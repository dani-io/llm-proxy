/** The panel and its API share one origin (llm-proxy's admin port). */
export const API_BASE = '/api'

/** Fired after login so open pages refetch. */
export const SETTINGS_EVENT = 'llmp-settings-changed'

/** Fired by the API client when the session is missing or expired. */
export const AUTH_REQUIRED_EVENT = 'llmp-auth-required'

export function getApiUrl() {
  return API_BASE
}
