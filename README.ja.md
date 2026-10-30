# dsh-session-tariff

[简体中文](README.md) · [English](README.en.md) · **日本語** · [繁體中文](README.zh-TW.md)

[DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) の Web GUI、コンポーザー下のステータスバーに「今回のセッションの推定コスト」を表示するピルを追加します。DeepSeek の**ピーク / アイドル**という 2 段階の料金でそれぞれ計算し、クリックすると時間帯ごとのキャッシュ読み取り・未キャッシュ入力・キャッシュ書き込み・出力のトークン数と金額の内訳が開きます。

> A DSH plugin that shows the estimated monetary cost of the current session beside the composer status pills, split by DeepSeek peak/idle tariff periods. Click the pill for a per-period, per-bucket token and amount breakdown.

## 表示イメージ

ピルは既存の統計のあと、コンテキスト使用率のリングの前に並びます。

```
 ⌁ 3 turns 102 steps · 251 tok/s     ⛁ 18.2M tok · 99% cached     ⊙ ≈¥1.72     ◔ 19%
```

クリックすると：

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

- `≈` は、トークン数と単価から計算した**推計値**であることを示します（請求額そのものではありません）
- トークン列は `K` / `M` で短縮表示し、ホバーで完全な桁区切り（`18,234,567`）が見えます
- 内訳の各行は小数 3 桁で四捨五入するため、時間帯の合計と ±0.001 ずれることがあります

## 機能

- ピルは現在のウィンドウではなくセッションログ全体を集計し、隣のトークン統計と同じ範囲を扱います
- 時間帯ごとにグループ化し、使われていない時間帯は表示しません
- 各時間帯について、リクエスト数と 4 つのバケットのトークン数・按分金額を出します
- フッターに、現在有効な 2 段階の単価とピーク時間のルールを明記します
- DSH のテーマトークンと言語（zh / en）に追従し、狭い画面でも折り返しやズレが起きません
- キーボード対応：`Esc` で閉じる、パネル外のクリックで閉じる

## 仕組み

### ホスト側のプロジェクションが必要な理由

DSH 標準の `tokenUsage` プロジェクションは全量の集計バケットしか持たず、**時間軸がありません**。そのため「この 1800 万トークンがいつ発生したか」は答えられません。本プラグインはホスト側にセッション・プロジェクション `sessionCost`（[host.js](host.js)）を登録し、モデル呼び出しごとにイベントを畳み込んで、リクエストの**開始時刻**でピーク / アイドルに振り分けます。クライアント（[client.js](client.js)）は取得・単価適用・描画だけを担当します。

```
session/* イベントストリーム
   ├─ step/start            → このリクエストの開始時刻を記録
   ├─ assistant/attempt     → ストリーミング中の usage（同じリクエストの message で上書きされる）
   ├─ assistant/message     → 確定した usage。開始時刻に応じて idle / peak に計上し、
   │                          そのうえで message.source.model ごとの台帳にも計上
   └─ llm/retry-started     → 上書きスロットを閉じ、リトライは 2 回目のリクエストとして加算
        ↓
   sessionCost プロジェクション → { idle: {…}, peak: {…}, peakWindows, models: [{ model, idle, peak }] }
        ↓
   ピル + 内訳ダイアログ（「モデル × 時間帯」ごとに 1 行、それぞれ自モデルの単価で計算）
```

### 課金の考え方

- **1 リクエスト = 1 回のモデル呼び出し**。時間帯は `step/start` の `time`（呼び出した時刻であり、完了時刻ではない）で決まります
- 同じステップで先に届いた `assistant/attempt` の usage は、そのステップの `assistant/message` で**上書き**され、二重計上されません
- `llm/retry-started` 後のリトライは別の課金リクエストとして個別に加算します
- provider の usage がないリクエスト（キャンセルされ未報告）は計上しません
- 金額 = Σ(バケットのトークン数 × そのバケットの単価) ÷ 1,000,000

この畳み込みは公式の `tokenUsage` と同じ口径なので、2 つの時間帯の合計は `tokenUsage` の合計とバケット単位で一致するはずです（「検証済み」を参照）。

### 時間帯の判定

タイムゾーンは `UTC+8` 固定です（`utcOffsetMinutes: 480`、中国にサマータイムはありません）。

| 時刻 | 区分 |
| --- | --- |
| 平日 09:00–12:00 | ピーク |
| 平日 12:00–14:00 | アイドル |
| 平日 14:00–18:00 | ピーク |
| 平日 18:00–翌 09:00 | アイドル |
| 土曜・日曜（振替出勤日を除く） | アイドル |
| 法定休日 | アイドル |

`workdays`（振替出勤日）は `holidays` と週末より優先されます。土曜に設定された振替出勤日は、勤務時間内ならピークとして計算されます。

## インストール

前提：動作する DSH（Desktop、または profile 付きで起動した `dsh`）。プラグインは profile 単位で入り、その profile の全セッションに適用されます。宣言している対応範囲は `@deepseek-ai/dsh` `^0.2.1-rc.2`、実測は `0.2.1-rc.3` です。0.1.x はクライアント slot / プロジェクション API が 0.2 と異なり、未検証です。

### 方法 1：npm から（公開後）

```bash
dsh plugin add dsh-session-tariff
```

### 方法 2：DSH エージェントにソースから入れてもらう（現在のおすすめ）

任意の DSH セッションでこう伝えます。

> このプラグインを現在の profile に入れて：`https://github.com/xuanyuanli/dsh-session-tariff` を clone し、そのディレクトリに対して `plugin_manager install_bundle` を実行して。

### 方法 3：手動で clone してインストール

```bash
git clone https://github.com/xuanyuanli/dsh-session-tariff.git
```

そのあと DSH のエージェントに `plugin_manager` の `install_bundle`（絶対パス）を実行させるか、プラグインページからローカルディレクトリをインストールします。

インストール後：

- **クライアント側**（ピルとダイアログ）はページを再読み込みすれば反映されます（必要なら `Ctrl+Shift+R`）
- **ホスト側**（`sessionCost` プロジェクション）は DSH プロセス内に登録されるため、ホスト側コードを更新したときは DSH の再起動が必要です

アンインストール：`plugin_manager remove_bundle dsh-session-tariff`（npm で入れた場合は `dsh plugin remove dsh-session-tariff`）。

## 設定

### 単価（クライアント）

既定値は [client.js](client.js) の先頭にあります。

```js
const DEFAULT_PRICING = {
  currency: '¥',
  idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
}
```

単位は**通貨単位 / 100 万トークン**です。バンドル行の `config.pricing` で一部だけ上書きもできます。

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

> **単価の出典。** 上の数値は DeepSeek 公式の「[モデル & 価格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)」（2026-10 時点で確認）の `deepseek-flash` の欄です：アイドル 0.02 / 1 / 4、ピーク 0.04 / 2 / 8 で、ピークはちょうどアイドルの 2 倍です。注意点が 3 つあります。
>
> - `cacheWrite` は既定で**ミス単価**を使います。DeepSeek にキャッシュ書き込み専用の価格はなく（書き込みトークンは未キャッシュのバケットに入ります）、書き込みを別途報告する provider でもミス単価が請求額に最も近くなります。セッションで `cacheWriteTokens` が常に 0 なら、この項も 0 になります。
> - `deepseek-v4-pro` のセッションでは、idle を `0.15 / 4.5 / 13.5`、peak を `0.30 / 9 / 27` に変えてください。そのままだと 3〜7 倍ほど低く見積もります。
> - 価格は変わります。API からリアルタイムに取っているわけではないので、改定されたらこの定数か `config.pricing` を更新してください。

#### モデルごとの単価

1 つのセッションで複数のモデルを走らせることがあり（複数 provider、モデル切り替え、サブエージェント）、単価はそれぞれ違うのが普通です。`pricing.models` の下に **モデル id 完全一致**の表を作り、各項目で `idle` / `peak` を個別に上書きできます。表にないモデルは最上位の `idle` / `peak` にフォールバックします。

```yaml
- id: session-tariff
  name: dsh-session-tariff
  config:
    pricing:
      currency: '¥'
      defaultModel: deepseek-v4.1-flash-1017   # モデル id が取れないときの表示名
      idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
      peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
      models:
        deepseek-v4.1-flash-1017:
          idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
          peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
        qwen3.8-max:
          idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
          peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
```

モデル id は各 `assistant/message` の `message.source.model` から取るので、DSH が provider に送っている id と完全に一致します（`ZHIPU/GLM-5.3` のようにスラッシュを含む名前は YAML で引用符で囲んでください）。内訳ダイアログは「モデル × 時間帯」ごとに 1 行になり、それぞれ自モデルの単価で計算されます。

#### 例：Alibaba Cloud Bailian（百炼）

Bailian は DeepSeek と根本的に 2 点違います（以下は `deepseek-v4.1-flash-1017` の例）。

| | DeepSeek 公式 | Bailian |
|---|---|---|
| アイドル時間帯 | 全体のアイドル帯はなく、平日のピーク窓のみ | **UTC+8 の 22:00〜翌 08:00 がアイドル、それ以外はすべてピーク** |
| 週末 | 終日アイドル | **割引なし、通常どおりピーク** |
| キャッシュヒット | 0.02 / 0.04 | **0.1 / 0.2** |

プラグインの `peakWindows` は日付をまたぐ区間を表現できない（`22:00-24:00` のような書き方は効きません）ため、**逆に埋めます**。昼間をピーク窓として書き、週末も時計どおりに判定させます。

```yaml
- id: session-tariff
  name: dsh-session-tariff
  config:
    utcOffsetMinutes: 480
    peakWindows: ['08:00-22:00']   # Bailian：22:00〜08:00 の外はすべてピーク
    weekends: clock                 # 週末は終日アイドルではなく時計どおり
    holidays: []
    workdays: []
    pricing:
      currency: '¥'
      defaultModel: deepseek-v4.1-flash-1017
      idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
      peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
```

> 価格を変えるときは 3 か所を一緒に直します：最上位の `idle` / `peak` と、`models` 内の該当モデルの項目です。

### 時間帯ルール（ホスト）

既定値は [host.js](host.js) の `DEFAULT_RULES` にあります。

```js
{
  utcOffsetMinutes: 480,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  holidays: [],    // 'YYYY-MM-DD'
  workdays: [],    // 'YYYY-MM-DD'、振替出勤日
  weekends: 'idle' // 'idle'：週末は終日アイドル（DeepSeek）、'clock'：peakWindows だけを見る
}
```

同じフィールドはバンドル行の `config` にも書けます（[cordis.patch.yml](cordis.patch.yml) のコメント参照）。**法定休日の表は既定で空**です。空のままだと休日は通常の平日として扱われ、`peakWindows` の中ではピークとして計算されます。正確にしたい場合は、その年の公式カレンダーに合わせて `holidays` / `workdays` を埋めてください。

`weekends` は、`workdays` に**載っていない**土日の扱いを決めます。`'idle'`（既定、DeepSeek の口径：終日アイドル）か `'clock'`（曜日を無視して `peakWindows` だけを見る。Bailian など従量課金の provider はこちら）。`holidays` に入れた日付はどちらの口径でもアイドルになります。

## 検証済み

- 畳み込みのユニットテスト（[test/fold.test.mjs](test/fold.test.mjs)、依存なし）：

  ```bash
  node test/fold.test.mjs
  ```

  対象：`09:00` / `12:00` / `14:00` / `18:00` の境界、週末、法定休日、振替出勤日、`assistant/attempt` が `message` で上書きされること、リトライの二重計上、無関係なイベントで状態の参照が保たれること、チェックポイントからの復元、wire ビューの形、加えて `weekends: 'clock'` の口径とモデル別の計上（同じモデルの `attempt` + `message` が 1 リクエストとして数えられ、2 つのモデルが別々の行になり、行の合計が総量に戻ること）。

- 実行時の突き合わせ：ある `deepseek-flash` セッション（144 リクエスト）で、`sessionCost` の 2 つの時間帯の合計が同じセッションの `tokenUsage` 合計と**バケット単位で一致**しました — キャッシュ読み取り 17,137,024 / 未キャッシュ入力 131,962 / 出力 87,763。二重計上も取りこぼしもありません。

- 単価の確認：2026-10 に公式の「[モデル & 価格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)」と照合し、`deepseek-flash` のアイドル 0.02 / 1 / 4、ピーク 0.04 / 2 / 8 が既定値とバケット単位で一致。ピークは平日 09:00-12:00 / 14:00-18:00、それ以外（週末と法定休日を含む）はアイドル、という脚注とも一致しています。

- 見た目（ピルの位置、ダイアログのレイアウト）は DSH Desktop で目視確認しました。ブラウザ自動テストはありません。

## 既知の制限

- 単価は静的な値です。既定は `deepseek-flash` の 1 段階分で、他のモデル（`deepseek-v4-pro` を含む）は `config.pricing.models` で上書きしてください（「モデルごとの単価」参照）。表にないモデルは最上位の単価にフォールバックします
- モデルの帰属は `message.source.model` から取ります。取れない場合（古いログ、またはホストがモデル別の行をまだ公開していない場合）は全体が `defaultModel` の行になります
- `peakWindows` は日付をまたぐ区間（`22:00-24:00` など）を表現できません。Bailian のような「夜間アイドル」は昼間をピーク窓として逆に埋めてください（「例：Alibaba Cloud Bailian」参照）
- 法定休日 / 振替出勤日の表は自分で保守する必要があり、既定は空です（週末は既定でアイドル扱い、`weekends: 'idle'`）
- 時間帯はリクエストの**開始**時刻で決まります。12:00 や 18:00 をまたぐ長いリクエストは、開始時の区分で全体が計算されます
- provider が usage を報告したリクエストだけを数えます。中断されて usage がないリクエストは対象外です
- 内訳の金額は小数 3 桁で丸めるため、時間帯の合計と ±0.001 ずれることがあります
- DSH Web GUI の `conversation.composer.dock` スロット専用です。ホスト側のプロジェクションキー `sessionCost` はグローバルに一意で、他のプラグインと衝突すると登録に失敗します

## 互換性

| 項目 | 値 |
| --- | --- |
| 宣言範囲 | `@deepseek-ai/dsh` `^0.2.1-rc.2`（`package.json` の `peerDependencies`） |
| 実測バージョン | `0.2.1-rc.3`（DSH Desktop） |
| 依存の範囲 | 実行時依存なし：ホスト側は `sessionProjections` サービスのみ、クライアント側はモジュールテーブルから `react` / `react-dom` を取るだけ |
| ホスト側キー | cordis プラグイン `session-tariff`、プロジェクション `sessionCost` |

## ディレクトリ構成

```
dsh-session-tariff/
├── package.json           # バンドル定義：dsh.bundle.patch + dsh.client（Web クライアント側）
├── cordis.patch.yml       # session-tariff の行を挿入（設定例つき）
├── host.js                # ホスト側：sessionCost プロジェクション（畳み込み + 時間帯分類）
├── client.js              # クライアント側：ステータスバーのピルと内訳ダイアログ（React、ビルド不要）
├── locale/{zh,en}.json    # プラグインページに出すタイトルと説明
├── icon.svg               # プラグインアイコン（自作）
└── test/fold.test.mjs     # 畳み込みロジックのユニットテスト
```

クライアント側はビルド不要の `window.__ModuleLoader__.load({ id, factory })` 形式のモジュールです。`react` / `react-dom` は DSH のモジュールテーブルからのみ取得し、スタイルは DSH のテーマトークン（`--dsw-alias-*`）を使うので、Harness のクライアントパッケージには依存しません。

## 開発

```bash
# 構文チェック
node --check host.js
node --check client.js

# 畳み込みテスト（DSH もパッケージも不要）
node test/fold.test.mjs
```

ホスト側を変更したら、再インストールして DSH を再起動しないと新しいモジュールは読み込まれません。クライアント側だけならページの再読み込みで済みます。

## ライセンス

[MIT](LICENSE)
