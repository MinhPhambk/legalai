import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react"
import { api } from "../api.js"
import { formatBytes } from "../lib.js"
import { fmtNumber, getLocale, intlLocale, useT } from "../i18n.jsx"
import { detectPii } from "../pii.js"
import { useApp } from "../settings.jsx"
import { useToast } from "./ui.jsx"
import { IconAlert, IconClip, IconClose, IconFile, IconRefresh, IconSend, IconStop, Spinner } from "./Icons.jsx"
import { OcrBadge } from "./OcrBadge.jsx"

export const ACCEPT = [".docx", ".pdf", ".txt", ".md"]
const MAX = 10 * 1024 * 1024
const MAX_FILES = 5

/** Upload queue shared by the composer and the drop zone. */
export function useUploads() {
  const toast = useToast()
  const t = useT()
  const [items, setItems] = useState([])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const update = (key, patch) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  // Server-side processing after the bytes are sent (a scanned PDF is OCR'd – ~2.5 s/page, one file at a time):
  // poll the phase so the chip says what is happening.
  const polls = useRef(new Map())
  const stopPoll = (key) => {
    clearInterval(polls.current.get(key))
    polls.current.delete(key)
  }
  const startPoll = (key, upKey) => {
    if (!upKey || polls.current.has(key)) return
    const tick = () =>
      api.uploadProgress(upKey).then(
        (r) => polls.current.has(key) && ["extract", "ocr-wait", "ocr"].includes(r?.phase) && update(key, { phase: r.phase, ocrPages: r.pages || 0 }),
        () => {},
      )
    polls.current.set(key, setInterval(tick, 900))
    tick()
  }
  useEffect(() => () => polls.current.forEach((t) => clearInterval(t)), [])

  const add = useCallback(
    (fileList) => {
      const files = [...fileList]
      let slots = MAX_FILES - itemsRef.current.length
      for (const file of files) {
        const ext = "." + (file.name.split(".").pop() || "").toLowerCase()
        if (!ACCEPT.includes(ext)) {
          toast.error(t("composer.badType", { name: file.name }))
          continue
        }
        if (file.size > MAX) {
          toast.error(t("composer.tooBig", { name: file.name }))
          continue
        }
        if (slots-- <= 0) {
          toast.error(t("composer.tooMany", { count: MAX_FILES }))
          break
        }
        const key = Math.random().toString(36).slice(2)
        const req = api.upload(file, (p) => {
          update(key, { progress: p })
          if (p >= 1) startPoll(key, req.key)
        })
        setItems((xs) => [...xs, { key, name: file.name, size: file.size, progress: 0, status: "uploading", req }])
        req.then(
          (u) => {
            stopPoll(key)
            update(key, { status: "done", progress: 1, phase: null, id: u.id, truncated: u.truncated, pii: Array.isArray(u.pii) ? u.pii : [], ocr: u.ocr?.pages?.length ? { n: u.ocr.pages.length, total: u.ocr.totalPages || u.ocr.pages.length } : null, req: null })
            if (u.truncated) toast.info(t("composer.truncated", { name: u.name, chars: fmtNumber(u.chars), sent: fmtNumber(u.sentChars) }), 7000)
          },
          (err) => {
            stopPoll(key)
            if (err.code === "aborted") return
            update(key, { status: "error", error: err.message, req: null })
            toast.error(t("composer.fileError", { name: file.name, message: err.message }))
          },
        )
      }
    },
    [toast, t],
  )
  const remove = useCallback((key) => {
    const it = itemsRef.current.find((x) => x.key === key)
    stopPoll(key)
    if (it?.req) it.req.abort()
    if (it?.id) api.deleteUpload(it.id).catch(() => {})
    setItems((xs) => xs.filter((x) => x.key !== key))
  }, [])
  const clear = useCallback(() => setItems([]), [])
  return { items, add, remove, clear }
}

/** What an upload in flight is doing: sending bytes (%), reading the text, waiting for / running OCR of a scan. */
function uploadPhaseText(t, f) {
  if ((f.progress || 0) < 1 || !f.phase) return t("composer.uploading", { pct: Math.round((f.progress || 0) * 100) })
  if (f.phase === "ocr") return t("composer.ocrRunning")
  if (f.phase === "ocr-wait") return t("composer.ocrWait")
  return t("composer.processing")
}
/** Chip tooltip: name + the long form of the phase (pages being recognised, why it waits) or the OCR note. */
function chipTitle(t, f) {
  if (f.error) return f.error
  if (f.status === "uploading" && f.phase === "ocr") return `${f.name} – ${f.ocrPages ? t("composer.ocrRunningPages", { count: f.ocrPages }) : t("composer.ocrRunning")}`
  if (f.status === "uploading" && f.phase === "ocr-wait") return `${f.name} – ${t("composer.ocrWaitTip")}`
  return f.ocr ? `${f.name} – ${t("ocr.tip")}` : f.name
}

/** "citizen ID number and phone number" (locale list format). */
const piiKinds = (t, kinds) => {
  const names = kinds.map((k) => t(`composer.pii.kind.${k}`))
  try {
    return new Intl.ListFormat(intlLocale(getLocale()), { type: "conjunction" }).format(names)
  } catch {
    return names.join(", ")
  }
}

/** `answering`: a clarifying question is open – the text becomes its free-text answer (no files), Stop stays available. */
export default function Composer({ ref, busy, answering = false, disabled, onSend, onStop, uploads, enterToSend = true }) {
  const t = useT()
  const { openDialog, autoRepair } = useApp()
  const toast = useToast()
  const [text, setText] = useState("")
  // Personal-identifier warning (always on, non-blocking): { kinds, reason: "send" | "file", keys } – values are never kept.
  const [pii, setPii] = useState(null)
  const ackRef = useRef(new Set())
  const taRef = useRef(null)
  const fileRef = useRef(null)
  const uploading = uploads.items.some((x) => x.status === "uploading")
  const ready = uploads.items.filter((x) => x.status === "done")
  const canSend = answering ? !disabled && !!text.trim() : !busy && !disabled && !uploading && (text.trim() || ready.length)

  useImperativeHandle(ref, () => ({
    setText: (t) => {
      setText(t)
      requestAnimationFrame(() => {
        const ta = taRef.current
        ta?.focus()
        ta?.setSelectionRange(t.length, t.length)
      })
    },
    focus: () => taRef.current?.focus(),
    openFile: () => fileRef.current?.click(),
  }))

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px"
  }, [text])

  useEffect(() => {
    if (!busy && !disabled && window.matchMedia("(pointer: fine)").matches) taRef.current?.focus({ preventScroll: true })
  }, [busy, disabled])

  // A finished upload whose text contains personal identifiers → warn once (non-blocking).
  useEffect(() => {
    const flagged = uploads.items.filter((f) => f.status === "done" && f.pii?.length && !ackRef.current.has(`f:${f.key}`))
    if (!flagged.length) return
    setPii({ reason: "file", kinds: [...new Set(flagged.flatMap((f) => f.pii))], keys: flagged.map((f) => f.key) })
  }, [uploads.items])

  const doSend = () => {
    setPii(null)
    const ok = onSend(text.trim(), answering ? [] : ready)
    if (ok !== false) setText("")
  }
  const send = () => {
    if (!canSend) return
    const kinds = detectPii(text)
    const sig = `t:${text.trim()}`
    if (kinds.length && !ackRef.current.has(sig)) {
      setPii({ reason: "send", kinds, sig })
      return
    }
    doSend()
  }
  const piiProceed = () => {
    if (pii?.reason === "send") {
      ackRef.current.add(pii.sig)
      doSend()
    } else {
      for (const k of pii?.keys || []) ackRef.current.add(`f:${k}`)
      setPii(null)
    }
  }
  const piiEdit = () => {
    if (pii?.reason === "file") for (const k of pii.keys || []) uploads.remove(k)
    setPii(null)
    requestAnimationFrame(() => taRef.current?.focus())
  }

  return (
    <div className="composer-wrap">
      {pii && (
        <div className="pii-warn" role="alert">
          <IconAlert size={15} />
          <span className="pii-warn-text">{t(pii.reason === "file" ? "composer.pii.fileWarn" : "composer.pii.warn", { kinds: piiKinds(t, pii.kinds) })}</span>
          <span className="pii-warn-actions">
            <button type="button" className="btn ghost xs" onClick={piiEdit}>
              {pii.reason === "file" ? t("composer.pii.removeFiles") : t("composer.pii.edit")}
            </button>
            <button type="button" className="btn primary xs" onClick={piiProceed}>
              {pii.reason === "file" ? t("composer.pii.keep") : t("composer.pii.sendAnyway")}
            </button>
          </span>
        </div>
      )}
      <form
        className={`composer ${busy ? "is-busy" : ""} ${answering ? "is-answering" : ""}`}
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        {uploads.items.length > 0 && (
          <ul className="chips" aria-label={t("composer.attachments")}>
            {uploads.items.map((f) => (
              <li key={f.key} className={`chip ${f.status} ${f.ocr ? "is-ocr" : ""} ${f.phase === "ocr" || f.phase === "ocr-wait" ? "is-ocr-run" : ""}`} title={chipTitle(t, f)}>
                <span className="chip-icon" aria-hidden="true">
                  {f.status === "uploading" ? <Spinner size={14} /> : f.status === "error" ? <IconAlert size={15} /> : <IconFile size={15} />}
                </span>
                <span className="chip-text">
                  <span className="chip-name">{f.name}</span>
                  <span className="chip-sub">
                    {f.status === "uploading" ? (
                      <span aria-live="polite">{uploadPhaseText(t, f)}</span>
                    ) : f.status === "error" ? (
                      t("common.error")
                    ) : (
                      <>
                        {formatBytes(f.size)}
                        {f.truncated ? ` · ${t("composer.truncatedShort")}` : ""}
                        {f.ocr && (
                          <>
                            {" · "}
                            <OcrBadge n={f.ocr.n} total={f.ocr.total} />
                          </>
                        )}
                      </>
                    )}
                  </span>
                </span>
                <button type="button" className="icon-btn xs" onClick={() => uploads.remove(f.key)} aria-label={t("composer.removeFile", { name: f.name })}>
                  <IconClose size={13} />
                </button>
                {f.status === "uploading" && <span className="chip-progress" style={{ transform: `scaleX(${f.progress || 0})` }} />}
              </li>
            ))}
          </ul>
        )}
        <label htmlFor="composer-input" className="sr-only">
          {t("composer.inputLabel")}
        </label>
        <textarea
          id="composer-input"
          ref={taRef}
          rows={1}
          value={text}
          placeholder={answering ? t("question.composerHint") : t("composer.placeholder")}
          maxLength={20000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
            if (enterToSend || e.ctrlKey || e.metaKey) {
              e.preventDefault()
              send()
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData?.files?.length) {
              e.preventDefault()
              uploads.add(e.clipboardData.files)
            }
          }}
        />
        <div className="composer-bar">
          <button type="button" className="icon-btn" onClick={() => fileRef.current?.click()} aria-label={t("composer.attachLabel")} title={t("composer.attach")} disabled={disabled || answering}>
            <IconClip />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT.join(",")}
            multiple
            hidden
            onChange={(e) => {
              uploads.add(e.target.files)
              e.target.value = ""
            }}
          />
          {autoRepair?.allowed && !answering && (
            // "Tự tra lại khi độ tin cậy thấp" – per-user, off by default, only while the admin allows it
            <button
              type="button"
              role="switch"
              aria-checked={autoRepair.enabled}
              aria-label={t("composer.autoRepairLabel")}
              title={t(autoRepair.enabled ? "composer.autoRepairOnTip" : "composer.autoRepairOffTip")}
              className={`composer-toggle ${autoRepair.enabled ? "on" : ""}`}
              onClick={() => autoRepair.set(!autoRepair.enabled).catch((e) => toast.error(e.message))}
            >
              <IconRefresh size={14} aria-hidden="true" />
              <span className="composer-toggle-label" aria-hidden="true">
                {t("composer.autoRepair")}
              </span>
              <span className="mini-switch" aria-hidden="true" />
            </button>
          )}
          <span className="composer-hint" aria-hidden="true">
            {enterToSend ? (
              <>
                <kbd>Enter</kbd> {t("composer.hintSend")} · <kbd>Shift</kbd>+<kbd>Enter</kbd> {t("composer.hintNewline")}
              </>
            ) : (
              <>
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> {t("composer.hintSend")} · <kbd>Enter</kbd> {t("composer.hintNewline")}
              </>
            )}
          </span>
          {busy && !(answering && text.trim()) ? (
            <button type="button" className="send-btn stop" onClick={onStop} aria-label={t("composer.stopLabel")} title={t("composer.stop")}>
              <IconStop />
            </button>
          ) : (
            <button type="submit" className="send-btn" disabled={!canSend} aria-label={t("composer.send")} title={t("composer.send")}>
              <IconSend />
            </button>
          )}
        </div>
      </form>
      <p className="composer-note">
        <span>{t("composer.disclaimer")}</span>
        <button type="button" className="link-btn composer-about" onClick={() => openDialog("about")}>
          {t("about.link")}
        </button>
      </p>
    </div>
  )
}
