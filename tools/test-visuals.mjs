// Tests for the visual tools (v12): diagram_create (Archify IR validation / autofix / compile / export, the skill's
// IR templates, sandbox of the renderer child process), image_search + image_fetch (real Wikimedia Commons results,
// license filter, download limits, allow-list, SSRF guards), source_snapshot (a real vbpl.vn page + an official PDF
// page). Needs the sandbox Chrome (node tools/launch-chrome.mjs) and internet. Output folder: a temp dir (never the
// real session outputs).  node tools/test-visuals.mjs   (ONLY=diagram,image,snapshot)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.env.LEGALAI_OUTPUTS_DIR ??= (fs.mkdirSync(path.join(ROOT, ".sandbox", "tmp"), { recursive: true }), fs.mkdtempSync(path.join(ROOT, ".sandbox", "tmp", "visuals-test-")))
const OUT = process.env.LEGALAI_OUTPUTS_DIR
const ONLY = new Set((process.env.ONLY || "diagram,image,snapshot").split(","))
let fails = 0
const check = (ok, msg) => (console.log(ok ? "  ✓" : "  ✗", msg), ok || fails++)
const ctx = (sid) => ({ sessionID: sid, messageID: "msg_test" }) // messageID → tools return { output, metadata }
const idOf = (out) => String(out).match(/\[\[diagram:(v\d{14}-[0-9a-f]{6})\]\]|\(visual:(v\d{14}-[0-9a-f]{6})\)/)?.slice(1).find(Boolean)
const metaOf = (sid, id) => JSON.parse(fs.readFileSync(path.join(OUT, sid, "visuals", `${id}.json`), "utf8"))

if (ONLY.has("diagram")) {
  console.log("diagram_create")
  const { create } = await import("../.opencode/tools/diagram.ts")
  const { normalizeIr, autofix, cleanSvg, compileDiagram, ARCHIFY_VERSION } = await import("../.opencode/lib/archify.ts")
  check(ARCHIFY_VERSION === "2.16.0", `vendored Archify version ${ARCHIFY_VERSION}`)
  // normalisation strips everything that could leave the compiler
  const n = normalizeIr("workflow", { diagram_type: "sequence", meta: { title: "x", output: "../../evil.html", animation: "trace", views: [] }, nodes: [{ id: "a", brand: { url: "https://evil.example/logo" }, label: "A" }] }, { title: "Tiêu đề" })
  check(n.ir.diagram_type === "workflow" && n.ir.schema_version === 2 && n.ir.meta.title === "Tiêu đề", "type / schema_version / title are fixed by the tool")
  check(!("output" in n.ir.meta) && !("animation" in n.ir.meta) && !("brand" in n.ir.nodes[0]) && n.ir.meta.legend?.mode === "hidden", "output path, animation, brand URL stripped; legend hidden")
  let bad = false
  try { normalizeIr("workflow", "{not json") } catch { bad = true }
  check(bad, "invalid JSON string rejected")
  bad = false
  try { normalizeIr("workflow", "x".repeat(90_000)) } catch { bad = true }
  check(bad, "oversized IR rejected")
  // mechanical autofix from structured diagnostics
  const ir = { lanes: [{ id: "l" }], nodes: [{ id: "a", type: "process", col: 9, extra: 1 }], mainPath: ["a", "b"] }
  const fx = autofix("workflow", ir, [
    { code: "schema/enum", message: "", subject: { path: "/nodes/0/type" }, evidence: { allowedValues: ["frontend", "backend", "database", "cloud", "security", "messagebus", "external"] } },
    { code: "schema/maximum", message: "", subject: { path: "/nodes/0/col" }, evidence: { limit: 5, comparison: "<=" } },
    { code: "schema/additionalProperties", message: "", subject: { path: "/nodes/0" }, evidence: { additionalProperty: "extra" } },
    { code: "schema/required", message: "", subject: { path: "/nodes/0" }, evidence: { missingProperty: "lane" } },
    { code: "layout/constraint", message: 'mainPath step "a" -> "b" has no matching edge — add the edge' },
  ])
  check(ir.nodes[0].type === "backend" && ir.nodes[0].col === 5 && !("extra" in ir.nodes[0]) && ir.nodes[0].lane === "l" && !ir.mainPath && fx.length === 5, `autofix: ${fx.length} fixes`)
  check(!/script|onload|foreignObject|https:/i.test(cleanSvg('<svg><script>x</script><rect onload="x" /><image href="https://e/x.png"/><foreignObject><div/></foreignObject></svg>')), "cleanSvg removes scripts, handlers, external refs, foreignObject")
  // every IR template of the skill compiles
  const skill = fs.readFileSync(path.join(ROOT, ".opencode/skills/archify/SKILL.md"), "utf8")
  const blocks = [...skill.matchAll(/### (\w+)[^\n]*\n```json\n([\s\S]*?)\n```/g)]
  check(blocks.length === 5, `skill has 5 IR templates (${blocks.map((b) => b[1]).join(", ")})`)
  for (const [, type, json] of blocks) {
    const t0 = Date.now()
    const r = await compileDiagram(type, JSON.parse(json), { lang: "vi" })
    check(r.ok && r.svg.length > 5000 && r.width > 200 && r.height > 150, `skill template ${type} compiles (${r.ok ? `${r.width}×${r.height}, ${r.checks.passed}/${r.checks.total} checks` : r.errors?.[0]}; ${Date.now() - t0} ms)`)
    if (r.ok) check(!/<script|https?:\/\/(?!www\.w3\.org)/i.test(r.svg) && /svg\[data-theme="dark"\]/.test(r.svg), `  ${type}: standalone dual-theme SVG, no script / external reference`)
  }
  // the "natural" graph shape models write (seen in a live Qwen run): lanes with title, nodes with actor / subtitle /
  // multi-line labels, no columns, two nodes that would collide → mapped + auto-laid-out
  const natural = { meta: { theme: "x" }, lanes: [{ id: "time", title: "Thời hạn", actors: ["A"] }], nodes: [
    { id: "n1", label: "Nộp đơn kiện", subtitle: "Đến DOC và USITC", actor: "Người nộp đơn", type: "start" }, { id: "n2", label: "Kết luận sơ bộ\nthiệt hại", subtitle: "~45 ngày", actor: "USITC" },
    { id: "n3", label: "Kết luận sơ bộ\nvề phá giá", actor: "DOC" }, { id: "n4", label: "Kết luận cuối", actor: "DOC" }, { id: "n5", label: "Cuối cùng thiệt hại", actor: "USITC" },
    { id: "n6", label: "Lệnh thuế", actor: "DOC" }, { id: "n7", label: "Thu thuế", actor: "CBP" }, { id: "n8", label: "Rà soát hàng năm", actor: "DOC" }, { id: "end1", label: "Kết thúc", actor: "USITC", type: "end" }],
    edges: [{ source: "n1", target: "n2" }, { from: "n2", to: "n3", label: "Chấp nhận" }, { from: "n2", to: "end1", label: "Phủ nhận" }, { from: "n3", to: "n4" }, { from: "n4", to: "n5" }, { from: "n5", to: "n6" }, { from: "n6", to: "n7" }, { from: "n7", to: "n8" }, { from: "n8", to: "ghost" }] }
  const nr = await compileDiagram("workflow", natural, { lang: "vi" })
  check(nr.ok && nr.ir.lanes.length === 4 && nr.ir.nodes.every((x) => Number.isInteger(x.col) && x.lane && !x.actor && !x.subtitle), `natural graph shape → lanes from actors, auto columns (${nr.ok ? `${nr.width}×${nr.height}; ${nr.notes.join("; ")}` : nr.errors?.[0]})`)
  // the tool itself: files + marker
  const wf = JSON.parse(blocks.find((b) => b[1] === "workflow")[2])
  const res = await create.execute({ type: "workflow", ir: JSON.stringify(wf), title: "Thủ tục khởi kiện (thử)", lang: "vi", caption: "thử" }, ctx("vis-test-diagram"))
  const id = idOf(res.output)
  check(!!id && res.metadata?.ui?.visual?.id === id && res.metadata.ui.res?.t === "title", "diagram_create returns [[diagram:<id>]] + metadata.ui")
  if (id) {
    const m = metaOf("vis-test-diagram", id)
    const roles = m.files.map((f) => f.role).sort().join(",")
    check(roles === "ir,png-dark,png-light,svg", `stored files: ${roles}`)
    const png = fs.readFileSync(path.join(OUT, "vis-test-diagram", "visuals", m.files.find((f) => f.role === "png-light").name))
    check(png.subarray(1, 4).toString() === "PNG" && png.length > 20_000, `PNG export (${Math.round(png.length / 1024)} KB)`)
    check(m.kind === "diagram" && m.diagram_type === "workflow" && m.checks?.passed === m.checks?.total, "metadata: kind, type, layout checks")
  }
  // errors go back to the model with the compiler's hint
  const err = await create.execute({ type: "workflow", ir: { lanes: [], nodes: [], edges: [{ from: "a", to: "b" }] }, title: "Lỗi" }, ctx("vis-test-diagram"))
  check(/^Lỗi – CHƯA tạo sơ đồ/.test(err.output) && /mermaid/.test(err.output) && err.metadata?.ui?.res?.t === "error", "invalid IR → error text for the model (retry / mermaid fallback)")
  // the renderer child process cannot reach the network or spawn processes
  const probe = path.join(OUT, "netblock-probe.mjs")
  fs.writeFileSync(probe, 'import https from "node:https"; import { lookup } from "node:dns/promises"; import cp from "node:child_process"; const r = []; for (const f of [() => fetch("https://example.com"), () => https.get("https://example.com"), () => lookup("example.com"), () => cp.spawnSync("cmd")]) { try { await f(); r.push("open") } catch (e) { r.push(/archify sandbox/.test(e.message) ? "blocked" : "other:" + e.message) } } console.log(r.join(","))')
  const pr = spawnSync(process.execPath, [`--import=${pathToFileURL(path.join(ROOT, ".opencode/lib/archify-netblock.mjs")).href}`, probe], { encoding: "utf8" })
  check(pr.stdout.trim() === "blocked,blocked,blocked,blocked", `renderer sandbox blocks fetch / https / dns / child_process (${pr.stdout.trim() || pr.stderr.slice(0, 120)})`)
  // vendored package: no install scripts, no runtime deps, update checker not shipped
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, ".opencode/vendor/archify/package.json"), "utf8"))
  check(!pkg.dependencies && !pkg.scripts?.postinstall && !pkg.scripts?.install && !fs.existsSync(path.join(ROOT, ".opencode/vendor/archify/scripts/check-update.mjs")), "vendor: no runtime deps / install hooks; network update checker not vendored")
}

if (ONLY.has("image")) {
  console.log("image_search / image_fetch")
  const im = await import("../.opencode/tools/image.ts")
  const src = await import("../.opencode/lib/image-sources.ts")
  // license filter
  for (const [l, ok] of [["CC0", true], ["Public domain", true], ["PD-USGov", true], ["CC BY 4.0", true], ["CC BY-SA 3.0", true], ["CC BY-SA 3.0 IGO", true], ["CC BY-NC 4.0", false], ["CC BY-ND 2.0", false], ["CC BY-NC-SA 4.0", false], ["GFDL", false], ["Fair use", false], ["", false], ["Copyrighted free use", false]])
    check(src.licenseOk(l) === ok, `license "${l}" → ${ok ? "allowed" : "rejected"}`)
  check(!src.licenseOk("CC BY 4.0", "true"), "NonFree flag rejects even a CC license")
  // real Commons search: every result has an allowed license
  const s = await im.search.execute({ query: "World Trade Organization headquarters Geneva", sources: ["commons"] }, ctx("vis-test-image"))
  const lic = [...String(s.output).matchAll(/ – ([^–\n]+?) – \d+×\d+/g)].map((m) => m[1].trim())
  check(lic.length >= 2 && lic.every((l) => src.licenseOk(l)), `real Commons results all free-licensed (${lic.slice(0, 5).join("; ")})`)
  const files = await src.commonsSearch("customs declaration form", 12)
  check(files.files.every((f) => src.licenseOk(f.license) && f.author && f.page.startsWith("https://commons.wikimedia.org/")), `commonsSearch: ${files.files.length} kept, ${files.rejected} rejected by license / format`)
  // fetch one: re-encoded WebP ≤ 1600 px, attribution recorded
  const url = String(s.output).match(/url: (https:\/\/commons\.wikimedia\.org\/wiki\/File:\S+)/)?.[1]
  const f = await im.fetch.execute({ url, caption: "Trụ sở WTO (thử)", lang: "vi" }, ctx("vis-test-image"))
  const id = idOf(f.output)
  check(!!id && /\n\*Ảnh: .+ – .+, nguồn commons\.wikimedia\.org\*$/.test(f.output), "image_fetch → ![caption](visual:<id>) + credit line") // i18n-ignore
  if (id) {
    const m = metaOf("vis-test-image", id)
    const b = fs.readFileSync(path.join(OUT, "vis-test-image", "visuals", m.files[0].name))
    check(b.subarray(8, 12).toString() === "WEBP" && Math.max(m.width, m.height) <= 1600, `stored as WebP ${m.width}×${m.height} (${Math.round(b.length / 1024)} KB)`)
    check(!/Exif|XMP|ICC_PROFILE/.test(b.toString("latin1")), "no EXIF / XMP / ICC metadata left")
    check(!!m.attribution?.author && !!m.attribution?.license && /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/.test(m.attribution.source_url), "attribution {title, author, license, license_url, source_url} recorded")
  }
  // allow-list, SSRF, non-image, limits
  const no = async (u, re, what) => { const r = await im.fetch.execute({ url: u }, ctx("vis-test-image")); check(/^Lỗi – CHƯA lưu ảnh/.test(r.output) && re.test(r.output), `${what} → rejected (${String(r.output).slice(15, 110)})`) }
  await no("https://images.unsplash.com/photo-1.jpg", /không thuộc nguồn ảnh được phép/, "stock site")
  await no("https://vnexpress.net/a.jpg", /không thuộc nguồn ảnh được phép/, "news site")
  await no("http://127.0.0.1:3000/api/health", /nội bộ/, "loopback")
  await no("http://192.168.1.10/x.png", /nội bộ/, "private network")
  await no("file:///C:/Windows/win.ini", /http\(s\)/, "file: URL")
  await no("https://commons.wikimedia.org/wiki/File:Mona_Lisa.jpg_that_does_not_exist_zz.jpg", /không tìm thấy|giấy phép/, "unknown Commons file")
  await no("https://www.wto.org/index.htm", /không trả về ảnh|Content-Type|HTTP 4\d\d/, "official page that is not an image")
  // readLimited: > 5 MB stream is cut
  const big = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close() } }))
  let cut = false
  try { await src.readLimited(big) } catch (e) { cut = /quá lớn/.test(e.message) }
  check(cut, "download > 5 MB aborted (streamed)")
  const hdr = new Response("x", { headers: { "content-length": String(9 * 1024 * 1024) } })
  cut = false
  try { await src.readLimited(hdr) } catch (e) { cut = /quá lớn/.test(e.message) }
  check(cut, "Content-Length > 5 MB rejected before reading")
  const { sniffImage } = await import("../.opencode/lib/image-proc.ts")
  check(sniffImage(new TextEncoder().encode("<html><body>not an image</body></html>")) === null && sniffImage(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')) === "svg", "magic-byte sniffing (HTML rejected, SVG recognised)")
}

if (ONLY.has("snapshot")) {
  console.log("source_snapshot")
  const { snapshot } = await import("../.opencode/tools/source.ts")
  const r = await snapshot.execute({ url_or_doc: "https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117", region: "Điều 301", caption: "Điều 301 Luật Thương mại 2005", lang: "vi" }, ctx("vis-test-snap"))
  const id = idOf(r.output)
  check(!!id && /\*Ảnh chụp từ vbpl\.vn/.test(r.output), `vbpl page snapshot + "Ảnh chụp từ" credit`) // i18n-ignore
  if (id) {
    const m = metaOf("vis-test-snap", id)
    check(m.kind === "snapshot" && m.width >= 600 && m.height >= 100 && m.source?.region === "Điều 301", `snapshot ${m.width}×${m.height}, region recorded`)
  }
  const pdf = await snapshot.execute({ url_or_doc: "https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/02/57-nd.signed.pdf", page: 2, lang: "vi" }, ctx("vis-test-snap"))
  check(!!idOf(pdf.output) && /trang 2/.test(pdf.output), "official PDF page 2 snapshot")
  const off = await snapshot.execute({ url_or_doc: "https://vnexpress.net/" }, ctx("vis-test-snap"))
  check(/^Lỗi – CHƯA chụp/.test(off.output) && /không phải tên miền chính thức/.test(off.output), "non-official site refused")
  const loc = await snapshot.execute({ url_or_doc: "http://localhost:3000/" }, ctx("vis-test-snap"))
  check(/^Lỗi – CHƯA chụp/.test(loc.output), "localhost refused")
}

console.log(fails ? `\n${fails} check(s) failed  (outputs: ${OUT})` : `\nall visual tool checks passed  (outputs: ${OUT})`)
process.exit(fails ? 1 : 0)
