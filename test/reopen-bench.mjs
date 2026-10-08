/**
 * 量"从别的窗口点回来"要多久（真浏览器 + 真桥 + 真实的慢网络）。
 *
 *   node test/reopen-bench.mjs <url> <pin>
 *
 * 现场：切到别的 App 再点回来，页面被系统回收重开，于是又是加载页 + 重下整段对话。
 * 现在手机上留着一份对话现场（IndexedDB；写不进去就退到 localStorage），回来先把它
 * 铺上，再去后台补新的那几条。所以这里量两个时刻：
 *   * 对话出现（本地那份铺上）—— 应该**不受网络影响**；
 *   * 界面显示出来（等 /api/boot 的 200，那是鉴权）—— 这一段受网络影响，
 *     但它已经是"一次小请求 + 只补差量"，不是"整段下载"。
 *
 * 为了让"不受网络影响"可验证，第二次加载前用 CDP 把网络延迟拉到 2 秒。
 *
 * ⚠️ 只动自己 spawn 出来的那台 Edge（隔离 profile + 随机端口），绝不按名字杀浏览器。
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9800 + Math.floor(Math.random() * 90)
const PROFILE_DIR = join(tmpdir(), `dsh-reopen-${process.pid}`)
const [url, pin] = process.argv.slice(2)
if (!url || !pin) {
	console.error('usage: node test/reopen-bench.mjs <url> <pin>')
	process.exit(2)
}

const base = url.endsWith('/') ? url : `${url}/`
const login = await fetch(new URL('api/login', base), {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ pin }),
})
if (login.status !== 200) { console.error('login failed', login.status); process.exit(1) }
const token = (login.headers.getSetCookie?.() ?? [])[0]?.split(';')[0]?.split('=').slice(1).join('=') ?? ''

const edge = spawn(EDGE, [
	'--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
	`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE_DIR}`, 'about:blank',
], { stdio: 'ignore' })

let wsUrl = ''
const deadline = Date.now() + 20000
while (Date.now() < deadline && wsUrl === '') {
	try {
		const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
		const target = list.find((entry) => entry.type === 'page')
		if (target?.webSocketDebuggerUrl) wsUrl = target.webSocketDebuggerUrl
	} catch { /* 还没起来 */ }
	if (wsUrl === '') await new Promise((resolve) => setTimeout(resolve, 200))
}
if (wsUrl === '') { console.error('devtools did not come up'); edge.kill(); process.exit(1) }

const socket = new WebSocket(wsUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let nextId = 1
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++
	pending.set(id, { resolve, reject })
	socket.send(JSON.stringify({ id, method, params }))
})
socket.onmessage = (event) => {
	const message = JSON.parse(event.data)
	if (message.id !== undefined && pending.has(message.id)) {
		const { resolve, reject } = pending.get(message.id)
		pending.delete(message.id)
		if (message.error) reject(new Error(JSON.stringify(message.error)))
		else resolve(message.result)
	}
}
const evaluate = async (expression, awaitPromise = false) => {
	const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
	return result.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'dshm', value: token, domain: '127.0.0.1', path: '/' })

/** 在页面里插一个计时器：记录"对话区第一次有内容"和"#app 第一次可见"的时刻。 */
const ARM = `(() => {
	window.__timing = { content: null, shown: null, started: performance.now() }
	const log = document.getElementById('log')
	const app = document.getElementById('app')
	const tick = () => {
		const t = performance.now() - window.__timing.started
		if (window.__timing.content === null && log !== null && log.querySelector('.row, .tool, .deliver, .think') !== null) window.__timing.content = Math.round(t)
		if (window.__timing.shown === null && app !== null && getComputedStyle(app).display !== 'none') window.__timing.shown = Math.round(t)
		if (window.__timing.content === null || window.__timing.shown === null) requestAnimationFrame(tick)
	}
	requestAnimationFrame(tick)
	return true
})()`

/** 换新文档前先注入计时器（新页面一开始就跑）。 */
const ARM_EARLY = `(() => {
	window.__timing = { content: null, shown: null, started: performance.now() }
	const tick = () => {
		const log = document.getElementById('log')
		const app = document.getElementById('app')
		const t = performance.now() - window.__timing.started
		if (window.__timing.content === null && log !== null && log.querySelector('.row, .tool, .deliver, .think') !== null) window.__timing.content = Math.round(t)
		if (window.__timing.shown === null && app !== null && getComputedStyle(app).display !== 'none') window.__timing.shown = Math.round(t)
		requestAnimationFrame(tick)
	}
	requestAnimationFrame(tick)
	return true
})()`

await send('Page.navigate', { url })
await evaluate(ARM, true).catch(() => {})
// 第一次：等首屏就绪，并让页面把这份对话存到手机上
const ready = await evaluate(`(async () => {
	const log = document.getElementById('log')
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	for (let i = 0; i < 300; i += 1) {
		if (log.querySelector('.row, .tool, .deliver, .think') !== null) break
		await wait(50)
	}
	// 触发一次 visibilitychange=hidden → 页面会立刻把现场写进本地
	document.dispatchEvent(new Event('visibilitychange'))
	await wait(600)
	return log.children.length
})()`, true)
console.log(`first load: ${ready} rows in the transcript (snapshot saved to the device)`)

// 第二次：把网络延迟拉到 2 秒（模拟慢隧道），然后重新加载页面
await send('Network.emulateNetworkConditions', { offline: false, latency: 2000, downloadThroughput: 200 * 1024, uploadThroughput: 200 * 1024 })
await send('Page.addScriptToEvaluateOnNewDocument', { source: ARM_EARLY })
const reloaded = send('Page.reload', { ignoreCache: false })
await reloaded
await new Promise((resolve) => setTimeout(resolve, 9000))
const timing = await evaluate('JSON.stringify(window.__timing ?? null)')
console.log(`second load (2s network latency): ${timing}`)
const parsed = timing === null ? null : JSON.parse(timing)
if (parsed !== null) {
	console.log(`transcript visible after: ${parsed.content === null ? 'timeout' : parsed.content + ' ms'}`)
	console.log(`app revealed after:      ${parsed.shown === null ? 'timeout' : parsed.shown + ' ms'}`)
	console.log(`verdict: ${parsed.content !== null && parsed.content < 400 ? 'the conversation is on screen before the network round trip finishes' : 'still waits for the network'}`)
}

socket.close()
if (edge.pid !== undefined) spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 800))
try { rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { /* 占着就算了 */ }
process.exit(0)
