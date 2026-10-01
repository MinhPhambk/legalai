// One-off: generate follow-up suggestions for two recorded answers with the platform's own generator
// (server/followups.mjs → the configured model; keys stay inside that module). Scratch DB only.
import fs from "node:fs"
import path from "node:path"
const H = process.env.HARNESS_DIR || "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox/demo-harness" // harness data (never production data)
process.env.WEB_DB_PATH = new URL("./scratch-followups.db", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const { generateFollowups } = await import("file:///C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/web/server/followups.mjs")
const LIB = JSON.parse(fs.readFileSync(path.join(H, "rec", "library.json"), "utf8"))
const out = {}
for (const [k, loc] of [["huybo", "vi"], ["precedent", "en"]]) {
  const msgs = LIB[k].messages
  const question = msgs.find((m) => m.info.role === "user").parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").split("\nNgôn ngữ giao diện")[0]
  const answer = msgs.filter((m) => m.info.role === "assistant").at(-1).parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")
  out[k] = await generateFollowups({ fullModel: "", question, answer, locale: loc, n: 3 })
  console.log(k, out[k])
}
fs.writeFileSync(path.join(H, "rec", "followups.json"), JSON.stringify(out, null, 1))
