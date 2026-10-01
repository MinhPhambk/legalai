// document_create / document_read / document_edit: generated (or uploaded) documents as versioned files.
// document_create turns a drafted contract / report (markdown) into real files – .docx (docx library) and
// .pdf (rendered by the sandbox Chrome) – laid out the way Vietnamese legal documents are: Quốc hiệu /
// Tiêu ngữ, Times New Roman 13, A4, justified text, signature blocks – in Vietnamese, English, or bilingual
// (two aligned columns Vietnamese | English, language clause added automatically). document_edit applies small
// targeted edits (never a full rewrite) and saves version n+1 plus a tracked-changes .docx (redline).
// Rendering + storage live in ../lib/doc-store.ts (shared with the web server). Files go to
// .sandbox/outputs/<sessionID>/ and every tool returns an artifact marker the web UI turns into a
// preview card with download buttons.
import { tool } from "@opencode-ai/plugin"
import {
  EditError, applyBilingualEdits, applyEdits, artifactMarker, bilingualOutline, changesSummary, checkBilingualStructure, enSignLabel,
  ensureLanguageClause, findCounterpart, findDocumentForSession, findSection, langOf, outline, readMarkdown, readMarkdownEn,
  saveDocument, type DocMeta, type Edit, type Pending,
} from "../lib/doc-store.ts"

// long drafts (draft_*): a draft id / an un-assembled draft → tell the model to call draft_assemble first
import { draftHint } from "../lib/drafting.ts"

const NOT_FOUND = "không tìm thấy tài liệu trong cuộc trò chuyện này"
const kb = (b: number) => `${Math.max(1, Math.round(b / 1024))} KB`
const fileList = (m: DocMeta) =>
  m.files.map((f) => `${f.format === "redline" ? "DOCX theo dõi thay đổi" : f.format.toUpperCase()} (${kb(f.bytes)})`).join(", ")
const pdfNote = (m: DocMeta) => (m.pdf_error ? " – không tạo được PDF (trình duyệt sandbox không phản hồi)" : "")

export const create = tool({
  description:
    "Tạo TỆP tài liệu hoàn chỉnh để người dùng xem trước và tải xuống (.docx và/hoặc .pdf): hợp đồng đã soạn, báo cáo rà soát, bảng tra cứu… Nội dung viết bằng markdown (tiêu đề # cho tên văn bản, ## cho từng Điều/Mục, bảng markdown được giữ thành bảng). kind='hop-dong' tự thêm Quốc hiệu – Tiêu ngữ và (nếu truyền sign_a/sign_b) khối chữ ký hai bên. NGÔN NGỮ: language='vi' (mặc định) | 'en' (bản tiếng Anh: Quốc hiệu tiếng Anh, nhãn ký 'FOR AND ON BEHALF OF PARTY A') | 'bilingual' (song ngữ hai cột Việt | Anh, căn theo từng Điều/khoản: truyền `markdown` = bản tiếng Việt và `markdown_en` = bản tiếng Anh có CÙNG cấu trúc tiêu đề – cùng số Điều/Mục, cùng thứ tự, 'Điều 5' ↔ 'Article 5'; hợp đồng song ngữ tự thêm điều khoản ngôn ngữ, bản ưu tiên theo `prevailing`). Dùng công cụ này MỖI KHI soạn xong hợp đồng hoặc báo cáo dài MỚI; trong câu trả lời chỉ tóm tắt và nhắc người dùng mở tệp. KHÔNG dùng để sửa tài liệu đã có (có 'mã tài liệu') – khi đó dùng document_read → document_edit.",
  args: {
    title: tool.schema.string().describe("Tên tài liệu, VD 'Hợp đồng phân phối độc quyền cà phê rang xay' (song ngữ: có thể 'Hợp đồng mua bán hàng hóa / Sales Contract')"),
    markdown: tool.schema.string().describe("Toàn bộ nội dung tài liệu (markdown). language='en': viết bằng tiếng Anh. language='bilingual': đây là BẢN TIẾNG VIỆT. Không đưa phần giải thích cho người dùng vào đây"),
    kind: tool.schema.enum(["hop-dong", "bao-cao", "van-ban"]).describe("hop-dong = hợp đồng (có Quốc hiệu); bao-cao = báo cáo rà soát / tra cứu; van-ban = tài liệu khác"),
    formats: tool.schema.array(tool.schema.enum(["docx", "pdf"])).optional().describe("Định dạng cần tạo (mặc định cả docx và pdf)"),
    sign_a: tool.schema.string().optional().describe("Nhãn khối chữ ký bên trái, VD 'ĐẠI DIỆN BÊN A' (en: 'FOR AND ON BEHALF OF PARTY A'; song ngữ: nhãn tiếng Việt, nhãn tiếng Anh tự thêm – hoặc ghi 'ĐẠI DIỆN BÊN A / FOR AND ON BEHALF OF PARTY A')"),
    sign_b: tool.schema.string().optional().describe("Nhãn khối chữ ký bên phải, VD 'ĐẠI DIỆN BÊN B'"),
    language: tool.schema.enum(["vi", "en", "bilingual"]).optional().describe("Ngôn ngữ tài liệu: vi (mặc định), en, bilingual (song ngữ Việt – Anh hai cột; cần markdown_en)"),
    markdown_en: tool.schema.string().optional().describe("CHỈ khi language='bilingual': bản tiếng Anh, CÙNG cấu trúc tiêu đề với `markdown` (mỗi '## Điều N. …' ↔ '## Article N. …', cùng các khoản/đoạn theo thứ tự) để hai cột căn đúng từng Điều"),
    prevailing: tool.schema.enum(["vi", "en"]).optional().describe("Song ngữ: bản ưu tiên áp dụng khi có khác biệt (mặc định vi)"),
  },
  async execute({ title, markdown, kind, formats, sign_a, sign_b, language, markdown_en, prevailing }, context) {
    const lang = language ?? (markdown_en?.trim() ? "bilingual" : "vi")
    const split = (s: string | undefined) => (s && s.includes(" / ") ? s.split(" / ").map((x) => x.trim()) : s ? [s.trim()] : [])
    const [a, aEn] = split(sign_a), [b, bEn] = split(sign_b)
    let sign: [string, string] | undefined
    let signEn: [string, string] | undefined
    if (lang === "en") {
      if (sign_a || sign_b) sign = [a ? (langOf(a) === "vi" ? enSignLabel(a, 0) : a) : "FOR AND ON BEHALF OF PARTY A", b ? (langOf(b) === "vi" ? enSignLabel(b, 1) : b) : "FOR AND ON BEHALF OF PARTY B"]
    } else if (sign_a || sign_b) {
      sign = [a ?? "ĐẠI DIỆN BÊN A", b ?? "ĐẠI DIỆN BÊN B"]
      if (lang === "bilingual") signEn = [aEn ?? enSignLabel(sign[0], 0), bEn ?? enSignLabel(sign[1], 1)]
    }
    let md = markdown, mdEn = markdown_en ?? ""
    let clauseNote = ""
    if (lang === "bilingual") {
      if (!mdEn.trim()) return "Lỗi – CHƯA tạo tài liệu: language='bilingual' cần `markdown_en` (bản tiếng Anh cùng cấu trúc với `markdown`)."
      const mism = checkBilingualStructure(md, mdEn)
      if (mism.length)
        return [
          "Lỗi – CHƯA tạo tài liệu: cấu trúc bản tiếng Việt (`markdown`) và bản tiếng Anh (`markdown_en`) không khớp, hai cột sẽ lệch. Sửa để mỗi tiêu đề có đúng một tiêu đề tương ứng, cùng thứ tự và cùng số (VD '## Điều 5. Thanh toán' ↔ '## Article 5. Payment'), rồi gọi lại document_create:",
          ...mism.map((m) => `- ${m}`),
        ].join("\n")
      if (kind === "hop-dong") {
        const r = ensureLanguageClause(md, mdEn, prevailing ?? "vi")
        md = r.vi; mdEn = r.en
        clauseNote = r.added
          ? ` Đã tự thêm điều khoản ngôn ngữ (song ngữ, bản tiếng ${(prevailing ?? "vi") === "en" ? "Anh" : "Việt"} ưu tiên) vào cuối ${r.label}.`
          : " Hợp đồng đã có điều khoản ngôn ngữ – không thêm."
      }
    }
    const meta = await saveDocument({
      sessionID: context?.sessionID ?? "no-session", title, markdown: md, kind, formats, sign, origin: "agent",
      language: lang, ...(lang === "bilingual" ? { markdownEn: mdEn, prevailing: prevailing ?? "vi", signEn } : {}),
    })
    const langNote = lang === "bilingual" ? " – song ngữ Việt | Anh (hai cột)" : lang === "en" ? " – tiếng Anh" : ""
    return [
      `Đã tạo tài liệu "${title}" (mã tài liệu: ${meta.id}, phiên bản 1${langNote}): ${fileList(meta)}${pdfNote(meta)}.${clauseNote}`,
      "Giao diện sẽ hiện thẻ tài liệu để người dùng xem trước và tải xuống. Trong câu trả lời: tóm tắt ngắn cấu trúc tài liệu, các điểm cần người dùng điền/thương lượng, và căn cứ pháp lý chính (không chép lại toàn bộ nội dung). Nếu người dùng muốn sửa sau này: document_read → document_edit với mã tài liệu này.",
      artifactMarker(meta),
    ].join("\n")
  },
})

const CAP = 12_000
const numbered = (text: string, firstLine: number) =>
  text.split("\n").map((l, i) => `${String(firstLine + i).padStart(4)}│ ${l}`).join("\n")

/** document_read of a bilingual document: per aligned section, the Vietnamese text then the English text. */
function readBilingual(meta: DocMeta, md: string, head: string, rule: string, section?: string) {
  let en: string
  try {
    en = readMarkdownEn(meta)
  } catch (e: any) {
    return `Lỗi: không đọc được bản tiếng Anh của tài liệu ${meta.id}: ${e?.message ?? e}.`
  }
  const h = `${head} Song ngữ Việt | Anh (hai cột), bản tiếng ${meta.prevailing === "en" ? "Anh" : "Việt"} ưu tiên; bản tiếng Anh ${en.length.toLocaleString("vi-VN")} ký tự.`
  const biRule = `${rule} Tài liệu SONG NGỮ: mỗi mục hiện [VI] (bản tiếng Việt) rồi [EN] (bản tiếng Anh), số dòng tính riêng cho từng bản. Sửa bằng document_edit với lang='vi' | 'en' | 'both' (both: find+text cho tiếng Việt, find_en+text_en cho tiếng Anh; theo section thì áp dụng cho cả hai). Sửa một bản thì phải sửa phần tương ứng của bản kia.`
  if (section) {
    let sv, se
    try {
      try {
        sv = findSection(md, section)
        se = findCounterpart(md, en, section, "vi")
      } catch (e) {
        if (!(e instanceof EditError) || !/^Không tìm thấy/.test(e.message)) throw e
        se = findSection(en, section)
        sv = findCounterpart(md, en, section, "en")
      }
    } catch (e: any) {
      if (e instanceof EditError) return `Lỗi: ${e.message}\n${e.candidates.map((c) => `- ${c}`).join("\n")}`
      throw e
    }
    const part = (src: string, sp: { start: number; end: number }) => {
      const first = src.slice(0, sp.start).split("\n").length
      const body = src.slice(sp.start, sp.end).replace(/\s+$/, "")
      return { first, body: body.length > CAP / 2 ? body.slice(0, CAP / 2) + "\n… (đã cắt)" : body }
    }
    const a = part(md, sv), b = part(en, se)
    return [h, `Mục ${sv.label}:`, biRule, "", `[VI] (từ dòng ${a.first}):`, numbered(a.body, a.first), "", `[EN] (từ dòng ${b.first}):`, numbered(b.body, b.first)].join("\n")
  }
  const outl = bilingualOutline(md, en)
  const toc = outl.slice(1).map((p) => `- ${p.vi?.heading ?? "(không có ở bản tiếng Việt)"}  ↔  ${p.en?.heading ?? "(không có ở bản tiếng Anh)"}`).join("\n")
  const out: string[] = []
  let used = 0, cut = false
  for (const p of outl) {
    const block = [`=== ${p.label} ===`, p.vi ? `[VI]\n${numbered(p.vi.text, p.vi.from)}` : "[VI] (không có)", p.en ? `[EN]\n${numbered(p.en.text, p.en.from)}` : "[EN] (không có)"].join("\n")
    if (used + block.length > CAP && out.length) { cut = true; break }
    out.push(block)
    used += block.length
  }
  return [
    h,
    toc ? `Mục lục (VI ↔ EN):\n${toc}` : "Mục lục: (không có tiêu đề Điều/Mục)",
    biRule,
    "",
    out.join("\n\n"),
    cut ? `\n… (đã cắt ở ~${CAP} ký tự; phần còn lại xem bằng document_read với section = tên Điều/Mục trong mục lục)` : "",
  ].join("\n")
}

export const read = tool({
  description:
    "Đọc nội dung markdown đã lưu của một tài liệu (đã tạo bằng document_create hoặc do người dùng tải lên, có 'mã tài liệu: <id>'), kèm mục lục Điều/Mục và số dòng. BẮT BUỘC gọi trước document_edit để chép NGUYÊN VĂN đoạn cần sửa làm `find`. Tài liệu dài chỉ trả về ~12.000 ký tự đầu – truyền `section` (VD 'Điều 5', '5.2', 'Điều 5 khoản 2' hoặc chữ trong tiêu đề) để xem phần cụ thể. Tài liệu song ngữ: hiện từng mục [VI] rồi [EN] (hai cột).",
  args: {
    id: tool.schema.string().describe("Mã tài liệu, VD '20260926034611-4345e7'"),
    section: tool.schema.string().optional().describe("Chỉ đọc một mục: 'Điều 5', '5.2', 'Điều 5 khoản 2', hoặc chữ trong tiêu đề"),
  },
  async execute({ id, section }, context) {
    const meta = findDocumentForSession(context?.sessionID ?? "no-session", id.trim())
    if (!meta) return draftHint(context?.sessionID ?? "no-session", id) ?? `Lỗi: ${NOT_FOUND} (mã ${id}).`
    const md = readMarkdown(meta)
    const head = `Tài liệu "${meta.title}" – mã tài liệu: ${meta.id} – phiên bản ${meta.version}${meta.parent_id ? ` (sửa từ ${meta.parent_id})` : ""} – ${meta.origin === "upload" ? "do người dùng tải lên" : "do trợ lý tạo"} – ${md.length.toLocaleString("vi-VN")} ký tự.`
    const toc = outline(md).map((h) => `${"  ".repeat(Math.max(0, Math.round(h.level) - 1))}- dòng ${h.line}: ${h.text.slice(0, 100)}`).join("\n")
    const rule = "Số dòng và ký tự '│' chỉ để định vị – KHÔNG đưa vào `find`. `find` phải là đoạn nguyên văn, duy nhất trong tài liệu."
    if (meta.language === "bilingual") return readBilingual(meta, md, head, rule, section)
    if (section) {
      let span
      try {
        span = findSection(md, section)
      } catch (e: any) {
        if (e instanceof EditError) return `Lỗi: ${e.message}\n${e.candidates.map((c) => `- ${c}`).join("\n")}`
        throw e
      }
      const firstLine = md.slice(0, span.start).split("\n").length
      let body = md.slice(span.start, span.end).replace(/\s+$/, "")
      const cut = body.length > CAP
      if (cut) body = body.slice(0, CAP)
      return [head, `Mục ${span.label} (từ dòng ${firstLine}):`, rule, "", numbered(body, firstLine), cut ? `\n… (mục dài, đã cắt ở ${CAP} ký tự – đọc từng khoản: section='${span.label} khoản N')` : ""].join("\n")
    }
    const cut = md.length > CAP
    const body = cut ? md.slice(0, md.lastIndexOf("\n", CAP) > 0 ? md.lastIndexOf("\n", CAP) : CAP) : md.replace(/\s+$/, "")
    return [
      head,
      toc ? `Mục lục:\n${toc}` : "Mục lục: (không có tiêu đề Điều/Mục)",
      rule,
      "",
      numbered(body, 1),
      cut ? `\n… (đã cắt ở ~${CAP} ký tự; phần còn lại xem bằng document_read với section = tên Điều/Mục trong mục lục)` : "",
    ].join("\n")
  },
})

const editSchema = tool.schema.object({
  op: tool.schema.enum(["replace", "insert_after", "insert_before", "delete", "replace_section"]).describe(
    "replace = thay đoạn `find` (hoặc cả `section`) bằng `text`; insert_after / insert_before = chèn `text` sau / trước đoạn `find` hoặc cả `section`; delete = xóa đoạn `find` hoặc cả `section` (VD 'Điều 7', 'Điều 5 khoản 3'); replace_section = viết lại toàn bộ một mục (`section`), giữ tiêu đề nếu `text` không có tiêu đề",
  ),
  find: tool.schema.string().optional().describe("Đoạn NGUYÊN VĂN cần định vị (chép từ document_read, không kèm số dòng), phải duy nhất trong tài liệu; ngắn gọn nhưng đủ phân biệt. Chèn cả dòng: find = trọn dòng/khoản. Tài liệu song ngữ: đoạn tiếng Việt (lang='vi'/'both') hoặc tiếng Anh (lang='en')"),
  section: tool.schema.string().optional().describe("Thay cho find khi thao tác cả mục: 'Điều 5', '5.2', 'Điều 5 khoản 2', hoặc chữ trong tiêu đề (song ngữ: 'Điều 5' cũng tìm được 'Article 5')"),
  text: tool.schema.string().optional().describe("Nội dung markdown mới (bỏ trống với delete). Khoản mới: viết đúng định dạng các khoản xung quanh, VD '3. Bên B …'"),
  lang: tool.schema.enum(["vi", "en", "both"]).optional().describe("CHỈ cho tài liệu song ngữ: sửa cột tiếng Việt (vi), cột tiếng Anh (en) hay cả hai (both – find+text cho tiếng Việt, find_en+text_en cho tiếng Anh). Bỏ trống: có find_en/text_en → both; find chỉ có trong bản tiếng Anh → en; delete theo section → both; còn lại → vi"),
  find_en: tool.schema.string().optional().describe("Song ngữ, lang='both': đoạn NGUYÊN VĂN tiếng Anh tương ứng với `find`"),
  text_en: tool.schema.string().optional().describe("Song ngữ, lang='both': nội dung tiếng Anh mới tương ứng với `text`"),
})

export const edit = tool({
  description:
    "SỬA một tài liệu đã có (đã tạo bằng document_create hoặc do người dùng tải lên, có 'mã tài liệu') bằng các thay đổi NHỎ, CÓ ĐÍCH – không viết lại cả văn bản. Gọi document_read trước để lấy nguyên văn `find`. Mỗi thay đổi: {op, find | section, text}. Các thay đổi áp dụng lần lượt; nếu một `find` không có hoặc khớp nhiều chỗ thì KHÔNG lưu gì và trả về đoạn gần giống để thử lại. Thành công → lưu phiên bản mới (mã mới), tạo lại .docx/.pdf và tệp .docx theo dõi thay đổi (Track Changes). Chèn khoản mới thì tự đánh số lại các khoản sau nếu cần (thêm thay đổi replace). Tài liệu SONG NGỮ: mỗi thay đổi có `lang` ('vi' | 'en' | 'both'); nội dung pháp lý phải sửa ở CẢ HAI bản (lang='both' kèm find_en/text_en, hoặc hai thay đổi vi + en) – sửa một bản thì công cụ vẫn lưu nhưng trả về CẢNH BÁO song ngữ.",
  args: {
    id: tool.schema.string().describe("Mã tài liệu cần sửa (phiên bản mới nhất mà người dùng đang xem)"),
    edits: tool.schema.array(editSchema).min(1).describe("Danh sách thay đổi có đích, theo thứ tự áp dụng"),
    note: tool.schema.string().optional().describe("Ghi chú ngắn lý do sửa, VD 'theo yêu cầu: tăng thời hạn thanh toán lên 45 ngày'"),
    formats: tool.schema.array(tool.schema.enum(["docx", "pdf"])).optional().describe("Định dạng cần tạo (mặc định như bản trước)"),
  },
  async execute({ id, edits, note, formats }, context) {
    const sid = context?.sessionID ?? "no-session"
    const parent = findDocumentForSession(sid, id.trim())
    if (!parent) return draftHint(sid, id) ?? `Lỗi: ${NOT_FOUND} (mã ${id}). Không có gì được lưu.`
    const bi = parent.language === "bilingual"
    let oldMd: string, oldEn = ""
    try {
      oldMd = readMarkdown(parent)
      if (bi) oldEn = readMarkdownEn(parent)
    } catch (e: any) {
      return `Lỗi: không đọc được nội dung tài liệu ${id}: ${e?.message ?? e}. Không có gì được lưu.`
    }
    // Models sometimes copy the line-number gutter of document_read into `find` – strip it.
    const gutter = (s?: string) => s?.split("\n").map((l) => l.replace(/^\s*\d+│ ?/, "")).join("\n")
    const clean = (edits as Edit[]).map((e) => ({ ...e, find: gutter(e.find), find_en: gutter(e.find_en) }))
    let result: { markdown: string; en?: string; changes: any[]; warnings: string[]; pending?: Pending[] }
    try {
      if (bi) {
        const pending = Array.isArray(parent.bilingual_pending) ? (parent.bilingual_pending as Pending[]) : []
        const r = applyBilingualEdits(oldMd, oldEn, clean, pending)
        result = { markdown: r.vi, en: r.en, changes: r.changes, warnings: r.warnings, pending: r.pending }
      } else {
        // single-language document: lang / find_en / text_en do not apply
        const r = applyEdits(oldMd, clean.map((e) => ({ op: e.op, find: e.find ?? e.find_en, section: e.section, text: e.text ?? e.text_en })))
        result = { ...r, warnings: [] }
      }
    } catch (e: any) {
      if (e instanceof EditError)
        return [`Lỗi – CHƯA lưu thay đổi nào: ${e.message}`, ...e.candidates.map((c) => `- ${c}`), "Hãy gọi document_read (có thể kèm section) rồi thử lại với `find` nguyên văn và duy nhất."].join("\n")
      throw e
    }
    if (result.markdown.trim() === oldMd.trim() && (!bi || (result.en ?? "").trim() === oldEn.trim())) return "Lỗi: các thay đổi không làm nội dung khác đi – không lưu phiên bản mới."
    const want = formats?.length ? formats : (["docx", "pdf"] as const).filter((f) => parent.files.some((x) => x.format === f))
    const meta = await saveDocument({
      sessionID: sid, title: parent.title, markdown: result.markdown, kind: parent.kind,
      formats: want.length ? [...want] : undefined, sign: parent.sign ?? null, parent, changes: result.changes,
      origin: parent.origin, nationalHeader: parent.national_header ?? (parent.origin === "upload" ? false : parent.kind === "hop-dong"), note,
      language: parent.language ?? "vi",
      ...(bi ? { markdownEn: result.en, prevailing: parent.prevailing ?? "vi", signEn: parent.sign_en ?? null, pending: result.pending } : {}),
    })
    const summary = changesSummary(meta.changes)
    const hasRedline = meta.files.some((f) => f.format === "redline")
    return [
      `Đã sửa "${meta.title}": phiên bản ${meta.version} (mã tài liệu mới: ${meta.id}, sửa từ ${parent.id}) – ${fileList(meta)}${pdfNote(meta)}.`,
      `Thay đổi (${meta.changes.length}):`,
      ...summary.map((s) => `- ${s}`),
      ...result.warnings,
      hasRedline ? `Tệp 'DOCX theo dõi thay đổi' hiển thị từng chỗ thêm/xóa (Track Changes)${bi ? " ngay trong cột tiếng Việt / tiếng Anh tương ứng" : ""} để người dùng duyệt trong Word.` : "",
      "Trong câu trả lời: liệt kê ngắn các chỗ đã sửa và căn cứ pháp lý (nếu thay đổi nội dung pháp lý), nhắc tệp theo dõi thay đổi; không chép lại cả văn bản. Lần sửa tiếp theo dùng mã tài liệu mới.",
      artifactMarker(meta),
    ].filter(Boolean).join("\n")
  },
})
