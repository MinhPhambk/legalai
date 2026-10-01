# Stops the LegalAI stack started by start-legalai.ps1: tunnel, web server (+ its AI agent server),
# sandbox Chrome (9333) and OCR Chrome (9334–9337). Only processes of this project are touched.
$root = Split-Path -Parent $PSScriptRoot
function Stop-Tree($procId) { if ($procId) { & taskkill /PID $procId /T /F 2>$null | Out-Null } }
function Stop-Port($port) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Tree $_.OwningProcess } }

Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($root) -or $_.ExecutablePath -like "$root*" } | ForEach-Object { Stop-Tree $_.ProcessId }
# /T also ends the AI agent server the web server spawned
Stop-Port 3000
# Chrome launchers (they relaunch Chrome, so stop the node launcher first, then the browsers)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'launch-(ocr-)?chrome\.mjs' } | ForEach-Object { Stop-Tree $_.ProcessId }
9333..9337 | ForEach-Object { Stop-Port $_ }
Write-Host "LegalAI đã dừng."
