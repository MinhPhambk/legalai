// Local stand-in for an official lookup page with a human check, for the assisted-browsing tests
// (tools/test-assist.mjs, web/scripts/assist-e2e.mjs). NOT a CAPTCHA solver test: the "code" is printed in
// plain text next to the box so the test (acting as the human user) can read and type it through the live view.
//   GET  /                → form like tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp (MST box, "Mã xác nhận" box + picture, Tra cứu)
//   POST /                → code "LIMIT": HTTP 429 "Too Many Requests" page (rate-limit test); wrong code: form again with "Vui lòng nhập đúng mã xác nhận!"; right code: result list
//                           (#resultContainer table, same columns as tracuunnt) + detail pane filled on click
//   /offsite, /internal, /popup, /download → links used by the navigation-guard tests
// Usage: node tools/assist-fake-site.mjs [port]   (or import { startFakeSite })
import http from "node:http"

export const FAKE_CODE = "7K2Q9"
export const FAKE_MST = "0100109106"
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

function form(err = "", mst = "") {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Tra cứu thông tin người nộp thuế (trang thử)</title>
<style>body{font:15px Arial;margin:24px;background:#fff}td{padding:6px}input[type=text]{width:260px;font-size:15px;padding:4px}
.cap{display:inline-block;padding:6px 12px;background:#eee;border:1px dashed #999;font:bold 22px monospace;letter-spacing:4px}
.err{color:#c00;font-weight:bold}button{font-size:15px;padding:6px 16px}</style></head><body>
<h2>Thông tin về người nộp thuế</h2>${err ? `<p class="err" id="err">${esc(err)}</p>` : ""}
<form method="post" action="/" name="myform"><table>
<tr><td>Mã số thuế*</td><td><input type="text" name="mst" id="mst" value="${esc(mst)}"></td></tr>
<tr><td>Mã xác nhận*</td><td><input type="text" name="captcha" id="captcha" autocomplete="off"> <span class="cap" id="capimg">${FAKE_CODE}</span></td></tr>
<tr><td></td><td><button type="submit" id="submit">Tra cứu</button></td></tr></table></form>
<p><a id="offsite" href="https://example.com/">Liên kết ngoài</a> · <a id="internal" href="http://127.0.0.2:9/">Địa chỉ nội bộ</a> ·
<a id="popup" href="/popup" target="_blank">Cửa sổ mới</a> · <a id="download" href="/download" download>Tải tệp</a> ·
<a id="fileurl" href="file:///C:/Windows/win.ini">Tệp cục bộ</a></p></body></html>`
}

function result(mst) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Kết quả tra cứu (trang thử)</title>
<style>body{font:15px Arial;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:5px}#detail{display:none;margin-top:16px}</style></head><body>
<div id="resultContainer"><table class="ta_border">
<tr><th>STT</th><th>MST</th><th>Tên người nộp thuế</th><th>Cơ quan thuế</th><th>Số CMT/Thẻ căn cước người đại diện</th><th>Ngày thay đổi thông tin gần nhất</th><th>Ghi chú</th></tr>
<tr><td>1</td><td>${esc(mst)}</td><td><a href="#" id="nntName" onclick="document.getElementById('detail').style.display='block';return false">CÔNG TY THỬ NGHIỆM ABC</a></td><td>Chi cục Thuế khu vực I</td><td>001234567890</td><td>01/09/2026</td><td>NNT đang hoạt động (đã được cấp GCN ĐKT)</td></tr>
</table></div>
<div id="detail"><table>
<tr><td>Mã số thuế</td><td>${esc(mst)}</td></tr>
<tr><td>Tên người nộp thuế</td><td>CÔNG TY THỬ NGHIỆM ABC</td></tr>
<tr><td>Địa chỉ trụ sở</td><td>Số 1 Phố Thử, Phường Hoàn Kiếm, Thành phố Hà Nội</td></tr>
<tr><td>Cơ quan thuế quản lý</td><td>Chi cục Thuế khu vực I</td></tr>
<tr><td>Ngày cấp MST</td><td>15/03/2010</td></tr>
<tr><td>Tên giám đốc</td><td>Nguyễn Văn Thử</td></tr>
<tr><td>Số CMT/Thẻ căn cước người đại diện</td><td>001234567890</td></tr>
<tr><td>Điện thoại</td><td>0241234567</td></tr>
<tr><td>Trạng thái</td><td>NNT đang hoạt động (đã được cấp GCN ĐKT)</td></tr>
</table></div></body></html>`
}

export function startFakeSite(port = 0) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x")
    const html = (s, code = 200) => { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(s) }
    if (req.method === "POST" && u.pathname === "/") {
      let body = ""
      req.on("data", (d) => (body += d))
      req.on("end", () => {
        const p = new URLSearchParams(body)
        const mst = (p.get("mst") || "").trim()
        // test hook: the code "LIMIT" makes the site answer like a rate-limited server (HTTP 429, bare text page)
        if ((p.get("captcha") || "").trim().toUpperCase() === "LIMIT") { res.writeHead(429, { "Content-Type": "text/html", "Retry-After": "120" }); return res.end("<html><body><h1>Too Many Requests</h1></body></html>") }
        if ((p.get("captcha") || "").trim().toUpperCase() !== FAKE_CODE) return html(form("Vui lòng nhập đúng mã xác nhận!", mst))
        html(result(mst))
      })
      return
    }
    if (u.pathname === "/") return html(form())
    if (u.pathname === "/popup") return html("<p>popup</p>")
    if (u.pathname === "/download") { res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=x.bin" }); return res.end("x") }
    html("not found", 404)
  })
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve({ server: srv, port: srv.address().port, url: `http://127.0.0.1:${srv.address().port}/` })))
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}`) {
  const { url } = await startFakeSite(Number(process.argv[2] || 0))
  console.log(`fake official site on ${url}`)
}
