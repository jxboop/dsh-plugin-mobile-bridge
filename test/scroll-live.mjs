/**
 * 在**真实流式输出**期间量"界面回弹"（真浏览器 + 真桥 + 真的一场回合）。
 *
 *   node test/scroll-live.mjs <url> <pin>
 *
 * 现场：发出一句话之后，界面像被光标钉住 —— 往上滑，过一会儿自己弹回底部。
 * 光看 jsdom 测不出来（没有布局、没有流式重排的时序），所以这里开一个**临时会话**，
 * 让它真的流式输出一段长文本，然后一边往上滚一边采样：
 *   * scrollTop 有没有被拉回底部；
 *   * scrollHeight / 子节点数有没有跳变（跳变 = 每帧重建 DOM，滚动位置自然被抢）；
 *   * 结束时报告"回弹了几次、最大位移"。
 *
 * 临时会话会留在会话列表里（名字带 [scroll-live]），跑完不再用它。
 * ⚠️ 只动自己 spawn 出来的那台 Edge（隔离 profile + 随机端口），绝不按名字杀浏览器。
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9600 + Math.floor(Math.random() * 90)
const PROFILE_DIR = join(tmpdir(), `dsh-scroll-live-${process.pid}`)
const [url, pin] = process.argv.slice(2)
if (!url || !pin) {
	console.error('usage: node test/scroll-live.mjs <url> <pin>')
	process.exit(2)
}

const base = url.endsWith('/') ? url : `${url}/`
const login = await fetch(new URL('api/login', base), {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ pin }),
})
if (login.status !== 200) { console.error('login failed', login.status); process.exit(1) }
const cookie = (login.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
const token = cookie.split('=').slice(1).join('=')
const post = async (path, body) => {
	const response = await fetch(new URL(path, base), {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify(body ?? {}),
	})
	return response.json().catch(() => ({}))
}

// 1) 开一个临时会话，让它流式输出一段长文本（不用工具，纯输出 → 连续 delta）
const created = await post('api/session', { cwd: process.cwd(), preset: 'default' })
const sessionId = created.sessionId
if (!sessionId) { console.error('创建会话失败', JSON.stringify(created)); process.exit(1) }
console.log(`scratch session: ${sessionId}`)
const prompt = '请把数字 1 到 1200 每行一个写出来，不要调用任何工具，直接输出正文。'
await post('api/prompt', { sessionId, text: prompt, images: [], files: [], mode: 'queue' })
console.log('prompt sent; waiting for the stream to start…')

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
// 直接开在这个临时会话上（页面从 localStorage 里读"上次那个会话"）
await send('Page.addScriptToEvaluateOnNewDocument', {
	source: `try { localStorage.setItem('dshm.session', ${JSON.stringify(sessionId)}) } catch (error) {}`,
})
await send('Page.navigate', { url })

// 2) 等页面连上、并且真的开始流式输出
const started = await evaluate(`(async () => {
	const log = document.getElementById('log')
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	for (let i = 0; i < 600; i += 1) {
		const cursor = log.querySelector('.cursor')
		if (cursor !== null && log.scrollHeight > log.clientHeight + 200) return 'streaming'
		await wait(100)
	}
	return 'timeout rows=' + log.children.length + ' scrollHeight=' + log.scrollHeight
})()`, true)
console.log(`stream: ${started}`)
if (started !== 'streaming') {
	socket.close()
	if (edge.pid !== undefined) spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
	process.exit(1)
}

// 3) 往上滚 200px，然后 15 秒内每 50ms 采样一次：位置有没有被拉回底部、主线程有没有卡顿
const report = await evaluate(`(async () => {
	const log = document.getElementById('log')
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	// 量主线程卡顿：rAF 之间的间隔超过 100ms 就算"卡了一下"（手机上表现为滚动被顶住）
	let maxGap = 0
	let last = performance.now()
	let running = true
	const frame = () => {
		const now = performance.now()
		maxGap = Math.max(maxGap, now - last)
		last = now
		if (running) requestAnimationFrame(frame)
	}
	requestAnimationFrame(frame)
	let longTasks = 0
	try {
		const observer = new PerformanceObserver((list) => { longTasks += list.getEntries().length })
		observer.observe({ entryTypes: ['longtask'] })
	} catch { /* 不支持就算了 */ }

	const samples = []
	// 先停在一个明确"不在底部"的位置（模拟用户往上翻）
	log.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }))
	log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight - 200)
	const parked = log.scrollTop
	log.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }))
	await wait(220)
	for (let i = 0; i < 300; i += 1) {
		samples.push({ top: Math.round(log.scrollTop), height: log.scrollHeight, rows: log.children.length, bottom: Math.round(log.scrollHeight - log.clientHeight - log.scrollTop) })
		await wait(50)
	}
	running = false
	const heights = samples.map((s) => s.height)
	const rows = samples.map((s) => s.rows)
	const bounced = samples.filter((s) => s.bottom < 8)
	return JSON.stringify({
		parked: Math.round(parked),
		minTop: Math.min(...samples.map((s) => s.top)),
		maxTop: Math.max(...samples.map((s) => s.top)),
		lastTop: samples[samples.length - 1].top,
		lastBottom: samples[samples.length - 1].bottom,
		bouncedSamples: bounced.length,
		heightRange: [Math.min(...heights), Math.max(...heights)],
		rowsRange: [Math.min(...rows), Math.max(...rows)],
		maxFrameGapMs: Math.round(maxGap),
		longTasks,
	})
})()`, true)
console.log(`bounce report: ${report}`)
const parsed = JSON.parse(report)
console.log(`verdict: ${parsed.bouncedSamples === 0 ? 'no bounce — the view stays where the reader put it' : `BOUNCED back to the bottom in ${parsed.bouncedSamples}/300 samples`}`)
console.log(`(scrollHeight ${parsed.heightRange[0]}–${parsed.heightRange[1]}，子节点 ${parsed.rowsRange[0]}–${parsed.rowsRange[1]}，最长掉帧 ${parsed.maxFrameGapMs}ms，longtask ${parsed.longTasks} 次)`)

socket.close()
if (edge.pid !== undefined) spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 800))
try { rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { /* 占着就算了 */ }
process.exit(parsed.bouncedSamples === 0 ? 0 : 1)
