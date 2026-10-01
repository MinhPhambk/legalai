// draft_plan / draft_write / draft_check / draft_fix / draft_assemble / draft_status: staged drafting of LONG
// documents (detailed contracts with many Điều and annexes, long reports) like a professional drafting team –
// PLAN → WRITE SECTIONS IN PARALLEL → CROSS-CHECK → FIX → ASSEMBLE. The orchestration (parallel writers,
// deterministic checks, reviewer pass, targeted rewrites) runs inside the tools (../lib/drafting.ts), so it does
// not depend on the chat model emitting parallel calls. Short documents keep using document_create directly.
// Every tool emits the progress object documented in docs/DRAFTING.md (tool metadata key `draft` + progress.json).
import { tool } from "@opencode-ai/plugin"
import {
  assembleDraft, checkDraft, createPlan, emit, fixDraft, loadDraft, loadIssues, planSummary, progressOf, progressTitle, saveDraft, writeSections,
  type Draft, type Issue,
} from "../lib/drafting.ts"
import { sessionModel } from "../lib/llm.ts"

const z = tool.schema
const NOT_FOUND = (id: string) => `Lỗi: không tìm thấy dự thảo ${id} trong cuộc trò chuyện này (mã dự thảo dạng d-YYYYMMDD-xxxxxx, lấy từ kết quả draft_plan).`
const sec = (ms: number) => `${(ms / 1000).toFixed(0)} giây`
const result = (d: Draft, output: string, issues?: Issue[]) => {
  const p = progressOf(d, issues)
  return { title: progressTitle(p), output, metadata: { draft: p } }
}
const issueLine = (i: Issue) => `- ${i.id} [${i.severity}] ${i.section ? `${i.section}: ` : ""}${i.message}${i.suggested_fix ? ` → ${i.suggested_fix}` : ""}`

export const plan = tool({
  description:
    "BƯỚC 1 soạn văn bản DÀI theo nhóm (skill `long-drafting`): lập dàn ý dự thảo sau khi ĐÃ tra cứu căn cứ bằng vbpl_* (mở đúng Điều bằng vbpl_article). Dùng khi hợp đồng / báo cáo dự kiến > ~8 Điều hoặc > ~2.500 từ, người dùng yêu cầu 'chi tiết / đầy đủ / dài', hoặc có nhiều phụ lục; văn bản ngắn thì dùng document_create. Truyền danh sách mục theo thứ tự (Điều 1..N rồi Phụ lục 1..M), mỗi mục: key, heading, purpose, must_include (các nội dung bắt buộc), legal_basis_urls ('URL Điều N' của các điều luật đã mở trong phiên). Công cụ kiểm tra dàn ý, gom đoạn luật đã tra cho từng mục thành bộ căn cứ (người soạn chỉ được dẫn các đoạn này) và trả về mã dự thảo. Tiếp theo: draft_write.",
  args: {
    title: z.string().describe("Tên văn bản, VD 'Hợp đồng đại lý phân phối độc quyền'"),
    title_en: z.string().optional().describe("Tên tiếng Anh (song ngữ / tiếng Anh)"),
    kind: z.enum(["hop-dong", "bao-cao", "van-ban"]).describe("hop-dong = hợp đồng (Điều + Phụ lục, Quốc hiệu, khối chữ ký); bao-cao = báo cáo; van-ban = khác"),
    language: z.enum(["vi", "en", "bilingual"]).optional().describe("vi (mặc định) | en | bilingual (song ngữ Việt – Anh, hai cột)"),
    prevailing: z.enum(["vi", "en"]).optional().describe("Song ngữ: bản ưu tiên (mặc định vi)"),
    brief: z.string().describe("Tóm tắt yêu cầu của người dùng và bối cảnh giao dịch (hàng hóa, khu vực, thời hạn, mong muốn chính)"),
    user_side: z.string().optional().describe("Bên người dùng đại diện, VD 'Bên A – bên giao đại lý'. Người soạn và người rà soát bảo vệ quyền lợi bên này"),
    sections: z.array(z.object({
      key: z.string().describe("Mã mục duy nhất, chữ thường không dấu, VD 'thanh-toan'"),
      heading: z.string().describe("Tên Điều / Phụ lục, VD 'Thanh toán' hoặc 'Điều 7. Thanh toán' hoặc 'Phụ lục 1. Danh mục sản phẩm' (số phải đúng thứ tự; bỏ số thì công cụ tự đánh)"),
      heading_en: z.string().optional().describe("Tên tiếng Anh (song ngữ), VD 'Payment'"),
      purpose: z.string().optional().describe("Mục đích / phạm vi của mục này (1–2 câu)"),
      must_include: z.array(z.string()).optional().describe("Các nội dung BẮT BUỘC phải có (bắt buộc với điều khoản chủ yếu: đối tượng, giá, thanh toán, giao nhận, độc quyền, chỉ tiêu, phạt, bồi thường, chấm dứt, tranh chấp…)"),
      legal_basis_urls: z.array(z.string()).optional().describe("Căn cứ đã MỞ trong phiên này, dạng 'https://vbpl.vn/… Điều 301' (có thể nhiều Điều: '… Điều 300, 301')"),
      words: z.number().optional().describe("Độ dài mục tiêu (từ) nếu khác mặc định"),
    })).describe("Các mục theo đúng thứ tự: Điều 1..N rồi Phụ lục 1..M (tối đa 40)"),
    glossary: z.array(z.object({ term: z.string(), definition: z.string(), en: z.string().optional() })).optional().describe("Bảng thuật ngữ định nghĩa (viết hoa đúng như sẽ dùng, VD 'Sản Phẩm', 'Khu Vực Độc Quyền')"),
    parties: z.array(z.object({
      role: z.string().describe("Vai trò, VD 'Bên giao đại lý'"),
      short: z.string().optional().describe("Tên viết tắt (mặc định Bên A, Bên B, …)"),
      name_placeholder: z.string().optional().describe("Tên doanh nghiệp hoặc '…'"),
      role_en: z.string().optional().describe("Vai trò tiếng Anh, VD 'Principal'"),
    })).optional().describe("Các bên (hợp đồng: bắt buộc ≥ 2)"),
    facts: z.record(z.string(), z.any()).optional().describe("Thông tin đã biết / đã thống nhất (hàng hóa, khu vực, thời hạn, mức phạt, thời hạn thanh toán, chỉ tiêu…) – người soạn dùng đúng các giá trị này"),
    style: z.object({
      detail: z.enum(["ngắn", "chuẩn", "chi tiết", "rất chi tiết"]).optional().describe("Mức chi tiết (mặc định 'chi tiết' ≈ 450 từ/điều)"),
      words_per_section: z.number().optional(),
      notes: z.string().optional().describe("Ghi chú văn phong"),
    }).optional(),
  },
  async execute(args, context) {
    const r = createPlan(context?.sessionID ?? "no-session", { ...args, model: sessionModel(context) } as any)
    if (!r.draft) return ["Lỗi – CHƯA lập dàn ý:", ...r.errors.map((e) => `- ${e}`), ...(r.warnings.length ? ["Lưu ý:", ...r.warnings.map((w) => `- ${w}`)] : []), "Sửa rồi gọi lại draft_plan."].join("\n")
    const d = r.draft
    d.timings.plan = Date.now() - d.startedAt
    saveDraft(d)
    emit(d, context, [])
    return result(d, planSummary(d), [])
  },
})

export const write = tool({
  description:
    "BƯỚC 2: soạn SONG SONG các mục của dự thảo (mặc định mọi mục chưa viết / lỗi), mỗi người soạn nhận dàn ý, thuật ngữ, các bên, thông tin đã biết và CHỈ bộ căn cứ của mục mình; tự kiểm tra dẫn chiếu luật ngoài bộ căn cứ và viết lại nếu cần. Tiến độ từng mục hiện trên giao diện. Tiếp theo: draft_check.",
  args: {
    draftId: z.string().describe("Mã dự thảo từ draft_plan"),
    sections: z.array(z.string()).optional().describe("Chỉ viết (lại) các key này; mặc định mọi mục pending / failed"),
    parallel: z.number().int().min(1).max(6).optional().describe("Số mục soạn đồng thời (1–6, mặc định 4)"),
  },
  async execute({ draftId, sections, parallel }, context) {
    const d = loadDraft(context?.sessionID ?? "no-session", draftId)
    if (!d) return NOT_FOUND(draftId)
    if (!d.model) d.model = sessionModel(context)
    const t0 = Date.now()
    const done = await writeSections(d, sections, { parallel, signal: context?.abort, context })
    const failed = done.filter((s) => s.status === "failed")
    const words = d.sections.reduce((a, s) => a + (s.wordCount ?? 0), 0)
    const out = [
      `Đã soạn ${done.length - failed.length}/${done.length} mục của "${d.title}" trong ${sec(Date.now() - t0)} (song song ${Math.min(6, parallel ?? 4)}); tổng ≈ ${words.toLocaleString("vi-VN")} từ.`,
      ...done.map((s) => `- ${s.label}. ${s.heading} [${s.key}]: ${s.status === "failed" ? `LỖI (${s.error})` : `${s.wordCount} từ${s.truncated ? " – có thể bị cắt" : ""}`}`),
      failed.length ? `BƯỚC TIẾP THEO: gọi draft_write({draftId:"${d.draftId}", sections:${JSON.stringify(failed.map((s) => s.key))}}).` : `BƯỚC TIẾP THEO: gọi draft_check({draftId:"${d.draftId}"}) (không trả lời người dùng trước khi có tài liệu).`,
    ].join("\n")
    return result(d, out)
  },
})

const next = (call: string, why = "") => `BƯỚC TIẾP THEO: gọi ${call}${why ? ` ${why}` : ""}. Không kết thúc lượt / không trả lời người dùng trước khi có tài liệu (thẻ tài liệu).`
const openOf = (issues: Issue[]) => issues.filter((i) => (i.status === "open" || i.status === "remaining") && i.severity !== "gợi ý")

/** Assemble + the summary text (used by draft_assemble and the automatic assembly of draft_check / draft_fix). */
async function assembleText(d: Draft, formats: ("docx" | "pdf")[] | undefined, context: any): Promise<{ ok: boolean; text: string; issues?: Issue[] }> {
  let r
  try {
    r = await assembleDraft(d, formats, { context })
  } catch (e: any) {
    d.phase = "failed"
    d.error = String(e?.message ?? e)
    saveDraft(d)
    emit(d, context)
    return { ok: false, text: `Lỗi – CHƯA tạo tài liệu: ${d.error}\n${next(`draft_status({draftId:"${d.draftId}"})`, "để xem mục nào thiếu, sửa rồi gọi lại draft_assemble")}` }
  }
  const { meta, marker, md, issues, notes } = r
  const open = issues.filter((i) => i.status === "open" || i.status === "remaining")
  const words = md.replace(/[#*_>|-]/g, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0
  const arts = d.sections.filter((s) => s.type === "article").length, ann = d.sections.filter((s) => s.type === "annex").length
  const t = d.timings
  const text = [
    `Đã tạo tài liệu "${meta.title}" (mã tài liệu: ${meta.id}, phiên bản ${meta.version}${meta.parent_id ? `, ghép lại từ ${meta.parent_id}` : ""}${d.language === "bilingual" ? " – song ngữ Việt | Anh" : d.language === "en" ? " – tiếng Anh" : ""}): ${meta.files.map((f) => (f.format === "redline" ? "DOCX theo dõi thay đổi" : f.format.toUpperCase())).join(", ")}${meta.pdf_error ? " – không tạo được PDF" : ""}.`,
    `Cấu trúc: ${d.kind === "hop-dong" ? `${arts} Điều${ann ? ` + ${ann} Phụ lục` : ""}` : `${d.sections.length} mục`}; ≈ ${words.toLocaleString("vi-VN")} từ${notes.length ? `; ${notes.join("; ")}` : ""}.`,
    `Kiểm tra: ${issues.length} vấn đề đã phát hiện, ${issues.filter((i) => i.status === "fixed").length} đã sửa; còn ${open.filter((i) => i.severity === "lỗi").length} lỗi, ${open.filter((i) => i.severity === "cảnh báo").length} cảnh báo, ${open.filter((i) => i.severity === "gợi ý").length} gợi ý.`,
    ...open.filter((i) => i.severity !== "gợi ý").slice(0, 15).map(issueLine),
    `Thời gian: dàn ý ${sec(t.plan ?? 0)}, soạn ${sec(t.write ?? 0)}, rà soát ${sec(t.check ?? 0)}, sửa ${sec(t.fix ?? 0)}, ghép ${sec(t.assemble ?? 0)}.`,
    "Căn cứ pháp lý trong văn bản đã được draft_check đối chiếu với bộ căn cứ đã tra. BƯỚC TIẾP THEO: viết câu trả lời ngắn – tóm tắt cấu trúc, các điểm chính có lợi cho bên người dùng, các chỗ cần điền (…) / [cần thương lượng], căn cứ chính (kèm link đã mở) và các cảnh báo còn lại; KHÔNG chép lại toàn văn; chỉ nêu căn cứ đã mở bằng công cụ trong phiên (bộ căn cứ ở draft_plan). BẮT BUỘC gọi grounding_check trên bản nháp câu trả lời trước khi gửi (skill citation-check) và ghi đúng độ tin cậy nó trả về. Sửa sau: document_read → document_edit với mã tài liệu này (không gọi lại draft_* trừ khi người dùng muốn viết lại cả điều).",
    marker,
  ].join("\n")
  return { ok: true, text, issues }
}

export const check = tool({
  description:
    "BƯỚC 3: rà soát chéo toàn bộ dự thảo – kiểm tra bằng máy (đánh số Điều/khoản/điểm, dẫn chiếu 'khoản 2 Điều 5' / 'Phụ lục 1' tới đúng mục có thật, thuật ngữ định nghĩa dùng nhất quán, thuật ngữ viết hoa chưa định nghĩa, tên các bên, trích dẫn nguyên văn và văn bản luật phải có trong bộ căn cứ, mức phạt ≤ 8%, mâu thuẫn tỷ lệ / thời hạn giữa các điều, số tiền bằng chữ, cấu trúc song ngữ) + hai lượt luật sư thẩm định (mâu thuẫn, thiếu nội dung bắt buộc, bất lợi cho bên người dùng, câu chữ mơ hồ). Không còn lỗi → TỰ GHÉP thành tài liệu (assemble, mặc định true) và trả về thẻ tài liệu. Còn lỗi → tiếp theo draft_fix.",
  args: {
    draftId: z.string().describe("Mã dự thảo"),
    review: z.boolean().optional().describe("Chạy lượt thẩm định bằng mô hình (mặc định true); false = chỉ kiểm tra bằng máy"),
    assemble: z.boolean().optional().describe("Không còn lỗi thì tự ghép thành tài liệu (mặc định true)"),
    formats: z.array(z.enum(["docx", "pdf"])).optional().describe("Định dạng khi tự ghép (mặc định docx + pdf)"),
  },
  async execute({ draftId, review, assemble: auto, formats }, context) {
    const d = loadDraft(context?.sessionID ?? "no-session", draftId)
    if (!d) return NOT_FOUND(draftId)
    if (!d.model) d.model = sessionModel(context)
    const t0 = Date.now()
    const issues = await checkDraft(d, { review, signal: context?.abort, context })
    const by = (s: string) => issues.filter((i) => i.severity === s)
    const head = [
      `Rà soát "${d.title}" xong trong ${sec(Date.now() - t0)}: ${by("lỗi").length} lỗi, ${by("cảnh báo").length} cảnh báo, ${by("gợi ý").length} gợi ý (máy: ${issues.filter((i) => i.source === "auto").length}, thẩm định: ${issues.filter((i) => i.source === "review").length}).`,
      ...["lỗi", "cảnh báo"].flatMap((s) => by(s).slice(0, 40).map(issueLine)),
      by("gợi ý").length ? `Gợi ý (${by("gợi ý").length}): ${by("gợi ý").slice(0, 12).map((i) => `${i.id} ${i.section ?? ""}: ${i.message.slice(0, 90)}`).join(" | ")}` : "",
    ].filter(Boolean)
    if (by("lỗi").length) {
      head.push(next(`draft_fix({draftId:"${d.draftId}"})`, "(sửa mọi lỗi + cảnh báo rồi TỰ GHÉP tài liệu; có thể truyền issues:[mã] để chọn, bỏ các mục thẩm định không đúng)"))
      return result(d, head.join("\n"), issues)
    }
    if (auto === false) {
      head.push(next(`draft_assemble({draftId:"${d.draftId}"})`, by("cảnh báo").length ? "(không còn lỗi; cảnh báo chỉ sửa khi người dùng yêu cầu: draft_fix với issues:[mã])" : ""))
      return result(d, head.join("\n"), issues)
    }
    head.push("Không còn lỗi → tự ghép thành tài liệu" + (by("cảnh báo").length ? " (các cảnh báo được nêu trong câu trả lời; chỉ sửa khi người dùng yêu cầu)." : "."))
    const a = await assembleText(d, formats, context)
    return result(d, [...head, a.text].join("\n"), a.issues ?? issues)
  },
})

export const fix = tool({
  description:
    "BƯỚC 4: sửa dự thảo theo danh sách vấn đề của draft_check – chỉ viết lại (song song) các mục có vấn đề, các mục khác giữ nguyên từng byte; kiểm tra lại bằng máy, tự sửa thêm tối đa 2 vòng, rồi TỰ GHÉP thành tài liệu (assemble, mặc định true) và trả về thẻ tài liệu. Mặc định sửa mọi lỗi + cảnh báo còn mở khi còn lỗi; nếu đã hết lỗi thì KHÔNG sửa tiếp cảnh báo (trừ khi truyền `issues`) mà ghép ngay.",
  args: {
    draftId: z.string().describe("Mã dự thảo"),
    issues: z.array(z.string()).optional().describe("Mã vấn đề cần sửa (VD ['A3','R2']); mặc định mọi lỗi + cảnh báo còn mở (chỉ khi còn lỗi)"),
    parallel: z.number().int().min(1).max(6).optional().describe("Số mục sửa đồng thời (mặc định 4)"),
    assemble: z.boolean().optional().describe("Sửa xong thì tự ghép thành tài liệu (mặc định true)"),
    formats: z.array(z.enum(["docx", "pdf"])).optional().describe("Định dạng khi tự ghép (mặc định docx + pdf)"),
  },
  async execute({ draftId, issues: ids, parallel, assemble: auto, formats }, context) {
    const d = loadDraft(context?.sessionID ?? "no-session", draftId)
    if (!d) return NOT_FOUND(draftId)
    if (!d.model) d.model = sessionModel(context)
    const before = loadIssues(d)
    if (!before.length) return `Dự thảo ${draftId} chưa được rà soát.\n${next(`draft_check({draftId:"${d.draftId}"})`)}`
    const errorsOpen = before.filter((i) => i.status === "open" && i.severity === "lỗi").length
    const lines: string[] = []
    let issues = before
    if (!ids?.length && !errorsOpen) {
      lines.push(`Dự thảo "${d.title}" không còn lỗi – không sửa thêm cảnh báo (chỉ sửa khi người dùng yêu cầu, truyền issues:[mã]).`)
    } else {
      const t0 = Date.now()
      const r = await fixDraft(d, ids, { parallel, signal: context?.abort, context })
      issues = r.issues
      const open = openOf(r.issues)
      lines.push(
        `Đã sửa "${d.title}" trong ${sec(Date.now() - t0)}: viết lại ${r.fixedSections.length} mục (${r.fixedSections.join(", ") || "không có"}); ${r.issues.filter((i) => i.status === "fixed").length} vấn đề đã xử lý.`,
        ...r.log.map((l) => `- ${l}`),
        open.length ? `Còn ${open.length} lỗi / cảnh báo:` : "Không còn lỗi / cảnh báo mở (kiểm tra máy).",
        ...open.slice(0, 30).map(issueLine),
        ...(r.unassigned.length ? [`Không gắn được vào mục nào (nêu trong câu trả lời / xử lý thủ công): ${r.unassigned.map((i) => i.id).join(", ")}`] : []),
      )
    }
    if (auto === false) {
      lines.push(next(`draft_assemble({draftId:"${d.draftId}"})`))
      return result(d, lines.join("\n"), issues)
    }
    const a = await assembleText(d, formats, context)
    return result(d, [...lines, a.text].join("\n"), a.issues ?? issues)
  },
})

export const assemble = tool({
  description:
    "BƯỚC 5 (draft_check / draft_fix đã tự ghép khi assemble=true – chỉ gọi khi cần ghép lại hoặc định dạng khác): ghép các mục theo thứ tự dàn ý thành văn bản hoàn chỉnh (chuẩn hóa tiêu đề và số Điều, Quốc hiệu – Tiêu ngữ, phần căn cứ – các bên, khối chữ ký, các Phụ lục sau khối chữ ký; song ngữ: hai cột + điều khoản ngôn ngữ) rồi tạo TỆP .docx / .pdf như document_create (có mã tài liệu; ghép lại = phiên bản mới). Trả về tóm tắt và thẻ tài liệu.",
  args: {
    draftId: z.string().describe("Mã dự thảo"),
    formats: z.array(z.enum(["docx", "pdf"])).optional().describe("Định dạng (mặc định cả docx và pdf)"),
  },
  async execute({ draftId, formats }, context) {
    const d = loadDraft(context?.sessionID ?? "no-session", draftId)
    if (!d) return NOT_FOUND(draftId)
    const a = await assembleText(d, formats, context)
    return result(d, a.text, a.issues)
  },
})

export const status = tool({
  description: "Xem trạng thái một dự thảo dài (dàn ý, tiến độ từng mục, vấn đề còn mở, tài liệu đã tạo) – dùng khi tải lại trang hoặc tiếp tục một dự thảo dở dang.",
  args: { draftId: z.string().describe("Mã dự thảo") },
  async execute({ draftId }, context) {
    const d = loadDraft(context?.sessionID ?? "no-session", draftId)
    if (!d) return NOT_FOUND(draftId)
    const issues = loadIssues(d)
    const p = progressOf(d, issues)
    const open = openOf(issues)
    const errs = open.filter((i) => i.severity === "lỗi").length
    const id = `{draftId:"${d.draftId}"}`
    const step = d.phase === "done" && d.document
      ? `Đã có tài liệu ${d.document.id} – viết câu trả lời (grounding_check trước khi gửi); sửa sau bằng document_read → document_edit.`
      : d.sections.some((s) => s.status === "pending" || s.status === "failed") ? next(`draft_write(${id})`)
        : !issues.length ? next(`draft_check(${id})`)
          : errs ? next(`draft_fix(${id})`) : next(`draft_assemble(${id})`)
    const out = [
      `Dự thảo "${d.title}" (${d.draftId}) – giai đoạn: ${d.phase}; ${d.sections.length} mục; vấn đề mở: ${p.issues.errors} lỗi, ${p.issues.warnings} cảnh báo, ${p.issues.suggestions} gợi ý.${d.document ? ` Tài liệu: ${d.document.id}.` : " CHƯA ghép thành tài liệu."}`,
      ...d.sections.map((s) => `- ${s.label}. ${s.heading} [${s.key}]: ${s.status}${s.wordCount ? `, ${s.wordCount} từ` : ""}${s.error ? ` (${s.error})` : ""}`),
      ...open.slice(0, 20).map(issueLine),
      step,
    ].join("\n")
    emit(d, context, issues)
    return result(d, out, issues)
  },
})
