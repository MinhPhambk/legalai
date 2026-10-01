// Assisted browsing – server API test against a harness (never production): the web copy must talk to an AI server
// that runs the real company_lookup tool with assist on and ND45_ASSIST_TEST_URL → tools/assist-fake-site.mjs
// (scratchpad assist-harness.sh). Checks: watcher → `assist` event (owner stream only, no internal ids), list,
// other user / admin → 404 everywhere (list, frame, input, cancel, WebSocket), WebSocket origin check, frames over
// WebSocket and long-poll, input forwarding (click, keys, text) drives the real page → tool continues → official card,
// invalid / disallowed keys dropped, rate limit, navigation guard notice, 410 after the end, cancel, timeout, no frame files.
// Usage: APP_URL=http://127.0.0.1:3111 OUTPUTS=<harness outputs dir> node scripts/assist-test.mjs
//        (users owner@test.vn / other@test.vn / admin@test.vn, passwords Owner-pass-123 / Other-pass-123 / Admin-pass-123)
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const APP = process.env.APP_URL || "http://127.0.0.1:3111"
if (/:3000\b/.test(APP)) throw new Error("refusing to run against production :3000")
const OUTPUTS = process.env.OUTPUTS
const req = createRequire(import.meta.url)
const puppeteer = req("puppeteer-core")
const WS = (await import(req.resolve("ws", { paths: [path.resolve(import.meta.dirname, "../..")] }).replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "file:///$1"))).default
const ok = (s) => console.log(`  ✓ ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LONG = process.env.TIMEOUT_TEST !== "0"

async function login(email, password) {
  const r = await fetch(`${APP}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: APP }, body: JSON.stringify({ email, password }) })
  assert.equal(r.status, 200, `login ${email}`)
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
  const call = async (method, p, body, extra = {}) => {
    const res = await fetch(APP + p, { method, headers: { cookie, Origin: APP, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined })
    return res
  }
  return { cookie, call, json: async (m, p, b) => { const r = await call(m, p, b); return { status: r.status, body: await r.json().catch(() => null) } } }
}
const owner = await login("owner@test.vn", "Owner-pass-123")
const other = await login("other@test.vn", "Other-pass-123")
const admin = await login("admin@test.vn", "Admin-pass-123")

/** Long-poll the chat's event stream in the background; `until(pred)` waits for a matching event. */
function stream(u, chatId) {
  const events = []
  let stop = false
  ;(async () => {
    let after = 0
    while (!stop) {
      const r = await u.call("GET", `/api/chats/${chatId}/poll?after=${after}&wait=10`).catch(() => null)
      if (!r || r.status !== 200) { await sleep(300); continue }
      const d = await r.json()
      events.push(...d.events)
      after = d.next
    }
  })()
  return {
    events,
    stop: () => (stop = true),
    async until(pred, ms = 60000, what = "event") {
      const t0 = Date.now()
      for (;;) {
        const e = events.find(pred)
        if (e) return e
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
        await sleep(100)
      }
    },
  }
}
const newChat = async (text) => {
  const r = await owner.json("POST", "/api/chats", { text })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body.chat.id
}
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${process.env.CHROME_PORT || 9333}`, defaultViewport: null })
/** Where an element of the fake page is, as fractions of the 1200×800 viewport (what a user sees and clicks). */
let currentTarget = null // target id of the request under test (read from its status file – test only)
const targetOf = (aid) => {
  for (const d of fs.readdirSync(OUTPUTS)) {
    const f = path.join(OUTPUTS, d, "assist", aid + ".json")
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).targetId
  }
}
async function fracOf(sel) {
  const t = await browser.waitForTarget((x) => x._targetId === currentTarget, { timeout: 15000 })
  const p = await t.page()
  const b = await p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  return { x: b.x / 1200, y: b.y / 800, page: p }
}
const click = (f) => [{ t: "m", k: "move", x: f.x, y: f.y, b: "none" }, { t: "m", k: "down", x: f.x, y: f.y, b: "left", c: 1 }, { t: "m", k: "up", x: f.x, y: f.y, b: "left", c: 1 }]
const keys = (s) => [...s].flatMap((ch) => [{ t: "k", k: "down", key: ch, code: "", kc: ch.toUpperCase().charCodeAt(0) }, { t: "k", k: "up", key: ch, code: "", kc: ch.toUpperCase().charCodeAt(0) }])

const wsOpenAt = (b, headers) => new Promise((resolve) => {
  const s = new WS(APP.replace(/^http/, "ws") + b + "/ws", { headers })
  s.on("unexpected-response", (_q, res) => resolve({ status: res.statusCode }))
  s.on("open", () => resolve({ status: 101, s }))
  s.on("error", () => resolve({ status: 0 }))
})

// ---------------------------------------------------------------- 1. request → event, list, scoping
console.log("1. assist event, list, access scoping")
const chatA = await newChat("ASSIST tra cứu MST 0100109106")
const evA = stream(owner, chatA)
const ev = await evA.until((e) => e.type === "assist" && e.assist?.status === "waiting_user", 60000, "assist waiting")
const a = ev.assist
assert.match(a.assistId, /^a-\d{8}-[0-9a-f]{8}$/); assert.equal(a.purpose, "company_lookup"); assert.equal(a.source, "gdt"); assert.equal(a.host, "127.0.0.1")
assert.ok(a.expiresAt > a.createdAt); assert.equal(a.openUrl, "http://127.0.0.1:4556/")
for (const k of ["targetId", "contextId", "sessionID", "url"]) assert.equal(a[k], undefined, `no ${k} in the event`)
ok(`assist event on the owner's stream (${a.assistId}), no target / session ids`)
let r = await owner.json("GET", `/api/chats/${chatA}/assist`)
assert.equal(r.status, 200); assert.equal(r.body.assists.length, 1); assert.equal(r.body.assists[0].status, "waiting_user")
ok("GET /assist lists it for the owner")
const base = `/api/chats/${chatA}/assist/${a.assistId}`
currentTarget = targetOf(a.assistId)
for (const [who, u] of [["other user", other], ["admin (not the owner)", admin]]) {
  assert.equal((await u.json("GET", `/api/chats/${chatA}/assist`)).status, 404)
  assert.equal((await u.call("GET", `${base}/frame?after=0&wait=0`)).status, 404)
  assert.equal((await u.json("POST", `${base}/input`, { ev: click({ x: 0.5, y: 0.5 }) })).status, 404)
  assert.equal((await u.json("POST", `${base}/cancel`, {})).status, 404)
  ok(`${who}: list / frame / input / cancel → 404`)
}
const adminView = await admin.json("GET", `/api/admin/chats/${chatA}/messages`)
assert.equal(adminView.status, 200); assert.equal(JSON.stringify(adminView.body).includes(a.assistId), false)
ok("admin read-only viewer: history has no assist / live view")
assert.equal((await owner.json("GET", `/api/chats/${chatA}/assist/a-20000101-00000000/frame`)).status, 404)
assert.equal((await owner.call("GET", `/api/chats/${chatA}/assist/..%2F..%2Fx/frame`)).status, 404)
ok("unknown / malformed assist id → 404")

// ---------------------------------------------------------------- 2. WebSocket: origin + auth, frames
console.log("2. WebSocket live view")
const wsUrl = APP.replace(/^http/, "ws") + `${base}/ws`
const wsOpen = (headers) => new Promise((resolve) => {
  const s = new WS(wsUrl, { headers })
  s.on("unexpected-response", (_q, res) => resolve({ status: res.statusCode }))
  s.on("open", () => resolve({ status: 101, s }))
  s.on("error", () => resolve({ status: 0 }))
})
assert.equal((await wsOpen({ cookie: owner.cookie })).status, 403) // no Origin
assert.equal((await wsOpen({ cookie: owner.cookie, Origin: "https://evil.example" })).status, 403)
assert.equal((await wsOpen({ Origin: APP })).status, 401)
assert.equal((await wsOpen({ cookie: other.cookie, Origin: APP })).status, 404)
assert.equal((await wsOpen({ cookie: admin.cookie, Origin: APP })).status, 404)
ok("WebSocket: missing / foreign Origin → 403, no session → 401, other user / admin → 404")
const w = await wsOpen({ cookie: owner.cookie, Origin: APP })
assert.equal(w.status, 101)
const wsMsgs = []
w.s.on("message", (d, bin) => wsMsgs.push(bin ? { bin: d } : JSON.parse(String(d))))
for (let i = 0; i < 100 && !wsMsgs.some((m) => m.bin); i++) await sleep(100)
const meta = wsMsgs.find((m) => m.type === "meta"), frame = wsMsgs.find((m) => m.bin)
assert.ok(meta && meta.w === 1200 && meta.h === 800, JSON.stringify(meta)); assert.ok(frame && frame.bin[0] === 0xff && frame.bin[1] === 0xd8, "JPEG")
ok(`WebSocket: meta 1200×800 + JPEG frame (${frame.bin.length} B)`)
// long-poll frames
let fr = await owner.call("GET", `${base}/frame?after=0&wait=1500`)
assert.equal(fr.status, 200); assert.equal(fr.headers.get("content-type"), "image/jpeg"); assert.equal(fr.headers.get("x-frame-w"), "1200")
const seq = Number(fr.headers.get("x-frame-seq"))
const t0 = Date.now()
fr = await owner.call("GET", `${base}/frame?after=${seq + 1000}&wait=800`)
assert.ok([204, 200].includes(fr.status)); assert.ok(Date.now() - t0 >= 700 || fr.status === 200)
ok("long-poll frame: 200 image/jpeg with seq / size headers, waits for a newer frame (204 when none)")

// ---------------------------------------------------------------- 3. input forwarding + validation
console.log("3. input forwarding")
assert.equal((await owner.json("POST", `${base}/input`, { ev: new Array(61).fill({ t: "m", k: "move", x: 0.1, y: 0.1 }) })).status, 400)
assert.equal((await owner.json("POST", `${base}/input`, { ev: "x" })).status, 400)
const noCsrf = await fetch(APP + `${base}/input`, { method: "POST", headers: { cookie: owner.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ev: [] }) })
assert.equal(noCsrf.status, 403)
ok("input: > 60 events / non-array → 400, missing Origin (CSRF) → 403")
const cap = await fracOf("#captcha")
const pg = cap.page
// navigation guard through the live view: the user clicks an off-site link → page stays, notice event
const off = await fracOf("#offsite")
w.s.send(JSON.stringify({ t: "in", ev: click(off) }))
const blockedEv = await evA.until((e) => e.type === "assist" && e.assist?.blockedNav >= 1, 15000, "blockedNav")
assert.equal(new URL(pg.url()).host, "127.0.0.1:4556")
ok(`user clicks an off-allowlist link in the live view → blocked, page stays, notice event (blockedNav ${blockedEv.assist.blockedNav})`)
// disallowed keys are dropped: F-keys, Ctrl+T; allowed printable keys arrive
r = await owner.json("POST", `${base}/input`, { ev: [...click(cap), { t: "k", k: "down", key: "F12", kc: 123 }, { t: "k", k: "down", key: "t", kc: 84, mod: 2 }, { t: "m", k: "move", x: 7, y: -3 }, { t: "zz" }] })
assert.equal(r.status, 200); assert.ok(r.body.dropped >= 3, JSON.stringify(r.body))
ok(`click on the code box forwarded; F12, Ctrl+T, garbage dropped (sent ${r.body.sent}, dropped ${r.body.dropped})`)
await sleep(300)
assert.equal(await pg.evaluate(() => document.activeElement?.id), "captcha")
ok("the mirrored page's code box has the focus after the forwarded click")
// type a wrong code with key events over the WebSocket, then fix it with Backspace + text insert (IME / mobile path)
w.s.send(JSON.stringify({ t: "in", ev: keys("ABC") }))
await sleep(500)
assert.equal(await pg.$eval("#captcha", (e) => e.value), "ABC")
w.s.send(JSON.stringify({ t: "in", ev: [0, 1, 2].flatMap(() => [{ t: "k", k: "down", key: "Backspace", code: "Backspace", kc: 8 }, { t: "k", k: "up", key: "Backspace", code: "Backspace", kc: 8 }]) }))
await sleep(400)
assert.equal(await pg.$eval("#captcha", (e) => e.value), "")
const code = await pg.$eval("#capimg", (e) => e.textContent.trim()) // the "user" reads the code off the frame
r = await owner.json("POST", `${base}/input`, { ev: [{ t: "text", v: code }] })
assert.equal(r.status, 200)
await sleep(300)
assert.equal(await pg.$eval("#captcha", (e) => e.value), code)
ok("keys (WebSocket), Backspace, pasted text (HTTP) typed into the real page")
// rate limit: a burst far above 60 / s is cut
const burst = await Promise.all([0, 1, 2, 3, 4].map(() => owner.json("POST", `${base}/input`, { ev: new Array(60).fill({ t: "m", k: "move", x: 0.9, y: 0.9, b: "none" }) })))
const dropped = burst.reduce((n, x) => n + (x.body?.dropped || 0), 0)
assert.ok(dropped > 0, "rate limit")
ok(`rate limit: burst of 300 moves → ${dropped} dropped`)
await sleep(1500)
// press "Tra cứu" with Enter in the code box → the tool continues by itself
w.s.send(JSON.stringify({ t: "in", ev: [{ t: "k", k: "down", key: "Enter", code: "Enter", kc: 13 }, { t: "k", k: "up", key: "Enter", code: "Enter", kc: 13 }] }))
const done = await evA.until((e) => e.type === "assist" && e.assist?.assistId === a.assistId && e.assist.status === "done", 30000, "assist done")
assert.ok(done.assist.doneAt)
const wsStatus = await (async () => { for (let i = 0; i < 50; i++) { const m = wsMsgs.find((x) => x.type === "status" && x.assist?.status === "done"); if (m) return m; await sleep(100) } })()
assert.equal(wsStatus?.assist?.status, "done")
ok("Enter submits the form → assist done event (stream + WebSocket status)")
const toolDone = await evA.until((e) => e.type === "part" && e.part?.tool === "company_lookup" && e.part.status === "completed", 60000, "tool completed")
assert.equal(toolDone.part.card?.basis, "official", JSON.stringify(toolDone.part.card))
assert.equal(toolDone.part.card.company.origin, "official"); assert.equal(toolDone.part.card.assist.status, "done")
assert.match(toolDone.part.card.company.name.v, /CÔNG TY THỬ NGHIỆM ABC/)
ok(`tool continued and parsed the result: card basis official, "${toolDone.part.card.company.name.v}", status ${toolDone.part.card.company.status}`)
await sleep(1500)
assert.equal((await owner.call("GET", `${base}/frame?after=0&wait=0`)).status, 410)
assert.equal((await owner.json("POST", `${base}/input`, { ev: click(cap) })).status, 410)
assert.equal((await wsOpen({ cookie: owner.cookie, Origin: APP })).status, 410)
assert.equal((await browser.targets()).some((t) => t._targetId === currentTarget), false)
ok("after the end: frame / input / WebSocket → 410; the assist tab is closed")
evA.stop()

// ---------------------------------------------------------------- 4. cancel
console.log("4. cancel")
const chatB = await newChat("ASSIST lần 2")
const evB = stream(owner, chatB)
const b = (await evB.until((e) => e.type === "assist" && e.assist?.status === "waiting_user", 60000, "assist waiting")).assist
assert.equal((await other.json("POST", `/api/chats/${chatB}/assist/${b.assistId}/cancel`, {})).status, 404)
r = await owner.json("POST", `/api/chats/${chatB}/assist/${b.assistId}/cancel`, {})
assert.equal(r.status, 200); assert.equal(r.body.assist.status, "cancelled")
await evB.until((e) => e.type === "assist" && e.assist?.assistId === b.assistId && e.assist.status === "cancelled", 10000, "cancelled event")
const tb = await evB.until((e) => e.type === "part" && e.part?.tool === "company_lookup" && e.part.status === "completed", 120000, "tool completed")
assert.notEqual(tb.part.card?.basis, "official"); assert.equal(tb.part.card?.assist?.status, "cancelled")
ok("owner cancels (other user 404) → cancelled event → tool falls back, card assist.cancelled")
evB.stop()

// ---------------------------------------------------------------- 4b. the site rate-limits (HTTP 429 page) + "Thử lại"; WebSocket slots
console.log("4b. official page error (429) + reload; WebSocket slots")
{
  const chatD = await newChat("ASSIST lần 4")
  const evD = stream(owner, chatD)
  const d = (await evD.until((e) => e.type === "assist" && e.assist?.status === "waiting_user", 60000, "assist waiting")).assist
  const baseD = `/api/chats/${chatD}/assist/${d.assistId}`
  currentTarget = targetOf(d.assistId)
  // sockets opened and closed one after another never pile up; 4 at once is the limit
  for (let i = 0; i < 8; i++) { const x = await wsOpenAt(baseD, { cookie: owner.cookie, Origin: APP }); assert.equal(x.status, 101); x.s.close(); await sleep(60) }
  await sleep(300)
  const four = []
  for (let i = 0; i < 4; i++) { const x = await wsOpenAt(baseD, { cookie: owner.cookie, Origin: APP }); assert.equal(x.status, 101); four.push(x.s) }
  assert.equal((await wsOpenAt(baseD, { cookie: owner.cookie, Origin: APP })).status, 429)
  four.forEach((s) => s.close())
  await sleep(300)
  assert.equal((await wsOpenAt(baseD, { cookie: owner.cookie, Origin: APP })).status, 101)
  ok("8 open/close cycles leave no socket behind; the 5th simultaneous view → 429 (logged), a slot frees on close")
  // the user submits and the site answers 429 "Too Many Requests"
  const capD = await fracOf("#captcha")
  await owner.json("POST", `${baseD}/input`, { ev: [...click(capD), { t: "text", v: "LIMIT" }] })
  await sleep(300)
  await owner.json("POST", `${baseD}/input`, { ev: [{ t: "k", k: "down", key: "Enter", code: "Enter", kc: 13 }, { t: "k", k: "up", key: "Enter", code: "Enter", kc: 13 }] })
  const pe = await evD.until((e) => e.type === "assist" && e.assist?.assistId === d.assistId && e.assist.pageError === "rate_limited", 20000, "pageError event")
  assert.equal(pe.assist.status, "waiting_user"); assert.equal(pe.assist.pageStatus, 429)
  ok("site 429 page → assist event pageError rate_limited (HTTP 429), still waiting – not success, not cancel")
  assert.equal((await other.json("POST", `${baseD}/reload`, {})).status, 404)
  await sleep(Math.max(0, d.createdAt + 16_000 - Date.now()))
  r = await owner.json("POST", `${baseD}/reload`, {})
  assert.equal(r.status, 200); assert.ok(r.body.assist.reloadAt)
  const again = await owner.json("POST", `${baseD}/reload`, {})
  assert.equal(again.status, 429); assert.ok(again.body.retryAfter > 0)
  await evD.until((e) => e.type === "assist" && e.assist?.assistId === d.assistId && e.assist.status === "waiting_user" && !e.assist.pageError && e.assist.reloadAt, 30000, "form reloaded")
  ok(`"Thử lại" → the form loads again, error cleared; other user 404; a second reload right away → 429 (retry after ${again.body.retryAfter} s)`)
  await owner.json("POST", `${baseD}/cancel`, {})
  evD.stop()
}

// ---------------------------------------------------------------- 5. timeout (harness started with ASSIST_TIMEOUT=30000)
if (LONG) {
  console.log("5. timeout")
  const chatC = await newChat("ASSIST lần 3")
  const evC = stream(owner, chatC)
  const c = (await evC.until((e) => e.type === "assist" && e.assist?.status === "waiting_user", 60000, "assist waiting")).assist
  const left = c.expiresAt - Date.now()
  await evC.until((e) => e.type === "assist" && e.assist?.assistId === c.assistId && e.assist.status === "timeout", left + 30000, "timeout event")
  ok(`no action for ${(left / 1000).toFixed(0)} s → timeout event`)
  evC.stop()
}

// ---------------------------------------------------------------- 6. nothing stored
if (OUTPUTS) {
  const files = []
  ;(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : files.push(f.name) })(OUTPUTS)
  assert.equal(files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length, 0)
  ok(`no frame image written under the outputs folder (${files.length} files, all request state)`)
}
w.s.close()
browser.disconnect()
console.log("\nALL ASSIST SERVER TESTS PASSED")
process.exit(0)
