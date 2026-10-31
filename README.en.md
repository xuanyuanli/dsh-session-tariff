# dsh-session-tariff

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

A cost pill for the [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) Web GUI composer status bar. It prices each request against the tariff of the **provider it belongs to** — two tiers, **peak** and **idle** — with built-in price books for `deepseek-account` (DeepSeek official) and `bailian` / `bailian-chat` (Alibaba Cloud Bailian), plus per-provider `config.providers` overrides. Click the pill for a per-period, per-model breakdown of cached input, uncached input, cache writes and output: tokens and money for each bucket.

> 在 DSH Web GUI 的输入框状态栏加一个「本会话花费」胶囊：按每条请求所属 provider 的高峰 / 空闲两档价分别计价（内置 DeepSeek 官方与阿里云百炼价目表，可用 `config.providers` 覆盖），点开可看到每个时段、每个模型的缓存读取、未缓存输入、缓存写入、输出各自的 token 数与金额。

## What it looks like

The pill sits after the built-in stats, before the context-usage ring:

```
 ⌁ 3 turns 102 steps · 251 tok/s     ⛁ 18.2M tok · 99% cached     ⊙ ≈¥1.72     ◔ 19%
```

Click it:

```
Session cost                                           ¥1.72
──────────────────────────────────────────────────────────────
Peak hours   149 requests                             ¥1.72
  Cached input      18.2M                             ¥0.729
  Uncached input   133.0K                             ¥0.266
  Output            90.9K                             ¥0.727
──────────────────────────────────────────────────────────────
Idle: hit ¥0.02 · miss ¥1 · output ¥4 per 1M tokens
Peak: hit ¥0.04 · miss ¥2 · output ¥8 per 1M tokens
Peak hours are workdays 09:00-12:00 / 14:00-18:00; every other hour, weekends and public holidays bill as idle
```

- The `≈` marks the amount as an **estimate** computed from token counts and unit prices, not a bill
- Token columns use `K` / `M`; hover for the full number (`18,234,567`)
- The three detail rows are each rounded to 3 decimals, so they can differ from the period total by ±0.001
- When a session spans more than one provider, each detail row gets a small provider tag before the period tag and the footer groups rates and period rules per provider; with a single provider the layout is exactly as shown above

## Features

- The pill prices the whole session log, not the current window, matching the token stats next to it
- Provider-aware pricing: built-in price books and period rules for `deepseek-account` (DeepSeek official) and `bailian` / `bailian-chat` (Alibaba Cloud Bailian) work out of the box, and `config.providers` overrides them per provider
- **Prices are editable in the GUI**: Settings → Plugins → dsh-session-tariff (or the Session cost tab under Built-in plugins); rows follow the providers and models DSH has registered, and saving applies immediately (written to the profile's `cordis.patch.yml`, no restart)
- Grouped by tariff period: a period that was never used is not listed
- Each period reports its request count plus tokens and allocated money for all four usage buckets
- The footer states the two unit-price sets and the peak-hour rule currently in effect
- A session that spans several providers is settled per provider: rows carry a provider tag and the footer groups rates and period rules by provider
- Follows DSH theme tokens and language (zh / en); no wrapping or misalignment on narrow screens
- Keyboard friendly: `Esc` closes, clicking outside the panel closes

## How it works

### Why it needs a host-side projection

The built-in `tokenUsage` projection only exposes aggregate buckets — **it has no time dimension**, so it cannot answer "when did these 18 million tokens actually happen". This plugin registers a session projection `sessionCost` on the host ([host.js](host.js)) that folds every model request as it arrives: it resolves the provider / model from `request/context` and `message.source`, then prices the request against that provider's price book at the moment the request started, producing a provider × model × period ledger; the client ([client.js](client.js)) only reads, prices and renders.

```
session/* event stream
   ├─ request/context       → updates the current route (provider + model) on a route change (first request, provider/model switch)
   ├─ step/start            → remember when this request started
   ├─ assistant/attempt     → streamed usage (later overwritten by the message of the same request)
   ├─ assistant/message     → final usage for the request, filed via message.source.provider / model
   │                          into that provider's price book and that model's own ledger, by start time into idle / peak
   └─ llm/retry-started     → closes the overwrite slot; the retry counts as a second request
        ↓
   sessionCost projection → { idle: {…}, peak: {…}, books: [{ provider, peakWindows, weekends, idle, peak, models }], models: [{ provider, model, idle, peak }] }
        ↓
   pill + breakdown dialog (one row per provider × model × period, priced at that provider book's rate for that model)
```

### Billing rules

- **One request = one model call**; the period comes from the `time` of `step/start` (when the provider was called, not when it finished)
- **Provider and model attribution**: the request's own `assistant/message` — `message.source.provider` / `message.source.model` — is authoritative; `assistant/attempt` carries no source and is attributed to the current route last recorded by `request/context`. Each provider has its own price book (period rules + unit prices); a multi-provider session is settled per provider without changing the totals
- If `assistant/attempt` arrives first, the request's `assistant/message` **overwrites** it — a streamed partial report is never double counted
- A retry after `llm/retry-started` is another billable request and is added separately
- Requests without provider usage (cancelled before reporting) are not counted
- Amount = Σ(bucket tokens × bucket price) ÷ 1,000,000

The fold matches the official `tokenUsage` unit, so the two periods summed must equal the `tokenUsage` totals bucket by bucket (see "Verified").

### Period rules

The time zone is fixed to `UTC+8` (`utcOffsetMinutes: 480`; China has no DST):

| Time | Tier |
| --- | --- |
| Workday 09:00–12:00 | peak |
| Workday 12:00–14:00 | idle |
| Workday 14:00–18:00 | peak |
| Workday 18:00–09:00 next day | idle |
| Saturday, Sunday (unless a make-up workday) | idle |
| Public holidays | idle |

`workdays` (make-up workdays) outranks `holidays` and the weekend: a make-up workday that lands on a Saturday still bills as peak during work hours.

## Install

Prerequisite: a working DSH (Desktop, or `dsh` started with a profile). Plugins are per profile and apply to every session in it. The declared range is `@deepseek-ai/dsh` `^0.2.1-rc.2`, tested on `0.2.1-rc.3`; the 0.1.x client slot / projection APIs differ and are untested.

### Option 1: npm (once published)

```bash
dsh plugin add dsh-session-tariff
```

### Option 2: let the DSH agent install from source (recommended today)

In any DSH session, say:

> Install this plugin into the current profile: `https://github.com/xuanyuanli/dsh-session-tariff` — clone it, then run `plugin_manager install_bundle` on that directory.

### Option 3: clone and install by hand

```bash
git clone https://github.com/xuanyuanli/dsh-session-tariff.git
```

Then have the agent run `plugin_manager` `install_bundle` on that directory (an absolute path), or install the local directory from the plugin page.

After installing:

- The **client half** (pill and dialog) takes effect on page refresh (`Ctrl+Shift+R` if needed)
- The **host half** (`sessionCost` projection) registers inside the DSH process; when upgrading from 1.1.0 the projection key is still `sessionCost`, but the host state shape (`stateVersion: 2`) and the pricing logic both change, so restart DSH to load the new module; client-only changes need just a page refresh

Uninstall: `plugin_manager remove_bundle dsh-session-tariff` (or `dsh plugin remove dsh-session-tariff` for an npm install).

## Configuration

### Edit prices in the GUI: Settings → Plugins → dsh-session-tariff

Once installed, no YAML is needed. Open **Settings → Plugins**, open this plugin (`dsh-session-tariff`), and the **Session cost price book** editor sits right under its description; the `session-tariff` row also grows a configure control that opens the same editor as a full page. **Settings → Built-in plugins** carries a **Session cost** tab with the same content — three entry points, one price book.

- **Rows come from DSH itself.** The page reads the providers and models DSH currently registers (`ctx.llm.listProviders()` / `listModels()`) and renders one row per model. **Add a provider or model and the row appears on the next read**, with its default already filled in from "built-in preset → provider default row → fallback book"; leave a cell empty and it keeps inheriting. **Remove a model and its row disappears**; any configuration left behind is listed under "Stale configuration" and can be dropped in one click.
- **Editing a cell overrides only that cell.** A filled input is an explicit price; clearing it restores inheritance (it does not write 0). "Reset" on a row clears that row; "Clear every override for this provider" on a card clears the whole block.
- **Saving applies immediately.** Saves go through the Host's `configEditor`, are written into the active profile's `cordis.patch.yml`, and the row is re-applied — the pill, the detail panel and the projection use the new prices on their next computation, with **no restart**.
- **Period rules live on the same card** — peak windows, weekend mode, UTC offset, holidays and make-up workdays; empty means inherit (preset or fallback).
- The **fallback book** card serves providers without a preset and also holds the currency.
- When the footer says "Saved — the pill is already repriced", the change is on disk.

> There is exactly one server surface: `GET /dsh-session-tariff/api/state` returns "live catalog + current config + writable flag", `POST /dsh-session-tariff/api/save` validates and writes. Writes are accepted only as same-origin `application/json` and pass through `sanitizeConfig()` before they touch disk — unknown fields, negative numbers, malformed `HH:MM-HH:MM` / `YYYY-MM-DD`, and prototype-pollution keys are rejected rather than persisted.

Only Host *code* changes (`host.js`) need a DSH restart; client-only changes need a page refresh, and prices themselves are configuration, so they always hot-apply.

The YAML shape below still works in full, and remains the right choice for "pin it in the repo" or scripted installs:

### Unit prices (client)

The defaults live at the top of [client.js](client.js) and double as the **fallback price book for providers without a preset**:

```js
const DEFAULT_PRICING = {
  currency: '¥',
  idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
}
```

The unit is **currency units per one million tokens**. `config.pricing` still overrides that fallback book (any subset), but it only applies to a provider that has neither a built-in preset nor a `config.providers` entry:

```yaml
- insert:
    - id: session-tariff
      name: dsh-session-tariff
      config:
        pricing:
          currency: '¥'
          idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
          peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
```

> **Where the prices come from.** These numbers are the `deepseek-flash` tier of the official DeepSeek [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) page (checked 2026-10): idle 0.02 / 1 / 4, peak 0.04 / 2 / 8 — peak is exactly twice idle. They are both the fallback default and the top-level rates of the built-in `deepseek-account` preset. Three caveats:
>
> - `cacheWrite` defaults to the **miss rate**: DeepSeek has no separate cache-write price (written tokens land in the uncached bucket), and for providers that do report writes separately the miss rate is still the closest match to the bill. When `cacheWriteTokens` is always 0 in your session, this term stays 0 anyway.
> - The two `deepseek-v4-pro` rate sets (idle `0.15 / 4.5 / 4.5 / 13.5`, peak `0.30 / 9 / 9 / 27`) are already part of the `deepseek-account` preset, so leave them alone; add any other model under `config.providers`.
> - Prices change. They are not fetched live, so update the matching `config.providers.<provider>` entry or the fallback `config.pricing` when the list moves.

### Pricing per provider

One session may span several providers (provider switching, model switching, subagents), and their price books and period rules differ. The plugin picks the price book by the **provider each request belongs to**; the attribution comes from the event stream:

- on every route change (the session's first request, or a switch to another provider / model) the host appends a `request/context` event carrying `provider` and `model`; the fold uses it to remember the current route
- `message.source.provider` / `message.source.model` on each `assistant/message` is **authoritative** for that request
- `assistant/attempt` carries no source and is attributed to the current route

Built-in presets cover the two common providers — `deepseek-account` (DeepSeek official) and `bailian` / `bailian-chat` (Alibaba Cloud Bailian) — out of the box; `config.providers` overrides them per provider, and can also give a provider without a preset a price book of its own. Price books use the same unit as above: **currency units per one million tokens** (both built-in presets are CNY `¥`), listed in the order cached hit / miss / write / output.

#### Built-in preset: DeepSeek official

`deepseek-account` follows DeepSeek's official tariff: the peak windows are workdays 09:00-12:00 / 14:00-18:00, and weekends and public holidays bill as idle all day (`weekends: 'idle'`).

| Model | Idle (hit / miss / write / output) | Peak (hit / miss / write / output) |
| --- | --- | --- |
| `deepseek-flash` (default) | 0.02 / 1 / 1 / 4 | 0.04 / 2 / 2 / 8 |
| `deepseek-v4-pro` | 0.15 / 4.5 / 4.5 / 13.5 | 0.30 / 9 / 9 / 27 |

#### Built-in preset: Alibaba Cloud Bailian

`bailian` (the OpenAI-responses endpoint) and `bailian-chat` (the OpenAI-completions endpoint) are two provider ids that share one Bailian preset. Bailian differs from DeepSeek in several fundamental ways (shown for `deepseek-v4.1-flash-1017`):

| | DeepSeek official | Bailian |
|---|---|---|
| Idle window | No global idle band, only weekday peak windows | **Idle 22:00–08:00 UTC+8, busy the rest of the day** |
| Weekends | Idle all day | **No discount, billed as busy** |
| Cache hit | 0.02 / 0.04 | **0.1 / 0.2** |

The plugin's default `peakWindows` cannot express a range that crosses midnight (a `22:00-24:00` entry does not work), so the preset fills it **inverted**: the daytime is written as the peak window (`peakWindows: ['08:00-22:00']`) and weekends follow the wall clock (`weekends: 'clock'`). Both are built in — **there is no need to flip the global `peakWindows` / `weekends` on the bundle row any more**.

| Model | Idle (hit / miss / write / output) | Peak (hit / miss / write / output) |
| --- | --- | --- |
| `deepseek-v4.1-flash-1017` (default) | 0.1 / 1 / 1 / 4 | 0.2 / 2 / 2 / 8 |
| `qwen3.8-max` | 1.5 / 12 / 12 / 36 | same as idle |
| `ZHIPU/GLM-5.3-Flash` | 0.23 / 0.8 / 0.8 / 2.8 | same as idle |
| `ZHIPU/GLM-5.3` | 2 / 8 / 8 / 28 | same as idle |

#### `config.providers` overrides

Entries under `config.providers.<provider>` are **merged field by field** over that provider's preset (or over the fallback book when it has no preset): write only what you want to change; missing rule fields inherit from the preset (or the fallback rules), missing rate fields inherit field by field, and `models` rows are merged per model id. `pricing.currency` / `pricing.defaultModel` can be set per provider too.

```yaml
- insert:
    - id: session-tariff
      name: dsh-session-tariff
      config:
        providers:
          bailian:                          # Bailian: only the fields you want to change; the rest inherits
            peakWindows: ['08:00-22:00']    # everything outside 22:00-08:00 is peak (same as the preset; change here to override)
            weekends: clock                  # no weekend discount, follow the clock (same as the preset)
            pricing:
              idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
              peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
          deepseek-account:                  # DeepSeek official: spell out the default rules and model table
            peakWindows: ['09:00-12:00', '14:00-18:00']
            weekends: idle
            pricing:
              idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
              peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
              models:
                deepseek-v4-pro:
                  idle: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 }
                  peak: { cacheHit: 0.30, cacheMiss: 9, cacheWrite: 9, output: 27 }
```

#### Per-model pricing

Every price book (built-in preset, `config.providers.<provider>.pricing` or the fallback `config.pricing`) may carry a `models` table keyed by **exact model id**; each entry can override `idle` / `peak` independently, and models not listed fall back to that book's top-level `idle` / `peak`. Add a model the preset does not know like this:

```yaml
- id: session-tariff
  name: dsh-session-tariff
  config:
    providers:
      deepseek-account:
        pricing:
          models:
            my-proxy-model:              # a model the preset does not know, priced from this table
              idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
              peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
```

The model id comes from `message.source.model` on each `assistant/message`, so it is exactly what DSH sends to the provider (quote names containing slashes such as `ZHIPU/GLM-5.3` in YAML). The breakdown dialog splits into one row per provider × model × period, each settled at that provider book's rate for that model; with a single provider no provider tag is shown.

#### Precedence

For a request's provider, the price book is resolved in this order:

1. `config.providers[provider]`, merged over the provider's preset (when it has one) or over the fallback book (when it does not)
2. the built-in preset for that provider
3. the flat price book / period rules at the top level of the bundle row's `config` (fallback)
4. `DEFAULT_PRICING` / `DEFAULT_RULES` in the code (DeepSeek official numbers)

In other words, flat `pricing` / `peakWindows` / `weekends` only decide the bill for a provider that has neither a preset nor a `config.providers` entry.

#### Migrating from flat config

If you previously customized `config.pricing` or `peakWindows` / `weekends` / `holidays` / `workdays` on the bundle row for a **known provider** (`deepseek-account`, `bailian`, `bailian-chat`), move the whole block under `config.providers.<provider>` at the same position: the fields are unchanged, just one provider id deeper. Flat fields now only backstop providers without a preset and no longer affect known providers; the old "set the global `peakWindows: ['08:00-22:00']` + `weekends: clock`" Bailian recipe stops working and Bailian requests go back to the preset numbers.

### Period rules (host)

The defaults live in `DEFAULT_RULES` in [host.js](host.js) and are the **fallback rules for providers without a preset**:

```js
{
  utcOffsetMinutes: 480,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  holidays: [],    // 'YYYY-MM-DD'
  workdays: [],    // 'YYYY-MM-DD', make-up workdays
  weekends: 'idle' // 'idle': weekends bill idle all day (DeepSeek); 'clock': follow peakWindows
}
```

The same fields can be set either at the top level of the bundle row's `config` (fallback rules) or under `config.providers.<provider>` (overriding only that provider's rules; see the comments in [cordis.patch.yml](cordis.patch.yml)). A provider with a preset uses the preset rules by default: `deepseek-account` is workdays 09:00-12:00 / 14:00-18:00 + `weekends: 'idle'`, while `bailian` / `bailian-chat` use `peakWindows: ['08:00-22:00']` + `weekends: 'clock'`.

**The holiday table is empty by default**: without it, a public holiday is treated as an ordinary workday and bills as peak inside `peakWindows`. Fill `holidays` / `workdays` from the official calendar for exactness (under the provider, or in the fallback rules).

`weekends` decides how a Saturday/Sunday that is **not** listed in `workdays` is classified: `'idle'` (the default, DeepSeek's rule: idle all day) or `'clock'` (ignore the weekday and only look at `peakWindows`, which is what Bailian and other pay-as-you-go providers do — the built-in Bailian preset is `'clock'`). Any date in `holidays` bills as idle under either policy.

## Verified

- Fold unit tests ([test/fold.test.mjs](test/fold.test.mjs), no dependencies):

  ```bash
  node test/fold.test.mjs
  ```

  Covers the `09:00` / `12:00` / `14:00` / `18:00` boundaries, weekends, public holidays, make-up workdays, `assistant/attempt` being overwritten by `message`, retries counting twice, unrelated events preserving state identity, checkpoint restore, the wire view shape, the `weekends: 'clock'` policy and per-model attribution (one `attempt` + `message` on the same model counts as a single request, two models produce two rows, and the rows sum back to the totals), plus provider-aware price-book selection: `deepseek-account` and `bailian` requests each use their own preset, `config.providers` merges field by field, two providers in one session settle separately, and a regression case where a stale global Bailian config must not price a DeepSeek-official session.

- Price-book editor tests (`npm test`, three files, 28 cases, no external dependencies):
  - [test/editor.test.mjs](test/editor.test.mjs) covers the Host half: `liveCatalog` lists the live providers / models sorted by id, a single provider whose model list fails becomes one warning and stays in the catalog, `describeState` sources (preset / config / book) plus `defaults` / `stale`, `sanitizeConfig` accepting and rejecting (unknown fields, negatives, bad windows and dates, `__proto__` / `constructor` pollution, empty-row pruning), `plainConfig` unwrapping, and the routes **wired through the real `apply()`**: `GET /state`, `POST /save` (through `configEditor.edit`, answering with fresh state), an invalid draft never writing, cross-site and form posts refused with 403, a deployment with no writable row explained, unknown paths 404.
  - [test/client.test.mjs](test/client.test.mjs) loads `client.js` in a `vm` sandbox with a tiny React shim and actually renders the settings page, then drives `onChange` / `onClick`: rows follow the catalog, an empty input shows the inherited rate as placeholder, one edited cell produces a POST body with exactly that cell, clearing an input deletes the override instead of writing 0, stale entries are removed in one click, the missing-Host and read-only notices render, and both dictionaries cover every key the page asks for.

- Runtime reconciliation: on one `deepseek-flash` session (144 requests) the two `sessionCost` periods summed to exactly the same `tokenUsage` totals — cached read 17,137,024 / uncached input 131,962 / output 87,763 — so nothing is billed twice and nothing is dropped.

- Price check: compared against the official [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) page in 2026-10; `deepseek-flash` idle 0.02 / 1 / 4 and peak 0.04 / 2 / 8 match the `deepseek-account` preset bucket by bucket, and the `deepseek-v4-pro` pair 0.15 / 4.5 / 4.5 / 13.5 and 0.30 / 9 / 9 / 27 is written into the preset from the same page. The `bailian` preset follows Bailian's pay-as-you-go tariff: idle 22:00-08:00, no weekend discount, cache hit 0.1 / 0.2.

- Visuals (pill placement, dialog layout) were checked by hand in DSH Desktop; the project has no browser automation, and **the settings page has not been eyeballed in a browser yet** (the DSH Web GUI needs a signed-in session). Its behaviour is covered by the `vm` render test above.

## Known limitations

- The prices are static: the built-in presets cover only the three provider ids `deepseek-account`, `bailian` / `bailian-chat` (two presets) and the models listed above; any other provider / model bills at the fallback book, or add it under `config.providers.<provider>.pricing` (see "Per-model pricing"), and unlisted models fall back to that book's top-level rates; changed prices must be updated by hand in the YAML path, or once in the settings page
- The settings page reads the providers / models the Host had registered **at that moment**, so "a new model appears, a removed model disappears" is per read: leave and re-enter the page, or press "Refresh models"; it does not subscribe to catalog changes
- Saving hot-applies through the Loader re-applying the plugin row; a stale row still participates in pricing until you remove it (the page lists it for that reason)
- Provider attribution comes from `message.source.provider` (falling back to the route of the last `request/context`); older logs with neither bill at the fallback book
- Model attribution comes from `message.source.model`; when it is missing (older logs, or a Host that has not published per-model rows) the whole session lands on the `defaultModel` row
- `peakWindows` cannot express a range crossing midnight (such as `22:00-24:00`); Bailian-style "idle at night" is implemented by the built-in preset with an inverted `08:00-22:00` window, and a custom provider needs the same trick (see "Built-in preset: Alibaba Cloud Bailian")
- The holiday / make-up-workday table is yours to maintain and empty by default; weekends bill as idle by default (`weekends: 'idle'`), while the Bailian preset is `'clock'`
- A request is filed by its **start** time; a long request that crosses 12:00 or 18:00 bills entirely at the starting tier
- Only requests with provider-reported usage are counted; a cancelled request without usage is not
- Detail rows round to 3 decimals, so they can differ from the period total by ±0.001
- It only fits the `conversation.composer.dock` slot of the DSH Web GUI; the host projection key `sessionCost` is globally unique, and a clash with another plugin makes registration fail

## Compatibility

| Item | Value |
| --- | --- |
| Declared range | `@deepseek-ai/dsh` `^0.2.1-rc.2` (`peerDependencies` in `package.json`) |
| Tested on | `0.2.1-rc.3` (DSH Desktop) |
| Dependency surface | None at runtime: the host half uses `sessionProjections` (required) plus `webServer` / `configEditor` / `llm` (optional — without them there is no settings page, or it is read-only); the client half only pulls `react` / `react-dom` from the module table |
| Host keys | cordis plugin `session-tariff`, projection `sessionCost`, settings API `/dsh-session-tariff/api` |

## Layout

```
dsh-session-tariff/
├── package.json           # bundle manifest: dsh.bundle.patch + dsh.client (web client half)
├── cordis.patch.yml       # inserts the session-tariff row (with a config example)
├── host.js                # host half: sessionCost projection + price-book API (catalog / validation / persistence)
├── client.js              # client half: status-bar pill, breakdown dialog, and the Settings → Plugins price editor
├── locale/{zh,en}.json    # plugin page title and description
├── icon.svg               # plugin icon (original)
└── test/
    ├── fold.test.mjs      # fold unit tests
    ├── editor.test.mjs    # host half: catalog / validation / HTTP API through the real apply()
    └── client.test.mjs    # client half: renders the settings page in a vm and drives it
```

The client half is a buildless `window.__ModuleLoader__.load({ id, factory })` module: it pulls `react` / `react-dom` from the DSH module table only, styles with DSH theme tokens (`--dsw-alias-*`), and depends on no Harness client package.

## Development

```bash
# syntax check
node --check host.js
node --check client.js

# every test (no DSH, no packages)
npm test

# fold tests only
node test/fold.test.mjs
```

After changing the host half, restart DSH to load the new module; the client half only needs a page refresh.

The settings page cannot read the Loader config (client modules receive none), so it always fetches "live catalog + current config" from the Host API and writes through `configEditor`.

## License

[MIT](LICENSE)
