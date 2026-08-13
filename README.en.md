# dsh-plugin-usage-report

A **usage & cost report** plugin for DeepSeek Harness (DSH): aggregates tokens (input / cache-read / cache-write / output), turns and estimated cost (USD) by local day and month, with monthly reports, budget alerts, and a Claude Code/Codex-style daily contribution grid with fun stats.

中文: [README.md](README.md)

## Features

- **Usage ledger**: refolds only revision-changed session logs against sessionPersistence, accumulating tokens / turns / steps / cost (USD) per day, broken down by model (`provider:model` key); persisted via storage-domain, no full rescan after restart
- **Budget alerts**: monthly budget (`monthlyBudgetUsd`) triggers alerts at threshold percentages (default 50/80/90/100%), deduplicated by `month|threshold`, reset automatically across months
- **`/usage` command**: `/usage` (today/month/budget progress/contribution grid/fun stats), `/usage month [YYYY-MM]` (monthly detail), `/usage budget <usd>` (0 disables), `/usage export [dir]` (Markdown report), `/usage rescan` (full rescan)
- **"Usage" tab under Settings > Plugins**: Claude Code/Codex-style contribution grid (last 13 weeks), editable budget progress bar, fun stats cards and alert list (zh/en, auto-refreshes every 15 s)

## Configuration

Optional config on the plugin row (`cordis.patch.yml`):

| Key | Default | Description |
| --- | --- | --- |
| `monthlyBudgetUsd` | `0` | Monthly budget (USD); 0 = budget alerts disabled |
| `alertThresholds` | `[50, 80, 90, 100]` | Alert thresholds as percent of budget (0-100, sorted, deduplicated) |
| `reconcileMinutes` | `10` | Session log reconcile interval in minutes; 0 = no auto reconcile |
| `keepDays` | `400` | Days of daily ledger to retain |
| `gridDays` | `91` | Days covered by the contribution grid (91 = 13 weeks) |
| `pricing` | `{}` | Per-model price overrides (USD/M tokens), keyed by `provider:model` or `model` |
| `exportDir` | `''` | Output directory for `/usage export`; empty = `<workspace>/.dsh-reports` |

Built-in DeepSeek official prices (USD/M tokens): `deepseek-chat` 0.27/0.07/1.10, `deepseek-reasoner` 0.55/0.14/2.19 (input/cache-read/output; cache-write falls back to cache-read). Models missing from the config fall back to the `deepseek-chat` default price.

## Install

Requirements: Node.js >= 22, pnpm, a local checkout of `deepseek-harness` (dependencies use `link:` to `../../../deepseek-harness`).

```sh
git clone https://github.com/csiroqa/dsh-plugin-usage-report.git
cd dsh-plugin-usage-report
pnpm install
pnpm build

# Add to the web profile (link: points at plugins/usage-report)
dsh plugin --profile web add link:$(pwd)/plugins/usage-report        # POSIX
dsh plugin --profile web add link:E:\path\to\dsh-plugin-usage-report\plugins\usage-report   # Windows
```

Restart `dsh web` and hard-refresh the browser (**Ctrl+F5**).

## Usage

1. Run `/usage` in a session to see today / this month / budget progress / contribution grid / fun stats; `/usage month [YYYY-MM]` for monthly detail
2. `/usage budget <usd>` sets the monthly budget; `/usage export [dir]` exports this month's report; `/usage rescan` does a full rescan
3. Settings > Plugins > **Usage**: contribution grid, editable budget progress and alert list

## Compatibility

- Developed against a DSH `0.1.0-rc.5` source checkout
- The client half depends only on platform modules (react, etc.)
- Build: `tsdown` (host `lib/index.js` + browser `lib/client.js`, standard `window.__ModuleLoader__.load` closure-factory format)

## Security notes

- Usage data and budget live only on the local machine (storage-domain backend and the `.dsh-reports` export directory)
- `/dsh-usage-report/*` endpoints are loopback-only (DSH binds to 127.0.0.1 by default); do not expose the DSH port to the public internet

## License

**MIT License** (see [LICENSE](LICENSE)). Use, modify, reference, or include it in your own plugin collections — just keep the license notice and credit this repository.

## Related

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- Plugin form reference: [dsh-schedule](https://github.com/csiroqa/dsh-schedule) (`dsh.bundle.patch` + `dsh.client` declaration + slot registration + dual-half build)
