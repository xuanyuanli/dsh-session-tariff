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
			'note.provider': '{provider}：',
			'settings.tab': '会话花费',
			'settings.title': '会话花费价目',
			'settings.desc': '按 DSH 当前注册的模型与供应商配置单价（¥ / 百万 tokens）。保存后立即生效，无需重启。未单独配置的模型沿用所在供应商的默认档。',
			'settings.loading': '正在读取价目…',
			'settings.hostMissing': '读不到价目接口：宿主半尚未加载。升级或修改过宿主代码后，重启 DSH 再打开本页。',
			'settings.empty': '还没有注册任何模型供应商，先在「设置 → 模型」里加一个。',
			'settings.period.idle': '空闲',
			'settings.period.peak': '高峰',
			'settings.field.cacheHit': '命中',
			'settings.field.cacheMiss': '未命中',
			'settings.field.cacheWrite': '写入',
			'settings.field.output': '输出',
			'settings.model': '模型',
			'settings.rules': '时段规则',
			'settings.peakWindows': '高峰时段',
			'settings.peakWindowsHint': 'HH:MM-HH:MM，逗号分隔',
			'settings.weekends': '周末',
			'settings.weekends.idle': '全天空闲',
			'settings.weekends.clock': '照常计时',
			'settings.utcOffset': '时区（分钟）',
			'settings.holidays': '节假日',
			'settings.workdays': '调休工作日',
			'settings.datesHint': 'YYYY-MM-DD，逗号分隔',
			'settings.defaultRow': '供应商默认档',
			'settings.defaultRowHint': '模型自身没有配置时按这档计',
			'settings.resetModel': '恢复默认',
			'settings.resetProvider': '清除本供应商全部覆盖',
			'settings.source.preset': '内置预设',
			'settings.source.config': '已自定义',
			'settings.source.book': '兜底档',
			'settings.fallback': '兜底价目（无预设的供应商）',
			'settings.stale': '已失效的配置',
			'settings.staleHint': 'DSH 已不再注册这些供应商或模型，保存前可一键清掉。',
			'settings.staleProvider': '供应商 {name}',
			'settings.staleModel': '{provider} / {model}',
			'settings.clean': '清理',
			'settings.save': '保存',
			'settings.saving': '保存中…',
			'settings.reload': '重新读取',
			'settings.refresh': '刷新模型列表',
			'settings.dirty': '有未保存的修改',
			'settings.clean2': '已保存，胶囊已按新价重算',
			'settings.failed': '保存失败：{error}',
			'settings.readFailed': '读取失败：{error}',
			'settings.readonly': '当前部署没有可写的 profile 行，只能查看。',
			'settings.currency': '币种',
			'settings.warnings': '提示：',
			'settings.inherited': '留空表示沿用上层默认'
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
			'note.provider': '{provider}: ',
			'settings.tab': 'Session cost',
			'settings.title': 'Session cost price book',
			'settings.desc': 'Prices per 1M tokens (¥), one row per model DSH currently registers. Saving applies immediately — no restart. A model without its own row bills at its provider default.',
			'settings.loading': 'Reading the price book…',
			'settings.hostMissing': 'The price API is unavailable: the Host half is not loaded yet. After changing Host code, restart DSH and reopen this page.',
			'settings.empty': 'No model provider is registered yet. Add one in Settings → Models first.',
			'settings.period.idle': 'Idle',
			'settings.period.peak': 'Peak',
			'settings.field.cacheHit': 'Hit',
			'settings.field.cacheMiss': 'Miss',
			'settings.field.cacheWrite': 'Write',
			'settings.field.output': 'Output',
			'settings.model': 'Model',
			'settings.rules': 'Tariff rules',
			'settings.peakWindows': 'Peak windows',
			'settings.peakWindowsHint': 'HH:MM-HH:MM, comma separated',
			'settings.weekends': 'Weekends',
			'settings.weekends.idle': 'Idle all day',
			'settings.weekends.clock': 'Follow the clock',
			'settings.utcOffset': 'UTC offset (minutes)',
			'settings.holidays': 'Holidays',
			'settings.workdays': 'Make-up workdays',
			'settings.datesHint': 'YYYY-MM-DD, comma separated',
			'settings.defaultRow': 'Provider default row',
			'settings.defaultRowHint': 'Used by models without their own row',
			'settings.resetModel': 'Reset',
			'settings.resetProvider': 'Clear every override for this provider',
			'settings.source.preset': 'built-in preset',
			'settings.source.config': 'customized',
			'settings.source.book': 'fallback book',
			'settings.fallback': 'Fallback book (providers without a preset)',
			'settings.stale': 'Stale configuration',
			'settings.staleHint': 'DSH no longer registers these providers or models; remove them before saving.',
			'settings.staleProvider': 'provider {name}',
			'settings.staleModel': '{provider} / {model}',
			'settings.clean': 'Remove',
			'settings.save': 'Save',
			'settings.saving': 'Saving…',
			'settings.reload': 'Reload',
			'settings.refresh': 'Refresh models',
			'settings.dirty': 'Unsaved changes',
			'settings.clean2': 'Saved — the pill is already repriced',
			'settings.failed': 'Save failed: {error}',
			'settings.readFailed': 'Read failed: {error}',
			'settings.readonly': 'This deployment exposes no writable profile row; the page is read-only.',
			'settings.currency': 'Currency',
			'settings.warnings': 'Notes: ',
			'settings.inherited': 'Leave empty to inherit'
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
			'.scost-noteLine+.scost-noteLine{margin-top:2px}',
			// --- Settings → Plugins page ---------------------------------------
			'.scost-settings{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
			'.scost-settingsHead{display:flex;flex-direction:column;gap:4px}',
			'.scost-settingsTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}',
			'.scost-settingsDesc{max-width:760px}',
			'.scost-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
			'.scost-cardHead{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}',
			'.scost-cardName{color:var(--dsw-alias-label-primary);font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis}',
			'.scost-badge{border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 5px;font-size:10px;line-height:16px;white-space:nowrap}',
			'.scost-badge[data-source=config]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
			'.scost-rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px 12px}',
			'.scost-field{display:flex;flex-direction:column;gap:2px;min-width:0}',
			'.scost-fieldLabel{font-size:11px;line-height:14px;opacity:.8}',
			'.scost-input,.scost-select{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:3px 6px;min-width:0}',
			'.scost-input:focus-visible,.scost-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
			'.scost-input[data-override=true]{background:var(--dsw-alias-bg-overlay);border-color:var(--dsw-alias-brand-primary)}',
			'.scost-scroll{overflow-x:auto}',
			'.scost-grid{display:grid;grid-template-columns:minmax(150px,1fr) repeat(8,minmax(58px,84px)) 64px;gap:4px 6px;align-items:center;min-width:700px;font-variant-numeric:tabular-nums}',
			'.scost-gridHead{font-size:11px;line-height:14px;opacity:.75;padding-bottom:2px}',
			'.scost-gridName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
			'.scost-gridName[data-source=preset]::after,.scost-gridName[data-source=book]::after{content:" · 默认";opacity:.5;font-size:10px}',
			'.scost-gridSep{grid-column:2 / span 4;border-top:1px solid var(--dsw-alias-border-l1);margin:6px 0 2px}',
			'.scost-mini{font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid transparent;border-radius:4px;padding:1px 4px;cursor:pointer;white-space:nowrap}',
			'.scost-mini:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}',
			'.scost-mini:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
			'.scost-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;position:sticky;bottom:0;background:var(--dsw-alias-bg-layer-1);padding:10px 0}',
			'.scost-primary{font:inherit;font-size:12px;line-height:18px;border-radius:6px;padding:3px 12px;cursor:pointer;background:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1)}',
			'.scost-primary:disabled{opacity:.4;cursor:default}',
			'.scost-status{font-size:11px;line-height:16px;opacity:.8}',
			'.scost-status[data-kind=error]{color:var(--dsw-alias-state-error-primary);opacity:1}',
			'.scost-hint{font-size:11px;line-height:15px;opacity:.65}'
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

		// ------------------------------------------------------------------
		// Settings → Plugins: the price-book editor
		//
		// The row's config lives on the Host, so this page is a thin client of the
		// JSON API in host.js: it never guesses which providers or models exist and
		// never writes the patch itself. Every model row it renders comes from the
		// live catalog, so adding or removing a model in DSH changes this page on the
		// next read, with the defaults already filled in.
		// ------------------------------------------------------------------

		const API_BASE = '/dsh-session-tariff/api'

		const RATE_FIELDS = [
			{ key: 'cacheHit', label: 'settings.field.cacheHit' },
			{ key: 'cacheMiss', label: 'settings.field.cacheMiss' },
			{ key: 'cacheWrite', label: 'settings.field.cacheWrite' },
			{ key: 'output', label: 'settings.field.output' }
		]

		const RATE_PERIODS = [
			{ key: 'idle', label: 'settings.period.idle' },
			{ key: 'peak', label: 'settings.period.peak' }
		]

		const RATE_COLUMNS = RATE_PERIODS.flatMap((period) =>
			RATE_FIELDS.map((field) => ({
				key: period.key + '.' + field.key,
				period: period.key,
				field: field.key,
				periodLabel: period.label,
				fieldLabel: field.label
			})))

		function isDataObject(value) {
			return value !== null && typeof value === 'object' && !Array.isArray(value)
		}

		/** A detached copy: the draft is edited by replacement, never by mutation. */
		function cloneData(value) {
			return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
		}

		/** Own-property read: never walks the prototype chain. */
		function own(object, key) {
			return isDataObject(object) && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined
		}

		function readAt(root, path) {
			let node = root
			for (const key of path) {
				node = own(node, key)
				if (node === undefined) return undefined
			}
			return node
		}

		function writeAt(root, path, value) {
			let node = root
			for (let index = 0; index < path.length - 1; index += 1) {
				const key = path[index]
				if (!isDataObject(own(node, key))) node[key] = {}
				node = node[key]
			}
			node[path[path.length - 1]] = value
		}

		/** Delete a leaf and every object the deletion left empty, bottom-up. */
		function deleteAt(root, path) {
			const parents = []
			let node = root
			for (let index = 0; index < path.length - 1; index += 1) {
				const key = path[index]
				const child = own(node, key)
				if (!isDataObject(child)) return
				parents.push([node, key])
				node = child
			}
			delete node[path[path.length - 1]]
			for (let index = parents.length - 1; index >= 0; index -= 1) {
				const parent = parents[index][0]
				const key = parents[index][1]
				const child = own(parent, key)
				if (isDataObject(child) && Object.keys(child).length === 0) delete parent[key]
			}
		}

		function requestJson(path, init) {
			return fetch(API_BASE + path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init)).then((response) => {
				if (!response.ok) throw new Error('HTTP ' + response.status)
				return response.json()
			})
		}

		function numberAt(value) {
			return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
		}

		function arraysAt(value) {
			return Array.isArray(value) ? value.join(', ') : ''
		}

		/** The price-book editor rendered inside Settings → Plugins. */
		function TariffSettings() {
			const [state, setState] = React.useState(null)
			const [draft, setDraft] = React.useState({})
			const [version, setVersion] = React.useState(0)
			const [status, setStatus] = React.useState({ kind: 'loading', text: '' })
			const [dirty, setDirty] = React.useState(false)
			const [busy, setBusy] = React.useState(false)

			const t = fallbackT

			const adopt = React.useCallback((next) => {
				setState(next)
				setDraft(isDataObject(next.config) ? cloneData(next.config) : {})
				setVersion((value) => value + 1)
				setDirty(false)
			}, [])

			const load = React.useCallback(() => {
				setStatus({ kind: 'loading', text: fallbackT('settings.loading') })
				setBusy(true)
				requestJson('/state', { headers: { accept: 'application/json' } })
					.then((payload) => {
						if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
							setStatus({ kind: 'error', text: fallbackT('settings.readFailed', { error: (payload && payload.error) || 'unknown' }) })
							return
						}
						adopt(payload)
						setStatus({ kind: 'idle', text: '' })
					})
					.catch((error) => {
						setStatus({ kind: 'error', text: fallbackT('settings.hostMissing') + ' — ' + String(error && error.message ? error.message : error) })
					})
					.then(() => setBusy(false))
			}, [adopt])

			React.useEffect(() => {
				load()
			}, [load])

			const commit = (next) => {
				setDraft(next)
				setDirty(true)
				setStatus({ kind: 'dirty', text: t('settings.dirty') })
			}

			const editRate = (path, field, raw) => {
				const text = String(raw).trim()
				const next = isDataObject(draft) ? cloneData(draft) : {}
				if (text === '') {
					deleteAt(next, path.concat(field))
				} else {
					const number = Number(text)
					if (!Number.isFinite(number) || number < 0) return
					writeAt(next, path.concat(field), number)
				}
				commit(next)
			}

			const editRuleText = (path, key, raw) => {
				const next = isDataObject(draft) ? cloneData(draft) : {}
				const list = String(raw)
					.split(',')
					.map((item) => item.trim())
					.filter((item) => item !== '')
				if (list.length === 0) deleteAt(next, path.concat(key))
				else writeAt(next, path.concat(key), list)
				commit(next)
			}

			const editRuleNumber = (path, key, raw) => {
				const text = String(raw).trim()
				const next = isDataObject(draft) ? cloneData(draft) : {}
				if (text === '') {
					deleteAt(next, path.concat(key))
				} else {
					const number = Number(text)
					if (!Number.isFinite(number)) return
					writeAt(next, path.concat(key), number)
				}
				commit(next)
			}

			const editRuleChoice = (path, key, raw) => {
				const next = isDataObject(draft) ? cloneData(draft) : {}
				if (raw === 'idle' || raw === 'clock') writeAt(next, path.concat(key), raw)
				else deleteAt(next, path.concat(key))
				commit(next)
			}

			const dropPath = (path) => {
				const next = isDataObject(draft) ? cloneData(draft) : {}
				deleteAt(next, path)
				commit(next)
			}

			const dropPaths = (paths) => {
				const next = isDataObject(draft) ? cloneData(draft) : {}
				for (const path of paths) deleteAt(next, path)
				commit(next)
			}

			const save = () => {
				if (busy || !dirty) return
				setBusy(true)
				setStatus({ kind: 'saving', text: t('settings.saving') })
				requestJson('/save', {
					method: 'POST',
					headers: { accept: 'application/json', 'content-type': 'application/json' },
					body: JSON.stringify({ config: draft })
				})
					.then((payload) => {
						if (payload === null || typeof payload !== 'object' || payload.ok === false) {
							setStatus({ kind: 'error', text: t('settings.failed', { error: (payload && payload.error) || 'unknown' }) })
							return
						}
						if (payload.state !== undefined) adopt(payload.state)
						setDirty(false)
						setStatus({ kind: 'saved', text: t('settings.clean2') })
					})
					.catch((error) => {
						setStatus({ kind: 'error', text: t('settings.failed', { error: String(error && error.message ? error.message : error) }) })
					})
					.then(() => setBusy(false))
			}

			const rateCell = (path, column, fallbackRate, label) => {
				const current = readAt(draft, path.concat(column.field))
				const overridden = typeof current === 'number'
				return h('input', {
					key: 'rate:' + label + ':' + column.key,
					className: PREFIX + '-input',
					type: 'number',
					step: '0.001',
					min: '0',
					inputMode: 'decimal',
					'aria-label': label + ' ' + t(column.periodLabel) + ' ' + t(column.fieldLabel),
					'data-override': overridden ? 'true' : 'false',
					defaultValue: overridden ? String(current) : '',
					placeholder: numberAt(fallbackRate),
					onChange: (event) => editRate(path, column.field, event.target.value)
				})
			}

			const rulesFields = (provider, path) => {
				const rules = isDataObject(provider.rules) ? provider.rules : {}
				const defaults = isDataObject(provider.defaults) && isDataObject(provider.defaults.rules) ? provider.defaults.rules : {}
				const currentWindows = readAt(draft, path.concat('peakWindows'))
				const currentHolidays = readAt(draft, path.concat('holidays'))
				const currentWorkdays = readAt(draft, path.concat('workdays'))
				const currentOffset = readAt(draft, path.concat('utcOffsetMinutes'))
				const currentWeekends = readAt(draft, path.concat('weekends'))
				return h('div', { className: PREFIX + '-rules' },
					h('label', { className: PREFIX + '-field' },
						h('span', { className: PREFIX + '-fieldLabel' }, t('settings.peakWindows')),
						h('input', {
							className: PREFIX + '-input',
							type: 'text',
							'data-override': Array.isArray(currentWindows) ? 'true' : 'false',
							defaultValue: Array.isArray(currentWindows) ? currentWindows.join(', ') : '',
							placeholder: arraysAt(defaults.peakWindows),
							title: t('settings.peakWindowsHint'),
							onChange: (event) => editRuleText(path, 'peakWindows', event.target.value)
						})),
					h('label', { className: PREFIX + '-field' },
						h('span', { className: PREFIX + '-fieldLabel' }, t('settings.weekends')),
						h('select', {
							className: PREFIX + '-select',
							defaultValue: typeof currentWeekends === 'string' ? currentWeekends : (rules.weekends === 'clock' ? 'clock' : 'idle'),
							onChange: (event) => editRuleChoice(path, 'weekends', event.target.value)
						},
							h('option', { value: 'idle' }, t('settings.weekends.idle')),
							h('option', { value: 'clock' }, t('settings.weekends.clock')))),
					h('label', { className: PREFIX + '-field' },
						h('span', { className: PREFIX + '-fieldLabel' }, t('settings.utcOffset')),
						h('input', {
							className: PREFIX + '-input',
							type: 'number',
							step: '30',
							'data-override': typeof currentOffset === 'number' ? 'true' : 'false',
							defaultValue: typeof currentOffset === 'number' ? String(currentOffset) : '',
							placeholder: numberAt(defaults.utcOffsetMinutes),
							onChange: (event) => editRuleNumber(path, 'utcOffsetMinutes', event.target.value)
						})),
					h('label', { className: PREFIX + '-field' },
						h('span', { className: PREFIX + '-fieldLabel' }, t('settings.holidays')),
						h('input', {
							className: PREFIX + '-input',
							type: 'text',
							'data-override': Array.isArray(currentHolidays) ? 'true' : 'false',
							defaultValue: Array.isArray(currentHolidays) ? currentHolidays.join(', ') : '',
							placeholder: arraysAt(defaults.holidays),
							title: t('settings.datesHint'),
							onChange: (event) => editRuleText(path, 'holidays', event.target.value)
						})),
					h('label', { className: PREFIX + '-field' },
						h('span', { className: PREFIX + '-fieldLabel' }, t('settings.workdays')),
						h('input', {
							className: PREFIX + '-input',
							type: 'text',
							'data-override': Array.isArray(currentWorkdays) ? 'true' : 'false',
							defaultValue: Array.isArray(currentWorkdays) ? currentWorkdays.join(', ') : '',
							placeholder: arraysAt(defaults.workdays),
							title: t('settings.datesHint'),
							onChange: (event) => editRuleText(path, 'workdays', event.target.value)
						})))
			}

			/**
			 * One price table: a provider-default row plus one row per live model.
			 * @param keyPrefix - render key namespace (`bailian`, `fallback`).
			 * @param models - live model rows (empty for the fallback book).
			 * @param defaults - rates the provider-default row inherits.
			 * @param bookPath - config path of the price table (`['providers', id, 'pricing']`).
			 */
			const priceGrid = (keyPrefix, models, defaults, bookPath) => {
				const head = [
					h('div', { key: 'name', className: PREFIX + '-gridHead' }, t('settings.model')),
					RATE_COLUMNS.map((column) => h('div', {
						key: column.key,
						className: PREFIX + '-gridHead'
					}, t(column.periodLabel) + ' · ' + t(column.fieldLabel))),
					h('div', { key: 'reset', className: PREFIX + '-gridHead' }, '')
				]
				const bookRow = [
					h('div', { key: 'book', className: PREFIX + '-gridName', title: t('settings.defaultRowHint') }, t('settings.defaultRow')),
					RATE_COLUMNS.map((column) => rateCell(bookPath.concat(column.period), column, own(own(defaults, column.period), column.field), keyPrefix + ':book')),
					h('button', {
						key: 'bookReset',
						className: PREFIX + '-mini',
						type: 'button',
						title: t('settings.resetModel'),
						onClick: () => dropPaths([bookPath.concat('idle'), bookPath.concat('peak')])
					}, t('settings.resetModel'))
				]
				const rows = []
				for (const model of Array.isArray(models) ? models : []) {
					const modelPath = bookPath.concat('models', String(model.id))
					rows.push(h('div', {
						key: model.id + ':name',
						className: PREFIX + '-gridName',
						'data-source': model.source,
						title: model.id
					}, model.id))
					for (const column of RATE_COLUMNS) {
						rows.push(rateCell(
							modelPath.concat(column.period),
							column,
							own(own(model.defaults, column.period), column.field),
							keyPrefix + ':' + model.id
						))
					}
					rows.push(h('button', {
						key: model.id + ':reset',
						className: PREFIX + '-mini',
						type: 'button',
						title: t('settings.resetModel'),
						onClick: () => dropPath(modelPath)
					}, t('settings.resetModel')))
				}
				return h('div', { className: PREFIX + '-scroll', key: 'grid:' + keyPrefix },
					h('div', { className: PREFIX + '-grid' }, head.concat(bookRow, rows)))
			}

			const header = h('div', { className: PREFIX + '-settingsHead', key: 'head' },
				h('div', { className: PREFIX + '-settingsTitle' }, t('settings.title')),
				h('div', { className: PREFIX + '-settingsDesc' }, t('settings.desc')))

			if (state === null) {
				return h('div', { className: PREFIX + '-settings' },
					header,
					h('div', { className: PREFIX + '-status', 'data-kind': status.kind }, status.text || t('settings.loading')))
			}

			const providers = Array.isArray(state.providers) ? state.providers : []
			const stale = isDataObject(state.stale) ? state.stale : {}
			const staleProviders = Array.isArray(stale.providers) ? stale.providers : []
			const staleModels = Array.isArray(stale.models) ? stale.models : []
			const warnings = Array.isArray(state.warnings) ? state.warnings : []
			const writable = state.writable === true
			const currency = typeof state.currency === 'string' ? state.currency : '¥'

			const cards = providers.map((provider) => {
				const path = ['providers', String(provider.id)]
				const models = Array.isArray(provider.models) ? provider.models : []
				const book = isDataObject(provider.book) ? provider.book : {}
				const defaults = isDataObject(provider.defaults) ? provider.defaults : {}
				return h('div', { className: PREFIX + '-card', key: 'provider:' + provider.id },
					h('div', { className: PREFIX + '-cardHead' },
						h('div', { className: PREFIX + '-cardName' }, String(provider.id), ' ',
							h('span', { className: PREFIX + '-badge', 'data-source': provider.source }, t('settings.source.' + (provider.source || 'book')))),
						h('button', {
							className: PREFIX + '-mini',
							type: 'button',
							onClick: () => dropPath(path)
						}, t('settings.resetProvider'))),
					rulesFields(provider, path),
					h('div', { className: PREFIX + '-hint' }, t('settings.inherited')),
					priceGrid(
						String(provider.id),
						models,
						isDataObject(defaults.book) ? defaults.book : (isDataObject(provider.book) ? provider.book : {}),
						path.concat('pricing')
					))
			})

			const fallback = isDataObject(state.fallback) ? state.fallback : {}
			const fallbackCard = h('div', { className: PREFIX + '-card', key: 'fallback' },
				h('div', { className: PREFIX + '-cardHead' },
					h('div', { className: PREFIX + '-cardName' }, t('settings.fallback'),
						' ', h('span', { className: PREFIX + '-badge' }, t('settings.source.book')))),
				h('div', { className: PREFIX + '-rules' },
					h('label', { className: PREFIX + '-field' },
						h('span', { className: PREFIX + '-fieldLabel' }, t('settings.currency')),
						h('input', {
							className: PREFIX + '-input',
							type: 'text',
							maxLength: 8,
							'data-override': typeof readAt(draft, ['pricing', 'currency']) === 'string' ? 'true' : 'false',
							defaultValue: typeof readAt(draft, ['pricing', 'currency']) === 'string' ? readAt(draft, ['pricing', 'currency']) : '',
							placeholder: currency,
							onChange: (event) => {
								const raw = String(event.target.value).trim()
								const next = isDataObject(draft) ? cloneData(draft) : {}
								if (raw === '') deleteAt(next, ['pricing', 'currency'])
								else writeAt(next, ['pricing', 'currency'], raw)
								commit(next)
							}
						}))),
				rulesFields({ rules: fallback.rules, defaults: fallback.defaults }, []),
				priceGrid(
					'fallback',
					[],
					isDataObject(fallback.defaults) && isDataObject(fallback.defaults.book)
						? fallback.defaults.book
						: (isDataObject(fallback.book) ? fallback.book : {}),
					['pricing']
				))

			const staleCard = staleProviders.length > 0 || staleModels.length > 0
				? h('div', { className: PREFIX + '-card', key: 'stale' },
					h('div', { className: PREFIX + '-cardHead' },
						h('div', { className: PREFIX + '-cardName' }, t('settings.stale'))),
					h('div', { className: PREFIX + '-hint' }, t('settings.staleHint')),
					staleProviders.map((id) => h('button', {
						key: 'staleP:' + id,
						className: PREFIX + '-mini',
						type: 'button',
						onClick: () => dropPath(['providers', String(id)])
					}, t('settings.staleProvider', { name: id }) + ' · ' + t('settings.clean'))),
					staleModels.map((entry) => h('button', {
						key: 'staleM:' + entry.provider + '/' + entry.model,
						className: PREFIX + '-mini',
						type: 'button',
						onClick: () => dropPath(['providers', String(entry.provider), 'pricing', 'models', String(entry.model)])
					}, t('settings.staleModel', { provider: entry.provider, model: entry.model }) + ' · ' + t('settings.clean'))))
				: null

			const empty = providers.length === 0 && staleCard === null
				? h('div', { className: PREFIX + '-hint', key: 'empty' }, t('settings.empty'))
				: null

			const footer = h('div', { className: PREFIX + '-footer', key: 'footer' },
				h('button', {
					className: PREFIX + '-primary',
					type: 'button',
					disabled: !writable || !dirty || busy,
					onClick: save
				}, busy ? t('settings.saving') : t('settings.save')),
				h('button', { className: PREFIX + '-mini', type: 'button', disabled: busy, onClick: load }, t('settings.reload')),
				h('button', { className: PREFIX + '-mini', type: 'button', disabled: busy, onClick: load }, t('settings.refresh')),
				writable ? null : h('span', { className: PREFIX + '-status' }, t('settings.readonly')),
				h('span', { className: PREFIX + '-status', 'data-kind': status.kind }, status.text))

			const warningBlock = warnings.length > 0
				? h('div', { className: PREFIX + '-hint', key: 'warnings' }, t('settings.warnings') + warnings.join(' · '))
				: null

			const body = [header]
			if (warningBlock !== null) body.push(warningBlock)
			if (empty !== null) body.push(empty)
			for (const card of cards) body.push(card)
			body.push(fallbackCard)
			if (staleCard !== null) body.push(staleCard)
			body.push(footer)

			return h('div', { className: PREFIX + '-settings', key: 'v' + version }, body)
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
				// The price-book editor lives in Settings → Plugins. Its rows come from
				// the Host API, so it stays in sync with whatever models DSH registers.
				ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
					name: 'settings.plugins.tab',
					id: 'session-tariff-price-book',
					order: 30,
					label: () => fallbackT('settings.tab')
				}, TariffSettings))
			}
		}
	}
})
