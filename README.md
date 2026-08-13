# dsh-plugin-usage-report

DeepSeek Harness（DSH）的**用量报表**插件：按本地自然日/月汇聚 token（输入 / 缓存读 / 缓存写 / 输出）、轮数、步数与估算费用（USD），提供月度报表、预算告警，以及 Claude Code / Codex 式每日贡献格子与趣味统计。

English: [README.en.md](README.en.md)

## 功能

- **用量账本**：对照 sessionPersistence 的 revision 增量重折叠变更会话日志，按日累计 token / 轮 / 步 / 估算费用（USD），按模型分账（`provider:model` 键）；数据持久化于 storage-domain，重启无需全量重扫
- **预算告警**：月度预算（`monthlyBudgetUsd`）按阈值（默认 50/80/90/100%）触发告警，按「月份|阈值」去重、跨月自动重置
- **命令 `/usage`**：`/usage`（今日/本月/预算进度/每日格子/趣味统计）、`/usage month [YYYY-MM]`（月度明细）、`/usage budget <usd>`（0 关闭）、`/usage export [dir]`（导出 Markdown 报表）、`/usage rescan`（全量重扫）
- **设置页「用量」页签**：Claude Code / Codex 式每日贡献格子（近 13 周）、预算进度条（可编辑）、趣味统计卡与告警列表（中英双语，每 15 秒自动刷新）

## 配置

插件行（`cordis.patch.yml` 的 `usage-report` insert 行）支持以下可选 config：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `monthlyBudgetUsd` | `0` | 月度预算（USD）；0 = 不启用预算告警 |
| `alertThresholds` | `[50, 80, 90, 100]` | 触发告警的消耗百分比阈值（0-100，升序去重） |
| `reconcileMinutes` | `10` | 会话日志对账间隔（分钟）；0 = 关闭自动对账 |
| `keepDays` | `400` | 每日账本保留天数 |
| `gridDays` | `91` | 每日贡献格子覆盖天数（91 = 13 周） |
| `pricing` | `{}` | 模型单价覆盖（USD/百万 token），键为 `provider:model` 或 `model` |
| `exportDir` | `''` | `/usage export` 输出目录；空 = 当前工作区 `.dsh-reports` |

内置 DeepSeek 官方单价（USD/百万 token）：`deepseek-chat` 0.27/0.07/1.10、`deepseek-reasoner` 0.55/0.14/2.19（输入/缓存读/输出；缓存写缺省按缓存读计）。未命中配置的模型回退到 `deepseek-chat` 兜底价。

## 安装

前置：Node.js >= 22、pnpm、本机 `deepseek-harness` 源码检出（依赖以 `link:` 指向 `../../../deepseek-harness`）。

```sh
git clone https://github.com/csiroqa/dsh-plugin-usage-report.git
cd dsh-plugin-usage-report
pnpm install
pnpm build

# 安装进 web profile（link: 指向 plugins/usage-report）
dsh plugin --profile web add link:$(pwd)/plugins/usage-report        # POSIX
dsh plugin --profile web add link:E:\path\to\dsh-plugin-usage-report\plugins\usage-report   # Windows
```

重启 `dsh web`，浏览器 **Ctrl+F5** 硬刷新。

## 使用

1. 会话里输入 `/usage` 查看今日/本月/预算进度/每日贡献格子/趣味统计；`/usage month [YYYY-MM]` 查看月度明细
2. `/usage budget <usd>` 设置月度预算；`/usage export [dir]` 导出当月报表；`/usage rescan` 全量重扫
3. 设置 > 插件 > **用量**：每日贡献格子、预算进度（可编辑）与告警列表

## 兼容性

- 针对 DSH `0.1.0-rc.5` 源码检出开发验证
- 客户端仅依赖平台模块表（react 等），不随 DSH SDK 版本漂移
- 构建产物：`tsdown`（host 半区 `lib/index.js` + browser 半区 `lib/client.js`，标准 `window.__ModuleLoader__.load` 闭包工厂格式）

## 安全说明

- 用量数据与预算仅存本机（storage-domain 后端与 `.dsh-reports` 导出目录）
- `/dsh-usage-report/*` 接口仅监听本机（DSH 默认回环绑定），请勿把 DSH 端口暴露到公网

## 许可与使用声明

**MIT License**（见 [LICENSE](LICENSE)）。

欢迎任何人**使用、修改、引用、或把本项目收录进自己的插件合集**，只需：

- 保留 `LICENSE` 文件与版权声明
- 标明出处（本仓库链接）

## 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- 插件形态参考 [dsh-schedule](https://github.com/csiroqa/dsh-schedule)（`dsh.bundle.patch` + `dsh.client` 声明 + 槽位注册 + 双半区构建）
