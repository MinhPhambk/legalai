// Market Access Map (ITC – International Trade Centre, www.macmap.org): market access conditions for ANY exporter →
// importer pair (≈ 238 countries) by HS code: applied customs tariffs (MFN and every preferential regime with the
// agreement name, AVE), taxes and fees, non-tariff measures (UNCTAD NTM classification, counts per measure type) and
// trade remedies. It complements tariff_us / tariff_eu / tariff_vn for markets without a dedicated tool (Japan,
// Korea, ASEAN, Australia, Canada, …).
//   macmap_access – exporter, importer, HS → the four result sections, with the macmap page link as the source
// macmap.org sits behind Cloudflare's bot check, which a normal HEADED browser passes without any interaction; the
// sandbox Chrome is headless, so this tool uses its own headed Chrome (own profile, DevTools 127.0.0.1:9343, drawn
// on the Xvfb display :99 of legalai-xvfb.service), started on first use. Nothing is done to evade the check: if it
// ever asks for interactive verification, the tool stops and says so (no CAPTCHA solving).
// The tool reads the JSON endpoints the macmap result page itself calls (/api/countries, /api/v2/ntlc-products,
// /api/results/{customduties,taxes,ntm-measures,traderemedy}); one request at a time, ≥ 1.5 s apart, cached 12 h.
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import puppeteer from "puppeteer-core"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { recordEvidence } from "../lib/evidence.ts"
import { polite } from "../lib/polite.ts"
import { count, withUi } from "../lib/ui-meta.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const PORT = process.env.MACMAP_CHROME_PORT ?? "9343"
const PROFILE = path.join(ROOT, ".sandbox", "macmap-chrome-profile")
const EXE = process.env.MACMAP_CHROME_EXE ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome-stable")
const BASE = "https://www.macmap.org"
const HOST = "www.macmap.org"
const POLITE = { concurrency: 1, gapMs: 1500 }
const today = () => new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
class Blocked extends Error {}

// ---- headed Chrome (lazy start) ------------------------------------------------------------------------------------
const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } }
let starting: Promise<void> | null = null
async function ensureChrome() {
  if (await up()) return
  starting ??= (async () => {
    fs.mkdirSync(PROFILE, { recursive: true })
    const env = { ...process.env, DISPLAY: process.env.DISPLAY || process.env.OCR_DISPLAY || ":99" }
    const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, "--remote-debugging-address=127.0.0.1", "--no-first-run",
      "--no-default-browser-check", "--disable-sync", "--window-size=1400,1000", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "about:blank"],
      { detached: true, stdio: "ignore", env })
    child.unref()
    for (let i = 0; i < 40 && !(await up()); i++) await sleep(500)
    if (!(await up())) throw new Blocked("không khởi động được trình duyệt cho macmap.org (cần màn hình ảo :99 – legalai-xvfb)")
  })().finally(() => { starting = null })
  return starting
}

/** A tab on macmap.org past the Cloudflare check (waits for it to clear by itself; never interacts with it). */
async function withMacmap<T>(fn: (page: any) => Promise<T>): Promise<T> {
  await ensureChrome()
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  try {
    // the visible first tab (a background tab gets a stricter check)
    const pages = await browser.pages()
    let page = pages.find((p: any) => p.url().startsWith(BASE))
    if (!page) {
      page = pages[0] ?? (await browser.newPage())
      await page.bringToFront().catch(() => {})
      await polite(HOST, () => page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 }), POLITE)
    }
    for (let i = 0; i < 12 && /just a moment|attention required/i.test(await page.title()); i++) await sleep(2500)
    if (/just a moment|attention required/i.test(await page.title())) throw new Blocked("macmap.org đang yêu cầu xác minh người dùng (Cloudflare) – hệ thống không vượt bước xác minh")
    return await fn(page)
  } finally {
    browser.disconnect()
  }
}

const memo = new Map<string, { at: number; v: any }>()
async function api(page: any, p: string) {
  const hit = memo.get(p)
  if (hit && Date.now() - hit.at < 12 * 3600_000) return hit.v
  const r: { s: number; t: string } = await polite(HOST, () => page.evaluate(async (u: string) => {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 45000)
    try { const res = await fetch(u, { headers: { accept: "application/json" }, signal: ctl.signal }); return { s: res.status, t: await res.text() } } catch (e: any) { return { s: 0, t: String(e?.message ?? e) } } finally { clearTimeout(tm) }
  }, p), POLITE)
  if (r.s === 403 || /just a moment/i.test(r.t.slice(0, 300))) throw new Blocked("macmap.org chặn truy cập tự động lúc này")
  if (r.s === 0 || r.s >= 500) throw new Blocked(`macmap.org không phản hồi (${r.s ? "HTTP " + r.s : r.t.slice(0, 80)})`)
  let v: any = null
  try { v = JSON.parse(r.t) } catch { v = null }
  memo.set(p, { at: Date.now(), v })
  return v
}

type Country = { Code: string; Name: string; ISO2: string; ISO3: string }
let countries: Country[] | null = null
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]/g, "")
// Vietnamese names of frequent partners (macmap names are English)
const VI_NAMES: Record<string, string> = { vietnam: "VN", vn: "VN", my: "US", hoaky: "US", nhat: "JP", nhatban: "JP", hanquoc: "KR", trungquoc: "CN", duc: "DE", phap: "FR", anh: "GB", uc: "AU", canada: "CA", hongkong: "HK", dailoan: "TW", thailan: "TH", indonesia: "ID", malaysia: "MY", singapore: "SG", philippines: "PH", campuchia: "KH", lao: "LA", myanmar: "MM", an: "IN", ando: "IN", nga: "RU", halan: "NL", bi: "BE", y: "IT", taybannha: "ES", thuysi: "CH", newzealand: "NZ", chile: "CL", mexico: "MX", brazil: "BR", uae: "AE", israel: "IL" }
function country(q: string | undefined, dflt?: string): Country | null {
  const s = fold(q || dflt || "")
  if (!s || !countries) return null
  const iso = VI_NAMES[s] ?? s.toUpperCase()
  return countries.find((c) => c.ISO2 === iso || c.ISO3 === iso || c.Code === s.padStart(3, "0")) ?? countries.find((c) => fold(c.Name) === s) ?? countries.find((c) => fold(c.Name).startsWith(s)) ?? null
}
const strip = (s: unknown) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

export const access = tool({
  description:
    "ĐIỀU KIỆN TIẾP CẬN THỊ TRƯỜNG theo Market Access Map của ITC (Trung tâm Thương mại Quốc tế – www.macmap.org) cho MỌI cặp nước xuất khẩu → nước nhập khẩu (≈ 238 nước) theo mã HS: thuế nhập khẩu áp dụng năm hiện tại (MFN và TỪNG chế độ ưu đãi kèm tên hiệp định, VD CPTPP, RCEP, AJCEP, VJEPA, EVFTA; quy đổi AVE), các loại thuế / phí khác, biện pháp phi thuế quan (NTM – SPS, TBT, kiểm tra trước khi giao hàng, giấy phép…, theo phân loại UNCTAD, có số lượng từng loại) và biện pháp phòng vệ thương mại đang áp dụng. Dùng cho thị trường chưa có công cụ riêng (Nhật Bản, Hàn Quốc, Trung Quốc, ASEAN, Úc, Canada, Ấn Độ…) hoặc để đối chiếu; với Hoa Kỳ / EU / Việt Nam ưu tiên tariff_us / tariff_eu (+ tariff_eu_requirements) / tariff_vn. Đây là CSDL tổng hợp của ITC: trích dẫn ghi \"theo Market Access Map (ITC)\" kèm năm dữ liệu, và đối chiếu văn bản gốc của nước nhập khẩu khi kết luận nghĩa vụ cụ thể.",
  args: {
    hs: tool.schema.string().describe("Mã HS 6 số trở lên, VD '0306.17', '090111', '7210.49'"),
    importer: tool.schema.string().describe("Nước nhập khẩu: mã ISO 2/3 chữ (JP, KOR…), tên tiếng Anh hoặc tiếng Việt (Nhật Bản, Hàn Quốc…)"),
    exporter: tool.schema.string().optional().describe("Nước xuất khẩu (mặc định Việt Nam)"),
  },
  async execute({ hs, importer, exporter }, context) {
    const d = String(hs ?? "").replace(/\D/g, "")
    if (d.length < 6) return "Cần mã HS ít nhất 6 số (VD 030617). Chưa có mã → tariff_search(query) hoặc tariff_vn_table(query=…)."
    try {
      return await withMacmap(async (page) => {
        countries ??= ((await api(page, "/api/countries")) as Country[] | null) ?? []
        const imp = country(importer), exp = country(exporter, "VN")
        if (!imp) return `Không nhận ra nước nhập khẩu "${importer}". Dùng mã ISO 2 chữ (VD JP, KR, AU) hoặc tên tiếng Anh.`
        if (!exp) return `Không nhận ra nước xuất khẩu "${exporter}".`
        const lines: { Code: string; Name: string }[] = ((await api(page, `/api/v2/ntlc-products?countryCode=${imp.Code}&level=8&code=${d.slice(0, 6)}`)) ?? [])
          .filter((x: any) => x?.Code && String(x.Code).startsWith(d.slice(0, Math.min(d.length, String(x.Code).length))))
        if (!lines.length) return `Market Access Map không có dòng thuế nào của ${imp.Name} cho mã ${d} (tra ngày ${today()}). Kiểm tra lại mã HS.`
        const MAX = 4
        const human = (code: string) => `${BASE}/en/query/results?reporter=${imp.Code}&partner=${exp.Code}&product=${code}&level=6`
        const out: string[] = [`ĐIỀU KIỆN TIẾP CẬN THỊ TRƯỜNG – Market Access Map (ITC) · ${exp.Name} → ${imp.Name} · mã HS ${d} · tra ngày ${today()}`]
        if (lines.length > MAX) out.push(`(${lines.length} dòng thuế quốc gia của ${imp.Name}; hiển thị ${MAX} dòng đầu – nhập mã chi tiết hơn để xem dòng khác)`)
        let nRates = 0
        for (const ln of lines.slice(0, MAX)) {
          const cd = (await api(page, `/api/results/customduties?reporter=${imp.Code}&partner=${exp.Code}&product=${ln.Code}`)) ?? {}
          out.push("", `■ Dòng thuế ${ln.Code} – ${clip(strip(ln.Name), 260)}`, `  Nguồn: ${human(ln.Code)} · năm dữ liệu ${cd.Year ?? "?"}${cd.ReferenceData ? ` · ${strip(cd.ReferenceData)}` : ""}`)
          const rows: any[] = Array.isArray(cd.CustomDuty) ? cd.CustomDuty : []
          if (!rows.length) out.push("  (không có dữ liệu thuế cho dòng này)")
          for (const r of rows) {
            nRates++
            out.push(`  • ${strip(r.TariffRegime)}: ${strip(r.TariffReported) || "–"}${r.TariffAve && r.TariffAve !== r.TariffReported ? ` (AVE ${strip(r.TariffAve)})` : ""}${r.TariffInsideQuota ? ` · trong hạn ngạch: ${strip(r.TariffInsideQuota)}` : ""}${r.OtherDuties ? ` · thuế khác: ${strip(r.OtherDuties)}` : ""}`)
          }
        }
        const first = lines[0].Code
        const q = `reporter=${imp.Code}&partner=${exp.Code}&product=${first}`
        const taxes = (await api(page, `/api/results/taxes?${q}`)) ?? {}
        const tx: any[] = Array.isArray(taxes.TaxDataViewModels) ? taxes.TaxDataViewModels : []
        out.push("", `THUẾ VÀ PHÍ KHÁC tại ${imp.Name} (dòng ${first}):`)
        if (!tx.length) out.push("  (không có dữ liệu)")
        for (const t of tx.slice(0, 12)) out.push(`  • ${strip(t.TaxName)}${t.TaxOfficialName ? ` (${strip(t.TaxOfficialName)})` : ""}: ${clip(strip(t.TaxRate), 160) || "–"}${t.AssessableTaxBase ? ` · cơ sở tính: ${clip(strip(t.AssessableTaxBase), 120)}` : ""}`)
        const ntm: any[] = (await api(page, `/api/results/ntm-measures?${q}`)) ?? []
        out.push("", `BIỆN PHÁP PHI THUẾ QUAN (NTM) – dòng ${first}:`)
        if (!Array.isArray(ntm) || !ntm.length) out.push("  (không có dữ liệu NTM)")
        for (const sec of Array.isArray(ntm) ? ntm : []) {
          out.push(`  ${strip(sec.MeasureSection)}: ${sec.MeasureTotalCount ?? "?"} biện pháp (năm ${sec.NtmYear ?? "?"}, ${strip(sec.NtmClassification)}; nguồn dữ liệu: ${clip(strip(sec.DataSource), 120)})`)
          for (const m of (sec.Measures ?? []).slice(0, 25)) out.push(`   - ${m.MeasureCode} ${strip(m.MeasureTitle)} (${m.MeasureCount ?? 1})`)
        }
        const tr = (await api(page, `/api/results/traderemedy?${q}`)) ?? {}
        const trData: any[] = Array.isArray(tr.TradeRemedyData) ? tr.TradeRemedyData : []
        out.push("", `PHÒNG VỆ THƯƠNG MẠI của ${imp.Name} với hàng từ ${exp.Name} (dòng ${first}): ${trData.length ? "" : "không có biện pháp nào trong dữ liệu"}`)
        for (const x of trData.slice(0, 8)) out.push(`  • ${strip(x.RemedyType ?? x.Type)} – ${strip(x.RemedyStatus ?? x.Status)} – thuế ${strip(x.Duty)}${x.StartDate ? ` – từ ${strip(x.StartDate)}` : ""}${x.ExportingFirm ? ` – doanh nghiệp: ${clip(strip(x.ExportingFirm), 120)}` : ""}`)
        out.push("", "LƯU Ý: Market Access Map là CSDL tổng hợp của ITC (có độ trễ cập nhật). Khi trả lời: ghi \"theo Market Access Map (ITC), dữ liệu năm …\" và link nguồn ở trên; ưu đãi FTA chỉ áp dụng khi hàng đáp ứng quy tắc xuất xứ (fta_search / tariff_eu cho EU); phòng vệ thương mại với Hoa Kỳ / EU đối chiếu trav_*, fedreg_*, eurlex_*. Nội dung chi tiết từng NTM: mở link nguồn.")
        const text = out.join("\n")
        recordEvidence(context?.sessionID, { url: human(first), title: `Market Access Map – ${exp.Name} → ${imp.Name} – ${d}`, text, source: "macmap.org", meta: { alt_urls: lines.slice(0, MAX).map((l) => human(l.Code)) } })
        return withUi(text, { res: count(nRates, "tariffLines") })
      })
    } catch (e: any) {
      if (e instanceof Blocked) return `Không tra được Market Access Map: ${e.message}. Không nêu điều kiện thị trường theo trí nhớ; thử lại sau hoặc dùng tariff_* / web_search.`
      throw e
    }
  },
})
