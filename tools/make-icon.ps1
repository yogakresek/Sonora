# Draws the placeholder app icon (gradient disc with five bars, same design as AppIcon.cs) and
# writes a multi-size .ico (PNG entries) to host/Sonora.Host/Assets/sonora.ico.
param([string]$Out = (Join-Path $PSScriptRoot '..\host\Sonora.Host\Assets\sonora.ico'))

Add-Type -AssemblyName System.Drawing

function New-IconPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = [single]$size
    $rect = New-Object System.Drawing.RectangleF 0, 0, $s, $s
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 124, 58, 237)), ([System.Drawing.Color]::FromArgb(255, 34, 211, 238)), 45
    $g.FillEllipse($bg, [single]($s * 0.02), [single]($s * 0.02), [single]($s * 0.96), [single]($s * 0.96))
    $heights = 0.30, 0.55, 0.80, 0.55, 0.30
    $barW = $s / 11; $gap = $s / 22
    $x = ($s - ($heights.Count * $barW + ($heights.Count - 1) * $gap)) / 2
    $white = [System.Drawing.Brushes]::White
    foreach ($h in $heights) {
        $bh = $s * 0.6 * $h
        $g.FillRectangle($white, [single]$x, [single](($s - $bh) / 2), [single]$barW, [single]$bh)
        $x += $barW + $gap
    }
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

$sizes = 256, 64, 48, 32, 24, 16
$images = $sizes | ForEach-Object { , (New-IconPng $_) }

New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$fs = [System.IO.File]::Create($Out)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]; $len = $images[$i].Length
    $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$len); $w.Write([uint32]$offset)
    $offset += $len
}
foreach ($img in $images) { $w.Write($img) }
$w.Dispose()
"wrote $Out"
