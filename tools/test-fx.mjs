// fx_rate / fx_convert live: State Bank of Vietnam central rate (sbv.gov.vn) and Vietcombank rates through
// the sandbox Chrome (node tools/launch-chrome.mjs, DevTools port $CHROME_PORT=9333). Prints the rates and
// dates found; asserts only the shape (live values change every day).
import assert from 'node:assert/strict';
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const f = await import('../.opencode/tools/fx.ts');
const g = await import('../.opencode/tools/grounding.ts');
const ev = await import('../.opencode/lib/evidence.ts');
const S = { sessionID: 'fx-test-' + Date.now() };
const head = (s) => s.split('\n')[0];
const show = (title, s) => console.log(`\n===== ${title}\n${s.split('\n').filter((l) => !/^Tỷ giá tham khảo do nguồn/.test(l)).join('\n')}`);

let t = Date.now();
const usd = await f.rate.execute({ currency: 'USD' }, S);
show(`fx_rate USD (hôm nay) – ${((Date.now() - t) / 1000).toFixed(1)}s`, usd);
assert.match(head(usd), /^TỶ GIÁ USD\/VND \(tham khảo, ngày \d\d\/\d\d\/\d{4}\): NHNN tỷ giá trung tâm [\d.]+ VND\/USD \(áp dụng ngày \d\d\/\d\d\/\d{4}\); Vietcombank USD: mua CK [\d,]+\.\d\d \/ bán [\d,]+\.\d\d/, usd);
assert.match(usd, /sbv\.gov\.vn/); assert.match(usd, /vietcombank\.com\.vn/);

t = Date.now();
const hist = await f.rate.execute({ currency: 'USD', date: '15/08/2026' }, S);
show(`fx_rate USD 15/08/2026 – ${((Date.now() - t) / 1000).toFixed(1)}s`, hist);
assert.match(hist, /tỷ giá trung tâm: 1 USD = [\d.]+ VND, áp dụng cho ngày 15\/08\/2026/);
assert.match(hist, /Vietcombank – USD \(US DOLLAR\) ngày 15\/08\/2026/);

const eur = await f.rate.execute({ currency: 'EUR', source: 'vcb' }, S);
show('fx_rate EUR (Vietcombank)', eur);
assert.match(head(eur), /Vietcombank EUR: mua CK/);

t = Date.now();
const conv = await f.convert.execute({ amount: '65.765,75', from: 'USD', to: 'VND' }, S);
show(`fx_convert 65.765,75 USD → VND – ${((Date.now() - t) / 1000).toFixed(1)}s (cache)`, conv);
assert.match(head(conv), /^QUY ĐỔI: 65\.765,75 USD = [\d.]+ VND .* theo tỷ giá trung tâm NHNN ngày/);

// the converted amount and the quoted rate pass grounding_check (fx evidence + calc evidence)
const rateVi = usd.match(/tỷ giá trung tâm ([\d.]+) VND\/USD/)[1];
const vnd = head(conv).match(/= ([\d.]+) VND/)[1];
const r = await g.check.execute({ answer: `Theo tỷ giá trung tâm của NHNN (${rateVi} VND/USD), 65.765,75 USD tương đương ${vnd} VND (tính bằng công cụ). Nguồn: https://sbv.gov.vn/vi/t%E1%BB%B7-gi%C3%A1` }, S);
show('grounding_check trên câu trả lời có tỷ giá + số tiền quy đổi', r);
assert.doesNotMatch(r, /Số tiền không thấy/); assert.doesNotMatch(r, /  - [13]%/, 'no figures from percent-encoded URLs'); assert.match(r, /Tính bằng công cụ[^\n]*:\n(  - .*\n)*  - [\d.]+ VND/);
const e = ev.loadEvidence(S.sessionID);
assert.ok(e.some((x) => x.source === 'sbv.gov.vn') && e.some((x) => x.source === 'vietcombank.com.vn') && e.some((x) => x.source === 'calc'));
console.log('\nALL PASSED');
