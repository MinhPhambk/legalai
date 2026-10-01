// Exact arithmetic for the calc_* / fx_* tools and grounding_check: BigInt rationals (never floating point,
// never eval / Function), Vietnamese + English number formats, a small safe expression parser, amounts in
// words (Vietnamese reading rules and English), and the "calc" evidence entries grounding_check relies on.
// Imported by tool files and tests only – this file exports no tools.
import crypto from "node:crypto"
import { recordEvidence } from "./evidence.ts"

// ---------------------------------------------------------------- rationals
export type Q = { n: bigint; d: bigint }
const babs = (a: bigint) => (a < 0n ? -a : a)
function gcd(a: bigint, b: bigint): bigint {
  a = babs(a); b = babs(b)
  while (b) [a, b] = [b, a % b]
  return a || 1n
}
export function q(n: bigint | number | string, d: bigint | number = 1n): Q {
  let N = BigInt(n), D = BigInt(d)
  if (D === 0n) throw new CalcError("chia cho 0")
  if (D < 0n) { N = -N; D = -D }
  const g = gcd(N, D)
  return { n: N / g, d: D / g }
}
export const ZERO = q(0), ONE = q(1), HUNDRED = q(100)
export const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d)
export const sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d)
export const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d)
export function div(a: Q, b: Q) {
  if (b.n === 0n) throw new CalcError("chia cho 0")
  return q(a.n * b.d, a.d * b.n)
}
export const neg = (a: Q) => q(-a.n, a.d)
export const absQ = (a: Q) => q(babs(a.n), a.d)
export const cmp = (a: Q, b: Q) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0 }
export const eq = (a: Q, b: Q) => a.n === b.n && a.d === b.d
export const isInt = (a: Q) => a.d === 1n
export function powQ(a: Q, k: Q) {
  if (!isInt(k)) throw new CalcError("chỉ hỗ trợ số mũ nguyên (VD (1 + 0,5%)^12)")
  let e = k.n
  if (babs(e) > 10_000n) throw new CalcError("số mũ quá lớn (tối đa 10000)")
  if (e < 0n) { if (a.n === 0n) throw new CalcError("chia cho 0"); a = q(a.d, a.n); e = -e }
  let r = ONE, b = a
  while (e > 0n) { if (e & 1n) r = mul(r, b); b = mul(b, b); e >>= 1n }
  if (r.n.toString().length + r.d.toString().length > 40_000) throw new CalcError("kết quả quá lớn")
  return r
}
export class CalcError extends Error {
  constructor(message: string) { super(message); this.name = "CalcError" }
}

export type RoundMode = "half-up" | "floor" | "ceil" | "trunc"
/** Round to `digits` decimals. half-up = half away from zero (VND / USD money rounding). */
export function roundQ(a: Q, digits: number, mode: RoundMode = "half-up"): Q {
  const s = 10n ** BigInt(Math.max(0, digits))
  const x = a.n * s, d = a.d
  let t = x / d // truncates toward zero
  const r = x - t * d
  if (r !== 0n) {
    if (mode === "floor" && x < 0n) t -= 1n
    else if (mode === "ceil" && x > 0n) t += 1n
    else if (mode === "half-up" && 2n * babs(r) >= d) t += x < 0n ? -1n : 1n
  }
  return q(t, s)
}
/** Number of decimals of a terminating rational, or null when it does not terminate (1/3). */
export function exactDecimals(a: Q): number | null {
  let d = a.d, two = 0, five = 0
  while (d % 2n === 0n) { d /= 2n; two++ }
  while (d % 5n === 0n) { d /= 5n; five++ }
  return d === 1n ? Math.max(two, five) : null
}
/** Plain decimal string with `digits` decimals ("-1234.50"); no grouping. */
export function toFixedQ(a: Q, digits: number): string {
  const r = roundQ(a, digits)
  const s = 10n ** BigInt(digits)
  const v = r.n * (s / r.d)
  const neg0 = v < 0n
  const abs = (neg0 ? -v : v).toString().padStart(digits + 1, "0")
  const int = abs.slice(0, abs.length - digits), frac = abs.slice(abs.length - digits)
  return `${neg0 ? "-" : ""}${int}${digits ? "." + frac : ""}`
}
/** Canonical plain form: exact decimals when terminating (≤ 12), else 12 decimals; trailing zeros trimmed. */
export function plainQ(a: Q, maxDigits = 12): { s: string; exact: boolean } {
  const e = exactDecimals(a)
  const digits = e == null ? maxDigits : Math.min(e, maxDigits)
  let s = toFixedQ(a, digits)
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "")
  return { s, exact: e != null && e <= maxDigits }
}
export type Locale = "vi" | "en"
/** Grouped number: vi "1.250.000,5", en "1,250,000.5". digits = fixed decimals, else exact (≤ 10, "≈" when cut). */
export function fmtQ(a: Q, locale: Locale = "vi", digits?: number): string {
  let s: string, approx = false
  if (digits != null) s = toFixedQ(a, digits)
  else { const p = plainQ(a, 10); s = p.s; approx = !p.exact }
  const neg0 = s.startsWith("-")
  const [int, frac] = s.replace(/^-/, "").split(".")
  const [ts, ds] = locale === "vi" ? [".", ","] : [",", "."]
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ts)
  return `${approx ? "≈" : ""}${neg0 ? "-" : ""}${g}${frac ? ds + frac : ""}`
}
export const fromPlain = (s: string): Q => {
  const m = String(s).trim().match(/^([+-])?(\d+)(?:\.(\d+))?$/)
  if (!m) throw new CalcError(`không phải số: "${s}"`)
  const frac = m[3] ?? ""
  return q(BigInt((m[1] === "-" ? "-" : "") + m[2] + frac), 10n ** BigInt(frac.length))
}

// ---------------------------------------------------------------- number text (vi / en)
export type NumParse = { value: Q; ambiguous?: string }
const NUM_RE = /^\d+(?:[.,]\d+)*$/
/**
 * "1.250.000" / "1,250,000" / "12,5" / "12.5" / "0.125" → exact value. Both separators: the last one is the
 * decimal mark. A single separator followed by exactly 3 digits ("1.250", "65,000") is ambiguous: locale
 * "en" reads "." as decimal, "vi" reads "," as decimal, "auto" reads it as a thousands separator (amounts)
 * and reports the ambiguity.
 */
export function parseNumber(raw: string, locale: "vi" | "en" | "auto" = "auto"): NumParse {
  const s = String(raw).trim().replace(/[\s  ]/g, "")
  const sign = s.startsWith("-") ? "-" : ""
  const t = s.replace(/^[+-]/, "")
  if (!NUM_RE.test(t)) throw new CalcError(`không đọc được số "${raw}"`)
  const dots = (t.match(/\./g) ?? []).length, commas = (t.match(/,/g) ?? []).length
  const grouped = (int: string, sep: string) => {
    const parts = int.split(sep)
    if (parts.slice(1).some((p) => p.length !== 3) || parts[0].length > 3 || !parts[0].length) throw new CalcError(`nhóm chữ số không hợp lệ trong "${raw}"`)
    return parts.join("")
  }
  let int = t, frac = "", ambiguous: string | undefined
  if (dots && commas) {
    const dec = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ","
    const th = dec === "." ? "," : "."
    const i = t.lastIndexOf(dec)
    if (t.slice(i + 1).includes(th) || t.split(dec).length > 2) throw new CalcError(`không đọc được số "${raw}"`)
    int = grouped(t.slice(0, i), th); frac = t.slice(i + 1)
  } else if (dots || commas) {
    const sep = dots ? "." : ","
    const n = dots || commas
    const parts = t.split(sep)
    if (n > 1) int = grouped(t, sep)
    else if (parts[1].length !== 3 || /^0+$/.test(parts[0])) { int = parts[0]; frac = parts[1] }
    else {
      const decimalHere = (sep === "." && locale === "en") || (sep === "," && locale === "vi")
      if (decimalHere) { int = parts[0]; frac = parts[1] }
      else {
        int = parts.join("")
        if (locale === "auto") ambiguous = `"${raw}" được hiểu là ${fmtQ(q(BigInt(int)), "vi")} (dấu "${sep}" phân cách hàng nghìn); nếu là số thập phân, truyền locale="${sep === "." ? "en" : "vi"}"`
      }
    }
  }
  const v = q(BigInt(sign + int + frac), 10n ** BigInt(frac.length))
  return { value: v, ambiguous }
}

// ---------------------------------------------------------------- expression parser
type Tok = { t: "num" | "id" | "op" | "(" | ")" | "sep" | "%"; v: string; pos: number }
const CURRENCY_WORDS = /(?<![\p{L}])(?:vnđ|vnd|đồng|dong|đ|usd|us\$|eur|euro|€|\$)(?![\p{L}])/giu
export type EvalResult = { value: Q; steps: string[]; notes: string[]; trace: Q[] }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const s = src
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    let m: RegExpMatchArray | null
    if ((m = s.slice(i).match(/^\d+(?:[.,]\d+)*/))) { out.push({ t: "num", v: m[0], pos: i }); i += m[0].length; continue }
    if ((m = s.slice(i).match(/^[\p{L}_][\p{L}\p{N}_]*/u))) { out.push({ t: "id", v: m[0], pos: i }); i += m[0].length; continue }
    if ("+-*/^×x·÷:−–".includes(c)) {
      const map: Record<string, string> = { "×": "*", "·": "*", "x": "*", "÷": "/", ":": "/", "−": "-", "–": "-" }
      out.push({ t: "op", v: map[c] ?? c, pos: i }); i++; continue
    }
    if (c === "(" || c === "[") { out.push({ t: "(", v: "(", pos: i }); i++; continue }
    if (c === ")" || c === "]") { out.push({ t: ")", v: ")", pos: i }); i++; continue }
    if (c === ";") { out.push({ t: "sep", v: ";", pos: i }); i++; continue }
    if (c === ",") { out.push({ t: "sep", v: ",", pos: i }); i++; continue }
    if (c === "%") { out.push({ t: "%", v: "%", pos: i }); i++; continue }
    throw new CalcError(`ký tự không hợp lệ "${c}" ở vị trí ${i + 1}`)
  }
  return out
}

const FUNCS = ["sum", "min", "max", "avg", "round", "floor", "ceil", "abs", "tong", "tổng"]
/**
 * Safe evaluator: numbers (vi/en formats), + − × ÷ * / ^, parentheses, postfix % (= ÷ 100), functions
 * sum/min/max/avg/round/floor/ceil/abs (arguments separated by ";" or ", "), named variables from `vars`.
 * Currency words (đồng, VND, USD, $, €…) are ignored. Every operation is recorded as a step.
 */
export function evaluate(expression: string, vars: Record<string, string | number> = {}, locale: "vi" | "en" | "auto" = "auto"): EvalResult {
  const steps: string[] = [], notes: string[] = [], trace: Q[] = []
  const L: Locale = locale === "en" ? "en" : "vi"
  const f = (x: Q) => fmtQ(x, L)
  const cleaned = expression.replace(CURRENCY_WORDS, " ")
  const toks = tokenize(cleaned)
  const V = new Map<string, Q>()
  for (const [k, v] of Object.entries(vars ?? {})) {
    const p = typeof v === "number" ? { value: fromPlain(String(v)) } : parseNumber(String(v).replace(CURRENCY_WORDS, "").replace(/%\s*$/, "").trim(), locale)
    let val = p.value
    if (typeof v === "string" && /%\s*$/.test(v)) val = div(val, HUNDRED)
    if ((p as NumParse).ambiguous) notes.push((p as NumParse).ambiguous!)
    V.set(k.toLowerCase(), val); trace.push(val)
  }
  let i = 0
  const peek = () => toks[i]
  const step = (s: string, v?: Q) => { if (steps.length < 300) steps.push(s); if (v && trace.length < 1000) trace.push(v) }
  function primary(): Q {
    const t = toks[i++]
    if (!t) throw new CalcError("biểu thức kết thúc đột ngột")
    if (t.t === "num") {
      const p = parseNumber(t.v, locale)
      if (p.ambiguous) notes.push(p.ambiguous)
      trace.push(p.value); return p.value
    }
    if (t.t === "(") {
      const v = expr()
      if (toks[i]?.t !== ")") throw new CalcError("thiếu dấu ')'")
      i++
      return v
    }
    if (t.t === "id") {
      const name = t.v.toLowerCase()
      if (toks[i]?.t === "(" && FUNCS.includes(name)) {
        i++
        const args: Q[] = []
        if (toks[i]?.t !== ")") {
          for (;;) {
            args.push(expr())
            if (toks[i]?.t === "sep") { i++; continue }
            break
          }
        }
        if (toks[i]?.t !== ")") throw new CalcError(`thiếu dấu ')' sau đối số của ${t.v}()`)
        i++
        return callFn(name === "tong" || name === "tổng" ? "sum" : name, args)
      }
      if (V.has(name)) return V.get(name)!
      throw new CalcError(`biến chưa khai báo "${t.v}" – truyền giá trị trong vars, VD vars={"${t.v}": "1.000.000"}`)
    }
    if (t.t === "op" && (t.v === "-" || t.v === "+")) { const v = unary(); return t.v === "-" ? neg(v) : v }
    throw new CalcError(`không mong đợi "${t.v}" ở vị trí ${t.pos + 1}`)
  }
  function callFn(name: string, a: Q[]): Q {
    const need = (n: number) => { if (a.length < n) throw new CalcError(`${name}() cần ít nhất ${n} đối số`) }
    let r: Q
    switch (name) {
      case "sum": r = a.reduce(add, ZERO); break
      case "avg": need(1); r = div(a.reduce(add, ZERO), q(a.length)); break
      case "min": need(1); r = a.reduce((x, y) => (cmp(y, x) < 0 ? y : x)); break
      case "max": need(1); r = a.reduce((x, y) => (cmp(y, x) > 0 ? y : x)); break
      case "abs": need(1); r = absQ(a[0]); break
      case "round": case "floor": case "ceil": {
        need(1)
        const dg = a[1] ? Number(a[1].n / a[1].d) : 0
        if (!Number.isInteger(dg) || dg < -12 || dg > 12) throw new CalcError(`${name}(): số chữ số phải là số nguyên −12…12`)
        const mode: RoundMode = name === "round" ? "half-up" : name
        if (dg >= 0) r = roundQ(a[0], dg, mode)
        else { const s = powQ(q(10), q(-dg)); r = mul(roundQ(div(a[0], s), 0, mode), s) }
        break
      }
      default: throw new CalcError(`hàm không hỗ trợ ${name}()`)
    }
    step(`${name}(${a.map(f).join("; ")}) = ${f(r)}`, r)
    return r
  }
  function postfix(): Q {
    let v = primary()
    while (peek()?.t === "%") { i++; const r = div(v, HUNDRED); step(`${f(v)}% = ${f(r)}`, r); v = r }
    return v
  }
  function power(): Q {
    const b = postfix()
    if (peek()?.t === "op" && peek().v === "^") {
      i++
      const e = unary()
      const r = powQ(b, e)
      step(`${f(b)} ^ ${f(e)} = ${f(r)}`, r)
      return r
    }
    return b
  }
  function unary(): Q {
    const t = peek()
    if (t?.t === "op" && (t.v === "-" || t.v === "+")) { i++; const v = unary(); return t.v === "-" ? neg(v) : v }
    return power()
  }
  function term(): Q {
    let v = unary()
    for (;;) {
      const t = peek()
      // implicit "x" multiplication only when x is not a declared variable
      if (t?.t === "id" && t.v.toLowerCase() === "x" && !V.has("x")) { t.t = "op"; t.v = "*" }
      if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
        i++
        const r0 = unary()
        const r = t.v === "*" ? mul(v, r0) : div(v, r0)
        step(`${f(v)} ${t.v === "*" ? "×" : "÷"} ${f(r0)} = ${f(r)}`, r)
        v = r
      } else return v
    }
  }
  function expr(): Q {
    let v = term()
    for (;;) {
      const t = peek()
      if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
        i++
        const r0 = term()
        const r = t.v === "+" ? add(v, r0) : sub(v, r0)
        step(`${f(v)} ${t.v === "+" ? "+" : "−"} ${f(r0)} = ${f(r)}`, r)
        v = r
      } else return v
    }
  }
  if (!toks.length) throw new CalcError("biểu thức rỗng")
  const value = expr()
  if (i < toks.length) throw new CalcError(`thừa "${toks[i].v}" ở vị trí ${toks[i].pos + 1}`)
  return { value, steps, notes: [...new Set(notes)], trace }
}

// ---------------------------------------------------------------- rounding presets
export type Rounding = { digits: number | null; label: string }
/** "vnd" → whole đồng, "usd"/"eur" → 2 decimals, "0".."12" → that many decimals, none → exact. */
export function roundingOf(r?: string | null): Rounding {
  const t = String(r ?? "").trim().toLowerCase()
  if (!t || t === "none" || t === "exact") return { digits: null, label: "không làm tròn (chính xác)" }
  if (t === "vnd" || t === "vnđ" || t === "đồng") return { digits: 0, label: "làm tròn đến đồng (half-up)" }
  if (t === "usd" || t === "eur" || t === "2") return { digits: 2, label: "làm tròn 2 chữ số thập phân (half-up)" }
  if (/^\d{1,2}$/.test(t) && +t <= 12) return { digits: +t, label: `làm tròn ${t} chữ số thập phân (half-up)` }
  throw new CalcError(`round không hợp lệ "${r}" – dùng "vnd", "usd", "eur" hoặc số chữ số thập phân "0"…"12"`)
}
export const currencyDigits = (c: string) => (/^(vnd|vnđ)$/i.test(c) ? 0 : /^(jpy|krw)$/i.test(c) ? 0 : 2)

// ---------------------------------------------------------------- amounts in words
const VI_DIG = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]
function vi3(n: number, full: boolean): string[] {
  const h = Math.floor(n / 100), t = Math.floor(n / 10) % 10, u = n % 10
  const out: string[] = []
  if (h > 0 || full) out.push(VI_DIG[h], "trăm")
  if (t === 0) { if (u > 0 && (h > 0 || full)) out.push("linh") }
  else if (t === 1) out.push("mười")
  else out.push(VI_DIG[t], "mươi")
  if (u > 0) out.push(u === 1 && t >= 2 ? "mốt" : u === 5 && t >= 1 ? "lăm" : VI_DIG[u])
  return out
}
function viBelowBillion(n: bigint, full: boolean): string[] {
  const g = [Number(n / 1_000_000n), Number((n / 1000n) % 1000n), Number(n % 1000n)]
  const names = ["triệu", "nghìn", ""]
  const out: string[] = []
  let started = false
  g.forEach((v, k) => {
    if (v === 0) return
    out.push(...vi3(v, started || full), ...(names[k] ? [names[k]] : []))
    started = true
  })
  return out
}
/** Vietnamese reading of a non-negative integer: mười/mươi, mốt, lăm, linh, nghìn, triệu, tỷ. */
export function viWords(n: bigint): string {
  if (n < 0n) return "âm " + viWords(-n)
  if (n === 0n) return "không"
  const read = (x: bigint, full: boolean): string[] => {
    if (x >= 1_000_000_000n) {
      const hi = x / 1_000_000_000n, lo = x % 1_000_000_000n
      return [...read(hi, full), "tỷ", ...(lo ? viBelowBillion(lo, true) : [])]
    }
    return viBelowBillion(x, full)
  }
  return read(n, false).join(" ")
}
const EN_1 = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
const EN_10 = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
const EN_SCALE = ["", "thousand", "million", "billion", "trillion", "quadrillion", "quintillion"]
function en3(n: number): string {
  const h = Math.floor(n / 100), r = n % 100
  const out: string[] = []
  if (h) out.push(EN_1[h], "hundred")
  if (r) out.push(r < 20 ? EN_1[r] : EN_10[Math.floor(r / 10)] + (r % 10 ? "-" + EN_1[r % 10] : ""))
  return out.join(" ")
}
/** English reading of a non-negative integer (US style, no "and"): "one million five thousand". */
export function enWords(n: bigint): string {
  if (n < 0n) return "minus " + enWords(-n)
  if (n === 0n) return "zero"
  const parts: string[] = []
  let k = 0
  while (n > 0n) {
    const g = Number(n % 1000n)
    if (g) parts.unshift(en3(g) + (EN_SCALE[k] ? " " + EN_SCALE[k] : ""))
    n /= 1000n; k++
    if (k >= EN_SCALE.length && n > 0n) throw new CalcError("số quá lớn để đọc bằng chữ")
  }
  return parts.join(" ")
}
export type Currency = "VND" | "USD" | "EUR"
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
export type MoneyWords = { text: string; value: Q; rounded: boolean; major: bigint; minor: bigint }
/** Amount in words: VND whole đồng ("… đồng chẵn"), USD/EUR with cents ("… đô la Mỹ và … xu" / "… US dollars and … cents"). */
export function moneyWords(amount: Q, currency: Currency, lang: "vi" | "en"): MoneyWords {
  if (amount.n < 0n) throw new CalcError("số tiền âm")
  const digits = currency === "VND" ? 0 : 2
  const v = roundQ(amount, digits)
  const rounded = !eq(v, amount)
  const cents = v.n * 100n / v.d
  const major = digits ? cents / 100n : v.n / v.d
  const minor = digits ? cents % 100n : 0n
  let text: string
  if (lang === "vi") {
    if (currency === "VND") text = `${viWords(major)} đồng chẵn`
    else {
      const [u, s] = currency === "USD" ? ["đô la Mỹ", "xu"] : ["euro", "cent"]
      text = minor ? `${viWords(major)} ${u} và ${viWords(minor)} ${s}` : `${viWords(major)} ${u} chẵn`
    }
  } else {
    const [one, many, subOne, subMany] = currency === "VND" ? ["Vietnam dong", "Vietnam dong", "", ""] : currency === "USD" ? ["US dollar", "US dollars", "cent", "cents"] : ["euro", "euros", "cent", "cents"]
    text = `${enWords(major)} ${major === 1n ? one : many}${minor ? ` and ${enWords(minor)} ${minor === 1n ? subOne : subMany}` : ""}`
  }
  return { text: cap(text), value: v, rounded, major, minor }
}

// ---- words → number (to report what a "bằng chữ" text actually says) ----
const foldVi = (s: string) => s.normalize("NFC").toLowerCase()
const VI_NUM: Record<string, number> = { không: 0, linh: -1, lẻ: -1, một: 1, mốt: 1, hai: 2, ba: 3, bốn: 4, tư: 4, năm: 5, lăm: 5, nhăm: 5, sáu: 6, bảy: 7, bẩy: 7, tám: 8, chín: 9 }
const VI_SKIP = new Set(["đồng", "chẵn", "chẳn", "việt", "nam", "vnd", "vnđ", "đô", "la", "mỹ", "usd", "euro", "eur", "ơ", "rô", "và", "xu", "cent", "cents", "bằng", "chữ", "số", "tiền", "là", "./.", "hoa", "kỳ", "mĩ"])
/** Parse Vietnamese number words (one integer); null if a token is unknown. */
function viParseInt(tokens: string[]): bigint | null {
  let big = 0n, mid = 0n, group = 0n
  let pending: bigint | null = null
  let any = false
  const flush = () => { if (pending != null) { group += pending; pending = null } }
  for (let k = 0; k < tokens.length; k++) {
    const w = tokens[k]
    if (w in VI_NUM) {
      const v = VI_NUM[w]
      if (v < 0) continue // linh / lẻ
      // "năm" right after "mười/mươi" is the units digit; otherwise a new digit
      flush(); pending = BigInt(v); any = true
      continue
    }
    if (w === "mười") { flush(); group += 10n; any = true; continue }
    if (w === "mươi") { group += (pending ?? 1n) * 10n; pending = null; any = true; continue }
    if (w === "trăm") { group += (pending ?? 1n) * 100n; pending = null; any = true; continue }
    if (w === "nghìn" || w === "ngàn") { flush(); mid += (group || 1n) * 1000n; group = 0n; any = true; continue }
    if (w === "triệu") { flush(); mid += (group || 1n) * 1_000_000n; group = 0n; any = true; continue }
    if (w === "tỷ" || w === "tỉ") { flush(); big = (big + mid + (group || (mid || big ? 0n : 1n))) * 1_000_000_000n; mid = 0n; group = 0n; any = true; continue }
    return null
  }
  flush()
  return any ? big + mid + group : null
}
const EN_NUM: Record<string, number> = Object.fromEntries([...EN_1.map((w, k) => [w, k]), ...EN_10.slice(2).map((w, k) => [w, (k + 2) * 10])])
const EN_MULT: Record<string, bigint> = { thousand: 1000n, million: 1_000_000n, billion: 1_000_000_000n, trillion: 1_000_000_000_000n }
function enParseInt(tokens: string[]): bigint | null {
  let total = 0n, group = 0n, any = false
  for (const w of tokens) {
    if (w === "and" || w === "a") continue
    if (w in EN_NUM) { group += BigInt(EN_NUM[w]); any = true; continue }
    if (w === "hundred") { group = (group || 1n) * 100n; any = true; continue }
    if (w in EN_MULT) { total += (group || 1n) * EN_MULT[w]; group = 0n; any = true; continue }
    return null
  }
  return any ? total + group : null
}
/** What amount does a words text say? Splits the main unit and the sub-unit (xu / cent). */
export function parseMoneyWords(text: string, lang: "vi" | "en"): { value: Q | null; unknown?: string } {
  const t = foldVi(text).replace(/[()"“”'’.,;:!?]/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim()
  let tokens = t.split(" ").filter(Boolean)
  if (lang === "vi") {
    const unitAt = tokens.findIndex((w) => ["đồng", "đô", "usd", "euro", "eur", "vnd", "vnđ"].includes(w))
    const main = (unitAt >= 0 ? tokens.slice(0, unitAt) : tokens).filter((w) => !VI_SKIP.has(w))
    const rest = unitAt >= 0 ? tokens.slice(unitAt + 1) : []
    const subAt = rest.findIndex((w) => w === "xu" || w === "cent" || w === "cents")
    const sub = subAt >= 0 ? rest.slice(0, subAt).filter((w) => !VI_SKIP.has(w)) : []
    const bad = [...main, ...sub].find((w) => !(w in VI_NUM) && !["mười", "mươi", "trăm", "nghìn", "ngàn", "triệu", "tỷ", "tỉ"].includes(w))
    if (bad) return { value: null, unknown: bad }
    const a = viParseInt(main)
    if (a == null) return { value: null }
    const c = sub.length ? viParseInt(sub) : 0n
    return { value: add(q(a), q(c ?? 0n, 100n)) }
  }
  tokens = tokens.filter((w) => !["say", "only", "us", "u", "s", "united", "states", "of", "america", "vietnam", "vietnamese", "viet", "nam", "exactly", "total", "amount", "in", "words"].includes(w))
  const unitAt = tokens.findIndex((w) => /^(dollars?|usd|dongs?|vnd|euros?|eur)$/.test(w))
  const main = unitAt >= 0 ? tokens.slice(0, unitAt) : tokens
  const rest = unitAt >= 0 ? tokens.slice(unitAt + 1) : []
  const subAt = rest.findIndex((w) => /^cents?$/.test(w))
  const sub = subAt >= 0 ? rest.slice(0, subAt) : []
  const bad = [...main, ...sub].find((w) => !(w in EN_NUM) && !(w in EN_MULT) && w !== "hundred" && w !== "and" && w !== "a")
  if (bad) return { value: null, unknown: bad }
  const a = enParseInt(main)
  if (a == null) return { value: null }
  const c = sub.length ? enParseInt(sub) : 0n
  return { value: add(q(a), q(c ?? 0n, 100n)) }
}
/** Normalised words for comparing style: ngàn→nghìn, lẻ→linh, tư→bốn, tỉ→tỷ, "chẵn"/"only"/"./." dropped. */
export function normWords(s: string, lang: "vi" | "en") {
  // token-level (JS \b does not see Vietnamese letters as word characters)
  const tok = foldVi(s).replace(/[()"“”'’.,;:!?/]/g, " ").replace(/-/g, " ").split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < tok.length; i++) {
    let w = tok[i]
    if (lang === "vi") {
      if (w === "chẵn" || w === "chẳn") continue
      if ((w === "việt" && tok[i + 1] === "nam" && tok[i - 1] === "đồng") || (w === "nam" && tok[i - 1] === "việt" && tok[i - 2] === "đồng")) continue
      if (w === "hoa" && tok[i + 1] === "kỳ") { out.push("mỹ"); i++; continue }
      w = ({ ngàn: "nghìn", lẻ: "linh", tỉ: "tỷ", bẩy: "bảy" } as Record<string, string>)[w] ?? w
      if (w === "tư" && tok[i - 1] === "mươi") w = "bốn"
    } else {
      if (w === "only" || w === "and" || w === "say") continue
      if ((w === "united" && tok[i + 1] === "states") || (w === "of" && tok[i + 1] === "america") || (w === "america" && tok[i - 1] === "of")) { if (w === "united") { out.push("us"); i++ } continue }
      if (w === "usd") { out.push("us", "dollars"); continue }
      if (w === "vnd") { out.push("vietnam", "dong"); continue }
      if (w === "vietnamese") w = "vietnam"
      w = ({ dollar: "dollars", cent: "cents", euro: "euros", dongs: "dong" } as Record<string, string>)[w] ?? w
    }
    out.push(w)
  }
  return out.join(" ")
}
const UNIT_TOKENS = new Set(["đồng", "đô", "la", "mỹ", "us", "dollars", "euros", "vietnam", "dong", "euro"])
/** normWords without the currency-unit words – compares only how the number itself is written. */
export const wordsKey = (s: string, lang: "vi" | "en") => normWords(s, lang).split(" ").filter((w) => !UNIT_TOKENS.has(w)).join(" ")

// ---------------------------------------------------------------- currency detection
const CUR_USD = /(?<![\p{L}\p{N}])(?:usd|us\$|đô la|đô-la|dollars?)(?![\p{L}])|\$\s?\d/iu
const CUR_EUR = /(?<![\p{L}\p{N}])(?:eur|euros?)(?![\p{L}])|€/iu
const CUR_VND = /(?<![\p{L}\p{N}])(?:vnd|vnđ|đồng|dong)(?![\p{L}])|\dđ(?![\p{L}])|\d\sđ(?![\p{L}])/iu
/** Currency named in a piece of text (first match by priority USD, EUR, VND); "1.000đ" counts as VND. */
export function currencyOf(s: string): Currency | null {
  if (CUR_USD.test(s)) return "USD"
  if (CUR_EUR.test(s)) return "EUR"
  if (CUR_VND.test(s)) return "VND"
  return null
}

// ---------------------------------------------------------------- money amounts in text
/** Money amounts written in a text: "150.000.000 đồng", "65.000 USD", "USD 65,000", "1,5 tỷ đồng", "$19,500". */
const AMT_NUM = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,4})?|\d+(?:[.,]\d+)?`
const SCALE = String.raw`(?:triệu|tỷ|tỉ|nghìn|ngàn|million|billion|thousand)`
const CUR = String.raw`(?:VNĐ|VND|đồng|đ|USD|US\$|đô\s?la(?:\s+Mỹ)?|EUR|euros?|€|US\s+dollars?|dollars?)`
const AMOUNT_SUFFIX = new RegExp(String.raw`(?<![\d.,\p{L}])(${AMT_NUM})\s?(${SCALE})?\s?(${CUR})(?![\p{L}])`, "giu")
const AMOUNT_PREFIX = new RegExp(String.raw`(?<![\p{L}])(US\$|\$|€|USD|EUR|VND|VNĐ)\s?(${AMT_NUM})(?:\s?(${SCALE}))?(?![\d\p{L}])`, "giu")
const SCALES: Record<string, bigint> = { triệu: 1_000_000n, tỷ: 1_000_000_000n, tỉ: 1_000_000_000n, nghìn: 1000n, ngàn: 1000n, million: 1_000_000n, billion: 1_000_000_000n, thousand: 1000n }
export type Amount = { value: Q; currency: Currency; pos: number; end: number; raw: string; num: string; scale: bigint }
const curOf = (s: string): Currency => currencyOf(s.length <= 2 && /đ/i.test(s) ? "1đ" : s) ?? "VND"
const numOrNull = (s: string): Q | null => { try { return parseNumber(s, "auto").value } catch { return null } }
export function amountsIn(text: string): Amount[] {
  const out: Amount[] = []
  for (const m of text.matchAll(AMOUNT_SUFFIX)) {
    let v = numOrNull(m[1]); if (!v) continue
    if (m[2]) v = mul(v, q(SCALES[m[2].toLowerCase()]))
    out.push({ value: v, currency: curOf(m[3]), pos: m.index!, end: m.index! + m[0].length, raw: m[0], num: m[1], scale: m[2] ? SCALES[m[2].toLowerCase()] : 1n })
  }
  for (const m of text.matchAll(AMOUNT_PREFIX)) {
    if (out.some((a) => m.index! >= a.pos && m.index! < a.end)) continue
    let v = numOrNull(m[2]); if (!v) continue
    if (m[3]) v = mul(v, q(SCALES[m[3].toLowerCase()]))
    out.push({ value: v, currency: curOf(m[1]), pos: m.index!, end: m.index! + m[0].length, raw: m[0], num: m[2], scale: m[3] ? SCALES[m[3].toLowerCase()] : 1n })
  }
  return out.sort((a, b) => a.pos - b.pos)
}

// ---------------------------------------------------------------- calc evidence
/** All the written forms of a value, so grounding_check can find it in an answer. */
export function numberForms(v: Q): string[] {
  const out = new Set<string>()
  const p = plainQ(v)
  out.add(p.s)
  for (const L of ["vi", "en"] as const) {
    out.add(fmtQ(v, L).replace(/^≈/, ""))
    for (const dg of [0, 2]) out.add(fmtQ(v, L, dg))
  }
  return [...out]
}
/**
 * Record a calc result as evidence (source "calc", url calc://<tool>/<hash>): inputs, steps and results in
 * vi and en number formats; meta.values holds canonical plain values (exact and rounded) for matching.
 */
export function recordCalc(context: any, toolName: string, lines: string[], values: Q[]) {
  const vals = new Set<string>()
  const forms: string[] = []
  for (const v of values) {
    vals.add(plainQ(v).s)
    for (const dg of [0, 2]) vals.add(plainQ(roundQ(v, dg)).s)
    forms.push(numberForms(v).join(" | "))
  }
  const text = [...lines, "", "Giá trị (vi | en | thuần):", ...forms].join("\n")
  const hash = crypto.createHash("sha1").update(toolName + "\n" + text).digest("hex").slice(0, 12)
  const url = `calc://${toolName}/${hash}`
  recordEvidence(context?.sessionID, { url, title: `Tính toán (${toolName})`, text, source: "calc", meta: { tool: toolName, values: [...vals] } })
  return url
}
