// Server-side text extraction for uploads (pure JS: mammoth for .docx → markdown keeping headings / bold / lists / tables, pdfjs-dist for .pdf).
// A PDF without a text layer (scan) is OCR'd by ../.opencode/lib/pdf-ocr.ts (Chrome built-in OCR in a dedicated
// Chrome, ~2.5 s/page, first ND45_OCR_MAX_PAGES=15 pages; one PDF at a time). ND45_OCR=0 / OCR unavailable → the old
// "no text layer" error.
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import mammoth from "mammoth"
import { ROOT } from "./config.mjs"

const require = createRequire(import.meta.url)
let pdfjsPromise
async function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href
      return lib
    })
  }
  return pdfjsPromise
}

const MAX_PDF_PAGES = 500

async function pdfText(buf, cap) {
  const lib = await pdfjs()
  const task = lib.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  })
  const doc = await task.promise
  const pages = []
  let total = 0
  try {
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES) && total <= cap; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let s = ""
      for (const it of content.items) {
        if (typeof it.str !== "string") continue
        s += it.str
        if (it.hasEOL) s += "\n"
      }
      pages.push(s)
      total += s.length
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return { text: pages.join("\n\n"), pages: doc.numPages }
}

// ---- OCR of scanned PDFs (../.opencode/lib/pdf-ocr.ts, Node 24 type stripping) ------------------------------
const PDF_OCR = process.env.WEB_PDF_OCR || path.join(ROOT, ".opencode", "lib", "pdf-ocr.ts")
export const NO_TEXT_LAYER = "PDF không có lớp chữ (có thể là bản scan). Hãy tải lên bản có thể chọn chữ."
let ocrModule
/** The pdf-ocr module, or null (missing / broken → uploads of scans get the old error). */
async function ocrLib() {
  if (ocrModule !== undefined) return ocrModule
  try {
    if (!fsSync.existsSync(PDF_OCR)) throw new Error("module not found: " + PDF_OCR)
    ocrModule = await import(pathToFileURL(PDF_OCR).href)
  } catch (e) {
    console.warn("[extract] OCR disabled:", String(e.message).split("\n")[0].slice(0, 200))
    ocrModule = null
  }
  return ocrModule
}
export const ocrMaxPages = () => Math.max(1, Math.min(60, Math.floor(+(process.env.ND45_OCR_MAX_PAGES ?? 15) || 15)))
// One OCR at a time in this server (pdf-ocr also serialises + locks across processes); later uploads see "waiting".
let ocrQueue = Promise.resolve()
function queued(fn, onStart) {
  const run = ocrQueue.then(() => (onStart?.(), fn()))
  ocrQueue = run.catch(() => {})
  return run
}
const isUnavailable = (e) => e?.name === "OcrUnavailable" || /\bOCR unavailable\b|ND45_OCR=0|OCR Chrome không chạy/.test(String(e?.message ?? e))

/** OCR a scanned upload → { text (starts with OCR_LABEL), chars, truncated, ocr: { engine, pages, totalPages, warnings, ms } }. */
async function ocrScan(buf, cap, numPages, onPhase) {
  if (process.env.ND45_OCR === "0") throw new Error(NO_TEXT_LAYER)
  const lib = await ocrLib()
  if (typeof lib?.ocrUploadText !== "function") throw new Error(NO_TEXT_LAYER)
  const maxPages = ocrMaxPages()
  const info = { pages: Math.min(numPages || maxPages, maxPages), totalPages: numPages || 0 }
  onPhase?.("ocr-wait", info)
  try {
    return await queued(() => lib.ocrUploadText(buf, cap, { maxPages }), () => onPhase?.("ocr", info))
  } catch (e) {
    console.warn("[extract] OCR failed:", String(e?.message ?? e).slice(0, 200))
    if (isUnavailable(e)) throw new Error(NO_TEXT_LAYER)
    throw new Error(`PDF không có lớp chữ (bản scan) và không OCR được: ${String(e?.message ?? e).slice(0, 200)}`)
  }
}

// ---- .docx → markdown (mammoth HTML → light markdown) -----------------------------------------------
// Keeps headings, bold/italic, lists and tables of the source; the words themselves are unchanged (no
// escaping), so the text the agent sees in the prompt matches the stored, editable document.
const MAMMOTH_OPTIONS = {
  styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
  convertImage: mammoth.images.imgElement(async () => ({ src: "" })), // no base64 images
  ignoreEmptyParagraphs: true,
}
const VOID = new Set(["br", "img", "hr", "col", "wbr"])
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
const decodeEnt = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)

/** Minimal parser for mammoth's well-formed HTML → { tag, children } tree. */
function parseHtml(html) {
  const root = { tag: "root", children: [] }
  const stack = [root]
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g)) {
    const top = stack[stack.length - 1]
    if (m[4] != null) { top.children.push({ text: decodeEnt(m[4]) }); continue }
    const tag = m[2].toLowerCase()
    if (m[1]) {
      const i = stack.map((n) => n.tag).lastIndexOf(tag)
      if (i > 0) stack.length = i
      continue
    }
    const node = { tag, children: [] }
    top.children.push(node)
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(node)
  }
  return root
}

const INLINE_MARK = { strong: "**", b: "**", em: "*", i: "*" }
const BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "div", "blockquote"])
/** Wrap in a marker with the surrounding spaces kept outside (so "*a *" never happens). */
function wrap(mark, s) {
  const core = s.trim()
  if (!core) return s
  if (core.startsWith(mark) && core.endsWith(mark) && core.length > 2 * mark.length) return s // already wrapped
  return s.match(/^\s*/)[0] + mark + core + mark + s.match(/\s*$/)[0]
}
function inline(nodes, br) {
  let out = ""
  // merge adjacent runs of the same kind (<strong>A</strong><strong>B</strong> → **AB**)
  const merged = []
  for (const n of nodes) {
    const last = merged[merged.length - 1]
    if (n.tag && INLINE_MARK[n.tag] && last?.tag === n.tag) last.children = [...last.children, ...n.children]
    else merged.push(n.tag ? { ...n } : n)
  }
  for (const n of merged) {
    if (n.text != null) out += n.text.replace(/\s+/g, " ")
    else if (n.tag === "br") out += br
    else if (n.tag === "img") continue
    else if (INLINE_MARK[n.tag]) out += wrap(INLINE_MARK[n.tag], inline(n.children, br))
    else if (BLOCK.has(n.tag)) out += " " + inline(n.children, br) + " "
    else out += inline(n.children, br) // a, u, s, sup, sub, span …
  }
  return out
}
const para = (nodes, br = "\\\n") => inline(nodes, br).replace(/[ \t]+/g, " ").replace(/ ?\\\n ?/g, "\\\n").trim().replace(/\\$/, "").trim()
/** A whole-line **bold** heading is just a heading. */
const unwrapLine = (s) => (/^\*\*[^*]+\*\*$/.test(s) ? s.slice(2, -2) : s)

function blocksOf(nodes, out, depth = 0) {
  let loose = [] // inline content directly inside a block container
  const flush = () => {
    const t = para(loose)
    if (t) out.push(t)
    loose = []
  }
  for (const n of nodes) {
    if (n.text != null || !BLOCK.has(n.tag)) { loose.push(n); continue }
    flush()
    if (n.tag === "p" || n.tag === "div" || n.tag === "blockquote") {
      if (n.children.some((c) => c.tag && BLOCK.has(c.tag))) blocksOf(n.children, out, depth)
      else { const t = para(n.children); if (t) out.push(t) }
    } else if (/^h[1-6]$/.test(n.tag)) {
      const t = unwrapLine(para(n.children, " "))
      if (t) out.push(`${"#".repeat(Number(n.tag[1]))} ${t}`)
    } else if (n.tag === "ul" || n.tag === "ol") {
      out.push(listOf(n, depth).join("\n"))
    } else if (n.tag === "table") {
      out.push(...tableOf(n))
    } else blocksOf(n.children, out, depth)
  }
  flush()
  return out
}

function listOf(list, depth) {
  const lines = []
  let k = 1
  for (const li of list.children.filter((c) => c.tag === "li")) {
    const own = [], nested = []
    for (const c of li.children) (c.tag === "ul" || c.tag === "ol" ? nested : own).push(c)
    const text = blocksOf(own, [], depth).join(" ").replace(/\\\n/g, " ")
    const bullet = list.tag === "ol" ? `${k++}.` : "-"
    lines.push(`${"   ".repeat(depth)}${bullet} ${text}`.trimEnd())
    for (const nl of nested) lines.push(...listOf(nl, depth + 1))
  }
  return lines
}

function tableOf(table) {
  const rows = []
  const collect = (n) => {
    for (const c of n.children) {
      if (c.tag === "tr") rows.push(c.children.filter((x) => x.tag === "td" || x.tag === "th"))
      else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") collect(c)
    }
  }
  collect(table)
  const cell = (c) => blocksOf(c.children, []).map((b) => b.replace(/\\\n/g, "<br>").replace(/\n+/g, "<br>")).join("<br>").replace(/\|/g, "\\|").trim()
  const grid = rows.map((r) => r.map(cell)).filter((r) => r.some(Boolean))
  if (!grid.length) return []
  const width = Math.max(...grid.map((r) => r.length))
  // a 1×1 or single-column "frame" table is just text
  if (width === 1) return grid.map((r) => r[0].replace(/<br>/g, "\n\n"))
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`
  return [[line(grid[0]), `|${" --- |".repeat(width)}`, ...grid.slice(1).map(line)].join("\n")]
}

export function htmlToMarkdown(html) {
  return blocksOf(parseHtml(html).children, []).join("\n\n")
}

async function docxMarkdown(buf) {
  try {
    const md = htmlToMarkdown((await mammoth.convertToHtml({ buffer: buf }, MAMMOTH_OPTIONS)).value)
    if (md.trim()) return md
  } catch (e) {
    console.warn("[extract] docx → markdown failed, using plain text:", String(e.message).slice(0, 160))
  }
  return (await mammoth.extractRawText({ buffer: buf })).value
}

function tidy(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .normalize("NFC")
    .trim()
}

/**
 * Extract text from a stored upload. Throws Error with a Vietnamese message for the user.
 * onPhase(phase, info): "ocr-wait" (another scan is being recognised) | "ocr" (recognising this scan; info.pages).
 * A scan returns `ocr` (engine, pages, totalPages, warnings, ms) and the labelled OCR text.
 */
export async function extractText(filePath, ext, cap, { onPhase } = {}) {
  const buf = await fs.readFile(filePath)
  let text
  if (ext === ".docx") {
    if (buf.subarray(0, 2).toString("latin1") !== "PK") throw new Error("Tệp .docx không hợp lệ.")
    text = await docxMarkdown(buf)
  } else if (ext === ".pdf") {
    if (!buf.subarray(0, 1024).toString("latin1").includes("%PDF")) throw new Error("Tệp PDF không hợp lệ.")
    const r = await pdfText(buf, cap)
    text = r.text
    if (!text.trim()) {
      const o = await ocrScan(buf, cap, r.pages, onPhase)
      return { text: o.text, chars: o.chars, truncated: o.truncated, ocr: o.ocr }
    }
  } else {
    if (buf.includes(0)) throw new Error("Tệp văn bản chứa dữ liệu nhị phân.")
    text = new TextDecoder("utf-8", { fatal: false }).decode(buf).replace(/^﻿/, "")
  }
  text = tidy(text)
  if (!text) throw new Error("Không đọc được nội dung chữ trong tệp.")
  const truncated = text.length > cap
  return { text: truncated ? text.slice(0, cap) : text, chars: text.length, truncated }
}
