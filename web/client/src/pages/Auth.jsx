import "../app-styles.js"
import { useEffect, useId, useRef, useState } from "react"
import { api } from "../api.js"
import { navigate, useTitle } from "../lib.js"
import { Trans, useLocale, useT } from "../i18n.jsx"
import { CONTACT_EMAIL } from "../site/config.js"
import LanguageToggle from "../components/LanguageToggle.jsx"
import { IconAlert, IconCheck, IconEye, IconEyeOff, IconGavel, IconGlobe, IconInfo, IconQuote, Spinner } from "../components/Icons.jsx"
import { TechlabLogo } from "../components/Logo.jsx"

const EMAIL_RE = /^[^\s@<>()"',;:]{1,64}@[^\s@<>()"',;:]{1,190}\.[a-z]{2,}$/i

export function passwordScore(pw) {
  if (!pw) return 0
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 12) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw)) s++
  if (pw.length < 8) s = Math.min(s, 1)
  return Math.min(4, s)
}
const STRENGTH = ["tooShort", "weak", "fair", "good", "strong"]

export function StrengthMeter({ password }) {
  const t = useT()
  const score = passwordScore(password)
  if (!password) return null
  return (
    <div className="strength" aria-live="polite">
      <div className="strength-bars" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={i <= score ? "on" : ""} />
        ))}
      </div>
      <span className="strength-label">
        <Trans k="auth.strength.label" vars={{ level: t(`auth.strength.${STRENGTH[score]}`) }} components={{ b: <strong /> }} />
        {password.length < 8 ? ` · ${t("auth.strength.needMore", { count: 8 - password.length })}` : ""}
      </span>
    </div>
  )
}

/** Password field with show/hide toggle and Caps Lock warning. */
export function PasswordInput({ id, label, value, onChange, autoComplete, invalid, describedBy, onBlur, hint }) {
  const t = useT()
  const [show, setShow] = useState(false)
  const [caps, setCaps] = useState(false)
  const checkCaps = (e) => setCaps(!!e.getModifierState?.("CapsLock"))
  const descIds = [describedBy, caps ? `${id}-caps` : null].filter(Boolean).join(" ") || undefined
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-wrap">
        <input
          id={id}
          className="input"
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={checkCaps}
          onKeyUp={checkCaps}
          onBlur={(e) => {
            setCaps(false)
            onBlur?.(e)
          }}
          autoComplete={autoComplete}
          maxLength={200}
          aria-invalid={invalid || undefined}
          aria-describedby={descIds}
        />
        <button type="button" className="icon-btn sm input-affix" onClick={() => setShow((s) => !s)} aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")} aria-pressed={show}>
          {show ? <IconEyeOff size={16} /> : <IconEye size={16} />}
        </button>
      </div>
      {caps && (
        <div className="field-note caps" id={`${id}-caps`} role="status">
          <IconAlert size={13} /> {t("auth.capsLock")}
        </div>
      )}
      {hint}
    </div>
  )
}

function FieldError({ id, children }) {
  return (
    <div className={`field-error ${children ? "show" : ""}`} id={id} role={children ? "alert" : undefined}>
      {children}
    </div>
  )
}

const mailtoAccess = (t) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(t("site.cta.mailSubject"))}`

/** /register while public sign-up is off: explain and offer an access request instead of a form. */
function RegisterClosed() {
  const t = useT()
  useTitle(t("auth.register.docTitle"))
  return (
    <div className="auth-form-inner">
      <h1 className="auth-title">{t("auth.registerClosed.title")}</h1>
      <p className="auth-sub">{t("auth.registerClosed.body")}</p>
      <a className="btn primary block lg" href={mailtoAccess(t)}>
        {t("auth.registerClosed.request")}
      </a>
      <p className="auth-switch">
        <a
          href="/login"
          onClick={(e) => {
            e.preventDefault()
            navigate("/login")
          }}
        >
          {t("auth.registerClosed.toLogin")}
        </a>
      </p>
    </div>
  )
}

function AuthForm({ mode, allowRegistration, onAuthed }) {
  const t = useT()
  const isLogin = mode === "login"
  useTitle(isLogin ? t("auth.login.docTitle") : t("auth.register.docTitle"))
  const uid = useId()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [touched, setTouched] = useState({})
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)
  const emailRef = useRef(null)
  useEffect(() => {
    setError("")
    setTouched({})
    setConfirm("")
    setForgot(false)
    emailRef.current?.focus()
  }, [mode])

  const emailErr = touched.email && email && !EMAIL_RE.test(email.trim()) ? t("auth.errors.emailFormat") : touched.email && !email ? t("auth.errors.emailRequired") : ""
  const pwErr = !isLogin && touched.password && password.length < 8 ? t("auth.errors.passwordShort") : touched.password && !password ? t("auth.errors.passwordRequired") : ""
  const confirmErr = !isLogin && (touched.confirm || confirm.length >= password.length) && confirm && confirm !== password ? t("auth.errors.passwordMismatch") : ""
  const confirmOk = !isLogin && confirm && confirm === password && password.length >= 8

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setTouched({ email: true, password: true, confirm: true })
    setError("")
    if (!EMAIL_RE.test(email.trim()) || !password) return
    if (!isLogin && (password.length < 8 || password !== confirm)) return
    setBusy(true)
    try {
      const r = isLogin ? await api.login(email.trim(), password) : await api.register(email.trim(), password)
      onAuthed(r.user)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  const go = (to) => (e) => {
    e.preventDefault()
    navigate(to)
  }

  return (
    <div className="auth-form-inner" key={mode}>
      <h1 className="auth-title">{isLogin ? t("auth.login.title") : t("auth.register.title")}</h1>
      <p className="auth-sub">{isLogin ? t("auth.login.subtitle") : t("auth.register.subtitle")}</p>
      <form onSubmit={submit} noValidate className="auth-form">
        <div className="field">
          <label htmlFor={`${uid}-email`}>{t("auth.email")}</label>
          <input
            ref={emailRef}
            id={`${uid}-email`}
            className="input"
            type="email"
            inputMode="email"
            autoComplete={isLogin ? "username" : "email"}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            maxLength={254}
            placeholder={t("auth.emailPlaceholder")}
            aria-invalid={!!emailErr || undefined}
            aria-describedby={`${uid}-email-err`}
          />
          <FieldError id={`${uid}-email-err`}>{emailErr}</FieldError>
        </div>
        <PasswordInput
          id={`${uid}-pw`}
          label={t("auth.password")}
          value={password}
          onChange={setPassword}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))}
          autoComplete={isLogin ? "current-password" : "new-password"}
          invalid={!!pwErr}
          describedBy={`${uid}-pw-err`}
          hint={
            <>
              {!isLogin && <StrengthMeter password={password} />}
              <FieldError id={`${uid}-pw-err`}>{pwErr}</FieldError>
            </>
          }
        />
        {!isLogin && (
          <PasswordInput
            id={`${uid}-pw2`}
            label={t("auth.confirmPassword")}
            value={confirm}
            onChange={setConfirm}
            onBlur={() => setTouched((t) => ({ ...t, confirm: true }))}
            autoComplete="new-password"
            invalid={!!confirmErr}
            describedBy={`${uid}-pw2-err`}
            hint={
              confirmOk ? (
                <div className="field-note ok">
                  <IconCheck size={13} /> {t("auth.passwordsMatch")}
                </div>
              ) : (
                <FieldError id={`${uid}-pw2-err`}>{confirmErr}</FieldError>
              )
            }
          />
        )}
        {isLogin && (
          <div className="auth-row">
            <button type="button" className="link-btn subtle" onClick={() => setForgot((f) => !f)} aria-expanded={forgot} aria-controls={`${uid}-forgot`}>
              {t("auth.forgot")}
            </button>
          </div>
        )}
        <div className={`collapse ${forgot ? "open" : ""}`} id={`${uid}-forgot`}>
          <div className="collapse-inner">
            <div className="auth-notice">
              <IconInfo size={16} />
              <span>
                <Trans k="auth.forgotBody" components={{ b: <strong /> }} />
              </span>
            </div>
          </div>
        </div>
        <div className={`form-error ${error ? "show" : ""}`} role="alert" aria-live="assertive">
          {error && <IconAlert size={15} />} <span>{error}</span>
        </div>
        <button className="btn primary block lg" type="submit" disabled={busy}>
          {busy ? <Spinner size={16} /> : null}
          <span>{busy ? (isLogin ? t("auth.login.busy") : t("auth.register.busy")) : isLogin ? t("auth.login.submit") : t("auth.register.submit")}</span>
        </button>
      </form>
      {allowRegistration ? (
        <p className="auth-switch">
          {isLogin ? (
            <>
              {t("auth.login.noAccount")}{" "}
              <a href="/register" onClick={go("/register")}>
                {t("auth.login.toRegister")}
              </a>
            </>
          ) : (
            <>
              {t("auth.register.haveAccount")}{" "}
              <a href="/login" onClick={go("/login")}>
                {t("auth.register.toLogin")}
              </a>
            </>
          )}
        </p>
      ) : (
        isLogin && (
          <p className="auth-request">
            <Trans k="auth.requestAccess" components={{ a: <a href={mailtoAccess(t)} /> }} />
          </p>
        )
      )}
    </div>
  )
}

const CAPS = [
  { k: "contracts", icon: <IconGavel size={18} /> },
  { k: "remedies", icon: <IconGlobe size={18} /> },
  { k: "citations", icon: <IconQuote size={18} /> },
]

export default function AuthPage({ mode, allowRegistration, onAuthed }) {
  const t = useT()
  const [locale] = useLocale()
  return (
    <div className="auth">
      <aside className="auth-hero" aria-label={t("auth.hero.label")}>
        <div className="auth-hero-inner">
          <div className="auth-brand">
            <TechlabLogo height={40} />
            <span className="brand-name">LegalAI</span>
          </div>
          <h2 className="hero-title">
            <Trans k="auth.hero.title" components={{ br: <br /> }} />
          </h2>
          <ul className="hero-caps">
            {CAPS.map((c, i) => (
              <li key={c.k} style={{ animationDelay: `${200 + i * 90}ms` }}>
                <span className="hero-cap-icon" aria-hidden="true">
                  {c.icon}
                </span>
                <span>
                  <strong>{t(`auth.hero.caps.${c.k}.title`)}</strong>
                  <span>{t(`auth.hero.caps.${c.k}.text`)}</span>
                </span>
              </li>
            ))}
          </ul>
          <figure className="hero-demo" aria-label={t("auth.hero.demoLabel")}>
            <div className="hero-q">{t("auth.hero.demoQ")}</div>
            <div className="hero-a">
              <Trans k="auth.hero.demoA" components={{ b: <strong /> }} /> <span className="cite static">1</span>
            </div>
            <figcaption className="hero-src">
              <span className="src-num">1</span> {t("auth.hero.demoSrc")} · <span className="status-badge">{t("sources.status.partlyExpired")}</span>
            </figcaption>
          </figure>
        </div>
      </aside>
      <main className="auth-main">
        <a className="auth-home" href={locale === "en" ? "/en" : "/"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          {t("auth.home")}
        </a>
        <LanguageToggle className="auth-lang" />
        <div className="auth-mobile-brand">
          <TechlabLogo height={28} />
          <span className="brand-name">LegalAI</span>
        </div>
        <div className="auth-card">
          {mode === "register" && !allowRegistration ? <RegisterClosed /> : <AuthForm mode={mode} allowRegistration={allowRegistration} onAuthed={onAuthed} />}
        </div>
        <p className="auth-foot">{t("auth.disclaimer")}</p>
        <div className="auth-endorse">
          <span className="ftu-plate bare">
            <img src="/brand/ftu-logo.png" width="491" height="108" alt={t("site.endorse.ftuAlt")} />
          </span>
          <span>
            {t("site.endorse.line1")} – {t("site.endorse.line2")}
          </span>
        </div>
      </main>
    </div>
  )
}
