// OCR fallback for SCANNED PDFs (image-only, no text layer) using Chrome's built-in PDF OCR ("Screen AI" component,
// the viewer banner "This PDF is inaccessible. Text extracted, powered by Google AI"). Runs in a DEDICATED OCR Chrome
// (tools/launch-ocr-chrome.mjs: own profile .sandbox/ocr-chrome-profile, 127.0.0.1:9334, headed off-screen,
// --force-renderer-accessibility) – never the sandbox Chrome (:9333) or the user's own Chrome.
// How: the PDF is written to a temporary file in .sandbox/tmp and opened (file://) in the OCR Chrome; the OCR text
// only exists in the PDF viewer's accessibility tree, which CDP getFullAXTree does NOT reach, so chrome://accessibility
// is automated (the PDF tab's row → showOrRefreshTree → <pre> dump: pdfRoot → region 'Page N' → staticText) and polled
// until the requested pages' texts are stable. ~2.5 s/page; CER ≈ 0.3–0.7 % on Vietnamese court scans, with typical
// errors: dropped/wrong diacritics, Cyrillic look-alikes (М), merged two-column headers, stamp fragments.
// Post-processing: NFC, Cyrillic/Greek look-alikes → Latin inside Latin words, spacing, header split, stamp-noise
// lines (short ASCII all-caps fragments like "TOA", "NHAN"; every dropped line is reported in warnings).
// Parallel (ND45_OCR_PARALLEL=K, default 4; 1 = sequential): ≥ 4 wanted pages are cut with pdf-lib into K balanced
// sub-PDFs (≥ 2 pages each) OCR'd concurrently in K OCR Chrome processes (main :9334 + workers :9335.. with profiles
// .sandbox/ocr-chrome-profile-w<i>, started on demand, exit after ND45_OCR_WORKER_IDLE_MIN=10 idle minutes).
// Measured on 9 pages (án lệ 90/2026): sequential 20.6–23.1 s, K=2 14.8 s, K=4 10.9–12.1 s (≈1.9×), identical text.
// One Chrome serialises Screen AI (K tabs in ONE Chrome: 61–100 s, slower than one tab), so parallelism = processes.
// Failed chunks are retried on the main OCR Chrome; pdf-lib errors → the sequential path.
// One PDF at a time (in-process queue + cross-process lock file); results cached by sha256 in
// <cache>/legalai/ocr/<sha>.json (raw page texts – normalisation is re-applied on read).
// OCR text is NOT verbatim source text: callers prefix it with OCR_LABEL, set ui {ocr:true, engine, pages} and
// record evidence with meta.ocr=true (grounding_check then caps claims resting on it at TRUNG BÌNH).
// Also importable by the Node web server (native TS type-stripping): no enums/namespaces, .ts imports only.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import puppeteer from "puppeteer-core"

export const OCR_LABEL = "[Văn bản nhận dạng OCR từ bản scan – có thể sai dấu/chữ; đối chiếu bản gốc trước khi trích dẫn chính xác]"
export const OCR_ENGINE = "chrome-screen-ai"
export const OCR_WARNING = "⚠ Nội dung lấy bằng nhận dạng chữ (OCR) từ bản scan – có thể sai dấu/chữ; trích dẫn nguyên văn phải đối chiếu bản gốc; độ tin cậy tối đa TRUNG BÌNH."

export type OcrPage = { n: number; text: string }
export type OcrResult = { pages: OcrPage[]; engine: typeof OCR_ENGINE; ms: number; warnings: string[]; totalPages: number; cached: boolean; sha256: string }
export type OcrOptions = { pages?: number[]; maxPages?: number; timeoutMs?: number }
export class OcrUnavailable extends Error { constructor(m: string) { super(m); this.name = "OcrUnavailable" } }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const PORT = () => process.env.OCR_CHROME_PORT ?? "9334"
const PROFILE = process.env.OCR_CHROME_PROFILE ?? path.join(ROOT, ".sandbox", "ocr-chrome-profile") // override: tests / experiments only
const TMP = path.join(ROOT, ".sandbox", "tmp")
const LAUNCHER = path.join(ROOT, "tools", "launch-ocr-chrome.mjs")
const cacheDir = () => path.join(process.env.XDG_CACHE_HOME ?? path.join(ROOT, ".sandbox", "cache"), "legalai", "ocr")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ OCR Chrome instances (lazy start + health)
// Instance 0 = the OCR Chrome (127.0.0.1:9334, .sandbox/ocr-chrome-profile). Instances 1..K-1 = parallel workers
// (port 9334+i, profile .sandbox/ocr-chrome-profile-w<i>, component copied from instance 0), started on first use.
// One Chrome runs Screen AI OCR serially (K tabs in one Chrome were SLOWER than one tab), so parallelism = processes.
type Inst = { i: number; port: string; profile: string; log: string }
const inst = (i: number): Inst => ({ i, port: String(+PORT() + i), profile: i ? PROFILE + "-w" + i : PROFILE, log: path.join(TMP, i ? "ocr-chrome-launcher-w" + i + ".log" : "ocr-chrome-launcher.log") })
async function portUp(port = PORT()) {
  try { return (await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1500) })).ok } catch { return false }
}
function componentVersion(profile = PROFILE): string | null {
  try {
    const d = path.join(profile, "screen_ai")
    return fs.readdirSync(d).filter((v) => fs.existsSync(path.join(d, v, "chrome_screen_ai.dll"))).sort().pop() ?? null
  } catch { return null }
}
const starting = new Map<string, Promise<void>>()
/** Start tools/launch-ocr-chrome.mjs for an instance unless its port is already up (ND45_OCR_AUTOSTART=0: never). */
async function ensureChrome(x: Inst = inst(0)): Promise<void> {
  if (await portUp(x.port)) return
  if (process.env.ND45_OCR_AUTOSTART === "0") throw new OcrUnavailable("OCR Chrome không chạy (127.0.0.1:" + x.port + "). Khởi động: node tools/launch-ocr-chrome.mjs")
  if (!starting.has(x.port)) starting.set(x.port, (async () => {
    fs.mkdirSync(TMP, { recursive: true })
    const fd = fs.openSync(x.log, "w")
    // Under run.sh the agent runs with HOME/USERPROFILE/TEMP redirected into .sandbox; Chrome does not open its
    // DevTools port in that environment, so the launcher gets the user's real profile env back (derived from LOCALAPPDATA).
    const env: Record<string, string | undefined> = { ...process.env, OCR_CHROME_PORT: x.port, OCR_CHROME_PROFILE: x.profile, OCR_CHROME_IDLE_EXIT_MIN: x.i ? process.env.ND45_OCR_WORKER_IDLE_MIN ?? "10" : "0" }
    const local = process.env.LOCALAPPDATA
    if (local && /[\/]AppData[\/]Local$/i.test(local)) {
      const home = path.resolve(local, "..", "..")
      Object.assign(env, { USERPROFILE: home, HOME: home, TEMP: path.join(local, "Temp"), TMP: path.join(local, "Temp") })
    }
    const child = spawn(process.env.ND45_NODE ?? "node", [LAUNCHER], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env })
    let exited: number | null = null
    child.on("exit", (c) => { exited = c ?? 0 })
    child.on("error", () => { exited = -1 })
    child.unref()
    fs.closeSync(fd)
    for (let k = 0; k < 80; k++) {
      if (await portUp(x.port)) return
      if (exited !== null && exited !== 0) break
      await sleep(500)
    }
    const why = (() => { try { return fs.readFileSync(x.log, "utf8").trim().split("\n").slice(-3).join(" | ") } catch { return "" } })()
    throw new OcrUnavailable("OCR unavailable: không khởi động được OCR Chrome (127.0.0.1:" + x.port + ")" + (why ? " – " + why : ""))
  })().finally(() => { starting.delete(x.port) }))
  return starting.get(x.port)
}

/** Health check: OCR Chrome reachable and Screen AI component present. start=false → never launches Chrome. */
export async function ocrHealth(opts: { start?: boolean } = {}): Promise<{ ok: boolean; port: string; component: string | null; parallel: number; reason?: string }> {
  try {
    if (opts.start === false) { if (!(await portUp())) throw new OcrUnavailable("OCR Chrome không chạy (127.0.0.1:" + PORT() + ")") }
    else await ensureChrome()
    const component = componentVersion()
    if (!component) throw new OcrUnavailable("OCR unavailable: thiếu thành phần Screen AI (chrome_screen_ai.dll) trong .sandbox/ocr-chrome-profile/screen_ai")
    return { ok: true, port: PORT(), component, parallel: parallelK() }
  } catch (e: any) {
    return { ok: false, port: PORT(), component: componentVersion(), parallel: parallelK(), reason: String(e?.message ?? e) }
  }
}
/** ND45_OCR_PARALLEL = number of OCR Chrome processes per request (default 4 – measured best; 1 = sequential only). */
export const parallelK = () => Math.max(1, Math.min(6, Math.floor(+(process.env.ND45_OCR_PARALLEL ?? 4)) || 4))


// ------------------------------------------------------------------ accessibility dump → pages
export type AxParse = { total: number; banner: string; pages: Map<number, string> }
/** Parse a chrome://accessibility tree dump of the PDF viewer (region 'Page N' → staticText lines). */
export function parseAxTree(tree: string): AxParse {
  const pages = new Map<number, string[]>()
  let cur: string[] | null = null, depthPage = -1
  for (const line of tree.split("\n")) {
    const m = line.match(/^(\+*)id#=-?\d+ (\w+)/)
    if (!m) continue
    const d = m[1].length, role = m[2]
    if (cur && d <= depthPage) cur = null
    const name = line.match(/ name='((?:[^']|'(?! \w+=))*)'/)?.[1]
    const pm = role === "region" ? name?.match(/^Page (\d+)$/) : null
    if (pm) { cur = []; pages.set(+pm[1], cur); depthPage = d; continue }
    if (cur && role === "staticText" && name && !/extracted text$/.test(name)) cur.push(name.replace(/<newline>/g, "\n"))
  }
  const total = +(tree.match(/PDF document containing (\d+) page/)?.[1] ?? 0)
  const banner = tree.match(/This PDF is inaccessible\.[^'\n]{0,120}/)?.[0] ?? ""
  return { total, banner, pages: new Map([...pages].map(([n, t]) => [n, t.join("\n").replace(/\n{2,}/g, "\n").trim()])) }
}

async function dumpTree(ax: any, urlPart: string): Promise<string> {
  await ax.goto("chrome://accessibility", { waitUntil: "load" })
  await sleep(500)
  return ax.evaluate(async (u: string) => {
    const row = [...document.querySelectorAll("div.row[id^=page_]")].find((r) => ((r.querySelector("h3")?.textContent ?? "") + (r.querySelector(".url")?.textContent ?? "")).includes(u))
    if (!row) return ""
    const id = row.id
    ;(document.getElementById(id + "-showOrRefreshTree") as HTMLElement | null)?.click()
    for (let k = 0; k < 100; k++) {
      await new Promise((r) => setTimeout(r, 200))
      const pre = document.getElementById(id)?.querySelector("pre") as HTMLElement | null
      if (pre && pre.innerText.length > 100) return pre.innerText
    }
    return ""
  }, urlPart)
}

// ------------------------------------------------------------------ post-processing
// Cyrillic / Greek letters that look like Latin ones (OCR confusions in Vietnamese text).
const HOMO: Record<string, string> = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y", "Ѕ": "S", "І": "I", "Ј": "J", "Ү": "Y",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "ѕ": "s", "і": "i", "ј": "j", "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "ο": "o", "ι": "i", "κ": "k", "ν": "v",
}
const HOMO_RE = new RegExp(`[${Object.keys(HOMO).join("")}]`, "u")
const LATIN = /\p{Script=Latin}/u
// ASCII all-caps acronyms that are real text, never stamp noise
const KEEP_CAPS = new Set("WTO FTA EU USD VND EUR VAT HS CIF FOB AL QH ND CP TT BTC BCT HC DS KDTM LD HNGD PL UBND HDND TAND VKS VKSND ASEAN CPTPP EVFTA UKVFTA RCEP AANZFTA VIFTA VJEPA AKFTA ACFTA AIFTA AJCEP VKFTA VCFTA CO CFR EXW DDP DAP ISO ID II III IV VI VII VIII IX XI XII XIII XIV XV".split(" "))

/** Normalise one OCR text (exported for tests). dropped = removed stamp-noise lines. */
export function normalizeOcrText(raw: string): { text: string; dropped: string[] } {
  const dropped: string[] = []
  const out: string[] = []
  for (let line of raw.normalize("NFC").split("\n")) {
    // look-alikes: inside a word that has Latin letters, or anywhere on a predominantly Latin line
    if (HOMO_RE.test(line)) {
      const letters = [...line].filter((c) => /\p{L}/u.test(c))
      const latinShare = letters.filter((c) => LATIN.test(c)).length / Math.max(1, letters.length)
      line = line.replace(/[\p{L}\p{M}]+/gu, (w) => {
        if (!HOMO_RE.test(w)) return w
        const hasLatin = LATIN.test(w)
        const otherForeign = [...w].some((c) => /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(c) && !HOMO[c])
        if (otherForeign && !hasLatin) return w
        return hasLatin || latinShare >= 0.7 ? [...w].map((c) => HOMO[c] ?? c).join("") : w
      }).normalize("NFC")
    }
    line = line.replace(/[ \t  -​]+/g, " ").replace(/ ([,.;:!?)\]”])/g, "$1").replace(/([(\[“]) /g, "$1").trim()
    if (!line) continue
    // stamp fragments: 1–2 short ASCII all-caps words (real Vietnamese capitals carry diacritics)
    if (/^[A-Z]{2,6}( [A-Z]{2,6})?$/.test(line) && !line.split(" ").every((w) => KEEP_CAPS.has(w))) { dropped.push(line); continue }
    // two-column header merged into one line: "TÒA ÁN NHÂN DÂN TỐI CAO CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM"
    const hm = line.match(/^(.*\S)\s+(CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM|CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM|Độc lập\s*[-–]\s*Tự do\s*[-–]\s*Hạnh phúc)$/u)
    if (hm) { out.push(hm[1], hm[2]); continue }
    out.push(line)
  }
  return { text: out.join("\n"), dropped }
}

// ------------------------------------------------------------------ serialisation + cache
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}
// cross-process lock (agent, web server and tests may share the one OCR Chrome)
async function withLock<T>(fn: () => Promise<T>, waitMs: number): Promise<T> {
  const lock = path.join(TMP, "ocr.lock")
  fs.mkdirSync(TMP, { recursive: true })
  const until = Date.now() + waitMs
  for (;;) {
    try { fs.mkdirSync(lock); break } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5 * 60_000) { fs.rmSync(lock, { recursive: true, force: true }); continue } } catch {}
      if (Date.now() > until) throw new Error("OCR đang bận (một PDF khác đang được nhận dạng) – thử lại sau.")
      await sleep(400)
    }
  }
  try { return await fn() } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}

type CacheEntry = { sha256: string; engine: string; totalPages: number; pages: Record<string, string>; at: number }
const cacheFile = (sha: string) => path.join(cacheDir(), `${sha}.json`)
function readCache(sha: string): CacheEntry | null {
  try { return JSON.parse(fs.readFileSync(cacheFile(sha), "utf8")) } catch { return null }
}
function writeCache(e: CacheEntry) {
  try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(cacheFile(e.sha256), JSON.stringify(e)) } catch {}
}

function result(e: CacheEntry, want: number[], t0: number, cached: boolean, warnings: string[]): OcrResult {
  const pages: OcrPage[] = []
  const dropped: string[] = []
  for (const n of want) {
    const raw = e.pages[String(n)]
    if (raw === undefined) continue
    const r = normalizeOcrText(raw)
    dropped.push(...r.dropped.map((d) => `tr.${n} "${d}"`))
    pages.push({ n, text: r.text })
  }
  const w = [...warnings]
  if (dropped.length) w.push(`Đã bỏ ${dropped.length} dòng nghi là chữ trên con dấu: ${dropped.slice(0, 8).join(", ")}${dropped.length > 8 ? ", …" : ""}`)
  const empty = pages.filter((p) => !p.text).map((p) => p.n)
  if (empty.length) w.push(`Không nhận dạng được chữ ở trang ${empty.join(", ")}`)
  return { pages, engine: OCR_ENGINE, ms: Date.now() - t0, warnings: w, totalPages: e.totalPages, cached, sha256: e.sha256 }
}

/**
 * OCR a scanned PDF (Buffer or file path) in the dedicated OCR Chrome. pages = 1-based page numbers (default: the
 * first maxPages=15 pages). Throws OcrUnavailable when the OCR Chrome / Screen AI component is not usable.
 */
export async function ocrPdf(input: Buffer | Uint8Array | string, opts: OcrOptions = {}): Promise<OcrResult> {
  if (process.env.ND45_OCR === "0") throw new OcrUnavailable("OCR đã bị tắt (ND45_OCR=0).")
  const t0 = Date.now()
  const buf = typeof input === "string" ? fs.readFileSync(input) : Buffer.from(input)
  if (!buf.subarray(0, 1024).toString("latin1").includes("%PDF")) throw new Error("Tệp không phải PDF.")
  const sha = crypto.createHash("sha256").update(buf).digest("hex")
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 15, 60))
  const wantOf = (total: number) => {
    const base = opts.pages?.length ? [...new Set(opts.pages.map((n) => Math.floor(n)))].filter((n) => n >= 1 && (!total || n <= total)).sort((a, b) => a - b) : Array.from({ length: total || maxPages }, (_, i) => i + 1)
    return base.slice(0, maxPages)
  }
  const hit = readCache(sha)
  if (hit && wantOf(hit.totalPages).every((n) => hit.pages[String(n)] !== undefined)) {
    const want = wantOf(hit.totalPages)
    return result(hit, want, t0, true, want.length < hit.totalPages && !opts.pages?.length ? [`Chỉ OCR ${want.length}/${hit.totalPages} trang đầu (maxPages=${maxPages})`] : [])
  }
  const tmo = (n: number) => opts.timeoutMs ?? Math.min(20_000 + 4_000 * n, 180_000)
  const timeoutMs = tmo(opts.pages?.length ? Math.max(...opts.pages) : maxPages)
  return serial(() => withLock(async () => {
    await ensureChrome()
    if (!componentVersion()) throw new OcrUnavailable("OCR unavailable: thiếu thành phần Screen AI (chrome_screen_ai.dll) trong .sandbox/ocr-chrome-profile/screen_ai")
    const warnings: string[] = []
    const entry: CacheEntry = { sha256: sha, engine: OCR_ENGINE, totalPages: hit?.totalPages ?? 0, pages: { ...(hit?.pages ?? {}) }, at: Date.now() }
    let want: number[] = []
    let timedOut = false
    // Parallel plan (ND45_OCR_PARALLEL=K, default 4): the wanted pages are cut into ≤ K sub-PDFs (≥ 2 pages each,
    // pdf-lib) OCR'd at the same time in K OCR Chrome processes. Any problem (pdf-lib cannot read the PDF, a worker
    // does not start, a chunk fails) falls back to the main OCR Chrome, sequentially.
    const plan = await parallelPlan(buf, wantOf, parallelK()).catch(() => null)
    if (plan) {
      entry.totalPages = plan.total
      want = plan.want
      const xs: Inst[] = [inst(0)]
      const extra = await Promise.all(plan.chunks.slice(1).map((_, j) => ensureChrome(inst(j + 1)).then(() => (componentVersion(inst(j + 1).profile) ? inst(j + 1) : null), () => null)))
      for (const x of extra) if (x) xs.push(x)
      const chunks = splitEven(want, xs.length)
      const failed: number[] = []
      await Promise.all(chunks.map(async (g, j) => {
        try {
          const r = await runOnce(xs[j], await plan.sub(g), `${sha.slice(0, 12)}-c${g[0]}`, (t) => Array.from({ length: t || g.length }, (_, i) => i + 1), tmo(g.length))
          g.forEach((n, i) => { const t = r.pages.get(i + 1); if (t) entry.pages[String(n)] = t })
          failed.push(...g.filter((_, i) => !r.pages.get(i + 1)))
        } catch { failed.push(...g) }
      }))
      if (failed.length) { // retry what failed (or stayed empty) on the main OCR Chrome, sequentially
        failed.sort((x, y) => x - y)
        try {
          const r = await runOnce(inst(0), await plan.sub(failed), `${sha.slice(0, 12)}-retry`, (t) => Array.from({ length: t || failed.length }, (_, i) => i + 1), tmo(failed.length))
          failed.forEach((n, i) => { const t = r.pages.get(i + 1); if (t) entry.pages[String(n)] = t })
          if (r.warnings.some((w) => /Hết thời gian/.test(w))) { timedOut = true; warnings.push(...r.warnings) }
        } catch (e) { if (e instanceof OcrUnavailable && failed.length === want.length) throw e }
      }
    } else {
      const r = await runOnce(inst(0), buf, sha.slice(0, 12), wantOf, timeoutMs)
      entry.totalPages = r.total || entry.totalPages
      want = wantOf(entry.totalPages)
      for (const n of want) { const t = r.pages.get(n); if (t) entry.pages[String(n)] = t }
      timedOut = r.warnings.some((w) => /Hết thời gian/.test(w))
      warnings.push(...r.warnings)
    }
    if (want.every((n) => !(entry.pages[String(n)] ?? ""))) throw new Error(`OCR không trả về chữ nào sau ${Math.round((Date.now() - t0) / 1000)}s.`)
    // empty pages: cached as blank, unless OCR ran out of time (then they are retried next time)
    for (const n of want) if (!entry.pages[String(n)]) { if (timedOut) delete entry.pages[String(n)]; else entry.pages[String(n)] = "" }
    if (want.length < entry.totalPages && !opts.pages?.length) warnings.push(`Chỉ OCR ${want.length}/${entry.totalPages} trang đầu (maxPages=${maxPages})`)
    entry.at = Date.now()
    writeCache(entry)
    return result(entry, want, t0, false, warnings)
  }, timeoutMs + 60_000))
}

/** Exactly min(k, n) consecutive, balanced chunks (9 pages, k=4 → 3/2/2/2). */
const splitEven = (xs: number[], k: number) => {
  const n = Math.max(1, Math.min(k, xs.length))
  const out: number[][] = []
  for (let j = 0, at = 0; j < n; j++) { const len = Math.floor(xs.length / n) + (j < xs.length % n ? 1 : 0); out.push(xs.slice(at, at + len)); at += len }
  return out.filter((c) => c.length)
}
/** Parallel plan, or null when K < 2, fewer than 4 pages are wanted, or pdf-lib cannot read the PDF. */
async function parallelPlan(buf: Buffer, wantOf: (total: number) => number[], K: number) {
  if (K < 2) return null
  const { PDFDocument } = await import("pdf-lib")
  const src = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false })
  const total = src.getPageCount()
  const want = wantOf(total)
  const k = Math.min(K, Math.floor(want.length / 2)) // ≥ 2 pages per chunk: the per-file overhead (~5 s) makes 1-page chunks slower
  if (k < 2) return null
  const sub = async (pages: number[]) => {
    const d = await PDFDocument.create()
    for (const p of await d.copyPages(src, pages.map((n) => n - 1))) d.addPage(p)
    return Buffer.from(await d.save())
  }
  return { total, want, chunks: splitEven(want, k), sub }
}

type Run = { total: number; pages: Map<number, string>; banner: string; warnings: string[] }
/** OCR one PDF in one OCR Chrome instance: temp file → PDF tab → poll chrome://accessibility until the wanted pages are stable. */
async function runOnce(x: Inst, buf: Buffer, tag: string, wantOf: (total: number) => number[], timeoutMs: number): Promise<Run> {
  fs.mkdirSync(TMP, { recursive: true })
  const name = `ocr-${tag}-${process.pid}-${Date.now()}.pdf`
  const file = path.join(TMP, name)
  fs.writeFileSync(file, buf)
  let browser: any
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${x.port}`, defaultViewport: null, protocolTimeout: 120_000 })
  } catch (e: any) {
    fs.rmSync(file, { force: true })
    throw new OcrUnavailable(`OCR unavailable: không kết nối được OCR Chrome (127.0.0.1:${x.port}): ${e?.message ?? e}`)
  }
  const warnings: string[] = []
  const ax = await browser.newPage()
  const pg = await browser.newPage()
  const started = Date.now()
  try {
    await pg.bringToFront().catch(() => {})
    await pg.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 30_000 }).catch(() => {})
    const deadline = Date.now() + timeoutMs
    let prev = "", stableRounds = 0, want: number[] = [], last: AxParse | null = null
    while (Date.now() < deadline) {
      await sleep(1200)
      const tree = await dumpTree(ax, name).catch(() => "")
      if (!tree) continue
      if (/Couldn.?t download text extraction/i.test(tree)) throw new OcrUnavailable("OCR unavailable: Chrome báo \"Couldn't download text extraction files\" – thành phần Screen AI không dùng được trong OCR Chrome.")
      const p = parseAxTree(tree)
      last = p
      if (/This PDF is inaccessible\. Couldn/i.test(p.banner)) throw new OcrUnavailable(`OCR unavailable: Chrome không nhận dạng được chữ (${p.banner}).`)
      if (p.total) want = wantOf(p.total)
      if (!want.length) continue
      const done = want.every((n) => (p.pages.get(n) ?? "").length > 0)
      const sig = want.map((n) => `${n}:${(p.pages.get(n) ?? "").length}`).join(",")
      stableRounds = sig === prev ? stableRounds + 1 : 0
      prev = sig
      const finished = /Text extracted/i.test(p.banner)
      // no OCR banner after a while = the PDF has a text layer (the viewer shows it directly)
      const noOcr = !p.banner && Date.now() - started > 8000 && stableRounds >= 1 && [...p.pages.values()].some((t) => t.length > 50)
      if ((done && (stableRounds >= 1 || finished)) || (finished && stableRounds >= 1) || noOcr) { // "Text extracted" + all wanted pages = final
        if (noOcr && !done) warnings.push("PDF có lớp chữ (không cần OCR) – văn bản lấy từ trình xem PDF.")
        break
      }
      // the highest requested page is ready and stable → earlier empty pages are blank
      if (stableRounds >= 3 && (p.pages.get(want[want.length - 1]) ?? "").length > 0) break
    }
    if (!last || !want.length) throw new Error(`OCR Chrome không mở được PDF trong ${Math.round(timeoutMs / 1000)}s.`)
    const lastP = last
    const missing = want.filter((n) => !(lastP.pages.get(n) ?? ""))
    if (Date.now() >= deadline && missing.length) warnings.push(`Hết thời gian (${Math.round(timeoutMs / 1000)}s): chưa nhận dạng xong trang ${missing.join(", ")}`)
    return { total: lastP.total, pages: new Map(want.map((n) => [n, lastP.pages.get(n) ?? ""])), banner: lastP.banner, warnings }
  } finally {
    await pg.close().catch(() => {})
    await ax.close().catch(() => {})
    browser.disconnect()
    fs.rmSync(file, { force: true })
  }
}

// ------------------------------------------------------------------ helpers for callers
/** Labelled OCR text: OCR_LABEL first, then the pages (markers "--- Trang n ---" unless markers=false). */
export function ocrBlock(r: OcrResult, markers = true): string {
  const body = r.pages.filter((p) => p.text).map((p) => (markers ? `--- Trang ${p.n} ---\n${p.text}` : p.text)).join("\n")
  return `${OCR_LABEL}\n${body}`
}
/** metadata.ui fields for a tool result resting on OCR text. */
export const ocrUi = (r: OcrResult) => ({ ocr: true, engine: r.engine, pages: r.pages.map((p) => p.n) })
/** evidence meta for recordEvidence (grounding_check caps claims resting on OCR evidence at TRUNG BÌNH). */
export const ocrMeta = (r: OcrResult) => ({ ocr: true, engine: r.engine, ocr_pages: r.pages.map((p) => p.n), total_pages: r.totalPages, warning: OCR_WARNING })
/**
 * For the web server's upload extraction (web/server/extract.mjs): a scanned upload → labelled OCR text in the same
 * shape as extractText() ({ text, chars, truncated }) plus ocr { engine, pages, totalPages, warnings, ms }.
 * Throws OcrUnavailable (OCR Chrome / component not usable) or Error (no text recognised).
 */
export async function ocrUploadText(buf: Buffer | Uint8Array, cap = 200_000, opts: OcrOptions = {}) {
  const r = await ocrPdf(buf, { maxPages: 15, ...opts })
  if (!r.pages.some((p) => p.text.length > 50)) throw new Error("PDF là bản scan và OCR không nhận dạng được chữ.")
  const text = ocrBlock(r)
  return { text: text.length > cap ? text.slice(0, cap) : text, chars: text.length, truncated: text.length > cap, ocr: { engine: r.engine, pages: r.pages.map((p) => p.n), totalPages: r.totalPages, warnings: r.warnings, ms: r.ms } }
}
/** "trang 1–9/9" style range for messages. */
export const ocrRange = (r: OcrResult) => {
  const ns = r.pages.map((p) => p.n)
  return ns.length ? `${ns[0] === ns[ns.length - 1] ? ns[0] : `${ns[0]}–${ns[ns.length - 1]}`}/${r.totalPages || "?"}` : "0"
}
