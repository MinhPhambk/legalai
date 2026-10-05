// Offline regression tests for quote handling in grounding_check (no Chrome / network needed).
// Covers the false "invented quote" verdicts seen in the 6,000-question evaluation (05/10/2026).
import assert from 'node:assert/strict';
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname;
const g = await import('../.opencode/tools/grounding.ts');
const ev = await import('../.opencode/lib/evidence.ts');
const url = 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117';
const blds = 'https://vbpl.vn/van-ban/chi-tiet/bo-luat-dan-su-so-91-2015-qh13--95942';
const art = 'Luật Thương mại số 36/2005/QH11\nĐiều 301. Mức phạt vi phạm\nMức phạt đối với vi phạm nghĩa vụ hợp đồng hoặc tổng mức phạt đối với nhiều vi phạm do các bên thoả thuận trong hợp đồng, nhưng không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm, trừ trường hợp quy định tại Điều 266 của Luật này.\nĐiều 302. Bồi thường thiệt hại\n1. Bồi thường thiệt hại là việc bên vi phạm bồi thường những tổn thất do hành vi vi phạm hợp đồng gây ra cho bên bị vi phạm.';
let k = 0;
async function verdict(answer) {
  const S = { sessionID: `gq-${Date.now()}-${k++}` };
  ev.recordEvidence(S.sessionID, { url, title: 'Luật Thương mại 36/2005/QH11', text: art, source: 'vbpl_article' });
  ev.recordEvidence(S.sessionID, { url: blds, title: 'Bộ luật Dân sự – Điều 419', text: 'Điều 419. Thiệt hại được bồi thường do vi phạm hợp đồng\n1. Thiệt hại được bồi thường do vi phạm nghĩa vụ theo hợp đồng được xác định theo quy định tại khoản 2 Điều này.', source: 'vbpl_article' });
  const r = String(await g.check.execute({ answer }, S));
  return { level: r.match(/ĐỘ TIN CẬY[^:]*:\s*([^\n]+)/)[1].trim(), r };
}
const tail = `\nSource: ${url} (Luật Thương mại 36/2005/QH11, 8%)`;
const cases = [
  ['verbatim', `Theo Điều 301: "Mức phạt đối với vi phạm nghĩa vụ hợp đồng hoặc tổng mức phạt đối với nhiều vi phạm do các bên thoả thuận trong hợp đồng"${tail}`, 'CAO'],
  ['bold inside quote', `> **Khoản 1:** Mức phạt đối với vi phạm nghĩa vụ hợp đồng … do các bên thoả thuận trong hợp đồng, nhưng **không quá 8%** giá trị phần nghĩa vụ hợp đồng bị vi phạm${tail}`, 'CAO'],
  ['ellipsis', `"Mức phạt đối với vi phạm nghĩa vụ hợp đồng... nhưng không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm"${tail}`, 'CAO'],
  ['near verbatim (one word differs)', `"Mức phạt đối với vi phạm nghĩa vụ hợp đồng hoặc tổng mức phạt đối với nhiều vi phạm do hai bên thoả thuận trong hợp đồng, nhưng không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm"${tail}`, 'CAO'],
  ['text between two short quotes', `Khái niệm "phạt vi phạm" theo Luật Thương mại là chế tài riêng, khác hẳn với khái niệm "bồi thường thiệt hại" ở Điều 302.${tail}`, 'CAO'],
  ['callout blockquote', `> Nói cách khác: bạn chỉ được thỏa thuận mức phạt tối đa 8% phần nghĩa vụ bị vi phạm, trừ trường hợp giám định.${tail}`, 'CAO'],
  ['intro line ending with colon', `> Trích nguyên văn Điều 301 Luật Thương mại 2005 như sau:\n> "Mức phạt đối với vi phạm nghĩa vụ hợp đồng hoặc tổng mức phạt đối với nhiều vi phạm do các bên thoả thuận trong hợp đồng"${tail}`, 'CAO'],
  ['paraphrase presented as quote', `"Mức phạt đối với vi phạm nghĩa vụ hợp đồng hoặc tổng mức phạt đối với nhiều vi phạm do các bên tự do quyết định, tối đa là 8% tổng giá trị toàn bộ hợp đồng"${tail}`, 'TRUNG BÌNH'],
  ['id from the opened document link', `Điều 419 Bộ luật Dân sự 91/2015/QH13 quy định thiệt hại được bồi thường do vi phạm hợp đồng; mức phạt tối đa 8% theo Luật Thương mại 36/2005/QH11.\nNguồn: ${blds} ; ${url}`, 'CAO'],
  ['one unsupported id in a short answer', `Mức phạt tối đa 8% theo Luật Thương mại 36/2005/QH11 (xem thêm Nghị định 99/2099/NĐ-CP).\nNguồn: ${url}`, 'TRUNG BÌNH'],
  ['invented quote', `Điều 301 quy định: "Bên vi phạm phải trả tiền phạt gấp ba lần giá trị thiệt hại thực tế cho bên bị vi phạm trong mọi trường hợp"${tail}`, 'THẤP'],
];
let fail = 0;
for (const [name, answer, want] of cases) {
  const { level, r } = await verdict(answer);
  const ok = level === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${level} (want ${want})${ok ? '' : '\n' + r.split('\n').slice(0, 8).join('\n')}`);
}
assert.equal(fail, 0, `${fail} case(s) failed`);
console.log('all quote cases pass');
