// Deterministic WTO ePing (SPS/TBT notification) tools for the legal agent. Everything goes through the sandbox
// Chrome (DevTools port on 127.0.0.1:$CHROME_PORT, started by run.sh); the public JSON API that epingalert.org's
// own search page calls (/api/v1/azureSearch/getAll, /api/v1/countries/…, /api/v1/azureSearch/getDownloadLinks)
// is queried with fetch() INSIDE a page on epingalert.org (same origin, real browser, no login):
//   eping_search        – notifications by notifying member, SPS/TBT, keyword, product, HS code, date range,
//                         open-for-comment, "Viet Nam named as affected" → symbol, member, dates, title, HS, link
//   eping_notification  – one notification (G/TBT/N/EU/1100, G/SPS/N/JPN/1427/Add.1 …): full details,
//                         notified documents, WTO document links, related addenda/revisions/corrigenda
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import { count, isoDate, withUi } from "../lib/ui-meta.ts"
import puppeteer from "puppeteer-core"
import { recordEvidence } from "../lib/evidence.ts"
import { politeEval, politeGoto } from "../lib/polite.ts"

const PORT = process.env.CHROME_PORT ?? "9333"
const EPING = "https://epingalert.org"

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

const TTL_MS = 15 * 60 * 1000
const cache = new Map<string, { at: number; value: any }>()
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

// A light same-origin page (the API refuses cross-origin calls from about:blank).
async function open(page: any) {
  if (!page.url().startsWith(EPING)) {
    const res = await politeGoto(page, `${EPING}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 60000 })
    if (!res || res.status() >= 500) throw new Error(`epingalert.org không phản hồi (HTTP ${res?.status()}).`)
  }
}

async function api(page: any, pathAndQuery: string): Promise<any> {
  return cached(`a|${pathAndQuery}`, async () => {
    await open(page)
    const r = await politeEval(EPING, page, async (u: string) => {
      try {
        const res = await fetch(u, { headers: { Accept: "application/json" } })
        return { status: res.status, body: await res.text() }
      } catch (e: any) {
        return { status: 0, body: String(e?.message ?? e) }
      }
    }, pathAndQuery)
    if (r.status !== 200) throw new Error(`API ePing lỗi (HTTP ${r.status}) cho ${pathAndQuery.split("?")[0]}: ${r.body.slice(0, 160)}`)
    try { return JSON.parse(r.body) } catch { throw new Error("API ePing trả về dữ liệu không phải JSON.") }
  })
}

// Vietnamese / short names → the WTO member names of the ePing dropdown.
const ALIASES: Record<string, string> = {
  eu: "European Union", "lien minh chau au": "European Union", "chau au": "European Union", ec: "European Union",
  "hoa ky": "United States of America", my: "United States of America", us: "United States of America", usa: "United States of America", "united states": "United States of America",
  "trung quoc": "China", "nhat ban": "Japan", nhat: "Japan", "han quoc": "Korea, Republic of", korea: "Korea, Republic of", "south korea": "Korea, Republic of",
  uc: "Australia", "an do": "India", anh: "United Kingdom", uk: "United Kingdom", "vuong quoc anh": "United Kingdom", "thai lan": "Thailand",
  "dai loan": "Chinese Taipei", taiwan: "Chinese Taipei", nga: "Russian Federation", russia: "Russian Federation", "tho nhi ky": "Türkiye", turkey: "Türkiye",
  "viet nam": "Viet Nam", vietnam: "Viet Nam", vn: "Viet Nam", "a rap xe ut": "Saudi Arabia, Kingdom of", "saudi arabia": "Saudi Arabia, Kingdom of",
  "phi lip pin": "Philippines", philippin: "Philippines", "ma lai xi a": "Malaysia", "in do ne xi a": "Indonesia", "ai cap": "Egypt", "nam phi": "South Africa",
  "brazil": "Brazil", braxin: "Brazil", "mexico": "Mexico", "me hi co": "Mexico", "canada": "Canada", "new zealand": "New Zealand", "thuy si": "Switzerland",
  uae: "United Arab Emirates", "a rap": "United Arab Emirates", "israel": "Israel", chile: "Chile", "chi le": "Chile", peru: "Peru", "singapore": "Singapore",
}

async function members(page: any): Promise<{ value: string; text: string }[]> {
  const j = await api(page, "/api/v1/countries/getWtoMembersForDropdown?language=1")
  return j.items ?? []
}

async function memberCode(page: any, input: string) {
  const list = await members(page)
  const f = fold(input)
  const name = ALIASES[f] ?? input
  const hit = list.find((m) => fold(m.text) === fold(name)) ?? list.find((m) => fold(m.text).startsWith(fold(name))) ?? list.find((m) => fold(m.text).includes(fold(name)))
  return hit ?? null
}

const strip = (s: string | null | undefined) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim()
const d10 = (s: string | null | undefined) => (s ? s.slice(0, 10) : "")
const viewLink = (symbol: string) => `${EPING}/en/Search?viewData=${encodeURIComponent(symbol.trim())}`

type Item = Record<string, any>

export const search = tool({
  description: "Tìm thông báo SPS (vệ sinh dịch tễ, an toàn thực phẩm) / TBT (hàng rào kỹ thuật) gửi WTO trên ePing (epingalert.org – WTO/ITC/UN DESA) qua API công khai của chính trang: theo thành viên thông báo (VD 'EU', 'Hoa Kỳ', 'Nhật Bản'), lĩnh vực SPS/TBT, từ khóa tiếng Anh (VD 'shrimp', 'pesticide maximum residue', 'packaging'), mô tả sản phẩm, mã HS, khoảng ngày phân phát, chỉ các thông báo còn hạn góp ý, hoặc chỉ thông báo nêu Việt Nam là nước bị ảnh hưởng. Trả về ký hiệu (VD G/TBT/N/EU/1100), thành viên, ngày phân phát, hạn góp ý, tiêu đề, sản phẩm/HS, link. Chi tiết + tài liệu: eping_notification(symbol).",
  args: {
    query: tool.schema.string().optional().describe("Từ khóa tiếng Anh (mọi từ đều phải có), VD 'frozen shrimp', 'maximum residue limits', 'labelling'"),
    member: tool.schema.string().optional().describe("Thành viên thông báo / thị trường, VD 'EU', 'Hoa Kỳ', 'Japan', 'Trung Quốc', 'Hàn Quốc'"),
    area: tool.schema.enum(["SPS", "TBT", "all"]).optional().describe("SPS, TBT hoặc all (mặc định)"),
    product: tool.schema.string().optional().describe("Từ khóa trong phần 'sản phẩm' của thông báo, VD 'shrimp', 'rice', 'coffee'"),
    hs: tool.schema.string().optional().describe("Mã HS (2–6 số), VD '0306', '030617'; nhiều mã cách nhau bằng dấu phẩy"),
    date_from: tool.schema.string().optional().describe("Ngày phân phát từ (YYYY-MM-DD)"),
    date_to: tool.schema.string().optional().describe("Ngày phân phát đến (YYYY-MM-DD)"),
    open_for_comment: tool.schema.boolean().optional().describe("true = chỉ thông báo còn hạn góp ý"),
    affects_vietnam: tool.schema.boolean().optional().describe("true = chỉ thông báo nêu cụ thể Việt Nam trong danh sách nước bị ảnh hưởng"),
    order: tool.schema.enum(["newest", "relevance"]).optional().describe("newest (mặc định) hoặc relevance"),
    limit: tool.schema.number().optional().describe("Số kết quả tối đa (mặc định 10, tối đa 30)"),
  },
  async execute({ query, member, area, product, hs, date_from, date_to, open_for_comment, affects_vietnam, order, limit }, context) {
    const max = Math.min(Math.max(limit ?? 10, 1), 30)
    const iso = /^\d{4}-\d{2}-\d{2}$/
    if (date_from && !iso.test(date_from)) return "date_from phải có dạng YYYY-MM-DD"
    if (date_to && !iso.test(date_to)) return "date_to phải có dạng YYYY-MM-DD"
    return withPage(async (page) => {
      const q = new URLSearchParams({ page: "1", pageSize: String(Math.min(max * 2, 60)), language: "1" })
      if ((order ?? "newest") === "newest") { q.set("sortBy", "distributionDate"); q.set("sortDirection", "desc") }
      if (area && area !== "all") q.set("domainIds", area === "TBT" ? "1" : "2")
      let m: { value: string; text: string } | null = null
      if (member) {
        try { m = await memberCode(page, member) } catch (e: any) { return `Không truy cập được ePing: ${e?.message ?? e}` }
        if (!m) return `Không nhận ra thành viên WTO "${member}". Dùng tên tiếng Anh như trên ePing (VD 'European Union', 'United States of America', 'Japan', 'China').`
        q.set("countryIds", m.value)
      }
      const words = (query ?? "").split(/\s+/).filter(Boolean)
      if (words.length) q.set("freeText", words.map((w) => (/^[+-]/.test(w) ? w : `+${w}`)).join(" "))
      if (product) q.set("productFreeText", product)
      for (const h of (hs ?? "").split(/[,;\s]+/).map((x) => x.replace(/\D/g, "")).filter(Boolean)) q.append("hsCodes", h)
      if (date_from) q.set("distributionDateFrom", date_from)
      if (date_to) q.set("distributionDateTo", date_to)
      if (open_for_comment) q.set("checkCommentDeadline", "true")
      if (affects_vietnam) q.set("specificCountriesToBeAffected", "C704")
      let j: any
      try { j = await api(page, `/api/v1/azureSearch/getAll?${q}`) } catch (e: any) { return `Không truy vấn được ePing: ${e?.message ?? e}` }
      const seen = new Set<string>()
      const items: Item[] = (j.items ?? []).filter((x: Item) => !seen.has(x.id) && seen.add(x.id)).slice(0, max)
      const filt = [member && `thành viên ${m?.text}`, area && area !== "all" && area, query && `từ khóa "${query}"`, product && `sản phẩm "${product}"`, hs && `HS ${hs}`, (date_from || date_to) && `${date_from ?? "…"} → ${date_to ?? "…"}`, open_for_comment && "còn hạn góp ý", affects_vietnam && "nêu Việt Nam là nước bị ảnh hưởng"].filter(Boolean).join(" · ")
      if (!items.length) return withUi(`Không có thông báo SPS/TBT nào khớp (${filt || "không lọc"}) trên ePing. Thử bỏ bớt từ khóa, dùng product thay cho query, hoặc mở rộng khoảng ngày.`, { res: count(0, "notifications") })
      for (const x of items) recordEvidence(context?.sessionID, { url: viewLink(x.documentSymbol), title: x.titlePlain, text: [x.documentSymbol.trim(), x.area, x.notifyingMember, d10(x.distributionDate), x.titlePlain, x.productsFreeTextPlain, x.hsCodeText].filter(Boolean).join(" · "), source: "eping_search", meta: { id: x.id, symbol: x.documentSymbol.trim() } })
      return withUi([
        `ePing: ${j.totalCount} thông báo khớp${filt ? ` (${filt})` : ""}; hiện ${items.length}, ${(order ?? "newest") === "newest" ? "mới nhất trước" : "theo mức liên quan"}:`,
        ...items.map((x, i) => {
          const affected = (x.countriesAffected ?? []).map((c: any) => c.name)
          const vn = affected.includes("Viet Nam")
          const prod = strip(x.productsFreeText).slice(0, 160)
          return [
            `${i + 1}. [${d10(x.distributionDate)}] ${x.documentSymbol.trim()} · ${x.area} · ${x.notifyingMember} · ${x.notificationType}`,
            `   ${strip(x.titlePlain ?? x.title).slice(0, 220)}`,
            `   Sản phẩm: ${prod || "—"}${x.hsCodeText ? ` · HS ${String(x.hsCodeText).slice(0, 80)}` : ""}${x.commentDeadlineDate ? ` · hạn góp ý ${d10(x.commentDeadlineDate)}` : ""}${affected.length ? ` · nước bị ảnh hưởng: ${vn ? "có Việt Nam" : affected.length > 4 ? `${affected.length} nước (không có VN)` : affected.join(", ")}` : ""}`,
            `   ${viewLink(x.documentSymbol)}`,
          ].join("\n")
        }),
        `(nguồn: ePing – epingalert.org, tra ngày ${today()}; chi tiết + tài liệu: eping_notification(symbol))`,
      ].join("\n"), { res: count(Number(j.totalCount) || items.length, "notifications") })
    })
  },
})

function symbolOf(input: string) {
  const s = decodeURIComponent(input.trim())
  const m = s.match(/G\/(SPS|TBT)\/N\/[A-Z]{2,4}\/\d+(?:\/(?:Rev|Add|Corr|Suppl)\.\d+)*/i)
  if (!m) throw new Error("Cần ký hiệu thông báo WTO dạng G/TBT/N/EU/1100 hoặc G/SPS/N/JPN/1427/Add.1 (hoặc link epingalert.org có viewData=…). Dùng eping_search để lấy ký hiệu.")
  return m[0].replace(/\/(rev|add|corr|suppl)\./gi, (x) => "/" + x.charAt(1).toUpperCase() + x.slice(2).toLowerCase()).replace(/^g\/(sps|tbt)\/n\//i, (x) => x.toUpperCase())
}

export const notification = tool({
  description: "Mở một thông báo SPS/TBT trên ePing theo ký hiệu WTO (VD 'G/TBT/N/EU/1100', 'G/SPS/N/JPN/1427/Add.1' hoặc link epingalert.org): thành viên, lĩnh vực, loại thông báo, ngày phân phát, hạn góp ý, ngày dự kiến thông qua / có hiệu lực, tiêu đề, mô tả nội dung, sản phẩm, mã HS/ICS, mục tiêu, nước bị ảnh hưởng, văn bản được thông báo (link), bản thông báo chính thức của WTO (EN/FR/ES) và các phụ lục/sửa đổi/đính chính liên quan.",
  args: {
    symbol: tool.schema.string().describe("Ký hiệu thông báo, VD 'G/TBT/N/EU/1100', hoặc link https://epingalert.org/en/Search?viewData=…"),
  },
  async execute({ symbol }, context) {
    const sym = symbolOf(symbol)
    return withPage(async (page) => {
      let j: any
      try { j = await api(page, `/api/v1/azureSearch/getAll?page=1&pageSize=50&language=1&documentSymbol=${encodeURIComponent(sym)}`) } catch (e: any) { return `Không truy vấn được ePing: ${e?.message ?? e}` }
      const all: Item[] = j.items ?? []
      const syms = (x: Item) => String(x.documentSymbol).split(",").map((s) => s.trim())
      const x = all.find((it) => syms(it).some((s) => s.toLowerCase() === sym.toLowerCase()))
      if (!x) return `Không tìm thấy thông báo ${sym} trên ePing.${all.length ? ` Ký hiệu gần giống: ${[...new Set(all.flatMap(syms))].slice(0, 6).join(", ")}` : " Dùng eping_search để lấy ký hiệu đúng."}`
      const [links, related] = await Promise.all([
        api(page, `/api/v1/azureSearch/getDownloadLinks?notificationId=${x.id}`).catch(() => []),
        api(page, `/api/v1/notifications/getRelatedNotifications?documentSymbol=${encodeURIComponent(sym.replace(/\/(Rev|Add|Corr|Suppl)\..*$/, ""))}&includeOriginal=true`).catch(() => []),
      ])
      const docs = String(x.notifiedDocumentLink ?? "").split(/[\s,]+/).filter((u) => /^https?:\/\//.test(u))
      const affected = (x.countriesAffected ?? []).map((c: any) => c.name)
      const rel = (Array.isArray(related) ? related : []).filter((s: string) => s.toLowerCase() !== sym.toLowerCase())
      const url = viewLink(sym)
      const title = strip(x.titlePlain ?? x.title)
      const lines = [
        `Ký hiệu: ${syms(x).join(", ")} · ${x.area} · ${x.notificationType}`,
        `Thành viên thông báo: ${x.notifyingMember}`,
        `Tiêu đề: ${title}`,
        `Ngày phân phát: ${d10(x.distributionDate)}${x.commentDeadlineDate ? ` · Hạn góp ý: ${d10(x.commentDeadlineDate)}` : " · Hạn góp ý: không có / không áp dụng"}`,
        x.proposedAdoptionDateText || x.proposedAdoptionDate ? `Dự kiến thông qua: ${x.proposedAdoptionDateText || d10(x.proposedAdoptionDate)}` : "",
        x.proposedEntryIntoForceDateText || x.proposedEntryIntoForceDate ? `Dự kiến có hiệu lực: ${x.proposedEntryIntoForceDateText || d10(x.proposedEntryIntoForceDate)}` : "",
        `Sản phẩm: ${strip(x.productsFreeText) || "—"}`,
        x.hsCodeText ? `Mã HS: ${String(x.hsCodeText).slice(0, 400)}` : "",
        x.icsCodeText ? `Mã ICS: ${x.icsCodeText}` : "",
        (x.objectives ?? []).length ? `Mục tiêu: ${(x.objectives ?? []).map((o: any) => o.name).join("; ")}${strip(x.objectivesFreeText) ? ` – ${strip(x.objectivesFreeText).slice(0, 300)}` : ""}` : "",
        (x.keywords ?? []).length ? `Từ khóa: ${(x.keywords ?? []).map((k: any) => k.name).join(", ")}` : "",
        `Nước bị ảnh hưởng: ${affected.length ? (affected.includes("Viet Nam") ? "CÓ Việt Nam – " : "") + (affected.length > 12 ? `${affected.slice(0, 12).join(", ")}, … (+${affected.length - 12})` : affected.join(", ")) : x.allTradingPartners ? "mọi đối tác thương mại" : "không nêu cụ thể"}`,
        `Mô tả: ${strip(x.descriptionPlain ?? x.description).slice(0, 1800)}`,
        strip(x.relevantDocumentTitle) ? `Văn bản liên quan: ${strip(x.relevantDocumentTitle).slice(0, 500)}` : "",
        docs.length ? `Văn bản được thông báo: ${docs.slice(0, 6).join(" ; ")}` : "",
        Array.isArray(links) && links.length ? `Thông báo chính thức WTO: ${links.map((l: any) => `${l.displayName} ${l.urlLink}`).join(" ; ")}` : x.linkToNotification ? `Thông báo chính thức WTO: ${x.linkToNotification}` : "",
        rel.length ? `Thông báo liên quan (bản gốc/sửa đổi/phụ lục/đính chính): ${rel.slice(0, 12).join(", ")}` : "",
        `Link ePing: ${url}`,
        `Ngày tra cứu: ${today()}`,
      ].filter(Boolean)
      recordEvidence(context?.sessionID, { url, title, text: [...lines, `Mô tả đầy đủ: ${strip(x.descriptionPlain ?? x.description)}`].join("\n"), source: "eping", meta: { id: x.id, symbol: sym, docs, wto: x.linkToNotification, alt_urls: [x.linkToNotification].filter(Boolean) } })
      return withUi(lines.join("\n"), { doc: { title, lang: "en", number: sym, issued: isoDate(d10(x.distributionDate)), url } })
    })
  },
})
