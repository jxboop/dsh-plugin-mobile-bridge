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
 * 4.13.0 起又多了一件：**定时开机** ✓（用户 2026-10-16：「既然有关机那么可以做一个对应的定时开机功能」✓）
 * —— ⚠️ 它**只在睡眠 (S3) 这一层成立** ✗，完全关机 (S5) 软件做不到 ✓：
 * 详细的分层结论、以及那四件**真机实测**过的事实，写在文件下半部分「4.13.0 定时开机」那一段 ✓。
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

/*
 * ================================================================== 4.13.0 定时开机
 *
 * 用户 2026-10-16 原话：「既然有关机那么可以做一个对应的定时开机功能」✓。
 *
 * ⚠️ 这件事**必须如实分层** ✗（本项目的底线：做不到就说做不到 ✓，不许含糊 ✓）：
 *   · **睡眠 (S3)**：能 ✓ —— 系统还活着 ✓，计划任务带 `WakeToRun` 就有权把机器叫醒 ✓；
 *   · **休眠 (S4)**：也能 ✓（本机没启用休眠 ✗ —— 那是另一件事，面板上照实说 ✓）；
 *   · **完全关机 (S5)**：**不能** ✗✗ —— 系统没在运行 ✓，**任何软件都不存在** ✓。
 *     那只能靠主板 BIOS/UEFI 里的 **RTC 定时开机** ✓（设好之后**不需要任何软件** ✓）。
 *     所以这里**不提供**"关机后到点开机"那个键 ✗（摆了就是骗人 ✓ —— 和"不摆按了没反应的键"同一条 ✓）。
 *
 * 2026-10-16 在**这台机器上当场实测过的四件事** ✓（不是照文档抄的 ✗）：
 *   ① `Register-ScheduledTask -WakeToRun -Force` **普通用户就能建** ✓（不要管理员 ✓）——
 *      读回来的 XML 里确实是 `<WakeToRun>true</WakeToRun>` ✓、`StartBoundary` 是本机时区 ✓；
 *   ② `schtasks.exe /query /tn <名字> /xml` **免提权可查** ✓ —— ⚠️ 但这台机器上
 *      `Get-ScheduledTask` 与 `Unregister-ScheduledTask` 会报 "The task XML contains a value
 *      which is incorrectly formatted or out of range" ✗（和 `lib/index.js` 里"开机自启"
 *      那条踩的是**同一颗雷** ✓）→ 所以这里**一律走 schtasks.exe** ✓；
 *   ③ `schtasks.exe /delete /tn <名字> /f` **免提权可删** ✓（`Unregister-ScheduledTask` ✗ 见 ②）；
 *   ④ `powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE` **免提权可读** ✓，而
 *      `powercfg /waketimers` **要管理员** ✗ → **读不到就如实说读不到** ✗，
 *      绝不把它当成"没有唤醒定时器" ✓（那是最坏的一种假话 ✓）。
 *
 * ⚠️ 还有一条**上一版交接文档里写错、这一版改正**的账 ✓：那里写着"`powercfg /waketimers`
 * 要提权 → 正好走 `elevationMinutes` + PIN" ✗ —— **两回事** ✓：`elevationMinutes` 只是
 * "最近输过一次 PIN"的窗口（`elevated(req)` ✓），**不是** Windows 管理员权限 ✗；
 * 本插件跑在普通用户下 ✓，既不提权、也不该偷偷提权 ✓。
 * 所以这一版的规矩是：**能读就读 ✓，读不到就照实说"要管理员、读不到"** ✓。
 *
 * ⚠️ 醒不醒得成，还看一条**系统电源设置**（本机实测：交流电 = 「仅限重要的唤醒定时器」✗、
 * 电池 = 「禁用」✗）：`RTCWAKE` 0=禁用 ✓ / 1=启用 ✓ / 2=仅限重要的唤醒定时器 ✓。
 * 所以面板上必须把**这条真实值**摆出来 ✓，并给出改它的命令（**要管理员** ✓ ——
 * 插件**不假装**自己能改 ✗）；电池那一档是 0 时还要说清"**插着电**才稳" ✓。
 */

/** 那个计划任务的名字 ✓。**纯 ASCII** ✓ —— 中文任务名走命令行会被本地代码页吃掉 ✗（见 lib/index.js 那笔账 ✓）。 */
export const WAKE_TASK_NAME = 'DSH-mobile-bridge-wake'

/** 改唤醒定时器策略的命令 ✓（要管理员 ✓ —— 面板只**显示**它，不假装能替用户跑 ✗）。 */
export const WAKE_POLICY_COMMAND = 'powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1'

/**
 * 把用户写的时间读成一个**本机时刻** ✓（纯函数 ✓ —— 不碰系统 ✓，测试就靠它 ✓）。
 *
 * 认三种写法 ✓：`07:30` ✓、`10-17 07:30` ✓、`2026-10-17 07:30` ✓（日期与时间之间空格或 `T` ✓）。
 * 滚动规则（**每一条都要能对用户说清楚** ✓ —— 悄悄改掉用户写的时间就是假话 ✗）：
 *   · 只写时间：今天还没到 → 今天 ✓；今天已经过了 → **明天** ✓（`rolled: 'tomorrow'` ✓）；
 *   · 写了月-日、没写年：今年这一天的这个点还没到 → 今年 ✓；已经过了 → **明年** ✓（`rolled: 'year'` ✓）；
 *   · 年月日都写了：**必须**是将来 ✓ —— 已经过了就**拒绝** ✓（用户写得很明确 ✓，替他改就是骗他 ✗）。
 * @param {string} text 用户写的时间
 * @param {Date} [now] 现在（测试注入 ✓）
 * @returns {{ok: boolean, at?: Date, iso?: string, text?: string, rolled?: string, error?: string}}
 */
export function parseWakeAt(text, now = new Date()) {
	// 日期与时间之间：空格 ✓ / `T` ✓（`2026-10-17T07:30` 也认 ✓ —— 后面那句话得是真的 ✓）。
	const raw = String(text ?? '').trim().replace(/\s+/g, ' ').replace(/T(?=\d{1,2}:\d{2}$)/, ' ')
	const bad = (error) => ({ ok: false, error })
	if (raw === '') return bad('先写一个时间 ✓ —— 比如 07:30、10-17 07:30、2026-10-17 07:30 ✓')
	const parts = raw.split(' ')
	if (parts.length > 2) return bad('看不懂这个时间 ✓ —— 可以写 07:30 / 10-17 07:30 / 2026-10-17 07:30 ✓')
	const timePart = parts.length === 2 ? parts[1] : parts[0]
	const datePart = parts.length === 2 ? parts[0] : ''
	const clock = /^(\d{1,2}):(\d{2})$/.exec(timePart)
	if (clock === null) return bad('时间要写成 07:30 这样 ✓（24 小时制 ✓）')
	const hour = Number(clock[1])
	const minute = Number(clock[2])
	if (hour > 23 || minute > 59) return bad('这个点数不存在 ✓ —— 小时 0~23、分钟 0~59 ✓')
	let year = now.getFullYear()
	let month = now.getMonth() + 1
	let day = now.getDate()
	let pinnedYear = false
	if (datePart !== '') {
		const date = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(datePart)
		if (date === null) return bad('日期要写成 10-17 或 2026-10-17 ✓')
		if (date[1] !== undefined) { year = Number(date[1]); pinnedYear = true }
		month = Number(date[2])
		day = Number(date[3])
	}
	if (month < 1 || month > 12) return bad('月份要在 1~12 之间 ✓')
	if (day < 1 || day > 31) return bad('日子要在 1~31 之间 ✓')
	/*
	 * ⚠️ 找年份**必须一年一年试** ✗，不能直接 `year + 1` ✓：
	 * 写 `02-29`（闰日 ✓）时，下一个**真的存在这一天**的年份可能是 +4 年 ✓ ——
	 * 直接 +1 会被 Date 悄悄滚成 3-1 ✗（那就变成"定在 3 月 1 日"了 ✓，跟用户写的完全不是一回事 ✗）。
	 */
	const build = (y) => new Date(y, month - 1, day, hour, minute, 0, 0)
	const fits = (y) => { const probe = build(y); return probe.getMonth() === month - 1 && probe.getDate() === day }
	const findYear = (from) => {
		for (let candidate = from; candidate <= from + 8; candidate += 1) if (fits(candidate) === true) return candidate
		return null
	}
	let rolled = ''
	let at = build(year)
	if (fits(year) === false) {
		// 2-30 / 4-31 这种"压根不存在"的日子一律拒绝 ✓；只有"没写年"的 02-29 才往后找真闰年 ✓。
		if (pinnedYear === true || datePart === '') return bad('这一天不存在 ✓（比如 2-30 / 4-31 ✓）')
		const leapYear = findYear(year + 1)
		if (leapYear === null) return bad('这一天不存在 ✓（比如 2-30 / 4-31 ✓）')
		at = build(leapYear)
		rolled = 'year'
	} else if (at.getTime() < now.getTime() + 60 * 1000) {
		if (pinnedYear === true) return bad('这个时间已经过了 ✓ —— 定时开机只能定**将来**的时刻 ✓')
		if (datePart === '') {
			at = build(year)
			at.setDate(at.getDate() + 1)
			rolled = 'tomorrow'
		} else {
			const nextYear = findYear(year + 1)
			if (nextYear === null) return bad('这一天不存在 ✓（比如 2-30 / 4-31 ✓）')
			at = build(nextYear)
			rolled = 'year'
		}
	}
	const padded = (value) => String(value).padStart(2, '0')
	const iso = `${at.getFullYear()}-${padded(at.getMonth() + 1)}-${padded(at.getDate())}T${padded(at.getHours())}:${padded(at.getMinutes())}:00`
	return { ok: true, at, iso, text: `${at.getFullYear()}-${padded(at.getMonth() + 1)}-${padded(at.getDate())} ${padded(at.getHours())}:${padded(at.getMinutes())}`, rolled }
}

/**
 * 从 `powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE` 的输出里抠出**交流 / 直流**两个值 ✓。
 *
 * ⚠️ 为什么不用中文关键词去匹配 ✗：`powercfg` 的输出是**本地化**的 ✓（这台机器是中文 ✓，
 * 换台英文机器就一个字都对不上 ✗）。而那两个值是 `0x00000002` 这种**十六进制字面量** ✓
 * —— 十六进制不翻译 ✓。实测输出里正好两个 `0x` ✓（"可能的设置索引: 000/001/002" 是十进制、
 * 不带 `0x` ✓），顺序是**先交流、后直流** ✓，所以取**最后两个** ✓。
 * @returns {{ac: number|null, dc: number|null}}
 */
export function parseRtcWakeIndex(text) {
	const found = [...String(text ?? '').matchAll(/0x([0-9a-fA-F]{1,8})/g)].map((match) => Number.parseInt(match[1], 16))
	if (found.length < 2) return { ac: null, dc: null }
	return { ac: found[found.length - 2], dc: found[found.length - 1] }
}

const RTCWAKE_NAMES = { 0: '禁用', 1: '启用', 2: '仅限重要的唤醒定时器' }

/**
 * 把两个数值说成人话 ✓（纯函数 ✓）。⚠️ **不许把"读不到"说成"没有"** ✗ ——
 * 读不到时 `level` 是 `'unknown'` ✓、`note` 明说读不到 ✓。
 */
export function describeWakePolicy(ac, dc) {
	const name = (value) => (value === null || value === undefined ? '读不到' : (RTCWAKE_NAMES[value] ?? `不认识的取值 ${value}`))
	const level = ac === 1 ? 'ok' : ac === 2 ? 'important-only' : ac === 0 ? 'disabled' : 'unknown'
	const battery = dc === 0 ? '电池这一档是「禁用」✗ —— **插着电**才稳 ✓' : `电池这一档是「${name(dc)}」✓`
	const notes = {
		ok: '唤醒定时器是「启用」✓ —— 到点叫醒的系统设置这一关是通的 ✓',
		'important-only': '⚠️ 唤醒定时器只是「仅限重要的唤醒定时器」—— 我们建的这个任务**多半叫不醒**机器 ✗（只有系统自己那几条重要唤醒定时器算数 ✓）。要稳，就在电脑上用**管理员**跑一条命令把它改成「启用」✓（命令面板上有 ✓）。',
		disabled: '⚠️ 唤醒定时器是「**禁用**」✗ —— 这么设的话，到点**醒不了** ✓。要稳，就在电脑上用**管理员**跑一条命令把它改成「启用」✓（命令面板上有 ✓）。',
		unknown: '⚠️ 唤醒定时器这条设置**读不到** ✗（不是"没设" ✓ —— 是这台机器上没读回来 ✓）。醒不醒得成，只能到点见分晓 ✓。',
	}
	return { ac, dc, acName: name(ac), dcName: name(dc), level, note: notes[level], battery, command: WAKE_POLICY_COMMAND }
}

/**
 * 解析 `schtasks /query /tn <名字> /xml` 的输出 ✓（纯函数 ✓）。
 *
 * ⚠️ 一条**实测得来**的坑 ✓：任务启用时，`schtasks` 导出的 XML 里**根本没有 `<Enabled>` 这个元素** ✗
 * （禁用时才有 `<Enabled>false</Enabled>` ✓）—— 所以"没这个元素 = 启用" ✓，
 * 把它当成"没启用"就会把自己建好的任务报成"没启用" ✗。
 */
export function parseWakeTaskXml(xml) {
	const text = String(xml ?? '')
	const pick = (tag) => {
		const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text)
		return match === null ? '' : match[1].trim()
	}
	const start = pick('StartBoundary')
	const command = pick('Command')
	const argumentsText = pick('Arguments')
	const enabledRaw = pick('Enabled')
	const wakeRaw = pick('WakeToRun')
	// 只有真见到 `<Task`（或者至少见到 StartBoundary）才算"任务在" ✓ —— 空串/错误文本都不算 ✓。
	const exists = /<Task[\s>]/.test(text) || start !== ''
	return {
		exists,
		startBoundary: start,
		wakeToRun: wakeRaw.toLowerCase() === 'true',
		enabled: enabledRaw === '' ? true : enabledRaw.toLowerCase() !== 'false',
		command,
		arguments: argumentsText,
	}
}

/** 建 / 覆盖那个任务 ✓（`__NAME__` 与 `__AT__` 由 JS 填 ✓ —— 脚本块本身必须纯 ASCII ✓）。 */
const WAKE_SET_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$name='__NAME__'
$at=[datetime]::ParseExact('__AT__','yyyy-MM-ddTHH:mm:ss',$null)
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command exit'
$trigger=New-ScheduledTaskTrigger -Once -At $at
$settings=New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$registered=$false
try { $null=Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop; $registered=$true } catch { $registered=$false }
$xml=(schtasks.exe /query /tn $name /xml 2>$null | Out-String)
$xmlExit=$LASTEXITCODE
[pscustomobject]@{ registered=$registered; xmlExit=$xmlExit; xml=$xml } | ConvertTo-Json -Compress
`

/** 一条命令读齐三样 ✓：任务 XML ✓ + 唤醒定时器策略 ✓ + 现有的唤醒定时器（要管理员 ✗）✓。 */
const WAKE_INFO_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$name='__NAME__'
$xml=(schtasks.exe /query /tn $name /xml 2>$null | Out-String)
$xmlExit=$LASTEXITCODE
$policy=(powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE 2>$null | Out-String)
$wake=(powercfg /waketimers 2>$null | Out-String)
$wakeExit=$LASTEXITCODE
[pscustomobject]@{ xml=$xml; xmlExit=$xmlExit; policy=$policy; wake=$wake; wakeExit=$wakeExit } | ConvertTo-Json -Compress
`

/** 删那个任务 ✓，并且**删完再查一次** ✓ —— "说删了"必须有回读撑着 ✓（照项目一贯的规矩 ✓）。 */
const WAKE_CLEAR_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$name='__NAME__'
$before=(schtasks.exe /query /tn $name /xml 2>$null | Out-String)
$beforeExit=$LASTEXITCODE
$delete=(schtasks.exe /delete /tn $name /f 2>&1 | Out-String)
$deleteExit=$LASTEXITCODE
$after=(schtasks.exe /query /tn $name /xml 2>$null | Out-String)
$afterExit=$LASTEXITCODE
[pscustomobject]@{ before=$before; beforeExit=$beforeExit; delete=$delete; deleteExit=$deleteExit; after=$after; afterExit=$afterExit } | ConvertTo-Json -Compress
`

/** 读这一个任务 + 系统那两条设置 ✓（一次 PowerShell ✓ —— 三次调用会白多花两秒 ✓）。 */
export async function readWakeInfo(name = WAKE_TASK_NAME) {
	const result = await runPowerShell(WAKE_INFO_SCRIPT.replace('__NAME__', name), 25000)
	const task = parseWakeTaskXml(result === null ? '' : result.xml)
	const policy = parseRtcWakeIndex(result === null ? '' : result.policy)
	const wakeText = result === null || typeof result.wake !== 'string' ? '' : result.wake.trim()
	const wakeExit = result === null ? 1 : Number(result.wakeExit ?? 1)
	return {
		task,
		policy: describeWakePolicy(policy.ac, policy.dc),
		// ⚠️ 读不到时 `readable:false` + **照实说**（面板据此说"要管理员才读得到" ✓，不说"没有定时器" ✗）。
		wakeTimers: {
			readable: wakeExit === 0,
			lines: wakeText === '' ? [] : wakeText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''),
		},
	}
}

/**
 * 建（或覆盖）那个到点唤醒的计划任务 ✓，然后**读回来** ✓ ——
 * 返回值里的 `ok` 要求"回读到的任务确实带 `WakeToRun`"✓，不是"我以为建上了" ✗。
 */
export async function setWakeTask(atIso, name = WAKE_TASK_NAME) {
	const script = WAKE_SET_SCRIPT.replace('__NAME__', name).replace('__AT__', atIso)
	const result = await runPowerShell(script, 30000)
	const task = parseWakeTaskXml(result === null ? '' : result.xml)
	const registered = result !== null && result.registered === true
	return {
		registered,
		ok: registered === true && task.exists === true && task.wakeToRun === true && task.startBoundary !== '',
		task,
	}
}

/** 取消（删掉）那个任务 ✓；`gone` 是**回读**得到的结论 ✓，`wasThere` 是删之前的状态 ✓。 */
export async function clearWakeTask(name = WAKE_TASK_NAME) {
	const result = await runPowerShell(WAKE_CLEAR_SCRIPT.replace('__NAME__', name), 25000)
	const before = parseWakeTaskXml(result === null ? '' : result.before)
	const after = parseWakeTaskXml(result === null ? '' : result.after)
	return {
		wasThere: before.exists,
		gone: after.exists === false,
		verified: after.exists === false,
		ok: after.exists === false,
	}
}
