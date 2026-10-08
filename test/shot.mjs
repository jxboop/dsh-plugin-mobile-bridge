/**
 * Screenshot the phone page in a real browser, authenticated.
 *
 *   node shot.mjs <url> <pin> <out.png> [width] [height] [waitMs] [clickSelector]
 *
 * Launches headless Edge with CDP, mints a session token through the bridge's
 * own login endpoint, plants it as a cookie, then captures the rendered page at
 * a phone viewport. Cookie planting avoids driving the PIN form, which would
 * make every capture a different length.
 *
 * `clickSelector` (optional) clicks one element by selector before capturing —
 * that is how you capture the screen *behind* a first-run sheet like #welcomeGo.
 *
 * ⚠️ 这个脚本只允许动**它自己 spawn 出来的那个 Edge**（`edge.kill()`）。
 *
 * 血的教训：为了清掉"卡住的旧实例"，曾经在截图前跑过
 * `Get-Process msedge | Stop-Process -Force` —— 那句话把**用户正在用的浏览器窗口
 * 也一起杀了**，而且每截一次图就杀一次（现象是"我的浏览器窗口隔一会儿就自己消失"，
 * 隔壁那个排查脚本为此盯了一整晚的进程树）。
 *
 * 现在改成：**每次运行都用独立临时 profile + 随机调试端口**，跑完只删自己那份，
 * 于是根本不需要去杀任何进程。任何人想"顺手清一下浏览器"之前，先读这段。
 */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
// 随机调试端口：固定端口时，前一次留下的 Edge 还没退出，这一次就会连上【上一次那个
// 页面】去截图 —— 明明点了「开始使用」，截出来的还是说明页，看起来像功能坏了。
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 500)
// 每次独立的临时 profile：既不会和用户自己的浏览器抢单例，也不会读到上一次的缓存。
const PROFILE_DIR = join(tmpdir(), `dsh-shot-${process.pid}`)
// 顺手扫掉自己以前留下的临时 profile（只认 dsh-shot-* 这个前缀，且必须超过一小时，
// 免得误删正在跑的那一份）。Edge 刚被杀时文件还被占着，收尾那一下经常删不掉。
try {
	for (const name of readdirSync(tmpdir())) {
		if (name.startsWith('dsh-shot-') === false) continue
		const stale = join(tmpdir(), name)
		try {
			if (Date.now() - statSync(stale).mtimeMs > 3600_000) rmSync(stale, { recursive: true, force: true })
		} catch { /* 占着就下次再说 */ }
	}
} catch { /* tmpdir 读不到也无所谓 */ }
const [url, pin, out, widthArg, heightArg, waitArg, clickArg] = process.argv.slice(2)
if (!url || !pin || !out) {
	console.error('usage: node shot.mjs <url> <pin> <out.png> [w] [h] [waitMs]')
	process.exit(2)
}
const width = Number(widthArg ?? 390)
const height = Number(heightArg ?? 844)
const waitMs = Number(waitArg ?? 5000)

/* ------------------------------------------------------------- login */

// 页面藏在随机密钥段后面（形如 https://host/<secret>/），所有接口都在那个段之下。
// 必须用【相对】地址解析：`new URL('/api/login', url)` 的前导斜杠会回到站点根目录，
// 把密钥段丢掉 → 线上必然 404（这正是这个脚本一直跑不通的原因）。
// 补一个尾斜杠，让相对解析落进密钥段。
const base = url.endsWith('/') ? url : `${url}/`
const login = await fetch(new URL('api/login', base), {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ pin }),
})
if (login.status !== 200) { console.error('login failed', login.status); process.exit(1) }
const setCookie = (login.headers.getSetCookie?.() ?? [])[0] ?? ''
const token = setCookie.split(';')[0].split('=').slice(1).join('=')

/* -------------------------------------------------------------- cdp */

const edge = spawn(EDGE, [
	'--headless=new',
	'--disable-gpu',
	'--hide-scrollbars',
	// 别抢"默认浏览器"、别跑首次运行向导：无头实例安安静静地来、安安静静地走。
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

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'dshm', value: token, domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, waitMs))

// Surface any uncaught page error: a blank shot is usually a JS crash.
const problems = await send('Runtime.evaluate', {
	expression: 'JSON.stringify(window.__shotErrors ?? [])',
	returnByValue: true,
})
console.log(`page errors: ${problems.result?.value ?? '[]'}`)
const title = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
const visible = await send('Runtime.evaluate', {
	expression: '(() => { const a=document.getElementById("app"), g=document.getElementById("gate"); return JSON.stringify({ app: a && getComputedStyle(a).display, gate: g && getComputedStyle(g).display, log: document.getElementById("log")?.textContent.length ?? -1 }) })()',
	returnByValue: true,
})
console.log(`title: ${title.result?.value}  state: ${visible.result?.value}`)

// Horizontal overflow is invisible in a screenshot that is itself clipped, so
// measure it: the widest offenders, by how far past the viewport they reach.
const measured = await send('Runtime.evaluate', {
	returnByValue: true,
	expression: `(() => {
		const log = document.getElementById('log')
		const limit = document.documentElement.clientWidth
		const offenders = []
		for (const el of document.querySelectorAll('body *')) {
			const box = el.getBoundingClientRect()
			if (box.width === 0 && box.height === 0) continue
			if (box.right > limit + 1 || box.width > limit + 1) {
				offenders.push({
					sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').join('.') : ''),
					width: Math.round(box.width), right: Math.round(box.right),
				})
			}
		}
		offenders.sort((a, b) => b.right - a.right)
		return JSON.stringify({
			viewport: limit,
			docScrollWidth: document.documentElement.scrollWidth,
			bodyScrollWidth: document.body.scrollWidth,
			log: log ? { client: log.clientWidth, scroll: log.scrollWidth } : null,
			offenders: offenders.slice(0, 10),
			offenderCount: offenders.length,
		})
	})()`,
})
console.log(`layout: ${measured.result?.value}`)

// 页面现在的渲染是增量的（只动变化的那一条），这里量的仍然是"整段 innerHTML 重建"
// 要花多少 —— 留作参考：增量渲染省掉的就是这个开销，也正因为不再每帧重排，
// 滚动位置才不会被重置。
const cost = await send('Runtime.evaluate', {
	returnByValue: true,
	expression: `(() => {
		const log = document.getElementById('log')
		const rows = log.children.length
		const nodes = log.querySelectorAll('*').length
		const htmlKB = Math.round(log.innerHTML.length / 1024)
		const imgs = log.querySelectorAll('img').length
		const saved = log.innerHTML
		const t0 = performance.now()
		for (let i = 0; i < 5; i += 1) log.innerHTML = saved
		const perFrame = (performance.now() - t0) / 5
		return JSON.stringify({ rows, nodes, htmlKB, imgs, fullRebuildMs: Math.round(perFrame * 10) / 10 })
	})()`,
})
console.log(`dom: ${cost.result?.value}`)

/*
 * 滚动体检：手机上报的是"界面定在一处、拖了又弹回原处、看不到消息"，这一项直接量
 * 三件事 —— 能不能滚到顶/底、消息行有没有被 content-visibility 拿去估算高度
 * （估算 = scrollHeight 说谎 = 位置乱跳）、以及一次真实重取之后读者的位置还在不在。
 */
const scrollProbe = await send('Runtime.evaluate', {
	returnByValue: true,
	awaitPromise: true,
	expression: `(async () => {
		const log = document.getElementById('log')
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
		const rowOf = (el) => (el && el.closest ? el.closest('#log > *') : null)
		const topText = () => {
			const rect = log.getBoundingClientRect()
			const row = rowOf(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 24))
			return row ? (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30) : ''
		}
		log.scrollTop = 0
		await wait(80)
		const top = Math.round(log.scrollTop)
		log.scrollTop = log.scrollHeight
		await wait(80)
		const bottomGap = Math.round(log.scrollHeight - log.scrollTop - log.clientHeight)
		// 停在中间，然后走一遍真实路径（可见性变化 → 重取对话 → 重绘），看位置有没有被抢。
		log.scrollTop = Math.max(0, Math.round(log.scrollHeight * 0.35))
		await wait(120)
		const before = { top: Math.round(log.scrollTop), text: topText() }
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
		document.dispatchEvent(new Event('visibilitychange'))
		await wait(1200)
		const after = { top: Math.round(log.scrollTop), text: topText() }
		const row = document.querySelector('#log .row')
		const tool = document.querySelector('#log .tool')
		return JSON.stringify({
			top, bottomGap,
			rowContentVisibility: row ? getComputedStyle(row).contentVisibility : null,
			toolContentVisibility: tool ? getComputedStyle(tool).contentVisibility : null,
			before, after,
			held: before.text !== '' && after.text === before.text && Math.abs(after.top - before.top) < 40,
		})
	})()`,
})
console.log(`scroll: ${scrollProbe.result?.value}`)

// Which style each speaker actually got, read from computed styles rather than
// from the markup's intent.
const speakers = await send('Runtime.evaluate', {
	returnByValue: true,
	expression: `(() => {
		const seen = {}
		for (const row of document.querySelectorAll('#log .row')) {
			const bubble = row.querySelector('.bubble')
			if (!bubble) continue
			const key = (row.classList.contains('user') ? 'user' : 'assistant') + '|' + getComputedStyle(bubble).backgroundColor
			seen[key] = (seen[key] ?? 0) + 1
		}
		const kinds = {}
		for (const el of document.querySelectorAll('#log > *')) {
			const k = el.className || el.tagName.toLowerCase()
			kinds[k] = (kinds[k] ?? 0) + 1
		}
		return JSON.stringify({ speakers: seen, rowKinds: kinds })
	})()`,
})
console.log(`speakers: ${speakers.result?.value}`)

// 可选：截图前点一下某个元素（例如首次说明页的「开始使用」），用来拍它背后那一屏。
if (clickArg !== undefined && clickArg !== '') {
	const clicked = await send('Runtime.evaluate', {
		returnByValue: true,
		expression: `(() => {
			const el = document.querySelector(${JSON.stringify(clickArg)})
			if (!el) return 'missing ' + ${JSON.stringify(clickArg)}
			el.click()
			return 'clicked ' + ${JSON.stringify(clickArg)}
		})()`,
	})
	console.log(`click: ${clicked.result?.value}`)
	await new Promise((resolve) => setTimeout(resolve, 1200))
	const after = await send('Runtime.evaluate', {
		returnByValue: true,
		expression: '(() => { const a=document.getElementById("app"); const w=document.getElementById("welcome"); return JSON.stringify({ app: a && getComputedStyle(a).display, welcome: w && getComputedStyle(w).display, welcomeSeen: (() => { try { return localStorage.getItem("dshm.welcomed") } catch { return "n/a" } })() }) })()',
	})
	console.log(`after click: ${after.result?.value}`)
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(out, Buffer.from(shot.data, 'base64'))
console.log(`saved ${out}`)

socket.close()
// 只结束【自己 spawn 出来的那棵树】：Edge 会派生子进程，node 的 kill() 只杀父进程，
// 所以按 PID 连子树一起清（taskkill /T）。
//
// 绝对不要写 `Stop-Process -Name msedge` / `taskkill /IM msedge.exe` —— 那是**按名字**
// 杀，会把用户正在用的浏览器窗口一起关掉。这条注释是拿一晚上的排查换来的。
if (edge.pid !== undefined) {
	const killer = spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
	await new Promise((resolve) => killer.on('exit', resolve))
} else {
	edge.kill()
}
// 只清自己这次用的临时 profile；用户自己的浏览器数据一个字节都不碰。
try { rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { /* 可能还被占着 */ }
process.exit(0)
