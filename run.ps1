# Launch opencode fully sandboxed inside this project folder (PowerShell version of run.sh).
# Usage: .\run.ps1 [opencode args...]
$Root = $PSScriptRoot
$SB = Join-Path $Root '.sandbox'
foreach ($d in 'home','config','data','cache','state','tmp','chrome-profile') { New-Item -ItemType Directory -Force (Join-Path $SB $d) | Out-Null }
New-Item -ItemType Directory -Force (Join-Path $Root 'workspace') | Out-Null

$envFile = Join-Path $Root '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim().Trim('"'), 'Process')
  }
}

$vars = @{
  HOME = "$SB\home"; USERPROFILE = "$SB\home"
  XDG_CONFIG_HOME = "$SB\config"; XDG_DATA_HOME = "$SB\data"; XDG_CACHE_HOME = "$SB\cache"; XDG_STATE_HOME = "$SB\state"
  TEMP = "$SB\tmp"; TMP = "$SB\tmp"; TMPDIR = "$SB\tmp"
  OPENCODE_CONFIG = "$Root\opencode.json"; OPENCODE_CONFIG_DIR = "$Root\.opencode"
  OPENCODE_DISABLE_AUTOUPDATE = '1'; OPENCODE_DISABLE_SHARE = '1'
  CHROME_PROFILE_DIR = "$SB\chrome-profile"; ND45_ROOT = $Root; npm_config_cache = "$SB\cache\npm"
}
# Interactive "question" tool – OPT-IN only (ND45_QUESTION_TOOL=1), see run.sh / docs/QUESTION_TOOL.md.
if ($env:ND45_QUESTION_TOOL -eq '1') { $vars.OPENCODE_ENABLE_QUESTION_TOOL = '1'; $vars.OPENCODE_PERMISSION = '{"question":"allow"}' }
foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process') }

# Start (or reuse) the sandbox Chrome with a local-only DevTools port (see run.sh).
if (-not $env:CHROME_PORT) { $env:CHROME_PORT = '9333' }
$probe = { try { Invoke-RestMethod -TimeoutSec 2 "http://127.0.0.1:$env:CHROME_PORT/json/version" | Out-Null; $true } catch { $false } }
if (-not (& $probe)) {
  Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList @(
    "--remote-debugging-port=$env:CHROME_PORT", '--remote-debugging-address=127.0.0.1',
    "--user-data-dir=$SB\chrome-profile", '--no-first-run', '--no-default-browser-check',
    '--disable-default-apps', '--disable-sync', 'about:blank')
  for ($i = 0; $i -lt 40 -and -not (& $probe); $i++) { Start-Sleep -Milliseconds 500 }
}

Set-Location (Join-Path $Root 'workspace')
& (Join-Path $Root 'node_modules\opencode-ai\bin\opencode.exe') @args
