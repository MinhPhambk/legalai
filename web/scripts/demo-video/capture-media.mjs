// Product screenshots for the landing (harness :3103, real recorded chats) → web/client/public/media/*.webp
// Usage: node capture.mjs [only=hero,citations,...]   (both themes)
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
const require = createRequire("C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/package.json")
const puppeteer = require("puppeteer-core")
const H = process.env.HARNESS_DIR || "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox/demo-harness" // harness data (never production data)
const BASE = "http://127.0.0.1:3103"
const OUT = "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/web/client/public/media/"
fs.mkdirSync(OUT, { recursive: true })
const IDS = JSON.parse(fs.readFileSync(path.join(H, "seeded.json"), "utf8"))
const ONLY = (process.argv[2] || "hero,citations,confidence,doccard,diff,trade").split(",")
const THEMES = (process.env.THEMES || "light,dark").split(",")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DPR = 1.25

const b = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, userDataDir: fs.mkdtempSync(process.env.TEMP + "/v6cap-"), args: ["--no-first-run", "--hide-scrollbars"] })
const p = await b.newPage()
await p.setViewport({ width: 1280, height: 800, deviceScaleFactor: DPR })
await p.goto(BASE + "/login", { waitUntil: "networkidle2" })
await p.evaluate(() => localStorage.setItem("nd45-locale", "vi"))
await p.goto(BASE + "/login", { waitUntil: "networkidle2" })
await p.type("input[type=email]", "demo@legalai.local")
await p.type("input[type=password]", "Demo-Pass-2026!")
await Promise.all([p.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}), p.click("button[type=submit]")])
await sleep(800)

const HIDE = `.model-chip{visibility:hidden!important} .composer-hint, .footer-note{opacity:1} *{caret-color:transparent!important}`
async function open(chat, theme, vp = [1280, 800]) {
  await p.setViewport({ width: vp[0], height: vp[1], deviceScaleFactor: DPR })
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }])
  await p.goto(BASE + "/c/" + chat, { waitUntil: "networkidle2" })
  await p.addStyleTag({ content: HIDE })
  await p.waitForSelector(".msg-assistant", { timeout: 15000 })
  await sleep(900)
}
async function save(name, theme, opts = {}) {
  const file = `${OUT}${name}-${theme}.webp`
  await p.screenshot({ path: file, type: "webp", quality: 82, captureBeyondViewport: false, ...opts })
  console.log(name, theme, (fs.statSync(file).size / 1024).toFixed(0) + " KB")
}
const scrollChat = (sel, block = "start", dy = 0) =>
  p.evaluate(
    (s, bl, d) => {
      const el = [...document.querySelectorAll(s)].at(-1)
      el?.scrollIntoView({ block: bl })
      const sc = el?.closest(".messages, .chat-scroll, [data-scroll]") || document.querySelector(".chat-scroll, .messages")
      if (sc && d) sc.scrollTop += d
    },
    sel,
    block,
    dy,
  )
const box = (sel, last = true) => p.evaluate((s, l) => { const els = [...document.querySelectorAll(s)]; const e = l ? els.at(-1) : els[0]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }, sel, last)

for (const theme of THEMES) {
  if (ONLY.includes("hero")) {
    await open(IDS.huybo, theme)
    await p.click(".report-card")
    await p.waitForSelector(".report-panel")
    await sleep(1200)
    await scrollChat(".msg-user", "start", -12)
    await sleep(400)
    await save("hero-answer", theme)
  }
  if (ONLY.includes("citations")) {
    await open(IDS.huybo, theme)
    await p.click(".report-card")
    await p.waitForSelector(".report-panel .md a.cite")
    await sleep(1000)
    const cites = await p.$$(".report-panel .md a.cite")
    const c = cites[Number(process.env.CITE || 0)]
    await c.evaluate((e) => e.scrollIntoView({ block: "center" }))
    await sleep(300)
    const pb = await box(".report-panel")
    await p.mouse.click(pb.x + pb.width - 20, pb.y + pb.height - 20) // pointer type → mouse
    await sleep(200)
    await c.hover()
    await sleep(900)
    const panel = await box(".report-panel")
    const cb = await c.boundingBox()
    const card = await box(".cite-card")
    console.log("cite", JSON.stringify(cb), "card", JSON.stringify(card))
    const top = Math.min(cb.y, card ? card.y : cb.y), bottom = Math.max(cb.y + cb.height, card ? card.y + card.height : 0)
    const w = Math.round(panel.width), h = 560
    const x = panel.x
    const y = Math.max(0, Math.min(800 - h, (top + bottom) / 2 - h / 2))
    await save("crop-citations", theme, { clip: { x, y, width: w, height: h } })
  }
  if (ONLY.includes("confidence")) {
    await open(IDS.huybo, theme)
    await scrollChat(".escalation-card, .esc-card, .conf-badge", "end", 0)
    await sleep(400)
    const conf = await box(".conf-badge")
    const col = await box(".msg-assistant")
    const w = 540, h = 480
    await save("crop-confidence", theme, { clip: { x: col.x - 24, y: Math.max(0, Math.min(800 - h, conf.y - 150)), width: w, height: h } })
  }
  if (ONLY.includes("doccard")) {
    await open(IDS.edit, theme)
    await scrollChat(".doc-card .doc-vnav", "center")
    await sleep(500)
    const card = await box(".doc-card:has(.doc-vnav)")
    const w = 540, h = 480
    await save("crop-doccard", theme, { clip: { x: card.x - 24, y: Math.max(0, Math.min(800 - h, card.y - 60)), width: w, height: h } })
  }
  if (ONLY.includes("diff")) {
    await open(IDS.edit, theme)
    const btn = (await p.$$(".doc-card .doc-diff-btn")).at(-1)
    await btn.evaluate((e) => e.scrollIntoView({ block: "center" }))
    await btn.click()
    await p.waitForSelector(".doc-panel .diff-page .diff-text", { timeout: 15000 })
    await sleep(1200)
    // Jump to the first change inside the diff.
    await p.evaluate(() => { const d = [...document.querySelectorAll(".doc-panel .diff-text ins")].find((e) => e.textContent.trim().length > 3); d?.scrollIntoView({ block: "center" }) })
    await sleep(500)
    const panel = await box(".doc-panel")
    const w = Math.min(896, panel.width), h = 720
    await save("crop-diff", theme, { clip: { x: panel.x + panel.width - w, y: 800 - h, width: w, height: h } })
  }
  if (ONLY.includes("mobile")) {
    // Phone: the answer (confidence + follow-ups) and the generated contract card.
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }])
    await p.goto(BASE + "/c/" + IDS.huybo, { waitUntil: "networkidle2" })
    await p.addStyleTag({ content: HIDE })
    await p.waitForSelector(".conf-badge")
    await sleep(800)
    await p.evaluate(() => document.querySelector(".conf-badge")?.scrollIntoView({ block: "center" }))
    await sleep(500)
    await save("shot-mobile-answer", theme)
    await p.goto(BASE + "/c/" + IDS.steel, { waitUntil: "networkidle2" })
    await p.addStyleTag({ content: HIDE })
    await p.waitForSelector(".doc-card")
    await sleep(800)
    await p.evaluate(() => document.querySelector(".doc-card")?.scrollIntoView({ block: "center" }))
    await sleep(500)
    await save("shot-mobile-contract", theme)
    await p.setViewport({ width: 1280, height: 800, deviceScaleFactor: DPR })
  }
  if (ONLY.includes("trade")) {
    await open(IDS.trade, theme)
    const hasReport = await p.$(".report-card")
    if (hasReport) {
      await p.click(".report-card")
      await sleep(1200)
      const panel = await box(".report-panel")
      await save("crop-trade", theme, { clip: { x: panel.x, y: 60, width: Math.min(896, panel.width), height: 560 } })
    } else {
      await scrollChat(".msg-user", "start")
      await sleep(400)
      const col = await box(".msg-assistant")
      await save("crop-trade", theme, { clip: { x: col.x - 24, y: 40, width: 896, height: 560 } })
    }
  }
}
await b.close()
