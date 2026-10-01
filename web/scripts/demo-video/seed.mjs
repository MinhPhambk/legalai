// Seeds the harness (instant replay) with the real recorded conversations; prints chat ids as JSON.
import fs from "node:fs"
import path from "node:path"
const H = process.env.HARNESS_DIR || "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox/demo-harness" // harness data (never production data)
import { login, mode } from "./api.mjs"
const LIB = JSON.parse(fs.readFileSync(path.join(H, "rec", "library.json"), "utf8"))
const userText = (k) => LIB[k].messages.find((m) => m.info.role === "user").parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n")
const clean = (s) => s.split("\nNgôn ngữ giao diện")[0].replace(/^"+/, "")
await mode("instant")
const { call, idle } = await login()
await call("PATCH", "/api/admin/settings", { allowRegistration: false })
const out = {}
const chat = async (key, text, loc = "vi", want) => {
  const id = (await call("POST", "/api/chats", { text }, { "X-UI-Locale": loc })).chat.id
  await idle(id, want)
  out[key] = id
}
const only = (process.env.ONLY || "trade,precedent,coffee,edit,steel,huybo").split(",")
if (only.includes("trade")) await chat("trade", "Thép mạ kẽm của Việt Nam xuất sang Úc có đang bị điều tra phòng vệ thương mại không?")
if (only.includes("precedent")) await chat("precedent", clean(userText("precedent")), "en", (h) => h.followups && !h.followups.pending)
if (only.includes("coffee")) await chat("coffee", userText("coffee").replace(/^"/, "").split(String.fromCharCode(10)).filter((l) => !l.startsWith("Ngôn ngữ giao diện")).join(" ").replace(/"$/, "").trim())
if (only.includes("edit")) await chat("edit", clean(userText("edit")))
if (only.includes("steel")) await chat("steel", clean(userText("steel")))
if (only.includes("huybo")) await chat("huybo", "Khi nào bên mua được huỷ bỏ hợp đồng mua bán hàng hóa?", "vi", (h) => h.followups && !h.followups.pending)
if (process.env.ESCALATE && out[process.env.ESCALATE]) console.error(JSON.stringify(await call("POST", `/api/chats/${out[process.env.ESCALATE]}/escalate`, { turn: 0, urgency: "trung bình", note: "Nhờ chuyên gia xem lại trường hợp hàng giao không đúng chất lượng." })).slice(0, 200))
await mode("video")
console.log(JSON.stringify(out))
