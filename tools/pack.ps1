# Builds the installer: artifacts\release\Sonora-win-Setup.exe (plus the files Velopack needs
# for updates). The version comes from host\Sonora.Host\Sonora.Host.csproj.
#
# Requires: .NET 10 SDK, Node.js, and the Velopack CLI (dotnet tool install -g vpk).
param([string]$Version)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$csproj = Join-Path $repo 'host\Sonora.Host\Sonora.Host.csproj'
$publish = Join-Path $repo 'artifacts\publish'
$release = Join-Path $repo 'artifacts\release'
$env:Path += ";$env:USERPROFILE\.dotnet\tools"

if (-not $Version) { $Version = ([xml](Get-Content $csproj)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1 }
Write-Host "Sonora $Version"

Write-Host '1/3 Building the web frontend...'
Push-Location (Join-Path $repo 'web')
try {
    if (-not (Test-Path node_modules)) { npm install --no-fund --no-audit | Out-Null }
    npm run build | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'web build failed' }
} finally { Pop-Location }

Write-Host '2/3 Publishing...'
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }
dotnet publish $csproj -c Release -r win-x64 --self-contained false -p:Version=$Version -o $publish --nologo -v quiet
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

Write-Host '3/3 Packing the installer...'
# Local builds start clean (Velopack refuses to pack a version that is already in the folder).
if (Test-Path $release) { Remove-Item $release -Recurse -Force }
# --framework: Setup installs the .NET 10 Desktop Runtime and WebView2 first if the PC lacks them.
vpk pack `
    --packId Sonora `
    --runtime win-x64 `
    --packVersion $Version `
    --packDir $publish `
    --mainExe Sonora.exe `
    --packTitle Sonora `
    --packAuthors Sonora `
    --icon (Join-Path $repo 'host\Sonora.Host\Assets\sonora.ico') `
    --framework net10.0-x64-desktop,webview2 `
    --shortcuts Desktop,StartMenuRoot `
    --outputDir $release
if ($LASTEXITCODE -ne 0) { throw 'vpk pack failed' }

Get-ChildItem $release -Filter *Setup.exe | ForEach-Object { Write-Host "Installer: $($_.FullName) ($([math]::Round($_.Length / 1MB, 1)) MB)" }
