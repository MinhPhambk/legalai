// Visual store shared by diagram_create / image_fetch / source_snapshot: every visual (an Archify diagram, a
// free-licensed or official image, a screenshot of an official page / PDF page) is an immutable record in
//   <outputs>/<sessionID>/visuals/<id>.json   (+ <id>.<role>.<ext> files)
// – a SUB-folder, so the document store / web artifact routes (which read <outputs>/<sessionID>/*.json) never see it.
// <outputs> = $LEGALAI_OUTPUTS_DIR, else $XDG_CACHE_HOME/../outputs, else <project>/.sandbox/outputs (same as
// doc-store.ts). The web server (web/server/visuals.mjs) serves them owner- / share-scoped.
// Markers the model copies into its answer (the web renders them inline, the CLI shows them as text):
//   diagram → a line `[[diagram:<id>]]`
//   image / snapshot → `![<caption>](visual:<id>)` followed by an italic credit line.
// Also importable by Node (native TS type-stripping): no enums / namespaces, .ts imports only.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

export const VISUAL_ID_RE = /^v\d{14}-[0-9a-f]{6}$/
export type VisualKind = "diagram" | "image" | "snapshot"
export type VisualRole = "svg" | "png-light" | "png-dark" | "image" | "ir" | "html"
export type VisualFile = { name: string; role: VisualRole; format: string; bytes: number }
export type Attribution = {
  title: string
  author: string
  license: string
  license_url?: string
  source_url: string
  domain: string
  /** ready-made credit line in the answer language, e.g. "Ảnh: X – CC BY-SA 4.0, nguồn commons.wikimedia.org" */
  credit: string
  attribution_required?: boolean
}
export type VisualMeta = {
  id: string
  kind: VisualKind
  title: string
  caption: string
  lang: "vi" | "en"
  sessionID: string
  createdAt: string
  width: number
  height: number
  files: VisualFile[]
  diagram_type?: string
  attribution?: Attribution
  /** where a snapshot / image came from */
  source?: { url: string; page?: number; region?: string; official?: string }
  checks?: { passed: number; total: number; profile: string; warnings: number }
  [k: string]: unknown
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export const outputsRoot = () =>
  process.env.LEGALAI_OUTPUTS_DIR ?? (process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, "..", "outputs") : path.join(ROOT, ".sandbox", "outputs"))
export const visualsDir = (sessionID: string) => path.join(outputsRoot(), String(sessionID || "no-session").replace(/[^\w.-]/g, "_"), "visuals")
export const newVisualId = () => `v${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`

const EXT: Record<string, string> = { svg: "svg", png: "png", webp: "webp", jpeg: "jpg", json: "json", html: "html" }

export type SaveVisualInput = Omit<VisualMeta, "id" | "createdAt" | "files" | "sessionID"> & {
  sessionID?: string
  /** role → { format, data } */
  blobs: { role: VisualRole; format: keyof typeof EXT; data: Buffer | string }[]
}

/** Write the files + metadata of a new visual; returns its metadata. */
export function saveVisual(input: SaveVisualInput): VisualMeta {
  const sid = input.sessionID || "no-session"
  const dir = visualsDir(sid)
  fs.mkdirSync(dir, { recursive: true })
  const id = newVisualId()
  const files: VisualFile[] = []
  for (const b of input.blobs) {
    const name = `${id}.${b.role}.${EXT[b.format]}`
    const buf = typeof b.data === "string" ? Buffer.from(b.data, "utf8") : b.data
    fs.writeFileSync(path.join(dir, name), buf)
    files.push({ name, role: b.role, format: b.format, bytes: buf.length })
  }
  const { blobs, sessionID, ...rest } = input
  const meta: VisualMeta = { ...rest, id, sessionID: sid, createdAt: new Date().toISOString(), files }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2))
  return meta
}

/** Metadata of a visual in the given sessions' folders only. */
export function findVisual(sessionIDs: string[], id: string): VisualMeta | null {
  if (!VISUAL_ID_RE.test(String(id))) return null
  for (const sid of sessionIDs) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(visualsDir(sid), `${id}.json`), "utf8"))
      if (m?.id === id) return m
    } catch {}
  }
  return null
}

export const diagramMarker = (id: string) => `[[diagram:${id}]]`
const oneLine = (s: string, n: number) => String(s ?? "").replace(/[\r\n\[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n)
/** Markdown the model pastes right after the paragraph the image illustrates: image + italic credit line. */
export const imageSnippet = (m: VisualMeta) => `![${oneLine(m.caption || m.title, 160)}](visual:${m.id})\n*${oneLine(m.attribution?.credit ?? "", 300).replace(/\*/g, "")}*`
