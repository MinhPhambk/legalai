// Language-leak check: renders replayed real sessions in both UI languages with a separate headless Chrome and flags
// UI-chrome text nodes in the wrong language – Vietnamese diacritics in the English UI, common English UI words in
// the Vietnamese UI. Text inside elements marked as data (data-lang / data-source: queries, law and article titles,
// product descriptions, document titles, model answers, user content) is skipped; everything else must be chrome
// in the UI language. Exit code 1 on any leak.
//
// Needs a harness whose AI server is the scripted replay (prompt "LANG" = recorded tool outputs without UI metadata,
// "LANGNEW" = outputs of the current tools with metadata.ui, "Soạn …" = long-drafting run, "COMPANY" = company_lookup
// (manual_required + reference-site sample) and company_verify (mixed match / partial / mismatch), "ASSIST" = company_lookup
// with assisted browsing – the live-view window + chip while waiting, then "Huỷ" → cancelled chip + card; needs the
// assist harness, whose AI server runs the real tool against the local fake official page) – see README
// "Tách ngôn ngữ giao diện / dữ liệu". Never run against production.
//   APP_URL=http://127.0.0.1:3109 QA_USER=… QA_PW=… node scripts/lang-leak-check.mjs
//   env: LOCALES=vi,en  SCENES=lang,langnew,draft,company,assist,ocr,share,library,expert  SHOTS=1 (screenshots/v8-lang-<tag>-*.png)
//        repair (repair harness): QA_ADMIN / QA_ADMIN_PW – opt-in "tự tra lại" switches + "Tra lại ngay" (screenshots/v11-repair-*.png)
//        ocr (OCR harness, v11): OCR_PDF=<scan.pdf>[,<scan2.pdf> for the 2nd locale] → upload chip / attachment / "OCRSTEP" steps (screenshots/v11-ocr-*.png)
//        TAG=after  CHROME_PATH=…
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const E = process.env
const APP = (E.APP_URL || "").replace(/\/$/, "")
if (!APP || /:3000\b/.test(APP)) {
  console.error("Set APP_URL to a harness (not the production port 3000).")
  process.exit(2)
}
const LOCALES = (E.LOCALES || "vi,en").split(",")
const SCENES = new Set((E.SCENES || "lang,langnew,draft,company,share,library,expert").split(","))
const TAG = E.TAG || "after"
const SHOTS = E.SHOTS === "1"
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Words that only appear in English UI copy (Vietnamese UI chrome must not contain them).
const EN_WORDS = /\b(results?|searched|search(?:ing)?|free|read(?:ing)?|articles?|documents?|loaded|skills?|todos?|tasks?|questions?|asked|opened|pages?|tools?|failed|done|running|official|unofficial|sources?|days?|interest|penalty|total|words|tariffs?|duty|duties|matches|checked|steps?|errors?|warnings?|rates?|version|changes?|edited|added|deleted|created|found|none|reference|conversion|details|standard|precedents?|judgments?|measures?|notifications?|codes?|lines?|origin|since|quota|preferential|verbatim|expired|applicable|in force|deadline|overdue|compan(?:y|ies)|mismatch|portals?|representative|lookup|verif(?:y|ied|ication))\b/i
// Allowed tokens in the Vietnamese UI (brands, standard abbreviations, official column names).
const EN_ALLOW = /\b(LegalAI|FTU|Tech Lab|MFN|NTR|HTS|TARIC|CELEX|EVFTA|FTA|WTO|SPS|TBT|ePing|EUR-Lex|Federal Register|GovInfo|Vietcombank|DOCX|PDF|VND|USD|EUR|Column 2|General|Special|Lighthouse|console|CSS|actual\/\d+|30\/360|half-up|OK|Email|email|CAPTCHA|MST)\b/g
const VI_CHARS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i

const browser = await puppeteer.launch({
  executablePath: E.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "lang-leak-")),
  args: ["--no-first-run", "--lang=en-US"],
})

/** Visible text nodes outside data marks → [{ text, where }] */
async function chromeTexts(p, root = "body") {
  return p.evaluate((root) => {
    const out = []
    const base = document.querySelector(root) || document.body
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.textContent.replace(/\s+/g, " ").trim()
      if (!s || !/\p{L}/u.test(s)) continue
      const el = n.parentElement
      if (!el || el.closest("script,style,noscript,template,[data-lang],[data-source],code,.cite,input,textarea,select option")) continue
      if (!el.checkVisibility({ visibilityProperty: true })) continue
      const where = [el.tagName.toLowerCase(), el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""].join("")
      const ctx = el.closest("[class]")
      out.push({ text: s.slice(0, 160), where: `${ctx?.className?.toString().split(" ")[0] || ""} > ${where}` })
    }
    return out
  }, root)
}
function leaks(list, locale) {
  return list.filter(({ text }) => (locale === "en" ? VI_CHARS.test(text) : EN_WORDS.test(text.replace(EN_ALLOW, " "))))
}
async function expandAll(p) {
  await p.evaluate(() => {
    document.querySelectorAll(".steps-head[aria-expanded=false]").forEach((b) => b.click())
    document.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""))
    document.querySelectorAll(".draft-toggle[aria-expanded=false]").forEach((b) => b.click())
    document.querySelectorAll(".sources-more").forEach((b) => b.click())
    document.querySelectorAll(".doc-changes-more").forEach((b) => b.click())
  })
  await sleep(700)
}
async function newPage(locale) {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  await p.evaluateOnNewDocument((l) => {
    try {
      localStorage.setItem("nd45-locale", l)
      sessionStorage.setItem("nd45-locale-explicit", l)
    } catch {}
  }, locale)
  await p.setViewport({ width: 1440, height: 1000 })
  return { ctx, p }
}
async function login(p, email = E.QA_USER, pw = E.QA_PW) {
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]", { timeout: 20000 })
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
}
async function ask(p, text) {
  await p.goto(APP + "/", { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
  await p.type(".composer textarea", text)
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => location.pathname.startsWith("/c/"), { timeout: 20000 })
  await p.waitForSelector(".msg-assistant", { timeout: 30000 })
  await p.waitForFunction(() => !document.querySelector(".msg-assistant[aria-busy]") && document.querySelector(".msg-assistant .answer-foot, .msg-assistant .msg-actions"), { timeout: 120000 })
  await sleep(1500)
  return p.url().split("/c/")[1]
}
async function shot(p, name, sel = ".msg-assistant", prefix = `v8-lang-${TAG}-`) {
  if (!SHOTS) return
  // Tall viewport so the whole message renders inside the chat's own scroll container.
  const h = await p.evaluate((sel) => Math.max(...[...document.querySelectorAll(sel)].map((e) => e.scrollHeight), document.body.scrollHeight), sel)
  await p.setViewport({ width: 1440, height: Math.min(Math.max(1000, h + 500), 14000) })
  await sleep(400)
  const el = (await p.$$(sel)).at(-1)
  const file = path.join(shots, `${prefix}${name}.png`)
  if (el) await el.screenshot({ path: file, captureBeyondViewport: true }).catch(() => p.screenshot({ path: file, fullPage: true }))
  else await p.screenshot({ path: file, fullPage: true })
  await p.setViewport({ width: 1440, height: 1000 })
}

const report = []
const record = (scene, locale, list) => {
  const bad = leaks(list, locale)
  report.push({ scene, locale, checked: list.length, leaks: bad })
  console.log(`${bad.length ? "✗" : "✓"} ${scene} [${locale}] – ${list.length} chrome text nodes, ${bad.length} leak(s)`)
  for (const b of bad.slice(0, 40)) console.log(`    ${b.where}: ${b.text}`)
}

for (const locale of LOCALES) {
  const { ctx, p } = await newPage(locale)
  await login(p)
  let langChat = null
  for (const [scene, prompt] of [["lang", "LANG – tra cứu mức phạt"], ["langnew", "LANGNEW – tra cứu mức phạt"], ["draft", "Soạn hợp đồng đại lý"], ["company", "COMPANY – kiểm tra đối tác MST 0100123453"]]) {
    if (!SCENES.has(scene) && !(scene === "lang" && (SCENES.has("share") || SCENES.has("expert")))) continue
    const id = await ask(p, prompt)
    if (scene === "lang") langChat = id
    if (!SCENES.has(scene)) continue
    await expandAll(p)
    record(scene, locale, await chromeTexts(p, ".chat-main, main, body"))
    await shot(p, `${locale}-${scene}`)
    // citation preview card
    if (scene !== "draft" && scene !== "company") {
      const cite = await p.$(".msg-assistant .cite")
      if (cite) {
        await cite.hover()
        await sleep(500)
        record(`${scene}-cite`, locale, await chromeTexts(p, ".cite-card"))
      }
    }
  }
  if (SCENES.has("visual")) {
    // v12 visuals (visual harness: prompt "VISUAL" runs the real diagram / image / snapshot tools): figure chrome
    // (buttons, links, lightbox) is checked even though it sits inside the answer; captions / credits are data.
    await ask(p, "VISUAL – vẽ sơ đồ quy trình điều tra")
    await p.waitForSelector(".vis-diagram iframe", { timeout: 20000 }).catch(() => {})
    await sleep(2500)
    await expandAll(p)
    record("visual", locale, await chromeTexts(p, ".chat-main, main, body"))
    const figs = await p.evaluate(() => {
      const out = []
      for (const root of document.querySelectorAll(".vis-figure, .vis-lightbox")) {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const s = n.textContent.replace(/\s+/g, " ").trim()
          const el = n.parentElement
          if (!s || !/\p{L}/u.test(s) || !el) continue
          const d = el.closest("[data-source],[data-lang]")
          if (d && root.contains(d)) continue
          out.push({ text: s.slice(0, 160), where: `vis > ${el.tagName.toLowerCase()}.${String(el.className || "").split(" ")[0]}` })
        }
        for (const el of root.querySelectorAll("button[aria-label], button[title], a[title]")) for (const a of ["aria-label", "title"]) if (el.getAttribute(a)) out.push({ text: el.getAttribute(a), where: `vis > @${a}` })
      }
      return out
    })
    record("visual-figures", locale, figs)
    await p.click(".vis-image .vis-zoom").catch(() => {})
    await sleep(500)
    record("visual-lightbox", locale, await chromeTexts(p, ".vis-lightbox"))
    await p.keyboard.press("Escape")
    await shot(p, `${locale}-visual`)
  }
  if (SCENES.has("ocr")) {
    // scanned-PDF upload (OCR on the server, ~2.5 s/page): processing chip → OCR badge on the chip, the attachment pill
    // and the document card; then tool steps resting on OCR text + the confidence reason "ocr_evidence" (OCRSTEP)
    const pdfs = (E.OCR_PDF || "").split(",").filter(Boolean)
    const pdf = pdfs[LOCALES.indexOf(locale) % Math.max(1, pdfs.length)]
    if (pdf) {
      await p.goto(APP + "/", { waitUntil: "domcontentloaded" })
      await p.waitForSelector(".composer textarea", { timeout: 20000 })
      await (await p.$(".composer input[type=file]")).uploadFile(pdf)
      await p.waitForFunction(() => document.querySelector(".chip.is-ocr-run, .chip.done, .chip.error"), { timeout: 60000 }).catch(() => {})
      if (await p.$(".chip.is-ocr-run")) {
        record("ocr-chip-running", locale, await chromeTexts(p, ".chips"))
        await shot(p, `${locale}-chip-running`, ".composer", "v11-ocr-")
      }
      await p.waitForSelector(".chip.done, .chip.error", { timeout: 120000 })
      await sleep(400)
      record("ocr-chip", locale, await chromeTexts(p, ".chips"))
      await shot(p, `${locale}-chip`, ".composer", "v11-ocr-")
      const hasBadge = !!(await p.$(".chip.done .ocr-badge"))
      console.log(`${hasBadge ? "✓" : "✗"} ocr [${locale}] – chip shows the OCR badge`)
      if (!hasBadge) report.push({ scene: "ocr-badge", locale, checked: 1, leaks: [{ text: "no OCR badge on the upload chip", where: ".chip" }] })
      await p.type(".composer textarea", "OCRUP – tóm tắt bản án đính kèm")
      await p.keyboard.press("Enter")
      await p.waitForFunction(() => location.pathname.startsWith("/c/"), { timeout: 20000 })
      await p.waitForFunction(() => !document.querySelector(".msg-assistant[aria-busy]") && document.querySelector(".msg-assistant .answer-foot, .msg-assistant .msg-actions"), { timeout: 120000 })
      await sleep(1500)
      record("ocr-attachment", locale, await chromeTexts(p, ".msg-user"))
      await shot(p, `${locale}-attachment`, ".msg-user", "v11-ocr-")
    }
    await ask(p, "OCRSTEP – đọc án lệ bản scan")
    await expandAll(p)
    record("ocr-steps", locale, await chromeTexts(p, ".chat-main, main, body"))
    // tooltips (title attributes) are chrome too: OCR badge + confidence reasons
    const titles = await p.evaluate(() => [...document.querySelectorAll(".ocr-badge[title], .conf-badge[title]")].map((e) => ({ text: e.title, where: e.className })))
    record("ocr-tooltips", locale, titles)
    const why = titles.some((x) => /conf-badge/.test(x.where) && /OCR/.test(x.text))
    console.log(`${why ? "✓" : "✗"} ocr [${locale}] – confidence tooltip names the OCR reason`)
    if (!why) report.push({ scene: "ocr-why", locale, checked: 1, leaks: [{ text: "confidence tooltip without the OCR reason", where: ".conf-badge" }] })
    await shot(p, `${locale}-steps`, ".msg-assistant", "v11-ocr-")
  }
  if (SCENES.has("repair")) {
    // opt-in "look up again": admin switch (QA_ADMIN / QA_ADMIN_PW), composer switch, "Tra lại ngay" on a THẤP answer
    // ("LOWCONF" prompt of the repair harness), then the repaired answer. The admin switch is restored to off.
    const { ctx: actx, p: ap } = await newPage(locale)
    await login(ap, E.QA_ADMIN, E.QA_ADMIN_PW)
    const setAdmin = (v) => ap.evaluate((v) => fetch("/api/admin/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoRepairLowConfidence: v }) }).then((r) => r.ok), v)
    await setAdmin(true)
    await ap.goto(APP + "/admin/settings", { waitUntil: "domcontentloaded" })
    await ap.waitForSelector("#adm-auto-repair", { timeout: 20000 })
    await sleep(600)
    record("repair-admin", locale, await chromeTexts(ap, ".adm-card:has(#adm-auto-repair)"))
    await shot(ap, `${locale}-admin`, ".adm-card:has(#adm-auto-repair)", "v11-repair-")
    await p.evaluate(() => fetch("/api/account/auto-repair", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) }))
    await p.goto(APP + "/", { waitUntil: "domcontentloaded" })
    await p.waitForSelector(".composer-toggle", { timeout: 20000 })
    const composerTexts = async () => [...(await chromeTexts(p, ".composer")), ...(await p.evaluate(() => [...document.querySelectorAll(".composer-toggle")].flatMap((e) => [{ text: e.title, where: "composer-toggle[title]" }, { text: e.getAttribute("aria-label"), where: "composer-toggle[aria-label]" }])))]
    record("repair-composer-off", locale, await composerTexts())
    await shot(p, `${locale}-composer-off`, ".composer", "v11-repair-")
    await p.click(".composer-toggle")
    await p.waitForSelector(".composer-toggle.on[aria-checked=true]", { timeout: 10000 })
    record("repair-composer-on", locale, await composerTexts())
    await shot(p, `${locale}-composer-on`, ".composer", "v11-repair-")
    await p.click(".composer-toggle") // back off: the next answer is repaired on demand only
    await p.waitForSelector(".composer-toggle[aria-checked=false]", { timeout: 10000 })
    await ask(p, "LOWCONF – mức phạt vi phạm hợp đồng")
    await p.waitForSelector(".conf-warn .conf-repair", { timeout: 20000 })
    record("repair-low", locale, await chromeTexts(p, ".msg-assistant .answer-foot"))
    await shot(p, `${locale}-low`, ".msg-assistant", "v11-repair-")
    await p.click(".conf-repair")
    await p.waitForSelector(".repair-note", { timeout: 30000 })
    await p.waitForFunction(() => !document.querySelector(".msg-assistant[aria-busy]"), { timeout: 60000 })
    await sleep(1500)
    record("repair-done", locale, await chromeTexts(p, ".chat-main, main, body"))
    await shot(p, `${locale}-repaired`, ".repair-wrap", "v11-repair-")
    await setAdmin(false)
    await actx.close()
  }
  if (SCENES.has("assist")) {
    // waiting: floating window + chip (the run blocks on the user, so no ask()); then cancel from the window
    await p.goto(APP + "/", { waitUntil: "domcontentloaded" })
    await p.waitForSelector(".composer textarea", { timeout: 20000 })
    await p.type(".composer textarea", "ASSIST – tra cứu MST 0100109106")
    await p.keyboard.press("Enter")
    await p.waitForSelector(".assist-pop", { timeout: 60000 })
    await p.waitForFunction(() => !document.querySelector(".assist-pop .assist-loading"), { timeout: 20000 }).catch(() => {})
    await sleep(800)
    record("assist-window", locale, await chromeTexts(p, ".assist-pop"))
    record("assist-chip", locale, await chromeTexts(p, ".assist-chip"))
    await shot(p, `${locale}-assist-window`, ".assist-pop")
    await p.click(".assist-foot .btn")
    await p.waitForFunction(() => document.querySelector(".assist-chip.st-cancelled"), { timeout: 15000 })
    await p.waitForFunction(() => !document.querySelector(".msg-assistant[aria-busy]") && document.querySelector(".msg-assistant .answer-foot, .msg-assistant .msg-actions"), { timeout: 180000 })
    await sleep(1500)
    await expandAll(p)
    record("assist-cancelled", locale, await chromeTexts(p, ".chat-main, main, body"))
    await shot(p, `${locale}-assist-cancelled`)
  }
  if (langChat && (SCENES.has("share") || SCENES.has("expert"))) {
    const r = await p.evaluate(async (id) => {
      const loc = localStorage.getItem("nd45-locale")
      const h = { "Content-Type": "application/json", "X-UI-Locale": loc }
      const sh = await fetch(`/api/chats/${id}/share`, { method: "POST", headers: h, body: "{}" }).then((x) => x.json())
      const es = await fetch(`/api/chats/${id}/escalate`, { method: "POST", headers: h, body: JSON.stringify({ urgency: "trung bình", note: "Nhờ xem lại mức phạt" }) }).then((x) => x.json())
      return { token: sh.share?.token || sh.share?.url?.split("/s/")[1], esc: es.escalation?.id || es.error }
    }, langChat)
    if (SCENES.has("share") && r.token) {
      const { ctx: c2, p: p2 } = await newPage(locale)
      await p2.goto(`${APP}/s/${r.token}`, { waitUntil: "domcontentloaded" })
      await p2.waitForSelector(".msg-assistant", { timeout: 20000 })
      await sleep(1200)
      await expandAll(p2)
      record("share", locale, await chromeTexts(p2))
      await shot(p2, `${locale}-share`)
      await c2.close()
    }
    if (SCENES.has("expert")) {
      await p.goto(`${APP}/c/${langChat}`, { waitUntil: "domcontentloaded" })
      await p.waitForSelector(".esc-card", { timeout: 20000 }).catch(() => {})
      await sleep(800)
      record("escalation-card", locale, await chromeTexts(p, ".esc-card"))
      await p.goto(`${APP}/expert`, { waitUntil: "domcontentloaded" })
      await p.waitForSelector(".queue-item", { timeout: 20000 }).catch(() => {})
      await (await p.$(".queue-item"))?.click()
      await p.waitForSelector(".case-inner", { timeout: 20000 }).catch(() => {})
      await sleep(1500)
      await expandAll(p)
      record("expert", locale, await chromeTexts(p))
      await shot(p, `${locale}-expert`, ".case-inner")
    }
  }
  if (SCENES.has("library")) {
    for (const tab of ["tools", "skills"]) {
      await p.goto(`${APP}/admin/library`, { waitUntil: "domcontentloaded" })
      await p.waitForSelector(".lib-tabs", { timeout: 20000 })
      if (tab === "skills") await (await p.$$(".lib-tabs [role=tab]"))[1]?.click()
      await p.waitForSelector(".lib-item", { timeout: 20000 })
      await sleep(800)
      await expandAll(p)
      record(`library-${tab}`, locale, await chromeTexts(p, ".lib-tabs ~ *, .admin-main, main"))
      await shot(p, `${locale}-library-${tab}`, ".admin-main, main")
    }
  }
  await ctx.close()
}
await browser.close()
const total = report.reduce((n, r) => n + r.leaks.length, 0)
fs.mkdirSync(path.join(web, "..", ".sandbox", "web"), { recursive: true })
fs.writeFileSync(path.join(web, "..", ".sandbox", "web", `lang-leak-${TAG}.json`), JSON.stringify(report, null, 1))
console.log(total ? `lang-leak-check FAILED: ${total} leak(s)` : "lang-leak-check OK")
process.exit(total ? 1 : 0)
