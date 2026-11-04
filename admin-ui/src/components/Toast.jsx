import { useCallback, useMemo, useRef, useState } from 'react'
import { ToastContext } from './toast-context'

const VARIANTS = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-red-200 bg-red-50 text-red-900',
  info: 'border-blue-200 bg-blue-50 text-blue-900',
}

const ICONS = {
  success: (
    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
  ),
  error: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008M10.34 3.94l-7.6 13.15A1.5 1.5 0 0 0 4.04 19.5h15.92a1.5 1.5 0 0 0 1.3-2.41l-7.6-13.15a1.5 1.5 0 0 0-2.6 0Z" />
  ),
  info: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25h1.5v5.25m-.75-8.25h.008M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  ),
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(1)

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (message, variant = 'info', duration = 5000) => {
      const id = nextId.current++
      setToasts((current) => [...current, { id, message, variant }])
      if (duration) setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss],
  )

  const value = useMemo(
    () => ({
      toast: push,
      success: (message) => push(message, 'success'),
      error: (message) => push(message, 'error', 7000),
      info: (message) => push(message, 'info'),
      dismiss,
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-auto sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 shadow-lg ring-1 ring-black/5 ${VARIANTS[t.variant] ?? VARIANTS.info}`}
          >
            <svg
              className="mt-0.5 h-5 w-5 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.8}
              stroke="currentColor"
              aria-hidden="true"
            >
              {ICONS[t.variant] ?? ICONS.info}
            </svg>
            <p className="flex-1 text-sm leading-snug break-words">{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded p-0.5 opacity-60 transition hover:opacity-100"
              aria-label="Dismiss notification"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
