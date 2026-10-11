# 开机自启：把"手机能连上"需要的东西按顺序拉起来，并把每一环的结果写成一句人话。
#
#   ① Tailscale 起了吗   → ② DSH 起了吗（open-dsh.ps1 -NoOpen）→ ③ 手机桥在听吗
#   → ④ Funnel 开着吗（并把它固定的 https 地址写进配置）→ ⑤ 从外网真的能打开吗
#
# 两条纪律：
#   * **幂等**：已经在跑的环节一律跳过 —— 开机自启绝不能打断一个正在跑的会话 ✗；
#   * **说人话**：哪一环没起来就写清是哪一环 + 怎么办（"连不上但不知道为什么"是最糟的 ✗）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-up.ps1 -DryRun   # 只检查，不启动
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-up.ps1           # 真拉起（开机用）
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-up.ps1 -Open     # 顺带打开桌面窗口
#
# 装成"开机自动跑"：tools\autostart.ps1（可 -Status / -Remove）
# 日志：%USERPROFILE%\.dsh\launcher\boot-up.log
#
# Windows PowerShell 5.1 兼容；不需要管理员。

param(
	[int]$DshPort = 3080,
	[int]$BridgePort = 0,          # 0 = 从 mobile-bridge.json 读
	[switch]$DryRun,
	[switch]$Open,
	[int]$TailscaleWaitSeconds = 90,
	[int]$DshWaitSeconds = 180,
	[int]$BridgeWaitSeconds = 60
)

$ErrorActionPreference = 'Continue'

$DshDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$LauncherDir = Join-Path $DshDir 'launcher'
$LogPath = Join-Path $LauncherDir 'boot-up.log'
$ConfigFile = Join-Path $DshDir 'mobile-bridge.json'
$OpenDsh = Join-Path $LauncherDir 'open-dsh.ps1'
$Tailscale = 'C:\Program Files\Tailscale\tailscale.exe'

$script:Problems = @()

function Write-Log {
	param([string]$Message, [string]$Level = 'info')
	$line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
	switch ($Level) {
		'ok'   { Write-Host "  [ok]   $Message" -ForegroundColor Green }
		'warn' { Write-Host "  [warn] $Message" -ForegroundColor Yellow }
		'fail' { Write-Host "  [fail] $Message" -ForegroundColor Red; $script:Problems += $Message }
		default { Write-Host "  $Message" }
	}
	try {
		if (-not (Test-Path -LiteralPath $LauncherDir)) { New-Item -ItemType Directory -Path $LauncherDir -Force | Out-Null }
		# 只留最近 256 KB：这是"看一眼就能定位"的日志，不该无限长。
		if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 262144) {
			Remove-Item -LiteralPath $LogPath -ErrorAction SilentlyContinue
		}
		Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
	} catch { }
}

function Test-PortOpen {
	param([int]$LocalPort)
	$client = New-Object System.Net.Sockets.TcpClient
	try {
		$async = $client.BeginConnect('127.0.0.1', $LocalPort, $null, $null)
		if ($async.AsyncWaitHandle.WaitOne(700)) { $client.EndConnect($async); return $true }
		return $false
	} catch { return $false } finally { $client.Close() }
}

function Wait-PortOpen {
	param([int]$LocalPort, [int]$Seconds)
	for ($i = 0; $i -lt $Seconds; $i++) {
		if (Test-PortOpen $LocalPort) { return $true }
		Start-Sleep -Seconds 1
	}
	return (Test-PortOpen $LocalPort)
}

function Get-BridgeConfig {
	# pathSecret 一定要拿到：给用户看的地址必须带那一段，少了就是 404。
	$fallback = [pscustomobject]@{ port = 3081; pathSecret = '' }
	if (-not (Test-Path -LiteralPath $ConfigFile)) { return $fallback }
	try {
		$cfg = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
		$port = if ($cfg.port -as [int]) { [int]$cfg.port } else { 3081 }
		$secret = [string]$cfg.pathSecret
		return [pscustomobject]@{ port = $port; pathSecret = $secret }
	} catch { return $fallback }
}

function Set-PublicUrl {
	param([string]$Url)
	if (-not (Test-Path -LiteralPath $ConfigFile) -or [string]::IsNullOrWhiteSpace($Url)) { return $false }
	try {
		$cfg = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
		if ($null -eq $cfg) { return $false }
		if ([string]$cfg.publicUrl -eq $Url) { return $true }   # 没变就别写盘
		$cfg | Add-Member -NotePropertyName publicUrl -NotePropertyValue $Url -Force
		# 必须写【无 BOM】UTF-8：Node 的 JSON.parse 遇到 BOM 会抛异常，插件会当成配置损坏。
		$json = $cfg | ConvertTo-Json -Depth 4
		$tmp = "$ConfigFile.tmp"
		[System.IO.File]::WriteAllText($tmp, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
		Move-Item -LiteralPath $tmp -Destination $ConfigFile -Force
		return $true
	} catch {
		Write-Log "写 publicUrl 失败（只影响徽标/二维码，不影响隧道）：$($_.Exception.Message)" 'warn'
		return $false
	}
}

function Get-TailscaleJson {
	if (-not (Test-Path -LiteralPath $Tailscale)) { return $null }
	try {
		$raw = & $Tailscale status --json 2>$null | Out-String
		if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
		return ($raw | ConvertFrom-Json)
	} catch { return $null }
}

Write-Host ''
Write-Host '手机桥 · 开机自启自检' -ForegroundColor Cyan
Write-Host ('  {0}{1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $(if ($DryRun) { '（DryRun：只看不起）' } else { '' })) -ForegroundColor DarkGray
Write-Host ''

$bridge = Get-BridgeConfig
if ($BridgePort -le 0) { $BridgePort = [int]$bridge.port }

# ── ① Tailscale ────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $Tailscale)) {
	Write-Log "找不到 Tailscale（$Tailscale）—— 没它就没有固定网址，手机只能用局域网地址。" 'fail'
} else {
	$ts = $null
	for ($i = 0; $i -lt $TailscaleWaitSeconds; $i++) {
		$ts = Get-TailscaleJson
		if ($ts -and [string]$ts.BackendState -eq 'Running') { break }
		Start-Sleep -Seconds 1
	}
	if ($ts -and [string]$ts.BackendState -eq 'Running') {
		Write-Log 'Tailscale 在跑' 'ok'
	} else {
		Write-Log "等了 $TailscaleWaitSeconds 秒 Tailscale 还没起来（状态：$([string]$ts.BackendState)）—— 手机在外网连不上多半就是这一环；打开 Tailscale 图标手动登录一次。" 'fail'
	}
}

# ── ② DSH ──────────────────────────────────────────────────────────────────
if (Test-PortOpen $DshPort) {
	Write-Log "DSH 已经在 $DshPort 上跑着（不重复拉起）" 'ok'
} elseif ($DryRun) {
	Write-Log "DSH 没在 $DshPort 上跑（DryRun：本该调 open-dsh.ps1 拉起来）" 'warn'
} elseif (-not (Test-Path -LiteralPath $OpenDsh)) {
	Write-Log "找不到启动器 $OpenDsh —— 请用桌面「DeepSeek Harness」图标启动一次。" 'fail'
} else {
	Write-Log "DSH 没在跑，正在通过 open-dsh.ps1 拉起（不开窗口）…"
	# ⚠️ 变量名别用 $args —— 那是 PowerShell 的自动变量（脚本参数），覆盖它会踩坑。
	$openArgs = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $OpenDsh, '-NoOpen')
	if ($Open) { $openArgs = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $OpenDsh) }
	Start-Process -FilePath 'powershell.exe' -ArgumentList $openArgs -WindowStyle Hidden
	if (Wait-PortOpen $DshPort $DshWaitSeconds) {
		Write-Log "DSH 起来了（$DshPort 已应答）" 'ok'
	} else {
		Write-Log "等了 $DshWaitSeconds 秒 DSH 还没起来 —— 看 $LauncherDir\server.err.log 和 dsh-desktop.log。" 'fail'
	}
}

# ── ③ 手机桥（它随 DSH 一起起，这里只验端口）───────────────────────────────
if (Test-PortOpen $BridgePort) {
	Write-Log "手机桥在 $BridgePort 上听着" 'ok'
} else {
	if (Wait-PortOpen $BridgePort $BridgeWaitSeconds) {
		Write-Log "手机桥起来了（$BridgePort）" 'ok'
	} else {
		Write-Log "手机桥没在 $BridgePort 上听 —— 常见原因：端口被上一份 DSH 占着（看 $DshDir\mobile-bridge-start-error.log），或插件没进 profile 的装配列表。" 'fail'
	}
}

# ── ④ Funnel（并把固定地址写进配置）────────────────────────────────────────
$publicHost = ''
if ($ts = Get-TailscaleJson) {
	# Self.DNSName 形如 "crmer.tailc2a211.ts.net."（结尾有个点，必须去掉）。
	$dns = [string]$ts.Self.DNSName
	if (-not [string]::IsNullOrWhiteSpace($dns)) { $publicHost = 'https://' + $dns.TrimEnd('.') }
}
if ([string]::IsNullOrWhiteSpace($publicHost)) {
	Write-Log '拿不到 Tailscale 的机器名 —— 跳过 Funnel（局域网地址仍然可用）。' 'warn'
} else {
	$status = ''
	try { $status = (& $Tailscale funnel status 2>&1 | Out-String) } catch { $status = '' }
	$serving = ($status -match 'Funnel on') -and ($status -match "127\.0\.0\.1:$BridgePort")
	if ($serving) {
		Write-Log "Funnel 已经开着（$publicHost → 127.0.0.1:$BridgePort）" 'ok'
	} elseif ($DryRun) {
		Write-Log "Funnel 没开（DryRun：本该执行 tailscale funnel --bg $BridgePort）" 'warn'
	} else {
		Write-Log "Funnel 没开，正在执行 tailscale funnel --bg $BridgePort …"
		try {
			& $Tailscale funnel --bg $BridgePort 2>&1 | ForEach-Object { if (-not [string]::IsNullOrWhiteSpace([string]$_)) { Write-Log ('   ' + ([string]$_).Trim()) } }
		} catch { Write-Log "开 Funnel 失败：$($_.Exception.Message)" 'warn' }
		Start-Sleep -Seconds 3
		try { $status = (& $Tailscale funnel status 2>&1 | Out-String) } catch { $status = '' }
		if (($status -match 'Funnel on') -and ($status -match "127\.0\.0\.1:$BridgePort")) {
			Write-Log 'Funnel 开起来了' 'ok'
		} else {
			Write-Log 'Funnel 没开起来 —— 可能要先去控制台同意一次（tailscale funnel 会打印同意链接）。' 'fail'
		}
	}
	# ⚠️ 写**裸地址**（不带密钥段）：桥的 `withSecret()` 会自己把 `/<pathSecret>/` 拼上去。
	# 写完整地址会让徽标 / 隧道自检 / 手机拿到的地址都变成 `…/<secret>/<secret>/` ✗
	# （2.7.0 开发时真踩过 —— 见 lib/index.js 里 withSecret 的注释 ✓）。
	if (-not $DryRun) {
		if (Set-PublicUrl $publicHost) { Write-Log "已把当前外网地址写进配置：$publicHost （裸地址，密钥段由桥自己拼）" 'ok' }
	}
}

# ── ⑤ 外网真的能打开吗 ────────────────────────────────────────────────────
$secret = [string](Get-BridgeConfig).pathSecret
$probeUrl = if ($secret -match '^[0-9a-f]{16}$') { "$publicHost/$secret/" } else { "$publicHost/" }
if ([string]::IsNullOrWhiteSpace($publicHost)) {
	Write-Log '跳过外网实测（没有固定外网地址）' 'warn'
} else {
	$ok = $false
	for ($i = 0; $i -lt 5; $i++) {
		try {
			$r = Invoke-WebRequest -Uri $probeUrl -TimeoutSec 10 -UseBasicParsing
			if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { $ok = $true; break }
		} catch { }
		if ($DryRun) { break }
		Start-Sleep -Seconds 3
	}
	if ($ok) { Write-Log "外网实测通过：$probeUrl" 'ok' }
	else { Write-Log "外网实测没通：$probeUrl —— 电脑刚开机时 Funnel 注册要几十秒，过一会儿手机上重试一次通常就好；一直不通就跑 tools\tunnel-status.ps1。" 'warn' }
}

# ── 小结 ──────────────────────────────────────────────────────────────────
Write-Host ''
if ($script:Problems.Count -eq 0) {
	Write-Host '  结论：这一环都没问题，手机可以直接用。' -ForegroundColor Green
	Write-Log 'boot-up 完成：全部环节正常' 'ok'
	exit 0
} else {
	Write-Host "  结论：有 $($script:Problems.Count) 环没起来 ——" -ForegroundColor Yellow
	foreach ($p in $script:Problems) { Write-Host "    · $p" -ForegroundColor Yellow }
	Write-Log "boot-up 结束：$($script:Problems.Count) 环失败" 'fail'
	exit 1
}
