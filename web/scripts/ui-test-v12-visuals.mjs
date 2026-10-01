// Visuals in answers (v12): a harness whose AI server runs the REAL visual tools for prompts containing "VISUAL"
// (diagram_create → [[diagram:…]], image_fetch → ![…](visual:…), source_snapshot, a ```mermaid timeline + xychart and an
// external image that must NOT be embedded).
//   APP_URL=http://127.0.0.1:3115 node scripts/ui-test-v12-visuals.mjs <email> <pw>
// Checks: diagram in a sandboxed iframe (sandbox="", server CSP, sized by aspect ratio), PNG / SVG downloads, full-screen
// dialog; image from our own endpoint (lazy, caption + credit, lightbox open / Esc); mermaid rendered as an <img> (no
// external request at all); external image turned into a link; share page shows the same visuals and rejects others;
// light / dark; no horizontal overflow 320–1920 px. Screenshots → screenshots/v12-visual-*.png.
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const APP = (process.env.APP_URL || "http://127.0.0.1:3115").replace(/\/$/, "")
const [email, pw] = process.argv.slice(2)
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const check = (ok, msg) => (console.log(ok ? "  ✓" : "  ✗", msg), ok || fails++)
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-first-run"] })
const appHost = new URL(APP).host

async function page(locale, theme, [w, h, mobile]) {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  const external = []
  p.on("request", (r) => {
    const u = r.url()
    if (/^https?:/.test(u) && new URL(u).host !== appHost) external.push(u)
  })
  const cspErrors = []
  p.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && cspErrors.push(m.text()))
  await p.evaluateOnNewDocument((l, th) => {
    try {
      localStorage.setItem("nd45-locale", l)
      sessionStorage.setItem("nd45-locale-explicit", l)
      localStorage.setItem("nd45-theme", th)
    } catch {}
  }, locale, theme)
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }])
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile })
  return { ctx, p, external, cspErrors }
}
async function login(p) {
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]")
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
}
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

// ---- 1. live run (vi, light, desktop) -------------------------------------------------------------------------
console.log("run: vi light 1440")
let { ctx, p, external, cspErrors } = await page("vi", "light", [1440, 900])
await login(p)
await p.type(".composer textarea", "VISUAL Vẽ sơ đồ quy trình điều tra chống bán phá giá của Hoa Kỳ")
await p.keyboard.press("Enter")
await p.waitForFunction(() => !document.querySelector(".msg-assistant[aria-busy]") && document.querySelector(".msg-assistant .md"), { timeout: 120000 })
await p.waitForSelector(".vis-diagram iframe", { timeout: 20000 })
await p.waitForSelector(".vis-chart img", { timeout: 20000 }).catch(() => {})
await sleep(1500)
const chatUrl = p.url()
const info = await p.evaluate(() => {
  const f = document.querySelector(".vis-diagram iframe")
  const wrap = document.querySelector(".vis-frame-wrap")
  const img = document.querySelector(".vis-image img")
  const md = [...document.querySelectorAll(".msg-assistant .md")].map((e) => e.innerHTML).join("\n")
  return {
    sandbox: f?.getAttribute("sandbox"), frameSrc: f?.getAttribute("src"), ratio: wrap?.style.aspectRatio, frameH: f?.getBoundingClientRect().height,
    imgSrc: img?.getAttribute("src"), imgLazy: img?.getAttribute("loading"), imgW: img?.naturalWidth,
    caption: document.querySelector(".vis-image .vis-caption")?.textContent, credit: document.querySelector(".vis-image .vis-credit")?.textContent,
    snapshot: document.querySelectorAll(".vis-image").length,
    charts: [...document.querySelectorAll(".vis-chart img")].map((i) => ({ src: i.getAttribute("src").slice(0, 26), w: i.naturalWidth })),
    mermaidPre: [...document.querySelectorAll('[data-vis="mermaid"]')].map((e) => getComputedStyle(e.querySelector("pre")).display),
    externalImg: [...document.querySelectorAll(".msg-assistant img")].filter((i) => /^https?:/.test(i.getAttribute("src") || "") && !i.getAttribute("src").startsWith(location.origin)).length,
    extLink: !!document.querySelector('.msg-assistant a[href*="Example.jpg"]'),
    creditDup: /\*Ảnh:|<em>Ảnh:/.test(md), // i18n-ignore
    rawMarker: /\[\[diagram:/.test(document.querySelector(".msg-assistant")?.innerText || ""),
    downloads: [...document.querySelectorAll(".vis-actions a[download]")].map((a) => a.getAttribute("href")),
  }
})
console.log("   ", JSON.stringify(info).slice(0, 600))
check(info.sandbox === "", 'diagram iframe has sandbox=""')
check(/\/api\/visuals\/[^/]+\/v\d{14}-[0-9a-f]{6}\/frame\?theme=light/.test(info.frameSrc || ""), "diagram frame comes from our own endpoint (light theme)")
check(/\d+ \/ \d+/.test(info.ratio || "") && info.frameH > 200, `diagram sized by aspect ratio (${info.ratio}, ${Math.round(info.frameH)} px)`)
check(/\/api\/visuals\/.+\/image$/.test(info.imgSrc || "") && info.imgLazy === "lazy" && info.imgW > 50, "image from own endpoint, lazy, loaded")
check(!!info.caption && /Ảnh:/.test(info.credit || "") && /commons\.wikimedia\.org/.test(info.credit || ""), `caption + credit under the image ("${(info.credit || "").slice(0, 60)}")`) // i18n-ignore
check(info.snapshot >= 2, "source snapshot rendered as a figure too")
check(info.charts.length === 2 && info.charts.every((c) => c.src.startsWith("data:image/svg+xml") && c.w > 100), "two mermaid charts rendered as images")
check(info.mermaidPre.every((d) => d === "none"), "mermaid source hidden once rendered")
check(info.externalImg === 0 && info.extLink, "external image not embedded – shown as a link")
check(!info.creditDup, "credit line not duplicated in the text")
check(!info.rawMarker, "no raw [[diagram:…]] marker visible")
check(info.downloads.some((h) => /download\/png/.test(h)) && info.downloads.some((h) => /download\/svg/.test(h)), "PNG / SVG download links")
// frame response headers + downloads
const hdr = await p.evaluate(async (src, dl) => {
  const r = await fetch(src)
  const png = await fetch(dl.find((h) => /png/.test(h)))
  const svg = await fetch(dl.find((h) => /svg/.test(h)))
  const svgText = await svg.text()
  return { csp: r.headers.get("content-security-policy"), xfo: r.headers.get("x-frame-options"), body: (await r.text()).slice(0, 200), png: [png.status, png.headers.get("content-type"), png.headers.get("content-disposition")], svg: [svg.status, svg.headers.get("content-type"), /<script/i.test(svgText), svgText.length] }
}, info.frameSrc, info.downloads)
check(/default-src 'none'/.test(hdr.csp) && /sandbox/.test(hdr.csp) && /frame-ancestors 'self'/.test(hdr.csp) && !/script-src/.test(hdr.csp), "frame CSP: default-src 'none', sandbox, no scripts")
check(hdr.xfo === "SAMEORIGIN", "frame X-Frame-Options SAMEORIGIN")
check(hdr.png[0] === 200 && hdr.png[1] === "image/png" && /attachment/.test(hdr.png[2] || ""), "PNG download")
check(hdr.svg[0] === 200 && /image\/svg\+xml/.test(hdr.svg[1]) && !hdr.svg[2] && hdr.svg[3] > 5000, "SVG download (no script)")
check(external.length === 0, `no request outside our origin (${external.slice(0, 3).join(", ")})`)
check(cspErrors.length === 0, `no CSP violations (${cspErrors.slice(0, 2).join(" | ")})`)
await p.evaluate(() => document.querySelector(".vis-diagram")?.scrollIntoView({ block: "start" }))
await sleep(600)
await p.screenshot({ path: path.join(shots, "v12-visual-diagram-light.png") })
// full screen dialog
await p.click(".vis-diagram .vis-actions button")
await p.waitForSelector(".vis-lightbox .vis-full-frame iframe", { timeout: 5000 })
await sleep(700)
check(await p.$eval(".vis-lightbox", (e) => e.getAttribute("role") === "dialog" && document.activeElement?.classList.contains("vis-lightbox-close")), "full-screen dialog opens with focus on close")
await p.screenshot({ path: path.join(shots, "v12-visual-fullscreen.png") })
await p.keyboard.press("Escape")
await sleep(300)
check(!(await p.$(".vis-lightbox")), "Esc closes the dialog")
// image lightbox
await p.evaluate(() => document.querySelector(".vis-image")?.scrollIntoView({ block: "center" }))
await sleep(500)
await p.screenshot({ path: path.join(shots, "v12-visual-image-light.png") })
await p.click(".vis-image .vis-zoom")
await p.waitForSelector(".vis-lightbox .vis-lightbox-img", { timeout: 5000 })
await sleep(500)
await p.screenshot({ path: path.join(shots, "v12-visual-lightbox.png") })
await p.click(".vis-lightbox-close")
await sleep(300)
check(!(await p.$(".vis-lightbox")), "lightbox closes with the close button")
await p.evaluate(() => document.querySelector(".vis-chart")?.scrollIntoView({ block: "start" }))
await sleep(400)
await p.screenshot({ path: path.join(shots, "v12-visual-mermaid-light.png") })

// share link
const chatId = chatUrl.match(/\/c\/([\w-]+)/)?.[1]
const share = await p.evaluate(async (id) => {
  const r = await fetch(`/api/chats/${id}/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  return r.json()
}, chatId)
const token = share?.share?.token || share?.share?.url?.match(/\/s\/([\w-]+)/)?.[1]
await ctx.close()

// ---- 2. dark mode + share page + responsive -------------------------------------------------------------------
;({ ctx, p, external, cspErrors } = await page("en", "dark", [1440, 900]))
await login(p)
await p.goto(chatUrl, { waitUntil: "domcontentloaded" })
await p.waitForSelector(".vis-diagram iframe", { timeout: 20000 })
await p.waitForSelector(".vis-chart img", { timeout: 20000 }).catch(() => {})
await sleep(1500)
check(/theme=dark/.test(await p.$eval(".vis-diagram iframe", (f) => f.getAttribute("src"))), "dark theme → dark diagram frame")
await p.evaluate(() => document.querySelector(".vis-diagram")?.scrollIntoView({ block: "start" }))
await sleep(600)
await p.screenshot({ path: path.join(shots, "v12-visual-diagram-dark.png") })
await p.evaluate(() => document.querySelector(".vis-chart")?.scrollIntoView({ block: "start" }))
await sleep(400)
await p.screenshot({ path: path.join(shots, "v12-visual-mermaid-dark.png") })
check(external.length === 0 && cspErrors.length === 0, "dark: no external requests / CSP errors")
const sizes = [[320, 700, true], [360, 740, true], [390, 844, true], [768, 1024, true], [1024, 768], [1280, 800], [1920, 1080]]
for (const [w, h, m] of sizes) {
  await p.setViewport({ width: w, height: h, isMobile: !!m, hasTouch: !!m })
  await sleep(700)
  const o = await overflow(p)
  const fits = await p.evaluate(() => [...document.querySelectorAll(".vis-figure")].every((f) => f.getBoundingClientRect().right <= window.innerWidth + 1))
  check(o <= 1 && fits, `${w}×${h}: no horizontal overflow (${o}px), figures fit`)
  if (w === 390) {
    await p.evaluate(() => document.querySelector(".vis-diagram")?.scrollIntoView({ block: "start" }))
    await sleep(500)
    await p.screenshot({ path: path.join(shots, "v12-visual-mobile-dark.png") })
  }
}
await ctx.close()

if (token) {
  ;({ ctx, p, external } = await page("vi", "light", [390, 844, true]))
  await p.goto(`${APP}/s/${token}`, { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".vis-diagram iframe", { timeout: 20000 })
  await sleep(1500)
  const s = await p.evaluate(() => ({ frame: document.querySelector(".vis-diagram iframe")?.getAttribute("src"), img: document.querySelector(".vis-image img")?.naturalWidth }))
  check(/\/api\/public\/shares\/[\w-]+\/visuals\/v\d{14}-[0-9a-f]{6}\/frame/.test(s.frame || "") && s.img > 50, "share page shows the diagram + image via share-scoped URLs")
  const denied = await p.evaluate(async (tk) => (await fetch(`/api/public/shares/${tk}/visuals/v20000101000000-abcdef/meta`)).status, token)
  check(denied === 404, "share: a visual outside the snapshot → 404")
  const anon = await p.evaluate(async (u) => (await fetch(u.replace(/\/api\/public\/shares\/[\w-]+\/visuals/, "/api/visuals/" + "x")).catch(() => ({ status: 0 }))).status, s.frame || "")
  check(anon === 401 || anon === 404, `owner endpoint without login → ${anon}`)
  await p.evaluate(() => document.querySelector(".vis-diagram")?.scrollIntoView({ block: "start" }))
  await sleep(400)
  await p.screenshot({ path: path.join(shots, "v12-visual-share-mobile.png") })
  check(external.length === 0, "share: no external requests")
  await ctx.close()
} else check(false, "share link created")

await browser.close()
console.log(fails ? `\n${fails} check(s) failed` : "\nall visual checks passed")
process.exit(fails ? 1 : 0)
