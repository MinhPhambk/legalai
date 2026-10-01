// Long-document drafting progress (draft_* tools, ../docs/DRAFTING.md "Progress contract").
//  • cleanDraft(): whitelist + length caps of the `draft` progress object before it reaches a browser.
//  • draftForPart(): the object for one tool part – state.metadata.draft (final / live) or, while the tool is
//    running, <outputs>/<sessionID>/drafts/<draftId>/progress.json (the host may not forward live metadata).
//  • startDraftWatcher(oc): while a draft_* part runs, polls its progress.json and re-emits the part with
//    metadata.draft through the client's own event fan-out (SSE + long-poll get it like any part update).
import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./config.mjs"
import { scrubText } from "./sanitize.mjs"

// Same resolution as doc-store outputsRoot() / server/artifacts.mjs (kept here to avoid an import cycle).
const OUTPUT_DIR = process.env.LEGALAI_OUTPUTS_DIR ? path.resolve(process.env.LEGALAI_OUTPUTS_DIR) : path.join(ROOT, ".sandbox", "outputs")
export const DRAFT_TOOL_RE = /^draft_(plan|write|check|fix|assemble|status)$/
const DRAFT_ID_RE = /^d-\d{8}-[0-9a-f]{6}$/
const SESSION_RE = /^[A-Za-z0-9_-]{1,80}$/
const DOC_ID_RE = /^\d{14}-[0-9a-f]{6}$/
const PHASES = new Set(["plan", "write", "check", "fix", "assemble", "done", "failed"])
const STATUSES = new Set(["pending", "writing", "written", "failed", "checked", "fixed"])
const KINDS = new Set(["hop-dong", "bao-cao", "van-ban"])
const LANGS = new Set(["vi", "en", "bilingual"])

const str = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n) : "")
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : undefined)

/** Safe, minimal copy of a DraftProgress object (null when it is not one). */
export function cleanDraft(d, locale = "vi") {
  if (!d || typeof d !== "object" || !DRAFT_ID_RE.test(String(d.draftId || ""))) return null
  const sc = (s) => scrubText(s, locale)
  const sections = (Array.isArray(d.sections) ? d.sections : []).slice(0, 60).map((s) => ({
    key: str(s?.key, 60),
    label: sc(str(s?.label, 40)),
    heading: sc(str(s?.heading, 140)),
    status: STATUSES.has(s?.status) ? s.status : "pending",
    ...(num(s?.words) ? { words: num(s.words) } : {}),
    ...(num(s?.issues) ? { issues: num(s.issues) } : {}),
  }))
  const t = d.timings && typeof d.timings === "object" ? d.timings : {}
  const doc = d.document && DOC_ID_RE.test(String(d.document.id || "")) ? { id: d.document.id, version: num(d.document.version) || 1, title: sc(str(d.document.title, 160)) } : null
  return {
    draftId: d.draftId,
    title: sc(str(d.title, 160)),
    kind: KINDS.has(d.kind) ? d.kind : "van-ban",
    language: LANGS.has(d.language) ? d.language : "vi",
    phase: PHASES.has(d.phase) ? d.phase : "plan",
    sections,
    issues: { errors: num(d.issues?.errors) || 0, warnings: num(d.issues?.warnings) || 0, suggestions: num(d.issues?.suggestions) || 0 },
    round: num(d.round) || 0,
    startedAt: num(d.startedAt) || null,
    updatedAt: num(d.updatedAt) || null,
    timings: Object.fromEntries(["plan", "write", "check", "fix", "assemble"].filter((k) => num(t[k]) != null).map((k) => [k, num(t[k])])),
    ...(doc ? { document: doc } : {}),
    ...(d.phase === "failed" && d.error ? { error: sc(str(d.error, 300)) } : {}),
  }
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {
    return null
  }
}

/**
 * progress.json of a draft: by id (this session's folder first, then any session folder – forks keep using the
 * parent's draft), or without an id (draft_plan still running) the newest one of this session updated after `since`.
 */
export function readProgress(sessionID, draftId, since = 0) {
  if (!SESSION_RE.test(String(sessionID || ""))) return null
  if (draftId && DRAFT_ID_RE.test(draftId)) {
    const own = readJson(path.join(OUTPUT_DIR, sessionID, "drafts", draftId, "progress.json"))
    if (own) return own
    try {
      for (const s of fs.readdirSync(OUTPUT_DIR)) {
        if (!SESSION_RE.test(s) || s === sessionID) continue
        const f = path.join(OUTPUT_DIR, s, "drafts", draftId, "progress.json")
        if (fs.existsSync(f)) return readJson(f)
      }
    } catch {}
    return null
  }
  const dir = path.join(OUTPUT_DIR, sessionID, "drafts")
  let best = null
  try {
    for (const id of fs.readdirSync(dir)) {
      if (!DRAFT_ID_RE.test(id)) continue
      const p = readJson(path.join(dir, id, "progress.json"))
      if (p && (p.updatedAt || 0) >= since - 5000 && (!best || p.updatedAt > best.updatedAt)) best = p
    }
  } catch {}
  return best
}

/** The progress object for a draft_* tool part (null for other tools / nothing known yet). */
export function draftForPart(p, locale) {
  if (p?.type !== "tool" || !DRAFT_TOOL_RE.test(p.tool || "")) return null
  const s = p.state || {}
  let d = s.metadata?.draft
  if (!d && s.status !== "error") d = readProgress(p.sessionID, typeof s.input?.draftId === "string" ? s.input.draftId : "", s.time?.start || 0)
  return cleanDraft(d, locale)
}

/** Live progress while draft_* tools run: poll progress.json, re-emit the part when it changes. */
export function startDraftWatcher(oc, { intervalMs = 1500, maxMs = 45 * 60_000 } = {}) {
  const running = new Map() // partID -> { part, seen, at }
  oc.onAny((ev) => {
    if (ev.type !== "message.part.updated" || ev.webInjected) return
    const part = ev.properties?.part
    if (part?.type !== "tool" || !DRAFT_TOOL_RE.test(part.tool || "")) return
    const st = part.state?.status
    if (st === "running" || st === "pending") {
      const cur = running.get(part.id)
      running.set(part.id, { part, seen: cur?.seen ?? part.state?.metadata?.draft?.updatedAt ?? 0, at: cur?.at ?? Date.now() })
    } else running.delete(part.id)
  })
  const timer = setInterval(() => {
    for (const [id, r] of running) {
      if (Date.now() - r.at > maxMs) {
        running.delete(id)
        continue
      }
      const s = r.part.state || {}
      const d = readProgress(r.part.sessionID, typeof s.input?.draftId === "string" ? s.input.draftId : "", s.time?.start || r.at)
      if (!d || !d.updatedAt || d.updatedAt === r.seen) continue
      r.seen = d.updatedAt
      const part = { ...r.part, state: { ...s, metadata: { ...(s.metadata || {}), draft: d } } }
      try {
        oc.inject({ type: "message.part.updated", webInjected: true, properties: { sessionID: part.sessionID, part } })
      } catch (e) {
        console.warn("[drafts] inject failed:", e.message)
      }
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
