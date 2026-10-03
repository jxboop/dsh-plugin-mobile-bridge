# 一个可复制的小窗口，显示手机访问用的外网网址与 PIN。
# 网址来源是 mobile-bridge.json（与 DSH 徽标同一份数据），所以永远是最新的。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$DshDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$cfgPath = Join-Path $DshDir 'mobile-bridge.json'

function Get-Info {
  try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  $secret = [string]$cfg.pathSecret
  $suffix = if ($secret -match '^[0-9a-f]{16}$') { "/$secret/" } else { '/' }
  $pub = [string]$cfg.publicUrl
  $wan = if ($pub -ne '') { $pub.TrimEnd('/') + $suffix } else { '(尚未建立隧道)' }
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress)
  $lan = ($ips | ForEach-Object { "http://$_" + ":" + $cfg.port + $suffix }) -join "  |  "
  return [pscustomobject]@{ Wan = $wan; Lan = $lan; Pin = [string]$cfg.pin }
}

$info = Get-Info
if ($null -eq $info) { [System.Windows.Forms.MessageBox]::Show('读不到 mobile-bridge.json') | Out-Null; exit 1 }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 手机访问网址'
$form.ClientSize = New-Object System.Drawing.Size(600, 264)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

function Add-Label($text, $x, $y, $w, $h) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y)
  $l.Size = New-Object System.Drawing.Size($w, $h)
  $form.Controls.Add($l); return $l
}

Add-Label '外网网址（蜂窝 / 别的 WiFi 都能打开）' 16 12 560 20 | Out-Null
$tbWan = New-Object System.Windows.Forms.TextBox
$tbWan.Location = New-Object System.Drawing.Point(16, 34)
$tbWan.Size = New-Object System.Drawing.Size(568, 26)
$tbWan.ReadOnly = $true
$tbWan.Font = New-Object System.Drawing.Font('Consolas', 10)
$tbWan.Text = $info.Wan
$tbWan.Add_Click({ $tbWan.SelectAll() })
$tbWan.Add_Enter({ $tbWan.SelectAll() })
$form.Controls.Add($tbWan)

$btnCopyWan = New-Object System.Windows.Forms.Button
$btnCopyWan.Text = '复制外网网址'
$btnCopyWan.Location = New-Object System.Drawing.Point(16, 68)
$btnCopyWan.Size = New-Object System.Drawing.Size(150, 30)
$form.Controls.Add($btnCopyWan)

$lblPin = Add-Label ("PIN  " + $info.Pin) 190 74 320 22
$lblPin.Font = New-Object System.Drawing.Font('Consolas', 12, [System.Drawing.FontStyle]::Bold)

$btnCopyPin = New-Object System.Windows.Forms.Button
$btnCopyPin.Text = '复制 PIN'
$btnCopyPin.Location = New-Object System.Drawing.Point(470, 68)
$btnCopyPin.Size = New-Object System.Drawing.Size(114, 30)
$form.Controls.Add($btnCopyPin)

Add-Label '局域网网址（同一热点/网线时更快）' 16 112 560 20 | Out-Null
$tbLan = New-Object System.Windows.Forms.TextBox
$tbLan.Location = New-Object System.Drawing.Point(16, 134)
$tbLan.Size = New-Object System.Drawing.Size(568, 26)
$tbLan.ReadOnly = $true
$tbLan.Font = New-Object System.Drawing.Font('Consolas', 9)
$tbLan.Text = $info.Lan
$tbLan.Add_Click({ $tbLan.SelectAll() })
$form.Controls.Add($tbLan)

$btnCopyLan = New-Object System.Windows.Forms.Button
$btnCopyLan.Text = '复制局域网网址'
$btnCopyLan.Location = New-Object System.Drawing.Point(16, 168)
$btnCopyLan.Size = New-Object System.Drawing.Size(150, 30)
$form.Controls.Add($btnCopyLan)

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = '刷新（隧道重启后网址会变）'
$btnRefresh.Location = New-Object System.Drawing.Point(180, 168)
$btnRefresh.Size = New-Object System.Drawing.Size(230, 30)
$form.Controls.Add($btnRefresh)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '关闭'
$btnClose.Location = New-Object System.Drawing.Point(470, 168)
$btnClose.Size = New-Object System.Drawing.Size(114, 30)
$form.Controls.Add($btnClose)

$lblStatus = Add-Label '' 16 208 560 20
$lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(0, 120, 0)

$setClip = {
  param($text, $what)
  if ($text -eq '' -or $text -like '(*') { $lblStatus.Text = '没有可复制的内容'; return }
  try { [System.Windows.Forms.Clipboard]::SetText($text); $lblStatus.Text = "已复制$what" }
  catch { $lblStatus.Text = "复制失败：$($_.Exception.Message)" }
}

$btnCopyWan.Add_Click({ & $setClip $tbWan.Text '外网网址' })
$btnCopyPin.Add_Click({ & $setClip $info.Pin 'PIN' })
$btnCopyLan.Add_Click({ & $setClip ($tbLan.Text -split '  \|  ')[0] '局域网网址' })
$btnClose.Add_Click({ $form.Close() })
$btnRefresh.Add_Click({
  $new = Get-Info
  if ($null -ne $new) {
    $tbWan.Text = $new.Wan; $tbLan.Text = $new.Lan; $lblPin.Text = 'PIN  ' + $new.Pin
    $lblStatus.Text = '已刷新'
  }
})

# --- 隐藏热区：右下角 14x14，颜色与窗体一致所以看不见 ---
# 点它才会让下面那个"应急"按钮显形，避免平时误触。
$btnEmergency = New-Object System.Windows.Forms.Button
$btnEmergency.Text = '应急：踢掉所有手机登录'
$btnEmergency.Location = New-Object System.Drawing.Point(16, 228)
$btnEmergency.Size = New-Object System.Drawing.Size(196, 26)
$btnEmergency.Visible = $false
$btnEmergency.ForeColor = [System.Drawing.Color]::FromArgb(160, 0, 0)
$form.Controls.Add($btnEmergency)

$hotspot = New-Object System.Windows.Forms.Label
$hotspot.Text = ''
$hotspot.Location = New-Object System.Drawing.Point(584, 250)
$hotspot.Size = New-Object System.Drawing.Size(16, 14)
$hotspot.BackColor = $form.BackColor
$hotspot.Cursor = 'Default'
$form.Controls.Add($hotspot)
$hotspot.Add_Click({
  $btnEmergency.Visible = -not $btnEmergency.Visible
  $lblStatus.Text = if ($btnEmergency.Visible) { '已显示应急按钮' } else { '' }
})
$btnEmergency.Add_Click({
  $rp = Join-Path $PSScriptRoot 'revoke-phone.ps1'
  if (Test-Path $rp) { Start-Process 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$rp) }
  else { $lblStatus.Text = "找不到 $rp" }
})
$form.Add_Shown({ $tbWan.Focus(); $tbWan.SelectAll() })
[void]$form.ShowDialog()