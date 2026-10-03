/**
 * Screenshot the phone page in a real browser, authenticated.
 *
 *   node shot.mjs <url> <pin> <out.png> [width] [height] [waitMs]
 *
 * Launches headless Edge with CDP, mints a session token through the bridge's
 * own login endpoint, plants it as a cookie, then captures the rendered page at
 * a phone viewport. Cookie planting avoids driving the PIN form, which would
 * make every capture a different length.
 */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9333
const [url, pin, out, widthArg, heightArg, waitArg] = process.argv.slice(2)
if (!url || !pin || !out) {
	console.error('usage: node shot.mjs <url> <pin> <out.png> [w] [h] [waitMs]')
	process.exit(2)
}
const width = Number(widthArg ?? 390)
const height = Number(heightArg ?? 844)
const waitMs = Number(waitArg ?? 5000)

/* ------------------------------------------------------------- login */

const login = await fetch(new URL('/api/login', url), {
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
	`--remote-debugging-port=${DEBUG_PORT}`,
	`--user-data-dir=${process.env.TEMP}\\dsh-shot-profile`,
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

// What the page actually pays on every streaming frame: it rebuilds the whole
// transcript with innerHTML, so measure that exact operation.
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
		return JSON.stringify({ rows, nodes, htmlKB, imgs, innerHTMLRebuildMs: Math.round(perFrame * 10) / 10 })
	})()`,
})
console.log(`dom: ${cost.result?.value}`)

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

const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(out, Buffer.from(shot.data, 'base64'))
console.log(`saved ${out}`)

socket.close()
edge.kill()
process.exit(0)
