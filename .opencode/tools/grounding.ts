// grounding_check: computes answer confidence from evidence instead of the model's self-assessment.
// Every link, verbatim quote, figure (percentages, rates) and identifier (số hiệu văn bản, số vụ việc,
// FR Doc, CELEX, ký hiệu thông báo WTO) in a draft answer must appear in what the lookup tools actually
// fetched in THIS session (see ../lib/evidence.ts). Unsupported items are listed so the agent can fix or
// drop them, and the resulting level (cao / trung bình / thấp) is what the answer must report.
// Computed figures: a percentage / money amount that appears in no source is still accepted when a calc_* /
// fx_convert tool computed it in this session (evidence source "calc") – reported as "tính bằng công cụ".
// Money amounts ("65.000 USD", "150.000.000 đồng") are claims too: accepted from opened sources, calc
// evidence, or verbatim from the user's own document (evidence source "artifact"); placeholders ("… đồng")
// are not claims.
// OCR evidence (meta.ocr = true: text recognised from a scanned PDF by ../lib/pdf-ocr.ts) supports claims, but a claim
// found ONLY in OCR text is "supported-but-OCR": level at most trung bình (why code "ocr_evidence").
import { tool } from "../lib/ui-meta.ts" // = @opencode-ai/plugin tool + plain-text results outside the AI runtime
import { amountsIn, fromPlain, fmtQ, plainQ, q, roundQ, div, eq, type Q } from "../lib/calc-core.ts"
import { loadEvidence, recordEvidence } from "../lib/evidence.ts"
import { canonicalKey } from "../lib/official-sources.ts"
import { withUi } from "../lib/ui-meta.ts"

const norm = (s: string) =>
  s.normalize("NFC").replace(/[“”«»„"]/g, '"').replace(/[‘’`']/g, "'").replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim().toLowerCase()
const stripUrl = (u: string) => u.replace(/[)>\].,;:!?'"»]+$/, "")
const baseUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[#].*$/, "").replace(/\/$/, "")

// Official sources whose pages are fetched by our tools; links elsewhere cannot be checked automatically.
const CHECKABLE = /vbpl\.vn|trav\.gov\.vn|federalregister\.gov|govinfo\.gov|eur-lex\.europa\.eu|publications\.europa\.eu|epingalert\.org|wto\.org|trungtamwto\.vn|toaan\.gov\.vn|sbv\.gov\.vn|vietcombank\.com\.vn|customs\.gov\.vn|hts\.usitc\.gov|trade\.ec\.europa\.eu\/access-to-markets/

// English answers quote the Vietnamese text verbatim, then "(unofficial translation: …)". The translation
// is not a verbatim quote of any source: it is cut out before quotes are extracted (the Vietnamese quote
// itself is still checked). Balanced parentheses, so "(… Article 301 (penalty) …)" is handled.
const TRANSLATION_OPEN = /\(\s*(?:unofficial\s+(?:English\s+)?translation|(?:bản\s+)?dịch\s+không\s+chính\s+thức|bản\s+dịch\s+tham\s+khảo|informal\s+translation)\s*:/giu
function splitTranslations(answer: string): { text: string; translations: string[] } {
  const translations: string[] = []
  let out = "", last = 0
  for (const m of answer.matchAll(TRANSLATION_OPEN)) {
    const start = m.index as number
    if (start < last) continue
    let depth = 0, end = -1
    for (let i = start; i < answer.length && i < start + 3000; i++) {
      if (answer[i] === "(") depth++
      else if (answer[i] === ")" && --depth === 0) { end = i; break }
    }
    if (end < 0) end = Math.min(answer.length, answer.indexOf("\n\n", start) < 0 ? answer.length : answer.indexOf("\n\n", start)) - 1
    translations.push(answer.slice(start + m[0].length, end).trim())
    out += answer.slice(last, start) + " "
    last = end + 1
  }
  return { text: out + answer.slice(last), translations }
}

// Markdown / labels the model adds around a verbatim passage are not part of the source text:
// "**Khoản 1:** Bên bán …", "- …", "[Điều 5](https://…)", "*nghiêng*", trailing "(Nguồn: …)".
function cleanQuote(raw: string) {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/\s*\((?:Nguồn|Source|theo|trích)[^)]*\)\s*$/i, "") // trailing source note
    .replace(/[*_`]+/g, "") // bold / italic / code markers
    .replace(/^\s*(?:[-+•]|\d{1,2}[.)])\s+/, "") // list marker
    .replace(/^\s*(?:(?:Khoản|Điểm|Điều|Article|Clause|Paragraph)\s+[\w.]+(?:\s+(?:Điều|Article)\s+\d+\w?)?|Nguyên văn|Quy định)\s*[:–-]\s*/i, "") // "Khoản 1:" label
    .replace(/^["“«'‘\s]+|["”»'’\s]+$/g, "")
    .trim()
}
// Lines that look like quotes (blockquote / quotation marks) but are notes, links or emphasis.
const NOT_A_QUOTE = /^(?:Nguồn|Source|Lưu ý|Note|Ghi chú|Tóm tắt|Kết luận|Khuyến nghị|Tính đến|As of|Trích|Theo|Căn cứ|Quote)(?=[\s:–-]|$)|https?:\/\/|^[^\p{L}\d]|:\s*$/iu
// A blockquote used as a callout for the assistant's own words (explanation, advice, arrows, questions).
const ADVISORY = /→|=>|\?\s*$|^(?:Nói cách khác|Hiểu đơn giản|Tức là|Nghĩa là|Ví dụ|In other words|For example|Lưu ý|Khuyến nghị|Mẹo|Gợi ý)(?=[\s:,–-]|$)|\b(?:bạn|doanh nghiệp (?:nên|cần)|chúng tôi|tôi khuyên|you should)\b/iu

/** Word n-grams of a normalized text (for near-verbatim matching of quotes). */
const words = (s: string) => s.split(/[^\p{L}\p{N}%]+/u).filter(Boolean)
function ngrams(ws: string[], n: number) {
  const out: string[] = []
  for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(" "))
  return out
}

function extractClaims(fullAnswer: string) {
  const { text: answer, translations } = splitTranslations(fullAnswer)
  // links / figures / identifiers inside a translation still count (they must be the same as in the source)
  const all = fullAnswer
  const urls = [...new Set([...all.matchAll(/https?:\/\/[^\s<>()\[\]]+/g)].map((m) => stripUrl(m[0])))]
  const quotes = new Set<string>()
  const addQuote = (raw: string) => {
    const q = cleanQuote(raw)
    if (q.length >= 30 && !NOT_A_QUOTE.test(q)) quotes.add(q)
  }
  for (const line of answer.split("\n")) {
    // Quotation marks are paired in order along the line ("a" … "b" never yields the text between them):
    // curly / guillemet pairs, and straight quotes taken two by two.
    for (const m of line.matchAll(/“([^”]{30,600})”|«([^»]{30,600})»/g)) addQuote(m[1] ?? m[2])
    const straight = line.split('"')
    for (let i = 1; i < straight.length - 1; i += 2) if (straight[i].length >= 30 && straight[i].length <= 600) addQuote(straight[i])
    const q = line.match(/^\s*>\s*(.+)$/)?.[1]
    // a highlighted result line ("> Tiền lãi = **765,75 USD**") is a formula, not a quotation of a source;
    // a blockquote that is the assistant's own note / explanation is not a quotation either
    if (q && !/\s=\s/.test(q) && !/["“«]/.test(q) && !ADVISORY.test(cleanQuote(q))) addQuote(q)
  }
  // numbers inside links ("t%E1%BB%B7-gi%C3%A1") are not figures
  const noUrls = all.replace(/https?:\/\/[^\s<>()\[\]]+/g, " ")
  const figures = [...new Set([...noUrls.matchAll(/(\d{1,3}(?:[.,]\d{1,3})?)\s?%/g)].map((m) => m[1]))]
  const ids = [...new Set([
    ...[...all.matchAll(/\b\d{1,4}\/\d{4}\/[A-ZĐ]{1,6}(?:-[A-ZĐ]{1,8})*\d{0,3}\b/g)].map((m) => m[0]), // 36/2005/QH11, 10/2018/NĐ-CP
    ...[...all.matchAll(/\b[AC]-\d{3}-\d{3}\b/g)].map((m) => m[0]), // A-552-843
    ...[...all.matchAll(/\b(?:FR Doc\.?\s*)?(20\d{2}-\d{5})\b/g)].map((m) => m[1]), // 2025-23431
    ...[...all.matchAll(/\b3\d{4}[A-Z]\d{4}\b/g)].map((m) => m[0]), // CELEX 32025R1919
    ...[...all.matchAll(/\bG\/(?:TBT|SPS)\/N\/[A-Z]{2,4}\/\d+(?:\/[A-Za-z0-9.]+)*\b/g)].map((m) => m[0]),
    ...[...all.matchAll(/\bÁn lệ số \d{1,3}\/\d{4}\/AL\b/g)].map((m) => m[0]),
  ])]
  // money amounts (placeholders "… đồng" have no digits and are never extracted)
  const seen = new Set<string>()
  const amounts = [...amountsIn(noUrls), ...tableAmounts(noUrls)].filter((a) => { const k = `${plainQ(a.value).s} ${a.currency}`; if (seen.has(k)) return false; seen.add(k); return true })
  return { urls, quotes: [...quotes], figures, ids, translations, amounts }
}

/** Amounts in markdown tables whose column header names the currency ("| USD | VND |", "Thành tiền (VNĐ)"). */
function tableAmounts(md: string) {
  const out: ReturnType<typeof amountsIn> = []
  const lines = md.split("\n")
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.replace(/\*\*/g, "").trim())
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue
    const head = cells(lines[i])
    const cur = head.map((h) => (/\b(usd|us\$)\b|đô la/i.test(h) ? "USD" : /\beur\b|euro|€/i.test(h) ? "EUR" : /\b(vnd|vnđ)\b|đồng/i.test(h) ? "VND" : ""))
    if (!cur.some(Boolean)) continue
    for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      cells(lines[j]).forEach((c, k) => {
        if (!cur[k] || currencyIn(c)) return // a cell with its own currency is extracted by amountsIn
        const m = c.match(/^[≈~]?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+[.,]\d{1,2})$/)
        if (m) out.push(...amountsIn(`${m[1]} ${cur[k]}`).map((a) => ({ ...a, raw: `${m[1]} ${cur[k]} (bảng)` })))
      })
    }
  }
  return out
}
const currencyIn = (s: string) => /\b(usd|vnd|vnđ|eur)\b|đồng|€|\$/i.test(s)

/** Every way the number part of an amount may be written in a source ("65.000", "65,000", "65000", "65.000,00"). */
function amountForms(num: string, value: Q, scale: bigint): string[] {
  const base = scale === 1n ? value : div(value, q(scale))
  const out = new Set<string>([num])
  for (const L of ["vi", "en"] as const) { out.add(fmtQ(base, L).replace(/^≈/, "")); out.add(fmtQ(base, L, 2)) }
  out.add(plainQ(base).s)
  return [...out].filter((s) => /\d/.test(s))
}
/** The written amount equals a calc value rounded to the precision it is written with (65.765,75 ← 65.765,7534…). */
function calcHas(values: Q[], num: string, value: Q, scale: bigint) {
  const target = scale === 1n ? value : div(value, q(scale))
  const shown = plainQ(target).s.split(".")[1]?.length ?? 0
  const tail = num.match(/[.,](\d{1,2})$/)?.[1].length ?? 0 // "65.765,70" keeps its 2 decimals
  const dec = Math.max(shown, tail)
  return values.some((c) => {
    const v = scale === 1n ? c : div(c, q(scale))
    return eq(roundQ(v, dec), target) || eq(v, value)
  })
}

export const check = tool({
  description:
    "BẮT BUỘC chạy trên bản nháp câu trả lời cuối cùng (bước citation-check). Kiểm tra bằng máy mọi link, đoạn trích nguyên văn, con số (%, mức thuế) và số hiệu (văn bản, vụ việc, FR Doc, CELEX, thông báo WTO, án lệ) có thật sự xuất hiện trong các nguồn mà công cụ tra cứu đã tải trong phiên này; trả về ĐỘ TIN CẬY (cao / trung bình / thấp) tính từ bằng chứng và danh sách mục chưa có căn cứ. Câu trả lời phải dùng đúng mức độ tin cậy này, không tự chấm.",
  args: {
    answer: tool.schema.string().describe("Toàn bộ bản nháp câu trả lời sẽ gửi cho người dùng (markdown)"),
  },
  async execute({ answer }, context) {
    const ev = loadEvidence(context?.sessionID)
    // Search-result entries (source "*_search") only prove a link was LISTED, not that the document was
    // read – they do not count as opened sources and their snippets are not used to support quotes/figures.
    const isSearch = (e: { source: string }) => /_search$/.test(e.source)
    const opened = ev.filter((e) => !["warning", "grounding", "artifact", "safety", "calc"].includes(e.source) && !isSearch(e))
    const listed = ev.filter(isSearch)
    // calc_* / fx_convert results: computed figures (not sources – they never support links, quotes or ids)
    const calcEv = ev.filter((e) => e.source === "calc")
    const calcCorpus = norm(calcEv.map((e) => e.text).join("\n"))
    const calcValues: Q[] = []
    for (const e of calcEv) for (const s of ((e.meta?.values as string[] | undefined) ?? [])) { try { calcValues.push(fromPlain(s)) } catch {} }
    // the user's own documents (uploads, generated drafts): their amounts are the document's own text
    const docCorpus = norm(ev.filter((e) => e.source === "artifact").map((e) => e.text).join("\n"))
    const warnings = [...new Set(ev.filter((e) => e.source === "warning").map((e) => e.text))]
    const corpus = norm(opened.map((e) => e.text).join("\n"))
    // OCR text of scanned PDFs (meta.ocr, ../lib/pdf-ocr.ts) supports claims, but only "supported-but-OCR":
    // an item found ONLY in OCR evidence caps the level at trung bình (OCR may have wrong diacritics / letters).
    const isOcr = (e: { meta?: Record<string, unknown> }) => e.meta?.ocr === true
    const hasOcr = opened.some(isOcr)
    const plainCorpus = hasOcr ? norm(opened.filter((e) => !isOcr(e)).map((e) => e.text).join("\n")) : corpus
    // the user's documents: an upload OCR'd from a scan (source "artifact", meta.ocr) is OCR evidence too
    const docOcr = ev.some((e) => e.source === "artifact" && isOcr(e))
    const docPlainCorpus = docOcr ? norm(ev.filter((e) => e.source === "artifact" && !isOcr(e)).map((e) => e.text).join("\n")) : docCorpus
    const ocrOnlyKeys = new Set(opened.filter(isOcr).map((e) => canonicalKey(e.url)).filter((k) => !opened.some((e) => !isOcr(e) && canonicalKey(e.url) === k)))
    const listedCorpus = norm(listed.map((e) => `${e.url} ${e.text}`).join("\n"))
    // Alternate identifiers of the same document (ELI / CELLAR links, WTO document links, govinfo copy).
    const altUrls = opened.flatMap((e) => ((e.meta?.alt_urls as string[] | undefined) ?? []).concat(typeof e.meta?.eli === "string" ? [e.meta.eli as string] : []))
    const openedUrls = [...opened.map((e) => e.url), ...altUrls].map(baseUrl)
    // one key per document: vbpl slug/id, FR html/govinfo, CELEX URLs, congbobanan 2ta/5ta … are the same source
    const openedKeys = new Set([...opened.map((e) => e.url), ...altUrls].map(canonicalKey))
    const sourceCount = new Set(opened.map((e) => canonicalKey(e.url))).size
    const { urls, quotes, figures, ids, translations, amounts } = extractClaims(answer)

    const urlRes = urls.map((u) => {
      const b = baseUrl(u)
      const hit = openedKeys.has(canonicalKey(u)) || openedUrls.some((o) => o === b || b.startsWith(o) || o.startsWith(b))
      const listed = !hit && (listedCorpus.includes(norm(b)) || corpus.includes(norm(b)))
      return { u, ok: hit, listed, checkable: CHECKABLE.test(u), ocr: hit && ocrOnlyKeys.has(canonicalKey(u)) }
    })
    // Near-verbatim matching: share of the quote's word 4-grams found in the sources (built only when needed).
    let gramSet: Set<string> | null = null
    const coverage = (nq: string) => {
      gramSet ??= new Set(ngrams(words(corpus), 4))
      const g = ngrams(words(nq), 4)
      return g.length ? g.filter((x) => gramSet!.has(x)).length / g.length : 0
    }
    const quoteRes = quotes.map((q) => {
      const nq = norm(q).replace(/^["']|["']$/g, "")
      // a quote shortened with "…" / "..." / "[…]": every fragment (≥ 12 chars) must be verbatim in the source
      // (a template's blanks "[tên công ty]" / "[…]" are cut the same way)
      const frags = nq.split(/\s*(?:…|\.\.\.+|\[[^\]]{0,60}\]|\(…\))\s*/).map((f) => f.replace(/^[,;:.\s]+|[,;:.\s]+$/g, "")).filter((f) => f.length >= 12)
      const inText = (c: string) => !!c && (c.includes(nq) || (nq.length > 80 && c.includes(nq.slice(0, 80)) && c.includes(nq.slice(-60))) || (frags.length > 1 && frags.every((f) => c.includes(f))))
      let src = inText(corpus)
      // near-verbatim (≥ 85 % of 4-grams: a changed diacritic, punctuation, a word dropped) counts as the source text
      const cov = src ? 1 : coverage(nq)
      const near = !src && cov >= 0.85
      if (near) src = true
      // a passage quoted from the user's own document, or text produced by a calc tool (amount in words)
      const doc = !src && inText(docCorpus)
      const calc = !src && !doc && inText(calcCorpus)
      // not supported: "partial" (half of it is in the sources – paraphrase / mixed with commentary) vs "invented"
      return { q, ok: src || doc || calc, doc, calc, near, partial: !src && !doc && !calc && cov >= 0.5, ocr: (src && hasOcr && !near && !inText(plainCorpus)) || (doc && docOcr && !inText(docPlainCorpus)) }
    })
    // A percentage counts only when the source shows the same number as a percentage ("8%", "8 %",
    // "8 percent", "tám phần trăm" is not handled) – or, for rate tables (Federal Register / EUR-Lex list
    // rates without "%"), as a standalone number in those tables. A bare "12" elsewhere ("Điều 12") is not enough.
    const tableCorpus = norm(opened.filter((e) => /federalregister|govinfo|eur-lex|publications\.europa|canhbaosom/.test(e.url + e.source)).map((e) => e.text).join("\n"))
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const figRes = figures.map((f) => {
      const forms = [...new Set([f, f.includes(",") ? f.replace(",", ".") : f.replace(".", ",")])].map(esc)
      const pct = new RegExp(`(?<![\\d.,])(${forms.join("|")})\\s?(%|percent|phần trăm)`, "i")
      const bare = new RegExp(`(?<![\\d.,])(${forms.join("|")})(?![\\d]|[.,]\\d)`)
      const src = pct.test(corpus) || (!!tableCorpus && bare.test(tableCorpus))
      // otherwise computed: a calc tool of this session shows the same number as a percentage
      const calc = !src && !!calcCorpus && pct.test(calcCorpus)
      return { f, ok: src || calc, calc, ocr: src && hasOcr && !pct.test(plainCorpus) && !(!!tableCorpus && bare.test(tableCorpus)) }
    })
    // A document number also counts when it is the number of a document that was opened (its title / link slug,
    // e.g. vbpl.vn/…/bo-luat-dan-su-so-91-2015-qh13--95942) – article pages do not repeat the number in their text.
    const idMeta = norm(opened.map((e) => `${e.title ?? ""} ${decodeURIComponent(e.url).replace(/[-_]/g, " ")}`).join("\n"))
    const idSlug = (id: string) => norm(id).replace(/[\/\-.]+/g, " ").replace(/đ/g, "d")
    const idRes = ids.map((id) => {
      const inText = corpus.includes(norm(id))
      const inMeta = !inText && (idMeta.includes(norm(id)) || idMeta.replace(/đ/g, "d").includes(idSlug(id)))
      return { id, ok: inText || inMeta, ocr: hasOcr && inText && !plainCorpus.includes(norm(id)) }
    })
    // Money amounts: in an opened source, computed by a calc tool, or verbatim in the user's document.
    const amtRes = amounts.map((a) => {
      const forms = amountForms(a.num, a.value, a.scale).map(esc)
      const re = new RegExp(`(?<![\\d.,])(${forms.join("|")})(?![\\d]|[.,]\\d)`)
      const src = re.test(corpus)
      const calc = !src && calcHas(calcValues, a.num, a.value, a.scale)
      const doc = !src && !calc && !!docCorpus && re.test(docCorpus)
      return { a: a.raw.trim(), ok: src || calc || doc, calc, doc, ocr: (src && hasOcr && !re.test(plainCorpus)) || (doc && docOcr && !re.test(docPlainCorpus)) }
    })
    const ocrItems = [...urlRes.filter((x) => x.ocr).map((x) => x.u), ...quoteRes.filter((x) => x.ocr).map((x) => `"${x.q.slice(0, 80)}${x.q.length > 80 ? "…" : ""}"`), ...figRes.filter((x) => x.ocr).map((x) => x.f + "%"), ...idRes.filter((x) => x.ocr).map((x) => x.id), ...amtRes.filter((x) => x.ocr).map((x) => x.a)]

    const bad = {
      urls: urlRes.filter((x) => !x.ok && !x.listed && x.checkable),
      urlsOnlyListed: urlRes.filter((x) => x.listed),
      urlsUnverifiable: urlRes.filter((x) => !x.ok && !x.checkable),
      quotes: quoteRes.filter((x) => !x.ok),
      figures: figRes.filter((x) => !x.ok),
      ids: idRes.filter((x) => !x.ok),
      amounts: amtRes.filter((x) => !x.ok),
    }
    const computed = [...figRes.filter((x) => x.calc).map((x) => x.f + "%"), ...amtRes.filter((x) => x.calc).map((x) => x.a), ...quoteRes.filter((x) => x.calc).map((x) => `"${x.q.slice(0, 80)}"`)]
    const fromDoc = [...amtRes.filter((x) => x.doc).map((x) => x.a), ...quoteRes.filter((x) => x.doc).map((x) => `"${x.q.slice(0, 80)}${x.q.length > 80 ? "…" : ""}"`)]
    const supported = urlRes.filter((x) => x.ok).length + quoteRes.filter((x) => x.ok).length + figRes.filter((x) => x.ok).length + idRes.filter((x) => x.ok).length + amtRes.filter((x) => x.ok).length
    const claims = urlRes.length + quoteRes.length + figRes.length + idRes.length + amtRes.length
    const unsupported = bad.urls.length + bad.quotes.length + bad.figures.length + bad.ids.length + bad.amounts.length
    // One denominator everywhere (badge, reasons, the 30 % rule): items that CAN be checked automatically.
    // Links outside the checkable sources are counted apart ("unverifiable"), never as unsupported.
    const checkable = claims - bad.urlsUnverifiable.length

    // Level: any invented quote or no evidence at all → thấp; unsupported links/figures/ids or tool
    // warnings → at most trung bình; otherwise cao when the answer rests on several verified items.
    // Only calc results / the user's document and no source opened → at most trung bình.
    const reasons: string[] = []
    // Same reasons as codes for the web UI (localized there): { code, n?, total?, computed? }
    const why: { code: string; n?: number; total?: number; computed?: number }[] = []
    let level: "cao" | "trung bình" | "thấp" = "cao"
    if (!opened.length && !(calcEv.length && supported)) { level = "thấp"; reasons.push("không có nguồn nào được tra bằng công cụ trong phiên này"); why.push({ code: "no_sources" }) }
    else if (!opened.length) { level = "trung bình"; reasons.push("chỉ có kết quả tính bằng công cụ / số liệu của tài liệu, không có nguồn pháp lý nào được tra"); why.push({ code: "calc_only" }) }
    // Only a quote that is NOT in the sources at all (< 50 % of its wording) is an invented quote → thấp.
    // A partly matching one (paraphrase presented as a quote) counts as unsupported and caps the level at trung bình.
    const invented = bad.quotes.filter((x) => !x.partial)
    const partialQ = bad.quotes.filter((x) => x.partial)
    if (invented.length) { level = "thấp"; reasons.push(`${invented.length} đoạn trích không có trong nguồn đã tra`); why.push({ code: "bad_quotes", n: invented.length }) }
    if (level === "cao" && partialQ.length) { level = "trung bình"; reasons.push(`${partialQ.length} đoạn trích chỉ khớp một phần với nguồn (diễn đạt lại, không phải nguyên văn)`); why.push({ code: "partial_quotes", n: partialQ.length }) }
    // ≥ 2 unsupported items and > 30 %: a single unsupported item in a short answer (1/3) is not "thấp" – it caps at trung bình.
    if (unsupported >= 2 && checkable && unsupported / checkable > 0.3) { level = "thấp"; reasons.push(`${unsupported}/${checkable} mục chưa có căn cứ`); why.push({ code: "unsupported", n: unsupported, total: checkable }) }
    if (level === "cao" && (bad.urls.length || bad.figures.length || bad.ids.length || bad.amounts.length)) { level = "trung bình"; reasons.push("một số link / con số / số tiền / số hiệu chưa đối chiếu được với nguồn đã tra"); why.push({ code: "unmatched" }) }
    if (level === "cao" && ocrItems.length) { level = "trung bình"; reasons.push(`${ocrItems.length} căn cứ chỉ có trong văn bản nhận dạng OCR từ bản scan (có thể sai dấu/chữ – cần đối chiếu bản gốc)`); why.push({ code: "ocr_evidence", n: ocrItems.length }) }
    if (level === "cao" && warnings.length) { level = "trung bình"; reasons.push("công cụ tra cứu có cảnh báo về văn bản nguồn"); why.push({ code: "source_warnings" }) }
    if (level === "cao" && bad.urlsUnverifiable.length) { level = "trung bình"; reasons.push("có link ngoài các nguồn kiểm chứng tự động được"); why.push({ code: "unverifiable_links" }) }
    if (level === "cao" && supported < 2) { level = "trung bình"; reasons.push("câu trả lời dựa trên quá ít căn cứ đã kiểm chứng"); why.push({ code: "few_items" }) }
    if (level === "cao") { reasons.push(`${supported}/${checkable} căn cứ đều khớp với nguồn đã tra${computed.length ? ` hoặc do công cụ tính (${computed.length})` : ""}`); why.push({ code: "all_matched", n: supported, total: checkable, ...(computed.length ? { computed: computed.length } : {}) }) }
    // States numbers / document numbers / quotes although nothing was opened in this session → from memory.
    if (!opened.length && (bad.ids.length || bad.figures.length || bad.amounts.length || bad.quotes.length)) {
      level = "thấp"; reasons.push("câu trả lời nêu số hiệu / con số / trích dẫn nhưng chưa mở nguồn nào trong phiên (trả lời theo trí nhớ)"); why.push({ code: "from_memory" })
    }

    // Research rounds: consecutive earlier checks of this session (last 30 min) that still had gaps.
    let prevRounds = 0
    for (const e of [...ev].reverse()) {
      if (e.source !== "grounding" || !e.at || Date.now() - e.at > 30 * 60_000) continue
      let v: any = {}
      try { v = JSON.parse(e.text) } catch {}
      if (!(v.unsupported > 0 || v.level === "thấp" || v.gap)) break
      prevRounds++
    }
    const allComputed = !opened.length && claims > 0 && supported === claims && !bad.urlsOnlyListed.length
    const mustResearch = level === "thấp" || unsupported > 0 || (!opened.length && !allComputed)
    const round = prevRounds + 1
    const gaps = [
      ...bad.quotes.map((x) => `trích dẫn "${x.q.slice(0, 80)}${x.q.length > 80 ? "…" : ""}"${/(đồng|đô la|dollars?|triệu|nghìn|tỷ)/i.test(x.q) && !/\d{2}/.test(x.q) ? " (số tiền bằng chữ → viết bằng calc_money_words)" : ""}`), ...bad.ids.map((x) => `số hiệu ${x.id}`),
      ...bad.figures.map((x) => `con số ${x.f}% (nếu là kết quả tính → calc_eval / calc_interest)`), ...bad.amounts.map((x) => `số tiền ${x.a} (nếu là kết quả tính → calc_eval / fx_convert)`), ...bad.urls.map((x) => `link ${x.u}`),
      ...(!opened.length && !unsupported ? ["căn cứ pháp lý / nguồn chính thức cho các nhận định trong câu trả lời"] : []),
    ]
    const researchStep = !mustResearch
      ? ""
      : round <= 3
        ? `→ BẮT BUỘC (vòng ${round}/3): tra thêm bằng web_search → web_read (hoặc công cụ chuyên dụng: vbpl_*, trav_*, fedreg_*, eurlex_*, eping_*, fta_*, court_*, fx_rate, calc_*) cho các mục sau: ${gaps.slice(0, 8).join("; ")}${gaps.length > 8 ? `; … (+${gaps.length - 8})` : ""} – rồi gọi lại grounding_check. Không tự sửa con số theo trí nhớ. Nếu vẫn không có căn cứ, nói rõ "chưa xác minh được".`
        : `→ Đã tra ${prevRounds} vòng mà vẫn chưa có căn cứ: KHÔNG đoán. Trả lời với câu "Tôi chưa xác minh được …" cho từng mục (hoặc bỏ mục đó), nêu nơi người dùng có thể tự kiểm tra (cơ quan / cổng thông tin chính thức), đánh dấu kiến thức chung là "kiến thức chung, chưa đối chiếu nguồn", và đề nghị chuyển chuyên gia (expert_escalate).`

    const list = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((x) => `  - ${x.length > 200 ? x.slice(0, 200) + "…" : x}`).join("\n")}` : "")
    const report = [
      `ĐỘ TIN CẬY (tính từ bằng chứng): ${level.toUpperCase()}`,
      `Lý do: ${reasons.join("; ")}.`,
      `Đã đối chiếu: ${claims} mục (link ${urlRes.length}, trích dẫn ${quoteRes.length}, con số ${figRes.length}, số tiền ${amtRes.length}, số hiệu ${idRes.length}) với ${sourceCount} nguồn đã tra${calcEv.length ? ` và ${calcEv.length} kết quả tính bằng công cụ` : ""} trong phiên.`,
      translations.length ? `Bản dịch không chính thức: ${translations.length} đoạn "(unofficial translation: …)" – không đối chiếu nguyên văn (bản dịch), đoạn trích tiếng Việt đi kèm vẫn được kiểm tra.` : "",
      list("Tính bằng công cụ (calc_* / fx_convert trong phiên này – ghi rõ \"tính bằng công cụ\" kèm công thức)", computed),
      list("Số tiền / đoạn trích lấy nguyên văn từ tài liệu của người dùng", fromDoc),
      list("Căn cứ chỉ có trong văn bản OCR từ bản scan (khớp, nhưng độ tin cậy tối đa TRUNG BÌNH – ghi rõ \"theo bản OCR, cần đối chiếu bản gốc\")", ocrItems),
      list("Đoạn trích KHÔNG có nguyên văn trong nguồn (phải trích lại bằng công cụ hoặc bỏ)", bad.quotes.filter((x) => !x.partial).map((x) => x.q)),
      list("Đoạn trích chỉ khớp một phần (đặt trong ngoặc kép như nguyên văn nhưng đã diễn đạt lại – trích đúng nguyên văn hoặc bỏ ngoặc kép)", bad.quotes.filter((x) => x.partial).map((x) => x.q)),
      list("Đoạn trích gần đúng nguyên văn (khác dấu câu / vài chữ – nên chép lại đúng từ công cụ)", quoteRes.filter((x) => x.near).map((x) => x.q)),
      list("Link chưa được mở bằng công cụ (mở bằng công cụ tương ứng hoặc bỏ)", bad.urls.map((x) => x.u)),
      list("Link chỉ thấy trong danh sách kết quả tìm kiếm, chưa mở văn bản", bad.urlsOnlyListed.map((x) => x.u)),
      list("Link ngoài nguồn kiểm chứng tự động", bad.urlsUnverifiable.map((x) => x.u)),
      list("Con số không thấy trong nguồn đã tra và không do công cụ tính (không tự nhẩm – tính bằng calc_eval / calc_interest, hoặc chỉ nêu số có trong văn bản)", bad.figures.map((x) => x.f + "%")),
      list("Số tiền không thấy trong nguồn đã tra, không do công cụ tính, không có trong tài liệu (tính bằng calc_* / fx_convert hoặc bỏ)", bad.amounts.map((x) => x.a)),
      list("Số hiệu không thấy trong nguồn đã tra", bad.ids.map((x) => x.id)),
      list("Cảnh báo từ công cụ", warnings),
      unsupported
        ? "→ Sửa hoặc bỏ các mục trên rồi gọi lại grounding_check trước khi trả lời. Nếu vẫn không có căn cứ, nói rõ là chưa xác minh được."
        : "→ Không tự ghi mức độ tin cậy vào câu trả lời và không nhắc tên công cụ nội bộ – giao diện tự hiển thị thẻ độ tin cậy do hệ thống chấm, kèm danh sách từng mục đã đối chiếu.",
      researchStep,
      allComputed ? "→ Chỉ có phép tính (không có nguồn pháp lý): nếu câu trả lời có nhận định pháp lý (mức trần, nghĩa vụ, thời hạn, căn cứ) thì BẮT BUỘC tra bằng vbpl_* hoặc web_search → web_read trước; nếu chỉ là phép tính thì ghi rõ \"(tính bằng công cụ)\"." : "",
      level === "thấp" ? "→ Độ tin cậy THẤP: nói rõ trong câu trả lời phần nào chưa xác minh được. Chỉ đề nghị chuyển chuyên gia (expert_escalate) khi phần chưa xác minh là kết luận chính của câu trả lời, hoặc tình huống thuộc diện bắt buộc theo skill citation-check / safety – không đề nghị chuyển chuyên gia chỉ vì một vài chi tiết phụ." : "",
    ].filter(Boolean).join("\n")
    // Per-item results for the web UI ("which items matched, where"): the answer text of each item (so the UI can
    // underline it in the answer), whether it matched, why, and the opened source it matched (title + link).
    const normTexts = new Map<number, string>()
    const textOf = (i: number) => { if (!normTexts.has(i)) normTexts.set(i, norm(opened[i].text)); return normTexts.get(i)! }
    const srcWhere = (pred: (t: string, e: (typeof opened)[number]) => boolean) => {
      for (let i = 0; i < opened.length; i++) if (pred(textOf(i), opened[i])) return { title: String(opened[i].title || "").slice(0, 120), url: opened[i].url }
      return undefined
    }
    type Check = { k: "link" | "quote" | "figure" | "amount" | "id"; t: string; ok: boolean; why: string; src?: { title: string; url: string } }
    const checks: Check[] = [
      ...quoteRes.map((x): Check => {
        const nq = norm(x.q).replace(/^["']|["']$/g, ""); const head = nq.split(/\s*(?:…|\.\.\.+)\s*/)[0].slice(0, 60)
        return { k: "quote", t: x.q, ok: x.ok, why: x.doc ? "doc" : x.calc ? "calc" : x.ocr ? "ocr" : x.near ? "near" : x.ok ? "verbatim" : x.partial ? "partial" : "missing", src: x.ok && !x.doc && !x.calc && head.length >= 12 ? srcWhere((t) => t.includes(head)) : undefined }
      }),
      ...figRes.map((x): Check => ({ k: "figure", t: x.f + "%", ok: x.ok, why: x.calc ? "calc" : x.ocr ? "ocr" : x.ok ? "source" : "missing", src: x.ok && !x.calc ? srcWhere((t) => t.includes(norm(x.f + "%")) || t.includes(norm(x.f + " %"))) : undefined })),
      ...amtRes.map((x): Check => ({ k: "amount", t: x.a, ok: x.ok, why: x.calc ? "calc" : x.doc ? "doc" : x.ocr ? "ocr" : x.ok ? "source" : "missing" })),
      ...idRes.map((x): Check => ({ k: "id", t: x.id, ok: x.ok, why: x.ocr ? "ocr" : x.ok ? "source" : "missing", src: x.ok ? srcWhere((t, e) => t.includes(norm(x.id)) || norm(`${e.title ?? ""} ${decodeURIComponent(e.url).replace(/[-_]/g, " ")}`).includes(norm(x.id))) : undefined })),
      ...urlRes.map((x): Check => ({ k: "link", t: x.u, ok: x.ok, why: x.ok ? (x.ocr ? "ocr" : "opened") : x.listed ? "listed" : x.checkable ? "not_opened" : "unverifiable", src: x.ok ? srcWhere((_t, e) => canonicalKey(e.url) === canonicalKey(x.u) || baseUrl(e.url) === baseUrl(x.u)) : undefined })),
    ].slice(0, 40).map((c) => ({ ...c, t: c.t.length > 300 ? c.t.slice(0, 300) + "…" : c.t }))
    // Keep the verdict with the session so the web UI can show the computed confidence.
    // Per-link status for the web UI (source cards): the SAME result the level was computed from, so the source list
    // and the badge can never disagree. ok = opened and matched · listed = only seen in search results ·
    // missing = never opened · external = outside the automatically checkable sources.
    const links = urlRes.slice(0, 60).map((x) => ({ u: x.u, s: x.ok ? "ok" : x.listed ? "listed" : x.checkable ? "missing" : "external" }))
    const unverifiable = bad.urlsUnverifiable.length
    recordEvidence(context?.sessionID, { url: "grounding://check", text: JSON.stringify({ level, reasons, why, claims, checkable, supported, unsupported, unverifiable, computed: computed.length, round, gap: mustResearch, checks, links }), source: "grounding" })
    const LEVEL_CODE = { cao: "high", "trung bình": "medium", thấp: "low" } as const
    return withUi(report, { res: { t: "level", code: LEVEL_CODE[level] }, verdict: { level: LEVEL_CODE[level], why, claims, supported, unsupported, unverifiable, checks } })
  },
})
