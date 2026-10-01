// Admin console routing: deep links, sub-navigation, back / forward, per-section query kept, lazy section data,
// non-admins redirected. Run against a harness: APP_URL=… node scripts/ui-test-v7-admin-console.mjs <admin> <pw> [<user> <pw>]
// Screenshots → screenshots/v7-admin-console-*.png
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const APP = (process.env.APP_URL || "http://127.0.0.1:3108").replace(/\/$/, "")
const [email, pw, userEmail, userPw] = process.argv.slice(2)
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const check = (ok, msg) => (console.log(ok ? "  ✓" : "  ✗", msg), ok || fails++)
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-first-run"] })

async function login(ctx, e, p, locale = "vi", theme = "light") {
  const page = await ctx.newPage()
  await page.evaluateOnNewDocument((l, th) => {
    try {
      localStorage.setItem("nd45-locale", l)
      sessionStorage.setItem("nd45-locale-explicit", l)
      localStorage.setItem("nd45-theme", th)
    } catch {}
  }, locale, theme)
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }])
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await page.waitForSelector("input[type=email]")
  await page.type("input[type=email]", e)
  await page.type("input[type=password]", p)
  await page.keyboard.press("Enter")
  await page.waitForSelector(".composer textarea", { timeout: 20000 })
  return page
}
const path_ = (p) => p.evaluate(() => location.pathname + location.search)
const active = (p) => p.$eval(".adm-nav-item.on", (a) => a.getAttribute("href")).catch(() => "")

{
  const ctx = await browser.createBrowserContext()
  const p = await login(ctx, email, pw)
  const api = []
  p.on("request", (r) => r.url().includes("/api/admin/") && api.push(new URL(r.url()).pathname))
  await p.goto(APP + "/admin/settings", { waitUntil: "domcontentloaded" })
  await p.waitForSelector(".admin-followups .segmented")
  await sleep(500)
  check(api.every((u) => u === "/api/admin/settings"), `lazy: only settings data loaded on /admin/settings (${[...new Set(api)].join(", ")})`)
  check((await active(p)) === "/admin/settings", "deep link selects the right nav item")
  await p.click('.adm-nav-item[href="/admin/users"]')
  await p.waitForSelector(".admin-table .u-email")
  check((await path_(p)) === "/admin/users", "nav click → /admin/users")
  await p.type("#admin-users .admin-search input", "draft")
  await sleep(500)
  check((await path_(p)) === "/admin/users?q=draft", "users filter kept in the query")
  await p.click('.adm-nav-item[href="/admin/library"]')
  await p.waitForSelector(".lib .lib-item")
  check((await path_(p)) === "/admin/library", "→ /admin/library")
  await p.click('.adm-nav-item[href="/admin/users"]')
  await p.waitForSelector(".admin-table .u-email")
  check((await path_(p)) === "/admin/users?q=draft", "coming back restores the section's query")
  check((await p.$eval("#admin-users .admin-search input", (i) => i.value)) === "draft", "…and the search box")
  await p.goBack()
  await p.waitForSelector(".lib .lib-item")
  check((await active(p)) === "/admin/library", "back → library")
  await p.goForward()
  await p.waitForSelector(".admin-table .u-email")
  check((await active(p)) === "/admin/users", "forward → users")
  // keyboard: arrows move focus inside the sub-navigation, Enter opens
  await p.focus('.adm-nav-item[href="/admin/users"]')
  await p.keyboard.press("ArrowDown")
  check((await p.evaluate(() => document.activeElement.getAttribute("href"))) === "/admin/chats", "ArrowDown moves focus in the sub-navigation")
  await p.keyboard.press("Enter")
  await p.waitForSelector("#admin-chats")
  check((await active(p)) === "/admin/chats", "Enter opens the focused section")
  const r = await p.goto(APP + "/admin/nope", { waitUntil: "domcontentloaded" })
  check(r.status() === 404, "unknown section → 404")
  for (const [k, sel] of [["", ".stats .stat-value"], ["experts", ".adm-card"], ["models", ".adm-model"], ["access-log", "#admin-access-log table"]]) {
    await p.goto(APP + "/admin" + (k ? "/" + k : ""), { waitUntil: "domcontentloaded" })
    await p.waitForSelector(sel, { timeout: 15000 })
    check(true, `/admin${k ? "/" + k : ""} renders`)
  }
  for (const [locale, theme] of [["vi", "light"], ["en", "dark"]]) {
    const c2 = await browser.createBrowserContext()
    const q = await login(c2, email, pw, locale, theme)
    for (const [w, h, dev] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
      await q.setViewport({ width: w, height: h, deviceScaleFactor: dev === "mobile" ? 2 : 1, isMobile: dev === "mobile", hasTouch: dev === "mobile" })
      for (const [k, sel] of [["", ".stats .stat-value"], ["settings", ".admin-followups .segmented"], ["experts", ".adm-card"]]) {
        await q.goto(APP + "/admin" + (k ? "/" + k : ""), { waitUntil: "domcontentloaded" })
        await q.waitForSelector(sel, { timeout: 15000 })
        await sleep(400)
        await q.screenshot({ path: path.join(shots, `v7-admin-console-${k || "overview"}-${locale}-${theme}-${dev}.png`) })
      }
    }
    await c2.close()
  }
  await ctx.close()
}
if (userPw) {
  const ctx = await browser.createBrowserContext()
  const p = await login(ctx, userEmail, userPw)
  await p.goto(APP + "/admin/users", { waitUntil: "domcontentloaded" })
  await sleep(1200)
  check((await path_(p)) === "/", "non-admin on /admin/users → redirected to /")
  await ctx.close()
}
await browser.close()
console.log(fails ? `\n${fails} check(s) failed` : "\nall admin console checks passed")
process.exit(fails ? 1 : 0)
