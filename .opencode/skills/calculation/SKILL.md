---
name: calculation
description: BẮT BUỘC cho mọi con số tự tính – cộng/nhân số tiền, thuế GTGT, tổng hợp đồng, tiền lãi chậm trả, tiền phạt vi phạm, quy đổi ngoại tệ, số tiền bằng chữ, soát số liệu hợp đồng – bằng công cụ calc_* / fx_* (số thập phân chính xác, ghi nhận để grounding_check đối chiếu); không bao giờ tự nhẩm, không tự đoán tỷ giá hay lãi suất.
---

# Tính toán bằng công cụ

## 1. Nguyên tắc
- **Không tự nhẩm bất kỳ phép tính nào** có kết quả đưa vào câu trả lời hoặc tài liệu (kể cả phép cộng hai số, nhân phần trăm, làm tròn). Mọi con số tự tính phải do công cụ dưới đây tạo ra – `grounding_check` chỉ chấp nhận con số / số tiền có trong nguồn đã tra, trong tài liệu của người dùng, hoặc do các công cụ này tính trong phiên (báo "tính bằng công cụ"); số tự nhẩm bị đánh dấu **chưa có căn cứ**.
- Khi trả lời: nêu **công thức + các giá trị đầu vào + kết quả** đúng như công cụ trả về (VD "65.000 USD × 10% × 43/365 = 765,75 USD – tính bằng công cụ"), đơn vị tiền, cách làm tròn. Không làm tròn lại khác công cụ.
- **Không tự chọn / đoán** lãi suất, tỷ giá, mức thuế: lãi suất lấy từ hợp đồng hoặc người dùng (thiếu thì hỏi – skill `clarify`); tỷ giá lấy bằng `fx_rate`; mức thuế lấy từ văn bản chính thức (skill `trade-remedy-lookup`).
- Mức trần pháp lý công cụ nhắc tới (phạt 8% – Điều 301 LTM 2005; lãi vay 20%/năm – Điều 468 BLDS 2015; lãi chậm trả – Điều 306 LTM, Điều 357 BLDS) chỉ là **gợi ý**: chỉ nêu trong câu trả lời **sau khi đã mở điều luật bằng `vbpl_find` → `vbpl_article`** (tình trạng hiệu lực, trích nguyên văn) theo skill `legal-research`.

## 2. Công cụ
| Việc | Công cụ | Ghi chú |
|---|---|---|
| Phép tính bất kỳ (tổng, thuế, chênh lệch, tỷ lệ, tiền ký quỹ = mức thuế × trị giá) | `calc_eval(expression, vars?, round?, locale?)` | Số kiểu Việt `1.250.000`, `12,5%` hoặc Anh `1,250,000.50`; đối số hàm cách nhau bằng `;` hoặc `, `; `round`: `vnd` (đến đồng), `usd`/`eur` (2 số lẻ), `0`…`12`. Số mơ hồ `65.000` / `1,250` → công cụ hiểu là hàng nghìn và báo lưu ý; số thập phân kiểu Anh thì truyền `locale="en"`. |
| Tiền lãi chậm trả / lãi vay | `calc_interest(principal, rate_percent, rate_basis?, from, to?, day_count?, compounding?, kind="late_payment"\|"loan")` | Số ngày tính như `clock_calc` (không tính ngày đầu, tính ngày cuối); mặc định actual/365, lãi đơn. Lãi nhập gốc chỉ khi hợp đồng thỏa thuận. |
| Tiền phạt vi phạm | `calc_interest(kind="penalty", rate_percent, breached_value)` | = tỷ lệ × giá trị phần nghĩa vụ bị vi phạm. |
| Số tiền bằng chữ | `calc_money_words(amount, currency, lang)` | Mọi "(Bằng chữ: …)" / "(in words: …)" trong hợp đồng, thư đòi nợ. |
| Soát một "bằng chữ" có sẵn | `calc_check_words(number_text, words_text)` | Báo KHỚP / KHÔNG KHỚP và cách viết đúng. |
| Soát toàn bộ số liệu hợp đồng | `calc_contract_check(id \| text)` | Bảng giá, VAT, tổng, lịch thanh toán, đặt cọc, bằng chữ, phạt > 8%, lãi > 20%/năm, trộn tiền tệ, "…" chưa điền, lệch số giữa bản Việt và bản Anh. |
| Tỷ giá | `fx_rate(currency, date?, source?)` | NHNN (tỷ giá trung tâm USD theo ngày; tỷ giá tham khảo và tính chéo tính thuế của ngày hiện hành) + Vietcombank (mua tiền mặt / mua chuyển khoản / bán). |
| Quy đổi ngoại tệ | `fx_convert(amount, from, to, date?, source?, rate_type?)` | Không tự nhân số tiền với tỷ giá. |

## 3. Tỷ giá
- Luôn ghi **nguồn** (NHNN – tỷ giá trung tâm, hay Vietcombank – mua chuyển khoản / bán…), **ngày của tỷ giá** (ngày công cụ trả về – ngày nghỉ thì là bảng gần nhất trước đó) và ghi chú "**tỷ giá tham khảo**". Kết quả theo hai nguồn khác nhau thì nêu cả hai hoặc nói rõ đang dùng nguồn nào.
- Tỷ giá áp dụng thật sự (thanh toán, hải quan, kế toán) theo thỏa thuận / ngân hàng thực hiện / quy định chuyên ngành – không khẳng định loại tỷ giá bắt buộc khi chưa tra căn cứ.
- Công cụ không lấy được tỷ giá → nói rõ, đề nghị người dùng cung cấp tỷ giá áp dụng; **không** dùng tỷ giá theo trí nhớ.

## 4. Mẫu trình bày
```
Tiền lãi chậm trả (tính bằng công cụ): 65.000 USD × 10%/năm × 43 ngày / 365 = 765,75 USD
(15/08/2026 → 27/09/2026 = 43 ngày; lãi suất 10%/năm theo thông tin bạn cung cấp).
Quy đổi (tỷ giá tham khảo – tỷ giá trung tâm NHNN ngày 26/09/2026: 25.641 VND/USD): 765,75 USD ≈ 19.634.596 VND.
```
Sau đó chạy `citation-check` như thường lệ.
