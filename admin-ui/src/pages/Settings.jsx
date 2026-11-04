import { useState } from 'react'
import { api } from '../lib/api'
import { useApiData } from '../hooks/useApiData'
import { useToast } from '../components/toast-context'
import { Button, Card, Field, PageHeader, inputClass } from '../components/ui'

const MIN_PASSWORD = 10

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-3 sm:gap-4">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900 sm:col-span-2">{children}</dd>
    </div>
  )
}

const Code = ({ children }) => <code className="font-mono text-xs break-all">{children}</code>

export default function Settings({ session, onLoggedOut }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const { data } = useApiData(() => api.overview())
  const px = data?.proxy

  const mismatch = repeat && next !== repeat
  const tooShort = next && next.length < MIN_PASSWORD

  const changePassword = async (e) => {
    e.preventDefault()
    if (mismatch || tooShort) return
    setBusy(true)
    try {
      await api.changePassword({ currentPassword: current, newPassword: next })
      toast.success('Password changed — other sessions were signed out')
      setCurrent('')
      setNext('')
      setRepeat('')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Settings" description={`Signed in as ${session?.name ?? 'admin'}.`} />

      <Card className="max-w-2xl p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-slate-900">Configuration</h2>
        <p className="mt-1 text-sm text-slate-500">
          Read-only in this version. Providers and models live in{' '}
          <Code>providers.yaml</Code>, API keys in <Code>.env</Code> — edit them on CT 261 and run{' '}
          <Code>systemctl restart llm-proxy</Code>.
        </p>
        <dl className="mt-4 divide-y divide-slate-100">
          <Row label="Providers file">
            <Code>{px?.providers_file ?? '…'}</Code>
            {px && !px.providers_file_exists && (
              <span className="ml-2 text-xs text-amber-700">missing — legacy LLAMA_URL mode</span>
            )}
          </Row>
          <Row label="Model API port">{px ? <Code>{px.api_port}</Code> : '…'}</Row>
          <Row label="Default model">{px ? <Code>{px.default_model}</Code> : '…'}</Row>
          <Row label="Server tools">{px?.tools?.join(', ') ?? '…'} (max {px?.max_tool_loops} loops)</Row>
          <Row label="Health probe">
            {px ? (px.probe_interval_s ? `every ${Math.round(px.probe_interval_s / 60)} min (GET /models)` : 'off') : '…'}
          </Row>
          <Row label="Request log">
            {px ? `kept ${px.retention_days} days · metadata only, prompts are never stored` : '…'}
          </Row>
          <Row label="Day boundaries">{px?.timezone ?? '…'}</Row>
        </dl>
      </Card>

      <Card className="mt-6 max-w-2xl p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-slate-900">Change password</h2>
        <p className="mt-1 text-sm text-slate-500">Every other open session is signed out afterwards.</p>
        <form onSubmit={changePassword} className="mt-5 space-y-4">
          <Field label="Current password" htmlFor="pw-current">
            <input id="pw-current" type="password" dir="ltr" autoComplete="current-password" required
              value={current} onChange={(e) => setCurrent(e.target.value)} className={inputClass} />
          </Field>
          <Field label="New password" htmlFor="pw-new" hint={`At least ${MIN_PASSWORD} characters.`}
            error={tooShort ? `At least ${MIN_PASSWORD} characters.` : ''}>
            <input id="pw-new" type="password" dir="ltr" autoComplete="new-password" required
              value={next} onChange={(e) => setNext(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Repeat new password" htmlFor="pw-repeat" error={mismatch ? 'Passwords do not match.' : ''}>
            <input id="pw-repeat" type="password" dir="ltr" autoComplete="new-password" required
              value={repeat} onChange={(e) => setRepeat(e.target.value)} className={inputClass} />
          </Field>
          <div className="border-t border-slate-100 pt-4">
            <Button type="submit" loading={busy} disabled={!current || !next || mismatch || tooShort}>
              Change password
            </Button>
          </div>
        </form>
      </Card>
    </>
  )
}
