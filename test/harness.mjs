/**
 * Offline harness for dsh-plugin-mobile-bridge.
 *
 * Runs the real plugin against a stub `sessionController`, so the whole HTTP
 * surface — PIN gate, cookie, bootstrap, prompt assembly, SSE fan-out, cancel —
 * is exercised without touching the live DSH process.
 *
 *   node test/harness.mjs
 *
 * It points DSH_HOME at a scratch directory so the real mobile-bridge.json
 * (and therefore the real PIN) is left alone.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = await mkdtemp(join(tmpdir(), 'dsh-mobile-bridge-'))
process.env.DSH_HOME = scratch

// Pin the port before the plugin loads. The real bridge already owns 3081;
// without this the harness would die on EADDRINUSE — or, worse, run its
// assertions against the live server and look green for the wrong reason.
const PORT = 31417
await writeFile(
	join(scratch, 'mobile-bridge.json'),
	JSON.stringify({ version: 1, port: PORT, pin: '123456' }),
	'utf8',
)

const { apply } = await import('../lib/index.js')

const STATE = { prompts: [], cancelled: [], followed: [], created: [] }

/* The plugin talks to api.deepseek.com through the global fetch; everything
   else on that name still goes to the real network so the harness can reach
   the listener it just started. */
const realFetch = globalThis.fetch
let balanceUpstreamCalls = 0
globalThis.fetch = (input, init) => {
	const url = typeof input === 'string' ? input : String(input?.url ?? input)
	if (url.startsWith('https://api.deepseek.com')) {
		balanceUpstreamCalls += 1
		return Promise.resolve(new Response(JSON.stringify({
			is_available: true,
			balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }],
		}), { status: 200, headers: { 'content-type': 'application/json' } }))
	}
	return realFetch(input, init)
}

function sessionStream(signal) {
	const snapshot = {
		type: 'snapshot',
		header: { version: 3, id: 'session-test', createdAt: Date.now(), isSeeded: false },
		cursor: 2,
		hasMore: false,
		records: [
			{ type: 'event', event: { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '下午好' }], source: { kind: 'user' } } } },
			{ type: 'event', event: { type: 'assistant/message', seq: 2, time: Date.now(), data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '在的' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: ['在的'] }] } } },
		],
		projections: { asOfSeq: 2, values: {} },
	}
	return (async function* () {
		yield snapshot
		yield { type: 'event', event: { type: 'tool/call', seq: 3, time: Date.now(), data: { turn: 1, step: 2, callId: 'call-1', name: 'read', arguments: '{"file_path":"a.txt"}' } } }
		yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: '正在处理…' } } }
		yield {
			type: 'event',
			event: {
				type: 'assistant/message',
				seq: 4,
				time: Date.now(),
				data: {
					turn: 1,
					step: 2,
					message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: '看完了' }], source: { kind: 'model', provider: 'p', model: 'm' } },
					stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [1, 2], texts: ['看', '完了'] }],
				},
			},
		}
		await new Promise((resolve) => {
			if (signal.aborted) return resolve()
			signal.addEventListener('abort', resolve, { once: true })
		})
	})()
}

const stubController = {
	async list() {
		return {
			items: [
				{ sessionId: 'session-test', updatedAt: Date.now(), running: false, blank: false, cwd: 'D:\\learn\\deepseek学习', projections: { asOfSeq: 2, values: { title: '手机桥接测试' } } },
				{ sessionId: 'session-blank', updatedAt: Date.now() - 5000, running: false, blank: true, cwd: 'D:\\tool' },
			],
		}
	},
	async prompt(request) {
		STATE.prompts.push(request)
		return { accepted: true }
	},
	async cancel(request) {
		STATE.cancelled.push(request)
		return { accepted: true }
	},
	async attachment() {
		return { attachment: { mediaType: 'image/png' }, data: 'iVBORw0KGgo=' }
	},
	async create(request) {
		STATE.created.push(request)
		return { sessionId: 'session-created-1', agentPreset: request.agentPreset }
	},
	follow(request, signal) {
		STATE.followed.push(request)
		return sessionStream(signal)
	},
}

const services = {
	workspaceRegistry: {
		list: () => [
			{ id: 'ws-1', title: 'deepseek学习', path: 'D:\\learn\\deepseek学习' },
			{ id: 'ws-2', title: '皇室', path: 'D:\\tool\\皇室' },
		],
	},
	agentPresets: {
		list: async () => [
			{ id: 'default', name: '默认' },
			{ id: 'video', name: '视频' },
			{ id: 'rotten', name: '坏掉的预设', broken: 'composition file is missing' },
		],
	},
	credentials: {
		resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-test-0123456789', source: 'test' } : undefined),
	},
}

const disposers = []
const ctx = {
	effect(callback) {
		const dispose = callback()
		disposers.push(dispose)
		return () => {}
	},
	get(name) { return services[name] },
	sessionController: stubController,
}

// apply() starts the listener asynchronously; wait for the socket to accept
// rather than for a file to exist, or the first fetch races the listener.
apply(ctx)

async function waitForPort(port) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const open = await new Promise((resolve) => {
			const socket = net.connect({ port, host: '127.0.0.1' })
			socket.once('connect', () => { socket.destroy(); resolve(true) })
			socket.once('error', () => { socket.destroy(); resolve(false) })
		})
		if (open) return true
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	return false
}

if (!await waitForPort(PORT)) {
	console.error(`harness: nothing listening on ${PORT}`)
	process.exit(1)
}

const config = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
const base = `http://127.0.0.1:${config.port}`
const results = []
const check = (name, ok, detail = '') => {
	results.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

let cookie = ''

const pageResponse = await fetch(`${base}/`)
const pageHtml = await pageResponse.text()
check('GET / serves the phone page', pageResponse.status === 200 && pageHtml.includes('DSH 手机端'))
check('the page forbids caching outright',
	/no-store/.test(pageResponse.headers.get('cache-control') ?? '') && pageResponse.headers.get('pragma') === 'no-cache',
	`${pageResponse.headers.get('cache-control')} / ${pageResponse.headers.get('pragma')}`)

// The tag is what lets a phone that stayed open across a server restart notice
// its UI is stale. If the marker ever ships unreplaced, that detection breaks
// silently — hence an explicit assertion rather than trusting the replace().
const pageTag = (/<meta name="dsh-page-tag" content="([^"]+)"/.exec(pageHtml) ?? [])[1]
check('the served page carries a real page tag, not the marker',
	typeof pageTag === 'string' && pageTag !== '__DSH_PAGE_TAG__' && /^[0-9a-f]{12}$/.test(pageTag),
	String(pageTag))

const guarded = await fetch(`${base}/api/bootstrap`)
check('unauthenticated API is refused', guarded.status === 401)

const badPin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '000000' }) })
check('wrong PIN is refused', badPin.status === 401)

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: config.pin }) })
cookie = (login.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
check('correct PIN issues a session cookie', login.status === 200 && cookie.startsWith('dshm='))

const authed = { headers: { cookie } }
const bootstrap = await (await fetch(`${base}/api/bootstrap`, authed)).json()
check('bootstrap lists sessions with titles', bootstrap.sessions?.length === 2 && bootstrap.sessions[0].title === '手机桥接测试',
	JSON.stringify(bootstrap.sessions?.map((item) => item.title)))
check('bootstrap titles fall back to the folder name', bootstrap.sessions?.[1]?.title === 'tool', bootstrap.sessions?.[1]?.title)
check('bootstrap advertises the same page tag', bootstrap.pageTag === pageTag, `${bootstrap.pageTag} vs ${pageTag}`)

const promptResponse = await fetch(`${base}/api/prompt`, {
	method: 'POST',
	headers: { cookie, 'content-type': 'application/json' },
	body: JSON.stringify({
		sessionId: 'session-test',
		text: '这张图里是什么？',
		images: [{ mediaType: 'image/jpeg', data: 'AAAA', name: 'photo.jpg' }],
	}),
})
const promptBody = await promptResponse.json()
const sent = STATE.prompts[0]
check('prompt is accepted', promptResponse.status === 200 && promptBody.accepted === true, JSON.stringify(promptBody))
check('prompt carries text then image in order',
	Array.isArray(sent?.content) && sent.content[0]?.type === 'text' && sent.content[1]?.type === 'image' && sent.content[1]?.mediaType === 'image/jpeg',
	JSON.stringify(sent?.content))
check('prompt uses queue mode and a fresh request id', sent?.mode === 'queue' && typeof sent?.requestId === 'string' && sent.requestId.length > 0)

const badImage = await fetch(`${base}/api/prompt`, {
	method: 'POST',
	headers: { cookie, 'content-type': 'application/json' },
	body: JSON.stringify({ sessionId: 'session-test', images: [{ mediaType: 'application/pdf', data: 'AAAA' }] }),
})
check('non-image media type is rejected', badImage.status === 400, String(badImage.status))

const stream = await fetch(`${base}/api/stream?sessionId=session-test`, authed)
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let raw = ''
const deadline = Date.now() + 5000
while (Date.now() < deadline) {
	const { value, done } = await reader.read()
	if (done) break
	raw += decoder.decode(value, { stream: true })
	if (raw.includes('"type":"assistant/message"')) break
}
await reader.cancel().catch(() => {})

const frames = raw.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
const snapshot = frames.find((frame) => frame.t === 'snapshot')
const toolEvent = frames.find((frame) => frame.t === 'event' && frame.event?.type === 'tool/call')
const assistantEvent = frames.find((frame) => frame.t === 'event' && frame.event?.type === 'assistant/message')
const delta = frames.find((frame) => frame.t === 'delta')
check('SSE opens with a snapshot', snapshot?.records?.length === 2, `${snapshot?.records?.length} records`)
check('every stream open carries the page tag, so a reconnect can self-heal',
	snapshot?.tag === pageTag, `${snapshot?.tag} vs ${pageTag}`)
check('SSE forwards durable events', toolEvent?.event?.data?.name === 'read', JSON.stringify(toolEvent?.event?.data?.name))
check('SSE strips the redundant stream field',
	assistantEvent?.event?.data?.message?.content?.[0]?.text === '看完了' && assistantEvent.event.data.stream === undefined,
	`stream=${JSON.stringify(assistantEvent?.event?.data?.stream)} keys=${JSON.stringify(Object.keys(assistantEvent?.event?.data ?? {}))}`)
check('SSE forwards live deltas', delta?.frame?.chunk?.type === 'text-delta', JSON.stringify(delta?.frame?.chunk))
check('follow was asked for assistant stream frames', STATE.followed[0]?.assistantStream === true && STATE.followed[0]?.address?.sessionId === 'session-test')

const attachment = await (await fetch(`${base}/api/attachment?sessionId=session-test&attachmentId=att-1`, authed)).json()
check('attachment proxy returns base64', attachment.data === 'iVBORw0KGgo=')

await fetch(`${base}/api/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-test' }) })
check('cancel reaches the controller', STATE.cancelled[0]?.sessionId === 'session-test')

/* --- workspaces and presets (the "new task" screen) ----------------------- */

const workspaceBody = await (await fetch(`${base}/api/workspaces`, authed)).json()
check('workspaces are listed with id, title and path',
	workspaceBody.workspaces?.length === 2 && workspaceBody.workspaces[0].path === 'D:\\learn\\deepseek学习',
	JSON.stringify(workspaceBody.workspaces))
check('a broken preset is withheld from the picker',
	workspaceBody.presets?.length === 2 && workspaceBody.presets.every((preset) => preset.id !== 'rotten'),
	JSON.stringify(workspaceBody.presets?.map((preset) => preset.id)))

const createResponse = await fetch(`${base}/api/session`, {
	method: 'POST',
	headers: { cookie, 'content-type': 'application/json' },
	body: JSON.stringify({ workspaceId: 'ws-2', agentPreset: 'video' }),
})
const createBody = await createResponse.json()
check('creating a session forwards workspace and preset',
	createResponse.status === 200 && STATE.created[0]?.workspaceId === 'ws-2' && STATE.created[0]?.agentPreset === 'video',
	JSON.stringify(STATE.created[0]))
check('creating a session returns the new id', createBody.sessionId === 'session-created-1')

const emptyCreate = await fetch(`${base}/api/session`, {
	method: 'POST',
	headers: { cookie, 'content-type': 'application/json' },
	body: JSON.stringify({}),
})
check('creating without a destination is refused', emptyCreate.status === 400, String(emptyCreate.status))

const cwdCreate = await fetch(`${base}/api/session`, {
	method: 'POST',
	headers: { cookie, 'content-type': 'application/json' },
	body: JSON.stringify({ cwd: 'D:\\tmp\\scratch' }),
})
await cwdCreate.json()
check('a hand-typed path is forwarded as cwd',
	STATE.created[1]?.cwd === 'D:\\tmp\\scratch' && STATE.created[1]?.workspaceId === undefined,
	JSON.stringify(STATE.created[1]))

/* --- balance ------------------------------------------------------------- */

const balance = await (await fetch(`${base}/api/balance`, authed)).json()
check('the balance endpoint is reachable from the phone', balance.ok === true, JSON.stringify(balance.reason ?? 'ok'))
check('balance entries are normalized to numbers',
	balance.balances?.[0]?.total === 12.34 && balance.balances[0].granted === 2 && balance.balances[0].toppedUp === 10.34,
	JSON.stringify(balance.balances?.[0]))
check('the key itself never leaves the host',
	JSON.stringify(balance).includes('sk-test-0123456789') === false)
check('the official top-up page is advertised',
	typeof balance.topUpUrl === 'string' && balance.topUpUrl.startsWith('https://platform.deepseek.com'),
	balance.topUpUrl)

const callsAfterFirst = balanceUpstreamCalls
const cachedBalance = await (await fetch(`${base}/api/balance`, authed)).json()
check('a second read is served from cache', cachedBalance.cached === true && balanceUpstreamCalls === callsAfterFirst,
	`upstream calls: ${callsAfterFirst} -> ${balanceUpstreamCalls}`)

const refreshed = await (await fetch(`${base}/api/balance?refresh=1`, authed)).json()
check('an explicit refresh goes upstream again',
	refreshed.cached === false && balanceUpstreamCalls === callsAfterFirst + 1,
	`upstream calls: ${balanceUpstreamCalls}`)

/* --- learning which address a phone actually used ------------------------- */
/*
 * `fetch` strips a caller-supplied Host (it is a forbidden header), so this
 * goes through the core http client — which is also the honest simulation,
 * since a browser really does send the address it dialled.
 */
function rawGet(path, cookie, host) {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port: config.port, path, method: 'GET', headers: { cookie, host } }, (res) => {
			res.resume()
			res.on('end', () => resolve(res.statusCode))
		})
		req.on('error', reject)
		req.end()
	})
}

const CABLE = '172.20.10.2'
await rawGet('/api/bootstrap', cookie, `${CABLE}:${config.port}`)
await new Promise((resolve) => setTimeout(resolve, 250))
const learned = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
check('the address a phone reached us on is remembered from the Host header',
	learned.phoneHost === CABLE, JSON.stringify(learned.phoneHost ?? null))

const withHost = await (await fetch(`${base}/api/bootstrap`, authed)).json()
check('bootstrap reports the remembered address', withHost.phoneHost === CABLE, String(withHost.phoneHost))
check('bootstrap reports labelled candidates, not bare strings',
	typeof withHost.addresses?.[0]?.url === 'string' && withHost.addresses[0].url.startsWith('http://'),
	JSON.stringify(withHost.addresses?.[0] ?? null))

// A loopback Host must never stick: it would advertise an address no phone can
// reach, and would then outrank the real one forever.
await rawGet('/api/bootstrap', cookie, `127.0.0.1:${config.port}`)
await new Promise((resolve) => setTimeout(resolve, 200))
const afterLoopback = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
check('a loopback Host is never remembered', afterLoopback.phoneHost === CABLE, String(afterLoopback.phoneHost ?? null))

/* --- surviving a restart ------------------------------------------------- */
/*
 * Tokens used to live only in the bridge's memory, so every `dsh web` restart
 * dropped the phone back to the PIN gate. Stopping and re-applying the plugin
 * in-process is the faithful reproduction: same files, brand-new state.
 */

const tokensFile = join(scratch, 'mobile-bridge.tokens.json')
let persistedTokens = {}
try { persistedTokens = JSON.parse(await readFile(tokensFile, 'utf8')).tokens ?? {} } catch { /* absent */ }
check('an issued token is written to disk',
	Object.keys(persistedTokens).length === 1 && Object.values(persistedTokens)[0] > Date.now(),
	`${Object.keys(persistedTokens).length} token(s)`)

// Regression: stopping the plugin ends every open SSE response, and `res.write`
// on an ended response emits an 'error' event rather than throwing. An unhandled
// one takes the whole Node process down — which is how a plugin reload (and any
// phone that closes the page mid-stream) used to kill the running DSH.
const crashes = []
const onCrash = (error) => crashes.push(error)
process.on('uncaughtException', onCrash)

const openStream = await fetch(`${base}/api/stream?sessionId=session-test`, authed)
const openReader = openStream.body.getReader()
await openReader.read()
await new Promise((resolve) => setTimeout(resolve, 200))

disposers[0]?.()
await new Promise((resolve) => setTimeout(resolve, 600))
check('stopping with a stream open does not crash the process',
	crashes.length === 0, crashes.map((error) => error.code ?? error.message).join(' | '))
process.removeListener('uncaughtException', onCrash)
await openReader.cancel().catch(() => {})

apply(ctx)

if (!await waitForPort(PORT)) {
	check('the bridge comes back up after a restart', false, 'nothing listening')
} else {
	check('the bridge comes back up after a restart', true)
	const afterRestart = await fetch(`${base}/api/bootstrap`, authed)
	check('a phone stays logged in across a server restart',
		afterRestart.status === 200, `HTTP ${afterRestart.status}`)
}

const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } })
const afterLogout = await fetch(`${base}/api/bootstrap`, authed)
check('logout revokes the cookie', logout.status === 200 && afterLogout.status === 401)

// persistTokens() writes without awaiting, so give the disk write a moment.
await new Promise((resolve) => setTimeout(resolve, 150))
const afterLogoutTokens = JSON.parse(await readFile(tokensFile, 'utf8')).tokens ?? {}
check('logout also clears the token on disk', Object.keys(afterLogoutTokens).length === 0,
	`${Object.keys(afterLogoutTokens).length} token(s) left`)

for (const dispose of disposers) { try { dispose?.() } catch { /* ignore */ } }
await new Promise((resolve) => setTimeout(resolve, 200))

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
