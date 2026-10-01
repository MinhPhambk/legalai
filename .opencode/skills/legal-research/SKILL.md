---
name: legal-research
description: Tra cứu văn bản pháp luật, án lệ, điều ước trực tiếp trên các trang chính thống bằng Chrome (MCP chrome) – tìm văn bản, mở toàn văn, kiểm tra tình trạng hiệu lực, trích đúng điều/khoản kèm link.
---

# Tra cứu pháp lý bằng Chrome

## Văn bản pháp luật Việt Nam (vbpl.vn) → LUÔN dùng công cụ `vbpl_*`
Các công cụ này tự điều khiển Chrome sandbox, trả kết quả gọn và chính xác – **không** tự bấm/đọc trang vbpl.vn bằng MCP `chrome`:
1. Xác định **luật điều chỉnh** câu hỏi (VD hợp đồng thương mại → Luật Thương mại 2005; hợp đồng dân sự → Bộ luật Dân sự 2015).
2. `vbpl_find` – tìm văn bản đó theo **tên hoặc số hiệu** → lấy **link thật** (không tìm theo chủ đề, không bao giờ tự đoán link).
3. `vbpl_document` – thuộc tính chính thức: số hiệu, loại, cơ quan, ngày ban hành, ngày có hiệu lực, **tình trạng hiệu lực**.
4. `vbpl_search_articles` – tìm trong văn bản các Điều chứa từ khóa của câu hỏi (VD "phạt vi phạm") → chọn điều đúng.
5. `vbpl_article` – **nguyên văn** điều đó (dùng đúng phần "NGUYÊN VĂN" để trích).
6. `vbpl_verify` – kiểm tra đoạn trích có thật trên trang (bắt buộc trong `citation-check`).
Chỉ kết luận "văn bản không quy định" sau khi `vbpl_search_articles` với vài từ khóa khác nhau đều không ra kết quả.
Nếu văn bản "Hết hiệu lực một phần" (hoặc có dấu hiệu bị sửa đổi): gọi `vbpl_history` để lấy các văn bản sửa đổi / bãi bỏ / thay thế; với từng văn bản đó, `vbpl_find` → `vbpl_search_articles` (từ khóa: số điều cần trích, VD "Điều 301", hoặc tên chế định) để xác nhận điều cần trích **có bị sửa hay không**, và nói rõ kết quả kiểm tra này trong câu trả lời.
Ngày tra cứu: dùng đúng ngày mà công cụ trả về.

## Các trang khác → `web_search` / `web_read`, rồi mới MCP `chrome`
Trang chưa có công cụ riêng: ưu tiên `web_search(query)` (mặc định chỉ nguồn chính thức) → `web_read(url, focus)` (nội dung được `grounding_check` ghi nhận; skill `verify-unknown`). Chỉ khi cần thao tác trên trang (điền ô tìm kiếm, bấm nút) mới dùng các công cụ của MCP `chrome` (mở trang, snapshot, điền ô tìm kiếm, bấm, chạy script đọc nội dung).
Chrome là **trình duyệt sandbox của dự án** (profile riêng, không đăng nhập tài khoản nào), đã được mở sẵn.

Cách làm hiệu quả với văn bản dài (VD toàn văn một bộ luật):
- Khi bấm/điền, đặt `includeSnapshot: false`; chỉ chụp snapshot khi thật sự cần tìm phần tử.
- Dùng `take_snapshot` để tìm ô tìm kiếm / kết quả / link cần bấm; **không** dùng snapshot để đọc toàn văn.
- Khi đã mở trang văn bản, dùng `evaluate_script` để lấy đúng điều cần trích, VD:
  `() => { const t = document.body.innerText; const i = t.indexOf('Điều 301'); return i < 0 ? 'NOT FOUND' : t.substring(i, i + 2500); }`
- Không tự đoán URL văn bản; chỉ đi theo link thấy trên trang hoặc kết quả tìm kiếm.

## Chỉ dùng nguồn trong danh sách này
| Loại | Trang |
|---|---|
| Văn bản pháp luật VN (nguồn chính, có tình trạng hiệu lực) | `vbpl.vn` |
| Văn bản mới ban hành | `congbao.chinhphu.vn`, `vanban.chinhphu.vn`, `chinhphu.vn` |
| Pháp điển | `phapdien.moj.gov.vn` |
| Án lệ, bản án | `anle.toaan.gov.vn`, `congbobanan.toaan.gov.vn` |
| Phòng vệ thương mại | `trav.gov.vn`, `canhbaosom.trav.gov.vn`, `moit.gov.vn` |
| FTA | `trungtamwto.vn` (công cụ `fta_list` / `fta_search` / `fta_document`), `wtocenter.vn`, `moit.gov.vn` |
| Hoa Kỳ | `federalregister.gov`, `govinfo.gov` (bản GPO chính thức của Federal Register), `trade.gov`, `usitc.gov`, `access.trade.gov` |
| EU | `eur-lex.europa.eu` (công cụ `eurlex_search` / `eurlex_document` – đọc bản chính thức qua CELLAR `publications.europa.eu`, không mở eur-lex bằng MCP `chrome`), `policy.trade.ec.europa.eu` |
| WTO / điều ước | `wto.org`, `epingalert.org` (thông báo SPS/TBT: công cụ `eping_search` / `eping_notification`), `uncitral.un.org`, `newyorkconvention.org` |
| Công cụ tìm kiếm (chỉ để tìm link tới các trang trên) | `google.com`, `bing.com` với toán tử `site:` |

**Không** dùng blog công ty luật, diễn đàn, báo chí, thuvienphapluat.vn làm căn cứ (có thể đọc để định hướng, nhưng phải tìm lại văn bản gốc trên trang chính thống rồi mới trích).

## Quy trình
1. **Xác định câu hỏi pháp lý** và từ khóa khái niệm (không đưa thông tin riêng của người dùng vào ô tìm kiếm).
2. **Tìm văn bản**: dùng ô tìm kiếm của trang chính thống (VD vbpl.vn), hoặc Google/Bing: `"<từ khóa>" site:vbpl.vn`. Ưu tiên luật/bộ luật → nghị định → thông tư.
3. **Mở văn bản gốc** và kiểm tra **tình trạng hiệu lực** (trên vbpl.vn: phần thuộc tính / hiệu lực; xem văn bản sửa đổi, thay thế, văn bản hợp nhất mới nhất). Nếu đã bị sửa đổi, tìm điều khoản ở bản hợp nhất hoặc văn bản sửa đổi.
4. **Trích đúng điều/khoản**: chép nguyên văn đoạn liên quan từ snapshot trang (không diễn đạt lại trong phần trích).
5. **Ghi nguồn** theo mẫu:
   `Điều 301 Luật Thương mại 2005 (36/2005/QH11) – còn hiệu lực (tra ngày DD/MM/YYYY) – <link đã mở>`
6. Nếu một trang không tải được (lỗi, CAPTCHA, chặn): **không** tìm cách vượt qua; chuyển sang nguồn khác trong danh sách hoặc báo không truy cập được.

## Lưu ý
- Với tranh chấp: tìm thêm án lệ và bản án tương tự bằng công cụ `court_*` (mục "Án lệ và bản án" dưới đây) – **không** tự bấm/đọc anle.toaan.gov.vn, congbobanan.toaan.gov.vn bằng MCP `chrome`.

## Án lệ và bản án → LUÔN dùng công cụ `court_*`
**Án lệ là nguồn luật** (Tòa án phải nghiên cứu, áp dụng); **bản án chỉ là tài liệu tham khảo** cho thấy cách Tòa áp dụng pháp luật – không bao giờ dùng bản án làm căn cứ pháp lý thay cho điều luật hoặc án lệ.
1. `court_anle_search` – tìm án lệ theo cụm từ pháp lý (VD "phạt vi phạm", "trọng tài", "đặt cọc"; nhiều cụm ngăn bằng dấu phẩy) và/hoặc `field` (VD "Kinh doanh thương mại"); để trống query để liệt kê. Thử vài cụm đồng nghĩa trước khi kết luận "không có án lệ".
2. `court_anle_document` – đọc án lệ theo số (VD "09/2016/AL"): **trạng thái** (còn áp dụng / bị bãi bỏ), ngày áp dụng, Tình huống – Giải pháp pháp lý, Quy định liên quan, nguyên văn Nội dung án lệ. Chỉ viện dẫn án lệ **còn áp dụng**; trích đúng phần "NỘI DUNG ÁN LỆ (nguyên văn)" hoặc "Giải pháp pháp lý". Nếu công cụ báo PDF ảnh quét: chỉ dẫn số, tên, trạng thái, ngày áp dụng – **không** suy diễn nội dung.
   Mẫu ghi nguồn: `Án lệ số 09/2016/AL – còn áp dụng (tra ngày DD/MM/YYYY) – <link>`.
3. `court_judgment_search` – tìm bản án/quyết định: từ khóa chỉ khớp **tên vụ việc / số bản án** (không tìm toàn văn), nên lọc thêm bằng `case_type` + `relation` (quan hệ pháp luật, VD "mua bán hàng hóa"), `level` (sơ thẩm/phúc thẩm/giám đốc thẩm), khoảng ngày.
4. `court_judgment_document` – đọc một bản án (link từ bước 3), dùng `focus` để lấy đúng đoạn nhận định liên quan; trả về đương sự (đã ẩn danh), yêu cầu, nhận định, quyết định, căn cứ pháp luật. Khi dẫn bản án ghi rõ "(bản án tham khảo, không phải nguồn luật)"; điều luật mà bản án viện dẫn phải được kiểm tra lại bằng `vbpl_*`.
Nếu công cụ báo CAPTCHA / máy chủ không phản hồi: không thử vượt qua, không gọi dồn – báo người dùng và tiếp tục với các nguồn khác.
- Hợp đồng quốc tế: xét CISG (Việt Nam là thành viên từ 01/01/2017), luật áp dụng do các bên chọn, Incoterms chỉ khi hợp đồng dẫn chiếu.
- Ghi lại mọi link đã mở để `citation-check` kiểm tra lại.
- Ngày tra cứu: lấy theo ngày hiện tại của hệ thống, không đoán.
