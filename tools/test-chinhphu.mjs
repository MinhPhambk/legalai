// Smoke test for .opencode/tools/chinhphu.ts against the sandbox Chrome (start it first: node tools/launch-chrome.mjs).
// The attachments are signed scans, so this also exercises the OCR Chrome (Linux: needs the Xvfb display, DISPLAY=:99).
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const t = await import('../.opencode/tools/chinhphu.ts');
const time = async (label, f) => { const s = Date.now(); const r = await f(); console.log(`\n=== ${label} (${((Date.now() - s) / 1000).toFixed(1)}s)\n${String(r).slice(0, 1500)}`); return r; };
const found = await time('search', () => t.search.execute({ query: 'Luật Thương mại điện tử', limit: 5 }, {}));
await time('search number', () => t.search.execute({ query: '122/2025/QH15', limit: 3 }, {}));
await time('search year', () => t.search.execute({ query: 'thương mại điện tử', year: 2026, limit: 3 }, {}));
const url = 'https://vanban.chinhphu.vn/?pageid=27160&docid=216503';
await time('document', () => t.document.execute({ url, max_articles: 6 }, {}));
await time('article', () => t.article.execute({ url, article: 'Điều 3' }, {}));
await time('search_articles', () => t.search_articles.execute({ url, keywords: 'nền tảng thương mại điện tử trung gian', limit: 3 }, {}));
await time('verify ok', () => t.verify.execute({ url, quote: 'Hoạt động thương mại điện tử là hoạt động thương mại được tiến hành một phần hoặc toàn bộ trên môi trường điện tử' }, {}));
await time('verify bad', () => t.verify.execute({ url, quote: 'Hoạt động thương mại điện tử là hoạt động mua bán chỉ trên mạng xã hội' }, {}));
await time('bad link', () => t.document.execute({ url: 'https://vbpl.vn/van-ban/chi-tiet/abc' }, {}).catch((e) => 'Lỗi (mong đợi): ' + e.message));
