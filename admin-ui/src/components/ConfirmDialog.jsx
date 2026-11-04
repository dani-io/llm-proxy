import { useEffect, useRef } from 'react'
import { Button } from './ui'

/** Modal confirmation (from sms-panel). */
export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', tone = 'danger', busy = false, onConfirm, onCancel }) {
  const confirmRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    confirmRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center">
      <div className="absolute inset-0" onClick={() => !busy && onCancel()} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-title"
        className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
        <h2 id="confirm-title" className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button ref={confirmRef} onClick={onConfirm} loading={busy}
            className={tone === 'danger' ? 'bg-red-600 hover:bg-red-700 focus-visible:outline-red-600' : ''}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
