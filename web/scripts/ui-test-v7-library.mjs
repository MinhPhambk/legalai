// Screenshots of Admin → tools & skills library and the sidebar history (v7) in vi / en, light / dark, desktop / mobile.
// Run against a harness: APP_URL=http://127.0.0.1:3107 node scripts/ui-test-v7-library.mjs <admin> <admin-pw> <user> <user-pw>
// → screenshots/v7-admin-tools-*.png, v7-admin-skills-*.png, v7-admin-skill-view-*.png, v7-sidebar-*.png
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const APP = (process.env.APP_URL || "http://127.0.0.1:3107").replace(/\/$/, "")
const [adminEmail, adminPw, userEmail, userPw] = process.argv.slice(2)
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, args: ["--no-first-run"] })
const shot = (p, name) => p.screenshot({ path: path.join(shots, `${name}.png`) }).then(() => console.log("  ", name))

async function session(email, pw, locale, theme) {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  await p.evaluateOnNewDocument(
    (l, th) => {
      try {
        localStorage.setItem("nd45-locale", l)
        sessionStorage.setItem("nd45-locale-explicit", l)
        localStorage.setItem("nd45-theme", th)
      } catch {}
    },
    locale,
    theme,
  )
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }])
  await p.setViewport({ width: 1440, height: 900 })
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]")
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
  return { p, ctx }
}

for (const locale of ["vi", "en"])
  for (const theme of ["light", "dark"]) {
    const tag = `${locale}-${theme}`
    console.log(tag)
    const { p, ctx } = await session(adminEmail, adminPw, locale, theme)
    for (const [w, h, dev] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
      await p.setViewport({ width: w, height: h, deviceScaleFactor: dev === "mobile" ? 2 : 1, isMobile: dev === "mobile", hasTouch: dev === "mobile" })
      await p.goto(APP + "/admin/library", { waitUntil: "domcontentloaded" })
      await p.waitForSelector(".lib .lib-item", { timeout: 20000 })
      await p.evaluate(() => {
        document.querySelector(".lib .lib-details")?.setAttribute("open", "")
        document.querySelector(".lib").scrollIntoView({ block: "start" })
      })
      await sleep(400)
      await shot(p, `v7-admin-tools-${tag}-${dev}`)
      if (dev === "desktop" && theme === "light") {
        await p.type(".lib-search input", locale === "vi" ? "ty gia" : "exchange")
        await sleep(300)
        await shot(p, `v7-admin-tools-search-${locale}`)
        await p.click(".lib-search input", { clickCount: 3 })
        await p.keyboard.down("Control")
        await p.keyboard.press("KeyA")
        await p.keyboard.up("Control")
        await p.keyboard.press("Backspace")
      }
      await p.click("#lib-tab-skills")
      await p.waitForSelector("#lib-pane-skills .lib-item")
      await p.evaluate(() => document.querySelector(".lib").scrollIntoView({ block: "start" }))
      await sleep(300)
      await shot(p, `v7-admin-skills-${tag}-${dev}`)
      await p.click("#lib-pane-skills .lib-view")
      await p.waitForSelector(".lib-skill-dialog .lib-skill-md")
      await sleep(500)
      await shot(p, `v7-admin-skill-view-${tag}-${dev}`)
      await p.keyboard.press("Escape")
      await sleep(300)
    }
    await ctx.close()

    const u = await session(userEmail, userPw, locale, theme)
    for (const [w, h, dev] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
      await u.p.setViewport({ width: w, height: h, deviceScaleFactor: dev === "mobile" ? 2 : 1, isMobile: dev === "mobile", hasTouch: dev === "mobile" })
      await u.p.goto(APP + "/", { waitUntil: "domcontentloaded" })
      await u.p.waitForSelector(".empty")
      if (await u.p.$eval(".menu-btn", (b) => getComputedStyle(b).display !== "none")) {
        await u.p.click(".menu-btn")
        await sleep(450)
      }
      await u.p.waitForSelector(".chat-list .chat-group", { timeout: 10000 })
      await sleep(300)
      await shot(u.p, `v7-sidebar-${tag}-${dev}`)
      if (await u.p.$(".show-more")) {
        await u.p.click(".show-more")
        await u.p.waitForFunction(() => !document.querySelector(".show-more[aria-busy]"), { timeout: 10000 })
        await u.p.evaluate(() => {
          const l = document.querySelector(".chat-list")
          l.scrollTop = l.scrollHeight
        })
        await sleep(300)
        await shot(u.p, `v7-sidebar-more-${tag}-${dev}`)
      }
    }
    await u.ctx.close()
  }
await browser.close()
