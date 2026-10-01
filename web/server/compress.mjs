// Compression without extra dependencies:
//  - static text assets are precompressed at build time (scripts/precompress.mjs → <file>.br / .gz) and
//    served here when the browser accepts them;
//  - dynamic HTML (the prerendered site pages) is compressed in memory (small, cached per variant).
// The API / SSE streams are never compressed here (the tunnel may still compress at the edge).
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

const TEXT = /\.(js|mjs|css|html|svg|json|webmanifest|vtt|txt|xml)$/i
export const pickEncoding = (req) => {
  const ae = String(req.headers["accept-encoding"] || "")
  return /\bbr\b/.test(ae) ? "br" : /\bgzip\b/.test(ae) ? "gzip" : null
}

/** Serves <file>.br / <file>.gz from `root` for text assets; `cacheFor(urlPath)` → Cache-Control value. */
export function precompressed(root, cacheFor) {
  const base = path.resolve(root)
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next()
    let p
    try {
      p = decodeURIComponent(req.path)
    } catch {
      return next()
    }
    if (!TEXT.test(p) || p.startsWith("/_site/")) return next()
    const enc = pickEncoding(req)
    if (!enc) return next()
    const file = path.resolve(base, "." + p)
    if (!file.startsWith(base + path.sep)) return next()
    const cf = file + (enc === "br" ? ".br" : ".gz")
    fs.stat(cf, (err, st) => {
      if (err || !st.isFile()) return next()
      res.setHeader("Content-Encoding", enc)
      res.setHeader("Vary", "Accept-Encoding")
      res.setHeader("Content-Length", st.size)
      res.setHeader("Cache-Control", cacheFor(p))
      res.type(path.extname(file))
      if (req.method === "HEAD") return res.end()
      fs.createReadStream(cf).pipe(res)
    })
  }
}

const memo = new Map()
/** Sends an HTML string compressed for the client (cached by `key`). */
export function sendHtml(req, res, html, key) {
  const enc = pickEncoding(req)
  res.setHeader("Vary", "Accept-Encoding, Cookie")
  res.type("html")
  if (!enc) return res.send(html)
  const k = `${enc}|${key}|${html.length}`
  let buf = memo.get(k)
  if (!buf) {
    buf = enc === "br" ? zlib.brotliCompressSync(html, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : zlib.gzipSync(html, { level: 9 })
    memo.set(k, buf)
    if (memo.size > 200) memo.delete(memo.keys().next().value)
  }
  res.setHeader("Content-Encoding", enc)
  res.send(buf)
}
