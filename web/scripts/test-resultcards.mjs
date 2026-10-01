// Unit tests for server/resultcards.mjs (language-neutral result cards, v2) and server/stepview.mjs (structured step
// summaries): tool metadata.ui first, legacy text outputs parsed. node scripts/test-resultcards.mjs
import assert from "node:assert/strict"
import { resultCard } from "../server/resultcards.mjs"
import { langOf, stepView, whyOf } from "../server/stepview.mjs"
import { parseChangeLine, summarizeChanges } from "../server/events.mjs"

let n = 0
const t = (name, fn) => (fn(), n++, console.log("  ✓", name))
const EVAL = "KẾT QUẢ: 165.000.000 (en: 165,000,000)\nBiểu thức: 1.250.000 × 120 × (1 + 10%)\nCác bước:\n1. 1.250.000 × 120 = 150.000.000\n2. 150.000.000 × 1,1 = 165.000.000\nKhi trả lời: nêu công thức…"
t("calc_eval (legacy text): raw value, expression data, steps", () => {
  const c = resultCard("calc_eval", EVAL, {})
  assert.equal(c.v, 2)
  assert.equal(c.kind, "calc")
  assert.equal(c.value.n, "165000000")
  assert.equal(c.expression.v, "1.250.000 × 120 × (1 + 10%)")
  assert.deepEqual(c.steps.map((s) => s.v), ["1.250.000 × 120 = 150.000.000", "150.000.000 × 1,1 = 165.000.000"])
})
t("calc_interest penalty: > 8% warning → code", () => {
  const c = resultCard("calc_interest", "TIỀN PHẠT: 60.000.000 VND (en: 60,000,000 VND)\nCông thức: tiền phạt = tỷ lệ phạt × giá trị = 12% × 500.000.000 VND = 60.000.000 VND\n⚠ Mức phạt 12% vượt 8%: Luật Thương mại 2005 Điều 301 …", {})
  assert.equal(c.label, "penalty")
  assert.deepEqual(c.value, { n: "60000000", cur: "VND" })
  assert.deepEqual(c.warnings, [{ code: "penalty_cap", rate: "12", cap: "8" }])
})
t("calc_check_words: status", () => {
  assert.equal(resultCard("calc_check_words", "KHÔNG KHỚP: bằng số 1.000 VND nhưng phần bằng chữ đọc ra 2.000 VND (chênh 1.000)\nCách viết chuẩn: Một nghìn đồng", {}).status, "mismatch")
  assert.equal(resultCard("calc_check_words", 'KHỚP: 1.000 VND = "Một nghìn đồng"', {}).status, "ok")
})
t("fx_rate (legacy): ISO date, numeric rates, http-only source links", () => {
  const out = [
    "TỶ GIÁ USD/VND (tham khảo, ngày 27/09/2026): NHNN 25.641",
    "Ngân hàng Nhà nước – tỷ giá trung tâm: 1 USD = 25.641 VND, áp dụng cho ngày 26/09/2026, theo 399/TB-NHNN. Nguồn: https://sbv.gov.vn/x",
    "Vietcombank – USD (US DOLLAR) ngày 27/09/2026, cập nhật 23:00: mua tiền mặt 25,760.00 – mua chuyển khoản 25,790.00 – bán 26,170.00 VND. Nguồn: javascript:alert(1)",
  ].join("\n")
  const c = resultCard("fx_rate", out, {})
  assert.equal(c.date, "2026-09-27")
  assert.deepEqual([c.rates[0].src, c.rates[0].rate, c.rates[0].date, c.rates[0].url], ["sbv_central", "25641", "2026-09-26", "https://sbv.gov.vn/x"])
  assert.equal(c.rates[1].sell, "26170.00")
  assert.equal(c.rates[1].url, undefined)
})
t("web_read: official / unofficial, ISO date", () => {
  const off = resultCard("web_read", "Trang: Luật Thương mại\nLink: https://vbpl.vn/a\nTên miền: vbpl.vn – NGUỒN CHÍNH THỨC (Cơ sở dữ liệu quốc gia về VBPL)\nNgày đăng / ban hành (theo trang): 14/06/2005", {})
  assert.equal(off.official, true)
  assert.deepEqual(off.officialLabel, { v: "Cơ sở dữ liệu quốc gia về VBPL", lang: "vi" })
  assert.equal(off.date, "2005-06-14")
  const un = resultCard("web_read", "Trang: Blog\nLink: https://example.com/b\nTên miền: example.com – ⚠ NGUỒN KHÔNG CHÍNH THỨC – chỉ tham khảo", {})
  assert.equal(un.official, false)
})
t("tariff_us (legacy): Free → free, descriptions as English data", () => {
  const out = "BIỂU THUẾ HOA KỲ – mã 7210.49\nBản HTS: 2026 HTS Revision 19 (áp dụng từ 09/15/2026)\n7210.49.00 | Other | Free [= 0%] | – | 21.5% | –"
  const c = resultCard("tariff_us", out, { hs: "7210.49" })
  assert.equal(c.rates[0].col, "general")
  assert.equal(c.rates[0].free, true)
  assert.equal(c.rates[1].pct, "21.5")
  assert.deepEqual(c.lines[0].desc, { v: "Other", lang: "en" })
})
t("metadata.ui.card wins over the text; free text outside {v, lang} dropped", () => {
  const c = resultCard("fx_convert", "QUY ĐỔI: whatever", {}, "vi", { ui: { card: { kind: "fx", mode: "convert", convert: { amount: "65000", fromCur: "USD", toCur: "VND", result: "1666665000", src: "sbv_central", date: "2026-09-26" }, note: "một câu tiếng Việt dài không phải mã, bị loại bỏ vì quá dài so với giới hạn mã" } } })
  assert.equal(c.convert.result, "1666665000")
  assert.equal(c.note, undefined)
})
t("errors / other tools / junk → null", () => {
  assert.equal(resultCard("calc_eval", "Lỗi: biểu thức không hợp lệ", {}), null)
  assert.equal(resultCard("vbpl_find", EVAL, {}), null)
  assert.equal(resultCard("calc_eval", "no result here", {}), null)
  assert.equal(resultCard("web_read", "Trang: x\nLink: ftp://x\nTên miền: x", {}), null)
})
t("vendor names scrubbed", () => {
  const c = resultCard("calc_eval", "KẾT QUẢ: 1 (en: 1)\nBiểu thức: opencode qwen3.6", {})
  assert.ok(!/opencode|qwen/i.test(JSON.stringify(c)))
})
// ---- company checks (company_lookup / company_verify) -------------------------------------------------------
const PORTALS = [
  { src: "dkkd", gate: "captcha", url: "https://dichvuthongtin.dkkd.gov.vn/inf/default.aspx" },
  { src: "dkkd_egazette", gate: "captcha", url: "https://bocaodientu.dkkd.gov.vn/egazette/Forms/Egazette/DefaultAnnouncements.aspx" },
  { src: "gdt", gate: "captcha", url: "https://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp" },
  { src: "gdt", url: "https://evil.example.com/phish" },
  { src: "masothue", url: "https://masothue.com/x" },
]
const LOOKUP_UI = { ui: { v: 1, res: { t: "status", code: "manual_required" }, card: { kind: "company", mode: "lookup", status: "manual_required", taxCode: "0100123453", codeKind: "enterprise", checksum: "valid", portals: PORTALS, date: "2026-09-27" } } }
const VERIFY_UI = { ui: { v: 1, res: { t: "status", code: "verify_mismatch" }, card: {
  kind: "company", mode: "verify", status: "parsed", result: "mismatch", taxCode: "0100123453", codeKind: "enterprise", checksum: "valid",
  fields: [
    { field: "tax_code", result: "match", expected: { v: "0100123453" }, official: { v: "0100123453" } },
    { field: "name", result: "match", expected: { v: "Công ty TNHH TM DV An Phát" }, official: { v: "CÔNG TY TNHH THƯƠNG MẠI DỊCH VỤ AN PHÁT" } },
    { field: "address", result: "partial", expected: { v: "Số 12 Trần Hưng Đạo, Phường Hàng Bài, Hà Nội" }, official: { v: "Số 12 phố Trần Hưng Đạo, Phường Cửa Nam, Thành phố Hà Nội" } },
    { field: "representative", result: "mismatch", expected: { v: "Trần Thị Bình" }, official: { v: "NGUYỄN VĂN AN" } },
    { field: "status", result: "mismatch", official: { v: "Tạm ngừng kinh doanh có thời hạn", lang: "vi" } },
    { field: "email", result: "match", expected: { v: "a@b.c" } },
  ],
  risks: 3,
  company: { origin: "user_paste", name: { v: "CÔNG TY TNHH THƯƠNG MẠI DỊCH VỤ AN PHÁT", lang: "vi" }, code: "0100123453", status: "temporarily_suspended", statusText: { v: "Tạm ngừng kinh doanh có thời hạn", lang: "vi" }, regDate: "2018-03-15", representative: { v: "NGUYỄN VĂN AN" }, phone: "0912345678" },
  portals: PORTALS.slice(0, 3), date: "2026-09-27",
} } }
t("company_lookup manual_required: official portals only, gates, ISO date, status step", () => {
  const c = resultCard("company_lookup", "TRA CỨU DOANH NGHIỆP – MST 0100123453\nNguồn chính thức yêu cầu mã xác thực – không tra tự động.", { tax_code: "0100123453" }, "vi", LOOKUP_UI)
  assert.equal(c.v, 2)
  assert.deepEqual([c.kind, c.mode, c.status, c.taxCode, c.codeKind, c.checksum, c.date], ["company", "lookup", "manual_required", "0100123453", "enterprise", "valid", "2026-09-27"])
  assert.deepEqual(c.portals.map((p) => [p.src, p.gate]), [["dkkd", "captcha"], ["dkkd_egazette", "captcha"], ["gdt", "captcha"]])
  assert.ok(!JSON.stringify(c).includes("evil.example") && !JSON.stringify(c).includes("masothue"))
  const st = stepView("company_lookup", { tax_code: "0100123453", official_text: "Tên doanh nghiệp: X\nSố CCCD: 001088012345" }, "…", LOOKUP_UI, null, "vi")
  assert.deepEqual(st, { args: [{ t: "code", v: "0100123453" }], res: { t: "status", code: "manual_required" } })
})
t("company_verify mixed results: fields, company facts as data, no personal fields, step status", () => {
  const c = resultCard("company_verify", "ĐỐI CHIẾU THÔNG TIN DOANH NGHIỆP – MST 0100123453", { tax_code: "0100123453" }, "vi", VERIFY_UI)
  assert.equal(c.result, "mismatch")
  assert.deepEqual(c.fields.map((f) => [f.field, f.result]), [["tax_code", "match"], ["name", "match"], ["address", "partial"], ["representative", "mismatch"], ["status", "mismatch"]])
  assert.deepEqual(c.fields[3].official, { v: "NGUYỄN VĂN AN", lang: "vi" })
  assert.equal(c.company.origin, "user_paste")
  assert.equal(c.company.status, "temporarily_suspended")
  assert.equal(c.company.regDate, "2018-03-15")
  assert.equal(c.company.phone, undefined)
  assert.equal(c.risks, 3)
  const st = stepView("company_verify", { tax_code: "0100123453", expected_representative: "Trần Thị Bình", official_text: "…" }, "…", VERIFY_UI, null, "en")
  assert.deepEqual(st, { args: [{ t: "code", v: "0100123453" }], res: { t: "status", code: "verify_mismatch" } })
})
t("company: aggregator origin, reference sources, cross-check; personal ID never echoed; legacy text", () => {
  const agg = resultCard("company_lookup", "x", {}, "vi", { ui: { card: { kind: "company", mode: "lookup", status: "parsed", taxCode: "0100123453", checksum: "valid",
    company: { origin: "aggregator", name: { v: "CÔNG TY A" }, status: "active" },
    sources: [{ domain: "masothue.com", url: "https://masothue.com/0100123453", official: true, fetchedAt: "2026-09-27T08:00:00+07:00" }, { domain: "x", url: "javascript:alert(1)" }],
    crossCheck: [{ field: "address", agree: false, values: ["Số 12 Trần Hưng Đạo", { v: "Số 21 Trần Hưng Đạo", lang: "vi" }] }, { field: "name", agree: true, values: [] }, { field: "phone", agree: true }] } } })
  assert.equal(agg.company.origin, "aggregator")
  assert.deepEqual(agg.sources, [{ domain: "masothue.com", url: "https://masothue.com/0100123453", official: false, fetchedAt: "2026-09-27T08:00:00+07:00" }])
  assert.deepEqual(agg.crossCheck.map((x) => [x.field, x.agree, x.values.length]), [["address", false, 2], ["name", true, 0]])
  const pid = resultCard("company_lookup", "x", { tax_code: "001088012345" }, "vi", { ui: { card: { kind: "company", mode: "lookup", status: "personal_id", checksum: "personal_id", taxCode: "001088012345" } } })
  assert.equal(pid.taxCode, undefined)
  const legacy = resultCard("company_lookup", "TRA CỨU DOANH NGHIỆP – MST 0100123453\nKiểm tra định dạng MST: HỢP LỆ – 10 chữ số\nNguồn chính thức yêu cầu mã xác thực – không tra tự động.", { tax_code: "0100123453" })
  assert.deepEqual([legacy.status, legacy.checksum, legacy.portals.length], ["manual_required", "valid", 3])
  assert.deepEqual(stepView("company_lookup", { name: "An Phát" }, "Nguồn chính thức yêu cầu mã xác thực – không tra tự động.", {}, null).res, { t: "status", code: "manual_required" })
  assert.deepEqual(stepView("company_lookup", { name: "An Phát" }, "", {}, null).args, [{ t: "q", v: "An Phát", lang: "vi" }])
})
t("company: aggregator basis (real shape) – conflicts, {domain, v} cross-check, site update date, candidates, skipped", () => {
  const agg = resultCard("company_lookup", "x", {}, "vi", { ui: { res: { t: "status", code: "unofficial" }, card: { kind: "company", mode: "lookup", status: "manual_required", basis: "aggregator", taxCode: "0100109106", checksum: "valid",
    company: { origin: "aggregator", name: { v: "TẬP ĐOÀN A", lang: "vi" }, status: "active", conflicts: ["address", "representative", "phone"] },
    sources: [{ domain: "infodoanhnghiep.com", url: "https://infodoanhnghiep.com/x.html", official: true, fetchedAt: "2026-09-27T05:06:34.071Z", updated: "2023-03-13" }, { domain: "x", url: "javascript:alert(1)" }],
    crossCheck: [
      { field: "address", agree: false, values: [{ domain: "infodoanhnghiep.com", v: "Lô D26 Cầu Giấy" }, { domain: "doanhnghiep.biz", v: "Số 5 Nguyễn Hữu An" }] },
      { field: "regDate", agree: true, values: [{ domain: "infodoanhnghiep.com", v: "21/05/1998" }] },
      { field: "phone", agree: true, values: [] },
    ],
    candidates: [{ name: { v: "CÔNG TY B", lang: "vi" }, code: "0300588569-026", domain: "infodoanhnghiep.com", url: "https://infodoanhnghiep.com/b.html" }, { name: { v: "Cá nhân" }, code: "001088012345" }],
    skipped: [{ domain: "doanhnghiep.biz", reason: "challenge" }, { domain: "a.vn", reason: "weird" }] } } })
  assert.equal(agg.basis, "aggregator")
  assert.equal(agg.status, "manual_required")
  assert.deepEqual(agg.company.conflicts, ["address", "representative"])
  assert.deepEqual(agg.sources, [{ domain: "infodoanhnghiep.com", url: "https://infodoanhnghiep.com/x.html", official: false, fetchedAt: "2026-09-27T05:06:34.071Z", updated: "2023-03-13" }])
  assert.deepEqual(agg.crossCheck.map((x) => [x.field, x.agree, x.values.map((v) => v.domain)]), [["address", false, ["infodoanhnghiep.com", "doanhnghiep.biz"]], ["regDate", true, ["infodoanhnghiep.com"]]])
  assert.deepEqual(agg.crossCheck[0].values[0], { domain: "infodoanhnghiep.com", v: "Lô D26 Cầu Giấy", lang: "vi" })
  assert.deepEqual(agg.candidates, [{ code: "0300588569-026", name: { v: "CÔNG TY B", lang: "vi" }, url: "https://infodoanhnghiep.com/b.html", domain: "infodoanhnghiep.com" }])
  assert.deepEqual(agg.skipped, [{ domain: "doanhnghiep.biz", reason: "challenge" }, { domain: "a.vn", reason: "error" }])
  assert.deepEqual(stepView("company_verify", { tax_code: "0100109106" }, "…", { ui: { res: { t: "status", code: "unofficial_partial" } } }, null).res, { t: "status", code: "unofficial_partial" })
})
// ---- structured steps ----------------------------------------------------------------------------------------
t("stepView: vbpl_article → article number + document (data) + title (data)", () => {
  const st = { docName: () => "Luật 36/2005/QH11 của Quốc hội" }
  const out = "Văn bản: Luật 36/2005/QH11 của Quốc hội\nLink: https://vbpl.vn/x\n--- NGUYÊN VĂN ---\nĐiều 300. Phạt vi phạm\n\nPhạt vi phạm là…"
  const s = stepView("vbpl_article", { url: "https://vbpl.vn/x", article: "Điều 300" }, out, {}, st, "vi")
  assert.deepEqual(s.args, [{ t: "art", n: "300" }, { t: "doc", v: "Luật 36/2005/QH11 của Quốc hội", lang: "vi" }])
  assert.deepEqual(s.res, { t: "title", v: "Phạt vi phạm", lang: "vi" })
})
t("stepView: counts / none / statuses from text; metadata.ui.res wins", () => {
  assert.deepEqual(stepView("vbpl_find", { query: "x" }, "1. a\n   https://vbpl.vn/a\n2. b\n   https://vbpl.vn/b", {}, null).res, { t: "count", n: 2, unit: "docs" })
  assert.deepEqual(stepView("trav_measures", {}, "Không có biện pháp nào khớp (…)", {}, null).res, { t: "none" })
  assert.deepEqual(stepView("vbpl_document", {}, "Tình trạng hiệu lực: Hết hiệu lực một phần\n", {}, null).res, { t: "status", code: "partly_expired" })
  assert.deepEqual(stepView("court_anle_search", {}, "whatever", { ui: { res: { t: "count", n: 3, unit: "precedents" } } }, null).res, { t: "count", n: 3, unit: "precedents" })
  assert.deepEqual(stepView("vbpl_find", {}, "Lỗi: xyz", {}, null).res, { t: "error" })
})
t("langOf: diacritics, unaccented Vietnamese, English, codes", () => {
  assert.equal(langOf("phạt vi phạm"), "vi")
  assert.equal(langOf("luat thuong mai so 36 2005 qh11"), "vi")
  assert.equal(langOf("Other shrimps and prawns"), "en")
  assert.equal(langOf("0306.17.00"), undefined)
  assert.equal(langOf("65.000 USD × 10%"), undefined)
})
t("confidence reasons → codes; change summaries → structured", () => {
  assert.deepEqual(whyOf(["2/4 mục chưa có căn cứ", "9/9 căn cứ đều khớp với nguồn đã tra hoặc do công cụ tính (2)"]), [{ code: "unsupported", n: 2, total: 4 }, { code: "all_matched", n: 9, total: 9, computed: 2 }])
  assert.deepEqual(parseChangeLine("Sửa Điều 10 khoản 2, 3 (2 chỗ)"), { op: "edit", unit: "article", n: "10", clauses: ["2", "3"], count: 2 })
  assert.deepEqual(summarizeChanges([{ op: "replace", target: "Điều 10 khoản 2" }, { op: "replace", target: "Điều 10 khoản 3" }, { op: "insert_after", target: "sau Mục 3.1" }]), [
    { op: "edit", unit: "article", n: "10", clauses: ["2", "3"] },
    { op: "add", pos: "after", unit: "section", n: "3.1" },
  ])
})
console.log(`${n} passed`)
