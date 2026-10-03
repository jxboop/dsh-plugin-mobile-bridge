# DSH 应急窗口：一键踢掉所有手机登录。
# 调用的是手机桥只允许本机(loopback)访问的 /api/revoke，所以密钥泄漏了外人也用不了它。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$DshDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$cfgPath = Join-Path $DshDir 'mobile-bridge.json'
try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { [System.Windows.Forms.MessageBox]::Show('读不到 mobile-bridge.json') | Out-Null; exit 1 }
$base = "http://127.0.0.1:$($cfg.port)/$($cfg.pathSecret)"

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 应急：踢掉所有手机登录'
$form.ClientSize = New-Object System.Drawing.Size(460, 220)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = "这会让所有已登录的手机立即失效，`n下次打开必须重新输入 PIN。`n`n本机 DSH 与局域网访问不受影响。"
$lbl.Location = New-Object System.Drawing.Point(18, 16)
$lbl.Size = New-Object System.Drawing.Size(424, 80)
$form.Controls.Add($lbl)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = '确认踢掉所有手机登录'
$btn.Location = New-Object System.Drawing.Point(18, 104)
$btn.Size = New-Object System.Drawing.Size(210, 34)
$btn.ForeColor = [System.Drawing.Color]::FromArgb(160, 0, 0)
$form.Controls.Add($btn)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '关闭'
$btnClose.Location = New-Object System.Drawing.Point(348, 104)
$btnClose.Size = New-Object System.Drawing.Size(94, 34)
$form.Controls.Add($btnClose)

$lblResult = New-Object System.Windows.Forms.Label
$lblResult.Text = ''
$lblResult.Location = New-Object System.Drawing.Point(18, 150)
$lblResult.Size = New-Object System.Drawing.Size(424, 56)
$form.Controls.Add($lblResult)

$btnClose.Add_Click({ $form.Close() })
# 两步确认：这个按钮一点就把手机踢下线，误触代价太大。
$armed = $false
$btn.Add_Click({
  if (-not $armed) {
    $armed = $true
    $btn.Text = '再点一次确认'
    $lblResult.ForeColor = [System.Drawing.Color]::FromArgb(170, 0, 0)
    $lblResult.Text = '已解锁。请再点一次同一个按钮才会真正执行。'
    return
  }
  $armed = $false
  $btn.Enabled = $false
  $btn.Text = '确认踢掉所有手机登录'
  $lblResult.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
  $lblResult.Text = '正在执行...'
  $form.Refresh()
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$base/api/revoke" -TimeoutSec 20
    $lblResult.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 0)
    $lblResult.Text = "已吊销 $($r.revoked) 个手机登录。手机上需要重新输入 PIN。"
  } catch {
    $lblResult.ForeColor = [System.Drawing.Color]::FromArgb(170, 0, 0)
    $lblResult.Text = "失败：$($_.Exception.Message)"
    $btn.Enabled = $true
  }
})

[void]$form.ShowDialog()