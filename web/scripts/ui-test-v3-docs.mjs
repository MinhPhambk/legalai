// Screenshots of document versions: doc card with the version switcher, diff panel (light / dark / mobile),
// "chỉ hiện chỗ thay đổi", imported upload card. Separate headless Chrome (never the agent's sandbox Chrome).
// Usage: node scripts/ui-test-v3-docs.mjs <email> <password> <chatId with a versioned document> [shareToken]
//        env APP_URL (default http://127.0.0.1:3000), CHROME_PATH
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const APP = process.env.APP_URL || "http://127.0.0.1:3000"
const [email, pw, chatId, shareToken] = process.argv.slice(2)
if (!email || !pw || !chatId) {
  console.error("usage: node scripts/ui-test-v3-docs.mjs <email> <password> <chatId> [shareToken]")
  process.exit(2)
}
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`)
  if (!cond) failures++
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--no-first-run", "--lang=vi-VN"],
})
try {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  p.setDefaultTimeout(15000)
  p.on("pageerror", (e) => {
    failures++
    console.log("pageerror:", e.message)
  })
  await p.setViewport({ width: 1440, height: 900 })
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]")
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })

  const open = async (theme, vp) => {
    await p.evaluate((t) => (t === "system" ? localStorage.removeItem("nd45-theme") : localStorage.setItem("nd45-theme", t)), theme)
    await p.setViewport(vp)
    await p.goto(`${APP}/c/${chatId}`, { waitUntil: "domcontentloaded" })
    await p.waitForSelector(".doc-vnav", { timeout: 20000 })
    await sleep(600)
  }
  /** The last card with a version switcher (the newest version of the chain). */
  const lastVersioned = () => p.evaluateHandle(() => [...document.querySelectorAll(".doc-card")].filter((c) => c.querySelector(".doc-vnav")).at(-1))

  // 1. card with versions (light, desktop)
  await open("light", { width: 1440, height: 900 })
  let card = await lastVersioned()
  await card.evaluate((c) => c.scrollIntoView({ block: "center" }))
  await sleep(300)
  check((await card.$$(".doc-vchip")).length >= 2, "version chips rendered")
  check(!!(await card.$(".doc-changes li")), "changes summary rendered")
  check(!!(await card.$(".doc-redline")), "redline download button rendered")
  await card.screenshot({ path: path.join(shots, "v3-doc-card-versions-light.png") })
  await p.screenshot({ path: path.join(shots, "v3-doc-chat-light.png") })
  // switch to v1 with the chip → card shows v1 (no changes list, no compare)
  const chips = await card.$$(".doc-vchip")
  await chips[0].click()
  await sleep(250)
  check((await card.$eval(".doc-version", (e) => e.textContent)) === "phiên bản 1", "switcher selects v1")
  check(!(await card.$(".doc-diff-btn")), "v1 has no 'So sánh với bản trước'")
  await card.screenshot({ path: path.join(shots, "v3-doc-card-v1-light.png") })
  await (await card.$$(".doc-vchip")).at(-1).click()
  await sleep(250)

  // 2. diff panel light
  await (await card.$(".doc-diff-btn")).click()
  await p.waitForSelector(".diff-page .diff-text", { timeout: 15000 })
  await sleep(700)
  check((await p.$$(".diff-page ins")).length > 0 && (await p.$$(".diff-page del")).length > 0, "diff shows insertions and deletions")
  const insStyle = await p.$eval(".diff-page ins", (e) => getComputedStyle(e).textDecorationLine)
  const delStyle = await p.$eval(".diff-page del", (e) => getComputedStyle(e).textDecorationLine)
  check(insStyle.includes("underline") && delStyle.includes("line-through"), `ins underline (${insStyle}), del strike (${delStyle})`)
  await p.screenshot({ path: path.join(shots, "v3-doc-diff-light.png") })
  // only changes
  await p.click(".doc-only .switch")
  await sleep(400)
  check((await p.$$(".diff-gap")).length > 0, "'chỉ hiện chỗ thay đổi' collapses unchanged text")
  await p.screenshot({ path: path.join(shots, "v3-doc-diff-only-light.png") })
  // switch the panel back to preview via the tab
  await p.click('.doc-subbar [role="tab"]')
  await p.waitForSelector(".doc-page", { timeout: 10000 })
  check(true, "panel tab switches back to preview")

  // 3. diff panel dark
  await open("dark", { width: 1440, height: 900 })
  card = await lastVersioned()
  await card.evaluate((c) => c.scrollIntoView({ block: "center" }))
  await card.screenshot({ path: path.join(shots, "v3-doc-card-versions-dark.png") })
  await (await card.$(".doc-diff-btn")).click()
  await p.waitForSelector(".diff-page .diff-text")
  await sleep(700)
  await p.screenshot({ path: path.join(shots, "v3-doc-diff-dark.png") })

  // 4. mobile (dark + light)
  for (const theme of ["dark", "light"]) {
    await open(theme, { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    card = await lastVersioned()
    await card.evaluate((c) => c.scrollIntoView({ block: "center" }))
    await sleep(300)
    await p.screenshot({ path: path.join(shots, `v3-doc-card-mobile-${theme}.png`) })
    await (await card.$(".doc-diff-btn")).tap()
    await p.waitForSelector(".diff-page .diff-text")
    await sleep(800)
    const over = await p.evaluate(() => document.scrollingElement.scrollWidth > innerWidth + 1)
    check(!over, `mobile ${theme}: no horizontal overflow`)
    await p.screenshot({ path: path.join(shots, `v3-doc-diff-mobile-${theme}.png`) })
  }

  // 5. imported upload on the user message
  await open("light", { width: 1440, height: 900 })
  const up = await p.$(".user-docs .doc-card")
  if (up) {
    await up.evaluate((c) => c.scrollIntoView({ block: "center" }))
    await sleep(300)
    check(/không giữ định dạng gốc/.test(await up.$eval(".doc-note", (e) => e.textContent)), "upload card shows the format note")
    await p.screenshot({ path: path.join(shots, "v3-doc-upload-card-light.png") })
  } else check(false, "upload doc card on the user message")

  // 6. public share page
  if (shareToken) {
    const sp = await browser.newPage()
    await sp.setViewport({ width: 1280, height: 860 })
    await sp.goto(`${APP}/s/${shareToken}`, { waitUntil: "domcontentloaded" })
    await sp.waitForSelector(".doc-card", { timeout: 15000 })
    await sleep(800)
    const vc = await sp.evaluateHandle(() => [...document.querySelectorAll(".doc-card")].filter((c) => c.querySelector(".doc-diff-btn")).at(-1))
    if (vc && (await vc.evaluate((c) => !!c))) {
      await vc.evaluate((c) => c.scrollIntoView({ block: "center" }))
      await (await vc.$(".doc-diff-btn")).click()
      await sp.waitForSelector(".diff-page .diff-text", { timeout: 10000 })
      await sleep(600)
      check(true, "share page: diff panel opens")
      await sp.screenshot({ path: path.join(shots, "v3-doc-share-diff.png") })
    } else check(false, "share page: versioned card")
  }
} finally {
  await browser.close()
}
console.log(failures ? `${failures} failure(s)` : "all UI checks passed")
process.exit(failures ? 1 : 0)
