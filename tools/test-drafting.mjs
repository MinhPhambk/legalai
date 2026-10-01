// Tests for the staged long-document drafting tools (.opencode/tools/draft.ts, .opencode/lib/drafting.ts).
// Needs the sandbox Chrome (node tools/launch-chrome.mjs) for vbpl.vn + PDF, and the model provider (.env).
//   node tools/test-drafting.mjs            all parts (a–e)
//   node tools/test-drafting.mjs a c        only some parts (c and e reuse the draft of b; run b first in the same run)
// (a) plan validation   (b) ~20-section distribution contract, real vbpl evidence, parallel 4, timings
// (c) injected issues found by draft_check and repaired by draft_fix   (d) bilingual pipeline (small)
// (e) assemble → doc-store artifact (docx/pdf) and document_edit on it
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const T = await import('../.opencode/tools/draft.ts');
const L = await import('../.opencode/lib/drafting.ts');
const V = await import('../.opencode/tools/vbpl.ts');
const D = await import('../.opencode/tools/document.ts');
const ev = await import('../.opencode/lib/evidence.ts');

const want = new Set(process.argv.slice(2));
const run = (p) => !want.size || want.has(p) || (want.has('c') && p === 'b') || (want.has('e') && p === 'b');
const ok = (m) => console.log('  ✓', m);
const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
const LTM = 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117';
const BLDS = 'https://vbpl.vn/van-ban/chi-tiet/bo-luat-dan-su-so-91-2015-qh13--95942';
/** Tool context like opencode's: sessionID + metadata() collector (live progress). */
const ctx = (sessionID) => { const meta = []; return { sessionID, metadata: (m) => meta.push(m), meta, abort: new AbortController().signal }; };
const out = (r) => (typeof r === 'string' ? r : r.output);
const draftIdOf = (r) => out(r).match(/mã dự thảo: (d-[\w-]+)/)?.[1];
const timings = {};

// ---------------- (a) plan validation ----------------
if (run('a')) {
  console.log('\n(a) plan validation');
  const c = ctx('drafting-a-' + Date.now());
  const bad = await T.plan.execute({
    title: 'Hợp đồng thử', kind: 'hop-dong', brief: 'thử', parties: [{ role: 'Bên bán' }],
    sections: [
      { key: 'doi-tuong', heading: 'Điều 1. Đối tượng', must_include: ['hàng hóa'] },
      { key: 'doi-tuong', heading: 'Điều 3. Thanh toán', must_include: [] },
      { key: 'Phat Vi Pham', heading: 'Phạt vi phạm' },
      { key: 'pl1', heading: 'Phụ lục 1. Danh mục' },
      { key: 'tranh-chap', heading: 'Giải quyết tranh chấp', must_include: ['trọng tài'] },
      { key: 'x', heading: 'Đối tượng', must_include: ['a'] },
    ],
  }, c);
  const t = out(bad);
  assert.match(t, /CHƯA lập dàn ý/);
  assert.match(t, /key "doi-tuong" bị trùng/);
  assert.match(t, /ghi số 3 nhưng theo thứ tự phải là Điều 2/);
  assert.match(t, /Thanh toán" là điều khoản chủ yếu – `must_include` không được rỗng/);
  assert.match(t, /\(phat-vi-pham\) "Phạt vi phạm"/, "keys are normalised");
  assert.match(t, /đứng sau Phụ lục/);
  assert.match(t, /trùng với mục "doi-tuong"/);
  assert.match(t, /ít nhất 2 bên/);
  ok('duplicate keys, wrong numbering, empty must_include for key clauses, key normalisation, Điều after Phụ lục, duplicate heading, parties');
  const nin = ['1. Đối tượng', '2. Khu vực', '1. Bên B phân phối tại …', '2. Bên B không bán ngoài Khu Vực.', '3. Độc quyền', '4. Bên A không chỉ định đại lý khác.'].join('\n');
  assert.equal(L.nestRestarts(nin), nin.replace('1. Bên B', '2.1. Bên B').replace('2. Bên B', '2.2. Bên B'));
  ok("restarted khoản numbering → sub-khoản 2.1., 2.2.");
  const many = await T.plan.execute({ title: 'x', kind: 'bao-cao', brief: 'x', sections: Array.from({ length: 41 }, (_, i) => ({ key: `m${i}`, heading: `Mục số ${i}` })) }, c);
  assert.match(out(many), /Tối đa 40 mục/);
  ok('> 40 sections rejected');
  const noEv = await T.plan.execute({ title: 'x', kind: 'hop-dong', brief: 'x', parties: [{ role: 'Bên bán' }, { role: 'Bên mua' }], sections: [{ key: 'gia', heading: 'Giá', must_include: ['giá'], legal_basis_urls: [`${LTM} Điều 50`] }] }, c);
  assert.match(out(noEv), /Chưa có căn cứ pháp lý nào đã tra/);
  assert.match(out(noEv), /chưa được mở bằng công cụ tra cứu/);
  ok('contract without researched legal basis rejected');
}

// ---------------- (b) full pipeline: 20-section distribution contract ----------------
let B; // { sid, c, draftId, doc }
if (run('b')) {
  console.log('\n(b) full pipeline – exclusive distribution contract (20 sections, parallel 4)');
  const sid = 'drafting-b-' + Date.now();
  const c = ctx(sid);
  let t0 = Date.now();
  // research with the real vbpl tools (each call records the full law text as evidence of this session)
  await V.article.execute({ url: LTM, article: 'Điều 301' }, c);
  await V.article.execute({ url: BLDS, article: 'Điều 156' }, c);
  timings.research = Date.now() - t0;
  assert.ok(ev.loadEvidence(sid).some((e) => e.url.includes('26117')), 'LTM evidence recorded');
  ok(`research pack from vbpl.vn (${s(timings.research)})`);
  const ltm = (...a) => `${LTM} ${a.map((x) => `Điều ${x}`).join(', ')}`;
  const sections = [
    { key: 'giai-thich', heading: 'Giải thích từ ngữ', purpose: 'Định nghĩa các thuật ngữ dùng trong hợp đồng' },
    { key: 'doi-tuong', heading: 'Đối tượng và phạm vi phân phối', must_include: ['Bên A chỉ định Bên B làm nhà phân phối độc quyền Sản Phẩm tại Khu Vực', 'Bên B mua Sản Phẩm để bán lại dưới danh nghĩa của mình'], legal_basis_urls: [ltm(24)] },
    { key: 'doc-quyen', heading: 'Quyền phân phối độc quyền', must_include: ['Bên A không chỉ định nhà phân phối khác tại Khu Vực', 'Bên B không phân phối sản phẩm cạnh tranh', 'Bên A được bán trực tiếp cho khách hàng dự án [cần thương lượng]'] },
    { key: 'chi-tieu', heading: 'Chỉ tiêu doanh số', must_include: ['Chỉ Tiêu Doanh Số từng năm theo Phụ lục 2', 'không đạt 80% chỉ tiêu thì Bên A có quyền chấm dứt độc quyền'] },
    { key: 'dat-hang', heading: 'Đặt hàng và xác nhận đơn hàng', must_include: ['Đơn Đặt Hàng bằng văn bản/email', 'Bên A xác nhận trong 3 ngày làm việc'] },
    { key: 'gia', heading: 'Giá bán và điều chỉnh giá', must_include: ['giá theo Bảng Giá tại Phụ lục 1', 'Bên A được điều chỉnh giá với thông báo trước 30 ngày'], legal_basis_urls: [ltm(52)] },
    { key: 'thanh-toan', heading: 'Thanh toán', must_include: ['thanh toán trong 30 ngày kể từ ngày nhận hóa đơn', 'chuyển khoản', 'lãi chậm trả theo Điều 306 Luật Thương mại'], legal_basis_urls: [ltm(50, 306)] },
    { key: 'giao-hang', heading: 'Giao hàng và chuyển rủi ro', must_include: ['địa điểm giao hàng tại kho Bên B', 'rủi ro chuyển khi giao hàng', 'quyền sở hữu chuyển khi thanh toán đủ'], legal_basis_urls: [ltm(34, 57, 62)] },
    { key: 'chat-luong', heading: 'Chất lượng, kiểm tra và bảo hành', must_include: ['kiểm tra khi nhận hàng', 'khiếu nại trong 7 ngày', 'bảo hành theo chính sách Bên A'] },
    { key: 'nhan-hieu', heading: 'Nhãn hiệu và sở hữu trí tuệ', must_include: ['Bên B chỉ sử dụng Nhãn Hiệu để phân phối Sản Phẩm', 'không đăng ký nhãn hiệu tương tự'] },
    { key: 'marketing', heading: 'Tiếp thị và báo cáo', must_include: ['kế hoạch tiếp thị hằng quý', 'báo cáo tồn kho và doanh số hằng tháng'] },
    { key: 'nghia-vu-a', heading: 'Quyền và nghĩa vụ của Bên A', must_include: ['cung cấp Sản Phẩm đúng chất lượng', 'hỗ trợ đào tạo', 'kiểm tra hoạt động phân phối'] },
    { key: 'nghia-vu-b', heading: 'Quyền và nghĩa vụ của Bên B', must_include: ['duy trì tồn kho tối thiểu', 'bán đúng giá bán lẻ khuyến nghị [cần thương lượng]', 'không bán ngoài Khu Vực'] },
    { key: 'bao-mat', heading: 'Bảo mật thông tin', must_include: ['Thông Tin Mật', 'thời hạn bảo mật 3 năm sau khi chấm dứt'] },
    { key: 'phat-vi-pham', heading: 'Phạt vi phạm và bồi thường thiệt hại', must_include: ['phạt 8% giá trị phần nghĩa vụ bị vi phạm', 'bồi thường thiệt hại thực tế'], legal_basis_urls: [ltm(300, 301, 302, 303)] },
    { key: 'bat-kha-khang', heading: 'Sự kiện bất khả kháng', must_include: ['định nghĩa theo Bộ luật Dân sự', 'thông báo trong 7 ngày', 'miễn trách nhiệm'], legal_basis_urls: [`${BLDS} Điều 156`, ltm(294, 295)] },
    { key: 'thoi-han', heading: 'Thời hạn và chấm dứt hợp đồng', must_include: ['thời hạn 3 năm', 'các trường hợp chấm dứt', 'xử lý hàng tồn kho khi chấm dứt'], legal_basis_urls: [ltm(310, 312)] },
    { key: 'tranh-chap', heading: 'Luật áp dụng và giải quyết tranh chấp', must_include: ['pháp luật Việt Nam', 'thương lượng 30 ngày', 'Trung tâm Trọng tài Quốc tế Việt Nam (VIAC)'] },
    { key: 'dieu-khoan-chung', heading: 'Điều khoản chung', must_include: ['hiệu lực', 'sửa đổi bằng văn bản', 'các Phụ lục là bộ phận không tách rời'] },
    { key: 'pl-bang-gia', heading: 'Phụ lục 1. Danh mục Sản Phẩm và Bảng Giá', must_include: ['bảng: mã sản phẩm, tên, quy cách, đơn giá'] },
    { key: 'pl-chi-tieu', heading: 'Phụ lục 2. Chỉ tiêu doanh số', must_include: ['bảng chỉ tiêu theo năm 2027–2029'] },
  ];
  t0 = Date.now();
  const p = await T.plan.execute({
    title: 'Hợp đồng phân phối độc quyền', kind: 'hop-dong', language: 'vi',
    brief: 'Nhà sản xuất nước giải khát (Bên A) chỉ định nhà phân phối độc quyền (Bên B) tại khu vực miền Bắc, thời hạn 3 năm; Bên B mua đứt để bán lại.',
    user_side: 'Bên A – bên cung cấp (nhà sản xuất)',
    parties: [{ role: 'Bên cung cấp', name_placeholder: 'CÔNG TY …' }, { role: 'Nhà phân phối', name_placeholder: 'CÔNG TY …' }],
    glossary: [
      { term: 'Sản Phẩm', definition: 'các sản phẩm nước giải khát mang Nhãn Hiệu của Bên A liệt kê tại Phụ lục 1' },
      { term: 'Khu Vực', definition: 'các tỉnh, thành phố miền Bắc liệt kê tại Điều 2' },
      { term: 'Nhãn Hiệu', definition: 'nhãn hiệu … của Bên A' },
      { term: 'Chỉ Tiêu Doanh Số', definition: 'doanh số mua tối thiểu hằng năm tại Phụ lục 2' },
      { term: 'Đơn Đặt Hàng', definition: 'yêu cầu mua Sản Phẩm của Bên B gửi Bên A' },
      { term: 'Bảng Giá', definition: 'bảng giá bán Sản Phẩm cho Bên B tại Phụ lục 1' },
      { term: 'Thông Tin Mật', definition: 'thông tin kinh doanh, kỹ thuật không công khai của một bên' },
    ],
    facts: { 'hàng hóa': 'nước giải khát đóng chai', 'khu vực': 'miền Bắc (… tỉnh)', 'thời hạn': '3 năm', 'mức phạt': '8% giá trị phần nghĩa vụ bị vi phạm', 'thời hạn thanh toán': '30 ngày kể từ ngày nhận hóa đơn', 'chỉ tiêu tối thiểu': '80%' },
    style: { detail: 'chi tiết' },
    sections,
  }, c);
  timings.plan = Date.now() - t0;
  const draftId = draftIdOf(p);
  assert.ok(draftId, out(p));
  assert.equal(p.metadata.draft.phase, 'plan');
  assert.equal(p.metadata.draft.sections.length, 21);
  assert.equal(c.meta.at(-1).metadata.draft.draftId, draftId);
  const d0 = L.loadDraft(sid, draftId);
  assert.ok(d0.research.find((r) => r.article === 'Điều 301' && /không quá 8%/.test(r.text)), 'Điều 301 in research pack');
  assert.ok(d0.research.find((r) => r.law?.startsWith('Bộ luật Dân sự') && r.article === 'Điều 156'), 'BLDS Điều 156 in pack');
  ok(`plan ${draftId}: ${d0.sections.length} sections (${d0.sections.filter((x) => x.type === 'annex').length} annexes), ${d0.research.length} research snippets`);
  console.log(out(p).split('\n').filter((l) => /^- R\d|Lưu ý|^- .*(chưa|không thấy)/.test(l)).slice(0, 30).join('\n'));

  t0 = Date.now();
  const w = await T.write.execute({ draftId, parallel: 4 }, c);
  timings.write = Date.now() - t0;
  console.log(out(w).split('\n').slice(0, 1).join('\n'));
  const statuses = new Set(c.meta.flatMap((m) => m.metadata.draft.sections.map((x) => x.status)));
  assert.ok(statuses.has('writing') && statuses.has('written'), 'live progress: writing → written');
  const maxWriting = Math.max(...c.meta.map((m) => m.metadata.draft.sections.filter((x) => x.status === 'writing').length));
  assert.ok(maxWriting >= 2 && maxWriting <= 4, `parallel writers (max concurrent ${maxWriting})`);
  const d1 = L.loadDraft(sid, draftId);
  const failed = d1.sections.filter((x) => x.status === 'failed');
  if (failed.length) { console.log('  retry failed:', failed.map((x) => x.key)); await T.write.execute({ draftId, sections: failed.map((x) => x.key) }, c); }
  const words = L.loadDraft(sid, draftId).sections.reduce((a, x) => a + (x.wordCount ?? 0), 0);
  ok(`write: ${d1.sections.length - failed.length}/${d1.sections.length} sections, ≈${words} words in ${s(timings.write)} (max ${maxWriting} concurrent)`);
  const pf = JSON.parse(fs.readFileSync(path.join(L.draftsDir(sid), draftId, 'progress.json'), 'utf8'));
  assert.equal(pf.draftId, draftId); assert.ok(['write'].includes(pf.phase));
  ok('progress.json mirrors the metadata');

  t0 = Date.now();
  const ch = await T.check.execute({ draftId }, c);
  timings.check = Date.now() - t0;
  console.log(out(ch).split('\n').slice(0, 25).join('\n'));
  const iss = L.loadIssues(L.loadDraft(sid, draftId));
  ok(`check: ${iss.length} issues (${iss.filter((i) => i.source === 'auto').length} auto, ${iss.filter((i) => i.source === 'review').length} review) in ${s(timings.check)}`);
  const errs = iss.filter((i) => i.severity === 'lỗi').length;
  // every draft_* output ends with an explicit next step; 0 errors → draft_check assembles by itself
  if (errs) {
    assert.equal(ch.metadata.draft.phase, 'check');
    assert.match(out(ch), /BƯỚC TIẾP THEO: gọi draft_fix\(\{draftId:"d-/);
    // an un-assembled draft: document_read / document_edit explain what to do instead of failing silently
    const hint = out(await D.read.execute({ id: draftId }, c));
    assert.match(hint, /bản nháp chưa gộp[\s\S]*draft_assemble\(\{draftId:"d-/, hint);
    assert.match(out(await D.edit.execute({ id: 'khong-co-ma', edits: [{ op: 'delete', find: 'x' }] }, c)), /bản nháp chưa gộp/);
    ok('check with errors → "BƯỚC TIẾP THEO: gọi draft_fix"; document_read / document_edit on the un-assembled draft → "gọi draft_assemble trước"');
  } else assert.equal(ch.metadata.draft.phase, 'done');

  t0 = Date.now();
  const fx = errs ? await T.fix.execute({ draftId }, c) : ch;
  timings.fixAndAssemble = Date.now() - t0;
  console.log(out(fx).split('\n').slice(0, 14).join('\n'));
  // draft_fix assembles automatically (assemble default true) → artifact marker even if the model stops here
  const marker = out(fx).match(/\[\[artifact:(\{[\s\S]*\})\]\]\s*$/);
  assert.ok(marker, 'auto-assembled artifact marker');
  const doc = JSON.parse(marker[1]);
  assert.equal(fx.metadata.draft.phase, 'done');
  assert.equal(fx.metadata.draft.document.id, doc.id);
  ok(`fix + automatic assembly → artifact ${doc.id} (${s(timings.fixAndAssemble)})`);
  // warnings only → draft_fix does not fix more, just (re)assembles as the next version
  const again = await T.fix.execute({ draftId }, c);
  if (!L.loadIssues(L.loadDraft(sid, draftId)).some((i) => i.status === 'open' && i.severity === 'lỗi')) {
    assert.match(out(again), /không còn lỗi – không sửa thêm cảnh báo/);
    const m2 = JSON.parse(out(again).match(/\[\[artifact:(\{[\s\S]*\})\]\]\s*$/)[1]);
    assert.equal(m2.version, 2); assert.equal(m2.parent_id, doc.id);
    ok('draft_fix with 0 errors: no more fixing, re-assembled as version 2 of the same document');
  }
  const hint2 = out(await D.read.execute({ id: draftId }, c));
  assert.match(hint2, /dùng mã tài liệu/);
  B = { sid, c, draftId, doc };
  console.log('  timings:', Object.entries(timings).map(([k, v]) => `${k} ${s(v)}`).join(', '));
}

// ---------------- (c) injected issues ----------------
if (run('c') && B) {
  console.log('\n(c) injected issues: wrong cross-reference, conflicting penalty, undefined term, quote not in pack, amount in words');
  const { sid, c, draftId } = B;
  const d = L.loadDraft(sid, draftId);
  const dir = path.join(L.draftsDir(sid), draftId, 'sections');
  const f = (k) => path.join(dir, `${k}.md`);
  const snapshot = Object.fromEntries(d.sections.map((x) => [x.key, fs.readFileSync(f(x.key), 'utf8')]));
  const add = (k, text) => fs.writeFileSync(f(k), snapshot[k].trimEnd() + '\n\n' + text + '\n');
  const nk = (k) => (snapshot[k].match(/^\s*\d{1,2}\.\s/gm) ?? []).length + 1;
  add('thanh-toan', `${nk('thanh-toan')}. Các tranh chấp về thanh toán được giải quyết theo quy định tại Điều 45 Hợp đồng này.`);
  add('chat-luong', `${nk('chat-luong')}. Trường hợp giao Sản Phẩm không đúng chất lượng, Bên B chịu phạt 12% giá trị toàn bộ Hợp đồng.`);
  add('marketing', `${nk('marketing')}. Báo cáo hằng tháng phải nêu rõ Doanh Số Thuần của từng kênh bán hàng.`);
  add('bao-mat', `${nk('bao-mat')}. Theo Luật Thương mại 2005, “bên vi phạm nghĩa vụ bảo mật phải bồi thường gấp đôi giá trị thiệt hại cho bên bị vi phạm theo quy định của pháp luật”.`);
  add('gia', `${nk('gia')}. Giá trị đơn hàng tối thiểu mỗi lần đặt hàng là 50.000.000 đồng (Bằng chữ: năm mươi lăm triệu đồng).`);
  const t0 = Date.now();
  const ch = await T.check.execute({ draftId, review: false }, c);
  const iss = L.loadIssues(L.loadDraft(sid, draftId));
  const find = (code, sec, re) => iss.find((i) => i.code.startsWith(code) && i.section === sec && i.status === 'open' && (!re || re.test(i.message)));
  const xref = find('xref-missing', 'thanh-toan', /Điều 45/);
  const cap = find('penalty-cap', 'chat-luong', /12%/);
  const conflict = iss.find((i) => i.code === 'conflict:mức phạt vi phạm' && /12%/.test(i.message));
  const term = find('term-undefined', 'marketing', /Doanh Số Thuần/);
  const quote = find('quote-not-in-pack', 'bao-mat', /gấp đôi/);
  const money = find('amount', 'gia', /bằng chữ/);
  for (const [n, x] of Object.entries({ xref, cap, conflict, term, quote, money })) assert.ok(x, `draft_check finds ${n}\n${out(ch)}`);
  ok(`draft_check (machine checks) found all 5 injected issues in ${s(Date.now() - t0)}: ${[xref, cap, conflict, term, quote, money].map((i) => i.id).join(', ')}`);
  const t1 = Date.now();
  const fx = await T.fix.execute({ draftId, issues: [xref.id, cap.id, conflict.id, term.id, quote.id, money.id], assemble: false }, c);
  assert.match(out(fx), /BƯỚC TIẾP THEO: gọi draft_assemble/);
  console.log(out(fx).split('\n').slice(0, 8).join('\n'));
  const after = L.loadIssues(L.loadDraft(sid, draftId));
  for (const i of [xref, cap, term, quote, money]) assert.equal(after.find((x) => x.id === i.id).status, 'fixed', `${i.id} ${i.code} fixed\n${out(fx)}`);
  assert.ok(!(await L.autoCheck(L.loadDraft(sid, draftId))).some((i) => /Điều 45|12%|Doanh Số Thuần|gấp đôi|năm mươi lăm/.test(i.message)), 'no injected issue left');
  const untouched = d.sections.filter((x) => !['thanh-toan', 'chat-luong', 'marketing', 'bao-mat', 'gia'].includes(x.key) && x.key !== conflict.section);
  for (const x of untouched) assert.equal(fs.readFileSync(f(x.key), 'utf8'), snapshot[x.key], `${x.key} byte-identical`);
  ok(`draft_fix repaired them in ${s(Date.now() - t1)}; ${untouched.length} other sections byte-identical`);
  const as = await T.assemble.execute({ draftId }, c);
  B.doc = JSON.parse(out(as).match(/\[\[artifact:(\{[\s\S]*\})\]\]\s*$/)[1]);
  ok(`re-assembled → ${B.doc.id}`);
}

// ---------------- (d) bilingual ----------------
if (run('d')) {
  console.log('\n(d) bilingual pipeline (4 sections)');
  const sid = 'drafting-d-' + Date.now();
  const c = ctx(sid);
  await V.article.execute({ url: LTM, article: 'Điều 301' }, c);
  const t0 = Date.now();
  const p = await T.plan.execute({
    title: 'Hợp đồng mua bán hàng hóa', title_en: 'Sales Contract', kind: 'hop-dong', language: 'bilingual',
    brief: 'Công ty Việt Nam (Bên A) bán cà phê nhân cho công ty Singapore (Bên B), giao FOB Hải Phòng.', user_side: 'Bên A – bên bán',
    parties: [{ role: 'Bên bán', role_en: 'Seller', name_placeholder: 'CÔNG TY …' }, { role: 'Bên mua', role_en: 'Buyer', name_placeholder: '… PTE. LTD.' }],
    glossary: [{ term: 'Hàng Hóa', definition: 'cà phê nhân Robusta loại 1', en: 'Goods' }, { term: 'Giá Trị Hợp Đồng', definition: 'tổng giá trị Hàng Hóa theo Điều 2', en: 'Contract Value' }],
    facts: { 'số lượng': '… tấn', 'thanh toán': 'L/C trả ngay', 'mức phạt': '8%' },
    style: { detail: 'chuẩn' },
    sections: [
      { key: 'dinh-nghia', heading: 'Giải thích từ ngữ', heading_en: 'Definitions' },
      { key: 'hang-hoa', heading: 'Hàng hóa, số lượng và giá', heading_en: 'Goods, Quantity and Price', must_include: ['Hàng Hóa', 'số lượng', 'đơn giá FOB Hải Phòng'] },
      { key: 'thanh-toan', heading: 'Thanh toán', heading_en: 'Payment', must_include: ['L/C trả ngay không hủy ngang', 'chứng từ xuất trình'] },
      { key: 'phat', heading: 'Phạt vi phạm', heading_en: 'Penalty', must_include: ['phạt 8% giá trị phần nghĩa vụ bị vi phạm'], legal_basis_urls: [`${LTM} Điều 301`] },
    ],
  }, c);
  const draftId = draftIdOf(p);
  assert.ok(draftId, out(p));
  await T.write.execute({ draftId, parallel: 4 }, c);
  const d = L.loadDraft(sid, draftId);
  for (const x of d.sections) {
    assert.ok(L.sectionText(d, x.key, 'en').startsWith(`## Article ${x.no}.`), `${x.key} EN heading`);
    assert.ok(L.sectionText(d, x.key, 'vi').startsWith(`## Điều ${x.no}.`), `${x.key} VI heading`);
  }
  ok('VI + EN sections with aligned headings');
  const ch = await T.check.execute({ draftId }, c);
  console.log(out(ch).split('\n').slice(0, 8).join('\n'));
  const fx = await T.fix.execute({ draftId, formats: ['docx'] }, c);
  console.log(out(fx).split('\n').slice(0, 4).join('\n'));
  const as = /\[\[artifact:/.test(out(fx)) ? fx : /\[\[artifact:/.test(out(ch)) ? ch : await T.assemble.execute({ draftId, formats: ['docx'] }, c);
  const doc = JSON.parse(out(as).match(/\[\[artifact:(\{[\s\S]*\})\]\]\s*$/)[1]);
  assert.equal(doc.language, 'bilingual');
  const rd = await D.read.execute({ id: doc.id }, c);
  assert.match(out(rd), /\[VI\][\s\S]*\[EN\]/); assert.match(out(rd), /Article 4/);
  ok(`bilingual artifact ${doc.id} (${s(Date.now() - t0)}), document_read shows [VI]/[EN]`);
}

// ---------------- (e) artifact + document_edit ----------------
if (run('e') && B) {
  console.log('\n(e) assembled artifact + document_edit');
  const { c, doc } = B;
  const dir = path.join(process.env.XDG_CACHE_HOME, '..', 'outputs', B.sid.replace(/[^\w.-]/g, '_'));
  const files = fs.readdirSync(dir).filter((x) => x.includes(doc.id));
  assert.ok(files.some((x) => x.endsWith('.docx')), 'docx'); assert.ok(files.some((x) => x.endsWith('.md')), 'md');
  console.log('  files:', files.join(', '));
  // annexes after the signature block, each on a new page (md marker → html section.annex / docx pageBreakBefore)
  const base = files.find((x) => x.endsWith('.md')).replace(/\.md$/, '');
  const mdTxt = fs.readFileSync(path.join(dir, base + '.md'), 'utf8');
  assert.ok(mdTxt.indexOf('<!-- phu-luc -->') > mdTxt.lastIndexOf('## Điều ') && mdTxt.indexOf('<!-- phu-luc -->') < mdTxt.indexOf('## Phụ lục 1'), 'marker between last Điều and Phụ lục 1');
  assert.match(mdTxt, /## Phụ lục 1\.[^\n]*\n\n\*\(Kèm theo Hợp đồng số/);
  const html = fs.readFileSync(path.join(dir, base + '.html'), 'utf8');
  assert.ok(html.indexOf('class="sign"') < html.indexOf('class="annex"') && html.indexOf('class="annex"') < html.search(/<h2[^>]*>Phụ lục 1/), 'html: signature before annexes');
  assert.equal((html.match(/<section class="annex">/g) ?? []).length, 2);
  const JSZip = (await import('node:module')).createRequire(import.meta.url)('jszip');
  const xml = await (await JSZip.loadAsync(fs.readFileSync(path.join(dir, base + '.docx')))).file('word/document.xml').async('string');
  assert.ok(xml.indexOf('ĐẠI DIỆN BÊN A') < xml.lastIndexOf('Phụ lục 1') && (xml.match(/w:pageBreakBefore/g) ?? []).length >= 2, 'docx: signature table before annexes, page breaks');
  ok('annexes after the signature block, each on a new page (md / html / docx)');
  const rd = out(await D.read.execute({ id: doc.id, section: 'Điều 7' }, c));
  assert.match(rd, /Điều 7\. Thanh toán/);
  const line = rd.split('\n').find((l) => /│\s*1\.\s/.test(l));
  const find = line.replace(/^\s*\d+│ ?/, '').slice(0, 60);
  const ed = out(await D.edit.execute({ id: doc.id, edits: [{ op: 'insert_after', find, text: '\n(Ghi chú thử nghiệm: bổ sung sau khi ghép.)' }], note: 'thử document_edit trên văn bản ghép' }, c));
  assert.match(ed, /phiên bản \d+/, ed);
  ok('document_read (section) + document_edit on the assembled document → version 2');
  const full = out(await D.read.execute({ id: doc.id }, c));
  assert.match(full, /CỘNG HÒA|Hợp đồng phân phối độc quyền/i);
}
// ---------------- (f) doc-store annex marker: single-language + bilingual, document_edit + redline keep the layout ----------------
if (run('f')) {
  console.log('\n(f) annexes after the signature block (doc-store marker)');
  const S = await import('../.opencode/lib/doc-store.ts');
  const c = ctx('drafting-f-' + Date.now());
  const vi = `# Hợp đồng thử\n\n## Điều 1. Đối tượng\n\n1. Bên A bán cho Bên B hàng hóa theo Phụ lục 1.\n\n## Điều 2. Hiệu lực\n\n1. Hợp đồng có hiệu lực từ ngày ký.\n\n${S.ANNEX_MARKER}\n\n## Phụ lục 1. Danh mục hàng hóa\n\n*(Kèm theo Hợp đồng số …)*\n\n| Mã | Tên |\n|---|---|\n| 01 | … |\n\n## Phụ lục 2. Lịch giao hàng\n\n1. Giao hàng hằng tháng.\n`;
  const en = vi.replace('# Hợp đồng thử', '# Test Contract').replace('## Điều 1. Đối tượng', '## Article 1. Subject').replace('1. Bên A bán cho Bên B hàng hóa theo Phụ lục 1.', '1. Party A sells the goods in Appendix 1 to Party B.')
    .replace('## Điều 2. Hiệu lực', '## Article 2. Effect').replace('1. Hợp đồng có hiệu lực từ ngày ký.', '1. This Contract takes effect upon signing.')
    .replace('## Phụ lục 1. Danh mục hàng hóa', '## Appendix 1. List of Goods').replace('*(Kèm theo Hợp đồng số …)*', '*(Attached to Contract No. …)*').replace('| Mã | Tên |', '| Code | Name |')
    .replace('## Phụ lục 2. Lịch giao hàng', '## Appendix 2. Delivery Schedule').replace('1. Giao hàng hằng tháng.', '1. Monthly delivery.');
  for (const [lang, extra] of [['vi', {}], ['bilingual', { markdown_en: en }]]) {
    const r = out(await D.create.execute({ title: `Phụ lục thử ${lang}`, markdown: vi, kind: 'hop-dong', sign_a: 'ĐẠI DIỆN BÊN A', sign_b: 'ĐẠI DIỆN BÊN B', language: lang, formats: ['docx'], ...extra }, c));
    const m = JSON.parse(r.match(/\[\[artifact:(\{[\s\S]*\})\]\]\s*$/)[1]);
    const meta = S.findDocumentForSession(c.sessionID, m.id);
    const html = fs.readFileSync(path.join(S.outDir(c.sessionID), meta.preview), 'utf8');
    assert.ok(html.indexOf('class="sign"') < html.indexOf('class="annex"'), `${lang}: signature before annexes`);
    assert.equal((html.match(/<section class="annex">/g) ?? []).length, 2, `${lang}: 2 annex pages`);
    const ed = out(await D.edit.execute({ id: m.id, edits: [{ op: 'replace', find: 'Giao hàng hằng tháng.', text: 'Giao hàng hằng quý.', ...(lang === 'bilingual' ? { lang: 'both', find_en: 'Monthly delivery.', text_en: 'Quarterly delivery.' } : {}) }] }, c));
    assert.match(ed, /phiên bản \d+/, ed);
    const m2 = JSON.parse(ed.match(/\[\[artifact:(\{[\s\S]*\})\]\]\s*$/)[1]);
    const meta2 = S.findDocumentForSession(c.sessionID, m2.id);
    assert.ok(S.readMarkdown(meta2).includes(S.ANNEX_MARKER), `${lang}: marker kept by document_edit`);
    const html2 = fs.readFileSync(path.join(S.outDir(c.sessionID), meta2.preview), 'utf8');
    assert.ok(html2.indexOf('class="sign"') < html2.indexOf('hằng quý'), `${lang}: edited annex still after the signature`);
    assert.ok(meta2.files.some((f) => f.format === 'redline'), `${lang}: redline`);
  }
  ok('document_create / document_edit / redline, vi + bilingual: signature table, then each Phụ lục on a new page');
}

console.log('\nAll requested drafting tests passed.', Object.keys(timings).length ? `Timings: ${Object.entries(timings).map(([k, v]) => `${k} ${s(v)}`).join(', ')}` : '');
