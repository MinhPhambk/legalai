// clock_now / clock_calc: the current date in Vietnam and deterministic deadline arithmetic for legal /
// contract time limits, so the agent never computes dates "in its head".
// Rules (Bộ luật Dân sự 2015): Điều 147.2 – a period in days/weeks/months/years starts on the day AFTER the
// reference day; Điều 148.1–4 – it ends at the end of the last day (months/years: the corresponding day,
// or the last day of the month when there is none); Điều 148.5 – when the last day is a weekly day off or a
// public holiday, the period ends at the end of the next working day.
// Public holidays: Bộ luật Lao động 2019 Điều 112 (1/1; Tết Âm lịch 5 days; Giỗ Tổ Hùng Vương 10/3 âm
// lịch; 30/4; 1/5; Quốc khánh 2/9 + 1 adjacent day) + Điều 111.3 (a holiday on a weekly day off is taken
// on the next working day). Lunar dates are computed with Hồ Ngọc Đức's Vietnamese lunar calendar
// algorithm (UTC+7). The actual Tết / 2-9 schedule is fixed each year by the competent authority and can
// move days around – the tool says so and accepts `extra_holidays` to follow the official notice.
import { tool } from "@opencode-ai/plugin"

import { addDays, addMonths, diffDays, fmt, key, mk, nowVN, parseDate, type D } from "../lib/calendar.ts"

const WD_VI = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"]
const WD_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
// civil dates, today in Vietnam and date parsing: ../lib/calendar.ts (shared with calc_interest)
const wd = (x: D) => WD_VI[x.getUTCDay()]

// ---------- Vietnamese lunar calendar (Hồ Ngọc Đức), time zone +7 ----------
const INT = Math.floor
function jdFromDate(dd: number, mm: number, yy: number) {
  const a = INT((14 - mm) / 12), y = yy + 4800 - a, m = mm + 12 * a - 3
  let jd = dd + INT((153 * m + 2) / 5) + 365 * y + INT(y / 4) - INT(y / 100) + INT(y / 400) - 32045
  if (jd < 2299161) jd = dd + INT((153 * m + 2) / 5) + 365 * y + INT(y / 4) - 32083
  return jd
}
function jdToDate(jd: number): [number, number, number] {
  let b: number, c: number
  if (jd > 2299160) { const a = jd + 32044; b = INT((4 * a + 3) / 146097); c = a - INT((b * 146097) / 4) }
  else { b = 0; c = jd + 32082 }
  const d = INT((4 * c + 3) / 1461), e = c - INT((1461 * d) / 4), m = INT((5 * e + 2) / 153)
  return [e - INT((153 * m + 2) / 5) + 1, m + 3 - 12 * INT(m / 10), b * 100 + d - 4800 + INT(m / 10)]
}
function newMoon(k: number) {
  const T = k / 1236.85, T2 = T * T, T3 = T2 * T, dr = Math.PI / 180
  let Jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3
  Jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr)
  const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3
  const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3
  const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3
  let C1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M)
  C1 = C1 - 0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(dr * 2 * Mpr) - 0.0004 * Math.sin(dr * 3 * Mpr)
  C1 = C1 + 0.0104 * Math.sin(dr * 2 * F) - 0.0051 * Math.sin(dr * (M + Mpr)) - 0.0074 * Math.sin(dr * (M - Mpr)) + 0.0004 * Math.sin(dr * (2 * F + M))
  C1 = C1 - 0.0004 * Math.sin(dr * (2 * F - M)) - 0.0006 * Math.sin(dr * (2 * F + Mpr)) + 0.001 * Math.sin(dr * (2 * F - Mpr)) + 0.0005 * Math.sin(dr * (2 * Mpr + M))
  const deltat = T < -11 ? 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3 : -0.000278 + 0.000265 * T + 0.000262 * T2
  return Jd1 + C1 - deltat
}
function sunLongitude(jdn: number) {
  const T = (jdn - 2451545.0) / 36525, T2 = T * T, dr = Math.PI / 180
  const M = 357.5291 + 35999.0503 * T - 0.0001559 * T2 - 0.00000048 * T * T2
  const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2
  const DL = (1.9146 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M) + (0.019993 - 0.000101 * T) * Math.sin(dr * 2 * M) + 0.00029 * Math.sin(dr * 3 * M)
  let L = (L0 + DL) * dr
  L -= Math.PI * 2 * INT(L / (Math.PI * 2))
  return L
}
const LTZ = 7
const newMoonDay = (k: number) => INT(newMoon(k) + 0.5 + LTZ / 24)
const sunLongDay = (dayNumber: number) => INT((sunLongitude(dayNumber - 0.5 - LTZ / 24) / Math.PI) * 6)
function lunarMonth11(yy: number) {
  const k = INT((jdFromDate(31, 12, yy) - 2415021) / 29.530588853)
  const nm = newMoonDay(k)
  return sunLongDay(nm) >= 9 ? newMoonDay(k - 1) : nm
}
function leapMonthOffset(a11: number) {
  const k = INT((a11 - 2415021.076998695) / 29.530588853 + 0.5)
  let last = 0, i = 1, arc = sunLongDay(newMoonDay(k + i))
  do { last = arc; i++; arc = sunLongDay(newMoonDay(k + i)) } while (arc !== last && i < 14)
  return i - 1
}
/** Lunar day/month (non-leap) of lunar year `ly` → solar date. */
function lunarToSolar(ld: number, lm: number, ly: number): D {
  const a11 = lm < 11 ? lunarMonth11(ly - 1) : lunarMonth11(ly)
  const b11 = lm < 11 ? lunarMonth11(ly) : lunarMonth11(ly + 1)
  const k = INT(0.5 + (a11 - 2415021.076998695) / 29.530588853)
  let off = lm - 11
  if (off < 0) off += 12
  if (b11 - a11 > 365 && off >= leapMonthOffset(a11)) off += 1
  const [d, m, y] = jdToDate(newMoonDay(k + off) + ld - 1)
  return mk(y, m, d)
}
function solarToLunar(x: D): { day: number; month: number; year: number; leap: boolean } {
  const dayNumber = jdFromDate(x.getUTCDate(), x.getUTCMonth() + 1, x.getUTCFullYear())
  const yy = x.getUTCFullYear()
  const k = INT((dayNumber - 2415021.076998695) / 29.530588853)
  let monthStart = newMoonDay(k + 1)
  if (monthStart > dayNumber) monthStart = newMoonDay(k)
  let a11 = lunarMonth11(yy), b11 = a11, year: number
  if (a11 >= monthStart) { year = yy; a11 = lunarMonth11(yy - 1) } else { year = yy + 1; b11 = lunarMonth11(yy + 1) }
  const day = dayNumber - monthStart + 1
  const diff = INT((monthStart - a11) / 29)
  let leap = false, month = diff + 11
  if (b11 - a11 > 365) {
    const lmd = leapMonthOffset(a11)
    if (diff >= lmd) { month = diff + 10; if (diff === lmd) leap = true }
  }
  if (month > 12) month -= 12
  if (month >= 11 && diff < 4) year -= 1
  return { day, month, year, leap }
}

// ---------- public holidays ----------
const holidayCache = new Map<number, Map<string, string>>()
/** Public holidays of a year (BLLĐ 2019 Điều 112) + compensatory days off (Điều 111.3). */
function holidaysOf(y: number): Map<string, string> {
  const hit = holidayCache.get(y)
  if (hit) return hit
  const h = new Map<string, string>()
  const add = (x: D, name: string) => { if (!h.has(key(x))) h.set(key(x), name) }
  add(mk(y, 1, 1), "Tết Dương lịch")
  const tet = lunarToSolar(1, 1, y)
  add(addDays(tet, -1), "Tết Âm lịch (ngày cuối năm âm lịch)")
  for (let i = 0; i < 4; i++) add(addDays(tet, i), `Tết Âm lịch (mùng ${i + 1})`)
  add(lunarToSolar(10, 3, y), "Giỗ Tổ Hùng Vương (10/3 âm lịch)")
  add(mk(y, 4, 30), "Ngày Chiến thắng 30/4")
  add(mk(y, 5, 1), "Ngày Quốc tế Lao động 1/5")
  const qk = mk(y, 9, 2)
  add(qk, "Quốc khánh 2/9")
  // the adjacent day is decided each year; default: 1/9 when 2/9 is a Tuesday (joins the weekend) or a Sunday, else 3/9
  add(qk.getUTCDay() === 2 || qk.getUTCDay() === 0 ? mk(y, 9, 1) : mk(y, 9, 3), "Quốc khánh (ngày liền kề)")
  // compensatory days: a holiday on Saturday / Sunday is taken on the next working day
  const isOff = (x: D) => x.getUTCDay() === 0 || x.getUTCDay() === 6 || h.has(key(x))
  for (const [k0, name] of [...h].sort()) {
    const x = new Date(k0 + "T00:00:00Z")
    if (x.getUTCDay() !== 0 && x.getUTCDay() !== 6) continue
    let c = addDays(x, 1)
    while (isOff(c)) c = addDays(c, 1)
    h.set(key(c), `Nghỉ bù (${name} trùng ngày nghỉ hằng tuần)`)
  }
  holidayCache.set(y, h)
  return h
}
type Cal = { holiday: (x: D) => string | undefined; off: (x: D) => string | undefined }
function calendar(extra: D[]): Cal {
  const ex = new Set(extra.map(key))
  const holiday = (x: D) => (ex.has(key(x)) ? "ngày nghỉ theo thông báo (extra_holidays)" : holidaysOf(x.getUTCFullYear()).get(key(x)))
  const off = (x: D) => holiday(x) ?? (x.getUTCDay() === 0 ? "Chủ nhật" : x.getUTCDay() === 6 ? "Thứ Bảy" : undefined)
  return { holiday, off }
}
const lunarStr = (x: D) => { const l = solarToLunar(x); return `${l.day}/${l.month}${l.leap ? " (nhuận)" : ""} năm âm lịch ${l.year}` }

const NOTE_HOLIDAYS = "Ngày nghỉ lễ: Điều 112 Bộ luật Lao động 2019 (Tết Âm lịch mặc định = ngày cuối năm âm lịch + mùng 1–4; Quốc khánh = 2/9 + 1 ngày liền kề mặc định) và nghỉ bù theo Điều 111 khoản 3; ngày làm việc = Thứ Hai–Thứ Sáu. Lịch nghỉ Tết / Quốc khánh thực tế do cơ quan có thẩm quyền công bố hằng năm (có thể hoán đổi ngày) – nếu khác, gọi lại với extra_holidays theo thông báo chính thức. Hợp đồng có quy ước riêng về cách tính thời hạn thì áp dụng quy ước đó (rule='exact' nếu hợp đồng không lùi ngày nghỉ)."

export const now = tool({
  description:
    "Ngày giờ HIỆN TẠI tại Việt Nam (Asia/Ho_Chi_Minh): dd/mm/yyyy, thứ (tiếng Việt + tiếng Anh), giờ, ISO kèm UTC+07:00, ngày âm lịch, có phải ngày nghỉ lễ / cuối tuần không. BẮT BUỘC gọi khi câu hỏi liên quan 'hôm nay', 'hiện nay', 'còn hạn không', 'còn hiệu lực không' (tình trạng hiệu lực tại ngày tra cứu) – không đoán ngày theo trí nhớ.",
  args: {},
  async execute() {
    const n = nowVN()
    const cal = calendar([])
    const off = cal.off(n.date)
    return [
      `Hôm nay (giờ Việt Nam, UTC+07:00): ${wd(n.date)}, ngày ${fmt(n.date)} – ${n.time}.`,
      `Today (Vietnam time): ${WD_EN[n.date.getUTCDay()]}, ${n.date.getUTCDate()} ${n.date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${n.date.getUTCFullYear()}.`,
      `ISO 8601: ${n.iso} (UTC: ${n.at.toISOString()})`,
      `Âm lịch: ${lunarStr(n.date)}.`,
      off ? `Hôm nay là ngày nghỉ: ${off}.` : "Hôm nay là ngày làm việc.",
      "Khi trả lời, ghi rõ \"tính đến ngày " + fmt(n.date) + "\". Mọi phép tính thời hạn dùng clock_calc.",
    ].join("\n")
  },
})

export const calc = tool({
  description:
    "Tính THỜI HẠN pháp lý / hợp đồng một cách xác định (không tự nhẩm): hạn thanh toán, thời hạn khiếu nại, thời hiệu khởi kiện, hạn giao hàng, hạn trả lời bản câu hỏi điều tra phòng vệ thương mại… Mặc định theo BLDS 2015: ngày đầu KHÔNG tính (Điều 147.2), kết thúc cuối ngày cuối cùng; tháng/năm → ngày tương ứng, không có thì ngày cuối tháng (Điều 148); ngày cuối rơi vào cuối tuần / nghỉ lễ → ngày làm việc tiếp theo (Điều 148.5). Hỗ trợ ngày làm việc (bỏ Thứ Bảy, Chủ nhật, ngày lễ Việt Nam tính theo âm lịch), số ngày giữa hai mốc, và cho biết hạn đã qua chưa so với hôm nay. Kết quả nêu rõ quy tắc đã dùng.",
  args: {
    from: tool.schema.string().optional().describe("Mốc tính (ngày xảy ra sự kiện: ký, nhận hàng, nhận hóa đơn…), 'dd/mm/yyyy' hoặc 'yyyy-mm-dd'; bỏ trống = hôm nay"),
    add_days: tool.schema.number().int().optional().describe("Cộng N ngày theo lịch (VD 30 cho 'trong vòng 30 ngày kể từ ngày …')"),
    add_weeks: tool.schema.number().int().optional().describe("Cộng N tuần"),
    add_months: tool.schema.number().int().optional().describe("Cộng N tháng (ngày tương ứng của tháng cuối)"),
    add_years: tool.schema.number().int().optional().describe("Cộng N năm (VD thời hiệu khởi kiện 2 năm)"),
    business_days: tool.schema.number().int().optional().describe("Cộng N NGÀY LÀM VIỆC (bỏ Thứ Bảy, Chủ nhật, ngày lễ) – dùng khi văn bản ghi 'ngày làm việc'"),
    until: tool.schema.string().optional().describe("Mốc thứ hai: tính số ngày (lịch và làm việc) từ `from` đến `until`"),
    rule: tool.schema.enum(["blds", "exact"]).optional().describe("blds (mặc định) = lùi sang ngày làm việc nếu ngày cuối là ngày nghỉ (Điều 148.5 BLDS); exact = giữ nguyên ngày cuối"),
    extra_holidays: tool.schema.array(tool.schema.string()).optional().describe("Ngày nghỉ bổ sung theo thông báo chính thức (dd/mm/yyyy), VD lịch nghỉ Tết thực tế"),
  },
  async execute({ from, add_days, add_weeks, add_months, add_years, business_days, until, rule, extra_holidays }) {
    const n = nowVN()
    const start = parseDate(from, n.date)
    if (!start) return `Lỗi: không hiểu ngày "${from}". Dùng dd/mm/yyyy (VD 15/01/2026) hoặc yyyy-mm-dd.`
    const extra: D[] = []
    for (const s of extra_holidays ?? []) { const x = parseDate(s, n.date); if (!x) return `Lỗi: extra_holidays có ngày không hợp lệ "${s}".`; extra.push(x) }
    const cal = calendar(extra)
    const label = (x: D) => `${fmt(x)} (${wd(x)})`
    const out: string[] = [`Mốc tính: ${label(start)}${from ? "" : " – hôm nay"}.`]
    const hasAdd = [add_days, add_weeks, add_months, add_years].some((v) => v != null && v !== 0)
    if (business_days != null && hasAdd) return "Lỗi: business_days không dùng chung với add_days / add_weeks / add_months / add_years – gọi riêng từng phép tính."
    if (!hasAdd && business_days == null && !until) return "Lỗi: cần ít nhất một trong add_days, add_weeks, add_months, add_years, business_days hoặc until."
    const status = (end: D) => {
      const d = diffDays(n.date, end)
      return d > 0 ? `So với hôm nay (${fmt(n.date)}): CÒN ${d} ngày (hạn chưa qua).` : d === 0 ? `So với hôm nay (${fmt(n.date)}): hạn cuối là HÔM NAY (hết ngày hôm nay).` : `So với hôm nay (${fmt(n.date)}): ĐÃ QUÁ HẠN ${-d} ngày.`
    }
    if (hasAdd) {
      const parts: string[] = []
      let end = start
      if (add_years) { end = addMonths(end, 12 * add_years); parts.push(`${add_years} năm`) }
      if (add_months) { end = addMonths(end, add_months); parts.push(`${add_months} tháng`) }
      if (add_weeks) { end = addDays(end, 7 * add_weeks); parts.push(`${add_weeks} tuần`) }
      if (add_days) { end = addDays(end, add_days); parts.push(`${add_days} ngày`) }
      const back = [add_days, add_weeks, add_months, add_years].some((v) => (v ?? 0) < 0)
      out.push(back
        ? `Quy tắc: tính lùi ${parts.join(" + ")} từ mốc (không áp dụng lùi ngày nghỉ).`
        : `Quy tắc: BLDS 2015 Điều 147 khoản 2 – ngày ${fmt(start)} không tính, thời hạn bắt đầu từ ${fmt(addDays(start, 1))}; Điều 148 – kết thúc vào cuối ngày cuối cùng${add_months || add_years ? " (tháng/năm: ngày tương ứng, không có thì ngày cuối tháng)" : ""}.`)
      out.push(`Thời hạn ${parts.join(" + ")} → ngày cuối theo lịch: ${label(end)}${cal.off(end) ? ` – ngày nghỉ: ${cal.off(end)}` : ""}.`)
      if (!back && (rule ?? "blds") === "blds" && cal.off(end)) {
        const skipped: string[] = []
        let e2 = end
        while (cal.off(e2)) { skipped.push(`${fmt(e2)} ${cal.off(e2)}`); e2 = addDays(e2, 1) }
        out.push(`Điều 148 khoản 5 BLDS: ngày cuối là ngày nghỉ → kết thúc vào ngày làm việc tiếp theo (bỏ qua: ${skipped.join("; ")}).`)
        end = e2
      } else if (rule === "exact" && cal.off(end)) out.push("rule='exact': giữ nguyên ngày cuối dù là ngày nghỉ (theo thỏa thuận hợp đồng).")
      out.push(`HẠN CUỐI: hết ngày ${label(end)}.`, status(end))
    }
    if (business_days != null) {
      if (business_days <= 0) return "Lỗi: business_days phải > 0."
      let x = start, c = 0
      const skipped: string[] = []
      while (c < business_days) { x = addDays(x, 1); const o = cal.off(x); if (o) { if (o !== "Thứ Bảy" && o !== "Chủ nhật") skipped.push(`${fmt(x)} ${o}`) } else c++ }
      out.push(`Quy tắc: ${business_days} ngày làm việc tính từ ngày tiếp theo mốc (Điều 147.2 BLDS), bỏ Thứ Bảy, Chủ nhật${skipped.length ? ` và ngày lễ: ${skipped.join("; ")}` : " (không gặp ngày lễ)"}.`)
      out.push(`HẠN CUỐI: hết ngày ${label(x)}.`, status(x))
    }
    if (until) {
      const u = parseDate(until, n.date)
      if (!u) return `Lỗi: không hiểu ngày "${until}".`
      const d = diffDays(start, u)
      const [a, b] = d >= 0 ? [start, u] : [u, start]
      let work = 0
      for (let x = addDays(a, 1); x.getTime() <= b.getTime(); x = addDays(x, 1)) if (!cal.off(x)) work++
      out.push(`Từ ${label(start)} đến ${label(u)}: ${Math.abs(d)} ngày theo lịch${d < 0 ? " (mốc thứ hai ở TRƯỚC mốc tính)" : ""}, ${work} ngày làm việc (không tính ngày đầu, tính ngày cuối).`)
      if (!hasAdd && business_days == null) out.push(status(u))
    }
    out.push(NOTE_HOLIDAYS)
    return out.join("\n")
  },
})
