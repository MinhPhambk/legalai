---
name: clarify
description: Hỏi lại người dùng khi thiếu thông tin then chốt – dùng khi yêu cầu soạn / rà soát hợp đồng chưa rõ bên nào, loại hợp đồng, ngôn ngữ, luật áp dụng; tra phòng vệ thương mại thiếu thị trường hoặc sản phẩm / mã HS; tính thời hạn thiếu ngày bắt đầu; câu hỏi pháp lý mơ hồ có hai cách hiểu. Quy tắc dùng công cụ `question` (lựa chọn, chọn nhiều, tự nhập) và cách hỏi bằng văn bản khi không có công cụ này.
---

# Hỏi lại người dùng (clarify)

## Khi nào hỏi
Chỉ hỏi khi **cả hai** điều kiện đúng:
1. Thông tin còn thiếu **làm thay đổi đáng kể** câu trả lời / tài liệu (khác căn cứ pháp lý, khác cấu trúc hợp đồng, khác bên được bảo vệ, khác kết quả tính);
2. **Không thể mặc định hợp lý** (nếu có mặc định an toàn – VD luật Việt Nam cho hợp đồng giữa hai doanh nghiệp Việt Nam, tiếng Việt khi người dùng viết tiếng Việt – thì dùng mặc định và **nói rõ đã giả định gì**, không hỏi).

Tình huống điển hình:
| Yêu cầu | Thông tin thường thiếu |
|---|---|
| Soạn / rà soát hợp đồng | người dùng là **bên nào**; **loại hợp đồng**; **ngôn ngữ** (vi / en / song ngữ); **luật áp dụng** khi có bên nước ngoài |
| Tra phòng vệ thương mại, FTA, xuất xứ | **thị trường** nhập khẩu; **sản phẩm hoặc mã HS** |
| Tính thời hạn (`clock_calc`) | **ngày bắt đầu / sự kiện kích hoạt** |
| Câu hỏi pháp lý | câu hỏi có **hai cách hiểu** hợp lý dẫn tới hai câu trả lời khác nhau |

**Không hỏi**:
- điều **tra cứu được** bằng công cụ (điều luật, mức thuế, tình trạng hiệu lực, mã HS gợi ý, ngày hôm nay → `clock_now`) – tự tra;
- điều người dùng **đã nói** trong hội thoại hoặc có trong tệp / tài liệu đính kèm – đọc lại trước khi hỏi;
- **dữ liệu định danh / bí mật**: CCCD, hộ chiếu, số tài khoản, mật khẩu, mã OTP, địa chỉ nhà riêng, tên thật của người khác… (xem skill `safety`) – hợp đồng mẫu dùng chỗ trống `[…]`;
- chi tiết nhỏ có thể để trống cho người dùng tự điền (số lượng, đơn giá, tên công ty) – dùng `[…]` thay vì hỏi.

## Cách hỏi: LUÔN gọi công cụ `question`
Cần hỏi → **gọi công cụ `question`** (kèm tối đa một câu dẫn ngắn). **Không** tự viết câu hỏi / danh sách lựa chọn thành văn bản rồi dừng: người dùng trả lời ngay trên thẻ câu hỏi (nút chọn + ô tự nhập), bạn nhận câu trả lời làm kết quả công cụ và làm tiếp trong cùng lượt. Không tự phán đoán công cụ có hay không – cứ gọi; chỉ khi lệnh gọi **báo lỗi công cụ không tồn tại / unavailable tool** mới hỏi bằng văn bản theo mục cuối.

## Cách dùng công cụ `question`
- **Gộp** tất cả câu hỏi vào **một lần gọi**, tối đa **3 câu hỏi**; hỏi **một lần** duy nhất cho mỗi yêu cầu.
- Trước khi gọi, viết **một câu ngắn** giải thích vì sao cần hỏi (VD "Để soạn đúng, tôi cần biết thêm 3 điểm:").
- Mỗi câu hỏi:
  - `question`: câu hỏi đầy đủ, ngắn gọn, bằng **ngôn ngữ của người dùng / giao diện** (mặc định tiếng Việt; dòng `Ngôn ngữ giao diện: en` → tiếng Anh);
  - `header`: nhãn rất ngắn, **≤ 30 ký tự** (VD "Loại hợp đồng", "Vai trò của bạn", "Ngôn ngữ");
  - `options`: **2–5** lựa chọn; `label` 1–5 từ, `description` một dòng giải thích hệ quả của lựa chọn;
  - lựa chọn **khuyến nghị đặt đầu tiên**, cuối nhãn thêm ` (Khuyến nghị)` (tiếng Anh: ` (Recommended)`);
  - `multiple: true` **chỉ khi** các lựa chọn không loại trừ nhau (VD nhiều thị trường cùng lúc); còn lại bỏ trống;
  - để mặc định `custom` (người dùng tự nhập được) – **không** thêm lựa chọn "Khác" / "Other".
- Kết quả trả về dạng `"câu hỏi"="nhãn đã chọn[, nhãn…]"`; câu trả lời tự nhập là chữ tự do; `"Unanswered"` = người dùng bỏ qua câu đó → dùng mặc định hợp lý và nói rõ.
- Người dùng **bỏ qua / đóng** câu hỏi (kết quả công cụ `The user dismissed this question`; lượt đó kết thúc) → ở tin nhắn sau **không hỏi lại** những câu đó; làm theo tin nhắn mới, thiếu gì thì dùng mặc định hợp lý và nêu rõ giả định.
- Có câu trả lời → **làm tiếp ngay**, không hỏi lại điều đã được trả lời, không xin xác nhận lại.

Ví dụ (soạn hợp đồng, chưa rõ gì):
```json
{"questions":[
  {"question":"Bạn cần soạn loại hợp đồng nào?","header":"Loại hợp đồng","options":[
    {"label":"Mua bán hàng hóa (Khuyến nghị)","description":"Hợp đồng mua bán hàng hóa giữa hai doanh nghiệp"},
    {"label":"Mua bán quốc tế","description":"Có bên nước ngoài, dùng Incoterms, luật áp dụng / trọng tài quốc tế"},
    {"label":"Cung ứng dịch vụ","description":"Một bên cung ứng dịch vụ, bên kia thanh toán"}]},
  {"question":"Doanh nghiệp của bạn là bên nào trong hợp đồng?","header":"Vai trò của bạn","options":[
    {"label":"Bên bán / cung ứng","description":"Điều khoản bảo vệ bên bán (thanh toán, giới hạn trách nhiệm)"},
    {"label":"Bên mua / sử dụng","description":"Điều khoản bảo vệ bên mua (chất lượng, bảo hành, phạt chậm giao)"},
    {"label":"Trung lập","description":"Bản cân bằng quyền lợi hai bên"}]},
  {"question":"Hợp đồng soạn bằng ngôn ngữ nào?","header":"Ngôn ngữ","options":[
    {"label":"Tiếng Việt (Khuyến nghị)","description":"Chỉ bản tiếng Việt"},
    {"label":"Song ngữ Việt – Anh","description":"Hai cột Việt | Anh, bản tiếng Việt ưu tiên"},
    {"label":"Tiếng Anh","description":"Chỉ bản tiếng Anh"}]}
]}
```

## Khi gọi `question` báo lỗi unavailable tool
Khi đó (giao diện chưa hỗ trợ thẻ câu hỏi) hỏi bằng văn bản, không nhắc tới tên công cụ hay lỗi:
- làm phần việc làm được với mặc định hợp lý (nêu rõ giả định); nếu thông tin thiếu làm thay đổi toàn bộ tài liệu (VD chưa biết loại hợp đồng) thì **không** soạn cả văn bản theo phỏng đoán – chỉ tóm tắt ngắn sẽ soạn gì;
- **cuối câu trả lời** thêm mục "Để tôi làm tiếp, vui lòng cho biết:" – danh sách đánh số, tối đa 3 câu, mỗi câu một dòng: **nhãn ngắn** + các lựa chọn ngắn cách nhau bằng " / ", lựa chọn khuyến nghị đầu tiên có "(Khuyến nghị)", cuối dòng "– hoặc mô tả khác";
- người dùng trả lời ở tin nhắn sau → làm tiếp, không hỏi lại.
