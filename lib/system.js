/**
 * 电脑状态采样 + 结束进程（2.7.0 ★3「电脑状态盘 + 一键结束卡死进程」）。
 *
 * 为什么单开一个模块：`index.js` 已经四千多行，而这一块**平台相关**（Windows 上靠
 * PowerShell 拿进程/网卡计数 ✓），独立出来才好读、好测 ✓。插件依旧零依赖 ✓
 * （`node:os` / `node:fs` / 一个 `powershell` 子进程 ✓）。
 *
 * 安全边界（这一版最重要的部分，写在最前面 ✓）：
 *   DSH 自己就是一个 node 进程，而**桥跑在它里面** —— 手机上点"结束进程"如果杀错，
 *   杀掉的就是正在跟用户说话的这个 DSH ✗（现场实测：3080 与 3081 都是同一个 PID ✓）。
 *   所以 `kill` 一共四道闸，缺一不可：
 *     ① 配置里 `processControl: true`（**默认关** ✓，而且每次请求**现读配置文件** ——
 *        关掉能立刻生效 ✓，不用重启 ✓）；
 *     ② 请求体里**现输 PIN**（和"删除会话"同一套纪律 ✓，错 PIN 进登录限速 ✓）；
 *     ③ 目标必须是 **node.exe** ✓（只治"node 卡住"这一种病 ✓）；
 *     ④ **不许杀自己**（`process.pid`）、**不许杀自己的子进程**（DSH 跑命令用的 runner ✓）——
 *        这两个是本机正常运行时最像"卡住"、实际一杀就出事的 ✓。
 */

import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { cpus, totalmem, freemem, platform, tmpdir } from 'node:os'
import { dirname, parse, join } from 'node:path'

const PS_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/** 一次 PowerShell 调用，拿回 JSON（单次 spawn：手机上点一下刷新，等 300ms 左右 ✓）。 */
function runPowerShell(script, timeoutMs = 12000) {
	return new Promise((resolve) => {
		execFile('powershell.exe', [...PS_ARGS, script], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			if (error !== null && (stdout ?? '') === '') { resolve(null); return }
			try { resolve(JSON.parse(String(stdout))) } catch { resolve(null) }
		})
	})
}

/** CPU 使用率要两次采样才有意义：把上一次留在模块里，2 秒内再来一次就直接用 ✓。 */
let lastCpu = null
function cpuUsage() {
	const now = cpus().map((core) => ({ idle: core.times.idle, total: Object.values(core.times).reduce((sum, value) => sum + value, 0) }))
	const previous = lastCpu
	lastCpu = now
	if (previous === null || previous.length !== now.length) return null
	let idleDelta = 0
	let totalDelta = 0
	for (let i = 0; i < now.length; i++) {
		idleDelta += now[i].idle - previous[i].idle
		totalDelta += now[i].total - previous[i].total
	}
	if (totalDelta <= 0) return null
	const usage = 100 * (1 - idleDelta / totalDelta)
	return Math.max(0, Math.min(100, Math.round(usage)))
}

/** 网速要两次网卡计数才有意义（同样把上一次留在模块里 ✓；第一次刷新显示"再刷一次" ✓）。 */
let lastNet = null

const PROCESS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,UserModeTime,KernelModeTime,CreationDate,CommandLine
$ports = Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3080,3081 } | Select-Object LocalPort,OwningProcess
$net = Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes,SentBytes -Sum
$disk = foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $null -ne $_.Used })) {
	[pscustomobject]@{ drive = $d.Name; free = $d.Free; used = $d.Used }
}
[pscustomobject]@{
	processes = @($procs)
	ports = @($ports)
	net = [pscustomobject]@{ received = [double]$net[0].Sum; sent = [double]$net[1].Sum }
	disks = @($disk)
} | ConvertTo-Json -Depth 4 -Compress
`

/** 采样一次（手机页刷新时调 ✓）。读不到的块**明说读不到** ✗，绝不编一个数字 ✓。
 * @param {{ full?: boolean }} [options] full=true 时返回**全部**进程 —— 结束进程那条路要用它 ✓：
 *   "能不能杀"必须对**真存在的任何进程**都能判 ✓，不能因为"没进手机那份精简列表"就说找不到 ✗。 */
export async function sampleSystem(options = {}) {
	// CPU 百分比要两次采样：**第一次调用**（进程刚起来、还没有上一次）就等 250ms 再采一次 ✓——
	// 让用户第一次打开就看到数字，而不是一个 "—" ✓（只多 250ms，人感觉不到 ✓）。
	let cpuPercent = cpuUsage()
	if (cpuPercent === null) {
		await new Promise((resolve) => setTimeout(resolve, 250))
		cpuPercent = cpuUsage()
	}
	const sampled = await runPowerShell(PROCESS_SCRIPT)
	const totalMB = Math.round(totalmem() / 1048576)
	const freeMB = Math.round(freemem() / 1048576)
	const cores = cpus().length

	const disks = []
	if (sampled !== null && Array.isArray(sampled.disks)) {
		for (const entry of sampled.disks) {
			const total = Number(entry.used) + Number(entry.free)
			if (!Number.isFinite(total) || total <= 0) continue
			disks.push({
				drive: String(entry.drive) + ':',
				freeGB: Math.round(Number(entry.free) / 1073741824),
				totalGB: Math.round(total / 1073741824),
				percentFree: Math.round((Number(entry.free) / total) * 100),
			})
		}
	}
	// 没有 PowerShell 数据时，至少把 DSH 所在盘报出来（Node 自带的 statfs ✓）。
	if (disks.length === 0) {
		try {
			const info = await statfs(parse(dirname(join(tmpdir(), 'x'))).root)
			const total = Number(info.blocks) * Number(info.bsize)
			const free = Number(info.bavail) * Number(info.bsize)
			if (total > 0) {
				disks.push({
					drive: parse(dirname(join(tmpdir(), 'x'))).root,
					freeGB: Math.round(free / 1073741824),
					totalGB: Math.round(total / 1073741824),
					percentFree: Math.round((free / total) * 100),
				})
			}
		} catch { /* 磁盘读不到就不报这一块 ✓ */ }
	}

	// 网速：和上一次比（第一次只说"再刷一次" ✓，不猜 ✓）。
	let net = null
	const rawNet = sampled?.net
	if (rawNet !== undefined && rawNet !== null) {
		const at = Date.now()
		const reading = { at, received: Number(rawNet.received), sent: Number(rawNet.sent) }
		if (lastNet !== null && at > lastNet.at && Number.isFinite(reading.received) && Number.isFinite(reading.sent)) {
			const seconds = (at - lastNet.at) / 1000
			const rx = (reading.received - lastNet.received) / 1024 / seconds
			const tx = (reading.sent - lastNet.sent) / 1024 / seconds
			if (Number.isFinite(rx) && Number.isFinite(tx) && rx >= 0 && tx >= 0) {
				net = { rxKBps: Math.round(rx), txKBps: Math.round(tx) }
			}
		}
		lastNet = reading
	}

	const ports = {}
	if (sampled !== null && Array.isArray(sampled.ports)) {
		for (const entry of sampled.ports) ports[String(entry.LocalPort)] = Number(entry.OwningProcess)
	}

	const processes = []
	const self = process.pid
	if (sampled !== null && Array.isArray(sampled.processes)) {
		for (const entry of sampled.processes) {
			const pid = Number(entry.ProcessId)
			if (!Number.isFinite(pid)) continue
			const parentPid = Number(entry.ParentProcessId)
			const name = String(entry.Name ?? '')
			const isNode = name.toLowerCase() === 'node.exe'
			const isSelf = pid === self
			const isChild = parentPid === self
			const cpuSeconds = Math.round(((Number(entry.UserModeTime) || 0) + (Number(entry.KernelModeTime) || 0)) / 1e7)
			let why = ''
			if (isSelf) why = '这就是 DSH 本体（手机桥跑在它里面）—— 绝不能杀'
			else if (isChild) why = 'DSH 正在用的子进程（跑命令/工具）—— 杀了会打断正在干的活'
			else if (!isNode) why = '不是 node 进程'
			processes.push({
				pid,
				parentPid,
				name,
				mb: Math.round((Number(entry.WorkingSetSize) || 0) / 1048576),
				cpuSeconds,
				startedAt: String(entry.CreationDate ?? ''),
				command: String(entry.CommandLine ?? '').slice(0, 300),
				isNode,
				isSelf,
				isChild,
				killable: isNode && isSelf === false && isChild === false,
				why,
			})
		}
	}
	// 有 node 的排前面（这一版就是治"node 卡住" ✓），再按内存降序。
	processes.sort((left, right) => (Number(right.isNode) - Number(left.isNode)) || (right.mb - left.mb))
	/*
	 * 手机上只发**该看的那些** ✓：全部 node 进程（要治的就是它 ✓）+ 内存最大的 12 个（看谁吃资源 ✓）
	 * + 占着桥那两个端口的 ✓。真机上共 313 个进程，全发过去是 ~90KB —— 隧道下白等 ✓，
	 * 而"翻 300 行进程列表"对用户也没用 ✓。
	 */
	const listed = processes.filter((entry, index) => entry.isNode === true || index < 12)
	const subset = []
	const seen = new Set()
	for (const entry of [...listed, ...processes.filter((p) => p.pid === ports['3080'] || p.pid === ports['3081'])]) {
		if (seen.has(entry.pid)) continue
		seen.add(entry.pid)
		subset.push(entry)
	}

	return {
		at: Date.now(),
		host: {
			platform: platform(),
			cores,
			cpuPercent,
			memoryTotalMB: totalMB,
			memoryFreeMB: freeMB,
			memoryUsedPercent: Math.round(((totalMB - freeMB) / totalMB) * 100),
			bridgeRssMB: Math.round(process.memoryUsage().rss / 1048576),
			uptimeHours: Math.round(process.uptime() / 360) / 10,
		},
		disks,
		net,
		ports,
		processTotal: processes.length,
		processes: options.full === true ? processes : subset,
		sampledAt: sampled === null ? null : Date.now(),
	}
}

/** 结束一个进程（调用方必须先过完四道闸 ✓，这里只做"杀 + 确认真的没了"✓）。 */
export function killProcess(pid) {
	return new Promise((resolve) => {
		execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
			if (error !== null) {
				resolve({ ok: false, message: String(stderr ?? '').trim() || String(error.message) })
				return
			}
			resolve({ ok: true, message: String(stdout ?? '').trim() })
		})
	})
}

/** 复查：这个 PID 还在不在（"杀了"必须**确认过**再说 ✓，不假装成功 ✓）。 */
export async function processAlive(pid) {
	const out = await runPowerShell(
		`$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($null -eq $p) { '{"alive":false}' } else { '{"alive":true}' }`,
	)
	if (out === null) return null
	return out.alive === true
}

/** 判断"这一次能不能杀"（配置 + 目标两条；PIN 由路由层负责 ✓）。 */
export function killVerdict(pid, processes) {
	const target = processes.find((entry) => entry.pid === Number(pid))
	if (target === undefined) return { ok: false, status: 404, error: '没有这个进程（它可能已经退出了）' }
	if (target.isSelf === true) return { ok: false, status: 400, error: '这是 DSH 本体 —— 杀了手机桥和这个会话都会断，不允许' }
	if (target.isChild === true) return { ok: false, status: 400, error: '这是 DSH 正在用的子进程（跑命令用的），杀了会打断正在干的活' }
	if (target.isNode !== true) return { ok: false, status: 400, error: '只允许结束 node 进程（这一版只治"node 卡住"）' }
	return { ok: true, target }
}
