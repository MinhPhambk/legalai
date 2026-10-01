// clock_now / clock_calc: deterministic deadline arithmetic (BLDS 2015 Điều 147–148, holidays per BLLĐ 2019
// Điều 111–112 with lunar dates). "Today" is pinned with LEGALAI_NOW so results do not depend on the run date.
import assert from 'node:assert/strict';
process.env.LEGALAI_NOW = '2026-09-26T10:00:00+07:00';
const c = await import('../.opencode/tools/clock.ts');
const calc = (a) => c.calc.execute(a, {});
const end = (out) => out.match(/HẠN CUỐI: hết ngày (\d\d\/\d\d\/\d{4})/)?.[1];
const ok = (m) => console.log('  ✓', m);

console.log('clock_now');
const n = await c.now.execute({}, {});
assert.match(n, /Thứ Bảy, ngày 26\/09\/2026 – 10:00:00/); assert.match(n, /Saturday, 26 September 2026/);
assert.match(n, /2026-09-26T10:00:00\+07:00/); assert.match(n, /Âm lịch: 16\/8 năm âm lịch 2026/); // Trung thu 2026 = 25/9
assert.match(n, /ngày nghỉ: Thứ Bảy/);
ok('26/09/2026 Saturday, ISO +07:00, lunar 16/8');

console.log('Tết / Giỗ Tổ from the lunar calendar (2025–2030)');
// first working day after the day before Tết reveals the computed Tết block; mùng 1 must be listed on the right date
const TET = { 2025: '29/01/2025', 2026: '17/02/2026', 2027: '06/02/2027', 2028: '26/01/2028', 2029: '13/02/2029', 2030: '02/02/2030' }; // 2030: new moon ≈23:07 UTC+7 on 2 Feb → Vietnam's Tết is one day before China's (3 Feb)
for (const [y, d] of Object.entries(TET)) {
  const [dd, mm] = d.split('/').map(Number);
  const before = new Date(Date.UTC(+y, mm - 1, dd - 3));
  const from = `${String(before.getUTCDate()).padStart(2, '0')}/${String(before.getUTCMonth() + 1).padStart(2, '0')}/${y}`;
  const out = await calc({ from, business_days: 3 });
  assert.match(out, new RegExp(`${d.replace(/\//g, '\\/')} Tết Âm lịch \\(mùng 1\\)`), `Tết ${y}: ${out}`);
}
ok(Object.entries(TET).map(([y, d]) => `${y}: ${d}`).join(', '));
const g25 = await calc({ from: '04/04/2025', business_days: 1 }); // Fri 4/4 → Mon 7/4 Giỗ Tổ → Tue 8/4
assert.match(g25, /07\/04\/2025 Giỗ Tổ Hùng Vương/); assert.equal(end(g25), '08/04/2025');
const g26 = await calc({ from: '24/04/2026', business_days: 1 }); // Giỗ Tổ 26/4/2026 is a Sunday → nghỉ bù Mon 27/4
assert.match(g26, /27\/04\/2026 Nghỉ bù \(Giỗ Tổ Hùng Vương/); assert.equal(end(g26), '28/04/2026');
ok('Giỗ Tổ 07/04/2025; 26/04/2026 (Sunday) → nghỉ bù 27/04/2026');
const t27 = await calc({ from: '04/02/2027', business_days: 1 });
assert.match(t27, /05\/02\/2027 Tết Âm lịch \(ngày cuối năm âm lịch\)/); assert.match(t27, /10\/02\/2027 Nghỉ bù/); assert.match(t27, /11\/02\/2027 Nghỉ bù/);
assert.equal(end(t27), '12/02/2027');
ok('Tết 2027: 05–09/02 + nghỉ bù 10–11/02 (mùng 1–2 fall on the weekend) → first working day 12/02/2027');

console.log('deadlines (Điều 147–148 BLDS)');
const d30 = await calc({ from: '15/01/2026', add_days: 30 });
assert.match(d30, /ngày cuối theo lịch: 14\/02\/2026 \(Thứ Bảy\)/); assert.match(d30, /Điều 148 khoản 5/);
assert.equal(end(d30), '23/02/2026', '14/02 Sat → weekend + Tết Bính Ngọ 16–20/02 → Mon 23/02'); assert.match(d30, /ĐÃ QUÁ HẠN 215 ngày/);
ok('30 ngày kể từ 15/01/2026 → 14/02/2026 (T7) → Tết → hết ngày 23/02/2026; quá hạn 215 ngày');
const d45 = await calc({ from: '20/08/2026', add_days: 45 });
assert.equal(end(d45), '05/10/2026'); assert.match(d45, /CÒN 9 ngày/);
ok('45 ngày kể từ 20/08/2026 → 04/10 (CN) → 05/10/2026, còn 9 ngày');
const exact = await calc({ from: '20/08/2026', add_days: 45, rule: 'exact' });
assert.equal(end(exact), '04/10/2026');
const m1 = await calc({ from: '31/01/2026', add_months: 1 });
assert.match(m1, /ngày cuối theo lịch: 28\/02\/2026/); assert.equal(end(m1), '02/03/2026');
ok('1 tháng kể từ 31/01/2026 → 28/02 (no 31/02; Saturday) → 02/03/2026; rule=exact keeps 04/10');
const y2 = await calc({ from: '10/03/2024', add_years: 2 });
assert.equal(end(y2), '10/03/2026');
const q = await calc({ from: '28/08/2026', add_days: 5 }); // 2/9/2026 is a Wednesday → 2/9 + 3/9 by default
assert.match(q, /02\/09\/2026 Quốc khánh 2\/9/); assert.match(q, /03\/09\/2026 Quốc khánh \(ngày liền kề\)/); assert.equal(end(q), '04/09/2026');
ok('2 năm (thời hiệu) 10/03/2024 → 10/03/2026; 5 ngày từ 28/08/2026 → 02/09 lễ → 04/09/2026');

console.log('working days, days between, extra holidays, errors');
const b = await calc({ from: '28/04/2026', business_days: 3 }); // 29/4 (1), 30/4 + 1/5 holidays, weekend, 4/5 (2), 5/5 (3)
assert.equal(end(b), '05/05/2026'); assert.match(b, /30\/04\/2026 Ngày Chiến thắng/); assert.match(b, /01\/05\/2026 Ngày Quốc tế Lao động/);
const u = await calc({ from: '01/09/2026', until: '30/09/2026' });
assert.match(u, /29 ngày theo lịch, 19 ngày làm việc/); assert.match(u, /CÒN 4 ngày/);
const back = await calc({ from: '30/09/2026', until: '01/09/2026' });
assert.match(back, /mốc thứ hai ở TRƯỚC/);
const ex = await calc({ from: '20/08/2026', add_days: 45, extra_holidays: ['05/10/2026'] });
assert.equal(end(ex), '06/10/2026');
assert.match(await calc({ from: '31/02/2026', add_days: 1 }), /^Lỗi: không hiểu ngày/);
assert.match(await calc({ from: '01/01/2026' }), /^Lỗi: cần ít nhất/);
assert.match(await calc({ from: '01/01/2026', add_days: 3, business_days: 2 }), /^Lỗi: business_days không dùng chung/);
ok('3 ngày làm việc từ 28/04/2026 → 05/05/2026; 01–30/09/2026 = 29 ngày / 19 ngày làm việc; extra_holidays; invalid input');
console.log('\nALL PASSED');
