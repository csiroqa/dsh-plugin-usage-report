/**
 * 用量/成本折叠与汇总（纯函数，无框架依赖，可脱离 harness 单测）。
 *
 * 从一个"会话事件日志"（SessionEvent[]）折叠出该会话按日的 token / 费用贡献：
 *   - 模型：跟随最新的 `request/header`（header.config.provider/model）；
 *   - 用量：`assistant/message` 事件携带的 usage 会计（输入/缓存读/缓存写/输出）；
 *     harness 的 outputTokens 已含推理 token（DeepSeek API 语义），不再重复计费；
 *   - 时间：按事件自身 time 归属到本地自然日（YYYY-MM-DD）；
 *   - 轮数/步数：按 turn/start、step/start 计数。
 *
 * 价格：ModelPricing 为每百万 token 的 USD 单价。未命中配置的模型回退到
 * DeepSeek chat 兜底价，并用 provider:model / 纯 model 两级匹配。
 *
 * 日键不变量：dayKeyOf 输出零填充的 YYYY-MM-DD，字典序 == 时间序，
 * 下游 sort / localeCompare / 区间比较 / previousDay 算术均依赖此性质。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  type TokenBuckets, type DayContribution, type DayRecord, type AlertRecord,
  type SessionUsageRecord,
} from './spec'

/** 单次模型用量（与 token-meter 的 TokenUsage 结构等价，避免引入 llm 依赖）。 */
export interface UsageInfo {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** 某一模型的单价（USD / 百万 token）；cacheRead 为"缓存命中输入"档。 */
export interface ModelPricing {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite?: number
  readonly output: number
}

/** 每百万 token 单价，按模型键解析。 */
export type PricingResolver = (modelKey: string) => ModelPricing

/** DeepSeek 官方单价（USD/百万 token，2025-03 定价）。 */
export const DEEPSEEK_PRICING: Record<string, ModelPricing> = {
  'deepseek-chat': { input: 0.27, cacheRead: 0.07, output: 1.10 },
  'deepseek-reasoner': { input: 0.55, cacheRead: 0.14, output: 2.19 },
}

/** 未命中任何配置时的兜底价（按 deepseek-chat 估算）。 */
export const FALLBACK_PRICING: ModelPricing = { input: 0.27, cacheRead: 0.07, output: 1.10 }

/** 标准化一个模型键（`provider:model` 或 `model`），去空白。 */
export function normalizeModelKey(provider: string | undefined, model: string | undefined): string {
  if (!model) return 'unknown'
  const clean = model.trim()
  const prov = provider?.trim()
  return prov && prov !== 'unknown' ? `${prov}:${clean}` : clean
}

/** 依据配置覆盖、常见键与兜底解析单价。 */
export function resolvePricing(modelKey: string, overrides: Record<string, ModelPricing>): ModelPricing {
  if (overrides[modelKey]) return overrides[modelKey]
  const colon = modelKey.lastIndexOf(':')
  const bare = colon >= 0 ? modelKey.slice(colon + 1) : modelKey
  if (overrides[bare]) return overrides[bare]
  if (DEEPSEEK_PRICING[bare]) return DEEPSEEK_PRICING[bare]
  if (DEEPSEEK_PRICING[modelKey]) return DEEPSEEK_PRICING[modelKey]
  return FALLBACK_PRICING
}

/** 空 token 桶。 */
export function emptyTokens(): TokenBuckets {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** 空单会话单日贡献。 */
export function emptyContribution(): DayContribution {
  return { tokens: emptyTokens(), turns: 0, steps: 0, costUsd: 0, byModel: {} }
}

/** 一份 token 桶的合计。 */
export function tokensTotal(tokens: TokenBuckets): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
}

/** 单会话单日贡献是否"活跃"（有 token 用量、轮数或步数）。 */
export function isContributionActive(contribution: DayContribution): boolean {
  return contribution.turns > 0 || contribution.steps > 0 || tokensTotal(contribution.tokens) > 0
}

function addTokens(target: TokenBuckets, source: TokenBuckets): void {
  target.input += source.input
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.output += source.output
}

/** 把一份用量按单价计入某模型的分模型桶，并同步累计到当日贡献合计。 */
function addUsage(contribution: DayContribution, usage: UsageInfo, price: ModelPricing, modelKey: string): void {
  const input = usage.inputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const output = usage.outputTokens ?? 0
  const modelCost = (
    input * price.input
    + cacheRead * price.cacheRead
    + cacheWrite * (price.cacheWrite ?? price.cacheRead)
    + output * price.output
  ) / 1_000_000
  contribution.tokens.input += input
  contribution.tokens.cacheRead += cacheRead
  contribution.tokens.cacheWrite += cacheWrite
  contribution.tokens.output += output
  contribution.costUsd += modelCost
  const modelUsage = contribution.byModel[modelKey]
  if (modelUsage) {
    modelUsage.tokens.input += input
    modelUsage.tokens.cacheRead += cacheRead
    modelUsage.tokens.cacheWrite += cacheWrite
    modelUsage.tokens.output += output
    modelUsage.costUsd += modelCost
  } else {
    contribution.byModel[modelKey] = {
      tokens: { input, cacheRead, cacheWrite, output },
      costUsd: modelCost,
    }
  }
}

/**
 * 折叠一个会话日志为按日贡献。
 * @param events - 会话事件（按 seq 有序）。
 * @param resolve - 模型单价解析器。
 */
export function foldSession(events: readonly SessionEvent[], resolve: PricingResolver): Map<string, DayContribution> {
  const byDay = new Map<string, DayContribution>()
  let currentModel = 'unknown'
  const byDayFor = (time: number): DayContribution => {
    const day = dayKeyOf(time)
    const contribution = byDay.get(day) ?? emptyContribution()
    byDay.set(day, contribution)
    return contribution
  }
  for (const event of events) {
    switch (event.type) {
      case 'request/header': {
        const header = event.data.header
        currentModel = normalizeModelKey(header.config.provider, header.config.model)
        break
      }
      case 'assistant/message': {
        if (!event.data.usage) break
        addUsage(byDayFor(event.time), event.data.usage, resolve(currentModel), currentModel)
        break
      }
      case 'turn/start':
        byDayFor(event.time).turns += 1
        break
      case 'step/start':
        byDayFor(event.time).steps += 1
        break
    }
  }
  return byDay
}

/** 把源贡献并入目标贡献（按模型去重累计）。 */
export function mergeContribution(target: DayContribution, source: DayContribution): DayContribution {
  addTokens(target.tokens, source.tokens)
  target.turns += source.turns
  target.steps += source.steps
  target.costUsd += source.costUsd
  for (const [key, usage] of Object.entries(source.byModel)) {
    const existing = target.byModel[key]
    if (existing) {
      addTokens(existing.tokens, usage.tokens)
      existing.costUsd += usage.costUsd
    } else {
      // 深拷贝：source 来自内存中长期存活的会话记录，直接挂引用会互相污染。
      target.byModel[key] = { tokens: { ...usage.tokens }, costUsd: usage.costUsd }
    }
  }
  return target
}

/** 补齐两位数的月/日。 */
export function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 本地自然日键（零填充，字典序 == 时间序）。 */
export function dayKeyOf(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 从日键取月份键 YYYY-MM。 */
export function monthKeyOf(day: string): string {
  return day.slice(0, 7)
}

/** 今天的日键。 */
export function todayKey(): string {
  return dayKeyOf(Date.now())
}

/** 本月的月份键。 */
export function currentMonthKey(): string {
  return monthKeyOf(todayKey())
}

/** 前一天日键（午夜减 1ms，跨夏令时安全）。 */
export function previousDay(day: string): string {
  return dayKeyOf(Date.parse(`${day}T00:00:00`) - 1)
}

/** 保留窗口起点的日键（小于该键的日被裁剪；用日期算术而非固定毫秒，避免夏令时偏移）。 */
export function cutoffDayOf(now: number, keepDays: number): string {
  const date = new Date(now)
  date.setDate(date.getDate() - keepDays)
  return dayKeyOf(date.getTime())
}

/** 空每日汇总。 */
export function zeroDay(day: string): DayRecord {
  return { day, tokens: emptyTokens(), turns: 0, steps: 0, sessions: [], costUsd: 0, byModel: {} }
}

/** 从全部会话贡献重建每日账本。 */
export function recomputeDaysOf(
  sessions: Iterable<readonly [string, SessionUsageRecord]>,
  cutoff: string,
): Map<string, DayRecord> {
  const next = new Map<string, DayRecord>()
  for (const [sessionId, record] of sessions) {
    for (const [day, contribution] of Object.entries(record.byDay)) {
      if (day < cutoff) continue
      let target = next.get(day)
      if (!target) {
        target = zeroDay(day)
        next.set(day, target)
      }
      mergeContribution(target, contribution)
      if (!target.sessions.includes(sessionId)) target.sessions.push(sessionId)
    }
  }
  return next
}

/** 月度汇总。 */
export interface MonthTotals {
  readonly ym: string
  readonly tokens: TokenBuckets
  readonly turns: number
  readonly steps: number
  readonly costUsd: number
  readonly activeDays: number
  readonly avgCostUsd: number
}

/** 某月费用/汇总合计。 */
export function monthTotalsOf(days: Iterable<DayRecord>, ym: string): MonthTotals {
  const tokens = emptyTokens()
  let turns = 0
  let steps = 0
  let costUsd = 0
  let activeDays = 0
  for (const record of days) {
    if (monthKeyOf(record.day) !== ym) continue
    addTokens(tokens, record.tokens)
    turns += record.turns
    steps += record.steps
    costUsd += record.costUsd
    if (record.costUsd > 0 || tokensTotal(record.tokens) > 0) activeDays += 1
  }
  return {
    ym,
    tokens,
    turns,
    steps,
    costUsd,
    activeDays,
    avgCostUsd: activeDays > 0 ? costUsd / activeDays : 0,
  }
}

/** 预算状态。 */
export interface BudgetStatus {
  readonly enabled: boolean
  readonly monthlyUsd: number
  readonly costUsd: number
  readonly pct: number
  readonly remainingUsd: number
  /** 下一个未穿越的阈值百分比；null = 已全部穿越（超支）。 */
  readonly nextThreshold: number | null
}

/** 预算状态（thresholds 须升序）。 */
export function budgetStatusOf(
  monthlyUsd: number,
  thresholds: readonly number[],
  costUsd: number,
): BudgetStatus {
  if (monthlyUsd <= 0) {
    return { enabled: false, monthlyUsd: 0, costUsd, pct: 0, remainingUsd: 0, nextThreshold: null }
  }
  const pct = (costUsd / monthlyUsd) * 100
  const next = thresholds.find(threshold => pct < threshold) ?? null
  return {
    enabled: true,
    monthlyUsd,
    costUsd,
    pct,
    remainingUsd: Math.max(0, monthlyUsd - costUsd),
    nextThreshold: next,
  }
}

/** 每日格子单元。 */
export interface GridCell {
  readonly day: string
  readonly tokens: TokenBuckets
  readonly costUsd: number
  /** 0-4 强度档（0 = 无消耗）。 */
  readonly level: number
}

/** 每日格子（含今天），按 costUsd 分位定档 0-4。 */
export function buildGridOf(days: ReadonlyMap<string, DayRecord>, count: number, now: number): GridCell[] {
  const cells: GridCell[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(now)
    date.setDate(date.getDate() - offset)
    const day = dayKeyOf(date.getTime())
    const record = days.get(day)
    cells.push({ day, tokens: record?.tokens ?? emptyTokens(), costUsd: record?.costUsd ?? 0, level: 0 })
  }
  const costs = cells.map(cell => cell.costUsd).filter(value => value > 0).sort((a, b) => a - b)
  if (costs.length === 0) return cells
  const [q1, q2, q3] = [0.25, 0.5, 0.75].map(p => costs[Math.floor(costs.length * p)])
  return cells.map(cell => ({
    ...cell,
    level: cell.costUsd <= 0 ? 0 : cell.costUsd <= q1 ? 1 : cell.costUsd <= q2 ? 2 : cell.costUsd <= q3 ? 3 : 4,
  }))
}

/** 趣味统计。 */
export interface FunStats {
  readonly currentStreak: number
  readonly longestStreak: number
  readonly activeDays: number
  readonly totalDays: number
  readonly totalCostUsd: number
  readonly topDay: { readonly day: string; readonly costUsd: number } | null
}

/** 趣味统计：连续天数、最长连续、活跃天数、总费用、单日纪录。 */
export function funStatsOf(days: ReadonlyMap<string, DayRecord>, today: string): FunStats {
  const active = [...days.values()]
    .filter(record => record.costUsd > 0 || tokensTotal(record.tokens) > 0)
    .map(record => record.day)
    .sort()
  let currentStreak = 0
  let cursor = active.includes(today) ? today : previousDay(today)
  while (active.includes(cursor)) {
    currentStreak += 1
    cursor = previousDay(cursor)
  }
  let longestStreak = 0
  let run = 0
  let previous: string | null = null
  for (const day of active) {
    run = previous !== null && previousDay(day) === previous ? run + 1 : 1
    if (run > longestStreak) longestStreak = run
    previous = day
  }
  let topDay: FunStats['topDay'] = null
  let totalCostUsd = 0
  for (const record of days.values()) {
    totalCostUsd += record.costUsd
    if (topDay === null || record.costUsd > topDay.costUsd) {
      topDay = { day: record.day, costUsd: record.costUsd }
    }
  }
  const firstDay = active[0]
  let totalDays = 0
  if (firstDay !== undefined) {
    const from = new Date(`${firstDay}T00:00:00`)
    const to = new Date(`${today}T00:00:00`)
    for (let date = from; date <= to; date.setDate(date.getDate() + 1)) totalDays += 1
  }
  return {
    currentStreak,
    longestStreak,
    activeDays: active.length,
    totalDays,
    totalCostUsd,
    topDay,
  }
}

/** GET /dsh-usage-report/summary 响应。 */
export interface UsageSummary {
  readonly at: number
  readonly today: DayRecord
  readonly month: MonthTotals
  readonly budget: BudgetStatus
  readonly grid: GridCell[]
  readonly stats: FunStats
  readonly alerts: AlertRecord[]
  readonly newAlerts: number
}

/** 组装综合快照（纯函数，入参均为调用方已对账后的状态）。 */
export function buildSummaryOf(
  days: ReadonlyMap<string, DayRecord>,
  monthlyUsd: number,
  thresholds: readonly number[],
  alerts: readonly AlertRecord[],
  since: number,
  gridDays: number,
  recentAlerts: number,
  now: number,
): UsageSummary {
  const today = dayKeyOf(now)
  const month = monthTotalsOf(days.values(), monthKeyOf(today))
  return {
    at: now,
    today: days.get(today) ?? zeroDay(today),
    month,
    budget: budgetStatusOf(monthlyUsd, thresholds, month.costUsd),
    grid: buildGridOf(days, gridDays, now),
    stats: funStatsOf(days, today),
    alerts: alerts.slice(0, recentAlerts),
    newAlerts: alerts.filter(alert => alert.at > since).length,
  }
}

/** 千分位可读 token。 */
export function formatTokens(tokens: TokenBuckets): string {
  const total = tokensTotal(tokens)
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`
  return String(total)
}

/** 单价美元展示。 */
export function formatUsd(usd: number): string {
  if (usd >= 10) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

/** 进度条（20 格）。 */
export function progressBar(pct: number): string {
  const filled = Math.max(0, Math.min(20, Math.round(pct / 5)))
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`
}

/** 格子档位 → 单字符。 */
export function gridGlyph(level: number): string {
  return ' ·▁▃▅▇'[Math.max(0, Math.min(4, level))]
}

/** 只取某档 token 的桶（用于分项展示，如"仅缓存读"）。 */
export function bucketPart(bucket: TokenBuckets, key: keyof TokenBuckets): TokenBuckets {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, [key]: bucket[key] }
}
