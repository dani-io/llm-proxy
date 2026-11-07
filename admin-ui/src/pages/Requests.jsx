import { useState } from 'react'
import { api } from '../lib/api'
import { useApiData } from '../hooks/useApiData'
import { formatMs, formatNumber, formatRelative, formatTimestamp } from '../lib/format'
import { StatusBadge, Tag } from '../components/Badges'
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, RefreshIcon, inputClass } from '../components/ui'

const PAGE = 50
const selectClass = inputClass.replace('block w-full', 'block w-auto')

function Row({ r }) {
  const [open, setOpen] = useState(false)
  const mismatch = r.requested && r.requested !== r.model
  return (
    <>
      <tr onClick={() => setOpen((v) => !v)} className="cursor-pointer hover:bg-slate-50">
        <td className="px-4 py-2.5 whitespace-nowrap text-xs text-slate-500" title={formatTimestamp(r.ts)}>{formatRelative(r.ts)}</td>
        <td className="px-4 py-2.5 whitespace-nowrap text-xs">
          {r.key_name ? (
            <span className="font-medium text-slate-900">{r.key_name}</span>
          ) : r.key_id ? (
            <span className="text-slate-400">key #{r.key_id} (deleted)</span>
          ) : r.source === 'test' ? (
            <span className="text-slate-400">panel</span>
          ) : (
            <span className="text-slate-400">no key</span>
          )}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          <span className="font-mono text-xs text-slate-900">{r.model ?? '—'}</span>
          {r.fallback ? <span className="ml-1.5"><Tag tone="amber" title="Started on another model, served by its fallback">fallback</Tag></span> : null}
          {mismatch && !r.fallback && <span className="ml-1 font-mono text-[11px] text-slate-400" title="Name the client sent">({r.requested})</span>}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          <span className="flex items-center gap-1.5">
            <StatusBadge status={r.status} />
            {r.source === 'test' && <Tag>test</Tag>}
            {r.stream ? <Tag title="Streaming">stream</Tag> : null}
          </span>
        </td>
        <td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums text-xs text-slate-900">
          {formatMs(r.latency_ms)}
          {r.ttft_ms != null && <span className="block text-[11px] text-slate-400">first token {formatMs(r.ttft_ms)}</span>}
        </td>
        <td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums text-xs text-slate-900">
          {formatNumber(r.prompt_tokens)} <span className="text-slate-400">/</span> {formatNumber(r.completion_tokens)}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap text-xs text-slate-600">
          {r.tool_calls ? `${r.tool_calls}× ${r.tools ?? ''}` : <span className="text-slate-300">—</span>}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap font-mono text-xs text-slate-500">{r.client ?? '—'}</td>
        <td className="max-w-xs truncate px-4 py-2.5 text-xs text-red-600" title={r.error ?? ''}>{r.error ?? ''}</td>
      </tr>
      {open && (
        <tr className="bg-slate-50">
          <td colSpan={9} className="px-4 py-3">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
              <div><dt className="text-slate-500">Time</dt><dd className="mt-0.5 text-slate-900">{formatTimestamp(r.ts)}</dd></div>
              <div><dt className="text-slate-500">Client asked for</dt><dd className="mt-0.5 font-mono text-slate-900">{r.requested ?? '(none)'}</dd></div>
              <div><dt className="text-slate-500">Served by</dt><dd className="mt-0.5 font-mono text-slate-900">{r.model} @ {r.provider}</dd></div>
              <div><dt className="text-slate-500">Upstream turns</dt><dd className="mt-0.5 text-slate-900">{r.turns}</dd></div>
              {r.error && <div className="col-span-2 sm:col-span-4"><dt className="text-slate-500">Error</dt><dd className="mt-0.5 font-mono break-all whitespace-pre-wrap text-red-700">{r.error}</dd></div>}
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}

export default function Requests() {
  const [model, setModel] = useState('')
  const [status, setStatus] = useState('')
  const [keyId, setKeyId] = useState('')
  const [older, setOlder] = useState([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [done, setDone] = useState(false)
  const overview = useApiData(() => api.overview())
  const keyList = useApiData(() => api.listKeys())

  const latest = useApiData(
    async () => {
      const res = await api.requests({ limit: PAGE, model, status, keyId })
      setOlder([])
      setDone(res.items.length < PAGE)
      return res
    },
    // Live-refresh only while viewing the newest page.
    { interval: older.length ? 0 : 10000, deps: [model, status, keyId] },
  )
  const items = [...(latest.data?.items ?? []), ...older]

  const more = async () => {
    const last = items[items.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const res = await api.requests({ limit: PAGE, beforeId: last.id, model, status, keyId })
      setOlder((o) => [...o, ...res.items])
      setDone(res.items.length < PAGE)
    } finally {
      setLoadingMore(false)
    }
  }

  const models = overview.data?.models.map((m) => m.id) ?? []

  return (
    <>
      <PageHeader
        title="Requests"
        description="Metadata only — prompts and answers are never stored. Click a row for details."
        actions={
          <>
            <select value={keyId} onChange={(e) => setKeyId(e.target.value)} className={selectClass} aria-label="Filter by API key">
              <option value="">All keys</option>
              {(keyList.data?.keys ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              <option value="0">No key</option>
            </select>
            <select value={model} onChange={(e) => setModel(e.target.value)} className={selectClass} aria-label="Filter by model">
              <option value="">All models</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass} aria-label="Filter by status">
              <option value="">Any status</option>
              <option value="ok">ok</option>
              <option value="error">error</option>
              <option value="client_tool">client tool</option>
            </select>
            <Button variant="secondary" onClick={() => latest.reload()} loading={latest.refreshing}>
              {!latest.refreshing && <RefreshIcon />}
              Refresh
            </Button>
          </>
        }
      />

      <Card className="overflow-hidden">
        {latest.loading && <LoadingState />}
        {!latest.loading && latest.error && <ErrorState error={latest.error} onRetry={latest.reload} />}
        {!latest.loading && !latest.error && !items.length && (
          <EmptyState title="No requests yet" description="Send something to the model API and it shows up here." />
        )}
        {!latest.loading && !latest.error && items.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">When</th>
                    <th className="px-4 py-2 font-medium">Key</th>
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Latency</th>
                    <th className="px-4 py-2 text-right font-medium whitespace-nowrap">Tokens in / out</th>
                    <th className="px-4 py-2 font-medium">Server tools</th>
                    <th className="px-4 py-2 font-medium">Client</th>
                    <th className="px-4 py-2 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((r) => <Row key={r.id} r={r} />)}
                </tbody>
              </table>
            </div>
            {!done && (
              <div className="border-t border-slate-100 p-3 text-center">
                <Button variant="ghost" onClick={more} loading={loadingMore}>Load older</Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  )
}
