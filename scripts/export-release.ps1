# Build a release and drop a standalone, portable GameAssetBrowser.exe into the
# git-ignored export/ folder. Run at major milestones: `npm run export`.
#
# "Standalone" = the raw release binary, which runs in portable mode (it keeps
# its data in a GameAssetBrowser.data folder beside itself), so a single .exe is
# genuinely all you need. tauri build emits "Game Asset Browser.exe" (mainBinaryName);
# we copy it to GameAssetBrowser.exe (no spaces) for a cleaner portable filename.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exportDir = Join-Path $root "export"
$builtExe = Join-Path $root "src-tauri\target\release\Game Asset Browser.exe"

Write-Host "Building release (this takes a couple of minutes)..." -ForegroundColor Cyan
Push-Location $root
try {
    # `tauri build` runs the whole chain: beforeBuildCommand (tsc + vite build)
    # produces a fresh dist/, which the release binary EMBEDS at compile time.
    # A bare `cargo build` would bundle a stale frontend. --no-bundle skips the
    # MSI/NSIS installers, which a standalone export does not want.
    npm run tauri build -- --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}

if (-not (Test-Path $builtExe)) { throw "expected $builtExe was not produced" }

New-Item -ItemType Directory -Force -Path $exportDir | Out-Null

# Stamp the export with version + short commit so it's clear what each one is.
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$commit = (git -C $root rev-parse --short HEAD).Trim()
$dest = Join-Path $exportDir "GameAssetBrowser.exe"

Copy-Item $builtExe $dest -Force

$sizeMB = "{0:N1}" -f ((Get-Item $dest).Length / 1MB)
"Game Asset Browser $version ($commit) - exported $(Get-Date -Format 'yyyy-MM-dd HH:mm')" |
    Out-File -FilePath (Join-Path $exportDir "VERSION.txt") -Encoding utf8

Write-Host "Exported GameAssetBrowser.exe ($sizeMB MB, v$version @ $commit) to:" -ForegroundColor Green
Write-Host "  $dest"
