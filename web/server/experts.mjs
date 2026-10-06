// Expert escalations ("Chuyển chuyên gia") and computed confidence (grounding_check verdicts).
//  - The agent's expert_escalate tool writes <ROOT>/.sandbox/escalations/<id>.json. Files are imported
//    idempotently into SQLite, where the workflow lives (status, assignee, replies). Status and replies are
//    written back to the file so the agent-side inbox stays in sync.
//  - grounding_check appends verdicts to <ROOT>/.sandbox/cache/legalai/evidence/<sessionID>.jsonl; the
//    last verdict inside each user turn's time window is that turn's confidence badge.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { ROOT } from "./config.mjs"
import { q, tx } from "./db.mjs"
import { requireUser } from "./auth.mjs"
import { convertHistory, plainText } from "./events.mjs"
import { scrubText } from "./sanitize.mjs"
import { cleanWhy } from "./stepview.mjs"

export const ESC_DIR = path.join(ROOT, ".sandbox", "escalations")
export const EVIDENCE_DIR = path.join(ROOT, ".sandbox", "cache", "legalai", "evidence")
export const STATUSES = ["mới", "đang xử lý", "đã trả lời", "đóng"]
const URGENCIES = ["thấp", "trung bình", "cao", "khẩn"]
const ID_RE = /^YC-\d{8}-\d{3}-[0-9a-f]{4}$/

// ---- grounding verdicts ----------------------------------------------------------------------------
const gCache = new Map() // sid -> { key, verdicts }
function readGrounding(sid) {
  const file = path.join(EVIDENCE_DIR, `${String(sid).replace(/[^\w.-]/g, "_")}.jsonl`)
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return []
  }
  const key = `${st.mtimeMs}:${st.size}`
  const hit = gCache.get(sid)
  if (hit?.key === key) return hit.verdicts
  const verdicts = []
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.includes('"source":"grounding"')) continue // lines of fetched documents can be huge; skip them unparsed
    try {
      const e = JSON.parse(l)
      const v = JSON.parse(e.text)
      verdicts.push({
        level: v.level, reasons: v.reasons || [], why: cleanWhy(v.why, v.reasons), claims: v.claims ?? 0, supported: v.supported ?? 0, unsupported: v.unsupported ?? 0, at: e.at || 0,
        // Server-run checks (grounding.mjs) and the unsupported items (for the THẤP warning).
        ...(v.origin === "server" ? { origin: "server" } : {}),
        ...(Array.isArray(v.items) && v.items.length ? { items: v.items.slice(0, 20).map((x) => scrubText(String(x).slice(0, 300))) } : {}),
        // Per-item results (grounding_check ≥ 07/10/2026): what was checked, matched or not, and where.
        ...(Array.isArray(v.checks) && v.checks.length
          ? {
              checks: v.checks.slice(0, 40).map((c) => ({
                k: ["link", "quote", "figure", "amount", "id"].includes(c?.k) ? c.k : "quote",
                t: scrubText(String(c?.t ?? "").slice(0, 300)),
                ok: !!c?.ok,
                why: String(c?.why ?? "").replace(/[^a-z_]/g, "").slice(0, 16),
                ...(c?.src?.url && /^https?:\/\//.test(c.src.url) ? { src: { title: scrubText(String(c.src.title ?? "").slice(0, 120)), url: String(c.src.url).slice(0, 500) } } : {}),
              })),
            }
          : {}),
        // per-link status of the same check (source cards) and links outside the automatically checkable sources
        ...(Array.isArray(v.links) ? { links: v.links.slice(0, 60).filter((x) => x && typeof x.u === "string" && /^https?:\/\//.test(x.u) && ["ok", "listed", "missing", "external"].includes(x.s)).map((x) => ({ u: x.u.slice(0, 500), s: x.s })) } : {}),
        ...(Number.isInteger(v.unverifiable) && v.unverifiable > 0 ? { unverifiable: v.unverifiable } : {}),
      })
    } catch {}
  }
  gCache.set(sid, { key, verdicts })
  if (gCache.size > 500) gCache.delete(gCache.keys().next().value)
  return verdicts
}

/** Sessions whose history is visible in a branch: its own + ancestors (only what happened before each fork). */
function sessionChain(branch) {
  const out = []
  let limit = Infinity
  for (let b = branch, guard = 0; b && guard < 100; guard++) {
    out.push({ sid: b.opencode_session_id, before: limit })
    limit = Math.min(limit, b.created_at)
    b = b.parent_id ? q("SELECT * FROM branches WHERE id = ?").get(b.parent_id) : null
  }
  return out
}

const turnStarts = (messages) => messages.filter((m) => m.role === "user").map((m) => m.time || 0)
const turnOf = (starts, at) => {
  let k = -1
  for (let i = 0; i < starts.length; i++) if (starts[i] <= at) k = i
  return k
}

/** Last grounding verdict per user turn of the branch's conversation (null = not checked). */
export function groundingForTurns(branch, messages) {
  const verdicts = []
  for (const c of sessionChain(branch)) for (const v of readGrounding(c.sid)) if (v.at < c.before) verdicts.push(v)
  verdicts.sort((a, b) => a.at - b.at)
  const starts = turnStarts(messages)
  const out = starts.map(() => null)
  for (const v of verdicts) {
    const k = turnOf(starts, v.at)
    if (k >= 0) out[k] = v
  }
  return out
}

// ---- escalation files ------------------------------------------------------------------------------
function dayStamp(d = new Date()) {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).replace(/-/g, "")
}
function newEscalationId() {
  const day = dayStamp()
  let files = []
  try {
    files = fs.readdirSync(ESC_DIR).filter((f) => f.startsWith(`YC-${day}-`))
  } catch {}
  const inDb = q("SELECT COUNT(*) AS n FROM escalations WHERE id LIKE ?").get(`YC-${day}-%`).n
  const seq = Math.max(files.length, inDb) + 1
  return `YC-${day}-${String(seq).padStart(3, "0")}-${crypto.randomBytes(2).toString("hex")}`
}
const clean = (s, n) => String(s ?? "").replace(/\u0000/g, "").slice(0, n)

// Server-written escalation texts (Vietnamese in the file, read by people and the agent) → codes / parts the browser
// words in the UI language. Agent-written reasons and summaries are model text (shown as data).
export const MANUAL_REASON = "Người dùng yêu cầu chuyên gia xem lại"
/** Summary written by POST /api/chats/:id/escalate → { note?, question, attachments?, answer? | noAnswer } (null otherwise). */
export function summaryParts(summary) {
  const s = String(summary ?? "")
  const q = s.match(/(?:^|\n\n)Câu hỏi: ([\s\S]*?)(?=\n\n(?:Câu trả lời của trợ lý|Trợ lý chưa có câu trả lời)|$)/)
  if (!q) return null
  let question = q[1]
  let attachments
  const at = question.match(/\nTệp đính kèm: (.*)$/)
  if (at) {
    attachments = at[1].split(", ").filter(Boolean).slice(0, 10)
    question = question.slice(0, at.index)
  }
  const note = s.match(/^Ghi chú của người dùng: ([\s\S]*?)(?=\n\nCâu hỏi: )/)?.[1]
  const answer = s.match(/\n\nCâu trả lời của trợ lý \(rút gọn\):\n([\s\S]*)$/)?.[1]
  return {
    ...(note ? { note } : {}),
    question: question === "(tệp đính kèm)" ? "" : question,
    ...(attachments ? { attachments } : {}),
    ...(answer ? { answer } : { noAnswer: true }),
  }
}

function writeBack(id) {
  const e = q("SELECT * FROM escalations WHERE id = ?").get(id)
  if (!e) return
  const file = path.join(ESC_DIR, `${id}.json`)
  let doc = {}
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {}
  const replies = q("SELECT author_name, text, created_at FROM escalation_replies WHERE escalation_id = ? ORDER BY created_at").all(id)
  const assignee = e.assignee_id ? q("SELECT email, display_name FROM users WHERE id = ?").get(e.assignee_id) : null
  doc = {
    ...doc,
    id,
    sessionID: doc.sessionID ?? e.session_id,
    createdAt: doc.createdAt ?? new Date(e.created_at).toISOString(),
    status: e.status,
    reason: doc.reason ?? e.reason,
    summary: doc.summary ?? e.summary,
    urgency: e.urgency,
    deadline: e.deadline,
    topic: doc.topic ?? e.topic,
    confidence: doc.confidence ?? e.confidence,
    sources: doc.sources ?? JSON.parse(e.sources || "[]"),
    origin: e.origin,
    assignee: assignee ? assignee.display_name || assignee.email : null,
    replies: replies.map((r) => ({ by: r.author_name, text: r.text, at: new Date(r.created_at).toISOString() })),
    updatedAt: new Date(e.updated_at).toISOString(),
  }
  try {
    fs.mkdirSync(ESC_DIR, { recursive: true })
    const tmp = file + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2))
    fs.renameSync(tmp, file)
  } catch (err) {
    console.warn("[experts] write-back failed:", err.message)
  }
}

export function registerExpertRoutes(app, { oc, states, json, chats }) {
  const notify = (chatId) => chatId && chats.hub.broadcast(chatId, { type: "escalation" })

  // Import new agent-side files (idempotent: the id is the primary key).
  function importFile(name) {
    if (!name.endsWith(".json")) return
    const id = name.slice(0, -5)
    if (!ID_RE.test(id) || q("SELECT 1 FROM escalations WHERE id = ?").get(id)) return
    let t
    try {
      t = JSON.parse(fs.readFileSync(path.join(ESC_DIR, name), "utf8"))
    } catch {
      return // partially written – picked up on the next scan
    }
    if (t.id !== id) return
    const branch = t.sessionID ? q("SELECT * FROM branches WHERE opencode_session_id = ?").get(t.sessionID) : null
    const chat = branch ? q("SELECT * FROM chats WHERE id = ?").get(branch.chat_id) : null
    const created = Date.parse(t.createdAt) || Date.now()
    q(
      `INSERT OR IGNORE INTO escalations (id, chat_id, user_id, session_id, origin, status, reason, summary, urgency, deadline, topic, confidence, sources, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, chat?.id ?? null, chat?.user_id ?? null, clean(t.sessionID, 80) || null,
      STATUSES.includes(t.status) ? t.status : "mới", clean(t.reason, 2000), clean(t.summary, 20000),
      URGENCIES.includes(t.urgency) ? t.urgency : "trung bình", t.deadline ? clean(t.deadline, 40) : null, clean(t.topic, 60) || null,
      t.confidence ? clean(t.confidence, 20) : null, JSON.stringify((Array.isArray(t.sources) ? t.sources : []).slice(0, 30).map((u) => clean(u, 500))),
      created, created,
    )
    console.log(`[experts] imported ${id}${chat ? ` (chat ${chat.id})` : " (no web chat)"}`)
    notify(chat?.id)
  }
  const scan = () => {
    try {
      for (const f of fs.readdirSync(ESC_DIR)) importFile(f)
    } catch {}
  }
  fs.mkdirSync(ESC_DIR, { recursive: true })
  scan()
  try {
    fs.watch(ESC_DIR, (_e, f) => f && setTimeout(() => importFile(String(f)), 150))
  } catch {}
  setInterval(scan, 5000).unref() // fs.watch is best effort on Windows

  const isExpert = (u) => u && (u.isExpert || u.isAdmin)
  const requireExpert = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Bạn cần đăng nhập." })
    if (!isExpert(req.user)) return res.status(403).json({ error: "Chỉ chuyên gia mới truy cập được." })
    next()
  }
  const nameOf = (u) => (u ? u.display_name || u.email : null)
  const repliesOf = (id) =>
    q("SELECT id, author_name, text, created_at FROM escalation_replies WHERE escalation_id = ? ORDER BY created_at").all(id).map((r) => ({ id: r.id, author: r.author_name, text: r.text, at: r.created_at }))
  const escOut = (e, extra = {}) => ({
    id: e.id,
    chatId: e.chat_id,
    origin: e.origin,
    status: e.status,
    reason: e.reason,
    ...(e.origin === "manual" && e.reason === MANUAL_REASON ? { reasonCode: "user_request" } : {}),
    summary: e.summary,
    ...(e.origin === "manual" && summaryParts(e.summary) ? { summaryParts: summaryParts(e.summary) } : {}),
    urgency: e.urgency,
    deadline: e.deadline,
    topic: e.topic,
    confidence: e.confidence,
    sources: JSON.parse(e.sources || "[]"),
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    assignee: e.assignee_id ? nameOf(q("SELECT email, display_name FROM users WHERE id = ?").get(e.assignee_id)) : null,
    assigneeId: e.assignee_id,
    ...extra,
  })

  /** Extra data for GET /api/chats/:id/messages: per-turn confidence and this version's escalations. */
  chats.setExtras((chat, branch, messages) => {
    const starts = turnStarts(messages)
    const sids = new Map(sessionChain(branch).map((c) => [c.sid, c.before]))
    const escs = q("SELECT * FROM escalations WHERE chat_id = ? ORDER BY created_at").all(chat.id).filter((e) => sids.has(e.session_id) && e.created_at < sids.get(e.session_id))
    q("UPDATE escalations SET owner_seen_at = ? WHERE chat_id = ?").run(Date.now(), chat.id)
    return {
      grounding: groundingForTurns(branch, messages),
      escalations: escs.map((e) => escOut(e, { turn: turnOf(starts, e.created_at), replies: repliesOf(e.id) })),
    }
  })
  chats.setUnread((userId) => {
    const rows = q(
      `SELECT e.chat_id, COUNT(r.id) AS n FROM escalations e JOIN escalation_replies r ON r.escalation_id = e.id
       WHERE e.user_id = ? AND r.created_at > COALESCE(e.owner_seen_at, 0) GROUP BY e.chat_id`,
    ).all(userId)
    return new Map(rows.map((r) => [r.chat_id, r.n]))
  })

  // ---- owner --------------------------------------------------------------------------------------
  app.post("/api/chats/:id/escalate", requireUser, json, async (req, res) => {
    const chat = q("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user.id)
    if (!chat) return res.status(404).json({ error: "Không tìm thấy cuộc trò chuyện." })
    const urgency = URGENCIES.includes(req.body?.urgency) ? req.body.urgency : "trung bình"
    const note = clean(req.body?.note, 4000).trim()
    const branch = chats.activeBranch(chat)
    let messages = []
    try {
      messages = convertHistory(await oc.request("GET", `/session/${encodeURIComponent(branch.opencode_session_id)}/message`), states.get(branch.opencode_session_id))
    } catch (e) {
      return res.status(503).json({ error: "Không đọc được nội dung cuộc trò chuyện. Thử lại sau.", code: "agent_down" })
    }
    const users = messages.filter((m) => m.role === "user")
    const k = Number.isInteger(req.body?.turn) && req.body.turn >= 0 && req.body.turn < users.length ? req.body.turn : users.length - 1
    if (k < 0) return res.status(400).json({ error: "Cuộc trò chuyện chưa có nội dung." })
    const starts = turnStarts(messages)
    const answerMsgs = messages.filter((m) => m.role === "assistant" && (m.time || 0) >= starts[k] && (k + 1 >= starts.length || (m.time || 0) < starts[k + 1]))
    const answer = answerMsgs.map(plainText).join("\n\n").trim()
    const sources = [...new Set(answerMsgs.flatMap((m) => (m.parts || []).filter((p) => p.source?.url).map((p) => p.source.url)))].slice(0, 20)
    const verdict = groundingForTurns(branch, messages)[k]
    const existing = q("SELECT id FROM escalations WHERE chat_id = ? AND session_id = ? AND created_at >= ? AND status <> 'đóng'").get(chat.id, branch.opencode_session_id, starts[k])
    if (existing) return res.status(409).json({ error: `Câu hỏi này đã được chuyển chuyên gia (${existing.id}).` })
    const id = newEscalationId()
    const now = Date.now()
    const summary = [
      note ? `Ghi chú của người dùng: ${note}` : "",
      `Câu hỏi: ${users[k].text || "(tệp đính kèm)"}${users[k].attachments?.length ? `\nTệp đính kèm: ${users[k].attachments.map((a) => a.name).join(", ")}` : ""}`,
      answer ? `Câu trả lời của trợ lý (rút gọn):\n${answer.slice(0, 2500)}${answer.length > 2500 ? "…" : ""}` : "Trợ lý chưa có câu trả lời.",
    ].filter(Boolean).join("\n\n")
    q(
      `INSERT INTO escalations (id, chat_id, user_id, session_id, origin, status, reason, summary, urgency, deadline, topic, confidence, sources, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', 'mới', ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).run(id, chat.id, req.user.id, branch.opencode_session_id, "Người dùng yêu cầu chuyên gia xem lại", summary, urgency, verdict?.level ?? null, JSON.stringify(sources), Math.max(now, starts[k]), now)
    writeBack(id)
    notify(chat.id)
    res.status(201).json({ escalation: escOut(q("SELECT * FROM escalations WHERE id = ?").get(id), { turn: k, replies: [] }) })
  })

  app.get("/api/escalations", requireUser, (req, res) => {
    const rows = q(`SELECT e.*, c.title AS chat_title FROM escalations e LEFT JOIN chats c ON c.id = e.chat_id WHERE e.user_id = ? ORDER BY e.updated_at DESC LIMIT 200`).all(req.user.id)
    res.json({ escalations: rows.map((e) => escOut(e, { chatTitle: e.chat_title, replies: repliesOf(e.id) })) })
  })

  app.get("/api/notifications", requireUser, (req, res) => {
    const replies = q(
      `SELECT COUNT(r.id) AS n FROM escalations e JOIN escalation_replies r ON r.escalation_id = e.id WHERE e.user_id = ? AND r.created_at > COALESCE(e.owner_seen_at, 0)`,
    ).get(req.user.id).n
    let queue = 0
    if (isExpert(req.user)) {
      const seen = q("SELECT expert_seen_at FROM users WHERE id = ?").get(req.user.id)?.expert_seen_at || 0
      queue = q("SELECT COUNT(*) AS n FROM escalations WHERE status = 'mới' AND created_at > ?").get(seen).n
    }
    res.json({ replies, queue, expertOpen: isExpert(req.user) ? q("SELECT COUNT(*) AS n FROM escalations WHERE status IN ('mới', 'đang xử lý')").get().n : 0 })
  })

  // ---- expert workspace ---------------------------------------------------------------------------
  app.get("/api/expert/escalations", requireExpert, (req, res) => {
    const where = []
    const args = []
    if (STATUSES.includes(req.query.status)) (where.push("e.status = ?"), args.push(req.query.status))
    else if (req.query.status === "open") where.push("e.status IN ('mới', 'đang xử lý')")
    if (URGENCIES.includes(req.query.urgency)) (where.push("e.urgency = ?"), args.push(req.query.urgency))
    if (req.query.mine === "1") (where.push("e.assignee_id = ?"), args.push(req.user.id))
    // Numbered pagination: ?page=1&size=20|50|100
    const size = [20, 50, 100].includes(Number(req.query.size)) ? Number(req.query.size) : 20
    const total = q(`SELECT COUNT(*) AS n FROM escalations e ${where.length ? "WHERE " + where.join(" AND ") : ""}`).get(...args).n
    const pages = Math.max(1, Math.ceil(total / size))
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages)
    const rows = q(
      `SELECT e.*, c.title AS chat_title, u.email AS owner_email, u.display_name AS owner_name,
              (SELECT COUNT(*) FROM escalation_replies r WHERE r.escalation_id = e.id) AS reply_count
       FROM escalations e LEFT JOIN chats c ON c.id = e.chat_id LEFT JOIN users u ON u.id = e.user_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY CASE e.status WHEN 'mới' THEN 0 WHEN 'đang xử lý' THEN 1 WHEN 'đã trả lời' THEN 2 ELSE 3 END,
                CASE e.urgency WHEN 'khẩn' THEN 0 WHEN 'cao' THEN 1 WHEN 'trung bình' THEN 2 ELSE 3 END, e.created_at DESC LIMIT ? OFFSET ?`,
    ).all(...args, size, (page - 1) * size)
    const counts = Object.fromEntries(q("SELECT status, COUNT(*) AS n FROM escalations GROUP BY status").all().map((r) => [r.status, r.n]))
    res.json({ escalations: rows.map((e) => escOut(e, { chatTitle: e.chat_title, owner: e.owner_name || e.owner_email, replyCount: e.reply_count })), counts, total, page, size, pages })
  })

  app.post("/api/expert/seen", requireExpert, (req, res) => {
    q("UPDATE users SET expert_seen_at = ? WHERE id = ?").run(Date.now(), req.user.id)
    res.json({ ok: true })
  })

  const getEsc = (req, res) => {
    const e = q("SELECT * FROM escalations WHERE id = ?").get(String(req.params.id))
    if (!e) res.status(404).json({ error: "Không tìm thấy yêu cầu." })
    return e
  }

  app.get("/api/expert/escalations/:id", requireExpert, async (req, res) => {
    const e = getEsc(req, res)
    if (!e) return
    let messages = []
    if (e.session_id) {
      try {
        messages = convertHistory(await oc.request("GET", `/session/${encodeURIComponent(e.session_id)}/message`), states.get(e.session_id))
      } catch {}
    }
    const owner = e.user_id ? q("SELECT email, display_name FROM users WHERE id = ?").get(e.user_id) : null
    const chat = e.chat_id ? q("SELECT title FROM chats WHERE id = ?").get(e.chat_id) : null
    const branch = e.session_id ? q("SELECT * FROM branches WHERE opencode_session_id = ?").get(e.session_id) : null
    const experts = q("SELECT id, email, display_name FROM users WHERE (is_expert = 1 OR is_admin = 1) AND disabled = 0 ORDER BY email").all()
    res.json({
      escalation: escOut(e, { replies: repliesOf(e.id), owner: owner ? nameOf(owner) : null, ownerEmail: owner?.email || null, chatTitle: chat?.title || null }),
      messages,
      grounding: branch ? groundingForTurns(branch, messages) : [],
      experts: experts.map((u) => ({ id: u.id, name: nameOf(u) })),
    })
  })

  const touch = (id) => {
    q("UPDATE escalations SET updated_at = ? WHERE id = ?").run(Date.now(), id)
    writeBack(id)
    notify(q("SELECT chat_id FROM escalations WHERE id = ?").get(id)?.chat_id)
  }

  app.post("/api/expert/escalations/:id/claim", requireExpert, (req, res) => {
    const e = getEsc(req, res)
    if (!e) return
    q("UPDATE escalations SET assignee_id = ?, status = CASE WHEN status = 'mới' THEN 'đang xử lý' ELSE status END WHERE id = ?").run(req.user.id, e.id)
    touch(e.id)
    res.json({ escalation: escOut(q("SELECT * FROM escalations WHERE id = ?").get(e.id), { replies: repliesOf(e.id) }) })
  })

  app.patch("/api/expert/escalations/:id", requireExpert, json, (req, res) => {
    const e = getEsc(req, res)
    if (!e) return
    if (req.body?.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: "Trạng thái không hợp lệ." })
      q("UPDATE escalations SET status = ? WHERE id = ?").run(req.body.status, e.id)
    }
    if (req.body?.urgency !== undefined && URGENCIES.includes(req.body.urgency)) q("UPDATE escalations SET urgency = ? WHERE id = ?").run(req.body.urgency, e.id)
    if (req.body?.assigneeId !== undefined) {
      const a = req.body.assigneeId ? q("SELECT id FROM users WHERE id = ? AND (is_expert = 1 OR is_admin = 1) AND disabled = 0").get(String(req.body.assigneeId)) : null
      if (req.body.assigneeId && !a) return res.status(400).json({ error: "Người được giao không phải chuyên gia." })
      q("UPDATE escalations SET assignee_id = ? WHERE id = ?").run(a?.id ?? null, e.id)
    }
    touch(e.id)
    res.json({ escalation: escOut(q("SELECT * FROM escalations WHERE id = ?").get(e.id), { replies: repliesOf(e.id) }) })
  })

  app.post("/api/expert/escalations/:id/replies", requireExpert, json, (req, res) => {
    const e = getEsc(req, res)
    if (!e) return
    const text = clean(req.body?.text, 20000).trim()
    if (!text) return res.status(400).json({ error: "Nội dung trả lời trống." })
    const me = q("SELECT email, display_name FROM users WHERE id = ?").get(req.user.id)
    tx(() => {
      q("INSERT INTO escalation_replies (escalation_id, author_id, author_name, text, created_at) VALUES (?, ?, ?, ?, ?)").run(e.id, req.user.id, nameOf(me), text, Date.now())
      q("UPDATE escalations SET status = CASE WHEN status = 'đóng' THEN status ELSE 'đã trả lời' END, assignee_id = COALESCE(assignee_id, ?) WHERE id = ?").run(req.user.id, e.id)
    })
    touch(e.id)
    res.status(201).json({ escalation: escOut(q("SELECT * FROM escalations WHERE id = ?").get(e.id), { replies: repliesOf(e.id) }) })
  })
}
