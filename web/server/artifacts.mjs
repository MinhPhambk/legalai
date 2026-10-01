// Generated / imported documents (agent tools document_create + document_edit, uploads imported via
// doc-store): preview, downloads, version chain and diffs – owner- or share-scoped.
// Files live in <ROOT>/.sandbox/outputs/<sessionID>/<slug>-<artifactId>.{json,html,md,docx,pdf,thay-doi.docx}.
// Every lookup is confined to the output folders of the chat's own sessions; file names come from the
// metadata and must resolve inside that folder.
import fs from "node:fs"
import { resolveLocale, tr } from "./i18n.mjs"
import path from "node:path"
import { ROOT, UPLOAD_DIR } from "./config.mjs"
import { q } from "./db.mjs"
import { requireUser } from "./auth.mjs"
import { ARTIFACT_ID_RE, artifactDescriptor } from "./events.mjs"
import { diffText } from "./diff.mjs"
import { logAdminAccess } from "./audit.mjs"

// Same resolution as ../.opencode/lib/doc-store.ts outputsRoot() (the web server never sets XDG_CACHE_HOME).
export const OUTPUT_DIR = process.env.LEGALAI_OUTPUTS_DIR ? path.resolve(process.env.LEGALAI_OUTPUTS_DIR) : path.join(ROOT, ".sandbox", "outputs")
const sessionDir = (sid) => path.join(OUTPUT_DIR, String(sid).replace(/[^\w.-]/g, "_"))
const MAX_META_BYTES = 512 * 1024
const MAX_MD_BYTES = 600 * 1024

// ---- metadata ------------------------------------------------------------------------------------
const metaCache = new Map() // file -> { mtime, meta }
function readMeta(file) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  if (st.size > MAX_META_BYTES) return null
  const hit = metaCache.get(file)
  if (hit && hit.mtime === st.mtimeMs) return hit.meta
  let meta = null
  try {
    meta = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!meta || typeof meta !== "object" || !ARTIFACT_ID_RE.test(meta.id)) meta = null
  } catch {}
  metaCache.set(file, { mtime: st.mtimeMs, meta })
  if (metaCache.size > 2000) metaCache.delete(metaCache.keys().next().value)
  return meta
}

/** Every artifact metadata in the output folders of the given sessions: [{ dir, meta }] (deduped by id). */
function listMetas(sessionIds) {
  const out = []
  const seen = new Set()
  for (const sid of sessionIds) {
    const dir = sessionDir(sid)
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      const m = n.match(/-(\d{14}-[0-9a-f]{6})\.json$/)
      if (!m || seen.has(m[1])) continue
      const meta = readMeta(path.join(dir, n))
      if (!meta || meta.id !== m[1]) continue
      seen.add(meta.id)
      out.push({ dir, meta })
    }
  }
  return out
}

/** Find an artifact's metadata in the output folders of the given sessions (never outside them). */
function locate(sessionIds, artifactId) {
  if (!ARTIFACT_ID_RE.test(artifactId)) return null
  for (const sid of sessionIds) {
    const dir = sessionDir(sid)
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    const metaName = names.find((n) => n.endsWith(`-${artifactId}.json`))
    if (!metaName) continue
    const meta = readMeta(path.join(dir, metaName))
    if (meta?.id === artifactId) return { dir, meta }
  }
  return null
}

/**
 * Mark a document imported from an OCR'd scan (doc-store importDocument does not know about OCR): adds
 * meta.ocr = { engine, pages, totalPages } to its metadata file in the session folder. Never throws.
 */
export function markArtifactOcr(sid, artifactId, ocr) {
  try {
    const found = locate([sid], artifactId)
    if (!found || found.meta.ocr) return false
    const name = fs.readdirSync(found.dir).find((n) => n.endsWith(`-${artifactId}.json`))
    const file = name && path.join(found.dir, name)
    if (!file) return false
    const meta = JSON.parse(fs.readFileSync(file, "utf8"))
    meta.ocr = { engine: ocr.engine, pages: ocr.pages, totalPages: ocr.totalPages }
    fs.writeFileSync(file, JSON.stringify(meta, null, 2))
    metaCache.delete(file)
    return true
  } catch (e) {
    console.warn("[artifacts] OCR mark failed:", String(e.message).slice(0, 160))
    return false
  }
}

const rootOf = (meta) => (ARTIFACT_ID_RE.test(meta.root_id) ? meta.root_id : meta.id)
const versionOf = (meta) => (Number.isInteger(Number(meta.version)) && Number(meta.version) >= 1 ? Number(meta.version) : 1)

/** All versions sharing the artifact's root, ordered v1 → vn (ties by creation time). */
function chainOf(sessionIds, found) {
  const root = rootOf(found.meta)
  return listMetas(sessionIds)
    .filter((x) => rootOf(x.meta) === root)
    .sort((a, b) => versionOf(a.meta) - versionOf(b.meta) || String(a.meta.createdAt || "").localeCompare(String(b.meta.createdAt || "")) || a.meta.id.localeCompare(b.meta.id))
}

/** Resolve a file name from the metadata inside `dir` only (path traversal safe). */
function fileIn(dir, name) {
  if (!name || typeof name !== "string" || name.length > 255 || name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0")) return null
  const full = path.resolve(dir, name)
  if (path.dirname(full) !== path.resolve(dir) || !fs.existsSync(full)) return null
  return full
}

const ORIGINAL_TYPES = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

/**
 * The original uploaded file of an imported document: a copy named in the metadata (files[format=original]
 * or `original`) inside the artifact folder, else the upload itself via upload_docs – only an upload of
 * the chat's owner, stored under that user's upload folder.
 */
function originalOf(found, ownerId) {
  const { dir, meta } = found
  if (meta.origin !== "upload") return null
  const named = meta.files?.find?.((f) => f?.format === "original")?.name || (typeof meta.original === "string" ? meta.original : meta.original?.name)
  const inDir = fileIn(dir, named)
  if (inDir && ORIGINAL_TYPES[path.extname(inDir).toLowerCase()]) {
    const display = typeof meta.original_name === "string" ? meta.original_name : typeof meta.original?.displayName === "string" ? meta.original.displayName : null
    return { file: inDir, name: display || `${meta.title || "tai-lieu"}${path.extname(inDir).toLowerCase()}` }
  }
  const row = q(
    "SELECT u.stored_path, u.name, u.user_id FROM upload_docs d JOIN uploads u ON u.id = d.upload_id WHERE d.artifact_id = ? AND d.user_id = ? AND u.user_id = ? LIMIT 1",
  ).get(meta.id, ownerId, ownerId)
  if (!row) return null
  const userDir = path.resolve(UPLOAD_DIR, row.user_id)
  const full = path.resolve(row.stored_path)
  if (path.dirname(full) !== userDir || !fs.existsSync(full)) return null
  if (!ORIGINAL_TYPES[path.extname(full).toLowerCase()]) return null
  return { file: full, name: row.name }
}

const asciiName = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120)
const safeBase = (s) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)
const niceName = (title, ext) => `${safeBase(title) || "tai-lieu"}.${ext}`

const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const TYPES = { docx: DOCX, pdf: "application/pdf", md: "text/markdown; charset=utf-8", redline: DOCX }

function attachment(res, file, type, nice) {
  res.setHeader("Content-Type", type)
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName(nice)}"; filename*=UTF-8''${encodeURIComponent(nice)}`)
  res.setHeader("Cache-Control", "private, no-store")
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.sendFile(file, { dotfiles: "allow" })
}

function send(res, found, what, format, ownerId) {
  const { dir, meta } = found
  if (what === "preview") {
    const f = fileIn(dir, meta.preview)
    if (!f) return res.status(404).json({ error: "Không có bản xem trước." })
    // The preview is agent-generated HTML: no scripts, sandboxed, frameable only by us.
    res.setHeader("Content-Security-Policy", PREVIEW_CSP)
    res.setHeader("X-Frame-Options", "SAMEORIGIN")
    res.setHeader("Cache-Control", "private, max-age=300")
    res.type("html")
    return res.sendFile(f, { dotfiles: "allow" })
  }
  if (format === "original") {
    const o = originalOf(found, ownerId)
    if (!o) return res.status(404).json({ error: "Không có tệp gốc." })
    const ext = path.extname(o.file).toLowerCase()
    const base = safeBase(o.name.replace(/\.[^.]+$/, "")) || "tep-goc"
    return attachment(res, o.file, ORIGINAL_TYPES[ext], `${base}${ext}`)
  }
  if (!TYPES[format]) return res.status(400).json({ error: "Định dạng không hỗ trợ." })
  const name = format === "md" ? meta.markdown : meta.files?.find?.((x) => x?.format === format)?.name
  const f = fileIn(dir, name)
  if (!f) return res.status(404).json({ error: "Tệp không tồn tại." })
  if (format === "redline" && !f.toLowerCase().endsWith(".docx")) return res.status(404).json({ error: "Tệp không tồn tại." })
  const nice = format === "redline" ? tr(resolveLocale(res.req), "redlineName", { base: safeBase(meta.title) || "tai-lieu", n: versionOf(meta) }) : niceName(meta.title, format)
  attachment(res, f, TYPES[format], nice)
}

/** Safe client descriptor of a metadata file (+ whether an original upload can be downloaded). */
function describe(found, ownerId) {
  const d = artifactDescriptor(found.meta)
  if (!d) return null
  if (d.origin === "upload") d.hasOriginal = !!originalOf(found, ownerId)
  else delete d.hasOriginal
  return d
}

function readMarkdown(found) {
  const f = fileIn(found.dir, found.meta.markdown)
  if (!f) return null
  try {
    if (fs.statSync(f).size > MAX_MD_BYTES) return null
    return fs.readFileSync(f, "utf8")
  } catch {
    return null
  }
}

const diffCache = new Map()
function diffOf(older, newer) {
  const key = `${older.dir}|${older.meta.id}|${newer.meta.id}`
  const hit = diffCache.get(key)
  if (hit) return hit
  const a = readMarkdown(older)
  const b = readMarkdown(newer)
  if (a == null || b == null) return null
  const r = diffText(a, b)
  diffCache.set(key, r)
  if (diffCache.size > 100) diffCache.delete(diffCache.keys().next().value)
  return r
}

// ---- routes --------------------------------------------------------------------------------------
/** Does any branch of the chat have generated / imported documents? (admin chat list) */
export function chatHasDocuments(chatId) {
  for (const sid of chatSessions(chatId)) {
    try {
      if (fs.readdirSync(sessionDir(sid)).some((n) => /-\d{14}-[0-9a-f]{6}\.json$/.test(n))) return true
    } catch {}
  }
  return false
}
export const chatSessions = (chatId) => q("SELECT opencode_session_id AS s FROM branches WHERE chat_id = ? ORDER BY created_at, rowid").all(chatId).map((r) => r.s)

/** Descriptor of an artifact in one of the chat's sessions (used to show imported uploads on user messages). */
export function describeInChat(chat, artifactId) {
  const found = locate(chatSessions(chat.id), String(artifactId || ""))
  return found ? describe(found, chat.user_id) : null
}

/** Artifact ids that are part of a share snapshot (answer cards + imported attachments). */
function snapshotIds(snap) {
  const ids = new Set()
  for (const m of snap.messages || []) {
    for (const p of m.parts || []) if (p.artifact?.id) ids.add(p.artifact.id)
    for (const a of m.attachments || []) {
      if (a.docId) ids.add(a.docId)
      if (a.artifact?.id) ids.add(a.artifact.id)
    }
  }
  return ids
}

const FORMATS = "docx|pdf|md|redline|original"
const ACTIONS = `preview|download|versions|diff`
const ownerRe = new RegExp(`^/api/artifacts/([\\w-]{3,40})/([\\w-]{3,40})/(${ACTIONS})(?:/(${FORMATS}))?$`)
const shareRe = new RegExp(`^/api/public/shares/([\\w-]{16,64})/artifacts/([\\w-]{3,40})/(${ACTIONS})(?:/(${FORMATS}))?$`)

function handle(req, res, { sessions, ownerId, allowed }) {
  const [artifactId, what, format] = [req.params[1], req.params[2], req.params[3]]
  if (!ARTIFACT_ID_RE.test(artifactId) || !allowed(artifactId)) return res.status(404).json({ error: "Không tìm thấy tài liệu." })
  if ((what === "download") !== !!format) return res.status(404).json({ error: "Không tìm thấy." })
  const found = locate(sessions, artifactId)
  if (!found) return res.status(404).json({ error: "Không tìm thấy tài liệu." })
  if (what === "versions") {
    const chain = chainOf(sessions, found).filter((x) => allowed(x.meta.id))
    res.setHeader("Cache-Control", "private, no-store")
    return res.json({ current: artifactId, rootId: rootOf(found.meta), versions: chain.map((x) => describe(x, ownerId)).filter(Boolean) })
  }
  if (what === "diff") {
    let againstId = String(req.query.against || "")
    if (!againstId) {
      // Default: the parent version (or the previous one in the chain).
      const chain = chainOf(sessions, found)
      const i = chain.findIndex((x) => x.meta.id === artifactId)
      againstId = (ARTIFACT_ID_RE.test(found.meta.parent_id) && found.meta.parent_id) || (i > 0 ? chain[i - 1].meta.id : "")
    }
    if (!ARTIFACT_ID_RE.test(againstId) || againstId === artifactId || !allowed(againstId)) return res.status(404).json({ error: "Không có bản để so sánh." })
    const other = locate(sessions, againstId)
    if (!other) return res.status(404).json({ error: "Không có bản để so sánh." })
    // Always old → new, whichever order the ids came in.
    const swap = versionOf(other.meta) > versionOf(found.meta)
    const [older, newer] = swap ? [found, other] : [other, found]
    const r = diffOf(older, newer)
    if (!r) return res.status(404).json({ error: "Không đọc được nội dung để so sánh." })
    res.setHeader("Cache-Control", "private, no-store")
    return res.json({
      from: { id: older.meta.id, version: versionOf(older.meta), title: artifactDescriptor(older.meta)?.title },
      to: { id: newer.meta.id, version: versionOf(newer.meta), title: artifactDescriptor(newer.meta)?.title },
      ops: r.ops,
      stats: r.stats,
    })
  }
  send(res, found, what, format, ownerId)
}

export function registerArtifactRoutes(app) {
  app.get(ownerRe, requireUser, (req, res) => {
    // Owner – or an admin (read-only review of any chat; preview / download are written to the access log).
    const chat = req.user.isAdmin
      ? q("SELECT id, user_id FROM chats WHERE id = ?").get(req.params[0])
      : q("SELECT id, user_id FROM chats WHERE id = ? AND user_id = ?").get(req.params[0], req.user.id)
    if (!chat) return res.status(404).json({ error: "Không tìm thấy." })
    const what = req.params[2]
    if (what === "preview" || what === "download") logAdminAccess(req.user, chat, what, `${req.params[1]}${req.params[3] ? "/" + req.params[3] : ""}`)
    handle(req, res, { sessions: chatSessions(chat.id), ownerId: chat.user_id, allowed: () => true })
  })

  // Shared read-only pages: only artifacts that are part of the snapshot (versions and diffs too).
  app.get(shareRe, (req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive")
    const s = q("SELECT * FROM shares WHERE token = ? AND revoked_at IS NULL").get(req.params[0])
    if (!s) return res.status(404).json({ error: "Không tìm thấy." })
    let ids
    try {
      ids = snapshotIds(JSON.parse(s.snapshot))
    } catch {
      return res.status(404).json({ error: "Không tìm thấy." })
    }
    const chat = q("SELECT id, user_id FROM chats WHERE id = ?").get(s.chat_id)
    if (!chat) return res.status(404).json({ error: "Không tìm thấy." })
    handle(req, res, { sessions: chatSessions(chat.id), ownerId: chat.user_id, allowed: (id) => ids.has(id) })
  })
}
