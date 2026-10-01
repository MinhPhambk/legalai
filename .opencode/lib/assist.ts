// Assisted browsing on an official site ("trợ giúp của người dùng trên trang chính thức").
//
// When an official page needs a human check (image CAPTCHA, reCAPTCHA), the tool opens it in the sandbox Chrome,
// the web UI shows the user a live mirror of that page and the USER solves the check / clicks on it themselves; the
// tool only waits for the result page, then reads it. Nothing here ever solves, types or clicks a CAPTCHA.
//
//   requestAssist({ sessionID, url, purpose, prefill?, successWhen, timeoutMs = 300 000 })
//     1. new isolated browser context (own cookies, closed afterwards) + one offscreen tab, viewport 1200×800,
//        navigation guard (allowlisted official hosts only), downloads denied, popups closed;
//     2. opens the URL, fills the prefill fields (e.g. the MST box – never the CAPTCHA box);
//     3. writes <outputs>/<sessionID>/assist/<assistId>.json {assistId, targetId, url, purpose, status:"waiting_user",
//        createdAt, expiresAt, …} – the web server (web/server/assist.mjs) watches these files, notifies the chat
//        owner and relays the live view (CDP screencast of `targetId`) and the user's mouse / keyboard input;
//     4. polls every 500 ms until successWhen holds, the file says "cancelled" (user pressed Huỷ), the tool call is
//        aborted, or the timeout – then updates the file (done | cancelled | timeout | error), optionally lets the
//        caller read further on the page (`collect`, e.g. open the detail row), closes the context and returns.
//
// File protocol (also read by the web server – keep in sync with web/server/assist.mjs):
//   { v: 1, assistId: "a-YYYYMMDD-xxxxxxxx", sessionID, targetId, contextId, url, openUrl, host, purpose, source,
//     status: "waiting_user" | "done" | "cancelled" | "timeout" | "error",
//     createdAt, expiresAt, updatedAt, doneAt?, viewport: {width, height}, notice?, blockedNav? }
// Only the web server's cancel endpoint writes to the file besides this module (status "cancelled").
import puppeteer from "puppeteer-core"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { polite } from "./polite.ts"

const PORT = process.env.CHROME_PORT ?? "9333"
export const ASSIST_ID_RE = /^a-\d{8}-[0-9a-f]{8}$/
const SESSION_RE = /^[A-Za-z0-9_-]{1,80}$/
export const VIEWPORT = { width: 1200, height: 800 }
export const DEFAULT_TIMEOUT = 300_000

// Same resolution as doc-store outputsRoot() (kept here: doc-store pulls in the document stack).
export const outputsRoot = () =>
  process.env.LEGALAI_OUTPUTS_DIR ??
  (process.env.XDG_CACHE_HOME
    ? path.join(process.env.XDG_CACHE_HOME, "..", "outputs")
    : path.join(fileURLToPath(new URL("../../", import.meta.url)), ".sandbox", "outputs"))
export const assistDir = (sessionID: string) => path.join(outputsRoot(), sessionID, "assist")
export const assistFile = (sessionID: string, assistId: string) => path.join(assistDir(sessionID), `${assistId}.json`)

// ---------------------------------------------------------------- navigation guard
/** Official hosts an assisted page may navigate to, per purpose (a host matches itself and its subdomains). */
export const ASSIST_HOSTS: Record<string, string[]> = {
  company_lookup: ["dkkd.gov.vn", "dangkykinhdoanh.gov.vn", "tracuunnt.gdt.gov.vn", "gdt.gov.vn"],
  company_verify: ["dkkd.gov.vn", "dangkykinhdoanh.gov.vn", "tracuunnt.gdt.gov.vn", "gdt.gov.vn"],
}
// Google reCAPTCHA widget: its frames / scripts / challenge images (host + path prefix; "" = any path).
const RECAPTCHA: [string, string][] = [["google.com", "/recaptcha/"], ["google.com", "/js/bg/"], ["recaptcha.net", "/recaptcha/"], ["gstatic.com", ""]]
const FONTS = ["fonts.googleapis.com", "fonts.gstatic.com"]
export const hostMatches = (host: string, domain: string) => host === domain || host.endsWith("." + domain)

/** Loopback / private / link-local / reserved addresses and local names – never reachable from an assisted page. */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (!h || h === "localhost" || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(h) || !h.includes(".") && !h.includes(":")) return true
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(h) || h.startsWith("::ffff:")
  return false
}

export type GuardKind = "main" | "frame" | "sub"
export type Guard = { ok: true } | { ok: false; reason: "scheme" | "internal" | "host" }
/**
 * May an assisted page load `raw`? Main-frame navigations: the purpose's official hosts only; sub-frames: + the
 * reCAPTCHA widget; sub-resources: + reCAPTCHA scripts / images and web fonts (trackers, other CDNs are dropped).
 * data: / blob: / about: are local to the page. file:, chrome:, javascript: etc. and internal addresses: never.
 * `extraHosts` (host[:port]) is for tests with a local page and only works together with ND45_ASSIST_TEST=1.
 */
export function guardUrl(raw: string, kind: GuardKind, hosts: string[], extraHosts: string[] = []): Guard {
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: "scheme" } }
  if (u.protocol === "data:" || u.protocol === "blob:" || u.href === "about:blank" || u.href === "about:srcdoc") return kind === "main" && u.protocol !== "about:" ? { ok: false, reason: "scheme" } : { ok: true }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "scheme" }
  const host = u.hostname.toLowerCase()
  const test = process.env.ND45_ASSIST_TEST === "1" && extraHosts.includes(u.host.toLowerCase())
  if (test) return { ok: true }
  if (isInternalHost(host)) return { ok: false, reason: "internal" }
  if (hosts.some((d) => hostMatches(host, d))) return { ok: true }
  if (kind === "main") return { ok: false, reason: "host" }
  if (RECAPTCHA.some(([d, p]) => hostMatches(host, d) && u.pathname.startsWith(p))) return { ok: true }
  if (kind === "sub" && FONTS.some((d) => hostMatches(host, d))) return { ok: true }
  return { ok: false, reason: "host" }
}

// ---------------------------------------------------------------- state file
export type AssistStatus = "waiting_user" | "done" | "cancelled" | "timeout" | "error"
export type AssistState = {
  v: 1; assistId: string; sessionID: string; targetId: string; contextId: string; url: string; openUrl: string; host: string; purpose: string; source?: string
  status: AssistStatus; createdAt: number; expiresAt: number; updatedAt: number; doneAt?: number; viewport: { width: number; height: number }; notice?: string; noticeAt?: number; reason?: string; blockedNav?: number
  /** The mirrored page itself is an error page: rate_limited (HTTP 429 / "Too Many Requests"), server_error (5xx), http_error. */
  pageError?: "rate_limited" | "server_error" | "http_error"; pageStatus?: number; pageErrorAt?: number
  /** Written by the web server when the user presses "Thử lại": the tool reloads the form (≥ 15 s apart). */
  reloadAt?: number
  /** Where the part the user must operate is (page CSS px, after scrolling it into view) – the live view pans to it. */
  focus?: { x: number; y: number; w: number; h: number }
}
export function readAssist(sessionID: string, assistId: string): AssistState | null {
  try { return JSON.parse(fs.readFileSync(assistFile(sessionID, assistId), "utf8")) } catch { return null }
}
/** Atomic write (tmp + rename; retried – the web server may be reading the file on Windows). */
export function writeAssist(s: AssistState) {
  const f = assistFile(s.sessionID, s.assistId)
  const cur = readAssist(s.sessionID, s.assistId)
  if (cur) {
    if (cur.status === "cancelled" && s.status === "waiting_user") s = { ...s, status: "cancelled", reason: cur.reason }
    if (cur.reloadAt && (!s.reloadAt || cur.reloadAt > s.reloadAt)) s = { ...s, reloadAt: cur.reloadAt }
  }
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...s, updatedAt: Date.now() }))
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, f); return } catch (e) { if (i >= 20) { fs.rmSync(tmp, { force: true }); throw e } }
    const until = Date.now() + 25
    while (Date.now() < until) {} // brief spin: rename collided with a reader
  }
}

// ---------------------------------------------------------------- orphaned contexts
// If the tool process dies while waiting (serve restarted), its context would stay open in the sandbox Chrome.
// Every context this module creates is listed with its expiry; each new request disposes the expired ones first.
const registryFile = () => path.join(outputsRoot(), "_assist-contexts.json")
function registry(update?: (r: Record<string, number>) => void): Record<string, number> {
  let r: Record<string, number> = {}
  try { r = JSON.parse(fs.readFileSync(registryFile(), "utf8")) } catch {}
  if (update) {
    update(r)
    try { fs.mkdirSync(path.dirname(registryFile()), { recursive: true }); fs.writeFileSync(registryFile(), JSON.stringify(r)) } catch {}
  }
  return r
}
async function sweepOrphans(conn: any) {
  const now = Date.now()
  const stale = Object.entries(registry()).filter(([, exp]) => now > exp + 60_000).map(([id]) => id)
  if (!stale.length) return
  const { browserContextIds = [] } = await conn.send("Target.getBrowserContexts").catch(() => ({}))
  for (const id of stale) if (browserContextIds.includes(id)) await conn.send("Target.disposeBrowserContext", { browserContextId: id }).catch(() => {})
  registry((r) => { for (const id of stale) delete r[id] })
}

// ---------------------------------------------------------------- request
export type SuccessWhen = { selector?: string | string[]; urlIncludes?: string | string[]; textIncludes?: string | string[] }
export type AssistRequest = {
  sessionID: string
  url: string
  /** Code of what the user is helping with (shown in the UI): company_lookup | company_verify. */
  purpose: string
  /** Which official source (UI label): gdt | dkkd | test. */
  source?: string
  /** URL the user may open in a normal tab instead ("Mở trang chính thức ở tab mới"); default `url`. */
  openUrl?: string
  prefill?: { selector: string; value: string }[]
  /** The element the user has to operate (CAPTCHA box / widget): scrolled into view, its position sent to the live view. */
  focus?: string
  /** Also part of the region the live view zooms to (e.g. the search button next to the code box). */
  focusAlso?: string
  /**
   * The page's search button: Enter pressed BY THE USER in a text box of the form clicks it. Some official forms
   * (tracuunnt) have no submit button – their "Tra cứu" is a JS button – so Enter does nothing there otherwise.
   */
  enterClicks?: string
  /** Page messages to show the user in the window (default: wrong / missing code messages). */
  messages?: RegExp
  successWhen: SuccessWhen
  timeoutMs?: number
  signal?: AbortSignal
  /** Test only (with ND45_ASSIST_TEST=1): extra host[:port] allowed, e.g. a local fake page. */
  testHosts?: string[]
  /** Steps before the user is asked (e.g. open the search form) – no CAPTCHA may be touched here. */
  prepare?: (page: any) => Promise<void>
  /** After success, read further on the page (e.g. open the detail of the result row); text returned as `collected`. */
  collect?: (page: any) => Promise<string>
  /** Called once the page is ready for the user (status file written). */
  onWaiting?: (s: AssistState) => void
}
export type AssistResult = {
  ok: boolean
  status: Exclude<AssistStatus, "waiting_user">
  assistId: string
  url?: string
  text?: string
  html?: string
  collected?: string
  error?: string
  /** Requests the guard refused (for tests / logs): "<kind> <reason> <host>". */
  blocked: string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** One request per official host at a time, ≥ 5 s apart (the sites rate-limit by IP: HTTP 429). */
const OFFICIAL_LIMIT = { concurrency: 1, gapMs: 5000 }
const RELOAD_GAP_MS = 15_000
/** Is the mirrored page an error page of the site itself? */
export function pageErrorOf(status: number, text: string): AssistState["pageError"] {
  const short = text.length < 2500
  if (status === 429 || (short && /too many requests|quá nhiều (?:yêu cầu|truy cập|lượt)|vượt quá (?:số lần|giới hạn)|rate limit/i.test(text))) return "rate_limited"
  if (status >= 500 || (short && /service unavailable|bad gateway|gateway time-?out|internal server error/i.test(text))) return "server_error"
  if (status >= 400) return "http_error"
  return undefined
}
/** Wrong / missing code messages of official forms (Vietnamese). */
export const DEFAULT_MESSAGES = /(vui lòng (?:nhập|chọn|kiểm tra)[^.!\n]{2,80}[.!]?|mã xác (?:nhận|thực) (?:không (?:đúng|hợp lệ|chính xác)|sai|đã hết hạn)[^.!\n]{0,60}[.!]?|sai mã xác (?:nhận|thực)[^.!\n]{0,60}[.!]?)/i
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, "")
const list = (v?: string | string[]) => (Array.isArray(v) ? v : v ? [v] : []).filter((x) => typeof x === "string" && x)

/** Does the page satisfy `w`? (runs in the page; any match of any list wins) */
const satisfied = (page: any, w: SuccessWhen): Promise<boolean> =>
  page.evaluate((sel: string[], urls: string[], texts: string[]) => {
    if (urls.some((u) => location.href.includes(u))) return true
    if (sel.some((s) => { try { return !!document.querySelector(s) } catch { return false } })) return true
    const body = document.body?.innerText ?? ""
    return texts.some((t) => body.includes(t))
  }, list(w.selector), list(w.urlIncludes), list(w.textIncludes)).catch(() => false)

/** Fill the prefill fields that are still empty (after every navigation – a wrong code reloads the form). */
const applyPrefill = (page: any, prefill: { selector: string; value: string }[]) =>
  prefill.length
    ? page.evaluate((items: { selector: string; value: string }[]) => {
        for (const { selector, value } of items) {
          const el = document.querySelector(selector) as HTMLInputElement | null
          if (!el || el.value || /captcha|recaptcha|xac.?nhan/i.test(`${el.name} ${el.id}`)) continue
          el.value = value
          el.dispatchEvent(new Event("input", { bubbles: true }))
          el.dispatchEvent(new Event("change", { bubbles: true }))
        }
      }, prefill).catch(() => {})
    : Promise.resolve()

/**
 * Ask the user to pass the human check of an official page themselves and wait for the result page.
 * Never throws for user-side outcomes (cancel / timeout); throws only on invalid arguments.
 */
export async function requestAssist(req: AssistRequest): Promise<AssistResult> {
  const { sessionID, url, purpose } = req
  if (!SESSION_RE.test(String(sessionID ?? ""))) throw new Error("requestAssist: sessionID không hợp lệ")
  if (!/^[a-z_]{1,40}$/.test(purpose)) throw new Error("requestAssist: purpose không hợp lệ")
  const hosts = ASSIST_HOSTS[purpose] ?? []
  const extra = (req.testHosts ?? []).map((h) => h.toLowerCase())
  const g0 = guardUrl(url, "main", hosts, extra)
  if (!g0.ok) throw new Error(`requestAssist: URL ngoài danh sách trang chính thức cho phép (${g0.reason})`)
  if (req.prefill?.some((p) => /captcha|recaptcha/i.test(p.selector))) throw new Error("requestAssist: không được điền sẵn ô mã xác thực")
  const timeoutMs = Math.min(Math.max(Number(req.timeoutMs ?? DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT, 5_000), 15 * 60_000)
  const assistId = `a-${today()}-${crypto.randomBytes(4).toString("hex")}`
  const blocked: string[] = []
  const prefill = (req.prefill ?? []).slice(0, 5).map((p) => ({ selector: String(p.selector).slice(0, 200), value: String(p.value).slice(0, 200) }))
  let state: AssistState | null = null
  let browser: any = null
  let ctx: any = null
  const finish = (status: AssistResult["status"], extraFields: Partial<AssistResult> = {}): AssistResult => {
    if (state) {
      const cur = readAssist(sessionID, assistId)
      // the user's cancel wins over a later outcome of this side
      const final = cur?.status === "cancelled" ? "cancelled" : status
      try { writeAssist({ ...state, status: final, ...(final === "done" ? { doneAt: state.doneAt ?? Date.now() } : {}), ...(extraFields.error ? { reason: String(extraFields.error).slice(0, 200) } : {}) }) } catch {}
      status = final
    }
    return { ok: status === "done", status, assistId, blocked, ...extraFields }
  }
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
    const conn = browser._connection ?? (await browser.target().createCDPSession())
    await sweepOrphans(conn)
    ctx = await browser.createBrowserContext()
    const ctxId = String(ctx.id ?? "")
    if (ctxId) registry((r) => { r[ctxId] = Date.now() + timeoutMs + 120_000 })
    await conn.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: ctx.id }).catch(() => {})
    // one tab, its window off the visible desktop (the sandbox Chrome is a headed, off-screen instance)
    let page: any
    let targetId = ""
    try {
      const r = await conn.send("Target.createTarget", { url: "about:blank", browserContextId: ctx.id, newWindow: true, left: -32000, top: -32000, width: VIEWPORT.width + 16, height: VIEWPORT.height + 100 })
      targetId = r.targetId
      const t = await browser.waitForTarget((x: any) => x._targetId === targetId, { timeout: 10_000 })
      page = await t.page()
    } catch {
      page = await ctx.newPage()
      targetId = page.target()._targetId
    }
    await page.setViewport(VIEWPORT)
    // ---- guard: every request of the tab (main frame, sub-frames, sub-resources)
    await page.setRequestInterception(true)
    page.on("request", (r: any) => {
      if (r.isInterceptResolutionHandled?.()) return
      const frame = r.frame?.()
      const kind: GuardKind = r.isNavigationRequest() ? (!frame || frame === page.mainFrame() ? "main" : "frame") : "sub"
      const g = guardUrl(r.url(), kind, hosts, extra)
      if (g.ok) return r.continue().catch(() => {})
      let host = ""
      try { host = new URL(r.url()).host } catch {}
      if (blocked.length < 200) blocked.push(`${kind} ${g.reason} ${host || r.url().slice(0, 40)}`)
      if (kind === "sub") return r.abort("blockedbyclient").catch(() => {})
      // a refused navigation answers 204 No Content: the browser stays on the current page (no error page)
      r.respond({ status: 204, body: "" }).catch(() => {})
      if (kind === "main" && state?.status === "waiting_user") { state = { ...state, blockedNav: (state.blockedNav ?? 0) + 1 }; try { writeAssist(state) } catch {} }
    })
    // popups (window.open, target=_blank) are not mirrored: closed at once
    const onTarget = async (t: any) => {
      try { if (t._targetId !== targetId && t.type() === "page") { blocked.push(`popup closed ${t.url().slice(0, 60)}`); await (await t.page())?.close() } } catch {}
    }
    ctx.on("targetcreated", onTarget)
    // alert() / confirm() would freeze the mirrored page: dismissed, the text shown to the user as a notice
    let notice = ""
    page.on("dialog", async (d: any) => {
      notice = String(d.message() ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
      await d.dismiss().catch(() => {})
      if (state && state.status === "waiting_user") { state = { ...state, notice, noticeAt: Date.now() }; try { writeAssist(state) } catch {} }
    })

    // the user's Enter in a form field = a click on the page's own search button (see enterClicks)
    if (req.enterClicks)
      await page.evaluateOnNewDocument((sel: string) => {
        if (window.top !== window) return
        document.addEventListener("keydown", (e) => {
          const t = e.target as HTMLInputElement | null
          if (e.key !== "Enter" || e.defaultPrevented || !t || t.tagName !== "INPUT" || !/^(text|search|tel|number|)$/.test(t.type) || !t.form) return
          const b = document.querySelector(sel) as HTMLElement | null
          if (!b) return
          e.preventDefault()
          e.stopPropagation()
          b.click()
        }, true)
      }, req.enterClicks)
    // status of every main-document response (a 429 page from the site must not look like "waiting for the user")
    let lastStatus = 0
    page.on("response", (r: any) => {
      try {
        if (!r.request().isNavigationRequest() || r.frame() !== page.mainFrame()) return
        lastStatus = r.status()
        if (lastStatus >= 400) console.warn(`[assist] ${new URL(r.url()).hostname} HTTP ${lastStatus} (${assistId})`)
      } catch {}
    })
    await polite(url, () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }), OFFICIAL_LIMIT)
    if (req.prepare) await req.prepare(page)
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {})
    await applyPrefill(page, prefill)
    const focus = req.focus
      ? await page.evaluate((sel: string, also: string) => {
          const el = document.querySelector(sel)
          if (!el) return null
          el.scrollIntoView({ block: "center", inline: "center" })
          // the box + the picture / widget next to it in the same row (a code box is useless without its picture)
          // + the search button: the region the live view zooms to
          const row = el.closest("tr, .form-group, li, p")
          const parts = [el, ...(row ? Array.from(row.querySelectorAll("img, canvas, iframe, [id*='cap' i], [class*='cap' i]")) : []), ...(also ? Array.from(document.querySelectorAll(also)).slice(0, 2) : [])]
          const rs = parts.map((p) => p.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
          const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top))
          const w = Math.max(...rs.map((r) => r.right)) - x, h = Math.max(...rs.map((r) => r.bottom)) - y
          return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
        }, req.focus, req.focusAlso ?? "").catch(() => null)
      : null
    // after every page load while waiting: prefill again (a wrong code reloads the form) and pick up the page's own
    // message ("Vui lòng nhập đúng mã xác nhận!") so the user sees why in the window
    const MSG = req.messages ?? DEFAULT_MESSAGES
    const pageMessage = async () => {
      const [m, head] = await page.evaluate((src: string, flags: string) => {
        const re = new RegExp(src, flags)
        const t = (document.body?.innerText ?? "").replace(/\s+/g, " ")
        return [t.match(re)?.[0] ?? "", t.slice(0, 3000)]
      }, MSG.source, MSG.flags).catch(() => ["", ""])
      const msg = String(m).trim().slice(0, 200)
      const pe = pageErrorOf(lastStatus, String(head))
      if (!state || state.status !== "waiting_user") return
      if ((state.notice ?? "") !== msg || msg || (state.pageError ?? "") !== (pe ?? "")) {
        state = {
          ...state, notice: msg || undefined, noticeAt: msg ? Date.now() : undefined,
          pageError: pe, pageStatus: pe ? lastStatus || undefined : undefined, pageErrorAt: pe ? (state.pageError === pe ? state.pageErrorAt : Date.now()) : undefined,
        }
        try { writeAssist(state) } catch {}
      }
    }
    // …and the part to operate back where the live view is looking (a reload starts at the top of the page)
    const refocus = () => (req.focus ? page.evaluate((sel: string) => document.querySelector(sel)?.scrollIntoView({ block: "center", inline: "center" }), req.focus).catch(() => {}) : Promise.resolve())
    page.on("load", () => { applyPrefill(page, prefill); refocus(); pageMessage() })

    const now = Date.now()
    const host = new URL(url).hostname.replace(/^www\./, "")
    state = {
      v: 1, assistId, sessionID, targetId, contextId: String(ctx.id ?? ""), url, openUrl: req.openUrl ?? url, host, purpose, ...(req.source ? { source: req.source } : {}),
      status: "waiting_user", createdAt: now, expiresAt: now + timeoutMs, updatedAt: now, viewport: VIEWPORT, ...(notice ? { notice } : {}), ...(focus ? { focus } : {}),
    }
    writeAssist(state)
    await pageMessage()
    req.onWaiting?.(state)
    let handledReload = 0, lastReload = Date.now()

    // ---- wait for the user
    for (;;) {
      if (req.signal?.aborted) return await close(finish("cancelled", { error: "aborted" }))
      const cur = readAssist(sessionID, assistId)
      if (cur?.status === "cancelled") return await close(finish("cancelled"))
      if (cur?.reloadAt && cur.reloadAt > handledReload) {
        handledReload = cur.reloadAt
        if (Date.now() - lastReload >= RELOAD_GAP_MS) {
          lastReload = Date.now()
          await polite(url, () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }), OFFICIAL_LIMIT).catch(() => {})
          if (req.prepare) await req.prepare(page).catch(() => {})
          await pageMessage()
        }
      }
      if (Date.now() >= state.expiresAt) return await close(finish("timeout"))
      if (page.isClosed()) return await close(finish("error", { error: "trang đã đóng" }))
      if (await satisfied(page, req.successWhen)) break
      await sleep(500)
    }
    state = { ...state, status: "done", doneAt: Date.now() }
    writeAssist(state)
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {})
    let collected = ""
    if (req.collect) {
      try { collected = String(await Promise.race([req.collect(page), sleep(25_000).then(() => "")]) ?? "") } catch {}
    }
    const [text, html] = await Promise.all([
      page.evaluate(() => document.body?.innerText ?? "").catch(() => ""),
      page.content().catch(() => ""),
    ])
    return await close(finish("done", { url: page.url(), text: String(text).slice(0, 200_000), html: String(html).slice(0, 500_000), collected: collected.slice(0, 200_000) }))
  } catch (e: any) {
    return await close(finish("error", { error: String(e?.message ?? e).slice(0, 300) }))
  }

  async function close<T>(r: T): Promise<T> {
    // the assist tab / context is always closed: no cookie or page of this user outlives the request
    try { await ctx?.close() } catch {}
    const id = String(ctx?.id ?? "")
    if (id) registry((r) => { delete r[id] })
    try { browser?.disconnect() } catch {}
    return r
  }
}

/** Every table of the page as text (cells tab-separated, one row per line) + the visible text – for the parsers. */
export const pageTables = (page: any): Promise<string> =>
  page.evaluate(() => {
    const out: string[] = []
    const cell = (c: Element) => ((c as HTMLElement).innerText ?? "").replace(/\s*\n\s*/g, " ").trim()
    for (const tb of Array.from(document.querySelectorAll("table"))) {
      if (tb.querySelector("table")) continue // innermost tables only (layout tables wrap the data)
      if ((tb as HTMLElement).offsetParent === null && getComputedStyle(tb).display === "none") continue
      for (const tr of Array.from(tb.querySelectorAll("tr"))) {
        const cells = Array.from(tr.querySelectorAll("th,td")).map(cell)
        if (cells.some(Boolean)) out.push(cells.join("\t"))
      }
      out.push("")
    }
    return out.join("\n")
  }).catch(() => "")
