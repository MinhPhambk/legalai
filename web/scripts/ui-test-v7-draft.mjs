// Drafting progress card (draft_* tools) against a harness whose AI server is the scripted fake (never production):
//   APP_URL=http://127.0.0.1:3108 node scripts/ui-test-v7-draft.mjs <email> <password>
// Checks: card appears, live progress while draft_write runs (progress.json → part updates), stepper states, done
// state with the document link (scrolls to / flashes the doc card), persistence after reload, failed state.
// Screenshots → screenshots/v7-draft-*.png (vi + en, light + dark, desktop + mobile).
import path from "node:path"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const APP = (process.env.APP_URL || "http://127.0.0.1:3108").replace(/\/$/, "")
const [email, pw] = process.argv.slice(2)
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, args: ["--no-first-run"] })
let fails = 0
const check = (ok, msg) => {
  console.log(ok ? "  ✓" : "  ✗", msg)
  if (!ok) fails++
}

async function open(locale, theme, [w, h, mobile]) {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  await p.evaluateOnNewDocument(
    (l, th) => {
      try {
        localStorage.setItem("nd45-locale", l)
        sessionStorage.setItem("nd45-locale-explicit", l)
        localStorage.setItem("nd45-theme", th)
      } catch {}
    },
    locale,
    theme,
  )
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }])
  await p.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: !!mobile, hasTouch: !!mobile })
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]")
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
  return { p, ctx }
}
const send = async (p, text) => {
  await p.type(".composer textarea", text)
  await p.keyboard.press("Enter")
}
const stats = (p) => p.$eval(".draft-card .draft-stats", (e) => e.textContent).catch(() => "")
const shot = (p, name) => p.screenshot({ path: path.join(shots, `v7-draft-${name}.png`) }).then(() => console.log("   ", name))
const scrollCard = (p) => p.evaluate(() => document.querySelector(".draft-card")?.scrollIntoView({ block: "center" }))

const MODES = [
  ["vi", "light", [1440, 900], "desktop"],
  ["en", "dark", [1440, 900], "desktop"],
  ["vi", "dark", [390, 844, true], "mobile"],
  ["en", "light", [390, 844, true], "mobile"],
]
for (const [locale, theme, vp, dev] of MODES) {
  const tag = `${locale}-${theme}-${dev}`
  console.log(tag)
  const { p, ctx } = await open(locale, theme, vp)
  await send(p, locale === "vi" ? "Soạn hợp đồng đại lý phân phối độc quyền thật chi tiết" : "Draft a detailed exclusive distribution agency contract")
  await p.waitForSelector(".draft-card", { timeout: 20000 })
  // live progress during draft_write (no part updates from the AI server – only progress.json)
  await p.waitForFunction(() => /[1-9]\d*\//.test(document.querySelector(".draft-card .draft-stats")?.textContent || ""), { timeout: 20000 })
  const a = await stats(p)
  await sleep(2200)
  const b = await stats(p)
  const n = (s) => Number((s.match(/(\d+)\//) || [])[1] || 0)
  check(n(b) > n(a), `live progress while writing (${n(a)} → ${n(b)})`)
  check(!!(await p.$(".draft-step.current")), "stepper shows a current step")
  await p.click(".draft-toggle")
  await scrollCard(p)
  await sleep(300)
  await shot(p, `writing-${tag}`)
  await p.waitForSelector(".draft-card.done", { timeout: 60000 })
  await sleep(600)
  check((await p.$$eval(".draft-step.done", (l) => l.length)) === 5, "all 5 steps done")
  check(!!(await p.$(".doc-card[data-doc-id]")), "document card present")
  check((await p.$$(".draft-card")).length === 1, "one card per draft")
  await scrollCard(p)
  await sleep(200)
  await shot(p, `done-${tag}`)
  await p.click(".draft-doc .btn")
  await sleep(250)
  check(!!(await p.$(".doc-card.flash")), "“go to document” flashes the doc card")
  if (dev === "desktop") {
    await p.reload({ waitUntil: "domcontentloaded" })
    await p.waitForSelector(".draft-card.done", { timeout: 20000 })
    check(true, "card restored from history after reload")
    // failed run
    await p.click(".new-chat-btn, .sidebar .btn-new, [data-new-chat]").catch(async () => p.goto(APP + "/", { waitUntil: "domcontentloaded" }))
    await p.goto(APP + "/", { waitUntil: "domcontentloaded" })
    await p.waitForSelector(".composer textarea")
    await send(p, "Soạn hợp đồng LỖI")
    await p.waitForSelector(".draft-card.failed", { timeout: 40000 })
    await sleep(500)
    check(!!(await p.$(".draft-step.failed")) && !!(await p.$(".draft-error")), "failed state: failed step + error text")
    await scrollCard(p)
    await shot(p, `failed-${tag}`)
  }
  await ctx.close()
}
await browser.close()
console.log(fails ? `\n${fails} check(s) failed` : "\nall draft UI checks passed")
process.exit(fails ? 1 : 0)
