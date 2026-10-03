# 下载 cloudflared.exe 到本脚本所在目录（外网隧道要用它）。
# 从 Cloudflare 官方 GitHub release 取，并校验 Authenticode 签名。
$ErrorActionPreference = 'Stop'
$dst = Join-Path $PSScriptRoot 'cloudflared.exe'
$url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
Write-Host "下载 $url"
Write-Host '（国内直连 GitHub 可能很慢，耐心等；中断了重跑会自动续传）'
& curl.exe -L --retry 5 --retry-delay 3 -C - -o $dst --connect-timeout 20 $url
if (-not (Test-Path $dst)) { Write-Host '下载失败' -ForegroundColor Red; exit 1 }
$sig = Get-AuthenticodeSignature $dst
Write-Host ("签名状态: " + $sig.Status)
if ($sig.SignerCertificate) { Write-Host ("签名者  : " + $sig.SignerCertificate.Subject) }
if ($sig.Status -ne 'Valid') { Write-Host '签名无效 —— 不要使用这个文件' -ForegroundColor Red; exit 1 }
Write-Host ("已就绪: " + $dst) -ForegroundColor Green