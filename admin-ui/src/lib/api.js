import { AUTH_REQUIRED_EVENT, getApiUrl } from './settings'

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function extractDetail(payload, status) {
  const detail = payload && typeof payload === 'object' ? payload.detail : payload
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => d?.msg).filter(Boolean)
    if (msgs.length) return msgs.join(', ')
  }
  if (status === 401) return 'Your session has ended — please sign in again.'
  return `Request failed (HTTP ${status})`
}

async function request(path, { method = 'GET', body, timeout = 15000, quiet401 = false } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let res
  try {
    res = await fetch(`${getApiUrl()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError(`Request timed out after ${Math.round(timeout / 1000)}s`, 0)
    }
    throw new ApiError('Cannot reach llm-proxy. Check that the service is running.', 0)
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !quiet401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
    throw new ApiError(extractDetail(payload, res.status), res.status)
  }
  return payload
}

function qs(params) {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, v)
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const api = {
  // ── Session ──
  me: () => request('/auth/me', { quiet401: true }),
  login: ({ username, password }) =>
    request('/auth/login', { method: 'POST', body: { username, password }, quiet401: true }),
  logout: () => request('/auth/logout', { method: 'POST', quiet401: true }),
  setupStatus: () => request('/auth/setup', { quiet401: true }),
  setup: ({ username, password }) =>
    request('/auth/setup', { method: 'POST', body: { username, password }, quiet401: true }),
  changePassword: ({ currentPassword, newPassword }) =>
    request('/auth/password', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
    }),

  // ── Data ──
  overview: () => request('/overview'),
  series: (range) => request(`/stats/series${qs({ range })}`),
  statsModels: (days) => request(`/stats/models${qs({ days })}`),
  requests: ({ limit = 50, beforeId, model, status } = {}) =>
    request(`/requests${qs({ limit, before_id: beforeId, model, status })}`),

  // One direct call to the model — no tools, no fallback.
  testModel: (alias, prompt) =>
    request(`/models/${encodeURIComponent(alias)}/test`, {
      method: 'POST',
      body: prompt ? { prompt } : {},
      timeout: 200000,
    }),
  // ── Config (phase 2): every call returns the full config view ──
  config: () => request('/config'),
  reloadConfig: () => request('/config/reload', { method: 'POST' }),
  saveProvider: (name, body) =>
    request(`/config/providers/${encodeURIComponent(name)}`, { method: 'PUT', body }),
  deleteProvider: (name) => request(`/config/providers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // Empty key removes it. Keys are write-only: the API only ever returns a hint.
  setKey: (name, key) =>
    request(`/config/providers/${encodeURIComponent(name)}/key`, { method: 'PUT', body: { key } }),
  saveModel: (alias, body) => request(`/config/models/${encodeURIComponent(alias)}`, { method: 'PUT', body }),
  deleteModel: (alias) => request(`/config/models/${encodeURIComponent(alias)}`, { method: 'DELETE' }),
  setDefault: (model) => request('/config/default', { method: 'PUT', body: { model } }),

  probeProvider: (name) =>
    request(`/providers/${encodeURIComponent(name)}/probe`, { method: 'POST', timeout: 30000 }),
}
