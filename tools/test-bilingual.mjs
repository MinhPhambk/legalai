// Bilingual (Vietnamese | English) documents: document_create language=en / bilingual, structure check,
// language clause, document_read / document_edit on both columns, redline inside the column cells, and
// import of a bilingual .docx made by our own generator (through the web server's extractor).
// Needs the sandbox Chrome for PDF (node tools/launch-chrome.mjs) – PDF failures are tolerated.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const d = await import('../.opencode/tools/document.ts');
const store = await import('../.opencode/lib/doc-store.ts');
const JSZip = createRequire(import.meta.url)('jszip');

const t0 = Date.now();
const S = `bilingual-smoke-${Date.now()}`;
const marker = (out) => JSON.parse(out.match(/\[\[artifact:(\{[\s\S]*\})\]\]\s*$/)[1]);
const ok = (msg) => console.log('  ✓', msg);
const docXml = async (file) => (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml').async('string');
const fileOf = (meta, format) => path.join(store.outDir(meta.sessionID), meta.files.find((f) => f.format === format).name);
const folderFiles = (sid) => { try { return fs.readdirSync(store.outDir(sid)).sort(); } catch { return []; } };
const count = (s, re) => (s.match(re) ?? []).length;

/** Top-level tables of word/document.xml → rows → cells (each cell = its raw xml, nested tables included). */
function topTables(xml) {
  const tables = [];
  const re = /<(\/?)w:(tbl|tr|tc)(?=[\s>\/])[^>]*?(\/?)>/g;
  let depth = 0, tbl = null, row = null, cellStart = -1, m;
  while ((m = re.exec(xml))) {
    const [all, close, tag, selfClose] = m;
    if (selfClose) continue;
    if (tag === 'tbl') {
      if (!close) { depth++; if (depth === 1) tbl = { rows: [] }; }
      else { if (depth === 1) tables.push(tbl); depth--; }
    } else if (depth === 1 && tag === 'tr') {
      if (!close) row = { cells: [], start: m.index }; else { row.xml = xml.slice(row.start, m.index); tbl.rows.push(row); }
    } else if (depth === 1 && tag === 'tc') {
      if (!close) cellStart = m.index + all.length; else row.cells.push(xml.slice(cellStart, m.index));
    }
  }
  return tables;
}
const cellText = (x) => [...x.matchAll(/<w:(?:t|delText)(?:\s[^>]*)?>([^<]*)<\/w:(?:t|delText)>/g)].map((m) => m[1]).join('');

const VI = `# HỢP ĐỒNG MUA BÁN HÀNG HÓA

Số: 05/2026/HĐMB

Hôm nay, ngày ... tháng ... năm 2026, tại Hà Nội, chúng tôi gồm:

**BÊN BÁN (Bên A):** Công ty TNHH Thép An Phát, mã số thuế ...

**BÊN MUA (Bên B):** Global Steel Trading Pte. Ltd. (Singapore)

## Điều 1. Hàng hóa

Bên A bán cho Bên B 100 tấn thép cuộn cán nóng theo tiêu chuẩn JIS G3101.

| Mặt hàng | Số lượng | Đơn giá |
|---|---|---|
| Thép cuộn SS400 | 100 tấn | 650 USD/tấn |

## Điều 2. Thanh toán

1. Tổng giá trị hợp đồng: 65.000 USD.
2. Bên B thanh toán bằng chuyển khoản trong vòng 30 ngày kể từ ngày nhận bộ chứng từ hợp lệ.

## Điều 3. Giao hàng

| Đợt | Số lượng | Thời hạn | Cảng xếp | Cảng dỡ |
|---|---|---|---|---|
| 1 | 50 tấn | 15/11/2026 | Hải Phòng | Singapore |
| 2 | 50 tấn | 15/12/2026 | Hải Phòng | Singapore |

## Điều 4. Phạt vi phạm

Bên vi phạm nghĩa vụ hợp đồng chịu phạt 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm.

## Điều 5. Bất khả kháng

Bên gặp sự kiện bất khả kháng phải thông báo cho Bên kia trong vòng 7 ngày.

## Điều 6. Điều khoản chung

1. Hợp đồng có hiệu lực kể từ ngày ký.
2. Tranh chấp được giải quyết tại Trung tâm Trọng tài Quốc tế Việt Nam (VIAC).
`;
const EN = `# SALES CONTRACT

No.: 05/2026/HĐMB

Today, on ... 2026, in Hanoi, we are:

**THE SELLER (Party A):** An Phat Steel Co., Ltd., tax code ...

**THE BUYER (Party B):** Global Steel Trading Pte. Ltd. (Singapore)

## Article 1. Goods

Party A sells to Party B 100 tonnes of hot-rolled steel coils according to JIS G3101.

| Item | Quantity | Unit price |
|---|---|---|
| SS400 steel coil | 100 tonnes | USD 650/tonne |

## Article 2. Payment

1. Total contract value: USD 65,000.
2. Party B shall pay by bank transfer within 30 days from the date of receipt of the valid set of documents.

## Article 3. Delivery

| Lot | Quantity | Time limit | Port of loading | Port of discharge |
|---|---|---|---|---|
| 1 | 50 tonnes | 15/11/2026 | Hai Phong | Singapore |
| 2 | 50 tonnes | 15/12/2026 | Hai Phong | Singapore |

## Article 4. Penalty for breach

The Party in breach of a contractual obligation shall pay a penalty of 8% of the value of the breached part of the contractual obligation.

## Article 5. Force majeure

The Party affected by a force majeure event shall notify the other Party within 7 days.

## Article 6. General provisions

1. This Contract takes effect from the date of signing.
2. Disputes shall be settled at the Vietnam International Arbitration Centre (VIAC).
`;

console.log('1. English contract (language=en)');
const rEn = await d.create.execute({ title: 'Sales Contract (test)', markdown: EN, kind: 'hop-dong', language: 'en', sign_a: 'ĐẠI DIỆN BÊN A', sign_b: 'FOR AND ON BEHALF OF PARTY B' }, { sessionID: S });
const aEn = marker(rEn);
assert.equal(aEn.language, 'en');
const mEn = store.findDocument([S], aEn.id);
assert.equal(mEn.language, 'en'); assert.deepEqual(mEn.sign, ['FOR AND ON BEHALF OF PARTY A', 'FOR AND ON BEHALF OF PARTY B']);
const hEn = fs.readFileSync(path.join(store.outDir(S), mEn.preview), 'utf8');
assert.match(hEn, /<html lang="en">/); assert.match(hEn, /SOCIALIST REPUBLIC OF VIETNAM/); assert.match(hEn, /Independence – Freedom – Happiness/);
assert.doesNotMatch(hEn, /CỘNG HÒA/); assert.match(hEn, /FOR AND ON BEHALF OF PARTY A/); assert.match(hEn, /\(Signature, full name, title and seal\)/);
const xEn = await docXml(fileOf(mEn, 'docx'));
assert.match(xEn, /SOCIALIST REPUBLIC OF VIETNAM/); assert.match(xEn, /FOR AND ON BEHALF OF PARTY B/); assert.doesNotMatch(xEn, /Ký, ghi rõ/);
ok(`en ${aEn.id}: English header + signature labels (${aEn.files.map((f) => f.format).join(', ')})`);

console.log('2. bilingual contract: two-column table, aligned rows, language clause');
const rBi = await d.create.execute({ title: 'Hợp đồng mua bán thép / Steel Sales Contract (thử)', markdown: VI, markdown_en: EN, language: 'bilingual', kind: 'hop-dong', sign_a: 'ĐẠI DIỆN BÊN A', sign_b: 'ĐẠI DIỆN BÊN B' }, { sessionID: S });
assert.match(rBi, /song ngữ/); assert.match(rBi, /Đã tự thêm điều khoản ngôn ngữ .* vào cuối Điều 6/);
const aBi = marker(rBi);
assert.equal(aBi.language, 'bilingual'); assert.equal(aBi.prevailing, 'vi'); assert.match(aBi.markdown_en, /\.en\.md$/);
const mBi = store.findDocument([S], aBi.id);
assert.equal(mBi.language, 'bilingual'); assert.equal(mBi.prevailing, 'vi');
assert.deepEqual(mBi.sign_en, ['FOR AND ON BEHALF OF PARTY A', 'FOR AND ON BEHALF OF PARTY B']);
const vi1 = store.readMarkdown(mBi), en1 = store.readMarkdownEn(mBi);
assert.equal(count(vi1, /tiếng Việt và tiếng Anh/g), 1); assert.equal(count(en1, /made in Vietnamese and English/g), 1);
assert.match(vi1, /2\. Tranh chấp[^\n]*\n3\. Hợp đồng này được lập bằng tiếng Việt và tiếng Anh, có giá trị pháp lý như nhau\. Trường hợp có sự khác biệt giữa hai bản, bản tiếng Việt được ưu tiên áp dụng\.\n$/);
assert.match(en1, /\n3\. This Contract is made in Vietnamese and English, both versions having equal legal validity\. In case of any discrepancy between the two versions, the Vietnamese version shall prevail\.\n$/);
assert.deepEqual(store.checkBilingualStructure(vi1, en1), []);
// DOCX: national header + titles outside, then ONE borderless two-column table, every row = 2 cells (or 1 full-width cell)
const xBi = await docXml(fileOf(mBi, 'docx'));
for (const s of ['CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', 'SOCIALIST REPUBLIC OF VIETNAM', 'Độc lập – Tự do – Hạnh phúc', 'Independence – Freedom – Happiness', 'HỢP ĐỒNG MUA BÁN HÀNG HÓA', 'SALES CONTRACT', 'FOR AND ON BEHALF OF PARTY A', '(Signature, full name, title and seal)', '(Ký, ghi rõ họ tên, chức vụ và đóng dấu)'])
  assert.ok(xBi.includes(s), `docx has ${s}`);
const tables = topTables(xBi);
assert.equal(tables.length, 2, 'bilingual table + signature table');
const bt = tables[0];
assert.match(xBi, /<w:tblLayout w:type="fixed"\/>/);
let twoCell = 0, stack = 0;
for (const r of bt.rows) {
  if (r.cells.length === 2) twoCell++;
  else { assert.equal(r.cells.length, 1); assert.match(r.xml, /<w:gridSpan w:val="2"\/>/); stack++; }
}
assert.ok(twoCell >= 15, `rows with 2 cells: ${twoCell}`); assert.equal(stack, 1, 'the 5-column table of Điều 3 is stacked full width');
const rowOf = (needle) => bt.rows.find((r) => r.cells.some((c) => cellText(c).includes(needle)));
for (const [v, e] of [['Điều 1. Hàng hóa', 'Article 1. Goods'], ['Điều 6. Điều khoản chung', 'Article 6. General provisions'], ['2. Bên B thanh toán', '2. Party B shall pay'], ['bản tiếng Việt được ưu tiên', 'Vietnamese version shall prevail'], ['Bên vi phạm nghĩa vụ', 'The Party in breach']]) {
  const r = rowOf(v);
  assert.ok(r && r.cells.length === 2 && cellText(r.cells[0]).includes(v) && cellText(r.cells[1]).includes(e), `row "${v}" ↔ "${e}"`);
}
assert.ok(cellText(rowOf('Thép cuộn SS400').cells[0]).includes('Thép cuộn SS400') && cellText(rowOf('Thép cuộn SS400').cells[1]).includes('SS400 steel coil'), 'small table: VN table left, EN table right');
assert.ok(bt.rows.filter((r) => r.cells.length === 2).every((r) => !cellText(r.cells[0]).match(/\b(shall|Party B|Article)\b/)), 'no English in the Vietnamese column');
assert.ok(count(bt.rows.map((r) => r.xml).join(''), /<w:cantSplit\/>/g) >= 10, 'rows kept from splitting');
assert.equal(count(xBi, /Hợp đồng này được lập bằng tiếng Việt và tiếng Anh/g), 1);
// HTML: same layout
const hBi = fs.readFileSync(path.join(store.outDir(S), mBi.preview), 'utf8');
assert.match(hBi, /<table class="bi">/); assert.match(hBi, /<h1 class="en">SALES CONTRACT<\/h1>/);
assert.match(hBi, /<i class="en">SOCIALIST REPUBLIC OF VIETNAM<\/i>/);
assert.match(hBi, /<tr class="head"><td class="vi" lang="vi"><h2>Điều 2\. Thanh toán<\/h2>\s*<\/td><td class="en" lang="en"><h2>Article 2\. Payment<\/h2>/);
assert.match(hBi, /<tr class="stack"><td colspan="2">/);
ok(`bilingual ${aBi.id}: ${bt.rows.length} rows (${twoCell} two-cell, ${stack} stacked), clause once, ${aBi.files.map((f) => f.format).join(', ')}`);

console.log('3. prevailing=en, existing language clause not duplicated');
const rP = marker(await d.create.execute({ title: 'HĐ song ngữ – bản Anh ưu tiên', markdown: VI, markdown_en: EN, language: 'bilingual', prevailing: 'en', kind: 'hop-dong', formats: ['docx'] }, { sessionID: S }));
const mP = store.findDocument([S], rP.id);
assert.equal(mP.prevailing, 'en');
assert.match(store.readMarkdown(mP), /bản tiếng Anh được ưu tiên áp dụng\.\n$/); assert.match(store.readMarkdownEn(mP), /the English version shall prevail\.\n$/);
const withClauseVi = VI.replace('2. Tranh chấp', '2. Hợp đồng được lập thành 04 bản bằng tiếng Việt và tiếng Anh; bản tiếng Việt được ưu tiên áp dụng.\n3. Tranh chấp');
const withClauseEn = EN.replace('2. Disputes', '2. This Contract is made in four originals in English and Vietnamese; the Vietnamese version shall prevail.\n3. Disputes');
const rQ = await d.create.execute({ title: 'HĐ đã có điều khoản ngôn ngữ', markdown: withClauseVi, markdown_en: withClauseEn, language: 'bilingual', kind: 'hop-dong', formats: ['docx'] }, { sessionID: S });
assert.match(rQ, /đã có điều khoản ngôn ngữ – không thêm/);
const mQ = store.findDocument([S], marker(rQ).id);
assert.equal(count(store.readMarkdown(mQ), /tiếng Việt và tiếng Anh/g), 1); assert.equal(store.readMarkdown(mQ).trim(), withClauseVi.trim());
ok('prevailing switch + no duplicate clause');

console.log('4. structure mismatch → clear error, nothing written');
const before = folderFiles(S);
const badEn = EN.replace(/## Article 4\. Penalty for breach\n\n[^\n]+\n\n/, '').replace('## Article 5. Force majeure', '## Article 4. Force majeure').replace('## Article 6. General', '## Article 5. General');
const rBad = await d.create.execute({ title: 'lệch cấu trúc', markdown: VI, markdown_en: badEn, language: 'bilingual', kind: 'hop-dong' }, { sessionID: S });
assert.match(rBad, /^Lỗi – CHƯA tạo tài liệu: cấu trúc/); assert.match(rBad, /tiếng Việt 6, tiếng Anh 5/); assert.match(rBad, /Tiêu đề bản tiếng Anh: Article 1\. Goods \| Article 2\. Payment \| Article 3\. Delivery \| Article 4\. Force majeure \| Article 5\. General provisions/);
assert.match(rBad, /Chỉ có ở bản tiếng Việt: "Điều 6\. Điều khoản chung"/);
const rBad2 = await d.create.execute({ title: 'lệch số', markdown: VI, markdown_en: EN.replace('## Article 5. Force majeure', '## Article 7. Force majeure'), language: 'bilingual', kind: 'hop-dong' }, { sessionID: S });
assert.match(rBad2, /Tiêu đề thứ 5 không tương ứng: VI "Điều 5\. Bất khả kháng" ↔ EN "Article 7\. Force majeure"/);
const rBad3 = await d.create.execute({ title: 'thiếu en', markdown: VI, language: 'bilingual', kind: 'hop-dong' }, { sessionID: S });
assert.match(rBad3, /cần `markdown_en`/);
assert.deepEqual(folderFiles(S), before, 'no file written');
ok(`mismatch reported: ${rBad.split('\n').slice(1, 3).join(' | ')}`);

console.log('5. document_read shows both columns');
const rd = await d.read.execute({ id: aBi.id }, { sessionID: S });
assert.match(rd, /Song ngữ Việt \| Anh/); assert.match(rd, /- Điều 2\. Thanh toán {2}↔ {2}Article 2\. Payment/);
assert.match(rd, /=== Điều 2 ===\n\[VI\]\n\s+\d+│ ## Điều 2\. Thanh toán[\s\S]*?\[EN\]\n\s+\d+│ ## Article 2\. Payment/);
const rs = await d.read.execute({ id: aBi.id, section: 'Điều 4' }, { sessionID: S });
assert.match(rs, /\[VI\] \(từ dòng \d+\):\n\s+\d+│ ## Điều 4\. Phạt vi phạm/); assert.match(rs, /\[EN\] \(từ dòng \d+\):\n\s+\d+│ ## Article 4\. Penalty/);
assert.doesNotMatch(rs, /Điều 5|Article 5/);
const rs2 = await d.read.execute({ id: aBi.id, section: 'Article 2 clause 2' }, { sessionID: S });
assert.match(rs2, /2\. Bên B thanh toán/); assert.match(rs2, /2\. Party B shall pay/);
ok('document_read: aligned [VI]/[EN] sections, section by Điều or Article');

console.log('6. edits: both languages, one language (warning), delete section in both');
const r2 = await d.edit.execute({ id: aBi.id, note: 'thời hạn thanh toán 45 ngày', edits: [
  { op: 'replace', lang: 'both', find: 'trong vòng 30 ngày', text: 'trong vòng 45 ngày', find_en: 'within 30 days', text_en: 'within 45 days' },
] }, { sessionID: S });
assert.doesNotMatch(r2, /CẢNH BÁO/);
const a2 = marker(r2);
assert.deepEqual(a2.changes_summary, ['Sửa Điều 2 khoản 2 (Việt + Anh)']);
const m2 = store.findDocument([S], a2.id);
assert.equal(m2.language, 'bilingual'); assert.equal(m2.version, 2);
assert.equal(store.readMarkdown(m2), vi1.replace('trong vòng 30 ngày', 'trong vòng 45 ngày'));
assert.equal(store.readMarkdownEn(m2), en1.replace('within 30 days', 'within 45 days'));
assert.deepEqual(m2.changes.map((c) => c.lang), ['vi', 'en']);
// redline: tracked changes inside the respective column cells of the same row
const red = await docXml(fileOf(m2, 'redline'));
const rt = topTables(red)[0];
const row = rt.rows.find((r) => r.cells.length === 2 && /<w:del /.test(r.cells[0]));
assert.ok(row, 'a row with a tracked deletion in the Vietnamese cell');
assert.match(row.cells[0], /<w:delText[^>]*>30<\/w:delText>/); assert.match(row.cells[0], /<w:ins [^>]*>[\s\S]*?45/);
assert.match(row.cells[1], /<w:delText[^>]*>30<\/w:delText>/); assert.match(row.cells[1], /within/);
assert.doesNotMatch(cellText(row.cells[0]), /within/); assert.doesNotMatch(cellText(row.cells[1]), /trong vòng/);
assert.match(red, /Tracked changes: version 2 against version 1/);
ok(`v2 ${a2.id}: ${a2.changes_summary.join(' | ')}; redline w:ins/w:del inside both cells of the Điều 2 khoản 2 row`);

const r3 = await d.edit.execute({ id: a2.id, formats: ['docx'], edits: [{ op: 'replace', find: 'chịu phạt 8%', text: 'chịu phạt 6%' }] }, { sessionID: S });
assert.match(r3, /CẢNH BÁO song ngữ: đã sửa bản tiếng Việt ở Điều 4 nhưng CHƯA sửa phần tiếng Anh tương ứng/);
const a3 = marker(r3);
assert.deepEqual(a3.changes_summary, ['Sửa Điều 4 (bản tiếng Việt)']);
const r4 = await d.edit.execute({ id: a3.id, formats: ['docx'], edits: [{ op: 'replace', lang: 'en', find: 'a penalty of 8%', text: 'a penalty of 6%' }] }, { sessionID: S });
assert.doesNotMatch(r4, /CẢNH BÁO/, 'counterpart fixed in a separate call → no structural warning');
const a4 = marker(r4);
assert.deepEqual(a4.changes_summary, ['Sửa Điều 4 (bản tiếng Anh)']);
// lang inferred from find: English text only exists in the English column
const r4b = marker(await d.edit.execute({ id: a4.id, formats: ['docx'], edits: [{ op: 'replace', find: 'within 7 days', text: 'within 5 days' }, { op: 'replace', find: 'trong vòng 7 ngày', text: 'trong vòng 5 ngày' }] }, { sessionID: S }));
assert.deepEqual(r4b.changes_summary, ['Sửa Điều 5 (Việt + Anh)']);
const r5 = await d.edit.execute({ id: r4b.id, formats: ['docx'], edits: [{ op: 'delete', section: 'Điều 5' }] }, { sessionID: S });
assert.doesNotMatch(r5, /CẢNH BÁO/);
const a5 = marker(r5);
assert.deepEqual(a5.changes_summary, ['Xóa Điều 5 (Việt + Anh)']);
const m5 = store.findDocument([S], a5.id);
assert.doesNotMatch(store.readMarkdown(m5), /Bất khả kháng/); assert.doesNotMatch(store.readMarkdownEn(m5), /Force majeure/);
assert.deepEqual(store.checkBilingualStructure(store.readMarkdown(m5), store.readMarkdownEn(m5)), []);
// adding a section in one language only → saved, but warned that the columns no longer line up
const r6 = await d.edit.execute({ id: a5.id, formats: ['docx'], edits: [{ op: 'insert_after', section: 'Điều 4', text: '## Điều 5. Bảo hành\n\nBảo hành 12 tháng.' }] }, { sessionID: S });
assert.match(r6, /CẢNH BÁO song ngữ: đã sửa bản tiếng Việt/); assert.match(r6, /cấu trúc tiêu đề hai bản không còn khớp/);
const m6 = store.findDocument([S], marker(r6).id);
const x6 = topTables(await docXml(fileOf(m6, 'docx')))[0];
const wr = x6.rows.find((r) => r.cells.some((c) => cellText(c).includes('Điều 5. Bảo hành')));
assert.ok(wr && wr.cells.length === 2 && cellText(wr.cells[1]).trim() === '', 'unmatched heading gets an empty English cell (no shift of later rows)');
assert.ok(cellText(x6.rows.find((r) => cellText(r.cells[0]).includes('Điều 6. Điều khoản chung')).cells[1]).includes('Article 6. General provisions'), 'later rows still aligned');
// errors: both without find_en, missing English text → nothing written
const before2 = folderFiles(S);
const e1 = await d.edit.execute({ id: a5.id, edits: [{ op: 'replace', lang: 'both', find: 'chịu phạt 6%', text: 'chịu phạt 5%' }] }, { sessionID: S });
assert.match(e1, /CHƯA lưu[\s\S]*cần thêm `find_en`/);
const e2 = await d.edit.execute({ id: a5.id, edits: [{ op: 'replace', lang: 'en', find: 'penalty of 9%', text: 'x' }] }, { sessionID: S });
assert.match(e2, /CHƯA lưu[\s\S]*bản tiếng Anh/);
assert.deepEqual(folderFiles(S), before2);
ok(`edits: one-language warning, lang inference, delete both, unmatched section warning (v${m6.version}), errors write nothing`);

console.log('7. import: bilingual .docx made by our generator (web server extractor)');
const { extractText } = await import('../web/server/extract.mjs');
const ex = await extractText(fileOf(mBi, 'docx'), '.docx', 60000);
const det = store.detectBilingual(ex.text);
assert.ok(det, 'detected as bilingual');
const hs = (md) => md.split('\n').filter((l) => /^#/.test(l));
assert.deepEqual(hs(det.vi), hs(vi1)); assert.deepEqual(hs(det.en), hs(en1));
assert.equal(det.nationalHeader, true);
assert.deepEqual(det.sign, ['ĐẠI DIỆN BÊN A', 'ĐẠI DIỆN BÊN B']); assert.deepEqual(det.signEn, ['FOR AND ON BEHALF OF PARTY A', 'FOR AND ON BEHALF OF PARTY B']);
assert.match(det.vi, /2\. Bên B thanh toán bằng chuyển khoản trong vòng 30 ngày/); assert.match(det.en, /2\. Party B shall pay by bank transfer within 30 days/);
assert.match(det.vi, /\| Thép cuộn SS400 \| 100 tấn \| 650 USD\/tấn \|/); assert.match(det.en, /\| 1 \| 50 tonnes \| 15\/11\/2026 \| Hai Phong \| Singapore \|/);
assert.doesNotMatch(det.vi, /shall|SOCIALIST/); assert.doesNotMatch(det.en, /Bên B thanh toán|CỘNG HÒA/);
const tmp = path.join(os.tmpdir(), `bi-upload-${Date.now()}.docx`);
fs.copyFileSync(fileOf(mBi, 'docx'), tmp);
const up = await store.importDocument({ sessionID: S, title: 'hop-dong-song-ngu', markdown: ex.text, originalPath: tmp, formats: ['docx'] });
assert.equal(up.language, 'bilingual'); assert.equal(up.kind, 'hop-dong'); assert.equal(up.national_header, true); assert.equal(up.prevailing, 'vi');
const upEd = marker(await d.edit.execute({ id: up.id, formats: ['docx'], edits: [{ op: 'replace', lang: 'both', find: 'trong vòng 30 ngày', text: 'trong vòng 60 ngày', find_en: 'within 30 days', text_en: 'within 60 days' }] }, { sessionID: S }));
assert.deepEqual(upEd.changes_summary, ['Sửa Điều 2 khoản 2 (Việt + Anh)']);
// a plain Vietnamese upload stays single-language; alternating VN / EN paragraphs are detected too
assert.equal(store.detectBilingual('# HỢP ĐỒNG\n\n## Điều 1. X\n\nNội dung một.\n\n## Điều 2. Y\n\nNội dung hai.\n'), null);
const alt = ['# HỢP ĐỒNG DỊCH VỤ', '# SERVICE CONTRACT', '## Điều 1. Phạm vi dịch vụ', '## Article 1. Scope of services', 'Bên A cung cấp dịch vụ vận chuyển hàng hóa cho Bên B.', 'Party A shall provide cargo transportation services to Party B.', '## Điều 2. Phí dịch vụ', '## Article 2. Service fee', 'Phí dịch vụ là 10.000.000 đồng mỗi tháng.', 'The service fee is VND 10,000,000 per month.'].join('\n\n');
const da = store.detectBilingual(alt);
assert.ok(da); assert.deepEqual(hs(da.vi), ['# HỢP ĐỒNG DỊCH VỤ', '## Điều 1. Phạm vi dịch vụ', '## Điều 2. Phí dịch vụ']); assert.deepEqual(hs(da.en), ['# SERVICE CONTRACT', '## Article 1. Scope of services', '## Article 2. Service fee']);
ok(`import: detected (table layout) → bilingual ${up.id} → edited ${upEd.id}; alternating paragraphs detected; plain VN not`);

console.log('8. backward compatibility: documents without language are Vietnamese');
const vi0 = marker(await d.create.execute({ title: 'HĐ tiếng Việt', markdown: VI, kind: 'hop-dong', formats: ['docx'] }, { sessionID: S }));
assert.equal(vi0.language, 'vi');
const m0 = store.findDocument([S], vi0.id);
const legacy = JSON.parse(fs.readFileSync(path.join(store.outDir(S), m0.markdown.replace(/\.md$/, '.json')), 'utf8'));
delete legacy.language;
fs.writeFileSync(path.join(store.outDir(S), m0.markdown.replace(/\.md$/, '.json')), JSON.stringify(legacy));
assert.equal(store.findDocument([S], vi0.id).language, 'vi');
const rl = marker(await d.edit.execute({ id: vi0.id, formats: ['docx'], edits: [{ op: 'replace', find: 'chịu phạt 8%', text: 'chịu phạt 7%' }] }, { sessionID: S }));
assert.deepEqual(rl.changes_summary, ['Sửa Điều 4']); assert.equal(rl.language, 'vi');
ok('missing language → vi, single-language edit summaries unchanged');

console.log(`\nALL PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s – outputs in ${store.outDir(S)}`);
console.log(`bilingual preview: ${path.join(store.outDir(S), mBi.preview)}`);
