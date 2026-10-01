// company_lookup / company_verify: enterprise / tax-code (MST, mã số doanh nghiệp) due diligence.
//
// 1. OFFICIAL sources first – Cổng thông tin quốc gia về đăng ký doanh nghiệp (dangkykinhdoanh.gov.vn →
//    dichvuthongtin.dkkd.gov.vn, Bố cáo điện tử bocaodientu.dkkd.gov.vn) and Cục Thuế (tracuunnt.gdt.gov.vn).
//    Research 27/09/2026 (sandbox Chrome; none of these hosts has a robots.txt): every official lookup of an
//    enterprise by code or name is behind a CAPTCHA –
//      - dichvuthongtin.dkkd.gov.vn "Thông tin về một doanh nghiệp cụ thể" (ProductCatalog.aspx): Google reCAPTCHA;
//        the header search box / dangkykinhdoanh.gov.vn "Tìm doanh nghiệp" only redirects back to the home page;
//      - bocaodientu.dkkd.gov.vn "Tìm bố cáo" (ANNOUNCEMENTSListingInsUpd.aspx): reCAPTCHA;
//      - tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp: image "Mã xác nhận" (captcha.png).
//    A CAPTCHA is never solved or bypassed. Web chats (ND45_ASSIST=1, set by the web server): ASSISTED BROWSING –
//    ../lib/assist.ts opens the form in an isolated tab with the MST filled in, the web UI mirrors it to the chat
//    owner who types the code / ticks reCAPTCHA and presses search; the result page is then read (origin "official",
//    evidence under the official domain). CLI, assist=false, cancel / timeout: the tools re-check the gates (every 6 h
//    at most) and return the exact official URLs + what to enter ("Nguồn chính thức yêu cầu mã xác thực – không tra tự động").
// 2. REFERENCE (unofficial) aggregators, user decision 27/09/2026 – only public GET pages by MST / their search
//    page, robots.txt checked for every path ("*" group, cached 24 h), ≥ 3 s between requests per host
//    (../lib/polite.ts), results cached 24 h, a challenge page (Cloudflare, CAPTCHA) → source skipped:
//      - infodoanhnghiep.com  (robots: Disallow /cgi-bin/ /out/ /api/ only) – /tim-kiem/auto/<MST>/ → /thong-tin/….html
//      - doanhnghiep.biz      (robots: no "*" group; blocks only named bots)  – /tim-kiem/?timkiem=<MST> → /<MST>-slug
//    Not used: masothue.com (search needs a session token and automated searches are answered with an UNRELATED
//    company – unreliable), thongtindoanhnghiep.co (connection refused), hosocongty.vn (redirects to another
//    site), tratencongty.com (search is a POST form; codes not shown as text).
//    A page whose MST differs from the requested one is discarded. ≥ 2 sources are CROSS-CHECKED field by field
//    (name, status, address, representative, registration date). Every fact is labelled unofficial; evidence is
//    recorded under the aggregator's domain WITH a warning, so grounding_check caps confidence at TRUNG BÌNH.
// 3. Text the USER copied from an official page (`official_text`) is parsed into a record (evidence source
//    "artifact" = user-provided) and preferred over aggregators.
// Privacy everywhere: company data only – ID numbers, dates of birth, personal addresses, phone numbers and
// e-mails are dropped; the legal representative is kept as a name only.
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import puppeteer from "puppeteer-core"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { recordEvidence, recordWarning } from "../lib/evidence.ts"
import { polite } from "../lib/polite.ts"
import { data, isoDate, withUi } from "../lib/ui-meta.ts"
import { fmt as fmtDate, nowVN } from "../lib/calendar.ts"
import {
  STATUS_RISK, checkMst, compareAddress, compareName, comparePerson, consensus, crossCheck, legalForm, parseOfficialText, parseResultPage, robotsAllows, statusOf,
  type CompanyRecord, type Cross, type FieldResult, type MstCheck, type SourceRecord,
} from "../lib/company-core.ts"
import { pageTables, requestAssist } from "../lib/assist.ts"

const PORT = process.env.CHROME_PORT ?? "9333"
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const CACHE = path.join(process.env.XDG_CACHE_HOME ?? path.join(ROOT, ".sandbox", "cache"), "legalai", "company")
const GATE_TTL = 6 * 3600 * 1000
const DAY = 24 * 3600 * 1000

// official entry points (what the user opens)
const URLS = {
  portal: "https://dangkykinhdoanh.gov.vn/vn/Pages/Trangchu.aspx",
  dkkd: "https://dichvuthongtin.dkkd.gov.vn/inf/default.aspx",
  egazette: "https://bocaodientu.dkkd.gov.vn/egazette/Forms/Egazette/DefaultAnnouncements.aspx",
  gdt: "https://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp",
} as const
const EGAZETTE_FILTER = "https://bocaodientu.dkkd.gov.vn/egazette/Forms/Egazette/ANNOUNCEMENTSListingInsUpd.aspx"
const today = () => fmtDate(nowVN().date)
const UNOFFICIAL = "⚠ Nguồn không chính thức (tổng hợp từ Cổng ĐKDN) – có thể chậm cập nhật; xác nhận trên cổng chính thức trước khi ký hợp đồng"

// ---------------------------------------------------------------- shared helpers
function cacheGet<T>(key: string, ttl: number): T | null {
  try { const f = path.join(CACHE, key.replace(/[^\w.-]/g, "_") + ".json"); if (Date.now() - fs.statSync(f).mtimeMs < ttl) return JSON.parse(fs.readFileSync(f, "utf8")) } catch {}
  return null
}
function cachePut(key: string, v: unknown) { try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(path.join(CACHE, key.replace(/[^\w.-]/g, "_") + ".json"), JSON.stringify(v)) } catch {} }
async function withPages<T>(n: number, fn: (pages: any[]) => Promise<T>): Promise<T> {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const pages: any[] = []
  try { for (let i = 0; i < n; i++) pages.push(await browser.newPage()); return await fn(pages) } finally { for (const p of pages) await p.close().catch(() => {}); browser.disconnect() }
}
const withPage = <T>(fn: (page: any) => Promise<T>) => withPages(1, (p) => fn(p[0]))

// ---------------------------------------------------------------- official CAPTCHA gate check (never solves it)
type Gate = "captcha" | "open" | "blocked" | "error"
type Gates = { at: number; dkkd: Gate; egazette: Gate; gdt: Gate; notes: string[] }
// at most 1 request / 2 s per official host (shared limiter)
const LIMIT = { concurrency: 1, gapMs: 2000 }
const goto = (page: any, url: string, opts: any, limit = LIMIT) => polite(url, () => page.goto(url, opts), limit)
const probe = (page: any, form: string, captcha: string) => page.evaluate((f: string, c: string) => {
  const t = (document.body?.innerText ?? "").slice(0, 3000)
  if (/request rejected|access denied|cloudflare|attention required/i.test(t)) return "blocked"
  if (!document.querySelector(f)) return "error"
  return document.querySelector(c) ? "captcha" : "open"
}, form, captcha)
const RECAPTCHA = "iframe[src*='recaptcha'], .g-recaptcha, script[src*='recaptcha']"

async function checkGates(force = false): Promise<Gates> {
  const hit = force ? null : cacheGet<Gates>("gates", GATE_TTL)
  if (hit) return hit
  const g: Gates = { at: Date.now(), dkkd: "error", egazette: "error", gdt: "error", notes: [] }
  try {
    await withPage(async (page) => {
      const step = async (name: keyof Omit<Gates, "at" | "notes">, fn: () => Promise<Gate>) => { try { g[name] = await fn() } catch (e: any) { g[name] = "error"; g.notes.push(`${name}: ${String(e?.message ?? e).slice(0, 120)}`) } }
      await step("dkkd", async () => {
        // the enterprise search form is reached from the home page link "Thông tin về một doanh nghiệp cụ thể"
        await goto(page, URLS.dkkd, { waitUntil: "networkidle2", timeout: 60000 })
        const link = await page.$("a[href*='ctl02$LnkActiveProdGroup']")
        if (!link) return (await probe(page, "#ctl00_FldSearch", RECAPTCHA)) === "blocked" ? "blocked" : "error"
        await polite(URLS.dkkd, () => Promise.all([page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }), link.click()]), LIMIT)
        return probe(page, "input[id$='ENTERPRISE_GDT_CODEFilterFld']", RECAPTCHA)
      })
      await step("egazette", async () => {
        await goto(page, EGAZETTE_FILTER, { waitUntil: "networkidle2", timeout: 60000 })
        return probe(page, "input[id$='ENT_GDT_CODEFld']", RECAPTCHA)
      })
      await step("gdt", async () => {
        await goto(page, URLS.gdt, { waitUntil: "domcontentloaded", timeout: 60000 })
        return probe(page, "input[name='mst']", "input[name='captcha'], img[src*='captcha']")
      })
    })
  } catch (e: any) { g.notes.push(`trình duyệt sandbox: ${String(e?.message ?? e).slice(0, 160)}`) }
  if (g.dkkd !== "error" || g.egazette !== "error" || g.gdt !== "error") cachePut("gates", g)
  return g
}
const GATE_TEXT: Record<Gate, string> = { captcha: "yêu cầu mã xác thực (CAPTCHA) – không tra tự động", open: "lần kiểm tra này không thấy CAPTCHA nhưng công cụ chưa hỗ trợ đọc tự động – tra thủ công", blocked: "từ chối truy cập tự động (tường lửa) – không vượt qua", error: "không kiểm tra được lúc này" }
const gateLines = (g: Gates) => [
  `- Cổng thông tin quốc gia về đăng ký doanh nghiệp – tra cứu doanh nghiệp (dichvuthongtin.dkkd.gov.vn): ${g.dkkd === "captcha" ? "Google reCAPTCHA" : GATE_TEXT[g.dkkd]}`,
  `- Bố cáo điện tử (bocaodientu.dkkd.gov.vn) – "Tìm bố cáo": ${g.egazette === "captcha" ? "Google reCAPTCHA" : GATE_TEXT[g.egazette]}`,
  `- Cục Thuế – Tra cứu thông tin người nộp thuế (tracuunnt.gdt.gov.vn): ${g.gdt === "captcha" ? "mã xác nhận dạng ảnh" : GATE_TEXT[g.gdt]}`,
]
const gatedText = (g: Gates) => ([g.dkkd, g.egazette, g.gdt].includes("captcha") ? "Nguồn chính thức yêu cầu mã xác thực – không tra tự động." : "Không tra tự động được nguồn chính thức lúc này.")

// ---------------------------------------------------------------- assisted official lookup (the USER passes the CAPTCHA)
// ../lib/assist.ts opens the official form in an isolated tab of the sandbox Chrome with the MST filled in; the web UI
// mirrors that tab to the chat owner, who types the image code (tracuunnt) or ticks / solves reCAPTCHA (dkkd) and
// presses the search button themselves. When the result page appears the tool reads it (detail row included).
// On by default for web chats (the web server starts serve with ND45_ASSIST=1), off in the CLI (no one to ask);
// the `assist` argument overrides. Cancel / timeout / no result → the aggregator path below, as before.
type AssistSource = "gdt" | "dkkd"
type OfficialHit = { source: AssistSource; host: string; url: string; rec: CompanyRecord; at: string }
type AssistOutcome = { status: "done" | "cancelled" | "timeout" | "error" | "not_found" | "unparsed"; source: AssistSource; hit?: OfficialHit }
const assistDefault = () => process.env.ND45_ASSIST === "1"
const ASSIST_TIMEOUT = () => Math.min(Math.max(Number(process.env.ND45_ASSIST_TIMEOUT_MS) || 300_000, 30_000), 900_000)
const SOURCE_LABEL: Record<AssistSource, string> = { gdt: "Cục Thuế – Tra cứu thông tin người nộp thuế", dkkd: "Cổng thông tin quốc gia về đăng ký doanh nghiệp" }
const SOURCE_HOST: Record<AssistSource, string> = { gdt: "tracuunnt.gdt.gov.vn", dkkd: "dichvuthongtin.dkkd.gov.vn" }
/** Click the link of the result row that shows `code` (detail pane / page), then return the page's tables + text. */
const readDetail = (navigates: boolean, code: string) => async (page: any): Promise<string> => {
  const href = await page.evaluate((code: string) => {
    for (const tr of Array.from(document.querySelectorAll("tr"))) {
      if (!new RegExp(`(^|\\D)${code.replace(/-/g, "-?")}(?![\\d-])`).test((tr as HTMLElement).innerText ?? "")) continue
      const a = tr.querySelector("a") as HTMLAnchorElement | null
      if (a) { a.setAttribute("data-assist-detail", "1"); return true }
    }
    return false
  }, code).catch(() => false)
  if (href) {
    const click = page.click("a[data-assist-detail='1']").catch(() => {})
    if (navigates) await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20_000 }).catch(() => {}), click])
    else { await click; await new Promise((r) => setTimeout(r, 1200)) }
  }
  const [tables, text] = await Promise.all([pageTables(page), page.evaluate(() => document.body?.innerText ?? "").catch(() => "")])
  return `${tables}\n\n${text}`
}
/** The assisted-browsing request for one official source (exported for the real-page regression test). */
export const assistSpec = (source: AssistSource, code: string, testUrl = "") =>
  source === "gdt"
    ? {
        url: testUrl || URLS.gdt,
        openUrl: testUrl || URLS.gdt,
        prefill: [{ selector: "input[name='mst']", value: code }],
        focus: "#captcha, input[name='captcha']",
        // the site's "Tra cứu" is a JS button (no submit button, Enter does nothing): Enter in a box clicks it
        focusAlso: "input.subBtn, input[onclick*='search']",
        enterClicks: "input.subBtn, input[onclick*='search']",
        // the result list (#resultContainer) or the "no taxpayer found" message; the MST as page text (not the input box)
        successWhen: { selector: "#resultContainer", textIncludes: [code, "Không tìm thấy", "không tìm thấy"] },
        collect: readDetail(false, code),
      }
    : {
        url: URLS.dkkd,
        openUrl: URLS.dkkd,
        // open "Thông tin về một doanh nghiệp cụ thể" (a postback link, no CAPTCHA) – the user then ticks reCAPTCHA
        prepare: async (page: any) => {
          const link = await page.$("a[href*='ctl02$LnkActiveProdGroup']")
          if (link) await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {}), link.click()])
        },
        prefill: [{ selector: "input[id$='ENTERPRISE_GDT_CODEFilterFld']", value: code }],
        focus: ".g-recaptcha, [id$='Googlerecaptcha']",
        focusAlso: "input[id$='BtnFilter']",
        enterClicks: "input[id$='BtnFilter']",
        successWhen: { selector: "#ctl00_C_UC_ENT_LIST1_CtlList a", textIncludes: [code] },
        collect: readDetail(true, code),
      }
async function officialAssist(sid: string, code: string, source: AssistSource, purpose: "company_lookup" | "company_verify", signal?: AbortSignal): Promise<AssistOutcome> {
  // tests only: a local stand-in for the tracuunnt form (tools/assist-fake-site.mjs), honoured with ND45_ASSIST_TEST=1
  const testUrl = process.env.ND45_ASSIST_TEST === "1" && source === "gdt" ? process.env.ND45_ASSIST_TEST_URL ?? "" : ""
  const common = { sessionID: sid, purpose, source, timeoutMs: ASSIST_TIMEOUT(), signal, ...(testUrl ? { testHosts: [new URL(testUrl).host] } : {}) }
  const r = await requestAssist({ ...common, ...assistSpec(source, code, testUrl) }).catch((e: any) => ({ ok: false, status: "error" as const, error: String(e?.message ?? e) }))
  if (!r.ok) return { status: r.status === "done" ? "error" : (r.status as AssistOutcome["status"]), source }
  const page = `${(r as any).collected ?? ""}\n\n${(r as any).text ?? ""}`
  const { rec, notFound, codeOk } = parseResultPage(page, code)
  if (notFound) return { status: "not_found", source }
  if (!codeOk || !(rec.name || rec.status)) return { status: "unparsed", source }
  const hit: OfficialHit = { source, host: SOURCE_HOST[source], url: testUrl || (source === "gdt" ? URLS.gdt : URLS.dkkd), rec, at: new Date().toISOString() }
  // evidence = the structured company record under the OFFICIAL domain (grounding may reach CAO); never the raw page
  recordEvidence(sid, { url: hit.url, title: `${SOURCE_LABEL[source]} – ${rec.name ?? code} (MST ${code})`, text: recordLines(rec).map((l) => l.replace(/^- /, "")).join("\n"), source: hit.host, meta: { official: true, origin: "assist" } })
  return { status: "done", source, hit }
}
const ASSIST_MISS: Record<Exclude<AssistOutcome["status"], "done">, string> = {
  cancelled: "người dùng đã huỷ bước xác minh",
  timeout: "hết thời gian chờ người dùng xác minh",
  error: "không mở được trang chính thức lúc này",
  not_found: "trang chính thức báo không tìm thấy mã này",
  unparsed: "không đọc được trang kết quả",
}
const assistLine = (o: AssistOutcome) =>
  o.status === "done"
    ? `XÁC MINH TRÊN NGUỒN CHÍNH THỨC: trang ${SOURCE_LABEL[o.source]} (${SOURCE_HOST[o.source]}) yêu cầu xác minh người thật – người dùng đã tự thực hiện (nhập mã / tích ô) trong khung trợ giúp, công cụ đọc trang kết quả. Khi trả lời, nói ngắn gọn rằng đã cần một bước xác minh trên trang chính thức và người dùng đã hoàn tất.`
    : `Đã mời người dùng tự xác minh trên trang chính thức (${SOURCE_HOST[o.source]}) nhưng ${ASSIST_MISS[o.status]}${o.status === "not_found" ? " – kiểm tra lại MST; không kết luận doanh nghiệp không tồn tại chỉ từ một lần tra" : ""}. Nói ngắn gọn với người dùng rằng bước xác minh chưa hoàn tất (có thể thử lại, hoặc tự tra theo link bên dưới).`
const officialLines = (h: OfficialHit) => [
  `THÔNG TIN DOANH NGHIỆP – NGUỒN CHÍNH THỨC: ${SOURCE_LABEL[h.source]} (${h.url}), đọc lúc ${new Date(h.at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}:`,
  ...recordLines(h.rec),
  "Đã bỏ khỏi kết quả: số giấy tờ, ngày sinh, địa chỉ, điện thoại, e-mail của cá nhân (nếu trang có).",
  `Nguồn chính thức để dẫn: ${h.url} (Ngày tra cứu: ${today()})`,
]
const RULES_OFFICIAL = "Hướng dẫn trả lời: thông tin trên lấy trực tiếp từ nguồn chính thức (người dùng tự qua bước xác minh) – nêu như thông tin chính thức kèm tên cổng + link + ngày tra cứu; chỉ nêu các mục có trong kết quả; người đại diện chỉ họ tên; không nêu số giấy tờ / điện thoại / e-mail cá nhân."
const assistUi = (o: AssistOutcome | null) => (o ? { assist: { status: o.status, source: o.source } } : {})
const officialSourceUi = (h: OfficialHit) => [{ domain: h.host, url: h.url, official: true, fetchedAt: h.at }]

// ---------------------------------------------------------------- reference aggregators (unofficial)
const AGG_LIMIT = { concurrency: 1, gapMs: 3000 }
type Agg = { domain: string; search: (q: string) => string }
const AGGREGATORS: Agg[] = [
  { domain: "infodoanhnghiep.com", search: (q) => `https://infodoanhnghiep.com/tim-kiem/auto/${encodeURIComponent(q)}/` },
  { domain: "doanhnghiep.biz", search: (q) => `https://doanhnghiep.biz/tim-kiem/?timkiem=${encodeURIComponent(q)}` },
]
type AggHit = SourceRecord & { fetchedAt: string; updated?: string }
type AggMiss = { domain: string; reason: "robots" | "challenge" | "not_found" | "code_mismatch" | "error"; detail?: string; url?: string }
type Candidate = { domain: string; name: string; code: string; url: string }
const CHALLENGE = /just a moment|checking your browser|verify you are human|attention required|cf-chl|captcha|access denied|request rejected/i

/** robots.txt of a host ("*" group), cached 24 h; 4xx = no restrictions, 5xx / unreachable = treat as disallowed. */
async function robotsOf(page: any, domain: string): Promise<string | null> {
  const key = `robots-${domain}`
  const hit = cacheGet<{ txt: string | null }>(key, DAY)
  if (hit) return hit.txt
  let txt: string | null = null
  try {
    const r = await goto(page, `https://${domain}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 45000 }, AGG_LIMIT)
    const st = r?.status() ?? 0
    txt = st >= 400 && st < 500 ? "" : st >= 200 && st < 300 ? await r.text() : null
  } catch { txt = null }
  cachePut(key, { txt })
  return txt
}
async function allowed(page: any, url: string): Promise<boolean> {
  // Owner's decision (27/09/2026): robots.txt is not a gate for these on-demand, per-user lookups.
  // RESPECT_ROBOTS=1 restores the check. CAPTCHA / challenge pages are still never bypassed.
  if (process.env.RESPECT_ROBOTS !== "1") return true
  const u = new URL(url)
  const txt = await robotsOf(page, u.hostname.replace(/^www\./, ""))
  return txt !== null && robotsAllows(txt, u.pathname + u.search, "LegalAI")
}
async function open(page: any, url: string): Promise<{ ok: true } | { ok: false; reason: AggMiss["reason"]; detail: string }> {
  if (!(await allowed(page, url))) return { ok: false, reason: "robots", detail: `robots.txt không cho phép ${new URL(url).pathname}` }
  const r = await goto(page, url, { waitUntil: "domcontentloaded", timeout: 60000 }, AGG_LIMIT)
  const head = await page.evaluate(() => `${document.title}\n${(document.body?.innerText ?? "").slice(0, 1500)}`)
  if ((r?.status() ?? 0) >= 400 && (r?.status() ?? 0) !== 404) return { ok: false, reason: CHALLENGE.test(head) ? "challenge" : "error", detail: `HTTP ${r?.status()}` }
  if (CHALLENGE.test(head)) return { ok: false, reason: "challenge", detail: "trang kiểm tra chống bot / CAPTCHA – bỏ qua, không vượt" }
  return { ok: true }
}
/** label → value pairs of the detail table (first line of each value only). */
const pairsOf = (page: any): Promise<string> => page.evaluate(() => {
  const first = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? "").split("\n").map((s) => s.trim()).find(Boolean) ?? ""
  const out: string[] = []
  for (const tr of Array.from(document.querySelectorAll("tr"))) { const c = tr.querySelectorAll("td,th"); if (c.length >= 2) out.push(`${first(c[0])}:\t${first(c[1])}`) }
  for (const h of Array.from(document.querySelectorAll("[class*='cell-head'], dt"))) out.push(`${first(h)}\t${first(h.nextElementSibling)}`)
  // the enterprise name as schema.org markup (a header cell on some sites); last, so a labelled row wins
  const nm = document.querySelector("[itemprop='name']:not([itemscope] [itemprop='name'])")
  if (nm) out.push(`Tên doanh nghiệp:\t${first(nm)}`)
  return out.join("\n")
})
/** A result link for exactly this code (not a branch "-xxx" of it). */
const pickDetail = (page: any, code: string): Promise<string | null> => page.evaluate((code: string) => {
  const esc = code.replace(/-/g, "\\-")
  const exact = new RegExp(`(?:Mã số thuế|MST|ĐKKD/Mã số thuế)\\s*:?\\s*${esc}(?![\\d-])`, "i")
  const byHref = new RegExp(`/${esc}-[a-z]`, "i")
  for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
    if (byHref.test(a.pathname)) return a.href
    if (!/\/thong-tin\//.test(a.pathname)) continue
    let el: Element | null = a
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) if (exact.test((el as HTMLElement).innerText ?? "")) return a.href
  }
  return null
}, code)

async function fetchAgg(page: any, agg: Agg, code: string): Promise<AggHit | AggMiss> {
  const key = `agg-${agg.domain}-${code}`
  const hit = cacheGet<AggHit | AggMiss>(key, DAY)
  if (hit) return hit
  const res = await (async (): Promise<AggHit | AggMiss> => {
    try {
      const s = agg.search(code)
      const o1 = await open(page, s)
      if (!o1.ok) return { domain: agg.domain, reason: o1.reason, detail: o1.detail, url: s }
      const href = await pickDetail(page, code)
      if (!href || !href.includes(agg.domain)) return { domain: agg.domain, reason: "not_found", detail: "không có kết quả đúng MST này", url: s }
      const o2 = await open(page, href)
      if (!o2.ok) return { domain: agg.domain, reason: o2.reason, detail: o2.detail, url: href }
      const text = await pairsOf(page)
      const body: string = await page.evaluate(() => document.body?.innerText ?? "")
      const rec = parseOfficialText(text)
      if (!rec.code || rec.code.replace(/-/g, "") !== code.replace(/-/g, "")) return { domain: agg.domain, reason: "code_mismatch", detail: `trang trả về MST ${rec.code ?? "?"} – bỏ`, url: href }
      const up = body.match(/Cập nhật[^\n]{0,40}?(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i)?.[1]
      return { domain: agg.domain, url: page.url(), rec, fetchedAt: new Date().toISOString(), ...(up ? { updated: up } : {}) }
    } catch (e: any) { return { domain: agg.domain, reason: "error", detail: String(e?.message ?? e).slice(0, 140) } }
  })()
  if (!("reason" in res) || res.reason !== "error") cachePut(key, res)
  return res
}
async function searchAgg(page: any, agg: Agg, name: string): Promise<Candidate[] | AggMiss> {
  const key = `aggname-${agg.domain}-${name.toLowerCase()}`
  const hit = cacheGet<Candidate[] | AggMiss>(key, DAY)
  if (hit) return hit
  try {
    const s = agg.search(name)
    const o = await open(page, s)
    if (!o.ok) return { domain: agg.domain, reason: o.reason, detail: o.detail, url: s }
    const list: Candidate[] = (await page.evaluate(() => {
      const out: { name: string; code: string; url: string }[] = []
      for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
        const t = (a.innerText ?? "").trim()
        if (t.length < 6 || !/[A-ZÀ-Ỹ]{3}/.test(t)) continue
        let el: Element | null = a, code = ""
        for (let i = 0; i < 4 && el && !code; i++, el = el.parentElement) code = ((el as HTMLElement).innerText ?? "").match(/(?:Mã số thuế|ĐKKD\/Mã số thuế)\s*:?\s*(\d{10}(?:-\d{3})?)/i)?.[1] ?? ""
        if (!code) code = a.pathname.match(/\/(\d{10}(?:-\d{3})?)-[a-z]/i)?.[1] ?? ""
        if (code && !out.some((x) => x.code === code)) out.push({ name: t.split("\n")[0], code, url: a.href })
      }
      return out.slice(0, 5)
    })).map((x: any) => ({ ...x, domain: agg.domain }))
    cachePut(key, list)
    return list
  } catch (e: any) { return { domain: agg.domain, reason: "error", detail: String(e?.message ?? e).slice(0, 140) } }
}
async function aggregatorsFor(code: string, sid?: string): Promise<{ hits: AggHit[]; misses: AggMiss[]; cross: Cross[] }> {
  let results: (AggHit | AggMiss)[] = []
  try { results = await withPages(AGGREGATORS.length, (pages) => Promise.all(AGGREGATORS.map((a, i) => fetchAgg(pages[i], a, code)))) }
  catch (e: any) { results = AGGREGATORS.map((a) => ({ domain: a.domain, reason: "error" as const, detail: String(e?.message ?? e).slice(0, 140) })) }
  const hits = results.filter((r): r is AggHit => !("reason" in r))
  const misses = results.filter((r): r is AggMiss => "reason" in r)
  for (const h of hits) {
    recordEvidence(sid, { url: h.url, title: `${h.domain} – ${h.rec.name ?? code} (nguồn không chính thức)`, text: recordLines(h.rec).map((l) => l.replace(/^- /, "")).join("\n"), source: h.domain, meta: { official: false, aggregator: true } })
    recordWarning(sid, h.url, `⚠ Nguồn không chính thức: ${h.domain} (trang tổng hợp thông tin doanh nghiệp) – chỉ tham khảo, có thể chậm cập nhật; phải xác nhận trên cổng chính thức (dangkykinhdoanh.gov.vn / tracuunnt.gdt.gov.vn).`)
  }
  return { hits, misses, cross: crossCheck(hits) }
}
const MISS_TEXT: Record<AggMiss["reason"], string> = { robots: "robots.txt không cho phép", challenge: "trang kiểm tra chống bot / CAPTCHA – bỏ qua", not_found: "không có dữ liệu cho mã này", code_mismatch: "trang trả về doanh nghiệp khác – bỏ", error: "lỗi truy cập" }
const CROSS_LABEL: Record<Cross["field"], string> = { name: "Tên doanh nghiệp", status: "Tình trạng", address: "Địa chỉ trụ sở", representative: "Người đại diện", regDate: "Ngày cấp / thành lập" }
function aggLines(hits: AggHit[], misses: AggMiss[], cross: Cross[]): string[] {
  if (!hits.length) return misses.length ? [`Nguồn tham khảo không chính thức: không lấy được (${misses.map((m) => `${m.domain}: ${MISS_TEXT[m.reason]}${m.detail ? ` – ${m.detail}` : ""}`).join("; ")}).`] : []
  const L = [`THAM KHẢO TỪ ${hits.length} NGUỒN KHÔNG CHÍNH THỨC – ${UNOFFICIAL}:`]
  hits.forEach((h, i) => {
    L.push(`[${i + 1}] ${h.domain} – ${h.url} (lấy lúc ${new Date(h.fetchedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}${h.updated ? `; trang ghi cập nhật ${h.updated}` : ""}):`)
    L.push(...recordLines(h.rec).map((l) => `  ${l} [⚠ không chính thức – ${h.domain}]`))
  })
  if (hits.length >= 2) {
    L.push("ĐỐI CHIẾU CHÉO các nguồn không chính thức:", `| Mục | ${hits.map((h) => h.domain).join(" | ")} | Kết quả |`, `|---|${hits.map(() => "---|").join("")}---|`)
    for (const c of cross) L.push(`| ${CROSS_LABEL[c.field]} | ${hits.map((h) => c.values.find((v) => v.domain === h.domain)?.v ?? "—").join(" | ")} | ${c.agree ? (c.values.length > 1 ? "THỐNG NHẤT" : "chỉ 1 nguồn") : "KHÔNG THỐNG NHẤT"} |`)
    const dis = cross.filter((c) => !c.agree)
    const ups = hits.filter((h) => h.updated).map((h) => `${h.domain}: ${h.updated}`)
    L.push(dis.length
      ? `⚠ Các nguồn KHÔNG thống nhất về: ${dis.map((c) => CROSS_LABEL[c.field].toLowerCase()).join(", ")} – ít nhất một nguồn chưa cập nhật; KHÔNG kết luận mục này, KHÔNG suy đoán nguồn nào đúng (kể cả theo hiểu biết riêng về doanh nghiệp / lãnh đạo), nêu cả hai giá trị và BẮT BUỘC xác nhận trên cổng chính thức.${ups.length ? ` Ngày cập nhật do chính các trang tự ghi (chỉ để tham khảo, không phải căn cứ): ${ups.join("; ")}.` : ""}`
      : "Các nguồn không chính thức thống nhất ở các mục trên – vẫn chỉ là tham khảo, chưa phải xác nhận chính thức.")
  } else L.push("Chỉ 1 nguồn không chính thức lấy được – không đối chiếu chéo được; độ tin cậy thấp hơn.")
  if (misses.length) L.push(`Không lấy được: ${misses.map((m) => `${m.domain} (${MISS_TEXT[m.reason]})`).join("; ")}.`)
  return L
}
const sourcesUi = (hits: AggHit[]) => hits.map((h) => ({ domain: h.domain, url: h.url, official: false, fetchedAt: h.fetchedAt, ...(isoDate(h.updated) ? { updated: isoDate(h.updated) } : {}) }))
const crossUi = (cross: Cross[]) => cross.map((c) => ({ field: c.field, agree: c.agree, values: c.values.map((v) => ({ domain: v.domain, v: data(v.v)?.v ?? "" })) }))

// ---------------------------------------------------------------- manual instructions
function manualSteps(code?: string, name?: string): string[] {
  const what = code ? `Mã số doanh nghiệp: ${code}` : `Tên doanh nghiệp: ${name}`
  const gdtWhat = code ? `Mã số thuế: ${code}` : `Tên tổ chức cá nhân nộp thuế: ${name} (có thể thêm Địa chỉ trụ sở để thu hẹp)`
  return [
    "Cách tự kiểm tra trên nguồn chính thức (miễn phí, cần tích / nhập mã xác thực):",
    `1. Cổng thông tin quốc gia về đăng ký doanh nghiệp: mở ${URLS.dkkd} (hoặc ${URLS.portal} → "Tìm doanh nghiệp") → mục "Thông tin về một doanh nghiệp cụ thể" → nhập ${what} → tích "Tôi không phải là người máy" (reCAPTCHA) → "Tìm kiếm" → bấm vào tên doanh nghiệp → phần thông tin cơ bản miễn phí: tên (tiếng Việt / nước ngoài / viết tắt), mã số, tình trạng hoạt động, loại hình pháp lý, ngày bắt đầu thành lập, tên người đại diện theo pháp luật, địa chỉ trụ sở chính, ngành nghề kinh doanh.`,
    `2. Cục Thuế: mở ${URLS.gdt} → thẻ "Thông tin về người nộp thuế" → nhập ${gdtWhat} → nhập "Mã xác nhận" trong ảnh → "Tra cứu" → bấm tên để xem: tên người nộp thuế, cơ quan thuế quản lý, trạng thái (VD "NNT đang hoạt động", "NNT không hoạt động tại địa chỉ đã đăng ký", "NNT ngừng hoạt động…", "tạm ngừng…").`,
    `3. (Khi cần lịch sử thay đổi / giải thể) Bố cáo điện tử: ${URLS.egazette} → "Tìm bố cáo" → ${code ? `Mã số doanh nghiệp: ${code}` : `Tên doanh nghiệp: ${name}`} → reCAPTCHA → danh sách thông báo (đăng ký mới, thay đổi, tạm ngừng, giải thể, thu hồi…).`,
    `Sau khi tra: sao chép nội dung trang kết quả và gọi company_verify(tax_code, official_text=<nội dung đã chép>, expected_name / expected_address / expected_representative = thông tin trong hợp đồng) để đối chiếu từng mục – công cụ tự bỏ số giấy tờ, địa chỉ, số điện thoại của cá nhân.`,
  ]
}
const RULES = "Hướng dẫn trả lời: KHÔNG nêu tên, tình trạng hoạt động, người đại diện, địa chỉ của doanh nghiệp theo trí nhớ; nói rõ nguồn chính thức yêu cầu mã xác thực nên chưa xác minh tự động, đưa các link + bước trên cho người dùng. MST hợp lệ về định dạng KHÔNG có nghĩa là mã đã được cấp / doanh nghiệp đang hoạt động."
const RULES_AGG = `Hướng dẫn trả lời: chỉ nêu thông tin có trong các nguồn trên; MỖI thông tin lấy từ trang tổng hợp phải kèm nhãn "${UNOFFICIAL}" (có thể ghi một lần ngay trên danh sách / bảng) và tên nguồn; mục các nguồn KHÔNG thống nhất → nêu cả hai giá trị, không tự chọn, không suy đoán lý do hay nguồn nào đúng hơn, không thêm hiểu biết riêng (chức vụ, thay đổi nhân sự…); luôn kèm link cổng chính thức + các bước tự tra; không nêu số điện thoại / e-mail / giấy tờ cá nhân. Độ tin cậy tối đa TRUNG BÌNH.`

function mstLine(c: MstCheck): string {
  if (c.ok) return `Kiểm tra định dạng MST: HỢP LỆ – ${c.kind === "branch" ? `13 chữ số: đơn vị phụ thuộc số ${c.branch} (chi nhánh / VPĐD / địa điểm kinh doanh) của doanh nghiệp có mã ${c.base}` : "10 chữ số, chữ số kiểm tra đúng (mã số doanh nghiệp = mã số thuế)"}. (Chỉ là kiểm tra toán học, không cho biết mã đã được cấp hay chưa.)`
  return `Kiểm tra định dạng MST "${c.input}": KHÔNG HỢP LỆ – ${c.detail}${c.expected ? ` (với 9 số đầu này, MST hợp lệ sẽ là ${c.expected})` : ""}.`
}
const checksumCode = (c: MstCheck) => (c.ok ? "valid" : c.reason === "checksum" ? "invalid" : c.reason)
const portalsUi = (g?: Gates) => g ? [
  { src: "dkkd", gate: g.dkkd, url: URLS.dkkd }, { src: "dkkd_egazette", gate: g.egazette, url: URLS.egazette }, { src: "gdt", gate: g.gdt, url: URLS.gdt },
] : [{ src: "dkkd", url: URLS.dkkd }, { src: "dkkd_egazette", url: URLS.egazette }, { src: "gdt", url: URLS.gdt }]

// ---------------------------------------------------------------- records
function recordLines(r: CompanyRecord): string[] {
  const L: string[] = []
  const add = (k: string, v?: string) => { if (v) L.push(`- ${k}: ${v}`) }
  add("Tên doanh nghiệp", r.name); add("Tên bằng tiếng nước ngoài", r.nameEn); add("Tên viết tắt / giao dịch", r.short)
  add("Mã số doanh nghiệp / MST", r.code)
  if (r.status) L.push(`- Tình trạng: ${r.status}${r.statusCode ? ` → ${STATUS_RISK[r.statusCode] ?? ""}` : ""}`)
  add("Loại hình", r.type); add("Ngày thành lập / cấp mã", r.regDate); add("Địa chỉ trụ sở chính", r.address)
  add("Người đại diện theo pháp luật (chỉ họ tên)", r.representative); add("Ngành nghề chính", r.mainLine); add("Cơ quan thuế quản lý", r.taxAuthority)
  return L
}
const companyUi = (r: CompanyRecord & { conflicts?: string[] }, origin: "user_paste" | "aggregator" | "official" = "user_paste") => ({
  origin,
  name: data(r.name, "vi"), nameEn: data(r.nameEn, "en"), short: data(r.short), code: r.code,
  status: r.statusCode, statusText: data(r.status, "vi"), regDate: isoDate(r.regDate), legalType: data(r.type, "vi"),
  address: data(r.address, "vi"), representative: data(r.representative), mainLine: data(r.mainLine, "vi"), taxAuthority: data(r.taxAuthority, "vi"),
  ...(r.conflicts?.length ? { conflicts: r.conflicts } : {}),
})
function useOfficialText(sid: string | undefined, code: string | undefined, text: string): CompanyRecord {
  const r = parseOfficialText(text)
  // evidence: the structured COMPANY record only (never the raw paste, which may hold personal data)
  const rec = recordLines(r).join("\n")
  if (rec) recordEvidence(sid, { url: `user-paste://company/${code ?? r.code ?? "unknown"}`, title: "Thông tin doanh nghiệp do người dùng sao chép từ trang chính thức", text: rec, source: "artifact", meta: { origin: "user_paste" } })
  return r
}

// ---------------------------------------------------------------- tools
export const lookup = tool({
  description:
    "TRA CỨU DOANH NGHIỆP / MÃ SỐ THUẾ: kiểm tra MST 10 / 13 số (chữ số kiểm tra); nguồn CHÍNH THỨC trước (Cổng thông tin quốc gia về đăng ký doanh nghiệp, Cục Thuế tracuunnt – đều yêu cầu CAPTCHA: trên giao diện web công cụ mời NGƯỜI DÙNG tự xác minh ngay trên trang chính thức (khung trợ giúp, công cụ không bao giờ tự giải CAPTCHA) rồi đọc kết quả chính thức; người dùng huỷ / hết giờ / chạy CLI → link + các bước để người dùng tự tra), sau đó THAM KHẢO ≥ 2 trang tổng hợp không chính thức (infodoanhnghiep.com, doanhnghiep.biz) và ĐỐI CHIẾU CHÉO tên, tình trạng, địa chỉ, người đại diện, ngày cấp. Mọi thông tin từ trang tổng hợp gắn nhãn \"Nguồn không chính thức\" – phải xác nhận trên cổng chính thức trước khi ký hợp đồng. Người dùng dán nội dung trang chính thức (official_text) → trích tên (VI/EN/viết tắt), MST, tình trạng, ngày thành lập, địa chỉ trụ sở, người đại diện (chỉ họ tên), ngành nghề chính, cơ quan thuế. Bỏ mọi số giấy tờ / địa chỉ / SĐT / e-mail cá nhân. Không nêu thông tin doanh nghiệp theo trí nhớ.",
  args: {
    tax_code: tool.schema.string().optional().describe("Mã số doanh nghiệp / MST: 10 chữ số, hoặc 13 chữ số của chi nhánh dạng 0123456789-001"),
    name: tool.schema.string().optional().describe("Tên doanh nghiệp (khi không có MST) – trả danh sách MST gợi ý từ trang tổng hợp để tra tiếp bằng tax_code"),
    official_text: tool.schema.string().optional().describe("Nội dung người dùng SAO CHÉP từ trang kết quả chính thức (dangkykinhdoanh / tracuunnt) để trích thông tin"),
    assist: tool.schema.boolean().optional().describe("Mời người dùng tự xác minh CAPTCHA trên trang chính thức ngay trong giao diện web (mặc định: bật khi chạy từ web, tắt ở CLI). false = chỉ trả link + bước tự tra"),
    assist_source: tool.schema.enum(["gdt", "dkkd"]).optional().describe("Trang chính thức cho bước xác minh: gdt = Cục Thuế tracuunnt (mã xác nhận dạng ảnh, mặc định), dkkd = Cổng đăng ký doanh nghiệp (reCAPTCHA; có người đại diện, loại hình, ngành nghề)"),
  },
  async execute({ tax_code, name, official_text, assist, assist_source }, context) {
    const sid = context?.sessionID
    const code = String(tax_code ?? "").trim(), nm = String(name ?? "").trim()
    if (!code && !nm && !official_text) return "Lỗi: cần tax_code (MST 10 hoặc 13 số) hoặc name (tên doanh nghiệp)."
    const c = code ? checkMst(code) : null
    const head = `TRA CỨU DOANH NGHIỆP – ${c ? `MST ${c.ok ? c.code : code}` : `tên "${nm}"`} (Ngày tra cứu: ${today()})`
    if (c && !c.ok && c.reason === "personal_id")
      return withUi([head, mstLine(c), "Không tra cứu / không hiển thị thông tin cá nhân. Nếu đối tác là hộ kinh doanh / cá nhân, đề nghị họ cung cấp giấy tờ đăng ký và tự kiểm tra trên nguồn chính thức."].join("\n"),
        { res: { t: "status", code: "personal_id" }, card: { kind: "company", mode: "lookup", status: "personal_id", checksum: "personal_id", date: isoDate(today()) } })
    if (c && !c.ok && c.reason !== "checksum" && !official_text)
      return withUi([head, mstLine(c), "Đề nghị người dùng kiểm tra lại MST trên hợp đồng / hóa đơn / Giấy chứng nhận ĐKDN."].join("\n"),
        { res: { t: "status", code: "invalid_code" }, card: { kind: "company", mode: "lookup", status: "invalid_code", taxCode: code, checksum: checksumCode(c), date: isoDate(today()) } })

    // user-copied official page → preferred over everything else
    const rec = official_text ? useOfficialText(sid, c?.ok ? c.code : undefined, official_text) : null
    if (rec && Object.keys(rec).length) {
      const codeMismatch = c?.ok && rec.code && rec.code.replace(/-/g, "") !== c.code.replace(/-/g, "")
      const text = [
        head, c ? mstLine(c) : "",
        "THÔNG TIN DOANH NGHIỆP theo nội dung người dùng sao chép từ trang chính thức (công cụ KHÔNG tự mở được trang do CAPTCHA – ghi rõ \"theo thông tin người dùng cung cấp từ <tên cổng>\" khi trả lời):",
        ...recordLines(rec),
        codeMismatch ? `⚠ MST trong nội dung dán (${rec.code}) KHÁC MST cần tra (${c!.ok ? c!.code : ""}) – có thể dán nhầm trang của doanh nghiệp khác.` : "",
        "Đã bỏ khỏi kết quả: số giấy tờ, ngày sinh, địa chỉ, điện thoại, e-mail của cá nhân (nếu có trong nội dung dán).",
        `Nguồn chính thức để dẫn: ${URLS.dkkd} ; ${URLS.gdt} (Ngày tra cứu: ${today()})`,
      ].filter(Boolean).join("\n")
      return withUi(text, { res: { t: "status", code: rec.statusCode ? `co_${rec.statusCode}` : "parsed" }, card: { kind: "company", mode: "lookup", status: "parsed", basis: "user_paste", taxCode: c?.ok ? c.code : rec.code, checksum: c ? checksumCode(c) : undefined, company: companyUi(rec), codeMismatch: !!codeMismatch, portals: portalsUi(), date: isoDate(today()) } })
    }

    // 1. official source with the user's help (assisted browsing: the user passes the CAPTCHA themselves)
    let ao: AssistOutcome | null = null
    if (c?.ok && sid && (assist ?? assistDefault())) {
      ao = await officialAssist(sid, c.code, assist_source ?? "gdt", "company_lookup", (context as any)?.abort)
      if (ao.hit) {
        const h = ao.hit
        const codeMismatch = !!h.rec.code && h.rec.code.replace(/-/g, "") !== c.code.replace(/-/g, "")
        const text = [head, mstLine(c), assistLine(ao), ...officialLines(h), codeMismatch ? `⚠ MST trên trang kết quả (${h.rec.code}) KHÁC MST cần tra.` : "", RULES_OFFICIAL].filter(Boolean).join("\n")
        return withUi(text, { res: { t: "status", code: h.rec.statusCode ? `co_${h.rec.statusCode}` : "parsed" }, card: { kind: "company", mode: "lookup", status: "parsed", basis: "official", taxCode: c.code, codeKind: c.kind, checksum: checksumCode(c), company: companyUi(h.rec, "official"), sources: officialSourceUi(h), codeMismatch, portals: portalsUi(), date: isoDate(today()), ...assistUi(ao) } })
      }
    }
    // 2. official portals (CAPTCHA check)
    const g = await checkGates()
    for (const [host, gate] of [["dichvuthongtin.dkkd.gov.vn", g.dkkd], ["tracuunnt.gdt.gov.vn", g.gdt]] as const)
      if (gate === "captcha") recordWarning(sid, `https://${host}/`, `${host}: nguồn chính thức yêu cầu mã xác thực – thông tin doanh nghiệp ${c?.ok ? c.code : nm} CHƯA được xác minh trên nguồn chính thức.`)
    // 2. reference aggregators
    let agg: { hits: AggHit[]; misses: AggMiss[]; cross: Cross[] } = { hits: [], misses: [], cross: [] }
    let cands: Candidate[] = [], candMiss: AggMiss[] = []
    if (c?.ok) agg = await aggregatorsFor(c.code, sid)
    else if (!c && nm) {
      const r = await withPages(AGGREGATORS.length, (pages) => Promise.all(AGGREGATORS.map((a, i) => searchAgg(pages[i], a, nm)))).catch((e: any) => AGGREGATORS.map((a) => ({ domain: a.domain, reason: "error" as const, detail: String(e?.message ?? e) })))
      for (const x of r) Array.isArray(x) ? cands.push(...x) : candMiss.push(x)
    }
    const hasAgg = agg.hits.length > 0
    const cons = hasAgg ? consensus(agg.hits, agg.cross) : null
    const candLines = cands.length ? [
      `GỢI Ý TỪ TRANG TỔNG HỢP – ${UNOFFICIAL}:`,
      ...[...new Map(cands.map((x) => [x.code, x])).values()].slice(0, 8).map((x) => `- ${x.name} – MST ${x.code} (${x.domain})`),
      "Tra tiếp đúng doanh nghiệp bằng company_lookup(tax_code=<MST>) (hỏi người dùng nếu có nhiều doanh nghiệp trùng tên).",
    ] : (!c && nm && candMiss.length ? [`Trang tổng hợp: không có gợi ý (${candMiss.map((m) => `${m.domain}: ${MISS_TEXT[m.reason]}`).join("; ")}).`] : [])
    const text = [
      head,
      c ? mstLine(c) : "",
      ao ? assistLine(ao) : "",
      official_text ? "Nội dung dán vào không có trường thông tin doanh nghiệp nào nhận dạng được (cần chép phần thông tin cơ bản của trang kết quả)." : "",
      gatedText(g),
      `Kiểm tra cổng chính thức lúc ${new Date(g.at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}:`,
      ...gateLines(g),
      ...aggLines(agg.hits, agg.misses, agg.cross),
      ...candLines,
      ...manualSteps(c?.ok ? c.code : code || undefined, nm || undefined),
      hasAgg || cands.length ? RULES_AGG : RULES,
    ].filter(Boolean).join("\n")
    return withUi(text, {
      res: { t: "status", code: hasAgg || cands.length ? "unofficial" : "manual_required" },
      card: {
        kind: "company", mode: "lookup", status: "manual_required", taxCode: c?.ok ? c.code : code || undefined, codeKind: c?.ok ? c.kind : undefined, checksum: c ? checksumCode(c) : undefined, name: data(nm, "vi"), portals: portalsUi(g), date: isoDate(today()),
        ...(hasAgg ? { basis: "aggregator", company: companyUi(cons!, "aggregator"), sources: sourcesUi(agg.hits), crossCheck: crossUi(agg.cross) } : {}),
        ...(cands.length ? { basis: "aggregator", candidates: cands.slice(0, 8).map((x) => ({ name: data(x.name, "vi"), code: x.code, domain: x.domain, url: x.url })) } : {}),
        ...(agg.misses.length || candMiss.length ? { skipped: [...agg.misses, ...candMiss].map((m) => ({ domain: m.domain, reason: m.reason })) } : {}),
        ...assistUi(ao),
      },
    })
  },
})

export const verify = tool({
  description:
    "ĐỐI CHIẾU THÔNG TIN DOANH NGHIỆP của một bên trong hợp đồng (thẩm định đối tác khi soạn / rà soát hợp đồng): kiểm tra MST (chữ số kiểm tra, chi nhánh 13 số) và so từng mục tên – địa chỉ trụ sở – người đại diện – tình trạng (chuẩn hóa dấu, viết tắt TNHH / CP / MTV / Công ty cổ phần, P./Q./TP.) → khớp / gần khớp / không khớp kèm rủi ro. Căn cứ: nội dung người dùng sao chép từ trang chính thức (official_text) nếu có; nếu không, trên giao diện web mời người dùng tự xác minh CAPTCHA trên trang chính thức rồi đối chiếu với kết quả chính thức; không được thì đối chiếu với các trang tổng hợp KHÔNG chính thức (infodoanhnghiep.com, doanhnghiep.biz) – kết quả ghi rõ \"đối chiếu với nguồn không chính thức\" và kèm link + bước tự tra cổng chính thức (CAPTCHA).",
  args: {
    tax_code: tool.schema.string().describe("MST / mã số doanh nghiệp ghi trong hợp đồng (10 hoặc 13 số)"),
    expected_name: tool.schema.string().optional().describe("Tên bên ký kết như ghi trong hợp đồng"),
    expected_address: tool.schema.string().optional().describe("Địa chỉ trụ sở như ghi trong hợp đồng"),
    expected_representative: tool.schema.string().optional().describe("Họ tên người đại diện ký hợp đồng như ghi trong hợp đồng (chỉ họ tên)"),
    official_text: tool.schema.string().optional().describe("Nội dung người dùng SAO CHÉP từ trang kết quả chính thức (dangkykinhdoanh / tracuunnt)"),
    assist: tool.schema.boolean().optional().describe("Mời người dùng tự xác minh CAPTCHA trên trang chính thức ngay trong giao diện web (mặc định: bật khi chạy từ web, tắt ở CLI)"),
    assist_source: tool.schema.enum(["gdt", "dkkd"]).optional().describe("gdt = Cục Thuế tracuunnt (mặc định), dkkd = Cổng đăng ký doanh nghiệp (có người đại diện theo pháp luật)"),
  },
  async execute({ tax_code, expected_name, expected_address, expected_representative, official_text, assist, assist_source }, context) {
    const sid = context?.sessionID
    const c = checkMst(tax_code)
    const head = `ĐỐI CHIẾU THÔNG TIN DOANH NGHIỆP – MST ${c.ok ? c.code : tax_code} (Ngày tra cứu: ${today()})`
    const rows: FieldResult[] = []
    const risks: string[] = []
    rows.push({ field: "tax_code", result: c.ok ? "match" : "mismatch", expected: tax_code, note: c.ok ? "định dạng / chữ số kiểm tra hợp lệ" : c.detail })
    if (!c.ok && c.reason === "personal_id") return withUi([head, mstLine(c), "Không xử lý dữ liệu cá nhân – đối tác là cá nhân / hộ kinh doanh: yêu cầu giấy tờ đăng ký và tự kiểm tra."].join("\n"), { res: { t: "status", code: "personal_id" }, card: { kind: "company", mode: "verify", status: "personal_id", checksum: "personal_id", date: isoDate(today()) } })
    if (!c.ok) risks.push(`RỦI RO: MST ghi trong hợp đồng không hợp lệ (${c.detail}) – yêu cầu đối tác xác nhận lại MST; hóa đơn / chứng từ ghi sai MST có thể không hợp lệ.`)
    if (c.ok && c.kind === "branch") risks.push("Lưu ý: MST 13 số là của đơn vị phụ thuộc (chi nhánh…) – đơn vị phụ thuộc không có tư cách pháp nhân; hợp đồng nên đứng tên doanh nghiệp (chi nhánh ký theo ủy quyền, kèm giấy ủy quyền). Cần nêu điều luật thì tra bằng legal-research.")
    if (expected_name && !legalForm(expected_name)) risks.push("Tên bên ký trong hợp đồng không ghi loại hình (Công ty TNHH / Cổ phần…) – yêu cầu ghi đúng tên đầy đủ theo Giấy chứng nhận ĐKDN.")

    // basis: user-copied official page, else the reference aggregators
    const pasted = official_text ? useOfficialText(sid, c.ok ? c.code : undefined, official_text) : null
    const hasPaste = !!pasted && !!(pasted.name || pasted.address || pasted.representative || pasted.status)
    let g: Gates | undefined
    let agg: { hits: AggHit[]; misses: AggMiss[]; cross: Cross[] } = { hits: [], misses: [], cross: [] }
    // official source with the user's help (assisted browsing) when nothing was pasted
    let ao: AssistOutcome | null = null
    if (!hasPaste && c.ok && sid && (assist ?? assistDefault())) ao = await officialAssist(sid, c.code, assist_source ?? "gdt", "company_verify", (context as any)?.abort)
    const off = ao?.hit ?? null
    if (!hasPaste && !off) {
      g = await checkGates()
      if (g.dkkd === "captcha" || g.gdt === "captcha") recordWarning(sid, "https://dichvuthongtin.dkkd.gov.vn/", `Thông tin doanh nghiệp MST ${c.ok ? c.code : tax_code} CHƯA được đối chiếu với nguồn chính thức (CAPTCHA).`)
      if (c.ok) agg = await aggregatorsFor(c.code, sid)
    }
    const basis: "user_paste" | "official" | "aggregator" | null = hasPaste ? "user_paste" : off ? "official" : agg.hits.length ? "aggregator" : null
    const srcs: { domain: string; rec: CompanyRecord }[] = hasPaste ? [{ domain: "official_paste", rec: pasted! }] : off ? [{ domain: off.host, rec: off.rec }] : agg.hits
    const OFF = basis === "aggregator" ? "nguồn không chính thức" : "chính thức"
    if (basis) {
      const codes = srcs.map((s) => s.rec.code).filter(Boolean) as string[]
      if (c.ok && codes.length) rows[0] = codes.every((x) => x.replace(/-/g, "") === c.code.replace(/-/g, "")) ? { field: "tax_code", result: "match", expected: tax_code, official: codes[0] } : { field: "tax_code", result: "mismatch", expected: tax_code, official: codes.join(" / "), note: `MST trên trang ${OFF} khác MST trong hợp đồng` }
      // one comparison per source, combined: all match → match; all mismatch → mismatch; otherwise partial
      const combine = (field: FieldResult["field"], expected: string | undefined, get: (r: CompanyRecord) => string | undefined, cmp: (e: string, o: string, r: CompanyRecord) => FieldResult): FieldResult => {
        const offs = srcs.map((s) => get(s.rec)).filter(Boolean) as string[]
        const offTxt = [...new Set(offs)].join(" / ") || undefined
        if (!expected) return { field, result: "not_checked", official: offTxt, note: "hợp đồng chưa cung cấp" }
        if (!offs.length) return { field, result: "not_checked", expected, note: "nguồn không có mục này" }
        const rs = srcs.filter((s) => get(s.rec)).map((s) => cmp(expected, get(s.rec)!, s.rec))
        if (rs.length === 1) return { ...rs[0], official: offTxt }
        const all = (x: string) => rs.every((r) => r.result === x)
        return all("match") ? { field, result: "match", expected, official: offTxt } : all("mismatch") ? { field, result: "mismatch", expected, official: offTxt, note: rs.find((r) => r.note)?.note }
          : { field, result: "partial", expected, official: offTxt, note: "các nguồn không chính thức không thống nhất – khớp với một nguồn, lệch với nguồn khác; phải xác nhận trên cổng chính thức" }
      }
      rows.push(combine("name", expected_name, (r) => r.name ?? r.nameEn, (e, _o, r) => compareName(e, [r.name ?? "", r.nameEn ?? "", r.short ?? ""])))
      rows.push(combine("address", expected_address, (r) => r.address, (e, o) => compareAddress(e, o)))
      rows.push(combine("representative", expected_representative, (r) => r.representative, (e, o) => comparePerson(e, o)))
      const sts = srcs.filter((s) => s.rec.status)
      if (sts.length) {
        const codes = [...new Set(sts.map((s) => s.rec.statusCode ?? statusOf(s.rec.status) ?? "other"))]
        const offTxt = [...new Set(sts.map((s) => s.rec.status!))].join(" / ")
        if (codes.length > 1) { rows.push({ field: "status", result: "partial", official: offTxt, note: "các nguồn ghi tình trạng khác nhau – phải xác nhận trên cổng chính thức" }); risks.push(`Tình trạng hoạt động không thống nhất giữa các nguồn (${offTxt}) – xác nhận trên cổng chính thức trước khi ký.`) }
        else { rows.push({ field: "status", result: codes[0] === "active" ? "match" : "mismatch", official: offTxt, note: STATUS_RISK[codes[0]] }); if (codes[0] !== "active") risks.push(STATUS_RISK[codes[0]]) }
      }
      for (const r of rows) if (r.result === "mismatch" && r.field !== "status") risks.push(`KHÔNG KHỚP ${LABEL[r.field]}: hợp đồng "${r.expected}" ≠ ${OFF} "${r.official ?? "?"}"${r.note ? ` – ${r.note}` : ""}.`)
        else if (r.result === "partial" && r.field !== "status") risks.push(`GẦN KHỚP / CHƯA RÕ ${LABEL[r.field]}: ${r.note ?? ""}`)
    } else {
      if (expected_name) rows.push({ field: "name", result: "not_checked", expected: expected_name })
      if (expected_address) rows.push({ field: "address", result: "not_checked", expected: expected_address })
      if (expected_representative) rows.push({ field: "representative", result: "not_checked", expected: expected_representative })
    }
    const colOff = basis === "aggregator" ? `Theo nguồn KHÔNG chính thức (${agg.hits.map((h) => h.domain).join(", ")})` : "Theo nguồn chính thức"
    const table = [`| Mục | Theo hợp đồng | ${colOff} | Kết quả |`, "|---|---|---|---|",
      ...rows.map((r) => `| ${LABEL[r.field]} | ${r.expected ?? "—"} | ${r.official ?? (basis ? "—" : "chưa tra (CAPTCHA)")} | ${RES[r.result]}${r.note && r.result !== "mismatch" ? ` – ${r.note}` : ""} |`)]
    const lines = [head, mstLine(c)]
    if (ao) lines.push(assistLine(ao))
    if (basis === "user_paste" || basis === "official") {
      if (basis === "official") lines.push(...officialLines(off!).slice(0, 1).map((l) => l.replace(/:$/, " – hồ sơ dùng để đối chiếu.")), ...table)
      else lines.push("Hồ sơ chính thức: theo nội dung người dùng sao chép từ trang chính thức (công cụ không tự mở được do CAPTCHA – ghi rõ điều này khi trả lời).", ...table)
      lines.push(risks.length ? "RỦI RO / VIỆC CẦN LÀM (đưa vào báo cáo rà soát, mục thông tin các bên):" : "Không phát hiện điểm lệch giữa hợp đồng và hồ sơ chính thức.", ...risks.map((r) => `- ${r}`))
      lines.push(basis === "official" ? `Nguồn chính thức để dẫn: ${off!.url} (Ngày tra cứu: ${today()})` : `Nguồn chính thức để dẫn: ${URLS.dkkd} ; ${URLS.gdt} (Ngày tra cứu: ${today()})`)
      if (basis === "official") lines.push(RULES_OFFICIAL)
    } else {
      lines.push(official_text ? "Nội dung dán vào không có trường thông tin doanh nghiệp nào nhận dạng được." : "", gatedText(g!), ...gateLines(g!))
      if (basis === "aggregator") lines.push(`ĐỐI CHIẾU VỚI NGUỒN KHÔNG CHÍNH THỨC – ${UNOFFICIAL}.`)
      lines.push(...table)
      if (basis === "aggregator") lines.push(...aggLines(agg.hits, agg.misses, agg.cross).slice(1).filter((l) => !/^\[\d\]|^  - /.test(l)))
      else if (agg.misses.length) lines.push(...aggLines([], agg.misses, []))
      if (risks.length) lines.push(basis ? "RỦI RO / VIỆC CẦN LÀM (theo nguồn không chính thức – xác nhận trên cổng chính thức):" : "Phát hiện ngay (không cần tra):", ...risks.map((r) => `- ${r}`))
      else if (basis) lines.push("Không thấy điểm lệch so với nguồn không chính thức – CHƯA phải xác nhận chính thức.")
      lines.push(...manualSteps(c.ok ? c.code : tax_code), "Danh mục đối chiếu: tên đầy đủ đúng từng chữ (kể cả loại hình), MST, địa chỉ trụ sở chính, họ tên người đại diện theo pháp luật (người ký khác → cần giấy ủy quyền), tình trạng \"Đang hoạt động\" (tạm ngừng / không hoạt động tại địa chỉ đăng ký / đang giải thể / đã giải thể → rủi ro cao).", basis ? RULES_AGG : RULES)
    }
    const worst = rows.some((r) => r.result === "mismatch") ? "mismatch" : rows.some((r) => r.result === "partial") ? "partial" : basis ? "match" : "manual_required"
    return withUi(lines.filter(Boolean).join("\n"), {
      res: { t: "status", code: basis === "user_paste" || basis === "official" ? `verify_${worst}` : basis === "aggregator" ? `unofficial_${worst}` : "manual_required" },
      card: {
        kind: "company", mode: "verify", status: basis === "user_paste" || basis === "official" ? "parsed" : "manual_required", result: worst, taxCode: c.ok ? c.code : tax_code, codeKind: c.ok ? c.kind : undefined, checksum: checksumCode(c),
        fields: rows.map((r) => ({ field: r.field, result: r.result, expected: data(r.expected), official: data(r.official) })),
        risks: risks.length, portals: portalsUi(g), date: isoDate(today()),
        ...(basis ? { basis } : {}),
        ...(basis === "user_paste" ? { company: companyUi(pasted!) } : {}),
        ...(basis === "official" ? { company: companyUi(off!.rec, "official"), sources: officialSourceUi(off!) } : {}),
        ...assistUi(ao),
        ...(basis === "aggregator" ? { company: companyUi(consensus(agg.hits, agg.cross), "aggregator"), sources: sourcesUi(agg.hits), crossCheck: crossUi(agg.cross) } : {}),
        ...(agg.misses.length ? { skipped: agg.misses.map((m) => ({ domain: m.domain, reason: m.reason })) } : {}),
      },
    })
  },
})
const LABEL: Record<FieldResult["field"], string> = { tax_code: "MST", name: "Tên doanh nghiệp", address: "Địa chỉ trụ sở", representative: "Người đại diện theo pháp luật", status: "Tình trạng hoạt động" }
const RES: Record<FieldResult["result"], string> = { match: "KHỚP", partial: "GẦN KHỚP / CHƯA RÕ", mismatch: "KHÔNG KHỚP", not_checked: "chưa đối chiếu" }
