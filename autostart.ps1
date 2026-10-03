# Rasid as a desktop app: runs hidden in the background, starts with Windows, opens from a desktop icon.
#   Install:  powershell -ExecutionPolicy Bypass -File .\autostart.ps1
#   Also stop the PC sleeping while plugged in:  add  -NoSleep
#   Remove:   powershell -ExecutionPolicy Bypass -File .\autostart.ps1 -Remove
param([switch]$Remove, [switch]$NoSleep)
$dir = $PSScriptRoot
$startupVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'Rasid.vbs'
$openVbs = Join-Path $dir 'Rasid.vbs'
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Rasid.lnk'

function Stop-Rasid {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -like '*rasid*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Remove) {
  Remove-Item $startupVbs, $openVbs, $lnk -ErrorAction SilentlyContinue
  Stop-Rasid
  Write-Host "Rasid stopped and removed from startup." -ForegroundColor Yellow
  exit
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Write-Host "Node.js is not installed:  winget install OpenJS.NodeJS.LTS" -ForegroundColor Red; exit 1 }
$node = $nodeCmd.Source
Push-Location $dir; npm install --omit=dev --no-audit --no-fund; Pop-Location
New-Item -ItemType Directory -Force (Join-Path $dir 'data') | Out-Null

# A .vbs launcher runs node with no console window at all.
function Write-Launcher($file, $extra) {
  $cmd = '"' + $node + '" "' + (Join-Path $dir 'src\launch.js') + '"' + $extra
  $line = 'CreateObject("WScript.Shell").Run "' + $cmd.Replace('"', '""') + '", 0, False'
  Set-Content -Path $file -Value $line -Encoding Unicode
}
Write-Launcher $startupVbs ' --background'   # at every Windows sign-in: start in the background
Write-Launcher $openVbs ''                   # desktop icon: make sure it runs, then open the app window

$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$s.Arguments = '"' + $openVbs + '"'
$s.WorkingDirectory = $dir
$s.IconLocation = (Join-Path $dir 'rasid.ico')
$s.Description = 'Rasid'
$s.Save()

if ($NoSleep) { powercfg /change standby-timeout-ac 0; Write-Host "PC will not sleep while plugged in." }

Stop-Rasid
Start-Sleep -Seconds 1
Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $openVbs + '"')
Write-Host "Done. Rasid runs in the background and starts with Windows. Open it from the 'Rasid' icon on your desktop." -ForegroundColor Green
