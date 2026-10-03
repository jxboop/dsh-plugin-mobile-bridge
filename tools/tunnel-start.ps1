# 启动 Cloudflare 快速隧道，把手机桥（本机 3081）暴露到公网。
# 手机在任何网络（蜂窝 / 别的 WiFi）都能打开打印出来的网址。
#
# 用法：右键本文件 -> 使用 PowerShell 运行
#      或：powershell -NoProfile -ExecutionPolicy Bypass -File %REPO%\tools\tunnel-start.ps1
#
# 注意：免费快速隧道的网址【每次重启都会变】，脚本会：
#   1. 把新网址写进 tools\tunnel-url.txt
#   2. 复制到剪贴板
#   3. 打印出来
# 想要固定网址，需要 Cloudflare 账号 + 自己的域名，做「命名隧道」。
#
# 安全：这是一条【公开网址】，任何人都能访问到登录页 —— 但手机桥有 PIN 认证
#       （PIN 在 %USERPROFILE%\.dsh\mobile-bridge.json）和登录限速。不要把网址乱发。

$Cloudflared = Join-Path $PSScriptRoot 'cloudflared.exe'
$ErrLog      = Join-Path $PSScriptRoot 'tunnel.err.log'
$OutLog      = Join-Path $PSScriptRoot 'tunnel.out.log'
$UrlFile     = Join-Path $PSScriptRoot 'tunnel-url.txt'
$Target      = 'http://localhost:3081'
# ── 把网址写进手机桥配置，DSH 界面左下角的徽标就能直接显示 ─────────────
$DshDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ConfigFile = Join-Path $DshDir 'mobile-bridge.json'

# 桥现在把所有路由藏在配置里的随机段后面，所以给用户看的网址必须带上它。
function Get-FullUrl([string]$base) {
	try {
		$cfg = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
		$secret = [string]$cfg.pathSecret
		if ($secret -match '^[0-9a-f]{16}$') { return ($base.TrimEnd('/') + '/' + $secret + '/') }
	} catch { }
	return $base
}

function Set-PublicUrl([string]$url) {
	if (-not (Test-Path $ConfigFile)) {
		Write-Host "  没找到 $ConfigFile，跳过徽标写入" -ForegroundColor Yellow
		return
	}
	try {
		$cfg = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
		if ($null -eq $cfg) { throw '配置内容为空' }
		$cfg | Add-Member -NotePropertyName publicUrl -NotePropertyValue $url -Force
		# 必须写【无 BOM】UTF-8：Node 的 JSON.parse 遇到 BOM 会抛异常，
		# 插件会当成配置损坏而重新生成 PIN。
		$json = $cfg | ConvertTo-Json -Depth 4
		$tmp = "$ConfigFile.tmp"
		[System.IO.File]::WriteAllText($tmp, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
		Move-Item -LiteralPath $tmp -Destination $ConfigFile -Force
		Write-Host '  已写入手机桥配置：DSH 界面左下角徽标会显示这个网址' -ForegroundColor Green
	} catch {
		Write-Host "  写入配置失败（只影响徽标，不影响隧道）: $($_.Exception.Message)" -ForegroundColor Yellow
	}
}

function Get-TunnelUrl {
	# 1) cloudflared 自己的日志最权威：那是【本次运行】真正拿到的网址。
	foreach ($f in @($ErrLog, $OutLog)) {
		if (Test-Path $f) {
			$raw = Get-Content $f -Raw -ErrorAction SilentlyContinue
			$m = [regex]::Match([string]$raw, 'https://[a-z0-9-]+\.trycloudflare\.com')
			if ($m.Success) { return $m.Value }
		}
	}
	# 2) 日志读不到时退回上次记录。没有这条回退，就会出现"隧道明明在跑、
	#    脚本却说拿不到网址"—— 用户只能干瞪眼。
	if (Test-Path $UrlFile) {
		$raw = [string](Get-Content $UrlFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
		$raw = $raw -replace "^\uFEFF", ''
		$m = [regex]::Match($raw, 'https://[a-z0-9-]+\.trycloudflare\.com')
		if ($m.Success) { return $m.Value }
	}
	# 3) 最后看手机桥配置里的 publicUrl（DSH 徽标显示的就是它）。
	try {
		$cfg = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
		if ($cfg -and $cfg.publicUrl) {
			$m = [regex]::Match([string]$cfg.publicUrl, 'https://[a-z0-9-]+\.trycloudflare\.com')
			if ($m.Success) { return $m.Value }
		}
	} catch { }
	return $null
}

function Show-Url([string]$url) {
	Write-Host ''
	Write-Host '  ================================================================' -ForegroundColor Cyan
	Write-Host '   手机访问这个网址：' -ForegroundColor Cyan
	Write-Host ''
	Write-Host "   $url" -ForegroundColor Yellow
	Write-Host ''
	Write-Host '  (已复制到剪贴板，也存进了 tools\tunnel-url.txt)' -ForegroundColor Cyan
	Write-Host '  ================================================================' -ForegroundColor Cyan
	Write-Host ''
}

function Wait-TunnelReady([string]$full) {
	# 拿到网址 ≠ 能用。Cloudflare 边缘注册需要几秒，cloudflared 也可能随后掉线，
	# 所以必须【真的从外网打开一次】再告诉用户"好了"。
	# 不验证的后果：手机上是 1033 / 1016 错误页，而用户以为自己操作错了。
	Write-Host ' 正在确认外网真的能打开' -NoNewline
	for ($i = 0; $i -lt 25; $i++) {
		Start-Sleep -Seconds 1
		Write-Host '.' -NoNewline
		try {
			$r = Invoke-WebRequest -Uri $full -TimeoutSec 8 -UseBasicParsing
			if ($r.StatusCode -eq 200) { Write-Host ''; return $true }
		} catch { }
		if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) { break }
	}
	Write-Host ''
	return $false
}

function Show-NotReady([string]$full) {
	Write-Host ''
	Write-Host ' 隧道没能通过外网验证 —— 现在把网址给手机，它多半会显示 1033 / 1016。' -ForegroundColor Red
	Write-Host ' 常见原因：' -ForegroundColor Yellow
	Write-Host '   · 电脑睡眠 / 休眠 / 合盖 —— 隧道会断'
	Write-Host '   · 安全软件、VPN 或网络加速器掐掉了 cloudflared 的连接'
	Write-Host '   · 网络本身不稳定'
	Write-Host '   · 网址是【上一轮】的（隧道重启过，免费隧道的网址每次都会变）'
	Write-Host ''
	Write-Host ' cloudflared 最后几行输出：' -ForegroundColor Yellow
	Get-Content $ErrLog -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "   $_" }
	Write-Host ''
	Write-Host ' 网址（可能过一会儿自己就通了）：' -ForegroundColor Gray
	Write-Host "   $full" -ForegroundColor Gray
	Write-Host ''
	Write-Host ' 下一步：先跑 tools\tunnel-stop.ps1，再跑一次本脚本拿全新网址。' -ForegroundColor Yellow
	Write-Host ' 或者跑 tools\tunnel-status.ps1 看详细体检结果。' -ForegroundColor Yellow
	Write-Host ''
}

if (-not (Test-Path $Cloudflared)) {
	Write-Host "找不到 cloudflared.exe：$Cloudflared" -ForegroundColor Red
	Write-Host '先跑一次 tools\download-cloudflared.ps1，或手动下载放到 tools\ 目录。' -ForegroundColor Yellow
	exit 1
}

# 手机桥在不在
$listening = Get-NetTCPConnection -State Listen -LocalPort 3081 -ErrorAction SilentlyContinue
if (-not $listening) {
	Write-Host '警告：本机 3081 端口没有在监听 —— DSH 可能没启动，或用的是别的端口。' -ForegroundColor Yellow
	Write-Host '      隧道仍会建立，但手机打开会是 502。请先启动 DeepSeek Harness。' -ForegroundColor Yellow
}

$running = @(Get-Process cloudflared -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
	$u = Get-TunnelUrl
	Write-Host "隧道已在运行 (PID $($running[0].Id))" -ForegroundColor Green
	if ($u) {
		$full = Get-FullUrl $u
		Set-PublicUrl $u
		Set-Content -LiteralPath $UrlFile -Value $full -Encoding UTF8 -NoNewline
		Set-Clipboard -Value $full -ErrorAction SilentlyContinue
		if (Wait-TunnelReady $full) { Show-Url $full }
		else { Show-NotReady $full; exit 1 }
	}
	else { Write-Host '但没能从日志里解析出网址，稍等几秒重跑本脚本。' -ForegroundColor Yellow }
	exit 0
}

Remove-Item $ErrLog, $OutLog -ErrorAction SilentlyContinue
Start-Process -FilePath $Cloudflared -WindowStyle Hidden `
	-ArgumentList @('tunnel', '--url', $Target, '--no-autoupdate') `
	-RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog

Write-Host '正在建立隧道' -NoNewline
$url = $null
for ($i = 0; $i -lt 40; $i++) {
	Start-Sleep -Milliseconds 750
	Write-Host '.' -NoNewline
	$url = Get-TunnelUrl
	if ($url) { break }
	if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) { break }
}
Write-Host ''

if (-not $url) {
	Write-Host '没能拿到网址。cloudflared 的最后几行输出：' -ForegroundColor Red
	Get-Content $ErrLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
	exit 1
}

Set-Content -LiteralPath $UrlFile -Value (Get-FullUrl $url) -Encoding UTF8 -NoNewline
Set-PublicUrl $url
$full = Get-FullUrl $url
Set-Clipboard -Value $full -ErrorAction SilentlyContinue
if (Wait-TunnelReady $full) {
	Show-Url $full
	Write-Host ' （已确认外网可打开）' -ForegroundColor Green
} else {
	Show-NotReady $full
	exit 1
}
