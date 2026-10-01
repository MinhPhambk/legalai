---
name: contract-review
description: Rà soát, soạn thảo, sửa hợp đồng thương mại – tách điều khoản, chấm rủi ro 5 mức, chỉ ra vấn đề pháp lý kèm căn cứ tra cứu trực tiếp, gợi ý sửa, và lập bảng nghĩa vụ – thời hạn để nhắc việc khi thực hiện hợp đồng.
---

# Rà soát hợp đồng

## Đầu vào
Tệp hợp đồng trong thư mục làm việc (.md, .txt, .docx đã chuyển sang văn bản, .pdf có lớp chữ). Hỏi người dùng nếu chưa rõ: **doanh nghiệp đứng ở bên nào** (bán/mua, bên cung ứng/bên thuê dịch vụ…), loại hợp đồng, luật áp dụng dự kiến.

### Hỏi lại người dùng
Thiếu **bên của người dùng**, **loại hợp đồng**, **ngôn ngữ** (vi / en / song ngữ) hoặc **luật áp dụng** (khi có bên nước ngoài) mà không mặc định hợp lý được → **gọi ngay công cụ `question`** (gộp tối đa 3 câu hỏi trong một lần gọi, có lựa chọn; quy tắc chi tiết ở skill `clarify`) – **không** tự viết câu hỏi thành văn bản rồi dừng; chỉ khi lệnh gọi báo công cụ không tồn tại mới hỏi bằng danh sách đánh số cuối câu trả lời. Không hỏi điều tra cứu được hay dữ liệu định danh; có câu trả lời thì làm tiếp, không hỏi lại.

## Các bước
1. **Nhận diện**: loại hợp đồng (mua bán hàng hóa nội địa/quốc tế, dịch vụ, đại lý, phân phối, vận chuyển, khác), các bên, luật áp dụng, cơ quan giải quyết tranh chấp.
   **Thẩm định các bên**: bên là doanh nghiệp Việt Nam có MST / tên → skill `company-lookup`: `company_verify(tax_code, expected_name, expected_address, expected_representative)` (cổng chính thức yêu cầu CAPTCHA → đưa link + bước để người dùng tự tra và dán kết quả vào `official_text`; chưa có thì công cụ đối chiếu với trang tổng hợp KHÔNG chính thức – ghi rõ "đối chiếu với nguồn không chính thức", phải xác nhận trên cổng chính thức trước khi ký); mọi điểm lệch (tên / loại hình, địa chỉ, người ký ≠ người đại diện theo pháp luật, tình trạng khác "đang hoạt động", MST sai / MST chi nhánh) ghi thành rủi ro ở mục thông tin các bên.
2. **Tách điều khoản** theo Điều/khoản của hợp đồng.
3. **Kiểm tra điều khoản thiếu** so với nội dung chủ yếu của loại hợp đồng đó (VD mua bán: đối tượng, số lượng, chất lượng, giá, thanh toán, giao nhận, chuyển rủi ro, kiểm tra hàng, vi phạm & chế tài, bất khả kháng, giải quyết tranh chấp, luật áp dụng).
4. **Chấm từng điều khoản**:
   - Mức rủi ro **1–5** = khả năng xảy ra (1–5) × mức ảnh hưởng (1–5), quy đổi: 1–4 → 1, 5–8 → 2, 9–12 → 3, 15–16 → 4, 20–25 → 5; điều khoản vô hiệu/trái điều cấm → 5.
   - Vấn đề: mất cân bằng quyền nghĩa vụ, ngôn ngữ mơ hồ, trái luật / vô hiệu, mức phạt vượt giới hạn luật định, thời hạn không rõ, thanh toán rủi ro, không rõ thời điểm chuyển rủi ro, loại trừ trách nhiệm quá rộng, cơ quan giải quyết tranh chấp không rõ, xung đột luật áp dụng, rủi ro tỷ giá, rủi ro tuân thủ xuất nhập khẩu.
   - **Căn cứ pháp lý: tra cứu bằng skill `legal-research`** (không trích theo trí nhớ).
   - Gợi ý sửa: viết lại điều khoản bảo vệ bên người dùng, vẫn cân bằng để đối tác có thể chấp nhận.
   - **Số liệu (bắt buộc khi hợp đồng có số tiền)**: chạy `calc_contract_check(id | text)` – bảng hàng hóa (số lượng × đơn giá, cộng, thuế GTGT, tổng cộng), giá trị hợp đồng, lịch thanh toán (tổng 100%, số tiền từng đợt), đặt cọc, mọi "(Bằng chữ: …)", phạt > 8%, lãi > 20%/năm, trộn VND/USD không có điều khoản tỷ giá, số tiền "…" chưa điền, và (song ngữ) số lệch giữa bản Việt – bản Anh. Đưa từng **lỗi** vào bảng điều khoản (rủi ro ≥ 3) kèm con số đúng do công cụ tính; mức trần pháp lý công cụ gợi ý chỉ nêu sau khi tra bằng `vbpl_article`. Phép tính khác (tiền phạt, lãi chậm trả, quy đổi) → skill `calculation`.
5. **Bảng nghĩa vụ – thời hạn** (phục vụ nhắc việc): mỗi dòng = bên phải làm, việc phải làm, loại thời hạn (ngày cố định / tương đối / gắn với sự kiện / định kỳ / không có), mô tả thời hạn, sự kiện kích hoạt, hậu quả nếu vi phạm.
6. **Soạn thảo** (khi được yêu cầu): hợp đồng DÀI / chi tiết (> ~8 Điều hoặc > ~2.500 từ, người dùng yêu cầu "chi tiết / đầy đủ", nhiều phụ lục) → làm theo skill `long-drafting` (draft_plan → draft_write → draft_check → draft_fix → draft_assemble thay cho bước 6–7 dưới đây, sau khi tra căn cứ); hợp đồng ngắn: xác định loại hợp đồng và **bên người dùng đại diện**; tra căn cứ cho các điều khoản chủ yếu (đối tượng, giá, thanh toán, giao nhận, chuyển rủi ro, chất lượng/kiểm tra, độc quyền/khu vực, chỉ tiêu, phạt vi phạm ≤ 8% theo Điều 301 LTM, bồi thường, bất khả kháng, chấm dứt, luật áp dụng, giải quyết tranh chấp) bằng `legal-research`; soạn đầy đủ từng Điều, để trống bằng "…" các thông tin chưa có (tên, địa chỉ, MST, số tiền) và đánh dấu **[cần thương lượng]** ở điểm có lựa chọn.
   **Số tiền trong bản soạn**: mọi thành tiền, tổng, thuế GTGT, số tiền từng đợt / đặt cọc tính bằng `calc_eval` (không tự nhẩm); mọi "(Bằng chữ: …)" viết bằng `calc_money_words` (song ngữ: `lang="vi"` cho bản Việt, `lang="en"` cho "(in words: …)" bản Anh). **Trước khi gọi `document_create` / `document_edit`**: chạy `calc_contract_check(text=<markdown>)` (song ngữ: kèm `text_en=<bản tiếng Anh>`) trên bản nháp, sửa hết **lỗi** rồi mới tạo / sửa tệp; sau khi tạo, có thể chạy lại `calc_contract_check(id)` để xác nhận.
   **Ngôn ngữ hợp đồng**: theo yêu cầu người dùng – tiếng Việt (mặc định), tiếng Anh, hoặc **song ngữ Việt – Anh**. Chưa nói rõ mà có bên nước ngoài / mua bán hàng hóa quốc tế → đề xuất song ngữ (thông lệ tại Việt Nam), bản tiếng Việt ưu tiên trừ khi người dùng muốn khác. Soạn tiếng Anh / song ngữ theo skill `legal-translation` (văn phong "shall", "the Parties", bảng thuật ngữ); bản song ngữ: viết bản tiếng Việt trước, rồi bản tiếng Anh **cùng cấu trúc** – cùng số Điều, cùng thứ tự khoản/đoạn (mỗi khoản tiếng Việt ↔ đúng một khoản tiếng Anh), "## Điều 5. …" ↔ "## Article 5. …". Không tự viết điều khoản ngôn ngữ – công cụ tự thêm. Căn cứ pháp lý trong câu trả lời tiếng Anh: trích nguyên văn tiếng Việt + "(unofficial translation: …)".
7. **Xuất tệp**: (văn bản soạn bằng `long-drafting` đã có tệp từ `draft_assemble` – không gọi `document_create` nữa) soạn xong hợp đồng MỚI → gọi `document_create(kind="hop-dong", sign_a="ĐẠI DIỆN BÊN A", sign_b="ĐẠI DIỆN BÊN B")` (tiếng Anh: thêm `language="en"`, nhãn ký tự đổi thành "FOR AND ON BEHALF OF PARTY A/B"; song ngữ: `language="bilingual", markdown=<bản tiếng Việt>, markdown_en=<bản tiếng Anh>`, tùy chọn `prevailing="en"`; nếu công cụ báo cấu trúc hai bản không khớp thì sửa đúng các tiêu đề được liệt kê rồi gọi lại – chưa có tệp nào được tạo); báo cáo rà soát dài → `document_create(kind="bao-cao")`. Kết quả có **mã tài liệu** – dùng mã này cho mọi lần sửa sau. Tài liệu đã có (đã tạo trước đó hoặc người dùng tải lên) thì **không** gọi lại `document_create` – xem mục "Sửa tài liệu đã có". Trong câu trả lời chỉ tóm tắt cấu trúc, các điểm cần điền/thương lượng và căn cứ chính, **không** chép lại toàn bộ văn bản.

## Sửa tài liệu đã có
Áp dụng khi người dùng muốn đổi "chỗ này chỗ kia" trong một tài liệu đã có – tài liệu trợ lý đã tạo trong cuộc trò chuyện, hoặc tệp người dùng tải lên (trong tin nhắn có dòng `mã tài liệu: <id>`).
1. **Luôn** `document_read(id)` trước (tài liệu dài: `document_read(id, section="Điều 5")`) để thấy nguyên văn và cấu trúc Điều/khoản. Dùng mã của **phiên bản mới nhất** (kết quả lần sửa gần nhất).
2. Gọi `document_edit(id, edits=[…], note)` với các thay đổi **nhỏ nhất, đúng chỗ**:
   - sửa câu/cụm từ: `{op:"replace", find:"<nguyên văn, duy nhất>", text:"<nội dung mới>"}`;
   - thêm khoản/đoạn: `{op:"insert_after", find:"<trọn dòng khoản đứng trước>", text:"3. …"}` (đánh số lại các khoản sau bằng thêm `replace` nếu cần) hoặc `{op:"insert_after", section:"Điều 5", text:"## Điều 6. …"}`;
   - xóa: `{op:"delete", find:"…"}` hoặc `{op:"delete", section:"Điều 7"}` / `section:"Điều 5 khoản 2"`;
   - viết lại cả một Điều chỉ khi người dùng yêu cầu: `{op:"replace_section", section:"Điều 5", text:"…"}`.
   - **tài liệu song ngữ** (`document_read` hiện [VI] và [EN]): sửa nội dung thì sửa **cả hai bản** trong cùng lần gọi – `{op:"replace", lang:"both", find:"<tiếng Việt>", text:"…", find_en:"<tiếng Anh>", text_en:"…"}`; xóa / chèn cả Điều theo `section` áp dụng cho cả hai (chèn cần `text` + `text_en`); chỉ sửa một bản (`lang:"vi"` hoặc `"en"`) khi đó là lỗi dịch / chính tả của riêng bản đó. Công cụ báo **CẢNH BÁO song ngữ** nếu một bản chưa được cập nhật – phải sửa tiếp bản còn lại.
   `find` phải chép **nguyên văn** từ `document_read` (không kèm số dòng), đủ dài để duy nhất. Nếu công cụ báo không tìm thấy / khớp nhiều chỗ thì **chưa có gì được lưu** – đọc đoạn gợi ý, sửa `find` rồi gọi lại.
3. **Không bao giờ** tạo lại cả văn bản bằng `document_create` chỉ để sửa vài chỗ, và không chép lại toàn văn vào câu trả lời.
4. Thay đổi có nội dung pháp lý (mức phạt, thời hạn, lãi chậm trả, chuyển rủi ro, luật áp dụng, giải quyết tranh chấp…) vẫn phải tra căn cứ bằng `legal-research` trước khi sửa và chạy `citation-check` trước khi trả lời. Sửa thuần câu chữ/thông tin các bên thì không cần tra cứu.
   Sửa **số tiền / số lượng / đơn giá / tỷ lệ** → tính lại mọi con số phụ thuộc (thành tiền, tổng, VAT, đợt thanh toán, bằng chữ – ở cả hai bản nếu song ngữ) bằng `calc_eval` / `calc_money_words`, đưa tất cả vào cùng một lần `document_edit`, rồi chạy `calc_contract_check(id=<mã mới>)`; còn lỗi thì sửa tiếp.
5. Trả lời: liệt kê ngắn từng chỗ đã sửa (Điều/khoản – trước → sau), căn cứ (nếu có), mã phiên bản mới, và nhắc người dùng tệp **DOCX theo dõi thay đổi** (Track Changes) để duyệt trong Word.

## Đầu ra – báo cáo (xuất tệp bằng `document_create(kind="bao-cao")`)
1. Tóm tắt: loại hợp đồng, bên người dùng, 3–5 rủi ro lớn nhất.
2. Bảng điều khoản: Điều | Loại | Rủi ro (1–5) | Vấn đề | Căn cứ (link) | Gợi ý sửa.
   Kèm mục **Soát số liệu** theo kết quả `calc_contract_check`: lỗi (vị trí – đúng – văn bản ghi), cảnh báo, các mục chưa điền.
3. Điều khoản còn thiếu.
4. Bảng nghĩa vụ – thời hạn.
5. Độ tin cậy + khuyến nghị tham vấn luật sư (theo `citation-check`).

Không đưa nội dung hợp đồng lên bất kỳ trang web nào.
