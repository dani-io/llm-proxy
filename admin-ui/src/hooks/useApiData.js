import { useCallback, useEffect, useRef, useState } from 'react'
import { SETTINGS_EVENT } from '../lib/settings'

/**
 * Fetch data from the gateway with optional polling.
 *
 * `interval` (ms) enables auto-refresh; polls are skipped while the tab is
 * hidden and are "silent" so the table never flashes back to a spinner.
 */
export function useApiData(fetcher, { interval = 0, deps = [] } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(null)

  // Keep the latest fetcher without making `load` change identity every render.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const alive = useRef(true)
  // Requests can overlap (fast-changing filters, a poll firing mid-load); only
  // the most recently started one may write state, so a slow stale response
  // never overwrites a newer one.
  const latest = useRef(0)

  const load = useCallback(async ({ silent = false } = {}) => {
    const id = ++latest.current
    if (silent) setRefreshing(true)
    else setLoading(true)
    try {
      const result = await fetcherRef.current()
      if (!alive.current || id !== latest.current) return
      setData(result)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      if (!alive.current || id !== latest.current) return
      setError(err)
    } finally {
      if (alive.current && id === latest.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  // Refetch on mount and whenever a caller-supplied dependency (a filter, an
  // id) changes. `deps` must keep a stable length across renders.
  useEffect(() => {
    alive.current = true
    load()
    return () => {
      alive.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps])

  useEffect(() => {
    if (!interval) return undefined
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load({ silent: true })
    }, interval)
    return () => clearInterval(id)
  }, [interval, load])

  // A new API URL/key should immediately re-run the request.
  useEffect(() => {
    const handler = () => load()
    window.addEventListener(SETTINGS_EVENT, handler)
    return () => window.removeEventListener(SETTINGS_EVENT, handler)
  }, [load])

  return { data, error, loading, refreshing, updatedAt, reload: load, setData }
}
