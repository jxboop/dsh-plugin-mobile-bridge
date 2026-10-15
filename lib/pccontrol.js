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
 * 蓝牙**已配对设备列表** —— 4.6.0 换成**系统原生蓝牙 API** ✓（`bthprops.cpl` ✓）。
 *
 * 为什么换 ✗：原来用 `Get-PnpDevice -Class Bluetooth` ✓，两个毛病：
 *   ① **慢** —— 每个子进程都要加载那个模块 ✓，实测 **12~16 秒** ✗（面板上点一下要干等 ✓）；
 *   ② **脏** —— 45 条里一半是协议/服务节点 ✓（"通用属性配置文件""蓝牙 LE 通用属性服务"…✓），
 *      得靠一串中文关键词黑名单去滤 ✓（而且那串关键词还不能写进 PowerShell 命令行 ✗ —— 见下面那条教训 ✓）。
 * 原生 API 两个毛病一起解决 ✓：**约 2 秒** ✓、而且它**只返回"这台机器记住过的设备"** ✓
 *（本来就不含协议节点 ✓，连过滤都省了 ✓），还**直接带上连接状态** ✓（`fConnected` ✓）。
 *
 * ⚠️ 关于「**连接某台设备**」—— 这一版**仍然没有那个键** ✗，而且这回是把底层试到底了 ✓：
 *   `BluetoothSetServiceState(hRadio, dev, guid, ENABLE)` 实测（2026-10-15 ✓）：
 *     · 杰的AirPods → **rc=87**（ERROR_INVALID_PARAMETER）✗、WI-C200 / CIYINSO → **rc=87** ✗、
 *       iPhone → **rc=1060**（设备不存在）✗；只有一台**没开机**的 F40 回了 rc=0 ✓，**但它并没有连上** ✗（`fConnected` 仍为 false ✓）。
 *     · 而 **DISABLE（断开）** 倒是 rc=0 ✓ —— 也就是"能关不能开" ✓。
 *   ⇒ 结论：Windows 这一层**没有**可靠的"连接某台已配对设备"接口 ✓（官方口径也是去设置里点 ✓）。
 *   所以面板上的做法是：**把每台设备的真实状态摆出来** ✓ + **点一下就直接打开系统蓝牙设置** ✓
 *   （从"找到那台设备"到"能动手的地方"只要一下 ✓）—— 这比摆一个按了没反应的键强得多 ✓。
 */
const BLUETOOTH_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
[StructLayout(LayoutKind.Sequential)] public struct BLUETOOTH_ADDRESS { public ulong ullLong; }
[StructLayout(LayoutKind.Sequential)] public struct SYSTEMTIME { public ushort wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct DSH_BT_DEVICE_INFO {
  public int dwSize;
  public BLUETOOTH_ADDRESS Address;
  public uint ulClassofDevice;
  public int fConnected;
  public int fRemembered;
  public int fAuthenticated;
  public SYSTEMTIME stLastSeen;
  public SYSTEMTIME stLastUsed;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string szName;
}
[StructLayout(LayoutKind.Sequential)] public struct DSH_BT_FIND_RADIO_PARAMS { public int dwSize; }
[StructLayout(LayoutKind.Sequential)] public struct DSH_BT_SEARCH_PARAMS {
  public int dwSize;
  public int fReturnAuthenticated;
  public int fReturnRemembered;
  public int fReturnUnknown;
  public int fReturnConnected;
  public int fIssueInquiry;
  public byte cTimeoutMultiplier;
  public IntPtr hRadio;
}
public class DshBluetooth {
  [DllImport("bthprops.cpl", SetLastError = true)] public static extern IntPtr BluetoothFindFirstRadio(ref DSH_BT_FIND_RADIO_PARAMS p, out IntPtr phRadio);
  [DllImport("bthprops.cpl", SetLastError = true)] public static extern bool BluetoothFindRadioClose(IntPtr h);
  [DllImport("bthprops.cpl", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr BluetoothFindFirstDevice(ref DSH_BT_SEARCH_PARAMS p, ref DSH_BT_DEVICE_INFO d);
  [DllImport("bthprops.cpl", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool BluetoothFindNextDevice(IntPtr h, ref DSH_BT_DEVICE_INFO d);
  [DllImport("bthprops.cpl", SetLastError = true)] public static extern bool BluetoothFindDeviceClose(IntPtr h);
  public static string List() {
    var frp = new DSH_BT_FIND_RADIO_PARAMS(); frp.dwSize = Marshal.SizeOf(frp);
    IntPtr radio; IntPtr find = BluetoothFindFirstRadio(ref frp, out radio);
    if (find == IntPtr.Zero) return "";
    var sp = new DSH_BT_SEARCH_PARAMS();
    sp.dwSize = Marshal.SizeOf(sp);
    sp.fReturnAuthenticated = 1; sp.fReturnRemembered = 1; sp.fReturnConnected = 1; sp.fReturnUnknown = 0; sp.fIssueInquiry = 0;
    sp.hRadio = radio;
    var d = new DSH_BT_DEVICE_INFO(); d.dwSize = Marshal.SizeOf(d);
    int size = d.dwSize;
    var sb = new StringBuilder();
    IntPtr h = BluetoothFindFirstDevice(ref sp, ref d);
    if (h != IntPtr.Zero) {
      do {
        if (d.szName != null && d.szName.Length > 0) {
          sb.Append(d.szName.Replace("|", " ")).Append("|").Append(d.fConnected != 0 ? "1" : "0").Append("\\n");
        }
        d.dwSize = size;
      } while (BluetoothFindNextDevice(h, ref d));
      BluetoothFindDeviceClose(h);
    }
    BluetoothFindRadioClose(find);
    return sb.ToString();
  }
}
'@
[pscustomobject]@{ lines = ([DshBluetooth]::List()) } | ConvertTo-Json
`
/*
 * ⚠️ 上面这段脚本必须**包成 JSON** 回来 ✓ —— `runPowerShell` 一律按 JSON 解 ✓，
 * 裸着打印多行文本会被 JSON.parse 判失败 → 列表永远是空的 ✗
 *（这个坑今天已经踩过一次 ✓，这是第二次 ✓ —— 记住：**输出一律 JSON** ✓）。
 * 📌 而且中文注释**不能写在脚本块里** ✗（`test/package.mjs` 有一条断言盯着 ✓）——
 * 整段脚本要过"命令行参数"那道边界 ✓，中文会在那儿被按本地代码页解掉 ✓，
 * 乱码甚至可能把注释提前结束、让后半行变成代码 ✗（今天就是这么让脚本跑不通的 ✓）。

/**
 * 列已配对设备 ✓（原生 API ✓，约 2 秒 ✓）：`{devices:[{name, connected}]}` ✓。
 *
 * ⚠️ 名字里可能有中文（"杰的AirPods" ✓）—— 所以**输出必须是 UTF-8** ✓（脚本开头那句
 * `[Console]::OutputEncoding` ✓），而且**脚本本身必须纯 ASCII** ✓：
 * 中文当命令行参数传进去会被 PowerShell 5.1 按本地代码页解掉 ✗（这条坑今天踩了两次 ✓）。
 */
export async function listBluetooth() {
	const result = await runPowerShell(BLUETOOTH_SCRIPT, 20000)
	const text = result === null || typeof result.lines !== 'string' ? '' : result.lines
	if (text.trim() === '') return { devices: [] }
	const devices = []
	const seen = new Set()
	for (const line of text.split('\n')) {
		const [name, flag] = line.trim().split('|')
		if (name === undefined || name === '' || seen.has(name)) continue
		seen.add(name)
		devices.push({ name, connected: flag === '1' })
	}
	// 连着的排前面 ✓（用户最可能想找的就是它 ✓）。
	devices.sort((left, right) => Number(right.connected) - Number(left.connected) || left.name.localeCompare(right.name))
	return { devices }
}

/*
 * ⚠️ 蓝牙**开关**：第一版删掉过，后来又做回来了 —— 两次的账都写在这儿 ✓。
 *
 * 第一次（4.5.0 发布前）为什么删 ✗：用 WinRT 的 `Radio.SetStateAsync` + `AsTask` **等结果**，
 * 真机上必报"类型 System.__ComObject 无法转换为 IAsyncAction" ✓，显式转型也一样 ✓ ——
 * 看着就像"系统不让调" ✓，于是按项目铁律把两个键撤了 ✓（不摆按了没反应的键 ✓）。
 *
 * 第二次（用户 2026-10-15 说「你再试一下」✓）探明白了三件事 ✓：
 *   ① **副作用其实执行了** ✓ —— 那个"失败"的调用把蓝牙真关了 ✓（探测时读回来 `before: Off` ✓）；
 *   ② 失败的**只是"等它完成"那一步** ✗（PS 5.1 绑不上 `IAsyncAction` 的 `AsTask` 重载 ✓）；
 *   ③ 而**读**状态那条路一直是好的 ✓（`IAsyncOperation<T>` 的泛型 `AsTask` ✓，约 1 秒 ✓）。
 * 所以正确做法：**把调用发出去、然后轮询真实状态** ✓ —— 不等那个 action ✓。
 * 这也更好 ✓：面板上显示的是"读回来的真状态" ✓，不是"我以为设成了" ✗。
 */
const RADIO_READ = `
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Get-BtRadioState {
  $task = $asTaskGeneric.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]).Invoke($null, @([Windows.Devices.Radios.Radio]::GetRadiosAsync()))
  $task.Wait(8000) | Out-Null
  $bt = @($task.Result | Where-Object { $_.Kind.ToString() -eq 'Bluetooth' })
  if ($bt.Count -eq 0) { return '' }
  return $bt[0].State.ToString()
}
`

/** 读蓝牙无线电状态 ✓（快 ✓，约 1 秒 ✓）：`On` / `Off` / `''`（没有无线电或读不到 ✓）。 */
export async function readBluetoothRadio() {
	const result = await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
$null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
${RADIO_READ}
# ⚠️ 必须走 JSON 回来 —— 裸着打印一个 On 时 JSON.parse 会失败
#    （我第一版就是这么写的，读回来永远是空；而开关那条因为本来就是 JSON 所以是好的）。
[pscustomobject]@{ state = (Get-BtRadioState) } | ConvertTo-Json
`, 15000)
	if (result === null) return ''
	return String(result.state ?? '')
}

/**
 * 蓝牙无线电开 / 关 ✓（**发出去 + 轮询真实状态** ✓，最多等约 10 秒 ✓）。
 * 返回值里的 `radio` 永远是**读回来的真状态** ✓ —— `ok` 就是"真状态 == 想要的状态" ✓。
 */
export async function setBluetoothRadio(on) {
	const wanted = on === true ? 'On' : 'Off'
	const result = await runPowerShell(`
$ErrorActionPreference='SilentlyContinue'
$null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
${RADIO_READ}
try {
  $task0 = $asTaskGeneric.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]).Invoke($null, @([Windows.Devices.Radios.Radio]::GetRadiosAsync()))
  $task0.Wait(8000) | Out-Null
  $radio = @($task0.Result | Where-Object { $_.Kind.ToString() -eq 'Bluetooth' })[0]
  if ($null -eq $radio) { [pscustomobject]@{ ok = $false; radio = ''; reason = 'no-radio' } | ConvertTo-Json } else {
    $null = $radio.SetStateAsync([Windows.Devices.Radios.RadioState]::${wanted})
    $state = ''
    $waited = 0
    for ($i = 0; $i -lt 25; $i++) {
      Start-Sleep -Milliseconds 400
      $waited = ($i + 1) * 400
      $state = Get-BtRadioState
      if ($state -eq '${wanted}') { break }
    }
    [pscustomobject]@{ ok = ($state -eq '${wanted}'); radio = $state; waitedMs = $waited } | ConvertTo-Json
  }
} catch { [pscustomobject]@{ ok = $false; radio = ''; reason = $_.Exception.Message } | ConvertTo-Json }
`, 30000)
	if (result === null) return { ok: false, radio: '', reason: 'no-output' }
	return { ok: result.ok === true, radio: String(result.radio ?? ''), reason: result.reason === undefined ? '' : String(result.reason) }
}

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
	const [audio, brightness, battery, network, radio] = await Promise.all([
		readAudio(), readBrightness(), checkBattery(), checkNetwork(), readBluetoothRadio(),
	])
	return { audio, brightness, battery, network, bluetooth: { radio }, at: Date.now() }
}
