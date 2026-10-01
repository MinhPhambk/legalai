// Encodes the recorded screencast (video/frames + frames.json + marks.json) into the demo video:
// time-warped (waiting / typing parts sped up), 30 fps, H.264 MP4 (+faststart) and VP9 WebM, poster JPG,
// WebVTT captions vi/en (texts = landing.demo.transcript in the locale files) and video-meta.json.
// Uses ffmpeg-static from web/node_modules (no global ffmpeg).
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const WEB = "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/web"
const FF = path.join(WEB, "node_modules/ffmpeg-static/ffmpeg.exe")
const H = process.env.HARNESS_DIR || "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox/demo-harness" 
const V = path.join(H, "video")
const OUT = path.join(WEB, "client/public/media")
const frames = JSON.parse(fs.readFileSync(path.join(V, "frames.json"), "utf8"))
const marks = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(V, "marks.json"), "utf8")).map((m) => [m.id, m.t]))
const DICT = { vi: JSON.parse(fs.readFileSync(path.join(WEB, "client/src/locales/vi.json"), "utf8")), en: JSON.parse(fs.readFileSync(path.join(WEB, "client/src/locales/en.json"), "utf8")) }

// Speed per recorded interval (ms): typing and waiting sped up; reading moments kept at 1×.
const SPEED = [
  [marks.landing, marks.login, 1.15],
  [marks.login, marks.ask, 1.6],
  [marks.ask, marks.steps, 1.4],
  [marks.steps, marks.answer, 1.8],
  [marks.draft, marks.doccard, 2.4],
  [marks.english, marks.escalate, 1.35],
  [marks.escalate, marks.escalate + 9000, 1.5],
]
const speedAt = (t) => SPEED.find(([a, b]) => t >= a && t < b)?.[2] || 1
/** recorded ms → output ms */
function warp(t) {
  let out = 0
  let cur = 0
  const bps = [...new Set([0, t, ...SPEED.flatMap(([a, b]) => [a, b])])].filter((x) => x <= t).sort((x, y) => x - y)
  for (const bp of bps) {
    if (bp <= cur) continue
    out += (bp - cur) / speedAt(cur)
    cur = bp
  }
  return out
}

// ---- concat list with per-frame durations --------------------------------------------------------------
const end = marks.stop
let list = "ffconcat version 1.0\n"
for (let i = 0; i < frames.length; i++) {
  const a = frames[i].t
  const b = i + 1 < frames.length ? frames[i + 1].t : end
  const d = Math.max(0.001, (warp(b) - warp(a)) / 1000)
  list += `file 'frames/${frames[i].file}'\nduration ${d.toFixed(4)}\n`
}
list += `file 'frames/${frames.at(-1).file}'\n`
fs.writeFileSync(path.join(V, "list.ffconcat"), list)
const total = warp(end) / 1000
console.log("output duration", total.toFixed(1), "s")

const run = (args) => execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: V, stdio: "inherit" })
const vf = "fps=30,scale=1280:720:flags=lanczos,format=yuv420p"
run(["-f", "concat", "-safe", "0", "-i", "list.ffconcat", "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-profile:v", "high", "-movflags", "+faststart", "-an", path.join(OUT, "legalai-demo.mp4")])
run(["-f", "concat", "-safe", "0", "-i", "list.ffconcat", "-vf", vf, "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", path.join(OUT, "legalai-demo.webm")])
// Poster: the answer with the citation card open.
const posterT = warp(marks.answer + 6500) / 1000
run(["-ss", posterT.toFixed(2), "-i", path.join(OUT, "legalai-demo.mp4"), "-frames:v", "1", "-q:v", "3", path.join(OUT, "legalai-demo-poster.jpg")])

// ---- captions ---------------------------------------------------------------------------------------------
const ORDER = ["landing", "login", "ask", "steps", "answer", "draft", "doccard", "versions", "diff", "english", "escalate", "end", "stop"]
const ts = (ms) => {
  const s = Math.max(0, ms) / 1000
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0")}`
}
for (const l of ["vi", "en"]) {
  let vtt = "WEBVTT\n\n"
  for (let i = 0; i < ORDER.length - 1; i++) {
    const a = warp(i === 0 ? 0 : marks[ORDER[i]])
    const b = warp(marks[ORDER[i + 1]]) - 80
    vtt += `${i + 1}\n${ts(a)} --> ${ts(b)} line:88% position:50% align:center\n${DICT[l].landing.demo.transcript[`t${i + 1}`]}\n\n`
  }
  fs.writeFileSync(path.join(OUT, `legalai-demo.${l}.vtt`), vtt)
}
const iso = `PT${Math.floor(total / 60)}M${Math.round(total % 60)}S`
fs.writeFileSync(path.join(OUT, "video-meta.json"), JSON.stringify({ duration: iso, seconds: Math.round(total), uploadDate: "2026-09-26", width: 1280, height: 720 }, null, 2) + "\n")
for (const f of ["legalai-demo.mp4", "legalai-demo.webm", "legalai-demo-poster.jpg"]) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2), "MB")
