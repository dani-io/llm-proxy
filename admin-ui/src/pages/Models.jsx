import { useState } from 'react'
import { api } from '../lib/api'
import { useApiData } from '../hooks/useApiData'
import { formatMs, formatNumber, formatRelative, isRtl } from '../lib/format'
import { HealthBadge, Tag } from '../components/Badges'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ModelForm } from '../components/ConfigForms'
import { useToast } from '../components/toast-context'
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
        <p className="font-medium">Failed{result.status ? ` — HTTP ${result.status}` : ''}{result.latency_ms != null ? ` after ${formatMs(result.latency_ms)}` : ''}</p>
        <pre className="mt-1 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap break-all">{result.error}</pre>
      </div>
    )
  }
  const u = result.usage || {}
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
        <span>Latency <b className="font-medium text-slate-900 tabular-nums">{formatMs(result.latency_ms)}</b></span>
        {result.tokens_per_s && <span>Speed <b className="font-medium text-slate-900 tabular-nums">{result.tokens_per_s} tok/s</b></span>}
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
  const cfg = useApiData(() => api.config(), { interval: 30000 })
  const ov = useApiData(() => api.overview(), { interval: 30000 })
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [results, setResults] = useState({})
  const [dialog, setDialog] = useState(null) // {kind: 'model'|'delete', model?}
  const [busy, setBusy] = useState('')
  const toast = useToast()

  const live = Object.fromEntries((ov.data?.models ?? []).map((m) => [m.id, m]))
  const onSaved = (newCfg) => {
    cfg.setData(newCfg)
    ov.reload({ silent: true })
  }

  const test = async (alias) => {
    setResults((r) => ({ ...r, [alias]: { running: true } }))
    try {
      const res = await api.testModel(alias, prompt.trim() || DEFAULT_PROMPT)
      setResults((r) => ({ ...r, [alias]: res }))
    } catch (err) {
      setResults((r) => ({ ...r, [alias]: { ok: false, error: err.message } }))
    }
    ov.reload({ silent: true })
  }

  const makeDefault = async (alias) => {
    setBusy(alias)
    try {
      onSaved(await api.setDefault(alias))
      toast.success(`${alias} is now the default model`)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy('')
    }
  }

  const doDelete = async () => {
    setBusy('delete')
    try {
      onSaved(await api.deleteModel(dialog.model.alias))
      toast.success(`Deleted ${dialog.model.alias}`)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy('')
      setDialog(null)
    }
  }

  const testAll = () => cfg.data?.models.filter((m) => m.active).forEach((m) => test(m.alias))
  const del = dialog?.kind === 'delete' ? dialog.model : null
  const delBlocked = del && (cfg.data?.default_model === del.alias || del.used_as_fallback_by.length)

  return (
    <>
      <PageHeader
        title="Models"
        description="Names clients send as model. Changes apply immediately. A test is one direct call — no tools, no fallback."
        actions={
          <>
            <Button variant="secondary" onClick={() => { cfg.reload(); ov.reload() }} loading={cfg.refreshing}>
              {!cfg.refreshing && <RefreshIcon />}
              Refresh
            </Button>
            <Button variant="secondary" onClick={testAll} disabled={!cfg.data}>Test all</Button>
            <Button onClick={() => setDialog({ kind: 'model' })} disabled={!cfg.data}>Add model</Button>
          </>
        }
      />

      <Card className="mb-6 p-5">
        <Field label="Test prompt" htmlFor="test-prompt" hint="Sent as a single user message, max 120 tokens. Tests update health and show in Requests, but not in Usage.">
          <input id="test-prompt" dir="auto" value={prompt} onChange={(e) => setPrompt(e.target.value)} className={inputClass} />
        </Field>
      </Card>

      {cfg.loading && <Card><LoadingState /></Card>}
      {!cfg.loading && cfg.error && <Card><ErrorState error={cfg.error} onRetry={cfg.reload} /></Card>}

      {!cfg.loading && !cfg.error && cfg.data && (
        <div className="space-y-4">
          {cfg.data.models.map((m) => {
            const l = live[m.alias]
            const h = l?.health ?? {}
            const u = l?.usage_24h
            const isDefault = cfg.data.active_default === m.alias
            return (
              <Card key={m.alias} className={`p-5 ${m.active ? '' : 'border-dashed'}`}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-mono text-base font-semibold text-slate-900">{m.alias}</h2>
                      {m.active ? <HealthBadge health={h} /> : <Tag tone="amber">inactive</Tag>}
                      {isDefault && <Tag tone="blue">default</Tag>}
                      {l?.external && <Tag tone="amber" title="Prompts leave the LAN">external</Tag>}
                      {m.tools ? <Tag title="web_search + fetch_url are offered">tools</Tag> : <Tag>no tools</Tag>}
                    </div>
                    {m.description && <p className="mt-1 text-sm text-slate-500">{m.description}</p>}
                    {!m.active && m.skipped_reason && (
                      <p className="mt-2 text-xs text-amber-800">Inactive: {m.skipped_reason} — set its key on the Providers page.</p>
                    )}
                    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                      <div><dt className="text-slate-500">Provider</dt><dd className="mt-0.5 font-mono text-slate-900">{m.provider}</dd></div>
                      <div><dt className="text-slate-500">Upstream id</dt><dd className="mt-0.5 truncate font-mono text-slate-900" title={m.model}>{m.model}</dd></div>
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
                  <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-stretch">
                    <Button variant="secondary" onClick={() => test(m.alias)} loading={results[m.alias]?.running} disabled={!m.active}>Test</Button>
                    {!isDefault && (
                      <Button variant="secondary" onClick={() => makeDefault(m.alias)} loading={busy === m.alias} disabled={!m.active}>Make default</Button>
                    )}
                    <Button variant="ghost" onClick={() => setDialog({ kind: 'model', model: m })}>Edit</Button>
                    <Button variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setDialog({ kind: 'delete', model: m })}>Delete</Button>
                  </div>
                </div>
                {results[m.alias] && <div className="mt-4 border-t border-slate-100 pt-4"><TestResult result={results[m.alias]} /></div>}
              </Card>
            )
          })}
        </div>
      )}

      {dialog?.kind === 'model' && cfg.data && (
        <ModelForm model={dialog.model} config={cfg.data} onClose={() => setDialog(null)} onSaved={onSaved} />
      )}
      <ConfirmDialog
        open={Boolean(del)}
        title={`Delete model ${del?.alias ?? ''}?`}
        message={
          !del ? '' :
          cfg.data?.default_model === del.alias ? `${del.alias} is the default model — make another model the default first.` :
          del.used_as_fallback_by.length ? `${del.alias} is the fallback of ${del.used_as_fallback_by.join(', ')} — change their fallback first.` :
          `Clients sending model "${del.alias}" will get the default model (${cfg.data?.active_default}) instead. A backup of providers.yaml is kept.`
        }
        confirmLabel={delBlocked ? 'OK' : 'Delete'}
        tone={delBlocked ? 'primary' : 'danger'}
        busy={busy === 'delete'}
        onConfirm={delBlocked ? () => setDialog(null) : doDelete}
        onCancel={() => setDialog(null)}
      />
    </>
  )
}
