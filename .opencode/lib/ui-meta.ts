// Language-neutral UI metadata of a tool result, for the web step list / result cards (web/server/stepview.mjs and
// web/server/resultcards.mjs document the shapes). The model reads ONLY the text `output` (unchanged); the web
// server reads `state.metadata.ui` of the completed tool part. Codes, numbers as plain decimal strings, ISO dates
// and source data as { v, lang } – never pre-rendered Vietnamese / English UI sentences.
import { tool as baseTool } from "@opencode-ai/plugin"

/**
 * Drop-in for `tool` of @opencode-ai/plugin: inside the AI runtime (a real tool context has `messageID`) the tool
 * returns { title, output, metadata } as written; called directly (tests, the web server, other tools passing a
 * bare { sessionID }) it returns the plain text, as before – so callers that expect a string keep working.
 */
export const tool: typeof baseTool = Object.assign(
  ((def: Parameters<typeof baseTool>[0]) => {
    const t = baseTool(def)
    const run = t.execute
    return { ...t, execute: async (args: any, ctx: any) => { const r = await run(args, ctx); return ctx && typeof ctx.messageID === "string" ? r : textOf(r) } }
  }) as typeof baseTool,
  { schema: baseTool.schema },
)

export type Lang = "vi" | "en"
export type Data = { v: string; lang?: Lang }
export type UiMeta = { res?: Record<string, unknown>; doc?: Record<string, unknown>; card?: Record<string, unknown>; [k: string]: unknown }
export type ToolResult = string | { title?: string; output: string; metadata?: Record<string, unknown> }

/** Tool return value with UI metadata (`title` stays empty: the web shows its own localized step name). */
export const withUi = (output: string, ui: UiMeta, title = "") => ({ title, output, metadata: { ui: { v: 1, ...ui } } })

/** The text a tool returned, whichever form (string or { output }) – for tools that call other tools. */
export const textOf = (r: unknown): string => (typeof r === "string" ? r : String((r as { output?: unknown } | null)?.output ?? ""))

/** "26/11/2024" | "2024-11-26" → "2024-11-26"; anything else → undefined. */
export function isoDate(s?: string | null): string | undefined {
  const x = String(s ?? "").trim()
  const ok = (y: string, mo: string, d: string) => (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 ? `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : undefined)
  let m = x.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return ok(m[1], m[2], m[3])
  m = x.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  return m ? ok(m[3], m[2], m[1]) : undefined
}

/** vbpl.vn / anle status phrase → code (same codes as web/server/stepview.mjs STATUS_CODES). */
export function statusCode(s?: string | null): string | undefined {
  const x = String(s ?? "").trim()
  if (/^còn hiệu lực/i.test(x)) return "in_force"
  if (/^hết hiệu lực một phần/i.test(x)) return "partly_expired"
  if (/^hết hiệu lực/i.test(x)) return "expired"
  if (/^chưa có hiệu lực/i.test(x)) return "not_yet"
  if (/^ngưng hiệu lực một phần/i.test(x)) return "partly_suspended"
  if (/^ngưng hiệu lực/i.test(x)) return "suspended"
  if (/^không còn phù hợp/i.test(x)) return "obsolete"
  if (/^còn áp dụng|^đang có hiệu lực/i.test(x)) return "applicable"
  if (/^(?:hết|không còn|ngừng|dừng) áp dụng|bãi bỏ|hủy bỏ|huỷ bỏ/i.test(x)) return "not_applicable"
  return undefined
}

/** Result count for the step list ("8 results" / "no results"). */
export const count = (n: number, unit: string) => ({ t: "count", n: Math.max(0, Math.floor(n) || 0), unit })
/** Data string with its language. */
export const data = (v: unknown, lang?: Lang): Data | undefined => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim()
  return s ? (lang ? { v: s, lang } : { v: s }) : undefined
}
