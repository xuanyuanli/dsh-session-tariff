# dsh-session-tariff

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **繁體中文**

在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的輸入框狀態列加一顆「本次工作階段花費」膠囊：按 DeepSeek 的**尖峰 / 離峰**兩段費率分別計價，點開可看到每個時段的快取讀取、未快取輸入、快取寫入、輸出各自的 token 數與金額。

> A DSH plugin that shows the estimated monetary cost of the current session beside the composer status pills, split by DeepSeek peak/idle tariff periods. Click the pill for a per-period, per-bucket token and amount breakdown.

## 效果

膠囊排在原有統計元件之後、上下文用量圓環之前：

```
 ⌁ 3 turns 102 steps · 251 tok/s     ⛁ 18.2M tok · 99% cached     ⊙ ≈¥1.72     ◔ 19%
```

點開膠囊：

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

- 金額前的 `≈` 表示這是用 token 用量與單價算出的**估算值**，不是帳單
- token 欄位以 `K` / `M` 縮寫，滑鼠移上去可看到完整千分位（如 `18,234,567`）
- 明細列四捨五入到小數 3 位，相加可能與時段合計相差 ±0.001

## 功能

- 膠囊統計的是整個工作階段紀錄（不是目前視窗），口徑與旁邊的 token 統計一致
- 依時段分組：某個時段沒用過就不顯示那一列
- 每個時段列出請求次數，以及四個用量桶的 token 數與分攤金額
- 底部註明目前生效的兩段單價與尖峰時段規則
- 跟隨 DSH 主題權杖與語言（zh / en）；桌面與窄螢幕都不會換行錯位
- 支援鍵盤：`Esc` 關閉，點擊面板外關閉

## 運作原理

### 為什麼需要宿主端的投影

DSH 內建的 `tokenUsage` 投影只提供整體聚合桶，**沒有時間維度**，因此無法回答「這 1800 萬 token 分別發生在哪些時段」。本外掛在宿主端註冊一個工作階段投影 `sessionCost`（[host.js](host.js)），逐事件摺疊每次模型請求，依請求**發起時刻**歸入尖峰或離峰，輸出兩段桶；用戶端（[client.js](client.js)）只負責取數、套單價、算繪。

```
session/* 事件流
   ├─ step/start            → 記錄本次請求的發起時刻
   ├─ assistant/attempt     → 串流上報的 usage（隨後會被同一請求的 message 覆蓋）
   ├─ assistant/message     → 該請求的最終 usage，依發起時刻歸入 idle / peak
   └─ llm/retry-started     → 關閉覆蓋槽，重試算作第二次請求
        ↓
   sessionCost 投影 → { idle: {…}, peak: {…}, peakWindows }
        ↓
   膠囊 + 明細對話框
```

### 計價口徑

- **一次請求 = 一次模型呼叫**，時段取 `step/start` 的 `time`（請求發起時刻，不是完成時刻）
- 同一步驟先到的 `assistant/attempt` 用量會被該步驟的 `assistant/message` **覆蓋**，不會重複計算
- `llm/retry-started` 之後的重試是另一次計費請求，單獨累加
- 沒有 provider usage 的請求（被取消且未上報）不計入
- 金額 = Σ(桶 token 數 × 該桶單價) ÷ 1,000,000

此摺疊與官方 `tokenUsage` 同口徑，因此兩段合計應與 `tokenUsage` 合計逐項相等（見「已驗證」）。

### 時段判定

時區固定為 `UTC+8`（`utcOffsetMinutes: 480`，中國無日光節約時間）：

| 時間 | 級距 |
| --- | --- |
| 工作日 09:00–12:00 | 尖峰 |
| 工作日 12:00–14:00 | 離峰 |
| 工作日 14:00–18:00 | 尖峰 |
| 工作日 18:00–次日 09:00 | 離峰 |
| 週六、週日（除非是補班日） | 離峰 |
| 國定假日 | 離峰 |

`workdays`（補班日）優先於 `holidays` 與週末：落在週六的補班日，在工作時段內仍按尖峰計。

## 安裝

前置：可用的 DSH（Desktop 或以 profile 啟動的 `dsh`）。外掛依 profile 安裝，對該 profile 下所有工作階段生效。宣告的相容範圍是 `@deepseek-ai/dsh` `^0.2.1-rc.2`，實測於 `0.2.1-rc.3`；0.1.x 的用戶端 slot / 投影 API 與 0.2 不同，未經測試。

### 方式一：npm 安裝（發布後可用）

```bash
dsh plugin add dsh-session-tariff
```

### 方式二：請 DSH 助理從原始碼安裝（目前推薦）

在任一 DSH 工作階段裡對它說：

> 把這個外掛裝到目前的 profile：`https://github.com/xuanyuanli/dsh-session-tariff`，clone 到本機後用 `plugin_manager install_bundle` 安裝那個目錄。

### 方式三：手動 clone 後安裝

```bash
git clone https://github.com/xuanyuanli/dsh-session-tariff.git
```

接著在 DSH 裡請助理對該目錄執行 `plugin_manager` 的 `install_bundle`（給絕對路徑），或在外掛頁安裝本機目錄。

安裝後：

- **用戶端半**（膠囊與對話框）重新整理頁面即可生效（必要時 `Ctrl+Shift+R`）
- **宿主半**（`sessionCost` 投影）在 DSH 行程內註冊；升級宿主程式碼後需重新啟動 DSH 才會載入新模組

移除：請助理執行 `plugin_manager remove_bundle dsh-session-tariff`（用 npm 裝的則是 `dsh plugin remove dsh-session-tariff`）。

## 設定

### 單價（用戶端）

預設值在 [client.js](client.js) 頂端：

```js
const DEFAULT_PRICING = {
  currency: '¥',
  idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
}
```

單位是**貨幣單位 / 百萬 tokens**。也可以在 bundle 列上用 `config.pricing` 覆蓋（可只覆蓋部分欄位）：

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

> **費率來源。** 上面這組數字取自 DeepSeek 官方《[模型 & 價格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)》頁（2026-10 核對）的 `deepseek-flash` 級距：離峰 0.02 / 1 / 4，尖峰 0.04 / 2 / 8，尖峰正好是離峰的兩倍。三個注意點：
>
> - `cacheWrite` 預設採**未命中價**：DeepSeek 沒有獨立的快取寫入價（寫入的 token 落在未快取桶裡），對會另外上報寫入量的 provider 來說，按未命中價計也最接近帳單。工作階段中 `cacheWriteTokens` 恆為 0 時，這一項自然是 0。
> - 若工作階段跑在 `deepseek-v4-pro`，把 idle 改成 `0.15 / 4.5 / 13.5`、peak 改成 `0.30 / 9 / 27`，否則會少報約 3–7 倍。
> - 費率會變動，且不是即時從 API 取得，改價後請自行更新這裡或 `config.pricing`。

### 時段規則（宿主）

預設值在 [host.js](host.js) 的 `DEFAULT_RULES`：

```js
{
  utcOffsetMinutes: 480,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  holidays: [],   // 'YYYY-MM-DD'
  workdays: []    // 'YYYY-MM-DD'，補班日
}
```

同樣的欄位也可以寫在 bundle 列的 `config` 上（見 [cordis.patch.yml](cordis.patch.yml) 的註解）。**國定假日表預設是空的**：不填時，假日會被當成一般工作日、只在 `peakWindows` 內按尖峰計；要精確請依當年官方行事曆補上 `holidays` / `workdays`。

## 已驗證

- 摺疊單元測試（[test/fold.test.mjs](test/fold.test.mjs)，無依賴）：

  ```bash
  node test/fold.test.mjs
  ```

  涵蓋：`09:00` / `12:00` / `14:00` / `18:00` 邊界、週末、國定假日、補班日、`assistant/attempt` 被 `message` 覆蓋、重試雙計、無關事件保持狀態參照、檢查點狀態還原、wire 視圖形狀。

- 執行時對帳：某個 `deepseek-flash` 工作階段（144 次請求）的 `sessionCost` 兩段合計與同工作階段的 `tokenUsage` 合計**逐項相等**——快取讀取 17,137,024 / 未快取輸入 131,962 / 輸出 87,763——代表既沒有重複計費也沒有漏計。

- 費率核對：2026-10 對照官方[《模型 & 價格》](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)，`deepseek-flash` 離峰 0.02 / 1 / 4、尖峰 0.04 / 2 / 8 與預設值逐項一致；尖峰為工作日 09:00-12:00 / 14:00-18:00，其餘含週末與國定假日全天按離峰計，也與官方註腳一致。

- 視覺部分（膠囊位置、對話框排版）在 DSH 桌面版人工確認；本專案沒有瀏覽器自動化測試。

> 註：目前外掛介面只有簡中與英文兩套字典，繁體中文介面會退回英文。

## 已知限制

- 費率是 `deepseek-flash` 的單一靜態級距：`deepseek-v4-pro` 需自行覆蓋 `config.pricing`（見「單價」）
- 國定假日 / 補班表需要自己維護，預設空表；週末本身已按離峰處理
- 時段歸屬依請求**發起**時刻；跨越 12:00 或 18:00 的長請求整體計入發起時段的價
- 只統計 provider 有上報 usage 的請求；被中斷且無 usage 的請求不計
- 明細列金額四捨五入到 3 位，與時段合計可能差 ±0.001
- 僅適用於 DSH Web GUI 的 `conversation.composer.dock` 位置；宿主投影鍵名 `sessionCost` 為全域唯一，若與其他外掛衝突會註冊失敗

## 相容性

| 項目 | 值 |
| --- | --- |
| 宣告範圍 | `@deepseek-ai/dsh` `^0.2.1-rc.2`（`package.json` 的 `peerDependencies`） |
| 實測版本 | `0.2.1-rc.3`（DSH 桌面版） |
| 依賴面 | 無執行時依賴：宿主半只用 `sessionProjections` 服務，用戶端半只從模組表取 `react` / `react-dom` |
| 宿主鍵名 | cordis 外掛 `session-tariff`，投影 `sessionCost` |

## 目錄結構

```
dsh-session-tariff/
├── package.json           # bundle 清單：dsh.bundle.patch + dsh.client（Web 用戶端半）
├── cordis.patch.yml       # 插入 session-tariff 這一列（含設定範例）
├── host.js                # 宿主半：註冊 sessionCost 工作階段投影（摺疊 + 時段歸類）
├── client.js              # 用戶端半：狀態列膠囊與明細對話框（React，無需建置）
├── locale/{zh,en}.json    # 外掛頁顯示的標題與說明
├── icon.svg               # 外掛圖示（原創）
└── test/fold.test.mjs     # 摺疊邏輯單元測試
```

用戶端半是 `window.__ModuleLoader__.load({ id, factory })` 形式的無建置模組，只從 DSH 模組表取 `react` / `react-dom`，樣式用 DSH 主題權杖（`--dsw-alias-*`），不依賴任何 Harness 用戶端套件。

## 開發

```bash
# 語法檢查
node --check host.js
node --check client.js

# 摺疊邏輯測試（不依賴 DSH、不依賴任何套件）
node test/fold.test.mjs
```

改完宿主半後要重新安裝並重新啟動 DSH 才會載入新模組；只改用戶端半重新整理頁面即可。

## 授權

[MIT](LICENSE)
