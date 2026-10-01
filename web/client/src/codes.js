// Stable data values exchanged with the server / stored in the database. They are Vietnamese by
// design (the agent and the escalation files use them) and are never shown as-is: every label comes
// from the locale files through the *_KEY maps below.
/* i18n-ignore-file */

/** Expert escalation workflow, in order. */
export const ESC_STATUSES = ["mới", "đang xử lý", "đã trả lời", "đóng"]
export const ESC_STATUS_KEY = { mới: "new", "đang xử lý": "inProgress", "đã trả lời": "answered", đóng: "closed" }
export const ESC_NEW = "mới"
export const ESC_IN_PROGRESS = "đang xử lý"
export const ESC_CLOSED = "đóng"

export const URGENCIES = ["thấp", "trung bình", "cao", "khẩn"]
export const URGENCY_KEY = { thấp: "low", "trung bình": "medium", cao: "high", khẩn: "urgent" }
export const URGENCY_MEDIUM = "trung bình"
export const URGENCY_HIGH = "cao"

/** grounding_check confidence levels. */
export const LEVEL_KEY = { cao: "high", "trung bình": "medium", thấp: "low" }
export const LEVEL_LOW = "thấp"
export const LEVEL_HIGH = "cao"

/** Token the delete-all endpoint expects (the typed confirmation phrase itself is localized). */
export const DELETE_ALL_TOKEN = "XOÁ TẤT CẢ"

/** Server-side step texts (tool label / result) → locale key + count, so they read naturally in English. */
export const STEP_TEXT_PATTERNS = [
  [/^(\d+) kết quả$/, "tools.text.results"],
  [/^(\d+) điều liên quan$/, "tools.text.relatedArticles"],
  [/^(\d+) việc$/, "tools.text.todos"],
  [/^(\d+) thay đổi$/, "tools.text.changes"],
  [/^không có tệp$/, "tools.text.noFiles"],
  // grounding_check result (confidence level, lower-cased by the server)
  [/^cao$/i, "confidence.level.high"],
  [/^trung bình$/i, "confidence.level.medium"],
  [/^thấp$/i, "confidence.level.low"],
]
export const STEP_ARTICLE = /^Điều (\S+)( · .*)?$/

/** Legal-status values of vbpl.vn (source cards) → locale key. Prefix match, case-insensitive. */
export const LEGAL_STATUS = [
  [/^còn hiệu lực/i, "sources.status.inForce"],
  [/^hết hiệu lực một phần/i, "sources.status.partlyExpired"],
  [/^hết hiệu lực toàn bộ/i, "sources.status.expired"],
  [/^hết hiệu lực/i, "sources.status.expired"],
  [/^chưa có hiệu lực/i, "sources.status.notYet"],
  [/^ngưng hiệu lực một phần/i, "sources.status.partlySuspended"],
  [/^ngưng hiệu lực/i, "sources.status.suspended"],
  [/^không còn phù hợp/i, "sources.status.obsolete"],
]
export const STATUS_OK = /^còn/i
export const STATUS_BAD = /hết hiệu lực toàn bộ|ngưng/i

/** Language-neutral legal status codes (server/stepview.mjs STATUS_CODES) → locale key + tone. */
export const STATUS_CODE_KEY = {
  in_force: ["inForce", "ok"],
  partly_expired: ["partlyExpired", ""],
  expired: ["expired", "bad"],
  not_yet: ["notYet", ""],
  partly_suspended: ["partlySuspended", "bad"],
  suspended: ["suspended", "bad"],
  obsolete: ["obsolete", "bad"],
  applicable: ["applicable", "ok"],
  not_applicable: ["notApplicable", "bad"],
}
/**
 * Company operating status (company_lookup / company_verify, server/stepview.mjs COMPANY_STATUSES) → tone:
 * ok = active, warn = suspended / not at address / winding down, bad = legal existence ended or revoked.
 */
export const COMPANY_STATUS_TONE = {
  active: "ok",
  temporarily_suspended: "warn",
  not_at_address: "warn",
  ceased_pending_closure: "warn",
  ceased: "warn",
  dissolving: "warn",
  dissolved: "bad",
  bankrupt: "bad",
  revoked: "bad",
  tax_code_closed: "bad",
  other: "",
}
/** Step status codes of the company tools → [locale key, tone]. */
export function companyStepStatus(code) {
  const c = String(code ?? "")
  if (c.startsWith("co_") && c.slice(3) in COMPANY_STATUS_TONE) return [`cards.company.status.${c.slice(3)}`, COMPANY_STATUS_TONE[c.slice(3)]]
  if (/^verify_(match|partial|mismatch)$/.test(c)) return [`cards.company.summary.${c.slice(7)}`, { match: "ok", partial: "warn", mismatch: "bad" }[c.slice(7)]]
  if (/^unofficial_(match|partial|mismatch)$/.test(c)) return [`cards.company.summaryUnofficial.${c.slice(11)}`, c === "unofficial_mismatch" ? "bad" : "warn"]
  if (["manual_required", "invalid_code", "personal_id", "parsed", "unofficial"].includes(c)) return [`tools.status.${c}`, c === "invalid_code" ? "bad" : c === "manual_required" || c === "unofficial" ? "warn" : ""]
  return null
}
/** Legacy status phrase (old records without statusCode) → code. */
export function statusCodeOf(s) {
  const x = String(s ?? "").trim()
  if (STATUS_CODE_KEY[x]) return x
  const table = [
    [/^còn hiệu lực/i, "in_force"], [/^hết hiệu lực một phần/i, "partly_expired"], [/^hết hiệu lực/i, "expired"], [/^chưa có hiệu lực/i, "not_yet"],
    [/^ngưng hiệu lực một phần/i, "partly_suspended"], [/^ngưng hiệu lực/i, "suspended"], [/^không còn phù hợp/i, "obsolete"],
    [/^còn áp dụng|^đang có hiệu lực/i, "applicable"], [/^(?:hết|không còn|ngừng) áp dụng|bãi bỏ|hủy bỏ/i, "not_applicable"],
  ]
  return table.find(([re]) => re.test(x))?.[1] || ""
}

/**
 * Step label / result strings of records made before structured steps (old share snapshots) → the structured
 * shapes of server/stepview.mjs, so they render in the UI language too.
 */
export function legacyStep(label, result) {
  const args = []
  const l = String(label ?? "").trim()
  if (l) {
    const art = l.match(/^Điều (\S+)(?: · (.*))?$/)
    const kw = l.match(/^“(.+?)”(?: · (.*))?$/)
    const cnt = l.match(/^(\d+) việc$/)
    if (art) args.push({ t: "art", n: art[1] }, ...(art[2] ? [{ t: "doc", v: art[2] }] : []))
    else if (kw) args.push({ t: "q", v: kw[1] }, ...(kw[2] ? [{ t: "doc", v: kw[2] }] : []))
    else if (cnt) args.push({ t: "count", n: +cnt[1], unit: "tasks" })
    else args.push({ t: "q", v: l })
  }
  let res = null
  const r = String(result ?? "").trim()
  let m
  if (!r) res = null
  else if ((m = r.match(/^(\d+) kết quả$/))) res = { t: "count", n: +m[1], unit: "results" }
  else if ((m = r.match(/^(\d+) điều liên quan$/))) res = { t: "count", n: +m[1], unit: "articles" }
  else if ((m = r.match(/^(\d+) thay đổi$/))) res = { t: "changes", n: +m[1] }
  else if (/^không có tệp$/.test(r)) res = { t: "files", v: [] }
  else if (/^(cao|trung bình|thấp)$/i.test(r)) res = { t: "level", code: LEVEL_KEY[r.toLowerCase()] }
  else if (/^KHỚP/.test(r)) res = { t: "verify", code: "match" }
  else if (/^KHÔNG KHỚP/.test(r)) res = { t: "verify", code: "nomatch" }
  else if (/^YC-\d{8}-\d{3}-[0-9a-f]{4}$/.test(r)) res = { t: "id", v: r }
  else if (/^[A-Z0-9]{2,6}(?:, [A-Z0-9]{2,6})*$/.test(r)) res = { t: "files", v: r.split(", ") }
  else if (statusCodeOf(r)) res = { t: "status", code: statusCodeOf(r) }
  else res = { t: "title", v: r.replace(/^Điều\s+\S+?\.\s*/, "") }
  return { args, ...(res ? { res } : {}) }
}

/** Legacy change summary line ("Sửa Điều 10 khoản 2, 3 (2 chỗ)") when the server did not send structured changes. */
export const LEGACY_CHANGE_OP = { sửa: "edit", thêm: "add", xóa: "delete", xoá: "delete", "viết lại": "rewrite" }
/** Answer makes legal claims (article / statute references) → it gets a confidence badge even without a grounding_check. */
export const LEGAL_CLAIM_RE = /(?:^|[^\p{L}])(?:Điều|Khoản|Article|Section|Clause)\s+\d+|Bộ luật|Luật\s+\p{Lu}|Nghị định|Thông tư|Nghị quyết|Pháp lệnh|\bDecree\b|\bCircular\b/u

/** Heading words that mark a long answer as a report (content detection, both languages). */
export const REPORTISH = /rà soát|báo cáo|bảng nghĩa vụ|đánh giá rủi ro|biện pháp|mức thuế|biên độ|review|report|obligations|risk assessment|measures?|duty rates?|margins?/i

/** Documents: artifact kind values. */
export const KIND_KEY = { "hop-dong": "contract", "bao-cao": "report", "van-ban": "document" }

/** Document language badge (artifact `language`; missing = vi). */
export const LANG_BADGE = { vi: "VI", en: "EN", bilingual: "VI–EN" }
