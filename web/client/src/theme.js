// Theme preference (system / light / dark) and reduced-motion – dependency-free (used by the public site too).
import { useEffect, useState } from "react"

// ---- motion -----------------------------------------------------------------------------------
const rmQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null
export const prefersReducedMotion = () => !!rmQuery?.matches

// ---- theme ------------------------------------------------------------------------------------
const THEME_KEY = "nd45-theme"
const themeListeners = new Set()
export function getThemePref() {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === "light" || t === "dark" ? t : "system"
  } catch {
    return "system"
  }
}
export function setThemePref(pref) {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch {}
  const root = document.documentElement
  root.classList.add("theme-switching")
  if (pref === "system") root.removeAttribute("data-theme")
  else root.setAttribute("data-theme", pref)
  setTimeout(() => root.classList.remove("theme-switching"), 350)
  themeListeners.forEach((fn) => fn(pref))
}
export function useThemePref() {
  const [pref, setPref] = useState(getThemePref)
  useEffect(() => {
    themeListeners.add(setPref)
    return () => themeListeners.delete(setPref)
  }, [])
  return [pref, setThemePref]
}
