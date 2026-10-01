// image_search / image_fetch: images for answers ONLY from official domains (../lib/official-sources.ts) and freely
// licensed Wikimedia Commons files (CC0 / PD / CC BY / CC BY-SA) – see ../lib/image-sources.ts. image_fetch stores a
// re-encoded copy (WebP ≤ 1600 px, metadata stripped, ../lib/image-proc.ts) as a visual of the session with its
// attribution, and returns a markdown snippet `![caption](visual:<id>)` + credit line for the answer. No stock or
// news images, never a hotlink: the web UI only shows images served by our own endpoints.
import puppeteer from "puppeteer-core"
import { tool, withUi, count, textOf } from "../lib/ui-meta.ts"
import { throttle } from "../lib/polite.ts"
import { officialOf } from "../lib/official-sources.ts"
import { reencodeImage } from "../lib/image-proc.ts"
import { imageSnippet, saveVisual } from "../lib/visual-store.ts"
import {
  ImageError, commonsFileOf, commonsSearch, creditLine, downloadImage, isCommonsHost, officialLicense, parsePublicUrl, sourceKind, stripHtml, today,
} from "../lib/image-sources.ts"

const PORT = process.env.CHROME_PORT ?? "9333"
async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const page = await browser.newPage()
  try { return await fn(page) } finally { await page.close().catch(() => {}); browser.disconnect() }
}
type Found = { url: string; page: string; title: string; width?: number; height?: number; domain: string; label: string }
const LOGO_RE = /logo|icon|favicon|banner|avatar|sprite|button|btn|arrow|social|facebook|twitter|youtube|zalo|qr[-_]?code|loading|spacer|blank/i

/** <img> of an official page (≥ 240×160 rendered, same official body, no logos / icons). */
async function imagesOnPage(pageUrl: URL): Promise<Found[]> {
  const off = officialOf(pageUrl.hostname)
  if (!off) throw new ImageError(`${pageUrl.hostname} không phải tên miền chính thức`)
  return withPage(async (page) => {
    await throttle(pageUrl.hostname, { gapMs: 1100 })
    await page.goto(pageUrl.href, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await new Promise((r) => setTimeout(r, 1500))
    const final = new URL(page.url())
    if (!officialOf(final.hostname)) throw new ImageError(`trang chuyển sang ${final.hostname} (không chính thức)`)
    const imgs: { src: string; alt: string; w: number; h: number; fig: string }[] = await page.evaluate(() =>
      [...document.querySelectorAll("img")].map((i) => ({
        src: (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src, alt: (i as HTMLImageElement).alt || (i as HTMLImageElement).title || "",
        w: (i as HTMLImageElement).naturalWidth, h: (i as HTMLImageElement).naturalHeight,
        fig: (i.closest("figure")?.querySelector("figcaption") as HTMLElement | null)?.innerText || "",
      })))
    const seen = new Set<string>()
    const out: Found[] = []
    for (const i of imgs) {
      let u: URL
      try { u = new URL(i.src) } catch { continue }
      if (!/^https?:$/.test(u.protocol) || seen.has(u.href) || i.w < 240 || i.h < 160 || LOGO_RE.test(u.pathname + " " + i.alt)) continue
      const o = officialOf(u.hostname)
      if (!o) continue
      seen.add(u.href)
      out.push({ url: u.href, page: final.href, title: (i.fig || i.alt).replace(/\s+/g, " ").trim().slice(0, 160), width: i.w, height: i.h, domain: o.domain, label: o.label })
      if (out.length >= 10) break
    }
    return out
  })
}

/** Official images for a query: web_search (official domains only) → the content images of the top official HTML
 *  pages (≤ 3 pages). No image search engine: every image found sits on an official page we can cite. */
async function officialSearch(query: string, lang: "vi" | "en"): Promise<Found[]> {
  const { search: webSearch } = await import("./web.ts")
  const text = textOf(await webSearch.execute({ query, lang, limit: 8 }, { sessionID: undefined } as any))
  const pages = [...text.matchAll(/\[CHÍNH THỨC[^\]]*\][^\n]*\n\s+(https?:\/\/\S+)/g)].map((m) => m[1]).filter((u) => !/\.(pdf|docx?|xlsx?)(\?|$)/i.test(u)).slice(0, 3)
  const out: Found[] = []
  for (const p of pages) {
    try { for (const f of await imagesOnPage(new URL(p))) if (!out.some((x) => x.url === f.url)) out.push(f) } catch { /* next page */ }
    if (out.length >= 8) break
  }
  return out.slice(0, 8)
}

export const search = tool({
  description:
    "TÌM ẢNH minh hoạ cho câu trả lời – CHỈ từ (a) tên miền CHÍNH THỨC (gov.vn, WTO, EU, USITC, Federal Register…) và (b) Wikimedia Commons với giấy phép tự do (CC0 / public domain / CC BY / CC BY-SA, công cụ tự lọc). Không có ảnh stock, ảnh báo chí. Dùng khi một ảnh THẬT SỰ giúp hiểu (trụ sở / con dấu / mẫu biểu chính thức, bản đồ, sơ đồ của cơ quan ban hành) – không dùng ảnh trang trí. Muốn lấy ảnh trên một trang chính thức đã đọc: truyền page_url. Sau đó gọi image_fetch(url) với ảnh đã chọn. Muốn cho người dùng xem NGUYÊN BẢN văn bản / bảng thuế → source_snapshot.",
  args: {
    query: tool.schema.string().describe("Từ khoá mô tả ảnh (tiếng Anh cho Commons thường nhiều kết quả hơn), VD 'United States International Trade Commission building'"),
    sources: tool.schema.array(tool.schema.enum(["official", "commons"])).optional().describe("Nguồn cần tìm (mặc định cả hai: official trước, commons sau)"),
    lang: tool.schema.enum(["vi", "en"]).optional().describe("Ngôn ngữ câu trả lời (chọn nhóm tên miền chính thức: vi = cơ quan Việt Nam, en = quốc tế)"),
    page_url: tool.schema.string().optional().describe("Tuỳ chọn: link một trang CHÍNH THỨC – liệt kê các ảnh nội dung trên trang đó (bỏ logo / biểu tượng)"),
  },
  async execute({ query, sources, lang, page_url }) {
    const l = lang === "en" ? "en" : "vi"
    const want = sources?.length ? sources : ["official", "commons"]
    const lines: string[] = []
    const notes: string[] = []
    let n = 0
    if (want.includes("official")) {
      try {
        const found = page_url ? await imagesOnPage(parsePublicUrl(page_url)) : await officialSearch(query, l)
        if (found.length) lines.push(`NGUỒN CHÍNH THỨC${page_url ? ` (ảnh trên trang ${page_url})` : ""}:`)
        for (const f of found) lines.push(`${++n}. [chính thức – ${f.label}] ${f.title || "(không có mô tả)"}${f.width ? ` – ${f.width}×${f.height}` : ""}\n   url: ${f.url}\n   trang: ${f.page}`)
        if (!found.length) notes.push(page_url ? "Trang chính thức không có ảnh nội dung phù hợp." : "Không thấy ảnh trên tên miền chính thức cho từ khoá này.")
      } catch (e: any) { notes.push(`Nguồn chính thức: ${String(e?.message ?? e).slice(0, 200)}`) }
    }
    if (want.includes("commons")) {
      try {
        const { files, rejected } = await commonsSearch(query, 8)
        if (files.length) lines.push("WIKIMEDIA COMMONS (giấy phép tự do đã kiểm tra):")
        for (const f of files) lines.push(`${++n}. ${f.title.replace(/^File:/, "")} – ${f.author} – ${f.license}${f.restrictions ? ` (hạn chế: ${f.restrictions})` : ""} – ${f.width}×${f.height}${f.description ? `\n   mô tả: ${f.description.slice(0, 160)}` : ""}\n   url: ${f.page}`)
        if (rejected) notes.push(`Đã loại ${rejected} tệp Commons có giấy phép không phù hợp (NC / ND / không rõ) hoặc định dạng không hỗ trợ.`)
        if (!files.length) notes.push("Không có ảnh Commons phù hợp giấy phép cho từ khoá này.")
      } catch (e: any) { notes.push(`Wikimedia Commons: ${String(e?.message ?? e).slice(0, 200)}`) }
    }
    const out = [
      n ? `Tìm thấy ${n} ảnh cho "${query}":` : `Không tìm thấy ảnh phù hợp cho "${query}".`,
      ...lines, ...notes,
      n ? "Chọn ảnh THẬT SỰ minh hoạ cho nội dung (đúng cơ quan / đúng văn bản), gọi image_fetch(url=<url ở trên>). Không dùng ảnh chỉ để trang trí; không có ảnh phù hợp thì bỏ qua." : "Không có ảnh phù hợp: bỏ qua ảnh (có thể dùng sơ đồ diagram_create hoặc source_snapshot trang chính thức).",
    ].join("\n")
    return withUi(out, { res: count(n, "results") })
  },
})

export const fetch = tool({
  description:
    "TẢI một ảnh đã chọn (từ image_search, hoặc link ảnh / trang File: trên Wikimedia Commons, hoặc ảnh trên tên miền chính thức) về kho của cuộc trò chuyện: ≤ 5 MB, chỉ ảnh, mã hoá lại WebP ≤ 1600 px, xoá EXIF; giấy phép Commons được kiểm tra lại (CC0 / PD / CC BY / CC BY-SA). Trả về đoạn markdown `![chú thích](visual:<mã>)` + dòng ghi công – chép NGUYÊN VĂN vào câu trả lời ngay sau đoạn văn mà ảnh minh hoạ. Không bao giờ chèn link ảnh bên ngoài trực tiếp vào câu trả lời.",
  args: {
    url: tool.schema.string().describe("Link ảnh (url từ image_search) hoặc trang https://commons.wikimedia.org/wiki/File:…"),
    caption: tool.schema.string().optional().describe("Chú thích ngắn bằng ngôn ngữ câu trả lời, mô tả ĐÚNG nội dung ảnh (không suy diễn), VD 'Trụ sở Ủy ban Thương mại Quốc tế Hoa Kỳ (USITC), Washington D.C.'"),
    page_url: tool.schema.string().optional().describe("Ảnh chính thức: trang chứa ảnh (ghi nguồn)"),
    lang: tool.schema.enum(["vi", "en"]).optional().describe("Ngôn ngữ câu trả lời (dòng ghi công)"),
  },
  async execute({ url, caption, page_url, lang }, context) {
    const l = lang === "en" ? "en" : "vi"
    try {
      const u = parsePublicUrl(url)
      const src = sourceKind(u)
      if (!src) throw new ImageError(`${u.hostname} không thuộc nguồn ảnh được phép – chỉ tên miền chính thức (gov.vn, WTO, EU, USITC…) hoặc Wikimedia Commons (giấy phép tự do). Không dùng ảnh stock / báo chí`)
      let bytes: Uint8Array, attribution, title: string, sourceUrl: string
      if (src.kind === "commons") {
        const f = await commonsFileOf(u)
        const d = await downloadImage(f.thumb, (x) => isCommonsHost(x.hostname))
        bytes = d.bytes
        title = f.title.replace(/^File:/, "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/_/g, " ")
        sourceUrl = f.page
        attribution = { title, author: f.author, license: f.license, license_url: f.license_url, source_url: f.page, domain: "commons.wikimedia.org", attribution_required: f.attribution_required, credit: creditLine(l, f.author, f.license, "commons.wikimedia.org") }
      } else {
        let referer: string | undefined
        if (page_url) { const p = parsePublicUrl(page_url); if (officialOf(p.hostname)) referer = p.href }
        const d = await downloadImage(u.href, (x) => !!officialOf(x.hostname), { referer })
        bytes = d.bytes
        title = decodeURIComponent(u.pathname.split("/").pop() || src.domain).replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_]+/g, " ").slice(0, 120)
        sourceUrl = referer ?? d.finalUrl
        const host = new URL(d.finalUrl).hostname.replace(/^www\./, "")
        attribution = { title, author: src.label, license: officialLicense(l), source_url: sourceUrl, domain: host, attribution_required: true, credit: creditLine(l, src.label, officialLicense(l), host) }
      }
      const enc = await reencodeImage(bytes, { maxDim: 1600, format: "webp" })
      const meta = saveVisual({
        sessionID: context?.sessionID, kind: "image", title, caption: String(caption ?? "").trim().slice(0, 300) || title, lang: l,
        width: enc.width, height: enc.height, attribution, source: { url: sourceUrl, official: src.kind === "official" ? src.label : undefined },
        blobs: [{ role: "image", format: enc.format, data: enc.data }],
      })
      const out = [
        `Đã lưu ảnh (mã ảnh: ${meta.id}; ${enc.width}×${enc.height}, ${enc.format.toUpperCase()} ${Math.round(enc.data.length / 1024)} KB, đã xoá siêu dữ liệu). Nguồn: ${sourceUrl} – ${attribution.license}${src.kind === "commons" && attribution.attribution_required ? " (bắt buộc ghi công tác giả)" : ""}. Truy cập ${today()}.`,
        "Chép NGUYÊN VĂN hai dòng sau vào câu trả lời, ngay sau đoạn văn mà ảnh minh hoạ (giữ dòng ghi công; không sửa link visual:):",
        imageSnippet(meta),
      ].join("\n")
      return withUi(out, { res: { t: "title", v: meta.caption, lang: l }, visual: { id: meta.id, kind: "image" } })
    } catch (e: any) {
      const msg = e instanceof ImageError ? e.message : `không tải / xử lý được ảnh (${String(e?.message ?? e).slice(0, 200)})`
      return withUi(`Lỗi – CHƯA lưu ảnh: ${msg}. Bỏ qua ảnh này (không chèn link ảnh ngoài vào câu trả lời).`, { res: { t: "error", code: "image_rejected" } })
    }
  },
})
