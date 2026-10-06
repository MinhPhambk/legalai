// Re-grade stored answers with the current grounding_check after the grader changed (05/10/2026: quote cleaning,
// "…" abbreviations, near-verbatim matching, quote pairing, callouts, id from opened links, ≥ 2 unsupported for THẤP).
// For every user turn that already has a verdict, the turn's final answer (after a repair, if any) is checked again
// against the session's evidence and the new verdict is APPENDED to the evidence file with the old verdict's time + 1 ms,
// so experts.mjs#groundingForTurns picks it for the same turn. Old verdicts are kept (nothing is deleted).
// Usage: node tools/regrade-chats.mjs [--all-users] [--dry]      (default: every user except eval@legalai.local)
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EVD = path.join(ROOT, ".sandbox/cache/legalai/evidence")
const DRY = process.argv.includes("--dry")
const ALL = process.argv.includes("--all-users")
// The running opencode server of the web app: port from its command line, password from its environment.
const ocPid = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).find((d) => { try { const a = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0"); return a.some((x) => x.startsWith(ROOT + "/") && x.endsWith("opencode.exe")) && a.includes("serve") } catch { return false } })
if (!ocPid) throw new Error("opencode server not running (start legalai-web)")
const ocArgs = fs.readFileSync(`/proc/${ocPid}/cmdline`, "utf8").split("\0")
const ocPw = fs.readFileSync(`/proc/${ocPid}/environ`, "utf8").split("\0").find((x) => x.startsWith("OPENCODE_SERVER_PASSWORD="))?.slice(25) ?? ""
const OC = `http://127.0.0.1:${ocArgs[ocArgs.indexOf("--port") + 1]}`
const AUTH = { Authorization: "Basic " + Buffer.from(`opencode:${ocPw}`).toString("base64") }

// grounding_check appends its own verdict to the evidence file: run it on a temporary copy.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "regrade-"))
fs.mkdirSync(path.join(TMP, "legalai/evidence"), { recursive: true })
process.env.XDG_CACHE_HOME = TMP
const { check } = await import(path.join(ROOT, ".opencode/tools/grounding.ts"))
const { parseEvidence } = await import(path.join(ROOT, ".opencode/lib/evidence.ts"))
const { reportItems, isHiddenPrompt, isRepairPrompt } = await import(path.join(ROOT, "web/server/grounding.mjs"))

const db = new DatabaseSync(path.join(ROOT, ".sandbox/web/app.db"), { readOnly: true })
const branches = db.prepare(`SELECT b.opencode_session_id sid, c.id chat, u.email FROM branches b JOIN chats c ON c.id = b.chat_id JOIN users u ON u.id = c.user_id ${ALL ? "" : "WHERE u.email <> 'eval@legalai.local'"}`).all()
const stats = { sessions: 0, turns: 0, changed: 0, from: {}, to: {} }
for (const { sid } of branches) {
  const file = path.join(EVD, `${sid.replace(/[^\w.-]/g, "_")}.jsonl`)
  if (!fs.existsSync(file)) continue
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
  const verdicts = lines.filter((l) => l.includes('"source":"grounding"')).map((l) => { try { const e = JSON.parse(l); return { at: e.at, v: JSON.parse(e.text) } } catch { return null } }).filter((x) => x?.v?.level)
  if (!verdicts.length) continue
  let items
  try { items = await (await fetch(`${OC}/session/${encodeURIComponent(sid)}/message`, { headers: AUTH })).json() } catch (e) { if (process.env.DEBUG) console.error(sid, e.message); continue }
  if (!Array.isArray(items)) continue
  stats.sessions++
  // user turns: [start, end) times and the final answer text
  const users = items.map((m, i) => ({ m, i })).filter(({ m }) => m.info?.role === "user" && !isHiddenPrompt(m))
  fs.writeFileSync(path.join(TMP, "legalai/evidence", path.basename(file)), lines.filter((l) => !l.includes('"source":"grounding"')).join("\n") + "\n")
  const add = []
  for (let k = 0; k < users.length; k++) {
    const start = users[k].m.info?.time?.created ?? 0
    const end = users[k + 1]?.m.info?.time?.created ?? Infinity
    const last = verdicts.filter((x) => x.at >= start && x.at < end).at(-1)
    if (!last || (last.v.regraded && Array.isArray(last.v.links) && !process.argv.includes("--force"))) continue
    const turn = items.slice(users[k].i + 1, users[k + 1]?.i ?? items.length)
    const ri = turn.map((m, i) => (isRepairPrompt(m) ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1
    const answer = turn.slice(ri + 1).filter((m) => m.info?.role === "assistant").flatMap((m) => (m.parts || []).filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text || "")).join("\n\n").trim()
    if (!answer) continue
    // only evidence recorded before the original verdict (what the answer could rest on at the time)
    // the same robust reader as grounding_check (broken / glued lines keep every record that can be recovered)
    const evAt = parseEvidence(lines.join("\n")).filter((e) => e.source !== "grounding" && (e.at ?? last.at) <= last.at)
    fs.writeFileSync(path.join(TMP, "legalai/evidence", path.basename(file)), evAt.map((e) => JSON.stringify(e)).join("\n") + "\n")
    const r = await check.execute({ answer }, { sessionID: sid })
    const text = typeof r === "string" ? r : r.output
    const gl = fs.readFileSync(path.join(TMP, "legalai/evidence", path.basename(file)), "utf8").split("\n").filter((l) => l.includes('"source":"grounding"')).at(-1)
    const nv = JSON.parse(JSON.parse(gl).text)
    const verdict = { ...nv, items: reportItems(text), origin: last.v.origin === "server" ? "server" : "model", regraded: true, previous: last.v.level }
    stats.turns++
    stats.from[last.v.level] = (stats.from[last.v.level] || 0) + 1
    stats.to[nv.level] = (stats.to[nv.level] || 0) + 1
    if (nv.level !== last.v.level) stats.changed++
    add.push(JSON.stringify({ url: "grounding://regrade", text: JSON.stringify(verdict), source: "grounding", at: last.at + 1 }))
  }
  if (add.length && !DRY) fs.appendFileSync(file, add.join("\n") + "\n")
}
fs.rmSync(TMP, { recursive: true, force: true })
console.log(JSON.stringify(stats))
