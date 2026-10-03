/**
 * Diagnose the phone page in a real browser.
 *
 * Unlike shot.mjs this one:
 *   - builds URLs from the configured secret path (the old hard-coded absolute
 *     `/api/login` silently 404s once the bridge moved behind a prefix),
 *   - records Runtime.exceptionThrown / console output and every network response,
 *     so "blank" can be told apart from "threw before it drew anything",
 *   - then clicks into a session and reports what #log holds afterwards.
 *
 *   node phone-diag.mjs
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9334
const dshDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const cfg = JSON.parse(await readFile(join(dshDir, 'mobile-bridge.json'), 'utf8'))
const base = `http://127.0.0.1:${cfg.port}`
const pageUrl = `${base}/${cfg.pathSecret}/`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log(`target: ${pageUrl}`)

const login = await fetch(`${base}/${cfg.pathSecret}/api/login`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ pin: cfg.pin }),
})
console.log(`login -> ${login.status}`)
const setCookie = (login.headers.getSetCookie?.() ?? [])[0] ?? ''
const token = setCookie.split(';')[0].split('=').slice(1).join('=')
console.log(`token length: ${token.length}`)
if (login.status !== 200) process.exit(1)

const edge = spawn(EDGE, [
	'--headless=new', '--disable-gpu', '--hide-scrollbars',
	`--remote-debugging-port=${PORT}`,
	`--user-data-dir=${process.env.TEMP}\\dsh-diag-profile`,
	'about:blank',
], { stdio: 'ignore' })

let wsUrl = ''
const deadline = Date.now() + 20000
while (Date.now() < deadline && wsUrl === '') {
	try {
		const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
		const page = list.find((e) => e.type === 'page')
		if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl
	} catch { /* not up */ }
	if (wsUrl === '') await sleep(250)
}
if (wsUrl === '') { console.error('devtools never appeared'); edge.kill(); process.exit(1) }

const socket = new WebSocket(wsUrl)
await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej })

let nextId = 1
const pending = new Map()
const exceptions = []
const consoles = []
const responses = []
socket.onmessage = (event) => {
	const m = JSON.parse(event.data)
	if (m.id !== undefined && pending.has(m.id)) {
		const { resolve, reject } = pending.get(m.id)
		pending.delete(m.id)
		if (m.error) reject(new Error(JSON.stringify(m.error)))
		else resolve(m.result)
		return
	}
	if (m.method === 'Runtime.exceptionThrown') {
		const d = m.params?.exceptionDetails
		exceptions.push(`${d?.exception?.description ?? d?.text ?? 'unknown'}`.split('\n').slice(0, 4).join(' | '))
	}
	if (m.method === 'Runtime.consoleAPICalled') {
		consoles.push(`${m.params.type}: ${(m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 200))
	}
	if (m.method === 'Network.responseReceived') {
		const r = m.params.response
		if (r.url.startsWith(base)) responses.push(`${r.status} ${r.url.slice(base.length)}`)
	}
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++
	pending.set(id, { resolve, reject })
	socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'dshm', value: token, domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: pageUrl })
await sleep(7000)

const stateOf = `JSON.stringify({
  href: location.href,
  title: document.title,
  gate: (() => { const g = document.getElementById('gate'); return g ? getComputedStyle(g).display : null })(),
  app: (() => { const a = document.getElementById('app'); return a ? getComputedStyle(a).display : null })(),
  viewTask: (() => { const v = document.getElementById('view-task'); return v ? getComputedStyle(v).display : null })(),
  logLen: (document.getElementById('log')?.textContent ?? '').length,
  logRows: document.querySelectorAll('#log > *').length,
  logHead: (document.getElementById('log')?.textContent ?? '').slice(0, 240),
  heading: document.getElementById('heading')?.textContent ?? null,
  banner: document.getElementById('banner')?.textContent ?? null,
  toast: document.getElementById('toast')?.textContent ?? null,
  tabs: (document.getElementById('tabs')?.textContent ?? '').slice(0, 60)
})`

console.log('\n=== 进入页面 7 秒后 ===')
console.log(await evaluate(stateOf))

console.log('\n=== 页面尝试点击第一个会话 ===')
const clicked = await evaluate(`(() => {
  const cands = [...document.querySelectorAll('#log [data-id], #log .row, #log .item, #log button, #log a')]
  if (cands.length === 0) return 'no candidate in #log'
  const first = cands[0]
  first.click()
  return 'clicked: ' + first.tagName + '.' + first.className + ' | ' + (first.textContent || '').slice(0, 60)
})()`)
console.log(clicked)
await sleep(8000)
console.log('\n=== 点击后 ===')
console.log(await evaluate(stateOf))

console.log('\n=== 网络请求 ===')
for (const r of responses.slice(-25)) console.log('  ' + r)

console.log('\n=== 页面异常 ===')
if (exceptions.length === 0) console.log('  （无）')
for (const e of exceptions.slice(0, 10)) console.log('  ' + e)

console.log('\n=== 控制台输出 ===')
if (consoles.length === 0) console.log('  （无）')
for (const c of consoles.slice(0, 15)) console.log('  ' + c)

const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile('phone-diag.png', Buffer.from(shot.data, 'base64'))
console.log('\nscreenshot: phone-diag.png')

socket.close()
edge.kill()
process.exit(0)
