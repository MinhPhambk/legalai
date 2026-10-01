// Public site: prerendered pages (client/dist/_site, built by scripts/prerender.mjs), robots.txt,
// sitemap.xml and the indexing policy.
//  - URLs in the head use SITE_URL (e.g. https://legalai.example.vn) or, when unset, the request origin.
//  - Indexing is allowed ONLY when SITE_URL is a real public domain AND the request comes in on that host.
//    Temporary hosts (*.trycloudflare.com, localhost, IPs) and SITE_URL unset → X-Robots-Tag: noindex +
//    robots.txt "Disallow: /".
//  - App, auth, share and API responses are always noindex (see app.mjs).
import fs from "node:fs"
import path from "node:path"
import { CLIENT_DIST } from "./config.mjs"
import { COOKIE, parseCookies, userForToken } from "./auth.mjs"
import { sendHtml } from "./compress.mjs"

const SITE_DIR = path.join(CLIENT_DIST, "_site")
const TEMP_HOST = /(^|\.)(trycloudflare\.com|ngrok(-free)?\.app|ngrok\.io|loca\.lt|localhost)$|^\d{1,3}(\.\d{1,3}){3}$|^\[?[0-9a-f:]+\]?$/i

function siteUrl() {
  const raw = String(process.env.SITE_URL || "").trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (!/^https?:$/.test(u.protocol)) return null
    return u.origin
  } catch {
    return null
  }
}

/** Host the visitor used (the local tunnel forwards it; only trusted from 127.0.0.1). */
export function requestHost(req) {
  const fwd = req.headers["x-forwarded-host"] && req.ip === "127.0.0.1" ? req.headers["x-forwarded-host"] : null
  return String(fwd || req.headers.host || "").split(",")[0].trim()
}
export function requestOrigin(req) {
  return siteUrl() || `${req.protocol}://${requestHost(req)}`
}
/** May search engines index public pages for this request? */
export function indexable(req) {
  const s = siteUrl()
  if (!s) return false
  const host = new URL(s).hostname
  if (TEMP_HOST.test(host)) return false
  return requestHost(req).split(":")[0].toLowerCase() === host.toLowerCase()
}

let cache = { mtime: 0, manifest: null, files: new Map() }
function manifest() {
  const f = path.join(SITE_DIR, "manifest.json")
  let st
  try {
    st = fs.statSync(f)
  } catch {
    return null
  }
  if (st.mtimeMs !== cache.mtime) cache = { mtime: st.mtimeMs, manifest: JSON.parse(fs.readFileSync(f, "utf8")), files: new Map() }
  return cache.manifest
}
function pageHtml(file) {
  let html = cache.files.get(file)
  if (html == null) cache.files.set(file, (html = fs.readFileSync(path.join(SITE_DIR, file), "utf8")))
  return html
}
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

const signedIn = (req) => {
  const token = parseCookies(req.headers.cookie)[COOKIE]
  return !!(token && userForToken(token))
}

export function registerSiteRoutes(app, { sendApp }) {
  // Temporary / non-canonical hosts: keep everything out of search engines.
  app.use((req, res, next) => {
    if (!indexable(req)) res.setHeader("X-Robots-Tag", "noindex, nofollow")
    next()
  })

  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").setHeader("Cache-Control", "public, max-age=3600")
    if (!indexable(req)) return res.send("# Temporary host – not for indexing.\nUser-agent: *\nDisallow: /\n")
    const o = requestOrigin(req)
    res.send(
      ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /c/", "Disallow: /s/", "Disallow: /admin", "Disallow: /expert", "Disallow: /login", "Disallow: /register", "", `Sitemap: ${o}/sitemap.xml`, ""].join("\n"),
    )
  })

  app.get("/sitemap.xml", (req, res) => {
    const m = manifest()
    if (!m) return res.status(503).type("text/plain").send("Site not built")
    const o = requestOrigin(req)
    const lastmod = new Date(cache.mtime).toISOString().slice(0, 10)
    const byPage = {}
    for (const [p, v] of Object.entries(m)) if (v.index) (byPage[v.page] ??= {})[v.locale] = p
    const urls = Object.values(byPage).flatMap((alt) =>
      Object.values(alt).map(
        (p) =>
          `  <url>\n    <loc>${o}${p}</loc>\n    <lastmod>${lastmod}</lastmod>\n` +
          Object.entries(alt)
            .map(([l, ap]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${o}${ap}"/>\n`)
            .join("") +
          `    <xhtml:link rel="alternate" hreflang="x-default" href="${o}${alt.vi}"/>\n  </url>`,
      ),
    )
    res.type("application/xml").setHeader("Cache-Control", "public, max-age=3600")
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`)
  })

  // "/en/" → "/en" etc. (one canonical URL per page).
  app.get(/^\/(en|brand|privacy|terms|en\/brand|en\/privacy|en\/terms)\/$/, (req, res) => res.redirect(301, req.path.slice(0, -1)))

  app.get(/^\/(en(\/(brand|privacy|terms))?|brand|privacy|terms)?$/, (req, res, next) => {
    const m = manifest()
    const entry = m?.[req.path]
    if (!entry) return next() // not built: fall back to the SPA
    // The landing is for signed-out visitors: signed-in users get the app ("/" = new chat).
    if (entry.page === "landing" && signedIn(req)) {
      if (req.path !== "/") return res.redirect(302, "/")
      res.setHeader("X-Robots-Tag", "noindex, nofollow")
      res.setHeader("Vary", "Cookie")
      return sendApp(req, res)
    }
    const robots = indexable(req) ? "index, follow, max-image-preview:large" : "noindex, nofollow"
    const html = pageHtml(entry.file).replaceAll("{{ORIGIN}}", escAttr(requestOrigin(req))).replaceAll("{{ROBOTS}}", robots)
    res.setHeader("Cache-Control", "no-cache")
    if (!entry.index) res.setHeader("X-Robots-Tag", "noindex, follow")
    sendHtml(req, res, html, `${entry.file}|${requestOrigin(req)}|${robots}|${cache.mtime}`)
  })
}
