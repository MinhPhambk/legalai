// API tests for Admin → tools & skills library (server/library.mjs). Run against a harness, never production:
//   APP_URL=http://127.0.0.1:3107 node scripts/library-api-test.mjs <admin-email> <admin-pw> <user-email> <user-pw>
// Optional: HELPER_DB=<app.db of that harness> to also check the exported helpers against the stored settings.
import assert from "node:assert/strict"

const APP = (process.env.APP_URL || "http://127.0.0.1:3107").replace(/\/$/, "")
const [adminEmail, adminPw, userEmail, userPw] = process.argv.slice(2)
if (!userPw) {
  console.error("usage: node scripts/library-api-test.mjs <admin-email> <admin-pw> <user-email> <user-pw>")
  process.exit(2)
}
let fails = 0
const ok = (name) => console.log("  ✓", name)
async function test(name, fn) {
  try {
    await fn()
    ok(name)
  } catch (e) {
    fails++
    console.log("  ✗", name, "\n     ", e.message)
  }
}

async function login(email, password) {
  const r = await fetch(APP + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: APP }, body: JSON.stringify({ email, password }) })
  assert.equal(r.status, 200, `login ${email}: ${r.status}`)
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
}
const call = async (cookie, method, p, body, locale = "vi") => {
  const r = await fetch(APP + p, {
    method,
    headers: { Cookie: cookie, Origin: APP, "X-UI-Locale": locale, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try {
    data = await r.json()
  } catch {}
  return { status: r.status, data }
}

const admin = await login(adminEmail, adminPw)
const user = await login(userEmail, userPw)

console.log("access")
for (const [m, p, b] of [
  ["GET", "/api/admin/library/tools"],
  ["GET", "/api/admin/library/skills"],
  ["GET", "/api/admin/library/skills/safety"],
  ["PUT", "/api/admin/library/tools/calc_eval", { enabled: false }],
  ["PUT", "/api/admin/library/skills/clarify", { enabled: false }],
  ["GET", "/api/admin/library/log"],
])
  await test(`${m} ${p} → 403 for a normal user`, async () => assert.equal((await call(user, m, p, b)).status, 403))
await test("GET tools → 401 when signed out", async () => assert.equal((await call("", "GET", "/api/admin/library/tools")).status, 401))

console.log("tools")
let tools
await test("GET tools: deduped list, groups, labels data, no runtime wording", async () => {
  const r = await call(admin, "GET", "/api/admin/library/tools")
  assert.equal(r.status, 200, JSON.stringify(r.data))
  tools = r.data.tools
  const names = tools.map((x) => x.name)
  assert.equal(new Set(names).size, names.length, "duplicates")
  for (const n of ["vbpl_article", "calc_eval", "grounding_check", "question"]) assert.ok(names.includes(n), `missing ${n}`)
  for (const n of ["bash", "read", "skill", "invalid"]) assert.ok(!names.includes(n), `should hide ${n}`)
  assert.equal(tools.find((x) => x.name === "vbpl_article").group, "vbpl")
  assert.equal(tools.find((x) => x.name === "fedreg_search").group, "remedy")
  assert.equal(tools.find((x) => x.name === "grounding_check").group, "verify")
  assert.equal(tools.find((x) => x.name === "clock_now").group, "system")
  if (tools.some((x) => x.name === "tariff_us")) assert.equal(tools.find((x) => x.name === "tariff_us").group, "tariff")
  assert.ok(tools.find((x) => x.name === "grounding_check").locked)
  assert.ok(tools.find((x) => x.name === "calc_eval").params.some((p) => p.name === "expression" && p.required))
  assert.ok(!/opencode/i.test(JSON.stringify(r.data)), "runtime name leaked")
  const u = tools.find((x) => x.name === "calc_eval").usage
  assert.ok(u.d7 && u.d30 && "calls" in u.d7 && "errorRate" in u.d30 && "medianMs" in u.d30 && "lastUsed" in u.d30)
})
await test("GET tools includes browser tools (chrome_*)", async () => assert.ok(tools?.some((x) => x.name.startsWith("chrome_") && x.group === "browser")))

await test("PUT locked tool → 400 locked", async () => {
  const r = await call(admin, "PUT", "/api/admin/library/tools/grounding_check", { enabled: false })
  assert.equal(r.status, 400)
  assert.equal(r.data.code, "locked")
})
await test("PUT unknown / invalid tool → 404 / 400", async () => {
  assert.equal((await call(admin, "PUT", "/api/admin/library/tools/no_such_tool", { enabled: false })).status, 404)
  assert.equal((await call(admin, "PUT", "/api/admin/library/tools/Bad-Name", { enabled: false })).status, 400)
  assert.equal((await call(admin, "PUT", "/api/admin/library/tools/calc_eval", { enabled: "no" })).status, 400)
})
await test("PUT calc_eval off → stored, who/when recorded, listed as disabled", async () => {
  const r = await call(admin, "PUT", "/api/admin/library/tools/calc_eval", { enabled: false })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.deepEqual(r.data.disabledTools.includes("calc_eval"), true)
  assert.equal(r.data.changed.by, adminEmail)
  assert.ok(Date.now() - r.data.changed.at < 60_000)
  const l = await call(admin, "GET", "/api/admin/library/tools")
  const t = l.data.tools.find((x) => x.name === "calc_eval")
  assert.equal(t.enabled, false)
  assert.equal(t.changed.enabled, false)
})
await test("PUT chrome_navigate_page off (browser tool)", async () => {
  const r = await call(admin, "PUT", "/api/admin/library/tools/chrome_navigate_page", { enabled: false })
  assert.equal(r.status, 200, JSON.stringify(r.data))
})

console.log("skills")
await test("GET skills: frontmatter name / description, size, modified, locked", async () => {
  const r = await call(admin, "GET", "/api/admin/library/skills")
  assert.equal(r.status, 200)
  const s = r.data.skills
  assert.ok(s.length >= 8)
  const safety = s.find((x) => x.name === "safety")
  assert.ok(safety.locked && safety.description.length > 20 && safety.size > 0 && safety.modified > 0)
  assert.ok(s.find((x) => x.name === "citation-check").locked)
  assert.ok(!s.find((x) => x.name === "clarify").locked)
  assert.ok(!/opencode/i.test(JSON.stringify(r.data)))
})
await test("GET skill content: markdown without frontmatter; path traversal → 404", async () => {
  const r = await call(admin, "GET", "/api/admin/library/skills/contract-review")
  assert.equal(r.status, 200)
  assert.ok(r.data.content.length > 100 && !r.data.content.startsWith("---"))
  assert.equal((await call(admin, "GET", "/api/admin/library/skills/..%2F..%2Fopencode.json")).status, 404)
  assert.equal((await call(admin, "GET", "/api/admin/library/skills/nope-nope")).status, 404)
})
await test("PUT locked skill → 400", async () => assert.equal((await call(admin, "PUT", "/api/admin/library/skills/safety", { enabled: false })).status, 400))
await test("PUT skill clarify off → stored with who/when", async () => {
  const r = await call(admin, "PUT", "/api/admin/library/skills/clarify", { enabled: false })
  assert.equal(r.status, 200)
  assert.ok(r.data.disabledSkills.includes("clarify"))
  assert.equal(r.data.changed.by, adminEmail)
  const l = await call(admin, "GET", "/api/admin/library/log")
  assert.equal(l.data.log[0].name, "clarify")
})

if (process.env.HELPER_DB) {
  console.log("helpers (settings of HELPER_DB)")
  process.env.WEB_DB_PATH = process.env.HELPER_DB
  const lib = await import("../server/library.mjs")
  await test("disabledToolsMap() → { calc_eval: false, chrome_navigate_page: false }", async () => {
    const m = lib.disabledToolsMap()
    assert.equal(m.calc_eval, false)
    assert.equal(m.chrome_navigate_page, false)
    assert.ok(!("grounding_check" in m))
  })
  await test("disabledSkillsNote() names the disabled skill", async () => {
    assert.match(lib.disabledSkillsNote("vi"), /clarify/)
    assert.match(lib.disabledSkillsNote("en"), /clarify/)
  })
  await test("applyLibraryPermissions(): PATCHes the deny rules once, then nothing; undoes stale denies", async () => {
    const calls = []
    let perm = [{ permission: "question", pattern: "*", action: "deny" }] // e.g. left by an old prompt `tools` object
    const fake = {
      request: async (m, p, b) => {
        calls.push([m, p, b])
        if (m === "GET") return { id: "ses_x", permission: perm }
        if (m === "PATCH") perm = [...perm, ...b.permission]
        return {}
      },
    }
    const r1 = await lib.applyLibraryPermissions(fake, "ses_x")
    assert.equal(r1.changed, 4)
    const sent = calls.find((c) => c[0] === "PATCH")[2].permission
    for (const r of [
      { permission: "calc_eval", pattern: "*", action: "deny" },
      { permission: "chrome_navigate_page", pattern: "*", action: "deny" },
      { permission: "question", pattern: "*", action: "allow" },
      { permission: "skill", pattern: "clarify", action: "deny" },
    ])
      assert.ok(sent.some((x) => JSON.stringify(x) === JSON.stringify(r)), `missing ${JSON.stringify(r)}`)
    assert.equal((await lib.applyLibraryPermissions(fake, "ses_x")).changed, 0)
    assert.equal(calls.filter((c) => c[0] === "PATCH").length, 1)
    // extra switches for one request (question tool off by config)
    const r3 = await lib.applyLibraryPermissions(fake, "ses_x", { question: false, grounding_check: false })
    assert.equal(r3.changed, 1, "only question → deny (locked tools ignored)")
    assert.deepEqual(perm.at(-1), { permission: "question", pattern: "*", action: "deny" })
    // AI server down → no throw
    const r4 = await lib.applyLibraryPermissions({ request: async () => { throw new Error("down") } }, "ses_z")
    assert.equal(r4.error, true)
  })
}

console.log("cleanup")
await test("re-enable calc_eval, chrome_navigate_page, clarify", async () => {
  for (const p of ["/api/admin/library/tools/calc_eval", "/api/admin/library/tools/chrome_navigate_page", "/api/admin/library/skills/clarify"])
    assert.equal((await call(admin, "PUT", p, { enabled: true })).status, 200)
  const r = await call(admin, "PUT", "/api/admin/library/skills/clarify", { enabled: true })
  assert.deepEqual(r.data.disabledSkills, [])
})

console.log(fails ? `\n${fails} test(s) failed` : "\nall library API tests passed")
process.exit(fails ? 1 : 0)
