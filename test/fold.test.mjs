import assert from 'node:assert/strict'
import {
	BOOK_PRESETS,
	DEFAULT_PRICING,
	classifyPeriod,
	createSessionCostDefinition,
	modelOf,
	resolveBooks,
	resolvePricing,
	resolveRules,
	sourceOf
} from '../host.js'

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

// ---------------------------------------------------------------------------
// Provider books: the plugin must price the provider a request actually ran on,
// not one global book configured for whichever provider came first.
const official = resolveBooks(undefined)
assert.deepEqual(Object.keys(official.providers).sort(), ['bailian', 'bailian-chat', 'deepseek-account'])
assert.equal(official.providers['deepseek-account'].pricing.idle.cacheHit, 0.02, 'official idle cache hit')
assert.equal(official.providers['deepseek-account'].pricing.peak.cacheHit, 0.04, 'official peak cache hit')
assert.deepEqual(official.providers['deepseek-account'].rules.peakWindows, ['09:00-12:00', '14:00-18:00'])
assert.equal(official.providers['deepseek-account'].rules.weekends, 'idle')
assert.equal(official.providers['bailian'].pricing.idle.cacheHit, 0.1, 'Bailian idle cache hit')
assert.equal(official.providers['bailian'].pricing.peak.cacheHit, 0.2, 'Bailian peak cache hit')
assert.deepEqual(official.providers['bailian'].rules.peakWindows, ['08:00-22:00'])
assert.equal(official.providers['bailian'].rules.weekends, 'clock')
assert.equal(official.providers['bailian'].pricing.models['qwen3.8-max'].peak.output, 36)
// The flat book falls back to the DeepSeek official list.
assert.equal(official.fallback.pricing.idle.cacheHit, 0.02)
assert.deepEqual(official.fallback.rules.peakWindows, ['09:00-12:00', '14:00-18:00'])

// The regression this change exists for: a profile whose *flat* config is a
// Bailian book must not prise official DeepSeek requests with it.
const flatBailianConfig = {
	peakWindows: ['08:00-22:00'],
	weekends: 'clock',
	pricing: {
		currency: '¥',
		defaultModel: 'deepseek-v4.1-flash-1017',
		idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 },
		peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
	}
}
const stale = resolveBooks(flatBailianConfig)
assert.equal(stale.fallback.pricing.idle.cacheHit, 0.1, 'flat config still describes the fallback book')
assert.equal(stale.providers['deepseek-account'].pricing.peak.cacheHit, 0.04, 'official book beats a stale flat Bailian book')
assert.deepEqual(stale.providers['deepseek-account'].rules.peakWindows, ['09:00-12:00', '14:00-18:00'])
assert.equal(stale.providers['bailian'].pricing.peak.cacheHit, 0.2)

// `config.providers` overrides merge over the preset field by field.
const overridden = resolveBooks({
	providers: {
		bailian: {
			peakWindows: ['09:00-21:00'],
			pricing: { idle: { cacheHit: 0.5 }, models: { 'qwen3.8-max': { peak: { output: 40 } } } }
		},
		'deepseek-account': { pricing: { peak: { output: 9 } } },
		internal: { weekends: 'idle' }
	}
})
assert.deepEqual(overridden.providers.bailian.rules.peakWindows, ['09:00-21:00'])
assert.equal(overridden.providers.bailian.rules.weekends, 'clock', 'unset rule fields inherit the preset')
assert.equal(overridden.providers.bailian.pricing.idle.cacheHit, 0.5)
assert.equal(overridden.providers.bailian.pricing.idle.cacheMiss, 1, 'unset rate fields inherit the preset')
assert.equal(overridden.providers.bailian.pricing.models['qwen3.8-max'].peak.output, 40)
assert.equal(overridden.providers.bailian.pricing.models['qwen3.8-max'].peak.cacheMiss, 12, 'partial model rows inherit')
assert.equal(overridden.providers['deepseek-account'].pricing.peak.output, 9)
assert.equal(overridden.providers['deepseek-account'].pricing.peak.cacheMiss, 2)
assert.equal(overridden.providers.internal.rules.weekends, 'idle')
assert.equal(overridden.providers.internal.pricing.idle.cacheHit, 0.02, 'a provider without a preset starts from the flat book')
// Presets themselves must not be mutated by any override.
assert.equal(BOOK_PRESETS.bailian.pricing.idle.cacheHit, 0.1)

// Legacy exports still resolve the flat book.
assert.equal(resolvePricing(flatBailianConfig).idle.cacheHit, 0.1)
assert.equal(resolvePricing(undefined).idle.cacheHit, 0.02)
assert.equal(resolvePricing(undefined).models['deepseek-flash'].peak.output, 8)
assert.deepEqual(resolveRules(undefined).peakWindows, ['09:00-12:00', '14:00-18:00'])

// ---------------------------------------------------------------------------
// Fold. Each provider classifies by its own rules and keeps its own rows.
const definition = createSessionCostDefinition(official)
const ev = (type, data, time, seq) => ({ type, data, time, seq })

const stepStart = (turn, step, time, seq) => ev('step/start', { turn, step }, time, seq)
const attempt = (turn, step, usage, time, seq) => ev('assistant/attempt', {
	turn,
	step,
	stream: [{ type: 'chunk', chunk: { type: 'text', text: 'x' }, time }, { type: 'chunk', chunk: { type: 'usage', usage }, time }]
}, time, seq)
const message = (turn, step, usage, time, seq, source) => ev('assistant/message', {
	turn,
	step,
	usage,
	stream: [],
	...(source === undefined ? {} : { message: { content: [], source } })
}, time, seq)
const route = (provider, model, time, seq) => ev('request/context', { provider, model, contextWindow: 1e6 }, time, seq)

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
assert.deepEqual(view.peakWindows, official.fallback.rules.peakWindows)

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

// A restored checkpoint state parses back into a usable fold.
const restored = definition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
const restoredView = definition.wire.view(restored)
assert.equal(restoredView.peak.outputTokens, 50)
assert.equal(restoredView.peak.requests, 2)

// Wire view parses and stays JSON-serializable.
const wire = definition.wire.viewSchema.parse(view)
assert.deepEqual(Object.keys(wire).sort(), ['books', 'idle', 'models', 'peak', 'peakWindows', 'pricing', 'weekends'])
// The flat book is always published now: the Client must never fall back to its
// own built-in copy just because the Host said nothing.
assert.ok(wire.pricing !== undefined)
assert.equal(wire.pricing.idle.cacheHit, 0.02)
// Every provider book travels on the wire, including the one this session used.
assert.deepEqual(wire.books.map((book) => book.provider), ['bailian', 'bailian-chat', 'deepseek-account'])
const officialBook = wire.books.find((book) => book.provider === 'deepseek-account')
assert.equal(officialBook.idle.cacheHit, 0.02)
assert.equal(officialBook.models['deepseek-flash'].peak.cacheHit, 0.04)
assert.equal(officialBook.weekends, 'idle')
assert.ok(typeof JSON.stringify(wire) === 'string')

// The registry contract: a sync view, validated by viewSchema on every publish.
assert.equal(typeof definition.wire.view(state), 'object')
assert.equal(definition.stateVersion, 2)
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

// The same instant bills differently per provider: Sunday noon is idle for
// DeepSeek official and peak for Bailian (no weekend discount).
const sundayNoon = at('2026-11-01T10:00:00+08:00')
assert.equal(classifyPeriod(sundayNoon, official.providers['deepseek-account'].rules), 'idle')
assert.equal(classifyPeriod(sundayNoon, official.providers.bailian.rules), 'peak')

// ---------------------------------------------------------------------------
// Provider + model attribution.
assert.equal(sourceOf(message(1, 1, {}, peakTime, 0, { provider: 'deepseek-account', model: 'deepseek-flash' })).provider, 'deepseek-account')
assert.equal(modelOf(message(1, 1, {}, peakTime, 0, { provider: 'deepseek-account', model: 'deepseek-flash' })), 'deepseek-flash')
assert.equal(sourceOf(attempt(1, 1, {}, peakTime, 0)), undefined)

let mixedState = definition.init()
const feed = (events) => {
	for (const event of events) mixedState = definition.apply(mixedState, event)
	return definition.wire.view(mixedState)
}
const withSource = (turn, step, usage, time, seq, provider, model) => message(turn, step, usage, time, seq, { provider, model })

// DeepSeek official on Sunday noon (idle for it) and Bailian on Sunday noon
// (peak for it), each with its own row.
let mixedView = feed([
	route('deepseek-account', 'deepseek-flash', sundayNoon, 0),
	stepStart(1, 1, sundayNoon, 1),
	withSource(1, 1, { inputTokens: 100, outputTokens: 10 }, sundayNoon + 2000, 2, 'deepseek-account', 'deepseek-flash'),
	ev('step/end', { turn: 1, step: 1 }, sundayNoon + 3000, 3),
	route('bailian', 'qwen3.8-max', sundayNoon, 4),
	stepStart(2, 1, sundayNoon, 5),
	withSource(2, 1, { inputTokens: 400, outputTokens: 40 }, sundayNoon + 2000, 6, 'bailian', 'qwen3.8-max'),
	ev('step/end', { turn: 2, step: 1 }, sundayNoon + 3000, 7)
])
assert.deepEqual(mixedView.models.map((entry) => entry.provider + '/' + entry.model), [
	'bailian/qwen3.8-max',
	'deepseek-account/deepseek-flash'
])
const officialRow = mixedView.models.find((entry) => entry.provider === 'deepseek-account')
assert.equal(officialRow.idle.requests, 1, 'Sunday noon is idle for DeepSeek official')
assert.equal(officialRow.idle.outputTokens, 10)
const bailianRow = mixedView.models.find((entry) => entry.provider === 'bailian')
assert.equal(bailianRow.peak.requests, 1, 'Sunday noon is peak for Bailian')
assert.equal(bailianRow.peak.outputTokens, 40)
// Per-row tokens sum back to the session totals.
assert.equal(mixedView.idle.uncachedInputTokens, 100)
assert.equal(mixedView.peak.uncachedInputTokens, 400)
assert.equal(mixedView.idle.outputTokens + mixedView.peak.outputTokens, 50)

// An attempt that reports usage before the message settles is attributed to the
// route the message then pins, so a request never splits across providers/models.
mixedState = definition.init()
mixedView = feed([
	route('bailian', 'deepseek-v4.1-flash-1017', sundayNoon, 0),
	stepStart(3, 1, sundayNoon, 1),
	attempt(3, 1, { inputTokens: 7, outputTokens: 3 }, sundayNoon + 1000, 2),
	withSource(3, 1, { inputTokens: 7, outputTokens: 9 }, sundayNoon + 2000, 3, 'bailian', 'deepseek-v4.1-flash-1017')
])
assert.equal(mixedView.models.length, 1, 'one route row, not a routeless row plus a routed row')
assert.equal(mixedView.models[0].provider, 'bailian')
assert.equal(mixedView.models[0].model, 'deepseek-v4.1-flash-1017')
assert.equal(mixedView.models[0].peak.requests, 1)

// A provider with no book uses the flat fallback book, and rows without any
// route keep working (old logs): no per-model row, totals only.
const fallbackDefinition = createSessionCostDefinition(resolveBooks(flatBailianConfig))
let fallbackState = fallbackDefinition.init()
fallbackState = fallbackDefinition.apply(fallbackState, stepStart(1, 1, peakTime, 0))
fallbackState = fallbackDefinition.apply(fallbackState, message(1, 1, { inputTokens: 5, outputTokens: 6 }, peakTime + 1000, 1, { provider: 'internal' }))
const fallbackView = fallbackDefinition.wire.view(fallbackState)
assert.equal(fallbackView.models.length, 1)
assert.equal(fallbackView.models[0].provider, 'internal')
assert.equal(fallbackView.models[0].model, undefined)
assert.equal(fallbackView.models[0].peak.requests, 1, 'unknown provider classifies with the flat fallback rules')

// A restored checkpoint without rows still parses (older state versions).
const legacy = definition.stateSchema.parse({ idle: mixedView.idle, peak: mixedView.peak, openStep: null, last: null })
assert.deepEqual(legacy.rows, {})
assert.equal(legacy.route, null)
assert.equal(legacy.last, null)

// ---------------------------------------------------------------------------
// Pricing reaches the Client as per-provider books, and the bug that started
// this change stays fixed: a DeepSeek-official session must never be priced with
// the Bailian book even when the profile's flat config is a Bailian one.
const M = 1e6
const cost = (row, rates) => (row.cacheReadTokens * rates.cacheHit
	+ row.uncachedInputTokens * rates.cacheMiss
	+ row.cacheWriteTokens * rates.cacheWrite
	+ row.outputTokens * rates.output) / M
const sampleRow = { cacheReadTokens: 17.2e6, uncachedInputTokens: 326.2e3, cacheWriteTokens: 0, outputTokens: 60.3e3 }
const atStaleFlat = cost(sampleRow, stale.fallback.pricing.peak)
const atOfficial = cost(sampleRow, stale.providers['deepseek-account'].pricing.peak)
assert.ok(Math.abs(atStaleFlat - 4.57) < 0.01, 'a stale flat Bailian book gives ¥4.57, got ' + atStaleFlat.toFixed(2))
assert.ok(Math.abs(atOfficial - 1.82) < 0.01, 'the official book gives ¥1.82, got ' + atOfficial.toFixed(2))

// A real DeepSeek-official fold publishes the official book, and the Client can
// bill the session from `books` without touching its own defaults.
const bugDefinition = createSessionCostDefinition(resolveBooks(flatBailianConfig))
let bugState = bugDefinition.init()
bugState = bugDefinition.apply(bugState, ev('request/context', { provider: 'deepseek-account', model: 'deepseek-flash' }, peakTime, 0))
bugState = bugDefinition.apply(bugState, stepStart(1, 1, peakTime, 1))
bugState = bugDefinition.apply(bugState, ev('assistant/message', {
	turn: 1,
	step: 1,
	usage: { inputTokens: 15100, outputTokens: 39 },
	stream: [],
	message: { content: [], source: { provider: 'deepseek-account', model: 'deepseek-flash' } }
}, peakTime + 2000, 2))
const bugView = bugDefinition.wire.viewSchema.parse(bugDefinition.wire.view(bugState))
const publishedOfficial = bugView.books.find((book) => book.provider === 'deepseek-account')
assert.equal(publishedOfficial.idle.cacheHit, 0.02, 'official idle cache hit is published')
assert.equal(publishedOfficial.peak.cacheHit, 0.04, 'official peak cache hit is published')
assert.equal(publishedOfficial.models['deepseek-flash'].peak.output, 8)
const officialRowView = bugView.models.find((entry) => entry.provider === 'deepseek-account')
const bugCost = cost(officialRowView.peak, publishedOfficial.peak)
assert.ok(Math.abs(bugCost - 0.0305) < 0.001, 'the reported sample bills ~¥0.031 at official peak rates, got ' + bugCost.toFixed(4))

// Defaults still resolve when no config is present at all (a shipped install).
const bare = resolvePricing(undefined)
assert.equal(bare.idle.cacheHit, 0.02)
assert.equal(bare.peak.cacheHit, 0.04)
assert.equal(bare.models['deepseek-flash'].idle.output, 4)
assert.equal(DEFAULT_PRICING.models['deepseek-v4-pro'].peak.output, 27)

console.log('sessionCost projection fold: all assertions passed')
