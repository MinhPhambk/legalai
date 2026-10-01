// SQLite storage via the built-in node:sqlite module (no native addons).
import { DatabaseSync } from "node:sqlite"
import { DB_PATH } from "./config.mjs"

export const db = new DatabaseSync(DB_PATH)
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS chats (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opencode_session_id TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_user ON chats(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  stored_path TEXT NOT NULL,
  text_path   TEXT NOT NULL,
  chars       INTEGER NOT NULL,
  truncated   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_user ON uploads(user_id);

-- Every version of a conversation is its own opencode session ("branch"). A branch forked from
-- parent_id at fork_turn shares the parent's user turns 0..fork_turn-1 (opencode's fork copies them)
-- and has its own turn fork_turn onwards. Sessions are append-only, so shared prefixes never change.
CREATE TABLE IF NOT EXISTS branches (
  id                  TEXT PRIMARY KEY,
  chat_id             TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  opencode_session_id TEXT NOT NULL UNIQUE,
  parent_id           TEXT REFERENCES branches(id) ON DELETE SET NULL,
  fork_turn           INTEGER,
  created_at          INTEGER NOT NULL,
  visited_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS branches_chat ON branches(chat_id);

-- Plain-text copy of messages for search (all branches), refreshed after every run.
CREATE TABLE IF NOT EXISTS message_text (
  message_id TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  branch_id  TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS message_text_chat ON message_text(chat_id);
CREATE INDEX IF NOT EXISTS message_text_time ON message_text(created_at);

CREATE TABLE IF NOT EXISTS shares (
  token      TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  snapshot   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS shares_user ON shares(user_id);
CREATE INDEX IF NOT EXISTS shares_chat ON shares(chat_id);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)

// ---- additive migrations ------------------------------------------------------------------------
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)
const addColumn = (table, col, def) => {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
}
addColumn("users", "display_name", "TEXT")
addColumn("users", "disabled", "INTEGER NOT NULL DEFAULT 0")
addColumn("users", "settings", "TEXT")
addColumn("users", "last_login_at", "INTEGER")
addColumn("chats", "pinned_at", "INTEGER")
// OCR of a scanned PDF upload: JSON { engine, pages: [n…], totalPages } (null = text layer / not a PDF)
addColumn("uploads", "ocr", "TEXT")
addColumn("chats", "active_branch_id", "TEXT")
addColumn("chats", "first_prompt_at", "INTEGER")
addColumn("branches", "kind", "TEXT NOT NULL DEFAULT 'root'") // root | edit | regenerate
addColumn("branches", "turns", "INTEGER NOT NULL DEFAULT 0") // user turns in the session
addColumn("users", "is_expert", "INTEGER NOT NULL DEFAULT 0")
addColumn("users", "expert_seen_at", "INTEGER")
addColumn("users", "locale", "TEXT") // UI language: vi | en (NULL = not chosen yet)
// Expert escalations. The agent's expert_escalate tool writes .sandbox/escalations/<id>.json (its inbox);
// those files are imported here idempotently and the workflow state lives in SQLite.
db.exec(`CREATE TABLE IF NOT EXISTS escalations (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT REFERENCES chats(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_id    TEXT,
  origin        TEXT NOT NULL DEFAULT 'agent',
  status        TEXT NOT NULL DEFAULT 'mới',
  reason        TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  urgency       TEXT NOT NULL DEFAULT 'trung bình',
  deadline      TEXT,
  topic         TEXT,
  confidence    TEXT,
  sources       TEXT NOT NULL DEFAULT '[]',
  assignee_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  owner_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS escalations_chat ON escalations(chat_id);
CREATE INDEX IF NOT EXISTS escalations_user ON escalations(user_id);
CREATE INDEX IF NOT EXISTS escalations_status ON escalations(status, created_at);
CREATE TABLE IF NOT EXISTS escalation_replies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  escalation_id TEXT NOT NULL REFERENCES escalations(id) ON DELETE CASCADE,
  author_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name   TEXT NOT NULL,
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS escalation_replies_e ON escalation_replies(escalation_id, created_at);`)
db.exec(`CREATE TABLE IF NOT EXISTS prompts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prompts_time ON prompts(created_at);`)
// Uploads imported into a chat session's document store (doc-store importDocument): one editable
// document per (upload, opencode session). Rows go away with the upload / chat / user.
db.exec(`CREATE TABLE IF NOT EXISTS upload_docs (
  upload_id   TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (upload_id, session_id)
);
CREATE INDEX IF NOT EXISTS upload_docs_artifact ON upload_docs(artifact_id);`)

// Chats created before branching existed: their session becomes the root branch.
for (const c of db.prepare("SELECT id, opencode_session_id, created_at FROM chats WHERE active_branch_id IS NULL").all()) {
  const existing = db.prepare("SELECT id FROM branches WHERE opencode_session_id = ?").get(c.opencode_session_id)
  const bid = existing?.id || "b_" + c.id.slice(2)
  if (!existing)
    db.prepare("INSERT INTO branches (id, chat_id, opencode_session_id, parent_id, fork_turn, created_at, visited_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)").run(
      bid, c.id, c.opencode_session_id, c.created_at, c.created_at)
  db.prepare("UPDATE chats SET active_branch_id = ? WHERE id = ?").run(bid, c.id)
}

// Full-text search (FTS5 ships with node:sqlite); diacritics-insensitive so "muc phat" finds "mức phạt".
export let FTS = true
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(text, message_id UNINDEXED, chat_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`)
} catch {
  FTS = false
}

const stmts = new Map()
/** Cached prepared statement. */
export const q = (sql) => {
  let s = stmts.get(sql)
  if (!s) stmts.set(sql, (s = db.prepare(sql)))
  return s
}

/** Run fn inside a transaction. */
export function tx(fn) {
  db.exec("BEGIN IMMEDIATE")
  try {
    const r = fn()
    db.exec("COMMIT")
    return r
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
}

export function getSetting(key, dflt) {
  const r = q("SELECT value FROM app_settings WHERE key = ?").get(key)
  if (!r) return dflt
  try {
    return JSON.parse(r.value)
  } catch {
    return dflt
  }
}
export function setSetting(key, value) {
  q("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value))
}
