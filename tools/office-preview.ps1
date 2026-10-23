# 手机桥的 Office 预览转换（Windows + Microsoft Office COM）。
#
# 用法（由 lib/index.js 调用，不要手动跑着玩）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/office-preview.ps1 `
#     -Mode slides|sheet -Path <文件> -OutDir <缓存目录> [-MaxSlides 40] [-MaxRows 300] [-MaxCols 30]
#
# 产物：
#   slides → <OutDir>/slide-1.jpg … + result.json { ok:true, kind:'slides', count, exported, width, height }
#   sheet  → result.json { ok:true, kind:'sheet', sheets:[{ name, rows, totalRows, totalCols, truncated }] }
# 失败也写 result.json { ok:false, error }，退出码 1（Node 那边按文件内容判断，不只看退出码）。
#
# 为什么用 COM：这台机器没有 LibreOffice，但有 Office（PowerPoint/Excel）。
# PowerPoint 的 Slides.Export 能逐页导出 PNG（手机端直接显示图片，最稳）；
# Excel 的 UsedRange.Value2 能一次拿到整张表（我们限制行列，避免把手机撑爆）。

param(
  [Parameter(Mandatory = $true)][ValidateSet('slides', 'sheet')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$MaxSlides = 40,
  [int]$MaxRows = 300,
  [int]$MaxCols = 30,
  [int]$Width = 1280
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result([hashtable]$payload) {
  $json = $payload | ConvertTo-Json -Depth 12 -Compress
  $file = Join-Path $OutDir 'result.json'
  [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Release-ComObject($obj) {
  if ($null -eq $obj) { return }
  try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($obj) | Out-Null } catch { }
}

try {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  if (Test-Path -LiteralPath $Path) { } else { throw "文件不存在：$Path" }
  $full = (Resolve-Path -LiteralPath $Path).ProviderPath
  $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()

  if ($Mode -eq 'slides') {
    if ($ext -ne '.ppt' -and $ext -ne '.pptx' -and $ext -ne '.pptm') { throw "不是 PPT：$ext" }
    $app = New-Object -ComObject PowerPoint.Application
    $pres = $null
    try {
      try { $app.WindowState = 2 } catch { }  # ppWindowMinimized：尽量别在桌面上弹窗
      # Open(FileName, ReadOnly, Untitled, WithWindow)
      $pres = $app.Presentations.Open($full, -1, 0, 0)
      $total = [int]$pres.Slides.Count
      $exported = 0
      $w = [int]$Width
      $ratio = 9.0 / 16.0
      try {
        $pw = [double]$pres.PageSetup.SlideWidth
        $ph = [double]$pres.PageSetup.SlideHeight
        if ($pw -gt 0 -and $ph -gt 0) { $ratio = $ph / $pw }
      } catch { }
      $h = [int][Math]::Round($w * $ratio)
      if ($h -lt 1) { $h = 720 }
      $limit = [Math]::Min($total, $MaxSlides)
      for ($i = 1; $i -le $limit; $i++) {
        $slide = $pres.Slides.Item($i)
        try {
          $file = Join-Path $OutDir ("slide-$i.jpg")
          $slide.Export($file, 'JPG', $w, $h)
          $exported++
        } finally {
          Release-ComObject $slide
        }
      }
      Write-Result @{ ok = $true; kind = 'slides'; count = $total; exported = $exported; width = $w; height = $h; truncated = ($total -gt $limit) }
    } finally {
      if ($null -ne $pres) { try { $pres.Close() } catch { } }
      try { $app.Quit() } catch { }
      Release-ComObject $pres
      Release-ComObject $app
    }
    exit 0
  }

  if ($Mode -eq 'sheet') {
    if ($ext -ne '.xls' -and $ext -ne '.xlsx' -and $ext -ne '.xlsm' -and $ext -ne '.xlsb') { throw "不是 Excel：$ext" }
    $app = New-Object -ComObject Excel.Application
    $wb = $null
    try {
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $wb = $app.Workbooks.Open($full, 0, $true)  # UpdateLinks=0, ReadOnly=true
      $sheetsOut = @()
      $total = [int]$wb.Sheets.Count
      $limitSheets = [Math]::Min($total, 3)
      for ($s = 1; $s -le $limitSheets; $s++) {
        $ws = $wb.Sheets.Item($s)
        try {
          $used = $ws.UsedRange
          $addr = [string]$used.Address($false, $false)
          $rowsTotal = 0
          $colsTotal = 0
          try { $rowsTotal = [int]$used.Rows.Count } catch { }
          try { $colsTotal = [int]$used.Columns.Count } catch { }
          $vals = $used.Value2
          $rows = @()
          if ($null -eq $vals) {
            # 空表
          } elseif ($vals -is [System.Array] -and $vals.Rank -eq 2) {
            $rMax = [Math]::Min($rowsTotal, $MaxRows)
            $cMax = [Math]::Min($colsTotal, $MaxCols)
            for ($r = 1; $r -le $rMax; $r++) {
              $row = New-Object System.Collections.ArrayList
              for ($c = 1; $c -le $cMax; $c++) {
                $v = $vals[$r, $c]
                if ($null -eq $v) { [void]$row.Add(''); continue }
                if ($v -is [datetime]) { [void]$row.Add($v.ToString('yyyy-MM-dd HH:mm:ss')); continue }
                if ($v -is [double]) { [void]$row.Add($v.ToString('0.##########', [System.Globalization.CultureInfo]::InvariantCulture)); continue }
                [void]$row.Add([string]$v)
              }
              $rows += ,$row.ToArray()
            }
          } else {
            # 只有一个单元格：Value2 返回标量
            $v = $vals
            if ($null -eq $v) { $rows = @(, @('')) }
            elseif ($v -is [datetime]) { $rows = @(, @($v.ToString('yyyy-MM-dd HH:mm:ss'))) }
            elseif ($v -is [double]) { $rows = @(, @($v.ToString('0.##########', [System.Globalization.CultureInfo]::InvariantCulture))) }
            else { $rows = @(, @([string]$v)) }
            $rowsTotal = 1; $colsTotal = 1
          }
          $sheetsOut += @{
            name = [string]$ws.Name
            address = $addr
            rows = $rows
            totalRows = $rowsTotal
            totalCols = $colsTotal
            truncated = (($rowsTotal -gt $MaxRows) -or ($colsTotal -gt $MaxCols))
          }
        } finally {
          Release-ComObject $ws
        }
      }
      Write-Result @{ ok = $true; kind = 'sheet'; count = $total; sheets = $sheetsOut; maxRows = $MaxRows; maxCols = $MaxCols }
    } finally {
      if ($null -ne $wb) { try { $wb.Close($false) } catch { } }
      try { $app.Quit() } catch { }
      Release-ComObject $wb
      Release-ComObject $app
    }
    exit 0
  }

  throw "不认识的 Mode：$Mode"
} catch {
  $message = $_.Exception.Message
  try {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    Write-Result @{ ok = $false; error = $message }
  } catch { }
  [Console]::Error.WriteLine("office-preview failed: $message")
  exit 1
}
