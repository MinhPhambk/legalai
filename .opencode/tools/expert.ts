// expert_escalate: turns "khuyến nghị tham vấn luật sư" into a real hand-off. Creates an escalation
// request in .sandbox/escalations/ (one JSON file per request) that the web platform shows to users with
// the expert role; the requester sees its status and the expert's reply in their chat.
import { tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { loadEvidence } from "../lib/evidence.ts"

// XDG_CACHE_HOME is <project>/.sandbox/cache (set by run.sh) → escalations live in <project>/.sandbox/escalations
const dir = () => path.join(process.env.XDG_CACHE_HOME ?? ".", "..", "escalations")

export const escalate = tool({
  description:
    "Chuyển câu hỏi / vụ việc cho chuyên gia pháp lý (luật sư) của nền tảng. Dùng khi: độ tin cậy từ grounding_check là THẤP; có tranh chấp đang hoặc sắp khởi kiện/trọng tài; giá trị lớn; đang bị điều tra phòng vệ thương mại với hạn chót gần; yếu tố nước ngoài phức tạp; dấu hiệu vi phạm hình sự/hành chính; hoặc người dùng yêu cầu. Tạo yêu cầu thật (có mã) kèm tóm tắt để chuyên gia xử lý; KHÔNG đưa bí mật không cần thiết vào tóm tắt.",
  args: {
    reason: tool.schema.string().describe("Lý do chuyển chuyên gia (ngắn, VD 'Tranh chấp sắp khởi kiện, giá trị hợp đồng lớn')"),
    summary: tool.schema.string().describe("Tóm tắt vụ việc và câu hỏi cho chuyên gia: bối cảnh, điều đã tra được (kèm căn cứ), điểm còn chưa chắc"),
    // Wording shown to people: "Độ khẩn" Thường / Sớm / Gấp / Khẩn – never Thấp / Trung bình / Cao (those are the
    // confidence levels). Stored values stay "thấp" / "trung bình" / "cao" / "khẩn" (web/server/experts.mjs).
    urgency: tool.schema.enum(["thường", "sớm", "gấp", "khẩn"]).describe("Độ khẩn: thường (không có hạn chót gần) · sớm (nên xử lý sớm) · gấp (hạn chót gần hoặc rủi ro lớn) · khẩn (hạn chót trong vài ngày)"),
    deadline: tool.schema.string().optional().describe("Hạn chót nếu có (dd/mm/yyyy), VD hạn trả lời bản câu hỏi điều tra"),
    topic: tool.schema.enum(["hợp đồng", "phòng vệ thương mại", "thương mại quốc tế", "tranh chấp", "khác"]).optional(),
  },
  async execute({ reason, summary, urgency: shown, deadline, topic }, context) {
    const urgency = ({ thường: "thấp", sớm: "trung bình", gấp: "cao", khẩn: "khẩn" } as Record<string, string>)[shown] ?? (["thấp", "trung bình", "cao", "khẩn"].includes(shown) ? shown : "trung bình")
    fs.mkdirSync(dir(), { recursive: true })
    const now = new Date()
    const day = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).replace(/-/g, "")
    const seq = fs.readdirSync(dir()).filter((f) => f.startsWith(`YC-${day}-`)).length + 1
    const id = `YC-${day}-${String(seq).padStart(3, "0")}-${crypto.randomBytes(2).toString("hex")}`
    const grounding = loadEvidence(context?.sessionID).filter((e) => e.source === "grounding").pop()
    const sources = [...new Set(loadEvidence(context?.sessionID).filter((e) => !["warning", "grounding", "safety"].includes(e.source)).map((e) => e.url))].slice(0, 20)
    const ticket = {
      id, sessionID: context?.sessionID ?? null, createdAt: now.toISOString(), status: "mới",
      reason, summary, urgency, deadline: deadline ?? null, topic: topic ?? "khác",
      confidence: grounding ? JSON.parse(grounding.text).level : null, sources, replies: [],
    }
    fs.writeFileSync(path.join(dir(), `${id}.json`), JSON.stringify(ticket, null, 2))
    return [
      `Đã tạo yêu cầu chuyển chuyên gia: ${id} (độ khẩn: ${shown}${deadline ? `, hạn chót ${deadline}` : ""}).`,
      "Trạng thái: mới – chuyên gia pháp lý của nền tảng sẽ xem xét; phản hồi sẽ hiện trong cuộc trò chuyện này.",
      "Hãy báo cho người dùng mã yêu cầu, những gì chuyên gia sẽ xem xét, và việc họ nên chuẩn bị (hợp đồng, chứng từ, thông báo của cơ quan điều tra…).",
    ].join("\n")
  },
})
