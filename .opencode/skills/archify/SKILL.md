---
name: archify
description: Vẽ sơ đồ bằng công cụ diagram_create (Archify JSON IR → SVG đã kiểm tra bố cục) – quy trình / thủ tục nhiều bên (khởi kiện, điều tra chống bán phá giá, giao kết – thực hiện hợp đồng), trình tự trao đổi (luồng thanh toán L/C, chứng từ), vòng đời trạng thái (hiệu lực hợp đồng, vụ việc), luồng hồ sơ (C/O, thủ tục hải quan), cơ cấu các bên. Có mẫu IR hợp lệ cho từng loại.
license: MIT (Archify 2.16.0 của tt-a1i, bản vendored đã rà soát – xem web/THIRD_PARTY_NOTICES.md)
---

# Sơ đồ Archify với `diagram_create`

Archify biên dịch một **JSON IR có kiểu** thành SVG một cách tất định và kiểm tra bố cục (không chồng chéo,
mũi tên vuông góc, nhãn không đè nút). Trên nền tảng này bạn KHÔNG chạy lệnh `archify` (không có shell): chỉ gọi
công cụ `diagram_create({type, ir, title, lang, caption?})`. Khi nào nên vẽ, đặt ở đâu, bao nhiêu hình: skill `visuals`.

## 1. Chọn loại
| Nội dung | type | Ví dụ pháp lý |
|---|---|---|
| Các bước do nhiều bên thực hiện, có nhánh (đạt / không đạt) | `workflow` | thủ tục khởi kiện, quy trình điều tra AD/CVD của DOC + ITC, giao kết → thực hiện → thanh lý hợp đồng |
| Thông điệp / chứng từ qua lại giữa các bên theo thứ tự thời gian | `sequence` | thanh toán L/C, nhờ thu D/P, khiếu nại – trả lời |
| Trạng thái và chuyển trạng thái | `lifecycle` | hiệu lực hợp đồng, tình trạng vụ việc / biện pháp |
| Hồ sơ đi qua các giai đoạn / cơ quan | `dataflow` | cấp C/O, thông quan, hồ sơ đăng ký |
| Cơ cấu các bên và quan hệ | `architecture` | chuỗi phân phối, công ty mẹ – con, bảo lãnh |
Mơ hồ → `workflow`. Mốc thời gian đơn thuần (timeline) → dùng khối ```mermaid `timeline` (skill `visuals`).

## 2. Quy tắc viết IR
- Không cần `schema_version`, `diagram_type` – công cụ tự điền. Không dùng `brand`, `animation`, `views`, `output`.
- **Nhãn bằng ngôn ngữ câu trả lời**, ngắn: `label` ≤ 4–5 từ ("Khởi xướng điều tra"), chi tiết / thời hạn vào `sublabel` ("20 ngày kể từ nộp đơn"), `tag` rất ngắn. Giữ nguyên tên riêng / viết tắt chính thức (DOC, ITC, L/C, C/O).
- `id` chỉ gồm chữ thường không dấu, số, `_` (VD `doc_prelim`). Mỗi `from` / `to` phải trỏ tới một `id` có thật.
- ≤ 12 nút chính, một đường chính rõ ràng; nhánh phụ ngắn. Bỏ cạnh ít giá trị thay vì thêm điều khiển đường đi.
- Không đặt toạ độ (`via`, `labelAt`, `channelX`…) trừ khi công cụ báo lỗi và gợi ý đúng giá trị đó.
- `type` của nút chỉ quyết định MÀU: `external` (bên ngoài: nguyên đơn, người mua), `frontend` (doanh nghiệp / bên tham gia), `backend` (cơ quan / bước xử lý), `security` (kiểm tra, quyết định, điều kiện), `database` (hồ sơ, kết quả, quyết định cuối), `messagebus` (thông báo, công bố), `cloud` (tổ chức quốc tế). lifecycle dùng `start | active | waiting | decision | success | failure | neutral | external`.
- Cạnh: `label` là nghĩa pháp lý ("khẳng định", "không đủ điều kiện"); nhánh lỗi: `"variant":"security","role":"error"`; nhấn mạnh: `"variant":"emphasis"`; trả về: `"variant":"dashed"` (sequence: `"return"`).
- Căn cứ pháp lý (điều, khoản, link) đặt trong **phần chữ** của câu trả lời, không chỉ trong sơ đồ. Mốc thời hạn trong sơ đồ phải khớp nguồn đã tra; tính ngày bằng `clock_calc`.

## 3. Mẫu IR (đã kiểm tra – thay nội dung bằng dữ kiện đã tra, không chép dữ kiện của mẫu)

### workflow – làn = các bên, `col` = thứ tự bước 0..5 (tối đa 6 cột; nhiều bước hơn → gộp bước hoặc cho hai bước cùng cột ở hai làn khác nhau)
```json
{"meta":{"title":"Thủ tục khởi kiện vụ án kinh doanh thương mại"},"lanes":[{"id":"nguyen_don","label":"Nguyên đơn"},{"id":"toa_an","label":"Tòa án"},{"id":"bi_don","label":"Bị đơn"}],"nodes":[{"id":"nop_don","lane":"nguyen_don","col":0,"type":"external","label":"Nộp đơn khởi kiện","sublabel":"kèm chứng cứ"},{"id":"xem_xet","lane":"toa_an","col":1,"type":"security","label":"Xem xét đơn","sublabel":"8 ngày làm việc"},{"id":"tam_ung","lane":"nguyen_don","col":2,"type":"frontend","label":"Nộp tạm ứng án phí","sublabel":"7 ngày"},{"id":"thu_ly","lane":"toa_an","col":3,"type":"backend","label":"Thụ lý vụ án"},{"id":"thong_bao","lane":"bi_don","col":4,"type":"messagebus","label":"Nhận thông báo","sublabel":"nộp ý kiến 15 ngày"},{"id":"hoa_giai","lane":"toa_an","col":5,"type":"database","label":"Hòa giải, xét xử"},{"id":"tra_lai","lane":"nguyen_don","col":1,"type":"security","label":"Trả lại đơn"}],"edges":[{"from":"nop_don","to":"xem_xet","label":"nộp"},{"from":"xem_xet","to":"tam_ung","label":"đủ điều kiện"},{"from":"xem_xet","to":"tra_lai","label":"không đủ","variant":"security","role":"error"},{"from":"tam_ung","to":"thu_ly","label":"biên lai"},{"from":"thu_ly","to":"thong_bao","label":"3 ngày"},{"from":"thong_bao","to":"hoa_giai"}]}
```
Có thể thêm `"mainPath": [id, …]` (chuỗi id của đường chính – mỗi cặp liên tiếp phải có cạnh) và `"phases": [{"id":"p1","label":"Sơ bộ","fromCol":0,"toCol":2}]`.

### sequence – người tham gia từ trái sang phải; thông điệp theo thứ tự (không cần `y`, công cụ tự xếp)
```json
{"meta":{"title":"Luồng thanh toán bằng thư tín dụng (L/C)"},"participants":[{"id":"nguoi_mua","type":"external","label":"Người mua"},{"id":"nh_mo","type":"backend","label":"NH phát hành"},{"id":"nh_tb","type":"backend","label":"NH thông báo"},{"id":"nguoi_ban","type":"frontend","label":"Người bán"}],"messages":[{"from":"nguoi_mua","to":"nh_mo","label":"đề nghị mở L/C"},{"from":"nh_mo","to":"nh_tb","label":"phát hành L/C","variant":"emphasis"},{"from":"nh_tb","to":"nguoi_ban","label":"thông báo L/C"},{"from":"nguoi_ban","to":"nh_tb","label":"xuất trình chứng từ"},{"from":"nh_tb","to":"nh_mo","label":"chuyển chứng từ"},{"from":"nh_mo","to":"nh_tb","label":"thanh toán","variant":"return"},{"from":"nh_mo","to":"nguoi_mua","label":"giao chứng từ, đòi tiền"}]}
```

### lifecycle – làn "main" cột 0..4; làn phụ: cột N nằm dưới cột N+2 của làn main; hai trạng thái làn phụ cách nhau ≥ 2 cột
```json
{"meta":{"title":"Vòng đời hiệu lực của hợp đồng"},"lanes":[{"id":"main","label":"Diễn biến chính"},{"id":"exc","label":"Bất thường"}],"states":[{"id":"dam_phan","type":"start","label":"Đàm phán","lane":"main","col":0},{"id":"giao_ket","type":"active","label":"Giao kết","lane":"main","col":1},{"id":"thuc_hien","type":"active","label":"Thực hiện","lane":"main","col":2},{"id":"nghiem_thu","type":"decision","label":"Nghiệm thu","lane":"main","col":3},{"id":"thanh_ly","type":"success","label":"Thanh lý","lane":"main","col":4},{"id":"vi_pham","type":"failure","label":"Vi phạm","sublabel":"phạt, bồi thường","lane":"exc","col":0},{"id":"cham_dut","type":"failure","label":"Chấm dứt","sublabel":"đơn phương","lane":"exc","col":2}],"transitions":[{"from":"dam_phan","to":"giao_ket"},{"from":"giao_ket","to":"thuc_hien"},{"from":"thuc_hien","to":"nghiem_thu"},{"from":"nghiem_thu","to":"thanh_ly"},{"from":"thuc_hien","to":"vi_pham","label":"vi phạm"},{"from":"vi_pham","to":"cham_dut"}]}
```

### dataflow – `stages` = cột (giai đoạn / cơ quan), `stage` = chỉ số cột, `row` = hàng 0..3
```json
{"meta":{"title":"Luồng hồ sơ C/O ưu đãi"},"stages":[{"label":"Doanh nghiệp"},{"label":"Cơ quan cấp C/O"},{"label":"Hải quan nước nhập khẩu"}],"nodes":[{"id":"ho_so","type":"frontend","label":"Hồ sơ đề nghị","sublabel":"hóa đơn, tờ khai","stage":0,"row":0},{"id":"kiem_tra","type":"security","label":"Kiểm tra xuất xứ","stage":1,"row":0},{"id":"co","type":"database","label":"Cấp C/O","stage":1,"row":1},{"id":"uu_dai","type":"backend","label":"Áp thuế ưu đãi","stage":2,"row":0}],"flows":[{"from":"ho_so","to":"kiem_tra","label":"nộp"},{"from":"kiem_tra","to":"co","label":"đạt"},{"from":"co","to":"uu_dai","label":"xuất trình"}]}
```

### architecture – cơ cấu các bên trên lưới `row` / `col`
```json
{"meta":{"title":"Cơ cấu các bên trong hợp đồng phân phối"},"layout":{"mode":"grid"},"components":[{"id":"nsx","type":"external","label":"Nhà sản xuất","row":0,"col":0},{"id":"npp","type":"backend","label":"Nhà phân phối","row":0,"col":1},{"id":"dai_ly","type":"frontend","label":"Đại lý cấp 2","row":0,"col":2},{"id":"nh","type":"database","label":"Ngân hàng bảo lãnh","row":1,"col":0}],"connections":[{"from":"nsx","to":"npp","label":"HĐ phân phối"},{"from":"npp","to":"dai_ly","label":"HĐ đại lý"},{"from":"nh","to":"nsx","label":"bảo lãnh thanh toán"}]}
```

## 4. Quy trình làm
1. Tra căn cứ trước (các bước, thời hạn, cơ quan) bằng công cụ tra cứu; không vẽ theo trí nhớ.
2. Chép mẫu IR đúng loại ở mục 3, thay lanes / nodes / edges bằng dữ kiện đã tra (≤ 12 nút, `col` 0..5).
3. Gọi `diagram_create` NGAY (không mô tả IR trong câu trả lời, không hỏi lại người dùng về định dạng).
4. Viết câu trả lời: đoạn giới thiệu → dòng `[[diagram:…]]` công cụ trả về → giải thích từng bước kèm căn cứ.

## 5. Kết quả và sửa lỗi
- Thành công: công cụ trả mã sơ đồ và dòng `[[diagram:v…]]` → chép **nguyên văn** dòng đó vào câu trả lời, trên một dòng riêng, ngay sau đoạn văn mà sơ đồ minh hoạ. Không tự viết mã sơ đồ.
- Công cụ tự sửa lỗi cơ học (thuộc tính thừa, loại nút sai, cột > 5, nhãn dài, nhãn đè nút, thiếu toạ độ sequence) và liệt kê "Đã tự sửa". Nếu vẫn báo lỗi: đọc từng dòng lỗi (tiếng Anh của trình biên dịch, kèm gợi ý "sửa:"), chỉ sửa đúng chỗ đó rồi gọi lại. Tối đa **2 lần** gọi lại; vẫn lỗi → bỏ Archify, dùng khối ```mermaid (skill `visuals`).
- Không tuyên bố đã vẽ khi công cụ báo lỗi. Không mô tả sơ đồ khác với IR đã gửi.
