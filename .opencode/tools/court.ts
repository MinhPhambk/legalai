// Deterministic tools for Vietnamese case law, both run by the Supreme People's Court. Every request goes
// through the sandbox Chrome (DevTools port on 127.0.0.1:$CHROME_PORT, started by run.sh).
//   court_anle_search       – officially published án lệ on anle.toaan.gov.vn (Án lệ số NN/YYYY/AL): the full
//                             list is read from the site's own paginated list (cached 24 h) and matched locally
//                             against number, title, lĩnh vực and – once fetched – khái quát / từ khóa / quy định
//   court_anle_document     – one án lệ split into Nguồn / Vị trí / Khái quát (Tình huống – Giải pháp pháp lý) /
//                             Quy định liên quan / Từ khóa / Nội dung án lệ, with status and link. Newer án lệ are
//                             published only as PDF, often a scan without text layer: OCR fallback (../lib/pdf-ocr.ts,
//                             dedicated OCR Chrome :9334), output labelled as OCR; reported as scan when OCR is unavailable
//   court_judgment_search   – congbobanan.toaan.gov.vn search, driven through the real ASP.NET form in Chrome
//                             (case type, quan hệ pháp luật, cấp tòa, cấp xét xử, date range, paging)
//   court_judgment_document – one published judgment: PDF downloaded inside the page (fetch → base64), text
//                             extracted with pdfjs, reduced to parties / quan hệ tranh chấp / yêu cầu / nhận định
//                             (key paragraphs) / quyết định / căn cứ pháp luật
// Both servers are fragile public government sites: at most 2 concurrent requests per host, ≥1 s apart, images/
// fonts/embedded PDF viewers are not loaded, and results are cached. CAPTCHA / login / Cloudflare are never bypassed.
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import { count, isoDate, statusCode, withUi } from "../lib/ui-meta.ts"
import puppeteer from "puppeteer-core"
import fs from "node:fs"
import path from "node:path"
import { recordEvidence } from "../lib/evidence.ts"
import { polite as politeLib } from "../lib/polite.ts"
import { ocrPdf, ocrBlock, OCR_ENGINE, OCR_LABEL, OCR_WARNING, type OcrResult } from "../lib/pdf-ocr.ts"
// Returns the tool output unchanged after recording it as evidence for grounding_check.
const rec = (context: any, url: string, source: string, out: string, title?: string) => (recordEvidence(context?.sessionID, { url, title, text: out, source }), out)

const PORT = process.env.CHROME_PORT ?? "9333"
const CACHE = path.join(process.env.XDG_CACHE_HOME ?? ".", "legalai")
const ANLE = "https://anle.toaan.gov.vn"
const CBBA = "https://congbobanan.toaan.gov.vn"

const today = () => new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- politeness: ≤2 concurrent requests per host, ≥1 s between request starts ----------
// shared limiter (../lib/polite.ts): the same host state is used by web_read and every other tool
const polite = <T>(host: string, fn: () => Promise<T>): Promise<T> => politeLib(host, fn, { concurrency: 2, gapMs: 1000 })

// Tabs opened by these tools skip images, fonts, media, third-party scripts and the embedded PDF viewers
// (we fetch the PDF ourselves once), so one navigation costs the court server as few requests as possible.
async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  let browser
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  } catch {
    throw new Error(`Không kết nối được Chrome sandbox tại 127.0.0.1:${PORT}. Khởi động bằng: node tools/launch-chrome.mjs`)
  }
  const page = await browser.newPage()
  try {
    await page.setRequestInterception(true)
    page.on("request", (req: any) => {
      if (req.isInterceptResolutionHandled?.()) return
      const u = req.url()
      const t = req.resourceType()
      const own = /^https?:\/\/(anle|congbobanan)\.toaan\.gov\.vn\//.test(u)
      if (["image", "font", "media"].includes(t) || (!own && t !== "document") || /\/Resources\/pdfjs\/|\/webcenter\/pdfview/.test(u)) req.abort().catch(() => {})
      else req.continue().catch(() => {})
    })
    return await fn(page)
  } finally {
    await page.close().catch(() => {})
    browser.disconnect()
  }
}

async function go(page: any, url: string, timeout = 60000) {
  const host = new URL(url).host
  try {
    return await polite(host, () => page.goto(url, { waitUntil: "domcontentloaded", timeout }))
  } catch (e: any) {
    if (/timeout/i.test(String(e?.message))) throw new Error(`${host} không phản hồi sau ${timeout / 1000}s (máy chủ Tòa án có thể đang quá tải). Thử lại sau vài phút; không gửi dồn yêu cầu.`)
    throw e
  }
}

// Stop on CAPTCHA / Cloudflare / login walls instead of trying to get around them.
async function assertNoWall(page: any, site: string) {
  const wall = await page.evaluate(() => {
    const t = document.body?.innerText ?? ""
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, #cf-challenge-running')) return "CAPTCHA"
    if (/Just a moment|Checking your browser|Attention Required/i.test(document.title)) return "Cloudflare"
    if (/Access Denied|Request Rejected/i.test(t.slice(0, 500))) return "chặn truy cập"
    return ""
  })
  if (wall) throw new Error(`${site} yêu cầu ${wall} – công cụ dừng lại, không vượt qua. Báo người dùng mở trang thủ công hoặc thử lại sau.`)
}

// Binary download inside the page (same origin, real browser session) → base64 → Buffer. With maxBytes the
// stream is cancelled as soon as it grows past the limit (the court servers send chunked responses without
// Content-Length, and do not answer HEAD requests), and tooBig is returned instead of the data.
async function fetchBinary(page: any, url: string, maxBytes = 0, timeoutMs = 120000): Promise<{ buf: Buffer; type: string; status: number; tooBig?: boolean }> {
  const host = new URL(url, page.url()).host
  const r = await polite(host, () => page.evaluate(async (u: string, max: number, ms: number) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), ms)
    try {
      const res = await fetch(u, { credentials: "same-origin", signal: ctl.signal })
      const reader = res.body!.getReader()
      const chunks: Uint8Array[] = []
      let n = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        n += value.length
        if (max && n > max) { ctl.abort(); return { b64: "", type: res.headers.get("content-type") ?? "", status: res.status, tooBig: true } }
      }
      const b = new Uint8Array(n)
      let o = 0
      for (const c of chunks) { b.set(c, o); o += c.length }
      let s = ""
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)))
      return { b64: btoa(s), type: res.headers.get("content-type") ?? "", status: res.status, tooBig: false }
    } catch (e) {
      return { b64: "", type: "", status: 0, tooBig: false, error: String(e) }
    } finally {
      clearTimeout(timer)
    }
  }, url, maxBytes, timeoutMs))
  if ((r as any).error) throw new Error(`Không tải được ${new URL(url, page.url()).href}: ${/abort/i.test((r as any).error) ? `quá ${timeoutMs / 1000}s` : (r as any).error}`)
  return { buf: Buffer.from(r.b64, "base64"), type: r.type, status: r.status, tooBig: r.tooBig }
}

// ---------- PDF text (pdfjs-dist from web/node_modules, or a local install) ----------
let pdfjsP: Promise<any> | null = null
function pdfjs() {
  pdfjsP ??= (async () => {
    const local = new URL("../../web/node_modules/pdfjs-dist/legacy/build/", import.meta.url)
    for (const spec of [new URL("pdf.mjs", local).href, "pdfjs-dist/legacy/build/pdf.mjs"]) {
      try {
        const m = await import(spec)
        if (spec.startsWith("file:") && m.GlobalWorkerOptions) m.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.mjs", local).href
        return m
      } catch {}
    }
    throw new Error("Không tìm thấy pdfjs-dist (cần web/node_modules/pdfjs-dist). Chạy: npm install --prefix web")
  })()
  return pdfjsP
}

// The ONE place where a PDF becomes text. scan = no usable text layer (image-only scan). With ocr=true a scan is
// OCR'd in the dedicated OCR Chrome (../lib/pdf-ocr.ts, first ND45_OCR_MAX_PAGES=15 pages): the text then starts with
// OCR_LABEL and ocr carries engine / pages / warnings. If OCR is unavailable or fails, scan stays true (ocrError
// says why) and callers report "bản scan, không có lớp chữ" and never guess content.
const ocrMaxPages = () => Math.max(1, +(process.env.ND45_OCR_MAX_PAGES ?? 15) || 15) // first N pages of a scan are OCR'd
type OcrInfo = { engine: string; pages: number[]; total: number; warnings: string[]; ms: number }
type PdfText = { text: string; pages: number; scan: boolean; ocr?: OcrInfo; ocrError?: string; ocrAt?: number }
async function extractPdfText(buf: Buffer, opts: { ocr?: boolean } = {}): Promise<PdfText> {
  const { text, pages } = await pdfLayerText(buf)
  const scan = text.replace(/\s+/g, "").length < 150 * Math.min(pages, 3)
  if (!scan) return { text, pages, scan }
  if (!opts.ocr) return { text: "", pages, scan }
  try {
    const r: OcrResult = await ocrPdf(buf, { maxPages: ocrMaxPages() })
    if (r.pages.some((p) => p.text.length > 50)) {
      return { text: ocrBlock(r, false), pages, scan: false, ocr: { engine: r.engine, pages: r.pages.map((p) => p.n), total: r.totalPages || pages, warnings: r.warnings, ms: r.ms }, ocrAt: Date.now() }
    }
    return { text: "", pages, scan, ocrError: "OCR không nhận dạng được chữ", ocrAt: Date.now() }
  } catch (e: any) {
    return { text: "", pages, scan, ocrError: String(e?.message ?? e).slice(0, 300), ocrAt: Date.now() }
  }
}
// OCR'd text → what every OCR tool output carries: label line + page range, UI meta, evidence meta.
const ocrLine = (o: OcrInfo) => `${OCR_LABEL}\n(OCR ${OCR_ENGINE}, trang ${o.pages[0]}–${o.pages[o.pages.length - 1]}/${o.total}${o.warnings.length ? `; ${o.warnings.join("; ")}` : ""})`
const ocrUiOf = (o: OcrInfo) => ({ ocr: true, engine: o.engine, pages: o.pages })
const ocrMetaOf = (o: OcrInfo) => ({ ocr: true, engine: o.engine, ocr_pages: o.pages, total_pages: o.total, warning: OCR_WARNING })
const OCR_RETRY_MS = 6 * 3600_000 // a scan whose OCR failed (OCR Chrome down / no component) is retried after 6 h

async function pdfLayerText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const lib = await pdfjs()
  const task = lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  let out = ""
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent()
    let y: number | undefined
    for (const it of c.items as any[]) {
      if (y !== undefined && Math.abs(it.transform[5] - y) > 2) out += "\n"
      out += it.str
      y = it.transform[5]
      if (it.hasEOL) { out += "\n"; y = undefined }
    }
    out += "\n"
  }
  const pages = doc.numPages
  await task.destroy().catch(() => {})
  return { text: out, pages }
}

// PDF lines are hard-wrapped: rebuild paragraphs (a new paragraph starts after . : ; or before "[n]", "- ", "1." …)
// and drop bare page numbers.
function paragraphs(text: string) {
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && !/^\d{1,3}$/.test(l))
  const out: string[] = []
  for (const l of lines) {
    const prev = out[out.length - 1]
    const startsNew = /^(\[\d+\]|[-–•+]\s|\d+[.)/]\s|[a-zđ][).]\s|[IVX]+\.\s|Căn cứ|Vì các lẽ trên|Nơi nhận)/.test(l) || /^[A-ZĐÀ-Ỹ\s,:“”"-]{6,}$/u.test(l)
    if (!prev || startsNew || /[.:;!?”"]$/.test(prev) || /^[A-ZĐÀ-Ỹ\s,:“”"-]{6,}$/u.test(prev)) out.push(l)
    else out[out.length - 1] = `${prev} ${l}`
  }
  return out
}

// ---------- disk cache ----------
function readJson<T>(file: string, ttl?: number): T | null {
  try {
    if (ttl && Date.now() - fs.statSync(file).mtimeMs > ttl) return null
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}
function writeJson(file: string, v: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(v))
}

const fold = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9/]+/g, " ").trim()
// Keeps diacritics (so "phạt" ≠ "phát"); used when the query itself is typed with diacritics.
const normVi = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}/]+/gu, " ").trim()
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + " …" : s)

// ======================================================================================================
// Án lệ (anle.toaan.gov.vn – Oracle WebCenter/ADF: pages need JS, so every page is a real navigation)
// ======================================================================================================

type AnLe = { no: string; id: string; title: string; field: string; adopted: string; effective: string; published: string; status: string }
const anleLink = (id: string) => `${ANLE}/webcenter/portal/anle/chitietanle?dDocName=${id}`
const anleFile = (id: string) => `${ANLE}/webcenter/ShowProperty?nodeId=/UCMServer/${id}`
const LIST_TTL = 24 * 3600 * 1000

async function anleList(page: any): Promise<AnLe[]> {
  const file = path.join(CACHE, "anle", "list.json")
  const hit = readJson<AnLe[]>(file, LIST_TTL)
  if (hit?.length) return hit
  const all: AnLe[] = []
  for (let n = 1; n <= 30; n++) {
    await go(page, `${ANLE}/webcenter/portal/anle/anle?selectedPage=${n}&docType=AnLe&mucHienThi=9009`)
    await assertNoWall(page, "anle.toaan.gov.vn")
    await page.waitForSelector('td > a[href*="chitietanle"]', { timeout: 15000 }).catch(() => {})
    const rows: AnLe[] = await page.evaluate(() =>
      [...document.querySelectorAll("tr")].filter((r) => r.querySelector(':scope > td > a[href*="chitietanle"]')).map((r) => {
        const a = r.querySelector(":scope > td > a") as HTMLAnchorElement
        const tds = [...r.querySelectorAll(".tb-thuoctinh td")].map((t) => (t.textContent ?? "").replace(/\s+/g, " ").trim())
        const tt: Record<string, string> = {}
        for (let i = 0; i + 1 < tds.length; i += 2) tt[tds[i]] = tds[i + 1]
        const side = ((r.querySelectorAll(":scope > td")[2] as HTMLElement)?.innerText ?? "").replace(/\s+/g, " ")
        return {
          no: (a.textContent ?? "").trim(),
          id: a.href.split("dDocName=")[1]?.split("&")[0] ?? "",
          title: (r.querySelector(":scope > td p")?.textContent ?? "").replace(/\s+/g, " ").trim(),
          field: tt["Lĩnh vực"] ?? "",
          adopted: tt["Ngày thông qua"] ?? side.match(/Ngày thông qua:\s*([\d/]+)/)?.[1] ?? "",
          effective: tt["Ngày áp dụng"] ?? side.match(/Ngày áp dụng:\s*([\d/]+)/)?.[1] ?? "",
          published: tt["Ngày công bố"] ?? "",
          status: tt["Trạng thái"] ?? side.match(/Trạng thái:\s*(.+)$/)?.[1]?.trim() ?? "",
        }
      }))
    const fresh = rows.filter((r) => r.id && !all.some((x) => x.id === r.id))
    if (!fresh.length) break
    all.push(...fresh)
  }
  if (!all.length) throw new Error("Không đọc được danh sách án lệ trên anle.toaan.gov.vn (trang không hiển thị bảng án lệ).")
  writeJson(file, all)
  return all
}

// "Đang có hiệu lực" → còn áp dụng; the site's own wording is kept next to it.
const statusVi = (s: string) => (/bãi bỏ|hủy bỏ|huỷ bỏ/i.test(s) ? `BỊ BÃI BỎ (không còn áp dụng) – "${s}"` : /chưa có hiệu lực/i.test(s) ? `chưa có hiệu lực – "${s}"` : /có hiệu lực/i.test(s) ? `còn áp dụng ("${s}")` : s || "không rõ")

type AnLeDoc = { id: string; kind: "html" | "pdf" | "scan" | "ocr" | "pending"; text: string; pages?: number; title?: string; fetched: number; ocr?: OcrInfo; ocrError?: string; ocrAt?: number }

const SECTION_RES: [string, RegExp][] = [
  ["nguon", /^Nguồn án lệ\s*:?\s*/i],
  ["vitri", /^Vị trí nội dung án lệ\s*:?\s*/i],
  ["khaiquat", /^Khái quát nội dung (của )?án lệ\s*:?\s*/i],
  ["tinhhuong", /^[-–•]?\s*Tình huống án lệ\s*:?\s*/i],
  ["giaiphap", /^[-–•]?\s*Giải pháp pháp lý\s*:?\s*/i],
  ["quydinh", /^Quy định (của )?pháp luật liên quan (đến )?án lệ\s*:?\s*/i],
  ["tukhoa", /^Từ khóa (của )?án lệ\s*:?\s*/i],
  ["noidungvuan", /^NỘI DUNG (VỤ ÁN|VỤ VIỆC)\s*:?\s*/],
  ["nhandinh", /^(NHẬN ĐỊNH CỦA (TÒA ÁN|HỘI ĐỒNG THẨM PHÁN[^:]*)|XÉT THẤY)\s*:?\s*/],
  ["quyetdinh", /^(QUYẾT ĐỊNH|VÌ CÁC LẼ TRÊN)\s*:?\s*/],
  ["noidunganle", /^NỘI DUNG (CỦA )?ÁN LỆ\s*:?\s*/i],
]

function anleSections(text: string) {
  const sec: Record<string, string[]> = { head: [] }
  let cur = "head"
  for (const raw of paragraphs(text)) {
    let line = raw
    const hit = SECTION_RES.find(([, re]) => re.test(line))
    if (hit) {
      cur = hit[0]
      line = line.replace(hit[1], "").trim()
      sec[cur] ??= []
    }
    if (line) sec[cur].push(line)
  }
  const get = (k: string) => (sec[k] ?? []).join("\n").trim()
  // "Nội dung án lệ" = the paragraph(s) named in "Vị trí nội dung án lệ" (e.g. "Đoạn 4, 5 của phần Nhận định
  // của Tòa án"), unless the text carries an explicit "NỘI DUNG ÁN LỆ" block.
  let content = get("noidunganle")
  const pos = get("vitri")
  if (!content && pos) {
    const nums = [...(pos.match(/đoạn\s*([\d\s,;và\[\]-]+)/i)?.[1] ?? "").matchAll(/\d+/g)].map((m) => m[0])
    const range = pos.match(/đoạn\s*\[?(\d+)\]?\s*(?:-|đến)\s*\[?(\d+)\]?/i)
    if (range) for (let k = +range[1]; k <= +range[2]; k++) nums.push(String(k))
    const pool = sec.nhandinh ?? []
    const picked = [...new Set(nums)].map((n) => {
      const i = pool.findIndex((p) => p.startsWith(`[${n}]`) || new RegExp(`^${n}[.)]\\s`).test(p))
      if (i < 0) return ""
      const out = [pool[i]]
      for (let j = i + 1; j < pool.length && !/^\[\d+\]|^\d+[.)]\s/.test(pool[j]); j++) out.push(pool[j])
      return out.join("\n")
    }).filter(Boolean)
    content = picked.join("\n")
  }
  return {
    nguon: get("nguon"), vitri: pos, khaiquat: get("khaiquat"), tinhhuong: get("tinhhuong"), giaiphap: get("giaiphap"),
    quydinh: get("quydinh"), tukhoa: get("tukhoa"), noidunganle: content, nhandinh: get("nhandinh"), quyetdinh: get("quyetdinh"),
  }
}

// kind: html = text on the page; pdf = text extracted from the published PDF; scan = PDF without text layer;
// pending = PDF-only, not downloaded yet. The search index ("small") only downloads PDFs up to 3 MB – the
// text-layer PDFs are ~0.2–1 MB, the multi-MB ones are scans – so it does not pull hundreds of MB off the server.
const INDEX_PDF_MAX = 3 * 1024 * 1024
const INDEX_BUDGET_MS = 150 * 1000
async function anleDoc(page: any, id: string, pdf: "small" | "always"): Promise<AnLeDoc> {
  const file = path.join(CACHE, "anle", `${id}.json`)
  const hit = readJson<AnLeDoc & { big?: boolean }>(file)
  // a cached scan is OCR'd when the document is read (pdf "always"), unless OCR failed less than OCR_RETRY_MS ago
  const retryOcr = pdf !== "small" && hit?.kind === "scan" && (!hit.ocrAt || Date.now() - hit.ocrAt > OCR_RETRY_MS)
  if (hit && !retryOcr && (hit.kind !== "pending" || (pdf === "small" && hit.big))) return hit
  let title = hit?.title ?? ""
  if (!hit) {
    await go(page, anleLink(id))
    await assertNoWall(page, "anle.toaan.gov.vn")
    await page.waitForSelector("#toanvan .content", { timeout: 20000 }).catch(() => {})
    const d = await page.evaluate(() => {
      const el = document.querySelector("#toanvan .content") as HTMLElement | null
      return { text: el?.innerText ?? "", pdf: !!el?.querySelector('iframe[src*="pdfview"], iframe.viewpdf'), title: (el?.querySelector("p") as HTMLElement | null)?.innerText?.trim() ?? "" }
    })
    if (!d.text && !d.pdf) throw new Error(`Trang án lệ ${anleLink(id)} không hiển thị nội dung.`)
    if (!d.pdf && d.text.replace(/\s+/g, " ").length > 800) {
      const doc: AnLeDoc = { id, kind: "html", text: d.text, fetched: Date.now() }
      writeJson(file, doc)
      return doc
    }
    title = d.title
  }
  if (!/anle\.toaan\.gov\.vn/.test(page.url())) await go(page, `${ANLE}/webcenter/portal/anle/anle`)
  const { buf, type, tooBig } = await fetchBinary(page, anleFile(id), pdf === "small" ? INDEX_PDF_MAX : 0)
  if (tooBig) {
    const doc = { id, kind: "pending" as const, text: "", title, big: true, fetched: Date.now() }
    writeJson(file, doc)
    return doc
  }
  if (!/pdf/i.test(type) && buf.subarray(0, 4).toString() !== "%PDF") throw new Error(`Tệp án lệ ${id} không phải PDF (${type}).`)
  const { text, pages, scan, ocr, ocrError, ocrAt } = await extractPdfText(buf, { ocr: pdf !== "small" })
  const doc: AnLeDoc = { id, kind: ocr ? "ocr" : scan ? "scan" : "pdf", text, pages, title, fetched: Date.now(), ...(ocr ? { ocr } : {}), ...(ocrError ? { ocrError } : {}), ...(ocrAt ? { ocrAt } : {}) }
  writeJson(file, doc)
  return doc
}

function resolveAnle(list: AnLe[], ref: string): AnLe | undefined {
  const s = ref.trim()
  const id = s.match(/TAND\d+/i)?.[0]?.toUpperCase()
  if (id) return list.find((x) => x.id === id)
  const m = s.match(/(\d{1,3})\s*\/\s*(\d{4})/) ?? s.match(/(?:án lệ|an le|số|so)?\s*(\d{1,3})\b/i)
  if (!m) return undefined
  const n = String(+m[1]).padStart(2, "0")
  return list.find((x) => x.no.startsWith(`${n}/`) && (!m[2] || x.no.includes(`/${m[2]}/`)))
}

export const anle_search = tool({
  description: "Tìm ÁN LỆ đã được Hội đồng Thẩm phán TANDTC thông qua và công bố chính thức trên anle.toaan.gov.vn (Án lệ số NN/YYYY/AL) theo từ khóa/chủ đề (VD 'phạt vi phạm', 'hợp đồng mua bán hàng hóa', 'trọng tài', 'lãi suất', 'đặt cọc') và/hoặc lĩnh vực. Trả về số án lệ, tên, lĩnh vực, ngày thông qua, ngày áp dụng, TRẠNG THÁI (còn áp dụng / bị bãi bỏ), khái quát nội dung và link. Để trống query để liệt kê. Án lệ là NGUỒN LUẬT (Tòa án phải nghiên cứu, áp dụng); sau khi chọn được án lệ, gọi court_anle_document để đọc Tình huống – Giải pháp pháp lý.",
  args: {
    query: tool.schema.string().optional().describe("Cụm từ pháp lý tiếng Việt (khớp nguyên cụm, VD 'phạt vi phạm', 'lãi chậm trả'); nhiều cụm ngăn bởi dấu phẩy thì phải có đủ (VD 'hợp đồng mua bán, lãi suất'); hoặc số án lệ ('09/2016')"),
    field: tool.schema.string().optional().describe("Lĩnh vực: 'Kinh doanh thương mại', 'Dân sự', 'Hình sự', 'Hành chính', 'Hôn nhân và gia đình', 'Lao động'"),
    status: tool.schema.string().optional().describe("'con' (còn áp dụng), 'bai_bo' (bị bãi bỏ) hoặc để trống = tất cả"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa (mặc định 10)"),
  },
  async execute({ query, field, status, limit }, context) {
    return withPage(async (page) => {
      const list = await anleList(page)
      const q = fold(query ?? "")
      // Content index: each án lệ page (and its PDF when it has a text layer) is fetched once and cached for
      // good – texts never change; status comes from the list, refreshed daily. Building it the first time takes
      // a few minutes at ≤1 request/s, so one call spends at most INDEX_BUDGET_MS and the next call continues.
      const docs = new Map<string, AnLeDoc>()
      let unindexed = 0
      const isNumber = /^\d{1,3}(\/\d{4})?(\/al)?$/.test(q)
      if (q && !isNumber) {
        const until = Date.now() + INDEX_BUDGET_MS
        let stop = false
        for (const a of list) {
          const cachedDoc = readJson<AnLeDoc & { big?: boolean }>(path.join(CACHE, "anle", `${a.id}.json`))
          if (cachedDoc && (cachedDoc.kind !== "pending" || cachedDoc.big)) { docs.set(a.id, cachedDoc); continue }
          if (stop || Date.now() > until) { unindexed++; continue }
          try { docs.set(a.id, await anleDoc(page, a.id, "small")) } catch (e) { unindexed++; if (/không phản hồi|CAPTCHA|Cloudflare/.test(String(e))) stop = true }
        }
      }
      // Legal terms are matched as phrases (so "phạt vi phạm" does not hit any text that merely contains "phạt",
      // "vi" and "phạm"); several concepts can be combined with "," or "+" and must all occur.
      const nf = /[^\x00-\x7f]/.test(query ?? "") ? normVi : fold
      const phrases = (query ?? "").split(/[,;+]/).map(nf).filter(Boolean)
      const has = (t: string, p: string) => ` ${t} `.includes(` ${p} `)
      const fq = fold(field ?? "").replace(/,/g, "")
      const scored = list.map((a) => {
        const d = docs.get(a.id)
        const s = d?.text ? anleSections(d.text) : null
        const title = nf(`${a.no} ${a.title}`)
        const key = s ? nf(`${s.khaiquat} ${s.tinhhuong} ${s.giaiphap} ${s.tukhoa}`) : ""
        const rest = s ? nf(`${s.quydinh} ${s.noidunganle} ${s.nguon}`) : ""
        let score = q ? 0 : 1
        if (q && isNumber) score += resolveAnle([a], q) ? 100 : 0
        else if (q) {
          for (const p of phrases) {
            const w = (has(title, p) ? 20 : 0) + (has(key, p) ? 12 : 0) + (has(rest, p) ? 4 : 0)
            if (!w) { score = 0; break }
            score += w
          }
        }
        return { a, s, score }
      }).filter((x) => x.score > 0)
        .filter((x) => !fq || fold(x.a.field).includes(fq) || fq.includes(fold(x.a.field)))
        .filter((x) => !status || (/bai|huy/.test(fold(status)) ? /bai bo|huy bo/.test(fold(x.a.status)) : !/bai bo|huy bo/.test(fold(x.a.status))))
        .sort((x, y) => y.score - x.score || +y.a.no.split("/")[0] - +x.a.no.split("/")[0])
      const shown = scored.slice(0, limit ?? 10)
      const pdfOnly = list.filter((a) => ["pending", "scan"].includes(docs.get(a.id)?.kind ?? "")).length
      const url = `${ANLE}/webcenter/portal/anle/anle`
      if (!shown.length) return withUi(rec(context, url, "anle.toaan.gov.vn", `Không có án lệ nào khớp "${query ?? ""}"${field ? ` (lĩnh vực ${field})` : ""} trong ${list.length} án lệ đã công bố trên anle.toaan.gov.vn (tra ngày ${today()}). Thử từ khóa ngắn hơn / đồng nghĩa (VD 'phạt vi phạm' → 'phạt hợp đồng', 'lãi'), hoặc để trống query để xem danh sách.`), { res: count(0, "precedents") })
      return withUi(rec(context, url, "anle.toaan.gov.vn", [
        `Án lệ trên anle.toaan.gov.vn${query ? ` khớp "${query}"` : ""}${field ? ` · lĩnh vực ${field}` : ""}: ${scored.length}/${list.length} án lệ (hiển thị ${shown.length})`,
        ...shown.map(({ a, s }, i) => [
          `${i + 1}. Án lệ số ${a.no} – ${clip(a.title, 220)}`,
          `   Lĩnh vực: ${a.field || "?"} · Thông qua: ${a.adopted || "?"} · Áp dụng từ: ${a.effective || "?"}${a.published ? ` · Công bố: ${a.published}` : ""} · Trạng thái: ${statusVi(a.status)}`,
          s?.khaiquat || s?.giaiphap ? `   Khái quát: ${clip((s.giaiphap || s.khaiquat).replace(/\n/g, " "), 300)}` : "",
          `   ${anleLink(a.id)}`,
        ].filter(Boolean).join("\n")),
        pdfOnly && q && !isNumber ? `(Lưu ý: ${pdfOnly} án lệ chỉ có PDF ảnh quét/tệp lớn nên chỉ khớp theo số và tên án lệ.)` : "",
        unindexed ? `(Chỉ mục nội dung chưa xong: còn ${unindexed} án lệ chưa đọc – gọi lại cùng truy vấn để hoàn tất.)` : "",
        `Nguồn: anle.toaan.gov.vn · Ngày tra cứu: ${today()}`,
        `Tiếp theo: court_anle_document(ref="<số án lệ hoặc link>") để đọc Tình huống – Giải pháp pháp lý – Nội dung án lệ.`,
      ].filter(Boolean).join("\n")), { res: count(scored.length, "precedents") })
    })
  },
})

export const anle_document = tool({
  description: "Đọc MỘT án lệ chính thức trên anle.toaan.gov.vn (theo số 'NN/YYYY/AL', VD '09/2016', hoặc link chitietanle?dDocName=…): trạng thái (còn áp dụng/bị bãi bỏ), ngày thông qua/áp dụng, Nguồn án lệ, Vị trí nội dung án lệ, Khái quát nội dung (Tình huống án lệ – Giải pháp pháp lý), Quy định của pháp luật liên quan, Từ khóa và NGUYÊN VĂN Nội dung án lệ (đoạn được lấy làm án lệ), kèm link. Dùng phần này để trích dẫn án lệ.",
  args: {
    ref: tool.schema.string().describe("Số án lệ ('09/2016/AL', 'án lệ 9/2016') hoặc link https://anle.toaan.gov.vn/...chitietanle?dDocName=TAND…"),
    max_chars: tool.schema.number().optional().describe("Giới hạn ký tự cho phần Nội dung án lệ (mặc định 5000)"),
    include_reasoning: tool.schema.boolean().optional().describe("true = kèm thêm trích phần Nhận định của Tòa án (mặc định false)"),
  },
  async execute({ ref, max_chars, include_reasoning }, context) {
    return withPage(async (page) => {
      const list = await anleList(page)
      const a = resolveAnle(list, ref)
      if (!a) return `Không tìm thấy án lệ "${ref}" trong ${list.length} án lệ đã công bố (anle.toaan.gov.vn). Dùng court_anle_search để tìm số án lệ đúng.`
      const d = await anleDoc(page, a.id, "always")
      const link = anleLink(a.id)
      const st = statusCode(statusVi(a.status))
      const ui = { ...(st ? { res: { t: "status", code: st } } : {}), doc: { title: `Án lệ số ${a.no} – ${a.title}`, lang: "vi", number: a.no, status: st, issued: isoDate(a.adopted), effective: isoDate(a.effective), url: link } }
      const head = [
        `Án lệ số ${a.no} – ${a.title}`,
        `Trạng thái: ${statusVi(a.status)} · Lĩnh vực: ${a.field || "?"} · Thông qua: ${a.adopted || "?"} · Áp dụng từ: ${a.effective || "?"}${a.published ? ` · Công bố: ${a.published}` : ""}`,
        `Link: ${link}`,
        `Ngày tra cứu: ${today()}`,
      ]
      if (!d.text) {
        const msg = [...head,
          `⚠ Toàn văn án lệ này chỉ được đăng dưới dạng PDF ẢNH QUÉT (${d.pages ?? "?"} trang, không có lớp chữ) – công cụ không trích được nội dung${d.ocrError ? ` (OCR không dùng được: ${d.ocrError})` : ""}.`,
          `Tệp gốc: ${anleFile(a.id)}`,
          `Chỉ được dẫn số, tên, trạng thái và ngày áp dụng ở trên; KHÔNG tự suy diễn nội dung Tình huống/Giải pháp pháp lý.`].join("\n")
        recordEvidence(context?.sessionID, { url: link, title: `Án lệ số ${a.no}`, text: msg, source: "anle.toaan.gov.vn", meta: { scan: true, no: a.no } })
        return withUi(msg, ui)
      }
      const s = anleSections(d.text)
      const cap = max_chars ?? 5000
      recordEvidence(context?.sessionID, { url: link, title: `Án lệ số ${a.no} – ${a.title}`, text: d.text, source: "anle.toaan.gov.vn", meta: { no: a.no, status: a.status, effective: a.effective, kind: d.kind, ...(d.ocr ? ocrMetaOf(d.ocr) : {}) } })
      if (d.ocr) Object.assign(ui, ocrUiOf(d.ocr))
      return withUi([
        ...head,
        d.kind === "pdf" ? `(Văn bản trích từ tệp PDF gốc: ${anleFile(a.id)})` : "",
        d.ocr ? `${ocrLine(d.ocr)}\n(Tệp gốc – bản scan: ${anleFile(a.id)}; mọi phần dưới đây đều là văn bản OCR)` : "",
        s.nguon ? `\nNGUỒN ÁN LỆ: ${clip(s.nguon.replace(/\n/g, " "), 600)}` : "",
        s.vitri ? `VỊ TRÍ NỘI DUNG ÁN LỆ: ${s.vitri.replace(/\n/g, " ")}` : "",
        `\nKHÁI QUÁT NỘI DUNG:`,
        s.tinhhuong ? `- Tình huống án lệ: ${s.tinhhuong}` : "",
        s.giaiphap ? `- Giải pháp pháp lý: ${s.giaiphap}` : "",
        !s.tinhhuong && !s.giaiphap ? (s.khaiquat || "(không tách được)") : "",
        s.quydinh ? `\nQUY ĐỊNH CỦA PHÁP LUẬT LIÊN QUAN:\n${s.quydinh}` : "",
        s.tukhoa ? `TỪ KHÓA: ${s.tukhoa.replace(/\n/g, " ")}` : "",
        d.ocr ? `\n--- NỘI DUNG ÁN LỆ (văn bản OCR – đối chiếu bản gốc) ---\n${OCR_LABEL}` : `\n--- NỘI DUNG ÁN LỆ (nguyên văn) ---`,
        s.noidunganle ? clip(s.noidunganle, cap) : "(Không xác định được đoạn án lệ theo 'Vị trí nội dung án lệ'; xem phần Nhận định bằng include_reasoning=true hoặc mở link.)",
        include_reasoning && s.nhandinh ? `\n--- NHẬN ĐỊNH CỦA TÒA ÁN (trích) ---\n${clip(s.nhandinh, cap)}` : "",
        `\nGhi chú: án lệ là nguồn luật – dẫn "Án lệ số ${a.no}" kèm trạng thái và link trên.`,
      ].filter(Boolean).join("\n"), ui)
    })
  },
})

// ======================================================================================================
// Bản án (congbobanan.toaan.gov.vn – ASP.NET WebForms with UpdatePanels)
// ======================================================================================================

const F = "#ctl00_Content_home_Public_ctl00_"
const CASE_TYPES: Record<string, string> = {
  "hinh su": "50", "dan su": "0", "hon nhan va gia dinh": "1", "hon nhan": "1", "kinh doanh thuong mai": "2", "kdtm": "2", "thuong mai": "2",
  "hanh chinh": "4", "lao dong": "3", "pha san": "5",
}
const COURT_LEVELS: Record<string, string> = { "toi cao": "TW", "tandtc": "TW", "cap cao": "CW", "tinh": "T", "cap tinh": "T", "huyen": "H", "cap huyen": "H", "khu vuc": "H" }
const JUDGMENT_LEVELS: Record<string, { v: string; courts: string[] }> = {
  "so tham": { v: "0", courts: ["T", "H"] }, "phuc tham": { v: "1", courts: ["CW", "T"] },
  "giam doc tham": { v: "2", courts: ["TW", "CW"] }, "tai tham": { v: "3", courts: ["TW", "CW"] },
}
const pick = <T>(map: Record<string, T>, s?: string) => {
  if (!s) return undefined
  const f = fold(s)
  return map[f] ?? Object.entries(map).find(([k]) => f.includes(k))?.[1]
}

// Run an action that triggers an ASP.NET postback and wait until it is over – either a partial postback
// (UpdatePanel: PageRequestManager endRequest fires) or a full one (a new document without our marker).
async function postback(page: any, action: () => Promise<unknown>) {
  await polite(new URL(CBBA).host, async () => {
    await page.evaluate(() => {
      const w = window as any
      w.__cbMark = 1
      w.__cbDone = 0
      try { w.Sys.WebForms.PageRequestManager.getInstance().add_endRequest(() => { w.__cbDone = 1 }) } catch {}
    })
    await action()
    await page.waitForFunction(() => {
      const w = window as any
      if (document.readyState === "loading") return false
      if (!w.__cbMark) return true // new document
      return w.__cbDone === 1 && !w.Sys?.WebForms?.PageRequestManager?.getInstance?.()?.get_isInAsyncPostBack?.()
    }, { timeout: 60000, polling: 200 }).catch(() => { throw new Error("congbobanan.toaan.gov.vn không phản hồi sau 60s (máy chủ có thể đang quá tải). Thử lại sau vài phút.") })
  })
}
const selectAndSettle = (page: any, id: string, value: string) => postback(page, () => page.select(F + id, value))
const options = (page: any, id: string): Promise<{ v: string; t: string }[]> =>
  page.evaluate((sel: string) => [...((document.querySelector(sel) as HTMLSelectElement)?.options ?? [])].map((o) => ({ v: o.value, t: o.text.trim() })), F + id)

type Hit = { kind: string; no: string; date: string; court: string; posted: string; relation: string; level: string; type: string; precedent: string; summary: string; link: string }

async function readResults(page: any): Promise<{ total: number; pages: number; items: Hit[] }> {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll("#List_group_pub .list-group-item")].map((n) => {
      const a = n.querySelector("a.echo_id_pub") as HTMLAnchorElement | null
      const head = (n.querySelector("h4") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").trim() ?? ""
      const lab = (l: string) => {
        const el = [...n.querySelectorAll("label")].find((x) => (x.textContent ?? "").trim().replace(/\s*:$/, "") === l)
        return (el?.nextElementSibling?.textContent ?? "").replace(/\s+/g, " ").trim()
      }
      const m = head.match(/^(Bản án|Quyết định)\s*:?\s*số\s*(\S+)\s+ngày\s+([\d/]+)\s+của\s+(.+?)\s*(?:\(([\d.]+)\))?$/)
      return {
        kind: m?.[1] ?? head.split(":")[0], no: m?.[2] ?? "", date: m?.[3] ?? "", court: m?.[4] ?? head, posted: m?.[5] ?? "",
        relation: lab("Quan hệ pháp luật"), level: lab("Cấp xét xử"), type: lab("Loại vụ/việc"), precedent: lab("Áp dụng án lệ"),
        summary: lab("Thông tin về vụ/việc"), link: a ? new URL(a.getAttribute("href") ?? "", location.origin).href : "",
      }
    }).filter((x) => x.link)
    const total = Number((document.querySelector("#ctl00_Content_home_Public_ctl00_lbl_count_record_top")?.textContent ?? "0").replace(/\D/g, "")) || 0
    const pages = (document.querySelector("#ctl00_Content_home_Public_ctl00_DropPages") as HTMLSelectElement | null)?.options.length ?? 1
    return { total, pages, items }
  })
}

const searchCache = new Map<string, { at: number; value: any }>()

async function runSearch(page: any, o: { keyword?: string; caseType?: string; relation?: string; courtLevel?: string; court?: string; level?: string; docType?: string; from?: string; to?: string; page: number }) {
  const key = JSON.stringify(o)
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.value
  await go(page, `${CBBA}/0tat1cvn/ban-an-quyet-dinh`)
  await assertNoWall(page, "congbobanan.toaan.gov.vn")
  await page.waitForSelector(F + "cmd_Left_search", { timeout: 20000 })
  const notes: string[] = []
  if (o.caseType) await selectAndSettle(page, "Drop_CASES_STYLES_SEARCH", o.caseType)
  if (o.relation) {
    const opts = (await options(page, "Ra_Case_shows_search")).filter((x) => x.v)
    const f = fold(o.relation)
    const best = opts.map((x) => ({ x, s: fold(x.t) === f ? 100 : fold(x.t).includes(f) ? 50 : f.split(" ").filter((w) => fold(x.t).includes(w)).length })).sort((a, b) => b.s - a.s)[0]
    if (best && best.s >= Math.max(2, Math.ceil(f.split(" ").length * 0.6))) {
      await selectAndSettle(page, "Ra_Case_shows_search", best.x.v)
      notes.push(`Quan hệ pháp luật: "${best.x.t}"`)
    } else notes.push(`Không có quan hệ pháp luật khớp "${o.relation}"${opts.length ? "" : " (hãy chọn case_type trước)"} – bỏ qua bộ lọc này`)
  }
  if (o.courtLevel) await selectAndSettle(page, "Drop_Levels", o.courtLevel)
  if (o.court && o.courtLevel) {
    const f = fold(o.court)
    const c = (await options(page, "Ra_Drop_Courts")).find((x) => x.v && fold(x.t).includes(f))
    if (c) { await selectAndSettle(page, "Ra_Drop_Courts", c.v); notes.push(`Tòa án: ${c.t}`) } else notes.push(`Không có tòa "${o.court}" ở cấp đã chọn – bỏ qua`)
  }
  if (o.level) {
    const ok = (await options(page, "Drop_LEVEL_JUDGMENT_SEARCH")).some((x) => x.v === o.level)
    if (ok) await selectAndSettle(page, "Drop_LEVEL_JUDGMENT_SEARCH", o.level)
  }
  if (o.docType) await page.select(F + "Drop_STATUS_JUDGMENT_SEARCH", o.docType)
  await page.evaluate((F: string, kw: string, from: string, to: string) => {
    const set = (id: string, v: string) => { const el = document.querySelector(F + id) as HTMLInputElement | null; if (el) el.value = v }
    if (kw) set("txtKeyword", kw)
    if (from) set("Rad_DATE_FROM", from)
    if (to) set("Rad_DATE_TO", to)
  }, F, o.keyword ?? "", o.from ?? "", o.to ?? "")
  await postback(page, () => page.evaluate((sel: string) => { setTimeout(() => (document.querySelector(sel) as HTMLElement).click(), 0) }, F + "cmd_Left_search"))
  await page.waitForSelector("#ctl00_Content_home_Public_ctl00_lbl_count_record_top, #List_group_pub", { timeout: 20000 }).catch(() => {})
  await assertNoWall(page, "congbobanan.toaan.gov.vn")
  const alert = await page.evaluate(() => /mã xác (thực|nhận)|captcha/i.test((document.querySelector("#ctl00_Content_home_Public_ctl00_search_content") as HTMLElement | null)?.innerText ?? ""))
  if (alert) throw new Error("congbobanan.toaan.gov.vn yêu cầu mã xác thực (CAPTCHA) cho tìm kiếm – công cụ dừng lại, không vượt qua. Báo người dùng tự tra trên trang.")
  let res = await readResults(page)
  if (o.page > 1 && o.page <= res.pages) {
    await selectAndSettle(page, "DropPages", String(o.page))
    await sleep(300)
    res = await readResults(page)
  }
  const value = { ...res, notes }
  searchCache.set(key, { at: Date.now(), value })
  return value
}

function toDmy(s?: string) {
  if (!s) return ""
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) return `${iso[3].padStart(2, "0")}/${iso[2].padStart(2, "0")}/${iso[1]}`
  const d = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  if (d) return `${d[1].padStart(2, "0")}/${d[2].padStart(2, "0")}/${d[3]}`
  throw new Error(`Ngày "${s}" không hợp lệ – dùng dd/mm/yyyy hoặc yyyy-mm-dd.`)
}
const dmyKey = (s: string) => s.split("/").reverse().join("")

export const judgment_search = tool({
  description: "Tìm BẢN ÁN / QUYẾT ĐỊNH đã công bố trên congbobanan.toaan.gov.vn bằng form tìm kiếm của trang (điều khiển Chrome). Lọc theo từ khóa (CHỈ khớp tên vụ việc / số bản án, không tìm toàn văn), loại vụ việc (Kinh doanh thương mại, Dân sự…), quan hệ pháp luật (VD 'Tranh chấp về mua bán hàng hóa', 'Tranh chấp hợp đồng tín dụng', 'trọng tài'), cấp tòa, cấp xét xử (sơ thẩm/phúc thẩm/giám đốc thẩm), khoảng ngày ban hành. Trả về số, ngày, tòa, cấp xét xử, quan hệ pháp luật, tóm tắt, link. Bản án chỉ là TÀI LIỆU THAM KHẢO (không phải nguồn luật); dùng court_judgment_document để đọc nội dung.",
  args: {
    keyword: tool.schema.string().optional().describe("Từ khóa trong tên vụ/việc hoặc số bản án (VD 'phạt vi phạm', 'mua bán hàng hóa', '85/2024/KDTM-PT')"),
    case_type: tool.schema.string().optional().describe("Loại vụ việc: 'Kinh doanh thương mại' | 'Dân sự' | 'Hành chính' | 'Lao động' | 'Hình sự' | 'Hôn nhân và gia đình'"),
    relation: tool.schema.string().optional().describe("Quan hệ pháp luật (cần case_type), VD 'mua bán hàng hóa', 'cung ứng dịch vụ', 'trọng tài thương mại', 'hợp đồng tín dụng'"),
    level: tool.schema.string().optional().describe("Cấp xét xử: 'sơ thẩm' | 'phúc thẩm' | 'giám đốc thẩm' | 'tái thẩm'"),
    court_level: tool.schema.string().optional().describe("Cấp tòa: 'tối cao' | 'cấp cao' | 'tỉnh' | 'huyện' (khu vực)"),
    court: tool.schema.string().optional().describe("Tên tòa (cần court_level), VD 'TP Hồ Chí Minh', 'Hà Nội'"),
    doc_type: tool.schema.string().optional().describe("'bản án' hoặc 'quyết định' (mặc định cả hai)"),
    date_from: tool.schema.string().optional().describe("Ban hành từ ngày (dd/mm/yyyy hoặc yyyy-mm-dd)"),
    date_to: tool.schema.string().optional().describe("Ban hành đến ngày"),
    page: tool.schema.number().optional().describe("Trang kết quả (mặc định 1)"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa hiển thị (mặc định 10)"),
  },
  async execute(args, context) {
    const caseType = pick(CASE_TYPES, args.case_type)
    if (args.case_type && caseType === undefined) return `Loại vụ việc "${args.case_type}" không hợp lệ. Dùng: Kinh doanh thương mại, Dân sự, Hành chính, Lao động, Hình sự, Hôn nhân và gia đình.`
    const lv = pick(JUDGMENT_LEVELS, args.level)
    if (args.level && !lv) return `Cấp xét xử "${args.level}" không hợp lệ. Dùng: sơ thẩm, phúc thẩm, giám đốc thẩm, tái thẩm.`
    const cl = pick(COURT_LEVELS, args.court_level)
    if (args.court_level && !cl) return `Cấp tòa "${args.court_level}" không hợp lệ. Dùng: tối cao, cấp cao, tỉnh, huyện.`
    if (!args.keyword && !caseType && !args.date_from && !args.date_to && !cl) return "Cần ít nhất một điều kiện: keyword, case_type, court_level hoặc khoảng ngày (trang có hơn 2 triệu bản án)."
    const docType = args.doc_type ? (/quyet/.test(fold(args.doc_type)) ? "1" : "0") : undefined
    const from = toDmy(args.date_from), to = toDmy(args.date_to)
    const pg = Math.max(1, args.page ?? 1)
    // The site only offers "cấp xét xử" after a court level is chosen; without one, search each court level
    // that can issue that kind of judgment and merge.
    const courtLevels = cl ? [cl] : lv ? lv.courts : [undefined]
    return withPage(async (page) => {
      const runs = []
      for (const c of courtLevels) runs.push({ c, r: await runSearch(page, { keyword: args.keyword, caseType, relation: args.relation, courtLevel: c, court: args.court, level: lv?.v, docType, from, to, page: pg }) })
      const items: Hit[] = runs.flatMap((x) => x.r.items).filter((x: Hit, i: number, arr: Hit[]) => arr.findIndex((y) => y.link === x.link) === i)
        .sort((a: Hit, b: Hit) => dmyKey(b.date).localeCompare(dmyKey(a.date)))
      const total = runs.reduce((n, x) => n + x.r.total, 0)
      const pages = Math.max(...runs.map((x) => x.r.pages))
      const notes = [...new Set(runs.flatMap((x) => x.r.notes))]
      const shown = items.slice(0, args.limit ?? 10)
      const cond = [args.keyword && `từ khóa "${args.keyword}"`, args.case_type, args.level, args.court_level && `cấp tòa ${args.court_level}`, (from || to) && `ban hành ${from || "…"} – ${to || "…"}`].filter(Boolean).join(" · ")
      const url = `${CBBA}/0tat1cvn/ban-an-quyet-dinh`
      if (!shown.length) return withUi(rec(context, url, "congbobanan.toaan.gov.vn", [`Không có bản án/quyết định nào khớp (${cond}) trên congbobanan.toaan.gov.vn (tra ngày ${today()}).`, ...notes,
        args.keyword ? "Lưu ý: từ khóa chỉ khớp TÊN vụ việc/số bản án – thử bỏ keyword và lọc bằng case_type + relation (quan hệ pháp luật), hoặc từ khóa ngắn hơn." : ""].filter(Boolean).join("\n")), { res: count(0, "judgments") })
      return withUi(rec(context, url, "congbobanan.toaan.gov.vn", [
        `Bản án/quyết định trên congbobanan.toaan.gov.vn (${cond}): ${total} kết quả, trang ${pg}/${pages}${courtLevels.length > 1 ? ` (gộp ${courtLevels.length} cấp tòa)` : ""}`,
        ...notes,
        ...shown.map((h, i) => [
          `${i + 1}. ${h.kind} số ${h.no} ngày ${h.date} – ${h.court}`,
          `   Cấp xét xử: ${h.level || "?"} · Loại: ${h.type || "?"} · QHPL: ${h.relation || "?"}${h.precedent && !/không/i.test(h.precedent) ? ` · Áp dụng án lệ: ${h.precedent}` : ""}${h.posted ? ` · Đăng: ${h.posted}` : ""}`,
          h.summary ? `   Tóm tắt: ${clip(h.summary, 260)}` : "",
          `   ${h.link}`,
        ].filter(Boolean).join("\n")),
        pages > pg ? `Còn trang sau: gọi lại với page=${pg + 1}.` : "",
        `Nguồn: congbobanan.toaan.gov.vn · Ngày tra cứu: ${today()}`,
        `Bản án chỉ để tham khảo cách Tòa áp dụng pháp luật, không phải nguồn luật (trừ khi đã được công bố là án lệ). Đọc nội dung bằng court_judgment_document(url).`,
      ].filter(Boolean).join("\n")), { res: count(total, "judgments") })
    })
  },
})

// ---------- one judgment ----------

type JudgmentMeta = Record<string, string>
type Judgment = { id: string; meta: JudgmentMeta; pdf: string; text: string; pages: number; scan: boolean; fetched: number; ocr?: OcrInfo; ocrError?: string; ocrAt?: number }

function judgmentId(ref: string) {
  const s = ref.trim()
  if (/^\d+$/.test(s)) return s
  let u: URL
  try { u = new URL(s) } catch { throw new Error("Cần link bản án dạng https://congbobanan.toaan.gov.vn/2ta<số>t1cvn/chi-tiet-ban-an (lấy từ court_judgment_search) hoặc mã số.") }
  if (u.hostname !== "congbobanan.toaan.gov.vn") throw new Error("Chỉ nhận link trên congbobanan.toaan.gov.vn.")
  const m = u.pathname.match(/^\/[235]ta(\d+)t1cvn/)
  if (!m) throw new Error("Link không phải trang bản án (…/2ta<số>t1cvn/chi-tiet-ban-an).")
  return m[1]
}
const judgmentLink = (id: string) => `${CBBA}/2ta${id}t1cvn/chi-tiet-ban-an`

async function loadJudgment(page: any, id: string): Promise<Judgment> {
  const file = path.join(CACHE, "congbobanan", `${id}.json`)
  const hit = readJson<Judgment>(file)
  if (hit && !(hit.scan && (!hit.ocrAt || Date.now() - hit.ocrAt > OCR_RETRY_MS))) return hit
  await go(page, judgmentLink(id))
  await assertNoWall(page, "congbobanan.toaan.gov.vn")
  const info = await page.evaluate(() => {
    const t = document.body.innerText
    const meta: Record<string, string> = {}
    for (const k of ["Tên bản án", "Tên quyết định", "Quan hệ pháp luật", "Cấp xét xử", "Cấp giải quyết", "Loại vụ/việc", "Tòa án xét xử", "Tòa án giải quyết", "Áp dụng án lệ", "Đính chính", "Thông tin về vụ/việc", "Ngày tuyên án", "Ngày ban hành"]) {
      const m = t.match(new RegExp(`${k}\\s*:\\s*([^\\n]+)`))
      if (m) meta[k] = m[1].trim()
    }
    const no = t.match(/(Bản án|Quyết định) số:\s*([^\n]+)\n\s*ngày\s*([\d/]+)/)
    if (no) { meta["Loại"] = no[1]; meta["Số"] = no[2].trim(); meta["Ngày"] = no[3] }
    const dl = document.querySelector('a[href*="t1cvn/"][download]') as HTMLAnchorElement | null
    const fr = document.querySelector("#iframe_pub") as HTMLIFrameElement | null
    const file = fr?.getAttribute("src")?.match(/file=([^&]+)/)?.[1]
    return { meta, pdf: dl?.getAttribute("href") ?? (file ? decodeURIComponent(file) : "") }
  })
  if (!info.meta["Số"] && !info.meta["Tên bản án"] && !info.meta["Tên quyết định"]) throw new Error(`Trang ${judgmentLink(id)} không có thông tin bản án (mã sai hoặc bản án đã bị gỡ).`)
  const pdfPath = info.pdf || `/3ta${id}t1cvn/`
  const { buf, type, status } = await fetchBinary(page, pdfPath)
  if (status !== 200 || (!/pdf/i.test(type) && buf.subarray(0, 4).toString() !== "%PDF")) throw new Error(`Không tải được tệp PDF bản án (HTTP ${status}, ${type || "?"}).`)
  const { text, pages, scan, ocr, ocrError, ocrAt } = await extractPdfText(buf, { ocr: true })
  const j: Judgment = { id, meta: info.meta, pdf: new URL(pdfPath, CBBA).href, text, pages, scan, fetched: Date.now(), ...(ocr ? { ocr } : {}), ...(ocrError ? { ocrError } : {}), ...(ocrAt ? { ocrAt } : {}) }
  writeJson(file, j)
  return j
}

const LAW_RE = /(?<!\p{L})(?:(?:điểm|khoản|Điều|các Điều|Mục)\s+[\p{L}\d,;.\s–-]{1,80}?\s+(?:của\s+)?)?(?:Bộ luật|Luật|Nghị quyết|Nghị định|Thông tư(?: liên tịch)?|Pháp lệnh|Công ước|Án lệ)\s+(?:số\s*:?\s*)?[^;\n()]{2,90}/gu

// "khoản 2 Điều 308 của Bộ luật Tố tụng dân sự", "các Điều 300, 301 Luật Thương mại 2005", "Án lệ số 09/2016/AL",
// "Nghị quyết 01/2019/NQ-HĐTP" … – only references that name an article or a numbered instrument, cut before
// the explanation that usually follows ("… quy định …", ": mức phạt …").
function citedLaw(paras: string[]) {
  const seen = new Map<string, string>()
  const TAIL = /\s*(:|\(|;|\.\s|\.$|,\s*(Hội đồng|Tòa án|nên|thì|không|do|vì|bên|các|nguyên đơn|bị đơn)(?=[\s,.]|$)|\s(quy định|xác định|điều chỉnh|hướng dẫn|về việc|về|thì|nên|để|mà|được|đã|là|không|khi|ngày|tại|theo|nhưng|và|của Ủy ban|của Hội đồng|của Chánh án|trong|có|với|đối với)(?=[\s,.]|$)).*$/u
  for (const p of paras) {
    for (const m of p.match(LAW_RE) ?? []) {
      let c = m.replace(/\s+/g, " ").replace(/\bsố\s*:\s*/giu, "số ").trim()
      if (!/^(điểm|khoản|Điều|các Điều|Mục|Án lệ|Nghị quyết\s+(số:?\s*)?\d|Nghị định\s+(số:?\s*)?\d|Thông tư\s+(số:?\s*)?\d)/.test(c)) continue
      const lawAt = c.search(/(Bộ luật|Luật|Nghị quyết|Nghị định|Thông tư|Pháp lệnh|Công ước|Án lệ)/)
      c = c.slice(0, lawAt) + c.slice(lawAt).replace(TAIL, "")
      c = c.replace(/[,\s–-]+$/, "").trim()
      const k = fold(c)
      if (c.length > 12 && ![...seen.keys()].some((x) => x.includes(k))) seen.set(k, c)
    }
  }
  return [...seen.values()]
}

function splitJudgment(text: string) {
  const ps = paragraphs(text)
  const idx = (re: RegExp, from = 0) => { const i = ps.slice(from).findIndex((p) => re.test(p)); return i < 0 ? -1 : i + from }
  const iContent = idx(/^(NỘI DUNG (VỤ ÁN|VỤ VIỆC|SỰ VIỆC)|Theo đơn khởi kiện|Theo (đơn|các tài liệu)|Tại đơn khởi kiện)/i)
  const iReason = idx(/^(NHẬN ĐỊNH CỦA (TÒA ÁN|HỘI ĐỒNG)|XÉT THẤY|Sau khi nghiên cứu các tài liệu)/i, Math.max(0, iContent))
  const iDecision = idx(/^(QUYẾT ĐỊNH|Vì các lẽ trên|VÌ CÁC LẼ TRÊN)\s*:?/, Math.max(0, iReason))
  const iEnd = idx(/^(Nơi nhận|TM\.? HỘI ĐỒNG|T\/M HỘI ĐỒNG|THẨM PHÁN\s*-?\s*CHỦ TỌA)/i, Math.max(0, iDecision))
  const head = ps.slice(0, iContent > 0 ? iContent : Math.min(ps.length, 60))
  const content = iContent >= 0 ? ps.slice(iContent, iReason > 0 ? iReason : undefined) : []
  const reason = iReason >= 0 ? ps.slice(iReason, iDecision > 0 ? iDecision : undefined) : []
  const decision = iDecision >= 0 ? ps.slice(iDecision, iEnd > 0 ? iEnd : undefined) : []
  return { ps, head, content, reason, decision }
}

const PARTY_RE = /^[-–•]?\s*(Nguyên đơn|Bị đơn|Người có quyền lợi[^:]*|Người yêu cầu[^:]*|Người kháng cáo|Viện kiểm sát kháng nghị|Người bị kiện|Người khởi kiện|Người phải thi hành[^:]*|Người được thi hành[^:]*)\s*:\s*(.*)$/i

export const judgment_document = tool({
  description: "Đọc MỘT bản án/quyết định trên congbobanan.toaan.gov.vn (link từ court_judgment_search): tải PDF qua Chrome, trích chữ và trả về cấu trúc gọn – số, ngày, tòa, cấp xét xử, các đương sự (đã ẩn danh như bản công bố), quan hệ tranh chấp, yêu cầu của đương sự, NHẬN ĐỊNH của Tòa (các đoạn chính, ưu tiên đoạn chứa 'focus'), QUYẾT ĐỊNH, căn cứ pháp luật được viện dẫn, link. Báo rõ nếu PDF là bản scan không có chữ. Bản án chỉ để tham khảo, không phải nguồn luật.",
  args: {
    url: tool.schema.string().describe("Link https://congbobanan.toaan.gov.vn/2ta<số>t1cvn/chi-tiet-ban-an hoặc mã số"),
    focus: tool.schema.string().optional().describe("Từ khóa để chọn đoạn nhận định liên quan, VD 'phạt vi phạm', 'bồi thường', 'lãi chậm trả'"),
    max_chars: tool.schema.number().optional().describe("Giới hạn ký tự cho phần nhận định (mặc định 5000)"),
  },
  async execute({ url, focus, max_chars }, context) {
    const id = judgmentId(url)
    return withPage(async (page) => {
      const j = await loadJudgment(page, id)
      const link = judgmentLink(id)
      const m = j.meta
      const title = `${m["Loại"] ?? "Bản án"} số ${m["Số"] ?? "?"} ngày ${m["Ngày"] ?? m["Ngày tuyên án"] ?? "?"}`
      const head = [
        `${title} – ${m["Tòa án xét xử"] ?? m["Tòa án giải quyết"] ?? ""}`,
        m["Tên bản án"] || m["Tên quyết định"] ? `Tên vụ việc: ${m["Tên bản án"] ?? m["Tên quyết định"]}` : "",
        `Cấp xét xử: ${m["Cấp xét xử"] ?? m["Cấp giải quyết"] ?? "?"} · Loại: ${m["Loại vụ/việc"] ?? "?"} · Quan hệ pháp luật: ${m["Quan hệ pháp luật"] ?? "?"} · Áp dụng án lệ: ${m["Áp dụng án lệ"] ?? "?"}`,
        `Link: ${link}`,
        `PDF: ${j.pdf}`,
        `Ngày tra cứu: ${today()}`,
      ].filter(Boolean)
      if (j.scan) {
        const msg = [...head, `⚠ Tệp PDF (${j.pages} trang) là BẢN SCAN không có lớp chữ – công cụ không trích được nội dung${j.ocrError ? ` (OCR không dùng được: ${j.ocrError})` : ""}. Chỉ dẫn các thông tin trên trang (ở trên); không suy diễn nội dung bản án.`, m["Thông tin về vụ/việc"] ? `Thông tin về vụ/việc (trên trang): ${m["Thông tin về vụ/việc"]}` : ""].filter(Boolean).join("\n")
        recordEvidence(context?.sessionID, { url: link, title, text: msg, source: "congbobanan.toaan.gov.vn", meta: { scan: true, pdf: j.pdf } })
        return msg
      }
      recordEvidence(context?.sessionID, { url: link, title, text: j.text, source: "congbobanan.toaan.gov.vn", meta: { pdf: j.pdf, ...m, ...(j.ocr ? ocrMetaOf(j.ocr) : {}) } })
      const { ps, head: hd, content, reason, decision } = splitJudgment(j.text)
      // Parties: the first line of each role in the heading part (the name may sit on the next paragraph).
      const parties: string[] = []
      hd.forEach((p, i) => {
        const pm = p.match(PARTY_RE)
        if (!pm || parties.some((x) => x.startsWith(pm[1]))) return
        const who = (pm[2].trim() || (hd[i + 1] ?? "").replace(/^\d+[.)/-]\s*|^[-–•]\s*/, "")).split(/[;.,]\s*(?:địa chỉ|trụ sở|cư trú|nơi cư trú|cùng địa chỉ|đại diện|người đại diện|sinh năm)/i)[0]
        if (who && !PARTY_RE.test(who)) parties.push(`${pm[1]}: ${clip(who, 200)}`)
      })
      const dispute = (ps.slice(0, 40).join(" ").match(/(?:về|V\/v)\s*(?:vụ án|việc)?\s*(?:kinh doanh,? thương mại|dân sự)?\s*[“"]([^”"]{5,250})[”"]/)?.[1]) ?? ps.slice(0, 15).find((p) => /^V\/v/i.test(p))?.replace(/^V\/v\s*/i, "") ?? m["Quan hệ pháp luật"] ?? ""
      // Claims: the plaintiff's / appellant's requests, strongest patterns first.
      const CLAIM_RES = [/(đơn khởi kiện|khởi kiện).{0,300}(yêu cầu|đề nghị)/i, /yêu cầu Tòa án|đề nghị Tòa án/i, /(nội dung )?kháng cáo.{0,40}(yêu cầu|đề nghị|toàn bộ|một phần)|kháng nghị.{0,120}đề nghị/i, /yêu cầu phản tố/i]
      const claims: string[] = []
      for (const re of CLAIM_RES) for (const p of [...content, ...reason]) {
        if (claims.length >= 4) break
        if (re.test(p) && !/^\+/.test(p) && p.length > 60 && !claims.includes(p)) claims.push(p)
      }
      // Reasoning: numbered paragraphs "[n]", "[3.1]", "[3.1a]" … (keeping continuation paragraphs), scored by focus words.
      const blocks: string[] = []
      for (const p of reason.slice(1)) {
        if (/^\[\d+(\.\d+)*[a-zđ]?\]/.test(p) || !blocks.length) blocks.push(p)
        else blocks[blocks.length - 1] += `\n${p}`
      }
      const fw = fold(focus ?? "").split(" ").filter((w) => w.length > 1)
      const cap = max_chars ?? 5000
      const scored = blocks.map((b, i) => {
        const f = fold(b)
        let s = 0
        if (fw.length) { if (f.includes(fw.join(" "))) s += 10; s += fw.filter((w) => f.includes(w)).length }
        if (/án phí|chi phí tố tụng|về tố tụng|thủ tục tố tụng|vắng mặt|hiệu lực pháp luật kể từ|trong thời hạn và đúng thủ tục|phạm vi kháng cáo/i.test(b.slice(0, 160))) s -= 5
        if (i === 0 && !b.startsWith("[")) s -= 3
        if (/chấp nhận|không chấp nhận|có cơ sở|không có cơ sở|vi phạm|phạt|bồi thường|lãi/i.test(b)) s += 1
        return { b, i, s }
      })
      const budget = { left: cap }
      const chosen = [...scored].sort((a, b) => b.s - a.s || a.i - b.i).filter((x) => x.s >= 0).filter((x) => {
        if (budget.left <= 200) return false
        budget.left -= Math.min(x.b.length, 1600)
        return true
      }).sort((a, b) => a.i - b.i).map((x) => clip(x.b, 1600))
      const laws = citedLaw([...decision, ...reason])
      const out = [
        ...head,
        j.ocr ? `${ocrLine(j.ocr)}\n(Mọi phần dưới đây đều là văn bản OCR từ bản scan)` : "",
        `\nĐƯƠNG SỰ (như bản công bố):`, parties.length ? parties.map((p) => `- ${p}`).join("\n") : "- (không tách được)",
        dispute ? `\nQUAN HỆ TRANH CHẤP: ${dispute}` : "",
        claims.length ? `\nYÊU CẦU / KHÁNG CÁO:\n${claims.map((c) => `- ${clip(c, 700)}`).join("\n")}` : "",
        `\nNHẬN ĐỊNH CỦA TÒA ÁN (${chosen.length}/${blocks.length} đoạn${focus ? `, ưu tiên "${focus}"` : ""}):`,
        chosen.length ? chosen.join("\n\n") : "(không tách được phần nhận định)",
        `\nQUYẾT ĐỊNH:`, decision.length ? clip(decision.filter((p) => !/^(QUYẾT ĐỊNH|VÌ CÁC LẼ TRÊN|Vì các lẽ trên)\s*:?$/.test(p)).join("\n"), 2500) : "(không tách được)",
        laws.length ? `\nCĂN CỨ PHÁP LUẬT ĐƯỢC VIỆN DẪN:\n${laws.slice(0, 25).map((l) => `- ${l}`).join("\n")}` : "",
        `\n(Toàn văn ${j.pages} trang, ${j.text.length} ký tự. Bản án chỉ là tài liệu tham khảo – không phải nguồn luật.)`,
      ].filter(Boolean).join("\n")
      return j.ocr ? withUi(out, ocrUiOf(j.ocr)) : out
    })
  },
})
