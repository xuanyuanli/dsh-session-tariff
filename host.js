/**
 * Host half of the session-tariff bundle.
 *
 * Registers the `sessionCost` session projection: it folds durable provider usage
 * per model request and classifies each request by the tariff period it started
 * in (peak vs idle), so the Client can price the whole log against both period
 * rates. The Client half owns rendering and unit prices.
 *
 * Classification follows the published DeepSeek rules: `peakWindows` apply on
 * workdays in the configured offset; weekends, listed holidays and every other
 * hour of the day are idle. A request's period is the `.time` of the `step/start`
 * that opened it, which is when the provider was called; a request retried inside
 * the same step keeps that step's period.
 */

/** Cordis plugin name. */
export const name = 'session-tariff'

/** The projection registry is this plugin's whole purpose. */
export const inject = ['sessionProjections']

/**
 * Default tariff rules. `utcOffsetMinutes: 480` is Asia/Shanghai (no DST).
 * `holidays` / `workdays` take `YYYY-MM-DD` keys; `workdays` wins, so a
 * make-up workday that lands on a weekend is classified as a workday.
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

const BUCKET_FIELDS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']

/**
 * Normalize one period bucket row (four token fields plus a request count).
 * @param value - candidate row.
 * @returns a complete row; unknown or invalid numbers become 0.
 */
function normalizeRow(value) {
	const row = value !== null && typeof value === 'object' ? value : {}
	const result = {}
	for (const field of BUCKET_FIELDS) {
		const number = Number(row[field])
		result[field] = Number.isFinite(number) && number > 0 ? number : 0
	}
	const requests = Number(row.requests)
	result.requests = Number.isFinite(requests) && requests > 0 ? Math.floor(requests) : 0
	return result
}

/** The wire value schema: the registry only requires a synchronous `parse`. */
const rowSchema = { parse: normalizeRow }

const viewSchema = {
	parse: (value) => {
		const view = value !== null && typeof value === 'object' ? value : {}
		const windows = Array.isArray(view.peakWindows) ? view.peakWindows.filter((entry) => typeof entry === 'string') : []
		const models = Array.isArray(view.models)
			? view.models
				.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.model === 'string' && entry.model.length > 0)
				.map((entry) => ({ model: entry.model, idle: normalizeRow(entry.idle), peak: normalizeRow(entry.peak) }))
			: []
		return {
			idle: normalizeRow(view.idle),
			peak: normalizeRow(view.peak),
			peakWindows: windows,
			weekends: view.weekends === 'clock' ? 'clock' : 'idle',
			models
		}
	}
}

const stateSchema = {
	parse: (value) => {
		const state = value !== null && typeof value === 'object' ? value : {}
		const openStep = state.openStep !== null && typeof state.openStep === 'object' ? state.openStep : null
		const last = state.last !== null && typeof state.last === 'object' ? state.last : null
		const models = {}
		if (state.models !== null && typeof state.models === 'object' && !Array.isArray(state.models)) {
			for (const key of Object.keys(state.models)) {
				const entry = state.models[key]
				if (entry !== null && typeof entry === 'object') models[key] = { idle: normalizeRow(entry.idle), peak: normalizeRow(entry.peak) }
			}
		}
		return {
			idle: normalizeRow(state.idle),
			peak: normalizeRow(state.peak),
			models,
			openModel: typeof state.openModel === 'string' && state.openModel.length > 0 ? state.openModel : null,
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
					model: typeof last.model === 'string' && last.model.length > 0 ? last.model : undefined
				}
		}
	}
}

/** Normalize the loader row's config over the defaults. */
function resolveRules(config) {
	const given = config !== null && typeof config === 'object' ? config : {}
	const offset = Number(given.utcOffsetMinutes)
	const windows = Array.isArray(given.peakWindows)
		? given.peakWindows.filter((entry) => typeof entry === 'string' && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(entry))
		: DEFAULT_RULES.peakWindows
	const strings = (list, fallback) => Array.isArray(list)
		? list.filter((entry) => typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry))
		: fallback
	return {
		utcOffsetMinutes: Number.isFinite(offset) ? offset : DEFAULT_RULES.utcOffsetMinutes,
		peakWindows: windows.length > 0 ? windows : DEFAULT_RULES.peakWindows,
		holidays: strings(given.holidays, DEFAULT_RULES.holidays),
		workdays: strings(given.workdays, DEFAULT_RULES.workdays),
		weekends: given.weekends === 'clock' ? 'clock' : DEFAULT_RULES.weekends
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
 * Classify one request time into `peak` or `idle`.
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
		if (record !== null && typeof record === 'object' && record.type === 'chunk'
			&& record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage') {
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

/**
 * Model id of one settlement: `message.source.model` on a durable
 * `assistant/message`. `assistant/attempt` carries no source, and retries keep
 * the provider/model of the request that opened the step, so the step's model
 * is recorded on `step/start` from the most recent durable message.
 * @param event - a session event.
 * @returns the model id, or undefined.
 */
export function modelOf(event) {
	if (event.type !== 'assistant/message') return undefined
	const source = event.data.message !== null && typeof event.data.message === 'object' ? event.data.message.source : undefined
	if (source === null || typeof source !== 'object') return undefined
	return typeof source.model === 'string' && source.model.length > 0 ? source.model : undefined
}

/**
 * Merge two period aggregates field by field.
 * @param left - accumulated rows, or undefined.
 * @param right - rows to add.
 * @returns the merged rows.
 */
function addPeriods(left, right) {
	const merged = {}
	for (const key of ['idle', 'peak']) {
		const a = left === undefined ? zeroRow() : left[key]
		const b = right[key]
		const row = { requests: a.requests + b.requests }
		for (const field of BUCKET_FIELDS) row[field] = a[field] + b[field]
		merged[key] = row
	}
	return merged
}

/** Compare two samples for fold suppression. */
export function bucketsEqual(left, right) {
	return BUCKET_FIELDS.every((field) => left[field] === right[field])
}

/**
 * Build the `sessionCost` unit for one set of tariff rules.
 * @param rules - resolved tariff rules (captured by the wire view).
 * @returns the projection definition.
 */
export function createSessionCostDefinition(rules) {
	return {
		key: 'sessionCost',
		stateVersion: 1,
		stateSchema,
		init: () => ({ idle: zeroRow(), peak: zeroRow(), openStep: null, last: null, models: {}, openModel: null }),
		apply: (state, event) => {
			if (event.type === 'step/start') {
				return {
					...state,
					openStep: { turn: event.data.turn, step: event.data.step, start: event.time }
				}
			}
			if (event.type === 'step/end') {
				const next = state.openStep === null ? state : { ...state, openStep: null }
				return next.openModel === null ? next : { ...next, openModel: null }
			}
			if (event.type === 'llm/retry-started') {
				const last = state.last
				if (last === null || last.turn !== event.data.turn || last.step !== event.data.step) return state
				return { ...state, last: null }
			}
			if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
			const sample = usageOf(event)
			const messageModel = modelOf(event)
			if (sample === undefined) {
				// A durable message with no usage still pins the step's model, so a later
				// `assistant/attempt` in the same step is attributed correctly.
				return messageModel === undefined || state.openModel === messageModel
					? state
					: { ...state, openModel: messageModel }
			}
			const { turn, step } = event.data
			const open = state.openStep
			const sameStep = open !== null && open.turn === turn && open.step === step
			const start = sameStep ? open.start : event.time
			const period = classifyPeriod(start, rules)
			const buckets = bucketsOf(sample)
			const model = messageModel ?? (sameStep ? state.openModel : null)
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
			// Per-model rows mirror the total fold, keyed by the model that served
			// the request, so each model can be priced at its own published rates.
			const models = {}
			for (const key of Object.keys(state.models)) models[key] = state.models[key]
			const touched = previous !== null && previous.model !== undefined ? previous.model : model
			if (touched !== null) {
				const before = models[touched] === undefined ? { idle: zeroRow(), peak: zeroRow() } : models[touched]
				let rowIdle = before.idle
				let rowPeak = before.peak
				if (previous !== null && previous.model === touched) {
					if (previous.period === 'peak') rowPeak = shiftRow(rowPeak, previous.buckets, -1)
					else rowIdle = shiftRow(rowIdle, previous.buckets, -1)
				}
				if (period === 'peak') rowPeak = shiftRow(rowPeak, buckets, 1)
				else rowIdle = shiftRow(rowIdle, buckets, 1)
				models[touched] = { idle: rowIdle, peak: rowPeak }
			}
			return {
				idle,
				peak,
				openStep: state.openStep,
				openModel: model ?? state.openModel,
				models,
				last: { turn, step, period, buckets, model: model ?? undefined }
			}
		},
		wire: {
			viewSchema,
			view: (state) => ({
				idle: state.idle,
				peak: state.peak,
				peakWindows: rules.peakWindows,
				weekends: rules.weekends,
				models: Object.keys(state.models).sort().map((model) => ({
					model,
					idle: state.models[model].idle,
					peak: state.models[model].peak
				}))
			})
		}
	}
}

/**
 * Register the unit; the registration is an effect on this plugin's fiber.
 * @param ctx - registrant context carrying the projection registry.
 * @param config - optional tariff-rule overrides from the loader row.
 */
export function apply(ctx, config) {
	ctx.sessionProjections.register(createSessionCostDefinition(resolveRules(config)))
}
