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

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
// 背景：真文件放在上传目录里，配置指过去 —— 和用户自己挑一段 .mov 的路径一样。
const BACKDROP_BYTES = Buffer.from('FAKEMOV-0123456789')
await mkdir(join(scratch, 'mobile-uploads'), { recursive: true })
await writeFile(join(scratch, 'mobile-uploads', 'bg.mov'), BACKDROP_BYTES)
await writeFile(
	join(scratch, 'mobile-bridge.json'),
	JSON.stringify({ version: 1, port: PORT, pin: '123456', answerOnPhone: true, backgroundFile: 'bg.mov' }),
	'utf8',
)

const { apply } = await import('../lib/index.js')

const STATE = { prompts: [], cancelled: [], followed: [], created: [], queueMutations: [] }

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

/**
 * 一段【巨型】历史的替身：单条工具输出 500 KB。
 * 真实事故：聊了几小时的会话日志 9.7 MB，`maxMessages: 40` 展开成 195 条记录、
 * 979 KB —— 手机上（尤其走隧道时）根本传不完，一断线又从头再传，用户看到的
 * 就是永远停在"正在读取会话内容…"。桥必须把它压到预算内再发。
 */
function hugeStream() {
	const huge = 'x'.repeat(500 * 1024)
	const records = []
	// 80 条：光靠"截断超长文本"还是装不下（80 × 4 KB ≈ 320 KB > 240 KB 预算），
	// 必须再丢掉最旧的记录 —— 这才走到了 hasMore 那条分支。
	for (let index = 0; index < 80; index += 1) {
		records.push({
			type: 'event',
			event: {
				type: 'tool/result', seq: index + 1, time: Date.now(),
				data: { turn: 1, step: index, message: { id: `h${index}`, role: 'user', content: [{ type: 'tool-result', toolCallId: `c${index}`, content: [{ type: 'text', text: huge }] }] } },
			},
		})
	}
	return (async function* () {
		yield { type: 'snapshot', header: { version: 3, id: 'session-huge', createdAt: Date.now(), isSeeded: false }, cursor: records.length, hasMore: false, records, projections: { asOfSeq: records.length, values: {} } }
	})()
}

/**
 * 一条 assistant/message，它的 `data.stream` 里装着这条消息已经逐字推过的全部增量。
 *
 * 这是最容易漏掉的一种"大"：**一堆短字符串**，不是超长文本，所以按 4000 字截断的
 * 逻辑对它完全无效。实测能让 /api/transcript 回 782 KB —— 正好把这个接口存在的
 * 理由（别让手机收到大包）又踩回去。
 */
function streamyStream() {
	const stream = []
	for (let index = 0; index < 200000; index += 1) stream.push('x')
	const records = [
		{ type: 'event', event: { type: 'user/message', seq: 1, time: Date.now(), data: { id: 's0', role: 'user', content: [{ type: 'text', text: '开始' }] } } },
		{
			type: 'event',
			event: {
				type: 'assistant/message', seq: 2, time: Date.now(),
				data: { turn: 1, step: 1, message: { id: 's1', role: 'assistant', content: [{ type: 'text', text: '好' }] }, stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: stream }] },
			},
		},
	]
	return (async function* () {
		yield { type: 'snapshot', header: { version: 3, id: 'session-streamy', createdAt: Date.now(), isSeeded: false }, cursor: records.length, hasMore: false, records, projections: { asOfSeq: records.length, values: {} } }
	})()
}

function sessionStream(signal) {	const snapshot = {
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

/** 会话列表（测试中途可增删：子会话过滤那一条要靠它）。 */
const listItems = [
	{ sessionId: 'session-test', updatedAt: Date.now(), running: false, blank: false, cwd: 'D:\\learn\\deepseek学习', projections: { asOfSeq: 2, values: { title: '手机桥接测试' } } },
	{ sessionId: 'session-blank', updatedAt: Date.now() - 5000, running: false, blank: true, cwd: 'D:\\tool' },
]

const stubController = {
	async list() {
		return { items: listItems }
	},
	async prompt(request) {
		STATE.prompts.push(request)
		// 真宿主的图片解码器啃不动多帧图 —— 手机发来的**动图**就是这么被拒的。
		// 桩里复现这一条，才能钉住"被拒之后改成存文件再发一次"那条退路。
		const frames = Array.isArray(request?.content) ? request.content : []
		if (frames.some((entry) => entry?.type === 'image' && entry?.mediaType === 'image/gif')) {
			throw new Error('image decode failed: animated gif is not supported')
		}
		return { accepted: true }
	},
	async cancel(request) {
		STATE.cancelled.push(request)
		return { accepted: true }
	},
	/** 撤回排队消息就走它：`{kind:'remove'}`。桩里记下来，好断言参数对不对。 */
	async updateQueue(request) {
		STATE.queueMutations.push(request)
		if (request?.itemId === 'already-started') {
			throw new Error('session/queue-item-not-found: queued item is no longer pending')
		}
		return { ok: true }
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
		if (request?.address?.sessionId === 'session-huge') return hugeStream()
		if (request?.address?.sessionId === 'session-streamy') return streamyStream()
		// 子会话（agent 自己派生的）不能用 {kind:'session'} 地址跟随，宿主会这么拒绝。
		if (request?.address?.sessionId === 'session-subagent') {
			throw new Error('subagent Sessions require their durable parent address')
		}
		return sessionStream(signal)
	},
}

/** installBadge 通过 webServer.tapIndex 注册的 HTML 变换函数。 */
let badgeTap = null

const services = {
	// 桌面角标靠 webServer.tapIndex 注入。以前 harness 里没有这个服务，于是
	// installBadge 整个走不到 —— 一个作用域写错（模块级函数里用了 createBridge
	// 内的 record()）就让 start() 抛错：角标消失、隧道自检永不启动，
	// 而当时 236 条测试全绿。给个假的把它覆盖上。
	webServer: {
		tapIndex: (transform) => { badgeTap = transform; return () => { badgeTap = null } },
	},
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

/* --- 「开始使用」说明页只该弹一次（服务端也记一份） ---------------------- */
/*
 * 现场：手机上每次退出重进都弹一遍说明页。页面自己用 localStorage 记，但换地址
 * （Funnel ↔ 局域网是不同 origin，各存各的）、无痕浏览、清了站点数据之后标记就没了。
 * 所以宿主也记一份，并且跟令牌文件一起落盘。
 */
{
	check('没看过之前 bootstrap 说 welcomed=false', bootstrap.welcomed === false, String(bootstrap.welcomed))
	const seen = await fetch(`${base}/api/welcomed`, { method: 'POST', headers: { cookie } })
	check('点「开始使用」会写回宿主', seen.status === 200, String(seen.status))
	const after = await (await fetch(`${base}/api/bootstrap`, authed)).json()
	check('之后 bootstrap 说 welcomed=true（页面据此不再弹）', after.welcomed === true, String(after.welcomed))
	const stored = JSON.parse(await readFile(join(scratch, 'mobile-bridge.tokens.json'), 'utf8'))
	check('这份标记跟着令牌文件落盘（重载/重启也不丢）',
		Object.keys(stored.welcomed ?? {}).length > 0, JSON.stringify(stored.welcomed))
}

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
check('prompt 把 requestId 回给手机（手机靠它对上排队条目、给出撤回）',
	promptBody.requestId === sent?.requestId, `${promptBody.requestId} vs ${sent?.requestId}`)

// 手机可以自带 requestId（重试用同一个）：宿主对同 id 幂等，重试不会变两条。
{
	const retry = await fetch(`${base}/api/prompt`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test', text: '重试同一条', requestId: 'client-retry-1' }),
	})
	const retryBody = await retry.json()
	check('手机带 requestId 时用它（重试幂等，不会变成两条）',
		retry.status === 200 && retryBody.requestId === 'client-retry-1'
		&& STATE.prompts.at(-1)?.requestId === 'client-retry-1',
		JSON.stringify(retryBody))
	const bogus = await fetch(`${base}/api/prompt`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test', text: 'x', requestId: '../evil' }),
	})
	const bogusBody = await bogus.json()
	check('非法 requestId 被丢掉、改用宿主自己生成的',
		bogus.status === 200 && bogusBody.requestId !== '../evil' && String(bogusBody.requestId).length > 8,
		String(bogusBody.requestId))
}

/* --- 撤回：把还没开始处理的那条从队列里拿掉 ----------------------------- */
{
	const ok = await fetch(`${base}/api/recall`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test', itemId: 'queue-item-1' }),
	})
	const okBody = await ok.json()
	const mutation = STATE.queueMutations[0]
	check('撤回真的调到了宿主的 updateQueue(remove)',
		ok.status === 200 && okBody.ok === true
		&& mutation?.sessionId === 'session-test' && mutation?.itemId === 'queue-item-1'
		&& mutation?.action?.kind === 'remove',
		JSON.stringify(mutation))

	const tooLate = await fetch(`${base}/api/recall`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test', itemId: 'already-started' }),
	})
	const tooLateBody = await tooLate.json()
	check('已经开始处理的撤不回来：409 + 人话（不假装成功）',
		tooLate.status === 409 && tooLateBody.error.includes('撤不回来'), `${tooLate.status} ${JSON.stringify(tooLateBody)}`)

	const bad = await fetch(`${base}/api/recall`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test' }),
	})
	check('撤回缺 itemId 给 400', bad.status === 400, String(bad.status))
}

const badImage = await fetch(`${base}/api/prompt`, {
	method: 'POST',
	headers: { cookie, 'content-type': 'application/json' },
	body: JSON.stringify({ sessionId: 'session-test', images: [{ mediaType: 'application/pdf', data: 'AAAA' }] }),
})
check('non-image media type is rejected', badImage.status === 400, String(badImage.status))

/* --- 手机发来的不只是图片：动图被拒要能兜住，视频要有地方落 --------------- */
/*
 * 现场：用户在手机上发动图，点了半天只有"发送失败"（500）。宿主只认
 * png/jpeg/webp/gif，而且多帧图会让它的解码器直接抛。所以桥必须（a）图片以外的
 * 东西存成文件、把路径交给 agent；（b）图片被拒时自动降级成"存文件再发一次"。
 */
{
	const promptsBefore = STATE.prompts.length
	// (a) 视频：存盘 + 路径进任务
	const video = await fetch(`${base}/api/prompt`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({
			sessionId: 'session-test',
			text: '看看这个视频',
			files: [{ name: 'clip.mp4', mediaType: 'video/mp4', data: Buffer.from('FAKEVIDEO').toString('base64') }],
		}),
	})
	const videoBody = await video.json()
	check('视频会被接住（不是 400/500）', video.status === 200 && videoBody.accepted === true, JSON.stringify(videoBody))
	const videoPrompt = STATE.prompts[promptsBefore]
	const videoNote = (videoPrompt?.content ?? []).find((entry) => entry.type === 'text' && entry.text.includes('手机上传的文件'))
	check('任务里带上了文件路径（agent 才有得用）',
		videoNote !== undefined && videoNote.text.includes('clip.mp4'), JSON.stringify(videoNote)?.slice(0, 160))
	const videoPath = /→\s*(.+)$/m.exec(videoNote?.text ?? '')?.[1]?.trim() ?? ''
	check('文件真的落到磁盘上了，内容一字不差',
		videoPath !== '' && (await readFile(videoPath, 'utf8')) === 'FAKEVIDEO', videoPath)
	check('路径在上传目录里（不会跑到别处去）', videoPath.includes('mobile-uploads'), videoPath)
	check('文件名带路径分隔符也跳不出目录', !videoPath.includes('..'), videoPath)

	// (b) 动图：宿主拒绝 → 桥自动降级成"存文件 + 再发一次"
	const promptsBeforeGif = STATE.prompts.length
	const gif = await fetch(`${base}/api/prompt`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({
			sessionId: 'session-test',
			text: '这个动图好笑吗',
			images: [{ mediaType: 'image/gif', data: Buffer.from('GIF89a-fake').toString('base64'), name: 'funny.gif' }],
		}),
	})
	const gifBody = await gif.json()
	check('动图被宿主拒了也不许失败：自动当文件再发一次',
		gif.status === 200 && gifBody.accepted === true && gifBody.degraded === true, `${gif.status} ${JSON.stringify(gifBody)}`)
	const retry = STATE.prompts[promptsBeforeGif + 1]
	check('重试那次不再带图片，只有文字 + 文件路径',
		(retry?.content ?? []).every((entry) => entry.type === 'text')
		&& (retry?.content ?? []).some((entry) => entry.text.includes('funny.gif')),
		JSON.stringify(retry?.content)?.slice(0, 200))
}

/* --- 分片上传：大文件只能靠它，而且路径不许跑出上传目录 ------------------ */
/*
 * 隧道入口会掐断"慢而大"的请求（实测 IPv6 16 MB 回 408、6.7 MB 要 89 秒），
 * 所以手机把文件切成 384 KB 一片发。这里验证：片能拼回原样，路径校验挡得住越界。
 */
{
	const parts = ['AAAA', 'BBBB', 'CCCC']
	let last = null
	for (let index = 0; index < parts.length; index += 1) {
		const res = await fetch(`${base}/api/upload`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({
				uploadId: 'probe-upload-1', index, total: parts.length,
				name: 'big.mp4', mediaType: 'video/mp4', data: Buffer.from(parts[index]).toString('base64'),
			}),
		})
		last = await res.json()
	}
	check('分片收完才回路径（前面几片只报进度）',
		last?.done === true && String(last.path).includes('mobile-uploads'), JSON.stringify(last))
	check('拼回来的内容和原文件一字不差', (await readFile(last.path, 'utf8')) === 'AAAABBBBCCCC',
		await readFile(last.path, 'utf8').catch(() => '(读不到)'))

	const escapeRef = await fetch(`${base}/api/prompt`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test', text: 'x', fileRefs: [{ name: 'win.ini', path: 'C:\\Windows\\win.ini' }] }),
	})
	check('引用上传目录以外的文件会被拒（接口不能变成任意文件读取）',
		escapeRef.status === 400, String(escapeRef.status))

	const badId = await fetch(`${base}/api/upload`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ uploadId: '../evil', index: 0, total: 1, name: 'x', data: 'AAAA' }),
	})
	check('uploadId 里带路径分隔符直接拒', badId.status === 400, String(badId.status))
}

/* --- 自定义背景：Range / 304 / 鉴权，一个都不能少 ------------------------ */
/*
 * 用户把自己手机上传的一段 .mov 设成手机界面背景。iOS Safari 放视频会先发
 * `Range: bytes=0-1` 试探，只回 200 它可能直接不播；ETag 让第二次打开走 304，
 * 免得在移动网络下把几 MB 再下一遍。
 */
{
	const noCookie = await fetch(`${base}/api/background`)
	check('背景也要鉴权（无 cookie → 401）', noCookie.status === 401, String(noCookie.status))

	const full = await fetch(`${base}/api/background`, authed)
	const body = Buffer.from(await full.arrayBuffer())
	check('背景原样发出去（内容一字不差）',
		full.status === 200 && body.equals(BACKDROP_BYTES), `${full.status} ${body.length} bytes`)
	check('背景带上正确的 content-type 和 accept-ranges',
		full.headers.get('content-type') === 'video/quicktime' && full.headers.get('accept-ranges') === 'bytes',
		`${full.headers.get('content-type')} / ${full.headers.get('accept-ranges')}`)

	const partial = await fetch(`${base}/api/background`, { headers: { ...authed.headers, range: 'bytes=0-3' } })
	const slice = Buffer.from(await partial.arrayBuffer())
	check('Range 请求回 206 + content-range（iOS 靠它判断能不能播）',
		partial.status === 206 && slice.toString('utf8') === 'FAKE'
		&& partial.headers.get('content-range') === `bytes 0-3/${BACKDROP_BYTES.length}`,
		`${partial.status} ${slice.toString('utf8')} ${partial.headers.get('content-range')}`)

	const etag = full.headers.get('etag')
	const cached = await fetch(`${base}/api/background`, { headers: { ...authed.headers, 'if-none-match': String(etag) } })
	check('带了 ETag 再来一次走 304（不重复下载几 MB）', cached.status === 304, `${cached.status}`)

	const advertised = await (await fetch(`${base}/api/bootstrap`, authed)).json()
	check('bootstrap 把背景告诉页面（页面才知道要不要铺）',
		advertised.background?.kind === 'video' && advertised.background?.url === 'api/background',
		JSON.stringify(advertised.background))
}

/* --- 装成 App：manifest / 图标 / service worker -------------------------- */
/*
 * iPhone 上装不了原生 App（要 Mac + 开发者账号 + 上架），但 PWA 不用商店：
 * Safari「分享 → 添加到主屏幕」之后就是全屏 + 独立图标 + 离线可用。
 * 这三样东西必须真的能取到，而且图标必须是 PNG（iOS 不认 SVG 图标）。
 */
{
	const manifest = await fetch(`${base}/manifest.webmanifest`, authed)
	const manifestBody = await manifest.json().catch(() => ({}))
	check('manifest 能取到、类型正确',
		manifest.status === 200
		&& String(manifest.headers.get('content-type')).includes('manifest+json')
		&& manifestBody.display === 'standalone' && manifestBody.start_url === './',
		`${manifest.status} ${manifest.headers.get('content-type')}`)
	check('manifest 里挂的是 PNG 图标（iOS 只认 PNG）',
		Array.isArray(manifestBody.icons) && manifestBody.icons.length >= 2
		&& manifestBody.icons.every((icon) => icon.type === 'image/png' && /\.png$/.test(icon.src)),
		JSON.stringify(manifestBody.icons))

	for (const name of ['icon-180.png', 'icon-192.png', 'icon-512.png']) {
		const icon = await fetch(`${base}/${name}`, authed)
		const bytes = Buffer.from(await icon.arrayBuffer())
		check(`${name} 是真 PNG 且能取到`,
			icon.status === 200 && icon.headers.get('content-type') === 'image/png'
			&& bytes.subarray(0, 4).toString('hex') === '89504e47',
			`${icon.status} ${bytes.length} bytes`)
	}
	check('图标白名单挡住目录穿越', (await fetch(`${base}/icons/../../package.json`, authed)).status !== 200)

	const sw = await fetch(`${base}/sw.js`, authed)
	const swBody = await sw.text()
	check('service worker 能取到、是 JS、且不吃接口缓存',
		sw.status === 200 && String(sw.headers.get('content-type')).includes('javascript')
		&& swBody.includes('addEventListener') && swBody.includes("/api/"),
		`${sw.status} ${sw.headers.get('content-type')}`)
	check('页面里的 manifest / apple-touch-icon 用的是相对地址（带密钥段才不会 404）',
		pageHtml.includes('href="manifest.webmanifest"') && pageHtml.includes('href="icon-180.png"'),
		'')
}

/* --- 电脑上的素材要能发给手机，而且只发该发的 ---------------------------- */
/*
 * 用户原话：「我手机看不到电脑给的素材」。agent 在电脑上做的图/视频在对话里只是一行
 * 路径，手机既看不到也存不下。现在有两条路：
 *   /api/media  附件 → 真二进制（iOS 长按才能"存储到照片"，data: 不行）
 *   /api/file   磁盘上的图片/视频 → 只能发桥认识的目录，别的拒掉
 */
{
	const media = await fetch(`${base}/api/media?sessionId=session-test&attachmentId=att-1`, authed)
	const mediaBody = Buffer.from(await media.arrayBuffer())
	check('附件能按真二进制取（长按可存相册）',
		media.status === 200 && media.headers.get('content-type') === 'image/png' && mediaBody.length > 0,
		`${media.status} ${media.headers.get('content-type')} ${mediaBody.length} bytes`)
	check('附件接口缺参数时给 400 而不是 500',
		(await fetch(`${base}/api/media`, authed)).status === 400)

	const noCookie = await fetch(`${base}/api/file?path=${encodeURIComponent(join(scratch, 'mobile-uploads', 'bg.mov'))}`)
	check('/api/file 也要鉴权', noCookie.status === 401, String(noCookie.status))

	// 上传目录（在 DSH_HOME 下）里的媒体：放行
	const allowed = await fetch(`${base}/api/file?path=${encodeURIComponent(join(scratch, 'mobile-uploads', 'bg.mov'))}`, authed)
	check('DSH 目录里的媒体能发给手机', allowed.status === 200, String(allowed.status))

	// 系统目录里的图片：拒绝（接口绝不能变成任意文件读取）
	const outside = await fetch(`${base}/api/file?path=${encodeURIComponent('C:\\Windows\\secret.png')}`, authed)
	check('允许目录以外的路径被拒（403）', outside.status === 403, String(outside.status))
	const sneaky = await fetch(`${base}/api/file?path=${encodeURIComponent('C:\\Windows\\..\\Windows\\secret.png')}`, authed)
	check('带 .. 绕一圈也还是被拒', sneaky.status === 403, String(sneaky.status))

	// 目录内但不是媒体：拒绝
	const notMedia = await fetch(`${base}/api/file?path=${encodeURIComponent(join(scratch, 'mobile-bridge.json'))}`, authed)
	check('只发图片/视频，配置文件不给（415）', notMedia.status === 415, String(notMedia.status))
}

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

/* --- 子会话：跟不了就说清楚，并且别再摆出来 ------------------------------- */
/*
 * 真事故：手机上默认选中的那个会话是 agent 派生的子会话，宿主回
 * "subagent Sessions require their durable parent address"。页面把它当普通断线，
 * 于是弹"和电脑断开了 / 你的地址已失效"，而浏览器每三秒自动重连一次，连一整晚。
 * （这一段必须放在上面那条 `STATE.followed[0]` 的断言之后。）
 */
{
	const stream = await fetch(`${base}/api/stream?sessionId=session-subagent`, authed)
	check('子会话的流会开出来（拒绝发生在跟随阶段）', stream.status === 200, `status ${stream.status}`)
	const text = await stream.text()
	const frames = text.split('\n').filter((line) => line.startsWith('data: '))
		.map((line) => { try { return JSON.parse(line.slice(6)) } catch { return null } })
		.filter(Boolean)
	const errorFrame = frames.find((frame) => frame.t === 'error')
	check('子会话的错误帧带 unsupported 标记（页面才敢说人话，而不是谎报断线）',
		errorFrame?.unsupported === true, JSON.stringify(errorFrame)?.slice(0, 140))

	listItems.push({ sessionId: 'session-subagent', updatedAt: Date.now() + 1000, running: false, blank: false, cwd: 'D:\\tool', projections: { asOfSeq: 1, values: { title: '子会话' } } })
	const after = await (await fetch(`${base}/api/bootstrap`, authed)).json()
	check('打不开的子会话不再出现在列表里（用户不会再选到它）',
		after.sessions?.some((item) => item.sessionId === 'session-subagent') === false,
		JSON.stringify(after.sessions?.map((item) => item.sessionId)))
	listItems.pop()
}

/* --- 巨型历史必须被压小之后再发给手机 ------------------------------------ */
{
	const res = await fetch(`${base}/api/stream?sessionId=session-huge`, authed)
	check('巨型会话的流仍能打开', res.status === 200, `HTTP ${res.status}`)
	const reader = res.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	let chars = 0
	let snapshot = null
	const deadline = Date.now() + 8000
	while (Date.now() < deadline && snapshot === null) {
		const { value, done } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		chars += value.length
		const lines = buffer.split('\n')
		buffer = lines.pop() ?? ''
		for (const line of lines) {
			if (!line.startsWith('data: ')) continue
			const payload = JSON.parse(line.slice(6))
			if (payload.t === 'snapshot') snapshot = payload
		}
	}
	await reader.cancel().catch(() => {})
	// 原始是 12 × 500 KB = 6 MB。预算 240 KB，留点余量断言。
	check('整段历史不会被原样塞给手机', snapshot !== null && chars < 300 * 1024,
		`${Math.round(chars / 1024)} KB（原始约 6000 KB）`)
	check('被裁掉的部分会用 hasMore 告诉页面', snapshot?.hasMore === true, `hasMore=${snapshot?.hasMore}`)
	check('超长工具输出被截断并注明', JSON.stringify(snapshot).includes('已截断'))
}

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

/* --- 桌面角标 / 启动完整性 ------------------------------------------------ */
/*
 * 这条路径以前完全没有测试覆盖。结果一个作用域写错 —— 模块级的 installBadge 里
 * 用了定义在 createBridge 内的 record() —— 就让 start() 在最后一行抛 ReferenceError：
 * 角标从界面上消失、隧道自检永不启动，而当时 236 条测试全绿。
 */
{
	check('角标注入函数已注册（installBadge 真的跑到了）', typeof badgeTap === 'function')
	const injected = typeof badgeTap === 'function' ? badgeTap('<html><body>hi</body></html>') : ''
	check('角标 HTML 被塞进 index 页',
		typeof injected === 'string' && injected.includes('dsh-mobile-bridge-badge'))
	check('角标里带着 PIN，用户不用翻文件', injected.includes('123456'))
	// apply() 里的 catch 会把 start() 的异常写进这个文件 —— 它不存在 = 启动没抛错。
	check('start() 没有抛异常（抛了就会留下 start-error 日志）',
		!existsSync(join(scratch, 'mobile-bridge-start-error.log')))
}

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

/* --- 普通请求取对话（不依赖长连接）-------------------------------------- */
/*
 * 真事故：有些通道会把大响应缓冲住，页面一片空白直到有新数据把它冲出来。
 * 初始对话必须能用一次普通请求拿到 —— bootstrap 能通就证明普通请求没有这个问题。
 */
{
	const plain = await (await fetch(`${base}/api/transcript?sessionId=session-test`, authed)).json()
	check('GET /api/transcript 用普通请求返回对话快照',
		Array.isArray(plain.records) && plain.records.length === 2, `${plain.records?.length} records`)
	check('快照带 cursor 与 pageTag', Number.isInteger(plain.cursor) && typeof plain.pageTag === 'string',
		`cursor=${plain.cursor} tag=${plain.pageTag}`)
	const huge = await (await fetch(`${base}/api/transcript?sessionId=session-huge`, authed)).json()
	check('普通请求路径同样会裁剪巨型历史',
		JSON.stringify(huge).length <= 300 * 1024 && huge.hasMore === true,
		`${Math.round(JSON.stringify(huge).length / 1024)} KB hasMore=${huge.hasMore}`)

	// 「大」不只有"超长文本"一种：`data.stream` 是一堆短字符串，按字数截断对它无效。
	const streamyRaw = await (await fetch(`${base}/api/transcript?sessionId=session-streamy`, authed)).text()
	check('冗余的 stream 增量和超长文本一样会被丢掉（否则一条消息就能顶 780 KB）',
		streamyRaw.length <= 300 * 1024 && !streamyRaw.includes('"stream"'),
		`${Math.round(streamyRaw.length / 1024)} KB`)

	// 手机上切走 / 关掉页面的那一刻，这次请求就没了收件人。往一条断掉的 socket 上
	// writeHead 会抛，而抛在 await 之外就是进程级 uncaught —— 整个 DSH 陪葬。
	// 所以掐断之后必须还能正常应答（handleStream 里踩过同一个坑）。
	const noId = await fetch(`${base}/api/transcript`, authed)
	check('缺少 sessionId → 400（不是 500，也不是假装成功的空 200）', noId.status === 400, `status ${noId.status}`)

	const aborting = new AbortController()
	const cut = fetch(`${base}/api/transcript?sessionId=session-huge`, { ...authed, signal: aborting.signal }).catch(() => null)
	aborting.abort()
	await cut
	await new Promise((resolve) => setTimeout(resolve, 150))
	const afterCut = await fetch(`${base}/api/bootstrap`, authed)
	check('客户端半路掐断 transcript 之后，桥还活着（没被 uncaught 带走）',
		afterCut.status === 200, `status ${afterCut.status}`)
}

/* --- 开机只跑一个来回（/api/boot） -------------------------------------- */
/*
 * 现场：手机上"开始使用"之后要等两次往返 —— 先 bootstrap（会话列表＋背景），
 * 再 transcript（上次那个会话的对话）。5G/Funnel 上一次往返一两秒，加起来就是
 * 用户看到的"进去太慢"。所以合并成一个请求：一次拿齐列表＋对话。
 * 慢网络上少一个来回 ≈ 少一两秒，这是纯粹的等待时间，没法靠缓存省掉。
 */
{
	const boot = await (await fetch(`${base}/api/boot?sessionId=session-test`, authed)).json()
	check('GET /api/boot 一次带回会话列表', boot.sessions?.length === 2, JSON.stringify(boot.sessions?.length))
	check('GET /api/boot 一次带回对话快照',
		Array.isArray(boot.transcript?.records) && boot.transcript.records.length === 2,
		`${boot.transcript?.records?.length} records`)
	check('GET /api/boot 带回 cursor / hasMore，页面不用再问一次',
		Number.isInteger(boot.transcript?.cursor) && boot.transcript.hasMore === false,
		`cursor=${boot.transcript?.cursor} hasMore=${boot.transcript?.hasMore}`)
	check('GET /api/boot 也带背景和 welcomed（等同 bootstrap 的那几项）',
		'background' in boot && typeof boot.welcomed === 'boolean',
		`welcomed=${boot.welcomed}`)
	check('GET /api/boot 与 bootstrap 用同一个 pageTag（两套入口不会各说各话）',
		boot.pageTag === pageTag, `${boot.pageTag} vs ${pageTag}`)

	// 没记住上次是哪个会话时（第一次装、清了站点数据），boot 只当 bootstrap 用。
	const bare = await fetch(`${base}/api/boot`, authed)
	const bareBody = await bare.json()
	check('没带 sessionId 的 boot 只回列表、不报错（首装那一趟也只用一次往返）',
		bare.status === 200 && bareBody.sessions?.length === 2 && bareBody.transcript === null,
		`status ${bare.status} transcript=${JSON.stringify(bareBody.transcript)}`)

	const hugeBoot = await (await fetch(`${base}/api/boot?sessionId=session-huge`, authed)).json()
	check('boot 里的对话同样会裁剪巨型历史（不能因为是新入口就绕过预算）',
		JSON.stringify(hugeBoot).length <= 320 * 1024 && hugeBoot.transcript?.hasMore === true,
		`${Math.round(JSON.stringify(hugeBoot).length / 1024)} KB`)

	const bootNoAuth = await fetch(`${base}/api/boot?sessionId=session-test`)
	check('未登录的 /api/boot 同样被拒（新入口不能开天窗）', bootNoAuth.status === 401, `status ${bootNoAuth.status}`)
}

/* --- 切走再切回来：只补"新的那几条"（since=） ----------------------------- */
/*
 * 现场：换到别的会话再换回来，又要等一次整段对话下载（隧道上好几秒），而这份内容
 * 刚刚还在屏幕上。宿主现在认得客户端报的序号：`since=<cursor>` → 只回这之后的记录，
 * 通常一条都没有。安全底线是"宁可多发，绝不能少发"：客户端比快照里最旧的记录还旧
 * （页面放了很久、历史被裁过、被压缩重排过）时必须回整段，否则它会缺一段而不自知。
 */
{
	const full = await (await fetch(`${base}/api/transcript?sessionId=session-test`, authed)).json()
	check('不带 since 时照旧回整段（partial 不出现）',
		Array.isArray(full.records) && full.records.length === 2 && full.partial === undefined,
		`${full.records?.length} records partial=${JSON.stringify(full.partial)}`)

	const nothingNew = await (await fetch(`${base}/api/transcript?sessionId=session-test&since=${full.cursor}`, authed)).json()
	check('since=最新序号 → 只回"没有新记录"的增量（一条都不发）',
		nothingNew.partial === true && nothingNew.records.length === 0 && nothingNew.cursor === full.cursor,
		`partial=${nothingNew.partial} records=${nothingNew.records.length}`)

	const oneNew = await (await fetch(`${base}/api/transcript?sessionId=session-test&since=1`, authed)).json()
	check('since=1 → 只回第 2 条之后的记录（第一条不再重发）',
		oneNew.partial === true && oneNew.records.length === 1 && oneNew.records[0].event.seq === 2,
		`${oneNew.records.length} 条，seq=${oneNew.records[0]?.event?.seq}`)

	const tooNew = await (await fetch(`${base}/api/transcript?sessionId=session-test&since=99`, authed)).json()
	check('客户端报的序号比快照还新（不可能）→ 老实回整段，不裁剪',
		tooNew.partial === undefined && tooNew.records.length === 2, `partial=${tooNew.partial}`)

	const junk = await (await fetch(`${base}/api/transcript?sessionId=session-test&since=abc`, authed)).json()
	const negative = await (await fetch(`${base}/api/transcript?sessionId=session-test&since=-1`, authed)).json()
	check('乱写的 since 一律当没带（不 500、也不裁剪）',
		junk.partial === undefined && junk.records.length === 2 && negative.partial === undefined && negative.records.length === 2,
		`abc=${junk.records.length} -1=${negative.records.length}`)
}

{
	// 长连接同样认 since：首帧变成"增量快照"，页面据此只追加、不清空。
	const stream = await fetch(`${base}/api/stream?sessionId=session-test&since=2`, authed)
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
	check('带 since 的流：首帧标成 partial 且不带旧记录',
		snapshot?.partial === true && snapshot.records.length === 0 && snapshot.cursor === 2,
		`partial=${snapshot?.partial} records=${snapshot?.records?.length}`)
	check('带 since 的流：之后的新事件照常推',
		frames.some((frame) => frame.t === 'event' && frame.event?.type === 'tool/call'),
		`${frames.length} 帧`)

	const plainStream = await fetch(`${base}/api/stream?sessionId=session-test`, authed)
	const plainReader = plainStream.body.getReader()
	let plainRaw = ''
	while (plainRaw.length < 400) {
		const { value, done } = await plainReader.read()
		if (done) break
		plainRaw += decoder.decode(value, { stream: true })
	}
	await plainReader.cancel().catch(() => {})
	const plainSnapshot = plainRaw.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))).find((frame) => frame.t === 'snapshot')
	check('不带 since 的流：首帧照旧是整段快照（没被增量逻辑误伤）',
		plainSnapshot?.records?.length === 2 && plainSnapshot.partial === undefined,
		`${plainSnapshot?.records?.length} records`)
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
