// Deterministic EU (EUR-Lex / CELLAR) tools for the legal agent. Everything goes through the sandbox Chrome
// (DevTools port on 127.0.0.1:$CHROME_PORT, started by run.sh):
//   eurlex_search    – the public CELLAR SPARQL endpoint of the Publications Office
//                      (publications.europa.eu/webapi/rdf/sparql), queried with fetch() inside a page on that
//                      origin: EU trade-defence acts (subject matter "Trade defence instruments"/"Dumping":
//                      anti-dumping, anti-subsidy, anti-circumvention, safeguard, registration, initiations,
//                      reviews) concerning a country (default Vietnam) + product words; or the CBAM / EUDR
//                      family of acts (base regulation + acts based on / amending it)
//   eurlex_document  – metadata (SPARQL) + the official OJ XHTML of the same act served by CELLAR
//                      (publications.europa.eu/resource/celex/<CELEX>) – eur-lex.europa.eu itself answers
//                      automated clients with an HTTP 202 bot challenge, which we do not try to get around –
//                      reduced to Article 1 / the duty table rows of the requested country (default Vietnam)
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import { count, isoDate, withUi } from "../lib/ui-meta.ts"
import puppeteer from "puppeteer-core"
import fs from "node:fs"
import path from "node:path"
import { recordEvidence, recordWarning } from "../lib/evidence.ts"
import { politeEval, politeGoto } from "../lib/polite.ts"

const PORT = process.env.CHROME_PORT ?? "9333"
const CACHE = path.join(process.env.XDG_CACHE_HOME ?? ".", "legalai", "eurlex")
const SPARQL = "https://publications.europa.eu/webapi/rdf/sparql"
const CELLAR = "https://publications.europa.eu/resource/celex/"
const eurlexUrl = (celex: string) => `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`

const today = () => new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" })

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

const TTL_MS = 15 * 60 * 1000
const cache = new Map<string, { at: number; value: any }>()
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}

// SPARQL runs as fetch() inside a page on the publications.europa.eu origin (CORS from about:blank fails).
async function sparql(page: any, query: string): Promise<Record<string, string>[]> {
  return cached(`q|${query}`, async () => {
    if (!/publications\.europa\.eu/.test(page.url())) await politeGoto(page, SPARQL, { waitUntil: "domcontentloaded", timeout: 60000 })
    const r = await politeEval(SPARQL, page, async (endpoint: string, q: string) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 45000)
      try {
        const res = await fetch(`${endpoint}?query=${encodeURIComponent(q)}&format=${encodeURIComponent("application/sparql-results+json")}`, { signal: ctl.signal })
        const body = await res.text()
        return { status: res.status, body }
      } catch (e: any) {
        return { status: 0, body: String(e?.message ?? e) }
      } finally {
        clearTimeout(timer)
      }
    }, SPARQL, query)
    if (r.status !== 200) throw new Error(`CELLAR SPARQL lỗi (HTTP ${r.status}): ${r.body.slice(0, 200)}`)
    const j = JSON.parse(r.body)
    return j.results.bindings.map((b: any) => Object.fromEntries(Object.entries(b).map(([k, v]: any) => [k, v.value])))
  })
}

const esc = (s: string) => s.replace(/["\\]/g, "\\$&")
const P = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX sm: <http://publications.europa.eu/resource/authority/subject-matter/>
`
const ENG = "<http://publications.europa.eu/resource/authority/language/ENG>"

// ---------- countries ----------

const COUNTRIES = [
  "Vietnam", "China", "Korea", "Taiwan", "India", "Indonesia", "Malaysia", "Thailand", "Cambodia", "Laos", "Myanmar", "Philippines",
  "Singapore", "Japan", "Egypt", "Türkiye", "Russia", "Belarus", "Ukraine", "Brazil", "Mexico", "Argentina", "United States", "Canada",
  "Oman", "Saudi Arabia", "United Arab Emirates", "Israel", "Iran", "Pakistan", "Bangladesh", "Sri Lanka", "Uzbekistan", "Kazakhstan",
  "South Africa", "Morocco", "Tunisia", "Algeria", "Serbia", "Bosnia and Herzegovina", "North Macedonia", "Australia", "New Zealand",
  "United Kingdom", "Norway", "Switzerland", "Hong Kong", "Macao", "Georgia", "Moldova", "Kosovo", "Albania", "Montenegro",
]
const countryRe = new RegExp(`\\b(Viet ?Nam|People['’]s Republic of China|Republic of Korea|Turkey|Türkiye|${COUNTRIES.filter((c) => !["Vietnam", "Türkiye"].includes(c)).join("|")})\\b`, "gi")
const canonCountry = (s: string) => {
  const l = s.toLowerCase()
  if (/viet ?nam/.test(l)) return "Vietnam"
  if (/china/.test(l)) return "China"
  if (/korea/.test(l)) return "Korea"
  if (/turkey|türkiye/.test(l)) return "Türkiye"
  return COUNTRIES.find((c) => c.toLowerCase() === l) ?? s
}
const countriesIn = (s: string) => [...new Set([...s.matchAll(countryRe)].map((m) => canonCountry(m[0])))]
const countryPattern = (c: string) => (canonCountry(c) === "Vietnam" ? "viet ?nam" : canonCountry(c) === "Türkiye" ? "t(ü|u)rkiye|turkey" : canonCountry(c).toLowerCase())
const listCap = (xs: string[], n = 10) => xs.slice(0, n).join(", ") + (xs.length > n ? `, … (+${xs.length - n} nước)` : "")
const EUROVOC:Record<string, string> = { Vietnam: "4707", China: "5969", Malaysia: "1767" }

// ---------- search ----------

const MEASURES: Record<string, { label: string; re?: string }> = {
  all: { label: "mọi biện pháp PVTM" },
  "anti-dumping": { label: "chống bán phá giá", re: "dumping" },
  "anti-subsidy": { label: "chống trợ cấp", re: "countervailing|subsid" },
  circumvention: { label: "chống lẩn tránh", re: "circumvent" },
  safeguard: { label: "tự vệ", re: "safeguard" },
  registration: { label: "đăng ký nhập khẩu", re: "registration" },
  initiation: { label: "thông báo khởi xướng", re: "initiation" },
  review: { label: "rà soát (cuối kỳ/giữa kỳ/hết hạn)", re: "review|expiry" },
}
const FAMILIES: Record<string, { celex: string; label: string }> = {
  cbam: { celex: "32023R0956", label: "CBAM – Cơ chế điều chỉnh biên giới carbon (Quy định (EU) 2023/956)" },
  eudr: { celex: "32023R1115", label: "EUDR – Quy định chống phá rừng (Quy định (EU) 2023/1115)" },
}
const TYPE_VI: Record<string, string> = {
  REG_IMPL: "Quy định thực thi (Implementing Regulation)", DEC_IMPL: "Quyết định thực thi (Implementing Decision)", REG: "Quy định (Regulation)",
  REG_DEL: "Quy định ủy quyền (Delegated Regulation)", DEC: "Quyết định (Decision)", ANNOUNC: "Thông báo trên OJ C (Notice)", DIR: "Chỉ thị (Directive)",
  COMMUNIC: "Thông tin (Communication)", PROP_REG: "Đề xuất quy định", CORRIGENDUM: "Đính chính (Corrigendum)", NOTICE: "Thông báo", GUIDELINE: "Hướng dẫn",
}
const typeVi = (t: string) => TYPE_VI[t] ?? t

function shortTitle(t: string) {
  return t.replace(/\s+/g, " ").trim()
}

export const search = tool({
  description: "Tìm văn bản pháp luật EU trên CSDL chính thức của Văn phòng Xuất bản EU (CELLAR – cùng dữ liệu với EUR-Lex): các biện pháp phòng vệ thương mại của EU liên quan tới một nước (mặc định Việt Nam) – chống bán phá giá, chống trợ cấp, chống lẩn tránh, tự vệ, đăng ký hàng nhập khẩu, thông báo khởi xướng, rà soát – lọc theo từ khóa sản phẩm tiếng Anh (VD 'hot-rolled steel', 'PET', 'plywood'), loại biện pháp và khoảng ngày; hoặc nhóm văn bản CBAM / EUDR (measure = 'cbam' / 'eudr': quy định gốc + văn bản thực thi/sửa đổi). Trả về số CELEX, tiêu đề, ngày, loại văn bản, còn hiệu lực hay không, link EUR-Lex và ELI. Đọc mức thuế / Điều 1 bằng eurlex_document(CELEX).",
  args: {
    query: tool.schema.string().optional().describe("Từ khóa tiếng Anh trong tiêu đề, VD 'hot-rolled', 'cold-rolled steel', 'polyethylene terephthalate', 'default values' (bỏ trống = mọi sản phẩm)"),
    country: tool.schema.string().optional().describe("Nước xuất xứ/liên quan (mặc định 'Vietnam'); 'all' = không lọc theo nước"),
    measure: tool.schema.enum(["all", "anti-dumping", "anti-subsidy", "circumvention", "safeguard", "registration", "initiation", "review", "cbam", "eudr"]).optional().describe("Loại: all (mặc định, mọi biện pháp PVTM), anti-dumping, anti-subsidy, circumvention, safeguard, registration, initiation, review; hoặc cbam / eudr"),
    date_from: tool.schema.string().optional().describe("Ngày văn bản từ (YYYY-MM-DD)"),
    date_to: tool.schema.string().optional().describe("Ngày văn bản đến (YYYY-MM-DD)"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa (mặc định 10, tối đa 30)"),
  },
  async execute({ query, country, measure, date_from, date_to, limit }, context) {
    const max = Math.min(Math.max(limit ?? 10, 1), 30)
    const m = measure ?? "all"
    const fam = FAMILIES[m]
    const want = fam ? (country && country !== "all" ? canonCountry(country) : undefined) : country === "all" ? undefined : canonCountry(country ?? "Vietnam")
    const iso = /^\d{4}-\d{2}-\d{2}$/
    if (date_from && !iso.test(date_from)) return "date_from phải có dạng YYYY-MM-DD"
    if (date_to && !iso.test(date_to)) return "date_to phải có dạng YYYY-MM-DD"
    const words = (query ?? "").toLowerCase().split(/[\s,;]+/).map((w) => w.trim()).filter((w) => w.length > 1 && !/^(vietnam|viet|nam|eu|the|of|and|on|imports?|duty|duties)$/.test(w))
    const filters: string[] = []
    for (const w of words) filters.push(`FILTER(CONTAINS(LCASE(STR(?title)), "${esc(w)}"))`)
    if (MEASURES[m]?.re) filters.push(`FILTER(REGEX(STR(?title), "${MEASURES[m].re}", "i"))`)
    if (date_from) filters.push(`FILTER(?date >= "${date_from}"^^xsd:date)`)
    if (date_to) filters.push(`FILTER(?date <= "${date_to}"^^xsd:date)`)
    let where: string
    if (fam) {
      where = `?base cdm:resource_legal_id_celex "${fam.celex}"^^xsd:string .
        { ?w cdm:resource_legal_based_on_resource_legal ?base } UNION { ?w cdm:resource_legal_amends_resource_legal ?base } UNION { BIND(?base AS ?w) }`
      if (want) filters.push(`FILTER(REGEX(STR(?title), "${countryPattern(want)}", "i"))`)
    } else {
      where = `{ ?w cdm:resource_legal_is_about_subject-matter sm:ITDI } UNION { ?w cdm:resource_legal_is_about_subject-matter sm:DUMP }`
      if (want) {
        const ev = EUROVOC[want]
        filters.push(ev
          ? `FILTER(EXISTS { ?w cdm:work_is_about_concept_eurovoc <http://eurovoc.europa.eu/${ev}> } || REGEX(STR(?title), "${countryPattern(want)}", "i"))`
          : `FILTER(REGEX(STR(?title), "${countryPattern(want)}", "i"))`)
      }
    }
    const q = `${P}SELECT ?celex (SAMPLE(?date0) AS ?date) (SAMPLE(?type0) AS ?type) (SAMPLE(?title0) AS ?title) (SAMPLE(?eli0) AS ?eli) (SAMPLE(?inforce0) AS ?inforce) WHERE {
      ${where}
      ?w cdm:resource_legal_id_celex ?celex ; cdm:work_date_document ?date .
      ?e cdm:expression_belongs_to_work ?w ; cdm:expression_uses_language ${ENG} ; cdm:expression_title ?title .
      OPTIONAL { ?w cdm:work_has_resource-type ?t }
      OPTIONAL { ?w cdm:resource_legal_eli ?eli }
      OPTIONAL { ?w cdm:resource_legal_in-force ?inf }
      FILTER(!STRSTARTS(STR(?celex), "0"))
      ${filters.join("\n      ")}
      BIND(?date AS ?date0) BIND(REPLACE(STR(?t), "^.*/", "") AS ?type0) BIND(?title AS ?title0) BIND(STR(?eli) AS ?eli0) BIND(STR(?inf) AS ?inforce0)
    } GROUP BY ?celex ORDER BY DESC(?date) LIMIT ${max + 1}`
    return withPage(async (page) => {
      let rows: Record<string, string>[]
      try {
        rows = await sparql(page, q)
      } catch (e: any) {
        return `Không truy vấn được CSDL CELLAR/EUR-Lex: ${e?.message ?? e}. Thử lại sau vài phút.`
      }
      const scope = fam ? fam.label : `${MEASURES[m].label}${want ? ` · nước: ${want}` : ""}`
      if (!rows.length) return withUi(`Không có văn bản EU khớp (${scope}${query ? ` · từ khóa "${query}"` : ""}${date_from || date_to ? ` · ${date_from ?? "…"} → ${date_to ?? "…"}` : ""}). Thử từ khóa tiếng Anh ngắn hơn (VD 'steel', 'hot-rolled'), bỏ lọc ngày, hoặc measure 'all'.`, { res: count(0, "docs") })
      const more = rows.length > max
      const list = rows.slice(0, max)
      for (const r of list) recordEvidence(context?.sessionID, { url: eurlexUrl(r.celex), title: r.title, text: `${r.celex} · ${r.date} · ${r.type} · ${shortTitle(r.title ?? "")}`, source: "eurlex_search", meta: { celex: r.celex, eli: r.eli, date: r.date, type: r.type } })
      return withUi([
        `EUR-Lex/CELLAR: ${scope}${query ? ` · từ khóa "${query}"` : ""}${date_from || date_to ? ` · ${date_from ?? "…"} → ${date_to ?? "…"}` : ""} – ${list.length}${more ? "+" : ""} văn bản, mới nhất trước:`,
        ...list.map((r, i) => {
          const cs = countriesIn(r.title ?? "")
          const status = r.inforce === "1" || r.inforce === "true" ? "còn hiệu lực" : r.inforce === "0" || r.inforce === "false" ? "hết hiệu lực/không còn áp dụng" : ""
          return `${i + 1}. [${r.date}] CELEX ${r.celex} · ${typeVi(r.type ?? "")}${status ? ` · ${status}` : ""}\n   ${shortTitle(r.title ?? "").slice(0, 330)}${cs.length ? `\n   Nước nêu trong tiêu đề: ${cs.join(", ")}` : ""}\n   ${eurlexUrl(r.celex)}${r.eli ? ` · ELI ${r.eli}` : ""}`
        }),
        more ? `(còn kết quả khác – thu hẹp bằng query / date_from / measure)` : "",
        `(nguồn: CELLAR SPARQL – Văn phòng Xuất bản EU, tra ngày ${today()}; đọc Điều 1 / bảng mức thuế: eurlex_document(CELEX))`,
      ].filter(Boolean).join("\n"), { res: count(list.length, "docs") })
    })
  },
})

// ---------- document ----------

function celexOf(input: string): string {
  const s = decodeURIComponent(input.trim())
  const m = s.match(/CELEX[:%3A]*\s*([0-9][0-9]{4}[A-Z]{1,2}[0-9]{3,5}(?:\(\d+\))?)/i) ?? s.match(/\b([1-9][0-9]{4}[A-Z]{1,2}[0-9]{3,5}(?:\(\d+\))?)\b/)
  if (m) return m[1].toUpperCase()
  const eli = s.match(/eli\/(reg_impl|reg_del|reg|dec_impl|dec_del|dec|dir_impl|dir)\/(\d{4})\/(\d+)/i)
  if (eli) {
    const letter = eli[1].toLowerCase().startsWith("reg") ? "R" : eli[1].toLowerCase().startsWith("dec") ? "D" : "L"
    return `3${eli[2]}${letter}${eli[3].padStart(4, "0")}`
  }
  const num = s.match(/\b(Regulation|Decision|Directive)\b[^0-9]*(?:\(EU\)\s*)?(?:No\s*)?(\d{4})\/(\d{1,4})\b/i)
  if (num) {
    const letter = /^reg/i.test(num[1]) ? "R" : /^dec/i.test(num[1]) ? "D" : "L"
    return `3${num[2]}${letter}${num[3].padStart(4, "0")}`
  }
  throw new Error("Cần số CELEX (VD '32025R1919', '52025XC05025'), link EUR-Lex (…uri=CELEX:…), link ELI (data.europa.eu/eli/reg_impl/2025/1919/oj) hoặc 'Regulation (EU) 2025/1919'. Dùng eurlex_search để lấy CELEX.")
}

type Doc = { text: string; cellar: string; contentType: string }

// Official XHTML from CELLAR; tables are flattened in the page into "@@ROW a | b | c" lines between
// @@TABLE / @@END markers so rows can be filtered by country; 2-column list layouts become "(i) text".
async function loadDoc(page: any, celex: string): Promise<Doc> {
  const file = path.join(CACHE, `${celex.replace(/[^\w()-]/g, "_")}.json`)
  try {
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 30 * 24 * 3600 * 1000) return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {}
  const res = await politeGoto(page, `${CELLAR}${celex}?language=eng`, { waitUntil: "domcontentloaded", timeout: 90000 })
  const status = res?.status() ?? 0
  if (status >= 400 || !res) throw new Error(`CELLAR trả về HTTP ${status} cho CELEX ${celex} (văn bản không có bản tiếng Anh dạng HTML, hoặc CELEX sai).`)
  // Response headers can be empty when Chrome serves the page from its cache – ask the document instead.
  const ct = ((await page.evaluate(() => document.contentType).catch(() => "")) || res.headers()?.["content-type"] || "") as string
  if (!/html|xml/.test(ct)) throw new Error(`CELLAR chỉ có bản ${ct || "không rõ định dạng"} cho CELEX ${celex} (không có HTML) – mở ${eurlexUrl(celex)} để xem PDF.`)
  const text = (await page.evaluate(() => {
    const tables = [...document.querySelectorAll("table")].reverse()
    for (const t of tables) {
      const rows = [...(t as HTMLTableElement).rows].filter((r) => r.closest("table") === t)
      const cells = rows.map((r) => [...r.cells].map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()))
      const list = cells.length > 0 && cells.every((c) => c.length === 2 && c[0].length <= 6)
      const div = document.createElement("div")
      // List layouts keep the line structure of their cells (they can hold an already flattened table).
      const cellText = (c: HTMLTableCellElement) => (c.innerText ?? "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
      div.innerText = list
        ? rows.map((r) => `${cellText(r.cells[0])} ${cellText(r.cells[1])}`).join("\n")
        : ["@@TABLE", ...cells.filter((c) => c.some(Boolean)).map((c) => `@@ROW ${c.join(" | ")}`), "@@END"].join("\n")
      t.replaceWith(div)
    }
    return document.body.innerText
  })) as string
  const doc = { text: text.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n"), cellar: page.url(), contentType: ct }
  try {
    fs.mkdirSync(CACHE, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(doc))
  } catch {}
  return doc
}

type Block = { text: string; table: boolean; part: "pre" | "art1" | "enact" | "post" | "annex"; country?: string; dropped?: string[] }

function blocksOf(text: string): Block[] {
  const out: Block[] = []
  const lines = text.split("\n")
  let part: Block["part"] = "pre"
  let buf: string[] = []
  const flush = () => {
    const t = buf.join("\n").trim()
    if (t) out.push({ text: t, table: false, part })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (l === "@@TABLE") {
      flush()
      const rows: string[] = []
      for (i++; i < lines.length && lines[i].trim() !== "@@END"; i++) if (lines[i].trim().startsWith("@@ROW")) rows.push(lines[i].trim().slice(6))
      if (rows.length) out.push({ text: rows.join("\n"), table: true, part })
      continue
    }
    if (/HA(S|VE) ADOPTED THIS (IMPLEMENTING )?(REGULATION|DECISION|DIRECTIVE)/.test(l)) { buf.push(l); flush(); part = "enact"; continue }
    if ((part === "art1" || part === "enact") && /^Done at /.test(l)) { flush(); part = "post" }
    if (part !== "pre" && part !== "post" && /^Article 1$/.test(l)) { flush(); part = "art1" }
    else if (part === "art1" && /^Article \d+$/.test(l)) { flush(); part = "enact" }
    else if (part !== "pre" && /^ANNEX(\s+[IVX]+)?$/.test(l)) { flush(); part = "annex" }
    if (!l) { flush(); continue }
    buf.push(l)
  }
  flush()
  return out
}

// Keep the header rows and the rows of the wanted country; rows without a country name continue the
// previous row's country (row groups, "Other cooperating companies" continuations…).
function filterTable(b: Block, want: string) {
  const rows = b.text.split("\n")
  let cur = ""
  const keep: string[] = []
  const dropped = new Set<string>()
  const seen = new Set<string>()
  // A "Country (of origin) / territory" column decides the row's country when the table has one; a blank
  // cell continues the previous row's country (row groups).
  const col = rows[0].split(" | ").findIndex((c) => /^(country|origin)|country of origin|country or territory/i.test(c.trim()))
  rows.forEach((r, k) => {
    const cell = col >= 0 && k > 0 ? (r.split(" | ")[col] ?? "").trim() : ""
    const cs = cell ? [countriesIn(cell)[0] ?? cell] : col >= 0 && k > 0 ? [] : countriesIn(r)
    if (cs.length === 1) cur = cs[0]
    else if (cs.includes(want)) cur = want
    else if (cs.length > 1) cur = cs[0]
    if (cur) seen.add(cur)
    if (!cur || cur === want) keep.push(r)
    else dropped.add(cur)
  })
  return { rows: keep, countries: [...seen], dropped: [...dropped], filtered: seen.size > 0 }
}

const KEY = /anti-dumping duty|countervailing duty|duty rate|rate of the (definitive|provisional)|dumping margin|subsidy margin|injury margin|%|TARIC additional code|all other (imports|companies)|registration|period of investigation|investigation period|shall expire|entry into force/i

function excerpt(text: string, want: string, focus: string | undefined, cap: number, multi: boolean) {
  const blocks = blocksOf(text)
  const f = focus?.toLowerCase().trim()
  const hasEnact = blocks.some((b) => b.part !== "pre")
  const tableCountries = new Set<string>()
  // Country filter on tables + section country of non-table blocks.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (!b.table) continue
    const r = filterTable(b, want)
    r.countries.forEach((c) => tableCountries.add(c))
    if (r.filtered) {
      b.dropped = r.dropped
      b.country = r.rows.some((x) => countriesIn(x).includes(want)) ? want : r.dropped.length ? "other" : undefined
      b.text = r.rows.join("\n")
    } else if (i > 0) {
      // Country heading right above the table: a short paragraph, or a one-cell table (CBAM annexes).
      const prev = blocks[i - 1]
      const cs = countriesIn(prev.text)
      const oneCell = prev.table && !prev.text.includes(" | ") && !prev.text.includes("\n") && prev.text.length < 60
      if (prev.text.length < 100 && cs.length === 1) b.country = cs[0] === want ? want : "other"
      else if (oneCell) b.country = canonCountry(prev.text.trim()) === want ? want : "other"
      if (oneCell && b.country) prev.country = b.country
    }
  }
  const anyTagged = blocks.some((b) => b.table && b.country)
  const picked = new Map<number, number>()
  // Empty questionnaire / sampling-form tables (notices) carry no facts.
  const formTable = (b: Block) => b.table && b.text.split("\n").slice(1).every((r) => r.split("|").slice(1).every((c) => !c.trim()))
  blocks.forEach((b, i) => {
    if (b.country === "other" || formTable(b)) return
    const low = b.text.toLowerCase()
    const hasFocus = f ? low.includes(f) : false
    const mentionsWant = new RegExp(countryPattern(want), "i").test(b.text)
    if (hasFocus) picked.set(i, 0)
    else if (b.part === "art1") picked.set(i, b.table ? 0.5 : 1)
    else if ((b.part === "enact" || b.part === "annex") && b.table && (b.country === want || (!anyTagged && /%/.test(b.text)))) picked.set(i, 1.5)
    else if (b.part === "enact" && mentionsWant && KEY.test(b.text)) picked.set(i, 2)
    else if (!hasEnact && b.table && b.country === want) picked.set(i, 1.5)
    else if (!hasEnact && mentionsWant && KEY.test(b.text)) picked.set(i, 2.5)
    else if (b.part === "pre" && b.table && b.country === want && /%/.test(b.text)) picked.set(i, 3)
  })
  // Notices (initiations, expiry notices) have no enacting terms: take the opening sections in order
  // (complaint, product, countries, allegation) up to ~half of the budget, then the key facts.
  if (!hasEnact) {
    const start = Math.max(0, blocks.findIndex((b) => /^(The European Commission|1\.\s)/.test(b.text)))
    let budget = cap * 0.5
    for (let k = start; k < blocks.length && budget > 0; k++) {
      if (blocks[k].country === "other" || formTable(blocks[k])) continue
      picked.set(k, Math.min(picked.get(k) ?? 9, 1 + k / 1000))
      budget -= Math.min(blocks[k].text.length, 5000)
    }
    blocks.forEach((b, i) => { if (!picked.has(i) && !formTable(b) && b.country !== "other" && /within \d+ days|period from \d|investigation period|period of investigation|will cover the period/i.test(b.text)) picked.set(i, 2.2) })
  }
  const order = [...picked.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const keep = new Set<number>()
  let used = 0
  const cut = new Map<number, number>()
  for (const [i, prio] of order) {
    const len = Math.min(blocks[i].text.length, 5000)
    if (used + len > cap) {
      // Article 1 is the core of the answer: shorten it rather than drop it.
      if (prio <= 1 && cap - used > 400 && !blocks[i].table) { keep.add(i); cut.set(i, cap - used); used = cap }
      continue
    }
    keep.add(i)
    used += len
  }
  // A section heading ("2.   Product under investigation") whose body did not fit is noise.
  const headingOnly = (t: string) => t.length < 110 && /^(\d+(\.\d+)*\.?\s+\S|Article \d+$|ANNEX)/.test(t) && !/[.;:]$/.test(t)
  for (const i of [...keep]) if (headingOnly(blocks[i].text) && !keep.has(i + 1)) keep.delete(i)
  const chosen = [...keep].sort((a, b) => a - b)
  const parts: string[] = []
  let lastLabel = ""
  chosen.forEach((i, n) => {
    if (n && chosen[n - 1] !== i - 1) parts.push("[…]")
    const b = blocks[i]
    const label = b.table && b.country === want
      ? `[Phần áp dụng cho: ${want}${b.dropped?.length ? ` · đã bỏ các dòng của: ${listCap(b.dropped)}` : ""}${hasEnact && b.part === "pre" ? " · bảng trong phần lý do (recitals), không phải điều khoản" : ""}]`
      : b.table && b.country && b.country !== want ? `[Phần áp dụng cho: ${b.country}]`
      : multi ? "[Phần chung của văn bản – không riêng nước nào]" : ""
    if (label && label !== lastLabel) { parts.push(label); lastLabel = label }
    const body = b.table ? b.text.split("\n").map((r) => `| ${r} |`).join("\n").slice(0, 5000) : b.text.replace(/\n+/g, " ").slice(0, 5000)
    parts.push(cut.has(i) ? `${body.slice(0, cut.get(i))}…(cắt)` : body)
  })
  return { body: parts.join("\n"), tableCountries: [...tableCountries], hasEnact }
}

export const document = tool({
  description: "Mở một văn bản EU (số CELEX như '32025R1919', link EUR-Lex/ELI, hoặc 'Regulation (EU) 2025/1919') từ bản chính thức trên Công báo EU (CELLAR – Văn phòng Xuất bản EU) và trả về: tiêu đề, loại, ngày, ngày hiệu lực / hết hiệu lực, tình trạng hiệu lực, các nước nêu trong văn bản, link EUR-Lex + ELI, cùng ĐOẠN TRÍCH NGUYÊN VĂN: Điều 1 (sản phẩm, mã CN/TARIC, mức thuế) và bảng mức thuế theo doanh nghiệp CHỈ GỒM các dòng của nước yêu cầu (mặc định Vietnam; dòng của nước khác bị loại, có nhãn [Phần áp dụng cho: …]). Với thông báo khởi xướng (OJ C): sản phẩm, nước, cáo buộc, thời hạn. Dùng focus để ưu tiên đoạn có tên doanh nghiệp.",
  args: {
    id: tool.schema.string().describe("Số CELEX (VD '32025R1919', '52025XC05025'), link EUR-Lex / ELI, hoặc 'Regulation (EU) 2025/1919'"),
    country: tool.schema.string().optional().describe("Nước cần lấy mức thuế (mặc định 'Vietnam'); các dòng bảng của nước khác bị loại"),
    focus: tool.schema.string().optional().describe("Từ cần ưu tiên trong đoạn trích, VD tên doanh nghiệp 'Formosa' hoặc 'Hoa Phat'"),
    max_chars: tool.schema.number().optional().describe("Số ký tự đoạn trích tối đa (mặc định 6000)"),
  },
  async execute({ id, country, focus, max_chars }, context) {
    const want = canonCountry(country ?? "Vietnam")
    const celex = celexOf(id)
    return withPage(async (page) => {
      let meta: Record<string, string> | undefined
      try {
        meta = (await sparql(page, `${P}SELECT ?title ?date ?type ?eli ?inforce ?eif ?eov WHERE {
          ?w cdm:resource_legal_id_celex "${esc(celex)}"^^xsd:string ; cdm:work_date_document ?date .
          OPTIONAL { ?e cdm:expression_belongs_to_work ?w ; cdm:expression_uses_language ${ENG} ; cdm:expression_title ?title }
          OPTIONAL { ?w cdm:work_has_resource-type ?t } BIND(REPLACE(STR(?t), "^.*/", "") AS ?type)
          OPTIONAL { ?w cdm:resource_legal_eli ?eli } OPTIONAL { ?w cdm:resource_legal_in-force ?inforce }
          OPTIONAL { ?w cdm:resource_legal_date_entry-into-force ?eif } OPTIONAL { ?w cdm:resource_legal_date_end-of-validity ?eov }
        } LIMIT 1`))[0]
      } catch (e: any) {
        return `Không truy vấn được CSDL CELLAR/EUR-Lex: ${e?.message ?? e}. Thử lại sau vài phút.`
      }
      if (!meta) return `Không tìm thấy văn bản EU có CELEX ${celex}. Dùng eurlex_search để lấy số CELEX đúng.`
      let doc: Doc | undefined
      let note = ""
      try {
        doc = await loadDoc(page, celex)
      } catch (e: any) {
        note = `(Không tải được toàn văn: ${e?.message ?? e}; chỉ có thông tin mô tả.)`
      }
      const title = (meta.title ?? "").replace(/\s+/g, " ").trim()
      const text = doc?.text ?? ""
      const flat = text.replace(/@@(ROW|TABLE|END)/g, " ").replace(/\s+/g, " ")
      const titleCountries = countriesIn(title)
      const textCountries = countriesIn(flat.slice(0, 20000))
      const cap = max_chars ?? 6000
      const multi = titleCountries.length > 1
      const ex = text ? excerpt(text, want, focus, cap, multi) : { body: "", tableCountries: [] as string[], hasEnact: false }
      const covered = titleCountries.length ? titleCountries : ex.tableCountries
      const mentionsWanted = new RegExp(countryPattern(want), "i").test(flat) || new RegExp(countryPattern(want), "i").test(title)
      const tradeDefence = /dumping|subsid|countervailing|circumvent|safeguard|registration/i.test(title)
      const warning = covered.length && !covered.includes(want) && !mentionsWanted
        ? `⚠ CẢNH BÁO: văn bản này KHÔNG đề cập ${want} (áp dụng cho: ${covered.join(", ")}). Không dùng mức thuế trong văn bản này cho ${want}; tìm văn bản khác bằng eurlex_search.`
        : covered.length && !covered.includes(want)
          ? `⚠ LƯU Ý: tiêu đề văn bản chỉ nêu ${covered.join(", ")}; ${want} chỉ xuất hiện trong nội dung – kiểm tra kỹ văn bản có áp dụng cho ${want} không (VD chống lẩn tránh qua ${want}, hoặc chỉ nhắc tới).`
          : !covered.length && tradeDefence && !mentionsWanted
            ? `⚠ LƯU Ý: văn bản không nêu tên ${want}; các đoạn trích dưới đây có thể không áp dụng cho ${want}.`
            : ""
      const url = eurlexUrl(celex)
      if (text) recordEvidence(context?.sessionID, { url, title, text: text.replace(/@@ROW /g, "| ").replace(/@@(TABLE|END)/g, ""), source: "eurlex", meta: { celex, eli: meta.eli, cellar: doc?.cellar, alt_urls: [meta.eli, doc?.cellar].filter(Boolean), date: meta.date, type: meta.type } })
      if (warning) recordWarning(context?.sessionID, url, warning)
      const inforce = meta.inforce === "1" || meta.inforce === "true" ? "còn hiệu lực" : meta.inforce === "0" || meta.inforce === "false" ? "hết hiệu lực / không còn áp dụng" : ""
      const st = meta.inforce === "1" || meta.inforce === "true" ? "in_force" : meta.inforce === "0" || meta.inforce === "false" ? "expired" : undefined
      return withUi([
        warning,
        `Tiêu đề: ${title}`,
        `CELEX ${celex} · ${typeVi(meta.type ?? "")} · ngày ${meta.date}${inforce ? ` · ${inforce}` : ""}`,
        meta.eif || (meta.eov && meta.eov !== "9999-12-31") ? `Ngày có hiệu lực: ${meta.eif ?? "—"}${meta.eov && meta.eov !== "9999-12-31" ? ` · hết hiệu lực: ${meta.eov}` : ""}` : "",
        `Nước trong văn bản: ${listCap(covered.length ? covered : textCountries) || "không nêu nước cụ thể"}${multi && covered.includes(want) ? ` (văn bản nhiều nước – bảng mức thuế chỉ giữ dòng của ${want}, có nhãn [Phần áp dụng cho: …])` : ""}`,
        `Link EUR-Lex: ${url}${meta.eli ? `\nELI: ${meta.eli}` : ""}`,
        doc ? `Bản chính thức (CELLAR, OJ): ${doc.cellar}` : "",
        `Ngày tra cứu: ${today()}`,
        note,
        ex.body ? `--- TRÍCH NGUYÊN VĂN (${ex.hasEnact ? "Điều 1 và bảng mức thuế" : "các mục chính của thông báo"}${focus ? `, ưu tiên đoạn có "${focus}"` : ""}; […] = lược bớt) ---\n${ex.body}` : text ? "(Không tìm thấy Điều 1 / bảng mức thuế trong văn bản.)" : "",
      ].filter(Boolean).join("\n"), { ...(st ? { res: { t: "status", code: st } } : {}), doc: { title, lang: "en", number: `CELEX ${celex}`, status: st, issued: isoDate(meta.date), effective: isoDate(meta.eif), url } })
    })
  },
})
