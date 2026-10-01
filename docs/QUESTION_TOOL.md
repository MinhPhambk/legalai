# opencode `question` tool – protocol for the web UI

Verified empirically on opencode **1.18.32** (`bash run.sh serve`, test instance on port 4299, agent `legal-web`,
models `nvidia/deepseek-ai/deepseek-v4.1-flash` and `qwen/qwen3.6-35b-a3b-fp8`), 2026-09-26/27.
The OpenAPI spec of a running server is at `GET /doc`.

The `question` tool lets the agent pause a run and ask the user 1..n multiple-choice questions (single or multi
select, plus free-text answer). The run **blocks** until the question is answered or rejected.

## 1. Enabling (opt-in)

| Layer | What | Default in this project |
|---|---|---|
| Tool registration | Built-in tool `question` is registered when `OPENCODE_CLIENT` ∈ {`app`,`cli`,`desktop`} **or** `OPENCODE_ENABLE_QUESTION_TOOL` is truthy (Effect `Config.boolean`: `1`/`true`/`yes`/`on`). `serve` leaves `OPENCODE_CLIENT` at its default `cli`, so the tool is registered anyway. | registered |
| Permission | opencode's defaults give every custom agent `question: deny` (only built-in `build`/`plan` allow it). A `*: deny` rule removes the tool from the model's tool list (verified: without the opt-in the model reports it has no `question` tool). | **deny** |
| Per request | `POST /session/{id}/prompt_async` body `tools: {"question": false}` removes it for that run. `web/server/chats.mjs` currently sends this. | off (web) |

`run.sh` / `run.ps1` switch it on **only** when `ND45_QUESTION_TOOL=1` is set in the environment of the launcher:

```bash
if [ "${ND45_QUESTION_TOOL:-0}" = 1 ]; then
  export OPENCODE_ENABLE_QUESTION_TOOL=1 OPENCODE_PERMISSION='{"question":"allow"}'
fi
```

`OPENCODE_PERMISSION` (JSON) is merged by opencode into the `permission` block of `opencode.json`, so `opencode.json`
itself stays unchanged (`question` not listed → default deny). The agent files do not set `question`, so the
global allow applies to both `legal` and `legal-web` (check: `GET /agent` → `permission` contains
`{"permission":"question","pattern":"*","action":"allow"}` after the default deny).

**To turn it on for the web**: spawn serve with `ND45_QUESTION_TOOL=1` in `env` (web/server/opencode.mjs) **and** drop
`tools: { question: false }` from `prompt_async` – only once the UI can answer questions (see §6 risk).

## 2. Event sequence (SSE `GET /event`)

Each SSE `data:` line is `{"id":"evt_…","type":"…","properties":{…}}`. Question events carry
`properties.sessionID` at the top level, so the existing `#dispatch` in `web/server/opencode.mjs` routes them to the
session listeners unchanged.

Normal flow (one assistant message):

1. `message.part.updated` – text part (the model's one-line lead-in, e.g. "Để soạn đúng, tôi cần biết thêm 3 điểm:").
2. `message.part.updated` – tool part, `tool:"question"`, `state.status:"pending"`, `state.input:{}`, `state.raw:""`
   (arguments still streaming; can last many seconds with slow models).
3. **`question.asked`** – the full request (below). `properties.tool.messageID` / `.callID` = the tool part's `messageID` / `callID`.
4. `message.part.updated` – same tool part, `state.status:"running"`, `state.input.questions` = same questions.
   (3 and 4 arrive within ~1 ms; observed order: asked first.)
5. …nothing for the session while waiting (only `server.heartbeat` every 10 s). `GET /session/status` → `{"ses_…":{"type":"busy"}}`.
6. After reply: **`question.replied`** → tool part `completed` → `step-finish` (`reason:"tool-calls"`) → `message.updated`
   (assistant message `finish:"tool-calls"`) → `session.status busy` → a **new assistant message** continues the run.
   After reject: **`question.rejected`** → tool part `error` → `message.updated` → `session.status idle` + `session.idle`
   (the run **ends**, see §4).

### `question.asked` (real sample, Qwen, trimmed to 2 options per question)
```json
{
  "id": "evt_0de9f926f002nFyFhXEpEYVDnt",
  "type": "question.asked",
  "properties": {
    "id": "que_0de9f926f001h5eqf5vum1xo99",
    "sessionID": "ses_f21608580ffetmO8IVoXMX1hJ0",
    "questions": [
      {
        "question": "Bạn cần soạn loại hợp đồng nào?",
        "header": "Loại hợp đồng",
        "options": [
          { "label": "Mua bán hàng hóa (Khuyến nghị)", "description": "Hợp đồng mua bán hàng hóa trong nước giữa hai doanh nghiệp" },
          { "label": "Mua bán quốc tế", "description": "Có bên nước ngoài, dùng Incoterms, luật áp dụng / trọng tài quốc tế" }
        ],
        "multiple": false
      },
      {
        "question": "Hợp đồng soạn bằng ngôn ngữ nào?",
        "header": "Ngôn ngữ",
        "options": [
          { "label": "Tiếng Việt (Khuyến nghị)", "description": "Chỉ bản tiếng Việt" },
          { "label": "Song ngữ Việt – Anh", "description": "Hai cột Việt | Anh, bản tiếng Việt ưu tiên khi có khác biệt" }
        ],
        "multiple": false
      }
    ],
    "tool": { "messageID": "msg_0de9f83e00016YcpNIJAV2caRt", "callID": "call_6dafa017e6994710be5b9de4" }
  }
}
```

Schema (`QuestionRequest`): `id` (`que_…`), `sessionID`, `questions[]`, optional `tool {messageID, callID}`.
`QuestionInfo`: `question` (full text), `header` (≤ 30 chars, advisory), `options[] {label, description}` (both
required), optional `multiple` (bool, default false), optional `custom` (bool, **default true** = show a
"type your own answer" input; hide it only when `custom === false`). Limits are advisory only – models do produce
6 options, a 1-option question, or a catch-all "Khác" option; render whatever arrives.

### Tool part while waiting (from `GET /session/{id}/message`)
```json
{ "id": "prt_0de9f926200156gzBXtKuxkYJ5", "messageID": "msg_0de9f83e00016YcpNIJAV2caRt", "sessionID": "ses_…",
  "type": "tool", "tool": "question", "callID": "call_6dafa017e6994710be5b9de4",
  "state": { "status": "running", "input": { "questions": [ … ] }, "time": { "start": 1790441394802 } } }
```

## 3. Answering

### `GET /question` – pending questions (use after page reload / reconnect)
Returns `QuestionRequest[]` for **all sessions of this server process** (in-memory). Filter by `sessionID`; match to the
tool part by `tool.callID`. Empty after reply / reject. (The `/api/session/{id}/question` and `/api/question/request`
"v2" endpoints returned `{"data":[]}` while a question was pending – do not use them.)

### `POST /question/{requestID}/reply`
Body `{"answers": string[][]}` – one array per question, **in question order**; each inner array = the selected
option labels (multi-select → several labels), or the user's free text as a single string. `[]` = skipped.
Labels are **not validated** against the options – free text is accepted as is. Send UTF-8 JSON (Node `fetch` +
`JSON.stringify` is fine; note: Git-Bash `curl -d` with Vietnamese literals mangles them).

| Response | When |
|---|---|
| `200 true` | answered |
| `404 {"_tag":"QuestionNotFoundError","requestID":"que_…","message":"Question request not found: que_…"}` | unknown / already answered / already rejected id (second reply → 404) |
| `400 {"name":"BadRequest","data":{"message":"Expected a string starting with \"que\" …","kind":"Params"}}` | id not `que…` |
| `400 {"name":"BadRequest","data":{"message":"Expected array, got \"x\" at [\"answers\"]","kind":"Payload"}}` | bad body |

Event:
```json
{"type":"question.replied","properties":{"sessionID":"ses_f215b4a52ffe7USZ9X50xDtFwh","requestID":"que_0dea4cc3200179bES6kZb3SfPq","answers":[["Hoa Kỳ","EU"],[]]}}
```

Resulting tool part (`completed`) – this is also what history shows later:
```json
{ "type": "tool", "tool": "question", "callID": "call_6dafa017e6994710be5b9de4",
  "state": {
    "status": "completed",
    "input": { "questions": [ … ] },
    "output": "User has answered your questions: \"Bạn cần soạn loại hợp đồng nào?\"=\"Mua bán quốc tế\", \"Doanh nghiệp của bạn là bên nào trong hợp đồng?\"=\"Tôi là nhà xuất khẩu, bán cho khách ở Đức\", \"Hợp đồng soạn bằng ngôn ngữ nào?\"=\"Song ngữ Việt – Anh\". You can now continue with the user's answers in mind.",
    "title": "Asked 3 questions",
    "metadata": { "answers": [["Mua bán quốc tế"], ["Tôi là nhà xuất khẩu, bán cho khách ở Đức"], ["Song ngữ Việt – Anh"]], "truncated": false },
    "time": { "start": 1790441394802, "end": 1790441683542 } } }
```
Model sees `output`: multi-select labels joined by `", "`, an empty answer becomes `"Unanswered"`
(e.g. `"…"="Hoa Kỳ, EU", "…"="Unanswered"`). The run continued in every test (new assistant message, then
normal tool calls such as `document_create`, `trav_measures`, `eurlex_search`).

### `POST /question/{requestID}/reject`
No body. `200 true` / same 404 / 400 as reply. Event:
```json
{"type":"question.rejected","properties":{"sessionID":"ses_f21544389ffenySC2ttT9CHXvU","requestID":"que_0deabce13001ItCjHUXd5YouCt"}}
```
Tool part → `{"status":"error","error":"The user dismissed this question","input":{…},"time":{…}}`.
**The run stops** (assistant message `finish:"tool-calls"`, then `session.status idle` + `session.idle`); the model does
not get another step. The user must send a new message to continue.

## 4. Edge cases (all observed)

| Case | Behaviour | What the web should do |
|---|---|---|
| **Never answered** | **No timeout.** Pending for 12 min (Qwen) and 289 s (DeepSeek): still listed in `GET /question`, session `busy`, no events except heartbeats; after the reply the run resumed normally. | Keep the card open; the run is blocked meanwhile. Consider a "Bỏ qua" button (= reject) and treat Stop as reject + abort. |
| **Session abort while pending** (`POST /session/{id}/abort`) | Tool part → `error`, `"error":"Tool execution aborted"`, `"metadata":{"interrupted":true}`; `session.error` `{"name":"MessageAbortedError"}`; session idle. **No `question.rejected` event and the request stays in `GET /question`** (orphan). Replying to the orphan later → `200 true` + `question.replied`, but nothing resumes. | On Stop: first `POST /question/{id}/reject` for the session's pending question(s), then abort. Ignore/hide `GET /question` entries whose tool part is no longer `running`. |
| **User sends a new message while a question is pending** (`prompt_async`) | Accepted (`204`), user message stored, run stays blocked. If the question is then **rejected**, the run ends and the queued message is **never answered** (session idle, last message = that user message). If the question is **replied**, the run continues and the model sees both the answer and the queued message. | Prefer: send the typed text as the custom answer (`reply` with `[[text]]` for the first question, `[]` for the rest), or disable the composer while a question card is open. Never reject + prompt in that order without waiting for idle. |
| Reply twice / reply after reject | `404 QuestionNotFoundError`. | Disable the card after the first submit. |
| Answers shorter than questions / empty inner array | Missing → `"Unanswered"` for the model. | Allow skipping a question. |
| Page reload | Pending: tool part `running` in `GET /session/{id}/message` + entry in `GET /question` (match `tool.callID`). | Rebuild the card from `GET /question`, fall back to `state.input.questions` of the running part. |
| History (answered) | Tool part `completed`: questions in `state.input.questions`, answers in `state.metadata.answers` (same order). | Render a read-only answered card. |
| History (rejected) | Tool part `error`, `state.error === "The user dismissed this question"`. | Render "đã bỏ qua". |
| History (aborted) | Tool part `error`, `state.error === "Tool execution aborted"`, `state.metadata.interrupted === true`. | Render "đã dừng". |
| Server restart while pending | Pending list is in memory (`GET /question` is per process); after restart the run is gone. | Treat a `running` question part without a `GET /question` entry as dead. |
| Several servers | Session storage (`.sandbox/data`) is shared by all serve instances (the test instance lists production sessions), but pending questions are not. | Always answer on the instance that runs the session. |


## 5. Model behaviour (skill `clarify`)

New skill `.opencode/skills/clarify/SKILL.md` (+ pointer paragraphs "Hỏi lại người dùng" in `contract-review` and
`trade-remedy-lookup`): ask only when a missing fact materially changes the answer and has no safe default; ≤ 3
questions in **one** call; header ≤ 30 chars; 2–5 options, recommended first with "(Khuyến nghị)"; `multiple` only
for non-exclusive choices; keep `custom`; never ask for identifiers / secrets or for things a tool can look up;
continue without re-asking after answers; on reject continue with stated defaults or stop.
Fallback: if the tool call fails as unavailable (or the tool is absent), ask in plain text at the end of the answer
as a short numbered list with options.

Observed with Qwen 3.6 (the default model now):
- Forced prompts ("hãy gọi công cụ question") → the tool is called every time, correct schema.
- Natural prompts ("Soạn giúp tôi một hợp đồng.", "…có bị áp thuế chống bán phá giá không?") with only the skill:
  the model usually **writes the questions as text** instead of calling the tool (~1 of 10 runs called it), even
  after loading `clarify`; one run reasoned "I don't have the question tool" although it was in the list.
- Same prompts with one line in the request `system` field
  (`"Khi cần hỏi lại người dùng, HỎI BẰNG CÁCH GỌI CÔNG CỤ question … Không viết câu hỏi thành văn bản rồi kết thúc lượt."`)
  → 3 of 4 runs called the tool.
- **Recommendation**: when enabling, add one rule to the agent prompts (`.opencode/agent/legal-web.md` / `legal.md`,
  "Nguyên tắc bắt buộc" + the "Chọn skill" table row `clarify`), or send it as `system` in `prompt_async`.
- With `tools: {question:false}` the model asked in text as the fallback prescribes.

## 6. Risk / fallback

If the tool is enabled for a client that cannot render `question.asked`, a run that calls it **waits forever**
(session `busy`, no timeout) and later messages in that session are not answered until the question is replied /
rejected. That is why it is opt-in (`ND45_QUESTION_TOOL=1`) and the web still sends `tools: {question:false}`.
Nothing else is needed on the agent side: without the tool the `clarify` skill falls back to plain-text questions.

## 7. Long-wait test log
```
asked que_0deac7811001S5U88j2ONX0Bqr 2026-09-26T17:04:00Z
t+1min … t+12min  pending=true status={"type":"busy"}  (no new session events)
reply 200 true → tool part completed → new assistant message (finish=stop)
```
