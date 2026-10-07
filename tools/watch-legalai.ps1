# Keeps the LegalAI stack up while the laptop stays on: every 60 s checks the web server (3000), the sandbox Chrome
# (9333) and the Cloudflare tunnel (process + public link answering); anything down → start-legalai.ps1 brings it back.
# The tunnel link only changes if the tunnel itself has to be restarted; THONG-TIN-TRUY-CAP.txt is rewritten then.
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File tools\watch-legalai.ps1
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root ".sandbox\tmp\watch-legalai.log"
function Log($m) { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 'dd/MM HH:mm:ss'), $m) -Encoding utf8 }
function Test-Port($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
function Tunnel-Url { $f = Join-Path $root ".sandbox\tmp\cloudflared.log"; if (Test-Path $f) { $m = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1; if ($m) { return $m.Matches[0].Value } }; return $null }
Log "watchdog started (pid $PID)"
$fails = 0
while ($true) {
  $web = Test-Port 3000; $chrome = Test-Port 9333; $cf = [bool](Get-Process cloudflared -ErrorAction SilentlyContinue)
  $public = $false; $u = Tunnel-Url
  if ($cf -and $u) { try { $r = Invoke-WebRequest -Uri "$u/api/meta" -UseBasicParsing -TimeoutSec 20; $public = ($r.StatusCode -eq 200) } catch { $public = $false } }
  if ($web -and $chrome -and $cf -and $public) { $fails = 0 }
  else {
    $fails++
    Log "check failed ($fails): web=$web chrome=$chrome tunnel=$cf public=$public"
    # a short network blip should not cost the link: restart only after 3 failed checks in a row (or when a process is gone)
    if (-not $web -or -not $chrome -or -not $cf -or $fails -ge 3) {
      if ($cf -and -not $public -and $fails -ge 3) { Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force; Log "tunnel not answering → restarting it (new link)" }
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "tools\start-legalai.ps1") *> $null
      Log ("restart done; link: " + (Tunnel-Url)); $fails = 0
    }
  }
  Start-Sleep -Seconds 60
}
