# 把「开机自启」装成 Windows 计划任务（登录后延迟 30 秒跑 tools\boot-up.ps1）。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart.ps1            # 装
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart.ps1 -Status    # 看现在装了没 + 上次结果
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart.ps1 -Remove    # 撤掉
#
# 设计取舍（都写在这儿，省得下次重新想）：
#   * **当前用户 + 交互式登录**、**不要求管理员**（RunLevel 不用 Highest）—— 开机自启不该逼用户过 UAC ✗；
#   * 触发点用 **AtLogOn + 30 秒延迟**：刚登录那几秒网络还没通、Tailscale 也可能没起来，
#     立刻跑必然失败 ✗（boot-up.ps1 自己也会等 Tailscale，这里是双层保险 ✓）；
#   * 失败重试 3 次 / 每次隔 2 分钟 ✓：开机时网络抖动很常见，不该一次失败就放弃一整晚 ✓；
#   * 超时 15 分钟（DSH 首次启动可能要一分多钟，但绝不该无限挂着 ✓）；
#   * 只认 PowerShell 5.1 的路径（系统自带）✓，不依赖 pwsh 7 ✓。
#
# 日志：%USERPROFILE%\.dsh\launcher\boot-up.log（boot-up.ps1 写的）

param(
	[switch]$Remove,
	[switch]$Status,
	[int]$DelaySeconds = 30
)

$ErrorActionPreference = 'Stop'

$TaskName = 'DSH 手机桥 · 开机自启'
$BootUpSource = Join-Path $PSScriptRoot 'boot-up.ps1'
$DshDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$LauncherDir = Join-Path $DshDir 'launcher'
# ⚠️ 任务要指向**稳定副本**，不能指向插件源码目录：源码会随重装/换机器消失，
# 那样开机自启会静默失效 ✗（最难查的那种"说不清为什么没起来"）。
# 和 open-dsh.ps1 一样放进 ~/.dsh/launcher/ ✓ —— 这台机器上这些东西的家。
$BootUp = Join-Path $LauncherDir 'boot-up.ps1'
$PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Get-ExistingTask {
	try { return Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { return $null }
}

function Show-Status {
	$task = Get-ExistingTask
	if ($null -eq $task) {
		Write-Host '  未安装：开机不会自动拉起手机桥（要装就跑一次本脚本，不带参数）。' -ForegroundColor Yellow
		return
	}
	$info = $null
	try { $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop } catch { }
	Write-Host "  已安装：$TaskName" -ForegroundColor Green
	Write-Host "    状态      : $($task.State)"
	Write-Host "    触发器    : 登录后 $DelaySeconds 秒（实际以任务定义为准）"
	Write-Host "    动作      : powershell -File `"$BootUp`""
	if ($null -ne $info) {
		Write-Host "    上次运行  : $($info.LastRunTime)（结果码 $($info.LastTaskResult)）"
		Write-Host "    下次运行  : $($info.NextRunTime)"
	}
	$log = Join-Path (Join-Path $env:USERPROFILE '.dsh') 'launcher\boot-up.log'
	if (Test-Path -LiteralPath $log) {
		Write-Host '    最近几行日志：' -ForegroundColor DarkGray
		Get-Content -LiteralPath $log -Tail 6 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
	}
}

if ($Status) {
	Write-Host ''
	Write-Host '手机桥 · 开机自启状态' -ForegroundColor Cyan
	Show-Status
	Write-Host ''
	exit 0
}

if ($Remove) {
	$task = Get-ExistingTask
	if ($null -eq $task) {
		Write-Host '  本来就没装，不用撤。' -ForegroundColor Yellow
		exit 0
	}
	Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
	Write-Host '  已撤掉开机自启 —— 重启后手机桥不会再自动拉起（桌面图标启动照旧可用）。' -ForegroundColor Green
	exit 0
}

# ── 安装 ───────────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $BootUpSource)) {
	Write-Host "找不到 $BootUpSource —— 本脚本必须和 boot-up.ps1 放在同一个 tools\ 目录里。" -ForegroundColor Red
	exit 1
}
if (-not (Test-Path -LiteralPath $PowerShell)) {
	Write-Host "找不到系统 PowerShell：$PowerShell" -ForegroundColor Red
	exit 1
}

# 装一份到稳定目录（任务指向它）。逐字节复制：**必须原样保留 UTF-8 BOM** ——
# PowerShell 5.1 按 ANSI 读 .ps1，无 BOM 的中文会把字符串截断（今天真踩过 ✗，见 test\package.mjs 那条断言）。
if (-not (Test-Path -LiteralPath $LauncherDir)) { New-Item -ItemType Directory -Path $LauncherDir -Force | Out-Null }
try {
	[System.IO.File]::WriteAllBytes($BootUp, [System.IO.File]::ReadAllBytes($BootUpSource))
} catch {
	Write-Host "  复制 boot-up.ps1 到 $LauncherDir 失败：$($_.Exception.Message)" -ForegroundColor Red
	exit 1
}
Write-Host "  已装一份到稳定位置：$BootUp" -ForegroundColor Green

$action = New-ScheduledTaskAction -Execute $PowerShell `
	-Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $BootUp)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# 延迟是"登录后等网络起来"，别省 —— 开机那几秒跑必然失败。
try { $trigger.Delay = ('PT{0}S' -f [int]$DelaySeconds) } catch { Write-Host "  （这次没能设上延迟：$($_.Exception.Message)）" -ForegroundColor Yellow }
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
	-StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) `
	-ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

try {
	Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
} catch {
	Write-Host ''
	Write-Host "  装不上：$($_.Exception.Message)" -ForegroundColor Red
	Write-Host '  常见原因：这台机器有组策略限制计划任务；或者用户名/域写错了。' -ForegroundColor Yellow
	Write-Host '  兜底办法：把 tools\boot-up.ps1 的快捷方式丢进启动文件夹（Win+R 输入 shell:startup）。' -ForegroundColor Yellow
	exit 1
}

Write-Host ''
Write-Host '  已装好开机自启 ✓' -ForegroundColor Green
Write-Host "    任务名 : $TaskName"
Write-Host "    触发   : 登录后 $DelaySeconds 秒自动跑一次 boot-up.ps1"
Write-Host "    脚本   : $BootUp"
Write-Host "    日志   : $(Join-Path $LauncherDir 'boot-up.log')"
Write-Host ''
Write-Host '  想先看看它到底会做什么（不会启动任何东西）：' -ForegroundColor DarkGray
Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File `"$BootUp`" -DryRun" -ForegroundColor DarkGray
Write-Host '  撤销：' -ForegroundColor DarkGray
Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Remove" -ForegroundColor DarkGray
Write-Host ''
exit 0
