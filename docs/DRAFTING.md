# Soạn văn bản dài theo nhóm (draft_* tools)

Long / detailed documents (contracts with many Điều and annexes, long reports) are drafted in stages like a
professional drafting team:

```
research (vbpl_*)  →  draft_plan  →  draft_write  →  draft_check  →  draft_fix  →  draft_assemble  →  answer + grounding_check
                      (outline,       (sections in    (machine checks  (rewrite only   (merge, header,
                       research pack)  parallel)       + 2 reviewers)   affected ones)  signature, files)
```

The orchestration runs **inside the tools** (`.opencode/lib/drafting.ts`), not in the chat model: writers and
reviewers are direct chat-completions calls (`.opencode/lib/llm.ts`) to the same model as the session
(`context.extra.model` → else `opencode.json` `model`; override with env `ND45_DRAFT_MODEL=provider/model`),
with reasoning off (`chat_template_kwargs.enable_thinking=false`), timeout 300 s and 2 retries per call.
The agent follows skill `long-drafting` (when: > ~8 Điều or > ~2,500 words, "chi tiết / đầy đủ / dài", several annexes).

## Tools

| Tool | Args | Does |
|---|---|---|
| `draft_plan` | `title`, `title_en?`, `kind` (`hop-dong`\|`bao-cao`\|`van-ban`), `language?` (`vi`\|`en`\|`bilingual`), `prevailing?`, `brief`, `user_side?`, `sections[]` {`key`, `heading`, `heading_en?`, `purpose?`, `must_include[]?`, `legal_basis_urls[]?` ("URL Điều N, M"), `words?`}, `glossary[]?` {`term`, `definition`, `en?`}, `parties[]?` {`role`, `short?`, `name_placeholder?`, `role_en?`}, `facts{}?`, `style?` {`detail?` ngắn\|chuẩn\|chi tiết\|rất chi tiết, `words_per_section?`, `notes?`} | Validates (unique keys, numbering Điều 1..N then Phụ lục 1..M in order, ≤ 40 sections, `must_include` required for key clauses, no duplicate headings, ≥ 2 parties for contracts, a contract needs researched legal basis) and builds the **research pack**: for every `legal_basis_urls` entry the article text is cut out of the evidence the lookup tools recorded in this session (a URL without "Điều N" → the 2 articles closest to the section topic). Returns `draftId` (`d-YYYYMMDD-xxxxxx`). |
| `draft_write` | `draftId`, `sections?` (keys; default all pending/failed), `parallel?` 1–6 (default 4) | Writers in parallel; each gets plan, glossary, parties, facts, outline (all headings + purposes), its section spec and **only its own research snippets**. The definitions article (Giải thích từ ngữ) is written first; terms it adds are appended to the glossary for the others. Output is validated: format (bilingual `=== VI === / === EN ===`, same khoản/điểm counts), stray CJK characters, citations outside the pack → one corrective rewrite. Section status: `pending → writing → written \| failed`. |
| `draft_check` | `draftId`, `review?` (default true), `assemble?` (default true), `formats?` | Machine checks + 2 reviewer passes in parallel (contradictions/consistency; gaps vs `must_include` / one-sidedness against `user_side`). Saves `issues.json`. Status → `checked`. **0 errors → assembles automatically** (same output as `draft_assemble`, incl. the `[[artifact:…]]` marker); errors → `BƯỚC TIẾP THEO: gọi draft_fix(…)`. |
| `draft_fix` | `draftId`, `issues?` (ids; default all open `lỗi` + `cảnh báo`), `parallel?`, `assemble?` (default true), `formats?` | Mechanical fixes first (mis-capitalised defined terms, restarted khoản numbering); then rewrites only the affected sections in parallel with their issues as instructions (other sections stay byte-identical); re-runs the machine checks; max 2 rounds. Status → `fixed`. **Then assembles automatically** and returns the artifact marker, so a model that stops after the fix still produces the document. When no error is open and no `issues` are given, it does NOT fix warnings – it only (re)assembles. |
| `draft_assemble` | `draftId`, `formats?` (`docx`,`pdf`) | Explicit (re)assembly – `draft_check` / `draft_fix` already assemble by default. Re-assembling a draft that already has a document saves the **next version** of that document (redline against the previous one). Merges sections in plan order, normalises headings/numbers (`## Điều N. …`, `## Phụ lục N. …`, EN `## Article N.` / `## Appendix N.`), adds preamble (title, Số, "Căn cứ …" = laws of the research pack, parties block with "…" fields) + national header + signature block (contracts), bilingual language clause; saves through doc-store `saveDocument` (same as `document_create`: versioned, `[[artifact:…]]` marker, later `document_read` / `document_edit` work). Summary: sections, words, issues found/fixed/remaining, timings. Phase → `done`. |
| `draft_status` | `draftId` | Current state (for reloads / resuming). |

### Next-step contract (anti early-stop)
Every `draft_*` output ends with an explicit line `BƯỚC TIẾP THEO: gọi draft_…({draftId:"…"})` (write → check → fix; after assembly: write the short answer + `grounding_check`). `document_read` / `document_edit` called with a draft id, or with an unknown id while the session has an un-assembled draft, answer "Đây là bản nháp chưa gộp … – gọi draft_assemble({draftId}) trước" (a draft id that was assembled → "dùng mã tài liệu …").

### Machine checks (`draft_check`, also re-run by `draft_fix`)
- numbering: khoản `1.` `2.` … continuous; điểm `a) b) c) d) đ) e)` (Latin order accepted); "5.1"-style lines (suggestion);
- cross-references: `Điều N`, `khoản K Điều N`, `khoản K Điều này`, `Phụ lục N`, EN `Article N`, `clause K of Article N`, `Appendix N` must exist; `Điều N (Tên)` / `Điều N về …` must match the target's topic; references to laws (`Điều 301 Luật Thương mại`) are external;
- citations: every quote (“…”, "…", `>` block, ≥ 30 chars) must appear verbatim in the research pack; laws named (`Luật …`, `Bộ luật …`, `Nghị định …`) and document numbers (`36/2005/QH11`) must be in the pack; cited articles of a pack law must be in the pack;
- defined terms: variants of glossary terms (mis-capitalised mid-sentence = warning, lowercase = suggestion), new definitions outside the definitions article, Title-Case phrases not in the glossary, glossary terms missing from the definitions article / never used;
- parties: `Bên X` / `Party X` must be a defined party; capitalised role names (`Bên mua`) must match the defined roles;
- amounts / rates: penalty > 8% (error, Điều 301 LTM), different values for the same topic across sections (penalty rate, late-payment interest; commission, discount, payment term, force-majeure notice as suggestions); the calc tools' contract check (`.opencode/lib/contract-check.ts`: tables, totals, VAT, payment schedule, amounts in words, VND/USD mix; bilingual VI ↔ EN figures) when installed;
- bilingual: EN text present, same khoản/điểm counts, same % / (n) figures, headings aligned (`checkBilingualStructure` at assembly);
- identical long sentences in two sections, too-short / truncated sections, stray CJK characters.

## Progress contract (for the web progress card)

Every `draft_*` tool publishes the same object under tool-part metadata key **`draft`**:

- **final**: the tool result is `{ title, output, metadata: { draft } }` → the completed tool part
  (`state.status = "completed"`) has `state.metadata.draft` (always available);
- **live**: the tools call `context.metadata({ title, metadata: { draft } })` on every status change
  (running tool part `state.metadata.draft`). NOTE: in opencode 1.18.32 the plugin-tool `context.metadata`
  returns an un-run Effect (the plugin wrapper only bridges `ask`), so running-state updates may not reach the
  part; therefore the same object is also written to a file on every change:
- **file**: `<outputs>/<sessionID>/drafts/<draftId>/progress.json` (`<outputs>` = doc-store `outputsRoot()`, i.e.
  `$LEGALAI_OUTPUTS_DIR` or `.sandbox/outputs`). While a `draft_*` tool part is `running`, the web server can poll
  / watch `<outputs>/<sessionID>/drafts/*/progress.json` (newest `updatedAt`; for `draft_write`/`check`/`fix`/
  `assemble`/`status` the `draftId` is in the tool input; `draft_plan` creates a new folder). Session forks:
  drafts are looked up by id across session folders.

```ts
type DraftProgress = {
  draftId: string            // "d-20260927-3fa9c1"
  title: string
  kind: "hop-dong" | "bao-cao" | "van-ban"
  language: "vi" | "en" | "bilingual"
  phase: "plan" | "write" | "check" | "fix" | "assemble" | "done" | "failed"
  sections: {
    key: string              // "thanh-toan"
    label: string            // "Điều 7" | "Phụ lục 1" | "Mục 3" (EN docs: "Article 7")
    heading: string          // "Thanh toán" (without number)
    status: "pending" | "writing" | "written" | "failed" | "checked" | "fixed"
    words?: number           // Vietnamese (or single-language) word count once written
    issues?: number          // open errors + warnings of this section
  }[]
  issues: { errors: number; warnings: number; suggestions: number }   // open (not fixed)
  round: number              // fix rounds done
  startedAt: number          // ms epoch (draft_plan)
  updatedAt: number          // ms epoch
  timings: { plan?: number; write?: number; check?: number; fix?: number; assemble?: number }  // ms, cumulative
  document?: { id: string; version: number; title: string }  // after draft_assemble (same id as the artifact card)
  error?: string             // phase "failed"
}
```

Status flow per section: `pending → writing → written | failed` (draft_write), `→ checked` (draft_check),
`→ pending → writing → fixed | failed` (draft_fix). The tool-part `title` is a one-line summary, e.g.
`Đang soạn các điều – Hợp đồng đại lý (12/28)`. The `draft_assemble` output also ends with the usual
`[[artifact:{…}]]` marker, so the existing document card appears.

## Annexes after the signature block
For contracts, `draft_assemble` puts the signature table after the last Điều. Each Phụ lục follows it on a new page, and each one gets a line `*(Kèm theo Hợp đồng số …/… ngày … tháng … năm …)*` under its heading (EN: `*(Attached to Contract No. …)*`).

Mechanism: a line `<!-- phu-luc -->` (`ANNEX_MARKER` in doc-store) splits the stored markdown into the main part and the annexes.
- `toHtml`, `toDocx`, the redline, and the bilingual html/docx/redline renderers all put the signature after the main part. HTML wraps each annex in `<section class="annex">` with a page break before it; docx inserts `pageBreakBefore`.
- `ensureLanguageClause` only touches the main part.
- Documents without the marker render exactly as before.
- The marker stays in the markdown, so `document_edit` and the redline keep the layout.
- Reports (`bao-cao`) keep annexes in sequence, with no marker.

## Storage
`<outputs>/<sessionID>/drafts/<draftId>/`: `draft.json` (plan + state + research pack), `sections/<key>.md`
(+ `<key>.en.md`), `issues.json` (`{id, section, severity: lỗi|cảnh báo|gợi ý, code, message, suggested_fix, source: auto|review, status: open|fixed|remaining, round}`), `progress.json`.

## Tests
`node tools/test-drafting.mjs [a|b|c|d|e]` (sandbox Chrome + model provider needed):
(a) plan validation, (b) 21-section distribution contract with real vbpl evidence, parallel 4, timings,
(c) injected issues (wrong cross-reference, second conflicting penalty rate, undefined term, quote not in the pack,
amount in words) found by `draft_check` and repaired by `draft_fix` with other sections byte-identical,
(d) bilingual pipeline, (e) assembled artifact + `document_edit`.
