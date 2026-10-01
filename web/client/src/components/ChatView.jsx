import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { api } from "../api.js"
import { cleanModelText, navigate, prefersReducedMotion } from "../lib.js"
import { useApp } from "../settings.jsx"
import { openChatStream } from "../stream.js"
import { t as tt, useT } from "../i18n.jsx"
import { ESC_CLOSED } from "../codes.js"
import Composer, { useUploads } from "./Composer.jsx"
import { AssistantTurn, MessagesSkeleton, UserMessage, turnArtifacts } from "./Messages.jsx"
import { DocumentPanel, EscalateDialog, EscalationCard, ExpertReply, Followups } from "./Extras.jsx"
import ReportPanel from "./ReportPanel.jsx"
import { AssistChip, AssistPopup } from "./AssistPopup.jsx"
import { useToast } from "./ui.jsx"
import { IconArrowDown, IconArrowUp, IconBook, IconClip, IconGavel, IconGlobe, IconLogo, IconScan, Spinner } from "./Icons.jsx"

const EXAMPLES = [
  { k: "penalty", icon: <IconGavel size={18} /> },
  { k: "review", icon: <IconScan size={18} />, attach: true },
  { k: "steel", icon: <IconGlobe size={18} /> },
  { k: "avoidance", icon: <IconBook size={18} /> },
]

// ---- message state reducer ---------------------------------------------------------------------
function upsertMsg(msgs, id, fn) {
  const i = msgs.findIndex((m) => m.id === id)
  if (i < 0) return [...msgs, fn({ id, role: "assistant", parts: [] })]
  const next = msgs.slice()
  next[i] = fn(msgs[i])
  return next
}
const isQuestion = (p) => p?.type === "tool" && p.tool === "question"
function upsertPart(parts, part) {
  let i = parts.findIndex((p) => p.id === part.id)
  // A question card created from the "question" event before its tool part arrived: same call id.
  if (i < 0 && isQuestion(part) && part.callID) i = parts.findIndex((p) => isQuestion(p) && p.callID === part.callID)
  if (i < 0) return [...parts, part]
  const prev = parts[i]
  const next = parts.slice()
  if (isQuestion(part)) {
    // Keep what only the question events carry (request id, questions while the input still streams, local answer).
    const done = part.qstate && part.qstate !== "pending"
    next[i] = {
      ...part,
      requestID: part.requestID || prev.requestID,
      questions: part.questions?.length ? part.questions : prev.questions,
      qstate: done ? part.qstate : prev.qstate && prev.qstate !== "pending" ? prev.qstate : part.qstate,
      answers: part.answers?.length ? part.answers : prev.answers,
    }
    return next
  }
  if ((part.type === "text" || part.type === "reasoning") && (part.text || "").length < cleanModelText(prev.text).length) next[i] = { ...part, text: prev.text }
  else next[i] = part
  return next
}
function applyEvent(msgs, ev) {
  switch (ev.type) {
    case "message":
      return upsertMsg(msgs, ev.id, (m) => ({ ...m, time: ev.time ?? m.time, completed: ev.completed, finish: ev.finish, error: ev.error, errorCode: ev.errorCode, errorDetail: ev.errorDetail, aborted: ev.aborted, repair: ev.repair || m.repair, finalize: ev.finalize || m.finalize }))
    case "part":
      return upsertMsg(msgs, ev.messageID, (m) => ({ ...m, parts: upsertPart(m.parts || [], ev.part) }))
    case "delta":
      return upsertMsg(msgs, ev.messageID, (m) => {
        const parts = m.parts || []
        const i = parts.findIndex((p) => p.id === ev.partID)
        if (i < 0) return { ...m, parts: [...parts, { id: ev.partID, type: ev.kind, text: ev.delta }] }
        const next = parts.slice()
        next[i] = { ...parts[i], text: (parts[i].text || "") + ev.delta }
        return { ...m, parts: next }
      })
    case "removed":
      return msgs.filter((m) => m.id !== ev.id)
    case "question": {
      const part = { id: "q-" + (ev.callID || ev.id), type: "tool", tool: "question", status: "running", callID: ev.callID, requestID: ev.id, questions: ev.questions || [], qstate: "pending" }
      if (ev.messageID) return upsertMsg(msgs, ev.messageID, (m) => ({ ...m, parts: upsertPart(m.parts || [], part) }))
      return msgs
    }
    case "question.replied":
    case "question.rejected":
      return mapQuestion(msgs, ev.id, (p) => ({ ...p, qstate: ev.type === "question.replied" ? "answered" : "dismissed", ...(ev.answers ? { answers: ev.answers } : {}) }))
    default:
      return msgs
  }
}

/**
 * Events that arrived while the history was loading, applied on top of it. The history already contains
 * part of the text those deltas carry (it was read after they were sent), so for a part that is in the
 * history the buffered deltas are joined and only what extends past the history text is appended
 * (largest overlap of the history's end with the deltas' start) – no doubled sentences.
 */
function applyBuffered(msgs, buf) {
  const inHistory = new Map()
  for (const m of msgs) for (const p of m.parts || []) if (p.type === "text" || p.type === "reasoning") inHistory.set(p.id, m.id)
  const pending = new Map() // partID -> { messageID, text }
  let out = msgs
  for (const ev of buf) {
    if (ev.type === "delta" && inHistory.has(ev.partID) && !pending.get(ev.partID)?.done) {
      const d = pending.get(ev.partID) || { messageID: ev.messageID, text: "" }
      d.text += ev.delta
      pending.set(ev.partID, d)
      continue
    }
    // A full part update supersedes the joined deltas (upsertPart keeps the longer text).
    if (ev.type === "part" && pending.has(ev.part?.id)) pending.get(ev.part.id).done = true
    out = applyEvent(out, ev)
  }
  for (const [partID, d] of pending) {
    if (d.done || !d.text) continue
    out = upsertMsg(out, d.messageID, (m) => ({
      ...m,
      parts: (m.parts || []).map((p) => {
        if (p.id !== partID) return p
        const have = p.text || ""
        let k = Math.min(have.length, d.text.length)
        while (k > 0 && !have.endsWith(d.text.slice(0, k))) k--
        return { ...p, text: have + d.text.slice(k) }
      }),
    }))
  }
  return out
}

/** Apply fn to the question part with this request id. */
function mapQuestion(msgs, requestID, fn) {
  let hit = false
  const out = msgs.map((m) => {
    if (!m.parts?.some((p) => isQuestion(p) && p.requestID === requestID)) return m
    hit = true
    return { ...m, parts: m.parts.map((p) => (isQuestion(p) && p.requestID === requestID ? fn(p) : p)) }
  })
  return hit ? out : msgs
}

export function buildTurns(msgs) {
  const turns = []
  let cur = null
  for (const m of msgs) {
    if (m.role === "user") turns.push((cur = { user: m, assistant: [] }))
    else {
      if (!cur) turns.push((cur = { user: null, assistant: [] }))
      cur.assistant.push(m)
    }
  }
  return turns
}

/** Messages up to (excluding) the user message of turn k. */
const cutBeforeTurn = (msgs, k) => {
  let seen = -1
  const i = msgs.findIndex((m) => m.role === "user" && ++seen === k)
  return i < 0 ? msgs : msgs.slice(0, i)
}

const WIDE = () => window.matchMedia("(min-width: 1100px)").matches

/** Stream / message error in the UI language (server sends a stable code + raw detail). */
export const errorText = (code, fallback, detail) => (code ? tt(`errors.stream.${code}`, { detail: detail ? `: ${detail}` : "" }) : fallback)

export default function ChatView({ chatId, onChatCreated, onActivity, onTitle, onStream }) {
  const toast = useToast()
  const t = useT()
  const { settings, autoRepair } = useApp()
  const uploads = useUploads()
  const [msgs, setMsgs] = useState([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!!chatId)
  const [loadError, setLoadError] = useState("")
  const [retry, setRetry] = useState(null)
  const [repairing, setRepairing] = useState(false) // automatic repair run after a THẤP verdict
  const [finalizing, setFinalizing] = useState(false) // hidden "write the final answer" run after an empty final message
  const [versions, setVersions] = useState([])
  const [switching, setSwitching] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [reportTurn, setReportTurnRaw] = useState(null)
  const [doc, setDocRaw] = useState(null)
  const [grounding, setGrounding] = useState(null)
  const [escalations, setEscalations] = useState([])
  const [escTarget, setEscTarget] = useState(null)
  const [followups, setFollowups] = useState(null) // { turn, items } | { turn, pending, count } for the latest turn
  // assisted browsing: requests to pass an official site's CAPTCHA in a live view (server/assist.mjs)
  const [assists, setAssists] = useState([])
  const [openAssist, setOpenAssistRaw] = useState(null) // assistId of the open window
  const openAssistRef = useRef(null)
  const dismissedAssist = useRef(new Set()) // windows the user closed (the chip reopens them)
  const setOpenAssist = (v) => {
    openAssistRef.current = v
    setOpenAssistRaw(v)
  }
  const branchRef = useRef(null)
  // History paging: messages start at user turn `turnOffset`; older turns load on scroll-up.
  const [turnOffset, setTurnOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [older, setOlder] = useState({ loading: false, error: false })
  const offsetRef = useRef(0)
  const keepScroll = useRef(null)
  // Only one side panel at a time.
  const setReportTurn = (v) => {
    setDocRaw(null)
    setReportTurnRaw(v)
  }
  const setDoc = (v) => {
    setReportTurnRaw(null)
    setDocRaw(v)
  }
  const scrollRef = useRef(null)
  const composerRef = useRef(null)
  const stickRef = useRef(true)
  const esRef = useRef(null)
  const idRef = useRef(chatId)
  const createdRef = useRef(null)
  const historyReady = useRef(false)
  const buffer = useRef([])
  const sendingRef = useRef(false)
  const streamState = useRef("up") // transport health reported by openChatStream
  const autoOpened = useRef(new Set())

  // ---- history + live stream -------------------------------------------------------------------
  const reload = useCallback(async (id) => {
    try {
      const r = await api.messages(id)
      if (idRef.current !== id) return
      let offset = r.turnOffset || 0
      let more = !!r.hasMore
      setMsgs((local) => {
        // Keep an optimistic user message that the server has not recorded yet.
        const pending = local.filter((m) => m.local)
        const first = r.messages[0]?.id
        const j = first ? local.findIndex((m) => m.id === first) : -1
        let base = r.messages
        if (j > 0 && offsetRef.current < offset) {
          // Older turns already loaded above the latest page: keep them.
          base = [...local.slice(0, j), ...r.messages]
          offset = offsetRef.current
          more = offsetRef.current > 0
        }
        const serverUsers = base.filter((m) => m.role === "user").length
        const localUsers = local.filter((m) => m.role === "user").length
        return pending.length && localUsers > serverUsers ? [...base, ...pending] : base
      })
      offsetRef.current = offset
      setTurnOffset(offset)
      setHasMore(more)
      setVersions(r.versions || [])
      setGrounding(r.grounding || [])
      setEscalations(r.escalations || [])
      branchRef.current = r.branchId || null
      setFollowups(r.followups || null)
      setBusy(r.busy || sendingRef.current)
      loadAssists(id)
      setLoadError("")
      onTitle?.(r.chat)
    } catch (e) {
      if (idRef.current !== id) return
      if (e.status === 404) {
        toast.error(t("chat.notFound"))
        if (idRef.current === id) navigate("/", { replace: true })
      } else setLoadError(e.message)
    } finally {
      if (idRef.current === id) {
        historyReady.current = true
        const buf = buffer.current
        buffer.current = []
        if (buf.length) setMsgs((m) => applyBuffered(m, buf))
        setLoading(false)
        setSwitching(false)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Recent assist requests of the chat (history reload): open the one still waiting unless the user closed it. */
  const loadAssists = useCallback(async (id) => {
    try {
      const r = await api.assists(id)
      if (idRef.current !== id) return
      const list = r.assists || []
      setAssists(list)
      const w = [...list].reverse().find((a) => a.status === "waiting_user" && !dismissedAssist.current.has(a.assistId))
      if (w && !openAssistRef.current) setOpenAssist(w.assistId)
      if (openAssistRef.current && !list.some((a) => a.assistId === openAssistRef.current && a.status === "waiting_user")) setOpenAssist(null)
    } catch {}
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  /** Live assist event: upsert; a new waiting request opens the window, the end of the open one closes it. */
  const onAssist = (a) => {
    if (!a?.assistId) return
    setAssists((list) => {
      const i = list.findIndex((x) => x.assistId === a.assistId)
      if (i < 0) return [...list, a]
      const next = list.slice()
      next[i] = a // the server always sends the whole public state (cleared fields must disappear)
      return next
    })
    if (a.status === "waiting_user") {
      if (!dismissedAssist.current.has(a.assistId) && !openAssistRef.current) setOpenAssist(a.assistId)
    } else if (openAssistRef.current === a.assistId) {
      setOpenAssist(null)
      if (a.status === "done") toast.success(t("assist.toastDone"))
      else if (a.status === "timeout") toast.info(t("assist.toastTimeout"))
    }
  }
  const cancelAssist = async (a) => {
    try {
      const r = await api.cancelAssist(idRef.current, a.assistId)
      if (r?.assist) onAssist(r.assist)
      setOpenAssist(null)
    } catch (e) {
      toast.error(e.message)
    }
  }

  /**
   * Opens the chat's event stream (SSE, or long polling behind buffering proxies – see stream.js).
   * Resolves on the first "ready" (or after 5 s – nothing waits on it).
   */
  const connect = useCallback(
    (id) =>
      new Promise((resolve) => {
        esRef.current?.close()
        let first = true
        const timer = setTimeout(resolve, 5000)
        const onStatus = (s) => {
          if (idRef.current !== id) return
          streamState.current = s
          onStream?.(s)
        }
        const onEvent = (ev) => {
          if (idRef.current !== id) return
          if (ev.type === "ready") {
            onStatus("up")
            if (first) {
              first = false
              clearTimeout(timer)
              resolve()
            } else reload(id) // reconnected: resync
            if (!sendingRef.current) setBusy(ev.busy)
            return
          }
          if (ev.type === "branch") offsetRef.current = Number.MAX_SAFE_INTEGER // do not merge across versions
          if (ev.type === "resync" || ev.type === "branch" || ev.type === "escalation" || ev.type === "confidence") return reload(id)
          if (ev.type === "finalizing") {
            setFinalizing(true)
            setBusy(true)
            return
          }
          if (ev.type === "repair") {
            // Server grounding found unsupported items: one automatic look-up-again run has started.
            setRepairing(true)
            setBusy(true)
            return reload(id)
          }
          if (ev.type === "assist") return onAssist(ev.assist)
          if (ev.type === "followups") {
            if (!branchRef.current || ev.branchId === branchRef.current) setFollowups(ev.pending ? { turn: ev.turn, pending: true, count: ev.count } : ev.items?.length ? { turn: ev.turn, items: ev.items } : null)
            return
          }
          if (ev.type === "status") {
            if (ev.status === "idle") {
              if (!sendingRef.current) setBusy(false)
              setRepairing(false)
              setFinalizing(false)
              setRetry(null)
              reload(id)
              onActivity?.(id)
            } else {
              setBusy(true)
              setRetry(ev.status === "retry" ? { attempt: ev.attempt, message: ev.message } : null)
            }
            return
          }
          if (ev.type === "idle" || ev.type === "aborted") return
          if (ev.type === "error") {
            toast.error(errorText(ev.code, ev.message, ev.detail))
            return
          }
          if (!historyReady.current) buffer.current.push(ev)
          else setMsgs((m) => applyEvent(m, ev))
        }
        streamState.current = "up"
        esRef.current = openChatStream(id, { onEvent, onStatus })
      }),
    [reload], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Last resort while the event stream is failing (SSE and long polling both down): refresh the
  // history every few seconds until the run is over.
  useEffect(() => {
    if (!busy || !chatId) return
    const timer = setInterval(() => {
      if (streamState.current === "down" && idRef.current === chatId && !sendingRef.current) reload(chatId)
    }, 4000)
    return () => clearInterval(timer)
  }, [busy, chatId, reload])

  useEffect(() => {
    idRef.current = chatId
    if (chatId && chatId === createdRef.current) {
      createdRef.current = null // we just created it; the stream is already being opened
      return
    }
    createdRef.current = null
    esRef.current?.close()
    esRef.current = null
    historyReady.current = false
    buffer.current = []
    setMsgs([])
    offsetRef.current = 0
    setTurnOffset(0)
    setHasMore(false)
    setVersions([])
    setGrounding(null)
    setEscalations([])
    setFollowups(null)
    setAssists([])
    setOpenAssist(null)
    dismissedAssist.current = new Set()
    branchRef.current = null
    setDocRaw(null)
    setBusy(false)
    setRetry(null)
    setRepairing(false)
    setFinalizing(false)
    setLoadError("")
    setReportTurn(null)
    stickRef.current = true
    uploads.clear()
    if (!chatId) {
      setLoading(false)
      return
    }
    setLoading(true)
    connect(chatId).then(() => reload(chatId))
  }, [chatId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      esRef.current?.close()
      onStream?.("up")
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // "/" focuses the composer.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      if (t.closest?.("input, textarea, [contenteditable=true], .dialog")) return
      e.preventDefault()
      composerRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // ---- scrolling ---------------------------------------------------------------------------------
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    stickRef.current = near
    setAtBottom(near)
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (keepScroll.current != null) {
      // Older turns were prepended: keep the reader's position.
      el.scrollTop = el.scrollHeight - keepScroll.current
      keepScroll.current = null
      return
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [msgs, busy, loading])
  const loadOlder = async () => {
    const id = idRef.current
    if (!id || !hasMore || older.loading || loading) return
    setOlder({ loading: true, error: false })
    try {
      const r = await api.messages(id, offsetRef.current, 10)
      if (idRef.current !== id) return
      const el = scrollRef.current
      keepScroll.current = el ? el.scrollHeight - el.scrollTop : null
      stickRef.current = false
      setMsgs((m) => {
        const have = new Set(m.map((x) => x.id))
        return [...r.messages.filter((x) => !have.has(x.id)), ...m]
      })
      offsetRef.current = r.turnOffset
      setTurnOffset(r.turnOffset)
      setHasMore(r.hasMore)
      setOlder({ loading: false, error: false })
    } catch {
      setOlder({ loading: false, error: true })
    }
  }
  const jumpToBottom = () => {
    const el = scrollRef.current
    stickRef.current = true
    el?.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" })
  }

  // ---- clarifying questions ----------------------------------------------------------------------
  // The latest turn's question that is waiting for an answer (and can be answered: request id known).
  const pendingQ = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0 && msgs[i].role !== "user"; i--) {
      const p = [...(msgs[i].parts || [])].reverse().find((x) => isQuestion(x) && x.qstate === "pending" && x.requestID)
      if (p) return p
    }
    return null
  }, [msgs])
  const draftRef = useRef(null) // { requestID, answers } – the open card's current choices
  const settleQuestion = (requestID, patch) => setMsgs((m) => mapQuestion(m, requestID, (p) => ({ ...p, ...patch })))
  const answerQuestion = async (part, answers) => {
    const id = idRef.current
    try {
      await api.replyQuestion(id, part.requestID, answers)
      settleQuestion(part.requestID, { qstate: "answered", answers })
      stickRef.current = true
      return true
    } catch (e) {
      toast.error(t("question.sendFailed", { message: e.message }))
      if (e.status === 404) reload(id)
      return false
    }
  }
  const rejectQuestion = async (part) => {
    const id = idRef.current
    try {
      await api.rejectQuestion(id, part.requestID)
      settleQuestion(part.requestID, { qstate: "dismissed" })
      return true
    } catch (e) {
      toast.error(t("question.sendFailed", { message: e.message }))
      if (e.status === 404) reload(id)
      return false
    }
  }
  const questionProps = {
    onReply: answerQuestion,
    onReject: rejectQuestion,
    onDraft: (part, answers) => {
      draftRef.current = { requestID: part.requestID, answers }
    },
  }

  // ---- actions -----------------------------------------------------------------------------------
  const send = (text, files) => {
    if (pendingQ) {
      // A question is waiting: what the user types is the free-text answer to the first unanswered question.
      const n = pendingQ.questions?.length || 1
      const draft = draftRef.current?.requestID === pendingQ.requestID ? draftRef.current.answers.map((a) => [...a]) : []
      while (draft.length < n) draft.push([])
      const k = Math.max(0, draft.findIndex((a) => !a.length))
      draft[k] = [text]
      answerQuestion(pendingQ, draft)
      return true
    }
    if (sendingRef.current) return false
    sendingRef.current = true
    const attachments = files.map((f) => ({ name: f.name, ...(f.ocr ? { ocr: f.ocr } : {}) }))
    const local = { id: "local-" + Date.now(), local: true, role: "user", text, attachments }
    const startedIn = idRef.current
    const startPath = window.location.pathname
    setMsgs((m) => [...m, local])
    setBusy(true)
    setFollowups(null)
    stickRef.current = true
    uploads.clear()
    const restore = (e) => {
      toast.error(e.message)
      if (idRef.current === startedIn) {
        setMsgs((m) => m.filter((x) => x !== local))
        setBusy(false)
        composerRef.current?.setText(text)
      }
    }
    ;(async () => {
      try {
        if (!startedIn) {
          // One request creates the chat *and* sends the prompt – a chat can no longer exist without it.
          const { chat } = await api.createChat(text, files.map((f) => f.id))
          onChatCreated?.(chat)
          // Only move to the new chat if the user is still on the new-chat screen.
          if (idRef.current != null || window.location.pathname !== startPath) {
            toast.success(t("chat.sentTo", { title: chat.title }))
            return
          }
          createdRef.current = chat.id
          idRef.current = chat.id
          historyReady.current = false
          navigate(`/c/${chat.id}`)
          connect(chat.id).then(() => reload(chat.id))
        } else {
          await api.send(startedIn, text, files.map((f) => f.id))
          onActivity?.(startedIn)
        }
      } catch (e) {
        restore(e)
      } finally {
        sendingRef.current = false
      }
    })()
    return true
  }

  const editTurn = async (k, text) => {
    const id = idRef.current
    if (!id || busy) return
    const before = msgs
    const lk = k - offsetRef.current
    const turnMsg = buildTurns(msgs)[lk]?.user
    offsetRef.current = Number.MAX_SAFE_INTEGER
    setMsgs((m) => [...cutBeforeTurn(m, lk), { id: "local-" + Date.now(), local: true, role: "user", text, attachments: turnMsg?.attachments || [] }])
    setBusy(true)
    setFollowups(null)
    setReportTurn(null)
    stickRef.current = true
    try {
      await api.editMessage(id, k, text)
      reload(id)
    } catch (e) {
      toast.error(e.message)
      if (idRef.current === id) {
        setMsgs(before)
        setBusy(false)
      }
    }
  }

  const regenerate = async (k) => {
    const id = idRef.current
    if (!id || busy) return
    const before = msgs
    const lk = k - offsetRef.current
    offsetRef.current = Number.MAX_SAFE_INTEGER
    setMsgs((m) => {
      const cut = cutBeforeTurn(m, lk)
      const userMsg = buildTurns(m)[lk]?.user
      return userMsg ? [...cut, userMsg] : cut
    })
    setBusy(true)
    setFollowups(null)
    setReportTurn(null)
    stickRef.current = true
    try {
      await api.regenerate(id, k)
      reload(id)
    } catch (e) {
      toast.error(e.message)
      if (idRef.current === id) {
        setMsgs(before)
        setBusy(false)
      }
    }
  }

  const switchVersion = async (branchId) => {
    const id = idRef.current
    if (!id || busy) return
    setSwitching(true)
    setReportTurn(null)
    offsetRef.current = Number.MAX_SAFE_INTEGER
    try {
      await api.switchBranch(id, branchId)
      await reload(id)
    } catch (e) {
      toast.error(e.message)
      setSwitching(false)
    }
  }

  const stop = async () => {
    const id = idRef.current
    if (!id) return
    try {
      await api.abort(id)
    } catch (e) {
      toast.error(e.message)
    }
  }

  // ---- drag & drop -------------------------------------------------------------------------------
  const dragDepth = useRef(0)
  const dnd = {
    onDragEnter: (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return
      e.preventDefault()
      dragDepth.current++
      setDragging(true)
    },
    onDragOver: (e) => {
      if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault()
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    },
    onDrop: (e) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (e.dataTransfer?.files?.length) uploads.add(e.dataTransfer.files)
    },
  }

  const turns = useMemo(() => buildTurns(msgs), [msgs])
  const vByTurn = useMemo(() => new Map(versions.map((v) => [v.turn, v])), [versions])
  // "phiên bản 2" for a newer document with the same title in this conversation.
  const docVersions = useMemo(() => {
    const seen = new Map()
    const out = new Map()
    for (const t of turns)
      for (const a of turnArtifacts(t.assistant).filter((x) => x.legacy)) {
        const n = (seen.get(a.title) || 0) + 1
        seen.set(a.title, n)
        out.set(a.id, n)
      }
    return out
  }, [turns])
  // Changes whenever a document (new version, imported upload) appears → cards refetch their version chain.
  const docsKey = useMemo(
    () => turns.reduce((n, t) => n + turnArtifacts(t.assistant).length + (t.user?.attachments || []).filter((a) => a.artifact).length, 0),
    [turns],
  )
  const openDoc = (a, opts = {}) => {
    const view = opts.view || "preview"
    setDoc((d) => (d?.id === a.id && (d.view || "preview") === view && d.against === opts.against ? null : { ...a, ...opts, view }))
  }
  const escByTurn = useMemo(() => {
    const m = new Map()
    for (const e of escalations) m.set(e.turn, [...(m.get(e.turn) || []), e])
    return m
  }, [escalations])
  const scope = useMemo(() => ({ chatId: idRef.current }), [chatId, msgs.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const empty = !loading && !msgs.length && !loadError
  const reportMsgs = reportTurn != null ? turns[reportTurn]?.assistant : null
  // assist chips: under the turn whose question came before the request (unknown time → the latest turn)
  const assistByTurn = useMemo(() => {
    const m = new Map()
    for (const a of assists) {
      let li = turns.length - 1
      for (let k = turns.length - 1; k >= 0; k--) {
        const tm = turns[k].user?.time
        if (tm && a.createdAt && tm <= a.createdAt) {
          li = k
          break
        }
      }
      if (li >= 0) m.set(li, [...(m.get(li) || []), a])
    }
    return m
  }, [assists, turns])
  const openA = openAssist ? assists.find((a) => a.assistId === openAssist && a.status === "waiting_user") : null
  const lastIdx = turns.length - 1

  return (
    <div className={`chat-area ${reportMsgs || doc ? "with-report" : ""}`}>
      <div className="chat" {...dnd}>
        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className={`chat-col ${empty ? "is-empty" : ""} ${switching ? "is-switching" : ""}`}>
            {loading ? (
              <MessagesSkeleton />
            ) : empty ? (
              <div className="empty">
                <span className="logo-mark xl float-in">
                  <IconLogo size={30} />
                </span>
                <h1 className="empty-title">{t("chat.empty.title")}</h1>
                <p className="empty-sub">{t("chat.empty.subtitle")}</p>
                <div className="examples">
                  {EXAMPLES.map((ex, i) => (
                    <button
                      key={ex.k}
                      className="example"
                      style={{ animationDelay: `${120 + i * 60}ms` }}
                      onClick={() => {
                        composerRef.current?.setText(t(`chat.examples.${ex.k}`))
                        if (ex.attach) composerRef.current?.openFile()
                      }}
                    >
                      <span className="example-icon" aria-hidden="true">
                        {ex.icon}
                      </span>
                      <span>{t(`chat.examples.${ex.k}`)}</span>
                      {ex.attach && <IconClip size={14} className="example-attach" aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="messages" role="log" aria-label={t("chat.logLabel")} aria-relevant="additions">
                {loadError && (
                  <div className="msg-error" role="alert">
                    {loadError}{" "}
                    <button className="link-btn" onClick={() => reload(idRef.current)}>
                      {t("common.retry")}
                    </button>
                  </div>
                )}
                {hasMore && (
                  <div className="older-turns">
                    <button type="button" className="btn ghost sm" onClick={loadOlder} disabled={older.loading} aria-busy={older.loading || undefined}>
                      {older.loading ? <Spinner size={12} /> : <IconArrowUp size={14} />}
                      {older.error ? t("chat.olderRetry") : t("chat.loadOlder")}
                    </button>
                  </div>
                )}
                {turns.map((tn, li) => {
                  const i = li + turnOffset // absolute turn index in the conversation
                  const v = vByTurn.get(i)
                  const active = busy && li === lastIdx
                  return (
                    <div className="turn" key={tn.user?.id || i}>
                      {tn.user && (
                        <UserMessage
                          msg={tn.user}
                          versions={v}
                          busy={busy || switching}
                          onEdit={idRef.current ? (text) => editTurn(i, text) : null}
                          onSwitch={switchVersion}
                          scope={scope}
                          docsKey={docsKey}
                          openDocId={doc?.id}
                          onPreviewDoc={openDoc}
                        />
                      )}
                      {(tn.assistant.length > 0 || active) && (
                        <AssistantTurn
                          messages={tn.assistant}
                          active={active}
                          retry={retry}
                          versions={v}
                          isLast={li === lastIdx}
                          busy={busy || switching}
                          showReasoning={settings.showReasoning}
                          onRegenerate={tn.user && idRef.current ? () => regenerate(i) : null}
                          onSwitch={switchVersion}
                          reportOpen={reportTurn === li}
                          onOpenReport={() => setReportTurn(reportTurn === li ? null : li)}
                          grounding={grounding ? (grounding[i] ?? null) : undefined}
                          escalated={(escByTurn.get(i) || []).some((e) => e.status !== ESC_CLOSED)}
                          onEscalate={idRef.current && tn.user ? ({ low }) => setEscTarget({ chatId: idRef.current, turn: i, low }) : null}
                          scope={scope}
                          docVersions={docVersions}
                          openDocId={doc?.id}
                          docsKey={docsKey}
                          onPreviewDoc={openDoc}
                          question={questionProps}
                          repairing={active && repairing}
                          onRepairNow={autoRepair.allowed && idRef.current && tn.user ? () => api.repair(idRef.current, i) : null}
                          finalizing={active && finalizing}
                          onReportDetected={() => {
                            const key = `${idRef.current}:${i}:${tn.assistant[0]?.id}`
                            if (active && WIDE() && !autoOpened.current.has(key)) {
                              autoOpened.current.add(key)
                              setReportTurn(li)
                            }
                          }}
                        />
                      )}
                      {(assistByTurn.get(li) || []).map((a) => (
                        <AssistChip
                          key={a.assistId}
                          assist={a}
                          open={openA?.assistId === a.assistId}
                          busy={busy && li === lastIdx}
                          onOpen={() => {
                            dismissedAssist.current.delete(a.assistId)
                            setOpenAssist(a.assistId)
                          }}
                        />
                      ))}
                      {li === lastIdx && !busy && !switching && settings.showFollowups !== false && followups?.turn === i && (
                        <Followups data={followups} disabled={busy || loading} onPick={(q) => send(q, [])} />
                      )}
                      {(escByTurn.get(i) || []).map((e) => (
                        <div key={e.id} className="esc-thread">
                          <EscalationCard e={e} />
                          {e.replies.map((r) => (
                            <ExpertReply key={r.id} r={r} escalationId={e.id} />
                          ))}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
        <div className="chat-bottom">
          <button className={`jump ${!atBottom && !empty && !loading ? "show" : ""}`} onClick={jumpToBottom} aria-label={t("chat.jumpToBottom")} tabIndex={atBottom ? -1 : 0}>
            <IconArrowDown size={17} />
          </button>
          <Composer
            ref={composerRef}
            busy={busy}
            answering={!!pendingQ}
            disabled={loading || switching}
            onSend={send}
            onStop={stop}
            uploads={uploads}
            enterToSend={settings.enterToSend}
          />
        </div>
        <div className={`dropzone ${dragging ? "show" : ""}`} aria-hidden={!dragging}>
          <div className="dropzone-box">
            <IconClip size={26} />
            <strong>{t("composer.dropTitle")}</strong>
            <span>{t("composer.dropHint")}</span>
          </div>
        </div>
      </div>
      {openA && (
        <AssistPopup
          key={openA.assistId}
          chatId={idRef.current}
          assist={openA}
          onCancel={cancelAssist}
          onMinimize={() => {
            dismissedAssist.current.add(openA.assistId)
            setOpenAssist(null)
          }}
        />
      )}
      <DocumentPanel artifact={doc} scope={scope} onClose={() => setDoc(null)} />
      <EscalateDialog target={escTarget} onClose={() => setEscTarget(null)} onDone={() => reload(idRef.current)} />
      <ReportPanel open={!!reportMsgs} messages={reportMsgs || []} streaming={busy && reportTurn === lastIdx} onClose={() => setReportTurn(null)} scope={scope} />
    </div>
  )
}
