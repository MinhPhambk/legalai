// Result cards in the step list (calc_* / fx_* / web_read), against a harness whose AI server is the scripted fake
// (prompt containing "Tính" replays real tool outputs):  APP_URL=http://127.0.0.1:3108 node scripts/ui-test-v7-cards.mjs <email> <pw>
// Screenshots → screenshots/v7-cards-*.png (vi / en, light / dark, desktop / mobile).
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const APP = (process.env.APP_URL || "http://127.0.0.1:3108").replace(/\/$/, "")
const [email, pw] = process.argv.slice(2)
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const check = (ok, msg) => (console.log(ok ? "  ✓" : "  ✗", msg), ok || fails++)
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-first-run"] })

for (const [locale, theme, [w, h, mobile], dev] of [
  ["vi", "light", [1440, 900], "desktop"],
  ["en", "dark", [1440, 900], "desktop"],
  ["vi", "dark", [390, 844, true], "mobile"],
  ["en", "light", [390, 844, true], "mobile"],
]) {
  const tag = `${locale}-${theme}-${dev}`
  console.log(tag)
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  await p.evaluateOnNewDocument((l, th) => {
    try {
      localStorage.setItem("nd45-locale", l)
      sessionStorage.setItem("nd45-locale-explicit", l)
      localStorage.setItem("nd45-theme", th)
    } catch {}
  }, locale, theme)
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }])
  await p.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: !!mobile, hasTouch: !!mobile })
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]")
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
  await p.type(".composer textarea", locale === "vi" ? "Tính tổng giá trị hợp đồng và tiền phạt" : "Tính the contract total and the penalty")
  await p.keyboard.press("Enter")
  await p.waitForSelector(".rcard", { timeout: 20000 })
  check(true, "a card appears while the run is live")
  await p.waitForFunction(() => !document.querySelector(".msg-assistant[aria-busy]"), { timeout: 30000 })
  await sleep(800)
  if (!(await p.$(".steps .collapse.open"))) await p.click(".steps-head")
  await sleep(400)
  const n = await p.$$eval(".rcard", (l) => l.length)
  check(n >= 7, `cards rendered (${n})`)
  check(await p.$eval(".rc-calc .rc-result", (e) => /165\.000\.000|165,000,000/.test(e.textContent)).catch(() => false), "calc result")
  check(await p.$$eval(".rc-calc .rc-warn", (l) => l.some((e) => /8%/.test(e.textContent))), "penalty > 8% warning")
  check(!!(await p.$('.rc-fx .rc-src[href*="sbv.gov.vn"]')), "fx card links the official source")
  check(!!(await p.$(".rc-web .rc-badge.ok")) && !!(await p.$(".rc-web .rc-badge.warn")), "web cards: official + unofficial badges")
  check(!!(await p.$(".rc-contract .rc-badge.bad")), "contract check: error count badge")
  await p.evaluate(() => document.querySelector(".rc-calc .rc-more")?.setAttribute("open", ""))
  await p.evaluate(() => document.querySelector(".steps").scrollIntoView({ block: "start" }))
  await sleep(300)
  await p.screenshot({ path: path.join(shots, `v7-cards-${tag}.png`) })
  if (dev === "desktop") {
    await p.evaluate(() => document.querySelector(".rc-web")?.scrollIntoView({ block: "center" }))
    await sleep(200)
    await p.screenshot({ path: path.join(shots, `v7-cards-web-${tag}.png`) })
  }
  await ctx.close()
}
await browser.close()
console.log(fails ? `\n${fails} check(s) failed` : "\nall result-card checks passed")
process.exit(fails ? 1 : 0)
