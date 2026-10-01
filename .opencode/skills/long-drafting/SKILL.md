---
name: long-drafting
description: Soạn văn bản DÀI / CHI TIẾT (hợp đồng nhiều Điều và phụ lục, báo cáo dài) theo quy trình nhóm soạn thảo – lập dàn ý → soạn song song từng Điều → rà soát chéo → sửa → ghép thành tệp – bằng các công cụ draft_plan, draft_write, draft_check, draft_fix, draft_assemble (draft_status để xem lại). Dùng khi văn bản dự kiến > ~8 Điều hoặc > ~2.500 từ, người dùng yêu cầu "chi tiết / đầy đủ / dài", hoặc có nhiều phụ lục; văn bản ngắn vẫn dùng document_create.
---

# Soạn văn bản dài theo nhóm (long-drafting)

## Khi nào dùng
- Hợp đồng / văn bản dự kiến **> ~8 Điều** hoặc **> ~2.500 từ**; người dùng nói "chi tiết", "đầy đủ", "dài", "khoảng 20–30 điều"; hoặc có **từ 2 phụ lục** trở lên (danh mục hàng, bảng giá, chỉ tiêu, biểu mẫu…).
- Báo cáo rà soát / nghiên cứu dài nhiều mục (`kind="bao-cao"`).
- Văn bản ngắn (thư, phụ lục lẻ, hợp đồng ≤ 8 Điều) → soạn trực tiếp và gọi `document_create` như skill `contract-review`.
- Sửa văn bản đã có mã tài liệu → **không** dùng skill này; dùng `document_read` → `document_edit`.

## Quy trình (bắt buộc theo thứ tự)
1. **Làm rõ** (skill `clarify`): bên người dùng, loại hợp đồng, ngôn ngữ (vi / en / song ngữ), luật áp dụng khi có bên nước ngoài, các thông số thương mại đã có (hàng hóa, khu vực, thời hạn, mức phạt, thời hạn thanh toán…). Thiếu nhưng có mặc định hợp lý thì dùng mặc định và nói rõ đã giả định gì.
2. **Tra cứu căn cứ** (skill `legal-research`): mở bằng `vbpl_article` **đúng các Điều** sẽ dùng cho điều khoản chủ yếu (VD Luật Thương mại 2005: Điều 24, 50, 57, 62, 169, 171–177 đại lý, 300–303 phạt / bồi thường, 294–295 miễn trách, 306 lãi chậm trả, 310–312; Bộ luật Dân sự 2015: Điều 156 bất khả kháng…). Mỗi lần mở một Điều, toàn văn văn bản được ghi vào bằng chứng của phiên – đó là **bộ căn cứ** mà người soạn được phép dẫn.
3. **`draft_plan`**: truyền dàn ý đầy đủ theo thứ tự (Điều 1..N rồi Phụ lục 1..M, ≤ 40 mục):
   - `sections[]`: `key` (chữ thường không dấu, duy nhất), `heading` (tên Điều; có thể kèm số đúng thứ tự), `purpose`, `must_include[]` (các nội dung bắt buộc – **không được rỗng** với điều khoản chủ yếu), `legal_basis_urls[]` dạng `"https://vbpl.vn/… Điều 301"` (chỉ các Điều đã mở).
   - `glossary[]` (thuật ngữ viết hoa đúng như sẽ dùng, VD "Sản Phẩm", "Khu Vực"), `parties[]` (role, name_placeholder – mặc định Bên A, Bên B), `facts{}` (các con số / thông số đã thống nhất), `user_side`, `style.detail` ("chuẩn" | "chi tiết" | "rất chi tiết"), `language`, `title_en` (song ngữ).
   - Điều 1 thường là "Giải thích từ ngữ"; điều khoản chung / hiệu lực ở cuối; phụ lục sau cùng.
   - Công cụ báo lỗi (trùng key, sai số thứ tự, thiếu must_include, căn cứ chưa mở…) → sửa rồi gọi lại. Lưu ý "chưa được mở" → mở Điều đó bằng `vbpl_article` rồi lập lại dàn ý.
4. **`draft_write({draftId})`**: soạn song song (mặc định 4 mục cùng lúc; điều Giải thích từ ngữ được soạn trước để các điều khác dùng đúng thuật ngữ). Mục lỗi → gọi lại với `sections:[key…]`.
5. **`draft_check({draftId})`**: kiểm tra bằng máy + hai lượt thẩm định. **Không còn lỗi → công cụ TỰ GHÉP thành tài liệu** (trả về thẻ tài liệu) – sang bước 8. Còn lỗi → bước 6.
6. **`draft_fix({draftId})`**: sửa mọi lỗi + cảnh báo (hoặc `issues:[mã]` để chọn; bỏ mục thẩm định không đúng / có lợi cho bên kia) rồi **TỰ GHÉP thành tài liệu**. Đã hết lỗi thì không gọi draft_fix để sửa cảnh báo, trừ khi người dùng yêu cầu – nêu cảnh báo trong câu trả lời.
7. **`draft_assemble({draftId})`**: chỉ khi cần ghép lại (VD sau khi viết lại mục bằng draft_write) hoặc bước trước báo lỗi ghép; ghép lại = phiên bản mới của cùng tài liệu. Hợp đồng có số tiền → chạy thêm `calc_contract_check(id)` (skill `calculation`).
8. **Trả lời ngắn** (không chép lại văn bản): cấu trúc (số Điều / Phụ lục, các nhóm nội dung), 3–6 điểm chính bảo vệ bên người dùng, các chỗ cần điền "…" và điểm **[cần thương lượng]**, căn cứ pháp lý chính (tên văn bản, Điều, link đã mở), cảnh báo còn lại từ `draft_assemble`, cách sửa tiếp (`document_edit` với mã tài liệu). Chạy **`grounding_check`** trên câu trả lời theo skill `citation-check` (căn cứ trong văn bản đã được `draft_check` đối chiếu với bộ căn cứ).

## Lưu ý
- **Luôn làm theo dòng `BƯỚC TIẾP THEO` ở cuối kết quả mỗi công cụ draft_***; không kết thúc lượt khi chưa có thẻ tài liệu (mã tài liệu). Bản nháp chưa ghép KHÔNG đọc / sửa được bằng document_read / document_edit.
- Không tự soạn toàn văn trong câu trả lời rồi mới gọi công cụ – nội dung các Điều do `draft_write` soạn.
- Mỗi bước trả về hướng dẫn "Bước tiếp theo"; nếu phiên bị gián đoạn, dùng `draft_status({draftId})` để xem tiến độ và làm tiếp.
- Song ngữ: `language="bilingual"`, đặt `heading_en` cho từng mục và `en` cho thuật ngữ; bản tiếng Việt ưu tiên trừ khi người dùng muốn khác (`prevailing`). Điều khoản ngôn ngữ được thêm tự động khi ghép.
- Mức phạt vi phạm hợp đồng thương mại ≤ 8% (Điều 301 LTM) – công cụ kiểm tra; con số khác (lãi, tổng tiền) tính bằng `calc_*`, không tự nhẩm.
