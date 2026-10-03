# Rasid launcher. Run:  powershell -ExecutionPolicy Bypass -File .\start.ps1
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed. Install it first:  winget install OpenJS.NodeJS.LTS" -ForegroundColor Red; exit 1
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "Claude Code not found. Install it:  npm install -g @anthropic-ai/claude-code  then run 'claude' once to sign in." -ForegroundColor Yellow
}
if (-not (Test-Path node_modules)) { npm install --omit=dev }
node src/server.js
