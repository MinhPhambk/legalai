// Assisted browsing UI test (harness only – see scripts/assist-test.mjs): a separate headless Chrome acts as the
// user. It sends a prompt that makes the (harness) agent run company_lookup with assist on against the local fake
// official page, waits for the floating live-view window, looks at the mirrored page (the code is printed next to
// the box on the fake page – the test reads it from the page, it does not solve anything), clicks into the code box
// ON THE CANVAS, types the code with the keyboard and presses Enter – exactly what a person does – then checks that
// the window closes by itself, the "Đã xác minh" toast / chip appear and the tool's card shows the official record.
// Also: close → chip "Mở lại" → reopen; zoom (starts on the code box, − / fit / +); resize + remembered size; a wrong
// code + Enter shows the site's message in the window; mobile full-screen sheet; EN locale; dark theme.
// Screenshots: web/screenshots/v10-assist-*.png
// Usage: APP_URL=http://127.0.0.1:3111 OUTPUTS=<harness outputs> node scripts/assist-ui-test.mjs
// Env: LOCALE=vi|en, THEME=light|dark, TRANSPORT=ws|poll (live view transport), SHOTS=0 to skip screenshots
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const APP = (process.env.APP_URL || "http://127.0.0.1:3111").replace(/\/$/, "")
if (/:3000$/.test(APP)) throw new Error("refusing to run against production :3000")
const OUTPUTS = process.env.OUTPUTS
const LOCALE = process.env.LOCALE === "en" ? "en" : "vi"
const THEME = process.env.THEME === "dark" ? "dark" : "light"
const TRANSPORT = process.env.TRANSPORT === "poll" ? "poll" : "ws"
const TAG = `${LOCALE}${THEME === "dark" ? "-dark" : ""}${TRANSPORT === "poll" ? "-poll" : ""}`
const shots = path.join(web, "screenshots")
fs.mkdirSync(shots, { recursive: true })
const shot = async (p, name, el) => process.env.SHOTS !== "0" && (el ? el.screenshot({ path: path.join(shots, `v10-assist-${name}.png`) }) : p.screenshot({ path: path.join(shots, `v10-assist-${name}.png`) }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (s) => console.log(`  ✓ ${s}`)
const profile = path.join(web, "..", ".sandbox", "web", "assist-ui-test-profile")
fs.rmSync(profile, { recursive: true, force: true })

// the sandbox Chrome hosts the assist tab – used here ONLY to know where the code box is on the mirrored page and
// to read the code the fake page prints (what the person would read off the picture)
const sandbox = await puppeteer.connect({ browserURL: `http://127.0.0.1:${process.env.CHROME_PORT || 9333}`, defaultViewport: null })
const targetOf = (aid) => {
  for (const d of fs.readdirSync(OUTPUTS)) {
    const f = path.join(OUTPUTS, d, "assist", aid + ".json")
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).targetId
  }
}
async function mirrored(aid) {
  const id = targetOf(aid)
  const t = await sandbox.waitForTarget((x) => x._targetId === id, { timeout: 15000 })
  return t.page()
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  userDataDir: profile,
  args: ["--no-first-run", "--no-default-browser-check", `--lang=${LOCALE === "en" ? "en-US" : "vi-VN"}`],
  defaultViewport: { width: 1366, height: 900 },
})
const t0 = Date.now()
const T = () => ((Date.now() - t0) / 1000).toFixed(1) + "s"
try {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.evaluateOnNewDocument((l, tr) => {
    try {
      localStorage.setItem("nd45-locale", l)
      localStorage.setItem("legalai.assistTransport", tr)
    } catch {}
  }, LOCALE, TRANSPORT)
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: THEME }])
  await page.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await page.waitForSelector(".auth-card input[type=email]", { timeout: 30000 })
  await page.type("input[type=email]", "owner@test.vn")
  await page.type("input[type=password]", "Owner-pass-123")
  await page.click("button[type=submit]")
  await page.waitForSelector("#composer-input", { timeout: 30000 })
  // the account's saved language wins over the browser one: set it for this run
  await page.evaluate((l) => fetch("/api/account/settings", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: l }) }), LOCALE)
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForSelector("#composer-input", { timeout: 30000 })
  await page.evaluate((th) => document.documentElement.setAttribute("data-theme", th), THEME)
  console.log(T(), "logged in", APP, TAG)

  // ---- 1. ask → the window opens by itself
  await page.click("#composer-input")
  await page.keyboard.type(LOCALE === "en" ? "ASSIST check tax code 0100109106" : "ASSIST tra cứu MST 0100109106")
  await page.keyboard.press("Enter")
  await page.waitForSelector(".assist-pop", { timeout: 60000 })
  const aid = await page.$eval(".assist-pop", (e) => e.dataset.assist)
  await page.waitForFunction(() => !document.querySelector(".assist-pop .assist-loading"), { timeout: 20000 })
  await sleep(600)
  const pop = await page.$(".assist-pop")
  const box = await pop.boundingBox()
  assert.ok(box.width >= 860 && box.width <= 910, `popup width ${box.width} (min(900, 70vw))`)
  assert.ok(await page.$(`.assist-chip[data-assist-chip="${aid}"]`), "chip in the stream")
  const notice = await page.$eval(".assist-note", (e) => e.textContent)
  assert.match(notice, LOCALE === "en" ? /verify that you are a person/ : /xác minh bạn là người thật/)
  assert.ok(await page.$eval(".assist-count", (e) => /^\d:\d\d$/.test(e.textContent.trim())), "countdown")
  const href = await page.$eval(".assist-head a", (e) => e.getAttribute("href"))
  assert.equal(href, "http://127.0.0.1:4556/")
  ok(`window opened (${Math.round(box.width)}×${Math.round(box.height)} px), notice, countdown, open-in-tab link, chip in the stream`)
  await shot(page, `${TAG}-popup`)
  await shot(page, `${TAG}-popup-window`, pop)
  // the canvas shows the mirrored page (not blank)
  const nonBlank = await page.$eval(".assist-canvas", (c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data
    let dark = 0
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 128) dark++
    return dark
  })
  assert.ok(nonBlank > 20, "mirrored frame drawn")
  ok("mirrored page drawn on the canvas")

  // ---- 2. close → chip "Mở lại" → reopen
  await page.click('.assist-close')
  await page.waitForFunction(() => !document.querySelector(".assist-pop"), { timeout: 5000 })
  const reopen = await page.waitForSelector(`.assist-chip[data-assist-chip="${aid}"] .link-btn`, { timeout: 5000 })
  await shot(page, `${TAG}-chip`)
  await reopen.click()
  await page.waitForSelector(".assist-pop", { timeout: 5000 })
  await page.waitForFunction(() => !document.querySelector(".assist-pop .assist-loading"), { timeout: 20000 })
  ok("close → chip with “reopen” → window back")
  // closing / reopening many times never piles up live views (4 per user max on the server)
  for (let i = 0; i < 6; i++) {
    await page.click(".assist-close")
    await page.waitForSelector(`.assist-chip[data-assist-chip="${aid}"] .link-btn`, { timeout: 5000 })
    await page.click(`.assist-chip[data-assist-chip="${aid}"] .link-btn`)
    await page.waitForSelector(".assist-pop .assist-canvas", { timeout: 5000 })
  }
  await page.waitForFunction(() => !document.querySelector(".assist-pop .assist-loading"), { timeout: 20000 })
  assert.equal(await page.evaluate(() => /too many requests/i.test(document.body.innerText)), false)
  ok("6 × close / reopen: still live (old sockets closed, no 429)")

  // ---- 3. zoom: starts on the code box at 100–125 %, − / label (fit) / +, the window can be resized (size kept)
  const zl = () => page.$eval(".assist-zoom-label", (e) => e.textContent.trim())
  const cw = () => page.$eval(".assist-canvas", (c) => c.getBoundingClientRect().width)
  assert.match(await zl(), /^(100|125)%$/, "starts zoomed on the form")
  await sleep(300)
  const cw0 = await cw()
  assert.ok(cw0 >= 1199, `page at ≥ 100 %: ${cw0} (${await zl()})`)
  const vis = await page.evaluate(() => {
    const st = document.querySelector(".assist-stage").getBoundingClientRect(), c = document.querySelector(".assist-canvas").getBoundingClientRect()
    return { st: { l: st.left, r: st.right, t: st.top, b: st.bottom }, k: c.width / 1200, cx: c.left, cy: c.top }
  })
  const mp = await mirrored(aid)
  const box0 = await mp.$eval("#captcha", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom } })
  const onScreen = (x, y) => x >= vis.st.l && x <= vis.st.r && y >= vis.st.t && y <= vis.st.b
  assert.ok(onScreen(vis.cx + box0.x * vis.k, vis.cy + box0.y * vis.k) && onScreen(vis.cx + box0.r * vis.k, vis.cy + box0.b * vis.k), "the code box is in view")
  await shot(page, `${TAG}-zoom-default`)
  const z0 = await zl()
  await page.click(".assist-zoom-out")
  await sleep(300)
  assert.ok((await cw()) < (z0 === "125%" ? 1499 : 1199), "zoom out")
  await page.click(".assist-zoom-label") // → whole page
  await sleep(300)
  const fitW = await cw()
  assert.ok(fitW < 1000, `fit ${fitW}`)
  await page.click(".assist-zoom-in")
  await sleep(300)
  assert.ok((await cw()) > fitW, "zoom in")
  await page.click(".assist-zoom-label") // back to the fit, then to the form
  await sleep(200)
  await page.click(".assist-zoom-label")
  await sleep(400)
  assert.equal(await zl(), z0)
  ok(`opens at ${z0} on the code box (in view), − / whole page / + work, back to ${z0}`)
  // resize from the corner → kept for the next window
  const g = await (await page.$(".assist-grip")).boundingBox()
  const before = await (await page.$(".assist-pop")).boundingBox()
  await page.mouse.move(g.x + 8, g.y + 8)
  await page.mouse.down()
  await page.mouse.move(g.x - 150, g.y - 60, { steps: 6 })
  await page.mouse.up()
  await sleep(300)
  const after = await (await page.$(".assist-pop")).boundingBox()
  assert.ok(Math.abs(after.width - (before.width - 158)) < 4 && Math.abs(after.height - (before.height - 68)) < 4, JSON.stringify({ before, after }))
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("legalai.assistSize")))
  assert.ok(Math.abs(saved.w - after.width) < 2)
  ok(`resized from the corner ${Math.round(before.width)}×${Math.round(before.height)} → ${Math.round(after.width)}×${Math.round(after.height)}, size remembered`)
  await page.evaluate(() => localStorage.removeItem("legalai.assistSize"))

  // ---- 4. operate the page like a person: click the code box on the canvas, type, Enter
  const clickBox = async () => {
    const rect = await mp.$eval("#captcha", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    const c = await page.$eval(".assist-canvas", (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
    await page.mouse.click(c.x + (rect.x / 1200) * c.w, c.y + (rect.y / 800) * c.h)
    await sleep(500)
  }
  // a mistyped code first: the site's own message appears in the window
  await clickBox()
  assert.equal(await mp.evaluate(() => document.activeElement?.id), "captcha", "click on the canvas focused the real box")
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("assist-kbd")), true)
  await page.keyboard.type("WRONG", { delay: 40 })
  await sleep(400)
  assert.equal(await mp.$eval("#captcha", (e) => e.value), "WRONG", "typed once, same case")
  await page.keyboard.press("Enter")
  await page.waitForSelector(".assist-page-msg", { timeout: 15000 })
  const msg = await page.$eval(".assist-page-msg", (e) => e.textContent)
  assert.match(msg, /Vui lòng nhập đúng mã xác nhận/)
  assert.equal(await mp.$eval("#mst", (e) => e.value), "0100109106", "MST filled again")
  await sleep(600)
  await shot(page, `${TAG}-wrong-code`)
  ok(`wrong code + Enter → the site's message in the window: "${msg.trim().slice(0, 70)}"`)
  // the site rate-limits: its own "Too Many Requests" page → a clear message + "Thử lại" after a pause
  await clickBox()
  await page.keyboard.type("LIMIT", { delay: 30 })
  await page.keyboard.press("Enter")
  await page.waitForSelector(".assist-page-err", { timeout: 15000 })
  const errTxt = await page.$eval(".assist-page-err", (e) => e.textContent)
  assert.match(errTxt, LOCALE === "en" ? /limiting the number of lookups/ : /đang giới hạn số lượt tra/)
  assert.equal(await page.$eval(".assist-page-err button", (b) => b.disabled), true, "retry waits")
  assert.ok(await page.$(".assist-pop"), "window stays open")
  await shot(page, `${TAG}-rate-limited`)
  await page.waitForFunction(() => !document.querySelector(".assist-page-err button")?.disabled, { timeout: 30000 })
  await page.click(".assist-page-err button")
  await page.waitForFunction(() => !document.querySelector(".assist-page-err"), { timeout: 30000 })
  await sleep(800)
  assert.equal(await mp.$eval("#mst", (e) => e.value), "0100109106")
  ok(`site 429 → "${errTxt.trim().slice(0, 60)}…", window kept open, "Thử lại" after the pause reloads the form`)
  const code = await mp.$eval("#capimg", (e) => e.textContent.trim()) // what the person reads on the picture
  await clickBox()
  await page.keyboard.type(code, { delay: 60 })
  await sleep(700)
  assert.equal(await mp.$eval("#captcha", (e) => e.value), code)
  await shot(page, `${TAG}-typing`)
  ok(`clicked the code box on the canvas, typed "${code}" → the real page has it`)
  await page.keyboard.press("Enter")
  // the window closes by itself, toast + chip
  await page.waitForFunction(() => !document.querySelector(".assist-pop"), { timeout: 30000 })
  await page.waitForFunction((a) => document.querySelector(`.assist-chip[data-assist-chip="${a}"]`)?.classList.contains("st-done"), { timeout: 10000 }, aid)
  const toast = await page.$$eval(".toast", (x) => x.map((e) => e.textContent).join(" | ")).catch(() => "")
  assert.match(toast, LOCALE === "en" ? /Verified/ : /Đã xác minh/)
  await shot(page, `${TAG}-verified`)
  ok(`window closed automatically, toast "${toast.trim().slice(0, 60)}", chip done`)
  // the tool continues: official card
  await page.waitForFunction(() => [...document.querySelectorAll(".rc-co-origin")].some((e) => e.textContent.length > 10), { timeout: 60000 })
  await page.waitForFunction(() => !document.querySelector(".composer .btn-stop, [aria-label='Dừng'], [aria-label='Stop']"), { timeout: 30000 }).catch(() => {})
  await sleep(1200)
  const card = await page.$eval(".rc-co", (e) => e.innerText)
  assert.match(card, /CÔNG TY THỬ NGHIỆM ABC/)
  assert.doesNotMatch(card, /001234567890|0241234567/)
  const chip = await page.$eval(`.assist-chip[data-assist-chip="${aid}"]`, (e) => e.textContent)
  assert.match(chip, LOCALE === "en" ? /Verified on the official site/ : /Đã xác minh trên trang chính thức/)
  const cardEl = await page.$(".rc-co")
  await cardEl.evaluate((e) => e.scrollIntoView({ block: "center" }))
  await sleep(300)
  await shot(page, `${TAG}-result`)
  ok("tool continued: company card from the official source (no personal ID / phone), chip “verified”")
  assert.deepEqual(errors, [])

  // ---- 5. mobile: full-screen sheet, tap-to-type path (hidden input)
  if (process.env.MOBILE !== "0") {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    await page.waitForSelector("#composer-input", { timeout: 30000 })
    await sleep(800)
    await page.click("#composer-input")
    await page.keyboard.type("ASSIST lần 2")
    await page.keyboard.press("Enter")
    await page.waitForSelector(".assist-pop.sheet", { timeout: 60000 })
    await page.waitForFunction(() => !document.querySelector(".assist-pop .assist-loading"), { timeout: 20000 })
    await sleep(600)
    const sb = await page.$eval(".assist-pop", (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, sw: document.documentElement.scrollWidth } })
    assert.equal(Math.round(sb.w), 390); assert.ok(sb.h >= 800); assert.ok(sb.sw <= 390, "no horizontal overflow")
    const cw = await page.$eval(".assist-canvas", (c) => { const r = c.getBoundingClientRect(); return { w: r.width, h: r.height } })
    assert.ok(Math.abs(cw.w / cw.h - 1.5) < 0.02, `aspect ${cw.w}/${cw.h}`)
    assert.ok(cw.w >= 1199, `≥ 100 % on phones: ${cw.w}`)
    await shot(page, `${TAG}-mobile`)
    const aid2 = await page.$eval(".assist-pop", (e) => e.dataset.assist)
    const mp2 = await mirrored(aid2)
    assert.equal(await page.$eval(".assist-pop", (e) => e.classList.contains("zoomed")), true, "phones start at ≥ 100 %")
    const r2 = await mp2.$eval("#captcha", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    const c2 = await page.$eval(".assist-canvas", (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
    const st2 = await page.$eval(".assist-stage", (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom } })
    const tapX = c2.x + (r2.x / 1200) * c2.w, tapY = c2.y + (r2.y / 800) * c2.h
    assert.ok(tapX > st2.l && tapX < st2.r && tapY > st2.t && tapY < st2.b, `code box in view on the phone: ${JSON.stringify({ tapX, tapY, st2 })}`)
    await page.touchscreen.tap(tapX, tapY)
    await sleep(500)
    assert.equal(await mp2.evaluate(() => document.activeElement?.id), "captcha", "tap focused the real box")
    // a phone keyboard delivers text through input events (no usable key codes)
    await page.evaluate(() => {
      const i = document.querySelector(".assist-kbd")
      i.value = "WRONG1"
      i.dispatchEvent(new InputEvent("input", { bubbles: true, data: "WRONG1", inputType: "insertText" }))
    })
    await sleep(500)
    assert.equal(await mp2.$eval("#captcha", (e) => e.value), "WRONG1")
    ok("mobile: full-screen sheet 390 px, page at ≥ 100 % with the code box in view (pannable), no page overflow; tap focuses the real box, phone-keyboard text arrives")
    // cancel from the sheet
    await page.click(".assist-foot .btn")
    await page.waitForFunction(() => !document.querySelector(".assist-pop"), { timeout: 10000 })
    await page.waitForFunction((a) => document.querySelector(`.assist-chip[data-assist-chip="${a}"]`)?.classList.contains("st-cancelled"), { timeout: 10000 }, aid2)
    await shot(page, `${TAG}-mobile-cancelled`)
    ok("“Huỷ” cancels: window closes, chip “cancelled”")
  }
  assert.deepEqual(errors, [])
  console.log(`\nASSIST UI TEST PASSED (${TAG}, ${T()})`)
} finally {
  await browser.close()
  sandbox.disconnect()
}
process.exit(0)
