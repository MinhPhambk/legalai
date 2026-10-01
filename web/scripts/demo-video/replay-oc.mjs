// Test double for `opencode serve` that REPLAYS real recorded conversations (rec/library.json, exported
// read-only from production) instead of calling a model. A prompt is matched to a recording by regex;
// the recording's assistant messages / parts are re-emitted on the /event bus with compressed timing,
// its generated documents are copied into the new session's output folder and its grounding verdicts
// are appended to the evidence file when the grounding_check step completes.
//   POST /__mode {"mode":"instant"|"video"}  – seeding vs. recording speed
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const PORT = Number(process.env.FAKE_OC_PORT || 4198)
const H = process.env.HARNESS_DIR || "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox/demo-harness" // harness data (never production data)
const LIB = JSON.parse(fs.readFileSync(path.join(H, "rec", "library.json"), "utf8"))
const FOLLOW = fs.existsSync(path.join(H, "rec", "followups.json")) ? JSON.parse(fs.readFileSync(path.join(H, "rec", "followups.json"), "utf8")) : {}
const OUT = process.env.LEGALAI_OUTPUTS_DIR
const EVID = path.join(H, ".sandbox", "cache", "legalai", "evidence")
const DB = path.join(H, "sessions.json")
const sessions = new Map(fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, "utf8")) : [])
setInterval(() => fs.writeFileSync(DB, JSON.stringify([...sessions])), 1000).unref()
const status = new Map()
const clients = new Set()
let mode = "video"
const sleep = (ms) => new Promise((r) => setTimeout(r, mode === "instant" ? 0 : ms))
const rid = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`
const emit = (ev) => {
  for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`)
}
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" })
  res.end(obj === undefined ? "" : JSON.stringify(obj))
}
const body = (req) =>
  new Promise((r) => {
    let s = ""
    req.on("data", (d) => (s += d))
    req.on("end", () => r(s ? JSON.parse(s) : {}))
  })

const pick = (prompt) => Object.entries(LIB).find(([, r]) => new RegExp(r.match, "i").test(prompt))

/** Replays the first turn of a recording into session `sid`. */
async function replay(sid, key) {
  const rec = LIB[key]
  const s = sessions.get(sid)
  s.rec = key
  // Documents: the recording's output folder, copied under the new session id.
  const src = path.join(H, "rec", "outputs", rec.sid)
  if (fs.existsSync(src)) fs.cpSync(src, path.join(OUT, sid), { recursive: true })
  const verdicts = fs.existsSync(path.join(H, "rec", "evidence", `${rec.sid}.jsonl`))
    ? fs.readFileSync(path.join(H, "rec", "evidence", `${rec.sid}.jsonl`), "utf8").split("\n").filter(Boolean)
    : []
  let vi = 0
  status.set(sid, { type: "busy" })
  emit({ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } })
  const firstUser = rec.messages.findIndex((m) => m.info.role === "user")
  const nextUser = rec.messages.findIndex((m, i) => i > firstUser && m.info.role === "user")
  const turn = rec.messages.slice(firstUser + 1, nextUser < 0 ? undefined : nextUser)
  const toolMs = Number(process.env.TOOL_MS || 170)
  for (const m of turn) {
    const mid = rid("msg")
    const info = { ...m.info, id: mid, sessionID: sid, time: { created: Date.now() } }
    delete info.error
    const parts = []
    s.messages.push({ info, parts })
    emit({ type: "message.updated", properties: { info } })
    for (const p0 of m.parts) {
      const part = { ...p0, id: rid("prt"), sessionID: sid, messageID: mid }
      if (part.type === "tool") {
        const final = part.state
        const start = Date.now()
        part.state = { status: "running", input: final.input, time: { start } }
        parts.push(part)
        emit({ type: "message.part.updated", properties: { part } })
        await sleep(part.tool === "document_create" || part.tool === "document_edit" ? toolMs * 5 : part.tool === "grounding_check" ? toolMs * 3 : toolMs)
        part.state = { ...final, time: { start, end: Date.now() } }
        if (part.tool === "grounding_check" && vi < verdicts.length) {
          fs.mkdirSync(EVID, { recursive: true })
          const v = JSON.parse(verdicts[vi++])
          v.at = Date.now()
          fs.appendFileSync(path.join(EVID, `${sid}.jsonl`), JSON.stringify(v) + "\n")
        }
        emit({ type: "message.part.updated", properties: { part } })
        await sleep(60)
      } else if (part.type === "text" && !part.synthetic && part.text.length > 40) {
        const full = part.text
        part.text = ""
        parts.push(part)
        emit({ type: "message.part.updated", properties: { part } })
        const step = Number(process.env.TEXT_CHUNK || 70)
        for (let i = 0; i < full.length; i += step) {
          const delta = full.slice(i, i + step)
          part.text += delta
          if (mode !== "instant") emit({ type: "message.part.delta", properties: { sessionID: sid, messageID: mid, partID: part.id, field: "text", delta } })
          await sleep(28)
        }
        part.text = full
        emit({ type: "message.part.updated", properties: { part } })
      } else {
        parts.push(part)
        emit({ type: "message.part.updated", properties: { part } })
      }
    }
    info.time.completed = Date.now()
    emit({ type: "message.updated", properties: { info } })
    await sleep(120)
  }
  status.set(sid, { type: "idle" })
  emit({ type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } })
  emit({ type: "session.idle", properties: { sessionID: sid } })
}

async function noMatch(sid) {
  const s = sessions.get(sid)
  const mid = rid("msg")
  const info = { id: mid, sessionID: sid, role: "assistant", time: { created: Date.now(), completed: Date.now() }, finish: "stop" }
  s.messages.push({ info, parts: [{ id: rid("prt"), sessionID: sid, messageID: mid, type: "text", text: "(harness: no recording matches this prompt)" }] })
  emit({ type: "message.updated", properties: { info } })
  emit({ type: "session.idle", properties: { sessionID: sid } })
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x")
    const p = u.pathname
    const m = p.match(/^\/session\/([^/]+)(?:\/(\w+))?$/)
    if (p === "/global/health") return json(res, 200, { healthy: true })
    if (p === "/__mode") return (mode = (await body(req)).mode || mode), json(res, 200, { mode })
    if (p === "/config") return json(res, 200, { model: "replay/recorded", provider: { replay: { name: "Replay (tự host)", options: { baseURL: "http://127.0.0.1:1" }, models: { recorded: { name: "Recorded session" } } } } })
    if (p === "/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
      clients.add(res)
      req.on("close", () => clients.delete(res))
      return
    }
    if (p === "/v1/chat/completions" && req.method === "POST") {
      // Follow-up suggestions: the ones recorded / generated once for the matching conversation.
      const b = await body(req)
      const usr = b.messages?.[1]?.content || ""
      const hit = pick(usr)
      const items = (hit && FOLLOW[hit[0]]) || []
      await sleep(900)
      return items.length ? json(res, 200, { choices: [{ message: { role: "assistant", content: JSON.stringify(items) } }] }) : json(res, 500, { error: "none" })
    }
    if (p === "/session/status") return json(res, 200, Object.fromEntries(status))
    if (p === "/session" && req.method === "POST") {
      const b = await body(req)
      const id = rid("ses")
      sessions.set(id, { id, title: b.title, messages: [] })
      return json(res, 200, { id, title: b.title })
    }
    if (/^\/(permission|question)\//.test(p)) return json(res, 200, true)
    if (m) {
      const [, sid, action] = m
      const s = sessions.get(decodeURIComponent(sid))
      if (!s) return json(res, 404, { error: "not found" })
      if (!action && req.method === "DELETE") return sessions.delete(s.id), json(res, 200, true)
      if (action === "message" && req.method === "GET") return json(res, 200, s.messages)
      if (action === "abort") return json(res, 200, true)
      if (action === "prompt_async") {
        const b = await body(req)
        const text = (b.parts || []).map((x) => x.text).join("\n")
        s.messages.push({ info: { id: rid("msg"), sessionID: s.id, role: "user", time: { created: Date.now() } }, parts: [{ id: rid("prt"), sessionID: s.id, type: "text", text }] })
        const hit = pick(text)
        setTimeout(() => (hit ? replay(s.id, hit[0]) : noMatch(s.id)).catch((e) => console.error("replay", e)), 250)
        res.writeHead(204)
        return res.end()
      }
      if (action === "fork") {
        const b = await body(req)
        const i = s.messages.findIndex((x) => x.info.id === b.messageID)
        const id = rid("ses")
        sessions.set(id, { id, title: s.title, messages: JSON.parse(JSON.stringify(i < 0 ? s.messages : s.messages.slice(0, i))) })
        return json(res, 200, { id })
      }
    }
    json(res, 404, { error: "no route " + p })
  })
  .listen(PORT, "127.0.0.1", () => console.log("replay opencode on", PORT, Object.keys(LIB).join(", ")))
