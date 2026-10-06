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
    const f = fileOf(sessionID)
    // Start on a fresh line if an earlier write was cut off (interrupted process): records are never glued together.
    let lead = ""
    try {
      const fd = fs.openSync(f, "r")
      try { const st = fs.fstatSync(fd); if (st.size) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, st.size - 1); if (b[0] !== 0x0a) lead = "\n" } } finally { fs.closeSync(fd) }
    } catch {}
    fs.appendFileSync(f, lead + JSON.stringify({ ...e, text: e.text.slice(0, 400_000), at: Date.now() }) + "\n")
  } catch {
    /* evidence logging must never break a lookup */
  }
}

/**
 * Evidence lines → records. A broken line (write cut off, or two records glued on one line) never discards the
 * rest of the file: every record that still parses is kept – a whole session must not look like "no sources".
 */
/** A record cut off mid-write: keep its url / title / source and the text up to the cut (marked meta.truncated). */
function salvage(part: string): Evidence | null {
  const str = (k: string, open = false) => {
    const m = part.match(new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)${open ? '(?:"|$)' : '"'}`))
    if (!m) return undefined
    try { return JSON.parse(`"${m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")}"`) as string } catch { return undefined }
  }
  const url = str("url"), source = str("source"), text = str("text", true)
  if (!url || !text) return null
  return { url, title: str("title"), text, source: source ?? "unknown", meta: { truncated: true } }
}

export function parseEvidence(raw: string): Evidence[] {
  const out: Evidence[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)); continue } catch {}
    // glued: '…cut-off record{"url":…}' – recover the complete records that follow the cut
    for (const part of line.split(/(?=\{"url":)/)) {
      try { out.push(JSON.parse(part)); continue } catch {}
      const cut = salvage(part)
      if (cut) out.push(cut)
    }
  }
  return out
}

export function loadEvidence(sessionID: string | undefined): Evidence[] {
  if (!sessionID) return []
  try {
    return parseEvidence(fs.readFileSync(fileOf(sessionID), "utf8"))
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
