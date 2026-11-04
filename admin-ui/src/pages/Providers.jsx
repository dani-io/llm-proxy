import { useState } from 'react'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { useApiData } from '../hooks/useApiData'
import { formatMs, formatRelative } from '../lib/format'
import { HealthBadge, Tag } from '../components/Badges'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { KeyForm, ModelForm, ProviderForm, suggestAlias } from '../components/ConfigForms'
import { useToast } from '../components/toast-context'
import { Button, Card, ErrorState, LoadingState, PageHeader, RefreshIcon, inputClass } from '../components/ui'

/** Upstream model ids from GET {base_url}/models, with Add / Copy per id. */
function ModelList({ probe, onAdd, existing }) {
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
          Reachable in <b className="font-medium text-slate-900">{formatMs(probe.latency_ms)}</b> · {probe.count} upstream models
        </p>
        {probe.count > 8 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter, e.g. free" dir="ltr" className={`${inputClass} sm:max-w-xs`} />
        )}
      </div>
      <ul className="mt-3 max-h-72 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
        {ids.slice(0, 500).map((id) => (
          <li key={id} className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="truncate font-mono text-xs text-slate-800">{id}</span>
            <span className="flex shrink-0 items-center gap-1">
              {existing.has(id) && <Tag tone="blue">in use</Tag>}
              <button type="button" onClick={() => onAdd(id)} className="rounded px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50">Add</button>
              <button type="button" onClick={() => copy(id)} className="rounded px-2 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100">Copy</button>
            </span>
          </li>
        ))}
        {!ids.length && <li className="px-3 py-4 text-center text-xs text-slate-500">No match</li>}
      </ul>
    </div>
  )
}

function KeyStatus({ p }) {
  if (!p.key.required && !p.key.set) return <span className="text-slate-500">not needed</span>
  if (!p.key.set) return <span className="font-medium text-amber-700">missing</span>
  return (
    <span className="font-mono text-slate-900">
      {p.key.hint} <span className="font-sans text-slate-400">({p.key.source === 'panel' ? 'panel' : '.env'})</span>
    </span>
  )
}

export default function Providers() {
  const cfg = useApiData(() => api.config(), { interval: 30000 })
  const ov = useApiData(() => api.overview(), { interval: 30000 })
  const [probes, setProbes] = useState({})
  const [busy, setBusy] = useState({})
  const [dialog, setDialog] = useState(null) // {kind, provider?, preset?}
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()

  const health = Object.fromEntries((ov.data?.providers ?? []).map((p) => [p.name, p.health]))
  const onSaved = (newCfg) => {
    cfg.setData(newCfg)
    ov.reload({ silent: true })
  }

  const check = async (name) => {
    setBusy((b) => ({ ...b, [name]: true }))
    try {
      const res = await api.probeProvider(name)
      setProbes((p) => ({ ...p, [name]: res }))
    } catch (err) {
      setProbes((p) => ({ ...p, [name]: { ok: false, error: err.message } }))
    } finally {
      setBusy((b) => ({ ...b, [name]: false }))
      ov.reload({ silent: true })
    }
  }

  const doDelete = async () => {
    setDeleting(true)
    try {
      onSaved(await api.deleteProvider(dialog.provider.name))
      toast.success(`Deleted ${dialog.provider.name}`)
      setDialog(null)
    } catch (err) {
      toast.error(err.message)
      setDialog(null)
    } finally {
      setDeleting(false)
    }
  }

  const refresh = () => {
    cfg.reload()
    ov.reload()
  }

  return (
    <>
      <PageHeader
        title="Providers"
        description="OpenAI-compatible endpoints. Changes apply immediately — no restart. Check now reads /models only, no generation quota."
        actions={
          <>
            <Button variant="secondary" onClick={refresh} loading={cfg.refreshing}>
              {!cfg.refreshing && <RefreshIcon />}
              Refresh
            </Button>
            <Button onClick={() => setDialog({ kind: 'provider' })} disabled={!cfg.data}>Add provider</Button>
          </>
        }
      />

      {cfg.loading && <Card><LoadingState /></Card>}
      {!cfg.loading && cfg.error && <Card><ErrorState error={cfg.error} onRetry={cfg.reload} /></Card>}

      {!cfg.loading && !cfg.error && cfg.data && (
        <div className="space-y-4">
          {cfg.data.providers.map((p) => {
            const h = health[p.name]
            const existing = new Set(cfg.data.models.filter((m) => m.provider === p.name).map((m) => m.model))
            return (
              <Card key={p.name} className={`p-5 ${p.active ? '' : 'border-dashed'}`}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-slate-900">{p.name}</h2>
                      {p.active ? <HealthBadge health={h} /> : <Tag tone="amber">inactive</Tag>}
                      {p.external ? <Tag tone="amber">external</Tag> : <Tag>LAN</Tag>}
                    </div>
                    <p className="mt-1 font-mono text-xs break-all text-slate-500">{p.base_url}</p>
                    {!p.active && p.skipped_reason && (
                      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        Inactive: {p.skipped_reason}.{' '}
                        <button type="button" onClick={() => setDialog({ kind: 'key', provider: p })} className="font-medium underline">Set a key</button>
                      </p>
                    )}
                    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                      <div><dt className="text-slate-500">API key</dt><dd className="mt-0.5"><KeyStatus p={p} /></dd></div>
                      <div><dt className="text-slate-500">Timeout</dt><dd className="mt-0.5 text-slate-900">{p.timeout} s</dd></div>
                      <div><dt className="text-slate-500">Last success</dt><dd className="mt-0.5 text-slate-900">{h?.last_ok ? formatRelative(h.last_ok) : '—'}</dd></div>
                      <div><dt className="text-slate-500">Calls ok / failed</dt><dd className="mt-0.5 text-slate-900 tabular-nums">{h ? `${h.successes} / ${h.failures}` : '—'}</dd></div>
                      <div className="col-span-2 sm:col-span-4"><dt className="text-slate-500">Models</dt>
                        <dd className="mt-1 flex flex-wrap gap-1.5">
                          {p.models.length ? p.models.map((m) => <Tag key={m}>{m}</Tag>) : <span className="text-slate-400">none yet — Check now, then Add from the list</span>}
                        </dd>
                      </div>
                    </dl>
                    {h?.error && (
                      <p className={`mt-3 rounded-lg px-3 py-2 text-xs break-all ${h.status === 'ok' ? 'bg-slate-50 text-slate-600' : 'bg-red-50 text-red-800'}`}>
                        <span className="font-medium">Last error {formatRelative(h.last_error)}</span>
                        {h.status_code ? ` (HTTP ${h.status_code})` : ''}: {h.error}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-stretch">
                    <Button variant="secondary" onClick={() => check(p.name)} loading={busy[p.name]} disabled={!p.active}>Check now</Button>
                    <Button variant="secondary" onClick={() => setDialog({ kind: 'key', provider: p })}>{p.key.set ? 'Key' : 'Set key'}</Button>
                    <Button variant="ghost" onClick={() => setDialog({ kind: 'provider', provider: p })}>Edit</Button>
                    <Button variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setDialog({ kind: 'delete', provider: p })}>Delete</Button>
                  </div>
                </div>
                {probes[p.name] && (
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <ModelList probe={probes[p.name]} existing={existing}
                      onAdd={(id) => setDialog({ kind: 'model', preset: { provider: p.name, model: id, alias: suggestAlias(id) } })} />
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {dialog?.kind === 'provider' && (
        <ProviderForm provider={dialog.provider} onClose={() => setDialog(null)} onSaved={onSaved} />
      )}
      {dialog?.kind === 'key' && <KeyForm provider={dialog.provider} onClose={() => setDialog(null)} onSaved={onSaved} />}
      {dialog?.kind === 'model' && cfg.data && (
        <ModelForm preset={dialog.preset} config={cfg.data} onClose={() => setDialog(null)} onSaved={onSaved} />
      )}
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title={`Delete provider ${dialog?.provider?.name ?? ''}?`}
        message={dialog?.provider?.models.length
          ? `It is still used by ${dialog.provider.models.join(', ')} — delete or move those models first.`
          : 'It is removed from providers.yaml (a backup is kept). A key stored in the panel for it is removed too.'}
        confirmLabel="Delete"
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => setDialog(null)}
      />
    </>
  )
}
