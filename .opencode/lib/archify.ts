// Deterministic diagram compiler for diagram_create: Archify (vendored, pinned – ../vendor/archify, MIT, see
// web/THIRD_PARTY_NOTICES.md) turns a typed JSON IR (architecture | workflow | sequence | dataflow | lifecycle) into
// validated SVG. How it runs (the vendored code is never imported into the AI runtime process):
//   1. normalizeIr   – parse + clamp the model's IR: fixed schema_version / diagram_type / title, strip everything
//                      that could reach outside the compiler (brand URLs, repository evidence, output paths) or only
//                      matters in the interactive viewer (animation, guided views); legend hidden by default
//                      (its built-in labels are English engineering terms).
//   2. renderOnce    – `node --import archify-netblock.mjs renderers/<type>/render-<type>.mjs in.json out.html` in a
//                      throw-away folder under .sandbox/tmp, with an EMPTY environment (PATH/SystemRoot only – no API
//                      keys), a 30 s timeout and capped output; network / child-process APIs are disabled by the preload.
//                      Then scripts/check-render-output.mjs (the artifact checks of `archify validate`).
//   3. autofix       – structured diagnostics with a mechanical fix (unknown property, out-of-range column, label
//                      wider than its node, mainPath without an edge, unknown node type…) are fixed and re-rendered
//                      (≤ 5 rounds); every fix is reported back to the model. Other diagnostics → error for the model.
//   4. extractSvg    – the rendered HTML is loaded (scripts and <link>s removed, all requests blocked) in the sandbox
//                      Chrome to build a standalone dual-theme SVG (same logic as the viewer's "Download SVG"):
//                      svg[data-theme="light"|"dark"] variable blocks, no scripts, no external references.
// Imported by tool files only – this file exports no tools.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { withOfflinePage } from "./image-proc.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export const VENDOR = path.join(ROOT, ".opencode", "vendor", "archify")
const NETBLOCK = path.join(ROOT, ".opencode", "lib", "archify-netblock.mjs")
const TMP = path.join(ROOT, ".sandbox", "tmp")
export const ARCHIFY_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(VENDOR, "package.json"), "utf8")).version as string } catch { return "?" } })()

export const DIAGRAM_TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const
export type DiagramType = (typeof DIAGRAM_TYPES)[number]
const NODES: Record<DiagramType, string> = { architecture: "components", workflow: "nodes", sequence: "participants", dataflow: "nodes", lifecycle: "states" }
const EDGES: Record<DiagramType, string> = { architecture: "connections", workflow: "edges", sequence: "messages", dataflow: "flows", lifecycle: "transitions" }
const COMPONENT_TYPES = ["frontend", "backend", "database", "cloud", "security", "messagebus", "external"]
const STATE_TYPES = ["start", "active", "waiting", "decision", "success", "failure", "neutral", "external"]
// words models use for node kinds → Archify semantic types (colours only)
const TYPE_SYNONYMS: Record<string, string> = {
  process: "backend", step: "backend", task: "backend", action: "backend", agency: "backend", authority: "backend", court: "backend", organ: "backend",
  decision: "security", gate: "security", check: "security", review: "security", condition: "security", approval: "security",
  start: "external", end: "database", actor: "external", party: "external", person: "external", user: "frontend", company: "frontend", enterprise: "frontend",
  document: "database", record: "database", result: "database", output: "database", data: "database", storage: "database", archive: "database",
  notice: "messagebus", event: "messagebus", message: "messagebus", publication: "messagebus", international: "cloud", organization: "cloud",
  bank: "backend", payment: "messagebus",
}
const STATE_SYNONYMS: Record<string, string> = { initial: "start", begin: "start", end: "success", final: "success", done: "success", error: "failure", fail: "failure", wait: "waiting", pending: "waiting", process: "active", step: "active", choice: "decision", gate: "decision" }

export class IrError extends Error {}
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)
const MAX_IR_BYTES = 80_000

/** Parse and normalise the model's IR; `notes` lists what was changed. */
export function normalizeIr(type: DiagramType, raw: unknown, opts: { title?: string; lang?: "vi" | "en"; quality?: "standard" | "showcase" } = {}): { ir: Record<string, any>; notes: string[] } {
  let ir: any = raw
  if (typeof raw === "string") {
    if (raw.length > MAX_IR_BYTES) throw new IrError(`IR quá lớn (${raw.length} ký tự, tối đa ${MAX_IR_BYTES}) – rút gọn sơ đồ (≤ 12 nút chính)`)
    try { ir = JSON.parse(raw) } catch (e: any) { throw new IrError(`ir không phải JSON hợp lệ: ${String(e?.message ?? e).slice(0, 160)}`) }
  }
  if (!isObj(ir)) throw new IrError("ir phải là một đối tượng JSON theo Archify IR (có meta, và các mảng nút / quan hệ của loại sơ đồ)")
  ir = JSON.parse(JSON.stringify(ir))
  if (JSON.stringify(ir).length > MAX_IR_BYTES) throw new IrError(`IR quá lớn (tối đa ${MAX_IR_BYTES} ký tự) – rút gọn sơ đồ`)
  const notes: string[] = []
  if (ir.diagram_type && ir.diagram_type !== type) notes.push(`diagram_type "${ir.diagram_type}" → "${type}" (theo tham số type)`)
  ir.diagram_type = type
  const sv = type === "workflow" ? (ir.schema_version === 1 ? 1 : 2) : 1
  if (ir.schema_version !== sv) { if (ir.schema_version != null) notes.push(`schema_version ${ir.schema_version} → ${sv}`); ir.schema_version = sv }
  const meta: Record<string, any> = isObj(ir.meta) ? ir.meta : {}
  if (opts.title?.trim()) meta.title = opts.title.trim().slice(0, 120)
  if (!String(meta.title ?? "").trim()) meta.title = "Sơ đồ"
  for (const k of ["output", "animation", "views", "visual_preset", "repository", "engineering_profile", "subtitle"]) if (k in meta) { delete meta[k]; notes.push(`bỏ meta.${k} (không dùng khi hiển thị trong câu trả lời)`) }
  if (opts.lang === "en") meta.locale = "en"
  else delete meta.locale // renderer UI strings stay English either way; authored labels are never translated
  meta.quality_profile = opts.quality ?? (meta.quality_profile === "showcase" ? "showcase" : "standard")
  if (!isObj(meta.legend)) meta.legend = { mode: "hidden" }
  ir.meta = meta
  semanticNormalize(type, ir, notes, opts.lang === "en" ? "en" : "vi")
  for (const coll of [NODES[type], "components", "participants", "states", "nodes"]) {
    if (!Array.isArray(ir[coll])) continue
    for (const n of ir[coll]) if (isObj(n)) { if ("brand" in n) { delete n.brand; notes.push(`bỏ brand của "${n.id}"`) } if ("sources" in n) delete n.sources }
  }
  // Sequence: message rows are absolute y coordinates – models forget them or space them unevenly. Missing / not
  // strictly increasing → evenly spaced rows (segments dropped, they refer to the old y), viewBox sized to fit.
  if (type === "sequence" && Array.isArray(ir.messages)) {
    if (meta.column_fit == null) meta.column_fit = "spread"
    const ys = ir.messages.map((m: any) => (isObj(m) && typeof m.y === "number" ? m.y : NaN))
    const ok = ys.every((y: number, i: number) => Number.isFinite(y) && (i === 0 || y - ys[i - 1] >= 30))
    if (!ok) {
      ir.messages.forEach((m: any, i: number) => { if (isObj(m)) m.y = 180 + i * 48 })
      if (Array.isArray(ir.segments)) { delete ir.segments; notes.push("bỏ segments (toạ độ y cũ)") }
      notes.push("xếp lại toạ độ y của các thông điệp (cách đều 48px)")
      const parts = Array.isArray(ir.participants) ? ir.participants.length : 4
      meta.viewBox = [Math.max(720, parts * 170), 180 + ir.messages.length * 48 + 60]
    } else if (!Array.isArray(meta.viewBox)) {
      const parts = Array.isArray(ir.participants) ? ir.participants.length : 4
      meta.viewBox = [Math.max(720, parts * 170), Math.max(...ys) + 100]
    }
  }
  // Nodes without an explicit width: size them for their (often long, diacritic-rich Vietnamese) labels up front –
  // the renderer's own fit check ignores the type icon, so a "just fitting" label collides with it.
  if (type === "workflow") {
    for (const n of Array.isArray(ir[NODES[type]]) ? ir[NODES[type]] : []) {
      if (!isObj(n) || n.width != null) continue
      const len = Math.max([...String(n.label ?? "")].length, Math.ceil([...String(n.sublabel ?? "")].length * 0.8), Math.ceil([...String(n.tag ?? "")].length * 0.75))
      const w = Math.ceil((len * 7.8 + 52) / 4) * 4
      if (w > 92) n.width = Math.min(240, w)
    }
  }
  return { ir, notes }
}

// ---------------------------------------------------------------- the model's "natural" shape → Archify fields
// Models tend to write a generic graph ({nodes:[{id,label,subtitle,actor}], edges:[{source,target}]}, lanes with
// "title", labels with "\n") instead of the typed IR. Map the common synonyms, split multi-line labels, derive lanes
// from actor / party names and, for workflows without columns, lay the nodes out by their order in the edge graph.
const pick = (o: any, keys: string[]) => { for (const k of keys) if (o[k] != null && o[k] !== "") { const v = o[k]; for (const kk of keys) delete o[kk]; return v } return undefined }
const slugId = (s: string, fallback: string) => {
  const v = String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)
  return /^[a-z]/.test(v) ? v : v ? `n_${v}` : fallback
}
const oneLine = (s: unknown) => String(s ?? "").replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim()
function splitLabel(n: any) {
  const raw = String(n.label ?? "")
  if (/\n/.test(raw)) {
    const [first, ...rest] = raw.split(/\s*\n+\s*/)
    n.label = first.trim()
    if (!n.sublabel && rest.join(" ").trim()) n.sublabel = rest.join(" ").trim()
  } else n.label = oneLine(raw)
  if (n.sublabel != null) n.sublabel = oneLine(n.sublabel)
  for (const k of ["sublabel", "tag"]) if (typeof n[k] === "string" && [...n[k]].length > 44) n[k] = [...n[k]].slice(0, 42).join("").trim() + "…"
  if ([...String(n.label)].length > 40) n.label = [...String(n.label)].slice(0, 38).join("").trim() + "…"
}

export function semanticNormalize(type: DiagramType, ir: Record<string, any>, notes: string[], lang: "vi" | "en" = "vi") {
  const coll = NODES[type], rel = EDGES[type]
  // collections under other names
  if (!Array.isArray(ir[coll])) for (const k of ["nodes", "steps", "states", "participants", "components", "actors", "parties", "items"]) if (Array.isArray(ir[k]) && k !== coll) { ir[coll] = ir[k]; delete ir[k]; notes.push(`dùng "${k}" làm ${coll}`); break }
  if (!Array.isArray(ir[rel])) for (const k of ["edges", "links", "connections", "flows", "transitions", "messages", "arrows", "relations"]) if (Array.isArray(ir[k]) && k !== rel) { ir[rel] = ir[k]; delete ir[k]; notes.push(`dùng "${k}" làm ${rel}`); break }
  const nodes: any[] = (Array.isArray(ir[coll]) ? ir[coll] : []).filter(isObj)
  const edges: any[] = (Array.isArray(ir[rel]) ? ir[rel] : []).filter(isObj)
  ir[coll] = nodes; ir[rel] = edges
  let renamed = 0
  nodes.forEach((n, i) => {
    const label = pick(n, ["label", "name", "title", "text"])
    if (label != null) n.label = label
    const sub = pick(n, ["sublabel", "subtitle", "description", "detail", "details", "note", "desc", "deadline", "duration", "time"])
    if (sub != null) n.sublabel = typeof sub === "string" ? sub : String(sub)
    if (n.id == null || !/^[A-Za-z][\w-]{0,63}$/.test(String(n.id))) { const old = n.id; n.id = slugId(old ?? n.label, `n${i + 1}`); if (old != null) { for (const e of edges) { if (e.from === old || e.source === old) e.from = n.id; if (e.to === old || e.target === old) e.to = n.id } } renamed++ }
    splitLabel(n)
  })
  if (renamed) notes.push(`chuẩn hoá ${renamed} id nút`)
  for (const e of edges) {
    const f = pick(e, ["from", "source", "src", "start"]), t = pick(e, ["to", "target", "dst", "end"])
    if (f != null) e.from = f
    if (t != null) e.to = t
    const l = pick(e, ["label", "text", "name", "title", "condition"])
    if (l != null) e.label = oneLine(l)
  }
  // edges pointing to unknown nodes are dropped (the compiler would reject the whole diagram)
  const ids = new Set(nodes.map((n) => n.id))
  const before = edges.length
  ir[rel] = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
  if (ir[rel].length < before) notes.push(`bỏ ${before - ir[rel].length} quan hệ trỏ tới nút không có`)
  if (type === "sequence") {
    for (const m of ir[rel]) if (m.label == null || m.label === "") m.label = "…"
    return
  }
  if (type !== "workflow") return
  // ---- workflow lanes: from lanes[] (label / title / name) and node lane / actor / party / owner references
  const lanes: any[] = (Array.isArray(ir.lanes) ? ir.lanes : []).filter(isObj)
  for (const [i, l] of lanes.entries()) {
    const label = pick(l, ["label", "title", "name"])
    l.label = oneLine(label ?? l.id ?? `${lang === "en" ? "Lane" : "Làn"} ${i + 1}`)
    for (const k of Object.keys(l)) if (!["id", "label", "variant"].includes(k)) delete l[k]
    if (l.id == null || !/^[A-Za-z][\w-]{0,63}$/.test(String(l.id))) l.id = slugId(l.label, `lane${i + 1}`)
  }
  const laneOf = (ref: unknown) => {
    const r = oneLine(ref)
    if (!r) return null
    const hit = lanes.find((l) => l.id === r || l.label === r || slugId(l.label, "") === slugId(r, "-"))
    if (hit) return hit.id
    const l = { id: slugId(r, `lane${lanes.length + 1}`), label: r }
    while (lanes.some((x) => x.id === l.id)) l.id += "_"
    lanes.push(l)
    return l.id
  }
  for (const n of nodes) {
    const ref = pick(n, ["lane", "actor", "party", "owner", "agency", "role", "swimlane", "group", "who"])
    const id = laneOf(ref)
    if (id) n.lane = id
  }
  // ---- columns: keep valid ones; otherwise rank by the edge graph (longest path from the sources)
  const needCols = nodes.some((n) => !Number.isInteger(n.col) || n.col < 0 || n.col > 5)
  if (needCols && nodes.length) {
    const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
    for (const e of ir[rel]) out.get(e.from)?.push(e.to)
    const rank = new Map<string, number>()
    const order = nodes.map((n) => n.id)
    // DFS order to ignore back edges (loops such as "khắc phục → thực hiện")
    const state = new Map<string, number>()
    const topo: string[] = []
    const visit = (v: string) => { state.set(v, 1); for (const w of out.get(v) ?? []) if (!state.get(w)) visit(w); state.set(v, 2); topo.push(v) }
    for (const v of order) if (!state.get(v)) visit(v)
    topo.reverse()
    const pos = new Map(topo.map((v, i) => [v, i]))
    for (const v of topo) rank.set(v, rank.get(v) ?? 0)
    for (const v of topo) for (const w of out.get(v) ?? []) if ((pos.get(w) ?? 0) > (pos.get(v) ?? 0)) rank.set(w, Math.max(rank.get(w) ?? 0, (rank.get(v) ?? 0) + 1))
    const max = Math.max(0, ...rank.values())
    for (const n of nodes) n.col = max <= 5 ? rank.get(n.id) ?? 0 : Math.round(((rank.get(n.id) ?? 0) * 5) / max)
    notes.push(`xếp cột tự động theo thứ tự các bước (${max + 1} bậc → cột 0..${Math.min(5, max)})`)
  }
  if (!lanes.length || nodes.some((n) => !n.lane || !lanes.some((l) => l.id === n.lane))) {
    const main = lanes[0] ?? (lanes.push({ id: "main", label: lang === "en" ? "Steps" : "Các bước" }), lanes[0])
    for (const n of nodes) if (!n.lane || !lanes.some((l) => l.id === n.lane)) n.lane = main.id
  }
  spreadCollisions(nodes, lanes, lang)
  ir.lanes = lanes.filter((l) => nodes.some((n) => n.lane === l.id))
  for (const n of nodes) if (typeof n.type === "string" && !COMPONENT_TYPES.includes(n.type)) n.type = TYPE_SYNONYMS[n.type.toLowerCase()] ?? "backend"
  for (const n of nodes) if (n.type == null) n.type = "backend"
}

/** Two workflow nodes in the same lane + column: move one to the nearest free column, else to a continuation lane. */
function spreadCollisions(nodes: any[], lanes: any[], lang: "vi" | "en") {
  const taken = new Set<string>()
  for (const n of nodes) {
    let key = `${n.lane}|${n.col}`
    if (!taken.has(key)) { taken.add(key); continue }
    const free = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5].map((d) => n.col + d).find((c) => c >= 0 && c <= 5 && !taken.has(`${n.lane}|${c}`))
    if (free != null) n.col = free
    else {
      const base = lanes.find((l) => l.id === n.lane)
      let cont = lanes.find((l) => l.id === `${n.lane}_2`)
      if (!cont) { cont = { id: `${n.lane}_2`, label: `${base?.label ?? n.lane} (${lang === "en" ? "cont." : "tiếp"})` }; lanes.splice(lanes.indexOf(base) + 1, 0, cont) }
      n.lane = cont.id
      if (taken.has(`${n.lane}|${n.col}`)) { const c = [0, 1, 2, 3, 4, 5].find((x) => !taken.has(`${n.lane}|${x}`)); if (c != null) n.col = c }
    }
    key = `${n.lane}|${n.col}`
    taken.add(key)
  }
}

// ---------------------------------------------------------------- child process (pinned vendor code)
type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean }
function runNode(script: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ARCHIFY_DIAGNOSTIC_FORMAT: "json", ...extraEnv }
    const child = spawn(process.env.ND45_NODE ?? "node", ["--disable-warning=ExperimentalWarning", `--import=${pathToFileURL(NETBLOCK).href}`, script, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = "", err = "", timedOut = false
    const cap = 4_000_000
    child.stdout.on("data", (d) => { if (out.length < cap) out += d })
    child.stderr.on("data", (d) => { if (err.length < cap) err += d })
    const t = setTimeout(() => { timedOut = true; child.kill() }, 30_000)
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, stdout: out, stderr: String(e?.message ?? e), timedOut }) })
    child.on("close", (code) => { clearTimeout(t); resolve({ code, stdout: out, stderr: err, timedOut }) })
  })
}

export type Diagnostic = { code: string; message: string; subject?: any; evidence?: any; supportedFixes?: string[] }
type RenderResult = { ok: true; html: string; checks: { passed: number; total: number; warnings: number; profile: string } } | { ok: false; stage: "render" | "check"; diagnostics: Diagnostic[] }

async function renderOnce(type: DiagramType, ir: Record<string, any>): Promise<RenderResult> {
  fs.mkdirSync(TMP, { recursive: true })
  const work = fs.mkdtempSync(path.join(TMP, "archify-"))
  try {
    fs.writeFileSync(path.join(work, "in.json"), JSON.stringify(ir, null, 1))
    const r = await runNode(path.join(VENDOR, "renderers", type, `render-${type}.mjs`), ["in.json", "out.html"], work, { ARCHIFY_QUALITY_PROFILE: ir.meta.quality_profile })
    if (r.timedOut) return { ok: false, stage: "render", diagnostics: [{ code: "internal/timeout", message: "Trình biên dịch sơ đồ quá 30 giây – rút gọn sơ đồ" }] }
    if (r.code !== 0) {
      try {
        const p = JSON.parse(r.stderr.trim())
        if (Array.isArray(p?.diagnostics) && p.diagnostics.length) return { ok: false, stage: "render", diagnostics: p.diagnostics }
      } catch {}
      return { ok: false, stage: "render", diagnostics: [{ code: "internal/unclassified", message: "Trình biên dịch sơ đồ lỗi mà không có chẩn đoán cụ thể" }] }
    }
    const out = path.join(work, "out.html")
    const c = await runNode(path.join(VENDOR, "scripts", "check-render-output.mjs"), [out], work)
    let receipt: any = null
    try { receipt = JSON.parse(c.stdout) } catch {}
    if (!receipt) return { ok: false, stage: "check", diagnostics: [{ code: "artifact/check-failed", message: "Không kiểm tra được sơ đồ đã dựng" }] }
    const errors = (receipt.composition?.issues ?? []).filter((i: any) => i.severity === "error")
    const failed = (receipt.checks ?? []).filter((x: any) => !x.ok)
    if (!receipt.ok || errors.length || failed.length) {
      return {
        ok: false, stage: "check",
        diagnostics: [
          ...errors.map((i: any) => ({ code: i.code, message: `${i.code}${i.relationship ? ` (${i.relationship.from} → ${i.relationship.to})` : ""}`, subject: i.relationship ? { relationship: i.relationship } : {} })),
          ...failed.map((x: any) => ({ code: `artifact/${x.name}`, message: (x.details ?? []).find(Boolean) ?? x.name })),
        ],
      }
    }
    return { ok: true, html: fs.readFileSync(out, "utf8"), checks: { passed: receipt.checks.length, total: receipt.checks.length, warnings: receipt.composition?.summary?.warnings ?? 0, profile: receipt.composition?.profile ?? ir.meta.quality_profile } }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- mechanical repairs of structured diagnostics
const ptr = (root: any, p: string): { parent: any; key: string } | null => {
  const parts = String(p || "").split("/").filter(Boolean).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
  if (!parts.length) return null
  let cur = root
  for (const k of parts.slice(0, -1)) { cur = cur?.[k]; if (cur == null) return null }
  return { parent: cur, key: parts[parts.length - 1] }
}
const REQUIRED_DEFAULTS: Record<string, (ir: any, node: any, idx: number, type: DiagramType) => unknown> = {
  label: (_ir, n) => (typeof n?.id === "string" ? n.id : "?"),
  type: (_ir, _n, _i, type) => (type === "lifecycle" ? "active" : "backend"),
  lane: (ir) => ir.lanes?.[0]?.id,
  col: (_ir, _n, i) => Math.min(5, i),
}

export function autofix(type: DiagramType, ir: Record<string, any>, diags: Diagnostic[]): string[] {
  const fixes: string[] = []
  const nodes: any[] = Array.isArray(ir[NODES[type]]) ? ir[NODES[type]] : []
  for (const d of diags) {
    const path_ = d.subject?.path as string | undefined
    const ev = d.evidence ?? {}
    if (d.code === "schema/additionalProperties" && path_ != null && ev.additionalProperty) {
      const at = ptr(ir, path_)
      const t = path_ === "" || path_ === "/" ? ir : at ? at.parent?.[at.key] : null
      if (isObj(t) && ev.additionalProperty in t) { delete t[ev.additionalProperty]; fixes.push(`bỏ thuộc tính không hỗ trợ "${ev.additionalProperty}" ở ${path_}`) }
      continue
    }
    if ((d.code === "schema/maximum" || d.code === "schema/minimum") && path_ && typeof ev.limit === "number") {
      const at = ptr(ir, path_)
      if (at && typeof at.parent?.[at.key] === "number") { at.parent[at.key] = ev.limit; fixes.push(`${path_} → ${ev.limit} (giới hạn ${ev.comparison} ${ev.limit})`) }
      continue
    }
    if (d.code === "schema/enum" && path_ && Array.isArray(ev.allowedValues)) {
      const at = ptr(ir, path_)
      if (!at || !isObj(at.parent)) continue
      const cur = String(at.parent[at.key] ?? "").toLowerCase()
      if (at.key === "type") {
        const allowed = ev.allowedValues as string[]
        const syn = allowed.includes("active") ? STATE_SYNONYMS[cur] : TYPE_SYNONYMS[cur]
        const v = syn && allowed.includes(syn) ? syn : allowed.includes(cur) ? cur : allowed.includes("backend") ? "backend" : allowed.includes("active") ? "active" : allowed[0]
        at.parent[at.key] = v
        fixes.push(`${path_}: "${cur}" → "${v}"`)
      } else {
        delete at.parent[at.key]
        fixes.push(`bỏ ${path_} = "${cur}" (không hợp lệ)`)
      }
      continue
    }
    if (d.code === "schema/type" && path_) {
      const at = ptr(ir, path_)
      if (at && isObj(at.parent) && typeof at.parent[at.key] === "string" && /^-?\d+(\.\d+)?$/.test(at.parent[at.key].trim())) { at.parent[at.key] = Number(at.parent[at.key]); fixes.push(`${path_} → số`) }
      else if (at && isObj(at.parent) && typeof at.parent[at.key] === "number") { at.parent[at.key] = String(at.parent[at.key]); fixes.push(`${path_} → chuỗi`) }
      continue
    }
    if (d.code === "schema/required" && path_ && ev.missingProperty && REQUIRED_DEFAULTS[ev.missingProperty]) {
      const at = ptr(ir, path_)
      const obj = at ? at.parent?.[at.key] : null
      if (isObj(obj)) {
        const v = REQUIRED_DEFAULTS[ev.missingProperty](ir, obj, Number(at!.key) || 0, type)
        if (v !== undefined) { obj[ev.missingProperty] = v; fixes.push(`thêm ${path_}/${ev.missingProperty} = ${JSON.stringify(v)}`) }
      }
      continue
    }
    const msg = String(d.message ?? "")
    let m = msg.match(/Label "(.+?)" \(~(\d+)px\) is wider than (?:node|state|participant|component) "([^"]+)" \((\d+)px\)/)
    if (m) {
      const n = nodes.find((x) => x?.id === m![3])
      if (n) { const w = Math.min(260, Math.ceil((+m[2] + 48) / 4) * 4); if (!(n.width >= w)) { n.width = w; fixes.push(`nới rộng nút "${m[3]}" → ${w}px cho vừa nhãn`) } }
      continue
    }
    // geometry that only needs more room (lifecycle / dataflow place columns across the viewBox width)
    const vb = (): number[] => {
      const d = type === "lifecycle" ? [980, 660] : type === "dataflow" ? [940, 720] : type === "sequence" ? [820, 760] : [960, 640]
      if (!Array.isArray(ir.meta.viewBox) || ir.meta.viewBox.length !== 2) ir.meta.viewBox = d
      return ir.meta.viewBox
    }
    if ((m = msg.match(/set meta\.viewBox\[([01])\] to at least (\d+)/))) { const v = vb(); const k = +m[1]; if (v[k] < +m[2]) { v[k] = Math.min(2600, +m[2] + 8); fixes.push(`meta.viewBox[${k}] → ${v[k]}`) } continue }
    if ((m = msg.match(/^(?:Node|State) "([^"]+)" exceeds the horizontal bounds/))) {
      const n = nodes.find((x) => x?.id === m![1])
      if (n && typeof n.width === "number" && n.width > 110) { n.width = Math.max(100, n.width - 32); fixes.push(`thu hẹp nút "${m[1]}" → ${n.width}px (vượt khung)`); continue }
    }
    if (/increase meta\.viewBox\[0\]/.test(msg) && type !== "workflow" && type !== "architecture") {
      const v = vb()
      if (v[0] < 2400 && !fixes.some((f) => f.startsWith("meta.viewBox[0]"))) { v[0] = Math.min(2400, v[0] + 160); fixes.push(`meta.viewBox[0] → ${v[0]} (thêm chỗ)`) }
      continue
    }
    if (/increase meta\.viewBox\[1\]/.test(msg)) {
      const v = vb()
      if (v[1] < 2000 && !fixes.some((f) => f.startsWith("meta.viewBox[1]"))) { v[1] = Math.min(2000, v[1] + 120); fixes.push(`meta.viewBox[1] → ${v[1]} (thêm chỗ)`) }
      continue
    }
    if ((m = msg.match(/^Label "(.+?)" overlaps [\s\S]*?Suggested fix: labelAt \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\]/))) {
      const e = (Array.isArray(ir[EDGES[type]]) ? ir[EDGES[type]] : []).find((x: any) => isObj(x) && x.label === m![1] && x.labelAt == null)
      if (e) { e.labelAt = [+m[2], +m[3]]; fixes.push(`dời nhãn "${m[1]}" ra khỏi nút (labelAt ${m[2]}, ${m[3]})`) }
      continue
    }
    if (/must include pos \[x, y\] when layout\.mode is omitted/.test(msg) && type === "architecture" && !isObj(ir.layout)) {
      ir.layout = { mode: "grid" }
      for (const c of Array.isArray(ir.components) ? ir.components : []) if (isObj(c)) { c.row ??= 0; c.col ??= 0 }
      fixes.push('layout.mode = "grid" (xếp thành phần theo row / col)')
      continue
    }
    if (/^mainPath step .+ has no matching edge/.test(msg) && Array.isArray(ir.mainPath)) { delete ir.mainPath; fixes.push("bỏ mainPath (có bước không có cạnh tương ứng)"); continue }
    if (/^mainPath /.test(msg) && Array.isArray(ir.mainPath)) { delete ir.mainPath; fixes.push("bỏ mainPath (không hợp lệ)"); continue }
  }
  return [...new Set(fixes)]
}

// ---------------------------------------------------------------- HTML → standalone dual-theme SVG (sandbox Chrome)
/** Remove anything active / external from an SVG string (defence in depth – the renderer escapes all text). */
export function cleanSvg(svg: string): string {
  return svg
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "")
    .replace(/url\(\s*(['"]?)(?!#)[^)'"]*\1\s*\)/gi, "none")
    .replace(/@import[^;]*;/gi, "")
    .replace(/\s(tabindex|role|aria-pressed|aria-haspopup|aria-controls|focusable)="[^"]*"/g, "")
    .replace(/\saria-label="Focus [^"]*"/g, "")
}

export async function extractSvg(html: string, title: string): Promise<{ svg: string; width: number; height: number }> {
  const stripped = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
  const r = await withOfflinePage(async (page) => {
    await page.setViewport({ width: 1600, height: 1000 })
    await page.setContent(stripped, { waitUntil: "load" })
    return page.evaluate((title: string) => {
      const svg = (document.querySelector(".diagram-container svg") || document.querySelector("svg")) as SVGSVGElement | null
      if (!svg) return null
      const clone = svg.cloneNode(true) as SVGSVGElement
      const rules: string[] = []
      for (const sheet of Array.from(document.styleSheets)) {
        let list: CSSRuleList
        try { list = sheet.cssRules } catch { continue }
        for (const rule of Array.from(list)) {
          if (rule.type === 7 && /^archify-/.test((rule as any).name || "")) { rules.push(rule.cssText); continue }
          if (rule.type !== 1) continue
          const sel = (rule as CSSStyleRule).selectorText || ""
          if (/(^|,)\s*(svg|:root|\[data-theme|\[data-preset|\.c-|\.t-|\.a-|\.m-)/.test(sel)) rules.push(rule.cssText)
        }
      }
      const host = rules.join("\n")
      const names = [...new Set(host.match(/--[a-zA-Z0-9-]+(?=\s*:)/g) || [])]
      const vars = (theme: string) => {
        const p = document.createElement("div")
        p.setAttribute("data-theme", theme)
        p.setAttribute("data-preset", "classic")
        p.style.cssText = "position:absolute;width:0;height:0;visibility:hidden"
        document.body.appendChild(p)
        const c = getComputedStyle(p)
        const s = names.map((n) => `${n}: ${c.getPropertyValue(n).trim()};`).join(" ")
        p.remove()
        return s
      }
      const vb = svg.viewBox.baseVal
      const w = vb?.width || svg.getBoundingClientRect().width || 800
      const h = vb?.height || svg.getBoundingClientRect().height || 600
      for (const a of Array.from(clone.attributes)) if (/^data-(?!theme)/.test(a.name)) clone.removeAttribute(a.name)
      clone.removeAttribute("style")
      clone.removeAttribute("class")
      clone.removeAttribute("data-theme")
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
      clone.setAttribute("width", String(w))
      clone.setAttribute("height", String(h))
      clone.setAttribute("role", "img")
      clone.setAttribute("aria-label", title)
      const font = "svg { font-family: 'JetBrains Mono', ui-monospace, Consolas, 'Segoe UI', 'DejaVu Sans Mono', monospace; }"
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style")
      const light = vars("light"), dark = vars("dark")
      style.textContent = `${font}\n${host}\n:root, svg { ${light} }\nsvg[data-theme="light"] { ${light} }\nsvg[data-theme="dark"] { ${dark} }\nrect.c-bg-rect { fill: var(--bg); }\n`
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect")
      bg.setAttribute("class", "c-bg-rect")
      bg.setAttribute("x", String(vb?.x || 0)); bg.setAttribute("y", String(vb?.y || 0))
      bg.setAttribute("width", String(w)); bg.setAttribute("height", String(h))
      clone.insertBefore(bg, clone.firstChild)
      clone.insertBefore(style, clone.firstChild)
      return { svg: new XMLSerializer().serializeToString(clone), width: w, height: h }
    }, title)
  })
  if (!r?.svg) throw new Error("không tìm thấy SVG trong kết quả của trình biên dịch sơ đồ")
  return { svg: cleanSvg(r.svg), width: Math.round(r.width), height: Math.round(r.height) }
}

export type CompileOk = { ok: true; ir: Record<string, any>; svg: string; width: number; height: number; fixes: string[]; notes: string[]; checks: { passed: number; total: number; warnings: number; profile: string } }
export type CompileErr = { ok: false; stage: "input" | "render" | "check" | "export"; errors: string[]; fixes: string[]; notes: string[] }

const diagText = (d: Diagnostic) => {
  const fix = Array.isArray(d.supportedFixes) && d.supportedFixes.length ? ` → sửa: ${d.supportedFixes.slice(0, 2).join("; ")}` : ""
  return `${String(d.message ?? d.code).replace(/\s+/g, " ").slice(0, 280)}${fix.slice(0, 200)}`
}

/** Validate + compile an IR (with mechanical repairs) and export the standalone SVG. */
export async function compileDiagram(type: DiagramType, rawIr: unknown, opts: { title?: string; lang?: "vi" | "en"; quality?: "standard" | "showcase" } = {}): Promise<CompileOk | CompileErr> {
  if (!DIAGRAM_TYPES.includes(type)) return { ok: false, stage: "input", errors: [`type phải là một trong ${DIAGRAM_TYPES.join(", ")}`], fixes: [], notes: [] }
  let ir: Record<string, any>, notes: string[]
  try { ({ ir, notes } = normalizeIr(type, rawIr, opts)) } catch (e: any) { return { ok: false, stage: "input", errors: [String(e?.message ?? e)], fixes: [], notes: [] } }
  const fixes: string[] = []
  let last: RenderResult | null = null
  for (let round = 0; round < 8; round++) {
    last = await renderOnce(type, ir)
    if (last.ok) break
    const f = autofix(type, ir, last.diagnostics)
    if (!f.length) break
    fixes.push(...f)
  }
  if (!last || !last.ok) {
    const diags = last && !last.ok ? last.diagnostics : []
    return { ok: false, stage: last && !last.ok ? last.stage : "render", errors: diags.slice(0, 12).map(diagText), fixes, notes }
  }
  try {
    const { svg, width, height } = await extractSvg(last.html, String(ir.meta.title))
    return { ok: true, ir, svg, width, height, fixes, notes, checks: last.checks }
  } catch (e: any) {
    return { ok: false, stage: "export", errors: [`không xuất được SVG (trình duyệt sandbox): ${String(e?.message ?? e).slice(0, 200)}`], fixes, notes }
  }
}

export const irHash = (ir: unknown) => crypto.createHash("sha256").update(JSON.stringify(ir)).digest("hex").slice(0, 16)
