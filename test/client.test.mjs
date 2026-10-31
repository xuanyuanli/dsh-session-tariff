/**
 * Integration test for the price-book page in Settings → Plugins.
 *
 * The page has no build step and runs in the DSH web client, so this loads
 * `client.js` in a `vm` sandbox with a tiny React shim, renders the settings
 * component once, then drives real `onChange` / `onClick` handlers and checks
 * what reaches `fetch`. That covers the wiring a browser would otherwise be
 * needed for: catalog → rows, edits → POST body, save → re-render.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

// ---------------------------------------------------------------------------
// A minimal React: elements, the four hooks the page uses, and a runner.
// ---------------------------------------------------------------------------

function createReact() {
	const React = {
		Fragment: Symbol('Fragment'),
		createElement(type, props, ...children) {
			return { type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity) }
		},
		useState() {
			throw new Error('hook called outside a render')
		}
	}
	return React
}

function textOf(node) {
	if (node === null || node === undefined || node === false || node === true) return ''
	if (typeof node === 'string' || typeof node === 'number') return String(node)
	if (Array.isArray(node)) return node.map(textOf).join(' ')
	if (!node.children) return ''
	return node.children.map(textOf).join(' ')
}

function elementsOf(node, predicate, found = []) {
	if (Array.isArray(node)) {
		for (const child of node) elementsOf(child, predicate, found)
		return found
	}
	if (node === null || typeof node !== 'object' || !node.type) return found
	if (predicate(node)) found.push(node)
	elementsOf(node.children, predicate, found)
	return found
}

function findByLabel(tree, label) {
	return elementsOf(tree, (node) => node.props['aria-label'] === label)[0]
}

function byClass(tree, className) {
	return elementsOf(tree, (node) => node.props.className === className)
}

/** Mount one function component and return render/drive handles. */
function mount(React, Component) {
	const slots = []
	let cursor = 0
	let tree = null
	let pending = null
	let liveEffects = []

	function runEffects(effects) {
		for (const effect of effects) {
			const cleanup = effect()
			if (typeof cleanup === 'function') liveEffects.push(cleanup)
		}
	}

	/**
	 * Expand function components the way React would, so a cell that wraps the
	 * editor (as the Plugins page cells do) renders through to host elements.
	 * Hook order stays deterministic because expansion is depth-first.
	 */
	function expand(node) {
		if (node === null || node === undefined || typeof node !== 'object') return node
		if (Array.isArray(node)) return node.map(expand)
		if (typeof node.type === 'function') return expand(node.type(node.props))
		if (!node.children) return node
		return { type: node.type, props: node.props, children: node.children.map(expand) }
	}

	function render() {
		cursor = 0
		const effects = []
		function nextSlot() {
			const slot = cursor
			cursor += 1
			if (!(slot in slots)) slots[slot] = { value: undefined, deps: undefined }
			return [slots[slot], slot]
		}
		function useState(initial) {
			const [slot] = nextSlot()
			if (slot.value === undefined) slot.value = typeof initial === 'function' ? initial() : initial
			return [slot.value, (next) => {
				const value = typeof next === 'function' ? next(slot.value) : next
				if (Object.is(value, slot.value)) return
				slot.value = value
				schedule()
			}]
		}
		function useEffect(fn, deps) {
			const [slot] = nextSlot()
			if (slot.deps === undefined || !sameDeps(slot.deps, deps)) {
				slot.deps = deps
				effects.push(fn)
			}
		}
		function useLayoutEffect(fn, deps) {
			useEffect(fn, deps)
		}
		function useCallback(fn, deps) {
			const [slot] = nextSlot()
			if (slot.value === undefined || !sameDeps(slot.deps, deps)) {
				slot.value = fn
				slot.deps = deps
			}
			return slot.value
		}
		function useMemo(fn, deps) {
			const [slot] = nextSlot()
			if (slot.value === undefined || !sameDeps(slot.deps, deps)) {
				slot.value = fn()
				slot.deps = deps
			}
			return slot.value
		}
		function useRef(value) {
			const [slot] = nextSlot()
			if (slot.value === undefined) slot.value = { current: value }
			return slot.value
		}
		function useId() {
			nextSlot()
			return 'id'
		}
		function schedule() {
			if (pending !== null) return
			pending = Promise.resolve().then(() => {
				pending = null
				render()
			})
		}
		globalThis.__reactRender = { nextSlot, useState, useEffect, useCallback, useMemo, useRef, useId }

		const result = Component()
		tree = expand(result)
		runEffects(effects)
		return tree
	}

	return {
		render,
		get tree() {
			return tree
		},
		async flush() {
			for (let round = 0; round < 6; round += 1) {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			return tree
		},
		unmount() {
			for (const cleanup of liveEffects.splice(0)) cleanup()
		}
	}
}

function sameDeps(left, right) {
	if (left === undefined || right === undefined) return false
	if (left.length !== right.length) return false
	return left.every((value, index) => Object.is(value, right[index]))
}

// ---------------------------------------------------------------------------
// Load client.js into a sandbox with the hooks above.
// ---------------------------------------------------------------------------

function loadPlugin({ fetch: fetchImpl, locale = 'zh' }) {
	const React = createReact()
	const dictionaries = { zh: {}, en: {} }
	let language = locale
	const registered = []
	const document = {
		head: { appendChild() {} },
		createElement: () => ({ dataset: {}, textContent: '', remove() {} })
	}
	const window = { __ModuleLoader__: { load: (definition) => { window.__loaded = definition } } }
	const sandbox = {
		window,
		document,
		fetch: fetchImpl,
		console,
		setTimeout,
		clearTimeout,
		Promise,
		JSON,
		Object,
		Array,
		Number,
		String,
		Error,
		Symbol,
		Math
	}
	vm.createContext(sandbox)
	vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
	const definition = window.__loaded
	assert.ok(definition, 'client.js registered a module definition')
	const module = definition.factory((name) => {
		if (name === 'react') {
			// Route the page's hook calls through the runner installed at render time.
			return new Proxy(React, {
				get(target, key) {
					if (key === 'createElement') return target.createElement
					if (key === 'Fragment') return target.Fragment
					const runner = globalThis.__reactRender
					if (runner && typeof runner[key] === 'function') return runner[key]
					return target[key]
				}
			})
		}
		if (name === 'react-dom') return { createPortal: (node) => node }
		throw new Error('unexpected require: ' + name)
	})
	const ctx = {
		effect: (fn) => {
			const disposer = fn()
			return typeof disposer === 'function' ? disposer : () => undefined
		},
		locale: {
			register: (namespace, tables) => {
				dictionaries.zh = tables.zh
				dictionaries.en = tables.en
				return () => undefined
			},
			bind: (namespace) => (key, params) => {
				const table = dictionaries[language] || {}
				const text = table[key] === undefined ? key : table[key]
				if (params === undefined) return text
				return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
			}
		},
		slots: {
			inject: (name, callback) => callback(),
			register: (options, component) => {
				registered.push({ options, component })
				return () => undefined
			}
		}
	}
	module.apply(ctx, undefined)
	return {
		registered,
		React,
		setLocale(next) {
			language = next
		},
		dictionaries
	}
}

/** A descriptor shaped exactly like GET /state. */
function descriptor(overrides = {}) {
	return Object.assign({
		ok: true,
		entryId: 'session-tariff',
		writable: true,
		config: {},
		providers: [
			{
				id: 'bailian',
				name: 'bailian',
				source: 'preset',
				rules: { peakWindows: ['09:00-12:00'], weekends: 'idle', utcOffsetMinutes: 480, holidays: [], workdays: [], source: 'preset' },
				book: { idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }, peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 } },
				defaults: {
					rules: { peakWindows: ['09:00-12:00'], weekends: 'idle', utcOffsetMinutes: 480, holidays: [], workdays: [] },
					book: { idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }, peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 } }
				},
				models: [
					{
						id: 'deepseek-v4.1-flash-1017',
						name: 'deepseek-v4.1-flash-1017',
						source: 'preset',
						rates: { idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }, peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 } },
						defaults: { idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }, peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 } }
					},
					{
						id: 'brand-new-model',
						name: 'brand-new-model',
						source: 'book',
						rates: { idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }, peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 } },
						defaults: { idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }, peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 } }
					}
				]
			}
		],
		fallback: {
			source: 'flat',
			rules: { peakWindows: ['09:00-12:00'], weekends: 'idle', utcOffsetMinutes: 480, holidays: [], workdays: [], source: 'flat' },
			book: { idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }, peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 } },
			defaults: {
				rules: { peakWindows: ['09:00-12:00'], weekends: 'idle', utcOffsetMinutes: 480, holidays: [], workdays: [] },
				book: { idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }, peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 } }
			}
		},
		stale: { providers: [], models: [] },
		warnings: []
	}, overrides)
}

/** A fetch stub that serves GET /state and records POST /save. */
function fakeFetch(payload, { failState = false } = {}) {
	const calls = []
	const impl = async (url, init = {}) => {
		calls.push({ url, init })
		if (init.method === 'POST') {
			const body = JSON.parse(init.body)
			return { ok: true, status: 200, json: async () => ({ ok: true, state: Object.assign({}, payload, { config: body.config }) }) }
		}
		if (failState) throw new Error('connect ECONNREFUSED')
		return { ok: true, status: 200, json: async () => payload }
	}
	return { impl, calls }
}

function settingsComponent(plugin) {
	const entry = plugin.registered.find((item) => item.options.id === 'session-tariff-price-book')
	assert.ok(entry, 'settings.plugins.tab contribution is registered')
	return entry
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('registers a settings tab next to the composer pill', () => {
	const plugin = loadPlugin({ fetch: fakeFetch(descriptor()).impl })
	const ids = plugin.registered.map((item) => item.options.id)
	assert.ok(ids.includes('cost'), 'composer dock pill still registered')
	const entry = settingsComponent(plugin)
	assert.equal(entry.options.order, 30)
	assert.equal(typeof entry.options.label, 'function')
	assert.equal(entry.options.label(), '会话花费')
	plugin.setLocale('en')
	// Labels are thunks re-read on every projection, so a locale switch follows.
	assert.equal(entry.options.label(), 'Session cost')
})

test('the editor is also reachable from the Plugins page: bundle cell and row cell', async () => {
	const fetchStub = fakeFetch(descriptor())
	const plugin = loadPlugin({ fetch: fetchStub.impl })
	const byName = (name) => plugin.registered.filter((item) => item.options.name === name)
	const bundle = byName('plugins.bundle.config')
	assert.equal(bundle.length, 1, 'bundle page cell is registered')
	assert.equal(bundle[0].options.key, 'dsh-session-tariff')
	const row = byName('plugins.row.config')
	assert.equal(row.length, 1, 'row configure cell is registered')
	assert.equal(row[0].options.key, 'dsh-session-tariff#session-tariff')

	// The Plugins page first asks a row for its one-liner; it must not mount the
	// form, and therefore must not read the Host API.
	const summary = mount(plugin.React, () => bundle[0].component({ view: 'summary' }))
	summary.render()
	await summary.flush()
	const summaryText = textOf(summary.tree)
	assert.match(summaryText, /随 DSH 的模型目录自动同步/)
	assert.equal(byClass(summary.tree, 'scost-settings').length, 0, 'no form in summary view')
	assert.equal(byClass(summary.tree, 'scost-brief').length, 1)
	assert.equal(fetchStub.calls.length, 0, 'summary view does not fetch')
	summary.unmount()

	// The page view renders the editor without its own title block, because the
	// Plugins page already heads the entry with the plugin's display title.
	const page = mount(plugin.React, () => row[0].component({ view: 'page' }))
	page.render()
	await page.flush()
	assert.equal(byClass(page.tree, 'scost-settingsHead').length, 0, 'no duplicated page header')
	assert.match(textOf(page.tree), /brand-new-model/)
	assert.equal(fetchStub.calls.length, 1, 'page view reads the Host state once')
	page.unmount()
})

test('renders one row per live model, with the inherited rate as placeholder', async () => {
	const plugin = loadPlugin({ fetch: fakeFetch(descriptor()).impl })
	const entry = settingsComponent(plugin)
	const mounted = mount(plugin.React, entry.component)
	mounted.render()
	await mounted.flush()
	const tree = mounted.tree
	const text = textOf(tree)
	assert.match(text, /bailian/)
	assert.match(text, /deepseek-v4\.1-flash-1017/)
	assert.match(text, /brand-new-model/)
	assert.match(text, /会话花费价目/)
	const fresh = findByLabel(tree, 'bailian:brand-new-model 空闲 命中')
	assert.ok(fresh, 'the brand-new model has an idle cache-hit cell')
	assert.equal(fresh.props.type, 'number')
	assert.equal(fresh.props.defaultValue, '')
	assert.equal(fresh.props.placeholder, '0.1')
	assert.equal(fresh.props['data-override'], 'false')
	assert.equal(byClass(tree, 'scost-primary')[0].props.disabled, true)
	mounted.unmount()
})

test('an edit becomes an override and POST /save carries exactly that override', async () => {
	const payload = descriptor()
	const fetchStub = fakeFetch(payload)
	const plugin = loadPlugin({ fetch: fetchStub.impl })
	const entry = settingsComponent(plugin)
	const mounted = mount(plugin.React, entry.component)
	mounted.render()
	await mounted.flush()

	const cell = findByLabel(mounted.tree, 'bailian:brand-new-model 空闲 命中')
	cell.props.onChange({ target: { value: '1.5' } })
	await mounted.flush()
	assert.equal(byClass(mounted.tree, 'scost-primary')[0].props.disabled, false)
	assert.match(textOf(mounted.tree), /有未保存的修改/)

	byClass(mounted.tree, 'scost-primary')[0].props.onClick()
	await mounted.flush()

	const post = fetchStub.calls.find((call) => call.init && call.init.method === 'POST')
	assert.ok(post, 'save posted')
	assert.equal(post.url, '/dsh-session-tariff/api/save')
	assert.equal(post.init.headers['content-type'], 'application/json')
	const body = JSON.parse(post.init.body)
	assert.deepEqual(body.config, { providers: { bailian: { pricing: { models: { 'brand-new-model': { idle: { cacheHit: 1.5 } } } } } } })
	assert.match(textOf(mounted.tree), /已保存/)
	mounted.unmount()
})

test('clearing an input removes the override instead of writing zero', async () => {
	const payload = descriptor({
		config: { providers: { bailian: { pricing: { models: { 'brand-new-model': { idle: { cacheHit: 1.5 } } } } } } }
	})
	const fetchStub = fakeFetch(payload)
	const plugin = loadPlugin({ fetch: fetchStub.impl })
	const entry = settingsComponent(plugin)
	const mounted = mount(plugin.React, entry.component)
	mounted.render()
	await mounted.flush()

	const cell = findByLabel(mounted.tree, 'bailian:brand-new-model 空闲 命中')
	assert.equal(cell.props.defaultValue, '1.5')
	assert.equal(cell.props['data-override'], 'true')
	cell.props.onChange({ target: { value: '' } })
	await mounted.flush()
	byClass(mounted.tree, 'scost-primary')[0].props.onClick()
	await mounted.flush()
	const post = fetchStub.calls.find((call) => call.init && call.init.method === 'POST')
	assert.deepEqual(JSON.parse(post.init.body).config, {})
	mounted.unmount()
})

test('a stale provider and model are listed and can be removed in one click', async () => {
	const payload = descriptor({
		config: {
			providers: {
				bailian: { pricing: { models: { 'gone-model': { idle: { cacheHit: 9 } } } } },
				'old-provider': { pricing: { idle: { cacheHit: 3 } } }
			}
		},
		stale: { providers: ['old-provider'], models: [{ provider: 'bailian', model: 'gone-model' }] }
	})
	const fetchStub = fakeFetch(payload)
	const plugin = loadPlugin({ fetch: fetchStub.impl })
	const entry = settingsComponent(plugin)
	const mounted = mount(plugin.React, entry.component)
	mounted.render()
	await mounted.flush()
	assert.match(textOf(mounted.tree), /已失效的配置/)

	for (const pattern of [/供应商 old-provider/, /bailian \/ gone-model/]) {
		const button = byClass(mounted.tree, 'scost-mini').find((item) => pattern.test(textOf(item)))
		assert.ok(button, 'stale entry button ' + pattern)
		button.props.onClick()
		// Each click is a separate browser event in the real page, so let the
		// component re-render before the next one reads the draft.
		await mounted.flush()
	}
	await mounted.flush()
	byClass(mounted.tree, 'scost-primary')[0].props.onClick()
	await mounted.flush()
	const post = fetchStub.calls.find((call) => call.init && call.init.method === 'POST')
	assert.deepEqual(JSON.parse(post.init.body).config, {})
	mounted.unmount()
})

test('a host without the API explains itself instead of rendering nothing', async () => {
	const plugin = loadPlugin({ fetch: fakeFetch(descriptor(), { failState: true }).impl })
	const entry = settingsComponent(plugin)
	const mounted = mount(plugin.React, entry.component)
	mounted.render()
	await mounted.flush()
	assert.match(textOf(mounted.tree), /读不到价目接口/)
	assert.equal(byClass(mounted.tree, 'scost-primary').length, 0)
	mounted.unmount()
})

test('a read-only deployment disables saving', async () => {
	const plugin = loadPlugin({ fetch: fakeFetch(descriptor({ writable: false })).impl })
	const entry = settingsComponent(plugin)
	const mounted = mount(plugin.React, entry.component)
	mounted.render()
	await mounted.flush()
	assert.match(textOf(mounted.tree), /只能查看/)
	assert.equal(byClass(mounted.tree, 'scost-primary')[0].props.disabled, true)
	mounted.unmount()
})

test('both locale dictionaries cover every settings key the page asks for', () => {
	const plugin = loadPlugin({ fetch: fakeFetch(descriptor()).impl })
	// Keys the source writes literally. `settings.source.` is a dynamic prefix
	// (preset/config/book) that itself ends with a dot and is filtered out.
	const keys = [...new Set(
		[...SOURCE.matchAll(/'settings\.[a-zA-Z0-9.]+'/g)]
			.map((match) => match[0].slice(1, -1))
			.filter((key) => !key.endsWith('.'))
			// A Slot name, not a locale key.
			.filter((key) => key !== 'settings.plugins.tab')
	)]
	// Keys reached only through a prefix at runtime.
	const dynamic = ['settings.source.preset', 'settings.source.config', 'settings.source.book']
	assert.ok(keys.length > 30)
	const missingZh = keys.concat(dynamic).filter((key) => plugin.dictionaries.zh[key] === undefined)
	const missingEn = keys.concat(dynamic).filter((key) => plugin.dictionaries.en[key] === undefined)
	assert.deepEqual(missingZh, [], 'every settings key has a Chinese string')
	assert.deepEqual(missingEn, [], 'every settings key has an English string')
})