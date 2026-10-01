// Writes <file>.br and <file>.gz next to every text asset in client/dist (served by server/compress.mjs).
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { fileURLToPath } from "node:url"

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "dist")
const TEXT = /\.(js|mjs|css|html|svg|json|webmanifest|vtt|txt|xml)$/i
let n = 0
let saved = 0
;(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name)
    if (f.isDirectory()) {
      if (f.name !== "_site") walk(p)
      continue
    }
    if (!TEXT.test(f.name)) continue
    const buf = fs.readFileSync(p)
    if (buf.length < 1024) continue
    const br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    fs.writeFileSync(p + ".br", br)
    fs.writeFileSync(p + ".gz", zlib.gzipSync(buf, { level: 9 }))
    n++
    saved += buf.length - br.length
  }
})(dist)
console.log(`precompressed ${n} files (brotli saves ${(saved / 1024).toFixed(0)} KB)`)
