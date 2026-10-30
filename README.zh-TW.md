# dsh-session-tariff

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **繁體中文**

在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的輸入框狀態列加一顆「本次工作階段花費」膠囊：按**每筆請求所屬 provider** 的**尖峰 / 離峰**兩段費率分別計價——`deepseek-account`（DeepSeek 官方）與 `bailian` / `bailian-chat`（阿里雲百煉）內建價目表，也可以用 `config.providers` 逐 provider 覆寫——點開可看到每個時段、每個模型的快取讀取、未快取輸入、快取寫入、輸出各自的 token 數與金額。

> A DSH plugin that shows the estimated monetary cost of the current session beside the composer status pills, priced per provider with built-in DeepSeek official and Alibaba Cloud Bailian price books (and `config.providers` overrides). Click the pill for a per-provider, per-model, per-period token and amount breakdown.

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
- 工作階段跨多個 provider 時，明細列會在時段標籤前多一個 provider 小標籤，底部單價與時段規則也依 provider 分組；只有一個 provider 時與上面完全一致

## 功能

- 膠囊統計的是整個工作階段紀錄（不是目前視窗），口徑與旁邊的 token 統計一致
- 依 provider 計價：`deepseek-account`（DeepSeek 官方）與 `bailian` / `bailian-chat`（阿里雲百煉）內建價目表與時段規則，開箱即用；也可以用 `config.providers` 逐 provider 覆寫
- 依時段分組：某個時段沒用過就不顯示那一列
- 每個時段列出請求次數，以及四個用量桶的 token 數與分攤金額
- 底部註明目前生效的兩段單價與尖峰時段規則
- 同一個工作階段跨多個 provider 時依 provider 分帳：明細列帶 provider 標籤，底部說明依 provider 分組列出各自的單價與時段規則
- 跟隨 DSH 主題權杖與語言（zh / en）；桌面與窄螢幕都不會換行錯位
- 支援鍵盤：`Esc` 關閉，點擊面板外關閉

## 運作原理

### 為什麼需要宿主端的投影

DSH 內建的 `tokenUsage` 投影只提供整體聚合桶，**沒有時間維度**，因此無法回答「這 1800 萬 token 分別發生在哪些時段」。本外掛在宿主端註冊一個工作階段投影 `sessionCost`（[host.js](host.js)），逐事件摺疊每次模型請求：依 `request/context` 與 `message.source` 解析出 provider / 模型，再依該 provider 的價目表與請求發起時刻計價，輸出「provider × 模型 × 時段」帳本；用戶端（[client.js](client.js)）只負責取數、套單價、算繪。

```
session/* 事件流
   ├─ request/context       → 路由變更（首筆請求或切換 provider / 模型）時更新目前的 provider + model
   ├─ step/start            → 記錄本次請求的發起時刻
   ├─ assistant/attempt     → 串流上報的 usage（隨後會被同一請求的 message 覆蓋）
   ├─ assistant/message     → 該請求的最終 usage，依 message.source.provider / model 歸入
   │                          對應 provider 的價目表與該模型的獨立帳本，依發起時刻歸入 idle / peak
   └─ llm/retry-started     → 關閉覆蓋槽，重試算作第二次請求
        ↓
   sessionCost 投影 → { idle: {…}, peak: {…}, books: [{ provider, peakWindows, weekends, idle, peak, models }], models: [{ provider, model, idle, peak }] }
        ↓
   膠囊 + 明細對話框（依「provider × 模型 × 時段」分行，每行用該 provider 價目表裡該模型的單價）
```

### 計價口徑

- **一次請求 = 一次模型呼叫**，時段取 `step/start` 的 `time`（請求發起時刻，不是完成時刻）
- **provider 與模型歸屬**：以該請求 `assistant/message` 的 `message.source.provider` / `message.source.model` 為準；`assistant/attempt` 不帶 source，歸到最近一次 `request/context` 記下的目前路由。每個 provider 有獨立的價目表（時段規則 + 單價），跨 provider 時依 provider 分帳，總額口徑不變
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
- **宿主半**（`sessionCost` 投影）在 DSH 行程內註冊；從 1.1.0 升級時投影鍵名仍是 `sessionCost`，但宿主狀態形狀（`stateVersion: 2`）與計價邏輯都已改變，需要重新啟動 DSH 才能載入新模組；只改用戶端半時重新整理頁面即可

移除：請助理執行 `plugin_manager remove_bundle dsh-session-tariff`（用 npm 裝的則是 `dsh plugin remove dsh-session-tariff`）。

## 設定

### 單價（用戶端）

預設值在 [client.js](client.js) 頂端，它同時也是**沒有預設的 provider 的備援價目表**：

```js
const DEFAULT_PRICING = {
  currency: '¥',
  idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
}
```

單位是**貨幣單位 / 百萬 tokens**。`config.pricing` 仍可覆寫這份備援表（可只覆寫部分欄位），但它只對既沒有內建預設、也沒有 `config.providers` 條目的 provider 生效：

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

> **費率來源。** 上面這組數字取自 DeepSeek 官方《[模型 & 價格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)》頁（2026-10 核對）的 `deepseek-flash` 級距：離峰 0.02 / 1 / 4，尖峰 0.04 / 2 / 8，尖峰正好是離峰的兩倍；它既是備援預設值，也是內建 `deepseek-account` 預設的頂層費率。三個注意點：
>
> - `cacheWrite` 預設採**未命中價**：DeepSeek 沒有獨立的快取寫入價（寫入的 token 落在未快取桶裡），對會另外上報寫入量的 provider 來說，按未命中價計也最接近帳單。工作階段中 `cacheWriteTokens` 恆為 0 時，這一項自然是 0。
> - `deepseek-v4-pro` 的兩段費率（離峰 `0.15 / 4.5 / 4.5 / 13.5`、尖峰 `0.30 / 9 / 9 / 27`）已經包含在 `deepseek-account` 預設裡，不用再手動改；預設以外的模型在 `config.providers` 裡補。
> - 費率會變動，且不是即時從 API 取得，改價後請自行更新對應的 `config.providers.<provider>` 條目或備援 `config.pricing`。

### 依 provider 計價

同一個工作階段可能跑過多個 provider（切換 provider、切換模型、子代理），它們的價目表與時段規則並不相同。外掛依**每筆請求所屬的 provider** 選擇價目表，歸屬資訊從事件流取得：

- 每次路由變更（工作階段的第一筆請求，或切到別的 provider / 模型）宿主會追加一筆 `request/context`，帶上 `provider` 與 `model`；摺疊時用它記住目前路由
- 每筆 `assistant/message` 的 `message.source.provider` / `message.source.model` 是該次請求的**權威**歸屬
- `assistant/attempt` 本身不帶 source，歸到目前路由

內建預設涵蓋兩個常見的 provider：`deepseek-account`（DeepSeek 官方）與 `bailian` / `bailian-chat`（阿里雲百煉），開箱即用；`config.providers` 可以逐 provider 覆寫，也可以給沒有預設的 provider 補一份價目表。價目表的單位與前面一致：**貨幣單位 / 百萬 tokens**（兩套內建預設都是人民幣 `¥`），每組數字依「快取命中 / 未命中 / 寫入 / 輸出」的順序。

#### 內建預設：DeepSeek 官方

`deepseek-account` 採 DeepSeek 官方口徑：尖峰窗為工作日 09:00-12:00 / 14:00-18:00，週末與國定假日全天按離峰（`weekends: 'idle'`）。

| 模型 | 離峰（命中 / 未命中 / 寫入 / 輸出） | 尖峰（命中 / 未命中 / 寫入 / 輸出） |
| --- | --- | --- |
| `deepseek-flash`（預設） | 0.02 / 1 / 1 / 4 | 0.04 / 2 / 2 / 8 |
| `deepseek-v4-pro` | 0.15 / 4.5 / 4.5 / 13.5 | 0.30 / 9 / 9 / 27 |

#### 內建預設：阿里雲百煉（Bailian）

`bailian`（OpenAI-responses 端點）與 `bailian-chat`（OpenAI-completions 端點）是兩個 provider id，共用同一套百煉預設。百煉的口徑和 DeepSeek 有幾處根本不同（以 `deepseek-v4.1-flash-1017` 為例）：

| | DeepSeek 官方 | 百煉 |
|---|---|---|
| 離峰時段 | 沒有全域離峰帶，只有平日的高峰窗 | **UTC+8 22:00–翌日 08:00 為離峰，其餘全部尖峰** |
| 週末 | 全天按離峰計 | **沒有優惠，照常按尖峰** |
| 快取命中 | 0.02 / 0.04 | **0.1 / 0.2** |

外掛預設的 `peakWindows` 無法表達跨午夜的區間（`22:00-24:00` 這種寫法不生效），所以預設用**反向填寫**的方式實作：把白天寫成尖峰窗（`peakWindows: ['08:00-22:00']`），並讓週末也依時鐘判定（`weekends: 'clock'`）。這些都已經內建，**不需要再在 bundle 列上全域改 `peakWindows` / `weekends`**。

| 模型 | 離峰（命中 / 未命中 / 寫入 / 輸出） | 尖峰（命中 / 未命中 / 寫入 / 輸出） |
| --- | --- | --- |
| `deepseek-v4.1-flash-1017`（預設） | 0.1 / 1 / 1 / 4 | 0.2 / 2 / 2 / 8 |
| `qwen3.8-max` | 1.5 / 12 / 12 / 36 | 與離峰相同 |
| `ZHIPU/GLM-5.3-Flash` | 0.23 / 0.8 / 0.8 / 2.8 | 與離峰相同 |
| `ZHIPU/GLM-5.3` | 2 / 8 / 8 / 28 | 與離峰相同 |

#### `config.providers` 覆寫

`config.providers.<provider>` 的內容會**逐欄位合併**到該 provider 的預設之上（沒有預設時合併到備援價目表之上）：只寫要改的欄位即可，沒寫的規則欄位繼承預設（或備援規則），沒寫的費率欄位逐欄位繼承，`models` 表依 model id 逐行合併。`pricing.currency` / `pricing.defaultModel` 同樣可以依 provider 寫。

```yaml
- insert:
    - id: session-tariff
      name: dsh-session-tariff
      config:
        providers:
          bailian:                          # 百煉：只寫要改的欄位，其餘繼承預設
            peakWindows: ['08:00-22:00']    # 22:00-08:00 之外按尖峰（與預設相同，改這裡即覆寫）
            weekends: clock                  # 週末不優惠，照常依時鐘判定（與預設相同）
            pricing:
              idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
              peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
          deepseek-account:                  # DeepSeek 官方：明確寫出預設規則與模型表
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

#### 依模型定價

每張價目表（內建預設、`config.providers.<provider>.pricing` 或備援 `config.pricing`）都可以帶 `models` 表，依 **model id 精確比對**；每一項可各自覆寫 `idle` / `peak`，沒列出的模型回落到該價目表最上層的 `idle` / `peak`。預設裡沒有的模型這樣補：

```yaml
- id: session-tariff
  name: dsh-session-tariff
  config:
    providers:
      deepseek-account:
        pricing:
          models:
            my-proxy-model:              # 預設裡沒有的模型，依這張表的費率計
              idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
              peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
```

model id 取自每筆 `assistant/message` 的 `message.source.model`，因此和 DSH 送給 provider 的 id 完全一致（像 `ZHIPU/GLM-5.3` 這種含斜線的名稱，在 YAML 裡加引號即可）。明細面板會依「provider × 模型 × 時段」分行，每行用該 provider 價目表裡該模型的費率結算；只有一個 provider 時不顯示 provider 標籤。

#### 優先順序

某筆請求的 provider 確定後，價目表依這個順序取：

1. `config.providers[provider]`：合併到該 provider 的預設（有預設時）或備援價目表（無預設時）之上
2. 該 provider 的內建預設
3. bundle 列 `config` 頂層的平鋪價目表 / 時段規則（備援）
4. 程式碼裡的 `DEFAULT_PRICING` / `DEFAULT_RULES`（DeepSeek 官方數字）

也就是說，平鋪的 `pricing` / `peakWindows` / `weekends` 只在 provider 既沒有預設、也沒有 `config.providers` 條目時才決定計價。

#### 從舊設定移轉

如果你以前在 bundle 列上為**已知 provider**（`deepseek-account`、`bailian`、`bailian-chat`）自訂過 `config.pricing` 或 `peakWindows` / `weekends` / `holidays` / `workdays`，請把整段移到 `config.providers.<provider>` 下的同名位置：欄位照搬，只是外面多包一層 provider id。平鋪欄位現在只給沒有預設的 provider 備援，不再影響已知 provider；原本「全域改 `peakWindows: ['08:00-22:00']` + `weekends: clock`」的百煉寫法會失效，表現為百煉請求回到預設的數字。

### 時段規則（宿主）

預設值在 [host.js](host.js) 的 `DEFAULT_RULES`，它是**沒有預設的 provider 的備援規則**：

```js
{
  utcOffsetMinutes: 480,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  holidays: [],    // 'YYYY-MM-DD'
  workdays: [],    // 'YYYY-MM-DD'，補班日
  weekends: 'idle' // 'idle'：週末整天離峰（DeepSeek）；'clock'：只看 peakWindows
}
```

同樣的欄位既可以寫在 bundle 列 `config` 頂層（備援規則），也可以寫在 `config.providers.<provider>` 下（只覆寫該 provider 的規則，見 [cordis.patch.yml](cordis.patch.yml) 的註解）。有預設的 provider 預設用預設規則：`deepseek-account` 是工作日 09:00-12:00 / 14:00-18:00 + `weekends: 'idle'`，`bailian` / `bailian-chat` 是 `peakWindows: ['08:00-22:00']` + `weekends: 'clock'`。

**國定假日表預設是空的**：不填時，假日會被當成一般工作日、只在 `peakWindows` 內按尖峰計；要精確請依當年官方行事曆補上 `holidays` / `workdays`（寫在對應 provider 下，或寫進備援規則）。

`weekends` 決定**沒有列在 `workdays`** 的週六日怎麼算：`'idle'`（預設，DeepSeek 口徑：整天離峰）或 `'clock'`（不看星期幾，只看 `peakWindows`，百煉等按量計費的 provider 用這個，內建的百煉預設即 `'clock'`）。`holidays` 裡的日期在任一口徑下都按離峰計。

## 已驗證

- 摺疊單元測試（[test/fold.test.mjs](test/fold.test.mjs)，無依賴）：

  ```bash
  node test/fold.test.mjs
  ```

  涵蓋：`09:00` / `12:00` / `14:00` / `18:00` 邊界、週末、國定假日、補班日、`assistant/attempt` 被 `message` 覆蓋、重試雙計、無關事件保持狀態參照、檢查點狀態還原、wire 視圖形狀、`weekends: 'clock'` 口徑與依模型歸集（同一模型的一次 `attempt` + `message` 只記一次請求，兩個模型各自成列、各段合計回到總量），以及依 provider 選擇價目表：`deepseek-account` 與 `bailian` 的請求各用各的預設、`config.providers` 的逐欄位合併、同一工作階段裡兩個 provider 分開計帳，還有「舊的全域百煉設定不再給 DeepSeek 官方工作階段計價」的回歸案例。

- 執行時對帳：某個 `deepseek-flash` 工作階段（144 次請求）的 `sessionCost` 兩段合計與同工作階段的 `tokenUsage` 合計**逐項相等**——快取讀取 17,137,024 / 未快取輸入 131,962 / 輸出 87,763——代表既沒有重複計費也沒有漏計。

- 費率核對：2026-10 對照官方[《模型 & 價格》](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)，`deepseek-flash` 離峰 0.02 / 1 / 4、尖峰 0.04 / 2 / 8 與 `deepseek-account` 預設逐項一致；`deepseek-v4-pro` 的 0.15 / 4.5 / 4.5 / 13.5 與 0.30 / 9 / 9 / 27 也依官方價目寫進預設。`bailian` 預設採百煉的按量計費口徑：22:00-08:00 離峰、週末不優惠、快取命中 0.1 / 0.2。

- 視覺部分（膠囊位置、對話框排版）在 DSH 桌面版人工確認；本專案沒有瀏覽器自動化測試。

> 註：目前外掛介面只有簡中與英文兩套字典，繁體中文介面會退回英文。

## 已知限制

- 費率是靜態值：內建預設只涵蓋 `deepseek-account`、`bailian` / `bailian-chat` 三個 provider id（兩套預設）和上面列出的模型；其他 provider / 模型按備援價目表計，或自己補 `config.providers.<provider>.pricing`（見「依模型定價」），未列出的模型回落到該價目表最上層費率；改價後需手動更新
- provider 歸屬取自 `message.source.provider`（缺失時用最近一次 `request/context` 的路由）；兩者都沒有的舊日誌整段按備援價目表計
- 模型歸屬取自 `message.source.model`；取不到時（舊日誌，或宿主尚未發布分模型列）整段算在 `defaultModel` 那一列
- `peakWindows` 無法表達跨午夜的區間（如 `22:00-24:00`）；百煉這類「夜間離峰」由內建預設用 `08:00-22:00` 反向填寫實作，自訂 provider 也要同樣處理（見「內建預設：阿里雲百煉」）
- 國定假日 / 補班表需要自己維護，預設空表；週末預設按離峰處理（`weekends: 'idle'`），百煉預設則是 `'clock'`
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
├── host.js                # 宿主半：註冊 sessionCost 工作階段投影（摺疊 + provider 價目表 + 時段歸類）
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
