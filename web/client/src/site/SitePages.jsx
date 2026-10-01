// Router for the public site pages. Keeps <html data-site> / page title / language in sync while a site
// page is shown and restores the app's document state when leaving (e.g. landing → /login).
import { useEffect } from "react"
import { applyDocument, useT } from "../i18n.jsx"
import Landing from "./Landing.jsx"
import BrandPage from "./BrandPage.jsx"
import LegalPage from "./LegalPage.jsx"

export default function SitePages({ page, locale, signedIn }) {
  const t = useT()
  useEffect(() => {
    const d = document.documentElement
    d.setAttribute("data-site", "")
    d.lang = locale
    document.title = t(`site.meta.${page}.title`)
    return () => {
      d.removeAttribute("data-site")
      applyDocument()
    }
  }, [page, locale]) // eslint-disable-line react-hooks/exhaustive-deps
  if (page === "brand") return <BrandPage locale={locale} signedIn={signedIn} />
  if (page === "privacy" || page === "terms") return <LegalPage kind={page} locale={locale} signedIn={signedIn} />
  return <Landing locale={locale} signedIn={signedIn} />
}
