// Deterministic tools for the Trade Remedies Authority of Viet Nam (Cục Phòng vệ thương mại). Every request
// goes through the sandbox Chrome (DevTools port on 127.0.0.1:$CHROME_PORT, started by run.sh); list pages are
// fetched with fetch() INSIDE the page context (same origin, real browser) and parsed with DOMParser.
//   trav_search    – trav.gov.vn's own site search (?page=search&keyword=…): news on foreign investigations
//                    against Vietnamese goods, early-warning notices… → title, date, link, snippet
//   trav_measures  – public early-warning table of canhbaosom.trav.gov.vn (/GetInterventions, HTTP only –
//                    its HTTPS certificate is expired) grouped per measure, with duty rates per company
//   trav_page      – one trav.gov.vn article → clean text (capped), publication date, attachments
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import { count, isoDate, withUi } from "../lib/ui-meta.ts"
import puppeteer from "puppeteer-core"
import { recordEvidence } from "../lib/evidence.ts"
import { politeEval, politeGoto } from "../lib/polite.ts"
// Returns the tool output unchanged after recording it as evidence for grounding_check.
const rec = (context: any, url: string, source: string, out: string, title?: string) => (recordEvidence(context?.sessionID, { url, title, text: out, source }), out)

const PORT = process.env.CHROME_PORT ?? "9333"
const TRAV = "https://trav.gov.vn"
const CBS = "http://canhbaosom.trav.gov.vn"

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

// Page-text cache (search results, articles): trav_search → trav_page on the same item loads once.
const TTL_MS = 15 * 60 * 1000
const cache = new Map<string, { at: number; value: any }>()
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}

// ---------- trav.gov.vn news search ----------

const CATEGORIES: Record<string, string> = {
  foreign: "061fcf6d-54dd-4a7b-9293-33e0c3c218ad", // Tin điều tra của nước ngoài
  warning: "116d0b73-1399-4d78-91d9-bd883c1421c8", // Tin cảnh báo sớm
  vietnam: "91b07cf1-3658-4f39-b688-73b9e8ff8a05", // Tin điều tra của Việt Nam
  market: "d9ee2fcf-a0b1-446c-9bd9-87a14f695cd6", // Thị trường - Ngành hàng
}

// Vietnamese / English spellings of the usual investigating markets (used to filter titles and to map
// the canhbaosom country list, whose names are English).
const MARKETS: Record<string, string[]> = {
  "United States": ["hoa ky", "my", "us", "usa", "united states", "doc", "usitc", "itc"],
  "European Union": ["eu", "lien minh chau au", "chau au", "european union", "uy ban chau au"],
  "Australia": ["uc", "australia", "o xtray lia"],
  "India": ["an do", "india", "dgtr"],
  "Canada": ["canada", "ca na da"],
  "China": ["trung quoc", "china", "mofcom"],
  "South Korea": ["han quoc", "korea", "south korea"],
  "Thailand": ["thai lan", "thailand"],
  "Indonesia": ["indonesia", "in do ne xi a", "kadi"],
  "Malaysia": ["malaysia", "ma lai xi a"],
  "Philippines": ["philippines", "phi lip pin", "philippin"],
  "Mexico": ["mexico", "mehico", "me hi co", "mexi co"],
  "Brazil": ["brazil", "braxin", "bra xin", "brasil"],
  "Turkey": ["tho nhi ky", "turkey", "turkiye"],
  "United Kingdom": ["anh", "vuong quoc anh", "uk", "united kingdom", "tra"],
  "Russia": ["nga", "russia", "eaeu", "lien minh kinh te a au"],
  "Japan": ["nhat ban", "japan"],
  "Taiwan": ["dai loan", "taiwan"],
  "Egypt": ["ai cap", "egypt"],
  "South Africa": ["nam phi", "south africa"],
  "Pakistan": ["pakistan"],
  "Argentina": ["argentina", "ac hen ti na"],
  "Colombia": ["colombia", "co lom bi a"],
  "Peru": ["peru", "pe ru"],
  "Chile": ["chile", "chi le"],
  "Vietnam": ["viet nam", "vietnam", "vn"],
}

function marketName(input: string): string | null {
  const f = fold(input)
  for (const [name, aliases] of Object.entries(MARKETS)) if (fold(name) === f || aliases.includes(f)) return name
  return null
}

const containsWord = (hay: string, word: string) => ` ${hay} `.includes(` ${word} `)

type NewsItem = { title: string; date: string; tag: string; link: string; snippet?: string }

async function searchPage(page: any, keyword: string, p: number, category?: string): Promise<{ items: NewsItem[]; last: number }> {
  return cached(`s|${keyword}|${p}|${category ?? ""}`, () =>
    politeEval(TRAV, page, async (keyword: string, p: number, category: string | undefined) => {
      const u = `/default.aspx?page=search&keyword=${encodeURIComponent(keyword)}&p=${p}` + (category ? `&category_id=${category}` : "")
      const d = new DOMParser().parseFromString(await (await fetch(u, { credentials: "omit" })).text(), "text/html")
      const items = [...d.querySelectorAll(".news")].map((n) => {
        const a = n.querySelector(".news__title a") as HTMLAnchorElement | null
        return {
          title: (a?.textContent ?? "").trim(),
          date: (n.querySelector(".news__info")?.textContent ?? "").trim(),
          tag: (n.querySelector(".news__tag")?.textContent ?? "").trim(),
          link: a ? new URL(a.getAttribute("href") ?? "", location.origin + "/").href : "",
        }
      }).filter((x) => x.title && x.link)
      const pages = [...d.querySelectorAll("a")].map((a) => Number((a.getAttribute("href") ?? "").match(/[?&]p=(\d+)/)?.[1] ?? 0))
      return { items, last: Math.max(p, ...pages) }
    }, keyword, p, category))
}

// Normalised article link: https://trav.gov.vn/default.aspx?page=news-detail&do=detail&id=<guid>
function articleId(url: string) {
  const u = new URL(url)
  if (!/(^|\.)trav\.gov\.vn$|(^|\.)pvtm\.gov\.vn$/.test(u.hostname)) throw new Error("Chỉ nhận link bài viết trên trav.gov.vn (VD https://trav.gov.vn/default.aspx?page=news-detail&do=detail&id=...)")
  const id = u.searchParams.get("id")
  if (!id || !/news-detail/.test(u.searchParams.get("page") ?? "")) throw new Error("Link không phải trang bài viết trav.gov.vn (cần page=news-detail&id=...). Dùng trav_search để lấy link đúng.")
  return id
}
const articleUrl = (id: string) => `${TRAV}/default.aspx?page=news-detail&do=detail&id=${id}`

async function readArticle(page: any, id: string) {
  return cached(`a|${id}`, async () => {
    const res = await politeGoto(page, articleUrl(id), { waitUntil: "domcontentloaded", timeout: 60000 })
    if (!res || res.status() >= 400 || /GenericErrorPage/i.test(page.url())) throw new Error(`Trang ${articleUrl(id)} báo lỗi hoặc không tồn tại.`)
    return page.evaluate(() => {
      const post = document.querySelector("article.post")
      const content = post?.querySelector(".post__content") as HTMLElement | null
      const title = (post?.querySelector(".post__title")?.textContent ?? document.title).trim()
      const crumbs = [...(post?.querySelectorAll(".breadcrumb-item") ?? [])].map((x) => (x.textContent ?? "").trim())
      const files = [...(content?.querySelectorAll("a[href]") ?? [])]
        .map((a) => ({ text: (a.textContent ?? "").trim(), href: (a as HTMLAnchorElement).href }))
        .filter((x) => /\/(data|file|userfiles)\/|\.(pdf|docx?|xlsx?|zip|rar)(\?|$)/i.test(x.href))
      return { title, category: crumbs[crumbs.length - 1] ?? "", text: (content?.innerText ?? "").replace(/ /g, " "), files }
    })
  })
}

function snippetOf(text: string, keyword: string, len = 220) {
  const flat = text.replace(/\s+/g, " ").trim()
  // Centre on the keyword when it appears verbatim (after the lead sentence), else take the lead.
  const at = flat.toLowerCase().indexOf(keyword.toLowerCase().trim())
  if (at < len - 60) return flat.slice(0, len) + (flat.length > len ? "…" : "")
  const start = Math.max(0, at - 60)
  return (start ? "…" : "") + flat.slice(start, start + len) + (flat.length > start + len ? "…" : "")
}

export const search = tool({
  description: "Tìm tin/vụ việc phòng vệ thương mại trên trav.gov.vn (Cục Phòng vệ thương mại) bằng ô tìm kiếm của chính trang: theo sản phẩm, mã HS hoặc thị trường (VD 'thép mạ kẽm', '7210', 'Hoa Kỳ', 'cá tra'). Có thể lọc thêm theo thị trường (market) và chuyên mục (foreign = Tin điều tra của nước ngoài đối với hàng VN, warning = Tin cảnh báo sớm, vietnam = Việt Nam điều tra hàng nhập khẩu). Trả về tiêu đề, ngày đăng, chuyên mục, link bài và đoạn trích ngắn; đọc toàn văn bằng trav_page.",
  args: {
    query: tool.schema.string().describe("Từ khóa: tên sản phẩm (tiếng Việt như trên trang), mã HS hoặc tên thị trường"),
    market: tool.schema.string().optional().describe("Lọc thêm theo thị trường điều tra, VD 'Hoa Kỳ', 'EU', 'Úc', 'Ấn Độ' (lọc trên tiêu đề/đoạn trích)"),
    category: tool.schema.enum(["all", "foreign", "warning", "vietnam", "market"]).optional().describe("Chuyên mục: all (mặc định), foreign, warning, vietnam, market"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa (mặc định 8, tối đa 20)"),
  },
  async execute({ query, market, category, limit }, context) {
    const max = Math.min(limit ?? 8, 20)
    const cat = category && category !== "all" ? CATEGORIES[category] : undefined
    const mName = market ? marketName(market) : null
    const mWords = market ? [fold(market), ...(mName ? MARKETS[mName] : [])].filter((w) => w.length > 1) : []
    return withPage(async (page) => {
      await politeGoto(page, `${TRAV}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 60000 })
      const found: NewsItem[] = []
      let total = 1
      // With a market filter we scan a few more result pages, since the site matches the keyword only.
      const maxPages = market ? 5 : Math.ceil(max / 10) + 1
      for (let p = 1; p <= Math.min(total, maxPages) && found.length < max; p++) {
        const { items, last } = await searchPage(page, query, p, cat)
        total = last
        for (const it of items) {
          if (found.length >= max) break
          if (found.some((x) => x.link === it.link)) continue
          if (mWords.length) {
            const t = fold(it.title)
            if (!mWords.some((w) => containsWord(t, w))) continue
          }
          found.push(it)
        }
      }
      if (!found.length) return withUi(`Không có kết quả trên trav.gov.vn cho "${query}"${market ? ` (thị trường: ${market})` : ""}. Thử từ khóa ngắn hơn (VD chỉ tên sản phẩm), mã HS 4 số, hoặc bỏ bộ lọc.`, { res: count(0, "news") })
      // Short snippets: open each article (same-origin fetch, parallel) and take the first sentences.
      await Promise.all(found.map(async (it) => {
        const id = new URL(it.link).searchParams.get("id") ?? ""
        it.link = articleUrl(id)
        it.snippet = await cached(`snip|${id}|${query}`, () => politeEval(TRAV, page, async (u: string) => {
          const d = new DOMParser().parseFromString(await (await fetch(u, { credentials: "omit" })).text(), "text/html")
          return ((d.querySelector(".post__content") as HTMLElement | null)?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 4000)
        }, it.link).then((t: string) => snippetOf(t, query), () => ""))
      }))
      return withUi(rec(context, `https://trav.gov.vn/default.aspx?page=search&q=${encodeURIComponent(query)}`, "trav_search", [
        `Kết quả tìm "${query}" trên trav.gov.vn${market ? ` · thị trường: ${market}` : ""}${cat ? ` · chuyên mục: ${category}` : ""} (${found.length} bài, mới nhất trước):`,
        ...found.map((x, i) => `${i + 1}. [${x.date}] ${x.title}\n   ${x.tag} · ${x.link}${x.snippet ? `\n   ${x.snippet}` : ""}`),
        `(nguồn: trav.gov.vn, tra ngày ${today()}; đọc toàn văn bằng trav_page)`,
      ].join("\n")), { res: count(found.length, "news") })
    })
  },
})

// ---------- canhbaosom.trav.gov.vn: measures in force ----------

const TYPES: Record<string, string> = { sg: "11", "tu ve": "11", safeguard: "11", cvd: "12", "chong tro cap": "12", subsidy: "12", countervailing: "12", ad: "13", "chong ban pha gia": "13", antidumping: "13", "anti dumping": "13", "lan tranh": "14", "chong lan tranh": "14", "chong gian lan": "14", circumvention: "14", "gian lan": "14" }

type Row = { id: string; type: string; jur: string; aff: string; hs: string; en: string; vi: string; init: string; prov: string; final: string; end: string; company: string; rate: string }

async function countryIds(page: any): Promise<Record<string, string>> {
  return cached("cbs-countries", () => page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll("select[name=sJurisdictionCountryID] option")].map((o) => [(o.textContent ?? "").trim(), (o as HTMLOptionElement).value]))))
}

function countryId(ids: Record<string, string>, input: string) {
  const name = marketName(input) ?? input
  const hit = Object.keys(ids).find((k) => fold(k) === fold(name)) ?? Object.keys(ids).find((k) => fold(k).startsWith(fold(name)))
  return hit ? { name: hit, id: ids[hit] } : null
}

export const measures = tool({
  description: "Tra CSDL cảnh báo sớm của Cục PVTM (canhbaosom.trav.gov.vn, bảng công khai 'Biện pháp phòng vệ thương mại của các nước'): các biện pháp AD/CVD/tự vệ/chống lẩn tránh ĐANG CÓ HIỆU LỰC (hoặc đã hết) mà một thị trường áp dụng với hàng Việt Nam, lọc theo tên hàng (tiếng Anh hoặc tiếng Việt, VD 'galvanized', 'thép mạ kẽm', 'shrimp'), mã HS (tiền tố, VD '7210') và nước áp dụng (VD 'Hoa Kỳ', 'EU', 'Úc'). Gộp theo từng biện pháp: loại, nước, sản phẩm, ngày khởi xướng/tạm thời/chính thức/chấm dứt, mã HS, MỨC THUẾ THEO DOANH NGHIỆP. Dữ liệu do Cục PVTM tổng hợp – đối chiếu với văn bản gốc của nước nhập khẩu (VD fedreg_*) trước khi kết luận.",
  args: {
    product: tool.schema.string().optional().describe("Tên hàng hóa (tiếng Anh hoặc Việt), VD 'galvanized', 'steel', 'tôm', 'thép mạ kẽm'"),
    hs: tool.schema.string().optional().describe("Mã HS hoặc tiền tố mã HS, VD '7210', '721049'"),
    market: tool.schema.string().optional().describe("Nước áp dụng biện pháp, VD 'Hoa Kỳ', 'EU', 'Úc', 'Ấn Độ', 'Canada'"),
    affected: tool.schema.string().optional().describe("Nước bị áp dụng (mặc định 'Vietnam')"),
    type: tool.schema.string().optional().describe("Loại biện pháp: AD (chống bán phá giá), CVD (chống trợ cấp), SG (tự vệ), 'lẩn tránh'"),
    company: tool.schema.string().optional().describe("Chỉ hiện mức thuế của doanh nghiệp có tên chứa chuỗi này (VD 'Hoa Sen', 'Hoa Phat')"),
    in_force: tool.schema.boolean().optional().describe("true = còn hiệu lực (mặc định), false = đã hết hiệu lực"),
    limit: tool.schema.number().optional().describe("Số biện pháp tối đa (mặc định 8)"),
    pages: tool.schema.number().optional().describe("Số trang bảng (20 dòng/trang) được quét, mặc định 30, tối đa 60"),
  },
  async execute({ product, hs, market, affected, type, company, in_force, limit, pages }, context) {
    return withPage(async (page) => {
      await politeGoto(page, `${CBS}/GetInterventions?page=1&vJCountryID=-1&vAffCountryID=-1&vInForce=1&vTypeID=-1`, { waitUntil: "domcontentloaded", timeout: 60000 })
      const ids = await countryIds(page)
      const jur = market ? countryId(ids, market) : null
      if (market && !jur) return `Không nhận ra thị trường "${market}" trong danh sách nước của canhbaosom.trav.gov.vn. Dùng tên tiếng Anh (VD 'United States', 'European Union', 'Australia').`
      const aff = countryId(ids, affected ?? "Vietnam")
      const typeId = type ? TYPES[fold(type)] : "-1"
      if (!typeId) return `Loại biện pháp "${type}" không hợp lệ; dùng AD, CVD, SG hoặc 'lẩn tránh'.`
      const q = new URLSearchParams({ vJCountryID: jur?.id ?? "-1", vAffCountryID: aff?.id ?? "-1", vInForce: in_force === false ? "0" : "1", vTypeID: typeId, Sectors: "1", vSort: "7" })
      if (product) q.set("strSearch", product)
      if (hs) q.set("Commodities", hs.replace(/[.\s]/g, ""))
      const qs = q.toString()
      const want = Math.min(Math.max(pages ?? 30, 1), 60)
      const scan = await page.evaluate(async (qs: string, want: number) => {
        const grab = async (p: number) => {
          const d = new DOMParser().parseFromString(await (await fetch(`/GetInterventions/Index?${qs}&page=${p}`, { credentials: "omit" })).text(), "text/html")
          const rows = [...d.querySelectorAll("table tbody tr")].map((r) => [...(r as HTMLTableRowElement).cells].map((c) => (c.textContent ?? "").trim()))
          return rows
        }
        // The pager's "last page" link is unreliable (it overcounts), so read batches of pages until one
        // comes back short/empty.
        const all: string[][] = []
        let done = false
        let read = 0
        for (let p = 1; p <= want && !done; p += 10) {
          const batch = await Promise.all(Array.from({ length: Math.min(10, want - p + 1) }, (_, k) => grab(p + k)))
          for (const rows of batch) { read++; all.push(...rows); if (rows.length < 20) { done = true; break } }
        }
        return { rows: all, read, done }
      }, qs, want)
      const rows: Row[] = scan.rows.filter((c: string[]) => c.length >= 14).map((c: string[]) => ({ id: c[1], type: c[2], jur: c[3], aff: c[4], hs: c[5], en: c[6], vi: c[7], init: c[8], prov: c[9], final: c[10], end: c[11], company: c[12], rate: c[13] }))
      const link = `${CBS}/GetInterventions/Index?${qs}`
      const filters = [product && `hàng hóa "${product}"`, hs && `HS ${hs}`, jur && `nước áp dụng ${jur.name}`, aff && `nước bị áp dụng ${aff.name}`, type && `loại ${type}`, in_force === false ? "đã hết hiệu lực" : "còn hiệu lực"].filter(Boolean).join(", ")
      if (!rows.length) return withUi(`Không có biện pháp nào khớp (${filters}) trong CSDL cảnh báo sớm (${link}). Thử tên hàng tiếng Anh/Việt khác, bỏ bớt bộ lọc, hoặc tìm tin bằng trav_search.`, { res: count(0, "measures") })
      const groups = new Map<string, { r: Row; hs: Set<string>; firms: Map<string, Set<string>> }>()
      for (const r of rows) {
        const g = groups.get(r.id) ?? { r, hs: new Set(), firms: new Map() }
        g.hs.add(r.hs)
        if (!company || fold(r.company).includes(fold(company))) {
          const rates = g.firms.get(r.company) ?? new Set()
          // Rows of one measure can carry different stages (provisional vs final) – show the date when it differs.
          rates.add((r.rate === "%" || !r.rate ? "(không ghi mức thuế)" : r.rate) + (r.final && r.final !== g.r.final ? ` (chính thức ${r.final})` : ""))
          g.firms.set(r.company, rates)
        }
        groups.set(r.id, g)
      }
      const matching = [...groups.values()].filter((g) => !company || g.firms.size)
      if (!matching.length) return withUi(`Có ${groups.size} biện pháp khớp (${filters}) nhưng không có doanh nghiệp nào chứa "${company}" (${link}). Thử cách viết khác (không dấu / tiếng Anh, VD 'Hoa Sen Group', 'Ton Dong A').`, { res: count(0, "measures") })
      const list = matching.slice(0, limit ?? 8)
      const d = (s: string) => s || "—"
      return withUi(rec(context, link, "canhbaosom.trav.gov.vn", [
        `CSDL cảnh báo sớm Cục PVTM – ${filters}. Đã đọc ${rows.length} dòng (${scan.read} trang${scan.done ? ", hết dữ liệu" : ", CHƯA hết"}; mới khởi xướng trước) → ${matching.length} biện pháp${matching.length > list.length ? `, hiện ${list.length}` : ""}.`,
        ...list.map((g, i) => {
          const hsList = [...g.hs]
          const firms = [...g.firms.entries()]
          return [
            `${i + 1}. [${g.r.type}] ${g.r.jur} → ${g.r.aff}: ${g.r.vi || g.r.en}${g.r.en && g.r.vi ? ` (${g.r.en})` : ""} · mã GTA ${g.r.id}`,
            `   Khởi xướng ${d(g.r.init)} · tạm thời ${d(g.r.prov)} · chính thức ${d(g.r.final)} · chấm dứt ${d(g.r.end)}`,
            `   HS (${hsList.length}): ${hsList.slice(0, 8).join(", ")}${hsList.length > 8 ? ", …" : ""}`,
            `   Mức thuế: ${firms.length ? firms.slice(0, 12).map(([f, r]) => `${f}: ${[...r].join("/")}`).join("; ") + (firms.length > 12 ? `; … (+${firms.length - 12} DN)` : "") : "—"}`,
          ].join("\n")
        }),
        !scan.done ? `Lưu ý: còn dữ liệu sau trang ${scan.read} – lọc hẹp hơn (HS/tên hàng/nước) hoặc tăng pages.` : "",
        `Nguồn: ${link} (tra ngày ${today()}). Dữ liệu tổng hợp, có thể chưa cập nhật kết quả rà soát mới nhất – đối chiếu văn bản gốc.`,
      ].filter(Boolean).join("\n")), { res: count(matching.length, "measures") })
    })
  },
})

// ---------- trav.gov.vn article ----------

export const page = tool({
  description: "Đọc một bài trên trav.gov.vn (link từ trav_search): trả về tiêu đề, chuyên mục, ngày đăng (lấy từ kết quả tìm kiếm của trang), nội dung đã làm sạch (tối đa ~8000 ký tự), các tệp đính kèm (thông báo gốc PDF…), link và ngày tra cứu.",
  args: {
    url: tool.schema.string().describe("Link bài viết https://trav.gov.vn/default.aspx?page=news-detail&do=detail&id=..."),
    max_chars: tool.schema.number().optional().describe("Số ký tự nội dung tối đa (mặc định 8000)"),
  },
  async execute({ url, max_chars }, context) {
    const id = articleId(url)
    return withPage(async (page) => {
      const a = await readArticle(page, id)
      if (!a.text.trim()) return `Bài ${articleUrl(id)} không có nội dung văn bản (có thể chỉ có tệp đính kèm).${a.files.length ? "\nTệp: " + a.files.map((f: any) => f.href).join("\n") : ""}`
      // The article page does not show its date; look the title up in the site search to get it.
      let date = ""
      try {
        const key = a.title.split(/\s+/).slice(0, 10).join(" ")
        const { items } = await searchPage(page, key, 1)
        date = items.find((x) => x.link.includes(id))?.date ?? ""
      } catch {}
      const cap = max_chars ?? 8000
      const text = a.text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()
      recordEvidence(context?.sessionID, { url: articleUrl(id), title: a.title, text, source: "trav.gov.vn" })
      return withUi([
        `Tiêu đề: ${a.title}`,
        `Chuyên mục: ${a.category || "không rõ"} · Ngày đăng: ${date || "không hiển thị trên trang"}`,
        `Link: ${articleUrl(id)}`,
        `Ngày tra cứu: ${today()}`,
        a.files.length ? `Tệp đính kèm: ${a.files.slice(0, 5).map((f: any) => f.href).join(" ; ")}` : "",
        "--- NỘI DUNG ---",
        text.slice(0, cap) + (text.length > cap ? `\n…(cắt, còn ${text.length - cap} ký tự)` : ""),
      ].filter(Boolean).join("\n"), { doc: { title: a.title, lang: "vi", issued: isoDate(date), accessed: isoDate(today()), url: articleUrl(id), agency: "trav" } })
    })
  },
})
