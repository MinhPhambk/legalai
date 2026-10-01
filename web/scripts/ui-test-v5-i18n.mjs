// v5 screenshots (i18n + follow-ups + about/PII), separate headless Chrome – never the agent's sandbox Chrome.
// Usage: APP_URL=http://127.0.0.1:3102 QA_USER=… QA_PW=… QA_ADMIN=… QA_ADMIN_PW=… QA_FOLLOW=<chat> QA_DOCV=<chat> QA_DOC=<chat>
//        QA_LOCALE=en|vi node scripts/ui-test-v5-i18n.mjs
// Writes screenshots/v5-<locale>-*.png and v5-followups-<locale>-*.png; exits 1 on a failed check.
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const E = process.env
const APP = E.APP_URL || "http://127.0.0.1:3102"
const L = E.QA_LOCALE === "vi" ? "vi" : "en"
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (ok, msg) => {
  console.log(`${ok ? "✓" : "✗"} ${msg}`)
  if (!ok) failed++
}

const browser = await puppeteer.launch({
  executablePath: E.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--no-first-run", `--lang=${L === "en" ? "en-US" : "vi-VN"}`],
})
async function page({ width = 1440, height = 900, mobile = false, theme = "light", locale = L, explicit = true } = {}) {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  await p.evaluateOnNewDocument(
    (l, th, ex) => {
      try {
        // Signed-out pages: only the first visit gets the run's locale (so a switch survives a reload).
        if (ex || !localStorage.getItem("nd45-locale")) localStorage.setItem("nd45-locale", l)
        if (ex) sessionStorage.setItem("nd45-locale-explicit", l)
        localStorage.setItem("nd45-theme", th)
      } catch {}
    },
    locale,
    theme,
    explicit,
  )
  await p.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
  p.setDefaultTimeout(15000)
  p.on("pageerror", (e) => console.log("pageerror:", e.message))
  return p
}
async function login(p, email, pw) {
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]")
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
}
const shot = (p, name) => p.screenshot({ path: path.join(shots, `${name}.png`) })
const text = (p, sel) => p.$eval(sel, (e) => e.textContent.trim()).catch(() => "")
const hasVietnamese = (s) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(s)

// ---- login (signed out): toggle, html lang, title ------------------------------------------------------
{
  const p = await page({ explicit: false })
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".auth-lang")
  check((await p.evaluate(() => document.documentElement.lang)) === L, `<html lang="${L}"> on the login page`)
  check((await p.title()).includes(L === "en" ? "Sign in" : "Đăng nhập"), `document title localized: ${await p.title()}`)
  check((await text(p, ".auth-title")) === (L === "en" ? "Welcome back" : "Chào mừng trở lại"), "login heading")
  await shot(p, `v5-${L}-login`)
  // Switch language on the login page.
  const other = L === "en" ? "vi" : "en"
  await p.click(`.auth-lang button[lang=${other}]`)
  await sleep(300)
  check((await p.evaluate(() => document.documentElement.lang)) === other, "toggle switches <html lang>")
  check((await text(p, ".auth-title")) === (other === "en" ? "Welcome back" : "Chào mừng trở lại"), "toggle re-renders the form")
  await p.reload({ waitUntil: "domcontentloaded" })
  await p.waitForSelector(".auth-title")
  check((await p.evaluate(() => localStorage.getItem("nd45-locale"))) === other, "choice persisted in localStorage")
  await p.setViewport({ width: 320, height: 640, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await p.click(`.auth-lang button[lang=${L}]`)
  await sleep(300)
  await shot(p, `v5-${L}-login-320`)
  const overflow = await p.evaluate(() => document.scrollingElement.scrollWidth > innerWidth + 1)
  check(!overflow, "login at 320px: no horizontal overflow")
  await p.browserContext().close()
}

// ---- chat: tool steps + confidence badge + follow-ups ----------------------------------------------------
const followShots = async (opts, tag) => {
  const p = await page(opts)
  await login(p, E.QA_USER, E.QA_PW)
  await p.goto(APP + "/c/" + E.QA_FOLLOW, { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".followups .followup")
  await p.evaluate(() => document.querySelector(".chat-scroll")?.scrollTo(0, 1e9))
  await sleep(900)
  return p
}
{
  const p = await followShots({}, "")
  // expand the step list
  await p.click(".steps-head")
  await sleep(400)
  const steps = await p.$$eval(".step-name", (xs) => xs.map((x) => x.textContent.trim()))
  check(steps.length >= 3, `tool steps rendered: ${steps.join(" | ")}`)
  if (L === "en") {
    check(steps.every((s) => !hasVietnamese(s)), "tool step names in English")
    const res = await p.$$eval(".step-result", (xs) => xs.map((x) => x.textContent.trim()))
    check(res.some((r) => /^3 results$/.test(r)), `step results localized: ${res.join(" | ")}`)
    check(/^Confidence: High/.test(await text(p, ".conf-badge")), `confidence badge: ${await text(p, ".conf-badge")}`)
  } else check(/^Độ tin cậy: Cao/.test(await text(p, ".conf-badge")), "confidence badge (vi)")
  const chips = await p.$$eval(".followup", (xs) => xs.map((x) => x.textContent.trim()))
  check(chips.length === 3, `3 follow-up chips: ${chips.join(" | ")}`)
  await shot(p, `v5-${L}-chat-steps`)
  await shot(p, `v5-followups-${L}-light`)
  // Keyboard access: Tab reaches a chip.
  await p.focus(".followup")
  check(await p.evaluate(() => document.activeElement?.classList.contains("followup")), "follow-up chip is focusable")
  await p.browserContext().close()
}
{
  const p = await followShots({ theme: "dark" })
  await shot(p, `v5-followups-${L}-dark`)
  await p.browserContext().close()
}
{
  const p = await followShots({ width: 390, height: 844, mobile: true })
  await shot(p, `v5-followups-${L}-mobile`)
  await p.setViewport({ width: 320, height: 640, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await sleep(400)
  await p.evaluate(() => document.querySelector(".followups")?.scrollIntoView({ block: "center" }))
  await sleep(300)
  const bad = await p.evaluate(() => [...document.querySelectorAll(".followup")].some((b) => b.getBoundingClientRect().right > innerWidth + 1))
  check(!bad, "follow-up chips wrap inside 320px")
  await shot(p, `v5-followups-${L}-320`)
  await p.browserContext().close()
}
// Low confidence → "Ask an expert to review"
if (E.QA_LOW) {
  const p = await page()
  await login(p, E.QA_USER, E.QA_PW)
  await p.goto(APP + "/c/" + E.QA_LOW, { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".conf-badge.lv-low")
  await sleep(500)
  check((await text(p, ".answer-foot .btn")).includes(L === "en" ? "Ask an expert to review" : "Nhờ chuyên gia xem lại"), "low-confidence CTA")
  await shot(p, `v5-${L}-chat-low-confidence`)
  await p.browserContext().close()
}

// ---- documents: card (language badge) + diff ---------------------------------------------------------------
{
  const p = await page()
  await login(p, E.QA_USER, E.QA_PW)
  if (E.QA_DOC) {
    await p.goto(APP + "/c/" + E.QA_DOC, { waitUntil: "domcontentloaded" })
    await p.waitForSelector(".doc-card .doc-lang")
    check((await text(p, ".doc-card .doc-lang")) === "VI–EN", "bilingual badge VI–EN")
    await p.evaluate(() => document.querySelector(".doc-card")?.scrollIntoView({ block: "center" }))
    await sleep(400)
    await shot(p, `v5-${L}-doc-card`)
  }
  await p.goto(APP + "/c/" + E.QA_DOCV, { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".doc-card .doc-diff-btn")
  check((await text(p, ".doc-card .doc-lang")) === "VI", "missing language → VI badge")
  const b = (await p.$$(".doc-card .doc-diff-btn")).at(-1)
  await b.evaluate((e) => e.scrollIntoView({ block: "center" }))
  await b.click()
  await p.waitForSelector(".doc-panel .diff-text")
  await sleep(700)
  const sub = await text(p, ".doc-panel .report-head-text span")
  check(L === "en" ? /^Comparing v1 → v2 · \+\d+ words? · −\d+ words? · \d+ changes?$/.test(sub) : /^So sánh v1 → v2/.test(sub), `diff header: ${sub}`)
  await shot(p, `v5-${L}-doc-diff`)
  await p.browserContext().close()
}

// ---- settings (General with language), about dialog, PII warning --------------------------------------------
{
  const p = await page()
  await login(p, E.QA_USER, E.QA_PW)
  await p.keyboard.down("Control")
  await p.keyboard.press("Comma")
  await p.keyboard.up("Control")
  await p.waitForSelector(".settings-dialog")
  await sleep(500)
  const tabs = await p.$$eval(".settings-tab", (xs) => xs.map((x) => x.textContent.trim()))
  check(tabs.join(",") === (L === "en" ? "General,Account,Data,About" : "Chung,Tài khoản,Dữ liệu,Giới thiệu"), `settings tabs: ${tabs}`)
  await shot(p, `v5-${L}-settings`)
  // Switch language from Settings → General; persisted for the account.
  const other = L === "en" ? "vi" : "en"
  const names = { vi: "Tiếng Việt", en: "English" }
  await p.evaluate((n) => [...document.querySelectorAll(".settings-dialog .segmented button")].find((b) => b.textContent.trim() === n)?.click(), names[other])
  await sleep(600)
  check((await p.evaluate(() => document.documentElement.lang)) === other, "Settings switch changes <html lang>")
  const me = await p.evaluate(() => fetch("/api/me").then((r) => r.json()))
  check(me.user.locale === other, `account locale saved: ${me.user.locale}`)
  await p.evaluate((n) => [...document.querySelectorAll(".settings-dialog .segmented button")].find((b) => b.textContent.trim() === n)?.click(), names[L])
  await sleep(500)
  await p.keyboard.press("Escape")
  await sleep(300)
  await p.click(".composer-about")
  await p.waitForSelector(".about-dialog")
  await sleep(400)
  check((await text(p, ".about-dialog .dialog-title")) === (L === "en" ? "About & limitations" : "Giới thiệu & giới hạn"), "about dialog title")
  await shot(p, `v5-${L}-about`)
  await p.keyboard.press("Escape")
  if (true) {
    await p.type(".composer textarea", "CCCD 079203001234")
    await p.keyboard.press("Enter")
    await p.waitForSelector(".pii-warn")
    check(!(await text(p, ".pii-warn")).includes("079203001234"), "PII warning never echoes the value")
    await shot(p, `v5-${L}-pii-warn`)
  }
  await p.browserContext().close()
}

// ---- admin + expert queue ----------------------------------------------------------------------------------
{
  const p = await page()
  await login(p, E.QA_ADMIN, E.QA_ADMIN_PW)
  await p.goto(APP + "/admin/users", { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".admin-table .u-email")
  await sleep(600)
  check((await p.title()).includes(L === "en" ? "Admin" : "Quản trị"), "admin title")
  await shot(p, `v5-${L}-admin-users`)
  await p.goto(APP + "/admin/settings", { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".admin-followups .segmented")
  await sleep(400)
  await shot(p, `v5-${L}-admin`)
  await p.goto(APP + "/expert", { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".chip-btn")
  await (await p.$$(".chip-btn")).at(-1).click()
  await p.waitForSelector(".queue-item")
  await p.click(".queue-item")
  await p.waitForSelector(".case-head h2")
  await sleep(600)
  const filters = await p.$$eval(".chip-btn", (xs) => xs.map((x) => x.childNodes[0].textContent.trim()))
  check(filters.join(",") === (L === "en" ? "Open,New,In progress,Answered,Closed,All" : "Đang mở,Mới,Đang xử lý,Đã trả lời,Đã đóng,Tất cả"), `expert filters: ${filters}`)
  await shot(p, `v5-${L}-expert`)
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await sleep(400)
  await shot(p, `v5-${L}-expert-mobile`)
  await p.browserContext().close()
}

// ---- share page (signed out) --------------------------------------------------------------------------------
if (E.QA_SHARE) {
  const p = await page({ explicit: false })
  await p.goto(APP + "/s/" + E.QA_SHARE, { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".share-head")
  await sleep(500)
  check((await text(p, ".share-badge")).includes(L === "en" ? "View-only" : "chỉ xem"), "share badge localized")
  await shot(p, `v5-${L}-share`)
  await p.browserContext().close()
}

await browser.close()
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed")
process.exitCode = failed ? 1 : 0
