// Import / export tariff lookup by HS code from OFFICIAL sources, through the sandbox Chrome (DevTools port on
// 127.0.0.1:$CHROME_PORT, started by run.sh); every request goes through the shared per-host limiter
// (../lib/polite.ts), results are cached (memory 15 min, disk under .sandbox/cache/legalai/tariff/):
//   tariff_vn     – Viet Nam: the Customs tariff database behind the public "Tra cứu Biểu thuế" detail pages of
//                   customs.gov.vn (index.jsp?pageId=24&Id=<mã HS> – the same in-page JSON calls those public pages
//                   make; the free-text search form is behind a CAPTCHA and is NOT used) → MFN (ưu đãi), thông
//                   thường, every FTA schedule with its legal basis; FTA rates for the requested YEAR are read from
//                   the annex of the Nghị định itself (the .docx attachments of the document on vbpl.vn, parsed
//                   locally, year / roadmap column chosen from the header or from the decree's own "cột (I)… (VII)"
//                   clauses); status (hiệu lực) from vbpl.vn; amending decrees found on vbpl.vn are scanned for the code
//   tariff_us     – United States: the official USITC HTS REST API (hts.usitc.gov/reststop) → General (NTR/MFN),
//                   Special, Column 2, units, footnotes, the Chapter 99 lines those footnotes cite, and the
//                   Chapter 99 lines that name Viet Nam (additional duties) – HTS revision + dates
//   tariff_eu     – European Union: the European Commission's Access2Markets API (trade.ec.europa.eu, data from
//                   TARIC) → third-country duty, tariff preference for the origin (EVFTA for VN), anti-dumping /
//                   countervailing / safeguard / quotas with additional codes and the regulation (CELEX)
//                   (ec.europa.eu/taxation_customs/dds2/taric is disallowed in robots.txt → not fetched)
//   tariff_search – description → candidate HS codes from the official nomenclature text (VN: Phụ lục II Nghị định
//                   26/2023/NĐ-CP on vbpl.vn; US: HTS search; EU: HTS HS6 candidates → EU nomenclature), SUGGESTIONS only
// No login / CAPTCHA / Cloudflare handling: a blocked page is reported and the tool stops.
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import puppeteer from "puppeteer-core"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { recordEvidence, recordWarning } from "../lib/evidence.ts"
import { polite, politeEval, politeGoto } from "../lib/polite.ts"
import { docxBlocks, expandRow } from "../lib/docx-lite.ts"
import { count, data, isoDate, textOf, withUi } from "../lib/ui-meta.ts"

// ---- web result card (language-neutral: codes, plain decimal rates, ISO dates; descriptions as data) ----
/** "0" / "7,5" / "Free" / "12.00 %" / "*" → { free, pct } (pct = plain decimal string or null). */
function rateUi(raw: string) {
  const s = String(raw ?? "").trim()
  if (/^free\b/i.test(s)) return { free: true, pct: "0" }
  const eq = s.match(/\[=\s*([\d.,]+)\s*%\]/)
  const m = eq ?? s.match(/^([\d]+(?:[.,]\d+)?)\s*%?$/)
  if (!m) return { free: false, pct: null as string | null }
  const n = m[1].replace(",", ".").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
  return { free: Number(n) === 0, pct: n }
}
const VN_COL: Record<string, string> = { NK_uu_dai: "mfn", NK_TT: "normal", XK: "export" }
/** Customs schedule code → FTA code shown in the card ("EVFTA_NK" → "EVFTA"). */
const vnFta = (code: string) => code.replace(/^XK_/, "").replace(/_(NK|XK)$/, "")
/** HTS release dates are US style "09/15/2026" → "2026-09-15". */
const usDate = (s?: string) => { const m = String(s ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : isoDate(s) }

const PORT = process.env.CHROME_PORT ?? "9333"
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const CACHE = path.join(process.env.XDG_CACHE_HOME ?? path.join(ROOT, ".sandbox", "cache"), "legalai", "tariff")
const DAY = 24 * 3600 * 1000
const CITE = "→ Khi trả lời: nêu NGUYÊN VĂN thuế suất + số hiệu văn bản / bản biểu thuế + link nguồn ở trên + ngày tra cứu; không tự thêm thông tin ngoài kết quả (VD loại C/O – tra fta_search(fta, \"quy tắc xuất xứ\")); chạy grounding_check trước khi gửi (skill citation-check)."

const today = () => new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" })
const thisYear = () => Number(new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()))
const isoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date())
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
const slugify = (s: string) => fold(s).replace(/ /g, "-")
const digits = (s: string) => String(s ?? "").replace(/\D/g, "")
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const page = await browser.newPage()
  try { return await fn(page) } finally { await page.close().catch(() => {}); browser.disconnect() }
}
const mem = new Map<string, { at: number; v: any }>()
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = mem.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.v
  const v = await fn()
  mem.set(key, { at: Date.now(), v })
  return v
}
function readDisk<T>(name: string, ttl: number): T | null {
  try {
    const f = path.join(CACHE, name)
    if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < ttl) return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {}
  return null
}
function writeDisk(name: string, v: unknown) {
  try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(path.join(CACHE, name), JSON.stringify(v)) } catch {}
}
class Blocked extends Error {}
/** "VN" / "Vietnam" / "Việt Nam" → "VN"; other names of a few partners; otherwise the first 2 letters of an ISO code. */
function iso2(v: string | undefined, dflt = "VN") {
  const f = fold(v ?? "")
  if (!f) return dflt
  const names: Record<string, string> = { "viet nam": "VN", vietnam: "VN", vnm: "VN", "trung quoc": "CN", china: "CN", "han quoc": "KR", korea: "KR", "nhat ban": "JP", japan: "JP", "an do": "IN", india: "IN", thailand: "TH", "thai lan": "TH", indonesia: "ID", malaysia: "MY", phap: "FR", france: "FR", duc: "DE", germany: "DE" }
  if (names[f]) return names[f]
  return /^[a-z]{2}$/.test(f) ? f.toUpperCase() : dflt
}
const BLOCK_RE = /captcha|verify you are human|just a moment|attention required|access denied|request blocked/i

/** HS code formatted the way each schedule prints it. */
const dotVN = (d: string) => (d.length <= 4 ? d : d.length <= 6 ? `${d.slice(0, 4)}.${d.slice(4)}` : d.length <= 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}.${d.slice(8)}`)
const dotEU = (d: string) => [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join(" ")
/** "2.5" / "2,5" → "2,5%"; "*" and text kept verbatim. */
const pctVi = (raw: string) => { const r = String(raw ?? "").trim(); return /^\d+(?:[.,]\d+)?$/.test(r) ? `${r.replace(".", ",")}%` : r || "(trống)" }
/** "12.00 %" → "12.00 % [= 12%]" so the plain figure can be cited and checked. */
const pctPlain = (raw: string) => {
  const m = String(raw ?? "").match(/^(\d+)[.,](\d+)\s?%$/)
  if (!m) return raw
  const n = m[2].replace(/0+$/, "")
  return `${raw} [= ${m[1]}${n ? "," + n : ""}%]`
}
function badCode(hs: string, min: number, max: number): string | null {
  const d = digits(hs)
  if (!d || /[a-z]{3,}/i.test(hs)) return `"${hs}" không phải mã HS. Nhập mã số (VD 7208.39, 0306.17.19); để tìm mã theo mô tả hàng hóa dùng tariff_search.`
  if (d.length < min) return `Mã HS "${hs}" quá ngắn – cần ít nhất ${min} chữ số (VD 7208 hoặc 7208.39).`
  if (d.length > max) return `Mã HS "${hs}" quá dài – tối đa ${max} chữ số.`
  return null
}

// =====================================================================================================
// Viet Nam – customs.gov.vn tariff database
// =====================================================================================================
const CUS = "https://www.customs.gov.vn"
const CUS_API = "/bridge?url=/customs/servletws/bieuthue/APIBieuThue"
const cusDetailUrl = (d: string) => `${CUS}/index.jsp?pageId=24&Id=${d}&cid=1201`

type VnType = { code: string; label: string; kind: "import" | "export"; aliases: string[]; partner?: RegExp }
const VN_TYPES: VnType[] = [
  { code: "NK_uu_dai", label: "Nhập khẩu ưu đãi (MFN)", kind: "import", aliases: ["mfn", "uu dai", "nk uu dai", "wto", "ưu đãi"] },
  { code: "NK_TT", label: "Nhập khẩu thông thường", kind: "import", aliases: ["thong thuong", "normal", "nk tt"] },
  { code: "ATIGA", label: "ASEAN (ATIGA)", kind: "import", aliases: ["atiga", "afta", "asean", "aec"] },
  { code: "ACFTA", label: "ASEAN – Trung Quốc (ACFTA)", kind: "import", aliases: ["acfta"] },
  { code: "AJCEP", label: "ASEAN – Nhật Bản (AJCEP)", kind: "import", aliases: ["ajcep"] },
  { code: "AKFTA", label: "ASEAN – Hàn Quốc (AKFTA)", kind: "import", aliases: ["akfta"] },
  { code: "AHKFTA", label: "ASEAN – Hồng Kông (AHKFTA)", kind: "import", aliases: ["ahkfta"] },
  { code: "AANZFTA", label: "ASEAN – Úc – New Zealand (AANZFTA)", kind: "import", aliases: ["aanzfta"] },
  { code: "AIFTA", label: "ASEAN – Ấn Độ (AIFTA)", kind: "import", aliases: ["aifta"] },
  { code: "VJEPA", label: "Việt Nam – Nhật Bản (VJEPA)", kind: "import", aliases: ["vjepa"] },
  { code: "VKFTA", label: "Việt Nam – Hàn Quốc (VKFTA)", kind: "import", aliases: ["vkfta"] },
  { code: "VN-EAEU", label: "Việt Nam – Liên minh Kinh tế Á – Âu (VN-EAEU FTA)", kind: "import", aliases: ["vn eaeu", "eaeu", "vneaeu"] },
  { code: "EVFTA_NK", label: "Việt Nam – EU (EVFTA)", kind: "import", aliases: ["evfta", "eu"] },
  { code: "UKVFTA_NK", label: "Việt Nam – Vương quốc Anh (UKVFTA)", kind: "import", aliases: ["ukvfta", "uk"] },
  { code: "VCFTA", label: "Việt Nam – Chi-lê (VCFTA)", kind: "import", aliases: ["vcfta", "chile"] },
  { code: "VNL", label: "Việt Nam – Lào", kind: "import", aliases: ["vnl", "lao"] },
  { code: "VNCB", label: "Việt Nam – Cu Ba", kind: "import", aliases: ["vncb", "cuba"] },
  { code: "CPTPP_NK_MEX", label: "CPTPP – Mê-hi-cô", kind: "import", aliases: ["cptpp", "cptpp mex", "cptpp mexico"], partner: /Mê-hi-cô/ },
  { code: "CPTPP_NK", label: "CPTPP – các nước khác", kind: "import", aliases: ["cptpp"], partner: /Ô-xtrây-li-a|Ca-na-đa|Nhật Bản/ },
  { code: "RCEP_ASEAN", label: "RCEP – các nước ASEAN", kind: "import", aliases: ["rcep", "rcep asean"] },
  { code: "RCEP_AU", label: "RCEP – Ô-xtrây-li-a", kind: "import", aliases: ["rcep", "rcep au"] },
  { code: "RCEP_CN", label: "RCEP – Trung Quốc", kind: "import", aliases: ["rcep", "rcep cn"] },
  { code: "RCEP_JP", label: "RCEP – Nhật Bản", kind: "import", aliases: ["rcep", "rcep jp"] },
  { code: "RCEP_KR", label: "RCEP – Hàn Quốc", kind: "import", aliases: ["rcep", "rcep kr"] },
  { code: "RCEP_NZ", label: "RCEP – Niu Di-lân", kind: "import", aliases: ["rcep", "rcep nz"] },
  { code: "XK", label: "Xuất khẩu", kind: "export", aliases: ["xk", "xuat khau", "mfn", "export"] },
  { code: "EVFTA_XK", label: "Xuất khẩu ưu đãi EVFTA", kind: "export", aliases: ["evfta", "eu"] },
  { code: "CPTPP_XK_MEX", label: "Xuất khẩu ưu đãi CPTPP – Mê-hi-cô", kind: "export", aliases: ["cptpp"], partner: /Mê-hi-cô/ },
  { code: "CPTPP_XK", label: "Xuất khẩu ưu đãi CPTPP – các nước khác", kind: "export", aliases: ["cptpp"], partner: /Ô-xtrây-li-a|Ca-na-đa|Nhật Bản/ },
  { code: "UKVFTA_XK", label: "Xuất khẩu ưu đãi UKVFTA", kind: "export", aliases: ["ukvfta", "uk"] },
]
// FTAs whose schedule is not in the Customs database: found on vbpl.vn by title words.
const VN_EXTRA: { code: string; label: string; aliases: string[]; query: string; must: string }[] = [
  { code: "VIFTA", label: "Việt Nam – Israel (VIFTA)", aliases: ["vifta", "israel"], query: "biểu thuế nhập khẩu ưu đãi đặc biệt nhà nước Ixraen", must: "ixraen" },
  { code: "CEPA", label: "Việt Nam – UAE (CEPA)", aliases: ["cepa", "uae"], query: "biểu thuế nhập khẩu ưu đãi đặc biệt các Tiểu vương quốc Ả-rập thống nhất", must: "tieu-vuong-quoc" },
]
function resolveTypes(fta: string | undefined, kind: "import" | "export") {
  const pool = VN_TYPES.filter((t) => t.kind === kind)
  const base = pool.filter((t) => (kind === "import" ? ["NK_uu_dai", "NK_TT"] : ["XK"]).includes(t.code))
  if (!fta || /^(all|tat ca|tất cả|\*)$/i.test(fta.trim())) return { types: pool, extra: kind === "import" ? VN_EXTRA : [], unknown: [] as string[] }
  const types = new Map<string, VnType>(base.map((t) => [t.code, t]))
  const extra: typeof VN_EXTRA = []
  const unknown: string[] = []
  for (const raw of fta.split(/[,;/+]| và | and /)) {
    const f = fold(raw)
    if (!f) continue
    const hit = pool.filter((t) => t.aliases.includes(f) || fold(t.code) === f)
    const ex = kind === "import" ? VN_EXTRA.filter((x) => x.aliases.includes(f) || fold(x.code) === f) : []
    hit.forEach((t) => types.set(t.code, t))
    extra.push(...ex)
    if (!hit.length && !ex.length) unknown.push(raw.trim())
  }
  return { types: [...types.values()], extra, unknown }
}

async function customsApi(page: any, body: Record<string, string>): Promise<any[]> {
  if (!page.url().startsWith(CUS)) {
    const res = await politeGoto(page, `${CUS}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e: any) => { throw new Blocked(`không kết nối được customs.gov.vn: ${String(e?.message ?? e).slice(0, 80)}`) })
    if ((res?.status() ?? 0) >= 500) throw new Blocked(`customs.gov.vn trả về HTTP ${res?.status()}`)
  }
  const r: { s: number; t: string } = await politeEval(CUS, page, async (u: string, b: string) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 40000)
    try {
      const res = await fetch(u, { method: "POST", body: b, headers: { "content-type": "application/json; charset=UTF-8", "x-requested-with": "XMLHttpRequest" }, signal: ctl.signal })
      return { s: res.status, t: await res.text() }
    } catch (e: any) { return { s: 0, t: String(e?.message ?? e) } } finally { clearTimeout(timer) }
  }, CUS_API, JSON.stringify(body))
  if (r.s === 0 || r.s >= 500) throw new Blocked(`CSDL Biểu thuế customs.gov.vn không phản hồi (${r.s ? "HTTP " + r.s : r.t.slice(0, 80)})`)
  if (/captcha/i.test(r.t) && r.t.length < 300) throw new Blocked("customs.gov.vn yêu cầu mã xác nhận (CAPTCHA) – dừng, không vượt qua")
  if (!r.t.trim()) return []
  try { const j = JSON.parse(r.t); return Array.isArray(j) ? j : [] } catch { return [] }
}
const customsList = (page: any, d: string) => cached(`cl|${d}`, 15 * 60_000, () => customsApi(page, { l_class: "TIM_KIEM", l_action: "GET", l_param: d, l_bieu_thue: "" }))
const customsDetail = (page: any, d: string, types: string[]) => cached(`cd|${d}|${types.join(",")}`, 15 * 60_000, () => customsApi(page, { l_class: "TIM_KIEM", l_action: "GET", l_bieu_thue: types.join(","), l_param: "detail", l_ma_hs: d }))

const vnDate = (s: string) => { const m = String(s ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : null }
function coversYear(from: string, to: string, year: number) {
  const a = vnDate(from), b = vnDate(to)
  const y0 = Date.UTC(year, 0, 1), y1 = Date.UTC(year, 11, 31)
  return (!a || a.getTime() <= y1) && (!b || b.getTime() >= y0)
}

// ------------------------------------------------------------------ vbpl.vn documents (annex attachments)
const STATUSES = ["Còn hiệu lực", "Hết hiệu lực một phần", "Hết hiệu lực toàn bộ", "Chưa có hiệu lực", "Ngưng hiệu lực một phần", "Ngưng hiệu lực toàn bộ", "Ngưng hiệu lực", "Không còn phù hợp"]
type VTable = { file: string; caption: string; labels: string[]; rows: string[][] }
type VDoc = { url: string; key: string; title: string; status: string | null; effective: string | null; checkedAt: number; files: { name: string; url: string; size: number }[]; tables: VTable[]; text: string; notes: string[]; complete?: boolean }
const GATEWAY = "https://vbpl-bientap-gateway.moj.gov.vn/api/qtdc/public/doc/minio/buckets/vbpl"
// Windows-1252 characters of bytes 0x80–0x9F (index = byte − 0x80; "\0" = undefined in cp1252)
const CP1252 = "€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ"
const CODE_RE = /^\d{2}\.\d{2}$|^\d{4}(?:\.\d{2}){1,3}$|^\d{8}$/

async function vbplFind(query: string, limit = 25): Promise<string[]> {
  const mod: any = await import("./vbpl.ts")
  const out = textOf(await mod.find.execute({ query, limit }, {}))
  return [...out.matchAll(/https:\/\/vbpl\.vn\/van-ban\/chi-tiet\/\S+/g)].map((m) => m[0])
}
const slugOf = (u: string) => decodeURIComponent(u.split("/van-ban/chi-tiet/")[1] ?? "")
/** vbpl URL of a document number ("116/2022/NĐ-CP") + the documents amending it (by title). */
async function vbplByNumber(no: string): Promise<{ base: string | null; amending: string[] }> {
  return cached(`vn|${no}`, DAY, async () => {
    const num = slugify(no)
    const has = new RegExp(`(^|-)${num}(-|$)`)
    const urls = await vbplFind(no, 25)
    const head = (u: string) => slugOf(u).replace(/^(nghi-dinh|quyet-dinh|nghi-quyet|thong-tu|luat)-(so-)?/, "")
    const base = urls.find((u) => head(u).startsWith(num + "-") || head(u) === num) ?? null
    const amending = urls.filter((u) => u !== base && has.test(slugOf(u)) && /sua-doi|bo-sung|keo-dai|dinh-chinh|bai-bo|thay-the/.test(slugOf(u)) && !head(u).startsWith(num + "-"))
    return { base, amending }
  })
}

function tablesOf(file: string, buf: Buffer): VTable[] {
  const blocks = docxBlocks(buf)
  const out: VTable[] = []
  let paras: string[] = []
  let annex = ""
  let collecting = 0
  for (const b of blocks) {
    if (b.kind === "p") {
      paras.push(b.text)
      if (paras.length > 8) paras.shift()
      // the annex title ("Phụ lục II / BIỂU THUẾ … / (Kèm theo Nghị định số …)") applies to every table after it
      if (/^Phụ lục\s+[IVX\d]+\b/i.test(b.text)) { annex = b.text; collecting = 5 }
      else if (collecting > 0) { annex = `${annex} / ${b.text}`.slice(0, 300); collecting-- }
      continue
    }
    collecting = 0
    const rows = b.rows.map((r) => expandRow(r).map((c) => (c.vmerge ? "^" : c.text)))
    const capHere = paras.join(" / ")
    paras = []
    // header = rows before the first data row (a row carrying a code / chapter title)
    const firstData = rows.findIndex((r) => r.some((c) => CODE_RE.test(c.trim()) || /^Chương \d+/.test(c.trim())))
    if (firstData < 0) continue
    const header = rows.slice(0, firstData)
    const width = Math.max(...rows.slice(0, firstData + 5).map((r) => r.length))
    const labels = Array.from({ length: width }, (_, i) => [...new Set(header.map((r) => (r[i] ?? "").trim()).filter((x) => x && x !== "^"))].join(" "))
    // code rows + description-only rows ("- Cá cảnh:") that give the hierarchy
    const data = rows.slice(firstData).filter((r) => r.some((c) => CODE_RE.test(c.trim()) || /^-\s/.test(c.trim())))
    out.push({ file, caption: annex || capHere.slice(0, 300) || `Phụ lục (tệp ${file})`, labels, rows: data })
  }
  return out
}

async function fetchBytes(page: any, url: string): Promise<{ status: number; b64?: string; error?: string }> {
  return polite(url, () => page.evaluate(async (u: string) => {
    try {
      const res = await fetch(u)
      const b = new Uint8Array(await res.arrayBuffer())
      let s = ""
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
      return { status: res.status, b64: btoa(s) }
    } catch (e: any) { return { status: 0, error: String(e?.message ?? e) } }
  }, url), { gapMs: 1200 })
}

let pdfjsLib: any
async function pdfjs() {
  if (pdfjsLib !== undefined) return pdfjsLib
  for (const c of ["pdfjs-dist/legacy/build/pdf.mjs", pathToFileURL(path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")).href]) {
    try { pdfjsLib = await import(c); return pdfjsLib } catch {}
  }
  pdfjsLib = null
  return null
}
async function pdfText(bytes: Buffer): Promise<string> {
  const lib = await pdfjs()
  if (!lib) return ""
  const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, verbosity: 0 })
  const doc = await task.promise
  let text = ""
  for (let p = 1; p <= Math.min(doc.numPages, 200); p++) {
    const c = await (await doc.getPage(p)).getTextContent()
    text += c.items.map((i: any) => i.str + (i.hasEOL ? "\n" : "")).join("") + "\n"
  }
  await Promise.resolve(task.destroy?.()).catch(() => {})
  return text
}

/** Open a vbpl.vn document: status, text, attachment list; .docx attachments parsed into tables (cached on disk). */
async function vbplDoc(page: any, url: string, opts: { attachments: boolean } = { attachments: true }): Promise<VDoc> {
  const key = slugOf(url).split("--").pop() || slugify(url).slice(-40)
  const file = `vbpl-${key.replace(/[^\w-]/g, "_")}.json`
  const prev = readDisk<VDoc>(file, 3650 * DAY)
  if (prev && Date.now() - prev.checkedAt < DAY && (!opts.attachments || prev.complete)) return prev
  const files: { name: string; path: string; size: number }[] = []
  const onResp = async (r: any) => {
    if (!/vbpl\.vn\/van-ban\/chi-tiet/.test(r.url())) return
    try {
      const t = Buffer.from(await r.buffer()).toString("utf8")
      // the payload carries UTF-8 file names that were decoded as Latin-1 once ("NÄ 26_2023…") – undo that
      // (Latin-1 or Windows-1252: "Ä‘" = 0xC4 0x91)
      const fix = (s: string) => {
        if (!/[ÃÄÆá»]/.test(s)) return s
        const bytes: number[] = []
        for (const ch of s) {
          const c = ch.codePointAt(0)!
          const b = c < 256 ? c : CP1252.indexOf(ch) >= 0 ? 0x80 + CP1252.indexOf(ch) : -1
          if (b < 0) return s
          bytes.push(b)
        }
        const f = Buffer.from(bytes).toString("utf8")
        return f.includes("�") ? s : f
      }
      for (const m of t.matchAll(/"fileName":"([^"]+)","originalFileName":[^,]*,"bucketName":[^,]*,"folderPath":[^,]*,"fullPath":"([^"]+)","type":"[^"]*","size":(\d+)/g))
        if (!files.some((f) => f.path === fix(m[2]))) files.push({ name: fix(m[1]), path: fix(m[2]), size: Number(m[3]) })
    } catch {}
  }
  page.on("response", onResp)
  try {
    await politeGoto(page, url, { waitUntil: "domcontentloaded", timeout: 90000 })
    const ok = await page.waitForFunction(() => document.body.innerText.length > 1500, { timeout: 25000 }).then(() => true, () => false)
    if (!ok) throw new Error(`trang vbpl.vn ${url} không hiển thị nội dung văn bản`)
    for (let k = 0, last = -1; k < 8; k++) { const len = await page.evaluate(() => document.body.innerText.length); if (len === last) break; last = len; await sleep(700) }
    const text: string = await page.evaluate(() => document.body.innerText)
    const title = String(await page.title()).split("|")[0].trim()
    const at = text.indexOf(title.slice(0, 40))
    const head = at >= 0 ? text.slice(at, at + 600) : text.slice(0, 2000)
    const status = STATUSES.find((s) => head.includes(s)) ?? null
    const effective = head.match(/Ngày có hiệu lực:\s*([\d/]+)/)?.[1] ?? null
    const doc: VDoc = { url, key, title, status, effective, checkedAt: Date.now(), files: prev?.complete ? prev.files : [], tables: prev?.complete ? prev.tables : [], text: text.slice(0, 400_000), notes: prev?.complete ? prev.notes : [], complete: prev?.complete }
    if (opts.attachments && !prev?.complete) {
      let failed = false, clicked = false
      for (const tab of ["Tải về", "Văn bản gốc"]) {
        const [el] = await page.$$(`xpath/.//*[@role="tab"][normalize-space()="${tab}"]`)
        if (el) { clicked = true; await el.click().catch(() => {}); for (let k = 0; k < 16 && !files.length; k++) await sleep(500); await sleep(800) }
      }
      doc.files = files.map((f) => ({ name: f.name, size: f.size, url: `${GATEWAY}/${f.path.split("/").map(encodeURIComponent).join("/")}/download` }))
      const docx = doc.files.filter((f) => /\.docx$/i.test(f.name) && f.size < 12e6)
      for (const f of docx) {
        const r = await fetchBytes(page, f.url)
        if (!r.b64 || r.status >= 400) { doc.notes.push(`không tải được ${f.name} (${r.error ?? "HTTP " + r.status})`); failed = true; continue }
        try { doc.tables.push(...tablesOf(f.name, Buffer.from(r.b64, "base64"))) } catch (e: any) { doc.notes.push(`không đọc được ${f.name}: ${e?.message ?? e}`) }
      }
      // no .docx: a text-layer PDF can still be searched (scans cannot)
      if (!docx.length) {
        for (const f of doc.files.filter((x) => /\.pdf$/i.test(x.name) && x.size < 6e6).slice(0, 1)) {
          const r = await fetchBytes(page, f.url)
          const t = r.b64 ? await pdfText(Buffer.from(r.b64, "base64")).catch(() => "") : ""
          if (t.replace(/\s/g, "").length > 500) doc.text += `\n[Tệp ${f.name}]\n${t.slice(0, 300_000)}`
          else doc.notes.push(`tệp ${f.name} là bản scan (không có lớp chữ)`)
        }
      }
      if (!doc.files.length) doc.notes.push("vbpl.vn không liệt kê tệp đính kèm")
      if (!doc.tables.length && !doc.notes.length) doc.notes.push(docx.length ? "không có bảng biểu thuế trong tệp .docx đính kèm" : `vbpl.vn chỉ có tệp PDF (${doc.files.map((f) => `${f.name}, ${Math.round(f.size / 1048576)} MB`).join("; ")}) – không trích được bảng; xem trực tiếp trên vbpl.vn`)
      doc.complete = !failed && (doc.files.length > 0 || clicked)
    }
    writeDisk(file, doc)
    return doc
  } finally {
    page.off("response", onResp)
  }
}

/** Rows of the annex tables whose code cell is `d` (dotted or plain); `other` = rows citing the code in another column (e.g. Chương 98). */
function annexRows(doc: VDoc, d: string) {
  const dotted = dotVN(d)
  const main: { t: VTable; row: string[] }[] = []
  const other: { t: VTable; row: string[] }[] = []
  for (const t of doc.tables) for (const row of t.rows) {
    const i = row.findIndex((c) => { const x = c.trim(); return x === dotted || x === d })
    if (i < 0) continue
    const first = row.findIndex((c) => CODE_RE.test(c.trim()))
    ;(i === first ? main : other).push({ t, row })
  }
  return { main, other }
}
/** Column clauses of the decree: "Từ ngày … đến ngày … tại cột có ký hiệu “(V)”", grouped by the clause heading. */
function columnClauses(text: string) {
  const groups: { heading: string; cols: { from: string; to: string; col: string; line: string }[] }[] = []
  let heading = ""
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const m = line.match(/Từ ngày (\d{1,2}) tháng (\d{1,2}) năm (\d{4}) đến ngày (\d{1,2}) tháng (\d{1,2}) năm (\d{4}) tại cột (?:có )?ký hiệu\s*[“"]?\(([IVX]+)\)/)
    if (m) {
      let g = groups.find((x) => x.heading === heading)
      if (!g) { g = { heading, cols: [] }; groups.push(g) }
      g.cols.push({ from: `${m[1]}/${m[2]}/${m[3]}`, to: `${m[4]}/${m[5]}/${m[6]}`, col: `(${m[7]})`, line: line.replace(/(Điều khoản được.*|Bổ sung)$/,"").trim() })
    } else if (/^(\d+\.|Điều \d+)/.test(line)) heading = line.slice(0, 260)
  }
  return groups
}
const cellOf = (row: string[], labels: string[], i: number) => (row[i] ?? "").trim()
/** "Phụ lục II / BIỂU THUẾ … / (Kèm theo …)" → "Phụ lục II BIỂU THUẾ …" (short label). */
const shortCap = (c: string) => clip(c.replace(/\s*\/\s*/g, " ").replace(/\(Kèm theo[\s\S]*$/i, "").replace(/_{3,}/g, "").replace(/\s+/g, " ").trim(), 110)
/** Pick the rate for `year` from an annex row: a year column, or the decree's roman-numbered column clauses. */
function rateForYear(doc: VDoc, t: VTable, row: string[], year: number, partner?: RegExp) {
  const codeIdx = row.findIndex((c) => CODE_RE.test(c.trim()))
  const rateCols = t.labels.map((l, i) => ({ l: l.replace(/\s+/g, " "), i })).filter((x) => x.i > codeIdx + 1 && !/Ghi chú|Mô tả|Mã hàng|STT/i.test(x.l))
  const verbatim = row.map((c) => c.trim()).filter((c, i) => i >= codeIdx && c !== "^").join(" | ")
  // code + rate cells only (the description is printed with the code already)
  const cells = [row[codeIdx]?.trim(), ...rateCols.map((c) => cellOf(row, t.labels, c.i) || "(trống)")].join(" | ")
  const shown = rateCols.map((c) => `${c.l || `cột ${c.i + 1}`}: ${cellOf(row, t.labels, c.i) || "(trống)"}`).join("; ")
  const note = t.labels.findIndex((l) => /Ghi chú/i.test(l))
  const noteText = note >= 0 ? cellOf(row, t.labels, note) : ""
  // columns labelled with a period ("01/04/2025 - 31/03/2026", AJCEP/VJEPA fiscal years): every period overlapping the year
  const RANGE = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*[-–]\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/
  const ranged = rateCols.flatMap((c) => { const m = c.l.match(RANGE); return m ? [{ ...c, from: `${m[1]}/${m[2]}/${m[3]}`, to: `${m[4]}/${m[5]}/${m[6]}` }] : [] })
  if (ranged.length) {
    const hits = ranged.filter((c) => coversYear(c.from, c.to, year))
    const now = Date.now()
    const current = (c: { from: string; to: string }) => vnDate(c.from)!.getTime() <= now && vnDate(c.to)!.getTime() + DAY > now
    if (hits.length) return { picks: hits.map((c) => ({ how: `cột "${c.from} – ${c.to}"${hits.length > 1 && current(c) ? " – đang áp dụng" : ""}`, value: cellOf(row, t.labels, c.i) })), verbatim, cells, shown, noteText }
  }
  const years = rateCols.map((c) => ({ ...c, y: [...new Set(c.l.match(/\b20\d{2}\b/g) ?? [])] }))
  const byYear = years.filter((c) => c.y.length === 1 && Number(c.y[0]) === year)
  if (byYear.length) return { picks: byYear.map((c) => ({ how: `cột "${c.l}"`, value: cellOf(row, t.labels, c.i) })), verbatim, cells, shown, noteText }
  const roman = rateCols.filter((c) => /\([IVX]+\)/.test(c.l))
  if (roman.length) {
    const annex = t.caption.match(/Phụ lục\s+([IVX]+)/i)?.[1]
    let groups = columnClauses(doc.text)
    const forAnnex = groups.filter((g) => annex && new RegExp(`Phụ lục ${annex}(?![IVX])`).test(g.heading))
    if (forAnnex.length) groups = forAnnex
    const picks: { how: string; value: string; group?: string; preferred?: boolean }[] = []
    for (const g of groups) {
      const c = g.cols.find((x) => coversYear(x.from, x.to, year))
      if (!c) continue
      const col = roman.find((r) => r.l.includes(c.col))
      if (!col) continue
      picks.push({ how: `cột ${c.col} ("${c.line}")`, value: cellOf(row, t.labels, col.i), group: g.heading, preferred: partner ? partner.test(g.heading) : undefined })
    }
    return { picks, verbatim, cells, shown, noteText }
  }
  if (rateCols.length === 1) return { picks: [{ how: `cột "${rateCols[0].l || "Thuế suất"}"`, value: cellOf(row, t.labels, rateCols[0].i) }], verbatim, cells, shown, noteText }
  return { picks: [], verbatim, cells, shown, noteText }
}
/** Lines of a document's text around each occurrence of the code (amending decrees publish their annex as page text). */
function textHits(doc: VDoc, d: string, max = 3) {
  const dotted = dotVN(d)
  const lines = doc.text.split("\n").map((l) => l.trim()).filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (lines[i] !== dotted && !lines[i].startsWith(dotted + " ") && !new RegExp(`(^|\\D)${dotted.replace(/\./g, "\\.")}(\\D|$)`).test(lines[i])) continue
    out.push(lines.slice(i, i + 5).join(" | ").slice(0, 400))
  }
  return out
}
const docNo = (doc: VDoc) => doc.title.match(/\b\d{1,4}\/\d{4}\/[A-ZĐa-z]{1,6}(?:-[A-ZĐa-z]{1,8})*\b/)?.[0] ?? doc.title.slice(0, 60)
const statusLine = (doc: VDoc) => `${docNo(doc)} – ${clip(doc.title, 170)} · tình trạng (vbpl.vn): ${doc.status ?? "không rõ"}${doc.effective ? ` · có hiệu lực từ ${doc.effective}` : ""} · ${doc.url}`

// ------------------------------------------------------------------ tariff_vn
type Leaf = { code: string; vi: string; en: string; unit: string; list: Record<string, string> }
const HEAD_KEYS = new Set(["", "MA", "MA_HS", "TO_JSON", "MO_TA_VN", "MO_TA_EN"])

export const vn = tool({
  description:
    "TRA BIỂU THUẾ XUẤT KHẨU / NHẬP KHẨU CỦA VIỆT NAM theo mã HS (AHTN 8 số; 4–6 số = liệt kê các mã con): thuế suất nhập khẩu ưu đãi (MFN), thông thường và ưu đãi đặc biệt theo từng FTA (ATIGA, ACFTA, AJCEP, AKFTA, AHKFTA, AANZFTA, AIFTA, VJEPA, VKFTA, VN-EAEU, EVFTA, UKVFTA, VCFTA, CPTPP, RCEP theo đối tác, Lào, Cu Ba; VIFTA/CEPA qua Nghị định trên vbpl.vn), nguyên văn, kèm SỐ HIỆU NGHỊ ĐỊNH, ngày áp dụng, tình trạng hiệu lực. Nguồn: CSDL Biểu thuế của Cục Hải quan (customs.gov.vn) + Phụ lục Nghị định biểu thuế trên vbpl.vn (lấy đúng cột của NĂM được hỏi theo lộ trình FTA) + rà soát văn bản sửa đổi. Lần đầu tra một Nghị định có thể mất 1–2 phút (tải phụ lục), sau đó dùng bộ nhớ đệm.",
  args: {
    hs: tool.schema.string().describe("Mã HS, VD '7208.39.90', '72083990', '0306.17' (≥ 4 số; ít hơn 8 số = liệt kê mã con)"),
    year: tool.schema.number().optional().describe("Năm cần thuế suất (mặc định năm hiện tại) – quan trọng với lộ trình FTA"),
    fta: tool.schema.string().optional().describe("'all' (mặc định: MFN + thông thường + mọi FTA) hoặc danh sách, VD 'EVFTA', 'ATIGA,CPTPP', 'RCEP', 'VIFTA', 'mfn'"),
    kind: tool.schema.enum(["import", "export"]).optional().describe("import (mặc định) | export (Biểu thuế xuất khẩu, xuất khẩu ưu đãi EVFTA/CPTPP/UKVFTA)"),
    check_amendments: tool.schema.boolean().optional().describe("Rà các Nghị định sửa đổi trên vbpl.vn xem có sửa dòng thuế này không (mặc định true)"),
  },
  async execute({ hs, year, fta, kind, check_amendments }, context) {
    const bad = badCode(hs, 4, 10)
    if (bad) return bad
    const d = digits(hs)
    const Y = year && year > 1990 && year < 2100 ? Math.trunc(year) : thisYear()
    const K = kind ?? "import"
    const { types, extra, unknown } = resolveTypes(fta, K)
    const sid = context?.sessionID
    const t0 = Date.now()
    try {
      return await withPage(async (page) => {
        const list = await customsList(page, d)
        const heads = list.filter((r) => Object.keys(r).every((k) => HEAD_KEYS.has(k)) || String(r.TO_JSON ?? "") === ":")
        const leaves: Leaf[] = list.filter((r) => !heads.includes(r)).map((r) => ({
          code: String(r.MA ?? r.MA_HS), vi: String(r.MO_TA_VN ?? ""), en: String(r.MO_TA_EN ?? ""), unit: String(r[""] ?? ""),
          list: Object.fromEntries(Object.entries(r).filter(([k]) => !HEAD_KEYS.has(k)).map(([k, v]) => [k, String(v)])),
        })).filter((l) => l.code.startsWith(d.slice(0, Math.min(d.length, 8))))
        const src = cusDetailUrl(d)
        if (!list.length || !leaves.length)
          return `Không tìm thấy mã HS ${dotVN(d)} trong CSDL Biểu thuế của Cục Hải quan (customs.gov.vn, tra ngày ${today()}). Kiểm tra lại mã (Danh mục AHTN 8 số, VD 7208.39.90) hoặc tìm theo mô tả hàng hóa bằng tariff_search(query, market="vn").`
        const out: string[] = []
        const vb: string[] = [] // evidence text per vbpl document is recorded separately
        out.push(`BIỂU THUẾ ${K === "export" ? "XUẤT" : "NHẬP"} KHẨU CỦA VIỆT NAM – mã ${dotVN(d)} – năm ${Y}`)
        out.push(`Nguồn chính: CSDL Biểu thuế của Cục Hải quan (Tra cứu Biểu thuế – customs.gov.vn): ${src} · Ngày tra cứu: ${today()}`)
        const trail = heads.filter((h) => d.startsWith(String(h.MA_HS))).map((h) => `${dotVN(String(h.MA_HS))} ${h.MO_TA_VN}`)
        if (trail.length) out.push(`Nhóm / phân nhóm: ${trail.map((p) => clip(p, 220)).join(" › ")}`)
        if (unknown.length) out.push(`⚠ Không nhận ra FTA: ${unknown.join(", ")} – các mã hợp lệ: ${[...new Set(VN_TYPES.filter((t) => t.kind === K).flatMap((t) => t.aliases.slice(0, 1)))].join(", ")}${K === "import" ? ", vifta, cepa" : ""}.`)

        // ---------- many codes: compact list (MFN / thông thường from the Customs database only)
        const MAX_DETAIL = 6
        if (leaves.length > MAX_DETAIL) {
          const cols = K === "import" ? ["NK_uu_dai", "NK_TT"] : ["XK"]
          const want = fta && !/^all$/i.test(fta) ? types.map((t) => t.code).filter((c) => !cols.includes(c)) : []
          out.push(`${leaves.length} mã 8 số thuộc ${dotVN(d)} (CSDL Hải quan; ${K === "import" ? "MFN = nhập khẩu ưu đãi, TT = thông thường" : "XK = thuế xuất khẩu"}${want.length ? `; cột FTA là giá trị CSDL Hải quan, CHƯA đối chiếu năm ${Y} – tra từng mã để có đúng mức năm ${Y}` : ""}):`)
          for (const l of leaves.slice(0, 80)) out.push(`- ${dotVN(l.code)} | ${clip(l.vi, 140)} | ${cols.map((c) => `${c === "NK_uu_dai" ? "MFN" : c === "NK_TT" ? "TT" : c}: ${pctVi(l.list[c] ?? "")}`).join(" | ")}${want.map((c) => ` | ${c}: ${pctVi(l.list[c] ?? "")}`).join("")}${l.unit ? ` | ĐVT: ${l.unit}` : ""}`)
          if (leaves.length > 80) out.push(`… (+${leaves.length - 80} mã)`)
          out.push(`→ Gọi lại tariff_vn với mã 8 số (VD ${dotVN(leaves[0].code)}) để có căn cứ pháp lý, ngày áp dụng và thuế suất FTA của năm ${Y}.`)
          const text = out.join("\n")
          recordEvidence(sid, { url: src, title: `Biểu thuế ${dotVN(d)}`, text, source: "customs.gov.vn", meta: { hs: d, year: Y, kind: K } })
          return withUi(text, { res: count(leaves.length, "tariffLines"), card: { kind: "tariff", market: "vn", code: dotVN(d), year: String(Y), flow: K, url: src, lines: leaves.slice(0, 6).map((l) => ({ code: dotVN(l.code), desc: data(l.vi.replace(/^[-\s]+/, ""), "vi"), ...(l.en ? { descAlt: data(l.en.replace(/^[-\s]+/, ""), "en") } : {}), ...(l.unit ? { unit: l.unit } : {}) })), more: Math.max(0, leaves.length - 6), rates: [] } })
        }

        // ---------- detail per code
        const docsUsed = new Map<string, VDoc>()
        const annexNeeded = new Set<string>()
        const details = new Map<string, any[]>()
        for (const l of leaves) details.set(l.code, await customsDetail(page, l.code, types.map((t) => t.code)))
        for (const rows of details.values()) for (const r of rows) if (r.VAN_BAN_LIEN_QUAN && !coversYear(r.BAT_DAU, r.KET_THUC, Y)) annexNeeded.add(String(r.VAN_BAN_LIEN_QUAN).trim())
        // MFN / export base schedule: always cross-check the annex of the base decree (26/2023 …) and scan amendments
        const baseNos = new Set<string>()
        for (const rows of details.values()) for (const r of rows) if (r.VAN_BAN_LIEN_QUAN) baseNos.add(String(r.VAN_BAN_LIEN_QUAN).trim())
        for (const x of extra) annexNeeded.add(`@${x.code}`)
        const resolved = new Map<string, { base: string | null; amending: string[] }>()
        const loadNo = async (no: string) => {
          if (no.startsWith("@")) {
            const x = VN_EXTRA.find((e) => e.code === no.slice(1))!
            const urls = await vbplFind(x.query, 10)
            const base = urls.find((u) => slugOf(u).includes(x.must) && /bieu-thue/.test(slugOf(u)) && !/sua-doi/.test(slugOf(u))) ?? null
            resolved.set(no, { base, amending: [] })
          } else resolved.set(no, await vbplByNumber(no))
          const r = resolved.get(no)!
          if (r.base && !docsUsed.has(r.base)) docsUsed.set(r.base, await vbplDoc(page, r.base))
        }
        const toLoad = [...new Set([...annexNeeded, ...[...baseNos].filter((n) => /^26\/2023\//.test(n))])]
        for (const no of toLoad) { try { await loadNo(no) } catch (e: any) { out.push(`⚠ Không mở được ${no} trên vbpl.vn: ${String(e?.message ?? e).slice(0, 120)}`) } }

        const compact = leaves.length > 1 && types.length + extra.length > 6
        if (compact) out.push(`(Nhiều mã × nhiều biểu thuế: mỗi biểu thuế một dòng – mức của năm ${Y}; căn cứ và dòng phụ lục nguyên văn: gọi lại với một mã 8 số và fta cụ thể)`)
        const leafBlocks: { head: string; lines: string[] }[] = []
        const uiRates: Record<string, unknown>[] = [] // rates of the first code, for the web card
        for (const l of leaves) {
          const rows = details.get(l.code) ?? []
          const lo: string[] = []
          const headLine = (`■ ${dotVN(l.code)} – ${l.vi}${l.en ? ` (EN: ${l.en})` : ""}${rows[0]?.DVT_VN || l.unit ? ` · ĐVT: ${rows[0]?.DVT_VN || l.unit}` : ""}`)
          for (const t of types) {
            const r = rows.find((x) => x.MA_LOAI_BIEU_THUE === t.code)
            const listVal = l.list[t.code]
            if (!r) {
              if (l === leaves[0] && listVal !== undefined && listVal !== "") uiRates.push({ col: VN_COL[t.code] ?? "fta", ...(VN_COL[t.code] ? {} : { fta: vnFta(t.code) }), raw: data(pctVi(listVal)), ...rateUi(listVal) })
              if (listVal !== undefined && listVal !== "") lo.push(`  • ${t.label}: ${pctVi(listVal)} (CSDL Hải quan, không có dòng chi tiết/căn cứ)${listVal.trim() === "*" ? " – ký hiệu “*”: không được hưởng thuế suất ưu đãi đặc biệt (xem giải thích ký hiệu trong Nghị định của FTA)" : ""}`)
              else if (fta && !/^all$/i.test(fta)) lo.push(`  • ${t.label}: không có dòng thuế trong CSDL Hải quan cho mã này`)
              continue
            }
            const no = String(r.VAN_BAN_LIEN_QUAN ?? "").trim()
            const period = `${r.BAT_DAU || "?"}${r.KET_THUC ? ` – ${r.KET_THUC}` : " – (không ghi ngày kết thúc)"}`
            const inYear = coversYear(r.BAT_DAU, r.KET_THUC, Y)
            if (l === leaves[0]) uiRates.push({ col: VN_COL[t.code] ?? "fta", ...(VN_COL[t.code] ? {} : { fta: vnFta(t.code) }), raw: data(pctVi(r.THUE_SUAT)), ...rateUi(String(r.THUE_SUAT ?? "")), ...(no ? { basis: no } : {}), ...(isoDate(r.BAT_DAU) ? { from: isoDate(r.BAT_DAU) } : {}), ...(isoDate(r.KET_THUC) ? { to: isoDate(r.KET_THUC) } : {}), ...(inYear ? {} : { stale: true }) })
            let line = `  • ${r.TEN_LOAI_BIEU_THUE || t.label}${t.code === "NK_uu_dai" ? " (MFN)" : ""}: ${pctVi(r.THUE_SUAT)} – căn cứ ${no || "(không ghi)"} – áp dụng ${period} [CSDL Hải quan]${r.GHI_CHU_THUE_SUAT ? ` – ghi chú: ${r.GHI_CHU_THUE_SUAT}` : ""}`
            if (!inYear) line += ` ⚠ giai đoạn này không phải năm ${Y}`
            // compact mode (several codes × many schedules): one line per schedule, rate of the year first
            const label = `${r.TEN_LOAI_BIEU_THUE || t.label}${t.code === "NK_uu_dai" ? " (MFN)" : ""}`
            if (!compact) lo.push(line)
            else if (inYear) lo.push(`  • ${label}: ${pctVi(r.THUE_SUAT)} – ${no || "(không ghi căn cứ)"} [CSDL Hải quan, áp dụng từ ${r.BAT_DAU || "?"}${r.KET_THUC ? ` đến ${r.KET_THUC}` : ""}]${r.GHI_CHU_THUE_SUAT ? ` – ghi chú: ${r.GHI_CHU_THUE_SUAT}` : ""}`)
            // annex of the decree: rate of the requested year (FTA roadmaps) / cross-check
            const doc = resolved.get(no)?.base ? docsUsed.get(resolved.get(no)!.base!) : undefined
            if (doc) {
              const { main, other } = annexRows(doc, l.code)
              const wantKind = K === "export" ? /xuất khẩu/i : /nhập khẩu/i
              const mm = main.filter((x) => wantKind.test(x.t.caption) || !/(xuất|nhập) khẩu/i.test(x.t.caption))
              for (const { t: tb, row } of (mm.length ? mm : main).slice(0, 2)) {
                const pick = rateForYear(doc, tb, row, Y, t.partner)
                const cap = shortCap(tb.caption)
                const chosen = pick.picks.filter((p) => p.preferred !== false)
                if (l === leaves[0] && !inYear && chosen.length && !uiRates.some((x) => x.annex && x.code === t.code)) uiRates.push({ col: VN_COL[t.code] ?? "fta", ...(VN_COL[t.code] ? {} : { fta: vnFta(t.code) }), code: t.code, raw: data(pctVi(chosen[0].value)), ...rateUi(chosen[0].value), ...(no ? { basis: no } : {}), year: String(Y), annex: true })
                const val = chosen.length ? chosen.map((p) => `${pctVi(p.value)} (${p.how}${p.group && pick.picks.length > 1 ? `; nhóm: ${clip(p.group, 110)}` : ""})`).join("; ") : `không xác định được cột của năm ${Y} – xem các cột: ${pick.shown}`
                const note = pick.noteText ? ` · Ghi chú: ${pick.noteText}` : ""
                vb.push(`[${doc.url}] ${tb.caption}\nCột: ${tb.labels.filter(Boolean).join(" | ")}\n${pick.verbatim}\n${pick.cells}\nNăm ${Y}: ${val}`)
                if (compact) {
                  if (!inYear) lo.push(`  • ${label}: năm ${Y}: ${chosen.length ? chosen.map((p) => `${pctVi(p.value)} (${p.how.replace(/ \(".*$/, "")})`).join("; ") : `không xác định được cột năm ${Y}`} – Phụ lục ${no}${note} [CSDL Hải quan chỉ ghi ${pctVi(r.THUE_SUAT)} cho ${period}]`)
                  break
                }
                if (inYear && chosen.length === 1 && pctVi(chosen[0].value) === pctVi(r.THUE_SUAT)) lo.push(`    ↳ khớp ${cap} – ${no}: dòng "${pick.cells}"${note}`)
                else {
                  lo.push(`    ↳ ${cap} – ${no} – năm ${Y}: ${val}`)
                  lo.push(`      dòng phụ lục (mã | các cột thuế suất): "${pick.cells}"${note}`)
                }
              }
              if (!main.length) lo.push(compact && !inYear ? `  • ${label}: ⚠ CSDL Hải quan chỉ ghi ${pctVi(r.THUE_SUAT)} cho ${period} (${no}); không thấy mã trong phụ lục trên vbpl.vn – không dùng mức này cho năm ${Y}` : `    ↳ Không thấy mã ${dotVN(l.code)} trong phụ lục ${no} đã tải từ vbpl.vn${doc.notes.length ? ` (${doc.notes.join("; ")})` : ""}.`)
              for (const { t: tb, row } of other.filter((x) => wantKind.test(x.t.caption) || !/(xuất|nhập) khẩu/i.test(x.t.caption)).slice(0, 2)) {
                const v = row.map((c) => c.trim()).filter((c) => c && c !== "^").join(" | ")
                lo.push(`    ↳ Mã còn được dẫn ở dòng khác của phụ lục ${no} (${clip(tb.caption, 90)}): "${clip(v, 220)}" – áp dụng theo điều kiện riêng của mục đó (VD Chương 98).`)
                vb.push(`[${doc.url}] ${tb.caption}\n${v}`)
              }
            } else if (!inYear) lo.push(compact ? `  • ${label}: ⚠ CSDL Hải quan chỉ ghi ${pctVi(r.THUE_SUAT)} cho ${period} (${no}); chưa lấy được phụ lục trên vbpl.vn – không dùng mức này cho năm ${Y}` : `    ↳ Chưa lấy được phụ lục ${no} trên vbpl.vn để đọc mức năm ${Y} – không dùng mức trên cho năm ${Y}.`)
          }
          for (const x of extra) {
            const r = resolved.get(`@${x.code}`)
            const doc = r?.base ? docsUsed.get(r.base) : undefined
            if (!doc) { lo.push(`  • ${x.label}: không tìm thấy Nghị định biểu thuế trên vbpl.vn`); continue }
            const { main } = annexRows(doc, l.code)
            if (!main.length) {
              const th = textHits(doc, l.code, 2)
              if (th.length) { lo.push(`  • ${x.label}: mã có trong nội dung ${docNo(doc)} trên vbpl.vn (không phải bảng – đọc cột theo tiêu đề của phụ lục): ${th.map((h) => `"${h}"`).join(" ; ")}`); vb.push(`[${doc.url}] ${doc.title}\n${th.join("\n")}`) }
              else lo.push(`  • ${x.label}: không thấy mã trong phụ lục ${docNo(doc)} (vbpl.vn)${doc.notes.length ? ` – ${doc.notes.join("; ")}` : ""} – kiểm tra trực tiếp văn bản tại ${doc.url}`)
              continue
            }
            const { t: tb, row } = main.find((m) => /nhập khẩu/i.test(m.t.caption)) ?? main[0]
            const pick = rateForYear(doc, tb, row, Y)
            const val = pick.picks.length ? pick.picks.map((p) => `${pctVi(p.value)} (${p.how})`).join("; ") : `xem các cột: ${pick.shown}`
            lo.push(`  • ${x.label}: năm ${Y}: ${val} – căn cứ ${docNo(doc)} (phụ lục trên vbpl.vn) – dòng ${compact ? "phụ lục (mã | các cột)" : "nguyên văn"}: "${compact ? pick.cells : clip(pick.verbatim, 260)}"`)
            vb.push(`[${doc.url}] ${tb.caption}\n${pick.verbatim}\nNăm ${Y}: ${val}`)
          }
          leafBlocks.push({ head: headLine, lines: lo })
        }

        // identical schedules for several codes (common for a 6-digit heading): print them once
        const groupsOut = new Map<string, { heads: string[]; lines: string[] }>()
        for (const bl of leafBlocks) {
          const key = bl.lines.map((x) => x.split(bl.head.slice(2, 12)).join("#")).join("\n")
          const g = groupsOut.get(key) ?? { heads: [], lines: bl.lines }
          g.heads.push(bl.head)
          groupsOut.set(key, g)
        }
        for (const g of groupsOut.values()) {
          out.push("")
          out.push(...g.heads)
          if (g.heads.length > 1) out.push(`  (${g.heads.length} mã trên có cùng thuế suất và căn cứ dưới đây)`)
          out.push(...g.lines)
        }
        // ---------- amendments: decrees amending the decrees cited above
        const amendHits: string[] = []
        const scanned: string[] = []
        if (check_amendments !== false) {
          const nos = [...baseNos].filter((n) => /NĐ-CP$/.test(n))
          const seen = new Set<string>()
          for (const no of nos) {
            let r = resolved.get(no)
            if (!r) { try { r = await vbplByNumber(no); resolved.set(no, r) } catch { continue } }
            for (const u of r.amending.slice(0, 10)) {
              if (seen.has(u)) continue
              seen.add(u)
              let doc: VDoc
              try { doc = await vbplDoc(page, u) } catch (e: any) { scanned.push(`${slugOf(u).slice(0, 60)}… (lỗi: ${String(e?.message ?? e).slice(0, 60)})`); continue }
              scanned.push(docNo(doc))
              for (const l of leaves) {
                const rows = annexRows(doc, l.code).main.map(({ t, row }) => `${clip(t.caption, 100)}: "${row.map((c) => c.trim()).filter((c) => c && c !== "^").join(" | ")}"`)
                const hits = [...rows, ...textHits(doc, l.code).map((h) => `"${h}"`)]
                if (!hits.length) continue
                amendHits.push(`⚠ ${dotVN(l.code)} có trong ${docNo(doc)} (sửa đổi ${no}; ${doc.status ?? "?"}${doc.effective ? `, hiệu lực từ ${doc.effective}` : ""}): ${hits.slice(0, 2).map((h) => clip(h, 320)).join(" ; ")} – ${doc.url}`)
                vb.push(`[${doc.url}] ${doc.title}\n${hits.join("\n")}`)
              }
              docsUsed.set(u, doc)
            }
          }
        }

        out.push("")
        out.push("VĂN BẢN & HIỆU LỰC (vbpl.vn, tra ngày " + today() + "):")
        const shown = new Set<string>()
        for (const doc of docsUsed.values()) if (!shown.has(doc.url) && (annexRows(doc, leaves[0].code).main.length || [...resolved.values()].some((r) => r.base === doc.url))) { shown.add(doc.url); out.push(`- ${statusLine(doc)}`) }
        let missing = [...baseNos].filter((n) => ![...docsUsed.values()].some((doc) => docNo(doc) === n))
        for (const n of missing.slice(0, 3)) {
          try {
            const r = resolved.get(n) ?? (await vbplByNumber(n))
            if (!r.base) continue
            const doc = await vbplDoc(page, r.base, { attachments: false })
            docsUsed.set(r.base, doc)
            out.push(`- ${statusLine(doc)}`)
            vb.push(`[${doc.url}] ${statusLine(doc)}`)
          } catch {}
        }
        missing = missing.filter((n) => ![...docsUsed.values()].some((doc) => docNo(doc) === n))
        if (missing.length) out.push(`- Căn cứ khác do CSDL Hải quan ghi (chưa mở trên vbpl.vn trong lần tra này): ${missing.join(", ")} – kiểm tra hiệu lực bằng vbpl_find → vbpl_document.`)
        if (check_amendments !== false) {
          out.push(amendHits.length ? `RÀ SOÁT VĂN BẢN SỬA ĐỔI – có sửa đổi liên quan tới mã này (ưu tiên mức trong văn bản sửa đổi còn hiệu lực, từ ngày hiệu lực của nó):\n${amendHits.join("\n")}` : `Rà soát văn bản sửa đổi trên vbpl.vn: không thấy mã ${leaves.map((l) => dotVN(l.code)).join(", ")} trong ${scanned.length ? scanned.join(", ") : "(không có văn bản sửa đổi nào được tìm thấy theo tiêu đề)"}.`)
        }
        out.push("")
        out.push("LƯU Ý:")
        if (K === "import") {
          out.push("- Thuế suất ưu đãi đặc biệt (FTA) chỉ áp dụng khi hàng đáp ứng quy tắc xuất xứ và có chứng từ chứng nhận xuất xứ hợp lệ theo FTA (loại chứng từ theo văn bản về quy tắc xuất xứ của từng FTA), nhập khẩu từ nước thành viên; không đáp ứng → thuế suất ưu đãi (MFN) hoặc thông thường.")
          out.push("- Ký hiệu “*”: không được hưởng thuế suất ưu đãi đặc biệt tại thời điểm tương ứng; mặt hàng có hạn ngạch thuế quan (TRQ) / Chương 98 / ghi chú riêng: xem ghi chú đi kèm và Điều liên quan của Nghị định.")
        } else out.push("- Thuế xuất khẩu ưu đãi theo FTA chỉ áp dụng khi đáp ứng điều kiện của Nghị định (xuất khẩu sang nước thành viên, chứng từ vận tải…).")
        out.push("- Mức trong CSDL Hải quan là dữ liệu tra cứu; căn cứ pháp lý là Nghị định biểu thuế (đã dẫn). Có sửa đổi thì theo văn bản sửa đổi còn hiệu lực. Thuế GTGT, TTĐB, BVMT, phòng vệ thương mại (trav_measures) là các khoản riêng.")
        out.push(`(tra trong ${Math.round((Date.now() - t0) / 1000)} giây)`)
        out.push(CITE)
        const text = out.join("\n")
        recordEvidence(sid, { url: src, title: `Biểu thuế ${dotVN(d)} – customs.gov.vn`, text, source: "customs.gov.vn", meta: { hs: d, year: Y, kind: K } })
        const byDoc = new Map<string, string[]>()
        for (const v of vb) { const u = v.match(/^\[(\S+)\]/)?.[1] ?? ""; byDoc.set(u, [...(byDoc.get(u) ?? []), v.replace(/^\[\S+\]\s*/, "")]) }
        for (const [u, parts] of byDoc) { const doc = [...docsUsed.values()].find((x) => x.url === u); recordEvidence(sid, { url: u, title: doc?.title, text: `${doc ? statusLine(doc) + "\n" : ""}${parts.join("\n\n")}`, source: "vbpl.vn", meta: { tariff: d } }) }
        if (amendHits.length) recordWarning(sid, src, `⚠ Mã ${dotVN(d)} có trong văn bản sửa đổi biểu thuế – đối chiếu mức thuế trong văn bản sửa đổi trước khi trả lời.`)
        return withUi(text, { res: count(leaves.length, "tariffLines"), card: { kind: "tariff", market: "vn", code: dotVN(d), year: String(Y), flow: K, url: src, lines: leaves.slice(0, 6).map((l) => ({ code: dotVN(l.code), desc: data(l.vi.replace(/^[-\s]+/, ""), "vi"), ...(l.en ? { descAlt: data(l.en.replace(/^[-\s]+/, ""), "en") } : {}), ...(l.unit ? { unit: l.unit } : {}) })), more: Math.max(0, leaves.length - 6), rates: uiRates.slice(0, 10), ...(amendHits.length ? { amended: amendHits.length } : {}) } })
      })
    } catch (e: any) {
      if (e instanceof Blocked) return `Không tra được biểu thuế Việt Nam: ${e.message}. Không nêu thuế suất theo trí nhớ; thử lại sau hoặc tra Phụ lục Nghị định biểu thuế bằng vbpl_find.`
      throw e
    }
  },
})

// =====================================================================================================
// United States – USITC HTS REST API
// =====================================================================================================
const HTS = "https://hts.usitc.gov"
async function htsJson(page: any, pathQ: string): Promise<any> {
  return cached(`hts|${pathQ}`, 6 * 3600_000, async () => {
    if (!page.url().startsWith(HTS)) {
      const res = await politeGoto(page, `${HTS}/reststop/currentRelease`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e: any) => { throw new Blocked(`không kết nối được hts.usitc.gov: ${String(e?.message ?? e).slice(0, 80)}`) })
      if ((res?.status() ?? 0) >= 500) throw new Blocked(`hts.usitc.gov trả về HTTP ${res?.status()}`)
    }
    const r: { s: number; t: string } = await politeEval(HTS, page, async (u: string) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 45000)
      try { const res = await fetch(u, { signal: ctl.signal }); return { s: res.status, t: await res.text() } } catch (e: any) { return { s: 0, t: String(e?.message ?? e) } } finally { clearTimeout(timer) }
    }, `${HTS}${pathQ}`)
    if (r.s === 0 || r.s >= 500) throw new Blocked(`API HTS không phản hồi (${r.s ? "HTTP " + r.s : r.t.slice(0, 80)})`)
    if (r.s >= 400) return null
    try { return JSON.parse(r.t) } catch { if (BLOCK_RE.test(r.t)) throw new Blocked("hts.usitc.gov chặn truy cập tự động"); return null }
  })
}
const htsDigits = (s: string) => digits(s)
const htsDot = (d: string) => (d.length <= 4 ? d : [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join("."))
const stripHtml = (s: string) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()

export const us = tool({
  description:
    "TRA BIỂU THUẾ NHẬP KHẨU HOA KỲ (HTS – USITC, API chính thức hts.usitc.gov) theo mã HS/HTS (4–10 số; ngắn = liệt kê mã con): thuế suất cột General (NTR/MFN – áp dụng cho hàng xuất xứ Việt Nam), Special (chương trình ưu đãi), Column 2, đơn vị, chú thích; các tiêu mục Chương 99 được chú thích dẫn chiếu và các tiêu mục Chương 99 nêu đích danh Việt Nam (thuế bổ sung), kèm số hiệu bản HTS (revision) và ngày. Thuế chống bán phá giá / chống trợ cấp KHÔNG nằm trong HTS → dùng trav_measures / fedreg_search.",
  args: {
    hs: tool.schema.string().describe("Mã HTS, VD '7210.49', '7210.49.00', '0306.17.00.40'"),
    country: tool.schema.string().optional().describe("Nước xuất xứ (mặc định VN = Việt Nam)"),
  },
  async execute({ hs, country }, context) {
    const bad = badCode(hs, 4, 10)
    if (bad) return bad
    const d = htsDigits(hs)
    const cc = iso2(country)
    const vnName = cc === "VN" ? "Vietnam" : null
    const t0 = Date.now()
    try {
      return await withPage(async (page) => {
        const rel = (await htsJson(page, "/reststop/currentRelease").catch(() => null)) ?? {}
        const relList: any[] = (await htsJson(page, "/reststop/releaseList").catch(() => null)) ?? []
        const cur = relList.find((r) => r.name === rel.name) ?? relList.find((r) => r.status === "current")
        const h4 = d.slice(0, 4)
        const next = String(Number(h4) + 1).padStart(4, "0")
        const rows: any[] = (await htsJson(page, `/reststop/exportList?from=${h4}&to=${next}&format=JSON&styles=false`)) ?? []
        const idx = rows.map((r, i) => ({ r, i, dd: htsDigits(r.htsno ?? "") }))
        const hits = idx.filter((x) => x.dd && x.dd.startsWith(d))
        const pageUrl = `${HTS}/search?query=${htsDot(d)}`
        if (!hits.length) return `Không tìm thấy mã ${htsDot(d)} trong HTS hiện hành (${rel.description ?? "HTS"}, hts.usitc.gov, tra ngày ${today()}). Kiểm tra lại mã hoặc dùng tariff_search(query, market="us").`
        // ancestors of the first hit (by indent), then every hit + the unnamed "superior" lines between them
        const first = hits[0].i
        const anc: any[] = []
        let ind = Number(rows[first].indent ?? 0)
        for (let i = first - 1; i >= 0 && ind > 0; i--) { const n = Number(rows[i].indent ?? 0); if (n < ind) { anc.unshift(rows[i]); ind = n } }
        const last = hits[hits.length - 1].i
        const block = rows.slice(first, last + 1).filter((r) => !htsDigits(r.htsno ?? "") || htsDigits(r.htsno).startsWith(d)).slice(0, 70)
        const out: string[] = []
        out.push(`BIỂU THUẾ HOA KỲ (Harmonized Tariff Schedule – USITC) – mã ${htsDot(d)}${vnName ? " – hàng xuất xứ Việt Nam" : ` – xuất xứ ${cc}`}`)
        out.push(`Bản HTS: ${cur?.description ?? rel.description ?? "?"}${cur?.releaseStartDate ? ` (áp dụng từ ${cur.releaseStartDate})` : ""} · Nguồn: ${pageUrl} (API chính thức ${HTS}/reststop) · Ngày tra cứu: ${today()}`)
        if (anc.length) out.push(`Nhóm: ${anc.map((a) => `${a.htsno ? htsDot(htsDigits(a.htsno)) + " " : ""}${clip(stripHtml(a.description), 160)}${a.general ? ` [General: ${a.general} | Special: ${a.special || "–"} | Column 2: ${a.other || "–"}]` : ""}`).join(" › ")}`)
        const ancRate = [...anc].reverse().find((a) => a.general && htsDigits(a.htsno ?? "").length >= 8)
        out.push("Mã | Mô tả | General (cột 1 – NTR/MFN) | Special | Column 2 | Đơn vị")
        const refs = new Set<string>()
        let rateLine = ""
        const uiLines: Record<string, unknown>[] = []
        let uiRates: Record<string, unknown>[] = []
        for (const r of block) {
          const dd = htsDigits(r.htsno ?? "")
          const pad = "  ".repeat(Math.max(0, Number(r.indent ?? 0) - (anc.length ? Number(anc[anc.length - 1].indent ?? 0) + 1 : 0)))
          const fn = (r.footnotes ?? []).map((f: any) => `[chú thích${f.columns?.length ? ` (${f.columns.join(",")})` : ""}: ${stripHtml(f.value)}]`).join(" ")
          for (const f of r.footnotes ?? []) if ((f.columns ?? []).some((c: string) => c === "general" || c === "special")) for (const m of String(f.value).matchAll(/99\d\d\.\d\d\.\d\d/g)) refs.add(m[0])
          const free = (v: string) => (/^Free$/i.test(v) ? `${v} [= 0%]` : v)
          const rates = dd ? ` | ${free(r.general) || "–"} | ${r.special || "–"} | ${free(r.other) || "–"} | ${(r.units ?? []).join(", ") || "–"}` : ""
          out.push(`${pad}${dd ? htsDot(dd) : "(dòng mô tả)"} | ${clip(stripHtml(r.description), 200)}${rates}${fn ? " " + fn : ""}`)
          if (dd.length === 8 && r.general && !rateLine) rateLine = `${htsDot(dd)}: General = ${free(r.general)}`
          if (dd && uiLines.length < 6) uiLines.push({ code: htsDot(dd), desc: data(stripHtml(r.description), "en"), ...((r.units ?? []).length ? { unit: (r.units ?? []).join(", ") } : {}) })
          if (dd && r.general && !uiRates.length) uiRates = [{ col: "general", raw: data(r.general, "en"), ...rateUi(r.general) }, ...(r.special ? [{ col: "special", raw: data(r.special, "en"), ...rateUi(r.special) }] : []), ...(r.other ? [{ col: "col2", raw: data(r.other, "en"), ...rateUi(r.other) }] : [])]
        }
        if (block.length === 70) out.push("… (danh sách dài – nhập mã chi tiết hơn)")
        if (!rateLine && ancRate) rateLine = `${htsDot(htsDigits(ancRate.htsno))}: General = ${/^Free$/i.test(ancRate.general) ? "Free [= 0%]" : ancRate.general} (mức của phân nhóm 8 số; mã thống kê 10 số dùng chung mức này)`
        const extra: string[] = []
        for (const ref of [...refs].slice(0, 8)) {
          const j: any[] = (await htsJson(page, `/reststop/search?keyword=${ref}`)) ?? []
          const x = j.find((y) => y.htsno === ref)
          if (x) extra.push(`- ${ref} | ${clip(stripHtml(x.description), 400)} | General: ${x.general || "–"}`)
        }
        const byCountry: string[] = []
        const active: string[] = []
        if (vnName) {
          const j: any[] = (await htsJson(page, `/reststop/search?keyword=${vnName}`)) ?? []
          for (const x of j.filter((y) => /^99\d\d\./.test(y.htsno ?? "")).slice(0, 12)) {
            const desc = stripHtml(x.description)
            // "entered for consumption … before 12:01 a.m. … on October 5, 2025" – an entry window that has closed
            const until = desc.match(/entered for consumption[^.]*?before 12:01 a\.m\.[a-z ]*? on ([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1]
            const closed = until && Date.parse(until) < Date.now() ? ` [chỉ áp dụng cho hàng nhập trước ${until} theo mô tả – thời hạn đã qua]` : ""
            byCountry.push(`- ${x.htsno}${/terminated|expired/i.test(desc) ? " [ĐÃ CHẤM DỨT theo ghi chú của HTS]" : closed} | General: ${x.general || "–"} | ${clip(desc, 600)}`)
            if (!/terminated|expired/i.test(desc) && !closed) active.push(`${x.htsno} (${x.general || "–"})`)
          }
        }
        if (vnName) out.push(`Hàng xuất xứ Việt Nam: áp dụng cột 1 “General” (Việt Nam không thuộc Column 2; cột “Special” chỉ dành cho chương trình/đối tác có ký hiệu trong ngoặc – xem General Notes của HTS)${rateLine ? ` → ${rateLine}` : ""}.`)
        if (active.length) out.push(`⚠ KHÔNG kết luận tổng thuế = mức General: HTS hiện hành còn tiêu mục Chương 99 nêu đích danh Việt Nam chưa ghi chấm dứt – ${active.join("; ")} – thuế bổ sung này cộng vào mức của phân nhóm nếu mặt hàng thuộc phạm vi (xem mô tả, ngoại lệ và chú giải dẫn chiếu bên dưới); nêu rõ trong câu trả lời.`)
        if (extra.length) out.push(`Tiêu mục Chương 99 được chú thích của các dòng trên dẫn chiếu:\n${extra.join("\n")}`)
        if (byCountry.length) out.push(`Tiêu mục Chương 99 trong HTS hiện hành nêu đích danh Việt Nam (thuế bổ sung cộng vào mức của phân nhóm; phạm vi, ngoại lệ và ngày áp dụng theo chú giải của Chương 99 – kiểm tra mặt hàng có thuộc diện không):\n${byCountry.join("\n")}`)
        out.push("LƯU Ý:")
        out.push("- HTS chỉ thể hiện thuế quan và các biện pháp được đưa vào Chương 99 (VD Mục 232 thép/nhôm, Mục 301, thuế bổ sung theo quốc gia); HTS không gắn chú thích Chương 99 cho từng dòng trong mọi trường hợp → đối chiếu Chương 99 và thông báo của CBP.")
        out.push(`- Thuế chống bán phá giá / chống trợ cấp (AD/CVD) với hàng Việt Nam KHÔNG có trong HTS: tra trav_measures(hs="${d.slice(0, 4)}", market="Hoa Kỳ") và fedreg_search.`)
        out.push(`- Tra cứu thêm: ${HTS} (USITC) · CBP: https://www.cbp.gov/trade · (tra trong ${Math.round((Date.now() - t0) / 1000)} giây)`)
        out.push(CITE)
        const text = out.join("\n")
        recordEvidence(context?.sessionID, { url: pageUrl, title: `HTS ${htsDot(d)}`, text, source: "hts.usitc.gov", meta: { hs: d, release: rel.name, alt_urls: [`${HTS}/reststop/search?keyword=${htsDot(d)}`, `${HTS}/reststop/exportList?from=${h4}&to=${next}&format=JSON&styles=false`, HTS] } })
        const nLines = block.filter((r) => htsDigits(r.htsno ?? "")).length
        if (!uiRates.length && ancRate) uiRates = [{ col: "general", raw: data(ancRate.general, "en"), ...rateUi(ancRate.general) }]
        return withUi(text, { res: count(nLines, "tariffLines"), card: { kind: "tariff", market: "us", code: htsDot(d), origin: cc, ...(cur?.description || rel.description ? { release: String(cur?.description ?? rel.description).slice(0, 40) } : {}), ...(usDate(cur?.releaseStartDate) ? { from: usDate(cur?.releaseStartDate) } : {}), url: pageUrl, lines: uiLines, more: Math.max(0, nLines - uiLines.length), rates: uiRates, ...(active.length ? { extraDuties: active.length } : {}) } })
      })
    } catch (e: any) {
      if (e instanceof Blocked) return `Không tra được HTS Hoa Kỳ: ${e.message}. Không nêu thuế suất theo trí nhớ; thử lại sau.`
      throw e
    }
  },
})

// =====================================================================================================
// European Union – Access2Markets (European Commission, data from TARIC)
// =====================================================================================================
const A2M = "https://trade.ec.europa.eu/access-to-markets"
async function a2mJson(page: any, pathQ: string): Promise<any> {
  return cached(`a2m|${pathQ}`, 6 * 3600_000, async () => {
    if (!page.url().startsWith(A2M)) {
      const res = await politeGoto(page, `${A2M}/en/home`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e: any) => { throw new Blocked(`không kết nối được trade.ec.europa.eu: ${String(e?.message ?? e).slice(0, 80)}`) })
      if ((res?.status() ?? 0) >= 500) throw new Blocked(`trade.ec.europa.eu trả về HTTP ${res?.status()}`)
    }
    const r: { s: number; t: string } = await politeEval("trade.ec.europa.eu", page, async (u: string) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 45000)
      try { const res = await fetch(u, { headers: { accept: "application/json" }, signal: ctl.signal }); return { s: res.status, t: await res.text() } } catch (e: any) { return { s: 0, t: String(e?.message ?? e) } } finally { clearTimeout(timer) }
    }, `${A2M}${pathQ}`)
    if (r.s === 0 || r.s >= 500) throw new Blocked(`API Access2Markets không phản hồi (${r.s ? "HTTP " + r.s : r.t.slice(0, 80)})`)
    if (r.s >= 400) return null
    try { return JSON.parse(r.t) } catch { if (BLOCK_RE.test(r.t)) throw new Blocked("trade.ec.europa.eu chặn truy cập tự động"); return null }
  })
}
/** TARIC regulation id "R2519190" → "R1919/25" + CELEX 32025R1919. */
function taricReg(id: string | null | undefined) {
  const m = String(id ?? "").match(/^([A-Z])(\d{2})(\d{4})(\d)$/)
  if (!m) return { short: String(id ?? ""), celex: "" }
  const yy = Number(m[2])
  return { short: `${m[1]}${m[3]}/${m[2]}`, celex: `3${yy < 60 ? "20" : "19"}${m[2]}${m[1]}${m[3]}` }
}
type EuNode = { code: string | null; description: string; hasChildren: boolean; children?: EuNode[] }
async function euLeaves(page: any, d: string, dest: string, max = 12) {
  const path: string[] = []
  const leaves: { code: string; desc: string; path: string }[] = []
  const walk = async (code: string, depth: number) => {
    const tree: EuNode[] = (await a2mJson(page, `/api/v2/nomenclature/productsByCode?lang=EN&code=${code}&country=${dest}`)) ?? []
    // descend the returned path to the node for `code`
    let node: EuNode | undefined
    const trail: string[] = []
    const find = (ns: EuNode[] | undefined): boolean => {
      for (const n of ns ?? []) {
        if (n.code === code) { node = n; trail.push(n.description); return true }
        if (n.code && !code.startsWith(n.code)) continue
        trail.push(n.description)
        if (find(n.children)) return true
        trail.pop()
      }
      return false
    }
    find(tree)
    if (!node) return
    if (!path.length) path.push(...trail.slice(0, -1))
    if (!node.hasChildren) { leaves.push({ code: node.code!.padEnd(10, "0"), desc: node.description, path: trail.join(" › ") }); return }
    const kids = (node.children ?? []).flatMap((k) => (k.code ? [k] : (k.children ?? [])))
    for (const k of kids) {
      if (leaves.length >= max) return
      if (!k.code) continue
      if (!k.hasChildren) leaves.push({ code: k.code.padEnd(10, "0"), desc: k.description, path: `${trail.join(" › ")} › ${k.description}` })
      else if (depth < 4) await walk(k.code, depth + 1)
    }
  }
  await walk(d, 0)
  return { leaves, path }
}

export const eu = tool({
  description:
    "TRA BIỂU THUẾ NHẬP KHẨU EU (dữ liệu TARIC qua Access2Markets – Ủy ban châu Âu, trade.ec.europa.eu) theo mã HS/CN/TARIC (4–10 số; ngắn = các mã con) và nước xuất xứ (mặc định VN): thuế MFN (Third country duty), ưu đãi thuế quan cho xuất xứ Việt Nam (EVFTA – Tariff preference), thuế chống bán phá giá / chống trợ cấp / tự vệ / thuế bổ sung, hạn ngạch (order number), mã bổ sung theo doanh nghiệp, kèm văn bản pháp lý (mã quy định TARIC + số CELEX) và ngày hiệu lực.",
  args: {
    hs: tool.schema.string().describe("Mã HS/CN/TARIC, VD '0306.17', '0306 17 92 90', '7208390010'"),
    origin: tool.schema.string().optional().describe("Mã ISO 2 chữ nước xuất xứ (mặc định VN)"),
    destination: tool.schema.string().optional().describe("Nước thành viên EU nhập khẩu, ISO 2 chữ (mặc định FR; thuế quan EU như nhau ở mọi nước thành viên)"),
  },
  async execute({ hs, origin, destination }, context) {
    const bad = badCode(hs, 4, 10)
    if (bad) return bad
    const d = digits(hs)
    const org = iso2(origin)
    const dest = iso2(destination, "FR")
    const t0 = Date.now()
    try {
      return await withPage(async (page) => {
        // Access2Markets node codes: 4/6/8/10 digits without trailing "00" levels (0306170000 → 030617)
        let c = d.length % 2 ? d.slice(0, -1) : d
        while (c.length > 4 && c.endsWith("00")) c = c.slice(0, -2)
        const { leaves, path } = await euLeaves(page, c, dest)
        const humanUrl = (c: string) => `${A2M}/en/results?product=${c}&origin=${org}&destination=${dest}`
        if (!leaves.length) return `Không tìm thấy mã ${dotEU(d)} trong Danh mục của EU (Access2Markets, tra ngày ${today()}). Kiểm tra lại mã hoặc dùng tariff_search(query, market="eu").`
        const out: string[] = []
        out.push(`BIỂU THUẾ NHẬP KHẨU EU (TARIC qua Access2Markets – Ủy ban châu Âu) – mã ${dotEU(d)} – xuất xứ ${org}${org === "VN" ? " (Việt Nam)" : ""} → ${dest}`)
        if (path.length) out.push(`Nhóm: ${path.map((p) => clip(p, 150)).join(" › ")}`)
        const MAX = 8
        if (leaves.length > MAX) out.push(`(${leaves.length}+ mã TARIC 10 số; hiển thị ${MAX} mã đầu – nhập mã chi tiết hơn để xem mã khác)`)
        const summary: string[] = []
        const uiLines: Record<string, unknown>[] = []
        const uiRates: Record<string, unknown>[] = [] // measures of the first code, for the web card
        const EU_COL = (t: string) => (/^Third country duty/i.test(t) ? "third_country" : /^Tariff preference/i.test(t) ? "preference" : /^Low-value consignment/i.test(t) ? "lvc" : /quota/i.test(t) ? "quota" : /anti-dumping/i.test(t) ? "antidumping" : /countervailing/i.test(t) ? "countervailing" : /safeguard/i.test(t) ? "safeguard" : /Additional duties/i.test(t) ? "additional" : "other")
        for (const leaf of leaves.slice(0, MAX)) {
          const groups: any[] = (await a2mJson(page, `/api/tariffs/get/${leaf.code}/${org}/${dest}?lang=EN`)) ?? []
          const upd: any = await a2mJson(page, `/api/lastupdate/tariffs/${org}/${dest}/${leaf.code}?lang=EN`).catch(() => null)
          out.push("")
          const segs = (leaf.path || leaf.desc).split(" › ")
          out.push(`■ ${dotEU(leaf.code)} – ${clip(segs.slice(Math.max(0, segs.length - 3)).join(" › "), 300)}`)
          if (uiLines.length < 6) uiLines.push({ code: dotEU(leaf.code), desc: data(stripHtml(leaf.desc), "en") })
          out.push(`  Nguồn: ${humanUrl(leaf.code)}${upd?.dateFormatted ? ` · dữ liệu cập nhật ${upd.dateFormatted}` : ""}`)
          if (!groups.length) { out.push("  (không có biện pháp nào được trả về)"); continue }
          let mfn = "", pref = "", ad: string[] = []
          for (const g of groups) {
            if (g.description) out.push(`  [${clip(stripHtml(g.description), 160)}]`)
            for (const m of g.measures ?? []) {
              const reg = taricReg(m.regulationId)
              const rate = m.tariffFormula ? pctPlain(String(m.tariffFormula).replace(/(\d)%$/, "$1 %")) : ""
              const cond = (m.conditions ?? []).filter((c: any) => c.tariffFormula || c.description).map((c: any) => `${c.description ?? ""}${c.certificateType ? ` (${c.certificateType}${c.certificateNumber ?? ""})` : ""}${c.tariffFormula ? ` → ${pctPlain(String(c.tariffFormula).replace(/(\d)%$/, "$1 %"))}` : ""}`).slice(0, 3).join("; ")
              const addc = m.additionalCodeId ? ` · mã bổ sung ${m.additionalCodeId}: ${clip(stripHtml(m.additionalCodeText ?? "").replace(/<br>/g, " "), 200)}` : ""
              const line = `  • [${m.origin}] ${m.type}${m.startDate ? ` (${m.startDate}${m.endDate && !/3000/.test(m.endDate) ? ` – ${m.endDate}` : " –"})` : ""}: ${rate || "(không ghi mức)"}${m.regulationOrderNumber ? ` · hạn ngạch số ${m.regulationOrderNumber}` : ""}${addc}${m.exclusions ? ` · trừ: ${m.exclusions}` : ""}${cond ? ` · điều kiện: ${clip(cond, 260)}` : ""} — văn bản ${reg.short}${reg.celex ? ` (CELEX ${reg.celex})` : ""}`
              out.push(line)
              if (leaf === leaves[0] && uiRates.length < 10) { const col = EU_COL(String(m.type ?? "")); uiRates.push({ col, ...(m.origin === "ERGA OMNES" ? { geo: "erga_omnes" } : { geoName: data(m.origin, "en") }), ...(col === "other" ? { label: data(m.type, "en") } : {}), raw: data(rate || "–", "en"), ...rateUi(rate), ...(reg.short ? { basis: reg.short } : {}), ...(isoDate(m.startDate) ? { from: isoDate(m.startDate) } : {}), ...(m.endDate && !/3000/.test(m.endDate) && isoDate(m.endDate) ? { to: isoDate(m.endDate) } : {}), ...(m.regulationOrderNumber ? { quota: String(m.regulationOrderNumber) } : {}) }) }
              for (const f of (m.footnotes ?? []).slice(0, 2)) out.push(`      chú thích ${f.type}${f.code}: ${clip(stripHtml(String(f.text).replace(/<br>/g, " ")), 260)}`)
              if (/^Third country duty/i.test(m.type) && !mfn) mfn = rate
              if (/Tariff preference/i.test(m.type) && !pref) pref = `${rate} (${reg.short}${reg.celex ? `, CELEX ${reg.celex}` : ""})`
              if (/anti-dumping|countervailing|safeguard|Additional duties/i.test(m.type) && m.tariffFormula) ad.push(`${m.type}${m.additionalCodeId ? ` [${m.additionalCodeId}]` : ""}: ${rate}`)
            }
          }
          summary.push(`- ${dotEU(leaf.code)}: MFN (Third country duty) ${mfn || "–"}; ưu đãi cho xuất xứ ${org} ${pref || "không có trong dữ liệu"}${ad.length ? `; ${ad.slice(0, 4).join("; ")}` : ""}`)
          const all = groups.flatMap((g) => g.measures ?? [])
          if (all.some((m: any) => /tariff quota/i.test(m.type)) && all.some((m: any) => /Additional duties/i.test(m.type)))
            summary.push(`  ⚠ ${dotEU(leaf.code)} có cả hạn ngạch thuế quan và “Additional duties”: phạm vi / mức trong và ngoài hạn ngạch theo văn bản (${[...new Set(all.filter((m: any) => /tariff quota|Additional duties/i.test(m.type)).map((m: any) => taricReg(m.regulationId).celex).filter(Boolean))].join(", ")}) – đọc bằng eurlex_document trước khi kết luận mức phải nộp.`)
        }
        out.push("")
        out.push(`TÓM TẮT (nguyên văn mức thuế từ TARIC; tra ngày ${today()}):`)
        out.push(...summary)
        out.push("LƯU Ý:")
        if (org === "VN") out.push("- “Tariff preference” cho Viet Nam là thuế suất ưu đãi theo EVFTA (Quyết định (EU) 2020/753 – CELEX 32020D0753 khi văn bản ghi D0753/20): chỉ áp dụng khi hàng có xuất xứ Việt Nam theo Nghị định thư về quy tắc xuất xứ của EVFTA và có chứng từ chứng nhận xuất xứ hợp lệ; không đáp ứng → thuế MFN (Third country duty).")
        out.push("- Thuế chống bán phá giá / chống trợ cấp theo mã bổ sung (additional code) của từng doanh nghiệp: đọc Điều 1 văn bản bằng eurlex_document(\"<CELEX>\"). Thuế GTGT / tiêu thụ đặc biệt do từng nước thành viên quy định.")
        out.push(`- TARIC (trang tra cứu của Ủy ban châu Âu, để người dùng tự kiểm tra): https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp?Lang=en · (tra trong ${Math.round((Date.now() - t0) / 1000)} giây)`)
        out.push(CITE)
        const text = out.join("\n")
        recordEvidence(context?.sessionID, { url: humanUrl(leaves[0].code), title: `EU tariff ${dotEU(d)} ${org}`, text, source: "trade.ec.europa.eu", meta: { hs: d, origin: org, alt_urls: leaves.slice(0, MAX).map((l) => humanUrl(l.code)).concat(`${A2M}/api/tariffs/get/${leaves[0].code}/${org}/${dest}`) } })
        return withUi(text, { res: count(Math.min(leaves.length, MAX), "tariffLines"), card: { kind: "tariff", market: "eu", code: dotEU(d), origin: org, dest, url: humanUrl(leaves[0].code), lines: uiLines, more: Math.max(0, leaves.length - uiLines.length), rates: uiRates } })
      })
    } catch (e: any) {
      if (e instanceof Blocked) return `Không tra được biểu thuế EU: ${e.message}. Không nêu thuế suất theo trí nhớ; thử lại sau.`
      throw e
    }
  },
})

// =====================================================================================================
// tariff_search – description → candidate HS codes (suggestions)
// =====================================================================================================
type VnEntry = { code: string; desc: string; path: string; rate: string }
let vnIndex: VnEntry[] | null = null
async function vnNomenclature(page: any): Promise<{ entries: VnEntry[]; doc: VDoc }> {
  const r = await vbplByNumber("26/2023/NĐ-CP")
  if (!r.base) throw new Error("không tìm thấy Nghị định 26/2023/NĐ-CP trên vbpl.vn")
  const doc = await vbplDoc(page, r.base)
  if (vnIndex) return { entries: vnIndex, doc }
  const entries: VnEntry[] = []
  for (const t of doc.tables.filter((x) => /nhập khẩu ưu đãi/i.test(x.caption) || !/xuất khẩu/i.test(x.caption))) {
    let heading = ""
    const stack: string[] = []
    for (const row of t.rows) {
      const i = row.findIndex((c) => CODE_RE.test(c.trim()))
      const code = i >= 0 ? row[i].trim() : ""
      const desc = (i >= 0 ? row[i + 1] ?? "" : row.find((c) => /^-\s/.test(c.trim())) ?? "").trim()
      const rate = i >= 0 ? (row[i + 2] ?? "").trim() : ""
      if (/^\d{2}\.\d{2}$/.test(code)) { heading = desc; stack.length = 0; continue }
      if (!desc) continue
      const level = Math.max(1, desc.match(/^(-\s*)+/)?.[0].replace(/\s/g, "").length ?? 1)
      stack.length = level - 1
      const p = [heading, ...stack].filter(Boolean).join(" › ")
      stack[level - 1] = desc.replace(/^(-\s*)+/, "").replace(/:$/, "")
      if (code.replace(/\D/g, "").length >= 8 && !/^98/.test(code)) entries.push({ code, desc, path: p, rate })
    }
  }
  vnIndex = entries
  return { entries, doc }
}

export const search = tool({
  description:
    "TÌM MÃ HS theo mô tả hàng hóa (tiếng Việt hoặc tiếng Anh) trong danh mục chính thức: market 'vn' = Biểu thuế nhập khẩu ưu đãi (Phụ lục II Nghị định 26/2023/NĐ-CP trên vbpl.vn, mô tả tiếng Việt AHTN 8 số); 'us' = HTS của USITC; 'eu' = danh mục CN/TARIC (qua các phân nhóm HS6 tìm được). Kết quả chỉ là GỢI Ý mã cần xác nhận (phân loại theo quy tắc tổng quát + chú giải; có thể đề nghị cơ quan hải quan xác định trước mã số) – sau đó tra thuế bằng tariff_vn / tariff_us / tariff_eu.",
  args: {
    query: tool.schema.string().describe("Mô tả hàng hóa, VD 'tôm thẻ chân trắng đông lạnh', 'thép cán nóng dạng cuộn', 'frozen shrimp', 'hot-rolled steel coil'"),
    market: tool.schema.enum(["vn", "us", "eu"]).describe("Danh mục của thị trường nào: vn | us | eu"),
    limit: tool.schema.number().optional().describe("Số gợi ý tối đa (mặc định 10, tối đa 25)"),
  },
  async execute({ query, market, limit }, context) {
    const max = Math.min(Math.max(limit ?? 10, 1), 25)
    const q = query.trim()
    if (q.length < 2) return "Cần mô tả hàng hóa (ít nhất vài từ)."
    const sid = context?.sessionID
    const ascii = !/[^\x00-\x7f]/.test(q)
    try {
      return await withPage(async (page) => {
        const out: string[] = []
        const htsHits = async () => {
          const j: any[] = (await htsJson(page, `/reststop/search?keyword=${encodeURIComponent(q)}`)) ?? []
          // the API matches any word: rank by the rarer query words (idf) found in the description
          const rows = j.filter((x) => x.htsno && !/^99/.test(x.htsno))
          const stem = (w: string) => w.replace(/(es|s)$/, "")
          const words = [...new Set(fold(q).split(" ").filter((w) => w.length > 2 && !/^(the|and|for|with|of)$/.test(w)).map(stem))]
          const has = (x: any, w: string) => fold(stripHtml(x.description)).split(" ").some((t) => stem(t) === w || t.startsWith(w))
          const df = new Map(words.map((w) => [w, rows.filter((x) => has(x, w)).length]))
          const idf = (w: string) => Math.log((rows.length + 1) / (1 + (df.get(w) ?? 0)))
          return rows.map((x) => ({ x, s: words.filter((w) => has(x, w)).reduce((a, w) => a + idf(w), 0) + (digits(x.htsno).length >= 8 ? 0.01 : 0) }))
            .filter((y) => y.s > 0.01).sort((a, b) => b.s - a.s).map((y) => y.x)
        }
        if (market === "vn" && !(ascii && /\b(the|of|and|frozen|steel|shrimp|with|for)\b/i.test(q))) {
          const { entries, doc } = await vnNomenclature(page)
          const words = fold(q).split(" ").filter((w) => w.length > 1)
          const scored = entries.map((e) => {
            const hay = ` ${fold(`${e.path} ${e.desc}`)} `
            const hit = words.filter((w) => hay.includes(` ${w} `) || (w.length > 3 && hay.includes(w))).length
            const specific = ` ${fold(`${e.path.split(" › ").slice(1).join(" ")} ${e.desc}`)} `
            const own = words.filter((w) => specific.includes(` ${w} `)).length
            return { e, s: hit / words.length + (own / words.length) * 0.5 }
          }).filter((x) => x.s >= (words.length > 2 ? 0.66 : 1)).sort((a, b) => b.s - a.s).slice(0, max)
          if (!scored.length) return `Không tìm thấy mô tả khớp "${q}" trong Biểu thuế nhập khẩu ưu đãi (Phụ lục II Nghị định 26/2023/NĐ-CP, vbpl.vn). Thử từ khóa ngắn hơn / từ đồng nghĩa (VD "tôm" thay "tôm thẻ"), hoặc market "us" với mô tả tiếng Anh.`
          out.push(`GỢI Ý MÃ HS (Việt Nam – AHTN 8 số) cho "${q}" – từ mô tả trong Phụ lục II Nghị định 26/2023/NĐ-CP (${doc.url}), tra ngày ${today()}:`)
          scored.forEach((x, i) => {
            const segs = x.e.path.split(" › ")
            out.push(`${i + 1}. ${x.e.code} | ${segs[0] ? clip(segs[0], 70) + " › " : ""}${clip([...segs.slice(1), x.e.desc.replace(/^(-\s*)+/, "")].join(" › "), 220)} | MFN (26/2023): ${pctVi(x.e.rate)}`)
          })
        } else if (market === "vn" || market === "us") {
          const j = await htsHits()
          if (!j.length) return `HTS (USITC) không có mục khớp "${q}". Thử từ khóa tiếng Anh khác (VD "shrimp", "hot-rolled").`
          if (market === "vn") out.push(`(Mô tả tiếng Anh: gợi ý phân nhóm HS6 từ HTS Hoa Kỳ – 6 số đầu dùng chung hệ HS; tra mã 8 số của Việt Nam bằng tariff_vn(hs="<6 số>") để liệt kê các mã con.)`)
          out.push(`GỢI Ý MÃ HTS cho "${q}" (hts.usitc.gov, tra ngày ${today()}):`)
          j.slice(0, max).forEach((x, i) => out.push(`${i + 1}. ${x.htsno} | ${clip(stripHtml(x.description), 220)}${x.general ? ` | General: ${x.general}` : ""}`))
        } else {
          const j = await htsHits()
          const hs6 = [...new Set(j.map((x) => digits(x.htsno).slice(0, 6)).filter((x) => x.length === 6))].slice(0, 6)
          if (!hs6.length) return `Không tìm được phân nhóm HS6 cho "${q}" (tìm qua HTS). Thử mô tả tiếng Anh khác.`
          out.push(`GỢI Ý MÃ CN/TARIC (EU) cho "${q}" – phân nhóm HS6 tìm qua HTS, mã con EU từ Access2Markets (tra ngày ${today()}):`)
          let n = 0
          for (const h of hs6) {
            const { leaves } = await euLeaves(page, h, "FR", 6)
            for (const l of leaves) { if (n >= max) break; out.push(`${++n}. ${dotEU(l.code)} | ${clip(l.path || l.desc, 240)}`) }
          }
        }
        out.push("⚠ Đây chỉ là GỢI Ý dựa trên mô tả – việc phân loại phải theo 6 quy tắc tổng quát và chú giải phần/chương; mã chính thức do cơ quan hải quan quyết định (có thể đề nghị xác định trước mã số). Tra thuế bằng tariff_vn / tariff_us / tariff_eu với mã đã chọn.")
        const text = out.join("\n")
        recordEvidence(sid, { url: `tariff-search://${market}/${encodeURIComponent(q)}`, title: `Tìm mã HS: ${q}`, text, source: "tariff_search" })
        return withUi(text, { res: count(out.filter((l) => /^\d+\. /.test(l)).length, "codes") })
      })
    } catch (e: any) {
      if (e instanceof Blocked) return `Không tìm được mã HS: ${e.message}.`
      throw e
    }
  },
})
