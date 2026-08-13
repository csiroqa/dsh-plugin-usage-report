/**
 * 用量报表插件 —— host 半区（@dsh-plugin/usage-report）
 *
 * 职责：
 *  1. 对账：定期（reconcileMinutes）与 /usage 命令、HTTP 请求触发时，对照
 *     sessionPersistence 的 revision 增量重折叠变更会话日志，按本地自然日
 *     累计 token（输入/缓存读/缓存写/输出）、轮数、步数与估算费用（USD）。
 *  2. 持久化：storage-domain 'usage-report'（days / sessions / alerts 表 +
 *     全局预算），重启后无需全量重扫。
 *  3. 预算告警：月度预算按月统计，穿越配置阈值（50/80/90/100%）写入告警表；
 *     告警 id = 月份键|阈值，按月自然去重，跨月自动重置。
 *  4. 命令 /usage：
 *     - 无参数：今日 + 本月 + 预算进度 + 近 14 天格子 + 连续/纪录等趣味统计；
 *     - month [YYYY-MM]：月度明细表；
 *     - budget <usd>：设置月度预算（0 关闭）；
 *     - export [dir]：导出当月 Markdown 报表（dir 须为相对子路径）；
 *     - rescan：全量重扫全部会话。
 *  5. HTTP（browser 半区数据源）：
 *     - GET /dsh-usage-report/summary?since=<ms>
 *     - GET /dsh-usage-report/month?ym=YYYY-MM
 *     - POST /dsh-usage-report/budget { monthlyBudgetUsd }
 *     - POST /dsh-usage-report/rescan
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  buildSummaryOf, budgetStatusOf, bucketPart, buildGridOf, cutoffDayOf, currentMonthKey,
  dayKeyOf, foldSession, formatTokens, formatUsd, funStatsOf, gridGlyph, isContributionActive,
  monthKeyOf, monthTotalsOf, progressBar, recomputeDaysOf, resolvePricing, tokensTotal,
  type BudgetStatus, type FunStats, type GridCell, type ModelPricing, type UsageSummary,
} from './ledger'
import {
  usageDomainSpec,
  type UsageDomain, type AlertRecord, type DayRecord, type SessionUsageRecord, type UsageGlobal,
} from './spec'

export const name = 'usage-report'

export const inject = ['commands', 'webServer', 'sessionPersistence', 'storageDomain']

export interface Config {
  /** 月度预算（USD）；0 = 不启用预算告警。 */
  readonly monthlyBudgetUsd?: number
  /** 触发告警的消耗百分比阈值（0-100）。 */
  readonly alertThresholds?: number[]
  /** 会话日志对账间隔（分钟）；0 = 关闭自动对账。 */
  readonly reconcileMinutes?: number
  /** 每日账本保留天数。 */
  readonly keepDays?: number
  /** 每日格子图覆盖天数。 */
  readonly gridDays?: number
  /** 模型单价覆盖（USD/百万 token），键为 provider:model 或 model。 */
  readonly pricing?: Record<string, ModelPricing>
  /** /usage export 输出目录；空 = 当前工作区 .dsh-reports。 */
  readonly exportDir?: string
}

const MAX_ALERTS = 100
const RECENT_ALERTS = 20
const GRID_TRAIL_DAYS = 14

/** 今日趣味标题（按格子档位，host 命令输出固定中文，与仓库约定一致）。 */
const TODAY_TITLES = ['今天还没开张，摸鱼愉快 🐑', '小试身手 🌱', '稳步推进 🌤️', '火力全开 🔥', '爆发日 💥']

/** 用量账本：内存态 + domain 持久化 + 对账。 */
class UsageLedger {
  private days = new Map<string, DayRecord>()
  private sessions = new Map<string, SessionUsageRecord>()
  private alertList: AlertRecord[] = []
  private global!: UsageGlobal
  private reconciling: Promise<void> | null = null

  private readonly daysTable: KvTable<string, DayRecord>
  private readonly sessionsTable: KvTable<string, SessionUsageRecord>
  private readonly alertsTable: KvTable<string, AlertRecord>

  constructor(
    private readonly ctx: Context,
    private readonly domain: UsageDomain,
    private readonly options: {
      readonly alertThresholds: number[]
      readonly keepDays: number
      readonly gridDays: number
      readonly pricingOverrides: Record<string, ModelPricing>
    },
  ) {
    this.daysTable = domain.table('days')
    this.sessionsTable = domain.table('sessions')
    this.alertsTable = domain.table('alerts')
  }

  /** 从 domain 载入内存态。 */
  async init(): Promise<void> {
    for (const [, record] of this.daysTable.entries()) this.days.set(record.day, record)
    for (const [id, record] of this.sessionsTable.entries()) this.sessions.set(id, record)
    this.alertList = [...this.alertsTable.entries()]
      .map(([, record]) => record)
      .sort((a, b) => b.at - a.at)
    this.global = this.domain.global.get()
  }

  /**
   * 对账（单飞）：并发调用共享同一趟；force 时等待在飞趟结束后另起全量重扫。
   * 失败会记日志并上抛，由调用点决定如何呈现（命令报错 / HTTP 500 / 定时器吞掉）。
   */
  async reconcile(force: boolean): Promise<void> {
    if (this.reconciling) {
      if (!force) return this.reconciling
      await this.reconciling
    }
    const run = this.runReconcile(force).catch(error => {
      this.ctx.logger.warn(`usage-report: reconcile failed: ${String(error)}`)
      throw error
    })
    this.reconciling = run
    try {
      await run
    } finally {
      if (this.reconciling === run) this.reconciling = null
    }
  }

  /** 内部对账：只重折叠 revision 变化的会话，清理已删除会话，然后整表重建每日账本。 */
  private async runReconcile(force: boolean): Promise<void> {
    const now = Date.now()
    const cutoff = cutoffDayOf(now, this.options.keepDays)
    const snapshots = await this.ctx.sessionPersistence.listSnapshots()
    const revisions = new Map<SessionId, string>()
    const liveIds = new Set<string>()
    for (const snapshot of snapshots) {
      revisions.set(snapshot.header.id, String(snapshot.revision))
      liveIds.add(String(snapshot.header.id))
    }

    const changed = new Set<SessionId>()
    for (const id of revisions.keys()) {
      const previous = this.sessions.get(String(id))
      if (force || previous === undefined || previous.revision !== revisions.get(id)) changed.add(id)
    }

    for (const id of changed) {
      let events
      try {
        events = (await this.ctx.sessionPersistence.load(id)).events
      } catch (error) {
        this.ctx.logger.warn(`usage-report: cannot load session '${id}': ${String(error)}`)
        continue
      }
      const byDay: SessionUsageRecord['byDay'] = {}
      const fold = foldSession(events, key => resolvePricing(key, this.options.pricingOverrides))
      for (const [day, contribution] of fold) {
        if (isContributionActive(contribution) && day >= cutoff) byDay[day] = contribution
      }
      this.sessions.set(String(id), { revision: revisions.get(id) ?? null, byDay })
    }

    for (const id of this.sessions.keys()) {
      if (liveIds.has(id)) continue
      this.sessions.delete(id)
      await this.sessionsTable.delete(id)
    }

    const previous = this.days
    this.days = recomputeDaysOf(this.sessions, cutoff)
    await this.flushDays(previous)
    await this.evaluateBudget()
    await this.pruneAlerts()
  }

  /** 持久化每日账本差异（新增/更新/删除）。 */
  private async flushDays(previous: Map<string, DayRecord>): Promise<void> {
    for (const [day, record] of this.days) {
      const old = previous.get(day)
      if (old !== undefined && JSON.stringify(old) === JSON.stringify(record)) continue
      await this.daysTable.put(day, record)
    }
    for (const day of previous.keys()) {
      if (!this.days.has(day)) await this.daysTable.delete(day)
    }
  }

  /** 裁剪告警表到上限（保留最新）。 */
  private async pruneAlerts(): Promise<void> {
    if (this.alertList.length <= MAX_ALERTS) return
    const dropped = this.alertList.slice(MAX_ALERTS)
    this.alertList = this.alertList.slice(0, MAX_ALERTS)
    for (const record of dropped) await this.alertsTable.delete(record.id)
  }

  /**
   * 预算告警评估：穿越未告警过的阈值则落一条告警。
   * 告警 id = 月份键|阈值：同一阈值同月只告警一次，跨月自动重置。
   */
  private async evaluateBudget(): Promise<void> {
    const monthlyUsd = this.global.monthlyBudgetUsd
    if (monthlyUsd <= 0) return
    const ym = currentMonthKey()
    const cost = monthTotalsOf(this.days.values(), ym).costUsd
    if (cost <= 0) return
    const pct = (cost / monthlyUsd) * 100
    for (const threshold of this.options.alertThresholds) {
      if (pct < threshold) break
      const id = `${ym}|${threshold}`
      if (this.alertList.some(alert => alert.id === id)) continue
      const record: AlertRecord = { id, at: Date.now(), threshold, costUsd: cost, budgetUsd: monthlyUsd }
      this.alertList.push(record)
      this.alertList.sort((a, b) => b.at - a.at)
      await this.alertsTable.put(id, record)
    }
  }

  /** 设置月度预算（0 关闭），随后以新预算重新对账（含告警评估）。 */
  async setBudget(monthlyBudgetUsd: number): Promise<void> {
    const next: UsageGlobal = { ...this.global, monthlyBudgetUsd: Math.max(0, monthlyBudgetUsd) }
    this.global = next
    await this.domain.global.set(next)
    await this.reconcile(false)
  }

  /** 综合快照（先对账再计算）。 */
  async summary(since: number): Promise<UsageSummary> {
    await this.reconcile(false)
    const now = Date.now()
    return buildSummaryOf(
      this.days,
      this.global.monthlyBudgetUsd,
      this.options.alertThresholds,
      this.alertList,
      since,
      this.options.gridDays,
      RECENT_ALERTS,
      now,
    )
  }

  /** 月度汇总。 */
  monthTotals(ym: string): ReturnType<typeof monthTotalsOf> {
    return monthTotalsOf(this.days.values(), ym)
  }

  /** 指定月份每日明细（按日升序，仅含活跃日）。 */
  monthDays(ym: string): DayRecord[] {
    return [...this.days.values()]
      .filter(record => monthKeyOf(record.day) === ym && (record.costUsd > 0 || tokensTotal(record.tokens) > 0))
      .sort((a, b) => a.day.localeCompare(b.day))
  }

  /** 预算状态（按当前月）。 */
  budgetStatus(): BudgetStatus {
    const ym = currentMonthKey()
    return budgetStatusOf(
      this.global.monthlyBudgetUsd,
      this.options.alertThresholds,
      monthTotalsOf(this.days.values(), ym).costUsd,
    )
  }

  /** 趣味统计（覆盖全部已保留日）。 */
  funStats(): FunStats {
    return funStatsOf(this.days, dayKeyOf(Date.now()))
  }

  /** 每日格子（含今天）。 */
  grid(count: number): GridCell[] {
    return buildGridOf(this.days, count, Date.now())
  }
}

/** 返回查询参数映射。 */
function queryOf(url: string | undefined): URLSearchParams {
  return new URL(url ?? '/', 'http://localhost').searchParams
}

/** 读取请求体全文。 */
function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** JSON 响应。 */
function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 导出子目录必须是相对路径且不含 `..` 段（防路径穿越）。 */
function isSafeSubdir(dir: string): boolean {
  return !isAbsolute(dir) && !dir.split(/[\\/]+/u).includes('..')
}

export function apply(ctx: Context, config: Config = {}): void {
  const monthlyBudgetUsd = config.monthlyBudgetUsd ?? 0
  // 升序去重、∈(0,100]：evaluateBudget 的增量穿越遍历与告警 id 依赖升序/唯一性。
  const alertThresholds = [...new Set(config.alertThresholds ?? [50, 80, 90, 100])]
    .filter(value => Number.isFinite(value) && value > 0 && value <= 100)
    .sort((a, b) => a - b)
  const reconcileMinutes = Math.max(0, config.reconcileMinutes ?? 10)
  const keepDays = Math.max(7, Math.min(config.keepDays ?? 400, 3650))
  const gridDays = Math.max(7, Math.min(config.gridDays ?? 91, 365))
  const pricingOverrides = config.pricing ?? {}
  const exportDir = (config.exportDir ?? '').trim() || join(process.cwd(), '.dsh-reports')

  const start = async (): Promise<void> => {
    const domain = await ctx.storageDomain.open(usageDomainSpec)
    ctx.effect(() => () => { void domain.close() }, 'usage-report: domain close')
    const ledger = new UsageLedger(ctx, domain, { alertThresholds, keepDays, gridDays, pricingOverrides })
    await ledger.init()
    await ledger.reconcile(false).catch(() => {})
    if (monthlyBudgetUsd > 0) await ledger.setBudget(monthlyBudgetUsd).catch(() => {})

    ctx.effect(() => ctx.commands.register({
      name: 'usage',
      description: '用量报表：今日与本月统计、预算进度、每日格子与趣味统计',
      input: { hint: '[month [YYYY-MM] | budget <usd> | export [dir] | rescan]' },
      handler: async (invocation) => {
        try {
          const tokens = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
          const sub = tokens[0] ?? ''
          if (sub === 'month') {
            const ym = tokens[1] ?? currentMonthKey()
            if (!/^\d{4}-\d{2}$/u.test(ym)) {
              return { kind: 'error', text: `无效月份：${ym}（示例：2026-08）` }
            }
            await ledger.reconcile(false)
            const totals = ledger.monthTotals(ym)
            const rows = ledger.monthDays(ym)
            const lines = [`📅 ${ym} 用量明细`, '', '  日期        轮  步  输入    缓存读   缓存写   输出    费用']
            for (const record of rows) {
              lines.push(
                `  ${record.day}  ${String(record.turns).padStart(3)} ${String(record.steps).padStart(3)}`
                + `  ${formatTokens(record.tokens)}`.padStart(9)
                + `  ${formatTokens(bucketPart(record.tokens, 'cacheRead'))}`.padStart(9)
                + `  ${formatTokens(bucketPart(record.tokens, 'cacheWrite'))}`.padStart(9)
                + `  ${formatTokens(bucketPart(record.tokens, 'output'))}`.padStart(9)
                + `  ${formatUsd(record.costUsd)}`.padStart(9),
              )
            }
            lines.push('', `  合计  ${String(totals.turns).padStart(3)} ${String(totals.steps).padStart(3)}`
              + `  ${formatTokens(totals.tokens)}`.padStart(9)
              + `  ${formatTokens(bucketPart(totals.tokens, 'cacheRead'))}`.padStart(9)
              + `  ${formatTokens(bucketPart(totals.tokens, 'cacheWrite'))}`.padStart(9)
              + `  ${formatTokens(bucketPart(totals.tokens, 'output'))}`.padStart(9)
              + `  ${formatUsd(totals.costUsd)}`.padStart(9))
            if (rows.length === 0) lines.push('', '  该月暂无用量数据')
            return { kind: 'success', text: lines.join('\n') }
          }
          if (sub === 'budget') {
            const raw = tokens[1]
            if (raw === undefined) return { kind: 'error', text: '用法：/usage budget <usd>（0 = 关闭预算告警）' }
            const usd = Number(raw)
            if (!Number.isFinite(usd) || usd < 0) {
              return { kind: 'error', text: '用法：/usage budget <usd>（0 = 关闭预算告警）' }
            }
            await ledger.setBudget(usd)
            return {
              kind: 'success',
              text: usd > 0 ? `月度预算已设为 ${formatUsd(usd)}` : '月度预算已关闭',
            }
          }
          if (sub === 'export') {
            const dir = (tokens[1] ?? '').trim()
            if (dir !== '' && !isSafeSubdir(dir)) {
              return { kind: 'error', text: '导出目录必须是相对子路径（不允许 .. 或绝对路径）' }
            }
            const target = await exportMonthReport(ledger, dir === '' ? exportDir : join(exportDir, dir), currentMonthKey())
            return { kind: 'success', text: `已导出月度报表：${target}` }
          }
          if (sub === 'rescan') {
            await ledger.reconcile(true)
            return { kind: 'success', text: '已完成全量重扫' }
          }

          const summary = await ledger.summary(0)
          const todayLevel = summary.grid.at(-1)?.level ?? 0
          const budgetLine = summary.budget.enabled
            ? `预算：${formatUsd(summary.budget.monthlyUsd)} · 已用 ${summary.budget.pct.toFixed(1)}%  ${progressBar(summary.budget.pct)}  剩 ${formatUsd(summary.budget.remainingUsd)}`
            : '预算：未设置（/usage budget <usd> 可开启）'
          const gridLine = summary.grid.slice(-GRID_TRAIL_DAYS).map(cell => gridGlyph(cell.level)).join('')
          const lines = [
            `📊 用量报表 · ${summary.today.day}`,
            '',
            `今日：${formatTokens(summary.today.tokens)}（入 ${formatTokens(bucketPart(summary.today.tokens, 'input'))}`
              + ` / 缓存读 ${formatTokens(bucketPart(summary.today.tokens, 'cacheRead'))}`
              + ` / 缓存写 ${formatTokens(bucketPart(summary.today.tokens, 'cacheWrite'))}`
              + ` / 出 ${formatTokens(bucketPart(summary.today.tokens, 'output'))}）`
              + ` · ${formatUsd(summary.today.costUsd)} · ${summary.today.turns} 轮 ${summary.today.steps} 步`,
            `本月（${summary.month.ym}）：${formatTokens(summary.month.tokens)} · ${formatUsd(summary.month.costUsd)}`
              + ` · ${summary.month.activeDays} 天活跃 · 日均 ${formatUsd(summary.month.avgCostUsd)}`,
            budgetLine,
            '',
            '每日格子（近 14 天）：',
            ` ${gridLine}`,
            '  · 无 ▁低 ▃中 ▅高 ▇峰值（按费用分位）',
            '',
            `🔥 连续 ${summary.stats.currentStreak} 天 · 🏆 最长 ${summary.stats.longestStreak} 天 · 📅 累计活跃 ${summary.stats.activeDays} 天`
              + (summary.stats.topDay ? ` · ⚡ 单日纪录 ${formatUsd(summary.stats.topDay.costUsd)}（${summary.stats.topDay.day}）` : ''),
            `今日：${TODAY_TITLES[todayLevel]}`,
            ...(summary.alerts.length > 0 ? ['', `🚨 预算告警 ${summary.alerts.length} 条（近期，见设置 > 用量页签）`] : []),
            '',
            '提示：/usage month [YYYY-MM] · /usage budget <usd> · /usage export · /usage rescan',
          ]
          return { kind: 'success', text: lines.join('\n') }
        } catch (error) {
          ctx.logger.error(`usage-report: /usage failed: ${String(error)}`)
          return { kind: 'error', text: '操作失败，请查看服务日志' }
        }
      },
    }), 'usage-report: /usage')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-usage-report/summary',
      handler: async (req, res) => {
        try {
          const since = Number(queryOf(req.url).get('since') ?? '0')
          json(res, 200, await ledger.summary(Number.isFinite(since) ? since : 0))
        } catch (error) {
          ctx.logger.error(`usage-report: /summary failed: ${String(error)}`)
          json(res, 500, { error: '用量统计获取失败，请查看服务日志' })
        }
      },
    }), 'usage-report: /dsh-usage-report/summary')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-usage-report/month',
      handler: async (req, res) => {
        try {
          await ledger.reconcile(false)
          const ym = queryOf(req.url).get('ym') ?? currentMonthKey()
          if (!/^\d{4}-\d{2}$/u.test(ym)) return json(res, 400, { error: 'ym 必须为 YYYY-MM 格式' })
          json(res, 200, { ym, days: ledger.monthDays(ym) })
        } catch (error) {
          ctx.logger.error(`usage-report: /month failed: ${String(error)}`)
          json(res, 500, { error: '月度明细获取失败，请查看服务日志' })
        }
      },
    }), 'usage-report: /dsh-usage-report/month')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-usage-report/budget',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' })
        let body: { monthlyBudgetUsd?: unknown }
        try {
          body = JSON.parse(await readBody(req)) as { monthlyBudgetUsd?: unknown }
        } catch (error) {
          ctx.logger.warn(`usage-report: /budget bad JSON: ${String(error)}`)
          return json(res, 400, { error: '请求体不是合法的 JSON' })
        }
        const usd = body.monthlyBudgetUsd
        if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
          return json(res, 400, { error: 'monthlyBudgetUsd 必须为非负数字' })
        }
        try {
          await ledger.setBudget(usd)
          json(res, 200, { ok: true, monthlyBudgetUsd: usd })
        } catch (error) {
          ctx.logger.error(`usage-report: /budget failed: ${String(error)}`)
          json(res, 500, { error: '预算保存失败，请查看服务日志' })
        }
      },
    }), 'usage-report: /dsh-usage-report/budget')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-usage-report/rescan',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' })
        try {
          await ledger.reconcile(true)
          json(res, 200, { ok: true })
        } catch (error) {
          ctx.logger.error(`usage-report: /rescan failed: ${String(error)}`)
          json(res, 500, { error: '全量重扫失败，请查看服务日志' })
        }
      },
    }), 'usage-report: /dsh-usage-report/rescan')

    if (reconcileMinutes > 0) {
      ctx.effect(() => ctx.interval(() => {
        void ledger.reconcile(false).catch(() => {})
      }, reconcileMinutes * 60_000), 'usage-report: reconcile timer')
    }
  }

  void start().catch(error => {
    ctx.logger.error(`usage-report: failed to start: ${String(error)}`)
  })
}

/** 导出指定月份的 Markdown 报表到目录，返回文件路径。 */
async function exportMonthReport(
  ledger: UsageLedger,
  dir: string,
  ym: string,
): Promise<string> {
  const totals = ledger.monthTotals(ym)
  const rows = ledger.monthDays(ym)
  const stats = ledger.funStats()
  const lines = [
    `# 用量报表 ${ym}`,
    '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 本月消耗：${formatUsd(totals.costUsd)}`,
    `- 本月 token：${formatTokens(totals.tokens)}`,
    `- 活跃天数：${totals.activeDays} 天`,
    `- 当前连续：${stats.currentStreak} 天，最长 ${stats.longestStreak} 天`,
    '',
    '## 每日明细',
    '',
    '| 日期 | 轮 | 步 | 输入 | 缓存读 | 缓存写 | 输出 | 费用 |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const record of rows) {
    lines.push(
      `| ${record.day} | ${record.turns} | ${record.steps} | ${formatTokens(bucketPart(record.tokens, 'input'))}`
      + ` | ${formatTokens(bucketPart(record.tokens, 'cacheRead'))}`
      + ` | ${formatTokens(bucketPart(record.tokens, 'cacheWrite'))}`
      + ` | ${formatTokens(bucketPart(record.tokens, 'output'))}`
      + ` | ${formatUsd(record.costUsd)} |`,
    )
  }
  const modelNames = new Set<string>()
  for (const record of rows) for (const key of Object.keys(record.byModel)) modelNames.add(key)
  if (modelNames.size > 0) {
    lines.push('', '## 分模型费用', '', '| 模型 | 费用 |', '|---|---|')
    for (const key of [...modelNames].sort()) {
      let costUsd = 0
      for (const record of rows) costUsd += record.byModel[key].costUsd
      lines.push(`| ${key} | ${formatUsd(costUsd)} |`)
    }
  }
  lines.push('', '## 每日格子（近 14 天）', '', '```', ledger.grid(GRID_TRAIL_DAYS).map(cell => gridGlyph(cell.level)).join(''), '```')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `usage-report-${ym}.md`)
  await writeFile(file, lines.join('\n') + '\n', 'utf8')
  return file
}
