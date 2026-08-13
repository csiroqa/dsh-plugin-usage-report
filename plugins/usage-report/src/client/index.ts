/**
 * 用量报表插件 —— browser 半区
 *
 * 在"设置 > 插件"区段注册"用量"页签（slot: settings.plugins.tab，id: usage-report，
 * order 10）：轮询 host 的 GET /dsh-usage-report/summary 渲染——
 *   - Claude Code / Codex 式每日格子：近 13 周费用贡献图（weekdays 行 × W 列）；
 *   - 今日 / 本月 / 预算进度（可编辑预算并 POST 生效）；
 *   - 趣味统计：连续天数、最长纪录、累计活跃、单日纪录、总费用；
 *   - 预算告警列表。
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { UsageSummary } from '../ledger'
import { UsageSettingsTab, type UsageTabInjected } from './UsageSettingsTab'
import { en, zh, type UsageLocaleKey } from './locales'

export const name = 'usage-report-client'

/** 用量页签文案命名空间。 */
export const NS = 'settings.usageReport'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 用量报表页签文案。 */
    'settings.usageReport': UsageLocaleKey
  }
}

export const inject = ['slots', 'locale']

/** 从响应体提取 host 的中文错误文案，否则回退为状态码。 */
async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') return body.error
  } catch {
    // 非 JSON 响应体，忽略
  }
  return `HTTP ${res.status}`
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'usage-report: dictionaries')

  const injected = (): UsageTabInjected => ({
    loadSummary: async (since: number): Promise<UsageSummary> => {
      const res = await fetch(`/dsh-usage-report/summary?since=${since}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(await errorOf(res))
      return res.json() as Promise<UsageSummary>
    },
    setBudget: async (monthlyBudgetUsd: number): Promise<void> => {
      const res = await fetch('/dsh-usage-report/budget', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ monthlyBudgetUsd }),
      })
      if (!res.ok) throw new Error(await errorOf(res))
      await res.json()
    },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'usage-report',
    order: 10,
    label: () => ctx.locale.bind(NS)('tab'),
    locale: NS,
    inject: injected,
  }, UsageSettingsTab))
}
