// /brand (+ /en/brand): LegalAI brand guideline – logo, clear space, don'ts, colour tokens with computed
// WCAG contrast, typography, voice & tone, UI examples, downloads. Public but noindex.
import { hasKey, useT } from "../i18n.jsx"
import { LogoMark, Lockup } from "../components/Logo.jsx"
import { SiteShell, Endorsement, useReveal } from "./Site.jsx"
import { CONTRAST_PAIRS, NEUTRAL, RED, ROLES, STATUS, TYPE_SCALE, contrast } from "./tokens.js"

const B = "/brand/"
const LOGOS = [
  { k: "horizontal-color", bg: "light" },
  { k: "horizontal-color-on-dark", bg: "dark" },
  { k: "stacked-color", bg: "light" },
  { k: "horizontal-black", bg: "light" },
  { k: "horizontal-white", bg: "dark" },
  { k: "horizontal-red", bg: "light" },
  { k: "mark-color", bg: "light" },
  { k: "mark-black", bg: "light" },
  { k: "mark-white", bg: "dark" },
]
const camel = (k) => k.replace(/-(\w)/g, (m, c) => c.toUpperCase())
const ratio = (r) => `${r.toFixed(2)}:1`
const grade = (r, min = 4.5) => (r >= 7 ? "AAA" : r >= min ? "AA" : r >= 3 ? "AA Large" : "—")

function Swatch({ name, hex, note }) {
  const w = contrast(hex, "#FFFFFF")
  const b = contrast(hex, "#0F0F0F")
  const fg = w >= b ? "#FFFFFF" : "#121212"
  return (
    <li className="swatch">
      <span className="swatch-chip" style={{ background: hex, color: fg }}>
        {name}
      </span>
      <span className="swatch-meta">
        <code>{hex}</code>
        {note ? <em>{note}</em> : null}
        <span>
          ◻ {ratio(w)} · ◼ {ratio(b)}
        </span>
      </span>
    </li>
  )
}

export default function BrandPage({ locale, signedIn }) {
  const t = useT()
  useReveal(locale)
  const sec = (id, children) => (
    <section className="brand-sec reveal" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="h2">
        {t(`brand.${id}.title`)}
      </h2>
      {hasKey(`brand.${id}.lead`) ? <p className="lead">{t(`brand.${id}.lead`)}</p> : null}
      {children}
    </section>
  )
  return (
    <SiteShell locale={locale} page="brand" signedIn={signedIn}>
      <div className="brand-page site-wrap">
        <header className="brand-hero">
          <p className="eyebrow">{t("brand.eyebrow")}</p>
          <h1 className="h1">{t("brand.title")}</h1>
          <p className="lead">{t("brand.lead")}</p>
          <nav className="brand-toc" aria-label={t("brand.toc")}>
            {["logo", "space", "donts", "color", "type", "voice", "ui", "endorse", "downloads"].map((id) => (
              <a key={id} href={`#${id}`}>
                {t(`brand.${id}.title`)}
              </a>
            ))}
          </nav>
        </header>

        {sec(
          "logo",
          <>
            <div className="brand-rationale">
              <div className="rationale-mark">
                <LogoMark size={120} />
              </div>
              <div>
                <h3>{t("brand.logo.rationaleTitle")}</h3>
                <p>{t("brand.logo.rationale")}</p>
              </div>
            </div>
            <ul className="logo-grid">
              {LOGOS.map(({ k, bg }) => (
                <li key={k} className={`logo-tile ${bg}`}>
                  <div className="logo-tile-art">
                    <img src={`${B}legalai-${k}.svg`} alt={`LegalAI – ${t(`brand.logo.variants.${camel(k)}`)}`} loading="lazy" />
                  </div>
                  <div className="logo-tile-meta">
                    <span>{t(`brand.logo.variants.${camel(k)}`)}</span>
                    <span className="dl">
                      <a href={`${B}legalai-${k}.svg`} download>
                        SVG
                      </a>
                      <a href={`${B}legalai-${k}.png`} download>
                        PNG
                      </a>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>,
        )}

        {sec(
          "space",
          <div className="space-grid">
            <figure className="space-demo">
              <div className="space-box">
                <Lockup size={48} />
              </div>
              <figcaption>{t("brand.space.clear")}</figcaption>
            </figure>
            <figure className="space-demo">
              <div className="min-row">
                <span>
                  <LogoMark size={16} />
                  <small>16 px</small>
                </span>
                <span>
                  <Lockup size={18} />
                  <small>{t("brand.space.minLockup")}</small>
                </span>
              </div>
              <figcaption>{t("brand.space.min")}</figcaption>
            </figure>
          </div>,
        )}

        {sec(
          "donts",
          <ul className="donts">
            {["stretch", "recolor", "rotate", "effects", "busy", "combine"].map((k) => (
              <li key={k}>
                <div className={`dont-art dont-${k}`} aria-hidden="true">
                  {k === "combine" ? (
                    <span className="dont-combo">
                      <LogoMark size={40} />
                      <span className="plus">+</span>
                      <span className="fake-emblem" />
                    </span>
                  ) : (
                    <Lockup size={30} />
                  )}
                  <span className="dont-x" />
                </div>
                <p>{t(`brand.donts.${k}`)}</p>
              </li>
            ))}
          </ul>,
        )}

        {sec(
          "color",
          <>
            <h3 className="h3">{t("brand.color.red")}</h3>
            <ul className="swatches">
              {Object.entries(RED).map(([k, v]) => (
                <Swatch key={k} name={`red ${k}`} hex={v} note={k === "600" ? t("brand.color.brandNote") : k === "300" ? t("brand.color.darkLinkNote") : null} />
              ))}
            </ul>
            <h3 className="h3">{t("brand.color.neutral")}</h3>
            <ul className="swatches">
              {Object.entries(NEUTRAL).map(([k, v]) => (
                <Swatch key={k} name={`neutral ${k}`} hex={v} />
              ))}
            </ul>
            <h3 className="h3">{t("brand.color.status")}</h3>
            <ul className="swatches">
              {Object.entries(STATUS.light).map(([k, v]) => (
                <Swatch key={k} name={`${k} · ${t("brand.color.light")}`} hex={v} />
              ))}
              {Object.entries(STATUS.dark).map(([k, v]) => (
                <Swatch key={`d${k}`} name={`${k} · ${t("brand.color.dark")}`} hex={v} />
              ))}
            </ul>
            <h3 className="h3">{t("brand.color.pairs")}</h3>
            <div className="table-wrap">
              <table className="contrast-table">
                <thead>
                  <tr>
                    <th scope="col">{t("brand.color.theme")}</th>
                    <th scope="col">{t("brand.color.pair")}</th>
                    <th scope="col">{t("brand.color.sample")}</th>
                    <th scope="col">{t("brand.color.ratio")}</th>
                    <th scope="col">WCAG</th>
                  </tr>
                </thead>
                <tbody>
                  {CONTRAST_PAIRS.map(([theme, fg, bg, min]) => {
                    const r = contrast(ROLES[theme][fg], ROLES[theme][bg])
                    return (
                      <tr key={`${theme}${fg}${bg}`}>
                        <td>{t(`brand.color.${theme}`)}</td>
                        <td>
                          <code>{fg}</code> / <code>{bg}</code>
                        </td>
                        <td>
                          <span className="pair-sample" style={{ color: ROLES[theme][fg], background: ROLES[theme][bg] }}>
                            Aa {ROLES[theme][fg]}
                          </span>
                        </td>
                        <td>{ratio(r)}</td>
                        <td>
                          <span className={`grade ${r >= min ? "ok" : "bad"}`}>{grade(r, min)}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="s-muted">{t("brand.color.usage")}</p>
          </>,
        )}

        {sec(
          "type",
          <div className="type-scale">
            {TYPE_SCALE.map((s) => (
              <div key={s.token} className="type-row">
                <div className="type-meta">
                  <code>{s.token}</code>
                  <span>
                    {s.size} · {s.weight} · {s.line} · {s.track}
                  </span>
                </div>
                <p style={{ fontSize: s.size, lineHeight: s.line, fontWeight: s.weight, letterSpacing: s.track, textTransform: s.token === "eyebrow" ? "uppercase" : undefined }}>
                  {t(s.token === "body" || s.token === "small" || s.token === "lead" ? "brand.type.sampleLong" : "brand.type.sample")}
                </p>
              </div>
            ))}
          </div>,
        )}

        {sec(
          "voice",
          <div className="voice-grid">
            {["clear", "honest", "grounded", "respectful"].map((k) => (
              <div key={k} className="voice-card">
                <h3>{t(`brand.voice.${k}.title`)}</h3>
                <p>{t(`brand.voice.${k}.text`)}</p>
                <p className="say">
                  <span>{t("brand.voice.say")}</span> {t(`brand.voice.${k}.do`)}
                </p>
                <p className="avoid">
                  <span>{t("brand.voice.avoid")}</span> {t(`brand.voice.${k}.dont`)}
                </p>
              </div>
            ))}
          </div>,
        )}

        {sec(
          "ui",
          <div className="ui-demo">
            <div className="ui-row">
              <button type="button" className="site-btn primary">
                {t("brand.ui.primary")}
              </button>
              <button type="button" className="site-btn ghost">
                {t("brand.ui.secondary")}
              </button>
              <a href="#ui" className="ui-link">
                {t("brand.ui.link")}
              </a>
            </div>
            <div className="ui-row">
              <label className="ui-field">
                <span>{t("brand.ui.label")}</span>
                <input type="text" placeholder={t("brand.ui.placeholder")} />
              </label>
            </div>
            <div className="ui-row">
              <span className="s-chip ok">{t("brand.ui.confHigh")}</span>
              <span className="s-chip warn">{t("brand.ui.confMid")}</span>
              <span className="s-chip err">{t("brand.ui.confLow")}</span>
              <span className="cite-num">1</span>
              <span className="s-chip">{t("brand.ui.status")}</span>
            </div>
          </div>,
        )}

        {sec(
          "endorse",
          <div className="endorse-rules">
            <Endorsement />
            <ul className="ticks plain">
              {[1, 2, 3, 4].map((i) => (
                <li key={i}>{t(`brand.endorse.r${i}`)}</li>
              ))}
            </ul>
          </div>,
        )}

        {sec(
          "downloads",
          <div className="downloads">
            <a className="site-btn primary lg" href={`${B}legalai-brand-kit.zip`} download>
              {t("brand.downloads.zip")}
            </a>
            <p className="s-muted">{t("brand.downloads.note")}</p>
          </div>,
        )}
      </div>
    </SiteShell>
  )
}
