// Engine of calc_contract_check: deterministic checks of the figures in a contract (markdown) – goods / price
// tables, VAT and totals, payment schedule, deposit, amounts in words, penalty / interest rates, currency
// consistency, unfilled amounts, and (bilingual documents) numbers that differ between the VI and EN texts.
// Imported by tools/calc.ts and tests only – this file exports no tools.
import {
  absQ, amountsIn, HUNDRED, ZERO, add, cmp, currencyOf, div, eq, fmtQ, moneyWords, mul, parseMoneyWords, parseNumber, plainQ, q, roundQ, sub, wordsKey,
  type Currency, type Q,
} from "./calc-core.ts"
import { bilingualOutline, labelAt } from "./doc-store.ts"

export type Severity = "lỗi" | "cảnh báo" | "thông tin"
export type Finding = { severity: Severity; where: string; what: string; expected?: string; found?: string }
export type CheckResult = { findings: Finding[]; passed: string[]; checks: number; values: Q[] }
type L = "vi" | "en"

const decimalsOf = (v: Q) => { const s = plainQ(v).s; return s.includes(".") ? s.split(".")[1].length : 0 }

// ---------------------------------------------------------------- amounts in text
const NUM = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,4})?|\d+(?:[.,]\d+)?`
const num = (s: string): Q | null => { try { return parseNumber(s, "auto").value } catch { return null } }
const PCT_RE = /(?<![\d.,])(\d{1,3}(?:[.,]\d{1,4})?)\s?%/g
const pctsIn = (s: string) => [...s.matchAll(PCT_RE)].map((m) => ({ value: pctValue(m[1])!, raw: m[0], pos: m.index! })).filter((p) => p.value)
/** A percentage "12,5" / "12.5" is always decimal (never a thousands separator). */
function pctValue(raw: string): Q | null {
  const t = raw.replace(",", ".")
  const m = t.match(/^(\d+)(?:\.(\d+))?$/)
  return m ? q(BigInt(m[1] + (m[2] ?? "")), 10n ** BigInt((m[2] ?? "").length)) : null
}

// ---------------------------------------------------------------- helpers
function lineIndex(md: string) {
  const starts = [0]
  for (let i = 0; i < md.length; i++) if (md[i] === "\n") starts.push(i + 1)
  return starts
}
const cellsOf = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\*\*/g, "").trim())
const isSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
const PLACEHOLDER = /^(?:[.…_\s●*-]|\[[^\]]*\]|x{3,})+$/i
/** First number in a table cell (currency and units ignored); "placeholder" when it is dots / blanks. */
function cellNumber(c: string): Q | "placeholder" | null {
  const t = c.replace(/\*\*/g, "").trim()
  if (!t) return null
  if (PLACEHOLDER.test(t)) return "placeholder"
  const m = t.match(new RegExp(`(?<![\\d.,])-?(${NUM})`))
  if (!m) return null
  return num(m[1])
}
const fmt = (v: Q, lang: L, cur?: Currency | null) => `${fmtQ(v, lang)}${cur ? " " + cur : ""}`
const same = (expected: Q, found: Q) => eq(roundQ(expected, Math.max(0, decimalsOf(found))), found)

// ---------------------------------------------------------------- the checks
export function checkContract(md: string, lang: L, tag = ""): CheckResult & { total: Q | null; currency: Currency | null } {
  const findings: Finding[] = [], passed: string[] = [], values: Q[] = []
  let checks = 0
  const T = tag ? `${tag} ` : ""
  const where = (pos: number, extra = "") => `${T}${labelAt(md, pos)}${extra}`
  const add1 = (f: Finding) => findings.push(f)
  const lines = md.split("\n")
  const starts = lineIndex(md)
  const amounts = amountsIn(md)
  const docCur = (() => {
    const c: Record<string, number> = {}
    for (const a of amounts) c[a.currency] = (c[a.currency] ?? 0) + 1
    return (Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] as Currency | undefined) ?? null
  })()

  // ---- 1. goods / price tables
  let tableNo = 0
  let tableGrand: Q | null = null, tableSub: Q | null = null, tableCur: Currency | null = null
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !isSep(lines[i + 1] ?? "")) continue
    const head = cellsOf(lines[i])
    let j = i + 2
    const rows: { cells: string[]; line: number }[] = []
    while (j < lines.length && /^\s*\|/.test(lines[j])) { rows.push({ cells: cellsOf(lines[j]), line: j }); j++ }
    i = j - 1
    const col = (re: RegExp, not: number[] = []) => head.findIndex((h, k) => re.test(h) && !not.includes(k))
    const cQty = col(/số\s*lượng|^sl$|khối\s*lượng|quantity|qty/i)
    const cPrice = col(/đơn\s*giá|unit\s*price|^price|giá\s*đơn\s*vị/i)
    const cAmt = col(/thành\s*tiền|amount|giá\s*trị|total|value|tổng|số\s*tiền/i, [cPrice])
    if (cAmt < 0 || (cQty < 0 && cPrice < 0)) continue
    tableNo++
    const hcur = currencyOf(head.join(" ")) ?? currencyOf(rows.map((r) => r.cells.join(" ")).join(" ")) ?? docCur
    let sumRows: Q = ZERO, dataRows = 0, lastBase: Q | null = null, vat: Q | null = null, discount: Q = ZERO
    for (const [ri, r] of rows.entries()) {
      const pos = starts[r.line]
      const label = r.cells.filter((c, k) => k !== cQty && k !== cPrice && k !== cAmt && c && !/^\d+$/.test(c))[0] ?? r.cells[0] ?? ""
      const loc = where(pos, ` – bảng ${tableNo}, dòng ${ri + 1}${label ? ` “${label.slice(0, 50)}”` : ""}`)
      const qty = cQty >= 0 ? cellNumber(r.cells[cQty] ?? "") : null
      const price = cPrice >= 0 ? cellNumber(r.cells[cPrice] ?? "") : null
      const amt = cellNumber(r.cells[cAmt] ?? "")
      const text = r.cells.join(" ")
      const summary = /cộng|tổng|total|subtotal|tạm\s*tính|thuế|vat|gtgt|chiết\s*khấu|giảm\s*giá|discount|bằng\s*chữ|in\s*words/i.test(label || text) && !(qty && qty !== "placeholder" && price && price !== "placeholder")
      if (amt === "placeholder" || qty === "placeholder" || price === "placeholder") {
        add1({ severity: "thông tin", where: loc, what: "số liệu chưa điền (…) – chưa kiểm tra được dòng này" })
        continue
      }
      if (!summary) {
        if (qty && price && amt) {
          checks++
          const exp = mul(qty, price)
          values.push(exp, amt)
          if (same(exp, amt)) passed.push(`${loc}: ${fmtQ(qty, lang)} × ${fmtQ(price, lang)} = ${fmtQ(amt, lang)}`)
          else values.push(absQ(sub(amt, exp))), add1({ severity: "lỗi", where: loc, what: `thành tiền ≠ số lượng × đơn giá (${fmtQ(qty, lang)} × ${fmtQ(price, lang)} = ${fmtQ(exp, lang)}; chênh ${fmtQ(sub(amt, exp), lang)})`, expected: fmt(exp, lang, hcur), found: fmt(amt, lang, hcur) })
          sumRows = add(sumRows, amt); dataRows++
        } else if (amt) { sumRows = add(sumRows, amt); dataRows++ }
        continue
      }
      if (!amt) continue
      if (/bằng\s*chữ|in\s*words/i.test(label)) continue
      if (/thuế|vat|gtgt/i.test(label || text)) {
        const pv = pctsIn(text)[0]
        const base = lastBase ?? sumRows
        if (pv) {
          checks++
          const rate = pctValue(pv.raw.replace(/\s?%$/, ""))!
          const exp = div(mul(base, rate), HUNDRED)
          values.push(exp, amt, base)
          if (same(exp, amt)) passed.push(`${loc}: ${fmtQ(rate, lang)}% × ${fmtQ(base, lang)} = ${fmtQ(amt, lang)}`)
          else add1({ severity: "lỗi", where: loc, what: `tiền thuế ≠ thuế suất × giá trước thuế (${fmtQ(rate, lang)}% × ${fmtQ(base, lang)} = ${fmtQ(exp, lang)})`, expected: fmt(roundQ(exp, decimalsOf(amt)), lang, hcur), found: fmt(amt, lang, hcur) })
        }
        vat = amt
        if (!lastBase) lastBase = base
        continue
      }
      if (/chiết\s*khấu|giảm\s*giá|discount/i.test(label || text)) { discount = add(discount, amt); continue }
      // a total row: before any VAT line = subtotal of the rows; after VAT = subtotal + VAT − discount
      checks++
      const isGrand = vat != null || /tổng\s*cộng|grand|tổng\s*thanh\s*toán|tổng\s*giá\s*trị|total\s*(?:contract\s*)?(?:value|price|amount)/i.test(label) && lastBase != null
      const exp = vat != null ? sub(add(lastBase ?? sumRows, vat), discount) : sub(sumRows, discount)
      values.push(exp, amt)
      const what = vat != null ? `tổng cộng ≠ giá trước thuế + thuế${discount.n ? " − chiết khấu" : ""} (${fmtQ(lastBase ?? sumRows, lang)} + ${fmtQ(vat, lang)}${discount.n ? " − " + fmtQ(discount, lang) : ""} = ${fmtQ(exp, lang)})` : `tổng ≠ cộng các dòng hàng (${dataRows} dòng, cộng = ${fmtQ(exp, lang)})`
      if (same(exp, amt)) passed.push(`${loc}: ${what.replace(/^[^(]*\(/, "(").replace(/\)$/, ")")} ✓`)
      else values.push(absQ(sub(amt, exp))), add1({ severity: "lỗi", where: loc, what: `${what}; chênh ${fmtQ(sub(amt, exp), lang)}`, expected: fmt(exp, lang, hcur), found: fmt(amt, lang, hcur) })
      if (vat != null || isGrand) tableGrand = amt
      else { lastBase = amt; tableSub = amt; if (!tableGrand) tableGrand = amt }
    }
    if (tableGrand == null && dataRows) tableGrand = sumRows
    if (tableSub == null && dataRows) tableSub = lastBase ?? sumRows
    tableCur = hcur
  }

  // ---- 2. contract value stated in the text
  const VALUE_RE = /(tổng\s+giá\s+trị\s+(?:của\s+)?hợp\s+đồng|giá\s+trị\s+(?:của\s+)?hợp\s+đồng|tổng\s+giá\s+trị|tổng\s+số\s+tiền|total\s+contract\s+(?:value|price|amount)|contract\s+(?:value|price)|total\s+(?:value|price|amount))/i
  let total: Q | null = null, totalCur: Currency | null = null, totalPos = -1
  for (const a of amounts) {
    const lineStart = md.lastIndexOf("\n", a.pos) + 1
    const before = md.slice(Math.max(lineStart, a.pos - 160), a.pos)
    if (!VALUE_RE.test(before) || /^\s*\|/.test(md.slice(lineStart, lineStart + 3))) continue
    total = a.value; totalCur = a.currency; totalPos = a.pos
    break
  }
  if (total && tableGrand) {
    checks++
    values.push(total, tableGrand)
    if (eq(total, tableGrand)) passed.push(`${where(totalPos)}: giá trị hợp đồng ${fmtQ(total, lang)} = tổng bảng giá`)
    else if (tableSub && eq(total, tableSub)) add1({ severity: "thông tin", where: where(totalPos), what: `giá trị hợp đồng ${fmtQ(total, lang)} bằng tổng TRƯỚC thuế của bảng giá (tổng sau thuế ${fmtQ(tableGrand, lang)}) – nên ghi rõ đã/chưa gồm thuế GTGT` })
    else add1({ severity: "lỗi", where: where(totalPos), what: "giá trị hợp đồng ghi trong điều khoản khác tổng của bảng giá", expected: fmt(tableGrand, lang, tableCur), found: fmt(total, lang, totalCur) })
  }
  const contractTotal = total ?? tableGrand
  const contractCur = totalCur ?? tableCur ?? docCur

  // ---- 3. payment schedule and deposit
  const INST = /đợt|lần\s+(?:thứ\s+)?(?:\d|một|hai|ba|bốn|cuối)|tạm\s+ứng|ứng\s+trước|installment|instalment|tranche|advance\s+payment|(?:first|second|third|final)\s+payment|balance\s+payment/i
  const DEPOSIT = /đặt\s+cọc|tiền\s+cọc|ký\s+quỹ|bảo\s+đảm\s+thực\s+hiện|deposit|performance\s+(?:security|bond|guarantee)/i
  const inst: { pct: Q; amt?: Amount; pos: number; line: string }[] = []
  lines.forEach((ln, k) => {
    const pos = starts[k]
    const lab = labelAt(md, pos)
    const payCtx = /thanh\s+toán|payment/i.test(ln) || /thanh\s*toán|payment/i.test(headingOf(md, pos))
    const pct = pctsIn(ln)[0]
    if (!pct || /lãi|interest|phạt|penalty|thuế|vat|tax/i.test(ln)) return
    const amt = amountsIn(ln)[0]
    const pv = pctValue(pct.raw.replace(/\s?%$/, ""))!
    if (DEPOSIT.test(ln) && !INST.test(ln)) {
      if (amt && contractTotal) {
        checks++
        const exp = div(mul(contractTotal, pv), HUNDRED)
        values.push(exp, amt.value)
        if (same(exp, amt.value)) passed.push(`${T}${lab}: tiền đặt cọc/bảo đảm ${fmtQ(pv, lang)}% × ${fmtQ(contractTotal, lang)} = ${fmtQ(amt.value, lang)}`)
        else add1({ severity: "lỗi", where: `${T}${lab}`, what: `số tiền đặt cọc/bảo đảm không khớp tỷ lệ ${fmtQ(pv, lang)}% × giá trị hợp đồng ${fmtQ(contractTotal, lang)}`, expected: fmt(roundQ(exp, decimalsOf(amt.value)), lang, amt.currency), found: fmt(amt.value, lang, amt.currency) })
      }
      return
    }
    if (payCtx && INST.test(ln)) inst.push({ pct: pv, amt, pos, line: ln })
  })
  if (inst.length >= 2) {
    checks++
    const s = inst.reduce((a, x) => add(a, x.pct), ZERO)
    values.push(s)
    const loc = `${T}${labelAt(md, inst[0].pos)}`
    if (eq(s, HUNDRED)) passed.push(`${loc}: các đợt thanh toán ${inst.map((x) => fmtQ(x.pct, lang) + "%").join(" + ")} = 100%`)
    else add1({ severity: "lỗi", where: loc, what: `tổng tỷ lệ các đợt thanh toán = ${inst.map((x) => fmtQ(x.pct, lang) + "%").join(" + ")} = ${fmtQ(s, lang)}% (phải bằng 100%)`, expected: "100%", found: `${fmtQ(s, lang)}%` })
  }
  if (contractTotal) for (const x of inst) {
    if (!x.amt) continue
    checks++
    const exp = div(mul(contractTotal, x.pct), HUNDRED)
    values.push(exp, x.amt.value)
    const loc = `${T}${labelAt(md, x.pos)}`
    if (same(exp, x.amt.value)) passed.push(`${loc}: đợt ${fmtQ(x.pct, lang)}% × ${fmtQ(contractTotal, lang)} = ${fmtQ(x.amt.value, lang)}`)
    else add1({ severity: "lỗi", where: loc, what: `số tiền đợt thanh toán không khớp ${fmtQ(x.pct, lang)}% × giá trị hợp đồng ${fmtQ(contractTotal, lang)}`, expected: fmt(roundQ(exp, decimalsOf(x.amt.value)), lang, x.amt.currency), found: fmt(x.amt.value, lang, x.amt.currency) })
  }
  if (contractTotal && inst.length >= 2 && inst.every((x) => x.amt)) {
    checks++
    const s = inst.reduce((a, x) => add(a, x.amt!.value), ZERO)
    values.push(s)
    if (!eq(s, contractTotal)) add1({ severity: "lỗi", where: `${T}${labelAt(md, inst[0].pos)}`, what: "tổng số tiền các đợt thanh toán khác giá trị hợp đồng", expected: fmt(contractTotal, lang, contractCur), found: fmt(s, lang, contractCur) })
  }

  // ---- 4. amounts in words
  const WORDS_RE = /(\()?\s*(?:\*\*|_)?(?:bằng\s+chữ|viết\s+bằng\s+chữ|số\s+tiền\s+bằng\s+chữ|in\s+words|say)(?:\*\*|_)?\s*[:：]?\s*(?:\*\*|_)?([^\n)|]*)/giu
  for (const m of md.matchAll(WORDS_RE)) {
    const pos = m.index!
    let words = m[2].replace(/(\*\*|_)+/g, "").replace(/\s*\.\/\.\s*$/, "").replace(/[.;,\s]+$/, "").trim()
    if (!m[1]) words = words.replace(/\)\s*$/, "")
    const loc = where(pos)
    if (!words || PLACEHOLDER.test(words)) { add1({ severity: "thông tin", where: loc, what: "số tiền bằng chữ chưa điền (…)" }); continue }
    const wl: L = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹáàãéèíìóòõúùýđ]/i.test(words) ? "vi" : "en"
    // the amount this refers to: the last amount (or large number) before it, within ~400 characters
    const back = md.slice(Math.max(0, pos - 400), pos)
    const prev = amountsIn(back).pop()
    let value: Q | null = prev?.value ?? null
    let cur: Currency | null = prev?.currency ?? null
    if (!value) {
      const nums = [...back.matchAll(new RegExp(`(?<![\\d.,])(\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?)(?![\\d])`, "g"))]
      const last = nums.pop()
      if (last) value = num(last[1])
    }
    if (/[…]|\.{3,}/.test(back.slice(-60)) && !prev) { add1({ severity: "thông tin", where: loc, what: "số tiền bằng số chưa điền (…) – chưa đối chiếu được phần bằng chữ" }); continue }
    if (!value) { add1({ severity: "cảnh báo", where: loc, what: `không xác định được số tiền bằng số tương ứng với "bằng chữ: ${words.slice(0, 80)}"` }); continue }
    cur = cur ?? currencyOf(words) ?? (wl === "vi" && /đồng/i.test(words) ? "VND" : null) ?? contractCur ?? "VND"
    checks++
    const said = parseMoneyWords(words, wl)
    let expWords: string
    try { expWords = moneyWords(value, cur, wl).text } catch (e) { expWords = String((e as Error).message) }
    values.push(value)
    if (!said.value) { add1({ severity: "cảnh báo", where: loc, what: `không đọc được phần bằng chữ "${words.slice(0, 100)}"${said.unknown ? ` (từ lạ: "${said.unknown}")` : ""}`, expected: expWords }); continue }
    const v2 = cur === "VND" ? roundQ(value, 0) : roundQ(value, 2)
    if (!eq(said.value, v2)) add1({ severity: "lỗi", where: loc, what: `số tiền bằng chữ không khớp bằng số ${fmt(value, lang, cur)} (phần bằng chữ đọc ra ${fmtQ(said.value, lang)})`, expected: expWords, found: words })
    else if (wordsKey(words, wl) !== wordsKey(expWords, wl))
      add1({ severity: "cảnh báo", where: loc, what: `bằng chữ khớp giá trị ${fmtQ(value, lang)} nhưng cách viết khác chuẩn`, expected: expWords, found: words })
    else passed.push(`${loc}: bằng chữ khớp ${fmt(value, lang, cur)}`)
  }

  // ---- 5. penalty and interest rates
  // per sentence: "phạt 12% … . Chậm thanh toán chịu lãi 1,5%/tháng" are two different checks
  const sentences: { s: string; pos: number }[] = []
  lines.forEach((l, k) => { let off = 0; for (const part of l.split(/(?<=[.;])\s+(?=\p{Lu}|\d)/u)) { const at = l.indexOf(part, off); sentences.push({ s: part, pos: starts[k] + Math.max(0, at) }); off = Math.max(0, at) + part.length } })
  sentences.forEach(({ s: ln, pos }) => {
    const pcts = pctsIn(ln)
    if (!pcts.length) return
    const loc = where(pos)
    if (/phạt|penalt|liquidated\s+damages/i.test(ln) && !/lãi|interest/i.test(ln)) {
      for (const p of pcts) {
        const v = pctValue(p.raw.replace(/\s?%$/, ""))!
        const perDay = /%\s*(?:\/|mỗi|một|cho\s+mỗi|per|each|a)\s*(?:ngày|day|tuần|week)/i.test(ln.slice(p.pos, p.pos + 40))
        checks++
        values.push(v)
        if (cmp(v, q(8)) > 0) add1({ severity: "cảnh báo", where: loc, what: `mức phạt ${fmtQ(v, lang)}% vượt 8% – Luật Thương mại 2005 Điều 301 giới hạn tổng mức phạt ≤ 8% giá trị phần nghĩa vụ bị vi phạm (hợp đồng thương mại; ngoại lệ Điều 266 – giám định; hợp đồng dân sự theo BLDS 2015 Điều 418 không giới hạn). Gợi ý căn cứ – xác minh bằng vbpl_article trước khi nêu.` })
        else if (perDay && !/tối\s+đa|không\s+quá|tổng\s+mức|maximum|cap|not\s+exceed|up\s+to/i.test(ln)) add1({ severity: "cảnh báo", where: loc, what: `phạt ${fmtQ(v, lang)}% theo ngày/tuần không có mức trần – cộng dồn có thể vượt giới hạn 8% (Điều 301 LTM 2005, cần xác minh bằng vbpl_article); nên thêm "tổng mức phạt không quá 8%"` })
        else passed.push(`${loc}: mức phạt ${fmtQ(v, lang)}% ≤ 8%`)
      }
    }
    if (/lãi|interest/i.test(ln)) {
      for (const p of pcts) {
        const tail = ln.slice(p.pos, p.pos + 30)
        const v = pctValue(p.raw.replace(/\s?%$/, ""))!
        const mult = /%\s*(?:\/|một|mỗi|per|a)\s*(?:năm|year|annum)|p\.?\s?a\.?/i.test(tail) ? 1n : /%\s*(?:\/|một|mỗi|per|a)\s*(?:tháng|month)/i.test(tail) ? 12n : /%\s*(?:\/|một|mỗi|per|a)\s*(?:ngày|day)/i.test(tail) ? 365n : 0n
        if (!mult) continue
        checks++
        const annual = mul(v, q(mult))
        values.push(annual)
        if (cmp(annual, q(20)) > 0) add1({ severity: "cảnh báo", where: loc, what: `lãi suất ${fmtQ(v, lang)}%${mult === 1n ? "/năm" : mult === 12n ? "/tháng" : "/ngày"} (= ${fmtQ(annual, lang)}%/năm) vượt 20%/năm – BLDS 2015 Điều 468 khoản 1 (lãi suất vay; trừ luật khác quy định khác); lãi chậm trả trong hợp đồng thương mại theo LTM 2005 Điều 306 (lãi suất nợ quá hạn trung bình trên thị trường, trừ khi có thỏa thuận khác). Gợi ý căn cứ – xác minh bằng vbpl_article.` })
        else passed.push(`${loc}: lãi suất ${fmtQ(annual, lang)}%/năm ≤ 20%/năm`)
      }
    }
  })

  // ---- 6. currency consistency, unfilled amounts
  const curs = [...new Set(amounts.map((a) => a.currency))]
  if (curs.length > 1) {
    checks++
    if (!/tỷ\s+giá|quy\s+đổi|exchange\s+rate|conversion\s+rate|converted/i.test(md)) add1({ severity: "cảnh báo", where: `${T}toàn văn`, what: `hợp đồng dùng nhiều đồng tiền (${curs.join(", ")}) nhưng không có điều khoản tỷ giá / quy đổi (tỷ giá nào, ngân hàng nào, thời điểm nào)` })
    else passed.push(`${T}toàn văn: nhiều đồng tiền (${curs.join(", ")}) và có điều khoản tỷ giá`)
  }
  const PH = /(?:…|\.{3,}|_{3,}|\[\s*[….●_ ]*\s*\])\s?(?:đồng|VNĐ|VND|USD|EUR|US\$)(?![\p{L}])|(?:USD|VND|US\$|\$)\s?(?:…|\.{3,}|_{3,})/giu
  for (const m of md.matchAll(PH)) add1({ severity: "thông tin", where: where(m.index!), what: `số tiền chưa điền ("${m[0].trim()}")` })

  return { findings, passed, checks, values, total: contractTotal, currency: contractCur }
}

function headingOf(md: string, pos: number) {
  const before = md.slice(0, pos)
  const m = [...before.matchAll(/^(?:#{1,6}\s+|\*\*)?((?:điều|article)\s+\d+[^\n]*)$/gimu)].pop()
  return m?.[1] ?? ""
}

/** Numbers that differ between the aligned VI and EN sections of a bilingual contract. */
export function compareBilingual(vi: string, en: string): { findings: Finding[]; checks: number; passed: string[] } {
  const findings: Finding[] = [], passed: string[] = []
  let checks = 0
  const pairs = bilingualOutline(vi, en)
  type Item = { k: string; show: string }
  const money = (t: string, L: L): Item[] => amountsIn(t).map((a) => ({ k: `${plainQ(a.value).s} ${a.currency}`, show: `${fmtQ(a.value, L)} ${a.currency}` }))
  const pct = (t: string, L: L): Item[] => pctsIn(t).map((x) => ({ k: `${plainQ(x.value).s}%`, show: `${fmtQ(x.value, L)}%` }))
  const diff = (x: Item[], y: Item[]) => { const c = y.map((v) => v.k); return x.filter((v) => { const i = c.indexOf(v.k); if (i >= 0) { c.splice(i, 1); return false } return true }) }
  for (const p of pairs) {
    if (!p.vi || !p.en) continue
    const A = [...money(p.vi.text, "vi"), ...pct(p.vi.text, "vi")], B = [...money(p.en.text, "en"), ...pct(p.en.text, "en")]
    if (!A.length && !B.length) continue
    checks++
    const onlyVi = diff(A, B), onlyEn = diff(B, A)
    if (onlyVi.length || onlyEn.length)
      findings.push({ severity: "lỗi", where: `${p.label} (VI ↔ EN)`, what: `số liệu bản tiếng Việt và bản tiếng Anh không khớp – chỉ bản VI có: ${onlyVi.map((x) => x.show).join(", ") || "(không)"}; chỉ bản EN có: ${onlyEn.map((x) => x.show).join(", ") || "(không)"}` })
    else passed.push(`${p.label}: số liệu VI = EN (${A.length} số)`)
  }
  return { findings, checks, passed }
}
