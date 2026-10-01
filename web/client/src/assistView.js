// Live view of an official page the user is asked to operate (assisted browsing, server/assist.mjs).
// Frames: WebSocket /api/chats/:id/assist/:aid/ws (binary JPEG + JSON meta/status) – WebSockets pass through the
// Cloudflare tunnel; if no frame arrives within 4 s (or the socket fails before the first frame) we switch to
// long-polled single frames (…/frame?after=<seq>&wait=1500, ~5–8 fps) and remember that for this browser session.
// Input (mouse / wheel / keys / text) goes up the socket, or as ordered POST …/input batches in poll mode.
// Testing: ?assistTransport=poll|ws in the page URL, or localStorage "legalai.assistTransport".
import { getLocale } from "./i18n.jsx"

const KEY = "legalai.assistTransport"
const WS_GRACE_MS = 4000
const POLL_WAIT_MS = 1500
const MIN_POLL_GAP_MS = 120

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// one live view per request in this tab: opening it again (re-render, reopen) closes the previous socket / poll loop
const openViews = new Map()
const read = (s) => {
  try {
    return window[s]?.getItem(KEY) || ""
  } catch {
    return ""
  }
}
function preferred() {
  let v = ""
  try {
    v = new URLSearchParams(window.location.search).get("assistTransport") || ""
  } catch {}
  v = v || read("localStorage") || read("sessionStorage")
  return v === "poll" || v === "ws" ? v : ""
}
const rememberPoll = () => {
  try {
    window.sessionStorage?.setItem(KEY, "poll")
  } catch {}
}
const headers = () => ({ "X-UI-Locale": getLocale() })

/**
 * Opens the live view. Callbacks: onFrame(blob, {w, h}), onMode("ws" | "poll"), onStatus(assist) when the server
 * reports a new status, onGone(status) when the request no longer waits (404 / 410). Returns { send(events), close() }.
 */
export function openAssistView(chatId, assistId, { onFrame, onMode, onStatus, onGone } = {}) {
  const base = `/api/chats/${encodeURIComponent(chatId)}/assist/${encodeURIComponent(assistId)}`
  let closed = false
  let ws = null
  let meta = { w: 1200, h: 800 }
  let seq = 0
  let queue = []
  let flushTimer = null
  let chain = Promise.resolve()
  let ctrl = null
  let wsFails = 0
  openViews.get(assistId)?.close()

  function startWs() {
    onMode?.("ws")
    let got = false
    try {
      ws = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${base}/ws`)
    } catch {
      return startPoll()
    }
    ws.binaryType = "blob"
    const grace = setTimeout(() => {
      if (got || closed) return
      rememberPoll()
      const s = ws
      ws = null
      s?.close()
      startPoll()
    }, WS_GRACE_MS)
    ws.onmessage = (m) => {
      if (typeof m.data === "string") {
        let d = null
        try {
          d = JSON.parse(m.data)
        } catch {}
        if (d?.type === "meta" && d.w > 0 && d.h > 0) meta = { w: d.w, h: d.h }
        if (d?.type === "status" && d.assist) onStatus?.(d.assist)
        return
      }
      got = true
      wsFails = 0
      clearTimeout(grace)
      onFrame?.(m.data, meta)
    }
    const sock = ws
    ws.onclose = (e) => {
      clearTimeout(grace)
      if (ws !== sock) return // replaced by the poll fallback
      ws = null
      if (closed) return
      if (!got) {
        // refused (404 / 410 / 403) or blocked by a proxy: polling tells which
        rememberPoll()
        return startPoll()
      }
      if (e.code === 1000) return onGone?.() // request finished
      // dropped: reconnect with backoff; after 3 drops in a row use polling
      wsFails++
      if (wsFails >= 3) return startPoll()
      setTimeout(() => !closed && startWs(), 1000 * 2 ** wsFails)
    }
  }

  async function startPoll() {
    onMode?.("poll")
    let backoff = 0
    while (!closed) {
      const t0 = Date.now()
      ctrl = new AbortController()
      try {
        const r = await fetch(`${base}/frame?after=${seq}&wait=${POLL_WAIT_MS}`, { credentials: "same-origin", headers: headers(), signal: ctrl.signal })
        if (r.status === 200 || r.status === 204) backoff = 0
        if (r.status === 200) {
          seq = Number(r.headers.get("X-Frame-Seq")) || seq
          const w = Number(r.headers.get("X-Frame-W")), h = Number(r.headers.get("X-Frame-H"))
          if (w > 0 && h > 0) meta = { w, h }
          const blob = await r.blob()
          if (!closed) onFrame?.(blob, meta)
        } else if (r.status === 404 || r.status === 410) {
          const d = await r.json().catch(() => null)
          if (!closed) onGone?.(d?.status)
          return
        } else if (r.status !== 204) {
          // 429 (too many views) / 5xx: back off, never show the response body
          backoff = Math.min(8000, backoff ? backoff * 2 : 1000)
          await sleep(backoff)
        }
      } catch {
        if (closed) return
        backoff = Math.min(8000, backoff ? backoff * 2 : 1000)
        await sleep(backoff)
      }
      const dt = Date.now() - t0
      if (dt < MIN_POLL_GAP_MS) await sleep(MIN_POLL_GAP_MS - dt)
    }
  }

  function flush() {
    flushTimer = null
    if (!queue.length || closed) return
    const batch = queue.splice(0, 60)
    if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "in", ev: batch }))
    else {
      const body = JSON.stringify({ ev: batch })
      chain = chain.then(() =>
        fetch(`${base}/input`, { method: "POST", credentials: "same-origin", headers: { ...headers(), "Content-Type": "application/json" }, body }).catch(() => {}),
      )
    }
    if (queue.length) flushTimer = setTimeout(flush, 30)
  }
  function send(events) {
    if (closed || !events?.length) return
    queue.push(...events)
    if (ws?.readyState === 1) flush()
    else flushTimer ||= setTimeout(flush, 30)
  }

  if (preferred() === "poll") startPoll()
  else startWs()
  const handle = {
    send,
    close() {
      if (openViews.get(assistId) === handle) openViews.delete(assistId)
      closed = true
      clearTimeout(flushTimer)
      ws?.close()
      ws = null
      ctrl?.abort()
    },
  }
  openViews.set(assistId, handle)
  return handle
}
