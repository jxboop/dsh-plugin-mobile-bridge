/**
 * 加载页进度条探针（真浏览器 + 网络节流）：**"百分比不会变"这类投诉的复现器**。
 *
 * 为什么需要它：加载页那根条有三层（真实字节 / 缓动 / 慢爬），本机几十毫秒就跑完，
 * 只有**慢网络**才看得见"冻在一个数上"。肉眼看动画没法复现，所以要采样。
 * 实测抓到过一次真凶：慢爬把显示值顶过目标 0.1% 后，缓动的往回拉项
 * （`(target - shown) * 0.16`）正好抵消慢爬，在「目标 + 0.1」形成死平衡 ——
 * 数字冻住，而动画循环还在跑（`ticks` 一直涨，`shown` 不动）。
 *
 * 用法（需要桥正在跑，且 Edge 已装）：
 *   node test/boot-probe.mjs http://127.0.0.1:3081/<密钥段>/ <PIN>
 *
 * 输出的每一行 = 一次采样：`<毫秒>  {boot 显示状态, fill 宽度, 文本, shown 动画值,
 * target 真实目标, ticks 帧计数, stuckMs 在这个目标上等了多久}`。
 * 结尾给一句结论（在等回包期间数字有没有动）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [urlArg, pinArg] = process.argv.slice(2)
if (urlArg === undefined || pinArg === undefined) {
	console.error('用法: node test/boot-probe.mjs <手机桥地址（含密钥段）> <PIN>')
	process.exit(2)
}
const url = urlArg.endsWith('/') ? urlArg : `${urlArg}/`
const pin = pinArg
const DEBUG_PORT = 9500 + Math.floor(Math.random() * 400)
const PROFILE_DIR = mkdtempSync(join(tmpdir(), 'dsh-bootprobe-'))

const login = await fetch(new URL('api/login', url), {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ pin }),
})
if (login.status !== 200) { console.error(`登录失败（PIN 对吗？）: ${login.status}`); process.exit(1) }
const token = ((login.headers.getSetCookie?.() ?? [])[0] ?? '').split(';')[0].split('=').slice(1).join('=')

const edge = spawn(EDGE, [
	'--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
	`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE_DIR}`, 'about:blank',
], { stdio: 'ignore' })

let wsUrl = ''
const deadline = Date.now() + 20000
while (Date.now() < deadline && wsUrl === '') {
	try {
		const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
		const page = list.find((entry) => entry.type === 'page')
		if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl
	} catch { /* not up yet */ }
	if (wsUrl === '') await new Promise((resolve) => setTimeout(resolve, 200))
}
if (wsUrl === '') { console.error('devtools 端点一直没起来'); edge.kill(); process.exit(1) }

const socket = new WebSocket(wsUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let nextId = 1
const pending = new Map()
socket.onmessage = (event) => {
	const message = JSON.parse(event.data)
	if (message.id !== undefined && pending.has(message.id)) {
		const { resolve, reject } = pending.get(message.id)
		pending.delete(message.id)
		if (message.error) reject(new Error(JSON.stringify(message.error)))
		else resolve(message.result)
	}
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++
	pending.set(id, { resolve, reject })
	socket.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'dshm', value: token, domain: '127.0.0.1', path: '/' })
// 把网络拖慢：否则本机几十毫秒就跑完，加载页根本来不及显示。4 秒延迟 ≈ 手机走隧道。
await send('Network.emulateNetworkConditions', {
	offline: false, latency: 4000, downloadThroughput: 40 * 1024, uploadThroughput: 40 * 1024,
})

const probe = `(() => {
	const boot = document.getElementById('boot')
	const fill = document.getElementById('bootFill')
	const text = document.getElementById('bootText')
	const readout = typeof window.__dshBoot === 'function' ? window.__dshBoot() : null
	return JSON.stringify({
		boot: boot ? getComputedStyle(boot).display : 'missing',
		fill: fill ? fill.style.width : 'missing',
		text: text ? text.textContent : 'missing',
		shown: readout ? readout.shown : null,
		target: readout ? readout.target : null,
		ticks: readout ? readout.ticks : null,
		stuckMs: readout ? readout.stuckMs : null,
	})
})()`

await send('Page.navigate', { url })
const t0 = Date.now()
const samples = []
for (let i = 0; i < 40; i += 1) {
	const out = await send('Runtime.evaluate', { expression: probe, returnByValue: true })
	const raw = out.result?.value ?? '{}'
	const at = Date.now() - t0
	samples.push({ at, ...JSON.parse(raw) })
	console.log(`${String(at).padStart(5)}ms  ${raw}`)
	if (samples[samples.length - 1].boot === 'none' && i > 3) break
	await new Promise((resolve) => setTimeout(resolve, 250))
}

// 结论只看"在等回包"的那段时间：目标没到 100、而且已经贴住目标（缓动收敛）之后，
// 数字还在不在动。这正是用户投诉的那一段。
const waiting = samples.filter((s) => s.target !== null && s.target < 100 && s.shown !== null && s.shown >= s.target - 0.5)
if (waiting.length >= 3) {
	const first = waiting[0]
	const last = waiting[waiting.length - 1]
	const moved = last.shown - first.shown
	const alive = last.ticks > first.ticks
	const pass = moved >= 0.3 && alive
	console.log(`\n结论：等回包期间 ${first.shown}% → ${last.shown}%（${((last.at - first.at) / 1000).toFixed(1)}s），` +
		`帧计数 ${first.ticks} → ${last.ticks} ⇒ ${pass ? 'PASS（一直在动）' : 'FAIL（数字冻住了）'}`)
	if (!pass) process.exitCode = 1
} else {
	console.log('\n结论：这次没抓到"贴住目标等回包"的窗口（网络不够慢或回包太快），换个时间再跑。')
}

edge.kill()
try { rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { /* 可能还被占着 */ }
