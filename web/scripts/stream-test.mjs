// Live-stream test: a separate headless Chrome logs in, asks one question and records every distinct
// DOM update of the assistant message (tool steps / answer text) with timings, plus which transport
// carried the events (SSE /events vs long-poll /poll requests). Fails unless the answer arrived
// incrementally (≥ 3 distinct updates before completion) and the first update came within FIRST_MS.
// Usage: node scripts/stream-test.mjs <email> <password> [question]
// Env: APP_URL (default http://127.0.0.1:3000), TRANSPORT = sse | poll | auto (default auto),
//      FIRST_MS (default 10000), CHROME_PATH.
import path from "node:path"
import fs from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")

const [email, password, question = "Thời hiệu khởi kiện tranh chấp hợp đồng thương mại là bao lâu? Trả lời ngắn."] = process.argv.slice(2)
if (!email || !password) {
  console.error("Usage: node scripts/stream-test.mjs <email> <password> [question]")
  process.exit(2)
}
const APP = (process.env.APP_URL || "http://127.0.0.1:3000").replace(/\/$/, "")
const TRANSPORT = ["sse", "poll"].includes(process.env.TRANSPORT) ? process.env.TRANSPORT : "auto"
const FIRST_MS = Number(process.env.FIRST_MS) || 10000
const profile = path.join(web, "..", ".sandbox", "web", "stream-test-profile")
fs.rmSync(profile, { recursive: true, force: true })

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  userDataDir: profile,
  args: ["--no-first-run", "--no-default-browser-check", "--lang=vi-VN"],
  defaultViewport: { width: 1280, height: 860 },
})
let ok = false
try {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(String(e)))
  const reqs = { events: 0, poll: 0, messages: 0 }
  const netlog = []
  const t00 = Date.now()
  if (process.env.DEBUG) {
    page.on("requestfinished", (r) => r.url().includes("/api/") && netlog.push(`${((Date.now() - t00) / 1000).toFixed(1)}s ${r.method()} ${r.url().replace(APP, "").slice(0, 70)} ${r.response()?.status()}`))
    page.on("requestfailed", (r) => r.url().includes("/api/") && netlog.push(`${((Date.now() - t00) / 1000).toFixed(1)}s FAIL ${r.url().replace(APP, "").slice(0, 70)} ${r.failure()?.errorText}`))
  }
  page.on("request", (r) => {
    const u = r.url()
    if (/\/api\/chats\/[^/]+\/events/.test(u)) reqs.events++
    else if (/\/api\/chats\/[^/]+\/poll/.test(u)) reqs.poll++
    else if (/\/api\/chats\/[^/]+\/messages/.test(u) && r.method() === "GET") reqs.messages++
  })
  await page.evaluateOnNewDocument((mode) => {
    try {
      if (mode === "auto") localStorage.removeItem("legalai.transport")
      else localStorage.setItem("legalai.transport", mode)
    } catch {}
  }, TRANSPORT)

  const tLogin = Date.now()
  await page.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await page.waitForSelector(".auth-card input[type=email]", { timeout: 30000 })
  await page.type("input[type=email]", email)
  await page.type("input[type=password]", password)
  await page.click("button[type=submit]")
  await page.waitForSelector("#composer-input", { timeout: 30000 })
  console.log(`logged in (${Date.now() - tLogin} ms) at ${APP}, transport=${TRANSPORT}`)

  // Record each distinct state of the last assistant message: steps | answer chars | steps done | reasoning chars.
  await page.evaluate(() => {
    window.__samples = []
    let last = ""
    const sample = () => {
      const all = document.querySelectorAll(".msg-assistant")
      const m = all[all.length - 1]
      if (!m) return
      const sig = `${m.querySelectorAll(".step-tool").length}|${m.querySelector(".md")?.textContent.length || 0}|${m.querySelectorAll(".step-tool.completed").length}|${[...m.querySelectorAll(".step-reason")].reduce((n, e) => n + e.textContent.length, 0)}`
      if (sig !== last) {
        last = sig
        window.__samples.push({ t: Date.now(), sig })
      }
    }
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  })
  await page.click("#composer-input")
  await page.type("#composer-input", question)
  const tSend = Date.now()
  await page.keyboard.press("Enter")
  await page.waitForSelector(".msg-user", { timeout: 15000 })
  // Done = stop button gone (and answer text present, or the run ended without one).
  for (;;) {
    const st = await page.evaluate(() => ({ busy: !!document.querySelector(".send-btn.stop"), md: document.querySelectorAll(".msg-assistant .md").length }))
    if (!st.busy && (st.md || Date.now() - tSend > 8000)) break // (a run can also end without answer text)
    if (Date.now() - tSend > (Number(process.env.MAX_MS) || 300_000)) {
      console.log("TIMEOUT; samples:", JSON.stringify(await page.evaluate(() => window.__samples.slice(-10))), "url:", page.url())
      console.log(netlog.join("\n"))
      throw new Error("timeout waiting for the answer")
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  const tDone = Date.now()
  await new Promise((r) => setTimeout(r, 1500))
  const samples = await page.evaluate(() => window.__samples)
  const transport = await page.evaluate(() => {
    try {
      return sessionStorage.getItem("legalai.transport") || "sse"
    } catch {
      return "?"
    }
  })
  const before = samples.filter((s) => s.t < tDone && s.sig !== "0|0|0|0")
  const first = before[0]
  const rel = (t) => ((t - tSend) / 1000).toFixed(2) + "s"
  console.log(`session transport memory: ${transport}; requests: ${JSON.stringify(reqs)}`)
  console.log(`distinct assistant updates before completion: ${before.length}; first at ${first ? rel(first.t) : "-"}; completed at ${rel(tDone)}`)
  const show = before.length > 14 ? [...before.slice(0, 8), { t: 0, sig: "…" }, ...before.slice(-5)] : before
  for (const s of show) console.log(`  ${s.t ? rel(s.t) : "   …"}  steps|chars|done|reasoning = ${s.sig}`)
  const textUpdates = new Set(before.map((s) => s.sig.split("|")[1]).filter((n) => n !== "0")).size
  console.log(`distinct text lengths while streaming: ${textUpdates}`)
  if (errors.length) console.log("page errors:", errors)
  ok = before.length >= 3 && first && first.t - tSend <= FIRST_MS
  console.log(ok ? "PASS" : "FAIL")
} finally {
  await browser.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(ok ? 0 : 1)
