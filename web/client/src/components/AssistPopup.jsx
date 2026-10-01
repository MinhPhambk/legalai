// Assisted browsing on an official site: a small floating window that mirrors the official page ("like a mirror")
// where the USER solves the human check themselves (ticks reCAPTCHA / types the picture code, presses the search
// button); every click / key goes to the real page (server/assist.mjs → CDP), the tool continues by itself once the
// result page appears. Desktop: min(900 px, 70vw) wide, draggable by its header, resizable from the corner (size kept
// per browser), zoom − / % / + (starts at 100–125 % on the code box + picture + search button); ≤ 640 px: full-screen sheet.
// In the message stream only a one-line chip remains (AssistChip) – it reopens the window if it was closed.
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Trans, useT } from "../i18n.jsx"
import { openAssistView } from "../assistView.js"
import { api } from "../api.js"
import { Data } from "./DataText.jsx"
import { IconAlert, IconCheck, IconClose, IconExternal, IconLock, IconShield, Spinner } from "./Icons.jsx"

const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
const BTN = ["left", "middle", "right"]
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
const useMedia = (q) => {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [q])
  return m
}

const LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const SIZE_KEY = "legalai.assistSize"
const savedSize = () => {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) || "null")
    return v && v.w >= 360 && v.h >= 300 ? { w: v.w, h: v.h } : null
  } catch {
    return null
  }
}
/** Source label key of a request (tracuunnt / dkkd / other). */
const srcKey = (a) => (a?.source === "gdt" || a?.source === "dkkd" ? a.source : "other")

export function AssistPopup({ chatId, assist, onMinimize, onCancel }) {
  const t = useT()
  const mobile = useMedia("(max-width: 640px)")
  const canvasRef = useRef(null)
  const stageRef = useRef(null)
  const kbdRef = useRef(null)
  const popRef = useRef(null)
  const viewRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState("")
  // zoom: "fit" (whole page in the window) or a scale of the page (1 = 100 %); null until the first frame, then
  // autoZoom(): 100–125 % on the part to operate – at fit width the code picture is too small to read
  const [zoom, setZoomRaw] = useState(null)
  const zoomRef = useRef(null)
  const pendingPan = useRef(null) // "focus" | { cx, cy } (keep the centre) after a zoom change
  const [frameW, setFrameW] = useState(1200)
  const [dim, setDim] = useState(savedSize) // user-chosen window size (desktop)
  const focusRef = useRef(assist.focus || null)
  focusRef.current = assist.focus || null
  const [pos, setPos] = useState(null) // dragged position {x, y} (desktop)
  const [now, setNow] = useState(Date.now())
  const [focused, setFocused] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const waiting = assist.status === "waiting_user"
  const left = (assist.expiresAt || 0) - now

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  /** At 100 %: bring the part to operate (CAPTCHA box / widget) into view, else the middle. False when nothing to pan. */
  const panToFocus = () => {
    const st = stageRef.current, c = canvasRef.current
    if (!st || !c || (st.scrollWidth <= st.clientWidth && st.scrollHeight <= st.clientHeight)) return false
    const f = focusRef.current
    const k = typeof zoomRef.current === "number" ? zoomRef.current : c.getBoundingClientRect().width / (c.width || 1200)
    if (st.scrollHeight < c.height * k * 0.98) return false // not laid out at this zoom yet
    st.scrollLeft = f ? f.x * k + (f.w * k) / 2 - st.clientWidth / 2 : (st.scrollWidth - st.clientWidth) / 2
    if (f) st.scrollTop = f.y * k + (f.h * k) / 2 - st.clientHeight / 2
    return true
  }
  const scaleNow = () => {
    const c = canvasRef.current
    return c ? c.getBoundingClientRect().width / (c.width || 1200) : 1
  }
  const fitScale = () => (stageRef.current?.clientWidth || 800) / (frameW || 1200)
  const autoZoom = () => {
    const f = focusRef.current
    const W = stageRef.current?.clientWidth || 800
    if (!f) return W / (frameW || 1200) >= 0.9 ? "fit" : 1
    return Math.min(1.25, Math.max(1, Math.floor(((W * 0.9) / Math.max(f.w, 1)) * 4) / 4))
  }
  const setZoom = (z) => {
    const st = stageRef.current
    if (st && canvasRef.current) {
      const k = scaleNow()
      pendingPan.current = { cx: (st.scrollLeft + st.clientWidth / 2) / k, cy: (st.scrollTop + st.clientHeight / 2) / k }
    }
    zoomRef.current = z
    setZoomRaw(z)
  }
  const zoomIn = () => {
    const cur = zoom === "fit" || zoom == null ? fitScale() : zoom
    const next = LEVELS.find((l) => l > cur + 0.01)
    if (next) setZoom(next)
  }
  const zoomOut = () => {
    const cur = zoom === "fit" || zoom == null ? fitScale() : zoom
    const prev = [...LEVELS].reverse().find((l) => l < cur - 0.01)
    setZoom(prev && prev > fitScale() + 0.01 ? prev : "fit")
  }
  // after a zoom change: keep the same spot in the middle, or (first frame) bring the part to operate into view
  useLayoutEffect(() => {
    const st = stageRef.current, p = pendingPan.current
    if (!st || !p || zoom == null) return
    pendingPan.current = null
    // after the browser has laid out the new canvas size (two frames: the zoomed width lands a frame later)
    if (p === "focus") return void requestAnimationFrame(() => panToFocus() || requestAnimationFrame(() => panToFocus()))
    const k = scaleNow()
    st.scrollLeft = p.cx * k - st.clientWidth / 2
    st.scrollTop = p.cy * k - st.clientHeight / 2
  }, [zoom, frameW])

  // live view
  useEffect(() => {
    if (!waiting) return
    let drawing = Promise.resolve()
    const v = openAssistView(chatId, assist.assistId, {
      onMode: setMode,
      onFrame: (blob) => {
        drawing = drawing.then(async () => {
          const c = canvasRef.current
          if (!c) return
          try {
            const bmp = await createImageBitmap(blob)
            if (c.width !== bmp.width || c.height !== bmp.height) {
              c.width = bmp.width
              c.height = bmp.height
              setFrameW(bmp.width)
            }
            c.getContext("2d").drawImage(bmp, 0, 0)
            bmp.close?.()
            setReady(true)
            if (zoomRef.current == null) {
              pendingPan.current = "focus"
              zoomRef.current = autoZoom()
              setZoomRaw(zoomRef.current)
            }
          } catch {}
        })
      },
    })
    viewRef.current = v
    return () => {
      v.close()
      viewRef.current = null
    }
  }, [chatId, assist.assistId, waiting])

  // focus the window when it opens (keyboard users can start at once; Esc leaves the page)
  useEffect(() => {
    popRef.current?.focus({ preventScroll: true })
  }, [])

  // ---- input ------------------------------------------------------------------------------------------------
  const send = (ev) => viewRef.current?.send(ev)
  const frac = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }
  const press = useRef({ b: null, last: null, touch: null })
  const moveRaf = useRef(0)
  const pendingMove = useRef(null)
  const focusKbd = () => kbdRef.current?.focus({ preventScroll: true })
  const onPointerDown = (e) => {
    if (!ready || !waiting) return
    focusKbd()
    const p = frac(e)
    if (e.pointerType === "touch") {
      press.current.touch = { ...p, cx: e.clientX, cy: e.clientY, moved: false, lx: e.clientX, ly: e.clientY }
      return // a tap becomes a click on pointerup; a drag scrolls the page (fit mode) or the view (100 %)
    }
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const b = BTN[e.button] || "left"
    const l = press.current.last
    const c = l && Date.now() - l.at < 450 && Math.hypot(l.x - p.x, l.y - p.y) < 0.01 ? Math.min(3, l.c + 1) : 1
    press.current = { ...press.current, b, last: { ...p, at: Date.now(), c } }
    send([{ t: "m", k: "move", ...p, b: "none", mod: mods(e) }, { t: "m", k: "down", ...p, b, c, mod: mods(e) }])
  }
  const onPointerMove = (e) => {
    if (!ready || !waiting) return
    const tch = press.current.touch
    if (e.pointerType === "touch") {
      if (!tch) return
      if (Math.hypot(e.clientX - tch.cx, e.clientY - tch.cy) > 8) tch.moved = true
      if (tch.moved && zoom === "fit") {
        const r = canvasRef.current.getBoundingClientRect()
        const k = (canvasRef.current.width || 1200) / r.width // CSS px of the view → page px
        send([{ t: "w", x: tch.x, y: tch.y, dx: -(e.clientX - tch.lx) * k, dy: -(e.clientY - tch.ly) * k }])
        tch.lx = e.clientX
        tch.ly = e.clientY
      }
      return
    }
    pendingMove.current = { t: "m", k: "move", ...frac(e), b: press.current.b || "none", mod: mods(e) }
    if (!moveRaf.current)
      moveRaf.current = requestAnimationFrame(() => {
        moveRaf.current = 0
        if (pendingMove.current) send([pendingMove.current])
        pendingMove.current = null
      })
  }
  const onPointerUp = (e) => {
    if (!ready || !waiting) return
    if (e.pointerType === "touch") {
      const tch = press.current.touch
      press.current.touch = null
      if (tch && !tch.moved) send([{ t: "m", k: "move", x: tch.x, y: tch.y, b: "none" }, { t: "m", k: "down", x: tch.x, y: tch.y, b: "left", c: 1 }, { t: "m", k: "up", x: tch.x, y: tch.y, b: "left", c: 1 }])
      return
    }
    const p = frac(e)
    send([{ t: "m", k: "up", ...p, b: press.current.b || "left", c: press.current.last?.c || 1, mod: mods(e) }])
    press.current.b = null
  }
  // wheel needs a non-passive listener to keep the chat from scrolling
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const onWheel = (e) => {
      if (!waiting) return
      e.preventDefault()
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1
      send([{ t: "w", ...frac(e), dx: e.deltaX * k, dy: e.deltaY * k, mod: mods(e) }])
    }
    c.addEventListener("wheel", onWheel, { passive: false })
    return () => c.removeEventListener("wheel", onWheel)
  }, [waiting]) // eslint-disable-line react-hooks/exhaustive-deps

  // keyboard: a hidden input keeps the focus (also opens the on-screen keyboard on phones); printable keys are sent
  // as key events, IME / mobile text as inserted text; Esc leaves the page (not forwarded)
  const downKeys = useRef(new Set())
  const onKeyDown = (e) => {
    if (!waiting) return
    if (e.key === "Escape") {
      e.currentTarget.blur()
      return
    }
    if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key === "Unidentified" || e.key === "Process") return
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.key.toLowerCase() === "v") return // → paste event
    if (e.key.length === 1 && !ctrl) {
      e.preventDefault()
      send([{ t: "k", k: "down", key: e.key, code: e.code, kc: e.keyCode, mod: mods(e) }, { t: "k", k: "up", key: e.key, code: e.code, kc: e.keyCode, mod: mods(e) }])
      return
    }
    if (e.key.length > 1 || ctrl) {
      e.preventDefault()
      downKeys.current.add(e.code || e.key)
      send([{ t: "k", k: "down", key: e.key, code: e.code, kc: e.keyCode, mod: mods(e) }])
    }
  }
  const onKeyUp = (e) => {
    const id = e.code || e.key
    if (!downKeys.current.has(id)) return
    downKeys.current.delete(id)
    send([{ t: "k", k: "up", key: e.key, code: e.code, kc: e.keyCode, mod: mods(e) }])
  }
  const onInput = (e) => {
    const v = e.currentTarget.value
    if (v) send([{ t: "text", v: v.slice(0, 200) }])
    e.currentTarget.value = ""
  }
  const onPaste = (e) => {
    e.preventDefault()
    const v = (e.clipboardData?.getData("text") || "").slice(0, 200)
    if (v) send([{ t: "text", v }])
  }

  // ---- drag (desktop) ------------------------------------------------------------------------------------------
  const drag = useRef(null)
  const onHeadDown = (e) => {
    if (mobile || e.button !== 0 || e.target.closest("button, a")) return
    const r = popRef.current.getBoundingClientRect()
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onHeadMove = (e) => {
    if (!drag.current) return
    const r = popRef.current.getBoundingClientRect()
    setPos({
      x: Math.min(Math.max(8, e.clientX - drag.current.dx), window.innerWidth - r.width - 8),
      y: Math.min(Math.max(8, e.clientY - drag.current.dy), window.innerHeight - 56),
    })
  }
  const onHeadUp = () => (drag.current = null)
  // resize from the bottom-right corner (desktop); the size is kept for next time
  const grip = useRef(null)
  const onGripDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const r = popRef.current.getBoundingClientRect()
    grip.current = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top }
    if (!pos) setPos({ x: r.left, y: r.top }) // anchor the top-left corner while resizing
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onGripMove = (e) => {
    const g = grip.current
    if (!g) return
    g.last = {
      w: Math.round(Math.min(Math.max(420, g.w + e.clientX - g.x), window.innerWidth - g.left - 8)),
      h: Math.round(Math.min(Math.max(320, g.h + e.clientY - g.y), window.innerHeight - g.top - 8)),
    }
    setDim(g.last)
  }
  const onGripUp = () => {
    if (!grip.current) return
    const last = grip.current.last
    grip.current = null
    if (!last) return
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify(last))
    } catch {}
  }
  // keep a dragged window on screen when the viewport shrinks
  useLayoutEffect(() => {
    if (!pos) return
    const fix = () => setPos((p) => p && { x: Math.min(p.x, Math.max(8, window.innerWidth - (popRef.current?.offsetWidth || 540) - 8)), y: Math.min(p.y, window.innerHeight - 56) })
    window.addEventListener("resize", fix)
    return () => window.removeEventListener("resize", fix)
  }, [pos])

  // the official page itself is an error page (HTTP 429 "Too Many Requests" …): explain, offer a reload after a pause
  const RETRY_AFTER_MS = 20_000
  const retryAt = assist.pageError ? Math.max((assist.pageErrorAt || now) + RETRY_AFTER_MS, (assist.reloadAt || 0) + 15_000) : 0
  const [reloading, setReloading] = useState(false)
  const reload = async () => {
    setReloading(true)
    try {
      await api.reloadAssist(chatId, assist.assistId)
    } catch {}
    setTimeout(() => setReloading(false), 4000)
  }
  const cancel = async () => {
    setCancelling(true)
    await onCancel?.(assist)
    setCancelling(false)
  }
  const style = mobile
    ? undefined
    : {
        ...(pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : {}),
        ...(dim ? { width: Math.min(dim.w, window.innerWidth - 16), height: Math.min(dim.h, window.innerHeight - 16) } : {}),
      }
  const zoomed = typeof zoom === "number"
  return (
    <div
      ref={popRef}
      className={`assist-pop ${mobile ? "sheet" : ""} ${zoomed ? "zoomed" : ""}`}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`assist-t-${assist.assistId}`}
      aria-describedby={`assist-d-${assist.assistId}`}
      tabIndex={-1}
      data-assist={assist.assistId}
    >
      <div className="assist-head" onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp}>
        <span className="assist-lock" aria-hidden="true">
          <IconLock size={14} />
        </span>
        <div className="assist-title">
          <strong id={`assist-t-${assist.assistId}`}>{t(`assist.source.${srcKey(assist)}`)}</strong>
          <span className="assist-host">
            <Data v={assist.host} code /> · {t(`assist.purpose.${assist.purpose === "company_verify" ? "company_verify" : "company_lookup"}`)}
          </span>
        </div>
        {waiting && (
          <span className={`assist-count ${left < 60_000 ? "low" : ""}`} aria-label={t("assist.timeLeft", { time: mmss(left) })} role="timer">
            {mmss(left)}
          </span>
        )}
        <div className="assist-zoom" role="group" aria-label={t("assist.zoom")}>
          <button type="button" className="icon-btn sm assist-zoom-out" onClick={zoomOut} disabled={zoom === "fit"} title={t("assist.zoomOut")} aria-label={t("assist.zoomOut")}>
            <span aria-hidden="true">−</span>
          </button>
          <button
            type="button"
            className="assist-zoom-label"
            onClick={() => setZoom(zoom === "fit" ? (autoZoom() === "fit" ? 1 : autoZoom()) : "fit")}
            title={zoom === "fit" ? t("assist.zoomFocus") : t("assist.zoomFit")}
          >
            {zoom === "fit" || zoom == null ? t("assist.fit") : `${Math.round(zoom * 100)}%`}
          </button>
          <button type="button" className="icon-btn sm assist-zoom-in" onClick={zoomIn} disabled={zoom === LEVELS.at(-1)} title={t("assist.zoomIn")} aria-label={t("assist.zoomIn")}>
            <span aria-hidden="true">+</span>
          </button>
        </div>
        {assist.openUrl && (
          <a className="icon-btn sm" href={assist.openUrl} target="_blank" rel="noopener noreferrer" title={t("assist.openTab")} aria-label={t("assist.openTab")}>
            <IconExternal size={15} />
          </a>
        )}
        <button type="button" className="icon-btn sm assist-close" onClick={onMinimize} title={t("assist.minimize")} aria-label={t("assist.minimize")}>
          <IconClose size={15} />
        </button>
      </div>
      <p className="assist-note" id={`assist-d-${assist.assistId}`}>
        <IconShield size={14} aria-hidden="true" />{" "}
        <span>
          {/* the button / checkbox names are the official page's own (Vietnamese) labels → data */}
          <Trans
            k={`assist.notice.${srcKey(assist)}`}
            vars={{
              button: <Data v={assist.source === "dkkd" ? "Tìm kiếm" : "Tra cứu"} lang="vi" q />, // i18n-ignore (label on the official page)
              box: <Data v="I'm not a robot" lang="en" q />, // reCAPTCHA widget label (the widget shows it in the browser language of the sandbox Chrome)
            }}
          />
        </span>
      </p>
      {assist.notice && (
        <p className="assist-page-msg" role="alert" key={assist.noticeAt || assist.notice}>
          <IconAlert size={14} aria-hidden="true" /> <span>{t("assist.pageSays")}</span> <Data v={assist.notice} q />
        </p>
      )}
      {assist.pageError && (
        <div className="assist-page-err" role="alert">
          <IconAlert size={15} aria-hidden="true" />
          <span>{t(`assist.pageError.${["rate_limited", "server_error"].includes(assist.pageError) ? assist.pageError : "http_error"}`)}</span>
          <button type="button" className="btn ghost sm" onClick={reload} disabled={reloading || now < retryAt}>
            {reloading ? <Spinner size={12} /> : null} {now < retryAt ? t("assist.retryIn", { s: Math.ceil((retryAt - now) / 1000) }) : t("assist.retry")}
          </button>
        </div>
      )}
      {assist.blockedNav > 0 && (
        <p className="assist-page-msg" role="status">
          {t("assist.blockedNav")}
        </p>
      )}
      <div ref={stageRef} className={`assist-stage ${focused ? "focused" : ""}`}>
        <canvas
          ref={canvasRef}
          className="assist-canvas"
          style={zoomed ? { width: Math.round(frameW * zoom) } : undefined}
          width={1200}
          height={800}
          aria-label={t("assist.canvasLabel")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (press.current.touch = null)}
          onContextMenu={(e) => e.preventDefault()}
        />
        <input
          ref={kbdRef}
          className="assist-kbd"
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-label={t("assist.keyboardLabel")}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onInput={onInput}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {!ready && waiting && (
          <div className="assist-loading" role="status">
            <Spinner size={18} /> <span>{t("assist.connecting")}</span>
          </div>
        )}
        {!waiting && (
          <div className="assist-loading done" role="status">
            {assist.status === "done" ? <IconCheck size={18} /> : null} <span>{t(`assist.status.${assist.status}`)}</span>
          </div>
        )}
      </div>
      <div className="assist-foot">
        <span className="assist-state" aria-live="polite">
          {waiting ? (
            <>
              <span className="assist-dot" aria-hidden="true" /> {t("assist.status.waiting_user")}
              {focused ? <span className="assist-hint"> · {t("assist.kbdOn")}</span> : <span className="assist-hint"> · {t("assist.clickToType")}</span>}
            </>
          ) : (
            t(`assist.status.${assist.status}`)
          )}
          {mode === "poll" && <span className="assist-hint"> · {t("assist.slowMode")}</span>}
        </span>
        {waiting && (
          <button type="button" className="btn ghost sm" onClick={cancel} disabled={cancelling}>
            {cancelling ? <Spinner size={12} /> : null} {t("assist.cancel")}
          </button>
        )}
      </div>
      {!mobile && (
        <span className="assist-grip" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} title={t("assist.resize")} aria-hidden="true" />
      )}
    </div>
  )
}

/** One-line status in the message stream; reopens the window while the request waits. */
export function AssistChip({ assist, open, busy, onOpen }) {
  const t = useT()
  const st = assist.status
  const key = st === "done" ? (busy ? "doneReading" : "done") : st
  return (
    <div className={`assist-chip st-${st}`} role="status" data-assist-chip={assist.assistId}>
      {st === "waiting_user" ? <span className="assist-dot" aria-hidden="true" /> : st === "done" ? <IconCheck size={13} aria-hidden="true" /> : <IconLock size={13} aria-hidden="true" />}
      <span>{t(`assist.chip.${key}`)}</span>
      <span className="assist-chip-host">
        <Data v={assist.host} code />
      </span>
      {st === "waiting_user" && !open && (
        <button type="button" className="link-btn" onClick={onOpen}>
          {t("assist.reopen")}
        </button>
      )}
    </div>
  )
}
