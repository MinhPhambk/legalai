// vanban.chinhphu.vn tools (Hệ thống văn bản – Cổng TTĐT Chính phủ) for the legal agent. Pages load through the
// sandbox Chrome; the full text of a document is its attached signed PDF on datafiles.chinhphu.vn, which is almost
// always a SCAN (no text layer) → OCR with Chrome's PDF OCR (../lib/pdf-ocr.ts), labelled as OCR everywhere.
// Most useful for very new documents (laws / decrees of the last months) that vbpl.vn does not have yet.
//   chinhphu_search          – search by keyword / số hiệu (the site's own search form; optional year filter)
//   chinhphu_document        – attributes (số ký hiệu, loại, cơ quan, ngày ban hành, người ký, trích yếu) + attachments
//                              + article list of the full text
//   chinhphu_article         – text of one article ("Điều N") from the attached PDF (OCR-labelled when scanned)
//   chinhphu_search_articles – articles of one document containing keywords
//   chinhphu_verify          – check that a quoted passage appears in the document's full text
// The site shows NO "tình trạng hiệu lực": the tools say so, and the agent checks validity on vbpl.vn when it can.
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import puppeteer from "puppeteer-core"
import { recordEvidence } from "../lib/evidence.ts"
import { polite } from "../lib/polite.ts"
import { ocrPdf, ocrMeta, ocrUi, OCR_LABEL, OCR_WARNING } from "../lib/pdf-ocr.ts"
import { count, isoDate, withUi } from "../lib/ui-meta.ts"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

const PORT = process.env.CHROME_PORT ?? "9333"
const HOST = "vanban.chinhphu.vn"
const BASE = `https://${HOST}/`
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const CACHE = path.join(process.env.XDG_CACHE_HOME ?? path.join(ROOT, ".sandbox", "cache"), "legalai", "chinhphu")
const POLITE = { concurrency: 1, gapMs: 1500 }
const SOURCE = "vanban.chinhphu.vn"
const NO_STATUS = "Tình trạng hiệu lực: trang vanban.chinhphu.vn KHÔNG ghi tình trạng hiệu lực – kiểm tra trên vbpl.vn (vbpl_find → vbpl_document) nếu văn bản đã có ở đó; nếu chưa có, nói rõ là chưa xác minh được tình trạng hiệu lực."

const today = () => new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const page = await browser.newPage()
  try {
    return await fn(page)
  } finally {
    await page.close().catch(() => {})
    browser.disconnect()
  }
}

/** Canonical detail link https://vanban.chinhphu.vn/?pageid=27160&docid=N (accepts any link carrying docid=N). */
function assertDoc(url: string) {
  let u: URL
  try { u = new URL(url.trim()) } catch { throw new Error("Link không hợp lệ – dùng link chinhphu_search trả về (https://vanban.chinhphu.vn/?pageid=27160&docid=...)") }
  const docid = u.searchParams.get("docid")
  if (!/(^|\.)vanban\.chinhphu\.vn$/.test(u.hostname) || !docid || !/^\d+$/.test(docid)) throw new Error("Chỉ nhận link trang chi tiết văn bản dạng https://vanban.chinhphu.vn/?pageid=27160&docid=...")
  return { href: `${BASE}?pageid=27160&docid=${docid}`, docid }
}

// ------------------------------------------------------------------ search
type Hit = { number: string; date: string; summary: string; url: string; files: number }

async function siteSearch(query: string, year?: number): Promise<Hit[]> {
  return polite(HOST, () => withPage(async (page) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 })
    await page.waitForSelector('input[name$="txtSearchKeyword"]', { timeout: 20000 })
    await page.select('select[name$="drdRecordPerPage"]', "50").catch(() => {})
    if (year) await page.select('select[name$="drdDocYear"]', String(year)).catch(() => {})
    await page.type('input[name$="txtSearchKeyword"]', query)
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }), page.click('input[name$="btnSearch"]')])
    await sleep(1500)
    return page.evaluate(() => {
      const out: { number: string; date: string; summary: string; url: string; files: number }[] = []
      const seen = new Set<string>()
      for (const a of document.querySelectorAll('a[href*="docid="]')) {
        const tr = a.closest("tr")
        const href = (a as HTMLAnchorElement).href
        if (!tr || seen.has(href)) continue
        const cells = [...tr.querySelectorAll("td")].map((td) => (td as HTMLElement).innerText.replace(/\s+/g, " ").trim())
        const date = cells.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c))
        if (!date || cells.length > 6) continue // layout tables, sidebars
        seen.add(href)
        const rest = cells.filter((c) => c && c !== date && !/^Tài liệu đính kèm$/.test(c))
        out.push({ number: rest[0] ?? "", date, summary: rest.slice(1).join(" ").replace(/\s*Tài liệu đính kèm\s*$/, ""), url: href, files: tr.querySelectorAll('a[href*="datafiles"]').length })
      }
      return out
    })
  }), POLITE)
}

// Vietnamese text → ascii tokens for loose matching of the query against số hiệu / trích yếu.
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase()

export const search = tool({
  description: "Tìm văn bản trên vanban.chinhphu.vn (Hệ thống văn bản – Cổng TTĐT Chính phủ: luật, nghị định, quyết định, thông tư, nghị quyết… kể cả văn bản RẤT MỚI mà vbpl.vn chưa có) theo từ khóa trong trích yếu hoặc SỐ HIỆU (VD 'Luật Thương mại điện tử', '122/2025/QH15', 'nghị định thương mại điện tử'). Có thể lọc theo năm ban hành. Trả về số hiệu, ngày ban hành, trích yếu và link chi tiết thật – dùng link này với chinhphu_document / chinhphu_article, không tự đoán link.",
  args: {
    query: tool.schema.string().describe("Từ khóa trích yếu hoặc số hiệu văn bản"),
    year: tool.schema.number().optional().describe("Năm ban hành (VD 2025) để lọc"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa (mặc định 10)"),
  },
  async execute({ query, year, limit }, context) {
    const hits = await siteSearch(query.trim(), year)
    // Exact số hiệu first, then the site's own order (newest first).
    const q = fold(query).replace(/\s+/g, "")
    const ranked = [...hits].sort((a, b) => Number(fold(b.number).replace(/\s+/g, "") === q) - Number(fold(a.number).replace(/\s+/g, "") === q)).slice(0, limit ?? 10)
    if (!ranked.length) return withUi(`Không tìm thấy văn bản khớp "${query}"${year ? ` (năm ${year})` : ""} trên vanban.chinhphu.vn. Thử từ khóa ngắn hơn, số hiệu, hoặc bỏ lọc năm.`, { res: count(0, "docs") })
    const text = ranked.map((h, i) => `${i + 1}. ${h.number} – ngày ${h.date} – ${h.summary}${h.files ? "" : " (không có tệp đính kèm)"}\n   ${h.url}`).join("\n")
    recordEvidence(context?.sessionID, { url: `${BASE}#search=${encodeURIComponent(query)}`, title: `Tìm kiếm vanban.chinhphu.vn: ${query}`, text, source: SOURCE })
    return withUi(`${text}\n(nguồn: vanban.chinhphu.vn, tra ngày ${today()}${hits.length > ranked.length ? `; còn ${hits.length - ranked.length} kết quả khác` : ""})`, { res: count(ranked.length, "docs") })
  },
})

// ------------------------------------------------------------------ document page + attachments
type DocPage = { url: string; title: string; attrs: Record<string, string>; files: { name: string; url: string }[] }
const ATTRS = ["Số ký hiệu", "Ngày ban hành", "Loại văn bản", "Cơ quan ban hành", "Người ký", "Trích yếu"]
const PAGE_TTL_MS = 30 * 60 * 1000
const pageCache = new Map<string, { at: number; doc: DocPage }>()

async function openDoc(href: string): Promise<DocPage> {
  const hit = pageCache.get(href)
  if (hit && Date.now() - hit.at < PAGE_TTL_MS) return hit.doc
  const doc = await polite(HOST, () => withPage(async (page) => {
    const res = await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 })
    if ((res?.status() ?? 0) >= 400) throw new Error(`HTTP ${res?.status()} – không mở được ${href}`)
    await page.waitForFunction(() => document.body.innerText.includes("Số ký hiệu"), { timeout: 20000 }).catch(() => {})
    return page.evaluate((labels: string[]) => {
      const attrs: Record<string, string> = {}
      for (const tr of document.querySelectorAll("tr")) {
        const tds = [...tr.querySelectorAll("td, th")].map((c) => (c as HTMLElement).innerText.replace(/\s+/g, " ").trim())
        if (tds.length >= 2 && labels.includes(tds[0]) && !(tds[0] in attrs)) attrs[tds[0]] = tds[1]
      }
      const files = [...document.querySelectorAll('a[href*="datafiles.chinhphu.vn"]')].map((a) => ({ name: (a as HTMLElement).innerText.trim() || (a as HTMLAnchorElement).href.split("/").pop()!, url: (a as HTMLAnchorElement).href }))
      const heading = [...document.querySelectorAll("h1, h2, .title, .doc-title, span, div")].map((e) => (e as HTMLElement).innerText?.trim() ?? "").find((t) => /^(Luật|Bộ luật|Nghị định|Nghị quyết|Quyết định|Thông tư|Pháp lệnh|Lệnh|Chỉ thị|Công điện|Văn bản|Hiến pháp|Thông báo|Công văn)\b.{10,300}$/.test(t) && !t.includes("\n")) ?? ""
      return { title: heading || document.title, attrs, files: files.filter((f, i) => files.findIndex((g) => g.url === f.url) === i) }
    }, ATTRS)
  }), POLITE)
  if (!Object.keys(doc.attrs).length) throw new Error(`Trang ${href} không có thông tin văn bản (docid sai hoặc văn bản đã gỡ). Dùng chinhphu_search để lấy link đúng.`)
  const out = { url: href, ...doc }
  pageCache.set(href, { at: Date.now(), doc: out })
  return out
}

// ------------------------------------------------------------------ full text (PDF text layer, else Chrome OCR)
type FullText = { text: string; pages: number; ocr: boolean; ocrMeta?: Record<string, unknown>; ocrUi?: Record<string, unknown>; file: { name: string; url: string }; warning?: string }
const textCache = new Map<string, FullText>()

let pdfjsLib: any
async function pdfjs() {
  if (pdfjsLib !== undefined) return pdfjsLib
  for (const c of ["pdfjs-dist/legacy/build/pdf.mjs", pathToFileURL(path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")).href]) {
    try { pdfjsLib = await import(c); return pdfjsLib } catch {}
  }
  pdfjsLib = null
  return null
}

async function downloadPdf(url: string): Promise<Buffer> {
  fs.mkdirSync(CACHE, { recursive: true })
  const file = path.join(CACHE, crypto.createHash("sha1").update(url).digest("hex") + ".pdf")
  if (fs.existsSync(file)) return fs.readFileSync(file)
  const u = new URL(url)
  if (u.hostname !== "datafiles.chinhphu.vn") throw new Error("tệp đính kèm không nằm trên datafiles.chinhphu.vn")
  const buf = await polite(u.hostname, async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!r.ok) throw new Error(`không tải được tệp đính kèm (HTTP ${r.status})`)
    const b = Buffer.from(await r.arrayBuffer())
    if (b.length > 40 * 1024 * 1024) throw new Error("tệp đính kèm quá lớn (> 40 MB)")
    return b
  }, POLITE)
  if (buf.subarray(0, 5).toString() !== "%PDF-") throw new Error("tệp đính kèm không phải PDF")
  fs.writeFileSync(file, buf)
  return buf
}

async function fullText(doc: DocPage): Promise<FullText> {
  const file = doc.files.find((f) => /\.pdf(\b|$)/i.test(f.url)) ?? doc.files[0]
  if (!file) throw new Error(`Văn bản ${doc.attrs["Số ký hiệu"] ?? doc.url} không có tệp đính kèm – chỉ có thuộc tính.`)
  const hit = textCache.get(file.url)
  if (hit) return hit
  if (!/\.pdf(\b|$)/i.test(file.url)) throw new Error(`Tệp đính kèm không phải PDF (${file.name}) – mở bằng web_read(${file.url}).`)
  const bytes = await downloadPdf(file.url)
  const lib = await pdfjs()
  if (!lib) throw new Error("máy chưa có thư viện pdf.js (pdfjs-dist)")
  const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, verbosity: 0 })
  const pdf = await task.promise
  const pages = pdf.numPages
  let text = ""
  for (let p = 1; p <= Math.min(pages, 400); p++) {
    const c = await (await pdf.getPage(p)).getTextContent()
    text += c.items.map((i: any) => i.str + (i.hasEOL ? "\n" : "")).join("") + "\n"
  }
  await Promise.resolve(task.destroy?.()).catch(() => {})
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()
  let out: FullText
  if (text.length >= pages * 200) out = { text, pages, ocr: false, file }
  else {
    // Signed scans (the usual case on this site): OCR every page – long laws are ~1.6 s/page with 2 OCR Chromes, cached by sha256.
    const max = Math.min(pages, Number(process.env.ND45_CHINHPHU_OCR_MAX_PAGES ?? 150))
    const r = await ocrPdf(bytes, { maxPages: max, timeoutMs: 15 * 60_000 })
    out = { text: r.pages.map((p) => p.text).join("\n"), pages, ocr: true, ocrMeta: ocrMeta(r), ocrUi: ocrUi(r), file, warning: max < pages ? `Chỉ OCR ${max}/${pages} trang đầu.` : undefined }
  }
  textCache.set(file.url, out)
  return out
}

// Articles: "Điều 3. Giải thích từ ngữ" … up to the next heading. Wrapped cross-references also start lines
// ("Điều 15 của Luật này;"), so a heading needs "." / ":" after the number and an increasing number; OCR sometimes
// drops the dot, so a dot-less line is accepted only as the NEXT number with a capitalised title.
const ARTICLE_RE = /^Điều\s+(\d+)([a-zđ]?)\s*([.:]?)\s+(.*)$/
function splitArticles(text: string) {
  const lines = text.split("\n")
  const arts: { no: string; heading: string; start: number; end: number }[] = []
  let prev = 0
  lines.forEach((l, idx) => {
    const m = l.trim().match(ARTICLE_RE)
    if (!m) return
    const n = Number(m[1]), title = m[4].trim()
    const ok = m[3] ? n > prev || (n === prev && !!m[2]) : n === prev + 1 && /^[A-ZĐÀ-Ỹ]/u.test(title)
    if (!ok) return
    if (arts.length) arts[arts.length - 1].end = idx
    arts.push({ no: m[1] + m[2], heading: title, start: idx, end: lines.length })
    prev = n
  })
  return { lines, arts }
}
const norm = (s: string) => s.normalize("NFC").replace(/[“”"«»]/g, '"').replace(/[‘’']/g, "'").replace(/\s+/g, " ").trim().toLowerCase()

function evidence(context: any, doc: DocPage, ft?: FullText) {
  const title = `${doc.attrs["Số ký hiệu"] ?? ""} ${doc.attrs["Trích yếu"] ?? doc.title}`.trim()
  recordEvidence(context?.sessionID, { url: doc.url, title, text: [doc.title, ...ATTRS.filter((k) => doc.attrs[k]).map((k) => `${k}: ${doc.attrs[k]}`)].join("\n"), source: SOURCE, meta: { official: true } })
  if (ft) recordEvidence(context?.sessionID, { url: ft.file.url, title, text: ft.text, source: SOURCE, meta: { official: true, ...(ft.ocr ? ft.ocrMeta : {}) } })
}
const docUi = (doc: DocPage) => ({ title: doc.title, lang: "vi", number: doc.attrs["Số ký hiệu"], issued: isoDate(doc.attrs["Ngày ban hành"]?.replace(/-/g, "/")), agency: doc.attrs["Cơ quan ban hành"], accessed: isoDate(today()), url: doc.url })
const header = (doc: DocPage) => [`Văn bản: ${doc.title}`, `Link: ${doc.url}`, ...ATTRS.filter((k) => doc.attrs[k]).map((k) => `${k}: ${doc.attrs[k]}`), NO_STATUS, `Ngày tra cứu: ${today()}`]
const ocrNote = (ft: FullText) => (ft.ocr ? [OCR_WARNING, OCR_LABEL] : [])

export const document = tool({
  description: "Mở một văn bản trên vanban.chinhphu.vn (link từ chinhphu_search) và trả về thuộc tính: số ký hiệu, ngày ban hành, loại văn bản, cơ quan ban hành, người ký, trích yếu, tệp đính kèm, cùng danh sách các Điều trong toàn văn (đọc từ PDF đính kèm; bản scan được OCR – lần đầu có thể mất 1–2 phút với văn bản dài). Trang này KHÔNG có tình trạng hiệu lực.",
  args: {
    url: tool.schema.string().describe("Link https://vanban.chinhphu.vn/?pageid=27160&docid=..."),
    max_articles: tool.schema.number().optional().describe("Số điều tối đa liệt kê (mặc định 300)"),
  },
  async execute({ url, max_articles }, context) {
    const { href } = assertDoc(url)
    const doc = await openDoc(href)
    let ft: FullText | undefined, why = ""
    try { ft = await fullText(doc) } catch (e: any) { why = String(e?.message ?? e).slice(0, 300) }
    evidence(context, doc, ft)
    const arts = ft ? splitArticles(ft.text).arts : []
    const list = arts.slice(0, max_articles ?? 300).map((a) => `Điều ${a.no}. ${a.heading}`.slice(0, 120))
    return withUi([
      ...header(doc),
      `Tệp đính kèm: ${doc.files.map((f) => `${f.name} (${f.url})`).join("; ") || "không có"}`,
      ft ? `Toàn văn: ${ft.pages} trang${ft.ocr ? " – bản scan, đã OCR" : ""}${ft.warning ? ` (${ft.warning})` : ""}` : `Toàn văn: không đọc được (${why})`,
      ...(ft ? ocrNote(ft).slice(0, 1) : []),
      ft ? `Số điều: ${arts.length}${arts.length > list.length ? ` (liệt kê ${list.length} điều đầu)` : ""}` : "",
      list.join("\n"),
    ].filter(Boolean).join("\n"), { doc: docUi(doc), ...(ft?.ocr ? ft.ocrUi : {}) })
  },
})

export const article = tool({
  description: "Lấy nội dung MỘT điều (VD article='12' hoặc 'Điều 12') của văn bản trên vanban.chinhphu.vn, từ PDF đính kèm, kèm số hiệu, trích yếu, link và ngày tra cứu. Bản scan được OCR và GẮN NHÃN OCR – trích dẫn nguyên văn phải nói rõ là văn bản nhận dạng OCR (có thể sai dấu); nếu văn bản đã có trên vbpl.vn thì ưu tiên trích từ vbpl_article.",
  args: {
    url: tool.schema.string().describe("Link https://vanban.chinhphu.vn/?pageid=27160&docid=..."),
    article: tool.schema.string().describe("Số điều, VD '12', '4a' hoặc 'Điều 12'"),
  },
  async execute({ url, article }, context) {
    const { href } = assertDoc(url)
    const no = article.replace(/^\s*điều\s*/i, "").replace(/[.\s]+$/, "").trim()
    const doc = await openDoc(href)
    const ft = await fullText(doc)
    evidence(context, doc, ft)
    const { lines, arts } = splitArticles(ft.text)
    const hit = arts.filter((a) => a.no.toLowerCase() === no.toLowerCase())
    if (!hit.length) return `Không tìm thấy "Điều ${no}" trong ${doc.title} (${href}). Toàn văn có ${arts.length} điều${ft.ocr ? " (bản OCR – số điều có thể bị nhận dạng sai)" : ""}; dùng chinhphu_document để xem danh sách.`
    const parts = hit.map((a) => lines.slice(a.start, a.end).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000))
    return withUi([
      ...header(doc),
      `Tệp nguồn: ${ft.file.url}`,
      ...ocrNote(ft),
      hit.length > 1 ? `Lưu ý: có ${hit.length} đoạn mang số "Điều ${no}".` : "",
      ft.ocr ? "--- NỘI DUNG (OCR) ---" : "--- NGUYÊN VĂN ---",
      parts.join("\n\n--- (đoạn khác cùng số điều) ---\n\n"),
    ].filter(Boolean).join("\n"), { res: { t: "title", v: hit[0].heading, lang: "vi" }, article: { n: hit[0].no, title: hit[0].heading, lang: "vi" }, doc: docUi(doc), ...(ft.ocr ? ft.ocrUi : {}) })
  },
})

export const search_articles = tool({
  description: "Tìm trong MỘT văn bản trên vanban.chinhphu.vn các Điều có chứa từ khóa (trong tên điều hoặc nội dung), VD keywords='nền tảng trung gian'. Trả về số điều, tên điều và đoạn chứa từ khóa. Dùng trước chinhphu_article để chọn đúng điều.",
  args: {
    url: tool.schema.string().describe("Link https://vanban.chinhphu.vn/?pageid=27160&docid=..."),
    keywords: tool.schema.string().describe("Từ khóa tiếng Việt"),
    limit: tool.schema.number().optional().describe("Số điều tối đa (mặc định 8)"),
  },
  async execute({ url, keywords, limit }, context) {
    const { href } = assertDoc(url)
    const doc = await openDoc(href)
    const ft = await fullText(doc)
    evidence(context, doc, ft)
    const { lines, arts } = splitArticles(ft.text)
    const phrase = norm(keywords)
    const words = phrase.split(" ").filter((w) => w.length > 1)
    const scored = arts.map((a) => {
      const heading = norm(a.heading)
      const body = norm(lines.slice(a.start, a.end).join(" "))
      let score = 0
      if (heading.includes(phrase)) score += 10
      else if (words.every((w) => heading.includes(w))) score += 6
      const hits = body.split(phrase).length - 1
      score += Math.min(hits, 5) * 2
      if (!hits && words.every((w) => body.includes(w))) score += 1
      const at = body.indexOf(phrase)
      return { a, score, snippet: at >= 0 ? body.slice(Math.max(0, at - 120), at + 200) : body.slice(0, 200) }
    }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score).slice(0, limit ?? 8)
    if (!scored.length) return withUi(`Không có điều nào trong ${doc.title} chứa "${keywords}"${ft.ocr ? " (bản OCR – thử từ khóa khác hoặc ít từ hơn)" : ""}.`, { res: count(0, "articles") })
    return withUi([`Văn bản: ${doc.title}`, `Link: ${href}`, ...(ft.ocr ? [OCR_LABEL] : []), `Các điều liên quan tới "${keywords}":`,
      ...scored.map((x) => `- Điều ${x.a.no}. ${x.a.heading}\n  …${x.snippet}…`),
      `Tiếp theo: gọi chinhphu_article(url, "<số điều>").`].join("\n"), { res: count(scored.length, "articles") })
  },
})

export const verify = tool({
  description: "Kiểm tra một đoạn trích có thật sự xuất hiện trong toàn văn của văn bản trên vanban.chinhphu.vn không (so khớp sau khi chuẩn hóa khoảng trắng, dấu nháy, chữ hoa/thường). Với bản scan, so trên văn bản OCR.",
  args: {
    url: tool.schema.string().describe("Link https://vanban.chinhphu.vn/?pageid=27160&docid=..."),
    quote: tool.schema.string().describe("Đoạn trích cần kiểm tra"),
  },
  async execute({ url, quote }, context) {
    const { href } = assertDoc(url)
    const doc = await openDoc(href)
    const ft = await fullText(doc)
    evidence(context, doc, ft)
    const hay = norm(ft.text)
    const needle = norm(quote)
    const src = ft.ocr ? " (so trên văn bản OCR)" : ""
    if (hay.includes(needle)) return withUi(`KHỚP: đoạn trích có trong ${doc.title} – ${href}${src} (kiểm tra ngày ${today()}).`, { res: { t: "verify", code: "match" } })
    const words = needle.split(" ")
    let best = 0
    for (let n = words.length; n >= 4 && !best; n--) if (hay.includes(words.slice(0, n).join(" "))) best = n
    return withUi(`KHÔNG KHỚP: đoạn trích không có nguyên văn trong ${href}${src}.${best ? ` Chỉ khớp ${best}/${words.length} từ đầu.` : ""} Hãy trích lại bằng chinhphu_article thay vì sửa tay.`, { res: { t: "verify", code: "nomatch" } })
  },
})
