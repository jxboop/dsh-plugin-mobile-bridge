# 把 HEIC（iPhone 拍的照片，扩展名可能还叫 .jpeg）转成 JPEG。
#
# 为什么需要它：浏览器（甚至 iOS Safari 的 canvas 路径）不一定能解 HEIC，而
# Windows 上装了 Microsoft.HEIFImageExtension 就能解 —— 这里借 WinRT 的解码器
# 转一道，转出来的 JPEG 任何浏览器都能显示、也能当手机界面背景。
#
#   powershell -File tools\heic-to-jpg.ps1 <输入文件> [输出文件] [最大边长]
#
# 只读输入、写输出，不碰别的东西。

param(
	[Parameter(Mandatory = $true)][string]$In,
	[string]$Out = '',
	[int]$MaxEdge = 1600
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $In)) { throw "找不到输入文件: $In" }
if ($Out -eq '') {
	$dir = Split-Path -Parent $In
	$base = [System.IO.Path]::GetFileNameWithoutExtension($In)
	$Out = Join-Path $dir "$base.jpg"
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
	$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

$asAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
	$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]

function AwaitAction($action) {
	$task = $asAction.Invoke($null, @($action))
	if (-not $task.Wait(30000)) { throw 'WinRT 调用超时' }
}

function Await($operation, $type) {
	$task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
	if (-not $task.Wait(30000)) { throw 'WinRT 调用超时' }
	return $task.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($In)) ([Windows.Storage.StorageFile])
$read = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($read)) ([Windows.Graphics.Imaging.BitmapDecoder])

$width = $decoder.PixelWidth
$height = $decoder.PixelHeight
$scale = 1.0
if ([Math]::Max($width, $height) -gt $MaxEdge) {
	$scale = $MaxEdge / [double][Math]::Max($width, $height)
}

$transform = New-Object Windows.Graphics.Imaging.BitmapTransform
$transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Round($width * $scale))
$transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Round($height * $scale))
$transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant

if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
$outFolder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync((Split-Path -Parent $Out))) ([Windows.Storage.StorageFolder])
$outName = Split-Path -Leaf $Out
$outFile = Await ($outFolder.CreateFileAsync($outName, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
$write = Await ($outFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])

$encoder = Await ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync([Windows.Graphics.Imaging.BitmapEncoder]::JpegEncoderId, $write)) ([Windows.Graphics.Imaging.BitmapEncoder])
$pixels = Await ($decoder.GetPixelDataAsync(
	[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
	[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
	$transform,
	[Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
	[Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRGB)) ([Windows.Graphics.Imaging.PixelDataProvider])
$encoder.SetPixelData(
	[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
	[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
	$transform.ScaledWidth, $transform.ScaledHeight,
	96, 96, $pixels.DetachPixelData())
try {
	$quality = [Windows.Foundation.PropertyValue]::CreateUInt8(90)
	$encoder.SetEncoderParameter([Windows.Graphics.Imaging.BitmapEncoder]::ImageQualityOption, $quality)
} catch { }
AwaitAction ($encoder.FlushAsync())

$read.Dispose()
$write.Dispose()

$size = (Get-Item -LiteralPath $Out).Length
Write-Output ("已转换: {0} ({1}x{2}) -> {3}  {4} KB" -f (Split-Path -Leaf $In), $width, $height, $Out, [Math]::Round($size / 1KB))
