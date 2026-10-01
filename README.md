# ND4–ND5: Agent AI pháp lý

Agent chạy trên **opencode + Qwen3.6-35B-A3B tự host (GPUStack)**, tự tra cứu nguồn chính thống bằng cách **điều khiển Chrome**.

Dự án **tách hoàn toàn** khỏi kho dữ liệu ND3 (`../nd3-dataset`): agent không đọc, không truy xuất, không dùng dữ liệu đó để đánh giá.

## Cô lập (sandbox)
- opencode và chrome-devtools-mcp được cài **cục bộ** trong `node_modules/`, không cài global.
- `run.sh` / `run.ps1` chuyển toàn bộ các thư mục sau vào **`.sandbox/`**:
  - HOME, USERPROFILE
  - XDG config / data / cache / state
  - TEMP
  - cache npm
- Nhờ vậy opencode **không đọc hay ghi** vào thư mục người dùng thật. Điều này đã được kiểm tra.
- Chrome chạy với **profile riêng** `.sandbox/chrome-profile`, không dùng Chrome hay tài khoản cá nhân.
- Quyền của agent (`opencode.json`, `.opencode/agent/legal.md`):
  - **Chặn** `bash`, `webfetch`, `websearch`, và việc truy cập thư mục ngoài dự án (`external_directory`).
  - Chỉ đọc và ghi trong `workspace/`.
  - Chỉ vào web qua Chrome.
- Tắt tự cập nhật, chia sẻ, snapshot.
- Xoá thư mục `.sandbox/` là xoá sạch trạng thái.

## Cài đặt API
1. Sao `.env.example` thành `.env` rồi điền:
   ```
   QWEN_BASE_URL=https://gpustack.chimai.io/v1
   QWEN_API_KEY=<key GPUStack>
   ```
2. Tên model trong `opencode.json` (`qwen3.6-35b-a3b-fp8`) phải **trùng với tên trên GPUStack**. Kiểm tra bằng `GET /v1/models`.
3. `limit.context` / `limit.output` đang đặt tạm là 131072 / 16384. Chỉnh theo cấu hình server.

## Chạy
```bash
./run.sh                    # giao diện TUI (agent mặc định: legal)
./run.sh run "câu hỏi…"     # một câu hỏi, chạy không tương tác
./run.sh mcp list           # kiểm tra Chrome MCP
```
Đặt hợp đồng cần rà soát vào `workspace/`. Báo cáo được ghi ra `workspace/out/`.

## Agent và skill (`.opencode/`)
| Thành phần | Vai trò |
|---|---|
| `agent/legal.md` | Agent chính: quy tắc trích dẫn, bảo mật (không đưa nội dung hợp đồng lên web), độ tin cậy, chuyển luật sư, song ngữ |
| `skills/legal-research` | Tra văn bản pháp luật, án lệ, điều ước qua Chrome, **chỉ trên các trang chính thống**; kiểm tra hiệu lực; trích nguyên văn kèm link |
| `skills/contract-review` | Rà soát và soạn hợp đồng: rủi ro 5 mức, căn cứ, gợi ý sửa, điều khoản thiếu, **bảng nghĩa vụ – thời hạn** |
| `skills/trade-remedy-lookup` | Tra biện pháp thương mại và ưu đãi FTA theo sản phẩm, mã HS, thị trường: giai đoạn, mức thuế, việc cần làm, thời hạn |
| `skills/citation-check` | Bước bắt buộc: xác minh lại từng trích dẫn trên trang gốc, chấm độ tin cậy, quyết định chuyển luật sư |
