// Image processing for visuals (diagram_create / image_fetch / source_snapshot) in the SANDBOX Chrome (127.0.0.1:
// CHROME_PORT, the same browser the lookup tools use) – no native addons, no Python. Every page opened here is an
// about:blank page with request interception that ABORTS every request except data: / blob: / about: URLs, so
// nothing rendered here can reach the network (no hotlinking, no tracking pixels, no web fonts).
//   reencodeImage – decode untrusted bytes as an <img> (scripts never run in image context, SVG included), draw on a
//                   canvas ≤ maxDim px and export WebP (or PNG): drops EXIF / XMP / ICC metadata and any payload.
//   svgToPng      – raster export of a diagram SVG in a given theme.
// Imported by tool files only – this file exports no tools.
import puppeteer from "puppeteer-core"

const PORT = () => process.env.CHROME_PORT ?? "9333"

export async function withOfflinePage<T>(fn: (page: any) => Promise<T>, opts: { allowNetwork?: (url: string) => boolean } = {}): Promise<T> {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT()}`, defaultViewport: null })
  const page = await browser.newPage()
  try {
    await page.setRequestInterception(true)
    page.on("request", (r: any) => {
      const u = String(r.url())
      if (/^(data|blob|about):/i.test(u) || opts.allowNetwork?.(u)) r.continue().catch(() => {})
      else r.abort("blockedbyclient").catch(() => {})
    })
    return await fn(page)
  } finally {
    await page.close().catch(() => {})
    browser.disconnect()
  }
}

/** Sniff an image format from magic bytes (never trust the Content-Type alone). */
export function sniffImage(b: Uint8Array): "png" | "jpeg" | "gif" | "webp" | "svg" | null {
  if (b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp"
  const head = Buffer.from(b.subarray(0, 2048)).toString("utf8").replace(/^﻿/, "").trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg"
  return null
}
const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" } as const

export type Encoded = { data: Buffer; format: "webp" | "png"; width: number; height: number; srcWidth: number; srcHeight: number }

/** Decode + downscale (≤ maxDim on the longer side) + re-encode; throws on undecodable input. */
export async function reencodeImage(bytes: Uint8Array, opts: { maxDim?: number; format?: "webp" | "png"; quality?: number } = {}): Promise<Encoded> {
  const kind = sniffImage(bytes)
  if (!kind) throw new Error("tệp không phải ảnh PNG / JPEG / GIF / WebP / SVG")
  const maxDim = Math.max(64, Math.min(4096, opts.maxDim ?? 1600))
  const b64 = Buffer.from(bytes).toString("base64")
  const r = await withOfflinePage((page) =>
    page.evaluate(
      async (b64: string, mime: string, maxDim: number, fmt: string, q: number) => {
        const bin = atob(b64)
        const u8 = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([u8], { type: mime }))
        try {
          const img = new Image()
          img.decoding = "async"
          img.src = url
          await img.decode()
          let w = img.naturalWidth || 0, h = img.naturalHeight || 0
          if (!w || !h) { w = 1200; h = 800 } // SVG without intrinsic size
          const s = Math.min(1, maxDim / Math.max(w, h))
          const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s))
          const c = document.createElement("canvas")
          c.width = cw; c.height = ch
          const g = c.getContext("2d")!
          g.imageSmoothingQuality = "high"
          g.drawImage(img, 0, 0, cw, ch)
          let out = c.toDataURL(fmt === "png" ? "image/png" : "image/webp", q)
          if (fmt !== "png" && !out.startsWith("data:image/webp")) out = c.toDataURL("image/png")
          return { out, w: cw, h: ch, sw: w, sh: h }
        } finally { URL.revokeObjectURL(url) }
      },
      b64, MIME[kind], maxDim, opts.format ?? "webp", opts.quality ?? 0.86,
    ),
  )
  const m = String(r.out).match(/^data:image\/(webp|png);base64,(.*)$/)
  if (!m) throw new Error("không mã hoá lại được ảnh")
  return { data: Buffer.from(m[2], "base64"), format: m[1] as "webp" | "png", width: r.w, height: r.h, srcWidth: r.sw, srcHeight: r.sh }
}

/** PNG of a (dual-theme) diagram SVG with data-theme set; scale 2 (capped to ~4000 px on the longer side). */
export async function svgToPng(svg: string, theme: "light" | "dark", width: number, height: number): Promise<Buffer> {
  const scale = Math.max(1, Math.min(2, 4000 / Math.max(width, height)))
  const themed = svg.replace(/^<svg\b/, `<svg data-theme="${theme}"`)
  return withOfflinePage(async (page) => {
    await page.setViewport({ width: Math.ceil(width), height: Math.ceil(height), deviceScaleFactor: scale })
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style></head><body>${themed}</body></html>`, { waitUntil: "load" })
    const el = await page.$("svg")
    return Buffer.from(await el.screenshot({ type: "png", omitBackground: true }))
  })
}

