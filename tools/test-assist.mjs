// Assisted browsing (../.opencode/lib/assist.ts): navigation guard (unit), then requestAssist against the local fake
// official page (tools/assist-fake-site.mjs) in the sandbox Chrome ($CHROME_PORT, default 9333): prefill, status file,
// wrong code → still waiting, off-allowlist / internal / file: navigation blocked, popup closed, download denied,
// success → result + collect, context closed; cancel via the status file; timeout; abort signal.
// The "user" is a second CDP client typing into the page, standing in for the web live view.
// Usage: node tools/test-assist.mjs
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

process.env.ND45_ASSIST_TEST = "1"
process.env.LEGALAI_OUTPUTS_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "assist-test-"))
const A = await import("../.opencode/lib/assist.ts")
const { startFakeSite, FAKE_CODE, FAKE_MST } = await import("./assist-fake-site.mjs")
const puppeteer = createRequire(import.meta.url)("puppeteer-core")
const PORT = process.env.CHROME_PORT ?? "9333"
const ok = (s) => console.log(`  ✓ ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 1. guard
console.log("1. navigation guard")
const H = A.ASSIST_HOSTS.company_lookup
const g = (u, k = "main", x = []) => A.guardUrl(u, k, H, x)
assert.equal(g("https://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp").ok, true)
assert.equal(g("https://dichvuthongtin.dkkd.gov.vn/inf/default.aspx").ok, true)
assert.equal(g("https://www.dangkykinhdoanh.gov.vn/vn/Pages/Trangchu.aspx").ok, true)
assert.deepEqual(g("https://evil-gdt.gov.vn.example.com/"), { ok: false, reason: "host" })
assert.deepEqual(g("https://example.com/"), { ok: false, reason: "host" })
assert.deepEqual(g("https://www.google.com/recaptcha/api2/anchor?k=x"), { ok: false, reason: "host" }) // not as the main page
assert.equal(g("https://www.google.com/recaptcha/api2/anchor?k=x", "frame").ok, true)
assert.equal(g("https://www.google.com/search?q=x", "frame").ok, false)
assert.equal(g("https://www.gstatic.com/recaptcha/releases/x/recaptcha__vi.js", "sub").ok, true)
assert.equal(g("https://ssl.google-analytics.com/ga.js", "sub").ok, false)
assert.equal(g("https://fonts.gstatic.com/s/x.woff2", "sub").ok, true)
assert.deepEqual(g("file:///C:/Windows/win.ini"), { ok: false, reason: "scheme" })
assert.deepEqual(g("javascript:alert(1)"), { ok: false, reason: "scheme" })
assert.deepEqual(g("chrome://settings"), { ok: false, reason: "scheme" })
assert.deepEqual(g("data:text/html,x"), { ok: false, reason: "scheme" })
assert.equal(g("data:image/png;base64,xx", "sub").ok, true)
for (const u of ["http://127.0.0.1:3000/", "http://localhost/", "http://10.0.0.5/", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://172.20.0.1/", "http://0.0.0.0/", "http://intranet/", "http://2130706433/"])
  assert.equal(g(u, "sub").ok, false, u)
assert.equal(g("http://127.0.0.1:4555/", "main", ["127.0.0.1:4555"]).ok, true) // test host (ND45_ASSIST_TEST=1)
process.env.ND45_ASSIST_TEST = "0"
assert.equal(g("http://127.0.0.1:4555/", "main", ["127.0.0.1:4555"]).ok, false) // …only in test mode
process.env.ND45_ASSIST_TEST = "1"
ok("official hosts allowed; look-alike, other hosts, reCAPTCHA as main page, trackers, file:/javascript:/chrome:/data: main, internal addresses blocked")
await assert.rejects(A.requestAssist({ sessionID: "s1", url: "https://example.com/", purpose: "company_lookup", successWhen: { selector: "x" } }), /ngoài danh sách/)
await assert.rejects(A.requestAssist({ sessionID: "../x", url: "https://tracuunnt.gdt.gov.vn/", purpose: "company_lookup", successWhen: {} }), /sessionID/)
await assert.rejects(A.requestAssist({ sessionID: "s1", url: "https://tracuunnt.gdt.gov.vn/", purpose: "company_lookup", prefill: [{ selector: "#captcha", value: "x" }], successWhen: {} }), /mã xác thực/)
ok("requestAssist refuses an off-allowlist URL, a bad session id, prefilling a CAPTCHA box")

// ---------------------------------------------------------------- 2. live against the fake page
console.log("2. requestAssist (fake official page, sandbox Chrome)")
const site = await startFakeSite()
const testHosts = [`127.0.0.1:${site.port}`]
const base = (sid, extra = {}) => ({
  sessionID: sid, url: site.url, purpose: "company_lookup", source: "test", testHosts,
  prefill: [{ selector: "input[name='mst']", value: FAKE_MST }],
  successWhen: { selector: "#resultContainer", textIncludes: "Không tìm thấy" }, ...extra,
})
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
const userPage = async (targetId) => (await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 10000 })).page()
const waitFile = async (sid) => {
  for (let i = 0; i < 200; i++) {
    const d = path.join(A.outputsRoot(), sid, "assist")
    const f = fs.existsSync(d) && fs.readdirSync(d).find((x) => x.endsWith(".json"))
    if (f) return JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))
    await sleep(100)
  }
  throw new Error("no assist file")
}

// 2a. wrong code, guard, then the right code
{
  const sid = "t-success-" + Date.now()
  const run = A.requestAssist(base(sid, { collect: async (p) => { await p.click("#nntName"); await sleep(300); return A.pageTables(p) } }))
  const st = await waitFile(sid)
  assert.equal(st.status, "waiting_user"); assert.match(st.assistId, A.ASSIST_ID_RE); assert.ok(st.targetId && st.contextId)
  assert.equal(st.viewport.width, 1200); assert.ok(st.expiresAt - st.createdAt >= 299_000); assert.equal(st.purpose, "company_lookup")
  ok(`status file waiting_user (${st.assistId}, viewport 1200×800, expires in 300 s)`)
  const p = await userPage(st.targetId)
  assert.equal(await p.$eval("#mst", (e) => e.value), FAKE_MST)
  assert.equal(await p.$eval("#captcha", (e) => e.value), "")
  ok("MST prefilled, CAPTCHA box left empty")
  // guard: off-site, internal, file: links, popup, download
  for (const id of ["offsite", "internal", "fileurl"]) {
    await p.click("#" + id).catch(() => {})
    await sleep(700)
    assert.equal(new URL(p.url()).host, `127.0.0.1:${site.port}`, `${id} must be blocked`)
  }
  const pagesBefore = (await browser.pages()).length
  await p.click("#popup"); await sleep(1200)
  assert.equal((await browser.pages()).length, pagesBefore, "popup closed")
  await p.click("#download"); await sleep(800)
  ok("off-allowlist, internal and file: navigations blocked; popup closed; download link inert")
  // wrong code → still waiting, prefill kept after the reload
  await p.type("#captcha", "WRONG"); await Promise.all([p.waitForNavigation(), p.click("#submit")])
  await sleep(1200)
  assert.equal(A.readAssist(sid, st.assistId).status, "waiting_user")
  assert.equal(await p.$eval("#mst", (e) => e.value), FAKE_MST)
  ok("wrong code → still waiting, MST still filled")
  const code = await p.$eval("#capimg", (e) => e.textContent.trim()) // the human reads the code…
  await p.type("#captcha", code); await p.click("#submit") // …types it and presses Tra cứu
  const r = await run
  assert.equal(r.ok, true); assert.equal(r.status, "done")
  assert.match(r.text, /CÔNG TY THỬ NGHIỆM ABC/); assert.match(r.collected, /Tên giám đốc\tNguyễn Văn Thử/)
  assert.ok(r.blocked.some((b) => /main (host|internal) /.test(b)), JSON.stringify(r.blocked))
  assert.ok(r.blocked.some((b) => /^popup closed/.test(b)), JSON.stringify(r.blocked))
  const fin = A.readAssist(sid, st.assistId)
  assert.equal(fin.status, "done"); assert.ok(fin.doneAt)
  await sleep(300)
  assert.equal((await browser.targets()).some((t) => t._targetId === st.targetId), false, "assist tab closed")
  ok(`done → text + collected detail returned, file status done, tab + context closed (blocked: ${r.blocked.length})`)
}

// 2b. cancel through the status file
{
  const sid = "t-cancel-" + Date.now()
  const run = A.requestAssist(base(sid))
  const st = await waitFile(sid)
  const t0 = Date.now()
  A.writeAssist({ ...st, status: "cancelled" })
  const r = await run
  assert.equal(r.status, "cancelled"); assert.equal(r.ok, false); assert.ok(Date.now() - t0 < 3000)
  assert.equal(A.readAssist(sid, st.assistId).status, "cancelled")
  ok(`cancel (status file) → cancelled in ${Date.now() - t0} ms`)
}
// 2c. timeout
{
  const sid = "t-timeout-" + Date.now()
  const t0 = Date.now()
  const r = await A.requestAssist(base(sid, { timeoutMs: 5000 }))
  assert.equal(r.status, "timeout")
  const d = path.join(A.outputsRoot(), sid, "assist")
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, fs.readdirSync(d)[0]), "utf8")).status, "timeout")
  ok(`timeout after ${((Date.now() - t0) / 1000).toFixed(1)} s (5 s + page load)`)
}
// 2d. abort (the chat's Stop button aborts the tool call)
{
  const sid = "t-abort-" + Date.now()
  const ac = new AbortController()
  const run = A.requestAssist(base(sid, { signal: ac.signal }))
  await waitFile(sid)
  ac.abort()
  const r = await run
  assert.equal(r.status, "cancelled")
  ok("abort signal → cancelled")
}
// 2f. the site answers HTTP 429 "Too Many Requests" after the user's submit → pageError, still waiting (not
//     success / cancel); "Thử lại" (reloadAt) loads the form again; a second reload within 15 s is ignored
{
  const sid = "t-429-" + Date.now()
  const run = A.requestAssist(base(sid))
  const st = await waitFile(sid)
  const p = await userPage(st.targetId)
  await p.type("#captcha", "LIMIT")
  await Promise.all([p.waitForNavigation(), p.click("#submit")])
  let cur
  for (let i = 0; i < 40; i++) { cur = A.readAssist(sid, st.assistId); if (cur.pageError) break; await sleep(150) }
  assert.equal(cur.pageError, "rate_limited"); assert.equal(cur.pageStatus, 429); assert.equal(cur.status, "waiting_user"); assert.ok(cur.pageErrorAt)
  ok("site answers 429 → pageError rate_limited (HTTP 429), request keeps waiting")
  await sleep(15_200) // the reload gap counts from the first page load
  A.writeAssist({ ...A.readAssist(sid, st.assistId), reloadAt: Date.now() }) // what POST …/reload writes
  for (let i = 0; i < 60; i++) { cur = A.readAssist(sid, st.assistId); if (!cur.pageError) break; await sleep(200) }
  assert.equal(cur.pageError, undefined); assert.equal(await p.$eval("#mst", (e) => e.value), FAKE_MST); assert.ok(await p.$("#captcha"))
  ok("reload request → the form is loaded again (prefilled), error cleared")
  // the tool writing its own state must never undo a cancel written by the web server in between
  A.writeAssist({ ...A.readAssist(sid, st.assistId), status: "cancelled" })
  A.writeAssist({ ...st, notice: "x" }) // a stale tool-side write (status waiting_user)
  assert.equal(A.readAssist(sid, st.assistId).status, "cancelled")
  const r = await run
  assert.equal(r.status, "cancelled")
  ok("a later tool write keeps the user's cancel (no lost cancel)")
}

// 2e. a context left behind by a killed tool process (expired in the registry) is disposed by the next request
{
  const orphan = await browser.createBrowserContext()
  await orphan.newPage()
  const reg = path.join(A.outputsRoot(), "_assist-contexts.json")
  const cur = fs.existsSync(reg) ? JSON.parse(fs.readFileSync(reg, "utf8")) : {}
  fs.writeFileSync(reg, JSON.stringify({ ...cur, [orphan.id]: Date.now() - 120_000 }))
  const sid = "t-sweep-" + Date.now()
  const run = A.requestAssist(base(sid))
  const st = await waitFile(sid)
  A.writeAssist({ ...st, status: "cancelled" })
  await run
  const { browserContextIds } = await browser._connection.send("Target.getBrowserContexts")
  assert.equal(browserContextIds.includes(orphan.id), false, "orphan disposed")
  assert.deepEqual(JSON.parse(fs.readFileSync(reg, "utf8")), {}, "registry empty after the request")
  ok("expired orphan context disposed by the next request; registry cleaned")
}

// ---------------------------------------------------------------- 3. company_lookup with assist (fake tracuunnt page)
console.log("3. company_lookup / company_verify with the user's help (fake official page)")
process.env.ND45_ASSIST_TEST_URL = site.url
const co = await import("../.opencode/tools/company.ts")
const ev = await import("../.opencode/lib/evidence.ts")
const solveAs = async (sid) => {
  const st = await waitFile(sid)
  const p = await userPage(st.targetId)
  await p.waitForSelector("#captcha")
  await p.type("#captcha", await p.$eval("#capimg", (e) => e.textContent.trim()))
  await p.click("#submit")
  return st
}
{
  const sid = "t-co-" + Date.now()
  const run = co.lookup.execute({ tax_code: FAKE_MST, assist: true }, { sessionID: sid, messageID: "m1" })
  const st = await solveAs(sid)
  assert.equal(st.purpose, "company_lookup"); assert.equal(st.source, "gdt")
  const r = await run
  assert.match(r.output, /XÁC MINH TRÊN NGUỒN CHÍNH THỨC/); assert.match(r.output, /NGUỒN CHÍNH THỨC: Cục Thuế/)
  assert.match(r.output, /Tên doanh nghiệp: CÔNG TY THỬ NGHIỆM ABC/); assert.match(r.output, /Tình trạng: NNT đang hoạt động/)
  assert.match(r.output, /Người đại diện theo pháp luật \(chỉ họ tên\): Nguyễn Văn Thử/); assert.match(r.output, /Địa chỉ trụ sở chính: Số 1 Phố Thử/)
  assert.doesNotMatch(r.output, /001234567890|0241234567/) // personal ID / phone never passed on
  assert.doesNotMatch(r.output, /THAM KHẢO TỪ|Nguồn không chính thức/) // no aggregator when the official source answered
  const card = r.metadata.ui.card
  assert.equal(card.basis, "official"); assert.equal(card.company.origin, "official"); assert.equal(card.company.status, "active")
  assert.equal(card.sources[0].official, true); assert.deepEqual(card.assist, { status: "done", source: "gdt" })
  assert.equal(r.metadata.ui.res.code, "co_active")
  const e = ev.loadEvidence(sid)
  assert.ok(e.some((x) => x.meta?.official === true && x.source === "tracuunnt.gdt.gov.vn" && /CÔNG TY THỬ NGHIỆM ABC/.test(x.text) && !/001234567890/.test(x.text)))
  assert.equal(e.some((x) => x.source === "warning"), false, "no CAPTCHA / aggregator warning → grounding can reach CAO")
  ok("lookup: official record (name, status, address, representative name only), card basis official, evidence under tracuunnt.gdt.gov.vn, no warnings, ID / phone dropped")
}
{
  const sid = "t-cov-" + Date.now()
  const run = co.verify.execute({ tax_code: FAKE_MST, expected_name: "Công ty Thử nghiệm ABC", expected_representative: "Nguyễn Văn Khác", assist: true }, { sessionID: sid, messageID: "m1" })
  await solveAs(sid)
  const r = await run
  const card = r.metadata.ui.card
  assert.equal(card.basis, "official"); assert.equal(card.result, "mismatch")
  assert.equal(card.fields.find((f) => f.field === "representative").result, "mismatch")
  assert.match(r.output, /Theo nguồn chính thức/)
  ok("verify: compared with the official record (representative mismatch → risk)")
}
{
  const sid = "t-cocancel-" + Date.now()
  process.env.ND45_ASSIST_TIMEOUT_MS = "30000"
  const run = co.lookup.execute({ tax_code: FAKE_MST, assist: true }, { sessionID: sid, messageID: "m1" })
  const st = await waitFile(sid)
  A.writeAssist({ ...st, status: "cancelled" })
  const r = await run
  assert.match(r.output, /người dùng đã huỷ bước xác minh/)
  assert.notEqual(r.metadata.ui.card.basis, "official"); assert.deepEqual(r.metadata.ui.card.assist, { status: "cancelled", source: "gdt" })
  ok("cancel → falls back to the manual links / reference sites, output tells the model the check was not completed")
}
{
  delete process.env.ND45_ASSIST
  const sid = "t-cli-" + Date.now()
  const r = await co.lookup.execute({ tax_code: "0100109107" }, { sessionID: sid, messageID: "m1" })
  assert.equal(fs.existsSync(path.join(A.outputsRoot(), sid, "assist")), false)
  ok("CLI default (no ND45_ASSIST) → no assist request")
}
browser.disconnect()
site.server.close()
console.log("\nALL ASSIST TOOL TESTS PASSED")
