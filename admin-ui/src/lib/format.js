// The gateway stores timestamps as unix seconds (REAL).
function toDate(ts) {
  if (ts === null || ts === undefined || ts === '') return null
  const num = Number(ts)
  if (!Number.isFinite(num)) return null
  const date = new Date(num * 1000)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatTimestamp(ts) {
  const date = toDate(ts)
  if (!date) return '—'
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatRelative(ts) {
  const date = toDate(ts)
  if (!date) return ''
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return date.toLocaleDateString()
}

export function truncate(text, max = 90) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** True when the string contains RTL characters (Arabic/Persian/Hebrew). */
export function isRtl(text) {
  return /[֐-׿؀-ۿ܀-ݏﭐ-﷿ﹰ-﻿]/.test(
    String(text ?? ''),
  )
}

const n0 = (n) => Number(n ?? 0)

export function formatNumber(n) {
  return n0(n).toLocaleString()
}

/** 1234 → '1.2k', 3_400_000 → '3.4M' */
export function formatCompact(n) {
  const v = n0(n)
  if (Math.abs(v) < 1000) return String(v)
  if (Math.abs(v) < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}k`
  return `${(v / 1e6).toFixed(1)}M`
}

/** 850 → '850 ms', 2300 → '2.3 s' */
export function formatMs(ms) {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

export function formatUptime(s) {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}
