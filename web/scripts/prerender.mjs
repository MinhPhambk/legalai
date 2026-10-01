// Prerenders the public site pages to static HTML after `vite build` (run by `npm run build`):
//   /, /en, /brand, /en/brand, /privacy, /en/privacy, /terms, /en/terms  →  client/dist/_site/<name>.html
// 1. builds client/src/ssr.jsx with Vite in SSR mode (temporary folder), 2. renders each page with
// React renderToString, 3. injects it into dist/index.html with a full SEO head (title, description,
// canonical, hreflang, Open Graph, Twitter card, JSON-LD). URLs in the head use the token {{ORIGIN}}
// and robots meta the token {{ROBOTS}}, both filled per request by server/site.mjs (SITE_URL or the
// request origin; noindex on temporary hosts). The browser hydrates the same markup (main.jsx).
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { build } from "vite"
import react from "@vitejs/plugin-react"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const client = path.join(web, "client")
const dist = path.join(client, "dist")
const tmp = path.join(web, ".ssr-build")
const outDir = path.join(dist, "_site")
const DICT = { vi: JSON.parse(fs.readFileSync(path.join(client, "src/locales/vi.json"), "utf8")), en: JSON.parse(fs.readFileSync(path.join(client, "src/locales/en.json"), "utf8")) }
const tr = (l, key) => key.split(".").reduce((o, k) => o?.[k], DICT[l]) ?? key
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const strip = (s) => String(s).replace(/<[^>]+>/g, "")

// ---- 1. SSR bundle -------------------------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true })
await build({
  root: client,
  configFile: false,
  logLevel: "warn",
  plugins: [react()],
  cacheDir: path.join(web, "node_modules/.vite-ssr"),
  build: { ssr: path.join(client, "src/ssr.jsx"), outDir: tmp, emptyOutDir: true, target: "node22", rollupOptions: { output: { format: "es", entryFileNames: "ssr.mjs" } } },
})
const { render } = await import(pathToFileURL(path.join(tmp, "ssr.mjs")).href)

// ---- 2. head -------------------------------------------------------------------------------------------
// The stylesheet is inlined into the prerendered pages (one render-blocking request less on slow
// connections; the CSP allows inline styles). App pages keep the <link>.
const inlineCss = (m, href) => `<style>${fs.readFileSync(path.join(dist, href), "utf8").replace(/<\/style/gi, "<\\/style")}</style>`
// theme-init.js is inlined too (allowed by its sha256 in the server CSP – see server/app.mjs).
const themeInit = fs.readFileSync(path.join(dist, "theme-init.js"), "utf8")
const template = fs.readFileSync(path.join(dist, "index.html"), "utf8").replace(`<script src="/theme-init.js"></script>`, () => `<script>${themeInit}</script>`).replace(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/, inlineCss)
  // The app bundle is started by theme-init.js after "load" (see public/theme-init.js): no early JS requests.
  .replace(/\s*<link rel="modulepreload"[^>]*>/g, "")
  .replace(/<script type="module" crossorigin src="(\/assets\/[^"]+\.js)"><\/script>/, (m, src) => `<script type="application/json" id="app-entry" data-src="${src}"></script>`)
const assets = fs.readdirSync(path.join(dist, "assets"))
const font = (re) => assets.find((f) => re.test(f))
// Only the heading weight is preloaded: more preloads compete with the LCP image on slow connections.
const preloadFonts = [/be-vietnam-pro-latin-700-normal.*\.woff2$/]
  .map(font)
  .filter(Boolean)
  .map((f) => `<link rel="preload" href="/assets/${f}" as="font" type="font/woff2" crossorigin />`)
  .join("\n    ")
const videoMetaFile = path.join(client, "public/media/video-meta.json")
const videoMeta = fs.existsSync(videoMetaFile) ? JSON.parse(fs.readFileSync(videoMetaFile, "utf8")) : null

const PAGES = [
  { page: "landing", path: { vi: "/", en: "/en" }, index: true },
  { page: "privacy", path: { vi: "/privacy", en: "/en/privacy" }, index: true },
  { page: "terms", path: { vi: "/terms", en: "/en/terms" }, index: true },
  { page: "brand", path: { vi: "/brand", en: "/en/brand" }, index: false },
]
const O = "{{ORIGIN}}"
const FAQ_KEYS = ["advice", "sources", "confidence", "data", "model", "access", "files", "language"]

function jsonLd(p, l) {
  const url = `${O}${p.path[l]}`
  const org = {
    "@type": "Organization",
    "@id": `${O}/#org`,
    name: "FTU Tech Lab",
    alternateName: "FTL",
    url: `${O}/`,
    parentOrganization: { "@type": "CollegeOrUniversity", name: "Trường Đại học Ngoại thương – Foreign Trade University", alternateName: "FTU", url: "https://ftu.edu.vn" },
  }
  const graph = [org]
  const crumbs = [{ "@type": "ListItem", position: 1, name: "LegalAI", item: `${O}${l === "en" ? "/en" : "/"}` }]
  if (p.page === "landing") {
    graph.push({
      "@type": "WebSite",
      "@id": `${O}/#website`,
      name: "LegalAI",
      url: `${O}/`,
      inLanguage: ["vi", "en"],
      publisher: { "@id": `${O}/#org` },
    })
    graph.push({
      "@type": "SoftwareApplication",
      name: "LegalAI",
      description: tr(l, "site.meta.landing.description"),
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      inLanguage: ["vi", "en"],
      url,
      image: `${O}/og-image-${l}.png`,
      publisher: { "@id": `${O}/#org` },
      featureList: ["research", "confidence", "contracts", "trade", "bilingual", "deadline", "safety", "followups"].map((k) => tr(l, `landing.features.${k}.title`)),
    })
    graph.push({
      "@type": "FAQPage",
      inLanguage: l,
      mainEntity: FAQ_KEYS.map((k) => ({ "@type": "Question", name: tr(l, `landing.faq.${k}.q`), acceptedAnswer: { "@type": "Answer", text: tr(l, `landing.faq.${k}.a`) } })),
    })
    if (videoMeta)
      graph.push({
        "@type": "VideoObject",
        name: tr(l, "landing.demo.title") + " – LegalAI",
        description: tr(l, "landing.demo.lead"),
        thumbnailUrl: [`${O}/media/legalai-demo-poster.jpg`],
        uploadDate: videoMeta.uploadDate,
        duration: videoMeta.duration,
        contentUrl: `${O}/media/legalai-demo.mp4`,
        inLanguage: l,
        publisher: { "@id": `${O}/#org` },
      })
  } else {
    crumbs.push({ "@type": "ListItem", position: 2, name: strip(tr(l, `site.meta.${p.page}.title`)).split(" – ")[0], item: url })
    graph.push({ "@type": "BreadcrumbList", itemListElement: crumbs })
  }
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c")
}

function head(p, l) {
  const title = tr(l, `site.meta.${p.page}.title`)
  const desc = tr(l, `site.meta.${p.page}.description`)
  const url = `${O}${p.path[l]}`
  const og = `${O}/og-image-${l}.png`
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<meta name="robots" content="${p.index ? "{{ROBOTS}}" : "noindex, follow"}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<link rel="alternate" hreflang="vi" href="${O}${p.path.vi}" />`,
    `<link rel="alternate" hreflang="en" href="${O}${p.path.en}" />`,
    `<link rel="alternate" hreflang="x-default" href="${O}${p.path.vi}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="LegalAI" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:locale" content="${l === "en" ? "en_US" : "vi_VN"}" />`,
    `<meta property="og:locale:alternate" content="${l === "en" ? "vi_VN" : "en_US"}" />`,
    `<meta property="og:image" content="${og}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(tr(l, "site.tagline"))} – LegalAI" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(desc)}" />`,
    `<meta name="twitter:image" content="${og}" />`,
    preloadFonts,
    p.page === "landing" ? `<link rel="preload" as="image" href="/media/hero-answer-light.webp" type="image/webp" fetchpriority="high" media="(prefers-color-scheme: light) and (min-width: 641px)" />` : "",
    p.page === "landing" ? `<link rel="preload" as="image" href="/media/shot-mobile-answer-light-660.webp" type="image/webp" fetchpriority="high" media="(prefers-color-scheme: light) and (max-width: 640px)" />` : "",
    `<script type="application/ld+json">${jsonLd(p, l)}</script>`,
  ]
    .filter(Boolean)
    .join("\n    ")
}

// ---- 3. render -----------------------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const manifest = {}
for (const p of PAGES)
  for (const l of ["vi", "en"]) {
    const body = render(p.path[l])
    const html = template
      .replace('<html lang="vi">', `<html lang="${l}" data-site>`)
      .replace(/<!--head:start-->[\s\S]*?<!--head:end-->/, head(p, l))
      .replace('<div id="root"><!--ssr--></div>', `<div id="root" data-ssr>${body}</div>`)
    const name = `${p.page}-${l}.html`
    fs.writeFileSync(path.join(outDir, name), html)
    manifest[p.path[l]] = { file: name, index: p.index, page: p.page, locale: l }
  }
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`prerendered ${Object.keys(manifest).length} pages → ${path.relative(web, outDir)}`)
