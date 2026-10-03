# Rasid one-line installer / updater.  Paste in PowerShell:
#   irm https://raw.githubusercontent.com/ahmedalimujaini-cell/rasid/main/install.ps1 | iex
# Downloads the latest Rasid, installs it to %USERPROFILE%\rasid (your data folder is kept),
# makes it start with Windows, puts the Rasid icon on the desktop, and opens it.
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is missing. Installing it...' -ForegroundColor Yellow
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  Write-Host 'Node.js installed. Close this window, open PowerShell again, and paste the same line once more.' -ForegroundColor Yellow
  return
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host 'Claude Code is missing. Installing it...' -ForegroundColor Yellow
  npm install -g @anthropic-ai/claude-code
  Write-Host 'After this finishes, run:  claude   then type  /login  once.' -ForegroundColor Yellow
}

$dest = Join-Path $HOME 'rasid'
$tmp = Join-Path $env:TEMP ('rasid-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
$zip = Join-Path $tmp 'rasid.zip'

Write-Host 'Downloading Rasid...' -ForegroundColor Cyan
Invoke-WebRequest 'https://github.com/ahmedalimujaini-cell/rasid/archive/refs/heads/main.zip' -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath $tmp -Force
$src = Join-Path $tmp 'rasid-main'
if (-not (Test-Path (Join-Path $src 'package.json'))) { throw 'Download looks incomplete. Try again.' }

Write-Host 'Installing...' -ForegroundColor Cyan
New-Item -ItemType Directory -Force $dest | Out-Null
robocopy $src $dest /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy $LASTEXITCODE)." }
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest 'autostart.ps1') -NoSleep
