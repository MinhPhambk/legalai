---
name: company-lookup
description: Tra cứu / thẩm định doanh nghiệp đối tác theo mã số thuế (MST, mã số doanh nghiệp) hoặc tên bằng company_lookup / company_verify – nguồn chính thức trước (Cổng thông tin quốc gia về đăng ký doanh nghiệp, Cục Thuế; có CAPTCHA → link + bước tự tra), trang tổng hợp chỉ để tham khảo có đối chiếu chéo và nhãn "không chính thức"; kiểm tra MST, tình trạng hoạt động, người đại diện, địa chỉ; đối chiếu thông tin bên ký hợp đồng và trình bày điểm lệch như rủi ro.
---

# Tra cứu & đối chiếu doanh nghiệp

## Khi nào dùng
- Soạn / rà soát hợp đồng có **MST hoặc tên của đối tác** (bước nhận diện các bên – skill `contract-review`).
- Người dùng hỏi về một công ty: "MST … còn hoạt động không?", "người đại diện là ai?", "tên đúng của công ty …?", "MST này có đúng không?".

## Nguyên tắc bắt buộc
1. **Nguồn chính thức trước**: Cổng thông tin quốc gia về đăng ký doanh nghiệp (dangkykinhdoanh.gov.vn / dichvuthongtin.dkkd.gov.vn / bocaodientu.dkkd.gov.vn) và Cục Thuế (tracuunnt.gdt.gov.vn) – luôn đưa link + bước tự tra.
   **Trang tổng hợp = chỉ tham khảo** (công cụ tự lấy infodoanhnghiep.com, doanhnghiep.biz – tuân thủ robots.txt, không vượt chặn bot): MỖI thông tin từ đây phải kèm nhãn "⚠ Nguồn không chính thức (tổng hợp từ Cổng ĐKDN) – có thể chậm cập nhật; xác nhận trên cổng chính thức trước khi ký hợp đồng" (một lần trên danh sách / bảng là đủ) và tên nguồn; độ tin cậy tối đa **TRUNG BÌNH**. Các nguồn **không thống nhất** (bảng "ĐỐI CHIẾU CHÉO") → nêu cả hai giá trị, **không tự chọn**, yêu cầu xác nhận chính thức. Không tự `web_read` trang tổng hợp khác để thay thế (link trang tổng hợp có MST tự chuyển sang `company_lookup`).
2. **Không nêu theo trí nhớ** tên, tình trạng, người đại diện, địa chỉ, ngày thành lập của doanh nghiệp – kể cả doanh nghiệp nổi tiếng.
3. **Các nguồn chính thức đều yêu cầu mã xác thực (CAPTCHA)** – công cụ không bao giờ tự giải / vượt CAPTCHA.
   - **Trên giao diện web** (mặc định): `company_lookup` / `company_verify` với MST tự mở trang chính thức trong một khung trợ giúp; **người dùng tự** nhập mã xác nhận (Cục Thuế) hoặc tích reCAPTCHA (Cổng ĐKDN, `assist_source="dkkd"`) rồi bấm tra cứu, công cụ đọc trang kết quả. Kết quả có "XÁC MINH TRÊN NGUỒN CHÍNH THỨC" → trình bày là **thông tin chính thức** (tên cổng + link + ngày tra cứu), mở đầu bằng **một câu ngắn**: trang chính thức cần một bước xác minh người thật và người dùng đã hoàn tất. Không gọi lại chỉ để "xác minh thêm" – mỗi lần gọi là một lần làm phiền người dùng.
   - Người dùng huỷ / hết giờ / trang báo không tìm thấy (dòng "Đã mời người dùng tự xác minh … nhưng …") → nói ngắn gọn bước xác minh chưa hoàn tất, dùng phần còn lại của kết quả như trước (nguồn tham khảo có nhãn "không chính thức" + link + các bước tự tra); chỉ gọi lại khi người dùng muốn thử lại.
   - CLI / `assist=false` / kết quả "Nguồn chính thức yêu cầu mã xác thực – không tra tự động": nói rõ điều đó, đưa **link chính thức + các bước** công cụ trả về (nhập MST / tên, tích reCAPTCHA hoặc nhập mã xác nhận), và mời người dùng **dán nội dung trang kết quả** để đối chiếu tiếp.
4. **MST hợp lệ về định dạng ≠ doanh nghiệp tồn tại / đang hoạt động** – chỉ là kiểm tra chữ số kiểm tra.
5. **Riêng tư**: chỉ xử lý dữ liệu của doanh nghiệp. Người đại diện: **chỉ họ tên**. Không nêu, không hỏi số CCCD/CMND/hộ chiếu, ngày sinh, địa chỉ, số điện thoại, e-mail của cá nhân (công cụ tự bỏ nếu có trong nội dung dán). MST 12 số (số định danh cá nhân) → không tra.

## Công cụ
| Việc | Gọi |
|---|---|
| Kiểm tra MST + nguồn chính thức (web: người dùng tự xác minh CAPTCHA trong khung trợ giúp; CLI: link + bước tự tra) + tham khảo ≥ 2 trang tổng hợp có đối chiếu chéo | `company_lookup(tax_code="0123456789" \| "0123456789-001")` |
| Cần người đại diện theo pháp luật / loại hình / ngành nghề từ Cổng ĐKDN (reCAPTCHA) | `company_lookup(tax_code, assist_source="dkkd")` |
| Không có MST | `company_lookup(name="<tên doanh nghiệp>")` → danh sách MST gợi ý (không chính thức) → hỏi người dùng chọn → `company_lookup(tax_code)` |
| Người dùng đã dán nội dung trang kết quả chính thức | `company_lookup(tax_code, official_text=<nội dung dán>)` → bản tóm tắt có cấu trúc |
| Đối chiếu bên ký hợp đồng | `company_verify(tax_code, expected_name, expected_address, expected_representative, official_text?)` |

`company_verify` **không cần** `official_text` để phát hiện: MST sai chữ số kiểm tra, tên thiếu loại hình (TNHH / cổ phần…), MST 13 số của chi nhánh (đơn vị phụ thuộc ký hợp đồng). Có `official_text` thì so từng mục với hồ sơ chính thức (chuẩn hóa dấu, viết tắt TNHH / CP / MTV / "Công ty cổ phần", P./Q./TP.) → KHỚP / GẦN KHỚP / KHÔNG KHỚP. Không có `official_text` → so với các trang tổng hợp (kết quả ghi "ĐỐI CHIẾU VỚI NGUỒN KHÔNG CHÍNH THỨC"; khớp nguồn này nhưng lệch nguồn kia → GẦN KHỚP / CHƯA RÕ): trình bày là **kết quả sơ bộ**, khuyến nghị xác nhận trên cổng chính thức trước khi ký.

## Trình bày
- **Tra cứu**: MST (hợp lệ / không hợp lệ); nguồn chính thức cần tra thủ công (link + bước); thông tin tham khảo từ trang tổng hợp dưới nhãn "Nguồn không chính thức" kèm tên nguồn, mục thống nhất / không thống nhất; "Ngày tra cứu". Thông tin từ nội dung người dùng dán: ghi "theo thông tin người dùng sao chép từ <tên cổng> ngày …", không trình bày như công cụ đã tự xác minh.
- **Đối chiếu (thẩm định đối tác)**: bảng Mục | Theo hợp đồng | Theo nguồn chính thức | Kết quả. Mỗi điểm lệch là **rủi ro** trong báo cáo rà soát (mục "Thông tin các bên"), kèm việc cần làm:
  - Tên khác / khác loại hình → có thể là pháp nhân khác: yêu cầu sửa đúng tên theo Giấy chứng nhận ĐKDN (rủi ro 4–5 nếu khác loại hình hoặc khác tên riêng).
  - Địa chỉ khác → yêu cầu ghi địa chỉ trụ sở theo đăng ký hiện hành (lưu ý sắp xếp đơn vị hành chính từ 01/7/2025); khác số nhà → rủi ro 3.
  - Người ký ≠ người đại diện theo pháp luật → yêu cầu giấy ủy quyền hợp lệ; ghi rõ căn cứ đại diện trong phần thông tin các bên.
  - Tình trạng khác "đang hoạt động" (tạm ngừng, không hoạt động tại địa chỉ đăng ký, đang giải thể, đã giải thể, chấm dứt hiệu lực MST…) → rủi ro 5: khuyến nghị **không ký / tạm dừng** đến khi làm rõ.
  - MST sai / MST chi nhánh → yêu cầu xác nhận lại; hợp đồng đứng tên doanh nghiệp, chi nhánh ký theo ủy quyền.
- Cần nêu điều luật (tư cách pháp nhân của chi nhánh, tạm ngừng kinh doanh, đại diện theo ủy quyền…) → tra bằng `legal-research`, không trích theo trí nhớ. Kết thúc bằng `citation-check`.
