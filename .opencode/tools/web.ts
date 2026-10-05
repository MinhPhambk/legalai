// web_search / web_read: live research on the open web through the sandbox Chrome (same connection style as
// vbpl.ts) for questions the dedicated tools (vbpl_*, trav_*, fedreg_*, eurlex_*, eping_*, fta_*, court_*,
// fx_*) do not cover or returned nothing – so the agent looks the answer up instead of answering from memory.
//   web_search – a real search-engine page (DuckDuckGo HTML, then DuckDuckGo Lite, then Bing; Google answers
//                automated sessions with a CAPTCHA and is not used), restricted by default to official domains
//                (site: groups from ../lib/official-sources.ts); results flagged official / not. Recorded as
//                source "web_search" = LISTED only (grounding_check does not treat a listing as a read source).
//   web_read   – opens one page (or PDF, text via pdf.js; scans: OCR via ../lib/pdf-ocr.ts, labelled), extracts the main text, returns a focused excerpt
//                + title / date / domain / official flag, and records the FULL text as evidence (source = the
//                domain) so grounding_check can verify quotes and figures. Non-official domains are allowed
//                with a recorded "⚠ nguồn không chính thức" warning (caps confidence at trung bình).
// Polite access: ≤ 1 request / second per host, results cached 15 minutes, no login / paywall / CAPTCHA /
// Cloudflare handling – a blocked page is reported and the tool stops.
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import puppeteer from "puppeteer-core"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { throttle as politeThrottle } from "../lib/polite.ts"
import { recordEvidence, recordWarning } from "../lib/evidence.ts"
import { SEARCH_GROUPS, canonicalKey, docNumbersIn, officialOf, routeOf } from "../lib/official-sources.ts"
import { count, data, isoDate, textOf, withUi } from "../lib/ui-meta.ts"
import { ocrPdf, ocrBlock, ocrMeta, ocrRange, ocrUi, OCR_LABEL, type OcrResult } from "../lib/pdf-ocr.ts"

const PORT = process.env.CHROME_PORT ?? "9333"
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const today = () => new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" })

async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const page = await browser.newPage()
  try { return await fn(page) } finally { await page.close().catch(() => {}); browser.disconnect() }
}
// per-host limiter shared with all tools (../lib/polite.ts): ≤ 2 in flight, starts ≥ 1,1 s apart
const throttle = (host: string) => politeThrottle(host, { gapMs: 1100 })
const TTL = 15 * 60 * 1000
const cache = new Map<string, { at: number; v: any }>()
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.v
  const v = await fn()
  cache.set(key, { at: Date.now(), v })
  return v
}
class Blocked extends Error {}
const BLOCK_RE = /captcha|verify you are human|xác minh bạn là người|just a moment|attention required|cf-browser-verification|unusual traffic|lưu lượng truy cập bất thường|giải quyết thử thách|solve the challenge|access denied|request blocked|this page can't be displayed/i
function checkBlocked(title: string, text: string, host: string) {
  const head = `${title}\n${text.slice(0, 2500)}`
  if (BLOCK_RE.test(head) && text.length < 6000) throw new Blocked(`${host} yêu cầu xác minh / chặn truy cập tự động (CAPTCHA, Cloudflare hoặc tương tự) – dừng, không vượt qua`)
}

// ---------------------------------------------------------------- web_search
type Hit = { title: string; url: string; snippet: string }
const decodeDdg = (href: string) => {
  try { const u = new URL(href, "https://duckduckgo.com"); const t = u.searchParams.get("uddg"); return t ? decodeURIComponent(t) : u.href } catch { return href }
}
async function ddgHtml(page: any, q: string, lang: "vi" | "en"): Promise<Hit[]> {
  await throttle("duckduckgo.com")
  await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=${lang === "vi" ? "vn-vi" : "us-en"}`, { waitUntil: "domcontentloaded", timeout: 45000 })
  const r = await page.evaluate(() => ({
    title: document.title, text: document.body?.innerText ?? "",
    hits: [...document.querySelectorAll(".result")].filter((d) => !d.classList.contains("result--ad")).map((d) => ({
      title: (d.querySelector("a.result__a") as HTMLElement | null)?.innerText?.trim() ?? "",
      url: (d.querySelector("a.result__a") as HTMLAnchorElement | null)?.getAttribute("href") ?? "",
      snippet: (d.querySelector(".result__snippet") as HTMLElement | null)?.innerText?.trim() ?? "",
    })),
  }))
  checkBlocked(r.title, r.text, "duckduckgo.com")
  return r.hits.filter((h: Hit) => h.url).map((h: Hit) => ({ ...h, url: decodeDdg(h.url) }))
}
async function ddgLite(page: any, q: string, lang: "vi" | "en"): Promise<Hit[]> {
  await throttle("duckduckgo.com")
  await page.goto(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=${lang === "vi" ? "vn-vi" : "us-en"}`, { waitUntil: "domcontentloaded", timeout: 45000 })
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("a.result-link")]
    return {
      title: document.title, text: document.body?.innerText ?? "",
      hits: rows.map((a) => {
        const tr = a.closest("tr")
        const snip = tr?.nextElementSibling?.querySelector(".result-snippet") as HTMLElement | null
        return { title: (a as HTMLElement).innerText.trim(), url: a.getAttribute("href") ?? "", snippet: snip?.innerText?.trim() ?? "" }
      }),
    }
  })
  checkBlocked(r.title, r.text, "duckduckgo.com")
  return r.hits.filter((h: Hit) => h.url).map((h: Hit) => ({ ...h, url: decodeDdg(h.url) }))
}
async function bing(page: any, q: string, lang: "vi" | "en"): Promise<Hit[]> {
  await throttle("bing.com")
  await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=${lang}`, { waitUntil: "domcontentloaded", timeout: 45000 })
  const r = await page.evaluate(() => ({
    title: document.title, text: document.body?.innerText ?? "",
    hits: [...document.querySelectorAll("li.b_algo")].map((li) => ({
      title: (li.querySelector("h2 a") as HTMLElement | null)?.innerText?.trim() ?? "",
      url: (li.querySelector("h2 a") as HTMLAnchorElement | null)?.href ?? "",
      snippet: (li.querySelector(".b_caption p, p") as HTMLElement | null)?.innerText?.trim() ?? "",
    })),
  }))
  checkBlocked(r.title, r.text, "bing.com")
  return r.hits.filter((h: Hit) => h.url && !/bing\.com\/(aclick|ck\/a)/.test(h.url))
}
const ENGINES: [string, (p: any, q: string, l: "vi" | "en") => Promise<Hit[]>][] = [["DuckDuckGo", ddgHtml], ["DuckDuckGo Lite", ddgLite], ["Bing", bing]]
async function searchOnce(page: any, q: string, lang: "vi" | "en", notes: string[]): Promise<{ engine: string; hits: Hit[] } | null> {
  for (const [name, fn] of ENGINES) {
    try {
      const hits = await cached(`s|${name}|${lang}|${q}`, () => fn(page, q, lang))
      if (hits.length) return { engine: name, hits }
      notes.push(`${name}: không có kết quả`)
    } catch (e: any) { notes.push(`${name}: ${e?.message ?? e}`) }
  }
  return null
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "") } catch { return "" } }

export const search = tool({
  description:
    "TÌM TRÊN WEB (nguồn chính thức) bằng trình duyệt sandbox – dùng khi công cụ chuyên dụng (vbpl_*, chinhphu_*, trav_*, fedreg_*, eurlex_*, eping_*, fta_*, court_*, fx_*) không bao quát câu hỏi hoặc không trả về kết quả, hoặc khi bạn KHÔNG CHẮC / sắp trả lời theo trí nhớ. Mặc định chỉ tìm trong các tên miền chính thức (*.gov.vn, chinhphu.vn, vbpl.vn, quochoi.vn, trungtamwto.vn, VCCI; WTO, Federal Register, EU, trade.gov, World Bank, ITC…); kết quả gắn nhãn CHÍNH THỨC / KHÔNG CHÍNH THỨC. Đây chỉ là DANH SÁCH – phải mở bằng web_read (hoặc công cụ chuyên dụng) trước khi trích dẫn hay nêu số liệu.",
  args: {
    query: tool.schema.string().describe("Từ khóa ngắn gọn (khái niệm pháp lý / tên văn bản / mã HS), KHÔNG đưa tên doanh nghiệp, số tiền, nội dung hợp đồng của người dùng. VD 'nghị định hóa đơn điện tử 2025', 'thuế nhập khẩu ưu đãi MFN 7208'"),
    sites: tool.schema.array(tool.schema.string()).optional().describe("Tùy chọn: chỉ tìm trong các tên miền này (VD ['customs.gov.vn','mof.gov.vn']); ['*'] = không giới hạn (kết quả không chính thức bị gắn cảnh báo)"),
    lang: tool.schema.enum(["vi", "en"]).optional().describe("vi (mặc định khi từ khóa tiếng Việt) = ưu tiên cơ quan Việt Nam; en = ưu tiên nguồn quốc tế"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa (mặc định 8)"),
  },
  async execute({ query, sites, lang, limit }, context) {
    const L: "vi" | "en" = lang ?? (/[^\x00-\x7f]/.test(query) ? "vi" : "en")
    const max = Math.min(Math.max(1, limit ?? 8), 15)
    const notes: string[] = []
    const open = sites?.length === 1 && sites[0] === "*"
    const groups: string[][] = open ? [[]] : sites?.length ? [sites.map((s) => s.replace(/^https?:\/\/|\/.*$/g, "").replace(/^www\./, ""))] : [SEARCH_GROUPS[L], SEARCH_GROUPS[L === "vi" ? "en" : "vi"]]
    const out: (Hit & { host: string; label: string | null })[] = []
    let engine = "", usedFilter = ""
    try {
      await withPage(async (page) => {
        for (const g of groups) {
          const q = g.length ? `${query} ${g.map((d) => `site:${d}`).join(" OR ")}` : query
          const r = await searchOnce(page, q, L, notes)
          if (!r) continue
          engine = engine || r.engine
          usedFilter = usedFilter || (g.length ? g.join(", ") : "không lọc")
          for (const h of r.hits) {
            const host = hostOf(h.url)
            if (!host || out.some((x) => x.url === h.url)) continue
            out.push({ ...h, host, label: officialOf(host)?.label ?? null })
          }
          if (out.filter((x) => x.label).length >= 3 || sites?.length) break
        }
      })
    } catch (e: any) { notes.push(String(e?.message ?? e)) }
    const hits = out.sort((a, b) => Number(!!b.label) - Number(!!a.label)).slice(0, max)
    if (!hits.length)
      return withUi([`Không tìm được kết quả cho "${query}" (${notes.join("; ") || "không có kết quả"}).`, "Không trả lời theo trí nhớ: nói rõ \"chưa xác minh được\", thử từ khóa khác / công cụ chuyên dụng, hoặc gợi ý nơi người dùng có thể kiểm tra."].join("\n"), { res: count(0, "results") })
    const hintOf = (h: Hit & { label: string | null }) => {
      const r = routeOf(h.url)
      if (r) return `\n   → mở bằng ${r.hint(new URL(h.url))}`
      const nos = docNumbersIn(`${h.title} ${h.snippet}`)
      // a legal document seen on a non-official site: go to the official text
      if (!h.label && nos.length) return `\n   → văn bản gốc chính thức: ${nos.slice(0, 2).map((n) => `vbpl_find("${n}")`).join(" / ")} (không trích từ trang không chính thức)`
      return ""
    }
    const lines = hits.map((h, i) => `${i + 1}. [${h.label ? `CHÍNH THỨC – ${h.label}` : "⚠ KHÔNG CHÍNH THỨC"}] ${h.title}\n   ${h.url}\n   ${h.snippet.slice(0, 260)}${hintOf(h)}`)
    const text = [`Kết quả tìm kiếm "${query}" (${engine}; lọc: ${usedFilter}; ngày ${today()})`, ...lines].join("\n")
    recordEvidence(context?.sessionID, { url: `web-search://${engine}/${encodeURIComponent(query)}`, title: `Tìm kiếm: ${query}`, text, source: "web_search" })
    return withUi([
      text,
      notes.length ? `(Ghi chú: ${notes.join("; ")})` : "",
      "Đây chỉ là danh sách kết quả – mở bằng web_read(url, focus) (văn bản pháp luật trên vbpl.vn: vbpl_*) rồi mới trích dẫn / nêu số liệu; ưu tiên kết quả CHÍNH THỨC, văn bản gốc và bản mới nhất.",
    ].filter(Boolean).join("\n"), { res: { ...count(hits.length, "results"), official: hits.filter((h) => h.label).length } })
  },
})

// ---------------------------------------------------------------- web_read
let pdfjsLib: any
async function pdfjs() {
  if (pdfjsLib !== undefined) return pdfjsLib
  for (const c of ["pdfjs-dist/legacy/build/pdf.mjs", pathToFileURL(path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")).href]) {
    try { pdfjsLib = await import(c); return pdfjsLib } catch {}
  }
  pdfjsLib = null
  return null
}
function assertPublicUrl(raw: string): URL {
  let u: URL
  try { u = new URL(raw.trim()) } catch { throw new Error(`link không hợp lệ "${raw}"`) }
  if (!/^https?:$/.test(u.protocol)) throw new Error("chỉ mở link http(s)")
  const h = u.hostname.toLowerCase()
  if (/^(localhost|0\.0\.0\.0|\[?::1\]?)$|\.local$|^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) throw new Error("không mở địa chỉ nội bộ")
  return u
}
type Read = { url: string; title: string; text: string; date?: string; pdfPages?: number; files?: { name: string; url: string }[]; canonical?: string; ocr?: OcrResult }
async function readPdf(page: any, u: URL): Promise<Read> {
  await throttle(u.hostname)
  await page.goto(`${u.origin}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {})
  await throttle(u.hostname)
  const r = await page.evaluate(async (href: string) => {
    try {
      const res = await fetch(href, { credentials: "omit" })
      const b = new Uint8Array(await res.arrayBuffer())
      if (b.length > 25 * 1024 * 1024) return { status: res.status, error: "tệp quá lớn (> 25 MB)" }
      let s = ""
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
      return { status: res.status, b64: btoa(s) }
    } catch (e: any) { return { status: 0, error: String(e?.message ?? e) } }
  }, u.href)
  if (r.error || r.status >= 400) throw new Error(`không tải được PDF (${r.error ?? "HTTP " + r.status})`)
  const bytes = Buffer.from(r.b64, "base64")
  if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("tệp không phải PDF")
  const lib = await pdfjs()
  if (!lib) throw new Error("máy chưa có thư viện pdf.js (pdfjs-dist)")
  const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, verbosity: 0 })
  const doc = await task.promise
  let text = ""
  for (let p = 1; p <= Math.min(doc.numPages, 300); p++) {
    const c = await (await doc.getPage(p)).getTextContent()
    text += c.items.map((i: any) => i.str + (i.hasEOL ? "\n" : "")).join("") + "\n"
  }
  const pages = doc.numPages
  await Promise.resolve(task.destroy?.()).catch(() => {})
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()
  if (text.length < 200) {
    // scan without text layer → OCR fallback in the dedicated OCR Chrome (first 15 pages), labelled as OCR
    let r: OcrResult
    try { r = await ocrPdf(bytes, { maxPages: 15 }) } catch (e: any) {
      throw new Error(`PDF ${pages} trang gần như không có lớp chữ (bản scan) – không đọc được nội dung, chỉ có link (OCR không dùng được: ${String(e?.message ?? e).slice(0, 200)})`)
    }
    if (!r.pages.some((p) => p.text.length > 50)) throw new Error(`PDF ${pages} trang là bản scan và OCR không nhận dạng được chữ – chỉ có link`)
    return { url: u.href, title: path.basename(u.pathname), text: ocrBlock(r), pdfPages: pages, ocr: r }
  }
  return { url: u.href, title: path.basename(u.pathname), text, pdfPages: pages }
}
async function readHtml(page: any, u: URL): Promise<Read> {
  await throttle(u.hostname)
  const res = await page.goto(u.href, { waitUntil: "domcontentloaded", timeout: 60000 })
  const ct = String(res?.headers()?.["content-type"] ?? "")
  if (/application\/pdf/.test(ct)) return readPdf(page, new URL(page.url()))
  if ((res?.status() ?? 0) >= 400) throw new Error(`HTTP ${res?.status()} – trang không mở được`)
  await page.waitForFunction(() => (document.body?.innerText?.length ?? 0) > 400, { timeout: 12000 }).catch(() => {})
  for (let k = 0, last = -1; k < 6; k++) {
    const len = await page.evaluate(() => document.body?.innerText?.length ?? 0)
    if (len === last) break
    last = len
    await new Promise((r) => setTimeout(r, 600))
  }
  const r = await page.evaluate(() => {
    const meta = (sel: string) => (document.querySelector(sel) as HTMLMetaElement | null)?.content || ""
    const date = meta('meta[property="article:published_time"]') || meta('meta[name="pubdate"]') || meta('meta[name="publishdate"]') || meta('meta[itemprop="datePublished"]') || meta('meta[name="date"]') || meta('meta[name="DC.date.issued"]') || (document.querySelector("time[datetime]") as HTMLElement | null)?.getAttribute("datetime") || ""
    const cands = [...document.querySelectorAll("article, main, [role=main], #content, .content, .article, .article-content, .detail, .detail-content, .news-detail, .entry-content, .post, .noidung, .content-detail")] as HTMLElement[]
    let best: HTMLElement | null = null, bl = 0
    for (const c of cands) { const l = c.innerText?.length ?? 0; if (l > bl) { best = c; bl = l } }
    if (!best || bl < 600) {
      for (const el of document.querySelectorAll("nav, header, footer, aside, script, style, noscript, form, [role=navigation], .menu, .navbar, .footer, .header, .sidebar, .breadcrumb")) el.remove()
      best = document.body
    }
    // attached files of the document (official gazette pages publish the signed PDF as an attachment)
    const h1 = (document.querySelector("h1") as HTMLElement | null)?.innerText?.trim() ?? ""
    const no = h1.match(/(\d{1,4})\/(\d{4})/)
    const files = [...document.querySelectorAll("a[href]")].map((a) => ({ name: ((a as HTMLElement).innerText || "").trim(), url: (a as HTMLAnchorElement).href }))
      .filter((x) => /\.(pdf|docx?)(\b|$)/i.test(decodeURIComponent(x.url)) && !!no && (x.url.includes(`${no[1]}-${no[2]}`) || x.url.toLowerCase().includes(`${no[1]}%2f${no[2]}`) || x.name.includes(`${no[1]}/${no[2]}`)))
      .slice(0, 5)
    const canonical = (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || meta('meta[property="og:url"]') || ""
    return { title: h1 || document.title, text: best?.innerText ?? "", date, final: location.href, files, canonical }
  })
  checkBlocked(r.title, r.text, u.hostname)
  const text = r.text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()
  if (text.length < 150) throw new Error("trang gần như không có nội dung văn bản (có thể cần đăng nhập / chặn truy cập tự động / nội dung nằm trong tệp đính kèm)")
  const shown = text.slice(0, 1500).match(/(?:ngày\s+(?:ban hành|đăng|cập nhật)|published|updated|ngày)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]
  return { url: r.final, title: r.title.trim(), text, date: r.date ? String(r.date).slice(0, 10) : shown, files: r.files, canonical: r.canonical }
}
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase()
function excerpt(text: string, focus: string | undefined, cap: number) {
  if (!focus?.trim()) return text.slice(0, cap) + (text.length > cap ? `\n…(đã cắt, còn ${text.length - cap} ký tự – truyền focus để lấy đúng đoạn)` : "")
  // positions in the folded text map 1:1 to the original (NFD marks removed per character)
  const f = text.split("").map((ch) => (fold(ch) || " ")[0]).join("")
  const words = fold(focus).split(/\s+/).filter((w) => w.length > 1)
  const hits: number[] = []
  const key = fold(focus.trim())
  for (let at = f.indexOf(key); at >= 0 && hits.length < 6; at = f.indexOf(key, at + key.length)) hits.push(at)
  if (!hits.length) for (const w of words) { const at = f.indexOf(w); if (at >= 0) hits.push(at) }
  if (!hits.length) return `(Không thấy "${focus}" trong trang – hiện phần đầu.)\n` + text.slice(0, Math.min(cap, 2500))
  hits.sort((a, b) => a - b)
  const per = Math.max(700, Math.floor(cap / Math.min(hits.length, 4)))
  const parts: string[] = []
  let lastEnd = -1
  for (const h of hits.slice(0, 4)) {
    const s = Math.max(0, h - Math.floor(per / 3), lastEnd)
    const e = Math.min(text.length, s + per)
    if (e <= s) continue
    parts.push((s > 0 ? "…" : "") + text.slice(s, e) + (e < text.length ? "…" : ""))
    lastEnd = e
  }
  return parts.join("\n[…]\n")
}

export const read = tool({
  description:
    "ĐỌC MỘT TRANG WEB / TỆP PDF (link từ web_search hoặc do người dùng đưa) bằng trình duyệt sandbox: trích nội dung chính, trả về đoạn liên quan (focus), tiêu đề, ngày đăng/ban hành (nếu có), tên miền và nhãn CHÍNH THỨC / KHÔNG CHÍNH THỨC; toàn văn được ghi nhận để grounding_check kiểm tra trích dẫn và số liệu. Chỉ trích dẫn / nêu số liệu có trong nội dung đã đọc. Trang yêu cầu đăng nhập, CAPTCHA, Cloudflare → công cụ dừng và báo (không vượt qua). Nguồn không chính thức → cảnh báo, độ tin cậy tối đa TRUNG BÌNH.",
  args: {
    url: tool.schema.string().describe("Link http(s) cần đọc"),
    focus: tool.schema.string().optional().describe("Cụm từ cần tìm trong trang để lấy đúng đoạn, VD 'hiệu lực thi hành', '7208', 'mức thuế'"),
    max_chars: tool.schema.number().optional().describe("Độ dài tối đa đoạn trích trả về (mặc định 6000)"),
  },
  async execute({ url, focus, max_chars }, context) {
    let u: URL
    try { u = assertPublicUrl(url) } catch (e: any) { return `Lỗi: ${e.message}.` }
    // domains with a dedicated tool: delegate to it (its parsing + evidence), never fetch generically
    const route = routeOf(u.href)
    if (route) {
      const art = route.module === "vbpl" ? focus?.match(/(?:điều|article)\s*(\d+[a-zđ]?)/i)?.[1] : undefined
      const args = art ? { url: u.href, article: art } : route.args(u, focus)
      if (!args) return `Link ${u.hostname}: nguồn này có công cụ chuyên dụng – dùng ${route.hint(u)} thay cho web_read.`
      const name = art ? "article" : route.exportName
      try {
        const mod: any = await import(`./${route.module}.ts`)
        const out = await mod[name].execute(args, context)
        const text = `(web_read → ${route.module === "vbpl" ? `vbpl_${name}` : route.tool}: nguồn có công cụ chuyên dụng, kết quả dưới đây do công cụ đó trả về)\n${textOf(out)}`
        // keep the delegated tool's UI metadata (step result, document) for the web
        return typeof out === "object" && out?.metadata ? { title: "", output: text, metadata: out.metadata } : text
      } catch (e: any) {
        return `Link ${u.hostname}: dùng ${route.hint(u)} (gọi tự động lỗi: ${e?.message ?? e}).`
      }
    }
    let r: Read
    try {
      r = await cached(`r|${u.href}`, () => withPage((page) => (/\.pdf($|[?&#])/i.test(u.pathname) || /[=/][^&=]*\.pdf($|&)/i.test(decodeURIComponent(u.search)) ? readPdf(page, u) : readHtml(page, u))))
    } catch (e: any) {
      const blocked = e instanceof Blocked
      return [`${blocked ? "BỊ CHẶN" : "Không đọc được"}: ${u.href} – ${e?.message ?? e}.`, blocked ? "Không tìm cách vượt qua; thử kết quả khác trong web_search hoặc công cụ chuyên dụng." : "Thử link khác / công cụ chuyên dụng. Không trả lời theo trí nhớ."].join("\n")
    }
    const host = hostOf(r.url) || u.hostname
    const off = officialOf(host)
    const sid = context?.sessionID
    // alternate URLs of the same page: the requested link and the page's canonical (official) URL
    const alt = [...new Set([u.href, r.canonical ?? ""].filter((x) => x && canonicalKey(x) !== canonicalKey(r.url) && (x === u.href || officialOf(hostOf(x)))))]
    recordEvidence(sid, { url: r.url, title: r.title, text: r.text, source: host, meta: { official: !!off, ...(alt.length ? { alt_urls: alt } : {}), ...(r.ocr ? ocrMeta(r.ocr) : {}) } })
    if (!off) recordWarning(sid, r.url, `⚠ Nguồn không chính thức: ${host} (không thuộc danh sách cơ quan / tổ chức chính thức) – chỉ tham khảo, đối chiếu với văn bản gốc trên nguồn chính thức.`)
    const cap = Math.min(Math.max(1000, max_chars ?? 6000), 15000)
    const ui = { card: { kind: "web", title: data(r.title), url: r.url, host, official: !!off, ...(off ? { officialDomain: off.domain } : {}), ...(isoDate(r.date) ? { date: isoDate(r.date) } : {}), chars: String(r.text.length), ...(r.pdfPages ? { pages: r.pdfPages } : {}) }, ...(r.ocr ? ocrUi(r.ocr) : {}) }
    return withUi([
      `Trang: ${r.title || "(không có tiêu đề)"}`,
      `Link: ${r.url}`,
      `Tên miền: ${host} – ${off ? `NGUỒN CHÍNH THỨC (${off.label})` : "⚠ NGUỒN KHÔNG CHÍNH THỨC – chỉ tham khảo; độ tin cậy tối đa TRUNG BÌNH"}`,
      r.date ? `Ngày đăng / ban hành (theo trang): ${r.date}` : "Ngày đăng: không xác định trên trang",
      r.files?.length ? `Tệp đính kèm (văn bản gốc – đọc bằng web_read(link tệp)):\n${r.files.map((x) => `  - ${x.name || "tệp"}: ${x.url}`).join("\n")}` : "",
      `Ngày truy cập: ${today()} · ${r.pdfPages ? `PDF ${r.pdfPages} trang, ` : ""}${r.text.length.toLocaleString("vi-VN")} ký tự`,
      r.ocr ? `⚠ PDF là bản scan – nội dung dưới đây do OCR (${r.ocr.engine}, trang ${ocrRange(r.ocr)}) nhận dạng${r.ocr.warnings.length ? `; ${r.ocr.warnings.join("; ")}` : ""}. Độ tin cậy tối đa TRUNG BÌNH.` : "",
      `--- NỘI DUNG${focus ? ` (đoạn chứa "${focus}")` : ""} ---`,
      r.ocr && !excerpt(r.text, focus, cap).startsWith(OCR_LABEL) ? `${OCR_LABEL}\n${excerpt(r.text, focus, cap)}` : excerpt(r.text, focus, cap),
      "--- HẾT ---",
      "Chỉ trích dẫn / nêu số liệu có trong nội dung trên (kèm link và ngày truy cập); văn bản pháp luật: kiểm tra tình trạng hiệu lực (vbpl_find → vbpl_document) khi có thể.",
    ].filter(Boolean).join("\n"), ui)
  },
})

