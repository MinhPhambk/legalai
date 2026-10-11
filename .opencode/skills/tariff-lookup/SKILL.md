---
name: tariff-lookup
description: Tra thuế nhập khẩu / xuất khẩu thông thường theo mã HS từ biểu thuế chính thức – Việt Nam (MFN, thông thường, ưu đãi đặc biệt từng FTA theo năm), Hoa Kỳ (HTS – USITC), EU (TARIC qua Access2Markets, gồm ưu đãi EVFTA và thuế chống bán phá giá) – bằng tariff_vn / tariff_us / tariff_eu / tariff_search; nêu nguyên văn thuế suất, số hiệu văn bản, ngày áp dụng, link nguồn.
---

# Tra biểu thuế theo mã HS

Dùng khi người dùng hỏi **thuế suất thuế nhập khẩu / xuất khẩu** (MFN, ưu đãi, thông thường, ưu đãi đặc biệt theo FTA) của một mặt hàng, hoặc trước khi **tính số tiền thuế** của một lô hàng. **Không** trả lời thuế suất theo trí nhớ, không nói "chưa tra được" khi chưa gọi các công cụ dưới đây.

## 1. Xác định mã HS
- Người dùng cho mã → dùng luôn (4–6 số: công cụ liệt kê các mã con; cần mã 8 số (VN) / 8–10 số (US, EU) để có mức chính xác).
- Chỉ có mô tả hàng → `tariff_search(query, market)` (market `vn` mô tả tiếng Việt; `us` / `eu` mô tả tiếng Anh). Kết quả là **gợi ý**: nêu rõ "mã gợi ý, cần xác nhận phân loại", nhiều mã cùng khả năng thì liệt kê hoặc hỏi lại (skill `clarify`).

## 2. Công cụ theo thị trường
| Thị trường | Công cụ | Ghi chú |
|---|---|---|
| Nhập khẩu **vào Việt Nam** (hoặc thuế **xuất khẩu** của Việt Nam) | `tariff_vn(hs, year?, fta?, kind?)` | Nguồn: CSDL Biểu thuế Cục Hải quan (customs.gov.vn) + **Phụ lục Nghị định** trên vbpl.vn. `fta`: `EVFTA`, `ATIGA`, `CPTPP`, `RCEP`, `ACFTA`, `AKFTA`, `AJCEP`, `VJEPA`, `VKFTA`, `AIFTA`, `AANZFTA`, `AHKFTA`, `VN-EAEU`, `UKVFTA`, `VCFTA`, `VIFTA`, `CEPA`, `mfn` hoặc `all`; `year` = năm cần mức thuế (lộ trình FTA giảm theo năm); `kind: "export"` cho thuế xuất khẩu. Lần đầu tra một Nghị định có thể mất 1–2 phút. |
| **Tra nhanh / bổ sung** cho Việt Nam: thuế FTA **đúng năm** khi `tariff_vn` không ra, nhiều loại thuế cùng lúc (VAT, TTĐB, BVMT, XK), **chính sách mặt hàng theo mã HS** (kiểm dịch, CITES, giấy phép, kiểm tra chuyên ngành), tìm mã theo tên hàng | `tariff_vn_table(hs?, query?, year?, fta?)` | **Bảng tổng hợp KHÔNG CHÍNH THỨC** của Real Logistics (ghi rõ phiên bản). Luôn ghi "theo bảng tổng hợp của Real Logistics (không chính thức)" kèm văn bản căn cứ của từng mức; xác nhận mức chính bằng `tariff_vn` hoặc văn bản gốc (`vbpl_*` / `chinhphu_*`). Độ khớp nguồn tối đa TRUNG BÌNH nếu chỉ dựa vào bảng này. |
| Hàng Việt Nam **vào Hoa Kỳ** | `tariff_us(hs)` | HTS (USITC): cột General = mức áp dụng cho hàng Việt Nam; kèm các tiêu mục Chương 99 nêu đích danh Việt Nam (thuế bổ sung) và chú thích. AD/CVD **không** có trong HTS → `trav_measures` + `fedreg_*` (skill `trade-remedy-lookup`). |
| Hàng Việt Nam **vào EU** | `tariff_eu(hs, origin="VN")` | TARIC (Access2Markets): "Third country duty" = MFN; "Tariff preference" [Viet Nam] = ưu đãi EVFTA; thuế chống bán phá giá / chống trợ cấp / thuế bổ sung / hạn ngạch theo mã bổ sung doanh nghiệp, kèm số CELEX (đọc Điều 1 bằng `eurlex_document`). |
| **Yêu cầu nhập khẩu EU** (SPS, an toàn thực phẩm, nhãn mác, hóa chất, tiêu chuẩn, CITES, chứng từ) + **VAT / thuế TTĐB** của nước nhập khẩu | `tariff_eu_requirements(hs, origin="VN", destination="DE")` | Access2Markets: danh mục yêu cầu theo mã CN + thuế nội địa. Chỉ là danh mục – nêu tên yêu cầu và link nguồn, không tự mô tả nội dung chi tiết từng quy định. |

`web_read` link customs.gov.vn (Tra cứu Biểu thuế), hts.usitc.gov, TARIC / Access2Markets tự chuyển sang công cụ tương ứng.

**Hoa Kỳ – bắt buộc:** kết quả `tariff_us` có dòng "⚠ KHÔNG kết luận tổng thuế = mức General" (tiêu mục Chương 99 nêu đích danh Việt Nam, VD `9903.xx.xx … + x%`) → câu trả lời PHẢI nêu tiêu mục đó và mức cộng thêm nguyên văn, kèm "áp dụng nếu mặt hàng thuộc phạm vi / không thuộc ngoại lệ theo chú giải Chương 99 – cần kiểm tra"; **không** được viết "tổng thuế = 0%" / "chỉ có thuế MFN" khi còn dòng này (kể cả khi người dùng chỉ hỏi "thuế quan"). Dòng ghi "[ĐÃ CHẤM DỨT]" / "thời hạn đã qua" thì không tính.
**EU:** "Additional duties" / hạn ngạch (order number) / chống bán phá giá theo mã bổ sung: nêu nguyên văn kèm CELEX, không tự cộng khi chưa đọc điều kiện áp dụng.

## 3. Cách đọc kết quả `tariff_vn`
- Mỗi loại thuế có: **thuế suất – căn cứ (số hiệu Nghị định / Quyết định) – giai đoạn áp dụng [CSDL Hải quan]**.
- Dòng có "⚠ giai đoạn này không phải năm …" → **dùng dòng "↳ Phụ lục … – năm …"** (cột đúng năm trong Phụ lục của Nghị định, kèm dòng nguyên văn) – không dùng mức của giai đoạn cũ.
- CPTPP / RCEP: mức khác nhau theo nhóm nước (Mê-hi-cô / các nước khác; RCEP theo đối tác) – nêu đúng nhóm người dùng hỏi, nếu không rõ thì nêu từng nhóm.
- Ký hiệu `*` = không được hưởng ưu đãi đặc biệt; dòng "Mã còn được dẫn ở … (Chương 98)" = mức riêng có điều kiện – chỉ nêu kèm điều kiện.
- "RÀ SOÁT VĂN BẢN SỬA ĐỔI" có dòng ⚠ → mã đã bị sửa: nêu mức trong văn bản sửa đổi còn hiệu lực (từ ngày hiệu lực của nó), dẫn số hiệu văn bản sửa đổi.
- Luôn nêu **tình trạng hiệu lực** (mục "VĂN BẢN & HIỆU LỰC") và điều kiện hưởng ưu đãi (quy tắc xuất xứ, chứng từ chứng nhận xuất xứ).

## 4. Trình bày
| Mục | Nội dung |
|---|---|
| Mã HS + mô tả | đúng mô tả chính thức (VI; EN nếu có) |
| Thuế suất | **nguyên văn** công cụ trả về, kèm đơn vị (%, EUR/…, "Free") và loại thuế (MFN / thông thường / FTA …) |
| Căn cứ | số hiệu Nghị định (VN) / bản HTS (revision) / mã quy định TARIC + CELEX (EU); ngày áp dụng / năm |
| Nguồn | link công cụ trả về + "Ngày tra cứu" |
| Lưu ý | điều kiện xuất xứ, hạn ngạch, mùa vụ, thuế bổ sung, AD/CVD (nếu có) |

Số tiền thuế ước tính (khi có trị giá lô hàng): thuế suất lấy **đúng** từ kết quả công cụ × trị giá tính thuế do người dùng cung cấp, tính bằng `calc_eval` (skill `calculation`), ghi "ước tính". Có AD/CVD thì cộng riêng từng khoản, nêu nguồn từng khoản. Kết thúc bằng skill `citation-check`.
