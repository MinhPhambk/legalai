// Structured, language-neutral step summaries for the step list ("Các bước tra cứu"). The browser renders every
// piece of UI chrome (labels, counters, statuses, units, dates) from codes in its own language; source data quoted
// verbatim (queries, law / article titles, document names, product descriptions…) travels as {v, lang} and is shown
// marked as data (quotes + a small language tag when it differs from the UI language) – never glued into a
// localized sentence.
//
// Sources, in order of preference:
//   1. `state.metadata.ui` of a completed tool part – written by our tools (../.opencode/lib/ui-meta.ts) next to the
//      unchanged text output the model reads: { v: 1, res?: Res, doc?: Doc, article?: {n, title, lang}, card?: … }
//   2. the tool's text output (sessions recorded before the tools emitted metadata) – parsed below.
//
// step = { args: Arg[], res?: Res }
//   Arg: {t:"q", v, lang?}            query / quote written by the model or the user (data)
//        {t:"doc", v, lang?}          document name (data)
//        {t:"art", n}                 article number → "Article 300" / "Điều 300"
//        {t:"code", v}                identifier (HS code, CELEX, FR Doc number, id, formula) – neutral
//        {t:"url", v}                 link (host + path)
//        {t:"file", v}                file name
//        {t:"skill", v}               skill id → localized skill name
//        {t:"count", n, unit}         e.g. todowrite: 3 tasks
//        {t:"version", n}             document version
//   Res: {t:"count", n, unit, official?}   unit ∈ COUNT_UNITS
//        {t:"none"}                        no results
//        {t:"status", code}                legal status (STATUS_CODES)
//        {t:"verify", code}                quote check: match | nomatch
//        {t:"level", code}                 confidence: high | medium | low
//        {t:"title", v, lang?}             e.g. the article title (data)
//        {t:"id", v}                       e.g. expert request id
//        {t:"files", v: ["DOCX", "PDF"]}   formats of a created document
//        {t:"changes", n}                  document edits
//        {t:"deadline", date, days?, passed?}   clock_calc (ISO date)
//        {t:"datetime", iso}               clock_now
//        {t:"safety", code, n?}            clean | flagged
//        {t:"error"}                       the tool answered with an error message ("Lỗi: …")
import { scrubText } from "./sanitize.mjs"

export const LANGS = ["vi", "en"]
const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i
// Unaccented Vietnamese (vbpl.vn slugs, queries typed without diacritics).
const VI_WORDS = /(?:^|[^a-z])(luat|nghi dinh|thong tu|quyet dinh|nghi quyet|hop dong|dieu|khoan|thue|phat|vi pham|cua|va|so|ngay|nam|thuong mai|dan su|bo luat|chong ban pha gia|hang hoa|thep|tom|ca phe|quoc hoi|chinh phu|sua doi|bo sung)(?:$|[^a-z])/i
/** Language of a data string: vi | en | undefined (codes, numbers). `fallback` = the source's language. */
const EN_WORDS = /(?:^|[^a-z])(the|of|and|for|in|on|to|with|from|or|other|not|by|is|are|duty|duties|trade|centre|center|products?|goods|steel|shrimps?|frozen|review|order|notice|final|results?|articles?|thickness|containing|weight|width)(?:$|[^a-z])/i
export function langOf(s, fallback) {
  s = String(s ?? "")
  if (VI_CHARS.test(s)) return "vi"
  // acronyms, currencies, units and ids say nothing about the language
  const words = s.replace(/\b[A-Z]{2,}\d*\b/g, " ").replace(/\b(?:kg|mm|cm|km|m2|m3|ha)\b/gi, " ").replace(/[_-]+/g, " ")
  if (!/(?:^|[^a-z])[a-z]{3,}/i.test(words)) return undefined
  if (VI_WORDS.test(words)) return "vi"
  if (EN_WORDS.test(words)) return "en"
  return fallback === "vi" ? "vi" : "en"
}

export const LEGAL_STATUS_CODES = ["in_force", "partly_expired", "expired", "not_yet", "partly_suspended", "suspended", "obsolete", "applicable", "not_applicable"]
// company_lookup / company_verify (../.opencode/tools/company.ts): gate / MST check outcome, operating status of the
// enterprise (co_<status>, company-core.ts STATUS) and the overall result of a field-by-field comparison.
export const COMPANY_STATUSES = ["active", "temporarily_suspended", "not_at_address", "dissolving", "dissolved", "bankrupt", "revoked", "ceased_pending_closure", "tax_code_closed", "ceased", "other"]
export const COMPANY_STATUS_CODES = [
  "manual_required", "invalid_code", "personal_id", "parsed", ...COMPANY_STATUSES.map((x) => `co_${x}`), "verify_match", "verify_partial", "verify_mismatch",
  // reference (unofficial) aggregator data found / compared against
  "unofficial", "unofficial_match", "unofficial_partial", "unofficial_mismatch",
]
export const STATUS_CODES = [...LEGAL_STATUS_CODES, ...COMPANY_STATUS_CODES]
const STATUS_RE = [
  [/^còn hiệu lực/i, "in_force"],
  [/^hết hiệu lực một phần/i, "partly_expired"],
  [/^hết hiệu lực/i, "expired"],
  [/^chưa có hiệu lực/i, "not_yet"],
  [/^ngưng hiệu lực một phần/i, "partly_suspended"],
  [/^ngưng hiệu lực/i, "suspended"],
  [/^không còn phù hợp/i, "obsolete"],
  // án lệ (precedents)
  [/^còn áp dụng|^đang có hiệu lực/i, "applicable"],
  [/^(?:hết|không còn|ngừng|dừng) áp dụng|^(?:bị |đã bị )?(?:bãi bỏ|hủy bỏ|huỷ bỏ)|^hết hiệu lực/i, "not_applicable"],
  // English (tools that already speak codes may send these)
  [/^in force/i, "in_force"],
]
/** vbpl.vn / anle status phrase ("Hết hiệu lực một phần") → code, or "" when unknown. */
export function statusCode(s) {
  const x = String(s ?? "").trim()
  if (!x) return ""
  if (STATUS_CODES.includes(x)) return x
  return STATUS_RE.find(([re]) => re.test(x))?.[1] || ""
}

/** "26/11/2024" / "2024-11-26" → "2024-11-26" (else ""). */
export function isoDate(s) {
  const x = String(s ?? "").trim()
  let m = x.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = x.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
  return ""
}

export const COUNT_UNITS = [
  "results", "docs", "articles", "precedents", "judgments", "measures", "news", "notifications", "codes", "tariffLines", "ftas", "changes", "tasks", "entries", "items", "pages",
]
const RES_TYPES = new Set(["count", "none", "status", "verify", "level", "title", "id", "files", "changes", "deadline", "datetime", "safety", "error"])
const ARG_TYPES = new Set(["q", "doc", "art", "code", "url", "file", "skill", "count", "version"])
const LEVELS = { cao: "high", "trung bình": "medium", thấp: "low", high: "high", medium: "medium", low: "low" }

const cap = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim()
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
const nat = (v, max = 1e9) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null
}
const langOk = (l) => (LANGS.includes(l) ? l : undefined)
const iso = (s) => (/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(String(s ?? "")) ? String(s) : "")

// ---- cleaning (whitelist + caps + scrub) -------------------------------------------------------------------
function cleanArg(a, sc) {
  if (!a || typeof a !== "object" || !ARG_TYPES.has(a.t)) return null
  switch (a.t) {
    case "art": {
      const n = cap(a.n, 12)
      return n ? { t: "art", n } : null
    }
    case "count": {
      const n = nat(a.n)
      return n == null || !COUNT_UNITS.includes(a.unit) ? null : { t: "count", n, unit: a.unit }
    }
    case "version": {
      const n = nat(a.n, 10000)
      return n ? { t: "version", n } : null
    }
    default: {
      const v = sc(cap(a.v, a.t === "url" ? 90 : a.t === "q" ? 80 : 110))
      if (!v) return null
      const out = { t: a.t, v }
      if (a.t === "q" || a.t === "doc") {
        const l = langOk(a.lang) || langOf(v)
        if (l) out.lang = l
      }
      return out
    }
  }
}
export function cleanRes(r, sc = (x) => x) {
  if (!r || typeof r !== "object" || !RES_TYPES.has(r.t)) return null
  switch (r.t) {
    case "count": {
      const n = nat(r.n)
      if (n == null || !COUNT_UNITS.includes(r.unit)) return null
      return n === 0 ? { t: "none" } : { t: "count", n, unit: r.unit, ...(nat(r.official) != null ? { official: nat(r.official) } : {}) }
    }
    case "status": {
      const code = statusCode(r.code)
      return code ? { t: "status", code } : null
    }
    case "verify":
      return ["match", "nomatch"].includes(r.code) ? { t: "verify", code: r.code } : null
    case "level": {
      const code = LEVELS[String(r.code ?? "").toLowerCase()]
      return code ? { t: "level", code } : null
    }
    case "title": {
      const v = sc(cap(r.v, 90))
      if (!v) return null
      const l = langOk(r.lang) || langOf(v)
      return l ? { t: "title", v, lang: l } : { t: "title", v }
    }
    case "id": {
      const v = cap(r.v, 40)
      return /^[\w./-]+$/.test(v) ? { t: "id", v } : null
    }
    case "files": {
      const v = (Array.isArray(r.v) ? r.v : []).filter((x) => /^[A-Z0-9]{2,6}$/.test(String(x))).slice(0, 6)
      return { t: "files", v }
    }
    case "changes": {
      const n = nat(r.n)
      return n == null ? null : { t: "changes", n }
    }
    case "deadline": {
      const date = iso(r.date)
      if (!date) return null
      const days = Number.isInteger(r.days) && Math.abs(r.days) < 100000 ? r.days : undefined
      return { t: "deadline", date, ...(days != null ? { days } : {}), ...(r.passed === true ? { passed: true } : {}) }
    }
    case "datetime": {
      const v = iso(r.iso)
      return v ? { t: "datetime", iso: v } : null
    }
    case "safety":
      return ["clean", "flagged"].includes(r.code) ? { t: "safety", code: r.code, ...(nat(r.n) ? { n: nat(r.n) } : {}) } : null
    default:
      return { t: r.t }
  }
}

// ---- args (from the tool input) ------------------------------------------------------------------------------
const UNIT_ART = /^\s*(?:điều|article|art\.?|đ\.)\s*/iu
const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")
const q = (v, lang) => (str(v).trim() ? { t: "q", v: str(v), lang: langOf(v, lang) } : null)
const code = (v) => (str(v).trim() ? { t: "code", v: str(v) } : null)
const urlArg = (u) => (str(u).trim() ? { t: "url", v: str(u).replace(/^https?:\/\//, "") } : null)
const TOOL_LANG = (tool) =>
  /^(vbpl|chinhphu|court|trav|fta|company)_/.test(tool) || tool === "tariff_vn" ? "vi" : /^(fedreg|eurlex|eping)_/.test(tool) || tool === "tariff_us" || tool === "tariff_eu" || tool === "tariff_eu_requirements" ? "en" : undefined

function argsOf(tool, input = {}, st, output) {
  const url = str(input.url)
  const doc = () => (url && st ? { t: "doc", v: st.docName(url), lang: "vi" } : null)
  switch (tool) {
    case "vbpl_find":
    case "chinhphu_search":
      return [q(input.query, "vi")]
    case "vbpl_document":
    case "vbpl_history":
    case "chinhphu_document":
      return [doc()]
    case "vbpl_article":
    case "chinhphu_article":
      return [input.article != null && str(input.article).trim() ? { t: "art", n: str(input.article).replace(UNIT_ART, "").trim() } : null, doc()]
    case "vbpl_search_articles":
    case "chinhphu_search_articles":
      return [q(input.keywords, "vi"), doc()]
    case "vbpl_verify":
    case "chinhphu_verify":
      return [q(input.quote, "vi")]
    case "court_anle_search":
      return [q(input.query, "vi")]
    case "court_anle_document":
      return [code(input.ref || input.no || input.id) || urlArg(url)]
    case "court_judgment_search":
      return [q(input.keyword || input.query || input.relation, "vi")]
    case "court_judgment_document":
    case "trav_page":
    case "fta_document":
    case "web_read":
      return [urlArg(url)]
    case "trav_search":
      return [q(input.query, "vi")]
    case "trav_measures":
      return [q(input.product, "vi"), code(input.hs)]
    case "fedreg_search":
    case "eurlex_search":
    case "eping_search":
      return [q(input.query || input.keyword, "en")]
    case "fedreg_document":
    case "eurlex_document":
    case "eping_notification":
      return [code(input.id || input.document_number || input.celex || input.symbol) || urlArg(url)]
    case "fta_search":
      return [code(input.fta), q(input.query, "vi")]
    case "tariff_vn":
    case "tariff_us":
    case "tariff_eu":
    case "tariff_eu_requirements":
      return [code(input.hs)]
    case "tariff_search":
      return [q(input.query), code(input.market ? String(input.market).toUpperCase() : "")]
    case "web_search":
      return [q(input.query)]
    case "calc_eval":
      return [code(input.expression)]
    case "calc_interest":
      return [code(input.principal)]
    case "calc_money_words":
      return [code(input.amount)]
    case "calc_check_words":
      return [code(input.number_text)]
    case "calc_contract_check":
      // `text` is the whole contract markdown – never show it as the step argument.
      return [typeof input.id === "string" ? code(input.id) : null]
    case "fx_rate":
      return [code(input.currency)]
    // official_text (a paste from the official page) and the contract party's details are never shown as arguments
    case "company_lookup":
      return [code(input.tax_code) || q(input.name, "vi")]
    case "company_verify":
      return [code(input.tax_code)]
    case "fx_convert":
      return [code([str(input.amount), [str(input.from), str(input.to)].filter(Boolean).join("→")].filter(Boolean).join(" "))]
    case "draft_plan":
    case "draft_write":
    case "draft_check":
    case "draft_fix":
    case "draft_assemble":
    case "draft_status":
      return [code(input.draftId)]
    case "invalid":
    case "grounding_check":
    case "clock_now":
    case "clock_calc":
    case "about_self":
    case "safety_scan":
      return []
    case "expert_escalate":
      return [q(input.reason)]
    case "diagram_create":
      return [q(input.title)]
    case "image_search":
      return [q(input.query)]
    case "image_fetch":
      return [urlArg(input.url)]
    case "source_snapshot":
      return [/^https?:/i.test(str(input.url_or_doc)) ? urlArg(input.url_or_doc) : code(input.url_or_doc)]
    case "skill":
      return [str(input.name) ? { t: "skill", v: str(input.name) } : null]
    case "read":
    case "write":
    case "edit":
      return [input.filePath ? { t: "file", v: String(input.filePath).split(/[\\/]/).pop() } : null]
    case "todowrite":
      return Array.isArray(input.todos) ? [{ t: "count", n: input.todos.length, unit: "tasks" }] : []
    default: {
      if (url) return [urlArg(url)]
      const first = Object.values(input).find((v) => typeof v === "string" && v.trim())
      return first ? [tool.startsWith("chrome_") ? code(first) : q(first)] : []
    }
  }
}

// ---- legacy results (text outputs recorded before metadata.ui) ----------------------------------------------
const numbered = (out) => (out.match(/^\s*\d+\.\s/gm) || []).length
const noHits = (out) => /^(?:Không có|Không tìm thấy|Chưa có|Không thấy)\s/i.test(out.trim())
const countOr = (out, unit, n = numbered(out)) => (n ? { t: "count", n, unit } : noHits(out) ? { t: "none" } : null)
const lineVal = (out, label) => out.match(new RegExp(`^${label}:\\s*([^\\n]+)`, "m"))?.[1]?.trim() || ""

function legacyRes(tool, out) {
  if (/^Lỗi:/.test(out.trim())) return { t: "error" }
  switch (tool) {
    case "vbpl_find":
    case "eurlex_search":
    case "eping_search":
    case "fta_search":
    case "web_search": {
      const unit = tool === "vbpl_find" || tool === "eurlex_search" ? "docs" : tool === "eping_search" ? "notifications" : "results"
      const r = countOr(out, unit)
      if (r?.t === "count" && tool === "web_search") r.official = (out.match(/^\s*\d+\.\s\[CHÍNH THỨC/gm) || []).length
      return r
    }
    case "vbpl_document": {
      const code = statusCode(lineVal(out, "Tình trạng hiệu lực"))
      return code ? { t: "status", code } : null
    }
    case "vbpl_article": {
      const m = out.match(/--- NGUYÊN VĂN ---\s*\n+([^\n]+)/)
      if (!m) return null
      const title = m[1].replace(/^\s*Điều\s+\S+?\.\s*/u, "").trim()
      return title ? { t: "title", v: title, lang: "vi" } : null
    }
    case "vbpl_search_articles": {
      const n = (out.match(/^- Điều/gm) || []).length
      return n ? { t: "count", n, unit: "articles" } : { t: "none" }
    }
    case "vbpl_history": {
      const sec = out.split(/^LỊCH SỬ HIỆU LỰC:\s*$/m)[1]?.split(/^[A-ZĐ ]{6,}.*:\s*$/m)[0] || ""
      const n = (sec.match(/^- (?!\()/gm) || []).length
      return n ? { t: "count", n, unit: "entries" } : { t: "none" }
    }
    case "chinhphu_search":
      return countOr(out, "docs")
    case "chinhphu_search_articles": {
      const n = (out.match(/^- Điều/gm) || []).length
      return n ? { t: "count", n, unit: "articles" } : { t: "none" }
    }
    case "vbpl_verify":
    case "chinhphu_verify":
      return /^KHỚP\b/.test(out) ? { t: "verify", code: "match" } : /^KHÔNG KHỚP/.test(out) ? { t: "verify", code: "nomatch" } : null
    case "court_anle_search":
      return countOr(out, "precedents")
    case "court_anle_document": {
      const code = statusCode(out.match(/^Trạng thái:\s*([^(·\n]+)/m)?.[1])
      return code ? { t: "status", code } : null
    }
    case "court_judgment_search": {
      const total = Number(out.match(/:\s*(\d+) kết quả/)?.[1] || 0)
      return countOr(out, "judgments", total || numbered(out))
    }
    case "trav_search":
      return countOr(out, "news")
    case "trav_measures": {
      const total = Number(out.match(/→\s*(\d+) biện pháp/)?.[1] || 0)
      return countOr(out, "measures", total || numbered(out))
    }
    case "fedreg_search": {
      const total = Number(out.match(/:\s*(\d+) văn bản khớp/)?.[1] || 0)
      return countOr(out, "docs", total || numbered(out))
    }
    case "fta_list":
      return countOr(out, "ftas")
    case "tariff_vn":
    case "tariff_eu": {
      const n = (out.match(/^■ /gm) || []).length
      return n ? { t: "count", n, unit: "tariffLines" } : noHits(out) ? { t: "none" } : null
    }
    case "tariff_us": {
      const n = (out.match(/^\s*\d{4}\.\d{2}\.\d{2}(?:\.\d{2})? \|/gm) || []).length
      return n ? { t: "count", n, unit: "tariffLines" } : noHits(out) ? { t: "none" } : null
    }
    case "tariff_search":
      return countOr(out, "codes")
    case "grounding_check": {
      const m = out.match(/ĐỘ TIN CẬY[^:]*:\s*([^\n]+)/)
      return m ? cleanRes({ t: "level", code: m[1].trim().toLowerCase() }) : null
    }
    case "expert_escalate": {
      const m = out.match(/YC-\d{8}-\d{3}-[0-9a-f]{4}/)
      return m ? { t: "id", v: m[0] } : null
    }
    case "clock_now": {
      const m = out.match(/ISO 8601:\s*(\S+)/)
      return m ? { t: "datetime", iso: m[1] } : null
    }
    case "clock_calc": {
      const m = out.match(/HẠN CUỐI:[^\d]*(\d{2}\/\d{2}\/\d{4})/)
      if (!m) return null
      const rest = out.match(/CÒN (\d+) ngày/)
      const over = out.match(/(?:ĐÃ QUA|QUÁ HẠN)[^\d]*(\d+) ngày/)
      return { t: "deadline", date: isoDate(m[1]), ...(rest ? { days: +rest[1] } : over ? { days: -over[1], passed: true } : {}) }
    }
    case "company_lookup":
    case "company_verify": {
      if (/^Không (?:tra cứu \/ không hiển thị thông tin|xử lý dữ liệu) cá nhân/m.test(out)) return { t: "status", code: "personal_id" }
      if (/yêu cầu mã xác thực – không tra tự động|Không tra tự động được nguồn chính thức/.test(out)) return { t: "status", code: "manual_required" }
      if (/^\| Mục \| Theo hợp đồng/m.test(out)) return { t: "status", code: /\| KHÔNG KHỚP/.test(out) ? "verify_mismatch" : /\| GẦN KHỚP/.test(out) ? "verify_partial" : "verify_match" }
      if (/^THÔNG TIN DOANH NGHIỆP/m.test(out)) return { t: "status", code: "parsed" }
      return /^Kiểm tra định dạng MST .*KHÔNG HỢP LỆ/m.test(out) ? { t: "status", code: "invalid_code" } : null
    }
    case "safety_scan":
      return /không phát hiện/i.test(out) ? { t: "safety", code: "clean" } : { t: "safety", code: "flagged" }
    default:
      return null
  }
}

/** Error of a failed tool part → { code, detail } (detail is the tool's own message, shown as data). */
export function stepError(err) {
  const s = String(err ?? "").trim()
  if (!s) return null
  const code = /abort/i.test(s) ? "aborted" : /time ?out|hết thời gian/i.test(s) ? "timeout" : /not found|không tìm thấy|không hiển thị/i.test(s) ? "notFound" : "failed"
  return { code, detail: cap(s, 200), lang: langOf(s, "vi") }
}

/**
 * Step summary of a tool part (null for tools rendered elsewhere). `metadata.ui` wins over parsing the text.
 * `locale` only selects the scrub wording (vendor-name filter).
 */
export function stepView(tool, input, output, metadata, st, locale) {
  const sc = (v) => scrubText(v, locale)
  const args = argsOf(tool, input || {}, st, output).map((a) => cleanArg(a, sc)).filter(Boolean)
  const ui = metadata && typeof metadata === "object" && metadata.ui && typeof metadata.ui === "object" ? metadata.ui : null
  let res = null
  if (typeof output === "string" && output) res = cleanRes(ui?.res, sc) || cleanRes(legacyRes(tool, output.slice(0, 200_000)), sc)
  const out = { args }
  if (res) out.res = res
  const ocr = ocrOf(ui)
  if (ocr) out.ocr = ocr
  return out
}

/** metadata.ui {ocr:true, engine, pages:[…]} of a tool resting on OCR text of a scanned PDF → { pages } (whitelisted). */
export function ocrOf(ui) {
  if (!ui || ui.ocr !== true) return null
  const pages = (Array.isArray(ui.pages) ? ui.pages : []).filter((n) => Number.isInteger(n) && n > 0 && n < 100000).slice(0, 200)
  return { pages }
}

export { TOOL_LANG }

// ---- confidence reasons (grounding_check verdicts) ---------------------------------------------------------
const WHY_CODES = ["partial_quotes", "no_sources", "calc_only", "bad_quotes", "unsupported", "unmatched", "source_warnings", "unverifiable_links", "few_items", "all_matched", "from_memory", "ocr_evidence"]
/** Vietnamese reason sentences of older verdicts → the codes newer verdicts carry in `why`. */
export function whyOf(reasons) {
  const out = []
  for (const r of Array.isArray(reasons) ? reasons : []) {
    const s = String(r ?? "")
    let m
    if (/^không có nguồn nào được tra/.test(s)) out.push({ code: "no_sources" })
    else if (/^chỉ có kết quả tính bằng công cụ/.test(s)) out.push({ code: "calc_only" })
    else if ((m = s.match(/^(\d+) đoạn trích không có nguyên văn/))) out.push({ code: "bad_quotes", n: +m[1] })
    else if ((m = s.match(/^(\d+)\/(\d+) mục chưa có căn cứ/))) out.push({ code: "unsupported", n: +m[1], total: +m[2] })
    else if (/^một số link \/ con số/.test(s)) out.push({ code: "unmatched" })
    else if (/^công cụ tra cứu có cảnh báo/.test(s)) out.push({ code: "source_warnings" })
    else if (/^có link ngoài các nguồn kiểm chứng/.test(s)) out.push({ code: "unverifiable_links" })
    else if (/^câu trả lời dựa trên quá ít căn cứ/.test(s)) out.push({ code: "few_items" })
    else if ((m = s.match(/^(\d+)\/(\d+) căn cứ đều khớp(?:.*công cụ tính \((\d+)\))?/))) out.push({ code: "all_matched", n: +m[1], total: +m[2], ...(m[3] ? { computed: +m[3] } : {}) })
    else if (/trả lời theo trí nhớ/.test(s)) out.push({ code: "from_memory" })
    else if ((m = s.match(/^(\d+) căn cứ chỉ có trong văn bản nhận dạng OCR/))) out.push({ code: "ocr_evidence", n: +m[1] })
  }
  return out
}
/** Whitelisted `why` list of a verdict (codes + small integers). */
export function cleanWhy(why, reasons) {
  const list = Array.isArray(why) && why.length ? why : whyOf(reasons)
  return list
    .filter((w) => w && WHY_CODES.includes(w.code))
    .slice(0, 10)
    .map((w) => {
      const o = { code: w.code }
      for (const k of ["n", "total", "computed"]) if (Number.isInteger(w[k]) && w[k] >= 0 && w[k] < 1e6) o[k] = w[k]
      return o
    })
}
