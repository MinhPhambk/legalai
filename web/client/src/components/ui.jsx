import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { IconAlert, IconCheck, IconClose } from "./Icons.jsx"
import { Trans, fmtNumber, useT } from "../i18n.jsx"

// ---- toasts ------------------------------------------------------------------------------------
const ToastCtx = createContext(null)
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }) {
  const t = useT()
  const [items, setItems] = useState([])
  // The portal is created after mount so the server-rendered (prerendered) markup hydrates cleanly.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const dismiss = useCallback((id) => {
    setItems((xs) => xs.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 220)
  }, [])
  const push = useCallback(
    (kind, message, ms = 4200) => {
      const id = Math.random().toString(36).slice(2)
      setItems((xs) => [...xs.slice(-3), { id, kind, message }])
      if (ms) setTimeout(() => dismiss(id), ms)
      return id
    },
    [dismiss],
  )
  const api = useRef(null)
  api.current ??= {}
  api.current.info = (m, ms) => push("info", m, ms)
  api.current.success = (m, ms) => push("success", m, ms)
  api.current.error = (m, ms) => push("error", m, ms ?? 6000)
  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      {mounted &&
        createPortal(
        <div className="toasts" role="region" aria-label={t("common.notifications")} aria-live="polite">
          {items.map((it) => (
            <div key={it.id} className={`toast toast-${it.kind} ${it.leaving ? "leaving" : ""}`} role={it.kind === "error" ? "alert" : "status"}>
              <span className="toast-icon">{it.kind === "error" ? <IconAlert size={16} /> : <IconCheck size={16} />}</span>
              <span className="toast-msg">{it.message}</span>
              <button className="icon-btn sm" onClick={() => dismiss(it.id)} aria-label={t("common.dismissNotification")}>
                <IconClose size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  )
}

// ---- modal dialog ------------------------------------------------------------------------------
export function Dialog({ open, title, children, onClose, actions, labelledBy = "dlg-title", className = "" }) {
  const [render, setRender] = useState(open)
  const [leaving, setLeaving] = useState(false)
  const boxRef = useRef(null)
  const lastFocus = useRef(null)
  useEffect(() => {
    if (open) {
      lastFocus.current = document.activeElement
      setRender(true)
      setLeaving(false)
    } else if (render) {
      setLeaving(true)
      const t = setTimeout(() => setRender(false), 180)
      lastFocus.current?.focus?.()
      return () => clearTimeout(t)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!render || leaving) return
    const box = boxRef.current
    const first = box?.querySelector("[data-autofocus]") || box?.querySelector("button, input, textarea")
    first?.focus()
    const onKey = (e) => {
      const all = document.querySelectorAll(".dialog")
      if (all[all.length - 1] !== box) return // only the topmost dialog reacts
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose?.()
      }
      if (e.key === "Tab" && box) {
        const f = [...box.querySelectorAll("button, input, textarea, [href]")].filter((el) => !el.disabled)
        if (!f.length) return
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault()
          f[f.length - 1].focus()
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault()
          f[0].focus()
        }
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [render, leaving, onClose])
  if (!render) return null
  return createPortal(
    <div className={`dialog-backdrop ${leaving ? "leaving" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={boxRef}>
        {title && (
          <h2 id={labelledBy} className="dialog-title">
            {title}
          </h2>
        )}
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---- confirm dialogs (promise based) -----------------------------------------------------------
const ConfirmCtx = createContext(null)
export const useConfirm = () => useContext(ConfirmCtx)

/**
 * confirm({ title, body, confirmLabel, danger, typed }) → Promise<boolean>.
 * `typed`: the user must type this exact text to enable the confirm button (destructive actions).
 */
export function ConfirmProvider({ children }) {
  const t = useT()
  const [state, setState] = useState(null)
  const [typed, setTyped] = useState("")
  const resolver = useRef(null)
  const lastState = useRef(null)
  if (state) lastState.current = state
  const confirm = useCallback((opts) => {
    setTyped("")
    setState(opts)
    return new Promise((resolve) => (resolver.current = resolve))
  }, [])
  const close = (v) => {
    resolver.current?.(v)
    resolver.current = null
    setState(null)
  }
  const s = state || lastState.current || {}
  const ok = !s.typed || typed.trim() === s.typed
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        title={s.title}
        onClose={() => close(false)}
        labelledBy="confirm-title"
        actions={
          <>
            <button className="btn ghost" data-autofocus={!s.typed || undefined} onClick={() => close(false)}>
              {s.cancelLabel || t("common.cancel")}
            </button>
            <button className={`btn ${s.danger ? "danger" : "primary"}`} disabled={!ok} onClick={() => close(true)}>
              {s.confirmLabel || t("common.ok")}
            </button>
          </>
        }
      >
        {typeof s.body === "string" ? <p>{s.body}</p> : s.body}
        {s.typed && (
          <div className="field confirm-typed">
            <label htmlFor="confirm-typed-input">
              <Trans k="common.typeToConfirm" vars={{ text: s.typed }} components={{ b: <strong /> }} />
            </label>
            <input
              id="confirm-typed-input"
              data-autofocus
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ok && close(true)}
            />
          </div>
        )}
      </Dialog>
    </ConfirmCtx.Provider>
  )
}

// ---- pagination -----------------------------------------------------------------------------------
/** Invisible marker that calls onVisible when it scrolls into view (infinite lists). */
export function Sentinel({ onVisible, loading, done, error, onRetry, endLabel, rootRef }) {
  const t = useT()
  if (endLabel === undefined) endLabel = t("common.endOfList")
  const ref = useRef(null)
  const cb = useRef(onVisible)
  cb.current = onVisible
  useEffect(() => {
    const el = ref.current
    if (!el || done || error) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && cb.current?.(), { root: rootRef?.current || null, rootMargin: "200px" })
    io.observe(el)
    return () => io.disconnect()
  }, [done, error, rootRef])
  if (error)
    return (
      <div className="list-sentinel" role="alert">
        {t("common.loadFailed")} <button className="link-btn" onClick={onRetry}>{t("common.retry")}</button>
      </div>
    )
  if (done) return endLabel ? <div className="list-end">{endLabel}</div> : null
  return (
    <div className="list-sentinel" ref={ref} aria-live="polite">
      {loading ? (
        <>
          <span className="spinner" style={{ width: 13, height: 13 }} /> {t("common.loading")}
        </>
      ) : (
        <span aria-hidden="true">&nbsp;</span>
      )}
    </div>
  )
}

/** Numbered pagination with page-size selector (wraps on narrow screens). */
export function Pager({ page, pages, size, total, onPage, onSize, unit = "common.items" }) {
  const t = useT()
  if (!total) return null
  const nums = []
  const add = (n) => !nums.includes(n) && n >= 1 && n <= pages && nums.push(n)
  add(1)
  for (let n = page - 2; n <= page + 2; n++) add(n)
  add(pages)
  nums.sort((a, b) => a - b)
  return (
    <nav className="pager" aria-label={t("common.pagination")}>
      <button onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label={t("common.prevPage")}>
        ‹
      </button>
      <span className="pager-pages">
        {nums.map((n, i) => (
          <span key={n} style={{ display: "contents" }}>
            {i > 0 && n - nums[i - 1] > 1 && <span aria-hidden="true">…</span>}
            <button className={n === page ? "on" : ""} aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}>
              {n}
            </button>
          </span>
        ))}
      </span>
      <button onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label={t("common.nextPage")}>
        ›
      </button>
      <label>
        <span className="sr-only">{t("common.rowsPerPage")}</span>
        <select value={size} onChange={(e) => onSize(Number(e.target.value))}>
          {[20, 50, 100].map((n) => (
            <option key={n} value={n}>
              {t("common.perPage", { n })}
            </option>
          ))}
        </select>
      </label>
      <span className="pager-total">
        {t(unit, { count: total })}
      </span>
    </nav>
  )
}

/** Read/write a few query-string params (keeps filters and paging in the URL). */
export function useQueryState(defaults) {
  const read = () => {
    const sp = new URLSearchParams(window.location.search)
    return Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, sp.get(k) ?? d]))
  }
  const [state, setState] = useState(read)
  const update = useCallback(
    (patch) =>
      setState((s) => {
        const next = { ...s, ...patch }
        const sp = new URLSearchParams(window.location.search)
        for (const [k, v] of Object.entries(next)) {
          if (v === "" || v == null || String(v) === String(defaults[k])) sp.delete(k)
          else sp.set(k, String(v))
        }
        const qs = sp.toString()
        window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""))
        return next
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )
  return [state, update]
}

// ---- small controls ----------------------------------------------------------------------------
export function Switch({ checked, onChange, label, description, id, disabled }) {
  return (
    <label className={`switch-row ${disabled ? "disabled" : ""}`} htmlFor={id}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {description && <span className="switch-desc">{description}</span>}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={!!checked}
        disabled={disabled}
        className={`switch ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </label>
  )
}

export function Segmented({ value, onChange, options, label }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? "on" : ""}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
            e.preventDefault()
            const i = options.findIndex((x) => x.value === value)
            const n = options[(i + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length]
            onChange(n.value)
            e.currentTarget.parentElement.querySelector(`[aria-checked="true"]`)?.focus()
          }}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

// ---- popover menu ------------------------------------------------------------------------------
/** Click-outside / Escape aware popover. `anchor` is the toggle button's ref. */
export function Popover({ open, onClose, anchorRef, className = "", children, label }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || anchorRef?.current?.contains(e.target)) return
      onClose()
    }
    const onKey = (e) => {
      if (e.key === "Escape") {
        onClose()
        anchorRef?.current?.focus()
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = [...(ref.current?.querySelectorAll("[role=menuitem], [role=menuitemradio]") || [])]
        if (!items.length) return
        e.preventDefault()
        const i = items.indexOf(document.activeElement)
        const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length
        items[next].focus()
      }
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("touchstart", onDown, { passive: true })
    document.addEventListener("keydown", onKey)
    const first = ref.current?.querySelector("[role=menuitem], [role=menuitemradio]")
    first?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("touchstart", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, onClose, anchorRef])
  // Open upwards when there is no room below (phone landscape, items near the bottom).
  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el) return
    el.classList.remove("flip")
    const r = el.getBoundingClientRect()
    if (r.bottom > window.innerHeight - 8 && r.top - r.height > 8) el.classList.add("flip")
  }, [open])
  if (!open) return null
  return (
    <div className={`popover ${className}`} role="menu" aria-label={label} ref={ref}>
      {children}
    </div>
  )
}
