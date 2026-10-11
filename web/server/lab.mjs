// Admin → "Lab thử nghiệm": a workspace where admins sketch pilot products built on the platform (name, purpose,
// target users, notes, and a DRAFT configuration: persona prompt, tools / skills, model). Admin-only; nothing here
// changes the running assistant yet – the draft configuration is stored for discussion and future activation.
import crypto from "node:crypto"
import { db, q } from "./db.mjs"

db.exec(`CREATE TABLE IF NOT EXISTS lab_products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  tagline     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'idea',
  data        TEXT NOT NULL DEFAULT '{}',
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);`)

export const LAB_STATUSES = ["idea", "building", "pilot", "paused"]
const TEXT_FIELDS = { goal: 4000, audience: 2000, notes: 20000, prompt: 20000, welcome: 1000 }
const LIST_FIELDS = { tools: 200, skills: 100, examples: 20 }

const clean = (s, n) => String(s ?? "").replace(/\u0000/g, "").trim().slice(0, n)
/** Only known fields, bounded sizes (the draft is free-form but never arbitrary JSON). */
function cleanData(d = {}) {
  const out = {}
  for (const [k, n] of Object.entries(TEXT_FIELDS)) if (d[k] != null) out[k] = clean(d[k], n)
  for (const [k, n] of Object.entries(LIST_FIELDS))
    if (Array.isArray(d[k])) out[k] = [...new Set(d[k].map((x) => clean(x, k === "examples" ? 300 : 80)).filter(Boolean))].slice(0, n)
  if (d.model != null) out.model = clean(d.model, 120)
  return out
}
const row = (r) => r && { id: r.id, name: r.name, tagline: r.tagline, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, ...JSON.parse(r.data || "{}") }

export function registerLabRoutes(app, { json }) {
  const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Bạn cần đăng nhập." })
    if (!req.user.isAdmin) return res.status(403).json({ error: "Chỉ quản trị viên mới truy cập được." })
    next()
  }
  app.get("/api/admin/lab", requireAdmin, (req, res) => {
    res.json({ products: q("SELECT * FROM lab_products ORDER BY updated_at DESC").all().map(row), statuses: LAB_STATUSES })
  })
  app.get("/api/admin/lab/:id", requireAdmin, (req, res) => {
    const r = q("SELECT * FROM lab_products WHERE id = ?").get(req.params.id)
    if (!r) return res.status(404).json({ error: "Không tìm thấy sản phẩm." })
    res.json({ product: row(r) })
  })
  app.post("/api/admin/lab", requireAdmin, json, (req, res) => {
    const name = clean(req.body?.name, 120)
    if (!name) return res.status(400).json({ error: "Cần đặt tên sản phẩm." })
    const id = "p_" + crypto.randomBytes(6).toString("base64url")
    const now = Date.now()
    const status = LAB_STATUSES.includes(req.body?.status) ? req.body.status : "idea"
    q("INSERT INTO lab_products (id, name, tagline, status, data, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, clean(req.body?.tagline, 300), status, JSON.stringify(cleanData(req.body)), req.user.id, now, now)
    res.json({ product: row(q("SELECT * FROM lab_products WHERE id = ?").get(id)) })
  })
  app.patch("/api/admin/lab/:id", requireAdmin, json, (req, res) => {
    const r = q("SELECT * FROM lab_products WHERE id = ?").get(req.params.id)
    if (!r) return res.status(404).json({ error: "Không tìm thấy sản phẩm." })
    const b = req.body || {}
    const name = b.name !== undefined ? clean(b.name, 120) : r.name
    if (!name) return res.status(400).json({ error: "Cần đặt tên sản phẩm." })
    const status = b.status !== undefined ? (LAB_STATUSES.includes(b.status) ? b.status : r.status) : r.status
    const data = { ...JSON.parse(r.data || "{}"), ...cleanData(b) }
    q("UPDATE lab_products SET name = ?, tagline = ?, status = ?, data = ?, updated_at = ? WHERE id = ?")
      .run(name, b.tagline !== undefined ? clean(b.tagline, 300) : r.tagline, status, JSON.stringify(data), Date.now(), r.id)
    res.json({ product: row(q("SELECT * FROM lab_products WHERE id = ?").get(r.id)) })
  })
  app.delete("/api/admin/lab/:id", requireAdmin, (req, res) => {
    q("DELETE FROM lab_products WHERE id = ?").run(req.params.id)
    res.json({ ok: true })
  })
}
