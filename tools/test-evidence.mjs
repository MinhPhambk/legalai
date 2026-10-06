// Offline tests: a broken evidence file must never make a session look like "no sources", and the per-link
// status recorded by grounding_check must agree with the badge counts (the web UI uses both).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'evtest-'));
const ev = await import('../.opencode/lib/evidence.ts');
const g = await import('../.opencode/tools/grounding.ts');
const dir = path.join(process.env.XDG_CACHE_HOME, 'legalai', 'evidence');
fs.mkdirSync(dir, { recursive: true });
const A = 'https://trade.ec.europa.eu/access-to-markets/en/results?product=6205200010&origin=VN&destination=DE';
const B = 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117';
const rec = (url, text, source) => JSON.stringify({ url, title: 't', text, source, at: Date.now() });
// 1) a record cut off mid-write, glued to the next complete record, then a normal line
const sid = 'ev-broken';
fs.writeFileSync(path.join(dir, `${sid}.jsonl`), rec(A, 'Third country duty 12 % for shirts of cotton, men', 'trade.ec.europa.eu').slice(0, -60) + rec(A, 'Tariff preference 0 % Viet Nam', 'trade.ec.europa.eu') + '\n' + rec(B, 'Luật Thương mại 36/2005/QH11 Điều 301. không quá 8% giá trị', 'vbpl.vn') + '\n');
const list = ev.loadEvidence(sid);
assert.equal(list.length, 3, 'cut + glued + normal → 3 records (cut one salvaged)');
assert.ok(list.some((e) => e.meta?.truncated), 'cut record kept, marked truncated');
// 2) the next write starts on a new line even if the file does not end with "\n"
fs.appendFileSync(path.join(dir, `${sid}.jsonl`), '{"url":"x","text":"cut');
ev.recordEvidence(sid, { url: B, text: 'more', source: 'vbpl.vn' });
assert.equal(ev.loadEvidence(sid).filter((e) => e.text === 'more').length, 1, 'appended record parses');
// 3) grounding on that session: sources are seen, link states + one denominator
const r = String(await g.check.execute({ answer: `Thuế EVFTA 0% (${A}); mức phạt tối đa 8% theo 36/2005/QH11 (${B}). Xem thêm https://example.com/blog` }, { sessionID: sid }));
assert.doesNotMatch(r, /không có nguồn nào/, r);
const v = JSON.parse(ev.loadEvidence(sid).filter((e) => e.source === 'grounding').at(-1).text);
assert.deepEqual(v.links.map((x) => x.s), ['ok', 'ok', 'external']);
assert.equal(v.unverifiable, 1);
assert.equal(v.checkable, v.claims - v.unverifiable);
assert.ok(v.supported <= v.checkable);
for (const w of v.why) if (w.total != null) assert.equal(w.total, v.checkable, `why ${w.code} uses the checkable denominator`);
console.log('evidence + link-status tests pass', JSON.stringify({ level: v.level, claims: v.claims, checkable: v.checkable, supported: v.supported }));
