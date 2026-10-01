// Read-only export of REAL recorded conversations (copies of the production DBs in ../prodcopy) into a
// replay library for the demo-video harness. Copies the sessions' generated documents and grounding verdicts.
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"
const H = process.env.HARNESS_DIR || "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox/demo-harness" // harness data (never production data)
const PROD_COPY = process.env.PROD_COPY || path.join(H, "prodcopy", "opencode.db") // a COPY of the opencode DB (read-only)
const P = "C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox"
const db = new DatabaseSync(PROD_COPY, { readOnly: true })
process.chdir(H)
const REC = {
  huybo: { sid: "ses_f242722c1ffeVsD2YJMFqZsxo0", match: "huỷ bỏ hợp đồng mua bán|hủy bỏ hợp đồng mua bán" },
  steel: { sid: "ses_f243359beffe6b9z22922QuGE3", match: "công ty bán thép ở Hà Nội" },
  edit: { sid: "ses_f240adbc0ffeKAK28waDAHf4Tb", match: "Sửa giúp 2 chỗ" },
  coffee: { sid: "ses_f23a728bcffeXsZk5NmQLqRf0i", match: "cà phê nhân|green coffee" },
  precedent: { sid: "ses_f2384b8f7ffeMg56XSUGgY3fRM", match: "court precedent" },
  maxpen: { sid: "ses_f238a7ca8ffeoHa8q2FEfVyFwg", match: "maximum penalty for breach" },
  trade: { sid: "ses_f252d6463ffeiVcXHwFsnd7bsk", match: "mạ kẽm" },
}
fs.mkdirSync("rec/outputs", { recursive: true })
fs.mkdirSync("rec/evidence", { recursive: true })
const lib = {}
for (const [k, r] of Object.entries(REC)) {
  const msgs = db.prepare("select id, data from message where session_id=? order by time_created, id").all(r.sid).map((m) => ({
    info: { ...JSON.parse(m.data), id: m.id, sessionID: r.sid },
    parts: db.prepare("select id, data from part where message_id=? order by time_created, id").all(m.id).map((p) => ({ ...JSON.parse(p.data), id: p.id, messageID: m.id, sessionID: r.sid })),
  }))
  lib[k] = { ...r, messages: msgs }
  const out = `${P}/outputs/${r.sid}`
  if (fs.existsSync(out)) fs.cpSync(out, `rec/outputs/${r.sid}`, { recursive: true })
  const ev = `${P}/cache/legalai/evidence/${r.sid}.jsonl`
  if (fs.existsSync(ev)) fs.writeFileSync(`rec/evidence/${r.sid}.jsonl`, fs.readFileSync(ev, "utf8").split("\n").filter((l) => l.includes('"source":"grounding"')).join("\n") + "\n")
  console.log(k, msgs.length, "messages", msgs.reduce((n, m) => n + m.parts.length, 0), "parts")
}
fs.writeFileSync("rec/library.json", JSON.stringify(lib))
console.log("library", (fs.statSync("rec/library.json").size / 1e6).toFixed(1), "MB")
