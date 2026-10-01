// Admin-only model switcher. The models come from the providers in ../opencode.json (read at runtime, never
// edited); the choice is stored in app_settings.agentModel = "providerID/modelID" and passed to opencode on
// every prompt (sendPrompt) and to the follow-up suggestions. Unset / unknown → opencode.json "model".
// Nothing here is ever sent to normal users: model names, providers and test results are admin-only, and the
// API key / base URL never leave this module (not logged, not returned).
import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./config.mjs"
import { getSetting, setSetting } from "./db.mjs"
import { providerConfig } from "./followups.mjs"


let ocCache = { at: 0, value: null }
function readOpencodeJson() {
  if (ocCache.value && Date.now() - ocCache.at < 30_000) return ocCache.value
  let v = {}
  try {
    v = JSON.parse(fs.readFileSync(path.join(ROOT, "opencode.json"), "utf8"))
  } catch {}
  ocCache = { at: Date.now(), value: v }
  return v
}

/** Provider label for the admin screen, without the parenthesised hosting note of opencode.json names. */
const providerLabel = (name) => String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim()

/** [{ id, providerID, modelID, name, provider, toolCall, reasoning }] – display fields only. */
export function listModels() {
  const oc = readOpencodeJson()
  const out = []
  for (const [providerID, p] of Object.entries(oc.provider || {})) {
    for (const [modelID, m] of Object.entries(p?.models || {})) {
      const id = `${providerID}/${modelID}`
      out.push({ id, providerID, modelID, name: String(m?.name || modelID), provider: providerLabel(p?.name) || providerID, toolCall: m?.tool_call !== false, reasoning: !!m?.reasoning })
    }
  }
  return out
}
export const defaultModelId = () => String(readOpencodeJson().model || "")
/** The model new prompts use: the admin choice when it still exists in opencode.json, else the default. */
export function activeModelId() {
  const chosen = getSetting("agentModel", "")
  if (chosen && listModels().some((m) => m.id === chosen)) return chosen
  return defaultModelId()
}
/** Body field for POST /session/:id/prompt_async (opencode 1.18: model: { providerID, modelID }). */
export function promptModel() {
  const id = activeModelId()
  const slash = id.indexOf("/")
  return slash > 0 ? { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) } : undefined
}
export function setActiveModel(id) {
  if (!id) return setSetting("agentModel", "")
  if (!listModels().some((m) => m.id === id)) throw Object.assign(new Error("unknown model"), { status: 400 })
  setSetting("agentModel", id)
}
/** Admin stats card. */
export function activeModelInfo() {
  const id = activeModelId()
  const m = listModels().find((x) => x.id === id)
  return m ? { id, name: m.name, provider: m.provider } : id ? { id, name: id, provider: "?" } : null
}

/**
 * Tiny health check: one chat-completions call with a single tool schema, to the provider in opencode.json
 * (baseURL / key resolved from ../.env). → { ok, ms, toolCall, status?, error? } – never includes the key.
 */
export async function testModel(id, { timeoutMs = 45_000, fetchImpl = fetch } = {}) {
  const cfg = listModels().some((m) => m.id === id) ? providerConfig(id) : null
  if (!cfg) return { ok: false, ms: 0, toolCall: false, error: "Không đọc được cấu hình nhà cung cấp (baseURL / khoá)." }
  const scrub = (s) => {
    let t = String(s || "")
    if (cfg.apiKey) t = t.split(cfg.apiKey).join("…")
    return t.replace(/Bearer\s+\S+/gi, "Bearer …").replace(/(sk|nvapi|key)[-_][\w-]{8,}/gi, "…").replace(/\s+/g, " ").slice(0, 240)
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const r = await fetchImpl(`${cfg.baseURL}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0,
        max_tokens: 300,
        messages: [
          { role: "system", content: "You are a test harness. When asked for a date calculation, call the provided tool." },
          { role: "user", content: "Use the clock_calc tool: what date is 30 days after 2026-01-15?" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "clock_calc",
              description: "Add a number of days to a date (YYYY-MM-DD).",
              parameters: { type: "object", properties: { from: { type: "string" }, add_days: { type: "integer" } }, required: ["from", "add_days"] },
            },
          },
        ],
        tool_choice: "auto",
        chat_template_kwargs: { thinking: false, enable_thinking: false },
      }),
    })
    const ms = Date.now() - t0
    if (!r.ok) {
      let body = ""
      try {
        body = await r.text()
      } catch {}
      return { ok: false, ms, toolCall: false, status: r.status, error: scrub(`HTTP ${r.status}${body ? ": " + body : ""}`) }
    }
    const data = await r.json()
    const msg = data?.choices?.[0]?.message || {}
    const call = (msg.tool_calls || []).find((c) => c?.function?.name === "clock_calc")
    let args = null
    try {
      args = call ? JSON.parse(call.function.arguments || "{}") : null
    } catch {}
    const toolCall = !!(args && /2026-01-15/.test(String(args.from)) && Number(args.add_days) === 30)
    return { ok: true, ms, toolCall, status: r.status, ...(toolCall ? {} : { error: call ? "Gọi công cụ nhưng tham số sai." : "Không gọi công cụ." }) }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, toolCall: false, error: e.name === "AbortError" ? `Quá thời gian (${Math.round(timeoutMs / 1000)} s).` : scrub(e.message) }
  } finally {
    clearTimeout(timer)
  }
}
