import { api } from '../lib/api'
import { useApiData } from '../hooks/useApiData'
import { formatCompact, formatMs, formatNumber, formatRelative, formatUptime } from '../lib/format'
import { HealthBadge, HealthDot, Tag } from '../components/Badges'
import { Button, Card, ErrorState, LoadingState, PageHeader, RefreshIcon } from '../components/ui'

function StatCard({ label, value, hint, dot, href }) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <span className={`h-2 w-2 rounded-full ${dot}`} />
      </div>
      <p className="mt-3 text-3xl font-semibold tabular-nums text-slate-900">{value}</p>
      <p className="mt-1 h-4 truncate text-xs text-slate-400">{hint ?? ''}</p>
    </>
  )
  const cls = 'block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300'
  return href ? <a href={href} className={cls}>{body}</a> : <div className={cls}>{body}</div>
}

function SummaryCards({ summary }) {
  const t = summary.today
  const week = summary.last_7d
  const tokens = (t.prompt_tokens ?? 0) + (t.completion_tokens ?? 0)
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Requests today" value={formatNumber(t.requests)}
        hint={`${formatNumber(week.requests)} in the last 7 days`} dot="bg-blue-500" href="#/requests" />
      <StatCard label="Errors today" value={formatNumber(t.errors)}
        hint={t.fallbacks ? `${formatNumber(t.fallbacks)} rescued by fallback` : 'no fallbacks today'}
        dot={t.errors ? 'bg-red-500' : 'bg-emerald-500'} href="#/requests" />
      <StatCard label="Tokens today" value={formatCompact(tokens)}
        hint={`${formatCompact(t.prompt_tokens)} in · ${formatCompact(t.completion_tokens)} out`}
        dot="bg-violet-500" href="#/stats" />
      <StatCard label="Avg latency today" value={formatMs(t.avg_latency_ms)}
        hint={t.tool_calls ? `${formatNumber(t.tool_calls)} tool calls` : 'whole request, incl. tools'}
        dot="bg-amber-500" />
    </div>
  )
}

function ModelsCard({ models }) {
  return (
    <Card className="mt-6 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
        <h2 className="text-sm font-semibold text-slate-900">Models</h2>
        <a href="#/models" className="text-xs font-medium text-blue-600 hover:text-blue-700">Test models →</a>
      </div>
      <ul className="divide-y divide-slate-100">
        {models.map((m) => {
          const u = m.usage_24h
          return (
            <li key={m.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <HealthDot health={m.health} />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-900">
                    <span className="font-mono">{m.id}</span>
                    {m.default && <Tag tone="blue">default</Tag>}
                    {m.external && <Tag tone="amber" title="Prompts leave the LAN">external</Tag>}
                    {!m.tools && <Tag title="No tool calling — web_search/fetch_url not offered">no tools</Tag>}
                  </p>
                  <p className="truncate font-mono text-xs text-slate-400">
                    {m.owned_by} / {m.upstream_model}
                    {m.fallback && <span className="text-slate-500"> · fallback → {m.fallback}</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-5 pl-4.5 text-xs text-slate-500 sm:pl-0">
                <span className="tabular-nums"><b className="font-medium text-slate-900">{formatNumber(u?.requests)}</b> req / 24h</span>
                <span className="w-16 tabular-nums">{formatMs(u?.avg_latency_ms)}</span>
                <HealthBadge health={m.health} />
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function ProvidersCard({ providers }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
        <h2 className="text-sm font-semibold text-slate-900">Providers</h2>
        <a href="#/providers" className="text-xs font-medium text-blue-600 hover:text-blue-700">Details →</a>
      </div>
      <ul className="divide-y divide-slate-100">
        {providers.map((p) => (
          <li key={p.name} className="px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-slate-900">{p.name}</p>
              <HealthBadge health={p.health} />
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-slate-400">{p.base_url}</p>
            {p.health.status !== 'ok' && p.health.error && (
              <p className="mt-1 truncate text-xs text-red-600" title={p.health.error}>
                {formatRelative(p.health.last_error)}: {p.health.error}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function GatewayCard({ proxy }) {
  const items = [
    ['Version', proxy.version],
    ['Uptime', formatUptime(proxy.uptime_s)],
    ['Model API', `port ${proxy.api_port}`],
    ['Default model', proxy.default_model],
    ['Server tools', proxy.tools.join(', ')],
  ]
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-slate-900">Gateway</h2>
      <dl className="mt-3 space-y-2.5">
        {items.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="truncate font-mono text-xs text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
      {!proxy.providers_file_exists && (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          providers.yaml not found — running on LLAMA_URL only.
        </p>
      )}
    </Card>
  )
}

export default function Dashboard() {
  const { data, error, loading, refreshing, updatedAt, reload } = useApiData(() => api.overview(), {
    interval: 15000,
  })

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Live state of the gateway. Health comes from real traffic and a periodic probe."
        actions={
          <>
            {updatedAt && <span className="text-xs text-slate-400">Updated {formatRelative(updatedAt / 1000)}</span>}
            <Button variant="secondary" onClick={() => reload()} loading={refreshing}>
              {!refreshing && <RefreshIcon />}
              Refresh
            </Button>
          </>
        }
      />

      {loading && <Card><LoadingState label="Loading gateway state…" /></Card>}
      {!loading && error && <Card><ErrorState error={error} onRetry={reload} /></Card>}

      {!loading && !error && data && (
        <>
          <SummaryCards summary={data.summary} />
          <ModelsCard models={data.models} />
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2"><ProvidersCard providers={data.providers} /></div>
            <GatewayCard proxy={data.proxy} />
          </div>
        </>
      )}
    </>
  )
}
