// Staged drafting of long documents (contracts, reports) – the core behind the draft_* tools
// (../tools/draft.ts): PLAN → WRITE SECTIONS IN PARALLEL → CROSS-CHECK → FIX → ASSEMBLE, like a drafting team.
// Orchestration happens here in code (not in the chat model), so parallelism and the checks do not depend on
// the model emitting parallel tool calls. Writers are direct chat-completions calls (./llm.ts) to the same
// model as the session. Everything a draft needs lives in
//   <outputs>/<sessionID>/drafts/<draftId>/{draft.json, sections/<key>.md, sections/<key>.en.md, issues.json, progress.json}
// progress.json is the live progress object (docs/DRAFTING.md) – also emitted as tool metadata key `draft`.
// Node 24 type-stripping compatible (imported by tests): no enums / namespaces, .ts imports only.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { loadEvidence, type Evidence } from "./evidence.ts"
import {
  ANNEX_MARKER, artifactMarker, checkBilingualStructure, ensureLanguageClause, enSignLabel, findDocumentForSession, listSessionFolders, normKey, outDir, outputsRoot,
  saveDocument, type DocMeta,
} from "./doc-store.ts"
import { chat, parseJsonLoose, pool, sessionModel, type ChatMsg } from "./llm.ts"

// ---------- types ----------
export type Kind = "hop-dong" | "bao-cao" | "van-ban"
export type Lang = "vi" | "en" | "bilingual"
export type SectionStatus = "pending" | "writing" | "written" | "failed" | "checked" | "fixed"
export type Severity = "lỗi" | "cảnh báo" | "gợi ý"
export type Phase = "plan" | "write" | "check" | "fix" | "assemble" | "done" | "failed"

export type SectionInput = {
  key: string
  heading: string
  heading_en?: string
  purpose?: string
  must_include?: string[]
  legal_basis_urls?: string[]
  words?: number
}
export type Section = {
  key: string
  heading: string // without number
  heading_en?: string
  purpose: string
  must_include: string[]
  legal_basis_urls: string[]
  words?: number
  type: "article" | "annex" | "part"
  no: number
  label: string // "Điều 5" | "Phụ lục 1" | "Mục 3"
  research: string[] // research item ids
  status: SectionStatus
  wordCount?: number
  issues?: number
  error?: string
  attempts?: number
  truncated?: boolean
}
export type ResearchItem = { id: string; url: string; title?: string; law?: string; number?: string; article?: string; text: string }
export type Party = { role: string; short?: string; name_placeholder?: string; role_en?: string }
export type GlossaryItem = { term: string; definition: string; en?: string; auto?: boolean }
export type Issue = {
  id: string
  section?: string
  severity: Severity
  code: string
  message: string
  suggested_fix?: string
  source: "auto" | "review"
  lang?: "vi" | "en"
  status: "open" | "fixed" | "remaining"
  round?: number
  /** machine-fixable details (term-variant: {term, variant}) */
  data?: Record<string, string>
}
export type Draft = {
  draftId: string
  sessionID: string
  title: string
  title_en?: string
  kind: Kind
  language: Lang
  prevailing?: "vi" | "en"
  brief: string
  user_side?: string
  sections: Section[]
  glossary: GlossaryItem[]
  parties: Party[]
  facts: Record<string, unknown>
  style: { detail?: string; words_per_section?: number; notes?: string }
  research: ResearchItem[]
  model: string
  phase: Phase
  round: number
  startedAt: number
  updatedAt: number
  timings: Record<string, number>
  warnings: string[]
  document?: { id: string; version: number; title: string }
  error?: string
}
export type Progress = {
  draftId: string
  title: string
  kind: Kind
  language: Lang
  phase: Phase
  sections: { key: string; label: string; heading: string; status: SectionStatus; words?: number; issues?: number }[]
  issues: { errors: number; warnings: number; suggestions: number }
  round: number
  startedAt: number
  updatedAt: number
  timings: Record<string, number>
  document?: { id: string; version: number; title: string }
  error?: string
}

// ---------- storage ----------
const DRAFT_ID_RE = /^d-[\w-]{6,40}$/
export const draftsDir = (sessionID: string) => path.join(outDir(sessionID || "no-session"), "drafts")
const dirOf = (d: Pick<Draft, "sessionID" | "draftId">) => path.join(draftsDir(d.sessionID), d.draftId)
const writeJson = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2))
  fs.renameSync(tmp, f)
}

export function saveDraft(d: Draft) {
  d.updatedAt = Date.now()
  writeJson(path.join(dirOf(d), "draft.json"), d)
}

/** Draft of this session, or (web fork / regenerate = new session id) of any session folder. */
export function loadDraft(sessionID: string, draftId: string): Draft | null {
  const id = String(draftId || "").trim()
  if (!DRAFT_ID_RE.test(id)) return null
  const tryDir = (sid: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(draftsDir(sid), id, "draft.json"), "utf8")) as Draft
    } catch {
      return null
    }
  }
  const own = tryDir(sessionID)
  if (own) return own
  for (const sid of listSessionFolders()) {
    const d = tryDir(sid)
    if (d) return d
  }
  return null
}

export function sectionText(d: Draft, key: string, lang: "vi" | "en" = "vi"): string {
  try {
    return fs.readFileSync(path.join(dirOf(d), "sections", `${key}${lang === "en" ? ".en" : ""}.md`), "utf8")
  } catch {
    return ""
  }
}
function writeSection(d: Draft, key: string, text: string, lang: "vi" | "en" = "vi") {
  const f = path.join(dirOf(d), "sections", `${key}${lang === "en" ? ".en" : ""}.md`)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text.trim() + "\n")
}
export function loadIssues(d: Draft): Issue[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(d), "issues.json"), "utf8"))
  } catch {
    return []
  }
}
function saveIssues(d: Draft, issues: Issue[]) {
  writeJson(path.join(dirOf(d), "issues.json"), issues)
}

// ---------- progress (tool metadata key `draft` + progress.json) ----------
export function progressOf(d: Draft, issues: Issue[] = loadIssues(d)): Progress {
  const open = issues.filter((i) => i.status !== "fixed")
  const per = new Map<string, number>()
  for (const i of open) if (i.section && i.severity !== "gợi ý") per.set(i.section, (per.get(i.section) ?? 0) + 1)
  return {
    draftId: d.draftId, title: d.title, kind: d.kind, language: d.language, phase: d.phase,
    sections: d.sections.map((s) => ({
      key: s.key, label: s.label, heading: s.heading, status: s.status,
      ...(s.wordCount ? { words: s.wordCount } : {}), ...(per.get(s.key) ? { issues: per.get(s.key) } : {}),
    })),
    issues: {
      errors: open.filter((i) => i.severity === "lỗi").length,
      warnings: open.filter((i) => i.severity === "cảnh báo").length,
      suggestions: open.filter((i) => i.severity === "gợi ý").length,
    },
    round: d.round, startedAt: d.startedAt, updatedAt: Date.now(), timings: d.timings,
    ...(d.document ? { document: d.document } : {}), ...(d.error ? { error: d.error } : {}),
  }
}

const PHASE_TITLE: Record<Phase, string> = {
  plan: "Lập dàn ý", write: "Đang soạn các điều", check: "Đang rà soát chéo", fix: "Đang sửa lỗi", assemble: "Đang ghép văn bản", done: "Hoàn tất", failed: "Lỗi",
}
export function progressTitle(p: Progress) {
  const done = p.sections.filter((s) => ["written", "checked", "fixed"].includes(s.status)).length
  return `${PHASE_TITLE[p.phase]} – ${p.title} (${done}/${p.sections.length})`
}

/** Emit progress: progress.json (always) + context.metadata (live tool-part metadata where the host supports it). */
export function emit(d: Draft, context?: any, issues?: Issue[]) {
  const p = progressOf(d, issues)
  try {
    writeJson(path.join(dirOf(d), "progress.json"), p)
  } catch {}
  try {
    const r = context?.metadata?.({ title: progressTitle(p), metadata: { draft: p } })
    if (r && typeof r.then === "function") r.then(undefined, () => {})
  } catch {}
  return p
}

// ---------- text helpers ----------
export const norm = (s: string) =>
  s.normalize("NFC").replace(/[“”«»„"]/g, '"').replace(/[‘’`']/g, "'").replace(/[‐-―]/g, "-").replace(/\.{3}/g, "…").replace(/\s+/g, " ").trim().toLowerCase()
const baseUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/$/, "")
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
export const wordCount = (s: string) => (s.replace(/[#*_>|`-]/g, " ").match(/[\p{L}\p{N}]+/gu) ?? []).length
const STOP = new Set("và của các cho với trong được theo tại khi nếu thì là có không này đó một những bên hợp đồng điều khoản về để từ đến do bởi hoặc như trên dưới sau trước the and of to in for a an by or on shall be is".split(" "))
const sigWords = (s: string) => new Set(normKey(s).split(" ").filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)))
const isDefinitions = (h: string) => /giai thich tu ngu|dinh nghia|dien giai|definitions?|interpretation/.test(normKey(h))

// ---------- research pack ----------
const LAW_TYPES = "Bộ luật|Luật|Nghị định|Thông tư|Nghị quyết|Pháp lệnh|Quyết định"
const LAW_EN: [RegExp, string][] = [
  [/^luat thuong mai/, "Commercial Law"], [/^bo luat dan su/, "Civil Code"], [/^luat canh tranh/, "Law on Competition"],
  [/^luat so huu tri tue/, "Law on Intellectual Property"], [/^luat quan ly ngoai thuong/, "Law on Foreign Trade Management"],
  [/^luat doanh nghiep/, "Law on Enterprises"], [/^luat bao ve quyen loi nguoi tieu dung/, "Law on Protection of Consumers' Rights"],
  [/^luat trong tai thuong mai/, "Law on Commercial Arbitration"], [/^luat quang cao/, "Law on Advertising"], [/^luat thue gia tri gia tang/, "Law on Value Added Tax"],
]
export function lawEn(name: string) {
  const k = normKey(name)
  return LAW_EN.find(([re]) => re.test(k))?.[1] ?? name
}

/** Law name + number from an evidence entry ("Luật Thương mại", "36/2005/QH11"). */
function lawOf(e: Evidence): { law?: string; number?: string } {
  const head = `${e.title ?? ""}\n${e.text.slice(0, 8000)}`
  const m = head.match(new RegExp(`(${LAW_TYPES})\\s+([^\\n]{0,90}?)\\s*số\\s*(\\d{1,4}/\\d{4}/[A-ZĐ0-9-]+)`, "u"))
  if (m) {
    const name = `${m[1]} ${m[2]}`.replace(/\s+/g, " ").trim()
    return { law: m[1] === "Nghị định" || m[1] === "Thông tư" || m[1] === "Quyết định" ? `${m[1]} ${m[3]}` : name, number: m[3] }
  }
  const n = head.match(/\b(\d{1,4}\/\d{4}\/[A-ZĐ]{1,6}(?:-[A-ZĐ]{1,8})*\d{0,3})\b/u)
  const t = (e.title ?? "").match(new RegExp(`^(${LAW_TYPES})\\b`, "u"))
  return { law: t && n ? `${t[1]} ${n[1]}` : e.title, number: n?.[1] }
}
export const lawDisplay = (r: Pick<ResearchItem, "law" | "number">) =>
  r.law ? `${r.law}${r.number && !r.law.includes(r.number) ? ` ${r.number.split("/")[1] ?? ""} (${r.number})`.replace(/\s+\(/, " (") : ""}` : r.number ?? ""

type Art = { no: string; head: string; text: string }
/** Articles of a law text ("Điều 301. Mức phạt vi phạm …" up to the next Điều / Chương / Mục heading). */
export function splitArticles(text: string): Art[] {
  const re = /(?:^|\n)[ \t]*(?:\*\*)?Điều\s+(\d+[a-zđ]?)\s*[.:]\s*([^\n]*)/giu
  const hits = [...text.matchAll(re)].map((m) => ({ no: m[1].toLowerCase(), head: m[2].replace(/\*\*/g, "").trim(), at: (m.index as number) + (m[0].startsWith("\n") ? 1 : 0) }))
  const out = new Map<string, Art>()
  hits.forEach((h, i) => {
    let end = i + 1 < hits.length ? hits[i + 1].at : text.length
    const tail = text.slice(h.at, end)
    const stop = tail.slice(10).search(/\n[ \t]*(?:Chương|Mục|Phần)\s+[IVXLC\d]+\b/u)
    if (stop >= 0) end = h.at + 10 + stop
    const body = text.slice(h.at, end).trim()
    const prev = out.get(h.no)
    if (!prev || body.length > prev.text.length) out.set(h.no, { no: h.no, head: h.head, text: body.slice(0, 6000) })
  })
  return [...out.values()]
}

const OPENED_SKIP = new Set(["warning", "grounding", "artifact", "safety", "calc"])
const isOpened = (e: Evidence) => !OPENED_SKIP.has(e.source) && !/_search$/.test(e.source)

/** Resolve the sections' legal basis against the evidence of the session → research items + warnings. */
export function buildResearch(sessionID: string, sections: Section[]): { items: ResearchItem[]; warnings: string[] } {
  const ev = loadEvidence(sessionID).filter(isOpened)
  const items: ResearchItem[] = []
  const warnings: string[] = []
  const add = (e: Evidence, article: string | undefined, text: string) => {
    const lw = lawOf(e)
    const k = `${baseUrl(e.url)}|${article ?? ""}`
    let it = items.find((x) => `${baseUrl(x.url)}|${x.article ?? ""}` === k)
    if (!it) {
      it = { id: `R${items.length + 1}`, url: e.url.replace(/#.*$/, ""), title: e.title, ...lw, ...(article ? { article: `Điều ${article}` } : {}), text: text.trim().slice(0, 6000) }
      items.push(it)
    }
    return it.id
  }
  for (const s of sections) {
    const ids = new Set<string>()
    for (const raw of s.legal_basis_urls) {
      const url = raw.match(/https?:\/\/[^\s<>()\]]+/)?.[0]?.replace(/[)>\].,;:!?'"»]+$/, "")
      const arts = [...new Set([...raw.matchAll(/Điều\s+(\d+[a-zđ]?)/giu), ...raw.matchAll(/#dieu-?(\d+[a-zđ]?)/giu)].map((m) => m[1].toLowerCase()))]
      let entries: Evidence[]
      if (url) entries = ev.filter((e) => { const a = baseUrl(e.url), b = baseUrl(url); return a === b || a.startsWith(b) || b.startsWith(a) })
      else {
        // "Điều 301 Luật Thương mại 2005" / "36/2005/QH11" without a link: match by number or law name
        const num = raw.match(/\d{1,4}\/\d{4}\/[A-ZĐ0-9-]+/u)?.[0]
        const rk = normKey(raw.replace(/Điều\s+\d+[a-zđ]?/giu, ""))
        entries = ev.filter((e) => { const lw = lawOf(e); return (num && lw.number === num) || (!!lw.law && rk.includes(normKey(lw.law).replace(/\s+\d{4}$/, ""))) })
      }
      if (!entries.length) {
        warnings.push(`${s.label} (${s.key}): căn cứ "${clip(raw, 120)}" chưa được mở bằng công cụ tra cứu trong phiên này – không đưa vào bộ căn cứ (mở bằng vbpl_article / vbpl_document rồi lập lại dàn ý nếu cần).`)
        continue
      }
      const byLen = [...entries].sort((a, b) => b.text.length - a.text.length)
      if (arts.length) {
        for (const a of arts) {
          let found = false
          for (const e of byLen) {
            const art = splitArticles(e.text).find((x) => x.no === a)
            if (art) { ids.add(add(e, a, art.text)); found = true; break }
          }
          if (!found) warnings.push(`${s.label} (${s.key}): không thấy Điều ${a} trong nội dung đã tra của ${clip(url ?? raw, 100)} – mở điều này bằng vbpl_article.`)
        }
      } else {
        const short = [...entries].sort((a, b) => a.text.length - b.text.length)[0]
        if (short.text.length <= 9000) ids.add(add(short, splitArticles(short.text)[0]?.no, short.text))
        else {
          // whole law without an article: pick the 2 articles closest to the section's topic
          const want = sigWords(`${s.heading} ${s.purpose} ${s.must_include.join(" ")}`)
          const scored = splitArticles(byLen[0].text).map((a) => {
            // heading words count triple; general articles (Điều 1–4: scope, definitions) only via their heading
            const h = sigWords(a.head), w = sigWords(a.text.slice(0, 1500))
            let hit = 0
            for (const x of want) hit += h.has(x) ? 3 : w.has(x) && !/^[1-4]$/.test(a.no) ? 1 : 0
            return { a, score: hit }
          }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score).slice(0, 2)
          if (!scored.length) warnings.push(`${s.label} (${s.key}): ${clip(url ?? raw, 100)} là cả văn bản – nêu rõ "Điều N" trong legal_basis_urls.`)
          for (const x of scored) ids.add(add(byLen[0], x.a.no, x.a.text))
          if (scored.length) warnings.push(`${s.label} (${s.key}): ${clip(url ?? raw, 80)} không nêu Điều – đã tự chọn ${scored.map((x) => `Điều ${x.a.no}`).join(", ")} theo chủ đề; nên ghi rõ "URL Điều N".`)
        }
      }
    }
    s.research = [...ids]
  }
  return { items, warnings }
}

// ---------- plan ----------
export type PlanInput = {
  title: string
  title_en?: string
  kind: Kind
  language?: Lang
  prevailing?: "vi" | "en"
  brief: string
  user_side?: string
  sections: SectionInput[]
  glossary?: GlossaryItem[]
  parties?: Party[]
  facts?: Record<string, unknown>
  style?: { detail?: string; words_per_section?: number; notes?: string }
  model?: string
}
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/
const KEY_CLAUSE = /thanh toan|gia |gia$|phat|boi thuong|cham dut|tranh chap|bat kha khang|doc quyen|chi tieu|doanh so|giao hang|giao nhan|bao hanh|bao mat|doi tuong|quyen va nghia vu|nghia vu|thu lao|hoa hong|so huu tri tue|nhan hieu|luat ap dung|payment|price|penalt|damages|terminat|dispute|force majeure|exclusiv|target|deliver|warrant|confidential|obligation|commission/
const HEAD_NUM = /^\s*(?:#+\s*)?(?:\*\*)?\s*(điều|article|phụ\s*lục|appendix|annex|mục|section|phần|part)\s+([\dIVXLC]+)\s*[.:\-–)]?\s*/iu
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 }

export function createPlan(sessionID: string, input: PlanInput): { draft?: Draft; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const kind = input.kind
  const language: Lang = input.language ?? "vi"
  const secs = input.sections ?? []
  if (!input.title?.trim()) errors.push("Thiếu `title`.")
  if (!secs.length) errors.push("`sections` rỗng – cần ít nhất 1 mục.")
  if (secs.length > 40) errors.push(`Tối đa 40 mục (đang có ${secs.length}) – gộp bớt các điều nhỏ hoặc đưa chi tiết vào phụ lục.`)
  const seen = new Set<string>(), seenHead = new Map<string, string>()
  let art = 0, annex = 0, part = 0, sawAnnex = false
  const sections: Section[] = []
  secs.forEach((x, i) => {
    const pos = `mục thứ ${i + 1}`
    // keys are normalised ("Chỉ-tiêu Doanh số" → "chi-tieu-doanh-so"); only an empty / duplicate key is an error
    const key = normKey(String(x.key ?? "")).replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
    if (!KEY_RE.test(key)) errors.push(`${pos}: key "${key}" không hợp lệ (chữ thường không dấu, số, "-" / "_", ≤ 40 ký tự; VD "thanh-toan").`)
    else if (seen.has(key)) errors.push(`${pos}: key "${key}" bị trùng.`)
    seen.add(key)
    const rawHead = String(x.heading ?? "").trim()
    const m = rawHead.match(HEAD_NUM)
    const word = m ? normKey(m[1]) : ""
    const isAnnex = /^(phu luc|appendix|annex)$/.test(word)
    const heading = rawHead.replace(HEAD_NUM, "").replace(/^\s*[.:\-–]\s*/, "").trim()
    if (!heading) errors.push(`${pos} (${key}): thiếu tên tiêu đề (VD "Thanh toán").`)
    const hk = (isAnnex ? "annex:" : "") + normKey(heading) // an annex may share the name of its Điều
    if (hk && seenHead.has(hk)) errors.push(`${pos} (${key}): tiêu đề "${heading}" trùng với mục "${seenHead.get(hk)}" – mỗi nội dung chỉ quy định một lần.`)
    seenHead.set(hk, key)
    let type: Section["type"], no: number, label: string
    if (isAnnex) { type = "annex"; no = ++annex; label = language === "en" ? `Appendix ${no}` : `Phụ lục ${no}`; sawAnnex = true }
    else if (kind === "hop-dong") {
      if (sawAnnex) errors.push(`${pos} (${key}): Điều "${heading}" đứng sau Phụ lục – đặt mọi Điều trước các Phụ lục.`)
      type = "article"; no = ++art; label = language === "en" ? `Article ${no}` : `Điều ${no}`
    } else { type = "part"; no = ++part; label = language === "en" ? `Section ${no}` : `Mục ${no}` }
    if (m) {
      const given = /^\d+$/.test(m[2]) ? Number(m[2]) : ROMAN[m[2].toLowerCase()] ?? NaN
      if (given !== no) errors.push(`${pos} (${key}): tiêu đề ghi số ${m[2]} nhưng theo thứ tự phải là ${label} – đánh số liên tục 1..N theo đúng thứ tự (hoặc bỏ số, công cụ tự đánh).`)
    }
    const must = (x.must_include ?? []).map((s) => String(s).trim()).filter(Boolean)
    if (!must.length && type !== "part" && KEY_CLAUSE.test(` ${normKey(heading)} `)) errors.push(`${pos} (${key}) "${heading}" là điều khoản chủ yếu – \`must_include\` không được rỗng (liệt kê các nội dung bắt buộc phải có).`)
    else if (!must.length && !isDefinitions(heading)) warnings.push(`${label} "${heading}": must_include rỗng – người soạn chỉ dựa vào purpose.`)
    sections.push({
      key, heading, ...(x.heading_en ? { heading_en: String(x.heading_en).replace(HEAD_NUM, "").trim() } : {}),
      purpose: String(x.purpose ?? "").trim(), must_include: must, legal_basis_urls: (x.legal_basis_urls ?? []).map(String).filter(Boolean),
      ...(x.words ? { words: Math.max(80, Math.min(2500, Number(x.words))) } : {}),
      type, no, label, research: [], status: "pending",
    })
  })
  const glossary = (input.glossary ?? []).filter((g) => g?.term?.trim()).map((g) => ({ term: g.term.trim().replace(/^["“]|["”]$/g, ""), definition: String(g.definition ?? "").trim(), ...(g.en ? { en: g.en.trim() } : {}) }))
  const gk = new Set<string>()
  for (const g of glossary) {
    if (gk.has(g.term.toLowerCase())) errors.push(`Thuật ngữ "${g.term}" định nghĩa hai lần trong glossary.`)
    gk.add(g.term.toLowerCase())
    if (!g.definition) warnings.push(`Thuật ngữ "${g.term}" chưa có định nghĩa.`)
    if (language === "bilingual" && !g.en) warnings.push(`Thuật ngữ "${g.term}" chưa có bản tiếng Anh (en) – người soạn sẽ tự dịch.`)
  }
  if (glossary.length && kind === "hop-dong" && !sections.some((s) => isDefinitions(s.heading))) warnings.push("Có glossary nhưng không có điều \"Giải thích từ ngữ\" – nên thêm (thường là Điều 1).")
  const parties = (input.parties ?? []).map((p, i) => ({ role: String(p.role ?? "").trim(), short: (p.short ?? `Bên ${String.fromCharCode(65 + i)}`).trim(), name_placeholder: p.name_placeholder ?? "…", ...(p.role_en ? { role_en: p.role_en } : {}) }))
  if (kind === "hop-dong" && parties.length < 2) errors.push("Hợp đồng cần `parties` (ít nhất 2 bên: role + name_placeholder, VD {role:'Bên giao đại lý', name_placeholder:'CÔNG TY …'}).")
  if (errors.length) return { errors, warnings }

  const draftId = `d-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex")}`
  const d: Draft = {
    draftId, sessionID: sessionID || "no-session", title: input.title.trim(), ...(input.title_en ? { title_en: input.title_en.trim() } : {}),
    kind, language, ...(language === "bilingual" ? { prevailing: input.prevailing ?? "vi" } : {}),
    brief: String(input.brief ?? "").trim(), ...(input.user_side ? { user_side: input.user_side } : {}),
    sections, glossary, parties, facts: input.facts ?? {}, style: input.style ?? {}, research: [],
    model: input.model || "", phase: "plan", round: 0, startedAt: Date.now(), updatedAt: Date.now(), timings: {}, warnings: [],
  }
  const r = buildResearch(d.sessionID, sections)
  d.research = r.items
  warnings.push(...r.warnings)
  if (kind === "hop-dong" && sections.some((s) => s.legal_basis_urls.length) && !sections.some((s) => s.legal_basis_urls.some((u) => /Điều\s+\d|#dieu-?\d/iu.test(u))))
    return { errors: ["legal_basis_urls chỉ có link cả văn bản, không nêu Điều nào. Ghi rõ từng căn cứ dạng 'https://vbpl.vn/… Điều 301' (hoặc '… Điều 300, 301') cho các điều khoản chủ yếu – mỗi Điều đã được mở bằng vbpl_article trong phiên – rồi gọi lại draft_plan."], warnings }
  if (kind === "hop-dong" && !r.items.length)
    return { errors: ["Chưa có căn cứ pháp lý nào đã tra trong phiên này cho các điều (legal_basis_urls). Tra cứu trước bằng vbpl_find → vbpl_article (Điều cụ thể), rồi ghi 'URL Điều N' vào legal_basis_urls của các điều khoản chủ yếu."], warnings }
  d.warnings = warnings
  return { draft: d, errors: [], warnings }
}

export function planSummary(d: Draft) {
  const lines = d.sections.map((s) => `- ${s.label}. ${s.heading} [${s.key}]${s.research.length ? ` – căn cứ: ${s.research.join(", ")}` : ""}`)
  const res = d.research.map((r) => `- ${r.id}: ${lawDisplay(r) || r.title || r.url}${r.article ? ` – ${r.article}` : ""}`)
  return [
    `Đã lập dàn ý dự thảo "${d.title}" (mã dự thảo: ${d.draftId}; ${d.kind}; ${d.language === "bilingual" ? "song ngữ Việt – Anh" : d.language === "en" ? "tiếng Anh" : "tiếng Việt"}): ${d.sections.length} mục, ${d.glossary.length} thuật ngữ, ${d.research.length} đoạn căn cứ.`,
    ...lines,
    d.research.length ? "Bộ căn cứ (người soạn chỉ được dẫn các đoạn này):" : "",
    ...res,
    d.warnings.length ? "Lưu ý:" : "",
    ...d.warnings.map((w) => `- ${w}`),
    `BƯỚC TIẾP THEO: gọi draft_write({draftId:"${d.draftId}"}).`,
  ].filter(Boolean).join("\n")
}

// ---------- prompts ----------
const DETAIL_WORDS: Record<string, number> = { "ngắn": 180, "chuẩn": 300, "chi tiết": 450, "rất chi tiết": 650 }
function targetWords(d: Draft, s: Section) {
  if (s.words) return s.words
  if (d.style.words_per_section) return d.style.words_per_section
  const base = DETAIL_WORDS[normKey(d.style.detail ?? "chi tiết").replace(/^chi tiet$/, "chi tiết")] ?? DETAIL_WORDS[d.style.detail ?? ""] ?? 450
  return s.type === "annex" ? Math.round(base * 0.9) : isDefinitions(s.heading) ? Math.max(base, d.glossary.length * 35) : base
}
export const headingLine = (d: Draft, s: Section, lang: "vi" | "en" = "vi") => {
  if (lang === "en") {
    const w = s.type === "annex" ? "Appendix" : s.type === "article" ? "Article" : ""
    return `## ${w ? `${w} ${s.no}. ` : `${s.no}. `}${s.heading_en || s.heading}`
  }
  if (d.language === "en") return headingLine(d, s, "en")
  const w = s.type === "annex" ? "Phụ lục" : s.type === "article" ? "Điều" : ""
  return `## ${w ? `${w} ${s.no}. ` : `${s.no}. `}${s.heading}`
}

function systemPrompt(d: Draft) {
  const en = d.language === "en", bi = d.language === "bilingual"
  const docWord = d.kind === "hop-dong" ? "hợp đồng" : d.kind === "bao-cao" ? "báo cáo" : "văn bản"
  return [
    `Bạn là luật sư soạn thảo ${docWord} thương mại Việt Nam trong một NHÓM SOẠN THẢO chuyên nghiệp. Mỗi người viết MỘT ${d.kind === "hop-dong" ? "Điều / Phụ lục" : "mục"}; trưởng nhóm đã lập dàn ý, bảng thuật ngữ, thông tin các bên và bộ căn cứ pháp lý. Bạn chỉ viết đúng phần được giao, đầy đủ, chặt chẽ, dùng được ngay.`,
    "QUY TẮC BẮT BUỘC:",
    `1. Chỉ trả về nội dung markdown của phần được giao, dòng đầu là ĐÚNG dòng tiêu đề được cho. Không lời dẫn, không giải thích, không tiêu đề phụ (#), không bảng mục lục.`,
    `2. Khoản đánh số "1. ", "2. ", … mỗi khoản một đoạn; điểm "a) ", "b) ", "c) ", "d) ", "đ) ", "e) " … mỗi điểm một dòng riêng dưới khoản. Đánh số khoản liên tục 1, 2, 3 … trong cả Điều, không bao giờ đánh lại từ 1 giữa chừng; khoản cần chia nhỏ thì dùng "2.1.", "2.2." hoặc điểm a), b). Không dùng kiểu "5.1" cho khoản, không in đậm số khoản, không đặt tên riêng cho từng khoản. Bảng markdown được phép (VD chỉ tiêu, bảng giá) khi phù hợp.`,
    `3. Gọi các bên đúng tên viết tắt đã cho (VD "Bên A", "Bên B") và dùng ĐÚNG các thuật ngữ trong bảng thuật ngữ, viết hoa đúng như bảng. Không tự định nghĩa thuật ngữ mới (không viết “X” là/có nghĩa là …) ngoài điều Giải thích từ ngữ; không viết hoa kiểu thuật ngữ cho cụm từ không có trong bảng.`,
    `4. Thông tin chưa biết (tên, địa chỉ, số tiền, ngày, số lượng) để "…"; điểm có nhiều lựa chọn thương mại thì nêu phương án hợp lý có lợi cho bên người dùng rồi ghi "[cần thương lượng]". Không bịa số liệu không có trong "Thông tin đã biết", trừ mức giới hạn luật định có trong bộ căn cứ.`,
    `5. Căn cứ pháp lý: CHỈ được dẫn các văn bản / điều luật có trong "BỘ CĂN CỨ" của phần này (VD "theo Điều 301 Luật Thương mại 2005"). Nếu bộ căn cứ trống thì không dẫn điều luật nào. Trích nguyên văn thì phải chép ĐÚNG từng chữ trong ngoặc kép; tốt nhất là diễn đạt lại không cần trích. Không đưa đường link.`,
    `6. Dẫn chiếu nội bộ chỉ tới các Điều / Phụ lục có trong DÀN Ý, đúng số và đúng nội dung (VD "theo Điều 8 Hợp đồng này"). Không lặp lại nội dung thuộc điều khác trong dàn ý – dẫn chiếu tới điều đó.`,
    `7. Bảo vệ quyền lợi của bên người dùng nhưng cân bằng, hợp pháp để đối tác có thể chấp nhận. Mức phạt vi phạm, lãi chậm trả, bồi thường phải phù hợp giới hạn luật định trong bộ căn cứ. Các con số (tỷ lệ phạt, thời hạn) phải thống nhất với "Thông tin đã biết".`,
    en || bi
      ? `8. Văn phong tiếng Anh pháp lý ("shall", "the Parties", "Party A"); giữ nguyên số hiệu văn bản Việt Nam; tên luật dịch chuẩn (Commercial Law, Civil Code).`
      : `8. Văn phong hợp đồng tiếng Việt trang trọng, chính xác ("Bên A có nghĩa vụ …", "trong thời hạn … ngày kể từ ngày …"), câu rõ chủ thể – hành vi – thời hạn – hậu quả.`,
    bi
      ? `9. SONG NGỮ: viết bản tiếng Việt, rồi bản tiếng Anh tương ứng CÙNG CẤU TRÚC (cùng số khoản, cùng điểm, cùng thứ tự, cùng con số). Định dạng trả về đúng như sau:\n=== VI ===\n<dòng tiêu đề tiếng Việt>\n<nội dung tiếng Việt>\n=== EN ===\n<dòng tiêu đề tiếng Anh>\n<nội dung tiếng Anh>`
      : "",
  ].filter(Boolean).join("\n")
}

function contextBlock(d: Draft, s: Section) {
  const en = d.language === "en"
  const parties = d.parties.map((p) => `- ${p.short} = ${p.role}${p.role_en ? ` (${p.role_en})` : ""}: ${p.name_placeholder ?? "…"}`).join("\n")
  const gl = d.glossary.map((g) => `- “${g.term}”${g.en ? ` / “${g.en}”` : ""}: ${g.definition}`).join("\n")
  const facts = Object.entries(d.facts ?? {}).map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")
  const outline = d.sections.map((x) => `${x.key === s.key ? "→ " : "  "}${x.label}. ${x.heading}${x.purpose ? ` — ${clip(x.purpose, 140)}` : ""}${x.key === s.key ? "   ← PHẦN BẠN VIẾT" : ""}`).join("\n")
  const pack = s.research.map((id) => d.research.find((r) => r.id === id)).filter(Boolean) as ResearchItem[]
  const packText = pack.map((r) => `[${r.id}] ${lawDisplay(r) || r.title || r.url}${r.article ? ` – ${r.article}` : ""}\n${r.text}`).join("\n\n")
  return [
    `VĂN BẢN: ${d.title}${d.title_en ? ` / ${d.title_en}` : ""} (${d.kind}${en ? ", tiếng Anh" : d.language === "bilingual" ? ", song ngữ Việt – Anh" : ""})`,
    d.user_side ? `BÊN NGƯỜI DÙNG (bảo vệ quyền lợi bên này): ${d.user_side}` : "",
    d.brief ? `YÊU CẦU CHUNG: ${d.brief}` : "",
    parties ? `CÁC BÊN:\n${parties}` : "",
    gl ? `BẢNG THUẬT NGỮ (dùng đúng, viết hoa đúng):\n${gl}` : "",
    facts ? `THÔNG TIN ĐÃ BIẾT:\n${facts}` : "",
    d.style.notes ? `PHONG CÁCH: ${d.style.notes}` : "",
    `DÀN Ý TOÀN VĂN BẢN:\n${outline}`,
    `BỘ CĂN CỨ CỦA PHẦN NÀY (chỉ được dẫn các đoạn này):\n${packText || "(trống – không dẫn điều luật nào)"}`,
  ].filter(Boolean).join("\n\n")
}

function assignment(d: Draft, s: Section) {
  const bi = d.language === "bilingual"
  const defs = isDefinitions(s.heading) && d.glossary.length
  return [
    `PHẦN ĐƯỢC GIAO: ${headingLine(d, s)}${bi ? `  |  tiếng Anh: ${headingLine(d, s, "en")}` : ""}`,
    s.purpose ? `Mục đích: ${s.purpose}` : "",
    s.must_include.length ? `Phải có đủ:\n${s.must_include.map((m) => `- ${m}`).join("\n")}` : "",
    defs ? "Đây là điều Giải thích từ ngữ: định nghĩa LẦN LƯỢT mọi thuật ngữ trong bảng thuật ngữ (mỗi thuật ngữ một khoản, dạng: 1. “Thuật ngữ” là …); chỉ thêm thuật ngữ ngoài bảng khi thật cần thiết (thuật ngữ thêm sẽ được đưa vào bảng cho các điều khác)." : "",
    `Độ dài mục tiêu: khoảng ${targetWords(d, s)} từ${bi ? " cho mỗi ngôn ngữ" : ""} (đủ chi tiết, không lan man).`,
    bi ? "Trả về theo đúng định dạng === VI === / === EN ===." : "Viết ngay nội dung, bắt đầu bằng dòng tiêu đề.",
  ].filter(Boolean).join("\n")
}

// ---------- output post-processing ----------
function cleanBody(raw: string, no: number): string {
  let t = raw.replace(/^\s*```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim()
  const lines = t.split("\n")
  // leading heading / title lines ("## Điều 5. …", "**Điều 5. …**", "Điều 5. …")
  while (lines.length && (!lines[0].trim() || /^\s*#{1,6}\s/.test(lines[0]) || /^\s*(?:\*\*)?\s*(?:điều|article|phụ\s*lục|appendix|annex|mục|section)\s+[\dIVXLC]+\s*[.:\-–]/iu.test(lines[0]))) lines.shift()
  t = lines
    .map((l) => l
      .replace(/^#{1,6}\s+(.+?)\s*#*$/, "**$1**")
      .replace(/^(\s*)\*\*(\d{1,2})\.\*\*\s*/, "$1$2. ")
      .replace(/^(\s*)\*\*(?:Khoản|Clause)\s+(\d{1,2})[.:]?\*\*[.:]?\s*/iu, "$1$2. ")
      .replace(new RegExp(`^(\\s*)${no}\\.(\\d{1,2})\\.?\\s+`), "$1$2. "))
    .join("\n")
  t = t.replace(/(?<!\.)\.{3,}(?!\.)/g, "…").replace(/\[\s*[Cc]ần thương lượng\s*\]|\(\s*[Cc]ần thương lượng\s*\)|\[\s*CẦN THƯƠNG LƯỢNG\s*\]/g, "[cần thương lượng]")
  t = t.replace(/\[\s*to be negotiated\s*\]|\(\s*to be negotiated\s*\)/gi, "[to be negotiated]")
  return nestRestarts(t.replace(/\n{3,}/g, "\n\n").trim())
}

/**
 * Writers sometimes restart numbering inside a khoản ("2. Khu vực" → "1. …", "2. …" → "3. …"). Such a restarted
 * run becomes sub-khoản "2.1.", "2.2." of the enclosing khoản (the writer's intent; "theo điểm 2.1" references
 * then match) so the khoản sequence 1, 2, 3 … stays continuous. Indented (nested markdown) lists are left alone.
 */
export function nestRestarts(body: string): string {
  const lines = body.split("\n")
  let expected = 1, sub = 0, subNext = 1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*\|/.test(l) || DIEM.test(l)) continue
    const m = l.match(/^(\d{1,2})\.\s+(\S.*)$/)
    if (!m || /^\d{1,3}\.\d{3}/.test(l)) continue
    const n = Number(m[1])
    // "3." may continue the sub-run (2.3) or the khoản sequence (3): a short title-like line is a khoản
    const titleLike = m[2].split(/\s+/).length <= 10 && !/[.:;,]$/.test(m[2].trim())
    if (sub && n === subNext && !(n === expected && titleLike)) { lines[i] = `${sub}.${n}. ${m[2]}`; subNext++; continue }
    if (n === expected) { expected++; sub = 0; continue }
    if (n === 1 && expected > 1) { sub = expected - 1; subNext = 2; lines[i] = `${sub}.1. ${m[2]}`; continue }
  }
  return lines.join("\n")
}
function enHeadingFrom(raw: string): string | undefined {
  const first = raw.split("\n").find((l) => l.trim())
  const m = first?.replace(/^\s*#+\s*/, "").replace(/\*\*/g, "").match(/^(?:article|appendix|annex|section)?\s*\d+\s*[.:\-–]\s*(.+)$/i)
  return m?.[1]?.trim()
}
function splitBilingual(raw: string): { vi: string; en: string } | null {
  const m = raw.match(/===\s*VI\s*===\s*\n([\s\S]*?)\n\s*===\s*EN\s*===\s*\n([\s\S]*)$/i)
  return m ? { vi: m[1].trim(), en: m[2].trim() } : null
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/u
const CJK_G = /[぀-ヿ㐀-鿿가-힯]+/gu
const KHOAN = /^\s*(\d{1,2})\.\s+\S/
const DIEM = /^\s*[-*]?\s*([a-zđ])\)\s+\S/
const DIEM_ORDER = "a b c d đ e g h i k l m n o p q r s t u v x y".split(" ")
const EN_ORDER = "a b c d e f g h i j k l m n o p q r s t u v w x y z".split(" ")
/** Khoản numbers and the điểm letters under each khoản. */
function structure(body: string) {
  const khoan: number[] = []
  const diem: string[][] = [[]]
  for (const l of body.split("\n")) {
    if (/^\s*\|/.test(l)) continue
    if (/^\s*\d{1,2}\.\d{1,2}\.?\s+\S/.test(l) && !/^\s*\d{1,3}\.\d{3}/.test(l)) { diem.push([]); continue } // sub-khoản "2.1." – own điểm list
    const k = l.match(KHOAN)
    if (k && !/^\s*\d{1,3}(?:\.\d{3})+/.test(l)) { khoan.push(Number(k[1])); diem.push([]); continue }
    const dm = l.match(DIEM)
    if (dm) diem[diem.length - 1].push(dm[1])
  }
  return { khoan, diem }
}

// ---------- deterministic checks ----------
type Texts = Map<string, { vi: string; en?: string }>
export function loadTexts(d: Draft): Texts {
  const m: Texts = new Map()
  for (const s of d.sections) m.set(s.key, { vi: sectionText(d, s.key, "vi"), ...(d.language === "bilingual" ? { en: sectionText(d, s.key, "en") } : {}) })
  return m
}

const LAW_MENTION = new RegExp(`(${LAW_TYPES})\\s+((?:\\p{Lu}[\\p{Ll}\\p{M}]*)(?:\\s+[\\p{Ll}\\p{M}]+){0,6})`, "gu")
const LAW_STOP = new Set("số năm và của tại theo về quy hiện có được này đã sửa đổi bổ sung hợp nhất thì khi nếu để cho với trong các mọi là hoặc sẽ phải ngày không".split(" "))
function lawMentions(text: string): { name: string; at: number }[] {
  const out: { name: string; at: number }[] = []
  for (const m of text.matchAll(LAW_MENTION)) {
    const words = m[2].split(/\s+/)
    const keep: string[] = []
    for (const w of words) { if (keep.length && LAW_STOP.has(w.toLowerCase())) break; keep.push(w) }
    const name = `${m[1]} ${keep.join(" ")}`.trim()
    if (/việt nam|nước ngoài|quốc tế|này/i.test(keep.join(" ")) && keep.length <= 2) continue
    out.push({ name, at: m.index as number })
  }
  return out
}
const packLawKeys = (d: Draft) => [...new Set(d.research.map((r) => normKey(r.law ?? "")).filter(Boolean))]
const lawInPack = (d: Draft, name: string) => {
  const k = normKey(name)
  return packLawKeys(d).some((p) => p === k || p.startsWith(k + " ") || k.startsWith(p + " ") || p.startsWith(k))
}
function packHasArticle(d: Draft, lawName: string | undefined, no: string) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:\\*\\*)?Điều\\s+${no}\\s*[.:]`, "u")
  return d.research.some((r) => (!lawName || lawInPack({ ...d, research: [r] } as Draft, lawName)) && (r.article === `Điều ${no}` || re.test(r.text)))
}
function quotesOf(text: string): string[] {
  const q = new Set<string>()
  for (const m of text.matchAll(/“([^“”\n]{30,600})”|«([^«»\n]{30,600})»/g)) q.add((m[1] ?? m[2]).trim())
  for (const line of text.split("\n")) {
    // straight quotes pair up left to right on a line ("A" là … "B" is not one long quote)
    const parts = line.split('"')
    if (parts.length >= 3 && parts.length % 2 === 1) for (let i = 1; i < parts.length; i += 2) if (parts[i].trim().length >= 30 && parts[i].length <= 600) q.add(parts[i].trim())
    const b = line.match(/^\s*>\s*(.+)$/)?.[1]?.replace(/^[*_"“«]+|[*_"”»]+$/g, "").trim()
    if (b && b.length >= 30) q.add(b)
  }
  return [...q]
}
const quoteOk = (corpus: string, q: string) => {
  const nq = norm(q).replace(/^["']|["']$/g, "")
  return corpus.includes(nq) || (nq.length > 80 && corpus.includes(nq.slice(0, 80)) && corpus.includes(nq.slice(-60)))
}

/** Citation problems of one section (also used right after writing to trigger a rewrite). */
export function citationIssues(d: Draft, s: Section, text: string, lang: "vi" | "en" = "vi"): Omit<Issue, "id" | "status">[] {
  const out: Omit<Issue, "id" | "status">[] = []
  const pack = s.research.map((id) => d.research.find((r) => r.id === id)).filter(Boolean) as ResearchItem[]
  const all = norm(d.research.map((r) => r.text).join("\n"))
  for (const q of quotesOf(text)) {
    if (!quoteOk(all, q)) out.push({ section: s.key, severity: "lỗi", code: "quote-not-in-pack", source: "auto", lang, message: `Đoạn trích "${clip(q, 140)}" không có nguyên văn trong bộ căn cứ đã tra.`, suggested_fix: "Chép đúng nguyên văn từ bộ căn cứ hoặc diễn đạt lại không dùng ngoặc kép." })
  }
  if (lang === "vi") {
    const seen = new Set<string>()
    for (const m of lawMentions(text)) {
      const k = normKey(m.name)
      if (seen.has(k)) continue
      seen.add(k)
      if (!lawInPack(d, m.name)) out.push({ section: s.key, severity: "cảnh báo", code: "law-not-in-pack", source: "auto", lang, message: `Dẫn "${m.name}" nhưng văn bản này không có trong bộ căn cứ đã tra.`, suggested_fix: `Bỏ dẫn chiếu tới ${m.name} hoặc chỉ dẫn các văn bản trong bộ căn cứ${pack.length ? ` (${[...new Set(pack.map((r) => r.law).filter(Boolean))].join(", ")})` : ""}.` })
    }
  }
  const ids = [...new Set([...text.matchAll(/\b\d{1,4}\/\d{4}\/[A-ZĐ]{1,6}(?:-[A-ZĐ]{1,8})*\d{0,3}\b/gu)].map((m) => m[0]))]
  for (const id of ids) if (!all.includes(norm(id))) out.push({ section: s.key, severity: "cảnh báo", code: "id-not-in-pack", source: "auto", lang, message: `Số hiệu ${id} không có trong bộ căn cứ đã tra.`, suggested_fix: "Bỏ số hiệu hoặc dùng văn bản có trong bộ căn cứ." })
  return out
}

/** Internal / external references ("khoản 2 Điều 5", "Điều 301 Luật Thương mại", "Phụ lục 1", "Article 7"). */
function referenceIssues(d: Draft, s: Section, text: string, lang: "vi" | "en", struct: Map<string, { khoan: number }>): Omit<Issue, "id" | "status">[] {
  const out: Omit<Issue, "id" | "status">[] = []
  const arts = d.sections.filter((x) => x.type === "article")
  const annexes = d.sections.filter((x) => x.type === "annex")
  const byNo = new Map(arts.map((x) => [x.no, x]))
  const here = struct.get(s.key)?.khoan ?? 0
  const seen = new Set<string>()
  const push = (i: Omit<Issue, "id" | "status">) => { const k = i.code + i.message; if (!seen.has(k)) { seen.add(k); out.push(i) } }
  if (lang === "vi") {
    for (const m of text.matchAll(/(?:khoản\s+(\d+)(?:\s*(?:,|và)\s*(?:khoản\s+)?\d+)*[ \t]+)?Điều[ \t]+(\d+|này)\b/giu)) {
      const at = m.index as number, end = at + m[0].length
      const after = text.slice(end, end + 90), before = text.slice(Math.max(0, at - 110), at)
      if (/^này$/i.test(m[2])) {
        if (m[1] && Number(m[1]) > here) push({ section: s.key, severity: "lỗi", code: "xref-missing-khoan", source: "auto", lang, message: `"${m[0]}" – ${s.label} chỉ có ${here} khoản.`, suggested_fix: "Sửa số khoản dẫn chiếu cho đúng." })
        continue
      }
      const n = Number(m[2])
      const extAfter = new RegExp(`^\\s*(?:của\\s+|tại\\s+)?(?:${LAW_TYPES}|BLDS|LTM|Công ước|Hiến pháp|CISG|Incoterms)\\b`, "iu").test(after) || /^\s*\d+\/\d{4}\//.test(after)
      const internalExplicit = /^\s*(?:của\s+)?(?:Hợp đồng|Phụ lục)\b/u.test(after)
      const lawBefore = lawMentions(before.split(/[.;\n]/).pop() ?? "").length > 0
      if (extAfter || (!internalExplicit && lawBefore && !byNo.has(n))) {
        const lm = lawMentions(after.replace(/^\s*(?:của|tại)\s+/u, ""))[0]
        if (lm && lawInPack(d, lm.name) && !packHasArticle(d, lm.name, String(n)))
          push({ section: s.key, severity: "cảnh báo", code: "article-not-in-pack", source: "auto", lang, message: `Dẫn Điều ${n} ${lm.name} nhưng điều này không có trong bộ căn cứ đã tra.`, suggested_fix: `Chỉ dẫn các điều có trong bộ căn cứ, hoặc bỏ số điều.` })
        continue
      }
      const target = byNo.get(n)
      if (!target) { push({ section: s.key, severity: "lỗi", code: "xref-missing", source: "auto", lang, message: `Dẫn chiếu tới Điều ${n} nhưng văn bản chỉ có ${arts.length} Điều.`, suggested_fix: "Sửa số Điều dẫn chiếu cho đúng điều có nội dung tương ứng trong dàn ý." }); continue }
      if (m[1]) {
        const k = struct.get(target.key)?.khoan ?? 0
        if (k && Number(m[1]) > k) push({ section: s.key, severity: "lỗi", code: "xref-missing-khoan", source: "auto", lang, message: `"${m[0]}" – ${target.label} (${target.heading}) chỉ có ${k} khoản.`, suggested_fix: "Sửa số khoản dẫn chiếu." })
      }
      // topic given with the reference: "Điều 7 (Thanh toán)", "Điều 7 về thanh toán"
      const topic = after.match(/^\s*(?:Hợp đồng này\s*)?(?:\(([^)]{3,60})\)|về\s+([^,.;\n]{3,50}))/u)
      const tp = topic?.[1] ?? topic?.[2]
      if (tp && !/hợp đồng này/i.test(tp)) {
        const want = sigWords(tp), have = sigWords(`${target.heading} ${target.purpose}`)
        let hit = 0
        for (const w of want) if (have.has(w)) hit++
        if (want.size && !hit) push({ section: s.key, severity: "lỗi", code: "xref-wrong-topic", source: "auto", lang, message: `"${m[0]} ${clip(tp, 40)}" – nhưng ${target.label} là "${target.heading}".`, suggested_fix: `Dẫn chiếu tới đúng Điều quy định "${tp}".` })
      }
    }
    for (const m of text.matchAll(/Phụ lục[ \t]+(số[ \t]+)?(\d+|[IVX]+)\b/gu)) {
      const n = /^\d+$/.test(m[2]) ? Number(m[2]) : ROMAN[m[2].toLowerCase()] ?? 0
      if (!annexes.some((a) => a.no === n)) push({ section: s.key, severity: "lỗi", code: "xref-annex-missing", source: "auto", lang, message: `Dẫn chiếu tới ${m[0]} nhưng văn bản có ${annexes.length} Phụ lục.`, suggested_fix: annexes.length ? `Dẫn đúng Phụ lục (${annexes.map((a) => `${a.label}: ${a.heading}`).join("; ")}).` : "Bỏ dẫn chiếu Phụ lục hoặc đưa nội dung vào điều khoản." })
    }
  } else {
    for (const m of text.matchAll(/(?:(?:clause|paragraph)\s+(\d+)\s+of\s+)?Article[ \t]+(\d+)\b/gi)) {
      const end = (m.index as number) + m[0].length
      if (/^\s*(?:of\s+(?:the\s+)?(?:Commercial Law|Civil Code|Law|Code|Decree|Circular|Convention|CISG|Vietnamese)|,?\s*(?:Commercial Law|Civil Code|Law No|Decree))/i.test(text.slice(end, end + 60))) continue
      const n = Number(m[2]), target = byNo.get(n)
      if (!target) push({ section: s.key, severity: "lỗi", code: "xref-missing", source: "auto", lang, message: `(EN) reference to Article ${n}, but the document has ${arts.length} Articles.`, suggested_fix: "Fix the article number." })
      else if (m[1]) {
        const k = struct.get(target.key)?.khoan ?? 0
        if (k && Number(m[1]) > k) push({ section: s.key, severity: "lỗi", code: "xref-missing-khoan", source: "auto", lang, message: `(EN) "${m[0]}" – ${target.label} has ${k} clauses.`, suggested_fix: "Fix the clause number." })
      }
    }
    for (const m of text.matchAll(/(?:Appendix|Annex)[ \t]+(\d+|[IVX]+)\b/g)) {
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : ROMAN[m[1].toLowerCase()] ?? 0
      if (!annexes.some((a) => a.no === n)) push({ section: s.key, severity: "lỗi", code: "xref-annex-missing", source: "auto", lang, message: `(EN) reference to ${m[0]}, but the document has ${annexes.length} appendices.`, suggested_fix: "Fix the appendix reference." })
    }
  }
  return out
}

const TITLE_PHRASE = /(?<=[\p{Ll}\p{N},;:)]\s)(\p{Lu}[\p{Ll}\p{M}]+(?:\s+\p{Lu}[\p{Ll}\p{M}]+){1,4})/gu
const PROPER_START = new Set("Bên Điều Luật Bộ Nghị Thông Phụ Việt Nhà Ngân Tòa Trung Ủy Cộng Công Quốc Chính Sở Cục Hà Hồ Thành Tỉnh Hội Viện Phòng Văn Đà Hải Cần Bình Đồng Long Quảng Thừa Khánh Lâm Kiên Tây Đông Nam Bắc Châu Liên Hoa Nhật Hàn Trọng Giám Tổng Chủ Phó Kế Thủ Hiến Pháp Incoterms Party Article Appendix".split(" "))
const NON_ASCII = /[^\x20-\x7e]/u
const SENTENCE_START = new Set("Việc Nếu Trường Trong Khi Các Mọi Mỗi Tại Theo Sau Trước Đối Với Để Do Vì Tuy Ngoài Trừ Hai Một Những Bất Kể Mặc Nhằm Căn Riêng Đồng Thời Cho Từ Kể Tất Toàn Bao Hàng Nội Quy".split(" "))
/** Defined-term consistency: variants of glossary terms, Title-Case terms / new definitions outside the glossary. */
function termIssues(d: Draft, s: Section, text: string): Omit<Issue, "id" | "status">[] {
  const out: Omit<Issue, "id" | "status">[] = []
  const terms = d.glossary.map((g) => g.term)
  const termKeys = new Set(terms.map((t) => t.toLowerCase()))
  const partyWords = new Set(d.parties.flatMap((p) => [p.short ?? "", p.role]).map((x) => x.toLowerCase()))
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const sentenceCase = (v: string) => v[0] !== v[0].toLowerCase() && v.slice(1) === v.slice(1).toLowerCase()
  for (const t of isDefinitions(s.heading) ? [] : terms) {
    if (!/\s/.test(t) && t === t.toLowerCase()) continue
    const re = new RegExp(`(?<![\\p{L}])${esc(t)}(?![\\p{L}])`, "giu")
    const variants = new Map<string, number>()
    for (const m of text.matchAll(re)) {
      if (m[0] === t) continue
      const at = m.index as number
      // "Chỉ tiêu doanh số …" at the start of a sentence / line / table cell is the ordinary word, not a variant
      const start = at === 0 || /(?:[.!?:;|]\s*|\n\s*[-*]?\s*|\)\s)$/.test(text.slice(Math.max(0, at - 4), at))
      const v = sentenceCase(m[0]) && start ? m[0].toLowerCase() : m[0]
      // a sentence-case term ("Hợp đồng") written in lowercase is the ordinary word – only Title-Case terms are flagged
      const titleCase = t.split(/\s+/).every((w) => w[0] !== w[0].toLowerCase())
      if (v !== t && (titleCase || v !== v.toLowerCase())) variants.set(v, (variants.get(v) ?? 0) + 1)
    }
    for (const [v, n] of variants) {
      const partialCaps = v !== v.toLowerCase() // "Sản phẩm" vs "Sản Phẩm" – sloppy variant
      out.push({ section: s.key, severity: partialCaps ? "cảnh báo" : "gợi ý", code: "term-variant", source: "auto", lang: "vi", message: `Thuật ngữ “${t}” được viết thành "${v}" (${n} lần).`, ...(partialCaps ? { data: { term: t, variant: v } } : {}), suggested_fix: partialCaps ? `Viết đúng “${t}”.` : `Nếu mang nghĩa đã định nghĩa thì viết “${t}”.` })
    }
  }
  if (!isDefinitions(s.heading)) {
    for (const m of text.matchAll(/[“"]([^”"\n]{2,50})[”"]\s*(?:\([^)]{0,40}\)\s*)?(?:là|có nghĩa là|được hiểu là|sau đây gọi là|dưới đây gọi là)/gu)) {
      if (!termKeys.has(m[1].trim().toLowerCase()) && !partyWords.has(m[1].trim().toLowerCase()))
        out.push({ section: s.key, severity: "cảnh báo", code: "term-defined-outside", source: "auto", lang: "vi", message: `Định nghĩa thuật ngữ mới “${m[1]}” ngoài điều Giải thích từ ngữ và không có trong bảng thuật ngữ.`, suggested_fix: `Dùng thuật ngữ có trong bảng hoặc diễn đạt bằng lời thường, không định nghĩa mới.` })
    }
  }
  const seen = new Set<string>()
  for (const m of text.matchAll(TITLE_PHRASE)) {
    const ws = m[1].split(/\s+/)
    while (ws.length && SENTENCE_START.has(ws[0])) ws.shift()
    const ph = ws.join(" ")
    if (ws.length < 2 || !NON_ASCII.test(ph) || ws.includes("Bên") || ws.includes("Party") || PROPER_START.has(ws[0]) || seen.has(ph)) continue
    seen.add(ph)
    const k = ph.toLowerCase()
    if (termKeys.has(k) || [...termKeys].some((t) => t.includes(k) || k.includes(t)) || partyWords.has(k) || lawInPack(d, ph)) continue
    if (d.parties.some((p) => (p.name_placeholder ?? "").includes(ph))) continue
    out.push({ section: s.key, severity: "cảnh báo", code: "term-undefined", source: "auto", lang: "vi", message: `"${ph}" viết hoa như thuật ngữ đã định nghĩa nhưng không có trong bảng thuật ngữ.`, suggested_fix: `Dùng thuật ngữ trong bảng (${terms.slice(0, 8).map((t) => `“${t}”`).join(", ")}${terms.length > 8 ? "…" : ""}) hoặc viết thường.` })
  }
  return out
}

const PARTY_ROLES = ["giao đại lý", "đại lý", "nhà phân phối", "phân phối", "mua", "bán", "cung ứng dịch vụ", "cung ứng", "cung cấp", "sử dụng dịch vụ", "cho thuê", "thuê", "vận chuyển", "gửi hàng", "nhận hàng", "ủy quyền", "nhận ủy quyền", "bảo lãnh", "nhượng quyền", "nhận quyền"]
function partyIssues(d: Draft, s: Section, text: string, lang: "vi" | "en"): Omit<Issue, "id" | "status">[] {
  const out: Omit<Issue, "id" | "status">[] = []
  if (!d.parties.length) return out
  const letters = new Set(d.parties.map((p) => (p.short ?? "").match(/([A-Z])$/)?.[1]).filter(Boolean))
  const re = lang === "en" ? /\bParty\s+([A-Z])\b/g : /\bBên\s+([A-Z])\b/gu
  const bad = new Set<string>()
  for (const m of text.matchAll(re)) if (!letters.has(m[1])) bad.add(m[0])
  for (const b of bad) out.push({ section: s.key, severity: "lỗi", code: "party-unknown", source: "auto", lang, message: `"${b}" không phải bên nào của văn bản (các bên: ${d.parties.map((p) => `${p.short} – ${p.role}`).join("; ")}).`, suggested_fix: "Dùng đúng tên viết tắt của các bên." })
  if (lang === "vi") {
    const roles = d.parties.map((p) => normKey(p.role.replace(/\([^)]*\)/g, "")))
    const alt = [...PARTY_ROLES].sort((a, b) => b.length - a.length).map((r) => r.replace(/ /g, "\\s+")).join("|")
    const seen = new Set<string>()
    for (const m of text.matchAll(new RegExp(`\\bBên\\s+(${alt})(?![\\p{L}])`, "giu"))) {
      const k = normKey(`bên ${m[1]}`)
      if (m[0][0] === "b" || seen.has(k) || roles.some((r) => r === k)) continue // lowercase "bên vận chuyển" = a third party
      seen.add(k)
      out.push({ section: s.key, severity: "cảnh báo", code: "party-role", source: "auto", lang, message: `Gọi một bên là "${m[0]}" – không khớp vai trò đã định (${d.parties.map((p) => `${p.short} = ${p.role}`).join("; ")}).`, suggested_fix: "Dùng đúng tên viết tắt / vai trò của các bên." })
    }
  }
  return out
}

type Fact = { topic: string; value: number; unit: string; section: string; snippet: string }
const TOPICS: { topic: string; re: RegExp; unit: "%" | "ngày"; severity: Severity }[] = [
  { topic: "mức phạt vi phạm", re: /(?:mức|tiền|khoản)\s+phạt|phạt vi phạm|chịu phạt|bị phạt|penalty/iu, unit: "%", severity: "cảnh báo" },
  { topic: "lãi chậm trả", re: /lãi\s+(?:suất\s+)?(?:chậm|trả chậm)|lãi\s+(?:trên\s+)?(?:số\s+)?tiền\s+chậm|late[- ]payment interest/iu, unit: "%", severity: "cảnh báo" },
  { topic: "thù lao / hoa hồng", re: /hoa hồng|thù lao|commission|remuneration/iu, unit: "%", severity: "gợi ý" },
  { topic: "chiết khấu", re: /chiết khấu|discount/iu, unit: "%", severity: "gợi ý" },
  { topic: "thời hạn thanh toán", re: /thời hạn thanh toán|phải thanh toán|thanh toán (?:toàn bộ|đầy đủ)?\s*trong (?:vòng|thời hạn)|payment (?:term|within)/iu, unit: "ngày", severity: "gợi ý" },
  { topic: "thông báo sự kiện bất khả kháng", re: /bất khả kháng|force majeure/iu, unit: "ngày", severity: "gợi ý" },
]
function numVal(s: string) { return Number(s.replace(",", ".")) }
function factsOf(key: string, text: string): Fact[] {
  const out: Fact[] = []
  for (const sent of text.split(/(?<=[.;:])\s+|\n+/)) {
    for (const t of TOPICS) {
      // only numbers shortly AFTER the topic keyword ("phạt 8% …", "mức phạt vi phạm là 8%"), not "80% chỉ tiêu … phạt"
      const vals = new Set<number>()
      for (const k of sent.matchAll(new RegExp(t.re.source, "giu"))) {
        const win = sent.slice(k.index as number, (k.index as number) + k[0].length + 110)
        const nums = t.unit === "%"
          // per-day / per-month rates ("0,05%/ngày chậm") are a different measure – not compared with flat rates
          ? [...win.matchAll(/(\d{1,3}(?:[.,]\d{1,3})?)\s?%(?!\s*(?:\/|mỗi|một|cho mỗi|trên mỗi|per|a|each)\s*(?:ngày|tháng|tuần|năm|day|month|week|year))/g)].map((m) => numVal(m[1]))
          : [...win.matchAll(/\(?(\d{1,3})\)?\s*(?:\(\s*[^)]{0,20}\)\s*)?ngày/gu)].map((m) => Number(m[1]))
        for (const v of nums) vals.add(v)
      }
      for (const v of vals) out.push({ topic: t.topic, value: v, unit: t.unit, section: key, snippet: clip(sent.trim(), 160) })
    }
  }
  return out
}

/** All deterministic checks over the current section texts. */
export async function autoCheck(d: Draft, texts: Texts = loadTexts(d)): Promise<Omit<Issue, "id" | "status">[]> {
  const out: Omit<Issue, "id" | "status">[] = []
  const struct = new Map<string, { khoan: number }>()
  for (const s of d.sections) struct.set(s.key, { khoan: structure(texts.get(s.key)?.vi ?? "").khoan.length })
  const bi = d.language === "bilingual"
  const allFacts: Fact[] = []
  const sentOwner = new Map<string, string>()
  for (const s of d.sections) {
    const t = texts.get(s.key)
    if (!t?.vi?.trim()) { if (s.status !== "failed") out.push({ section: s.key, severity: "lỗi", code: "missing", source: "auto", message: `${s.label} chưa có nội dung.`, suggested_fix: "Chạy lại draft_write cho mục này." }); continue }
    const vi = t.vi
    const body = vi.split("\n").slice(1).join("\n")
    // numbering inside the section
    const st = structure(body)
    st.khoan.forEach((k, i) => { if (k !== i + 1) out.push({ section: s.key, severity: "lỗi", code: "numbering", source: "auto", lang: "vi", message: `${s.label}: khoản đánh số không liên tục (${st.khoan.join(", ")}).`, suggested_fix: "Đánh số lại các khoản 1, 2, 3… liên tục." }) })
    const order = d.language === "en" ? EN_ORDER : DIEM_ORDER
    // điểm: a, b, c, d, đ, e … (Vietnamese drafting) – the Latin sequence a, b, c, d, e … is accepted too
    st.diem.forEach((ds) => { if (ds.some((x, i) => x !== order[i]) && ds.some((x, i) => x !== EN_ORDER[i])) out.push({ section: s.key, severity: "cảnh báo", code: "numbering-diem", source: "auto", lang: "vi", message: `${s.label}: điểm đánh không đúng thứ tự (${ds.join(", ")}).`, suggested_fix: `Đánh lại điểm ${order.slice(0, ds.length).join(", ")}.` }) })
    if (new RegExp(`^\\s*${s.no}\\.\\d+\\.?\\s`, "m").test(body)) out.push({ section: s.key, severity: "gợi ý", code: "numbering-style", source: "auto", lang: "vi", message: `${s.label}: có dòng đánh số kiểu "5.1" – nên dùng khoản 1., 2. và điểm a), b).` })
    const cjk = `${vi}\n${t.en ?? ""}`.match(CJK_G)
    if (cjk) out.push({ section: s.key, severity: "lỗi", code: "foreign-chars", source: "auto", message: `${s.label} có ký tự lạ (${[...new Set(cjk)].slice(0, 5).join(", ")}) – lỗi sinh văn bản.`, suggested_fix: "Xóa hoặc thay bằng từ tiếng Việt / tiếng Anh đúng nghĩa." })
    const wc = wordCount(vi)
    if (wc < Math.min(60, targetWords(d, s) / 4)) out.push({ section: s.key, severity: "cảnh báo", code: "too-short", source: "auto", message: `${s.label} quá ngắn (${wc} từ).`, suggested_fix: "Viết đầy đủ các nội dung bắt buộc." })
    if (s.truncated) out.push({ section: s.key, severity: "cảnh báo", code: "truncated", source: "auto", message: `${s.label} có thể bị cắt cụt (hết giới hạn token).`, suggested_fix: "Viết gọn lại và kết thúc trọn vẹn." })
    out.push(...referenceIssues(d, s, body, d.language === "en" ? "en" : "vi", struct))
    out.push(...citationIssues(d, s, body, d.language === "en" ? "en" : "vi"))
    if (d.language !== "en") out.push(...termIssues(d, s, body))
    out.push(...partyIssues(d, s, body, d.language === "en" ? "en" : "vi"))
    allFacts.push(...factsOf(s.key, body))
    // weak must_include coverage (the reviewer does the real check)
    const have = sigWords(body)
    for (const mi of s.must_include) {
      const w = [...sigWords(mi)]
      if (w.length >= 2 && w.filter((x) => have.has(x)).length / w.length < 0.34) out.push({ section: s.key, severity: "gợi ý", code: "must-include", source: "auto", message: `${s.label} có thể chưa có nội dung bắt buộc: "${clip(mi, 100)}".`, suggested_fix: `Bổ sung: ${mi}` })
    }
    // identical long sentences in two sections
    for (const sent of body.split(/(?<=[.;])\s+|\n+/)) {
      const k = norm(sent)
      if (k.split(" ").length < 14) continue
      const o = sentOwner.get(k)
      if (o && o !== s.key) out.push({ section: s.key, severity: "gợi ý", code: "duplicate", source: "auto", message: `Câu lặp lại nguyên văn ở ${d.sections.find((x) => x.key === o)?.label}: "${clip(sent.trim(), 120)}".`, suggested_fix: "Bỏ câu lặp, dẫn chiếu tới điều kia." })
      else sentOwner.set(k, s.key)
    }
    // money in words ("50.000.000 đồng (Bằng chữ: năm mươi triệu đồng)")
    if (!(await contractCheckMod())) out.push(...(await moneyIssues(s, body)))
    if (bi) {
      const en = t.en ?? ""
      if (!en.trim()) { out.push({ section: s.key, severity: "lỗi", code: "bilingual-missing", source: "auto", lang: "en", message: `${s.label}: chưa có bản tiếng Anh.`, suggested_fix: "Viết bản tiếng Anh cùng cấu trúc." }); continue }
      const enBody = en.split("\n").slice(1).join("\n")
      const se = structure(enBody)
      if (se.khoan.length !== st.khoan.length || se.diem.map((x) => x.length).join() !== st.diem.map((x) => x.length).join())
        out.push({ section: s.key, severity: "lỗi", code: "bilingual-structure", source: "auto", lang: "en", message: `${s.label}: bản tiếng Việt có ${st.khoan.length} khoản / ${st.diem.flat().length} điểm, bản tiếng Anh có ${se.khoan.length} khoản / ${se.diem.flat().length} điểm.`, suggested_fix: "Bản tiếng Anh phải cùng số khoản, số điểm, cùng thứ tự với bản tiếng Việt." })
      const nums = (x: string) => [...x.matchAll(/\d+(?:[.,]\d+)?\s?%|\(\d+\)/g)].map((m) => m[0].replace(/\s/g, "").replace(",", ".")).sort().join(" ")
      if (nums(body) !== nums(enBody)) out.push({ section: s.key, severity: "cảnh báo", code: "bilingual-numbers", source: "auto", lang: "en", message: `${s.label}: tỷ lệ % / số trong ngoặc khác nhau giữa hai bản (VI: ${clip(nums(body) || "–", 80)}; EN: ${clip(nums(enBody) || "–", 80)}).`, suggested_fix: "Thống nhất các con số giữa hai bản." })
      out.push(...referenceIssues(d, s, enBody, "en", struct))
      out.push(...citationIssues(d, s, enBody, "en"))
      out.push(...partyIssues(d, s, enBody, "en"))
    }
  }
  // amounts: the calc tools' contract check (../lib/contract-check.ts – tables, totals, VAT, payment schedule,
  // amounts in words, VND/USD mix; bilingual: figures VI ↔ EN) on the whole draft, findings mapped to sections
  out.push(...(await amountIssues(d, texts)))
  // cross-section consistency of rates / terms
  const cap301 = d.research.some((r) => /luat thuong mai/.test(normKey(r.law ?? "")) && /8%/.test(r.text) && /Điều 301/.test(`${r.article} ${r.text.slice(0, 40)}`))
  for (const t of TOPICS) {
    const fs_ = allFacts.filter((f) => f.topic === t.topic)
    const vals = [...new Set(fs_.map((f) => f.value))]
    if (t.topic === "mức phạt vi phạm" && d.kind === "hop-dong") {
      for (const f of fs_) if (f.value > 8) out.push({ section: f.section, severity: "lỗi", code: "penalty-cap", source: "auto", message: `Mức phạt ${f.value}% vượt mức tối đa 8% giá trị phần nghĩa vụ bị vi phạm${cap301 ? " (Điều 301 Luật Thương mại 2005 trong bộ căn cứ)" : " (Điều 301 Luật Thương mại 2005 – cần kiểm tra lại bằng công cụ)"}: "${f.snippet}".`, suggested_fix: "Hạ mức phạt xuống không quá 8% và thống nhất với các điều khác." })
    }
    // graded rates inside ONE article are normal; different values in different articles are a possible contradiction
    if (vals.length > 1 && new Set(fs_.map((f) => f.section)).size > 1) {
      const bySec = new Map<string, Set<number>>()
      for (const f of fs_) { if (!bySec.has(f.section)) bySec.set(f.section, new Set()); bySec.get(f.section)!.add(f.value) }
      const secs = [...bySec.keys()]
      const detail = fs_.map((f) => `${d.sections.find((x) => x.key === f.section)?.label}: ${f.value}${f.unit === "%" ? "%" : " ngày"}`).filter((v, i, a) => a.indexOf(v) === i).join("; ")
      const target = secs.length > 1 ? secs[secs.length - 1] : secs[0]
      out.push({ section: target, severity: t.severity, code: `conflict:${t.topic}`, source: "auto", message: `Có ${vals.length} giá trị khác nhau cho ${t.topic}: ${detail}. Kiểm tra mâu thuẫn (cùng một vi phạm / nghĩa vụ không được quy định hai mức).`, suggested_fix: `Thống nhất ${t.topic} theo một mức (VD theo điều chuyên về nội dung này) hoặc dẫn chiếu thay vì quy định lại.` })
    }
  }
  // cross-section: glossary terms never used
  if (d.language !== "en") {
    const whole = [...texts.values()].map((t) => t.vi).join("\n")
    const defs = d.sections.find((x) => isDefinitions(x.heading))
    const rest = d.sections.filter((x) => x !== defs).map((x) => texts.get(x.key)?.vi ?? "").join("\n")
    for (const g of d.glossary) {
      if (defs && !(texts.get(defs.key)?.vi ?? "").includes(g.term)) out.push({ section: defs.key, severity: "cảnh báo", code: "term-not-defined", source: "auto", message: `Thuật ngữ “${g.term}” có trong bảng thuật ngữ nhưng chưa được định nghĩa trong ${defs.label}.`, suggested_fix: `Thêm khoản định nghĩa “${g.term}”: ${g.definition}` })
      else if (!rest.includes(g.term) && whole.includes(g.term)) out.push({ section: defs?.key, severity: "gợi ý", code: "term-unused", source: "auto", message: `Thuật ngữ “${g.term}” được định nghĩa nhưng không dùng ở điều nào khác.` })
    }
  }
  return out
}

let ccMod: any = undefined
/** ../lib/contract-check.ts (calc tools) when installed, else null – then only the built-in money-in-words check runs. */
async function contractCheckMod() {
  if (ccMod !== undefined) return ccMod
  try { ccMod = await import("./contract-check.ts"); if (typeof ccMod?.checkContract !== "function") ccMod = null } catch { ccMod = null }
  return ccMod
}
async function amountIssues(d: Draft, texts: Texts): Promise<Omit<Issue, "id" | "status">[]> {
  const cc = await contractCheckMod()
  if (!cc || d.kind !== "hop-dong") return []
  const join = (lang: "vi" | "en") => d.sections.map((s) => (lang === "en" ? texts.get(s.key)?.en : texts.get(s.key)?.vi) ?? "").join("\n\n")
  const secOf = (where: string) => {
    const m = String(where ?? "").match(/(điều|article|phụ\s*lục|appendix|annex)\s+(\d+)/iu)
    if (!m) return undefined
    const typ = /phu luc|appendix|annex/.test(normKey(m[1])) ? "annex" : "article"
    return d.sections.find((s) => s.type === typ && s.no === Number(m[2]))?.key
  }
  const out: Omit<Issue, "id" | "status">[] = []
  const add = (f: any, lang: "vi" | "en") => {
    if (!f || f.severity === "thông tin") return
    if (/mức phạt/i.test(f.what) && /8%/.test(f.what)) return // penalty cap: own check (penalty-cap) with the research pack
    out.push({
      section: secOf(f.where), severity: f.severity === "lỗi" ? "lỗi" : "cảnh báo", code: "amount", source: "auto", lang,
      message: `${f.where ? `${f.where}: ` : ""}${f.what}${f.found ? ` (đang ghi: ${clip(String(f.found), 80)})` : ""}`,
      ...(f.expected ? { suggested_fix: `Sửa thành: ${clip(String(f.expected), 160)}` } : {}),
    })
  }
  try {
    const one = d.language === "en" ? "en" : "vi"
    for (const f of cc.checkContract(join(one), one).findings ?? []) add(f, one)
    if (d.language === "bilingual") {
      for (const f of cc.checkContract(join("en"), "en").findings ?? []) add(f, "en")
      for (const f of cc.compareBilingual?.(join("vi"), join("en"))?.findings ?? []) add(f, "en")
    }
  } catch {}
  return out
}

let calcMod: any = undefined
async function calc() {
  if (calcMod !== undefined) return calcMod
  try { calcMod = await import("./calc-core.ts") } catch { calcMod = null }
  return calcMod
}
async function moneyIssues(s: Section, body: string): Promise<Omit<Issue, "id" | "status">[]> {
  const c = await calc()
  if (!c?.parseMoneyWords || !c?.parseNumber || !c?.cmp) return []
  const out: Omit<Issue, "id" | "status">[] = []
  for (const m of body.matchAll(/(\d{1,3}(?:\.\d{3})+|\d{4,})\s*(?:VNĐ|VND|đồng)\s*\(\s*(?:bằng chữ\s*:\s*)?([^)]{6,160})\)/giu)) {
    try {
      const num = c.parseNumber(m[1], "vi").value
      const w = c.parseMoneyWords(m[2], "vi")
      if (w?.value && c.cmp(w.value, num) !== 0) out.push({ section: s.key, severity: "lỗi", code: "money-words", source: "auto", message: `Số tiền "${m[1]}" không khớp với số tiền bằng chữ "${clip(m[2], 80)}".`, suggested_fix: "Sửa số tiền bằng chữ cho khớp số tiền bằng số." })
    } catch {}
  }
  return out
}

// ---------- LLM calls ----------
function tokensFor(d: Draft, s: Section) {
  const w = targetWords(d, s)
  const one = Math.max(2500, Math.round(w * 4.2))
  return Math.min(15000, d.language === "bilingual" ? one * 2 + 500 : one)
}
function parseWriter(d: Draft, s: Section, raw: string): { vi: string; en?: string; heading_en?: string } | { error: string } {
  if (d.language === "bilingual") {
    const p = splitBilingual(raw)
    if (!p) return { error: "thiếu phần === VI === / === EN ===" }
    const vi = cleanBody(p.vi, s.no), en = cleanBody(p.en, s.no)
    if (!vi || !en) return { error: "một trong hai bản trống" }
    return { vi, en, heading_en: s.heading_en ?? enHeadingFrom(p.en) }
  }
  const vi = cleanBody(raw, s.no)
  return vi ? { vi } : { error: "nội dung trống" }
}
function compose(d: Draft, s: Section, body: string, lang: "vi" | "en") {
  return `${headingLine(d, s, lang)}\n\n${body}`
}

export type RunOpts = { parallel?: number; signal?: AbortSignal; context?: any; onProgress?: () => void }

async function writeOne(d: Draft, s: Section, extra: ChatMsg[] = [], opts: RunOpts): Promise<void> {
  const model = d.model || sessionModel(opts.context)
  const messages: ChatMsg[] = [
    { role: "system", content: systemPrompt(d) },
    { role: "user", content: `${contextBlock(d, s)}\n\n${assignment(d, s)}` },
    ...extra,
  ]
  let lastErr = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(messages, { model, maxTokens: tokensFor(d, s), temperature: 0.35, timeoutMs: 300_000, retries: 2, signal: opts.signal })
    const p = parseWriter(d, s, r.text)
    if ("error" in p) { lastErr = p.error; messages.push({ role: "assistant", content: r.text.slice(0, 4000) }, { role: "user", content: `Sai định dạng: ${p.error}. Trả lại toàn bộ theo đúng định dạng yêu cầu.` }); continue }
    if (p.heading_en && !s.heading_en) s.heading_en = p.heading_en.replace(/\*\*/g, "")
    if (CJK.test(`${p.vi}\n${p.en ?? ""}`) && attempt === 0) {
      messages.push({ role: "assistant", content: r.text }, { role: "user", content: `Phần vừa viết có ký tự tiếng Trung / Nhật / Hàn lẫn vào. Viết lại toàn bộ, chỉ dùng tiếng Việt${p.en ? " và tiếng Anh" : ""}, đúng định dạng.` })
      continue
    }
    // bilingual: khoản / điểm counts must match → one corrective retry
    if (p.en) {
      const a = structure(p.vi), b = structure(p.en)
      if ((a.khoan.length !== b.khoan.length || a.diem.flat().length !== b.diem.flat().length) && attempt === 0) {
        messages.push({ role: "assistant", content: r.text }, { role: "user", content: `Bản tiếng Việt có ${a.khoan.length} khoản / ${a.diem.flat().length} điểm nhưng bản tiếng Anh có ${b.khoan.length} khoản / ${b.diem.flat().length} điểm. Viết lại cả hai bản CÙNG cấu trúc (cùng số khoản, số điểm, thứ tự), đúng định dạng === VI === / === EN ===.` })
        continue
      }
    }
    // citations outside the research pack → one corrective retry
    const cit = [...citationIssues(d, s, p.vi, d.language === "en" ? "en" : "vi"), ...(p.en ? citationIssues(d, s, p.en, "en") : [])].filter((i) => i.severity === "lỗi" || i.code === "law-not-in-pack")
    if (cit.length && attempt === 0) {
      messages.push({ role: "assistant", content: r.text }, { role: "user", content: `Phần vừa viết có dẫn chiếu không nằm trong bộ căn cứ:\n${cit.map((i) => `- ${i.message}`).join("\n")}\nViết lại toàn bộ phần này, chỉ dẫn các văn bản / đoạn trong bộ căn cứ (hoặc không dẫn), giữ nguyên mọi nội dung khác.` })
      continue
    }
    writeSection(d, s.key, compose(d, s, p.vi, d.language === "en" ? "en" : "vi"), "vi")
    if (p.en) writeSection(d, s.key, compose(d, s, p.en, "en"), "en")
    s.wordCount = wordCount(p.vi)
    s.truncated = r.finish === "length"
    return
  }
  throw new Error(lastErr || "không viết được")
}

/** Terms the definitions article defined beyond the plan glossary → added to the glossary (auto) for the other writers and checks. */
function extendGlossary(d: Draft, defsKey: string) {
  const text = sectionText(d, defsKey, "vi")
  const have = new Set(d.glossary.map((g) => g.term.toLowerCase()))
  const added: string[] = []
  for (const m of text.matchAll(/^\s*\d{1,2}\.\s*(?:\*\*)?[“"]([^”"\n]{2,50})[”"](?:\*\*)?\s*(?:\([^)]{0,60}\)\s*)?(?:là|có nghĩa là|được hiểu là)\s+([^\n]{0,240})/gmu)) {
    const term = m[1].trim()
    if (have.has(term.toLowerCase()) || d.parties.some((p) => p.short?.toLowerCase() === term.toLowerCase())) continue
    have.add(term.toLowerCase())
    d.glossary.push({ term, definition: m[2].trim().replace(/[.;]$/, ""), auto: true })
    added.push(term)
  }
  if (added.length) d.warnings.push(`Điều Giải thích từ ngữ định nghĩa thêm: ${added.map((t) => `“${t}”`).join(", ")} – đã đưa vào bảng thuật ngữ.`)
  return added
}

/** Write (or rewrite) sections in parallel. The definitions article (if pending with others) is written first,
 *  so every other writer gets its complete list of defined terms. */
export async function writeSections(d: Draft, keys: string[] | undefined, opts: RunOpts = {}) {
  const want = keys?.length ? d.sections.filter((s) => keys.includes(s.key)) : d.sections.filter((s) => s.status === "pending" || s.status === "failed")
  const t0 = Date.now()
  d.phase = "write"
  for (const s of want) { s.status = "pending"; delete s.error }
  saveDraft(d)
  emit(d, opts.context)
  const one = async (s: Section) => {
    s.status = "writing"
    s.attempts = (s.attempts ?? 0) + 1
    saveDraft(d); emit(d, opts.context); opts.onProgress?.()
    try {
      await writeOne(d, s, [], opts)
      s.status = "written"
    } catch (e: any) {
      s.status = "failed"
      s.error = String(e?.message ?? e).slice(0, 300)
    }
    saveDraft(d); emit(d, opts.context); opts.onProgress?.()
  }
  const defs = want.length > 1 ? want.find((s) => isDefinitions(s.heading)) : undefined
  if (defs) {
    await one(defs)
    if (defs.status === "written") extendGlossary(d, defs.key)
  }
  await pool(want.filter((s) => s !== defs), Math.max(1, Math.min(6, opts.parallel ?? 4)), one)
  d.timings.write = (d.timings.write ?? 0) + (Date.now() - t0)
  saveDraft(d)
  return want
}

// ---------- LLM reviewer ----------
function assembledForReview(d: Draft, texts: Texts) {
  return d.sections.map((s) => `[${s.key}] ${texts.get(s.key)?.vi ?? "(chưa có)"}`).join("\n\n")
}
const REVIEW_FOCUS = [
  "MÂU THUẪN và THIẾU NHẤT QUÁN: hai điều quy định khác nhau cho cùng một vấn đề (mức phạt, thời hạn, phương thức thanh toán, thời điểm chuyển rủi ro, luật áp dụng, cơ quan giải quyết tranh chấp…); dẫn chiếu nội bộ sai nội dung; dùng thuật ngữ / tên các bên không thống nhất; câu chữ mơ hồ, có hai cách hiểu; thời hạn không rõ mốc tính.",
  "THIẾU NỘI DUNG so với yêu cầu bắt buộc (must_include) của từng mục; điều khoản bất lợi hoặc thiên lệch gây hại cho BÊN NGƯỜI DÙNG (KHÔNG đề xuất sửa để có lợi hơn cho bên kia; chỉ khi điều khoản trái luật / có thể vô hiệu, hoặc bất cân xứng tới mức đối tác khó chấp nhận thì nêu ở mức 'gợi ý'); rủi ro pháp lý (mức phạt / bồi thường / lãi vượt giới hạn trong bộ căn cứ, điều khoản có thể vô hiệu); nghĩa vụ thiếu chế tài hoặc thiếu thời hạn.",
]
async function reviewPass(d: Draft, texts: Texts, focus: string, opts: RunOpts): Promise<Omit<Issue, "id" | "status">[]> {
  const model = d.model || sessionModel(opts.context)
  const req = d.sections.map((s) => `[${s.key}] ${s.label}. ${s.heading}${s.must_include.length ? ` – phải có: ${s.must_include.join("; ")}` : ""}`).join("\n")
  const gl = d.glossary.map((g) => `“${g.term}”: ${g.definition}`).join("\n")
  const packLaws = [...new Set(d.research.map((r) => `${lawDisplay(r)}${r.article ? ` ${r.article}` : ""}`))].join("; ")
  const sys = "Bạn là luật sư thẩm định (reviewer) của nhóm soạn thảo hợp đồng. Bạn KHÔNG viết lại văn bản; bạn liệt kê vấn đề cụ thể, có vị trí, kèm cách sửa. Chỉ nêu vấn đề thật, không nêu lại điều đã ổn, không bắt lỗi dấu \"…\" hay \"[cần thương lượng]\" (đó là chỗ trống có chủ ý). Trả lời DUY NHẤT một JSON: {\"issues\":[{\"section\":\"<key trong ngoặc vuông>\",\"severity\":\"lỗi|cảnh báo|gợi ý\",\"message\":\"…\",\"suggested_fix\":\"…\"}]} (tối đa 20 mục; lỗi = sai / mâu thuẫn / trái luật; cảnh báo = thiếu nội dung quan trọng, bất lợi rõ, mơ hồ; gợi ý = cải thiện)."
  const user = [
    `VĂN BẢN: ${d.title} (${d.kind})`,
    d.user_side ? `BÊN NGƯỜI DÙNG: ${d.user_side}` : "",
    d.parties.length ? `CÁC BÊN: ${d.parties.map((p) => `${p.short} = ${p.role}`).join("; ")}` : "",
    gl ? `BẢNG THUẬT NGỮ:\n${gl}` : "",
    packLaws ? `BỘ CĂN CỨ ĐÃ TRA: ${packLaws}` : "",
    `YÊU CẦU TỪNG MỤC:\n${req}`,
    `TRỌNG TÂM RÀ SOÁT LẦN NÀY: ${focus}`,
    `TOÀN VĂN DỰ THẢO (mỗi mục bắt đầu bằng [key]):\n${assembledForReview(d, texts)}`,
  ].filter(Boolean).join("\n\n")
  const r = await chat([{ role: "system", content: sys }, { role: "user", content: user }], { model, maxTokens: 5000, temperature: 0.1, timeoutMs: 360_000, retries: 2, signal: opts.signal })
  let parsed: any
  try { parsed = parseJsonLoose(r.text) } catch { return [] }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.issues) ? parsed.issues : []
  const keyOf = (x: string) => {
    const t = String(x ?? "").replace(/[[\]]/g, "").trim()
    if (d.sections.some((s) => s.key === t)) return t
    const m = t.match(/(điều|article|phụ lục|appendix|mục)\s+(\d+)/i)
    if (m) { const w = normKey(m[1]); const typ = /phu luc|appendix/.test(w) ? "annex" : /muc/.test(w) ? "part" : "article"; return d.sections.find((s) => s.type === typ && s.no === Number(m[2]))?.key }
    return undefined
  }
  const sev = (x: string): Severity => (/lỗi|loi|error/i.test(x) ? "lỗi" : /cảnh|canh|warn/i.test(x) ? "cảnh báo" : "gợi ý")
  return arr.filter((x: any) => x && x.message).slice(0, 25).map((x: any) => ({
    section: keyOf(x.section), severity: sev(String(x.severity ?? "")), code: "review", source: "review" as const,
    message: String(x.message).slice(0, 600), ...(x.suggested_fix ? { suggested_fix: String(x.suggested_fix).slice(0, 600) } : {}),
  }))
}

const issueKey = (i: Pick<Issue, "code" | "section" | "message">) => `${i.code}|${i.section ?? ""}|${i.message}`
function numberIssues(list: Omit<Issue, "id" | "status">[], prefix: string, round: number): Issue[] {
  return list.map((x, n) => ({ ...x, id: `${prefix}${n + 1}`, status: "open" as const, round }))
}

/** Deterministic checks + (optionally) the LLM reviewer passes (in parallel). Saves issues.json. */
export async function checkDraft(d: Draft, opts: RunOpts & { review?: boolean } = {}) {
  const t0 = Date.now()
  d.phase = "check"
  saveDraft(d)
  emit(d, opts.context)
  const texts = loadTexts(d)
  const [auto, ...reviews] = await Promise.all([
    autoCheck(d, texts),
    ...(opts.review === false ? [] : REVIEW_FOCUS.map((f) => reviewPass(d, texts, f, opts).catch(() => [] as Omit<Issue, "id" | "status">[]))),
  ])
  // dedupe reviewer findings (same section, very similar message)
  const rv: Omit<Issue, "id" | "status">[] = []
  for (const x of reviews.flat()) {
    const w = sigWords(x.message)
    const dup = rv.some((y) => y.section === x.section && (() => { const v = sigWords(y.message); let h = 0; for (const a of w) if (v.has(a)) h++; return h / Math.max(1, Math.min(w.size, v.size)) > 0.6 })())
    if (!dup) rv.push(x)
  }
  const issues = [...numberIssues(dedupe(auto), "A", d.round), ...numberIssues(rv, "R", d.round)]
  saveIssues(d, issues)
  for (const s of d.sections) if (s.status === "written" || s.status === "fixed") s.status = s.status === "fixed" ? "fixed" : "checked"
  d.timings.check = (d.timings.check ?? 0) + (Date.now() - t0)
  saveDraft(d)
  emit(d, opts.context, issues)
  return issues
}
function dedupe(list: Omit<Issue, "id" | "status">[]) {
  const seen = new Set<string>()
  return list.filter((i) => { const k = issueKey(i); if (seen.has(k)) return false; seen.add(k); return true })
}

// ---------- fix ----------
export async function fixDraft(d: Draft, ids: string[] | undefined, opts: RunOpts & { maxRounds?: number } = {}) {
  const t0 = Date.now()
  let issues = loadIssues(d)
  const selected = (ids?.length ? issues.filter((i) => ids.includes(i.id)) : issues.filter((i) => i.status === "open" && i.severity !== "gợi ý"))
  const unassigned = selected.filter((i) => !i.section)
  const log: string[] = []
  const fixedKeys = new Set<string>()
  // mechanical fixes (no model call): mis-capitalised defined terms mid-sentence → the defined form
  const mechFix = (list: Issue[]) => {
    const mech = list.filter((i) => i.code === "term-variant" && i.status === "open" && i.section && i.data?.term && i.data?.variant)
    for (const i of mech) {
      const s = d.sections.find((x) => x.key === i.section)
      if (!s) continue
      const txt = sectionText(d, s.key, "vi")
      const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const re = new RegExp(`(?<![\\p{L}])${esc(i.data!.variant)}(?![\\p{L}])`, "gu")
      const lines = txt.split("\n")
      const next = [lines[0], ...lines.slice(1).map((l) => l.replace(re, (m, at: number, str: string) => (at === 0 || /(?:[.!?:;|]\s*|^\s*[-*]?\s*|\)\s)$/.test(str.slice(Math.max(0, at - 4), at)) ? m : i.data!.term)))].join("\n")
      if (next !== txt) { writeSection(d, s.key, next, "vi"); s.status = "fixed"; fixedKeys.add(s.key); i.status = "fixed" }
    }
    const n = mech.filter((i) => i.status === "fixed").length
    if (n) log.push(`Sửa bằng máy ${n} chỗ viết sai hoa / thường của thuật ngữ đã định nghĩa.`)
    // restarted khoản numbering → sub-khoản "2.1." (the issue is re-evaluated by the next machine check)
    const num = list.filter((i) => i.code === "numbering" && i.status === "open" && i.section)
    for (const i of num) {
      for (const lang of (d.language === "bilingual" ? ["vi", "en"] : ["vi"]) as ("vi" | "en")[]) {
        const txt = sectionText(d, i.section!, lang)
        const [h, ...rest] = txt.split("\n")
        const next = [h, nestRestarts(rest.join("\n"))].join("\n")
        if (next !== txt) { writeSection(d, i.section!, next, lang); fixedKeys.add(i.section!); const s = d.sections.find((x) => x.key === i.section); if (s) s.status = "fixed" }
      }
    }
    return [...mech, ...num]
  }
  mechFix(selected)
  if (fixedKeys.size) {
    const now = new Set(dedupe(await autoCheck(d)).map(issueKey))
    for (const i of issues) if (i.source === "auto" && i.status === "open" && !now.has(issueKey(i))) i.status = "fixed"
  }
  let todo = selected.filter((i) => i.section && i.status !== "fixed")
  const maxRounds = Math.max(1, Math.min(2, opts.maxRounds ?? 2))
  d.phase = "fix"
  for (let round = 1; round <= maxRounds && todo.length; round++) {
    d.round = (d.round ?? 0) + 1
    const bySec = new Map<string, Issue[]>()
    for (const i of todo) { if (!bySec.has(i.section!)) bySec.set(i.section!, []); bySec.get(i.section!)!.push(i) }
    const secs = d.sections.filter((s) => bySec.has(s.key))
    for (const s of secs) s.status = "pending"
    saveDraft(d); emit(d, opts.context, issues)
    await pool(secs, Math.max(1, Math.min(6, opts.parallel ?? 4)), async (s) => {
      s.status = "writing"
      saveDraft(d); emit(d, opts.context, issues)
      const list = bySec.get(s.key)!
      const cur = sectionText(d, s.key, "vi"), curEn = d.language === "bilingual" ? sectionText(d, s.key, "en") : ""
      const current = d.language === "bilingual" ? `=== VI ===\n${cur}\n=== EN ===\n${curEn}` : cur
      const extra: ChatMsg[] = [
        { role: "assistant", content: current },
        { role: "user", content: `Trưởng nhóm rà soát đã phát hiện các vấn đề sau trong phần bạn viết:\n${list.map((i) => `- [${i.severity}] ${i.message}${i.suggested_fix ? ` → Cách sửa: ${i.suggested_fix}` : ""}${i.lang === "en" ? " (bản tiếng Anh)" : ""}`).join("\n")}\n\nViết lại TOÀN BỘ phần này, chỉ sửa đúng các vấn đề trên, giữ nguyên các khoản / câu chữ không liên quan, cùng định dạng${d.language === "bilingual" ? " === VI === / === EN === (sửa cả hai bản cho khớp)" : ""}. Không thêm dẫn chiếu tới điều / luật không có trong dàn ý và bộ căn cứ.` },
      ]
      try {
        await writeOne(d, s, extra, opts)
        s.status = "fixed"
        fixedKeys.add(s.key)
        for (const i of list) i.status = "fixed"
      } catch (e: any) {
        s.status = "failed"
        s.error = String(e?.message ?? e).slice(0, 300)
        log.push(`${s.label}: không sửa được (${s.error})`)
      }
      saveDraft(d); emit(d, opts.context, issues)
    })
    // re-run deterministic checks: auto issues are recomputed (gone → fixed, still there → open, new → added);
    // errors left in the sections rewritten in this round → next round
    const auto = dedupe(await autoCheck(d))
    const now = new Set(auto.map(issueKey))
    for (const i of issues) if (i.source === "auto") i.status = now.has(issueKey(i)) ? "open" : "fixed"
    const known = new Set(issues.filter((i) => i.source === "auto").map(issueKey))
    let n = Math.max(0, ...issues.filter((i) => i.source === "auto").map((i) => Number(i.id.slice(1)) || 0))
    for (const a of auto) if (!known.has(issueKey(a))) issues.push({ ...a, id: `A${++n}`, status: "open", round: d.round })
    if (mechFix(issues.filter((i) => i.section && secs.some((x) => x.key === i.section))).some((i) => i.status === "fixed")) {
      const again = new Set(dedupe(await autoCheck(d)).map(issueKey))
      for (const i of issues) if (i.source === "auto") i.status = again.has(issueKey(i)) ? "open" : "fixed"
    }
    saveIssues(d, issues)
    const roundSecs = new Set(secs.map((s) => s.key))
    todo = issues.filter((i) => i.source === "auto" && i.status === "open" && i.severity === "lỗi" && !!i.section && roundSecs.has(i.section))
    log.push(`Vòng ${round}: sửa ${secs.length} mục (${secs.map((s) => s.label).join(", ")}); kiểm tra lại tự động: ${auto.filter((a) => a.severity === "lỗi").length} lỗi, ${auto.filter((a) => a.severity === "cảnh báo").length} cảnh báo.`)
  }
  for (const i of unassigned) if (i.status === "open") i.status = "remaining"
  saveIssues(d, issues)
  d.timings.fix = (d.timings.fix ?? 0) + (Date.now() - t0)
  saveDraft(d)
  emit(d, opts.context, issues)
  return { issues, log, unassigned, fixedSections: [...fixedKeys] }
}

// ---------- assemble ----------
const PARTY_FIELDS_VI = ["Địa chỉ trụ sở chính: …", "Mã số doanh nghiệp / mã số thuế: …", "Điện thoại: …   Email: …", "Người đại diện theo pháp luật: …   Chức vụ: …", "Tài khoản số: …   tại Ngân hàng: …"]
const PARTY_FIELDS_EN = ["Head office address: …", "Enterprise code / tax code: …", "Telephone: …   Email: …", "Legal representative: …   Position: …", "Bank account No.: …   at Bank: …"]

const partyEn = (p: Party) => (p.short ?? "").replace(/^Bên/, "Party")
const roleEn = (p: Party, i: number) =>
  p.role_en || enSignLabel(`ĐẠI DIỆN ${p.short} (${p.role})`, i ? 1 : 0).match(/\(([^)]+)\)/)?.[1]?.replace(/^THE\s+/i, "") || partyEn(p)
function preamble(d: Draft, lang: "vi" | "en") {
  const title = lang === "en" ? d.title_en || d.title : d.title
  const laws = [...new Map(d.research.filter((r) => r.law).map((r) => [normKey(r.law!), r])).values()]
  if (d.kind !== "hop-dong") return [`# ${title}`, ""].join("\n")
  if (lang === "en") {
    return [
      `# ${title}`, "", "No.: …/…", "",
      ...laws.map((r) => `*Pursuant to the ${lawEn(r.law!)}${r.number ? ` No. ${r.number}` : ""};*`),
      "*Based on the needs and capabilities of the Parties,*", "",
      "Today, …, at …, we, the undersigned, comprise:", "",
      ...d.parties.flatMap((p, i) => [`**${roleEn(p, i).toUpperCase()} (hereinafter "${partyEn(p)}"): ${p.name_placeholder ?? "…"}**`, "", ...PARTY_FIELDS_EN.map((f) => `- ${f}`), ""]),
      "The Parties agree to enter into this Contract on the following terms and conditions:", "",
    ].join("\n")
  }
  return [
    `# ${title}`, "", "Số: …/…", "",
    ...laws.map((r) => `*Căn cứ ${r.law}${r.number && !r.law!.includes(r.number) ? ` số ${r.number}` : ""};*`),
    "*Căn cứ nhu cầu và khả năng của các bên,*", "",
    "Hôm nay, ngày … tháng … năm …, tại …, chúng tôi gồm:", "",
    ...d.parties.flatMap((p) => [`**${p.role.toUpperCase()} (sau đây gọi là "${p.short}"): ${p.name_placeholder ?? "…"}**`, "", ...PARTY_FIELDS_VI.map((f) => `- ${f}`), ""]),
    "Sau khi bàn bạc, các bên thống nhất ký kết Hợp đồng này với các điều khoản sau:", "",
  ].join("\n")
}

const NL = "\n"
export async function assembleDraft(d: Draft, formats: ("docx" | "pdf")[] | undefined, opts: RunOpts = {}) {
  const t0 = Date.now()
  d.phase = "assemble"
  saveDraft(d); emit(d, opts.context)
  const missing = d.sections.filter((s) => !sectionText(d, s.key, "vi").trim() || (d.language === "bilingual" && !sectionText(d, s.key, "en").trim()))
  if (missing.length) throw new Error(`các mục chưa có nội dung: ${missing.map((s) => `${s.label} (${s.key})`).join(", ")} – chạy draft_write({draftId, sections:[…]}) trước.`)
  const bi = d.language === "bilingual"
  const part = (lang: "vi" | "en", secs: Section[]) => secs.map((s) => {
    const t = sectionText(d, s.key, lang).trim().split(NL)
    t[0] = headingLine(d, s, lang) // normalised heading (numbering from the plan)
    // annexes of a contract: "(Kèm theo Hợp đồng số …)" under the heading
    if (s.type === "annex" && d.kind === "hop-dong" && !/kèm theo|attached to/i.test(t.slice(1, 4).join(" ")))
      t.splice(1, 0, "", lang === "en" ? "*(Attached to Contract No. …/… dated …)*" : "*(Kèm theo Hợp đồng số …/… ngày … tháng … năm …)*")
    return t.join(NL)
  }).join(NL + NL)
  const mainSecs = d.sections.filter((s) => s.type !== "annex"), annexSecs = d.sections.filter((s) => s.type === "annex")
  const oneLang: "vi" | "en" = d.language === "en" ? "en" : "vi"
  let md = [preamble(d, oneLang), part(oneLang, mainSecs), ""].join(NL)
  let mdEn = bi ? [preamble(d, "en"), part("en", mainSecs), ""].join(NL) : ""
  const notes: string[] = []
  if (bi) {
    const mism = checkBilingualStructure(md, mdEn)
    if (mism.length) throw new Error(`cấu trúc hai bản không khớp: ${mism.slice(0, 6).join(" | ")}`)
    if (d.kind === "hop-dong") {
      const r = ensureLanguageClause(md, mdEn, d.prevailing ?? "vi")
      md = r.vi; mdEn = r.en
      if (r.added) notes.push(`đã thêm điều khoản ngôn ngữ vào ${r.label}`)
    }
  }
  // contracts: annexes after the signature block, each on a new page (doc-store ANNEX_MARKER); reports: in sequence
  if (annexSecs.length) {
    const sep = d.kind === "hop-dong" ? ["", ANNEX_MARKER, "", ""].join(NL) : NL
    md = md.trimEnd() + NL + sep + part(oneLang, annexSecs) + NL
    if (bi) mdEn = mdEn.trimEnd() + NL + sep + part("en", annexSecs) + NL
    if (d.kind === "hop-dong") notes.push("các Phụ lục đặt sau khối chữ ký, mỗi Phụ lục một trang mới")
  }
  let sign: [string, string] | undefined
  if (d.kind === "hop-dong" && d.parties.length >= 2) {
    const lab = (p: Party) => `ĐẠI DIỆN ${(p.short ?? "").toUpperCase()}${p.role ? ` (${p.role.toUpperCase()})` : ""}`
    sign = oneLang === "en" ? [`FOR AND ON BEHALF OF ${(d.parties[0].short ?? "Party A").replace(/^Bên/, "PARTY").toUpperCase()}`, `FOR AND ON BEHALF OF ${(d.parties[1].short ?? "Party B").replace(/^Bên/, "PARTY").toUpperCase()}`] : [lab(d.parties[0]), lab(d.parties[1])]
  }
  // re-assembly (after more fixes) = the next version of the same document (redline against the previous one)
  const parent = d.document ? findDocumentForSession(d.sessionID, d.document.id) : null
  const meta: DocMeta = await saveDocument({
    sessionID: d.sessionID, title: d.title_en && bi ? `${d.title} / ${d.title_en}` : d.title, markdown: md, kind: d.kind, formats, sign, origin: "agent",
    language: d.language, ...(bi ? { markdownEn: mdEn, prevailing: d.prevailing ?? "vi" } : {}),
    ...(parent ? { parent, note: "ghép lại dự thảo sau khi sửa" } : {}),
  })
  d.document = { id: meta.id, version: meta.version, title: meta.title }
  d.phase = "done"
  d.timings.assemble = (d.timings.assemble ?? 0) + (Date.now() - t0)
  saveDraft(d)
  const issues = loadIssues(d)
  emit(d, opts.context, issues)
  return { meta, marker: artifactMarker(meta), md, mdEn, notes, issues }
}

export { outputsRoot }

/** Drafts of a session (newest first). */
export function listDrafts(sessionID: string): Draft[] {
  try {
    return fs.readdirSync(draftsDir(sessionID)).map((id) => loadDraft(sessionID, id)).filter((d): d is Draft => !!d).sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

/**
 * For document_read / document_edit: when `id` is a draft id, or the id is unknown while this session has a draft
 * that is not assembled yet, a message telling the model to assemble first (or which document id to use). Else null.
 */
export function draftHint(sessionID: string, id: string): string | null {
  const key = String(id ?? "").trim()
  const d = DRAFT_ID_RE.test(key) ? loadDraft(sessionID, key) : listDrafts(sessionID).find((x) => !x.document)
  if (!d) return null
  if (d.document) return `"${key}" là mã dự thảo đã ghép thành tài liệu – dùng mã tài liệu ${d.document.id} (phiên bản ${d.document.version}) cho document_read / document_edit.`
  return `Đây là bản nháp chưa gộp (dự thảo "${d.title}", mã ${d.draftId}) – chưa có tài liệu để đọc / sửa. BƯỚC TIẾP THEO: gọi draft_assemble({draftId:"${d.draftId}"}) trước (ghép các mục thành tệp .docx / .pdf và trả về mã tài liệu), rồi mới dùng document_read / document_edit với mã tài liệu đó.`
}
