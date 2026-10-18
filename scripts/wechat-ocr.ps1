param([string]$OutDir = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WxCap {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static IntPtr Best(uint[] pids){
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
}
'@

[WxCap]::SetProcessDPIAware() | Out-Null
$pids = [uint32[]](Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($pids.Count -eq 0) { '{"ok":false,"error":"wechat_not_running"}'; exit 0 }
$hwnd = [WxCap]::Best($pids)
if ($hwnd -eq [IntPtr]::Zero) { '{"ok":false,"error":"no_wechat_window"}'; exit 0 }

$wasVisible = [WxCap]::IsWindowVisible($hwnd)
$wasMin = [WxCap]::IsIconic($hwnd)
[WxCap]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
[WxCap]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 900

$r = New-Object WxCap+RECT
[WxCap]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { '{"ok":false,"error":"bad_window_size"}'; exit 0 }

if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'group-digest' }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$image = Join-Path $OutDir ("wechat-$stamp.png")

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($image, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

if (-not $wasVisible) { [WxCap]::ShowWindow($hwnd, 0) | Out-Null }      # SW_HIDE
elseif ($wasMin) { [WxCap]::ShowWindow($hwnd, 6) | Out-Null }            # SW_MINIMIZE

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

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($image)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$language = New-Object Windows.Globalization.Language 'zh-Hans'
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
$text = ''
if ($engine) {
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $text = $result.Text
}

[pscustomobject]@{
  ok = $true
  hwnd = [int64]$hwnd
  image = $image
  text = $text
  chars = $text.Length
  wasVisible = $wasVisible
  wasMinimized = $wasMin
} | ConvertTo-Json -Depth 4 -Compress
