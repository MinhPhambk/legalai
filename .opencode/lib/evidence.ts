// Per-session evidence store shared by all lookup tools (vbpl_*, trav_*, fedreg_*, eurlex_*, eping_*,
// fta_*, court_*). Every tool records the canonical URL and the FULL text it extracted; grounding_check
// then verifies an answer's links, quotes and figures against exactly what was fetched in that session,
// so confidence is computed from evidence instead of being self-reported by the model.
// Also imported by the Node web server (native TS type-stripping): no enums/namespaces, .ts imports only.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type Evidence = { url: string; title?: string; text: string; source: string; meta?: Record<string, unknown>; at?: number }

// <project>/.sandbox/cache when XDG_CACHE_HOME is not set (e.g. when imported by the web server).
const cacheHome = () => process.env.XDG_CACHE_HOME ?? path.join(fileURLToPath(new URL("../../", import.meta.url)), ".sandbox", "cache")
const dir = () => path.join(cacheHome(), "legalai", "evidence")
const fileOf = (sessionID: string) => path.join(dir(), `${sessionID.replace(/[^\w.-]/g, "_")}.jsonl`)

export function recordEvidence(sessionID: string | undefined, e: Evidence) {
  if (!sessionID || !e?.url || !e.text) return
  try {
    fs.mkdirSync(dir(), { recursive: true })
    fs.appendFileSync(fileOf(sessionID), JSON.stringify({ ...e, text: e.text.slice(0, 400_000), at: Date.now() }) + "\n")
  } catch {
    /* evidence logging must never break a lookup */
  }
}

export function loadEvidence(sessionID: string | undefined): Evidence[] {
  if (!sessionID) return []
  try {
    return fs.readFileSync(fileOf(sessionID), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** Tool-level warnings (e.g. fedreg "⚠ CẢNH BÁO") are recorded as evidence with source "warning". */
export function recordWarning(sessionID: string | undefined, url: string, message: string) {
  recordEvidence(sessionID, { url, text: message, source: "warning" })
}

/**
 * Session fork (web edit / regenerate): copy the evidence of `fromSessionID` into `toSessionID` so
 * grounding_check and artifact lookup (document_read / document_edit) keep working in the fork.
 * Lines already present in the target are not duplicated. Returns the number of entries copied.
 */
export function inheritSession(fromSessionID: string, toSessionID: string): number {
  if (!fromSessionID || !toSessionID || fromSessionID === toSessionID) return 0
  try {
    const src = fs.readFileSync(fileOf(fromSessionID), "utf8").split("\n").filter(Boolean)
    if (!src.length) return 0
    let existing: string[] = []
    try {
      existing = fs.readFileSync(fileOf(toSessionID), "utf8").split("\n").filter(Boolean)
    } catch {}
    const have = new Set(existing)
    const add = src.filter((l) => !have.has(l))
    if (!add.length) return 0
    fs.mkdirSync(dir(), { recursive: true })
    // Inherited history goes first, so the fork's own later entries keep their order after it.
    fs.writeFileSync(fileOf(toSessionID), [...add, ...existing].join("\n") + "\n")
    return add.length
  } catch {
    return 0
  }
}
