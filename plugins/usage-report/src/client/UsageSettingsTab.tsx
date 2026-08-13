/**
 * "设置 > 插件 > 用量"页签组件 —— 用量报表。
 *
 * 与内置"插件列表"页签同一注册模式：经 slots.register 的 inject 拿到数据函数，
 * 组件每 15 秒轮询 GET /dsh-usage-report/summary 并渲染：
 *   - 每日格子（Claude Code / Codex 式贡献图，近 13 周）
 *   - 今日 / 本月统计与预算进度（可编辑预算）
 *   - 趣味统计（连续 / 纪录 / 活跃天数）
 *   - 预算告警列表
 */
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatTokens, formatUsd, type UsageSummary } from '../ledger'
import type { UsageLocaleKey } from './locales'

/** 页签注册时注入的数据函数。 */
export interface UsageTabInjected {
  loadSummary: (since: number) => Promise<UsageSummary>
  setBudget: (monthlyBudgetUsd: number) => Promise<void>
}

/** Slot 渲染器组装出的完整组件 props。 */
export type UsageSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.usageReport'>
  & InjectFace<UsageTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly summary: UsageSummary }

const REFRESH_MS = 15_000

const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid #3a3a3f',
  borderRadius: 8, marginBottom: 8,
}
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const label: CSSProperties = { fontWeight: 600, minWidth: 96, margin: 0 }
const dim: CSSProperties = { color: '#9b9ba0', fontSize: 12 }
const chip: CSSProperties = {
  fontSize: 11, padding: '1px 8px', borderRadius: 10, border: '1px solid #55555c', color: '#c6c6cc',
}
const statCard: CSSProperties = {
  flex: '1 1 120px', minWidth: 110, padding: 10, border: '1px solid #3a3a3f',
  borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2,
}
const statValue: CSSProperties = { fontSize: 18, fontWeight: 700, margin: 0 }
const barTrack: CSSProperties = { flex: 1, height: 10, borderRadius: 5, background: '#2a2a2f', overflow: 'hidden', position: 'relative' }
const barFill: CSSProperties = { height: '100%', borderRadius: 5, background: '#4a8fe0' }
const cellBase: CSSProperties = { width: 13, height: 13, borderRadius: 3 }
const GRID_COLORS = ['#26262b', '#0e4429', '#006d32', '#26a641', '#39d353']

/** 计算格子所在列/行（周一列 0）。 */
function gridPosition(day: string, firstDay: string): { col: number; row: number } {
  const start = Date.parse(`${firstDay}T00:00:00`)
  const current = Date.parse(`${day}T00:00:00`)
  const diff = Math.round((current - start) / 86_400_000)
  const weekday = (new Date(`${day}T00:00:00`).getDay() + 6) % 7
  return { col: Math.floor(diff / 7), row: weekday }
}

/** 渲染"设置 > 插件 > 用量"页签。 */
export function UsageSettingsTab({ loadSummary, setBudget, t }: UsageSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [budgetInput, setBudgetInput] = useState('')
  const [invalidBudget, setInvalidBudget] = useState(false)
  const [saveResult, setSaveResult] = useState<'idle' | 'saved' | 'failed' | 'saving'>('idle')
  const sinceRef = useRef(0)
  const lastAtRef = useRef(0)
  const primedRef = useRef(false)

  useEffect(() => {
    let current = true
    let inFlight = false
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = (): void => {
      if (inFlight) return
      inFlight = true
      void loadSummary(sinceRef.current).then(
        (summary) => {
          inFlight = false
          if (!current) return
          // 丢弃乱序/过期响应（对账耗时超过轮询间隔时可能出现）。
          if (summary.at < lastAtRef.current) return
          lastAtRef.current = summary.at
          sinceRef.current = summary.at
          setState({ status: 'ready', summary })
          if (!primedRef.current) {
            primedRef.current = true
            setBudgetInput(String(summary.budget.monthlyUsd || ''))
          }
        },
        (error) => {
          inFlight = false
          if (current) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        },
      )
    }
    tick()
    timer = setInterval(tick, REFRESH_MS)
    return () => {
      current = false
      if (timer !== undefined) clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSummary 由注册侧注入，稳定
  }, [loadSummary, request])

  const retry = (): void => { setState({ status: 'loading' }); setRequest(v => v + 1) }

  const onSubmitBudget = (event: FormEvent): void => {
    event.preventDefault()
    const usd = Number(budgetInput)
    if (!Number.isFinite(usd) || usd < 0) {
      setInvalidBudget(true)
      return
    }
    setInvalidBudget(false)
    setSaveResult('saving')
    void setBudget(usd).then(
      () => {
        setSaveResult('saved')
        setRequest(v => v + 1)
      },
      () => setSaveResult('failed'),
    )
  }

  if (state.status === 'loading') {
    return <p style={dim}>{t('loading')}</p>
  }
  if (state.status === 'error') {
    return (
      <div>
        <p role="alert">{t('error')}</p>
        <p style={dim}>{state.message}</p>
        <button type="button" onClick={retry}>{t('retry')}</button>
      </div>
    )
  }

  const summary = state.summary
  const grid = summary.grid
  const firstDay = grid[0].day
  const weeks = Math.max(1, Math.ceil(grid.length / 7))
  const todayLevel = grid[grid.length - 1].level
  const budgetPct = summary.budget.enabled ? summary.budget.pct : 0
  const overBudget = summary.budget.enabled && summary.budget.pct >= 100
  const fillColor = overBudget
    ? '#c9443d'
    : summary.budget.pct >= 80 ? '#d9a13c' : '#4a8fe0'

  return (
    <div aria-busy={false}>
      <div style={row}>
        <span style={dim}>{t('autoRefresh')}</span>
        <button type="button" onClick={retry}>{t('refresh')}</button>
      </div>

      <div style={card}>
        <div style={row}>
          <p style={label}>{t('today')} · {summary.today.day}</p>
          <span style={chip}>{t(`todayTitle${todayLevel}` as UsageLocaleKey)}</span>
        </div>
        <p style={dim}>
          {formatTokens(summary.today.tokens)} {t('tokens')}
          {' · '}{formatUsd(summary.today.costUsd)} {t('cost')}
          {' · '}{summary.today.turns} {t('turns')} {summary.today.steps} {t('steps')}
          {' · '}{summary.today.sessions.length} {t('sessions')}
        </p>
      </div>

      <div style={card}>
        <div style={row}>
          <p style={label}>{t('thisMonth')} · {summary.month.ym}</p>
          <span>{formatTokens(summary.month.tokens)} {t('tokens')}</span>
          <span style={chip}>{formatUsd(summary.month.costUsd)}</span>
        </div>
        <div style={row}>
          <span style={dim}>
            {summary.month.activeDays} {t('activeDays')}
            {' · '}{summary.month.turns} {t('turns')} {summary.month.steps} {t('steps')}
            {' · '}{t('avgCost')} {formatUsd(summary.month.avgCostUsd)}
          </span>
        </div>
        <div style={row}>
          <p style={label}>{t('budget')}</p>
          {summary.budget.enabled
            ? (
              <>
                <span>{formatUsd(summary.budget.monthlyUsd)}</span>
                <div style={barTrack} role="progressbar" aria-valuenow={Math.round(budgetPct)} aria-valuemin={0} aria-valuemax={100}>
                  <div style={{ ...barFill, width: `${Math.min(100, budgetPct)}%`, background: fillColor }} />
                </div>
                <span style={dim}>{budgetPct.toFixed(1)}% {t('used')}</span>
                <span style={dim}>{t('remaining')} {formatUsd(summary.budget.remainingUsd)}</span>
              </>
            )
            : <span style={dim}>{t('budgetUnset')}</span>}
        </div>
        <form style={row} onSubmit={onSubmitBudget}>
          <p style={label}>{t('setBudget')}</p>
          <input
            type="number"
            min={0}
            step="any"
            value={budgetInput}
            onChange={event => { setBudgetInput(event.target.value); setInvalidBudget(false) }}
            placeholder={t('budgetUnset')}
            style={{ width: 120 }}
          />
          <button type="submit" disabled={saveResult === 'saving'}>{t('save')}</button>
          {invalidBudget && <span role="alert" style={{ color: '#c9443d' }}>{t('invalidBudget')}</span>}
          {saveResult === 'saved' && <span style={{ color: '#4caf7d' }}>{t('saved')}</span>}
          {saveResult === 'failed' && <span role="alert" style={{ color: '#c9443d' }}>{t('saveFailed')}</span>}
        </form>
      </div>

      <div style={card}>
        <p style={label}>{t('gridTitle').replace('{}', String(grid.length))}</p>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${weeks}, 15px)`, gap: 3 }}>
          {grid.map(cell => {
            const { col, row: cellRow } = gridPosition(cell.day, firstDay)
            const isToday = cell.day === summary.today.day
            return (
              <div
                key={cell.day}
                title={`${cell.day} · ${formatTokens(cell.tokens)} · ${formatUsd(cell.costUsd)} · ${t(`level${cell.level}` as UsageLocaleKey)}`}
                style={{
                  ...cellBase,
                  background: GRID_COLORS[Math.max(0, Math.min(4, cell.level))],
                  gridColumn: col + 1,
                  gridRow: cellRow + 1,
                  outline: isToday ? '1px solid #c6c6cc' : undefined,
                }}
              />
            )
          })}
        </div>
        <div style={row}>
          <span style={dim}>{t('less')}</span>
          {GRID_COLORS.map(color => <span key={color} style={{ ...cellBase, background: color, display: 'inline-block' }} />)}
          <span style={dim}>{t('more')}</span>
        </div>
      </div>

      <div style={card}>
        <p style={label}>{t('stats')}</p>
        <div style={{ ...row, alignItems: 'stretch' }}>
          <div style={statCard}>
            <p style={statValue}>{summary.stats.currentStreak} 🔥</p>
            <span style={dim}>{t('currentStreak')}</span>
          </div>
          <div style={statCard}>
            <p style={statValue}>{summary.stats.longestStreak} 🏆</p>
            <span style={dim}>{t('longestStreak')}</span>
          </div>
          <div style={statCard}>
            <p style={statValue}>{summary.stats.activeDays}</p>
            <span style={dim}>{t('totalActive')}</span>
          </div>
          <div style={statCard}>
            <p style={statValue}>{summary.stats.totalDays}</p>
            <span style={dim}>{t('totalDays')}</span>
          </div>
          <div style={statCard}>
            <p style={statValue}>{formatUsd(summary.stats.totalCostUsd)}</p>
            <span style={dim}>{t('totalCost')}</span>
          </div>
          {summary.stats.topDay && (
            <div style={statCard}>
              <p style={statValue}>{formatUsd(summary.stats.topDay.costUsd)} ⚡</p>
              <span style={dim}>{t('recordDay')} · {summary.stats.topDay.day}</span>
            </div>
          )}
        </div>
      </div>

      <div style={card}>
        <p style={label}>{t('alerts')}</p>
        {summary.alerts.length === 0
          ? <span style={dim}>{t('noAlerts')}</span>
          : summary.alerts.map(alert => (
            <div key={alert.id} style={row}>
              <span style={chip}>{new Date(alert.at).toLocaleString()}</span>
              <span>{t('alertAt')} {alert.threshold}%</span>
              <span style={dim}>{formatUsd(alert.costUsd)} / {formatUsd(alert.budgetUsd)}</span>
            </div>
          ))}
      </div>
    </div>
  )
}
