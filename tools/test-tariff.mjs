// Live test for .opencode/tools/tariff.ts (tariff_vn / tariff_us / tariff_eu / tariff_search) against the sandbox
// Chrome (start it first: node tools/launch-chrome.mjs, or any `bash run.sh …`). First run downloads the decree
// annexes from vbpl.vn (1–3 minutes); later runs use .sandbox/cache/legalai/tariff/.
// Usage: node tools/test-tariff.mjs
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const t = await import('../.opencode/tools/tariff.ts');
const web = await import('../.opencode/tools/web.ts');
const grounding = await import('../.opencode/tools/grounding.ts');
const year = Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date()));
const ctx = { sessionID: `test-tariff-${Date.now()}` };
let failed = 0;
const time = async (label, f, expect = [], max = 2200) => {
  const s = Date.now();
  try {
    const r = String(await f());
    const miss = expect.filter((e) => !(e instanceof RegExp ? e.test(r) : r.includes(e)));
    if (miss.length) { failed++; process.exitCode = 1; }
    console.log(`\n=== ${label} (${((Date.now() - s) / 1000).toFixed(1)}s, ${r.length} ký tự)${miss.length ? `  ✗ THIẾU: ${miss.join(' | ')}` : '  ✓'}\n${r.slice(0, max)}`);
    return r;
  } catch (e) { failed++; process.exitCode = 1; console.log(`\n=== ${label} LỖI (${((Date.now() - s) / 1000).toFixed(1)}s): ${e?.stack ?? e}`); return ''; }
};

// ---------- Viet Nam
await time(`tariff_vn 7208.39 MFN + ATIGA + EVFTA + CPTPP năm ${year}`, () => t.vn.execute({ hs: '7208.39', year, fta: 'EVFTA,ATIGA,CPTPP' }, ctx),
  ['7208.39.90', '26/2023/NĐ-CP', '116/2022/NĐ-CP', '126/2022/NĐ-CP', '115/2022/NĐ-CP', `năm ${year}`, 'Mê-hi-cô', 'customs.gov.vn', 'Ngày tra cứu', 'hiệu lực'], 4500);
await time('tariff_vn 0306.17.19 nhập khẩu (EVFTA lộ trình: 2022 = 2,5 → năm hiện tại)', () => t.vn.execute({ hs: '0306.17.19', year, fta: 'EVFTA,RCEP' }, ctx),
  ['12%', '2,5', /Thuế suất EVFTA \(%\) \d{4}/, 'RCEP', '9804.17.19'], 3500);
await time('tariff_vn 0306.17.19 xuất khẩu', () => t.vn.execute({ hs: '03061719', kind: 'export' }, ctx), ['XUẤT KHẨU', 'Xuất khẩu', '26/2023/NĐ-CP', 'Phụ lục I'], 1500);
await time('tariff_vn năm cũ 2023 (cột 2023 của Phụ lục EVFTA)', () => t.vn.execute({ hs: '0306.17.19', year: 2023, fta: 'EVFTA', check_amendments: false }, ctx), ['năm 2023', /EVFTA \(%\) 2023"\)/], 1200);
await time('tariff_vn tiền tố 4 số 7208 (liệt kê mã con)', () => t.vn.execute({ hs: '7208' }, ctx), ['mã 8 số thuộc 7208', '7208.10.00', 'MFN'], 1200);
await time('tariff_vn mã sai 9999.99.99', () => t.vn.execute({ hs: '9999.99.99' }, ctx), ['Không tìm thấy mã HS'], 400);
await time('tariff_vn mã quá ngắn "72"', () => t.vn.execute({ hs: '72' }, ctx), ['quá ngắn'], 300);
await time('tariff_vn không phải mã "thép"', () => t.vn.execute({ hs: 'thép cán nóng' }, ctx), ['không phải mã HS'], 300);

// ---------- United States
await time('tariff_us 7210.49 (VN)', () => t.us.execute({ hs: '7210.49' }, ctx), ['7210.49.00', 'General', 'Free', 'HTS Revision', 'Vietnam', 'trav_measures'], 2500);
await time('tariff_us 0306.17 (VN)', () => t.us.execute({ hs: '0306.17' }, ctx), ['0306.17.00', 'Free', 'Chương 99'], 1500);
await time('tariff_us 10 số 0306.17.00.41', () => t.us.execute({ hs: '0306.17.00.41' }, ctx), ['0306.17.00.41', 'General = Free'], 900);

// ---------- European Union
await time('tariff_eu 0306.17 xuất xứ VN (EVFTA)', () => t.eu.execute({ hs: '0306.17', origin: 'VN' }, ctx), ['Third country duty', '12.00 %', 'Tariff preference', '[Viet Nam]', 'CELEX 32020D0753'], 2500);
await time('tariff_eu 7208.39 xuất xứ VN (chống bán phá giá)', () => t.eu.execute({ hs: '720839' }, ctx), ['anti-dumping', 'CELEX 32025R1919'], 1500);
await time('tariff_eu mã sai 9999', () => t.eu.execute({ hs: '9999' }, ctx), ['Không tìm thấy'], 300);

// ---------- search
await time('tariff_search vn "tôm thẻ chân trắng đông lạnh"', () => t.search.execute({ query: 'tôm thẻ chân trắng đông lạnh', market: 'vn', limit: 5 }, ctx), ['0306.17.2', 'GỢI Ý'], 1500);
await time('tariff_search us "frozen shrimp"', () => t.search.execute({ query: 'frozen shrimp', market: 'us', limit: 5 }, ctx), ['0306.'], 900);
await time('tariff_search eu "hot-rolled steel coil"', () => t.search.execute({ query: 'hot-rolled steel coil', market: 'eu', limit: 5 }, ctx), ['7208'], 900);

// ---------- web_read delegation (official-sources.ts routes)
await time('web_read → tariff_vn (customs.gov.vn)', () => web.read.execute({ url: 'https://www.customs.gov.vn/index.jsp?pageId=24&Id=72083990&cid=1201' }, ctx), ['web_read → tariff_vn', '7208.39.90'], 500);
await time('web_read → tariff_us (hts.usitc.gov)', () => web.read.execute({ url: 'https://hts.usitc.gov/search?query=7210.49' }, ctx), ['web_read → tariff_us', '7210.49.00'], 400);
await time('web_read → tariff_eu (TARIC)', () => web.read.execute({ url: 'https://ec.europa.eu/taxation_customs/dds2/taric/measures.jsp?Lang=en&Taric=0306179290&Area=VN' }, ctx), ['web_read → tariff_eu', 'Tariff preference'], 400);

// ---------- grounding: figures / ids / links of a tariff answer are verifiable
const answer = [
  `Thuế nhập khẩu ưu đãi (MFN) mã 0306.17.19: 12% (Nghị định 26/2023/NĐ-CP); EVFTA năm ${year}: 0% theo Phụ lục Nghị định 116/2022/NĐ-CP.`,
  'Nguồn: https://www.customs.gov.vn/index.jsp?pageId=24&Id=03061719&cid=1201',
  'EU: Third country duty 12% (CELEX 32011R1006), ưu đãi EVFTA 0% (CELEX 32020D0753) – https://trade.ec.europa.eu/access-to-markets/en/results?product=0306179290&origin=VN&destination=FR',
  'Hoa Kỳ: 7210.49.00 General Free, Column 2 21.5% – https://hts.usitc.gov/search?query=7210.49',
].join('\n');
await time('grounding_check trên câu trả lời mẫu', () => grounding.check.execute({ answer }, ctx), ['ĐỘ TIN CẬY', /CAO|TRUNG BÌNH/], 1500);

console.log(`\n${failed ? `✗ ${failed} mục chưa đạt` : '✓ tất cả mục đạt'}`);
