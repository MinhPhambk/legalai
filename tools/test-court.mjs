// Smoke test for .opencode/tools/court.ts against the sandbox Chrome (start it first: node tools/launch-chrome.mjs).
// The first run builds the án lệ content index (~1–3 min at ≤1 request/s); later runs use the cache.
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const court = await import('../.opencode/tools/court.ts');
const ctx = { sessionID: 'smoke-test' };
const time = async (label, f, max = 1800) => {
  const s = Date.now();
  try { const r = await f(); console.log(`\n=== ${label} (${((Date.now() - s) / 1000).toFixed(1)}s, ${String(r).length} ký tự)\n${String(r).slice(0, max)}`); return r; }
  catch (e) { console.log(`\n=== ${label} LỖI (${((Date.now() - s) / 1000).toFixed(1)}s): ${e?.message ?? e}`); process.exitCode = 1; }
};
await time('anle_search phạt vi phạm', () => court.anle_search.execute({ query: 'phạt vi phạm' }, ctx));
await time('anle_search trọng tài', () => court.anle_search.execute({ query: 'trọng tài', limit: 5 }, ctx), 1200);
await time('anle_search KDTM', () => court.anle_search.execute({ field: 'Kinh doanh thương mại', limit: 15 }, ctx), 1500);
await time('anle_document 09/2016 (HTML)', () => court.anle_document.execute({ ref: '09/2016/AL' }, ctx), 3000);
await time('anle_document 36/2020 (PDF có chữ)', () => court.anle_document.execute({ ref: 'Án lệ số 36/2020/AL' }, ctx), 1500);
await time('anle_document 90/2026 (PDF scan)', () => court.anle_document.execute({ ref: '90/2026' }, ctx), 900);
const found = await time('judgment_search từ khóa', () => court.judgment_search.execute({ keyword: 'phạt vi phạm', case_type: 'Kinh doanh thương mại' }, ctx), 1500);
await time('judgment_search bộ lọc', () => court.judgment_search.execute({ case_type: 'Kinh doanh thương mại', relation: 'mua bán hàng hóa', level: 'phúc thẩm', date_from: '2024-01-01', date_to: '2025-12-31', limit: 4 }, ctx), 1500);
await time('judgment_search GĐT dân sự', () => court.judgment_search.execute({ case_type: 'Dân sự', level: 'giám đốc thẩm', keyword: 'đặt cọc', limit: 3 }, ctx), 1200);
const link = String(found ?? '').match(/https:\/\/congbobanan\.toaan\.gov\.vn\/2ta\d+t1cvn\/chi-tiet-ban-an/)?.[0] ?? 'https://congbobanan.toaan.gov.vn/2ta1668839t1cvn/chi-tiet-ban-an';
await time('judgment_document', () => court.judgment_document.execute({ url: link, focus: 'phạt vi phạm', max_chars: 3000 }, ctx), 4000);
await time('judgment_document sơ thẩm', () => court.judgment_document.execute({ url: 'https://congbobanan.toaan.gov.vn/2ta239166t1cvn/chi-tiet-ban-an' }, ctx), 1500);
process.exit();
