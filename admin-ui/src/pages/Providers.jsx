import { useState } from 'react'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { useApiData } from '../hooks/useApiData'
import { formatMs, formatRelative } from '../lib/format'
import { HealthBadge, Tag } from '../components/Badges'
import { useToast } from '../components/toast-context'
import { Button, Card, ErrorState, LoadingState, PageHeader, RefreshIcon, inputClass } from '../components/ui'

/** Upstream model ids from GET {base_url}/models — handy for picking the
 * current id of a free model before adding it to providers.yaml. */
function ModelList({ probe }) {
  const [q, setQ] = useState('')
  const toast = useToast()
  if (!probe) return null
  if (!probe.ok) {
    return (
      <p className="rounded-lg bg-red-50 px-3 py-2 text-sm break-all text-red-800">
        Check failed after {formatMs(probe.latency_ms)}: {probe.error}
      </p>
    )
  }
  const needle = q.trim().toLowerCase()
  const ids = needle ? probe.models.filter((m) => m.toLowerCase().includes(needle)) : probe.models
  const copy = async (id) => {
    try {
      await copyText(id)
      toast.success(`Copied ${id}`)
    } catch (err) {
      toast.error(err.message)
    }
  }
  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-600">
          Reachable in <b className="font-medium text-slate-900">{formatMs(probe.latency_ms)}</b> ·{' '}
          {probe.count} upstream models
        </p>
        {probe.count > 8 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter, e.g. free"
            dir="ltr" className={`${inputClass} sm:max-w-xs`} />
        )}
      </div>
      <ul className="mt-3 max-h-72 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
        {ids.slice(0, 500).map((id) => (
          <li key={id} className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="truncate font-mono text-xs text-slate-800">{id}</span>
            <button type="button" onClick={() => copy(id)}
              className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50">
              Copy
            </button>
          </li>
        ))}
        {!ids.length && <li className="px-3 py-4 text-center text-xs text-slate-500">No match</li>}
      </ul>
      <p className="mt-2 text-xs text-slate-500">
        Use an id as <code className="font-mono">model:</code> under <code className="font-mono">models</code> in providers.yaml.
      </p>
    </div>
  )
}

export default function Providers() {
  const { data, error, loading, refreshing, reload } = useApiData(() => api.overview(), { interval: 30000 })
  const [probes, setProbes] = useState({})
  const [busy, setBusy] = useState({})

  const check = async (name) => {
    setBusy((b) => ({ ...b, [name]: true }))
    try {
      const res = await api.probeProvider(name)
      setProbes((p) => ({ ...p, [name]: res }))
    } catch (err) {
      setProbes((p) => ({ ...p, [name]: { ok: false, error: err.message } }))
    } finally {
      setBusy((b) => ({ ...b, [name]: false }))
      reload({ silent: true })
    }
  }

  return (
    <>
      <PageHeader
        title="Providers"
        description="OpenAI-compatible endpoints from providers.yaml. Check reads /models only — it costs no generation quota."
        actions={
          <Button variant="secondary" onClick={() => reload()} loading={refreshing}>
            {!refreshing && <RefreshIcon />}
            Refresh
          </Button>
        }
      />

      {loading && <Card><LoadingState /></Card>}
      {!loading && error && <Card><ErrorState error={error} onRetry={reload} /></Card>}

      {!loading && !error && data && (
        <div className="space-y-4">
          {data.providers.map((p) => {
            const h = p.health
            return (
              <Card key={p.name} className="p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-slate-900">{p.name}</h2>
                      <HealthBadge health={h} />
                      {p.external ? <Tag tone="amber">external</Tag> : <Tag>LAN</Tag>}
                    </div>
                    <p className="mt-1 font-mono text-xs break-all text-slate-500">{p.base_url}</p>
                    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                      <div><dt className="text-slate-500">API key</dt><dd className="mt-0.5 font-mono text-slate-900">{p.key ?? 'none'}</dd></div>
                      <div><dt className="text-slate-500">Timeout</dt><dd className="mt-0.5 text-slate-900">{p.timeout} s</dd></div>
                      <div><dt className="text-slate-500">Last success</dt><dd className="mt-0.5 text-slate-900">{h.last_ok ? formatRelative(h.last_ok) : '—'}</dd></div>
                      <div><dt className="text-slate-500">Calls ok / failed</dt><dd className="mt-0.5 text-slate-900 tabular-nums">{h.successes} / {h.failures}</dd></div>
                      <div className="col-span-2 sm:col-span-4"><dt className="text-slate-500">Models</dt>
                        <dd className="mt-1 flex flex-wrap gap-1.5">
                          {p.models.length ? p.models.map((m) => <Tag key={m}>{m}</Tag>) : <span className="text-slate-400">none</span>}
                        </dd>
                      </div>
                    </dl>
                    {h.error && (
                      <p className={`mt-3 rounded-lg px-3 py-2 text-xs break-all ${h.status === 'ok' ? 'bg-slate-50 text-slate-600' : 'bg-red-50 text-red-800'}`}>
                        <span className="font-medium">Last error {formatRelative(h.last_error)}</span>
                        {h.status_code ? ` (HTTP ${h.status_code})` : ''}: {h.error}
                      </p>
                    )}
                  </div>
                  <Button variant="secondary" className="shrink-0" onClick={() => check(p.name)} loading={busy[p.name]}>
                    Check now
                  </Button>
                </div>
                {probes[p.name] && <div className="mt-4 border-t border-slate-100 pt-4"><ModelList probe={probes[p.name]} /></div>}
              </Card>
            )
          })}
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">Adding a provider</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-600">
              <li>Put its key in <code className="font-mono text-xs">/opt/llm-proxy/.env</code>, e.g. <code className="font-mono text-xs">FREEPROXY_API_KEY=…</code></li>
              <li>Add it under <code className="font-mono text-xs">providers</code> and its models under <code className="font-mono text-xs">models</code> in <code className="font-mono text-xs">providers.yaml</code> (see providers.example.yaml).</li>
              <li><code className="font-mono text-xs">systemctl restart llm-proxy</code> — then Check now, and pick model ids from the list.</li>
            </ol>
          </Card>
        </div>
      )}
    </>
  )
}
