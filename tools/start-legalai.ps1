# Starts the whole LegalAI stack after a reboot and prints the public link:
#   1. sandbox Chrome (127.0.0.1:9333, off-screen) – browser for the lookup tools
#   2. web server (127.0.0.1:3000) – it starts the AI agent server itself
#   3. Cloudflare quick tunnel – a NEW public *.trycloudflare.com link every start
# The OCR Chrome (9334) starts by itself on the first scanned PDF.
# Each part is skipped if it is already running, so running this twice is harmless.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$sb = Join-Path $root ".sandbox"
New-Item -ItemType Directory -Force (Join-Path $sb "tmp"), (Join-Path $sb "web"), (Join-Path $sb "cloudflared") | Out-Null

function Test-Port($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Wait-Port($port, $seconds) {
  for ($i = 0; $i -lt $seconds; $i++) { if (Test-Port $port) { return $true }; Start-Sleep -Seconds 1 }
  return $false
}

Write-Host "== LegalAI: khởi động ==" -ForegroundColor Cyan

# 1. Sandbox Chrome
if (Test-Port 9333) { Write-Host "[1/3] Trình duyệt sandbox: đang chạy sẵn" }
else {
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "tools/launch-chrome.mjs" `
    -RedirectStandardOutput (Join-Path $sb "tmp\chrome-launcher.log") -RedirectStandardError (Join-Path $sb "tmp\chrome-launcher.err.log")
  if (Wait-Port 9333 60) { Write-Host "[1/3] Trình duyệt sandbox: đã bật" } else { Write-Host "[1/3] Trình duyệt sandbox: KHÔNG bật được – xem .sandbox\tmp\chrome-launcher.log" -ForegroundColor Red }
}

# 2. Web server (+ AI agent server, spawned by the web server through Git Bash)
if (Test-Port 3000) { Write-Host "[2/3] Web: đang chạy sẵn" }
else {
  $log = Join-Path $sb "web\web-server.log"
  if (Test-Path $log) { Move-Item -Force $log (Join-Path $sb "web\web-server.prev.log") }
  Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -WorkingDirectory (Join-Path $root "web") `
    -ArgumentList "/c", "npm start > `"$log`" 2>&1"
  if (Wait-Port 3000 90) { Write-Host "[2/3] Web: đã bật (http://127.0.0.1:3000)" } else { Write-Host "[2/3] Web: KHÔNG bật được – xem .sandbox\web\web-server.log" -ForegroundColor Red }
}

# 3. Cloudflare quick tunnel
$cfLog = Join-Path $sb "tmp\cloudflared.log"
$running = Get-Process cloudflared -ErrorAction SilentlyContinue
if ($running -and (Test-Path $cfLog)) { Write-Host "[3/3] Tunnel: đang chạy sẵn" }
else {
  if (Test-Path $cfLog) { Move-Item -Force $cfLog (Join-Path $sb "tmp\cloudflared.prev.log") }
  $cfHome = Join-Path $sb "cloudflared"
  $env:HOME = $cfHome; $env:USERPROFILE = $cfHome
  Start-Process -WindowStyle Hidden -FilePath (Join-Path $root "tools\cloudflared.exe") `
    -ArgumentList "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3000" -RedirectStandardError $cfLog -RedirectStandardOutput (Join-Path $sb "tmp\cloudflared.out.log")
  Write-Host "[3/3] Tunnel: đang lấy link…"
}
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  if (Test-Path $cfLog) { $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1; if ($m) { $url = $m.Matches[0].Value } }
  if (-not $url) { Start-Sleep -Seconds 1 }
}
if ($url) {
  Set-Content -Path (Join-Path $sb "tmp\tunnel-url.txt") -Value $url -Encoding utf8
  try { Set-Clipboard -Value $url } catch {}
  Write-Host ""
  Write-Host "LINK TRUY CẬP: $url" -ForegroundColor Green
  Write-Host "(đã chép vào clipboard; link mới mỗi lần khởi động – có thể cần 10–30 giây mới vào được)"
} else { Write-Host "Chưa lấy được link tunnel – xem .sandbox\tmp\cloudflared.log" -ForegroundColor Red }

# Everything the owner needs in one plain-text file next to START-LegalAI.cmd
$pwFile = Join-Path $sb "web\admin-password.txt"
$pw = if (Test-Path $pwFile) { (Get-Content $pwFile -Raw).Trim() } else { "(chưa có – xem .sandbox\web\admin-password.txt)" }
$info = Join-Path $root "THONG-TIN-TRUY-CAP.txt"
$link = if ($url) { $url } else { "(chưa lấy được – chạy lại START-LegalAI.cmd)" }
$upwFile = Join-Path $sb "web\user-password.txt"
$upw = if (Test-Path $upwFile) { (Get-Content $upwFile -Raw).Trim() } else { "(chưa có tài khoản người dùng thường)" }
@(
  "LegalAI – thông tin truy cập (cập nhật $(Get-Date -Format 'dd/MM/yyyy HH:mm'))",
  "",
  "Link công khai : $link",
  "Link trên máy  : http://127.0.0.1:3000",
  "",
  "Tài khoản admin: admin@legalai.local",
  "Mật khẩu       : $pw",
  "",
  "Tài khoản user : user@legalai.local   (người dùng thường)",
  "Mật khẩu       : $upw",
  "",
  "Lưu ý: link công khai đổi mỗi lần bật lại. Không gửi file này cho người khác."
) | Set-Content -Path $info -Encoding utf8
Write-Host ""
Write-Host "Tài khoản + mật khẩu + link: $info" -ForegroundColor Yellow
Start-Process notepad.exe $info
