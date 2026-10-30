# dsh-session-tariff

[简体中文](README.md) · [English](README.en.md) · **日本語** · [繁體中文](README.zh-TW.md)

[DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) の Web GUI、コンポーザー下のステータスバーに「今回のセッションの推定コスト」を表示するピルを追加します。**各リクエストが属する provider** の**ピーク / アイドル** 2 段階の料金で計算し（`deepseek-account`（DeepSeek 公式）と `bailian` / `bailian-chat`（Alibaba Cloud Bailian）の料金表を内蔵、`config.providers` で provider ごとに上書き可能）、クリックすると時間帯・モデルごとのキャッシュ読み取り・未キャッシュ入力・キャッシュ書き込み・出力のトークン数と金額の内訳が開きます。

> A DSH plugin that shows the estimated monetary cost of the current session beside the composer status pills, priced per provider with built-in DeepSeek official and Alibaba Cloud Bailian price books (and `config.providers` overrides). Click the pill for a per-provider, per-model, per-period token and amount breakdown.

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
- セッションが複数の provider にまたがる場合、内訳の行は時間帯タグの前に provider の小さなタグが付き、フッターも provider ごとに単価と時間帯ルールを分けて表示します。provider が 1 つだけのときは上の表示とまったく同じです

## 機能

- ピルは現在のウィンドウではなくセッションログ全体を集計し、隣のトークン統計と同じ範囲を扱います
- provider ごとの料金：`deepseek-account`（DeepSeek 公式）と `bailian` / `bailian-chat`（Alibaba Cloud Bailian）の料金表と時間帯ルールを内蔵し、そのまま使えます。`config.providers` で provider ごとに上書きもできます
- 時間帯ごとにグループ化し、使われていない時間帯は表示しません
- 各時間帯について、リクエスト数と 4 つのバケットのトークン数・按分金額を出します
- フッターに、現在有効な 2 段階の単価とピーク時間のルールを明記します
- 複数 provider にまたがるセッションは provider ごとに計上し、内訳行に provider タグが付き、フッターも provider ごとに単価と時間帯ルールを分けて表示します
- DSH のテーマトークンと言語（zh / en）に追従し、狭い画面でも折り返しやズレが起きません
- キーボード対応：`Esc` で閉じる、パネル外のクリックで閉じる

## 仕組み

### ホスト側のプロジェクションが必要な理由

DSH 標準の `tokenUsage` プロジェクションは全量の集計バケットしか持たず、**時間軸がありません**。そのため「この 1800 万トークンがいつ発生したか」は答えられません。本プラグインはホスト側にセッション・プロジェクション `sessionCost`（[host.js](host.js)）を登録し、モデル呼び出しごとにイベントを畳み込みます。`request/context` と `message.source` から provider / モデルを特定し、その provider の料金表とリクエストの開始時刻で計算して「provider × モデル × 時間帯」の台帳を作ります。クライアント（[client.js](client.js)）は取得・単価適用・描画だけを担当します。

```
session/* イベントストリーム
   ├─ request/context       → ルート変更（最初のリクエスト、provider / モデルの切り替え）時に現在のルートを更新
   ├─ step/start            → このリクエストの開始時刻を記録
   ├─ assistant/attempt     → ストリーミング中の usage（同じリクエストの message で上書きされる）
   ├─ assistant/message     → 確定した usage。message.source.provider / model に従って、その provider の
   │                          料金表とモデル別台帳に計上し、開始時刻に応じて idle / peak に分類
   └─ llm/retry-started     → 上書きスロットを閉じ、リトライは 2 回目のリクエストとして加算
        ↓
   sessionCost プロジェクション → { idle: {…}, peak: {…}, books: [{ provider, peakWindows, weekends, idle, peak, models }], models: [{ provider, model, idle, peak }] }
        ↓
   ピル + 内訳ダイアログ（「provider × モデル × 時間帯」ごとに 1 行、その provider の料金表のモデル単価で計算）
```

### 課金の考え方

- **1 リクエスト = 1 回のモデル呼び出し**。時間帯は `step/start` の `time`（呼び出した時刻であり、完了時刻ではない）で決まります
- **provider とモデルの帰属**：そのリクエストの `assistant/message` の `message.source.provider` / `message.source.model` が正式な根拠です。`assistant/attempt` は source を持たないため、`request/context` が記録した現在のルートに帰属させます。provider ごとに独立した料金表（時間帯ルール + 単価）を持ち、複数 provider にまたがっても provider ごとに計上し、合計の口径は変わりません
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
- **ホスト側**（`sessionCost` プロジェクション）は DSH プロセス内に登録されます。1.1.0 からアップグレードする場合、プロジェクションキーは `sessionCost` のままですが、ホストの状態形状（`stateVersion: 2`）と料金計算ロジックが変わるため、新しいモジュールを読み込むには DSH の再起動が必要です。クライアント側だけの変更ならページの再読み込みで済みます

アンインストール：`plugin_manager remove_bundle dsh-session-tariff`（npm で入れた場合は `dsh plugin remove dsh-session-tariff`）。

## 設定

### 単価（クライアント）

既定値は [client.js](client.js) の先頭にあり、**プリセットを持たない provider のフォールバック料金表**も兼ねています。

```js
const DEFAULT_PRICING = {
  currency: '¥',
  idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
}
```

単位は**通貨単位 / 100 万トークン**です。`config.pricing` でこのフォールバック表を上書きできます（一部のフィールドだけでも可）が、適用されるのは**組み込みプリセットも `config.providers` の項目も持たない provider** だけです。

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

> **単価の出典。** 上の数値は DeepSeek 公式の「[モデル & 価格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)」（2026-10 時点で確認）の `deepseek-flash` の欄です：アイドル 0.02 / 1 / 4、ピーク 0.04 / 2 / 8 で、ピークはちょうどアイドルの 2 倍です。フォールバックの既定値であり、組み込み `deepseek-account` プリセットの最上位単価でもあります。注意点が 3 つあります。
>
> - `cacheWrite` は既定で**ミス単価**を使います。DeepSeek にキャッシュ書き込み専用の価格はなく（書き込みトークンは未キャッシュのバケットに入ります）、書き込みを別途報告する provider でもミス単価が請求額に最も近くなります。セッションで `cacheWriteTokens` が常に 0 なら、この項も 0 になります。
> - `deepseek-v4-pro` の 2 段階の単価（アイドル `0.15 / 4.5 / 4.5 / 13.5`、ピーク `0.30 / 9 / 9 / 27`）は `deepseek-account` プリセットに含まれているので、手で書き換える必要はありません。プリセットにないモデルは `config.providers` で追加してください。
> - 価格は変わります。API からリアルタイムに取っているわけではないので、改定されたら該当する `config.providers.<provider>` の項目かフォールバックの `config.pricing` を更新してください。

### provider ごとの料金

1 つのセッションで複数の provider をまたぐことがあり（provider の切り替え、モデルの切り替え、サブエージェント）、料金表も時間帯ルールもそれぞれ違います。プラグインは**各リクエストが属する provider** で料金表を選びます。帰属情報はイベントストリームから取ります。

- ルートが変わるたび（セッション最初のリクエスト、または別の provider / モデルへの切り替え）に、ホストは `request/context` を追記し、`provider` と `model` を載せます。畳み込みはこれで現在のルートを覚えます
- 各 `assistant/message` の `message.source.provider` / `message.source.model` が、そのリクエストの**正式な**帰属です
- `assistant/attempt` は source を持たないため、現在のルートに帰属させます

組み込みプリセットがよく使う 2 つの provider（`deepseek-account`（DeepSeek 公式）と `bailian` / `bailian-chat`（Alibaba Cloud Bailian））をカバーするので、そのまま使えます。`config.providers` で provider ごとに上書きでき、プリセットを持たない provider に料金表を与えることもできます。料金表の単位は上と同じ**通貨単位 / 100 万トークン**です（組み込みプリセットはどちらも人民元 `¥`）。各値は「ヒット / ミス / 書き込み / 出力」の順です。

#### 組み込みプリセット：DeepSeek 公式

`deepseek-account` は DeepSeek 公式の口径です。ピーク窓は平日 09:00-12:00 / 14:00-18:00、週末と法定休日は終日アイドル（`weekends: 'idle'`）です。

| モデル | アイドル（ヒット / ミス / 書き込み / 出力） | ピーク（ヒット / ミス / 書き込み / 出力） |
| --- | --- | --- |
| `deepseek-flash`（既定） | 0.02 / 1 / 1 / 4 | 0.04 / 2 / 2 / 8 |
| `deepseek-v4-pro` | 0.15 / 4.5 / 4.5 / 13.5 | 0.30 / 9 / 9 / 27 |

#### 組み込みプリセット：Alibaba Cloud Bailian（百炼）

`bailian`（OpenAI-responses エンドポイント）と `bailian-chat`（OpenAI-completions エンドポイント）は 2 つの provider id で、同じ百炼のプリセットを共有します。Bailian は DeepSeek と根本的にいくつかの点が違います（以下は `deepseek-v4.1-flash-1017` の例）。

| | DeepSeek 公式 | Bailian |
|---|---|---|
| アイドル時間帯 | 全体のアイドル帯はなく、平日のピーク窓のみ | **UTC+8 の 22:00〜翌 08:00 がアイドル、それ以外はすべてピーク** |
| 週末 | 終日アイドル | **割引なし、通常どおりピーク** |
| キャッシュヒット | 0.02 / 0.04 | **0.1 / 0.2** |

プラグイン既定の `peakWindows` は日付をまたぐ区間を表現できない（`22:00-24:00` のような書き方は効きません）ため、プリセットは**逆に埋める**形で実装しています。昼間をピーク窓（`peakWindows: ['08:00-22:00']`）として書き、週末も時計どおりに判定させます（`weekends: 'clock'`）。どちらも組み込み済みで、**バンドル行で `peakWindows` / `weekends` をグローバルに切り替える必要はもうありません**。

| モデル | アイドル（ヒット / ミス / 書き込み / 出力） | ピーク（ヒット / ミス / 書き込み / 出力） |
| --- | --- | --- |
| `deepseek-v4.1-flash-1017`（既定） | 0.1 / 1 / 1 / 4 | 0.2 / 2 / 2 / 8 |
| `qwen3.8-max` | 1.5 / 12 / 12 / 36 | アイドルと同じ |
| `ZHIPU/GLM-5.3-Flash` | 0.23 / 0.8 / 0.8 / 2.8 | アイドルと同じ |
| `ZHIPU/GLM-5.3` | 2 / 8 / 8 / 28 | アイドルと同じ |

#### `config.providers` による上書き

`config.providers.<provider>` の内容は、その provider のプリセット（プリセットがなければフォールバック料金表）の上に**フィールド単位でマージ**されます。変えたいフィールドだけ書けばよく、書かなかったルール項目はプリセット（またはフォールバックのルール）を継承し、書かなかった料率項目はフィールド単位で継承、`models` はモデル id ごとに行をマージします。`pricing.currency` / `pricing.defaultModel` も provider ごとに書けます。

```yaml
- insert:
    - id: session-tariff
      name: dsh-session-tariff
      config:
        providers:
          bailian:                          # Bailian：変えたいフィールドだけ書く（残りはプリセットを継承）
            peakWindows: ['08:00-22:00']    # 22:00-08:00 の外がピーク（プリセットと同じ。ここを変えれば上書き）
            weekends: clock                  # 週末割引なし、時計どおり（プリセットと同じ）
            pricing:
              idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
              peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
          deepseek-account:                  # DeepSeek 公式：既定のルールとモデル表を明示
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

#### モデルごとの単価

どの料金表（組み込みプリセット、`config.providers.<provider>.pricing`、フォールバックの `config.pricing`）にも `models` 表を持たせられ、**モデル id 完全一致**で引きます。各項目は `idle` / `peak` を個別に上書きでき、載っていないモデルはその料金表の最上位 `idle` / `peak` にフォールバックします。プリセットにないモデルは次のように追加します。

```yaml
- id: session-tariff
  name: dsh-session-tariff
  config:
    providers:
      deepseek-account:
        pricing:
          models:
            my-proxy-model:              # プリセットにないモデル。この表の単価で計算
              idle: { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1, output: 4 }
              peak: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
```

モデル id は各 `assistant/message` の `message.source.model` から取るので、DSH が provider に送っている id と完全に一致します（`ZHIPU/GLM-5.3` のようにスラッシュを含む名前は YAML で引用符で囲んでください）。内訳ダイアログは「provider × モデル × 時間帯」ごとに 1 行になり、その provider の料金表にあるモデル単価で計算します。provider が 1 つだけのときは provider タグを表示しません。

#### 優先順位

リクエストの provider が決まると、料金表は次の順で解決されます。

1. `config.providers[provider]`：その provider のプリセット（あれば）またはフォールバック料金表（なければ）の上にマージ
2. その provider の組み込みプリセット
3. バンドル行 `config` 最上位のフラットな料金表 / 時間帯ルール（フォールバック）
4. コード内の `DEFAULT_PRICING` / `DEFAULT_RULES`（DeepSeek 公式の数値）

つまり、フラットな `pricing` / `peakWindows` / `weekends` が効くのは、provider にプリセットも `config.providers` の項目もないときだけです。

#### 旧設定からの移行

これまでバンドル行で**既知の provider**（`deepseek-account`、`bailian`、`bailian-chat`）向けに `config.pricing` や `peakWindows` / `weekends` / `holidays` / `workdays` をカスタマイズしていた場合は、そのブロックを `config.providers.<provider>` の同じ位置へ移動してください。項目はそのままで、provider id の階層が 1 つ増えるだけです。フラットな項目はプリセットを持たない provider のフォールバックにだけ使われ、既知の provider には影響しなくなります。以前の「グローバルに `peakWindows: ['08:00-22:00']` + `weekends: clock` を設定する」Bailian の書き方は効かなくなり、Bailian のリクエストはプリセットの数値に戻ります。

### 時間帯ルール（ホスト）

既定値は [host.js](host.js) の `DEFAULT_RULES` で、**プリセットを持たない provider のフォールバックルール**です。

```js
{
  utcOffsetMinutes: 480,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  holidays: [],    // 'YYYY-MM-DD'
  workdays: [],    // 'YYYY-MM-DD'、振替出勤日
  weekends: 'idle' // 'idle'：週末は終日アイドル（DeepSeek）、'clock'：peakWindows だけを見る
}
```

同じフィールドはバンドル行 `config` の最上位（フォールバックルール）にも、`config.providers.<provider>` の下（その provider のルールだけ上書き。[cordis.patch.yml](cordis.patch.yml) のコメント参照）にも書けます。プリセットを持つ provider は既定でプリセットのルールを使います：`deepseek-account` は平日 09:00-12:00 / 14:00-18:00 + `weekends: 'idle'`、`bailian` / `bailian-chat` は `peakWindows: ['08:00-22:00']` + `weekends: 'clock'` です。

**法定休日の表は既定で空**です。空のままだと休日は通常の平日として扱われ、`peakWindows` の中ではピークとして計算されます。正確にしたい場合は、その年の公式カレンダーに合わせて `holidays` / `workdays` を埋めてください（provider の下、またはフォールバックルールに）。

`weekends` は、`workdays` に**載っていない**土日の扱いを決めます。`'idle'`（既定、DeepSeek の口径：終日アイドル）か `'clock'`（曜日を無視して `peakWindows` だけを見る。Bailian など従量課金の provider はこちらで、組み込みの Bailian プリセットも `'clock'`）。`holidays` に入れた日付はどちらの口径でもアイドルになります。

## 検証済み

- 畳み込みのユニットテスト（[test/fold.test.mjs](test/fold.test.mjs)、依存なし）：

  ```bash
  node test/fold.test.mjs
  ```

  対象：`09:00` / `12:00` / `14:00` / `18:00` の境界、週末、法定休日、振替出勤日、`assistant/attempt` が `message` で上書きされること、リトライの二重計上、無関係なイベントで状態の参照が保たれること、チェックポイントからの復元、wire ビューの形、`weekends: 'clock'` の口径とモデル別の計上（同じモデルの `attempt` + `message` が 1 リクエストとして数えられ、2 つのモデルが別々の行になり、行の合計が総量に戻ること）、加えて provider ごとの料金表の選択：`deepseek-account` と `bailian` のリクエストがそれぞれのプリセットで計算されること、`config.providers` がフィールド単位でマージされること、1 つのセッションで 2 つの provider を別々に計上すること、そして「古いグローバルな Bailian 設定が DeepSeek 公式セッションの料金に使われない」という回帰ケース。

- 実行時の突き合わせ：ある `deepseek-flash` セッション（144 リクエスト）で、`sessionCost` の 2 つの時間帯の合計が同じセッションの `tokenUsage` 合計と**バケット単位で一致**しました — キャッシュ読み取り 17,137,024 / 未キャッシュ入力 131,962 / 出力 87,763。二重計上も取りこぼしもありません。

- 単価の確認：2026-10 に公式の「[モデル & 価格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)」と照合し、`deepseek-flash` のアイドル 0.02 / 1 / 4、ピーク 0.04 / 2 / 8 が `deepseek-account` プリセットとバケット単位で一致。`deepseek-v4-pro` の 0.15 / 4.5 / 4.5 / 13.5 と 0.30 / 9 / 9 / 27 も同じページの単価をプリセットに反映しています。`bailian` プリセットは百炼の従量課金の口径（22:00-08:00 がアイドル、週末割引なし、キャッシュヒット 0.1 / 0.2）に従っています。

- 見た目（ピルの位置、ダイアログのレイアウト）は DSH Desktop で目視確認しました。ブラウザ自動テストはありません。

## 既知の制限

- 単価は静的な値です。組み込みプリセットは `deepseek-account`、`bailian` / `bailian-chat` の 3 つの provider id（2 つのプリセット）と上に挙げたモデルだけをカバーします。それ以外の provider / モデルはフォールバック料金表で計算されるか、`config.providers.<provider>.pricing` に追加してください（「モデルごとの単価」参照）。表にないモデルはその料金表の最上位単価にフォールバックします。改定時は手で更新が必要です
- provider の帰属は `message.source.provider` から取ります（なければ直近の `request/context` のルート）。どちらもない古いログはフォールバック料金表で計算します
- モデルの帰属は `message.source.model` から取ります。取れない場合（古いログ、またはホストがモデル別の行をまだ公開していない場合）は全体が `defaultModel` の行になります
- `peakWindows` は日付をまたぐ区間（`22:00-24:00` など）を表現できません。Bailian のような「夜間アイドル」は組み込みプリセットが `08:00-22:00` を逆に埋める形で実装しており、独自 provider でも同じ工夫が必要です（「組み込みプリセット：Alibaba Cloud Bailian（百炼）」参照）
- 法定休日 / 振替出勤日の表は自分で保守する必要があり、既定は空です（週末は既定でアイドル扱い、`weekends: 'idle'`。Bailian プリセットは `'clock'`）
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
├── host.js                # ホスト側：sessionCost プロジェクション（畳み込み + provider ごとの料金表 + 時間帯分類）
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
