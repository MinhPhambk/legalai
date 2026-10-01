// Tiny API client for the harness.
export const BASE = process.env.APP_URL || "http://127.0.0.1:3103"
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function login(email = "demo@legalai.local", password = "Demo-Pass-2026!") {
  const r0 = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ email, password }) })
  const cookie = r0.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
  const call = async (m, u, b, h = {}) => {
    const r = await fetch(BASE + u, { method: m, headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/json", ...h }, body: b ? JSON.stringify(b) : undefined })
    const t = await r.text()
    try { return JSON.parse(t) } catch { return t }
  }
  const idle = async (id, want = () => true) => {
    for (let i = 0; i < 200; i++) {
      const h = await call("GET", `/api/chats/${id}/messages`)
      if (!h.busy && h.messages?.some((m) => m.role === "assistant" && m.completed) && want(h)) return h
      await sleep(300)
    }
  }
  return { cookie, call, idle }
}
export const mode = (m) => fetch("http://127.0.0.1:4198/__mode", { method: "POST", body: JSON.stringify({ mode: m }) })
