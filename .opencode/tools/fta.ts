// Deterministic FTA tools on trungtamwto.vn (Trung tâm WTO và Hội nhập – VCCI). Every request goes through the
// sandbox Chrome (DevTools port on 127.0.0.1:$CHROME_PORT, started by run.sh); pages are fetched with fetch()
// INSIDE a page on trungtamwto.vn (same origin, real browser) and parsed with DOMParser:
//   fta_list      – Vietnam's FTAs: the centre's own summary table (/thong-ke/12065 "Tổng hợp các FTA của Việt
//                   Nam") → status / in-force dates, partners, link to each FTA's section of the site
//   fta_search    – chapters / annexes / schedules listed on an FTA's "Văn kiện hiệp định" pages (each with its
//                   EN/VI attachment links) + the FTA's "Văn bản thực thi của Việt Nam" (implementing circulars,
//                   decrees) + publications, matched against a keyword ("quy tắc xuất xứ", "thuế", "SPS"…)
//   fta_document  – one trungtamwto.vn page (clean text + attachments) or one attachment PDF (text extracted
//                   locally with pdf.js when available), capped, with focus windows
// The site sits behind Cloudflare and has had 52x outages: errors are reported, never worked around.
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import { count, isoDate, withUi } from "../lib/ui-meta.ts"
import puppeteer from "puppeteer-core"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { recordEvidence } from "../lib/evidence.ts"
import { ocrPdf, ocrBlock, ocrMeta, ocrRange, ocrUi, OCR_LABEL, type OcrResult } from "../lib/pdf-ocr.ts"
import { politeEval, politeGoto } from "../lib/polite.ts"

const PORT = process.env.CHROME_PORT ?? "9333"
const SITE = "https://trungtamwto.vn"
const CACHE = path.join(process.env.XDG_CACHE_HOME ?? ".", "legalai", "fta")
const INDEX_TTL_MS = 24 * 3600 * 1000
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

const today = () => new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" })

async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const page = await browser.newPage()
  try {
    return await fn(page)
  } finally {
    await page.close().catch(() => {})
    browser.disconnect()
  }
}

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

const TTL_MS = 15 * 60 * 1000
const cache = new Map<string, { at: number; value: any }>()
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}

class SiteDown extends Error {}
const downMessage = (why: string) =>
  `trungtamwto.vn hiện không truy cập được (${why}). Trang này từng gặp lỗi Cloudflare 52x – thử lại sau vài phút; không tìm cách vượt qua. Có thể dùng tạm vbpl_* (văn bản thực thi: thông tư/nghị định về quy tắc xuất xứ, biểu thuế) hoặc moit.gov.vn qua MCP chrome.`

// Open the site once (same origin for the in-page fetches) and detect Cloudflare error / challenge pages.
async function openSite(page: any) {
  if (page.url().startsWith(SITE)) return
  let res: any
  try {
    res = await politeGoto(page, `${SITE}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 45000 })
  } catch (e: any) {
    throw new SiteDown(`không kết nối được: ${String(e?.message ?? e).slice(0, 80)}`)
  }
  const st = res?.status() ?? 0
  if (!res || st >= 500) throw new SiteDown(`HTTP ${st}${st >= 520 && st <= 530 ? " – lỗi Cloudflare" : ""}`)
  const t = String(await page.evaluate(() => document.title + " " + (document.body?.innerText ?? "").slice(0, 300)).catch(() => ""))
  if (/just a moment|attention required|cf-error|checking your browser/i.test(t)) throw new SiteDown("Cloudflare yêu cầu kiểm tra trình duyệt")
}

type Fetched = { status: number; html: string }
async function getHtml(page: any, url: string): Promise<Fetched> {
  return cached(`h|${url}`, async () => {
    await openSite(page)
    const r: Fetched = await politeEval(SITE, page, async (u: string) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 40000)
      try {
        const res = await fetch(u, { signal: ctl.signal, credentials: "omit" })
        return { status: res.status, html: await res.text() }
      } catch (e: any) {
        return { status: 0, html: String(e?.message ?? e) }
      } finally {
        clearTimeout(timer)
      }
    }, url)
    if (r.status === 0 || r.status >= 500) throw new SiteDown(r.status ? `HTTP ${r.status}` : r.html.slice(0, 80))
    if (/<title>\s*(Just a moment|Attention Required)/i.test(r.html)) throw new SiteDown("Cloudflare yêu cầu kiểm tra trình duyệt")
    return r
  })
}

// ---------- FTA catalogue ----------

type Fta = { id: string; name: string; code: string; url: string; signed: boolean }

// The site's own menu (FTA → Đã ký kết / Chưa ký kết) lists every FTA section.
async function catalogue(page: any): Promise<Fta[]> {
  const file = path.join(CACHE, "catalogue.json")
  try {
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < INDEX_TTL_MS) return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {}
  const { html } = await getHtml(page, `${SITE}/fta/174-da-ky-ket/1`)
  const list: Fta[] = await page.evaluate((html: string) => {
    const d = new DOMParser().parseFromString(html, "text/html")
    const seen = new Set<string>()
    const out: any[] = []
    let signed = true
    for (const a of [...d.querySelectorAll("a[href]")]) {
      const href = a.getAttribute("href") ?? ""
      const text = (a.textContent ?? "").replace(/\s+/g, " ").trim()
      if (/\/fta\/196-/.test(href)) signed = false
      if (/\/fta\/174-/.test(href)) signed = true
      const m = href.match(/^\/fta\/(\d+)-[^/]+\/1$/)
      if (!m || ["174", "196"].includes(m[1]) || seen.has(m[1]) || !text) continue
      if (!/ - |ASEAN|CPTPP|RCEP|EFTA/.test(text)) continue
      seen.add(m[1])
      const code = (text.match(/\(([^)]+)\)\s*$/)?.[1] ?? text).trim()
      out.push({ id: m[1], name: text, code, url: new URL(href, "https://trungtamwto.vn").href, signed })
    }
    return out
  }, html)
  if (list.length < 10) throw new Error("Không đọc được danh mục FTA trên trungtamwto.vn (cấu trúc trang có thể đã đổi).")
  try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(file, JSON.stringify(list)) } catch {}
  return list
}

// Codes / Vietnamese names people use → words that appear in the site's FTA names.
const FTA_ALIASES: Record<string, string> = {
  atiga: "aec", afta: "aec", aec: "aec", asean: "aec", tpp: "cptpp", cptpp: "cptpp", evfta: "evfta", eu: "evfta", "chau au": "evfta",
  ukvfta: "ukvfta", anh: "ukvfta", uk: "ukvfta", rcep: "rcep", vkfta: "vkfta", "han quoc": "vkfta", akfta: "akfta", vjepa: "vjepa", "nhat ban": "vjepa",
  ajcep: "ajcep", acfta: "acfta", "trung quoc": "acfta", aifta: "aifta", "an do": "aifta", aanzfta: "aanzfta", uc: "aanzfta", "new zealand": "aanzfta",
  ahkfta: "ahkfta", "hong kong": "ahkfta", vcfta: "vcfta", chile: "vcfta", "chi le": "vcfta", eaeu: "vn eaeu fta", "vn eaeu": "vn eaeu fta", nga: "vn eaeu fta",
  "a au": "vn eaeu fta", vifta: "vifta", israel: "vifta", cepa: "cepa", uae: "cepa", efta: "efta", canada: "asean canada",
}

function findFta(list: Fta[], input: string): Fta | null {
  const f = fold(input)
  const key = FTA_ALIASES[f] ?? f
  return list.find((x) => fold(x.code) === key) ?? list.find((x) => fold(x.name).includes(key)) ?? list.find((x) => ` ${fold(x.name)} `.includes(` ${f} `)) ?? null
}

// ---------- fta_list ----------

export const list = tool({
  description: "Danh sách các FTA của Việt Nam theo bảng tổng hợp của Trung tâm WTO và Hội nhập – VCCI (trungtamwto.vn): tên/viết tắt (AFTA, ACFTA, AKFTA, AJCEP, VJEPA, AIFTA, AANZFTA, VCFTA, VKFTA, VN-EAEU, CPTPP, AHKFTA, EVFTA, UKVFTA, RCEP, VIFTA, CEPA Việt Nam–UAE…), tình trạng và ngày có hiệu lực, các đối tác, link chuyên mục FTA trên trang (văn kiện, văn bản thực thi). Dùng trước fta_search để lấy đúng tên FTA.",
  args: {},
  async execute(_args, context) {
    return withPage(async (page) => {
      try {
        const cat = await catalogue(page)
        const statsUrl = `${SITE}/thong-ke/12065-tong-hop-cac-fta-cua-viet-nam-tinh-den-thang-112018`
        const { status, html } = await getHtml(page, statsUrl)
        const table = status < 400 ? await page.evaluate((html: string) => {
          const d = new DOMParser().parseFromString(html, "text/html")
          const title = ([...d.querySelectorAll("h1, h3")].map((h) => (h.textContent ?? "").trim()).find((t) => /^Tổng hợp các FTA/i.test(t)) ?? "").trim()
          const rows = [...d.querySelectorAll(".content__main table tr")].map((r) => [...(r as HTMLTableRowElement).cells].map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()))
          return { title, rows }
        }, html) : { title: "", rows: [] as string[][] }
        const lines: string[] = []
        let group = ""
        for (const r of table.rows) {
          if (r.length === 1 || (r.length >= 1 && r.slice(1).every((c) => !c))) { group = r[0]; if (group) lines.push(`— ${group}`); continue }
          if (!/^\d+$/.test(r[0])) continue
          const [n, name, status, partners] = r
          const hit = findFta(cat, name.replace(/\(.*\)/, "").replace(/–/g, "-"))
          lines.push(`${n}. ${name} · ${status} · Đối tác: ${partners}${hit ? `\n   ${hit.url}` : ""}`)
        }
        const text = [
          `FTA của Việt Nam – ${table.title || "bảng tổng hợp của Trung tâm WTO và Hội nhập (VCCI)"}:`,
          ...(lines.length ? lines : cat.map((x, i) => `${i + 1}. ${x.name}${x.signed ? "" : " (chưa ký kết/đang đàm phán)"}\n   ${x.url}`)),
          `Nguồn: ${statsUrl} (tra ngày ${today()}). Ngày có hiệu lực theo bảng của VCCI – đối chiếu văn bản gốc (Nghị định biểu thuế, Thông tư quy tắc xuất xứ) khi cần.`,
        ].join("\n")
        recordEvidence(context?.sessionID, { url: statsUrl, title: table.title, text, source: "fta_list" })
        return withUi(text, { res: count(lines.length ? lines.filter((l) => /^\d+\. /.test(l)).length : cat.length, "ftas") })
      } catch (e: any) {
        if (e instanceof SiteDown) return downMessage(e.message)
        throw e
      }
    })
  },
})

// ---------- FTA index (sections, text pages, implementing documents) ----------

type Entry = { kind: "text" | "impl" | "pub"; label: string; page: string; links: { label: string; href: string }[]; meta?: string }
type Index = { fta: Fta; sections: { name: string; url: string }[]; entries: Entry[]; at: number }

async function listing(page: any, url: string, pages: number) {
  const items: { title: string; url: string; meta: string }[] = []
  for (let p = 1; p <= pages; p++) {
    const u = url.replace(/\/\d+$/, `/${p}`)
    const { status, html } = await getHtml(page, u)
    if (status >= 400) break
    const r = await page.evaluate((html: string) => {
      const d = new DOMParser().parseFromString(html, "text/html")
      const main = d.querySelector(".content__main") ?? d.body
      const its = [...main.querySelectorAll("._item")].map((it) => {
        const a = it.querySelector("._item__title a[href]") as HTMLAnchorElement | null
        return { title: (a?.textContent ?? "").replace(/\s+/g, " ").trim(), url: a ? new URL(a.getAttribute("href") ?? "", "https://trungtamwto.vn").href.replace(/\?$/, "") : "", meta: (it.querySelector("._item__content p")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240) }
      }).filter((x) => x.title && /\/chuyen-de\//.test(x.url))
      const last = Math.max(1, ...[...main.querySelectorAll("a[href]")].map((a) => Number((a.getAttribute("href") ?? "").match(/\/(\d+)$/)?.[1] ?? 0)).filter((n) => n < 200))
      return { its, last }
    }, html)
    items.push(...r.its)
    if (p >= r.last) break
  }
  return items
}

async function textPageEntries(page: any, url: string): Promise<Entry[]> {
  const { status, html } = await getHtml(page, url)
  if (status >= 400) return []
  return page.evaluate((html: string, url: string) => {
    const d = new DOMParser().parseFromString(html, "text/html")
    const box = d.querySelector(".content__main .content__box") ?? d.body
    const isFile = (h: string) => /\/(download|upload)\/|\.(pdf|docx?|xlsx?|zip|rar)(\?|$)/i.test(h)
    const out: any[] = []
    for (const n of [...box.querySelectorAll("p, li, tr, h4, h5")]) {
      const links = [...n.querySelectorAll("a[href]")].map((a) => ({ label: (a.textContent ?? "").replace(/[()\s]+/g, " ").trim(), href: new URL(a.getAttribute("href") ?? "", "https://trungtamwto.vn").href })).filter((l) => isFile(l.href))
      if (!links.length) continue
      if (n.tagName === "TR" && n.querySelector("p, li")) continue
      const label = (n.textContent ?? "").replace(/\((Tiếng Anh|Tiếng Việt|bản tiếng Anh|bản tiếng Việt|English|Vietnamese)\)/gi, "").replace(/\s+/g, " ").trim()
      out.push({ kind: "text", label: label.slice(0, 240), page: url, links })
    }
    return out
  }, html, url)
}

async function ftaIndex(page: any, fta: Fta): Promise<Index> {
  const file = path.join(CACHE, `index-${fta.id}.json`)
  try {
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < INDEX_TTL_MS) return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {}
  const { html } = await getHtml(page, fta.url)
  const sections: { name: string; url: string }[] = await page.evaluate((html: string) => {
    const d = new DOMParser().parseFromString(html, "text/html")
    const main = d.querySelector(".content__main") ?? d.body
    return [...main.querySelectorAll("._item__title a[href], h3 a[href]")].map((a) => ({ name: (a.textContent ?? "").replace(/\s+/g, " ").trim(), url: new URL(a.getAttribute("href") ?? "", "https://trungtamwto.vn").href }))
      .filter((s, i, arr) => /\/fta\/\d+-/.test(s.url) && s.name && arr.findIndex((x) => x.url === s.url) === i)
  }, html)
  const entries: Entry[] = []
  const content = sections.find((s) => /noi dung hiep dinh/.test(fold(s.name)))
  const impl = sections.find((s) => /van ban thuc thi/.test(fold(s.name)))
  const pubs = sections.find((s) => /an pham|tai lieu/.test(fold(s.name)))
  if (content) {
    const texts = await listing(page, content.url, 2)
    for (const t of texts) entries.push({ kind: "text", label: t.title, page: t.url, links: [], meta: t.meta })
    // Open the pages that hold the agreement text (chapters/annexes with attachments).
    const textPages = texts.filter((t) => /van kien|van ban hiep dinh|toan van|noi dung|hiep dinh/.test(fold(t.title))).slice(0, 6)
    const parsed = await Promise.all(textPages.map((t) => textPageEntries(page, t.url).catch(() => [] as Entry[])))
    parsed.forEach((es) => entries.push(...es))
  }
  if (impl) for (const t of await listing(page, impl.url, 4)) entries.push({ kind: "impl", label: t.title, page: t.url, links: [], meta: t.meta })
  if (pubs) for (const t of await listing(page, pubs.url, 1)) entries.push({ kind: "pub", label: t.title, page: t.url, links: [], meta: t.meta })
  const idx = { fta, sections, entries, at: Date.now() }
  if (entries.length) try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(file, JSON.stringify(idx)) } catch {}
  return idx
}

// ---------- fta_search ----------

const STOP = new Set(["hiep", "dinh", "fta", "cua", "va", "trong", "ve", "cac", "theo", "the", "of", "and", "viet", "nam", "vn", "hang", "hoa"])
const SYN: Record<string, string[]> = {
  "xuat xu": ["origin", "xuat xu", "qtxx", "c o"], thue: ["thue", "tariff", "bieu", "schedule"], "dich vu": ["dich vu", "services"],
  "dau tu": ["dau tu", "investment"], "phong ve": ["phong ve", "pvtm", "remedies", "tu ve"], "so huu tri tue": ["so huu tri tue", "intellectual"],
  "mua sam": ["mua sam", "procurement"], "lao dong": ["lao dong", "labour"], "moi truong": ["moi truong", "environment"], "hai quan": ["hai quan", "customs"],
  tbt: ["tbt", "hang rao ky thuat", "technical barriers"], sps: ["sps", "ve sinh", "kiem dich", "sanitary", "an toan thuc pham"],
  "thuong mai dien tu": ["thuong mai dien tu", "electronic commerce"], "giai quyet tranh chap": ["tranh chap", "dispute"],
}

function terms(query: string, ftaWords: string[]) {
  let q = ` ${fold(query)} `
  for (const w of ftaWords) q = q.replace(` ${w} `, " ")
  const groups: string[][] = []
  for (const [k, alts] of Object.entries(SYN)) if (q.includes(` ${k} `)) { groups.push(alts); q = q.replace(` ${k} `, " ") }
  q = q.replace(/ quy tac /g, " ")
  for (const w of q.split(" ").filter((w) => w.length > 1 && !STOP.has(w))) groups.push([w])
  return groups
}

export const search = tool({
  description: "Tìm trong chuyên mục FTA của trungtamwto.vn (Trung tâm WTO và Hội nhập – VCCI): các chương / phụ lục / biểu cam kết thuế / quy tắc cụ thể mặt hàng của văn kiện hiệp định (kèm link bản tiếng Anh/tiếng Việt), văn bản thực thi của Việt Nam (thông tư quy tắc xuất xứ, nghị định biểu thuế ưu đãi…) và ấn phẩm, theo FTA + từ khóa. VD fta='EVFTA', query='quy tắc xuất xứ'; fta='CPTPP', query='thuế'; fta='RCEP', query='SPS'. Có thể gộp FTA vào query (VD 'EVFTA quy tắc xuất xứ'). Đọc nội dung bằng fta_document(link).",
  args: {
    query: tool.schema.string().describe("Từ khóa tiếng Việt (hoặc Anh), VD 'quy tắc xuất xứ', 'biểu thuế', 'phòng vệ thương mại', 'Phụ lục 2-A'; có thể kèm tên FTA"),
    fta: tool.schema.string().optional().describe("FTA: EVFTA, CPTPP, RCEP, UKVFTA, VKFTA, VJEPA, ATIGA/AEC, ACFTA, AKFTA, AJCEP, AIFTA, AANZFTA, AHKFTA, VCFTA, VN-EAEU, VIFTA, CEPA (UAE), EFTA…"),
    kind: tool.schema.enum(["all", "text", "implementing", "publications"]).optional().describe("all (mặc định) | text (văn kiện: chương/phụ lục) | implementing (văn bản thực thi của VN) | publications (ấn phẩm)"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa (mặc định 10, tối đa 25)"),
  },
  async execute({ query, fta, kind, limit }, context) {
    const max = Math.min(Math.max(limit ?? 10, 1), 25)
    return withPage(async (page) => {
      try {
        const cat = await catalogue(page)
        let f: Fta | null = fta ? findFta(cat, fta) : null
        if (!f && !fta) for (const w of fold(query).split(" ")) { f = FTA_ALIASES[w] ? findFta(cat, w) : null; if (f) break }
        if (!f) return `Chưa xác định được FTA${fta ? ` "${fta}"` : ""}. Các FTA trên trungtamwto.vn: ${cat.map((x) => x.code).join(", ")}. Gọi lại với fta = một trong các tên này (hoặc fta_list).`
        const idx = await ftaIndex(page, f)
        const ftaWords = [...new Set([...fold(f.code).split(" "), ...(fta ? fold(fta).split(" ") : []), ...Object.keys(FTA_ALIASES).filter((k) => FTA_ALIASES[k] === FTA_ALIASES[fold(f!.code)]).flatMap((k) => k.split(" "))])]
        const groups = terms(query, ftaWords)
        const want = kind === "text" ? ["text"] : kind === "implementing" ? ["impl"] : kind === "publications" ? ["pub"] : ["text", "impl", "pub"]
        const pool = idx.entries.filter((e) => want.includes(e.kind))
        const scored = pool.map((e) => {
          const hay = ` ${fold(`${e.label} ${e.meta ?? ""}`)} `
          const hit = groups.filter((alts) => alts.some((a) => hay.includes(` ${a} `) || (a.length > 4 && hay.includes(a)))).length
          return { e, score: groups.length ? hit / groups.length : 1 }
        }).filter((x) => x.score >= (groups.length > 2 ? 0.5 : groups.length ? 1 : 0))
        const order = { text: 0, impl: 1, pub: 2 } as const
        scored.sort((a, b) => b.score - a.score || order[a.e.kind] - order[b.e.kind])
        const seen = new Set<string>()
        const top = scored.filter((x) => { const k = `${x.e.label}|${x.e.links[0]?.href ?? x.e.page}`; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, max)
        if (!top.length) return withUi(`Không có mục nào của ${f.name} khớp "${query}" trên trungtamwto.vn (đã xem ${pool.length} mục: văn kiện, văn bản thực thi, ấn phẩm). Thử từ khóa khác (VD 'xuất xứ', 'thuế', 'Chương 3', 'Phụ lục'), hoặc kind='all'. Chuyên mục: ${f.url}`, { res: count(0, "results") })
        const kindVi = { text: "Văn kiện", impl: "Văn bản thực thi của VN", pub: "Ấn phẩm" }
        for (const x of top) recordEvidence(context?.sessionID, { url: x.e.links[0]?.href ?? x.e.page, title: x.e.label, text: [x.e.label, x.e.meta].filter(Boolean).join(" · "), source: "fta_search", meta: { fta: f.code, page: x.e.page, kind: x.e.kind } })
        return withUi([
          `trungtamwto.vn – ${f.name}: ${top.length} mục khớp "${query}"${kind && kind !== "all" ? ` (${kind})` : ""}:`,
          ...top.map((x, i) => {
            const e = x.e
            const files = e.links.slice(0, 4).map((l) => `${l.label || "tệp"}: ${l.href}`).join(" ; ")
            return `${i + 1}. [${kindVi[e.kind]}] ${e.label}${e.meta ? `\n   ${e.meta.slice(0, 200)}` : ""}${files ? `\n   ${files}` : ""}\n   Trang: ${e.page}`
          }),
          `(nguồn: trungtamwto.vn – Trung tâm WTO và Hội nhập, VCCI; tra ngày ${today()}; đọc nội dung: fta_document(link trang hoặc link tệp PDF))`,
        ].join("\n"), { res: count(top.length, "results") })
      } catch (e: any) {
        if (e instanceof SiteDown) return downMessage(e.message)
        throw e
      }
    })
  },
})

// ---------- fta_document ----------

let pdfjsLib: any
async function pdfjs() {
  if (pdfjsLib !== undefined) return pdfjsLib
  const candidates = ["pdfjs-dist/legacy/build/pdf.mjs", pathToFileURL(path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")).href, pathToFileURL(path.join(ROOT, "web", "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")).href]
  for (const c of candidates) {
    try { pdfjsLib = await import(c); return pdfjsLib } catch {}
  }
  pdfjsLib = null
  return null
}

async function pdfText(page: any, url: string): Promise<{ text: string; pages: number; ocr?: OcrResult; ocrError?: string } | { error: string }> {
  return cached(`p|${url}`, async () => {
    await openSite(page)
    const r = await politeEval(SITE, page, async (u: string) => {
      try {
        const res = await fetch(u, { credentials: "omit" })
        const ct = res.headers.get("content-type") ?? ""
        const b = new Uint8Array(await res.arrayBuffer())
        if (b.length > 25 * 1024 * 1024) return { status: res.status, ct, error: `tệp quá lớn (${Math.round(b.length / 1048576)} MB)` }
        let s = ""
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
        return { status: res.status, ct, b64: btoa(s) }
      } catch (e: any) {
        return { status: 0, ct: "", error: String(e?.message ?? e) }
      }
    }, url)
    if (r.status === 0 || r.status >= 500) throw new SiteDown(r.status ? `HTTP ${r.status}` : r.error)
    if (r.error) return { error: r.error }
    if (r.status >= 400) return { error: `HTTP ${r.status}` }
    const bytes = Buffer.from(r.b64, "base64")
    if (bytes.subarray(0, 5).toString() !== "%PDF-") return { error: `tệp không phải PDF (${r.ct || "không rõ định dạng"})` }
    const lib = await pdfjs()
    if (!lib) return { error: "máy chưa có thư viện pdf.js (pdfjs-dist) để đọc PDF" }
    const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, verbosity: 0 })
    const doc = await task.promise
    let text = ""
    const n = Math.min(doc.numPages, 400)
    for (let p = 1; p <= n; p++) {
      const c = await (await doc.getPage(p)).getTextContent()
      text += c.items.map((i: any) => i.str + (i.hasEOL ? "\n" : "")).join("") + "\n"
    }
    const pages = doc.numPages
    await Promise.resolve(task.destroy?.()).catch(() => {})
    text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()
    // scanned annex / decision (no text layer) → OCR fallback in the dedicated OCR Chrome (first 15 pages)
    if (text.replace(/\s/g, "").length < 40 * Math.min(pages, 5)) {
      try {
        const o = await ocrPdf(bytes, { maxPages: 15 })
        if (o.pages.some((p) => p.text.length > 50)) return { text: ocrBlock(o), pages, ocr: o }
      } catch (e: any) { return { text, pages, ocrError: String(e?.message ?? e).slice(0, 200) } }
    }
    return { text, pages }
  })
}

function windows(text: string, focus: string | undefined, cap: number) {
  if (!focus) return text.slice(0, cap) + (text.length > cap ? `\n…(cắt, còn ${text.length - cap} ký tự; dùng focus để lấy đoạn cần)` : "")
  const low = fold(text)
  // fold() keeps length only for ascii; map positions through a folded copy built char by char.
  const map: number[] = []
  let folded = ""
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]) || " "
    for (const ch of f) { folded += ch; map.push(i) }
  }
  const key = fold(focus)
  const hits: number[] = []
  for (let at = folded.indexOf(key); at >= 0 && hits.length < 8; at = folded.indexOf(key, at + key.length)) hits.push(map[at])
  if (!hits.length || !low) return `(Không thấy "${focus}" trong văn bản.)\n` + text.slice(0, Math.min(cap, 1500))
  const per = Math.max(600, Math.floor(cap / Math.min(hits.length, 4)))
  const parts: string[] = []
  let lastEnd = -1
  for (const h of hits) {
    const s = Math.max(0, h - Math.floor(per / 4), lastEnd)
    const e = Math.min(text.length, s + per)
    if (s >= e) continue
    parts.push((s > 0 ? "…" : "") + text.slice(s, e) + (e < text.length ? "…" : ""))
    lastEnd = e
    if (parts.join("\n[…]\n").length > cap) break
  }
  return parts.join("\n[…]\n").slice(0, cap + 200)
}

export const document = tool({
  description: "Đọc một trang hoặc một tệp đính kèm trên trungtamwto.vn (link từ fta_search/fta_list): với trang bài viết/văn kiện → tiêu đề, ngày đăng, nội dung đã làm sạch (tối đa ~6000 ký tự) và danh sách tệp đính kèm (chương/phụ lục/thông tư, bản EN/VI); với link tệp PDF (/download/…) → văn bản trích từ PDF. Dùng focus (VD 'Điều 3', 'cộng gộp', 'de minimis', '0306') để lấy đúng đoạn cần trong văn bản dài.",
  args: {
    url: tool.schema.string().describe("Link https://trungtamwto.vn/chuyen-de/… , /thong-ke/… , /fta/… hoặc tệp /download/…pdf"),
    focus: tool.schema.string().optional().describe("Từ/cụm cần tìm trong văn bản (trả về các đoạn quanh vị trí xuất hiện)"),
    max_chars: tool.schema.number().optional().describe("Số ký tự nội dung tối đa (mặc định 6000)"),
  },
  async execute({ url, focus, max_chars }, context) {
    let u: URL
    try { u = new URL(url, SITE) } catch { return "Link không hợp lệ." }
    if (!/(^|\.)trungtamwto\.vn$|(^|\.)wtocenter\.vn$/.test(u.hostname)) return "Chỉ nhận link trên trungtamwto.vn (VD https://trungtamwto.vn/chuyen-de/…). Dùng fta_search để lấy link."
    u.hostname = "trungtamwto.vn"
    u.protocol = "https:"
    const cap = max_chars ?? 6000
    return withPage(async (page) => {
      try {
        if (/\/(download|upload)\/|\.pdf(\?|$)/i.test(u.pathname)) {
          const r = await pdfText(page, u.href)
          if ("error" in r) return `Không đọc được nội dung tệp ${u.href}: ${r.error}. Mở trực tiếp link để xem.\nNgày tra cứu: ${today()}`
          if (!r.ocr && r.text.replace(/\s/g, "").length < 40 * Math.min(r.pages, 5)) return `Tệp ${u.href} (${r.pages} trang) là bản scan dạng ảnh – không có lớp chữ để trích${r.ocrError ? ` (OCR không dùng được: ${r.ocrError})` : ""}. Mở trực tiếp link để xem; nếu là thông tư/nghị định của Việt Nam, tra toàn văn trên vbpl.vn bằng vbpl_find.\nNgày tra cứu: ${today()}`
          recordEvidence(context?.sessionID, { url: u.href, title: decodeURIComponent(u.pathname.split("/").pop() ?? ""), text: r.text, source: "fta_pdf", meta: { pages: r.pages, ...(r.ocr ? ocrMeta(r.ocr) : {}) } })
          const body = windows(r.text, focus, cap)
          const out = [
            `Tệp: ${decodeURIComponent(u.pathname.split("/").pop() ?? "")} (${r.pages} trang PDF, ${r.text.length} ký tự)`,
            `Link: ${u.href}`,
            `Nguồn: trungtamwto.vn (Trung tâm WTO và Hội nhập – VCCI) · Ngày tra cứu: ${today()}`,
            r.ocr ? `⚠ Tệp là bản scan – nội dung dưới đây do OCR (${r.ocr.engine}, trang ${ocrRange(r.ocr)}) nhận dạng${r.ocr.warnings.length ? `; ${r.ocr.warnings.join("; ")}` : ""}. Độ tin cậy tối đa TRUNG BÌNH.` : "",
            `--- NỘI DUNG${focus ? ` (các đoạn có "${focus}")` : ""} ---`,
            r.ocr && !body.startsWith(OCR_LABEL) ? `${OCR_LABEL}\n${body}` : body,
          ].filter(Boolean).join("\n")
          return r.ocr ? withUi(out, ocrUi(r.ocr)) : out
        }
        const { status, html } = await getHtml(page, u.href)
        if (status >= 400) return `Trang ${u.href} trả về HTTP ${status} (link sai hoặc bài đã bị gỡ). Dùng fta_search để lấy link đúng.`
        const a = await page.evaluate((html: string) => {
          const d = new DOMParser().parseFromString(html, "text/html")
          const main = d.querySelector(".content__main") ?? d.body
          main.querySelectorAll("script, style, link, .modal, form").forEach((x) => x.remove())
          const title = (main.querySelector(".content__main-title h3")?.textContent ?? d.title).replace(/\s+/g, " ").trim()
          const date = (main.querySelector(".content__main-title span")?.textContent ?? "").replace(/\s+/g, " ").trim().split(" ")[0] ?? ""
          const box = main.querySelector(".content__box ._item") ?? main.querySelector(".content__box") ?? main
          // "Các bài khác" (other articles) is a separate _item – keep only the first one.
          const files = [...box.querySelectorAll("a[href]")].map((x) => {
            const own = (x.textContent ?? "").replace(/[()\s]+/g, " ").trim()
            const holder = (x.closest("p, li, td")?.textContent ?? "").replace(/\((Tiếng Anh|Tiếng Việt|bản tiếng Anh|bản tiếng Việt|English|Vietnamese|Slide tóm tắt)\)/gi, "").replace(/\s+/g, " ").trim()
            const label = holder && holder !== own ? `${holder.slice(0, 150)} (${own})` : own
            return { label, href: new URL(x.getAttribute("href") ?? "", "https://trungtamwto.vn").href }
          })
            .filter((x) => /\/(download|upload)\/|\.(pdf|docx?|xlsx?|zip|rar)(\?|$)/i.test(x.href))
          const blocks = [...box.querySelectorAll("p, li, h4, h5, tr")].filter((n) => !n.closest("tr") || n.tagName === "TR").map((n) => n.tagName === "TR" ? [...(n as HTMLTableRowElement).cells].map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | ") : (n.textContent ?? "").replace(/\s+/g, " ").trim())
          const text = (blocks.filter(Boolean).length ? blocks.filter(Boolean) : [(box.textContent ?? "").replace(/\s+/g, " ")]).join("\n")
          return { title, date, text, files }
        }, html)
        const text = a.text.replace(/\n{2,}/g, "\n").trim()
        recordEvidence(context?.sessionID, { url: u.href, title: a.title, text: `${a.title}\n${text}\n${a.files.map((f: any) => `${f.label} ${f.href}`).join("\n")}`, source: "fta", meta: { date: a.date, files: a.files.map((f: any) => f.href) } })
        const uniq = a.files.filter((f: any, i: number, arr: any[]) => arr.findIndex((x) => x.href === f.href) === i)
        // With a focus, the attachments whose label matches come first (a text page can list 100+ files).
        if (focus) uniq.sort((x: any, y: any) => Number(fold(y.label).includes(fold(focus))) - Number(fold(x.label).includes(fold(focus))))
        return withUi([
          `Tiêu đề: ${a.title}`,
          `Ngày đăng: ${a.date || "không hiển thị"} · Link: ${u.href}`,
          `Nguồn: trungtamwto.vn (Trung tâm WTO và Hội nhập – VCCI) · Ngày tra cứu: ${today()}`,
          uniq.length ? `Tệp đính kèm (${uniq.length}):\n${uniq.slice(0, 25).map((f: any) => `- ${f.label} → ${f.href}`).join("\n")}${uniq.length > 25 ? `\n- … (+${uniq.length - 25} tệp; dùng focus để tìm)` : ""}` : "Tệp đính kèm: không có",
          `--- NỘI DUNG${focus ? ` (các đoạn có "${focus}")` : ""} ---`,
          windows(text, focus, cap),
        ].join("\n"), { doc: { title: a.title, lang: "vi", issued: isoDate(a.date), url: u.href } })
      } catch (e: any) {
        if (e instanceof SiteDown) return downMessage(e.message)
        throw e
      }
    })
  },
})
