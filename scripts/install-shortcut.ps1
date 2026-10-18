$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root '启动萨勒芬妮.vbs'
$icon = Join-Path $root 'app\seraphine-final.ico'
if (-not (Test-Path $target)) { throw "找不到启动脚本：$target" }
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop '萨勒芬妮.lnk'
$oldPath = Join-Path $desktop '群聊情报官.lnk'
if (Test-Path $oldPath) { Remove-Item -Force $oldPath }
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments = '"' + $target + '"'
$lnk.WorkingDirectory = $root
$lnk.Description = '萨勒芬妮 · 本机群聊情报与日程'
if (Test-Path $icon) { $lnk.IconLocation = $icon }
$lnk.Save()
Write-Output "已创建桌面快捷方式：$lnkPath"
