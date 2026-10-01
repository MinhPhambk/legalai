// Accounts, password hashing (scrypt + per-user salt), cookie sessions and login rate limiting.
import crypto from "node:crypto"
import { promisify } from "node:util"
import { getSetting, q } from "./db.mjs"
import { config } from "./config.mjs"

const scrypt = promisify(crypto.scrypt)
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }
const KEYLEN = 64
export const COOKIE = "nd45_sid"

export const newId = (bytes = 12) => crypto.randomBytes(bytes).toString("base64url")
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex")

export async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const key = await scrypt(password.normalize("NFC"), salt, KEYLEN, SCRYPT)
  return { salt, hash: `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${key.toString("hex")}` }
}

export async function verifyPassword(password, salt, stored) {
  const [alg, N, r, p, hex] = String(stored).split("$")
  if (alg !== "scrypt" || !hex) return false
  const expected = Buffer.from(hex, "hex")
  const key = await scrypt(password.normalize("NFC"), salt, expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem })
  return crypto.timingSafeEqual(key, expected)
}

const EMAIL_RE = /^[^\s@<>()"',;:]{1,64}@[^\s@<>()"',;:]{1,190}\.[a-z]{2,}$/i
export function validateCredentials(email, password) {
  if (typeof email !== "string" || typeof password !== "string") return "Thiếu email hoặc mật khẩu."
  if (email.length > 254 || !EMAIL_RE.test(email.trim())) return "Email không hợp lệ."
  if (password.length < 8) return "Mật khẩu cần ít nhất 8 ký tự."
  if (password.length > 200) return "Mật khẩu quá dài."
  return null
}

export async function createUser(email, password, { admin = false } = {}) {
  const { salt, hash } = await hashPassword(password)
  const id = "u_" + newId(9)
  q("INSERT INTO users (id, email, password_hash, salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, email.trim().toLowerCase(), hash, salt, admin ? 1 : 0, Date.now())
  return { id, email: email.trim().toLowerCase(), isAdmin: admin }
}

export const findUserByEmail = (email) => q("SELECT * FROM users WHERE email = ?").get(String(email).trim().toLowerCase())

// A fixed dummy hash so that logins for unknown emails take as long as real ones.
let dummy
const dummyHash = async () => (dummy ??= await hashPassword("dummy-password-for-timing"))

/** Returns the user row or null. Always spends one scrypt computation. */
export async function checkLogin(email, password) {
  const user = findUserByEmail(email)
  if (!user) {
    const d = await dummyHash()
    await verifyPassword(password, d.salt, d.hash)
    return null
  }
  const ok = await verifyPassword(password, user.salt, user.password_hash)
  return ok && !user.disabled ? user : null
}

// ---- sessions ---------------------------------------------------------------------------------
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url")
  const now = Date.now()
  q("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    sha256(token), userId, now, now + config.sessionDays * 86400_000)
  return token
}

export function destroySession(token) {
  if (token) q("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token))
}

export function userForToken(token) {
  if (!token || token.length > 100) return null
  const row = q(`SELECT s.token_hash, s.expires_at, u.id, u.email, u.is_admin, u.is_expert, u.disabled, u.display_name, u.settings, u.locale FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ?`).get(sha256(token))
  if (!row) return null
  const now = Date.now()
  if (row.expires_at < now) {
    q("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash)
    return null
  }
  // Sliding expiry, refreshed at most once a day.
  const fresh = now + config.sessionDays * 86400_000
  if (fresh - row.expires_at > 86400_000) q("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(fresh, row.token_hash)
  if (row.disabled) return null
  return { id: row.id, email: row.email, isAdmin: !!row.is_admin, isExpert: !!row.is_expert, displayName: row.display_name || "", settings: parseSettings(row.settings), locale: row.locale || null, tokenHash: row.token_hash }
}

export function purgeExpiredSessions() {
  q("DELETE FROM sessions WHERE expires_at < ?").run(Date.now())
}

export function parseCookies(header = "") {
  const out = {}
  for (const part of header.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export const isHttps = (req) => req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"

export function setSessionCookie(req, res, token) {
  const parts = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${config.sessionDays * 86400}`]
  if (isHttps(req)) parts.push("Secure")
  res.append("Set-Cookie", parts.join("; "))
}

export function clearSessionCookie(req, res) {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]
  if (isHttps(req)) parts.push("Secure")
  res.append("Set-Cookie", parts.join("; "))
}

/** Express middleware: attaches req.user (or null) and req.sessionToken. */
export function sessionMiddleware(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE]
  req.sessionToken = token
  req.user = token ? userForToken(token) : null
  next()
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Bạn cần đăng nhập." })
  next()
}

// ---- rate limiting ----------------------------------------------------------------------------
/** Sliding-window failure counter kept in memory. */
export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max
    this.windowMs = windowMs
    this.hits = new Map()
  }
  #recent(key) {
    const now = Date.now()
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs)
    if (arr.length) this.hits.set(key, arr)
    else this.hits.delete(key)
    return arr
  }
  blocked(key) {
    return this.#recent(key).length >= this.max
  }
  hit(key) {
    const arr = this.#recent(key)
    arr.push(Date.now())
    this.hits.set(key, arr)
  }
  reset(key) {
    this.hits.delete(key)
  }
  sweep() {
    for (const k of [...this.hits.keys()]) this.#recent(k)
  }
}

export const DEFAULT_SETTINGS = { fontSize: "md", showReasoning: false, enterToSend: true, showFollowups: true, adminReasoning: true, autoRepair: false }
/**
 * May this viewer see model reasoning? Normal users: admin setting showReasoningToUsers (default off);
 * admins: their own toggle (settings.adminReasoning, default on). Enforced server-side (SSE, history).
 */
export const reasoningAllowed = (u) => (u?.isAdmin ? u.settings?.adminReasoning !== false : getSetting("showReasoningToUsers", false) === true)
export function parseSettings(raw) {
  try {
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}
export const hashToken = sha256

/** Readable one-time password for admin resets (no ambiguous characters). */
export function generatePassword(len = 14) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  const bytes = crypto.randomBytes(len)
  let out = ""
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length]
  return out.slice(0, 4) + "-" + out.slice(4, 9) + "-" + out.slice(9)
}

export async function setPassword(userId, password) {
  const { salt, hash } = await hashPassword(password)
  q("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").run(hash, salt, userId)
}
