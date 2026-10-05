// Deterministic weekday check of a final answer: "Thứ Bảy, ngày 04/10/2026" when 04/10/2026 is a Sunday. LLMs
// sometimes "compute" the weekday from memory instead of copying it from clock_now / clock_calc; a wrong weekday
// next to a deadline is a real error for the user, so chats.mjs asks the agent (hidden prompt) to fix it once.
// Only a weekday written right next to a full date is checked (no relative phrases like "Thứ Hai tuần sau").

const VI_DAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"]
const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const EN_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]

/** Vietnamese / English weekday word → 0 (Sunday) … 6 (Saturday), or -1. */
function dayIndex(word) {
  const w = word.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()
  if (/^(chủ nhật|cn)$/.test(w)) return 0
  const m = w.match(/^thứ (hai|ba|tư|năm|sáu|bảy|2|3|4|5|6|7)$/)
  if (m) return { hai: 1, ba: 2, "tư": 3, "năm": 4, "sáu": 5, "bảy": 6 }[m[1]] ?? Number(m[1]) - 1
  const e = EN_DAYS.findIndex((d) => d.toLowerCase() === w)
  return e
}

/** y/m/d → weekday 0…6, or -1 for an impossible date. */
function weekdayOf(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return -1
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCMonth() === m - 1 ? t.getUTCDay() : -1
}

const VI_DAY = String.raw`(?:chủ nhật|thứ\s+(?:hai|ba|tư|năm|sáu|bảy|[2-7]))`
const EN_DAY = String.raw`(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)`
const DAY = `(${VI_DAY}|${EN_DAY})`
// Dates: 04/10/2026, 4-10-2026, 04.10.2026, "ngày 04 tháng 10 năm 2026", "4 October 2026", "October 4, 2026".
const DATE = String.raw`(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})|(?:ngày\s+)?(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(\d{4})|(\d{1,2})\s+(${EN_MONTHS.join("|")})\s+(\d{4})|(${EN_MONTHS.join("|")})\s+(\d{1,2}),?\s+(\d{4})`
// Between a weekday and its date only punctuation, markdown and "ngày" / "the" (no other words – "Thứ Hai đến
// Thứ Sáu, từ 01/10" is a range, not a claim about 01/10).
const GAP = String.raw`[\s*_,:(–-]{0,6}(?:ngày\s+|the\s+)?[\s*_]{0,3}`
const DAY_THEN_DATE = new RegExp(`${DAY}${GAP}(?:${DATE})`, "giu")
const DATE_THEN_DAY = new RegExp(`(?:${DATE})[\\s*_]{0,3}[,(][\\s*_]{0,3}${DAY}`, "giu")

function ymd(g, off) {
  if (g[off]) return [+g[off + 2], +g[off + 1], +g[off]]
  if (g[off + 3]) return [+g[off + 5], +g[off + 4], +g[off + 3]]
  if (g[off + 6]) return [+g[off + 8], EN_MONTHS.indexOf(g[off + 7].toLowerCase()) + 1, +g[off + 6]]
  if (g[off + 9]) return [+g[off + 11], EN_MONTHS.indexOf(g[off + 9].toLowerCase()) + 1, +g[off + 10]]
  return null
}

/**
 * Weekday mismatches in `text`: [{ text, date: "dd/mm/yyyy", said, actualVi, actualEn }] (deduplicated).
 */
export function weekdayIssues(text) {
  const s = String(text || "").normalize("NFC")
  const out = new Map()
  const check = (match, word, d) => {
    if (!d) return
    const [y, m, day] = d
    const actual = weekdayOf(y, m, day)
    const said = dayIndex(word)
    if (actual < 0 || said < 0 || actual === said) return
    const date = `${String(day).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`
    out.set(`${date}|${said}`, { text: match.replace(/\s+/g, " ").trim(), date, said: word.replace(/\s+/g, " ").trim(), actualVi: VI_DAYS[actual], actualEn: EN_DAYS[actual] })
  }
  for (const g of s.matchAll(DAY_THEN_DATE)) check(g[0], g[1], ymd(g, 2))
  for (const g of s.matchAll(DATE_THEN_DAY)) check(g[0], g[13], ymd(g, 1))
  return [...out.values()].slice(0, 10)
}

/** Hidden correction prompt for weekdayIssues (the user does not see it). */
export function weekdayPrompt(issues, locale = "vi") {
  const list = issues.map((x) => (locale === "en" ? `- "${x.text}": ${x.date} is a ${x.actualEn}, not ${x.said}` : `- "${x.text}": ngày ${x.date} là ${x.actualVi}, không phải ${x.said}`)).join("\n")
  return locale === "en"
    ? `Automatic check: the answer states a wrong day of the week:\n${list}\nRewrite the complete answer with the correct weekday (copy weekdays from clock_now / clock_calc, never work them out yourself) and change nothing else (the user does not see this message).`
    : `Kiểm tra tự động: câu trả lời ghi sai thứ trong tuần:\n${list}\nHãy viết lại toàn bộ câu trả lời với thứ đúng (thứ trong tuần luôn chép từ clock_now / clock_calc, không tự suy ra), không thay đổi nội dung khác (người dùng không thấy tin nhắn này).`
}
