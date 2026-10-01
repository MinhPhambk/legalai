// Smoke test for grounding_check / expert_escalate (run with the sandbox Chrome up: node tools/launch-chrome.mjs).
import assert from 'node:assert/strict';
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const v = await import('../.opencode/tools/vbpl.ts');
const g = await import('../.opencode/tools/grounding.ts');
const x = await import('../.opencode/tools/expert.ts');
const ev = await import('../.opencode/lib/evidence.ts');

// ---- offline: English answers – "(unofficial translation: …)" is a translation, not a verbatim quote ----
{
  const S = { sessionID: 'grounding-en-' + Date.now() };
  const url = 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117';
  const art = 'Luật Thương mại số 36/2005/QH11 ' + 'Điều 301. Mức phạt vi phạm\nMức phạt đối với vi phạm nghĩa vụ hợp đồng hoặc tổng mức phạt đối với nhiều vi phạm do các bên thoả thuận trong hợp đồng, nhưng không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm, trừ trường hợp quy định tại Điều 266 của Luật này.';
  ev.recordEvidence(S.sessionID, { url, title: 'Luật Thương mại 36/2005/QH11 – Điều 301', text: art, source: 'vbpl_article' });
  ev.recordEvidence(S.sessionID, { url: url + '#dieu-300', title: 'Điều 300', text: 'Điều 300. Phạt vi phạm\nPhạt vi phạm là việc bên bị vi phạm yêu cầu bên vi phạm trả một khoản tiền phạt do vi phạm hợp đồng nếu trong hợp đồng có thoả thuận, trừ các trường hợp miễn trách nhiệm quy định tại Điều 294 của Luật này.', source: 'vbpl_article' });
  const vnQuote = 'Mức phạt đối với vi phạm nghĩa vụ hợp đồng hoặc tổng mức phạt đối với nhiều vi phạm do các bên thoả thuận trong hợp đồng, nhưng không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm';
  const enGood = [
    'Under Article 301 of the Commercial Law (Law No. 36/2005/QH11), the contractual penalty is capped:',
    `> "${vnQuote}" (unofficial translation: "The penalty for a breach of contractual obligations, or the aggregate penalty for multiple breaches, shall be agreed by the parties in the contract but shall not exceed 8% of the value of the breached part of the contractual obligation (except as provided in Article 266)")`,
    '',
    'Article 300 defines the penalty for breach: "Phạt vi phạm là việc bên bị vi phạm yêu cầu bên vi phạm trả một khoản tiền phạt do vi phạm hợp đồng nếu trong hợp đồng có thoả thuận" (unofficial translation: "Penalty for breach means that the aggrieved party requests the breaching party to pay a monetary penalty for the breach of contract if so agreed in the contract").',
    `Source: ${url}`,
  ].join('\n');
  const r1 = await g.check.execute({ answer: enGood }, S);
  assert.match(r1, /ĐỘ TIN CẬY \(tính từ bằng chứng\): CAO/, r1);
  assert.match(r1, /trích dẫn 2,/, 'only the two Vietnamese quotes are checked');
  assert.match(r1, /Bản dịch không chính thức: 2 đoạn/);
  assert.doesNotMatch(r1, /KHÔNG có nguyên văn/);
  // an English "quote" presented as if it were the source text is still flagged
  const enBad = `Article 301 of the Commercial Law (36/2005/QH11) provides: "The penalty for a breach of contractual obligations shall not exceed 8% of the value of the breached part of the contractual obligation." Source: ${url}`;
  const r2 = await g.check.execute({ answer: enBad }, S);
  assert.match(r2, /ĐỘ TIN CẬY \(tính từ bằng chứng\): THẤP/); assert.match(r2, /KHÔNG có nguyên văn[\s\S]*The penalty for a breach/);
  // the Vietnamese quote next to a translation is still verified: a wrong one is flagged
  const enWrongVn = `Article 301: "Mức phạt đối với vi phạm nghĩa vụ hợp đồng không quá 12% giá trị toàn bộ hợp đồng theo thỏa thuận" (unofficial translation: "The penalty shall not exceed 12% of the total contract value"). Source: ${url}`;
  const r3 = await g.check.execute({ answer: enWrongVn }, S);
  assert.match(r3, /THẤP/); assert.match(r3, /KHÔNG có nguyên văn[\s\S]*không quá 12% giá trị toàn bộ/); assert.match(r3, /Con số không thấy[\s\S]*12%/);
  // nested parentheses inside the translation
  const r4 = await g.check.execute({ answer: `> "${vnQuote}" (unofficial translation: "the penalty (for one or several breaches) shall not exceed 8% (eight percent) of the value of the breached part of the obligation")\nSource: ${url}` }, S);
  assert.doesNotMatch(r4, /KHÔNG có nguyên văn/); assert.match(r4, /Bản dịch không chính thức: 1 đoạn/);
  console.log('✓ English answers: translations skipped, Vietnamese quotes still verified, unmarked English quotes flagged');
}

// ---- offline: money amounts are claims; computed figures only from calc evidence (see also test-calc.mjs) ----
{
  const c = await import('../.opencode/tools/calc.ts');
  const S = { sessionID: 'grounding-calc-' + Date.now() };
  const url = 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117';
  ev.recordEvidence(S.sessionID, { url, title: 'Điều 301', text: 'Luật Thương mại số 36/2005/QH11. Điều 301. Mức phạt vi phạm … nhưng không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm … hợp đồng trị giá 150.000.000 đồng', source: 'vbpl_article' });
  await c.interest.execute({ principal: '150.000.000 đồng', rate_percent: 8, kind: 'penalty' }, S);
  const r = await g.check.execute({ answer: `Mức phạt tối đa 8% (Điều 301 Luật Thương mại 36/2005/QH11) trên 150.000.000 đồng là 12.000.000 đồng; còn 9.999.000 đồng là số tự nhẩm; phí … đồng chưa điền. Nguồn: ${url}` }, S);
  assert.match(r, /số tiền 3,/, r); // 150.000.000 (source), 12.000.000 (calc), 9.999.000 (invented); "… đồng" is no claim
  assert.match(r, /Tính bằng công cụ[^\n]*:\n  - 12\.000\.000 đồng/);
  assert.match(r, /Số tiền không thấy[^\n]*:\n  - 9\.999\.000 đồng/);
  assert.match(r, /TRUNG BÌNH/);
  console.log('✓ money amounts: source / calc ("tính bằng công cụ") accepted, invented amount flagged, placeholder ignored');
}

// ---- offline: research enforcement – unsupported / no sources → mandatory web research, max 3 rounds ----
{
  const S = { sessionID: 'grounding-enforce-' + Date.now() };
  const memory = 'Theo Nghị định 70/2025/NĐ-CP, hóa đơn điện tử áp dụng từ 01/06/2025 và mức phạt là 15%.';
  let r = await g.check.execute({ answer: memory }, S);
  assert.match(r, /THẤP/); assert.match(r, /nêu số hiệu \/ con số \/ trích dẫn nhưng chưa mở nguồn nào/);
  assert.match(r, /→ BẮT BUỘC \(vòng 1\/3\): tra thêm bằng web_search → web_read .*số hiệu 70\/2025\/NĐ-CP; con số 15%/);
  r = await g.check.execute({ answer: memory }, S); assert.match(r, /vòng 2\/3/);
  r = await g.check.execute({ answer: memory }, S); assert.match(r, /vòng 3\/3/);
  r = await g.check.execute({ answer: memory }, S);
  assert.match(r, /Đã tra 3 vòng mà vẫn chưa có căn cứ: KHÔNG đoán\. Trả lời với câu "Tôi chưa xác minh được …"/); assert.match(r, /expert_escalate/);
  // once a source is read and the answer is supported, the counter resets (a new question starts at round 1)
  ev.recordEvidence(S.sessionID, { url: 'https://congbao.chinhphu.vn/van-ban/nghi-dinh-so-70-2025-nd-cp-44623.htm', title: 'NĐ 70/2025', text: 'Nghị định số 70/2025/NĐ-CP sửa đổi, bổ sung một số điều của Nghị định số 123/2020/NĐ-CP quy định về hóa đơn, chứng từ. Nghị định này có hiệu lực thi hành từ ngày 01 tháng 6 năm 2025.', source: 'congbao.chinhphu.vn' });
  r = await g.check.execute({ answer: 'Nghị định 70/2025/NĐ-CP sửa đổi Nghị định 123/2020/NĐ-CP. Nguồn: https://congbao.chinhphu.vn/van-ban/nghi-dinh-so-70-2025-nd-cp-44623.htm' }, S);
  assert.doesNotMatch(r, /BẮT BUỘC/); assert.doesNotMatch(r, /THẤP/);
  r = await g.check.execute({ answer: 'Thuế MFN thép 7208 là 12%. Nguồn: https://congbao.chinhphu.vn/van-ban/nghi-dinh-so-70-2025-nd-cp-44623.htm' }, S);
  assert.match(r, /vòng 1\/3/);
  // a non-official page read with web_read carries a warning → at most TRUNG BÌNH
  const S2 = { sessionID: 'grounding-unofficial-' + Date.now() };
  ev.recordEvidence(S2.sessionID, { url: 'https://example-blog.vn/bai-viet', title: 'blog', text: 'Luật Thương mại số 36/2005/QH11: mức phạt không quá 8% giá trị phần nghĩa vụ bị vi phạm.', source: 'example-blog.vn' });
  ev.recordWarning(S2.sessionID, 'https://example-blog.vn/bai-viet', '⚠ Nguồn không chính thức: example-blog.vn');
  r = await g.check.execute({ answer: 'Mức phạt không quá 8% (Luật Thương mại 36/2005/QH11). Nguồn: https://example-blog.vn/bai-viet' }, S2);
  assert.match(r, /TRUNG BÌNH/); assert.match(r, /Nguồn không chính thức/);
  console.log('✓ enforcement: memory answer → THẤP + "BẮT BUỘC (vòng n/3): tra thêm bằng web_search → web_read"; after 3 rounds → "chưa xác minh được" + expert_escalate; counter resets; non-official source ≤ TRUNG BÌNH');
}

// ---- online (vbpl.vn through the sandbox Chrome) ----
const ctx = { sessionID: 'grounding-smoke-' + Date.now() };
const url = 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117';
await v.article.execute({ url, article: '301' }, ctx);
const good = `Theo Điều 301 Luật Thương mại 2005 (36/2005/QH11):\n> "Mức phạt đối với vi phạm nghĩa vụ hợp đồng hoặc tổng mức phạt đối với nhiều vi phạm do các bên thỏa thuận trong hợp đồng, nhưng không quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm"\nNguồn: ${url}`;
const bad = `Theo Điều 301 Luật Thương mại 2005 (36/2005/QH11), "mức phạt tối đa là 12% tổng giá trị hợp đồng và có thể cộng thêm lãi chậm trả" – tổng cộng khoảng 88,36%. Xem https://vbpl.vn/van-ban/chi-tiet/bo-luat-dan-su-2015--99999 và Nghị định 98/2020/NĐ-CP.`;
for (const [name, answer, c] of [['GOOD', good, ctx], ['BAD', bad, ctx], ['NO-EVIDENCE', good, { sessionID: 'empty-' + Date.now() }]])
  console.log(`\n===== ${name}\n` + (await g.check.execute({ answer }, c)));
// expert_escalate creates a REAL ticket (.sandbox/escalations → web expert queue): opt-in only
if (process.env.ND45_TEST_ESCALATE === '1') console.log('\n===== ESCALATE\n' + (await x.escalate.execute({ reason: 'Thử nghiệm', summary: 'Kiểm tra công cụ chuyển chuyên gia', urgency: 'thấp', topic: 'khác' }, ctx)));
else console.log('\n===== ESCALATE: bỏ qua (tạo yêu cầu thật trong hàng đợi chuyên gia) – chạy với ND45_TEST_ESCALATE=1 để thử');
