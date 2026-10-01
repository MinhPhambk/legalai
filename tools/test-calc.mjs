// calc_* tools (exact decimal arithmetic, Vietnamese number formats, money in words, interest / penalty,
// contract figure check) and grounding_check's acceptance of computed figures. Offline – no Chrome needed.
// "Today" is pinned with LEGALAI_NOW so the interest day counts do not depend on the run date.
import assert from 'node:assert/strict';
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.LEGALAI_NOW = '2026-09-27T10:00:00+07:00';
const c = await import('../.opencode/tools/calc.ts');
const g = await import('../.opencode/tools/grounding.ts');
const ev = await import('../.opencode/lib/evidence.ts');
const S = { sessionID: 'calc-test-' + Date.now() };
const ok = (m) => console.log('  ✓', m);
const head = (s) => s.split('\n')[0];

console.log('calc_eval – exact decimals, rounding, number formats');
{
  let r = await c.eval.execute({ expression: '0.1 + 0.2' }, S);
  assert.match(head(r), /^KẾT QUẢ: 0,3 \(en: 0\.3\)$/, r);
  r = await c.eval.execute({ expression: '0,1 + 0,2 - 0,3' }, S); assert.match(head(r), /^KẾT QUẢ: 0 /);
  r = await c.eval.execute({ expression: '1/3 * 3' }, S); assert.match(head(r), /^KẾT QUẢ: 1 /, 'rationals, no float drift');
  r = await c.eval.execute({ expression: '1.234,5', round: 'vnd' }, S); assert.match(head(r), /^KẾT QUẢ: 1\.235 /);
  r = await c.eval.execute({ expression: 'round(2,5) + round(-2,5)' }, S); assert.match(head(r), /^KẾT QUẢ: 0 /, 'half-up away from zero: 3 + (−3)');
  r = await c.eval.execute({ expression: '1.005 × 1.000', round: 'usd', locale: 'en' }, S); assert.match(head(r), /^KẾT QUẢ: 1,01 \(en: 1\.01\)/, 'en: 1.005 rounds half-up to 1.01 (float gives 1.00)');
  r = await c.eval.execute({ expression: '2,675', round: 'usd', locale: 'vi' }, S); assert.match(head(r), /^KẾT QUẢ: 2,68 /, 'USD half-up (float would give 2.67)');
  r = await c.eval.execute({ expression: '1.250.000 x 120 x (1 + 10%)' }, S); assert.match(head(r), /^KẾT QUẢ: 165\.000\.000 /); assert.match(r, /1\.250\.000 × 120 = 150\.000\.000/);
  r = await c.eval.execute({ expression: '12,5% × 1.000.000 đồng' }, S); assert.match(head(r), /^KẾT QUẢ: 125\.000 /);
  r = await c.eval.execute({ expression: '1,250,000.50 + 0.5' }, S); assert.match(head(r), /^KẾT QUẢ: 1\.250\.001 \(en: 1,250,001\)/);
  r = await c.eval.execute({ expression: 'rate × value', vars: { rate: '22,5%', value: '1.500.000 USD' }, round: 'usd' }, S); assert.match(head(r), /^KẾT QUẢ: 337\.500,00 /);
  r = await c.eval.execute({ expression: 'sum(1.000; 2.500; 3.750) / avg(2, 4)' }, S); assert.match(head(r), /^KẾT QUẢ: 2\.416,6666666667|^KẾT QUẢ: ≈2\.416,6666666667/);
  r = await c.eval.execute({ expression: '(1 + 12%/12)^12 - 1', round: '6' }, S); assert.match(head(r), /^KẾT QUẢ: 0,126825 /);
  r = await c.eval.execute({ expression: 'process.exit(1)' }, S); assert.match(r, /^Lỗi:/, 'no eval: identifiers are only functions / vars');
  r = await c.eval.execute({ expression: '2 ^ 0,5' }, S); assert.match(r, /^Lỗi: chỉ hỗ trợ số mũ nguyên/);
  r = await c.eval.execute({ expression: '5 / (3 - 3)' }, S); assert.match(r, /^Lỗi: chia cho 0/);
  ok('0.1 + 0.2 = 0.3 exactly; VND / USD half-up; vi "1.250.000", "12,5%" and en "1,250,000.50"; vars; sum/avg; ^; safe errors');
}

console.log('calc_money_words / calc_check_words – Vietnamese reading rules, USD cents, English');
{
  const W = async (amount, currency, lang) => head(await c.money_words.execute({ amount, currency, lang }, S)).replace(/^BẰNG CHỮ: /, '');
  const cases = [
    ['1.005.000', 'Một triệu không trăm linh năm nghìn đồng chẵn'],
    ['21', 'Hai mươi mốt đồng chẵn'],
    ['25', 'Hai mươi lăm đồng chẵn'],
    ['101', 'Một trăm linh một đồng chẵn'],
    ['1.000.000.000', 'Một tỷ đồng chẵn'],
    ['15', 'Mười lăm đồng chẵn'],
    ['105', 'Một trăm linh năm đồng chẵn'],
    ['14', 'Mười bốn đồng chẵn'],
    ['110', 'Một trăm mười đồng chẵn'],
    ['2.035.000.000', 'Hai tỷ không trăm ba mươi lăm triệu đồng chẵn'],
    ['1.500.000.000.000', 'Một nghìn năm trăm tỷ đồng chẵn'],
  ];
  for (const [n, w] of cases) assert.equal(await W(n), w, n);
  assert.equal(await W('65.000', 'USD'), 'Sáu mươi lăm nghìn đô la Mỹ chẵn');
  assert.equal(await W('65.765,75', 'USD'), 'Sáu mươi lăm nghìn bảy trăm sáu mươi lăm đô la Mỹ và bảy mươi lăm xu');
  assert.equal(await W('65,765.01', 'USD', 'en'), 'Sixty-five thousand seven hundred sixty-five US dollars and one cent');
  assert.equal(await W('1', 'USD', 'en'), 'One US dollar');
  assert.equal(await W('1.005.000', 'VND', 'en'), 'One million five thousand Vietnam dong');
  let r = await c.check_words.execute({ number_text: '1.500.000.000 đồng', words_text: 'Một tỷ năm trăm nghìn đồng chẵn' }, S);
  assert.match(head(r), /^KHÔNG KHỚP: .*đọc ra 1\.000\.500\.000/); assert.match(r, /Cách viết chuẩn: Một tỷ năm trăm triệu đồng chẵn/);
  r = await c.check_words.execute({ number_text: '1.005.000 đồng', words_text: 'Một triệu không trăm lẻ năm ngàn đồng' }, S);
  assert.match(head(r), /^KHỚP: /, 'lẻ / ngàn / missing "chẵn" are accepted variants');
  r = await c.check_words.execute({ number_text: '35.000.000', words_text: 'Ba mươi năm triệu đồng' }, S);
  assert.match(head(r), /^KHỚP GIÁ TRỊ .*khác chuẩn/, '"mươi năm" → should be "mươi lăm"');
  r = await c.check_words.execute({ number_text: 'USD 65,000.50', words_text: 'Sixty-five thousand US dollars and fifty cents only' }, S);
  assert.match(head(r), /^KHỚP: /, r);
  r = await c.check_words.execute({ number_text: 'USD 65,000', words_text: 'Sixty-six thousand US dollars' }, S);
  assert.match(head(r), /^KHÔNG KHỚP: .*66,000/);
  ok('1.005.000, 21, 25, 101, 1.000.000.000, 15, 105, 14, 110, tỷ/nghìn tỷ; USD "… xu", EN "… cents"; check: mismatch / variants / style');
}

console.log('calc_interest – actual/365, 30/360, compounding, loan cap, penalty cap');
{
  let r = await c.interest.execute({ principal: '65.000 USD', rate_percent: 10, from: '15/08/2026', to: '27/09/2026' }, S);
  assert.match(head(r), /^TIỀN LÃI: 765,75 USD \(en: 765\.75 USD\) – 43 ngày/, r); // 65,000 × 10% × 43/365 = 765.7534…
  assert.match(r, /Tổng gốc \+ lãi: 65\.765,75 USD/); assert.match(r, /Điều 306/);
  r = await c.interest.execute({ principal: '100.000.000', rate_percent: 10, from: '01/01/2025', to: '01/01/2026' }, S);
  assert.match(head(r), /^TIỀN LÃI: 10\.000\.000 VND .* 365 ngày/);
  r = await c.interest.execute({ principal: '100.000.000', rate_percent: 12, from: '31/01/2026', to: '31/03/2026', day_count: '30/360' }, S);
  assert.match(head(r), /^TIỀN LÃI: 2\.000\.000 VND .* 60 ngày/);
  r = await c.interest.execute({ principal: '100.000.000', rate_percent: 2, rate_basis: 'month', kind: 'loan', from: '01/01/2026', to: '01/07/2026', compounding: 'monthly' }, S);
  assert.match(head(r), /^TIỀN LÃI: 12\.616\.242 VND/); assert.match(r, /⚠ Lãi suất 24%\/năm vượt 20%\/năm: BLDS 2015 Điều 468/);
  r = await c.interest.execute({ principal: '100.000.000', rate_percent: 18, kind: 'loan', from: '01/01/2026', to: '01/02/2026' }, S);
  assert.doesNotMatch(r, /⚠/);
  r = await c.interest.execute({ principal: '500.000.000 đồng', rate_percent: 10, kind: 'penalty' }, S);
  assert.match(head(r), /^TIỀN PHẠT: 50\.000\.000 VND/); assert.match(r, /⚠ Mức phạt 10% vượt 8%: Luật Thương mại 2005 Điều 301/); assert.match(r, /Điều 266/); assert.match(r, /Điều 418/);
  r = await c.interest.execute({ principal: '1', rate_percent: 8, kind: 'penalty', breached_value: '200.000.000' }, S);
  assert.match(head(r), /^TIỀN PHẠT: 16\.000\.000 VND/); assert.doesNotMatch(r, /⚠/);
  r = await c.interest.execute({ principal: '1000', rate_percent: 10, from: '10/10/2026' }, S); assert.match(r, /^Lỗi: ngày kết thúc/);
  ok('43 days actual/365 = 765,75 USD; 365 days; 30/360; monthly compounding + 20%/năm warning; penalty 10% → Điều 301 warning');
}

console.log('calc_contract_check – crafted contract with 3 deliberate errors, bilingual mismatch');
const CONTRACT = `# HỢP ĐỒNG MUA BÁN HÀNG HÓA

Số: 12/2026/HĐMB

## Điều 1. Hàng hóa, số lượng, giá

| STT | Tên hàng | Đơn vị | Số lượng | Đơn giá (VNĐ) | Thành tiền (VNĐ) |
|---|---|---|---|---|---|
| 1 | Thép cuộn cán nóng | tấn | 100 | 15.500.000 | 1.500.000.000 |
| 2 | Thép tấm | tấn | 20 | 18.000.000 | 360.000.000 |
| | **Cộng tiền hàng** | | | | 1.850.000.000 |
| | Thuế GTGT (10%) | | | | 185.000.000 |
| | **Tổng cộng** | | | | 2.035.000.000 |

Tổng giá trị hợp đồng: 2.035.000.000 đồng (Bằng chữ: Hai tỷ không trăm ba mươi lăm triệu đồng chẵn).

## Điều 2. Thanh toán

1. Đợt 1: tạm ứng 30% giá trị hợp đồng, tương đương 610.500.000 đồng, trong vòng 5 ngày kể từ ngày ký.
2. Đợt 2: thanh toán 70% giá trị hợp đồng, tương đương 1.424.500.000 đồng (Bằng chữ: Một tỷ bốn trăm hai mươi triệu năm trăm nghìn đồng).
3. Bên mua đặt cọc 10% giá trị hợp đồng, tương đương 203.500.000 đồng.

## Điều 3. Phạt vi phạm

Bên vi phạm chịu phạt 12% giá trị phần nghĩa vụ bị vi phạm. Chậm thanh toán chịu lãi 1,5%/tháng trên số tiền chậm trả.
Phí vận chuyển: … đồng.
`;
{
  const r = await c.contract_check.execute({ text: CONTRACT }, S);
  assert.match(head(r), /^SOÁT SỐ LIỆU HỢP ĐỒNG: 3 lỗi, 1 cảnh báo, 1 thông tin/, r);
  assert.match(r, /\[Điều 1 – bảng 1, dòng 1 “Thép cuộn cán nóng”\] thành tiền ≠ số lượng × đơn giá \(100 × 15\.500\.000 = 1\.550\.000\.000/);
  assert.match(r, /\[Điều 1 – bảng 1, dòng 3 “Cộng tiền hàng”\] tổng ≠ cộng các dòng hàng \(2 dòng, cộng = 1\.860\.000\.000\)/);
  assert.match(r, /\[Điều 2 khoản 2\] số tiền bằng chữ không khớp bằng số 1\.424\.500\.000 VND \(phần bằng chữ đọc ra 1\.420\.500\.000\)/);
  assert.match(r, /Một tỷ bốn trăm hai mươi bốn triệu năm trăm nghìn đồng chẵn/);
  assert.match(r, /\[Điều 3\] mức phạt 12% vượt 8% – Luật Thương mại 2005 Điều 301/);
  assert.match(r, /số tiền chưa điền \("… đồng"\)/);
  assert.match(r, /các đợt thanh toán 30% \+ 70% = 100%/); assert.match(r, /tiền đặt cọc\/bảo đảm 10% × 2\.035\.000\.000 = 203\.500\.000/);
  assert.match(r, /lãi suất 18%\/năm ≤ 20%\/năm/);
  ok('row product, subtotal and words mismatch = 3 lỗi (with Điều/khoản locations); 12% penalty warned; "… đồng" = chưa điền; schedule / deposit / VAT pass');
  // bilingual: VI and EN columns, EN has a different installment amount (and its own schedule error)
  const vi = `# HỢP ĐỒNG MUA BÁN\n\n## Điều 1. Giá\n\nTổng giá trị hợp đồng là 65.000 USD (Bằng chữ: Sáu mươi lăm nghìn đô la Mỹ chẵn).\n\n## Điều 2. Thanh toán\n\n1. Đợt 1: 30% giá trị hợp đồng, tương đương 19.500 USD.\n2. Đợt 2: 70% giá trị hợp đồng, tương đương 45.500 USD.\n`;
  const en = `# SALES CONTRACT\n\n## Article 1. Price\n\nThe total contract value is USD 65,000 (in words: Sixty-five thousand US dollars).\n\n## Article 2. Payment\n\n1. First installment: 30% of the contract value, i.e. USD 19,500.\n2. Second installment: 70% of the contract value, i.e. USD 54,500.\n`;
  const b = await c.contract_check.execute({ text: vi, text_en: en }, S);
  assert.match(head(b), /^SOÁT SỐ LIỆU HỢP ĐỒNG: 3 lỗi, 0 cảnh báo, 0 thông tin .*song ngữ/, b);
  assert.match(b, /\[Điều 2 \(VI ↔ EN\)\] số liệu bản tiếng Việt và bản tiếng Anh không khớp – chỉ bản VI có: 45\.500 USD; chỉ bản EN có: 54,500 USD/);
  assert.match(b, /\[\[EN\] Điều 2 khoản 2\] số tiền đợt thanh toán không khớp 70%/);
  assert.match(b, /\[VI\] Điều 1: bằng chữ khớp 65\.000 USD/); assert.match(b, /\[EN\] Điều 1: bằng chữ khớp 65,000 USD/);
  ok('bilingual: both columns checked, VI 45.500 USD ≠ EN 54,500 USD reported as lỗi');
  // mixed currencies without an exchange-rate clause
  const m = await c.contract_check.execute({ text: `## Điều 1. Giá\n\nGiá hàng: 65.000 USD. Phí dịch vụ: 5.000.000 đồng.\n` }, S);
  assert.match(m, /nhiều đồng tiền \(USD, VND\) nhưng không có điều khoản tỷ giá/);
  ok('USD + VND without tỷ giá clause → cảnh báo');
}

console.log('grounding_check – computed figures accepted only from calc evidence');
{
  // an opened legal source (Điều 306 LTM) so the level is not capped by "no source"
  const url = 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117';
  ev.recordEvidence(S.sessionID, { url, title: 'Luật Thương mại 36/2005/QH11 – Điều 306', text: 'Luật Thương mại số 36/2005/QH11 Điều 306. Quyền yêu cầu tiền lãi do chậm thanh toán\nTrường hợp bên vi phạm hợp đồng chậm thanh toán tiền hàng hay chậm thanh toán thù lao dịch vụ và các chi phí hợp lý khác thì bên bị vi phạm hợp đồng có quyền yêu cầu trả tiền lãi trên số tiền chậm trả đó theo lãi suất nợ quá hạn trung bình trên thị trường tại thời điểm thanh toán tương ứng với thời gian chậm trả, trừ trường hợp có thoả thuận khác hoặc pháp luật có quy định khác.', source: 'vbpl_article' });
  const q306 = 'bên bị vi phạm hợp đồng có quyền yêu cầu trả tiền lãi trên số tiền chậm trả đó theo lãi suất nợ quá hạn trung bình trên thị trường';
  const good = `Tiền lãi chậm trả trên 65.000 USD từ 15/08/2026 đến 27/09/2026 (43 ngày) với lãi suất 10%/năm là **765,75 USD** (tính bằng công cụ: 65.000 × 10% × 43/365), tổng 65.765,75 USD.\nTheo Điều 306 Luật Thương mại (36/2005/QH11): "${q306}".\nNguồn: ${url}`;
  let r = await g.check.execute({ answer: good }, S);
  assert.match(r, /ĐỘ TIN CẬY \(tính từ bằng chứng\): CAO/, r);
  assert.match(r, /số tiền 3,/); assert.match(r, /Tính bằng công cụ[^\n]*:\n(?:  - .*\n)*  - 765,75 USD/);
  const invented = good.replace('**765,75 USD**', '**812,40 USD**');
  r = await g.check.execute({ answer: invented }, S);
  assert.match(r, /TRUNG BÌNH|THẤP/); assert.match(r, /Số tiền không thấy trong nguồn đã tra, không do công cụ tính[^\n]*:\n  - 812,40 USD/);
  // an invented percentage stays unsupported; one computed by a calc tool is accepted
  r = await g.check.execute({ answer: `Lãi suất quy đổi là 24%/năm, phạt 12% và thuế 37,5%. Nguồn: ${url}` }, S);
  assert.match(r, /Con số không thấy[^\n]*:\n  - 37,5%/); assert.doesNotMatch(r.split('Con số không thấy')[1] ?? '', /  - 24%|  - 12%/);
  // figures verbatim from the user's own document (artifact evidence) are not flagged; placeholders are no claims
  ev.recordEvidence(S.sessionID, { url: 'artifact://test-doc', title: 'HĐ', text: 'Giá trị hợp đồng 3.210.000.000 đồng', source: 'artifact' });
  r = await g.check.execute({ answer: `Hợp đồng ghi giá trị 3.210.000.000 đồng; phí vận chuyển … đồng chưa điền. Nguồn: ${url}` }, S);
  assert.match(r, /Số tiền \/ đoạn trích lấy nguyên văn từ tài liệu của người dùng:\n  - 3\.210\.000\.000 đồng/); assert.match(r, /số tiền 1,/); assert.doesNotMatch(r, /Số tiền không thấy/);
  // no source at all, but everything computed → at most TRUNG BÌNH (never CAO)
  const S2 = { sessionID: 'calc-only-' + Date.now() };
  await c.eval.execute({ expression: '65.000 × 25.641' }, S2);
  r = await g.check.execute({ answer: 'Quy đổi: 65.000 USD × 25.641 = 1.666.665.000 VND (tính bằng công cụ).' }, S2);
  assert.match(r, /ĐỘ TIN CẬY \(tính từ bằng chứng\): TRUNG BÌNH/, r); assert.match(r, /chỉ có kết quả tính bằng công cụ/);
  r = await g.check.execute({ answer: 'Quy đổi: 65.000 USD × 25.641 = 1.666.000.000 VND.' }, S2);
  assert.match(r, /- 1\.666\.000\.000 VND/);
  ok('765,75 USD accepted as "tính bằng công cụ", invented 812,40 USD / 37,5% rejected, document amounts accepted, calc-only answers ≤ TRUNG BÌNH');
}
console.log('ALL PASSED');
