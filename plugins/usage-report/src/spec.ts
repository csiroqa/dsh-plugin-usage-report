/**
 * 用量账本持久化 schema（storage-domain + zod）。
 *
 * 账本 = "每日汇总（days）" + "每会话折叠结果（sessions）" + "告警记录（alerts）"
 * + 全局预算状态（global）。
 *
 * schema 演进策略（重要）：
 *  - 新增可选字段必须带缺省（如 z.number().default(0) / z.string().optional()）：
 *    zod 默认 strip 未知键，带缺省的必填字段可在旧介质记录上补齐，无需迁移。
 *  - 仅破坏性变更才 bump version；bump 时 storage-domain 会对旧介质拒绝 open，
 *    需在注释中写明迁移方案。
 *  - 新增表只需在 tables 里加项，open 时 entry 集由 spec 决定，旧介质缺表不报错。
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

export const tokensSchema = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
})
export type TokenBuckets = z.infer<typeof tokensSchema>

export const modelUsageSchema = z.object({
  tokens: tokensSchema,
  costUsd: z.number(),
})
export type ModelUsage = z.infer<typeof modelUsageSchema>

/** 单会话单日贡献（sessions 表 byDay 的值，可 JSON 序列化）。 */
export const contributionSchema = z.object({
  tokens: tokensSchema,
  turns: z.number(),
  steps: z.number(),
  costUsd: z.number(),
  byModel: z.record(z.string(), modelUsageSchema),
})
export type DayContribution = z.infer<typeof contributionSchema>

/** 持久化的"每日汇总"记录。 */
export const dayRecordSchema = z.object({
  day: z.string(),
  tokens: tokensSchema,
  turns: z.number(),
  steps: z.number(),
  sessions: z.array(z.string()),
  costUsd: z.number(),
  byModel: z.record(z.string(), modelUsageSchema),
})
export type DayRecord = z.infer<typeof dayRecordSchema>

/** 持久化的"会话折叠结果"；revision 变化即触发重折叠。 */
export const sessionUsageSchema = z.object({
  revision: z.string().nullable(),
  byDay: z.record(z.string(), contributionSchema),
})
export type SessionUsageRecord = z.infer<typeof sessionUsageSchema>

/** 持久化的"预算告警"记录；id = 月份键 + 阈值（如 2026-08|80），天然去重。 */
export const alertRecordSchema = z.object({
  id: z.string(),
  at: z.number(),
  threshold: z.number(),
  costUsd: z.number(),
  budgetUsd: z.number(),
})
export type AlertRecord = z.infer<typeof alertRecordSchema>

/** 全局状态：月度预算（USD；0 = 不启用预算告警）。 */
export const usageGlobalSchema = z.object({
  monthlyBudgetUsd: z.number(),
})
export type UsageGlobal = z.infer<typeof usageGlobalSchema>

/** 用量账本 domain 声明。域名须匹配 /^[a-z][a-z0-9_]*$/（storage-domain 约束，不允许连字符）。 */
export const usageDomainSpec = defineDomain({
  name: 'usage_report',
  version: 1,
  global: {
    schema: usageGlobalSchema,
    initial: { monthlyBudgetUsd: 0 },
  },
  tables: {
    days: domainTable<string, DayRecord>(dayRecordSchema),
    sessions: domainTable<string, SessionUsageRecord>(sessionUsageSchema),
    alerts: domainTable<string, AlertRecord>(alertRecordSchema),
  },
})

/** 打开的 domain 句柄类型。 */
export type UsageDomain = Domain<typeof usageDomainSpec>
