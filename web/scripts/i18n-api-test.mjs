// API tests for localization, the hidden prompt lines, document language pass-through and follow-up
// suggestions. Run against an ISOLATED harness (fake opencode), never production:
//   APP_URL=http://127.0.0.1:3102 node scripts/i18n-api-test.mjs
// FAKE_STORE=<fake-sessions.json> enables the raw-prompt check.
// env: A_EMAIL/A_PW (admin), B_EMAIL/B_PW (non-admin). Chats created here are deleted at the end.
import assert from "node:assert/strict"

const BASE = process.env.APP_URL || "http://127.0.0.1:3102"
if (/:3000\b/.test(BASE) && !process.env.I_KNOW) throw new Error("refusing to run against :3000 (production); use the harness")
const A = { email: process.env.A_EMAIL || "alice@test.local", pw: process.env.A_PW || "Test-Pass-123!" }
const B = { email: process.env.B_EMAIL || "bob@test.local", pw: process.env.B_PW || "Test-Pass-123!" }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
const created = []
async function test(name, fn) {
  try {
    await fn()
    pass++
    console.log("✓", name)
  } catch (e) {
    console.error("✗", name, "\n ", e.message)
    process.exitCode = 1
  }
}
async function login(u, headers = {}) {
  const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...headers }, body: JSON.stringify({ email: u.email, password: u.pw }) })
  assert.equal(r.status, 200, `login ${u.email}`)
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
  const call = async (method, url, body, h = {}) => {
    const res = await fetch(BASE + url, { method, headers: { Cookie: cookie, Origin: BASE, ...(body ? { "Content-Type": "application/json" } : {}), ...h }, body: body ? JSON.stringify(body) : undefined })
    const ct = res.headers.get("content-type") || ""
    return { status: res.status, body: ct.includes("json") ? await res.json() : await res.arrayBuffer(), headers: res.headers }
  }
  return call
}
const raw = (method, url, body, headers = {}) =>
  fetch(BASE + url, { method, headers: { Origin: BASE, ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
async function idle(call, id, want = (h) => true) {
  for (let i = 0; i < 80; i++) {
    const h = (await call("GET", `/api/chats/${id}/messages`)).body
    if (!h.busy && h.messages.some((m) => m.role === "assistant" && m.completed) && want(h)) return h
    await sleep(300)
  }
  throw new Error("chat did not settle: " + id)
}

const a = await login(A)
const b = await login(B)
const adminPrev = (await a("GET", "/api/admin/settings")).body

await test("login error localized by Accept-Language (en) with stable code", async () => {
  const r = await raw("POST", "/api/auth/login", { email: "nobody@x.zz", password: "wrong-pass" }, { "Accept-Language": "en-US,en;q=0.9" })
  assert.equal(r.status, 401)
  assert.equal(r.body.error, "Incorrect email or password.")
  assert.equal(r.body.code, "invalid_credentials")
})
await test("login error stays Vietnamese by default / vi Accept-Language", async () => {
  const r = await raw("POST", "/api/auth/login", { email: "nobody@x.zz", password: "wrong-pass" }, { "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.5" })
  assert.equal(r.body.error, "Email hoặc mật khẩu không đúng.")
  assert.equal(r.body.code, "invalid_credentials")
})
await test("X-UI-Locale overrides Accept-Language", async () => {
  const r = await raw("POST", "/api/auth/login", { email: "nobody@x.zz", password: "wrong-pass" }, { "Accept-Language": "en", "X-UI-Locale": "vi" })
  assert.equal(r.body.error, "Email hoặc mật khẩu không đúng.")
})
await test("CSRF error localized", async () => {
  const r = await fetch(BASE + "/api/auth/logout", { method: "POST", headers: { Origin: "https://evil.example", "Accept-Language": "en" } }).then((x) => x.json())
  assert.equal(r.code, "csrf")
  assert.match(r.error, /CSRF/)
  assert.doesNotMatch(r.error, /Yêu cầu/)
})
await test("existing codes are kept (share_revoked / agent codes untouched)", async () => {
  const r = await raw("GET", "/api/public/shares/aaaaaaaaaaaaaaaaaaaaaaaa", undefined, { "Accept-Language": "en" })
  assert.equal(r.status, 404)
  assert.equal(r.body.error, "Share link not found.")
  assert.equal(r.body.state, "notfound")
})
await test("users.locale: save en, reflected in /api/me, invalid value rejected", async () => {
  let r = await b("PUT", "/api/account/settings", { locale: "en" })
  assert.equal(r.status, 200)
  assert.equal(r.body.locale, "en")
  assert.equal((await b("GET", "/api/me")).body.user.locale, "en")
  r = await b("PUT", "/api/account/settings", { locale: "fr" }, { "X-UI-Locale": "en" })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, "invalid_data")
})
await test("user.locale localizes errors when the request has no language header", async () => {
  const r = await b("GET", "/api/chats/c_doesnotexist000")
  assert.equal(r.status, 404)
  assert.equal(r.body.error, "Chat not found.")
  assert.equal(r.body.code, "chat_not_found")
})
await test("dynamic error messages are translated (message too long)", async () => {
  const r = await b("POST", "/api/chats", { text: "x".repeat(20001) }, { "X-UI-Locale": "en" })
  assert.equal(r.status, 413)
  assert.equal(r.body.error, "Message is too long (maximum 20,000 characters).")
  assert.equal(r.body.code, "message_too_long")
})
await test("non-admin cannot change follow-up settings (403, localized)", async () => {
  const r = await b("PATCH", "/api/admin/settings", { followupCount: 2 }, { "X-UI-Locale": "en" })
  assert.equal(r.status, 403)
  assert.equal(r.body.error, "Administrators only.")
})
await test("admin: followupCount accepts 0–5, rejects others", async () => {
  for (const n of [0, 5, 3]) assert.equal((await a("PATCH", "/api/admin/settings", { followupCount: n })).body.followupCount, n)
  for (const bad of [6, -1, 2.5, "x"]) assert.equal((await a("PATCH", "/api/admin/settings", { followupCount: bad })).status, 400)
  assert.equal((await a("GET", "/api/admin/settings")).body.followupCount, 3)
})

let chatEn
await test("prompt carries hidden UI-language + sent-at lines; shown text is clean", async () => {
  const r = await b("POST", "/api/chats", { text: "#tra What is the maximum penalty?" }, { "X-UI-Locale": "en" })
  assert.equal(r.status, 201)
  chatEn = r.body.chat.id
  created.push([b, chatEn])
  const h = await idle(b, chatEn)
  const user = h.messages.find((m) => m.role === "user")
  assert.equal(user.text, "#tra What is the maximum penalty?")
})
await test("hidden lines reach the agent (raw prompt at the fake opencode)", async () => {
  // Find the session through the search index-free route: the branch session id is not exposed, so scan the fake store.
  const fs = await import("node:fs")
  const store = process.env.FAKE_STORE
  if (!store) return console.log("  (skipped: FAKE_STORE not set)")
  await sleep(1200)
  const all = JSON.parse(fs.readFileSync(store, "utf8"))
  const hit = all.map(([, s]) => s).find((s) => s.messages.some((m) => m.info.role === "user" && m.parts.some((p) => p.text?.startsWith("#tra What is the maximum penalty?"))))
  assert.ok(hit, "session found")
  const text = hit.messages.find((m) => m.info.role === "user").parts[0].text
  assert.match(text, /\n\nNgôn ngữ giao diện: en\nThời điểm người dùng gửi: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+07:00 \(Asia\/Ho_Chi_Minh\)$/)
})
await test("tool steps + confidence verdict available for the turn", async () => {
  const h = (await b("GET", `/api/chats/${chatEn}/messages`)).body
  const tools = h.messages.filter((m) => m.role === "assistant").flatMap((m) => m.parts).filter((p) => p.type === "tool")
  assert.ok(tools.some((t) => t.tool === "vbpl_find" && t.result === "3 kết quả"), "server keeps stable step text (client localizes)")
  assert.equal(h.grounding?.[0]?.level, "cao")
})
await test("follow-ups: generated after the answer, N=3, red-flag suggestion removed, in the UI language", async () => {
  const h = await idle(b, chatEn, (x) => x.followups && !x.followups.pending)
  assert.equal(h.followups.turn, 0)
  assert.equal(h.followups.items.length, 3)
  assert.ok(h.followups.items.every((s) => !/evade tax|trốn thuế/i.test(s)))
  assert.ok(h.followups.items.every((s) => /^[\x20-\x7E’–—]+$/.test(s)), "English suggestions")
})
await test("follow-ups are stable across reloads (stored per turn)", async () => {
  const one = (await b("GET", `/api/chats/${chatEn}/messages`)).body.followups.items
  const two = (await b("GET", `/api/chats/${chatEn}/messages`)).body.followups.items
  assert.deepEqual(one, two)
})
await test("follow-ups respect the admin count (2) and 0 disables", async () => {
  await a("PATCH", "/api/admin/settings", { followupCount: 2 })
  let r = await b("POST", "/api/chats", { text: "#tra Hỏi thử" }, { "X-UI-Locale": "vi" })
  created.push([b, r.body.chat.id])
  let h = await idle(b, r.body.chat.id, (x) => x.followups && !x.followups.pending)
  assert.equal(h.followups.items.length, 2)
  assert.ok(h.followups.items.some((s) => /[ăâđêôơư]/i.test(s)), "Vietnamese suggestions")
  await a("PATCH", "/api/admin/settings", { followupCount: 0 })
  r = await b("POST", "/api/chats", { text: "#tra Không gợi ý" })
  created.push([b, r.body.chat.id])
  h = await idle(b, r.body.chat.id)
  await sleep(2000)
  h = (await b("GET", `/api/chats/${r.body.chat.id}/messages`)).body
  assert.equal(h.followups, null)
  await a("PATCH", "/api/admin/settings", { followupCount: 3 })
})
await test("follow-ups: provider failure → none, silently", async () => {
  const r = await b("POST", "/api/chats", { text: "#tra #fufail" })
  created.push([b, r.body.chat.id])
  await idle(b, r.body.chat.id)
  await sleep(2500)
  assert.equal((await b("GET", `/api/chats/${r.body.chat.id}/messages`)).body.followups, null)
})
await test("user can turn follow-ups off (showFollowups=false)", async () => {
  assert.equal((await b("PUT", "/api/account/settings", { showFollowups: false })).body.settings.showFollowups, false)
  const r = await b("POST", "/api/chats", { text: "#tra Tắt gợi ý" })
  created.push([b, r.body.chat.id])
  await idle(b, r.body.chat.id)
  await sleep(2500)
  assert.equal((await b("GET", `/api/chats/${r.body.chat.id}/messages`)).body.followups, null)
  await b("PUT", "/api/account/settings", { showFollowups: true })
})
await test("document language passes through the artifact descriptor (bilingual)", async () => {
  const r = await b("POST", "/api/chats", { text: "#songngu Soạn hợp đồng song ngữ" })
  created.push([b, r.body.chat.id])
  const h = await idle(b, r.body.chat.id)
  const art = h.messages.flatMap((m) => m.parts || []).find((p) => p.artifact)?.artifact
  assert.equal(art?.language, "bilingual")
  const v = (await b("GET", `/api/artifacts/${r.body.chat.id}/${art.id}/versions`)).body
  assert.equal(v.versions.at(-1).language, "bilingual")
})
await test("export (Markdown zip) headings follow the user's locale", async () => {
  const JSZip = (await import("jszip")).default
  const r = await b("GET", "/api/export?format=md")
  assert.equal(r.status, 200)
  const zip = await JSZip.loadAsync(r.body)
  const md = await zip.file(Object.keys(zip.files).find((f) => f.includes(chatEn.slice(2, 8)))).async("string")
  assert.match(md, /## You\n/)
  assert.match(md, /## Assistant\n/)
  assert.match(md, /_Created: /)
  assert.doesNotMatch(md, /Ngôn ngữ giao diện/)
  assert.match(await zip.file("README.txt").async("string"), /LegalAI data export/)
})
await test("upload response flags personal identifiers by category only", async () => {
  const fd = new FormData()
  fd.append("file", new Blob(["Bên A: Nguyễn Văn A, CCCD 079203001234, điện thoại 0912 345 678."]), "pii.txt")
  const r = await fetch(BASE + "/api/uploads", { method: "POST", headers: { Origin: BASE, Cookie: (await loginCookie(B)) }, body: fd }).then((x) => x.json())
  assert.deepEqual(r.upload.pii.sort(), ["cccd", "phone"])
  assert.ok(!JSON.stringify(r).includes("079203001234"))
  await b("DELETE", `/api/uploads/${r.upload.id}`)
})
async function loginCookie(u) {
  const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ email: u.email, password: u.pw }) })
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
}

// ---- cleanup ------------------------------------------------------------------------------------
for (const [call, id] of created) await call("DELETE", `/api/chats/${id}`)
await b("PUT", "/api/account/settings", { locale: "vi" })
await a("PATCH", "/api/admin/settings", { followupCount: adminPrev.followupCount ?? 3 })
console.log(`${pass} passed${process.exitCode ? ", some FAILED" : ""}`)
