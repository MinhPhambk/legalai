// Deterministic US Federal Register tools for the legal agent. Everything goes through the sandbox Chrome
// (DevTools port on 127.0.0.1:$CHROME_PORT, started by run.sh):
//   fedreg_search    – the public Federal Register API (www.federalregister.gov/api/v1/documents.json),
//                      opened as a page in Chrome → title, type, agency, date, document number, case numbers
//   fedreg_document  – API metadata for one document + the official GPO text of the same FR document on
//                      govinfo.gov (federalregister.gov's own full-text pages refuse automated clients and
//                      redirect to unblock.federalregister.gov, which we do not try to get around), reduced
//                      to the parts that matter: rates / cash deposits / margins tables, POR, dates
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import { count, isoDate, withUi } from "../lib/ui-meta.ts"
import puppeteer from "puppeteer-core"
import { recordEvidence } from "../lib/evidence.ts"
import { politeGoto } from "../lib/polite.ts"
// Returns the tool output unchanged after recording it as evidence for grounding_check.
const rec = (context: any, url: string, source: string, out: string, title?: string) => (recordEvidence(context?.sessionID, { url, title, text: out, source }), out)

const PORT = process.env.CHROME_PORT ?? "9333"
const API = "https://www.federalregister.gov/api/v1"

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

// Page-text cache: fedreg_search → fedreg_document on the same document loads it once.
const TTL_MS = 15 * 60 * 1000
const cache = new Map<string, { at: number; value: any }>()
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}

async function getJson(page: any, url: string) {
  return cached(`j|${url}`, async () => {
    const res = await politeGoto(page, url, { waitUntil: "domcontentloaded", timeout: 60000 })
    if (/unblock\.federalregister\.gov/.test(page.url())) throw new Error("federalregister.gov chặn truy cập tự động (trang Request Access) – không vượt qua; thử lại sau hoặc mở bằng chrome MCP.")
    const body = (await res?.text()) ?? ""
    try { return JSON.parse(body) } catch { throw new Error(`API Federal Register trả về dữ liệu không phải JSON (HTTP ${res?.status()}).`) }
  })
}

const AGENCIES: Record<string, string> = {
  ita: "international-trade-administration", doc: "international-trade-administration", commerce: "international-trade-administration",
  usitc: "international-trade-commission", itc: "international-trade-commission",
  cbp: "u-s-customs-and-border-protection", customs: "u-s-customs-and-border-protection",
  ustr: "trade-representative-office-of-united-states",
}
const TYPES: Record<string, string> = { notice: "NOTICE", rule: "RULE", proposed: "PRORULE", presidential: "PRESDOCU" }

const CASE_RE = /\b[ACE]-\d{3}-\d{3}\b|\b(?:701|731)-TA-[\d-]+(?:\s*\((?:Preliminary|Final|Review|Second Review|Third Review|Fourth Review|Fifth Review)\))?|\b(?:337|201)-TA-\d+/g
const caseNumbers = (...texts: (string | undefined | null)[]) => [...new Set(texts.filter(Boolean).join(" ").match(CASE_RE) ?? [])]
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim()

export const search = tool({
  description: "Tìm văn bản trên Federal Register Hoa Kỳ (qua API công khai federalregister.gov) liên quan tới Việt Nam + sản phẩm/vụ việc, VD 'galvanized steel antidumping', 'shrimp countervailing', 'A-552-801'. Lọc theo cơ quan (ITA = Bộ Thương mại/DOC, USITC, CBP, USTR), loại văn bản và khoảng ngày đăng. Trả về tiêu đề, loại, cơ quan, ngày đăng, số văn bản (document number), số vụ việc (A-552-xxx / C-552-xxx / 731-TA-xxxx), link html và đoạn khớp. Từ 'Vietnam' tự được thêm vào nếu thiếu. Đọc chi tiết mức thuế bằng fedreg_document.",
  args: {
    query: tool.schema.string().describe("Từ khóa tiếng Anh: sản phẩm / loại vụ việc / số vụ việc, VD 'corrosion-resistant steel antidumping'"),
    agency: tool.schema.string().optional().describe("ITA | USITC | CBP | USTR (bỏ trống = mọi cơ quan)"),
    date_from: tool.schema.string().optional().describe("Ngày đăng từ (YYYY-MM-DD)"),
    date_to: tool.schema.string().optional().describe("Ngày đăng đến (YYYY-MM-DD)"),
    type: tool.schema.enum(["notice", "rule", "proposed", "presidential"]).optional().describe("Loại văn bản (hầu hết thông báo AD/CVD là notice)"),
    order: tool.schema.enum(["relevance", "newest", "oldest"]).optional().describe("Sắp xếp: relevance (mặc định) hoặc newest/oldest"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa (mặc định 8, tối đa 20)"),
  },
  async execute({ query, agency, date_from, date_to, type, order, limit }, context) {
    const term = /viet\s*nam/i.test(query) ? query : `Vietnam ${query}`
    const q = new URLSearchParams()
    q.set("per_page", String(Math.min(limit ?? 8, 20)))
    q.set("order", order ?? "relevance")
    q.set("conditions[term]", term)
    if (agency) {
      const slug = AGENCIES[agency.toLowerCase().replace(/[^a-z]/g, "")] ?? agency
      q.append("conditions[agencies][]", slug)
    }
    if (type) q.append("conditions[type][]", TYPES[type])
    const iso = /^\d{4}-\d{2}-\d{2}$/
    if (date_from) { if (!iso.test(date_from)) return "date_from phải có dạng YYYY-MM-DD"; q.set("conditions[publication_date][gte]", date_from) }
    if (date_to) { if (!iso.test(date_to)) return "date_to phải có dạng YYYY-MM-DD"; q.set("conditions[publication_date][lte]", date_to) }
    for (const f of ["title", "type", "agencies", "publication_date", "document_number", "html_url", "docket_ids", "abstract", "excerpts", "citation"]) q.append("fields[]", f)
    return withPage(async (page) => {
      const j = await getJson(page, `${API}/documents.json?${q}`)
      if (j.errors) return `API Federal Register báo lỗi: ${JSON.stringify(j.errors).slice(0, 300)}`
      const results: any[] = j.results ?? []
      if (!results.length) return withUi(`Không có văn bản Federal Register khớp "${term}"${agency ? ` (cơ quan ${agency})` : ""}. Thử từ khóa ngắn hơn (tên sản phẩm tiếng Anh như trong tiêu đề) hoặc bỏ lọc ngày.`, { res: count(0, "docs") })
      return withUi(rec(context, `https://www.federalregister.gov/documents/search?conditions[term]=${encodeURIComponent(term)}`, "fedreg_search", [
        `Federal Register: ${j.count} văn bản khớp "${term}"${agency ? ` · ${agency}` : ""}${date_from || date_to ? ` · ${date_from ?? "…"} → ${date_to ?? "…"}` : ""} (hiện ${results.length}, sắp xếp ${order ?? "relevance"}):`,
        ...results.map((r, i) => {
          const agencies = (r.agencies ?? []).map((a: any) => a.name ?? a.raw_name).filter((n: string) => n && n !== "Commerce Department").join(", ")
          const cases = caseNumbers(...(r.docket_ids ?? []), r.title, r.abstract, r.excerpts && stripTags(r.excerpts))
          const ex = r.excerpts ? stripTags(r.excerpts).slice(0, 220) : (r.abstract ?? "").slice(0, 220)
          return `${i + 1}. [${r.publication_date}] ${r.title}\n   ${r.type} · ${agencies} · FR Doc ${r.document_number}${r.citation ? ` · ${r.citation}` : ""}${cases.length ? ` · vụ việc: ${cases.join(", ")}` : ""}\n   ${r.html_url}${ex ? `\n   …${ex}…` : ""}`
        }),
        `(nguồn: federalregister.gov API, tra ngày ${today()}; chi tiết mức thuế: fedreg_document(document_number))`,
      ].join("\n")), { res: count(Number(j.count) || results.length, "docs") })
    })
  },
})

// ---------- document text (govinfo.gov, official GPO edition of the same FR document) ----------

function docNumber(input: string) {
  const s = input.trim()
  const m = s.match(/\/(?:documents|d|public-inspection)\/(?:\d{4}\/\d{2}\/\d{2}\/)?([A-Z0-9]{0,3}\d{2,4}-\d{3,6})/i) ?? s.match(/\b(\d{4}-\d{4,6}|[A-Z]\d-\d{3,6}|E\d-\d+)\b/i)
  if (!m) throw new Error("Cần số văn bản Federal Register (VD '2026-19102') hoặc link https://www.federalregister.gov/documents/…")
  return m[1]
}

// Clean the GPO plain text: drop footnote boxes, page markers and inline footnote marks.
function cleanGpo(raw: string) {
  // Page markers can split a sentence ("…margin of\n\n[[Page 8431]]\n\n25.76 percent") – rejoin those.
  const lines = raw.replace(/\r/g, "").replace(/\n\s*\n\s*\[\[Page \d+\]\]\s*\n\s*\n(?=[a-z0-9(])/g, "\n").split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^-{60,}$/.test(l.trim())) {
      // footnote box: dashed line, then "    \N\ text", closed by another dashed line
      let k = i + 1
      while (k < lines.length && !lines[k].trim()) k++
      if (k < lines.length && /^\s*\\\d+\\/.test(lines[k])) {
        let e = k
        while (e < lines.length && !/^-{60,}$/.test(lines[e].trim())) e++
        i = e
        // The box often interrupts a sentence: if the text after it continues that sentence (starts in
        // lower case / with a number), drop the blank lines so the sentence stays in one paragraph.
        let n = i + 1
        while (n < lines.length && !lines[n].trim()) n++
        if (n < lines.length && /^[a-z0-9(,;.]/.test(lines[n]) && out.length && out[out.length - 1].trim()) i = n - 1
        continue
      }
    }
    if (/^\s*\[\[Page \d+\]\]\s*$/.test(l)) continue
    out.push(l.replace(/\\\d+\\/g, ""))
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n")
}

const KEY = /cash deposit|dumping margin|subsidy rate|countervailable subsidy|net subsidy|all[- ]others rate|vietnam[- ]wide|weighted[- ]average|assessment rate|ad valorem|de minimis|estimated subsidy/i
const tidyTable = (s: string) => s.split("\n").map((l) => /^\s*-{10,}\s*$/.test(l) ? "—" : l.replace(/\.{3,}/g, " ").replace(/[ ]{3,}/g, "  ").trimEnd()).join("\n")

// Multi-country notices (one order for Brazil, Canada, Mexico and Vietnam…) list one rate table per
// country. Every excerpt is labelled with the country/case section it belongs to, so rates of one country
// can never be quoted as another country's. Commerce case numbers carry an ISO-like country code.
const CASE_COUNTRY: Record<string, string> = {
  "552": "Vietnam", "351": "Brazil", "122": "Canada", "201": "Mexico", "580": "Korea", "583": "Taiwan", "570": "China",
  "533": "India", "560": "Indonesia", "549": "Thailand", "557": "Malaysia", "489": "Turkey", "602": "Australia",
  "791": "South Africa", "421": "Netherlands", "588": "Japan", "412": "United Kingdom", "428": "Germany", "469": "Spain",
  "475": "Italy", "427": "France", "455": "Poland", "485": "Romania", "821": "Russia", "823": "Ukraine", "520": "UAE",
  "523": "Oman", "535": "Pakistan", "538": "Bangladesh", "555": "Cambodia", "565": "Philippines", "559": "Singapore",
  "729": "Egypt", "487": "Bulgaria", "307": "Venezuela", "331": "Ecuador", "357": "Argentina", "337": "Chile",
  "301": "Colombia", "401": "Sweden", "405": "Finland", "408": "Denmark", "423": "Belgium", "433": "Austria",
  "449": "Latvia", "451": "Lithuania", "508": "Israel", "517": "Saudi Arabia", "779": "Kazakhstan",
}
const COUNTRY_NAMES = [...new Set(Object.values(CASE_COUNTRY))]
const countryRe = new RegExp(`\\b(the Socialist Republic of Vietnam|Viet ?nam|People's Republic of China|Republic of Korea|${COUNTRY_NAMES.filter((c) => !["Vietnam", "China", "Korea"].includes(c)).join("|")}|China|Korea)\\b`, "gi")
const canonCountry = (s: string) => /viet ?nam/i.test(s) ? "Vietnam" : /china/i.test(s) ? "China" : /korea/i.test(s) ? "Korea" : COUNTRY_NAMES.find((c) => c.toLowerCase() === s.toLowerCase()) ?? s
const countriesIn = (s: string) => [...new Set([...s.matchAll(countryRe)].map((m) => canonCountry(m[0])))]
const caseCountry = (c: string) => CASE_COUNTRY[c.match(/^[AC]-(\d{3})/)?.[1] ?? ""]

// GPO tables for several countries put each country's rows under a centred line holding only the country
// name ("Brazil", "Vietnam"…) between dashed rules. Keep the column header plus the wanted country's rows.
function splitTableByCountry(p: string, want: string | undefined) {
  const lines = p.split("\n")
  const marks = lines.map((l, k) => ({ k, c: /^\s{6,}\S.*$/.test(l) && l.trim().length < 60 && countriesIn(l.trim()).length === 1 && countriesIn(l.trim())[0] && l.trim().replace(/^the\s+/i, "").length <= 40 ? countriesIn(l.trim())[0] : "" })).filter((m) => m.c)
  if (marks.length < 2) return { text: p, countries: marks.map((m) => m.c), split: false }
  const countries = marks.map((m) => m.c)
  const idx = want ? countries.indexOf(canonCountry(want)) : -1
  if (idx < 0) return { text: "", countries, split: true }
  const header = lines.slice(0, marks[0].k).join("\n")
  const body = lines.slice(marks[idx].k, idx + 1 < marks.length ? marks[idx + 1].k : lines.length).join("\n")
  return { text: `${header}\n${body}`, countries, split: true }
}

function excerpt(text: string, focus: string | undefined, cap: number, country: string | undefined) {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+$/, "")).filter((p) => p.trim() && !/^\s*(By order of|BILLING CODE|\[FR Doc|Dated:)/.test(p))
  // Multi-country tables → cut down to the wanted country's block before anything else looks at them.
  const tableCountries = new Set<string>()
  for (let i = 0; i < paras.length; i++) {
    if (!/^\s*-{20,}\s*$/m.test(paras[i])) continue
    const s = splitTableByCountry(paras[i], country)
    s.countries.forEach((c) => tableCountries.add(c))
    if (s.split) paras[i] = s.text ? `${s.text}\n@@COUNTRY:${canonCountry(country!)}` : ""
    else if (s.countries.length === 1) paras[i] = `${paras[i]}\n@@COUNTRY:${s.countries[0]}`
  }
  for (let i = paras.length - 1; i >= 0; i--) if (!paras[i]) paras.splice(i, 1)
  const isTable = (p: string) => /^\s*-{20,}\s*$/m.test(p)
  const heading = (p: string) => p.trim().length < 120 && !/[.:;]$/.test(p.trim()) && !isTable(p)
  // Section context: a short heading naming one country, or a case number, opens that country's section.
  const ctx: { country?: string; cases: string[] }[] = []
  let cur: { country?: string; cases: string[] } = { cases: [] }
  paras.forEach((p, i) => {
    const flatP = p.replace(/\s+/g, " ")
    const cs = caseNumbers(flatP)
    const cn = countriesIn(flatP)
    const tagged = p.match(/@@COUNTRY:(.+)$/)?.[1]
    if (tagged) { ctx[i] = { country: tagged, cases: cur.country === tagged ? cur.cases : [] }; return }
    if (heading(p) && cn.length === 1) cur = { country: cn[0], cases: cs }
    else if (heading(p) && cs.length === 1 && caseCountry(cs[0])) cur = { country: caseCountry(cs[0]), cases: cs }
    else if (isTable(p) && cn.length === 1) cur = { country: cn[0], cases: cur.country === cn[0] ? cur.cases : cs }
    ctx[i] = { ...cur }
  })
  const want = country ? canonCountry(country) : undefined
  const sections = new Set([...ctx.map((c) => c.country).filter(Boolean), ...tableCountries])
  const multi = sections.size > 1
  // In a multi-country notice, a rate table that sits in another country's section is excluded.
  const otherCountry = (i: number) => multi && want && ctx[i].country && ctx[i].country !== want
  const f = focus?.toLowerCase().trim()
  const picked = new Map<number, number>() // paragraph index → priority (lower = more important)
  paras.forEach((p, i) => {
    if (otherCountry(i)) return
    const near = paras.slice(Math.max(0, i - 3), i).join(" ")
    const hasFocus = f ? p.toLowerCase().includes(f) : false
    const leadIn = (k: number) => heading(paras[k]) || (paras[k].trim().length < 300 && /:\s*$/.test(paras[k]))
    if (isTable(p) && (KEY.test(p) || KEY.test(near) || /percent|rate|margin/i.test(p))) {
      picked.set(i, hasFocus || /viet\s*nam/i.test(p + near) ? 0 : 1)
      for (let k = i - 1; k >= Math.max(0, i - 2) && leadIn(k); k--) picked.set(k, Math.min(picked.get(k) ?? 9, picked.get(i)!))
    } else if (KEY.test(p) && /\d/.test(p)) picked.set(i, hasFocus ? 0 : /\d\s*percent|cash deposit rate/i.test(p) ? 2 : 2.5)
    else if (hasFocus) picked.set(i, 1)
    else if (/period of (review|investigation)/i.test(p) && !/^\s*(DATES|SUMMARY):/.test(p)) picked.set(i, 3)
  })
  // Nothing about rates (e.g. USITC determinations, initiations): take the opening of SUPPLEMENTARY INFORMATION.
  if (![...picked.values()].some((v) => v <= 2)) {
    let s = paras.findIndex((p) => /SUPPLEMENTARY INFORMATION:/.test(p))
    if (s < 0) s = paras.findIndex((p) => p.trim().length > 300 && !isTable(p)) - 1 // USITC: no AGENCY/SUMMARY header
    for (let k = Math.max(s + 1, 0); k < Math.min(paras.length, s + 6); k++) if (!/^\s*[\[=]/.test(paras[k])) picked.set(k, 4)
  }
  // Add the section heading right above each picked prose paragraph (e.g. "Cash Deposit Requirements").
  for (const i of [...picked.keys()]) if (i > 0 && heading(paras[i - 1]) && !picked.has(i - 1)) picked.set(i - 1, picked.get(i)!)
  const order = [...picked.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const keep = new Set<number>()
  let used = 0
  for (const [i] of order) {
    const len = Math.min(paras[i].length, isTable(paras[i]) ? 6000 : 2500)
    if (used + len > cap) continue
    keep.add(i)
    used += len
  }
  // A heading whose section body did not fit is noise.
  for (const i of [...keep]) if (heading(paras[i]) && !keep.has(i + 1)) keep.delete(i)
  const chosen = [...keep].sort((a, b) => a - b)
  const parts: string[] = []
  let lastLabel = ""
  chosen.forEach((i, n) => {
    if (n && chosen[n - 1] !== i - 1) parts.push("[…]")
    // Label every change of country/case section so each table is tied to the right country and case.
    const c = { ...ctx[i] }
    if (c.country && !c.cases.length) c.cases = caseNumbers(text).filter((x) => caseCountry(x) === c.country)
    const label = c.country ? `[Phần áp dụng cho: ${c.country}${c.cases.length ? ` · ${c.cases.join(", ")}` : ""}]` : multi ? "[Phần chung của văn bản – không riêng nước nào]" : ""
    if (label && label !== lastLabel) { parts.push(label); lastLabel = label }
    const p = paras[i].replace(/\n@@COUNTRY:.+$/, "").slice(0, isTable(paras[i]) ? 6000 : 2500)
    parts.push(isTable(p) ? tidyTable(p) : p.replace(/\s+/g, " ").trim())
  })
  return { body: parts.join("\n"), sections: [...sections] as string[], multi, foundWanted: !want || !multi || sections.has(want) }
}

export const document = tool({
  description: "Mở một văn bản Federal Register (số văn bản như '2026-19102' hoặc link federalregister.gov) và trả về: tiêu đề, loại, cơ quan, ngày đăng, trích dẫn FR, số vụ việc, ngày hiệu lực/DATES, kỳ rà soát/điều tra, cùng ĐOẠN TRÍCH NGUYÊN VĂN liên quan: bảng biên độ phá giá (weighted-average dumping margin), mức trợ cấp (subsidy rate), tỷ lệ ký quỹ (cash deposit), mức toàn quốc (Vietnam-wide / all-others). Văn bản đầy đủ lấy từ bản chính thức của GPO trên govinfo.gov. Dùng focus để ưu tiên đoạn có tên doanh nghiệp.",
  args: {
    id: tool.schema.string().describe("Số văn bản FR (VD '2026-19102') hoặc link https://www.federalregister.gov/documents/…"),
    focus: tool.schema.string().optional().describe("Từ cần ưu tiên trong đoạn trích, VD tên doanh nghiệp 'Hoa Phat' hoặc 'Hoa Sen'"),
    country: tool.schema.string().optional().describe("Nước cần lấy mức thuế trong văn bản nhiều nước (mặc định 'Vietnam'); các bảng của nước khác bị loại"),
    max_chars: tool.schema.number().optional().describe("Số ký tự đoạn trích tối đa (mặc định 6000)"),
  },
  async execute({ id, focus, country, max_chars }, context) {
    const want = country ?? "Vietnam"
    const n = docNumber(id)
    return withPage(async (page) => {
      const d = await getJson(page, `${API}/documents/${n}.json`)
      if (d.errors || !d.document_number) return `Không tìm thấy văn bản Federal Register số ${n}. Dùng fedreg_search để lấy số văn bản đúng.`
      const agencies = (d.agencies ?? []).map((a: any) => a.name ?? a.raw_name).filter((x: string) => x && x !== "Commerce Department").join(", ")
      const gov = `https://www.govinfo.gov/content/pkg/FR-${d.publication_date}/html/${d.document_number}.htm`
      let text = ""
      let note = ""
      try {
        text = await cached(`g|${gov}`, async () => {
          const res = await politeGoto(page, gov, { waitUntil: "domcontentloaded", timeout: 60000 })
          if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status()}`)
          return cleanGpo((await page.evaluate(() => document.body.innerText)) as string)
        })
      } catch (e: any) {
        note = `(Không tải được toàn văn trên govinfo.gov: ${e?.message ?? e}; chỉ có tóm tắt từ API.)`
      }
      const flat = text.replace(/\s+/g, " ")
      const period = flat.match(/[^.]*\bperiod of (?:review|investigation)\b[^.]*\bis\b[^.]*\d{4}[^.]*\./i)?.[0]?.trim() ?? flat.match(/\b(?:POR|POI)\) is [^.]+\./)?.[0]
      const cases = caseNumbers(...(d.docket_ids ?? []), d.title, flat.slice(0, 3000))
      const cap = max_chars ?? 6000
      const ex = text ? excerpt(text, focus, cap, want) : { body: "", sections: [] as string[], multi: false, foundWanted: true }
      const body = ex.body
      // Which countries does this notice actually cover? Title first, then case numbers, then the text.
      const titleCountries = countriesIn(d.title ?? "")
      const caseCountries = [...new Set(cases.map(caseCountry).filter(Boolean))] as string[]
      const covered = titleCountries.length ? titleCountries : caseCountries.length ? caseCountries : ex.sections
      const wantCanon = canonCountry(want)
      const mentionsWanted = covered.includes(wantCanon) || new RegExp(wantCanon === "Vietnam" ? "viet ?nam" : wantCanon, "i").test(flat)
      const warning = !mentionsWanted
        ? `⚠ CẢNH BÁO: văn bản này KHÔNG đề cập ${wantCanon} (áp dụng cho: ${covered.join(", ") || "không xác định"}). Không dùng mức thuế trong văn bản này cho ${wantCanon}; tìm văn bản khác bằng fedreg_search.`
        : !covered.includes(wantCanon) && covered.length
          ? `⚠ LƯU Ý: tiêu đề văn bản chỉ nêu ${covered.join(", ")}; ${wantCanon} chỉ xuất hiện trong nội dung – kiểm tra kỹ văn bản có áp mức thuế cho ${wantCanon} không.`
          : ex.multi && !ex.foundWanted
            ? `⚠ LƯU Ý: văn bản nhiều nước nhưng không tìm thấy phần riêng cho ${wantCanon}; các đoạn trích dưới đây có thể không áp dụng cho ${wantCanon}.`
            : ""
      for (const u of [d.html_url, gov]) recordEvidence(context?.sessionID, { url: u, title: d.title, text: text || String(d.abstract ?? ""), source: "federalregister.gov", meta: { doc: d.document_number, cases } })
      if (warning) recordEvidence(context?.sessionID, { url: d.html_url, text: warning, source: "warning" })
      return withUi([
        warning,
        `Tiêu đề: ${d.title}`,
        `Nước trong văn bản: ${covered.join(", ") || "không xác định"}${ex.multi ? ` (văn bản nhiều nước – đoạn trích chỉ lấy phần của ${wantCanon}, mỗi phần có nhãn [Phần áp dụng cho: …])` : ""}`,
        `Loại: ${d.type}${d.action ? ` (${d.action})` : ""} · Cơ quan: ${agencies}`,
        `Ngày đăng: ${d.publication_date} · ${d.citation ?? ""} · FR Doc ${d.document_number}`,
        cases.length ? `Số vụ việc: ${cases.join(", ")}` : "",
        d.dates ? `DATES: ${d.dates.replace(/\s+/g, " ").slice(0, 400)}` : "",
        d.effective_on ? `Ngày hiệu lực: ${d.effective_on}` : "",
        d.comments_close_on ? `Hạn góp ý: ${d.comments_close_on}` : "",
        period ? `Kỳ rà soát/điều tra: ${period.slice(0, 300)}` : "",
        d.abstract ? `Tóm tắt: ${d.abstract.replace(/\s+/g, " ").slice(0, 600)}` : "",
        `Link: ${d.html_url}`,
        `Bản GPO (govinfo): ${gov}${d.pdf_url ? ` · PDF: ${d.pdf_url}` : ""}`,
        `Ngày tra cứu: ${today()}`,
        note,
        body ? `--- TRÍCH NGUYÊN VĂN (ưu tiên bảng mức thuế/biên độ/ký quỹ${focus ? `, đoạn có "${focus}"` : ""}; […] = lược bớt) ---\n${body}` : text ? "(Văn bản không có bảng mức thuế/ký quỹ – VD thông báo của USITC; xem Tóm tắt/DATES ở trên.)" : "",
      ].filter(Boolean).join("\n"), { doc: { title: d.title, lang: "en", number: `FR Doc ${d.document_number}`, issued: isoDate(d.publication_date), effective: isoDate(d.effective_on), url: d.html_url } })
    })
  },
})
