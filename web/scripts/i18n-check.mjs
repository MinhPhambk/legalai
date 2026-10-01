// i18n checks for the web client (exit code 1 on any error):
//  1. vi.json and en.json have the same keys (plural forms key_one/key_other… count as one key);
//  2. every key used in the code (t("…"), <Trans k="…">, unit="…", template keys `ns.${x}`) exists;
//  3. no hard-coded Vietnamese text left in client/src outside the locale files (string literals,
//     template literals, JSX text and attributes; comments are ignored). Lines ending with
//     `// i18n-ignore` and files containing `i18n-ignore-file` are skipped (stable data values).
// Usage: node scripts/i18n-check.mjs [--keys]   (--keys prints every key used in the code)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const src = path.join(web, "client", "src")
const locDir = path.join(src, "locales")
const errors = []
const warn = []

// ---- 1. key parity ------------------------------------------------------------------------------
const PLURAL = /_(zero|one|two|few|many|other)$/
function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === "object") flatten(v, key, out)
    else if (typeof v === "string") out.set(key, v)
    else errors.push(`locale value is not a string: ${key}`)
  }
  return out
}
const load = (l) => {
  try {
    return flatten(JSON.parse(fs.readFileSync(path.join(locDir, `${l}.json`), "utf8")))
  } catch (e) {
    errors.push(`cannot read locales/${l}.json: ${e.message}`)
    return new Map()
  }
}
const dict = { vi: load("vi"), en: load("en") }
const bases = (m) => new Set([...m.keys()].map((k) => k.replace(PLURAL, "")))
const base = { vi: bases(dict.vi), en: bases(dict.en) }
for (const [a, b] of [["vi", "en"], ["en", "vi"]]) for (const k of base[a]) if (!base[b].has(k)) errors.push(`key in ${a}.json but not in ${b}.json: ${k}`)
for (const l of ["vi", "en"])
  for (const k of dict[l].keys())
    if (PLURAL.test(k) && !dict[l].has(k.replace(PLURAL, "_other"))) errors.push(`${l}.json: plural key without _other form: ${k}`)
// Placeholders must match between languages.
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",")
const tags = (s) => [...String(s).matchAll(/<(\w+)\/?>/g)].map((m) => m[1]).sort().join(",")
for (const k of base.vi) {
  if (!base.en.has(k)) continue
  const pick = (l) => dict[l].get(k) ?? dict[l].get(`${k}_other`)
  const [v, e] = [pick("vi"), pick("en")]
  if (v == null || e == null) continue
  if (vars(v) !== vars(e)) errors.push(`placeholders differ for ${k}: vi {${vars(v)}} / en {${vars(e)}}`)
  if (tags(v) !== tags(e)) errors.push(`rich-text tags differ for ${k}: vi <${tags(v)}> / en <${tags(e)}>`)
}

// ---- files ----------------------------------------------------------------------------------------
const files = []
;(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name)
    if (f.isDirectory()) {
      if (p !== locDir) walk(p)
    } else if (/\.(jsx?|mjs)$/.test(f.name)) files.push(p)
  }
})(src)

// ---- 2. used keys ---------------------------------------------------------------------------------
const used = new Map() // key or pattern → first location
const add = (k, where) => !used.has(k) && used.set(k, where)
for (const f of files) {
  const text = stripComments(fs.readFileSync(f, "utf8"))
  const rel = path.relative(web, f)
  const res = [
    /\bt\(\s*"([a-zA-Z0-9_.]+)"/g,
    /\bt\(\s*`([a-zA-Z0-9_.${}\s\w[\]()?:|&"'-]+?)`/g,
    /<Trans\s+k="([a-zA-Z0-9_.]+)"/g,
    /\bunit="([a-zA-Z0-9_.]+)"/g,
    /\bhasKey\(\s*`([^`]+)`/g,
    /"((?:errors|docs|tools|sources|expert|confidence|settings|auth|admin|chat|share)\.[a-zA-Z0-9_.]+)"/g,
  ]
  for (const re of res) for (const m of text.matchAll(re)) add(m[1], `${rel}:${text.slice(0, m.index).split("\n").length}`)
}
const allKeys = new Set([...base.vi, ...base.en])
for (const [k, where] of used) {
  if (!k.includes("${")) {
    if (!allKeys.has(k) && !/\.$/.test(k)) errors.push(`missing key "${k}" (used at ${where})`)
    continue
  }
  // Template key: `tools.name.${tool}` → at least one key must match the pattern.
  const re = new RegExp("^" + k.split(/\$\{[^}]*\}/).map((s) => s.replace(/[.*+?^()|[\]\\]/g, "\\$&")).join("[A-Za-z0-9_]+") + "$")
  if (![...allKeys].some((x) => re.test(x))) errors.push(`no key matches template "${k}" (used at ${where})`)
}
const isUsed = (k) =>
  [...used.keys()].some((u) => (u.includes("${") ? new RegExp("^" + u.split(/\$\{[^}]*\}/).map((s) => s.replace(/[.*+?^()|[\]\\]/g, "\\$&")).join("[A-Za-z0-9_]+") + "$").test(k) : u === k))
for (const k of base.vi) if (!isUsed(k) && !k.startsWith("server.")) warn.push(`unused key: ${k}`)

// ---- 3. hard-coded Vietnamese ----------------------------------------------------------------------
// Letters that only Vietnamese uses among the scripts we care about (plus the tone-marked vowels).
const VI = /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ]/
function stripComments(s) {
  // Remove block comments and JSX comments, then line comments not inside strings (good enough for this code base).
  s = s.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, (m) => m.replace(/[^\n]/g, " "))
  return s
    .split("\n")
    .map((line) => {
      let out = ""
      let q = null
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (q) {
          if (c === "\\") {
            out += c + (line[i + 1] || "")
            i++
            continue
          }
          if (c === q) q = null
          out += c
          continue
        }
        if (c === '"' || c === "'" || c === "`") q = c
        if (c === "/" && line[i + 1] === "/" && !/[:\\]$/.test(out)) break
        out += c
      }
      return out
    })
    .join("\n")
}
for (const f of files) {
  const raw = fs.readFileSync(f, "utf8")
  if (raw.includes("i18n-ignore-file")) continue
  const rel = path.relative(web, f)
  const rawLines = raw.split("\n")
  stripComments(raw)
    .split("\n")
    .forEach((line, i) => {
      if (/i18n-ignore/.test(rawLines[i])) return
      if (VI.test(line)) errors.push(`hard-coded Vietnamese at ${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
}

// ---- report ---------------------------------------------------------------------------------------
if (process.argv.includes("--keys")) console.log([...used.keys()].sort().join("\n"))
if (process.argv.includes("--warn")) for (const w of warn) console.log("warn:", w)
console.log(`i18n-check: ${base.vi.size} keys (vi) / ${base.en.size} keys (en), ${used.size} used in code, ${files.length} files scanned, ${warn.length} unused`)
if (errors.length) {
  for (const e of errors) console.error("✗", e)
  console.error(`i18n-check FAILED (${errors.length} problem${errors.length > 1 ? "s" : ""})`)
  process.exit(1)
}
console.log("i18n-check OK")
