// Live chat events over SSE, or long polling when a proxy holds the stream back.
// Some proxies (e.g. the Cloudflare quick tunnel) deliver a streamed response only once it ends, so an
// EventSource there stays silent. We start with SSE; if nothing (not even "ready") arrives within 3 s,
// or the stream errors, we switch to GET /api/chats/:id/poll (each response ends, so it gets through)
// and remember that for the rest of the browser session. Events are passed through untouched.
//
// Testing: ?transport=poll|sse in the page URL, or localStorage "legalai.transport" = "poll" | "sse".
import { getLocale } from "./i18n.jsx"

const KEY = "legalai.transport"
const SSE_GRACE_MS = 3000
const POLL_WAIT_S = 25
const POLL_TIMEOUT_MS = (POLL_WAIT_S + 15) * 1000

const store = (s) => {
  try {
    return window[s]
  } catch {
    return null
  }
}
const read = (s) => {
  try {
    return store(s)?.getItem(KEY) || ""
  } catch {
    return ""
  }
}
/** "poll" | "sse" forced for testing, else "" (auto). */
function forced() {
  let v = ""
  try {
    v = new URLSearchParams(window.location.search).get("transport") || ""
  } catch {}
  v = v || read("localStorage")
  return v === "poll" || v === "sse" ? v : ""
}
const remembered = () => read("sessionStorage") === "poll"
function rememberPoll() {
  try {
    store("sessionStorage")?.setItem(KEY, "poll")
  } catch {}
}

/** Transport currently in use for new chats ("sse" | "poll"), for diagnostics. */
export const preferredTransport = () => forced() || (remembered() ? "poll" : "sse")

/**
 * Opens the event stream of a chat. `onEvent(ev)` gets every event object; `onStatus(s)` gets
 * "up" | "reconnecting" | "down" (transport health). Returns { close(), transport }.
 */
export function openChatStream(id, { onEvent, onStatus }) {
  const url = `/api/chats/${encodeURIComponent(id)}`
  let closed = false
  let es = null
  let ctrl = null
  let timer = null
  const handle = { transport: "sse", close }

  function close() {
    closed = true
    clearTimeout(timer)
    es?.close()
    ctrl?.abort()
  }

  function startSse() {
    handle.transport = "sse"
    const only = forced() === "sse"
    es = new EventSource(`${url}/events`)
    let got = false
    // Nothing within the grace period: a buffering proxy (or a dead stream) – long-poll instead.
    if (!only) timer = setTimeout(() => !got && fallback(true), SSE_GRACE_MS)
    es.onmessage = (e) => {
      if (closed) return
      got = true
      clearTimeout(timer)
      let ev
      try {
        ev = JSON.parse(e.data)
      } catch {
        return
      }
      onEvent(ev)
    }
    es.onerror = () => {
      if (closed) return
      if (only) {
        // Forced SSE (testing): the browser retries by itself; if it gave up, reopen a bit later.
        const gaveUp = es.readyState === EventSource.CLOSED
        onStatus?.(gaveUp ? "down" : "reconnecting")
        if (gaveUp) timer = setTimeout(() => !closed && startSse(), 5000)
        return
      }
      // Never delivered anything: remember long polling for this session. After a working stream broke
      // (e.g. server restart) only this chat switches.
      fallback(!got)
    }
  }

  function fallback(remember) {
    clearTimeout(timer)
    es?.close()
    es = null
    if (closed) return
    if (remember && !forced()) rememberPoll()
    startPoll()
  }

  async function startPoll() {
    handle.transport = "poll"
    let after = 0
    let fails = 0
    while (!closed) {
      ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), POLL_TIMEOUT_MS)
      try {
        const res = await fetch(`${url}/poll?after=${after}&wait=${POLL_WAIT_S}`, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { "X-UI-Locale": getLocale(), "Accept-Language": getLocale() },
          signal: ctrl.signal,
        })
        if (res.status === 401) window.dispatchEvent(new CustomEvent("auth:expired"))
        if (!res.ok) throw new Error(`poll ${res.status}`)
        const data = await res.json()
        clearTimeout(t)
        if (closed) return
        if (fails) onStatus?.("up")
        fails = 0
        after = Number(data.next) || 0
        for (const ev of data.events || []) {
          if (closed) return
          onEvent(ev)
        }
      } catch {
        clearTimeout(t)
        if (closed) return
        fails++
        onStatus?.(fails >= 3 ? "down" : "reconnecting")
        await new Promise((r) => setTimeout(r, Math.min(fails, 5) * 1000))
      }
    }
  }

  const mode = forced() || (remembered() ? "poll" : "sse")
  if (mode === "poll" || typeof EventSource === "undefined") startPoll()
  else startSse()
  return handle
}
