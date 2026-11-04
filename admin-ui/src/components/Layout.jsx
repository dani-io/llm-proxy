import { useEffect, useState } from 'react'
import { NAV_ITEMS } from '../nav'
import { api } from '../lib/api'

/** Live indicator: polls the unauthenticated setup endpoint on the admin port. */
function ProxyStatus() {
  const [state, setState] = useState('checking')

  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        await api.setupStatus()
        if (alive) setState('online')
      } catch {
        if (alive) setState('offline')
      }
    }
    check()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') check()
    }, 30000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const dot = state === 'online' ? 'bg-emerald-500' : state === 'offline' ? 'bg-red-500' : 'bg-slate-300'
  const label = state === 'online' ? 'Proxy online' : state === 'offline' ? 'Proxy unreachable' : 'Checking…'

  return (
    <div className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5" title={window.location.host}>
      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-700">{label}</p>
        <p className="truncate font-mono text-[11px] text-slate-400">{window.location.host}</p>
      </div>
    </div>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-slate-900">LLM Proxy</p>
        <p className="text-[11px] text-slate-500">Model gateway admin</p>
      </div>
    </div>
  )
}

function NavLink({ item, active, onClick }) {
  return (
    <a
      href={`#/${item.id}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
        active
          ? 'bg-blue-50 text-blue-700'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      {item.icon}
      {item.label}
    </a>
  )
}

function Account({ session, onLogout }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-slate-700">{session?.name ?? 'admin'}</p>
        <p className="text-[11px] text-slate-400">Administrator</p>
      </div>
      <button
        type="button"
        onClick={onLogout}
        className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
      >
        Sign out
      </button>
    </div>
  )
}

export function Layout({ route, session, onLogout, children }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const activeLabel = NAV_ITEMS.find((i) => i.id === route)?.label ?? 'Dashboard'

  // Close the drawer whenever navigation happens.
  useEffect(() => setMenuOpen(false), [route])

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <div className="border-b border-slate-200 px-4 py-4">
          <Brand />
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.id} item={item} active={item.id === route} />
          ))}
        </nav>
        <div className="space-y-1 p-3">
          <ProxyStatus />
          <Account session={session} onLogout={onLogout} />
        </div>
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <Brand />
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-label="Toggle navigation menu"
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
            {menuOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            )}
          </svg>
        </button>
      </header>

      {menuOpen && (
        <nav className="sticky top-[57px] z-20 space-y-1 border-b border-slate-200 bg-white p-3 shadow-sm lg:hidden">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.id}
              item={item}
              active={item.id === route}
              onClick={() => setMenuOpen(false)}
            />
          ))}
          <div className="space-y-1 pt-2">
            <ProxyStatus />
            <Account session={session} onLogout={onLogout} />
          </div>
        </nav>
      )}

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
          <p className="sr-only" aria-live="polite">
            {activeLabel}
          </p>
          {children}
        </div>
      </main>
    </div>
  )
}
