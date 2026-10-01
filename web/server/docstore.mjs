// Optional bridge to the agent's document store (../.opencode/lib/doc-store.ts, Node 24 type
// stripping). Everything here degrades gracefully: when the module is missing or broken, uploads are
// still sent inline and forks still work – they just do not get an editable document / inherited docs.
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ROOT } from "./config.mjs"

const DOC_STORE = process.env.WEB_DOC_STORE || path.join(ROOT, ".opencode", "lib", "doc-store.ts")
let cached = { mtime: 0, mod: null }
let lastFail = { mtime: -1, at: 0 }
let warned = ""

const warnOnce = (msg) => {
  if (warned === msg) return
  warned = msg
  console.warn("[doc-store]", msg)
}

/** The doc-store module, re-imported when the file changes (so a new version needs no restart). */
async function load() {
  let st
  try {
    st = fs.statSync(DOC_STORE)
  } catch {
    warnOnce("module not found – upload import and fork inheritance are disabled")
    return null
  }
  if (cached.mod && cached.mtime === st.mtimeMs) return cached.mod
  // A broken version is retried only after it changes or after a minute.
  if (lastFail.mtime === st.mtimeMs && Date.now() - lastFail.at < 60_000) return null
  try {
    const mod = await import(pathToFileURL(DOC_STORE).href + `?v=${Math.round(st.mtimeMs)}`)
    cached = { mtime: st.mtimeMs, mod }
    warned = ""
    return mod
  } catch (e) {
    lastFail = { mtime: st.mtimeMs, at: Date.now() }
    warnOnce(`cannot load module: ${String(e.message).split("\n")[0].slice(0, 200)}`)
    return null
  }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms).unref())])

/** importDocument(...) → metadata, or null when unavailable / failed. */
export async function importDocument(args, timeoutMs = 30_000) {
  const mod = await load()
  if (typeof mod?.importDocument !== "function") return null
  try {
    const meta = await withTimeout(Promise.resolve(mod.importDocument(args)), timeoutMs)
    return meta && typeof meta === "object" && typeof meta.id === "string" ? meta : null
  } catch (e) {
    console.warn("[doc-store] importDocument failed:", String(e.message).slice(0, 200))
    return null
  }
}

/** inheritSession(from, to) – copies the parent session's documents to a fork. Never throws. */
export async function inheritSession(fromSessionID, toSessionID, timeoutMs = 15_000) {
  const mod = await load()
  if (typeof mod?.inheritSession !== "function") return false
  try {
    await withTimeout(Promise.resolve(mod.inheritSession(fromSessionID, toSessionID)), timeoutMs)
    return true
  } catch (e) {
    console.warn("[doc-store] inheritSession failed:", String(e.message).slice(0, 200))
    return false
  }
}
