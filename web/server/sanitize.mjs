// Defense-in-depth output filter for everything users see (answer text, reasoning, step labels / results /
// errors, follow-ups, document titles, share / export). Product decision: users never see the vendor, model,
// provider or runtime behind the assistant – only "the AI model deployed by FTU Tech Lab".
//  • Names come from a static list (vendors / runtimes) + the providers and models in ../opencode.json
//    (ids, display names, base-URL hosts), re-read every minute.
//  • "do FTU Tech Lab phát triển / huấn luyện / xây dựng" (and EN "developed / trained / built by FTU Tech Lab")
//    → "triển khai" / "deployed": the lab deploys the model, it did not build or train it.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = process.env.SANITIZE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export const GENERIC = { vi: "mô hình AI của FTU Tech Lab", en: "the FTU Tech Lab AI model" }

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
function readEnv() {
  const out = {}
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2").replace(/\s+#.*$/, "")
    }
  } catch {}
  return out
}
/** Names / ids / hosts from opencode.json (display names cut at " (" so "X (GPUStack – …)" → "X"). */
function configTerms() {
  const terms = new Set()
  try {
    const oc = JSON.parse(fs.readFileSync(path.join(ROOT, "opencode.json"), "utf8"))
    const env = { ...readEnv(), ...process.env }
    const add = (s) => {
      s = String(s || "").trim()
      if (s.length >= 4 && !/^(model|models|provider|recorded|replay|default|local)$/i.test(s)) terms.add(s)
    }
    for (const [pid, p] of Object.entries(oc.provider || {})) {
      add(pid)
      add(String(p?.name || "").split(" (")[0])
      const base = String(p?.options?.baseURL || "").replace(/\{env:(\w+)\}/g, (_, k) => env[k] || "")
      try {
        const host = new URL(base).hostname
        if (host && !/^(localhost|127\.)/.test(host)) add(host)
      } catch {}
      for (const [mid, m] of Object.entries(p?.models || {})) {
        add(`${pid}/${mid}`)
        add(mid)
        add(mid.split("/").pop())
        add(String(m?.name || "").split(" (")[0])
      }
    }
    add(oc.model)
  } catch {}
  return [...terms]
}
// Vendors / runtimes, with any trailing model-id characters ("qwen3.6-35b-a3b-fp8", "deepseek-ai/deepseek-v4.1-flash").
const STATIC = "(?:deepseek|qwen|nemotron|gpustack|nvidia|opencode)[\\w.\\-/]*(?:\\s+(?:serve|nim|api))?"
let cache = { at: 0, re: null }
function nameRe() {
  if (cache.re && Date.now() - cache.at < 60_000) return cache.re
  const dyn = configTerms().sort((a, b) => b.length - a.length).map(esc)
  cache = { at: Date.now(), re: new RegExp(`(?<![\\w\\-./])(?:${[...dyn, STATIC].join("|")})(?![\\w])`, "giu") }
  return cache.re
}
const BUILT_VI = /(do|bởi|của)\s+FTU Tech Lab\s+(tự\s+)?(phát triển|huấn luyện|xây dựng|tạo ra|làm ra|đào tạo)/giu
const BUILT_EN = /\b(developed|trained|built|created|made)\s+by\s+FTU Tech Lab/gi
// "Lab tự phát triển / huấn luyện mô hình" style claims.
const LAB_BUILT_VI = /(FTU Tech Lab|Lab)\s+(đã\s+)?(tự\s+)?(phát triển|huấn luyện|xây dựng|đào tạo)\s+(mô hình|model)/giu

/** Replace vendor / model / provider / runtime names with the generic term; fix "built by the lab" claims. */
export function scrubText(s, locale = "vi") {
  if (s == null) return s
  let t = String(s)
  if (!t) return t
  const g = GENERIC[locale === "en" ? "en" : "vi"]
  t = t.replace(nameRe(), g)
  // Collapse repeats produced by replacing adjacent names ("mô hình AI của FTU Tech Lab mô hình AI của FTU Tech Lab").
  t = t.replace(new RegExp(`(${esc(g)})(?:[\\s/·,()–-]+${esc(g)})+`, "giu"), "$1")
  t = t.replace(BUILT_VI, "$1 FTU Tech Lab triển khai").replace(BUILT_EN, "deployed by FTU Tech Lab").replace(LAB_BUILT_VI, "$1 triển khai $5")
  return unhotlinkImages(t)
}

/**
 * Model output never embeds an external image (no hotlinking, no tracking pixels): markdown images whose target is not
 * one of our own visuals (`visual:<id>`, served by server/visuals.mjs) become plain links; raw <img> tags lose their src.
 */
export function unhotlinkImages(s) {
  if (s == null || !/!\[|<img|\[\[diagram:/i.test(s)) return s
  return String(s)
    // a diagram marker the model made up (real ids come from diagram_create: v<14 digits>-<6 hex>) shows nothing
    .replace(/\[\[diagram:(?!v\d{14}-[0-9a-f]{6}\]\])[^\]\n]{0,120}\]\]/g, "")
    .replace(/!\[([^\]\n]{0,300})\]\(\s*<?((?!visual:)[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt, url) => `[${alt.trim() || url}](${url})`)
    .replace(/<img\b[^>]*>/gi, "")
}
/** True when the text still names a vendor / model / runtime (for tests). */
export const hasVendorName = (s) => {
  const re = nameRe()
  re.lastIndex = 0
  const hit = re.test(String(s || ""))
  re.lastIndex = 0
  return hit
}
