import { formatRelative } from '../lib/format'

// Status colours are reserved for state and always ship with a text label.
const HEALTH = {
  ok: { dot: 'bg-emerald-500', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', label: 'Healthy' },
  degraded: { dot: 'bg-amber-500', cls: 'bg-amber-50 text-amber-800 ring-amber-600/30', label: 'Recent errors' },
  down: { dot: 'bg-red-500', cls: 'bg-red-50 text-red-700 ring-red-600/20', label: 'Failing' },
  unknown: { dot: 'bg-slate-300', cls: 'bg-slate-100 text-slate-600 ring-slate-500/20', label: 'No data yet' },
}

export function HealthBadge({ health, compact = false }) {
  const s = HEALTH[health?.status] ?? HEALTH.unknown
  const title = health?.error
    ? `Last error ${formatRelative(health.last_error)}: ${health.error}`
    : health?.last_ok
      ? `Last success ${formatRelative(health.last_ok)}`
      : undefined
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${s.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {compact ? null : s.label}
    </span>
  )
}

export function HealthDot({ health }) {
  const s = HEALTH[health?.status] ?? HEALTH.unknown
  return <span title={s.label} className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
}

const STATUS = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  error: 'bg-red-50 text-red-700 ring-red-600/20',
  client_tool: 'bg-blue-50 text-blue-700 ring-blue-700/20',
}
const STATUS_LABEL = { ok: 'ok', error: 'error', client_tool: 'client tool' }

export function StatusBadge({ status }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${STATUS[status] ?? STATUS.ok}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function Tag({ children, tone = 'slate', title }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600 ring-slate-500/20',
    blue: 'bg-blue-50 text-blue-700 ring-blue-700/20',
    amber: 'bg-amber-50 text-amber-800 ring-amber-600/30',
    violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  }
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
      {options.map((opt) => {
        const active = opt.id === value
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            aria-pressed={active}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
              active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
