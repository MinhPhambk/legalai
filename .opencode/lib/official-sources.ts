// Official / authoritative domains for web_search / web_read (one config). A host is "official" when it
// equals or is a subdomain of one of these (e.g. congbao.chinhphu.vn, trade.ec.europa.eu, *.gov.vn).
// SEARCH_GROUPS are the compact site: filters actually sent to the search engine (queries have a length
// limit); results from other domains are still flagged against the full OFFICIAL list.
// Imported by tool files only – this file exports no tools.
export const OFFICIAL: { domain: string; label: string }[] = [
  // Viet Nam – State bodies, official gazette, legal database, courts, trade remedies, WTO centre, VCCI
  { domain: "gov.vn", label: "cơ quan nhà nước Việt Nam (*.gov.vn)" },
  { domain: "chinhphu.vn", label: "Cổng TTĐT Chính phủ / Công báo" },
  { domain: "vbpl.vn", label: "CSDL quốc gia về văn bản pháp luật" },
  { domain: "quochoi.vn", label: "Quốc hội" },
  { domain: "toaan.gov.vn", label: "Tòa án nhân dân tối cao" },
  { domain: "moit.gov.vn", label: "Bộ Công Thương" },
  { domain: "customs.gov.vn", label: "Tổng cục / Cục Hải quan" },
  { domain: "sbv.gov.vn", label: "Ngân hàng Nhà nước" },
  { domain: "mof.gov.vn", label: "Bộ Tài chính" },
  { domain: "gdt.gov.vn", label: "Cục Thuế" },
  { domain: "dkkd.gov.vn", label: "Cổng thông tin quốc gia về đăng ký doanh nghiệp" },
  { domain: "dangkykinhdoanh.gov.vn", label: "Cổng thông tin quốc gia về đăng ký doanh nghiệp" },
  { domain: "trav.gov.vn", label: "Cục Phòng vệ thương mại" },
  { domain: "trungtamwto.vn", label: "Trung tâm WTO và Hội nhập (VCCI)" },
  { domain: "vcci.com.vn", label: "VCCI" },
  { domain: "moj.gov.vn", label: "Bộ Tư pháp" },
  { domain: "dangcongsan.vn", label: "Báo điện tử Đảng Cộng sản Việt Nam" },
  // International / partner-market authorities
  { domain: "wto.org", label: "WTO" },
  { domain: "epingalert.org", label: "ePing (WTO/ITC/UN DESA)" },
  { domain: "federalregister.gov", label: "US Federal Register" },
  { domain: "govinfo.gov", label: "US GPO govinfo" },
  { domain: "trade.gov", label: "US International Trade Administration" },
  { domain: "usitc.gov", label: "US International Trade Commission" },
  { domain: "cbp.gov", label: "US Customs and Border Protection" },
  { domain: "ustr.gov", label: "USTR" },
  { domain: "eur-lex.europa.eu", label: "EUR-Lex" },
  { domain: "europa.eu", label: "EU institutions (ec.europa.eu, trade, taxation-customs…)" },
  { domain: "gov.uk", label: "UK Government / legislation.gov.uk" },
  { domain: "worldbank.org", label: "World Bank" },
  { domain: "wits.worldbank.org", label: "World Bank WITS" },
  { domain: "trademap.org", label: "ITC Trade Map" },
  { domain: "macmap.org", label: "ITC Market Access Map" },
  { domain: "intracen.org", label: "International Trade Centre" },
  { domain: "wcoomd.org", label: "World Customs Organization" },
  { domain: "un.org", label: "United Nations / UNCITRAL" },
  { domain: "unctad.org", label: "UNCTAD" },
  { domain: "oecd.org", label: "OECD" },
  { domain: "asean.org", label: "ASEAN Secretariat" },
  { domain: "apec.org", label: "APEC" },
  { domain: "cbsa-asfc.gc.ca", label: "Canada Border Services Agency" },
  { domain: "canada.ca", label: "Government of Canada" },
  { domain: "abf.gov.au", label: "Australian Border Force" },
  { domain: "industry.gov.au", label: "Anti-Dumping Commission (Australia)" },
  { domain: "customs.go.jp", label: "Japan Customs" },
  { domain: "meti.go.jp", label: "METI Japan" },
  { domain: "customs.go.kr", label: "Korea Customs Service" },
  { domain: "mofcom.gov.cn", label: "MOFCOM (China)" },
  { domain: "customs.gov.cn", label: "GACC (China)" },
  { domain: "dgtr.gov.in", label: "DGTR India" },
  { domain: "cbic.gov.in", label: "CBIC India" },
]
/** Compact site: groups sent to the search engine (vi: Vietnamese authorities; en: international). */
export const SEARCH_GROUPS: Record<"vi" | "en", string[]> = {
  vi: ["gov.vn", "chinhphu.vn", "vbpl.vn", "quochoi.vn", "trungtamwto.vn", "vcci.com.vn"],
  en: ["wto.org", "federalregister.gov", "europa.eu", "trade.gov", "worldbank.org", "intracen.org", "gov.uk"],
}
export function officialOf(host: string): { domain: string; label: string } | null {
  const h = host.toLowerCase().replace(/^www\./, "")
  let best: { domain: string; label: string } | null = null
  for (const o of OFFICIAL) if ((h === o.domain || h.endsWith("." + o.domain)) && (!best || o.domain.length > best.domain.length)) best = o
  return best
}

// ---------------------------------------------------------------- dedicated tools per domain
// web_read never fetches these itself: it delegates to the dedicated implementation (same special parsing
// and evidence recording) or, when the arguments cannot be derived from the URL, tells which tool to call.
// web_search adds the same hint to matching results.
export type Route = { tool: string; module: string; exportName: string; args: (u: URL, focus?: string) => Record<string, unknown> | null; hint: (u: URL) => string }
const frNo = (u: URL) => (u.pathname.match(/(?:^|\/)(\d{4}-\d{5})(?:\/|\.|$)/) ?? u.pathname.match(/FR-\d{4}-\d{2}-\d{2}\/(?:html|pdf)\/(\d{4}-\d{5})/))?.[1] ?? null
export const ROUTES: { test: (u: URL) => boolean; route: Route }[] = [
  { test: (u) => /(^|\.)vbpl\.vn$/.test(u.hostname) && u.pathname.startsWith("/van-ban/chi-tiet/"),
    route: { tool: "vbpl_document / vbpl_article", module: "vbpl", exportName: "document", args: (u) => ({ url: u.href }), hint: (u) => `vbpl_document(url="${u.href}") rồi vbpl_article(url, "<số điều>")` } },
  { test: (u) => u.hostname === "anle.toaan.gov.vn",
    route: { tool: "court_anle_document", module: "court", exportName: "anle_document", args: (u) => ({ ref: u.href }), hint: (u) => `court_anle_document(ref="${u.href}")` } },
  { test: (u) => u.hostname === "congbobanan.toaan.gov.vn" && /^\/[235]ta\d+t1cvn/.test(u.pathname),
    route: { tool: "court_judgment_document", module: "court", exportName: "judgment_document", args: (u, focus) => ({ url: u.href, ...(focus ? { focus } : {}) }), hint: (u) => `court_judgment_document(url="${u.href}")` } },
  { test: (u) => /(^|\.)trav\.gov\.vn$/.test(u.hostname) && u.hostname !== "canhbaosom.trav.gov.vn" && !!u.searchParams.get("id"),
    route: { tool: "trav_page", module: "trav", exportName: "page", args: (u) => ({ url: u.href }), hint: (u) => `trav_page(url="${u.href}")` } },
  { test: (u) => u.hostname === "canhbaosom.trav.gov.vn",
    route: { tool: "trav_measures", module: "trav", exportName: "measures", args: () => null, hint: () => `trav_measures(product / hs / market / company) – CSDL cảnh báo sớm, lọc theo sản phẩm` } },
  { test: (u) => /(^|\.)(federalregister\.gov|govinfo\.gov)$/.test(u.hostname) && !!frNo(u),
    route: { tool: "fedreg_document", module: "fedreg", exportName: "document", args: (u, focus) => ({ id: frNo(u)!, ...(focus ? { focus } : {}) }), hint: (u) => `fedreg_document(id="${frNo(u)}")` } },
  { test: (u) => /(^|\.)(eur-lex\.europa\.eu|publications\.europa\.eu)$/.test(u.hostname),
    route: { tool: "eurlex_document", module: "eurlex", exportName: "document", args: (u, focus) => ({ id: u.href, ...(focus ? { focus } : {}) }), hint: (u) => `eurlex_document(id="${u.href}")` } },
  { test: (u) => /(^|\.)epingalert\.org$/.test(u.hostname),
    route: { tool: "eping_notification", module: "eping", exportName: "notification", args: (u) => (/viewData|\/notifications?\//i.test(u.href) ? { symbol: u.href } : null), hint: () => `eping_search / eping_notification(symbol="G/TBT/N/…")` } },
  { test: (u) => /(^|\.)trungtamwto\.vn$/.test(u.hostname),
    route: { tool: "fta_document", module: "fta", exportName: "document", args: (u, focus) => ({ url: u.href, ...(focus ? { focus } : {}) }), hint: (u) => `fta_document(url="${u.href}")` } },
  { test: (u) => (/(^|\.)sbv\.gov\.vn$/.test(u.hostname) && /t%E1%BB%B7-gi|ty-gia|tygia/i.test(u.pathname)) || (/(^|\.)vietcombank\.com\.vn$/.test(u.hostname) && /ty-gia|tygia|exchangerate/i.test(u.pathname)),
    route: { tool: "fx_rate", module: "fx", exportName: "rate", args: (_u, focus) => ({ currency: /^[A-Za-z]{3}$/.test(focus ?? "") ? focus!.toUpperCase() : "USD" }), hint: () => `fx_rate(currency="USD", date?)` } },
  // tariff schedules: customs.gov.vn "Tra cứu Biểu thuế", USITC HTS, EU TARIC / Access2Markets → tariff_* tools
  { test: (u) => /(^|\.)customs\.gov\.vn$/.test(u.hostname) && (u.searchParams.get("pageId") === "24" || /bieuthue/i.test(u.href)),
    route: { tool: "tariff_vn", module: "tariff", exportName: "vn", args: (u) => (hsParam(u, ["Id", "id", "ma_hs"]) ? { hs: hsParam(u, ["Id", "id", "ma_hs"])! } : null), hint: () => `tariff_vn(hs="<mã HS>", year?, fta?) – biểu thuế XNK Việt Nam; tìm mã theo mô tả: tariff_search(query, market="vn")` } },
  { test: (u) => /(^|\.)hts\.usitc\.gov$/.test(u.hostname),
    route: { tool: "tariff_us", module: "tariff", exportName: "us", args: (u) => (hsParam(u, ["query", "keyword", "q"]) ? { hs: hsParam(u, ["query", "keyword", "q"])! } : null), hint: () => `tariff_us(hs="<mã HTS>") – biểu thuế Hoa Kỳ; tìm mã theo mô tả: tariff_search(query, market="us")` } },
  { test: (u) => (/(^|\.)ec\.europa\.eu$/.test(u.hostname) && /\/taxation_customs\/dds2\/taric\//.test(u.pathname)) || (/(^|\.)trade\.ec\.europa\.eu$/.test(u.hostname) && /\/access-to-markets\//.test(u.pathname)),
    route: { tool: "tariff_eu", module: "tariff", exportName: "eu", args: (u) => { const hs = hsParam(u, ["Taric", "taric", "product", "code"]); if (!hs) return null; const o = (u.searchParams.get("Area") ?? u.searchParams.get("origin") ?? "VN").slice(0, 2).toUpperCase(); return { hs, origin: /^[A-Z]{2}$/.test(o) ? o : "VN" } }, hint: () => `tariff_eu(hs="<mã CN/TARIC>", origin="VN") – biểu thuế EU (TARIC); tìm mã theo mô tả: tariff_search(query, market="eu")` } },
  // enterprise / taxpayer lookups (National Business Registration Portal, Cục Thuế – CAPTCHA-gated) → company_lookup
  { test: (u) => /(^|\.)dkkd\.gov\.vn$/.test(u.hostname) || u.hostname === "tracuunnt.gdt.gov.vn" || (/(^|\.)dangkykinhdoanh\.gov\.vn$/.test(u.hostname) && !!mstIn(u)),
    route: { tool: "company_lookup", module: "company", exportName: "lookup", args: (u) => (mstIn(u) ? { tax_code: mstIn(u)! } : null), hint: () => `company_lookup(tax_code="<MST 10 hoặc 13 số>" | name="<tên>") – tra cứu doanh nghiệp trên nguồn chính thức (có CAPTCHA → công cụ trả link + bước tự tra)` } },
  // MST aggregator page of one company (unofficial reference, flagged): → company_lookup, which cross-checks ≥ 2
  // aggregators and adds the official links; other aggregator pages are read normally by web_read (flagged)
  { test: (u) => MST_AGGREGATORS.test(u.hostname) && !!mstIn(u),
    route: { tool: "company_lookup", module: "company", exportName: "lookup", args: (u) => (mstIn(u) ? { tax_code: mstIn(u)! } : null), hint: (u) => `${u.hostname} là trang tổng hợp KHÔNG chính thức – dùng company_lookup(tax_code="${mstIn(u)}") (đối chiếu chéo nhiều nguồn + link cổng chính thức)` } },
]
const MST_AGGREGATORS = /(^|\.)(masothue\.(com|vn)|thongtindoanhnghiep\.co|hosocongty\.vn|tratencongty\.com|infodoanhnghiep\.com|doanhnghiep\.biz|masocongty\.vn|timcongty\.vn|congtydoanhnghiep\.com|mst\.vn)$/
/** An MST (10 digits, or 13 with "-xxx") in the lookup parameters or the path of a company page. */
function mstIn(u: URL): string | null {
  for (const n of ["search", "mst", "tax_code", "taxcode", "masothue", "ENT_CODE", "q"]) { const v = (u.searchParams.get(n) ?? "").replace(/[\s.]/g, ""); if (/^\d{10}(-?\d{3})?$/.test(v)) return v }
  return decodeURIComponent(u.pathname).match(/(?:^|\/)(\d{10}(?:-\d{3})?)(?=[-/._]|$)/)?.[1] ?? null
}
/** An HS code (4–10 digits) in one of the query parameters of a tariff page. */
function hsParam(u: URL, names: string[]): string | null {
  for (const n of names) { const v = (u.searchParams.get(n) ?? "").replace(/[\s.]/g, ""); if (/^\d{4,10}$/.test(v)) return v }
  return null
}
export function routeOf(raw: string): Route | null {
  try { const u = new URL(raw); return ROUTES.find((r) => r.test(u))?.route ?? null } catch { return null }
}

// ---------------------------------------------------------------- one key per document (grounding de-dup)
/**
 * Canonical key of a document URL, so alternate URLs of the same document count as one source:
 * vbpl slug vs id, Federal Register html vs govinfo copy, EUR-Lex CELEX URLs, congbobanan 2ta/3ta/5ta forms.
 * Unknown URLs: host + path without "www.", trailing "/", fragment.
 */
export function canonicalKey(raw: string): string {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return raw.trim().toLowerCase() }
  const h = u.hostname.replace(/^www\./, "")
  if (h === "vbpl.vn") {
    const id = u.pathname.match(/--(\d+)\/?$/)?.[1] ?? u.searchParams.get("ItemID") ?? u.searchParams.get("itemid")
    if (id) return `vbpl:${id}`
  }
  if (h === "federalregister.gov" || h === "govinfo.gov") { const n = frNo(u); if (n) return `fr:${n}` }
  if (h === "eur-lex.europa.eu") {
    const celex = (decodeURIComponent(u.search).match(/CELEX:(\d[\dA-Z()]+)/i) ?? decodeURIComponent(u.pathname).match(/CELEX:(\d[\dA-Z()]+)/i))?.[1]
    if (celex) return `celex:${celex.toUpperCase()}`
  }
  if (h === "congbobanan.toaan.gov.vn") { const id = u.pathname.match(/^\/[235]ta(\d+)t1cvn/)?.[1]; if (id) return `cbba:${id}` }
  if (h === "anle.toaan.gov.vn") { const d = u.searchParams.get("dDocName"); if (d) return `anle:${d.toUpperCase()}` }
  return `${h}${u.pathname.replace(/\/$/, "")}${u.search}`.toLowerCase()
}
/** Vietnamese document numbers in a text ("70/2025/NĐ-CP", "36/2005/QH11") – to point at vbpl_find. */
export const docNumbersIn = (s: string) => [...new Set([...s.matchAll(/\b\d{1,4}\/\d{4}\/[A-ZĐ]{1,6}(?:-[A-ZĐ]{1,8})*\d{0,3}\b/g)].map((m) => m[0]))]
