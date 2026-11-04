import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useToast } from './toast-context'
import { Modal } from './Modal'
import { Button, Field, inputClass } from './ui'

const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** 'deepseek/deepseek-chat-v3:free' → 'deepseek-chat-v3-free' */
export function suggestAlias(modelId) {
  const last = String(modelId).split('/').pop() || 'model'
  return last.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'model'
}

const checkbox = 'h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500'

/** Shared submit wrapper: runs the call, hands the new config to onSaved. */
function useSubmit(onSaved, onClose, success) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toast = useToast()
  const run = async (fn) => {
    setBusy(true)
    setError('')
    try {
      const cfg = await fn()
      onSaved(cfg)
      toast.success(success)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function ErrorBox({ error }) {
  if (!error) return null
  return <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm break-words text-red-700">{error}</p>
}

// ─── Provider ────────────────────────────────────────────────
export function ProviderForm({ provider, onClose, onSaved }) {
  const editing = Boolean(provider)
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? 'https://')
  const [timeout, setTimeoutS] = useState(String(provider?.timeout ?? 120))
  const [key, setKey] = useState('')
  const [keyEnv, setKeyEnv] = useState(provider?.api_key_env ?? '')
  const [streamUsage, setStreamUsage] = useState(provider?.stream_usage ?? true)
  const [advanced, setAdvanced] = useState(false)
  const { busy, error, run } = useSubmit(onSaved, onClose, editing ? `Saved ${name}` : `Added ${name}`)

  const nameErr = name && !PROVIDER_RE.test(name) ? 'Letters, digits, - or _ — e.g. freemodel' : ''
  const urlErr = baseUrl && !/^https?:\/\/[^\s/]+/.test(baseUrl) ? 'Must start with http:// or https://' : ''
  const derivedEnv = keyEnv || (name ? `${name.toUpperCase().replace(/-/g, '_')}_API_KEY` : '')

  const submit = (e) => {
    e.preventDefault()
    if (nameErr || urlErr) return
    run(() =>
      api.saveProvider(name.trim(), {
        base_url: baseUrl.trim(),
        timeout: Number(timeout) || 120,
        api_key_env: keyEnv.trim() || null,
        headers: provider?.headers ?? {},
        stream_usage: streamUsage,
        key: key.trim() || null,
      }),
    )
  }

  return (
    <Modal open title={editing ? `Edit provider ${provider.name}` : 'Add provider'} onClose={onClose} busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="provider-form" loading={busy} disabled={!name || !baseUrl || Boolean(nameErr || urlErr)}>
            {editing ? 'Save' : 'Add provider'}
          </Button>
        </>
      }>
      <form id="provider-form" onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="pv-name" error={nameErr} hint={editing ? 'Names cannot be changed.' : 'Short id used in the config, e.g. freemodel.'}>
          <input id="pv-name" dir="ltr" value={name} onChange={(e) => setName(e.target.value)} disabled={editing} autoFocus={!editing} required className={inputClass} />
        </Field>
        <Field label="Base URL" htmlFor="pv-url" error={urlErr} hint="The OpenAI-compatible root, usually ending in /v1 — e.g. https://freemodel.in/v1">
          <input id="pv-url" dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required className={inputClass} />
        </Field>
        <Field label={editing && provider.key.set ? 'Replace API key' : 'API key'} htmlFor="pv-key"
          hint={editing && provider.key.set
            ? `Current key ${provider.key.hint} (from ${provider.key.source === 'panel' ? 'the panel' : '.env'}). Leave empty to keep it.`
            : 'Optional. Stored on the server in data/provider-keys.env (0600) — never shown again, only its last 4 characters.'}>
          <input id="pv-key" type="password" dir="ltr" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={editing && provider.key.set ? '••••••••' : 'sk-…'} className={inputClass} />
        </Field>
        <Field label="Timeout (seconds)" htmlFor="pv-timeout">
          <input id="pv-timeout" type="number" min={1} max={900} value={timeout} onChange={(e) => setTimeoutS(e.target.value)} className={`${inputClass} max-w-32`} />
        </Field>

        <button type="button" onClick={() => setAdvanced((v) => !v)} className="text-xs font-medium text-blue-600 hover:text-blue-700">
          {advanced ? 'Hide advanced' : 'Advanced'}
        </button>
        {advanced && (
          <div className="space-y-4 rounded-lg bg-slate-50 p-3">
            <Field label="Key variable" htmlFor="pv-env" hint={`Name the key is stored under. Default: ${derivedEnv || 'NAME_API_KEY'}. Use the name of an existing .env variable to reuse that key.`}>
              <input id="pv-env" dir="ltr" value={keyEnv} onChange={(e) => setKeyEnv(e.target.value.toUpperCase())} placeholder={derivedEnv} className={inputClass} />
            </Field>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={streamUsage} onChange={(e) => setStreamUsage(e.target.checked)} className={`${checkbox} mt-0.5`} />
              <span>Ask for token usage when streaming <span className="block text-xs text-slate-500">Turn off only if the provider rejects <code className="font-mono">stream_options</code>.</span></span>
            </label>
          </div>
        )}
        <ErrorBox error={error} />
      </form>
    </Modal>
  )
}

// ─── Key ─────────────────────────────────────────────────────
export function KeyForm({ provider, onClose, onSaved }) {
  const [key, setKey] = useState('')
  const { busy, error, run } = useSubmit(onSaved, onClose, `Key saved for ${provider.name}`)
  const remove = useSubmit(onSaved, onClose, `Key removed from ${provider.name}`)
  const fromEnv = provider.key.source === 'env'

  return (
    <Modal open title={`API key — ${provider.name}`} onClose={onClose} busy={busy || remove.busy}
      footer={
        <>
          {provider.key.source === 'panel' && (
            <Button variant="ghost" className="mr-auto text-red-600 hover:bg-red-50" loading={remove.busy}
              onClick={() => remove.run(() => api.setKey(provider.name, ''))}>
              Remove key
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="key-form" loading={busy} disabled={!key.trim()}>Save key</Button>
        </>
      }>
      <form id="key-form" onSubmit={(e) => { e.preventDefault(); run(() => api.setKey(provider.name, key.trim())) }} className="space-y-4">
        <p className="text-sm text-slate-600">
          {provider.key.set
            ? <>Current key <code className="font-mono">{provider.key.hint}</code>, from {fromEnv ? <code className="font-mono">.env</code> : 'the panel'}.</>
            : 'No key yet — the provider and its models stay inactive until one is set.'}
          {' '}Keys are write-only: after saving, only the last 4 characters are ever shown.
        </p>
        {fromEnv && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            A key saved here takes priority over <code className="font-mono">{provider.api_key_env}</code> in .env.
          </p>
        )}
        <Field label="New key" htmlFor="key-input">
          <input id="key-input" type="password" dir="ltr" autoComplete="off" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" className={inputClass} />
        </Field>
        <ErrorBox error={error || remove.error} />
      </form>
    </Modal>
  )
}

// ─── Upstream model picker ───────────────────────────────────
/** Free-text input plus a searchable list loaded from the provider's
 * /models (cached 5 min on the server). Typing any id is still allowed —
 * some providers serve models they do not list. */
function UpstreamPicker({ provider, active, value, onChange, onPick, inUse }) {
  const [state, setState] = useState({ status: 'idle', ids: [], error: '' })
  const [open, setOpen] = useState(false)

  const load = async (fresh = false) => {
    if (!provider || !active) {
      setState({ status: 'idle', ids: [], error: '' })
      return
    }
    setState((s) => ({ ...s, status: 'loading', error: '' }))
    try {
      const res = await api.probeProvider(provider, fresh ? 0 : 300)
      setState(res.ok ? { status: 'ok', ids: res.models, error: '' } : { status: 'error', ids: [], error: res.error })
    } catch (err) {
      setState({ status: 'error', ids: [], error: err.message })
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, active])

  const needle = value.trim().toLowerCase()
  const exact = state.ids.includes(value.trim())
  const matches = needle && !exact ? state.ids.filter((id) => id.toLowerCase().includes(needle)) : state.ids
  const showList = open && state.status === 'ok' && matches.length > 0

  return (
    <div>
      <div className="relative">
        <input id="md-upstream" dir="ltr" value={value} autoComplete="off" required
          onChange={(e) => { onChange(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }}
          placeholder={state.status === 'ok' ? `Search ${state.ids.length} models or type an id` : 'e.g. gpt-6-luna'}
          className={`${inputClass} font-mono`} />
        {showList && (
          <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
            {matches.slice(0, 300).map((id) => (
              <li key={id}>
                <button type="button" onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onPick(id); setOpen(false) }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-blue-50 ${id === value ? 'bg-blue-50 text-blue-700' : 'text-slate-800'}`}>
                  <span className="truncate">{id}</span>
                  {inUse.has(id) && <span className="shrink-0 font-sans text-[11px] text-slate-400">in use</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
        {!active && "This provider is inactive, so its models can't be listed — type the id."}
        {active && state.status === 'loading' && 'Loading models from the provider…'}
        {active && state.status === 'ok' && (
          <>
            <span>{state.ids.length} models from {provider}{value && !exact && state.ids.length ? ' — not in the list, will be used as typed' : ''}.</span>
            <button type="button" onClick={() => load(true)} className="font-medium text-blue-600 hover:text-blue-700">Refresh list</button>
          </>
        )}
        {active && state.status === 'error' && (
          <>
            <span className="text-amber-700">Could not list models ({state.error}) — type the id.</span>
            <button type="button" onClick={() => load(true)} className="font-medium text-blue-600 hover:text-blue-700">Retry</button>
          </>
        )}
      </p>
    </div>
  )
}

// ─── Model ───────────────────────────────────────────────────
export function ModelForm({ model, preset, config, onClose, onSaved }) {
  const editing = Boolean(model)
  const init = model ?? preset ?? {}
  const [alias, setAlias] = useState(init.alias ?? '')
  const [aliasTouched, setAliasTouched] = useState(Boolean(init.alias))
  const [provider, setProvider] = useState(init.provider ?? config.providers[0]?.name ?? '')
  const [upstream, setUpstream] = useState(init.model ?? '')
  const [tools, setTools] = useState(init.tools ?? true)
  const [fallback, setFallback] = useState(init.fallback ?? (editing ? '' : config.active_default ?? ''))
  const [description, setDescription] = useState(init.description ?? '')
  const { busy, error, run } = useSubmit(onSaved, onClose, editing ? `Saved ${alias}` : `Added ${alias}`)

  const aliasErr = alias && !ALIAS_RE.test(alias) ? 'Letters, digits and . _ : - only' : ''
  const taken = !editing && config.models.some((m) => m.alias === alias) ? 'A model with this name exists — edit it instead' : ''
  const fallbacks = config.models.filter((m) => m.alias !== alias)
  const prov = config.providers.find((p) => p.name === provider)

  const submit = (e) => {
    e.preventDefault()
    if (aliasErr || taken) return
    run(() => api.saveModel(alias.trim(), { provider, model: upstream.trim(), tools, fallback: fallback || null, description }))
  }

  return (
    <Modal open title={editing ? `Edit model ${model.alias}` : 'Add model'} onClose={onClose} busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="model-form" loading={busy} disabled={!alias || !upstream || !provider || Boolean(aliasErr || taken)}>
            {editing ? 'Save' : 'Add model'}
          </Button>
        </>
      }>
      <form id="model-form" onSubmit={submit} className="space-y-4">
        <Field label="Provider" htmlFor="md-provider" hint={prov && !prov.active ? 'This provider is inactive (no API key) — the model will be inactive until it has one.' : undefined}>
          <select id="md-provider" value={provider} onChange={(e) => setProvider(e.target.value)} className={inputClass}>
            {config.providers.map((p) => <option key={p.name} value={p.name}>{p.name}{p.active ? '' : ' (inactive)'}</option>)}
          </select>
        </Field>
        <Field label="Upstream model id" htmlFor="md-upstream">
          <UpstreamPicker provider={provider} active={Boolean(prov?.active)} value={upstream} onChange={setUpstream}
            inUse={new Set(config.models.filter((m) => m.provider === provider && m.alias !== model?.alias).map((m) => m.model))}
            onPick={(id) => {
              setUpstream(id)
              if (!editing && !aliasTouched) setAlias(suggestAlias(id))
            }} />
        </Field>
        <Field label="Name clients use" htmlFor="md-alias" error={aliasErr || taken} hint={editing ? 'Names cannot be changed.' : 'Sent as "model" in requests. Filled in from the upstream id — change it to something short, e.g. luna.'}>
          <input id="md-alias" dir="ltr" value={alias} onChange={(e) => { setAlias(e.target.value); setAliasTouched(Boolean(e.target.value)) }} disabled={editing}  required className={inputClass} />
        </Field>
        <Field label="Fallback" htmlFor="md-fallback" hint="Used automatically when this model fails (network, rate limit, bad key…).">
          <select id="md-fallback" value={fallback} onChange={(e) => setFallback(e.target.value)} className={inputClass}>
            <option value="">None</option>
            {fallbacks.map((m) => <option key={m.alias} value={m.alias}>{m.alias}{m.active ? '' : ' (inactive)'}</option>)}
          </select>
        </Field>
        <Field label="Description" htmlFor="md-desc">
          <input id="md-desc" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Optional note shown in the panel and /v1/models" className={inputClass} />
        </Field>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} className={`${checkbox} mt-0.5`} />
          <span>Supports tool calling <span className="block text-xs text-slate-500">Offers web_search and fetch_url. Turn off if the provider returns errors for requests with tools.</span></span>
        </label>
        <ErrorBox error={error} />
      </form>
    </Modal>
  )
}
