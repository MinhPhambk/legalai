// Source data inside UI chrome (queries, law / article titles, product descriptions, document names…): shown in
// its original language, visually marked as data (quotes / muted style) with a small language tag when it
// differs from the UI language – never glued into a localized sentence. Everything rendered here carries
// data-lang (or data-source), which the language-leak check (scripts/lang-leak-check.mjs) skips.
import "../styles-lang.css"
import { t, useLocale } from "../i18n.jsx"

const LANGS = ["vi", "en"]
// Mirrors server/stepview.mjs langOf() for strings that arrive without a language (older records).
const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i // i18n-ignore
/** vi | en | undefined for a data string (Vietnamese diacritics → vi, other words → en, codes → none). */
export function guessLang(s) {
  const x = String(s ?? "")
  if (VI_CHARS.test(x)) return "vi"
  const words = x.replace(/\b[A-Z]{2,}\d*\b/g, " ").replace(/[_-]+/g, " ")
  return /(?:^|[^a-z])[a-z]{3,}/i.test(words) ? "en" : undefined
}

/** Small "VI" / "EN" tag, only when the data language differs from the UI language. */
export function LangTag({ lang }) {
  const [ui] = useLocale()
  if (!LANGS.includes(lang) || lang === ui) return null
  return (
    <span className="lang-tag" title={t(`common.dataLang.${lang}`)} aria-label={t(`common.dataLang.${lang}`)}>
      {lang.toUpperCase()}
    </span>
  )
}

/**
 * <Data v="phạt vi phạm" lang="vi" q /> → “phạt vi phạm” VI (in the EN UI).
 * q = quoted (queries, quotes, titles inside a step line); code = identifier style (HS code, CELEX, file name).
 */
export function Data({ v, lang, q = false, code = false, className = "", title }) {
  if (v == null || v === "") return null
  const l = LANGS.includes(lang) ? lang : lang === null ? undefined : guessLang(v)
  if (code)
    return (
      <span className={`data-code ${className}`} data-source="" translate="no" title={title}>
        {v}
      </span>
    )
  return (
    <span className={`data ${q ? "data-q" : ""} ${className}`} data-lang={l || "und"} lang={l} title={title}>
      <span className="data-v">{v}</span>
      <LangTag lang={l} />
    </span>
  )
}

/** {v, lang} object (server data shape) → <Data>. */
export const D = ({ d, ...rest }) => (d && d.v ? <Data v={d.v} lang={d.lang ?? guessLang(d.v)} {...rest} /> : null)
