// UI smoke test: drives a separate headless Chrome against the running app (npm start), logs in,
// asks one question, records timings and writes screenshots to web/screenshots/.
// Usage: node scripts/ui-test.mjs <email> <password> [question]
// Env: APP_URL (default http://127.0.0.1:3000), CHROME_PATH.
import path from "node:path"
import fs from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")

const [email, password, question = "Mức phạt vi phạm tối đa trong hợp đồng thương mại là bao nhiêu?"] = process.argv.slice(2)
if (!email || !password) {
  console.error("Usage: node scripts/ui-test.mjs <email> <password> [question]")
  process.exit(2)
}
const APP = process.env.APP_URL || "http://127.0.0.1:3000"
const shots = path.join(web, "screenshots")
fs.mkdirSync(shots, { recursive: true })
const profile = path.join(web, "..", ".sandbox", "web", "ui-test-profile")
fs.rmSync(profile, { recursive: true, force: true }) // start logged out

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  userDataDir: profile,
  args: ["--no-first-run", "--no-default-browser-check", "--lang=vi-VN"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
})
const t0 = Date.now()
const T = () => ((Date.now() - t0) / 1000).toFixed(1) + " s"
const log = (...a) => console.log(`[${T()}]`, ...a)
const errors = []
try {
  const page = await browser.newPage()
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])

  // 1. login page
  await page.goto(APP + "/", { waitUntil: "networkidle0" })
  await page.waitForSelector(".auth-card input[type=email]")
  await page.evaluate(() => document.fonts.ready)
  await new Promise((r) => setTimeout(r, 700))
  await page.screenshot({ path: path.join(shots, "01-login-light.png") })
  log("login page ok, font:", await page.evaluate(() => getComputedStyle(document.body).fontFamily.split(",")[0]), "loaded:", await page.evaluate(() => document.fonts.check('16px "Be Vietnam Pro"')))

  // wrong password shows a generic error
  await page.type("input[type=email]", email)
  await page.type("input[type=password]", "sai-mat-khau")
  await page.click("button[type=submit]")
  await page.waitForSelector(".form-error.show")
  log("wrong password →", await page.$eval(".form-error", (e) => e.textContent))
  await page.$eval("input[type=password]", (e) => (e.value = ""))
  await page.click("input[type=password]", { clickCount: 3 })
  await page.keyboard.press("Backspace")
  await page.type("input[type=password]", password)
  await page.click("button[type=submit]")
  await page.waitForSelector(".empty .example", { timeout: 15000 })
  log("logged in, empty state shown; composer note:", await page.$eval(".composer-note", (e) => e.textContent))
  await new Promise((r) => setTimeout(r, 900))
  await page.screenshot({ path: path.join(shots, "02-empty-light.png") })

  // 2. ask
  await page.click("#composer-input")
  await page.type("#composer-input", question)
  const tSend = Date.now()
  await page.keyboard.press("Enter")
  await page.waitForSelector(".msg-user", { timeout: 10000 })
  log("user message rendered; url:", page.url())
  await page.waitForSelector(".thinking, .steps", { timeout: 60000 })
  await page.waitForSelector(".steps", { timeout: 120000 })
  const tSteps = Date.now()
  log(`first tool step after ${((tSteps - tSend) / 1000).toFixed(1)} s`)
  let seen = new Set()
  let midShot = false
  let tText = 0
  for (;;) {
    const st = await page.evaluate(() => ({
      current: document.querySelector(".steps-current")?.textContent || "",
      steps: [...document.querySelectorAll(".step-tool")].map((li) => `${li.classList.contains("completed") ? "✓" : li.classList.contains("error") ? "✗" : "…"} ${li.querySelector(".step-meta")?.textContent}`),
      md: document.querySelector(".msg-assistant .md")?.textContent.length || 0,
      streaming: !!document.querySelector(".md.streaming"),
      busy: !!document.querySelector(".send-btn.stop"),
    }))
    for (const s of st.steps) if (!seen.has(s)) (seen.add(s), log("step", s))
    if (!midShot && st.steps.length >= 4) {
      midShot = true
      await page.screenshot({ path: path.join(shots, "03-streaming-steps-light.png") })
    }
    if (st.md && !tText) {
      tText = Date.now()
      log(`answer text started after ${((tText - tSend) / 1000).toFixed(1)} s (streaming caret: ${st.streaming})`)
    }
    if (tText && st.streaming && !fs.existsSync(path.join(shots, "04-streaming-answer-light.png")) && st.md > 400)
      await page.screenshot({ path: path.join(shots, "04-streaming-answer-light.png") })
    if (!st.busy && tText) break
    if (Date.now() - tSend > 600_000) throw new Error("timeout waiting for answer")
    await new Promise((r) => setTimeout(r, 400))
  }
  const tDone = Date.now()
  log(`answer complete after ${((tDone - tSend) / 1000).toFixed(1)} s`)
  await new Promise((r) => setTimeout(r, 1200))
  const summary = await page.evaluate(() => ({
    steps: document.querySelectorAll(".step-tool").length,
    stepsHead: document.querySelector(".steps-head")?.textContent,
    answer: document.querySelector(".msg-assistant .md")?.innerText.slice(0, 400),
    links: [...document.querySelectorAll(".md a")].map((a) => `${a.target} ${a.rel} ${a.href}`).slice(0, 3),
    blockquotes: document.querySelectorAll(".md blockquote").length,
    copy: !!document.querySelector(".msg-actions button"),
    sidebar: [...document.querySelectorAll(".chat-title")].map((e) => e.textContent).slice(0, 3),
  }))
  log("summary", JSON.stringify(summary, null, 1))
  // show the top of the answer with steps collapsed
  await page.evaluate(() => {
    const el = document.querySelector(".chat-scroll")
    const md = document.querySelector(".msg-assistant")
    el.scrollTop = md.offsetTop - 80
  })
  await new Promise((r) => setTimeout(r, 500))
  await page.screenshot({ path: path.join(shots, "05-answer-light.png") })

  // 3. dark theme via the user menu
  await page.click(".user-btn")
  await page.waitForSelector(".user-pop")
  const [darkBtn] = await page.$$(".user-pop [role=menuitemradio]").then((b) => b.slice(1, 2))
  await darkBtn.click()
  await page.keyboard.press("Escape")
  await page.evaluate(() => document.activeElement?.blur())
  await page.evaluate(() => {
    const el = document.querySelector(".steps-head")
    el?.click()
  })
  await new Promise((r) => setTimeout(r, 900))
  await page.screenshot({ path: path.join(shots, "06-answer-dark.png") })
  log("dark theme:", await page.evaluate(() => document.documentElement.dataset.theme), getComputedStyleBg(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)))

  // attachment chip (optional: UI_ATTACH=<path to .docx/.pdf/.txt/.md>)
  if (process.env.UI_ATTACH) {
    const input = await page.$("input[type=file]")
    await input.uploadFile(process.env.UI_ATTACH)
    await page.waitForSelector(".chip.done", { timeout: 30000 })
    await page.type("#composer-input", "Rà soát hợp đồng mua bán hàng hóa tôi tải lên")
    await new Promise((r) => setTimeout(r, 500))
    await page.screenshot({ path: path.join(shots, "07-attachment-dark.png") })
    log("attachment chip:", await page.$eval(".chip", (e) => e.textContent))
    await page.click(".chip .icon-btn")
    await page.$eval("#composer-input", (e) => e.blur())
  }

  // 4. reload keeps history
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForSelector(".msg-assistant .md", { timeout: 15000 })
  log("history restored after reload:", await page.$$eval(".msg", (m) => m.length), "messages")

  // 5. mobile, dark, sidebar open
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await new Promise((r) => setTimeout(r, 500))
  await page.screenshot({ path: path.join(shots, "08-mobile-dark.png") })
  await page.click(".menu-btn")
  await new Promise((r) => setTimeout(r, 600))
  await page.screenshot({ path: path.join(shots, "09-mobile-sidebar-dark.png") })
  // restore system theme for the next run
  await page.evaluate(() => localStorage.removeItem("nd45-theme"))
  log("done; console errors:", errors.length ? errors : "none")
} finally {
  await browser.close()
}

function getComputedStyleBg(bg) {
  return `body background ${bg}`
}
