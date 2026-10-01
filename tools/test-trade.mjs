// Smoke test for .opencode/tools/trav.ts and fedreg.ts against the sandbox Chrome (start it first: node tools/launch-chrome.mjs).
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const trav = await import('../.opencode/tools/trav.ts');
const fed = await import('../.opencode/tools/fedreg.ts');
const time = async (label, f, max = 1800) => {
  const s = Date.now();
  try { const r = await f(); console.log(`\n=== ${label} (${((Date.now() - s) / 1000).toFixed(1)}s, ${String(r).length} ký tự)\n${String(r).slice(0, max)}`); return r; }
  catch (e) { console.log(`\n=== ${label} LỖI (${((Date.now() - s) / 1000).toFixed(1)}s): ${e?.message ?? e}`); process.exitCode = 1; }
};
const found = await time('trav_search', () => trav.search.execute({ query: 'thép mạ kẽm', limit: 5 }, {}));
await time('trav_search HS', () => trav.search.execute({ query: '7210', limit: 3 }, {}), 900);
await time('trav_search market', () => trav.search.execute({ query: 'thép', market: 'Hoa Kỳ', category: 'foreign', limit: 4 }, {}), 1200);
await time('trav_measures', () => trav.measures.execute({ product: 'galvanised', market: 'Úc' }, {}));
await time('trav_measures HS+company', () => trav.measures.execute({ hs: '7210', market: 'Hoa Kỳ', company: 'Hoa Sen', limit: 3 }, {}), 1200);
const link = String(found ?? '').match(/https:\/\/trav\.gov\.vn\/\S+id=[\w-]+/)?.[0] ?? 'https://trav.gov.vn/default.aspx?page=news-detail&do=detail&id=9379fa59-1bbe-40f9-a7cc-ba916628ee8b';
await time('trav_page', () => trav.page.execute({ url: link, max_chars: 600 }, {}));
await time('fedreg_search', () => fed.search.execute({ query: 'galvanized steel antidumping', limit: 4 }, {}));
await time('fedreg_search ITA+dates', () => fed.search.execute({ query: 'corrosion-resistant steel', agency: 'ITA', date_from: '2025-01-01', order: 'newest', limit: 4 }, {}));
await time('fedreg_document', () => fed.document.execute({ id: '2026-19102', focus: 'Hoa Phat', max_chars: 2500 }, {}), 3500);
await time('fedreg_document USITC', () => fed.document.execute({ id: 'https://www.federalregister.gov/documents/2025/12/02/2025-21761/x', max_chars: 1200 }, {}), 2500);
