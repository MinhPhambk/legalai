// Public landing page ("/" vi, "/en" en). Prerendered to static HTML at build time and hydrated.
// Copy lives in locales/*.json under "landing.*" / "site.*". Only real product features are described.
import { useEffect, useRef, useState } from "react"
import { Trans, useT } from "../i18n.jsx"
import { navigate } from "../route.js"
import { LogoMark } from "../components/Logo.jsx"
import { SiteShell, Endorsement, mailto, useReveal } from "./Site.jsx"
import { SOURCES, VIDEO } from "./config.js"

/** Theme-aware product screenshot: a light and a dark capture, CSS shows the one that matches. */
export function Shot({ name, w, h, alt, eager = false, className = "", sizes = "(max-width: 1000px) 92vw, 600px", mobile = null }) {
  const common = { width: w, height: h, decoding: "async", sizes }
  // Non-hero captures also ship a 480 px wide variant (scripts: web/scripts/demo-video → media-variants).
  const srcSet = (theme) => (eager ? undefined : `/media/${name}-${theme}-480.webp 480w, /media/${name}-${theme}.webp ${w}w`)
  // `mobile` = [name, w, h]: a phone capture served on narrow screens (<picture> per theme).
  const one = (theme) => {
    const first = theme === "light"
    const img = <img src={`/media/${name}-${theme}.webp`} {...common} alt={first ? alt : ""} aria-hidden={first ? undefined : "true"} loading={eager && first ? "eager" : "lazy"} fetchPriority={eager && first ? "high" : undefined} />
    if (!mobile) return <img className={`shot-${theme}`} src={`/media/${name}-${theme}.webp`} srcSet={srcSet(theme)} {...common} alt={first ? alt : ""} aria-hidden={first ? undefined : "true"} loading={eager && first ? "eager" : "lazy"} fetchPriority={eager && first ? "high" : undefined} />
    return (
      <picture className={`shot-${theme}`}>
        <source media="(max-width: 640px)" srcSet={`/media/${mobile[0]}-${theme}${mobile[3] || ""}.webp`} width={mobile[1]} height={mobile[2]} />
        {img}
      </picture>
    )
  }
  return (
    <span className={`shot ${className}`}>
      {one("light")}
      {one("dark")}
    </span>
  )
}

const Check = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5 10 17l9-10" />
  </svg>
)
const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)
const Play = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor" />
  </svg>
)

// ---- hero ---------------------------------------------------------------------------------------------
const STEPS = ["find", "article", "verify", "ground"]

/** Animated "research steps" card (real steps from a recorded answer); static when motion is reduced. */
function StepsCard() {
  const t = useT()
  const [n, setN] = useState(STEPS.length) // server + no-JS: all steps done
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let i = 0
    setN(0)
    const id = setInterval(() => {
      i = i >= STEPS.length + 3 ? 0 : i + 1
      setN(Math.min(i, STEPS.length))
    }, 900)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="float-card steps-card" aria-hidden="true">
      <div className="float-head">
        <span className={`pulse-dot ${n < STEPS.length ? "busy" : ""}`} />
        {n < STEPS.length ? t("landing.hero.steps.busy") : t("landing.hero.steps.done", { count: STEPS.length })}
      </div>
      <ol>
        {STEPS.map((k, i) => (
          <li key={k} className={i < n ? "done" : i === n ? "run" : ""}>
            <span className="step-ic">{i < n ? <Check /> : <span className="spin" />}</span>
            <span>{t(`landing.hero.steps.${k}`)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function CiteCard() {
  const t = useT()
  return (
    <figure className="float-card hero-cite" aria-hidden="true">
      <div className="cite-top">
        <span className="cite-num">1</span>
        <span className="cite-src">{t("landing.hero.cite.source")}</span>
      </div>
      <blockquote lang="vi">{t("landing.hero.cite.quote")}</blockquote>
      <figcaption>
        <span className="s-chip">{t("landing.hero.cite.status")}</span>
        <span className="s-chip ok">
          <Check /> {t("landing.hero.cite.confidence")}
        </span>
      </figcaption>
    </figure>
  )
}

function Hero() {
  const t = useT()
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-bg" aria-hidden="true" />
      <div className="site-wrap hero-inner">
        <p className="eyebrow-pill">
          <span className="dot" aria-hidden="true" />
          {t("landing.hero.eyebrow")}
        </p>
        <h1 id="hero-title" className="display">
          <Trans k="landing.hero.title" components={{ em: <em />, br: <br /> }} />
        </h1>
        <p className="lead hero-lead">{t("landing.hero.lead")}</p>
        <div className="hero-ctas">
          <a className="site-btn primary lg" href={mailto(t)}>
            {t("site.nav.request")} <Arrow />
          </a>
          <a className="site-btn ghost lg" href="#demo">
            <Play /> {t("landing.hero.watch")}
          </a>
        </div>
        <p className="hero-note">{t("landing.hero.note")}</p>
      </div>
      <div className="site-wrap hero-visual-wrap">
        <div className="hero-visual">
          <div className="browser">
            <div className="browser-bar" aria-hidden="true">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className="browser-url">
                <LogoMark size={14} /> legalai · {t("landing.hero.frameTitle")}
              </span>
            </div>
            <Shot name="hero-answer" w={1600} h={1000} eager mobile={["shot-mobile-answer", 660, 1428, "-660"]} className="hero-shot" alt={t("landing.hero.shotAlt")} sizes="(max-width: 1240px) 100vw, 1180px" />
          </div>
          <StepsCard />
          <CiteCard />
        </div>
      </div>
    </section>
  )
}

// ---- trust bar -------------------------------------------------------------------------------------
function Sources() {
  const t = useT()
  return (
    <section className="src-bar" aria-labelledby="sources-title">
      <div className="site-wrap">
        <h2 id="sources-title" className="src-bar-title">
          {t("landing.sources.title")}
        </h2>
        <ul className="src-bar-list">
          {SOURCES.map((k) => (
            <li key={k}>
              <span className="src-name">{t(`site.sources.${k}.name`)}</span>
              <span className="src-what">{t(`site.sources.${k}.what`)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

// ---- features (bento) -----------------------------------------------------------------------------
function SectionHead({ id, eyebrow, title, lead, center = false }) {
  return (
    <div className={`section-head reveal ${center ? "center" : ""}`}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id} className="h2">
        {title}
      </h2>
      {lead ? <p className="lead">{lead}</p> : null}
    </div>
  )
}

function Bullets({ k, n }) {
  const t = useT()
  return (
    <ul className="ticks">
      {Array.from({ length: n }, (_, i) => (
        <li key={i}>
          <Check />
          <span>{t(`${k}.b${i + 1}`)}</span>
        </li>
      ))}
    </ul>
  )
}

function Features() {
  const t = useT()
  return (
    <section className="section" id="features" aria-labelledby="features-title">
      <div className="site-wrap">
        <SectionHead id="features-title" eyebrow={t("landing.features.eyebrow")} title={t("landing.features.title")} lead={t("landing.features.lead")} />
        <div className="bento">
          <article className="card span-7 reveal">
            <div className="card-text">
              <h3>{t("landing.features.research.title")}</h3>
              <p>{t("landing.features.research.text")}</p>
            </div>
            <div className="card-media bleed">
              <Shot className="pos-mid" name="crop-citations" w={736} h={700} alt={t("landing.features.research.alt")} />
            </div>
          </article>
          <article className="card span-5 reveal">
            <div className="card-text">
              <h3>{t("landing.features.confidence.title")}</h3>
              <p>{t("landing.features.confidence.text")}</p>
            </div>
            <div className="card-media bleed">
              <Shot name="crop-confidence" w={675} h={600} alt={t("landing.features.confidence.alt")} />
            </div>
          </article>
          <article className="card span-5 reveal">
            <div className="card-text">
              <h3>{t("landing.features.contracts.title")}</h3>
              <p>{t("landing.features.contracts.text")}</p>
            </div>
            <div className="card-media bleed">
              <Shot name="crop-doccard" w={675} h={600} alt={t("landing.features.contracts.alt")} />
            </div>
          </article>
          <article className="card span-7 reveal">
            <div className="card-text">
              <h3>{t("landing.features.trade.title")}</h3>
              <p>{t("landing.features.trade.text")}</p>
            </div>
            <div className="card-media bleed">
              <Shot name="crop-trade" w={736} h={700} alt={t("landing.features.trade.alt")} />
            </div>
          </article>
          {["bilingual", "deadline", "safety", "followups"].map((k) => (
            <article key={k} className="card span-3 mini reveal">
              <span className="card-ic" aria-hidden="true">
                <SmallIcon k={k} />
              </span>
              <h3>{t(`landing.features.${k}.title`)}</h3>
              <p>{t(`landing.features.${k}.text`)}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function SmallIcon({ k }) {
  const p = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }
  if (k === "bilingual")
    return (
      <svg {...p}>
        <path d="M4 5h9M8.5 3v2M6 5c.5 3.5 3 6 6 7.5M11 5c-.6 3.8-3.2 6.7-7 8.5" />
        <path d="M13 21l4-9 4 9M14.5 18h5" />
      </svg>
    )
  if (k === "deadline")
    return (
      <svg {...p}>
        <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
        <path d="M3.5 10h17M8 3v4M16 3v4M9 14.5l2 2 4-4" />
      </svg>
    )
  if (k === "safety")
    return (
      <svg {...p}>
        <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    )
  return (
    <svg {...p}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-8Z" />
      <path d="M9 8.5h6M9 11.5h4" />
    </svg>
  )
}

// ---- deep dives -------------------------------------------------------------------------------------
function Contracts() {
  const t = useT()
  return (
    <section className="section alt" aria-labelledby="contracts-title">
      <div className="site-wrap split">
        <div className="split-text reveal">
          <p className="eyebrow">{t("landing.contracts.eyebrow")}</p>
          <h2 id="contracts-title" className="h2">
            {t("landing.contracts.title")}
          </h2>
          <p className="lead">{t("landing.contracts.lead")}</p>
          <Bullets k="landing.contracts" n={5} />
        </div>
        <div className="split-media reveal">
          <div className="frame">
            <Shot name="crop-diff" w={700} h={900} alt={t("landing.contracts.alt")} />
          </div>
        </div>
      </div>
    </section>
  )
}

function Trade() {
  const t = useT()
  const rows = ["trav", "fedreg", "eurlex", "eping", "fta"]
  return (
    <section className="section" aria-labelledby="trade-title">
      <div className="site-wrap split reverse">
        <div className="split-text reveal">
          <p className="eyebrow">{t("landing.trade.eyebrow")}</p>
          <h2 id="trade-title" className="h2">
            {t("landing.trade.title")}
          </h2>
          <p className="lead">{t("landing.trade.lead")}</p>
          <Bullets k="landing.trade" n={3} />
        </div>
        <div className="split-media reveal">
          <div className="source-table" role="table" aria-label={t("landing.trade.tableLabel")}>
            <div className="st-row st-head" role="row">
              <span role="columnheader">{t("landing.trade.colSource")}</span>
              <span role="columnheader">{t("landing.trade.colWhat")}</span>
            </div>
            {rows.map((k) => (
              <div className="st-row" role="row" key={k}>
                <span role="cell" className="st-src">
                  {t(`site.sources.${k}.name`)}
                </span>
                <span role="cell">{t(`landing.trade.rows.${k}`)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function How() {
  const t = useT()
  return (
    <section className="section alt" id="how" aria-labelledby="how-title">
      <div className="site-wrap">
        <SectionHead id="how-title" eyebrow={t("landing.how.eyebrow")} title={t("landing.how.title")} center />
        <ol className="how">
          {[1, 2, 3].map((i) => (
            <li key={i} className="reveal">
              <span className="how-num" aria-hidden="true">
                {i}
              </span>
              <h3>{t(`landing.how.s${i}.title`)}</h3>
              <p>{t(`landing.how.s${i}.text`)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

// ---- demo video -------------------------------------------------------------------------------------
function Demo({ locale }) {
  const t = useT()
  const other = locale === "en" ? "vi" : "en"
  // The poster is attached when the player nears the viewport (it must not compete with the hero image).
  const [poster, setPoster] = useState(undefined)
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !("IntersectionObserver" in window)) return setPoster(VIDEO.poster)
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setPoster(VIDEO.poster), io.disconnect()), { rootMargin: "600px 0px" })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <section className="section demo" id="demo" aria-labelledby="demo-title">
      <div className="site-wrap">
        <SectionHead id="demo-title" eyebrow={t("landing.demo.eyebrow")} title={t("landing.demo.title")} lead={t("landing.demo.lead")} center />
        <div className="video-frame reveal">
          <video ref={ref} controls preload="none" playsInline poster={poster} width={VIDEO.width} height={VIDEO.height} aria-describedby="demo-transcript">
            <source src={VIDEO.webm} type="video/webm" />
            <source src={VIDEO.mp4} type="video/mp4" />
            <track kind="captions" src={VIDEO.vtt[locale]} srcLang={locale} label={t(`site.langName.${locale}`)} default />
            <track kind="captions" src={VIDEO.vtt[other]} srcLang={other} label={t(`site.langName.${other}`)} />
            <a href={VIDEO.mp4}>{t("landing.demo.download")}</a>
          </video>
        </div>
        <details className="transcript reveal" id="demo-transcript">
          <summary>{t("landing.demo.transcriptTitle")}</summary>
          <ol>
            {Array.from({ length: 12 }, (_, i) => (
              <li key={i}>{t(`landing.demo.transcript.t${i + 1}`)}</li>
            ))}
          </ol>
          <p className="s-muted">{t("landing.demo.transcriptNote")}</p>
        </details>
      </div>
    </section>
  )
}

// ---- bilingual ----------------------------------------------------------------------------------------
function Bilingual() {
  const t = useT()
  return (
    <section className="section" aria-labelledby="bi-title">
      <div className="site-wrap split">
        <div className="split-text reveal">
          <p className="eyebrow">{t("landing.bilingual.eyebrow")}</p>
          <h2 id="bi-title" className="h2">
            {t("landing.bilingual.title")}
          </h2>
          <p className="lead">{t("landing.bilingual.lead")}</p>
          <Bullets k="landing.bilingual" n={3} />
        </div>
        <div className="split-media reveal">
          <figure className="bi-doc">
            <figcaption>{t("landing.bilingual.docTitle")}</figcaption>
            <div className="bi-cols">
              <div lang="vi">
                <p className="bi-head">{t("landing.bilingual.viHead")}</p>
                <p>{t("landing.bilingual.viText")}</p>
              </div>
              <div lang="en">
                <p className="bi-head">{t("landing.bilingual.enHead")}</p>
                <p>{t("landing.bilingual.enText")}</p>
              </div>
            </div>
            <p className="bi-note">{t("landing.bilingual.docNote")}</p>
          </figure>
        </div>
      </div>
    </section>
  )
}

// ---- about + limits -------------------------------------------------------------------------------
function About() {
  const t = useT()
  return (
    <section className="section alt" id="about" aria-labelledby="about-title">
      <div className="site-wrap about-grid">
        <div className="about-main reveal">
          <p className="eyebrow">{t("landing.about.eyebrow")}</p>
          <h2 id="about-title" className="h2">
            {t("landing.about.title")}
          </h2>
          <p className="lead">{t("landing.about.text")}</p>
          <Endorsement />
        </div>
        <div className="limits reveal" id="limits">
          <h3>{t("landing.limits.title")}</h3>
          <ul>
            {Array.from({ length: 5 }, (_, i) => (
              <li key={i}>{t(`landing.limits.l${i + 1}`)}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

// ---- FAQ --------------------------------------------------------------------------------------------
export const FAQ_KEYS = ["advice", "sources", "confidence", "data", "model", "access", "files", "language"]
function Faq() {
  const t = useT()
  return (
    <section className="section" id="faq" aria-labelledby="faq-title">
      <div className="site-wrap faq-wrap">
        <SectionHead id="faq-title" eyebrow={t("landing.faq.eyebrow")} title={t("landing.faq.title")} />
        <div className="faq">
          {FAQ_KEYS.map((k) => (
            <details key={k} className="faq-item reveal">
              <summary>
                <h3>{t(`landing.faq.${k}.q`)}</h3>
                <span className="faq-plus" aria-hidden="true" />
              </summary>
              <p>{t(`landing.faq.${k}.a`)}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

function Cta() {
  const t = useT()
  return (
    <section className="cta-band" aria-labelledby="cta-title">
      <div className="site-wrap">
        <div className="cta-card reveal">
          <div className="cta-glow" aria-hidden="true" />
          <LogoMark size={44} />
          <h2 id="cta-title" className="h2">
            {t("landing.cta.title")}
          </h2>
          <p className="lead">{t("landing.cta.text")}</p>
          <div className="hero-ctas">
            <a className="site-btn primary lg" href={mailto(t)}>
              {t("site.nav.request")} <Arrow />
            </a>
            <a
              className="site-btn ghost lg on-dark"
              href="/login"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.button !== 0) return
                e.preventDefault()
                navigate("/login")
              }}
            >
              {t("site.nav.login")}
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

export default function Landing({ locale, signedIn }) {
  useReveal(locale)
  return (
    <SiteShell locale={locale} page="landing" signedIn={signedIn}>
      <Hero />
      <Sources />
      <Features />
      <Contracts />
      <Trade />
      <How />
      <Demo locale={locale} />
      <Bilingual />
      <About />
      <Faq />
      <Cta />
    </SiteShell>
  )
}
