import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Button, Card, Field, LoadingState, inputClass } from '../components/ui'

const MIN_PASSWORD = 10

/**
 * Sign-in, or — on a fresh install with no admin yet — a one-time form that
 * creates the admin account. The server accepts that form only once.
 */
export default function Login({ onLoggedIn }) {
  const [mode, setMode] = useState('checking') // checking | login | setup
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .setupStatus()
      .then((r) => alive && setMode(r.needs_setup ? 'setup' : 'login'))
      .catch(() => alive && setMode('login'))
    return () => {
      alive = false
    }
  }, [])

  const setup = mode === 'setup'
  const tooShort = setup && password && password.length < MIN_PASSWORD
  const mismatch = setup && repeat && password !== repeat

  const submit = async (e) => {
    e.preventDefault()
    if (tooShort || mismatch) return
    setBusy(true)
    setError('')
    try {
      if (setup) {
        await api.setup({ username: username.trim(), password })
      } else {
        await api.login({ username: username.trim(), password })
      }
      onLoggedIn()
    } catch (err) {
      // Someone finished setup in the meantime: fall back to normal sign-in.
      if (setup && err.status === 409) setMode('login')
      setError(err.message)
      if (!setup) setPassword('')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Connecting…" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
          </span>
          <div className="leading-tight">
            <p className="text-base font-semibold text-slate-900">LLM Proxy</p>
            <p className="text-xs text-slate-500">
              {setup ? 'First run — create the admin account' : 'Sign in to the admin panel'}
            </p>
          </div>
        </div>

        <Card className="p-6">
          {setup && (
            <p className="mb-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">
              No admin account exists yet. Choose a username and password — you can change the
              password later in Settings.
            </p>
          )}
          <form onSubmit={submit} className="space-y-4">
            <Field label="Username" htmlFor="login-user">
              <input
                id="login-user"
                dir="ltr"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field
              label="Password"
              htmlFor="login-pass"
              hint={setup ? `At least ${MIN_PASSWORD} characters.` : undefined}
              error={tooShort ? `At least ${MIN_PASSWORD} characters.` : ''}
            >
              <input
                id="login-pass"
                type="password"
                dir="ltr"
                autoComplete={setup ? 'new-password' : 'current-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
            </Field>
            {setup && (
              <Field label="Repeat password" htmlFor="login-repeat" error={mismatch ? 'Passwords do not match.' : ''}>
                <input
                  id="login-repeat"
                  type="password"
                  dir="ltr"
                  autoComplete="new-password"
                  required
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  className={inputClass}
                />
              </Field>
            )}
            {error && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
            <Button type="submit" loading={busy} disabled={Boolean(tooShort || mismatch)} className="w-full">
              {setup ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}
