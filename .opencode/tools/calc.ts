// calc_eval / calc_money_words / calc_check_words / calc_interest / calc_contract_check: deterministic
// calculations so the agent never does arithmetic "in its head" when drafting / reviewing contracts or
// answering trade-remedy questions. Exact BigInt-rational arithmetic (../lib/calc-core.ts, no floating point,
// no eval), Vietnamese and English number formats, and every result is recorded as "calc" evidence
// (calc://<tool>/<hash>) so grounding_check accepts the computed figures – and only those – as "tính bằng công cụ".
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import {
  CalcError, HUNDRED, ONE, add, cmp, currencyOf, div, eq, evaluate, fmtQ, fromPlain, moneyWords, mul, parseMoneyWords, parseNumber, wordsKey,
  plainQ, powQ, q, recordCalc, roundQ, roundingOf, sub, type Currency, type Q,
} from "../lib/calc-core.ts"
import { addMonths, diffDays, fmt as fmtDate, nowVN, parseDate, type D } from "../lib/calendar.ts"
import { checkContract, compareBilingual, type Finding } from "../lib/contract-check.ts"
import { detectBilingual, findDocumentForSession, langOf, readMarkdown, readMarkdownEn } from "../lib/doc-store.ts"
import { data, isoDate, withUi } from "../lib/ui-meta.ts"

// Web result card (language-neutral: plain decimal strings, codes, ISO dates; tool notes as Vietnamese data).
const n$ = (v: Q) => plainQ(v).s
const noteData = (xs: string[]) => xs.map((x) => data(x, "vi")).filter(Boolean)

const numArg = () => tool.schema.union([tool.schema.string(), tool.schema.number()])
const both = (v: Q, digits?: number) => `${fmtQ(v, "vi", digits)} (en: ${fmtQ(v, "en", digits)})`
const err = (e: unknown) => `Lỗi: ${e instanceof CalcError ? e.message : (e as Error)?.message ?? String(e)}. Không có kết quả – sửa đầu vào rồi gọi lại (không tự tính thay).`
const CUR_STRIP = /(?<![\p{L}])(?:vnđ|vnd|đồng|đ|usd|us\$|eur|euro|€|\$)(?![\p{L}])/giu
/** "65.000 USD", "1.250.000 đ", 65000 → exact value (+ ambiguity note). */
function money(x: string | number, locale: "vi" | "en" | "auto" = "auto"): { value: Q; note?: string } {
  if (typeof x === "number") return { value: fromPlain(String(x)) }
  const t = String(x).replace(CUR_STRIP, "").replace(/\s+/g, "").trim()
  const p = parseNumber(t, locale)
  // "65.000 USD" / "1.250 đồng" with a currency is an amount: the thousands reading needs no note
  return { value: p.value, note: t !== String(x).replace(/\s+/g, "").trim() ? undefined : p.ambiguous }
}
const pctArg = (x: string | number): Q => (typeof x === "number" ? fromPlain(String(x)) : pctOf(String(x)))
function pctOf(s: string): Q {
  const t = s.replace(/%.*$/, "").trim().replace(",", ".")
  if (!/^\d+(?:\.\d+)?$/.test(t)) throw new CalcError(`tỷ lệ không hợp lệ "${s}" (VD 10 hoặc "0,83")`)
  return fromPlain(t)
}

// ================================================================ calc_eval
const evalTool = tool({
  description:
    "MÁY TÍNH CHÍNH XÁC (số thập phân chính xác, không sai số dấu phẩy động) – BẮT BUỘC dùng cho MỌI phép tính số tiền, tỷ lệ, thuế, tổng, chênh lệch trong câu trả lời hoặc hợp đồng; không tự nhẩm. Biểu thức: + − × ÷ * / ^ (số mũ nguyên), ngoặc, % (10% = 0,1), hàm sum/min/max/avg/round/floor/ceil/abs (đối số cách nhau bằng ';' hoặc ', '), biến đặt tên qua `vars`. Nhận số kiểu Việt ('1.250.000', '12,5%') và kiểu Anh ('1,250,000', '12.5%'); chữ tiền tệ (đồng, VND, USD) được bỏ qua. Trả về kết quả (định dạng vi và en), các bước tính. Làm tròn: round='vnd' (đến đồng, half-up), 'usd'/'eur' (2 số lẻ) hoặc số chữ số thập phân '0'…'12'.",
  args: {
    expression: tool.schema.string().describe("Biểu thức, VD '1.250.000 × 120 × (1 + 10%)', 'round(65.000 × 25.641; 0)', 'mức_thuế × trị_giá'"),
    vars: tool.schema.record(tool.schema.string(), numArg()).optional().describe("Biến dùng trong biểu thức, VD {\"trị_giá\": \"1.500.000 USD\", \"mức_thuế\": \"22,5%\"}"),
    round: tool.schema.string().optional().describe("Làm tròn kết quả: 'vnd' | 'usd' | 'eur' | '0'…'12' (bỏ trống = chính xác)"),
    locale: tool.schema.enum(["vi", "en", "auto"]).optional().describe("Cách đọc số mơ hồ '1.250' / '65,000': vi = dấu ',' là thập phân; en = dấu '.' là thập phân; auto (mặc định) = hiểu là phân cách hàng nghìn và báo lưu ý"),
  },
  async execute({ expression, vars, round, locale }, context) {
    try {
      let V = vars as any
      if (typeof V === "string") V = JSON.parse(V)
      const r = evaluate(expression, V ?? {}, locale ?? "auto")
      const rd = roundingOf(round)
      const final = rd.digits == null ? r.value : roundQ(r.value, rd.digits)
      const exactNote = rd.digits == null && !plainQ(r.value).exact ? ` – số thập phân vô hạn, giá trị chính xác = ${r.value.n}/${r.value.d}; truyền round để làm tròn` : ""
      const out = [
        `KẾT QUẢ: ${both(final, rd.digits ?? undefined)}${exactNote}`,
        `Biểu thức: ${expression}${V && Object.keys(V).length ? ` với ${Object.entries(V).map(([k, v]) => `${k} = ${v}`).join("; ")}` : ""}`,
        rd.digits != null ? `Làm tròn: ${rd.label}; giá trị chưa làm tròn ${both(r.value)}` : "",
        r.steps.length ? `Các bước:\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "",
        r.notes.length ? `Lưu ý: ${r.notes.join("; ")}` : "",
        "Khi trả lời: nêu công thức và kết quả đúng như trên (con số được ghi nhận để grounding_check đối chiếu).",
      ].filter(Boolean)
      recordCalc(context, "eval", out, [...r.trace, r.value, final])
      return withUi(out.join("\n"), {
        card: {
          kind: "calc", label: "result", value: { n: n$(final) }, expression: data(expression),
          facts: rd.digits != null ? [{ k: "rounding", digits: rd.digits }, { k: "unrounded", n: n$(r.value) }] : [],
          steps: r.steps.map((s) => data(s)).filter(Boolean), warnings: [], notes: noteData(r.notes),
        },
      })
    } catch (e) { return err(e) }
  },
})
export { evalTool as eval }

// ================================================================ calc_money_words / calc_check_words
const CURS = ["VND", "USD", "EUR"] as const
export const money_words = tool({
  description:
    "Viết SỐ TIỀN BẰNG CHỮ đúng quy tắc (tiếng Việt: mười/mươi, mốt, lăm, linh, nghìn, triệu, tỷ, '… đồng chẵn'; USD: '… đô la Mỹ và … xu'; tiếng Anh: '… US dollars and … cents'). BẮT BUỘC dùng khi ghi '(Bằng chữ: …)' trong hợp đồng, hóa đơn, thư đòi nợ – không tự viết.",
  args: {
    amount: numArg().describe("Số tiền, VD '1.005.000', '65,000.50', 1500000"),
    currency: tool.schema.enum(CURS).optional().describe("VND (mặc định) | USD | EUR"),
    lang: tool.schema.enum(["vi", "en"]).optional().describe("vi (mặc định) | en"),
  },
  async execute({ amount, currency, lang }, context) {
    try {
      const m = money(amount)
      const cur = (currency ?? currencyOf(String(amount)) ?? "VND") as Currency
      const L = lang ?? "vi"
      const w = moneyWords(m.value, cur, L)
      const out = [
        `BẰNG CHỮ: ${w.text}`,
        `Số tiền: ${fmtQ(w.value, L, cur === "VND" ? 0 : undefined)} ${cur} (${L === "vi" ? "en" : "vi"}: ${fmtQ(w.value, L === "vi" ? "en" : "vi", cur === "VND" ? 0 : undefined)})`,
        w.rounded ? `Lưu ý: đã làm tròn ${cur === "VND" ? "đến đồng" : "đến 2 số lẻ"} (half-up) từ ${fmtQ(m.value, L)}.` : "",
        m.note ? `Lưu ý: ${m.note}` : "",
        L === "vi" ? `Ghi trong văn bản: "${fmtQ(w.value, "vi", cur === "VND" ? 0 : undefined)} ${cur === "VND" ? "đồng" : cur} (Bằng chữ: ${w.text})".` : `In the document: "${cur} ${fmtQ(w.value, "en", cur === "VND" ? 0 : 2)} (in words: ${w.text})".`,
      ].filter(Boolean)
      recordCalc(context, "money_words", out, [w.value])
      return withUi(out.join("\n"), {
        card: { kind: "calc", label: "words", value: { n: n$(w.value), cur }, words: data(w.text, L), facts: [], steps: [], warnings: [], notes: noteData([w.rounded ? `đã làm tròn ${cur === "VND" ? "đến đồng" : "đến 2 số lẻ"} (half-up) từ ${fmtQ(m.value, "vi")}` : "", m.note ?? ""].filter(Boolean)) },
      })
    } catch (e) { return err(e) }
  },
})

export const check_words = tool({
  description:
    "SOÁT SỐ TIỀN BẰNG CHỮ: đối chiếu số tiền bằng số với phần 'bằng chữ' (tiếng Việt hoặc tiếng Anh) – báo KHỚP / KHÔNG KHỚP, số mà phần chữ thực sự đọc ra, và cách viết đúng. Dùng khi rà soát hợp đồng, hóa đơn, chứng từ.",
  args: {
    number_text: numArg().describe("Số tiền bằng số như trong văn bản, VD '1.500.000.000 đồng', 'USD 65,000'"),
    words_text: tool.schema.string().describe("Phần bằng chữ như trong văn bản, VD 'Một tỷ năm trăm triệu đồng chẵn'"),
    currency: tool.schema.enum(CURS).optional().describe("Bỏ trống = tự nhận từ văn bản (mặc định VND)"),
    lang: tool.schema.enum(["vi", "en"]).optional().describe("Ngôn ngữ phần bằng chữ; bỏ trống = tự nhận"),
  },
  async execute({ number_text, words_text, currency, lang }, context) {
    try {
      const m = money(number_text)
      const cur = (currency ?? currencyOf(String(number_text)) ?? currencyOf(words_text) ?? "VND") as Currency
      const L = lang ?? (/[^\x00-\x7f]/.test(words_text) ? "vi" : "en")
      const exp = moneyWords(m.value, cur, L)
      const said = parseMoneyWords(words_text, L)
      const strip = (s: string) => wordsKey(s, L)
      let head: string
      if (!said.value) head = `KHÔNG ĐỌC ĐƯỢC phần bằng chữ${said.unknown ? ` (từ lạ: "${said.unknown}")` : ""} – cách viết đúng: ${exp.text}`
      else if (!eq(said.value, exp.value)) head = `KHÔNG KHỚP: bằng số ${fmtQ(exp.value, L)} ${cur} nhưng phần bằng chữ đọc ra ${fmtQ(said.value, L)} ${cur} (chênh ${fmtQ(sub(said.value, exp.value), L)})`
      else if (strip(words_text) !== strip(exp.text)) head = `KHỚP GIÁ TRỊ (${fmtQ(exp.value, L)} ${cur}) nhưng cách viết khác chuẩn`
      else head = `KHỚP: ${fmtQ(exp.value, L)} ${cur} = "${words_text.trim()}"`
      const out = [head, `Bằng số: ${number_text} → ${both(exp.value)} ${cur}`, `Bằng chữ trong văn bản: ${words_text.trim()}`, `Cách viết chuẩn: ${exp.text}`, m.note ? `Lưu ý: ${m.note}` : ""].filter(Boolean)
      recordCalc(context, "check_words", out, [exp.value, ...(said.value ? [said.value] : [])])
      const status = !said.value ? "unread" : !eq(said.value, exp.value) ? "mismatch" : strip(words_text) !== strip(exp.text) ? "style" : "ok"
      return withUi(out.join("\n"), {
        card: { kind: "check", status, value: { n: n$(exp.value), cur }, ...(said.value && status === "mismatch" ? { said: { n: n$(said.value), cur } } : {}), words: data(words_text, L), standard: data(exp.text, L) },
      })
    } catch (e) { return err(e) }
  },
})

// ================================================================ calc_interest
const nextStep = (law: string, art: string) =>
  `Tiếp theo: nêu căn cứ pháp lý thì tra trước – vbpl_find("${law}") → vbpl_article(url, "${art}") (không ghi tên luật / năm theo trí nhớ); trước khi trả lời chạy grounding_check trên bản nháp (skill citation-check) và ghi "(tính bằng công cụ)" cạnh con số tự tính.`
function days360(a: D, b: D) {
  const d1 = Math.min(a.getUTCDate(), 30)
  const d2 = b.getUTCDate() === 31 && d1 === 30 ? 30 : b.getUTCDate()
  return 360 * (b.getUTCFullYear() - a.getUTCFullYear()) + 30 * (b.getUTCMonth() - a.getUTCMonth()) + (d2 - d1)
}
export const interest = tool({
  description:
    "TÍNH TIỀN LÃI / TIỀN PHẠT chính xác: lãi chậm trả, lãi vay, phạt vi phạm. kind='late_payment' | 'loan': tiền lãi = gốc × lãi suất × số ngày / cơ sở ngày (actual/365, actual/360, 30/360), đơn (mặc định) hoặc nhập gốc hằng tháng / hằng ngày; số ngày tính như clock_calc (không tính ngày đầu, tính ngày cuối). kind='penalty': tiền phạt = tỷ lệ × giá trị phần nghĩa vụ bị vi phạm (breached_value). Cảnh báo khi lãi vay > 20%/năm (gợi ý Điều 468 BLDS 2015) hoặc phạt > 8% (gợi ý Điều 301 LTM 2005) – chỉ là GỢI Ý căn cứ, phải xác minh bằng vbpl_article trước khi nêu. Công cụ chỉ tính với lãi suất được cung cấp (không tự chọn lãi suất thị trường).",
  args: {
    principal: numArg().describe("Số tiền gốc / số tiền chậm trả, VD '65.000 USD', '1.500.000.000'"),
    rate_percent: numArg().describe("Lãi suất / tỷ lệ phạt (%), VD 10 hoặc '0,83'"),
    rate_basis: tool.schema.enum(["year", "month", "day"]).optional().describe("Lãi suất theo năm (mặc định) | tháng | ngày"),
    from: tool.schema.string().optional().describe("Ngày bắt đầu tính (dd/mm/yyyy hoặc yyyy-mm-dd) – VD ngày đến hạn thanh toán; không cần với kind='penalty'"),
    to: tool.schema.string().optional().describe("Ngày kết thúc (dd/mm/yyyy, yyyy-mm-dd, 'hôm nay'); bỏ trống = hôm nay"),
    day_count: tool.schema.enum(["actual/365", "actual/360", "30/360"]).optional().describe("Quy ước đếm ngày (mặc định actual/365)"),
    compounding: tool.schema.enum(["simple", "monthly", "daily"]).optional().describe("simple (mặc định, lãi đơn) | monthly | daily (lãi nhập gốc – chỉ khi hợp đồng thỏa thuận)"),
    kind: tool.schema.enum(["late_payment", "loan", "penalty"]).optional().describe("late_payment (mặc định) | loan | penalty"),
    breached_value: numArg().optional().describe("kind='penalty': giá trị phần nghĩa vụ bị vi phạm (mặc định = principal)"),
    currency: tool.schema.enum(CURS).optional().describe("Đơn vị tiền (bỏ trống = nhận từ principal, mặc định VND): VND làm tròn đến đồng, USD/EUR 2 số lẻ"),
  },
  async execute(a, context) {
    try {
      const kind = a.kind ?? "late_payment"
      const P = money(a.principal)
      const cur = (a.currency ?? currencyOf(String(a.principal)) ?? currencyOf(String(a.breached_value ?? "")) ?? "VND") as Currency
      const dg = cur === "VND" ? 0 : 2
      const r = pctArg(a.rate_percent)
      const rate = div(r, HUNDRED)
      const cf = (v: Q, d?: number) => `${fmtQ(v, "vi", d)} ${cur}`
      const warnings: string[] = [], notes: string[] = []
      if (P.note) notes.push(P.note)
      if (kind === "penalty") {
        const B = a.breached_value != null ? money(a.breached_value) : P
        const pen = mul(B.value, rate)
        const rounded = roundQ(pen, dg)
        if (cmp(r, q(8)) > 0) warnings.push(`⚠ Mức phạt ${fmtQ(r, "vi")}% vượt 8%: Luật Thương mại 2005 Điều 301 – mức phạt (hoặc tổng mức phạt nhiều vi phạm) không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm, trừ trường hợp Điều 266 (dịch vụ giám định). Áp dụng cho hợp đồng thương mại; hợp đồng dân sự theo BLDS 2015 Điều 418 – mức phạt do các bên thỏa thuận, không có mức trần chung (trừ luật khác quy định). GỢI Ý căn cứ – xác minh bằng vbpl_find / vbpl_article trước khi nêu.`)
        else notes.push("Căn cứ gợi ý: LTM 2005 Điều 300–301 (hợp đồng thương mại, ≤ 8%), BLDS 2015 Điều 418 (hợp đồng dân sự) – xác minh bằng vbpl_article.")
        const out = [
          `TIỀN PHẠT: ${cf(rounded, dg)} (en: ${fmtQ(rounded, "en", dg)} ${cur})`,
          `Công thức: tiền phạt = tỷ lệ phạt × giá trị phần nghĩa vụ bị vi phạm = ${fmtQ(r, "vi")}% × ${cf(B.value)} = ${cf(pen)}${eq(pen, rounded) ? "" : ` → làm tròn ${cf(rounded, dg)}`}`,
          ...warnings, ...notes.map((n) => `Lưu ý: ${n}`),
          nextStep("Luật Thương mại 2005", "301"),
        ]
        recordCalc(context, "interest", out, [B.value, r, pen, rounded])
        return withUi(out.join("\n"), {
          card: {
            kind: "calc", label: "penalty", value: { n: n$(rounded), cur }, formula: "penalty",
            facts: [{ k: "rate", n: n$(r) }, { k: "base", n: n$(B.value), cur }, ...(eq(pen, rounded) ? [] : [{ k: "unrounded", n: n$(pen), cur }])],
            steps: [], warnings: cmp(r, q(8)) > 0 ? [{ code: "penalty_cap", rate: n$(r), cap: "8" }] : [], notes: noteData(notes),
          },
        })
      }
      const today = nowVN().date
      const from = parseDate(a.from, today), to = parseDate(a.to, today)
      if (!a.from || !from) return err(new CalcError(`cần ngày bắt đầu hợp lệ \`from\` (dd/mm/yyyy), nhận "${a.from ?? ""}"`))
      if (!to) return err(new CalcError(`ngày kết thúc không hợp lệ "${a.to}"`))
      const dc = a.day_count ?? "actual/365"
      const days = dc === "30/360" ? days360(from, to) : diffDays(from, to)
      if (days < 0) return err(new CalcError(`ngày kết thúc ${fmtDate(to)} trước ngày bắt đầu ${fmtDate(from)}`))
      const denom = dc === "actual/365" ? 365 : 360
      const basis = a.rate_basis ?? "year"
      // annual rate used in the formula (and for the 20 %/năm check)
      const annual = basis === "year" ? rate : basis === "month" ? mul(rate, q(12)) : mul(rate, q(denom))
      const annualPct = mul(annual, HUNDRED)
      const comp = a.compounding ?? "simple"
      let amount: Q, formula: string
      const steps: string[] = []
      if (comp === "simple") {
        amount = basis === "day" ? mul(mul(P.value, rate), q(days)) : div(mul(mul(P.value, annual), q(days)), q(denom))
        formula = basis === "day"
          ? `tiền lãi = gốc × lãi suất/ngày × số ngày = ${cf(P.value)} × ${fmtQ(r, "vi")}% × ${days}`
          : `tiền lãi = gốc × lãi suất năm × số ngày / ${denom} = ${cf(P.value)} × ${fmtQ(annualPct, "vi")}% × ${days} / ${denom}`
        steps.push(`${cf(P.value)} × ${fmtQ(annualPct, "vi")}% = ${cf(mul(P.value, annual))} / năm`, `× ${days} / ${denom} = ${cf(amount)}`)
      } else if (comp === "monthly") {
        let n = 0
        while (addMonths(from, n + 1).getTime() <= to.getTime()) n++
        const mid = addMonths(from, n)
        const rem = dc === "30/360" ? days360(mid, to) : diffDays(mid, to)
        const monthly = div(annual, q(12))
        const A = mul(mul(P.value, powQ(add(ONE, monthly), q(n))), add(ONE, div(mul(annual, q(rem)), q(denom))))
        amount = sub(A, P.value)
        formula = `lãi nhập gốc hằng tháng: gốc × (1 + ${fmtQ(annualPct, "vi")}%/12)^${n} × (1 + ${fmtQ(annualPct, "vi")}% × ${rem}/${denom}) − gốc`
        steps.push(`${n} tháng tròn (${fmtDate(from)} → ${fmtDate(mid)}) + ${rem} ngày lẻ`, `số dư cuối kỳ = ${cf(A)}`, `tiền lãi = ${cf(A)} − ${cf(P.value)} = ${cf(amount)}`)
        notes.push("Lãi nhập gốc chỉ áp dụng khi hợp đồng có thỏa thuận và pháp luật cho phép (tham khảo BLDS 2015 Điều 466, 468 – xác minh bằng vbpl_article).")
      } else {
        const A = mul(P.value, powQ(add(ONE, div(annual, q(denom))), q(days)))
        amount = sub(A, P.value)
        formula = `lãi nhập gốc hằng ngày: gốc × (1 + ${fmtQ(annualPct, "vi")}%/${denom})^${days} − gốc`
        steps.push(`số dư cuối kỳ = ${cf(A)}`, `tiền lãi = ${cf(amount)}`)
        notes.push("Lãi nhập gốc chỉ áp dụng khi hợp đồng có thỏa thuận và pháp luật cho phép – xác minh bằng vbpl_article.")
      }
      const rounded = roundQ(amount, dg)
      if (kind === "loan" && cmp(annualPct, q(20)) > 0) warnings.push(`⚠ Lãi suất ${fmtQ(annualPct, "vi")}%/năm vượt 20%/năm: BLDS 2015 Điều 468 khoản 1 – lãi suất vay do các bên thỏa thuận nhưng không vượt quá 20%/năm của khoản tiền vay, trừ trường hợp luật khác có liên quan quy định khác (VD tổ chức tín dụng); phần vượt không có hiệu lực. GỢI Ý căn cứ – xác minh bằng vbpl_article trước khi nêu.`)
      if (kind === "loan" && cmp(annualPct, q(20)) <= 0) notes.push("Căn cứ gợi ý: BLDS 2015 Điều 468 (trần 20%/năm cho hợp đồng vay, trừ luật khác quy định khác) – xác minh bằng vbpl_article.")
      if (kind === "late_payment") notes.push("Lãi chậm trả: hợp đồng thương mại – LTM 2005 Điều 306 (lãi trên số tiền chậm trả theo lãi suất nợ quá hạn TRUNG BÌNH TRÊN THỊ TRƯỜNG tại thời điểm thanh toán, trừ khi có thỏa thuận khác hoặc pháp luật quy định khác); hợp đồng dân sự – BLDS 2015 Điều 357 (dẫn chiếu Điều 468). Công cụ chỉ tính với lãi suất được cung cấp; lãi suất áp dụng phải có căn cứ (thỏa thuận hoặc nguồn chính thức) – xác minh bằng vbpl_article.")
      const out = [
        `TIỀN LÃI: ${cf(rounded, dg)} (en: ${fmtQ(rounded, "en", dg)} ${cur}) – ${days} ngày, ${fmtQ(r, "vi")}%/${basis === "year" ? "năm" : basis === "month" ? "tháng" : "ngày"}, ${dc}${comp === "simple" ? ", lãi đơn" : comp === "monthly" ? ", nhập gốc hằng tháng" : ", nhập gốc hằng ngày"}`,
        `Loại: ${kind === "loan" ? "lãi vay" : "lãi chậm trả"}. Số tiền gốc: ${cf(P.value)} (en: ${fmtQ(P.value, "en")} ${cur}).`,
        `Số ngày: ${fmtDate(from)} → ${fmtDate(to)} = ${days} ngày${dc === "30/360" ? " (quy ước 30/360)" : " (không tính ngày đầu, tính ngày cuối – như clock_calc)"}.`,
        `Công thức: ${formula}`,
        `Các bước:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        `Kết quả chưa làm tròn: ${cf(amount)}; làm tròn ${dg ? "2 số lẻ" : "đến đồng"} (half-up): ${cf(rounded, dg)}. Tổng gốc + lãi: ${cf(add(P.value, rounded), dg)}.`,
        ...warnings, ...notes.map((n) => `Lưu ý: ${n}`),
        kind === "loan" ? nextStep("Bộ luật Dân sự 2015", "468") : nextStep("Luật Thương mại 2005", "306"),
      ]
      recordCalc(context, "interest", out, [P.value, r, annualPct, q(days), amount, rounded, add(P.value, rounded)])
      const loanCap = kind === "loan" && cmp(annualPct, q(20)) > 0
      return withUi(out.join("\n"), {
        card: {
          kind: "calc", label: "interest", value: { n: n$(rounded), cur },
          formula: comp === "monthly" ? "monthly" : comp === "daily" ? "daily" : basis === "day" ? "simple_day" : "simple_year",
          facts: [
            { k: "rate", n: n$(r), basis }, { k: "dayCount", v: dc }, { k: "compounding", v: comp }, { k: "period", from: isoDate(fmtDate(from)), to: isoDate(fmtDate(to)) },
            { k: "days", n: String(days) }, { k: "kind", v: kind }, { k: "principal", n: n$(P.value), cur }, { k: "unrounded", n: n$(amount), cur }, { k: "total", n: n$(add(P.value, rounded)), cur },
          ],
          steps: steps.map((s) => data(s, "vi")).filter(Boolean),
          warnings: loanCap ? [{ code: "loan_cap", rate: n$(annualPct), cap: "20" }] : [],
          notes: noteData(notes),
        },
      })
    } catch (e) { return err(e) }
  },
})

// ================================================================ calc_contract_check
export const contract_check = tool({
  description:
    "SOÁT SỐ LIỆU HỢP ĐỒNG bằng máy (BẮT BUỘC khi soạn / rà soát / sửa hợp đồng có số tiền – chạy trước khi trả lời và trước document_create / document_edit): bảng hàng hóa (số lượng × đơn giá = thành tiền, cộng các dòng = tổng, thuế GTGT = thuế suất × giá trước thuế, tổng cộng), giá trị hợp đồng ghi trong điều khoản so với bảng, lịch thanh toán (tổng các đợt = 100%, số tiền từng đợt = tỷ lệ × giá trị), tiền đặt cọc, mọi '(Bằng chữ: …)' / '(in words: …)' so với số, mức phạt > 8% và lãi > 20%/năm (gợi ý căn cứ), trộn VND/USD không có điều khoản tỷ giá, số tiền chưa điền '…'. Tài liệu song ngữ: soát cả hai bản và báo số khác nhau giữa bản Việt và bản Anh. Truyền `id` (mã tài liệu đã tạo / tải lên) hoặc `text` (markdown).",
  args: {
    id: tool.schema.string().optional().describe("Mã tài liệu (từ document_create / tệp tải lên)"),
    text: tool.schema.string().optional().describe("Hoặc: nội dung hợp đồng (markdown) cần soát"),
    text_en: tool.schema.string().optional().describe("Tùy chọn: bản tiếng Anh tương ứng với `text` (hợp đồng song ngữ chưa lưu)"),
  },
  async execute({ id, text, text_en }, context) {
    try {
      let vi = "", en = "", title = "", bi = false, single: "vi" | "en" = "vi"
      if (id?.trim()) {
        const meta = findDocumentForSession(context?.sessionID ?? "no-session", id.trim())
        if (!meta) return `Lỗi: không tìm thấy tài liệu trong cuộc trò chuyện này (mã ${id}). Truyền \`text\` nếu có nội dung.`
        title = `"${meta.title}" (mã ${meta.id}, phiên bản ${meta.version})`
        vi = readMarkdown(meta)
        if (meta.language === "bilingual") { en = readMarkdownEn(meta); bi = true }
        else if (meta.language === "en") single = "en"
      } else if (text?.trim()) {
        title = "(nội dung được truyền)"
        if (text_en?.trim()) { vi = text; en = text_en; bi = true }
        else {
          const d = detectBilingual(text)
          if (d) { vi = d.vi; en = d.en; bi = true }
          else { vi = text; single = langOf(text.slice(0, 4000)) === "en" ? "en" : "vi" }
        }
      } else return "Lỗi: cần `id` (mã tài liệu) hoặc `text` (nội dung hợp đồng)."
      const parts = bi ? [checkContract(vi, "vi", "[VI]"), checkContract(en, "en", "[EN]")] : [checkContract(vi, single)]
      const cmpBi = bi ? compareBilingual(vi, en) : null
      const findings: Finding[] = [...parts.flatMap((p) => p.findings), ...(cmpBi?.findings ?? [])]
      const passed = [...parts.flatMap((p) => p.passed), ...(cmpBi?.passed ?? [])]
      const checks = parts.reduce((s, p) => s + p.checks, 0) + (cmpBi?.checks ?? 0)
      const count = (s: string) => findings.filter((f) => f.severity === s).length
      const line = (f: Finding, i: number) => `${i + 1}. [${f.where}] ${f.what}${f.expected ? `\n   – đúng / kỳ vọng: ${f.expected}` : ""}${f.found ? `\n   – văn bản ghi: ${f.found}` : ""}`
      const group = (sev: string, head: string) => { const g = findings.filter((f) => f.severity === sev); return g.length ? `${head}:\n${g.map(line).join("\n")}` : "" }
      const total = parts[0].total
      const out = [
        `SOÁT SỐ LIỆU HỢP ĐỒNG: ${count("lỗi")} lỗi, ${count("cảnh báo")} cảnh báo, ${count("thông tin")} thông tin – ${checks} phép kiểm tra${bi ? " (song ngữ: bản Việt + bản Anh + đối chiếu hai bản)" : ""}.`,
        `Tài liệu: ${title}${total ? ` – giá trị hợp đồng xác định được: ${fmtQ(total, "vi")} ${parts[0].currency ?? ""}` : ""}.`,
        !checks && !findings.length ? "Không tìm thấy bảng giá, số tiền, tỷ lệ thanh toán hay phần bằng chữ để kiểm tra." : "",
        group("lỗi", "LỖI (phải sửa)"),
        group("cảnh báo", "CẢNH BÁO (xem xét; căn cứ pháp lý chỉ là gợi ý – xác minh bằng vbpl_article trước khi nêu)"),
        group("thông tin", "THÔNG TIN"),
        passed.length ? `ĐẠT (${passed.length}):\n${passed.slice(0, 40).map((p) => `- ${p}`).join("\n")}${passed.length > 40 ? `\n- … và ${passed.length - 40} mục khác` : ""}` : "",
        count("lỗi") ? "→ Sửa các lỗi bằng document_edit (cả hai bản nếu song ngữ; số tiền bằng chữ dùng calc_money_words), rồi chạy lại calc_contract_check. Khi trả lời, nêu đúng các con số ở trên; trước khi trả lời chạy grounding_check trên bản nháp." : "→ Khi trả lời, nêu kết quả soát ở trên (con số được ghi nhận để grounding_check đối chiếu); trước khi trả lời chạy grounding_check trên bản nháp.",
      ].filter(Boolean)
      recordCalc(context, "contract_check", out, parts.flatMap((p) => p.values))
      const items = (sev: string) => findings.filter((f) => f.severity === sev).slice(0, 6).map((f) => data(`[${f.where}] ${f.what}`, "vi"))
      return withUi(out.join("\n"), {
        card: {
          kind: "contract", errors: count("lỗi"), warnings: count("cảnh báo"), info: count("thông tin"), checks, passed: passed.length, bilingual: bi,
          ...(total ? { total: { n: n$(total), ...(parts[0].currency ? { cur: parts[0].currency } : {}) } } : {}),
          errorItems: items("lỗi"), warningItems: items("cảnh báo"),
        },
      })
    } catch (e) { return err(e) }
  },
})

