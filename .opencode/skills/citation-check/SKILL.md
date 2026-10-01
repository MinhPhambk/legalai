---
name: citation-check
description: Bước kiểm tra bắt buộc trước khi trả lời – chạy grounding_check (máy đối chiếu mọi link, trích dẫn, con số, số hiệu với nguồn đã tra trong phiên), sửa đến khi hết mục chưa có căn cứ, báo độ tin cậy do grounding_check tính, và chuyển chuyên gia bằng expert_escalate khi thuộc diện bắt buộc.
---

# Kiểm tra trích dẫn, độ tin cậy, chuyển chuyên gia

## 1. Đối chiếu bằng máy – `grounding_check` (bắt buộc)
1. Viết xong bản nháp câu trả lời → gọi `grounding_check(answer = toàn bộ bản nháp)`.
2. Với mỗi mục công cụ báo **chưa có căn cứ**:
   - Đoạn trích không có nguyên văn → lấy lại nguyên văn bằng công cụ, hoặc bỏ đoạn trích.
   - Link chưa mở → mở bằng công cụ tương ứng, hoặc bỏ link.
   - Con số / số tiền không có trong nguồn → **không tự tính, cộng, quy đổi trong đầu**: nếu đó là kết quả tính toán (tổng, thuế, lãi, tiền phạt, quy đổi ngoại tệ, số tiền bằng chữ) thì tính lại bằng công cụ `calc_*` / `fx_convert` (skill `calculation`) và nêu công thức; nếu là số của văn bản (mức thuế, mức phạt luật định) thì chỉ nêu đúng con số có trong văn bản và ghi nguồn từng con số.
   - `grounding_check` liệt kê riêng mục **"Tính bằng công cụ"** (con số do calc_* / fx_convert tính trong phiên) và **"Số tiền lấy nguyên văn từ tài liệu của người dùng"** – các mục này hợp lệ; trong câu trả lời ghi rõ "(tính bằng công cụ)" cạnh con số tự tính. Số tiền để trống ("… đồng") không bị kiểm tra.
   - Số hiệu không thấy → kiểm tra lại bằng công cụ hoặc bỏ.
   - `grounding_check` báo **"→ BẮT BUỘC (vòng n/3): tra thêm bằng web_search → web_read …"** → làm đúng như vậy theo skill **`verify-unknown` (bắt buộc)**: tra các mục được liệt kê bằng công cụ chuyên dụng hoặc `web_search` → `web_read`, chỉ giữ nội dung đã đọc được; **không** tự sửa con số theo trí nhớ.
3. Gọi lại `grounding_check` trên bản đã sửa (tối đa 3 vòng). Mục nào vẫn không có căn cứ (hoặc công cụ báo đã hết 3 vòng) thì ghi rõ "Tôi chưa xác minh được …", chỉ nơi người dùng có thể kiểm tra và đề nghị chuyển chuyên gia – không đoán.
4. Không đưa **nhận định về thủ tục / thời hạn / nghĩa vụ** nếu không có đoạn trích làm căn cứ; nếu là suy luận của bạn, ghi rõ "(nhận định, chưa có căn cứ trực tiếp)".

Lấy lại nguyên văn theo nguồn:
- vbpl.vn → `vbpl_article` / `vbpl_verify(url, đoạn trích)` (chỉ giữ trích dẫn **KHỚP**).
- Federal Register → `fedreg_document(id)` (không mở lại federalregister.gov bằng Chrome – trang chặn truy cập tự động).
- trav.gov.vn → `trav_page(url)` / `trav_measures`.
- EUR-Lex / ePing / FTA / án lệ, bản án → công cụ `eurlex_*` / `eping_*` / `fta_*` / `court_*` tương ứng.
- Thứ tự: công cụ chuyên dụng ở trên TRƯỚC → `web_search` chỉ cho phần còn thiếu → `web_read` chỉ cho tên miền không có công cụ riêng (link của các nguồn trên được `web_read` tự chuyển sang công cụ chuyên dụng).
- Nguồn chưa có công cụ riêng: `web_search` → `web_read(url, focus)` (ghi nhận toàn văn cho `grounding_check`; nguồn không chính thức bị cảnh báo); chỉ khi không được mới dùng MCP `chrome` (`navigate_page` rồi `evaluate_script`) – nội dung đọc bằng MCP `chrome` **không** được `grounding_check` ghi nhận, nên độ tin cậy sẽ bị hạ.
- Luôn xác nhận **tình trạng hiệu lực** tại ngày tra cứu (văn bản / điều khoản chưa bị bãi bỏ, thay thế – dùng `vbpl_history` khi cần).

## 2. Độ tin cậy
- **Chỉ dùng mức do `grounding_check` trả về** (CAO / TRUNG BÌNH / THẤP) kèm lý do của nó — **không tự chấm, không nâng mức**.
- Được **hạ** mức nếu câu hỏi thiếu thông tin tình huống hoặc phải diễn giải nhiều (nói rõ lý do).

## 3. Chuyển chuyên gia – `expert_escalate`
**Bắt buộc gọi `expert_escalate`** (rồi báo mã yêu cầu cho người dùng) khi có ít nhất một điều:
- Độ tin cậy từ `grounding_check` là **THẤP** sau khi đã sửa.
- Đang có tranh chấp, sắp khởi kiện / trọng tài, hoặc cần đánh giá chứng cứ.
- Doanh nghiệp đang bị điều tra phòng vệ thương mại và có **hạn chót** (bản câu hỏi, rà soát…) trong vòng 30 ngày.
- Có dấu hiệu vi phạm hình sự / xử phạt hành chính.
- Người dùng yêu cầu gặp luật sư / chuyên gia.

**Nên đề nghị** (hỏi người dùng có muốn chuyển không, chưa gọi công cụ) khi: giá trị hợp đồng / tranh chấp lớn, yếu tố nước ngoài phức tạp (xung đột pháp luật, thi hành phán quyết nước ngoài), hoặc độ tin cậy TRUNG BÌNH ở điểm then chốt.

Tóm tắt gửi chuyên gia: bối cảnh, câu hỏi, những gì đã tra được (kèm căn cứ), điểm còn chưa chắc — không đưa thông tin cá nhân không cần thiết.

## 4. Mẫu kết thúc câu trả lời
```
Nguồn đã tra (DD/MM/YYYY): <danh sách link do công cụ trả về>
Độ tin cậy: <CAO|TRUNG BÌNH|THẤP> (tính từ bằng chứng) – <lý do từ grounding_check>
<Nếu đã chuyển> Đã chuyển chuyên gia: <mã yêu cầu> – <việc người dùng nên chuẩn bị>
<Nếu nên đề nghị> Bạn có muốn chuyển câu hỏi này cho chuyên gia pháp lý không?
Lưu ý: thông tin tham khảo, không thay thế tư vấn pháp lý chính thức.
```
