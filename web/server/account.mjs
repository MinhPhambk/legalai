// Account self-service (Settings → Tài khoản / Chung) and the admin screen API.
import fs from "node:fs"
import path from "node:path"
import { config, UPLOAD_DIR } from "./config.mjs"
import { followupCount } from "./followups.mjs"
import { REPAIR_DISABLED, autoRepairOn } from "./grounding.mjs"
import { activeModelId, defaultModelId, listModels, setActiveModel, testModel } from "./models.mjs"
import { getSetting, q, setSetting } from "./db.mjs"
import {
  DEFAULT_SETTINGS, RateLimiter, clearSessionCookie, createUser, findUserByEmail, generatePassword, parseSettings,
  requireUser, setPassword, validateCredentials, verifyPassword,
} from "./auth.mjs"

const userOut = (u) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name || "",
  isAdmin: !!u.is_admin,
  isExpert: !!u.is_expert,
  disabled: !!u.disabled,
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at || null,
  locale: u.locale || null,
})

export const allowRegistration = () => getSetting("allowRegistration", config.allowRegistration)

export function registerAccountRoutes(app, { oc, json, chats, getModelInfo, opencodeHealth }) {
  const pwLimiter = new RateLimiter({ max: 5, windowMs: 15 * 60_000 })
  const adminLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60_000 })
  setInterval(() => [pwLimiter, adminLimiter].forEach((l) => l.sweep()), 10 * 60_000).unref()
  const TOO_MANY = { error: "Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ít phút." }

  const fullUser = (id) => q("SELECT * FROM users WHERE id = ?").get(id)

  // ---- account --------------------------------------------------------------------------------
  app.get("/api/account", requireUser, (req, res) => {
    const u = fullUser(req.user.id)
    const otherSessions = q("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND token_hash <> ? AND expires_at > ?").get(req.user.id, req.user.tokenHash, Date.now()).n
    res.json({ user: { ...userOut(u), settings: parseSettings(u.settings) }, otherSessions })
  })

  app.patch("/api/account", requireUser, json, (req, res) => {
    const name = typeof req.body?.displayName === "string" ? req.body.displayName.replace(/\s+/g, " ").trim().slice(0, 60) : null
    if (name === null) return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
    q("UPDATE users SET display_name = ? WHERE id = ?").run(name || null, req.user.id)
    res.json({ user: userOut(fullUser(req.user.id)) })
  })

  app.put("/api/account/settings", requireUser, json, (req, res) => {
    const b = req.body || {}
    const cur = parseSettings(fullUser(req.user.id).settings)
    const next = { ...cur }
    if (["sm", "md", "lg"].includes(b.fontSize)) next.fontSize = b.fontSize
    if (typeof b.showReasoning === "boolean") next.showReasoning = b.showReasoning
    if (typeof b.enterToSend === "boolean") next.enterToSend = b.enterToSend
    if (typeof b.showFollowups === "boolean") next.showFollowups = b.showFollowups
    // automatic look-up-again on THẤP: only while the admin allows it (switching it off is always accepted)
    if (typeof b.autoRepair === "boolean") {
      if (b.autoRepair && !autoRepairOn()) return res.status(403).json({ error: REPAIR_DISABLED })
      next.autoRepair = b.autoRepair
    }
    if (typeof b.adminReasoning === "boolean" && req.user.isAdmin) next.adminReasoning = b.adminReasoning
    const clean = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, next[k]]))
    q("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(clean), req.user.id)
    // UI language lives in its own column (also read for localized errors, exports and the agent prompt).
    if (b.locale !== undefined) {
      if (!["vi", "en"].includes(b.locale)) return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
      q("UPDATE users SET locale = ? WHERE id = ?").run(b.locale, req.user.id)
    }
    res.json({ settings: clean, locale: fullUser(req.user.id).locale || null })
  })

  /** The user's "Tự tra lại khi độ tin cậy thấp" preference (403 while the admin does not allow automatic repair). */
  app.get("/api/account/auto-repair", requireUser, (req, res) => {
    const allowed = autoRepairOn()
    res.json({ allowed, enabled: allowed && parseSettings(fullUser(req.user.id).settings).autoRepair === true })
  })
  app.put("/api/account/auto-repair", requireUser, json, (req, res) => {
    if (!autoRepairOn()) return res.status(403).json({ error: REPAIR_DISABLED })
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
    const next = { ...parseSettings(fullUser(req.user.id).settings), autoRepair: req.body.enabled }
    const clean = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, next[k]]))
    q("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(clean), req.user.id)
    res.json({ allowed: true, enabled: clean.autoRepair, settings: clean })
  })

  app.post("/api/account/password", requireUser, json, async (req, res) => {
    if (pwLimiter.blocked(req.user.id)) return res.status(429).json(TOO_MANY)
    const { current, next } = req.body || {}
    const u = fullUser(req.user.id)
    if (typeof current !== "string" || !(await verifyPassword(current, u.salt, u.password_hash))) {
      pwLimiter.hit(req.user.id)
      return res.status(400).json({ error: "Mật khẩu hiện tại không đúng." })
    }
    const invalid = validateCredentials(u.email, next)
    if (invalid) return res.status(400).json({ error: invalid })
    await setPassword(u.id, next)
    // Keep this device signed in, sign out everywhere else.
    q("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(u.id, req.user.tokenHash)
    res.json({ ok: true })
  })

  app.post("/api/account/logout-others", requireUser, (req, res) => {
    const r = q("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(req.user.id, req.user.tokenHash)
    res.json({ ok: true, count: r.changes })
  })

  async function deleteUserData(userId) {
    await chats.deleteAllChats(userId)
    fs.rmSync(path.join(UPLOAD_DIR, userId), { recursive: true, force: true })
    q("DELETE FROM users WHERE id = ?").run(userId)
  }

  app.post("/api/account/delete", requireUser, json, async (req, res) => {
    if (pwLimiter.blocked(req.user.id)) return res.status(429).json(TOO_MANY)
    const { email, password } = req.body || {}
    const u = fullUser(req.user.id)
    if (String(email || "").trim().toLowerCase() !== u.email) return res.status(400).json({ error: "Email xác nhận không khớp." })
    if (typeof password !== "string" || !(await verifyPassword(password, u.salt, u.password_hash))) {
      pwLimiter.hit(req.user.id)
      return res.status(400).json({ error: "Mật khẩu không đúng." })
    }
    if (u.is_admin && q("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0").get().n <= 1)
      return res.status(400).json({ error: "Không thể xoá quản trị viên cuối cùng." })
    await deleteUserData(u.id)
    clearSessionCookie(req, res)
    res.json({ ok: true })
  })

  // ---- admin ----------------------------------------------------------------------------------
  const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Bạn cần đăng nhập." })
    if (!req.user.isAdmin) return res.status(403).json({ error: "Chỉ quản trị viên mới truy cập được." })
    next()
  }
  const target = (req, res) => {
    const u = fullUser(String(req.params.id))
    if (!u) res.status(404).json({ error: "Không tìm thấy người dùng." })
    return u
  }

  app.get("/api/admin/users", requireAdmin, (req, res) => {
    const needle = String(req.query.q || "").trim().toLowerCase().slice(0, 100)
    // Numbered pagination: ?page=1&size=20|50|100
    const size = [20, 50, 100].includes(Number(req.query.size)) ? Number(req.query.size) : 20
    const where = `(? = '' OR lower(u.email) LIKE ? OR lower(COALESCE(u.display_name, '')) LIKE ?)`
    const args = [needle, `%${needle}%`, `%${needle}%`]
    const total = q(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`).get(...args).n
    const pages = Math.max(1, Math.ceil(total / size))
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages)
    const rows = q(
      `SELECT u.*, (SELECT COUNT(*) FROM chats c WHERE c.user_id = u.id) AS chat_count,
              (SELECT MAX(created_at) FROM prompts p WHERE p.user_id = u.id) AS last_prompt_at
       FROM users u WHERE ${where} ORDER BY u.created_at DESC, u.id LIMIT ? OFFSET ?`,
    ).all(...args, size, (page - 1) * size)
    res.json({ users: rows.map((u) => ({ ...userOut(u), chats: u.chat_count, lastPromptAt: u.last_prompt_at || null, self: u.id === req.user.id })), total, page, size, pages })
  })

  app.post("/api/admin/users", requireAdmin, json, async (req, res) => {
    if (adminLimiter.blocked(req.user.id)) return res.status(429).json(TOO_MANY)
    adminLimiter.hit(req.user.id)
    const email = String(req.body?.email || "").trim()
    const generated = !req.body?.password
    const password = generated ? generatePassword() : String(req.body.password)
    const invalid = validateCredentials(email, password)
    if (invalid) return res.status(400).json({ error: invalid })
    if (findUserByEmail(email)) return res.status(400).json({ error: "Email này đã có tài khoản." })
    const u = await createUser(email, password, { admin: !!req.body?.isAdmin })
    res.status(201).json({ user: userOut(fullUser(u.id)), password: generated ? password : undefined })
  })

  app.post("/api/admin/users/:id/reset-password", requireAdmin, async (req, res) => {
    if (adminLimiter.blocked(req.user.id)) return res.status(429).json(TOO_MANY)
    adminLimiter.hit(req.user.id)
    const u = target(req, res)
    if (!u) return
    const password = generatePassword()
    await setPassword(u.id, password)
    q("DELETE FROM sessions WHERE user_id = ?").run(u.id)
    res.json({ ok: true, password }) // shown once in the UI, never stored in plain text
  })

  app.patch("/api/admin/users/:id", requireAdmin, json, (req, res) => {
    const u = target(req, res)
    if (!u) return
    const self = u.id === req.user.id
    if (req.body?.disabled !== undefined) {
      if (self) return res.status(400).json({ error: "Không thể tự khoá tài khoản của mình." })
      q("UPDATE users SET disabled = ? WHERE id = ?").run(req.body.disabled ? 1 : 0, u.id)
      if (req.body.disabled) q("DELETE FROM sessions WHERE user_id = ?").run(u.id)
    }
    if (req.body?.isExpert !== undefined) q("UPDATE users SET is_expert = ? WHERE id = ?").run(req.body.isExpert ? 1 : 0, u.id)
    if (req.body?.isAdmin !== undefined) {
      if (self) return res.status(400).json({ error: "Không thể tự bỏ quyền quản trị của mình." })
      q("UPDATE users SET is_admin = ? WHERE id = ?").run(req.body.isAdmin ? 1 : 0, u.id)
    }
    res.json({ user: userOut(fullUser(u.id)) })
  })

  app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    const u = target(req, res)
    if (!u) return
    if (u.id === req.user.id) return res.status(400).json({ error: "Không thể tự xoá tài khoản của mình ở đây." })
    await deleteUserData(u.id)
    res.json({ ok: true })
  })

  const adminSettings = () => ({
    allowRegistration: allowRegistration(), followupCount: followupCount(), showReasoningToUsers: getSetting("showReasoningToUsers", false) === true,
    // Server-enforced grounding (grounding.mjs): check answers the model left unchecked (default on) / allow users to
    // turn on one repair run on THẤP + the "Tra lại ngay" button (opt-in, default off).
    serverGrounding: getSetting("serverGrounding", true) !== false, autoRepairLowConfidence: autoRepairOn(),
  })
  app.get("/api/admin/settings", requireAdmin, (req, res) => res.json(adminSettings()))
  app.patch("/api/admin/settings", requireAdmin, json, (req, res) => {
    const b = req.body || {}
    if (b.followupCount !== undefined) {
      const n = Number(b.followupCount)
      if (!Number.isInteger(n) || n < 0 || n > 5) return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
      setSetting("followupCount", n)
    }
    if (typeof b.allowRegistration === "boolean") setSetting("allowRegistration", b.allowRegistration)
    if (typeof b.showReasoningToUsers === "boolean") setSetting("showReasoningToUsers", b.showReasoningToUsers)
    for (const k of ["serverGrounding", "autoRepairLowConfidence"]) if (typeof b[k] === "boolean") setSetting(k, b[k])
    res.json(adminSettings())
  })

  // ---- admin-only model switcher (model names / test results never reach normal users) ----
  const modelsOut = () => ({ models: listModels(), active: activeModelId(), default: defaultModelId(), chosen: getSetting("agentModel", "") || null })
  app.get("/api/admin/models", requireAdmin, (req, res) => res.json(modelsOut()))
  app.post("/api/admin/models/test", requireAdmin, json, async (req, res) => {
    const id = String(req.body?.id || "")
    if (!listModels().some((m) => m.id === id)) return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
    res.json({ id, ...(await testModel(id)) })
  })
  app.put("/api/admin/models/active", requireAdmin, json, (req, res) => {
    const id = req.body?.id ? String(req.body.id) : ""
    if (id && !listModels().some((m) => m.id === id)) return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
    setActiveModel(id)
    console.log(`[admin] agent model → ${activeModelId()} (by user ${req.user.id})`)
    res.json(modelsOut())
  })

  app.get("/api/admin/stats", requireAdmin, async (req, res) => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const [health, model] = await Promise.all([opencodeHealth(), getModelInfo()])
    let running = 0
    let waiting = 0
    try {
      const st = await oc.request("GET", "/session/status", undefined, { timeoutMs: 4000 })
      const ours = new Set(q("SELECT opencode_session_id AS s FROM branches").all().map((r) => r.s))
      running = Object.entries(st || {}).filter(([sid, s]) => ours.has(sid) && s?.type !== "idle").length
      // Runs blocked on a clarifying question (included in activeRuns; they wait for the user, not the model).
      if (running) {
        const pend = await oc.request("GET", "/question", undefined, { timeoutMs: 4000 }).catch(() => [])
        waiting = new Set((Array.isArray(pend) ? pend : []).filter((r) => ours.has(r?.sessionID) && st?.[r.sessionID]?.type !== "idle").map((r) => r.sessionID)).size
      }
    } catch {}
    res.json({
      users: q("SELECT COUNT(*) AS n FROM users").get().n,
      disabledUsers: q("SELECT COUNT(*) AS n FROM users WHERE disabled = 1").get().n,
      chats: q("SELECT COUNT(*) AS n FROM chats").get().n,
      chatsToday: q("SELECT COUNT(*) AS n FROM chats WHERE created_at >= ?").get(today).n,
      messagesToday: q("SELECT COUNT(*) AS n FROM prompts WHERE created_at >= ?").get(today).n,
      messages7d: q("SELECT COUNT(*) AS n FROM prompts WHERE created_at >= ?").get(today - 6 * 86400_000).n,
      activeRuns: running,
      waitingOnQuestion: waiting,
      openStreams: chats.hub.count(),
      shares: q("SELECT COUNT(*) AS n FROM shares WHERE revoked_at IS NULL").get().n,
      system: health,
      model,
      agent: config.agent,
    })
  })
}
