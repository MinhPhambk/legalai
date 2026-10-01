// Smoke test for .opencode/tools/vbpl.ts against the sandbox Chrome (start it first: node tools/launch-chrome.mjs).
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const t = await import('../.opencode/tools/vbpl.ts');
const time = async (label, f) => { const s = Date.now(); const r = await f(); console.log(`\n=== ${label} (${((Date.now() - s) / 1000).toFixed(1)}s)\n${String(r).slice(0, 1800)}`); return r; };
const found = await time('find', () => t.find.execute({ query: 'Luật Thương mại 2005' }, {}));
await time('find number', () => t.find.execute({ query: '36/2005/QH11', limit: 3 }, {}));
const url = 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117';
await time('document', () => t.document.execute({ url, max_articles: 5 }, {}));
await time('article', () => t.article.execute({ url, article: 'Điều 301' }, {}));
await time('verify ok', () => t.verify.execute({ url, quote: 'nhưng không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm' }, {}));
await time('verify bad', () => t.verify.execute({ url, quote: 'nhưng không quá 12% giá trị hợp đồng' }, {}));
await time('history', () => t.history.execute({ url, max_items: 4 }, {}));
await time('search_articles', () => t.search_articles.execute({ url, keywords: 'phạt vi phạm', limit: 4 }, {}));
