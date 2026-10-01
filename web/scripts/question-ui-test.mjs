// Question-card UI test: a separate headless Chrome logs in, sends a prompt that makes the agent ask
// clarifying questions, waits for the card, takes screenshots (light / dark / mobile), answers with the
// keyboard (number keys + Enter / Next / Submit), and waits for the run to finish (answering follow-up
// cards the same way). Screenshots: web/screenshots/v7-question-<locale>-*.png
// Usage: node scripts/question-ui-test.mjs <email> <password> [prompt]
// Env: APP_URL (default http://127.0.0.1:3000), LOCALE = vi | en (default vi), CHROME_PATH, MAX_MS,
//      COMPOSER_ANSWER = text: answer the first card by typing in the composer instead (free-text answer),
//      KEEP_PENDING=1: stop at the first card and leave it pending (prints the chat id, for QA screens).
import path from "node:path"
import fs from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const LOCALE = process.env.LOCALE === "en" ? "en" : "vi"
const [email, password, prompt = LOCALE === "en" ? "Draft a contract for me" : "Soạn giúp tôi một hợp đồng"] = process.argv.slice(2)
if (!email || !password) {
  console.error("Usage: node scripts/question-ui-test.mjs <email> <password> [prompt]")
  process.exit(2)
}
const APP = (process.env.APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "")
const MAX_MS = Number(process.env.MAX_MS) || 480_000
const shots = path.join(web, "screenshots")
fs.mkdirSync(shots, { recursive: true })
const shot = (p, name) => p.screenshot({ path: path.join(shots, `v7-question-${LOCALE}-${name}.png`) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = path.join(web, "..", ".sandbox", "web", "question-test-profile")
fs.rmSync(profile, { recursive: true, force: true })

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  userDataDir: profile,
  args: ["--no-first-run", "--no-default-browser-check", `--lang=${LOCALE === "en" ? "en-US" : "vi-VN"}`],
  defaultViewport: { width: 1280, height: 900 },
})
const t0 = Date.now()
const T = () => ((Date.now() - t0) / 1000).toFixed(1) + "s"
let ok = false
try {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.evaluateOnNewDocument((l) => {
    try {
      localStorage.setItem("nd45-locale", l)
    } catch {}
  }, LOCALE)
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
  await page.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await page.waitForSelector(".auth-card input[type=email]", { timeout: 30000 })
  await page.type("input[type=email]", email)
  await page.type("input[type=password]", password)
  await page.click("button[type=submit]")
  await page.waitForSelector("#composer-input", { timeout: 30000 })
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"))
  console.log(T(), "logged in at", APP, "locale", LOCALE)
  await page.click("#composer-input")
  await page.type("#composer-input", prompt)
  const tSend = Date.now()
  await page.keyboard.press("Enter")

  const state = () =>
    page.evaluate(() => {
      const card = [...document.querySelectorAll(".qcard:not(.is-readonly):not(.is-loading)")].at(-1)
      const busy = !!document.querySelector(".send-btn.stop")
      if (!card) return { card: false, busy, answered: document.querySelectorAll(".qcard-done.is-answered").length }
      const tabs = [...card.querySelectorAll(".qcard-tab")]
      const idx = Math.max(0, tabs.findIndex((t) => t.classList.contains("on")))
      const opts = [...card.querySelectorAll(".qopt")]
      return {
        card: true,
        busy,
        idx,
        total: tabs.length || 1,
        multi: !!card.querySelector(".qopt.multi"),
        selected: opts.some((o) => o.getAttribute("aria-checked") === "true"),
        focusInCard: card.contains(document.activeElement),
        header: card.querySelector(".qcard-chip")?.textContent,
        question: card.querySelector(".qcard-q")?.textContent,
        options: opts.map((o) => o.querySelector(".qopt-label")?.textContent),
        sending: card.getAttribute("aria-busy") === "true",
      }
    })

  let cards = 0
  let lastQ = ""
  for (;;) {
    if (Date.now() - tSend > MAX_MS) throw new Error("timeout")
    const st = await state()
    if (!st.card) {
      if (!st.busy && Date.now() - tSend > 8000) break
      await sleep(400)
      continue
    }
    if (st.sending) {
      await sleep(300)
      continue
    }
    const key = `${st.question}|${st.idx}`
    if (st.idx === 0 && st.question !== lastQ && !st.selected) {
      cards++
      console.log(T(), `card ${cards} after ${((Date.now() - tSend) / 1000).toFixed(1)}s: ${st.total} question(s); focus in card: ${st.focusInCard}; "${st.header}" – ${st.question} → [${st.options.join(" | ")}]`)
      if (cards === 1) {
        await sleep(500)
        await shot(page, "light")
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"))
        await sleep(300)
        await shot(page, "dark")
        await page.setViewport({ width: 360, height: 740 })
        await sleep(400)
        await page.evaluate(() => document.querySelector(".qcard:not(.is-readonly)")?.scrollIntoView({ block: "start" }))
        await sleep(200)
        await shot(page, "mobile-dark")
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"))
        await sleep(200)
        await shot(page, "mobile-light")
        await page.setViewport({ width: 1280, height: 900 })
        await sleep(300)
        await page.focus(".qcard:not(.is-readonly) .qopt")
        if (process.env.KEEP_PENDING) {
          console.log("PENDING_CHAT", page.url().split("/c/")[1])
          ok = true
          break
        }
        if (process.env.COMPOSER_ANSWER) {
          await page.click("#composer-input")
          await page.type("#composer-input", process.env.COMPOSER_ANSWER)
          await page.keyboard.press("Enter")
          console.log(T(), "answered card 1 from the composer")
          await page.waitForSelector(".qcard-done.is-answered", { timeout: 15000 })
          lastQ = st.question
          continue
        }
      }
    }
    lastQ = st.idx === 0 ? st.question : lastQ
    // Answer this step with the keyboard: "1" = first option.
    if (!st.selected) {
      if (!(await page.evaluate(() => document.querySelector(".qcard:not(.is-readonly)")?.contains(document.activeElement)))) await page.focus(".qcard:not(.is-readonly) .qopt")
      await page.keyboard.press("1")
      await sleep(450)
      if (!st.multi && st.idx < st.total - 1) continue // single choice advances by itself
    }
    const s2 = await state()
    if (s2.card && s2.idx === st.idx) {
      if (st.idx === st.total - 1) {
        if (cards === 1) await shot(page, "filled")
        await page.click(".qcard:not(.is-readonly) .qcard-foot .btn.primary")
        console.log(T(), `submitted card ${cards}`)
        await sleep(800)
      } else {
        await page.click(".qcard:not(.is-readonly) .qcard-foot .btn.primary")
        await sleep(300)
      }
    }
    void key
  }
  if (process.env.KEEP_PENDING) process.exit(0)
  const tDone = Date.now()
  await sleep(1200)
  const sum = await page.evaluate(() => ({
    answered: [...document.querySelectorAll(".qcard-done.is-answered")].map((e) => e.textContent.slice(0, 200)),
    docCards: document.querySelectorAll(".doc-card").length,
    text: document.querySelectorAll(".msg-assistant .md").length,
    tail: [...document.querySelectorAll(".msg-assistant .md")].at(-1)?.textContent.slice(0, 200),
  }))
  await page.evaluate(() => document.querySelector(".qcard-done")?.scrollIntoView({ block: "center" }))
  await sleep(300)
  await shot(page, "answered")
  console.log(T(), `run finished ${((tDone - tSend) / 1000).toFixed(1)}s after send; cards answered: ${cards}; summaries: ${JSON.stringify(sum.answered)}; doc cards: ${sum.docCards}`)
  console.log("answer tail:", JSON.stringify(sum.tail))
  console.log("chat:", page.url())
  if (errors.length) console.log("page errors:", errors)
  ok = cards > 0 && sum.answered.length >= 1 && !errors.length
  console.log(ok ? "PASS" : "FAIL")
} finally {
  await browser.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(ok ? 0 : 1)
