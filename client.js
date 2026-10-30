window.__ModuleLoader__.load({
	id: 'dsh-session-tariff',
	factory(require) {
		const React = require('react')
		const ReactDOM = require('react-dom')
		const h = React.createElement

		const NS = 'session-cost'
		const STAT_ID = 'cost'
		const PREFIX = 'scost'
		const MILLION = 1e6

		/**
		 * Unit prices in CNY per one million tokens, split by tariff period.
		 * Checked against the official DeepSeek list (2026-10): deepseek-flash
		 * idle 0.02 / 1 / 4, peak 0.04 / 2 / 8 — peak is exactly twice idle.
		 * DeepSeek has no separate cache-write price (writes land in the uncached
		 * bucket), so `cacheWrite` defaults to the miss rate, which is also what
		 * providers that report writes separately charge. This is the last-resort
		 * book only: the Host publishes a book per provider (`projected.books`),
		 * and the legacy flat `projected.pricing` is the fallback book for old
		 * Hosts and for providers with no preset of their own.
		 */
		const DEFAULT_PRICING = {
			currency: '¥',
			// Kept structurally complete: a book always exposes a `models` map,
			// even when there is no per-model rate to publish.
			models: {},
			idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
			peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
		}

		/** The built-in book: what rates fall back to when nothing was published. */
		const DEFAULT_BOOK = {
			currency: DEFAULT_PRICING.currency,
			defaultModel: undefined,
			peakWindows: [],
			weekends: 'idle',
			idle: DEFAULT_PRICING.idle,
			peak: DEFAULT_PRICING.peak,
			models: {}
		}

		/** Per-bucket detail rows, in billing order. */
		const ROW_SPECS = [
			{ key: 'cacheRead', field: 'cacheReadTokens', rate: 'cacheHit' },
			{ key: 'cacheMiss', field: 'uncachedInputTokens', rate: 'cacheMiss' },
			{ key: 'cacheWrite', field: 'cacheWriteTokens', rate: 'cacheWrite' },
			{ key: 'output', field: 'outputTokens', rate: 'output' }
		]

		const ZH = {
			aria: '本会话估算花费 {cost}',
			'dialog.title': '本会话花费',
			'period.idle': '空闲时段',
			'period.peak': '高峰时段',
			'period.unknown': '未区分时段',
			'period.requests': '{count} 次请求',
			'row.cacheRead': '缓存读取',
			'row.cacheMiss': '未缓存输入',
			'row.cacheWrite': '缓存写入',
			'row.output': '输出',
			'note.idlePrice': '空闲：命中 {currency}{cacheHit} · 未命中 {currency}{cacheMiss} · 输出 {currency}{output} / 百万 tokens',
			'note.peakPrice': '高峰：命中 {currency}{cacheHit} · 未命中 {currency}{cacheMiss} · 输出 {currency}{output} / 百万 tokens',
			'note.rule': '高峰时段 {windows}（{dayRule}）；其余时间按空闲计',
			'note.dayRule.idle': '周末与法定节假日全天按空闲计',
			'note.dayRule.clock': '周末照常按时段计，周末无优惠',
			'note.fallback': '尚未取得分时段用量，暂按高峰价估算',
			'note.provider': '{provider}：'
		}

		const EN = {
			aria: 'Estimated cost of this session {cost}',
			'dialog.title': 'Session cost',
			'period.idle': 'Idle hours',
			'period.peak': 'Peak hours',
			'period.unknown': 'Period unknown',
			'period.requests': '{count} requests',
			'row.cacheRead': 'Cached input',
			'row.cacheMiss': 'Uncached input',
			'row.cacheWrite': 'Cache write',
			'row.output': 'Output',
			'note.idlePrice': 'Idle: hit {currency}{cacheHit} · miss {currency}{cacheMiss} · output {currency}{output} per 1M tokens',
			'note.peakPrice': 'Peak: hit {currency}{cacheHit} · miss {currency}{cacheMiss} · output {currency}{output} per 1M tokens',
			'note.rule': 'Peak hours {windows} ({dayRule}); every other time bills as idle',
			'note.dayRule.idle': 'weekends and public holidays bill idle all day',
			'note.dayRule.clock': 'weekends follow the same clock with no discount',
			'note.fallback': 'Per-period usage is not available yet; estimated at peak rates',
			'note.provider': '{provider}: '
		}

		const MEASURE_STYLE = { left: 0, top: 0, visibility: 'hidden' }

		const CSS = [
			'.scost-anchor{min-width:0;font-size:12px;line-height:20px;display:inline-flex}',
			'.scost-pill{box-sizing:border-box;border-radius:6px;max-width:100%;color:var(--dsw-alias-label-secondary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
			'.scost-pill svg{flex:none;width:14px;height:14px}',
			'.scost-pill:hover,.scost-pill[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
			'.scost-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
			'.scost-label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
			'.scost-panel{box-sizing:border-box;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);min-width:min(300px,100vw - 24px);max-width:min(420px,100vw - 24px);color:var(--dsw-alias-label-secondary);cursor:default;padding:14px 16px;font-size:12px;line-height:18px;position:fixed;z-index:1100}',
			'.scost-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
			'.scost-titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
			'.scost-titleLabel svg{flex:none;width:14px;height:14px}',
			'.scost-titleValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
			'.scost-rule{border-top:1px solid var(--dsw-alias-border-l1);margin-bottom:10px}',
			'.scost-period{padding:0 0 8px}',
			'.scost-period+.scost-period{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}',
			'.scost-periodHead{justify-content:space-between;gap:16px;color:var(--dsw-alias-label-primary);display:flex}',
			'.scost-periodName{align-items:center;gap:8px;min-width:0;display:inline-flex}',
			'.scost-periodRequests{color:var(--dsw-alias-label-secondary);font-weight:400}',
			'.scost-model{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.scost-providerTag{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 4px;font-size:10px;line-height:14px;white-space:nowrap}',
			'.scost-periodTag{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px;font-size:10px;line-height:14px}',
			'.scost-periodValue{font-variant-numeric:tabular-nums;white-space:nowrap}',
			'.scost-lines{color:var(--dsw-alias-label-secondary);grid-template-columns:auto minmax(0,1fr) auto;gap:2px 12px;margin-top:4px;display:grid;font-variant-numeric:tabular-nums}',
			'.scost-lineLabel{min-width:0}',
			'.scost-lineTokens{text-align:right;white-space:nowrap}',
			'.scost-lineValue{color:var(--dsw-alias-label-primary);text-align:right;white-space:nowrap;min-width:56px}',
			'.scost-note{color:var(--dsw-alias-label-secondary);opacity:.75;margin-top:10px;font-size:11px;line-height:16px}',
			'.scost-noteLine+.scost-noteLine{margin-top:2px}'
		].join('\n')

		/**
		 * The flat book resolved from the loader row's `config`, if any. The DSH
		 * client module loader creates plugin entries with `{ name }` only, so
		 * `apply(ctx, config)` normally receives no `config` here; the Host
		 * publishes the real books on the projection (`projected.books`), and
		 * this stays only as the legacy fallback book / built-in default.
		 */
		let configured = resolvePricing(undefined)
		let fallbackT = (key, params) => interpolate(ZH[key] === undefined ? key : ZH[key], params)

		function interpolate(text, params) {
			if (params === undefined || params === null) return text
			return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
		}

		function rate(value, fallback) {
			const number = Number(value)
			return Number.isFinite(number) && number >= 0 ? number : fallback
		}

		function resolveRates(given, fallback) {
			const source = given !== null && typeof given === 'object' ? given : {}
			return {
				cacheHit: rate(source.cacheHit, fallback.cacheHit),
				cacheMiss: rate(source.cacheMiss, fallback.cacheMiss),
				cacheWrite: rate(source.cacheWrite, fallback.cacheWrite),
				output: rate(source.output, fallback.output)
			}
		}

		function resolvePricing(config) {
			const given = config !== null && typeof config === 'object' && config.pricing !== null && typeof config.pricing === 'object' ? config.pricing : {}
			const flat = { cacheHit: given.cacheHit, cacheMiss: given.cacheMiss, cacheWrite: given.cacheWrite, output: given.output }
			const base = { cacheHit: DEFAULT_PRICING.idle.cacheHit, cacheMiss: DEFAULT_PRICING.idle.cacheMiss, cacheWrite: DEFAULT_PRICING.idle.cacheWrite, output: DEFAULT_PRICING.idle.output }
			const idle = resolveRates(given.idle === undefined ? flat : given.idle, resolveRates(flat, base))
			const peak = resolveRates(given.peak === undefined ? flat : given.peak, resolveRates(flat, DEFAULT_PRICING.peak))
			const models = {}
			const table = given.models !== null && typeof given.models === 'object' && !Array.isArray(given.models) ? given.models : {}
			for (const key of Object.keys(table)) {
				const entry = table[key]
				if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
				const rowFlat = {
					cacheHit: entry.cacheHit,
					cacheMiss: entry.cacheMiss,
					cacheWrite: entry.cacheWrite,
					output: entry.output
				}
				models[key] = { idle: resolveRates(entry.idle === undefined ? rowFlat : entry.idle, resolveRates(rowFlat, idle)) }
				models[key].peak = entry.peak === undefined
					? resolveRates(rowFlat, peak)
					: resolveRates(entry.peak, resolveRates(rowFlat, peak))
			}
			return {
				currency: typeof given.currency === 'string' && given.currency.length > 0 ? given.currency : DEFAULT_PRICING.currency,
				idle,
				peak,
				models,
				// Label for runs whose model is unknown (older logs, or a Host that has
				// not published per-model rows yet).
				defaultModel: typeof given.defaultModel === 'string' && given.defaultModel.length > 0 ? given.defaultModel : undefined
			}
		}

		/**
		 * Fill one price book (either a Host-published provider book or the legacy
		 * flat `projected.pricing`) over `base`. A provider book is authoritative,
		 * so a missing rate falls back to that book's own period rate and finally
		 * to the built-in DeepSeek book — never to another provider's flat config.
		 * @param source - candidate book from the wire view.
		 * @param base - book to inherit missing currency/rules/rates from.
		 */
		function normalizeBook(source, base) {
			const given = source !== null && typeof source === 'object' ? source : {}
			const idle = resolveRates(given.idle, base.idle)
			const peak = resolveRates(given.peak, base.peak)
			const models = {}
			const table = given.models !== null && typeof given.models === 'object' && !Array.isArray(given.models) ? given.models : {}
			for (const key of Object.keys(table)) {
				const entry = table[key]
				if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
				models[key] = {
					idle: resolveRates(entry.idle, idle),
					peak: resolveRates(entry.peak, peak)
				}
			}
			const windows = Array.isArray(given.peakWindows)
				? given.peakWindows.filter((entry) => typeof entry === 'string')
				: base.peakWindows
			return {
				currency: typeof given.currency === 'string' && given.currency.length > 0 ? given.currency : base.currency,
				defaultModel: typeof given.defaultModel === 'string' && given.defaultModel.length > 0 ? given.defaultModel : base.defaultModel,
				peakWindows: windows,
				weekends: given.weekends === 'clock' || given.weekends === 'idle' ? given.weekends : base.weekends,
				idle,
				peak,
				models
			}
		}

		function bookFromPricing(pricing) {
			return {
				currency: pricing.currency,
				defaultModel: pricing.defaultModel,
				peakWindows: [],
				weekends: 'idle',
				idle: pricing.idle,
				peak: pricing.peak,
				models: pricing.models
			}
		}

		/**
		 * Adopt the Host-published books from `projected.books` (array of provider
		 * books) and the legacy flat `projected.pricing` as the fallback book. When
		 * `books` is absent/empty (old Host), the fallback book is the only book, so
		 * the previous single-book rendering is reproduced exactly.
		 * @param projected - the `sessionCost` projection value, possibly undefined.
		 * @returns `{ fallback, books }`, books keyed by provider id.
		 */
		function adoptProjection(projected) {
			const view = projected !== null && typeof projected === 'object' ? projected : undefined
			const published = view === undefined || view.pricing === null || typeof view.pricing !== 'object' ? undefined : view.pricing
			const fallback = normalizeBook({
				currency: published === undefined ? undefined : published.currency,
				defaultModel: published === undefined ? undefined : published.defaultModel,
				idle: published === undefined ? undefined : published.idle,
				peak: published === undefined ? undefined : published.peak,
				models: published === undefined ? undefined : published.models,
				// The legacy wire fields describe the fallback book's rules.
				peakWindows: view === undefined ? undefined : view.peakWindows,
				weekends: view === undefined ? undefined : view.weekends
			}, bookFromPricing(configured))
			const books = new Map()
			const list = view !== undefined && Array.isArray(view.books) ? view.books : []
			for (const entry of list) {
				const provider = entry !== null && typeof entry === 'object' && typeof entry.provider === 'string' && entry.provider.length > 0
					? entry.provider
					: undefined
				if (provider === undefined) continue
				books.set(provider, normalizeBook(entry, DEFAULT_BOOK))
			}
			return { fallback, books }
		}

		/**
		 * Rates for one (provider, model, period): the model's own entry, else the
		 * provider book's period rates, else the built-in DeepSeek book.
		 */
		function ratesFor(book, model, periodKey) {
			const entry = model === undefined ? undefined : book.models[model]
			const rates = entry === undefined ? undefined : entry[periodKey]
			return rates === undefined
				? (book[periodKey] === undefined ? DEFAULT_PRICING[periodKey] : book[periodKey])
				: rates
		}

		/** Compact token count: 18.2M, 133.0K, 912. */
		function formatTokens(value) {
			if (value >= 1e9) return (value / 1e9).toFixed(1) + 'B'
			if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M'
			if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K'
			return String(Math.round(value))
		}

		/** Exact token count with thousands separators, for the row's tooltip. */
		function exactTokens(value) {
			return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
		}

		function money(amount, currency) {
			if (!(amount > 0)) return currency + '0'
			if (amount < 0.001) return currency + '<0.001'
			return currency + amount.toFixed(amount < 1 ? 3 : 2)
		}

		/** Price one period row against that period's rates. */
		function amountOf(row, rates) {
			return (row.cacheReadTokens * rates.cacheHit
				+ row.uncachedInputTokens * rates.cacheMiss
				+ row.cacheWriteTokens * rates.cacheWrite
				+ row.outputTokens * rates.output) / MILLION
		}

		function hasTokens(row) {
			if (row === null || typeof row !== 'object') return false
			return row.cacheReadTokens + row.uncachedInputTokens + row.cacheWriteTokens + row.outputTokens > 0
		}

		function CostIcon() {
			return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
				h('circle', { cx: 8, cy: 8, r: 6.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
				h('path', {
					d: 'M5.4 4.9 8 8.2l2.6-3.3M8 8.2v3.5M6.3 9.3h3.4M6.3 10.7h3.4',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.3,
					strokeLinecap: 'round',
					strokeLinejoin: 'round'
				}))
		}

		/**
		 * One trigger-anchored dialog seat: open state, viewport-clamped placement,
		 * Escape and outside-pointerdown close. Mirrors the host status pills.
		 */
		function useDialogSeat() {
			const [open, setOpen] = React.useState(false)
			const [pos, setPos] = React.useState(null)
			const rootRef = React.useRef(null)
			const panelRef = React.useRef(null)

			React.useLayoutEffect(() => {
				if (!open) {
					setPos(null)
					return
				}
				const anchor = rootRef.current
				const panel = panelRef.current
				if (anchor === null || panel === null) return
				const rect = anchor.getBoundingClientRect()
				const width = panel.offsetWidth
				const height = panel.offsetHeight
				const margin = 12
				const gap = 8
				const left = Math.min(
					Math.max(margin, rect.left + rect.width / 2 - width / 2),
					Math.max(margin, window.innerWidth - width - margin)
				)
				let top = rect.top - gap - height
				if (top < margin) top = Math.min(Math.max(margin, window.innerHeight - height - margin), rect.bottom + gap)
				setPos({ left, top })
			}, [open])

			React.useEffect(() => {
				if (!open) return undefined
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false)
				}
				const onPointerDown = (event) => {
					const target = event.target
					if (!(target instanceof Node)) return
					if (rootRef.current !== null && rootRef.current.contains(target)) return
					if (panelRef.current !== null && panelRef.current.contains(target)) return
					setOpen(false)
				}
				document.addEventListener('keydown', onKeyDown)
				document.addEventListener('pointerdown', onPointerDown, true)
				return () => {
					document.removeEventListener('keydown', onKeyDown)
					document.removeEventListener('pointerdown', onPointerDown, true)
				}
			}, [open])

			return { open, setOpen, pos, rootRef, panelRef }
		}

		/**
		 * Whole-log cost pill: estimated spend split by tariff period, opening a
		 * per-(provider, model, period) breakdown. Reads the host `sessionCost`
		 * projection (provider-aware books plus per-provider usage rows); when a
		 * running Host has not registered it yet, falls back to the aggregate
		 * `tokenUsage` buckets priced at the fallback book's peak rates.
		 */
		function CostPill({ useProjection, t }) {
			const translate = typeof t === 'function' ? t : fallbackT
			const projected = useProjection('sessionCost')
			const aggregate = useProjection('tokenUsage')
			const seat = useDialogSeat()

			// The Host owns the configured price books; adopt them before pricing so
			// a provider never bills at another provider's rates.
			const adopted = adoptProjection(projected)
			const books = adopted.books
			const fallbackBook = adopted.fallback
			const bookFor = (provider) => (provider !== undefined && books.has(provider) ? books.get(provider) : fallbackBook)

			// Groups are (provider, model, period) triples so each row is priced at
			// the rates of the provider and model that served it. A provider with no
			// published book (old logs: provider undefined) uses the fallback book.
			const groups = []
			let fallbackNote = false
			const push = (provider, model, key, row) => {
				if (!hasTokens(row)) return
				const book = bookFor(provider)
				groups.push({
					provider,
					model,
					key,
					row,
					book,
					rates: ratesFor(book, model, key),
					label: translate('period.' + key)
				})
			}
			const perModel = projected !== undefined && projected !== null && Array.isArray(projected.models)
				? projected.models
				: []
			if (projected !== undefined && projected !== null && perModel.length > 0) {
				for (const entry of perModel) {
					const provider = typeof entry.provider === 'string' && entry.provider.length > 0 ? entry.provider : undefined
					const model = typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : undefined
					push(provider, model, 'idle', entry.idle)
					push(provider, model, 'peak', entry.peak)
				}
			} else if (projected !== undefined && projected !== null) {
				push(undefined, fallbackBook.defaultModel, 'idle', projected.idle)
				push(undefined, fallbackBook.defaultModel, 'peak', projected.peak)
			} else if (aggregate !== undefined && aggregate !== null && hasTokens(aggregate)) {
				push(undefined, fallbackBook.defaultModel, 'peak', aggregate)
				fallbackNote = true
			}
			if (groups.length === 0) return null

			let total = 0
			for (const group of groups) {
				group.amount = amountOf(group.row, group.rates)
				total += group.amount
			}
			if (!(total > 0)) return null

			// Provider order follows the wire order (the Host sorts provider ids, with
			// an undefined provider last). Only a multi-provider bill gets tags and
			// provider-prefixed note lines; a single-provider bill stays untouched.
			const providers = []
			const seenProviders = new Set()
			for (const group of groups) {
				const key = group.provider === undefined ? '\u0000' : group.provider
				if (seenProviders.has(key)) continue
				seenProviders.add(key)
				providers.push(group.provider)
			}
			const multiProvider = providers.length > 1
			const currency = fallbackBook.currency
			const totalText = money(total, currency)
			const label = '≈' + totalText

			const priceLine = (labelKey, rates, bookCurrency) => translate(labelKey, {
				currency: bookCurrency,
				cacheHit: String(rates.cacheHit),
				cacheMiss: String(rates.cacheMiss),
				output: String(rates.output)
			})

			// One note block per provider present in the bill, each from that
			// provider's own book: its rates, peak windows and weekend policy. The
			// legacy aggregate path keeps the old "estimated at peak rates" block.
			const notes = []
			for (const provider of providers) {
				const book = bookFor(provider)
				const lines = [
					priceLine('note.idlePrice', book.idle, book.currency),
					priceLine('note.peakPrice', book.peak, book.currency)
				]
				if (fallbackNote) {
					lines.push(translate('note.fallback'))
				} else {
					const windows = book.peakWindows.join(' / ')
					if (windows !== '') {
						lines.push(translate('note.rule', { windows, dayRule: translate('note.dayRule.' + book.weekends) }))
					}
				}
				// Rows from older Hosts carry no provider; they have no id to tag.
				const prefix = multiProvider && provider !== undefined
					? translate('note.provider', { provider })
					: ''
				for (const line of lines) notes.push(prefix + line)
			}

			const panel = h('div', {
				ref: seat.panelRef,
				role: 'dialog',
				'aria-label': translate('dialog.title'),
				className: PREFIX + '-panel',
				style: seat.pos === null ? MEASURE_STYLE : { left: seat.pos.left + 'px', top: seat.pos.top + 'px' }
			},
				h('div', { className: PREFIX + '-title' },
					h('span', { className: PREFIX + '-titleLabel' }, h(CostIcon), translate('dialog.title')),
					h('span', { className: PREFIX + '-titleValue' }, totalText)),
				h('div', { className: PREFIX + '-rule', 'aria-hidden': true }),
				groups.map((group) => h('div', {
					key: (group.provider === undefined ? '' : group.provider) + '\u0000' + (group.model === undefined ? '' : group.model) + '\u0000' + group.key,
					className: PREFIX + '-period'
				},
					h('div', { className: PREFIX + '-periodHead' },
						h('span', { className: PREFIX + '-periodName' },
							group.model === undefined ? group.label : h('span', { className: PREFIX + '-model', title: group.model }, group.model),
							group.model === undefined
								? null
								: multiProvider && group.provider !== undefined
									? h('span', { className: PREFIX + '-providerTag' }, group.provider)
									: null,
							group.model === undefined ? null : h('span', { className: PREFIX + '-periodTag' }, group.label),
							group.row.requests > 0
								? h('span', { className: PREFIX + '-periodRequests' }, translate('period.requests', { count: group.row.requests }))
								: null),
						h('span', { className: PREFIX + '-periodValue' }, money(group.amount, currency))),
					h('div', { className: PREFIX + '-lines' }, ROW_SPECS.flatMap((spec) => {
						const tokens = group.row[spec.field]
						if (!(tokens > 0)) return []
						return [
							h('div', { key: spec.key + '-label', className: PREFIX + '-lineLabel' }, translate('row.' + spec.key)),
							h('div', {
								key: spec.key + '-tokens',
								className: PREFIX + '-lineTokens',
								title: exactTokens(tokens)
							}, formatTokens(tokens)),
							h('div', {
								key: spec.key + '-value',
								className: PREFIX + '-lineValue'
							}, money(tokens * group.rates[spec.rate] / MILLION, currency))
						]
					})))),
				h('div', { className: PREFIX + '-note' }, notes.map((line, index) => h('div', {
					key: 'note-' + index,
					className: PREFIX + '-noteLine'
				}, line))))

			return h('span', {
				ref: seat.rootRef,
				className: PREFIX + '-anchor',
				'data-composer-stat': STAT_ID
			},
				h('button', {
					type: 'button',
					className: PREFIX + '-pill',
					'aria-haspopup': 'dialog',
					'aria-expanded': seat.open,
					'aria-label': translate('aria', { cost: totalText }),
					onClick: () => seat.setOpen(!seat.open)
				},
					h(CostIcon),
					h('span', { className: PREFIX + '-label' }, label)),
				seat.open ? ReactDOM.createPortal(panel, document.body) : null)
		}

		function insertStyles() {
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-session-tariff'
			tag.dataset.pluginCss = 'dsh-session-tariff/dock-cost.css'
			tag.textContent = CSS
			document.head.appendChild(tag)
			return () => {
				tag.remove()
			}
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx, config) {
				configured = resolvePricing(config)
				ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'session-cost: dictionaries')
				fallbackT = ctx.locale.bind(NS)
				ctx.effect(insertStyles, 'session-cost: styles')
				ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock',
					id: STAT_ID,
					order: 2,
					locale: NS
				}, CostPill))
			}
		}
	}
})
