// diagram_create: a deterministic diagram (Archify JSON IR → validated SVG, see ../lib/archify.ts and the skill
// `archify`) stored as a visual of the session (../lib/visual-store.ts: dual-theme SVG + light / dark PNG + the IR).
// The tool returns a `[[diagram:<id>]]` marker: the model puts that line right after the paragraph the diagram
// illustrates and the web UI renders it inline (sandboxed frame, "Mở toàn màn hình", "Tải PNG / SVG").
import { tool, withUi } from "../lib/ui-meta.ts"
import { ARCHIFY_VERSION, DIAGRAM_TYPES, compileDiagram, type DiagramType } from "../lib/archify.ts"
import { svgToPng } from "../lib/image-proc.ts"
import { diagramMarker, saveVisual } from "../lib/visual-store.ts"

/** The diagram type: the argument when valid, else inferred from the IR's collections (default workflow). */
function inferType(t: unknown, ir: unknown): DiagramType {
  if (DIAGRAM_TYPES.includes(t as DiagramType)) return t as DiagramType
  let o: any = ir
  if (typeof ir === "string") { try { o = JSON.parse(ir) } catch { o = {} } }
  if (DIAGRAM_TYPES.includes(o?.diagram_type)) return o.diagram_type
  if (Array.isArray(o?.participants) || Array.isArray(o?.messages)) return "sequence"
  if (Array.isArray(o?.states) || Array.isArray(o?.transitions)) return "lifecycle"
  if (Array.isArray(o?.stages) || Array.isArray(o?.flows)) return "dataflow"
  if (Array.isArray(o?.components) || Array.isArray(o?.connections)) return "architecture"
  return "workflow"
}

export const create = tool({
  description:
    "VẼ SƠ ĐỒ (quy trình, trình tự, cơ cấu các bên, luồng chứng từ / thanh toán, vòng đời trạng thái) từ Archify JSON IR – biên dịch tất định, kiểm tra bố cục, lưu SVG + PNG. Đọc skill `archify` trước để có mẫu IR cho từng loại. type: workflow (quy trình nhiều bên theo làn: thủ tục khởi kiện, điều tra chống bán phá giá, giao kết – thực hiện hợp đồng) | sequence (trình tự thông điệp giữa các bên: luồng L/C, trao đổi chứng từ) | lifecycle (trạng thái – chuyển trạng thái: hiệu lực hợp đồng, tình trạng vụ việc) | dataflow (luồng hồ sơ / chứng từ qua các giai đoạn) | architecture (cơ cấu các bên, quan hệ sở hữu / hợp đồng). Nhãn viết bằng ngôn ngữ câu trả lời, ngắn (≤ 4–5 từ; chi tiết để ở sublabel), ≤ 12 nút chính. Công cụ tự sửa lỗi cơ học (thuộc tính thừa, cột vượt giới hạn, nhãn dài…) và báo lại; lỗi còn lại → sửa IR và gọi lại (tối đa 2 lần), không được thì dùng khối ```mermaid. KHÔNG tự viết marker trước khi gọi công cụ. Thành công → trả dòng `[[diagram:<mã>]]` để chép NGUYÊN VĂN vào câu trả lời, trên một dòng riêng, ngay sau đoạn văn mà sơ đồ minh hoạ. Căn cứ pháp lý / nguồn vẫn phải nêu trong phần chữ của câu trả lời.",
  args: {
    type: tool.schema.enum(DIAGRAM_TYPES as unknown as [string, ...string[]]).optional().describe("Loại sơ đồ: workflow | sequence | lifecycle | dataflow | architecture (bỏ trống → suy từ ir, mặc định workflow)"),
    ir: tool.schema.any().describe("Archify JSON IR (đối tượng JSON, hoặc chuỗi JSON) theo mẫu trong skill `archify`: meta + lanes/nodes/edges (workflow), participants/messages (sequence), lanes/states/transitions (lifecycle), stages/nodes/flows (dataflow), components/connections (architecture). Không cần schema_version / diagram_type – công cụ tự điền. Viết đơn giản {lanes:[{id,label}], nodes:[{id,label,sublabel,lane,col}], edges:[{from,to,label}]} cũng được: thiếu col thì công cụ tự xếp theo thứ tự các cạnh"),
    title: tool.schema.string().describe("Tiêu đề sơ đồ bằng ngôn ngữ câu trả lời, VD 'Quy trình điều tra chống bán phá giá của Hoa Kỳ'"),
    lang: tool.schema.enum(["vi", "en"]).optional().describe("Ngôn ngữ nhãn trong sơ đồ = ngôn ngữ câu trả lời (mặc định vi)"),
    caption: tool.schema.string().optional().describe("Chú thích ngắn hiện dưới sơ đồ (tuỳ chọn), VD 'Các mốc thời hạn theo 19 U.S.C. 1673a–1673d'"),
  },
  async execute({ type: typeArg, ir, title, lang, caption }, context) {
    const l = lang === "en" ? "en" : "vi"
    const type = inferType(typeArg, ir)
    const r = await compileDiagram(type as DiagramType, ir, { title, lang: l })
    const fixLines = (f: string[]) => (f.length ? [`Đã tự sửa (${f.length}):`, ...f.slice(0, 15).map((x) => `- ${x}`)] : [])
    if (!r.ok) {
      const out = [
        `Lỗi – CHƯA tạo sơ đồ (${r.stage === "input" ? "IR không hợp lệ" : r.stage === "check" ? "bố cục chưa đạt kiểm tra" : r.stage === "export" ? "không xuất được hình" : "trình biên dịch từ chối IR"}):`,
        ...r.errors.map((e) => `- ${e}`),
        ...fixLines(r.fixes),
        "Sửa đúng các mục trên rồi gọi lại diagram_create với IR đã sửa (giữ nguyên phần đúng). Sau 2 lần vẫn lỗi: bỏ sơ đồ Archify, dùng khối ```mermaid (flowchart / sequenceDiagram / timeline) trong câu trả lời thay thế.",
      ].join("\n")
      return withUi(out, { res: { t: "error", code: "diagram_invalid" } })
    }
    let light: Buffer | null = null, dark: Buffer | null = null
    try {
      light = await svgToPng(r.svg, "light", r.width, r.height)
      dark = await svgToPng(r.svg, "dark", r.width, r.height)
    } catch { /* PNG export is a convenience – the SVG is the artifact */ }
    const meta = saveVisual({
      sessionID: context?.sessionID,
      kind: "diagram",
      title: String(r.ir.meta.title),
      caption: String(caption ?? "").trim().slice(0, 300),
      lang: l,
      width: r.width,
      height: r.height,
      diagram_type: type,
      checks: r.checks,
      generator: `archify ${ARCHIFY_VERSION}`,
      blobs: [
        { role: "svg", format: "svg", data: r.svg },
        ...(light ? [{ role: "png-light" as const, format: "png" as const, data: light }] : []),
        ...(dark ? [{ role: "png-dark" as const, format: "png" as const, data: dark }] : []),
        { role: "ir", format: "json", data: JSON.stringify(r.ir, null, 1) },
      ],
    })
    const out = [
      `Đã tạo sơ đồ "${meta.title}" (mã sơ đồ: ${meta.id}; ${type}, ${r.width}×${r.height}; Archify ${ARCHIFY_VERSION}, kiểm tra bố cục ${r.checks.passed}/${r.checks.total} đạt${r.checks.warnings ? `, ${r.checks.warnings} cảnh báo nhẹ` : ""}).`,
      ...fixLines(r.fixes),
      "Chép NGUYÊN VĂN dòng sau vào câu trả lời, trên một dòng riêng, ngay sau đoạn văn mà sơ đồ minh hoạ (giao diện web hiện sơ đồ tại đó; tối đa ~3 hình / câu trả lời). Giải thích từng bước và nêu căn cứ / nguồn trong phần chữ, không chỉ trong sơ đồ:",
      diagramMarker(meta.id),
    ].join("\n")
    return withUi(out, { res: { t: "title", v: meta.title, lang: l }, visual: { id: meta.id, kind: "diagram" } })
  },
})
