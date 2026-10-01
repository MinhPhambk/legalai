import { LOCALES, setLocale, useLocale, useT } from "../i18n.jsx"

const SHORT = { vi: "VI", en: "EN" }

/** Compact VI | EN switch. `onChange` defaults to a signed-out choice (localStorage + wins at sign-in). */
export default function LanguageToggle({ onChange, className = "" }) {
  const [locale] = useLocale()
  const t = useT()
  const change = onChange || ((l) => setLocale(l, { explicit: true }))
  return (
    <div className={`lang-toggle ${className}`} role="radiogroup" aria-label={t("settings.general.language")}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          lang={l}
          aria-checked={locale === l}
          aria-label={t(`settings.general.languageName.${l}`)}
          title={t(`settings.general.languageName.${l}`)}
          className={locale === l ? "on" : ""}
          onClick={() => change(l)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
            e.preventDefault()
            const n = LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length]
            change(n)
            requestAnimationFrame(() => e.currentTarget?.parentElement?.querySelector('[aria-checked="true"]')?.focus())
          }}
        >
          {SHORT[l]}
        </button>
      ))}
    </div>
  )
}
