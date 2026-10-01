// Unit test for server/sanitize.mjs (vendor / model / runtime names never reach users) and the reasoning
// gate / streaming scrub in server/events.mjs.   node scripts/test-sanitize.mjs
import assert from "node:assert/strict"
import { scrubText, hasVendorName, GENERIC } from "../server/sanitize.mjs"
import { normalizePart, translateEvent, SessionState, convertHistory } from "../server/events.mjs"

let n = 0
const ok = (m) => console.log(`  ✓ ${m}`, ++n)

const cases = [
  "Tôi là Qwen, một mô hình của Alibaba.",
  "I am DeepSeek-V4 by DeepSeek-AI.",
  "You are powered by the model named qwen3.6-35b-a3b-fp8. The exact model ID is nvidia/deepseek-ai/deepseek-v4.1-flash.",
  "Chạy trên NVIDIA NIM qua GPUStack; runtime opencode serve --port 4096.",
  "Nemotron 3.5 Lightning 30B-A3B và DeepSeek V4.1 Flash",
  "deepseek-ai/deepseek-v4.1-flash",
]
for (const c of cases) {
  const out = scrubText(c)
  assert.ok(!hasVendorName(out), `still leaks: ${out}`)
  assert.doesNotMatch(out, /qwen|deepseek|nvidia|gpustack|nemotron|opencode/i, out)
  assert.ok(out.includes(GENERIC.vi), out)
}
ok("vendor / model / runtime names and ids → generic term (vi)")
assert.equal(scrubText("I run on Qwen.", "en"), `I run on ${GENERIC.en}.`)
ok("English generic term")
assert.equal(scrubText("Tôi là LegalAI, chạy trên mô hình AI do FTU Tech Lab phát triển."), "Tôi là LegalAI, chạy trên mô hình AI do FTU Tech Lab triển khai.")
assert.equal(scrubText("a model developed by FTU Tech Lab", "en"), "a model deployed by FTU Tech Lab")
assert.match(scrubText("FTU Tech Lab tự huấn luyện mô hình này"), /FTU Tech Lab triển khai mô hình/)
ok('"do FTU Tech Lab phát triển / huấn luyện" → "triển khai"; EN developed → deployed')
const legal = "Theo Điều 301 Luật Thương mại 2005 (https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai--26117), mức phạt không quá 8%. Cloudflare, cloud storage, open code review."
assert.equal(scrubText(legal), legal)
ok("ordinary legal text and URLs unchanged")

// reasoning gate
const st = new SessionState()
const rp = { id: "p1", type: "reasoning", text: "You are powered by the model named qwen3.6-35b-a3b-fp8" }
assert.equal(normalizePart(rp, st), null)
assert.equal(normalizePart(rp, st, { reasoning: false }), null)
const shown = normalizePart(rp, st, { reasoning: true })
assert.ok(shown && !hasVendorName(shown.text), JSON.stringify(shown))
ok("reasoning parts stripped unless allowed; scrubbed even when allowed")
const hist = convertHistory([{ info: { id: "m1", role: "assistant", time: {} }, parts: [rp, { id: "p2", type: "text", text: "Tôi là Qwen." }] }], new SessionState())
assert.equal(hist[0].parts.length, 1)
assert.equal(hist[0].parts[0].text, `Tôi là ${GENERIC.vi}.`)
ok("history: reasoning removed, answer scrubbed")

// streaming: deltas are scrubbed with a hold-back so a name split across deltas never reaches the client
const st2 = new SessionState()
st2.roles.set("m1", "assistant")
st2.partKinds.set("t1", "text")
st2.partKinds.set("r1", "reasoning")
const ctx = { reasoning: false, acc: new Map(), locale: "vi" }
let seen = ""
const text = "Xin chào, tôi là trợ lý pháp lý. Tôi chạy trên Qw" + "en3.6-35b-a3b-fp8 và không phải luật sư. Luôn kiểm tra trích dẫn trên trang gốc nhé."
for (const ch of text.match(/.{1,5}/gs)) {
  const out = translateEvent({ type: "message.part.delta", properties: { messageID: "m1", partID: "t1", field: "text", delta: ch } }, st2, ctx)
  if (out?.type === "delta") seen += out.delta
  else if (out?.type === "part") seen = out.part.text
  assert.ok(!/qw|qwen/i.test(seen), `partial leak: ${seen}`)
}
const fin = translateEvent({ type: "message.part.updated", properties: { part: { id: "t1", messageID: "m1", type: "text", text } } }, st2, ctx)
assert.ok(!hasVendorName(fin.part.text) && fin.part.text.includes(GENERIC.vi), fin.part.text)
ok("streamed deltas never show a (partial) vendor name; final part scrubbed")
assert.equal(translateEvent({ type: "message.part.delta", properties: { messageID: "m1", partID: "r1", field: "text", delta: "thinking…" } }, st2, ctx), null)
assert.equal(translateEvent({ type: "message.part.updated", properties: { part: { id: "r1", messageID: "m1", type: "reasoning", text: "x" } } }, st2, ctx), null)
ok("reasoning deltas / parts dropped from SSE when not allowed")
const retry = translateEvent({ type: "session.status", properties: { status: { type: "retry", attempt: 2, message: "NVIDIA API timeout" } } }, st2, ctx)
assert.ok(!JSON.stringify(retry).match(/nvidia/i), JSON.stringify(retry))
ok("retry status carries no provider text")
console.log("\nALL PASSED")
