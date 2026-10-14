/**
 * 电脑控制（4.5.0 ★「手机上给电脑静音 / 调音量 / 调亮度 / 查联网 / 查电量 / 看蓝牙设备」）。
 *
 * 用户 2026-10-14 原话：「做一键给电脑静音，调低亮度，调低调高音量，调高亮度，联网检查，
 * 电量检查，蓝牙连接，蓝牙设备显示的功能的功能」✓ —— 七件事 ✓。
 *
 * 为什么单开一个模块：和 `lib/system.js` 同一个理由 ✓（平台相关、`index.js` 已经四千多行 ✓），
 * 插件依旧**零依赖** ✓（一个 `powershell.exe` 子进程 + `node:*` ✓）。
 *
 * ⚠️ 平台现实（这一版最重要的是**别摆按了没反应的键** ✗ —— 4.3.0 就因为这个撤过一个"解锁"键 ✓）：
 *   · **亮度**：WMI 只管**内置面板** ✓。这台 Lenovo 笔记本实测可读可写 ✓；
 *     台式机 / 只接外接屏的机器上 `WmiMonitorBrightnessMethods` 根本不存在 ✗ →
 *     如实回"这台机器没有可调的内置屏幕" ✓，**不是**假装调成功 ✗。
 *   · **音量 / 静音**：不走外接工具 ✓，也不靠"发媒体键给前台窗口" ✗（那种做法在前台不是音频程序时会失灵 ✓）。
 *     用 CoreAudio 的 `IAudioEndpointVolume` ✓（系统自带的 COM 接口 ✓，读值 + 设值都行 ✓）——
 *     **能读回真实数值** ✓，所以手机上显示的是"音量 42%"而不是"已调低"这种糊话 ✓。
 *   · **蓝牙连接**：⚠️ Windows **没有**可靠的命令行接口去"连接某台已配对设备" ✗ ——
 *     所以这里**不摆"连接"那个键** ✗（摆了就是骗人 ✓）。能做的三件是真做 ✓：
 *     列出已配对设备 ✓、蓝牙无线电开 / 关 ✓（WinRT `Windows.Devices.Radios` ✓）、
 *     打开系统蓝牙设置页 ✓（`ms-settings:bluetooth` ✓）。
 *     面板上会**明说**"连接要在设置里点一下" ✓ —— 这是做不到就如实说 ✓，不是含糊过去 ✗。
 *
 * 安全边界（照 `lib/system.js` 那四道闸的同一套纪律 ✓）：
 *   ① 配置里 `pcControl: true`（**默认关** ✓，且每次请求**现读配置文件** ✓ —— 关掉立刻生效 ✓）；
 *   ② 让电脑"动手"的动作（音量 / 亮度 / 蓝牙开关 / 打开设置页 ✓）走 `guardWrite()` ✓：
 *      要 PIN 提权（4.3.1 起默认一小时内有效 ✓）；
 *   ③ 只读的那些（电量 / 联网 / 蓝牙设备列表 ✓）走 `guard()` ✓，不额外要 PIN ✓ —— 它们不改任何东西 ✓。
 */

import { execFile } from 'node:child_process'

const PS_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/**
 * 一次 PowerShell 调用，拿回 JSON ✓。
 *
 * ⚠️ 两个必须写对的地方（不然中文/特殊字符回来就是乱码 ✗）：
 *   ① 脚本**必须是纯 ASCII** ✓ —— 它是作为**命令行参数**传进去的 ✓，
 *      Windows 的命令行是 UTF-16 → PowerShell 5.1 收参数时会按本地代码页解 ✗（实测踩过 ✓）；
 *   ② 脚本里第一句就把**输出编码设成 UTF-8** ✓ —— 不然蓝牙设备名里的中文（"杰的AirPods" ✓）
 *      会按 GBK 出来 ✗，Node 按 UTF-8 解 → 乱码 ✓。
 */
function runPowerShell(script, timeoutMs = 15000) {
	return new Promise((resolve) => {
		const full = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + script
		execFile('powershell.exe', [...PS_ARGS, full], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			const text = String(stdout ?? '').trim()
			if (text === '') { resolve(error === null ? null : { error: String(error.message ?? error) }); return }
			try { resolve(JSON.parse(text)) } catch { resolve(null) }
		})
	})
}

/** CoreAudio 的 C# 桥 ✓（Add-Type 内联 ✓，不装任何东西 ✓）：读 + 设 音量/静音 ✓。 */
const AUDIO_CSHARP = `
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h();
  int SetMasterVolumeLevel(float a, ref Guid b);
  int SetMasterVolumeLevelScalar(float a, ref Guid b);
  int GetMasterVolumeLevel(out float a);
  int GetMasterVolumeLevelScalar(out float a);
  int SetChannelVolumeLevel(int a, float b, ref Guid c);
  int SetChannelVolumeLevelScalar(int a, float b, ref Guid c);
  int GetChannelVolumeLevel(int a, out float b);
  int GetChannelVolumeLevelScalar(int a, out float b);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool a, ref Guid b);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool a);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class DshAudio {
  static IAudioEndpointVolume Vol() {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    return (IAudioEndpointVolume)o;
  }
  public static int GetVolume() { float s; Vol().GetMasterVolumeLevelScalar(out s); return (int)Math.Round(s * 100); }
  public static bool GetMute() { bool m; Vol().GetMute(out m); return m; }
  public static void SetVolume(int percent) { Guid g = Guid.Empty; Vol().SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, percent / 100f)), ref g); }
  public static void SetMute(bool on) { Guid g = Guid.Empty; Vol().SetMute(on, ref g); }
}
`

/** 读当前音量 / 静音 ✓（读不回来就回 null ✓ —— 页面如实说"读不到"，不编一个数 ✗）。 */
export async function readAudio() {
	const script = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
${AUDIO_CSHARP}
'@
[pscustomobject]@{ volume = [DshAudio]::GetVolume(); muted = [DshAudio]::GetMute() } | ConvertTo-Json
`
	const result = await runPowerShell(script)
	if (result === null || typeof result.volume !== 'number') return null
	return { volume: Math.max(0, Math.min(100, Math.round(result.volume))), muted: result.muted === true }
}

/**
 * 设音量 / 静音 ✓（设完**再读回来** ✓ —— 手机上看的是真实值 ✓，不是"我以为设成了" ✗）。
 * @param {{volume?: number, muted?: boolean}} wanted
 */
export async function applyAudio(wanted) {
	const lines = []
	if (typeof wanted.volume === 'number') lines.push(`[DshAudio]::SetVolume(${Math.max(0, Math.min(100, Math.round(wanted.volume)))})`)
	if (typeof wanted.muted === 'boolean') lines.push(`[DshAudio]::SetMute($${wanted.muted === true ? 'true' : 'false'})`)
	if (lines.length === 0) return readAudio()
	const script = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
${AUDIO_CSHARP}
'@
${lines.map((line) => line.replace('$$', '$')).join('\n')}
[pscustomobject]@{ volume = [DshAudio]::GetVolume(); muted = [DshAudio]::GetMute() } | ConvertTo-Json
`
	const result = await runPowerShell(script)
	if (result === null || typeof result.volume !== 'number') return null
	return { volume: Math.max(0, Math.min(100, Math.round(result.volume))), muted: result.muted === true }
}

/**
 * 读 + 设 屏幕亮度 ✓（WMI ✓，只管内置面板 ✓）。
 * 读不到 = 这台机器没有可调的内置屏 ✓ → 回 `{ supported: false }` ✓，调用方据此说人话 ✓。
 */
export async function readBrightness() {
	const result = await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
$b = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness
$m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods
if ($null -eq $b -or $null -eq $m) { [pscustomobject]@{ supported = $false } | ConvertTo-Json } else { [pscustomobject]@{ supported = $true; level = [int]$b.CurrentBrightness } | ConvertTo-Json }
`)
	if (result === null) return { supported: false }
	return { supported: result.supported === true, level: typeof result.level === 'number' ? Math.round(result.level) : null }
}

/** 设亮度 ✓（设完读回来 ✓）。返回值同 `readBrightness` ✓。 */
export async function applyBrightness(percent) {
	const level = Math.max(0, Math.min(100, Math.round(percent)))
	await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
$m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods
if ($null -ne $m) { $m | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = 0; Brightness = ${level} } | Out-Null; 'ok' }
`)
	return readBrightness()
}

/** 联网检查 ✓：有没有连上、走的哪条网、外网通不通 ✓（只读 + 一次 ping ✓）。 */
export async function checkNetwork() {
	const result = await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
$profiles = @(Get-NetConnectionProfile | Select-Object -Property Name, IPv4Connectivity, InterfaceAlias)
$adapters = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -Property Name, LinkSpeed)
$ping = Test-Connection -ComputerName 223.5.5.5 -Count 1 -Quiet
[pscustomobject]@{
  internet = [bool]$ping
  profiles = $profiles
  adapters = $adapters
} | ConvertTo-Json -Depth 4
`)
	if (result === null) return { internet: false, profiles: [], adapters: [] }
	const profiles = (Array.isArray(result.profiles) ? result.profiles : []).map((row) => ({
		name: String(row?.Name ?? ''),
		connectivity: String(row?.IPv4Connectivity ?? ''),
	}))
	const adapters = (Array.isArray(result.adapters) ? result.adapters : []).map((row) => ({ name: String(row?.Name ?? ''), speed: String(row?.LinkSpeed ?? '') }))
	return { internet: result.internet === true, profiles, adapters }
}

/** 电量检查 ✓（台式机没有电池 → `supported: false` ✓，如实说 ✓）。 */
export async function checkBattery() {
	const result = await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
if ($null -eq $b) { [pscustomobject]@{ supported = $false } | ConvertTo-Json } else {
  [pscustomobject]@{
    supported = $true
    percent = [int]$b.EstimatedChargeRemaining
    status = [int]$b.BatteryStatus
    minutesLeft = [int]$b.EstimatedRunTime
  } | ConvertTo-Json
}
`)
	if (result === null) return { supported: false }
	// BatteryStatus: 2 = 接着电源 ✓、1 = 放电中 ✓（其余按"未知"处理 ✓）
	const status = Number(result.status ?? 0)
	/*
	 * ⚠️ `EstimatedRunTime` 在**接着电源**时会回一个哨兵值（本机实测 `71582788` 分钟 ≈ 1.3 万年 ✗）——
	 * 那是 WMI 的"未知"占位 ✓，不是剩余时间 ✓。照着显示就是把一个荒唐的数摆给用户 ✗。
	 * 规矩：**说不清就不说** ✓（超过 24 小时一律当"未知" ✓）—— 这和"读不到就不显示那一段"是同一条 ✓。
	 */
	const rawMinutes = Number(result.minutesLeft ?? 0)
	const minutesLeft = Number.isFinite(rawMinutes) && rawMinutes > 0 && rawMinutes <= 24 * 60 ? Math.round(rawMinutes) : null
	return {
		supported: result.supported === true,
		percent: typeof result.percent === 'number' ? Math.round(result.percent) : null,
		plugged: status === 2,
		minutesLeft,
	}
}

/*
 * ⚠️ 这里的 PowerShell 脚本**必须是纯 ASCII** ✓ —— 它是当**命令行参数**传进去的 ✓，
 * 中文会被 PowerShell 5.1 按本地代码页解掉 ✗（我第一版把中文关键词写在 PS 正则里 ✓
 * → 脚本直接跑不通 ✓、还卡满 12 秒超时 ✓ → 列表回空 ✓ —— 一次踩了两个坑 ✓）。
 *
 * 所以分层：**PowerShell 只负责"取数据"** ✓（纯 ASCII ✓），
 * **"什么算设备、什么算协议"这条判断留在 Node 这边** ✓（UTF-8 安全 ✓、也好测 ✓）。
 */
const BLUETOOTH_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$devices = @(Get-PnpDevice -Class Bluetooth | Where-Object { $_.FriendlyName } | Select-Object -Property FriendlyName, Status)
[pscustomobject]@{ devices = $devices } | ConvertTo-Json -Depth 4
`

/**
 * 什么不算"用户眼里的设备" ✓（按名字滤 ✓）：
 *   · 协议 / 服务节点 —— "通用属性配置文件""蓝牙 LE 通用属性服务""服务发现服务""电话簿访问 PSE 服务" ✓
 *   · 无线电 / 枚举器 —— "英特尔(R) 无线 Bluetooth(R)""Microsoft 蓝牙枚举器" ✓
 *   · Avrcp 之类的**同一台设备的另一半** —— 要和主条目去重 ✓
 * 实测：45 条里滤出 **6 台真设备** ✓（AirPods / iPhone / 两台耳机 / 键盘 / 一台 F40 ✓）。
 */
const BLUETOOTH_NOISE = /Enumerator|Radio|Adapter|Protocol|Service|Profile|Avrcp|Microsoft|Bluetooth|通用|服务|配置文件|枚举|设备信息|电话簿|个人区域网|\bLE\b/i

/** 列已配对设备 ✓（只读 ✓）。⚠️ 实测 `Get-PnpDevice` 在这台机器上要 **12~15 秒** ✗（每次子进程都要加载那个模块 ✓）—— 超时给足 ✓，面板上写明"要十几秒" ✓。 */
export async function listBluetooth() {
	const result = await runPowerShell(BLUETOOTH_SCRIPT, 28000)
	if (result === null) return { devices: [] }
	const seen = new Set()
	const devices = []
	for (const row of Array.isArray(result.devices) ? result.devices : []) {
		const name = String(row?.FriendlyName ?? '').trim()
		if (name === '' || seen.has(name) || BLUETOOTH_NOISE.test(name)) continue
		seen.add(name)
		devices.push({ name, ok: String(row?.Status ?? '') === 'OK' })
	}
	return { devices }
}

/*
 * ⚠️ 这里原本还有一个 setBluetoothRadio()（WinRT 的 Radio.SetStateAsync）—— **真机验的时候删掉了** ✗。
 * 实测：这台机器上它绑不上 —— PS 5.1 里 WinRT 的 SetStateAsync 回的是裸 __ComObject，
 * 显式转成 IAsyncAction 也照样报转换失败（而**读**状态那条路（IAsyncOperation<T>）是好的）。
 * 按项目铁律：**不许摆一个按了没反应的键** ✗（4.3.0 就为这个撤过那个"解锁"键）——
 * 所以蓝牙开关那两个键**不做**，页面改成写明"开 / 关请到系统设置里点"。
 */
/** 打开系统蓝牙设置页 ✓（`ms-settings:bluetooth` ✓ —— 配对/连接在 Windows 上只能在这儿点 ✓）。 */
export async function openBluetoothSettings() {
	return new Promise((resolve) => {
		execFile('cmd.exe', ['/c', 'start', '', 'ms-settings:bluetooth'], { windowsHide: true, timeout: 8000 }, (error) => {
			resolve({ ok: error === null })
		})
	})
}

/**
 * 一次给齐面板要显示的**快状态** ✓（只读 ✓）：音量 / 亮度 / 电量 / 联网 ✓。
 *
 * ⚠️ **蓝牙故意不在这里** ✗：那一路要起 WinRT 等异步结果 ✓，实测拖到十几秒 ✓ ——
 * 面板一打开就干等十几秒是不能接受的 ✗。所以蓝牙走**单独一个按钮**（点一下才查 ✓），
 * 这样"打开面板"永远是快的 ✓，"查蓝牙"慢一点但用户知道自己在等什么 ✓。
 */
export async function snapshot() {
	const [audio, brightness, battery, network] = await Promise.all([
		readAudio(), readBrightness(), checkBattery(), checkNetwork(),
	])
	return { audio, brightness, battery, network, at: Date.now() }
}
