# Builds the Chrome Web Store upload ZIP.
#
# SHIP is an explicit ALLOWLIST, not a denylist. Anything not named here never
# reaches the package. That is deliberate: a denylist fails open, which is how
# internal docs and a driver-schedule export ended up sitting in the folder that
# gets zipped.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a .ps1 with no
# BOM as ANSI, so a UTF-8 em dash decodes into bytes that include a quote
# character and breaks the parser.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\package.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

$SHIP = @(
    "manifest.json",
    "background.js",
    "payloads.js",
    "hook.js",
    "bridge.js",
    "loadboard.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "icons/icon16.png",
    "icons/icon32.png",
    "icons/icon48.png",
    "icons/icon128.png"
)

$dist = Join-Path $root "dist"
$zip  = Join-Path $root "rlb-load-search.zip"

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
if (Test-Path $zip)  { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $dist -Force | Out-Null

$missing = @()
foreach ($f in $SHIP) {
    $src = Join-Path $root $f
    if (-not (Test-Path $src)) { $missing += $f; continue }
    $dest = Join-Path $dist $f
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item $src $dest -Force
}

# Sanity check: the manifest must parse, or the upload fails with an opaque error.
$manifest = Get-Content (Join-Path $dist "manifest.json") -Raw | ConvertFrom-Json
Write-Output ("manifest OK - " + $manifest.name + " v" + $manifest.version)
Write-Output ("permissions: " + ($manifest.permissions -join ", "))

Compress-Archive -Path (Join-Path $dist "*") -DestinationPath $zip -Force

$shipped = Get-ChildItem $dist -Recurse -File
$zipKb = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Output ""
Write-Output ("packaged " + $shipped.Count + " file(s) into rlb-load-search.zip, " + $zipKb + " KB")
foreach ($s in $shipped) { Write-Output ("  " + $s.FullName.Substring($dist.Length + 1)) }

if ($missing.Count -gt 0) {
    Write-Output ""
    Write-Warning ("INCOMPLETE - " + $missing.Count + " file(s) missing:")
    foreach ($m in $missing) { Write-Warning ("  " + $m) }
    Write-Warning "The Web Store upload will be rejected until these exist."
}

Pop-Location
