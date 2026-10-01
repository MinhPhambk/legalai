// Assisted browsing against the REAL tracuunnt.gdt.gov.vn form (sandbox Chrome, 1 page load + 2 wrong-code submits,
// polite gaps). Regression for "typed the code + Enter → error": the input a user produces in the live view is
// replayed through the web server's own translation (web/server/assist.mjs toCdp) and we check what the SITE receives.
// The CAPTCHA is NEVER solved: a deliberately wrong code is typed, so the site answers with its wrong-code message.
//   1. exactly one captcha picture per page load (the picture the user sees is the one the session expects);
//   2. click on the code box → focus there (not in the MST box); typed "abCd9" arrives once, same case, MST untouched;
//   3. Enter in the code box submits the form like the site's "Tra cứu" button (POST with mst + captcha fields);
//   4. the site's message ("Vui lòng nhập đúng mã xác nhận!") is written to the request file (shown in the window),
//      the form is prefilled again, a new picture is loaded, the request keeps waiting;
//   5. the "Tra cứu" button path gives the same result.
// Usage: node tools/test-assist-real.mjs
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

process.env.LEGALAI_OUTPUTS_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "assist-real-"))
const A = await import("../.opencode/lib/assist.ts")
const { assistSpec } = await import("../.opencode/tools/company.ts")
const { toCdp } = await import("../web/server/assist.mjs")
const puppeteer = createRequire(import.meta.url)("puppeteer-core")
const ok = (s) => console.log(`  ✓ ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MST = "0100109106"
const WRONG = "abCd9"

const sid = "real-" + Date.now()
const spec = assistSpec("gdt", MST)
const run = A.requestAssist({ sessionID: sid, purpose: "company_lookup", source: "gdt", timeoutMs: 120_000, ...spec, collect: undefined })
let st
for (let i = 0; i < 300 && !st; i++) {
  const d = path.join(A.outputsRoot(), sid, "assist")
  const f = fs.existsSync(d) && fs.readdirSync(d).find((x) => x.endsWith(".json"))
  if (f) st = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))
  else await sleep(200)
}
assert.ok(st, "assist request written")
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${process.env.CHROME_PORT ?? "9333"}`, defaultViewport: null })
try {
  const target = await browser.waitForTarget((t) => t._targetId === st.targetId)
  const page = await target.page()
  const cdp = await target.createCDPSession()
  await cdp.send("Network.enable")
  const posts = []
  cdp.on("Network.requestWillBeSent", (e) => { if (e.request.method === "POST" && /mstdn\.jsp/.test(e.request.url)) posts.push(new URLSearchParams(e.request.postData || "")) })
  const send = async (evs) => { for (const e of evs) { const c = toCdp(e, { width: 1200, height: 800 }); assert.ok(c, JSON.stringify(e)); await cdp.send(c.method, c.params) } }
  const frac = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: (r.x + r.width / 2) / 1200, y: (r.y + r.height / 2) / 800 } })
  const click = (f) => [{ t: "m", k: "move", ...f, b: "none" }, { t: "m", k: "down", ...f, b: "left", c: 1 }, { t: "m", k: "up", ...f, b: "left", c: 1 }]
  // what AssistPopup sends for a printable key: keydown + keyup with e.key / e.code / keyCode / Shift
  const typed = (s) => [...s].flatMap((ch) => {
    const kc = ch.toUpperCase().charCodeAt(0), code = /\d/.test(ch) ? "Digit" + ch : "Key" + ch.toUpperCase(), mod = /[A-Z]/.test(ch) ? 8 : 0
    return [{ t: "k", k: "down", key: ch, code, kc, mod }, { t: "k", k: "up", key: ch, code, kc, mod }]
  })
  const enter = [{ t: "k", k: "down", key: "Enter", code: "Enter", kc: 13 }, { t: "k", k: "up", key: "Enter", code: "Enter", kc: 13 }]
  const captchaLoads = () => page.evaluate(() => performance.getEntriesByType("resource").filter((e) => /captcha\.png/.test(e.name)).length)
  const values = () => page.evaluate(() => ({ mst: document.querySelector("[name=mst]")?.value, captcha: document.querySelector("#captcha")?.value, active: document.activeElement?.name || document.activeElement?.id }))

  console.log("real tracuunnt.gdt.gov.vn (wrong code on purpose – nothing is solved)")
  assert.equal(await captchaLoads(), 1)
  assert.ok(st.focus && st.focus.w > 200, `focus region incl. the button: ${JSON.stringify(st.focus)}`)
  ok(`one captcha picture per load; focus region ${JSON.stringify(st.focus)} (code box + picture + Tra cứu)`)

  for (const [how, submit] of [["Enter", async () => send(enter)], ["the Tra cứu button", async () => send(click(await frac("input.subBtn")))]]) {
    await send(click(await frac("#captcha")))
    await sleep(300)
    await send(typed(WRONG))
    await sleep(300)
    const v = await values()
    assert.deepEqual(v, { mst: MST, captcha: WRONG, active: "captcha" }, JSON.stringify(v))
    const before = posts.length
    const t0 = Date.now()
    await Promise.all([page.waitForNavigation({ timeout: 30_000 }), submit()])
    await sleep(1500)
    assert.equal(posts.length, before + 1, `${how}: one POST`)
    const body = posts.at(-1)
    assert.equal(body.get("mst"), MST); assert.equal(body.get("captcha"), WRONG)
    const cur = A.readAssist(sid, st.assistId)
    assert.equal(cur.status, "waiting_user")
    assert.match(cur.notice || "", /Vui lòng nhập đúng mã xác nhận/, JSON.stringify(cur.notice))
    assert.ok(cur.noticeAt >= t0)
    const after = await values()
    assert.equal(after.mst, MST, "MST prefilled again"); assert.equal(after.captcha, "")
    assert.equal(await captchaLoads(), 1, "new page, one new picture")
    ok(`${how}: site received mst=${body.get("mst")} captcha=${body.get("captcha")} (typed once, same case) → "${cur.notice}" shown in the window; MST prefilled again, new picture, still waiting`)
    await sleep(2500) // polite gap before the next submit
  }
  A.writeAssist({ ...A.readAssist(sid, st.assistId), status: "cancelled" })
  const r = await run
  assert.equal(r.status, "cancelled")
  ok("cancelled; tab closed")
  console.log("\nREAL-PAGE ASSIST TEST PASSED")
} finally {
  browser.disconnect()
}
