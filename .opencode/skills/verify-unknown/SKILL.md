---
name: verify-unknown
description: BẮT BUỘC khi không chắc / không biết / sắp trả lời theo trí nhớ, hoặc khi công cụ chuyên dụng không bao quát hay không trả về kết quả – thừa nhận là chưa có thông tin đã xác minh, tra trực tiếp trên nguồn chính thức bằng web_search → web_read, chỉ trả lời từ những gì đã đọc; không tìm được thì nói rõ "chưa xác minh được", chỉ nơi kiểm tra và đề nghị chuyển chuyên gia.
---

# Không biết thì nói không biết – và đi tra

## 1. Không trả lời theo trí nhớ
**Không bao giờ** nêu theo trí nhớ: điều luật / nội dung quy định, số hiệu văn bản, ngày ban hành / hiệu lực, mức thuế, mức phạt, lãi suất, tỷ giá, con số thống kê, thời hạn thủ tục, tên cơ quan có thẩm quyền. Mọi mục như vậy phải lấy từ nội dung công cụ đã mở trong phiên này.

## 2. Thứ tự tra cứu (bắt buộc)
1. **Công cụ chuyên dụng trước**: `vbpl_*` (văn bản pháp luật VN), `trav_*`, `fedreg_*`, `eurlex_*`, `eping_*`, `fta_*`, `court_*`, `tariff_*` (biểu thuế theo mã HS: VN / Hoa Kỳ / EU), `fx_rate`, `clock_*`, `calc_*`.
2. **`web_search` chỉ cho phần còn thiếu** (công cụ chuyên dụng không bao quát / không có kết quả).
3. **`web_read` chỉ cho tên miền không có công cụ chuyên dụng** – link vbpl.vn, toaan.gov.vn, trav.gov.vn, federalregister.gov / govinfo.gov, eur-lex, epingalert.org, trungtamwto.vn, trang tỷ giá SBV / Vietcombank được `web_read` tự chuyển sang công cụ tương ứng (hoặc báo công cụ cần gọi); kết quả `web_search` có dòng "→ mở bằng …" thì gọi đúng công cụ đó. Kết quả KHÔNG CHÍNH THỨC có số hiệu văn bản → mở văn bản gốc bằng `vbpl_find("<số hiệu>")` theo gợi ý của công cụ.

## 2b. Khi nào phải tra trên web
- Công cụ chuyên dụng không bao quát câu hỏi (VD hóa đơn điện tử, thủ tục hải quan, quy định mới của bộ ngành, thông tin trên cổng của cơ quan nước ngoài), **hoặc** đã gọi mà không có kết quả / lỗi;
- Bạn **không chắc** (định nói "có thể là", "khoảng", "theo tôi nhớ");
- `grounding_check` báo **BẮT BUỘC … tra thêm** (vòng 1–3).

Khi đó, **nói trước cho người dùng** (một câu, trong câu trả lời): "Tôi chưa có thông tin đã xác minh về … – đang tra cứu trên nguồn chính thức." rồi:
1. `web_search(query)` – từ khóa ngắn theo khái niệm pháp lý / tên văn bản / mã HS (không đưa tên doanh nghiệp, số tiền, nội dung hợp đồng); mặc định chỉ tìm nguồn chính thức; `lang="en"` cho nguồn quốc tế; `sites=[…]` để nhắm cơ quan cụ thể (VD `["customs.gov.vn","mof.gov.vn"]`).
2. `web_read(url, focus)` – mở **tối đa khoảng 6 trang**, ưu tiên kết quả **CHÍNH THỨC**, văn bản gốc (công báo, tệp PDF đính kèm) và bản **mới nhất**; `focus` = cụm từ cần tìm ("hiệu lực thi hành", "7208", "mức thuế"). Link vbpl.vn → dùng `vbpl_document` / `vbpl_article`.
3. Văn bản pháp luật tìm được: kiểm tra tình trạng hiệu lực (`vbpl_find` → `vbpl_document` / `vbpl_history`) khi có thể; văn bản đã bị sửa đổi / thay thế thì tìm văn bản mới.
4. Chỉ trả lời **từ nội dung đã đọc**, trích nguyên văn đoạn then chốt, ghi link + ngày truy cập; số liệu tự tính → skill `calculation`.
5. Chạy `grounding_check` (skill `citation-check`); còn mục chưa có căn cứ → tra tiếp (tối đa 3 vòng).

## 3. Nguồn không chính thức
`web_read` gắn nhãn **⚠ NGUỒN KHÔNG CHÍNH THỨC** (báo, blog, trang tư vấn, thư viện tổng hợp): chỉ dùng để định hướng tìm văn bản gốc; nếu buộc phải dùng thì ghi rõ "theo … (nguồn không chính thức, chưa đối chiếu văn bản gốc)" – độ tin cậy tối đa TRUNG BÌNH.

## 4. Tra không ra
Sau khi đã tra (hoặc `grounding_check` báo đã hết 3 vòng):
- Nói rõ: "**Tôi chưa xác minh được** … trên nguồn chính thức (đã tra: …)." – **không đoán**, không đưa con số "có thể là", không lấp bằng kiến thức chung.
- Chỉ **nơi người dùng có thể kiểm tra** (cơ quan / cổng thông tin cụ thể, VD Cổng Công báo, cơ quan hải quan, Cục Thuế, Cục Phòng vệ thương mại) hoặc **người nên hỏi** (luật sư, cơ quan quản lý).
- Đề nghị chuyển chuyên gia (`expert_escalate` theo skill `citation-check`).
- Kiến thức chung không thể tránh (định nghĩa, nguyên tắc chung) phải ghi rõ "**(kiến thức chung, chưa đối chiếu nguồn)**".

- Tra tối đa khoảng 6 lần `web_read` / 8 lần `web_search` cho một câu hỏi; hết lượt thì DỪNG tra và **luôn viết câu trả lời cuối cùng cho người dùng** (kết quả đã xác minh, hoặc "chưa xác minh được" theo mẫu dưới) – không kết thúc lượt bằng một lệnh gọi công cụ hay câu trả lời trống.

## 5. Mẫu
```
Tôi chưa có thông tin đã xác minh về <nội dung> – đang tra cứu trên nguồn chính thức.
… (kết quả, trích nguyên văn, link, ngày truy cập) …
<hoặc> Tôi chưa xác minh được <nội dung> trên nguồn chính thức (đã tra: <nguồn>). Bạn có thể kiểm tra tại <cơ quan / cổng>; nếu cần, tôi có thể chuyển câu hỏi cho chuyên gia.
```
