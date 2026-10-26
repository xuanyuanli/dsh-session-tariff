import assert from 'node:assert/strict'
import { createSessionCostDefinition, classifyPeriod } from '../host.js'

const CST = 8 * 60 * 60 * 1000
const at = (iso) => Date.parse(iso)

const rules = { utcOffsetMinutes: 480, peakWindows: ['09:00-12:00', '14:00-18:00'], holidays: ['2026-10-30'], workdays: ['2026-10-31'] }

// Monday 2026-10-26 10:00 CST is peak; 20:00 is idle; noon is the idle gap.
assert.equal(classifyPeriod(at('2026-10-26T10:00:00+08:00'), rules), 'peak')
assert.equal(classifyPeriod(at('2026-10-26T09:00:00+08:00'), rules), 'peak')
assert.equal(classifyPeriod(at('2026-10-26T11:59:00+08:00'), rules), 'peak')
assert.equal(classifyPeriod(at('2026-10-26T12:00:00+08:00'), rules), 'idle')
assert.equal(classifyPeriod(at('2026-10-26T14:00:00+08:00'), rules), 'peak')
assert.equal(classifyPeriod(at('2026-10-26T18:00:00+08:00'), rules), 'idle')
assert.equal(classifyPeriod(at('2026-10-26T20:00:00+08:00'), rules), 'idle')
// Saturday and Sunday are idle even inside a peak window.
assert.equal(classifyPeriod(at('2026-10-31T10:00:00+08:00'), rules), 'peak', 'listed make-up workday')
assert.equal(classifyPeriod(at('2026-11-01T10:00:00+08:00'), rules), 'idle')
// Friday 2026-10-30 is a listed holiday.
assert.equal(classifyPeriod(at('2026-10-30T10:00:00+08:00'), rules), 'idle')

const definition = createSessionCostDefinition(rules)
const ev = (type, data, time, seq) => ({ type, data, time, seq })

const stepStart = (turn, step, time, seq) => ev('step/start', { turn, step }, time, seq)
const attempt = (turn, step, usage, time, seq) => ev('assistant/attempt', {
	turn,
	step,
	stream: [{ type: 'chunk', chunk: { type: 'text', text: 'x' }, time }, { type: 'chunk', chunk: { type: 'usage', usage }, time }]
}, time, seq)
const message = (turn, step, usage, time, seq) => ev('assistant/message', { turn, step, usage, stream: [] }, time, seq)

let state = definition.init()
const run = (events) => {
	for (const event of events) state = definition.apply(state, event)
	return definition.wire.view(state)
}

// One peak request, one idle request: buckets split by the step/start time.
const peakTime = at('2026-10-26T10:00:00+08:00')
const idleTime = at('2026-10-26T20:00:00+08:00')
run([
	stepStart(1, 1, peakTime, 0),
	message(1, 1, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 }, peakTime + 2000, 1),
	stepStart(1, 2, idleTime, 2),
	message(1, 2, { inputTokens: 200, cacheReadTokens: 1800, outputTokens: 80 }, idleTime + 2000, 3)
])
let view = definition.wire.view(state)
assert.deepEqual(view.peak, { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 50, requests: 1 })
assert.deepEqual(view.idle, { uncachedInputTokens: 200, cacheReadTokens: 1800, cacheWriteTokens: 0, outputTokens: 80, requests: 1 })
assert.deepEqual(view.peakWindows, rules.peakWindows)

// Attempt sample then the same step's message: replace, never sum both.
state = definition.init()
run([
	stepStart(2, 1, peakTime, 0),
	attempt(2, 1, { inputTokens: 100, outputTokens: 10 }, peakTime + 1000, 1),
	message(2, 1, { inputTokens: 100, outputTokens: 50 }, peakTime + 2000, 2)
])
view = definition.wire.view(state)
assert.equal(view.peak.outputTokens, 50)
assert.equal(view.peak.uncachedInputTokens, 100)
assert.equal(view.peak.requests, 1)

// A retried attempt inside one step is a second billed request: the retry closes
// the replacement slot, so the first attempt survives and the message replaces the
// second attempt rather than adding to it.
state = definition.init()
run([
	stepStart(3, 1, peakTime, 0),
	attempt(3, 1, { inputTokens: 100, outputTokens: 10 }, peakTime + 1000, 1),
	ev('llm/retry-started', { turn: 3, step: 1 }, peakTime + 1500, 2),
	attempt(3, 1, { inputTokens: 120, outputTokens: 20 }, peakTime + 2000, 3),
	message(3, 1, { inputTokens: 120, outputTokens: 40 }, peakTime + 3000, 4)
])
view = definition.wire.view(state)
assert.equal(view.peak.requests, 2)
assert.equal(view.peak.uncachedInputTokens, 100 + 120)
assert.equal(view.peak.outputTokens, 10 + 40)

// Unrelated events keep the state reference (no downstream work).
const before = state
state = definition.apply(state, ev('tool/call', { callId: 'c1' }, peakTime, 5))
assert.equal(state, before)

// A restored checkpoint state parses back into a usable row.
const restored = definition.stateSchema.parse(JSON.parse(JSON.stringify(view)))
assert.equal(restored.peak.outputTokens, 50)

// Wire view parses and stays JSON-serializable.
const wire = definition.wire.viewSchema.parse(view)
assert.deepEqual(Object.keys(wire).sort(), ['idle', 'peak', 'peakWindows'])
assert.ok(typeof JSON.stringify(wire) === 'string')

// The registry contract: a sync view, validated by viewSchema on every publish.
assert.equal(typeof definition.wire.view(state), 'object')
assert.equal(definition.stateVersion, 1)
assert.equal(definition.key, 'sessionCost')

console.log('sessionCost projection fold: all assertions passed')
