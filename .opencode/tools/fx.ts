// fx_rate / fx_convert: official reference exchange rates through the sandbox Chrome (same connection style
// as vbpl.ts), so the agent never invents a rate:
//   - Ngân hàng Nhà nước (SBV, sbv.gov.vn): tỷ giá trung tâm VND/USD of a given day (the public page
//     "Tỷ giá" for today; the site's own public JSON (Liferay headless-delivery, structure "Tỷ Giá Trung Tâm",
//     one entry per applicable day, title = dd/mm/yyyy) for earlier days), plus – on today's page – the
//     reference buy/sell rates of the Foreign Exchange Management Department and the weekly cross rates
//     used for import/export duty.
//   - Vietcombank (vietcombank.com.vn): cash buy / transfer buy / sell of ~20 currencies for a date (the
//     public JSON behind the "Tỷ giá" page, /api/exchangerates?date=yyyy-mm-dd).
// Polite access: both sites' robots.txt allow crawling; at most 1 request / second per host, results cached
// 1 hour on disk; no login, no CAPTCHA handling (a blocked page is reported, never bypassed).
// Every page / feed text is recorded as evidence so grounding_check can verify the quoted rates; fx_convert
// also records its multiplication as "calc" evidence.
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import puppeteer from "puppeteer-core"
import fs from "node:fs"
import path from "node:path"
import { CalcError, div, fmtQ, mul, parseNumber, recordCalc, roundQ, type Q } from "../lib/calc-core.ts"
import { addDays, fmt as fmtDate, nowVN, parseDate, type D } from "../lib/calendar.ts"
import { throttle as politeThrottle } from "../lib/polite.ts"
import { recordEvidence } from "../lib/evidence.ts"
import { isoDate, withUi } from "../lib/ui-meta.ts"
import { plainQ } from "../lib/calc-core.ts"

const PORT = process.env.CHROME_PORT ?? "9333"
const CACHE = path.join(process.env.XDG_CACHE_HOME ?? ".", "legalai", "fx")
const TTL_MS = 3600 * 1000
const SBV_PAGE = "https://sbv.gov.vn/vi/t%E1%BB%B7-gi%C3%A1"
const SBV_API = "https://sbv.gov.vn/o/headless-delivery/v1.0/content-structures/137473/structured-contents"
const SBV_HUMAN = "https://sbv.gov.vn/vi/bieu-do-ty-gia-trung-tam"
const VCB_PAGE = "https://www.vietcombank.com.vn/vi-VN/KHCN/Cong-cu-Tien-ich/Ty-gia"
const VCB_API = "https://www.vietcombank.com.vn/api/exchangerates"
const NOTE = "Tỷ giá tham khảo do nguồn chính thức công bố (tra ngày {today}); tỷ giá áp dụng cho một giao dịch / hợp đồng / nghĩa vụ thuế cụ thể theo thỏa thuận của các bên, ngân hàng thực hiện giao dịch hoặc quy định chuyên ngành – ghi rõ nguồn, loại tỷ giá và ngày của tỷ giá khi trả lời."

// ---------------------------------------------------------------- polite access
// per-host limiter shared with all tools (../lib/polite.ts)
const throttle = (host: string) => politeThrottle(host, { gapMs: 1100 })
function cacheGet<T>(key: string): T | null {
  try {
    const f = path.join(CACHE, key.replace(/[^\w.-]/g, "_") + ".json")
    if (Date.now() - fs.statSync(f).mtimeMs < TTL_MS) return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {}
  return null
}
function cachePut(key: string, v: unknown) {
  try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(path.join(CACHE, key.replace(/[^\w.-]/g, "_") + ".json"), JSON.stringify(v)) } catch {}
}
async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const page = await browser.newPage()
  try { return await fn(page) } finally { await page.close().catch(() => {}); browser.disconnect() }
}
const blocked = (t: string) => /captcha|access denied|request rejected|this page can't be displayed|cloudflare/i.test(t.slice(0, 3000))
async function getText(page: any, url: string, json = false): Promise<{ status: number; text: string }> {
  const u = new URL(url)
  if (json) {
    // JSON feeds are fetched from a page of the same origin (the SBV feed answers XML to a browser
    // navigation's Accept header); the origin page is the site's tiny robots.txt
    if (new URL(page.url() === "about:blank" ? "about:blank" : page.url()).origin !== u.origin) {
      await throttle(u.hostname)
      await page.goto(`${u.origin}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 60000 })
    }
    await throttle(u.hostname)
    const r = await page.evaluate(async (href: string) => { const x = await fetch(href, { headers: { Accept: "application/json" }, credentials: "include" }); return { status: x.status, text: await x.text() } }, url)
    if (r.status >= 400 || blocked(r.text)) throw new Error(`${u.hostname} từ chối / chặn truy cập tự động (HTTP ${r.status}) – không vượt qua; thử lại sau hoặc dùng nguồn khác`)
    return r
  }
  await throttle(u.hostname)
  const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
  const status = r?.status() ?? 0
  const ct = String(r?.headers()?.["content-type"] ?? "")
  const text = /json|xml/.test(ct) ? await r.text() : await page.evaluate(() => document.body?.innerText ?? "")
  if (status >= 400 || blocked(text)) throw new Error(`${new URL(url).hostname} từ chối / chặn truy cập tự động (HTTP ${status}) – không vượt qua; thử lại sau hoặc dùng nguồn khác`)
  return { status, text }
}

// ---------------------------------------------------------------- SBV
export type SbvCentral = { date: string; usd: string; words?: string; doc?: string; issued?: string; url: string }
export type SbvToday = { central: SbvCentral | null; refDate?: string; ref: Record<string, { buy: string; sell: string; name: string }>; crossFrom?: string; crossTo?: string; cross: Record<string, { rate: string; name: string }>; text: string }
async function sbvToday(page: any): Promise<SbvToday> {
  const hit = cacheGet<SbvToday>("sbv-today")
  if (hit) return hit
  const { text } = await getText(page, SBV_PAGE)
  const c = text.match(/áp dụng cho ngày (\d{2}\/\d{2}\/\d{4})[\s\S]{0,200}?1 Đô la Mỹ\s*=?\s*([\d.]+)\s*VND/)
  const words = text.match(/Bằng chữ\s+([^\n]+)/)?.[1]?.trim()
  const doc = text.match(/Số văn bản\s+([^\s]+)/)?.[1]
  const issued = text.match(/Ngày ban hành\s+(\d{2}\/\d{2}\/\d{4})/)?.[1]
  const out: SbvToday = { central: c ? { date: c[1], usd: c[2], words, doc, issued, url: SBV_PAGE } : null, ref: {}, cross: {}, text: "" }
  const refStart = text.indexOf("Tỷ giá tham khảo giữa đồng Việt Nam")
  const crossStart = text.indexOf("Tỷ giá tính chéo")
  if (refStart >= 0) {
    const part = text.slice(refStart, crossStart > refStart ? crossStart : undefined)
    out.refDate = part.match(/áp dụng cho ngày (\d{2}\/\d{2}\/\d{4})/)?.[1]
    for (const m of part.matchAll(/^\s*\d+\s+([A-Z]{3})\s+([^\t\n]+?)\s+([\d.]+,\d+)\s+([\d.]+,\d+)\s*$/gm)) out.ref[m[1]] = { name: m[2].trim(), buy: m[3], sell: m[4] }
  }
  if (crossStart >= 0) {
    const part = text.slice(crossStart, crossStart + 4000)
    const eff = part.match(/kể từ ngày (\d{2}\/\d{2}\/\d{4}) đến (\d{2}\/\d{2}\/\d{4})/)
    out.crossFrom = eff?.[1]; out.crossTo = eff?.[2]
    for (const m of part.matchAll(/^\s*\d+\s+([A-Z]{3})\s+([^\t\n]+?)\s+([\d.]+,\d+)\s*$/gm)) out.cross[m[1]] = { name: m[2].trim(), rate: m[3] }
  }
  const s = text.indexOf("Tỷ giá trung tâm")
  const e = text.indexOf("Giới thiệu NHNN", s)
  out.text = text.slice(Math.max(0, s), e > s ? e : s + 6000)
  if (out.central) cachePut("sbv-today", out)
  return out
}
/** Central rate of one applicable day (SBV publishes one per day, weekends included). */
async function sbvCentralOn(page: any, d: D): Promise<{ c: SbvCentral; raw: string } | null> {
  const key = `sbv-${fmtDate(d)}`
  const hit = cacheGet<{ c: SbvCentral; raw: string }>(key)
  if (hit) return hit
  const url = `${SBV_API}?pageSize=1&fields=title,contentFields,datePublished&filter=${encodeURIComponent(`title eq '${fmtDate(d)}'`)}`
  const { text } = await getText(page, url, true)
  const j = JSON.parse(text)
  const it = j?.items?.[0]
  if (!it) return null
  const f = (n: string) => it.contentFields?.find((x: any) => x.name === n)?.contentFieldValue?.data as string | undefined
  const usd = f("TyGiaSo")
  if (!usd) return null
  const iso = f("NgayBanHanh")
  const issued = iso ? fmtDate(addDays(new Date(iso.slice(0, 10) + "T00:00:00Z"), new Date(iso).getUTCHours() >= 17 ? 1 : 0)) : undefined
  const c: SbvCentral = { date: it.title, usd: fmtQ(parseNumber(usd.replace(/\.0+$/, ""), "en").value, "vi"), words: f("TyGiaChu"), doc: f("SoVanBan"), issued, url }
  const out = { c, raw: text.slice(0, 6000) }
  cachePut(key, out)
  return out
}

// ---------------------------------------------------------------- Vietcombank
export type VcbRate = { code: string; name: string; cash: string; transfer: string; sell: string }
export type VcbDay = { date: string; updated: string; rates: VcbRate[]; url: string; raw: string }
async function vcbOn(page: any, d: D): Promise<VcbDay | null> {
  const iso = d.toISOString().slice(0, 10)
  const key = `vcb-${iso}`
  const hit = cacheGet<VcbDay>(key)
  if (hit) return hit
  const url = `${VCB_API}?date=${iso}`
  const { text } = await getText(page, url, true)
  const j = JSON.parse(text)
  if (!j?.Data?.length) return null
  const upd = String(j.UpdatedDate ?? "")
  const m = upd.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  const out: VcbDay = {
    date: fmtDate(new Date(String(j.Date).slice(0, 10) + "T00:00:00Z")),
    updated: m ? `${m[4]}:${m[5]} ngày ${m[3]}/${m[2]}/${m[1]}` : upd,
    rates: j.Data.map((x: any) => ({ code: x.currencyCode, name: String(x.currencyName).trim(), cash: String(x.cash), transfer: String(x.transfer), sell: String(x.sell) })),
    url, raw: "",
  }
  out.raw = [`Vietcombank – Tỷ giá ngoại tệ ngày ${out.date} (cập nhật lúc ${out.updated})`, "Mã ngoại tệ | Tên ngoại tệ | Mua tiền mặt | Mua chuyển khoản | Bán",
    ...out.rates.map((r) => `${r.code} | ${r.name} | ${vcbFmt(r.cash)} | ${vcbFmt(r.transfer)} | ${vcbFmt(r.sell)}`)].join("\n")
  cachePut(key, out)
  return out
}
/** VCB feed numbers are plain "25760.00"; "-" = not quoted. Shown as "25,760.00" like the VCB page. */
const vcbFmt = (s: string) => (/^\d+(\.\d+)?$/.test(s) ? fmtQ(parseNumber(s, "en").value, "en", 2) : "-")
const vcbQ = (s: string): Q | null => (/^\d+(\.\d+)?$/.test(s) && +s > 0 ? parseNumber(s, "en").value : null)

// ---------------------------------------------------------------- shared lookup
type Lookup = {
  currency: string; date: D; lines: string[]; sources: string[]
  sbv?: { central?: SbvCentral; ref?: { buy: string; sell: string }; refDate?: string; cross?: string; crossFrom?: string; crossTo?: string }
  vcb?: { day: VcbDay; rate: VcbRate }
  errors: string[]
}
async function lookup(currency: string, dateArg: string | undefined, source: "sbv" | "vcb" | "both", context: any): Promise<Lookup> {
  const cur = currency.trim().toUpperCase()
  const today = nowVN().date
  const d = parseDate(dateArg, today)
  if (!d) throw new CalcError(`ngày không hợp lệ "${dateArg}" (dd/mm/yyyy)`)
  if (d.getTime() > today.getTime()) throw new CalcError(`ngày ${fmtDate(d)} ở tương lai – chưa có tỷ giá`)
  const L: Lookup = { currency: cur, date: d, lines: [], sources: [], errors: [] }
  const sid = context?.sessionID
  await withPage(async (page) => {
    if (source !== "vcb") {
      try {
        L.sbv = {}
        let t: SbvToday | null = null
        if (!dateArg || fmtDate(d) === fmtDate(today) || cur !== "USD") t = await sbvToday(page)
        if (t) {
          recordEvidence(sid, { url: SBV_PAGE, title: "Ngân hàng Nhà nước Việt Nam – Tỷ giá", text: t.text, source: "sbv.gov.vn" })
          L.sources.push(SBV_PAGE)
        }
        if (cur === "USD") {
          let c = t?.central && (!dateArg || t.central.date === fmtDate(d)) ? t.central : null
          // an earlier day (or today before publication): the day's entry, else the latest entry before it
          for (let k = 0; !c && k < 7; k++) {
            const r = await sbvCentralOn(page, addDays(d, -k))
            if (r) {
              c = r.c
              recordEvidence(sid, { url: SBV_HUMAN, title: `NHNN – Tỷ giá trung tâm ngày ${r.c.date}`, text: `Tỷ giá trung tâm áp dụng cho ngày ${r.c.date}: 1 Đô la Mỹ = ${r.c.usd} VND. Bằng chữ: ${r.c.words ?? ""}. Số văn bản: ${r.c.doc ?? ""}. Ngày ban hành: ${r.c.issued ?? ""}.\n${r.raw}`, source: "sbv.gov.vn", meta: { api: r.c.url } })
              L.sources.push(SBV_HUMAN)
            }
          }
          if (c) L.sbv.central = c
          else L.errors.push(`SBV: không tìm thấy tỷ giá trung tâm trong 7 ngày đến ${fmtDate(d)}`)
        }
        if (t && (!dateArg || fmtDate(d) === fmtDate(today) || t.refDate === fmtDate(d))) {
          if (t.ref[cur]) { L.sbv.ref = t.ref[cur]; L.sbv.refDate = t.refDate }
          if (t.cross[cur]) { L.sbv.cross = t.cross[cur].rate; L.sbv.crossFrom = t.crossFrom; L.sbv.crossTo = t.crossTo }
        } else if (cur !== "USD") L.errors.push(`SBV: bảng tỷ giá tham khảo / tính chéo chỉ có cho ngày hiện hành (${t?.refDate ?? "?"}), không tra được ngày ${fmtDate(d)}`)
      } catch (e: any) { L.errors.push(`SBV: ${e?.message ?? e}`) }
    }
    if (source !== "sbv") {
      try {
        let day: VcbDay | null = null
        for (let k = 0; !day && k < 7; k++) day = await vcbOn(page, addDays(d, -k))
        if (!day) L.errors.push(`Vietcombank: không có bảng tỷ giá trong 7 ngày đến ${fmtDate(d)}`)
        else {
          recordEvidence(sid, { url: VCB_PAGE, title: `Vietcombank – Tỷ giá ngày ${day.date}`, text: day.raw, source: "vietcombank.com.vn", meta: { api: day.url } })
          L.sources.push(VCB_PAGE)
          const rate = day.rates.find((r) => r.code === cur)
          if (rate) L.vcb = { day, rate }
          else L.errors.push(`Vietcombank không niêm yết ${cur} (có: ${day.rates.map((r) => r.code).join(", ")})`)
        }
      } catch (e: any) { L.errors.push(`Vietcombank: ${e?.message ?? e}`) }
    }
  })
  return L
}

const today = () => fmtDate(nowVN().date)
function describe(L: Lookup): { head: string; body: string[] } {
  const parts: string[] = [], body: string[] = []
  const c = L.sbv?.central
  if (c) {
    parts.push(`NHNN tỷ giá trung tâm ${c.usd} VND/USD (áp dụng ngày ${c.date})`)
    body.push(`Ngân hàng Nhà nước – tỷ giá trung tâm: 1 USD = ${c.usd} VND, áp dụng cho ngày ${c.date}${c.doc ? `, theo ${c.doc}` : ""}${c.issued ? ` ban hành ${c.issued}` : ""}${c.words ? ` (bằng chữ: ${c.words})` : ""}. Nguồn: ${c.url.startsWith(SBV_API) ? SBV_HUMAN : c.url}`)
  }
  if (L.sbv?.ref) body.push(`NHNN (Cục Quản lý ngoại hối) – tỷ giá tham khảo ${L.currency} ngày ${L.sbv.refDate}: mua ${L.sbv.ref.buy} – bán ${L.sbv.ref.sell} VND. Nguồn: ${SBV_PAGE}`)
  if (L.sbv?.cross) body.push(`NHNN – tỷ giá tính chéo ${L.currency} để xác định trị giá tính thuế XNK, hiệu lực ${L.sbv.crossFrom} – ${L.sbv.crossTo}: ${L.sbv.cross} VND. Nguồn: ${SBV_PAGE}`)
  if (L.vcb) {
    const r = L.vcb.rate
    parts.push(`Vietcombank ${L.currency}: mua CK ${vcbFmt(r.transfer)} / bán ${vcbFmt(r.sell)} (ngày ${L.vcb.day.date})`)
    body.push(`Vietcombank – ${L.currency} (${r.name}) ngày ${L.vcb.day.date}, cập nhật ${L.vcb.day.updated}: mua tiền mặt ${vcbFmt(r.cash)} – mua chuyển khoản ${vcbFmt(r.transfer)} – bán ${vcbFmt(r.sell)} VND. Nguồn: ${VCB_PAGE}`)
  }
  if (L.vcb && fmtDate(L.date) !== L.vcb.day.date) body.push(`Lưu ý: Vietcombank chưa có bảng cho ngày ${fmtDate(L.date)} – dùng bảng gần nhất ${L.vcb.day.date}.`)
  if (c && fmtDate(L.date) !== c.date) body.push(`Lưu ý: tỷ giá trung tâm hiện có gần nhất với ngày ${fmtDate(L.date)} là ngày ${c.date}.`)
  return { head: parts.join("; "), body }
}

// Web result card: the same rates as plain decimal strings + source codes + ISO dates (the UI formats them).
const plainVi = (s?: string) => { try { return s ? plainQ(parseNumber(s, "vi").value).s : undefined } catch { return undefined } }
const plainFeed = (s?: string) => (s && /^\d+(\.\d+)?$/.test(s) && +s > 0 ? plainQ(parseNumber(s, "en").value).s : undefined)
function ratesUi(L: Lookup) {
  const out: Record<string, unknown>[] = []
  const c = L.sbv?.central
  if (c) out.push({ src: "sbv_central", cur: "USD", rate: plainVi(c.usd), date: isoDate(c.date), url: c.url.startsWith(SBV_API) ? SBV_HUMAN : c.url })
  if (L.sbv?.ref) out.push({ src: "sbv_ref", cur: L.currency, buy: plainVi(L.sbv.ref.buy), sell: plainVi(L.sbv.ref.sell), date: isoDate(L.sbv.refDate), url: SBV_PAGE })
  if (L.sbv?.cross) out.push({ src: "sbv_cross", cur: L.currency, rate: plainVi(L.sbv.cross), from: isoDate(L.sbv.crossFrom), to: isoDate(L.sbv.crossTo), url: SBV_PAGE })
  if (L.vcb) out.push({ src: "vcb", cur: L.currency, cash: plainFeed(L.vcb.rate.cash), transfer: plainFeed(L.vcb.rate.transfer), sell: plainFeed(L.vcb.rate.sell), date: isoDate(L.vcb.day.date), url: VCB_PAGE })
  return out
}

export const rate = tool({
  description:
    "TRA TỶ GIÁ chính thức (không tự nhớ / đoán tỷ giá): Ngân hàng Nhà nước – tỷ giá trung tâm VND/USD theo ngày (sbv.gov.vn), kèm tỷ giá tham khảo mua/bán và tỷ giá tính chéo tính thuế XNK của ngày hiện hành; Vietcombank – mua tiền mặt / mua chuyển khoản / bán (~20 ngoại tệ) theo ngày. Trả về tỷ giá, NGÀY của tỷ giá, link nguồn; nội dung được ghi nhận để grounding_check kiểm tra. Khi trả lời luôn ghi nguồn + loại tỷ giá + ngày, và 'tỷ giá tham khảo'.",
  args: {
    currency: tool.schema.string().describe("Mã ngoại tệ ISO: USD, EUR, JPY, CNY, GBP, AUD, SGD, KRW, THB…"),
    date: tool.schema.string().optional().describe("Ngày của tỷ giá dd/mm/yyyy (bỏ trống = hôm nay; ngày nghỉ → bảng gần nhất trước đó)"),
    source: tool.schema.enum(["sbv", "vcb", "both"]).optional().describe("sbv = Ngân hàng Nhà nước, vcb = Vietcombank, both (mặc định)"),
  },
  async execute({ currency, date, source }, context) {
    try {
      const L = await lookup(currency, date, source ?? "both", context)
      const { head, body } = describe(L)
      if (!head && !body.length) return [`Không tra được tỷ giá ${L.currency} ngày ${fmtDate(L.date)}.`, ...L.errors.map((e) => `- ${e}`), "Không tự đưa tỷ giá theo trí nhớ – báo cho người dùng và đề nghị cung cấp tỷ giá áp dụng."].join("\n")
      const text = [
        `TỶ GIÁ ${L.currency}/VND (tham khảo, ngày ${fmtDate(L.date)}): ${head || "xem chi tiết"}`,
        ...body,
        ...L.errors.map((e) => `Không lấy được: ${e}`),
        `Nguồn đã mở: ${[...new Set(L.sources)].join(" ; ")}`,
        NOTE.replace("{today}", today()),
        "Quy đổi số tiền: dùng fx_convert (không tự nhân).",
      ].join("\n")
      return withUi(text, { card: { kind: "fx", mode: "rate", currency: L.currency, date: isoDate(fmtDate(L.date)), rates: ratesUi(L), errors: L.errors.length } })
    } catch (e: any) { return `Lỗi: ${e?.message ?? e}. Không tự đưa tỷ giá theo trí nhớ.` }
  },
})

export const convert = tool({
  description:
    "QUY ĐỔI NGOẠI TỆ ↔ VND bằng tỷ giá chính thức tra trực tiếp (fx_rate) và phép nhân chính xác: kết quả theo tỷ giá trung tâm NHNN (USD) và theo Vietcombank (ngoại tệ → VND dùng giá MUA chuyển khoản, VND → ngoại tệ dùng giá BÁN, trừ khi chọn rate_type). Hai ngoại tệ khác nhau: quy đổi chéo qua VND. Ghi rõ tỷ giá, nguồn, ngày trong câu trả lời.",
  args: {
    amount: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Số tiền, VD '65.000', '65,765.75', 1500000000"),
    from: tool.schema.string().describe("Đồng tiền gốc: USD, EUR, VND…"),
    to: tool.schema.string().describe("Đồng tiền cần đổi sang: VND, USD…"),
    date: tool.schema.string().optional().describe("Ngày của tỷ giá dd/mm/yyyy (bỏ trống = hôm nay)"),
    source: tool.schema.enum(["sbv", "vcb", "both"]).optional().describe("both (mặc định) | sbv | vcb"),
    rate_type: tool.schema.enum(["central", "buy_cash", "buy_transfer", "sell"]).optional().describe("Chỉ dùng một loại tỷ giá: central (NHNN, chỉ USD) | buy_cash | buy_transfer | sell (Vietcombank)"),
  },
  async execute({ amount, from, to, date, source, rate_type }, context) {
    try {
      const F = from.trim().toUpperCase(), T = to.trim().toUpperCase()
      if (F === T) return "Lỗi: đồng tiền gốc và đích giống nhau."
      const amt = typeof amount === "number" ? parseNumber(String(amount), "en").value : parseNumber(String(amount).replace(/[^\d.,]/g, ""), "auto").value
      const foreign = [F, T].filter((c) => c !== "VND")
      const src = rate_type === "central" ? "sbv" : rate_type ? "vcb" : source ?? "both"
      const looks = new Map<string, Lookup>()
      for (const c of foreign) looks.set(c, await lookup(c, date, src, context))
      const dg = T === "VND" ? 0 : 2
      type Way = { label: string; value: Q; formula: string; rates: Q[]; src: string; date?: string }
      const ways: Way[] = []
      const SRC = { central: "sbv_central", buy_cash: "vcb_cash", buy_transfer: "vcb_transfer", sell: "vcb_sell" } as const
      const rateOf = (c: string, kind: "central" | "buy_cash" | "buy_transfer" | "sell"): { r: Q; label: string; src: string; date: string } | null => {
        const L = looks.get(c)!
        if (kind === "central") { const x = L.sbv?.central; return x ? { r: parseNumber(x.usd, "vi").value, label: `tỷ giá trung tâm NHNN ngày ${x.date}`, src: SRC[kind], date: x.date } : null }
        const v = L.vcb; if (!v) return null
        const s = kind === "buy_cash" ? v.rate.cash : kind === "buy_transfer" ? v.rate.transfer : v.rate.sell
        const r = vcbQ(s)
        return r ? { r, label: `Vietcombank ${kind === "buy_cash" ? "mua tiền mặt" : kind === "buy_transfer" ? "mua chuyển khoản" : "bán"} ngày ${v.day.date}`, src: SRC[kind], date: v.day.date } : null
      }
      const kinds = (c: string, dir: "in" | "out"): ("central" | "buy_cash" | "buy_transfer" | "sell")[] => {
        if (rate_type) return [rate_type]
        const k: ("central" | "buy_cash" | "buy_transfer" | "sell")[] = []
        if (c === "USD" && src !== "vcb") k.push("central")
        if (src !== "sbv") k.push(dir === "in" ? "buy_transfer" : "sell")
        return k
      }
      if (F !== "VND" && T === "VND") {
        for (const k of kinds(F, "in")) { const x = rateOf(F, k); if (x) ways.push({ label: x.label, value: mul(amt, x.r), formula: `${fmtQ(amt, "vi")} ${F} × ${fmtQ(x.r, "vi")} VND/${F}`, rates: [x.r], src: x.src, date: x.date }) }
      } else if (F === "VND") {
        for (const k of kinds(T, "out")) { const x = rateOf(T, k); if (x) ways.push({ label: x.label, value: div(amt, x.r), formula: `${fmtQ(amt, "vi")} VND ÷ ${fmtQ(x.r, "vi")} VND/${T}`, rates: [x.r], src: x.src, date: x.date }) }
      } else {
        const pairs: ["central" | "buy_transfer" | "sell" | "buy_cash", "central" | "buy_transfer" | "sell" | "buy_cash"][] = rate_type ? [[rate_type, rate_type]] : [["buy_transfer", "sell"]]
        for (const [a, b] of pairs) {
          const x = rateOf(F, a), y = rateOf(T, b)
          if (x && y) ways.push({ label: `chéo qua VND: ${x.label} / ${y.label}`, value: div(mul(amt, x.r), y.r), formula: `${fmtQ(amt, "vi")} ${F} × ${fmtQ(x.r, "vi")} ÷ ${fmtQ(y.r, "vi")}`, rates: [x.r, y.r], src: `cross:${x.src}/${y.src}`, date: x.date })
        }
      }
      const errs = [...looks.values()].flatMap((l) => l.errors)
      if (!ways.length) return [`Không quy đổi được ${F} → ${T}: không có tỷ giá phù hợp.`, ...errs.map((e) => `- ${e}`), "Không tự dùng tỷ giá theo trí nhớ."].join("\n")
      const res = ways.map((w) => ({ ...w, rounded: roundQ(w.value, dg) }))
      const out = [
        `QUY ĐỔI: ${fmtQ(amt, "vi")} ${F} = ${fmtQ(res[0].rounded, "vi", dg)} ${T} (en: ${fmtQ(res[0].rounded, "en", dg)} ${T}) theo ${res[0].label}`,
        ...res.map((w, i) => `${i + 1}. ${w.label}: ${w.formula} = ${fmtQ(w.value, "vi")} → ${fmtQ(w.rounded, "vi", dg)} ${T} (en: ${fmtQ(w.rounded, "en", dg)})`),
        ...[...looks.values()].flatMap((l) => describe(l).body),
        ...errs.map((e) => `Không lấy được: ${e}`),
        `Nguồn đã mở: ${[...new Set([...looks.values()].flatMap((l) => l.sources))].join(" ; ")}`,
        NOTE.replace("{today}", today()),
        "Tiếp theo: trong câu trả lời ghi nguồn, loại tỷ giá, ngày của tỷ giá và \"tỷ giá tham khảo\"; chạy grounding_check trên bản nháp trước khi trả lời.",
      ]
      recordCalc(context, "fx_convert", out, [amt, ...res.flatMap((w) => [...w.rates, w.value, w.rounded])])
      const p = (v: Q) => plainQ(v).s
      return withUi(out.join("\n"), {
        card: {
          kind: "fx", mode: "convert", currency: foreign[0],
          convert: { amount: p(amt), fromCur: F, toCur: T, result: p(res[0].rounded), src: res[0].src, date: isoDate(res[0].date) },
          ways: res.map((w) => ({ src: w.src, date: isoDate(w.date), rate: w.rates.length === 1 ? p(w.rates[0]) : undefined, result: p(w.rounded) })),
          rates: [...looks.values()].flatMap(ratesUi), errors: errs.length,
        },
      })
    } catch (e: any) { return `Lỗi: ${e?.message ?? e}. Không tự quy đổi theo trí nhớ.` }
  },
})

