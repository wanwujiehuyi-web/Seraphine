param(
  [string]$OutDir = '',
  [int]$ClickX = -1,
  [int]$ClickY = -1,
  [int]$Pages = 1,
  [int]$ChatPages = 1,
  [string]$GroupNameB64 = '',
  [string]$SinceB64 = '',
  [switch]$Foreground
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$GroupName = ''
if ($GroupNameB64) {
  $GroupName = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($GroupNameB64))
}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WxScan {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static IntPtr Best(uint[] pids) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h,l)=>{
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids,pid) < 0) return true;
      var c = new StringBuilder(128); GetClassName(h,c,128);
      if (c.ToString() != "Qt51514QWindowIcon") return true;
      var t = new StringBuilder(128); GetWindowText(h,t,128);
      if (t.ToString() != "微信") return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.Right-r.Left) * (r.Bottom-r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static void Click(int x, int y) {
    SetCursorPos(x,y); System.Threading.Thread.Sleep(120);
    mouse_event(0x0002,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(60);
    mouse_event(0x0004,0,0,0,IntPtr.Zero);
  }
  public static void Scroll(int x, int y, int delta) {
    SetCursorPos(x,y); System.Threading.Thread.Sleep(100);
    mouse_event(0x0800,0,0,unchecked((uint)delta),IntPtr.Zero);
  }
  public static void ClickClient(IntPtr h, int x, int y) {
    int lp = ((y & 0xFFFF) << 16) | (x & 0xFFFF);
    PostMessage(h, 0x0200, IntPtr.Zero, (IntPtr)lp);
    System.Threading.Thread.Sleep(40);
    PostMessage(h, 0x0201, (IntPtr)1, (IntPtr)lp);
    System.Threading.Thread.Sleep(60);
    PostMessage(h, 0x0202, IntPtr.Zero, (IntPtr)lp);
  }
  public static void ScrollClient(IntPtr h, int x, int y, int delta) {
    var p = new POINT(); p.X = x; p.Y = y;
    ClientToScreen(h, ref p);
    int wp = unchecked((int)((uint)(ushort)delta << 16));
    int lp = ((p.Y & 0xFFFF) << 16) | (p.X & 0xFFFF);
    PostMessage(h, 0x020A, (IntPtr)wp, (IntPtr)lp);
  }
}
'@

[WxScan]::SetProcessDPIAware() | Out-Null
$pids = [uint32[]](Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($pids.Count -eq 0) { '{"ok":false,"error":"wechat_not_running"}'; exit 0 }
$hwnd = [WxScan]::Best($pids)
if ($hwnd -eq [IntPtr]::Zero) { '{"ok":false,"error":"no_wechat_window"}'; exit 0 }

$wasVisible = [WxScan]::IsWindowVisible($hwnd)
$wasMin = [WxScan]::IsIconic($hwnd)
$origRect = New-Object WxScan+RECT
[WxScan]::GetWindowRect($hwnd, [ref]$origRect) | Out-Null
$restoreHidden = $false

if ($Foreground) {
  [WxScan]::ShowWindow($hwnd, 9) | Out-Null
  [WxScan]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
  [WxScan]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 700
  [WxScan]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null
} elseif (-not $wasVisible -or $wasMin) {
  # 窗口最小化/收进托盘时 DWM 不渲染；把它以“不激活”的方式在屏幕外复活，
  # 截图/点击完再恢复原状，用户看不到窗口，也不会被抢焦点。
  $restoreHidden = $true
  [WxScan]::SetWindowPos($hwnd, [IntPtr]::Zero, -5000, -5000, 0, 0, 0x0013) | Out-Null
  [WxScan]::ShowWindow($hwnd, 4) | Out-Null
  Start-Sleep -Milliseconds 800
}

function Restore-WechatState {
  if ($restoreHidden) {
    if ($wasMin) { [WxScan]::ShowWindow($hwnd, 6) | Out-Null }
    else { [WxScan]::ShowWindow($hwnd, 0) | Out-Null }
    [WxScan]::SetWindowPos($hwnd, [IntPtr]::Zero, $origRect.Left, $origRect.Top, 0, 0, 0x0013) | Out-Null
  } elseif ($Foreground) {
    if (-not $wasVisible) { [WxScan]::ShowWindow($hwnd, 0) | Out-Null }
    elseif ($wasMin) { [WxScan]::ShowWindow($hwnd, 6) | Out-Null }
  }
}

trap {
  try { Restore-WechatState } catch {}
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 0
}

$rect = New-Object WxScan+RECT
[WxScan]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { '{"ok":false,"error":"bad_window_size"}'; exit 0 }

# 截图是“整窗”坐标；后台点击/滚轮要的是“客户区”坐标。
$clientOrigin = New-Object WxScan+POINT
[WxScan]::ClientToScreen($hwnd, [ref]$clientOrigin) | Out-Null
$offsetX = $clientOrigin.X - $rect.Left
$offsetY = $clientOrigin.Y - $rect.Top

if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'group-digest' }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Save-Shot([string]$name) {
  $path = Join-Path $OutDir $name
  $bmp = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  if ($Foreground) {
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
  } else {
    $dc = $g.GetHdc()
    $ok = [WxScan]::PrintWindow($hwnd, $dc, 2)
    $g.ReleaseHdc($dc)
    if (-not $ok) { throw 'PrintWindow failed' }
  }
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return $path
}

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]

function Await($WinRtTask, $ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$engine = $null
try {
  $language = New-Object Windows.Globalization.Language 'zh-Hans'
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
} catch {}
if (-not $engine) { '{"ok":false,"error":"ocr_unavailable"}'; exit 0 }

function Ocr-Shot([string]$path) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $result.Lines) {
    $text = $line.Text
    if (-not $text) { continue }
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    if ($minX -eq [double]::MaxValue) { $minX = 0; $minY = 0; $maxX = 1; $maxY = 1 }
    $lines += [pscustomobject]@{
      text = $text
      x = [int]$minX
      y = [int]$minY
      w = [int]($maxX - $minX)
      h = [int]($maxY - $minY)
    }
  }
  return $lines
}

function Norm([string]$s) {
  if (-not $s) { return '' }
  return (($s -replace '\s+', '') -replace '[．.·…]', '').ToLower()
}

function Invoke-Click([int]$imgX, [int]$imgY) {
  if ($Foreground) {
    [WxScan]::Click(($rect.Left + $imgX), ($rect.Top + $imgY))
  } else {
    [WxScan]::ClickClient($hwnd, ($imgX - $offsetX), ($imgY - $offsetY))
  }
}

function Invoke-Scroll([int]$imgX, [int]$imgY, [int]$delta) {
  if ($Foreground) {
    [WxScan]::Scroll(($rect.Left + $imgX), ($rect.Top + $imgY), $delta)
  } else {
    [WxScan]::ScrollClient($hwnd, ($imgX - $offsetX), ($imgY - $offsetY), $delta)
  }
}

$listX = [int]($width * 0.17)
$listY = [int]($height * 0.45)
$targetKey = Norm $GroupName
$PageShots = @()
$foundLine = $null

# 先滚到会话列表顶部，保证每次读取顺序稳定。
Invoke-Scroll $listX $listY (120 * 40)
Start-Sleep -Milliseconds 400

$pageCount = [Math]::Max(1, $Pages)
for ($p = 0; $p -lt $pageCount; $p++) {
  $path = Save-Shot ("wechat-list-$stamp-$p.png")
  $lines = Ocr-Shot $path
  $PageShots += [pscustomobject]@{ image = $path; lines = @($lines) }

  if ($targetKey) {
    foreach ($line in $lines) {
      if ($line.x -gt ($width * 0.35)) { continue }
      $key = Norm $line.text
      if ($key.Length -ge 2 -and ($key.Contains($targetKey) -or $targetKey.Contains($key))) {
        $foundLine = $line
        break
      }
    }
    if ($foundLine) { break }
  }

  if ($p -lt $pageCount - 1) {
    Invoke-Scroll $listX $listY (-120 * 4)
    Start-Sleep -Milliseconds 550
  }
}

function Capture-ChatPages([string]$tag) {
  $shots = @()
  $count = [Math]::Max(1, $ChatPages)
  $lastFingerprint = ''
  if ($SinceB64) {
    try {
      $sinceText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($SinceB64))
    } catch {
      $sinceText = ''
    }
  }
  for ($i = 0; $i -lt $count; $i++) {
    $shotPath = Save-Shot ("wechat-chat-$stamp-$tag-$i.png")
    $shotLines = Ocr-Shot $shotPath
    $shots += [pscustomobject]@{ image = $shotPath; lines = @($shotLines) }

    # 内容指纹：两页完全一样说明滚不动了，提前结束。
    $fingerprint = (($shotLines | ForEach-Object { $_.text }) -join '|')
    if ($i -gt 0 -and $fingerprint -and $fingerprint -eq $lastFingerprint) { break }
    $lastFingerprint = $fingerprint

    # 翻到更早的时间戳就停；只认短时间行，避免消息正文里的“昨天”误触发。
    if ($sinceText -and $i -gt 0) {
      $older = $false
      foreach ($line in $shotLines) {
        $t = Norm $line.text
        if ($t.Length -gt 18) { continue }
        if ($t -match '^(昨天|今天)?\d{1,2}:\d{1,2}$') { $older = $true; break }
        if ($t -match '^(星期|周)[一二三四五六日]$') { $older = $true; break }
        if ($t -match '^\d{4}年\d{1,2}月\d{1,2}日') { $older = $true; break }
      }
      if ($older) { break }
    }

    if ($i -lt $count - 1) {
      # 向上滚，加载更早的消息。
      Invoke-Scroll ([int]($width * 0.72)) ([int]($height * 0.45)) (120 * 4)
      Start-Sleep -Milliseconds 650
    }
  }
  $taken = $shots.Count
  if ($taken -gt 1) {
    # 回到最新消息位置，别把用户的聊天停在历史里。
    Invoke-Scroll ([int]($width * 0.72)) ([int]($height * 0.45)) (-120 * 4 * ($taken - 1))
    Start-Sleep -Milliseconds 350
  }
  return $shots
}

$listPath = $PageShots[0].image
$listLines = $PageShots[0].lines
$chatPath = $null
$chatLines = $null
$chatShotPages = @()

if ($foundLine) {
  Invoke-Click $listX ($foundLine.y + 12)
  Start-Sleep -Milliseconds 3000
  $chatShotPages = @(Capture-ChatPages 'byName')
} elseif ($GroupName) {
  Invoke-Scroll $listX $listY (120 * 40)
  Restore-WechatState
  [pscustomobject]@{ ok = $false; error = 'group_not_found'; requested = $GroupName } | ConvertTo-Json -Compress
  exit 0
} elseif ($ClickX -ge 0 -and $ClickY -ge 0) {
  Invoke-Click $ClickX $ClickY
  Start-Sleep -Milliseconds 3000
  $chatShotPages = @(Capture-ChatPages 'byClick')
}

if ($chatShotPages.Count -gt 0) {
  $chatPath = $chatShotPages[0].image
  $chatLines = $chatShotPages[0].lines
}

# 没指定群时，读完页面把列表滚回顶部。
if (-not $foundLine) {
  Invoke-Scroll $listX $listY (120 * 40)
  Start-Sleep -Milliseconds 300
}

Restore-WechatState

[pscustomobject]@{
  ok = $true
  hwnd = [int64]$hwnd
  width = $width
  height = $height
  list = [pscustomobject]@{ image = $listPath; lines = @($listLines); pages = @($PageShots) }
  chat = if ($chatPath) { [pscustomobject]@{ image = $chatPath; lines = @($chatLines); pages = @($chatShotPages) } } else { $null }
  wasVisible = $wasVisible
  wasMinimized = $wasMin
  background = (-not $Foreground)
  at = (Get-Date).ToString('o')
} | ConvertTo-Json -Depth 8 -Compress
