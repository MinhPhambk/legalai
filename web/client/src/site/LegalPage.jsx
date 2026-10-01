// /privacy and /terms (+ /en/…): honest DRAFT texts, clearly marked, to be reviewed before launch.
import { useT } from "../i18n.jsx"
import { SiteShell, mailto } from "./Site.jsx"
import { CONTACT_EMAIL } from "./config.js"

const SECTIONS = { privacy: 8, terms: 7 }

export default function LegalPage({ kind, locale, signedIn }) {
  const t = useT()
  const n = SECTIONS[kind]
  return (
    <SiteShell locale={locale} page={kind} signedIn={signedIn}>
      <article className="legal site-wrap narrow">
        <nav className="crumbs" aria-label={t("site.crumbs.label")}>
          <a href={locale === "en" ? "/en" : "/"}>{t("site.crumbs.home")}</a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{t(`legal.${kind}.title`)}</span>
        </nav>
        <p className="draft-badge">{t("legal.draftBadge")}</p>
        <h1 className="h1">{t(`legal.${kind}.title`)}</h1>
        <p className="lead">{t(`legal.${kind}.intro`)}</p>
        <p className="draft-note">{t("legal.draftNote")}</p>
        {Array.from({ length: n }, (_, i) => (
          <section key={i}>
            <h2>{t(`legal.${kind}.s${i + 1}.h`)}</h2>
            <p>{t(`legal.${kind}.s${i + 1}.p`)}</p>
          </section>
        ))}
        <section>
          <h2>{t("legal.contactH")}</h2>
          <p>
            {t("legal.contactP")} <a href={mailto(t)}>{CONTACT_EMAIL}</a>
          </p>
        </section>
        <p className="s-muted">{t("legal.updated")}</p>
      </article>
    </SiteShell>
  )
}
