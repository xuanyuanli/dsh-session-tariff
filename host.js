/**
 * Host half of the session-tariff bundle.
 *
 * Two jobs:
 *
 * 1. Registers the `sessionCost` session projection: it folds durable provider
 *    usage per (provider, model) request and classifies each request by the
 *    tariff period that the *serving provider's* rules assign to its start time
 *    (peak vs idle), so the Client can price every row against that provider's book.
 * 2. Serves the price-book editor the Client renders in Settings → Plugins:
 *    a small JSON API (`/dsh-session-tariff/api`) over the live provider/model
 *    catalog plus the row's own `config`. Saving goes through `configEditor`,
 *    so an edit persists to the profile patch and applies without a restart.
 *
 * Provider resolution follows the log: a settled request carries
 * `message.source.provider` / `message.source.model`; `request/context` records
 * the route for the upcoming request. The loop appends `request/context` *after*
 * `step/start` and before the request, and a live `assistant/attempt` carries no
 * source at all, so an attempt is attributed to the current route rather than to a
 * route pinned on the step.
 *
 * Classification follows each provider's published rules. DeepSeek bills workday
 * peak windows (09:00-12:00 / 14:00-18:00) and idle weekends, holidays and the rest
 * of the day. Alibaba Bailian bills 08:00-22:00 every day, keeps weekends at full
 * price, and discounts 22:00-08:00; its peak window is therefore expressed as the
 * daytime window, which the rules model can represent (a window cannot cross
 * midnight).
 */

/** Cordis plugin name. */
export const name = 'session-tariff'

/** The projection registry is this plugin's whole purpose. */
export const inject = ['sessionProjections']

/** JSON API prefix served to this plugin's own settings page. */
export const API_PREFIX = '/dsh-session-tariff/api'

/**
 * DeepSeek official rules. `utcOffsetMinutes: 480` is Asia/Shanghai (no DST).
 * `holidays` / `workdays` take `YYYY-MM-DD` keys; `workdays` wins, so a make-up
 * workday that lands on a weekend is classified as a workday.
 *
 * `weekends` decides what a Saturday/Sunday is when it is not listed:
 * `'idle'` (DeepSeek: weekends bill as idle all day) or `'clock'` (Alibaba
 * Bailian and most pay-as-you-go providers: the weekend has no discount, so
 * only `peakWindows` matter). `holidays` always bills as idle regardless.
 */
const DEFAULT_RULES = {
	utcOffsetMinutes: 480,
	peakWindows: ['09:00-12:00', '14:00-18:00'],
	holidays: [],
	workdays: [],
	weekends: 'idle'
}

/** Alibaba Bailian rules: 22:00-08:00 idle, no weekend discount. */
const BAILIAN_RULES = {
	utcOffsetMinutes: 480,
	peakWindows: ['08:00-22:00'],
	holidays: [],
	workdays: [],
	weekends: 'clock'
}

const BUCKET_FIELDS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']

/**
 * Unit prices in CNY per one million tokens, split by tariff period. Checked
 * against the official DeepSeek list (2026-10): `deepseek-flash` idle 0.02 / 1 / 4,
 * peak 0.04 / 2 / 8 — peak is exactly twice idle. DeepSeek has no separate
 * cache-write price (writes land in the uncached bucket), so `cacheWrite` defaults
 * to the miss rate, which is also what providers that report writes separately
 * charge. `deepseek-v4-pro` is idle 0.15 / 4.5 / 13.5, peak 0.30 / 9 / 27.
 */
export const DEFAULT_PRICING = {
	currency: '¥',
	defaultModel: 'deepseek-flash',
	idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
	peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 },
	models: {
		'deepseek-flash': {
			idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
			peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
		},
		'deepseek-v4-pro': {
			idle: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
			peak: { cacheHit: 0.3, cacheMiss: 9, cacheWrite: 9, output: 27 }
		}
	}
}

/**
 * Built-in price books, keyed by the provider id DSH reports on the wire
 * (`message.source.provider` / `request/context.provider`). They make a session
 * price correctly on the provider it actually ran on, without any configuration:
 * switching the GUI model between DeepSeek official and Bailian needs no edit and
 * no restart. `config.providers[id]` overrides any of this per provider.
 *
 * Rates are CNY per 1M tokens in `{ cacheHit, cacheMiss, cacheWrite, output }`.
 * Bailian prices come from the console's model cards (2026-10): only
 * `deepseek-v4.1-flash-1017` has an idle/peak split; Qwen and GLM are flat, so
 * their idle and peak rows are identical.
 */
const BAILIAN_PRICING = {
	currency: '¥',
	defaultModel: 'deepseek-v4.1-flash-1017',
	idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 },
	peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 },
	models: {
		'deepseek-v4.1-flash-1017': {
			idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 },
			peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
		},
		'qwen3.8-max': {
			idle: { cacheHit: 1.5, cacheMiss: 12, cacheWrite: 12, output: 36 },
			peak: { cacheHit: 1.5, cacheMiss: 12, cacheWrite: 12, output: 36 }
		},
		'ZHIPU/GLM-5.3-Flash': {
			idle: { cacheHit: 0.23, cacheMiss: 0.8, cacheWrite: 0.8, output: 2.8 },
			peak: { cacheHit: 0.23, cacheMiss: 0.8, cacheWrite: 0.8, output: 2.8 }
		},
		'ZHIPU/GLM-5.3': {
			idle: { cacheHit: 2, cacheMiss: 8, cacheWrite: 8, output: 28 },
			peak: { cacheHit: 2, cacheMiss: 8, cacheWrite: 8, output: 28 }
		}
	}
}

/** The preset books; copied into each resolved set so config merging never mutates them. */
export const BOOK_PRESETS = {
	'deepseek-account': { rules: DEFAULT_RULES, pricing: DEFAULT_PRICING },
	bailian: { rules: BAILIAN_RULES, pricing: BAILIAN_PRICING },
	'bailian-chat': { rules: BAILIAN_RULES, pricing: BAILIAN_PRICING }
}

/** A shallow object guard. */
function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty string, or undefined. */
function text(value) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Deep-copy plain data through JSON: books contain only strings, numbers, arrays and maps. */
function copy(value) {
	return JSON.parse(JSON.stringify(value))
}

/**
 * Normalize one period bucket row (four token fields plus a request count).
 * @param value - candidate row.
 * @returns a complete row; unknown or invalid numbers become 0.
 */
function normalizeRow(value) {
	const row = isObject(value) ? value : {}
	const result = {}
	for (const field of BUCKET_FIELDS) {
		const number = Number(row[field])
		result[field] = Number.isFinite(number) && number > 0 ? number : 0
	}
	const requests = Number(row.requests)
	result.requests = Number.isFinite(requests) && requests > 0 ? Math.floor(requests) : 0
	return result
}

/**
 * Normalize one rate row. A missing or non-numeric field keeps the fallback, so
 * a partial override only has to name the fields it changes.
 * @param given - candidate rates.
 * @param fallback - rates to inherit missing fields from.
 * @returns a complete rate row.
 */
function resolveRates(given, fallback) {
	const source = isObject(given) ? given : {}
	const take = (value, base) => {
		const number = Number(value)
		return Number.isFinite(number) && number >= 0 ? number : base
	}
	return {
		cacheHit: take(source.cacheHit, fallback.cacheHit),
		cacheMiss: take(source.cacheMiss, fallback.cacheMiss),
		cacheWrite: take(source.cacheWrite, fallback.cacheWrite),
		output: take(source.output, fallback.output)
	}
}

/**
 * Merge a partial pricing block over a complete book. Flat rate fields on the
 * block override the base field by field; `idle` / `peak` override over that;
 * `models` rows merge per model id (a row's missing fields inherit the merged
 * book rates first, then the base row's own fields).
 * @param base - complete book: `{ currency, defaultModel, idle, peak, models }`.
 * @param given - partial override, or undefined.
 * @returns a complete book.
 */
function mergePricing(base, given) {
	const source = isObject(given) ? given : {}
	const flat = { cacheHit: source.cacheHit, cacheMiss: source.cacheMiss, cacheWrite: source.cacheWrite, output: source.output }
	const idle = resolveRates(source.idle === undefined ? flat : source.idle, resolveRates(flat, base.idle))
	const peak = resolveRates(source.peak === undefined ? flat : source.peak, resolveRates(flat, base.peak))
	const models = {}
	for (const key of Object.keys(base.models)) models[key] = copy(base.models[key])
	const table = isObject(source.models) ? source.models : {}
	for (const key of Object.keys(table)) {
		const entry = table[key]
		if (!isObject(entry)) continue
		const rowFlat = { cacheHit: entry.cacheHit, cacheMiss: entry.cacheMiss, cacheWrite: entry.cacheWrite, output: entry.output }
		const rowBase = models[key] === undefined ? { idle, peak } : models[key]
		const rowIdle = resolveRates(entry.idle === undefined ? rowFlat : entry.idle, resolveRates(rowFlat, rowBase.idle))
		const rowPeak = entry.peak === undefined
			? resolveRates(rowFlat, rowBase.peak)
			: resolveRates(entry.peak, resolveRates(rowFlat, rowBase.peak))
		models[key] = { idle: rowIdle, peak: rowPeak }
	}
	return {
		currency: text(source.currency) ?? base.currency,
		defaultModel: text(source.defaultModel) ?? base.defaultModel,
		idle,
		peak,
		models
	}
}

/**
 * Merge tariff-rule overrides over a complete rules object. A field that is
 * absent or unusable keeps the base value; a `peakWindows` list that filters down
 * to nothing keeps the base windows rather than disabling peak billing.
 * @param base - complete rules.
 * @param given - partial override, or undefined.
 * @returns complete rules.
 */
function mergeRules(base, given) {
	const source = isObject(given) ? given : {}
	const offset = Number(source.utcOffsetMinutes)
	const windows = Array.isArray(source.peakWindows)
		? source.peakWindows.filter((entry) => typeof entry === 'string' && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(entry))
		: []
	const dates = (value) => Array.isArray(value)
		? value.filter((entry) => typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry))
		: undefined
	const holidays = dates(source.holidays)
	const workdays = dates(source.workdays)
	return {
		utcOffsetMinutes: Number.isFinite(offset) ? offset : base.utcOffsetMinutes,
		peakWindows: windows.length > 0 ? windows : base.peakWindows,
		holidays: holidays === undefined ? base.holidays : holidays,
		workdays: workdays === undefined ? base.workdays : workdays,
		weekends: source.weekends === 'clock' || source.weekends === 'idle' ? source.weekends : base.weekends
	}
}

/**
 * The flat (legacy) book: resolved from the loader row's top-level fields.
 * This is the fallback for a provider with no preset and no `providers` entry.
 * @param config - the loader row's config.
 * @returns `{ rules, pricing }`.
 */
export function resolveFlatBook(config) {
	const given = isObject(config) ? config : {}
	return {
		rules: mergeRules(DEFAULT_RULES, given),
		pricing: mergePricing(DEFAULT_PRICING, given.pricing)
	}
}

/** Backwards-compatible alias: the flat book's rules. */
export function resolveRules(config) {
	return resolveFlatBook(config).rules
}

/** Backwards-compatible alias: the flat book's pricing. */
export function resolvePricing(config) {
	return resolveFlatBook(config).pricing
}

/**
 * Resolve every price book for this loader row.
 *
 * Precedence for a request's provider: `config.providers[id]` (merged over the
 * built-in preset, or over the flat book when the id has no preset) → the
 * preset → the flat book → the hardcoded defaults. Publishing the whole book set
 * costs a few KB on the wire and lets the Client price a mixed-provider session
 * without a restart when the model changes.
 *
 * @param config - the loader row's config.
 * @returns `{ fallback: { rules, pricing }, providers: { [id]: { rules, pricing } } }`.
 */
export function resolveBooks(config) {
	const given = isObject(config) ? config : {}
	const fallback = resolveFlatBook(given)
	const overrides = isObject(given.providers) ? given.providers : {}
	const providers = {}
	for (const id of Object.keys(BOOK_PRESETS)) {
		const preset = BOOK_PRESETS[id]
		const override = isObject(overrides[id]) ? overrides[id] : {}
		providers[id] = {
			rules: mergeRules(copy(preset.rules), override),
			pricing: mergePricing(copy(preset.pricing), override.pricing)
		}
	}
	for (const id of Object.keys(overrides)) {
		if (providers[id] !== undefined || !isObject(overrides[id])) continue
		providers[id] = {
			rules: mergeRules(fallback.rules, overrides[id]),
			pricing: mergePricing(fallback.pricing, overrides[id].pricing)
		}
	}
	return { fallback, providers }
}

/**
 * Validate a published pricing block. Unknown or non-numeric rates are dropped
 * rather than defaulted, so the Client can tell "not published" from "published
 * as zero". `models` is a map of model id to `{ idle, peak }` rate rows.
 * @param value - candidate pricing block.
 * @returns the pricing block, or undefined when absent.
 */
function normalizePricingWire(value) {
	if (!isObject(value)) return undefined
	const rates = (row) => {
		if (!isObject(row)) return undefined
		const out = {}
		for (const field of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output']) {
			const number = Number(row[field])
			if (Number.isFinite(number) && number >= 0) out[field] = number
		}
		return Object.keys(out).length === 4 ? out : undefined
	}
	const idle = rates(value.idle)
	const peak = rates(value.peak)
	if (idle === undefined || peak === undefined) return undefined
	const models = {}
	if (isObject(value.models)) {
		for (const key of Object.keys(value.models)) {
			const entry = value.models[key]
			if (!isObject(entry)) continue
			const rowIdle = rates(entry.idle)
			const rowPeak = rates(entry.peak)
			if (rowIdle !== undefined && rowPeak !== undefined) models[key] = { idle: rowIdle, peak: rowPeak }
		}
	}
	return {
		currency: text(value.currency) ?? '¥',
		defaultModel: text(value.defaultModel),
		idle,
		peak,
		models
	}
}

/**
 * Validate one published provider book: its provider id, the tariff rules the
 * Host used to classify that provider's requests, and its price table.
 * @param value - candidate book.
 * @returns the book, or undefined when the entry is unusable.
 */
function normalizeBookWire(value) {
	if (!isObject(value)) return undefined
	const provider = text(value.provider)
	if (provider === undefined) return undefined
	const pricing = normalizePricingWire(value)
	if (pricing === undefined) return undefined
	const windows = Array.isArray(value.peakWindows)
		? value.peakWindows.filter((entry) => typeof entry === 'string')
		: []
	return {
		provider,
		peakWindows: windows,
		weekends: value.weekends === 'clock' ? 'clock' : 'idle',
		...pricing
	}
}

const viewSchema = {
	parse: (value) => {
		const view = isObject(value) ? value : {}
		const windows = Array.isArray(view.peakWindows) ? view.peakWindows.filter((entry) => typeof entry === 'string') : []
		const models = Array.isArray(view.models)
			? view.models
				.filter((entry) => isObject(entry) && typeof entry.model === 'string' && entry.model.length > 0)
				.map((entry) => ({
					provider: text(entry.provider),
					model: entry.model,
					idle: normalizeRow(entry.idle),
					peak: normalizeRow(entry.peak)
				}))
			: []
		const books = Array.isArray(view.books) ? view.books.map(normalizeBookWire).filter((entry) => entry !== undefined) : []
		return {
			idle: normalizeRow(view.idle),
			peak: normalizeRow(view.peak),
			peakWindows: windows,
			weekends: view.weekends === 'clock' ? 'clock' : 'idle',
			pricing: normalizePricingWire(view.pricing),
			books,
			models
		}
	}
}

/** A row key that distinguishes provider + model pairs (NUL cannot appear in either id). */
export function rowKey(provider, model) {
	return String(provider ?? '') + '\u0000' + String(model ?? '')
}

/** `{ provider, model }` from one wire route-like object, or undefined. */
function routeOf(value) {
	if (!isObject(value)) return undefined
	const provider = text(value.provider)
	const model = text(value.model)
	return provider === undefined && model === undefined ? undefined : { provider, model }
}

/** Whether two routes describe the same provider/model pair. */
function routeEquals(left, right) {
	if (left === null || left === undefined) return right === null || right === undefined
	if (right === null || right === undefined) return false
	return left.provider === right.provider && left.model === right.model
}

const stateSchema = {
	parse: (value) => {
		const state = isObject(value) ? value : {}
		const openStep = isObject(state.openStep) ? state.openStep : null
		const last = isObject(state.last) ? state.last : null
		const rows = {}
		if (isObject(state.rows)) {
			for (const key of Object.keys(state.rows)) {
				const entry = state.rows[key]
				if (!isObject(entry)) continue
				const provider = text(entry.provider)
				const model = text(entry.model)
				if (provider === undefined && model === undefined) continue
				rows[rowKey(provider, model)] = {
					provider,
					model,
					idle: normalizeRow(entry.idle),
					peak: normalizeRow(entry.peak)
				}
			}
		}
		const route = routeOf(state.route)
		return {
			idle: normalizeRow(state.idle),
			peak: normalizeRow(state.peak),
			rows,
			route: route ?? null,
			openStep: openStep === null
				? null
				: {
					turn: Number(openStep.turn) || 0,
					step: Number(openStep.step) || 0,
					start: Number(openStep.start) || 0
				},
			last: last === null
				? null
				: {
					turn: Number(last.turn) || 0,
					step: Number(last.step) || 0,
					period: last.period === 'peak' ? 'peak' : 'idle',
					buckets: normalizeRow(last.buckets),
					provider: text(last.provider),
					model: text(last.model)
				}
		}
	}
}

/**
 * Minutes since local midnight for `HH:MM`.
 * @param clock - `HH:MM` text.
 * @returns minutes since midnight.
 */
function minutesOf(clock) {
	const [hours, minutes] = clock.split(':')
	return Number(hours) * 60 + Number(minutes)
}

/**
 * Local calendar date key `YYYY-MM-DD` and weekday for one epoch millisecond.
 * Uses a fixed offset: Asia/Shanghai has no DST, so no time-zone database is needed.
 * @param time - epoch milliseconds.
 * @param rules - resolved tariff rules.
 * @returns date key, weekday (0 = Sunday) and minutes since local midnight.
 */
function localParts(time, rules) {
	const local = new Date(time + rules.utcOffsetMinutes * 60000)
	const year = local.getUTCFullYear()
	const month = String(local.getUTCMonth() + 1).padStart(2, '0')
	const day = String(local.getUTCDate()).padStart(2, '0')
	return {
		key: `${year}-${month}-${day}`,
		weekday: local.getUTCDay(),
		minute: local.getUTCHours() * 60 + local.getUTCMinutes()
	}
}

/**
 * Classify one request time into `peak` or `idle` under one rule set.
 * @param time - epoch milliseconds of the request start.
 * @param rules - resolved tariff rules.
 * @returns the tariff period.
 */
export function classifyPeriod(time, rules) {
	const { key, weekday, minute } = localParts(time, rules)
	const weekend = weekday === 0 || weekday === 6
	let workday
	if (rules.workdays.includes(key)) workday = true
	else if (rules.holidays.includes(key)) workday = false
	else if (rules.weekends === 'clock') workday = true
	else workday = !weekend
	if (!workday) return 'idle'
	for (const window of rules.peakWindows) {
		const [start, end] = window.split('-')
		if (minute >= minutesOf(start) && minute < minutesOf(end)) return 'peak'
	}
	return 'idle'
}

/** An empty period row. */
function zeroRow() {
	const row = {}
	for (const field of BUCKET_FIELDS) row[field] = 0
	row.requests = 0
	return row
}

/**
 * Provider usage of one durable settlement, mirroring the `tokenUsage` unit.
 * @param event - a session event.
 * @returns the reported usage record, or undefined.
 */
export function usageOf(event) {
	if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
	if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
	const stream = event.data.stream
	if (!Array.isArray(stream)) return undefined
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = stream[index]
		if (isObject(record) && record.type === 'chunk'
			&& isObject(record.chunk) && record.chunk.type === 'usage') {
			return record.chunk.usage
		}
	}
	return undefined
}

/**
 * Provider usage buckets of one sample, matching the `tokenUsage` buckets.
 * @param usage - provider-reported usage.
 * @returns the four bucket values.
 */
export function bucketsOf(usage) {
	const input = Number(usage.inputTokens)
	const output = Number(usage.outputTokens)
	const cacheRead = Number(usage.cacheReadTokens ?? 0)
	const cacheWrite = Number(usage.cacheWriteTokens ?? 0)
	return {
		uncachedInputTokens: Number.isFinite(input) && input > 0 ? input : 0,
		outputTokens: Number.isFinite(output) && output > 0 ? output : 0,
		cacheReadTokens: Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0,
		cacheWriteTokens: Number.isFinite(cacheWrite) && cacheWrite > 0 ? cacheWrite : 0
	}
}

/**
 * Add (`sign` 1) or remove (`sign` -1) one bucket sample on a period row.
 * @param row - the period row to shift.
 * @param buckets - the sample.
 * @param sign - direction.
 * @returns a new row.
 */
function shiftRow(row, buckets, sign) {
	const next = { requests: row.requests + sign }
	for (const field of BUCKET_FIELDS) next[field] = Math.max(0, row[field] + sign * buckets[field])
	return next
}

/** Compare two samples for fold suppression. */
export function bucketsEqual(left, right) {
	return BUCKET_FIELDS.every((field) => left[field] === right[field])
}

/**
 * The route a settled request ran on: `message.source.provider` /
 * `message.source.model`. `assistant/attempt` carries no source.
 * @param event - a session event.
 * @returns the route, or undefined.
 */
export function sourceOf(event) {
	if (event.type !== 'assistant/message') return undefined
	const source = event.data.message !== null && typeof event.data.message === 'object' ? event.data.message.source : undefined
	return routeOf(source)
}

/**
 * Model id of one settlement, kept for callers that only need that half.
 * @param event - a session event.
 * @returns the model id, or undefined.
 */
export function modelOf(event) {
	const route = sourceOf(event)
	return route === undefined ? undefined : route.model
}

/**
 * The rules that govern one provider: its own book, else the flat fallback book.
 * @param books - resolved books.
 * @param provider - provider id, possibly undefined.
 * @returns resolved rules.
 */
function rulesFor(books, provider) {
	if (provider !== undefined) {
		const book = books.providers[provider]
		if (book !== undefined) return book.rules
	}
	return books.fallback.rules
}

/**
 * Build the `sessionCost` unit for one resolved book set.
 * @param source - `resolveBooks(config)` output, or a function returning it so a
 *   live config write reaches the published view without re-registering the unit.
 *   Published with the view so the Client bills from the configured list rather
 *   than its own hardcoded copy (the Client never receives the loader row's
 *   `config`).
 * @returns the projection definition.
 */
export function createSessionCostDefinition(source) {
	const resolve = typeof source === 'function' ? source : () => source
	return {
		key: 'sessionCost',
		stateVersion: 2,
		stateSchema,
		init: () => ({ idle: zeroRow(), peak: zeroRow(), rows: {}, route: null, openStep: null, last: null }),
		apply: (state, event) => {
			if (event.type === 'request/context') {
				const route = routeOf(event.data)
				if (route === undefined || routeEquals(route, state.route)) return state
				return { ...state, route }
			}
			if (event.type === 'step/start') {
				return {
					...state,
					openStep: { turn: event.data.turn, step: event.data.step, start: event.time }
				}
			}
			if (event.type === 'step/end') {
				return state.openStep === null ? state : { ...state, openStep: null }
			}
			if (event.type === 'llm/retry-started') {
				const last = state.last
				if (last === null || last.turn !== event.data.turn || last.step !== event.data.step) return state
				return { ...state, last: null }
			}
			if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
			const sample = usageOf(event)
			const source = sourceOf(event)
			if (sample === undefined) {
				// A durable message with no usage still pins the route, so a later
				// `assistant/attempt` in the same step is attributed correctly.
				if (source === undefined || routeEquals(source, state.route)) return state
				return { ...state, route: source }
			}
			const { turn, step } = event.data
			const route = source === undefined ? state.route : source
			const provider = route === null ? undefined : route.provider
			const model = route === null ? undefined : route.model
			const open = state.openStep
			const sameStep = open !== null && open.turn === turn && open.step === step
			const start = sameStep ? open.start : event.time
			const period = classifyPeriod(start, rulesFor(resolve(), provider))
			const buckets = bucketsOf(sample)
			const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null
			if (previous !== null && previous.period === period && bucketsEqual(previous.buckets, buckets)) return state
			let idle = state.idle
			let peak = state.peak
			if (previous !== null) {
				if (previous.period === 'peak') peak = shiftRow(peak, previous.buckets, -1)
				else idle = shiftRow(idle, previous.buckets, -1)
			}
			if (period === 'peak') peak = shiftRow(peak, buckets, 1)
			else idle = shiftRow(idle, buckets, 1)
			// Per-route rows mirror the total fold, keyed by the provider + model that
			// served the request, so each pair can be priced at its own book's rates.
			const rows = {}
			for (const existing of Object.keys(state.rows)) rows[existing] = state.rows[existing]
			const currentKey = rowKey(provider, model)
			const previousKey = previous === null ? null : rowKey(previous.provider, previous.model)
			const tracked = previous !== null && (previous.provider !== undefined || previous.model !== undefined)
			// A sample that settles after an untracked one belongs to its own route; a
			// sample that replaces a tracked one stays on that row so the request never
			// splits across routes (a retry clears `last`, so a rerouted retry starts
			// a fresh row instead of overwriting the failed attempt's).
			const target = tracked ? previousKey : currentKey
			const targetProvider = tracked ? previous.provider : provider
			const targetModel = tracked ? previous.model : model
			if (targetProvider !== undefined || targetModel !== undefined) {
				const before = rows[target] === undefined
					? { provider: targetProvider, model: targetModel, idle: zeroRow(), peak: zeroRow() }
					: rows[target]
				let rowIdle = before.idle
				let rowPeak = before.peak
				if (tracked && previousKey === target) {
					if (previous.period === 'peak') rowPeak = shiftRow(rowPeak, previous.buckets, -1)
					else rowIdle = shiftRow(rowIdle, previous.buckets, -1)
				}
				if (period === 'peak') rowPeak = shiftRow(rowPeak, buckets, 1)
				else rowIdle = shiftRow(rowIdle, buckets, 1)
				rows[target] = { provider: targetProvider, model: targetModel, idle: rowIdle, peak: rowPeak }
			}
			return {
				idle,
				peak,
				rows,
				openStep: state.openStep,
				route: route ?? state.route,
				last: { turn, step, period, buckets, provider, model }
			}
		},
		wire: {
			viewSchema,
			view: (state) => {
				// Resolved per read: a saved price edit is visible to the already-running
				// unit, not only after the loader re-applies this plugin.
				const books = resolve()
				return {
					idle: state.idle,
					peak: state.peak,
					peakWindows: books.fallback.rules.peakWindows,
					weekends: books.fallback.rules.weekends,
					pricing: books.fallback.pricing,
					books: Object.keys(books.providers).sort().map((provider) => ({
						provider,
						peakWindows: books.providers[provider].rules.peakWindows,
						weekends: books.providers[provider].rules.weekends,
						...books.providers[provider].pricing
					})),
					models: Object.keys(state.rows)
						.sort((left, right) => {
							const a = state.rows[left]
							const b = state.rows[right]
							const byProvider = String(a.provider ?? '\uffff').localeCompare(String(b.provider ?? '\uffff'))
							return byProvider !== 0 ? byProvider : String(a.model ?? '').localeCompare(String(b.model ?? ''))
						})
						.map((key) => {
							const row = state.rows[key]
							return { provider: row.provider, model: row.model, idle: row.idle, peak: row.peak }
						})
				}
			}
		}
	}
}

/**
 * Unit prices of the flat fallback book, published by the projection so the
 * Client never has to carry the configured list.
 * @param config - optional tariff-rule and pricing overrides from the loader row.
 */
export function apply(ctx, config) {
	// This row intentionally exports no schemastery `Config` (see the note above
	// `plainConfig`), so the authoritative copy of the price books is the Loader
	// entry's own `options.config`: `configEditor.edit()` persists the next config
	// into the profile patch, updates that entry, and re-applies this plugin. Read
	// from the entry rather than from the `config` argument so the value is the one
	// on disk even if a future Loader stops handing the row's config to `apply`.
	// `plainConfig` still unwraps volatile references, so this also works if a
	// schema (and therefore hot field references) is ever added back.
	const entry = entryOf(ctx)
	const refs = () => {
		const snapshot = entry === undefined || entry.options === undefined ? undefined : entry.options.config
		return snapshot === undefined ? config : snapshot
	}
	const current = () => plainConfig(refs())

	// Resolving the books deep-copies the presets, and the fold runs for every
	// session event, so memoize on the identity of the unwrapped values: a
	// volatile field returns a new snapshot only when it changed.
	let cachedConfig
	let cachedBooks
	const books = () => {
		const plain = current()
		if (cachedBooks !== undefined && sameShallow(plain, cachedConfig)) return cachedBooks
		cachedConfig = plain
		cachedBooks = resolveBooks(plain)
		return cachedBooks
	}

	ctx.sessionProjections.register(createSessionCostDefinition(books))

	// The settings page is optional: without a web server (a headless deployment)
	// the projection still works and the page simply reports that the Host half has
	// no API. `ctx.inject` is the sanctioned way to wait for a service that may
	// start after this plugin; the fallback registers immediately when it is
	// already up, so this keeps working if the wait API ever changes.
	const route = () => ({
		kind: 'prefix',
		path: API_PREFIX,
		handler: (req, res) => handleApi(ctx, req, res, current)
	})
	const mount = (web) => web.effect(() => web.webServer.register(route()), 'session-tariff: price-book API')
	if (typeof ctx.inject === 'function') {
		ctx.inject(['webServer'], (web) => mount(web))
	} else {
		const server = ctx.get('webServer')
		if (server !== undefined) ctx.effect(() => server.register(route()), 'session-tariff: price-book API')
	}
}

/** Shallow identity comparison of two plain configs (volatile snapshots are frozen values). */
function sameShallow(left, right) {
	if (left === right) return true
	if (!isObject(left) || !isObject(right)) return false
	const keys = Object.keys(left)
	if (keys.length !== Object.keys(right).length) return false
	for (const key of keys) {
		if (left[key] !== right[key]) return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Price-book editor: the Client page in Settings → Plugins
//
// The page must sync with the providers and models DSH actually has right now,
// so the Host is the one that asks the `llm` registry and answers with one
// descriptor: the live catalog with each row's *effective* rates, what those
// rates would be without an override, and what the row's config currently says.
// Saving is a whole-config replacement validated here and applied through
// `configEditor`, which persists to the profile patch and reconciles the row.
// ---------------------------------------------------------------------------

/** The four billed buckets, in billing order. */
const RATE_FIELDS = ['cacheHit', 'cacheMiss', 'cacheWrite', 'output']

/** Period keys of one rate row. */
const RATE_PERIODS = ['idle', 'peak']

/** `Symbol.for('cosmokit.volatile.write')` — how a resolved volatile field is identified. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Names that must never reach a plain-object assignment built from JSON. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** Tariff-rule keys, shared by the flat book and every provider book. */
const RULE_KEYS = ['utcOffsetMinutes', 'peakWindows', 'weekends', 'holidays', 'workdays']

/** Pricing-block keys, shared by the flat book and every provider book. */
const PRICING_KEYS = ['currency', 'defaultModel', ...RATE_FIELDS, ...RATE_PERIODS, 'models']

/** A provider book is a rule set plus a price table. */
const PROVIDER_KEYS = [...RULE_KEYS, 'pricing']

/** Top-level keys of the loader row's config. */
const TOP_KEYS = [...PROVIDER_KEYS, 'providers']

const WINDOW_PATTERN = /^\d{2}:\d{2}-\d{2}:\d{2}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_BODY_BYTES = 256 * 1024

/** A one-line diagnostic from any thrown value. */
function messageOf(error) {
	if (error instanceof Error) return error.message
	return String(error)
}

/** Whether a resolved config field is a live volatile reference. */
function isVolatileRef(value) {
	return isObject(value) && typeof value.get === 'function' && VOLATILE_WRITE in value
}

/** Follow volatile references down to plain data. */
function unlocked(value) {
	return isVolatileRef(value) ? unlocked(value.get()) : value
}

/**
 * Plain, detached data from a loader config whose fields are volatile references.
 * @param config - the value `apply` received.
 * @returns a plain config object (`{}` when absent).
 */
export function plainConfig(config) {
	const source = unlocked(config)
	if (!isObject(source)) return {}
	const plain = {}
	for (const key of Object.keys(source)) plain[key] = unlocked(source[key])
	return plain
}

/*
 * This row deliberately exports no schemastery `Config`. A development install
 * links this package into the profile, and Node resolves a bare specifier from
 * the package's realpath rather than from the profile, so a static harness import
 * here would fail to load. The price books are validated by `sanitizeConfig()`
 * below instead, before anything is persisted, and the Loader applies the written
 * config through its normal path.
 */

/**
 * The providers and models DSH has registered right now.
 *
 * `listProviders()` is synchronous metadata; `listModels()` asks the adapter and
 * may fail or be slow for one route, so a failure is reported as a warning and
 * leaves that provider in the catalog with no models rather than dropping it.
 *
 * @param llm - the host `llm` service, or undefined when the deployment has none.
 * @returns `{ providers: [{ id, name, models: [{ id, name }] }], warnings }`.
 */
export async function liveCatalog(llm) {
	const warnings = []
	if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') {
		return { providers: [], warnings: ['llm service is not composed; price rows cannot follow the live catalog'] }
	}
	let listed = []
	try {
		listed = llm.listProviders() ?? []
	} catch (error) {
		return { providers: [], warnings: ['listProviders failed: ' + messageOf(error)] }
	}
	const providers = []
	for (const info of listed) {
		const id = text(info === null || info === undefined ? undefined : info.id)
		if (id === undefined) continue
		const models = []
		if (typeof llm.listModels === 'function') {
			try {
				for (const model of (await llm.listModels(id)) ?? []) {
					const modelId = text(model === null || model === undefined ? undefined : model.id)
					if (modelId === undefined) continue
					models.push({ id: modelId, name: text(model.name) ?? modelId })
				}
			} catch (error) {
				warnings.push(id + ': model list failed: ' + messageOf(error))
			}
		}
		models.sort((left, right) => left.id.localeCompare(right.id))
		providers.push({ id, name: text(info.name) ?? id, models })
	}
	providers.sort((left, right) => left.id.localeCompare(right.id))
	return { providers, warnings }
}

/** Whether a provider override names at least one tariff rule. */
function overridesRules(override) {
	for (const key of RULE_KEYS) if (override[key] !== undefined) return true
	return false
}

/**
 * Turn the row's config plus the live catalog into the descriptor the settings
 * page renders.
 *
 * A live provider always appears, whether or not it has a preset or an override:
 * that is what makes a newly added provider usable at once. A model that DSH no
 * longer reports is not editable; it is listed under `stale` so the page can
 * offer to remove its leftover override.
 *
 * @param config - plain config of this row (possibly `{}`).
 * @param catalog - `liveCatalog()` output.
 * @returns the wire descriptor (`providers`, `fallback`, `stale`, `warnings`).
 */
export function describeState(config, catalog) {
	const given = isObject(config) ? config : {}
	const books = resolveBooks(given)
	const overrides = isObject(given.providers) ? given.providers : {}
	const live = isObject(catalog) ? catalog : { providers: [], warnings: [] }

	const providers = []
	const staleModels = []
	const seen = new Set()
	for (const entry of Array.isArray(live.providers) ? live.providers : []) {
		const id = text(isObject(entry) ? entry.id : undefined)
		if (id === undefined || seen.has(id)) continue
		seen.add(id)
		const preset = BOOK_PRESETS[id]
		const override = isObject(overrides[id]) ? overrides[id] : undefined
		const book = books.providers[id] === undefined ? books.fallback : books.providers[id]
		const source = preset !== undefined ? 'preset' : override !== undefined ? 'config' : 'book'
		const overridePricing = override !== undefined && isObject(override.pricing) ? override.pricing : undefined
		const overrideModels = overridePricing !== undefined && isObject(overridePricing.models) ? overridePricing.models : {}
		const leftover = new Set(Object.keys(overrideModels))

		const models = []
		for (const model of Array.isArray(entry.models) ? entry.models : []) {
			const modelId = text(isObject(model) ? model.id : undefined)
			if (modelId === undefined) continue
			if (models.some((known) => known.id === modelId)) continue
			leftover.delete(modelId)
			const configured = isObject(overrideModels[modelId]) ? overrideModels[modelId] : undefined
			const presetRow = preset !== undefined && isObject(preset.pricing.models[modelId])
			models.push({
				id: modelId,
				name: text(model.name) ?? modelId,
				source: configured !== undefined ? 'config' : presetRow ? 'preset' : 'book',
				rates: {
					idle: resolveRates(configured === undefined ? undefined : configured.idle, book.pricing.idle),
					peak: resolveRates(configured === undefined ? undefined : configured.peak, book.pricing.peak)
				},
				defaults: { idle: book.pricing.idle, peak: book.pricing.peak }
			})
		}
		for (const modelId of leftover) staleModels.push({ provider: id, model: modelId })
		// What this provider's rows would inherit with no override at all: the
		// preset when one exists, else the flat book. The editor needs it to show a
		// placeholder and to decide whether a row is a real override.
		const inherit = preset === undefined
			? { rules: books.fallback.rules, pricing: books.fallback.pricing }
			: { rules: preset.rules, pricing: preset.pricing }
		providers.push({
			id,
			name: text(entry.name) ?? id,
			source,
			rules: { ...book.rules, source: override !== undefined && overridesRules(override) ? 'config' : source },
			book: { idle: book.pricing.idle, peak: book.pricing.peak },
			defaults: {
				rules: { ...inherit.rules },
				book: { idle: inherit.pricing.idle, peak: inherit.pricing.peak }
			},
			models
		})
	}

	const staleProviders = Object.keys(overrides)
		.filter((id) => isObject(overrides[id]) && !seen.has(id))
		.sort()
	staleModels.sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))

	return {
		providers,
		fallback: {
			source: 'flat',
			rules: { ...books.fallback.rules, source: 'flat' },
			book: { idle: books.fallback.pricing.idle, peak: books.fallback.pricing.peak },
			defaults: {
				rules: { ...DEFAULT_RULES },
				book: { idle: DEFAULT_PRICING.idle, peak: DEFAULT_PRICING.peak }
			}
		},
		stale: { providers: staleProviders, models: staleModels },
		warnings: Array.isArray(live.warnings) ? live.warnings.filter((warning) => typeof warning === 'string') : []
	}
}

/**
 * Read one numeric rate: absent stays absent, anything present must be a finite
 * non-negative number (a numeric string is accepted, JSON never produces one).
 */
function takeRate(value, path, fail) {
	if (value === undefined || value === null) return undefined
	const number = Number(value)
	if (!Number.isFinite(number) || number < 0) {
		fail(path + ' must be a non-negative number')
		return undefined
	}
	return number
}

/** One `{ cacheHit, cacheMiss, cacheWrite, output }` block, or undefined when empty. */
function takeRates(value, path, fail) {
	if (!isObject(value)) {
		fail(path + ' must be an object')
		return undefined
	}
	const rates = {}
	for (const field of RATE_FIELDS) {
		const rate = takeRate(value[field], path + '.' + field, fail)
		if (rate !== undefined) rates[field] = rate
	}
	return Object.keys(rates).length > 0 ? rates : undefined
}

/** One per-model row: optional flat fields plus `idle` / `peak`. */
function takeModelRow(value, path, fail) {
	if (!isObject(value)) {
		fail(path + ' must be an object')
		return undefined
	}
	const row = {}
	for (const key of Object.keys(value)) {
		if (!RATE_FIELDS.includes(key) && !RATE_PERIODS.includes(key)) {
			fail(path + '.' + key + ' is not a rate field')
			return undefined
		}
	}
	for (const field of RATE_FIELDS) {
		const rate = takeRate(value[field], path + '.' + field, fail)
		if (rate !== undefined) row[field] = rate
	}
	for (const period of RATE_PERIODS) {
		if (value[period] === undefined) continue
		const rates = takeRates(value[period], path + '.' + period, fail)
		if (rates !== undefined) row[period] = rates
	}
	return Object.keys(row).length > 0 ? row : undefined
}

/** One key of a `providers` / `models` map: a real, bounded, non-reserved id. */
function takeId(value, path, fail) {
	if (typeof value !== 'string' || value.length === 0) {
		fail(path + ' must be a non-empty string')
		return false
	}
	if (value.length > 200) {
		fail(path + ' is too long')
		return false
	}
	if (FORBIDDEN_KEYS.has(value)) {
		fail(path + ' uses a reserved name')
		return false
	}
	return true
}

/** One price table. */
function takePricing(value, path, fail) {
	if (value === undefined) return undefined
	if (!isObject(value)) {
		fail(path + ' must be an object')
		return undefined
	}
	for (const key of Object.keys(value)) {
		if (!PRICING_KEYS.includes(key)) {
			fail(path + '.' + key + ' is not a pricing field')
			return undefined
		}
	}
	const pricing = {}
	if (value.currency !== undefined) {
		const currency = String(value.currency)
		if (currency.length === 0 || currency.length > 8) fail(path + '.currency must be 1-8 characters')
		else pricing.currency = currency
	}
	if (value.defaultModel !== undefined) {
		const model = String(value.defaultModel)
		if (model.length === 0 || model.length > 200) fail(path + '.defaultModel must be 1-200 characters')
		else pricing.defaultModel = model
	}
	for (const field of RATE_FIELDS) {
		const rate = takeRate(value[field], path + '.' + field, fail)
		if (rate !== undefined) pricing[field] = rate
	}
	for (const period of RATE_PERIODS) {
		if (value[period] === undefined) continue
		const rates = takeRates(value[period], path + '.' + period, fail)
		if (rates !== undefined) pricing[period] = rates
	}
	if (value.models !== undefined) {
		if (!isObject(value.models)) {
			fail(path + '.models must be an object')
		} else {
			const models = {}
			for (const id of Object.keys(value.models)) {
				if (!takeId(id, path + '.models', fail)) continue
				const row = takeModelRow(value.models[id], path + '.models.' + id, fail)
				if (row !== undefined) models[id] = row
			}
			pricing.models = models
		}
	}
	return Object.keys(pricing).length > 0 ? pricing : undefined
}

/** The five tariff-rule fields. */
function takeRules(value, path, fail) {
	const rules = {}
	if (value.utcOffsetMinutes !== undefined) {
		const offset = Number(value.utcOffsetMinutes)
		if (!Number.isFinite(offset) || Math.abs(offset) > 24 * 60) fail(path + '.utcOffsetMinutes must be minutes within ±1440')
		else rules.utcOffsetMinutes = offset
	}
	for (const key of ['peakWindows', 'holidays', 'workdays']) {
		if (value[key] === undefined) continue
		if (!Array.isArray(value[key])) {
			fail(path + '.' + key + ' must be an array')
			continue
		}
		const pattern = key === 'peakWindows' ? WINDOW_PATTERN : DATE_PATTERN
		const items = []
		for (const item of value[key]) {
			const entry = typeof item === 'string' ? item.trim() : ''
			if (!pattern.test(entry)) {
				fail(path + '.' + key + ' has an invalid entry: ' + JSON.stringify(item))
				continue
			}
			items.push(entry)
		}
		rules[key] = items
	}
	if (value.weekends !== undefined) {
		if (value.weekends !== 'idle' && value.weekends !== 'clock') fail(path + '.weekends must be "idle" or "clock"')
		else rules.weekends = value.weekends
	}
	return rules
}

/**
 * Validate a whole draft config and return the object to persist.
 *
 * The Client edits the row's config wholesale, so this is the only gate between
 * a browser and the profile patch: unknown keys are refused (a typo must not
 * silently do nothing), every number and pattern is checked, and the result is a
 * freshly built object, so no JSON key can reach a prototype.
 *
 * @param draft - the `config` value posted by the settings page.
 * @returns `{ config }` on success, `{ error }` describing the first problems.
 */
export function sanitizeConfig(draft) {
	if (!isObject(draft)) return { error: 'config must be an object' }
	const failures = []
	const fail = (problem) => {
		if (failures.length < 4) failures.push(problem)
	}
	for (const key of Object.keys(draft)) {
		if (!TOP_KEYS.includes(key)) fail('unknown field "' + key + '"')
	}
	const config = { ...takeRules(draft, 'config', fail) }
	const pricing = takePricing(draft.pricing === undefined ? undefined : draft.pricing, 'config.pricing', fail)
	if (draft.pricing !== undefined) {
		if (pricing !== undefined) config.pricing = pricing
	}
	if (draft.providers !== undefined) {
		if (!isObject(draft.providers)) {
			fail('config.providers must be an object')
		} else {
			const providers = {}
			for (const id of Object.keys(draft.providers)) {
				if (!takeId(id, 'config.providers', fail)) continue
				const book = draft.providers[id]
				if (!isObject(book)) {
					fail('config.providers.' + id + ' must be an object')
					continue
				}
				for (const key of Object.keys(book)) {
					if (!PROVIDER_KEYS.includes(key)) fail('config.providers.' + id + '.' + key + ' is not a known field')
				}
				const clean = { ...takeRules(book, 'config.providers.' + id, fail) }
				const bookPricing = takePricing(book.pricing === undefined ? undefined : book.pricing, 'config.providers.' + id + '.pricing', fail)
				if (book.pricing !== undefined && bookPricing !== undefined) clean.pricing = bookPricing
				providers[id] = clean
			}
			config.providers = providers
		}
	}
	if (failures.length > 0) return { error: failures.join('; ') }
	return { config }
}

/** The loader entry this plugin row owns, when the deployment exposes one. */
function entryOf(ctx) {
	const fiber = ctx === null || ctx === undefined ? undefined : ctx.fiber
	const entry = fiber === null || fiber === undefined ? undefined : fiber.entry
	if (entry !== undefined && entry !== null) return entry
	const editor = ctx.get('configEditor')
	if (editor === undefined || typeof editor.entries !== 'function') return undefined
	try {
		for (const candidate of editor.entries() ?? []) {
			const options = candidate === null || candidate === undefined ? undefined : candidate.options
			const name = options === undefined || options === null ? candidate?.name : options.name
			if (name === 'dsh-session-tariff') return candidate
		}
	} catch (_unreadable) {
		return undefined
	}
	return undefined
}

/** The profile patch id of one entry, for diagnostics in the page. */
function entryIdOf(entry) {
	const options = entry === null || entry === undefined ? undefined : entry.options
	return text(options === undefined || options === null ? entry?.id : options.id)
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload)
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.setHeader('content-length', Buffer.byteLength(body))
	res.end(body)
}

/** Read a bounded request body as UTF-8. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let bytes = 0
		req.on('data', (chunk) => {
			bytes += chunk.length
			if (bytes > MAX_BODY_BYTES) {
				reject(new Error('request body too large'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}

/**
 * Refuse a cross-site write. The page is same-origin, so a browser write sends
 * `application/json` (not settable by a plain HTML form) and, when it sends an
 * `Origin`, that origin must be this server. A request without either header is
 * a local tool call, not a browser form post.
 */
function crossSite(req) {
	const origin = req.headers.origin
	if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
		let host
		try {
			host = new URL(origin).host
		} catch (_invalid) {
			return true
		}
		if (host !== req.headers.host) return true
	}
	const type = req.headers['content-type']
	return typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')
}

/** Build the descriptor plus the fields only the Host knows. */
async function stateOf(ctx, config) {
	const catalog = await liveCatalog(ctx.get('llm'))
	const entry = entryOf(ctx)
	const editor = ctx.get('configEditor')
	return {
		ok: true,
		entryId: entryIdOf(entry),
		writable: entry !== undefined && editor !== undefined,
		currency: resolveFlatBook(config).pricing.currency,
		config,
		...describeState(config, catalog)
	}
}

/** One JSON API request. */
async function handleApi(ctx, req, res, current) {
	const url = new URL(req.url ?? '/', 'http://localhost')
	const path = url.pathname.slice(API_PREFIX.length) || '/'
	if (path === '/state' && req.method === 'GET') {
		sendJson(res, 200, await stateOf(ctx, current()))
		return
	}
	if (path === '/save' && req.method === 'POST') {
		if (crossSite(req)) {
			sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
			return
		}
		let body
		try {
			body = await readBody(req)
		} catch (error) {
			sendJson(res, 413, { ok: false, error: messageOf(error) })
			return
		}
		let parsed
		try {
			parsed = JSON.parse(body)
		} catch (_invalid) {
			sendJson(res, 200, { ok: false, error: 'request body is not JSON' })
			return
		}
		const sanitized = sanitizeConfig(isObject(parsed) ? parsed.config : undefined)
		if (sanitized.error !== undefined) {
			sendJson(res, 200, { ok: false, error: sanitized.error })
			return
		}
		const editor = ctx.get('configEditor')
		const entry = entryOf(ctx)
		if (editor === undefined || entry === undefined) {
			sendJson(res, 200, { ok: false, error: 'this deployment exposes no writable profile row for the plugin' })
			return
		}
		try {
			await editor.edit(entry, () => sanitized.config)
		} catch (error) {
			sendJson(res, 200, { ok: false, error: 'write failed: ' + messageOf(error) })
			return
		}
		sendJson(res, 200, { ok: true, state: await stateOf(ctx, sanitized.config) })
		return
	}
	sendJson(res, 404, { ok: false, error: 'not found' })
}
