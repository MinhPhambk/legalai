// Smoke test for document_edit / document_read / doc-store (needs the sandbox Chrome for PDF:
// node tools/launch-chrome.mjs – PDF failures are tolerated, everything else must pass).
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
const S = `edit-smoke-${Date.now()}`;
const marker = (out) => JSON.parse(out.match(/\[\[artifact:(\{[\s\S]*\})\]\]\s*$/)[1]);
const ok = (msg) => console.log('  ✓', msg);
const docXml = async (file) => (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml').async('string');
const folderFiles = (sid) => fs.readdirSync(store.outDir(sid)).sort();

const md = `# Hợp đồng mua bán hàng hóa

Số: 02/2026/HĐMB

**BÊN BÁN (Bên A):** Công ty A

**BÊN MUA (Bên B):** Công ty B

## Điều 1. Hàng hóa

Bên A bán cho Bên B 100 tấn thép cuộn cán nóng theo tiêu chuẩn JIS G3101.

## Điều 2. Thanh toán

1. Giá trị hợp đồng: 1.500.000.000 đồng (đã bao gồm VAT).
2. Bên B thanh toán toàn bộ trong vòng 30 ngày kể từ ngày nhận hóa đơn hợp lệ.

## Điều 3. Phạt vi phạm

Bên vi phạm chịu phạt 8% giá trị phần nghĩa vụ bị vi phạm.

## Điều 4. Bất khả kháng

Bên gặp sự kiện bất khả kháng phải thông báo cho Bên kia trong vòng 7 ngày.

## Điều 5. Giải quyết tranh chấp

Tranh chấp được giải quyết tại Trung tâm Trọng tài Quốc tế Việt Nam (VIAC).
`;

console.log('1. create');
const r1 = await d.create.execute({ title: 'Hợp đồng mua bán thép (thử sửa)', markdown: md, kind: 'hop-dong', sign_a: 'ĐẠI DIỆN BÊN A', sign_b: 'ĐẠI DIỆN BÊN B' }, { sessionID: S });
const a1 = marker(r1);
assert.equal(a1.version, 1); assert.equal(a1.root_id, a1.id); assert.equal(a1.parent_id, null); assert.equal(a1.origin, 'agent');
assert.deepEqual(a1.changes_summary, []);
assert.match(a1.id, /^\d{14}-[0-9a-f]{6}$/);
const v1 = store.findDocument([S], a1.id);
const md1 = store.readMarkdown(v1);
ok(`v1 ${a1.id} (${a1.files.map((f) => f.format).join(', ')})`);

console.log('2. read');
const rd = await d.read.execute({ id: a1.id }, { sessionID: S });
assert.match(rd, /mã tài liệu: /); assert.match(rd, /dòng \d+: Điều 2\. Thanh toán/); assert.match(rd, /│ 2\. Bên B thanh toán/);
const rs = await d.read.execute({ id: a1.id, section: 'Điều 2' }, { sessionID: S });
assert.match(rs, /Điều 2\. Thanh toán/); assert.doesNotMatch(rs, /Điều 3\./);
ok('document_read full + section');

console.log('3. edit v2: replace clause + insert new khoản');
const r2 = await d.edit.execute({
  id: a1.id,
  note: 'tăng thời hạn thanh toán, thêm lãi chậm trả',
  edits: [
    { op: 'replace', find: 'trong vòng 30 ngày kể từ ngày nhận hóa đơn hợp lệ', text: 'trong vòng 45 ngày kể từ ngày nhận hóa đơn hợp lệ' },
    // line-number gutter copied from document_read must be tolerated
    { op: 'insert_after', find: '  12│ 2. Bên B thanh toán toàn bộ trong vòng 45 ngày kể từ ngày nhận hóa đơn hợp lệ.', text: '3. Chậm thanh toán thì Bên B trả lãi trên số tiền chậm trả theo Điều 306 Luật Thương mại 2005.' },
  ],
}, { sessionID: S });
const a2 = marker(r2);
assert.equal(a2.version, 2); assert.equal(a2.parent_id, a1.id); assert.equal(a2.root_id, a1.id); assert.notEqual(a2.id, a1.id);
assert.ok(a2.changes_summary.length === 2 && a2.changes_summary.every((s) => s.length < 80), a2.changes_summary);
assert.match(a2.changes_summary[0], /Điều 2 khoản 2/); assert.equal(a2.changes_summary[1], 'Thêm sau Điều 2 khoản 2');
const v2 = store.findDocument([S], a2.id);
const md2 = store.readMarkdown(v2);
const expected2 = md1.replace('trong vòng 30 ngày', 'trong vòng 45 ngày').replace('hóa đơn hợp lệ.\n', 'hóa đơn hợp lệ.\n3. Chậm thanh toán thì Bên B trả lãi trên số tiền chậm trả theo Điều 306 Luật Thương mại 2005.\n');
assert.equal(md2, expected2, 'v2 must equal v1 with exactly the two edits (byte-identical elsewhere)');
assert.equal(v2.changes[0].op, 'replace'); assert.match(v2.changes[0].before, /30 ngày/); assert.match(v2.changes[0].after, /45 ngày/);
assert.equal(v2.note, 'tăng thời hạn thanh toán, thêm lãi chậm trả');
assert.deepEqual(v2.sign, ['ĐẠI DIỆN BÊN A', 'ĐẠI DIỆN BÊN B']);
const red2 = v2.files.find((f) => f.format === 'redline');
assert.ok(red2 && red2.name.endsWith('.thay-doi.docx'), 'redline file listed');
const x2 = await docXml(path.join(store.outDir(S), red2.name));
assert.match(x2, /<w:ins /); assert.match(x2, /<w:del /); assert.match(x2, /w:author="LegalAI"/);
assert.match(x2, /<w:delText[^>]*>30<\/w:delText>/); assert.match(x2, /45/);
ok(`v2 ${a2.id}: ${a2.changes_summary.join(' | ')}; redline has w:ins + w:del`);

console.log('4. edit v3: delete a whole section');
const r3 = await d.edit.execute({ id: a2.id, edits: [{ op: 'delete', section: 'Điều 4' }] }, { sessionID: S });
const a3 = marker(r3);
assert.equal(a3.version, 3); assert.equal(a3.parent_id, a2.id); assert.equal(a3.root_id, a1.id);
const v3 = store.findDocument([S], a3.id);
const md3 = store.readMarkdown(v3);
const s4 = md2.indexOf('## Điều 4'), s5 = md2.indexOf('## Điều 5');
assert.equal(md3, md2.slice(0, s4) + md2.slice(s5), 'v3 = v2 minus Điều 4 exactly');
assert.match(a3.changes_summary[0], /^Xóa Điều 4$/);
const x3 = await docXml(path.join(store.outDir(S), v3.files.find((f) => f.format === 'redline').name));
assert.match(x3, /<w:del /); assert.match(x3, /bất khả kháng/i);
ok(`v3 ${a3.id}: ${a3.changes_summary.join(' | ')}`);

console.log('5. failures write nothing');
const before = folderFiles(S);
const amb = await d.edit.execute({ id: a3.id, edits: [{ op: 'replace', find: 'Điều 2', text: 'x' }, { op: 'replace', find: 'Bên B', text: 'Bên Mua' }] }, { sessionID: S });
assert.match(amb, /CHƯA lưu/); assert.match(amb, /xuất hiện \d+ lần/); assert.match(amb, /dòng \d+:/);
const miss = await d.edit.execute({ id: a3.id, edits: [{ op: 'replace', find: 'thanh toán trong vòng 60 ngày kể từ ngày giao hàng', text: 'x' }] }, { sessionID: S });
assert.match(miss, /Không tìm thấy đoạn/); assert.match(miss, /dòng \d+: .*thanh toán/);
const miss2 = await d.edit.execute({ id: a3.id, edits: [{ op: 'delete', section: 'Điều 9' }] }, { sessionID: S });
assert.match(miss2, /Không tìm thấy mục/);
const other = await d.edit.execute({ id: a3.id, edits: [{ op: 'delete', section: 'Điều 1' }] }, { sessionID: `${S}-other` });
assert.match(other, /không tìm thấy tài liệu trong cuộc trò chuyện này/);
assert.deepEqual(folderFiles(S), before, 'no file written on failure');
ok('ambiguous / missing find / missing section / foreign session → error, no files written');
console.log('   ', amb.split('\n').slice(0, 3).join('\n     '));

console.log('6. whitespace-insensitive find + replace_section + khoản section');
const r4 = await d.edit.execute({ id: a3.id, formats: ['docx'], edits: [
  { op: 'replace', find: 'Bên vi phạm   chịu phạt\n8%', text: 'Bên vi phạm chịu phạt 5%' },
  { op: 'replace_section', section: 'Điều 1', text: 'Bên A bán cho Bên B 120 tấn thép cuộn cán nóng theo tiêu chuẩn JIS G3101.' },
  { op: 'delete', section: 'Điều 2 khoản 1' },
] }, { sessionID: S });
const a4 = marker(r4);
const md4 = store.readMarkdown(store.findDocument([S], a4.id));
assert.equal(md4, md3.replace('phạt 8%', 'phạt 5%').replace('100 tấn', '120 tấn').replace('1. Giá trị hợp đồng: 1.500.000.000 đồng (đã bao gồm VAT).\n', ''));
assert.deepEqual(a4.files.map((f) => f.format).sort(), ['docx', 'redline']);
ok(`v4 ${a4.id}: ${a4.changes_summary.join(' | ')}`);

console.log('7. importDocument (upload)');
const tmp = path.join(os.tmpdir(), `upload-${Date.now()}.md`);
fs.writeFileSync(tmp, '# HỢP ĐỒNG DỊCH VỤ\n\n**Điều 1. Phạm vi**\n\nBên A cung cấp dịch vụ vận chuyển.\n\n**Điều 2. Phí dịch vụ**\n\n1. Phí: 10.000.000 đồng/tháng.\n2. Thanh toán ngày 5 hằng tháng.\n');
const up = await store.importDocument({ sessionID: S, title: 'Hợp đồng dịch vụ (tải lên)', markdown: fs.readFileSync(tmp, 'utf8'), originalPath: tmp, formats: ['docx'] });
assert.equal(up.version, 1); assert.equal(up.origin, 'upload'); assert.equal(up.kind, 'hop-dong'); assert.equal(up.parent_id, null);
assert.ok(up.original?.endsWith('.original.md') && fs.existsSync(path.join(store.outDir(S), up.original)));
assert.equal(up.national_header, false);
const r5 = await d.edit.execute({ id: up.id, edits: [{ op: 'replace', section: 'Điều 2 khoản 2', text: '2. Thanh toán ngày 10 hằng tháng.' }] }, { sessionID: S });
const a5 = marker(r5);
assert.equal(a5.origin, 'upload'); assert.equal(a5.version, 2);
// import promotes "**Điều N. …**" paragraphs to "## Điều N. …" (markers only, words unchanged)
const upMd = '# HỢP ĐỒNG DỊCH VỤ\n\n## Điều 1. Phạm vi\n\nBên A cung cấp dịch vụ vận chuyển.\n\n## Điều 2. Phí dịch vụ\n\n1. Phí: 10.000.000 đồng/tháng.\n2. Thanh toán ngày 5 hằng tháng.\n';
assert.equal(store.readMarkdown(up), upMd);
assert.equal(store.readMarkdown(store.findDocument([S], a5.id)), upMd.replace('ngày 5', 'ngày 10'));
ok(`upload ${up.id} → v2 ${a5.id} (${a5.changes_summary.join(' | ')})`);

console.log('7b. imported contract (plain extracted text): labels, sections, normalisation');
// Shape of a real upload (mammoth raw text of a .docx): no markdown at all, "Điều N." paragraphs,
// dotted khoản "2.1." / "10.2.", "– a)" điểm, national header on top, signature block at the end.
const imported = `CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM

Độc lập – Tự do – Hạnh phúc

HỢP ĐỒNG MUA BÁN HÀNG HÓA

Số: …/HĐMB-…

– Căn cứ Bộ luật Dân sự số 91/2015/QH13 và Luật Thương mại số 36/2005/QH11;

BÊN BÁN (BÊN A): …

BÊN MUA (BÊN B): …

Điều 1. Đối tượng, số lượng và chất lượng hàng hóa

1.1. Bên A bán cho Bên B thép cuộn với thông tin cơ bản sau:

1.2. Chất lượng hàng hóa: theo tiêu chuẩn công bố của nhà sản xuất.

Điều 2. Giá cả, phương thức và thời hạn thanh toán

2.1. Tổng giá trị Hợp đồng tạm tính: 1.500.000.000 đồng (đã bao gồm VAT).

2.2. Đồng tiền thanh toán: VND.

2.3. Phương thức thanh toán: chuyển khoản vào tài khoản của Bên A.

2.4. Tiến độ thanh toán (bảo vệ Bên A):

– a) Bên B đặt cọc …% giá trị Hợp đồng trong vòng … ngày kể từ ngày ký;

– b) Bên B thanh toán …% còn lại trong vòng … ngày kể từ ngày nhận đủ hàng và chứng từ;

2.5. Thời điểm thanh toán được xác định là ngày tiền vào tài khoản Bên A.

Điều 10. Giải quyết tranh chấp, luật áp dụng và thời hiệu

10.1. Tranh chấp được giải quyết lần lượt bằng thương lượng, hòa giải; nếu không thành, đưa ra Trọng tài hoặc Tòa án.

10.2. [cần thương lượng] Cơ quan giải quyết tranh chấp: …

10.3. Thời hạn khiếu nại: theo Điều 318 Luật Thương mại 2005.

10.4. Thời hiệu khởi kiện: 02 năm kể từ thời điểm quyền và lợi ích hợp pháp bị xâm phạm.

10.5. Luật áp dụng: pháp luật Việt Nam.

Điều 11. Điều khoản chung

11.1. Hợp đồng có hiệu lực kể từ ngày ký.

ĐẠI DIỆN BÊN A (BÊN BÁN)

(Ký, ghi rõ họ tên, chức vụ và đóng dấu)

ĐẠI DIỆN BÊN B (BÊN MUA)

(Ký, ghi rõ họ tên, chức vụ và đóng dấu)
`;
// (a) labels on the raw text (what live uploads produced before normalisation) – the renumbering edit of the live test
const renumber = [
  { op: 'replace', find: '– b) Bên B thanh toán …% còn lại trong vòng … ngày kể từ ngày nhận đủ hàng và chứng từ;', text: '– b) Bên B thanh toán …% còn lại trong vòng 30 (ba mươi) ngày kể từ ngày giao hàng;' },
  { op: 'replace', find: '10.5. Luật áp dụng: pháp luật Việt Nam.', text: '10.6. Luật áp dụng: pháp luật Việt Nam.' },
  { op: 'replace', find: '10.4. Thời hiệu khởi kiện:', text: '10.5. Thời hiệu khởi kiện:' },
  { op: 'replace', find: '10.3. Thời hạn khiếu nại:', text: '10.4. Thời hạn khiếu nại:' },
  { op: 'replace', find: '10.2. [cần thương lượng] Cơ quan giải quyết tranh chấp:', text: '10.3. [cần thương lượng] Cơ quan giải quyết tranh chấp:' },
  { op: 'insert_after', find: '10.1. Tranh chấp được giải quyết lần lượt bằng thương lượng, hòa giải; nếu không thành, đưa ra Trọng tài hoặc Tòa án.', text: '10.2. Các bên ưu tiên giải quyết tại VIAC.' },
];
for (const src of [imported, store.normalizeImported(imported).markdown]) {
  const res = store.applyEdits(src, renumber);
  assert.deepEqual(res.changes.map((c) => c.target), ['Điều 2 khoản 4 điểm b', 'Điều 10 khoản 5', 'Điều 10 khoản 4', 'Điều 10 khoản 3', 'Điều 10 khoản 2', 'sau Điều 10 khoản 1']);
  assert.deepEqual(store.changesSummary(res.changes), ['Sửa Điều 2 khoản 4 điểm b', 'Sửa Điều 10 khoản 2, 3, 4, 5', 'Thêm sau Điều 10 khoản 1']);
}
const lab = (find) => store.labelAt(imported, imported.indexOf(find));
assert.equal(lab('2.1. Tổng giá trị'), 'Điều 2 khoản 1');
assert.equal(lab('1.500.000.000 đồng'), 'Điều 2 khoản 1');
assert.equal(lab('2.5. Thời điểm'), 'Điều 2 khoản 5');
assert.equal(lab('Tiến độ thanh toán'), 'Điều 2 khoản 4');
assert.equal(lab('HỢP ĐỒNG MUA BÁN'), 'Đầu văn bản');
// (b) identical / mixed labels merge
const dup = store.applyEdits(imported, [
  { op: 'replace', find: 'pháp luật Việt Nam', text: 'pháp luật nước CHXHCN Việt Nam' },
  { op: 'replace', find: '10.5. Luật áp dụng:', text: '10.5. Luật điều chỉnh:' },
  { op: 'replace', find: '02 năm', text: '03 năm' },
  { op: 'replace', find: 'Điều 318 Luật Thương mại 2005', text: 'Điều 318 Luật Thương mại số 36/2005/QH11' },
  { op: 'replace', find: 'Tranh chấp được giải quyết lần lượt', text: 'Mọi tranh chấp được giải quyết lần lượt' },
  { op: 'replace', find: 'Giải quyết tranh chấp, luật áp dụng', text: 'Giải quyết tranh chấp và luật áp dụng' },
]);
assert.deepEqual(store.changesSummary(dup.changes), ['Sửa Điều 10 (6 chỗ)']);
assert.deepEqual(store.changesSummary(dup.changes.slice(0, 2)), ['Sửa Điều 10 khoản 5 (2 chỗ)']);
assert.deepEqual(store.changesSummary(dup.changes.slice(0, 3)), ['Sửa Điều 10 khoản 4, 5 (3 chỗ)']);
assert.deepEqual(store.changesSummary([{ op: 'replace', target: 'Điều 10' }, { op: 'replace', target: 'Điều 10 khoản 2' }]), ['Sửa Điều 10', 'Sửa Điều 10 khoản 2']);
// (c) sections by "Điều 10 khoản 2", "khoản 10.3", "Điều 2 khoản 4 điểm b"
const sec = (q, src = imported) => { const s = store.findSection(src, q); return [s.label, src.slice(s.start, s.end)]; };
assert.deepEqual(sec('Điều 10 khoản 2'), ['Điều 10 khoản 2', '10.2. [cần thương lượng] Cơ quan giải quyết tranh chấp: …']);
assert.deepEqual(sec('khoản 10.3'), ['Điều 10 khoản 3', '10.3. Thời hạn khiếu nại: theo Điều 318 Luật Thương mại 2005.']);
assert.deepEqual(sec('Điều 2 khoản 4 điểm b'), ['Điều 2 khoản 4 điểm b', '– b) Bên B thanh toán …% còn lại trong vòng … ngày kể từ ngày nhận đủ hàng và chứng từ;']);
assert.match(sec('Điều 2 khoản 4')[1], /^2\.4\. Tiến độ[\s\S]*chứng từ;$/);
assert.throws(() => store.findSection(imported, 'Điều 10 khoản 9'), /Không tìm thấy khoản 9/);
// (d) normalisation: national header → flag, title → #, Điều → ##, signature → sign table; idempotent; words kept
const norm = store.normalizeImported(imported);
assert.equal(norm.nationalHeader, true);
assert.deepEqual(norm.sign, ['ĐẠI DIỆN BÊN A (BÊN BÁN)', 'ĐẠI DIỆN BÊN B (BÊN MUA)']);
assert.deepEqual(norm.markdown.split('\n').filter((l) => l.startsWith('#')), ['# HỢP ĐỒNG MUA BÁN HÀNG HÓA', '## Điều 1. Đối tượng, số lượng và chất lượng hàng hóa', '## Điều 2. Giá cả, phương thức và thời hạn thanh toán', '## Điều 10. Giải quyết tranh chấp, luật áp dụng và thời hiệu', '## Điều 11. Điều khoản chung']);
assert.equal(store.normalizeImported(norm.markdown).markdown, norm.markdown, 'idempotent');
const body = imported.split('\n\n').slice(2, -4).join('\n\n').trim(); // without header + signature block
assert.equal(norm.markdown.replace(/^#+ /gm, '').trim(), body, 'only markdown markers added');
const chuong = store.normalizeImported('**CHƯƠNG I**\n\n**Điều 1. Phạm vi**\n\nNội dung.\n\nChương II\n\nĐiều 2: Hiệu lực\n\nNội dung 2.\n');
assert.equal(chuong.markdown, '## CHƯƠNG I\n\n### Điều 1. Phạm vi\n\nNội dung.\n\n## Chương II\n\n### Điều 2: Hiệu lực\n\nNội dung 2.\n');
assert.equal(chuong.nationalHeader, false); assert.equal(chuong.sign, null);
// signature as a 2-column table (docx → markdown)
const tsign = store.normalizeImported('# HỢP ĐỒNG\n\n## Điều 1. X\n\nNội dung.\n\n| **ĐẠI DIỆN BÊN A**<br>*(Ký, ghi rõ họ tên)* | **ĐẠI DIỆN BÊN B**<br>*(Ký, ghi rõ họ tên)* |\n| --- | --- |\n');
assert.deepEqual(tsign.sign, ['ĐẠI DIỆN BÊN A', 'ĐẠI DIỆN BÊN B']); assert.doesNotMatch(tsign.markdown, /ĐẠI DIỆN|\|/);
// a names row under the labels is content → table kept
assert.equal(store.normalizeImported('Nội dung.\n\n| ĐẠI DIỆN BÊN A | ĐẠI DIỆN BÊN B |\n| --- | --- |\n| Nguyễn Văn A | Trần Thị B |\n').sign, null);
// (e) import + edit through the tools: header rendered once, sign table, find copied from the upload text works
const upc = await store.importDocument({ sessionID: S, title: 'hop-dong-thep', markdown: imported, formats: ['docx'] });
assert.equal(upc.national_header, true); assert.deepEqual(upc.sign, norm.sign); assert.equal(upc.kind, 'hop-dong');
const upcMd = store.readMarkdown(upc);
assert.equal(upcMd, norm.markdown); assert.doesNotMatch(upcMd, /CỘNG HÒA/);
const html = fs.readFileSync(path.join(store.outDir(S), upc.preview), 'utf8');
assert.equal(html.match(/CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM/g).length, 1, 'national header rendered once');
assert.match(html, /<h1>HỢP ĐỒNG MUA BÁN HÀNG HÓA<\/h1>/); assert.match(html, /<h2>Điều 10\. Giải quyết tranh chấp/); assert.match(html, /table class="sign"/);
const r8 = marker(await d.edit.execute({ id: upc.id, formats: ['docx'], edits: renumber }, { sessionID: S }));
assert.deepEqual(r8.changes_summary, ['Sửa Điều 2 khoản 4 điểm b', 'Sửa Điều 10 khoản 2, 3, 4, 5', 'Thêm sau Điều 10 khoản 1']);
const v8 = store.findDocument([S], r8.id);
assert.equal(v8.national_header, true); assert.deepEqual(v8.sign, norm.sign); assert.deepEqual(v8.changes_summary, r8.changes_summary);
assert.match(store.readMarkdown(v8), /10\.1\. Tranh chấp[^\n]*\n\n10\.2\. Các bên ưu tiên giải quyết tại VIAC\.\n\n10\.3\. \[cần/);
ok(`imported contract ${upc.id} → v2 ${r8.id}: ${r8.changes_summary.join(' | ')}`);
// (f) optional: the latest real .docx upload through the server's extractor (mammoth → markdown)
const sample = fs.readdirSync(store.outputsRoot(), { withFileTypes: true }).filter((e) => e.isDirectory())
  .flatMap((e) => { try { return fs.readdirSync(path.join(store.outputsRoot(), e.name)).filter((n) => /^hop-dong-thep-.*\.original\.docx$/.test(n)).map((n) => path.join(store.outputsRoot(), e.name, n)); } catch { return []; } })
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (sample) {
  const { extractText } = await import('../web/server/extract.mjs');
  const ex = await extractText(sample, '.docx', 60000);
  const nx = store.normalizeImported(ex.text);
  assert.equal(nx.nationalHeader, true); assert.ok(nx.sign, 'signature table detected');
  assert.match(nx.markdown, /^# HỢP ĐỒNG/); assert.match(nx.markdown, /^## Điều 1\. /m); assert.match(nx.markdown, /^\| \*\*STT\*\* \|/m);
  assert.equal(store.normalizeImported(nx.markdown).markdown, nx.markdown, 'idempotent (docx)');
  ok(`sample ${path.basename(sample)}: ${nx.markdown.split('\n').filter((l) => /^#/.test(l)).length} headings, table kept, header + sign detected`);
} else console.log('  – no hop-dong-thep .original.docx sample – docx extraction check skipped');

console.log('8. fork continuity (inheritSession)');
const F = `${S}-fork`;
assert.ok(store.inheritSession(S, F) > 0);
assert.equal(store.inheritSession(S, F), 0, 'idempotent');
const rf = await d.read.execute({ id: a3.id }, { sessionID: F });
assert.match(rf, /phiên bản 3/);
const r6 = await d.edit.execute({ id: a3.id, formats: ['docx'], edits: [{ op: 'insert_before', section: 'Điều 5', text: '## Điều 4. Bảo hành\n\nBảo hành 12 tháng.' }] }, { sessionID: F });
const a6 = marker(r6);
assert.equal(a6.parent_id, a3.id); assert.equal(a6.version, 4);
assert.ok(fs.existsSync(path.join(store.outDir(F), `${store.findDocument([F], a6.id).markdown}`)), 'fork version saved in the fork folder');
assert.equal(store.readMarkdown(store.findDocument([F], a6.id)), md3.replace('## Điều 5', '## Điều 4. Bảo hành\n\nBảo hành 12 tháng.\n\n## Điều 5'));
ok(`fork ${F}: edited ${a3.id} → ${a6.id} (${a6.changes_summary.join(' | ')})`);

console.log('9. backward compatibility (meta without version)');
const legacy = { id: '20250101000000-abcdef', title: 'Cũ', kind: 'van-ban', files: [], preview: 'cu-20250101000000-abcdef.html', markdown: 'cu-20250101000000-abcdef.md', sessionID: S, createdAt: new Date().toISOString() };
fs.writeFileSync(path.join(store.outDir(S), 'cu-20250101000000-abcdef.json'), JSON.stringify(legacy));
fs.writeFileSync(path.join(store.outDir(S), 'cu-20250101000000-abcdef.md'), '# Cũ\n\nNội dung cũ.\n');
const lm = store.findDocument([S], legacy.id);
assert.equal(lm.version, 1); assert.equal(lm.root_id, legacy.id); assert.equal(lm.parent_id, null);
const r7 = marker(await d.edit.execute({ id: legacy.id, formats: ['docx'], edits: [{ op: 'replace', find: 'cũ.', text: 'mới.' }] }, { sessionID: S }));
assert.equal(r7.version, 2); assert.equal(r7.root_id, legacy.id);
assert.equal(store.findDocument([S], '../etc'), null);
ok('legacy meta treated as v1; invalid id rejected');

console.log(`\nALL PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s – outputs in ${store.outDir(S)}`);
