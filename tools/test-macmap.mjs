// Tests for .opencode/tools/macmap.ts. Offline by default: the browser is made unreachable, so the tool must answer
// with the per-market fallback, and a second call must not try again (blocked pause). LIVE=1 also runs one real lookup
// (needs the Xvfb display :99; passes when macmap.org answers OR when it reports the Cloudflare check with a fallback).
import assert from 'node:assert/strict';
if (!process.env.LIVE) { process.env.MACMAP_CHROME_PORT = '9399'; process.env.MACMAP_CHROME_EXE = '/bin/false' }
const t = await import('../.opencode/tools/macmap.ts');
const call = async (a) => { const s = Date.now(); const r = String(await t.access.execute(a, {})); return { r, ms: Date.now() - s } };
if (!process.env.LIVE) {
  const first = await call({ hs: '0306.17', importer: 'US' });
  assert.match(first.r, /Không tra được Market Access Map/);
  assert.match(first.r, /tariff_us\(hs="030617"\)/, 'US → tariff_us');
  const de = await call({ hs: '090111', importer: 'Đức' });
  assert.match(de.r, /tariff_eu\(hs="090111", destination="DE"\)/, 'Germany → tariff_eu DE');
  assert.match(de.r, /tariff_eu_requirements/);
  assert.ok(de.ms < 1000, `second call answers at once while paused (${de.ms} ms)`);
  assert.match(de.r, /tạm ngừng thử lại/);
  assert.match((await call({ hs: '090111', importer: 'EU' })).r, /destination="FR"/, 'EU → a member state');
  assert.match((await call({ hs: '090111', importer: 'Việt Nam' })).r, /tariff_vn\(hs="090111"\).*tariff_vn_table/s, 'VN → tariff_vn + table');
  assert.match((await call({ hs: '030617', importer: 'Nhật Bản' })).r, /fta_search.*web_search/s, 'other markets → fta_search + official customs site');
  assert.match((await call({ hs: '0306', importer: 'JP' })).r, /ít nhất 6 số/, 'HS < 6 digits');
  console.log('macmap offline tests pass');
} else {
  const { r, ms } = await call({ hs: '0306.17', importer: 'JP' });
  console.log(`live (${ms} ms):\n` + r.slice(0, 1200));
  assert.ok(/ĐIỀU KIỆN TIẾP CẬN THỊ TRƯỜNG/.test(r) || (/Không tra được/.test(r) && /→ Thay thế/.test(r)), 'live: data or a fallback');
  console.log('macmap live test pass');
}
