// Builds the LegalAI brand assets from code (no design tool): logo mark + wordmark lockups (SVG, all
// colour variants), PNG exports, favicon.svg / favicon.ico (16/32/48), apple-touch-icon, PWA icons
// (192/512 + maskable), site.webmanifest, the Open Graph images (vi / en, 1200×630) and a zip of
// everything for the /brand page. The wordmark is Be Vietnam Pro Bold (SIL OFL) converted to outlines
// with opentype.js, so the SVGs do not depend on installed fonts.
//
// Usage: node scripts/brand-build.mjs            (writes client/public/brand/*, client/public/*.png|ico|webmanifest)
//        BRAND_ONLY=og node scripts/brand-build.mjs   (only the OG images – needs the screenshots)
// Rendering uses puppeteer-core with the system Chrome in a separate, temporary headless profile.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import opentype from "opentype.js"
import JSZip from "jszip"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pub = path.join(web, "client", "public")
const out = path.join(pub, "brand")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe"
const ONLY = process.env.BRAND_ONLY || ""
fs.mkdirSync(out, { recursive: true })

// ---- palette (see client/src/site/tokens.js) --------------------------------------------------------
const RED = "#C20B11"
const INK = "#121212"
const WHITE = "#FFFFFF"

// ---- the mark ---------------------------------------------------------------------------------------
// 32-unit grid. A balance (beam, pillar, base, two pans) whose fulcrum is a four-point spark:
// "the law, weighed with AI assistance". Rounded tile r=8 (25%).
const GLYPH_STROKES = "M6.5 12.5h19M16 12.5V25M11 25h10" // beam, pillar, base (stroke 2.6, round caps)
const GLYPH_FILLS = "M4.8 16.5h8.4a4.2 4.2 0 0 1-8.4 0ZM18.8 16.5h8.4a4.2 4.2 0 0 1-8.4 0ZM16 3.8Q16.9 7.6 20.6 8.4 16.9 9.2 16 13 15.1 9.2 11.4 8.4 15.1 7.6 16 3.8Z"
/** Glyph only (no tile), drawn in `color`. */
const glyph = (color) =>
  `<path d="${GLYPH_STROKES}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="${GLYPH_FILLS}" fill="${color}"/>`
/**
 * Tile + glyph at (x, y) with size s. `knock` = glyph cut out of the tile (single-colour variants)
 * instead of painted in `fg`.
 */
function markAt({ x = 0, y = 0, s = 32, tile, fg, knock = false, id = "m" }) {
  const k = s / 32
  const tr = `translate(${x} ${y}) scale(${k})`
  if (!knock) return `<g transform="${tr}"><rect width="32" height="32" rx="8" fill="${tile}"/>${glyph(fg)}</g>`
  return `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="32" height="32" rx="8" fill="#fff"/>${glyph("#000")}</mask></defs><g transform="${tr}"><rect width="32" height="32" rx="8" fill="${tile}" mask="url(#${id})"/></g>`
}

// Pixel-snapped 16 px mark for favicon.ico / tiny UI (the 32-grid glyph blurs at 16 px).
const MARK16 = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" rx="4" fill="${RED}"/><g fill="#fff"><rect x="7" y="2" width="2" height="4"/><rect x="6" y="3" width="4" height="2"/><rect x="3" y="6" width="10" height="1"/><rect x="7" y="7" width="2" height="5"/><rect x="5" y="12" width="6" height="1"/><rect x="2" y="8" width="5" height="1"/><rect x="3" y="9" width="3" height="1"/><rect x="9" y="8" width="5" height="1"/><rect x="10" y="9" width="3" height="1"/></g></svg>`

// ---- wordmark -----------------------------------------------------------------------------------------
const fontFile = path.join(web, "node_modules", "@fontsource", "be-vietnam-pro", "files", "be-vietnam-pro-latin-700-normal.woff")
const font = opentype.parse(fs.readFileSync(fontFile).buffer.slice(0))
const TRACK = -0.012 // em
/** Outlined "LegalAI": { d, width, capHeight } at font size `size`, baseline at y=0, starting x=0. */
function wordmark(size, text = "LegalAI") {
  const scale = size / font.unitsPerEm
  const glyphs = font.stringToGlyphs(text)
  let x = 0
  const ds = []
  glyphs.forEach((g, i) => {
    ds.push(g.getPath(x, 0, size).toPathData(2))
    x += g.advanceWidth * scale
    if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * scale + TRACK * size
  })
  // Trim the right side bearing of the last glyph so the bbox is tight.
  const bb = font.getPath(text, 0, 0, size).getBoundingBox()
  const cap = (font.tables.os2.sCapHeight || font.charToGlyph("H").getBoundingBox().y2) * scale
  return { d: ds.join(""), width: x, left: bb.x1, right: bb.x2, capHeight: cap }
}

const svg = (w, h, body, title = "LegalAI") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${round(w)}" height="${round(h)}" viewBox="0 0 ${round(w)} ${round(h)}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`
const round = (n) => Math.round(n * 100) / 100

const VARIANTS = {
  // name: [tile, glyph (null = knocked out), wordmark]
  color: [RED, WHITE, INK], // default, on light backgrounds
  "color-on-dark": [RED, WHITE, WHITE],
  black: [INK, null, INK],
  white: [WHITE, null, WHITE],
  red: [RED, null, RED],
}

function horizontal(v) {
  const [tile, fg, word] = VARIANTS[v]
  const H = 40
  const size = 29
  const wm = wordmark(size)
  const gap = 11
  const tx = H + gap - wm.left
  const baseline = H / 2 + wm.capHeight / 2
  const W = tx + wm.right
  return svg(W, H, markAt({ s: H, tile, fg, knock: !fg, id: `m-${v}-h` }) + `<path transform="translate(${round(tx)} ${round(baseline)})" d="${wm.d}" fill="${word}"/>`)
}
function stacked(v) {
  const [tile, fg, word] = VARIANTS[v]
  const M = 64
  const size = 34
  const wm = wordmark(size)
  const ww = wm.right - wm.left
  const W = Math.max(M, ww)
  const gap = 14
  const baseline = M + gap + wm.capHeight
  const H = baseline + size * 0.26 // room for the "g" descender
  return svg(W, H, markAt({ x: (W - M) / 2, s: M, tile, fg, knock: !fg, id: `m-${v}-s` }) + `<path transform="translate(${round((W - ww) / 2 - wm.left)} ${round(baseline)})" d="${wm.d}" fill="${word}"/>`)
}
function markOnly(v) {
  const [tile, fg] = VARIANTS[v]
  return svg(32, 32, markAt({ s: 32, tile, fg, knock: !fg, id: `m-${v}` }), "LegalAI")
}

// ---- rendering helpers ---------------------------------------------------------------------------------
let browser
async function page(w, h, dpr = 1) {
  browser ??= await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "legalai-brand-")),
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions", "--font-render-hinting=none"],
  })
  const p = await browser.newPage()
  await p.setViewport({ width: w, height: h, deviceScaleFactor: dpr })
  return p
}
/** Rasterise an SVG string to PNG (transparent unless `bg`). */
async function png(svgText, w, h, file, { bg = null, pad = 0 } = {}) {
  const p = await page(w, h)
  const html = `<!doctype html><html><body style="margin:0;background:${bg || "transparent"}"><img src="data:image/svg+xml;base64,${Buffer.from(svgText).toString("base64")}" style="display:block;width:${w - 2 * pad}px;height:${h - 2 * pad}px;margin:${pad}px"></body></html>`
  await p.setContent(html, { waitUntil: "load" })
  const buf = await p.screenshot({ type: "png", omitBackground: !bg, clip: { x: 0, y: 0, width: w, height: h } })
  await p.close()
  if (file) fs.writeFileSync(file, buf)
  return buf
}
/** ICO container with PNG-compressed images (supported by every current browser / Windows ≥ Vista). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, e)
    head.writeUInt8(size >= 256 ? 0 : size, e + 1)
    head.writeUInt8(0, e + 2)
    head.writeUInt8(0, e + 3)
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(buf.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += buf.length
  })
  return Buffer.concat([head, ...images.map((x) => x.buf)])
}
const dims = (s) => s.match(/width="([\d.]+)" height="([\d.]+)"/).slice(1).map(Number)

// ---- Open Graph images ---------------------------------------------------------------------------------
const OG = {
  vi: {
    title: "Trợ lý pháp lý AI<br>cho doanh nghiệp Việt",
    sub: "Hỏi đáp pháp luật có trích dẫn nguyên văn · Soạn và rà soát hợp đồng · Phòng vệ thương mại",
    foot: "Sản phẩm của FTU Tech Lab – Trường Đại học Ngoại thương",
    badge: "Thí điểm nghiên cứu",
  },
  en: {
    title: "AI legal assistant<br>for Vietnamese businesses",
    sub: "Answers on Vietnamese law with verbatim citations · Contract drafting & review · Trade remedies",
    foot: "A product of FTU Tech Lab, Foreign Trade University",
    badge: "Research pilot",
  },
}
async function ogImages() {
  const fontCss = (w) => {
    const f = (sub) => path.join(web, "node_modules", "@fontsource", "be-vietnam-pro", "files", `be-vietnam-pro-${sub}-${w}-normal.woff2`)
    return ["vietnamese", "latin", "latin-ext"]
      .map((sub) => `@font-face{font-family:BVP;font-weight:${w};src:url(data:font/woff2;base64,${fs.readFileSync(f(sub)).toString("base64")}) format("woff2")}`)
      .join("")
  }
  const lock = fs.readFileSync(path.join(out, "legalai-horizontal-color.svg"), "utf8")
  const shotPath = path.join(pub, "media", "hero-answer-light.webp")
  const shot = fs.existsSync(shotPath) ? `data:image/webp;base64,${fs.readFileSync(shotPath).toString("base64")}` : ""
  for (const [l, c] of Object.entries(OG)) {
    const p = await page(1200, 630)
    const html = `<!doctype html><html lang="${l}"><head><style>${fontCss(400)}${fontCss(600)}${fontCss(700)}
      *{box-sizing:border-box}body{margin:0;width:1200px;height:630px;font-family:BVP,sans-serif;background:#fff;color:${INK};overflow:hidden;position:relative}
      .l{position:absolute;left:72px;top:64px;width:600px}
      .lock{height:44px;display:block}
      .badge{display:inline-block;margin-top:48px;font-size:18px;font-weight:600;color:${RED};background:#FEF1F1;border:1px solid #F9CFD0;border-radius:999px;padding:6px 14px}
      h1{font-size:54px;line-height:1.12;letter-spacing:-0.02em;margin:22px 0 0;font-weight:700}
      p{font-size:22px;line-height:1.45;color:#4d4d4d;margin:22px 0 0;max-width:560px}
      .foot{position:absolute;left:72px;bottom:56px;font-size:18px;color:#5c5c5c;font-weight:500}
      .bar{position:absolute;left:0;top:0;bottom:0;width:10px;background:${RED}}
      .shot{position:absolute;left:720px;top:88px;width:760px;border-radius:16px;border:1px solid #e6e6e6;box-shadow:0 24px 60px -12px rgba(0,0,0,.25);overflow:hidden;background:#f8f8f8}
      .shot img{display:block;width:100%}
    </style></head><body><div class="bar"></div><div class="l"><img class="lock" src="data:image/svg+xml;base64,${Buffer.from(lock).toString("base64")}"><span class="badge">${c.badge}</span><h1>${c.title}</h1><p>${c.sub}</p></div>
    ${shot ? `<div class="shot"><img src="${shot}"></div>` : ""}<div class="foot">${c.foot}</div></body></html>`
    await p.setContent(html, { waitUntil: "load" })
    await p.evaluate(() => document.fonts.ready)
    fs.writeFileSync(path.join(pub, `og-image-${l}.png`), await p.screenshot({ type: "png" }))
    await p.close()
  }
  console.log("og images written")
}

// ---- main -----------------------------------------------------------------------------------------------
if (ONLY !== "og") {
  const files = {}
  for (const v of Object.keys(VARIANTS)) {
    files[`legalai-horizontal-${v}.svg`] = horizontal(v)
    files[`legalai-stacked-${v}.svg`] = stacked(v)
    files[`legalai-mark-${v === "color-on-dark" ? "color" : v}.svg`] = markOnly(v)
  }
  files["legalai-mark-16.svg"] = MARK16
  for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(out, f), s)

  // PNG exports (2× of a comfortable size) for decks / documents.
  for (const f of Object.keys(files).filter((f) => !f.includes("-16"))) {
    const [w, h] = dims(files[f])
    const k = f.includes("mark") ? 512 / w : f.includes("stacked") ? 640 / w : 960 / w
    await png(files[f], Math.round(w * k), Math.round(h * k), path.join(out, f.replace(/\.svg$/, ".png")))
  }

  // Favicons / app icons.
  fs.writeFileSync(path.join(pub, "favicon.svg"), markOnly("color"))
  const i16 = await png(MARK16, 16, 16)
  const i32 = await png(markOnly("color"), 32, 32)
  const i48 = await png(markOnly("color"), 48, 48)
  fs.writeFileSync(path.join(pub, "favicon.ico"), ico([{ size: 16, buf: i16 }, { size: 32, buf: i32 }, { size: 48, buf: i48 }]))
  // Full-bleed squares (iOS / Android apply their own mask). Glyph at ~62% (touch) / 50% (maskable safe zone).
  const square = (scale) => {
    const g = 32 * scale
    const o = (32 - g) / 2
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${RED}"/><g transform="translate(${o} ${o}) scale(${scale})">${glyph(WHITE)}</g></svg>`
  }
  await png(square(0.8), 180, 180, path.join(pub, "apple-touch-icon.png"))
  await png(markOnly("color"), 192, 192, path.join(pub, "icon-192.png"))
  await png(markOnly("color"), 512, 512, path.join(pub, "icon-512.png"))
  await png(square(0.62), 512, 512, path.join(pub, "icon-maskable-512.png"))
  fs.writeFileSync(
    path.join(pub, "site.webmanifest"),
    JSON.stringify(
      {
        name: "LegalAI – Trợ lý pháp lý AI",
        short_name: "LegalAI",
        description: "Trợ lý pháp lý AI cho doanh nghiệp Việt – AI legal assistant for Vietnamese businesses",
        lang: "vi",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: RED,
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      null,
      2,
    ) + "\n",
  )

  // Official FTU logo: copied unchanged (endorsement only).
  const ftuSrc = process.env.FTU_LOGO || path.join(out, "ftu-logo.png")
  if (fs.existsSync(ftuSrc) && path.resolve(ftuSrc) !== path.resolve(path.join(out, "ftu-logo.png"))) fs.copyFileSync(ftuSrc, path.join(out, "ftu-logo.png"))

  // Zip of the LegalAI assets (the FTU logo is not redistributed in the kit).
  const zip = new JSZip()
  for (const f of fs.readdirSync(out).filter((f) => /^legalai-.*\.(svg|png)$/.test(f))) zip.file(`legalai-brand/${f}`, fs.readFileSync(path.join(out, f)))
  zip.file(
    "legalai-brand/README.txt",
    [
      "LegalAI – brand assets / Bộ nhận diện",
      "",
      "legalai-horizontal-*.svg|png  logo ngang / horizontal lockup",
      "legalai-stacked-*.svg|png     logo xếp dọc / stacked lockup",
      "legalai-mark-*.svg|png        biểu tượng / mark only",
      "Variants: color (light backgrounds), color-on-dark, black, white, red.",
      "Clear space = 1/4 of the mark height on every side. Minimum size: mark 16 px, horizontal lockup 96 px wide.",
      "Brand red #C20B11 (FTU red). Typeface: Be Vietnam Pro (SIL Open Font License).",
      "Do not recolour, stretch, rotate, add effects or combine the LegalAI mark with the FTU emblem.",
      "See /brand for the full guideline.",
      "",
    ].join("\n"),
  )
  fs.writeFileSync(path.join(out, "legalai-brand-kit.zip"), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))
  console.log("brand assets:", fs.readdirSync(out).length, "files in", path.relative(web, out))
}
if (!ONLY || ONLY === "og") await ogImages()
await browser?.close()
