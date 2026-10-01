// source_snapshot: a screenshot of an OFFICIAL page (vbpl.vn, anle.toaan.gov.vn, a tariff table on customs.gov.vn,
// a Federal Register notice…) or of one page of an official PDF / of a document of this conversation, taken in the
// sandbox Chrome and stored as a visual (WebP ≤ 1600 px) with the credit "Ảnh chụp từ <nguồn>". Lets the answer show
// the ORIGINAL document visually next to the explanation; never used to fake a document.
import puppeteer from "puppeteer-core"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tool, withUi } from "../lib/ui-meta.ts"
import { throttle } from "../lib/polite.ts"
import { officialOf } from "../lib/official-sources.ts"
import { reencodeImage } from "../lib/image-proc.ts"
import { imageSnippet, saveVisual } from "../lib/visual-store.ts"
import { ImageError, parsePublicUrl, today } from "../lib/image-sources.ts"
import { findDocumentForSession, outDir } from "../lib/doc-store.ts"

const PORT = process.env.CHROME_PORT ?? "9333"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const VIEW = { width: 1280, height: 900 }

async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const page = await browser.newPage()
  try { await page.setViewport(VIEW); return await fn(page) } finally { await page.close().catch(() => {}); browser.disconnect() }
}

/** Screenshot of the part of the page the caller asked for: `region` = CSS selector ("css:…") or a text to find. */
async function shootHtml(page: any, region?: string): Promise<Buffer> {
  await page.setViewport({ width: 1280, height: 1600 })
  await page.waitForFunction(() => (document.body?.innerText?.length ?? 0) > 200, { timeout: 12_000 }).catch(() => {})
  await sleep(1200)
  const box = await page.evaluate((region: string) => {
    const pick = (): Element | null => {
      if (region?.startsWith("css:")) return document.querySelector(region.slice(4).trim())
      if (region?.trim()) {
        const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ")
        const want = fold(region.trim())
        let best: HTMLElement | null = null
        // smallest block in the MAIN column (wide elements – skips tables of contents / sidebars) containing the text
        for (const el of document.querySelectorAll("p, li, td, tr, table, h1, h2, h3, h4, h5, div, section, article") as NodeListOf<HTMLElement>) {
          const r = el.getBoundingClientRect()
          if (r.width < 420 || r.height < 8) continue
          const t = fold(el.innerText || "")
          if (t.includes(want) && (!best || best.innerText.length > el.innerText.length)) best = el
        }
        if (!best) return null
        // a heading-like hit (e.g. "Điều 301. …"): extend over the following siblings up to the next heading of the same kind
        if ((best.innerText || "").length < 300 && best.parentElement) {
          const sig = (e: Element) => e.tagName + "." + String((e as HTMLElement).className || "")
          const first = best.getBoundingClientRect()
          let bottom = first.bottom
          for (let s = best.nextElementSibling; s; s = s.nextElementSibling) {
            if (sig(s) === sig(best)) break
            const r = s.getBoundingClientRect()
            if (r.bottom - first.top > 1400) break
            bottom = Math.max(bottom, r.bottom)
          }
          ;(best as any).__clipH = bottom - first.top
        }
        return best
      }
      const cands = [...document.querySelectorAll("article, main, [role=main], #content, .content, .detail, .noidung, .content-detail")] as HTMLElement[]
      return cands.sort((a, b) => (b.innerText?.length ?? 0) - (a.innerText?.length ?? 0))[0] ?? document.body
    }
    const el = pick()
    if (!el) return null
    el.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior })
    const r = el.getBoundingClientRect()
    const h = Math.max(r.height, (el as any).__clipH ?? 0)
    return { x: Math.max(0, r.left + scrollX - 12), y: Math.max(0, r.top + scrollY - 12), w: Math.min(r.width + 24, 1600), h: Math.min(Math.max(h + 24, 120), 1500) }
  }, region ?? "")
  await sleep(300)
  // cookie banners / fixed headers / floating tables of contents would cover the text
  await page.evaluate(() => { for (const el of [...document.querySelectorAll("body *")] as HTMLElement[]) { const p = getComputedStyle(el).position; if (p === "fixed" || p === "sticky") el.style.setProperty("visibility", "hidden", "important") } }).catch(() => {})
  if (region && !box) throw new ImageError(`không thấy vùng "${region}" trên trang`)
  const clip = box ?? { x: 0, y: 0, w: VIEW.width, h: VIEW.height }
  return Buffer.from(await page.screenshot({ type: "png", clip: { x: clip.x, y: clip.y, width: Math.max(200, clip.w), height: clip.h }, captureBeyondViewport: false }))
}

/** One page of a PDF in Chrome's own viewer (the sandbox Chrome runs headed off-screen, so the viewer renders scans too).
 *  A fresh navigation (via about:blank) so the viewer honours #page / #toolbar=0 / #navpanes=0. */
async function shootPdf(page: any, href: string, n: number): Promise<Buffer> {
  await page.setViewport({ width: 1100, height: 1500 })
  await page.goto("about:blank")
  await page.goto(href.split("#")[0] + "#page=" + n + "&toolbar=0&navpanes=0&view=FitH", { waitUntil: "load", timeout: 60_000 }).catch(() => {})
  await sleep(4500)
  return Buffer.from(await page.screenshot({ type: "png" }))
}

export const snapshot = tool({
  description:
    "CHỤP ẢNH NGUYÊN BẢN một trang CHÍNH THỨC (vbpl.vn, anle.toaan.gov.vn, biểu thuế trên customs.gov.vn, Federal Register, EUR-Lex…) hoặc một trang của tệp PDF chính thức / của tài liệu trong cuộc trò chuyện (mã tài liệu), để người dùng THẤY văn bản gốc cạnh phần giải thích (VD trang án lệ, bảng thuế, điều khoản). region: đoạn chữ cần chụp (công cụ tìm khối chứa đoạn đó) hoặc 'css:<selector>'. Trả về đoạn markdown `![chú thích](visual:<mã>)` + dòng 'Ảnh chụp từ <nguồn>' để chép nguyên văn vào câu trả lời. Chỉ chụp trang đã/đang dùng làm căn cứ; không dùng để tạo 'ảnh văn bản' không có thật.",
  args: {
    url_or_doc: tool.schema.string().describe("Link trang / PDF chính thức, hoặc mã tài liệu của cuộc trò chuyện (VD '20260926034611-4345e7')"),
    page: tool.schema.number().optional().describe("PDF: số trang cần chụp (mặc định 1)"),
    region: tool.schema.string().optional().describe("Tuỳ chọn: đoạn chữ nằm trong vùng cần chụp (VD 'Điều 5', 'Nhóm 7208') hoặc 'css:<selector>'"),
    caption: tool.schema.string().optional().describe("Chú thích ngắn, VD 'Trang án lệ số 69/2023/AL trên anle.toaan.gov.vn'"),
    lang: tool.schema.enum(["vi", "en"]).optional().describe("Ngôn ngữ câu trả lời (dòng ghi nguồn)"),
  },
  async execute({ url_or_doc, page, region, caption, lang }, context) {
    const l = lang === "en" ? "en" : "vi"
    const sid = context?.sessionID ?? "no-session"
    const n = Math.max(1, Math.min(2000, Math.floor(Number(page) || 1)))
    try {
      let png: Buffer, sourceUrl: string, domain: string, label: string, title: string
      const ref = String(url_or_doc ?? "").trim()
      if (/^\d{14}-[0-9a-f]{6}$/.test(ref)) {
        const meta = findDocumentForSession(sid, ref)
        if (!meta) throw new ImageError(`không tìm thấy tài liệu ${ref} trong cuộc trò chuyện này`)
        const dir = outDir(meta.sessionID)
        const pdf = meta.files.find((f) => f.format === "pdf")?.name ?? (typeof meta.original === "string" && /\.pdf$/i.test(meta.original) ? meta.original : null)
        const file = pdf ? path.join(dir, pdf) : path.join(dir, meta.preview)
        if (!fs.existsSync(file) || path.dirname(path.resolve(file)) !== path.resolve(dir)) throw new ImageError("tài liệu không có tệp để chụp")
        png = await withPage((p) => (pdf ? shootPdf(p, pathToFileURL(file).href, n) : p.goto(pathToFileURL(file).href, { waitUntil: "load" }).then(() => shootHtml(p, region))))
        sourceUrl = `artifact://${meta.id}`; domain = l === "en" ? "document in this conversation" : "tài liệu trong cuộc trò chuyện"; label = meta.title; title = meta.title
      } else {
        const u = parsePublicUrl(ref)
        const off = officialOf(u.hostname)
        if (!off) throw new ImageError(`${u.hostname} không phải tên miền chính thức – chỉ chụp trang của cơ quan nhà nước / tổ chức quốc tế (gov.vn, vbpl.vn, WTO, EU, Federal Register…)`)
        const r = await withPage(async (p) => {
          await throttle(u.hostname, { gapMs: 1100 })
          const res = await p.goto(u.href, { waitUntil: "domcontentloaded", timeout: 60_000 })
          const final = new URL(p.url())
          if (!officialOf(final.hostname)) throw new ImageError(`trang chuyển sang ${final.hostname} (không chính thức)`)
          if ((res?.status() ?? 200) >= 400) throw new ImageError(`HTTP ${res?.status()} – trang không mở được`)
          const ct = String(res?.headers()?.["content-type"] ?? "")
          const isPdf = /application\/pdf/.test(ct) || /\.pdf$/i.test(final.pathname)
          const shot = isPdf ? await shootPdf(p, final.href, n) : await shootHtml(p, region)
          const t = isPdf ? decodeURIComponent(final.pathname.split("/").pop() || "PDF") : await p.evaluate(() => ((document.querySelector("h1") as HTMLElement | null)?.innerText || document.title || "").trim())
          return { shot, final: final.href, t: String(t).replace(/\s+/g, " ").slice(0, 160) }
        })
        png = r.shot; sourceUrl = r.final; domain = new URL(r.final).hostname.replace(/^www\./, ""); label = off.label; title = r.t || domain
      }
      const enc = await reencodeImage(png, { maxDim: 1600, format: "webp", quality: 0.9 })
      const credit = l === "en" ? `Screenshot from ${domain}${label && label !== domain ? ` (${label})` : ""}, accessed ${today()}` : `Ảnh chụp từ ${domain}${label && label !== domain ? ` (${label})` : ""}, truy cập ${today()}`
      const meta = saveVisual({
        sessionID: sid, kind: "snapshot", title, caption: String(caption ?? "").trim().slice(0, 300) || title, lang: l, width: enc.width, height: enc.height,
        attribution: { title, author: label, license: l === "en" ? "screenshot of the original source" : "ảnh chụp nguyên bản từ nguồn", source_url: sourceUrl, domain, credit },
        source: { url: sourceUrl, ...(n > 1 ? { page: n } : {}), ...(region ? { region: String(region).slice(0, 120) } : {}), official: label },
        blobs: [{ role: "image", format: enc.format, data: enc.data }],
      })
      const out = [
        `Đã chụp ${title ? `"${title}"` : sourceUrl} (mã ảnh: ${meta.id}; ${enc.width}×${enc.height}${n > 1 ? `, trang ${n}` : ""}). Nguồn: ${sourceUrl}.`,
        "Chép NGUYÊN VĂN hai dòng sau vào câu trả lời, ngay sau đoạn văn trích / giải thích nội dung đó (vẫn trích dẫn văn bản bằng chữ + link như thường lệ):",
        imageSnippet(meta),
      ].join("\n")
      return withUi(out, { res: { t: "title", v: meta.caption, lang: l }, visual: { id: meta.id, kind: "snapshot" } })
    } catch (e: any) {
      const msg = e instanceof ImageError ? e.message : `không chụp được (${String(e?.message ?? e).slice(0, 200)})`
      return withUi(`Lỗi – CHƯA chụp: ${msg}.`, { res: { t: "error", code: "snapshot_failed" } })
    }
  },
})
