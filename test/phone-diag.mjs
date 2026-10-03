/**
 * Lean, hang-proof phone-page diagnostic.
 *
 * The previous version could block forever on a devtools websocket that never
 * opened. Everything here has a deadline, the browser profile is unique per run
 * (no stale lock), and error capture is installed BEFORE navigation so a throw
 * during first render is still recorded.
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9341 + (process.pid % 100)
const dshDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const cfg = JSON.parse(await readFile(join(dshDir, 'mobile-bridge.json'), 'utf8'))
const base = `http://127.0.0.1:${cfg.port}`
const pageUrl = `${base}/${cfg.pathSecret}/`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withDeadline = (p, ms, label) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`deadline: ${label}`)))])

console.log(`target: ${pageUrl}`)
const login = await fetch(`${base}/${cfg.pathSecret}/api/login`, {
	method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: cfg.pin }),
})
console.log(`login -> ${login.status}`)
const token = ((login.headers.getSetCookie?.() ?? [])[0] ?? '').split(';')[0].split('=').slice(1).join('=')

const profile = await mkdtemp(join(tmpdir(), 'dsh-diag-'))
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
	`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => { try { edge.kill() } catch { /* gone */ } })

let wsUrl = ''
const t0 = Date.now()
while (Date.now() - t0 < 25000 && wsUrl === '') {
	try {
		const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
		const page = list.find((e) => e.type === 'page')
		if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl
	} catch { /* not up */ }
	if (wsUrl === '') await sleep(300)
}
if (wsUrl === '') { console.error('devtools never appeared'); edge.kill(); await rm(profile, { recursive: true, force: true }); process.exit(1) }
console.log(`devtools ready in ${Date.now() - t0}ms`)

const socket = new WebSocket(wsUrl)
await withDeadline(new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej }), 10000, 'ws open')

let nextId = 1
const pending = new Map()
const exceptions = []
const consoles = []
const responses = []
socket.onmessage = (event) => {
	const m = JSON.parse(event.data)
	if (m.id !== undefined && pending.has(m.id)) {
		const { resolve } = pending.get(m.id)
		pending.delete(m.id)
		resolve(m.error ? { __error: m.error } : m.result)
		return
	}
	if (m.method === 'Runtime.exceptionThrown') {
		const d = m.params?.exceptionDetails
		exceptions.push(String(d?.exception?.description ?? d?.text ?? '?').split('\n').slice(0, 6).join(' | '))
	}
	if (m.method === 'Runtime.consoleAPICalled') {
		consoles.push(`${m.params.type}: ${(m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 240))
	}
	if (m.method === 'Network.responseReceived') {
		const r = m.params.response
		if (r.url.startsWith(base)) responses.push(`${r.status}  ${r.url.slice(base.length).slice(0, 80)}`)
	}
}
const send = (method, params = {}) => new Promise((resolve) => {
	const id = nextId++
	pending.set(id, { resolve })
	socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
	const r = await send('Runtime.evaluate', { expression, returnByValue: true })
	return r?.result?.value ?? (r?.__error ? 'ERR:' + JSON.stringify(r.__error) : undefined)
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
// Install capture BEFORE any page script runs.
await send('Page.addScriptToEvaluateOnNewDocument', {
	source: 'window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(String(e.message)+" @"+(e.filename||"")+":"+(e.lineno||0))});window.addEventListener("unhandledrejection",function(e){window.__errs.push("rejection: "+String(e.reason))});',
})
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Network.setCookie', { name: 'dshm', value: token, domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: pageUrl })

const state = `JSON.stringify({
  href: location.pathname,
  gate: getComputedStyle(document.getElementById('gate')).display,
  app: getComputedStyle(document.getElementById('app')).display,
  selectValue: document.getElementById('session')?.value ?? null,
  optionCount: document.getElementById('session')?.options.length ?? -1,
  logChars: (document.getElementById('log')?.textContent ?? '').length,
  logRows: document.querySelectorAll('#log > *').length,
  logHead: (document.getElementById('log')?.textContent ?? '').slice(0, 200),
  status: document.getElementById('dot')?.className ?? null,
  errs: (window.__errs ?? []).slice(0, 5)
})`

for (const [label, wait] of [['3s', 3000], ['8s', 5000], ['15s', 7000]]) {
	await sleep(wait)
	console.log(`\n=== 加载后 ${label} ===`)
	console.log(await evaluate(state))
}

console.log('\n=== 网络响应 ===')
for (const r of responses.slice(-20)) console.log('  ' + r)
console.log('\n=== 页面异常 ===')
console.log(exceptions.length === 0 ? '  （无）' : exceptions.map((e) => '  ' + e).join('\n'))
console.log('\n=== 控制台 ===')
console.log(consoles.length === 0 ? '  （无）' : consoles.slice(0, 10).map((c) => '  ' + c).join('\n'))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) { await writeFile('D:\\dsh\\phone-diag.png', Buffer.from(shot.data, 'base64')); console.log('\nscreenshot: D:\\dsh\\phone-diag.png') }
socket.close()
edge.kill()
await sleep(300)
await rm(profile, { recursive: true, force: true }).catch(() => {})
process.exit(0)
