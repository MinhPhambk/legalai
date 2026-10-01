// Assisted browsing on official sites – web side ("trợ giúp của người dùng trên trang chính thức").
// Tool side: ../../.opencode/lib/assist.ts (file protocol documented there). When a tool needs the user to pass the
// human check of an official page (CAPTCHA), it opens the page in an isolated tab of the sandbox Chrome and writes
// <outputs>/<sessionID>/assist/<assistId>.json. This module
//  • watches those files (fs.watch + a poll of sessions with a running tool) and sends an `assist` event to the chat's
//    event stream (only the chat owner's connections are in the hub – admin read-only views and share pages never);
//  • relays a live view of that one tab to the owner: CDP Page.startScreencast (JPEG q60, ≤ 1200 px) over a
//    WebSocket (/api/chats/:id/assist/:aid/ws) or, as a fallback, long-polled single frames (…/frame?after=);
//  • forwards the owner's mouse / wheel / keyboard / pasted text to that tab (CDP Input.dispatch*), validated and
//    rate-limited, only while the request is waiting for the user; …/cancel marks it cancelled.
// Frames live in memory only (latest frame per request), never on disk; the view stops when nobody watches.
import fs from "node:fs"
import path from "node:path"
import { ROOT, config } from "./config.mjs"
import { q } from "./db.mjs"
import { COOKIE, parseCookies, requireUser, userForToken } from "./auth.mjs"

const OUTPUT_DIR = process.env.LEGALAI_OUTPUTS_DIR ? path.resolve(process.env.LEGALAI_OUTPUTS_DIR) : path.join(ROOT, ".sandbox", "outputs")
const CHROME_PORT = process.env.CHROME_PORT || "9333"
export const ASSIST_ID_RE = /^a-\d{8}-[0-9a-f]{8}$/
const SESSION_RE = /^[A-Za-z0-9_-]{1,80}$/
const CHAT_RE = /^[A-Za-z0-9_-]{1,64}$/
const TARGET_RE = /^[0-9A-Fa-f]{16,64}$/
const PURPOSES = new Set(["company_lookup", "company_verify"])
const SOURCES = new Set(["gdt", "dkkd", "test"])
const STATUSES = new Set(["waiting_user", "done", "cancelled", "timeout", "error"])
const OFFICIAL_HOST = /(^|\.)(dkkd\.gov\.vn|dangkykinhdoanh\.gov\.vn|gdt\.gov\.vn)$/i
// harness only: host:port of a local stand-in page (never set in production)
const testHosts = () => String(process.env.WEB_ASSIST_TEST_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
const PAGE_ERRORS = new Set(["rate_limited", "server_error", "http_error"])
export const RELOAD_GAP_MS = 15_000 // same gap as the tool (../../.opencode/lib/assist.ts)
const STALE_MS = 15_000 // a waiting request past its expiry (+ this) whose tool died counts as timed out
const LIST_WINDOW = 2 * 3600_000

export function allowedUrl(raw) {
  try {
    const u = new URL(raw)
    return (u.protocol === "https:" && OFFICIAL_HOST.test(u.hostname)) || testHosts().includes(u.host.toLowerCase())
  } catch {
    return false
  }
}

// ---- files ---------------------------------------------------------------------------------------
const dirOf = (sid) => path.join(OUTPUT_DIR, sid, "assist")
export function readAssist(sid, aid) {
  if (!SESSION_RE.test(String(sid || "")) || !ASSIST_ID_RE.test(String(aid || ""))) return null
  for (let i = 0; i < 3; i++) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dirOf(sid), `${aid}.json`), "utf8"))
      return a && a.assistId === aid && a.sessionID === sid ? a : null
    } catch (e) {
      if (e.code === "ENOENT") return null // being replaced (rename) → retry a JSON error only
    }
  }
  return null
}
function listAssists(sid) {
  let names = []
  try {
    names = fs.readdirSync(dirOf(sid))
  } catch {
    return []
  }
  return names.map((n) => n.match(/^(a-\d{8}-[0-9a-f]{8})\.json$/)?.[1]).filter(Boolean).map((aid) => readAssist(sid, aid)).filter(Boolean)
}
/** Effective status: a waiting request well past its expiry (tool process gone) is shown as timed out. */
const statusOf = (a) => (a.status === "waiting_user" && Date.now() > Number(a.expiresAt || 0) + STALE_MS ? "timeout" : STATUSES.has(a.status) ? a.status : "error")
const focusOf = (a) => {
  const f = a.focus
  const n = (v, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(-100, Math.round(Number(v)))) : null)
  if (!f || typeof f !== "object") return null
  const o = { x: n(f.x, 4000), y: n(f.y, 4000), w: n(f.w, 4000), h: n(f.h, 4000) }
  return Object.values(o).every((v) => v != null) ? o : null
}
/** What a browser may see: codes, host, times – never the target id, session id or file paths. */
export function publicAssist(a) {
  let host = ""
  try {
    host = new URL(a.url).hostname.replace(/^www\./, "")
  } catch {}
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : undefined)
  const out = {
    assistId: a.assistId,
    host: /^[a-z0-9.-]{1,120}(:\d{1,5})?$/i.test(host) ? host : "",
    purpose: PURPOSES.has(a.purpose) ? a.purpose : "company_lookup",
    source: SOURCES.has(a.source) ? a.source : undefined,
    status: statusOf(a),
    createdAt: num(a.createdAt),
    expiresAt: num(a.expiresAt),
    ...(num(a.doneAt) ? { doneAt: num(a.doneAt) } : {}),
    ...(allowedUrl(a.openUrl) ? { openUrl: new URL(a.openUrl).href } : {}),
    ...(typeof a.notice === "string" && a.notice.trim() ? { notice: a.notice.replace(/[\u0000-\u001f<>]+/g, " ").trim().slice(0, 200) } : {}),
    ...(typeof a.notice === "string" && a.notice.trim() && num(a.noticeAt) ? { noticeAt: num(a.noticeAt) } : {}),
    ...(num(a.blockedNav) ? { blockedNav: Math.min(num(a.blockedNav), 999) } : {}),
    ...(PAGE_ERRORS.has(a.pageError) ? { pageError: a.pageError, ...(num(a.pageStatus) ? { pageStatus: num(a.pageStatus) } : {}), ...(num(a.pageErrorAt) ? { pageErrorAt: num(a.pageErrorAt) } : {}) } : {}),
    ...(num(a.reloadAt) ? { reloadAt: num(a.reloadAt) } : {}),
    ...(focusOf(a) ? { focus: focusOf(a) } : {}),
  }
  return out
}
/** Mark a waiting request cancelled (atomic replace, retried while the tool reads it). */
function writeCancel(sid, aid) {
  const a = readAssist(sid, aid)
  if (!a || statusOf(a) !== "waiting_user") return a
  return writeState(sid, aid, { ...a, status: "cancelled", updatedAt: Date.now(), reason: "user" })
}
/** The user asks the tool to load the official form again (after an error page of the site). */
function writeReload(sid, aid) {
  const a = readAssist(sid, aid)
  if (!a || statusOf(a) !== "waiting_user") return { a, ok: false }
  const wait = (Number(a.reloadAt) || 0) + RELOAD_GAP_MS - Date.now()
  if (wait > 0) return { a, ok: false, retryAfter: Math.ceil(wait / 1000) }
  return { a: writeState(sid, aid, { ...a, reloadAt: Date.now(), updatedAt: Date.now() }), ok: true }
}
function writeState(sid, aid, next) {
  const f = path.join(dirOf(sid), `${aid}.json`)
  const tmp = `${f}.web${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next))
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, f)
      break
    } catch (e) {
      if (i >= 20) {
        fs.rmSync(tmp, { force: true })
        throw e
      }
      const until = Date.now() + 25
      while (Date.now() < until) {}
    }
  }
  return next
}

// ---- CDP (one browser-level connection, flat sessions) ------------------------------------------
class Cdp {
  constructor() {
    this.ws = null
    this.opening = null
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map() // sessionId -> fn(method, params)
    this.onDetach = new Set()
  }
  async open() {
    if (this.ws?.readyState === 1) return
    if (this.opening) return this.opening
    this.opening = (async () => {
      const v = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json())
      const url = String(v.webSocketDebuggerUrl || "")
      if (!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//.test(url)) throw new Error("no local DevTools endpoint")
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(url)
        const t = setTimeout(() => reject(new Error("CDP connect timeout")), 5000)
        ws.onopen = () => {
          clearTimeout(t)
          this.ws = ws
          resolve()
        }
        ws.onerror = () => {
          clearTimeout(t)
          reject(new Error("CDP connect failed"))
        }
        ws.onclose = () => {
          if (this.ws === ws) this.ws = null
          for (const [, p] of this.pending) p.reject(new Error("CDP closed"))
          this.pending.clear()
          for (const [sid, fn] of this.handlers) fn("Inspector.detached", { sessionId: sid })
          this.handlers.clear()
        }
        ws.onmessage = (m) => this.#message(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString("utf8"))
      })
    })()
    try {
      await this.opening
    } finally {
      this.opening = null
    }
  }
  #message(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      return msg.error ? p.reject(new Error(msg.error.message || "CDP error")) : p.resolve(msg.result || {})
    }
    if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) {
      this.handlers.get(msg.params.sessionId)?.("Inspector.detached", msg.params)
      this.handlers.delete(msg.params.sessionId)
      return
    }
    if (msg.sessionId) this.handlers.get(msg.sessionId)?.(msg.method, msg.params || {})
  }
  async send(method, params = {}, sessionId) {
    await this.open()
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout`))
      }, 10_000)
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
}

// ---- input validation ------------------------------------------------------------------------------
const BUTTONS = { left: 1, right: 2, middle: 4, none: 0 }
const clamp01 = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : null)
const CTRL_OK = new Set(["a", "c", "v", "x", "z", "y"])
/**
 * One input event from the browser → a CDP command { method, params }, or null when invalid / not allowed.
 * Coordinates arrive as fractions of the mirrored frame (0..1) and are scaled to the page's CSS viewport.
 */
export function toCdp(e, vp) {
  if (!e || typeof e !== "object") return null
  const mod = Number.isInteger(e.mod) && e.mod >= 0 && e.mod <= 15 ? e.mod : 0
  if (e.t === "m" || e.t === "w") {
    const fx = clamp01(e.x), fy = clamp01(e.y)
    if (fx == null || fy == null) return null
    const x = Math.round(fx * vp.width * 10) / 10, y = Math.round(fy * vp.height * 10) / 10
    if (e.t === "w") {
      const d = (v) => (Number.isFinite(Number(v)) ? Math.max(-2000, Math.min(2000, Number(v))) : 0)
      return { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x, y, deltaX: d(e.dx), deltaY: d(e.dy), modifiers: mod } }
    }
    const type = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" }[e.k]
    if (!type) return null
    const button = Object.hasOwn(BUTTONS, e.b) ? e.b : "none"
    const clickCount = Number.isInteger(e.c) && e.c >= 0 && e.c <= 3 ? e.c : type === "mouseMoved" ? 0 : 1
    const buttons = type === "mouseReleased" ? 0 : BUTTONS[button]
    return { method: "Input.dispatchMouseEvent", params: { type, x, y, button, buttons, clickCount, modifiers: mod } }
  }
  if (e.t === "k") {
    const key = typeof e.key === "string" && e.key.length >= 1 && e.key.length <= 24 ? e.key : null
    if (!key || !["down", "up"].includes(e.k)) return null
    const code = typeof e.code === "string" && /^[A-Za-z0-9]{0,24}$/.test(e.code) ? e.code : ""
    const kc = Number.isInteger(e.kc) && e.kc >= 0 && e.kc <= 255 ? e.kc : 0
    if (/^F\d{1,2}$/.test(key)) return null // function keys (reload, devtools…) are not forwarded
    if (mod & 6 && !CTRL_OK.has(key.toLowerCase())) return null // Ctrl / Meta: only edit shortcuts
    const base = { key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers: mod }
    if (e.k === "up") return { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...base } }
    const text = key === "Enter" ? "\r" : key.length === 1 && !(mod & 6) ? key : ""
    return { method: "Input.dispatchKeyEvent", params: text ? { type: "keyDown", ...base, text, unmodifiedText: text } : { type: "rawKeyDown", ...base } }
  }
  if (e.t === "text") {
    const v = typeof e.v === "string" ? e.v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 200) : ""
    return v ? { method: "Input.insertText", params: { text: v } } : null
  }
  return null
}

// ---- live view of one assist tab ---------------------------------------------------------------------
class AssistView {
  constructor(cdp, a, onEnd) {
    this.cdp = cdp
    this.aid = a.assistId
    this.sid = a.sessionID
    this.targetId = a.targetId
    this.contextId = a.contextId
    this.vp = { width: Number(a.viewport?.width) || 1200, height: Number(a.viewport?.height) || 800 }
    this.session = null
    this.starting = null
    this.frame = null // { seq, buf, w, h }
    this.seq = 0
    this.subs = new Set()
    this.waiters = new Set()
    this.touched = Date.now()
    this.ended = false
    this.onEnd = onEnd
    this.tokens = 120
    this.refillAt = Date.now()
  }
  /** Attach to the tab after checking it is the isolated assist tab of this request. */
  start() {
    if (this.session) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = (async () => {
      if (!TARGET_RE.test(String(this.targetId || ""))) throw new Error("bad target")
      const { targetInfo: ti } = await this.cdp.send("Target.getTargetInfo", { targetId: this.targetId })
      const { browserContextIds = [] } = await this.cdp.send("Target.getBrowserContexts")
      // an isolated (non-default) context, the one the tool created, on an allowed page
      if (ti?.type !== "page" || !ti.browserContextId || ti.browserContextId !== this.contextId || !browserContextIds.includes(ti.browserContextId)) throw new Error("target mismatch")
      if (ti.url !== "about:blank" && !allowedUrl(ti.url)) throw new Error("target not on an allowed page")
      const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId: this.targetId, flatten: true })
      this.session = sessionId
      this.cdp.handlers.set(sessionId, (method, p) => this.#event(method, p))
      await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {})
      await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1200, maxHeight: 1200, everyNthFrame: 1 }, sessionId)
    })()
    return this.starting.finally(() => (this.starting = null))
  }
  #event(method, p) {
    if (method === "Page.screencastFrame") {
      this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, this.session).catch(() => {})
      const m = p.metadata || {}
      if (m.deviceWidth > 0 && m.deviceHeight > 0) this.vp = { width: m.deviceWidth, height: m.deviceHeight }
      this.frame = { seq: ++this.seq, buf: Buffer.from(p.data, "base64"), w: this.vp.width, h: this.vp.height }
      for (const fn of this.subs) fn(this.frame)
      for (const w of this.waiters) w()
      return
    }
    if (method === "Inspector.detached" || method === "Target.targetDestroyed") this.end("closed")
  }
  touch() {
    this.touched = Date.now()
  }
  /** Resolves with the frame newer than `after`, or null after `ms`. */
  next(after, ms) {
    if (this.frame && this.frame.seq > after) return Promise.resolve(this.frame)
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t)
        this.waiters.delete(done)
        resolve(this.frame && this.frame.seq > after ? this.frame : null)
      }
      const t = setTimeout(done, ms)
      this.waiters.add(done)
    })
  }
  /** Rate limit: 120-event bucket, refilled 60 / s. Returns how many of `n` may pass. */
  take(n) {
    const now = Date.now()
    this.tokens = Math.min(120, this.tokens + ((now - this.refillAt) / 1000) * 60)
    this.refillAt = now
    const k = Math.min(n, Math.floor(this.tokens))
    this.tokens -= k
    return k
  }
  async input(events) {
    if (this.ended) return { sent: 0, dropped: events.length }
    await this.start()
    const allowed = this.take(events.length)
    let sent = 0
    for (const e of events.slice(0, allowed)) {
      const cmd = toCdp(e, this.vp)
      if (!cmd) continue
      await this.cdp.send(cmd.method, cmd.params, this.session).catch(() => {})
      sent++
    }
    this.touch()
    return { sent, dropped: events.length - sent }
  }
  end(reason) {
    if (this.ended) return
    this.ended = true
    for (const w of this.waiters) w()
    if (this.session) {
      const s = this.session
      this.cdp.handlers.delete(s)
      this.cdp.send("Page.stopScreencast", {}, s).catch(() => {})
      this.cdp.send("Target.detachFromTarget", { sessionId: s }).catch(() => {})
    }
    this.frame = null // frames are never kept after the view ends
    this.onEnd?.(this, reason)
  }
}

// ---- routes, watcher, WebSocket ---------------------------------------------------------------------
export function registerAssistRoutes(app, { oc, hub, json }) {
  const cdp = new Cdp()
  const views = new Map() // assistId -> AssistView
  const subscribers = new Map() // assistId -> Set<fn(publicAssist)> (WebSocket viewers)
  const sessionChat = new Map() // sessionID -> { chatId, at }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const branchSessions = (chatId) => q("SELECT opencode_session_id AS sid FROM branches WHERE chat_id = ?").all(chatId).map((r) => r.sid)
  /** chat of a session: a branch session, or a sub-agent session whose parent is one (looked up once, cached). */
  async function chatOfSession(sid, depth = 0) {
    const b = q("SELECT chat_id FROM branches WHERE opencode_session_id = ?").get(sid)
    if (b) return b.chat_id
    const c = sessionChat.get(sid)
    if (c && (c.chatId || Date.now() - c.at < 60_000)) return c.chatId
    let chatId = null
    if (depth < 3) {
      try {
        const s = await oc.request("GET", `/session/${encodeURIComponent(sid)}`, undefined, { timeoutMs: 4000 })
        if (s?.parentID && SESSION_RE.test(s.parentID)) chatId = await chatOfSession(s.parentID, depth + 1)
      } catch {}
    }
    sessionChat.set(sid, { chatId, at: Date.now() })
    return chatId
  }
  const sessionsOfChat = (chatId) => [...new Set([...branchSessions(chatId), ...[...sessionChat].filter(([, v]) => v.chatId === chatId).map(([k]) => k)])]

  /** The request `aid` of chat `chatId` owned by `user` (null → 404 for everyone else, admins included). */
  function assistFor(user, chatId, aid) {
    if (!user || !CHAT_RE.test(String(chatId || "")) || !ASSIST_ID_RE.test(String(aid || ""))) return null
    const chat = q("SELECT id FROM chats WHERE id = ? AND user_id = ?").get(chatId, user.id)
    if (!chat) return null
    for (const sid of sessionsOfChat(chat.id)) {
      const a = readAssist(sid, aid)
      if (a) return { chatId: chat.id, sid, a }
    }
    return null
  }
  const notFound = (res) => res.status(404).json({ error: "Không tìm thấy yêu cầu xác minh." })
  const gone = (res, a) => res.status(410).json({ error: "Yêu cầu xác minh không còn chờ.", status: statusOf(a) })

  function viewFor(a) {
    let v = views.get(a.assistId)
    if (v && !v.ended) return v
    v = new AssistView(cdp, a, (view) => {
      if (views.get(view.aid) === view) views.delete(view.aid)
    })
    views.set(a.assistId, v)
    return v
  }
  // stop views nobody looks at, and views of requests that are no longer waiting
  setInterval(() => {
    for (const v of views.values()) {
      const a = readAssist(v.sid, v.aid)
      if (!a || statusOf(a) !== "waiting_user") v.end("status")
      else if (!v.subs.size && Date.now() - v.touched > 20_000) v.end("idle")
    }
  }, 5000).unref()

  // ---- watcher: status file → `assist` event for the chat (owner connections only) ----
  const known = new Map() // `${sid}/${aid}` -> signature
  const lastPageError = new Map()
  const active = new Map() // sid -> scan until
  async function emit(sid, a) {
    const pub = publicAssist(a)
    if (pub.pageError && pub.pageError !== lastPageError.get(a.assistId)) console.warn(`[assist] ${a.assistId} official page error: ${pub.pageError}${pub.pageStatus ? ` (HTTP ${pub.pageStatus})` : ""} on ${pub.host}`)
    lastPageError.set(a.assistId, pub.pageError)
    for (const fn of subscribers.get(a.assistId) || []) fn(pub)
    if (pub.status !== "waiting_user") views.get(a.assistId)?.end("status")
    const chatId = await chatOfSession(sid)
    if (chatId) hub.broadcast(chatId, { type: "assist", assist: pub })
  }
  function scan(sid) {
    for (const a of listAssists(sid)) {
      const sig = [statusOf(a), a.updatedAt, a.notice || "", a.noticeAt || 0, a.blockedNav || 0, a.pageError || "", a.reloadAt || 0].join("|")
      const k = `${sid}/${a.assistId}`
      if (known.get(k) === sig) continue
      known.set(k, sig)
      emit(sid, a).catch((e) => console.warn("[assist] emit failed:", e.message))
    }
  }
  oc.onAny((ev) => {
    if (ev.type !== "message.part.updated" || ev.webInjected) return
    const p = ev.properties?.part
    if (p?.type !== "tool" || !SESSION_RE.test(String(p.sessionID || ""))) return
    const st = p.state?.status
    active.set(p.sessionID, Date.now() + (st === "running" || st === "pending" ? 20 * 60_000 : 30_000))
  })
  try {
    fs.watch(OUTPUT_DIR, { recursive: true }, (_e, name) => {
      const m = String(name || "").match(/^([A-Za-z0-9_-]{1,80})[\\/]assist[\\/]a-\d{8}-[0-9a-f]{8}\.json$/)
      if (!m) return
      active.set(m[1], Math.max(active.get(m[1]) || 0, Date.now() + 20 * 60_000))
      setTimeout(() => scan(m[1]), 30)
    }).on("error", () => {})
  } catch (e) {
    console.warn("[assist] fs.watch unavailable, polling only:", e.message)
  }
  setInterval(() => {
    const now = Date.now()
    // bounded memory: forget the oldest signatures (a re-scan only re-emits the current state)
    if (known.size > 5000) for (const k of [...known.keys()].slice(0, 1000)) known.delete(k)
    for (const [sid, until] of active) {
      if (now > until) active.delete(sid)
      else scan(sid)
    }
    // a waiting request that outlived its tool (expired): tell the page once
    for (const [k, sig] of known) if (sig.startsWith("waiting_user|")) {
      const [sid, aid] = k.split("/")
      const a = readAssist(sid, aid)
      if (a && statusOf(a) !== "waiting_user") scan(sid)
    }
  }, 700).unref()

  // ---- HTTP API (owner only) ----
  app.get("/api/chats/:id/assist", requireUser, async (req, res) => {
    const chat = q("SELECT id FROM chats WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user.id)
    if (!chat) return res.status(404).json({ error: "Không tìm thấy cuộc trò chuyện." })
    const since = Date.now() - LIST_WINDOW
    const list = sessionsOfChat(chat.id).flatMap(listAssists).filter((a) => Number(a.createdAt) > since).map(publicAssist)
    res.json({ assists: list.sort((a, b) => a.createdAt - b.createdAt).slice(-20) })
  })
  app.post("/api/chats/:id/assist/:aid/cancel", requireUser, (req, res) => {
    const r = assistFor(req.user, String(req.params.id), String(req.params.aid))
    if (!r) return notFound(res)
    const a = writeCancel(r.sid, r.a.assistId)
    scan(r.sid)
    res.json({ assist: publicAssist(a) })
  })
  app.post("/api/chats/:id/assist/:aid/reload", requireUser, (req, res) => {
    const r = assistFor(req.user, String(req.params.id), String(req.params.aid))
    if (!r) return notFound(res)
    const out = writeReload(r.sid, r.a.assistId)
    if (!out.ok && out.retryAfter) return res.status(429).set("Retry-After", String(out.retryAfter)).json({ error: "Vui lòng chờ trước khi tải lại trang chính thức.", retryAfter: out.retryAfter })
    if (!out.ok) return gone(res, out.a || r.a)
    scan(r.sid)
    res.json({ assist: publicAssist(out.a) })
  })
  // long-poll frames (fallback when WebSockets do not get through)
  const framePolls = new Map() // userId -> in flight
  app.get("/api/chats/:id/assist/:aid/frame", requireUser, async (req, res) => {
    const r = assistFor(req.user, String(req.params.id), String(req.params.aid))
    if (!r) return notFound(res)
    if (statusOf(r.a) !== "waiting_user") return gone(res, r.a)
    const n = framePolls.get(req.user.id) || 0
    if (n >= 4) return res.status(429).json({ error: "Quá nhiều kết nối đồng thời." })
    framePolls.set(req.user.id, n + 1)
    try {
      const v = viewFor(r.a)
      v.touch()
      await v.start()
      const after = Math.max(0, Number(req.query.after) || 0)
      const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), 2000)
      const f = await v.next(after, wait)
      if (res.destroyed) return
      if (!f) return res.status(204).end()
      res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Frame-Seq": String(f.seq), "X-Frame-W": String(f.w), "X-Frame-H": String(f.h) })
      res.end(f.buf)
    } catch (e) {
      console.warn("[assist] view failed:", e.message)
      if (!res.headersSent) res.status(503).json({ error: "Không mở được khung xem trang chính thức." })
    } finally {
      const m = (framePolls.get(req.user.id) || 1) - 1
      if (m > 0) framePolls.set(req.user.id, m)
      else framePolls.delete(req.user.id)
    }
  })
  app.post("/api/chats/:id/assist/:aid/input", requireUser, json, async (req, res) => {
    const r = assistFor(req.user, String(req.params.id), String(req.params.aid))
    if (!r) return notFound(res)
    if (statusOf(r.a) !== "waiting_user") return gone(res, r.a)
    const ev = req.body?.ev
    if (!Array.isArray(ev) || ev.length > 60) return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
    try {
      const out = await viewFor(r.a).input(ev)
      res.status(out.sent || !ev.length ? 200 : 429).json(out)
    } catch (e) {
      console.warn("[assist] input failed:", e.message)
      res.status(503).json({ error: "Không mở được khung xem trang chính thức." })
    }
  })

  // ---- WebSocket live view: binary JPEG frames + JSON {type:"meta"|"status"} down, {t:"in", ev:[…]} up ----
  let wss = null
  const wsLoad = import("ws")
    .then((m) => (wss = new (m.WebSocketServer || m.default.Server)({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })))
    .catch((e) => console.warn("[assist] WebSocket support unavailable (long-poll only):", e.message))
  const wsCount = new Map()
  const reject = (socket, code, text, why = "") => {
    if (code !== 404) console.warn(`[assist] WebSocket rejected ${code} ${text}${why ? ` – ${why}` : ""}`)
    try {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } catch {}
    socket.destroy()
  }
  /** http server "upgrade" handler; returns false when the URL is not ours. */
  function upgrade(req, socket, head) {
    let u
    try {
      u = new URL(req.url, "http://x")
    } catch {
      return false
    }
    const m = u.pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]{1,64})\/assist\/(a-\d{8}-[0-9a-f]{8})\/ws$/)
    if (!m) return false
    ;(async () => {
      await wsLoad
      if (!wss) return reject(socket, 503, "Service Unavailable")
      // same-origin only (cross-site WebSocket hijacking): Origin host must be the Host we are served as
      const loop = /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || "")
      const host = String((loop && req.headers["x-forwarded-host"]) || req.headers.host || "").split(",")[0].trim()
      let originOk = false
      try {
        originOk = !!req.headers.origin && new URL(req.headers.origin).host === host
      } catch {}
      if (!originOk) return reject(socket, 403, "Forbidden")
      const user = userForToken(parseCookies(req.headers.cookie || "")[COOKIE])
      if (!user) return reject(socket, 401, "Unauthorized")
      const r = assistFor(user, m[1], m[2])
      if (!r) return reject(socket, 404, "Not Found")
      if (statusOf(r.a) !== "waiting_user") return reject(socket, 410, "Gone")
      const n = wsCount.get(user.id) || 0
      if (n >= 4) return reject(socket, 429, "Too Many Requests", `user ${String(user.id).slice(0, 6)}… has ${n} live views open (${m[2]})`)
      wss.handleUpgrade(req, socket, head, (ws) => liveSocket(ws, user, r))
    })().catch((e) => {
      console.warn("[assist] upgrade failed:", e.message)
      reject(socket, 500, "Internal Server Error")
    })
    return true
  }
  function liveSocket(ws, user, r) {
    wsCount.set(user.id, (wsCount.get(user.id) || 0) + 1)
    const v = viewFor(r.a)
    let lastSent = 0, lastMeta = "", pendingFrame = null, timer = null, closed = false
    const sendFrame = (f) => {
      if (closed || ws.readyState !== 1) return
      if (ws.bufferedAmount > 1_500_000) return void (pendingFrame = f) // slow link: keep only the newest
      const wait = 60 - (Date.now() - lastSent) // ≤ ~16 frames / s per viewer
      if (wait > 0) {
        pendingFrame = f
        timer ||= setTimeout(() => {
          timer = null
          const p = pendingFrame
          pendingFrame = null
          if (p) sendFrame(p)
        }, wait)
        return
      }
      const meta = `${f.w}x${f.h}`
      if (meta !== lastMeta) {
        lastMeta = meta
        ws.send(JSON.stringify({ type: "meta", w: f.w, h: f.h }))
      }
      ws.send(f.buf, { binary: true })
      lastSent = Date.now()
    }
    const onStatus = (pub) => {
      if (closed) return
      ws.send(JSON.stringify({ type: "status", assist: pub }))
      if (pub.status !== "waiting_user") ws.close(1000, "done")
    }
    const subs = subscribers.get(r.a.assistId) || new Set()
    subscribers.set(r.a.assistId, subs)
    subs.add(onStatus)
    v.subs.add(sendFrame)
    const cleanup = () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      v.subs.delete(sendFrame)
      subs.delete(onStatus)
      if (!subs.size) subscribers.delete(r.a.assistId)
      v.touch()
      const k = (wsCount.get(user.id) || 1) - 1
      if (k > 0) wsCount.set(user.id, k)
      else wsCount.delete(user.id)
    }
    ws.on("close", cleanup)
    ws.on("error", cleanup)
    ws.on("message", async (data, isBinary) => {
      if (isBinary) return
      let msg
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      if (msg?.t === "ping") return ws.send(JSON.stringify({ type: "pong" }))
      if (msg?.t !== "in" || !Array.isArray(msg.ev) || msg.ev.length > 60) return
      const a = readAssist(r.sid, r.a.assistId)
      if (!a || statusOf(a) !== "waiting_user") return onStatus(publicAssist(a || r.a))
      await v.input(msg.ev).catch(() => {})
    })
    v.start()
      .then(() => v.frame && sendFrame(v.frame))
      .catch((e) => {
        console.warn("[assist] view failed:", e.message)
        if (!closed) ws.close(1011, "view unavailable")
      })
  }

  return { upgrade, views, scan, readAssist, enabled: config.assist }
}
