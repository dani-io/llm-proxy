export function Card({ children, className = '' }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {children}
    </div>
  )
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

const BUTTON_VARIANTS = {
  primary:
    'bg-blue-600 text-white shadow-sm hover:bg-blue-700 focus-visible:outline-blue-600 disabled:bg-blue-300',
  secondary:
    'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 focus-visible:outline-slate-400 disabled:text-slate-400',
  ghost:
    'bg-transparent text-slate-600 hover:bg-slate-100 focus-visible:outline-slate-400 disabled:text-slate-300',
}

export function Button({
  variant = 'primary',
  className = '',
  loading = false,
  disabled = false,
  children,
  ...props
}) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  )
}

export function Spinner({ className = 'h-5 w-5' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  )
}

export function Field({ label, hint, error, htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p className="mt-1.5 text-xs text-red-600">{error}</p>
      ) : (
        hint && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>
      )}
    </div>
  )
}

export const inputClass =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-slate-50'

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-3 px-6 py-16 text-sm text-slate-500">
      <Spinner className="h-5 w-5 text-blue-600" />
      {label}
    </div>
  )
}

export function EmptyState({ title, description }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
    </div>
  )
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="px-6 py-12 text-center">
      <svg
        className="mx-auto h-8 w-8 text-red-500"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.6}
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m0 3.75h.008M10.34 3.94l-7.6 13.15A1.5 1.5 0 0 0 4.04 19.5h15.92a1.5 1.5 0 0 0 1.3-2.41l-7.6-13.15a1.5 1.5 0 0 0-2.6 0Z"
        />
      </svg>
      <p className="mt-3 text-sm font-medium text-slate-900">Could not load data</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{error?.message}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-4" onClick={() => onRetry()}>
          Try again
        </Button>
      )}
    </div>
  )
}

export function TrashIcon({ className = 'h-4 w-4' }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.8}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
      />
    </svg>
  )
}

/** Compact square button for row-level actions. */
export function IconButton({ label, onClick, disabled, busy, tone = 'default', children }) {
  const tones = {
    default: 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
    danger: 'text-slate-500 hover:bg-red-50 hover:text-red-600',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={label}
      aria-label={label}
      className={`inline-flex items-center justify-center rounded-md p-1.5 transition disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      {busy ? <Spinner className="h-4 w-4" /> : children}
    </button>
  )
}

export function RefreshIcon({ className = 'h-4 w-4' }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.8}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.023 9.348h4.992V4.356m-4.992 4.992-2.482-2.482a7.5 7.5 0 1 0 1.591 8.063"
      />
    </svg>
  )
}
