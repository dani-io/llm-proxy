import { useState } from 'react'
import { api } from '../lib/api'
import { useApiData } from '../hooks/useApiData'
import { formatMs, formatNumber, formatRelative, isRtl } from '../lib/format'
import { HealthBadge, Tag } from '../components/Badges'
import { Button, Card, ErrorState, Field, LoadingState, PageHeader, RefreshIcon, Spinner, inputClass } from '../components/ui'

const DEFAULT_PROMPT = 'Reply with one short sentence: which model are you?'

function TestResult({ result }) {
  if (!result) return null
  if (result.running) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner className="h-4 w-4 text-blue-600" /> Waiting for the model…
      </div>
    )
  }
  if (!result.ok) {
    return (
      <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800">
        <p className="font-medium">
          Failed{result.status ? ` — HTTP ${result.status}` : ''} after {formatMs(result.latency_ms)}
        </p>
        <pre className="mt-1 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap break-all">{result.error}</pre>
      </div>
    )
  }
  const u = result.usage || {}
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
        <span>Latency <b className="font-medium text-slate-900 tabular-nums">{formatMs(result.latency_ms)}</b></span>
        {result.tokens_per_s && (
          <span>Speed <b className="font-medium text-slate-900 tabular-nums">{result.tokens_per_s} tok/s</b></span>
        )}
        {u.completion_tokens !== undefined && (
          <span>Tokens <b className="font-medium text-slate-900 tabular-nums">{u.prompt_tokens} in · {u.completion_tokens} out</b></span>
        )}
        {result.upstream_model && <span className="font-mono">{result.upstream_model}</span>}
        {result.reasoning && <Tag tone="violet" title="The model returned a reasoning trace">reasoning</Tag>}
      </div>
      <p dir="auto" className={`msg-body mt-2 text-sm text-slate-900 ${isRtl(result.content) ? 'text-right' : ''}`}>
        {result.content || <span className="text-slate-400 italic">(empty content)</span>}
      </p>
    </div>
  )
}

export default function Models() {
  const { data, error, loading, refreshing, reload } = useApiData(() => api.overview(), { interval: 30000 })
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [results, setResults] = useState({})

  const test = async (alias) => {
    setResults((r) => ({ ...r, [alias]: { running: true } }))
    try {
      const res = await api.testModel(alias, prompt.trim() || DEFAULT_PROMPT)
      setResults((r) => ({ ...r, [alias]: res }))
    } catch (err) {
      setResults((r) => ({ ...r, [alias]: { ok: false, error: err.message } }))
    }
    reload({ silent: true })
  }

  const testAll = () => data?.models.forEach((m) => test(m.id))

  return (
    <>
      <PageHeader
        title="Models"
        description="Aliases clients can send as model. A test is one direct call — no tools, no fallback."
        actions={
          <>
            <Button variant="secondary" onClick={() => reload()} loading={refreshing}>
              {!refreshing && <RefreshIcon />}
              Refresh
            </Button>
            <Button onClick={testAll} disabled={!data}>Test all</Button>
          </>
        }
      />

      <Card className="mb-6 p-5">
        <Field label="Test prompt" htmlFor="test-prompt" hint="Sent as a single user message, max 120 tokens. Tests show up in health but not in usage stats.">
          <input id="test-prompt" dir="auto" value={prompt} onChange={(e) => setPrompt(e.target.value)} className={inputClass} />
        </Field>
      </Card>

      {loading && <Card><LoadingState /></Card>}
      {!loading && error && <Card><ErrorState error={error} onRetry={reload} /></Card>}

      {!loading && !error && data && (
        <div className="space-y-4">
          {data.models.map((m) => {
            const h = m.health
            const u = m.usage_24h
            return (
              <Card key={m.id} className="p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-mono text-base font-semibold text-slate-900">{m.id}</h2>
                      <HealthBadge health={h} />
                      {m.default && <Tag tone="blue">default</Tag>}
                      {m.external && <Tag tone="amber" title="Prompts leave the LAN">external</Tag>}
                      {m.tools ? <Tag title="web_search + fetch_url are offered">tools</Tag> : <Tag>no tools</Tag>}
                    </div>
                    {m.description && <p className="mt-1 text-sm text-slate-500">{m.description}</p>}
                    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                      <div><dt className="text-slate-500">Provider</dt><dd className="mt-0.5 font-mono text-slate-900">{m.owned_by}</dd></div>
                      <div className="col-span-1 sm:col-span-1"><dt className="text-slate-500">Upstream id</dt><dd className="mt-0.5 truncate font-mono text-slate-900" title={m.upstream_model}>{m.upstream_model}</dd></div>
                      <div><dt className="text-slate-500">Fallback</dt><dd className="mt-0.5 font-mono text-slate-900">{m.fallback ?? '—'}</dd></div>
                      <div><dt className="text-slate-500">Requests / 24h</dt><dd className="mt-0.5 text-slate-900 tabular-nums">{formatNumber(u?.requests)}{u?.errors ? <span className="text-red-600"> · {u.errors} err</span> : null}</dd></div>
                      <div><dt className="text-slate-500">Last success</dt><dd className="mt-0.5 text-slate-900">{h.last_ok ? formatRelative(h.last_ok) : '—'}</dd></div>
                      <div><dt className="text-slate-500">Last latency</dt><dd className="mt-0.5 text-slate-900 tabular-nums">{formatMs(h.latency_ms)}</dd></div>
                      <div className="col-span-2"><dt className="text-slate-500">Last error</dt>
                        <dd className="mt-0.5 truncate text-slate-900" title={h.error ?? ''}>
                          {h.last_error ? <><span className="text-slate-500">{formatRelative(h.last_error)}</span> {h.error}</> : '—'}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <Button variant="secondary" className="shrink-0" onClick={() => test(m.id)} loading={results[m.id]?.running}>
                    Test
                  </Button>
                </div>
                {results[m.id] && <div className="mt-4 border-t border-slate-100 pt-4"><TestResult result={results[m.id]} /></div>}
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}
