// Accountability for admin access to other users' conversations: every view / document preview / download of a
// chat the admin does not own is logged (admin, chat, owner, action, time) and listed in Admin → access log.
import { db, q } from "./db.mjs"

db.exec(`CREATE TABLE IF NOT EXISTS admin_access_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_access_log_time ON admin_access_log(created_at);
CREATE INDEX IF NOT EXISTS admin_access_log_chat ON admin_access_log(chat_id);`)
// Emails / title copied at log time, so the log stays readable after a user or chat is deleted.
{
  const cols = new Set(q("PRAGMA table_info(admin_access_log)").all().map((c) => c.name))
  for (const c of ["admin_email", "owner_email", "chat_title"]) if (!cols.has(c)) db.exec(`ALTER TABLE admin_access_log ADD COLUMN ${c} TEXT`)
}

const ACTIONS = new Set(["view", "preview", "download"])
/** Log an admin access to someone else's chat (own chats are not logged). */
export function logAdminAccess(admin, chat, action, detail = "") {
  if (!admin?.isAdmin || !chat || chat.user_id === admin.id || !ACTIONS.has(action)) return
  const owner = q("SELECT email FROM users WHERE id = ?").get(chat.user_id)
  const title = chat.title ?? q("SELECT title FROM chats WHERE id = ?").get(chat.id)?.title
  q("INSERT INTO admin_access_log (admin_id, chat_id, owner_id, action, detail, created_at, admin_email, owner_email, chat_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    admin.id, chat.id, chat.user_id, action, String(detail).slice(0, 120), Date.now(), admin.email || null, owner?.email || null, title || null)
}

/** Paged log with emails / titles (users or chats deleted since then show as null). */
export function accessLog({ page = 1, size = 20 } = {}) {
  const total = q("SELECT COUNT(*) AS n FROM admin_access_log").get().n
  const rows = q(
    `SELECT l.id, l.action, l.detail, l.created_at AS at, l.chat_id AS chatId, COALESCE(a.email, l.admin_email) AS adminEmail, COALESCE(o.email, l.owner_email) AS ownerEmail, c.title AS chatTitle, (c.id IS NULL) AS chatDeleted, l.chat_title AS chatTitleAtView
     FROM admin_access_log l LEFT JOIN users a ON a.id = l.admin_id LEFT JOIN users o ON o.id = l.owner_id LEFT JOIN chats c ON c.id = l.chat_id
     ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
  ).all(size, (page - 1) * size)
  return { entries: rows, total, page, size, pages: Math.max(1, Math.ceil(total / size)) }
}
