/**
 * Tests for the price-book editor half: live-catalog overlay, config validation,
 * and the JSON API that the settings page in Settings → Plugins talks to.
 *
 * The API is exercised through the real `apply()` wiring with a fake cordis
 * context, so route registration, request dispatch, and the `configEditor` write
 * are all covered without booting the harness.
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
	DEFAULT_PRICING,
	BOOK_PRESETS,
	apply,
	createSessionCostDefinition,
	describeState,
	liveCatalog,
	plainConfig,
	resolveBooks,
	sanitizeConfig
} from '../host.js'

function createEntry() {
	return { options: { id: 'session-tariff', name: 'dsh-session-tariff' } }
}

/** A live catalog with one preset provider, one catalogue-only model, and one unknown provider. */
const CATALOG = {
	providers: [
		{
			id: 'bailian',
			name: 'bailian',
			models: [
				{ id: 'deepseek-v4.1-flash-1017', name: 'deepseek-v4.1-flash-1017' },
				{ id: 'brand-new-model', name: 'brand-new-model' }
			]
		},
		{ id: 'bailian-tokenplan', name: 'bailian-tokenplan', models: [{ id: 'glm-5.3', name: 'glm-5.3' }] }
	],
	warnings: []
}

const RATES = { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
const PEAK_RATES = { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }

/** The `llm` service face `liveCatalog()` reads, backed by CATALOG. */
const fakeLlm = () => ({
	listProviders: () => CATALOG.providers.map((entry) => ({ id: entry.id, name: entry.name })),
	listModels: async (id) => (CATALOG.providers.find((entry) => entry.id === id) ?? { models: [] }).models
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('sanitizeConfig accepts the documented shape and keeps it', () => {
	const draft = {
		utcOffsetMinutes: 480,
		peakWindows: ['09:00-12:00', '14:00-18:00'],
		weekends: 'idle',
		holidays: ['2026-10-01'],
		workdays: ['2026-10-10'],
		pricing: { currency: '¥', idle: RATES, peak: PEAK_RATES, models: { 'm-1': { idle: RATES, peak: PEAK_RATES } } },
		providers: {
			bailian: {
				peakWindows: ['08:00-22:00'],
				weekends: 'clock',
				pricing: { idle: RATES, peak: PEAK_RATES, models: { glm: { idle: { cacheHit: 2, cacheMiss: 8, cacheWrite: 8, output: 28 } } } }
			}
		}
	}
	const result = sanitizeConfig(draft)
	assert.equal(result.error, undefined)
	assert.deepEqual(result.config, draft)
})

test('sanitizeConfig refuses unknown fields instead of silently dropping them', () => {
	assert.match(sanitizeConfig({ peakWidows: ['09:00-12:00'] }).error, /unknown field/)
	assert.match(sanitizeConfig({ providers: { bailian: { peakWindow: [] } } }).error, /not a known field/)
	assert.match(sanitizeConfig({ pricing: { cachehit: 1 } }).error, /not a pricing field/)
	assert.match(sanitizeConfig({ providers: { bailian: { pricing: { models: { m: { cacheHits: 1 } } } } } }).error, /not a rate field/)
})

test('sanitizeConfig refuses bad numbers and bad patterns', () => {
	assert.match(sanitizeConfig({ pricing: { idle: { cacheHit: -1 } } }).error, /non-negative/)
	assert.match(sanitizeConfig({ pricing: { idle: { cacheHit: 'free' } } }).error, /non-negative/)
	assert.match(sanitizeConfig({ peakWindows: ['9:00-12:00'] }).error, /invalid entry/)
	assert.match(sanitizeConfig({ holidays: ['2026/10/01'] }).error, /invalid entry/)
	assert.match(sanitizeConfig({ weekends: 'holidays' }).error, /idle" or "clock/)
	assert.match(sanitizeConfig({ utcOffsetMinutes: 99999 }).error, /within/)
	assert.match(sanitizeConfig('nope').error, /must be an object/)
	assert.match(sanitizeConfig([]).error, /must be an object/)
})

test('sanitizeConfig refuses prototype-pollution keys', () => {
	const draft = JSON.parse('{"providers":{"__proto__":{"pricing":{"idle":{"cacheHit":0,"cacheMiss":0,"cacheWrite":0,"output":0}}}}}')
	assert.match(sanitizeConfig(draft).error, /reserved name/)
	assert.equal(Object.prototype.cacheHit, undefined)
	const model = JSON.parse('{"providers":{"bailian":{"pricing":{"models":{"constructor":{"idle":{"cacheHit":0,"cacheMiss":0,"cacheWrite":0,"output":0}}}}}}}')
	assert.match(sanitizeConfig(model).error, /reserved name/)
})

test('sanitizeConfig drops empty rows so a cleared override stops being pinned', () => {
	const result = sanitizeConfig({ providers: { bailian: { pricing: { models: { 'm-1': {} } } } } })
	assert.equal(result.error, undefined)
	assert.deepEqual(result.config, { providers: { bailian: { pricing: { models: {} } } } })
})

// ---------------------------------------------------------------------------
// Live catalog
// ---------------------------------------------------------------------------

test('liveCatalog lists every registered provider and model, sorted', async () => {
	const llm = {
		listProviders: () => [{ id: 'zulu', name: 'Zulu' }, { id: 'alpha' }],
		listModels: async (provider) => (provider === 'zulu' ? [{ id: 'm-2' }, { id: 'm-1', name: 'Model One' }] : [])
	}
	const catalog = await liveCatalog(llm)
	assert.deepEqual(catalog.providers.map((entry) => entry.id), ['alpha', 'zulu'])
	assert.deepEqual(catalog.providers[1].models.map((model) => model.id), ['m-1', 'm-2'])
	assert.equal(catalog.providers[1].models[0].name, 'Model One')
	assert.deepEqual(catalog.warnings, [])
})

test('liveCatalog keeps a provider whose model list failed and reports why', async () => {
	const llm = {
		listProviders: () => [{ id: 'bailian' }],
		listModels: async () => {
			throw new Error('adapter offline')
		}
	}
	const catalog = await liveCatalog(llm)
	assert.deepEqual(catalog.providers, [{ id: 'bailian', name: 'bailian', models: [] }])
	assert.equal(catalog.warnings.length, 1)
	assert.match(catalog.warnings[0], /adapter offline/)
})

test('liveCatalog degrades without an llm service', async () => {
	const catalog = await liveCatalog(undefined)
	assert.deepEqual(catalog.providers, [])
	assert.equal(catalog.warnings.length, 1)
})

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

test('describeState prices a new model from its provider book, not from nothing', () => {
	const state = describeState({}, CATALOG)
	assert.deepEqual(state.providers.map((entry) => entry.id), ['bailian', 'bailian-tokenplan'])
	const bailian = state.providers[0]
	assert.equal(bailian.source, 'preset')
	const known = bailian.models.find((model) => model.id === 'deepseek-v4.1-flash-1017')
	const fresh = bailian.models.find((model) => model.id === 'brand-new-model')
	// The preset has that model; a model the preset never heard of inherits the book.
	assert.equal(known.source, 'preset')
	assert.deepEqual(known.rates.idle, BOOK_PRESETS.bailian.pricing.models['deepseek-v4.1-flash-1017'].idle)
	assert.equal(fresh.source, 'book')
	assert.deepEqual(fresh.rates, { idle: BOOK_PRESETS.bailian.pricing.idle, peak: BOOK_PRESETS.bailian.pricing.peak })
	assert.deepEqual(fresh.defaults, fresh.rates)
	// A provider with no preset bills from the flat fallback book.
	const unknown = state.providers[1]
	assert.equal(unknown.source, 'book')
	assert.deepEqual(unknown.book, { idle: DEFAULT_PRICING.idle, peak: DEFAULT_PRICING.peak })
	assert.deepEqual(state.stale, { providers: [], models: [] })
	assert.deepEqual(state.fallback.rules.peakWindows, ['09:00-12:00', '14:00-18:00'])
})

test('describeState reports overrides, their source, and what they leave behind', () => {
	const config = {
		providers: {
			bailian: {
				weekends: 'idle',
				pricing: { models: { 'brand-new-model': { idle: RATES, peak: PEAK_RATES }, 'gone-model': { idle: RATES } } }
			},
			'old-provider': { pricing: { idle: RATES } }
		}
	}
	const state = describeState(config, CATALOG)
	const bailian = state.providers.find((entry) => entry.id === 'bailian')
	const fresh = bailian.models.find((model) => model.id === 'brand-new-model')
	assert.equal(fresh.source, 'config')
	assert.deepEqual(fresh.rates.idle, RATES)
	assert.deepEqual(fresh.defaults.idle, BOOK_PRESETS.bailian.pricing.idle)
	assert.equal(bailian.rules.source, 'config')
	assert.equal(bailian.rules.weekends, 'idle')
	assert.deepEqual(state.stale, { providers: ['old-provider'], models: [{ provider: 'bailian', model: 'gone-model' }] })
})

// ---------------------------------------------------------------------------
// Wire/config plumbing
// ---------------------------------------------------------------------------

test('plainConfig unwraps volatile references and tolerates plain values', () => {
	const write = Symbol.for('cosmokit.volatile.write')
	const ref = (value) => ({ get: () => value, [write]: () => undefined })
	assert.deepEqual(plainConfig({ providers: ref({ a: 1 }), utcOffsetMinutes: ref(480), plain: 2 }), {
		providers: { a: 1 },
		utcOffsetMinutes: 480,
		plain: 2
	})
	assert.deepEqual(plainConfig(undefined), {})
	assert.deepEqual(plainConfig('nope'), {})
})

test('createSessionCostDefinition reprices its published view without re-registering', () => {
	let config = {}
	const definition = createSessionCostDefinition(() => resolveBooks(config))
	const state = definition.init()
	const before = definition.wire.view(state)
	assert.equal(before.books.find((book) => book.provider === 'bailian').idle.cacheHit, 0.1)
	config = { providers: { bailian: { pricing: { idle: { cacheHit: 9 } } } } }
	const after = definition.wire.view(state)
	assert.equal(after.books.find((book) => book.provider === 'bailian').idle.cacheHit, 9)
})

// ---------------------------------------------------------------------------
// JSON API through apply()
// ---------------------------------------------------------------------------

function harness(options = {}) {
	const recorded = { projection: undefined, route: undefined, edits: [] }
	const entry = options.entry === undefined ? createEntry() : options.entry
	recorded.entry = entry
	let handler
	const ctx = {
		fiber: { entry },
		sessionProjections: {
			register: (definition) => {
				recorded.projection = definition
			}
		},
		get: (name) => {
			if (name === 'llm') return options.llm
			if (name === 'configEditor') return options.editor
			return undefined
		},
		inject: (names, callback) => {
			const child = {
				webServer: {
					register: (route) => {
						recorded.route = route
						handler = route.handler
						return () => undefined
					}
				},
				effect: (fn) => fn()
			}
			callback(child)
		}
	}
	apply(ctx, options.config)
	return { recorded, ctx, handler: () => handler }
}

function call(handler, { method = 'GET', path = '/state', body = '', headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no response')), 3000)
		const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
		req.method = method
		req.url = '/dsh-session-tariff/api' + path
		req.headers = headers
		const res = {
			statusCode: 200,
			headers: {},
			setHeader(key, value) {
				this.headers[String(key).toLowerCase()] = value
			},
			end(chunk) {
				clearTimeout(timer)
				resolve({ status: this.statusCode, headers: this.headers, body: chunk === undefined ? undefined : JSON.parse(chunk) })
			}
		}
		handler(req, res)
	})
}

test('apply registers a prefix route and the projection', async () => {
	const { recorded } = harness({})
	assert.equal(recorded.route.kind, 'prefix')
	assert.equal(recorded.route.path, '/dsh-session-tariff/api')
	assert.equal(recorded.projection.key, 'sessionCost')
})

test('GET /state returns the live catalog, the raw config, and writability', async () => {
	const editor = { entries: () => [], edit: async () => undefined }
	const created = harness({
		llm: fakeLlm(),
		editor,
		config: { providers: { bailian: { pricing: { currency: '¥' } } } }
	})
	const response = await call(created.handler())
	assert.equal(response.status, 200)
	assert.equal(response.body.ok, true)
	assert.equal(response.body.entryId, 'session-tariff')
	assert.equal(response.body.writable, true)
	assert.deepEqual(response.body.config, { providers: { bailian: { pricing: { currency: '¥' } } } })
	assert.deepEqual(response.body.providers.map((entry) => entry.id), ['bailian', 'bailian-tokenplan'])
})

test('the config the Loader entry carries wins over the apply-time argument', async () => {
	const created = harness({
		llm: fakeLlm(),
		editor: { entries: () => [], edit: async () => undefined },
		entry: { options: { id: 'session-tariff', name: 'dsh-session-tariff', config: { providers: { bailian: { pricing: { idle: { cacheHit: 7 } } } } } } },
		config: { providers: { bailian: { pricing: { idle: { cacheHit: 1 } } } } }
	})
	const response = await call(created.handler())
	const bailian = response.body.state === undefined ? response.body.providers[0] : response.body.providers[0]
	assert.deepEqual(bailian.book.idle.cacheHit, 7)
})

test('a save is visible to the next read once the Loader entry carries it', async () => {
	const entries = []
	const created = harness({
		llm: fakeLlm(),
		editor: {
			entries: () => [],
			edit: async (entry, change) => {
				const next = change({}, {})
				entries.push(next)
				// What the Loader does: the entry now reports the persisted config,
				// and the plugin is re-applied, so a fresh apply() reads this value.
				entry.options.config = next
			}
		},
		config: {}
	})
	const draft = { providers: { bailian: { pricing: { models: { 'brand-new-model': { idle: RATES } } } } } }
	const saved = await call(created.handler(), {
		method: 'POST',
		path: '/save',
		body: JSON.stringify({ config: draft }),
		headers: { 'content-type': 'application/json', host: '127.0.0.1:60496' }
	})
	assert.equal(saved.body.ok, true)
	assert.deepEqual(entries, [draft])
	const reread = await call(created.handler())
	assert.deepEqual(reread.body.config, draft)
	const bailian = reread.body.providers.find((entry) => entry.id === 'bailian')
	assert.deepEqual(bailian.models.find((model) => model.id === 'brand-new-model').rates.idle, RATES)
	assert.equal(bailian.models.find((model) => model.id === 'brand-new-model').source, 'config')
})

test('POST /save writes the sanitized config through configEditor and answers with fresh state', async () => {
	const edits = []
	const editor = {
		entries: () => [],
		edit: async (entry, change) => {
			edits.push({ entry, next: change({}, {}) })
		}
	}
	const created = harness({ llm: fakeLlm(), editor, config: {} })
	const draft = {
		providers: { bailian: { pricing: { models: { 'brand-new-model': { idle: RATES, peak: PEAK_RATES } } } } }
	}
	const response = await call(created.handler(), {
		method: 'POST',
		path: '/save',
		body: JSON.stringify({ config: draft }),
		headers: { 'content-type': 'application/json', host: '127.0.0.1:60496' }
	})
	assert.equal(response.status, 200)
	assert.equal(edits.length, 1)
	assert.equal(edits[0].entry, created.recorded.entry)
	assert.deepEqual(edits[0].next, draft)
	assert.equal(response.body.state != null, true)
	const bailian = response.body.state.providers.find((entry) => entry.id === 'bailian')
	assert.deepEqual(bailian.models.find((model) => model.id === 'brand-new-model').rates.idle, RATES)
})

test('POST /save refuses an invalid draft without writing', async () => {
	let called = false
	const editor = { entries: () => [], edit: async () => { called = true } }
	const created = harness({ editor })
	const response = await call(created.handler(), {
		method: 'POST',
		path: '/save',
		body: JSON.stringify({ config: { pricing: { idle: { cacheHit: -3 } } } }),
		headers: { 'content-type': 'application/json', host: '127.0.0.1:60496' }
	})
	assert.equal(response.body.ok, false)
	assert.match(response.body.error, /non-negative/)
	assert.equal(called, false)
})

test('POST /save refuses a cross-site or form-encoded write', async () => {
	const editor = { entries: () => [], edit: async () => undefined }
	const created = harness({ editor })
	const crossOrigin = await call(created.handler(), {
		method: 'POST',
		path: '/save',
		body: '{"config":{}}',
		headers: { 'content-type': 'application/json', host: '127.0.0.1:60496', origin: 'https://evil.example' }
	})
	assert.equal(crossOrigin.status, 403)
	const formPost = await call(created.handler(), {
		method: 'POST',
		path: '/save',
		body: 'config=',
		headers: { 'content-type': 'application/x-www-form-urlencoded', host: '127.0.0.1:60496' }
	})
	assert.equal(formPost.status, 403)
})

test('POST /save reports a deployment without a writable row', async () => {
	const created = harness({ editor: undefined })
	const response = await call(created.handler(), {
		method: 'POST',
		path: '/save',
		body: '{"config":{}}',
		headers: { 'content-type': 'application/json', host: '127.0.0.1:60496' }
	})
	assert.equal(response.body.ok, false)
	assert.match(response.body.error, /no writable profile row/)
})

test('unknown paths and methods are not routed', async () => {
	const { handler } = harness({})
	const missing = await call(handler(), { path: '/nope' })
	assert.equal(missing.status, 404)
	const wrongMethod = await call(handler(), { method: 'POST', path: '/state', body: '{}', headers: { 'content-type': 'application/json' } })
	assert.equal(wrongMethod.status, 404)
})