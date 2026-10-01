// 480 px wide variants of the landing crops (srcset) and a WebP poster, with ffmpeg-static.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const FF = path.join(web, "node_modules/ffmpeg-static/ffmpeg.exe")
const M = path.join(web, "client/public/media")
const ff = (args) => execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: M })
for (const f of fs.readdirSync(M).filter((f) => /^crop-.*-(light|dark)\.webp$/.test(f))) ff(["-i", f, "-vf", "scale=480:-2:flags=lanczos", "-c:v", "libwebp", "-quality", "80", f.replace(/\.webp$/, "-480.webp")])
if (fs.existsSync(path.join(M, "legalai-demo-poster.jpg"))) ff(["-i", "legalai-demo-poster.jpg", "-c:v", "libwebp", "-quality", "72", "legalai-demo-poster.webp"])
console.log("media variants written")
for (const t of ["light", "dark"]) if (fs.existsSync(path.join(M, `shot-mobile-answer-${t}.webp`))) ff(["-i", `shot-mobile-answer-${t}.webp`, "-vf", "scale=660:-2:flags=lanczos", "-c:v", "libwebp", "-quality", "70", `shot-mobile-answer-${t}-660.webp`])
