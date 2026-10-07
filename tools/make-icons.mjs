/**
 * 生成「添加到主屏幕」要用的图标（PNG）。
 *
 *   node tools/make-icons.mjs
 *
 * 为什么要它：iOS 的「添加到主屏幕」只认 **PNG** 的 apple-touch-icon（SVG 不认），
 * 而库里不想为了几个图标引入图形依赖。于是用本机 Edge 的 canvas 画好再导出 ——
 * 和 test/shot.mjs 同一套 CDP 手法，只是把截图换成 toDataURL。
 *
 * ⚠️ 和 shot.mjs 一样：**只动自己 spawn 出来的那个 Edge**，绝不按名字杀浏览器。
 */
import { spawnSync, spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'lib', 'icons')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9600 + Math.floor(Math.random() * 300)
const PROFILE = join(tmpdir(), `dsh-icons-${process.pid}`)

/** 图标本身：冰蓝渐变 + 一台手机 + 一条"桥"的弧线。 */
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
<defs>
	<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
		<stop offset="0%" stop-color="#7fd4ff"/>
		<stop offset="55%" stop-color="#4a86ff"/>
		<stop offset="100%" stop-color="#1d3fb8"/>
	</linearGradient>
	<linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
		<stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
		<stop offset="100%" stop-color="#dfeaff" stop-opacity="0.75"/>
	</linearGradient>
</defs>
<rect width="512" height="512" rx="112" fill="url(#g)"/>
<rect x="170" y="96" width="172" height="300" rx="34" fill="url(#s)"/>
<rect x="196" y="132" width="120" height="16" rx="8" fill="#3a63d8" opacity="0.55"/>
<rect x="196" y="164" width="86" height="14" rx="7" fill="#3a63d8" opacity="0.35"/>
<rect x="196" y="330" width="120" height="34" rx="17" fill="#2f6ee0" opacity="0.85"/>
<path d="M92 300 C 150 210, 362 210, 420 300" stroke="#ffffff" stroke-opacity="0.85" stroke-width="18" fill="none" stroke-linecap="round"/>
<circle cx="92" cy="300" r="22" fill="#ffffff"/>
<circle cx="420" cy="300" r="22" fill="#ffffff"/>
</svg>`

const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0b1220">
<script>
window.render = (svg, size) => new Promise((resolve, reject) => {
	const image = new Image()
	image.onload = () => {
		const canvas = document.createElement('canvas')
		canvas.width = size
		canvas.height = size
		canvas.getContext('2d').drawImage(image, 0, 0, size, size)
		resolve(canvas.toDataURL('image/png'))
	}
	image.onerror = () => reject(new Error('svg load failed'))
	image.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
})
</script></body>`

async function main() {
	mkdirSync(OUT_DIR, { recursive: true })
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
		if (wsUrl === '') await new Promise((resolve) => setTimeout(resolve, 250))
	}
	if (wsUrl === '') { console.error('devtools 没起来'); edge.kill(); process.exit(1) }

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
	await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page) })
	await new Promise((resolve) => setTimeout(resolve, 600))

	const targets = [
		{ name: 'icon-180.png', size: 180 },
		{ name: 'icon-192.png', size: 192 },
		{ name: 'icon-512.png', size: 512 },
	]
	for (const target of targets) {
		const result = await send('Runtime.evaluate', {
			awaitPromise: true,
			returnByValue: true,
			expression: `window.render(${JSON.stringify(svg(512))}, ${target.size})`,
		})
		const dataUrl = String(result.result?.value ?? '')
		if (dataUrl.startsWith('data:image/png;base64,') === false) {
			console.error('渲染失败:', target.name, dataUrl.slice(0, 80)); continue
		}
		const bytes = Buffer.from(dataUrl.split(',')[1], 'base64')
		writeFileSync(join(OUT_DIR, target.name), bytes)
		console.log(`  ${target.name}  ${target.size}×${target.size}  ${(bytes.length / 1024).toFixed(1)} KB`)
	}

	socket.close()
	if (edge.pid !== undefined) spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
	try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* 占着就算了 */ }
	console.log('图标写到', OUT_DIR)
}

main().catch((error) => { console.error('FAILED', error); process.exit(1) })
