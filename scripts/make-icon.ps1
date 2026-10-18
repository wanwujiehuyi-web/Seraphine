$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'app'
$svgPath = Join-Path $appDir 'seraphine-icon.svg'
$renderPath = Join-Path $env:TEMP 'seraphine-icon-render.png'
if (-not (Test-Path $svgPath)) { throw "找不到图标源文件：$svgPath" }

$edgeCandidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw '找不到 Edge，无法渲染 SVG 图标' }

$uri = ([System.Uri]$svgPath).AbsoluteUri
$edgeArgs = @(
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=256,256',
  '--force-device-scale-factor=1',
  '--default-background-color=00000000',
  "--screenshot=$renderPath",
  $uri
)
Start-Process -FilePath $edge -ArgumentList $edgeArgs -Wait -WindowStyle Hidden
if (-not (Test-Path $renderPath)) { throw 'Edge 没有生成图标截图' }

$src = [System.Drawing.Image]::FromFile($renderPath)
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, 256, 256), 0, 0, [Math]::Min(256, $src.Width), [Math]::Min(256, $src.Height), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$src.Dispose()

$pngPath = Join-Path $appDir 'seraphine-icon.png'
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Save((Join-Path $appDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

function Resize-Icon([System.Drawing.Image]$image, [int]$size) {
  $out = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($image, 0, 0, $size, $size)
  $g.Dispose()
  return $out
}

$sizes = @(16, 32, 48, 64, 128, 256)
$entries = @()
foreach ($size in $sizes) {
  $scaled = Resize-Icon $bmp $size
  $ms = New-Object System.IO.MemoryStream
  $scaled.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $entries += [pscustomobject]@{ Size = $size; Bytes = $ms.ToArray() }
  $ms.Dispose()
  $scaled.Dispose()
}
$bmp.Dispose()

function Write-Ico([string]$path) {
  $fs = [System.IO.File]::Create($path)
  $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]$entries.Count)
  $offset = 6 + 16 * $entries.Count
  foreach ($entry in $entries) {
    $dim = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$entry.Bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $entry.Bytes.Length
  }
  foreach ($entry in $entries) { $bw.Write($entry.Bytes) }
  $bw.Flush(); $bw.Close(); $fs.Close()
}

Write-Ico (Join-Path $appDir 'seraphine-icon.ico')
Write-Ico (Join-Path $appDir 'icon.ico')
Remove-Item -Force $renderPath -ErrorAction SilentlyContinue
Write-Output "icon: $pngPath"
Copy-Item (Join-Path $appDir 'seraphine-icon.png') (Join-Path $appDir 'seraphine-avatar.png') -Force
Copy-Item (Join-Path $appDir 'seraphine-icon.ico') (Join-Path $appDir 'seraphine-avatar.ico') -Force
Copy-Item (Join-Path $appDir 'seraphine-icon.png') (Join-Path $appDir 'seraphine-final.png') -Force
Copy-Item (Join-Path $appDir 'seraphine-icon.ico') (Join-Path $appDir 'seraphine-final.ico') -Force
Write-Output "ico:  $(Join-Path $appDir 'seraphine-icon.ico')"
