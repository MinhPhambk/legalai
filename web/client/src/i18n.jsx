// Small i18n layer: vi / en dictionaries (locales/*.json, namespaced keys), {var} interpolation,
// CLDR plurals via Intl.PluralRules (key_one / key_other), <tag>…</tag> rich text (<Trans>), and
// Intl-based date / number / relative-time / byte formatting for the active locale.
import { Fragment, cloneElement, useSyncExternalStore } from "react"
import vi from "./locales/vi.json"
import en from "./locales/en.json"

export const DICTS = { vi, en }
export const LOCALES = ["vi", "en"]
const INTL = { vi: "vi-VN", en: "en-US" }
const STORE_KEY = "nd45-locale"
const EXPLICIT_KEY = "nd45-locale-explicit"

export const normalizeLocale = (l) => (LOCALES.includes(l) ? l : null)
/** vi* → vi, anything else → en. */
export const detectLocale = () => (String(navigator.language || navigator.languages?.[0] || "").toLowerCase().startsWith("vi") ? "vi" : "en")

function initialLocale() {
  try {
    const s = normalizeLocale(localStorage.getItem(STORE_KEY))
    if (s) return s
  } catch {}
  return typeof navigator !== "undefined" ? detectLocale() : "vi"
}

let locale = initialLocale()
const listeners = new Set()
export const getLocale = () => locale
export const intlLocale = (l = locale) => INTL[l] || INTL.vi

/** <html lang> + meta description for the app. Public site pages (<html data-site>) manage their own head. */
export function applyDocument() {
  if (typeof document === "undefined") return
  if (document.documentElement.hasAttribute("data-site")) {
    document.documentElement.lang = locale
    return
  }
  document.documentElement.lang = locale
  const meta = document.querySelector('meta[name="description"]')
  if (meta) meta.setAttribute("content", t("app.description"))
}

/**
 * Switch the UI language. `explicit` marks a choice the user made while signed out (it wins over the
 * value stored for the account at the next sign-in). `persist: false` = this page only (the public site
 * pages take their language from the URL without changing the saved preference).
 */
export function setLocale(next, { explicit = false, persist = true } = {}) {
  next = normalizeLocale(next)
  if (!next) return
  if (persist)
    try {
      localStorage.setItem(STORE_KEY, next)
      if (explicit) sessionStorage.setItem(EXPLICIT_KEY, next)
    } catch {}
  if (next === locale) return
  locale = next
  applyDocument()
  listeners.forEach((fn) => fn(next))
}
/** Locale chosen on the sign-in page in this tab (or null), consumed once after sign-in. */
export function takeExplicitLocale() {
  try {
    const v = normalizeLocale(sessionStorage.getItem(EXPLICIT_KEY))
    sessionStorage.removeItem(EXPLICIT_KEY)
    return v
  } catch {
    return null
  }
}

const subscribe = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
/** Re-renders the component when the language changes. Returns [locale, setLocale]. */
export function useLocale() {
  const l = useSyncExternalStore(subscribe, getLocale, getLocale)
  return [l, setLocale]
}

// ---- translation ------------------------------------------------------------------------------------
const lookup = (dict, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict)
const plurals = {}
const pluralOf = (n) => (plurals[locale] ??= new Intl.PluralRules(intlLocale())).select(n)

function resolve(key, vars, l = locale) {
  const dict = DICTS[l]
  let msg
  if (vars && typeof vars.count === "number") msg = lookup(dict, `${key}_${pluralOf(vars.count)}`) ?? lookup(dict, `${key}_other`)
  msg ??= lookup(dict, key)
  if (msg == null && l !== "vi") return resolve(key, vars, "vi")
  if (typeof msg !== "string") {
    if (import.meta.env?.DEV) console.warn("[i18n] missing key", key)
    return key
  }
  return msg
}

const fmtVar = (v) => (typeof v === "number" ? fmtNumber(v) : v == null ? "" : String(v))
/** t("ns.key", { var }) → string. Numbers are formatted for the locale; `count` selects the plural form. */
export function t(key, vars) {
  const msg = resolve(key, vars)
  return vars ? msg.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? fmtVar(vars[k]) : m)) : msg
}
/** Does the dictionary have this key (for optional, data-driven labels)? */
export const hasKey = (key) => typeof lookup(DICTS[locale], key) === "string"

/** Component-side access; re-renders on language change. */
export function useT() {
  useLocale()
  return t
}

/**
 * Rich text: <Trans k="auth.forgotBody" components={{ b: <strong /> }} vars={{ email }} />
 * The message may contain <b>…</b> style tags (not nested) and {var} placeholders; a var may be a node.
 */
export function Trans({ k, vars = {}, components = {} }) {
  useLocale()
  const msg = resolve(k, vars)
  const out = []
  const re = /<(\w+)>([\s\S]*?)<\/\1>|<(\w+)\/>/g
  let last = 0
  let m
  const pushText = (s) => {
    s.split(/(\{\w+\})/).forEach((piece) => {
      const v = piece.match(/^\{(\w+)\}$/)
      if (v && v[1] in vars) out.push(typeof vars[v[1]] === "object" ? vars[v[1]] : fmtVar(vars[v[1]]))
      else if (piece) out.push(piece)
    })
  }
  while ((m = re.exec(msg))) {
    pushText(msg.slice(last, m.index))
    const tag = m[1] || m[3]
    const el = components[tag]
    if (el) out.push(cloneElement(el, { key: out.length }, m[2] != null ? m[2].replace(/\{(\w+)\}/g, (x, v) => (v in vars ? fmtVar(vars[v]) : x)) : undefined))
    else pushText(m[2] || "")
    last = re.lastIndex
  }
  pushText(msg.slice(last))
  return out.map((x, i) => (typeof x === "string" ? <Fragment key={i}>{x}</Fragment> : x))
}

// ---- formatting ----------------------------------------------------------------------------------------
const cache = new Map()
const intl = (kind, opts) => {
  const k = `${kind}|${locale}|${JSON.stringify(opts || {})}`
  let f = cache.get(k)
  if (!f) cache.set(k, (f = new Intl[kind](intlLocale(), opts)))
  return f
}
export const fmtNumber = (n, opts) => intl("NumberFormat", opts).format(n)
export const fmtDate = (ts, opts = { day: "2-digit", month: "2-digit", year: "numeric" }) => (ts == null ? "" : intl("DateTimeFormat", opts).format(new Date(ts)))
export const fmtDateTime = (ts, opts = { dateStyle: "short", timeStyle: "short" }) => (ts == null ? "" : intl("DateTimeFormat", opts).format(new Date(ts)))
export const fmtTime = (ts) => fmtDate(ts, { hour: "2-digit", minute: "2-digit" })

/** "just now" / "5 minutes ago" / "yesterday" … then a short date after a week. */
export function relTime(ts) {
  if (!ts) return ""
  const d = Date.now() - ts
  if (d < 60_000) return t("time.justNow")
  const rtf = intl("RelativeTimeFormat", { numeric: "auto" })
  if (d < 3600_000) return rtf.format(-Math.floor(d / 60_000), "minute")
  if (d < 86400_000) return rtf.format(-Math.floor(d / 3600_000), "hour")
  if (d < 7 * 86400_000) return rtf.format(-Math.floor(d / 86400_000), "day")
  return fmtDate(ts)
}

/** 512 B / 34 KB / 1.2 MB (locale decimal separator). */
export function formatBytes(n) {
  n = Number(n) || 0
  if (n < 1024) return `${fmtNumber(n)} B`
  if (n < 1048576) return `${fmtNumber(Math.round(n / 1024))} KB`
  return `${fmtNumber(n / 1048576, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`
}

/** "1.2 s" / "12 s" / "1 min 05 s" (vi: "1,2 s" / "1 ph 05 s"). */
export function fmtDuration(ms) {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return ""
  const s = ms / 1000
  if (s < 10) return t("time.seconds", { n: fmtNumber(s, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) })
  if (s < 60) return t("time.seconds", { n: Math.round(s) })
  return t("time.minSec", { m: Math.floor(s / 60), s: String(Math.round(s % 60)).padStart(2, "0") })
}

// Apply <html lang> / meta description once everything above is initialised.
applyDocument()
