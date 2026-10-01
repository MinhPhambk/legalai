import { useEffect, useState } from "react"
import { marked } from "marked"
import DOMPurify from "dompurify"
import { fmtDate, formatBytes, fmtDuration, getLocale, hasKey, relTime, t, t as translate } from "./i18n.jsx"
import { REPORTISH, STATUS_CODE_KEY, statusCodeOf } from "./codes.js"

export { formatBytes, fmtDuration, relTime }

// ---- routing (see route.js) ----------------------------------------------------------------
export { navigate, useRoute, useTitle } from "./route.js"


// ---- motion / theme (see theme.js) ------------------------------------------------------------
export { getThemePref, prefersReducedMotion, setThemePref, useThemePref } from "./theme.js"

// ---- text helpers ---------------------------------------------------------------------------
/** Strip model control tokens (e.g. "<｜…｜ calls>") incl. a partial one at the end of a stream. */
export const cleanModelText = (s) =>
  String(s || "")
    .replace(/<｜[^<>\n]{0,80}>/g, "")
    .replace(/<｜[^<>\n]{0,80}$/, "")
    .replace(/<$/, "")

export function groupChats(chats) {
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86400000
  const groups = [
    { key: "today", label: t("sidebar.groups.today"), from: startToday, items: [] },
    { key: "yesterday", label: t("sidebar.groups.yesterday"), from: startToday - day, items: [] },
    { key: "week", label: t("sidebar.groups.week"), from: startToday - 7 * day, items: [] },
    { key: "month", label: t("sidebar.groups.month"), from: startToday - 30 * day, items: [] },
    { key: "older", label: t("sidebar.groups.older"), from: -Infinity, items: [] },
  ]
  for (const c of chats) groups.find((g) => c.updatedAt >= g.from).items.push(c)
  return groups.filter((g) => g.items.length)
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    ta.remove()
    return ok
  }
}

// ---- markdown -----------------------------------------------------------------------------
marked.setOptions({ gfm: true, breaks: false })
// Visuals in answers (components/Visuals.jsx hydrates the placeholders):
//   ```mermaid … ```            → [data-vis="mermaid"] with the code as fallback (rendered client-side, strict mode)
//   ![caption](visual:<id>)     → [data-vis="image"] (our own image endpoint only); any other image → a plain link
//   line [[diagram:<id>]]       → [data-vis="diagram"] (sandboxed frame)
const VISUAL_ID = /^v\d{14}-[0-9a-f]{6}$/
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
marked.use({
  renderer: {
    code(token) {
      if (String(token.lang || "").trim().toLowerCase() !== "mermaid") return false
      const code = String(token.text || "")
      return `<div data-vis="mermaid" data-code="${encodeURIComponent(code)}"><pre><code>${escHtml(code)}</code></pre></div>\n`
    },
    image(token) {
      const href = String(token.href || "")
      const m = href.match(/^visual:(.+)$/)
      if (m && VISUAL_ID.test(m[1])) return `<span data-vis="image" data-id="${m[1]}" data-alt="${escHtml(token.text)}"></span>`
      // never hotlink: an external image becomes a link to it
      return /^https?:\/\//i.test(href) ? `<a href="${escHtml(href)}">${escHtml(token.text || href)}</a>` : escHtml(token.text || "")
    },
  },
})
/** Markdown source → visual placeholders the renderer understands (diagram marker lines, duplicate credit lines). */
export function prepareVisuals(src) {
  let s = String(src || "")
  if (!s.includes("[[diag") && !s.includes("visual:")) return s
  // own line – also when the model wrapped it in a heading / quote / emphasis / code span
  s = s.replace(/^[ \t>#*_`-]*\[\[diagram:(v\d{14}-[0-9a-f]{6})\]\][ \t*_`]*$/gm, (_m, id) => `\n<div data-vis="diagram" data-id="${id}"></div>\n`)
  // inside a sentence: the diagram becomes a block after that paragraph's line
  s = s.replace(/^(.*?)\[\[diagram:(v\d{14}-[0-9a-f]{6})\]\](.*)$/gm, (_m, a, id, b) => `${a}${b}\n\n<div data-vis="diagram" data-id="${id}"></div>\n`)
  // the figure shows the stored credit line itself – drop the italic credit line the tool told the model to paste
  s = s.replace(/(!\[[^\]\n]*\]\(visual:v\d{14}-[0-9a-f]{6}(?:\s+"[^"\n]*")?\))[ \t]*\n?[ \t]*([*_])(?:Ảnh|Image|Screenshot|Nguồn|Source)[^\n]{0,400}?\2[ \t]*(?=\n|$)/g, "$1") // i18n-ignore
  // a marker still being streamed
  return s.replace(/\[\[diag[^\]\n]*\]?$/, "")
}
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") || ""
    if (!/^(https?:|mailto:)/i.test(href)) {
      node.removeAttribute("href")
    } else {
      node.setAttribute("target", "_blank")
      node.setAttribute("rel", "noopener noreferrer nofollow")
    }
  }
})
const PURIFY = {
  ADD_ATTR: ["target"],
  FORBID_TAGS: ["style", "img", "form", "input", "button", "iframe", "svg", "math", "video", "audio"],
  FORBID_ATTR: ["style", "class", "id"],
}
export function renderMarkdown(src) {
  const html = marked.parse(prepareVisuals(src), { async: false })
  const clean = DOMPurify.sanitize(html, PURIFY)
  // Wide legal tables scroll horizontally instead of breaking the layout.
  return clean.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>")
}

// ---- tools ------------------------------------------------------------------------------------
// Labels live in the locale files: tools.name.<tool> (past / neutral) and tools.active.<tool> (live status line).
export const toolTitle = (tool) =>
  hasKey(`tools.name.${tool}`) ? t(`tools.name.${tool}`) : tool.startsWith("chrome_") ? t("tools.name._browser") : t("tools.name._tool")

export function toolActive(tool) {
  if (hasKey(`tools.active.${tool}`)) return t(`tools.active.${tool}`)
  const name = toolTitle(tool)
  return t("tools.active._fallback", { name: getLocale() === "vi" ? name.toLowerCase() : name })
}

/**
 * Legal status of a source in the UI language: its code (statusCode) or the legacy phrase ("Còn hiệu lực")
 * mapped to a code; unknown phrases are returned as they are (source data).
 */
export function legalStatus(s) {
  const src = s && typeof s === "object" ? s : { status: s }
  const k = STATUS_CODE_KEY[src.statusCode || statusCodeOf(src.status)]
  return k ? t(`sources.status.${k[0]}`) : src.status || ""
}
/** Access date of a source in the locale format (ISO when the server sent it, else the stored text). */
export const sourceAccessed = (s) => (s?.accessedIso ? fmtDate(s.accessedIso + "T00:00:00") : s?.accessed || "")

// ---- misc -------------------------------------------------------------------------------------
/** Case- and diacritics-insensitive form for client-side matching. */
export const fold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d") // i18n-ignore
    .replace(/Đ/g, "D") // i18n-ignore
    .toLowerCase()

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const modKey = isMac ? "⌘" : "Ctrl"

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export const slugify = (s) => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "bao-cao"

// ---- citations ------------------------------------------------------------------------------
export const normUrl = (u) => {
  try {
    const x = new URL(u)
    x.hash = ""
    return x.href.replace(/\/$/, "")
  } catch {
    return String(u || "")
  }
}
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}
const SOURCE_KIND = { "vbpl.vn": "vbpl", "trav.gov.vn": "trav", "federalregister.gov": "fedreg", "govinfo.gov": "govinfo" }
export const sourceSite = (u) => {
  const h = hostOf(u)
  const k = Object.keys(SOURCE_KIND).find((d) => h === d || h.endsWith("." + d))
  return k ? t(`sources.site.${SOURCE_KIND[k]}`) : h
}

/** url → merged metadata from the tool results of one turn (vbpl_document/article, fedreg_document, trav_page). */
export function collectSources(messages) {
  const map = new Map()
  for (const m of messages || [])
    for (const p of m.parts || []) {
      if (p.type !== "tool" || !p.source?.url) continue
      const key = normUrl(p.source.url)
      const cur = map.get(key) || { url: p.source.url, articles: [] }
      for (const [k, v] of Object.entries(p.source)) if (v && k !== "article" && !cur[k]) cur[k] = v
      if (p.source.article && !cur.articles.includes(p.source.article)) cur.articles.push(p.source.article)
      map.set(key, cur)
    }
  return map
}

/**
 * Turn external links of rendered (sanitized) answer HTML into numbered citation chips.
 * `registry` (Map normUrl → {n, url, label}) is shared by all segments of one answer so numbering is
 * stable across segments and between the chat and the report panel.
 */
export function citeify(html, registry) {
  if (!html.includes("<a")) return html
  const tpl = document.createElement("template")
  tpl.innerHTML = html
  for (const a of [...tpl.content.querySelectorAll("a[href]")]) {
    const href = a.getAttribute("href")
    if (!/^https?:/i.test(href)) continue
    const key = normUrl(href)
    let entry = registry.get(key)
    const text = a.textContent.trim()
    const urlish = !text || /^https?:\/\//i.test(text) || text.replace(/^www\./, "") === hostOf(href) || normUrl(text) === key
    if (!entry) {
      entry = { n: registry.size + 1, url: href, label: urlish ? "" : text }
      registry.set(key, entry)
    } else if (!entry.label && !urlish) entry.label = text
    const chip = document.createElement("a")
    chip.className = "cite"
    chip.href = href
    chip.target = "_blank"
    chip.rel = "noopener noreferrer nofollow"
    chip.dataset.cite = key
    chip.textContent = String(entry.n)
    chip.setAttribute("aria-label", t("sources.citeN", { n: entry.n }))
    if (urlish) a.replaceWith(chip)
    else {
      a.classList.add("cite-text")
      a.after(chip)
    }
  }
  return tpl.innerHTML
}

// ---- report / artifact detection --------------------------------------------------------------
/** Long structured answers (reports, big tables) are shown in the side panel. */
export function analyzeArtifact(text) {
  const t = String(text || "")
  const headings = (t.match(/^#{1,4}\s+\S/gm) || []).length
  const tableRows = (t.match(/^\s*\|.*\|\s*$/gm) || []).length
  const tables = (t.match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm) || []).length
  const maxCols = Math.max(0, ...(t.match(/^\s*\|.*\|\s*$/gm) || []).map((l) => l.split("|").length - 2))
  const listItems = (t.match(/^\s*([-*+]|\d+\.)\s+\S/gm) || []).length
  const first = t.match(/^#{1,3}\s+(.+)$/m)?.[1]?.replace(/[*_`]/g, "").trim() || ""
  const reportish = REPORTISH.test(first)
  const bigTable = tables > 0 && (tableRows - tables * 2 >= 5 || maxCols >= 5)
  const isArtifact = bigTable || (t.length > 3000 && headings >= 4) || (t.length > 1500 && reportish && (headings >= 2 || tables > 0 || listItems >= 8))
  return { isArtifact, title: first || translate("report.defaultTitle"), headings, tables, chars: t.length, minutes: Math.max(1, Math.round(t.length / 1100)) }
}

/** The intro of a long answer, shown in the chat above the "Mở báo cáo" card. */
export function artifactSummary(text) {
  const tokens = marked.lexer(String(text || ""))
  const out = []
  let len = 0
  let headingSeen = 0
  for (const tk of tokens) {
    if (tk.type === "heading") {
      headingSeen++
      if (headingSeen > 1 || out.length) break
      continue // the title is shown on the card
    }
    if (tk.type === "table" || tk.type === "hr" || tk.type === "code") break
    if (tk.type === "space") continue
    out.push(tk.raw)
    len += tk.raw.length
    if (len > 420) break
  }
  let s = out.join("").trim()
  if (s.length > 600) s = s.slice(0, 600).replace(/\s+\S*$/, "") + "…"
  return s
}
