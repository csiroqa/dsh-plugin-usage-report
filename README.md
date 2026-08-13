# dsh-plugin-usage-report

DeepSeek Harness（`dsh`）用量报表插件 —— `plugins/usage-report`（`@dsh-plugin/usage-report`）。

按本地自然日/月汇聚 token（输入 / 缓存读 / 缓存写 / 输出）、轮数、步数与估算费用（USD），提供月度报表、预算告警，以及 Claude Code / Codex 式每日贡献格子与趣味统计。

## 功能

- **用量账本**：对账时对照 sessionPersistence 的 revision 增量重折叠变更会话日志，按日累计 token / 轮 / 步 / 费用（USD），按模型分账（`provider:model` 键）。
- **预算告警**：月度预算（`monthlyBudgetUsd`）按阈值（默认 50/80/90/100%）触发告警；告警按"月份|阈值"去重，跨月自动重置。
- **命令 `/usage`**：
  - 无参数：今日 + 本月 + 预算进度 + 近 14 天格子 + 连续/纪录等趣味统计；
  - `month [YYYY-MM]`：月度明细表；
  - `budget <usd>`：设置月度预算（0 关闭）；
  - `export [dir]`：导出当月 Markdown 报表（`dir` 为导出目录下的相对子路径）；
  - `rescan`：全量重扫全部会话。
- **设置页"用量"页签**（browser 半区，每 15 秒轮询）：每日格子（近 13 周，周一行 × 列）、预算进度条（可编辑预算）、趣味统计卡与告警列表，文案中英双语跟随 DSH 语言。

## 配置

`cordis.patch.yml` 的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `monthlyBudgetUsd` | `0` | 月度预算（USD）；0 = 不启用预算告警 |
| `alertThresholds` | `[50, 80, 90, 100]` | 触发告警的消耗百分比阈值（0-100，升序去重） |
| `reconcileMinutes` | `10` | 会话日志对账间隔（分钟）；0 = 关闭自动对账 |
| `keepDays` | `400` | 每日账本保留天数 |
| `gridDays` | `91` | 每日格子图覆盖天数 |
| `pricing` | `{}` | 模型单价覆盖（USD/百万 token），键为 `provider:model` 或 `model` |
| `exportDir` | `''` | `/usage export` 输出目录；空 = 当前工作区 `.dsh-reports` |

内置 DeepSeek 官方单价（USD/百万 token）：`deepseek-chat` 0.27/0.07/1.10、`deepseek-reasoner` 0.55/0.14/2.19（输入/缓存读/输出；缓存写缺省按缓存读计）。未命中的模型回退到 `deepseek-chat` 兜底价。

## HTTP 路由（browser 半区数据源）

| 路由 | 说明 |
|---|---|
| `GET /dsh-usage-report/summary?since=<ms>` | 综合快照（今日/本月/预算/格子/统计/告警；`since` 用于计算新增告警数） |
| `GET /dsh-usage-report/month?ym=YYYY-MM` | 指定月份每日明细（仅活跃日） |
| `POST /dsh-usage-report/budget` | 设置月度预算 `{ monthlyBudgetUsd }` |
| `POST /dsh-usage-report/rescan` | 全量重扫 |

## 架构要点

- **两半区**（与 harness 外部插件约定一致）：
  - host 半区 `lib/index.js`（Node ESM）：`export const name` / `inject` / `apply(ctx, config)`；依赖宿主注入 `commands`、`webServer`、`sessionPersistence`、`storageDomain`。
  - browser 半区 `lib/client.js`（CJS + `window.__ModuleLoader__.load` 包装）；依赖 `slots`、`locale`，注册 `settings.plugins.tab` 页签（id `usage-report`，order 10）。
- **持久化**：storage-domain `usage-report`（version 1），`days` / `sessions` / `alerts` 表 + `global{ monthlyBudgetUsd }`；重启无需全量重扫。schema 演进策略见 `src/spec.ts` 头部注释（新增字段必须带缺省，破坏性变更才 bump version）。
- **对账**：`ctx.interval`（reconcileMinutes）触发，revision 未变即跳过重折叠；单飞（并发共享同一趟，force 等待后另起）；已删除会话自动清理；每日账本整表重建、差异落盘。
- **模型单价解析**：`provider:model` → 纯 model → 内置定价 → 兜底价（`src/ledger.ts` `resolvePricing`）。
- **费用估算**：按 token 桶 × 每百万单价累加；harness 的 `outputTokens` 已含推理 token，不重复计费。

## 开发工作流

```sh
# 构建（esbuild 全量，~1s）
pnpm build

# 类型检查
pnpm typecheck

# 单插件 watch（改 src/ 自动重编 lib/index.js 与 lib/client.js）
pnpm watch

# 装进 profile 启动（需本机有 deepseek-harness 源码，link 依赖指向其 vendor/packages）
cd ../deepseek-harness
pnpm dsh plugin --profile web add ../dsh-plugin-usage-report/plugins/usage-report
pnpm dsh web --port 0

# 层序检查
pnpm dsh --profile web --dump-config
```

## 目录结构

```
plugins/usage-report/
├── cordis.patch.yml      # 插入层配置（默认值见上表）
├── package.json          # bundle 声明 + 构建/类型检查脚本
├── tsconfig.json
├── src/
│   ├── index.ts          # host 半区：UsageLedger（对账/持久化/告警）、/usage 命令、HTTP 路由
│   ├── ledger.ts         # 纯函数：事件折叠、定价解析、日期键、月度/格子/趣味统计、格式化（可单测）
│   ├── spec.ts           # storage-domain zod schema 与类型唯一真相
│   └── client/
│       ├── index.ts      # browser 半区入口（页签注册 + 数据函数）
│       ├── locales.ts    # zh/en 文案字典
│       └── UsageSettingsTab.tsx  # 页签 UI（轮询渲染）
scripts/build-plugin.mjs   # 两半区 esbuild 构建脚本（--only 指定插件）
```
