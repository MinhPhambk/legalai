// Admin → "Thư viện công cụ & kỹ năng": catalog of the tools the web agent can call (AI server HTTP API +
// the browser MCP), the skills in ../.opencode/skills, usage stats from stored session data, and per-tool /
// per-skill on/off switches kept in app_settings.
//
// Enforcement (chats.mjs, before every prompt_async):
//  • applyLibraryPermissions(oc, sid, extra) → session permission rules for disabled tools and skills (see below).
//  • disabledToolsMap()               → { name: false, … } of the disabled tools (informational / tests; do NOT send
//    it as prompt_async `tools` – that replaces the session rules).
//  • disabledSkillsNote(locale)       → line for the prompt_async `system` text naming the disabled skills.
// Locked items can never be switched off (defense in depth: the helpers ignore them too).
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { ROOT } from "./config.mjs"
import { getSetting, q, setSetting } from "./db.mjs"
import { activeModelId } from "./models.mjs"
import { resolveLocale } from "./i18n.mjs"

export const LOCKED_TOOLS = new Set(["grounding_check", "about_self", "safety_scan", "clock_now", "clock_calc"])
export const LOCKED_SKILLS = new Set(["safety", "citation-check"])

const SKILLS_DIR = process.env.LIBRARY_SKILLS_DIR || path.join(ROOT, ".opencode", "skills")
const AI_DB = process.env.LIBRARY_AI_DB || path.join(ROOT, ".sandbox", "data", "opencode", "opencode.db")
const MCP_BIN = process.env.LIBRARY_MCP_BIN || path.join(ROOT, "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js")
// Harness only: count tool calls of every stored session instead of the web chats' sessions.
const USAGE_ALL = process.env.LIBRARY_USAGE_ALL === "1"

// Built-in runtime tools the web agent is not given (file system / shell / sub-agents) or that are shown elsewhere
// (skill → Skills tab). Everything else from the tool list is shown.
const HIDDEN = new Set(["invalid", "bash", "read", "glob", "grep", "list", "edit", "write", "patch", "multiedit", "apply_patch", "task", "webfetch", "websearch", "codesearch", "todowrite", "todoread", "lsp", "skill", "batch", "plan_enter", "plan_exit"])

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function toolGroup(name) {
  if (name.startsWith("vbpl_")) return "vbpl"
  if (name.startsWith("court_")) return "court"
  if (/^(trav|fedreg|eurlex|eping)_/.test(name)) return "remedy"
  if (name.startsWith("fta_")) return "fta"
  if (/^(document|draft)_/.test(name)) return "docs"
  if (name.startsWith("tariff_")) return "tariff"
  if (/^(diagram|image)_/.test(name) || name === "source_snapshot") return "visuals"
  if (name.startsWith("company_")) return "company"
  if (/^(calc|fx)_/.test(name)) return "calc"
  if (name.startsWith("web_")) return "web"
  if (name === "grounding_check" || name === "expert_escalate") return "verify"
  if (name.startsWith("clock_") || name === "about_self" || name === "safety_scan") return "system"
  if (name.startsWith("chrome_")) return "browser"
  if (name === "question") return "question"
  return "other"
}
export const GROUP_ORDER = ["vbpl", "court", "remedy", "tariff", "fta", "company", "docs", "visuals", "calc", "web", "verify", "system", "browser", "question", "other"]

// Admin screen wording: no runtime names.
const neutral = (s, locale) =>
  String(s || "")
    .replace(/(?:[A-Za-z]:)?[\\/\w.-]*\.opencode[\\/]/g, "")
    .replace(/\bopencode\b/gi, locale === "en" ? "AI system" : "hệ thống AI")

const firstSentence = (s) => {
  const t = String(s || "").replace(/\s+/g, " ").trim()
  const m = t.match(/^(.{20,400}?[.!?])(?:\s|$)/)
  return (m ? m[1] : t.slice(0, 300)).trim()
}

/** Parameters of a JSON schema, flattened one level: [{ name, type, required, description, enum }]. */
function paramsOf(schema, locale) {
  const props = schema?.properties || {}
  const req = new Set(schema?.required || [])
  const typeOf = (p) => {
    if (!p) return ""
    if (p.enum) return "enum"
    if (p.type === "array") return `${typeOf(p.items) || "any"}[]`
    if (p.type) return Array.isArray(p.type) ? p.type.join(" | ") : p.type
    if (p.anyOf || p.oneOf) return (p.anyOf || p.oneOf).map(typeOf).filter(Boolean).join(" | ")
    return "any"
  }
  return Object.entries(props)
    .slice(0, 40)
    .map(([name, p]) => ({
      name: name.slice(0, 64),
      type: typeOf(p).slice(0, 60),
      required: req.has(name),
      description: neutral(String(p?.description || ""), locale).slice(0, 400),
      ...(Array.isArray(p?.enum) ? { enum: p.enum.slice(0, 20).map((x) => String(x).slice(0, 40)) } : {}),
    }))
}

// ---- settings ----------------------------------------------------------------------------------
const cleanList = (v, re) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && re.test(x)))] : [])
export const disabledTools = () => cleanList(getSetting("disabledTools", []), NAME_RE).filter((n) => !LOCKED_TOOLS.has(n))
export const disabledSkills = () => cleanList(getSetting("disabledSkills", []), SKILL_RE).filter((n) => !LOCKED_SKILLS.has(n))

/** For prompt_async: { toolName: false, … } of the tools the admin switched off (empty object when none). */
export function disabledToolsMap() {
  return Object.fromEntries(disabledTools().map((n) => [n, false]))
}

const libMeta = () => {
  const m = getSetting("libraryMeta", {})
  return { tools: m?.tools || {}, skills: m?.skills || {} }
}
function recordChange(kind, name, enabled, user) {
  const meta = libMeta()
  meta[kind][name] = { enabled, by: user?.email || user?.id || "", at: Date.now() }
  setSetting("libraryMeta", meta)
  const log = getSetting("libraryLog", [])
  setSetting("libraryLog", [{ kind, name, enabled, by: user?.email || "", at: Date.now() }, ...(Array.isArray(log) ? log : [])].slice(0, 100))
}
function setDisabled(key, name, enabled) {
  const re = key === "disabledTools" ? NAME_RE : SKILL_RE
  const set = new Set(cleanList(getSetting(key, []), re))
  if (enabled) set.delete(name)
  else set.add(name)
  setSetting(key, [...set].sort())
}

// ---- skills ------------------------------------------------------------------------------------
function parseFrontmatter(src) {
  const m = String(src).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: {}, body: String(src) }
  const data = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if (/^[>|][-+]?$/.test(v)) {
      const buf = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) buf.push(lines[++i].trim())
      v = buf.join(v.startsWith(">") ? " " : "\n")
    }
    data[kv[1]] = v.replace(/^(['"])([\s\S]*)\1$/, "$2")
  }
  return { data, body: String(src).slice(m[0].length) }
}

export function listSkills() {
  let dirs = []
  try {
    dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && SKILL_RE.test(d.name))
  } catch {
    return []
  }
  const out = []
  for (const d of dirs) {
    const file = path.join(SKILLS_DIR, d.name, "SKILL.md")
    let st
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    let fm = { data: {} }
    try {
      fm = parseFrontmatter(fs.readFileSync(file, "utf8").slice(0, 8192))
    } catch {}
    const name = SKILL_RE.test(fm.data.name || "") ? fm.data.name : d.name
    out.push({ name, dir: d.name, description: String(fm.data.description || ""), size: st.size, modified: st.mtimeMs, file })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function readSkill(name, locale) {
  const s = listSkills().find((x) => x.name === name)
  if (!s) return null
  const src = fs.readFileSync(s.file, "utf8").slice(0, 300_000)
  return { name: s.name, description: neutral(s.description, locale), content: neutral(parseFrontmatter(src).body, locale), size: s.size, modified: s.modified }
}

/** Optional line for the prompt `system` text: tells the model which skills are off (the permission rule enforces it). */
export function disabledSkillsNote(locale = "vi") {
  const off = disabledSkills()
  if (!off.length) return ""
  return locale === "en"
    ? `These skills are switched off by the administrator; do not load them: ${off.join(", ")}.`
    : `Các kỹ năng sau đang được quản trị viên tạm tắt, không nạp: ${off.join(", ")}.`
}

/**
 * Per-request enforcement, called right before every prompt_async (instead of sending a `tools` object:
 * on 1.18.32 prompt_async `tools` REPLACES the session's permission rules with {permission: tool, pattern: "*"}
 * rules – which would wipe the skill rules – and those rules stick for later prompts).
 * Makes the session's rules match the admin setting: disabled tool → { permission: <tool>, pattern: "*",
 * action: "deny" } (the tool disappears from the model's tool list); disabled skill → { permission: "skill",
 * pattern: <name>, action: "deny" } (loading it fails with a permission error). `extra` = more tool switches for
 * this request (e.g. { question: false }). PATCH /session/:id appends rules (the last matching rule wins), so only
 * the differences are sent, and "allow" is appended only to undo an earlier deny on this session (a tool the agent
 * itself denies is never switched on). Forks do not inherit session rules – calling this before each prompt
 * covers them. Never throws: a failure only logs and the prompt still goes out.
 */
export async function applyLibraryPermissions(oc, sessionID, extra = {}) {
  try {
    const offTools = new Set(disabledTools())
    for (const [k, v] of Object.entries(extra || {})) if (NAME_RE.test(k) && !LOCKED_TOOLS.has(k)) v === false ? offTools.add(k) : offTools.delete(k)
    const offSkills = new Set(disabledSkills())
    const sid = encodeURIComponent(sessionID)
    const s = await oc.request("GET", `/session/${sid}`, undefined, { timeoutMs: 5000 })
    const rules = Array.isArray(s?.permission) ? s.permission : []
    // Last session rule for (permission, pattern); undefined = the session has none (agent rules apply).
    const last = (perm, pattern) => {
      let a
      for (const r of rules) if (r?.permission === perm && r.pattern === pattern) a = r.action
      return a
    }
    const patch = []
    const want = (perm, pattern, off) => {
      const cur = last(perm, pattern)
      if (off && cur !== "deny") patch.push({ permission: perm, pattern, action: "deny" })
      else if (!off && cur === "deny") patch.push({ permission: perm, pattern, action: "allow" })
    }
    const toolNames = new Set([...offTools, ...rules.filter((r) => r?.pattern === "*" && NAME_RE.test(r.permission || "") && r.permission !== "skill").map((r) => r.permission)])
    for (const n of toolNames) want(n, "*", offTools.has(n))
    const skillNames = new Set([...offSkills, ...rules.filter((r) => r?.permission === "skill" && SKILL_RE.test(r.pattern || "")).map((r) => r.pattern)])
    for (const n of skillNames) want("skill", n, offSkills.has(n))
    if (patch.length) await oc.request("PATCH", `/session/${sid}`, { permission: patch }, { timeoutMs: 5000 })
    return { changed: patch.length }
  } catch (e) {
    console.warn("[library] permissions not applied:", e.message)
    return { changed: 0, error: true }
  }
}

// ---- usage stats (stored session data of the AI server, read-only) -----------------------------
let usageCache = { at: 0, value: null }
function readUsage() {
  if (usageCache.value && Date.now() - usageCache.at < 60_000) return usageCache.value
  const since = Date.now() - 30 * 86400_000
  const tools = new Map()
  const skills = new Map()
  let ok = false
  let adb
  try {
    adb = new DatabaseSync(AI_DB, { readOnly: true })
    adb.exec("PRAGMA busy_timeout = 2000")
    const ours = USAGE_ALL ? null : new Set(q("SELECT opencode_session_id AS s FROM branches").all().map((r) => r.s))
    const rows = adb
      .prepare(
        `SELECT session_id AS sid, json_extract(data, '$.tool') AS tool, json_extract(data, '$.state.status') AS st,
                json_extract(data, '$.state.time.start') AS t0, json_extract(data, '$.state.time.end') AS t1,
                CASE WHEN json_extract(data, '$.tool') = 'skill' THEN json_extract(data, '$.state.input.name') END AS skill,
                time_created AS at
         FROM part WHERE time_created >= ? AND json_extract(data, '$.type') = 'tool'`,
      )
      .all(since)
    for (const r of rows) {
      if (ours && !ours.has(r.sid)) continue
      if (r.st !== "completed" && r.st !== "error") continue
      const bucket = r.tool === "skill" ? (r.skill ? [skills, String(r.skill)] : null) : [tools, String(r.tool)]
      if (!bucket) continue
      const [map, key] = bucket
      let e = map.get(key)
      if (!e) map.set(key, (e = []))
      e.push({ at: Number(r.t0) || r.at, error: r.st === "error", ms: r.t1 && r.t0 ? Math.max(0, r.t1 - r.t0) : null })
    }
    ok = true
  } catch (e) {
    console.warn("[library] usage stats unavailable:", e.message)
  } finally {
    try {
      adb?.close()
    } catch {}
  }
  usageCache = { at: Date.now(), value: { ok, tools, skills } }
  return usageCache.value
}
function summarize(calls) {
  const now = Date.now()
  const win = (days) => {
    const c = (calls || []).filter((x) => x.at >= now - days * 86400_000)
    const ms = c.map((x) => x.ms).filter((x) => x != null).sort((a, b) => a - b)
    const errors = c.filter((x) => x.error).length
    return {
      calls: c.length,
      errors,
      errorRate: c.length ? errors / c.length : 0,
      medianMs: ms.length ? (ms.length % 2 ? ms[(ms.length - 1) >> 1] : Math.round((ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2)) : null,
      lastUsed: c.length ? Math.max(...c.map((x) => x.at)) : null,
    }
  }
  return { d7: win(7), d30: win(30) }
}

// ---- tool catalog ------------------------------------------------------------------------------
let catalogCache = { at: 0, key: "", value: null }
let mcpCache = { at: 0, value: null }

/** Browser MCP tool list via a short-lived stdio JSON-RPC session (tools/list never touches the browser). */
function listMcpTools() {
  if (mcpCache.value && Date.now() - mcpCache.at < 30 * 60_000) return Promise.resolve(mcpCache.value)
  return new Promise((resolve) => {
    if (!fs.existsSync(MCP_BIN)) return resolve([])
    let done = false
    let buf = ""
    const child = spawn(process.execPath, [MCP_BIN, "--browserUrl", `http://127.0.0.1:${process.env.CHROME_PORT || 9333}`, "--no-usage-statistics"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    })
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {}
      if (v.length) mcpCache = { at: Date.now(), value: v }
      resolve(v)
    }
    const timer = setTimeout(() => finish(mcpCache.value || []), 15_000)
    child.on("error", () => finish(mcpCache.value || []))
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n")
    child.stdout.on("data", (d) => {
      buf += d
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.id === 1) {
          send({ method: "notifications/initialized" })
          send({ id: 2, method: "tools/list" })
        } else if (m.id === 2) finish((m.result?.tools || []).map((t) => ({ id: `chrome_${t.name}`, description: t.description || "", parameters: t.inputSchema || {} })))
      }
    })
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legalai-web-library", version: "1" } } })
  })
}

async function toolCatalog(oc) {
  const model = activeModelId()
  if (catalogCache.value && catalogCache.key === model && Date.now() - catalogCache.at < 5 * 60_000) return catalogCache.value
  const slash = model.indexOf("/")
  const qs = new URLSearchParams(slash > 0 ? { provider: model.slice(0, slash), model: model.slice(slash + 1) } : {}).toString()
  const [ids, defs, mcp, mcpStatus] = await Promise.all([
    oc.request("GET", "/experimental/tool/ids", undefined, { timeoutMs: 8000 }),
    oc.request("GET", `/experimental/tool?${qs}`, undefined, { timeoutMs: 8000 }).catch(() => []),
    listMcpTools(),
    oc.request("GET", "/mcp", undefined, { timeoutMs: 4000 }).catch(() => ({})),
  ])
  const byId = new Map()
  for (const d of Array.isArray(defs) ? defs : []) if (d?.id && !byId.has(d.id)) byId.set(d.id, d)
  const names = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((n) => NAME_RE.test(n) && !HIDDEN.has(n))
  const list = names.map((n) => byId.get(n) || { id: n, description: "", parameters: {} })
  for (const m of mcp) if (!names.includes(m.id)) list.push(m)
  const value = { list, browser: mcpStatus?.chrome?.status || (mcp.length ? "unknown" : "missing") }
  catalogCache = { at: Date.now(), key: model, value }
  return value
}

// ---- routes ------------------------------------------------------------------------------------
export function registerLibraryRoutes(app, { oc, json }) {
  const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Bạn cần đăng nhập." })
    if (!req.user.isAdmin) return res.status(403).json({ error: "Chỉ quản trị viên mới truy cập được." })
    next()
  }
  const loc = (req) => (resolveLocale(req) === "en" ? "en" : "vi")

  app.get("/api/admin/library/tools", requireAdmin, async (req, res) => {
    let cat
    try {
      cat = await toolCatalog(oc)
    } catch (e) {
      console.warn("[library] tool list unavailable:", e.message)
      return res.status(503).json({ error: "Không kết nối được với trợ lý. Vui lòng thử lại sau ít phút.", code: "agent_down" })
    }
    const locale = loc(req)
    const off = new Set(disabledTools())
    const meta = libMeta().tools
    const usage = readUsage()
    const tools = cat.list
      .map((d) => ({
        name: d.id,
        group: toolGroup(d.id),
        summary: neutral(firstSentence(d.description), locale),
        description: neutral(String(d.description || ""), locale).slice(0, 4000),
        params: paramsOf(d.parameters, locale),
        locked: LOCKED_TOOLS.has(d.id),
        enabled: !off.has(d.id),
        changed: meta[d.id] || null,
        usage: summarize(usage.tools.get(d.id)),
      }))
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.name.localeCompare(b.name))
    res.json({ tools, groups: GROUP_ORDER, usageAvailable: usage.ok, browser: cat.browser, appliesTo: "next-message" })
  })

  app.put("/api/admin/library/tools/:name", requireAdmin, json, async (req, res) => {
    const name = String(req.params.name)
    const enabled = req.body?.enabled
    if (!NAME_RE.test(name) || typeof enabled !== "boolean") return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
    if (LOCKED_TOOLS.has(name)) return res.status(400).json({ error: "Dữ liệu không hợp lệ.", code: "locked" })
    let cat
    try {
      cat = await toolCatalog(oc)
    } catch {
      return res.status(503).json({ error: "Không kết nối được với trợ lý. Vui lòng thử lại sau ít phút.", code: "agent_down" })
    }
    if (!cat.list.some((d) => d.id === name) && !disabledTools().includes(name)) return res.status(404).json({ error: "Không tìm thấy." })
    setDisabled("disabledTools", name, enabled)
    recordChange("tools", name, enabled, req.user)
    console.log(`[admin] tool ${name} → ${enabled ? "on" : "off"} (by user ${req.user.id})`)
    res.json({ name, enabled, changed: libMeta().tools[name], disabledTools: disabledTools() })
  })

  app.get("/api/admin/library/skills", requireAdmin, (req, res) => {
    const locale = loc(req)
    const off = new Set(disabledSkills())
    const meta = libMeta().skills
    const usage = readUsage()
    const skills = listSkills().map((s) => ({
      name: s.name,
      description: neutral(s.description, locale).slice(0, 1200),
      size: s.size,
      modified: s.modified,
      locked: LOCKED_SKILLS.has(s.name),
      enabled: !off.has(s.name),
      changed: meta[s.name] || null,
      usage: summarize(usage.skills.get(s.name)),
    }))
    res.json({ skills, usageAvailable: usage.ok, appliesTo: "next-message" })
  })

  app.get("/api/admin/library/skills/:name", requireAdmin, (req, res) => {
    const name = String(req.params.name)
    if (!SKILL_RE.test(name)) return res.status(404).json({ error: "Không tìm thấy." })
    let s
    try {
      s = readSkill(name, loc(req))
    } catch {}
    if (!s) return res.status(404).json({ error: "Không tìm thấy." })
    res.json(s)
  })

  app.put("/api/admin/library/skills/:name", requireAdmin, json, (req, res) => {
    const name = String(req.params.name)
    const enabled = req.body?.enabled
    if (!SKILL_RE.test(name) || typeof enabled !== "boolean") return res.status(400).json({ error: "Dữ liệu không hợp lệ." })
    if (LOCKED_SKILLS.has(name)) return res.status(400).json({ error: "Dữ liệu không hợp lệ.", code: "locked" })
    if (!listSkills().some((s) => s.name === name) && !disabledSkills().includes(name)) return res.status(404).json({ error: "Không tìm thấy." })
    setDisabled("disabledSkills", name, enabled)
    recordChange("skills", name, enabled, req.user)
    console.log(`[admin] skill ${name} → ${enabled ? "on" : "off"} (by user ${req.user.id})`)
    res.json({ name, enabled, changed: libMeta().skills[name], disabledSkills: disabledSkills() })
  })

  app.get("/api/admin/library/log", requireAdmin, (req, res) => {
    const log = getSetting("libraryLog", [])
    res.json({ log: Array.isArray(log) ? log.slice(0, 100) : [] })
  })
}
