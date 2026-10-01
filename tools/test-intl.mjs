// Smoke test for .opencode/tools/eurlex.ts, eping.ts and fta.ts against the sandbox Chrome (start it first: node tools/launch-chrome.mjs).
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const eu = await import('../.opencode/tools/eurlex.ts');
const ep = await import('../.opencode/tools/eping.ts');
const fta = await import('../.opencode/tools/fta.ts');
const ctx = { sessionID: 'smoke-test' };
const time = async (label, f, max = 1800) => {
  const s = Date.now();
  try { const r = await f(); console.log(`\n=== ${label} (${((Date.now() - s) / 1000).toFixed(1)}s, ${String(r).length} ký tự)\n${String(r).slice(0, max)}`); return r; }
  catch (e) { console.log(`\n=== ${label} LỖI (${((Date.now() - s) / 1000).toFixed(1)}s): ${e?.message ?? e}`); process.exitCode = 1; }
};
// EU – EUR-Lex / CELLAR
await time('eurlex_search', () => eu.search.execute({ limit: 5 }, ctx), 1500);
const hr = await time('eurlex_search hot-rolled AD', () => eu.search.execute({ query: 'hot-rolled', measure: 'anti-dumping', limit: 3 }, ctx), 1200);
await time('eurlex_search CBAM', () => eu.search.execute({ measure: 'cbam', limit: 3 }, ctx), 1000);
const celex = String(hr ?? '').match(/CELEX (3\d{4}R\d{4})/)?.[1] ?? '32025R1919';
await time(`eurlex_document ${celex}`, () => eu.document.execute({ id: celex, max_chars: 2500 }, ctx), 3200);
await time('eurlex_document notice (OJ C)', () => eu.document.execute({ id: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:52025XC05025', max_chars: 1500 }, ctx), 2200);
await time('eurlex_document not Vietnam (⚠)', () => eu.document.execute({ id: '32023R2180', max_chars: 600 }, ctx), 900);
// WTO ePing – SPS/TBT
await time('eping_search EU TBT', () => ep.search.execute({ member: 'EU', area: 'TBT', limit: 3 }, ctx), 1400);
await time('eping_search shrimp HS 0306 open', () => ep.search.execute({ hs: '0306', open_for_comment: true, limit: 3 }, ctx), 1400);
await time('eping_search affects VN', () => ep.search.execute({ affects_vietnam: true, limit: 3 }, ctx), 1200);
await time('eping_notification', () => ep.notification.execute({ symbol: 'G/SPS/N/MYS/72/Rev.1' }, ctx), 2200);
// FTA – trungtamwto.vn
await time('fta_list', () => fta.list.execute({}, ctx), 1200);
const roo = await time('fta_search EVFTA quy tắc xuất xứ', () => fta.search.execute({ query: 'EVFTA quy tắc xuất xứ', limit: 4 }, ctx), 1600);
await time('fta_search CPTPP thuế', () => fta.search.execute({ query: 'thuế', fta: 'CPTPP', limit: 3 }, ctx), 1200);
const pageUrl = String(roo ?? '').match(/Trang: (https:\/\/trungtamwto\.vn\/chuyen-de\/\S+)/)?.[1] ?? 'https://trungtamwto.vn/chuyen-de/8445-van-kien-hiep-dinh-evfta-evipa-va-cac-tom-tat-tung-chuong';
await time('fta_document page', () => fta.document.execute({ url: pageUrl, focus: 'Nghị định thư 1', max_chars: 800 }, ctx), 1600);
await time('fta_document PDF', () => fta.document.execute({ url: 'https://trungtamwto.vn/download/20194/rcep-chapter-5.pdf', focus: 'equivalence', max_chars: 900 }, ctx), 1400);
