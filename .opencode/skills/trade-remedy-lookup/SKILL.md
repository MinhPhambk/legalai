---
name: trade-remedy-lookup
description: Tra cứu biện pháp thương mại (AD, CVD, tự vệ, chống lẩn tránh, TBT/SPS, xuất xứ, CBAM/EUDR) và ưu đãi FTA áp dụng cho một sản phẩm / mã HS Việt Nam xuất sang một thị trường – tình trạng vụ việc, mức thuế, việc doanh nghiệp cần làm, thời hạn.
---

# Tra cứu biện pháp thương mại

## Đầu vào cần có
Sản phẩm (tên + **mã HS** nếu có), **thị trường** nhập khẩu, (tuỳ chọn) tên doanh nghiệp xuất khẩu để tra mức thuế riêng. Thiếu mã HS thì hỏi lại hoặc tra mã HS gợi ý và nói rõ là ước đoán.

### Hỏi lại người dùng
Chưa rõ **thị trường** nhập khẩu hoặc **sản phẩm / mã HS** (không suy ra được từ tin nhắn, không tra mã HS gợi ý được) → **gọi ngay công cụ `question`** (một lần gọi, tối đa 3 câu, có lựa chọn; thị trường: `multiple: true`; quy tắc chi tiết ở skill `clarify`) – **không** tự viết câu hỏi thành văn bản rồi dừng; chỉ khi lệnh gọi báo công cụ không tồn tại mới hỏi bằng danh sách đánh số cuối câu trả lời. **Không** hỏi tên doanh nghiệp (chỉ dùng nếu người dùng tự nêu). Không hỏi điều tra cứu được (mức thuế, tình trạng vụ việc); có câu trả lời thì tra ngay, không hỏi lại.

## Nguồn theo thứ tự
1. **trav.gov.vn / canhbaosom.trav.gov.vn** (Cục Phòng vệ thương mại) → LUÔN dùng công cụ `trav_*` (tự điều khiển Chrome sandbox, trả kết quả gọn – **không** tự bấm/đọc các trang này bằng MCP `chrome`):
   - `trav_search(query, market?, category?)` – tin điều tra của nước ngoài với hàng VN, cảnh báo sớm… theo **tên sản phẩm tiếng Việt**, **mã HS** (VD `7210`) hoặc thị trường; `market` lọc thêm theo nước (VD "Hoa Kỳ", "EU", "Úc"), `category: "foreign"` chỉ lấy tin điều tra của nước ngoài. Từ khóa ngắn cho kết quả tốt hơn ("thép mạ kẽm" thay vì cả câu).
   - `trav_page(url)` – toàn văn một bài (link từ `trav_search`): ngày đăng, diễn biến, mốc thời hạn, khuyến nghị của Cục PVTM, tệp thông báo gốc đính kèm.
   - `trav_measures(product?, hs?, market?, type?, company?, in_force?)` – CSDL cảnh báo sớm: biện pháp **đang có hiệu lực** theo nước áp dụng, mã HS, ngày khởi xướng / chính thức, **mức thuế theo doanh nghiệp**. Tên hàng thử cả tiếng Anh ("galvanised", "shrimp") lẫn tiếng Việt; `company` để lọc mức thuế riêng của doanh nghiệp. Đây là dữ liệu tổng hợp, có thể chậm cập nhật → đối chiếu văn bản gốc của nước nhập khẩu trước khi nêu mức thuế.
2. Nguồn gốc của nước nhập khẩu:
   - Hoa Kỳ → LUÔN dùng công cụ `fedreg_*` (API công khai Federal Register + bản chính thức GPO trên govinfo.gov; trang toàn văn federalregister.gov chặn truy cập tự động nên **không** mở bằng MCP `chrome`):
     - `fedreg_search(query, agency?, date_from?, date_to?, order?)` – từ khóa tiếng Anh (sản phẩm + "antidumping"/"countervailing"/"administrative review", hoặc số vụ việc `A-552-xxx` / `C-552-xxx`); `agency`: `ITA` (Bộ Thương mại – mức thuế), `USITC` (thiệt hại), `CBP`; `order: "newest"` để lấy kết quả rà soát mới nhất.
     - `fedreg_document(id, focus?)` – số văn bản FR (VD `2026-19102`) → cơ quan, ngày đăng, trích dẫn FR, số vụ việc, DATES, kỳ rà soát, và **đoạn nguyên văn** bảng biên độ phá giá / mức trợ cấp / tỷ lệ ký quỹ (cash deposit), mức Vietnam-wide / all-others; `focus` = tên doanh nghiệp để ưu tiên dòng của doanh nghiệp đó.
     - `access.trade.gov` (nếu cần thêm) vẫn dùng MCP `chrome`.
   - EU → LUÔN dùng công cụ `eurlex_*` (CSDL chính thức CELLAR của Văn phòng Xuất bản EU – cùng dữ liệu với EUR-Lex; trang eur-lex.europa.eu chặn truy cập tự động nên **không** mở bằng MCP `chrome`):
     - `eurlex_search(query?, country?, measure?, date_from?, date_to?)` – văn bản PVTM của EU liên quan tới Việt Nam (mặc định): `measure` = `anti-dumping` / `anti-subsidy` / `circumvention` / `safeguard` / `registration` (đăng ký hàng nhập khẩu) / `initiation` (thông báo khởi xướng, OJ C) / `review`; `query` = từ khóa tiếng Anh trong tiêu đề ("hot-rolled", "PET", "plywood"). CBAM / EUDR: `measure: "cbam"` / `"eudr"` (quy định gốc + văn bản thực thi/sửa đổi, lọc thêm bằng `query`, VD "default values"). Kết quả mới nhất trước, có số CELEX, loại văn bản, còn hiệu lực hay không.
     - `eurlex_document(id, country?, focus?)` – số CELEX (VD `32025R1919`) / link EUR-Lex / ELI → ngày, hiệu lực, **Điều 1 nguyên văn** (sản phẩm, mã CN/TARIC) và bảng mức thuế theo doanh nghiệp **chỉ gồm dòng của Việt Nam** (nhãn `[Phần áp dụng cho: Vietnam …]`); thông báo khởi xướng: sản phẩm, cáo buộc, kỳ điều tra, thời hạn; `focus` = tên doanh nghiệp.
   - Nước khác: trang cơ quan điều tra (Ấn Độ DGTR, Trung Quốc MOFCOM…) bằng MCP `chrome` nếu truy cập được; nếu không, dùng thông tin trên trav.gov.vn (`trav_search` / `trav_page`).
3. TBT/SPS → LUÔN dùng công cụ `eping_*` (API công khai của ePing – epingalert.org, WTO/ITC/UN DESA):
   - `eping_search(query?, member?, area?, product?, hs?, date_from?, date_to?, open_for_comment?, affects_vietnam?)` – thông báo SPS/TBT theo **thị trường** (`member`: "EU", "Hoa Kỳ", "Nhật Bản"…), `area` SPS/TBT, từ khóa tiếng Anh (mọi từ đều phải có), mã HS (VD `0306`), `open_for_comment: true` (còn hạn góp ý), `affects_vietnam: true` (Việt Nam được nêu là nước bị ảnh hưởng).
   - `eping_notification(symbol)` – ký hiệu WTO (VD `G/TBT/N/EU/1100`, `G/SPS/N/JPN/1427/Add.1`) → mô tả, sản phẩm/HS, hạn góp ý, ngày dự kiến thông qua/có hiệu lực, văn bản được thông báo, bản thông báo chính thức WTO, các phụ lục/sửa đổi liên quan.
4. Ưu đãi thuế / quy tắc xuất xứ → LUÔN dùng công cụ `fta_*` (trungtamwto.vn – Trung tâm WTO và Hội nhập, VCCI; nếu trang báo lỗi/Cloudflare thì công cụ báo rõ – **không** tìm cách vượt qua, chuyển sang `vbpl_*` cho thông tư/nghị định thực thi):
   - `fta_list()` – các FTA của Việt Nam, ngày có hiệu lực, đối tác.
   - `fta_search(query, fta?, kind?)` – chương / phụ lục / biểu cam kết thuế / quy tắc cụ thể mặt hàng (kèm link bản EN/VI) và **văn bản thực thi của Việt Nam** (thông tư quy tắc xuất xứ, nghị định biểu thuế ưu đãi), VD `fta: "EVFTA", query: "quy tắc xuất xứ"`, `fta: "CPTPP", query: "thuế"`.
   - `fta_document(url, focus?)` – nội dung trang hoặc tệp PDF đính kèm (chữ trích từ PDF; bản scan dạng ảnh thì chỉ có link), `focus` để lấy đúng đoạn (VD "cộng gộp", "de minimis", mã HS).
   Mức thuế ưu đãi áp dụng tại Việt Nam và quy tắc xuất xứ hiện hành: đối chiếu nghị định biểu thuế / thông tư quy tắc xuất xứ mới nhất trên vbpl.vn (`vbpl_find` → `vbpl_document` → `vbpl_article`).
5. **Thuế nhập khẩu thông thường / MFN / ưu đãi FTA theo mã HS** (thuế quan nền, trước và cùng với AD/CVD) → LUÔN dùng `tariff_*` (skill `tariff-lookup`), không trả lời "chưa tra được" khi chưa gọi:
   - Vào Việt Nam (hoặc thuế xuất khẩu của VN): `tariff_vn(hs, year?, fta?, kind?)` – MFN, thông thường, từng FTA theo **năm** (cột lộ trình trong Phụ lục Nghị định), số hiệu Nghị định, hiệu lực, văn bản sửa đổi.
   - Vào Hoa Kỳ: `tariff_us(hs)` – HTS: General (NTR/MFN) cho hàng Việt Nam + tiêu mục Chương 99 nêu đích danh Việt Nam; AD/CVD vẫn tra bằng `trav_measures` / `fedreg_*` ở trên.
   - Vào EU: `tariff_eu(hs, origin="VN")` – TARIC: MFN (Third country duty), ưu đãi EVFTA (Tariff preference), thuế chống bán phá giá / bổ sung theo mã bổ sung doanh nghiệp (số CELEX → `eurlex_document`).
   - Chỉ có mô tả hàng: `tariff_search(query, market)` → mã gợi ý (nêu rõ là gợi ý) rồi tra thuế.

Trình tự gợi ý cho hàng xuất sang Hoa Kỳ: `trav_search` (bức tranh vụ việc, tiếng Việt) → `trav_measures` (biện pháp đang áp dụng, mức thuế theo DN) → `fedreg_search` (văn bản gốc mới nhất, `order: "newest"`) → `fedreg_document` (mức thuế / ký quỹ nguyên văn). Khi hai nguồn lệch nhau, ưu tiên văn bản gốc mới nhất trên Federal Register và nêu rõ sự khác biệt.

Trình tự gợi ý cho hàng xuất sang EU: `trav_search` / `trav_measures` (market "EU") → `eurlex_search` (văn bản mới nhất: khởi xướng → đăng ký → thuế tạm thời → thuế chính thức → rà soát) → `eurlex_document` (Điều 1 + bảng mức thuế của Việt Nam). Kèm `eping_search` (member "EU", sản phẩm/HS) cho yêu cầu SPS/TBT và `fta_search` (fta "EVFTA") cho ưu đãi thuế, quy tắc xuất xứ.

## Trả lời gồm
| Mục | Nội dung |
|---|---|
| Biện pháp | Loại (AD/CVD/SG/chống lẩn tránh/TBT/SPS/…), cơ quan, số vụ việc |
| Giai đoạn | Khởi xướng / kết luận sơ bộ / cuối cùng / đang áp dụng / rà soát / chấm dứt – kèm ngày |
| Mức thuế / yêu cầu | Theo doanh nghiệp nếu tìm thấy, mức toàn quốc nếu không |
| Mốc thời hạn | Hạn trả lời bản câu hỏi, rà soát hành chính, hết hiệu lực… |
| Doanh nghiệp cần làm | Hồ sơ chứng minh xuất xứ, tham gia/đăng ký trả lời điều tra, truy xuất nguồn gốc, liên hệ Cục PVTM… |
| Thuế nhập khẩu thông thường / MFN | Từ `tariff_us` / `tariff_eu` / `tariff_vn`: nguyên văn thuế suất + bản HTS / mã quy định TARIC (CELEX) / số hiệu Nghị định |
| Ưu đãi FTA | Thuế ưu đãi (đúng năm, từ `tariff_*`) và điều kiện xuất xứ nếu có |

**Gắn mức thuế với đúng văn bản:** mỗi mức thuế / biên độ / mức trợ cấp nêu ra phải đi kèm **số văn bản FR (FR Doc …), số vụ việc (A-552-… / C-552-…)** – hoặc với EU: **số CELEX và số hiệu Implementing Regulation (EU) …/…** – và lấy từ đoạn có nhãn `[Phần áp dụng cho: Vietnam …]` của `fedreg_document` / `eurlex_document` (văn bản nhiều nước: công cụ tự lọc theo `country`, mặc định Vietnam; bảng trong phần lý do (recitals) chỉ là căn cứ, mức thuế áp dụng lấy ở Điều 1). Nếu kết quả có dòng `⚠ CẢNH BÁO` / `⚠ LƯU Ý` thì **không** dùng mức thuế trong văn bản đó cho Việt Nam khi chưa kiểm tra lại. Không ghép số liệu của các văn bản khác nhau vào một bảng mà không ghi rõ nguồn từng dòng.

**Số tiền thuế / tiền ký quỹ (cash deposit) ước tính** (khi người dùng cho trị giá lô hàng): mức thuế lấy **đúng từ văn bản chính thức đã mở** (dòng của doanh nghiệp, hoặc mức toàn quốc / all-others) × trị giá khai báo (entered value) do người dùng cung cấp, tính bằng `calc_eval` (VD `calc_eval(expression="mức × trị_giá", vars={"mức": "22,5%", "trị_giá": "1.500.000 USD"}, round="usd")`) – không tự nhẩm; nêu công thức, nguồn của mức thuế và ghi "ước tính, chưa gồm thuế nhập khẩu thông thường / phí khác, số phải nộp do cơ quan hải quan nước nhập khẩu xác định". Nếu cần cả thuế nhập khẩu thông thường / MFN / FTA: lấy thuế suất bằng `tariff_*` trước (không tự nhớ), tính từng khoản riêng bằng `calc_eval` và ghi nguồn từng khoản (VD thuế MFN theo HTS + thuế AD theo FR Doc …). Quy đổi sang VND (hoặc ngược lại) bằng `fx_convert` (tỷ giá tham khảo NHNN / Vietcombank, ghi ngày của tỷ giá) – không dùng tỷ giá theo trí nhớ. Chi tiết: skill `calculation`.

Mọi dòng phải có **link nguồn đã mở** (link do công cụ trả về: bài trav.gov.vn, link canhbaosom, link federalregister.gov kèm bản govinfo, link EUR-Lex / ELI, link ePing, link trungtamwto.vn) và ngày tra cứu (dùng đúng ngày công cụ trả về); thông tin vụ việc thay đổi nhanh nên luôn ghi rõ "tính đến ngày …". Kết thúc bằng `citation-check`.
