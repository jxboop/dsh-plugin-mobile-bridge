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
	JSON.stringify({ version: 1, port: PORT, pin: '123456', answerOnPhone: true }),
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
/**
 * 记录插件注册的 waterfall 应答者，测试自己触发它们 —— 模拟 Cordis 的 dispatch。
 * 插件用 prepend 抢在官方 api-remotes 之前，所以这里只关心"登记了谁"。
 */
const waterfallListeners = new Map()
const ctx = {
	effect(callback) {
		const dispose = callback()
		disposers.push(dispose)
		return () => {}
	},
	get(name) { return services[name] },
	sessionController: stubController,
	on(name, listener) {
		if (!waterfallListeners.has(name)) waterfallListeners.set(name, [])
		waterfallListeners.get(name).push(listener)
		return () => {
			const list = waterfallListeners.get(name) ?? []
			const at = list.indexOf(listener)
			if (at >= 0) list.splice(at, 1)
		}
	},
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
// 每条路由都藏在一个随机密钥段后面（loadConfig 生成后写回本文件）。测试必须带上它：
// 少了这一段，所有 `${base}/api/...` 都会 404 —— 那正是这个 harness 曾经整份烂掉的原因
// （37 条断言全废，只因为 base 里没有这个前缀）。
const secret = `/${config.pathSecret}`
const base = `http://127.0.0.1:${config.port}${secret}`
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
await rawGet(`${secret}/api/bootstrap`, cookie, `${CABLE}:${config.port}`)
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
await rawGet(`${secret}/api/bootstrap`, cookie, `127.0.0.1:${config.port}`)
await new Promise((resolve) => setTimeout(resolve, 200))
const afterLoopback = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
check('a loopback Host is never remembered', afterLoopback.phoneHost === CABLE, String(afterLoopback.phoneHost ?? null))

/* --- 手机上回答提问 / 批准操作 ------------------------------------------- */
/*
 * agent 调 ask_user_question、或某个工具需要批准时，宿主会挂在 Cordis 的
 * waterfall 上等人类回答。官方 api-remotes 把它转发给浏览器；手机不搭那条通道，
 * 所以桥自己注册应答者：SSE 把问题推给【正在看这个会话】的手机，再用
 * POST /api/answer 把答案收回 waterfall。
 */

const askHandlers = waterfallListeners.get('user-questions/request') ?? []
const approveHandlers = waterfallListeners.get('approval/request') ?? []
check('注册了提问应答者（且只有一个）', askHandlers.length === 1, `${askHandlers.length}`)
check('注册了审批应答者（且只有一个）', approveHandlers.length === 1, `${approveHandlers.length}`)

/** 从一条 SSE 流里读到第一个 interaction 帧。 */
async function readInteraction(reader) {
	const decoder = new TextDecoder()
	let buffer = ''
	const deadline = Date.now() + 5000
	while (Date.now() < deadline) {
		const { value, done } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		const lines = buffer.split('\n')
		buffer = lines.pop() ?? ''
		for (const line of lines) {
			if (!line.startsWith('data: ')) continue
			const payload = JSON.parse(line.slice(6))
			if (payload.t === 'interaction') return payload
		}
	}
	return null
}

// 没有手机在看这个会话时必须【立刻】next()：桌面上的批准框不能因为我们而迟到。
{
	let delegated = false
	await askHandlers[0](
		{ agent: { id: 'nobody-is-watching' }, questions: [] },
		() => { delegated = true; return Promise.resolve({ answers: [] }) },
	)
	check('没有手机在看这个会话时，立刻交还桌面', delegated === true)
}

// 有手机在看：问题出现在 SSE 上，答案经 POST /api/answer 回到 waterfall。
{
	const stream = await fetch(`${base}/api/stream?sessionId=session-test`, authed)
	check('作答测试拿到了一条流', stream.status === 200, `HTTP ${stream.status}`)
	const reader = stream.body.getReader()

	const pendingAnswer = askHandlers[0](
		{
			agent: { id: 'session-test' },
			questions: [{
				id: 'q1',
				question: '用哪个方案？',
				header: '方案',
				options: [{ label: '甲', description: '快' }, { label: '乙' }],
			}],
		},
		() => Promise.resolve({ answers: [{ id: 'q1', selected: ['兜底'] }] }),
	)

	const frame = await readInteraction(reader)
	check('提问被推到了手机那条流上',
		frame !== null && frame.kind === 'question' && typeof frame.id === 'string' && frame.id !== '',
		JSON.stringify(frame)?.slice(0, 140))
	check('推送里带着问题与选项（前端要靠它渲染）',
		frame?.payload?.questions?.[0]?.question === '用哪个方案？'
		&& frame?.payload?.questions?.[0]?.options?.[0]?.label === '甲')
	check('推送里不含 agent（那是活对象，不能外发）', frame?.payload?.agent === undefined)

	const answered = await fetch(`${base}/api/answer`, {
		method: 'POST',
		headers: { cookie: authed.headers.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ id: frame?.id, answers: [{ id: 'q1', selected: ['乙'] }] }),
	})
	check('POST /api/answer 收下了答案', answered.status === 200, `HTTP ${answered.status}`)

	const resolved = await pendingAnswer
	check('waterfall 拿到的是手机选的答案，不是桌面的兜底',
		resolved?.answers?.[0]?.selected?.[0] === '乙', JSON.stringify(resolved))

	// 用过的 id 必须失效：否则同一张卡片能被答两次，第二次会写进一个已结束的回合。
	const replay = await fetch(`${base}/api/answer`, {
		method: 'POST',
		headers: { cookie: authed.headers.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ id: frame?.id, answers: [{ id: 'q1', selected: ['甲'] }] }),
	})
	check('同一个提问 id 不能重复作答', replay.status === 409, `HTTP ${replay.status}`)

	await reader.cancel().catch(() => {})
}

// 审批：只接受三个合法结果，凭空造的必须被拒。
{
	const stream = await fetch(`${base}/api/stream?sessionId=session-test`, authed)
	const reader = stream.body.getReader()

	const pendingApproval = approveHandlers[0](
		{ agent: { id: 'session-test' }, toolName: 'pwsh', reason: '要删文件' },
		() => Promise.resolve('rejected'),
	)

	const frame = await readInteraction(reader)
	check('审批被推到了手机上',
		frame?.kind === 'approval' && frame?.payload?.toolName === 'pwsh',
		JSON.stringify(frame)?.slice(0, 140))

	const bogus = await fetch(`${base}/api/answer`, {
		method: 'POST',
		headers: { cookie: authed.headers.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ id: frame?.id, outcome: 'yolo' }),
	})
	check('非法的审批结果被拒（不能凭空造 outcome）', bogus.status === 400, `HTTP ${bogus.status}`)

	const allowed = await fetch(`${base}/api/answer`, {
		method: 'POST',
		headers: { cookie: authed.headers.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ id: frame?.id, outcome: 'allowed-once' }),
	})
	check('合法的审批结果被接受', allowed.status === 200, `HTTP ${allowed.status}`)
	check('waterfall 拿到 allowed-once', (await pendingApproval) === 'allowed-once')

	await reader.cancel().catch(() => {})
}

// 手机刷新 / 重连时，还没答的提问必须【补推】。提问只在发生时推一次的话，
// 手机一刷新卡片就永远消失了，而宿主还挂在 waterfall 上等。
{
	const streamA = await fetch(`${base}/api/stream?sessionId=session-test`, authed)
	const readerA = streamA.body.getReader()

	const pendingQ = askHandlers[0](
		{ agent: { id: 'session-test' }, questions: [{ id: 'q9', question: '刷新后还看得到吗？' }] },
		() => Promise.resolve({ answers: [] }),
	)
	const first = await readInteraction(readerA)
	check('重推测试：第一次推送到达', first?.payload?.questions?.[0]?.id === 'q9',
		JSON.stringify(first)?.slice(0, 120))

	// 模拟"手机刷新"：开一条新流。
	const streamB = await fetch(`${base}/api/stream?sessionId=session-test`, authed)
	const readerB = streamB.body.getReader()
	const replay = await readInteraction(readerB)
	check('新开的流会补推还没答的提问（手机刷新不丢卡片）',
		replay?.id === first?.id && replay?.payload?.questions?.[0]?.id === 'q9',
		JSON.stringify(replay)?.slice(0, 120))

	// 收尾：答掉它，别让挂着的 waiter 影响后面的测试。
	await fetch(`${base}/api/answer`, {
		method: 'POST',
		headers: { cookie: authed.headers.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ id: first?.id, answers: [{ id: 'q9', selected: ['看得到'] }] }),
	})
	await pendingQ
	await readerA.cancel().catch(() => {})
	await readerB.cancel().catch(() => {})
}

// 请求被【取消】（agent 停了、会话结束）时不能去惊动桌面：那会弹出一个已经作废的
// 批准框，用户点了也毫无意义。取消和超时必须分开处理。
{
	const stream = await fetch(`${base}/api/stream?sessionId=session-test`, authed)
	const reader = stream.body.getReader()
	const controller = new AbortController()
	let delegated = false
	const pending = approveHandlers[0](
		{ agent: { id: 'session-test' }, toolName: 'pwsh', signal: controller.signal },
		() => { delegated = true; return Promise.resolve('rejected') },
	)
	const frame = await readInteraction(reader)
	check('取消测试：审批确实推到了手机', frame?.kind === 'approval', JSON.stringify(frame)?.slice(0, 100))
	controller.abort()
	const outcome = await pending
	check('请求被取消时不去惊动桌面（不弹作废的批准框）', delegated === false)
	check('取消时给出 cancelled 这个合法结果（调用方按不允许处理）',
		outcome === 'cancelled', String(outcome))
	await reader.cancel().catch(() => {})
}

/* --- surviving a restart ------------------------------------------------- */
/*
 * Tokens used to live only in the bridge's memory, so every `dsh web` restart
 * dropped the phone back to the PIN gate. Stopping and re-applying the plugin
 * in-process is the faithful reproduction: same files, brand-new state.
 */

const tokensFile = join(scratch, 'mobile-bridge.tokens.json')
let persistedTokens = {}
try { persistedTokens = JSON.parse(await readFile(tokensFile, 'utf8')).tokens ?? {} } catch { /* absent */ }
// 落盘的是 { expiresAt, ip } 对象（旧版本存的是裸数字，加载器两种都认）。
// 这里两种形态都接受，但必须断言"确实是一个未来时间"，否则格式再变一次测试会假过。
const issuedRecord = Object.values(persistedTokens)[0]
const issuedExpiry = typeof issuedRecord === 'number' ? issuedRecord : Number(issuedRecord?.expiresAt)
check('an issued token is written to disk',
	Object.keys(persistedTokens).length === 1 && Number.isFinite(issuedExpiry) && issuedExpiry > Date.now(),
	`${Object.keys(persistedTokens).length} token(s), expiresAt=${issuedExpiry}`)
check('the persisted token also records the address it was issued to',
	typeof issuedRecord === 'object' && issuedRecord !== null && typeof issuedRecord.ip === 'string',
	JSON.stringify(issuedRecord ?? null))

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

	// 恢复的会话故意【不提权】：读得到，但一动手必须重新证明是本人。服务器用
	// 403 + needPin 表达这件事 —— 不是 401，因为令牌本身完全有效。手机页面正是
	// 靠这个标志去打开 PIN 门的；契约一旦变成 401 或普通 403，用户就会被卡在
	// "提示要重输 PIN，却根本没有输入框"。
	const restartWrite = await fetch(`${base}/api/prompt`, {
		method: 'POST',
		headers: { cookie: authed.headers.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test', text: '重启后应当被拒', images: [] }),
	})
	const restartWriteBody = await restartWrite.json().catch(() => ({}))
	check('a restored session is readable but not elevated (403 + needPin, not 401)',
		restartWrite.status === 403 && restartWriteBody.needPin === true,
		`HTTP ${restartWrite.status} ${JSON.stringify(restartWriteBody)}`)
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
