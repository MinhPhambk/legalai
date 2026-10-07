import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  analyzeArtifact, artifactSummary, citeify, cleanModelText, collectSources, copyText, fmtDuration, normUrl, renderMarkdown,
  sourceSite, toolActive, toolTitle,
} from "../lib.js"
import { fmtDate, fmtTime, t, useT } from "../i18n.jsx"
import { LEGAL_CLAIM_RE, LEVEL_LOW, statusCodeOf } from "../codes.js"
import { StepArgs, StepError, StepRes, statusLabel, stepOf, stepPlain } from "./StepParts.jsx"
import { OcrBadge } from "./OcrBadge.jsx"
import { Data, guessLang } from "./DataText.jsx"
import { useToast } from "./ui.jsx"
import { ArtifactCards, CheckList, ConfidenceBadge, UPLOAD_DOC_NOTE, checkTip } from "./Extras.jsx"
import { clearChecks, markChecks, revealCheck } from "../checkmarks.js"
import QuestionCard from "./QuestionCard.jsx"
import { OrphanVisuals, RichHtml, VisualScope, orphanVisuals } from "./Visuals.jsx"
import DraftCard from "./DraftCard.jsx"
import ResultCard from "./ResultCard.jsx"
import {
  IconAlert, IconCheck, IconChevron, IconCopy, IconExternal, IconFile, IconLeft, IconPencil, IconRefresh, IconReport, IconRight, IconShield, IconX, Spinner,
} from "./Icons.jsx"

const Html = memo(function Html({ html, streaming, className = "" }) {
  // Model answer text: data in its own language (never translated) – excluded from the UI-language leak check.
  // Visual placeholders (diagrams, images, mermaid) are hydrated in place by RichHtml.
  return <RichHtml html={html} streaming={streaming} className={className} />
})

// ---- answer model: segments + citation registry + sources ---------------------------------------
/** Steps / text segments of one assistant turn, answer HTML with citation chips, and the source list. */
export function buildAnswer(messages, sourceMessages = messages) {
  const segs = []
  const drafts = new Map() // draftId -> draft segment (one progress card per draft, placed where it started)
  for (const m of messages) {
    for (const p of m.parts || []) {
      if (p.type === "text") {
        const text = cleanModelText(p.text)
        if (!text.trim()) continue
        segs.push({ kind: "text", id: p.id, text })
      } else if (p.type === "tool" && p.tool === "question") {
        // Clarifying question: its own card in the stream, not a step.
        segs.push({ kind: "question", id: p.id, part: p })
      } else if (p.type === "tool" && p.draft?.draftId) {
        // Long-document drafting (draft_* tools): all parts of one draft merge into one progress card.
        let d = drafts.get(p.draft.draftId)
        if (!d) {
          drafts.set(p.draft.draftId, (d = { kind: "draft", id: "d-" + p.draft.draftId, draft: p.draft, parts: [] }))
          segs.push(d)
        } else if ((p.draft.updatedAt || 0) >= (d.draft.updatedAt || 0)) d.draft = p.draft
        d.parts.push(p)
      } else {
        if (p.type === "reasoning" && !p.text?.trim()) continue
        let last = segs[segs.length - 1]
        if (!last || last.kind !== "steps") segs.push((last = { kind: "steps", id: "s-" + p.id, items: [] }))
        last.items.push(p)
      }
    }
  }
  const registry = new Map()
  for (const s of segs) if (s.kind === "text") s.html = citeify(renderMarkdown(s.text), registry)
  // looked-up sources of the whole turn (also the part before an automatic repair, shown collapsed)
  const meta = collectSources(sourceMessages)
  const sources = [...registry.entries()].map(([key, e]) => ({ ...(meta.get(key) || {}), ...e, key, cited: true }))
  let n = sources.length
  for (const [key, m] of meta) if (!registry.has(key)) sources.push({ ...m, key, n: ++n, cited: false })
  const answer = segs.filter((s) => s.kind === "text").map((s) => s.text).join("\n\n")
  return { segs, answer, registry, sources, byKey: new Map(sources.map((s) => [s.key, s])) }
}

// ---- citation preview ---------------------------------------------------------------------------
/** Legal status of a source (statusCode, or the legacy phrase) → { label, tone } in the UI language. */
export const sourceStatus = (s) => statusLabel(s?.statusCode || statusCodeOf(s?.status))
/** ISO date → locale format; legacy dd/mm/yyyy strings stay as they are. */
const srcDate = (iso, raw) => (iso ? fmtDate(iso + "T00:00:00") : raw || "")
/** Title of a source as data (the document's own language). */
/** Readable name for a link without a title: last path segment + the query values that identify the page
 *  (…/access-to-markets/en/results?product=0306179220&origin=VN&destination=FR → "results · 0306179220 · VN · FR"). */
export function urlLabel(url) {
  try {
    const u = new URL(url)
    const seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "")
      .replace(/\.(html?|aspx?|jsp|php)$/i, "").replace(/--\d+$/, "").replace(/[-_]+/g, " ").trim()
    const vals = [...u.searchParams].filter(([k]) => !/^(utm_|lang|locale|ref|fbclid|gclid)/i.test(k)).map(([, v]) => decodeURIComponent(v).replace(/^CELEX:/i, "CELEX "))
    const label = [seg, ...vals].filter(Boolean).join(" · ")
    return label.length > 90 ? label.slice(0, 89) + "…" : label || u.hostname
  } catch {
    return url
  }
}
export function SourceTitle({ s }) {
  const v = s.title || s.label || urlLabel(s.url)
  return <Data v={v} lang={s.title ? s.titleLang || s.lang : guessLang(v)} />
}

/** "Điều 300. Phạt vi phạm" → "Article 300" / "Điều 300" (chrome); other headings stay data. */
const ART_HEAD = /^(?:Điều|Article)\s+(\S+?)\.?(?:\s|$)/ // i18n-ignore
function SourceSub({ s }) {
  const t = useT()
  const st = sourceStatus(s)
  const art = s.articles?.[0]?.match(ART_HEAD)?.[1]
  const parts = [s.number ? <Data key="n" v={s.number} code /> : null, art ? <span key="a">{t("tools.text.article", { n: art })}</span> : null, st ? <span key="s">{st.label}</span> : null].filter(Boolean)
  return (
    <span className="src-sub">
      {parts.length ? parts.map((p, i) => [i > 0 ? " · " : null, p]) : s.cited ? "" : t("sources.looked")}
    </span>
  )
}

function SourceCardBody({ s }) {
  const st = sourceStatus(s)
  return (
    // Module-level t: rendered inside components that already subscribe to the locale.
    <>
      <div className="src-site">
        <span className="src-num">{s.n}</span>
        <span>{sourceSite(s.url)}</span>
      </div>
      <div className="src-title">
        <SourceTitle s={s} />
      </div>
      <dl className="src-meta">
        {s.number && (
          <>
            <dt>{s.kind === "fedreg" ? t("sources.meta.docNumber") : t("sources.meta.number")}</dt>
            <dd>
              <Data v={s.number} code />
            </dd>
          </>
        )}
        {s.articles?.length > 0 && (
          <>
            <dt>{t("sources.meta.articles")}</dt>
            <dd>
              <Data v={s.articles.slice(0, 3).join("; ")} lang={s.lang || "vi"} />
              {s.articles.length > 3 ? ` (+${s.articles.length - 3})` : ""}
            </dd>
          </>
        )}
        {(st || s.status) && (
          <>
            <dt>{t("sources.meta.status")}</dt>
            <dd>{st ? <span className={`status-badge ${st.tone}`}>{st.label}</span> : <Data v={s.status} lang="vi" />}</dd>
          </>
        )}
        {s.citation && (
          <>
            <dt>{t("sources.meta.citation")}</dt>
            <dd>
              <Data v={s.citation} code />
            </dd>
          </>
        )}
        {(s.issuedIso || s.issued) && (
          <>
            <dt>{s.kind === "vbpl" ? t("sources.meta.issued") : t("sources.meta.published")}</dt>
            <dd>{s.issuedIso ? srcDate(s.issuedIso) : <Data v={s.issued} code />}</dd>
          </>
        )}
        {(s.agencyCode || s.agency) && s.kind !== "vbpl" && (
          <>
            <dt>{t("sources.meta.agency")}</dt>
            <dd>{s.agencyCode === "trav" ? t("sources.agency.trav") : <Data v={s.agency} />}</dd>
          </>
        )}
        {(s.accessedIso || s.accessed) && (
          <>
            <dt>{t("sources.meta.accessed")}</dt>
            <dd>{s.accessedIso ? srcDate(s.accessedIso) : <Data v={s.accessed} code />}</dd>
          </>
        )}
      </dl>
    </>
  )
}

/** Hover (mouse) / tap (touch) preview for `.cite` chips inside `rootRef`. */
export function useCitationPreview(rootRef, byKey) {
  const [card, setCard] = useState(null) // { s, rect }
  const hideT = useRef(0)
  const lastPointer = useRef("mouse")
  // Listeners are delegated from document and resolved against rootRef at event time, so they work
  // for containers that mount later (e.g. the report panel body).
  const byKeyRef = useRef(byKey)
  byKeyRef.current = byKey
  useEffect(() => {
    const inRoot = (el) => !!el && !!rootRef.current?.contains(el)
    const show = (el) => {
      clearTimeout(hideT.current)
      const s = byKeyRef.current.get(el.dataset.cite)
      if (s) setCard({ s, rect: el.getBoundingClientRect(), el, at: Date.now() })
    }
    const hide = () => {
      clearTimeout(hideT.current)
      hideT.current = setTimeout(() => setCard(null), 160)
    }
    const over = (e) => {
      const el = e.target.closest?.(".cite")
      if (inRoot(el) && lastPointer.current === "mouse") show(el)
    }
    const out = (e) => lastPointer.current === "mouse" && inRoot(e.target.closest?.(".cite")) && hide()
    const down = (e) => (lastPointer.current = e.pointerType || "mouse")
    const click = (e) => {
      const el = e.target.closest?.(".cite")
      if (!inRoot(el)) return
      if (lastPointer.current !== "mouse") {
        // First tap previews, the card has the "Mở nguồn" link.
        e.preventDefault()
        show(el)
      }
    }
    const focus = (e) => e.target.classList?.contains("cite") && inRoot(e.target) && lastPointer.current === "mouse" && show(e.target)
    const blur = (e) => e.target.classList?.contains("cite") && inRoot(e.target) && lastPointer.current === "mouse" && hide()
    const opts = true
    document.addEventListener("mouseover", over, opts)
    document.addEventListener("mouseout", out, opts)
    document.addEventListener("pointerdown", down, opts)
    document.addEventListener("click", click, opts)
    document.addEventListener("focusin", focus, opts)
    document.addEventListener("focusout", blur, opts)
    return () => {
      document.removeEventListener("mouseover", over, opts)
      document.removeEventListener("mouseout", out, opts)
      document.removeEventListener("pointerdown", down, opts)
      document.removeEventListener("click", click, opts)
      document.removeEventListener("focusin", focus, opts)
      document.removeEventListener("focusout", blur, opts)
    }
  }, [rootRef])
  useEffect(() => {
    if (!card) return
    const close = (e) => {
      if (e.type === "keydown" && e.key !== "Escape") return
      if (e.type === "pointerdown" && (e.target.closest?.(".cite-card") || e.target.closest?.(".cite"))) return
      setCard(null)
    }
    // A tap focuses the chip and the browser may scroll it into view – ignore scrolls right after opening.
    const onScroll = () => Date.now() - card.at > 450 && setCard(null)
    document.addEventListener("pointerdown", close)
    document.addEventListener("keydown", close)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("pointerdown", close)
      document.removeEventListener("keydown", close)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [card])
  const node = card
    ? createPortal(
        <CiteCard
          card={card}
          onEnter={() => clearTimeout(hideT.current)}
          onLeave={() => {
            hideT.current = setTimeout(() => setCard(null), 160)
          }}
        />,
        document.body,
      )
    : null
  return node
}

function CiteCard({ card, onEnter, onLeave }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: card.rect.left, top: card.rect.bottom + 8, place: "below" })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = Math.min(Math.max(12, card.rect.left + card.rect.width / 2 - w / 2), vw - w - 12)
    let top = card.rect.bottom + 8
    let place = "below"
    if (top + h > vh - 12 && card.rect.top - h - 8 > 12) {
      top = card.rect.top - h - 8
      place = "above"
    }
    // Never leave the viewport (short landscape screens): clamp, the card scrolls itself if needed.
    top = Math.min(Math.max(12, top), Math.max(12, vh - Math.min(h, vh - 24) - 12))
    setPos({ left, top, place })
  }, [card])
  const { s } = card
  return (
    <div
      ref={ref}
      className={`cite-card ${pos.place}`}
      style={{ left: pos.left, top: pos.top }}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <SourceCardBody s={s} />
      <a className="src-open" href={s.url} target="_blank" rel="noopener noreferrer nofollow">
        {t("sources.open")} <IconExternal size={13} />
      </a>
    </div>
  )
}

export function SourcesList({ sources }) {
  const t = useT()
  if (!sources.length) return null
  const cited = sources.filter((s) => s.cited).length
  // Every source is listed (cited ones first, numbered like the chips in the answer, then the other looked-up ones).
  return (
    <section className="sources" aria-label={t("sources.title")}>
      <h4 className="sources-title">
        {t("sources.titleCount", { count: sources.length })}
        {cited < sources.length && <span className="sources-sub"> · {t("sources.citedOf", { cited, looked: sources.length - cited })}</span>}
      </h4>
      <ol className="source-grid">
        {sources.map((s) => (
          <li key={s.key}>
            <a className={`source-card ${s.cited ? "" : "uncited"}`} href={s.url} target="_blank" rel="noopener noreferrer nofollow" data-cite={s.key} title={s.url}>
              <span className="src-site">
                <span className="src-num">{s.n}</span>
                <span className="src-site-name">{sourceSite(s.url)}</span>
              </span>
              <span className="src-title">
                <SourceTitle s={s} />
              </span>
              <SourceSub s={s} />
            </a>
          </li>
        ))}
      </ol>
    </section>
  )
}

// ---- user message ---------------------------------------------------------------------------------
function VersionSwitcher({ v, onSwitch, disabled }) {
  const t = useT()
  if (!v) return null
  const go = (d) => {
    const i = v.index - 1 + d
    if (i < 0 || i >= v.total) return
    onSwitch(v.targets[i])
  }
  return (
    <div className="versions" role="group" aria-label={t("chat.versionOf", { n: v.index, total: v.total })}>
      <button className="icon-btn xs" onClick={() => go(-1)} disabled={disabled || v.index <= 1} aria-label={t("chat.prevVersion")}>
        <IconLeft size={14} />
      </button>
      <span className="versions-n" aria-live="polite">
        {v.index}/{v.total}
      </span>
      <button className="icon-btn xs" onClick={() => go(1)} disabled={disabled || v.index >= v.total} aria-label={t("chat.nextVersion")}>
        <IconRight size={14} />
      </button>
    </div>
  )
}

function UserEditor({ msg, onSave, onCancel }) {
  const t = useT()
  const [text, setText] = useState(msg.text || "")
  const ref = useRef(null)
  useLayoutEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = Math.min(ta.scrollHeight, 360) + "px"
  }, [text])
  useEffect(() => {
    const ta = ref.current
    ta?.focus()
    ta?.setSelectionRange(ta.value.length, ta.value.length)
  }, [])
  const can = text.trim() && text.trim() !== (msg.text || "").trim()
  return (
    <div className="user-edit">
      {msg.attachments?.length > 0 && (
        <div className="bubble-files">
          {msg.attachments.map((a, i) => (
            <span key={i} className="file-pill" title={t("chat.attachmentKept")}>
              <IconFile size={14} />
              <span data-source="file">{a.name}</span>
              {a.ocr && <OcrBadge n={a.ocr.n} total={a.ocr.total} />}
            </span>
          ))}
        </div>
      )}
      <label className="sr-only" htmlFor={`edit-${msg.id}`}>
        {t("chat.editMessage")}
      </label>
      <textarea
        id={`edit-${msg.id}`}
        ref={ref}
        value={text}
        maxLength={20000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel()
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && can) onSave(text.trim())
        }}
      />
      <div className="user-edit-bar">
        <span className="user-edit-hint">{t("chat.editHint")}</span>
        <button className="btn ghost sm" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button className="btn primary sm" disabled={!can} onClick={() => onSave(text.trim())}>
          {t("common.save")}
        </button>
      </div>
    </div>
  )
}

export function UserMessage({ msg, versions, onEdit, onSwitch, busy, readOnly, scope, onPreviewDoc, openDocId, docsKey }) {
  const t = useT()
  const docs = (msg.attachments || []).filter((a) => a.artifact).map((a) => a.artifact)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const canEdit = !readOnly && !msg.local && onEdit
  if (editing)
    return (
      <div className="msg msg-user editing">
        <UserEditor
          msg={msg}
          onCancel={() => setEditing(false)}
          onSave={(t) => {
            setEditing(false)
            onEdit(t)
          }}
        />
      </div>
    )
  return (
    <div className="msg msg-user">
      <div className="user-bubble">
        {msg.attachments?.length > 0 && (
          <div className="bubble-files">
            {msg.attachments.map((a, i) => (
              <span key={i} className="file-pill">
                <IconFile size={14} />
                <span data-source="file">{a.name}</span>
                {a.ocr && <OcrBadge n={a.ocr.n} total={a.ocr.total} />}
              </span>
            ))}
          </div>
        )}
        {msg.text && (
          <div className="user-text" data-source="user">
            {msg.text}
          </div>
        )}
      </div>
      {docs.length > 0 && scope && (
        <ArtifactCards artifacts={docs} scope={scope} onPreview={onPreviewDoc} openId={openDocId} refreshKey={docsKey} note={t(UPLOAD_DOC_NOTE)} className="user-docs" />
      )}
      {readOnly && onSwitch && versions?.kind === "edit" && (
        <div className="user-actions">
          <VersionSwitcher v={versions} onSwitch={onSwitch} disabled={busy} />
        </div>
      )}
      {!readOnly && (
        <div className="user-actions">
          {versions?.kind === "edit" && <VersionSwitcher v={versions} onSwitch={onSwitch} disabled={busy} />}
          {msg.text && (
            <button
              className="icon-btn sm"
              aria-label={copied ? t("common.copied") : t("chat.copyMessage")}
              title={t("common.copy")}
              onClick={async () => {
                if (await copyText(msg.text)) {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1400)
                }
              }}
            >
              {copied ? <IconCheck size={15} className="pop-in" /> : <IconCopy size={15} />}
            </button>
          )}
          {canEdit && (
            <button className="icon-btn sm" aria-label={t("chat.editMessage")} title={t("common.edit")} disabled={busy} onClick={() => setEditing(true)}>
              <IconPencil size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---- steps (live status line, tool-only list with durations, reasoning behind one toggle) ---------
// Ticks while `on` so live timers re-render (tool elapsed time, "đang phân tích" time).
function useNow(on, ms = 500) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [on, ms])
  return now
}

const isRunning = (t) => t.status === "running" || t.status === "pending"

function StepItem({ item, now }) {
  const running = isRunning(item)
  const failed = item.status === "error"
  const took = item.start ? (item.end ?? (running ? now : undefined)) - item.start : undefined
  const step = stepOf(item)
  const hasArgs = step.args.length > 0
  const res = !running && step.res ? step.res : null
  // the tool read a scanned PDF whose text was recognised by OCR (metadata.ui.ocr)
  const ocr = !running && step.ocr?.pages ? step.ocr : null
  const label = hasArgs ? stepPlain(step) : ""
  return (
    <li className={`step step-tool ${item.status} ${running ? "active" : ""}`}>
      <span className="step-icon" aria-hidden="true">
        {running ? <Spinner size={13} /> : failed ? <IconX size={14} /> : <IconCheck size={14} className="pop-in" />}
      </span>
      <div className="step-body">
        {/* Grid: name | arg (1fr, ellipsis) | result (right-aligned, capped) | time (fixed, right) – on phones
            name + time on the first line, arg · result wrapped below. Full text in the title attributes. */}
        <div className="step-line">
          <span className={`step-name ${running ? "shimmer" : ""}`}>{running ? toolActive(item.tool) : toolTitle(item.tool)}</span>
          {(hasArgs || res || ocr) && (
            <span className="step-detail">
              {hasArgs && (
                <span className="step-arg" title={label}>
                  <StepArgs args={step.args} />
                </span>
              )}
              {(res || ocr) && (
                <span className="step-result">
                  <StepRes res={res} />
                  {ocr && <OcrBadge pages={ocr.pages} kind="source" className="step-ocr" />}
                </span>
              )}
            </span>
          )}
          {took != null && !Number.isNaN(took) && <span className="step-time">{fmtDuration(took)}</span>}
        </div>
        {failed && <StepError item={item} />}
        {!running && item.card && <ResultCard card={item.card} />}
      </div>
      <span className="sr-only">{running ? t("tools.state.running") : failed ? t("tools.state.error") : t("tools.state.done")}</span>
    </li>
  )
}

// Model reasoning is kept out of the step list (it made the list read "Suy nghĩ, Suy nghĩ…"); it is
// available behind one toggle instead.
function Reasoning({ items, defaultOpen }) {
  const t = useT()
  const [open, setOpen] = useState(!!defaultOpen)
  if (!items.length) return null
  return (
    <div className="reasoning-box">
      <button className="step-reason-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <IconChevron size={14} className={`chev ${open ? "up" : ""}`} />
        <span>{open ? t("tools.hideReasoning", { n: items.length }) : t("tools.showReasoning", { n: items.length })}</span>
      </button>
      <div className={`collapse ${open ? "open" : ""}`}>
        <div className="collapse-inner">
          {items.map((r) => (
            <p key={r.id} className="step-reason open">
              {r.text.trim()}
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}

function Steps({ items, live, showReasoning }) {
  const t = useT()
  const tools = items.filter((i) => i.type === "tool")
  const reasoning = items.filter((i) => i.type === "reasoning")
  const running = live || tools.some(isRunning)
  const now = useNow(running)
  const [userOpen, setUserOpen] = useState(null)
  const expanded = userOpen ?? running
  const current = [...tools].reverse().find(isRunning)
  const lastDone = [...tools].reverse().find((t) => !isRunning(t))
  const errors = tools.filter((t) => t.status === "error").length
  // What the agent is doing right now, in words – never just "đang suy nghĩ".
  const since = current?.start ?? lastDone?.end
  const curStep = current ? stepOf(current) : null
  const status = current ? (
    <>
      {toolActive(current.tool)}
      {curStep.args.length > 0 && (
        <>
          <span className="step-sep"> · </span>
          <StepArgs args={curStep.args} />
        </>
      )}
    </>
  ) : lastDone
      ? t("tools.analyzing", { name: toolTitle(lastDone.tool) })
      : t("tools.planning")
  if (!tools.length && !running) return reasoning.length && showReasoning !== null ? <Reasoning items={reasoning} defaultOpen={showReasoning} /> : null
  return (
    <div className={`steps ${running ? "running" : "done"}`}>
      <button className="steps-head" onClick={() => setUserOpen(!expanded)} aria-expanded={expanded}>
        <span className="steps-icon" aria-hidden="true">
          {running ? <Spinner size={14} /> : <IconCheck size={15} className="pop-in" />}
        </span>
        {running ? (
          <span className="steps-current shimmer" aria-live="polite">
            {status}
            {since && <span className="steps-elapsed"> · {fmtDuration(now - since)}</span>}
          </span>
        ) : (
          <>
            <span className="steps-title">{t("tools.done")}</span>
            <span className="steps-count">
              · {t("tools.steps", { count: tools.length })}
              {errors ? `, ${t("tools.errors", { count: errors })}` : ""}
            </span>
          </>
        )}
        <IconChevron size={16} className={`chev ${expanded ? "up" : ""}`} />
      </button>
      <div className={`collapse ${expanded ? "open" : ""}`}>
        <div className="collapse-inner">
          {tools.length > 0 && (
            <ol className="step-list">
              {tools.map((it) => (
                <StepItem key={it.id} item={it} now={now} />
              ))}
            </ol>
          )}
          {showReasoning !== null && <Reasoning items={reasoning} defaultOpen={showReasoning} />}
        </div>
      </div>
    </div>
  )
}

// ---- report card ------------------------------------------------------------------------------------
function ReportCard({ info, streaming, open, onOpen }) {
  const t = useT()
  const meta = [info.headings ? t("report.sections", { count: info.headings }) : "", info.tables ? t("report.tables", { count: info.tables }) : "", t("report.readTime", { count: info.minutes })]
  return (
    <button className={`report-card ${open ? "is-open" : ""} ${streaming ? "is-live" : ""}`} onClick={onOpen} aria-pressed={open}>
      <span className="report-icon" aria-hidden="true">
        {streaming ? <Spinner size={16} /> : <IconReport size={20} />}
      </span>
      <span className="report-text">
        <span className="report-title" data-source="answer">
          {info.title}
        </span>
        <span className="report-meta">
          {streaming ? t("report.writing") : meta.filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="report-cta">{open ? t("report.opened") : t("report.open")}</span>
    </button>
  )
}

// ---- assistant turn ---------------------------------------------------------------------------------
/** Generated documents of a turn (document_create tool parts). */
export const turnArtifacts = (messages) => (messages || []).flatMap((m) => (m.parts || []).filter((p) => p.type === "tool" && p.artifact).map((p) => p.artifact))

/**
 * One assistant turn. After an automatic repair run (server grounding found unsupported items, see
 * server/grounding.mjs) the first answer is kept collapsed above the updated one ("Đã tra lại và cập nhật").
 */
export function AssistantTurn(props) {
  const t = useT()
  const { messages } = props
  const split = messages.findIndex((m) => m.repair)
  if (split <= 0) return <AssistantTurnBody {...props} />
  return (
    <div className="repair-wrap">
      <details className="repair-prev">
        <summary>{t("repair.previous")}</summary>
        <AssistantTurnBody
          messages={messages.slice(0, split)}
          active={false}
          readOnly
          nested
          isLast={false}
          showReasoning={props.showReasoning}
          scope={props.scope}
          docVersions={props.docVersions}
          onPreviewDoc={props.onPreviewDoc}
          openDocId={props.openDocId}
          docsKey={props.docsKey}
        />
      </details>
      <div className="repair-note" role="note">
        <IconRefresh size={14} /> {t("repair.updated")}
      </div>
      <AssistantTurnBody {...props} messages={messages.slice(split)} sourceMessages={messages} />
    </div>
  )
}

function AssistantTurnBody({
  messages, active, retry, versions, isLast, onRegenerate, onSwitch, onOpenReport, onReportDetected, reportOpen, readOnly, showReasoning, busy,
  grounding, onEscalate, escalated, scope, docVersions, onPreviewDoc, openDocId, docsKey, question, repairing, finalizing, nested, onRepairNow, sourceMessages,
}) {
  const toast = useToast()
  const t = useT()
  const [copied, setCopied] = useState(false)
  const rootRef = useRef(null)
  const model = useMemo(() => buildAnswer(messages, sourceMessages || messages), [messages, sourceMessages])
  const { segs, answer, sources, byKey } = model
  const artifacts = useMemo(() => turnArtifacts(messages).map((a) => (a.legacy ? { ...a, version: docVersions?.get(a.id) || 1 } : a)), [messages, docVersions])
  // A generated document already carries the long content → the answer text is just its summary.
  const report = useMemo(() => (answer.length > 1200 && !artifacts.length ? analyzeArtifact(answer) : { isArtifact: false }), [answer, artifacts.length])
  const mainText = useMemo(() => segs.filter((s) => s.kind === "text").reduce((best, s) => (s.text.length > (best?.text.length || 0) ? s : best), null)?.text || answer, [segs, answer])
  const summary = useMemo(() => (report.isArtifact ? citeify(renderMarkdown(artifactSummary(mainText)), new Map(model.registry)) : ""), [report.isArtifact, mainText, model.registry])
  const preview = useCitationPreview(rootRef, byKey)
  const [checksOpen, setChecksOpen] = useState(false)
  useEffect(() => {
    if (report.isArtifact && active) onReportDetected?.()
  }, [report.isArtifact, active]) // eslint-disable-line react-hooks/exhaustive-deps
  const last = messages[messages.length - 1]
  const errMsg = [...messages].reverse().find((m) => m.error && !m.aborted)
  const error = errMsg ? (errMsg.errorCode ? t(`errors.stream.${errMsg.errorCode}`, { detail: errMsg.errorDetail ? `: ${errMsg.errorDetail}` : "" }) : errMsg.error) : null
  const aborted = messages.some((m) => m.aborted)
  const lastSeg = segs[segs.length - 1]
  const copy = async () => {
    if (await copyText(answer)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } else toast.error(t("common.copyFailed"))
  }
  // In report mode all lookup steps are merged into one block above the report card.
  const view = useMemo(() => {
    if (!report.isArtifact) return segs
    const steps = segs.filter((s) => s.kind === "steps")
    const merged = steps.length ? [{ kind: "steps", id: steps[0].id, items: steps.flatMap((s) => s.items) }] : []
    return [...merged, ...segs.filter((s) => s.kind === "question" || s.kind === "draft"), { kind: "report", id: "report" }]
  }, [segs, report.isArtifact])
  const low = grounding?.level === LEVEL_LOW
  // "Tra lại ngay": one repair on demand (admin allows repairs; latest answer, not repaired yet – the server checks again)
  const [repairReq, setRepairReq] = useState(false)
  const canRepairNow = low && !!onRepairNow && isLast && !readOnly && !nested && !active && !busy && !messages.some((m) => m.repair)
  const repairNow = async () => {
    setRepairReq(true)
    try {
      await onRepairNow()
    } catch (e) {
      toast.error(e.message)
      setRepairReq(false)
    }
  }
  // The run ended without any visible answer even after the hidden "write it now" prompt (or long ago).
  const lastDone = messages[messages.length - 1]
  const noAnswer =
    !active && !nested && !answer && !artifacts.length && !error && !aborted && !segs.some((s) => s.kind === "question" || s.kind === "draft") && messages.length > 0 &&
    (messages.some((m) => m.finalize) || !isLast || (lastDone?.completed && Date.now() - lastDone.completed > 20_000))
  const done = !active && !!answer
  // Grounding marks in the answer text: unmatched items underlined in red, matched quotes ticked (see checkmarks.js).
  useEffect(() => {
    const root = rootRef.current
    if (!done || nested || !grounding?.checks?.length) return
    const id = requestAnimationFrame(() => markChecks(root, grounding.checks, (c) => checkTip(t, c)))
    return () => { cancelAnimationFrame(id); clearChecks(root) }
  }, [done, nested, grounding, answer, t])
  // Badge only when the turn was checked (grounding_check) or the answer makes legal claims / cites sources –
  // identity and small-talk turns get none (not even "Chưa kiểm chứng tự động").
  const showConf = !nested && done && (!!grounding || ((grounding !== undefined || readOnly) && (sources.length > 0 || LEGAL_CLAIM_RE.test(answer))))
  const orphans = useMemo(() => (active ? [] : orphanVisuals(messages, answer)), [messages, answer, active])
  return (
    <VisualScope.Provider value={scope || null}>
    <div className="msg msg-assistant" aria-busy={active || undefined} ref={rootRef}>
      {segs.length === 0 && active && (
        <div className="thinking" role="status">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="shimmer">{t("chat.thinking")}</span>
        </div>
      )}
      {view.map((s, i) => {
        if (s.kind === "steps")
          return <Steps key={s.id} items={s.items} live={active && (i === view.length - 1 || (report.isArtifact && !answer))} showReasoning={readOnly && showReasoning == null ? null : showReasoning} />
        if (s.kind === "question")
          return (
            <QuestionCard
              key={s.id}
              part={s.part}
              interactive={!readOnly && !!question?.onReply}
              readOnlyNote={question?.note}
              onReply={(answers) => question?.onReply?.(s.part, answers)}
              onReject={() => question?.onReject?.(s.part)}
              onDraft={(answers) => question?.onDraft?.(s.part, answers)}
            />
          )
        if (s.kind === "draft") return <DraftCard key={s.id} draft={s.draft} parts={s.parts} active={active} rootRef={rootRef} />
        if (s.kind === "report")
          return (
            <div key="report" className="report-wrap">
              {summary && <Html html={summary} className="report-summary" />}
              <ReportCard info={report} streaming={active} open={reportOpen} onOpen={onOpenReport} />
            </div>
          )
        return <Html key={s.id} html={s.html} streaming={active && s === lastSeg} />
      })}
      <OrphanVisuals visuals={orphans} />
      {artifacts.length > 0 && <ArtifactCards artifacts={artifacts} scope={scope} onPreview={onPreviewDoc} openId={openDocId} refreshKey={docsKey} />}
      {active && finalizing && !answer && (
        <div className="notice-inline repair-status" role="status">
          <Spinner size={12} /> <span className="shimmer">{t("chat.finalizing")}</span>
        </div>
      )}
      {noAnswer && (
        <div className="msg-error no-answer" role="alert">
          <IconAlert size={16} /> <span>{t("chat.noAnswer")}</span>
          {isLast && onRegenerate && !busy && (
            <button className="link-btn" onClick={onRegenerate}>
              {t("common.retry")}
            </button>
          )}
          {!readOnly && onEscalate && !escalated && (
            <button className="btn ghost xs" onClick={() => onEscalate({ low: false })}>
              {t("expert.escalate")}
            </button>
          )}
        </div>
      )}
      {active && repairing && (
        <div className="notice-inline repair-status" role="status">
          <Spinner size={12} /> <span className="shimmer">{t("repair.running")}</span>
        </div>
      )}
      {active && retry && (
        <div className="notice-inline" role="status">
          <Spinner size={12} /> {retry.attempt ? t("chat.retryingN", { n: retry.attempt }) : t("chat.retrying")} {retry.message}
        </div>
      )}
      {error && (
        <div className="msg-error" role="alert">
          <IconAlert size={16} /> <span>{error}</span>
          {isLast && onRegenerate && !busy && (
            <button className="link-btn" onClick={onRegenerate}>
              {t("common.retry")}
            </button>
          )}
        </div>
      )}
      {aborted && !active && <div className="msg-stopped">{t("chat.stopped")}</div>}
      {!active && sources.length > 0 && <SourcesList sources={sources} />}
      {showConf && (
        <div className={`answer-foot ${low ? "is-low" : ""}`}>
          <ConfidenceBadge verdict={grounding || null} open={checksOpen} onToggle={grounding?.checks?.length ? () => setChecksOpen((o) => !o) : undefined} />
          {checksOpen && grounding?.checks?.length > 0 && <CheckList checks={grounding.checks} onPick={(i) => revealCheck(rootRef.current, i)} />}
          {low && (
            <div className="conf-warn" role="alert">
              <IconAlert size={15} />
              <div>
                <span>{t("confidence.lowWarn")}</span>
                {canRepairNow && (
                  <>
                    {" "}
                    <button className="link-btn conf-repair" onClick={repairNow} disabled={repairReq} title={t("repair.nowTip")}>
                      {repairReq ? <Spinner size={11} /> : <IconRefresh size={12} />} {t("repair.now")}
                    </button>
                  </>
                )}
                {grounding.items?.length > 0 && (
                  <ul className="conf-items">
                    {grounding.items.slice(0, 8).map((x, i) => (
                      <li key={i}>
                        <Data v={x} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {low && !readOnly && onEscalate && !escalated && (
            <button className="btn primary xs" onClick={() => onEscalate({ low: true })}>
              <IconShield size={13} /> {t("expert.askReview")}
            </button>
          )}
        </div>
      )}
      {!nested && !active && (answer || (isLast && onRegenerate)) && (
        <div className="msg-actions">
          {answer && (
            <button className="icon-btn sm" onClick={copy} aria-label={copied ? t("common.copied") : t("chat.copyAnswer")} title={copied ? t("common.copied") : t("common.copy")}>
              {copied ? <IconCheck size={15} className="pop-in" /> : <IconCopy size={15} />}
            </button>
          )}
          {!readOnly && isLast && onRegenerate && (
            <button className="icon-btn sm" onClick={onRegenerate} aria-label={t("chat.regenerateLabel")} title={t("chat.regenerate")} disabled={busy}>
              <IconRefresh size={15} />
            </button>
          )}
          {!readOnly && onEscalate && answer && (
            <button
              className="icon-btn sm"
              data-act="escalate"
              onClick={() => onEscalate({ low })}
              aria-label={escalated ? t("expert.escalated") : t("expert.escalate")}
              title={escalated ? t("expert.escalated") : t("expert.escalate")}
              disabled={busy || escalated}
            >
              <IconShield size={15} />
            </button>
          )}
          {(!readOnly || onSwitch) && versions && versions.kind !== "edit" && <VersionSwitcher v={versions} onSwitch={onSwitch} disabled={busy} />}
          {last?.completed && (
            <span className="msg-time">{fmtTime(last.completed)}</span>
          )}
        </div>
      )}
      {preview}
    </div>
    </VisualScope.Provider>
  )
}

export function MessagesSkeleton() {
  const t = useT()
  return (
    <div className="messages-skeleton" aria-label={t("chat.loadingChat")}>
      <div className="skeleton bubble" />
      <div className="skeleton line" style={{ width: "92%" }} />
      <div className="skeleton line" style={{ width: "86%" }} />
      <div className="skeleton line" style={{ width: "64%" }} />
      <div className="skeleton bubble" style={{ width: "40%", marginTop: 28 }} />
      <div className="skeleton line" style={{ width: "88%" }} />
      <div className="skeleton line" style={{ width: "72%" }} />
    </div>
  )
}

export { Html, normUrl }
