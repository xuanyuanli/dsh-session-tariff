import assert from 'node:assert/strict'
import { createSessionCostDefinition, classifyPeriod, modelOf, resolvePricing, DEFAULT_PRICING } from '../host.js'

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
assert.deepEqual(Object.keys(wire).sort(), ['idle', 'models', 'peak', 'peakWindows', 'pricing', 'weekends'])
// The default rules leave the weekend policy implicit as DeepSeek's 'idle'.
assert.equal(wire.weekends, 'idle')
// A definition built without pricing publishes nothing, so the Client keeps its
// own copy instead of being told every rate is zero.
assert.equal(wire.pricing, undefined)
assert.ok(typeof JSON.stringify(wire) === 'string')

// The registry contract: a sync view, validated by viewSchema on every publish.
assert.equal(typeof definition.wire.view(state), 'object')
assert.equal(definition.stateVersion, 1)
assert.equal(definition.key, 'sessionCost')

// ---------------------------------------------------------------------------
// Weekend policy: 'clock' bills weekends at the wall clock (Bailian style),
// where only `peakWindows` decide; 'idle' keeps the DeepSeek behaviour.
const clockRules = { ...rules, weekends: 'clock' }
// Saturday 2026-10-31 10:00 is peak under 'clock', but listed as a make-up workday above.
assert.equal(classifyPeriod(at('2026-11-01T10:00:00+08:00'), clockRules), 'peak', 'Sunday daytime is peak when weekends bill at the clock')
assert.equal(classifyPeriod(at('2026-11-01T02:00:00+08:00'), clockRules), 'idle', 'Sunday 02:00 is outside the peak window')
assert.equal(classifyPeriod(at('2026-11-01T10:00:00+08:00'), rules), 'idle', 'default policy keeps Sunday idle')
// A listed holiday still bills idle even under the clock policy.
assert.equal(classifyPeriod(at('2026-10-30T10:00:00+08:00'), clockRules), 'idle')

// ---------------------------------------------------------------------------
// Per-model attribution: each model keeps its own idle/peak rows.
const withSource = (usage, model, time = peakTime + 2000, seq = 9) => ({
	type: 'assistant/message',
	data: { turn: 1, step: 1, usage, stream: [], message: { content: [], source: { provider: 'bailian', model } } },
	time,
	seq
})
assert.equal(modelOf(withSource({ inputTokens: 1, outputTokens: 1 }, 'qwen3.8-max')), 'qwen3.8-max')
assert.equal(modelOf(ev('assistant/attempt', { turn: 1, step: 1, stream: [] }, peakTime, 0)), undefined)

const modelDefinition = createSessionCostDefinition(clockRules)
let modelState = modelDefinition.init()
const feed = (events) => {
	for (const event of events) modelState = modelDefinition.apply(modelState, event)
	return modelDefinition.wire.view(modelState)
}
const sundayNoon = at('2026-11-01T10:00:00+08:00')
const sunday2am = at('2026-11-01T02:00:00+08:00')
const withTurn = (turn, usage, model, time, seq) => {
	const event = withSource(usage, model, time, seq)
	event.data.turn = turn
	event.data.step = 1
	return event
}
let modelView = feed([
	ev('step/start', { turn: 1, step: 1 }, sundayNoon, 0),
	withTurn(1, { inputTokens: 100, outputTokens: 10 }, 'qwen3.8-max', sundayNoon + 2000, 9),
	ev('step/end', { turn: 1, step: 1 }, sundayNoon + 3000, 10),
	ev('step/start', { turn: 2, step: 1 }, sunday2am, 11),
	withTurn(2, { inputTokens: 400, outputTokens: 40 }, 'ZHIPU/GLM-5.3', sunday2am + 2000, 19),
	ev('step/end', { turn: 2, step: 1 }, sunday2am + 3000, 20)
])
assert.deepEqual(modelView.models.map((entry) => entry.model), ['ZHIPU/GLM-5.3', 'qwen3.8-max'], 'models sorted by id')
const qwen = modelView.models.find((entry) => entry.model === 'qwen3.8-max')
assert.equal(qwen.peak.requests, 1, 'Sunday noon bills peak under the clock policy')
assert.equal(qwen.peak.outputTokens, 10)
const glm = modelView.models.find((entry) => entry.model === 'ZHIPU/GLM-5.3')
assert.equal(glm.idle.requests, 1, 'Sunday 02:00 bills idle')
assert.equal(glm.idle.outputTokens, 40)
// The per-model rows sum back to the session totals.
assert.equal(modelView.peak.uncachedInputTokens, 100)
assert.equal(modelView.idle.uncachedInputTokens, 400)
assert.equal(modelView.peak.outputTokens + modelView.idle.outputTokens, 50)
// The wire view must carry the policy that produced those rows, so the client's
// explanation matches the arithmetic instead of assuming DeepSeek's rule.
assert.equal(modelView.weekends, 'clock')

// An attempt that reports usage before the message settles is priced under the
// model the message then pins, so a single request never splits across models.
modelState = modelDefinition.init()
modelView = feed([
	ev('step/start', { turn: 3, step: 1 }, sundayNoon, 0),
	ev('assistant/attempt', { turn: 3, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }, time: sundayNoon }] }, sundayNoon + 1000, 1),
	withTurn(3, { inputTokens: 7, outputTokens: 9 }, 'qwen3.8-max', sundayNoon + 2000, 5)
])
assert.equal(modelView.models.length, 1, 'one model row, not a null-model row plus a model row')
assert.equal(modelView.models[0].model, 'qwen3.8-max')
assert.equal(modelView.models[0].peak.requests, 1)

// A restored checkpoint without model rows still parses (older state versions).
const legacy = modelDefinition.stateSchema.parse({ idle: modelView.idle, peak: modelView.peak, openStep: null, last: null })
assert.deepEqual(legacy.models, {})
assert.equal(legacy.openModel, null)

// ---------------------------------------------------------------------------
// Pricing must reach the Client. The DSH client module loader creates plugin
// entries with `{ name }` only, so `apply(ctx, config)` never receives the
// loader row's config in the browser; the Host therefore republishes the
// configured prices on the projection. Without this, a Bailian setup silently
// bills at the built-in DeepSeek rates.
const bailianConfig = {
	peakWindows: ['08:00-22:00'],
	weekends: 'clock',
	pricing: {
		currency: '¥',
		defaultModel: 'deepseek-v4.1-flash-1017',
		idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 },
		peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 },
		models: {
			'deepseek-v4.1-flash-1017': {
				idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 },
				peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
			},
			'ZHIPU/GLM-5.3': {
				idle: { cacheHit: 2, cacheMiss: 8, cacheWrite: 8, output: 28 },
				peak: { cacheHit: 2, cacheMiss: 8, cacheWrite: 8, output: 28 }
			}
		}
	}
}

// The host half reads the row's config, so the resolved prices must appear on
// the wire view the Client consumes.
const published = resolvePricing(bailianConfig)
assert.equal(published.idle.cacheHit, 0.1, 'idle cacheHit comes from config')
assert.equal(published.peak.cacheHit, 0.2, 'peak cacheHit comes from config')
assert.equal(published.models['ZHIPU/GLM-5.3'].peak.output, 28, 'per-model rate survives')

const pricingDefinition = createSessionCostDefinition({ ...rules, weekends: 'clock' }, published)
let pricingState = pricingDefinition.init()
pricingState = pricingDefinition.apply(pricingState, ev('step/start', { turn: 1, step: 1 }, at('2026-10-26T10:00:00+08:00'), 0))
pricingState = pricingDefinition.apply(pricingState, {
	type: 'assistant/message',
	data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 }, stream: [], message: { content: [], source: { model: 'deepseek-v4.1-flash-1017' } } },
	time: at('2026-10-26T10:00:02+08:00'),
	seq: 1
})
const pricingView = pricingDefinition.wire.viewSchema.parse(pricingDefinition.wire.view(pricingState))
assert.ok(pricingView.pricing !== undefined, 'pricing is published')
assert.equal(pricingView.pricing.idle.cacheHit, 0.1, 'published idle cacheHit is 0.1, not the 0.02 default')
assert.equal(pricingView.pricing.peak.cacheHit, 0.2, 'published peak cacheHit is 0.2, not the 0.04 default')
assert.equal(pricingView.pricing.models['ZHIPU/GLM-5.3'].idle.cacheHit, 2, 'per-model table travels too')

// Billing the same sample at the published rates must differ from the defaults,
// which is exactly the 5x cache gap the user hit.
const M = 1e6
const cost = (row, r) => (row.cacheReadTokens * r.cacheHit + row.uncachedInputTokens * r.cacheMiss + row.outputTokens * r.output) / M
const sampleRow = { cacheReadTokens: 17.2e6, uncachedInputTokens: 326.2e3, outputTokens: 60.3e3 }
const atPublished = cost(sampleRow, pricingView.pricing.peak)
const atDefault = cost(sampleRow, DEFAULT_PRICING.peak)
assert.ok(Math.abs(atDefault - 1.82) < 0.01, 'built-in defaults reproduce the wrong ¥1.82, got ' + atDefault.toFixed(2))
assert.ok(Math.abs(atPublished - 4.57) < 0.01, 'Bailian rates give ¥4.57, got ' + atPublished.toFixed(2))

// Defaults still resolve when no config is present at all (a shipped install).
const bare = resolvePricing(undefined)
assert.equal(bare.idle.cacheHit, 0.02)
assert.equal(bare.peak.cacheHit, 0.04)
assert.deepEqual(bare.models, {})

console.log('sessionCost projection fold: all assertions passed')
