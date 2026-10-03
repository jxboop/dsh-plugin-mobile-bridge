# 手机桥 · 外网隧道体检
#
# 用法：右键本文件 -> 使用 PowerShell 运行
#      或：powershell -NoProfile -ExecutionPolicy Bypass -File tools\tunnel-status.ps1
#
# 什么时候需要它：手机浏览器出现 Cloudflare 的错误页时。
#
#   Error 1033  Cloudflare Tunnel error
#               = 这个主机名【曾经】是一条隧道，但现在没有任何隧道连着它
#   Error 1016  Origin DNS error
#               = 这个主机名已经完全解析不到（隧道早就没了）
#
# 两者含义相同：cloudflared 没在跑，或者手机上那个网址是【上一轮】的。
#
# 免费快速隧道（quick tunnel）的网址【每次 cloudflared 重启都会变】，
# 旧网址永久失效、救不回来。唯一的办法是重跑 tunnel-start.ps1 拿新网址。
# 想要固定网址，得用 Cloudflare 账号 + 自己的域名做「命名隧道」。
#
# 常见掉线原因：
#   · 电脑睡眠 / 休眠 / 合盖  —— 隧道会断
#   · 关掉了跑 cloudflared 的那个窗口（若用别的方式启动）
#   · 安全软件 / VPN / 加速器 掐掉 cloudflared 的连接
#   · 换网络（Wi-Fi 切到别的、网线拔了）

$ErrLog      = Join-Path $PSScriptRoot 'tunnel.err.log'
$OutLog      = Join-Path $PSScriptRoot 'tunnel.out.log'
$UrlFile     = Join-Path $PSScriptRoot 'tunnel-url.txt'
$DshDir      = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ConfigFile  = Join-Path $DshDir 'mobile-bridge.json'

function Read-JsonFile([string]$path) {
	try { return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Clear-Bom([string]$text) {
	if ($null -eq $text) { return '' }
	return ($text -replace "^\uFEFF", '').Trim()
}

$cfg    = Read-JsonFile $ConfigFile
$secret = ''
$port   = 3081
if ($cfg) {
	if ($cfg.pathSecret) { $secret = [string]$cfg.pathSecret }
	if ($cfg.port) { $port = [int]$cfg.port }
}

Write-Host ''
Write-Host '  ============ 手机桥 · 外网隧道体检 ============' -ForegroundColor Cyan
Write-Host ''

$allOk = $true

# ---- 1) cloudflared 进程 ----
$cf = @(Get-Process cloudflared -ErrorAction SilentlyContinue)
if ($cf.Count -gt 0) {
	Write-Host ('  [OK]  cloudflared 在运行  (PID ' + $cf[0].Id + '，启动于 ' + $cf[0].StartTime + ')') -ForegroundColor Green
} else {
	$allOk = $false
	Write-Host '  [X]   cloudflared 没在运行' -ForegroundColor Red
	Write-Host '        -> 现在任何 trycloudflare 网址都会是 1033 / 1016' -ForegroundColor Yellow
	Write-Host '        -> 重跑 tools\tunnel-start.ps1 拿一个新网址' -ForegroundColor Yellow
}

# ---- 2) 本机手机桥 ----
$listen = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($listen) {
	Write-Host ('  [OK]  手机桥在监听 ' + $port) -ForegroundColor Green
} else {
	$allOk = $false
	Write-Host ('  [X]   本机 ' + $port + ' 端口没有监听 —— DSH 没启动，或改过端口') -ForegroundColor Red
}

# ---- 3) 记录中的外网网址 ----
$url = ''
if (Test-Path $UrlFile) { $url = Clear-Bom (Get-Content $UrlFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) }
if ($url -eq '' -and $cfg -and $cfg.publicUrl) { $url = [string]$cfg.publicUrl }

if ($url -ne '') {
	Write-Host ('  [--]  记录中的网址: ' + $url) -ForegroundColor Gray
	if ($secret -ne '' -and $url -notmatch [regex]::Escape($secret)) {
		$url = $url.TrimEnd('/') + '/' + $secret + '/'
		Write-Host ('  [--]  补上密钥段: ' + $url) -ForegroundColor Gray
	}
} else {
	$allOk = $false
	Write-Host '  [--]  没有任何外网网址记录（还没跑过 tunnel-start.ps1）' -ForegroundColor Yellow
}

# ---- 4) 从外网实测 ----
if ($url -ne '') {
	Write-Host '  [..]  正在从外网访问它……' -ForegroundColor Gray
	$code = 0
	try {
		$r = Invoke-WebRequest -Uri $url -TimeoutSec 25 -UseBasicParsing
		$code = [int]$r.StatusCode
	} catch {
		if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
	}
	if ($code -eq 200) {
		Write-Host '  [OK]  外网能打开（HTTP 200）—— 隧道是活的，手机现在能用' -ForegroundColor Green
	} else {
		$allOk = $false
		Write-Host ('  [X]   外网打不开（' + $(if ($code -eq 0) { '连不上' } else { 'HTTP ' + $code }) + '）') -ForegroundColor Red
		if ($cf.Count -gt 0) {
			Write-Host '        cloudflared 明明在跑 —— 说明它重启过，网址已经换了。' -ForegroundColor Yellow
			Write-Host '        重跑 tools\tunnel-start.ps1，用【新打印出来的】网址。' -ForegroundColor Yellow
		}
	}
}

Write-Host ''
if ($allOk) {
	Write-Host '  结论：一切正常。' -ForegroundColor Green
} else {
	Write-Host '  结论：有问题，看上面标 [X] 的行。' -ForegroundColor Red
}
Write-Host '  ==============================================' -ForegroundColor Cyan
Write-Host ''
