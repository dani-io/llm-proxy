import { useState } from 'react'
import { api } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { formatCompact, formatNumber, formatRelative } from '../lib/format'
import { useApiData } from '../hooks/useApiData'
import { useToast } from '../components/toast-context'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Modal } from '../components/Modal'
import { Tag } from '../components/Badges'
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  RefreshIcon,
  inputClass,
} from '../components/ui'

const STATE_STYLES = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  disabled: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  expired: 'bg-amber-50 text-amber-700 ring-amber-600/20',
}

function StateBadge({ state }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATE_STYLES[state]}`}
    >
      {state}
    </span>
  )
}

/** The model API address as clients see it (llm-admin.bp → llm.bp). */
function apiBase() {
  const { protocol, hostname } = window.location
  if (hostname.startsWith('llm-admin.')) return `${protocol}//${hostname.replace(/^llm-admin\./, 'llm.')}/v1`
  return `${protocol}//${hostname}:8000/v1`
}

// ── Token amounts: accept 200000, 200k, 1.5M ──

function parseTokens(value) {
  const v = String(value ?? '').trim().toLowerCase().replace(/[, _]/g, '')
  if (!v) return null
  const m = v.match(/^(\d+(?:\.\d+)?)([km]?)$/)
  if (!m) return NaN
  const n = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1)
  return n >= 1 ? Math.round(n) : NaN
}

function tokensInput(n) {
  if (!n) return ''
  if (n % 1e6 === 0) return `${n / 1e6}M`
  if (n % 1e3 === 0) return `${n / 1e3}k`
  return String(n)
}

function UsageBar({ used, limit, label }) {
  if (!limit) {
    return (
      <div className="min-w-32">
        <p className="text-slate-400">{label}</p>
        <p className="text-sm text-slate-700">
          <span className="font-semibold tabular-nums">{formatCompact(used)}</span>
          <span className="text-slate-400"> · no limit</span>
        </p>
      </div>
    )
  }
  const pct = Math.min(100, Math.round((used / limit) * 100))
  const color = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-blue-600'
  return (
    <div className="min-w-32" title={`${formatNumber(used)} / ${formatNumber(limit)} tokens`}>
      <p className="text-slate-400">{label}</p>
      <p className="text-sm text-slate-700">
        <span className="font-semibold tabular-nums">{formatCompact(used)}</span>
        <span className="tabular-nums text-slate-400"> / {formatCompact(limit)}</span>
      </p>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function ModelChips({ keyRow }) {
  if (keyRow.models === null) {
    return <Tag tone="blue" title="Every model, including ones added later">all models</Tag>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {keyRow.models.map((m) => {
        const missing = keyRow.missing_models.includes(m)
        return (
          <span
            key={m}
            title={missing ? 'Not an active model right now' : undefined}
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
              missing ? 'bg-slate-50 text-slate-400 line-through' : 'bg-slate-100 text-slate-700'
            }`}
          >
            {m}
          </span>
        )
      })}
    </div>
  )
}

// ── Date helpers (expiry is a unix timestamp) ──

function toDateInput(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** End of the chosen day, in the browser's (Tehran) time. */
function fromDateInput(value) {
  if (!value) return null
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000
}

function daysFromNow(days) {
  return toDateInput(Date.now() / 1000 + days * 86400)
}

function expiryLabel(key) {
  if (!key.expires_at) return 'Never'
  const days = Math.ceil((key.expires_at * 1000 - Date.now()) / 86400000)
  if (days < 0) return `Expired ${formatRelative(key.expires_at)}`
  if (days === 0) return 'Today'
  return `${toDateInput(key.expires_at)} · ${days}d left`
}

// ── Create / edit form ──

const EMPTY_FORM = {
  name: '',
  allModels: false,
  models: [],
  tools: true,
  daily: '',
  monthly: '',
  expires: '',
  note: '',
}

function formFromKey(key) {
  return {
    name: key.name,
    allModels: key.models === null,
    models: key.models ?? [],
    tools: key.tools,
    daily: tokensInput(key.daily_tokens),
    monthly: tokensInput(key.monthly_tokens),
    expires: toDateInput(key.expires_at),
    note: key.note ?? '',
  }
}

function KeyForm({ form, setForm, models }) {
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const toggleModel = (id) =>
    set({ models: form.models.includes(id) ? form.models.filter((m) => m !== id) : [...form.models, id] })
  // Models the key has but that are not active now still show, so they can be unticked.
  const extra = form.models.filter((m) => !models.some((x) => x.id === m)).map((id) => ({ id, missing: true }))

  return (
    <div className="space-y-4">
      <Field label="Project name" htmlFor="key-name" hint="e.g. mindgo, exportnet, lingox">
        <input
          id="key-name"
          dir="ltr"
          required
          maxLength={40}
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          className={inputClass}
        />
      </Field>

      <div>
        <p className="text-sm font-medium text-slate-700">Models</p>
        <div className="mt-2 inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="group">
          {[
            [false, 'Only these'],
            [true, 'All models'],
          ].map(([value, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => set({ allModels: value })}
              aria-pressed={form.allModels === value}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                form.allModels === value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {form.allModels ? (
          <p className="mt-2 text-xs text-slate-500">
            Every model, including models added later. Fallbacks follow the normal chain.
          </p>
        ) : (
          <>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {[...models, ...extra].map((m) => (
                <label
                  key={m.id}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm ${
                    form.models.includes(m.id) ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={form.models.includes(m.id)}
                    onChange={() => toggleModel(m.id)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                  />
                  <span className="min-w-0">
                    <span className="font-mono text-xs font-semibold text-slate-900">{m.id}</span>
                    {m.external && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800">
                        external
                      </span>
                    )}
                    {m.missing && (
                      <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500">
                        inactive
                      </span>
                    )}
                    {m.upstream_model && (
                      <span className="block truncate font-mono text-[11px] text-slate-500">
                        {m.owned_by} / {m.upstream_model}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              If a model fails, its fallback is used only when this key may use it too. External models
              send prompts outside the LAN.
            </p>
          </>
        )}
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
        <input
          type="checkbox"
          checked={form.tools}
          onChange={(e) => set({ tools: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
        />
        <span>
          <span className="font-medium text-slate-900">Server tools</span>
          <span className="block text-xs text-slate-500">
            Offer <code className="font-mono">web_search</code> and <code className="font-mono">fetch_url</code>,
            run by the proxy. The project's own tools always pass through.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Daily token limit" htmlFor="key-daily" hint="Input + output, resets 00:00 Tehran. e.g. 200k">
          <input
            id="key-daily"
            dir="ltr"
            value={form.daily}
            onChange={(e) => set({ daily: e.target.value })}
            placeholder="No limit"
            className={inputClass}
          />
        </Field>
        <Field label="30-day token limit" htmlFor="key-monthly" hint="Over the last 30 days, today included. e.g. 3M">
          <input
            id="key-monthly"
            dir="ltr"
            value={form.monthly}
            onChange={(e) => set({ monthly: e.target.value })}
            placeholder="No limit"
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Expires" htmlFor="key-expires" hint="Empty = never expires.">
        <input
          id="key-expires"
          type="date"
          dir="ltr"
          value={form.expires}
          onChange={(e) => set({ expires: e.target.value })}
          className={inputClass}
        />
        <div className="mt-1.5 flex flex-wrap gap-1">
          {[
            ['30d', 30],
            ['90d', 90],
            ['1y', 365],
          ].map(([label, days]) => (
            <button
              key={label}
              type="button"
              onClick={() => set({ expires: daysFromNow(days) })}
              className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => set({ expires: '' })}
            className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
          >
            never
          </button>
        </div>
      </Field>

      <Field label="Note" htmlFor="key-note" hint="Optional — where this key is used.">
        <textarea
          id="key-note"
          rows={2}
          maxLength={500}
          value={form.note}
          onChange={(e) => set({ note: e.target.value })}
          className={inputClass}
        />
      </Field>
    </div>
  )
}

/** Form → request body, or throws a message the toast can show. */
function formToBody(form, isNew) {
  const daily = parseTokens(form.daily)
  const monthly = parseTokens(form.monthly)
  if (Number.isNaN(daily) || Number.isNaN(monthly)) throw new Error('Token limits must be numbers like 200000, 200k or 1.5M')
  if (!form.allModels && form.models.length === 0) throw new Error('Pick at least one model, or choose “All models”')
  const body = {
    name: form.name.trim(),
    tools: form.tools,
    note: form.note.trim() || null,
  }
  if (isNew) {
    body.models = form.allModels ? null : form.models
    body.daily_tokens = daily
    body.monthly_tokens = monthly
    body.expires_at = fromDateInput(form.expires)
  } else {
    // PATCH: 0 clears a limit / the expiry
    if (form.allModels) body.all_models = true
    else body.models = form.models
    body.daily_tokens = daily ?? 0
    body.monthly_tokens = monthly ?? 0
    body.expires_at = fromDateInput(form.expires) ?? 0
  }
  return body
}

// ── One-time reveal of a new key ──

function RevealKey({ secret, onClose }) {
  const toast = useToast()
  const copy = async (text, what) => {
    try {
      await copyText(text)
      toast.success(`${what} copied`)
    } catch (err) {
      toast.error(err.message)
    }
  }
  const base = apiBase()
  const example = `import os\nfrom openai import OpenAI\n\nclient = OpenAI(base_url="${base}", api_key=os.environ["LLM_API_KEY"])`

  return (
    <Modal
      open={Boolean(secret)}
      title={secret?.rotated ? `New key for “${secret?.name}”` : `Key created: ${secret?.name}`}
      onClose={onClose}
      wide
      footer={<Button onClick={onClose}>I stored it</Button>}
    >
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
        This is the only time the key is shown. Store it in Bitwarden now — it can't be recovered, only rotated.
        {secret?.rotated && ' The previous key has stopped working.'}
      </p>
      <div className="mt-4 flex gap-2">
        <input
          readOnly
          dir="ltr"
          value={secret?.key ?? ''}
          onFocus={(e) => e.target.select()}
          className={`${inputClass} font-mono text-xs`}
        />
        <Button variant="secondary" onClick={() => copy(secret.key, 'Key')}>
          Copy
        </Button>
      </div>
      <div className="mt-4 space-y-2 text-xs text-slate-600">
        <p>
          In the project's Coolify env, set <code className="font-mono">LLM_API_KEY</code> (as a secret) and point
          its OpenAI client at <code className="font-mono">{base}</code>:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100" dir="ltr">
          {example}
        </pre>
      </div>
    </Modal>
  )
}

// ── Usage by project (includes requests without a key and deleted keys) ──

function ProjectUsage({ data }) {
  const rows = [
    ...data.keys.map((k) => ({ id: k.id, name: k.name, ...k.usage })),
    ...data.other.map((o) => ({
      id: `o${o.key_id}`,
      name: o.key_id === 0 ? null : `key #${o.key_id}`,
      deleted: o.deleted,
      today_requests: o.today_requests,
      today_tokens: o.today_tokens,
      week_tokens: o.week_tokens,
      month_requests: o.month_requests,
      month_tokens: o.month_tokens,
      month_errors: o.month_errors,
      last_ts: o.last_ts,
      by_model: o.by_model,
    })),
  ].filter((r) => r.month_requests)

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-900">Usage by project</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Tokens are input + output. Days follow Tehran time; 30 days includes today.
        </p>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No traffic in the last 30 days" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
              <tr>
                <th className="px-5 py-2.5">Project</th>
                <th className="px-3 py-2.5 text-right">Today</th>
                <th className="px-3 py-2.5 text-right">7 days</th>
                <th className="px-3 py-2.5 text-right">30 days</th>
                <th className="px-3 py-2.5 text-right">Requests (30d)</th>
                <th className="px-3 py-2.5 text-right">Errors</th>
                <th className="px-3 py-2.5">Models (30d)</th>
                <th className="px-5 py-2.5">Last request</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-5 py-2.5 font-medium whitespace-nowrap text-slate-900">
                    {r.name ?? <span className="text-slate-500">No key (before keys)</span>}
                    {r.deleted && <span className="ml-1.5 text-xs text-slate-400">(deleted)</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums" title={formatNumber(r.today_tokens)}>
                    {formatCompact(r.today_tokens)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums" title={formatNumber(r.week_tokens)}>
                    {formatCompact(r.week_tokens)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums" title={formatNumber(r.month_tokens)}>
                    {formatCompact(r.month_tokens)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(r.month_requests)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{r.month_errors || 0}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">
                    {(r.by_model ?? []).map((m) => (
                      <span key={m.model ?? '?'} className="mr-2 whitespace-nowrap">
                        <span className="font-mono">{m.model ?? '—'}</span>{' '}
                        <span className="text-slate-400">{formatCompact(m.tokens)}</span>
                      </span>
                    ))}
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap text-slate-500">{formatRelative(r.last_ts) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── Page ──

export default function Keys() {
  const toast = useToast()
  const keys = useApiData(() => api.listKeys(), { interval: 30000 })
  const overview = useApiData(() => api.overview())

  const [editing, setEditing] = useState(null) // null | 'new' | key object
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [secret, setSecret] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const models = overview.data?.models ?? []

  const openNew = () => {
    setForm(EMPTY_FORM)
    setEditing('new')
  }
  const openEdit = (key) => {
    setForm(formFromKey(key))
    setEditing(key)
  }

  const save = async (e) => {
    e?.preventDefault()
    if (!form.name.trim()) {
      toast.error('A project name is required')
      return
    }
    setSaving(true)
    try {
      const body = formToBody(form, editing === 'new')
      if (editing === 'new') {
        const created = await api.createKey(body)
        setSecret({ name: created.name, key: created.key })
      } else {
        await api.updateKey(editing.id, body)
        toast.success(`Saved “${form.name.trim()}”`)
      }
      setEditing(null)
      keys.reload({ silent: true })
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (key) => {
    setBusyId(key.id)
    try {
      await api.updateKey(key.id, { active: !key.active })
      toast.success(`${key.name} ${key.active ? 'disabled' : 'enabled'}`)
      keys.reload({ silent: true })
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const askRotate = (key) =>
    setConfirm({
      title: `Rotate “${key.name}”?`,
      message:
        'A new key is issued and the current one stops working immediately. Update the project with the new key right after.',
      label: 'Rotate key',
      run: async () => {
        const res = await api.rotateKey(key.id)
        setSecret({ name: res.name, key: res.key, rotated: true })
      },
    })

  const askDelete = (key) =>
    setConfirm({
      title: `Delete “${key.name}”?`,
      message:
        'The key stops working and cannot be restored. Its requests stay in the log and usage. Disable it instead if you may need it again.',
      label: 'Delete key',
      run: async () => {
        await api.deleteKey(key.id)
        toast.success(`${key.name} deleted`)
      },
    })

  const runConfirm = async () => {
    setConfirmBusy(true)
    try {
      await confirm.run()
      setConfirm(null)
      keys.reload({ silent: true })
    } catch (err) {
      toast.error(err.message)
    } finally {
      setConfirmBusy(false)
    }
  }

  const list = keys.data?.keys ?? []

  return (
    <>
      <PageHeader
        title="API Keys"
        description="One key per project, each with its own models, token limits and expiry. The model API accepts only these keys."
        actions={
          <>
            <Button variant="secondary" onClick={() => keys.reload()} loading={keys.refreshing}>
              {!keys.refreshing && <RefreshIcon />}
              Refresh
            </Button>
            <Button onClick={openNew}>New key</Button>
          </>
        }
      />

      <Card className="overflow-hidden">
        {keys.loading && !keys.data ? (
          <LoadingState />
        ) : keys.error ? (
          <ErrorState error={keys.error} onRetry={keys.reload} />
        ) : list.length === 0 ? (
          <EmptyState
            title="No keys yet"
            description="Requests to the model API are refused until a project has a key. Create one per project."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.map((key) => (
              <li key={key.id} className={`px-5 py-4 ${key.state !== 'active' ? 'bg-slate-50/60' : ''}`}>
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">{key.name}</span>
                      <StateBadge state={key.state} />
                      {!key.tools && <Tag title="web_search / fetch_url are not offered">no server tools</Tag>}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-slate-500" dir="ltr">
                      {key.prefix}
                    </p>
                    <div className="mt-2">
                      <ModelChips keyRow={key} />
                    </div>
                    {key.note && <p className="mt-2 text-xs text-slate-500">{key.note}</p>}
                  </div>

                  <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs text-slate-500 sm:grid-cols-4 xl:w-[36rem]">
                    <UsageBar used={key.usage.today_tokens} limit={key.daily_tokens} label="Tokens today" />
                    <UsageBar used={key.usage.month_tokens} limit={key.monthly_tokens} label="Tokens · 30 days" />
                    <div>
                      <p className="text-slate-400">Expires</p>
                      <p className={`text-sm ${key.expired ? 'text-amber-700' : 'text-slate-700'}`}>{expiryLabel(key)}</p>
                    </div>
                    <div>
                      <p className="text-slate-400">Last used</p>
                      <p className="text-sm text-slate-700" title={key.last_used_ip ?? ''}>
                        {formatRelative(key.last_used_at) || 'Never'}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5 xl:justify-end">
                    <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => openEdit(key)}>
                      Edit
                    </Button>
                    <Button
                      variant="secondary"
                      className="px-2.5 py-1.5 text-xs"
                      loading={busyId === key.id}
                      onClick={() => toggleActive(key)}
                    >
                      {key.active ? 'Disable' : 'Enable'}
                    </Button>
                    <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => askRotate(key)}>
                      Rotate
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50"
                      onClick={() => askDelete(key)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {keys.data && <ProjectUsage data={keys.data} />}

      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'New API key' : `Edit “${editing?.name}”`}
        onClose={() => setEditing(null)}
        busy={saving}
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              {editing === 'new' ? 'Create key' : 'Save changes'}
            </Button>
          </>
        }
      >
        <form onSubmit={save}>
          <KeyForm form={form} setForm={setForm} models={models} />
        </form>
      </Modal>

      <RevealKey secret={secret} onClose={() => setSecret(null)} />

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.label}
        busy={confirmBusy}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
    </>
  )
}
