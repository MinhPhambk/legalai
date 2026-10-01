import { useEffect, useMemo, useRef, useState } from "react"
import { analyzeArtifact, copyText, legalStatus, prefersReducedMotion, sourceAccessed } from "../lib.js"
import { Data } from "./DataText.jsx"
import { buildAnswer, useCitationPreview } from "./Messages.jsx"
import { useToast } from "./ui.jsx"
import { useT } from "../i18n.jsx"
import { RichHtml, VisualScope } from "./Visuals.jsx"
import { IconCheck, IconClose, IconCopy, IconDownload, IconPrinter, IconReport, Spinner } from "./Icons.jsx"

const WIDTH_KEY = "nd45-report-width"
const readWidth = () => {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY))
    return w > 300 ? w : 0
  } catch {
    return 0
  }
}

/** Resizable right-hand panel (full-screen sheet on mobile) that renders a long answer as a report. */
export default function ReportPanel({ open, messages, streaming, onClose, scope }) {
  const toast = useToast()
  const t = useT()
  const [width, setWidth] = useState(() => readWidth() || Math.round(Math.min(760, window.innerWidth * 0.46)))
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState("")
  const [render, setRender] = useState(open)
  const [leaving, setLeaving] = useState(false)
  const bodyRef = useRef(null)
  const panelRef = useRef(null)
  // Keep showing the last content while the panel animates out.
  const kept = useRef(messages)
  if (open && messages?.length) kept.current = messages
  const shownMsgs = open ? messages : kept.current
  const model = useMemo(() => buildAnswer(shownMsgs || []), [shownMsgs])
  const info = useMemo(() => analyzeArtifact(model.answer), [model.answer])
  const preview = useCitationPreview(bodyRef, model.byKey)
  const html = useMemo(() => model.segs.filter((s) => s.kind === "text").map((s) => s.html).join(""), [model])

  useEffect(() => {
    if (open) {
      setRender(true)
      setLeaving(false)
    } else if (render) {
      setLeaving(true)
      const t = setTimeout(() => setRender(false), prefersReducedMotion() ? 0 : 260)
      return () => clearTimeout(t)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the stream while the report is being written (unless the reader scrolled up).
  const stick = useRef(true)
  useEffect(() => {
    const el = bodyRef.current
    if (el && streaming && stick.current) el.scrollTop = el.scrollHeight
  }, [html, streaming])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === "Escape" && !document.querySelector(".dialog")) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const startDrag = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev) => {
      const w = Math.min(Math.max(360, startW + (startX - ev.clientX)), Math.round(window.innerWidth * 0.72))
      setWidth(w)
    }
    const up = () => {
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", up)
      document.body.classList.remove("resizing")
      try {
        localStorage.setItem(WIDTH_KEY, String(panelRef.current?.offsetWidth || width))
      } catch {}
    }
    document.body.classList.add("resizing")
    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", up)
  }
  const keyResize = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    setWidth((w) => Math.min(Math.max(360, w + (e.key === "ArrowLeft" ? 40 : -40)), Math.round(window.innerWidth * 0.72)))
  }

  const sourcesHtml = () => {
    if (!model.sources.length) return ""
    const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
    return (
      `<h2>${esc(t("sources.title"))}</h2><ol class="print-sources">` +
      model.sources.map((s) => `<li>[${s.n}] ${esc([s.title || s.label, s.number, legalStatus(s)].filter(Boolean).join(" · "))} – ${esc(s.url)}${s.accessed ? ` (${esc(t("sources.accessedOn", { date: sourceAccessed(s) }))})` : ""}</li>`).join("") +
      "</ol>"
    )
  }
  const copy = async () => {
    if (await copyText(model.answer)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  const docx = async () => {
    setBusy("docx")
    try {
      const { exportDocx } = await import("../exportReport.js")
      await exportDocx(info.title, model.answer, model.sources)
      toast.success(t("report.docxDone"))
    } catch (e) {
      console.error(e)
      toast.error(t("report.docxFailed"))
    } finally {
      setBusy("")
    }
  }
  const pdf = async () => {
    const { printReport } = await import("../exportReport.js")
    printReport(info.title, html, sourcesHtml())
  }

  if (!render) return null
  return (
    <aside
      ref={panelRef}
      className={`report-panel ${leaving ? "leaving" : ""}`}
      style={{ "--report-w": `${width}px` }}
      aria-label={t("report.panelLabel", { title: info.title })}
    >
      <div
        className="report-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("report.resize")}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={keyResize}
      />
      <header className="report-head">
        <span className="report-head-icon" aria-hidden="true">
          {streaming ? <Spinner size={15} /> : <IconReport size={17} />}
        </span>
        <div className="report-head-text">
          <h2>{info.title}</h2>
          <span>{streaming ? t("report.writing") : `${t("report.chars", { count: info.chars })} · ${t("report.sources", { count: model.sources.length })}`}</span>
        </div>
        <div className="report-tools">
          <button className="icon-btn sm" onClick={copy} disabled={!model.answer} aria-label={t("report.copy")} title={t("common.copy")}>
            {copied ? <IconCheck size={16} className="pop-in" /> : <IconCopy size={16} />}
          </button>
          <button className="btn ghost sm" onClick={docx} disabled={streaming || !!busy} title={t("report.docxTip")}>
            {busy === "docx" ? <Spinner size={13} /> : <IconDownload size={15} />} .docx
          </button>
          <button className="btn ghost sm" onClick={pdf} disabled={streaming} title={t("report.pdfTip")}>
            <IconPrinter size={15} /> PDF
          </button>
          <button className="icon-btn sm" onClick={onClose} aria-label={t("report.close")} title={t("common.closeEsc")}>
            <IconClose size={17} />
          </button>
        </div>
      </header>
      <div
        className="report-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <VisualScope.Provider value={scope || null}>
          <RichHtml as="article" html={html} streaming={streaming} className="report-md" />
        </VisualScope.Provider>
        {!streaming && model.sources.length > 0 && (
          <section className="report-sources">
            <h3>{t("sources.title")}</h3>
            <ol>
              {model.sources.map((s) => (
                <li key={s.key}>
                  <span className="src-num">{s.n}</span>
                  <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">
                    <Data v={s.title || s.label || s.url} lang={s.title ? s.titleLang || s.lang : undefined} />
                  </a>
                  {[s.number, s.status, s.accessed].filter(Boolean).length > 0 && (
                    <span className="report-src-meta">
                      {s.number ? (
                        <>
                          {" · "}
                          <Data v={s.number} code />
                        </>
                      ) : null}
                      {[legalStatus(s), s.accessed && t("sources.accessedOn", { date: sourceAccessed(s) })].filter(Boolean).map((x) => ` · ${x}`)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
      {preview}
    </aside>
  )
}
