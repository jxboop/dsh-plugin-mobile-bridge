/**
 * 量"切会话"到底要多久（真浏览器 + 真桥）。
 *
 *   node test/switch-bench.mjs <url> <pin>
 *
 * 现场：手机上"换到别的对话再回来又要加载，而且很慢"。原因有两个，都要量出来：
 *   1. 切走时把内容清空了 → 切回来是**一片空白**，得等下载完才看得到；
 *   2. 每次切换都重下整段对话（实测 43 KB gzip；隧道上一个来回好几秒）。
 * 这个脚本量三件事：
 *   * 切到没打开过的会话：多久才有内容（老路径，得等下载）；
 *   * 切回刚看过的会话：**切完那一刻**画面上有没有内容（现在应该"秒开"）；
 *   * 切回去这一步真实下载了多少字节（增量应该只有几十字节）。
 *
 * ⚠️ 只动自己 spawn 出来的那台 Edge（隔离 profile + 随机端口），绝不按名字杀浏览器。
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9900 + Math.floor(Math.random() * 90)
const PROFILE_DIR = join(tmpdir(), `dsh-switch-${process.pid}`)
const [url, pin] = process.argv.slice(2)
if (!url || !pin) {
	console.error('usage: node test/switch-bench.mjs <url> <pin>')
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
/** 每个请求落到哪个接口，以及它真实下载了多少字节（encodedDataLength 已经是压缩后的）。 */
const tracked = new Map()
const bytes = new Map()
const transcriptBytes = () => [...bytes.entries()].filter(([path]) => path.startsWith('/api/transcript')).reduce((sum, [, n]) => sum + n, 0)
socket.onmessage = (event) => {
	const message = JSON.parse(event.data)
	if (message.method === 'Network.responseReceived') {
		const path = String(message.params?.response?.url ?? '').replace(/^https?:\/\/[^/]+/, '').split('?')[0]
		tracked.set(message.params.requestId, path)
	}
	if (message.method === 'Network.loadingFinished') {
		const path = tracked.get(message.params.requestId)
		if (path !== undefined) bytes.set(path, (bytes.get(path) ?? 0) + (message.params.encodedDataLength ?? 0))
	}
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
const evaluate = async (expression, awaitPromise = false) => {
	const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
	return result.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'dshm', value: token, domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url })

/**
 * 页面里的量法：改下拉框 → 同步读一次"有没有内容" → 再每 25ms 看一次，记下第一次有的时刻。
 *
 * 判"有没有内容"用真实的内容节点，不用文本：空会话的占位提示是 `.note`，
 * 而"正在读取会话内容…"这句话本身就出现在对话正文里（这个插件自己的会话就是）。
 */
const measureSwitch = (sessionId) => `(async () => {
	const log = document.getElementById('log')
	const select = document.getElementById('session')
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	select.value = ${JSON.stringify(sessionId)}
	const started = performance.now()
	select.dispatchEvent(new Event('change'))
	const hasContent = () => log.querySelector('.row, .tool, .deliver, .think') !== null
	const immediate = hasContent()
	let at = null
	for (let i = 0; i < 400; i += 1) {
		if (hasContent()) { at = Math.round(performance.now() - started); break }
		await wait(25)
	}
	await wait(200)
	return JSON.stringify({ at, immediate, rows: log.children.length })
})()`

const first = await evaluate(`(async () => {
	const log = document.getElementById('log')
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	for (let i = 0; i < 300; i += 1) {
		if (log.querySelector('.row, .tool, .deliver, .think') !== null) return 'ready'
		await wait(50)
	}
	return 'timeout'
})()`, true)
console.log(`first paint: ${first}`)

const sessions = JSON.parse(await evaluate(`JSON.stringify([...document.getElementById('session').options].map((o) => o.value))`))
const current = sessions[0]
const untouched = sessions.find((id) => id !== current)
if (untouched === undefined) { console.error('only one session, nothing to switch to'); edge.kill(); process.exit(1) }

// 1) 切到"没打开过"的会话：老路径，必须等下载
const coldBase = transcriptBytes()
const cold = JSON.parse(await evaluate(measureSwitch(untouched), true))
const coldBytes = transcriptBytes() - coldBase
console.log(`switch to an untouched session: content after ${cold.at === null ? 'timeout' : cold.at + ' ms'} (immediate=${cold.immediate}), downloaded ${coldBytes} bytes`)

// 2) 切回来：现在应该"切完那一刻就有内容"，且几乎不下载
const warmBase = transcriptBytes()
const warm = JSON.parse(await evaluate(measureSwitch(current), true))
const warmBytes = transcriptBytes() - warmBase
console.log(`switch back to the session just seen: immediate=${warm.immediate}${warm.immediate ? ' (instant)' : ' (waited ' + warm.at + ' ms)'}, downloaded ${warmBytes} bytes`)
console.log(`verdict: ${warm.immediate ? 'no reload on switch-back (0 full downloads)' : 'still waits on switch-back'}`)

socket.close()
if (edge.pid !== undefined) spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 800))
try { rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { /* 占着就算了 */ }
process.exit(0)
