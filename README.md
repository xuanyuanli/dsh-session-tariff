# dsh-session-tariff

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的输入框状态栏加一个「本会话花费」胶囊：按 DeepSeek 的**高峰 / 空闲**两档价分别计价，点开可看到每个时段的缓存读取、未缓存输入、缓存写入、输出各自的 token 数与金额。

> A DSH plugin that shows the estimated monetary cost of the current session beside the composer status pills, split by DeepSeek peak/idle tariff periods. Click the pill for a per-period, per-bucket token and amount breakdown.

## 效果

胶囊排在原有统计控件之后、上下文占用圆环之前：

```
 ⌁ 3 轮 102 步 · 251 tok/s     ⛁ 18.2M tok · 缓存命中 99%     ⊙ ≈¥1.72     ◔ 19%
```

点开胶囊：

```
本会话花费                                              ¥1.72
──────────────────────────────────────────────────────────
高峰时段   149 次请求                                   ¥1.72
  缓存读取        18.2M                                ¥0.729
  未缓存输入     133.0K                                ¥0.266
  输出            90.9K                                ¥0.727
──────────────────────────────────────────────────────────
空闲：命中 ¥0.02 · 未命中 ¥1 · 输出 ¥4 / 百万 tokens
高峰：命中 ¥0.04 · 未命中 ¥2 · 输出 ¥8 / 百万 tokens
高峰时段为工作日 09:00-12:00 / 14:00-18:00；其余时间含周末与法定节假日按空闲计
```

- 金额标 `≈`：这是按 token 用量和单价算出的**估算**，不是账单
- token 列用 `K` / `M` 缩写；鼠标悬停可看到完整千分位数（如 `18,234,567`）
- 三行金额各自四舍五入（3 位），相加可能与时段合计差 ±0.001

## 功能

- 胶囊显示本会话（整个日志，不是当前窗口）的估算花费，口径与旁边的 token 统计一致
- 按时段分组：只在某个时段用过量就只显示那一档
- 每个时段给出请求次数与四个用量桶的 token 数、分摊金额
- 底部注明当前生效的两档单价与时段规则
- 跟随 DSH 主题令牌与语言（中/英），桌面与窄屏都不换行错位
- 支持键盘：`Esc` 关闭，点击面板外关闭

## 工作原理

### 为什么需要宿主侧的投影

DSH 自带的 `tokenUsage` 投影只给全量聚合桶，**没有时间维度**，因此无法回答「这 1800 万 token 分别发生在哪些时段」。本插件在宿主侧注册一个会话投影 `sessionCost`（[host.js](host.js)），逐事件折叠每次模型请求，按请求发起时刻把它归入高峰或空闲，输出两档桶；客户端（[client.js](client.js)）只负责取数、套单价、渲染。

```
session/* 事件流
   ├─ step/start            → 记录本次请求的发起时刻
   ├─ assistant/attempt     → 流式上报的 usage（随后会被同一请求的 message 覆盖）
   ├─ assistant/message     → 该请求的最终 usage，按发起时刻归入 idle / peak
   └─ llm/retry-started     → 关闭覆盖槽，重试算作第二次请求
        ↓
   sessionCost 投影 → { idle: {…}, peak: {…}, peakWindows }
        ↓
   胶囊 + 明细对话框
```

### 计价口径

- **一次请求 = 一次模型调用**，归属时段取 `step/start` 事件的 `time`（请求发起时刻，不是完成时刻）
- 同一步骤内先到的 `assistant/attempt` 用量会被该步骤的 `assistant/message` **覆盖**，不会重复计
- `llm/retry-started` 后的重试是另一次计费请求，单独累加
- 没有 provider usage 的请求（被取消且未上报）不计入
- 金额 = Σ(桶 token × 该桶单价) ÷ 1,000,000

该折叠与官方 `tokenUsage` 单元同口径，因此两档合计应与 `tokenUsage` 合计逐项相等（见「已验证」）。

### 时段判定

时区固定为 `UTC+8`（`utcOffsetMinutes: 480`，中国无夏令时）：

| 时间 | 档位 |
| --- | --- |
| 工作日 09:00–12:00 | 高峰 |
| 工作日 12:00–14:00 | 空闲 |
| 工作日 14:00–18:00 | 高峰 |
| 工作日 18:00–次日 09:00 | 空闲 |
| 周六、周日（除非是调休上班日） | 空闲 |
| 法定节假日 | 空闲 |

`workdays`（调休上班日）优先于 `holidays` 与周末：一个落在周六的调休上班日，工作时段内仍按高峰计。

## 安装

前置：一个可用的 DSH（Desktop 或带 profile 启动的 `dsh`），插件按 profile 安装，对该 profile 下所有会话生效。声明的兼容范围是 `@deepseek-ai/dsh` `^0.2.1-rc.2`（实测于 `0.2.1-rc.3`）；更早的 0.1.x 没有 `sessionProjections` 服务，装不上也不用装。

### 方式一：npm 安装（发布后可用）

```bash
dsh plugin add dsh-session-tariff
```

### 方式二：让 DSH 助手从源码安装（推荐，当前可用）

在本仓库或任意 DSH 会话里对它说：

> 把这个插件装到当前 profile：`https://github.com/xuanyuanli/dsh-session-tariff`，克隆到本地后用 `plugin_manager install_bundle` 安装那个目录。

### 方式三：手动 clone 后安装

```bash
git clone https://github.com/xuanyuanli/dsh-session-tariff.git
```

然后在 DSH 里让助手对该目录执行 `plugin_manager` 的 `install_bundle`（目标为绝对路径），或在插件页安装本地目录。

安装后：

- **客户端半**（胶囊与对话框）刷新页面即可生效（必要时 `Ctrl+Shift+R`）
- **宿主半**（`sessionCost` 投影）在 DSH 进程内注册；从旧版本升级宿主代码时，需要重启 DSH 才能装载新的模块

卸载：让助手执行 `plugin_manager remove_bundle dsh-session-tariff`（用 npm 装的则 `dsh plugin remove dsh-session-tariff`）。

## 配置

### 单价（客户端）

默认值在 [client.js](client.js) 顶部：

```js
const DEFAULT_PRICING = {
  currency: '¥',
  idle: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
}
```

单位是**货币单位 / 百万 tokens**。也可以在 bundle 行上用 `config.pricing` 覆盖（可只覆盖部分字段）：

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

> **价目来源。** 上面这组数字是 DeepSeek 官方《[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)》页（2026-10 核对）的 `deepseek-flash` 档：空闲 0.02 / 1 / 4，高峰 0.04 / 2 / 8，高峰正好是空闲的两倍。三个注意点：
>
> - `cacheWrite` 默认取**未命中价**：DeepSeek 没有单独的缓存写入价（写入的 token 落在未命中桶里），对会单独上报写入量的 provider 来说，按未命中价计也最接近账单。会话里 `cacheWriteTokens` 恒为 0 时这一项自然为 0。
> - 会话若跑在 `deepseek-v4-pro` 上，把 idle 改成 `0.15 / 4.5 / 13.5`、peak 改成 `0.30 / 9 / 27`，否则会低报约 3–7 倍。
> - 价目是会变的，它不是从 API 实时取的，改价后自己更新这里或 `config.pricing`。

### 时段规则（宿主）

默认值在 [host.js](host.js) 的 `DEFAULT_RULES`：

```js
{
  utcOffsetMinutes: 480,
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  holidays: [],   // 'YYYY-MM-DD'
  workdays: []    // 'YYYY-MM-DD'，调休上班日
}
```

同样的字段可以写在 bundle 行的 `config` 上（见 [cordis.patch.yml](cordis.patch.yml) 的注释）。**法定节假日表默认是空的**：不填时，节假日会被当作普通工作日、只在 `peakWindows` 内按高峰计；要精确请按当年国务院公告补 `holidays` / `workdays`。

## 已验证

- 折叠单元测试（[test/fold.test.mjs](test/fold.test.mjs)，无依赖）：

  ```bash
  node test/fold.test.mjs
  ```

  覆盖：`09:00` / `12:00` / `14:00` / `18:00` 边界、周末、法定节假日、调休上班日、`assistant/attempt` 被 `message` 覆盖、重试双计、无关事件保持状态引用、检查点状态复原、wire 视图形状。

- 运行时对账：某个 `deepseek-flash` 会话（144 次请求）的 `sessionCost` 两档合计与同会话 `tokenUsage` 合计**逐项相等**——缓存读取 17,137,024 / 未缓存输入 131,962 / 输出 87,763——说明既没有重复计费也没有漏计。

- 价目核对：2026-10 对照官方[《模型 & 价格》](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)，`deepseek-flash` 空闲 0.02 / 1 / 4、高峰 0.04 / 2 / 8 与默认值逐项一致；高峰为工作日 09:00-12:00 / 14:00-18:00，其余含周末与法定节假日全天按空闲计，也与官方脚注一致。

- 视觉部分（胶囊位置、对话框排版）在 DSH 桌面版中人工确认；本项目没有浏览器自动化测试。

## 已知限制

- 价目是 `deepseek-flash` 的一档静态值：`deepseek-v4-pro` 需自行覆盖 `config.pricing`（见「单价」）
- 法定节假日 / 调休表需要自己维护，默认空表；周末本身已按空闲处理
- 时段归属按请求**发起**时刻；跨越 12:00 或 18:00 边界的长请求整体计入发起时段的价
- 只统计 provider 上报了 usage 的请求；被中断且无 usage 的请求不计
- 明细行金额四舍五入到 3 位，与时段合计可能差 ±0.001
- 仅适用于 DSH Web GUI 的 `conversation.composer.dock` 位置；宿主投影键名 `sessionCost` 为全局唯一，若与其他插件冲突会注册失败

## 兼容性

| 项 | 值 |
| --- | --- |
| 声明范围 | `@deepseek-ai/dsh` `^0.2.1-rc.2`（`package.json` 的 `peerDependencies`） |
| 实测版本 | `0.2.1-rc.3`（DSH 桌面版） |
| 依赖面 | 无运行时依赖：宿主半只用 `sessionProjections` 服务，客户端半只从模块表取 `react` / `react-dom` |
| 宿主键名 | cordis 插件 `session-tariff`，投影 `sessionCost` |

## 目录结构

```
dsh-session-tariff/
├── package.json           # bundle 清单：dsh.bundle.patch + dsh.client（Web 客户端半）
├── cordis.patch.yml       # 插入 session-tariff 这一行（含配置示例）
├── host.js                # 宿主半：注册 sessionCost 会话投影（折叠 + 时段归类）
├── client.js              # 客户端半：状态栏胶囊与明细对话框（React，无构建）
├── locale/{zh,en}.json    # 插件在插件页显示的标题与描述
├── icon.svg               # 插件图标（原创）
└── test/fold.test.mjs     # 折叠逻辑单元测试
```

客户端半是 `window.__ModuleLoader__.load({ id, factory })` 形式的无构建模块，只从 DSH 的模块表取 `react` / `react-dom`，样式用 DSH 主题令牌（`--dsw-alias-*`），不依赖任何 Harness 客户端包。

## 开发

```bash
# 语法检查
node --check host.js
node --check client.js

# 折叠逻辑测试（不依赖 DSH、不依赖任何包）
node test/fold.test.mjs
```

改完宿主半后重新安装并重启 DSH 才会装载新模块；只改客户端半刷新页面即可。

## 许可

[MIT](LICENSE)
