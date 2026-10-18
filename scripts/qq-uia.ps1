param(
  [ValidateSet('sessions','chat','open')][string]$Mode = 'sessions',
  [int]$Index = -1,
  [string]$GroupName = '',
  [string]$GroupNameB64 = ''
)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if ($GroupNameB64) {
  $GroupName = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($GroupNameB64))
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class QqWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static IntPtr Best(uint[] pids){
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h,l)=>{
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids,pid) < 0) return true;
      var c = new StringBuilder(128); GetClassName(h,c,128);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(128); GetWindowText(h,t,128);
      if (t.ToString() != "QQ") return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.Right-r.Left) * (r.Bottom-r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static IntPtr[] All(uint[] pids){
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h,l)=>{
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids,pid) < 0) return true;
      var c = new StringBuilder(128); GetClassName(h,c,128);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(128); GetWindowText(h,t,128);
      if (t.ToString() != "QQ") return true;
      list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
'@

$pids = [uint32[]](Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($pids.Count -eq 0) { '{"ok":false,"error":"qq_not_running"}'; exit 0 }

function Get-All($el) {
  return $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}

# 主窗口 = 会话列表项最多的那个 QQ 窗口。不能按面积选：QQ 最小化后
# GetWindowRect 会返回 158x26，而某些空壳窗口反而更大。
$hwnd = [IntPtr]::Zero
$root = $null
$bestCount = -1
foreach ($wh in [QqWin]::All($pids)) {
  $wr = [System.Windows.Automation.AutomationElement]::FromHandle($wh)
  if (-not $wr) { continue }
  $witems = Get-All $wr
  $count = 0
  for ($wi = 0; $wi -lt $witems.Count; $wi++) {
    if ($witems.Item($wi).Current.ClassName -eq 'recent-contact-item') { $count++ }
  }
  if ($count -gt $bestCount) {
    $bestCount = $count
    $hwnd = $wh
    $root = $wr
  }
}
if (-not $root) { '{"ok":false,"error":"no_qq_window"}'; exit 0 }

function Is-Time([string]$s) {
  return $s -match '^(\d{1,2}:\d{2}|(昨天|今天)\s*\d{1,2}:\d{2}|昨天|今天|(星期|周)[一二三四五六日]\s*(\d{1,2}:\d{2})?|\d{1,2}/\d{1,2}|\d{1,2}月\d{1,2}日(\s*\d{1,2}:\d{2})?)$'
}

function Get-Sessions($rootEl) {
  $all = Get-All $rootEl
  $rows = @()
  for ($i = 0; $i -lt $all.Count; $i++) {
    $e = $all.Item($i)
    if ($e.Current.ClassName -ne 'recent-contact-item') { continue }
    $rect = $e.Current.BoundingRectangle
    $kids = Get-All $e
    $texts = @()
    $sender = ''
    $previewParts = @()
    $unread = 0
    for ($j = 0; $j -lt $kids.Count; $j++) {
      $k = $kids.Item($j)
      if ($k.Current.ControlType.ProgrammaticName -ne 'ControlType.Text') { continue }
      $t = [string]$k.Current.Name
      if (-not $t) { continue }
      $r = $k.Current.BoundingRectangle
      $texts += [pscustomobject]@{ Text = $t; X = [int]$r.X; Y = [int]$r.Y; W = [int]$r.Width }
    }
    # 群名：行上半部分、靠左
    $topTexts = $texts | Where-Object { $_.Y -lt ($rect.Y + $rect.Height * 0.45) -and -not (Is-Time $_.Text) -and $_.Text -notmatch '^\(\d+\)$' -and $_.Text -notmatch '^\d+条未读$' }
    $name = ($topTexts | Sort-Object X | ForEach-Object { $_.Text }) -join ''
    # 时间：右侧、短
    $time = ''
    $timeText = $texts | Where-Object { Is-Time $_.Text } | Select-Object -First 1
    if ($timeText) { $time = $timeText.Text }
    # 未读：Group 名称 / 右侧数字
    $groups = $kids | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Group' }
    foreach ($g in $groups) {
      if ($g.Current.Name -match '^(\d+)条未读$') { $unread = [int]$Matches[1] }
    }
    # 发送者 / 预览：行下半部分
    $bottom = $texts | Where-Object { $_.Y -ge ($rect.Y + $rect.Height * 0.45) -and -not (Is-Time $_.Text) }
    $bottom = $bottom | Sort-Object X
    foreach ($b in $bottom) {
      if ($b.Text -match '：$|:$') { if (-not $sender) { $sender = ($b.Text -replace '[：:]$','') } }
      elseif ($b.Text -match '^\d+$') { continue }
      elseif ($b.Text -eq '免打扰') { continue }
      else { $previewParts += $b.Text }
    }
    $preview = ($previewParts -join ' ')
    if (-not $unread) {
      foreach ($b in $bottom) { if ($b.Text -match '^\d+$' -and $b.X -gt ($rect.X + $rect.Width * 0.85)) { $unread = [int]$b.Text } }
    }
    if (-not $name) { $name = ($texts | Sort-Object Y, X | Select-Object -First 1).Text }
    $rows += [pscustomobject]@{
      index = $rows.Count
      name = $name
      time = $time
      sender = $sender
      preview = $preview
      unread = $unread
      x = [int]$rect.X
      y = [int]$rect.Y
      width = [int]$rect.Width
      height = [int]$rect.Height
    }
  }
  return $rows
}

if ($Mode -eq 'sessions') {
  $sessions = Get-Sessions $root
  $payload = [pscustomobject]@{
    ok = $true
    hwnd = [int64]$hwnd
    sessions = @($sessions)
    needsAccessibility = ($sessions.Count -eq 0)
  }
  $payload | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

if ($Mode -eq 'open') {
  $all = Get-All $root
  $rows = @()
  for ($i = 0; $i -lt $all.Count; $i++) {
    $e = $all.Item($i)
    if ($e.Current.ClassName -eq 'recent-contact-item') { $rows += $e }
  }
  $target = $null
  if ($GroupName) {
    for ($ri = 0; $ri -lt $rows.Count; $ri++) {
      $rowTexts = Get-All $rows[$ri]
      $rowNames = @()
      for ($rj = 0; $rj -lt $rowTexts.Count; $rj++) {
        $rn = [string]$rowTexts.Item($rj).Current.Name
        if ($rn) { $rowNames += $rn }
      }
      if (($rowNames -contains $GroupName) -or (($rowNames -join '') -like "*$GroupName*")) {
        $target = $rows[$ri]
        break
      }
    }
  } elseif ($Index -ge 0 -and $Index -lt $rows.Count) {
    $target = $rows[$Index]
  }
  # 读群是用户主动操作：把 QQ 主窗口恢复出来，聊天区才能渲染。
  [QqWin]::ShowWindow($hwnd, 9) | Out-Null
  [QqWin]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 400
  $invoked = $false
  # 会话列表是虚拟化的，目标群可能不在当前渲染的 14 行里。退化为搜索框。
  if (-not $target -and $GroupName) {
    $allNow = Get-All $root
    $searchEdit = $null
    for ($si = 0; $si -lt $allNow.Count; $si++) {
      $se = $allNow.Item($si)
      if ($se.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and $se.Current.Name -eq '搜索') {
        $searchEdit = $se
        break
      }
    }
    if ($searchEdit) {
      $vp = $searchEdit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $vp.SetValue($GroupName)
      Start-Sleep -Milliseconds 1500
      $results = Get-All $root
      for ($ri = 0; $ri -lt $results.Count; $ri++) {
        $re = $results.Item($ri)
        $rcn = $re.Current.ClassName
        $rnm = [string]$re.Current.Name
        if (-not $rnm) { continue }
        if ($rnm -like "*$GroupName*" -and ($rcn -match 'search-result-item' -or $re.Current.ControlType.ProgrammaticName -eq 'ControlType.ListItem')) {
          try {
            $re.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            $invoked = $true
            break
          } catch {}
        }
      }
      $vp.SetValue('')
      Start-Sleep -Milliseconds 1200
    }
  }
  if (-not $target -and -not $invoked) {
    $sample = @()
    for ($si = 0; $si -lt [Math]::Min(3, $rows.Count); $si++) {
      $st = Get-All $rows[$si]
      $sn = @()
      for ($sj = 0; $sj -lt $st.Count; $sj++) { if ($st.Item($sj).Current.Name) { $sn += [string]$st.Item($sj).Current.Name } }
      $sample += ($sn -join '|')
    }
    [pscustomobject]@{ ok = $false; error = 'group_not_found'; requested = $GroupName; rows = $rows.Count; sample = $sample } | ConvertTo-Json -Depth 4 -Compress
    exit 0
  }
  if (-not $invoked -and $target) {
    $invoke = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
  }
  Start-Sleep -Milliseconds 1800
  # 如果 QQ 把会话开在独立窗口且该窗口是隐藏的，把它显示出来以触发渲染。
  foreach ($wh in [QqWin]::All($pids)) {
    $wr = [System.Windows.Automation.AutomationElement]::FromHandle($wh)
    if (-not $wr) { continue }
    $hit = $wr.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'chat-header__contact-name')))
    if ($hit -and -not [QqWin]::IsWindowVisible($wh)) {
      [QqWin]::ShowWindow($wh, 9) | Out-Null
      [QqWin]::SetForegroundWindow($wh) | Out-Null
      Start-Sleep -Milliseconds 1200
      break
    }
  }
  '{"ok":true}'
  exit 0
}

# Mode = chat
# QQ 可能把会话开在独立窗口里（主窗口之外）。在所有 QQ 窗口里选
# “消息气泡最多 / 有聊天标题”的那个。
$chatRoot = $null
$chatHwnd = [int64]$hwnd
$bestScore = -1
foreach ($wh in [QqWin]::All($pids)) {
  $wr = [System.Windows.Automation.AutomationElement]::FromHandle($wh)
  if (-not $wr) { continue }
  $witems = Get-All $wr
  $msgCount = 0
  $hasHeader = $false
  for ($wi = 0; $wi -lt $witems.Count; $wi++) {
    $wc = $witems.Item($wi).Current.ClassName
    if ($wc -eq 'message') { $msgCount++ }
    if ($wc -eq 'chat-header__contact-name') { $hasHeader = $true }
  }
  $score = $msgCount * 10
  if ($hasHeader) { $score += 5 }
  if ($score -gt $bestScore -and ($msgCount -gt 0 -or $hasHeader)) {
    $bestScore = $score
    $chatRoot = $wr
    $chatHwnd = [int64]$wh
  }
}
if (-not $chatRoot) { $chatRoot = $root }
$all = Get-All $chatRoot
$chatName = ''
$header = $all | Where-Object { $_.Current.ClassName -eq 'chat-header__contact-name' } | Select-Object -First 1
if ($header) { $chatName = [string]$header.Current.Name }
$messages = @()
for ($i = 0; $i -lt $all.Count; $i++) {
  $e = $all.Item($i)
  if ($e.Current.ClassName -ne 'message') { continue }
  $kids = Get-All $e
  $timestamp = ''
  $sender = ''
  $senderY = 0
  $parts = @()
  $hasImage = $false
  for ($j = 0; $j -lt $kids.Count; $j++) {
    $k = $kids.Item($j)
    $r = $k.Current.BoundingRectangle
    $cn = $k.Current.ClassName
    $n = [string]$k.Current.Name
    if ($k.Current.ControlType.ProgrammaticName -eq 'ControlType.Group' -and $cn -match 'avatar-span') {
      if (-not $sender) { $sender = $n; $senderY = [int]$r.Y }
      continue
    }
    if ($k.Current.ControlType.ProgrammaticName -eq 'ControlType.Image') {
      if ($cn -match 'pic-element') { $hasImage = $true }
      continue
    }
    if ($k.Current.ControlType.ProgrammaticName -ne 'ControlType.Text') { continue }
    if (-not $n) { continue }
    if (Is-Time $n) { if (-not $timestamp) { $timestamp = $n }; continue }
    if ($n -eq 'LV' -or $n -eq $sender -or $n -match '^[0-9]+$') { continue }
    if ($n -match '^(王者|白银|黄金|铂金|钻石|星耀|青铜|大师|宗师)$') { continue }
    if ($senderY -and $r.Y -lt ($senderY + 12) -and $r.X -lt 1200) { continue }
    $parts += [pscustomobject]@{ Text = $n; X = [int]$r.X; Y = [int]$r.Y }
  }
  if (-not $sender) { continue }
  $text = (($parts | Sort-Object Y, X | ForEach-Object { $_.Text }) -join '').Trim()
  if ($hasImage) { $text = ($text + ' [图片]').Trim() }
  if (-not $text) { $text = if ($hasImage) { '[图片]' } else { '' } }
  if (-not $text) { continue }
  $messages += [pscustomobject]@{
    timestamp = $timestamp
    sender = $sender
    text = $text
    isSystem = ($text -match '撤回了一条|加入了群聊|退出了群聊|群公告')
  }
}
[pscustomobject]@{
  ok = $true
  hwnd = $chatHwnd
  chatName = $chatName
  messages = @($messages)
} | ConvertTo-Json -Depth 6 -Compress
