# Builds a Release copy of Sonora into %LOCALAPPDATA%\Sonora\app and puts shortcuts on the
# Desktop and in the Start Menu. Run it again after pulling changes to update the installed copy.
# (A proper installer with uninstall comes later; see docs/ARCHITECTURE.md §10.)
param([switch]$NoDesktopShortcut, [switch]$NoStart)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$appDir = Join-Path $env:LOCALAPPDATA 'Sonora\app'
$exe = Join-Path $appDir 'Sonora.exe'

Write-Host 'Stopping Sonora if it is running...'
Get-Process Sonora -ErrorAction SilentlyContinue | Stop-Process
Start-Sleep -Milliseconds 800

Write-Host 'Building the web frontend...'
Push-Location (Join-Path $repo 'web')
try {
    if (-not (Test-Path node_modules)) { npm install --no-fund --no-audit | Out-Null }
    npm run build | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'web build failed' }
} finally { Pop-Location }

Write-Host "Publishing to $appDir ..."
dotnet publish (Join-Path $repo 'host\Sonora.Host\Sonora.Host.csproj') -c Release -o $appDir --nologo -v quiet
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

function New-Shortcut([string]$path) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $appDir
    $lnk.IconLocation = "$exe,0"
    $lnk.Description = 'Sonora — widget musik untuk desktop'
    $lnk.Save()
    Write-Host "Shortcut: $path"
}

$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Sonora.lnk'
New-Shortcut $startMenu
if (-not $NoDesktopShortcut) {
    New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sonora.lnk')
}

if (-not $NoStart) {
    Start-Process $exe
    Write-Host 'Sonora started.'
}
