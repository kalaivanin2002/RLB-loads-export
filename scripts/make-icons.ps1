# Generates icons/icon{16,32,48,128}.png from brand/fleetyes_logo.svg.
#
# Rasterizes with headless Chrome (no ImageMagick/Inkscape on this box), then
# auto-crops to the mark's real alpha bounds before downsampling. The raw SVG
# viewBox has uneven margins, so cropping first is what keeps the mark centred
# and filling the frame at 16px instead of drifting and shrinking.
#
# Keep this file ASCII-only (see note in package.ps1).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
#         powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1 -Background "#FFFFFF"

param(
    [string]$Background = "transparent",   # "transparent" or a hex like "#FFFFFF"
    [int]$PadPercent = 6                   # breathing room around the mark
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$svg = Join-Path $root "brand\fleetyes_logo.svg"
$iconDir = Join-Path $root "icons"
$tmp = Join-Path $env:TEMP ("rlb-icons-" + [guid]::NewGuid().ToString("N").Substring(0, 8))

if (-not (Test-Path $svg)) { throw "missing source: $svg" }
New-Item -ItemType Directory -Path $iconDir -Force | Out-Null
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "no Chrome/Edge found to rasterize the SVG" }
Write-Output ("rasterizing with: " + (Split-Path -Leaf $chrome))

# --- 1. render the SVG large, on transparent, so we can measure it ------------
$MASTER = 1024
$svgMarkup = Get-Content $svg -Raw -Encoding UTF8
$svgMarkup = $svgMarkup -replace '<\?xml[^>]*\?>', ''
$html = @"
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
  body{width:${MASTER}px;height:${MASTER}px;}
  svg{width:${MASTER}px;height:${MASTER}px;display:block;}
</style>
$svgMarkup
"@
$htmlPath = Join-Path $tmp "icon.html"
[System.IO.File]::WriteAllText($htmlPath, $html, (New-Object System.Text.UTF8Encoding($false)))

$masterPng = Join-Path $tmp "master.png"
# Start-Process, not the call operator: Chrome writes progress to stderr, and
# PowerShell 5.1 wraps native stderr in NativeCommandError records that trip
# $ErrorActionPreference='Stop' even on a successful exit code 0.
$argList = @(
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--virtual-time-budget=4000",
    "--default-background-color=00000000",
    ('--user-data-dir="' + (Join-Path $tmp "profile") + '"'),
    ("--window-size=" + $MASTER + "," + $MASTER),
    ('--screenshot="' + $masterPng + '"'),
    ('"file:///' + ($htmlPath -replace '\\', '/') + '"')
)
Start-Process -FilePath $chrome -ArgumentList $argList -Wait -NoNewWindow `
    -RedirectStandardOutput (Join-Path $tmp "out.log") `
    -RedirectStandardError (Join-Path $tmp "err.log") | Out-Null
if (-not (Test-Path $masterPng)) {
    $err = if (Test-Path (Join-Path $tmp "err.log")) { Get-Content (Join-Path $tmp "err.log") -Raw } else { "(no stderr)" }
    throw ("headless render produced no PNG. chrome stderr:`n" + $err)
}

# --- 2. find the mark's real alpha bounding box -------------------------------
$src = [System.Drawing.Bitmap]::FromFile($masterPng)
$rect = New-Object System.Drawing.Rectangle(0, 0, $src.Width, $src.Height)
$data = $src.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $src.Height)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$src.UnlockBits($data)

$minX = $src.Width; $minY = $src.Height; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $src.Height; $y++) {
    $row = $y * $data.Stride
    for ($x = 0; $x -lt $src.Width; $x++) {
        if ($bytes[$row + $x * 4 + 3] -gt 8) {
            if ($x -lt $minX) { $minX = $x }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}
if ($maxX -lt 0) { throw "rendered image is fully transparent - the SVG did not draw" }
$bw = $maxX - $minX + 1
$bh = $maxY - $minY + 1
Write-Output ("mark bounds: ${bw}x${bh} at ($minX,$minY) within ${MASTER}x${MASTER}")

# --- 3. crop, pad to square, downsample to each target ------------------------
$cropped = New-Object System.Drawing.Bitmap($bw, $bh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($cropped)
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $bw, $bh)), $minX, $minY, $bw, $bh, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$src.Dispose()

$bgColor = if ($Background -eq "transparent") { [System.Drawing.Color]::Transparent } else { [System.Drawing.ColorTranslator]::FromHtml($Background) }

foreach ($size in 16, 32, 48, 128) {
    $canvas = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gc = [System.Drawing.Graphics]::FromImage($canvas)
    $gc.Clear($bgColor)
    $gc.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gc.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gc.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $gc.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $avail = $size * (1.0 - ($PadPercent * 2.0 / 100.0))
    $scale = [Math]::Min($avail / $bw, $avail / $bh)
    $dw = [Math]::Max(1, [int][Math]::Round($bw * $scale))
    $dh = [Math]::Max(1, [int][Math]::Round($bh * $scale))
    $dx = [int][Math]::Round(($size - $dw) / 2.0)
    $dy = [int][Math]::Round(($size - $dh) / 2.0)

    $gc.DrawImage($cropped, (New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)))
    $gc.Dispose()

    $out = Join-Path $iconDir ("icon" + $size + ".png")
    $canvas.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Dispose()
    Write-Output ("wrote icons/icon" + $size + ".png  (mark " + $dw + "x" + $dh + ")")
}

$cropped.Dispose()
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Output "done"
