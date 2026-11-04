import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../lib/api'
import { useApiData } from '../hooks/useApiData'
import { AXIS_TEXT, GRID, SERIES, colorMap } from '../lib/colors'
import { formatCompact, formatMs, formatNumber, formatRelative } from '../lib/format'
import { Segmented } from '../components/Badges'
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, RefreshIcon } from '../components/ui'

const RANGES = [
  { id: '24h', label: '24 hours', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
]

const IN_OUT = [
  { key: 'prompt_tokens', label: 'Input tokens', color: SERIES[0] },
  { key: 'completion_tokens', label: 'Output tokens', color: SERIES[1] },
]

function bucketLabel(ts, hourly) {
  const d = new Date(ts * 1000)
  return hourly
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Clean axis steps instead of Recharts' 65 / 130 / 195.
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000, 100000, 250000, 500000, 1e6, 2e6, 5e6]
function niceAxis(max) {
  if (!max) return { domain: [0, 1], ticks: [0, 1] }
  const step = STEPS.find((c) => max / c <= 4) ?? Math.ceil(max / 4)
  const top = Math.ceil(max / step) * step
  const ticks = []
  for (let t = 0; t <= top; t += step) ticks.push(t)
  return { domain: [0, top], ticks }
}

const AXIS = { stroke: GRID, tick: { fill: AXIS_TEXT, fontSize: 11 }, tickLine: false, axisLine: false }

/** Identity never rides on colour alone — the legend is always present. */
function Legend({ items }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}

function ChartTooltip({ active, payload, label, items, format = formatNumber }) {
  if (!active || !payload?.length) return null
  const total = items.reduce((s, it) => s + (payload.find((p) => p.dataKey === it.key)?.value ?? 0), 0)
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-slate-900">{label}</p>
      <div className="mt-1.5 space-y-1">
        {items.map((s) => {
          const v = payload.find((p) => p.dataKey === s.key)?.value ?? 0
          return (
            <p key={s.key} className="flex items-center gap-2 text-xs text-slate-600">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="flex-1">{s.label}</span>
              <span className="font-medium tabular-nums text-slate-900">{format(v)}</span>
            </p>
          )
        })}
        {items.length > 1 && (
          <p className="flex items-center gap-2 border-t border-slate-100 pt-1 text-xs text-slate-600">
            <span className="flex-1 pl-4">Total</span>
            <span className="font-medium tabular-nums text-slate-900">{format(total)}</span>
          </p>
        )}
      </div>
    </div>
  )
}

/** Stacked bars; 1.5px surface stroke separates segments, only the top
 * segment gets rounded corners. Drawn statically — the page re-polls. */
function StackedBars({ rows, items, height, format }) {
  const max = Math.max(0, ...rows.map((r) => items.reduce((s, it) => s + (r[it.key] ?? 0), 0)))
  const y = niceAxis(max)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="label" minTickGap={16} {...AXIS} />
        <YAxis width={56} tickFormatter={formatCompact} domain={y.domain} ticks={y.ticks} {...AXIS} />
        <Tooltip content={<ChartTooltip items={[...items].reverse()} format={format} />} cursor={{ fill: '#f1f5f9' }} />
        {items.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} stackId="s" fill={s.color} stroke="#fff" strokeWidth={1.5}
            maxBarSize={28} radius={i === items.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

function ChartCard({ title, subtitle, legend, children }) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
        </div>
        {legend}
      </div>
      {children}
    </Card>
  )
}

function ModelTable({ rows, colors }) {
  if (!rows.length) return null
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-200 px-5 py-3.5">
        <h2 className="text-sm font-semibold text-slate-900">By model</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              {['Model', 'Requests', 'Errors', 'Fallbacks', 'Input tok', 'Output tok', 'Avg latency', 'Last used'].map((h, i) => (
                <th key={h} className={`px-4 py-2 font-medium whitespace-nowrap ${i ? 'text-right' : ''}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.model}>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <span className="flex items-center gap-2 font-mono text-xs text-slate-900">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colors[r.model] }} />
                    {r.model}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">{formatNumber(r.requests)}</td>
                <td className={`px-4 py-2.5 text-right tabular-nums ${r.errors ? 'text-red-600' : 'text-slate-500'}`}>{formatNumber(r.errors)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{formatNumber(r.fallbacks)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">{formatNumber(r.prompt_tokens)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">{formatNumber(r.completion_tokens)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">{formatMs(r.avg_latency_ms)}</td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap text-slate-500">{formatRelative(r.last_ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export default function Stats() {
  const [rangeId, setRangeId] = useState('7d')
  const range = RANGES.find((r) => r.id === rangeId)
  const overview = useApiData(() => api.overview())
  const series = useApiData(() => api.series(rangeId), { interval: 60000, deps: [rangeId] })
  const byModel = useApiData(() => api.statsModels(range.days), { interval: 60000, deps: [rangeId] })

  // Colour follows the model's slot in providers.yaml; models that only
  // exist in history (since removed) come after, in name order.
  const colors = useMemo(() => {
    const configured = overview.data?.models.map((m) => m.id) ?? []
    const seen = [...(series.data?.models ?? []), ...(byModel.data?.models.map((m) => m.model) ?? [])]
    const extra = [...new Set(seen)].filter((m) => !configured.includes(m)).sort()
    return colorMap([...configured, ...extra])
  }, [overview.data, series.data, byModel.data])

  const hourly = series.data?.bucket_s === 3600
  const models = series.data?.models ?? []
  const modelItems = models.map((m) => ({ key: `m:${m}`, label: m, color: colors[m] }))
  const rows = (series.data?.points ?? []).map((p) => {
    const r = { label: bucketLabel(p.bucket, hourly), prompt_tokens: p.prompt_tokens, completion_tokens: p.completion_tokens }
    for (const m of models) r[`m:${m}`] = p.by_model[m] ?? 0
    return r
  })
  const totalReq = (series.data?.points ?? []).reduce((s, p) => s + p.requests, 0)
  const totalTok = (series.data?.points ?? []).reduce((s, p) => s + p.prompt_tokens + p.completion_tokens, 0)

  const refreshing = series.refreshing || byModel.refreshing
  const reloadAll = () => {
    series.reload()
    byModel.reload()
  }

  return (
    <>
      <PageHeader
        title="Usage"
        description={`Requests and tokens per ${hourly ? 'hour' : 'day'}, by the model that served them. Panel tests are excluded.`}
        actions={
          <>
            <Segmented options={RANGES} value={rangeId} onChange={setRangeId} label="Time range" />
            <Button variant="secondary" onClick={reloadAll} loading={refreshing}>
              {!refreshing && <RefreshIcon />}
              Refresh
            </Button>
          </>
        }
      />

      {series.loading && <Card><LoadingState label="Loading usage…" /></Card>}
      {!series.loading && series.error && <Card><ErrorState error={series.error} onRetry={series.reload} /></Card>}

      {!series.loading && !series.error && series.data && (
        <div className="space-y-6">
          {!totalReq ? (
            <Card><EmptyState title="No requests in this range" description="Traffic through the model API shows up here." /></Card>
          ) : (
            <>
              <ChartCard title="Requests" subtitle={`${formatNumber(totalReq)} in the last ${range.label}`} legend={<Legend items={modelItems} />}>
                <StackedBars rows={rows} items={modelItems} height={280} />
              </ChartCard>
              <ChartCard title="Tokens" subtitle={`${formatCompact(totalTok)} in the last ${range.label} — as reported by the providers`} legend={<Legend items={IN_OUT} />}>
                <StackedBars rows={rows} items={IN_OUT} height={240} format={formatNumber} />
              </ChartCard>
            </>
          )}
          {byModel.data && <ModelTable rows={byModel.data.models} colors={colors} />}
        </div>
      )}
    </>
  )
}
