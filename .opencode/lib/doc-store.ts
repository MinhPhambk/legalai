// Document store shared by the opencode tools (document_create / document_read / document_edit) and the
// Node web server (uploads, fork continuity). Imported by Node 24 via native TS type-stripping, so: no
// enums / namespaces / parameter properties, explicit .ts import extensions, no Bun-only APIs.
//
// Layout: <outputs>/<sessionID>/<slug>-<id>.{md,html,docx,pdf,json} (+ <base>.thay-doi.docx = redline,
// <base>.original.<ext> = uploaded original, <base>.en.md = English text of a bilingual document –
// meta.language "vi" (default / missing) | "en" | "bilingual"). <outputs> = $LEGALAI_OUTPUTS_DIR, else
// $XDG_CACHE_HOME/../outputs, else <project>/.sandbox/outputs.
// Every save is a NEW immutable version (new id); versions are chained with root_id / parent_id.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { marked, type Token, type Tokens } from "marked"
import {
  AlignmentType, BorderStyle, DeletedTextRun, Document, Footer, HeadingLevel, InsertedTextRun, LevelFormat, Packer,
  PageNumber, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType,
} from "docx"
import { inheritSession, loadEvidence, recordEvidence } from "./evidence.ts"

export { inheritSession }

// ---------- types ----------
export type DocKind = "hop-dong" | "bao-cao" | "van-ban"
export type EditOp = "replace" | "insert_after" | "insert_before" | "delete" | "replace_section"
export type DocLang = "vi" | "en" | "bilingual"
export type Change = { op: EditOp; target: string; before?: string; after?: string; lang?: "vi" | "en"; key?: string }
export type Edit = { op: EditOp; find?: string; section?: string; text?: string; lang?: "vi" | "en" | "both"; find_en?: string; text_en?: string }
export type DocFile = { name: string; format: string; bytes: number }
export type DocMeta = {
  id: string
  title: string
  kind: DocKind
  files: DocFile[]
  preview: string
  markdown: string
  sessionID: string
  createdAt: string
  version: number
  root_id: string
  parent_id: string | null
  origin: "agent" | "upload"
  changes: Change[]
  sign?: [string, string] | null
  national_header?: boolean
  note?: string
  original?: string | null
  /** missing = "vi" (documents made before bilingual support) */
  language?: DocLang
  /** bilingual only: which version prevails (default "vi") */
  prevailing?: "vi" | "en"
  /** bilingual only: file name of the English markdown (<base>.en.md) */
  markdown_en?: string
  /** bilingual only: English signature labels */
  sign_en?: [string, string] | null
  /** text recognised by OCR from a scanned upload (../lib/pdf-ocr.ts); carried forward to later versions */
  ocr?: OcrDocMeta
  [k: string]: unknown
}
export type OcrDocMeta = { engine: string; pages: number[]; totalPages: number }
const ocrDocMeta = (o: any): OcrDocMeta | null =>
  o && typeof o === "object" && typeof o.engine === "string" ? { engine: o.engine, pages: Array.isArray(o.pages) ? o.pages.map(Number).filter(Number.isInteger) : [], totalPages: Number(o.totalPages) || 0 } : null

export const ID_RE = /^[\w-]{3,40}$/
const PORT = process.env.CHROME_PORT ?? "9333"
const FONT = "Times New Roman"
const SIZE = 26 // half-points → 13 pt
const AUTHOR = "LegalAI"
// Body text size of the docx builders below; bilingual (two-column) documents render at 12 pt.
let BODY = SIZE

export const outputsRoot = () =>
  process.env.LEGALAI_OUTPUTS_DIR ??
  (process.env.XDG_CACHE_HOME
    ? path.join(process.env.XDG_CACHE_HOME, "..", "outputs")
    : path.join(fileURLToPath(new URL("../../", import.meta.url)), ".sandbox", "outputs"))
export const outDir = (sessionID: string) => path.join(outputsRoot(), String(sessionID).replace(/[^\w.-]/g, "_"))
export const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "tai-lieu"
const newId = () => `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`
const clip = (s: string | undefined, n = 400) => (s == null ? undefined : s.length > n ? s.slice(0, n - 1) + "…" : s)

// ---------- markdown → docx ----------
type Run = { text: string; bold?: boolean; italics?: boolean; underline?: boolean }

function inlineRuns(tokens: Token[] | undefined, style: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = []
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong": out.push(...inlineRuns((t as Tokens.Strong).tokens, { ...style, bold: true })); break
      case "em": out.push(...inlineRuns((t as Tokens.Em).tokens, { ...style, italics: true })); break
      case "del": out.push(...inlineRuns((t as Tokens.Del).tokens, style)); break
      case "link": out.push(...inlineRuns((t as Tokens.Link).tokens, { ...style, underline: true })); break
      case "codespan": out.push({ ...style, text: (t as Tokens.Codespan).text }); break
      case "br": out.push({ ...style, text: "\n" }); break
      // raw inline HTML (imported tables use <br> inside cells): line breaks kept, other tags dropped
      case "html": out.push({ ...style, text: decode(String((t as any).raw ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")) }); break
      case "text": {
        const tt = t as Tokens.Text
        if (tt.tokens?.length) out.push(...inlineRuns(tt.tokens, style))
        else out.push({ ...style, text: decode(tt.text) })
        break
      }
      default: out.push({ ...style, text: decode((t as any).text ?? (t as any).raw ?? "") })
    }
  }
  return out
}
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
const textRuns = (runs: Run[], extra: Record<string, unknown> = {}) =>
  runs.flatMap((r) => r.text.split("\n").map((part, i) => new TextRun({ text: part, bold: r.bold, italics: r.italics, underline: r.underline ? {} : undefined, font: FONT, size: BODY, break: i ? 1 : undefined, ...extra })))

function blocks(tokens: Token[], level = 0): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = []
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading
        const centered = h.depth === 1
        out.push(new Paragraph({
          children: textRuns(inlineRuns(h.tokens), { bold: true, size: h.depth === 1 ? 30 : BODY, allCaps: h.depth === 1 }),
          alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
          heading: h.depth === 1 ? HeadingLevel.TITLE : h.depth === 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
          spacing: { before: centered ? 120 : 240, after: 120 },
          keepNext: true,
        }))
        break
      }
      case "paragraph": {
        const p = t as Tokens.Paragraph
        out.push(new Paragraph({ children: textRuns(inlineRuns(p.tokens)), alignment: AlignmentType.JUSTIFIED, spacing: { after: 120, line: 312 } }))
        break
      }
      case "list": {
        const l = t as Tokens.List
        l.items.forEach((item, idx) => {
          const [first, ...rest] = item.tokens
          const firstRuns = first && (first.type === "text" || first.type === "paragraph") ? inlineRuns((first as any).tokens ?? [{ type: "text", text: (first as any).text }] as any) : []
          const bullet = l.ordered ? `${(Number(l.start) || 1) + idx}. ` : "– "
          out.push(new Paragraph({
            children: [new TextRun({ text: bullet, font: FONT, size: BODY }), ...textRuns(firstRuns)],
            alignment: AlignmentType.JUSTIFIED,
            indent: { left: 360 * (level + 1), hanging: 280 },
            spacing: { after: 80, line: 312 },
          }))
          out.push(...blocks(first && (first.type === "text" || first.type === "paragraph") ? rest : item.tokens, level + 1))
        })
        break
      }
      case "blockquote":
        out.push(...blocks((t as Tokens.Blockquote).tokens, level + 1))
        break
      case "table": {
        const tb = t as Tokens.Table
        const border = { style: BorderStyle.SINGLE, size: 4, color: "000000" }
        const cell = (c: Tokens.TableCell, head: boolean) => new TableCell({
          children: [new Paragraph({ children: textRuns(inlineRuns(c.tokens), head ? { bold: true } : {}), spacing: { after: 40 } })],
          borders: { top: border, bottom: border, left: border, right: border },
        })
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ tableHeader: true, children: tb.header.map((c) => cell(c, true)) }), ...tb.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) }))],
        }))
        out.push(new Paragraph({ children: [], spacing: { after: 120 } }))
        break
      }
      case "hr":
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, spacing: { after: 120 } }))
        break
      case "code":
        out.push(new Paragraph({ children: [new TextRun({ text: (t as Tokens.Code).text, font: "Consolas", size: 20 })] }))
        break
      case "space":
        break
      default:
        if ((t as any).text) out.push(new Paragraph({ children: textRuns([{ text: decode((t as any).text) }]) }))
    }
  }
  return out
}

// Quốc hiệu – Tiêu ngữ block used on contracts and official-style documents: Vietnamese, English
// ("SOCIALIST REPUBLIC OF VIETNAM / Independence – Freedom – Happiness") or both (VN line, EN italic line).
export type RenderLang = "vi" | "en" | "bilingual"
const QH_VI = "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", TN_VI = "Độc lập – Tự do – Hạnh phúc"
const QH_EN = "SOCIALIST REPUBLIC OF VIETNAM", TN_EN = "Independence – Freedom – Happiness"
const SIGN_NOTE_VI = "(Ký, ghi rõ họ tên, chức vụ và đóng dấu)", SIGN_NOTE_EN = "(Signature, full name, title and seal)"
const centerLine = (text: string, o: Record<string, unknown> = {}, after = 0) =>
  new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, font: FONT, size: SIZE, ...o })], ...(after ? { spacing: { after } } : {}) })
const nationalHeader = (lang: RenderLang = "vi") =>
  lang === "en" ? [centerLine(QH_EN, { bold: true }), centerLine(TN_EN, { bold: true, size: 28, underline: {} }, 240)]
    : lang === "bilingual" ? [centerLine(QH_VI, { bold: true }), centerLine(QH_EN, { italics: true, size: 24 }), centerLine(TN_VI, { bold: true, size: 28, underline: {} }), centerLine(TN_EN, { italics: true, size: 24 }, 240)]
      : [centerLine(QH_VI, { bold: true }), centerLine(TN_VI, { bold: true, size: 28, underline: {} }, 240)]
const nationalHeaderHtml = (lang: RenderLang = "vi") =>
  lang === "en" ? `<div class="qh"><b>${QH_EN}</b><br><b><u>${TN_EN}</u></b></div>`
    : lang === "bilingual" ? `<div class="qh"><b>${QH_VI}</b><br><i class="en">${QH_EN}</i><br><b><u>${TN_VI}</u></b><br><i class="en">${TN_EN}</i></div>`
      : `<div class="qh"><b>${QH_VI}</b><br><b><u>${TN_VI}</u></b></div>`

/** Signature block columns: label line(s) + note line(s) per party, in the document's language(s). */
type SignCol = { labels: string[]; notes: string[] }
function signCols(lang: RenderLang, sign?: [string, string] | null, signEn?: [string, string] | null): [SignCol, SignCol] | null {
  if (!sign && !signEn) return null
  const col = (i: 0 | 1): SignCol =>
    lang === "en" ? { labels: [(sign ?? signEn)![i]], notes: [SIGN_NOTE_EN] }
      : lang === "bilingual" ? { labels: [sign?.[i], signEn?.[i]].filter((x): x is string => !!x), notes: [SIGN_NOTE_VI, SIGN_NOTE_EN] }
        : { labels: [(sign ?? signEn)![i]], notes: [SIGN_NOTE_VI] }
  return [col(0), col(1)]
}

function signatureTable(cols: [SignCol, SignCol]) {
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }
  const col = (c: SignCol) => new TableCell({
    borders: { top: none, bottom: none, left: none, right: none },
    children: [
      ...c.labels.map((label, i) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: label, bold: true, italics: i > 0, font: FONT, size: i > 0 ? 24 : SIZE })] })),
      ...c.notes.map((note, i) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: note, italics: true, font: FONT, size: 22 })], spacing: { after: i === c.notes.length - 1 ? 1400 : 0 } })),
    ],
  })
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ cantSplit: true, children: [col(cols[0]), col(cols[1])] })] })
}
const signatureHtml = (cols: [SignCol, SignCol] | null) =>
  cols ? `<table class="sign"><tr>${cols.map((c) => `<td>${c.labels.map((l, i) => (i ? `<br><b><i>${escHtml(l)}</i></b>` : `<b>${escHtml(l)}</b>`)).join("")}${c.notes.map((n) => `<br><i class="note">${escHtml(n)}</i>`).join("")}</td>`).join("")}</tr></table>` : ""

// ---- annexes after the signature block ----
// A line "<!-- phu-luc -->" splits a document: everything before it is the main contract (signature table right
// after it), everything after it are the annexes (Phụ lục / Appendix), each starting on a new page. Documents
// without the marker render exactly as before. The marker stays in the stored markdown, so document_edit /
// redline / bilingual keep the layout.
export const ANNEX_MARKER = "<!-- phu-luc -->"
const ANNEX_RE = /^[ \t]*<!--\s*phu-luc\s*-->[ \t]*$/m
export function splitAnnexes(md: string): { main: string; annex: string | null } {
  const m = md.match(ANNEX_RE)
  if (!m || m.index == null) return { main: md, annex: null }
  return { main: md.slice(0, m.index).replace(/\s+$/, "\n"), annex: md.slice(m.index + m[0].length).replace(/^\s+/, "") }
}
/** Annex part → one chunk per annex heading ("## Phụ lục 1 …", "## Appendix 1 …"); text before the first heading joins it. */
function annexChunks(annex: string): string[] {
  const lines = annex.split("\n")
  const out: string[][] = []
  for (const l of lines) {
    if (/^#{1,3}\s+(?:\*\*)?(?:phụ\s*lục|appendix|annex)\b/iu.test(l) || !out.length) out.push([])
    out[out.length - 1].push(l)
  }
  return out.map((c) => c.join("\n").trim()).filter(Boolean)
}
const pageBreak = () => new Paragraph({ pageBreakBefore: true, children: [] })

function wrapDocx(title: string, body: (Paragraph | Table)[], header: RenderLang | null, cols: [SignCol, SignCol] | null, tail: (Paragraph | Table)[] = []) {
  const doc = new Document({
    creator: "FTU LegalAI",
    title,
    styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
    numbering: { config: [{ reference: "none", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT }] }] },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1701, right: 1134 } } }, // A4; 2 cm / 3 cm left
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 22 })] })] }) },
      children: [...(header ? nationalHeader(header) : []), ...body, ...(cols ? [new Paragraph({ children: [], spacing: { after: 240 } }), signatureTable(cols)] : []), ...tail],
    }],
  })
  return Packer.toBuffer(doc)
}

/** Single-language document (Vietnamese by default; lang="en" → English header / signature notes). */
export async function toDocx(title: string, md: string, kind: string, sign?: [string, string] | null, header?: boolean, lang: "vi" | "en" = "vi") {
  BODY = SIZE
  const { main, annex } = splitAnnexes(md)
  const tail = annex == null ? [] : annexChunks(annex).flatMap((c) => [pageBreak(), ...blocks(marked.lexer(c))])
  return wrapDocx(title, blocks(marked.lexer(main)), (header ?? kind === "hop-dong") ? lang : null, signCols(lang, sign), tail)
}
const annexHtml = (annex: string | null, render: (md: string) => string) =>
  annex == null ? "" : annexChunks(annex).map((c) => `<section class="annex">${render(c)}</section>`).join("")

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const BASE_CSS = `
@page { size: A4; margin: 2cm 2cm 2cm 3cm; }
body { font-family: "Times New Roman", Times, serif; font-size: 13pt; line-height: 1.45; color: #000; }
.qh { text-align: center; margin-bottom: 18pt; } h1 { text-align: center; text-transform: uppercase; font-size: 15pt; margin: 6pt 0 12pt; }
h2 { font-size: 13pt; margin: 14pt 0 6pt; } h3 { font-size: 13pt; font-style: italic; margin: 10pt 0 4pt; }
h1, h2, h3 { break-after: avoid; page-break-after: avoid; } tr, blockquote { break-inside: avoid; } table.sign { break-inside: avoid; }
p, li { text-align: justify; margin: 0 0 6pt; } table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; }
th, td { border: 1px solid #000; padding: 4pt 6pt; vertical-align: top; font-size: 12pt; } th { background: #f2f2f2; }
table.sign td { border: none; text-align: center; width: 50%; padding-bottom: 70pt; } table.sign .note { font-size: 11pt; } blockquote { margin: 6pt 0 6pt 18pt; font-style: italic; }
a { color: #000; }
section.annex { break-before: page; page-break-before: always; margin-top: 18pt; border-top: 1px dashed #bbb; padding-top: 12pt; }
@media print { section.annex { border-top: none; margin-top: 0; padding-top: 0; } }
`
const htmlPage = (title: string, lang: string, css: string, body: string) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`

export function toHtml(title: string, md: string, kind: string, sign?: [string, string] | null, header?: boolean, lang: "vi" | "en" = "vi") {
  const { main, annex } = splitAnnexes(md)
  const body = marked.parse(main) as string
  return htmlPage(title, lang, "", `${(header ?? kind === "hop-dong") ? nationalHeaderHtml(lang) : ""}${body}${signatureHtml(signCols(lang, sign))}${annexHtml(annex, (c) => marked.parse(c) as string)}`)
}

export async function toPdf(html: string) {
  const puppeteer = (await import("puppeteer-core")).default
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const page = await browser.newPage()
  try {
    await page.setContent(html, { waitUntil: "load" })
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: "<div></div>", footerTemplate: '<div style="width:100%;text-align:center;font-size:9pt;font-family:Times New Roman"><span class="pageNumber"></span></div>' })
  } finally {
    await page.close().catch(() => {})
    browser.disconnect()
  }
}

// ---------- diff (LCS) ----------
type DiffOp<T> = { t: "eq" | "del" | "ins"; a?: T; b?: T }

function lcsDiff<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): DiffOp<T>[] {
  let pre = 0
  while (pre < a.length && pre < b.length && eq(a[pre], b[pre])) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && eq(a[a.length - 1 - suf], b[b.length - 1 - suf])) suf++
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf)
  const n = A.length, m = B.length
  const mid: DiffOp<T>[] = []
  if (n * m > 16_000_000) {
    for (const x of A) mid.push({ t: "del", a: x })
    for (const y of B) mid.push({ t: "ins", b: y })
  } else {
    const w = m + 1
    const L = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * w + j] = eq(A[i], B[j]) ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
    let i = 0, j = 0
    while (i < n && j < m) {
      if (eq(A[i], B[j])) { mid.push({ t: "eq", a: A[i], b: B[j] }); i++; j++ }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) mid.push({ t: "del", a: A[i++] })
      else mid.push({ t: "ins", b: B[j++] })
    }
    while (i < n) mid.push({ t: "del", a: A[i++] })
    while (j < m) mid.push({ t: "ins", b: B[j++] })
  }
  return [
    ...a.slice(0, pre).map((x, k) => ({ t: "eq" as const, a: x, b: b[k] })),
    ...mid,
    ...a.slice(a.length - suf).map((x, k) => ({ t: "eq" as const, a: x, b: b[b.length - suf + k] })),
  ]
}

const words = (s: string) => new Set(normKey(s).split(" ").filter((w) => w.length > 1))
function similarity(x: string, y: string) {
  const a = words(x), b = words(y)
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const w of a) if (b.has(w)) hit++
  return (2 * hit) / (a.size + b.size)
}

/** Line-level diff where changed runs of lines are aligned into (old, new) pairs by word similarity. */
type LineItem = { t: "eq"; line: string } | { t: "pair"; a: string; b: string } | { t: "del"; a: string } | { t: "ins"; b: string }
function lineDiff(oldMd: string, newMd: string): LineItem[] {
  return lineDiffIndexed(oldMd, newMd).map((x) => x.it)
}
/**
 * lineDiff where every item carries `j` = the index of the NEW line it belongs to (deletions: the next
 * new line after them), so the items can be distributed over the cells of a bilingual layout.
 */
function lineDiffIndexed(oldMd: string, newMd: string): { it: LineItem; j: number }[] {
  const ops = lcsDiff(oldMd.split("\n"), newMd.split("\n"))
  const res: { it: LineItem; j: number }[] = []
  const out = { push: (it: LineItem) => { res.push({ it, j: -1 }) } }
  let jNow = 0
  let dels: string[] = [], inss: string[] = [], insJ: number[] = []
  const flush = () => {
    const from = res.length
    const Ij = insJ.filter((_, k) => inss[k].trim())
    const D = dels.filter((l) => l.trim()), I = inss.filter((l) => l.trim())
    dels = []; inss = []; insJ = []
    let ij = 0
    const push0 = out.push
    out.push = (it: LineItem) => { push0(it); if (it.t === "pair" || it.t === "ins") res[res.length - 1].j = Ij[ij++] }
    // DP alignment keeping order: pair (i, j) when similar enough, otherwise leave as pure del / ins.
    const n = D.length, m = I.length
    const S: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) {
        const s = similarity(D[i], I[j])
        S[i][j] = Math.max(S[i + 1][j], S[i][j + 1], s >= 0.3 ? S[i + 1][j + 1] + s : -1)
      }
    let i = 0, j = 0
    while (i < n && j < m) {
      const s = similarity(D[i], I[j])
      if (s >= 0.3 && S[i][j] === S[i + 1][j + 1] + s) { out.push({ t: "pair", a: D[i++], b: I[j++] }) }
      else if (S[i][j] === S[i + 1][j]) out.push({ t: "del", a: D[i++] })
      else out.push({ t: "ins", b: I[j++] })
    }
    while (i < n) out.push({ t: "del", a: D[i++] })
    while (j < m) out.push({ t: "ins", b: I[j++] })
    out.push = push0
    // deletions belong to the next new line of the run (or the line after the run)
    let next = jNow
    for (let k = res.length - 1; k >= from; k--) { if (res[k].j >= 0) next = res[k].j; else res[k].j = next }
  }
  for (const o of ops) {
    if (o.t === "eq") { if (dels.length || inss.length) flush(); out.push({ t: "eq", line: o.a as string }); res[res.length - 1].j = jNow++ }
    else if (o.t === "del") dels.push(o.a as string)
    else { inss.push(o.b as string); insJ.push(jNow++) }
  }
  if (dels.length || inss.length) flush()
  return res
}

// ---------- redline (.docx with Word tracked changes) ----------
type Tok = Run
type Layout = { kind: "heading" | "list" | "quote" | "table" | "para"; depth: number; prefix: string; content: string }

function layoutOf(line: string): Layout {
  let m: RegExpMatchArray | null
  if ((m = line.match(/^(#{1,6})\s+(.*)$/))) return { kind: "heading", depth: m[1].length, prefix: "", content: m[2].replace(/\s+#+\s*$/, "") }
  if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) return { kind: "list", depth: Math.floor(m[1].length / 2), prefix: /\d/.test(m[2]) ? `${m[2]} ` : "– ", content: m[3] }
  if ((m = line.match(/^\s*>\s?(.*)$/))) return { kind: "quote", depth: 0, prefix: "", content: m[1] }
  if (/^\s*\|/.test(line)) return { kind: "table", depth: 0, prefix: "", content: line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join("  |  ") }
  return { kind: "para", depth: 0, prefix: "", content: line.trim() }
}
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)

function tokensOf(l: Layout): Tok[] {
  const runs = [{ text: l.prefix } as Run, ...inlineRuns(marked.Lexer.lexInline(l.content))]
  const out: Tok[] = []
  for (const r of runs) for (const part of r.text.split(/(\s+)/)) if (part) out.push({ ...r, text: part })
  return out
}

type Ctx = { id: number; date: string }
function redlineParagraph(ctx: Ctx, mode: "pair" | "del" | "ins", a: string | undefined, b: string | undefined) {
  const la = a != null ? layoutOf(a) : undefined, lb = b != null ? layoutOf(b) : undefined
  const lay = (lb ?? la) as Layout
  const ta = la ? tokensOf(la) : [], tb = lb ? tokensOf(lb) : []
  const seq: { t: "eq" | "del" | "ins"; tok: Tok }[] =
    mode === "del" ? ta.map((tok) => ({ t: "del" as const, tok }))
      : mode === "ins" ? tb.map((tok) => ({ t: "ins" as const, tok }))
        : lcsDiff(ta, tb, (x, y) => x.text === y.text).map((o) => ({ t: o.t, tok: (o.t === "del" ? o.a : o.b) as Tok }))
  const extra: Record<string, unknown> = lay.kind === "heading" ? { bold: true, size: lay.depth === 1 ? 30 : BODY, allCaps: lay.depth === 1 } : lay.kind === "quote" ? { italics: true } : lay.kind === "table" ? { size: BODY - 2 } : {}
  const children: (TextRun | InsertedTextRun | DeletedTextRun)[] = []
  let i = 0
  while (i < seq.length) {
    const s = seq[i]
    let text = s.tok.text
    let k = i + 1
    while (k < seq.length && seq[k].t === s.t && !!seq[k].tok.bold === !!s.tok.bold && !!seq[k].tok.italics === !!s.tok.italics && !!seq[k].tok.underline === !!s.tok.underline) text += seq[k++].tok.text
    const opts = { text, bold: s.tok.bold, italics: s.tok.italics, underline: s.tok.underline ? {} : undefined, font: FONT, size: BODY, ...extra }
    if (s.t === "eq") children.push(new TextRun(opts))
    else if (s.t === "ins") children.push(new InsertedTextRun({ ...opts, id: ctx.id++, author: AUTHOR, date: ctx.date }))
    else children.push(new DeletedTextRun({ ...opts, id: ctx.id++, author: AUTHOR, date: ctx.date }))
    i = k
  }
  const mark = mode === "pair" ? undefined : { [mode === "ins" ? "insertion" : "deletion"]: { id: ctx.id++, author: AUTHOR, date: ctx.date } }
  return new Paragraph({
    children,
    alignment: lay.kind === "heading" && lay.depth === 1 ? AlignmentType.CENTER : lay.kind === "heading" || lay.kind === "table" ? AlignmentType.LEFT : AlignmentType.JUSTIFIED,
    ...(lay.kind === "list" ? { indent: { left: 360 * (lay.depth + 1), hanging: 280 } } : lay.kind === "quote" ? { indent: { left: 360 } } : {}),
    spacing: lay.kind === "heading" ? { before: 240, after: 120 } : { after: 120, line: 312 },
    ...(mark ? { run: mark as any } : {}),
  })
}

/** Blocks of a redline: unchanged lines as normal markdown, changed lines as tracked-change paragraphs. */
function redlineBody(ctx: Ctx, items: LineItem[]): (Paragraph | Table)[] {
  const body: (Paragraph | Table)[] = []
  let eqBuf: string[] = []
  const flushEq = () => {
    if (eqBuf.length) body.push(...blocks(marked.lexer(eqBuf.join("\n"))))
    eqBuf = []
  }
  for (const it of items) {
    if (it.t === "eq") { eqBuf.push(it.line); continue }
    flushEq()
    const a = it.t === "ins" ? undefined : it.a, b = it.t === "del" ? undefined : it.b
    if ((a != null && isTableSep(a)) || (b != null && isTableSep(b))) continue
    body.push(redlineParagraph(ctx, it.t, a, b))
  }
  flushEq()
  return body
}
const redlineNote = (note: string) =>
  new Paragraph({ children: [new TextRun({ text: note, italics: true, font: FONT, size: 22, color: "666666" })], spacing: { after: 200 } })
const newCtx = (): Ctx => ({ id: 1, date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") })

/** Redline .docx: the NEW document with Word tracked changes (w:ins / w:del) against the old one. */
export async function toRedlineDocx(title: string, oldMd: string, newMd: string, kind: string, sign?: [string, string] | null, header?: boolean, note?: string, lang: "vi" | "en" = "vi") {
  BODY = SIZE
  const ctx = newCtx()
  const o = splitAnnexes(oldMd), n = splitAnnexes(newMd)
  const body = [
    redlineNote(note ?? "Bản theo dõi thay đổi (Track Changes) – mở bằng Microsoft Word, tab Review để chấp nhận / từ chối từng thay đổi."),
    ...redlineBody(ctx, lineDiff(o.main, n.main)),
  ]
  // annexes (after the signature block, new page): diffed as one part
  const tail = n.annex == null && o.annex == null ? [] : [pageBreak(), ...redlineBody(ctx, lineDiff(o.annex ?? "", n.annex ?? ""))]
  return wrapDocx(`${title} – thay đổi`, body, (header ?? kind === "hop-dong") ? lang : null, signCols(lang, sign), tail)
}

// ---------- structure: headings, sections, labels ----------
export const normKey = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\*\*|__/g, "").replace(/[^\p{L}\p{N}.]+/gu, " ").replace(/\s+/g, " ").trim()

type Heading = { line: number; level: number; text: string; start: number; lineEnd: number; real: boolean }

function lineStarts(md: string) {
  const s = [0]
  for (let i = 0; i < md.length; i++) if (md[i] === "\n") s.push(i + 1)
  return s
}
const PSEUDO: [RegExp, number][] = [
  [/^(phần|phan)\s+([\divxlc]+)\b/i, 1.2],
  [/^(chương|chuong)\s+([\divxlc]+)\b/i, 1.5],
  [/^(mục|muc)\s+(\d+)\b/i, 1.8],
  [/^(điều|dieu)\s+(\d+[a-z]?)\s*[.:\-–)]/i, 2.5],
  // English counterparts (English / bilingual documents)
  [/^part\s+([\divxlc]+)\s*(?:[.:\-–)]|$)/i, 1.2],
  [/^chapter\s+([\divxlc]+)\s*(?:[.:\-–)]|$)/i, 1.5],
  [/^article\s+(\d+[a-z]?)\s*[.:\-–)]/i, 2.5],
]

export function headings(md: string): Heading[] {
  const out: Heading[] = []
  const starts = lineStarts(md)
  let fence = false
  starts.forEach((st, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : md.length
    const line = md.slice(st, end).replace(/\r$/, "")
    if (/^\s*```/.test(line)) { fence = !fence; return }
    if (fence) return
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (h) { out.push({ line: i + 1, level: h[1].length, text: h[2].trim(), start: st, lineEnd: end, real: true }); return }
    const plain = line.trim().replace(/^\*\*(.*)\*\*$/, "$1").trim()
    if (plain.length > 160) return
    for (const [re, level] of PSEUDO) if (re.test(plain)) { out.push({ line: i + 1, level, text: plain, start: st, lineEnd: end, real: false }); return }
  })
  return out
}

const sectionEnd = (md: string, hs: Heading[], h: Heading) => {
  const next = hs.find((x) => x.start > h.start && x.level <= h.level)
  return next ? next.start : md.length
}

/** Short human label: "Điều 5", "Chương II", "Mục 5.2", or a clipped heading text. */
export function shortLabel(text: string) {
  const t = text.replace(/\*\*/g, "").trim()
  const m = t.match(/^(điều|chương|mục|phần|khoản|article|chapter|section|part|clause)\s+([\dIVXLCivxlc]+[a-z]?(?:\.\d+)*)/i)
  if (m) {
    // English headings get the Vietnamese label (labels / change summaries are Vietnamese UI text)
    const w = ({ article: "điều", chapter: "chương", section: "mục", part: "phần", clause: "khoản" } as Record<string, string>)[m[1].toLowerCase()] ?? m[1]
    return `${w[0].toUpperCase()}${w.slice(1).toLowerCase()} ${m[2]}`
  }
  const n = t.match(/^(\d+(?:\.\d+)*)[.)]?\s/)
  if (n) return `Mục ${n[1]}`
  return t.length > 40 ? t.slice(0, 39) + "…" : t
}

// Khoản lines: "2. …", "2) …", "**Khoản 2.** …", and the dotted style of imported contracts "10.2. …"
// (= khoản 2 of Điều 10). Điểm lines: "a) …", "– b) …". "1.500.000 đồng …" is not a khoản.
const KHOAN_RE = /^\s*(?:[-*+–—]\s+)?(?:\*\*)?(?:(?:khoản|clause)\s+)?(\d{1,3}(?:\.\d{1,3})*)\s*[.)](?!\d)/iu
const DIEM_RE = /^\s*(?:[-*+–—]\s+)?(?:\*\*)?(?:(?:điểm|point)\s+)?([a-zđ])\s*\)/iu
const dieuNo = (text: string) => text.replace(/\*\*/g, "").trim().match(/^(?:điều|article)\s+(\d+[a-z]?)/iu)?.[1]
/** "10.2" inside Điều 10 → "2"; plain "2" stays "2"; a foreign prefix ("3.5" in Điều 5) is kept. */
const khoanOf = (raw: string, dieu?: string) => {
  const p = raw.split(".")
  return dieu && p.length > 1 && p[0] === dieu ? p.slice(1).join(".") : raw
}

/** Label of the position: nearest enclosing heading, plus "khoản N" / "điểm x" inside an Điều. */
export function labelAt(md: string, pos: number) {
  const hs = headings(md)
  let h: Heading | undefined
  for (const x of hs) if (x.start <= pos) h = x
  if (!h) return "Đầu văn bản"
  if (h.real && h.level === 1) return "Phần mở đầu"
  const label = shortLabel(h.text)
  const dieu = dieuNo(h.text)
  if (dieu && pos > h.lineEnd) {
    const eol = md.indexOf("\n", pos)
    const between = md.slice(h.lineEnd, eol < 0 ? md.length : eol).split("\n")
    // the line containing pos is the last element; it is a điểm only when that line itself is one
    const dm = between[between.length - 1].match(DIEM_RE)
    const diem = dm ? ` điểm ${dm[1].toLowerCase()}` : ""
    for (let i = between.length - 1; i >= 0; i--) {
      const k = between[i].match(KHOAN_RE)
      if (k) return `${label} khoản ${khoanOf(k[1], dieu)}${diem}`
    }
    return label + diem
  }
  return label
}

export class EditError extends Error {
  candidates: string[]
  constructor(message: string, candidates: string[] = []) {
    super(message)
    this.name = "EditError"
    this.candidates = candidates
  }
}

type Span = { start: number; end: number; label: string; heading?: Heading; khoan?: boolean }

/** Locate a section by "Điều 5", "5.2", heading text, or "Điều 5 khoản 2". */
export function findSection(md: string, section: string): Span {
  const hs = headings(md)
  let q = normKey(section.replace(/^#+\s*/, ""))
  let khoan: string | undefined, diem: string | undefined
  const dm = q.match(/^(.+?)\s*(?:diem|point)\s*([a-z])$/)
  if (dm) { q = dm[1].trim(); diem = dm[2] }
  const km = q.match(/^(.*?)\s*(?:khoan|clause|k\.)\s*(\d+(?:\.\d+)*)$/)
  const km2 = q.match(/^(?:khoan|clause)\s*(\d+(?:\.\d+)*)\s+(?:cua\s+|of\s+)?([^\d.\s].*)$/)
  if (km && km[1]) { q = km[1].trim(); khoan = km[2] }
  else if (km2) { q = km2[2].trim(); khoan = km2[1] }
  else if (km && km[2].includes(".")) { q = km[2].split(".")[0]; khoan = km[2] } // "khoản 10.2" → Điều 10
  if (dm && !khoan && !/^((dieu|article)\s+)?\d+[a-z]?$/.test(q)) { q = `${q} diem ${diem}`; diem = undefined } // not an Điều query
  // "Điều 5" also finds "Article 5" (and vice versa) – bilingual / English documents
  const SWAP: Record<string, string> = { dieu: "article", article: "dieu", chuong: "chapter", chapter: "chuong", phan: "part", part: "phan", muc: "section", section: "muc" }
  const w0 = q.split(" ")[0]
  const queries = /^\d+$/.test(q) ? [`dieu ${q}`, `article ${q}`, q] : SWAP[w0] ? [q, SWAP[w0] + q.slice(w0.length)] : [q]
  let found: Heading[] = []
  for (const qq of queries) {
    found = hs.filter((h) => {
      const ht = normKey(h.text)
      if (!ht.startsWith(qq)) return false
      const rest = ht.slice(qq.length)
      return !/^\d/.test(rest) && !/^\.\d/.test(rest) && !/^[a-z]\b/.test(rest)
    })
    if (found.length) break
  }
  if (!found.length) found = hs.filter((h) => normKey(h.text).includes(q))
  const list = (xs: Heading[]) => xs.slice(0, 12).map((h) => `dòng ${h.line}: ${h.text.slice(0, 100)}`)
  if (!found.length) throw new EditError(`Không tìm thấy mục "${section}". Các tiêu đề hiện có:`, list(hs))
  if (found.length > 1) throw new EditError(`"${section}" khớp nhiều mục – ghi rõ hơn (VD tiêu đề đầy đủ):`, list(found))
  const h = found[0]
  const end = sectionEnd(md, hs, h)
  if (!khoan && !diem) return { start: h.start, end, label: shortLabel(h.text), heading: h }
  const dieu = dieuNo(h.text)
  const lineAt = (s: number) => md.slice(s, md.indexOf("\n", s) < 0 ? md.length : md.indexOf("\n", s))
  // An item (khoản / điểm) runs from its line to the next item line of the same or a higher rank.
  const itemSpan = (from: number, to: number, isStart: (line: string) => boolean, isStop: (line: string) => boolean) => {
    let s0 = -1, e0 = to
    for (const s of lineStarts(md).filter((x) => x >= from && x < to)) {
      const line = lineAt(s)
      if (s0 < 0) { if (isStart(line)) s0 = s }
      else if (isStop(line) || /^#{1,6}\s/.test(line)) { e0 = s; break }
    }
    while (s0 >= 0 && e0 > s0 && md[e0 - 1] === "\n") e0-- // leave trailing blank lines outside the item
    return { s0, e0 }
  }
  let label = shortLabel(h.text), start = h.lineEnd + 1, stop = end
  if (khoan) {
    const want = khoanOf(khoan, dieu)
    const r = itemSpan(start, end, (l) => { const m = l.match(KHOAN_RE); return !!m && khoanOf(m[1], dieu) === want }, (l) => KHOAN_RE.test(l))
    if (r.s0 < 0) throw new EditError(`Không tìm thấy khoản ${khoan} trong ${label}.`, [md.slice(h.start, Math.min(end, h.start + 300))])
    label += ` khoản ${want}`; start = r.s0; stop = r.e0
  }
  if (diem) {
    const r = itemSpan(start, stop, (l) => l.match(DIEM_RE)?.[1].toLowerCase() === diem, (l) => DIEM_RE.test(l) || KHOAN_RE.test(l))
    if (r.s0 < 0) throw new EditError(`Không tìm thấy điểm ${diem} trong ${label}.`, [md.slice(start, Math.min(stop, start + 300))])
    label += ` điểm ${diem}`; start = r.s0; stop = r.e0
  }
  return { start, end: stop, label, heading: h, khoan: true }
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function nearest(md: string, find: string, k = 3) {
  const fw = [...words(find)]
  if (!fw.length) return []
  return md.split("\n")
    .map((line, i) => {
      const lw = words(line)
      let hit = 0
      for (const w of fw) if (lw.has(w)) hit++
      return { i, line, score: hit / fw.length }
    })
    .filter((x) => x.score > 0 && x.line.trim())
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => `dòng ${x.i + 1}: ${x.line.trim().slice(0, 220)}`)
}

/** Unique occurrence of `find` (exact first, then whitespace-insensitive). Throws EditError otherwise. */
export function locate(md: string, rawFind: string): { start: number; end: number } {
  const find = rawFind.normalize("NFC").trim()
  if (!find) throw new EditError("`find` rỗng.")
  const hits: number[][] = []
  for (let i = md.indexOf(find); i >= 0 && hits.length < 20; i = md.indexOf(find, i + 1)) hits.push([i, i + find.length])
  if (!hits.length) {
    const re = new RegExp(find.split(/\s+/).map(escRe).join("\\s+"), "g")
    for (const m of md.matchAll(re)) { hits.push([m.index as number, (m.index as number) + m[0].length]); if (hits.length >= 20) break }
  }
  if (hits.length === 1) return { start: hits[0][0], end: hits[0][1] }
  if (!hits.length) throw new EditError(`Không tìm thấy đoạn \`find\`: "${clip(find, 120)}". Đoạn gần giống nhất:`, nearest(md, find))
  const starts = lineStarts(md)
  const lineOf = (p: number) => { let l = 0; while (l + 1 < starts.length && starts[l + 1] <= p) l++; return l }
  throw new EditError(`Đoạn \`find\` "${clip(find, 120)}" xuất hiện ${hits.length} lần – thêm ngữ cảnh xung quanh cho duy nhất, hoặc dùng \`section\`:`,
    hits.slice(0, 6).map(([s]) => { const l = lineOf(s); return `dòng ${l + 1}: ${md.slice(starts[l], (starts[l + 1] ?? md.length + 1) - 1).trim().slice(0, 220)}` }))
}

const atLineStart = (md: string, p: number) => p === 0 || md[p - 1] === "\n"
const atLineEnd = (md: string, p: number) => p >= md.length || md[p] === "\n" || md.startsWith("\r\n", p)
const isItem = (s: string) => /^\s*([-*+]|\d+[.)]|[a-zđ]\))\s/.test(s) || /^\s*\|/.test(s)
const lineAround = (md: string, p: number) => md.slice(md.lastIndexOf("\n", p - 1) + 1, md.indexOf("\n", p) < 0 ? md.length : md.indexOf("\n", p))

/**
 * Apply targeted edits in order (each `find` / `section` is located in the text as it is AFTER the
 * previous edits). Text outside the edited spans is kept byte-identical. Throws EditError (with
 * candidate snippets) when a target is missing or ambiguous – nothing is applied in that case.
 */
export function applyEdits(markdown: string, edits: Edit[]): { markdown: string; changes: Change[] } {
  let md = markdown
  const changes: Change[] = []
  if (!edits?.length) throw new EditError("Không có thay đổi nào (edits rỗng).")
  edits.forEach((e, n) => {
    const where = edits.length > 1 ? ` (thay đổi #${n + 1})` : ""
    try {
      const text = (e.text ?? "").normalize("NFC")
      const t = text.replace(/^\n+|\s+$/g, "")
      const op = e.op
      if (!["replace", "insert_after", "insert_before", "delete", "replace_section"].includes(op)) throw new EditError(`op không hợp lệ: ${op}`)
      if (op === "replace_section" && !e.section) throw new EditError("replace_section cần `section`.")
      if (op !== "delete" && op !== "replace" && !t) throw new EditError(`${op} cần \`text\`.`)
      if (op === "replace" && e.text == null) throw new EditError("replace cần `text` (dùng op delete để xóa).")
      if (!e.find && !e.section) throw new EditError(`${op} cần \`find\` hoặc \`section\`.`)
      const span: Span = e.find ? { ...locate(md, e.find), label: "" } : findSection(md, e.section as string)
      const mdBefore = md, nBefore = changes.length
      if (e.find) span.label = labelAt(md, span.start)
      const whole = !e.find // section / khoản span (block-level)
      const blockStart = whole || atLineStart(md, span.start)
      const blockEnd = whole || atLineEnd(md, span.end)
      const before = md.slice(span.start, span.end)
      if (op === "replace" && !(whole && !span.khoan)) {
        const repl = whole ? t : text.trim()
        md = md.slice(0, span.start) + repl + md.slice(span.end)
        changes.push({ op, target: span.label, before: clip(before), after: clip(repl) })
      } else if (op === "delete") {
        let s = span.start, en = span.end
        if (blockStart && blockEnd) {
          while (en < md.length && (md[en] === "\n" || md[en] === "\r")) en++
          if (en >= md.length) while (s > 1 && md[s - 1] === "\n" && md[s - 2] === "\n") s--
        }
        md = md.slice(0, s) + md.slice(en)
        changes.push({ op, target: span.label, before: clip(before) })
      } else if (op === "replace_section" || op === "replace") {
        // whole ## section (or khoản): keep the original heading when the new text does not bring one
        const h = span.heading as Heading
        const trailing = span.khoan ? "" : (before.match(/\s*$/) as RegExpMatchArray)[0] || (span.end < md.length ? "\n\n" : "\n")
        const firstLine = t.split("\n")[0]
        const hasHashes = /^#{1,6}\s/.test(t)
        const bringsHeading = hasHashes || normKey(firstLine).startsWith(normKey(shortLabel(h.text)))
        const keepHeading = !span.khoan && !bringsHeading
        const body = !span.khoan && bringsHeading && h.real && !hasHashes ? `${"#".repeat(h.level)} ${t}` : t // keep heading level
        const from = keepHeading ? h.lineEnd : span.start
        const repl = keepHeading ? `\n\n${body}${trailing}` : `${body}${trailing}`
        const old = md.slice(from, span.end)
        md = md.slice(0, from) + repl + md.slice(span.end)
        changes.push({ op, target: span.label, before: clip(old.trim()), after: clip(t) })
      } else if (op === "insert_after") {
        if (whole && !span.khoan) {
          // after a whole section: new block right before the next heading (or at the end)
          const pre = md.slice(0, span.end)
          const lead = pre.endsWith("\n\n") || !pre ? "" : pre.endsWith("\n") ? "\n" : "\n\n"
          md = pre + lead + t + (span.end < md.length ? "\n\n" : "\n") + md.slice(span.end)
        } else if (blockEnd) {
          const sep = isItem(lineAround(md, span.start)) && isItem(t) ? "\n" : "\n\n"
          md = md.slice(0, span.end) + sep + t + md.slice(span.end)
        } else md = md.slice(0, span.end) + text + md.slice(span.end)
        changes.push({ op, target: `sau ${span.label}`, after: clip(t) })
      } else if (op === "insert_before") {
        if (blockStart) {
          const sep = isItem(lineAround(md, span.start)) && isItem(t) ? "\n" : "\n\n"
          md = md.slice(0, span.start) + t + sep + md.slice(span.start)
        } else md = md.slice(0, span.start) + text + md.slice(span.start)
        changes.push({ op, target: `trước ${span.label}`, after: clip(t) })
      }
      if (changes.length > nBefore) changes[changes.length - 1].key = sectionKey(mdBefore, span.start)
    } catch (err: any) {
      if (err instanceof EditError) throw new EditError(err.message.replace(/([.:])?$/, `${where}$1`), err.candidates)
      throw err
    }
  })
  return { markdown: md, changes }
}

const OP_VI: Record<EditOp, string> = { replace: "Sửa", insert_after: "Thêm", insert_before: "Thêm", delete: "Xóa", replace_section: "Viết lại" }
/**
 * One line per group of changes with the same action in the same Điều: identical labels merge into
 * "Sửa Điều 10 khoản 5 (2 chỗ)", several khoản into "Sửa Điều 10 khoản 2, 3, 4", mixed targets (3+) into
 * "Sửa Điều 10 (4 chỗ)". Order = first appearance. (web/server/events.mjs summarizeChanges mirrors this.)
 */
export function changesSummary(changes: Change[] | undefined): string[] {
  // Bilingual documents: changes carry `lang`; the same edit in both columns counts once and the line
  // says which column(s) changed – "(Việt + Anh)", "(bản tiếng Anh)", "(bản tiếng Việt)".
  type G = { head: string; byLang: Map<string, string[]> }
  const groups = new Map<string, G>()
  for (const c of changes ?? []) {
    const verb = OP_VI[c.op] ?? String(c.op)
    const target = String(c.target ?? "").trim()
    const m = target.match(/^((?:sau|trước) )?(Điều \S+)(?: (.+))?$/u)
    const head = m ? `${verb} ${m[1] ?? ""}${m[2]}` : `${verb} ${target}`.trim()
    const g = groups.get(head) ?? { head, byLang: new Map() }
    const lang = c.lang ?? ""
    g.byLang.set(lang, [...(g.byLang.get(lang) ?? []), m ? m[3] ?? "" : ""])
    groups.set(head, g)
  }
  const merged = (g: G) => {
    const lists = [...g.byLang.values()]
    if (lists.length === 1) return lists[0]
    const cnt = new Map<string, number>()
    for (const a of lists) {
      const own = new Map<string, number>()
      for (const x of a) own.set(x, (own.get(x) ?? 0) + 1)
      for (const [k, v] of own) cnt.set(k, Math.max(cnt.get(k) ?? 0, v))
    }
    return [...cnt].flatMap(([k, v]) => new Array(v).fill(k) as string[])
  }
  const langNote = (g: G) => {
    const ls = new Set(g.byLang.keys())
    return ls.has("vi") && ls.has("en") ? " (Việt + Anh)" : ls.has("en") ? " (bản tiếng Anh)" : ls.has("vi") ? " (bản tiếng Việt)" : ""
  }
  const num = (s: string) => s.replace(/^khoản /, "").split(".").map(Number)
  const byNum = (a: string, b: string) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1); return 0 }
  const times = (n: number) => (n > 1 ? ` (${n} chỗ)` : "")
  const all: string[] = []
  for (const g of groups.values()) {
    const { head } = g
    const subs = merged(g)
    const ln = langNote(g)
    const uniq = [...new Set(subs)]
    const count = (u: string) => subs.filter((s) => s === u).length
    if (uniq.length === 1) all.push(`${head}${uniq[0] ? ` ${uniq[0]}` : ""}${times(subs.length)}${ln}`)
    else if (uniq.every((u) => /^khoản [\d.]+$/.test(u))) all.push(`${head} khoản ${uniq.sort(byNum).map((u) => u.replace(/^khoản /, "")).join(", ")}${subs.length > uniq.length ? times(subs.length) : ""}${ln}`)
    else if (uniq.length >= 3) all.push(`${head}${times(subs.length)}${ln}`)
    else for (const u of uniq) all.push(`${head}${u ? ` ${u}` : ""}${times(count(u))}${ln}`)
  }
  const out = all.map((s) => (s.length > 80 ? s.slice(0, 79) + "…" : s))
  return out.length <= 8 ? out : [...out.slice(0, 7), `… và ${out.length - 7} mục thay đổi khác`]
}

// ---------- bilingual documents (Vietnamese | English, two aligned columns) ----------
// A bilingual document is two markdown texts with the SAME heading structure: `markdown` (Vietnamese,
// <base>.md) and `markdown_en` (English, <base>.en.md). Rendering pairs them section by section – every
// heading pair, then every paragraph / khoản / table pair of the section in one row of a borderless
// two-column table (Vietnamese left, English right), the usual layout of Vietnamese bilingual contracts.

/** Rough language of a text: "vi" (Vietnamese diacritics), "en" (English), "?" (numbers / too short). */
export function langOf(s: string): "vi" | "en" | "?" {
  const t = s.replace(/<[^>]+>/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[#*_`>|[\]()\\]/g, " ")
  const letters = (t.match(/\p{L}/gu) ?? []).length
  if (letters < 3) return "?"
  const marks = (t.normalize("NFD").match(/[̀-ͯ]|[đĐ]/gu) ?? []).length
  const ratio = marks / letters
  const words = Math.max(1, (t.match(/\p{L}+/gu) ?? []).length)
  const enWords = (t.match(/\b(the|and|of|shall|to|in|on|this|that|by|with|for|be|is|are|any|party|parties|contract|agreement|article|goods|seller|buyer|behalf)\b/gi) ?? []).length
  if (ratio >= 0.1) return enWords / words > 0.3 ? "en" : "vi"
  if (enWords > 0 || ratio < 0.02) return "en"
  return "?"
}

type Range = [number, number]
type Sect = { head: number | null; body: Range; text?: string; level?: number }
type BiDoc = { lines: string[]; title: number | null; sections: Sect[] }

/** Lines, the "# title" line (only when it is the first non-empty line) and the sections (0 = preamble). */
function biParse(md: string): BiDoc {
  const lines = md.split("\n")
  const hs = headings(md)
  const firstNon = lines.findIndex((l) => l.trim())
  const title = hs.length && hs[0].real && hs[0].level === 1 && hs[0].line - 1 === firstNon ? firstNon : null
  const H = hs.filter((h) => h.line - 1 !== title)
  const sections: Sect[] = [{ head: null, body: [title == null ? 0 : title + 1, H.length ? H[0].line - 1 : lines.length] }]
  H.forEach((h, i) => sections.push({ head: h.line - 1, body: [h.line, i + 1 < H.length ? H[i + 1].line - 1 : lines.length], text: h.text, level: h.level }))
  return { lines, title, sections }
}

/** "Điều 5" / "Article 5" → "5", "Chương II" / "Chapter II" → "ii", "3.2. …" → "3.2"; null when unnumbered. */
function headingNum(text: string): string | null {
  const t = text.replace(/\*\*/g, "").trim()
  const m = t.match(/^(?:điều|article|chương|chapter|mục|section|phần|part|phụ\s+lục|appendix|annex|khoản|clause)\s+([\dIVXLCivxlc]+[a-z]?(?:\.\d+)*)/iu) ?? t.match(/^(\d+(?:\.\d+)*|[IVXLC]+)[.)]\s/u)
  return m ? m[1].toLowerCase() : null
}
const compatible = (a: Sect, b: Sect) => headingNum(a.text ?? "") === headingNum(b.text ?? "")

/** Pair the heading sections of both languages: by position when the counts match, else by LCS on the numbers. */
function alignSections(A: Sect[], B: Sect[]): [Sect | null, Sect | null][] {
  if (A.length === B.length) return A.map((a, i) => [a, B[i]])
  return lcsDiff(A, B, compatible).map((o) => (o.t === "eq" ? [o.a as Sect, o.b as Sect] : o.t === "del" ? [o.a as Sect, null] : [null, o.b as Sect]))
}

/**
 * Structure check for a bilingual pair: same number of headings, same numbering (Điều 5 ↔ Article 5),
 * both or neither with a "# title". Returns human-readable mismatches (empty = OK).
 */
export function checkBilingualStructure(vi: string, en: string): string[] {
  const V = biParse(vi), E = biParse(en)
  const A = V.sections.slice(1), B = E.sections.slice(1)
  const out: string[] = []
  const t = (s: Sect | null | undefined) => (s ? `"${clip(s.text ?? "", 80)}"` : "(không có)")
  if ((V.title == null) !== (E.title == null)) out.push(`Tiêu đề văn bản (# …): ${V.title == null ? "bản tiếng Việt không có, bản tiếng Anh có" : "bản tiếng Việt có, bản tiếng Anh không có"}.`)
  if (A.length !== B.length) {
    out.push(`Số tiêu đề (Điều/Mục) khác nhau: tiếng Việt ${A.length}, tiếng Anh ${B.length}.`)
    for (const [a, b] of alignSections(A, B)) {
      if (a && !b) out.push(`Chỉ có ở bản tiếng Việt: ${t(a)}`)
      else if (b && !a) out.push(`Chỉ có ở bản tiếng Anh: ${t(b)}`)
    }
    const list = (S: Sect[]) => S.map((s) => clip(s.text ?? "", 40)).join(" | ")
    out.push(`Tiêu đề bản tiếng Việt: ${clip(list(A), 900)}`, `Tiêu đề bản tiếng Anh: ${clip(list(B), 900)}`)
  } else A.forEach((a, i) => { if (!compatible(a, B[i])) out.push(`Tiêu đề thứ ${i + 1} không tương ứng: VI ${t(a)} ↔ EN ${t(B[i])}`) })
  return out.length > 25 ? [...out.slice(0, 24), `… và ${out.length - 24} chỗ khác`] : out
}

/** Paragraphs / list items (khoản, điểm) / tables of a section body as line ranges. */
function units(lines: string[], a: number, b: number): Range[] {
  const out: Range[] = []
  let s = -1, inTable = false, fence = false
  const close = (e: number) => {
    if (s >= 0) { let e2 = e; while (e2 > s && !lines[e2 - 1].trim()) e2--; if (e2 > s) out.push([s, e2]) }
    s = -1
  }
  for (let i = a; i < b; i++) {
    const l = lines[i]
    if (/^\s*```/.test(l)) { if (!fence && s < 0) s = i; fence = !fence; continue }
    if (fence) continue
    if (!l.trim()) { close(i); continue }
    const isTable = /^\s*\|/.test(l)
    const itemStart = /^(?:[-*+–—]\s+|\d{1,3}(?:\.\d{1,3})*[.)]\s|[a-zđ]\)\s|(?:\*\*)?(?:khoản|clause|điểm|point)\s+[\w.]+)/iu.test(l)
    if (s < 0) { s = i; inTable = isTable; continue }
    if (isTable !== inTable || (!isTable && itemStart)) { close(i); s = i; inTable = isTable }
  }
  close(b)
  return out
}
const isWideTable = (lines: string[], r: Range | null) =>
  !!r && /^\s*\|/.test(lines[r[0]]) && lines[r[0]].trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).length > 3

type BiRow = { type: "head" | "body" | "stack"; vi: Range | null; en: Range | null }
/** Row layout of a bilingual pair: heading rows + one row per paragraph pair (whole body when the counts differ). */
function biLayout(vi: string, en: string) {
  const V = biParse(vi), E = biParse(en)
  const rows: BiRow[] = []
  const pairs: [Sect | null, Sect | null][] = [[V.sections[0], E.sections[0]], ...alignSections(V.sections.slice(1), E.sections.slice(1))]
  for (const [a, b] of pairs) {
    const ha = a && a.head != null ? ([a.head, a.head + 1] as Range) : null, hb = b && b.head != null ? ([b.head, b.head + 1] as Range) : null
    if (ha || hb) rows.push({ type: "head", vi: ha, en: hb })
    const ua = a ? units(V.lines, ...a.body) : [], ub = b ? units(E.lines, ...b.body) : []
    if (!ua.length && !ub.length) continue
    if (ua.length === ub.length) ua.forEach((r, i) => rows.push({ type: isWideTable(V.lines, r) || isWideTable(E.lines, ub[i]) ? "stack" : "body", vi: r, en: ub[i] }))
    else rows.push({ type: "body", vi: ua.length ? [ua[0][0], ua[ua.length - 1][1]] : null, en: ub.length ? [ub[0][0], ub[ub.length - 1][1]] : null })
  }
  return { V, E, rows }
}
const frag = (lines: string[], r: Range | null) => (r ? lines.slice(r[0], r[1]).join("\n") : "")
const titleOf = (D: BiDoc) => (D.title == null ? "" : D.lines[D.title].replace(/^#\s+/, "").replace(/\s+#+\s*$/, "").trim())

/** Key of the section containing `pos` (same for "Điều 5" and "Article 5") – pairs edits across languages. */
function sectionKey(md: string, pos: number) {
  const D = biParse(md)
  const lineIdx = md.slice(0, pos).split("\n").length - 1
  if (D.title != null && lineIdx === D.title) return "title"
  let k = 0
  for (let i = 1; i < D.sections.length; i++) if ((D.sections[i].head as number) <= lineIdx) k = i
  if (!k) return "pre"
  const num = headingNum(D.sections[k].text ?? "")
  return num ? `n:${num}` : `i:${k}`
}

const BI_CSS = `
.qh .en { font-size: 12pt; font-weight: normal; } .bt { margin: 6pt 0 14pt; } .bt h1 { margin: 0 0 2pt; } .bt h1.en { font-style: italic; font-size: 14pt; }
table.bi { table-layout: fixed; width: 100%; border-collapse: collapse; margin: 0; }
table.bi > tbody > tr > td { border: none; padding: 0 8pt 0 0; width: 50%; vertical-align: top; font-size: 12pt; }
table.bi > tbody > tr > td.en { padding: 0 0 0 8pt; }
table.bi > tbody > tr.stack > td { padding: 0; } table.bi > tbody > tr.stack .en { margin-top: 4pt; } table.bi > tbody > tr.stack, table.bi > tbody > tr.long { break-inside: auto; } table.bi > tbody > tr.head { break-after: avoid; page-break-after: avoid; }
table.bi ol, table.bi ul { margin: 0 0 6pt; padding-left: 18pt; } table.bi td > :last-child { margin-bottom: 6pt; }
table.bi p, table.bi li { font-size: 12pt; } table.bi h2, table.bi h3 { font-size: 12pt; margin: 10pt 0 4pt; }
table.bi table th, table.bi table td { border: 1px solid #000; font-size: 11pt; padding: 3pt 4pt; width: auto; }
`

/** Bilingual annexes: the i-th Vietnamese annex paired with the i-th English one. */
function biAnnexPairs(vi: string | null, en: string | null): [string, string][] {
  if (vi == null && en == null) return []
  const a = annexChunks(vi ?? ""), b = annexChunks(en ?? "")
  return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i] ?? "", b[i] ?? ""] as [string, string])
}
function biTableHtml(vi: string, en: string) {
  const { V, E, rows } = biLayout(vi, en)
  const cell = (md: string) => (md.trim() ? (marked.parse(md) as string) : "&nbsp;")
  return `<table class="bi"><tbody>\n${rows.map((r) => {
    const a = cell(frag(V.lines, r.vi)), b = cell(frag(E.lines, r.en))
    return r.type === "stack"
      ? `<tr class="stack"><td colspan="2"><div class="vi" lang="vi">${a}</div><div class="en" lang="en">${b}</div></td></tr>`
      : `<tr class="${r.type}${Math.max(textLen(V.lines, r.vi), textLen(E.lines, r.en)) >= 1400 ? " long" : ""}"><td class="vi" lang="vi">${a}</td><td class="en" lang="en">${b}</td></tr>`
  }).join("\n")}\n</tbody></table>`
}

export function toBilingualHtml(title: string, viAll: string, enAll: string, kind: string, sign?: [string, string] | null, signEn?: [string, string] | null, header?: boolean) {
  const sv = splitAnnexes(viAll), se = splitAnnexes(enAll)
  const vi = sv.main, en = se.main
  const annexes = biAnnexPairs(sv.annex, se.annex).map(([a, b]) => `<section class="annex">${biTableHtml(a, b)}</section>`).join("")
  const { V, E, rows } = biLayout(vi, en)
  const tv = titleOf(V), te = titleOf(E)
  const titles = tv || te ? `<div class="bt">${tv ? `<h1>${marked.parseInline(tv)}</h1>` : ""}${te ? `<h1 class="en">${marked.parseInline(te)}</h1>` : ""}</div>` : ""
  const cell = (md: string) => (md.trim() ? (marked.parse(md) as string) : "&nbsp;")
  const trs = rows.map((r) => {
    const a = cell(frag(V.lines, r.vi)), b = cell(frag(E.lines, r.en))
    return r.type === "stack"
      ? `<tr class="stack"><td colspan="2"><div class="vi" lang="vi">${a}</div><div class="en" lang="en">${b}</div></td></tr>`
      : `<tr class="${r.type}${Math.max(textLen(V.lines, r.vi), textLen(E.lines, r.en)) >= 1400 ? " long" : ""}"><td class="vi" lang="vi">${a}</td><td class="en" lang="en">${b}</td></tr>`
  }).join("\n")
  const body = `${(header ?? kind === "hop-dong") ? nationalHeaderHtml("bilingual") : ""}${titles}<table class="bi"><tbody>\n${trs}\n</tbody></table>${signatureHtml(signCols("bilingual", sign, signEn))}${annexes}`
  return htmlPage(title, "vi", BI_CSS, body)
}

// docx: content width = A4 11906 − margins 1701 − 1134 = 9071 twips
const FULL_W = 9071, COL_W = 4535
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER }
function biCell(children: (Paragraph | Table)[], width: number, left: number, right: number, span?: number) {
  const kids = children.length && !(children[children.length - 1] instanceof Table) ? children : [...children, new Paragraph({ children: [] })]
  return new TableCell({ children: kids, width: { size: width, type: WidthType.DXA }, borders: NO_BORDERS, margins: { left, right, top: 0, bottom: 0 }, ...(span ? { columnSpan: span } : {}) })
}
const textLen = (lines: string[], r: Range | null) => (r ? frag(lines, r).length : 0)
/** The borderless two-column table; small rows may not split across pages, heading rows stay with the next row. */
function biTable(rows: BiRow[], V: BiDoc, E: BiDoc, cells: (r: BiRow, i: number) => [(Paragraph | Table)[], (Paragraph | Table)[]]) {
  return new Table({
    width: { size: FULL_W, type: WidthType.DXA },
    columnWidths: [COL_W, FULL_W - COL_W],
    layout: TableLayoutType.FIXED,
    borders: { ...NO_BORDERS, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
    rows: rows.map((r, i) => {
      const [a, b] = cells(r, i)
      const small = Math.max(textLen(V.lines, r.vi), textLen(E.lines, r.en)) < 1400
      return new TableRow({
        cantSplit: r.type === "head" || small,
        children: r.type === "stack" ? [biCell([...a, ...b], FULL_W, 0, 0, 2)] : [biCell(a, COL_W, 0, 170), biCell(b, FULL_W - COL_W, 170, 0)],
      })
    }),
  })
}
const cellBlocks = (lines: string[], r: Range | null) => (r ? blocks(marked.lexer(frag(lines, r))) : [])
function biTitles(V: BiDoc, E: BiDoc) {
  const tv = titleOf(V), te = titleOf(E)
  const p = (t: string, en: boolean) => new Paragraph({
    heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, keepNext: true,
    children: textRuns(inlineRuns(marked.Lexer.lexInline(t)), { bold: true, italics: en, size: en ? 28 : 30, allCaps: true }),
    spacing: { before: en ? 0 : 120, after: en || !te ? 240 : 40 },
  })
  return [...(tv ? [p(tv, false)] : []), ...(te ? [p(te, true)] : [])]
}

export async function toBilingualDocx(title: string, viAll: string, enAll: string, kind: string, sign?: [string, string] | null, signEn?: [string, string] | null, header?: boolean) {
  BODY = 24 // 12 pt in two columns
  try {
    const sv = splitAnnexes(viAll), se = splitAnnexes(enAll)
    const { V, E, rows } = biLayout(sv.main, se.main)
    const body = [...biTitles(V, E), biTable(rows, V, E, (r) => [cellBlocks(V.lines, r.vi), cellBlocks(E.lines, r.en)])]
    const tail = biAnnexPairs(sv.annex, se.annex).flatMap(([a, b]) => {
      const L = biLayout(a, b)
      return [pageBreak(), biTable(L.rows, L.V, L.E, (r) => [cellBlocks(L.V.lines, r.vi), cellBlocks(L.E.lines, r.en)])]
    })
    return wrapDocx(title, body, (header ?? kind === "hop-dong") ? "bilingual" : null, signCols("bilingual", sign, signEn), tail)
  } finally {
    BODY = SIZE
  }
}

/** Redline of a bilingual pair: the same two-column table, tracked changes inside the respective column cells. */
export async function toBilingualRedlineDocx(title: string, oldViAll: string, oldEnAll: string, newViAll: string, newEnAll: string, kind: string, sign?: [string, string] | null, signEn?: [string, string] | null, header?: boolean, note?: string) {
  BODY = 24
  try {
    const ctx = newCtx()
    const ov = splitAnnexes(oldViAll), oe = splitAnnexes(oldEnAll), nv = splitAnnexes(newViAll), ne = splitAnnexes(newEnAll)
    const oldVi = ov.main, oldEn = oe.main, newVi = nv.main, newEn = ne.main
    // annexes (after the signature block, new page): tracked changes of the Vietnamese then the English annex text
    const hasAnnex = [ov, oe, nv, ne].some((x) => x.annex != null)
    const annexTail = hasAnnex ? [pageBreak(), ...redlineBody(ctx, lineDiff(ov.annex ?? "", nv.annex ?? "")), pageBreak(), ...redlineBody(ctx, lineDiff(oe.annex ?? "", ne.annex ?? ""))] : []
    const { V, E, rows } = biLayout(newVi, newEn)
    // every new line (and every deletion, via its next new line) belongs to a row: its own, else the next one
    const owners = (D: BiDoc, side: "vi" | "en") => {
      const n = D.lines.length
      const cover = new Array<number | undefined>(n + 1)
      rows.forEach((r, k) => { const rg = r[side]; if (rg) for (let i = rg[0]; i < rg[1]; i++) cover[i] = k })
      if (D.title != null) cover[D.title] = -1
      let last = rows.length - 1
      while (last >= 0 && !rows[last][side]) last--
      const own = new Array<number>(n + 1)
      let next = last
      for (let i = n; i >= 0; i--) { if (cover[i] != null) next = cover[i] as number; own[i] = cover[i] ?? next }
      return own
    }
    const group = (D: BiDoc, side: "vi" | "en", items: { it: LineItem; j: number }[]) => {
      const own = owners(D, side)
      const g = new Map<number, LineItem[]>()
      for (const x of items) { const k = own[Math.min(x.j, own.length - 1)] ?? -1; g.set(k, [...(g.get(k) ?? []), x.it]) }
      return g
    }
    const gv = group(V, "vi", lineDiffIndexed(oldVi, newVi)), ge = group(E, "en", lineDiffIndexed(oldEn, newEn))
    const titleBlocks = [...redlineBody(ctx, gv.get(-1) ?? []), ...redlineBody(ctx, ge.get(-1) ?? [])]
    const table = biTable(rows, V, E, (_r, k) => [redlineBody(ctx, gv.get(k) ?? []), redlineBody(ctx, ge.get(k) ?? [])])
    const body = [
      redlineNote(note ?? "Bản theo dõi thay đổi (Track Changes) – mở bằng Microsoft Word, tab Review để chấp nhận / từ chối từng thay đổi."),
      ...titleBlocks, table,
    ]
    return wrapDocx(`${title} – thay đổi`, body, (header ?? kind === "hop-dong") ? "bilingual" : null, signCols("bilingual", sign, signEn), annexTail)
  } finally {
    BODY = SIZE
  }
}

// ---- language clause of bilingual contracts ----
const LANG_CLAUSE_VI_RE = /tiếng\s+Việt\s+và\s+tiếng\s+Anh|tiếng\s+Anh\s+và\s+tiếng\s+Việt|(?:bản|văn\s+bản)\s+tiếng\s+(?:Việt|Anh)\s+(?:sẽ\s+)?(?:được\s+)?ưu\s+tiên/iu
const LANG_CLAUSE_EN_RE = /\b(?:Vietnamese\s+and\s+English|English\s+and\s+Vietnamese)\b|\b(?:Vietnamese|English)\s+(?:version|text|language)\s+shall\s+prevail/i
export const languageClause = (prevailing: "vi" | "en" = "vi") => ({
  vi: `Hợp đồng này được lập bằng tiếng Việt và tiếng Anh, có giá trị pháp lý như nhau. Trường hợp có sự khác biệt giữa hai bản, bản tiếng ${prevailing === "en" ? "Anh" : "Việt"} được ưu tiên áp dụng.`,
  en: `This Contract is made in Vietnamese and English, both versions having equal legal validity. In case of any discrepancy between the two versions, the ${prevailing === "en" ? "English" : "Vietnamese"} version shall prevail.`,
})
export const hasLanguageClause = (vi: string, en: string) => LANG_CLAUSE_VI_RE.test(vi) || LANG_CLAUSE_EN_RE.test(en)

/**
 * Bilingual contracts: add the language clause pair (equal validity, which version prevails) at the end of
 * the general / final provisions (else the last Điều) of both texts, numbered like the khoản around it –
 * unless either text already has a language clause.
 */
export function ensureLanguageClause(vi: string, en: string, prevailing: "vi" | "en" = "vi"): { vi: string; en: string; added: boolean; label?: string } {
  if (hasLanguageClause(vi, en)) return { vi, en, added: false }
  // annexes after the signature block: the clause belongs to the main contract
  const sv = splitAnnexes(vi), se = splitAnnexes(en)
  if (sv.annex != null || se.annex != null) {
    const r = ensureLanguageClause(sv.main, se.main, prevailing)
    const join = (main: string, annex: string | null) => (annex == null ? main : `${main.trimEnd()}\n\n${ANNEX_MARKER}\n\n${annex}`)
    return { ...r, vi: join(r.vi, sv.annex), en: join(r.en, se.annex) }
  }
  const clause = languageClause(prevailing)
  const V = biParse(vi), E = biParse(en)
  const A = V.sections.slice(1), B = E.sections.slice(1)
  let idx = -1
  if (A.length && A.length === B.length) {
    const GEN = /dieu khoan chung|quy dinh chung|dieu khoan cuoi|dieu khoan thi hanh|hieu luc|general provisions|final provisions|miscellaneous|general terms|entry into force|effectiveness/
    for (let i = A.length - 1; i >= 0 && idx < 0; i--) if (GEN.test(normKey(A[i].text ?? "")) || GEN.test(normKey(B[i].text ?? ""))) idx = i
    if (idx < 0) idx = A.length - 1
  }
  const add = (D: BiDoc, S: Sect[], text: string) => {
    const lines = [...D.lines]
    let from = 0, end = lines.length
    if (idx >= 0) {
      const s = S[idx]
      from = (s.head as number) + 1
      const nxt = S.slice(idx + 1).find((x) => (x.level ?? 9) <= (s.level ?? 9))
      end = nxt ? (nxt.head as number) : lines.length
    }
    let last = end - 1
    while (last >= from && !lines[last].trim()) last--
    let numbered: string | null = null
    for (let i = last; i >= from; i--) {
      const m = lines[i].match(/^(\s*(?:[-*+–—]\s+)?(?:\*\*)?(?:(?:khoản|clause)\s+)?)(\d{1,3}(?:\.\d{1,3})*)(\s*[.)])(?!\d)/iu)
      if (m && !/^\s*\|/.test(lines[i])) {
        const p = m[2].split(".")
        p[p.length - 1] = String(Number(p[p.length - 1]) + 1)
        numbered = `${m[1].replace(/\*\*/g, "")}${p.join(".")}${m[3]} ${text}`
        break
      }
    }
    const lastIsItem = last >= from && /^\s*(?:[-*+–—]\s+|\d{1,3}(?:\.\d{1,3})*[.)]\s)/.test(lines[last])
    const ins = numbered ? (lastIsItem ? [numbered] : ["", numbered]) : ["", text]
    if (last < from && idx >= 0) lines.splice(from, 0, "", text)
    else lines.splice(last + 1, 0, ...ins)
    return lines.join("\n").replace(/^\n+/, "")
  }
  return { vi: add(V, A, clause.vi), en: add(E, B, clause.en), added: true, label: idx >= 0 ? shortLabel(A[idx].text ?? "") : "cuối văn bản" }
}

/** English signature label for a Vietnamese one: "ĐẠI DIỆN BÊN A (BÊN BÁN)" → "FOR AND ON BEHALF OF PARTY A (THE SELLER)". */
export function enSignLabel(label: string, i: 0 | 1): string {
  const n = normKey(label)
  const letter = n.match(/\bben ([a-z])\b/)?.[1]
  const ROLES: [RegExp, string][] = [[/ben giao dai ly/, "PRINCIPAL"], [/ben dai ly/, "AGENT"], [/ben ban/, "SELLER"], [/ben mua/, "BUYER"], [/ben cung (?:ung|cap)/, "SERVICE PROVIDER"], [/ben (?:su dung|thue) dich vu/, "CUSTOMER"], [/ben phan phoi/, "DISTRIBUTOR"], [/ben (?:nhan )?van chuyen/, "CARRIER"], [/ben thue/, "LESSEE"], [/ben cho thue/, "LESSOR"]]
  const role = ROLES.find(([re]) => re.test(n))?.[1]
  if (letter) return `FOR AND ON BEHALF OF PARTY ${letter.toUpperCase()}${role ? ` (THE ${role})` : ""}`
  if (role) return `FOR AND ON BEHALF OF THE ${role}`
  return `FOR AND ON BEHALF OF PARTY ${i ? "B" : "A"}`
}

// ---- edits on bilingual documents ----
const squash = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim()
const contains = (md: string, find: string) => !!find.trim() && squash(md).includes(squash(find))

/** Section of the other language matching `section` of `from` (by name, else by position in the aligned structure). */
export function findCounterpart(vi: string, en: string, section: string, from: "vi" | "en"): Span {
  const [src, dst] = from === "vi" ? [vi, en] : [en, vi]
  try {
    return findSection(dst, section)
  } catch (e) {
    if (!(e instanceof EditError) || !/^Không tìm thấy mục/.test(e.message)) throw e
  }
  const s = findSection(src, section)
  const S = biParse(src), D = biParse(dst)
  const pair = alignSections(S.sections.slice(1), D.sections.slice(1)).find(([a]) => a && s.heading && a.head === s.heading.line - 1)
  if (!pair || !pair[1]) throw new EditError(`Không tìm thấy mục tương ứng với "${section}" trong bản ${from === "vi" ? "tiếng Anh" : "tiếng Việt"}.`)
  return findSection(dst, pair[1].text as string)
}

/**
 * Apply edits to a bilingual pair. Each edit targets `lang`: "vi" (find/section/text on the Vietnamese
 * text), "en" (find/text – or find_en/text_en – on the English text), "both" (find+text on Vietnamese,
 * find_en+text_en on English; a `section` applies to both). Without `lang`: find_en/text_en → both, a `find`
 * found only in the English text → en, delete by section → both, else vi. All-or-nothing (EditError).
 * Returns warnings (not errors) when a section was changed in one language only, or when the heading
 * structures no longer match.
 */
export type Pending = { lang: "vi" | "en"; key: string; label: string }
export function applyBilingualEdits(vi: string, en: string, edits: Edit[], pending: Pending[] = []): { vi: string; en: string; changes: Change[]; warnings: string[]; pending: Pending[] } {
  if (!edits?.length) throw new EditError("Không có thay đổi nào (edits rỗng).")
  let V = vi, E = en
  const changes: Change[] = []
  edits.forEach((e, n) => {
    const where = edits.length > 1 ? ` (thay đổi #${n + 1})` : ""
    let lang = e.lang
    if (!lang) lang = e.find_en != null || e.text_en != null ? "both" : e.find ? (contains(V, e.find) ? "vi" : contains(E, e.find) ? "en" : "vi") : e.op === "delete" ? "both" : "vi"
    if (lang === "both") {
      if (e.find && !e.find_en) throw new EditError(`lang="both" với \`find\` cần thêm \`find_en\` (đoạn tiếng Anh tương ứng, nguyên văn)${where}.`)
      if (!e.find && !e.section) throw new EditError(`${e.op} cần \`find\` hoặc \`section\`${where}.`)
      if (e.op !== "delete" && e.text_en == null) throw new EditError(`lang="both" cần \`text_en\` (nội dung tiếng Anh tương ứng)${where}.`)
    }
    const run = (side: "vi" | "en", ed: Edit) => {
      const cur = side === "vi" ? V : E
      let sec = ed.section
      if (sec && side === "en" && !ed.find) {
        try { sec = findCounterpart(V, E, sec, "vi").heading?.text ?? sec } catch (err) { if (!(err instanceof EditError)) throw err }
        if (sec !== ed.section && /\b(khoản|clause|điểm|point)\b/i.test(ed.section as string)) sec = ed.section // keep khoản queries as written
      }
      try {
        const r = applyEdits(cur, [{ op: ed.op, find: ed.find, section: ed.find ? undefined : sec, text: ed.text }])
        for (const c of r.changes) changes.push({ ...c, lang: side })
        if (side === "vi") V = r.markdown; else E = r.markdown
      } catch (err: any) {
        if (err instanceof EditError) throw new EditError(`${err.message.replace(/[.:]$/, "")} – bản tiếng ${side === "vi" ? "Việt" : "Anh"}${where}${/:$/.test(err.message) ? ":" : "."}`, err.candidates)
        throw err
      }
    }
    if (lang === "vi" || lang === "both") run("vi", { op: e.op, find: e.find, section: e.section, text: e.text })
    if (lang === "en") run("en", { op: e.op, find: e.find_en ?? e.find, section: e.section, text: e.text_en ?? e.text })
    if (lang === "both") run("en", { op: e.op, find: e.find_en, section: e.section, text: e.text_en })
  })
  // One-language changes stay "pending" (kept in the version metadata) until the counterpart section of
  // the other language is edited too – possibly in a later call.
  const warnings: string[] = []
  let open: Pending[] = [...pending]
  for (const c of changes) {
    const other = c.lang === "vi" ? "en" : "vi"
    const hit = open.findIndex((p) => p.lang === other && p.key === c.key)
    if (hit >= 0) open.splice(hit, 1)
    else if (!open.some((p) => p.lang === c.lang && p.key === c.key) && !changes.some((x) => x.lang === other && x.key === c.key))
      open.push({ lang: c.lang as "vi" | "en", key: String(c.key), label: c.target.replace(/^(sau|trước) /, "") })
  }
  const labelsOf = (side: "vi" | "en") => [...new Set(open.filter((p) => p.lang === side).map((p) => p.label))]
  const onlyVi = labelsOf("vi"), onlyEn = labelsOf("en")
  if (onlyVi.length) warnings.push(`CẢNH BÁO song ngữ: đã sửa bản tiếng Việt ở ${onlyVi.join(", ")} nhưng CHƯA sửa phần tiếng Anh tương ứng. Hãy cập nhật bản tiếng Anh (document_edit với lang="en", hoặc lang="both" kèm find_en/text_en) để hai cột khớp nhau.`)
  if (onlyEn.length) warnings.push(`CẢNH BÁO song ngữ: đã sửa bản tiếng Anh ở ${onlyEn.join(", ")} nhưng CHƯA sửa phần tiếng Việt tương ứng. Hãy cập nhật bản tiếng Việt (document_edit với lang="vi") để hai cột khớp nhau.`)
  const mism = checkBilingualStructure(V, E)
  if (mism.length) warnings.push(`CẢNH BÁO song ngữ: cấu trúc tiêu đề hai bản không còn khớp (hai cột sẽ lệch):\n${mism.slice(0, 6).map((m) => `  - ${m}`).join("\n")}`)
  return { vi: V, en: E, changes, warnings, pending: open }
}

/** Aligned sections of a bilingual pair for document_read: 1-based line ranges in each text. */
export function bilingualOutline(vi: string, en: string) {
  const V = biParse(vi), E = biParse(en)
  const span = (D: BiDoc, s: Sect | null, first: boolean) => {
    if (!s) return null
    const a = first ? 0 : (s.head as number), b = s.body[1]
    return { from: a + 1, to: b, text: D.lines.slice(a, b).join("\n").replace(/\s+$/, ""), heading: s.text ?? null }
  }
  const pairs: [Sect | null, Sect | null][] = [[V.sections[0], E.sections[0]], ...alignSections(V.sections.slice(1), E.sections.slice(1))]
  return pairs.map(([a, b], i) => ({ label: i === 0 ? "Phần mở đầu" : shortLabel((a ?? b)?.text ?? ""), vi: span(V, a, i === 0), en: span(E, b, i === 0) }))
}

// ---- uploads laid out bilingually ----
const NH1_EN = /^SOCIALIST\s+REPUBLIC\s+OF\s+VIET\s?NAM$/i
const NH2_EN = /^INDEPENDENCE\s*[-–—]\s*FREEDOM\s*[-–—]\s*HAPPINESS$/i
const EN_SIGN_LABEL = /^(?:FOR\s+AND\s+ON\s+BEHALF\s+OF\b.*|ON\s+BEHALF\s+OF\b.*|(?:REPRESENTATIVE\s+OF\s+)?PARTY\s+[A-Z](?:\s*\([^)]*\))?|THE\s+(?:SELLER|BUYER))$/
const isHeaderLine = (p: string) => NH1.test(p) || NH2.test(p) || NH1_EN.test(p) || NH2_EN.test(p) || SEP_LINE.test(p)

/** Markdown of one table cell produced by the upload extractor (blocks joined with <br>, nested tables escaped). */
function cellMd(c: string) {
  const parts = c.replace(/\\\|/g, "|").split(/<br\s*\/?>/i).map((s) => s.trim()).filter(Boolean)
  // table lines stay together, except where a new table starts (its header row is followed by | --- |)
  const newTable = (k: number) => k + 1 < parts.length && isTableSep(parts[k + 1]) && !isTableSep(parts[k])
  return parts.map((p, k) => (k ? (/^\|/.test(p) && /^\|/.test(parts[k - 1]) && !newTable(k) ? "\n" : "\n\n") : "") + p).join("")
}
const cellsOfRow = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim())

/**
 * Detect an uploaded bilingual document – a two-column Vietnamese | English table (as the upload extractor
 * renders .docx tables), or alternating Vietnamese / English paragraphs – and split it into the two texts.
 * Returns null unless confident (enough VN|EN pairs AND the two texts end up with the same heading structure).
 */
export function detectBilingual(markdown: string): { vi: string; en: string; nationalHeader: boolean; sign: [string, string] | null; signEn: [string, string] | null } | null {
  const L = markdown.replace(/\r\n?/g, "\n").split("\n")
  return biFromTable(L) ?? biFromAlternating(L)
}

function finishBi(viParts: string[], enParts: string[], header: boolean, sign: [string, string] | null, signEn: [string, string] | null) {
  const nv = normalizeImported(viParts.join("\n\n")), ne = normalizeImported(enParts.join("\n\n"))
  if (!nv.markdown.trim() || !ne.markdown.trim()) return null
  if (checkBilingualStructure(nv.markdown, ne.markdown).length) return null
  return { vi: nv.markdown, en: ne.markdown, nationalHeader: header || nv.nationalHeader || ne.nationalHeader, sign: sign ?? nv.sign, signEn: signEn ?? ne.sign }
}

function biFromTable(L: string[]) {
  const tables: Range[] = []
  for (let i = 0; i < L.length; i++) if (/^\s*\|/.test(L[i])) { let j = i; while (j < L.length && /^\s*\|/.test(L[j])) j++; tables.push([i, j]); i = j - 1 }
  let best: { t: Range; rows: string[][]; good: number } | null = null
  for (const t of tables) {
    const rows = L.slice(t[0], t[1]).filter((l) => !isTableSep(l)).map(cellsOfRow)
    if (rows.length < 3 || !rows.every((r) => r.length === 2)) continue
    let good = 0, bad = 0
    for (const r of rows) {
      const a = langOf(cellMd(r[0])), b = langOf(cellMd(r[1]))
      if (a === "vi" && b === "en") good++
      else if (a !== "?" && b !== "?") bad++
    }
    if (good >= 3 && good >= 0.7 * (good + bad) && (!best || good > best.good)) best = { t, rows, good }
  }
  if (!best) return null
  const vi: string[] = [], en: string[] = []
  let header = false
  const side = (text: string) => {
    const l = langOf(text)
    if (l === "en") en.push(text)
    else if (l === "vi") vi.push(text)
    else { vi.push(text); en.push(text) }
  }
  // before the table: national header (VN/EN lines), titles, loose paragraphs
  for (let i = 0; i < best.t[0]; i++) {
    const p = plainLine(L[i])
    if (!p) continue
    if (isHeaderLine(p)) { header = header || !SEP_LINE.test(p); continue }
    const hm = L[i].match(/^\s*(#{1,6})\s/)
    side(hm ? `${hm[1]} ${p}` : L[i].trim()) // "# ***SALES CONTRACT***" → "# SALES CONTRACT"
  }
  for (const r of best.rows) {
    const a = cellMd(r[0]), b = cellMd(r[1])
    if (a && b) { vi.push(a); en.push(b); continue }
    // full-width row (tables stacked VN then EN): split its blocks by language
    for (const blk of (a || b).split(/\n\n+/)) if (blk.trim()) side(blk)
  }
  // after the table: bilingual signature table, loose paragraphs
  let sign: [string, string] | null = null, signEn: [string, string] | null = null
  const rest = L.slice(best.t[1])
  const st = rest.findIndex((l) => /^\s*\|/.test(l))
  if (st >= 0) {
    let se = st
    while (se < rest.length && /^\s*\|/.test(rest[se])) se++
    const rows = rest.slice(st, se).filter((l) => !isTableSep(l)).map(cellsOfRow)
    const head = rows[0]
    if (head?.length === 2 && rows.length <= 3) {
      const parts = (c: string) => c.split(/<br\s*\/?>/i).map(plainLine).filter(Boolean)
      const lv = head.map((c) => parts(c).find((x) => SIGN_LABEL.test(x)))
      const le = head.map((c) => parts(c).find((x) => EN_SIGN_LABEL.test(x)))
      if (lv[0] && lv[1]) sign = [lv[0], lv[1]]
      if (le[0] && le[1]) signEn = [le[0], le[1]]
      if (sign || signEn) rest.splice(st, se - st)
    }
  }
  for (const l of rest) if (l.trim()) side(l.trim())
  return finishBi(vi, en, header, sign, signEn)
}

function biFromAlternating(L: string[]) {
  const blocksMd = L.join("\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  let header = false
  const body = blocksMd.filter((b) => {
    const ls = b.split("\n").map(plainLine)
    if (ls.every((p) => isHeaderLine(p))) { header = true; return false }
    return true
  })
  const cls = body.map((b) => langOf(b))
  const known = cls.filter((c) => c !== "?").length
  let pairs = 0
  for (let k = 0; k + 1 < cls.length; k++) if (cls[k] === "vi" && cls[k + 1] === "en") { pairs++; k++ }
  if (pairs < 3 || 2 * pairs < 0.8 * known) return null
  const vi = body.filter((_, k) => cls[k] !== "en"), en = body.filter((_, k) => cls[k] !== "vi")
  return finishBi(vi, en, header, null, null)
}

// ---------- store ----------
/** Backward compatibility: metas written before versioning are version 1 of themselves. */
export function normalizeMeta(m: any, folderSession?: string): DocMeta {
  return {
    ...m,
    sessionID: folderSession ?? m.sessionID,
    version: Number.isInteger(m.version) && m.version > 0 ? m.version : 1,
    root_id: m.root_id ?? m.id,
    parent_id: m.parent_id ?? null,
    origin: m.origin === "upload" ? "upload" : "agent",
    changes: Array.isArray(m.changes) ? m.changes : [],
    language: m.language === "en" || m.language === "bilingual" ? m.language : "vi",
    ...(m.language === "bilingual" ? { prevailing: m.prevailing === "en" ? "en" : "vi" } : {}),
  }
}

/** Find a document's metadata inside the given sessions' output folders only. */
export function findDocument(sessionIDs: string[], id: string): DocMeta | null {
  if (typeof id !== "string" || !ID_RE.test(id)) return null
  for (const sid of sessionIDs ?? []) {
    if (!sid) continue
    const dir = outDir(sid)
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    const metaName = names.find((n) => n.endsWith(`-${id}.json`))
    if (!metaName) continue
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, metaName), "utf8"))
      if (meta.id === id) return normalizeMeta(meta, sid)
    } catch {}
  }
  return null
}

/** The stored markdown of a document. */
export function readMarkdown(meta: DocMeta): string {
  const name = String(meta.markdown ?? "")
  if (!name || /[\\/]|\.\./.test(name)) throw new Error("tài liệu không có nội dung markdown")
  return fs.readFileSync(path.join(outDir(meta.sessionID), name), "utf8")
}

/** The stored English markdown of a bilingual document. */
export function readMarkdownEn(meta: DocMeta): string {
  const name = String(meta.markdown_en ?? "")
  if (!name || /[\\/]|\.\./.test(name)) throw new Error("tài liệu không có bản tiếng Anh")
  return fs.readFileSync(path.join(outDir(meta.sessionID), name), "utf8")
}

/** All session folders under the outputs root (for fork lookups). */
export function listSessionFolders(): string[] {
  try { return fs.readdirSync(outputsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
}

/**
 * Look a document up for a tool call in `sessionID`: its own folder first; other folders only when the
 * id is part of this session's evidence (source "artifact", e.g. inherited from a forked session).
 */
export function findDocumentForSession(sessionID: string, id: string): DocMeta | null {
  const own = findDocument([sessionID], id)
  if (own) return own
  const ev = loadEvidence(sessionID).filter((e) => e.source === "artifact" && (e.url === `artifact://${id}` || (e.meta as any)?.id === id))
  if (!ev.length) return null
  const hinted = ev.map((e) => (e.meta as any)?.sessionID).filter((s): s is string => typeof s === "string")
  return findDocument([...new Set([...hinted, ...listSessionFolders()])], id)
}

export function artifactDescriptor(meta: DocMeta) {
  return {
    id: meta.id, title: meta.title, kind: meta.kind, files: meta.files, preview: meta.preview, markdown: meta.markdown,
    version: meta.version, root_id: meta.root_id, parent_id: meta.parent_id, origin: meta.origin,
    changes_summary: changesSummary(meta.changes),
    language: meta.language ?? "vi",
    ...(meta.language === "bilingual" ? { prevailing: meta.prevailing ?? "vi", markdown_en: meta.markdown_en } : {}),
    ...(meta.ocr ? { ocr: meta.ocr } : {}),
  }
}
export const artifactMarker = (meta: DocMeta) => `[[artifact:${JSON.stringify(artifactDescriptor(meta))}]]`

export type SaveInput = {
  sessionID: string
  title: string
  markdown: string
  kind: DocKind
  formats?: ("docx" | "pdf")[]
  sign?: [string, string] | null
  parent?: DocMeta | null
  changes?: Change[]
  origin: "agent" | "upload"
  originalFile?: string
  nationalHeader?: boolean
  note?: string
  /** default "vi"; "bilingual" needs markdownEn (same heading structure as markdown) */
  language?: DocLang
  markdownEn?: string
  prevailing?: "vi" | "en"
  signEn?: [string, string] | null
  /** bilingual: one-language changes whose counterpart is not edited yet */
  pending?: Pending[]
  /** OCR'd scan: { engine, pages, totalPages }; default = the parent's (kept across document_edit versions); null = clear */
  ocr?: OcrDocMeta | null
}

/** Write a new version: md + html (+ docx / pdf, + redline docx when `parent` is given) + json. */
export async function saveDocument(input: SaveInput): Promise<DocMeta> {
  const { sessionID, title, kind, parent } = input
  const sid = sessionID || "no-session"
  const dir = outDir(sid)
  fs.mkdirSync(dir, { recursive: true })
  const id = newId()
  const base = `${slugify(title)}-${id}`
  const sign = input.sign ?? null
  const header = input.nationalHeader ?? (input.origin === "upload" ? false : kind === "hop-dong")
  const want = input.formats?.length ? input.formats : ["docx", "pdf"]
  const files: DocFile[] = []
  const lang: DocLang = input.language === "en" || input.language === "bilingual" ? input.language : "vi"
  const bi = lang === "bilingual"
  const one: "vi" | "en" = lang === "en" ? "en" : "vi"
  const signEn = bi ? input.signEn ?? (sign ? [enSignLabel(sign[0], 0), enSignLabel(sign[1], 1)] as [string, string] : null) : null
  const prevailing: "vi" | "en" = input.prevailing === "en" ? "en" : "vi"
  const ocr = input.ocr === null ? null : ocrDocMeta(input.ocr) ?? ocrDocMeta(parent?.ocr)
  const md = input.markdown.normalize("NFC").trim() + "\n"
  fs.writeFileSync(path.join(dir, `${base}.md`), md)
  const mdEn = bi ? String(input.markdownEn ?? "").normalize("NFC").trim() + "\n" : ""
  if (bi) fs.writeFileSync(path.join(dir, `${base}.en.md`), mdEn)
  const html = bi ? toBilingualHtml(title, md, mdEn, kind, sign, signEn, header) : toHtml(title, md, kind, sign, header, one)
  fs.writeFileSync(path.join(dir, `${base}.html`), html) // preview source for the web UI
  if (want.includes("docx")) {
    const buf = bi ? await toBilingualDocx(title, md, mdEn, kind, sign, signEn, header) : await toDocx(title, md, kind, sign, header, one)
    fs.writeFileSync(path.join(dir, `${base}.docx`), buf)
    files.push({ name: `${base}.docx`, format: "docx", bytes: buf.length })
  }
  let pdfError = false
  if (want.includes("pdf")) {
    try {
      const buf = await toPdf(html)
      fs.writeFileSync(path.join(dir, `${base}.pdf`), buf)
      files.push({ name: `${base}.pdf`, format: "pdf", bytes: buf.length })
    } catch {
      pdfError = true
    }
  }
  if (parent) {
    try {
      const oldMd = readMarkdown(parent)
      const v = (parent.version ?? 1) + 1
      const note = `Bản theo dõi thay đổi: phiên bản ${v} so với phiên bản ${parent.version ?? 1} (mã ${parent.id}). Mở bằng Microsoft Word, tab Review để chấp nhận / từ chối từng thay đổi.`
        + (lang === "vi" ? "" : ` / Tracked changes: version ${v} against version ${parent.version ?? 1} – open in Microsoft Word, Review tab, to accept or reject each change.`)
      const buf = bi && parent.language === "bilingual"
        ? await toBilingualRedlineDocx(title, oldMd, readMarkdownEn(parent), md, mdEn, kind, sign, signEn, header, note)
        : await toRedlineDocx(title, oldMd, md, kind, sign, header, note, one)
      fs.writeFileSync(path.join(dir, `${base}.thay-doi.docx`), buf)
      files.push({ name: `${base}.thay-doi.docx`, format: "redline", bytes: buf.length })
    } catch {
      /* redline is a convenience – never block the new version */
    }
  }
  let original: string | null = null
  if (input.originalFile) {
    const ext = (path.extname(input.originalFile).replace(/[^\w.]/g, "") || ".bin").toLowerCase()
    original = `${base}.original${ext}`
    fs.copyFileSync(input.originalFile, path.join(dir, original))
  }
  const meta: DocMeta = {
    id, title, kind, files, preview: `${base}.html`, markdown: `${base}.md`, sessionID: sid, createdAt: new Date().toISOString(),
    version: parent ? (parent.version ?? 1) + 1 : 1,
    root_id: parent ? parent.root_id ?? parent.id : id,
    parent_id: parent ? parent.id : null,
    origin: input.origin,
    changes: (input.changes ?? []).map((c) => ({ op: c.op, target: c.target, ...(c.lang && bi ? { lang: c.lang } : {}), ...(c.before != null ? { before: clip(c.before) } : {}), ...(c.after != null ? { after: clip(c.after) } : {}) })),
    sign, national_header: header,
    language: lang,
    ...(bi ? { prevailing, markdown_en: `${base}.en.md`, sign_en: signEn } : {}),
    ...(bi && input.pending?.length ? { bilingual_pending: input.pending } : {}),
    ...(input.changes?.length ? { changes_summary: changesSummary(input.changes) } : {}), // read by the web server
    ...(input.note ? { note: input.note } : {}),
    ...(original ? { original } : {}),
    ...(pdfError ? { pdf_error: true } : {}),
    ...(ocr ? { ocr } : {}),
  }
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(meta, null, 2))
  recordEvidence(sid, { url: `artifact://${id}`, title, text: bi ? `${md}\n${mdEn}` : md, source: "artifact", meta: { ...artifactDescriptor(meta), sessionID: sid, ...(ocr ? { ocr: true, engine: ocr.engine, ocr_pages: ocr.pages, total_pages: ocr.totalPages } : {}) } })
  return meta
}

export type ImportInput = { sessionID: string; title: string; markdown: string; kind?: DocKind; originalPath?: string; formats?: ("docx" | "pdf")[]; ocr?: OcrDocMeta | null }

// ---------- import normalisation ----------
const NH1 = /^C[ỘO]NG\s+H[ÒOÓ]A\s+X[ÃA]\s+H[ỘO]I\s+CH[ỦU]\s+NGH[ĨI]A\s+VI[ỆE]T\s+NAM$/iu
const NH2 = /^Đ[ỘO]C\s+L[ẬA]P\s*[-–—]\s*T[ỰU]\s+DO\s*[-–—]\s*H[ẠA]NH\s+PH[ÚU]C$/iu
const SEP_LINE = /^\s*[-_–—=~.*·]{2,}\s*(?:o0o|oOo|000)?\s*[-_–—=~.*·]*\s*$/u
const DIEU_LINE = /^(?:Điều|Article)\s+\d+[a-zđ]?\s*(?:[.:\-–)]|$)/iu
const CHUONG_LINE = /^(?:Chương|Chapter)\s+(?:[IVXLC]+|\d+)\b/iu
const PHAN_LINE = /^(?:Phần|Part)\s+(?:thứ\s+\S+|[IVXLC]+|\d+)\b/iu
const SIGN_LABEL = /^(?:ĐẠI\s+DIỆN\s.*|BÊN\s+\p{Lu}+(?:\s+\p{Lu}+)?(?:\s*\([^)]*\))?|FOR\s+AND\s+ON\s+BEHALF\s+OF\s.*|PARTY\s+[A-Z](?:\s*\([^)]*\))?)$/u
const SIGN_NOTE = /^\(\s*(?:Ký|Signature|Sign)(?=[\s,.;)])[^)]*\)?$/iu
/** Line text without heading hashes, a trailing hard break and markers wrapping the whole line. */
const plainLine = (l: string) => {
  let s = l.trim().replace(/^#{1,6}\s+/, "").replace(/\s*\\$/, "").trim()
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/^(\*\*|__|\*|_)(.+)\1$/su, "$2").replace(/^<u>(.*)<\/u>$/su, "$1").trim() }
  return s
}
const isUpper = (s: string) => /\p{L}/u.test(s) && s === s.toLocaleUpperCase("vi")

/**
 * Promote the structure of an imported (plain / converted) text to markdown without changing its words:
 * Quốc hiệu – Tiêu ngữ at the top → `nationalHeader` (rendered like document_create's), the document
 * title → "#", "Phần/Chương …" → "##", "Điều N." → "##" (or "###" under Chương), a trailing
 * "ĐẠI DIỆN BÊN A / ĐẠI DIỆN BÊN B" block → `sign`. Idempotent: its output normalises to itself.
 */
export function normalizeImported(markdown: string): { markdown: string; nationalHeader: boolean; sign: [string, string] | null } {
  const L = markdown.replace(/\r\n?/g, "\n").split("\n")
  const drop = new Set<number>()
  const nonEmpty = (from: number) => { let i = from; while (i < L.length && !L[i].trim()) i++; return i }
  // 1. Quốc hiệu – Tiêu ngữ (only as the very first lines)
  let nationalHeader = false
  // Vietnamese, English ("SOCIALIST REPUBLIC OF VIETNAM / Independence – Freedom – Happiness") or both
  const i0 = nonEmpty(0)
  if (i0 < L.length && (NH1.test(plainLine(L[i0])) || NH1_EN.test(plainLine(L[i0])))) {
    const top: number[] = []
    for (let i = i0; i < L.length && top.length < 4; i = nonEmpty(i + 1)) {
      const p = plainLine(L[i])
      if (!(NH1.test(p) || NH2.test(p) || NH1_EN.test(p) || NH2_EN.test(p))) break
      top.push(i)
    }
    if (top.some((i) => NH2.test(plainLine(L[i])) || NH2_EN.test(plainLine(L[i])))) {
      nationalHeader = true
      for (let i = i0; i <= top[top.length - 1]; i++) drop.add(i)
      const i2 = nonEmpty(top[top.length - 1] + 1)
      if (i2 < L.length && SEP_LINE.test(L[i2])) drop.add(i2)
    }
  }
  // 2. structural lines
  let fence = false
  const cand: { i: number; type: "phan" | "chuong" | "dieu" }[] = []
  let firstStruct = L.length
  for (let i = 0; i < L.length; i++) {
    if (drop.has(i)) continue
    const line = L[i]
    if (/^\s*```/.test(line)) { fence = !fence; continue }
    if (fence || /^\s*([|>]|[-*+]\s|\d+[.)]\s)/.test(line) || /^\s{4,}/.test(line)) continue
    const p = plainLine(line)
    if (!p || p.length > 200) continue
    const prev = i > 0 ? L[i - 1].trim() : ""
    const standalone = /^#{1,6}\s/.test(line) || !prev || drop.has(i - 1) || /^#{1,6}\s/.test(prev) || /[.:;!?…)\]"”]$/.test(prev)
    if (!standalone) continue
    const type = DIEU_LINE.test(p) ? "dieu" : CHUONG_LINE.test(p) && p.length <= 150 ? "chuong" : PHAN_LINE.test(p) && p.length <= 150 ? "phan" : null
    if (type) { cand.push({ i, type }); firstStruct = Math.min(firstStruct, i) }
  }
  const hasPhan = cand.some((c) => c.type === "phan"), hasChuong = cand.some((c) => c.type === "chuong")
  const level = { phan: 2, chuong: hasPhan ? 3 : 2, dieu: Math.min(4, 2 + (hasPhan ? 1 : 0) + (hasChuong ? 1 : 0)) }
  const out = [...L]
  for (const c of cand) out[c.i] = `${"#".repeat(level[c.type])} ${plainLine(L[c.i])}`
  // 3. title: the first all-caps line before the first Điều/Chương, unless the text already has one
  const structural = (p: string) => DIEU_LINE.test(p) || CHUONG_LINE.test(p) || PHAN_LINE.test(p)
  if (!L.some((l) => /^#\s/.test(l) && !structural(plainLine(l)))) {
    let seen = 0
    for (let i = 0; i < firstStruct && seen < 12; i++) {
      if (drop.has(i) || !L[i].trim()) continue
      seen++
      if (/^\s*([|>]|[-*+–]\s|\d+[.)]\s|#)/.test(L[i])) continue
      const p = plainLine(L[i])
      if (p.length >= 4 && p.length <= 160 && isUpper(p) && !p.includes(":") && !/^(SỐ|ĐẠI DIỆN|BÊN|NO\.|FOR AND ON BEHALF|PARTY)(?=\s|:|$)/u.test(p) && !NH1.test(p) && !NH2.test(p) && !NH1_EN.test(p) && !NH2_EN.test(p)) {
        out[i] = `# ${p}`
        break
      }
    }
  }
  // 4. signature block at the very end: paragraphs (label, "(Ký …)", label, "(Ký …)") or a 2-column table
  let sign: [string, string] | null = null
  const tail: number[] = []
  for (let i = L.length - 1; i >= 0 && tail.length < 8; i--) if (L[i].trim() && !drop.has(i)) tail.unshift(i)
  const cellsOf = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim())
  const lastTable: number[] = []
  for (let k = tail.length - 1; k >= 0 && /^\s*\|/.test(L[tail[k]]); k--) lastTable.unshift(tail[k])
  if (lastTable.length && lastTable.length <= 4 && !/^\s*\|/.test(L[lastTable[0] - 1] ?? "")) {
    const rows = lastTable.map((i) => L[i]).filter((l) => !isTableSep(l)).map(cellsOf)
    const parts = (c: string) => c.split(/<br\s*\/?>/i).map(plainLine).filter(Boolean)
    const head = rows[0]
    if (head?.length === 2 && head.every((c) => SIGN_LABEL.test(parts(c)[0] ?? ""))) {
      const rest = [...head.flatMap((c) => parts(c).slice(1)), ...rows.slice(1).flat().flatMap(parts)]
      if (rest.every((s) => SIGN_NOTE.test(s))) {
        sign = [parts(head[0])[0], parts(head[1])[0]]
        lastTable.forEach((i) => drop.add(i))
      }
    }
  }
  if (!sign) {
    const labels = tail.filter((i) => SIGN_LABEL.test(plainLine(L[i])) && plainLine(L[i]).length <= 80)
    if (labels.length >= 2) {
      const [a, b] = labels.slice(-2)
      const block = tail.filter((i) => i >= a)
      if (block.every((i) => i === a || i === b || SIGN_NOTE.test(plainLine(L[i])))) {
        sign = [plainLine(L[a]), plainLine(L[b])]
        for (let i = a; i < L.length; i++) drop.add(i)
      }
    }
  }
  const md = out.filter((_, i) => !drop.has(i)).join("\n").replace(/^\s*\n/, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n"
  return { markdown: md, nationalHeader, sign }
}

/** Register an uploaded document (already converted to markdown) as version 1 so it can be edited. */
export async function importDocument(input: ImportInput): Promise<DocMeta> {
  const src = input.markdown.normalize("NFC")
  const kindOf = (md: string): DocKind => input.kind ?? (/h[ợo]p\s+đ[ồo]ng|contract/i.test(`${input.title}\n${md.slice(0, 600)}`) ? "hop-dong" : "van-ban")
  // a bilingual layout (VN | EN table, or alternating VN / EN paragraphs) is imported as a bilingual document
  const bi = detectBilingual(src)
  if (bi) {
    const prevailing = /bản\s+tiếng\s+Anh\s+(?:sẽ\s+)?(?:được\s+)?ưu\s+tiên/iu.test(bi.vi) || /English\s+(?:version|text)\s+shall\s+prevail/i.test(bi.en) ? "en" : "vi"
    return saveDocument({
      sessionID: input.sessionID, title: input.title, markdown: bi.vi, markdownEn: bi.en, language: "bilingual", prevailing,
      kind: kindOf(bi.vi), formats: input.formats, origin: "upload", originalFile: input.originalPath,
      nationalHeader: bi.nationalHeader, sign: bi.sign, signEn: bi.signEn, ocr: input.ocr,
    })
  }
  const n = normalizeImported(src)
  // an English-only upload keeps English header / signature notes
  const paras = n.markdown.split(/\n\s*\n/).map(langOf)
  const en = paras.filter((l) => l === "en").length, vi = paras.filter((l) => l === "vi").length
  const language: DocLang = en >= 3 && en >= 4 * vi ? "en" : "vi"
  return saveDocument({
    sessionID: input.sessionID, title: input.title, markdown: n.markdown, kind: kindOf(n.markdown), formats: input.formats,
    origin: "upload", originalFile: input.originalPath, nationalHeader: n.nationalHeader, sign: n.sign, language, ocr: input.ocr,
  })
}

/** Section outline of a document (for document_read). */
export function outline(md: string) {
  return headings(md).map((h) => ({ line: h.line, level: h.level, text: h.text, label: shortLabel(h.text) }))
}
