/**
 * 量一下"进插件"到底要多久（真浏览器 + 真桥）。
 *
 *   node tools/measure-boot.mjs <url> <pin>
 *
 * 报三个数：页面能看见（#app 显示）用了多久、对话有内容用了多久、这次开了几个接口请求。
 * 用来验证"加快加载"是不是真的快了，而不是凭感觉。
 *
 * ⚠️ 只动自己 spawn 出来的那个 Edge（隔离 profile + 随机端口），绝不按名字杀浏览器。
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9700 + Math.floor(Math.random() * 300)
const PROFILE = join(tmpdir(), `dsh-measure-${process.pid}`)
const [url, pin] = process.argv.slice(2)
if (!url || !pin) { console.error('usage: node tools/measure-boot.mjs <url> <pin>'); process.exit(2) }

const login = await fetch(new URL('api/login', url.endsWith('/') ? url : `${url}/`), {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ pin }),
})
if (login.status !== 200) { console.error('login failed', login.status); process.exit(1) }
const token = (login.headers.getSetCookie?.() ?? [])[0]?.split(';')[0]?.split('=').slice(1).join('=') ?? ''

const edge = spawn(EDGE, [
	'--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
	`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' })

let wsUrl = ''
const deadline = Date.now() + 20000
while (Date.now() < deadline && wsUrl === '') {
	try {
		const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
		const target = list.find((entry) => entry.type === 'page')
		if (target?.webSocketDebuggerUrl) wsUrl = target.webSocketDebuggerUrl
	} catch { /* 还没起来 */ }
	if (wsUrl === '') await new Promise((resolve) => setTimeout(resolve, 200))
}
if (wsUrl === '') { console.error('devtools 没起来'); edge.kill(); process.exit(1) }

const socket = new WebSocket(wsUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let nextId = 1
const pending = new Map()
const calls = []
socket.onmessage = (event) => {
	const message = JSON.parse(event.data)
	if (message.method === 'Network.requestWillBeSent') {
		const path = String(message.params?.request?.url ?? '').replace(/^https?:\/\/[^/]+/, '')
		calls.push(path)
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

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'dshm', value: token, domain: '127.0.0.1', path: '/' })

const started = Date.now()
await send('Page.navigate', { url })
const read = async (expression) => {
	const result = await send('Runtime.evaluate', { returnByValue: true, expression })
	return result.result?.value
}
let appAt = 0
let contentAt = 0
while (Date.now() - started < 30000) {
	if (appAt === 0 && (await read('(() => { const a = document.getElementById("app"); return !!a && getComputedStyle(a).display !== "none" })()')) === true) {
		appAt = Date.now() - started
	}
	if (appAt !== 0 && contentAt === 0 && (await read('(document.getElementById("log")||{}).textContent.length > 20 || false')) === true) {
		contentAt = Date.now() - started
		break
	}
	await new Promise((resolve) => setTimeout(resolve, 50))
}

const counts = calls.reduce((acc, path) => {
	const key = path.split('?')[0].replace(/\/[0-9a-f]{16}\//, '/')
	acc[key] = (acc[key] ?? 0) + 1
	return acc
}, {})
console.log(`界面可见: ${appAt === 0 ? '超时' : appAt + ' ms'}`)
console.log(`对话有内容: ${contentAt === 0 ? '超时' : contentAt + ' ms'}`)
console.log('这次打开的请求:')
for (const [path, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(2)}× ${path}`)

socket.close()
if (edge.pid !== undefined) spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 800))
try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* 占着就算了 */ }
process.exit(0)
