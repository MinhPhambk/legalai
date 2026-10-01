// Where images for answers may come from (image_search / image_fetch / source_snapshot) – and nowhere else:
//   (a) official domains of ../lib/official-sources.ts (gov.vn, WTO, EU, USITC, …) – license: reuse terms of the
//       issuing body, credited to that body;
//   (b) Wikimedia Commons via its public API – ONLY files whose LicenseShortName is CC0 / public domain / CC BY /
//       CC BY-SA (never NC / ND / GFDL-only / fair use / "NonFree"); author + license read from extmetadata.
// No stock-photo sites, no news sites, no search-engine thumbnails. Downloads go through the polite limiter,
// are capped at 5 MB, must sniff as an image, follow ≤ 3 redirects re-checked against the allow-list, and never
// reach private / loopback addresses. Imported by tool files only – this file exports no tools.
import { polite } from "./polite.ts"
import { officialOf } from "./official-sources.ts"
import { sniffImage } from "./image-proc.ts"

export const UA = "LegalAI-FTU-TechLab/1.0 (legal research assistant; image attribution bot)"
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const COMMONS_API = "https://commons.wikimedia.org/w/api.php"
const COMMONS_HOSTS = new Set(["commons.wikimedia.org", "upload.wikimedia.org", "thumb.wikimedia.org"])

export class ImageError extends Error {}

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*|\[?fe80:.*)$|\.local$|\.internal$|\.lan$|^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./i
export function parsePublicUrl(raw: string): URL {
  let u: URL
  try { u = new URL(String(raw ?? "").trim()) } catch { throw new ImageError(`link không hợp lệ "${String(raw).slice(0, 120)}"`) }
  if (!/^https?:$/.test(u.protocol)) throw new ImageError("chỉ nhận link http(s)")
  if (u.username || u.password) throw new ImageError("link không được chứa thông tin đăng nhập")
  if (PRIVATE_HOST.test(u.hostname) || /^\d+$/.test(u.hostname)) throw new ImageError("không tải từ địa chỉ nội bộ")
  return u
}
export const isCommonsHost = (h: string) => COMMONS_HOSTS.has(h.toLowerCase())
/** "official" (with the body's label) | "commons" | null (not allowed). */
export function sourceKind(u: URL): { kind: "official"; label: string; domain: string } | { kind: "commons" } | null {
  if (isCommonsHost(u.hostname)) return { kind: "commons" }
  const o = officialOf(u.hostname)
  return o ? { kind: "official", label: o.label, domain: o.domain } : null
}

// ---------------------------------------------------------------- licenses
const FREE_LICENSE = /^(cc0(\s+1\.0)?|cc[- ]zero|public domain|pd(-[\w.-]+)?|pdm(-owner)?|cc[ -]by(-sa)?[ -]\d(\.\d)?(\s+[a-z-]{2,10})?|cc[ -]by(-sa)?)$/i
const NON_FREE = /\b(nc|nd|non[- ]?commercial|no[- ]?deriv|fair use|gfdl|copyrighted|all rights reserved)\b/i
/** Is a Commons LicenseShortName one we accept (CC0 / PD / CC BY / CC BY-SA)? */
export function licenseOk(short: string, nonFree?: string): boolean {
  const s = String(short ?? "").replace(/\s+/g, " ").trim()
  if (!s || NON_FREE.test(s) || /^(true|1)$/i.test(String(nonFree ?? ""))) return false
  return FREE_LICENSE.test(s)
}
export const stripHtml = (s: string) =>
  String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim()

export type CommonsFile = {
  title: string // "File:….jpg"
  page: string // https://commons.wikimedia.org/wiki/File:…
  thumb: string
  width: number
  height: number
  mime: string
  bytes: number
  license: string
  license_url?: string
  author: string
  attribution_required: boolean
  description: string
  restrictions: string
}

async function commonsApi(params: Record<string, string>): Promise<any> {
  const u = new URL(COMMONS_API)
  for (const [k, v] of Object.entries({ action: "query", format: "json", formatversion: "2", ...params })) u.searchParams.set(k, v)
  return polite("commons.wikimedia.org", async () => {
    const r = await fetch(u, { headers: { "User-Agent": UA, "Api-User-Agent": UA }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new ImageError(`Wikimedia Commons trả HTTP ${r.status}`)
    return r.json()
  }, { concurrency: 1, gapMs: 1000 })
}
const cleanUrl = (s: string) => { try { const u = new URL(s); for (const k of [...u.searchParams.keys()]) if (/^utm_/.test(k)) u.searchParams.delete(k); return u.href } catch { return s } }
function toFile(p: any): CommonsFile | null {
  const ii = p?.imageinfo?.[0]
  if (!ii) return null
  const em = ii.extmetadata ?? {}
  const v = (k: string) => String(em[k]?.value ?? "")
  return {
    title: String(p.title), page: cleanUrl(ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, "_"))}`),
    thumb: cleanUrl(ii.thumburl || ii.url), width: Math.min(Number(ii.thumbwidth || ii.width) || 0, Number(ii.width) || Infinity), height: Math.min(Number(ii.thumbheight || ii.height) || 0, Number(ii.height) || Infinity),
    mime: String(ii.mime ?? ""), bytes: Number(ii.size) || 0,
    license: stripHtml(v("LicenseShortName")), license_url: stripHtml(v("LicenseUrl")) || undefined,
    author: shortAuthor(stripHtml(v("Artist"))) || "không rõ tác giả",
    attribution_required: !/^false$/i.test(v("AttributionRequired")),
    description: stripHtml(v("ImageDescription")).slice(0, 300),
    restrictions: stripHtml(v("Restrictions")).slice(0, 120),
    ...(/^(true|1)$/i.test(v("NonFree")) ? { nonFree: true } : {}),
  } as CommonsFile
}
/** Commons "Artist" fields can be long (Library of Congress records: "X. Related names: …") – keep the author proper. */
export function shortAuthor(s: string): string {
  let a = String(s ?? "").split(/\s+(?:Related names?|Other names?|Contributors?|Photograph(?:ed)? by)\s*:/i)[0].replace(/\s*\((?:talk|contribs)[^)]*\)/gi, "").trim()
  if (a.length > 90) { const cut = a.slice(0, 90); a = cut.slice(0, Math.max(cut.lastIndexOf(","), cut.lastIndexOf(" "), 40)).trim() + "…" }
  return a
}
const IIPROPS = { prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1600", iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|AttributionRequired|Restrictions|ImageDescription|NonFree" }
const OK_MIME = /^image\/(jpeg|png|gif|webp|svg\+xml|tiff)$/

/** Commons search (file namespace) → only freely licensed raster / SVG files, best first. */
export async function commonsSearch(query: string, limit = 8): Promise<{ files: CommonsFile[]; rejected: number }> {
  const j = await commonsApi({ generator: "search", gsrnamespace: "6", gsrsearch: `${query} filetype:bitmap|drawing`, gsrlimit: "30", ...IIPROPS })
  const pages = (j?.query?.pages ?? []).sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
  const files: CommonsFile[] = []
  let rejected = 0
  for (const p of pages) {
    const f = toFile(p)
    if (!f || !OK_MIME.test(f.mime) || !licenseOk(f.license, (f as any).nonFree ? "true" : "")) { rejected++; continue }
    files.push(f)
    if (files.length >= limit) break
  }
  return { files, rejected }
}

/** The Commons file behind a File: page / upload.wikimedia.org / thumb URL (metadata re-read from the API). */
export async function commonsFileOf(u: URL): Promise<CommonsFile> {
  let title = ""
  const path = decodeURIComponent(u.pathname)
  if (u.hostname === "commons.wikimedia.org") title = path.match(/\/wiki\/(File:.+)$/i)?.[1] ?? u.searchParams.get("title") ?? ""
  else {
    // /wikipedia/commons/a/ab/Name.jpg  |  /wikipedia/commons/thumb/a/ab/Name.jpg/800px-Name.jpg
    const m = path.match(/\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/i)
    if (m) title = `File:${m[1]}`
  }
  if (!/^File:.{3,240}$/i.test(title)) throw new ImageError("không nhận ra tệp Wikimedia Commons trong link (cần link trang File:… hoặc upload.wikimedia.org)")
  const j = await commonsApi({ titles: title.replace(/_/g, " "), ...IIPROPS })
  const f = toFile(j?.query?.pages?.[0])
  if (!f) throw new ImageError(`không tìm thấy tệp ${title} trên Wikimedia Commons`)
  if (!licenseOk(f.license, (f as any).nonFree ? "true" : "")) throw new ImageError(`giấy phép của ${f.title} là "${f.license || "không rõ"}" – chỉ dùng ảnh CC0 / public domain / CC BY / CC BY-SA`)
  if (!OK_MIME.test(f.mime)) throw new ImageError(`định dạng ${f.mime} không hỗ trợ`)
  return f
}

// ---------------------------------------------------------------- limited download
/** Read a fetch body up to `max` bytes (throws beyond). */
export async function readLimited(res: Response, max = MAX_IMAGE_BYTES): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? 0)
  if (len > max) throw new ImageError(`ảnh quá lớn (${Math.round(len / 1024)} KB > ${Math.round(max / 1024)} KB)`)
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(await res.arrayBuffer()).slice(0, max + 1)
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) { await reader.cancel().catch(() => {}); throw new ImageError(`ảnh quá lớn (> ${Math.round(max / 1024)} KB)`) }
    chunks.push(value)
  }
  const out = new Uint8Array(n)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/** Download an image from an allowed host (redirects re-checked), ≤ 5 MB, image/* + magic bytes. */
export async function downloadImage(raw: string, allowed: (u: URL) => boolean, opts: { referer?: string } = {}): Promise<{ bytes: Uint8Array; finalUrl: string; contentType: string }> {
  let u = parsePublicUrl(raw)
  for (let hop = 0; hop < 4; hop++) {
    if (!allowed(u)) throw new ImageError(`${u.hostname} không thuộc nguồn ảnh được phép (tên miền chính thức hoặc Wikimedia Commons)`)
    const res: Response = await polite(u.hostname, () => fetch(u, { redirect: "manual", headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml;q=0.8", ...(opts.referer ? { Referer: opts.referer } : {}) }, signal: AbortSignal.timeout(30_000) }), { gapMs: 1000 })
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = parsePublicUrl(new URL(res.headers.get("location")!, u).href)
      continue
    }
    if (!res.ok) throw new ImageError(`tải ảnh lỗi HTTP ${res.status}`)
    const ct = String(res.headers.get("content-type") ?? "").toLowerCase()
    if (!/^image\//.test(ct)) throw new ImageError(`link không trả về ảnh (Content-Type: ${ct.split(";")[0] || "không rõ"})`)
    const bytes = await readLimited(res)
    if (!sniffImage(bytes)) throw new ImageError("nội dung tải về không phải ảnh PNG / JPEG / GIF / WebP / SVG")
    return { bytes, finalUrl: u.href, contentType: ct }
  }
  throw new ImageError("chuyển hướng quá nhiều lần")
}

export const today = () => new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" })
export const creditLine = (lang: "vi" | "en", author: string, license: string, domain: string) =>
  lang === "en" ? `Image: ${author} – ${license}, source ${domain}` : `Ảnh: ${author} – ${license}, nguồn ${domain}`
export const officialLicense = (lang: "vi" | "en") => (lang === "en" ? "official source (reuse terms of the issuing body)" : "nguồn chính thức (điều kiện sử dụng lại theo cơ quan ban hành)")
