// Server-side localization (vi / en).
//  • resolveLocale(req): X-UI-Locale header (sent by the web client) > the signed-in user's saved locale
//    > Accept-Language > "vi".
//  • localizeErrors middleware: every JSON body with an `error` string is translated for the request's
//    locale and gets a stable machine-readable `code` (existing codes such as agent_down are kept).
//    Handlers keep writing their Vietnamese message; the catalog below maps it to a code + English text,
//    so modules maintained elsewhere (e.g. extract.mjs) are covered without touching them.
//  • tr(locale, key, vars): other server-made text (export headings, default titles, file names).

export const LOCALES = ["vi", "en"]
const norm = (l) => {
  const s = String(l || "").trim().toLowerCase()
  return s.startsWith("vi") ? "vi" : s.startsWith("en") ? "en" : null
}

/** Best of vi/en from an Accept-Language header (q-values honoured), or null. */
export function fromAcceptLanguage(h) {
  let best = null
  let bestQ = -1
  for (const part of String(h || "").split(",")) {
    const [tag, ...params] = part.trim().split(";")
    const l = norm(tag)
    if (!l) continue
    const qp = params.find((p) => p.trim().startsWith("q="))
    const q = qp ? Number(qp.trim().slice(2)) : 1
    if (q > bestQ) {
      best = l
      bestQ = q
    }
  }
  return best
}

export function resolveLocale(req) {
  return norm(req.headers?.["x-ui-locale"]) || norm(req.user?.locale) || fromAcceptLanguage(req.headers?.["accept-language"]) || "vi"
}

// ---- API error catalog ---------------------------------------------------------------------------
// [code, Vietnamese message (string, or RegExp with capture groups), English (string, or fn(match))]
const ERRORS = [
  ["csrf", "Yêu cầu không hợp lệ (CSRF).", "Invalid request (CSRF check failed)."],
  ["assist_not_found", "Không tìm thấy yêu cầu xác minh.", "Verification request not found."],
  ["assist_gone", "Yêu cầu xác minh không còn chờ.", "This verification request is no longer waiting."],
  ["assist_view_down", "Không mở được khung xem trang chính thức.", "Couldn't open the live view of the official page."],
  ["assist_reload_wait", "Vui lòng chờ trước khi tải lại trang chính thức.", "Please wait before reloading the official page."],
  ["agent_down", "Không kết nối được với trợ lý. Vui lòng thử lại sau ít phút.", "Can't reach the assistant. Please try again in a few minutes."],
  ["agent_down", "Không đọc được nội dung cuộc trò chuyện. Thử lại sau.", "Couldn't read the conversation. Please try again later."],
  ["rate_limited", "Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ít phút.", "Too many attempts. Please try again in a few minutes."],
  ["invalid_credentials", "Email hoặc mật khẩu không đúng.", "Incorrect email or password."],
  ["registration_closed", "Đăng ký tài khoản đang tắt. Liên hệ quản trị viên.", "Sign-ups are closed. Please contact your administrator."],
  ["registration_failed", "Không thể tạo tài khoản với email này.", "Can't create an account with this email."],
  ["credentials_missing", "Thiếu email hoặc mật khẩu.", "Email and password are required."],
  ["email_invalid", "Email không hợp lệ.", "Invalid email address."],
  ["password_too_short", "Mật khẩu cần ít nhất 8 ký tự.", "Password must be at least 8 characters."],
  ["password_too_long", "Mật khẩu quá dài.", "Password is too long."],
  ["auth_required", "Bạn cần đăng nhập.", "Please sign in."],
  ["admin_only", "Chỉ quản trị viên mới truy cập được.", "Administrators only."],
  ["expert_only", "Chỉ chuyên gia mới truy cập được.", "Experts only."],
  ["invalid_data", "Dữ liệu không hợp lệ.", "Invalid data."],
  ["payload_too_large", "Dữ liệu gửi lên quá lớn.", "The request is too large."],
  ["server_error", "Lỗi máy chủ.", "Server error."],
  ["not_found", "Không tìm thấy.", "Not found."],
  ["wrong_current_password", "Mật khẩu hiện tại không đúng.", "Your current password is incorrect."],
  ["email_mismatch", "Email xác nhận không khớp.", "The confirmation email doesn't match."],
  ["wrong_password", "Mật khẩu không đúng.", "Incorrect password."],
  ["last_admin", "Không thể xoá quản trị viên cuối cùng.", "You can't delete the last administrator."],
  ["user_not_found", "Không tìm thấy người dùng.", "User not found."],
  ["email_taken", "Email này đã có tài khoản.", "An account with this email already exists."],
  ["self_lock", "Không thể tự khoá tài khoản của mình.", "You can't lock your own account."],
  ["self_demote", "Không thể tự bỏ quyền quản trị của mình.", "You can't remove your own administrator role."],
  ["self_delete", "Không thể tự xoá tài khoản của mình ở đây.", "You can't delete your own account here."],
  ["upload_invalid", "Yêu cầu tải lên không hợp lệ.", "Invalid upload request."],
  ["upload_quota", "Bạn đã tải lên quá nhiều tệp trong 24 giờ qua.", "You've uploaded too many files in the last 24 hours."],
  ["file_too_large", "Tệp vượt quá 10 MB.", "The file is larger than 10 MB."],
  ["file_type", "Chỉ nhận tệp .docx, .pdf, .txt, .md.", "Only .docx, .pdf, .txt and .md files are supported."],
  ["file_save_failed", "Không lưu được tệp.", "Couldn't save the file."],
  ["file_empty", "Tệp trống.", "The file is empty."],
  ["file_unreadable", "Không đọc được nội dung tệp.", "Couldn't read the file's content."],
  ["no_file", "Không có tệp nào được gửi.", "No file was sent."],
  ["upload_not_found", "Không tìm thấy tệp.", "File not found."],
  ["docx_invalid", "Tệp .docx không hợp lệ.", "Invalid .docx file."],
  ["pdf_invalid", "Tệp PDF không hợp lệ.", "Invalid PDF file."],
  ["repair_disabled", "Quản trị viên chưa cho phép tự tra lại.", "Looking up again is not enabled by your administrator."],
  ["repair_done", "Câu trả lời này đã được tra lại.", "This answer has already been looked up again."],
  ["repair_not_low", "Chỉ tra lại được khi độ tin cậy thấp.", "Only answers with low confidence can be looked up again."],
  ["repair_nothing", "Không có câu trả lời nào để tra lại.", "There is no answer to look up again."],
  ["pdf_ocr_failed", /^PDF không có lớp chữ \(bản scan\) và không OCR được: /, () => "This PDF has no text layer (it is a scan) and its text could not be recognized (OCR). Please upload a version with selectable text."],
  ["pdf_no_text","PDF không có lớp chữ (có thể là bản scan). Hãy tải lên bản có thể chọn chữ.", "This PDF has no text layer (it may be a scan). Please upload a version with selectable text."],
  ["text_binary", "Tệp văn bản chứa dữ liệu nhị phân.", "The text file contains binary data."],
  ["no_text", "Không đọc được nội dung chữ trong tệp.", "Couldn't find any readable text in the file."],
  ["chat_not_found", "Không tìm thấy cuộc trò chuyện.", "Chat not found."],
  ["message_too_long", /^Tin nhắn quá dài \(tối đa ([\d.,]+) ký tự\)\.$/, (m) => `Message is too long (maximum ${m[1].replace(/\./g, ",")} characters).`],
  ["message_too_long", "Tin nhắn quá dài.", "Message is too long."],
  ["too_many_attachments", /^Tối đa (\d+) tệp mỗi tin nhắn\.$/, (m) => `You can attach up to ${m[1]} files per message.`],
  ["attachment_missing", "Tệp đính kèm không tồn tại hoặc đã bị xoá.", "The attachment doesn't exist or has been deleted."],
  ["message_empty", "Tin nhắn trống.", "The message is empty."],
  ["title_empty", "Tên không được để trống.", "The name can't be empty."],
  ["confirm_mismatch", "Xác nhận không đúng.", "The confirmation text doesn't match."],
  ["too_many_streams", "Quá nhiều kết nối đồng thời.", "Too many simultaneous connections."],
  ["question_gone", "Câu hỏi này không còn chờ trả lời.", "This question is no longer waiting for an answer."],
  ["question_answers_invalid", "Câu trả lời không hợp lệ.", "Invalid answer."],
  ["busy", "Trợ lý đang trả lời. Hãy chờ hoặc bấm dừng.", "The assistant is still responding. Wait for it to finish or press Stop."],
  ["invalid_message", "Tin nhắn không hợp lệ.", "Invalid message."],
  ["version_not_found", "Không tìm thấy phiên bản.", "Version not found."],
  ["share_busy", "Chờ trợ lý trả lời xong rồi hãy chia sẻ.", "Wait for the assistant to finish before sharing."],
  ["chat_empty", "Cuộc trò chuyện chưa có nội dung.", "This chat has no messages yet."],
  ["share_not_found", "Không tìm thấy liên kết.", "Link not found."],
  ["share_not_found", "Không tìm thấy liên kết chia sẻ.", "Share link not found."],
  ["share_revoked", "Liên kết này đã bị thu hồi.", "This link has been revoked."],
  ["no_preview", "Không có bản xem trước.", "No preview available."],
  ["no_original", "Không có tệp gốc.", "No original file."],
  ["format_unsupported", "Định dạng không hỗ trợ.", "Unsupported format."],
  ["file_not_found", "Tệp không tồn tại.", "File not found."],
  ["document_not_found", "Không tìm thấy tài liệu.", "Document not found."],
  ["no_diff_base", "Không có bản để so sánh.", "No version to compare with."],
  ["diff_unreadable", "Không đọc được nội dung để so sánh.", "Couldn't read the content to compare."],
  ["already_escalated", /^Câu hỏi này đã được chuyển chuyên gia \(([^)]+)\)\.$/, (m) => `This question has already been escalated to an expert (${m[1]}).`],
  ["escalation_not_found", "Không tìm thấy yêu cầu.", "Request not found."],
  ["invalid_status", "Trạng thái không hợp lệ.", "Invalid status."],
  ["assignee_not_expert", "Người được giao không phải chuyên gia.", "The assignee is not an expert."],
  ["reply_empty", "Nội dung trả lời trống.", "The reply is empty."],
]
const exact = new Map(ERRORS.filter(([, vi]) => typeof vi === "string").map((e) => [e[1], e]))
const patterns = ERRORS.filter(([, vi]) => vi instanceof RegExp)

/** Vietnamese API message → { code, message } for the locale (unknown messages keep their text). */
export function localizeError(message, locale) {
  const hit = exact.get(message)
  if (hit) return { code: hit[0], message: locale === "en" ? hit[2] : message }
  for (const [code, re, en] of patterns) {
    const m = String(message).match(re)
    if (m) return { code, message: locale === "en" ? en(m) : message }
  }
  return { code: null, message }
}

/** Express middleware: localize `{ error }` JSON bodies and add a stable `code`. */
export function localizeErrors(req, res, next) {
  const json = res.json.bind(res)
  res.json = (body) => {
    if (body && typeof body === "object" && typeof body.error === "string") {
      const { code, message } = localizeError(body.error, resolveLocale(req))
      body = { ...body, error: message }
      if (code && !body.code) body.code = code
    }
    return json(body)
  }
  next()
}

// ---- other server-made text ------------------------------------------------------------------------
const TEXT = {
  vi: {
    newChat: "Cuộc trò chuyện mới",
    fileTitle: "Tệp: {name}",
    exportCreated: "Tạo: {date}",
    exportYou: "Bạn",
    exportAssistant: "Trợ lý",
    exportSources: "Nguồn đã tra:",
    exportReadme: "Xuất dữ liệu LegalAI – {date}\n{count} cuộc trò chuyện (phiên bản đang hiển thị của mỗi cuộc).\n",
    exportAttachment: "Tệp: {name}",
    redlineName: "{base} - thay đổi (v{n}).docx",
    uiLanguageLine: "Ngôn ngữ giao diện: {locale}",
  },
  en: {
    newChat: "New chat",
    fileTitle: "File: {name}",
    exportCreated: "Created: {date}",
    exportYou: "You",
    exportAssistant: "Assistant",
    exportSources: "Sources consulted:",
    exportReadme: "LegalAI data export – {date}\n{count} chats (the version currently shown for each).\n",
    exportAttachment: "File: {name}",
    redlineName: "{base} - changes (v{n}).docx",
    uiLanguageLine: "Ngôn ngữ giao diện: {locale}",
  },
}
export const tr = (locale, key, vars = {}) => (TEXT[locale]?.[key] ?? TEXT.vi[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
export const intlLocale = (locale) => (locale === "en" ? "en-US" : "vi-VN")
export const fmtDateTime = (ts, locale) => new Date(ts).toLocaleString(intlLocale(locale))


// ---- agent prompt: hidden context lines ------------------------------------------------------------
// Appended to the user's text of every prompt we send and hidden from the message shown back to the user
// (like the attachment blocks):
//   Ngôn ngữ giao diện: <vi|en>                                  → the agent answers in the UI language by default
//   Thời điểm người dùng gửi: <ISO datetime> (Asia/Ho_Chi_Minh)  → "today" for deadlines / legal status
// The labels stay Vietnamese on purpose: they are fixed markers the agent prompt looks for.
export const UI_LANGUAGE_RE = /\n*Ngôn ngữ giao diện: (?:vi|en)(?:\s*\nThời điểm người dùng gửi: [^\n]*)?\s*$/
export const uiLanguageLine = (locale) => tr("vi", "uiLanguageLine", { locale: locale === "en" ? "en" : "vi" })
/** 2026-09-26T13:05:09+07:00 */
export function vnIsoNow(now = Date.now()) {
  return new Date(now + 7 * 3600_000).toISOString().slice(0, 19) + "+07:00"
}
export const sentAtLine = (now = Date.now()) => `Thời điểm người dùng gửi: ${vnIsoNow(now)} (Asia/Ho_Chi_Minh)`
/** Remove the hidden lines from the text shown to the user. */
export const stripUiLanguage = (text) => String(text || "").replace(UI_LANGUAGE_RE, "")
/** Append (or replace) the hidden lines at the end of the user's text part of a prompt. */
export const withUiLanguage = (text, locale, now = Date.now()) => `${stripUiLanguage(text)}\n\n${uiLanguageLine(locale)}\n${sentAtLine(now)}`
