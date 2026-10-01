// web_search / web_read live through the sandbox Chrome (node tools/launch-chrome.mjs, port $CHROME_PORT=9333):
// official-domain search for real questions, page / PDF reading with evidence, non-official warning,
// blocked / internal addresses refused. Prints what was found; asserts the shape (live results change).
import assert from 'node:assert/strict';
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const w = await import('../.opencode/tools/web.ts');
const g = await import('../.opencode/tools/grounding.ts');
const ev = await import('../.opencode/lib/evidence.ts');
const S = { sessionID: 'web-test-' + Date.now() };
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1) + 's';
const show = (title, s, n = 14) => console.log(`\n===== ${title}\n${s.split('\n').slice(0, n).join('\n')}`);

let t = Date.now();
const s1 = await w.search.execute({ query: 'nghị định hóa đơn điện tử 2025' }, S);
show(`web_search "nghị định hóa đơn điện tử 2025" – ${secs(t)}`, s1);
assert.match(s1, /^Kết quả tìm kiếm "nghị định hóa đơn điện tử 2025" \((DuckDuckGo|DuckDuckGo Lite|Bing); lọc: gov\.vn/);
const off1 = [...s1.matchAll(/\[CHÍNH THỨC – [^\]]+\][^\n]*\n\s+(https?:\/\/\S+)/g)].map((m) => m[1]);
assert.ok(off1.length >= 3, 'at least 3 official results');
assert.ok(off1.some((u) => /chinhphu\.vn|gov\.vn|vbpl\.vn/.test(u)));

t = Date.now();
const s2 = await w.search.execute({ query: 'thuế nhập khẩu MFN thép cán nóng 7208' }, S);
show(`web_search "thuế nhập khẩu MFN thép cán nóng 7208" – ${secs(t)}`, s2);
assert.ok([...s2.matchAll(/\[CHÍNH THỨC – /g)].length >= 3, s2);

t = Date.now();
const s3 = await w.search.execute({ query: 'Vietnam hot-rolled steel anti-dumping', lang: 'en' }, S);
show(`web_search (en) "Vietnam hot-rolled steel anti-dumping" – ${secs(t)}`, s3, 8);
assert.match(s3, /lọc: wto\.org, federalregister\.gov/);

// read an official article page (evidence = full text, source = domain)
const article = off1.find((u) => /xaydungchinhsach\.chinhphu\.vn/.test(u)) ?? off1.find((u) => /baochinhphu\.vn|chinhphu\.vn\/.*\.htm/.test(u)) ?? off1[0];
t = Date.now();
const r1 = await w.read.execute({ url: article, focus: 'hiệu lực' }, S);
show(`web_read ${article} – ${secs(t)}`, r1, 16);
assert.match(r1, /NGUỒN CHÍNH THỨC/); assert.match(r1, /--- NỘI DUNG/);
const e1 = ev.loadEvidence(S.sessionID).find((e) => e.url === article || e.meta?.alt_urls?.includes(article));
assert.ok(e1 && e1.text.length > 1000 && e1.source.endsWith('chinhphu.vn'), 'full text recorded as evidence');
assert.ok(ev.loadEvidence(S.sessionID).some((e) => e.source === 'web_search'), 'search listing recorded as web_search (listed only)');

// a quote from what was read passes grounding; the search listing alone would not count
const sentence = e1.text.split('\n').map((l) => l.trim()).find((l) => l.length > 60 && l.length < 300 && /Nghị định/.test(l)) ?? e1.text.slice(0, 120);
const gr = await g.check.execute({ answer: `Theo trang Chính phủ: "${sentence}". Nguồn: ${e1.url}` }, S);
show('grounding_check on a quote from the page read', gr, 6);
assert.doesNotMatch(gr, /KHÔNG có nguyên văn/);

// a non-official page: allowed, but warned and recorded as a warning (caps confidence)
t = Date.now();
const r2 = await w.read.execute({ url: 'https://vi.wikipedia.org/wiki/H%C3%B3a_%C4%91%C6%A1n_%C4%91i%E1%BB%87n_t%E1%BB%AD', focus: 'hóa đơn' }, S);
show(`web_read (non-official) vi.wikipedia.org – ${secs(t)}`, r2, 6);
assert.match(r2, /⚠ NGUỒN KHÔNG CHÍNH THỨC|Không đọc được|BỊ CHẶN/);
if (/⚠ NGUỒN KHÔNG CHÍNH THỨC/.test(r2)) assert.ok(ev.loadEvidence(S.sessionID).some((e) => e.source === 'warning' && /Nguồn không chính thức: vi\.wikipedia\.org/.test(e.text)));

// internal addresses are refused
assert.match(await w.read.execute({ url: 'http://127.0.0.1:9333/json/version' }, S), /^Lỗi: không mở địa chỉ nội bộ/);

// 1. routing: domains with a dedicated tool are delegated (same parsing + evidence), or the tool is named
t = Date.now();
const rv = await w.read.execute({ url: 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117', focus: 'Điều 301' }, S);
show(`web_read vbpl.vn (focus "Điều 301") → delegated – ${secs(t)}`, rv, 6);
assert.match(rv, /^\(web_read → vbpl_article:/); assert.match(rv, /không quá 8%/);
assert.ok(ev.loadEvidence(S.sessionID).some((e) => e.source === 'vbpl.vn' && /26117/.test(e.url)), 'evidence recorded by vbpl_article');
assert.match(await w.read.execute({ url: 'http://canhbaosom.trav.gov.vn/' }, S), /công cụ chuyên dụng – dùng trav_measures/);
const o = await import('../.opencode/lib/official-sources.ts');
for (const [u, tool] of [
  ['https://anle.toaan.gov.vn/webcenter/portal/anle/chitietanle?dDocName=TAND123', 'court_anle_document'],
  ['https://congbobanan.toaan.gov.vn/2ta1234567t1cvn/chi-tiet-ban-an', 'court_judgment_document'],
  ['https://trav.gov.vn/default.aspx?page=news-detail&do=detail&id=abc', 'trav_page'],
  ['https://www.federalregister.gov/documents/2025/10/20/2025-19102/x', 'fedreg_document'],
  ['https://www.govinfo.gov/content/pkg/FR-2025-10-20/pdf/2025-19102.pdf', 'fedreg_document'],
  ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32025R1919', 'eurlex_document'],
  ['https://trungtamwto.vn/an-pham/25927-cac-cong-cu-tra-cuu-thue-nhap-khau', 'fta_document'],
  ['https://www.vietcombank.com.vn/vi-VN/KHCN/Cong-cu-Tien-ich/Ty-gia', 'fx_rate'],
  ['https://doanhnghiep.biz/0100109106-tap-doan-cong-nghiep-vien-thong-quan-doi', 'company_lookup'],
  ['https://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp?mst=0100109106', 'company_lookup'],
]) assert.equal(o.routeOf(u)?.tool, tool, u);
assert.equal(o.routeOf('https://xaydungchinhsach.chinhphu.vn/abc.htm'), null);
// MST aggregators are allowed again as REFERENCE sources: not official (web_search flags them), not excluded
assert.equal(o.officialOf('masothue.com'), null); assert.equal(o.officialOf('doanhnghiep.biz'), null); assert.equal(o.excludedSource, undefined);
assert.equal(o.routeOf('https://infodoanhnghiep.com/thong-tin/Cong-Ty-Co-Phan-Sua-Viet-Nam-88569.html'), null, 'aggregator page without MST → read normally, flagged');
assert.match(s2, /→ mở bằng fta_document\(url="https:\/\/trungtamwto\.vn/, 'search results on a routed domain carry the tool hint');
console.log('  ✓ routing: vbpl link → vbpl_article (delegated, evidence recorded); canhbaosom → trav_measures hint; 10 domain routes (incl. company_lookup for MST pages); aggregators flagged, not excluded; search hints');

// 2. shared limiter: ≤ 2 in flight per host, starts ≥ 1 s apart, strictest limits kept across callers
{
  const p = await import('../.opencode/lib/polite.ts');
  let active = 0, peak = 0; const starts = [];
  await Promise.all([...Array(5)].map(() => p.polite('limiter-test.example', async () => { starts.push(Date.now()); peak = Math.max(peak, ++active); await new Promise((r) => setTimeout(r, 1500)); active-- }, { concurrency: 2, gapMs: 1000 })));
  starts.sort((a, b) => a - b);
  assert.ok(peak <= 2, `peak ${peak}`); assert.ok(starts.slice(1).every((s, i) => s - starts[i] >= 990), JSON.stringify(starts.map((s) => s - starts[0])));
  await p.throttle('limiter-test.example', { gapMs: 1100 });
  assert.deepEqual({ ...p.limitsOf('limiter-test.example'), active: 0 }, { concurrency: 2, gapMs: 1100, active: 0 });
  console.log(`  ✓ limiter: 5 requests → peak ${peak} in flight, starts ${starts.map((s) => s - starts[0]).join('/')} ms`);
}

// 3. one source per document in grounding (FR html vs govinfo copy, CELEX URL forms, vbpl slug vs id)
{
  const S3 = { sessionID: 'web-canon-' + Date.now() };
  ev.recordEvidence(S3.sessionID, { url: 'https://www.federalregister.gov/documents/2025/10/20/2025-19102/certain-steel', title: 'FR', text: 'FR Doc. 2025-19102 antidumping duty 12.5 percent', source: 'fedreg' });
  ev.recordEvidence(S3.sessionID, { url: 'https://www.govinfo.gov/content/pkg/FR-2025-10-20/html/2025-19102.htm', title: 'FR govinfo', text: 'FR Doc. 2025-19102 antidumping duty 12.5 percent', source: 'fedreg' });
  const r3 = await g.check.execute({ answer: 'Mức thuế 12,5% theo FR Doc 2025-19102. Nguồn: https://www.govinfo.gov/content/pkg/FR-2025-10-20/pdf/2025-19102.pdf và https://www.federalregister.gov/d/2025-19102' }, S3);
  assert.match(r3, /với 1 nguồn đã tra/); assert.doesNotMatch(r3, /Link chưa được mở/);
  assert.equal(o.canonicalKey('https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai--26117'), o.canonicalKey('https://vbpl.vn/TW/Pages/vbpq-toanvan.aspx?ItemID=26117'));
  assert.equal(o.canonicalKey('https://congbobanan.toaan.gov.vn/2ta99t1cvn/chi-tiet-ban-an'), o.canonicalKey('https://congbobanan.toaan.gov.vn/5ta99t1cvn/ban-an.pdf'));
  assert.equal(o.canonicalKey('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32025R1919'), 'celex:32025R1919');
  console.log('  ✓ canonical keys: FR html / govinfo pdf / federalregister.gov/d = one source; vbpl slug = ItemID; congbobanan 2ta = 5ta; CELEX');
}

// 4. non-official results about a legal document point to vbpl_find with the document number
t = Date.now();
const s4 = await w.search.execute({ query: 'Nghị định 70/2025/NĐ-CP hóa đơn chứng từ', sites: ['thuvienphapluat.vn', 'luatvietnam.vn'] }, S);
show(`web_search on non-official sites – ${secs(t)}`, s4, 10);
if (/⚠ KHÔNG CHÍNH THỨC/.test(s4)) assert.match(s4, /→ văn bản gốc chính thức: vbpl_find\("70\/2025\/NĐ-CP"\)/);
assert.deepEqual(o.docNumbersIn('Nghị định 70/2025/NĐ-CP sửa đổi Nghị định 123/2020/NĐ-CP'), ['70/2025/NĐ-CP', '123/2020/NĐ-CP']);
console.log('  ✓ non-official legal-document results → vbpl_find("<số hiệu>") hint');
console.log('\nALL PASSED');
