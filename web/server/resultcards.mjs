// Compact result cards inside the step list: calculations (calc_*), exchange rates (fx_*), web pages read (web_read)
// tariff look-ups (tariff_vn / tariff_us / tariff_eu) and company checks (company_lookup / company_verify). Cards are LANGUAGE-NEUTRAL (v: 2): raw numbers as plain
// decimal strings, dates ISO, codes for labels / statuses / sources – the browser formats numbers and dates with
// Intl and renders every label from its locale. Source data (words of an amount, notes of the tool, product
// descriptions, page titles…) is {v, lang} and shown marked as data.
// Source: `state.metadata.ui.card` written by the tool (../.opencode/lib/ui-meta.ts) – else the tool's text output
// is parsed (sessions recorded before). Everything is whitelisted, capped and scrubbed; links must be http(s).
import { scrubText } from "./sanitize.mjs"
import { isoDate, langOf, ocrOf } from "./stepview.mjs"

const CARD_TOOLS = new Set([
  "calc_eval", "calc_interest", "calc_money_words", "calc_check_words", "calc_contract_check", "fx_rate", "fx_convert", "web_read", "tariff_vn", "tariff_us", "tariff_eu",
  "company_lookup", "company_verify",
])
const cap = (s, n) => {
  s = String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f]+/g, " ").trim()
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
const httpUrl = (u) => {
  try {
    const x = new URL(String(u).trim())
    return /^https?:$/.test(x.protocol) ? x.href.slice(0, 500) : ""
  } catch {
    return ""
  }
}
const lineAfter = (lines, re) => {
  const l = lines.find((x) => re.test(x))
  return l ? l.replace(re, "").trim() : ""
}
const data = (v, fallback) => {
  const s = String(v ?? "").trim()
  if (!s) return null
  const lang = langOf(s, fallback)
  return lang ? { v: s, lang } : { v: s }
}

// ---- numbers ---------------------------------------------------------------------------------------------------
/** "1.250.000,5" (vi) → "1250000.5"; "≈765,75" → "765.75". */
export function numVi(s) {
  const m = String(s ?? "").match(/-?[\d.]*\d(?:,\d+)?/)
  if (!m) return ""
  return m[0].replace(/\./g, "").replace(",", ".")
}
/** "1,250,000.50" (en) → "1250000.50". */
export function numEn(s) {
  const m = String(s ?? "").match(/-?[\d,]*\d(?:\.\d+)?/)
  if (!m) return ""
  return m[0].replace(/,/g, "")
}
/** "165.000.000 VND (en: 165,000,000 VND)" → { n: "165000000", cur: "VND" } (the en part wins, it is unambiguous). */
function money(s) {
  s = String(s ?? "")
  const en = s.match(/\(en:\s*([^)]+)\)/)?.[1]
  const n = en ? numEn(en) : numVi(s)
  const cur = (en || s).match(/\b(VND|USD|EUR)\b/)?.[1] || s.match(/\b(VND|USD|EUR)\b/)?.[1]
  return n ? (cur ? { n, cur } : { n }) : null
}
const NUM = /^-?\d{1,30}(?:\.\d{1,20})?$/
const CURS = ["VND", "USD", "EUR"]

// ---- legacy parsers ----------------------------------------------------------------------------------------------
/** "Các bước:\n1. …\n2. …" → [{v, lang}] */
function stepsOf(text) {
  const m = text.match(/Các bước:\n((?:\d+\.\s.*(?:\n|$))+)/)
  return m ? m[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean).slice(0, 12).map((x) => data(x, "vi")) : []
}
function warningsOf(lines) {
  return lines
    .filter((l) => l.startsWith("⚠"))
    .slice(0, 4)
    .map((l) => {
      let m = l.match(/^⚠\s*Mức phạt ([\d.,]+)% vượt ([\d.,]+)%/)
      if (m) return { code: "penalty_cap", rate: numVi(m[1]), cap: numVi(m[2]) }
      m = l.match(/^⚠\s*Lãi suất ([\d.,]+)%\/năm vượt ([\d.,]+)%\/năm/)
      if (m) return { code: "loan_cap", rate: numVi(m[1]), cap: numVi(m[2]) }
      return data(l.replace(/^⚠\s*/, ""), "vi")
    })
}
const notesOf = (lines) => lines.filter((l) => l.startsWith("Lưu ý:")).map((l) => data(l.replace(/^Lưu ý:\s*/, ""), "vi")).slice(0, 3)
const roundingDigits = (label) => {
  if (/đến đồng/.test(label)) return 0
  const m = label.match(/(\d+) (?:chữ số|số lẻ)/)
  return m ? +m[1] : null
}

function legacyCalc(tool, text, input) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  switch (tool) {
    case "calc_eval": {
      const head = lineAfter(lines, /^KẾT QUẢ:\s*/)
      if (!head) return null
      const facts = []
      const rl = lineAfter(lines, /^Làm tròn:\s*/)
      if (rl) {
        const d = roundingDigits(rl)
        if (d != null) facts.push({ k: "rounding", digits: d })
        const un = money(rl.split("giá trị chưa làm tròn")[1] || "")
        if (un) facts.push({ k: "unrounded", ...un })
      }
      const expr = lineAfter(lines, /^Biểu thức:\s*/)
      return { kind: "calc", label: "result", value: money(head.split(" – ")[0]), expression: data(expr.split(" với ")[0]), facts, steps: stepsOf(text), warnings: warningsOf(lines), notes: notesOf(lines) }
    }
    case "calc_interest": {
      const interest = lineAfter(lines, /^TIỀN LÃI:\s*/)
      const penalty = lineAfter(lines, /^TIỀN PHẠT:\s*/)
      if (!interest && !penalty) return null
      const head = interest || penalty
      const value = money(head.split(" – ")[0])
      const facts = []
      const formulaText = lineAfter(lines, /^Công thức:\s*/)
      let formula = ""
      if (penalty) {
        formula = "penalty"
        const m = formulaText.match(/=\s*([\d.,]+)%\s*×\s*([\d.,]+)\s*(VND|USD|EUR)?/)
        if (m) facts.push({ k: "rate", n: numVi(m[1]) }, { k: "base", n: numVi(m[2]), ...(m[3] ? { cur: m[3] } : {}) })
      } else {
        const m = head.match(/–\s*(\d+) ngày, ([\d.,]+)%\/(năm|tháng|ngày), ([\w/]+)(?:, (lãi đơn|nhập gốc hằng tháng|nhập gốc hằng ngày))?/)
        if (m) {
          facts.push({ k: "rate", n: numVi(m[2]), basis: { năm: "year", tháng: "month", ngày: "day" }[m[3]] })
          facts.push({ k: "dayCount", v: m[4] })
          facts.push({ k: "compounding", v: m[5] === "nhập gốc hằng tháng" ? "monthly" : m[5] === "nhập gốc hằng ngày" ? "daily" : "simple" })
        }
        const days = lineAfter(lines, /^Số ngày:\s*/).match(/^(\S+)\s*→\s*(\S+)\s*=\s*(\d+) ngày/)
        if (days) facts.push({ k: "period", from: isoDate(days[1]), to: isoDate(days[2]) }, { k: "days", n: days[3] })
        const kind = lineAfter(lines, /^Loại:\s*/)
        if (kind) facts.push({ k: "kind", v: /lãi vay/.test(kind) ? "loan" : "late_payment" })
        const pr = kind.match(/Số tiền gốc:\s*(.+?)\.?$/)?.[1]
        if (pr && money(pr)) facts.push({ k: "principal", ...money(pr) })
        const res = lineAfter(lines, /^Kết quả chưa làm tròn:\s*/)
        const un = res.match(/^≈?([\d.,]+)\s*(VND|USD|EUR)?/)
        if (un) facts.push({ k: "unrounded", n: numVi(un[1]), ...(un[2] ? { cur: un[2] } : {}) })
        const tot = res.match(/Tổng gốc \+ lãi:\s*([\d.,]+)\s*(VND|USD|EUR)?/)
        if (tot) facts.push({ k: "total", n: numVi(tot[1]), ...(tot[2] ? { cur: tot[2] } : {}) })
        formula = /nhập gốc hằng tháng/.test(formulaText) ? "monthly" : /nhập gốc hằng ngày/.test(formulaText) ? "daily" : /lãi suất\/ngày/.test(formulaText) ? "simple_day" : "simple_year"
      }
      return {
        kind: "calc",
        label: interest ? "interest" : "penalty",
        value,
        formula,
        expression: data(formulaText.replace(/^[^=]*=\s*(?:[^=]*=\s*)?/, "").trim()),
        facts,
        steps: stepsOf(text),
        warnings: warningsOf(lines),
        notes: notesOf(lines),
      }
    }
    case "calc_money_words": {
      const words = lineAfter(lines, /^BẰNG CHỮ:\s*/)
      if (!words) return null
      return { kind: "calc", label: "words", value: money(lineAfter(lines, /^Số tiền:\s*/)), words: data(words, "vi"), facts: [], steps: [], warnings: [], notes: notesOf(lines) }
    }
    case "calc_check_words": {
      const head = lines[0] || ""
      const status = /^KHỚP:/.test(head) ? "ok" : /^KHỚP GIÁ TRỊ/.test(head) ? "style" : /^KHÔNG KHỚP/.test(head) ? "mismatch" : /^KHÔNG ĐỌC ĐƯỢC/.test(head) ? "unread" : ""
      if (!status) return null
      const bn = lineAfter(lines, /^Bằng số:\s*/)
      const value = money(bn.split("→")[1] || bn)
      const words = lineAfter(lines, /^Bằng chữ trong văn bản:\s*/)
      const said = head.match(/đọc ra ([\d.,]+) (VND|USD|EUR)/)
      const wl = langOf(words, "vi")
      return {
        kind: "check",
        status,
        value,
        ...(said ? { said: { n: wl === "en" ? numEn(said[1]) : numVi(said[1]), cur: said[2] } } : {}),
        words: data(words, "vi"),
        standard: data(lineAfter(lines, /^Cách viết chuẩn:\s*/), "vi"),
      }
    }
    case "calc_contract_check": {
      const m = (lines[0] || "").match(/^SOÁT SỐ LIỆU HỢP ĐỒNG:\s*(\d+) lỗi, (\d+) cảnh báo, (\d+) thông tin – (\d+) phép kiểm tra/)
      if (!m) return null
      const section = (head) => {
        const s = text.match(new RegExp(`${head}[^\\n]*:\\n((?:\\s*\\d+\\. .*\\n?(?:\\s+– .*\\n?)*)+)`))
        return s ? [...s[1].matchAll(/^\s*\d+\.\s(.*)$/gm)].map((x) => data(x[1], "vi")).slice(0, 6) : []
      }
      const passed = Number((text.match(/ĐẠT \((\d+)\)/) || [])[1] || 0)
      const tot = (lines[1] || "").match(/giá trị hợp đồng xác định được:\s*([\d.,]+)\s*(VND|USD|EUR)?/)
      return {
        kind: "contract", errors: +m[1], warnings: +m[2], info: +m[3], checks: +m[4], passed,
        ...(tot ? { total: { n: numVi(tot[1]), ...(tot[2] ? { cur: tot[2] } : {}) } } : {}),
        bilingual: /song ngữ/.test(lines[0]),
        errorItems: section("LỖI"), warningItems: section("CẢNH BÁO"),
      }
    }
  }
  return null
}

/** Rate lines of fx_rate / fx_convert (NHNN central, NHNN reference, Vietcombank) → [{src, …numbers, date, url}] */
function fxRates(lines) {
  const out = []
  for (const l of lines) {
    const url = httpUrl(l.match(/Nguồn:\s*(\S+)\s*$/)?.[1] || "")
    let m = l.match(/^Ngân hàng Nhà nước – tỷ giá trung tâm: 1 (\w+) = ([\d.,]+) VND, áp dụng cho ngày (\d{2}\/\d{2}\/\d{4})/)
    if (m) {
      out.push({ src: "sbv_central", cur: m[1], rate: numVi(m[2]), date: isoDate(m[3]), url })
      continue
    }
    m = l.match(/^NHNN \([^)]*\) – tỷ giá tham khảo (\w+) ngày (\d{2}\/\d{2}\/\d{4}): mua ([\d.,]+) – bán ([\d.,]+)/)
    if (m) {
      out.push({ src: "sbv_ref", cur: m[1], buy: numVi(m[3]), sell: numVi(m[4]), date: isoDate(m[2]), url })
      continue
    }
    m = l.match(/^Vietcombank – (\w+)(?: \([^)]*\))? ngày (\d{2}\/\d{2}\/\d{4}).*?: (mua .*)$/)
    if (m) {
      const v = (label) => {
        const x = m[3].match(new RegExp(`${label} ([\\d.,]+)`))
        return x ? numEn(x[1]) : ""
      }
      out.push({ src: "vcb", cur: m[1], cash: v("mua tiền mặt"), transfer: v("mua chuyển khoản"), sell: v("bán"), date: isoDate(m[2]), url })
    }
  }
  return out.slice(0, 4)
}
const fxSrc = (s) =>
  /trung tâm/.test(s) ? "sbv_central" : /Vietcombank.*chuyển khoản/.test(s) ? "vcb_transfer" : /Vietcombank.*tiền mặt/.test(s) ? "vcb_cash" : /Vietcombank.*bán/.test(s) ? "vcb_sell" : /tham khảo/.test(s) ? (/mua/.test(s) ? "sbv_ref_buy" : "sbv_ref_sell") : ""

function legacyFx(tool, text, input) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  const errors = lines.filter((l) => l.startsWith("Không lấy được:")).length
  if (tool === "fx_rate") {
    const head = lines[0]?.match(/^TỶ GIÁ (\S+)\/VND \(tham khảo, ngày ([^)]+)\):/)
    if (!head) return null
    const rates = fxRates(lines)
    return { kind: "fx", mode: "rate", currency: head[1], date: isoDate(head[2]), rates, errors }
  }
  const r = lineAfter(lines, /^QUY ĐỔI:\s*/)
  const m = r.match(/^([\d.,]+) (\w+) = ([\d.,]+) (\w+)(?: \(en: ([\d,.]+)[^)]*\))?\s*theo (.+?) ngày (\d{2}\/\d{2}\/\d{4})/)
  if (!m) return null
  const ways = lines
    .filter((l) => /^\d+\.\s/.test(l))
    .slice(0, 4)
    .map((l) => {
      const w = l.replace(/^\d+\.\s*/, "").match(/^(.+?) ngày (\d{2}\/\d{2}\/\d{4}): .*?× ([\d.,]+) VND\/\w+ = .*?→ ([\d.,]+) \w+(?: \(en: ([\d,.]+)\))?/)
      return w ? { src: fxSrc(w[1]), date: isoDate(w[2]), rate: numVi(w[3]), result: w[5] ? numEn(w[5]) : numVi(w[4]) } : null
    })
    .filter((w) => w && w.src)
  return {
    kind: "fx",
    mode: "convert",
    currency: m[2],
    convert: { amount: numVi(m[1]), fromCur: m[2], toCur: m[4], result: m[5] ? numEn(m[5]) : numVi(m[3]), src: fxSrc(m[6]), date: isoDate(m[7]) },
    ways,
    rates: fxRates(lines),
    errors,
  }
}

function legacyWeb(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  const url = httpUrl(lineAfter(lines, /^Link:\s*/))
  const dom = lineAfter(lines, /^Tên miền:\s*/)
  if (!url || !dom) return null
  const host = dom.split(" – ")[0].trim()
  const official = /NGUỒN CHÍNH THỨC/.test(dom) && !/KHÔNG CHÍNH THỨC/.test(dom)
  const dateRaw = lineAfter(lines, /^Ngày đăng(?: \/ ban hành)?(?: \(theo trang\))?:\s*/)
  const date = isoDate(dateRaw.match(/\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}/)?.[0] || "")
  const chars = lineAfter(lines, /^Ngày truy cập:\s*/).match(/·\s*([\d.]+) ký tự/)?.[1]
  return {
    kind: "web",
    title: data(lineAfter(lines, /^Trang:\s*/)),
    url,
    host,
    official,
    ...(official ? { officialLabel: data((dom.match(/NGUỒN CHÍNH THỨC \(([^)]+)\)/) || [])[1] || "", "vi") } : {}),
    date,
    ...(chars ? { chars: numVi(chars) } : {}),
  }
}

// Tariffs ------------------------------------------------------------------------------------------------------
const pctOf = (raw) => {
  const s = String(raw ?? "").trim()
  if (/^free\b/i.test(s)) return { free: true, pct: "0" }
  const eq = s.match(/\[=\s*([\d.,]+)\s*%\]/)
  if (eq) return { free: Number(numEn(eq[1])) === 0, pct: numEn(eq[1]) }
  const m = s.match(/^([\d.,]+)\s*%$/)
  if (m) {
    const n = /,\d+$/.test(m[1]) && !/\./.test(m[1]) ? numVi(m[1]) : numEn(m[1])
    return { free: Number(n) === 0, pct: n }
  }
  return { free: false, pct: null }
}
const VN_COL = (label) => (/ưu đãi \(MFN\)|^Nhập khẩu ưu đãi$/i.test(label) ? "mfn" : /thông thường/i.test(label) ? "normal" : /\(([A-Z][A-Za-z-]+)\)\s*$/.test(label) ? "fta" : "other")
const EU_COL = (label) =>
  /^Third country duty/i.test(label) ? "third_country" : /^Tariff preference/i.test(label) ? "preference" : /^Low-value consignment/i.test(label) ? "lvc" : /quota/i.test(label) ? "quota" : "other"

function legacyTariff(tool, text, input) {
  const lines = text.split("\n")
  const market = tool === "tariff_vn" ? "vn" : tool === "tariff_us" ? "us" : "eu"
  const code = String(input?.hs ?? "").trim()
  const url = httpUrl(text.match(/https?:\/\/[^\s)]+/)?.[0] || "")
  const out = { kind: "tariff", market, code, url, lines: [], rates: [] }
  if (market === "vn") {
    const y = text.match(/– năm (\d{4})/)?.[1]
    if (y) out.year = y
    for (const l of lines) {
      let m = l.match(/^■ (\S+) – (.*?)(?: \(EN: (.*)\))?(?: · ĐVT: (\S+))?$/)
      if (m) {
        if (out.lines.length < 6) out.lines.push({ code: m[1], desc: data(m[2].replace(/^[-\s]+/, ""), "vi"), ...(m[3] ? { descAlt: data(m[3].replace(/^[-\s]+/, ""), "en") } : {}), ...(m[4] ? { unit: m[4] } : {}) })
        else out.more = (out.more || 0) + 1
        continue
      }
      m = l.match(/^\s+• (.+?): ([^–]+?) – căn cứ (\S+) – áp dụng (\d{2}\/\d{2}\/\d{4})(?: – (\d{2}\/\d{2}\/\d{4}))?/)
      if (m && out.rates.length < 8) {
        const col = VN_COL(m[1])
        const p = pctOf(m[2])
        out.rates.push({
          col, ...(col === "fta" ? { fta: m[1].match(/\(([A-Z][A-Za-z-]+)\)\s*$/)[1] } : {}), ...(col === "other" ? { label: data(m[1], "vi") } : {}),
          raw: data(m[2].trim(), "vi"), ...p, basis: m[3], from: isoDate(m[4]), ...(m[5] ? { to: isoDate(m[5]) } : {}), ...(/⚠ giai đoạn này không phải/.test(l) ? { stale: true } : {}),
        })
      }
    }
  } else if (market === "us") {
    const rel = text.match(/^Bản HTS: ([^·(\n]+)/m)?.[1]?.trim()
    if (rel) out.release = rel
    out.origin = String(input?.country ?? "").slice(0, 40)
    for (const l of lines) {
      const m = l.match(/^\s*(\d{4}\.\d{2}(?:\.\d{2}){0,2}) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?)(?: \[|$)/)
      if (!m) continue
      if (out.lines.length < 6) out.lines.push({ code: m[1], desc: data(m[2], "en"), ...(m[6] && m[6] !== "–" ? { unit: m[6] } : {}) })
      else out.more = (out.more || 0) + 1
      if (!out.rates.length && m[3] !== "–") {
        out.rates.push({ col: "general", raw: data(m[3].replace(/\s*\[=.*\]$/, ""), "en"), ...pctOf(m[3]) })
        if (m[4] !== "–") out.rates.push({ col: "special", raw: data(m[4], "en"), ...pctOf(m[4]) })
        if (m[5] !== "–") out.rates.push({ col: "col2", raw: data(m[5], "en"), ...pctOf(m[5]) })
      }
    }
    const ch99 = text.split(/^Tiêu mục Chương 99/m)[1] || ""
    const active = (ch99.match(/^- 99\d\d\.\d\d\.\d\d(?! \[)/gm) || []).length
    if (active) out.extraDuties = active
  } else {
    const m0 = text.match(/xuất xứ (\S+)(?: \([^)]*\))? → (\S+)/)
    if (m0) {
      out.origin = m0[1]
      out.dest = m0[2]
    }
    let first = true
    for (const l of lines) {
      let m = l.match(/^■ (\S+(?: \S{2}){1,4}) – (.*)$/)
      if (m) {
        if (out.lines.length < 6) out.lines.push({ code: m[1], desc: data(m[2].split(" › ").pop(), "en") })
        else out.more = (out.more || 0) + 1
        if (out.lines.length > 1) first = false
        continue
      }
      m = l.match(/^\s+• \[([^\]]+)\] (.+?) \(([^)]*)\): (.+?)(?: — văn bản (\S+))?(?: \(CELEX \S+\))?$/)
      if (m && first && out.rates.length < 8) {
        const col = EU_COL(m[2])
        const [from, to] = m[3].split("–").map((x) => isoDate(x.trim()))
        const val = m[4].split(" · ")[0].trim()
        out.rates.push({ col, geo: m[1] === "ERGA OMNES" ? "erga_omnes" : "", ...(m[1] !== "ERGA OMNES" ? { geoName: data(m[1], "en") } : {}), ...(col === "other" ? { label: data(m[2], "en") } : {}), raw: data(val.replace(/\s*\[=.*\]$/, ""), "en"), ...pctOf(val), ...(m[5] ? { basis: m[5] } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) })
      }
    }
  }
  return out.lines.length || out.rates.length ? out : null
}

// Company checks ------------------------------------------------------------------------------------------------
// Official entry points (../.opencode/tools/company.ts URLS) – the only links a company card may carry.
const COMPANY_PORTALS = {
  dkkd: "https://dichvuthongtin.dkkd.gov.vn/inf/default.aspx",
  dkkd_egazette: "https://bocaodientu.dkkd.gov.vn/egazette/Forms/Egazette/DefaultAnnouncements.aspx",
  gdt: "https://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp",
}
const OFFICIAL_COMPANY_HOST = /(^|\.)(dkkd\.gov\.vn|dangkykinhdoanh\.gov\.vn|gdt\.gov\.vn)$/
/** Text output recorded before metadata.ui: only the "check it yourself" state is recognised (no company data parsed). */
function legacyCompany(tool, text, input) {
  if (!/yêu cầu mã xác thực – không tra tự động|Không tra tự động được nguồn chính thức/.test(text)) return null
  const code = String(input?.tax_code ?? "").trim()
  const ok = /Kiểm tra định dạng MST: HỢP LỆ/.test(text)
  return {
    kind: "company", mode: tool === "company_verify" ? "verify" : "lookup", status: "manual_required",
    ...(code ? { taxCode: code } : {}), ...(ok ? { checksum: "valid", codeKind: /13 chữ số: đơn vị phụ thuộc/.test(text) ? "branch" : "enterprise" } : /KHÔNG HỢP LỆ/.test(text) ? { checksum: "invalid" } : {}),
    ...(!code && input?.name ? { name: data(String(input.name), "vi") } : {}),
    portals: Object.entries(COMPANY_PORTALS).map(([src, url]) => ({ src, url })),
  }
}
const pick = (v, list) => (list.includes(v) ? v : undefined)
const COMPANY_STATUS = ["active", "temporarily_suspended", "not_at_address", "dissolving", "dissolved", "bankrupt", "revoked", "ceased_pending_closure", "tax_code_closed", "ceased", "other"]
const COMPANY_FIELDS = ["tax_code", "name", "address", "representative", "status"]
// fields the reference sites are cross-checked on (company-core.ts crossCheck)
const CROSS_FIELDS = ["name", "status", "address", "representative", "regDate"]
const SKIP_REASONS = ["robots", "challenge", "not_found", "code_mismatch", "error"]
const DOMAIN_RE = /^[\w.-]{1,120}$/
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/
const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return ""
  }
}
/**
 * Company card (company_lookup / company_verify), built field by field from the tool's card: enumerations checked,
 * portal buttons limited to the official hosts, company facts and compared values as {v, lang} data. Company facts
 * come from what the user pasted from an official page ("user_paste"), from the official result page the user reached
 * by passing its CAPTCHA in the live view ("official", assisted browsing – `assist` {status, source} says how that went)
 * or from reference aggregator sites ("aggregator" – unofficial, shown with a warning and cross-checked between the sites).
 */
function companyCard(c, sc) {
  const d = (v, fallback) => {
    const x = v && typeof v === "object" ? v : typeof v === "string" ? { v } : null
    if (!x || typeof x.v !== "string") return undefined
    const s = sc(cap(x.v, 400))
    if (!s) return undefined
    const lang = ["vi", "en"].includes(x.lang) ? x.lang : langOf(s, fallback)
    return lang ? { v: s, lang } : { v: s }
  }
  const iso = (v) => (typeof v === "string" && ISO_RE.test(v.slice(0, 10)) ? v.slice(0, 10) : undefined)
  // timestamp kept whole (the browser shows it in the viewer's time zone); a bare date stays a date
  const isoDt = (v) => (typeof v === "string" && ISO_DT_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : iso(v))
  const dom = (v, url) => (typeof v === "string" && DOMAIN_RE.test(v) ? v.replace(/^www\./, "") : hostOf(url).replace(/^www\./, ""))
  const out = { kind: "company", mode: c.mode === "verify" ? "verify" : "lookup", status: pick(c.status, ["manual_required", "invalid_code", "personal_id", "parsed"]) || "manual_required" }
  const set = (k, v) => v !== undefined && v !== "" && (out[k] = v)
  set("result", pick(c.result, ["match", "partial", "mismatch", "manual_required"]))
  set("basis", pick(c.basis, ["aggregator", "user_paste", "official"]))
  if (c.assist && typeof c.assist === "object") {
    const st = pick(c.assist.status, ["done", "cancelled", "timeout", "error", "not_found", "unparsed"])
    if (st) out.assist = { status: st, ...(pick(c.assist.source, ["gdt", "dkkd"]) ? { source: c.assist.source } : {}) }
  }
  set("codeKind", pick(c.codeKind, ["enterprise", "branch"]))
  set("checksum", pick(c.checksum, ["valid", "invalid", "format", "branch_zero", "personal_id"]))
  // never echo a personal ID number
  if (out.status !== "personal_id" && out.checksum !== "personal_id" && typeof c.taxCode === "string" && /^[\d\s.-]{1,20}$/.test(c.taxCode.trim())) out.taxCode = c.taxCode.trim()
  set("name", d(c.name, "vi"))
  set("date", iso(c.date))
  if (c.codeMismatch === true) out.codeMismatch = true
  out.portals = (Array.isArray(c.portals) ? c.portals : [])
    .filter((p) => p && COMPANY_PORTALS[p.src] && OFFICIAL_COMPANY_HOST.test(hostOf(p.url)) && httpUrl(p.url))
    .slice(0, 6)
    .map((p) => ({ src: p.src, url: httpUrl(p.url), ...(pick(p.gate, ["captcha", "open", "blocked", "error"]) ? { gate: p.gate } : {}) }))
  if (!out.portals.length) out.portals = Object.entries(COMPANY_PORTALS).map(([src, url]) => ({ src, url }))
  if (c.company && typeof c.company === "object") {
    const co = c.company
    const r = { origin: co.origin === "aggregator" ? "aggregator" : co.origin === "official" && out.basis === "official" ? "official" : "user_paste" }
    for (const [k, fb] of [["name", "vi"], ["nameEn", "en"], ["short"], ["statusText", "vi"], ["legalType", "vi"], ["address", "vi"], ["representative"], ["mainLine", "vi"], ["taxAuthority", "vi"]]) {
      const v = d(co[k], fb)
      if (v) r[k] = v
    }
    if (typeof co.code === "string" && /^[\d-]{1,14}$/.test(co.code)) r.code = co.code
    if (co.status) r.status = pick(co.status, COMPANY_STATUS) || "other"
    if (iso(co.regDate)) r.regDate = iso(co.regDate)
    // fields left empty because the reference sites disagree (values in crossCheck)
    if (Array.isArray(co.conflicts)) {
      const cf = [...new Set(co.conflicts.filter((x) => CROSS_FIELDS.includes(x)))]
      if (cf.length) r.conflicts = cf
    }
    out.company = r
  }
  if (Array.isArray(c.fields))
    out.fields = c.fields
      .filter((f) => f && COMPANY_FIELDS.includes(f.field))
      .slice(0, 8)
      .map((f) => {
        const o = { field: f.field, result: pick(f.result, ["match", "partial", "mismatch", "not_checked"]) || "not_checked" }
        const e = d(f.expected), of = d(f.official)
        if (e) o.expected = e
        if (of) o.official = of
        return o
      })
  // reference (unofficial) sites the facts were read from, and whether they agree with each other per field
  if (Array.isArray(c.sources))
    out.sources = c.sources
      .filter((x) => x && httpUrl(x.url))
      .slice(0, 6)
      .map((x) => {
        const host = hostOf(x.url).replace(/^www\./, "")
        return {
          domain: dom(x.domain, x.url), url: httpUrl(x.url), official: x.official === true && OFFICIAL_COMPANY_HOST.test(host),
          ...(isoDt(x.fetchedAt) ? { fetchedAt: isoDt(x.fetchedAt) } : {}), ...(iso(x.updated) ? { updated: iso(x.updated) } : {}),
        }
      })
  if (Array.isArray(c.crossCheck))
    out.crossCheck = c.crossCheck
      .filter((x) => x && CROSS_FIELDS.includes(x.field) && typeof x.agree === "boolean")
      .slice(0, 8)
      .map((x) => ({
        field: x.field,
        agree: x.agree,
        // {domain, v} per site (older shape: plain strings / {v, lang})
        values: (Array.isArray(x.values) ? x.values : [])
          .slice(0, 4)
          .map((v) => {
            const dv = d(v && typeof v === "object" ? { v: v.v, lang: v.lang } : v, "vi")
            if (!dv) return null
            return v && typeof v.domain === "string" && DOMAIN_RE.test(v.domain) ? { domain: v.domain.replace(/^www\./, ""), ...dv } : dv
          })
          .filter(Boolean),
      }))
  // name search: codes suggested by the reference sites
  if (Array.isArray(c.candidates))
    out.candidates = c.candidates
      .filter((x) => x && typeof x.code === "string" && /^\d{10}(?:-\d{3})?$/.test(x.code))
      .slice(0, 8)
      .map((x) => ({ code: x.code, ...(d(x.name, "vi") ? { name: d(x.name, "vi") } : {}), ...(httpUrl(x.url) ? { url: httpUrl(x.url), domain: dom(x.domain, x.url) } : {}) }))
  // reference sites that were not used (robots.txt, anti-bot page, no data, other company, error)
  if (Array.isArray(c.skipped))
    out.skipped = c.skipped
      .filter((x) => x && typeof x.domain === "string" && DOMAIN_RE.test(x.domain))
      .slice(0, 6)
      .map((x) => ({ domain: x.domain.replace(/^www\./, ""), reason: pick(x.reason, SKIP_REASONS) || "error" }))
  if (typeof c.risks === "number" && Number.isInteger(c.risks) && c.risks >= 0 && c.risks < 100) out.risks = c.risks
  else if (Array.isArray(c.risks)) out.risks = c.risks.slice(0, 8).map((v) => d(v, "vi")).filter(Boolean)
  return out
}

function legacyCard(tool, text, input) {
  if (tool.startsWith("company_")) return legacyCompany(tool, text, input)
  if (tool.startsWith("calc_")) return legacyCalc(tool, text, input)
  if (tool.startsWith("fx_")) return legacyFx(tool, text, input)
  if (tool === "web_read") return legacyWeb(text)
  if (tool.startsWith("tariff_")) return legacyTariff(tool, text, input)
  return null
}

// ---- cleaning ------------------------------------------------------------------------------------------------
const KINDS = new Set(["calc", "check", "contract", "fx", "web", "tariff", "company"])
const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,30}$/
const ISO_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
// Short code-like strings (currencies, columns, sources, HS codes, day counts…): no free text.
const CODE_RE = /^[\p{L}\p{N}_./→ +()%*-]{1,40}$/u
/** Recursively whitelist a card: {v, lang} data objects, numbers, booleans, ISO dates, codes and http(s) urls only. */
function cleanValue(k, v, sc, depth = 0) {
  if (depth > 5 || v == null) return undefined
  if (typeof v === "boolean") return v
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined
  if (typeof v === "string") {
    if (k === "url") return httpUrl(v) || undefined
    if (k === "expression") return sc(cap(v, 300)) || undefined
    if (/^(n|rate|buy|sell|cash|transfer|amount|result|pct|cap|chars)$/.test(k)) return NUM.test(v) ? v : undefined
    if (/^(date|from|to)$/.test(k)) return ISO_RE.test(v) ? v : undefined
    if (k === "host") return /^[\w.-]{1,120}$/.test(v) ? v : undefined
    return CODE_RE.test(v) ? v : undefined
  }
  if (Array.isArray(v)) return v.slice(0, 12).map((x) => cleanValue(k, x, sc, depth + 1)).filter((x) => x !== undefined)
  if (typeof v === "object") {
    // data string {v, lang}
    if (typeof v.v === "string" && Object.keys(v).every((x) => x === "v" || x === "lang")) {
      const s = sc(cap(v.v, 400))
      if (!s) return undefined
      return ["vi", "en"].includes(v.lang) ? { v: s, lang: v.lang } : { v: s }
    }
    const o = {}
    for (const [kk, vv] of Object.entries(v)) {
      if (!SAFE_KEY.test(kk)) continue
      const c = cleanValue(kk, vv, sc, depth + 1)
      if (c !== undefined) o[kk] = c
    }
    return o
  }
  return undefined
}

/** Card for a completed tool part, or null. */
export function resultCard(tool, output, input, locale = "vi", metadata = null) {
  if (!CARD_TOOLS.has(tool) || typeof output !== "string" || !output || /^Lỗi:/.test(output)) return null
  let c = metadata?.ui?.card
  if (!c || typeof c !== "object" || !KINDS.has(c.kind)) {
    try {
      c = legacyCard(tool, output.slice(0, 60_000), input || {})
    } catch {
      c = null
    }
  }
  if (!c || !KINDS.has(c.kind)) return null
  const sc = (s) => scrubText(s, locale)
  if (c.kind === "company") return { ...companyCard(c, sc), v: 2 }
  const out = cleanValue("card", c, sc)
  if (!out || typeof out !== "object") return null
  out.kind = c.kind
  out.v = 2
  // text of a scanned PDF recognised by OCR (web_read / fta_document …): badge on the card
  const ocr = ocrOf(metadata?.ui)
  if (ocr) out.ocr = ocr
  if (out.value && !out.value.n) delete out.value
  return out
}

export { CURS }
