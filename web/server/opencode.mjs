// opencode server: spawn (through ../run.sh so it stays sandboxed), a tiny HTTP client with basic auth,
// and one shared /event subscription fanned out to per-session listeners.
import { spawn, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { ROOT, DATA_DIR, config } from "./config.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findBash() {
  if (process.env.BASH_PATH) return process.env.BASH_PATH
  if (process.platform !== "win32") return "bash"
  // Prefer Git Bash; plain "bash" on Windows may resolve to WSL, which cannot run run.sh correctly.
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || "bash"
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

export class OpencodeClient {
  constructor(url, password) {
    this.url = url.replace(/\/$/, "")
    this.auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
    this.listeners = new Map() // sessionID -> Set<fn>
    this.globalListeners = new Set()
    this.connected = false
  }

  async request(method, p, body, { timeoutMs = 30000 } = {}) {
    const res = await fetch(this.url + p, {
      method,
      headers: { Authorization: this.auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    if (!res.ok) {
      const err = new Error(`opencode ${method} ${p} → ${res.status}`)
      err.status = res.status
      err.body = data
      throw err
    }
    return data
  }

  health() {
    return this.request("GET", "/global/health", undefined, { timeoutMs: 3000 })
  }

  subscribe(sessionID, fn) {
    let set = this.listeners.get(sessionID)
    if (!set) this.listeners.set(sessionID, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (!set.size) this.listeners.delete(sessionID)
    }
  }

  onAny(fn) {
    this.globalListeners.add(fn)
    return () => this.globalListeners.delete(fn)
  }

  /** Feed a synthesized event through the same fan-out as the /event stream (e.g. live draft progress). */
  inject(ev) {
    this.#dispatch(ev)
  }

  #dispatch(ev) {
    const p = ev.properties || {}
    const sid = p.sessionID || p.part?.sessionID || p.info?.sessionID
    for (const fn of this.globalListeners) {
      try {
        fn(ev, sid)
      } catch (e) {
        console.error("[opencode] listener error", e)
      }
    }
    if (!sid) return
    const set = this.listeners.get(sid)
    if (set) for (const fn of [...set]) {
      try {
        fn(ev)
      } catch (e) {
        console.error("[opencode] listener error", e)
      }
    }
  }

  /** Keeps one SSE connection to opencode's /event open forever (reconnects with backoff). */
  async runEventLoop() {
    let backoff = 500
    for (;;) {
      if (this.stopped) return
      try {
        const res = await fetch(this.url + "/event", { headers: { Authorization: this.auth, Accept: "text/event-stream" } })
        if (!res.ok || !res.body) throw new Error("event stream status " + res.status)
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ""
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true }).replace(/\r/g, "")
          let i
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = chunk
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).replace(/^ /, ""))
              .join("\n")
            if (!data) continue
            let ev
            try {
              ev = JSON.parse(data)
            } catch {
              continue
            }
            if (ev.type === "server.connected") {
              const wasConnected = this.connected
              this.connected = true
              backoff = 500
              if (this.everConnected) this.#dispatchAll({ type: "web.resync" })
              this.everConnected = true
              if (!wasConnected) console.log("[opencode] event stream connected")
            }
            this.#dispatch(ev)
          }
        }
        throw new Error("event stream ended")
      } catch (e) {
        if (this.connected) console.warn("[opencode] event stream lost:", e.message)
        this.connected = false
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 10000)
      }
    }
  }

  #dispatchAll(ev) {
    for (const set of this.listeners.values()) for (const fn of [...set]) fn(ev)
  }
}

/** Spawns `bash run.sh serve …` and keeps it alive. Returns { client, stop }. */
export async function startOpencode({ port, password } = {}) {
  port ||= await freePort()
  password ||= crypto.randomBytes(24).toString("base64url")
  const url = `http://127.0.0.1:${port}`
  const client = new OpencodeClient(url, password)
  const logPath = path.join(DATA_DIR, "opencode.log")
  const bash = findBash()
  let child = null
  let stopping = false

  const launch = () => {
    const log = fs.openSync(logPath, "a")
    fs.writeSync(log, `\n=== ${new Date().toISOString()} starting opencode serve on ${url} ===\n`)
    const env = { ...process.env, OPENCODE_SERVER_PASSWORD: password }
    delete env.OPENCODE_SERVER_USERNAME
    // run.sh enables the "question" tool (+ permission) only with this flag (docs/QUESTION_TOOL.md).
    if (config.questionTool) env.ND45_QUESTION_TOOL = "1"
    else delete env.ND45_QUESTION_TOOL
    // tools may ask the user to pass an official site's CAPTCHA in the live view (server/assist.mjs)
    if (config.assist) env.ND45_ASSIST = "1"
    else delete env.ND45_ASSIST
    child = spawn(bash, [path.join(ROOT, "run.sh"), "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", log, log],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    fs.closeSync(log)
    child.on("exit", (code, signal) => {
      console.warn(`[opencode] process exited (code ${code}, signal ${signal})`)
      child = null
      if (!stopping) setTimeout(() => !stopping && launch(), 2000)
    })
  }

  let serverPid = 0
  const killTree = () => {
    try {
      if (process.platform === "win32") {
        for (const pid of [child?.pid, serverPid]) if (pid) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      } else if (child?.pid) process.kill(-child.pid, "SIGTERM")
    } catch {}
    fs.rmSync(PID_FILE, { force: true })
  }

  const stop = () => {
    stopping = true
    client.stopped = true
    killTree()
  }

  killStale()
  launch()
  const t0 = Date.now()
  for (;;) {
    try {
      await client.health()
      break
    } catch {}
    if (Date.now() - t0 > 90_000) {
      stop()
      throw new Error(`opencode did not become healthy within 90 s – see ${logPath}`)
    }
    await sleep(500)
  }
  console.log(`[opencode] ready on ${url} after ${((Date.now() - t0) / 1000).toFixed(1)} s (log: ${logPath})`)
  // On Windows a hard-killed parent leaves opencode.exe running (no process groups). Remember its PID so
  // the next start can clean it up.
  if (process.platform === "win32") {
    serverPid = listeningPid(port)
    fs.writeFileSync(PID_FILE, JSON.stringify({ port, pids: [child?.pid, serverPid].filter(Boolean) }))
  }
  client.runEventLoop()
  return { client, stop }
}

const PID_FILE = path.join(DATA_DIR, "opencode.pid.json")

function listeningPid(port) {
  const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true })
  const line = (r.stdout || "").split(/\r?\n/).find((l) => new RegExp(`\\s127\\.0\\.0\\.1:${port}\\s.*LISTENING`).test(l))
  return line ? Number(line.trim().split(/\s+/).pop()) : 0
}

const commandLine = (pid) =>
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], {
    encoding: "utf8",
    windowsHide: true,
  }).stdout?.trim() || ""

/**
 * Kill the opencode serve left behind by a hard-killed previous run – only the exact recorded PIDs, and
 * only if the process is still OUR `serve --port <port>` (PIDs get reused; other opencode / run.sh
 * processes on this machine, e.g. agent tests, must never be touched).
 */
function killStale() {
  if (process.platform !== "win32" || !fs.existsSync(PID_FILE)) return
  try {
    const { pids, port } = JSON.parse(fs.readFileSync(PID_FILE, "utf8"))
    if (!port) return
    const mine = new RegExp(`\\bserve\\b.*--port\\s+${Number(port)}\\b`)
    for (const pid of pids || []) {
      const cmd = commandLine(pid)
      if (!cmd || !mine.test(cmd)) continue
      spawnSync("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore", windowsHide: true })
      console.log(`[opencode] killed stale process ${pid} (serve --port ${port}) from a previous run`)
    }
  } catch {
  } finally {
    fs.rmSync(PID_FILE, { force: true })
  }
}

export async function connectOpencode(url, password) {
  const client = new OpencodeClient(url, password)
  await client.health()
  client.runEventLoop()
  return { client, stop: () => (client.stopped = true) }
}
