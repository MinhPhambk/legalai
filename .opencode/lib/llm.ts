// Direct chat-completions calls to the platform's own model provider (OpenAI-compatible, e.g. Qwen on
// GPUStack), used by tools that orchestrate their own LLM sub-calls (draft_* – long-document drafting).
// Provider baseURL / key come from ../../opencode.json with {env:…} resolved from process.env (run.sh
// loads .env) or, when imported outside opencode (tests), from ../../.env. Keys are never logged or
// returned. Node 24 type-stripping compatible (no enums / namespaces).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {}
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

export type ProviderCfg = { baseURL: string; apiKey: string; model: string; full: string }

/** Model id "provider/model" of the running session (tool context), env override, or opencode.json default. */
export function sessionModel(context?: any): string {
  if (process.env.ND45_DRAFT_MODEL) return process.env.ND45_DRAFT_MODEL
  const m = context?.extra?.model
  const pid = m?.providerID, mid = m?.api?.id ?? m?.id ?? m?.modelID
  if (pid && mid) return `${pid}/${mid}`
  try {
    const oc = JSON.parse(fs.readFileSync(path.join(ROOT, "opencode.json"), "utf8"))
    return String(oc.model || "")
  } catch {
    return ""
  }
}

export function providerConfig(fullModel?: string): ProviderCfg | null {
  try {
    const oc = JSON.parse(fs.readFileSync(path.join(ROOT, "opencode.json"), "utf8"))
    const env: Record<string, string | undefined> = { ...readEnvFile(), ...process.env }
    const sub = (v: unknown) => String(v ?? "").replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, k) => env[k] ?? "")
    const full = fullModel || String(oc.model || "")
    const slash = full.indexOf("/")
    if (slash < 0) return null
    const provider = oc.provider?.[full.slice(0, slash)]
    const baseURL = sub(provider?.options?.baseURL).replace(/\/+$/, "")
    if (!provider || !baseURL) return null
    return { baseURL, apiKey: sub(provider.options?.apiKey), model: full.slice(slash + 1), full }
  } catch {
    return null
  }
}

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string }
export type ChatOpts = {
  model?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
  /** reasoning off (default) – fast non-reasoning calls; Qwen needs chat_template_kwargs.enable_thinking=false */
  thinking?: boolean
}
export type ChatResult = { text: string; finish: string; usage?: any; ms: number; attempts: number }

export class LlmError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "LlmError"
    this.status = status
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One chat completion with timeout + retries (network errors, 5xx, 429, empty content). */
export async function chat(messages: ChatMsg[], opts: ChatOpts = {}): Promise<ChatResult> {
  const cfg = providerConfig(opts.model)
  if (!cfg) throw new LlmError("không đọc được cấu hình nhà cung cấp mô hình (opencode.json / .env)")
  const retries = opts.retries ?? 2
  const t0 = Date.now()
  let last: any
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new LlmError("đã hủy")
    const ctl = new AbortController()
    const onAbort = () => ctl.abort()
    opts.signal?.addEventListener("abort", onAbort)
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 240_000)
    try {
      const r = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: cfg.model, messages, stream: false,
          temperature: opts.temperature ?? 0.3,
          max_tokens: opts.maxTokens ?? 4000,
          // Qwen rejects reasoning_effort; thinking is switched off through the chat template instead.
          chat_template_kwargs: opts.thinking ? { enable_thinking: true, thinking: true } : { enable_thinking: false, thinking: false },
        }),
      })
      if (!r.ok) {
        const body = (await r.text().catch(() => "")).slice(0, 300)
        last = new LlmError(`HTTP ${r.status}: ${body}`, r.status)
        if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) throw last
      } else {
        const data: any = await r.json()
        const ch = data?.choices?.[0]
        const text = String(ch?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim()
        if (text) return { text, finish: String(ch?.finish_reason ?? ""), usage: data?.usage, ms: Date.now() - t0, attempts: attempt + 1 }
        last = new LlmError("mô hình trả về nội dung rỗng")
      }
    } catch (e: any) {
      if (e instanceof LlmError && e.status && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408) throw e
      last = e?.name === "AbortError" ? new LlmError(opts.signal?.aborted ? "đã hủy" : "quá thời gian chờ mô hình") : e
      if (opts.signal?.aborted) throw last
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
    }
    if (attempt < retries) await sleep(1500 * (attempt + 1))
  }
  throw last instanceof Error ? last : new LlmError(String(last))
}

/** Extract the first JSON value (object or array) from a model reply. */
export function parseJsonLoose(text: string): any {
  const t = text.replace(/```(?:json)?/g, "")
  const starts = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0)
  if (!starts.length) throw new Error("không có JSON")
  const s = Math.min(...starts)
  const close = t[s] === "{" ? "}" : "]"
  for (let e = t.lastIndexOf(close); e > s; e = t.lastIndexOf(close, e - 1)) {
    try {
      return JSON.parse(t.slice(s, e + 1))
    } catch {}
  }
  throw new Error("JSON không hợp lệ")
}

/** Run async jobs with a concurrency limit, preserving order of results. */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}
