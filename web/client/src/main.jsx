import { StrictMode } from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import App from "./App.jsx"
import { ConfirmProvider, ToastProvider } from "./components/ui.jsx"
import { setLocale } from "./i18n.jsx"
import { sitePage } from "./route.js"
import "./fonts.js"
import "./styles-core.css"
import "./site/site.css"
// App screen styles load with the (lazy) app modules – see app-styles.js.

const root = document.getElementById("root")
// Public site pages are prerendered (scripts/prerender.mjs): their language comes from the URL, and the
// markup is hydrated instead of re-rendered.
const ssr = root.hasAttribute("data-ssr")
const site = sitePage(window.location.pathname)
if (site) setLocale(site.locale, { persist: false })
const tree = (
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App ssr={ssr} />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>
)
if (ssr && site) hydrateRoot(root, tree)
else createRoot(root).render(tree)
