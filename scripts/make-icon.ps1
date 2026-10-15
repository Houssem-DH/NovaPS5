# Builds build/icon.ico (multi-resolution, PNG frames) from public/icon.png.
# electron-builder uses this for the exe, installer and shortcuts; the app also
# loads it for the window and tray icon. Re-run after changing public/icon.png.
#
#   powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'public\icon.png'
$target = Join-Path $root 'build\icon.ico'

if (-not (Test-Path $source)) { throw "Missing source icon: $source" }
New-Item -ItemType Directory -Force -Path (Join-Path $root 'build') | Out-Null

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$src = [System.Drawing.Image]::FromFile((Resolve-Path $source).Path)

$frames = @()
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gfx.DrawImage($src, 0, 0, $size, $size)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames += , $ms.ToArray()
  $gfx.Dispose()
  $bmp.Dispose()
}
$src.Dispose()

$fs = [System.IO.File]::Create($target)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type: icon
$bw.Write([UInt16]$sizes.Count)      # image count

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $size = $sizes[$i]
  $data = $frames[$i]
  $dim = if ($size -ge 256) { 0 } else { $size }  # 0 means 256 in ICO
  $bw.Write([Byte]$dim)              # width
  $bw.Write([Byte]$dim)              # height
  $bw.Write([Byte]0)                 # palette colours
  $bw.Write([Byte]0)                 # reserved
  $bw.Write([UInt16]1)               # colour planes
  $bw.Write([UInt16]32)              # bits per pixel
  $bw.Write([UInt32]$data.Length)    # payload size
  $bw.Write([UInt32]$offset)         # payload offset
  $offset += $data.Length
}
foreach ($data in $frames) { $bw.Write($data) }
$bw.Close()
$fs.Close()

Write-Output ("icon written: " + $target + " (" + $sizes.Count + " sizes, " + [Math]::Round((Get-Item $target).Length / 1KB) + " KB)")
