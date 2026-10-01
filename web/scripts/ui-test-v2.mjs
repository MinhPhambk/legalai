// Full UI run for v2 screens in a separate headless Chrome (never the agent's sandbox Chrome on :9333,
// whose tabs the agent's browser tools can see). Writes screenshots to web/screenshots/v2-*.png.
// Usage: node scripts/ui-test-v2.mjs <user-email> <user-pw> <admin-email> <admin-pw> [versionsChatId]
import path from "node:path"
import fs from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const [EMAIL, PW, AEMAIL, APW, VCHAT] = process.argv.slice(2)
const DOCCHAT = process.env.DOCCHAT || ""
const APP = process.env.APP_URL || "http://127.0.0.1:3000"
const shots = path.join(web, "screenshots")
const dl = path.join(web, "..", ".sandbox", "web", "ui-test-downloads")
fs.mkdirSync(shots, { recursive: true })
fs.rmSync(dl, { recursive: true, force: true })
fs.mkdirSync(dl, { recursive: true })
const profile = path.join(web, "..", ".sandbox", "web", "ui-test-profile")
fs.rmSync(profile, { recursive: true, force: true })

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const only = (process.env.ONLY || "").split(",").filter(Boolean)
const want = (k) => !only.length || only.includes(k)

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  userDataDir: profile,
  args: ["--no-first-run", "--no-default-browser-check", "--lang=vi-VN", "--font-render-hinting=none"],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 60000,
})
const errors = []
async function newPage(ctx = browser, { theme = "light", mobile = false } = {}) {
  const page = await ctx.newPage()
  page.on("console", (m) => m.type() === "error" && !/401|Failed to load resource/.test(m.text()) && errors.push(m.text()))
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }])
  if (mobile) await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const cdp = await page.createCDPSession()
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl }).catch(() => {})
  return page
}
const shot = async (page, name) => {
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))])).catch(() => {})
  await sleep(450)
  await page.screenshot({ path: path.join(shots, `v2-${name}.png`) })
  log("screenshot", name)
}
const setTheme = (page, t) => page.evaluate((t) => (t === "system" ? localStorage.removeItem("nd45-theme") : localStorage.setItem("nd45-theme", t), document.documentElement.setAttribute("data-theme", t)), t)
async function login(page, email, pw) {
  await page.goto(APP + "/login", { waitUntil: "networkidle2" })
  await page.waitForSelector("input[type=email]")
  await page.type("input[type=email]", email)
  await page.type("input[type=password]", pw)
  await page.keyboard.press("Enter")
  await page.waitForSelector(".composer textarea", { timeout: 20000 })
}
async function ask(page, text, { newChat = true } = {}) {
  if (newChat) {
    await page.evaluate(() => {
      history.pushState(null, "", "/")
      dispatchEvent(new PopStateEvent("popstate"))
    })
    await page.waitForSelector(".empty", { timeout: 10000 })
  }
  await page.click("#composer-input")
  await page.type("#composer-input", text)
  const t = Date.now()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => location.pathname.startsWith("/c/"), { timeout: 30000 })
  log("chat created →", page.url(), `(${Date.now() - t} ms)`)
  return t
}
async function waitDone(page, t, label, midShot) {
  let shotTaken = false
  for (;;) {
    const s = await page.evaluate(() => ({
      busy: !!document.querySelector(".send-btn.stop"),
      steps: document.querySelectorAll(".step-tool").length,
      text: document.querySelector(".msg-assistant:last-of-type .md, .turn:last-child .md")?.textContent.length || 0,
      done: !!document.querySelector(".turn:last-child .msg-actions"),
    }))
    if (midShot && !shotTaken && s.busy && s.steps >= 3) {
      shotTaken = true
      await midShot()
    }
    if (!s.busy && s.done) break
    if (Date.now() - t > 900_000) throw new Error("timeout " + label)
    await sleep(700)
  }
  log(`${label}: done after ${((Date.now() - t) / 1000).toFixed(1)} s`)
}

try {
  // ---------------------------------------------------------------- auth screens
  if (want("auth")) {
    const p = await newPage()
    await p.goto(APP + "/login", { waitUntil: "networkidle2" })
    await p.waitForSelector(".auth-hero")
    await shot(p, "01-login-light")
    await p.type("input[type=email]", "sai-dinh-dang")
    await p.click("input[type=password]")
    await p.type("input[type=password]", "sai-mat-khau")
    await sleep(200)
    await p.evaluate(() => (document.querySelector("input[type=email]").value = ""))
    await p.click("input[type=email]", { clickCount: 3 })
    await p.type("input[type=email]", "khong-ton-tai@example.test")
    await p.keyboard.press("Enter")
    await p.waitForSelector(".form-error.show")
    log("login error:", await p.$eval(".form-error", (e) => e.textContent.trim()))
    await p.click(".link-btn.subtle") // Quên mật khẩu?
    await sleep(400)
    await shot(p, "02-login-error-forgot-light")
    await p.click('a[href="/register"]')
    await p.waitForSelector("#" + (await p.$eval("input[type=password]", (e) => e.id)).replace(/:/g, "\\:"))
    await sleep(300)
    await p.click("input[type=email]", { clickCount: 3 })
    await p.keyboard.press("Backspace")
    await p.type("input[type=email]", "ten-sai@")
    const pws = await p.$("input[type=password]")
    await pws[0].click({ clickCount: 3 })
    await p.keyboard.press("Backspace")
    await pws[0].type("abc12")
    await pws[1].type("abc1")
    await p.click(".auth-title")
    await sleep(400)
    await shot(p, "03-register-validation-light")
    await pws[0].type("XYZ!789")
    await pws[1].click({ clickCount: 3 })
    await pws[1].type("abc12XYZ!789")
    await sleep(300)
    await shot(p, "04-register-strength-light")
    await setTheme(p, "dark")
    await p.goto(APP + "/login", { waitUntil: "networkidle2" })
    await shot(p, "05-login-dark")
    await p.close()
    const m = await newPage(browser, { mobile: true })
    await m.goto(APP + "/login", { waitUntil: "networkidle2" })
    await setTheme(m, "light")
    await m.reload({ waitUntil: "networkidle2" })
    await shot(m, "06-login-mobile-light")
    await m.goto(APP + "/register", { waitUntil: "networkidle2" })
    await setTheme(m, "dark")
    await m.reload({ waitUntil: "networkidle2" })
    await shot(m, "07-register-mobile-dark")
    await setTheme(m, "light")
    await m.close()
  }

  const page = await newPage()
  await login(page, EMAIL, PW)
  await setTheme(page, "light")
  log("logged in as test user")

  // ---------------------------------------------------------------- race guard (bug b)
  if (want("race")) {
    await page.goto(APP + "/", { waitUntil: "networkidle2" })
    await page.waitForSelector(".chat-link", { timeout: 15000 }).catch(() => {})
    const other = await page.$eval(".chat-link", (a) => a.getAttribute("href")).catch(() => null)
    if (other) {
      await page.type("#composer-input", "Chỉ trả lời: 'Đã nhận'. Không dùng công cụ.")
      await page.keyboard.press("Enter")
      await page.click(`.chat-link[href="${other}"]`) // switch away while the chat is being created
      await sleep(4000)
      log("race: after sending then switching away, url =", new URL(page.url()).pathname, "expected", other, new URL(page.url()).pathname === other ? "OK" : "MISMATCH")
    }
  }

  // ---------------------------------------------------------------- citations answer
  if (want("cite")) {
    const t = await ask(page, "Mức phạt vi phạm tối đa trong hợp đồng thương mại là bao nhiêu?")
    await waitDone(page, t, "citation answer", () => shot(page, "10-streaming-light"))
    await page.evaluate(() => {
      const el = document.querySelector(".chat-scroll")
      el.scrollTop = document.querySelector(".msg-assistant").offsetTop - 70
    })
    await shot(page, "11-answer-citations-light")
    const n = await page.$$eval(".md a.cite", (a) => a.length)
    log("citation chips:", n, "sources cards:", await page.$$eval(".source-card", (a) => a.length))
    if (n) {
      const chip = await page.$(".md a.cite")
      await chip.evaluate((e) => e.scrollIntoView({ block: "center" }))
      await sleep(300)
      await chip.hover()
      await page.waitForSelector(".cite-card", { timeout: 4000 })
      log("preview:", (await page.$eval(".cite-card", (e) => e.innerText)).replace(/\n/g, " | ").slice(0, 200))
      await shot(page, "12-citation-hover-light")
    }
    await page.evaluate(() => document.querySelector(".sources")?.scrollIntoView({ block: "center" }))
    await shot(page, "13-sources-list-light")
    await setTheme(page, "dark")
    await page.evaluate(() => document.querySelector(".md a.cite")?.scrollIntoView({ block: "center" }))
    const chip = await page.$(".md a.cite")
    if (chip) {
      await chip.hover()
      await sleep(400)
    }
    await shot(page, "14-citation-hover-dark")
    await setTheme(page, "light")
  }

  // ---------------------------------------------------------------- report panel
  if (want("report")) {
    const t = await ask(page, "Rà soát giúp tôi điều khoản sau và lập báo cáo có bảng rủi ro (cột: Điều khoản, Rủi ro, Mức độ, Căn cứ, Đề xuất sửa): 'Điều 5. Bên bán chịu phạt 12% giá trị hợp đồng nếu giao hàng chậm. Điều 6. Bên mua thanh toán trong 90 ngày. Điều 7. Tranh chấp giải quyết tại Tòa án nơi bên bán đặt trụ sở.'")
    let panelShot = false
    await waitDone(page, t, "report answer", async () => {})
    await page.waitForSelector(".report-card", { timeout: 5000 }).catch(() => log("no report card detected"))
    if (await page.$(".report-card")) {
      if (!(await page.$(".report-panel"))) await page.click(".report-card")
      await page.waitForSelector(".report-panel")
      await sleep(600)
      await shot(page, "20-report-panel-light")
      panelShot = true
      // docx export
      await (await page.$(".report-panel:not(.doc-panel) .report-tools .btn"))[0].click()
      for (let i = 0; i < 20 && !fs.readdirSync(dl).some((f) => f.endsWith(".docx")); i++) await sleep(500)
      const docx = fs.readdirSync(dl).find((f) => f.endsWith(".docx"))
      log("docx export:", docx, docx ? fs.statSync(path.join(dl, docx)).size + " bytes" : "MISSING")
      // PDF: run the print path and render it with page.pdf()
      await page.evaluate(() => (window.print = () => {}))
      await (await page.$(".report-panel:not(.doc-panel) .report-tools .btn"))[1].click()
      await sleep(400)
      await page.emulateMediaType("print")
      await page.pdf({ path: path.join(dl, "report-print.pdf"), format: "A4" })
      await page.emulateMediaType(null)
      await page.evaluate(() => window.dispatchEvent(new Event("afterprint")))
      log("print PDF:", fs.statSync(path.join(dl, "report-print.pdf")).size, "bytes")
      await setTheme(page, "dark")
      await shot(page, "21-report-panel-dark")
      await setTheme(page, "light")
      // resize by dragging the handle
      const h = await page.$(".report-resize")
      const b = await h.boundingBox()
      await page.mouse.move(b.x + 4, b.y + 300)
      await page.mouse.down()
      await page.mouse.move(b.x - 160, b.y + 300, { steps: 8 })
      await page.mouse.up()
      log("panel width after drag:", await page.$eval(".report-panel", (e) => e.offsetWidth))
    }
    if (!panelShot) await shot(page, "20-report-answer-light")
  }

  // ---------------------------------------------------------------- versions + edit
  if (want("versions") && VCHAT) {
    await page.goto(APP + "/c/" + VCHAT, { waitUntil: "networkidle2" })
    await page.waitForSelector(".versions", { timeout: 15000 })
    await sleep(500)
    log("version switchers:", await page.$$eval(".versions-n", (e) => e.map((x) => x.textContent)))
    await shot(page, "30-version-switcher-light")
    // switch turn-0 version
    await page.click(".msg-user .versions button:last-child")
    await page.waitForFunction(() => document.querySelector(".msg-user .versions-n")?.textContent === "2/2", { timeout: 15000 })
    await sleep(500)
    log("after switch:", await page.$$eval(".versions-n", (e) => e.map((x) => x.textContent)), "turns:", await page.$$eval(".msg-user", (e) => e.length))
    await shot(page, "31-version-switched-light")
    // inline editor
    await page.hover(".msg-user")
    await page.click('.msg-user button[aria-label="Sửa tin nhắn"]')
    await page.waitForSelector(".user-edit textarea")
    await shot(page, "32-inline-edit-light")
    await page.click(".user-edit .btn.ghost")
    await setTheme(page, "dark")
    await shot(page, "33-version-switcher-dark")
    await setTheme(page, "light")
    // share dialog
    await page.click(".share-btn")
    await page.waitForSelector(".share-dialog")
    await sleep(600)
    const create = await page.$(".share-dialog .btn.primary")
    await create.click()
    await page.waitForSelector(".share-link input", { timeout: 10000 })
    const shareUrl = await page.$eval(".share-link input", (e) => e.value)
    await sleep(300)
    await shot(page, "34-share-dialog-light")
    await page.keyboard.press("Escape")
    // public page in a logged-out context
    const ctx = await browser.createBrowserContext()
    const sp = await newPage(ctx)
    await sp.goto(shareUrl, { waitUntil: "networkidle2" })
    await sp.waitForSelector(".share-head")
    log("share page robots meta:", await sp.$eval('meta[name="robots"]', (m) => m.content), "composer present:", !!(await sp.$(".composer")))
    await shot(sp, "35-share-page-light")
    const spm = await newPage(ctx, { mobile: true, theme: "dark" })
    await spm.goto(shareUrl, { waitUntil: "networkidle2" })
    await spm.waitForSelector(".share-head")
    await shot(spm, "36-share-page-mobile-dark")
    await spm.goto(APP + "/s/khongtontaikhongtontai00", { waitUntil: "networkidle2" })
    await spm.waitForSelector(".state-page")
    await shot(spm, "37-share-notfound-mobile-dark")
    await ctx.close()
  }

  // ---------------------------------------------------------------- search, shortcuts, settings
  if (want("dialogs")) {
    await page.goto(APP + "/", { waitUntil: "networkidle2" })
    await page.waitForSelector(".chat-link")
    await page.keyboard.down("Control")
    await page.keyboard.press("KeyK")
    await page.keyboard.up("Control")
    await page.waitForSelector(".search-dialog input")
    await page.type(".search-dialog input", "phat vi pham")
    await page.waitForSelector(".search-item-snippet mark", { timeout: 8000 }).catch(() => {})
    await sleep(400)
    log("search results:", await page.$$eval(".search-item", (e) => e.length))
    await shot(page, "40-search-light")
    await page.keyboard.press("Escape")
    await sleep(300)
    await page.keyboard.press("?")
    await page.waitForSelector(".kbd-dialog")
    await shot(page, "41-shortcuts-light")
    await page.keyboard.press("Escape")
    await sleep(300)
    await page.keyboard.down("Control")
    await page.keyboard.press("Comma")
    await page.keyboard.up("Control")
    await page.waitForSelector(".settings-dialog")
    await shot(page, "42-settings-general-light")
    for (const [i, name] of [
      [1, "43-settings-account-light"],
      [2, "44-settings-data-light"],
      [3, "45-settings-about-light"],
    ]) {
      await page.click(`.settings-tab:nth-of-type(${i + 1})`)
      await sleep(700)
      await shot(page, name)
    }
    await setTheme(page, "dark")
    await page.click(".settings-tab:nth-of-type(1)")
    await sleep(400)
    await shot(page, "46-settings-general-dark")
    await setTheme(page, "light")
    await page.keyboard.press("Escape")
    // offline + maintenance banners
    await page.setOfflineMode(true)
    await page.evaluate(() => window.dispatchEvent(new Event("offline")))
    await sleep(600)
    await shot(page, "47-offline-banner-light")
    await page.setOfflineMode(false)
    await page.evaluate(() => window.dispatchEvent(new Event("online")))
    await sleep(800)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agent:down")))
    await sleep(500)
    await shot(page, "48-maintenance-banner-light")
    // 404
    await page.goto(APP + "/khong-co-trang-nay", { waitUntil: "networkidle2" })
    await page.waitForSelector(".state-page")
    await shot(page, "49-404-light")
  }

  // ---------------------------------------------------------------- mobile chat
  if (want("mobile")) {
    const mp = await newPage(browser, { mobile: true })
    await mp.goto(APP + "/", { waitUntil: "networkidle2" })
    await mp.waitForSelector(".composer")
    await shot(mp, "50-mobile-empty-light")
    await mp.click(".menu-btn")
    await sleep(600)
    await shot(mp, "51-mobile-sidebar-light")
    await mp.click(".sidebar-overlay")
    const link = await mp.$eval(".chat-link", (a) => a.getAttribute("href")).catch(() => null)
    await mp.goto(APP + (link || "/"), { waitUntil: "networkidle2" })
    await sleep(1200)
    const card = await mp.$(".report-card")
    if (card) {
      await card.click()
      await sleep(700)
      await shot(mp, "52-mobile-report-sheet-light")
      await mp.click('.report-tools button[aria-label="Đóng báo cáo"]')
      await sleep(400)
    }
    await setTheme(mp, "dark")
    await mp.evaluate(() => document.querySelector(".md a.cite")?.scrollIntoView({ block: "center" }))
    const c = await mp.$(".md a.cite")
    if (c) {
      await c.tap()
      await sleep(500)
      log("mobile tap preview:", !!(await mp.$(".cite-card")))
    }
    await shot(mp, "53-mobile-chat-dark")
    await setTheme(mp, "light")
    await mp.close()
  }

  // ---------------------------------------------------------------- admin
  if (want("admin") && AEMAIL) {
    const ctx = await browser.createBrowserContext()
    const ap = await newPage(ctx)
    await login(ap, AEMAIL, APW)
    await ap.goto(APP + "/admin/users", { waitUntil: "networkidle2" })
    await ap.waitForSelector(".admin-table tbody tr .u-email", { timeout: 15000 })
    await ap.type(".admin-search input", "uitest")
    await sleep(800)
    await shot(ap, "60-admin-light")
    // reset password flow for the non-admin test user → one-time password dialog
    const rows = await ap.$$(".admin-table tbody tr")
    for (const r of rows) {
      const email = await r.$eval(".u-email", (e) => e.textContent).catch(() => "")
      if (email.startsWith("uitest-b")) {
        await (await r.$(".actions .btn")).click()
        break
      }
    }
    await ap.waitForSelector(".dialog .btn.primary")
    await shot(ap, "61-admin-confirm-light")
    await ap.click(".dialog .btn.primary")
    await ap.waitForSelector(".otp code", { timeout: 10000 })
    await ap.evaluate(() => (document.querySelector(".otp code").textContent = "••••-•••••-•••••")) // never put a real password in a screenshot
    await shot(ap, "62-admin-onetime-password-light")
    await ap.click(".dialog .btn.primary")
    await setTheme(ap, "dark")
    await sleep(400)
    await shot(ap, "63-admin-dark")
    const am = await newPage(ctx, { mobile: true, theme: "dark" })
    await am.goto(APP + "/admin", { waitUntil: "networkidle2" })
    await am.waitForSelector(".stat-value", { timeout: 15000 })
    await shot(am, "64-admin-mobile-dark")
    await setTheme(ap, "light")
    await ctx.close()
  }
  // ---------------------------------------------------------------- documents, confidence, escalation
  if (want("docs") && DOCCHAT) {
    await page.goto(APP + "/c/" + DOCCHAT, { waitUntil: "networkidle2" })
    await page.waitForSelector(".doc-card", { timeout: 20000 })
    await page.evaluate(() => document.querySelector(".doc-card")?.scrollIntoView({ block: "center" }))
    await shot(page, "70-document-card-light")
    await page.click(".doc-card .btn.primary")
    await page.waitForSelector(".doc-page.ready", { timeout: 20000 })
    await sleep(800)
    await shot(page, "71-document-preview-light")
    await setTheme(page, "dark")
    await shot(page, "72-document-preview-dark")
    await setTheme(page, "light")
    await page.click('.doc-panel button[aria-label="Đóng xem trước"]')
    await sleep(400)
    // confidence badge (hover shows reasons) + escalation card + expert reply
    const badge = await page.$(".conf-badge")
    if (badge) {
      await badge.evaluate((e) => e.scrollIntoView({ block: "center" }))
      await badge.hover()
      await sleep(400)
      log("confidence badge:", await badge.evaluate((e) => e.childNodes.length && e.innerText.split("\n")[0]))
      await shot(page, "73-confidence-badge-light")
    }
    if (await page.$(".esc-card")) {
      await page.evaluate(() => document.querySelector(".esc-thread")?.scrollIntoView({ block: "start" }))
      await sleep(300)
      await shot(page, "74-escalation-reply-light")
      await setTheme(page, "dark")
      await shot(page, "75-escalation-reply-dark")
      await setTheme(page, "light")
    }
    // escalate dialog (opened from an answer's action bar)
    const escBtn = await page.$('.msg-actions button[aria-label="Chuyển chuyên gia"]')
    if (escBtn) {
      await escBtn.click()
      await page.waitForSelector(".esc-dialog")
      await shot(page, "76-escalate-dialog-light")
      await page.keyboard.press("Escape")
    }
    const mp = await newPage(browser, { mobile: true })
    await mp.goto(APP + "/c/" + DOCCHAT, { waitUntil: "networkidle2" })
    await mp.waitForSelector(".doc-card .btn.primary", { timeout: 20000 })
    await mp.click(".doc-card .btn.primary")
    await mp.waitForSelector(".doc-page.ready", { timeout: 20000 })
    await sleep(700)
    await shot(mp, "77-document-preview-mobile")
    await mp.close()
  }
  if (want("expert") && AEMAIL) {
    const ctx = await browser.createBrowserContext()
    const ep = await newPage(ctx)
    await login(ep, AEMAIL, APW)
    await ep.goto(APP + "/expert", { waitUntil: "networkidle2" })
    await ep.waitForSelector(".chip-btn")
    await (await ep.$$(".chip-btn")).at(-1).click() // "Tất cả"
    await ep.waitForSelector(".queue-item", { timeout: 15000 })
    await ep.click(".queue-item")
    await ep.waitForSelector(".case-head h2", { timeout: 15000 })
    await sleep(700)
    await shot(ep, "80-expert-queue-light")
    await setTheme(ep, "dark")
    await shot(ep, "81-expert-queue-dark")
    await setTheme(ep, "light")
    const em = await newPage(ctx, { mobile: true })
    await em.goto(APP + "/expert", { waitUntil: "networkidle2" })
    await em.waitForSelector(".chip-btn")
    await (await em.$$(".chip-btn")).at(-1).click()
    await em.waitForSelector(".queue-item", { timeout: 15000 })
    await shot(em, "82-expert-queue-mobile")
    await ctx.close()
  }
  log("console errors:", errors.length ? errors : "none")
} finally {
  await browser.close()
}
