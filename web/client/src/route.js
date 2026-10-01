// Minimal client-side routing (no dependencies, SSR-safe: the prerender sets the path explicitly).
import { useEffect, useSyncExternalStore } from "react"

// Server snapshot: the prerender sets it; in the browser (hydration) it is the current path.
let ssrPath = typeof window !== "undefined" ? window.location.pathname : "/"
/** Used by the prerender (server has no window). */
export const setServerPath = (p) => (ssrPath = p)
const subscribeRoute = (cb) => {
  window.addEventListener("popstate", cb)
  return () => window.removeEventListener("popstate", cb)
}
const current = () => window.location.pathname
export const useRoute = () => useSyncExternalStore(subscribeRoute, current, () => ssrPath)
export function navigate(to, { replace = false } = {}) {
  const [path, hash] = to.split("#")
  if (path === window.location.pathname && !hash) return
  window.history[replace ? "replaceState" : "pushState"](null, "", to)
  window.dispatchEvent(new PopStateEvent("popstate"))
  if (!hash) window.scrollTo(0, 0)
}

// ---- site (public, prerendered) pages -----------------------------------------------------------------
/** path → { page, locale } for the public site pages, or null. */
export function sitePage(path) {
  const m = String(path).match(/^\/(en\/?)?(brand|privacy|terms)?\/?$/)
  if (!m) return null
  const locale = m[1] ? "en" : "vi"
  const page = m[2] || "landing"
  return { page, locale }
}
export const sitePath = (page, locale) => (locale === "en" ? "/en" : "") + (page === "landing" ? (locale === "en" ? "" : "/") : `/${page}`)

/** Keeps document.title in sync (re-evaluated when the language changes). */
export function useTitle(title) {
  useEffect(() => {
    if (title) document.title = title
  }, [title])
}
