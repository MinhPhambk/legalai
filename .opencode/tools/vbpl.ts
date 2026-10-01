// Deterministic vbpl.vn tools for the legal agent. Every page is loaded through the sandbox Chrome
// (DevTools port on 127.0.0.1:$CHROME_PORT, started by run.sh) so the agent never has to click around,
// guess URLs or read whole 190k-character statutes into its context.
//   vbpl_find       – find documents by title / number using vbpl.vn's own public sitemaps
//                     (the on-site search box is behind reCAPTCHA, which we do not bypass)
//   vbpl_document   – attributes (số hiệu, loại, ngày ban hành/hiệu lực, tình trạng hiệu lực…) + article list
//   vbpl_article    – verbatim text of one article ("Điều N") with status, link and access date
//   vbpl_verify     – check that a quoted passage really appears on a vbpl.vn page
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import puppeteer from "puppeteer-core"
import { recordEvidence } from "../lib/evidence.ts"
import { politeGoto } from "../lib/polite.ts"
import { count, isoDate, statusCode, withUi } from "../lib/ui-meta.ts"
import fs from "node:fs"
import path from "node:path"

const PORT = process.env.CHROME_PORT ?? "9333"
const CACHE = path.join(process.env.XDG_CACHE_HOME ?? ".", "legalai")
const SITEMAP_TTL_MS = 24 * 3600 * 1000
const STATUSES = ["Còn hiệu lực", "Hết hiệu lực một phần", "Hết hiệu lực toàn bộ", "Chưa có hiệu lực", "Ngưng hiệu lực một phần", "Ngưng hiệu lực toàn bộ", "Ngưng hiệu lực", "Không còn phù hợp"]
const ATTR_LABELS = ["Số hiệu", "Loại văn bản", "Ngành", "Ngày ban hành", "Lĩnh vực", "Ngày có hiệu lực", "Tình trạng hiệu lực", "Ngày hết hiệu lực", "Cơ quan ban hành", "Chức danh", "Người ký"]

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

function assertVbpl(url: string) {
  const u = new URL(url)
  if (u.hostname !== "vbpl.vn" || !u.pathname.startsWith("/van-ban/chi-tiet/")) throw new Error("Chỉ nhận link trang chi tiết văn bản dạng https://vbpl.vn/van-ban/chi-tiet/...")
  return u.href
}

// Vietnamese text → ascii slug tokens, matching how vbpl.vn builds its URLs.
const slugify = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

async function centralSitemapUrls(): Promise<string[]> {
  fs.mkdirSync(CACHE, { recursive: true })
  const file = path.join(CACHE, "vbpl-sitemap-trung-uong.json")
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < SITEMAP_TTL_MS) return JSON.parse(fs.readFileSync(file, "utf8"))
  const urls = await withPage(async (page) => {
    const get = async (u: string) => (await (await politeGoto(page, u, { waitUntil: "domcontentloaded", timeout: 60000 }))?.text()) ?? ""
    const index = await get("https://vbpl.vn/sitemap.xml")
    // The index groups sitemaps under XML comments ("Trang tĩnh", "Trung ương", "Địa phương"…); keep the central group.
    const central = index.split("<!--").find((part) => /Trung\s*ương/i.test(part.split("-->")[0])) ?? index
    const maps = [...central.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    const all: string[] = []
    for (const m of maps) all.push(...[...(await get(m)).matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1]))
    return all.filter((u) => u.includes("/van-ban/chi-tiet/"))
  })
  fs.writeFileSync(file, JSON.stringify(urls))
  return urls
}

// Page text is cached for a while so vbpl_document → vbpl_article → vbpl_verify on the same document
// load it once. Waiting for "networkidle" is slow here (reCAPTCHA, analytics), so wait for the document
// body to render and stop growing instead.
const PAGE_TTL_MS = 15 * 60 * 1000
const pageCache = new Map<string, { at: number; text: string; title: string }>()

async function openDocument(page: any, url: string, tab?: string) {
  const key = `${url}#${tab ?? ""}`
  const hit = pageCache.get(key)
  if (hit && Date.now() - hit.at < PAGE_TTL_MS) return hit
  await politeGoto(page, url, { waitUntil: "domcontentloaded", timeout: 90000 })
  const rendered = await page.waitForFunction(() => document.body.innerText.length > 1500, { timeout: 20000 }).then(() => true, () => false)
  if (!rendered) throw new Error(`Trang ${url} không hiển thị nội dung văn bản (link sai hoặc văn bản không tồn tại). Dùng vbpl_find để lấy link đúng.`)
  // Let streamed content finish: stop once the text length is stable for one poll (max ~6 s).
  for (let k = 0, last = -1; k < 8; k++) {
    const len = await page.evaluate(() => document.body.innerText.length)
    if (len === last) break
    last = len
    await new Promise((r) => setTimeout(r, 700))
  }
  if (tab) {
    const [el] = await page.$$(`xpath/.//*[@role="tab"][normalize-space()="${tab}"]`)
    if (el) { await el.click(); await new Promise((r) => setTimeout(r, 1500)) }
  }
  const out = { at: Date.now(), text: (await page.evaluate(() => document.body.innerText)) as string, title: ((await page.title()) as string).split("|")[0].trim() }
  pageCache.set(key, out)
  return out
}

function headerInfo(text: string, title: string) {
  const i = text.indexOf(title)
  const head = i >= 0 ? text.slice(i, i + 400) : text.slice(0, 1500)
  return {
    status: STATUSES.find((s) => head.includes(s)) ?? null,
    effective: head.match(/Ngày có hiệu lực:\s*([\d/]+)/)?.[1] ?? null,
    updated: head.match(/Ngày cập nhật:\s*([\d/]+)/)?.[1] ?? null,
  }
}

function parseAttributes(text: string) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  const out: Record<string, string> = {}
  for (let k = 0; k < lines.length - 1; k++) if (ATTR_LABELS.includes(lines[k]) && !(lines[k] in out)) out[lines[k]] = lines[k + 1]
  return out
}

// Articles: "Điều 301. Mức phạt vi phạm" … up to the next "Điều N." / "Chương" heading.
const ARTICLE_RE = /^Điều\s+(\d+[a-zđ]?)\s*[.:]\s*(.*)$/

function splitArticles(text: string) {
  const lines = text.split("\n")
  const arts: { no: string; heading: string; start: number; end: number }[] = []
  lines.forEach((l, idx) => {
    const m = l.trim().match(ARTICLE_RE)
    if (m) { if (arts.length) arts[arts.length - 1].end = idx; arts.push({ no: m[1], heading: m[2].trim(), start: idx, end: lines.length }) }
  })
  return { lines, arts }
}

const norm = (s: string) => s.replace(/[“”"«»]/g, '"').replace(/[‘’']/g, "'").replace(/\s+/g, " ").trim().toLowerCase()

export const find = tool({
  description: "Tìm văn bản pháp luật trung ương trên vbpl.vn theo TÊN hoặc SỐ HIỆU văn bản (VD 'Luật Thương mại 2005', '36/2005/QH11', 'Bộ luật Dân sự 2015', 'nghị định phòng vệ thương mại'). Chỉ khớp tên/số hiệu, KHÔNG tìm theo nội dung: với câu hỏi theo chủ đề (VD 'mức phạt vi phạm hợp đồng'), hãy xác định luật điều chỉnh rồi tìm luật đó, sau đó dùng vbpl_search_articles. Trả về link trang chi tiết thật; luôn dùng công cụ này thay vì tự đoán URL.",
  args: {
    query: tool.schema.string().describe("Tên văn bản, từ khóa hoặc số hiệu"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa (mặc định 8)"),
  },
  async execute({ query, limit }) {
    const urls = await centralSitemapUrls()
    const q = slugify(query)
    const numberish = /\d/.test(q)
    const tokens = q.split("-").filter((t) => t.length > 1 || /\d/.test(t))
    const scored = urls.map((u) => {
      const slug = decodeURIComponent(u.split("/van-ban/chi-tiet/")[1] ?? "").replace(/--[\w-]+$/, "")
      let score = 0
      for (const t of tokens) if (slug.includes(t)) score += /\d/.test(t) ? 3 : 1
      if (numberish && slug.includes(q)) score += 10
      if (slug.startsWith("van-ban-hop-nhat")) score -= 0.5 // prefer the original act; consolidated texts listed after
      return { u, slug, score }
    }).filter((x) => x.score >= Math.max(1, tokens.length * 0.6)).sort((a, b) => b.score - a.score).slice(0, limit ?? 8)
    if (!scored.length) return withUi(`Không tìm thấy văn bản khớp "${query}" trong sitemap vbpl.vn (${urls.length} văn bản trung ương). Thử từ khóa khác hoặc số hiệu.`, { res: count(0, "docs") })
    return withUi(scored.map((x, i) => `${i + 1}. ${x.slug.replace(/-/g, " ")}\n   ${x.u}`).join("\n") + `\n(nguồn: sitemap vbpl.vn, tra ngày ${today()})`, { res: count(scored.length, "docs") })
  },
})

export const document = tool({
  description: "Mở một văn bản trên vbpl.vn (link từ vbpl_find) và trả về thuộc tính chính thức: số hiệu, loại, cơ quan ban hành, ngày ban hành, ngày có hiệu lực, TÌNH TRẠNG HIỆU LỰC, ngày hết hiệu lực, người ký, cùng danh sách các Điều (số + tên điều) để chọn điều cần trích.",
  args: {
    url: tool.schema.string().describe("Link https://vbpl.vn/van-ban/chi-tiet/..."),
    max_articles: tool.schema.number().optional().describe("Số điều tối đa liệt kê (mặc định 400)"),
  },
  async execute({ url, max_articles }, context) {
    const href = assertVbpl(url)
    return withPage(async (page) => {
      const { text: content, title } = await openDocument(page, href)
      recordEvidence(context?.sessionID, { url: href, title, text: content, source: "vbpl.vn" })
      const h = headerInfo(content, title)
      const { arts } = splitArticles(content)
      const { text: attrsText } = await openDocument(page, href, "Thuộc tính")
      recordEvidence(context?.sessionID, { url: href, title, text: attrsText, source: "vbpl.vn", meta: { tab: "Thuộc tính" } })
      const attrs = parseAttributes(attrsText)
      const list = arts.slice(0, max_articles ?? 400).map((a) => `Điều ${a.no}. ${a.heading}`.slice(0, 120))
      const status = statusCode(attrs["Tình trạng hiệu lực"] ?? h.status)
      const ui = {
        ...(status ? { res: { t: "status", code: status } } : {}),
        doc: { title, lang: "vi", number: attrs["Số hiệu"], status, issued: isoDate(attrs["Ngày ban hành"]), effective: isoDate(attrs["Ngày có hiệu lực"]), agency: attrs["Cơ quan ban hành"], accessed: isoDate(today()), url: href },
      }
      return withUi([
        `Văn bản: ${title}`,
        `Link: ${href}`,
        `Tình trạng hiệu lực: ${attrs["Tình trạng hiệu lực"] ?? h.status ?? "không rõ"}`,
        ...ATTR_LABELS.filter((k) => k !== "Tình trạng hiệu lực" && attrs[k]).map((k) => `${k}: ${attrs[k]}`),
        h.updated ? `Ngày cập nhật trên vbpl.vn: ${h.updated}` : "",
        `Ngày tra cứu: ${today()}`,
        `Số điều: ${arts.length}${arts.length > list.length ? ` (liệt kê ${list.length} điều đầu)` : ""}`,
        list.join("\n"),
      ].filter(Boolean).join("\n"), ui)
    })
  },
})

export const article = tool({
  description: "Trích NGUYÊN VĂN một điều luật từ văn bản trên vbpl.vn (VD article='301' hoặc 'Điều 301'), kèm tên văn bản, tình trạng hiệu lực, link và ngày tra cứu. Dùng kết quả này để trích dẫn; không diễn đạt lại trong phần trích.",
  args: {
    url: tool.schema.string().describe("Link https://vbpl.vn/van-ban/chi-tiet/..."),
    article: tool.schema.string().describe("Số điều, VD '301', '4a' hoặc 'Điều 301'"),
  },
  async execute({ url, article }, context) {
    const href = assertVbpl(url)
    const no = article.replace(/^\s*điều\s*/i, "").replace(/[.\s]+$/, "").trim()
    return withPage(async (page) => {
      const { text: content, title } = await openDocument(page, href)
      recordEvidence(context?.sessionID, { url: href, title, text: content, source: "vbpl.vn" })
      const h = headerInfo(content, title)
      const { lines, arts } = splitArticles(content)
      const hit = arts.filter((a) => a.no.toLowerCase() === no.toLowerCase())
      if (!hit.length) return `Không tìm thấy "Điều ${no}" trong ${title} (${href}). Văn bản có ${arts.length} điều; dùng vbpl_document để xem danh sách.`
      // Consolidated texts can repeat an article number (e.g. in amending sections) – return every match.
      const parts = hit.map((a) => lines.slice(a.start, a.end).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000))
      const status = statusCode(h.status)
      const ui = {
        res: { t: "title", v: hit[0].heading, lang: "vi" },
        article: { n: hit[0].no, title: hit[0].heading, lang: "vi" },
        doc: { title, lang: "vi", status, effective: isoDate(h.effective), accessed: isoDate(today()), url: href },
      }
      return withUi([
        `Văn bản: ${title}`,
        `Tình trạng hiệu lực của văn bản: ${h.status ?? "không rõ"}${h.effective ? ` · Ngày có hiệu lực: ${h.effective}` : ""}`,
        `Link: ${href}`,
        `Ngày tra cứu: ${today()}`,
        hit.length > 1 ? `Lưu ý: có ${hit.length} đoạn mang số "Điều ${no}" trong trang.` : "",
        "--- NGUYÊN VĂN ---",
        parts.join("\n\n--- (đoạn khác cùng số điều) ---\n\n"),
      ].filter(Boolean).join("\n"), ui)
    })
  },
})

export const search_articles = tool({
  description: "Tìm trong MỘT văn bản trên vbpl.vn các Điều có chứa từ khóa (trong tên điều hoặc nội dung), VD url=Luật Thương mại, keywords='phạt vi phạm'. Trả về số điều, tên điều và đoạn chứa từ khóa, xếp theo mức liên quan. Dùng để xác định điều cần trích trước khi gọi vbpl_article.",
  args: {
    url: tool.schema.string().describe("Link https://vbpl.vn/van-ban/chi-tiet/..."),
    keywords: tool.schema.string().describe("Từ khóa tiếng Việt, VD 'phạt vi phạm', 'bồi thường thiệt hại', 'bất khả kháng'"),
    limit: tool.schema.number().optional().describe("Số điều tối đa (mặc định 8)"),
  },
  async execute({ url, keywords, limit }, context) {
    const href = assertVbpl(url)
    return withPage(async (page) => {
      const { text: content, title } = await openDocument(page, href)
      recordEvidence(context?.sessionID, { url: href, title, text: content, source: "vbpl.vn" })
      const { lines, arts } = splitArticles(content)
      const phrase = norm(keywords)
      const words = phrase.split(" ").filter((w) => w.length > 1)
      const scored = arts.map((a) => {
        const heading = norm(a.heading)
        const body = norm(lines.slice(a.start, a.end).join(" "))
        let score = 0
        if (heading.includes(phrase)) score += 10
        else if (words.every((w) => heading.includes(w))) score += 6
        const hits = body.split(phrase).length - 1
        score += Math.min(hits, 5) * 2
        if (!hits && words.every((w) => body.includes(w))) score += 1
        const at = body.indexOf(phrase)
        const snippet = at >= 0 ? body.slice(Math.max(0, at - 120), at + 200) : body.slice(0, 200)
        return { a, score, snippet }
      }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score).slice(0, limit ?? 8)
      if (!scored.length) return withUi(`Không có điều nào trong ${title} chứa "${keywords}". Thử từ khóa khác hoặc xem danh sách điều bằng vbpl_document.`, { res: count(0, "articles") })
      return withUi([`Văn bản: ${title}`, `Link: ${href}`, `Các điều liên quan tới "${keywords}":`,
        ...scored.map((x) => `- Điều ${x.a.no}. ${x.a.heading}\n  …${x.snippet}…`),
        `Tiếp theo: gọi vbpl_article(url, "<số điều>") để lấy nguyên văn.`].join("\n"), { res: count(scored.length, "articles") })
    })
  },
})

export const history = tool({
  description: "Lịch sử hiệu lực và quan hệ của một văn bản trên vbpl.vn: các mốc (ban hành, có hiệu lực, bị sửa đổi/bổ sung/bãi bỏ/thay thế một phần hoặc toàn bộ) kèm VĂN BẢN GÂY RA thay đổi và link của nó; cùng các nhóm văn bản liên quan (hướng dẫn thi hành, bị/được tác động hiệu lực, dẫn chiếu, hợp nhất…). Dùng khi văn bản 'Hết hiệu lực một phần' để biết điều cần trích có bị sửa không.",
  args: {
    url: tool.schema.string().describe("Link https://vbpl.vn/van-ban/chi-tiet/..."),
    max_items: tool.schema.number().optional().describe("Số văn bản tối đa mỗi nhóm trong lược đồ (mặc định 6)"),
  },
  async execute({ url, max_items }, context) {
    const href = assertVbpl(url)
    return withPage(async (page) => {
      const { title, text: histBase } = await openDocument(page, href)
      recordEvidence(context?.sessionID, { url: href, title, text: histBase, source: "vbpl.vn" })
      const readTab = async (tab: string) => {
        const [el] = await page.$$(`xpath/.//*[@role="tab"][normalize-space()="${tab}"]`)
        if (!el) return { text: "", links: [] as { name: string; href: string }[] }
        await el.click()
        await new Promise((r) => setTimeout(r, 2500))
        return page.evaluate(() => {
          const act = document.querySelector('[role=tabpanel]:not([aria-hidden=true]), .ant-tabs-tabpane-active') as HTMLElement | null
          const links = [...(act ?? document).querySelectorAll("a[href]")].map((a) => ({ name: (a as HTMLElement).innerText.trim(), href: (a as HTMLAnchorElement).href.replace(/\?.*$/, "") })).filter((l) => l.href.includes("/van-ban/chi-tiet/"))
          return { text: act?.innerText ?? "", links }
        })
      }
      // Lịch sử: rows "dd/mm/yyyy <tab> event <tab> source document"
      const hist = await readTab("Lịch sử")
      recordEvidence(context?.sessionID, { url: href, title, text: hist.text, source: "vbpl.vn", meta: { tab: "Lịch sử" } })
      const linkOf = (name: string) => hist.links.find((l) => l.name === name.trim())?.href
      const events = hist.text.split("\n").map((l) => l.split("\t").map((c) => c.trim()).filter(Boolean))
        .filter((c) => c.length >= 3 && /^\d{2}\/\d{2}\/\d{4}$/.test(c[0]))
        .map(([date, event, source]) => `- ${date}: ${event} — ${source}${linkOf(source) && !linkOf(source)!.startsWith(href) ? ` (${linkOf(source)})` : ""}`)
      // Lược đồ: "Group name (n)" followed by up to n document names
      const rel = await readTab("Lược đồ")
      recordEvidence(context?.sessionID, { url: href, title, text: rel.text, source: "vbpl.vn", meta: { tab: "Lược đồ" } })
      const lines = rel.text.split("\n").map((l) => l.trim()).filter(Boolean)
      const groups: string[] = []
      for (let k = 0; k < lines.length; k++) {
        const m = lines[k].match(/^(Văn bản .+|Căn cứ ban hành)\s*\((\d+)\)$/)
        if (!m || m[2] === "0") continue
        // Keep only groups that bear on validity; "áp dụng" / "dẫn chiếu" / "căn cứ" lists are hundreds of
        // loosely related (often provincial) documents and would flood the context.
        if (!/hiệu lực|sửa đổi|bổ sung|thay thế|bãi bỏ|hợp nhất|hướng dẫn|quy định chi tiết|đính chính|đình chỉ|tạm ngưng/i.test(m[1]) || /áp dụng$|dẫn chiếu|Căn cứ/i.test(m[1].trim())) continue
        const n = Number(m[2])
        const items = lines.slice(k + 1, k + 1 + Math.min(n, max_items ?? 6)).filter((x) => !/\(\d+\)$/.test(x) && x !== "--")
        groups.push(`${m[1]} (${n}):\n${items.map((x) => `  · ${x}`).join("\n")}${n > items.length ? `\n  · … còn ${n - items.length} văn bản` : ""}`)
      }
      return withUi([
        `Văn bản: ${title}`, `Link: ${href}`, `Ngày tra cứu: ${today()}`,
        "LỊCH SỬ HIỆU LỰC:", events.length ? events.join("\n") : "- (không có dữ liệu lịch sử)",
        "LƯỢC ĐỒ (nhóm có văn bản):", groups.length ? groups.join("\n") : "- (không có)",
        "Để xem văn bản liên quan: dùng vbpl_find với tên/số hiệu ở trên.",
      ].join("\n"), { res: count(events.length, "entries"), doc: { title, lang: "vi", accessed: isoDate(today()), url: href } })
    })
  },
})

export const verify = tool({
  description: "Kiểm tra một đoạn trích có thật sự xuất hiện trên trang văn bản vbpl.vn không (so khớp sau khi chuẩn hóa khoảng trắng, dấu nháy, chữ hoa/thường). Dùng trong bước citation-check cho mọi trích dẫn từ vbpl.vn.",
  args: {
    url: tool.schema.string().describe("Link https://vbpl.vn/van-ban/chi-tiet/..."),
    quote: tool.schema.string().describe("Đoạn trích cần kiểm tra (nguyên văn)"),
  },
  async execute({ url, quote }, context) {
    const href = assertVbpl(url)
    return withPage(async (page) => {
      const { text: content, title: vTitle } = await openDocument(page, href)
      recordEvidence(context?.sessionID, { url: href, title: vTitle, text: content, source: "vbpl.vn" })
      const hay = norm(content)
      const needle = norm(quote)
      if (hay.includes(needle)) return withUi(`KHỚP: đoạn trích có trên trang ${href} (kiểm tra ngày ${today()}).`, { res: { t: "verify", code: "match" } })
      // Report the best partial match so the agent can correct the quote instead of guessing.
      const words = needle.split(" ")
      let best = 0
      for (let n = words.length; n >= 4 && !best; n--) if (hay.includes(words.slice(0, n).join(" "))) best = n
      return withUi(`KHÔNG KHỚP: đoạn trích không có nguyên văn trên ${href}.${best ? ` Chỉ khớp ${best}/${words.length} từ đầu.` : ""} Hãy trích lại bằng vbpl_article thay vì sửa tay.`, { res: { t: "verify", code: "nomatch" } })
    })
  },
})
