# LegalAI Web – giao diện chat cho agent pháp lý (opencode)

Giao diện web kiểu claude.ai / chatgpt.com cho agent `legal` chạy trên **opencode**.
Trình duyệt chỉ nói chuyện với backend Node (127.0.0.1:3000). Backend tự khởi động
`opencode serve` qua `../run.sh` (có sandbox), với mật khẩu ngẫu nhiên, và chỉ bind 127.0.0.1.

```
Trình duyệt ──HTTP/SSE──► web/server (Express, 127.0.0.1:3000)
                              │  cookie phiên, SQLite, kiểm tra quyền sở hữu, trích văn bản tệp
                              └──HTTP basic + SSE──► opencode serve (127.0.0.1:<cổng ngẫu nhiên>)
                                                         └─ agent legal, tools vbpl_*, skills, Chrome sandbox
```

## Yêu cầu
- Node ≥ 22.5 (đã thử với Node 24), Git Bash (để chạy `run.sh`), Chrome (cho Chrome sandbox của agent).
- `../.env` đã có khoá API (xem README của dự án).
- Không cần Python, Docker hay addon native: SQLite dùng `node:sqlite`, mật khẩu dùng `node:crypto` scrypt.

## Cài đặt và build
```bash
cd web
npm install          # cache npm nằm trong ../.sandbox/cache/npm (xem .npmrc)
npm run build        # build frontend (Vite) vào client/dist + prerender trang công khai (scripts/prerender.mjs)
```

## Chạy
```bash
npm start            # khởi động backend → backend tự khởi động opencode serve
# mở http://127.0.0.1:3000
```
- Tắt: Ctrl+C (backend tắt luôn opencode). Nếu backend bị kill cứng, lần chạy sau sẽ tự dọn
  tiến trình opencode cũ (ghi PID ở `../.sandbox/web/opencode.pid.json`).
- Dev: `npm run dev` → backend + Vite dev server tại http://127.0.0.1:5173 (proxy `/api`).

### Biến môi trường
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng web (luôn bind 127.0.0.1) |
| `SITE_URL` | – | Tên miền thật, ví dụ `https://legalai.example.vn`: dùng cho canonical / hreflang / OG / sitemap và **chỉ khi đặt** (và không phải `*.trycloudflare.com`, localhost, IP) thì trang công khai mới được index – chỉ trên đúng host đó. Không đặt → URL lấy theo request, mọi trang `X-Robots-Tag: noindex` + robots.txt `Disallow: /` |
| `ALLOW_REGISTRATION` | `true` | Giá trị mặc định; quản trị viên bật/tắt lúc chạy trong màn hình Quản trị (lưu trong DB) |
| `OPENCODE_URL`, `OPENCODE_SERVER_PASSWORD` | – | Dùng một opencode server có sẵn thay vì tự khởi động (dev) |
| `OPENCODE_PORT` | ngẫu nhiên | Cổng cố định cho opencode serve |
| `OPENCODE_AGENT` | `legal-web` | Agent nhận prompt |
| `WEB_MODEL_CLOUD` | – | không còn dùng (UI không còn nhãn cloud / tự host) |
| `BASH_PATH` | Git Bash | Đường dẫn bash để chạy `run.sh` |
| `WEB_ASSIST` | `1` | Trợ giúp xác minh trên trang chính thức (v10): serve chạy với `ND45_ASSIST=1` → `company_lookup` / `company_verify` mời người dùng tự qua CAPTCHA trong khung xem trực tiếp; `0` = tắt (chỉ trả link + bước tự tra như trước) |
| `ND45_OCR` / `ND45_OCR_MAX_PAGES` | bật / `15` | OCR bản scan khi tải lên (v11); `ND45_OCR=0` = tắt (PDF scan bị từ chối như trước). Số trang đầu được OCR |
| `WEB_PDF_OCR` | `../.opencode/lib/pdf-ocr.ts` | Module OCR (harness trỏ về bản thật); thiếu / lỗi → coi như tắt OCR |
| `WEB_QUESTION_TOOL` | `1` | Thẻ câu hỏi làm rõ (công cụ `question`); `0` = tắt (serve chạy không có công cụ, câu hỏi nào lọt ra bị từ chối ngay) |

## Tài khoản
```bash
node scripts/create-user.mjs <email> <mật-khẩu> [--admin]
# hoặc: npm run create-user -- <email> <mật-khẩu> [--admin]
```
Nếu email đã tồn tại, lệnh sẽ đặt lại mật khẩu và huỷ mọi phiên đăng nhập cũ.
Dữ liệu nằm ở `../.sandbox/web/app.db` (users, sessions, chats, uploads) và tệp tải lên ở
`../.sandbox/web/uploads/<userId>/`.

## Tính năng
- Đăng ký / đăng nhập / đăng xuất; mật khẩu scrypt (N=2^15) + salt riêng; token phiên 32 byte
  ngẫu nhiên (chỉ lưu SHA-256) trong cookie `httpOnly; SameSite=Lax` (+`Secure` khi chạy qua HTTPS,
  nhận biết qua `X-Forwarded-Proto` từ tunnel cục bộ); giới hạn đăng nhập sai theo IP và theo email;
  thông báo lỗi đăng nhập chung chung.
- Mỗi cuộc trò chuyện = một session opencode. Mọi API đều kiểm tra quyền sở hữu (người khác nhận 404).
- Stream: trình duyệt mở SSE `/api/chats/:id/events`; backend giữ **một** kết nối `/event` tới opencode và
  chỉ chuyển sự kiện của session đó, đã rút gọn (text delta, suy nghĩ, bước công cụ: tên + tham số ngắn +
  trạng thái + kết quả ngắn, lỗi, idle). Không chuyển nguyên output công cụ, đường dẫn hay cấu hình.
- Long-poll dự phòng (`server/poll.mjs`, `client/src/stream.js`): Cloudflare quick tunnel giữ lại toàn bộ
  response dạng chunked tới khi kết thúc, nên SSE không tới người dùng qua tunnel. Client mở SSE trước;
  nếu 3 s không có sự kiện nào (kể cả `ready`) hoặc stream lỗi → chuyển sang
  `GET /api/chats/:id/poll?after=<seq>&wait=25` (trả ngay nếu có sự kiện sau `seq`, không thì chờ tối đa 25 s,
  gom sự kiện trong 60 ms rồi **kết thúc** response: `{events, next, reset?}`), và nhớ lựa chọn trong
  `sessionStorage` cho các cuộc trò chuyện sau. Server giữ một log sự kiện cho mỗi (chat, người xem, quyền
  xem suy nghĩ, ngôn ngữ) – cùng `translateEvent`/lọc như SSE – vòng đệm 2000 sự kiện / 10 phút;
  `after` cũ hơn đệm (hoặc từ tiến trình server trước) → `reset` + `ready` (client tải lại lịch sử).
  Tối đa 12 poll đang chờ mỗi người dùng. Ép chế độ để thử: `?transport=poll|sse` hoặc
  `localStorage["legalai.transport"]`. Kiểm thử: `node scripts/stream-test.mjs <email> <mật khẩu>`
  (env `APP_URL`, `TRANSPORT`).
- Dừng (abort), đổi tên, xoá cuộc trò chuyện; tự đặt tiêu đề từ ~60 ký tự đầu (truyền vào khi tạo
  session nên opencode không tốn thêm lượt gọi model để đặt tên).
- Tải tệp `.docx .pdf .txt .md` ≤ 10 MB (kiểm tra đuôi + chữ ký tệp); trích chữ phía server
  (.docx: mammoth → HTML → markdown, giữ tiêu đề / chữ đậm-nghiêng / danh sách / bảng của tệp gốc; .pdf: pdfjs-dist, chỉ chữ), cắt ở 60.000 ký tự/tệp (tổng 150.000 ký tự/tin nhắn) và báo người dùng khi bị cắt.
  Nội dung được gửi **trong prompt**:
  ```
  Tệp đính kèm: <tên>
  <<<
  …nội dung…
  >>>
  ```
  nên agent không cần (và không được) truy cập tệp của người dùng trên đĩa.
- Bảo mật: kiểm tra Origin/Referer cho mọi request thay đổi trạng thái (CSRF), giới hạn kích thước
  (JSON 200 KB, tin nhắn 20.000 ký tự, 100 tệp/24 giờ/người), CSP chặt (không inline script), `nosniff`,
  `X-Frame-Options: DENY`, COOP/CORP, markdown được DOMPurify lọc, link mở tab mới với `noopener`.
  Tool `question` bị tắt cho prompt từ web; yêu cầu permission/question (nếu có) tự bị từ chối để run không treo.
- Giao diện: đen – trắng – xám với đỏ FTU #C20B11 làm màu nhấn duy nhất (nút chính, logo, liên kết, viền focus), sáng/tối (theo hệ thống hoặc chọn tay), font Be Vietnam Pro (tự host), hiệu ứng chuyển
  trang, tin nhắn, con trỏ khi stream, “Các bước tra cứu” thu gọn được, skeleton, toast, kéo thả tệp,
  nút cuộn xuống, sidebar trượt trên mobile; tôn trọng `prefers-reduced-motion`.

## Trang công khai, thương hiệu và SEO (v6)
- **Landing** `/` (vi) và `/en`: người chưa đăng nhập thấy landing; người đã đăng nhập vào `/` là vào thẳng ứng dụng (cuộc trò chuyện mới), `/en` chuyển về `/`.
  Các trang `/brand`, `/en/brand` (noindex), `/privacy`, `/terms` (+ `/en/…`, **bản nháp**). Mã: `client/src/site/` (Landing, BrandPage, LegalPage, Site = header/footer/endorsement,
  `tokens.js` = token màu / kiểu chữ, `config.js` = **`CONTACT_EMAIL` (đang là placeholder, cần điền)**, danh sách nguồn, video), CSS `site/site.css`, lớp thương hiệu cho app `styles-brand.css`.
- **Prerender** (`scripts/prerender.mjs`, chạy trong `npm run build`): build `client/src/ssr.jsx` bằng Vite SSR, `renderToString` từng trang → `client/dist/_site/<trang>-<vi|en>.html` với head đầy đủ
  (title / description riêng theo ngôn ngữ, canonical, hreflang vi / en / x-default, Open Graph + Twitter card với `og-image-vi|en.png`, JSON-LD Organization (FTU Tech Lab → CollegeOrUniversity),
  WebSite, SoftwareApplication, FAQPage, VideoObject (từ `public/media/video-meta.json`), BreadcrumbList cho trang con). `{{ORIGIN}}` / `{{ROBOTS}}` được `server/site.mjs` điền theo từng request.
  Trình duyệt hydrate đúng markup đó (`main.jsx`: `hydrateRoot` khi `#root[data-ssr]`); các màn hình app tải lười (`React.lazy`) nên landing chỉ tải phần cần thiết. Font Be Vietnam Pro tự host (`@fontsource`, preload).
- **robots.txt / sitemap.xml** (`server/site.mjs`): trên host tạm hoặc khi chưa đặt `SITE_URL` → `Disallow: /` và mọi phản hồi `X-Robots-Tag: noindex, nofollow`; với tên miền thật → cho phép trang công khai,
  chặn `/api/ /c/ /s/ /admin /expert /login /register`, sitemap gồm landing + privacy + terms (vi/en, có xhtml:link hreflang). App / đăng nhập / chia sẻ / API luôn noindex.
- **Thương hiệu**: `node scripts/brand-build.mjs` sinh logo SVG/PNG (mọi biến thể), favicon.svg/.ico, apple-touch-icon, icon PWA + maskable, site.webmanifest, ảnh OG, gói zip;
  `node scripts/brand-contrast.mjs` kiểm tra tương phản WCAG của các cặp màu. Tóm tắt: `../docs/BRAND.md`. Logo Trường ĐH Ngoại thương (`public/brand/ftu-logo.png`) giữ nguyên tệp chính thức, chỉ dùng ở khu vực ghi nhận.
- **Ảnh sản phẩm & video demo** (`scripts/demo-video/`): harness riêng (bản sao server trên :3103 + `replay-oc.mjs` giả lập opencode trên :4198 phát lại **các cuộc trò chuyện thật đã ghi**,
  xuất read-only từ bản sao DB bằng `export-recordings.mjs`; dữ liệu harness ở `$HARNESS_DIR`, không đụng dữ liệu production). `harness-reset.sh` → `capture-media.mjs` (ảnh .webp sáng/tối cho landing)
  → `record.mjs` (Chrome headless riêng, CDP screencast) → `encode.mjs` (ffmpeg-static: MP4 H.264 + WebM VP9 1280×720, tua nhanh phần chờ, poster, phụ đề WebVTT vi/en = `landing.demo.transcript`).
- QA: `responsive-qa.mjs` có thêm màn hình `landing`, `landing-menu`, `brand`, `privacy`, `terms` (16 kích thước, `QA_LOCALE=vi|en`).

## Phiên bản (sửa tin nhắn / tạo lại) – mô hình nhánh
- Mỗi **phiên bản** của cuộc trò chuyện là một session opencode riêng (bảng `branches`: `parent_id`, `fork_turn`, `kind` = root | edit | regenerate).
- Sửa lượt k hoặc tạo lại câu trả lời lượt k: backend gọi `POST /session/:id/fork` tại tin nhắn người dùng của lượt k
  (opencode sao chép **các tin nhắn trước** tin nhắn đó), tạo nhánh mới, chuyển nhánh đang hiển thị (`chats.active_branch_id`)
  rồi gửi prompt đã sửa (hoặc y nguyên – giữ cả khối tệp đính kèm) vào session mới. Session cũ không bị sửa → phiên bản cũ luôn xem lại được.
- Bộ chuyển `‹ n/m ›` ở lượt k: các nhánh có chung lượt 0..k-1 với nhánh đang xem được nhóm theo nội dung lượt k
  (hai nhánh cùng một phiên bản nếu chung cả lượt k); mỗi phiên bản mở nhánh xem gần nhất của nó. Luồng SSE của cuộc trò chuyện tự đi theo nhánh đang hiển thị.

## Các màn hình
Đăng nhập / Đăng ký (kiểm tra trường, độ mạnh mật khẩu, Caps Lock, “Quên mật khẩu?” → hướng dẫn liên hệ quản trị viên – không có email),
trò chuyện (trạng thái trống, stream, phiên bản, báo cáo bên phải, chia sẻ), tìm kiếm (Ctrl/⌘+K – tiêu đề + nội dung, FTS5 không dấu),
Cài đặt (Chung / Tài khoản / Dữ liệu / Giới thiệu), trang chia sẻ công khai `/s/<token>` (noindex, thu hồi được), Quản trị `/admin`
(chỉ admin: người dùng, tạo, đặt lại mật khẩu một lần, khoá/mở, xoá, bật/tắt đăng ký, thống kê, trạng thái agent),
404, lỗi giao diện, ngoại tuyến / mất kết nối / bảo trì agent, bảng phím tắt (`?`).


## Tài liệu tạo bởi agent (document_create)
Tệp nằm ở `../.sandbox/outputs/<sessionID>/`. Thẻ tài liệu trong câu trả lời: Xem trước (panel bên phải, trang A4, sheet toàn màn hình trên mobile),
tải .docx / .pdf. `GET /api/artifacts/:chatId/:artifactId/preview` (HTML, CSP không script + sandbox) và `…/download/docx|pdf|md`
(tên tệp tiếng Việt qua `filename*`), chỉ chủ cuộc trò chuyện hoặc trang chia sẻ chứa tài liệu đó; tên tệp chỉ lấy trong thư mục của phiên.

### Phiên bản tài liệu (document_edit / document_read)
- Mỗi lần sửa là một bản mới (id mới) nối bằng `root_id` / `parent_id` trong metadata; `version`, `origin` (agent | upload), `changes`,
  tệp `redline` (`<base>.thay-doi.docx`, Word Track Changes) và `original` (tệp gốc của upload). Marker `[[artifact:…]]` được lọc theo danh sách trắng
  (`artifactDescriptor` trong `server/events.mjs`), chuỗi bị cắt độ dài, id kiểm tra theo regex.
- `GET /api/artifacts/:chat/:id/versions` → chuỗi phiên bản (mọi metadata cùng `root_id` trong các session của cuộc trò chuyện, v1 → vn);
  `GET …/diff?against=<id>` → diff theo từ, tính ở server (`server/diff.mjs`: Myers theo dòng rồi theo từ; luôn bản cũ → bản mới; mặc định so với bản cha);
  `…/download/redline` (tên `<tiêu đề> - thay đổi (v<n>).docx`), `…/download/original` (chỉ tài liệu từ upload). Cùng quy tắc truy cập: chủ cuộc trò chuyện,
  hoặc trang chia sẻ – với chia sẻ, chuỗi phiên bản và diff chỉ gồm các bản có trong snapshot.
- Thẻ tài liệu: “phiên bản n”, bộ chuyển ‹ v1 v2 v3 ›, danh sách thay đổi, Xem trước / So sánh với bản trước (panel diff: chữ thêm gạch chân xanh,
  chữ xoá gạch ngang đỏ, công tắc “Chỉ hiện chỗ thay đổi”) / tải .docx .pdf / bản đánh dấu thay đổi / tệp gốc.
- Tệp tải lên (.docx .pdf .md .txt): khi gửi, backend gọi `importDocument` của `../.opencode/lib/doc-store.ts` (import động, tự nạp lại khi tệp đổi;
  không có module → bỏ qua) cho session hiện tại, lưu ánh xạ ở bảng `upload_docs`, và ghi `Tệp đính kèm: <tên> (mã tài liệu: <id> – có thể sửa bằng document_edit)`
  vào đầu khối đính kèm. Khi nhập, `normalizeImported` chỉ thêm ký hiệu markdown (không đổi chữ, nên `find` chép từ tệp vẫn khớp; chạy lại cho cùng kết quả):
  Quốc hiệu – Tiêu ngữ ở đầu → `national_header` (vẽ như `document_create`, không lặp), tên văn bản IN HOA → `#`, `Phần/Chương …` → `##`, `Điều N.` → `##` (`###` khi có Chương),
  khối `ĐẠI DIỆN BÊN A / ĐẠI DIỆN BÊN B` (+ “(Ký, …)”) ở cuối, dạng đoạn hoặc bảng 2 cột → bảng chữ ký. Nhãn thay đổi hiểu khoản kiểu `10.2.` (= Điều 10 khoản 2) và điểm `a)`,
  gộp nhãn trùng: “Sửa Điều 10 khoản 2, 3, 4”, “Sửa Điều 10 khoản 5 (2 chỗ)”, “Sửa Điều 10 (4 chỗ)”. Tin nhắn người dùng hiện thẻ tài liệu kèm ghi chú “Định dạng theo mẫu chuẩn của hệ thống, không giữ định dạng gốc”.
- Sửa tin nhắn / tạo lại: ngay sau `fork`, backend gọi `inheritSession(cha, con)` để phiên bản mới vẫn sửa được tài liệu của phiên cha.
- Kiểm thử: `node scripts/ui-test-v3-docs.mjs <email> <mk> <chatId có tài liệu nhiều phiên bản> [shareToken]` → `screenshots/v3-doc-*.png`;
  QA đáp ứng có thêm màn hình `doc-versions`, `doc-diff`, `doc-diff-only` (đặt `QA_DOCV=<chatId>`).

## Độ tin cậy tính từ bằng chứng
Huy hiệu dưới mỗi câu trả lời = kết quả `grounding_check` cuối cùng trong lượt đó (đọc `../.sandbox/cache/legalai/evidence/<sessionID>.jsonl`,
ghép theo thời gian, đi cả phiên cha của các phiên bản). Không có kết quả → “Chưa kiểm chứng tự động”. Độ tin cậy thấp → gợi ý “Nhờ chuyên gia xem lại”.

## Chuyển chuyên gia
- Vai trò **chuyên gia** (quản trị viên cấp trong màn hình Quản trị). Hàng đợi `/expert`: lọc trạng thái, phân trang, nhận xử lý / giao việc,
  xem toàn bộ hội thoại + nguồn, trả lời (markdown), đổi trạng thái mới → đang xử lý → đã trả lời → đóng.
- Agent tạo yêu cầu bằng `expert_escalate` → tệp `../.sandbox/escalations/<id>.json` được nhập (idempotent) vào SQLite; trạng thái và trả lời được ghi ngược vào tệp.
  Người dùng cũng bấm “Chuyển chuyên gia” trên bất kỳ câu trả lời nào.
- Trong chat: thẻ “Đã chuyển chuyên gia · YC-… · trạng thái” cập nhật trực tiếp, trả lời của chuyên gia hiện như tin nhắn “Chuyên gia”;
  chấm chưa đọc trên sidebar, thông báo cho chuyên gia khi có yêu cầu mới.

## Đa ngôn ngữ (Tiếng Việt / English)
- Lớp i18n nhỏ tự viết, không thêm thư viện: `client/src/i18n.jsx` (`t("ns.key", { var })`, số nhiều CLDR qua `Intl.PluralRules` – khoá `key_one` / `key_other`,
  `<Trans>` cho chữ có `<b>…</b>`, `useT()` / `useLocale()`, định dạng ngày / số / thời gian tương đối / dung lượng theo `Intl`). Từ điển: `client/src/locales/vi.json`, `en.json`
  (namespace: app, common, auth, sidebar, chat, composer, tools, sources, confidence, report, docs, expert, admin, settings, search, share, shortcuts, states, about, followups…).
- Giá trị dữ liệu cố định bằng tiếng Việt (trạng thái / mức khẩn của yêu cầu chuyên gia, mức tin cậy, cụm xác nhận xoá…) nằm ở `client/src/codes.js`, nhãn hiển thị lấy từ từ điển.
- Chọn ngôn ngữ: lần đầu theo `navigator.language` (vi* → vi, còn lại → en); nút VI | EN ở trang đăng nhập / đăng ký / chia sẻ và Cài đặt → Chung.
  Lưu ở `localStorage` (`nd45-locale`) và theo tài khoản (cột `users.locale`, `PUT /api/account/settings { locale }`); chọn ở trang đăng nhập ngay trước khi đăng nhập thì thắng giá trị đã lưu.
  `<html lang>`, tiêu đề trang và mô tả được cập nhật; `public/theme-init.js` đặt `lang` trước khi vẽ.
- Server: mọi phản hồi JSON có `error` được dịch theo `X-UI-Locale` (client gửi kèm mọi request) → `users.locale` → `Accept-Language` → vi, kèm `code` ổn định
  (`server/i18n.mjs`: bảng thông báo tiếng Việt → code + tiếng Anh; code cũ như `agent_down` giữ nguyên). Lỗi luồng trả lời gửi `code`/`errorCode` để client tự dịch.
  Tên tệp bản đánh dấu thay đổi, tiêu đề mặc định, Markdown / README của tệp xuất dữ liệu theo ngôn ngữ người dùng.
- Prompt gửi agent có thêm hai dòng ẩn cuối phần chữ người dùng (ẩn khi hiển thị lại, giống khối tệp đính kèm):
  `Ngôn ngữ giao diện: <vi|en>` và `Thời điểm người dùng gửi: <ISO +07:00> (Asia/Ho_Chi_Minh)`. Tạo lại câu trả lời dùng ngôn ngữ / thời điểm hiện tại.
- Tài liệu: thẻ hiện nhãn ngôn ngữ VI / EN / VI–EN từ trường `language` (vi | en | bilingual; thiếu = vi), được `artifactDescriptor` cho qua.
- Kiểm tra: `node scripts/i18n-check.mjs` (khoá vi/en khớp nhau, placeholder / thẻ khớp nhau, mọi khoá dùng trong code tồn tại, không còn chữ tiếng Việt cứng trong `client/src`;
  dòng dữ liệu cố định đánh dấu `// i18n-ignore` hoặc tệp `/* i18n-ignore-file */`). QA đáp ứng: `QA_LOCALE=en node scripts/responsive-qa.mjs`.
  API: `APP_URL=<harness> node scripts/i18n-api-test.mjs`; ảnh: `QA_LOCALE=en|vi node scripts/ui-test-v5-i18n.mjs` → `screenshots/v5-*.png`.

## Gợi ý câu hỏi tiếp theo
- Sau mỗi lượt trả lời hoàn tất (không lỗi / không bị dừng), server gọi **một** lần chat-completions ngắn tới cùng model / nhà cung cấp của nền tảng
  (model từ `/config` của opencode, baseURL + khoá từ `../opencode.json` và `../.env`, chỉ ở server) → N câu hỏi ≤ 90 ký tự theo ngôn ngữ giao diện, lọc câu hỏi trái pháp luật, hết hạn 20 s, lỗi thì bỏ qua.
- Lưu theo (session phiên bản, lượt) ở bảng `followups`; gửi qua SSE (`followups`, có trạng thái đang tạo). Quản trị: “Gợi ý câu hỏi tiếp theo” 0–5 (0 = tắt, mặc định 3, `app_settings.followupCount`);
  người dùng tắt được trong Cài đặt → Chung (`showFollowups`). Chỉ hiện dưới câu trả lời mới nhất, không hiện trên trang chia sẻ.

## Câu hỏi làm rõ (thẻ lựa chọn, v7)
- Agent hỏi lại người dùng bằng công cụ `question` (giao thức: `../docs/QUESTION_TOOL.md`). Backend khởi động serve với
  `ND45_QUESTION_TOOL=1` (run.sh bật công cụ + quyền), không còn gửi `tools:{question:false}`, và thêm một dòng `system`
  (vi/en theo ngôn ngữ giao diện) nhắc gọi `question` khi thiếu thông tin làm thay đổi hẳn kết quả (tối đa 3 câu).
- Sự kiện: `question.asked` → `{type:"question", id, messageID, callID, questions}`; `question.replied` / `question.rejected` →
  `question.replied` / `question.rejected`. Phần công cụ `question` trong lịch sử: `questions`, `qstate`
  (pending | answered | dismissed | stopped), `answers`; lịch sử gắn `requestID` cho câu đang chờ (khớp `GET /question` theo `callID`),
  câu "running" không còn request (server khởi động lại / mồ côi) → `stopped`. Câu hỏi và lựa chọn đều qua `scrubText`, bị cắt độ dài.
- API (chỉ chủ cuộc trò chuyện, id phải thuộc một phiên bản của chat, người khác 404): `POST /api/chats/:id/questions/:qid/reply`
  `{answers: string[][]}` (≤ max(5, số câu) mảng, mỗi mảng ≤ 20 chuỗi ≤ 500 ký tự) và `/reject`. Dừng (abort) từ chối câu đang chờ trước rồi mới abort.
- Giao diện (`QuestionCard.jsx`, `styles-v7.css`): chip tiêu đề, câu hỏi, lựa chọn dạng thẻ (radio / checkbox khi `multiple`), ô "Khác…" khi
  `custom !== false`, lựa chọn "(Khuyến nghị)" có nhãn; nhiều câu → bước (tab) + Tiếp / Quay lại / Gửi; "Bỏ qua" = reject. Phím: mũi tên, 1–9,
  Enter. Thẻ tự nhận focus khi xuất hiện. Khi đang chờ, ô soạn tin hiện gợi ý và nội dung gõ vào được gửi làm câu trả lời tự do cho câu chưa trả lời đầu tiên.
  Sau khi trả lời → tóm tắt gọn "Bạn đã chọn: …". Trang quản trị (chỉ xem) / chia sẻ: chỉ đọc.
- Thống kê quản trị: `waitingOnQuestion` = số lượt đang chờ người dùng trả lời (đã tính trong `activeRuns`; một lượt như vậy không có hạn chờ).
- Kiểm thử: `node scripts/question-ui-test.mjs <email> <mật khẩu>` (env `APP_URL`, `LOCALE`, `COMPOSER_ANSWER`, `KEEP_PENDING`);
  màn hình QA `question-answered` (`QA_QUESTION`) / `question-pending` (`QA_QPENDING`).

## Kiểm chứng tự động bởi hệ thống + tự tra lại (v7)
- `server/grounding.mjs`: khi một lượt chạy kết thúc (idle), nếu lượt không có `grounding_check` hoàn tất nhưng câu trả lời có nội dung
  pháp lý (Điều/khoản, tên luật/nghị định, link, số hiệu văn bản, %, số tiền – ngày giờ đơn thuần **không** tính), server chạy **chính**
  công cụ `grounding_check` (import chỉ đọc `../.opencode/tools/grounding.ts`, bằng chứng của phiên) trên câu trả lời cuối, ghi thêm
  verdict `origin:"server"` kèm danh sách mục chưa có căn cứ, và phát sự kiện `confidence` → badge "… · kiểm chứng tự động bởi hệ thống".
- Mức THẤP (của model hoặc của server): cảnh báo dưới câu trả lời liệt kê các mục chưa có căn cứ + nút "Nhờ chuyên gia xem lại"; khi được phép (xem dưới)
  **một** lượt tra lại trong cùng phiên: prompt ẩn (part `synthetic`, bắt đầu bằng `[[kiem-chung-tu-dong]]`, không hiện là tin nhắn người dùng,
  không tính là lượt – lịch sử / sửa / tạo lại bỏ qua nó). Sự kiện `repair` → dòng trạng thái "Đang tra lại để kiểm chứng…"; các tin nhắn
  trả lời sau prompt ẩn có `repair:true` → giao diện hiện "Đã tra lại và cập nhật", câu trả lời ban đầu thu gọn phía trên. Tối đa 1 lần / lượt
  (lượt đã có prompt ẩn thì không tra lại nữa). Gợi ý câu hỏi tiếp theo chạy sau lượt tra lại.
- Quản trị → Hệ thống: `serverGrounding` (mặc định bật) và `autoRepairLowConfidence` = "Cho phép tự tra lại khi độ tin cậy thấp" (`app_settings`).
- Tra lại là **tuỳ chọn** (27/09/2026): `autoRepairLowConfidence` mặc định **tắt**; lần khởi động đầu của bản này đổi giá trị cũ (chưa đặt / `true` = mặc định cũ) thành `false`
  (đánh dấu `autoRepairOptInMigrated`). Khi quản trị viên bật: `/api/meta` trả `autoRepair: true` → người dùng có công tắc "Tự tra lại" ở ô soạn tin (cạnh nút đính kèm; ≤ 360 px chỉ còn biểu tượng)
  và trong Cài đặt → Chung ("Tự tra lại khi độ tin cậy thấp", `settings.autoRepair`, mặc định tắt, theo tài khoản, áp cho mọi cuộc trò chuyện của họ);
  cảnh báo THẤP của câu trả lời mới nhất có nút "Tra lại ngay" → `POST /api/chats/:id/repair` (một lần / lượt; 403 `repair_disabled` khi quản trị tắt, 409 `repair_done` / `repair_not_low` / `repair_nothing`).
  Tự tra lại chỉ chạy khi quản trị cho phép **và** chủ cuộc trò chuyện bật (`autoRepairFor()`, kiểm ở server); `GET|PUT /api/account/auto-repair` (`PUT` 403 khi quản trị tắt; `PUT /api/account/settings {autoRepair:true}` cũng 403).
  Quản trị tắt lại → công tắc ẩn, lựa chọn đã lưu không còn tác dụng. Kiểm tra: harness tra lại (prompt `LOWCONF`), cảnh `repair` của `lang-leak-check.mjs` (`QA_ADMIN`, `QA_ADMIN_PW`),
  QA `repair-composer|repair-low` (`QA_REPAIR=1`, `QA_REPAIR_LOW`); ảnh `screenshots/v11-repair-*.png`.

## Không nêu tên model với người dùng (quyết định sản phẩm, 26/09/2026)
- Mọi chỗ người dùng thấy (header, chân ô soạn tin, Giới thiệu & giới hạn, Cài đặt, trang chia sẻ, tệp xuất, lỗi, landing / FAQ, /privacy, /terms, meta / JSON-LD, video)
  chỉ nói chung “mô hình AI do FTU Tech Lab triển khai” (nhãn ngắn “Mô hình AI của FTU Tech Lab”); không tên nhà phát triển / model / nhà cung cấp, không cloud / tự host.
  `/api/meta` trả `model: { name: "FTU Tech Lab AI model" }` (đã đăng nhập) – không có tên thật. Lỗi của nhà cung cấp chỉ ghi log server, người dùng thấy câu chung
  (“Mô hình AI tạm thời không phản hồi…”), không chuyển `detail`. `about_self` của agent cũng mô tả chung (không đọc opencode.json).
- Model thật chỉ hiện cho quản trị viên: thẻ trạng thái agent và mục “Mô hình AI (chỉ quản trị viên)”.

## Chọn model (chỉ quản trị viên)
- Quản trị → “Mô hình AI (chỉ quản trị viên)”: danh sách model đọc động từ các provider trong `../opencode.json` (không sửa tệp đó), nút **Kiểm tra** (một lượt chat-completions nhỏ
  kèm 1 tool schema tới provider, baseURL + khoá từ opencode.json / `../.env`, chỉ ở server; trả độ trễ và có gọi tool đúng không – không bao giờ trả / ghi khoá) và **Đặt làm mặc định**.
- Lưu ở `app_settings.agentModel` = `providerID/modelID`; mỗi prompt (tin nhắn mới, sửa, tạo lại) gửi `model: { providerID, modelID }` trong body `prompt_async` (opencode 1.18);
  gợi ý câu hỏi tiếp theo dùng cùng model của lượt đó. Chưa đặt / model không còn trong cấu hình → `model` của opencode.json. API: `GET /api/admin/models`, `POST /api/admin/models/test`,
  `PUT /api/admin/models/active` (403 với người không phải admin). Mã: `server/models.mjs`.
- Gợi ý câu hỏi: `reasoning_effort: "none"` bị vLLM (GPUStack) từ chối (400) → tự gửi lại không có trường đó.

## Cảnh báo thông tin định danh
- Luôn bật (không phụ thuộc model): trước khi gửi, client dò nhẹ số CCCD (12 số), hộ chiếu, số tài khoản cạnh “STK / số tài khoản”, số điện thoại; tệp tải lên được server dò cùng quy tắc
  (`upload.pii` chỉ trả về loại, không bao giờ trả / ghi giá trị). Cảnh báo không chặn: “Tin nhắn có vẻ chứa thông tin định danh cá nhân (…). Chỉ gửi khi thật cần thiết.” – “Gửi” / “Sửa”.
  Chân trang có liên kết “Giới thiệu & giới hạn”.

## Phân trang
Cursor: `/api/chats?cursor=` (30/trang, ghim trả kèm trang đầu), `/api/search?cursor=`, `/api/shares?cursor=`; lịch sử chat theo lượt
(`/api/chats/:id/messages?beforeTurn=k`, 20 lượt/trang, tải khi cuộn lên và giữ vị trí). Đánh số: `/api/admin/users?page=&size=`,
`/api/expert/escalations?page=&size=` (20/50/100, bộ lọc giữ trên URL).

## Kiểm thử giao diện đáp ứng
`node scripts/responsive-qa.mjs` (biến QA_* trong đầu tệp): mọi màn hình × 16 kích thước; kiểm tra tràn ngang, phần tử bị cắt,
hộp thoại/menu nằm trong màn hình, ô nhập luôn thấy được. Kết quả chi tiết ở `../.sandbox/web/responsive-qa.json`.

## Khởi động lại an toàn
Chỉ dừng tiến trình node đang nghe 127.0.0.1:3000 và các PID trong `../.sandbox/web/opencode.pid.json` sau khi kiểm tra dòng lệnh chứa
`serve --port <cổng trong tệp>`. Không dừng opencode.exe theo tên – các phiên agent khác có thể đang chạy.

## Kiểm thử
```bash
# cần app đang chạy (npm start) và một tài khoản
node scripts/ui-test.mjs <email> <mật-khẩu> ["câu hỏi"]
node scripts/ui-test-v2.mjs <email> <mk> <admin-email> <admin-mk> [chatId có phiên bản]   # mọi màn hình v2 → screenshots/v2-*.png
#   ONLY=auth,cite,report,versions,dialogs,mobile,admin,race để chạy từng phần
#   UI_ATTACH=<tệp> để chụp thêm chip đính kèm; ảnh chụp ghi vào screenshots/
```
Script dùng `puppeteer-core` của dự án và một Chrome headless **riêng** (profile trong `../.sandbox/web/ui-test-profile`). Không chạy test UI trong Chrome sandbox của agent (cổng 9333): các công cụ `chrome_*` của agent nhìn thấy và có thể thao tác mọi tab trong Chrome đó.

## Giới hạn đã biết
- Mọi session opencode dùng chung thư mục `../workspace`; agent vẫn có quyền đọc/ghi ở đó (theo cấu hình
  opencode hiện tại), nên về lý thuyết một cuộc trò chuyện có thể thấy tệp mà agent ghi ra cho cuộc trò chuyện khác.
- Rate limit lưu trong bộ nhớ (mất khi khởi động lại).
- Xuất dữ liệu chỉ gồm phiên bản đang hiển thị của mỗi cuộc trò chuyện; tìm kiếm quét mọi phiên bản.
- PDF xuất bằng hộp thoại in của trình duyệt (“Lưu dưới dạng PDF”), không tạo tệp PDF phía server.
- Tệp tải lên không tự dọn. PDF scan (không có lớp chữ) được OCR (v11) – chỉ `ND45_OCR_MAX_PAGES` trang đầu (mặc định 15), chữ có thể sai dấu; OCR tắt / không dùng được → bị từ chối như trước.
  PDF có lớp chữ rỗng mới được OCR (lớp chữ rác vài ký tự thì không).
- Tài liệu nhập từ tệp tải lên chỉ gồm phần chữ đã trích (tối đa 60.000 ký tự, định dạng theo mẫu chuẩn); .docx giữ tiêu đề, đậm/nghiêng, danh sách và bảng (ô gộp bị tách, không giữ màu/cỡ chữ/căn lề, đánh số tự động của Word trở thành danh sách 1., 2., …); .pdf chỉ có chữ. Metadata upload cũ giữ nguyên (nhãn thay đổi đã lưu không tính lại).
  Việc nhập chạy đồng bộ khi gửi tin nhắn (tối đa 30 s/tệp, gồm cả tạo .docx/.pdf); quá hạn → tin nhắn vẫn gửi, chỉ không có mã tài liệu.
- So sánh phiên bản dựa trên markdown (ký hiệu `#`, `**` được lược khi hiển thị), không so định dạng Word; bản đánh dấu thay đổi .docx do doc-store tạo.
- `doc-store.ts` được nạp lại khi tệp đổi, nhưng các module nó import (`evidence.ts`, `docx`, …) chỉ nạp lại khi khởi động lại server.
- Bộ chuyển phiên bản trên thẻ hiển thị mọi phiên bản cùng gốc trong cuộc trò chuyện, kể cả bản tạo ở nhánh (phiên bản hội thoại) khác.
- Tên provider trong màn hình Quản trị bỏ phần ghi chú trong ngoặc của opencode.json.

## Tách ngôn ngữ giao diện / dữ liệu (v8, 27/09/2026)
- Nguyên tắc: mọi chữ "khung" (nhãn, trạng thái, bộ đếm, đơn vị, ngày, số) theo ngôn ngữ giao diện; dữ liệu nguồn trích nguyên văn (câu truy vấn, tên luật / điều, tên văn bản,
  mô tả mã HS, tiêu đề trang, câu trả lời của mô hình, nội dung người dùng) giữ ngôn ngữ gốc nhưng được đánh dấu là dữ liệu (`<Data>` trong `components/DataText.jsx`:
  ngoặc kép / nghiêng + nhãn nhỏ VI / EN khi khác ngôn ngữ giao diện, thuộc tính `data-lang` / `data-source`).
- Bước công cụ: server gửi `step = { args, res }` có cấu trúc (`server/stepview.mjs`: `{t:"art", n}`, `{t:"q", v, lang}`, `{t:"count", n, unit}`, `{t:"status", code}`…),
  client dựng câu bằng `t()` (`components/StepParts.jsx`). Bản ghi cũ (chia sẻ trước đây) được chuyển bằng `legacyStep()` trong `codes.js`. Lỗi bước: `errorInfo {code, detail}`.
- Thẻ kết quả `v: 2` (`server/resultcards.mjs`): số dạng chuỗi thập phân thô, ngày ISO, mã nguồn / cột / cảnh báo – client định dạng bằng `Intl`. Thêm thẻ biểu thuế (tariff_vn / us / eu).
- Công cụ (`.opencode/tools/*.ts`) trả thêm `metadata.ui` (qua `withUi` trong `.opencode/lib/ui-meta.ts`; văn bản cho mô hình giữ nguyên). `tool` của `ui-meta.ts` bọc
  `@opencode-ai/plugin`: gọi trực tiếp (test, web server, công cụ khác – không có `messageID`) vẫn nhận chuỗi như cũ. Không có metadata (phiên cũ) → server phân tích văn bản.
- Nguồn: `statusCode`, `issuedIso` / `accessedIso`, `agencyCode`; độ tin cậy: `why` (mã lý do, `whyOf()` chuyển câu cũ); thay đổi tài liệu: `artifact.changes` có cấu trúc;
  yêu cầu chuyên gia: `reasonCode`, `summaryParts`; thư viện: mô tả ngắn `library.tool.*` / `library.skill.*`, mô tả gốc trong "Mô tả kỹ thuật", nhóm "Biểu thuế".
- Kiểm tra: `node scripts/test-resultcards.mjs`; `APP_URL=<harness> QA_USER=… QA_PW=… node scripts/lang-leak-check.mjs` (Chrome headless riêng; harness phát lại phiên thật:
  prompt `LANG` = đầu ra cũ, `LANGNEW` = đầu ra công cụ mới có `metadata.ui`, `Soạn …` = soạn văn bản dài; `SHOTS=1` → `screenshots/v8-lang-<TAG>-*.png`).

## Tra cứu / đối chiếu doanh nghiệp (v9, 27/09/2026)
- Công cụ `company_lookup` / `company_verify` (`../.opencode/tools/company.ts`) trả `metadata.ui`: bước có `res {t:"status", code}` (mã mới trong `STATUS_CODES` của
  `server/stepview.mjs`: manual_required, invalid_code, personal_id, parsed, co_<tình trạng>, verify_match|partial|mismatch; nhãn `tools.status.*` / `cards.company.*`);
  tham số bước chỉ hiện MST hoặc tên – không bao giờ hiện `official_text` hay thông tin bên ký.
- Thẻ `kind:"company"` (`companyCard()` trong `server/resultcards.mjs`, lọc từng trường): MST + huy hiệu định dạng; `manual_required` → thông báo "Nguồn chính thức yêu cầu mã xác thực – hãy tự tra",
  nút mở từng cổng chính thức (chỉ host dkkd.gov.vn / dangkykinhdoanh.gov.vn / gdt.gov.vn, thẻ mới, rel=noopener) + 3 bước; dữ liệu doanh nghiệp (tình trạng tô màu xanh / hổ phách / đỏ,
  `origin` user_paste → ghi chú nguồn; aggregator → cảnh báo "Nguồn không chính thức…", danh sách `sources`, dấu `crossCheck` từng mục); verify → bảng từng mục (xếp dọc khi thẻ hẹp,
  container query) + rủi ro dựng bằng ngôn ngữ giao diện từ kết quả có cấu trúc (`risks` là số → chỉ đếm). Số định danh cá nhân không bao giờ được hiển thị lại.
- Nguồn tham khảo không chính thức (infodoanhnghiep.com, doanhnghiep.biz): `basis:"aggregator"`, `status` vẫn manual_required → thẻ hiện khối dữ liệu tham khảo + nút cổng chính thức để xác nhận (không hiện trạng thái "tự tra"); `company.conflicts` → mục "Chưa thống nhất giữa các nguồn" kèm giá trị từng trang (`crossCheck.values[{domain, v}]`); `sources[].updated` = ngày trang ghi cập nhật; `candidates` (tra theo tên) → danh sách MST gợi ý "Tra mã này"; `skipped` → dòng mờ lý do bỏ qua. Mã bước `unofficial`, `unofficial_match|partial|mismatch`; verify → "Đối chiếu với nguồn không chính thức", ô gần khớp = "Gần khớp / chưa rõ".
- Thư viện: nhóm "Doanh nghiệp / Companies", mô tả `library.tool.company_*`, kỹ năng `company-lookup`.
- Kiểm tra: `node scripts/test-resultcards.mjs`; cảnh `company` của `lang-leak-check.mjs` (prompt `COMPANY …` của harness); QA `step-cards` với `QA_CARDS=<chat COMPANY>`; ảnh `screenshots/v9-company-*.png`.

## Trợ giúp xác minh trên trang chính thức (v10, 27/09/2026)
Khi trang chính thức cần xác minh người thật (Cục Thuế tracuunnt: mã xác nhận dạng ảnh; Cổng ĐKDN dichvuthongtin: reCAPTCHA), **người dùng tự thao tác** trên trang thật
qua một cửa sổ nhỏ phản chiếu trang đó, hệ thống theo dõi và tự tiếp tục. Công cụ **không bao giờ** tự giải / vượt CAPTCHA.
- Công cụ: `../.opencode/lib/assist.ts` `requestAssist({sessionID, url, purpose, prefill?, focus?, successWhen, timeoutMs=300000})` – browser context **riêng** (cookie không dùng chung giữa
  người dùng / phiên, đóng khi xong; context mồ côi do serve bị tắt được dọn ở lần sau – `<outputs>/_assist-contexts.json`), tab ngoài màn hình 1200×800, điền sẵn MST (không bao giờ điền ô mã xác thực),
  ghi `<outputs>/<sessionID>/assist/<assistId>.json` (`waiting_user` → `done | cancelled | timeout | error`), chờ `successWhen` (0,5 s/lần), đọc trang kết quả (bấm vào dòng kết quả để mở chi tiết).
  **Chặn điều hướng**: trang chính chỉ được ở dkkd.gov.vn / dangkykinhdoanh.gov.vn / tracuunnt.gdt.gov.vn / gdt.gov.vn; frame thêm Google reCAPTCHA; tài nguyên thêm gstatic / font; file:, chrome:, javascript:,
  địa chỉ nội bộ (loopback, mạng riêng, link-local, tên máy cục bộ) luôn bị chặn; điều hướng bị chặn trả 204 (trang đứng yên, cửa sổ báo "Đã chặn một liên kết…"); không tải tệp; popup bị đóng; alert/confirm bị đóng và hiện nội dung cho người dùng.
- `company_lookup` / `company_verify` (tham số `assist`, mặc định = `ND45_ASSIST === "1"`, tức bật khi chạy từ web, tắt ở CLI; `assist_source` = `gdt` (mặc định) | `dkkd`): thành công → hồ sơ `origin/basis: "official"`,
  bằng chứng ghi dưới tên miền chính thức (không có cảnh báo CAPTCHA / trang tổng hợp → `grounding_check` có thể đạt CAO), bộ lọc riêng tư như cũ (bỏ số CMT/CCCD, điện thoại…); dòng đầu ra cho mô hình
  "XÁC MINH TRÊN NGUỒN CHÍNH THỨC…" (mô hình nói ngắn gọn đã có bước xác minh); huỷ / hết giờ / không tìm thấy / không đọc được → như trước (trang tổng hợp + link + bước), thẻ có `assist.status`.
  Parser trang kết quả: `parseResultPage()` trong `company-core.ts` (bảng kết quả tracuunnt STT | MST | Tên người nộp thuế | Cơ quan thuế | … | Ghi chú + khung chi tiết; trang doanh nghiệp dkkd – theo nhãn).
- Server `server/assist.mjs`: theo dõi tệp (fs.watch + quét phiên có công cụ đang chạy) → sự kiện `assist` cho cuộc trò chuyện (chỉ kết nối của **chủ** cuộc trò chuyện; không có id target / phiên);
  `GET /api/chats/:id/assist` (danh sách 2 giờ gần nhất), `POST …/assist/:aid/cancel`, `GET …/assist/:aid/frame?after=&wait=` (long-poll 1 ảnh JPEG), `POST …/assist/:aid/input` `{ev:[…]}` (≤ 60 sự kiện),
  WebSocket `…/assist/:aid/ws` (ảnh JPEG nhị phân + JSON meta/status xuống; `{t:"in", ev}` lên; kiểm tra Origin = Host, cookie phiên; tối đa 4 kết nối/người dùng; ≤ ~16 khung hình/s mỗi người xem).
  CDP: một kết nối tới Chrome sandbox, `Target.attachToTarget` (flat) đúng tab của yêu cầu – kiểm tra tab thuộc context riêng ghi trong tệp và đang ở trang cho phép; `Page.startScreencast` JPEG q60, ≤ 1200 px;
  `Input.dispatchMouseEvent / dispatchKeyEvent / insertText` (toạ độ gửi dạng tỉ lệ 0..1 của khung hình, quy đổi theo viewport; phím F1–F12 và Ctrl/Cmd + phím ngoài A C V X Z Y bị bỏ; văn bản ≤ 200 ký tự; giới hạn 120 sự kiện, nạp lại 60/s).
  Chỉ khi trạng thái `waiting_user` (hết hạn → 410); người khác (kể cả quản trị viên) → 404. Ảnh chỉ nằm trong bộ nhớ (ảnh mới nhất), không ghi đĩa; ngừng screencast khi không ai xem 20 s hoặc yêu cầu kết thúc.
  Thư viện `ws` (có sẵn trong `../node_modules` qua puppeteer-core); thiếu → chỉ long-poll.
- Enter / thông báo của trang (sửa sau thử nghiệm thật 27/09): tracuunnt không có nút submit ("Tra cứu" là nút JS) nên Enter trong ô mã không làm gì → `enterClicks`: Enter của người dùng trong ô nhập = bấm đúng nút tìm kiếm của trang;
  sau mỗi lần tải trang, thông báo của trang (`DEFAULT_MESSAGES`: "Vui lòng nhập đúng mã xác nhận!"…) được ghi vào `notice` / `noticeAt` và hiện nổi bật trong cửa sổ; ô cần thao tác được cuộn lại vào giữa.
  Trang lỗi của chính trang chính thức (HTTP 429 "Too Many Requests" khi trang giới hạn số lượt tra theo IP, 5xx): công cụ ghi `pageError` / `pageStatus` (không tính là xong hay huỷ), cửa sổ hiện "Trang chính thức đang giới hạn số lượt tra – thử lại sau ít phút" + nút "Thử lại" (bật sau 20 s; `POST …/assist/:aid/reload` → `reloadAt`, công cụ tải lại biểu mẫu, cách nhau ≥ 15 s; tải trang chính thức cách nhau ≥ 5 s mỗi host).
  Nhật ký server: `[assist] WebSocket rejected <mã> …`, `[assist] <id> official page error: …`; công cụ: `[assist] <host> HTTP <mã>`. Client: một khung xem / yêu cầu mỗi tab (mở lại đóng socket cũ), lùi dần khi 429 / lỗi, không bao giờ hiện nội dung phản hồi lỗi.
  Kiểm thử trên trang thật (mã sai có chủ đích, không giải CAPTCHA): `node ../tools/test-assist-real.mjs` – kiểm tra đúng 1 ảnh mã / lần tải, focus đúng ô, ký tự gõ một lần đúng hoa/thường, trang nhận POST mst + captcha qua Enter và qua nút, thông báo lỗi của trang.
- Giao diện (`components/AssistPopup.jsx`, `assistView.js`, `styles-assist.css`): cửa sổ nổi min(900 px, 70vw) (kéo bằng thanh tiêu đề, đổi kích thước bằng góc dưới phải – nhớ trong `localStorage["legalai.assistSize"]`) – tên cổng + host + mục đích + đếm ngược + thu phóng − / % / + (mở ở 100–125 % trên vùng ô mã + ảnh + nút tìm; bấm nhãn % = xem cả trang) + "Mở trang chính thức ở tab mới" + đóng;
  thông báo "Trang chính thức yêu cầu xác minh bạn là người thật…", canvas phản chiếu (bấm / gõ trực tiếp; ô nhập ẩn nhận bàn phím, IME, dán, bàn phím điện thoại; Esc để thoát), "Huỷ".
  ≤ 640 px: sheet toàn màn hình, mặc định 100–125 % và cuộn tới ô cần thao tác (`focus` + `focusAlso`); chạm = bấm, kéo = cuộn. Xong → cửa sổ tự đóng + toast "Đã xác minh…"; trong luồng tin nhắn chỉ còn một dòng trạng thái
  ("Đang chờ bạn xác minh trên trang chính thức · Mở lại" → "Đã xác minh – đang đọc kết quả" → "Đã xác minh trên trang chính thức" / "Đã huỷ…" / "Hết thời gian…"). WebSocket trước (qua Cloudflare quick tunnel: đã thử,
  phím → khung hình mới ~110 ms), không có khung hình trong 4 s → long-poll (`?assistTransport=poll|ws` / `localStorage["legalai.assistTransport"]` để ép). Trang quản trị (chỉ xem) và trang chia sẻ không có khung xem.
- Kiểm thử: `node ../tools/test-assist.mjs` (chặn điều hướng, điền sẵn, sai mã, huỷ, hết giờ, abort, company_lookup / verify với trang thử `../tools/assist-fake-site.mjs`);
  trên harness (AI giả chạy công cụ thật): `APP_URL=… OUTPUTS=… node scripts/assist-test.mjs` (sự kiện, phạm vi quyền, WebSocket / long-poll, chuyển tiếp thao tác, giới hạn, huỷ, hết giờ),
  `node scripts/assist-ui-test.mjs` (Chrome headless đóng vai người dùng; `LOCALE`, `THEME`, `TRANSPORT`), cảnh `assist` của `lang-leak-check.mjs`, QA `assist-window|assist-zoom|assist-chip` (`QA_ASSIST`); ảnh `screenshots/v10-assist-*.png`.

## OCR bản scan (v11, 27/09/2026)
- Tải lên PDF không có lớp chữ → `server/extract.mjs` gọi `ocrUploadText` của `../.opencode/lib/pdf-ocr.ts` (Chrome OCR riêng :9334, ~2,5 s/trang, tối đa `ND45_OCR_MAX_PAGES` trang,
  một tệp một lúc – hàng đợi trong server + khoá liên tiến trình của pdf-ocr). `ND45_OCR=0`, module thiếu hoặc `OcrUnavailable` → lỗi cũ `pdf_no_text`; OCR lỗi khác → `pdf_ocr_failed` (đều dịch theo ngôn ngữ).
- Trạng thái: client gửi `X-Upload-Key` và hỏi `GET /api/uploads/progress/:key` (`extract` → `ocr-wait` → `ocr` (+ `pages`) → `done`) → chip "Đang đọc nội dung tệp…" / "Đang chờ nhận dạng chữ…" /
  "Đang nhận dạng chữ từ bản scan…" (thanh chạy vô định; số trang ở tooltip).
- Lưu `uploads.ocr` (JSON `{engine, pages, totalPages}`), phản hồi `upload.ocr`. Văn bản gửi cho agent bắt đầu bằng `OCR_LABEL` (mỗi trang "--- Trang n ---"); tiêu đề khối đính kèm có
  `(bản scan – văn bản nhận dạng OCR, n/tổng trang)` → `parseAttachmentHeader` trả `ocr {n,total}` cho viên thuốc tệp trong tin nhắn.
- `importUploads`: `importDocument` nhận thêm `ocr` (doc-store hiện bỏ qua) → server ghi `meta.ocr` vào tệp metadata của tài liệu (`markArtifactOcr`), `artifactDescriptor` trả `ocr {n,total}` (thẻ tài liệu);
  và ghi một bằng chứng `artifact://<id>` (hoặc `upload://<id>` khi không nhập được) `source:"artifact"`, `meta: {ocr:true, engine, ocr_pages, total_pages, warning}` (`server/ocr.mjs`, một lần mỗi phiên).
- Huy hiệu "OCR" (`components/OcrBadge.jsx`, tooltip "Đã nhận dạng OCR – có thể sai dấu/chữ" + số trang): chip tải lên, viên thuốc tệp, thẻ tài liệu; bước công cụ có `metadata.ui.ocr`
  (`step.ocr {pages}` từ `stepView`) và thẻ `web` (`card.ocr`). Lý do độ tin cậy `ocr_evidence` → "một số căn cứ chỉ có trong văn bản nhận dạng OCR – cần đối chiếu bản gốc".
- Kiểm tra: cảnh `ocr` của `lang-leak-check.mjs` (`OCR_PDF=<scan.pdf>[,<scan2.pdf>]`, prompt `OCRUP` / `OCRSTEP` của harness OCR), QA `ocr-chip|ocr-attach|ocr-steps`
  (`QA_OCR_PDF`, `QA_OCR`, `QA_OCR_STEPS`); ảnh `screenshots/v11-ocr-*.png`.

## Hình minh hoạ trong câu trả lời (v12, 27/09/2026)
- Công cụ agent (skill `visuals`, `archify`): `diagram_create({type: workflow|sequence|lifecycle|dataflow|architecture, ir, title, lang, caption?})` – Archify 2.16.0
  (vendored, MIT, `../.opencode/vendor/archify`, xem `THIRD_PARTY_NOTICES.md`) biên dịch IR → SVG hai chủ đề + PNG sáng/tối, tự sửa lỗi cơ học và trả dòng `[[diagram:<id>]]`;
  `image_search({query, sources?: official|commons, lang, page_url?})` → `image_fetch({url, caption, page_url?, lang})` (chỉ tên miền chính thức của `official-sources.ts` hoặc
  Wikimedia Commons CC0 / PD / CC BY / CC BY-SA; ≤ 5 MB, `image/*` + kiểm tra chữ ký tệp, WebP ≤ 1600 px, xoá EXIF) và `source_snapshot({url_or_doc, page?, region?})`
  (ảnh chụp trang / trang PDF chính thức hoặc tài liệu của cuộc trò chuyện) → `![chú thích](visual:<id>)` + dòng ghi công. Lưu ở `<outputs>/<sessionID>/visuals/<id>.json` (+ tệp),
  thư mục con nên không lẫn với tài liệu (`artifacts.mjs`).
- Server `server/visuals.mjs` (chỉ chủ cuộc trò chuyện / quản trị viên – có ghi nhật ký – hoặc trang chia sẻ chứa marker đó): `GET /api/visuals/:chat/:id/meta|image|frame|download/svg|png`
  và `/api/public/shares/:token/visuals/:id/…`. `frame` = trang HTML chỉ có SVG nội tuyến, CSP `default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`.
  Tệp SVG tải xuống có CSP `sandbox`. Chia sẻ: phần công cụ trong snapshot giữ `visual {id, kind}`; id hợp lệ = marker trong chữ + các phần đó.
- Không hotlink: `scrubText` (`sanitize.mjs` → `unhotlinkImages`) đổi mọi `![…](http…)` của mô hình thành link thường và bỏ `<img>`; phía trình duyệt `renderMarkdown` chỉ tạo ảnh cho `visual:<id>`,
  ảnh ngoài → link. CSP chính giữ `img-src 'self' data: blob:`.
- Giao diện (`components/Visuals.jsx`, `styles-visuals.css`; `RichHtml` thay `div.md` của câu trả lời và báo cáo): sơ đồ trong `<iframe sandbox="">` theo tỉ lệ khung của SVG
  (≤ 640 px: giữ độ rộng đọc được, cuộn ngang trong khung), "Mở toàn màn hình", "Tải PNG" (theo chủ đề đang dùng) / "Tải SVG"; ảnh `loading="lazy"`, chú thích + dòng ghi công
  (tác giả – giấy phép, nguồn, link trang nguồn / giấy phép), bấm để phóng to (lightbox, Esc / nút đóng, giữ focus); dòng ghi công mô hình chép vào chữ được ẩn (hình đã hiện).
  Khối ```mermaid: `mermaid` 12.0.0 đóng gói cục bộ (chunk tải lười), `securityLevel: "strict"`, `htmlLabels: false`, render tuần tự, hiển thị như `<img>` SVG (data URL), theo chủ đề sáng / tối,
  lỗi cú pháp → giữ mã + ghi chú. Marker bị quên trong chữ → hình vẫn hiện cuối câu trả lời (`orphanVisuals`).
- Kiểm thử: `node ../tools/test-visuals.mjs` (IR / autofix / 5 mẫu của skill / xuất PNG-SVG / sandbox tiến trình con; lọc giấy phép với kết quả Commons thật, giới hạn tải, danh sách cho phép,
  SSRF; chụp trang vbpl + trang PDF chính thức); harness `visual` (AI giả chạy **công cụ thật**, prompt `VISUAL`): `APP_URL=… node scripts/ui-test-v12-visuals.mjs <email> <mk>`
  (iframe sandbox + CSP, tải xuống, lightbox, mermaid, ảnh ngoài → link, chia sẻ, không request ra ngoài, không lỗi CSP, sáng / tối, 320–1920 px) → `screenshots/v12-visual-*.png`;
  cảnh `visual` của `lang-leak-check.mjs`.

## Suy nghĩ của mô hình, bộ lọc đầu ra (26/09/2026)
- `app_settings.showReasoningToUsers` (mặc định **tắt**, Quản trị → Hệ thống): phần “suy nghĩ” (reasoning) bị loại **ở server** khỏi SSE, lịch sử, trang chia sẻ (luôn loại), tệp xuất, chỉ mục tìm kiếm.
  Quản trị viên có công tắc riêng trong Cài đặt → Chung (`settings.adminReasoning`, mặc định bật) – `reasoningAllowed()` trong `server/auth.mjs`. `/api/meta` trả `reasoning: true|false`.
- `server/sanitize.mjs` (`scrubText`): mọi chữ người dùng thấy (câu trả lời, suy nghĩ, nhãn / kết quả / lỗi bước, gợi ý câu hỏi, tiêu đề tài liệu, chia sẻ, xuất, đoạn trích tìm kiếm)
  được thay tên hãng / model / runtime (danh sách tĩnh + provider, model id, tên, host trong opencode.json) bằng “mô hình AI của FTU Tech Lab”, và sửa “do FTU Tech Lab phát triển / huấn luyện” → “triển khai”.
  Luồng SSE giữ lại 40 ký tự cuối của mỗi phần đang stream để tên bị cắt giữa hai delta không lọt ra; khi tin nhắn xong thì gửi phần còn lại. Kiểm thử: `node scripts/test-sanitize.mjs`.
- Huy hiệu độ tin cậy chỉ hiện khi lượt đó có `grounding_check` hoặc câu trả lời có trích dẫn / căn cứ pháp lý (`LEGAL_CLAIM_RE` trong `client/src/codes.js`).

## Quản trị: lịch sử trò chuyện của mọi người dùng
- Quản trị → “Lịch sử trò chuyện” (`GET /api/admin/chats?q=&user=&from=&to=&page=&size=`, tham số URL `h*`) và trình xem chỉ đọc `/admin/chats/:id`
  (`GET /api/admin/chats/:id/messages[?branch=]` – xem phiên bản khác mà không đổi nhánh của chủ cuộc trò chuyện). Tài liệu: route `/api/artifacts/...` cho phép admin với mọi cuộc trò chuyện.
- Mỗi lượt admin xem cuộc trò chuyện / xem trước / tải tài liệu của người khác được ghi vào bảng `admin_access_log` (`server/audit.mjs`), hiển thị ở Quản trị → “Nhật ký truy cập” (`GET /api/admin/access-log`).
  /privacy (bản nháp) có mục “Quản trị viên xem nội dung”; Cài đặt → Dữ liệu có ghi chú cho người dùng.
