// company_lookup / company_verify: MST checksum, CAPTCHA path, reference aggregators (live cross-check, robots), (live check of the official portals through the
// sandbox Chrome, node tools/launch-chrome.mjs, DevTools port $CHROME_PORT=9333), parsing + privacy of text the
// user copied from an official page, field-by-field verification, web_read / web_search routing.
// Live part 1 reads the PUBLIC e-gazette home listing (bocaodientu.dkkd.gov.vn, no CAPTCHA) to take real
// enterprise codes issued today and checks that every one passes the checksum.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const core = await import('../.opencode/lib/company-core.ts');
const co = await import('../.opencode/tools/company.ts');
const src = await import('../.opencode/lib/official-sources.ts');
const ev = await import('../.opencode/lib/evidence.ts');
const S = { sessionID: 'company-test-' + Date.now() };
const RT = { ...S, messageID: 'm1' }; // AI-runtime context → { output, metadata.ui }
const show = (title, s) => console.log(`\n===== ${title}\n${s}`);
const ok = (name) => console.log(`  ✓ ${name}`);

// ---------------------------------------------------------------- 1. checksum
console.log('\n1. MST checksum');
const valid = ['0100109106', '0300588569', '0100112437'];
for (const c of valid) assert.equal(core.checkMst(c).ok, true, c);
ok(`valid 10-digit: ${valid.join(', ')}`);
let r = core.checkMst('0100109107');
assert.equal(r.ok, false); assert.equal(r.reason, 'checksum'); assert.equal(r.expected, '0100109106');
ok('invalid 10-digit 0100109107 → checksum, expected 0100109106');
r = core.checkMst('0100109106-001'); assert.equal(r.ok, true); assert.equal(r.kind, 'branch'); assert.equal(r.branch, '001');
r = core.checkMst('0100109106001'); assert.equal(r.ok, true); assert.equal(r.code, '0100109106-001');
ok('13-digit branch 0100109106-001 / 0100109106001 → branch 001');
assert.equal(core.checkMst('0100109107-001').reason, 'checksum');
assert.equal(core.checkMst('0100109106-000').reason, 'branch_zero');
assert.equal(core.checkMst('001089012345').reason, 'personal_id');
assert.equal(core.checkMst('12345').reason, 'format');
ok('13-digit with bad parent / branch 000 / 12-digit personal ID / garbage rejected');
// every 9-digit prefix has at most one check digit; remainder 0 → unissuable
let unissuable = 0; for (let i = 0; i < 2000; i++) { const p = String(100000000 + i * 4999).slice(0, 9); if (core.mstCheckDigit(p) === null) unissuable++ }
ok(`${unissuable}/2000 random prefixes are unissuable (check digit would be 10)`);

// live: real codes published today on the official e-gazette home page (public listing, no CAPTCHA)
const require = createRequire(new URL('../.opencode/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
try {
  const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${process.env.CHROME_PORT ?? 9333}`, defaultViewport: null });
  const p = await b.newPage();
  await p.goto('https://bocaodientu.dkkd.gov.vn/egazette/Forms/Egazette/DefaultAnnouncements.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const codes = [...new Set([...(await p.evaluate(() => document.body.innerText)).matchAll(/MÃ SỐ DN:\s*(\d{10}(?:-\d{3})?)/g)].map((m) => m[1]))];
  await p.close(); b.disconnect();
  assert.ok(codes.length >= 5, 'e-gazette listing has codes');
  const bad = codes.filter((c) => !core.checkMst(c).ok);
  assert.deepEqual(bad, [], 'every official code passes the checksum');
  ok(`${codes.length} real codes from bocaodientu.dkkd.gov.vn all pass the checksum (e.g. ${codes.slice(0, 4).join(', ')})`);
} catch (e) { if (e instanceof assert.AssertionError) throw e; console.log(`  (skip live e-gazette codes: ${e.message})`) }

// ---------------------------------------------------------------- 2. CAPTCHA path (live gate check)
console.log('\n2. company_lookup – live: official portals first, then aggregators');
// fresh aggregator data for the codes under test (24 h cache otherwise)
const fsx = await import('node:fs');
for (const f of (() => { try { return fsx.readdirSync(`${process.env.XDG_CACHE_HOME}/legalai/company`) } catch { return [] } })()) if (/^agg/.test(f)) fsx.rmSync(`${process.env.XDG_CACHE_HOME}/legalai/company/${f}`);
const AGG = ['doanhnghiep.biz', 'infodoanhnghiep.com'];
let t = Date.now();
const out = await co.lookup.execute({ tax_code: '0100109106' }, RT);
show(`company_lookup 0100109106 – ${((Date.now() - t) / 1000).toFixed(1)}s`, out.output);
assert.match(out.output, /Kiểm tra định dạng MST: HỢP LỆ/);
assert.match(out.output, /Nguồn chính thức yêu cầu mã xác thực – không tra tự động/);
assert.match(out.output, /https:\/\/dichvuthongtin\.dkkd\.gov\.vn\/inf\/default\.aspx/);
assert.match(out.output, /https:\/\/tracuunnt\.gdt\.gov\.vn\/tcnnt\/mstdn\.jsp/);
assert.match(out.output, /Mã số doanh nghiệp: 0100109106/);
const ui = out.metadata.ui;
assert.equal(ui.card.status, 'manual_required', 'official check still manual (backward compatible)'); assert.equal(ui.card.checksum, 'valid');
console.log('  gates:', ui.card.portals.map((x) => `${x.src}=${x.gate}`).join(', '));
assert.ok(ui.card.portals.some((x) => x.gate === 'captcha'), 'at least one official portal detected as CAPTCHA-gated');
ok('official portals first: CAPTCHA detected, manual links + steps kept');

console.log('\n2b. reference aggregators – live, cross-check');
assert.equal(ui.res.code, 'unofficial'); assert.equal(ui.card.basis, 'aggregator'); assert.equal(ui.card.company.origin, 'aggregator');
assert.deepEqual(ui.card.sources.map((s) => s.domain).sort(), AGG, 'both aggregators fetched');
assert.ok(ui.card.sources.every((s) => s.official === false && /^\d{4}-\d\d-\d\dT/.test(s.fetchedAt) && s.url.includes(s.domain)));
assert.match(out.output, /THAM KHẢO TỪ 2 NGUỒN KHÔNG CHÍNH THỨC – ⚠ Nguồn không chính thức \(tổng hợp từ Cổng ĐKDN\) – có thể chậm cập nhật; xác nhận trên cổng chính thức trước khi ký hợp đồng/);
const facts = out.output.split('\n').filter((l) => /^  - /.test(l));
assert.ok(facts.length >= 10 && facts.every((l) => /\[⚠ không chính thức – (infodoanhnghiep\.com|doanhnghiep\.biz)\]$/.test(l)), 'every aggregator fact labelled');
const cc = Object.fromEntries(ui.card.crossCheck.map((c) => [c.field, c]));
for (const f of ['name', 'status', 'address', 'representative', 'regDate']) assert.ok(cc[f], `crossCheck.${f}`);
assert.equal(cc.name.agree, true); assert.equal(cc.status.agree, true); assert.equal(cc.regDate.agree, true);
assert.ok(cc.status.values.length === 2 && cc.name.values.length === 2);
console.log('  cross-check 0100109106:', ui.card.crossCheck.map((c) => `${c.field}=${c.agree ? 'agree' : 'DISAGREE'}`).join(', '));
// disagreement handling: whatever disagrees is flagged, both values shown, left out of the consensus record
const dis = ui.card.crossCheck.filter((c) => !c.agree);
if (dis.length) {
  assert.match(out.output, /⚠ Các nguồn KHÔNG thống nhất về: .* BẮT BUỘC xác nhận trên cổng chính thức/);
  for (const d of dis) { assert.ok(ui.card.company.conflicts.includes(d.field)); assert.equal(ui.card.company[d.field], undefined); for (const v of d.values) assert.ok(out.output.includes(v.v)) }
  ok(`disagreement on ${dis.map((d) => d.field).join(', ')} → both values shown, not concluded, excluded from company record`);
} else ok('sources agree on every field');
const evs0 = ev.loadEvidence(RT.sessionID);
for (const d of AGG) {
  assert.ok(evs0.some((e) => e.source === d && e.meta?.official === false), `evidence under ${d}`);
  assert.ok(evs0.some((e) => e.source === 'warning' && e.text.includes(`Nguồn không chính thức: ${d}`)), `warning for ${d}`);
}
const gr = await (await import('../.opencode/tools/grounding.ts')).check.execute({ answer: `Theo infodoanhnghiep.com và doanhnghiep.biz (nguồn không chính thức): ${cc.name.values[0].v}, MST 0100109106, ngày cấp ${cc.regDate.values[0].v}. Nguồn: ${ui.card.sources[0].url}` }, { sessionID: RT.sessionID });
assert.match(gr, /^ĐỘ TIN CẬY \(tính từ bằng chứng\): (TRUNG BÌNH|THẤP)/, gr.split('\n')[0]);
ok(`evidence recorded per aggregator domain + warning → grounding_check: ${gr.split('\n')[0].split(': ')[1]}`);
// privacy: aggregator pages show phone numbers / e-mails → never in output or evidence
for (const bad of ['02462556789', 'vietteladm@viettel.com.vn', 'Điện thoại', 'EMail']) assert.ok(!out.output.includes(bad) && !evs0.some((e) => e.text.includes(bad)), `no ${bad}`);
ok('privacy: phone / e-mail on aggregator pages dropped (output + evidence)');

const vnm = await co.lookup.execute({ tax_code: '0300588569' }, RT);
show('company_lookup 0300588569 (đối chiếu chéo)', vnm.output.split('\n').filter((l) => /^\||^⚠|^\[|Không lấy/.test(l)).join('\n'));
const vc = Object.fromEntries(vnm.metadata.ui.card.crossCheck.map((c) => [c.field, c]));
assert.equal(vnm.metadata.ui.card.sources.length, 2); assert.equal(vc.name.agree, true); assert.match(vc.name.values[0].v, /SỮA VIỆT NAM/);
assert.equal(vnm.metadata.ui.card.company.status ?? 'conflict', vc.status.agree ? 'active' : 'conflict');
ok(`0300588569: 2 sources, ${vnm.metadata.ui.card.crossCheck.filter((c) => c.agree).length}/${vnm.metadata.ui.card.crossCheck.length} fields agree`);

// robots compliance: the live robots.txt of each aggregator allows exactly the paths the tool opened
{
  const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${process.env.CHROME_PORT ?? 9333}`, defaultViewport: null });
  const p = await b.newPage();
  for (const s of [...ui.card.sources, ...vnm.metadata.ui.card.sources]) {
    const r = await p.goto(`https://${s.domain}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const txt = r.status() < 300 ? await r.text() : '';
    const u = new URL(s.url);
    assert.ok(core.robotsAllows(txt, u.pathname + u.search, 'LegalAI'), `robots allows ${s.url}`);
    await new Promise((x) => setTimeout(x, 3000));
  }
  await p.close(); b.disconnect();
}
assert.equal(core.robotsAllows('User-agent: *\nDisallow: /tim-kiem/', '/tim-kiem/auto/0100109106/'), false);
assert.equal(core.robotsAllows('User-Agent: *\nAllow: /\nDisallow: /Ajax/*', '/Ajax/x'), false);
assert.equal(core.robotsAllows('User-agent: GPTBot\nDisallow: /', '/0100109106-x', 'LegalAI'), true);
ok('robots.txt: live rules allow every opened page; Disallow rules are honoured by the parser');

// unknown but well-formed code: never invents a company
assert.ok(core.checkMst('8999999995').ok);
const unknown = await co.lookup.execute({ tax_code: '8999999995' }, RT);
assert.match(unknown.output, /không tra tự động/); assert.doesNotMatch(unknown.output, /Tên doanh nghiệp:|Người đại diện theo pháp luật \(chỉ/);
assert.match(unknown.output, /KHÔNG có nghĩa là mã đã được cấp/); assert.equal(unknown.metadata.ui.res.code, 'manual_required');
assert.ok(unknown.metadata.ui.card.skipped.every((m) => m.reason === 'not_found'));
ok('unknown code 8999999995 → no aggregator data (not_found), manual, nothing invented');
const inv = await co.lookup.execute({ tax_code: '0100109107' }, RT);
show('company_lookup 0100109107 (checksum sai)', inv.output.split('\n').slice(0, 3).join('\n'));
assert.match(inv.output, /KHÔNG HỢP LỆ – chữ số kiểm tra \(số thứ 10\) phải là 6/); assert.equal(inv.metadata.ui.card.sources, undefined, 'no aggregator lookup for an invalid code');
const pid = await co.lookup.execute({ tax_code: '001089012345' }, RT);
assert.equal(pid.metadata.ui.card.status, 'personal_id'); assert.doesNotMatch(pid.output, /tracuunnt/);
ok('checksum error explained (no aggregator fetch); 12-digit personal ID refused');
const plain = await co.lookup.execute({ tax_code: '0100109106' }, S);
assert.equal(typeof plain, 'string'); ok('direct call returns plain text');

const byName = await co.lookup.execute({ name: 'Công ty cổ phần sữa Việt Nam' }, RT);
show('company_lookup name=…', byName.output.split('\n').filter((l) => /^- .*MST|GỢI Ý|^1\./.test(l)).join('\n'));
assert.match(byName.output, /Tên doanh nghiệp: Công ty cổ phần sữa Việt Nam/);
assert.equal(byName.metadata.ui.card.status, 'manual_required');
assert.ok(byName.metadata.ui.card.candidates?.some((x) => x.code === '0300588569'), 'Vinamilk among name-search candidates');
ok('name search → official manual steps + unofficial MST candidates (company names + codes only)');

// ---------------------------------------------------------------- 3. privacy of user-copied text
console.log('\n3. official_text (user copy of the official page) – parsing + privacy');
const PASTE = [
  'Tên doanh nghiệp bằng tiếng Việt:\tCÔNG TY TNHH THƯƠNG MẠI MẪU ABC',
  'Tên doanh nghiệp viết bằng tiếng nước ngoài:\tABC SAMPLE TRADING COMPANY LIMITED',
  'Tên doanh nghiệp viết tắt:\tABC TRADING CO., LTD',
  'Tình trạng hoạt động:\tTạm ngừng kinh doanh có thời hạn',
  'Mã số doanh nghiệp:\t0100109106',
  'Loại hình pháp lý:\tCông ty trách nhiệm hữu hạn hai thành viên trở lên',
  'Ngày bắt đầu thành lập:\t15/03/2010',
  'Tên người đại diện theo pháp luật:\tNGUYỄN VĂN A (CCCD 001089012345, sinh ngày 01/01/1980)',
  'Số giấy tờ pháp lý của cá nhân:\t001089012345',
  'Ngày sinh:\t01/01/1980',
  'Địa chỉ liên lạc:\tSố 5 ngõ 10 phố X, Hà Nội',
  'Điện thoại:\t0912345678',
  'Email:\tnguyenvana@example.com',
  'Địa chỉ trụ sở chính:',
  'Số 12 Đường Láng, Phường Láng, Thành phố Hà Nội, Việt Nam',
  'Mã ngành\tNgành, nghề kinh doanh\tNgành chính',
  '4610\tĐại lý, môi giới, đấu giá hàng hóa\t',
  '4690\tBán buôn tổng hợp\tX',
].join('\n');
const pl = await co.lookup.execute({ tax_code: '0100109106', official_text: PASTE }, RT);
show('company_lookup + official_text', pl.output);
for (const bad of ['001089012345', '01/01/1980', '0912345678', 'nguyenvana@example.com', 'ngõ 10']) assert.ok(!pl.output.includes(bad), `output must not contain ${bad}`);
assert.match(pl.output, /Người đại diện theo pháp luật \(chỉ họ tên\): NGUYỄN VĂN A\n/);
assert.match(pl.output, /Ngành nghề chính: 4690 – Bán buôn tổng hợp/);
assert.match(pl.output, /Tình trạng: Tạm ngừng kinh doanh có thời hạn → RỦI RO/);
assert.equal(pl.metadata.ui.card.company.status, 'temporarily_suspended'); assert.equal(pl.metadata.ui.res.code, 'co_temporarily_suspended');
assert.equal(pl.metadata.ui.card.company.regDate, '2010-03-15');
const evs = ev.loadEvidence(S.sessionID);
const paste = evs.filter((e) => e.source === 'artifact');
assert.ok(paste.length && paste.every((e) => !/001089012345|0912345678|01\/01\/1980|example\.com/.test(e.text)), 'evidence holds company data only');
assert.ok(evs.some((e) => e.source === 'warning' && /CHƯA được (công cụ )?xác minh/.test(e.text)), 'CAPTCHA gate recorded as warning');
ok('ID number, date of birth, personal address, phone, e-mail dropped (output + evidence); status → code');
const gdtTable = 'STT\tMST\tTên người nộp thuế\tCơ quan thuế\tSố CMT/Thẻ căn cước người đại diện\tNgày thay đổi thông tin gần nhất\tGhi chú\n1\t0100109106\tCÔNG TY TNHH THƯƠNG MẠI MẪU ABC\tThuế Thành phố Hà Nội\t001089012345\t01/07/2025\tNNT không hoạt động tại địa chỉ đã đăng ký';
const g2 = core.parseOfficialText(gdtTable);
assert.equal(g2.statusCode, 'not_at_address'); assert.equal(g2.taxAuthority, 'Thuế Thành phố Hà Nội'); assert.ok(!JSON.stringify(g2).includes('001089012345'));
ok('tracuunnt result table: ID-number column skipped, status "không hoạt động tại địa chỉ" → not_at_address');

// ---------------------------------------------------------------- 4. company_verify
console.log('\n4. company_verify');
const v1 = await co.verify.execute({ tax_code: '0100109106', expected_name: 'Cty TNHH TM Mẫu ABC', expected_address: 'Số 12 Đường Láng, P. Láng, TP. Hà Nội', expected_representative: 'Ông Nguyen Van A', official_text: PASTE }, RT);
show('company_verify (khớp tên/địa chỉ/người ĐD, tình trạng tạm ngừng)', v1.output);
const f = Object.fromEntries(v1.metadata.ui.card.fields.map((x) => [x.field, x.result]));
assert.deepEqual(f, { tax_code: 'match', name: 'match', address: 'match', representative: 'match', status: 'mismatch' });
assert.match(v1.output, /RỦI RO: đang tạm ngừng kinh doanh/);
const v2 = await co.verify.execute({ tax_code: '0100109106', expected_name: 'Công ty Cổ phần Mẫu ABC', expected_address: 'Số 99 Phố Huế, Hà Nội', expected_representative: 'Trần Thị B', official_text: PASTE.replace('Tạm ngừng kinh doanh có thời hạn', 'Đang hoạt động') }, RT);
show('company_verify (không khớp)', v2.output.split('\n').filter((l) => /^\||KHÔNG KHỚP|RỦI RO/.test(l)).join('\n'));
const f2 = Object.fromEntries(v2.metadata.ui.card.fields.map((x) => [x.field, x.result]));
assert.equal(f2.name, 'mismatch'); assert.equal(f2.address, 'mismatch'); assert.equal(f2.representative, 'mismatch'); assert.equal(f2.status, 'match');
assert.match(v2.output, /LOẠI HÌNH khác \(công ty cổ phần ≠ công ty TNHH\)/); assert.match(v2.output, /giấy ủy quyền/);
assert.equal(v2.metadata.ui.res.code, 'verify_mismatch');
ok('mismatch per field (legal form, address, representative) presented as risks');
const v3 = await co.verify.execute({ tax_code: '0100109107', expected_name: 'ABC' }, RT);
assert.equal(v3.metadata.ui.card.status, 'manual_required'); assert.match(v3.output, /MST ghi trong hợp đồng không hợp lệ/); assert.match(v3.output, /không ghi loại hình/);
assert.equal(v3.metadata.ui.card.basis, undefined, 'invalid code: no aggregator comparison');
ok('invalid MST: checksum risk + missing legal form, no aggregator lookup');

// without official_text: compared with the unofficial aggregators, clearly marked
const v5 = await co.verify.execute({ tax_code: '0300588569', expected_name: 'Công ty CP Sữa Việt Nam', expected_representative: 'Bà Mai Kiều Liên', expected_address: '10 Tân Trào, P. Tân Phú, Q.7, TP.HCM' }, RT);
show('company_verify 0300588569 (nguồn không chính thức)', v5.output.split('\n').filter((l) => /^\||ĐỐI CHIẾU VỚI|^- |KHÔNG thống/.test(l)).join('\n'));
const c5 = v5.metadata.ui.card;
assert.equal(c5.basis, 'aggregator'); assert.equal(c5.status, 'manual_required'); assert.equal(c5.sources.length, 2); assert.ok(Array.isArray(c5.crossCheck));
assert.match(v5.metadata.ui.res.code, /^unofficial_(match|partial|mismatch)$/);
assert.match(v5.output, /ĐỐI CHIẾU VỚI NGUỒN KHÔNG CHÍNH THỨC – ⚠ Nguồn không chính thức/); assert.match(v5.output, /Theo nguồn KHÔNG chính thức \(/);
const f5 = Object.fromEntries(c5.fields.map((x) => [x.field, x.result]));
assert.equal(f5.name, 'match'); assert.equal(f5.representative, 'match'); assert.ok(['match', 'partial'].includes(f5.address), 'address matches ≥ 1 source');
assert.match(v5.output, /tracuunnt\.gdt\.gov\.vn\/tcnnt\/mstdn\.jsp/);
ok(`verify vs aggregators: name/representative match, address ${f5.address}, marked "đối chiếu với nguồn không chính thức"`);
const v6 = await co.verify.execute({ tax_code: '0100109106', expected_representative: 'Tào Đức Thắng', expected_name: 'Công ty TNHH ABC' }, RT);
const f6 = Object.fromEntries(v6.metadata.ui.card.fields.map((x) => [x.field, x]));
show('company_verify 0100109106 (nguồn lệch nhau)', v6.output.split('\n').filter((l) => /^\||^- /.test(l)).join('\n'));
assert.equal(f6.name.result, 'mismatch');
const repAgree = v6.metadata.ui.card.crossCheck.find((c) => c.field === 'representative')?.agree;
assert.equal(f6.representative.result, repAgree ? 'match' : 'partial', 'disagreeing sources → partial, not a verdict');
ok(`sources disagree on the representative → ${f6.representative.result}; wrong name → mismatch`);
const v4 = await co.verify.execute({ tax_code: '0100109106-002', expected_name: 'Chi nhánh Công ty TNHH ABC tại Đà Nẵng' }, RT);
assert.match(v4.output, /không có tư cách pháp nhân/);
ok('branch code: legal-personality warning');

// ---------------------------------------------------------------- 5. routing
console.log('\n5. web_read / web_search routing');
for (const [u, code] of [['https://masothue.com/0100109106-tap-doan-cong-nghiep-vien-thong-quan-doi', '0100109106'], ['https://doanhnghiep.biz/0300588569-cong-ty-co-phan-sua-viet-nam', '0300588569'], ['https://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp?mst=0100109106', '0100109106'], ['https://dichvuthongtin.dkkd.gov.vn/inf/default.aspx?search=0100109106&h=AD64', '0100109106']]) {
  const rt = src.routeOf(u); assert.equal(rt?.tool, 'company_lookup', u); assert.deepEqual(rt.args(new URL(u)), { tax_code: code });
}
assert.equal(src.routeOf('https://infodoanhnghiep.com/thong-tin/Cong-Ty-Co-Phan-Sua-Viet-Nam-88569.html'), null, 'aggregator page without MST → read normally (flagged)');
assert.equal(src.routeOf('https://dangkykinhdoanh.gov.vn/vn/tin-tuc/597/4031/thong-bao.aspx'), null, 'portal news pages are read normally');
assert.equal(src.officialOf('masothue.com'), null, 'aggregators are NOT official');
assert.equal(src.officialOf('dichvuthongtin.dkkd.gov.vn')?.domain, 'dkkd.gov.vn');
assert.equal(src.excludedSource, undefined, 'hard exclusion removed');
const web = await import('../.opencode/tools/web.ts');
const wr = await web.read.execute({ url: 'https://doanhnghiep.biz/0300588569-cong-ty-co-phan-sua-viet-nam' }, S);
assert.match(wr, /^\(web_read → company_lookup/); assert.match(wr, /NGUỒN KHÔNG CHÍNH THỨC/);
const wr2 = await web.read.execute({ url: 'https://infodoanhnghiep.com/thong-tin/Cong-Ty-Co-Phan-Sua-Viet-Nam-88569.html' }, S);
assert.match(wr2, /⚠ NGUỒN KHÔNG CHÍNH THỨC/); assert.doesNotMatch(wr2, /^\(web_read → company_lookup/);
ok('aggregator MST pages → company_lookup; other aggregator pages read and flagged "không chính thức"');

console.log('\nALL PASSED');
