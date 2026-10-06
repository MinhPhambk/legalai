import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api.js"
import { formatBytes, prefersReducedMotion, relTime, renderMarkdown } from "../lib.js"
import { fmtDateTime, hasKey, t, useT } from "../i18n.jsx"
import { ESC_STATUSES, ESC_STATUS_KEY, KIND_KEY, LANG_BADGE, LEVEL_HIGH, LEVEL_KEY, LEVEL_LOW, URGENCIES, URGENCY_HIGH, URGENCY_KEY, URGENCY_MEDIUM } from "../codes.js"
import { Dialog, useToast } from "./ui.jsx"
import { Data } from "./DataText.jsx"
import { OcrBadge } from "./OcrBadge.jsx"
import { IconAlert, IconCheck, IconClose, IconCompare, IconDownload, IconExpand, IconEye, IconFile, IconGavel, IconLeft, IconReport, IconRight, IconShield, IconUser, Spinner } from "./Icons.jsx"

// ---- confidence badge ----------------------------------------------------------------------------
const WHY = ["partial_quotes", "no_sources", "calc_only", "bad_quotes", "unsupported", "unmatched", "source_warnings", "unverifiable_links", "few_items", "all_matched", "from_memory", "ocr_evidence"]
/** Reasons of a grounding verdict in the UI language (codes in `why`; older verdicts: none → no tooltip text). */
export function confidenceReasons(v) {
  const why = (v?.why || []).filter((w) => WHY.includes(w.code))
  return why
    .map((w) => (w.code === "all_matched" && w.computed ? t("confidence.why.all_matched_calc", { n: w.n ?? 0, total: w.total ?? 0, computed: w.computed }) : t(`confidence.why.${w.code}`, { n: w.n ?? 0, total: w.total ?? 0, count: w.n ?? 0 })))
    .join("; ")
}
/**
 * Always-visible explanation under the badge: why the system gave this level (from the check's reason codes) and what
 * the level means for the user. Older verdicts without codes fall back to the check's own reason text.
 */
export function ConfidenceWhy({ verdict }) {
  const tr = useT()
  if (!verdict?.level) return null
  const lv = verdict.level === LEVEL_HIGH ? "high" : verdict.level === LEVEL_LOW ? "low" : "medium"
  let reasons = confidenceReasons(verdict) || (verdict.reasons || []).join("; ")
  // With per-item results, name the items instead of the generic "some links / figures … did not match".
  const bad = (verdict.checks || []).filter((c) => !c.ok)
  if (bad.length) {
    const short = (s) => (s.length > 60 ? s.slice(0, 60) + "…" : s)
    const items = bad.slice(0, 3).map((c) => `${tr(`confidence.check.kind.${c.k}`).toLocaleLowerCase()} “${short(c.t)}”`).join(", ")
    const named = tr("confidence.whyItems", { items }) + (bad.length > 3 ? tr("confidence.whyMore", { n: bad.length - 3 }) : "")
    const generic = (verdict.why || []).filter((w) => !["unmatched", "unsupported", "bad_quotes"].includes(w.code))
    reasons = [named, confidenceReasons({ why: generic })].filter(Boolean).join("; ")
  }
  return (
    <div className={`conf-why lv-${lv}`}>
      <b>{tr("confidence.whyTitle", { level: tr(`confidence.level.${lv}`) })}</b> {reasons ? `${reasons.charAt(0).toUpperCase()}${reasons.slice(1)}.` : ""}{" "}
      <span className="conf-why-hint">{tr(`confidence.meaning.${lv}`)}</span>
    </div>
  )
}

/** Tooltip / list text for one checked item: why it matched or not, and the source it matched. */
export function checkTip(t, c) {
  const why = hasKey(`confidence.check.why.${c.why}`) ? t(`confidence.check.why.${c.why}`) : t(c.ok ? "confidence.check.why.source" : "confidence.check.why.missing")
  return c.ok && c.src?.title ? `${why} – ${c.src.title}` : why
}

/** Expanded list of the grounding check: every checked item, ✓ matched (with its source) / ✗ not found. */
export function CheckList({ checks, onPick }) {
  const t = useT()
  const bad = checks.filter((c) => !c.ok).length
  const order = checks.map((c, i) => ({ c, i })).sort((a, b) => Number(a.c.ok) - Number(b.c.ok))
  return (
    <div className="gc-list" role="region" aria-label={t("confidence.check.title")}>
      <div className="gc-list-head">
        {t("confidence.check.title")} · <b className="ok">{checks.length - bad} {t("confidence.check.matched")}</b>
        {bad > 0 && <> · <b className="bad">{bad} {t("confidence.check.unmatched")}</b></>}
      </div>
      <ul>
        {order.map(({ c, i }) => (
          <li key={i} className={c.ok ? "ok" : "bad"}>
            <span className="gc-icon" aria-hidden="true">{c.ok ? "✓" : "✗"}</span>
            <span className="gc-kind">{t(`confidence.check.kind.${c.k}`)}</span>
            <button type="button" className="gc-text" onClick={() => onPick?.(i)} title={t("confidence.check.goto")}>
              {c.t.length > 110 ? c.t.slice(0, 110) + "…" : c.t}
            </button>
            <span className="gc-where">
              {c.ok && c.src?.url ? (
                <a href={c.src.url} target="_blank" rel="noopener noreferrer">{c.src.title || new URL(c.src.url).hostname}</a>
              ) : (
                checkTip(t, c)
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="gc-list-foot">{t("confidence.check.legend")}</div>
    </div>
  )
}

export function ConfidenceBadge({ verdict, open = false, onToggle }) {
  const t = useT()
  if (!verdict) {
    return (
      <span className="conf-badge none" title={t("confidence.noneTip")}>
        <span className="conf-dot" aria-hidden="true" />
        {t("confidence.none")}
      </span>
    )
  }
  const lv = verdict.level
  const tip = confidenceReasons(verdict)
  return (
    <span className={`conf-badge lv-${lv === LEVEL_HIGH ? "high" : lv === LEVEL_LOW ? "low" : "mid"}`} title={tip ? t("confidence.reasons", { tip }) : undefined} tabIndex={0}>
      <span className="conf-meter" aria-hidden="true">
        <i className="on" />
        <i className={lv !== LEVEL_LOW ? "on" : ""} />
        <i className={lv === LEVEL_HIGH ? "on" : ""} />
      </span>
      {t("confidence.label", { level: LEVEL_KEY[lv] ? t(`confidence.level.${LEVEL_KEY[lv]}`) : lv })}
      {verdict.claims - (verdict.unverifiable || 0) > 0 && (
        // denominator = items that CAN be checked automatically; links outside those sources are counted apart
        <span className="conf-sub">
          · {t("confidence.claims", { supported: verdict.supported, claims: verdict.claims - (verdict.unverifiable || 0) })}
        </span>
      )}
      {verdict.unverifiable > 0 && <span className="conf-sub"> · {t("confidence.unverifiable", { count: verdict.unverifiable })}</span>}
      {verdict.origin === "server" && <span className="conf-sub"> · {t("confidence.byServer")}</span>}
      {onToggle && (
        <button type="button" className="conf-more" aria-expanded={open} onClick={onToggle}>
          {t(open ? "confidence.check.hide" : "confidence.check.show")} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </button>
      )}
      {tip && <span className="conf-tip" role="tooltip">{tip}</span>}
    </span>
  )
}

// ---- generated documents ---------------------------------------------------------------------------
const kindLabel = (kind) => t(`docs.kind.${KIND_KEY[kind] || "generic"}`)
const KindIcon = ({ kind, size = 22 }) => (kind === "hop-dong" ? <IconGavel size={size} /> : kind === "bao-cao" ? <IconReport size={size} /> : <IconFile size={size} />)
/** Locale key of the note under documents imported from an upload. */
export const UPLOAD_DOC_NOTE = "docs.uploadNote"

/** VI / EN / VI–EN from the artifact's `language` (missing = vi). */
export function LangBadge({ language }) {
  const l = LANG_BADGE[language] ? language : "vi"
  return (
    <span className={`doc-lang lang-${l}`} title={t(`docs.language.${l}`)} aria-label={t(`docs.language.${l}`)}>
      {LANG_BADGE[l]}
    </span>
  )
}

/** Version chain of a document (all versions sharing its root), refetched when `refreshKey` changes. */
function useVersionChain(scope, a, refreshKey) {
  const [chain, setChain] = useState(null)
  const scopeKey = scope?.token || scope?.chatId || ""
  useEffect(() => {
    if (!scopeKey || a.legacy) return
    let dead = false
    api
      .artifactVersions(scope, a.id)
      .then((r) => !dead && setChain(Array.isArray(r?.versions) && r.versions.length ? r.versions : null))
      .catch(() => {})
    return () => {
      dead = true
    }
  }, [scopeKey, a.id, a.legacy, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return chain
}

/** ‹ v1 v2 v3 › */
function VersionNav({ list, sel, onSelect }) {
  const t = useT()
  const i = list.indexOf(sel)
  const chipsRef = useRef(null)
  useEffect(() => {
    chipsRef.current?.querySelector(".on")?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [sel.id])
  return (
    <div className="doc-vnav" role="group" aria-label={t("docs.versionNav", { n: sel.version, count: list.length })}>
      <button className="icon-btn xs" onClick={() => onSelect(list[i - 1])} disabled={i <= 0} aria-label={t("chat.prevVersion")}>
        <IconLeft size={14} />
      </button>
      <div className="doc-vchips" ref={chipsRef}>
        {list.map((v) => (
          <button key={v.id} className={`doc-vchip ${v.id === sel.id ? "on" : ""}`} aria-pressed={v.id === sel.id} onClick={() => onSelect(v)} title={v.createdAt ? fmtDateTime(v.createdAt) : undefined}>
            v{v.version}
          </button>
        ))}
      </div>
      <button className="icon-btn xs" onClick={() => onSelect(list[i + 1])} disabled={i >= list.length - 1} aria-label={t("chat.nextVersion")}>
        <IconRight size={14} />
      </button>
    </div>
  )
}

/** Document language for data marks (bilingual → none: both languages appear). */
export const docLang = (a) => (a?.language === "en" ? "en" : a?.language === "bilingual" ? undefined : "vi")
/** Older records: summary lines (strings) → shown as data items. */
const legacyChanges = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string").map((x) => ({ op: "edit", text: { v: x }, legacy: true })) : [])
const UNITS = ["article", "chapter", "section", "part", "clause"]
/** Structured change (server/events.mjs summarizeChanges) → "Edited Article 10, clauses 2, 3 (2 places)". */
export function ChangeItem({ c, lang }) {
  const t = useT()
  if (c.legacy) return <Data v={c.text.v} lang={lang} />
  const op = t(`docs.change.op.${["edit", "add", "delete", "rewrite"].includes(c.op) ? c.op : "edit"}`)
  const where = []
  if (c.pos) where.push(t(`docs.change.pos.${c.pos === "before" ? "before" : "after"}`))
  if (c.end) where.push(t("docs.change.end"))
  else if (c.preamble) where.push(t("docs.change.preamble"))
  else if (c.unit && UNITS.includes(c.unit)) where.push(t(`docs.change.unit.${c.unit}`, { n: c.n || "" }))
  if (c.clauses?.length) where.push(t("docs.change.clauses", { count: c.clauses.length, list: c.clauses.join(", ") }))
  if (c.point) where.push(t("docs.change.point", { p: c.point }))
  return (
    <>
      {op} {where.join(" ")}
      {c.text?.v ? (
        <>
          {where.length ? " " : ""}
          <Data v={c.text.v} lang={c.text.lang || lang} q />
        </>
      ) : null}
      {c.count > 1 ? ` ${t("docs.change.times", { count: c.count })}` : ""}
    </>
  )
}

function ChangesList({ items, lang }) {
  const t = useT()
  const [all, setAll] = useState(false)
  if (!items?.length) return null
  const shown = all ? items : items.slice(0, 3)
  return (
    <div className="doc-changes">
      <span className="doc-changes-title">{t("docs.changesTitle")}</span>
      <ul>
        {shown.map((c, i) => (
          <li key={i}>
            <ChangeItem c={c} lang={lang} />
          </li>
        ))}
      </ul>
      {items.length > 3 && (
        <button className="link-btn doc-changes-more" onClick={() => setAll((x) => !x)}>
          {all ? t("common.showLess") : t("docs.moreChanges", { count: items.length - 3 })}
        </button>
      )}
    </div>
  )
}

/** Previous version of `sel` within the chain (its parent, else the one before it). */
const previousOf = (list, sel) => (sel.parentId && list.find((v) => v.id === sel.parentId)) || list[list.indexOf(sel) - 1] || null

function DocCard({ a, scope, onPreview, openId, index, refreshKey, note }) {
  const t = useT()
  const chain = useVersionChain(scope, a, refreshKey)
  const list = chain?.some((v) => v.id === a.id) ? chain : [a]
  const [selId, setSelId] = useState(a.id)
  const sel = list.find((v) => v.id === selId) || list.find((v) => v.id === a.id) || a
  const prev = previousOf(list, sel)
  const urls = api.artifactUrls(scope, sel.id)
  const files = (sel.files || []).filter((f) => f.format === "docx" || f.format === "pdf")
  const redline = (sel.files || []).find((f) => f.format === "redline")
  const versioned = list.length > 1 || sel.version > 1
  const rich = versioned || sel.changesSummary?.length > 0 || !!note
  const isOpen = openId === sel.id
  return (
    <div className={`doc-card ${rich ? "rich" : ""} ${isOpen ? "is-open" : ""}`} data-doc-id={a.id} style={{ animationDelay: `${index * 70}ms` }}>
      <span className="doc-icon" aria-hidden="true">
        <KindIcon kind={sel.kind} />
      </span>
      <div className="doc-text">
        <span className="doc-kind">
          {kindLabel(sel.kind)}
          <LangBadge language={sel.language} />
          {versioned && <span className="doc-version">{t("docs.version", { n: sel.version })}</span>}
          {sel.origin === "upload" && <span className="doc-origin">{t("docs.uploaded")}</span>}
          {sel.ocr && <OcrBadge n={sel.ocr.n} total={sel.ocr.total} />}
        </span>
        <span className="doc-title">
          <Data v={sel.title} lang={docLang(sel)} />
        </span>
        <span className="doc-files">{files.map((f) => `${f.format.toUpperCase()} · ${formatBytes(f.bytes)}`).join("  ·  ") || t("docs.noFiles")}</span>
      </div>
      {list.length > 1 && <VersionNav list={list} sel={sel} onSelect={(v) => v && setSelId(v.id)} />}
      {note && <p className="doc-note">{note}</p>}
      {sel.version > 1 && <ChangesList key={sel.id} items={sel.changes || legacyChanges(sel.changesSummary)} lang={docLang(sel)} />}
      <div className="doc-actions">
        {sel.hasPreview && (
          <button className="btn primary sm" onClick={() => onPreview?.(sel, { view: "preview" })} aria-pressed={isOpen}>
            <IconEye size={14} /> {t("docs.preview")}
          </button>
        )}
        {prev && sel.hasMarkdown && prev.hasMarkdown !== false && (
          <button className="btn ghost sm doc-diff-btn" onClick={() => onPreview?.(sel, { view: "diff", against: prev.id, againstVersion: prev.version })}>
            <IconCompare size={14} /> {t("docs.compare")}
          </button>
        )}
        {files.map((f) => (
          <a key={f.format} className="btn ghost sm" href={urls.download(f.format)} download aria-label={t("docs.download", { ext: f.format })} title={t("docs.download", { ext: f.format })}>
            <IconDownload size={14} /> .{f.format}
          </a>
        ))}
        {redline && (
          <a className="btn ghost sm doc-redline" href={urls.download("redline")} download title={t("docs.redlineTip")}>
            <IconDownload size={14} /> {t("docs.redline")}
          </a>
        )}
        {sel.origin === "upload" && sel.hasOriginal && (
          <a className="btn ghost sm" href={urls.download("original")} download title={t("docs.originalTip")}>
            <IconDownload size={14} /> {t("docs.original")}
          </a>
        )}
      </div>
    </div>
  )
}

export function ArtifactCards({ artifacts, scope, onPreview, openId, refreshKey, note, className = "" }) {
  if (!artifacts?.length) return null
  return (
    <div className={`doc-cards ${className}`}>
      {artifacts.map((a, i) => (
        <DocCard key={a.id} a={a} index={i} scope={scope} onPreview={onPreview} openId={openId} refreshKey={refreshKey} note={note} />
      ))}
    </div>
  )
}

// ---- diff view ----------------------------------------------------------------------------------------
/** Markdown syntax that only adds noise to a text diff. */
const cleanMd = (s) => s.replace(/\*\*|__/g, "").replace(/(^|\n)#{1,6} /g, "$1")
const CONTEXT = 2

/** Diff ops → render items; with `only`, long unchanged runs collapse to a few lines of context. */
export function diffItems(ops, only) {
  const out = []
  const n = ops.length
  ops.forEach((o, idx) => {
    const text = cleanMd(o.text)
    // Line breaks inside a change are drawn without the colour mark (no bars on empty lines).
    if (o.op !== "eq") return text.split(/(\n+)/).forEach((t) => t && out.push({ op: o.op, text: t, ws: /^\s*$/.test(t) }))
    if (!only) return out.push({ op: o.op, text })
    const lines = text.split("\n")
    const first = idx === 0
    const last = idx === n - 1
    const keep = CONTEXT + 1
    if (first && last) return
    if (first) {
      if (lines.length > keep + 1) out.push({ gap: lines.length - keep }, { op: "eq", text: lines.slice(-keep).join("\n") })
      else out.push({ op: "eq", text })
    } else if (last) {
      if (lines.length > keep + 1) out.push({ op: "eq", text: lines.slice(0, keep).join("\n") }, { gap: lines.length - keep })
      else out.push({ op: "eq", text })
    } else if (lines.length > 2 * keep + 1) {
      out.push({ op: "eq", text: lines.slice(0, keep).join("\n") }, { gap: lines.length - 2 * keep }, { op: "eq", text: lines.slice(-keep).join("\n") })
    } else out.push({ op: "eq", text })
  })
  return out
}

function DiffView({ scope, a, only, onStats }) {
  const t = useT()
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    let dead = false
    setState({ loading: true })
    api
      .artifactDiff(scope, a.id, a.against)
      .then((r) => {
        if (dead) return
        setState({ data: r })
        onStats?.(r)
      })
      .catch((e) => !dead && setState({ error: e.message }))
    return () => {
      dead = true
    }
  }, [a.id, a.against, scope?.token, scope?.chatId]) // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => (state.data ? diffItems(state.data.ops || [], only) : []), [state.data, only])
  if (state.loading)
    return (
      <div className="doc-loading">
        <Spinner size={18} /> {t("docs.diff.loading")}
      </div>
    )
  if (state.error)
    return (
      <div className="doc-loading" role="alert">
        <IconAlert size={16} /> {state.error}
      </div>
    )
  const changed = state.data.stats?.changes > 0
  return (
    <article className="diff-page" aria-label={t("docs.diff.label", { from: state.data.from.version, to: state.data.to.version })}>
      <div className="diff-legend" aria-hidden="true">
        <span>
          <ins>{t("docs.diff.inserted")}</ins>
        </span>
        <span>
          <del>{t("docs.diff.deleted")}</del>
        </span>
      </div>
      {!changed ? (
        <p className="diff-same">{t("docs.diff.same")}</p>
      ) : (
        <div className="diff-text">
          {items.map((it, i) =>
            it.gap ? (
              <div key={i} className="diff-gap">
                ⋯ {t("docs.diff.unchangedLines", { count: it.gap })}
              </div>
            ) : it.op === "ins" ? (
              <ins key={i} className={/^\s*$/.test(it.text) ? "ws" : undefined}>
                {it.text}
              </ins>
            ) : it.op === "del" ? (
              <del key={i} className={/^\s*$/.test(it.text) ? "ws" : undefined}>
                {it.text}
              </del>
            ) : (
              <span key={i}>{it.text}</span>
            ),
          )}
        </div>
      )}
    </article>
  )
}

/** Side panel (sheet on mobile): the rendered document on an A4 page (zoomed to fit), or a diff view. */
export function DocumentPanel({ artifact, scope, onClose }) {
  const t = useT()
  const [render, setRender] = useState(!!artifact)
  const [leaving, setLeaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [scale, setScale] = useState(1)
  const [canvasH, setCanvasH] = useState(0)
  const [view, setView] = useState(artifact?.view || "preview")
  const [only, setOnly] = useState(false)
  const [stats, setStats] = useState(null)
  const kept = useRef(artifact)
  if (artifact) kept.current = artifact
  const a = artifact || kept.current
  const canvasRef = useRef(null)
  const openKey = artifact ? `${artifact.id}|${artifact.view || ""}|${artifact.against || ""}` : ""
  useEffect(() => {
    if (artifact) {
      setRender(true)
      setLeaving(false)
      setLoaded(false)
      setView(artifact.view === "diff" ? "diff" : "preview")
      setStats(null)
    } else if (render) {
      setLeaving(true)
      const t = setTimeout(() => setRender(false), prefersReducedMotion() ? 0 : 260)
      return () => clearTimeout(t)
    }
  }, [openKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Zoom the 794 px (A4 @96 dpi) page to the canvas width.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    // Re-fit only when the width changes (rotation, panel resize). On phones the address bar showing/hiding
    // while scrolling changes the height continuously, which made the page resize in a loop (seen as the
    // preview zooming in and out).
    let raf = 0
    let lastW = -1
    const measure = () => {
      raf = 0
      const w = el.clientWidth
      if (Math.abs(w - lastW) < 2) return
      lastW = w
      const next = Math.round(Math.min(1, (w - 32) / 794) * 1000) / 1000
      setScale((s) => (Math.abs(s - next) >= 0.01 ? next : s))
      setCanvasH(Math.floor(el.clientHeight))
    }
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(measure)
    })
    ro.observe(el)
    return () => (ro.disconnect(), raf && cancelAnimationFrame(raf))
  }, [render])
  useEffect(() => {
    if (!artifact) return
    const onKey = (e) => e.key === "Escape" && !document.querySelector(".dialog") && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [artifact, onClose])
  if (!render || !a) return null
  const urls = api.artifactUrls(scope, a.id)
  const canDiff = !!a.against && a.hasMarkdown !== false
  const files = (a.files || []).filter((f) => f.format === "docx" || f.format === "pdf")
  const redline = (a.files || []).find((f) => f.format === "redline")
  const diffing = view === "diff" && canDiff
  const sub = diffing
    ? t("docs.diff.title", { from: stats?.from?.version ?? a.againstVersion ?? "?", to: stats?.to?.version ?? a.version }) +
      (stats?.stats
        ? ` · ${t("docs.diff.insertedWords", { count: stats.stats.insertedWords })} · ${t("docs.diff.deletedWords", { count: stats.stats.deletedWords })} · ${t("docs.diff.changes", { count: stats.stats.changes })}`
        : "")
    : `${kindLabel(a.kind)} · ${LANG_BADGE[a.language] || LANG_BADGE.vi}${a.version > 1 ? ` · ${t("docs.version", { n: a.version })}` : ""}${files.length ? ` · ${files.map((f) => f.format.toUpperCase()).join(", ")}` : ""}`
  return (
    <aside className={`report-panel doc-panel ${diffing ? "is-diff" : ""} ${leaving ? "leaving" : ""}`} aria-label={`${diffing ? t("docs.compareShort") : t("docs.preview")}: ${a.title}`}>
      <header className="report-head">
        <span className="report-head-icon" aria-hidden="true">
          <KindIcon kind={a.kind} size={17} />
        </span>
        <div className="report-head-text">
          <h2>
            <Data v={a.title} lang={docLang(a)} />
          </h2>
          <span>{sub}</span>
        </div>
        <div className="report-tools">
          {!diffing && (
            <a className="icon-btn sm" href={urls.preview} target="_blank" rel="noopener noreferrer" aria-label={t("docs.fullscreen")} title={t("docs.fullscreen")}>
              <IconExpand size={16} />
            </a>
          )}
          <button className="icon-btn sm" onClick={onClose} aria-label={t("docs.closePreview")} title={t("common.closeEsc")}>
            <IconClose size={17} />
          </button>
        </div>
      </header>
      <div className="doc-subbar">
        {canDiff && (
          <div className="segmented" role="tablist" aria-label={t("docs.viewMode")}>
            <button role="tab" aria-selected={!diffing} className={!diffing ? "on" : ""} onClick={() => setView("preview")}>
              {t("docs.preview")}
            </button>
            <button role="tab" aria-selected={diffing} className={diffing ? "on" : ""} onClick={() => setView("diff")}>
              {t("docs.compareShort")}
            </button>
          </div>
        )}
        {diffing && (
          <label className="doc-only">
            <button type="button" role="switch" aria-checked={only} className={`switch ${only ? "on" : ""}`} onClick={() => setOnly((x) => !x)}>
              <span className="switch-thumb" />
            </button>
            <span onClick={() => setOnly((x) => !x)}>{t("docs.diff.onlyChanges")}</span>
          </label>
        )}
        <div className="doc-subbar-dl">
          {files.map((f) => (
            <a key={f.format} className="btn ghost xs" href={urls.download(f.format)} download title={t("docs.download", { ext: f.format })}>
              <IconDownload size={13} /> .{f.format}
            </a>
          ))}
          {redline && (
            <a className="btn ghost xs" href={urls.download("redline")} download title={t("docs.redlineTip")}>
              <IconDownload size={13} /> {t("docs.redlineShort")}
            </a>
          )}
        </div>
      </div>
      <div className="doc-canvas" ref={canvasRef}>
        {diffing ? (
          <DiffView scope={scope} a={a} only={only} onStats={setStats} />
        ) : (
          <>
            {!loaded && (
              <div className="doc-loading">
                <Spinner size={18} /> {t("docs.loadingPreview")}
              </div>
            )}
            {/* The page fills the canvas; the (sandboxed, unmeasurable) document scrolls inside it. */}
            <div className="doc-page-wrap" style={{ width: Math.floor(794 * scale), height: Math.floor(Math.max(1123 * scale, canvasH - 66)) }}>
              <iframe
                key={a.id}
                className={`doc-page ${loaded ? "ready" : ""}`}
                title={t("docs.previewOf", { title: a.title })}
                src={urls.preview}
                sandbox=""
                referrerPolicy="no-referrer"
                style={{ transform: `scale(${scale})`, height: Math.floor(Math.max(1123, (canvasH - 66) / (scale || 1))) }}
                onLoad={() => setLoaded(true)}
              />
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

// ---- escalations ------------------------------------------------------------------------------------
const STATUS_STEPS = ESC_STATUSES
export const statusLabel = (s) => (ESC_STATUS_KEY[s] ? t(`expert.status.${ESC_STATUS_KEY[s]}`) : s)
export const urgencyLabel = (u) => (URGENCY_KEY[u] ? t(`expert.urgency.${URGENCY_KEY[u]}`) : u)
const URG_CLASS = { low: "low", medium: "mid", high: "high", urgent: "urgent" }
export const UrgencyBadge = ({ u }) => {
  useT()
  const k = URGENCY_KEY[u]
  return <span className={`urg-badge u-${URG_CLASS[k] || "mid"}`}>{k ? t(`expert.urgencyBadge.${k}`) : u}</span>
}

export function EscalationCard({ e }) {
  const t = useT()
  const idx = STATUS_STEPS.indexOf(e.status)
  return (
    <div className="esc-card" role="status" aria-live="polite">
      <div className="esc-head">
        <span className="esc-icon" aria-hidden="true">
          <IconShield size={18} />
        </span>
        <div className="esc-title">
          <strong>{t("expert.escalated")}</strong>
          <span>
            {e.id} · {e.origin === "manual" ? t("expert.origin.youManual") : t("expert.origin.agent")} · {relTime(e.createdAt)}
          </span>
        </div>
        <UrgencyBadge u={e.urgency} />
      </div>
      <ol className="esc-steps" aria-label={t("expert.progress")}>
        {STATUS_STEPS.map((s, i) => (
          <li key={s} className={i < idx ? "done" : i === idx ? "current" : ""}>
            <span className="esc-step-dot" aria-hidden="true">
              {i < idx ? <IconCheck size={10} /> : null}
            </span>
            {statusLabel(s)}
          </li>
        ))}
      </ol>
      <div className="esc-meta">
        {e.reason && (
          <span>
            {t("expert.reasonLabel")}: {e.reasonCode === "user_request" ? t("expert.reasonCode.user_request") : <Data v={e.reason} />}
          </span>
        )}
        {e.deadline && (
          <span>
            {t("expert.deadlineLabel")}: <Data v={e.deadline} />
          </span>
        )}
        {e.assignee && (
          <span>
            {t("expert.assigneeLabel")}: <Data v={e.assignee} lang={null} />
          </span>
        )}
      </div>
    </div>
  )
}

export function ExpertReply({ r, escalationId }) {
  const t = useT()
  const html = renderMarkdown(r.text)
  return (
    <div className="msg msg-expert">
      <div className="expert-head">
        <span className="avatar expert" aria-hidden="true">
          {(r.author || "C").slice(0, 1).toUpperCase()}
        </span>
        <strong>
          {t("expert.replyAuthorLabel")} · <Data v={r.author} lang={null} />
        </strong>
        <span className="expert-sub">
          {t("expert.replyTo", { id: escalationId })} · {fmtDateTime(r.at, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}
        </span>
      </div>
      <div className="md expert-md" data-source="expert" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

export function EscalateDialog({ target, onClose, onDone }) {
  const toast = useToast()
  const t = useT()
  const [urgency, setUrgency] = useState(URGENCY_MEDIUM)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (target) {
      setUrgency(target.low ? URGENCY_HIGH : URGENCY_MEDIUM)
      setNote("")
    }
  }, [target])
  const submit = async () => {
    setBusy(true)
    try {
      const r = await api.escalate(target.chatId, { turn: target.turn, urgency, note })
      toast.success(t("expert.sent", { id: r.escalation.id }))
      onDone?.(r.escalation)
      onClose()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={t("expert.dialogTitle")}
      labelledBy="esc-dlg-title"
      className="esc-dialog"
      actions={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner size={14} /> : <IconShield size={15} />} {t("expert.submit")}
          </button>
        </>
      }
    >
      {target?.low && (
        <p className="esc-warn">
          <IconAlert size={15} /> {t("expert.lowWarn")}
        </p>
      )}
      <p>{t("expert.dialogBody")}</p>
      <div className="field">
        <label htmlFor="esc-urg">{t("expert.urgencyLabel")}</label>
        <div className="segmented" role="radiogroup" id="esc-urg" aria-label={t("expert.urgencyLabel")}>
          {URGENCIES.map((u) => (
            <button key={u} type="button" role="radio" aria-checked={urgency === u} className={urgency === u ? "on" : ""} onClick={() => setUrgency(u)}>
              <span>{urgencyLabel(u)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="esc-note">{t("expert.noteLabel")}</label>
        <textarea id="esc-note" className="input textarea" rows={4} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("expert.notePlaceholder")} />
      </div>
    </Dialog>
  )
}

// ---- follow-up suggestions ---------------------------------------------------------------------------
/** Chips under the latest answer: skeletons while generating, then clickable questions (sent as a new message). */
export function Followups({ data, onPick, disabled }) {
  const t = useT()
  if (!data) return null
  if (data.pending)
    return (
      <div className="followups is-pending" aria-busy="true" aria-label={t("followups.loading")}>
        {Array.from({ length: Math.min(data.count || 3, 5) }, (_, i) => (
          <span key={i} className="followup-skel skeleton" style={{ width: `${[62, 48, 55, 40, 58][i]}%`, animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
    )
  if (!data.items?.length) return null
  return (
    <div className="followups" role="group" aria-label={t("followups.label")}>
      <span className="followups-title">{t("followups.title")}</span>
      {data.items.map((q, i) => (
        <button key={q} type="button" className="followup" style={{ animationDelay: `${i * 70}ms` }} disabled={disabled} onClick={() => onPick(q)} aria-label={t("followups.ask", { q })}>
          <IconRight size={13} aria-hidden="true" />
          <span data-source="followup">{q}</span>
        </button>
      ))}
    </div>
  )
}
