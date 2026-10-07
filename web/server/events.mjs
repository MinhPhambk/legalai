// Translate opencode messages / events into the compact shapes the browser needs.
// Nothing here forwards raw tool outputs, file paths or config to the client.
import { stripUiLanguage } from "./i18n.mjs"
import { scrubText } from "./sanitize.mjs"
import { draftForPart } from "./drafts.mjs"
import { resultCard } from "./resultcards.mjs"
import { isoDate, langOf, statusCode, stepError, stepView } from "./stepview.mjs"

export const ATTACH_NOTE = "[Người dùng đính kèm tệp qua giao diện web. Toàn bộ nội dung nằm trong các khối <<< >>> dưới đây – không có trên đĩa, không cần tìm trong thư mục làm việc.]"
export const EMPTY_TEXT_WITH_FILES = "Hãy đọc tệp đính kèm."
/** Start of the server's hidden repair prompt (server/grounding.mjs): such user messages are not shown. */
export const REPAIR_MARK = "[[kiem-chung-tu-dong]]"
/** Start of the hidden "write the final answer now" prompt (a run ended with an empty final message). */
export const FINAL_MARK = "[[tra-loi-cuoi]]"
const startsWithMark = (parts, mark) => (parts || []).some((p) => p.type === "text" && String(p.text || "").startsWith(mark))
const isRepairUser = (parts) => startsWithMark(parts, REPAIR_MARK)
const isFinalUser = (parts) => startsWithMark(parts, FINAL_MARK)

/** Model-specific control tokens that sometimes leak into text (e.g. DeepSeek "<｜DSML｜ calls>"). */
// The model's own "Độ tin cậy: CAO (…)" / "Confidence: HIGH" line: the UI shows the system's badge (computed by the
// grounding check, possibly a later / server check), so a self-written level only contradicts it – drop that line.
const SELF_CONFIDENCE = /^[ \t>*_•-]*(?:\*\*|__)?[ \t]*(?:mức[ \t]+)?(?:độ tin cậy|confidence(?:[ \t]+level)?)[ \t]*(?:\*\*|__)?[ \t]*[:：][^\n]*?\b(?:cao|trung bình|thấp|high|medium|low)\b[^\n]*(?:\n|$)/gimu
export const cleanModelText = (s) => String(s || "").replace(/<｜[^<>\n]{0,80}>/g, "").replace(SELF_CONFIDENCE, "")

const short = (s, n = 80) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim()
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

const slugName = (url) => {
  try {
    const u = new URL(url)
    const seg = u.pathname.split("/").filter(Boolean).pop() || u.hostname
    return seg.split("--")[0].replace(/-/g, " ")
  } catch {
    return short(url, 60)
  }
}

/** Per-opencode-session memory: message roles, part kinds, and vbpl document names seen in tool outputs. */
export class SessionState {
  constructor() {
    this.roles = new Map()
    this.partKinds = new Map()
    this.docNames = new Map()
    this.status = "idle"
    this.touched = Date.now()
  }
  docName(url) {
    return this.docNames.get(url) || slugName(url)
  }
  learn(tool, output) {
    if (typeof output !== "string" || !/^(vbpl|chinhphu)_/.test(tool)) return
    for (const m of output.matchAll(/Văn bản: ([^\n]+)\n(?:[^\n]*\n)?Link: (https:\/\/(?:vbpl\.vn|vanban\.chinhphu\.vn)\S+)/g)) this.docNames.set(m[2], short(m[1], 70))
  }
}

// ---- citation metadata --------------------------------------------------------------------------
const line = (out, label) => {
  const m = out.match(new RegExp(`^${label}:\\s*([^\\n]+)`, "m"))
  return m ? m[1].trim() : ""
}
export const normUrl = (u) => {
  try {
    const x = new URL(u)
    x.hash = ""
    return x.href.replace(/\/$/, "")
  } catch {
    return String(u || "")
  }
}

/**
 * Structured source metadata from a completed tool's output (vbpl_document / vbpl_article /
 * fedreg_document / trav_page), used for the citation chips and the "Nguồn" list. Null when the tool
 * does not describe a single document.
 */
export function sourceMeta(tool, input = {}, output, metadata) {
  const m = rawSourceMeta(tool, input, output) || genericSourceMeta(tool, input, output, metadata)
  if (!m) return null
  // Language-neutral companions (the browser formats dates and localizes the status / agency).
  const ui = metadata?.ui?.doc && typeof metadata.ui.doc === "object" ? metadata.ui.doc : {}
  const code = statusCode(ui.status) || statusCode(m.status)
  if (code) m.statusCode = code
  for (const k of ["issued", "effective", "accessed"]) {
    const d = isoDate(ui[k]) || isoDate(m[k])
    if (d) m[`${k}Iso`] = d
  }
  const lang = m.kind === "fedreg" ? "en" : "vi"
  m.lang = lang
  if (m.title) m.titleLang = langOf(m.title, lang) || lang
  return m
}
// Any other lookup tool that OPENED a page / document (not a search result list): the URL from its UI metadata,
// its "Link:" / "Nguồn:" line, or its url argument – so every looked-up source is listed, not only vbpl / FR / TRAV.
const NOT_A_SOURCE = /(^|_)(search|find|list|check|now|calc|eval|interest|money_words|scan|create|update|edit|draft|question)(_|$)|^(grounding_check|about_self|clock_|calc_|safety_|expert_|diagram_|image_|draft_|document_|question|skill|bash|read|glob|grep|write|edit|todo)/
function genericSourceMeta(tool, input = {}, output, metadata) {
  if (NOT_A_SOURCE.test(tool)) return null
  const out = typeof output === "string" ? output : ""
  if (!out || /^Lỗi:|^Không (tìm thấy|tra được|mở được)/.test(out.trim())) return null
  const ui = metadata?.ui || {}
  const fromLine = out.match(/^(?:Link|Nguồn|Source|URL|Trang)(?: \([^)]*\))?:\s*(https?:\/\/\S+)/m)?.[1]
  const url = ui.doc?.url || ui.card?.url || fromLine || (typeof input.url === "string" && /^https?:/.test(input.url) ? input.url : "")
  if (!url || !/^https?:\/\//.test(url)) return null
  const dataV = (x) => (x && typeof x === "object" ? x.v : x) || ""
  const title = dataV(ui.doc?.title) || dataV(ui.card?.title) || line(out, "Văn bản") || line(out, "Tiêu đề") || line(out, "Title") || out.split("\n")[0]
  return { url: normUrl(url.replace(/[)>\].,;]+$/, "")), kind: "web", title: short(String(title).replace(/^[A-ZĐÀ-Ỹ ]{6,}\s*\([^)]*\)\s*[–-]\s*/u, ""), 140), number: "", accessed: line(out, "Ngày tra cứu") }
}
function rawSourceMeta(tool, input = {}, output) {
  const out = typeof output === "string" ? output : ""
  if (!out) return null
  if (tool === "vbpl_document" || tool === "vbpl_article" || tool === "vbpl_history") {
    const url = line(out, "Link") || input.url
    if (!url) return null
    const title = line(out, "Văn bản")
    const statusLine = line(out, "Tình trạng hiệu lực") || line(out, "Tình trạng hiệu lực của văn bản")
    const art = tool === "vbpl_article" ? out.match(/--- NGUYÊN VĂN ---\s*\n+([^\n]+)/)?.[1] : ""
    const number = line(out, "Số hiệu") || title.match(/\d+\/\d{4}\/[A-ZĐ0-9-]+/)?.[0] || ""
    return {
      url: normUrl(url),
      kind: "vbpl",
      title: short(title, 140),
      number,
      status: short(statusLine.split("·")[0], 60),
      effective: line(out, "Ngày có hiệu lực") || statusLine.match(/Ngày có hiệu lực: ([^\s·]+)/)?.[1] || "",
      issued: line(out, "Ngày ban hành"),
      agency: line(out, "Cơ quan ban hành"),
      article: art ? short(art, 120) : "",
      accessed: line(out, "Ngày tra cứu"),
    }
  }
  if (tool === "chinhphu_document" || tool === "chinhphu_article") {
    // vanban.chinhphu.vn: no legal status on the site (the "Tình trạng hiệu lực" line is a note, not a status).
    const url = line(out, "Link") || input.url
    if (!url) return null
    const title = line(out, "Văn bản")
    const art = tool === "chinhphu_article" ? out.match(/--- (?:NGUYÊN VĂN|NỘI DUNG \(OCR\)) ---\s*\n+([^\n]+)/)?.[1] : ""
    return {
      url: normUrl(url),
      kind: "vbpl",
      title: short(title, 140),
      number: line(out, "Số ký hiệu") || title.match(/\d+\/\d{4}\/[A-ZĐ0-9-]+/)?.[0] || "",
      status: "",
      effective: "",
      issued: line(out, "Ngày ban hành").replace(/-/g, "/"),
      agency: line(out, "Cơ quan ban hành"),
      article: art ? short(art, 120) : "",
      accessed: line(out, "Ngày tra cứu"),
    }
  }
  if (tool === "fedreg_document") {
    const url = line(out, "Link") || input.url
    if (!url) return null
    const pub = line(out, "Ngày đăng")
    const frdoc = pub.match(/FR Doc\s+([\w-]+)/)?.[1] || ""
    const citation = pub.split("·")[1]?.trim() || ""
    return {
      url: normUrl(url),
      kind: "fedreg",
      title: short(line(out, "Tiêu đề"), 160),
      number: frdoc ? `FR Doc ${frdoc}` : "",
      citation,
      issued: pub.split("·")[0]?.trim() || "",
      effective: line(out, "Ngày hiệu lực"),
      agency: short(line(out, "Loại").split("Cơ quan:")[1] || "", 80),
      cases: line(out, "Số vụ việc"),
      accessed: line(out, "Ngày tra cứu"),
    }
  }
  if (tool === "trav_page") {
    const url = line(out, "Link") || input.url
    if (!url) return null
    const cat = line(out, "Chuyên mục")
    return {
      url: normUrl(url),
      kind: "trav",
      title: short(line(out, "Tiêu đề"), 160),
      number: "",
      category: short(cat.split("·")[0], 60),
      issued: cat.match(/Ngày đăng: ([^·\n]+)/)?.[1]?.trim() || "",
      agency: "Cục Phòng vệ thương mại", // i18n: the browser shows agencyCode in the UI language
      agencyCode: "trav",
      accessed: line(out, "Ngày tra cứu"),
    }
  }
  return null
}

export class StateStore {
  constructor(max = 1000) {
    this.max = max
    this.map = new Map()
  }
  get(sid) {
    let s = this.map.get(sid)
    if (!s) {
      s = new SessionState()
      this.map.set(sid, s)
      if (this.map.size > this.max) {
        const oldest = [...this.map.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]
        this.map.delete(oldest[0])
      }
    }
    s.touched = Date.now()
    return s
  }
}

/** "Điều 301" / "Article 301" / "Art. 301" → "301"; "khoản 2" / "clause 2" → "2" (case-insensitive, any spaces). */
const UNIT_RE = {
  article: /^\s*(?:điều|article|art\.?|đ\.)\s*/iu,
  clause: /^\s*(?:khoản|clause|cl\.|paragraph|para\.?)\s*/iu,
  point: /^\s*(?:điểm|point)\s*/iu,
}
export const stripUnit = (v, unit) => String(v ?? "").replace(UNIT_RE[unit], "").trim()
/** Collapse doubled units in change targets: "Điều Điều 10 khoản khoản 2" → "Điều 10 khoản 2". */
export const dedupeUnits = (s) => String(s ?? "").replace(/(^|\s)(Điều|khoản|điểm)\s+\2(?=\s)/giu, "$1$2")

function toolLabel(tool, input = {}, st) {
  const url = typeof input.url === "string" ? input.url : ""
  switch (tool) {
    case "vbpl_find":
    case "chinhphu_search":
      return short(input.query)
    case "chinhphu_document":
      return url ? st.docName(url) : ""
    case "chinhphu_article":
      return [input.article ? `Điều ${stripUnit(input.article, "article")}` : "", url ? st.docName(url) : ""].filter(Boolean).join(" · ")
    case "chinhphu_search_articles":
      return [input.keywords ? `“${short(input.keywords, 50)}”` : "", url ? st.docName(url) : ""].filter(Boolean).join(" · ")
    case "vbpl_document":
    case "vbpl_history":
      return url ? st.docName(url) : ""
    case "vbpl_article":
      // The model may pass "301" or "Điều 301" / "Article 301": never render "Điều Điều 301".
      return [input.article ? `Điều ${stripUnit(input.article, "article")}` : "", url ? st.docName(url) : ""].filter(Boolean).join(" · ")
    case "vbpl_search_articles":
      return [input.keywords ? `“${short(input.keywords, 50)}”` : "", url ? st.docName(url) : ""].filter(Boolean).join(" · ")
    case "vbpl_verify":
    case "chinhphu_verify":
      return input.quote ? `“${short(input.quote, 70)}”` : ""
    case "skill":
      return short(input.name)
    case "grounding_check":
      return ""
    case "expert_escalate":
      return short(input.reason, 70)
    case "read":
    case "write":
    case "edit":
      return input.filePath ? String(input.filePath).split(/[\\/]/).pop() : ""
    case "calc_contract_check":
      // `text` is the whole contract markdown – never show it as the step argument.
      return typeof input.id === "string" ? short(input.id, 40) : ""
    case "todowrite":
      return Array.isArray(input.todos) ? `${input.todos.length} việc` : ""
    default: {
      if (url) return short(url.replace(/^https?:\/\//, ""), 70)
      const first = Object.values(input).find((v) => typeof v === "string" && v.trim())
      return first ? short(first, 70) : ""
    }
  }
}

function toolResult(tool, output, title) {
  const out = typeof output === "string" ? output : ""
  switch (tool) {
    case "vbpl_find": {
      const n = (out.match(/^\s*\d+\.\s/gm) || []).length
      return n ? `${n} kết quả` : short(out.split("\n")[0], 60)
    }
    case "vbpl_verify":
      return short(out.split(":")[0], 30)
    case "vbpl_article": {
      const m = out.match(/--- NGUYÊN VĂN ---\s*\n+([^\n]+)/)
      return m ? short(m[1], 70) : ""
    }
    case "vbpl_document": {
      const m = out.match(/Tình trạng hiệu lực: ([^\n]+)/)
      return m ? short(m[1], 40) : ""
    }
    case "vbpl_search_articles": {
      const n = (out.match(/^- Điều/gm) || []).length
      return `${n} điều liên quan`
    }
    case "skill":
      return ""
    case "grounding_check": {
      const m = out.match(/ĐỘ TIN CẬY[^:]*:\s*([^\n]+)/)
      return m ? short(m[1].toLowerCase(), 30) : ""
    }
    case "expert_escalate": {
      const m = out.match(/YC-\d{8}-\d{3}-[0-9a-f]{4}/)
      return m ? m[0] : ""
    }
    default:
      return title ? short(title, 60) : ""
  }
}

export const ARTIFACT_ID_RE = /^\d{14}-[0-9a-f]{6}$/
const FILE_FORMATS = ["docx", "pdf", "redline"]
const LANGUAGES = ["vi", "en", "bilingual"]
const ORIGINS = ["agent", "upload"]
// Edit operations of doc-store → language-neutral change codes (the browser words them).
const OP_CODE = { replace: "edit", insert_after: "add", insert_before: "add", delete: "delete", replace_section: "rewrite", insert: "add", edit: "edit", remove: "delete" }
const OP_FROM_VI = { sửa: "edit", thêm: "add", xóa: "delete", xoá: "delete", "viết lại": "rewrite" }
const UNIT_CODE = { điều: "article", chương: "chapter", mục: "section", phần: "part", khoản: "clause", article: "article", chapter: "chapter", section: "section", part: "part", clause: "clause" }
/**
 * doc-store change target ("sau Điều 5", "Điều 10 khoản 2 điểm a", "Mục 3.1", "Chương II", a clipped heading…) →
 * { pos?, unit?, n?, clause?, point?, text? } – text (a heading quoted from the document) is data.
 */
export function parseTarget(target, docLang = "vi") {
  let s = dedupeUnits(short(target, 100)).trim()
  const out = {}
  const pos = s.match(/^(sau|trước|after|before) /iu)
  if (pos) {
    out.pos = /^(sau|after)/i.test(pos[1]) ? "after" : "before"
    s = s.slice(pos[0].length)
  }
  if (/^cuối văn bản$/iu.test(s)) return { ...out, end: true }
  if (/^Phần mở đầu$/iu.test(s)) return { ...out, preamble: true }
  const m = s.match(/^(điều|chương|mục|phần|khoản|article|chapter|section|part|clause)\s+([\dIVXLCivxlc]+[a-zđ]?(?:\.\d+)*)(?:\s+khoản\s+([\d.]+))?(?:\s+điểm\s+([a-zđ]))?$/iu)
  if (m) {
    out.unit = UNIT_CODE[m[1].toLowerCase()]
    out.n = m[2]
    if (m[3]) out.clause = m[3]
    if (m[4]) out.point = m[4]
    return out
  }
  if (s) out.text = { v: s, lang: langOf(s, docLang) || docLang }
  return out
}
const posInt = (v, max = 100000) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null
}
const idOrNull = (v) => (typeof v === "string" && ARTIFACT_ID_RE.test(v) ? v : null)

/**
 * Structured summary of a metadata `changes` list ([{op, target, before?, after?}]), grouped like doc-store
 * changesSummary(): same action in the same Điều → one item with clauses [2, 3], identical targets → count,
 * 3+ mixed sub-targets → the Điều with a count. Item: { op, pos?, unit?, n?, clauses?, point?, text?, end?,
 * preamble?, count? } – the browser renders "Edited Article 10, clauses 2, 3" / "Sửa Điều 10 khoản 2, 3".
 */
export function summarizeChanges(changes, docLang = "vi") {
  if (!Array.isArray(changes)) return []
  const groups = new Map()
  for (const c of changes.slice(0, 200)) {
    if (!c || typeof c !== "object") continue
    const op = OP_CODE[String(c.op || "").toLowerCase()] || "edit"
    const t = parseTarget(c.target, c.lang || docLang)
    // Group per (op, position, Điều): sub-targets are the clause / point inside it; other targets group when identical.
    const isArt = t.unit === "article"
    const head = isArt ? { op, ...(t.pos ? { pos: t.pos } : {}), unit: t.unit, n: t.n } : { op, ...t }
    const key = isArt ? `${op}|${t.pos ?? ""}|${t.n}` : `${op}|${JSON.stringify(t)}`
    const g = groups.get(key) ?? { head, subs: [] }
    g.subs.push(isArt ? JSON.stringify([t.clause ?? "", t.point ?? ""]) : "")
    groups.set(key, g)
  }
  const num = (s) => String(s).split(".").map(Number)
  const byNum = (a, b) => {
    const x = num(a), y = num(b)
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1)
    return 0
  }
  const out = []
  const push = (item, count) => out.push(count > 1 ? { ...item, count } : item)
  for (const { head, subs } of groups.values()) {
    const uniq = [...new Set(subs)]
    const sub = (u) => {
      const [clause, point] = JSON.parse(u || '["",""]')
      return { ...(clause ? { clauses: [clause] } : {}), ...(point ? { point } : {}) }
    }
    if (uniq.length === 1) push({ ...head, ...sub(uniq[0]) }, subs.length)
    else if (uniq.every((u) => /^\["[\d.]+",""\]$/.test(u))) {
      const clauses = uniq.map((u) => JSON.parse(u)[0]).sort(byNum)
      push({ ...head, clauses }, subs.length > uniq.length ? subs.length : 1)
    } else if (uniq.length >= 3) push(head, subs.length)
    else for (const u of uniq) push({ ...head, ...sub(u) }, subs.filter((s) => s === u).length)
  }
  return out.slice(0, 30)
}

/** Legacy Vietnamese summary lines ("Sửa Điều 10 khoản 2, 3 (2 chỗ)") → the same structured items. */
export function parseChangeLine(line, docLang = "vi") {
  const m = String(line || "").trim().match(/^(Sửa|Thêm|Xóa|Xoá|Viết lại)\s+(.*?)(?:\s+\((\d+) chỗ\))?$/iu)
  if (!m) return { op: "edit", text: { v: short(line, 160), lang: langOf(line, "vi") || "vi" } }
  const op = OP_FROM_VI[m[1].toLowerCase()] || "edit"
  let target = m[2]
  let clauses
  const k = target.match(/^(.*?Điều \S+) khoản ([\d.]+(?:, [\d.]+)+)$/u)
  if (k) {
    target = k[1]
    clauses = k[2].split(/,\s*/)
  }
  const t = parseTarget(target, docLang)
  if (t.clause) {
    clauses = [t.clause]
    delete t.clause
  }
  const item = { op, ...t, ...(clauses ? { clauses } : {}) }
  return m[3] && +m[3] > 1 ? { ...item, count: +m[3] } : item
}

/** Whitelist of a structured change item (strings capped). */
function cleanChange(c) {
  if (!c || typeof c !== "object") return null
  const out = { op: ["edit", "add", "delete", "rewrite"].includes(c.op) ? c.op : "edit" }
  if (["after", "before"].includes(c.pos)) out.pos = c.pos
  if (["article", "chapter", "section", "part", "clause"].includes(c.unit)) out.unit = c.unit
  if (c.n != null && /^[\w.]{1,12}$/u.test(String(c.n))) out.n = String(c.n)
  if (Array.isArray(c.clauses)) out.clauses = c.clauses.map(String).filter((x) => /^[\d.]{1,12}$/.test(x)).slice(0, 20)
  if (c.point && /^[a-zđ]$/iu.test(String(c.point))) out.point = String(c.point)
  if (c.text?.v) out.text = { v: short(c.text.v, 160), ...(["vi", "en"].includes(c.text.lang) ? { lang: c.text.lang } : {}) }
  if (c.end === true) out.end = true
  if (c.preamble === true) out.preamble = true
  if (Number.isInteger(c.count) && c.count > 1 && c.count < 10000) out.count = c.count
  return out.unit || out.text || out.end || out.preamble ? out : null
}

/**
 * Normalize an artifact descriptor (the tool's marker JSON or a metadata file) into the safe, minimal
 * shape the browser sees: whitelisted fields only, strings capped, ids validated. Null when invalid.
 */
export function artifactDescriptor(a) {
  if (!a || typeof a !== "object" || !ARTIFACT_ID_RE.test(a.id)) return null
  const files = (Array.isArray(a.files) ? a.files : [])
    .filter((f) => f && FILE_FORMATS.includes(f.format))
    .slice(0, 6)
    .map((f) => ({ format: f.format, bytes: Math.max(0, Number(f.bytes) || 0) }))
  const docLang = a.language === "en" ? "en" : "vi"
  // Structured change items (raw `changes` when present; else the Vietnamese summary lines of older metadata).
  const changes = (
    Array.isArray(a.changes) && a.changes.length
      ? summarizeChanges(a.changes, docLang)
      : Array.isArray(a.changes_summary)
        ? a.changes_summary.filter((x) => typeof x === "string" && x.trim()).slice(0, 30).map((x) => parseChangeLine(x, docLang))
        : []
  )
    .map(cleanChange)
    .filter(Boolean)
  const out = {
    id: a.id,
    title: short(a.title || "Tài liệu", 160),
    kind: ["hop-dong", "bao-cao", "van-ban"].includes(a.kind) ? a.kind : "van-ban",
    files,
    hasPreview: !!a.preview,
    hasMarkdown: !!a.markdown,
    version: posInt(a.version) || 1,
    rootId: idOrNull(a.root_id) || idOrNull(a.rootId) || a.id,
    parentId: idOrNull(a.parent_id) || idOrNull(a.parentId),
    origin: ORIGINS.includes(a.origin) ? a.origin : "agent",
    changes,
  }
  // Document language (VI / EN / VI–EN badge); missing = vi on the client.
  if (LANGUAGES.includes(a.language)) out.language = a.language
  if (typeof a.createdAt === "string" && a.createdAt.length <= 40) out.createdAt = a.createdAt
  // Made before versioning existed: no chain on the server (the UI numbers same-title documents instead).
  if (a.version == null && a.root_id == null && a.rootId == null) out.legacy = true
  if (a.origin === "upload" && (a.original || (Array.isArray(a.files) && a.files.some((f) => f?.format === "original")))) out.hasOriginal = true
  // imported from a scanned PDF upload whose text was recognised by OCR (the web server adds meta.ocr after importDocument)
  if (a.ocr && typeof a.ocr === "object" && Array.isArray(a.ocr.pages)) {
    const n = a.ocr.pages.filter((x) => Number.isInteger(x) && x > 0).length
    if (n) out.ocr = { n, total: posInt(a.ocr.totalPages) || n }
  }
  return out
}

/** The `[[artifact:{…}]]` marker at the end of a document_create / document_edit output → safe descriptor. */
export function parseArtifact(output) {
  const m = String(output || "").match(/\[\[artifact:(\{[\s\S]*\})\]\]\s*$/)
  if (!m || m[1].length > 200_000) return null
  try {
    return artifactDescriptor(JSON.parse(m[1]))
  } catch {
    return null
  }
}

const DOC_TOOLS = new Set(["document_create", "document_edit", "draft_assemble"])

// ---- visuals (diagram_create / image_fetch / source_snapshot, server/visuals.mjs) ----------------------------
const VISUAL_TOOLS = new Set(["diagram_create", "image_fetch", "source_snapshot"])
/** {id, kind} of the visual a completed tool made (metadata.ui.visual, else the marker in its output). */
export function visualOf(output, metadata) {
  const v = metadata?.ui?.visual
  if (v && /^v\d{14}-[0-9a-f]{6}$/.test(v.id) && ["diagram", "image", "snapshot"].includes(v.kind)) return { id: v.id, kind: v.kind }
  const m = String(output || "").match(/\[\[diagram:(v\d{14}-[0-9a-f]{6})\]\]|\(visual:(v\d{14}-[0-9a-f]{6})\)/)
  return m ? { id: m[1] || m[2], kind: m[1] ? "diagram" : "image" } : null
}

// ---- interactive clarifying questions (opencode "question" tool, see docs/QUESTION_TOOL.md) ----------
export const QUESTION_TOOL = "question"
export const QUESTION_ID_RE = /^que_[A-Za-z0-9]{1,80}$/
/** Model-written questions → safe, capped shape (render whatever arrives: 6 options or 4 questions happen). */
export function cleanQuestions(list, locale) {
  const sc = (v, n) => scrubText(short(typeof v === "string" ? v : "", n), locale)
  const text = (v, n) => {
    // Question text may be multi-line: keep line breaks, cap the length.
    const x = String(typeof v === "string" ? v : "").replace(/\r/g, "").trim()
    return scrubText(x.length > n ? x.slice(0, n - 1) + "…" : x, locale)
  }
  return (Array.isArray(list) ? list : [])
    .filter((q) => q && typeof q === "object")
    .slice(0, 10)
    .map((q) => ({
      question: text(q.question, 1000),
      header: sc(q.header, 60),
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o) => o && typeof o === "object" && typeof o.label === "string" && o.label.trim())
        .slice(0, 12)
        .map((o) => ({ label: sc(o.label, 200), description: sc(o.description, 400) })),
      multiple: q.multiple === true,
      custom: q.custom !== false,
    }))
    .filter((q) => q.question || q.options.length)
}
/** Answers (string[][]) as stored by opencode / sent by the user → capped copy. */
export const cleanAnswers = (a, locale) =>
  (Array.isArray(a) ? a : []).slice(0, 10).map((x) => (Array.isArray(x) ? x : []).filter((v) => typeof v === "string").slice(0, 20).map((v) => scrubText(short(v, 500), locale)))
/** Tool part → { qstate, questions, answers? }: pending | answered | dismissed (user skipped) | stopped (run aborted). */
function questionPart(p, s, opts) {
  const questions = cleanQuestions(s.input?.questions, opts.locale)
  let qstate = "pending"
  if (s.status === "completed") qstate = "answered"
  else if (s.status === "error") qstate = /dismiss/i.test(String(s.error || "")) ? "dismissed" : "stopped"
  return {
    id: p.id,
    type: "tool",
    tool: QUESTION_TOOL,
    status: s.status || "pending",
    callID: typeof p.callID === "string" ? p.callID.slice(0, 120) : undefined,
    questions,
    qstate,
    ...(qstate === "answered" ? { answers: cleanAnswers(s.metadata?.answers, opts.locale) } : {}),
    start: s.time?.start,
    end: s.time?.end,
  }
}

/**
 * opencode Part → client part (or null when it should not be shown).
 * opts.reasoning: include model reasoning (admin toggle / admin setting) – default false: stripped server-side.
 * Every user-visible string goes through scrubText (no vendor / model / runtime names).
 */
export function normalizePart(p, st, opts = {}) {
  if (!p) return null
  const np = rawPart(p, st, opts)
  if (!np) return null
  const sc = (v) => (typeof v === "string" ? scrubText(v, opts.locale) : v)
  for (const k of ["text", "label", "result", "error"]) if (np[k] != null) np[k] = sc(np[k])
  if (np.errorInfo) np.errorInfo = { ...np.errorInfo, detail: sc(np.errorInfo.detail) }
  if (np.step)
    np.step = {
      args: (np.step.args || []).map((a) => (typeof a.v === "string" ? { ...a, v: sc(a.v) } : a)),
      ...(np.step.res ? { res: typeof np.step.res.v === "string" ? { ...np.step.res, v: sc(np.step.res.v) } : np.step.res } : {}),
      ...(np.step.ocr ? { ocr: np.step.ocr } : {}),
    }
  // Long-document drafting (draft_* tools): the progress object for the web progress card (docs/DRAFTING.md).
  if (np.type === "tool") {
    const draft = draftForPart(p, opts.locale)
    if (draft) np.draft = draft
    // draft_fix / draft_check assemble the document themselves (docs/DRAFTING.md) → same document card.
    if (!np.artifact && /^draft_(fix|check)$/.test(p.tool) && p.state?.status === "completed") {
      const artifact = parseArtifact(p.state.output)
      if (artifact) np.artifact = artifact
    }
    // Compact result card for calc_* / fx_* / web_read / tariff_* steps (server/resultcards.mjs).
    if (p.state?.status === "completed") {
      const card = resultCard(p.tool, p.state.output, p.state.input, opts.locale, p.state.metadata)
      if (card) np.card = card
    }
  }
  if (np.artifact)
    np.artifact = {
      ...np.artifact,
      title: sc(np.artifact.title),
      changes: (np.artifact.changes || []).map((c) => (c.text ? { ...c, text: { ...c.text, v: sc(c.text.v) } } : c)),
    }
  return np
}
function rawPart(p, st, opts) {
  if (p.type === "text") {
    if (p.synthetic || p.ignored) return null
    return { id: p.id, type: "text", text: cleanModelText(p.text) }
  }
  if (p.type === "reasoning") return opts.reasoning ? { id: p.id, type: "reasoning", text: String(p.text || "") } : null
  if (p.type === "tool") {
    // Malformed calls the model retries on its own ("invalid" placeholder tool) are noise for users.
    if (p.tool === "invalid") return null
    const s = p.state || {}
    if (p.tool === QUESTION_TOOL) return questionPart(p, s, opts)
    if (s.status === "completed") st.learn(p.tool, s.output)
    const source = s.status === "completed" ? sourceMeta(p.tool, s.input || {}, s.output, s.metadata) : null
    const errorInfo = s.status === "error" ? stepError(s.error) : null
    const common = { id: p.id, type: "tool", tool: p.tool, status: s.status || "pending", error: s.status === "error" ? short(s.error, 200) : undefined, ...(errorInfo ? { errorInfo } : {}), start: s.time?.start, end: s.time?.end }
    if (DOC_TOOLS.has(p.tool)) {
      const artifact = s.status === "completed" ? parseArtifact(s.output) : null
      const title = short(artifact?.title || (typeof s.input?.title === "string" ? s.input.title : ""), 80)
      const docLang = artifact?.language === "en" ? "en" : artifact?.language === "bilingual" ? undefined : "vi"
      const files = artifact ? artifact.files.filter((f) => f.format !== "redline").map((f) => f.format.toUpperCase()) : []
      const step = {
        args: [title ? { t: "doc", v: title, ...(langOf(title, docLang) ? { lang: langOf(title, docLang) } : {}) } : null, p.tool === "document_edit" && artifact ? { t: "version", n: artifact.version } : null].filter(Boolean),
        ...(artifact ? { res: p.tool === "document_edit" && artifact.changes.length ? { t: "changes", n: artifact.changes.length } : { t: "files", v: files } } : {}),
      }
      if (!artifact && /^draft_/.test(p.tool)) step.args = stepView(p.tool, s.input || {}, "", null, st, opts.locale).args
      return {
        ...common,
        // legacy strings (older clients); the browser renders `step`
        label: p.tool === "document_edit" && artifact ? `${title} (v${artifact.version})` : title,
        result: artifact ? (p.tool === "document_edit" && artifact.changes.length ? `${artifact.changes.length} thay đổi` : files.join(", ") || "không có tệp") : undefined,
        step,
        ...(artifact ? { artifact } : {}),
      }
    }
    if (p.tool === "document_read") {
      const a = s.status === "completed" ? parseArtifact(s.output) : null
      const docLang = a?.language === "en" ? "en" : a?.language === "bilingual" ? undefined : "vi"
      return {
        ...common,
        label: a ? short(a.title, 80) + (a.version > 1 ? ` (v${a.version})` : "") : "",
        step: { args: a ? [{ t: "doc", v: short(a.title, 80), ...(langOf(a.title, docLang) ? { lang: langOf(a.title, docLang) } : {}) }, ...(a.version > 1 ? [{ t: "version", n: a.version }] : [])] : [] },
      }
    }
    return {
      ...common,
      label: toolLabel(p.tool, s.input || {}, st),
      result: s.status === "completed" ? toolResult(p.tool, s.output, s.title) : undefined,
      step: stepView(p.tool, s.input || {}, s.status === "completed" ? s.output : "", s.metadata, st, opts.locale),
      ...(source ? { source } : {}),
      ...(s.status === "completed" && VISUAL_TOOLS.has(p.tool) && visualOf(s.output, s.metadata) ? { visual: visualOf(s.output, s.metadata) } : {}),
    }
  }
  return null
}

/**
 * opencode error → { message (Vietnamese, legacy), code (stable, localized by the client) }.
 * The raw provider / model error text is NOT forwarded to users (it can name the vendor, model or endpoint,
 * e.g. "… API timeout"); it is only logged on the server.
 */
export function errorMessage(err) {
  if (!err) return null
  const name = err.name || ""
  const msg = err.data?.message || err.message || ""
  if (name === "MessageAbortedError") return { aborted: true, code: "aborted", message: "Đã dừng." }
  if (msg) logModelError(name, msg)
  if (name === "ProviderAuthError") return { code: "provider_auth", message: "Mô hình AI tạm thời không khả dụng. Vui lòng báo quản trị viên." }
  if (name === "ContextOverflowError") return { code: "context_overflow", message: "Cuộc trò chuyện đã quá dài. Hãy mở cuộc trò chuyện mới." }
  if (name === "MessageOutputLengthError") return { code: "output_length", message: "Câu trả lời vượt quá độ dài cho phép." }
  if (name === "APIError") return { code: "model_error", message: "Mô hình AI tạm thời không phản hồi. Vui lòng thử lại sau ít phút." }
  return { code: "processing_error", message: "Đã xảy ra lỗi khi xử lý. Vui lòng thử lại." }
}
const loggedErrors = new Set()
function logModelError(name, msg) {
  const k = name + ":" + msg
  if (loggedErrors.has(k)) return
  if (loggedErrors.size > 500) loggedErrors.clear()
  loggedErrors.add(k)
  console.warn(`[agent] ${name || "Error"}: ${short(msg, 300)}`)
}

/**
 * "Tệp đính kèm: <tên> (mã tài liệu: <id> – …) (bản scan – văn bản nhận dạng OCR, <n>/<tổng> trang) (đã cắt bớt – …)"
 * → { name, docId?, ocr?: { n, total } }. `ocr` = { pages: [..], totalPages } of the upload (text recognised from a scan).
 */
export const attachmentHeader = (name, docId, cutNote = "", ocr = null) =>
  `Tệp đính kèm: ${name}${docId ? ` (mã tài liệu: ${docId} – có thể sửa bằng document_edit)` : ""}${ocr?.pages?.length ? ` (bản scan – văn bản nhận dạng OCR, ${ocr.pages.length}/${ocr.totalPages || ocr.pages.length} trang)` : ""}${cutNote}`
const OCR_NOTE_RE = /\s+\(bản scan – văn bản nhận dạng OCR, (\d{1,4})\/(\d{1,4}) trang\)$/
export function parseAttachmentHeader(h) {
  let name = String(h).replace(/\s+\(đã cắt bớt[^()]*\)$/, "")
  let ocr
  const o = name.match(OCR_NOTE_RE)
  if (o) {
    ocr = { n: +o[1], total: +o[2] }
    name = name.slice(0, o.index)
  }
  const r = parseDocHeader(name)
  return ocr ? { ...r, ocr } : r
}
function parseDocHeader(name) {
  let docId
  const m = name.match(/\s+\(mã tài liệu: (\d{14}-[0-9a-f]{6})[^()]*\)$/)
  if (m) {
    docId = m[1]
    name = name.slice(0, m.index)
  }
  return docId ? { name, docId } : { name }
}

/** Split the prompt we sent back into what the user typed + attachment names. */
export function parseUserText(text) {
  text = String(text || "")
  const i = text.indexOf(ATTACH_NOTE)
  if (i < 0) return { text: stripUiLanguage(text), attachments: [] }
  const rest = text.slice(i)
  const attachments = [...rest.matchAll(/^Tệp đính kèm: (.+)$/gm)].map((m) => parseAttachmentHeader(m[1]))
  let shown = stripUiLanguage(text.slice(0, i).trim()).trim()
  if (shown === EMPTY_TEXT_WITH_FILES) shown = ""
  return { text: shown, attachments }
}

/** The exact prompt text we sent (user text + attachment blocks). */
export const rawUserText = (parts = []) => parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n")

/** The attachment section of a prompt we sent (to keep attachments when a message is edited). */
export function attachmentSection(raw) {
  const i = String(raw || "").indexOf(ATTACH_NOTE)
  return i < 0 ? "" : raw.slice(i)
}

/** Plain text of a converted message for search / export. */
export function plainText(m, fileLabel = "Tệp") {
  if (m.role === "user") return [m.text, ...(m.attachments || []).map((a) => `[${fileLabel}: ${a.name}]`)].filter(Boolean).join("\n")
  return (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n").trim()
}

/** GET /session/:id/message → client messages. */
export function convertHistory(items, st, opts = {}) {
  const out = []
  let repair = false // after a hidden repair prompt: the turn's answers are the repaired ones
  let finalize = false
  for (const { info, parts } of items || []) {
    if (!info) continue
    st.roles.set(info.id, info.role)
    if (info.role === "user" && isRepairUser(parts)) {
      repair = true
      continue
    }
    if (info.role === "user" && isFinalUser(parts)) {
      finalize = true // same turn: the answer written on request after an empty final message
      continue
    }
    if (info.role === "user") {
      repair = false
      finalize = false
      const text = rawUserText(parts)
      out.push({ id: info.id, role: "user", time: info.time?.created, ...parseUserText(text) })
    } else {
      const err = errorMessage(info.error)
      out.push({
        id: info.id,
        role: "assistant",
        time: info.time?.created,
        completed: info.time?.completed,
        finish: info.finish,
        error: err?.message,
        errorCode: err?.code,
        errorDetail: err?.detail,
        aborted: err?.aborted,
        ...(repair ? { repair: true } : {}),
        ...(finalize ? { finalize: true } : {}),
        parts: parts.map((p) => normalizePart(p, st, opts)).filter(Boolean),
      })
    }
  }
  return out
}

/**
 * Streaming scrub: text / reasoning deltas are accumulated per part (per connection) and only the scrubbed
 * prefix minus a short hold-back is sent, so a vendor name split across deltas ("Qw" + "en…") never reaches
 * the browser. If scrubbing changes text already sent, the whole part is re-sent instead of a delta.
 */
const HOLD = 40
function scrubDelta(ctx, messageID, partID, kind, delta) {
  const a = ctx.acc.get(partID) ?? { raw: "", sent: "", messageID, kind }
  a.raw += delta
  ctx.acc.set(partID, a)
  const clean = scrubText(kind === "text" ? cleanModelText(a.raw) : a.raw, ctx.locale)
  const upto = Math.max(a.sent.length, clean.length - HOLD)
  if (!clean.startsWith(a.sent)) {
    a.sent = clean.slice(0, upto)
    return { type: "part", messageID, part: { id: partID, type: kind, text: a.sent } }
  }
  const out = clean.slice(a.sent.length, upto)
  if (!out) return null
  a.sent += out
  return { type: "delta", messageID, partID, kind, delta: out }
}

/**
 * One opencode bus event → zero or one client event.
 * ctx (per SSE connection): { reasoning: boolean, acc: Map, locale } – without it (state bookkeeping only)
 * the result is not sent anywhere.
 */
export function translateEvent(ev, st, ctx = null) {
  const p = ev.properties || {}
  switch (ev.type) {
    case "message.updated": {
      const info = p.info
      st.roles.set(info.id, info.role)
      if (info.role !== "assistant") return null
      const err = errorMessage(info.error)
      const msg = { type: "message", id: info.id, time: info.time?.created, completed: info.time?.completed, finish: info.finish, error: err?.message, errorCode: err?.code, errorDetail: err?.detail, aborted: err?.aborted }
      // Message finished: release the held-back tail of its streamed parts (full scrubbed text).
      if (ctx && info.time?.completed) {
        const flush = []
        for (const [id, a] of ctx.acc) {
          if (a.messageID !== info.id) continue
          const clean = scrubText(a.kind === "text" ? cleanModelText(a.raw) : a.raw, ctx.locale)
          if (clean !== a.sent) flush.push({ type: "part", messageID: info.id, part: { id, type: a.kind, text: clean } })
          ctx.acc.delete(id)
        }
        if (flush.length) return [...flush, msg]
      }
      return msg
    }
    case "message.part.updated": {
      const part = p.part
      if (st.roles.get(part.messageID) === "user") return null
      st.partKinds.set(part.id, part.type)
      const np = normalizePart(part, st, { reasoning: !!ctx?.reasoning, locale: ctx?.locale })
      if (np && ctx && (np.type === "text" || np.type === "reasoning")) {
        // Full text of the part: resync the streaming accumulator with it. While the part is still streaming
        // (no end time), keep the same hold-back as for deltas.
        if (!part.time?.end && np.text.length > HOLD) np.text = np.text.slice(0, np.text.length - HOLD)
        ctx.acc.set(part.id, { raw: String(part.text || ""), sent: np.text, messageID: part.messageID, kind: np.type })
      }
      return np ? { type: "part", messageID: part.messageID, part: np } : null
    }
    case "message.part.delta": {
      if (st.roles.get(p.messageID) === "user" || p.field !== "text") return null
      const kind = st.partKinds.get(p.partID) || "text"
      if (kind !== "text" && kind !== "reasoning") return null
      if (kind === "reasoning" && !ctx?.reasoning) return null
      if (!ctx) return null
      return scrubDelta(ctx, p.messageID, p.partID, kind, String(p.delta || ""))
    }
    case "message.removed":
      return { type: "removed", id: p.messageID }
    case "session.status": {
      const s = p.status || {}
      st.status = s.type === "idle" ? "idle" : "busy"
      // No provider text in retry notices (it can name the vendor / endpoint).
      if (s.type === "retry") return { type: "status", status: "retry", attempt: s.attempt }
      return { type: "status", status: s.type }
    }
    case "session.idle":
      st.status = "idle"
      return { type: "idle" }
    case "session.error": {
      const err = errorMessage(p.error)
      if (!err) return null
      return err.aborted ? { type: "aborted" } : { type: "error", message: err.message, code: err.code, detail: err.detail }
    }
    case "web.resync":
      return { type: "resync" }
    // Clarifying questions: the request id (needed to answer) only comes with these events.
    case "question.asked":
      if (!ctx || !QUESTION_ID_RE.test(String(p.id || ""))) return null
      return { type: "question", id: p.id, messageID: p.tool?.messageID, callID: p.tool?.callID, questions: cleanQuestions(p.questions, ctx.locale) }
    case "question.replied":
      if (!ctx || !QUESTION_ID_RE.test(String(p.requestID || ""))) return null
      return { type: "question.replied", id: p.requestID, answers: cleanAnswers(p.answers, ctx.locale) }
    case "question.rejected":
      if (!ctx || !QUESTION_ID_RE.test(String(p.requestID || ""))) return null
      return { type: "question.rejected", id: p.requestID }
    default:
      return null
  }
}
