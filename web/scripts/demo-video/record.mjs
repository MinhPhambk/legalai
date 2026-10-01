// Demo video recorder: drives the harness (:3103, replaying REAL recorded conversations) in a separate
// headless Chrome and records CDP screencast frames (1280×720 CSS px @1.5 → 1920×1080) with timestamps.
// Output: video/frames/*.jpg + video/frames.json + video/marks.json (segment start times for captions).
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
const require = createRequire("C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/package.json")
const puppeteer = require("puppeteer-core")
const BASE = "http://127.0.0.1:3103"
const H = process.env.HARNESS_DIR || "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox/demo-harness" // harness data (never production data)
const OUT = path.join(H, "video")
const FR = path.join(OUT, "frames")
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(FR, { recursive: true })
const IDS = JSON.parse(fs.readFileSync(path.join(H, "seeded.json"), "utf8"))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const b = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  userDataDir: fs.mkdtempSync(process.env.TEMP + "/v6rec-"),
  args: ["--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb", "--lang=vi-VN"],
})
const p = await b.newPage()
await p.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5 })
await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
const cdp = await p.createCDPSession()
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(OUT, "downloads") }).catch(() => {})

// Visible cursor + click ripple (headless screencasts have no pointer), a hidden model chip, and the saved UI language.
await p.evaluateOnNewDocument(() => {
  try {
    if (!sessionStorage.getItem("rec-init")) {
      localStorage.setItem("nd45-locale", "vi")
      sessionStorage.setItem("rec-init", "1")
    }
  } catch {}
  const add = () => {
    if (document.getElementById("rec-cursor")) return
    const st = document.createElement("style")
    st.textContent = `#rec-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);transition:transform .05s linear;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))}
      .rec-ripple{position:fixed;z-index:2147483646;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(194,11,17,.75);pointer-events:none;animation:recr .5s ease-out forwards}
      @keyframes recr{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
      .model-chip{visibility:hidden!important}`
    document.documentElement.appendChild(st)
    const c = document.createElement("div")
    c.id = "rec-cursor"
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5v17.2l4.6-4.3 2.9 6.6 3-1.3-2.9-6.5h6.2L4 2.5Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    document.documentElement.appendChild(c)
    const pos = window.__recPos || { x: 640, y: 360 }
    c.style.left = pos.x + "px"
    c.style.top = pos.y + "px"
    document.addEventListener("mousemove", (e) => {
      c.style.left = e.clientX + "px"
      c.style.top = e.clientY + "px"
      window.__recPos = { x: e.clientX, y: e.clientY }
    }, true)
    document.addEventListener("mousedown", (e) => {
      const r = document.createElement("div")
      r.className = "rec-ripple"
      r.style.left = e.clientX + "px"
      r.style.top = e.clientY + "px"
      document.documentElement.appendChild(r)
      setTimeout(() => r.remove(), 600)
    }, true)
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add)
  else add()
})

// ---- screencast ----------------------------------------------------------------------------------------
const frames = []
let t0 = null
cdp.on("Page.screencastFrame", async (f) => {
  const ts = f.metadata.timestamp * 1000
  t0 ??= ts
  const n = frames.length
  const file = `f${String(n).padStart(6, "0")}.jpg`
  fs.writeFileSync(path.join(FR, file), Buffer.from(f.data, "base64"))
  frames.push({ file, t: ts - t0 })
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
})
const marks = []
const now = () => (t0 == null ? 0 : Date.now() - t0)
let wall0 = 0
const mark = (id) => {
  marks.push({ id, t: now() })
  console.log(`[${(now() / 1000).toFixed(1)}s] ${id}`)
}

// ---- helpers -------------------------------------------------------------------------------------------
let mouse = { x: 640, y: 360 }
async function moveTo(x, y, ms = 600) {
  const steps = Math.max(8, Math.round(ms / 16))
  const from = { ...mouse }
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    await p.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e)
    await sleep(ms / steps)
  }
  mouse = { x, y }
}
async function center(sel, { last = false, timeout = 15000 } = {}) {
  await p.waitForSelector(sel, { visible: true, timeout })
  const els = await p.$$(sel)
  const el = last ? els.at(-1) : els[0]
  await el.evaluate((e) => e.scrollIntoView({ block: "nearest", inline: "nearest" }))
  const bb = await el.boundingBox()
  return { el, x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }
}
async function click(sel, opts = {}) {
  const c = await center(sel, opts)
  await moveTo(c.x, c.y, opts.ms ?? 650)
  await sleep(120)
  await p.mouse.down()
  await sleep(70)
  await p.mouse.up()
  await sleep(opts.after ?? 350)
  return c
}
async function hover(sel, opts = {}) {
  const c = await center(sel, opts)
  await moveTo(c.x, c.y, opts.ms ?? 650)
  await sleep(opts.after ?? 300)
}
async function type(text, delay = 28) {
  for (const ch of text) {
    await p.keyboard.type(ch)
    await sleep(delay * (0.6 + Math.random() * 0.8))
  }
}
async function smoothScroll(dy, ms = 1400, sel = null) {
  await p.evaluate(
    async (dy, ms, sel) => {
      const el = sel ? document.querySelector(sel) : document.scrollingElement
      const start = el.scrollTop
      const t0 = performance.now()
      await new Promise((res) => {
        const step = (t) => {
          const k = Math.min(1, (t - t0) / ms)
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
          el.scrollTop = start + dy * e
          k < 1 ? requestAnimationFrame(step) : res()
        }
        requestAnimationFrame(step)
      })
    },
    dy,
    ms,
    sel,
  )
}
const waitIdle = (timeout = 60000) => p.waitForFunction(() => !document.querySelector(".send-btn.stop"), { timeout, polling: 200 })
const chatScroller = ".chat-scroll"

// ---- script ---------------------------------------------------------------------------------------------
await p.goto(BASE + "/", { waitUntil: "networkidle2" })
await p.mouse.move(mouse.x, mouse.y)
await sleep(600)
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
wall0 = Date.now()
await sleep(300)

// S1 landing
mark("landing")
await moveTo(700, 420, 900)
await sleep(1600)
await smoothScroll(620, 2200)
await sleep(1500)
await smoothScroll(900, 2000)
await sleep(1400)
await smoothScroll(-1520, 1200)
await sleep(500)

// S2 login
mark("login")
await click(".site-header .site-btn.ghost", { after: 900 })
await p.waitForSelector(".auth-card input[type=email]")
await click(".auth-card input[type=email]", { after: 150 })
await type("demo@legalai.local", 24)
await click(".auth-card input[type=password]", { after: 150 })
await type("Demo-Pass-2026!", 22)
await sleep(250)
await click(".auth-card button[type=submit]", { after: 1200 })
await p.waitForSelector(".composer textarea")
await sleep(800)

// S3 ask a question (live steps, citations, confidence, follow-ups)
mark("ask")
await click(".composer textarea", { after: 200 })
await type("Khi nào bên mua được huỷ bỏ hợp đồng mua bán hàng hóa?", 30)
await sleep(400)
await click(".send-btn", { after: 900 })
mark("steps")
await p.waitForSelector(".steps.running .steps-head", { timeout: 15000 })
await click(".steps.running .steps-head", { after: 200 })
await waitIdle(90000)
await sleep(900)
mark("answer")
await p.waitForSelector(".report-card", { timeout: 20000 })
if (!(await p.$(".report-card.is-open"))) await click(".report-card", { after: 1300 })
else await hover(".report-card", { after: 900 })
await p.waitForSelector(".report-panel .md a.cite")
// Hover a citation inside the report panel.
const cites = await p.$$(".report-panel .md a.cite")
await cites[0].evaluate((e) => e.scrollIntoView({ block: "center", behavior: "smooth" }))
await sleep(1100)
const cb = await cites[0].boundingBox()
await moveTo(cb.x + cb.width / 2, cb.y + cb.height / 2, 800)
await sleep(2600)
await moveTo(cb.x - 200, cb.y + 260, 500)
await sleep(300)
await click(".report-panel .report-tools .icon-btn:last-child", { after: 700 }).catch(() => {})
await p.evaluate((s) => { const el = document.querySelector(s); el && el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }) }, chatScroller)
await sleep(1200)
await hover(".conf-badge", { last: true, after: 1500 })
await p.waitForSelector(".followups:not(.is-pending) .followup", { timeout: 20000 }).catch(() => {})
await hover(".followup", { after: 1600 })

// S4 draft a contract
mark("draft")
await click(".new-chat", { after: 700 })
await click(".composer textarea", { after: 150 })
await type("Tôi là công ty bán thép ở Hà Nội. Soạn giúp tôi hợp đồng mua bán thép cuộn nội địa ngắn gọn (khoảng 10 điều), bảo vệ bên bán, có điều khoản phạt vi phạm và bồi thường đúng Luật Thương mại, xuất file Word và PDF.", 9)
await sleep(300)
await click(".send-btn", { after: 800 })
await waitIdle(120000)
await sleep(800)
mark("doccard")
await p.waitForSelector(".doc-card .btn.primary", { timeout: 20000 })
await (await p.$(".doc-card")).evaluate((e) => e.scrollIntoView({ block: "center", behavior: "smooth" }))
await sleep(900)
await hover(".doc-card", { after: 700 })
await click(".doc-card .btn.primary", { after: 1800 })
await p.waitForSelector(".doc-panel", { timeout: 15000 })
await sleep(600)
await smoothScroll(700, 2200, ".doc-panel .doc-canvas")
await sleep(1400)

// S5 versions / diff / redline (recorded upload-edit conversation)
mark("versions")
await click(`.chat-item a.chat-link[href="/c/${IDS.edit}"]`, { after: 1500 }).catch(async () => {
  await p.goto(BASE + "/c/" + IDS.edit, { waitUntil: "networkidle2" })
})
await p.waitForSelector(".doc-card .doc-vnav", { timeout: 15000 })
const vcard = (await p.$$(".doc-card:has(.doc-vnav)")).at(-1)
await vcard.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "smooth" }))
await sleep(1200)
await hover(".doc-card:has(.doc-vnav) .doc-vnav button:not(.on)", { last: true, after: 900 }).catch(() => {})
mark("diff")
await click(".doc-card:has(.doc-vnav) .doc-diff-btn", { last: true, after: 1600 })
await p.waitForSelector(".doc-panel .diff-page .diff-text", { timeout: 15000 })
await p.evaluate(() => { const d = [...document.querySelectorAll(".doc-panel .diff-text ins")].find((e) => e.textContent.trim().length > 3); d?.scrollIntoView({ block: "center", behavior: "smooth" }) })
await sleep(2200)
await click(".doc-panel .doc-only .switch", { after: 2200 }).catch(() => {})
await hover(".doc-panel .doc-subbar-dl a[href$='/download/redline']", { after: 500 }).catch(() => {})
await click(".doc-panel .doc-subbar-dl a[href$='/download/redline']", { after: 1500 }).catch(() => {})

// S6 English UI + bilingual contract
mark("english")
await click(".user-btn", { after: 500 })
await click(".user-pop .menu-item", { after: 900 })
await click(".set-pane .segmented button:nth-child(2)", { after: 1300 })
await p.keyboard.press("Escape")
await sleep(600)
await click(`.chat-item a.chat-link[href="/c/${IDS.coffee}"]`, { after: 1400 }).catch(async () => {
  await p.goto(BASE + "/c/" + IDS.coffee, { waitUntil: "networkidle2" })
})
await p.waitForSelector(".doc-card .btn.primary", { timeout: 15000 })
await (await p.$(".doc-card")).evaluate((e) => e.scrollIntoView({ block: "center", behavior: "smooth" }))
await sleep(1000)
await click(".doc-card .btn.primary", { after: 2200 })
await smoothScroll(520, 2000, ".doc-panel .doc-canvas")
await sleep(1600)

// S7 expert escalation (English question)
mark("escalate")
await click(`.chat-item a.chat-link[href="/c/${IDS.precedent}"]`, { after: 1400 }).catch(async () => {
  await p.goto(BASE + "/c/" + IDS.precedent, { waitUntil: "networkidle2" })
})
await p.evaluate((s) => { const el = document.querySelector(s); el && el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }) }, chatScroller)
await sleep(1200)
await click("[data-act='escalate']", { last: true, after: 900 })
await p.waitForSelector(".esc-dialog textarea")
await click(".esc-dialog textarea", { after: 150 })
await type("Please review the late-payment interest calculation for our contract.", 16)
await sleep(300)
await click(".esc-dialog .btn.primary", { after: 1600 })
await p.evaluate((s) => { const el = document.querySelector(s); el && el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }) }, chatScroller)
await sleep(2400)

// S8 end card: the landing's closing section (English)
mark("end")
await p.evaluate(() => fetch("/api/auth/logout", { method: "POST" }))
await p.goto(BASE + "/en", { waitUntil: "networkidle2" })
await p.evaluate(() => document.querySelector(".cta-card")?.scrollIntoView({ block: "center" }))
await sleep(3200)
mark("stop")
await cdp.send("Page.stopScreencast")
await sleep(300)
fs.writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(frames))
fs.writeFileSync(path.join(OUT, "marks.json"), JSON.stringify(marks, null, 1))
console.log(frames.length, "frames,", (frames.at(-1).t / 1000).toFixed(1), "s")
await b.close()
