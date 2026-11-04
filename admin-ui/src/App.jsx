import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ToastProvider } from './components/Toast'
import { Layout } from './components/Layout'
import { NAV_ITEMS, DEFAULT_ROUTE } from './nav'
import { api } from './lib/api'
import { AUTH_REQUIRED_EVENT, SETTINGS_EVENT } from './lib/settings'
import Dashboard from './pages/Dashboard'
import Models from './pages/Models'
import Providers from './pages/Providers'
import Requests from './pages/Requests'
import Settings from './pages/Settings'
import Login from './pages/Login'
import { LoadingState } from './components/ui'

// Recharts is the bulk of the bundle and only the Usage page needs it.
const Stats = lazy(() => import('./pages/Stats'))

const PAGES = {
  dashboard: Dashboard,
  models: Models,
  providers: Providers,
  stats: Stats,
  requests: Requests,
  settings: Settings,
}

function currentRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return PAGES[hash] ? hash : DEFAULT_ROUTE
}

/**
 * Hash-based routing keeps deep links working without a router dependency and
 * without depending on server-side rewrites.
 */
function useHashRoute() {
  const [route, setRoute] = useState(currentRoute)

  useEffect(() => {
    const handler = () => {
      setRoute(currentRoute())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', handler)
    if (!window.location.hash) window.location.replace(`#/${DEFAULT_ROUTE}`)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  return route
}

/**
 * Session state: 'checking' on load, then the /auth/me result or null.
 * Any 401 from any request (expired session) drops back to the login page.
 */
function useSession() {
  const [session, setSession] = useState(undefined) // undefined = checking

  const check = useCallback(async () => {
    try {
      const me = await api.me()
      setSession(me.kind === 'admin' ? me : null)
    } catch {
      setSession(null)
    }
  }, [])

  useEffect(() => {
    check()
    const onAuthRequired = () => setSession(null)
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [check])

  const loggedIn = useCallback(async () => {
    await check()
    window.dispatchEvent(new Event(SETTINGS_EVENT))
  }, [check])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setSession(null)
    }
  }, [])

  return { session, loggedIn, logout, ended: () => setSession(null) }
}

export default function App() {
  const route = useHashRoute()
  const { session, loggedIn, logout, ended } = useSession()
  const Page = PAGES[route] ?? Dashboard
  const item = NAV_ITEMS.find((i) => i.id === route)

  useEffect(() => {
    document.title = item ? `${item.label} · LLM Proxy` : 'LLM Proxy'
  }, [item])

  return (
    <ToastProvider>
      {session === undefined ? (
        <div className="flex min-h-screen items-center justify-center">
          <LoadingState label="Checking session…" />
        </div>
      ) : session === null ? (
        <Login onLoggedIn={loggedIn} />
      ) : (
        <Layout route={route} session={session} onLogout={logout}>
          <Suspense fallback={<LoadingState />}>
            <Page session={session} onLoggedOut={ended} />
          </Suspense>
        </Layout>
      )}
    </ToastProvider>
  )
}
