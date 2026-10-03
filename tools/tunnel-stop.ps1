# 关闭 Cloudflare 隧道（只是断掉公网入口，不影响本机 DSH 和局域网访问）。
#
# 用法：右键本文件 -> 使用 PowerShell 运行
#      或：powershell -NoProfile -ExecutionPolicy Bypass -File %REPO%\tools\tunnel-stop.ps1

$procs = @(Get-Process cloudflared -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
	Write-Host '隧道本来就没在运行。' -ForegroundColor Yellow
	exit 0
}

foreach ($p in $procs) {
	Write-Host "关闭 cloudflared PID $($p.Id) ..." -NoNewline
	try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Write-Host ' 已关闭' -ForegroundColor Green }
	catch { Write-Host " 失败: $($_.Exception.Message)" -ForegroundColor Red }
}

Remove-Item (Join-Path $PSScriptRoot 'tunnel-url.txt') -ErrorAction SilentlyContinue

# 顺手清掉徽标里的公网网址，免得界面还显示一个已经失效的链接
try {
	$DshDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
	$ConfigFile = Join-Path $DshDir 'mobile-bridge.json'
	if (Test-Path $ConfigFile) {
		$cfg = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
		$cfg | Add-Member -NotePropertyName publicUrl -NotePropertyValue '' -Force
		$json = $cfg | ConvertTo-Json -Depth 4
		[System.IO.File]::WriteAllText($ConfigFile, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
		Write-Host '已清除徽标里的公网网址。' -ForegroundColor Green
	}
} catch {
	Write-Host "清除徽标网址失败: $($_.Exception.Message)" -ForegroundColor Yellow
}
Write-Host ''
Write-Host '公网入口已断开。本机 DSH 与局域网/热点访问不受影响。' -ForegroundColor Cyan
