// Server-side render entry used only by scripts/prerender.mjs (built with `vite build --ssr`).
// Renders exactly the tree that main.jsx hydrates, for a public site path ("/", "/en", "/brand", …).
import { StrictMode } from "react"
import { renderToString } from "react-dom/server"
import App from "./App.jsx"
import { ConfirmProvider, ToastProvider } from "./components/ui.jsx"
import { setLocale } from "./i18n.jsx"
import { setServerPath, sitePage } from "./route.js"

export function render(path) {
  const site = sitePage(path)
  if (!site) throw new Error(`not a site page: ${path}`)
  setLocale(site.locale, { persist: false })
  setServerPath(path)
  return renderToString(
    <StrictMode>
      <ToastProvider>
        <ConfirmProvider>
          <App ssr />
        </ConfirmProvider>
      </ToastProvider>
    </StrictMode>,
  )
}
