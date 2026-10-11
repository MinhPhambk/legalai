// Conversations: chats, version branches (one opencode session per version), live streams,
// search index, pins, read-only share snapshots and export.
import fs from "node:fs"
import JSZip from "jszip"
import { config } from "./config.mjs"
import { FTS, q, tx } from "./db.mjs"
import { newId, parseSettings, reasoningAllowed, requireUser } from "./auth.mjs"
import { scrubText } from "./sanitize.mjs"
import {
  ATTACH_NOTE, EMPTY_TEXT_WITH_FILES, QUESTION_ID_RE, QUESTION_TOOL, attachmentHeader, attachmentSection, convertHistory, plainText, rawUserText, translateEvent,
  parseChangeLine,
} from "./events.mjs"
import { importDocument, inheritSession } from "./docstore.mjs"
import { chatHasDocuments, describeInChat, markArtifactOcr } from "./artifacts.mjs"
import { recordUploadOcrEvidence, uploadOcr } from "./ocr.mjs"
import { accessLog, logAdminAccess } from "./audit.mjs"
import { fmtDateTime, resolveLocale, stripUiLanguage, tr, withUiLanguage } from "./i18n.mjs"
import { followupCount, generateFollowups, storeFollowups, storedFollowups } from "./followups.mjs"
import { activeModelId, promptModel } from "./models.mjs"
import { EventLog, POLL } from "./poll.mjs"
import { applyLibraryPermissions, disabledSkillsNote } from "./library.mjs"
import { groundingForTurns } from "./experts.mjs"
import { weekdayIssues, weekdayPrompt } from "./weekday.mjs"
import { REPAIR_DISABLED, annotateModelVerdict, autoRepairFor, autoRepairOn, finalPrompt, isFinalPrompt, isHiddenPrompt, isRepairPrompt, looksLegal, repairPrompt, reportItems, serverCheck, serverGroundingOn } from "./grounding.mjs"

/** One `system` line per run: without it the model mostly writes its clarifying questions as text (docs/QUESTION_TOOL.md §5). */
const CLARIFY_SYSTEM = {
  vi: "Nếu thiếu thông tin quan trọng làm thay đổi hẳn kết quả, hãy gọi công cụ question (skill clarify) để hỏi người dùng bằng lựa chọn, tối đa 3 câu.",
  en: "If important information that would substantially change the result is missing, call the question tool (skill clarify) to ask the user with options, at most 3 questions.",
}

export function makeTitle(text, attachments = [], locale = "vi") {
  const t = String(text || "").replace(/\s+/g, " ").trim()
  if (!t) return attachments.length ? tr(locale, "fileTitle", { name: attachments[0].name }).slice(0, 60) : tr(locale, "newChat")
  if (t.length <= 60) return t
  const cut = t.slice(0, 60)
  const sp = cut.lastIndexOf(" ")
  return (sp > 30 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "") + "…"
}

const fold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()

/** Opaque keyset cursor: base64url("<timestamp>:<id>"). */
export const encodeCursor = (t, id) => Buffer.from(`${t}:${id}`).toString("base64url")
export function decodeCursor(c) {
  if (!c || typeof c !== "string" || c.length > 200) return null
  const s = Buffer.from(c, "base64url").toString("utf8")
  const i = s.indexOf(":")
  const t = Number(s.slice(0, i))
  return i > 0 && Number.isFinite(t) ? { t, id: s.slice(i + 1) } : null
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

// ---- version tree -------------------------------------------------------------------------------
const branchesOf = (chatId) => q("SELECT * FROM branches WHERE chat_id = ? ORDER BY created_at, rowid").all(chatId)

/** Number of leading user turns two branches have in common (tree path, min of fork turns). */
function sharedPrefix(bmap, a, b) {
  if (a === b) return Infinity
  const chain = (id) => {
    const out = []
    for (let cur = bmap.get(id), guard = 0; cur && guard < 1000; cur = cur.parent_id ? bmap.get(cur.parent_id) : null, guard++) out.push(cur)
    return out
  }
  const ca = chain(a)
  const cb = chain(b)
  const idxB = new Map(cb.map((x, i) => [x.id, i]))
  const ia = ca.findIndex((x) => idxB.has(x.id))
  if (ia < 0) return 0
  const ib = idxB.get(ca[ia].id)
  let m = Infinity
  for (let i = 0; i < ia; i++) m = Math.min(m, ca[i].fork_turn ?? 0)
  for (let i = 0; i < ib; i++) m = Math.min(m, cb[i].fork_turn ?? 0)
  return m
}

/**
 * For the active branch X and each of its user turns k: the alternative versions of turn k.
 * Two branches show the same version of turn k when they share turns 0..k; a version is represented
 * by its most recently visited branch.
 */
export function computeVersions(branches, activeId) {
  const bmap = new Map(branches.map((b) => [b.id, b]))
  const X = bmap.get(activeId)
  if (!X) return []
  const out = []
  for (let k = 0; k < (X.turns || 0); k++) {
    const cands = branches.filter((b) => (b.turns || 0) > k && sharedPrefix(bmap, X.id, b.id) >= k)
    const classes = []
    for (const b of cands) {
      const c = classes.find((cl) => sharedPrefix(bmap, cl[0].id, b.id) >= k + 1)
      if (c) c.push(b)
      else classes.push([b])
    }
    if (classes.length < 2) continue
    const index = classes.findIndex((cl) => cl.some((b) => b.id === X.id))
    const targets = classes.map((cl) => (cl.some((b) => b.id === X.id) ? X.id : [...cl].sort((a, b) => b.visited_at - a.visited_at)[0].id))
    // Was this turn re-asked with different text (edit) or only re-answered (regenerate)?
    const edited = classes.some((cl) => cl.some((b) => b.fork_turn === k && b.kind === "edit"))
    out.push({ turn: k, index: index + 1, total: classes.length, targets, kind: edited ? "edit" : "regenerate" })
  }
  return out
}

// ---- live streams: one SSE connection follows the chat's *active* branch -------------------------
class ChatHub {
  constructor(oc, states) {
    this.oc = oc
    this.states = states
    this.conns = new Map() // chatId -> Set<conn>
  }
  add(chatId, conn) {
    let set = this.conns.get(chatId)
    if (!set) this.conns.set(chatId, (set = new Set()))
    set.add(conn)
  }
  remove(chatId, conn) {
    const set = this.conns.get(chatId)
    set?.delete(conn)
    if (set && !set.size) this.conns.delete(chatId)
  }
  /** Re-point every open stream of the chat at another branch's session. */
  switchTo(chatId, branchId, sid) {
    for (const conn of this.conns.get(chatId) || []) conn.follow(sid, branchId)
  }
  broadcast(chatId, obj) {
    for (const conn of this.conns.get(chatId) || []) conn.send(obj)
  }
  count() {
    let n = 0
    // Long-poll logs count only while being polled (they outlive their viewer by a few minutes).
    for (const s of this.conns.values()) for (const c of s) if (c.live !== false) n++
    return n
  }
}

export function registerChatRoutes(app, { oc, states, json, upstreamError }) {
  const hub = new ChatHub(oc, states)

  // Runs we started and that have not reached idle yet (double-submit guard + admin stats).
  const runs = new Map() // sessionID -> { at, sawBusy, chatId }
  oc.onAny((ev, sid) => {
    if (!sid) return
    const r = runs.get(sid)
    if (ev.type === "session.status") {
      const idle = ev.properties?.status?.type === "idle"
      if (r) {
        if (idle && (r.sawBusy || Date.now() - r.at > 1500)) {
          runs.delete(sid)
          afterRun(sid, r)
        } else if (!idle) r.sawBusy = true
      }
      if (idle) scheduleIndex(sid)
    }
    if (ev.type === "permission.asked" && ev.properties?.id) {
      if (branchBySession(sid)) oc.request("POST", `/permission/${ev.properties.id}/reply`, { reply: "reject" }).catch(() => {})
    } else if (!config.questionTool && (ev.type === "question.asked" || ev.type === "question.v2.asked") && ev.properties?.id) {
      // Question cards turned off: never leave a run blocked on a question nobody can answer.
      if (branchBySession(sid)) oc.request("POST", `/question/${ev.properties.id}/reject`).catch(() => {})
    }
  })
  setInterval(() => {
    for (const [sid, r] of runs) if (Date.now() - r.at > 60 * 60_000) runs.delete(sid)
  }, 60_000).unref()

  const branchBySession = (sid) => q("SELECT * FROM branches WHERE opencode_session_id = ?").get(sid)

  /** A run we started reached idle: server grounding (may start a repair run), then follow-up suggestions. */
  async function afterRun(sid, run) {
    let items = null
    try {
      items = await oc.request("GET", `/session/${encodeURIComponent(sid)}/message`)
      if (await autoFinal(sid, run, items)) return // empty final answer: one "write it now" run first, grounding after it
      if (await autoGround(sid, run, items)) return // a repair run started: suggestions come after it
    } catch (e) {
      console.warn("[grounding]", e.message)
    }
    runFinished(sid, run, items).catch((e) => console.warn("[followups]", e.message))
  }

  // ---- empty final answer ------------------------------------------------------------------------------
  // The model sometimes ends a run with an empty final message (typically after chrome_* / web_* calls). Then one
  // hidden synthetic prompt (FINAL_MARK) asks it to write the answer now – at most once per user turn; the
  // grounding check / repair runs on its result. Still empty → the client shows "no answer yet" + the expert button.
  const finalAt = new Map() // sessionID -> time the hidden final-answer prompt was sent
  const visibleText = (m) => (m.parts || []).some((p) => p.type === "text" && !p.synthetic && !p.ignored && String(p.text || "").trim())
  /** Returns true when a final-answer run was started. */
  async function autoFinal(sid, run, items) {
    const branch = branchBySession(sid)
    if (!branch || !items?.length || run.final) return false
    let lastUser = -1
    for (let i = items.length - 1; i >= 0; i--) if (items[i].info?.role === "user" && !isHiddenPrompt(items[i])) {
      lastUser = i
      break
    }
    if (lastUser < 0) return false
    const turn = items.slice(lastUser + 1)
    if (turn.some(isFinalPrompt)) return false // already asked once this turn
    // The latest segment (after a hidden repair prompt, if any) decides.
    const ri = turn.map((m, i) => (isHiddenPrompt(m) ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1
    const tail = turn.slice(ri + 1).filter((m) => m.info?.role === "assistant")
    if (!tail.length || tail.some((m) => m.info?.error)) return false // failed or stopped by the user
    // Only text written AFTER the last tool call is an answer: a short note before the look-ups ("Tôi sẽ tra…") is not.
    const lastTool = tail.map((m, i) => ((m.parts || []).some((p) => p.type === "tool") ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1
    const afterTools = tail.slice(lastTool + 1)
    const lastToolMsg = lastTool >= 0 ? tail[lastTool] : null
    // text in the same message after its last tool part counts too
    const textAfterLastToolPart = lastToolMsg ? (() => { const ps = lastToolMsg.parts || []; const k = ps.map((p, i) => (p.type === "tool" ? i : -1)).filter((i) => i >= 0).at(-1); return ps.slice(k + 1).some((p) => p.type === "text" && !p.synthetic && !p.ignored && String(p.text || "").trim()) })() : false
    if (afterTools.some(visibleText) || textAfterLastToolPart || (lastTool < 0 && tail.some(visibleText))) return false
    // A run that stopped on a clarifying question is not "empty".
    if (tail.some((m) => (m.parts || []).some((p) => p.type === "tool" && p.tool === "question"))) return false
    const locale = run.locale || "vi"
    const model = promptModel()
    const k = items.slice(0, lastUser + 1).filter((m) => m.info?.role === "user" && !isHiddenPrompt(m)).length - 1
    finalAt.set(sid, Date.now())
    runs.set(sid, { ...run, at: Date.now(), sawBusy: false, final: true })
    try {
      await oc.request("POST", `/session/${encodeURIComponent(sid)}/prompt_async`, {
        agent: config.agent,
        ...(model ? { model } : {}),
        parts: [{ type: "text", text: finalPrompt(locale), synthetic: true }],
        ...(await libraryPromptFields(sid, locale)),
      })
    } catch (e) {
      runs.delete(sid)
      finalAt.delete(sid)
      throw e
    }
    console.log(`[final] empty final answer in ${sid} (turn ${k}): asked for the answer once`)
    hub.broadcast(branch.chat_id, { type: "finalizing", branchId: branch.id, turn: k })
    return true
  }

  // ---- server-enforced grounding (see grounding.mjs) -------------------------------------------------
  const repairAt = new Map() // sessionID -> time the hidden repair prompt was sent (live messages after it are "repair")
  /** The latest user turn of a session's raw items: { k, repaired, tail (assistant messages after the repair prompt, if any), answer } or null. */
  function lastTurnOf(items) {
    let lastUser = -1
    for (let i = (items?.length || 0) - 1; i >= 0; i--)
      if (items[i].info?.role === "user" && !isHiddenPrompt(items[i])) {
        lastUser = i
        break
      }
    if (lastUser < 0) return null
    const turn = items.slice(lastUser + 1)
    const ri = turn.findIndex(isRepairPrompt)
    const repaired = ri >= 0
    const tail = (repaired ? turn.slice(ri + 1) : turn).filter((m) => m.info?.role === "assistant")
    const answer = tail.flatMap((m) => (m.parts || []).filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text || "")).join("\n\n").trim()
    const k = items.slice(0, lastUser + 1).filter((m) => m.info?.role === "user" && !isHiddenPrompt(m)).length - 1
    return { k, repaired, tail, answer }
  }
  /** Returns true when a repair run was started. */
  async function autoGround(sid, run, items) {
    const branch = branchBySession(sid)
    if (!branch || !items?.length) return false
    // The latest user turn (raw items), and the part after a hidden repair prompt if there is one.
    const lt = lastTurnOf(items)
    if (!lt) return false
    const { k, repaired, tail, answer } = lt
    if (!tail.length || tail.some((m) => m.info?.error)) return false // failed or stopped
    if (!answer) return false
    // A weekday that does not match its date ("Thứ Bảy, 04/10/2026" for a Sunday) is fixed once per user turn,
    // independent of the opt-in grounding repair: it is a deterministic error and the rewrite needs no look-ups.
    if (!repaired) {
      const wd = weekdayIssues(answer)
      if (wd.length) {
        console.log(`[weekday] ${sid} turn ${k}: ${wd.map((x) => `${x.date} said ${x.said}, is ${x.actualVi}`).join("; ")} – asking for a correction`)
        return startRepair(sid, run, branch, k, { level: "weekday", items: [], origin: "weekday" }, false, weekdayPrompt(wd, run.locale || "vi"))
      }
    }
    const checks = tail.flatMap((m) => m.parts || []).filter((p) => p.type === "tool" && p.tool === "grounding_check" && p.state?.status === "completed")
    let verdict = null
    if (checks.length) {
      // The model checked itself: its last report decides.
      const out = String(checks.at(-1).state.output || "")
      const level = (out.match(/ĐỘ TIN CẬY[^:]*:\s*([^\n]+)/)?.[1] || "").trim().toLowerCase()
      verdict = { level, items: reportItems(out), origin: "model" }
      if (level === "thấp" && verdict.items.length) await annotateModelVerdict(sid, verdict.items).catch(() => {})
    } else if (serverGroundingOn() && looksLegal(answer)) {
      verdict = await serverCheck(sid, answer)
      if (verdict) {
        console.log(`[grounding] server check ${sid}: ${verdict.level} (${verdict.unsupported}/${verdict.claims} unsupported)`)
        hub.broadcast(branch.chat_id, { type: "confidence", branchId: branch.id, turn: k, level: verdict.level, origin: "server" })
      }
    }
    if (!verdict || verdict.level !== "thấp" || repaired) return false
    // Opt-in: only when the admin allows it AND the chat owner switched it on (enforced here, never by the client).
    const owner = q("SELECT user_id FROM chats WHERE id = ?").get(branch.chat_id)?.user_id
    if (!autoRepairFor(owner)) return false
    return startRepair(sid, run, branch, k, verdict)
  }
  /** One repair per user turn (automatic or "Tra lại ngay"): a hidden (synthetic) prompt in the same session. */
  async function startRepair(sid, run, branch, k, verdict, manual = false, text = null) {
    const locale = run.locale || "vi"
    const model = promptModel()
    repairAt.set(sid, Date.now())
    runs.set(sid, { ...run, at: Date.now(), sawBusy: false, repair: true })
    try {
      await oc.request("POST", `/session/${encodeURIComponent(sid)}/prompt_async`, {
        agent: config.agent,
        ...(model ? { model } : {}),
        parts: [{ type: "text", text: text || repairPrompt(verdict.items || [], locale), synthetic: true }],
        ...(await libraryPromptFields(sid, locale)),
      })
    } catch (e) {
      runs.delete(sid)
      repairAt.delete(sid)
      throw e
    }
    console.log(`[grounding] ${manual ? "on-demand" : "automatic"} repair turn started for ${sid} (turn ${k}, ${verdict.origin} verdict ${verdict.level})`)
    hub.broadcast(branch.chat_id, { type: "repair", branchId: branch.id, turn: k })
    return true
  }

  // ---- follow-up suggestions (see followups.mjs) -----------------------------------------------------
  const pendingFollowups = new Map() // sessionID -> { turn, count }
  async function runFinished(sid, run, prefetched = null) {
    const n = followupCount()
    const branch = branchBySession(sid)
    if (!n || !branch) return
    const owner = q("SELECT settings FROM users WHERE id = ?").get(run.userId)
    if (owner && parseSettings(owner.settings).showFollowups === false) return
    const items = prefetched || (await oc.request("GET", `/session/${encodeURIComponent(sid)}/message`))
    const msgs = convertHistory(items, states.get(sid))
    const users = msgs.filter((m) => m.role === "user")
    const k = users.length - 1
    if (k < 0 || storedFollowups(sid, k)) return
    const lastUser = msgs.lastIndexOf(users[k])
    const replies = msgs.slice(lastUser + 1)
    if (!replies.length || replies.some((m) => m.error || m.aborted)) return // failed or stopped: no suggestions
    const answer = plainText(replies.at(-1))
    if (!answer) return
    const done = { type: "followups", branchId: branch.id, turn: k }
    pendingFollowups.set(sid, { turn: k, count: n })
    hub.broadcast(branch.chat_id, { ...done, pending: true, count: n })
    let list = []
    try {
      // Same model as the answer (the one the run was sent with).
      list = await generateFollowups({ fullModel: run.model || activeModelId(), question: stripUiLanguage(users[k].text).split(ATTACH_NOTE)[0], answer, locale: run.locale, n })
      list = list.map((x) => scrubText(x, run.locale))
      if (q("SELECT 1 FROM chats WHERE id = ?").get(branch.chat_id)) storeFollowups(sid, k, branch.chat_id, run.locale, list)
    } finally {
      pendingFollowups.delete(sid)
      hub.broadcast(branch.chat_id, { ...done, items: list })
    }
  }
  /** Suggestions for the latest turn of a branch (null when none / not applicable). */
  function followupsFor(sid, users) {
    const k = users - 1
    if (k < 0) return null
    const p = pendingFollowups.get(sid)
    if (p && p.turn === k) return { turn: k, pending: true, count: p.count }
    const items = storedFollowups(sid, k)
    return items?.length ? { turn: k, items: items.map((x) => scrubText(x)) } : null
  }
  const activeBranch = (chat) =>
    (chat.active_branch_id && q("SELECT * FROM branches WHERE id = ? AND chat_id = ?").get(chat.active_branch_id, chat.id)) ||
    q("SELECT * FROM branches WHERE chat_id = ? ORDER BY created_at LIMIT 1").get(chat.id)

  const remoteBusy = async (sid) => {
    try {
      const st = await oc.request("GET", "/session/status", undefined, { timeoutMs: 5000 })
      const s = st?.[sid]
      return !!s && s.type !== "idle"
    } catch {
      return states.get(sid).status !== "idle"
    }
  }
  const sessionBusy = async (sid) => {
    const r = runs.get(sid)
    if (r && Date.now() - r.at < 30 * 60_000) return true
    return remoteBusy(sid)
  }
  const chatBusy = async (chatId) => {
    const all = branchesOf(chatId)
    if (all.some((b) => runs.has(b.opencode_session_id))) return true
    try {
      const st = await oc.request("GET", "/session/status", undefined, { timeoutMs: 5000 })
      return all.some((b) => st?.[b.opencode_session_id] && st[b.opencode_session_id].type !== "idle")
    } catch {
      return false
    }
  }

  let extras = () => ({})
  let unreadOf = () => new Map()
  const chatOut = (c, unread = 0) => ({ id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at, pinned: !!c.pinned_at, pinnedAt: c.pinned_at || null, unread })
  const ownChat = (req) => {
    const chat = q("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user.id)
    if (!chat) throw new HttpError(404, "Không tìm thấy cuộc trò chuyện.")
    return chat
  }
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) })
      if (e.status || e.cause || /fetch failed|opencode/i.test(e.message)) return upstreamError(res, e)
      console.error("[chats]", e)
      res.status(500).json({ error: "Lỗi máy chủ." })
    }
  }

  // ---- prompt building ---------------------------------------------------------------------------
  /** Validate the message and resolve its attachments (only the user's own uploads). */
  function checkPrompt(req, text, attachmentIds) {
    text = String(text || "").replace(/\r\n?/g, "\n").trim()
    if (text.length > config.maxMessageChars) throw new HttpError(413, `Tin nhắn quá dài (tối đa ${config.maxMessageChars.toLocaleString("vi-VN")} ký tự).`)
    const ids = Array.isArray(attachmentIds) ? [...new Set(attachmentIds.map(String))] : []
    if (ids.length > config.maxAttachmentsPerMessage) throw new HttpError(400, `Tối đa ${config.maxAttachmentsPerMessage} tệp mỗi tin nhắn.`)
    const uploads = ids.map((id) => q("SELECT * FROM uploads WHERE id = ? AND user_id = ?").get(id, req.user.id))
    if (uploads.some((u) => !u)) throw new HttpError(400, "Tệp đính kèm không tồn tại hoặc đã bị xoá.")
    if (!text && !uploads.length) throw new HttpError(400, "Tin nhắn trống.")
    return { text, uploads }
  }

  /**
   * Import each upload into the session's document store (doc-store importDocument) so the agent can
   * edit it with document_edit. Idempotent per (upload, session); skipped when doc-store is unavailable.
   * Returns Map uploadId → artifact id.
   */
  async function importUploads(uploads, chat, sid, userId) {
    const out = new Map()
    for (const u of uploads) {
      if (u.user_id !== userId || chat.user_id !== userId) continue
      const prev = q("SELECT artifact_id FROM upload_docs WHERE upload_id = ? AND session_id = ?").get(u.id, sid)
      if (prev && describeInChat(chat, prev.artifact_id)) {
        out.set(u.id, prev.artifact_id)
        continue
      }
      let markdown
      try {
        markdown = fs.readFileSync(u.text_path, "utf8")
      } catch {
        continue
      }
      const ocr = uploadOcr(u)
      // text recognised from a scan: the document carries meta.ocr and the evidence meta.ocr=true (grounding caps claims resting on it)
      const meta = await importDocument({ sessionID: sid, title: u.name.replace(/\.[^.]+$/, "") || u.name, markdown, originalPath: u.stored_path, ...(ocr ? { ocr } : {}) })
      const ok = !!meta && /^\d{14}-[0-9a-f]{6}$/.test(meta.id)
      if (ocr) {
        if (ok && !meta.ocr) markArtifactOcr(sid, meta.id, ocr)
        recordUploadOcrEvidence(sid, u, markdown, ocr, ok ? meta.id : null)
      }
      if (!ok) continue
      q(
        "INSERT INTO upload_docs (upload_id, session_id, chat_id, user_id, artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(upload_id, session_id) DO UPDATE SET artifact_id = excluded.artifact_id",
      ).run(u.id, sid, chat.id, userId, meta.id, Date.now())
      out.set(u.id, meta.id)
    }
    return out
  }

  /** User text + the UI-language line (hidden when shown back) + attachment blocks. */
  function assemblePrompt(text, uploads, docIds = new Map(), locale = "vi") {
    let prompt = withUiLanguage(text || EMPTY_TEXT_WITH_FILES, locale)
    if (uploads.length) {
      let budget = config.maxPromptAttachmentChars
      const blocks = []
      for (const u of uploads) {
        let body = fs.readFileSync(u.text_path, "utf8")
        let cut = !!u.truncated
        if (body.length > budget) {
          body = body.slice(0, Math.max(0, budget))
          cut = true
        }
        budget -= body.length
        // Keep the delimiter unambiguous even if the document itself contains ">>>" / "<<<" lines.
        body = body.replace(/^(<<<|>>>)\s*$/gm, (m) => m.split("").join(" "))
        const cutNote = cut ? ` (đã cắt bớt – chỉ gửi ${body.length.toLocaleString("vi-VN")} ký tự đầu)` : ""
        blocks.push(`${attachmentHeader(u.name, docIds.get(u.id), cutNote, uploadOcr(u))}\n<<<\n${body}\n>>>`)
      }
      prompt += `\n\n${ATTACH_NOTE}\n\n${blocks.join("\n\n")}`
    }
    return prompt
  }

  /** Imported uploads shown as document cards on user messages (looked up in this chat's sessions only). */
  function withAttachmentDocs(chat, messages) {
    for (const m of messages) {
      if (m.role !== "user" || !m.attachments?.length) continue
      m.attachments = m.attachments.map((a) => {
        if (!a.docId) return a
        const artifact = describeInChat(chat, a.docId)
        return artifact ? { ...a, artifact } : { name: a.name, ...(a.ocr ? { ocr: a.ocr } : {}) }
      })
    }
    return messages
  }

  /**
   * Admin tool / skill switches (server/library.mjs) as session permission rules, applied right before each
   * prompt_async – never a prompt `tools` object, which would replace the session rules. With the question tool
   * off (WEB_QUESTION_TOOL=0) "question" is denied the same way. Returns the `system` field for the prompt body.
   */
  async function libraryPromptFields(sid, locale) {
    await applyLibraryPermissions(oc, sid, config.questionTool ? {} : { question: false })
    const system = [config.questionTool ? CLARIFY_SYSTEM[locale] || CLARIFY_SYSTEM.vi : "", disabledSkillsNote(locale)].filter(Boolean).join("\n")
    return system ? { system } : {}
  }

  async function sendPrompt(chat, branch, prompt, userId, locale = "vi") {
    const sid = branch.opencode_session_id
    repairAt.delete(sid)
    finalAt.delete(sid)
    // Model chosen by the admin (app_settings.agentModel; default = opencode.json "model") – new messages, edits and regenerations.
    const model = promptModel()
    runs.set(sid, { at: Date.now(), sawBusy: false, chatId: chat.id, userId, locale, model: model ? `${model.providerID}/${model.modelID}` : undefined })
    try {
      await oc.request("POST", `/session/${encodeURIComponent(sid)}/prompt_async`, {
        agent: config.agent,
        ...(model ? { model } : {}),
        parts: [{ type: "text", text: prompt }],
        // Clarifying questions are answered with the question cards; without them the tool stays off.
        ...(await libraryPromptFields(sid, locale)),
      })
    } catch (e) {
      runs.delete(sid)
      throw e
    }
    states.get(sid).status = "busy"
    const now = Date.now()
    q("UPDATE chats SET updated_at = ?, first_prompt_at = COALESCE(first_prompt_at, ?) WHERE id = ?").run(now, now, chat.id)
    q("UPDATE branches SET turns = COALESCE(turns, 0) + 1, visited_at = ? WHERE id = ?").run(now, branch.id)
    q("INSERT INTO prompts (user_id, chat_id, created_at) VALUES (?, ?, ?)").run(userId, chat.id, now)
  }

  const deleteSessions = async (chatId) => {
    for (const b of branchesOf(chatId)) {
      await oc.request("POST", `/session/${encodeURIComponent(b.opencode_session_id)}/abort`).catch(() => {})
      await oc.request("DELETE", `/session/${encodeURIComponent(b.opencode_session_id)}`).catch((e) => e.status !== 404 && console.warn("[chats] delete session:", e.message))
    }
  }

  // ---- search index ------------------------------------------------------------------------------
  const indexTimers = new Map()
  function scheduleIndex(sid, delay = 800) {
    if (indexTimers.has(sid)) return
    indexTimers.set(
      sid,
      setTimeout(() => {
        indexTimers.delete(sid)
        indexSession(sid).catch((e) => console.warn("[index]", e.message))
      }, delay),
    )
  }
  async function indexSession(sid) {
    const branch = branchBySession(sid)
    if (!branch) return
    const items = await oc.request("GET", `/session/${encodeURIComponent(sid)}/message`)
    const msgs = convertHistory(items, states.get(sid))
    writeIndex(branch, msgs)
  }
  function writeIndex(branch, msgs) {
    const users = msgs.filter((m) => m.role === "user").length
    tx(() => {
      q("UPDATE branches SET turns = ? WHERE id = ?").run(users, branch.id)
      for (const m of msgs) {
        const text = plainText(m)
        if (!text) continue
        const prev = q("SELECT text FROM message_text WHERE message_id = ?").get(m.id)
        if (prev?.text === text) continue
        q("INSERT INTO message_text (message_id, chat_id, branch_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET text = excluded.text").run(
          m.id, branch.chat_id, branch.id, m.role, text, m.time || Date.now())
        if (FTS) {
          q("DELETE FROM message_fts WHERE message_id = ?").run(m.id)
          q("INSERT INTO message_fts (text, message_id, chat_id) VALUES (?, ?, ?)").run(text, m.id, branch.chat_id)
        }
      }
    })
  }
  // Backfill chats that were never indexed (e.g. created before search existed).
  setTimeout(async () => {
    const todo = q("SELECT b.opencode_session_id AS sid FROM branches b WHERE NOT EXISTS (SELECT 1 FROM message_text m WHERE m.branch_id = b.id)").all()
    for (const { sid } of todo) await indexSession(sid).catch(() => {})
  }, 3000).unref()

  // ---- chats -------------------------------------------------------------------------------------
  /**
   * Cursor-paginated chat list (newest activity first): ?limit=30 (max 100) &cursor=<opaque>.
   * The first page also carries all pinned chats (they are excluded from the paged list).
   */
  app.get("/api/chats", requireUser, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100)
    const cur = decodeCursor(req.query.cursor)
    const rows = cur
      ? q(`SELECT * FROM chats WHERE user_id = ? AND pinned_at IS NULL AND (updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC, id DESC LIMIT ?`).all(
          req.user.id, cur.t, cur.t, cur.id, limit + 1)
      : q(`SELECT * FROM chats WHERE user_id = ? AND pinned_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?`).all(req.user.id, limit + 1)
    const more = rows.length > limit
    const page = rows.slice(0, limit)
    const unread = unreadOf(req.user.id)
    const out = { chats: page.map((c) => chatOut(c, unread.get(c.id) || 0)), next: more ? encodeCursor(page.at(-1).updated_at, page.at(-1).id) : null }
    if (!cur) {
      out.pinned = q("SELECT * FROM chats WHERE user_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC").all(req.user.id).map((c) => chatOut(c, unread.get(c.id) || 0))
      out.total = q("SELECT COUNT(*) AS n FROM chats WHERE user_id = ?").get(req.user.id).n
    }
    res.json(out)
  })
  app.get("/api/chats/:id", requireUser, (req, res) => {
    const chat = q("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user.id)
    if (!chat) return res.status(404).json({ error: "Không tìm thấy cuộc trò chuyện." })
    res.json({ chat: chatOut(chat, unreadOf(req.user.id).get(chat.id) || 0) })
  })

  /** Create a chat and send its first prompt in one request, so a chat can never exist without its prompt. */
  app.post(
    "/api/chats",
    requireUser,
    json,
    wrap(async (req, res) => {
      const { text, uploads } = checkPrompt(req, req.body?.text, req.body?.attachmentIds)
      const locale = resolveLocale(req)
      const title = makeTitle(text, uploads.map((u) => ({ name: u.name })), locale)
      // Passing a title means opencode does not spend a model call to generate one.
      const session = await oc.request("POST", "/session", { title })
      const now = Date.now()
      const id = "c_" + newId(12)
      const bid = "b_" + newId(12)
      tx(() => {
        q("INSERT INTO chats (id, user_id, opencode_session_id, title, created_at, updated_at, active_branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          id, req.user.id, session.id, title, now, now, bid)
        q("INSERT INTO branches (id, chat_id, opencode_session_id, parent_id, fork_turn, created_at, visited_at, kind, turns) VALUES (?, ?, ?, NULL, NULL, ?, ?, 'root', 0)").run(
          bid, id, session.id, now, now)
      })
      const chat = q("SELECT * FROM chats WHERE id = ?").get(id)
      try {
        const prompt = assemblePrompt(text, uploads, await importUploads(uploads, chat, session.id, req.user.id), locale)
        await sendPrompt(chat, q("SELECT * FROM branches WHERE id = ?").get(bid), prompt, req.user.id, locale)
      } catch (e) {
        // Never leave a silent empty chat behind.
        q("DELETE FROM chats WHERE id = ?").run(id)
        oc.request("DELETE", `/session/${encodeURIComponent(session.id)}`).catch(() => {})
        throw e
      }
      res.status(201).json({ chat: chatOut(q("SELECT * FROM chats WHERE id = ?").get(id)) })
    }),
  )

  app.patch(
    "/api/chats/:id",
    requireUser,
    json,
    wrap(async (req, res) => {
      const chat = ownChat(req)
      if (req.body?.title !== undefined) {
        const title = typeof req.body.title === "string" ? req.body.title.replace(/\s+/g, " ").trim().slice(0, config.maxTitleChars) : ""
        if (!title) throw new HttpError(400, "Tên không được để trống.")
        q("UPDATE chats SET title = ? WHERE id = ?").run(title, chat.id)
      }
      if (req.body?.pinned !== undefined) q("UPDATE chats SET pinned_at = ? WHERE id = ?").run(req.body.pinned ? Date.now() : null, chat.id)
      res.json({ chat: chatOut(q("SELECT * FROM chats WHERE id = ?").get(chat.id)) })
    }),
  )

  app.delete(
    "/api/chats/:id",
    requireUser,
    wrap(async (req, res) => {
      const chat = ownChat(req)
      await deleteSessions(chat.id)
      q("DELETE FROM message_fts WHERE chat_id = ?").run(chat.id)
      q("DELETE FROM chats WHERE id = ?").run(chat.id)
      res.json({ ok: true })
    }),
  )

  /** Delete every chat of the current user (Settings → Dữ liệu). */
  app.post(
    "/api/chats/delete-all",
    requireUser,
    json,
    wrap(async (req, res) => {
      if (req.body?.confirm !== "XOÁ TẤT CẢ") throw new HttpError(400, "Xác nhận không đúng.")
      const n = await deleteAllChats(req.user.id)
      res.json({ ok: true, deleted: n })
    }),
  )
  async function deleteAllChats(userId) {
    const chats = q("SELECT id FROM chats WHERE user_id = ?").all(userId)
    for (const c of chats) {
      await deleteSessions(c.id)
      q("DELETE FROM message_fts WHERE chat_id = ?").run(c.id)
    }
    q("DELETE FROM chats WHERE user_id = ?").run(userId)
    return chats.length
  }

  app.get(
    "/api/chats/:id/messages",
    requireUser,
    wrap(async (req, res) => res.json(await historyResponse(req, ownChat(req)))),
  )
  /** Chat history page for the owner – or, read-only, for an admin (?branch=<id> views a version without switching). */
  async function historyResponse(req, chat, branchOverride = null) {
    {
      const branch = branchOverride || activeBranch(chat)
      const sid = branch.opencode_session_id
      let items = []
      try {
        items = await oc.request("GET", `/session/${encodeURIComponent(sid)}/message`)
      } catch (e) {
        if (e.status !== 404) throw e
      }
      const messages = withAttachmentDocs(chat, convertHistory(items, states.get(sid), { reasoning: reasoningAllowed(req.user), locale: resolveLocale(req) }))
      const busy = await sessionBusy(sid)
      await annotateQuestions(messages, sid, busy)
      const users = messages.filter((m) => m.role === "user").length
      if (users !== branch.turns && !runs.has(sid)) q("UPDATE branches SET turns = ? WHERE id = ?").run(users, branch.id)
      const branches = branchesOf(chat.id).map((b) => (b.id === branch.id ? { ...b, turns: Math.max(users, b.turns || 0) } : b))
      // Page by user turns (newest first): ?turns=N (default 20, max 100) and ?beforeTurn=k for older ones.
      // Turn-indexed data (versions, confidence, escalations) stays absolute; the client adds turnOffset.
      const pageTurns = Math.min(Math.max(parseInt(req.query.turns, 10) || 20, 1), 100)
      const before = req.query.beforeTurn != null ? Math.min(Math.max(parseInt(req.query.beforeTurn, 10) || 0, 0), users) : users
      const start = Math.max(0, before - pageTurns)
      const userIdx = []
      messages.forEach((m, i) => m.role === "user" && userIdx.push(i))
      const from = start === 0 ? 0 : userIdx[start]
      const to = before >= users ? messages.length : userIdx[before]
      const ex = extras(chat, branch, messages)
      return {
        chat: chatOut(chat),
        branchId: branch.id,
        busy,
        messages: messages.slice(from, to),
        turnOffset: start,
        totalTurns: users,
        hasMore: start > 0,
        versions: computeVersions(branches, branch.id),
        followups: followupsFor(sid, users),
        ...ex,
      }
    }
  }

  // ---- admin: read-only review of every user's chats (each view is written to the access log) ----------
  const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Vui lòng đăng nhập." })
    if (!req.user.isAdmin) return res.status(403).json({ error: "Bạn không có quyền truy cập." })
    next()
  }
  const pageArgs = (req) => {
    const size = [20, 50, 100].includes(Number(req.query.size)) ? Number(req.query.size) : 20
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    return { size, page }
  }
  const dayStart = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? new Date(`${v}T00:00:00+07:00`).getTime() : null)
  app.get("/api/admin/chats", requireUser, requireAdmin, (req, res) => {
    const { size, page } = pageArgs(req)
    const where = []
    const args = []
    const user = String(req.query.user || "").trim().toLowerCase()
    if (user) {
      where.push("(lower(u.email) LIKE ? OR u.id = ?)")
      args.push(`%${user.replace(/[%_]/g, "")}%`, user)
    }
    const from = dayStart(req.query.from)
    const to = dayStart(req.query.to)
    if (from != null) where.push("c.updated_at >= ?"), args.push(from)
    if (to != null) where.push("c.updated_at < ?"), args.push(to + 86400_000)
    const kw = String(req.query.q || "").trim().slice(0, 100)
    if (kw) {
      const ids = new Set(q("SELECT id FROM chats WHERE title LIKE ?").all(`%${kw}%`).map((r) => r.id))
      try {
        if (FTS) {
          // Same query shape as /api/search (FTS5, diacritics-insensitive, prefix match).
          const terms = (kw.match(/[\p{L}\p{N}]+/gu) || []).map((w) => `"${w}"*`).join(" ")
          if (terms) for (const r of q("SELECT DISTINCT chat_id FROM message_fts WHERE message_fts MATCH ? LIMIT 1000").all(terms)) ids.add(r.chat_id)
          // Titles, diacritics-insensitive too.
          for (const c of q("SELECT id, title FROM chats").all()) if (fold(c.title).includes(fold(kw))) ids.add(c.id)
        } else for (const r of q("SELECT DISTINCT chat_id FROM message_text WHERE text LIKE ? LIMIT 1000").all(`%${kw}%`)) ids.add(r.chat_id)
      } catch {}
      if (!ids.size) return res.json({ chats: [], total: 0, page: 1, size, pages: 1 })
      where.push(`c.id IN (${[...ids].map(() => "?").join(",")})`)
      args.push(...ids)
    }
    const W = where.length ? "WHERE " + where.join(" AND ") : ""
    const total = q(`SELECT COUNT(*) AS n FROM chats c JOIN users u ON u.id = c.user_id ${W}`).get(...args).n
    const rows = q(
      `SELECT c.*, u.email AS owner_email,
         (SELECT COALESCE(MAX(b.turns), 0) FROM branches b WHERE b.chat_id = c.id) AS turns,
         (SELECT COUNT(*) FROM escalations e WHERE e.chat_id = c.id) AS escalations
       FROM chats c JOIN users u ON u.id = c.user_id ${W} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    ).all(...args, size, (page - 1) * size)
    res.json({
      chats: rows.map((c) => ({ id: c.id, title: c.title, ownerId: c.user_id, ownerEmail: c.owner_email, createdAt: c.created_at, updatedAt: c.updated_at, turns: c.turns, hasDocuments: chatHasDocuments(c.id), hasEscalation: c.escalations > 0 })),
      total, page, size, pages: Math.max(1, Math.ceil(total / size)),
    })
  })
  app.get(
    "/api/admin/chats/:id/messages",
    requireUser,
    requireAdmin,
    wrap(async (req, res) => {
      const chat = q("SELECT * FROM chats WHERE id = ?").get(String(req.params.id))
      if (!chat) throw new HttpError(404, "Không tìm thấy cuộc trò chuyện.")
      const branch = req.query.branch ? q("SELECT * FROM branches WHERE id = ? AND chat_id = ?").get(String(req.query.branch), chat.id) : null
      if (req.query.branch && !branch) throw new HttpError(404, "Không tìm thấy phiên bản.")
      // One log entry per opened view (not for "load older turns" pages).
      if (req.query.beforeTurn == null) logAdminAccess(req.user, chat, "view", branch ? `branch ${branch.id}` : "")
      const owner = q("SELECT id, email FROM users WHERE id = ?").get(chat.user_id)
      res.json({ ...(await historyResponse(req, chat, branch)), owner: owner ? { id: owner.id, email: owner.email } : null, followups: null })
    }),
  )
  app.get("/api/admin/access-log", requireUser, requireAdmin, (req, res) => res.json(accessLog(pageArgs(req))))

  /** A hub connection for one viewer: follows a branch session and translates its events for that viewer. */
  function streamConn(req, send) {
    return {
      unsub: null,
      send,
      follow(sid, branchId) {
        this.unsub?.()
        const st = states.get(sid)
        // Per connection: reasoning only for allowed viewers; streamed text scrubbed (see events.mjs).
        const ctx = { reasoning: reasoningAllowed(req.user), acc: new Map(), locale: resolveLocale(req) }
        // Answers of an automatic repair run are flagged so the UI can show "Đã tra lại và cập nhật".
        const flag = (o) => {
          const t0 = o?.type === "message" && repairAt.get(sid)
          if (t0 && (o.time || 0) >= t0) o.repair = true
          const f0 = o?.type === "message" && finalAt.get(sid)
          if (f0 && (o.time || 0) >= f0) o.finalize = true
          return o
        }
        this.unsub = oc.subscribe(sid, (ev) => {
          const out = translateEvent(ev, st, ctx)
          if (Array.isArray(out)) out.forEach((o) => send(flag(o)))
          else if (out) send(flag(out))
        })
        if (branchId) send({ type: "branch", branchId })
      },
    }
  }

  const sseCount = new Map()
  app.get(
    "/api/chats/:id/events",
    requireUser,
    wrap(async (req, res) => {
      const chat = ownChat(req)
      const n = sseCount.get(req.user.id) || 0
      if (n >= 12) throw new HttpError(429, "Quá nhiều kết nối đồng thời.")
      sseCount.set(req.user.id, n + 1)
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
      res.flushHeaders?.()
      req.socket.setNoDelay?.(true)
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const conn = streamConn(req, send)
      conn.follow(activeBranch(chat).opencode_session_id)
      hub.add(chat.id, conn)
      const hb = setInterval(() => res.write(": ping\n\n"), 15_000)
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(hb)
        conn.unsub?.()
        hub.remove(chat.id, conn)
        const m = (sseCount.get(req.user.id) || 1) - 1
        if (m > 0) sseCount.set(req.user.id, m)
        else sseCount.delete(req.user.id)
      }
      req.on("close", close)
      res.on("error", close)
      // A padding comment first: some proxies hold back small event-stream chunks.
      res.write(`: ${" ".repeat(2048)}\n\nretry: 2000\n\n`)
      send({ type: "ready", busy: await sessionBusy(activeBranch(chat).opencode_session_id) })
    }),
  )

  // ---- long-poll transport (see poll.mjs): the same events as /events, one short response per batch,
  // for viewers behind proxies that buffer streamed responses. Logs are per chat and viewer scope
  // (user + reasoning permission + locale), so per-viewer translation / scrubbing is exactly the SSE one.
  const pollLogs = new Map() // scope key -> EventLog
  const pollCount = new Map() // userId -> polls currently waiting
  const pollKey = (req, chat) => [chat.id, req.user.id, reasoningAllowed(req.user) ? 1 : 0, resolveLocale(req)].join("|")
  const dropLog = (key, log) => {
    pollLogs.delete(key)
    log.conn.unsub?.()
    hub.remove(log.chatId, log.conn)
  }
  setInterval(() => {
    for (const [key, log] of pollLogs) {
      if (log.stale || !q("SELECT 1 FROM chats WHERE id = ?").get(log.chatId)) dropLog(key, log)
      else log.prune()
    }
  }, 60_000).unref()
  const readyEvent = async (chat) => ({ type: "ready", busy: await sessionBusy(activeBranch(chat).opencode_session_id) })
  app.get(
    "/api/chats/:id/poll",
    requireUser,
    wrap(async (req, res) => {
      const chat = ownChat(req)
      const key = pollKey(req, chat)
      let log = pollLogs.get(key)
      if (!log) {
        // At most 20 logs per user: drop the least recently polled one.
        const mine = [...pollLogs].filter(([, l]) => l.userId === req.user.id).sort((a, b) => a[1].polledAt - b[1].polledAt)
        if (mine.length >= 20) dropLog(...mine[0])
        const l = (log = new EventLog())
        l.chatId = chat.id
        l.userId = req.user.id
        l.conn = streamConn(req, (obj) => l.push(obj))
        Object.defineProperty(l.conn, "live", { get: () => l.live })
        l.conn.follow(activeBranch(chat).opencode_session_id)
        hub.add(chat.id, l.conn)
        pollLogs.set(key, l)
      }
      log.polledAt = Date.now()
      res.set("Cache-Control", "no-store")
      const after = Math.max(0, Number(req.query.after) || 0)
      const waitMs = Math.min(Math.max(Number(req.query.wait ?? POLL.MAX_WAIT_S) || 0, 0), POLL.MAX_WAIT_S) * 1000
      // First poll (after=0), or `after` older than the buffer / from another server process: start over
      // with a "ready" (the client then reloads the history, as on an SSE reconnect).
      const restart = async (reset) => {
        const next = log.seq
        res.json({ events: [await readyEvent(chat)], next, ...(reset ? { reset: true } : {}) })
      }
      let out = after > 0 ? log.since(after) : null
      if (!out) return restart(after > 0)
      if (!out.events.length && waitMs > 0) {
        const n = pollCount.get(req.user.id) || 0
        if (n >= 12) throw new HttpError(429, "Quá nhiều kết nối đồng thời.")
        pollCount.set(req.user.id, n + 1)
        log.polling++
        try {
          out = await log.wait(after, waitMs, (finish) => req.on("close", finish))
        } finally {
          log.polling--
          log.polledAt = Date.now()
          const m = (pollCount.get(req.user.id) || 1) - 1
          if (m > 0) pollCount.set(req.user.id, m)
          else pollCount.delete(req.user.id)
        }
        if (res.destroyed || res.headersSent) return
        if (!out) return restart(true)
      }
      res.json(out)
    }),
  )

  app.post(
    "/api/chats/:id/abort",
    requireUser,
    wrap(async (req, res) => {
      const chat = ownChat(req)
      const sid = activeBranch(chat).opencode_session_id
      // A pending question must be rejected first: an abort alone leaves it orphaned (docs/QUESTION_TOOL.md §4).
      for (const r of await pendingQuestions(new Set([sid]))) await oc.request("POST", `/question/${encodeURIComponent(r.id)}/reject`).catch(() => {})
      await oc.request("POST", `/session/${encodeURIComponent(sid)}/abort`)
      res.json({ ok: true })
    }),
  )

  // ---- clarifying questions (question cards) -------------------------------------------------------
  /** Pending question requests of these sessions (opencode keeps them in memory, per serve process). */
  async function pendingQuestions(sids) {
    if (!config.questionTool) return []
    try {
      const list = await oc.request("GET", "/question", undefined, { timeoutMs: 5000 })
      return (Array.isArray(list) ? list : []).filter((r) => r && sids.has(r.sessionID) && QUESTION_ID_RE.test(String(r.id)))
    } catch {
      return []
    }
  }
  /**
   * History: give pending question parts the request id (needed to answer), matched by tool call id. A
   * question part still marked pending without a live request (server restarted, orphan after an abort) is dead.
   */
  async function annotateQuestions(messages, sid, busy) {
    const parts = messages.flatMap((m) => (m.role === "assistant" ? m.parts || [] : [])).filter((p) => p.tool === QUESTION_TOOL && p.qstate === "pending")
    if (!parts.length) return
    const byCall = new Map((await pendingQuestions(new Set([sid]))).map((r) => [r.tool?.callID, r]))
    for (const p of parts) {
      const r = p.callID && byCall.get(p.callID)
      if (r) p.requestID = r.id
      else if (!busy || p.status === "running") p.qstate = "stopped"
    }
  }
  const chatQuestion = async (req) => {
    const chat = ownChat(req)
    const qid = String(req.params.qid || "")
    if (!QUESTION_ID_RE.test(qid)) throw new HttpError(404, "Câu hỏi này không còn chờ trả lời.")
    const sids = new Set(branchesOf(chat.id).map((b) => b.opencode_session_id))
    const r = (await pendingQuestions(sids)).find((x) => x.id === qid)
    if (!r) throw new HttpError(404, "Câu hỏi này không còn chờ trả lời.")
    return { chat, r }
  }
  const upstreamGone = (e) => {
    if (e.status === 404) throw new HttpError(404, "Câu hỏi này không còn chờ trả lời.")
    throw e
  }
  app.post(
    "/api/chats/:id/questions/:qid/reply",
    requireUser,
    json,
    wrap(async (req, res) => {
      const { r } = await chatQuestion(req)
      const max = Math.min(10, Math.max(5, Array.isArray(r.questions) ? r.questions.length : 0))
      const a = req.body?.answers
      const valid =
        Array.isArray(a) && a.length <= max &&
        a.every((x) => Array.isArray(x) && x.length <= 20 && x.every((v) => typeof v === "string" && v.trim() && v.length <= 500))
      if (!valid) throw new HttpError(400, "Câu trả lời không hợp lệ.")
      await oc.request("POST", `/question/${encodeURIComponent(r.id)}/reply`, { answers: a.map((x) => x.map((v) => v.trim())) }).catch(upstreamGone)
      res.json({ ok: true })
    }),
  )
  app.post(
    "/api/chats/:id/questions/:qid/reject",
    requireUser,
    json,
    wrap(async (req, res) => {
      const { r } = await chatQuestion(req)
      await oc.request("POST", `/question/${encodeURIComponent(r.id)}/reject`).catch(upstreamGone)
      res.json({ ok: true })
    }),
  )

  const BUSY = "Trợ lý đang trả lời. Hãy chờ hoặc bấm dừng."

  /**
   * "Tra lại ngay": one repair run on demand for the latest answer of the active version, when the admin allows
   * repairs (autoRepairLowConfidence) – whatever the user's automatic preference. Only for a THẤP verdict and at
   * most once per user turn (the same limit as the automatic repair).
   */
  app.post(
    "/api/chats/:id/repair",
    requireUser,
    json,
    wrap(async (req, res) => {
      if (!autoRepairOn()) throw new HttpError(403, REPAIR_DISABLED)
      const chat = ownChat(req)
      const branch = activeBranch(chat)
      const sid = branch.opencode_session_id
      if (runs.has(sid) || (await remoteBusy(sid))) throw new HttpError(409, BUSY)
      const items = await oc.request("GET", `/session/${encodeURIComponent(sid)}/message`)
      const lt = lastTurnOf(items)
      if (!lt || !lt.answer || !lt.tail.length || lt.tail.some((m) => m.info?.error)) throw new HttpError(409, "Không có câu trả lời nào để tra lại.")
      if (req.body?.turn != null && Number(req.body.turn) !== lt.k) throw new HttpError(409, "Không có câu trả lời nào để tra lại.")
      if (lt.repaired) throw new HttpError(409, "Câu trả lời này đã được tra lại.")
      const verdict = groundingForTurns(branch, convertHistory(items, states.get(sid)))[lt.k]
      if (verdict?.level !== "thấp") throw new HttpError(409, "Chỉ tra lại được khi độ tin cậy thấp.")
      const model = promptModel()
      const locale = resolveLocale(req)
      await startRepair(sid, { chatId: chat.id, userId: req.user.id, locale, model: model ? `${model.providerID}/${model.modelID}` : undefined }, branch, lt.k, { ...verdict, origin: verdict.origin || "model" }, true)
      res.status(202).json({ ok: true, branchId: branch.id, turn: lt.k })
    }),
  )

  /**
   * Send a message. Without editTurn/regenerate it is appended to the active branch. With them, the
   * active session is forked just before user turn k (opencode copies turns 0..k-1), the new branch
   * becomes active and receives the edited / identical prompt – old versions stay untouched.
   */
  app.post(
    "/api/chats/:id/messages",
    requireUser,
    json,
    wrap(async (req, res) => {
      const chat = ownChat(req)
      const branch = activeBranch(chat)
      const editTurn = req.body?.editTurn
      const regenerate = !!req.body?.regenerate
      if (editTurn == null && !regenerate) {
        const { text, uploads } = checkPrompt(req, req.body?.text, req.body?.attachmentIds)
        const sid = branch.opencode_session_id
        if (runs.has(sid) || (await remoteBusy(sid))) throw new HttpError(409, BUSY)
        const prompt = assemblePrompt(text, uploads, await importUploads(uploads, chat, sid, req.user.id), resolveLocale(req))
        await sendPrompt(chat, branch, prompt, req.user.id, resolveLocale(req))
        return res.status(202).json({ ok: true, branchId: branch.id })
      }
      if (await chatBusy(chat.id)) throw new HttpError(409, BUSY)
      const items = await oc.request("GET", `/session/${encodeURIComponent(branch.opencode_session_id)}/message`)
      const userMsgs = items.filter((m) => m.info?.role === "user" && !isHiddenPrompt(m))
      const k = regenerate ? (editTurn ?? userMsgs.length - 1) : Number(editTurn)
      if (!Number.isInteger(k) || k < 0 || k >= userMsgs.length) throw new HttpError(400, "Tin nhắn không hợp lệ.")
      const original = rawUserText(userMsgs[k].parts)
      let prompt
      const locale = resolveLocale(req)
      const section = attachmentSection(original)
      if (regenerate) {
        // Same prompt, but with the current UI language.
        const head = section ? original.slice(0, original.indexOf(section)).trimEnd() : original
        prompt = withUiLanguage(stripUiLanguage(head), locale) + (section ? `\n\n${section}` : "")
      } else {
        const text = String(req.body?.text || "").replace(/\r\n?/g, "\n").trim()
        if (!text && !section) throw new HttpError(400, "Tin nhắn trống.")
        if (text.length > config.maxMessageChars) throw new HttpError(413, "Tin nhắn quá dài.")
        prompt = withUiLanguage(text || EMPTY_TEXT_WITH_FILES, locale) + (section ? `\n\n${section}` : "")
      }
      const fork = await oc.request("POST", `/session/${encodeURIComponent(branch.opencode_session_id)}/fork`, { messageID: userMsgs[k].info.id })
      // The new version sees the parent's documents (document_edit on an earlier version keeps working).
      await inheritSession(branch.opencode_session_id, fork.id)
      const now = Date.now()
      const bid = "b_" + newId(12)
      q("INSERT INTO branches (id, chat_id, opencode_session_id, parent_id, fork_turn, created_at, visited_at, kind, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        bid, chat.id, fork.id, branch.id, k, now, now, regenerate ? "regenerate" : "edit", k)
      q("UPDATE chats SET active_branch_id = ? WHERE id = ?").run(bid, chat.id)
      const nb = q("SELECT * FROM branches WHERE id = ?").get(bid)
      hub.switchTo(chat.id, bid, fork.id) // streams follow the new version before the prompt starts
      try {
        await sendPrompt(chat, nb, prompt, req.user.id, locale)
      } catch (e) {
        q("UPDATE chats SET active_branch_id = ? WHERE id = ?").run(branch.id, chat.id)
        q("DELETE FROM branches WHERE id = ?").run(bid)
        hub.switchTo(chat.id, branch.id, branch.opencode_session_id)
        oc.request("DELETE", `/session/${encodeURIComponent(fork.id)}`).catch(() => {})
        throw e
      }
      res.status(202).json({ ok: true, branchId: bid })
    }),
  )

  /** Show another version (branch) of the conversation. */
  app.post(
    "/api/chats/:id/switch",
    requireUser,
    json,
    wrap(async (req, res) => {
      const chat = ownChat(req)
      const target = q("SELECT * FROM branches WHERE id = ? AND chat_id = ?").get(String(req.body?.branchId || ""), chat.id)
      if (!target) throw new HttpError(404, "Không tìm thấy phiên bản.")
      if (await chatBusy(chat.id)) throw new HttpError(409, BUSY)
      q("UPDATE chats SET active_branch_id = ? WHERE id = ?").run(target.id, chat.id)
      q("UPDATE branches SET visited_at = ? WHERE id = ?").run(Date.now(), target.id)
      hub.switchTo(chat.id, target.id, target.opencode_session_id)
      res.json({ ok: true, branchId: target.id })
    }),
  )

  // ---- search ------------------------------------------------------------------------------------
  app.get(
    "/api/search",
    requireUser,
    wrap(async (req, res) => {
      const raw = String(req.query.q || "").trim().slice(0, 200)
      if (!raw) return res.json({ results: [] })
      const chats = q("SELECT * FROM chats WHERE user_id = ?").all(req.user.id)
      const byId = new Map(chats.map((c) => [c.id, c]))
      const needle = fold(raw)
      const results = new Map()
      for (const c of chats) if (fold(c.title).includes(needle)) results.set(c.id, { ...chatOut(c), match: "title", snippet: "" })
      let rows = []
      const terms = raw.match(/[\p{L}\p{N}]+/gu) || []
      if (FTS && terms.length) {
        const match = terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ")
        try {
          rows = q(
            `SELECT chat_id, snippet(message_fts, 0, '«', '»', '…', 14) AS snip, bm25(message_fts) AS score FROM message_fts
             WHERE message_fts MATCH ? AND chat_id IN (SELECT id FROM chats WHERE user_id = ?) ORDER BY score LIMIT 200`,
          ).all(match, req.user.id)
        } catch {
          rows = []
        }
      } else {
        rows = q(
          `SELECT m.chat_id, substr(m.text, 1, 160) AS snip FROM message_text m JOIN chats c ON c.id = m.chat_id WHERE c.user_id = ? AND m.text LIKE ? LIMIT 200`,
        ).all(req.user.id, `%${raw.replace(/[%_]/g, "")}%`)
      }
      for (const r of rows) {
        const c = byId.get(r.chat_id)
        if (!c) continue
        const cur = results.get(c.id)
        if (cur && cur.snippet) continue
        results.set(c.id, { ...chatOut(c), match: cur ? "both" : "message", snippet: scrubText(String(r.snip || "").replace(/\s+/g, " ").slice(0, 220)) })
      }
      // Offset cursor over the ranked result list: ?limit=30 (max 100) &cursor=<n>
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100)
      const offset = Math.max(parseInt(req.query.cursor, 10) || 0, 0)
      const all = [...results.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      res.json({ results: all.slice(offset, offset + limit), next: offset + limit < all.length ? String(offset + limit) : null, total: all.length })
    }),
  )

  // ---- sharing -----------------------------------------------------------------------------------
  const shareOut = (s, chatTitle) => ({ token: s.token, chatId: s.chat_id, title: s.title, chatTitle, createdAt: s.created_at, revoked: !!s.revoked_at })

  app.get(
    "/api/chats/:id/share",
    requireUser,
    wrap(async (req, res) => {
      const chat = ownChat(req)
      const s = q("SELECT * FROM shares WHERE chat_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get(chat.id)
      res.json({ share: s ? shareOut(s, chat.title) : null })
    }),
  )

  /** Snapshot the active version and publish it under a random token (replaces the previous link). */
  app.post(
    "/api/chats/:id/share",
    requireUser,
    wrap(async (req, res) => {
      const chat = ownChat(req)
      const branch = activeBranch(chat)
      if (await sessionBusy(branch.opencode_session_id)) throw new HttpError(409, "Chờ trợ lý trả lời xong rồi hãy chia sẻ.")
      const items = await oc.request("GET", `/session/${encodeURIComponent(branch.opencode_session_id)}/message`)
      const messages = withAttachmentDocs(chat, convertHistory(items, states.get(branch.opencode_session_id), { locale: resolveLocale(req) })).map((m) =>
        m.role === "user"
          ? { role: "user", text: m.text, attachments: m.attachments, time: m.time }
          : {
              role: "assistant",
              time: m.time,
              completed: m.completed,
              aborted: m.aborted || undefined,
              // Only answer text and the step list (no reasoning, no raw tool output or error details).
              parts: (m.parts || [])
                .filter((p) => p.type === "text" || p.type === "tool")
                .map((p) =>
                  p.type === "text"
                    ? { id: p.id, type: "text", text: p.text }
                    : p.tool === QUESTION_TOOL
                      ? // Clarifying questions: read-only summary (a still-pending one shows as not answered).
                        { id: p.id, type: "tool", tool: p.tool, status: p.status, questions: p.questions, answers: p.answers, qstate: p.qstate === "pending" ? "stopped" : p.qstate, start: p.start, end: p.end }
                      : { id: p.id, type: "tool", tool: p.tool, status: p.status === "error" ? "error" : p.status, label: p.label, result: p.result, ...(p.step ? { step: p.step } : {}), ...(p.errorInfo ? { errorInfo: { code: p.errorInfo.code } } : {}), start: p.start, end: p.end, source: p.source, artifact: p.artifact, ...(p.draft ? { draft: p.draft } : {}), ...(p.card ? { card: p.card } : {}), ...(p.visual ? { visual: p.visual } : {}) },
                ),
            },
      )
      if (!messages.length) throw new HttpError(400, "Cuộc trò chuyện chưa có nội dung.")
      const token = newId(24)
      const now = Date.now()
      tx(() => {
        q("UPDATE shares SET revoked_at = ? WHERE chat_id = ? AND revoked_at IS NULL").run(now, chat.id)
        q("INSERT INTO shares (token, chat_id, user_id, title, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
          token, chat.id, req.user.id, chat.title, JSON.stringify({ messages, grounding: extras(chat, branch, messages).grounding || [] }), now)
      })
      res.status(201).json({ share: shareOut(q("SELECT * FROM shares WHERE token = ?").get(token), chat.title) })
    }),
  )

  app.get("/api/shares", requireUser, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100)
    const cur = decodeCursor(req.query.cursor)
    const rows = q(
      `SELECT s.*, c.title AS chat_title FROM shares s LEFT JOIN chats c ON c.id = s.chat_id
       WHERE s.user_id = ? AND s.revoked_at IS NULL AND (? IS NULL OR s.created_at < ? OR (s.created_at = ? AND s.token < ?))
       ORDER BY s.created_at DESC, s.token DESC LIMIT ?`,
    ).all(req.user.id, cur?.t ?? null, cur?.t ?? 0, cur?.t ?? 0, cur?.id ?? "", limit + 1)
    const page = rows.slice(0, limit)
    res.json({ shares: page.map((s) => shareOut(s, s.chat_title)), next: rows.length > limit ? encodeCursor(page.at(-1).created_at, page.at(-1).token) : null })
  })

  app.delete("/api/shares/:token", requireUser, (req, res) => {
    const r = q("UPDATE shares SET revoked_at = ? WHERE token = ? AND user_id = ? AND revoked_at IS NULL").run(Date.now(), String(req.params.token), req.user.id)
    if (!r.changes) return res.status(404).json({ error: "Không tìm thấy liên kết." })
    res.json({ ok: true })
  })

  /** Public, no login. */
  app.get("/api/public/shares/:token", (req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive")
    const token = String(req.params.token || "")
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return res.status(404).json({ error: "Không tìm thấy liên kết chia sẻ.", state: "notfound" })
    const s = q("SELECT * FROM shares WHERE token = ?").get(token)
    if (!s) return res.status(404).json({ error: "Không tìm thấy liên kết chia sẻ.", state: "notfound" })
    if (s.revoked_at) return res.status(410).json({ error: "Liên kết này đã bị thu hồi.", state: "revoked" })
    const snap = JSON.parse(s.snapshot)
    // Snapshots made before the output filter existed: scrub assistant text / steps on the way out, and never
    // include reasoning.
    const locale = resolveLocale(req)
    const sc = (v) => (typeof v === "string" ? scrubText(v, locale) : v)
    const messages = (snap.messages || []).map((m) =>
      m.role === "assistant"
        ? { ...m, parts: (m.parts || []).filter((p) => p.type !== "reasoning").map((p) => ({ ...p, text: sc(p.text), label: sc(p.label), result: sc(p.result), ...(p.artifact ? { artifact: { ...p.artifact, title: sc(p.artifact.title), ...(Array.isArray(p.artifact.changes) ? {} : { changes: (p.artifact.changesSummary || []).map((x) => parseChangeLine(sc(x), p.artifact.language === "en" ? "en" : "vi")) }) } } : {}) })) }
        : m,
    )
    res.json({ share: { title: s.title, createdAt: s.created_at, messages, grounding: snap.grounding || [], token } })
  })

  // ---- export ------------------------------------------------------------------------------------
  app.get(
    "/api/export",
    requireUser,
    wrap(async (req, res) => {
      const format = req.query.format === "json" ? "json" : "md"
      const locale = resolveLocale(req)
      const chats = q("SELECT * FROM chats WHERE user_id = ? ORDER BY created_at").all(req.user.id)
      const zip = new JSZip()
      const all = []
      for (const c of chats) {
        const b = activeBranch(c)
        let msgs = []
        try {
          msgs = convertHistory(await oc.request("GET", `/session/${encodeURIComponent(b.opencode_session_id)}/message`), states.get(b.opencode_session_id), { locale })
        } catch {}
        const clean = msgs.map((m) => ({
          role: m.role,
          time: m.time ? new Date(m.time).toISOString() : null,
          text: plainText(m, locale === "en" ? "File" : "Tệp"),
          ...(m.role === "assistant"
            ? { tools: (m.parts || []).filter((p) => p.type === "tool").map((p) => ({ tool: p.tool, label: p.label, status: p.status, result: p.result })), sources: (m.parts || []).filter((p) => p.source).map((p) => p.source) }
            : { attachments: m.attachments }),
        }))
        all.push({ id: c.id, title: c.title, createdAt: new Date(c.created_at).toISOString(), updatedAt: new Date(c.updated_at).toISOString(), versions: branchesOf(c.id).length, messages: clean })
        if (format === "md") {
          const slug = fold(c.title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "tro-chuyen"
          const md = [`# ${c.title}`, "", `_${tr(locale, "exportCreated", { date: fmtDateTime(c.created_at, locale) })}_`, ""]
          for (const m of clean) {
            md.push(`## ${m.role === "user" ? tr(locale, "exportYou") : tr(locale, "exportAssistant")}`, "", m.text || "", "")
            if (m.sources?.length) {
              const seen = new Set()
              md.push(`**${tr(locale, "exportSources")}**`, "")
              for (const s of m.sources) if (!seen.has(s.url) && seen.add(s.url)) md.push(`- ${s.title || s.url}${s.number ? ` (${s.number})` : ""} – ${s.url}`)
              md.push("")
            }
          }
          zip.file(`${new Date(c.created_at).toISOString().slice(0, 10)}-${slug}-${c.id.slice(2, 8)}.md`, md.join("\n"))
        }
      }
      if (format === "json") zip.file("chats.json", JSON.stringify({ exportedAt: new Date().toISOString(), user: req.user.email, chats: all }, null, 2))
      else zip.file("README.txt", tr(locale, "exportReadme", { date: fmtDateTime(Date.now(), locale), count: chats.length }))
      const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
      res.setHeader("Content-Type", "application/zip")
      res.setHeader("Content-Disposition", `attachment; filename="legalai-${format}-${new Date().toISOString().slice(0, 10)}.zip"`)
      res.end(buf)
    }),
  )

  return {
    runs,
    hub,
    deleteAllChats,
    deleteSessions,
    activeBranch,
    setExtras: (fn) => (extras = fn),
    setUnread: (fn) => (unreadOf = fn),
  }
}
