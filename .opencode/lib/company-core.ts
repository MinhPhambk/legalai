// Pure helpers of company_lookup / company_verify (../tools/company.ts): Vietnamese tax-code (MST / mã số
// doanh nghiệp) validation, name / address / person normalisation for due-diligence comparisons, status
// phrase → code mapping, and parsing of text the USER copied from an official page (National Business
// Registration Portal / tracuunnt.gdt.gov.vn) with every personal identifier dropped.
// No network, no tools – imported by tool files and tests only.

// ---------------------------------------------------------------- MST checksum
// 10-digit code N1…N10: N10 = 10 − (Σ Ni·Wi mod 11), W = 31 29 23 19 17 13 7 5 3 (a remainder of 0 would need
// check digit 10 → such codes are never issued). 13-digit code = 10-digit code of the parent + "-" + 3-digit
// dependent-unit number 001–999 (branch, representative office, business location).
const W = [31, 29, 23, 19, 17, 13, 7, 5, 3]
export type MstCheck =
  | { ok: true; kind: "enterprise" | "branch"; code: string; base: string; branch?: string }
  | { ok: false; reason: "format" | "checksum" | "branch_zero" | "personal_id"; input: string; base?: string; expected?: string; detail: string }

export function mstCheckDigit(nine: string): number | null {
  const s = [...nine].reduce((a, d, i) => a + Number(d) * W[i], 0)
  const c = 10 - (s % 11)
  return c === 10 ? null : c
}
export function checkMst(raw: string): MstCheck {
  const input = String(raw ?? "").trim()
  const t = input.replace(/[\s.]/g, "").replace(/[–—_]/g, "-")
  if (/^\d{12}$/.test(t) || /^\d{9}$/.test(t))
    return { ok: false, reason: "personal_id", input, detail: `${t.length} chữ số = số định danh / CMND của cá nhân (từ 01/7/2025 cá nhân, hộ kinh doanh dùng số định danh cá nhân làm MST) – công cụ chỉ tra doanh nghiệp, không xử lý dữ liệu cá nhân` }
  const m = t.match(/^(\d{10})(?:-?(\d{3}))?$/)
  if (!m) return { ok: false, reason: "format", input, detail: "MST doanh nghiệp gồm 10 chữ số, hoặc 13 chữ số dạng 0123456789-001 (đơn vị phụ thuộc: chi nhánh, VPĐD, địa điểm kinh doanh)" }
  const [, base, br] = m
  const exp = mstCheckDigit(base.slice(0, 9))
  if (exp === null || exp !== Number(base[9]))
    return { ok: false, reason: "checksum", input, base, expected: exp === null ? undefined : base.slice(0, 9) + exp, detail: exp === null ? `9 chữ số đầu ${base.slice(0, 9)} không thể tạo MST hợp lệ (số kiểm tra = 10)` : `chữ số kiểm tra (số thứ 10) phải là ${exp}, không phải ${base[9]} – có thể gõ nhầm` }
  if (br === "000") return { ok: false, reason: "branch_zero", input, base, detail: "3 số đuôi của đơn vị phụ thuộc phải từ 001 đến 999" }
  return br ? { ok: true, kind: "branch", code: `${base}-${br}`, base, branch: br } : { ok: true, kind: "enterprise", code: base, base }
}

// ---------------------------------------------------------------- normalisation
export const stripVi = (s: string) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
const base = (s: string) => stripVi(s).toLowerCase().replace(/[“”"'`’]/g, "").replace(/[.,;:()\[\]{}\/\\&+–—-]/g, " ").replace(/\s+/g, " ").trim()

// Company names: legal-form and common abbreviations → full words (Luật Doanh nghiệp: TNHH, CP, MTV…).
const NAME_ABBR: [RegExp, string][] = [
  [/\bctcp\b/g, "cong ty co phan"], [/\bcty\b/g, "cong ty"], [/\bcong ty cp\b/g, "cong ty co phan"],
  [/\btnhh\b/g, "trach nhiem huu han"], [/\bmtv\b/g, "mot thanh vien"], [/\b1tv\b/g, "mot thanh vien"], [/\bmot tv\b/g, "mot thanh vien"],
  [/\bhtv\b/g, "hai thanh vien"], [/\b2tv\b/g, "hai thanh vien"], [/\bcp\b/g, "co phan"], [/\bdntn\b/g, "doanh nghiep tu nhan"],
  [/\bhtx\b/g, "hop tac xa"], [/\btm\b/g, "thuong mai"], [/\bdv\b/g, "dich vu"], [/\bsx\b/g, "san xuat"], [/\bxnk\b/g, "xuat nhap khau"],
  [/\bxd\b/g, "xay dung"],
  [/\btmdv\b/g, "thuong mai dich vu"], [/\bsxtm\b/g, "san xuat thuong mai"], [/\bvn\b/g, "viet nam"], [/\btap doan\b/g, "tap doan"],
]
// English / international legal forms → the Vietnamese form, so "ABC Co., Ltd" ≈ "Công ty TNHH ABC".
const EN_FORM: [RegExp, string][] = [
  [/\b(joint stock company|jsc|j s c|corporation|corp)\b/g, "cong ty co phan"],
  [/\b(one member limited liability company|single member limited liability company|one member llc|one member co ltd)\b/g, "cong ty trach nhiem huu han mot thanh vien"],
  [/\b(limited liability company|company limited|co ltd|llc|ltd)\b/g, "cong ty trach nhiem huu han"],
  [/\bgroup\b/g, "tap doan"], [/\bcompany\b/g, "cong ty"], // (bare "co" is NOT mapped: it is also "cổ" / "có" once diacritics are stripped)
]
const FORM_PHRASES = /\b(tong cong ty|cong ty|co phan|trach nhiem huu han|mot thanh vien|hai thanh vien|doanh nghiep tu nhan|hop tac xa|tap doan|chi nhanh|van phong dai dien)\b/g
export function normName(s: string): string {
  let x = " " + base(s) + " "
  for (const [re, v] of EN_FORM) x = x.replace(re, v)
  for (const [re, v] of NAME_ABBR) x = x.replace(re, v)
  return x.replace(/\s+/g, " ").trim()
}
/** Name without legal-form words ("cong ty co phan …") – the distinctive part. */
export const coreName = (s: string) => normName(s).replace(FORM_PHRASES, " ").replace(/\s+/g, " ").trim()
const FORM_VI: Record<string, string> = { cp: "công ty cổ phần", tnhh1: "công ty TNHH một thành viên", tnhh: "công ty TNHH", dntn: "doanh nghiệp tư nhân", htx: "hợp tác xã", hd: "công ty hợp danh" }
/** Legal form of a name: "cp" | "tnhh1" | "tnhh" | "dntn" | "htx" | null. */
export function legalForm(s: string): string | null {
  const n = normName(s)
  if (/co phan/.test(n)) return "cp"
  if (/trach nhiem huu han mot thanh vien/.test(n)) return "tnhh1"
  if (/trach nhiem huu han/.test(n)) return "tnhh"
  if (/doanh nghiep tu nhan/.test(n)) return "dntn"
  if (/hop tac xa/.test(n)) return "htx"
  if (/hop danh/.test(n)) return "hd"
  return null
}

const ADDR_ABBR: [RegExp, string][] = [
  [/\btp hcm\b|\btp ho chi minh\b|\bhcm\b|\bhcmc\b|\bsai gon\b/g, "ho chi minh"], [/\bhn\b/g, "ha noi"],
  [/\btp\b|\bthanh pho\b/g, " "], [/\bp\b|\bphuong\b/g, " "], [/\bq\b|\bquan\b/g, " "], [/\bh\b|\bhuyen\b/g, " "], [/\btx\b|\bthi xa\b/g, " "],
  [/\btt\b|\bthi tran\b/g, " "], [/\bx\b|\bxa\b/g, " "], [/\bt\b|\btinh\b/g, " "], [/\bdac khu\b/g, " "],
  [/\bso nha\b|\bso\b/g, " "], [/\bd\b|\bduong\b|\bpho\b/g, " "], [/\bkcn\b|\bkhu cong nghiep\b/g, "kcn"], [/\bkdt\b|\bkhu do thi\b/g, "kdt"],
  [/\bviet nam\b|\bvietnam\b/g, " "], [/\btoa nha\b|\btoa\b|\bbuilding\b/g, "toa"], [/\btang\b|\bfloor\b/g, "tang"],
]
export function normAddress(s: string): string {
  let x = " " + base(s) + " "
  for (const [re, v] of ADDR_ABBR) x = x.replace(re, v)
  return x.replace(/\s+/g, " ").trim()
}
const TITLES = /^(ong|ba|anh|chi|mr|mrs|ms|miss|dr|ts|ths|ks|ls|giam doc|tong giam doc|chu tich hoi dong quan tri|chu tich hdqt|chu tich|pho giam doc)\b\s*/
export function normPerson(s: string): string {
  let x = base(s)
  for (let i = 0; i < 3; i++) x = x.replace(TITLES, "")
  return x.trim()
}

// ---------------------------------------------------------------- comparisons
export type FieldResult = { field: "name" | "address" | "representative" | "tax_code" | "status"; result: "match" | "partial" | "mismatch" | "not_checked"; expected?: string; official?: string; note?: string }
const tokens = (s: string) => new Set(s.split(" ").filter(Boolean))
function overlap(a: string, b: string) {
  const A = tokens(a), B = tokens(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const t of A) if (B.has(t)) n++
  return n / Math.max(A.size, B.size)
}
export function compareName(expected: string, official: string[], _: unknown = null): FieldResult {
  const offs = official.filter(Boolean)
  const e = normName(expected)
  const exact = offs.find((o) => normName(o) === e)
  if (exact) return { field: "name", result: "match", expected, official: exact, note: base(expected) === base(exact) ? undefined : "khớp sau khi chuẩn hóa dấu / viết tắt (TNHH, CP, MTV…)" }
  let best = offs[0] ?? "", score = 0
  for (const o of offs) { const s = coreName(o) === coreName(expected) ? 0.99 : overlap(coreName(expected), coreName(o)); if (s > score) { score = s; best = o } }
  const fe = legalForm(expected), fo = legalForm(best)
  if (score >= 0.99) return { field: "name", result: fe && fo && fe !== fo ? "mismatch" : "partial", expected, official: best, note: fe && fo && fe !== fo ? `phần tên riêng giống nhưng LOẠI HÌNH khác (${FORM_VI[fe]} ≠ ${FORM_VI[fo]}) – có thể là doanh nghiệp khác` : "phần tên riêng giống, khác cách ghi loại hình / từ phụ – yêu cầu ghi đúng tên đầy đủ theo đăng ký" }
  const formNote = fe && fo && fe !== fo ? `; LOẠI HÌNH khác (${FORM_VI[fe]} ≠ ${FORM_VI[fo]})` : ""
  if (score >= 0.6) return { field: "name", result: formNote ? "mismatch" : "partial", expected, official: best, note: `tên gần giống nhưng không trùng – yêu cầu ghi đúng tên theo Giấy chứng nhận ĐKDN${formNote}` }
  return { field: "name", result: "mismatch", expected, official: best, note: formNote ? `tên khác${formNote} – có thể là doanh nghiệp khác` : "tên khác – có thể là doanh nghiệp khác hoặc tên cũ trước khi đổi tên" }
}
export function compareAddress(expected: string, official: string): FieldResult {
  const e = normAddress(expected), o = normAddress(official)
  if (e === o) return { field: "address", result: "match", expected, official, note: base(expected) === base(official) ? undefined : "khớp sau khi chuẩn hóa viết tắt (P., Q., TP., số…)" }
  const s = overlap(e, o)
  const houseE = e.match(/\b\d+[a-z]?(?: \d+[a-z]?)*\b/)?.[0], houseO = o.match(/\b\d+[a-z]?(?: \d+[a-z]?)*\b/)?.[0]
  if (houseE && houseO && houseE !== houseO) return { field: "address", result: "mismatch", expected, official, note: "khác số nhà / lô" }
  if (s >= 0.6 && houseE === houseO) return { field: "address", result: "partial", expected, official, note: "cùng số nhà nhưng khác tên đường / đơn vị hành chính – có thể do sắp xếp đơn vị hành chính từ 01/7/2025 (bỏ cấp huyện, sáp nhập tỉnh / xã) hoặc địa chỉ cũ; đề nghị đối tác ghi đúng địa chỉ theo đăng ký hiện hành" }
  return { field: "address", result: "mismatch", expected, official }
}
export function comparePerson(expected: string, official: string): FieldResult {
  const e = normPerson(expected), o = normPerson(official)
  const plain = (s: string) => s.toLowerCase().replace(/^(ông|bà|mr\.?|mrs\.?|ms\.?)\s+/, "").replace(/\s+/g, " ").trim()
  if (e && e === o) return { field: "representative", result: "match", expected, official, note: plain(expected) !== plain(official) ? "khớp khi bỏ dấu – nên ghi đúng họ tên có dấu như đăng ký" : undefined }
  if (e && [...tokens(e)].sort().join(" ") === [...tokens(o)].sort().join(" ")) return { field: "representative", result: "partial", expected, official, note: "cùng các chữ nhưng khác thứ tự" }
  return { field: "representative", result: "mismatch", expected, official, note: "người ký có thể là người được ủy quyền – khi đó yêu cầu giấy ủy quyền hợp lệ của người đại diện theo pháp luật" }
}

// ---------------------------------------------------------------- status phrases → codes
export const STATUS: { re: RegExp; code: string }[] = [
  { re: /tạm ngừng|tam ngung/i, code: "temporarily_suspended" },
  { re: /không hoạt động tại địa chỉ|khong hoat dong tai dia chi|bỏ địa chỉ/i, code: "not_at_address" },
  { re: /đang làm thủ tục giải thể|đang giải thể|dang lam thu tuc giai the/i, code: "dissolving" },
  { re: /đã giải thể|da giai the|giải thể/i, code: "dissolved" },
  { re: /phá sản|pha san/i, code: "bankrupt" },
  { re: /thu hồi giấy chứng nhận|bị thu hồi|thu hoi/i, code: "revoked" },
  { re: /ngừng hoạt động nhưng chưa hoàn thành|chưa hoàn thành thủ tục chấm dứt/i, code: "ceased_pending_closure" },
  { re: /đã chấm dứt hiệu lực mã số thuế|hoàn thành thủ tục chấm dứt hiệu lực|chấm dứt hiệu lực mst/i, code: "tax_code_closed" },
  { re: /ngừng hoạt động|ngung hoat dong|chấm dứt hoạt động/i, code: "ceased" },
  { re: /đang hoạt động|dang hoat dong|^hoạt động$|đã được cấp gcn đkt/i, code: "active" },
]
export const statusOf = (s?: string | null) => STATUS.find((x) => x.re.test(String(s ?? "")))?.code ?? (s ? "other" : undefined)
export const STATUS_RISK: Record<string, string> = {
  active: "đang hoạt động theo đăng ký",
  temporarily_suspended: "RỦI RO: đang tạm ngừng kinh doanh – không được ký kết / thực hiện hợp đồng mới trong thời gian tạm ngừng (trừ hợp đồng đã ký, nghĩa vụ thuế…)",
  not_at_address: "RỦI RO CAO: cơ quan thuế ghi nhận không hoạt động tại địa chỉ đã đăng ký – nguy cơ hóa đơn không hợp lệ, khó liên hệ / thi hành",
  dissolving: "RỦI RO CAO: đang làm thủ tục giải thể – bị cấm ký hợp đồng mới trừ để thực hiện giải thể",
  dissolved: "RỦI RO RẤT CAO: đã giải thể – không còn tư cách pháp nhân, không ký hợp đồng",
  bankrupt: "RỦI RO RẤT CAO: liên quan thủ tục phá sản",
  revoked: "RỦI RO RẤT CAO: bị thu hồi Giấy chứng nhận đăng ký doanh nghiệp",
  ceased_pending_closure: "RỦI RO CAO: ngừng hoạt động nhưng chưa hoàn thành thủ tục chấm dứt hiệu lực MST",
  tax_code_closed: "RỦI RO RẤT CAO: đã chấm dứt hiệu lực mã số thuế – không được sử dụng MST trong giao dịch",
  ceased: "RỦI RO CAO: ngừng hoạt động",
  other: "tình trạng chưa phân loại – đọc nguyên văn trên trang chính thức",
}

// ---------------------------------------------------------------- user-copied official text → record
export type CompanyRecord = {
  name?: string; nameEn?: string; short?: string; code?: string; status?: string; statusCode?: string; type?: string
  regDate?: string; address?: string; representative?: string; mainLine?: string; taxAuthority?: string
}
// Fields that are NEVER read (personal data of individuals); checked before the field labels.
const DENY = /cmt|cmnd|cccd|căn cước|can cuoc|hộ chiếu|ho chieu|định danh|dinh danh|ngày sinh|ngay sinh|giới tính|dân tộc|quốc tịch|hộ khẩu|thường trú|chỗ ở|nơi ở|liên lạc|lien lac|điện thoại|dien thoai|fax|email|thư điện tử|website|địa chỉ (của )?(người|chủ|giám đốc)|số giấy tờ|giấy tờ pháp lý|chữ ký|mẫu dấu/i
const LABELS: { key: keyof CompanyRecord; re: RegExp }[] = [
  { key: "nameEn", re: /^(tên (doanh nghiệp |công ty )?(viết )?bằng tiếng nước ngoài|tên (tiếng anh|quốc tế|nước ngoài)|english name)$/i },
  { key: "short", re: /^(tên (doanh nghiệp |công ty )?viết tắt|tên giao dịch|abbreviation)$/i },
  { key: "name", re: /^(tên doanh nghiệp(( viết)? bằng tiếng việt)?|tên người nộp thuế|tên công ty|tên tổ chức|tên đơn vị|tên chính thức|enterprise name|company name)$/i },
  { key: "code", re: /^(mã số doanh nghiệp|mã số thuế|mã số dn|mst|số đkkd\/mst|số đkkd\/mã số thuế|mã doanh nghiệp|enterprise code|tax code)$/i },
  { key: "status", re: /^(tình trạng( hoạt động)?|trạng thái( hoạt động| mst)?|tình trạng hoạt động của doanh nghiệp|status)$/i },
  { key: "type", re: /^(loại hình( pháp lý| doanh nghiệp| dn)?|legal type)$/i },
  { key: "regDate", re: /^(ngày (bắt đầu )?thành lập|ngày cấp( mã số thuế| mst)?|ngày đăng ký lần đầu|ngày cấp giấy chứng nhận|ngày cấp giấy phép|founding date)$/i },
  { key: "address", re: /^(địa chỉ trụ sở( chính)?|địa chỉ( trụ sở)? kinh doanh|địa chỉ|trụ sở chính|head office address)$/i },
  { key: "representative", re: /^((tên )?người đại diện( theo pháp luật)?|đại diện (theo )?pháp luật|người đại diện pháp luật|(tên )?giám đốc|chủ doanh nghiệp|legal representative)$/i },
  { key: "mainLine", re: /^(ngành nghề (kinh doanh )?chính|ngành nghề kd|ngành chính|ngành kinh doanh chính|main business line)$/i },
  { key: "taxAuthority", re: /^(cơ quan thuế( quản lý)?|nơi đăng ký quản lý( thuế)?|quản lý bởi|tax authority)$/i },
]
const scrubIds = (s: string) => s.replace(/\b\d{12}\b|\b\d{9}\b/g, "").replace(/(?:\+84|\b0)(?:[\s.]?\d){8,10}\b/g, (m) => (/^\d{10}$/.test(m.replace(/\D/g, "")) && checkMst(m.replace(/\D/g, "")).ok ? m : "")).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "")
const clean = (s: string) => scrubIds(s).replace(/\s+/g, " ").replace(/^[:\-–\s]+|[\s,;:\-–]+$/g, "").trim()
/** Person name only: letters and spaces up to the first digit / bracket / comma / title separator. */
export const personName = (s: string) => stripTitle(String(s ?? "").split(/[\d(,;|\t]|\s[-–]\s|chức danh|chuc danh/i)[0].replace(/[^\p{L}\s.]/gu, " ").replace(/\s+/g, " ").trim())
const stripTitle = (s: string) => s.replace(/^(ông|bà|mr\.?|mrs\.?|ms\.?)\s+/i, "")

export function parseOfficialText(text: string): CompanyRecord {
  const out: CompanyRecord = {}
  const lines = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/ /g, " ").trim())
  const take = (key: keyof CompanyRecord, v: string) => { const c = clean(v); if (c && !out[key]) (out as any)[key] = c }
  // result TABLE (tracuunnt: "STT | MST | Tên người nộp thuế | Cơ quan thuế | Số CMT/Thẻ căn cước người đại diện | …"):
  // header row with ≥ 2 known labels → the next row with as many cells; personal-data columns are skipped
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split("\t").map((c) => c.replace(/[*:]+$/, "").trim())
    if (cells.length < 3) continue
    const keys = cells.map((c): keyof CompanyRecord | null => (DENY.test(c) ? null : /^ghi chú$/i.test(c) ? "status" : LABELS.find((x) => x.re.test(c))?.key ?? null))
    if (keys.filter(Boolean).length < 2) continue
    const row = lines.slice(i + 1).find((l) => l.split("\t").length >= cells.length - 1 && l.trim())
    if (!row) break
    row.split("\t").forEach((v, k) => { if (keys[k]) take(keys[k]!, v) })
    break
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l || l.split("\t").length >= 3) continue
    // "Label: value" / "Label<TAB>value" / "Label" + value on the next line
    const m = l.match(/^([^:\t]{2,70}?)\s*(?::|\t)\s*(.*)$/)
    const label = (m ? m[1] : l).replace(/[*:]+$/, "").trim()
    if (DENY.test(label)) { if (m && !m[2]) i++; continue }
    const hit = LABELS.find((x) => x.re.test(label))
    if (!hit) continue
    let v = m ? m[2] : ""
    if (!v) { let j = i + 1; while (j < lines.length && !lines[j]) j++; if (j < lines.length && !LABELS.some((x) => x.re.test(lines[j].replace(/[*:]+$/, ""))) && !DENY.test(lines[j].split(/[:\t]/)[0])) { v = lines[j]; i = j } }
    take(hit.key, v)
  }
  // main line in the business-line table: "4610 | Đại lý … | (Ngành chính)" / "… (ngành chính)" / "… Y"
  if (!out.mainLine) {
    // a row "4690<TAB>Bán buôn tổng hợp<TAB>X" under a header with a "Ngành chính" column, or "… (Ngành chính)"
    const hdr = lines.findIndex((l) => l.includes("\t") && /ngành chính/i.test(l) && !/\d{4}/.test(l))
    const MARK = /\t\s*(x|y|có|✓|✔)\s*$/i
    const marked = hdr >= 0 ? lines.slice(hdr + 1).find((l) => /^\d{4,5}\t/.test(l) && MARK.test(l)) : undefined
    const ml = marked?.replace(MARK, "") ?? lines.find((l) => /ngành chính|nganh chinh/i.test(l) && /\d{4}/.test(l))
    if (ml) out.mainLine = clean(ml.replace(/\(?\s*ngành chính\s*\)?|nganh chinh/gi, "").replace(/\t+/g, " – "))
  }
  if (out.representative) out.representative = personName(out.representative) || undefined
  if (out.code) out.code = out.code.replace(/[^\d-]/g, "").slice(0, 14) || undefined
  if (out.status) out.statusCode = statusOf(out.status)
  return out
}

// ---------------------------------------------------------------- result page read after assisted browsing
/**
 * Company record from an official RESULT page the user reached themselves (assisted browsing, ../lib/assist.ts):
 * text = the page's tables (cells tab-separated) + its visible text. Same label rules and privacy filter as a paste.
 *  - tracuunnt.gdt.gov.vn (source "gdt"): result list STT | MST | Tên người nộp thuế | Cơ quan thuế | Số CMT… | Ngày thay đổi
 *    thông tin gần nhất | Ghi chú (= trạng thái) + the detail pane (Mã số thuế, Tên người nộp thuế, Địa chỉ trụ sở, Cơ quan
 *    thuế quản lý, Ngày cấp MST, Tên giám đốc / Người đại diện, Trạng thái …);
 *  - dichvuthongtin.dkkd.gov.vn (source "dkkd"): the enterprise page (Tên doanh nghiệp viết bằng tiếng Việt / nước ngoài /
 *    viết tắt, Mã số doanh nghiệp, Tình trạng hoạt động, Loại hình pháp lý, Ngày bắt đầu thành lập, Tên người đại diện theo
 *    pháp luật, Địa chỉ trụ sở chính, ngành nghề).
 * notFound: the page says no taxpayer / enterprise matched. codeOk: the record is for the requested code.
 */
export function parseResultPage(text: string, code: string): { rec: CompanyRecord; notFound: boolean; codeOk: boolean } {
  const rec = parseOfficialText(text)
  const want = String(code ?? "").replace(/-/g, "")
  // list rows show the code as a cell of its own; accept it when the label pass missed it
  const esc = code.replace(/[^\d]/g, (c) => (c === "-" ? "-?" : ""))
  if (!rec.code && want && new RegExp(`(^|[\\t\\s])${esc}(?![\\d-])`).test(text)) rec.code = code
  const notFound = !rec.name && /không tìm thấy|không có (dữ liệu|kết quả)|danh sách trống/i.test(text)
  return { rec, notFound, codeOk: !!rec.code && rec.code.replace(/-/g, "") === want }
}

// ---------------------------------------------------------------- robots.txt (RFC 9309, the "*" group)
/** Is `path` (path + query) allowed for a generic agent by this robots.txt? Longest matching rule wins; Allow wins a tie. */
export function robotsAllows(robots: string, path: string, agent = "*"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pat: string }[] }[] = []
  let cur: (typeof groups)[number] | null = null, lastWasAgent = false
  for (const raw of String(robots ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim()
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const k = m[1].toLowerCase(), v = m[2].trim()
    if (k === "user-agent") { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur) } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue }
    lastWasAgent = false
    if (cur && (k === "allow" || k === "disallow") && v) cur.rules.push({ allow: k === "allow", pat: v })
  }
  const a = agent.toLowerCase()
  const g = groups.filter((x) => x.agents.some((n) => n !== "*" && a.includes(n))) // a group naming this agent replaces "*"
  const rules = (g.length ? g : groups.filter((x) => x.agents.includes("*"))).flatMap((x) => x.rules)
  let best: { allow: boolean; len: number } | null = null
  for (const r of rules) {
    const endAnchor = r.pat.endsWith("$")
    const body = (endAnchor ? r.pat.slice(0, -1) : r.pat).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
    const re = new RegExp("^" + body + (endAnchor ? "$" : ""))
    if (re.test(path) && (!best || r.pat.length > best.len || (r.pat.length === best.len && r.allow))) best = { allow: r.allow, len: r.pat.length }
  }
  return best ? best.allow : true
}

// ---------------------------------------------------------------- cross-check of several (unofficial) records
export type SourceRecord = { domain: string; url: string; rec: CompanyRecord }
export type CrossField = "name" | "status" | "address" | "representative" | "regDate"
export type Cross = { field: CrossField; agree: boolean; values: { domain: string; v: string }[]; note?: string }
const FIELD_VALUE: Record<CrossField, (r: CompanyRecord) => string | undefined> = {
  name: (r) => r.name, status: (r) => r.status, address: (r) => r.address, representative: (r) => r.representative, regDate: (r) => r.regDate,
}
function same(field: CrossField, a: string, b: string): boolean {
  if (field === "name") return normName(a) === normName(b)
  if (field === "status") return (statusOf(a) ?? a) === (statusOf(b) ?? b)
  if (field === "representative") return normPerson(a) === normPerson(b)
  if (field === "regDate") { const d = (x: string) => x.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/) ?? x.match(/(\d{4})-(\d{2})-(\d{2})/); const x = d(a), y = d(b); return !!x && !!y && normDate(x[0]) === normDate(y[0]) }
  return compareAddress(a, b).result === "match"
}
const normDate = (s: string) => { const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return `${m[3]}/${m[2]}/${m[1]}`; const n = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); return n ? `${n[1].padStart(2, "0")}/${n[2].padStart(2, "0")}/${n[3]}` : s }
/** Field-by-field agreement of ≥ 1 records (a field shown by one source only: agree = true, note "1 nguồn"). */
export function crossCheck(list: SourceRecord[]): Cross[] {
  const out: Cross[] = []
  for (const field of ["name", "status", "address", "representative", "regDate"] as CrossField[]) {
    const values = list.map((s) => ({ domain: s.domain, v: FIELD_VALUE[field](s.rec) ?? "" })).filter((x) => x.v)
    if (!values.length) continue
    const agree = values.every((x) => same(field, values[0].v, x.v))
    out.push({ field, agree, values, note: values.length === 1 ? "chỉ 1 nguồn có mục này" : undefined })
  }
  return out
}
/** Agreed values (fields on which the sources disagree are left out and listed in `conflicts`). */
export function consensus(list: SourceRecord[], cross: Cross[]): CompanyRecord & { conflicts: CrossField[] } {
  const first = <K extends keyof CompanyRecord>(k: K) => list.map((s) => s.rec[k]).find(Boolean)
  const out: CompanyRecord & { conflicts: CrossField[] } = { conflicts: cross.filter((c) => !c.agree).map((c) => c.field) }
  for (const k of ["name", "nameEn", "short", "code", "type", "mainLine", "taxAuthority"] as const) (out as any)[k] = first(k)
  for (const c of cross) if (c.agree) { (out as any)[c.field] = c.values[0].v; if (c.field === "status") out.statusCode = statusOf(c.values[0].v) }
  return out
}
