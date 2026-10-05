// Server-enforced grounding: when an assistant turn ends without a grounding_check although the answer makes
// legal claims, the server runs the very same check (the agent's grounding tool, imported read-only) on the
// final answer against the session's evidence, and records the verdict with origin "server". A THẤP verdict
// (the model's own or the server's) can trigger ONE hidden repair turn per user turn.
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ROOT } from "./config.mjs"
import { getSetting, q, setSetting } from "./db.mjs"
import { parseSettings } from "./auth.mjs"
import { FINAL_MARK, REPAIR_MARK } from "./events.mjs"

/**
 * Admin settings. serverGrounding (the server-side check + low-confidence warning): default ON.
 * autoRepairLowConfidence = "Cho phép tự tra lại khi độ tin cậy thấp": opt-in since 27/09/2026 – default OFF; when on,
 * each user decides (settings.autoRepair, default off) and the "Tra lại ngay" button is offered on THẤP answers.
 */
export const serverGroundingOn = () => getSetting("serverGrounding", true) !== false
export const autoRepairOn = () => getSetting("autoRepairLowConfidence", false) === true
// One-time migration: the old default (unset or true, i.e. automatic repair for everyone) becomes OFF.
if (getSetting("autoRepairOptInMigrated", false) !== true) {
  if (getSetting("autoRepairLowConfidence", true) !== false) setSetting("autoRepairLowConfidence", false)
  setSetting("autoRepairOptInMigrated", true)
}
export const REPAIR_DISABLED = "Quản trị viên chưa cho phép tự tra lại."
/** Automatic repair for this user's chats: the admin allows it AND the user switched it on. */
export function autoRepairFor(userId) {
  if (!autoRepairOn() || !userId) return false
  const row = q("SELECT settings FROM users WHERE id = ?").get(userId)
  return !!row && parseSettings(row.settings).autoRepair === true
}

export { FINAL_MARK, REPAIR_MARK }
const markedUser = (item, mark) => item?.info?.role === "user" && (item.parts || []).some((p) => p.type === "text" && String(p.text || "").startsWith(mark))
/** Is this raw opencode message (from GET /session/:id/message) our hidden repair prompt? */
export const isRepairPrompt = (item) => markedUser(item, REPAIR_MARK)
/** …our hidden "write the final answer now" prompt? */
export const isFinalPrompt = (item) => markedUser(item, FINAL_MARK)
/** Any hidden server prompt (never a user turn). */
export const isHiddenPrompt = (item) => isRepairPrompt(item) || isFinalPrompt(item)

/** Hidden follow-up when a run ended without a visible final answer (typically after browser / web look-ups). */
export function finalPrompt(locale = "vi") {
  const body =
    locale === "en"
      ? 'You have not written the final answer for the user yet. Based on what you have looked up, write a concise answer now; say clearly "not verified" for anything you could not verify. Do not call any more browser tools. Answer in English (the user does not see this message).'
      : 'Bạn chưa viết câu trả lời cuối cho người dùng. Dựa trên những gì đã tra được, hãy viết câu trả lời ngắn gọn ngay bây giờ; mục nào chưa xác minh được thì nói rõ "chưa xác minh được". Không gọi thêm công cụ trình duyệt. (Người dùng không thấy tin nhắn này.)'
  return `${FINAL_MARK}\n${body}`
}

// Same idea as the client's LEGAL_CLAIM_RE / confidence-badge heuristic, plus the claim kinds the check verifies
// (links, document numbers, percentages, money amounts). Dates / times alone do not count (small talk: "mấy giờ rồi").
const LEGAL_RE = /(?:^|[^\p{L}])(?:Điều|Khoản|Article|Section|Clause)\s+\d+|Bộ luật|Luật\s+\p{Lu}|Nghị định|Thông tư|Nghị quyết|Pháp lệnh|\bDecree\b|\bCircular\b/u
const CLAIM_RE = [
  /https?:\/\/\S+/,
  /\b\d{1,4}\/\d{4}\/[A-ZĐ]{1,6}/, // 36/2005/QH11
  /\d\s?%/,
  /\d[\d.,]*\s?(?:đồng|VND|VNĐ|USD|EUR|triệu|tỷ)\b/iu,
  /\b[AC]-\d{3}-\d{3}\b|\bFR Doc\b|\bCELEX\b|\bG\/(?:TBT|SPS)\//,
]
export const looksLegal = (answer) => {
  const s = String(answer || "")
  return s.trim().length > 0 && (LEGAL_RE.test(s) || CLAIM_RE.some((re) => re.test(s)))
}

let toolP = null
/** The agent's grounding_check tool (loaded lazily; a broken file only disables the server check). */
async function groundingTool() {
  toolP ||= import(pathToFileURL(path.join(ROOT, ".opencode", "tools", "grounding.ts")).href).then((m) => m.check).catch((e) => {
    toolP = null
    throw e
  })
  return toolP
}
let evidenceP = null
const evidenceLib = () => (evidenceP ||= import(pathToFileURL(path.join(ROOT, ".opencode", "lib", "evidence.ts")).href))

/** Unsupported items listed in a grounding_check report (the sections that name what has no basis). */
export function reportItems(report) {
  const out = []
  let on = false
  for (const line of String(report || "").split("\n")) {
    if (/^(Đoạn trích KHÔNG|Đoạn trích chỉ khớp một phần|Link chưa được mở|Con số không thấy|Số tiền không thấy|Số hiệu không thấy)/.test(line)) on = true
    else if (!/^\s+- /.test(line)) on = false
    else if (on) out.push(line.replace(/^\s+- /, "").trim())
  }
  return out.slice(0, 20)
}

/**
 * Run the check on `answer` for session `sid` and record the verdict (origin "server").
 * Returns { level, reasons, claims, supported, unsupported, items, report } or null.
 */
export async function serverCheck(sid, answer) {
  const check = await groundingTool()
  const { loadEvidence, recordEvidence } = await evidenceLib()
  const r = await check.execute({ answer }, { sessionID: sid })
  // The tool returns { output, metadata } (or a plain string in older versions).
  const report = typeof r === "string" ? r : String(r?.output ?? "")
  // The tool recorded its verdict; re-record it flagged as ours, with the unsupported items (last one wins).
  const ev = loadEvidence(sid).filter((e) => e.source === "grounding")
  let v = {}
  try {
    v = JSON.parse(ev.at(-1)?.text || "{}")
  } catch {}
  if (!v.level) return null
  const items = reportItems(report)
  const verdict = { ...v, items, origin: "server" }
  recordEvidence(sid, { url: "grounding://server", text: JSON.stringify(verdict), source: "grounding", meta: { origin: "server" } })
  return { ...verdict, report }
}

/** The model's own THẤP verdict: re-record it with the unsupported items from its report (for the warning). */
export async function annotateModelVerdict(sid, items) {
  const { loadEvidence, recordEvidence } = await evidenceLib()
  const last = loadEvidence(sid).filter((e) => e.source === "grounding").at(-1)
  let v = null
  try {
    v = JSON.parse(last?.text || "null")
  } catch {}
  if (!v?.level || v.items) return
  recordEvidence(sid, { url: "grounding://check", text: JSON.stringify({ ...v, items, origin: "model" }), source: "grounding" })
}

/** The hidden repair prompt (vi/en). */
export function repairPrompt(items, locale = "vi") {
  const list = items.length ? items.map((x) => `- ${x}`).join("\n") : locale === "en" ? "- (see the grounding_check report)" : "- (xem báo cáo grounding_check)"
  const body =
    locale === "en"
      ? `Automatic verification: the following items have no basis in the sources looked up:\n${list}\nLook them up again with the tools (vbpl_*, web_search/web_read, …), correct the answer, call grounding_check, and if there is still no basis say clearly "not verified". Answer the user's question again in full (the user does not see this message).`
      : `Kiểm chứng tự động: các mục sau chưa có căn cứ trong nguồn đã tra:\n${list}\nHãy tra lại bằng công cụ (vbpl_*, web_search/web_read, …), sửa câu trả lời, gọi grounding_check, và nếu vẫn không có căn cứ thì nói rõ "chưa xác minh được". Trả lời lại đầy đủ câu hỏi của người dùng (người dùng không thấy tin nhắn này).`
  return `${REPAIR_MARK}\n${body}`
}
