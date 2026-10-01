import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api.js"
import { copyText, fold, modKey, navigate, relTime } from "../lib.js"
import { useApp } from "../settings.jsx"
import { Trans, fmtDateTime, useT } from "../i18n.jsx"
import { Dialog, Sentinel, useConfirm, useToast } from "./ui.jsx"
import { IconCheck, IconClose, IconCopy, IconExternal, IconLink, IconPin, IconSearch, IconShare, Spinner } from "./Icons.jsx"

// ---- search (Ctrl/⌘+K) ----------------------------------------------------------------------------
function Highlight({ text }) {
  // Server snippets mark hits with «…».
  const parts = String(text || "").split(/(«[^»]*»)/)
  return parts.map((p, i) => (p.startsWith("«") ? <mark key={i}>{p.slice(1, -1)}</mark> : <Fragment key={i}>{p}</Fragment>))
}

export function SearchDialog({ open, onClose, chats }) {
  const t = useT()
  const [q, setQ] = useState("")
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState(0)
  const [nextCur, setNextCur] = useState(null)
  const [moreLoading, setMoreLoading] = useState(false)
  const [moreErr, setMoreErr] = useState(false)
  const loadMore = async () => {
    if (!nextCur || moreLoading) return
    setMoreLoading(true)
    try {
      const r = await api.search(q.trim(), nextCur)
      setResults((xs) => [...(xs || []), ...r.results])
      setNextCur(r.next)
    } catch {
      setMoreErr(true)
    } finally {
      setMoreLoading(false)
    }
  }
  const listRef = useRef(null)
  useEffect(() => {
    if (open) {
      setQ("")
      setResults(null)
      setSel(0)
    }
  }, [open])
  // Instant title filter locally, then server results (titles + message text, all versions).
  const local = useMemo(() => {
    const n = fold(q.trim())
    const base = chats || []
    return (n ? base.filter((c) => fold(c.title).includes(n)) : base).slice(0, n ? 20 : 8).map((c) => ({ ...c, match: "title", snippet: "" }))
  }, [q, chats])
  useEffect(() => {
    const term = q.trim()
    if (!open || term.length < 2) {
      setResults(null)
      return
    }
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const r = await api.search(term)
        setResults(r.results)
        setNextCur(r.next)
        setMoreErr(false)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 220)
    return () => clearTimeout(t)
  }, [q, open])
  const items = results ?? local
  useEffect(() => setSel(0), [q, results])
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" })
  }, [sel])
  const go = (c) => {
    onClose()
    // The sidebar goes back to its first page after a search (see ChatApp).
    window.dispatchEvent(new CustomEvent("chats:reset"))
    navigate(`/c/${c.id}`)
  }
  return (
    <Dialog open={open} onClose={onClose} className="search-dialog" labelledBy="search-title">
      <h2 id="search-title" className="sr-only">
        {t("search.title")}
      </h2>
      <div className="search-box">
        <IconSearch size={18} />
        <input
          data-autofocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.inputLabel")}
          aria-controls="search-results"
          aria-activedescendant={items[sel] ? `sr-${items[sel].id}` : undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, items.length - 1))
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === "Enter" && items[sel]) go(items[sel])
          }}
        />
        {loading && <Spinner size={15} />}
        <button className="icon-btn sm" onClick={onClose} aria-label={t("search.close")}>
          <IconClose size={16} />
        </button>
      </div>
      <div className="search-results" id="search-results" role="listbox" ref={listRef} aria-label={t("search.results")}>
        {!q.trim() && <div className="search-section">{t("search.recent")}</div>}
        {items.length === 0 && q.trim() && !loading && <p className="search-empty">{t("search.empty", { q: q.trim() })}</p>}
        {items.map((c, i) => (
          <button
            key={c.id}
            id={`sr-${c.id}`}
            data-i={i}
            role="option"
            aria-selected={i === sel}
            className={`search-item ${i === sel ? "sel" : ""}`}
            onMouseMove={() => setSel(i)}
            onClick={() => go(c)}
          >
            <span className="search-item-title">
              {c.pinned && <IconPin size={13} />} {c.title}
            </span>
            {c.snippet && (
              <span className="search-item-snippet">
                <Highlight text={c.snippet} />
              </span>
            )}
            <span className="search-item-time">{relTime(c.updatedAt)}</span>
          </button>
        ))}
        {results && results.length > 0 && (
          <Sentinel rootRef={listRef} onVisible={loadMore} loading={moreLoading} done={!nextCur} error={moreErr} onRetry={() => (setMoreErr(false), loadMore())} endLabel={results.length > 10 ? t("search.end") : ""} />
        )}
      </div>
      <div className="search-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> {t("search.hintSelect")}
        </span>
        <span>
          <kbd>Enter</kbd> {t("search.hintOpen")}
        </span>
        <span>
          <kbd>Esc</kbd> {t("search.hintClose")}
        </span>
      </div>
    </Dialog>
  )
}

// ---- share -----------------------------------------------------------------------------------------
export function ShareDialog({ chat, onClose }) {
  const toast = useToast()
  const t = useT()
  const confirm = useConfirm()
  const [share, setShare] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const open = !!chat
  useEffect(() => {
    if (!chat) return
    setShare(undefined)
    setCopied(false)
    api.getShare(chat.id).then(
      (r) => setShare(r.share),
      (e) => {
        toast.error(e.message)
        setShare(null)
      },
    )
  }, [chat?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const url = share ? `${window.location.origin}/s/${share.token}` : ""
  const create = async () => {
    setBusy(true)
    try {
      const r = await api.createShare(chat.id)
      setShare(r.share)
      const link = `${window.location.origin}/s/${r.share.token}`
      if (await copyText(link)) {
        setCopied(true)
        toast.success(t("share.toastCreated"))
      }
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  const revoke = async () => {
    const ok = await confirm({ title: t("share.revokeTitle"), body: t("share.revokeBody"), confirmLabel: t("share.revoke"), danger: true })
    if (!ok) return
    setBusy(true)
    try {
      await api.revokeShare(share.token)
      setShare(null)
      toast.success(t("share.toastRevoked"))
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={t("share.dialogTitle")} labelledBy="share-title" className="share-dialog">
      <p className="share-lead">
        <Trans k="share.lead" vars={{ title: chat?.title || "" }} components={{ b: <strong /> }} />
      </p>
      {share === undefined ? (
        <div className="skeleton line" style={{ height: 44, borderRadius: 12 }} />
      ) : share ? (
        <>
          <div className="share-link">
            <IconLink size={16} />
            <input readOnly value={url} aria-label={t("share.linkLabel")} onFocus={(e) => e.target.select()} />
            <button
              className="btn primary sm"
              onClick={async () => {
                if (await copyText(url)) {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                }
              }}
            >
              {copied ? <IconCheck size={15} /> : <IconCopy size={15} />} {copied ? t("common.copiedShort") : t("common.copy")}
            </button>
          </div>
          <p className="share-note">
            {t("share.snapshotNote", { date: fmtDateTime(share.createdAt) })}
          </p>
          <div className="dialog-actions">
            <button className="btn ghost" onClick={revoke} disabled={busy}>
              {t("share.revoke")}
            </button>
            <a className="btn ghost" href={url} target="_blank" rel="noopener noreferrer">
              <IconExternal size={15} /> {t("share.view")}
            </a>
            <button className="btn primary" onClick={create} disabled={busy}>
              {busy ? <Spinner size={14} /> : null} {t("share.update")}
            </button>
          </div>
        </>
      ) : (
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn primary" onClick={create} disabled={busy}>
            {busy ? <Spinner size={14} /> : <IconShare size={15} />} {t("share.create")}
          </button>
        </div>
      )}
    </Dialog>
  )
}

// ---- keyboard shortcuts --------------------------------------------------------------------------
export const SHORTCUTS = [
  { k: "search", keys: [modKey, "K"] },
  { k: "newChat", keys: [modKey, "Shift", "O"] },
  { k: "focusInput", keys: ["/"] },
  { k: "send", keys: ["Enter"] },
  { k: "newline", keys: ["Shift", "Enter"] },
  { k: "modSend", keys: [modKey, "Enter"] },
  { k: "close", keys: ["Esc"] },
  { k: "settings", keys: [modKey, ","] },
  { k: "help", keys: ["?"] },
  { k: "helpTyping", keys: [modKey, "/"] },
]

export function ShortcutsDialog({ open, onClose }) {
  const t = useT()
  return (
    <Dialog open={open} onClose={onClose} title={t("shortcuts.title")} labelledBy="kbd-title" className="kbd-dialog" actions={<button className="btn primary" onClick={onClose}>{t("common.close")}</button>}>
      <dl className="kbd-list">
        {SHORTCUTS.map((s) => (
          <div key={s.k} className="kbd-row">
            <dt>{t(`shortcuts.${s.k}`)}</dt>
            <dd>
              {s.keys.map((k, i) => (
                <Fragment key={i}>
                  {i > 0 && <span className="kbd-plus">+</span>}
                  <kbd>{k}</kbd>
                </Fragment>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  )
}

/** Global shortcuts for the signed-in app. */
export function useGlobalShortcuts() {
  const { openDialog, dialog } = useApp()
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey
      const typing = e.target.closest?.("input, textarea, [contenteditable=true]")
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault()
        openDialog(dialog === "search" ? null : "search")
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault()
        openDialog(null)
        navigate("/")
      } else if (mod && e.key === ",") {
        e.preventDefault()
        openDialog("settings:general")
      } else if ((mod && e.key === "/") || (e.key === "?" && !typing && !mod && !document.querySelector(".dialog"))) {
        e.preventDefault()
        openDialog("shortcuts")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [openDialog, dialog])
}

// ---- about & limitations ---------------------------------------------------------------------------
/** Product purpose, the AI model (generic – no vendor / provider details), not legal advice, data handling, escalation. */
export function AboutDialog({ open, onClose }) {
  const t = useT()
  const sections = ["purpose", "advice", "data", "escalation"]
  return (
    <Dialog open={open} onClose={onClose} title={t("about.title")} labelledBy="about-title" className="about-dialog" actions={<button className="btn primary" onClick={onClose}>{t("common.close")}</button>}>
      <div className="about-model">
        <span className="about-model-name">{t("about.model")}</span>
      </div>
      {sections.map((k) => (
        <section key={k} className="about-sec">
          <h3>{t(`about.${k}.title`)}</h3>
          <p>{t(`about.${k}.body`)}</p>
        </section>
      ))}
    </Dialog>
  )
}
