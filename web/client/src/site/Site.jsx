// Shared chrome of the public site (landing, /brand, /privacy, /terms): header, footer, endorsement,
// scroll-reveal. Everything here is server-rendered by scripts/prerender.mjs and hydrated.
import { useEffect, useRef, useState } from "react"
import { useT } from "../i18n.jsx"
import { navigate, sitePath } from "../route.js"
import { getThemePref, setThemePref } from "../theme.js"
import { Lockup } from "../components/Logo.jsx"
import { CONTACT_EMAIL, FTU_URL } from "./config.js"

const YEAR = 2026 // © year (static so the prerendered HTML is deterministic)

export const mailto = (t) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(t("site.cta.mailSubject"))}`

/** Adds `.in` to `.reveal` elements when they scroll into view (CSS keeps them visible without JS / with reduced motion). */
export function useReveal(dep) {
  useEffect(() => {
    const els = [...document.querySelectorAll(".reveal:not(.in)")]
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      els.forEach((e) => e.classList.add("in"))
      return
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in")
            io.unobserve(e.target)
          }
        }),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    )
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [dep])
}

/** Client-side navigation for app links (/login) so the app chunk loads without a full page reload. */
const appLink = (to) => (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
  e.preventDefault()
  navigate(to)
}

function ThemeButton() {
  const t = useT()
  // Resolved after mount (the server does not know the theme) so the hydrated markup matches.
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const p = getThemePref()
    setDark(p === "dark" || (p === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches))
  }, [])
  const next = dark ? "light" : "dark"
  return (
    <button
      type="button"
      className="site-icon-btn"
      onClick={() => {
        setThemePref(next)
        setDark(next === "dark")
      }}
      aria-label={t(next === "dark" ? "site.nav.themeDark" : "site.nav.themeLight")}
      title={t(next === "dark" ? "site.nav.themeDark" : "site.nav.themeLight")}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path className="i-moon" d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
        <g className="i-sun">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
        </g>
      </svg>
    </button>
  )
}

function LangSwitch({ locale, page }) {
  const t = useT()
  return (
    <nav className="site-lang" aria-label={t("site.nav.language")}>
      {["vi", "en"].map((l) => (
        <a key={l} href={sitePath(page, l)} hrefLang={l} lang={l} aria-current={l === locale ? "true" : undefined} className={l === locale ? "on" : ""}>
          {l.toUpperCase()}
        </a>
      ))}
    </nav>
  )
}

export function SiteHeader({ locale, page = "landing", signedIn }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8)
    on()
    window.addEventListener("scroll", on, { passive: true })
    return () => window.removeEventListener("scroll", on)
  }, [])
  const home = sitePath("landing", locale)
  const a = (id) => (page === "landing" ? `#${id}` : `${home}#${id}`)
  const links = [
    ["features", t("site.nav.features")],
    ["how", t("site.nav.how")],
    ["demo", t("site.nav.demo")],
    ["faq", t("site.nav.faq")],
  ]
  return (
    <header className={`site-header ${scrolled ? "scrolled" : ""} ${open ? "open" : ""}`}>
      <div className="site-wrap site-header-inner">
        <a href={home} className="site-logo" aria-label={t("site.nav.home")}>
          <Lockup size={28} />
        </a>
        <nav className="site-nav" aria-label={t("site.nav.primary")}>
          {links.map(([id, label]) => (
            <a key={id} href={a(id)} onClick={() => setOpen(false)}>
              {label}
            </a>
          ))}
        </nav>
        <div className="site-actions">
          <LangSwitch locale={locale} page={page} />
          <ThemeButton />
          {signedIn ? (
            <a className="site-btn primary" href="/" onClick={appLink("/")}>
              {t("site.nav.openApp")}
            </a>
          ) : (
            <>
              <a className="site-btn ghost hide-sm" href="/login" onClick={appLink("/login")}>
                {t("site.nav.login")}
              </a>
              <a className="site-btn primary hide-xs" href={mailto(t)}>
                {t("site.nav.request")}
              </a>
            </>
          )}
          <button type="button" className="site-icon-btn site-menu-btn" aria-expanded={open} aria-controls="site-menu" aria-label={t("site.nav.menu")} onClick={() => setOpen((o) => !o)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 8h16M4 16h16" />}
            </svg>
          </button>
        </div>
      </div>
      <div className="site-menu" id="site-menu" hidden={!open}>
        <div className="site-wrap">
          {links.map(([id, label]) => (
            <a key={id} href={a(id)} onClick={() => setOpen(false)}>
              {label}
            </a>
          ))}
          {!signedIn && (
            <div className="site-menu-actions">
              <a className="site-btn ghost" href="/login" onClick={appLink("/login")}>
                {t("site.nav.login")}
              </a>
              <a className="site-btn primary" href={mailto(t)}>
                {t("site.nav.request")}
              </a>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

/** "A product of FTU Tech Lab – Foreign Trade University" with the official FTU logo (unaltered, on a white plate). */
export function Endorsement({ compact = false }) {
  const t = useT()
  return (
    <div className={`endorse ${compact ? "compact" : ""}`}>
      <a className="ftu-plate" href={FTU_URL} target="_blank" rel="noopener" aria-label={t("site.endorse.ftuLink")}>
        <img src="/brand/ftu-logo.png" width="491" height="108" alt={t("site.endorse.ftuAlt")} loading="lazy" decoding="async" />
      </a>
      <p>
        {t("site.endorse.line1")}
        <br />
        <span>{t("site.endorse.line2")}</span>
      </p>
    </div>
  )
}

export function SiteFooter({ locale }) {
  const t = useT()
  const home = sitePath("landing", locale)
  const col = (title, items) => (
    <div className="site-foot-col">
      <h2>{title}</h2>
      <ul>
        {items.map(([href, label]) => (
          <li key={href}>
            <a href={href}>{label}</a>
          </li>
        ))}
      </ul>
    </div>
  )
  return (
    <footer className="site-footer">
      <div className="site-wrap">
        <div className="site-foot-top">
          <div className="site-foot-brand">
            <Lockup size={28} />
            <p>{t("site.tagline")}</p>
            <p className="site-foot-status">
              <span className="dot" aria-hidden="true" /> {t("site.footer.status")}
            </p>
          </div>
          {col(t("site.footer.product"), [
            [`${home}#features`, t("site.nav.features")],
            [`${home}#how`, t("site.nav.how")],
            [`${home}#demo`, t("site.nav.demo")],
            [`${home}#faq`, t("site.nav.faq")],
          ])}
          {col(t("site.footer.resources"), [
            [`${home}#limits`, t("site.footer.limits")],
            [sitePath("brand", locale), t("site.footer.brand")],
            [sitePath("privacy", locale), t("site.footer.privacy")],
            [sitePath("terms", locale), t("site.footer.terms")],
          ])}
          <div className="site-foot-col">
            <h2>{t("site.footer.contact")}</h2>
            <ul>
              <li>
                <a href={mailto(t)}>{t("site.nav.request")}</a>
              </li>
              <li>
                <a href="/login" onClick={appLink("/login")}>
                  {t("site.nav.login")}
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="site-foot-endorse">
          <Endorsement compact />
        </div>
        <div className="site-foot-bottom">
          <p>{t("site.footer.copyright", { year: String(YEAR) })}</p>
          <p>{t("site.footer.disclaimer")}</p>
        </div>
      </div>
    </footer>
  )
}

/** Wraps a site page: <html data-site> for the duration, skip link, header, main, footer. */
export function SiteShell({ locale, page, signedIn, children }) {
  const t = useT()
  const mainRef = useRef(null)
  return (
    <div className="site">
      <a className="skip-link" href="#main">
        {t("site.nav.skip")}
      </a>
      <SiteHeader locale={locale} page={page} signedIn={signedIn} />
      <main id="main" ref={mainRef} tabIndex={-1}>
        {children}
      </main>
      <SiteFooter locale={locale} />
    </div>
  )
}
