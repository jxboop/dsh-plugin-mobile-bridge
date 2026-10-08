/**
 * 给两个新面板拍照片（真浏览器 + 真点击）。
 *
 *   node test/panel-shot.mjs <url> <pin> [输出前缀]
 *
 * 产出 <前缀>-gen.png（生图面板）与 <前缀>-perm.png（权限面板）。
 * 截图脚本 shot.mjs 走的是"打开就拍"，看不到面板 —— 面板必须点出来。
 */

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [url, pin, prefix = 'panel'] = process.argv.slice(2)
if (!url || !pin) {
	console.error('usage: node test/panel-shot.mjs <url> <pin> [prefix]')
	process.exit(2)
}

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 500)
const PROFILE_DIR = join(tmpdir(), `dsh-panel-shot-${process.pid}`)

const base = url.endsWith('/') ? url : `${url}/`
const login = await fetch(new URL('api/login', base), {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ pin }),
})
if (login.status !== 200) { console.error('login failed', login.status); process.exit(1) }
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
	if (wsUrl === '') await new Promise((resolve) => setTimeout(resolve, 250))
}
if (wsUrl === '') { console.error('devtools endpoint never appeared'); edge.kill(); process.exit(1) }

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
const evaluate = async (expression) => {
	const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
	return result.result?.value
}
const shoot = async (path) => {
	const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
	await writeFile(path, Buffer.from(shot.data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'dshm', value: token, domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, 3500))

// 生图面板：填一句提示词，让预览里出现真正要发出去的那句话。
await evaluate(`(() => {
	document.getElementById('genBtn').click()
	const box = document.getElementById('genPrompt')
	box.value = 'a red apple on a white table, soft daylight, photo'
	box.dispatchEvent(new Event('input', { bubbles: true }))
	document.getElementById('genSeed').value = '12345'
	document.getElementById('genSeed').dispatchEvent(new Event('input', { bubbles: true }))
	document.querySelectorAll('#genopen .genopt')[1].click()
	return 1
})()`)
await new Promise((resolve) => setTimeout(resolve, 400))
await shoot(`${prefix}-gen.png`)
console.log('生图面板:', `${prefix}-gen.png`)

// 权限面板：默认就在放开档（角标是橙的），顺便把三档说明全拍进去。
await evaluate(`(() => {
	document.getElementById('genBack').click()
	document.getElementById('permBtn').click()
	return 1
})()`)
await new Promise((resolve) => setTimeout(resolve, 800))
console.log('权限面板状态:', await evaluate(`JSON.stringify({
	current: document.getElementById('permNow').textContent,
	options: [...document.querySelectorAll('#permopen .permopt')].map((node) => node.dataset.perm),
	apply: document.getElementById('permApply').textContent,
	badge: document.getElementById('composer').dataset.perm,
})`))
await shoot(`${prefix}-perm.png`)
console.log('权限面板:', `${prefix}-perm.png`)

socket.close()
edge.kill()
try { rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { /* still held */ }
process.exit(0)
