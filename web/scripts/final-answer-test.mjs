// Empty final answer → one hidden "write the final answer" prompt (server/chats.mjs autoFinal). Harness only: the AI
// server must be the scripted fake (prompt "… RỖNG" = empty final message, "… RỖNG2" = empty again after the prompt).
//   APP_URL=http://127.0.0.1:3108 FAKE_URL=http://127.0.0.1:4197 HARNESS_DB=<harness app.db> node scripts/final-answer-test.mjs <email> <pw>
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const APP = (process.env.APP_URL || "http://127.0.0.1:3108").replace(/\/$/, "")
const FAKE = (process.env.FAKE_URL || "http://127.0.0.1:4197").replace(/\/$/, "")
const db = new DatabaseSync(process.env.HARNESS_DB, { readOnly: true })
const [email, pw] = process.argv.slice(2)
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const check = (ok, msg) => (console.log(ok ? "  ✓" : "  ✗", msg), ok || fails++)
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-first-run"] })

async function run(locale, prompt, tag) {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  await p.evaluateOnNewDocument((l) => {
    try {
      localStorage.setItem("nd45-locale", l)
      sessionStorage.setItem("nd45-locale-explicit", l)
    } catch {}
  }, locale)
  await p.setViewport({ width: 1280, height: 860 })
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]")
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
  await p.type(".composer textarea", prompt)
  await p.keyboard.press("Enter")
  let sawFinalizing = false
  const t0 = Date.now()
  while (Date.now() - t0 < 40000) {
    if (await p.$(".repair-status")) sawFinalizing = true
    const done = await p.evaluate(() => !document.querySelector(".msg-assistant[aria-busy]") && !!document.querySelector(".msg-assistant"))
    if (done && Date.now() - t0 > 3000) break
    await sleep(150)
  }
  await sleep(1500)
  const chatId = await p.evaluate(() => location.pathname.split("/").pop())
  const sid = db.prepare("SELECT opencode_session_id AS s FROM branches WHERE chat_id = ?").get(chatId)?.s
  const msgs = await (await fetch(`${FAKE}/session/${sid}/message`)).json()
  const hidden = msgs.filter((m) => m.info.role === "user" && String(m.parts[0]?.text || "").startsWith("[[tra-loi-cuoi]]"))
  const userBubbles = await p.$$eval(".msg-user", (l) => l.length)
  const answer = await p.$$eval(".msg-assistant .md", (l) => l.map((e) => e.textContent).join(" ").trim())
  await p.screenshot({ path: path.join(shots, `v7-final-${tag}.png`) })
  await ctx.close()
  return { sawFinalizing, hidden: hidden.length, hiddenText: hidden[0]?.parts[0]?.text || "", userBubbles, answer, msgs }
}

console.log("empty final message → one hidden prompt → answer")
let r = await run("vi", "Mức phạt vi phạm hợp đồng tối đa là bao nhiêu? RỖNG", "answered-vi")
check(r.hidden === 1, `exactly one hidden final-answer prompt (${r.hidden})`)
check(/Không gọi thêm công cụ trình duyệt/.test(r.hiddenText), "hidden prompt text (vi)")
check(r.userBubbles === 1, "hidden prompt not shown as a user message")
check(/8%/.test(r.answer), "final answer shown in the same turn")
check(r.sawFinalizing, "status line shown while finishing")
check(r.msgs.filter((m) => m.info.role === "user" && String(m.parts[0]?.text || "").startsWith("[[kiem-chung")).length <= 1, "at most one grounding repair after it")
console.log("still empty after the prompt → no-answer notice with the expert button, no loop")
r = await run("en", "What is the maximum contract penalty? RỖNG2", "noanswer-en")
check(r.hidden === 1, `exactly one hidden prompt, no loop (${r.hidden})`)
check(/not verified/.test(r.hiddenText), "hidden prompt text (en)")
{
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.evaluate(() => {
    localStorage.setItem("nd45-locale", "en")
    sessionStorage.setItem("nd45-locale-explicit", "en")
  })
  await p.reload({ waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]")
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
  const chat = db.prepare("SELECT id FROM chats WHERE title LIKE '%RỖNG2%' ORDER BY created_at DESC").get()
  await p.goto(APP + "/c/" + chat.id, { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".msg-assistant", { timeout: 15000 })
  await sleep(800)
  const notice = await p.$eval(".no-answer", (e) => e.textContent).catch(() => "")
  check(/No answer could be produced/.test(notice), "no-answer notice (after reload)")
  check(!!(await p.$(".no-answer .btn")), "expert button in the notice")
  await p.screenshot({ path: path.join(shots, "v7-final-noanswer-reload-en.png") })
  await ctx.close()
}
await browser.close()
console.log(fails ? `\n${fails} check(s) failed` : "\nall final-answer checks passed")
process.exit(fails ? 1 : 0)
