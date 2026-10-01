// Visuals inside answer text (placeholders produced by renderMarkdown in ../lib.js):
//   [data-vis="diagram"] → <iframe sandbox=""> of /api/visuals/…/frame (inline SVG, strict CSP from the server), sized by
//                          the diagram's aspect ratio, "Mở toàn màn hình", "Tải PNG / SVG"
//   [data-vis="image"]   → <img loading="lazy"> from our own image endpoint + caption + credit, click → lightbox
//   [data-vis="mermaid"] → rendered in the browser by the locally bundled mermaid (lazy chunk, securityLevel "strict",
//                          no HTML labels, no network) and shown as an <img> of the SVG; parse error → the code stays
// RichHtml replaces the plain answer <div dangerouslySetInnerHTML> and mounts these as portals into the placeholders.
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../api.js"
import { useT } from "../i18n.jsx"
import { useThemePref } from "../theme.js"
import { IconClose, IconDownload, IconExpand, IconExternal } from "./Icons.jsx"

/** { chatId } | { token } of the conversation the answer belongs to. */
export const VisualScope = createContext(null)

// ---- theme ------------------------------------------------------------------------------------------------
const darkQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null
export function useResolvedTheme() {
  const [pref] = useThemePref()
  const [sys, setSys] = useState(() => (darkQuery?.matches ? "dark" : "light"))
  useEffect(() => {
    if (!darkQuery) return
    const on = () => setSys(darkQuery.matches ? "dark" : "light")
    darkQuery.addEventListener("change", on)
    return () => darkQuery.removeEventListener("change", on)
  }, [])
  return pref === "system" ? sys : pref
}

// ---- metadata (cached per scope + id) -------------------------------------------------------------------------
const metaCache = new Map()
function useVisualMeta(scope, id) {
  const key = `${scope?.token || scope?.chatId || ""}|${id}`
  const [state, setState] = useState(() => metaCache.get(key) || null)
  useEffect(() => {
    if (!scope || !id) return
    let live = true
    const hit = metaCache.get(key)
    if (hit?.visual) return setState(hit)
    const p = hit?.promise || api.visualMeta(scope, id).then((r) => ({ visual: r.visual }), () => ({ error: true }))
    metaCache.set(key, { promise: p })
    p.then((v) => {
      metaCache.set(key, v)
      if (live) setState(v)
    })
    return () => {
      live = false
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

// ---- lightbox -------------------------------------------------------------------------------------------------
export function Lightbox({ onClose, label, children, wide }) {
  const t = useT()
  const closeRef = useRef(null)
  const cb = useRef(onClose)
  cb.current = onClose
  useEffect(() => {
    const prev = document.activeElement
    closeRef.current?.focus()
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        cb.current()
      } else if (e.key === "Tab") {
        // keep focus inside the dialog (only the close button and links are focusable)
        const f = [...(closeRef.current?.closest(".vis-lightbox")?.querySelectorAll("button, a[href]") || [])]
        if (f.length && !f.includes(document.activeElement)) {
          e.preventDefault()
          f[0].focus()
        }
      }
    }
    document.addEventListener("keydown", onKey, true)
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey, true)
      document.body.style.overflow = overflow
      prev?.focus?.()
    }
  }, [])
  return createPortal(
    <div className="vis-lightbox" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <button ref={closeRef} className="vis-lightbox-close" onClick={onClose} aria-label={t("visuals.close")} title={t("visuals.close")}>
        <IconClose size={20} />
      </button>
      <div className={`vis-lightbox-body ${wide ? "wide" : ""}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
        {children}
      </div>
    </div>,
    document.body,
  )
}

// ---- pieces ---------------------------------------------------------------------------------------------------
function Credit({ v }) {
  const t = useT()
  if (!v?.credit) return null
  return (
    <span className="vis-credit">
      <span data-source="visual">{v.credit}</span>
      {v.sourceUrl && (
        <>
          {" · "}
          <a href={v.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="vis-source">
            {t("visuals.openSource")} <IconExternal size={11} />
          </a>
        </>
      )}
      {v.licenseUrl && (
        <>
          {" · "}
          <a href={v.licenseUrl} target="_blank" rel="noopener noreferrer nofollow">
            {t("visuals.license")}
          </a>
        </>
      )}
    </span>
  )
}

function VisualImage({ id, alt }) {
  const t = useT()
  const scope = useContext(VisualScope)
  const m = useVisualMeta(scope, id)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!scope) return null
  if (m?.error || failed) return <span className="vis-missing">{t("visuals.unavailable")}</span>
  const v = m?.visual
  const src = api.visualUrls(scope, id).image()
  const caption = v?.caption || alt || v?.title || ""
  return (
    <figure className="vis-figure vis-image" data-kind={v?.kind || "image"}>
      <button type="button" className="vis-zoom" onClick={() => setOpen(true)} aria-label={t("visuals.zoom")} title={t("visuals.zoom")}>
        <img src={src} alt={caption} loading="lazy" decoding="async" width={v?.width || undefined} height={v?.height || undefined} onError={() => setFailed(true)} />
      </button>
      {(caption || v?.credit) && (
        <figcaption>
          {caption && <span className="vis-caption" data-source="visual">{caption}</span>}
          <Credit v={v} />
        </figcaption>
      )}
      {open && (
        <Lightbox onClose={() => setOpen(false)} label={caption || t("visuals.image")}>
          <img className="vis-lightbox-img" src={src} alt={caption} />
          {(caption || v?.credit) && (
            <div className="vis-lightbox-cap">
              {caption && <span className="vis-caption" data-source="visual">{caption}</span>}
              <Credit v={v} />
            </div>
          )}
        </Lightbox>
      )}
    </figure>
  )
}

function DiagramFrame({ id }) {
  const t = useT()
  const scope = useContext(VisualScope)
  const theme = useResolvedTheme()
  const m = useVisualMeta(scope, id)
  const [full, setFull] = useState(false)
  if (!scope) return null
  if (m?.error) return <span className="vis-missing">{t("visuals.unavailable")}</span>
  const v = m?.visual
  const urls = api.visualUrls(scope, id)
  const ratio = v?.width && v?.height ? `${v.width} / ${v.height}` : "16 / 10"
  const title = v?.title || t("visuals.diagram")
  return (
    <figure className="vis-figure vis-diagram">
      {/* narrow screens: the diagram keeps a readable width and scrolls sideways inside its own box */}
      <div className="vis-frame-scroll" tabIndex={0} aria-label={title}>
        <div className="vis-frame-wrap" style={{ aspectRatio: ratio, maxWidth: v?.width ? `${Math.max(v.width, 480)}px` : undefined, "--vis-min": v?.width ? `${Math.min(v.width, 680)}px` : "560px" }}>
          {v ? <iframe key={theme} src={urls.frame(theme)} sandbox="" title={title} loading="lazy" referrerPolicy="no-referrer" /> : <div className="vis-skeleton" aria-hidden="true" />}
        </div>
      </div>
      <figcaption>
        <span className="vis-caption" data-source="visual">{v?.caption || title}</span>
        <span className="vis-actions">
          <button type="button" className="btn ghost xs" onClick={() => setFull(true)} disabled={!v}>
            <IconExpand size={14} /> {t("visuals.fullscreen")}
          </button>
          <a className="btn ghost xs" href={urls.download("png", theme)} download>
            <IconDownload size={14} /> {t("visuals.downloadPng")}
          </a>
          <a className="btn ghost xs" href={urls.download("svg")} download>
            <IconDownload size={14} /> {t("visuals.downloadSvg")}
          </a>
        </span>
      </figcaption>
      {full && v && (
        <Lightbox onClose={() => setFull(false)} label={title} wide>
          <div className="vis-full-frame" style={{ aspectRatio: ratio }}>
            <iframe src={urls.frame(theme)} sandbox="" title={title} referrerPolicy="no-referrer" />
          </div>
          <div className="vis-lightbox-cap">
            <span className="vis-caption" data-source="visual">{v.caption || title}</span>
          </div>
        </Lightbox>
      )}
    </figure>
  )
}

// ---- mermaid (lazy, local bundle) -----------------------------------------------------------------------------
let mermaidPromise = null
let mermaidTheme = null
let seq = 0
// mermaid.render is not re-entrant (shared parser / DOM state): one render at a time
let queue = Promise.resolve()
const renderMermaid = (code, theme) => {
  const run = queue.then(() => renderMermaidNow(code, theme))
  queue = run.catch(() => {})
  return run
}
async function renderMermaidNow(code, theme) {
  mermaidPromise ??= import("mermaid").then((m) => m.default)
  const mermaid = await mermaidPromise
  if (mermaidTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "neutral",
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      fontFamily: "'Be Vietnam Pro', 'Segoe UI', Arial, sans-serif",
      deterministicIds: true,
      suppressErrorRendering: true,
      maxTextSize: 20000,
    })
    mermaidTheme = theme
  }
  await mermaid.parse(code)
  const { svg } = await mermaid.render(`mmd-${++seq}`, code)
  // standalone image: explicit size from the viewBox, no scripts / foreign objects / external refs survive
  const vb = svg.match(/viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"/)
  const w = vb ? Math.ceil(+vb[1]) : 800
  const h = vb ? Math.ceil(+vb[2]) : 400
  const clean = svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/<svg\b([^>]*?)\swidth="[^"]*"/, "<svg$1")
    .replace(/<svg\b([^>]*?)\sstyle="[^"]*"/, "<svg$1")
    .replace(/^<svg\b/, `<svg width="${w}" height="${h}"`)
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`, w, h }
}

function MermaidBlock({ el, code, streaming }) {
  const t = useT()
  const theme = useResolvedTheme()
  const [out, setOut] = useState(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (streaming) return
    let live = true
    renderMermaid(code, theme).then(
      (r) => {
        if (!live) return
        setOut(r)
        el.setAttribute("data-ready", "1")
      },
      () => {
        if (!live) return
        setOut({ error: true })
        el.setAttribute("data-failed", "1")
      },
    )
    return () => {
      live = false
    }
  }, [code, theme, streaming, el])
  if (!out) return null
  if (out.error) return <div className="vis-mermaid-error">{t("visuals.mermaidError")}</div>
  return (
    <figure className="vis-figure vis-chart">
      <button type="button" className="vis-zoom" onClick={() => setOpen(true)} aria-label={t("visuals.zoom")} title={t("visuals.zoom")}>
        <img src={out.url} alt={t("visuals.chart")} width={out.w} height={out.h} />
      </button>
      {open && (
        <Lightbox onClose={() => setOpen(false)} label={t("visuals.chart")} wide>
          <img className="vis-lightbox-img vis-lightbox-svg" src={out.url} alt={t("visuals.chart")} />
        </Lightbox>
      )}
    </figure>
  )
}

// ---- rich answer HTML -----------------------------------------------------------------------------------------
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return ""
  }
}
/** Answer HTML with visual placeholders hydrated in place (portals). */
export const RichHtml = memo(function RichHtml({ html, streaming, className = "", source = "answer", as: Tag = "div" }) {
  const ref = useRef(null)
  const [slots, setSlots] = useState([])
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const found = [...root.querySelectorAll("[data-vis]")].map((el, i) => ({ el, i, kind: el.getAttribute("data-vis"), id: el.getAttribute("data-id") || "", alt: el.getAttribute("data-alt") || "", code: safeDecode(el.getAttribute("data-code") || "") }))
    setSlots((prev) => (prev.length === 0 && found.length === 0 ? prev : found))
  }, [html])
  return (
    <>
      <Tag ref={ref} className={`md ${streaming ? "streaming" : ""} ${className}`} data-source={source} dangerouslySetInnerHTML={{ __html: html }} />
      {slots.map((s) =>
        createPortal(
          s.kind === "diagram" ? <DiagramFrame id={s.id} /> : s.kind === "image" ? <VisualImage id={s.id} alt={s.alt} /> : s.kind === "mermaid" ? <MermaidBlock el={s.el} code={s.code} streaming={streaming} /> : null,
          s.el,
          `${s.kind}-${s.id || s.i}-${s.i}`,
        ),
      )}
    </>
  )
})

/** Visual tool parts of a turn whose marker the model did not put into the text → shown after the answer. */
export function orphanVisuals(messages, answer) {
  const out = []
  for (const m of messages || [])
    for (const p of m.parts || []) {
      const v = p.type === "tool" && p.status === "completed" ? p.visual : null
      if (v?.id && !String(answer || "").includes(v.id) && !out.some((x) => x.id === v.id)) out.push(v)
    }
  return out
}

export function OrphanVisuals({ visuals }) {
  if (!visuals?.length) return null
  return (
    <div className="vis-orphans" data-source="answer">
      {visuals.map((v) => (v.kind === "diagram" ? <DiagramFrame key={v.id} id={v.id} /> : <VisualImage key={v.id} id={v.id} alt="" />))}
    </div>
  )
}
