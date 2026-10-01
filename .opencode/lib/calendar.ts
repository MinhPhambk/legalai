// Civil-date helpers shared by clock_* (deadlines) and calc_* (interest day counts), so every tool counts
// days with exactly the same calendar logic. UTC-based dates (no time-zone drift); "today" is Vietnam time
// (LEGALAI_NOW=ISO overrides it, for tests). Imported by tool files only – this file exports no tools.
export const TZ = "Asia/Ho_Chi_Minh"
export type D = Date
export const mk = (y: number, m: number, d: number): D => new Date(Date.UTC(y, m - 1, d))
export const addDays = (x: D, n: number): D => new Date(x.getTime() + n * 86_400_000)
export const key = (x: D) => x.toISOString().slice(0, 10)
export const fmt = (x: D) => `${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCMonth() + 1).padStart(2, "0")}/${x.getUTCFullYear()}`
/** Calendar days from a to b (b − a): the first day is not counted, the last day is (BLDS 2015 Điều 147.2). */
export const diffDays = (a: D, b: D) => Math.round((b.getTime() - a.getTime()) / 86_400_000)
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
export function addMonths(x: D, n: number): D {
  const t = x.getUTCFullYear() * 12 + x.getUTCMonth() + n
  const y = Math.floor(t / 12), m = (t % 12) + 1
  return mk(y, m, Math.min(x.getUTCDate(), daysInMonth(y, m))) // Điều 148.3: no corresponding day → last day of that month
}

/** Today in Vietnam (LEGALAI_NOW=ISO overrides, for tests). */
export function nowVN() {
  const at = process.env.LEGALAI_NOW ? new Date(process.env.LEGALAI_NOW) : new Date()
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]))
  return { at, date: mk(+p.year, +p.month, +p.day), time: `${p.hour}:${p.minute}:${p.second}`, iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+07:00` }
}

/** "15/01/2026", "15-1-2026", "2026-01-15", "hôm nay"/"today" → date; null when invalid. */
export function parseDate(s: string | undefined, today: D): D | null {
  const t = String(s ?? "").trim().toLowerCase()
  if (!t || /^(hôm nay|hom nay|today|now|bây giờ)$/.test(t)) return today
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:t[\d:.+z-]*)?$/)
  let y: number, mo: number, d: number
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3] }
  else if ((m = t.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3] }
  else return null
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || y < 1900 || y > 2200) return null
  return mk(y, mo, d)
}
