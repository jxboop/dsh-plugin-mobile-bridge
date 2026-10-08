/**
 * 输入框那一排键位的宽度体检（真浏览器，390×844 的手机视口）。
 *
 * 为什么值得单独一个脚本：一排里现在有五个键（图片/原图/生图/权限/发送或插话），
 * 每个键都"看着不宽"，加起来却能把输入框挤到只剩一条缝 —— 而这件事在 234 项
 * DOM 测试里看不出来（jsdom 不做布局），只有在真浏览器里量宽度才看得见。
 *
 *   node test/compose-bench.mjs <url> <pin>
 */

import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [url, pin] = process.argv.slice(2)
if (!url || !pin) {
	console.error('usage: node test/compose-bench.mjs <url> <pin>')
	process.exit(2)
}

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 500)
const PROFILE_DIR = join(tmpdir(), `dsh-compose-bench-${process.pid}`)
const width = 390
const height = 844

const base = url.endsWith('/') ? url : `${url}/`
const login = await fetch(new URL('api/login', base), {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ pin }),
})
if (login.status !== 200) { console.error('login failed', login.status); process.exit(1) }
const setCookie = (login.headers.getSetCookie?.() ?? [])[0] ?? ''
const token = setCookie.split(';')[0].split('=').slice(1).join('=')

const edge = spawn(EDGE, [
	'--headless=new',
	'--disable-gpu',
	'--hide-scrollbars',
	'--no-first-run',
	'--no-default-browser-check',
	`--remote-debugging-port=${DEBUG_PORT}`,
	`--user-data-dir=${PROFILE_DIR}`,
	'about:blank',
], { stdio: 'ignore' })

const deadline = Date.now() + 20000
let wsUrl = ''
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

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'dshm', value: token, domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, 3000))

const MEASURE = `(() => {
	const groups = {
		tools: ['pick', 'rawToggle', 'genBtn', 'permBtn'],
		compose: ['text', 'send', 'stop'],
	}
	const out = {}
	for (const [name, ids] of Object.entries(groups)) {
		const rows = new Map()
		const keys = {}
		for (const id of ids) {
			const node = document.getElementById(id)
			if (node === null) continue
			if (getComputedStyle(node).display === 'none') continue
			const box = node.getBoundingClientRect()
			keys[id] = { w: Math.round(box.width), top: Math.round(box.top) }
			const line = Math.round(box.top)
			if (!rows.has(line)) rows.set(line, [])
			rows.get(line).push(id)
		}
		out[name] = {
			keys,
			rows: [...rows.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]),
		}
	}
	out.width = Math.round(document.getElementById('composer').getBoundingClientRect().width)
	return JSON.stringify(out)
})()`

const report = (label, raw) => {
	const data = JSON.parse(raw)
	console.log(`${label}  (输入区宽 ${data.width}px)`)
	for (const [group, info] of Object.entries({ tools: data.tools, compose: data.compose })) {
		const lines = info.rows.length
		console.log(`  ${group}: ${lines === 1 ? '一行 ✔' : `${lines} 行 ✘`}`)
		for (const [index, ids] of info.rows.entries()) {
			const parts = ids.map((id) => `${id}=${info.keys[id].w}`)
			const sum = ids.reduce((total, id) => total + info.keys[id].w, 0)
			console.log(`    第${index + 1}行: ${parts.join('  ')}   → 合计 ${sum}px`)
		}
	}
	return data
}

console.log('页面错误:', await evaluate('JSON.stringify(window.__shotErrors ?? [])'))
const idle = report('空闲（发送键）', await evaluate(MEASURE))

// 运行中：发送键变「插话」，同时还多一个「停止」—— 最挤的那一幕。
await evaluate(`(() => {
	document.getElementById('compose').classList.add('two')
	document.getElementById('send').textContent = '插话'
	document.getElementById('stop').style.display = 'inline-block'
	return 1
})()`)
await new Promise((resolve) => setTimeout(resolve, 300))
const busy = report('运行中（插话+停止）', await evaluate(MEASURE))

console.log('空闲输入框宽:', idle.compose.keys.text?.w, 'px   运行中输入框宽:', busy.compose.keys.text?.w, 'px')
console.log('工具键那一排总宽:', Object.values(idle.tools.keys).reduce((total, key) => total + key.w, 0), 'px（换行即说明窄屏也放不下）')

socket.close()
edge.kill()
try { rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { /* still held */ }
process.exit(0)
