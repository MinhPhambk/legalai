// Visuals made by the agent tools diagram_create / image_fetch / source_snapshot (../../.opencode/lib/visual-store.ts):
// <outputs>/<sessionID>/visuals/<id>.json + <id>.<role>.<ext>. Served ONLY from here, owner- / admin- / share-scoped
// like the document artifacts, so the answer never hotlinks anything:
//   GET /api/visuals/:chatId/:id/meta                  → safe descriptor (title, caption, size, credit, license…)
//   GET /api/visuals/:chatId/:id/image[?theme=dark]    → the stored WebP / PNG (diagram: PNG of that theme)
//   GET /api/visuals/:chatId/:id/frame?theme=light|dark → diagram page for <iframe sandbox="">: inline SVG, strict CSP
//   GET /api/visuals/:chatId/:id/download/svg|png      → attachment
//   GET /api/public/shares/:token/visuals/:id/…         → same, only for visuals referenced by the share snapshot
import fs from "node:fs"
import path from "node:path"
import { q } from "./db.mjs"
import { requireUser } from "./auth.mjs"
import { logAdminAccess } from "./audit.mjs"
import { OUTPUT_DIR, chatSessions } from "./artifacts.mjs"
import { scrubText } from "./sanitize.mjs"
import { resolveLocale } from "./i18n.mjs"

export const VISUAL_ID_RE = /^v\d{14}-[0-9a-f]{6}$/
const MAX_META = 64 * 1024
const MAX_SVG = 3 * 1024 * 1024
const visualsDir = (sid) => path.join(OUTPUT_DIR, String(sid).replace(/[^\w.-]/g, "_"), "visuals")

/** Visual ids referenced by answer text (markers / visual: links) – for share snapshots. */
export function visualIdsInText(text) {
  const ids = new Set()
  for (const m of String(text || "").matchAll(/(?:\[\[diagram:|\(visual:)(v\d{14}-[0-9a-f]{6})/g)) ids.add(m[1])
  return ids
}

function locate(sessionIds, id) {
  if (!VISUAL_ID_RE.test(id)) return null
  for (const sid of sessionIds) {
    const dir = visualsDir(sid)
    const f = path.join(dir, `${id}.json`)
    try {
      if (fs.statSync(f).size > MAX_META) continue
      const meta = JSON.parse(fs.readFileSync(f, "utf8"))
      if (meta?.id === id && ["diagram", "image", "snapshot"].includes(meta.kind)) return { dir, meta }
    } catch {}
  }
  return null
}

/** A file of the visual by role, inside its folder only. */
function fileOf(found, role) {
  const f = (Array.isArray(found.meta.files) ? found.meta.files : []).find((x) => x?.role === role)
  const name = f?.name
  if (typeof name !== "string" || !new RegExp(`^${found.meta.id}\\.[\\w-]+\\.(svg|png|webp|json)$`).test(name)) return null
  const full = path.resolve(found.dir, name)
  return path.dirname(full) === path.resolve(found.dir) && fs.existsSync(full) ? full : null
}

const httpUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) && u.length < 2000 ? u : null)
const cap = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n)
const posInt = (n) => (Number.isFinite(+n) && +n > 0 && +n < 20000 ? Math.round(+n) : 0)

/** Safe client descriptor. */
export function visualDescriptor(meta, locale) {
  const a = meta.attribution && typeof meta.attribution === "object" ? meta.attribution : {}
  const sc = (s, n) => scrubText(cap(s, n), locale)
  return {
    id: meta.id,
    kind: meta.kind,
    title: sc(meta.title, 160),
    caption: sc(meta.caption, 300),
    lang: meta.lang === "en" ? "en" : "vi",
    width: posInt(meta.width),
    height: posInt(meta.height),
    ...(meta.kind === "diagram" ? { diagramType: cap(meta.diagram_type, 20) } : {}),
    ...(a.credit ? { credit: sc(a.credit, 300), author: sc(a.author, 160), license: cap(a.license, 80), licenseUrl: httpUrl(a.license_url), sourceUrl: httpUrl(a.source_url), domain: cap(a.domain, 80) } : {}),
    formats: meta.kind === "diagram" ? ["png", "svg"] : [],
  }
}

function frameHtml(svg, theme, title) {
  const themed = svg.replace(/^<svg\b/, `<svg data-theme="${theme}"`)
  const t = String(title).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c])
  return `<!doctype html><html lang="vi" data-theme="${theme}"><head><meta charset="utf-8"><title>${t}</title><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:100%;height:auto}</style></head><body>${themed}</body></html>`
}

// Diagram frame: no scripts at all, nothing external, frameable by our own pages only.
const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"

function handle(req, res, { sessions, allowed, log }) {
  const id = req.params[1], what = req.params[2], fmt = req.params[3]
  if (!VISUAL_ID_RE.test(id) || !allowed(id)) return res.status(404).json({ error: "Không tìm thấy." })
  const found = locate(sessions, id)
  if (!found) return res.status(404).json({ error: "Không tìm thấy." })
  const theme = req.query.theme === "dark" ? "dark" : "light"
  res.setHeader("X-Content-Type-Options", "nosniff")
  if (what === "meta") {
    res.setHeader("Cache-Control", "private, no-store")
    return res.json({ visual: visualDescriptor(found.meta, resolveLocale(req)) })
  }
  if (what === "image") {
    const file = found.meta.kind === "diagram" ? fileOf(found, theme === "dark" ? "png-dark" : "png-light") || fileOf(found, "png-light") : fileOf(found, "image")
    if (!file) return res.status(404).json({ error: "Không tìm thấy." })
    log("preview", `visual:${id}`)
    res.setHeader("Cache-Control", "private, max-age=86400, immutable")
    res.type(path.extname(file) === ".webp" ? "image/webp" : "image/png")
    return res.sendFile(file, { dotfiles: "allow" })
  }
  if (what === "frame") {
    if (found.meta.kind !== "diagram") return res.status(404).json({ error: "Không tìm thấy." })
    const file = fileOf(found, "svg")
    if (!file || fs.statSync(file).size > MAX_SVG) return res.status(404).json({ error: "Không tìm thấy." })
    log("preview", `visual:${id}`)
    res.setHeader("Content-Security-Policy", FRAME_CSP)
    res.setHeader("X-Frame-Options", "SAMEORIGIN")
    res.setHeader("Cache-Control", "private, max-age=3600")
    res.type("html")
    return res.send(frameHtml(fs.readFileSync(file, "utf8"), theme, found.meta.title || "diagram"))
  }
  if (what === "download") {
    if (found.meta.kind !== "diagram" || !["svg", "png"].includes(fmt)) return res.status(404).json({ error: "Không tìm thấy." })
    const file = fmt === "svg" ? fileOf(found, "svg") : fileOf(found, theme === "dark" ? "png-dark" : "png-light")
    if (!file) return res.status(404).json({ error: "Không tìm thấy." })
    log("download", `visual:${id}/${fmt}`)
    const base = String(found.meta.title || "so-do").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "so-do"
    const ascii = base.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/[^\w.-]+/g, "_")
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}.${fmt}"; filename*=UTF-8''${encodeURIComponent(`${base}.${fmt}`)}`)
    res.setHeader("Cache-Control", "private, no-store")
    if (fmt === "svg") res.setHeader("Content-Security-Policy", SVG_CSP)
    res.type(fmt === "svg" ? "image/svg+xml" : "image/png")
    return res.sendFile(file, { dotfiles: "allow" })
  }
  return res.status(404).json({ error: "Không tìm thấy." })
}

/** Visual ids of a share snapshot: markers in answer text + visual tool parts. */
export function snapshotVisualIds(snap) {
  const ids = new Set()
  for (const m of snap?.messages || []) {
    for (const p of m.parts || []) {
      if (p.type === "text") for (const id of visualIdsInText(p.text)) ids.add(id)
      if (p.visual?.id && VISUAL_ID_RE.test(p.visual.id)) ids.add(p.visual.id)
    }
  }
  return ids
}

const ACTIONS = "meta|image|frame|download"
const ownerRe = new RegExp(`^/api/visuals/([\\w-]{3,40})/(v\\d{14}-[0-9a-f]{6})/(${ACTIONS})(?:/(svg|png))?$`)
const shareRe = new RegExp(`^/api/public/shares/([\\w-]{16,64})/visuals/(v\\d{14}-[0-9a-f]{6})/(${ACTIONS})(?:/(svg|png))?$`)

export function registerVisualRoutes(app) {
  app.get(ownerRe, requireUser, (req, res) => {
    const chat = req.user.isAdmin
      ? q("SELECT id, user_id, title FROM chats WHERE id = ?").get(req.params[0])
      : q("SELECT id, user_id, title FROM chats WHERE id = ? AND user_id = ?").get(req.params[0], req.user.id)
    if (!chat) return res.status(404).json({ error: "Không tìm thấy." })
    handle(req, res, { sessions: chatSessions(chat.id), allowed: () => true, log: (action, detail) => logAdminAccess(req.user, chat, action, detail) })
  })
  app.get(shareRe, (req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive")
    const s = q("SELECT * FROM shares WHERE token = ? AND revoked_at IS NULL").get(req.params[0])
    if (!s) return res.status(404).json({ error: "Không tìm thấy." })
    let ids
    try {
      ids = snapshotVisualIds(JSON.parse(s.snapshot))
    } catch {
      return res.status(404).json({ error: "Không tìm thấy." })
    }
    handle(req, res, { sessions: chatSessions(s.chat_id), allowed: (id) => ids.has(id), log: () => {} })
  })
}
