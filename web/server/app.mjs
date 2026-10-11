// HTTP API + static frontend.
import express from "express"
import Busboy from "busboy"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { config, UPLOAD_DIR, CLIENT_DIST } from "./config.mjs"
import { q } from "./db.mjs"
import {
  RateLimiter, checkLogin, clearSessionCookie, createSession, createUser, destroySession, findUserByEmail,
  newId, reasoningAllowed, requireUser, sessionMiddleware, setSessionCookie, validateCredentials,
} from "./auth.mjs"
import { extractText } from "./extract.mjs"
import { autoRepairOn } from "./grounding.mjs"
import { StateStore, translateEvent } from "./events.mjs"
import { registerChatRoutes } from "./chats.mjs"
import { allowRegistration, registerAccountRoutes } from "./account.mjs"
import { registerExpertRoutes } from "./experts.mjs"
import { registerArtifactRoutes } from "./artifacts.mjs"
import { registerVisualRoutes } from "./visuals.mjs"
import { registerLibraryRoutes } from "./library.mjs"
import { registerLabRoutes } from "./lab.mjs"
import { startDraftWatcher } from "./drafts.mjs"
import { registerAssistRoutes } from "./assist.mjs"
import { localizeErrors } from "./i18n.mjs"
import { detectPii } from "./pii.mjs"
import { registerSiteRoutes } from "./site.mjs"
import { precompressed } from "./compress.mjs"

export { makeTitle } from "./chats.mjs"

// The prerendered site pages inline theme-init.js (no render-blocking request): the CSP allows exactly
// that script by its sha256 (recomputed when the built file changes).
let themeHash = { mtime: -1, value: "" }
function themeInitHash() {
  const f = path.join(CLIENT_DIST, "theme-init.js")
  try {
    const st = fs.statSync(f)
    if (st.mtimeMs !== themeHash.mtime) themeHash = { mtime: st.mtimeMs, value: " 'sha256-" + crypto.createHash("sha256").update(fs.readFileSync(f)).digest("base64") + "'" }
  } catch {
    themeHash = { mtime: -1, value: "" }
  }
  return themeHash.value
}
const csp = () =>
  [
    "default-src 'self'",
    `script-src 'self'${themeInitHash()}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "manifest-src 'self'",
    "connect-src 'self'", // includes same-origin ws: / wss: (assist live view)
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")

// Client-side routes that exist; anything else gets the SPA with a real 404 status.
const SPA_ROUTES = /^\/(|en|brand|privacy|terms|en\/brand|en\/privacy|en\/terms|login|register|admin|admin\/(?:users|chats|access-log|experts|models|library|lab|settings)|admin\/lab\/[A-Za-z0-9_-]{1,64}|admin\/chats\/[A-Za-z0-9_-]{1,64}|expert|c\/[A-Za-z0-9_-]{1,64}|s\/[A-Za-z0-9_-]{1,64})$/

const clientIp = (req) => req.ip || req.socket.remoteAddress || ""
const publicUser = (u) => u && { id: u.id, email: u.email, isAdmin: u.isAdmin, isExpert: u.isExpert, displayName: u.displayName, settings: u.settings, locale: u.locale || null }

export function createApp({ oc, getModelInfo }) {
  const app = express()
  app.disable("x-powered-by")
  app.set("trust proxy", "loopback") // only local processes (the tunnel) can reach us
  const states = new StateStore()
  startDraftWatcher(oc) // live progress of draft_* tools (progress.json → part updates)
  oc.onAny((ev, sid) => {
    if (sid) translateEvent(ev, states.get(sid)) // keep roles / part kinds / doc names up to date
  })

  // opencode health, cached briefly (maintenance banner, admin screen).
  let health = { at: 0, value: null }
  const opencodeHealth = async () => {
    if (Date.now() - health.at < 5000 && health.value) return health.value
    const t0 = Date.now()
    let ok = false
    try {
      await oc.health()
      ok = true
    } catch {}
    health = { at: Date.now(), value: { ok, ms: Date.now() - t0, events: !!oc.connected } }
    return health.value
  }

  // ---- security headers ------------------------------------------------------------------------
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", csp())
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("X-Frame-Options", "DENY")
    res.setHeader("Referrer-Policy", "same-origin")
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin")
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin")
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000")
    next()
  })

  // Localized API errors (vi / en) with stable codes – see server/i18n.mjs.
  app.use("/api", localizeErrors)

  // ---- CSRF: state-changing API requests must come from our own origin -------------------------
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next()
    const host = req.headers["x-forwarded-host"] && req.ip === "127.0.0.1" ? req.headers["x-forwarded-host"] : req.headers.host
    const src = req.headers.origin || req.headers.referer
    let ok = false
    try {
      ok = !!src && new URL(src).host === String(host).split(",")[0].trim()
    } catch {}
    if (!ok || req.headers["sec-fetch-site"] === "cross-site") return res.status(403).json({ error: "Yêu cầu không hợp lệ (CSRF)." })
    next()
  })

  app.use("/api", sessionMiddleware)
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store")
    next()
  })
  const json = express.json({ limit: "200kb" })
  const upstreamError = (res, e) => {
    console.error("[api] opencode error:", e.message, e.body ? JSON.stringify(e.body).slice(0, 300) : "")
    health.at = 0
    res.status(503).json({ error: "Không kết nối được với trợ lý. Vui lòng thử lại sau ít phút.", code: "agent_down" })
  }

  // ---- auth --------------------------------------------------------------------------------
  const ipLimiter = new RateLimiter({ max: 20, windowMs: 15 * 60_000 })
  const emailLimiter = new RateLimiter({ max: 6, windowMs: 15 * 60_000 })
  const registerLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60_000 })
  setInterval(() => [ipLimiter, emailLimiter, registerLimiter].forEach((l) => l.sweep()), 10 * 60_000).unref()
  const TOO_MANY = { error: "Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ít phút." }

  app.get("/api/health", async (req, res) => {
    const oc = await opencodeHealth()
    res.json({ ok: true, agent: oc.ok })
  })

  app.get("/api/meta", async (req, res) => {
    // Public / user API: never expose the vendor, model id or provider – only a generic label (the real
    // model is shown to admins only, in GET /api/admin/stats).
    res.json({ allowRegistration: allowRegistration(), model: req.user ? { name: "FTU Tech Lab AI model" } : null, ...(req.user ? { reasoning: reasoningAllowed(req.user), autoRepair: autoRepairOn() } : {}) })
  })

  app.get("/api/me", (req, res) => {
    res.json({ user: publicUser(req.user) || null }) // 200 either way: "not logged in" is not an error for the SPA
  })

  app.post("/api/auth/login", json, async (req, res) => {
    const { email, password } = req.body || {}
    const ip = clientIp(req)
    const ekey = String(email || "").trim().toLowerCase()
    if (ipLimiter.blocked(ip) || emailLimiter.blocked(ekey)) return res.status(429).json(TOO_MANY)
    const generic = { error: "Email hoặc mật khẩu không đúng." }
    if (typeof email !== "string" || typeof password !== "string" || email.length > 254 || password.length > 200) {
      ipLimiter.hit(ip)
      return res.status(401).json(generic)
    }
    const user = await checkLogin(email, password)
    if (!user) {
      ipLimiter.hit(ip)
      emailLimiter.hit(ekey)
      return res.status(401).json(generic)
    }
    emailLimiter.reset(ekey)
    q("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), user.id)
    const token = createSession(user.id)
    setSessionCookie(req, res, token)
    res.json({ user: { id: user.id, email: user.email, isAdmin: !!user.is_admin } })
  })

  app.post("/api/auth/register", json, async (req, res) => {
    if (!allowRegistration()) return res.status(403).json({ error: "Đăng ký tài khoản đang tắt. Liên hệ quản trị viên." })
    const ip = clientIp(req)
    if (registerLimiter.blocked(ip)) return res.status(429).json(TOO_MANY)
    const { email, password } = req.body || {}
    const invalid = validateCredentials(email, password)
    if (invalid) return res.status(400).json({ error: invalid })
    registerLimiter.hit(ip)
    if (findUserByEmail(email)) return res.status(400).json({ error: "Không thể tạo tài khoản với email này." })
    let user
    try {
      user = await createUser(email, password)
    } catch {
      return res.status(400).json({ error: "Không thể tạo tài khoản với email này." })
    }
    q("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), user.id)
    const token = createSession(user.id)
    setSessionCookie(req, res, token)
    res.status(201).json({ user })
  })

  app.post("/api/auth/logout", (req, res) => {
    destroySession(req.sessionToken)
    clearSessionCookie(req, res)
    res.json({ ok: true })
  })

  // ---- chats, account, admin ------------------------------------------------------------------
  const chats = registerChatRoutes(app, { oc, states, json, upstreamError })
  registerAccountRoutes(app, { oc, json, chats, getModelInfo, opencodeHealth })
  registerExpertRoutes(app, { oc, states, json, chats })
  registerArtifactRoutes(app)
  registerVisualRoutes(app)
  // assisted browsing on official sites: assist events, live view (WebSocket upgrade via app.locals.upgrade), input, cancel
  const assist = registerAssistRoutes(app, { oc, hub: chats.hub, json })
  app.locals.upgrade = assist.upgrade
  registerLibraryRoutes(app, { oc, json }) // Admin → tools & skills library
  registerLabRoutes(app, { json }) // Admin → Lab thử nghiệm (pilot products, drafts only)

  // ---- uploads ------------------------------------------------------------------------------
  // Processing status of an upload in flight (the client sends X-Upload-Key and polls while the server extracts):
  // "extract" → "ocr-wait" (another scan is being recognised) → "ocr" (recognising this scan, ~2.5 s/page).
  const uploadPhases = new Map() // key -> { userId, phase, pages, at }
  const UPLOAD_KEY_RE = /^[A-Za-z0-9_-]{8,40}$/
  const setPhase = (key, userId, phase, info = {}) => {
    if (!key) return
    uploadPhases.set(key, { userId, phase, ...(info.pages ? { pages: info.pages } : {}), at: Date.now() })
    if (uploadPhases.size > 500) for (const [k, v] of uploadPhases) if (Date.now() - v.at > 10 * 60_000) uploadPhases.delete(k)
  }
  app.get("/api/uploads/progress/:key", requireUser, (req, res) => {
    const p = uploadPhases.get(String(req.params.key))
    if (!p || p.userId !== req.user.id) return res.json({ phase: "unknown" })
    res.json({ phase: p.phase, ...(p.pages ? { pages: p.pages } : {}) })
  })
  const ocrOut = (o) => (o ? { engine: String(o.engine || ""), pages: (o.pages || []).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200), totalPages: Number.isInteger(o.totalPages) ? o.totalPages : 0 } : null)

  app.post("/api/uploads", requireUser, (req, res) => {
    const upKey = UPLOAD_KEY_RE.test(String(req.headers["x-upload-key"] || "")) ? String(req.headers["x-upload-key"]) : null
    const ctype = String(req.headers["content-type"] || "")
    if (!ctype.startsWith("multipart/form-data")) return res.status(400).json({ error: "Yêu cầu tải lên không hợp lệ." })
    const recent = q("SELECT COUNT(*) AS n FROM uploads WHERE user_id = ? AND created_at > ?").get(req.user.id, Date.now() - 86400_000).n
    if (recent >= 100) return res.status(429).json({ error: "Bạn đã tải lên quá nhiều tệp trong 24 giờ qua." })
    const declared = Number(req.headers["content-length"] || 0)
    if (declared > config.maxUploadBytes + 64 * 1024) return res.status(413).json({ error: "Tệp vượt quá 10 MB." })
    const userDir = path.join(UPLOAD_DIR, req.user.id)
    fs.mkdirSync(userDir, { recursive: true })
    let bb
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: config.maxUploadBytes, fields: 2, parts: 3 }, defParamCharset: "utf8" })
    } catch {
      return res.status(400).json({ error: "Yêu cầu tải lên không hợp lệ." })
    }
    let done = false
    const fail = (status, error, file) => {
      if (done) return
      done = true
      if (file) fs.rm(file, { force: true }, () => {})
      res.status(status).json({ error })
      req.unpipe(bb)
      req.resume()
    }
    let handled = false
    bb.on("file", (_field, stream, info) => {
      handled = true
      const name = path.basename(String(info.filename || "tep")).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 150) || "tep"
      const ext = path.extname(name).toLowerCase()
      if (!config.uploadExtensions.includes(ext)) {
        stream.resume()
        return fail(415, "Chỉ nhận tệp .docx, .pdf, .txt, .md.")
      }
      const id = "f_" + newId(12)
      const stored = path.join(userDir, id + ext)
      const out = fs.createWriteStream(stored, { flags: "wx" })
      let size = 0
      stream.on("data", (d) => (size += d.length))
      stream.on("limit", () => fail(413, "Tệp vượt quá 10 MB.", stored))
      stream.pipe(out)
      out.on("error", () => fail(500, "Không lưu được tệp.", stored))
      out.on("finish", async () => {
        if (done) return fs.rm(stored, { force: true }, () => {})
        if (!size) return fail(400, "Tệp trống.", stored)
        setPhase(upKey, req.user.id, "extract")
        try {
          // a scan is OCR'd (can take ~2.5 s/page); a client that went away no longer needs it
          const r = await extractText(stored, ext, config.maxExtractChars, { onPhase: (phase, info) => setPhase(upKey, req.user.id, phase, info) })
          if (done) return fs.rm(stored, { force: true }, () => {})
          const ocr = ocrOut(r.ocr)
          const textPath = path.join(userDir, id + ".txt")
          fs.writeFileSync(textPath, r.text)
          q("INSERT INTO uploads (id, user_id, name, size, stored_path, text_path, chars, truncated, created_at, ocr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            id, req.user.id, name, size, stored, textPath, r.chars, r.truncated ? 1 : 0, Date.now(), ocr ? JSON.stringify(ocr) : null)
          done = true
          // pii: categories of personal identifiers in the text (never the values) – the client warns before sending (values never leave the server).
          // ocr: the text was recognised from a scan (may contain wrong diacritics / letters) – pages OCR'd of totalPages.
          res.status(201).json({ upload: { id, name, size, chars: r.chars, sentChars: r.text.length, truncated: r.truncated, pii: detectPii(r.text), ...(ocr ? { ocr } : {}) } })
        } catch (e) {
          console.warn("[upload] extract failed:", e.message)
          fail(422, /[À-ỹ]/.test(e.message) ? e.message : "Không đọc được nội dung tệp.", stored)
        } finally {
          setPhase(upKey, req.user.id, "done")
        }
      })
    })
    bb.on("error", () => fail(400, "Yêu cầu tải lên không hợp lệ."))
    bb.on("close", () => {
      if (!handled) fail(400, "Không có tệp nào được gửi.")
    })
    req.pipe(bb)
  })

  app.delete("/api/uploads/:id", requireUser, (req, res) => {
    const u = q("SELECT * FROM uploads WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user.id)
    if (!u) return res.status(404).json({ error: "Không tìm thấy tệp." })
    for (const p of [u.stored_path, u.text_path]) fs.rm(p, { force: true }, () => {})
    q("DELETE FROM uploads WHERE id = ?").run(u.id)
    res.json({ ok: true })
  })

  app.use("/api", (_req, res) => res.status(404).json({ error: "Không tìm thấy." }))

  // ---- frontend ------------------------------------------------------------------------------
  // Brotli / gzip versions of text assets (built by scripts/precompress.mjs).
  const cacheFor = (p) => (p.startsWith("/assets/") ? "public, max-age=31536000, immutable" : /^\/(media|brand)\//.test(p) ? "public, max-age=86400" : "public, max-age=3600")
  app.use(precompressed(CLIENT_DIST, cacheFor))
  app.use(
    "/assets",
    express.static(path.join(CLIENT_DIST, "assets"), { immutable: true, maxAge: "1y", index: false, fallthrough: false }),
  )
  // The SPA shell (app, auth, share pages): never indexed.
  const sendApp = (req, res) => {
    const index = path.join(CLIENT_DIST, "index.html")
    if (!fs.existsSync(index)) return res.status(503).type("text/plain").send("Frontend chưa được build. Chạy: npm run build")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("X-Robots-Tag", "noindex, nofollow")
    if (req.path.startsWith("/s/")) {
      // Public read-only share pages: keep them out of search engines and do not leak the token.
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive")
      res.setHeader("Referrer-Policy", "no-referrer")
    }
    if (!SPA_ROUTES.test(req.path)) res.status(404)
    res.sendFile(index)
  }
  // Public site: prerendered landing / brand / legal pages, robots.txt, sitemap.xml (server/site.mjs).
  registerSiteRoutes(app, { sendApp })
  app.use("/_site", (_req, res) => res.status(404).end()) // raw prerender templates are not public
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      maxAge: "1h",
      setHeaders: (res, file) => {
        if (/[\\/](media|brand)[\\/]/.test(file)) res.setHeader("Cache-Control", "public, max-age=86400")
      },
    }),
  )
  app.get(/^\/(?!api\/).*/, sendApp)

  // ---- errors -----------------------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "Dữ liệu gửi lên quá lớn." })
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
    if (err?.status === 404) return res.status(404).end()
    console.error("[api] unhandled", err)
    res.status(500).json({ error: "Lỗi máy chủ." })
  })

  return app
}
