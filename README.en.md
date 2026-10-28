# dsh-session-tariff

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

A cost pill for the [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) Web GUI composer status bar. It prices the current session against DeepSeek's two tariff tiers — **peak** and **idle** — and opens a per-period breakdown of cached input, uncached input, cache writes and output: tokens and money for each bucket.

> 在 DSH Web GUI 的输入框状态栏加一个「本会话花费」胶囊，按 DeepSeek 高峰 / 空闲两档价分别计价，点开可看到每个时段的缓存读取、未缓存输入、缓存写入、输出各自的 token 数与金额。

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

## Features

- The pill prices the whole session log, not the current window, matching the token stats next to it
- Grouped by tariff period: a period that was never used is not listed
- Each period reports its request count plus tokens and allocated money for all four usage buckets
- The footer states the two unit-price sets and the peak-hour rule currently in effect
- Follows DSH theme tokens and language (zh / en); no wrapping or misalignment on narrow screens
- Keyboard friendly: `Esc` closes, clicking outside the panel closes

## How it works

### Why it needs a host-side projection

The built-in `tokenUsage` projection only exposes aggregate buckets — **it has no time dimension**, so it cannot answer "when did these 18 million tokens actually happen". This plugin registers a session projection `sessionCost` on the host ([host.js](host.js)) that folds every model request as it arrives and files it under peak or idle by the moment the request *started*; the client ([client.js](client.js)) only reads, prices and renders.

```
session/* event stream
   ├─ step/start            → remember when this request started
   ├─ assistant/attempt     → streamed usage (later overwritten by the message of the same request)
   ├─ assistant/message     → final usage for the request, filed under idle / peak by start time
   └─ llm/retry-started     → closes the overwrite slot; the retry counts as a second request
        ↓
   sessionCost projection → { idle: {…}, peak: {…}, peakWindows }
        ↓
   pill + breakdown dialog
```

### Billing rules

- **One request = one model call**; the period comes from the `time` of `step/start` (when the provider was called, not when it finished)
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
- The **host half** (`sessionCost` projection) registers inside the DSH process; when upgrading host code, restart DSH to load the new module

Uninstall: `plugin_manager remove_bundle dsh-session-tariff` (or `dsh plugin remove dsh-session-tariff` for an npm install).

## Configuration

### Unit prices (client)

Defaults live at the top of [client.js](client.js):

```js
const DEFAULT_PRICING = {
  currency: '¥',
  idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
}
```

The unit is **currency units per one million tokens**. Override any subset on the bundle row via `config.pricing`:

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

> **Where the prices come from.** These numbers are the `deepseek-flash` tier of the official DeepSeek [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) page (checked 2026-10): idle 0.02 / 1 / 4, peak 0.04 / 2 / 8 — peak is exactly twice idle. Three caveats:
>
> - `cacheWrite` defaults to the **miss rate**: DeepSeek has no separate cache-write price (written tokens land in the uncached bucket), and for providers that do report writes separately the miss rate is still the closest match to the bill. When `cacheWriteTokens` is always 0 in your session, this term stays 0 anyway.
> - On a `deepseek-v4-pro` session, set idle to `0.15 / 4.5 / 13.5` and peak to `0.30 / 9 / 27`; otherwise the estimate under-reports by roughly 3–7×.
> - Prices change. They are not fetched live, so update this constant or `config.pricing` when the list moves.

### Period rules (host)

Defaults live in `DEFAULT_RULES` in [host.js](host.js):

```js
{
  utcOffsetMinutes: 480,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  holidays: [],   // 'YYYY-MM-DD'
  workdays: []    // 'YYYY-MM-DD', make-up workdays
}
```

The same fields can be set on the bundle row's `config` (see the comments in [cordis.patch.yml](cordis.patch.yml)). **The holiday table is empty by default**: without it, a public holiday is treated as an ordinary workday and bills as peak inside `peakWindows`. Fill `holidays` / `workdays` from the official calendar for exactness.

## Verified

- Fold unit tests ([test/fold.test.mjs](test/fold.test.mjs), no dependencies):

  ```bash
  node test/fold.test.mjs
  ```

  Covers the `09:00` / `12:00` / `14:00` / `18:00` boundaries, weekends, public holidays, make-up workdays, `assistant/attempt` being overwritten by `message`, retries counting twice, unrelated events preserving state identity, checkpoint restore, and the wire view shape.

- Runtime reconciliation: on one `deepseek-flash` session (144 requests) the two `sessionCost` periods summed to exactly the same `tokenUsage` totals — cached read 17,137,024 / uncached input 131,962 / output 87,763 — so nothing is billed twice and nothing is dropped.

- Price check: compared against the official [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) page in 2026-10; `deepseek-flash` idle 0.02 / 1 / 4 and peak 0.04 / 2 / 8 match the defaults bucket by bucket, and so does the footnote (peak = workdays 09:00-12:00 / 14:00-18:00; everything else, weekends and public holidays included, is idle).

- Visuals (pill placement, dialog layout) were checked by hand in DSH Desktop; the project has no browser automation.

## Known limitations

- The prices are one static `deepseek-flash` tier: `deepseek-v4-pro` needs a `config.pricing` override (see "Unit prices")
- The holiday / make-up-workday table is yours to maintain and empty by default; weekends are already idle
- A request is filed by its **start** time; a long request that crosses 12:00 or 18:00 bills entirely at the starting tier
- Only requests with provider-reported usage are counted; a cancelled request without usage is not
- Detail rows round to 3 decimals, so they can differ from the period total by ±0.001
- It only fits the `conversation.composer.dock` slot of the DSH Web GUI; the host projection key `sessionCost` is globally unique, and a clash with another plugin makes registration fail

## Compatibility

| Item | Value |
| --- | --- |
| Declared range | `@deepseek-ai/dsh` `^0.2.1-rc.2` (`peerDependencies` in `package.json`) |
| Tested on | `0.2.1-rc.3` (DSH Desktop) |
| Dependency surface | None at runtime: the host half only uses the `sessionProjections` service, the client half only pulls `react` / `react-dom` from the module table |
| Host keys | cordis plugin `session-tariff`, projection `sessionCost` |

## Layout

```
dsh-session-tariff/
├── package.json           # bundle manifest: dsh.bundle.patch + dsh.client (web client half)
├── cordis.patch.yml       # inserts the session-tariff row (with a config example)
├── host.js                # host half: the sessionCost session projection (fold + period classification)
├── client.js              # client half: status-bar pill and breakdown dialog (React, no build)
├── locale/{zh,en}.json    # plugin page title and description
├── icon.svg               # plugin icon (original)
└── test/fold.test.mjs     # fold unit tests
```

The client half is a buildless `window.__ModuleLoader__.load({ id, factory })` module: it pulls `react` / `react-dom` from the DSH module table only, styles with DSH theme tokens (`--dsw-alias-*`), and depends on no Harness client package.

## Development

```bash
# syntax check
node --check host.js
node --check client.js

# fold tests (no DSH, no packages)
node test/fold.test.mjs
```

After changing the host half, reinstall and restart DSH to load the new module; the client half only needs a page refresh.

## License

[MIT](LICENSE)
