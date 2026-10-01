// Follow-up question suggestions ("gợi ý câu hỏi tiếp theo") after an assistant turn.
//  • One lightweight chat-completions call to the SAME model / provider the platform uses: model id from the
//    live opencode config, provider baseURL + key from ../opencode.json with {env:…} resolved from ../.env.
//    The key never leaves this module (not logged, not sent to the browser).
//  • Stored per (branch session, user turn) so reloads show the same chips; a new version (edit /
//    regenerate) is a new session → new suggestions. Streamed to open chat streams as a "followups" event.
//  • Admin setting followupCount (0–5, default 3; 0 = off); users can hide them (settings.showFollowups).
import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./config.mjs"
import { db, getSetting, q } from "./db.mjs"

db.exec(`CREATE TABLE IF NOT EXISTS followups (
  session_id TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  locale     TEXT NOT NULL,
  items      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
);
CREATE INDEX IF NOT EXISTS followups_chat ON followups(chat_id);`)

export const DEFAULT_FOLLOWUPS = 3
export const followupCount = () => {
  const n = Number(getSetting("followupCount", DEFAULT_FOLLOWUPS))
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : DEFAULT_FOLLOWUPS
}

// ---- provider config (server-side only) ------------------------------------------------------------
function readEnvFile() {
  const out = {}
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2]
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
      else v = v.replace(/\s+#.*$/, "")
      out[m[1]] = v
    }
  } catch {}
  return out
}
let cfgCache = { at: 0, value: null }
/** { baseURL, apiKey, model } for "provider/model" (or the opencode.json default), or null. */
export function providerConfig(fullModel) {
  if (Date.now() - cfgCache.at > 60_000) cfgCache = { at: Date.now(), value: null }
  const key = String(fullModel || "")
  cfgCache.value ??= {}
  if (key in cfgCache.value) return cfgCache.value[key]
  let result = null
  try {
    const oc = JSON.parse(fs.readFileSync(path.join(ROOT, "opencode.json"), "utf8"))
    const env = { ...readEnvFile(), ...process.env }
    const sub = (v) => String(v ?? "").replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, k) => env[k] ?? "")
    const full = key || String(oc.model || "")
    const slash = full.indexOf("/")
    const provider = oc.provider?.[full.slice(0, slash)]
    const baseURL = sub(provider?.options?.baseURL).replace(/\/+$/, "")
    if (provider && baseURL) result = { baseURL, apiKey: sub(provider.options?.apiKey), model: full.slice(slash + 1) }
  } catch {}
  cfgCache.value[key] = result
  return result
}

// ---- generation ------------------------------------------------------------------------------------
/** Requests for clearly unlawful help – suggestions matching this are dropped. */
const RED_FLAG = /trốn thuế|né thuế|lách luật|lách thuế|làm giả|giả mạo|hối lộ|đưa hối|rửa tiền|tẩu tán|gian lận|trốn tránh nghĩa vụ|qua mặt|che giấu|evad\w* tax|tax evasion|forg(e|ery|ing)|brib\w*|launder\w*|hide assets|circumvent|fraud\w*|fake (invoice|document)/i

export function cleanSuggestions(arr, n) {
  const seen = new Set()
  const out = []
  for (let s of Array.isArray(arr) ? arr : []) {
    if (typeof s !== "string") continue
    s = s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "")
    if (s.length < 8 || RED_FLAG.test(s)) continue
    if (s.length > 90) s = s.slice(0, 89).replace(/\s+\S*$/, "") + "…"
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
    if (out.length >= n) break
  }
  return out
}

/** Language of the user's question, decided in code (the model tends to follow the Vietnamese legal quotes
 *  in the answer instead): mostly unaccented text with common English words → en; Vietnamese diacritics → vi. */
export function questionLanguage(question, fallback) {
  const q = String(question || "")
  const letters = (q.match(/\p{L}/gu) || []).length
  if (letters < 8) return fallback
  const vi = (q.match(/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/giu) || []).length
  const en = (q.toLowerCase().match(/\b(the|is|are|what|which|how|can|does|do|of|and|for|under|with|there|any|should|my|a|an|in|on|to)\b/g) || []).length
  if (vi / letters > 0.04) return "vi"
  if (en >= 2) return "en"
  return fallback
}

function buildPrompt(question, answer, locale, n) {
  const lang = questionLanguage(question, locale === "en" ? "en" : "vi") === "en" ? "English" : "Vietnamese (tiếng Việt)"
  return [
    {
      role: "system",
      content:
        `You suggest follow-up questions for a legal assistant used by Vietnamese small and medium-sized businesses (commercial contracts, trade remedies). ` +
        `Write exactly ${n} short (at most 90 characters), specific, non-overlapping next questions the user would naturally ask after this answer, written in ${lang} (even if the Answer quotes Vietnamese law). ` +
        `Each must be a question the user asks the assistant, lawful, and grounded in the conversation. No numbering, no quotes around items. ` +
        `Reply with a JSON array of strings only.`,
    },
    { role: "user", content: `Question:\n${String(question || "").slice(0, 2000)}\n\nAnswer:\n${String(answer || "").slice(0, 6000)}` },
  ]
}

/** Returns up to n suggestions, or [] on any failure (silently). */
const TIMEOUT_MS = Number(process.env.FOLLOWUP_TIMEOUT_MS) > 0 ? Number(process.env.FOLLOWUP_TIMEOUT_MS) : 30_000
export async function generateFollowups({ fullModel, question, answer, locale, n, timeoutMs = TIMEOUT_MS, fetchImpl = fetch }) {
  if (!n || !answer?.trim()) return []
  const cfg = providerConfig(fullModel)
  if (!cfg) return []
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const call = (extra) =>
      fetchImpl(`${cfg.baseURL}/chat/completions`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, messages: buildPrompt(question, answer, locale, n), temperature: 0.3, max_tokens: 600, stream: false,
          // Suggestions need no reasoning: with thinking on, DeepSeek/Qwen spend the token budget (and 20–40 s)
          // on reasoning and often return no content.
          chat_template_kwargs: { thinking: false, enable_thinking: false }, ...extra }),
      })
    // reasoning_effort "none" helps some providers but vLLM (GPUStack) only accepts low|medium|high → HTTP 400:
    // retry once without it.
    let r = await call({ reasoning_effort: "none" })
    if (r.status === 400) r = await call({})
    if (!r.ok) return []
    const data = await r.json()
    const text = String(data?.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "")
    const i = text.indexOf("[")
    const j = text.lastIndexOf("]")
    if (i < 0 || j <= i) return []
    return cleanSuggestions(JSON.parse(text.slice(i, j + 1)), n)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ---- storage ---------------------------------------------------------------------------------------
export function storedFollowups(sessionId, turn) {
  const r = q("SELECT items FROM followups WHERE session_id = ? AND turn = ?").get(sessionId, turn)
  if (!r) return null
  try {
    return JSON.parse(r.items)
  } catch {
    return []
  }
}
export function storeFollowups(sessionId, turn, chatId, locale, items) {
  q("INSERT INTO followups (session_id, turn, chat_id, locale, items, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, turn) DO UPDATE SET items = excluded.items, locale = excluded.locale, created_at = excluded.created_at").run(
    sessionId, turn, chatId, locale, JSON.stringify(items), Date.now())
}
