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

import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { homedir, tmpdir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

/*
 * 语音转写的桩服务：**绝不在测试里打真的智谱接口**（花钱、还要网络、结果不可控）。
 * 桥的 asrBaseUrl 是可配置的，指到这里就行。它会记下每次请求的 model / 有没有文件 /
 * 有没有带上文（prompt），好让用例断言"长音频真的被切片、而且切片之间有上下文"。
 */
const ASR_CALLS = []
const asrStub = createServer((req, res) => {
	const chunks = []
	req.on('data', (chunk) => chunks.push(chunk))
	req.on('end', () => {
		const body = Buffer.concat(chunks)
		const raw = body.toString('latin1')
		// multipart 里既有二进制（音频）也有 UTF-8 文本：整体按 latin1 读是为了不破坏字节位置，
		// 取到文本字段后再 latin1→utf8 还原（否则中文会变成乱码，断言"上下文带过去了"就会假红）。
		const utf8 = (value) => Buffer.from(String(value ?? ''), 'latin1').toString('utf8')
		const model = utf8((/name="model"\r\n\r\n([^\r]+)/.exec(raw) ?? [])[1])
		const prompt = utf8((/name="prompt"\r\n\r\n([^\r]*)/.exec(raw) ?? [])[1])
		const hasFile = raw.includes('name="file"; filename=')
		ASR_CALLS.push({ model, prompt, hasFile, bytes: body.length, url: req.url })
		res.writeHead(200, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ id: 'stub', model, text: `第${ASR_CALLS.length}段转写` }))
	})
})
await new Promise((resolve) => asrStub.listen(0, '127.0.0.1', resolve))
const ASR_PORT = asrStub.address().port
const ASR_BASE = `http://127.0.0.1:${ASR_PORT}`

const scratch = await mkdtemp(join(tmpdir(), 'dsh-mobile-bridge-'))
process.env.DSH_HOME = scratch

/*
 * Pin the port before the plugin loads. The real bridge already owns 3081;
 * without this the harness would die on EADDRINUSE — or, worse, run its
 * assertions against the live server and look green for the wrong reason.
 *
 * ⚠️ 3.4.0 复查（第 75 轮）🟠：原来**写死 31417** ✗ —— 复查自己就撞过 `EADDRINUSE`
 * （上一轮跑完留下的 TIME_WAIT 也能占住它 ✓），我这轮"连着跑两套"更是一定撞 ✗。
 * 现在：**先预检** ✓ —— 31417 绑得上就用它（保住"钉住端口"的本意 ✓）；
 * 绑不上（TIME_WAIT / 别的进程占着 ✓）就换一个**系统给的空闲端口** ✓，并**大声说出来** ✓
 * （悄悄换端口更糟 ✗：日志里的端口和"上一轮那个"对不上，排查时只会更晕 ✓）。
 */
/*
 * ⚠️ 复审（第 83 轮 N1，2/2 复现）：**不要"优先钉 31417"** ✗ —— 两套 harness 并发跑时会**同时**看到
 * 它空闲 ✓（预检 → 绑定之间的 TOCTOU ✓）→ 一套 `EADDRINUSE`（那份插件静默起不来 ✓）、
 * 另一套的断言**打到别人家的服务器上** ✓（实测 6 处 404 + 一条**没有 FAIL 行**的 exit 1 ✗，
 * 正是 R10 要治的那类"红在哪看不见" ✗）。
 * 现在：**直接用系统给的空闲端口** ✓ —— 并发不再撞 ✓，而且它永远不可能是线上 3081 ✓（另留一道硬闸 ✓）。
 */
const pickPort = async () => {
	const probe = createServer()
	await new Promise((resolve) => probe.listen(0, resolve))
	const port = probe.address().port
	await new Promise((resolve) => probe.close(resolve))
	if (port === 3081) { console.error('harness: 拿到线上端口 3081 —— 这不可能是巧合，拒绝继续 ✗'); process.exit(3) }
	return port
}
const PORT = await pickPort()
console.log(`harness: 用端口 ${PORT}（系统给的空闲端口 ✓ —— 并发跑两套也不会撞 ✓）`)
/*
 * 🔴 复查（第 83 轮）R1 的**冷启动回归用例** ✓：**启动之前**就把 `webhookUrl` 写进配置 ✓ ——
 * 这样"配了 URL 的冷启动/重启"就是这条 harness 自己的启动路径 ✓。
 * 为什么以前抓不到 ✗：harness 的"正路径"是**先 POST 订阅路由**再验的 ✓（`test/harness.mjs` 里自己写着
 * "订阅必须走请求路径"✓）→ 于是"启动时到底订没订"从来没人问 ✓，R1 就这么漏到复查 ✓。
 */
const coldHits = []
const coldReceiver = createServer((req, res) => {
	let body = ''
	req.on('data', (chunk) => { body += chunk })
	req.on('end', () => { coldHits.push({ headers: req.headers, body }); res.statusCode = 200; res.end('ok') })
})
await new Promise((resolve) => coldReceiver.listen(0, '127.0.0.1', resolve))
const coldTarget = `http://127.0.0.1:${coldReceiver.address().port}/cold`
const coldSecret = '冷启动-hmac-秘密'
// 背景：真文件放在上传目录里，配置指过去 —— 和用户自己挑一段 .mov 的路径一样。
const BACKDROP_BYTES = Buffer.from('FAKEMOV-0123456789')
await mkdir(join(scratch, 'mobile-uploads'), { recursive: true })
await writeFile(join(scratch, 'mobile-uploads', 'bg.mov'), BACKDROP_BYTES)
await writeFile(
	join(scratch, 'mobile-bridge.json'),
	JSON.stringify({
		version: 1, port: PORT, pin: '123456', answerOnPhone: true, backgroundFile: 'bg.mov',
		asrKey: 'harness-asr-key', asrBaseUrl: ASR_BASE,
		// R1：**启动前**就配好（下面 3.4.0 那组会断言"不用调订阅接口也挂着"✓）。
		webhookUrl: coldTarget, webhookSecret: coldSecret,
		// 2.7.0：用户自己加的键**不许被配置重写抹掉** ✗ —— loadConfig 是白名单重写，
		// 这条特意放进来看它能不能活过启动时那次规范化 ✓（下面有对应断言 ✓）。
		myCustomFlag: 'keep-me',
	}),
	'utf8',
)

const { apply } = await import('../lib/index.js')
const { qrMatrix } = await import('../lib/qr.js')

const STATE = { prompts: [], cancelled: [], followed: [], created: [], queueMutations: [] ,
	searches: [],}

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
	/*
	 * 隧道探测探的是 `publicUrl`（harness 里配的 `https://example.ts.net` ✓）——
	 * 在这里**离线地**让它失败 ✓：既不让测试去碰真网络（DNS 超时会拖慢一切 ✗），
	 * 又让"自检说通不通"这条断言有确定结果 ✓。
	 */
	if (url.startsWith('https://example.ts.net')) return Promise.reject(new TypeError('tunnel down (harness)'))
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
	// 模型目录 / 按会话切模型（2.4.0，宿主真实接口同形）。
	modelCatalog: async () => ({
		groups: [
			{ provider: 'deepseek', label: 'DeepSeek', models: [{ id: 'deepseek-chat', label: 'deepseek-chat' }, { id: 'deepseek-reasoner', label: 'deepseek-reasoner' }] },
			{ provider: 'zhipu', label: '智谱', models: [{ id: 'glm-4-flash', label: 'glm-4-flash' }] },
		],
	}),
	selectModel: async (request) => {
		services.selectedModels.push(request)
		if (String(request?.model ?? '') === 'nope') throw new Error('unknown model')
		return { selected: { provider: request.provider, model: request.model } }
	},
	async list() {
		return { items: listItems }
	},
// 3.3.0：**会话全文检索** ✓（宿主真实形状：`search({ query })` → `{ items: [{sessionId, snippet}], hasMore }` ✓）。
	async search(request) {
		STATE.searches.push(request)
		const query = String(request?.query ?? '')
		// 「boom」模拟"这台 DSH 的检索没生效 / 超时" ✓ —— 桥必须**如实 503**，不能假装搜过了 ✗。
		if (query === 'boom') throw new Error('search backend unavailable (test stub)')
		if (query === 'none') return { items: [], hasMore: false }
		// 正常：一条能对上列表的 ✓ + 一条**对不上列表的** ✓（用来验"标题拿不到就留空" ✓）。
		return {
			items: [

				{ sessionId: 'session-test', snippet: '…关于「' + query + '」的一段…' },
				{ sessionId: 'session-not-in-list', snippet: '另一段 ' + query },
			],
			hasMore: true,
		}
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
	/** 记录"切模型"的请求（2.4.0）。 */
	selectedModels: [],
	/*
	 * 3.5.0「目标」：上游查实（**活契约** ✓，`cordis_inspect_query` ✓）——
	 *   · `agents.get(sessionId)` → **活着的** agent（`{ id }` ✓）—— 是"查"不是"唤醒" ✓；
	 *   · `goals.get(agent)` → `GoalView | undefined` ✓
	 *     （字段照契约 ✓：objective / phase / roundsStarted / maxGoalRounds / activation / revision / updatedAt ✓）。
	 * 桩里一条"在跑且带目标" ✓、一条"没在跑" ✓ —— 桥必须**分别**说清 ✓，
	 * 尤其**不许**把"没在跑"说成"这条会话没有目标" ✗（那是编 ✗）。
	 */
	agents: {
		get(id) { return String(id) === 'session-test' ? { id: 'session-test' } : undefined },
	},
	goals: {
		get(agent) {
			if (agent?.id !== 'session-test') return undefined
			return {
				id: 'goal-1', revision: 3, objective: '把手机桥按总路线推进到 v4.0.0',
				phase: 'active', maxGoalRounds: 12, roundsStarted: 7,
				createdAt: 1791800000000, updatedAt: 1791840000000, activation: 'armed',
			}
		},
	},
	/*
	 * 2.7.0 ★6：定时任务栏的桩。
	 *
	 * 真上游是 `@deepseek-ai/dsh-schedule` 注册的 **`schedule`** 服务（`super(ctx, "schedule")` ✓），
	 * 方法：create(sessionId, request) / list({sessionId}) / catalog() / delete({id, sessionId}) ✓。
	 * 桩的重点不是"演得像"，而是**把桥转发过去的请求形状记下来** ✓ —— 形状错了，
	 * 真宿主会直接抛输入错误，而那时候用户看到的是"没建成" ✗。
	 */
	schedule: {
		created: [],
		deleted: [],
		tasks: [
			{ id: 'schedule-1', sessionId: 'session-test', title: '整理今天的笔记', prompt: '整理今天的笔记', scheduledAt: '2026-10-13T15:00:00.000Z', repeat: { kind: 'daily', time: '23:00:00', timeZone: 'Asia/Shanghai' }, status: 'active' },
		],
		async create(sessionId, request) {
			this.created.push({ sessionId, request })
			return { id: `schedule-new-${this.created.length}`, sessionId, status: 'active', ...request }
		},
		async list({ sessionId }) {
			return this.tasks.filter((task) => task.sessionId === sessionId)
		},
		async catalog() {
			return this.tasks
		},
		async delete({ id, sessionId }) {
			this.deleted.push({ id, sessionId })
			const found = this.tasks.some((task) => task.id === id && task.sessionId === sessionId)
			return found ? { id, deleted: true } : { id, deleted: false, code: 'schedule_not_found' }
		},
	},
	// 桌面角标靠 webServer.tapIndex 注入。以前 harness 里没有这个服务，于是
	// installBadge 整个走不到 —— 一个作用域写错（模块级函数里用了 createBridge
	// 内的 record()）就让 start() 抛错：角标消失、隧道自检永不启动，
	// 而当时 236 条测试全绿。给个假的把它覆盖上。
	webServer: {
		tapIndex: (transform) => { badgeTap = transform; return () => { badgeTap = null } },
	},
	workspaceRegistry: {
		/** 2.6.0：手机上那个「删除」落到的就是宿主的**归档集合**。 */
		archived: [],
		/** 桩演三种结果：正在跑（不带 stop 就抛）／不存在的会话／正常归档。 */
		busy: new Set(),
		unknown: new Set(),
		archiveCalls: [],
		get archivedSessionIds() { return this.archived.slice() },
		async archiveSession(sessionId, options) {
			this.archiveCalls.push({ sessionId, options: options ?? {} })
			if (this.unknown.has(sessionId)) {
				const error = new Error(`unknown session ${sessionId}`)
				error.name = 'WorkspaceUnknownSessionError'
				throw error
			}
			if (this.busy.has(sessionId) && options?.stopActivity !== true) {
				const error = new Error(`session ${sessionId} is active`)
				error.name = 'WorkspaceActiveSessionError'
				error.activity = [{ kind: 'turn' }]
				throw error
			}
			this.busy.delete(sessionId)
			if (this.archived.includes(sessionId) === false) this.archived.push(sessionId)
		},
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
		// 宿主真实实现会给 `isDefault`（手机"新建"面板靠它显示"本次将用哪个预设"，
		// 因为用户报过"手机新建明显会变贵" —— 得让花销在选择之前看得见）。
		remoteExportList: async () => ({
			presets: [
				{ id: 'default', name: '默认', isDefault: true },
				{ id: 'video', name: '视频', isDefault: false, description: '带视频工具的预设' },
				{ id: 'rotten', name: '坏掉的预设', broken: 'composition file is missing' },
			],
		}),
	},
	credentials: {
		resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-test-0123456789', source: 'test' } : undefined),
	},
	/**
	 * 权限预设的替身。真实实现来自 dsh-permission-presets：它把预设名翻译成
	 * 沙箱模式 + 审批策略，并且**按会话**记（写进会话日志，桌面端也看得到）。
	 * 这里只留桥用得到的那几个成员，外加一个 current 变量方便断言切换真的发生了。
	 */
	permissionPresets: {
		presets: {
			'read-only': { sandbox: 'read-only', approval: 'ask' },
			'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
			'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
		},
		currentPreset: 'workspace-write',
		writes: [],
		get names() { return Object.keys(this.presets) },
		resolve(name) {
			const spec = this.presets[name]
			if (spec === undefined) throw new Error(`permission: unknown preset "${name}"`)
			return spec
		},
		/**
		 * 3.5.0：真实契约里的 `@Remote('catalog')` ✓（`{options, defaultOptions, defaultPreset}` ✓）——
		 * 手机「新建任务」那张纸在**会话还不存在**时要靠它列出"这台电脑的默认档 + 可选档" ✓。
		 * 这里按真实形状摆一份 ✓（`PresetOption = {value, name, description?}` ✓）。
		 */
		catalog() {
			const options = this.names.map((value) => ({ value, name: value, description: `沙箱 ${this.presets[value].sandbox}` }))
			return {
				options,
				defaultOptions: options.filter((option) => option.value === 'workspace-write'),
				defaultPreset: 'workspace-write',
			}
		},
		current(session) { return this.currentPreset },
		set(session, name) {
			this.resolve(name)
			this.writes.push({ sessionId: session.id, preset: name })
			this.currentPreset = name
		},
	},
	/** 桥按 sessionId 拿会话对象；只有真正存在的会话给对象，其它一律当作"找不到"。 */
	sessions: {
		get(id) {
			const known = ['session-test', 'session-blank', 'session-streamy', 'session-huge', 'session-fresh']
			return known.includes(String(id)) ? { id: String(id) } : undefined
		},
	},
}

/** 撤一棵 effect 子树（子 effect 先撤 ✓ —— 真 Cordis 就是按作用域收集的 ✓）。 */
const disposeScope = (scope) => {
	for (const child of scope?.children ?? []) disposeScope(child)
	try { if (typeof scope?.dispose === 'function') scope.dispose() } catch { /* 无所谓 */ }
}
/**
 * **一代 = 一次 `apply()`** ✓（复查第 83 轮抓的那一类假绿就出在这里）：
 * 真 Cordis 里"插件 fiber 被 dispose"会把**它的全部** effect 一起撤掉 ✓ —— 包括 `start()` 里
 * 异步注册的那个 webhook 订阅 ✓（那时 `apply` 早返回了 ✓，所以按"调用栈"分组是错的 ✗）。
 * 假 ctx 原来把所有 effect 平铺 ✗ → harness 的"重启"只撤外层 ✓，**webhook 订阅留在原地** ✗ →
 * 后面每一组"监听器数"断言都多算一套 ✓（实测：冷启动三个事件各 2 个监听器 ✗）。
 */
let currentGeneration = 0
const scopesByGeneration = new Map()
const disposeGeneration = (generation) => {
	for (const scope of scopesByGeneration.get(generation) ?? []) disposeScope(scope)
	scopesByGeneration.delete(generation)
}
/**
 * 记录插件注册的 waterfall 应答者，测试自己触发它们 —— 模拟 Cordis 的 dispatch。
 * 插件用 prepend 抢在官方 api-remotes 之前，所以这里只关心"登记了谁"。
 */
const waterfallListeners = new Map()
/** 当前正在执行的 effect 的栈（用来模拟"子 effect 属于外层"✓）。 */
const effectScopeStack = []
const ctx = {
	effect(callback) {
		/*
		 * ⚠️ 三件事，复查（第 75 / 83 轮）各抓过 ✓：
		 * ① 必须返回**真的** disposer（第 82 轮修 ✓）：插件用 `webhookEffectDisposer?.()` 撤上一次订阅 ✓，
		 *    原来返回 `() => {}` ✗ → 连订两次多挂一套监听器 ✗（真宿主上 = 同一事件投递两次 ✗）。
		 * ② 必须模拟**作用域**（第 83 轮 ✓）：在 effect 执行期间注册的 effect 是它的**子** ✓，一起撤 ✓。
		 * ③ 还要按**代**归组（第 83 轮 ✓）：`start()` 里异步注册的 effect 也必须算进这一代 ✓ ——
		 *    否则"重启"撤不掉它 ✗（就是上面那段注释里的实测 ✓）。
		 */
		const parent = effectScopeStack.length > 0 ? effectScopeStack[effectScopeStack.length - 1] : null
		const scope = { children: [], dispose: null }
		if (parent === null) {
			if (!scopesByGeneration.has(currentGeneration)) scopesByGeneration.set(currentGeneration, new Set())
			scopesByGeneration.get(currentGeneration).add(scope)
		} else {
			parent.children.push(scope)
		}
		effectScopeStack.push(scope)
		try { scope.dispose = callback() } finally { effectScopeStack.pop() }
		return () => disposeScope(scope)
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
/** 每次 `apply` = **新的一代** ✓（这样"重启"才能把上一代的订阅一起撤掉 ✓，见 ctx.effect 注释 ✓）。 */
const applyBridge = () => { currentGeneration += 1; apply(ctx) }
applyBridge()

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
/*
 * 复审（第 83 轮 N1）的第二道闸 ✓：端口上**必须是"我们这份桥"** ✓ —— 判据是"密钥段认不认" ✓
 * （我们自己的桥没 cookie 会回 401 ✓；**404 说明端口上是别人** ✓）。撞上就直接退出并说清原因 ✓，
 * 而不是让后面几十条断言挨个假红、最后崩在一个看不出原因的 TypeError 上 ✗。
 */
{
	const probe = await fetch(`${base}/api/bootstrap`).catch(() => null)
	if (probe === null || probe.status === 404) {
		console.error(`harness: ${base}/api/bootstrap → ${probe === null ? '连不上' : probe.status} —— `
			+ '端口上**不是我们这份桥**（密钥段不认 ✓；并发跑了两套 harness？）。'
			+ '断言打过去只会得到一堆假红 ✗ → 直接退出 ✓')
		process.exit(3)
	}
}
const results = []
const check = (name, ok, detail = '') => {
	results.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/**
 * 读一份 JSON：**读不到就红一条，绝不把整个套件炸掉** ✓（复查第 83 轮 R10）。
 * 为什么要有它 ✗：`persistTokens()` 是 fire-and-forget（落盘慢半拍 ✓），harness 里那些
 * "直接读 tokens 文件"的地方撞上 ENOENT 会**整个进程 exit 1** ✗ —— 而且**不是 FAIL 行** ✓，
 * 排查时根本看不出是哪条断言 ✓（复查实测：另一套在跑时 `check-counts` 内层 harness 就这么崩过 ✓）。
 * ⚠️ 正常路径下它**不 push 任何 check** ✓（所以项数不变 ✓、check-counts 的数字也不会抖 ✓）；
 * 只有真读不到时才红一条 ✓。
 */
const readJsonOrFail = async (path) => {
	try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
		check(`🔴 读得到 ${String(path).split(/[\\/]/).pop()} ✓（复查 R10：读不到要红一条，不许把整个套件炸掉 ✗）`,
			false, String(error?.code ?? error?.message ?? error))
		return {}
	}
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

/*
 * 开始页的版本说明（1.8.0）：页面上的版本必须**等于 package.json**（服务端现读的），
 * 而且"最近更新"要是从 CHANGELOG 现读出来的真内容。这两条只有在真桥上跑才算数 ——
 * ui.mjs 那边用的是固定夹具。
 *
 * 顺带钉住这次的教训：标记在页面里出现不止一次（版本标记登录页一处、说明页一处），
 * 只换第一处的 `replace` 会让第二处原样漏给用户。
 */
const pkgVersion = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
check('页面上的版本号 = package.json 里的版本（现读，不手抄）',
	pageHtml.includes(`手机桥 v${pkgVersion}`) && pageHtml.includes(`v${pkgVersion}</strong>`),
	`package.json=${pkgVersion}`)
/*
 * 现场（2026-10-09）：CHANGELOG 标题加了"· 最终版"后缀之后，服务端解析标题的正则漏掉了那一节，
 * 注入进页面的"最新版本"退回 1.8.2 —— 手机登录页与说明页都显示旧版本号 ✗。
 * 把"注入的最新版本必须等于 package.json"钉死，标题格式怎么变都不许退版。
 */
{
	const injectedNews = /<script type="application\/json" id="whatsnew">([\s\S]*?)<\/script>/.exec(pageHtml)
	let first = ''
	try { first = JSON.parse(injectedNews?.[1] ?? '[]')[0]?.version ?? '' } catch { first = '' }
	check('注入的"最新版本"= package.json 的版本（标题格式变了也不许退版）',
		first === pkgVersion, `注入=${first} package.json=${pkgVersion}`)
}
check('注入标记一处都没漏（replaceAll 而不是 replace）',
	pageHtml.includes('__DSH_PAGE_TAG__') === false
	&& pageHtml.includes('__DSH_BRIDGE_VERSION__') === false
	&& pageHtml.includes('__DSH_WHATSNEW__') === false)
{
	const injected = /<script type="application\/json" id="whatsnew">([\s\S]*?)<\/script>/.exec(pageHtml)
	let sections = []
	try { sections = JSON.parse(injected?.[1] ?? '[]') } catch { sections = [] }
	check('"最近更新"是从 CHANGELOG 现读出来的真内容（不是空的、也不是模板）',
		Array.isArray(sections) && sections.length > 0
		&& typeof sections[0].version === 'string'
		&& Array.isArray(sections[0].lines) && sections[0].lines.length > 0,
		JSON.stringify(sections[0] ?? null).slice(0, 90))
	/*
	 * 过滤规则从**白名单**改成了**黑名单**（2026-10-09）：白名单太脆 —— 标题换个写法就被静默丢掉，
	 * 现场是 32 个版本只剩 15 个出现在手机的历史里。现在只要求"不带维护者向的标题"，
	 * 并且**覆盖到足够多的版本**（这条能抓住"过滤又变脆"的回归）。
	 */
	// 一个版本都不许少（用户要求看到 1.0 → 2.0 全量）：CHANGELOG 里有 30+ 节，注入的也得是同一量级。
	check('更新历史覆盖全部版本（不筛标题，一节都不许丢）',
		Array.isArray(sections) && sections.length >= 25 && sections[0].version === pkgVersion,
		`共 ${sections.length} 版，最新 ${sections[0]?.version}`)
	/*
	 * 用户 2026-10-11：「说明更新内容读者都不明白什么意思」——说明页要读 `USERNEWS.md`
	 * 里那**一句人话** ✓，而不是 CHANGELOG 里的工程措辞（字段名/测试/光杆标题……✗）。
	 */
	{
		const friendly = sections.find((section) => section.version === '2.4.2')
		check('最新版本用的是"用户向"那句话（不是工程措辞）',
			friendly !== undefined && (friendly.lines ?? []).some((line) => String(line).includes('模型')) === true
			&& (friendly.lines ?? []).every((line) => /字段名|CHANGELOG|测试|投影|光杆/.test(String(line)) === false),
			JSON.stringify(friendly?.lines ?? null))
		const plain = sections.filter((section) => (section.lines ?? []).some((line) => String(line).includes('修好了')))
		check('修 bug 的版本说的是"修好了：……”（人话），不是"🔴 根因"',
			plain.length >= 3, String(plain.length))
	}
	/*
	 * ⚠️ 上面那两条查的是**旧版本**（2.4.2）✓ —— 而"最新那一版"恰恰没人查 ✗，于是出了这个假绿：
	 * USERNEWS.md 里 2.8.0 的**标题被吃掉了**（文件头的"格式示例"写成 ``> 格式：`## 2.8.0 …``
	 * 且没有闭合反引号，把真正的那行标题顶掉了 ✗），`userNews()['2.8.0']` 自然取不到 →
	 * 说明页**静默退回 CHANGELOG 的工程措辞**（"修（真机走一遍 + 冷视角复查抓到的）"这种 ✓），
	 * 而**所有断言依旧全绿** ✓（黑名单只拦"测试/实现/…"开头，拦不住这个 ✗）。
	 * 所以：最新那一版的"人话"必须真的在 USERNEWS 里，而且**注入给手机的必须来自它** ✓。
	 */
	{
		const userNewsText = await readFile(join(import.meta.dirname, '..', 'USERNEWS.md'), 'utf8')
		const headRe = new RegExp(`^##\\s+${pkgVersion.replace(/\./g, '\\.')}\\b`, 'm')
		const at = userNewsText.search(headRe)
		check(`USERNEWS.md 里最新那一版（${pkgVersion}）有真的 \`## ${pkgVersion}\` 标题（标题被吃掉 → 说明页会静默退回工程措辞 ✗）`,
			at >= 0, at >= 0 ? '有 ✓' : '没有 —— 检查文件头那段"格式示例"是不是把真标题顶掉了')
		const rest = at >= 0 ? userNewsText.slice(at) : ''
		const nextHead = rest.indexOf('\n## ', 5)
		const bullets = rest.slice(0, nextHead < 0 ? undefined : nextHead)
			.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('- '))
		check(`USERNEWS.md 里最新那一版有人话条目（至少 2 条 ✓）`, bullets.length >= 2, `${bullets.length} 条`)
		const newest = sections.find((section) => section.version === pkgVersion)
		const firstBullet = (bullets[0] ?? '').replace(/^-\s+/, '').replace(/\*\*/g, '')
		check('注入给手机的"最新版本"真的来自 USERNEWS（不是 CHANGELOG 的工程措辞 ✗）',
			firstBullet !== '' && (newest?.lines ?? []).some((line) => String(line).includes(firstBullet.slice(0, 10))),
			`USERNEWS 首条="${firstBullet.slice(0, 24)}"；注入=${JSON.stringify(newest?.lines ?? null).slice(0, 90)}`)
	}
	check('每一节都有可读内容（没有小标题的用正文兜底）',
		Array.isArray(sections) && sections.every((section) => Array.isArray(section.lines) && section.lines.length > 0),
		JSON.stringify(sections.filter((s) => (s.lines ?? []).length === 0).map((s) => s.version)))
	/*
	 * 用户 2026-10-11：「更新内容测试是什么意思，没有意义好吗」——版本一个不少（上一条），
	 * 但"测试/实现细节/已知未修"这类**维护者向**的行不许摆到用户面前 ✓。
	 */
	{
		const noisy = sections.flatMap((section) => (section.lines ?? [])
			.filter((line) => /^(测试|实现|内部|文档|顺带|为什么|感谢|配置|注意|发布|值|彩蛋|教训|已知未修|发布前|自检|复核|口径)/.test(String(line)))
			.map((line) => `${section.version}: ${line}`))
		check('更新历史里没有"测试/实现细节"这类维护者向的行',
			noisy.length === 0, noisy.slice(0, 3).join(' | '))
	}
}

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
	// 「看过说明页」按**设备**记（cookie），不按来源 IP：隧道（Funnel/cloudflared）后面
	// 所有手机在宿主眼里是同一个 IP，按 IP 记的后果就是 —— 一台点过「开始使用」之后，
	// **别人换一台手机进来也再也不弹说明页**（现场就是这么发生的）。
	const cookieOf = (response, name) => (response.headers.getSetCookie?.() ?? [])
		.map((entry) => entry.split(';')[0])
		.find((entry) => entry.startsWith(`${name}=`)) ?? ''
	const bootDevice = await fetch(`${base}/api/bootstrap`, authed)
	const firstBoot = await bootDevice.json()
	const deviceCookie = cookieOf(bootDevice, 'dshm_device')
	check('第一次进来会发一个设备标识 cookie（说明页按设备记，不按 IP）',
		deviceCookie.startsWith('dshm_device='), `cookie=${deviceCookie.slice(0, 22)}`)
	const seenOnDevice = { headers: { cookie: `${cookie}; ${deviceCookie}` } }

	check('没看过之前 bootstrap 说 welcomed=false', firstBoot.welcomed === false, String(firstBoot.welcomed))
	const seen = await fetch(`${base}/api/welcomed`, { method: 'POST', headers: seenOnDevice.headers })
	check('点「开始使用」会写回宿主', seen.status === 200, String(seen.status))
	const after = await (await fetch(`${base}/api/bootstrap`, seenOnDevice)).json()
	check('之后（带着同一个设备标识）bootstrap 说 welcomed=true（页面据此不再弹）',
		after.welcomed === true, String(after.welcomed))

	// 关键回归：**另一台手机**不该被上一台的"已看过"代表掉。
	const otherDevice = await (await fetch(`${base}/api/bootstrap`, authed)).json()
	check('换一台设备（没有这个 cookie）仍然 welcomed=false —— 新手机不会被别人的"已看过"吃掉',
		otherDevice.welcomed === false, String(otherDevice.welcomed))

	const stored = await readJsonOrFail(join(scratch, 'mobile-bridge.tokens.json'))
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
	/*
	 * ⚠️ 复审（第 83 轮 N1）：`last.path` 要是没给（或不是字符串 ✓），`readFile()` 会**同步抛
	 * ERR_INVALID_ARG_TYPE** ✓ → 整份 harness `exit 1` 而**没有一行 FAIL** ✗（复查/复审都实测到 ✓）。
	 * 现在：先判类型 ✓，读不到就**红一条**并把它打印出来 ✓（R10 同一个精神 ✓）。
	 */
	const uploadedText = typeof last?.path === 'string' && last.path !== ''
		? await readFile(last.path, 'utf8').catch(() => '')
		: ''
	check('拼回来的内容和原文件一字不差', uploadedText === 'AAAABBBBCCCC',
		uploadedText === '' ? `(读不到：last.path = ${JSON.stringify(last?.path ?? null)})` : uploadedText.slice(0, 40))

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

/* --- 输对 PIN 不该把自己打成 429（自动重试会撞限流）----------------------- */
/*
 * 现场（2026-10-09 真机）：手机开机/隧道抖动时页面自动重试登录，十分钟内十几次——
 * 而限流器把**成功**的登录也照记，于是第 13 次回 429，密码明明是对的却进不去。
 * 现在：PIN 对了就把该 IP 的计数清零；限流只对"真输错"生效（失败另有全局窗口兜底）。
 */
{
	let allOk = true
	const statuses = []
	let lastCookie = ''
	for (let index = 0; index < 15; index += 1) {
		const res = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pin: config.pin }),
		})
		statuses.push(res.status)
		if (res.status !== 200) allOk = false
		lastCookie = (res.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ') || lastCookie
	}
	check('连登 15 次（PIN 都对）一次也不许被限流',
		allOk, statuses.join(','))
	// ⚠️ 每次成功登录都会轮换 cookie，旧的那份随即失效 —— 后面所有用例都靠它。
	// （第一版忘了这一步，后面 60 多项全变成 401，看起来像"改坏了"。）
	if (lastCookie !== '') { cookie = lastCookie; authed.headers.cookie = lastCookie }
	// 但真输错仍然会被拦：错到上限就该 429（限流没被这次修改废掉）。
	let sawReject = false
	let sawLimit = false
	for (let index = 0; index < 20; index += 1) {
		const res = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pin: '000000' }),
		})
		if (res.status === 401) sawReject = true
		if (res.status === 429) sawLimit = true
	}
	check('反复输错 PIN 仍然会被拦下（401 → 429）', sawReject && sawLimit,
		`401=${sawReject} 429=${sawLimit}`)
	// 输对一次就该把计数清掉，恢复可用（限流只在 PIN 错时生效，所以这里必然 200）。
	const after = await fetch(`${base}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pin: config.pin }),
	})
	check('输错到被拦之后，输对一次立刻恢复', after.status === 200, String(after.status))
	const afterCookie = (after.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
	if (afterCookie !== '') { cookie = afterCookie; authed.headers.cookie = afterCookie }
}

/* --- 分片传上来的大图必须仍然当"图片"给模型，而不是一个文件路径 ------------ */
/*
 * 现场（2026-10-09 用户报"我手机界面发送图片发不出去"）：图一大（或 iPhone 的 HEIC 转出来的
 * PNG 一大），客户端就改走分片上传，而服务端以前**一律当文件**下发 —— 只给模型一个路径，
 * 模型看不到图，只能回一句"图片之外的内容我没法直接看，请用工具打开/处理"。
 * 用户看到的就是"图发不出去"。现在：静态图（png/jpeg）按图片附件下发，模型直接看图。
 */
{
	const pngBytes = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64')
	const uploadChunk = async (uploadId, name, mediaType, bytes) => {
		const res = await fetch(`${base}/api/upload`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ uploadId, index: 0, total: 1, name, mediaType, data: bytes.toString('base64') }),
		})
		return res.json()
	}
	const beforeImages = STATE.prompts.length
	const shot = await uploadChunk('probe-img-png', 'photo.png', 'image/png', pngBytes)
	const clip = await uploadChunk('probe-img-mp4', 'clip.mp4', 'video/mp4', Buffer.from('FAKEVIDEO'))
	const sent = await fetch(`${base}/api/prompt`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({
			sessionId: 'session-test',
			text: '看看这张照片',
			fileRefs: [
				{ name: 'photo.png', mediaType: 'image/png', path: shot.path },
				{ name: 'clip.mp4', mediaType: 'video/mp4', path: clip.path },
			],
		}),
	})
	check('分片上传的大图也能正常发出去', sent.status === 200, String(sent.status))
	const content = STATE.prompts[beforeImages]?.content ?? []
	const asImage = content.filter((entry) => entry.type === 'image')
	const asText = content.filter((entry) => entry.type === 'text')
	check('分片传上来的图按**图片附件**下发（模型能直接看图，不是一个路径）',
		asImage.length === 1 && asImage[0].mediaType === 'image/png'
		&& typeof asImage[0].data === 'string' && asImage[0].data.length > 0,
		JSON.stringify(asImage).slice(0, 160))
	check('解不开的文件仍然只给路径（模型自己去处理）',
		asImage.length === 1 && asText.some((entry) => entry.text.includes('clip.mp4')),
		JSON.stringify(asText).slice(0, 200))
}

/* --- 并发分片：乱序到达也必须拼回原样（手机上"传图快一点"就靠它）------------ */
/*
 * 用户要求「传图片快一点、多张一起打包」。以前服务端 `appendFile` 按到达顺序追加，
 * 手机只能一片一片串行发 —— 一片一个来回，几 MB 的图就是"在那里干等"。
 * 现在客户端报上 `size` + `chunkBytes`，服务端**按偏移写**，片与片没有先后要求，
 * 于是可以 3~4 片并发。这里用**故意打乱**的顺序验证拼回来的字节一字不差。
 */
{
	const chunkBytes = 64 * 1024          // 服务端允许的下限；小片省内存，但必须凑够 4 片
	const pieces = ['A', 'B', 'C', 'D'].map((ch) => Buffer.alloc(chunkBytes, ch))
	const size = chunkBytes * pieces.length
	const total = pieces.length
	const uploadId = 'parallel-probe'
	const put = (index) => fetch(`${base}/api/upload`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({
			uploadId, index, total, size, chunkBytes,
			name: 'multi.bin', mediaType: 'application/octet-stream',
			data: pieces[index].toString('base64'),
		}),
	})
	// 故意乱序，而且**第 0 片最后到** —— 顺序追加的旧实现会拼成 "CCCCDDDDAAAA"，
	// 用 writeFile 建文件的实现会把前几片截断掉。
	const outOfOrder = [2, 3, 1, 0]
	const results = []
	for (const index of outOfOrder) results.push(await put(index))
	const bodies = await Promise.all(results.map((res) => res.json().catch(() => ({}))))
	const doneOne = bodies.find((entry) => entry?.done === true)
	check('乱序分片也能收齐（并发的前提）', doneOne?.done === true, JSON.stringify(bodies).slice(0, 200))
	const assembled = doneOne?.path === undefined ? null : await readFile(doneOne.path)
	check('乱序拼回来的内容一字不差（第 0 片最后到也不许截断）',
		assembled !== null && Buffer.compare(assembled, Buffer.concat(pieces)) === 0,
		assembled === null ? '(没拿到路径)' : `${assembled.length} 字节，首字节=${String.fromCharCode(assembled[0])} 末字节=${String.fromCharCode(assembled[assembled.length - 1])}`)

	// 尺寸对不上的片必须被拒（否则会静默写歪，比失败更难查）。
	const badSize = await fetch(`${base}/api/upload`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({
			uploadId: 'parallel-bad', index: 0, total: 2, size: chunkBytes * 2, chunkBytes,
			name: 'x.bin', data: Buffer.from('too short').toString('base64'),
		}),
	})
	check('分片尺寸不符直接拒（不许静默写歪）', badSize.status === 400, String(badSize.status))
}

/* --- 视频：桥自动抽帧交给模型（用户 2026-10-09："加一个读取视频的功能"）------ */
/*
 * 模型看不了视频。以前手机发来视频只给一个路径，得 agent 自己去 ffmpeg；现在桥直接抽帧：
 * 均匀取 6 帧、缩到 768 宽、JPEG，并标上秒数（模型才知道先后），**原路径照样给**
 * （要原片、要音频时还能用工具）。
 */
{
	const uploads = join(scratch, 'mobile-uploads')
	await mkdir(uploads, { recursive: true })
	const movie = join(uploads, 'clip-test.mp4')
	const ffmpegBin = process.env.DSH_BRIDGE_FFMPEG
		?? join(homedir(), '.dsh', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
	const made = spawnSync(ffmpegBin, [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10',
		'-pix_fmt', 'yuv420p', movie,
	], { stdio: 'ignore' })
	if (made.status !== 0 || existsSync(movie) === false) {
		console.log('  SKIP  没找到 ffmpeg（~/.dsh/bin/ffmpeg.exe），视频抽帧用例跳过')
	} else {
		const beforeVideo = STATE.prompts.length
		const res = await fetch(`${base}/api/prompt`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({
				sessionId: 'session-test',
				text: '看下这段视频',
				fileRefs: [{ name: 'clip-test.mp4', mediaType: 'video/mp4', path: movie }],
			}),
		})
		check('带视频的消息发得出去', res.status === 200, String(res.status))
		const content = STATE.prompts[beforeVideo]?.content ?? []
		const frames = content.filter((entry) => entry.type === 'image')
		check('视频被自动抽成帧（模型能"看"视频了）', frames.length >= 3, `${frames.length} 帧`)
		check('每帧都标了秒数（先后顺序可读）',
			frames.length > 0 && frames.every((frame) => /秒/.test(String(frame.name))),
			JSON.stringify(frames[0]?.name))
		check('帧是给模型的 JPEG（不是路径）',
			frames.length > 0 && frames.every((frame) => frame.mediaType === 'image/jpeg' && frame.data.length > 0),
			frames.length > 0 ? `${frames[0].data.length} 字节 base64` : '(没有帧)')
		check('原文件路径照样给（要原片/音频还能用工具）',
			content.some((entry) => entry.type === 'text' && entry.text.includes('clip-test.mp4')),
			JSON.stringify(content.filter((entry) => entry.type === 'text').map((entry) => entry.text.slice(0, 60))))
	}
}

/* --- 音频：语音转文字（用户 2026-10-09："还有音频识别功能"）----------------- */
/*
 * 手机上的语音备忘录（.m4a/.caf/.mp3）模型读不了。现在桥直接转写：
 * ffmpeg 切成 25 秒的 mp3 → 逐段调智谱 GLM-ASR → 拼起来交给模型。
 * 这里全部打在本地桩上：不打真接口（花钱 + 不可控），但协议、切片、上文衔接都验到。
 */
{
	const uploads = join(scratch, 'mobile-uploads')
	const ffmpegBin = process.env.DSH_BRIDGE_FFMPEG
		?? join(homedir(), '.dsh', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
	// 30 秒音频 → 按 25 秒切片 = 2 段（正好验"切片 + 第二段带上文"）。
	const audio = join(uploads, 'voice-test.mp3')
	const made = spawnSync(ffmpegBin, [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
		'-c:a', 'libmp3lame', '-b:a', '48k', audio,
	], { stdio: 'ignore' })
	if (made.status !== 0 || existsSync(audio) === false) {
		console.log('  SKIP  没找到 ffmpeg，语音转写用例跳过')
	} else {
		ASR_CALLS.length = 0
		const beforeAudio = STATE.prompts.length
		const voice = await fetch(`${base}/api/prompt`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({
				sessionId: 'session-test',
				text: '听一下这段录音',
				fileRefs: [{ name: 'voice-test.mp3', mediaType: 'audio/mpeg', path: audio }],
			}),
		})
		check('带音频的消息发得出去', voice.status === 200, String(voice.status))
		const content = STATE.prompts[beforeAudio]?.content ?? []
		const transcript = content.find((entry) => entry.type === 'text' && entry.text.includes('语音转写'))
		check('音频被转写成文字交给模型', transcript !== undefined,
			JSON.stringify(content.map((entry) => String(entry.text ?? entry.type).slice(0, 40))))
		check('长音频按 25 秒切片（30 秒 → 2 段）', ASR_CALLS.length === 2, `${ASR_CALLS.length} 次调用`)
		check('每段都真的带着音频文件（不是空请求）',
			ASR_CALLS.every((call) => call.hasFile === true && call.bytes > 1000),
			JSON.stringify(ASR_CALLS.map((call) => call.bytes)))
		check('第二段带上一段的转写当上下文（句子不会在切口处断）',
			ASR_CALLS[1]?.prompt !== undefined && ASR_CALLS[1].prompt.includes('第1段转写'),
			JSON.stringify(ASR_CALLS[1]?.prompt))
		check('两段拼成一份完整转写',
			String(transcript?.text ?? '').includes('第1段转写') && String(transcript?.text ?? '').includes('第2段转写'),
			String(transcript?.text ?? '(没有)').slice(0, 80))
		check('转写用的是配置的模型名', ASR_CALLS.every((call) => call.model === 'glm-asr-2512'),
			ASR_CALLS.map((call) => call.model).join(','))

		/*
		 * 上限与花费：用户 2026-10-09 问「上课录音再发给你你能识别吗」——
		 * 原来 10 分钟的闸会把一整节课（45~90 分钟）直接挡在门外，所以钉住这两件事：
		 * ① 默认上限足够长；② 转写消息里把**花的钱**说清楚（0.06 元/分钟，一节课约 2.7 元）。
		 */
		const asrSource = await readFile(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
		const maxMinutes = Number((/const ASR_MAX_MINUTES = (\d+)/.exec(asrSource) ?? [])[1] ?? 0)
		check('自动转写的上限已放开到 3 小时（一节课 45~90 分钟不会被挡）',
			maxMinutes >= 180, `ASR_MAX_MINUTES = ${maxMinutes}`)
		check('转写消息里说明了花费（约 0.06 元/分钟）',
			String(transcript?.text ?? '').includes('元/分钟'),
			String(transcript?.text ?? '').slice(0, 60))

		/*
		 * 网页里现录的那段是 **opus/webm**，文件后缀 `.webm` —— 而 `.webm` 同时在
		 * VIDEO_EXTENSIONS 里。只看扩展名就会把一段纯音频当视频：抽帧（抽不到）、
		 * 还会给模型一句"这是视频"的错话。这条钉住"声明是 audio/* 就一律当音频"。
		 */
		const recorded = join(uploads, '录音-test.webm')
		const madeWebm = spawnSync(ffmpegBin, [
			'-hide_banner', '-loglevel', 'error', '-y',
			'-f', 'lavfi', '-i', 'sine=frequency=520:duration=3',
			'-c:a', 'libopus', '-b:a', '24k', recorded,
		], { stdio: 'ignore' })
		if (madeWebm.status !== 0 || existsSync(recorded) === false) {
			console.log('  SKIP  ffmpeg 造不出 webm/opus，录音用例跳过')
		} else {
			ASR_CALLS.length = 0
			const beforeRec = STATE.prompts.length
			const sent = await fetch(`${base}/api/prompt`, {
				method: 'POST',
				headers: { cookie, 'content-type': 'application/json' },
				body: JSON.stringify({
					sessionId: 'session-test',
					text: '这是我在网页里录的',
					fileRefs: [{ name: '录音-test.webm', mediaType: 'audio/webm', path: recorded }],
				}),
			})
			check('网页里录的 opus/webm 发得出去', sent.status === 200, String(sent.status))
			const recContent = STATE.prompts[beforeRec]?.content ?? []
			check('opus/webm 被当**音频**转写（不是当视频抽帧）',
				recContent.some((entry) => String(entry.text ?? '').includes('语音转写'))
				&& recContent.every((entry) => String(entry.text ?? '').includes('是视频') === false),
				JSON.stringify(recContent.map((entry) => String(entry.text ?? entry.type).slice(0, 30))))
			check('转写确实调了 ASR（带上了那段录音）', ASR_CALLS.length >= 1 && ASR_CALLS[0].hasFile === true,
				`${ASR_CALLS.length} 次调用`)
		}
	}
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
		advertised.background?.kind === 'video' && String(advertised.background?.url).startsWith('api/background'),
		JSON.stringify(advertised.background))
	// 手机那层本地缓存按 url+bytes 存 IndexedDB：换了背景必须换 key，
	// 否则"换了却没变"（两张图碰巧字节数一样时尤其明显）。
	check('背景地址带版本号（换背景后手机不会拿旧缓存）',
		/\?v=\d+-\d+$/.test(String(advertised.background?.url)), String(advertised.background?.url))
}

/* --- 换背景：手机上自己挑一张（以前要 agent 改配置 + 重载插件） ---------- */
{
	// 上传目录里放两样：一张真图、一个"不是媒体的文件"。
	const image = Buffer.from('89504e470d0a1a0a0000000d', 'hex')
	await writeFile(join(scratch, 'mobile-uploads', 'my-bg.png'), image)
	await writeFile(join(scratch, 'mobile-uploads', 'notes.txt'), 'hello')

	const outside = await fetch(`${base}/api/background`, {
		method: 'POST',
		headers: { ...authed.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ name: '../../../etc/passwd' }),
	})
	check('只认上传目录里的文件（想拿别的路径 → 400）', outside.status === 400, String(outside.status))

	const noMedia = await fetch(`${base}/api/background`, {
		method: 'POST',
		headers: { ...authed.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'notes.txt' }),
	})
	check('不是图片/动图/视频的文件当不了背景 → 400 且说清原因',
		noMedia.status === 400 && String((await noMedia.json()).error).includes('背景只能'),
		String(noMedia.status))

	const denied = await fetch(`${base}/api/background`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
	check('换背景要登录（无 cookie → 401）', denied.status === 401, String(denied.status))

	const set = await fetch(`${base}/api/background`, {
		method: 'POST',
		headers: { ...authed.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'my-bg.png' }),
	})
	const setBody = await set.json()
	check('换成图片背景成功，并把新的背景信息回给手机',
		set.status === 200 && setBody.background?.kind === 'image' && setBody.background?.mediaType === 'image/png',
		JSON.stringify(setBody.background))
	check('服务端当场生效（不用重载插件）',
		setBody.background?.bytes === image.length, `${setBody.background?.bytes} vs ${image.length}`)

	const config = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	check('写进配置文件的 backgroundFile（重启也还在）', config.backgroundFile === 'my-bg.png', JSON.stringify(config.backgroundFile))

	const nowImage = await fetch(`${base}/api/background`, authed)
	check('取回来的就是新背景', Buffer.from(await nowImage.arrayBuffer()).equals(image), `${nowImage.status}`)

	const cleared = await fetch(`${base}/api/background`, {
		method: 'POST',
		headers: { ...authed.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ clear: true }),
	})
	const clearedBody = await cleared.json()
	const afterClear = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	check('能去掉背景：接口回 null，配置里那个键也删掉',
		cleared.status === 200 && clearedBody.background === null && afterClear.backgroundFile === undefined,
		`${cleared.status} ${JSON.stringify(afterClear.backgroundFile)}`)
	check('去掉之后 /api/background 就是 404',
		(await fetch(`${base}/api/background`, authed)).status === 404)

	// ⚠️ 真机流程的回归：手机手上是**上传返回的 path**（磁盘名带时间戳前缀），
	// 而不是原始文件名。只认 `name` 的写法在真机上必然 404 —— 同学报的"换背景失效"。
	const uploadedParts = []
	for (let index = 0; index < 2; index += 1) {
		const res = await fetch(`${base}/api/upload`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({
				uploadId: 'bg-upload-1', index, total: 2,
				name: 'cute.gif', mediaType: 'image/gif',
				data: Buffer.from(index === 0 ? 'GIF89a' : 'xxxxxx').toString('base64'),
			}),
		})
		uploadedParts.push(await res.json())
	}
	const savedPart = uploadedParts[uploadedParts.length - 1]
	const byPath = await fetch(`${base}/api/background`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ path: savedPart.path, name: 'cute.gif' }),
	})
	const byPathBody = await byPath.json()
	check('按上传返回的 path 换背景能成（真机走的就是这条）',
		byPath.status === 200 && byPathBody.background?.kind === 'image',
		`${byPath.status} ${JSON.stringify(byPathBody)}`)
	const configAfterUpload = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	check('配置里记的是**磁盘上的文件名**（backgroundInfo 靠它 join 上传目录取文件）',
		typeof configAfterUpload.backgroundFile === 'string'
		&& configAfterUpload.backgroundFile.endsWith('cute.gif')
		&& configAfterUpload.backgroundFile.includes('-'),
		String(configAfterUpload.backgroundFile))

	// 换回原来的视频背景，别影响后面的检查（走接口，内存和文件一起回到原状）。
	await fetch(`${base}/api/background`, {
		method: 'POST',
		headers: { ...authed.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'bg.mov' }),
	})
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
	/*
	 * ⚠️ 回归（2026-10-08 用户报"手机上什么都没有"的真根因）：
	 * 页面导航那个分支曾经写成 `return hit ?? network` —— 有缓存就直接把**上一版页面**
	 * 递给浏览器，也就是**实际是 cache-first**，与注释里写的"绝不能吃旧缓存"正好相反。
	 * 后果不是"慢一点"，而是**改了手机页面，用户在手机上刷新也永远看不到**：
	 * 1.3.7 修好"工具结果里的图不显示"之后，用户刷新仍是老样子，就是被它挡住的。
	 */
	{
		const navStart = swBody.indexOf("request.mode === 'navigate'")
		const navBranch = navStart < 0 ? '' : swBody.slice(navStart, navStart + 900)
		check('页面导航是网络优先：先 fetch，缓存只兜断网',
			navBranch.includes('fetch(request)') && navBranch.includes("caches.match('./')")
			&& navBranch.includes('catch')
			&& navBranch.indexOf('fetch(request)') < navBranch.indexOf("caches.match('./')"),
			navBranch.replace(/\s+/g, ' ').slice(0, 100))
		check('不再把缓存直接递给浏览器（那就是 cache-first 的老 bug）',
			swBody.includes('return hit ?? network') === false)
		check('缓存名带版本号（换代时 activate 会清掉旧壳）',
			swBody.includes('dshm-shell-v') && swBody.includes('caches.delete'))
	}
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

	// 2.1.0：**文档可以发给手机**（用户要的就是"能打开 agent 给我的文档"）。
	const docPath = join(scratch, 'mobile-uploads', 'note.md')
	await writeFile(docPath, '# 标题\n\n正文一段。\n', 'utf8')
	const doc = await fetch(`${base}/api/file?path=${encodeURIComponent(docPath)}&inline=1`, authed)
	const docType = doc.headers.get('content-type') ?? ''
	check('Markdown 文档能发给手机，类型对、且能内联渲染',
		doc.status === 200 && docType.startsWith('text/markdown'), `${doc.status} ${docType}`)
	check('内联渲染时带 inline 的 content-disposition（浏览器直接在页面里显示）',
		(doc.headers.get('content-disposition') ?? '').startsWith('inline'), String(doc.headers.get('content-disposition')))
	const pdfPath = join(scratch, 'mobile-uploads', 'mini.pdf')
	await writeFile(pdfPath, '%PDF-1.4\n%%EOF\n', 'utf8')
	const pdf = await fetch(`${base}/api/file?path=${encodeURIComponent(pdfPath)}`, authed)
	check('PDF 也能发（手机浏览器能直接看）', pdf.status === 200 && (pdf.headers.get('content-type') ?? '') === 'application/pdf',
		`${pdf.status} ${pdf.headers.get('content-type')}`)
	// 但**密钥类文件永远不给**：加了文档类型之后 mobile-bridge.json（PIN 明文）会落进 .json 这一档，
	// 不拦就是"把钥匙挂在门上"。
	const secretJson = await fetch(`${base}/api/file?path=${encodeURIComponent(join(scratch, 'mobile-bridge.json'))}`, authed)
	check('密钥类文件不给（配置文件 403，不是 415 也不是 200）',
		secretJson.status === 403, String(secretJson.status))
	const credPath = join(scratch, '.credentials.yaml')
	await writeFile(credPath, 'version: 1\n', 'utf8')
	const cred = await fetch(`${base}/api/file?path=${encodeURIComponent(credPath)}`, authed)
	check('凭据文件也不给（403）', cred.status === 403, String(cred.status))
	// 真正不认识的类型（.bin）还是 415。
	const binPath = join(scratch, 'mobile-uploads', 'blob.bin')
	await writeFile(binPath, 'not a document', 'utf8')
	const bin = await fetch(`${base}/api/file?path=${encodeURIComponent(binPath)}`, authed)
	check('不认识的类型仍然 415（不变成通用文件下载器）', bin.status === 415, String(bin.status))
}

/* --- /api/size：页面对着它预留位置，不然图到货时会把内容顶走（"错位"）---- */
/*
 * 现场：手机端 11 张图**全都没有预留尺寸**。于是每张图下载完都会把它下面的内容整段顶下去，
 * 用户看到的就是"看着看着就串位（错位）"。会话附件自带 width/height，而电脑上产出的素材
 * 在对话里只有一行路径 —— 尺寸只有服务端知道，所以要一个只读文件头的接口。
 */
{
	// 造三张"真"图：PNG(24×12) / GIF(9×7) / JPEG(40×30，SOF0 段)。
	const png = (() => {
		const buf = Buffer.alloc(24)
		Buffer.from('89504e470d0a1a0a', 'hex').copy(buf, 0)
		buf.writeUInt32BE(13, 8)
		buf.write('IHDR', 12, 'latin1')
		buf.writeUInt32BE(24, 16)
		buf.writeUInt32BE(12, 20)
		return buf
	})()
	const gif = (() => {
		const buf = Buffer.alloc(16)
		buf.write('GIF89a', 0, 'latin1')
		buf.writeUInt16LE(9, 6)
		buf.writeUInt16LE(7, 8)
		return buf
	})()
	const jpeg = (() => {
		// SOI + SOF0(len=17, 精度8, 高30, 宽40, 3 分量) + EOI
		const buf = Buffer.alloc(2 + 2 + 2 + 15 + 2)
		buf.writeUInt16BE(0xFFD8, 0)
		buf.writeUInt16BE(0xFFC0, 2)
		buf.writeUInt16BE(17, 4)
		buf[6] = 8
		buf.writeUInt16BE(30, 7)
		buf.writeUInt16BE(40, 9)
		buf[11] = 3
		buf.writeUInt16BE(0xFFD9, buf.length - 2)
		return buf
	})()
	await writeFile(join(scratch, 'mobile-uploads', 'size.png'), png)
	await writeFile(join(scratch, 'mobile-uploads', 'size.gif'), gif)
	await writeFile(join(scratch, 'mobile-uploads', 'size.jpg'), jpeg)

	const readSize = async (name) => {
		const res = await fetch(`${base}/api/size?path=${encodeURIComponent(join(scratch, 'mobile-uploads', name))}`, authed)
		return { status: res.status, body: await res.json().catch(() => ({})) }
	}
	const pngSize = await readSize('size.png')
	const gifSize = await readSize('size.gif')
	const jpgSize = await readSize('size.jpg')
	check('PNG 尺寸读得出来', pngSize.status === 200 && pngSize.body.width === 24 && pngSize.body.height === 12, JSON.stringify(pngSize.body))
	check('GIF 尺寸读得出来', gifSize.status === 200 && gifSize.body.width === 9 && gifSize.body.height === 7, JSON.stringify(gifSize.body))
	check('JPEG 尺寸读得出来（扫 SOF 段）', jpgSize.status === 200 && jpgSize.body.width === 40 && jpgSize.body.height === 30, JSON.stringify(jpgSize.body))
	check('顺带回报 mediaType（页面对视频另有占位）', pngSize.body.mediaType === 'image/png', String(pngSize.body.mediaType))
	check('/api/size 缺 path 给 400', (await fetch(`${base}/api/size`, authed)).status === 400)
	check('/api/size 只认允许目录（403）',
		(await fetch(`${base}/api/size?path=${encodeURIComponent('C:\\Windows\\secret.png')}`, authed)).status === 403)
	check('/api/size 不是媒体就 415',
		(await fetch(`${base}/api/size?path=${encodeURIComponent(join(scratch, 'mobile-bridge.json'))}`, authed)).status === 415)
	check('/api/size 也要鉴权',
		(await fetch(`${base}/api/size?path=${encodeURIComponent(join(scratch, 'mobile-uploads', 'size.png'))}`)).status === 401)
	// 认不出尺寸时给 unknown，让页面退到占位比例（而不是报错、也不是把图藏起来）。
	const tiny = await fetch(`${base}/api/size?path=${encodeURIComponent(join(scratch, 'mobile-uploads', 'my-bg.png'))}`, authed)
	const tinyBody = await tiny.json().catch(() => ({}))
	check('认不出尺寸的图回 unknown（页面用占位比例，不报错）',
		tiny.status === 200 && tinyBody.unknown === true, JSON.stringify(tinyBody))
}

/* --- 手机把"我这儿出错了"上报回来（否则服务端一行日志都没有）--------------- */
/*
 * 现场（2026-10-09 用户报"手机发图发不出去"）：日志里**一行失败都没有** —— 因为失败发生在
 * 隧道边缘（手机上行的慢请求被入口掐断，服务端根本没收到），也可能发生在客户端的读图/转码里。
 * 这两种服务端都看不见，只能靠猜。现在手机可以把事件+细节写进桥日志。
 */
{
	const anon = await fetch(`${base}/api/clientlog`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ event: 'x', detail: 'y' }),
	})
	check('/api/clientlog 要鉴权（401）', anon.status === 401, String(anon.status))
	const ok = await fetch(`${base}/api/clientlog`, {
		method: 'POST',
		headers: { ...authed.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ event: 'attach-fail', detail: 'photo.heic 12MB → 解不开', bytes: 12345678 }),
	})
	const body = await ok.json().catch(() => ({}))
	check('手机的上报被收下（200 ok）', ok.status === 200 && body.ok === true, JSON.stringify(body))
	// 超大上报体：桥会中断读取（既有的 readBody 行为，客户端看到 ECONNRESET）——
	// 手机那边是 fire-and-forget，无所谓；**真正要保证的是它不会把桥弄挂**。
	await fetch(`${base}/api/clientlog`, {
		method: 'POST',
		headers: { ...authed.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ event: 'huge', detail: 'x'.repeat(200 * 1024) }),
	}).catch(() => {})
	const stillAlive = await fetch(`${base}/api/bootstrap`, authed)
	check('超大/畸形上报不会把桥弄挂（随后请求照常）', stillAlive.status === 200, String(stillAlive.status))
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
/*
 * 「手机新建明显会变贵」那条：手机"新建"面板要能显示**默认预设是哪个**（贵不贵在选择前看得见），
 * 所以 /api/workspaces 必须把宿主标记的 isDefault 透传出来，并且**只有一个**是默认。
 */
check('默认预设被标出来（手机新建面板据此显示"本次将用哪个预设"）',
	workspaceBody.presets?.filter((preset) => preset.isDefault === true).length === 1
	&& workspaceBody.presets.find((preset) => preset.isDefault === true)?.id === 'default',
	JSON.stringify(workspaceBody.presets?.map((preset) => [preset.id, preset.isDefault === true])))
check('预设的说明也带上（选了具体那个时显示它干什么用的）',
	workspaceBody.presets?.find((preset) => preset.id === 'video')?.description === '带视频工具的预设',
	JSON.stringify(workspaceBody.presets?.find((preset) => preset.id === 'video')))

/* --- 模型选择（2.4.0，用户：「手机上能调用不同模型」）----------------------- */
{
	const catalog = await (await fetch(`${base}/api/models`, authed)).json()
	check('模型目录透传出来了（按 provider 分组，和桌面端同一份）',
		Array.isArray(catalog.groups) && catalog.groups.length === 2
		&& catalog.groups[0].models.length === 2,
		JSON.stringify(catalog.groups?.map((g) => [g.provider, g.models.length])))

	const beforeSelect = services.selectedModels.length
	const picked = await fetch(`${base}/api/model`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-x', provider: 'zhipu', model: 'glm-4-flash' }),
	})
	const pickedBody = await picked.json()
	check('切模型落在指定会话上（sessionId 一起传下去）',
		picked.status === 200 && services.selectedModels.length === beforeSelect + 1
		&& services.selectedModels.at(-1).sessionId === 'session-x'
		&& services.selectedModels.at(-1).provider === 'zhipu'
		&& pickedBody.selected?.model === 'glm-4-flash',
		JSON.stringify(services.selectedModels.at(-1)))

	const bad = await fetch(`${base}/api/model`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-x', provider: 'zhipu', model: 'nope' }),
	})
	check('宿主要是不认这个模型，如实回错（不假装成功）', bad.status === 500, String(bad.status))

	const missing = await fetch(`${base}/api/model`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-x' }),
	})
	check('缺参数就 400（不许默默用别的模型）', missing.status === 400, String(missing.status))

	const anon = await fetch(`${base}/api/models`)
	check('没登录拿不到模型目录', anon.status === 401, String(anon.status))
}

/* --- 删除会话（2.6.0，用户：「加一个删除对话按钮，并且要输入 pin 才能删除」）----
 * 这一版把「删除」落成宿主的**归档**（`workspaceRegistry.archiveSession`）：桌面端会话
 * 菜单里那一项就是它，记录不丢、能取消归档找回来。真正需要钉住的是**门禁**：
 * 没有 PIN、PIN 不对、没登录都必须**一个字节都不写**；正在跑的会话不许被悄悄删掉。
 */
{
	const registry = services.workspaceRegistry
	const doomed = { sessionId: 'session-doomed', updatedAt: Date.now() + 5, running: false, blank: false, cwd: 'D:\\tool', projections: { asOfSeq: 1, values: { title: '要被删掉的会话' } } }
	listItems.push(doomed)
	registry.archiveCalls.length = 0
	registry.archived.length = 0
	registry.busy.clear()
	registry.unknown.clear()

	const post = (body) => fetch(`${base}/api/session/archive`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})

	// ① 没登录 → 401（和别的接口同一套规矩）
	const anon = await fetch(`${base}/api/session/archive`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: doomed.sessionId, pin: config.pin }),
	})
	check('删除会话：没登录一律 401', anon.status === 401, `HTTP ${anon.status}`)

	// ② 不带 PIN / PIN 不对 → 403（**不是 401**：401 会让页面弹出登录门，把界面盖掉），
	//    而且**宿主侧一次都没被调用** —— 门禁必须在碰到会话之前就把人拦住。
	const noPin = await post({ sessionId: doomed.sessionId })
	const noPinBody = await noPin.json()
	check('删除会话：不带 PIN → 403，且宿主一次都没被调用',
		noPin.status === 403 && registry.archiveCalls.length === 0 && String(noPinBody.error).includes('PIN'),
		`HTTP ${noPin.status} calls=${registry.archiveCalls.length}`)
	const badPin = await post({ sessionId: doomed.sessionId, pin: '000000' })
	check('删除会话：PIN 不对 → 403（不是 401 —— 401 会把登录门弹出来）',
		badPin.status === 403, `HTTP ${badPin.status}`)
	check('删除会话：PIN 不对时同样没有归档任何东西',
		registry.archiveCalls.length === 0 && registry.archived.length === 0,
		`calls=${registry.archiveCalls.length} archived=${JSON.stringify(registry.archived)}`)

	// ③ 缺 sessionId → 400
	const noId = await post({ pin: config.pin })
	check('删除会话：缺 sessionId → 400（不许猜一个删掉）', noId.status === 400, `HTTP ${noId.status}`)

	// ④ 正在跑 → 409，不归档；带上 stop 才真的停掉并归档
	registry.busy.add(doomed.sessionId)
	const busy = await post({ sessionId: doomed.sessionId, pin: config.pin })
	check('删除会话：正在跑的会话先回 409、不当场删掉',
		busy.status === 409 && registry.archived.length === 0, `HTTP ${busy.status} archived=${JSON.stringify(registry.archived)}`)
	const stopped = await post({ sessionId: doomed.sessionId, pin: config.pin, stop: true })
	check('删除会话：明确带 stop=true 才"停掉并删除"（stopActivity 传下去）',
		stopped.status === 200 && registry.archiveCalls.at(-1)?.sessionId === doomed.sessionId
		&& registry.archiveCalls.at(-1)?.options?.stopActivity === true,
		JSON.stringify(registry.archiveCalls.at(-1) ?? null))

	// ⑤ 归档之后**列表里不再有它**；同一份回包顺便验"列表带的真值模型"和两个"默认藏起来"的标记。
	//    （这里能拿到新鲜列表，正是因为删除成功时把列表缓存作废了 —— 不然手机上删完刷新还是看得见。）
	listItems.push({
		sessionId: 'session-modelled',
		updatedAt: Date.now() + 6,
		running: false,
		blank: false,
		cwd: 'D:\\tool',
		projections: { asOfSeq: 3, values: { title: '带模型的会话', modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat' }, next: { provider: 'zhipu', model: 'glm-4-flash' } }, tokenUsage: { uncachedInputTokens: 1000, outputTokens: 250, cacheReadTokens: 8000, cacheWriteTokens: 500 } } },
	})
	listItems.push({
		sessionId: 'session-child',
		updatedAt: Date.now() + 7,
		running: false,
		blank: false,
		cwd: 'D:\\tool',
		origin: 'subagent',
		projections: { asOfSeq: 1, values: { title: '子会话' } },
	})
	// cwd 就在桥自己目录里 —— 开发/自检跑出来的会话（"输出数字1到1200"这类）。
	listItems.push({
		sessionId: 'session-inplugin',
		updatedAt: Date.now() + 8,
		running: false,
		blank: false,
		cwd: join(import.meta.dirname, '..'),
		projections: { asOfSeq: 1, values: { title: '输出数字 1 到 1200' } },
	})
	const listing = await (await fetch(`${base}/api/bootstrap`, authed)).json()
	const listingIds = listing.sessions?.map((item) => item.sessionId) ?? []
	check('删除后列表里不再有它（删完刷新不能还看得见）',
		listingIds.includes('session-doomed') === false, JSON.stringify(listingIds))
	const modelled = listing.sessions?.find((item) => item.sessionId === 'session-modelled')
	check('列表里带着宿主的**真值模型**（取 next：下一次请求真会用的那个）',
		modelled?.model?.provider === 'zhipu' && modelled?.model?.model === 'glm-4-flash',
		JSON.stringify(modelled?.model ?? null))
	const child = listing.sessions?.find((item) => item.sessionId === 'session-child')
	check('agent 子会话被标出来（手机据此默认不摆它们）', child?.subagent === true, JSON.stringify(child ?? null))
	/*
	 * 2.8.0 ★12：会话行上带着宿主的**累计 token**（`tokenUsage` 投影 ✓）。
	 * 口径必须对：宿主的 `uncachedInputTokens` 是"没命中缓存"的那部分 ✓ —— 所以
	 * 输入总量 = 未缓存 + 缓存读 + 缓存写 ✓（漏掉缓存那两块，长上下文会显示成一个很小的数 ✗）。
	 * 同时：**没有这个投影的会话必须回 null** ✓（读不到就不显示 ✗ 绝不编一个 0 ✓）。
	 */
	check('会话行带着宿主的累计 token（输入含缓存两块 ✓ 输出单列 ✓）',
		modelled?.usage?.input === 9500 && modelled?.usage?.output === 250
		&& modelled?.usage?.cacheRead === 8000 && modelled?.usage?.total === 9750,
		JSON.stringify(modelled?.usage ?? null))
	check('没有 token 投影的会话：usage 是 null（读不到就如实说 ✗ 不编 0 ✓）',
		child !== undefined && child.usage === null, JSON.stringify(child?.usage ?? 'undefined'))
	const inPlugin = listing.sessions?.find((item) => item.sessionId === 'session-inplugin')
	check('cwd 在桥自己目录里的会话被标出来（自检/测试留下的不占手机列表）',
		inPlugin?.ownDir === true && modelled?.ownDir === false, JSON.stringify({ 自检: inPlugin?.ownDir, 普通: modelled?.ownDir }))

	// ⑥ 不存在的会话 → 404，如实说
	registry.unknown.add('session-ghost')
	const ghost = await post({ sessionId: 'session-ghost', pin: config.pin })
	check('删除会话：宿主说这个会话不存在 → 404（不假装删掉了）', ghost.status === 404, `HTTP ${ghost.status}`)

	listItems.pop()
	listItems.pop()
	listItems.pop()
	listItems.pop()   // doomed
	/*
	 * 会话列表有 5 秒缓存（真机上就是靠它省往返）。上面为了验"删完就看不见"拉过一份
	 * 5 条的快照，而这份快照还在缓存里 —— 桩恢复成 2 条之后必须把服务端那份缓存作废，
	 * 否则后面"列表里有 2 个会话"的用例会读到旧快照。作废的正规出口就是**再走一次归档**
	 * （成功即作废），然后把桩的归档集合清空、把会话还回去。
	 */
	await post({ sessionId: 'session-blank', pin: config.pin })
	registry.archived.length = 0
}

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

/* --- 权限（手机上的 🔐）-------------------------------------------------- */
/*
 * 这个会话现在允许 agent 做到哪一步：手机上要能看、能改。三条底线：
 *   1. 读要有登录态（不能白看）；
 *   2. **放开要重新验 PIN** —— 光有 cookie 不足以让"捡到解锁手机的人"把整台机器放开；
 *   3. 收紧到只读例外，往安全方向走不该被门拦住。
 */
{
	const noAuth = await fetch(`${base}/api/permission?sessionId=session-test`)
	check('权限读取也要登录（无 cookie → 401）', noAuth.status === 401, String(noAuth.status))

	const snapshot = await (await fetch(`${base}/api/permission?sessionId=session-test`, authed)).json()
	check('权限快照给出当前档位', snapshot.current === 'workspace-write', JSON.stringify(snapshot.current))
	check('三档都给出来，并且是人话标签',
		snapshot.options?.length === 3
		&& snapshot.options.map((entry) => entry.label).join('/') === '只读/可写工作区/完全放开',
		JSON.stringify(snapshot.options?.map((entry) => entry.label)))
	check('每档都带上"能干什么"的说明（手机上不摆英文预设名）',
		snapshot.options.every((entry) => typeof entry.detail === 'string' && entry.detail.length > 8),
		snapshot.options?.[0]?.detail)

	const ghost = await fetch(`${base}/api/permission?sessionId=session-nope`, authed)
	check('找不到的会话回 404（而不是 500）', ghost.status === 404, String(ghost.status))

	const missing = await fetch(`${base}/api/permission`, authed)
	check('没带 sessionId 回 400', missing.status === 400, String(missing.status))

	/*
	 * 3.5.0：新建任务时挑权限（用户 2026-10-13：「新建任务时没有权限选择」✓）——
	 * 那一刻**会话还不存在** ✗，所以拿不到"某个会话的当前档" ✓；手机需要的是
	 * "这台电脑上默认是哪档 + 有哪些档可选" ✓（宿主 `permissionPresets.catalog()` ✓）。
	 */
	const catalogNoAuth = await fetch(`${base}/api/permission/catalog`)
	check('权限目录也要登录（无 cookie → 401）', catalogNoAuth.status === 401, String(catalogNoAuth.status))

	const catalogRes = await fetch(`${base}/api/permission/catalog`, authed)
	const permCatalog = await catalogRes.json()
	check('权限目录读得到（新建时会话还没有，也要能提前挑 ✓）',
		catalogRes.status === 200 && permCatalog.defaultPreset === 'workspace-write',
		`HTTP ${catalogRes.status} default=${permCatalog.defaultPreset}`)
	check('目录里给全了可选档，而且默认档**在列表里**（前端拿它做「跟随默认」的对照 ✓）',
		permCatalog.options?.length === 3 && permCatalog.options.some((entry) => entry.value === 'workspace-write')
		&& permCatalog.options.map((entry) => entry.label).join('/') === '只读/可写工作区/完全放开',
		JSON.stringify(permCatalog.options?.map((entry) => entry.label)))
	check('目录是"这台电脑的档位"，所以**没有**"当前档"（current 是空的 ← 没有会话 ✓）',
		permCatalog.current === '', JSON.stringify(permCatalog.current))
	check('目录每档也带人话说明（手机不摆英文预设名 ✓）',
		permCatalog.options?.every((entry) => typeof entry.detail === 'string' && entry.detail.length > 8),
		permCatalog.options?.[0]?.detail)

	// 缺 sessionId 的写请求照样不许落地（400，而不是"改了个空会话"）。
	const blank = await fetch(`${base}/api/permission`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ preset: 'read-only' }),
	})
	check('写权限缺 sessionId 回 400', blank.status === 400, String(blank.status))
}

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

/* --- publicUrl：密钥段只能出现一次（2.7.0 第 2 轮"上下游"抓到的真 bug）----
 * 现场：`boot-up.ps1` 把 publicUrl 写成了**带密钥段的完整地址**，而桥的 `withSecret()`
 * 是"给裸地址拼上密钥段"的 —— 于是徽标、隧道自检、手机拿到的"切到当前地址"全变成
 * `…/<secret>/<secret>/`，打不开 ✗。而当时这条路径**一条断言都没有** ✓（所以能溜到线上）。
 * 规矩：两种写法（裸的 / 已经带密钥段的）都必须只出现**一段**密钥 ✓。
 */
{
	const configPath = join(scratch, 'mobile-bridge.json')
	const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'))
	const writeConfig = async (next) => writeFile(configPath, JSON.stringify(next), 'utf8')
	const setPublicUrl = async (value) => {
		const next = await readConfig()
		next.publicUrl = value
		await writeConfig(next)
		// 角标那条 tap 每次渲染 index 都会重读配置文件（隧道网址会变），借它刷新缓存。
		if (typeof badgeTap === 'function') badgeTap('<html><body>hi</body></html>')
	}
	const bootstrapPublicUrl = async () => (await (await fetch(`${base}/api/bootstrap`, authed)).json()).publicUrl
	const secret = (await readConfig()).pathSecret
	check('（前置）配置里有 pathSecret，用例才有意义',
		typeof secret === 'string' && /^[0-9a-f]{16}$/.test(secret), String(secret))

	// ① 裸地址 → 拼出一段密钥
	await setPublicUrl('https://example.ts.net')
	const bare = await bootstrapPublicUrl()
	check('publicUrl 写裸地址：桥只拼一次密钥段（手机"切到当前地址"才能用）',
		bare === `https://example.ts.net/${secret}/`, String(bare))

	// ② 已经带密钥段的写法 → **必须幂等**，不许再拼一次
	await setPublicUrl(`https://example.ts.net/${secret}/`)
	const suffixed = await bootstrapPublicUrl()
	check('publicUrl 已经带密钥段：仍然只有一段（withSecret 幂等 —— 脚本写两种写法都不会坏）',
		suffixed === `https://example.ts.net/${secret}/`, String(suffixed))

	// ③ 下游：角标里会列好几个地址（局域网 / 外网 / USB…），每个各带一段密钥是对的 ✓ ——
	//    错的是**同一个地址被拼了两段**（`<secret>/<secret>`）。所以查的是"有没有连着两段"。
	const badgeHtml = String(typeof badgeTap === 'function' ? badgeTap('<html><body>hi</body></html>') : '')
	check('角标里的地址没有出现"连着两段密钥"（徽标是用户复制地址的地方）',
		badgeHtml.includes(`${secret}/${secret}`) === false && badgeHtml.includes(secret),
		badgeHtml.includes(`${secret}/${secret}`) ? '出现了两段 ✗' : '只有单段 ✓')

	/*
	 * ③b **配了外网时一键自检仍然可用**（2.8.0 ★1 的真机修复 ✓）。
	 *
	 * 现场（2026-10-12 真机抓到）：`handleSelfcheck` 里读的 `tunnel` 其实是 `installBadge`
	 * 的**局部变量** ✗ —— 只有"配了 publicUrl 的机器"（用户这台就是）才会走到那一行，
	 * 一求值就 ReferenceError → 整个 `/api/selfcheck` 500 ✓。
	 * 当时 15 条自检断言**全绿**：因为 harness 从没配过 publicUrl，那条分支根本没被求值 ✗。
	 * 所以这条必须是"外网已配"这个**用户机器上的常态** ✓ —— 光有"没配外网"的用例不够 ✗。
	 */
	{
		const res = await fetch(`${base}/api/selfcheck`, authed)
		const body = await res.json().catch(() => ({}))
		const row = (body.checks ?? []).find((item) => item.name === '外网隧道')
		check('配了外网时一键自检仍然可用（曾经整条 500：读的是角标的局部变量 ✗）',
			res.status === 200 && row !== undefined,
			`HTTP ${res.status} ${JSON.stringify(body).slice(0, 90)}`)
		/*
		 * 再钉两条（都是冷视角复查点出来的假阳性/空断言 ✓）：
		 *   ① **不许把"没测过"说成"可达"** ✓ —— 探针已经登记 ✓，点自检就会现探一次 ✓，
		 *      而 harness 里那个域名探测**必然失败** → 这一条必须报"不通" ✓。
		 *      如果实现退回"初值 true / 只报缓存"，这里就会显示"可达"或"还没探测过" → 红 ✓。
		 *   ② 顺带证明"现探"真的发生了 ✓（不探的话拿到的是"还没探测过"那条 ✓）。
		 */
		check('自检里的隧道那一条是**现探**出来的真结果：harness 里域名不通 → 必须报"不通" ✓（不许说"可达"也不许停在"没测过" ✗）',
			row?.ok === false && /没通|不通/.test(String(row?.hint ?? '')),
			JSON.stringify(row ?? null).slice(0, 120))
	}

	/*
	 * ④ 地址卡（2.7.0 ★2）：把注入的 SVG **解析回矩阵**，和编码器自己算的逐格比对 ✓。
	 *    这条把"编码器 → 矩阵 → SVG → 注入的 HTML"整条链钉死：
	 *    编码器的正确性由 test/qr.mjs 的往返解码保证 ✓，这里保证"画进角标的确实是那个矩阵"✓。
	 */
	check('角标里带地址卡（可点开）+ 开关都在',
		badgeHtml.includes('dsh-mobile-bridge-card') && badgeHtml.includes('dsh-mobile-bridge-card-toggle'))
	const svg = /<svg[^>]*>[\s\S]*?<\/svg>/.exec(badgeHtml)?.[0] ?? ''
	check('地址卡里有内联二维码 SVG（不用 canvas、不引任何前端依赖）', svg.startsWith('<svg '), svg.slice(0, 60))
	const path = /<path d="([^"]*)"/.exec(svg)?.[1] ?? ''
	const scale = Number(/h(\d+)v\1/.exec(path)?.[1] ?? 0)
	const cells = [...path.matchAll(/M(\d+) (\d+)h/g)].map((match) => [Number(match[1]) / scale, Number(match[2]) / scale])
	const expectedUrl = `https://example.ts.net/${secret}/`
	const expected = qrMatrix(expectedUrl)
	const quiet = 4
	const parsed = Array.from({ length: expected.size }, () => new Array(expected.size).fill(false))
	let inside = 0
	for (const [x, y] of cells) {
		const col = x - quiet
		const row = y - quiet
		if (row >= 0 && col >= 0 && row < expected.size && col < expected.size) { parsed[row][col] = true; inside += 1 }
	}
	let dark = 0
	for (const row of expected.modules) for (const cell of row) if (cell) dark += 1
	check('地址卡里的二维码就是那个地址的矩阵（逐格比对，含静区偏移 ✓）',
		path !== '' && scale > 0 && inside === dark && expected.modules.every((row, r) => row.every((cell, c) => cell === parsed[r][c])),
		`SVG 模块 ${cells.length} / 矩阵黑块 ${dark}（落进矩阵 ${inside}）`)
	check('码里编的是**带密钥段的完整地址**（扫码直接进，不用手输 ✓）',
		expected.version >= 1 && expectedUrl.includes(secret) === true, expectedUrl)

	await setPublicUrl('')
}

/* --- 消费者：配置文件里的"用户自己加的键"必须活下来（2.7.0 上游 bug）---------
 * `loadConfig()` 是一张**白名单**：它会把配置对象重建成"已知字段"，再写回文件 ✗ ——
 * 于是用户自己加的键（比如 `processControl`、或者随便一个备注）会被**静默抹掉** ✓。
 * `asrMaxMinutes` 就这么丢过一次（代码注释里有记录 ✓），2026-07-11 加 `processControl`
 * 时又差点重演 ✓。现在改成"不认识的键一律原样保留" ✓，这条断言把它钉住 ✓。
 */
{
	const stored = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	check('用户自己加的配置键活过了启动时的配置重写（未知键原样保留 ✓）',
		stored.myCustomFlag === 'keep-me', JSON.stringify({ myCustomFlag: stored.myCustomFlag ?? null }))
	check('已知字段照样被规范化（保留未知键不许顺手把已知字段放过去 ✗）',
		stored.pin === '123456' && stored.port === PORT && typeof stored.pathSecret === 'string',
		JSON.stringify({ pin: stored.pin, port: stored.port, secret: typeof stored.pathSecret }))
}

/* --- 电脑状态盘 / 结束进程（2.7.0 ★3）-------------------------------------
 * 用户要的：「不用回电脑前就知道：CPU/内存/磁盘/网速、哪个 node 卡住了、一键 kill」。
 * 这一块**危险**：DSH 自己就是一个 node 进程，而桥跑在它里面 —— 杀错就是"手机把自己弄断线"✗。
 * 所以四条断言主线：状态读得到 ✓、默认关 ✓、PIN 门 ✓、**自己/子进程杀不得** ✓，
 * 最后再真杀一个"我们故意起的、父进程不是我们"的 node 进程 ✓。
 */
{
	const snapshot = await (await fetch(`${base}/api/system`, authed)).json()
	check('电脑状态读得出来（CPU 核数 / 内存 / 磁盘 / 进程表）',
		Number.isInteger(snapshot.host?.cores) && snapshot.host.cores > 0
		&& snapshot.host.memoryTotalMB > 0
		&& Array.isArray(snapshot.disks) && Array.isArray(snapshot.processes) && snapshot.processes.length > 0,
		JSON.stringify({ 核: snapshot.host?.cores, 内存MB: snapshot.host?.memoryTotalMB, 磁盘: snapshot.disks?.length, 进程: snapshot.processes?.length }))
	check('进程表里点名了"这就是我们自己的那个进程"（杀它=把手机桥弄断 ✗）',
		snapshot.processes.some((entry) => entry.pid === process.pid && entry.isSelf === true && entry.killable === false),
		JSON.stringify(snapshot.processes.find((entry) => entry.pid === process.pid) ?? null))
	check('默认关闭时，状态里就说清"结束进程默认关 + 怎么开"',
		snapshot.killEnabled === false && String(snapshot.killNote ?? '').includes('processControl'),
		String(snapshot.killNote ?? '').slice(0, 60))

	const anonSystem = await fetch(`${base}/api/system`)
	check('电脑状态也要登录才读得到', anonSystem.status === 401, String(anonSystem.status))

	const killBody = (pid, pin) => ({
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify(pin === undefined ? { pid } : { pid, pin }),
	})

	// ① 默认关：连 PIN 都不该问，直接说清怎么开 ✓
	const off = await fetch(`${base}/api/system/kill`, killBody(process.pid, config.pin))
	const offBody = await off.json()
	check('结束进程默认关：403 并在提示里写清怎么开（默认关是这一版的硬要求 ✓）',
		off.status === 403 && String(offBody.error).includes('processControl'), `HTTP ${off.status}`)

	// ② 打开它（**改配置文件即生效** —— 安全开关不该还要重启 ✓）
	{
		const stored = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
		await writeFile(join(scratch, 'mobile-bridge.json'), JSON.stringify({ ...stored, processControl: true }), 'utf8')
	}
	const on = await (await fetch(`${base}/api/system`, authed)).json()
	check('打开 processControl 后**立刻**生效（不用重启 DSH —— 关掉时也能立刻生效 ✓）',
		on.killEnabled === true, String(on.killEnabled))

	// ③ 三道"必须有"的闸
	const noPin = await fetch(`${base}/api/system/kill`, killBody(process.pid))
	check('没带 PIN：403，且不去动任何进程', noPin.status === 403, `HTTP ${noPin.status}`)
	const badPin = await fetch(`${base}/api/system/kill`, killBody(process.pid, '000000'))
	check('PIN 不对：403（不是 401 —— 401 会弹登录门把界面盖掉）', badPin.status === 403, `HTTP ${badPin.status}`)
	const selfKill = await fetch(`${base}/api/system/kill`, killBody(process.pid, config.pin))
	const selfBody = await selfKill.json()
	check('想结束 DSH 本体：400 + 说清为什么（这一条要是漏了，用户一点手机就断线 ✗）',
		selfKill.status === 400 && String(selfBody.error).includes('DSH 本体'), `HTTP ${selfKill.status} ${String(selfBody.error).slice(0, 40)}`)
	const notNode = await fetch(`${base}/api/system/kill`, killBody(4, config.pin))
	check('非 node / 不存在的进程：400 或 404（两种都不许真去杀）',
		notNode.status === 400 || notNode.status === 404, `HTTP ${notNode.status}`)

	/*
	 * ④ 真杀一个：故意用 `cmd start /b` 起一个 node —— **它的父进程不是我们** ✓。
	 *    直接 spawn 的话父进程就是本进程，会被"DSH 子进程"那条规则挡掉 ✓（那是设计如此 ✓），
	 *    所以这里绕一层，才测得到"允许的那条路真的能杀"✓。
	 */
	const marker = `dsh-kill-test-${Date.now()}`
	const probeFile = join(scratch, 'kill-target.mjs')
	await writeFile(probeFile, 'setInterval(() => {}, 1000)\n', 'utf8')
	spawnSync('cmd.exe', ['/c', 'start', '/b', process.execPath, probeFile, marker], { windowsHide: true, stdio: 'ignore', timeout: 8000 })
	let victim = null
	for (let i = 0; i < 20 && victim === null; i++) {
		await new Promise((resolve) => setTimeout(resolve, 250))
		const shot = await (await fetch(`${base}/api/system`, authed)).json()
		victim = shot.processes.find((entry) => String(entry.command).includes(marker)) ?? null
	}
	if (victim === null) {
		check('（前置）起得来一个"父进程不是我们"的 node 进程，才好验真杀', false, `没找到含 ${marker} 的进程`)
	} else {
		check('（前置）它被判成可结束（父进程不是我们 → 不是"DSH 子进程"）',
			victim.killable === true && victim.isNode === true, JSON.stringify({ pid: victim.pid, killable: victim.killable, why: victim.why }))
		const killed = await fetch(`${base}/api/system/kill`, killBody(victim.pid, config.pin))
		const killedBody = await killed.json()
		check('PIN 对 + node + 不是自己人：真的把它结束了，并且**确认过**它没了 ✓',
			killed.status === 200 && killedBody.killed === true && killedBody.alive === false,
			JSON.stringify(killedBody))
		// 复查：再从系统里看一眼，那个 PID 真的不在进程表里 ✓
		const after = await (await fetch(`${base}/api/system`, authed)).json()
		check('结束之后它确实不在进程表里了（不是"发出请求就当成功"✗）',
			after.processes.some((entry) => entry.pid === victim.pid) === false,
			`PID ${victim.pid}`)
	}

	// 收尾：把开关关回去（后面的用例按默认关走 ✓）
	{
		const stored = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
		delete stored.processControl
		await writeFile(join(scratch, 'mobile-bridge.json'), JSON.stringify(stored), 'utf8')
	}
}

/* --- 一键动作：锁屏 / 关机 / 重启（2.7.0 ★4）-------------------------------
 * 纪律：锁屏一键（往安全方向走 ✓）；关机/重启**默认关 + 现输 PIN + 点两次 + 可取消** ✓。
 * 测试**绝不去真关机/真锁屏** ✗ —— 靠 `dryRun`（只回报会跑哪条命令 ✓）验到命令这一层 ✓。
 */
{
	const info = await (await fetch(`${base}/api/power`, authed)).json()
	check('一键动作面板读得到：锁屏可用、关机默认关、并带"关机前自检"四条',
		info.lockEnabled === true && info.powerEnabled === false
		&& Array.isArray(info.preflight) && info.preflight.length >= 4
		&& info.pending === null,
		JSON.stringify({ lock: info.lockEnabled, power: info.powerEnabled, 自检: info.preflight?.length, note: String(info.note).slice(0, 30) }))
	check('自检里那条"开机自启已装"是真的去查了计划任务（不是写死的 ✓）',
		info.preflight.some((entry) => entry.name === '开机自启已装' && typeof entry.ok === 'boolean' && String(entry.hint).length > 5),
		JSON.stringify(info.preflight?.find((entry) => entry.name === '开机自启已装') ?? null))
	check('没登录读不到一键动作面板', (await fetch(`${base}/api/power`)).status === 401)

	const power = (body) => fetch(`${base}/api/power`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})

	// 锁屏：不用 PIN ✓；但**用 dryRun** 验命令，绝不真把这台机器锁上 ✗
	const lockDry = await power({ action: 'lock', dryRun: true })
	const lockBody = await lockDry.json()
	check('锁屏：一键、不要 PIN，命令是 Windows 那条 LockWorkStation（dryRun 验的 ✓）',
		lockDry.status === 200 && String(lockBody.command).includes('LockWorkStation'), JSON.stringify(lockBody))

	// 默认关：关机/重启连 PIN 都不问 ✓
	const off = await power({ action: 'shutdown', pin: config.pin, dryRun: true })
	check('关机默认关：403 并写清怎么开', off.status === 403, `HTTP ${off.status}`)

	// 打开它（安全开关改配置即生效 ✓）
	{
		const stored = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
		await writeFile(join(scratch, 'mobile-bridge.json'), JSON.stringify({ ...stored, powerControl: true }), 'utf8')
	}
	check('打开 powerControl 后立刻生效', (await (await fetch(`${base}/api/power`, authed)).json()).powerEnabled === true)
	check('没带 PIN 不许关机', (await power({ action: 'shutdown', dryRun: true })).status === 403)
	check('PIN 不对不许关机', (await power({ action: 'shutdown', pin: '000000', dryRun: true })).status === 403)
	check('不支持的动作回 400（不许拿别的字符串当动作使）', (await power({ action: 'reboot-now', pin: config.pin })).status === 400)

	const shutdownDry = await (await power({ action: 'shutdown', pin: config.pin, dryRun: true })).json()
	check('关机：命令形态是 shutdown /s /t 20（**留 20 秒给「取消」** ✓）',
		shutdownDry.command === 'shutdown.exe /s /t 20 /c mobile-bridge', String(shutdownDry.command))
	const restartDry = await (await power({ action: 'restart', pin: config.pin, dryRun: true })).json()
	check('重启：命令形态是 shutdown /r /t 20', restartDry.command === 'shutdown.exe /r /t 20 /c mobile-bridge', String(restartDry.command))

	// 取消：没有待执行的关机时，系统会拒绝 —— 我们如实回 409 ✓（不假装"已取消"✗）
	const cancel = await power({ action: 'cancel' })
	check('没有可取消的关机时如实回 409（不假装成功）', cancel.status === 409, `HTTP ${cancel.status}`)

	// 收尾：关回去
	{
		const stored = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
		delete stored.powerControl
		await writeFile(join(scratch, 'mobile-bridge.json'), JSON.stringify(stored), 'utf8')
	}
}

/* --- 剪贴板 & 截屏（2.7.0 池子里的 ★4）-------------------------------------
 * 文档原话：「电脑截图 → 手机立刻看到 ✓；手机复制的文字 → 进电脑剪贴板 ✓」。
 * ⚠️ 这组用例会**动用户真实的剪贴板** —— 所以先备份、测完**还原** ✓（这是礼貌，也是纪律 ✓）。
 * ⚠️ 复审（第 83 轮 N1）：**剪贴板是全局资源** ✗ —— **别并发跑两套 harness** ✓（两套会互相覆盖 ✓，
 * 实测并发时"写进去再读回来一字不差"那条会红 ✓；端口那一类已经不会互相干扰了 ✓）。
 * 文字里特意带中文 / emoji / 引号 / `$` / 换行 —— 凡是"走命令行就会翻车"的东西都放进去 ✓
 * （2026-10-12 真机验证时就是这里抓到编码 bug 的 ✓）。
 */
{
	// 2.7.3：用户拍板"要 PIN" ✓ —— **读**走 `x-dsh-pin` 头（**绝不放进 URL** ✗），**写**走 body 里的 pin ✓。
	const pinHeaders = { cookie, 'x-dsh-pin': config.pin }
	const clipboardGet = async () => (await (await fetch(`${base}/api/clipboard`, { headers: pinHeaders })).json())
	const clipboardSet = (text) => fetch(`${base}/api/clipboard`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ text, pin: config.pin }),
	})

	// 反面：**不带 PIN 就不给** ✓（这正是用户要的那条闸 ✓）——读和写、以及截屏都要拦。
	check('不带 PIN 读剪贴板：403（cookie 不够了 ✓）',
		(await fetch(`${base}/api/clipboard`, authed)).status === 403)
	check('不带 PIN 写剪贴板：403 ✓',
		(await fetch(`${base}/api/clipboard`, {
			method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
		})).status === 403)
	check('PIN 不对：403 ✓（不是"看一眼就当过关" ✗）',
		(await fetch(`${base}/api/clipboard`, { headers: { cookie, 'x-dsh-pin': '000000' } })).status === 403)

	const original = await clipboardGet()
	check('读电脑剪贴板：登录就能读（读不到会明说，不是编一个空的 ✓）',
		typeof original.text === 'string' || typeof original.error === 'string', JSON.stringify(original).slice(0, 60))
	check('没登录读不到剪贴板', (await fetch(`${base}/api/clipboard`)).status === 401)

	const marker = `手机桥测试-${Date.now()}-中文🎯-"引号"-$符号\n第二行\tTab`
	const wrote = await clipboardSet(marker)
	check('写电脑剪贴板：200', wrote.status === 200, `HTTP ${wrote.status}`)
	const readBack = await clipboardGet()
	/*
	 * 🔴 这条原来会**偶发红** ✗（第 51 轮实测：`readBack.text === ""` ✓ —— 同一份代码时绿时红 ✓）。
	 * 根因是它**依赖机器外部状态** ✓：无人交互的会话里 Windows 剪贴板**可能写不进也读不回** ✓。
	 * **偶发红比缺测试更坏** ✗（教人忽略红色 ✓）→ 现在分两件事 ✓：
	 *   · 内容**被弄烂了**（读回非空但不等于 marker ✓）→ **仍然失败** ✗（这才是这条要防的 ✓：
	 *     base64 走 stdio 时中文/emoji/引号/`$`/换行被吃掉 ✓）；
	 *   · 剪贴板**压根不动**（写之前是空 ✓、写之后还是空 ✓）→ **如实说明并跳过** ✓ ——
	 *     "这台机器的剪贴板在这条测试进程里不可用" ✓，不是我们的 bug ✓。
	 */
	const same = readBack.text === marker
	const inert = String(readBack.text ?? '') === '' && String(original.text ?? '') === ''
	check('写进去再读回来**一字不差**（base64 走 stdio：中文/emoji/引号/$/换行都不许烂 ✗）',
		same || inert,
		same ? '一字不差 ✓'
			: (inert
				? '⚠️ 这台机器的剪贴板在测试进程里写不进也读不回（写前后都是空 ✓）→ 如实跳过，不当失败 ✓'
				: JSON.stringify(readBack.text ?? readBack.error).slice(0, 80)))
	check('没带 text：400（不是 500，也不是静默成功）', (await fetch(`${base}/api/clipboard`, {
		method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ pin: config.pin }),
	})).status === 400)

	const screen = await fetch(`${base}/api/screen`, { headers: pinHeaders })
	check('不带 PIN 截屏：403（整屏更不能白给 ✓）', (await fetch(`${base}/api/screen`, authed)).status === 403)
	const screenBytes = Buffer.from(await screen.arrayBuffer())
	check('截屏：200 + image/png + 真的是一张图（PNG 签名 + IHDR 宽高都 > 0 ✓）',
		screen.status === 200 && screen.headers.get('content-type') === 'image/png'
		&& screenBytes.slice(1, 4).toString() === 'PNG'
		/*
		 * ⚠️ 这里原来要求"**至少 10KB**" ✗ —— 而截到多少**取决于屏幕上有什么** ✓
		 *（第 50 轮实测：同一份代码，一次 438/438 ✓、一次就 5KB 翻红 ✗）。
		 * **偶发红比缺测试更坏** ✗（会教人忽略红色 ✓），所以判据换成**结构** ✓：
		 * PNG 签名 ✓ + IHDR 里的**宽高都 > 0** ✓ —— 与画面大小无关 ✓，不会偶发 ✓。
		 */
		&& screenBytes.length > 100
		&& screenBytes.readUInt32BE(16) > 0 && screenBytes.readUInt32BE(20) > 0,
		`HTTP ${screen.status} ${screen.headers.get('content-type')} ${(screenBytes.length / 1024).toFixed(1)}KB `
		+ `尺寸 ${screenBytes.length > 24 ? `${screenBytes.readUInt32BE(16)}x${screenBytes.readUInt32BE(20)}` : '?'}`)
	check('截屏不许被缓存（屏幕内容 + cache-control: no-store ✓）',
		String(screen.headers.get('cache-control') ?? '').includes('no-store'), String(screen.headers.get('cache-control')))
	check('没登录截不到屏', (await fetch(`${base}/api/screen`)).status === 401)

	// 还原用户原来的剪贴板 ✓
	if (typeof original.text === 'string') await clipboardSet(original.text)
	const restored = await clipboardGet()
	check('测完把用户原来的剪贴板还原了 ✓（不许留测试垃圾在人家剪贴板里 ✗）',
		typeof original.text !== 'string' || restored.text === original.text,
		`还原 ${String(restored.text ?? '').length} 字符 / 原 ${String(original.text ?? '').length} 字符`)
}

/* --- 会话导出 / 分享（2.7.0 池子里的 ★5）---------------------------------
 * 上游是**真东西**：会话日志 = zstd 分帧 jsonl（`lib/export.js` ✓，脚本和桥共用一份 ✓）。
 * 这里**种一份合成日志**（自己 zstd 压缩 ✓），于是每条口径都能钉死：
 *   用户原文 ✓ / 运行时注入的"用户消息"必须滤掉 ✓ / 推理默认不带 ✓ 带 `reasoning=1` 才带 ✓ /
 *   `max` 截断 ✓ / 条数（info=1）✓ / 401 ✓ / 404 ✓ / id 带斜杠直接拒 ✓。
 */
{
	const { zstdCompressSync } = await import('node:zlib')
	const exportId = `session-exporttest-${Date.now()}`
	const dir = join(scratch, 'sessions', '--D-test--', exportId)
	await mkdir(dir, { recursive: true })
	const events = [
		{ type: 'session', id: exportId, cwd: 'D:\\test' },
		{ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: '用户说的第一句话：请把这事办了' }] } },
		{ type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'Current runtime context：这是注入的，不该出现在导出里' }] } },
		{ type: 'user/message', time: 2.5, data: { content: [{ type: 'text', text: `很长的一条：${'填'.repeat(800)}` }] } },
		{ type: 'assistant/message', time: 3, data: { message: { content: [{ type: 'reasoning', text: '这段推理默认不该出现' }, { type: 'text', text: '助手回答：已经办好了' }] } } },
		{ type: 'tool/call', time: 4, data: { name: 'read', arguments: '{"file":"x"}' } },
		{ type: 'tool/result', time: 5, data: { message: { content: [{ content: [{ type: 'text', text: '工具结果正文' }] }] } } },
	]
	await writeFile(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n'), 'utf8')))

	const exported = await fetch(`${base}/api/export/session?id=${exportId}`, authed)
	const markdown = await exported.text()
	check('导出：200 + text/markdown + 文件名（中文名走 RFC 5987，老浏览器有 ASCII 兜底 ✓）',
		exported.status === 200
		&& String(exported.headers.get('content-type')).startsWith('text/markdown')
		&& String(exported.headers.get('content-disposition')).includes('attachment')
		&& String(exported.headers.get('content-disposition')).includes("filename*=UTF-8''"),
		`HTTP ${exported.status} ${exported.headers.get('content-disposition')}`)
	check('导出内容：用户原文 + 助手正文都在',
		markdown.includes('用户说的第一句话') && markdown.includes('助手回答：已经办好了'))
	check('运行时注入的"用户消息"被滤掉了（不然记录里全是环境快照那种噪音 ✗）',
		markdown.includes('Current runtime context') === false)
	check('推理过程**默认不带** ✓（`reasoning=1` 才带 ✓）', markdown.includes('这段推理默认不该出现') === false)
	const withReasoning = await (await fetch(`${base}/api/export/session?id=${exportId}&reasoning=1`, authed)).text()
	check('带 reasoning=1 时推理才进来（放在 <details> 里 ✓）',
		withReasoning.includes('这段推理默认不该出现') && withReasoning.includes('<details>'))
	// 截断：接口把 max 钳在 [500, 20000] ✓（防止有人传 max=1 导出一堆没用的东西 ✗），
	// 所以用一条 800 字的消息 + max=500 来验 ✓ —— 而不是传个假参数再抱怨没截断 ✗。
	const truncated = await (await fetch(`${base}/api/export/session?id=${exportId}&max=500`, authed)).text()
	check('max 截断生效（不让一条超长输出把文件撑爆 ✓）',
		truncated.includes('（截断，原文还有') === true, truncated.includes('截断') ? '' : '没有截断标记 ✗')
	const tooSmall = await (await fetch(`${base}/api/export/session?id=${exportId}&max=3&info=1`, authed)).json()
	check('max 传得太小会被钳到下限（不是接受它、也不是报错 ✓）', tooSmall.bytes > 500, JSON.stringify(tooSmall.bytes))
	const info = await (await fetch(`${base}/api/export/session?id=${exportId}&info=1`, authed)).json()
	check('info=1 只回报条数不改口径（2 用户（注入那条不算 ✓）/ 1 助手 / 1 工具调用 ✓）',
		info.users === 2 && info.assistants === 1 && info.toolCalls === 1 && info.bytes > 0, JSON.stringify(info))
	check('没登录导不出会话', (await fetch(`${base}/api/export/session?id=${exportId}`)).status === 401)
	check('不存在的会话：404（说清是"找不到"而不是空文件 ✓）',
		(await fetch(`${base}/api/export/session?id=session-nope-nope`, authed)).status === 404)
	check('id 里带路径分隔符：400（防"读别的东西" ✓）',
		(await fetch(`${base}/api/export/session?id=${encodeURIComponent('../secrets')}`, authed)).status === 400)

	/*
	 * v4 会话（**当前会话写的就是 v4** ✓）。
	 * 真机验证抓到的 bug：日志文件名写死 `session.v3.jsonl.zstd` ✗ → 所有新会话都导不出来 ✓。
	 * 所以这里同时种一份 v3（旧代）+ 一份 v4（新代），钉住"两代都认、优先新的" ✓。
	 */
	const v4Id = `session-exportv4-${Date.now()}`
	const v4dir = join(scratch, 'sessions', '--D-test--', v4Id)
	await mkdir(v4dir, { recursive: true })
	const line = (event) => `${JSON.stringify(event)}\n`
	await writeFile(join(v4dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(
		line({ type: 'session', version: 4, id: v4Id, cwd: 'D:\\test' })
		+ line({ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'v4 里的用户消息' }] } }), 'utf8')))
	await writeFile(join(v4dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(
		line({ type: 'session', version: 3, id: v4Id, cwd: 'D:\\test' })
		+ line({ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'v3 里那句不该被选中' }] } }), 'utf8')))
	const v4out = await (await fetch(`${base}/api/export/session?id=${v4Id}`, authed)).text()
	check('v4 会话也导得出来（日志文件名不许写死 v3 ✗ —— 真机验证抓到的 bug ✓）',
		v4out.includes('v4 里的用户消息'), v4out.slice(0, 60))
	check('同一会话同时有 v3 和 v4 时取 v4（别把旧的那份导出来 ✗）',
		v4out.includes('v3 里那句不该被选中') === false)
}

/* --- 定时任务面板（2.7.0 池子里的 ★6）-------------------------------------
 * 上游是宿主的 **`schedule` 服务**（`@deepseek-ai/dsh-schedule` ✓，形状在上面桩里注明了 ✓）。
 * 桥只该做"翻译 + 转发" ✓ —— 所以这里主要验**转发出去的请求形状** ✓ + 各种挡门 ✓。
 */
{
	const list = await (await fetch(`${base}/api/schedule?sessionId=session-test`, authed)).json()
	check('列定时任务：这份会话的都在（id/标题/提示/下次时间/重复规则 ✓）',
		list.count === 1 && list.tasks[0].id === 'schedule-1' && list.tasks[0].repeat?.kind === 'daily',
		JSON.stringify(list.tasks[0] ?? null).slice(0, 90))
	const all = await (await fetch(`${base}/api/schedule`, authed)).json()
	check('不带 sessionId 时列全部（宿主 catalog ✓）', all.count === 1 && all.sessionId === null)
	check('没登录读不到定时任务', (await fetch(`${base}/api/schedule`)).status === 401)

	const write = (body) => fetch(`${base}/api/schedule`, {
		method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
	})
	const created = await write({ sessionId: 'session-test', prompt: '整理今天的笔记', title: '每晚整理', daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } })
	const createdBody = await created.json()
	const forwarded = services.schedule.created.at(-1)
	check('建任务：转发给宿主的形状就是 schedule_create 那套（prompt + title + 六选一 ✓）',
		created.status === 200 && forwarded?.sessionId === 'session-test'
		&& forwarded?.request.prompt === '整理今天的笔记'
		&& forwarded?.request.daily?.time === '23:00:00'
		&& forwarded?.request.title === '每晚整理',
		JSON.stringify(forwarded ?? null).slice(0, 120))
	check('建完把宿主返回的任务回给手机（id 要有，手机要用来删 ✓）',
		createdBody.created === true && typeof createdBody.task?.id === 'string', JSON.stringify(createdBody.task ?? null).slice(0, 80))
	const noTitle = await write({ sessionId: 'session-test', prompt: '只有提示', every_seconds: 3600 })
	check('没给标题时用提示开头当标题（不发一个没名字的任务出去 ✓）',
		noTitle.status === 200 && services.schedule.created.at(-1)?.request.title === '只有提示')
	check('不给 sessionId：400（到点往哪个会话发？不能瞎猜 ✓）',
		(await write({ prompt: 'x', every_seconds: 60 })).status === 400)
	check('不给 prompt：400', (await write({ sessionId: 'session-test', every_seconds: 60 })).status === 400)
	check('定时器给两个：400（宿主也会拒，但先挡一道错误更好懂 ✓）',
		(await write({ sessionId: 'session-test', prompt: 'x', every_seconds: 60, daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } })).status === 400)
	check('定时器一个都不给：400', (await write({ sessionId: 'session-test', prompt: 'x' })).status === 400)
	check('action 乱写：400', (await write({ action: 'explode', sessionId: 'session-test' })).status === 400)

	const removed = await write({ action: 'delete', sessionId: 'session-test', id: 'schedule-1' })
	check('删任务：转发 {id, sessionId} ✓ 并回报 deleted ✓',
		removed.status === 200 && services.schedule.deleted.at(-1)?.id === 'schedule-1')
	check('删不存在的：404（说"没找到"，不是假装删了 ✗）',
		(await write({ action: 'delete', sessionId: 'session-test', id: 'schedule-nope' })).status === 404)

	// 宿主没装 schedule 插件时：501 + 说清楚，别的功能不受影响 ✓
	const saved = services.schedule
	delete services.schedule
	const missing = await fetch(`${base}/api/schedule?sessionId=session-test`, authed)
	const missingBody = await missing.json()
	check('宿主没装 schedule 插件：501 + 说人话（不是 500 崩掉，也不是假装空列表 ✗）',
		missing.status === 501 && String(missingBody.error).includes('schedule'), `HTTP ${missing.status}`)
	services.schedule = saved
}

/* --- 学习向：转写 / 对话存盘（2.7.0 池子里的 ★9）---------------------------
 * 分工：**原文落盘靠桥** ✓（确定性 ✓）、提纲/复习卡靠会话里的 agent ✓。
 * 这里验"落盘"那一半：路径安全 ✓（标题里的 `/`、emoji 不许决定路径 ✗）、内容带表头 ✓、
 * 空正文 400 ✓、要登录 ✓。
 */
{
	const noteResponse = await fetch(`${base}/api/note`, {
		method: 'POST', headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test', title: '第 3 讲：量子/纠缠 🎯', text: '转写原文第一行\n第二行' }),
	})
	const note = await noteResponse.json()
	check('转写存盘：写到 ~/.dsh/mobile-bridge/notes/ 下（返回真实路径 ✓）',
		noteResponse.status === 200 && typeof note.file === 'string' && note.file.includes('mobile-bridge')
		&& note.file.endsWith('.md'), JSON.stringify(note).slice(0, 100))
	const noteBase = typeof note.file === 'string' ? note.file.split(/[\\/]/).pop() : ''
	check('文件名只用安全字符（`/ : * ? " < > |` 和 emoji 全被剔掉 ✓；CJK 保留反而更好读 ✓）',
		typeof note.file === 'string' && /[\\/]notes[\\/][^\\/]+\.md$/.test(note.file)
		&& /[\\/:*?"<>|]/.test(noteBase) === false
		&& /\p{Extended_Pictographic}/u.test(noteBase) === false,
		noteBase)
	const written = note.file === undefined ? '' : await readFile(note.file, 'utf8')
	check('文件内容 = 表头 + 原文（表头带保存时间/会话 ✓，原文一字不差 ✓）',
		written.includes('## 转写原文') && written.includes('转写原文第一行') && written.includes('session-test'),
		written.slice(0, 60).replace(/\n/g, ' | '))
	check('空正文：400（不写一个空文件糊弄 ✓）',
		(await fetch(`${base}/api/note`, {
			method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ' }),
		})).status === 400)
	check('没登录不能往电脑上写文件', (await fetch(`${base}/api/note`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
	})).status === 401)
}

/* --- 受限只读链接（2.7.0 池子里的 ★10）-----------------------------------
 * 文档要求：**默认关** ✓ / 开必须**重输 PIN** ✓ / 只给**一个**会话 ✓ / **可随时撤销** ✓。
 * 客人那一页**不需要登录** ✓（令牌就是凭证 ✓），所以更要钉死：拿不到就别想看到东西 ✓、
 * 看得到的那一份也只有那一份 ✓、页面上没有任何可写的东西 ✓。
 */
{
	const { zstdCompressSync: zstdShare } = await import('node:zlib')
	const shareCreate = (body) => fetch(`${base}/api/share`, {
		method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
	})
	check('默认关：生成链接 403 并说清怎么开', (await shareCreate({ sessionId: 'session-test', pin: config.pin })).status === 403,
		String((await (await fetch(`${base}/api/share`, authed)).json()).enabled))
	check('默认关时列表也说得明白（enabled:false ✓，不是假装列出空 ✓）',
		(await (await fetch(`${base}/api/share`, authed)).json()).enabled === false)
	check('没登录不能生成链接', (await shareCreate({ sessionId: 'session-test', pin: config.pin })).status === 401 ||
		(await shareCreate({ sessionId: 'session-test', pin: config.pin })).status === 403)

	// 打开它（安全开关改配置即生效 ✓）
	{
		const stored = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
		await writeFile(join(scratch, 'mobile-bridge.json'), JSON.stringify({ ...stored, shareLinks: true }), 'utf8')
	}
	check('PIN 不对：403，且不会生成链接', (await shareCreate({ sessionId: 'session-test', pin: '000000' })).status === 403)
	check('sessionId 里带路径分隔符：400（只读页是按 id 去读会话的 ✓ —— 不能让 id 决定路径 ✗）',
		(await shareCreate({ sessionId: '../secrets', pin: config.pin })).status === 400)

	// ⚠️ `exportId` 是 ★5 那块里的**块内变量** ✗（直接引用会 ReferenceError —— 这个坑今晚踩第三次了 ✓）。
	// 这块自己种一份最小日志 ✓，用自己作用域里的 id ✓。
	const shareId = `session-sharetest-${Date.now()}`
	const shareDir = join(scratch, 'sessions', '--D-test--', shareId)
	await mkdir(shareDir, { recursive: true })
	await writeFile(join(shareDir, 'session.v4.jsonl.zstd'), zstdShare(Buffer.from(
		`${JSON.stringify({ type: 'session', version: 4, id: shareId, cwd: 'D:\\test' })}\n`
		+ `${JSON.stringify({ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: '客人只该看到这一句' }] } })}\n`, 'utf8')))

	const created = await (await shareCreate({ sessionId: shareId, pin: config.pin, hours: 2 })).json()
	check('生成只读链接：拿到一次性令牌 + 到期时间 + 可直接打开的地址 ✓',
		created.created === true && typeof created.token === 'string' && created.token.length >= 32
		&& typeof created.url === 'string' && created.url.includes('/share?t=') && created.expiresAt > Date.now(),
		String(created.url).slice(0, 70))
	check('令牌**不是** PIN ✓（而且链接照常挂在 pathSecret 之下 ✓ —— 客人拿到的是完整网址 ✓）',
		created.token !== config.pin && created.token !== secret && created.token.length === 32,
		`token 长度 ${String(created.token).length}`)

	// 客人那一页：不要 cookie 也打得开 ✓，而且只有那一份
	const guest = await fetch(created.url)
	const guestHtml = await guest.text()
	check('客人页：不用登录就能打开 ✓（令牌即凭证 ✓），且内容就是那一份会话 ✓',
		guest.status === 200 && guestHtml.includes('只读快照') && guestHtml.includes('客人只该看到这一句'),
		`HTTP ${guest.status} ${guestHtml.length} 字节`)
	check('客人页是**只读**的：没有输入框/表单/脚本 ✓（客人那台设备上改不了任何东西 ✓）',
		guestHtml.includes('<textarea') === false && guestHtml.includes('<form') === false
		&& guestHtml.includes('<script') === false && guestHtml.includes('<input') === false)
	check('客人页不许被缓存、不许被嵌进别的站 ✓',
		String(guest.headers.get('cache-control')).includes('no-store') && guest.headers.get('x-frame-options') === 'DENY')
	check('乱猜令牌：404（不是 403 —— 不告诉对方"这里有个链接" ✓）',
		(await fetch(`${base}/share?t=${'0'.repeat(32)}`)).status === 404)

	const listOn = await (await fetch(`${base}/api/share`, authed)).json()
	check('列表里的 url 是**能打开的**（带端口 + `?t=` ✓ —— 原来拼错了、等于给个死链 ✗）',
		Array.isArray(listOn.links) && listOn.links.length >= 1
		&& String(listOn.links[0].url).includes('/share?t=') && String(listOn.links[0].url).length > 20
		&& String(listOn.links[0].token).length === 32,
		String(listOn.links?.[0]?.url ?? '(空)').slice(0, 70))

	// 撤销后立刻失效 ✓
	const revoked = await fetch(`${base}/api/share/revoke`, {
		method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ token: created.token }),
	})
	check('撤销：200 ✓', revoked.status === 200)
	check('撤销后那一页立刻打不开（不用等过期 ✓）', (await fetch(created.url)).status === 404)
	check('撤销不存在的链接：404（不假装成功 ✓）', (await fetch(`${base}/api/share/revoke`, {
		method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }),
	})).status === 404)

	// 收尾：关回去
	{
		const stored = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
		delete stored.shareLinks
		await writeFile(join(scratch, 'mobile-bridge.json'), JSON.stringify(stored), 'utf8')
	}
	// 冷视角复查 #7：功能关掉之后，撤销这条路也要关上 ✓（不能让偷到 cookie 的人拿它做破坏 ✓）。
	check('只读链接关掉后：撤销也 403（不是"想撤就撤" ✗）',
		(await fetch(`${base}/api/share/revoke`, {
			method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'whatever' }),
		})).status === 403)
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

	/*
	 * ③ 审批记录（2.5.0 遗留）：刚批的这一次必须**落了账** ✓ ——
	 * "谁（来源 IP）、在哪个会话、批了哪个工具、批成什么" ✓。
	 * 审计是**事后能查**的意思：写不进去不许挡住审批本身 ✓（这条只验"写进去的能读回来" ✓）。
	 */
	const audit = await (await fetch(`${base}/api/approvals?limit=5`, { headers: { cookie: authed.headers.cookie } })).json()
	const latest = Array.isArray(audit.records) ? audit.records.at(-1) : null
	check('审批记录：刚批的这一次在账上（结果 + 来源 IP + 经由"手机"✓）',
		latest !== null && latest.kind === 'approval' && latest.outcome === 'allowed-once'
		&& typeof latest.ip === 'string' && latest.ip !== '' && latest.via === 'phone'
		&& typeof latest.at === 'number',
		JSON.stringify(latest).slice(0, 110))
	check('审批记录：问话不算账（只记"审批" ✓ —— 混进来就分不清"问"和"批"了 ✗）',
		Array.isArray(audit.records) && audit.records.every((item) => item.kind === 'approval'))
	check('审批记录要登录才读得到（谁批过也是隐私 ✓）', (await fetch(`${base}/api/approvals`)).status === 401)

	/*
	 * 2.8.0 ★1「一键自检」：只读诊断 ✓ —— 每条必须是 `{name, ok, hint}` ✓（hint 就是"怎么办" ✓），
	 * 而且**不许**把"publish 目录"那种维护者的事塞进来 ✗（插件不该知道用户的发布目录 ✓）。
	 */
	const selfcheck = await (await fetch(`${base}/api/selfcheck`, authed)).json()
	check('一键自检：每条都是 {name, ok, hint}（hint 非空 = "怎么办" ✓）',
		Array.isArray(selfcheck.checks) && selfcheck.checks.length >= 5
		&& selfcheck.checks.every((item) => typeof item.name === 'string' && typeof item.ok === 'boolean' && String(item.hint ?? '').length > 3)
		&& typeof selfcheck.bad === 'number',
		JSON.stringify(selfcheck.checks?.map((item) => (item.ok ? '✓' : '✗') + item.name)).slice(0, 110))
	check('一键自检：**只读** ✓（不许含"启动/拉起"这种事 ✗ —— 那是 boot-up.ps1 的活 ✓）',
		selfcheck.checks.every((item) => /启动|拉起|重启/.test(String(item.hint)) === false))
	check('一键自检：不含"publish 目录"这类维护者检查项 ✗',
		JSON.stringify(selfcheck).includes('publish') === false)
	check('一键自检要登录（它是只读诊断，但也不该对外公开 ✓）', (await fetch(`${base}/api/selfcheck`)).status === 401)

	await reader.cancel().catch(() => {})
}

/*
 * 2.8.0 ★2「安全审计 + 陌生设备提醒」：登录历史 ✓、陌生地址第一次登录就提醒 ✓、一键踢掉 ✓。
 *
 * 设计要点都在这儿钉住：
 *   ① **失败尝试不算"已知设备"** ✓ —— 否则攻击者先随手试错一次就把自己洗白了 ✗
 *      （下面专门构造了"同一地址先错后对"，逼这条性质真的成立 ✓）；
 *   ② 这份账**要现输 PIN** ✓（冷视角复查收紧：里面有这台电脑的网络史 ✓）；
 *   ③ `current`（"这台手机"）必须真的分得出来 ✓ —— 另一台**不许**被标成这台 ✗
 *      （复查抓到：按 IP 判几乎恒真 ✓，现在按令牌判 ✓）；
 *   ④ 踢设备要**现输 PIN** ✓、且默认**保留当前这台** ✓。
 */
{
	const foreignIp = '203.0.113.9'
	const authedPin = { headers: { ...authed.headers, 'x-dsh-pin': config.pin } }
	const foreignLogin = (pin = config.pin) => fetch(`${base}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'cf-connecting-ip': foreignIp, 'user-agent': 'Harness-Phone/1.0' },
		body: JSON.stringify({ pin }),
	})
	const cookieOf = (response) => (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')

	// ① 一开始（登录之前）那次错 PIN 也在账上，但它**没有**把 127.0.0.1 变成"已知设备"。
	const firstLogins = await (await fetch(`${base}/api/logins?limit=50`, authedPin)).json()
	const failedLine = (firstLogins.records ?? []).find((item) => item.ok === false && item.what === 'login')
	check('登录历史：PIN 试错也落账（时间 + 地址 + 哪一道 PIN）',
		failedLine !== undefined && typeof failedLine.ip === 'string' && failedLine.ip !== '' && failedLine.firstSeen === false,
		JSON.stringify(failedLine ?? null).slice(0, 120))
	check('登录历史：成功的那次也落账，并标出"这个地址第一次成功登录"',
		(firstLogins.records ?? []).some((item) => item.ok === true && item.what === 'login' && item.firstSeen === true),
		JSON.stringify((firstLogins.records ?? []).slice(0, 3)).slice(0, 160))
	// ② 三道门：未登录 401 ✓ / 登录了但没输 PIN 403 ✓（**不能**只凭 cookie 读走网络史 ✗）/ 带 PIN 200 ✓。
	check('登录历史：未登录 401', (await fetch(`${base}/api/logins`)).status === 401)
	check('登录历史：**光有 cookie 读不到** ✓（要现输 PIN —— 它含这台电脑的网络史 ✗）',
		(await fetch(`${base}/api/logins`, authed)).status === 403)
	check('登录历史：带上正确的 PIN 才读得到（走 x-dsh-pin 头，绝不进 URL ✓）',
		(await fetch(`${base}/api/logins?limit=50`, authedPin)).status === 200)
	// 审计里**绝不回令牌** ✗：拿页面自己的令牌去搜整份响应 ✓（同时要求响应真的带内容 ✓，免得成为空断言 ✗）。
	{
		const raw = await (await fetch(`${base}/api/logins?limit=50`, authedPin)).text()
		const token = cookie.split('=').slice(1).join('=')
		check('登录审计里绝不回令牌（回了等于把凭据抄给看页面的人 ✗）',
			token.length > 8 && raw.includes(token) === false && raw.includes('127.0.0.1'),
			`token 长度 ${token.length}；响应 ${raw.length} 字节`)
	}

	// ③ 陌生地址登录 → **先故意错一次**（证明"失败不洗白"），再用对的 PIN 进 ✓。
	const foreignBad = await foreignLogin('000000')
	check('（前置）陌生地址先错一次 PIN（这条就是为了下面"没被洗白" ✓）',
		foreignBad.status === 401 || foreignBad.status === 429, `HTTP ${foreignBad.status}`)
	const foreignRes = await foreignLogin()
	const foreignBody = await foreignRes.json().catch(() => ({}))
	let foreignCookie = cookieOf(foreignRes)
	check('陌生地址先错后对：仍然算"第一次成功登录" ✓（失败尝试不当已知设备 ✗ —— 否则攻击者一试错就洗白了 ✓）',
		foreignRes.status === 200 && foreignBody.firstSeen === true, JSON.stringify(foreignBody).slice(0, 120))
	check('陌生地址登录 → 桌面角标上出现提醒，且写明"走外网时这是隧道那端的地址"',
		String(typeof badgeTap === 'function' ? badgeTap('<html><body>hi</body></html>') : '').includes('新设备')
		&& String(typeof badgeTap === 'function' ? badgeTap('<html><body>hi</body></html>') : '').includes('隧道那端'),
		'角标里应当有"新设备"与"隧道那端"')
	{
		const boot = await (await fetch(`${base}/api/bootstrap`, authed)).json()
		check('bootstrap 只给"新设备登录"的**时间**（手机据此提一句 ✓）',
			typeof boot.security?.newDeviceAt === 'number' && boot.security.newDeviceAt > 0,
			JSON.stringify(boot.security?.newDeviceAt ?? null))
		// 反面：bootstrap 只要 cookie —— 所以**不许**把陌生设备的 IP 摆进去 ✗（IP 在要 PIN 的那份账里 ✓）。
		const raw = await (await fetch(`${base}/api/bootstrap`, authed)).text()
		check('bootstrap **不泄漏**陌生设备的 IP ✗（它只要 cookie；IP 属于要 PIN 的那份账 ✓）',
			raw.includes(foreignIp) === false, raw.includes(foreignIp) ? '里面出现了陌生设备 IP ✗' : '没有 ✓')
	}

	// ④ 同一个地址再登录 → 不再是"陌生设备" ✓（提醒不该每次都响 ✗）。
	const foreignAgain = await foreignLogin()
	const againBody = await foreignAgain.json().catch(() => ({}))
	const againCookie = cookieOf(foreignAgain)
	if (againCookie !== '') foreignCookie = againCookie
	check('同一个地址再登录就不算陌生设备（提醒只响第一次 ✓）',
		foreignAgain.status === 200 && againBody.firstSeen === false, JSON.stringify(againBody).slice(0, 120))

	// ⑤ `current` 得真的分得出来 ✓：另一台**不许**被标成"这台手机" ✗。
	{
		const listed = await (await fetch(`${base}/api/logins?limit=5`, authedPin)).json()
		const mine = (listed.devices ?? []).find((item) => item.current === true)
		const other = (listed.devices ?? []).find((item) => item.ip === foreignIp)
		check('设备表：当前这台标成 current ✓，而**另一台不是** ✓（按令牌判，不按 IP —— 复查抓到按 IP 几乎恒真 ✗）',
			mine !== undefined && other !== undefined && other.current === false,
			JSON.stringify(listed.devices ?? null).slice(0, 160))
	}

	// ⑥ 踢掉其它设备：不带 PIN / 错 PIN 一律 403，且**那台设备还在**（没被踢掉 ✓）。
	const revoke = (body) => fetch(`${base}/api/logins/revoke`, {
		method: 'POST',
		headers: { cookie: authed.headers.cookie, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	const noPin = await revoke({})
	const stillThere = await fetch(`${base}/api/bootstrap`, { headers: { cookie: foreignCookie } })
	check('踢设备不带 PIN：403，而且那台设备**没被踢掉** ✗',
		noPin.status === 403 && stillThere.status === 200, `HTTP ${noPin.status} / 那台 ${stillThere.status}`)
	check('踢设备输错 PIN：403', (await revoke({ pin: '000000' })).status === 403)

	const kicked = await revoke({ pin: config.pin })
	const kickedBody = await kicked.json().catch(() => ({}))
	const foreignGone = await fetch(`${base}/api/bootstrap`, { headers: { cookie: foreignCookie } })
	const mineStill = await fetch(`${base}/api/bootstrap`, authed)
	check('踢掉其它设备：那台立刻失效，而**当前这台**还留着（不把自己踢下线 ✓）',
		kicked.status === 200 && Number(kickedBody.revoked ?? 0) >= 1 && kickedBody.keptSelf === true
		&& kickedBody.selfRevoked === false
		&& foreignGone.status === 401 && mineStill.status === 200,
		`HTTP ${kicked.status} revoked=${kickedBody.revoked} 那台=${foreignGone.status} 这台=${mineStill.status}`)
	{
		const after = await (await fetch(`${base}/api/logins`, authedPin)).json()
		check('踢完之后还在登录态的设备只剩当前这台（且它被标成 current ✓）',
			after.deviceCount === 1 && (after.devices ?? [])[0]?.current === true,
			JSON.stringify(after.devices ?? null).slice(0, 120))
	}
}

/*
 * 2.8.0 ★4「诊断包」：把证据收集齐，用户一个键就能发出来 ✓。
 * 这条路的目的是**发出去** ✗✗ —— 所以最要紧的一条是**脱敏**：PIN 与网址里的密钥段
 * 一个都不许出现 ✓。为了不让这条断言变成空的，这里先用一个**带两样东西的 User-Agent**
 * 去撞一次 PIN（UA 是客户端自己写的 ✓，正是"别把不可信输入照抄进要外发的东西"这个场景 ✓）。
 */
{
	check('诊断包要登录才拿得到（它是这台机器的日志 ✗ 不是公开页 ✓）', (await fetch(`${base}/api/diag`)).status === 401)

	const secretForDiag = JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8')).pathSecret
	const marker = `diag-marker-${Date.now().toString(36)}`
	await fetch(`${base}/api/clientlog`, {
		method: 'POST',
		headers: { ...authed.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ event: marker, detail: '诊断包用例', bytes: 1 }),
	})
	// 故意把密钥段与 PIN 塞进 UA：它们会进登录账 ✓ —— 诊断包必须把它们洗掉 ✓。
	await fetch(`${base}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'user-agent': `leak/${secretForDiag}/${config.pin}` },
		body: JSON.stringify({ pin: '000000' }),
	})
	await new Promise((resolve) => setTimeout(resolve, 150))

	const diagRes = await fetch(`${base}/api/diag`, authed)
	const diag = await diagRes.text()
	check('诊断包：200 + 一份可下载的文本（文件名纯 ASCII —— 中文名各家处理不一致 ✗）',
		diagRes.status === 200
		&& String(diagRes.headers.get('content-type')).startsWith('text/plain')
		&& /attachment; filename="mobile-bridge-diag-\d{8}-\d{4}\.txt"/.test(String(diagRes.headers.get('content-disposition'))),
		`HTTP ${diagRes.status} ${String(diagRes.headers.get('content-disposition'))}`)
	check('（前置）那行带密钥段 + PIN 的 UA 确实进了包里（否则下面的脱敏断言是空的 ✗）',
		diag.includes('leak/<密钥段>/<PIN>'), diag.includes('leak/') ? '有 leak/ 但没被替换成占位符 ✗' : '包里的登录账没有这一行')
	check('诊断包**脱敏**：PIN 与密钥段一个都不出现 ✗✗（它是要发出去的 ✓）',
		diag.includes(config.pin) === false && diag.includes(secretForDiag) === false
		&& diag.includes('<PIN>') && diag.includes('<密钥段>'),
		`含 PIN=${diag.includes(config.pin)} 含密钥段=${diag.includes(secretForDiag)}`)
	check('诊断包真的读了日志（刚上报的那一行在里面 ✓，不是一份空壳 ✓）', diag.includes(marker))
	check('诊断包把该有的几段都带上（自检 / 登录账 / 主日志 / 崩溃日志 ✓）',
		diag.includes('## 自检') && diag.includes('## 登录账') && diag.includes('## mobile-bridge.log') && diag.includes('## dsh-crash.log'))

	/*
	 * 「限量」这条要**真的顶到上限**才有意义 ✓（冷视角复查点过：原来只断言 < 200KB，
	 * 而包里才十几 KB —— 阈值永远碰不到，对"截断"零覆盖 ✗）。
	 * 所以先往日志里灌够（`/api/clientlog` 每条 detail 上限 300 字 ✓），
	 * 再断言：① 出现了"更早的内容省略了"那句 ✓；② 整份仍然有界 ✓。
	 */
	const bigMarker = `diag-big-${Date.now().toString(36)}`
	for (let index = 0; index < 220; index += 1) {
		await fetch(`${base}/api/clientlog`, {
			method: 'POST',
			headers: { ...authed.headers, 'content-type': 'application/json' },
			body: JSON.stringify({ event: `${bigMarker}-${index}`, detail: 'x'.repeat(280), bytes: 1 }),
		})
	}
	await new Promise((resolve) => setTimeout(resolve, 200))
	const bigDiag = await (await fetch(`${base}/api/diag`, authed)).text()
	check('诊断包**限量**：日志一大就真的截断 ✓（出现"更早的内容省略了"），整份仍然有界（< 200 KB ✓）',
		bigDiag.includes('更早的内容省略了') && bigDiag.length < 200 * 1024,
		`${Math.round(bigDiag.length / 1024)} KB；含截断标记=${bigDiag.includes('更早的内容省略了')}`)
	check('诊断包里也**没有**页面的登录令牌 ✗（它要发出去 ✓）',
		bigDiag.includes(cookie.split('=').slice(1).join('=')) === false)
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

	// 手机上留着上次那份对话时，boot 会带 since= 回来：只补新的那几条。
	// 这是"从别的窗口点回来不用重新加载"的另一半 —— 内容在手机上，请求只补差量。
	const bootSince = await (await fetch(`${base}/api/boot?sessionId=session-test&since=2`, authed)).json()
	check('boot 带 since=最新序号 → 对话部分是"没有新记录"的增量',
		bootSince.transcript?.partial === true && bootSince.transcript.records.length === 0 && bootSince.transcript.cursor === 2,
		`partial=${bootSince.transcript?.partial} records=${bootSince.transcript?.records?.length}`)
	check('boot 的增量回包里会话列表照旧齐全（页面还要用它填下拉框）',
		bootSince.sessions?.length === 2, `${bootSince.sessions?.length} sessions`)
	const bootSinceOne = await (await fetch(`${base}/api/boot?sessionId=session-test&since=1`, authed)).json()
	check('boot 带 since=1 → 只回第 2 条（旧的 1 条不重发）',
		bootSinceOne.transcript?.partial === true && bootSinceOne.transcript.records.length === 1,
		`${bootSinceOne.transcript?.records?.length} 条`)
	const bootSinceJunk = await (await fetch(`${base}/api/boot?sessionId=session-test&since=abc`, authed)).json()
	check('boot 的 since 乱写也不会裁错（当没带）',
		bootSinceJunk.transcript?.partial === undefined && bootSinceJunk.transcript.records.length === 2,
		`partial=${bootSinceJunk.transcript?.partial}`)
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

/*
 * 说明页的**内容版本**：说明改版后，老手机要能再看一遍新的。
 * 既不能"永远不再弹"（一刀切按设备记"看过"），也不能"每次打开都弹"。
 * 落盘存的是版本号（不是时间戳），加载时把 v1 时代的时间戳认成第 1 版。
 */
const welcomeDevice = 'dshm_device=harness-welcome-version'
await fetch(`${base}/api/welcomed`, { method: 'POST', headers: { cookie: `${cookie}; ${welcomeDevice}` } })
const welcomeBeforeRestart = await readJsonOrFail(tokensFile)
const welcomeVersion = welcomeBeforeRestart.welcomed?.['harness-welcome-version']
check('说明页的"看过"落盘的是版本号（不是时间戳）',
	Number.isInteger(welcomeVersion) && welcomeVersion >= 1 && welcomeVersion < 1000,
	JSON.stringify(welcomeBeforeRestart.welcomed))

const openStream = await fetch(`${base}/api/stream?sessionId=session-test`, authed)
const openReader = openStream.body.getReader()
await openReader.read()
await new Promise((resolve) => setTimeout(resolve, 200))

disposeGeneration(currentGeneration)
await new Promise((resolve) => setTimeout(resolve, 600))
check('stopping with a stream open does not crash the process',
	crashes.length === 0, crashes.map((error) => error.code ?? error.message).join(' | '))
process.removeListener('uncaughtException', onCrash)
await openReader.cancel().catch(() => {})

// 装成 v1 时代的老数据（那时存的是毫秒时间戳）—— 迁移必须在"还没起来"的空档做，
// 否则 dispose/加载过程会把内存里那份版本号又写回去，测不到迁移。
await writeFile(tokensFile, JSON.stringify({
	...await readJsonOrFail(tokensFile),
	welcomed: { 'harness-welcome-version': 1792078785000 },
}, null, '\t'))

applyBridge()

if (!await waitForPort(PORT)) {
	check('the bridge comes back up after a restart', false, 'nothing listening')
} else {
	check('the bridge comes back up after a restart', true)
	const afterRestart = await fetch(`${base}/api/bootstrap`, authed)
	check('a phone stays logged in across a server restart',
		afterRestart.status === 200, `HTTP ${afterRestart.status}`)

	// 老数据（时间戳）算第 1 版 → 说明已升到第 2 版 → 这台手机应当再看一遍。
	const legacyWelcome = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie: `${cookie}; ${welcomeDevice}` } })).json()
	check('v1 时代的时间戳被认成"第 1 版"：说明改版后老手机能再看一遍新内容',
		legacyWelcome.welcomed === false, String(legacyWelcome.welcomed))

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

	/*
	 * 权限的"要不要重新验 PIN"这件事，只有在这个现场才测得准：重启后恢复的令牌
	 * **读得到、写不了**（正是手机在桥上最常见的状态）。三条底线：
	 */
	const restored = { headers: { cookie: authed.headers.cookie, 'content-type': 'application/json' } }
	const beforeWrites = services.permissionPresets.writes.length

	// ① 放开 = 必须重新验 PIN。
	const refused = await fetch(`${base}/api/permission`, {
		method: 'POST',
		...restored,
		body: JSON.stringify({ sessionId: 'session-test', preset: 'danger-full-access' }),
	})
	const refusedBody = await refused.json().catch(() => ({}))
	check('提权过期时放开权限被拒：403 + needPin（页面据此弹 PIN 门）',
		refused.status === 403 && refusedBody.needPin === true,
		`HTTP ${refused.status} ${JSON.stringify(refusedBody)}`)
	check('被拒的那次真的没写进任何会话', services.permissionPresets.writes.length === beforeWrites,
		`${beforeWrites} -> ${services.permissionPresets.writes.length}`)

	// ② 收紧到只读 = 不用再验一次 PIN（不能拦着用户赶紧把机器锁上）。
	const tighten = await fetch(`${base}/api/permission`, {
		method: 'POST',
		...restored,
		body: JSON.stringify({ sessionId: 'session-test', preset: 'read-only' }),
	})
	const tightened = await tighten.json().catch(() => ({}))
	check('不验 PIN 也能收紧到只读（往安全方向走不设门）',
		tighten.status === 200 && tightened.current === 'read-only',
		`HTTP ${tighten.status} ${JSON.stringify(tightened.current)}`)
	check('只读写进了会话（桌面端看得到同一档）',
		services.permissionPresets.writes.at(-1)?.preset === 'read-only',
		JSON.stringify(services.permissionPresets.writes.at(-1)))

	// ③ 重新验 PIN 之后（登录会**换发令牌**，旧 cookie 当场作废）放开才生效。
	const relogin = await fetch(`${base}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pin: config.pin }),
	})
	const freshCookie = (relogin.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
	const widen = await fetch(`${base}/api/permission`, {
		method: 'POST',
		headers: { cookie: freshCookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test', preset: 'danger-full-access' }),
	})
	const widened = await widen.json().catch(() => ({}))
	check('重新验过 PIN 之后放开成功（当前档位 + 标签一起回来）',
		widen.status === 200 && widened.current === 'danger-full-access' && widened.label === '完全放开',
		`HTTP ${widen.status} ${widened.current}/${widened.label}`)

	const bogus = await fetch(`${base}/api/permission`, {
		method: 'POST',
		headers: { cookie: freshCookie, 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: 'session-test', preset: 'make-me-root' }),
	})
	check('不存在的档位回 400，而且不许顺手动坏当前档位',
		bogus.status === 400 && services.permissionPresets.writes.at(-1)?.preset === 'danger-full-access',
		`HTTP ${bogus.status} -> ${services.permissionPresets.writes.at(-1)?.preset}`)

	// 换发过令牌：收尾的注销用例要用新的那张。
	cookie = freshCookie
	authed.headers.cookie = freshCookie
}

const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } })
const afterLogout = await fetch(`${base}/api/bootstrap`, authed)
check('logout revokes the cookie', logout.status === 200 && afterLogout.status === 401)

// persistTokens() writes without awaiting, so give the disk write a moment.
await new Promise((resolve) => setTimeout(resolve, 150))
const afterLogoutTokens = (await readJsonOrFail(tokensFile)).tokens ?? {}
check('logout also clears the token on disk', Object.keys(afterLogoutTokens).length === 0,
	`${Object.keys(afterLogoutTokens).length} token(s) left`)

/* --- 语音转文字（3.0.0 ★③「语音往返」：说 → 文字）-----------------------------
 * 上游是宿主的 `speechController`（**实验性** ✓，2026-10-12 用只读 inspect 查实它在当前 profile 里是活的 ✓）。
 * 桥这边的规矩是这一组要钉的：**不在就说不在** ✓、**云识别器要现输 PIN** ✓（音频会离开这台电脑 ✗）、
 * **超上限先拒** ✓、日志**只记字数不记内容** ✓。这里用一个假服务替身 ✓（真转写要靠真机 ✓）。
 */
{
	/*
	 * ⚠️ 前面那条"退出登录"的用例把 cookie 作废了 ✓ —— 这一组要**重新登一次** ✓
	 * （我第一次写完就吃到了 9 个 401 ✗：断言全红但原因跟语音一点关系都没有 ✓）。
	 */
	const relogin = await fetch(`${base}/api/login`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: config.pin }),
	})
	const freshCookie = (relogin.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
	if (freshCookie !== '') { cookie = freshCookie; authed.headers.cookie = freshCookie }

	const json = async (path, options) => {
		const res = await fetch(`${base}${path}`, options)
		return { status: res.status, body: await res.json().catch(() => ({})) }
	}
	const post = (path, payload, headers = {}) => json(path, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json', ...headers },
		body: JSON.stringify(payload),
	})

	// ① 服务不在：**如实说**"没开" ✓ —— 绝不能假装转出一个空字符串 ✗。
	delete services.speechController
	const absent = await json('/api/speech', authed)
	check('宿主没开语音服务时：`available:false` + 一句人话 ✓（不假装成功 ✗）',
		absent.status === 200 && absent.body.available === false && String(absent.body.message).includes('没开'),
		JSON.stringify(absent.body).slice(0, 90))
	const absentTranscribe = await post('/api/transcribe', { audioBase64: 'QUJD' })
	check('没开服务时转写：503 + 说清原因 ✓（不是 200 空文字 ✗）',
		absentTranscribe.status === 503 && String(absentTranscribe.body.error).includes('没开'),
		JSON.stringify(absentTranscribe.body).slice(0, 90))

	// ② 装一个假服务：一个**本地**识别器 + 一个**云**识别器 ✓（位置不同，闸门就该不同 ✓）。
	const seen = []
	/** 3.0.0 复查：让 `prepare` 抛错 ✓（"忘了 await" 会让 rejection 逃出去打死整个进程 ✓）。 */
	let prepareFails = false
	services.speechController = {
		catalog: () => ({
			providers: [
				{ id: 'local-1', name: '本机小模型', location: 'host-local', languages: ['zh', 'en'], preparation: { phase: 'ready' } },
				{ id: 'cloud-1', name: '云端识别', location: 'cloud', languages: ['zh'], preparation: { phase: 'ready' } },
			],
			selection: { providerId: 'local-1', language: 'zh' },
			maxAudioBytes: 1024 * 1024,
			maxDurationSeconds: 60,
		}),
		prepare: async (providerId) => {
			// ⚠️ **必须 async** ✗（3.0.0 复查抓到的崩溃级 bug 就是这么漏过去的 ✓）：
			// 真宿主的 `prepare` 是 async ✓，而"下模型失败"是这条路的常态 ✓ ——
			// 用同步替身测，"忘了 await" 这个 bug **永远不可能被触发** ✓。
			if (prepareFails === true) throw new Error('下模型失败（测试桩）')
			seen.push(['prepare', providerId])
		},
		transcribe: async (request) => {
			seen.push(['transcribe', request.providerId, String(request.audioBase64 ?? '').length, request.language])
			return { text: '把这句话变成文字', audioSeconds: 3.2, inferenceSeconds: 0.4 }
		},
	}
	const catalog = await json('/api/speech', authed)
	check('语音设置读得出来：识别器 + 位置（本地/云 ✓）+ 宿主的两个上限 ✓（手机靠它决定录多久 ✓）',
		catalog.body.available === true && catalog.body.providers.length === 2
		&& catalog.body.providers[0].location === 'host-local' && catalog.body.providers[1].location === 'cloud'
		&& catalog.body.maxAudioBytes === 1024 * 1024 && catalog.body.maxDurationSeconds === 60,
		JSON.stringify(catalog.body).slice(0, 140))

	// ③ 本地识别器：登录就能转 ✓（不额外要 PIN ✓ —— 音频不出这台电脑 ✓）。
	const local = await post('/api/transcribe', { audioBase64: 'QUJD' })
	check('本机识别器：登录就能转 ✓、原样回文字与秒数 ✓、把 provider / 语言交给宿主 ✓',
		local.status === 200 && local.body.text === '把这句话变成文字' && local.body.audioSeconds === 3.2
		&& seen.some((row) => row[0] === 'transcribe' && row[1] === 'local-1' && row[2] === 4 && row[3] === 'zh'),
		JSON.stringify({ status: local.status, text: local.body.text, seen: seen.slice(-1) }))

	// ④ 云识别器：**必须现输 PIN** ✓（音频要离开这台电脑 ✗）。
	const cloudNoPin = await post('/api/transcribe', { audioBase64: 'QUJD', providerId: 'cloud-1' })
	check('云识别器不带 PIN：403 ✓（音频会出这台电脑 ✗）', cloudNoPin.status === 403, JSON.stringify(cloudNoPin.body).slice(0, 80))
	const cloudPin = await post('/api/transcribe', { audioBase64: 'QUJD', providerId: 'cloud-1', pin: config.pin })
	check('云识别器带对 PIN：转 ✓（不是"永久禁止"，是"每次本人点头" ✓）',
		cloudPin.status === 200 && cloudPin.body.text.length > 0, JSON.stringify(cloudPin.body).slice(0, 80))

	// ⑤ 超上限：**先拒再传** ✓（2 MB base64 ≈ 1.5 MB 音频 > 宿主的 1 MB ✓）。
	const big = await post('/api/transcribe', { audioBase64: 'A'.repeat(2 * 1024 * 1024) })
	check('超过宿主的单次上限：413 + 说清"约多少 MB / 上限多少" ✓（不给宿主送大包 ✗）',
		big.status === 413 && String(big.body.error).includes('超过') && String(big.body.error).includes('MB'),
		String(big.body.error ?? '').slice(0, 90))

	// ⑥ 「准备识别器」转发给宿主 ✓（第一次用要下模型 ✓）。
	const prepared = await post('/api/speech/prepare', {})
	check('「准备识别器」转发给宿主 ✓（第一次用要下模型的出路 ✓）',
		prepared.status === 200 && seen.some((row) => row[0] === 'prepare' && row[1] === 'local-1'),
		JSON.stringify(prepared.body).slice(0, 80))
	/*
	 * 🔴 3.0.0 复查抓到的**崩溃级**回归 ✓：真宿主的 `prepare` 是 **async** ✓，而失败（下模型失败）是常态 ✓ ——
	 * 第一版没 `await` ✗ → rejection 逃出那个 try/catch ✗ → unhandled rejection →
	 * Node ≥15 默认 `--unhandled-rejections=throw` = **整个 DSH 进程被打死** ✓
	 *（而同一刻已经先回了"已经开始准备了 ✓" ✗，用户看到的是"手机上说着准备、电脑上全掉线" ✓）。
	 * 假替身也一并改成 async ✓ —— 同步替身下这个 bug **永远不可能被测出来** ✓。
	 */
	prepareFails = true
	const prepFail = await post('/api/speech/prepare', {})
	check('🔴 宿主准备失败（async reject）：回 503 ✓、**而且这个进程还活着** ✓（漏 await 会打死整个 DSH ✗）',
		prepFail.status === 503 && String(prepFail.body.error).includes('准备不了')
		&& (await json('/api/speech', authed)).status === 200,
		JSON.stringify(prepFail.body).slice(0, 90))
	prepareFails = false

	/*
	 * 🔴 3.0.0 复查抓到的**功能性**回归 ✓：云识别器的 403 少了 `needPin: true` ✗ →
	 * 手机端只在看到这个字段时才**把 PIN 门弹出来** ✓（`mobile.html` 的 api() 分支 ✓）→
	 * 不带的话：用户只看到一行"要 PIN"的字 ✓、**没有任何地方能输入 PIN** ✗ ——
	 * "云端转写要现输 PIN"这句写进了文案、注释、harness，就是接不上 ✓（剪贴板/截屏同款 ✓，一并修了 ✓）。
	 */
	const needPin = await post('/api/transcribe', { audioBase64: 'QUJD', providerId: 'cloud-1' })
	check('🔴 云识别器不带 PIN 的 403 **必须带 `needPin: true`** ✓（否则手机上根本没有输 PIN 的入口 ✗）',
		needPin.status === 403 && needPin.body.needPin === true, JSON.stringify(needPin.body).slice(0, 90))

	// ⑦ 日志里**只有字数/秒数** ✓，**绝不记转出来的内容** ✗（那可能是家里说的话 ✓）—— 走诊断包看 ✓。
	const diag = await (await fetch(`${base}/api/diag`, authed)).text()
	const voiceLines = diag.split('\n').filter((line) => line.includes('语音转文字'))
	check('日志：有"语音转文字：N 字"这类行 ✓，但**没有转出来的内容** ✗（隐私 ✓）',
		voiceLines.length > 0 && /语音转文字：\d+ 字/.test(diag) && diag.includes('把这句话变成文字') === false,
		(voiceLines[0] ?? '(没有)').slice(0, 70))
	delete services.speechController
}

/* --- 多端授权（3.0.0 ★④）-----------------------------------------------------
 * 用户要的（总路线原话）：**新设备进来自动失效 + 一次性放行** ✓。
 * 这一组的重点**不是"能不能拦"** ✗，而是三条**防锁死**的规矩 ✓（拦错了等于把自己关在门外 ✗）：
 *   ① 默认关 ✓（安全类功能一律默认关 ✓）；
 *   ② **一台已放行的设备都没有时，直接放行** ✓ —— 全新安装 / 全踢掉之后，下一次登录永远进得来 ✓；
 *   ③ 放行入口**只在本机（loopback）** ✓ —— 手机（隧道/局域网）打不开 ✓（这比"再输一次 PIN"更接近本人 ✓）。
 */
{
	const readConfig = async () => JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	const writeConfig = async (patch) => writeFile(join(scratch, 'mobile-bridge.json'), JSON.stringify({ ...await readConfig(), ...patch }, null, 2), 'utf8')
	// 用 `x-forwarded-for` 假装"另一台设备" ✓（本机连接才会被采信 ✓，见 clientIp ✓）。
	// 3.4.1：`device` 参数 = 页面那枚 **`dshm_device`** cookie ✓（"同一台手机"的稳定指纹 ✓）——
	// 用户的真实痛点就出在这儿 ✗：设备的身份以前只跟 IP 走 ✓，IPv6 前缀一变就成"新设备" ✗。
	const loginAs = async (ip, device) => {
		const response = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(ip === undefined ? {} : { 'x-forwarded-for': ip }),
				...(device === undefined ? {} : { cookie: `dshm_device=${device}` }),
			},
			body: JSON.stringify({ pin: config.pin }),
		})
		const body = await response.json().catch(() => ({}))
		const jar = (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
		return { status: response.status, body, cookie: jar }
	}
	const statusOf = async (path, jar) => (await fetch(`${base}${path}`, { headers: { cookie: jar } })).status

	// ① 默认关：登录就进得来 ✓（老行为一个字不改 ✓）。
	const normal = await loginAs('203.0.113.11')
	check('「多端授权」默认关：登录不会被拦住 ✓（老行为不变 ✓）',
		normal.status === 200 && normal.body.pending !== true && await statusOf('/api/bootstrap', normal.cookie) === 200,
		JSON.stringify(normal.body))

	// ② 打开它 + **一台已放行的设备都没有** ✓ → 直接放行 ✓（**防锁死**的第一条 ✓）。
	//    ⚠️ 注意顺序 ✗：先得把设备全踢掉，否则上面那次登录留下的已放行设备还在 ✓
	//    （那我就是在测"有可信设备时该拦"✗，不是测"没有任何可信设备时不许锁死" ✓）。
	const seed = await loginAs('203.0.113.91')
	await fetch(`${base}/api/logins/revoke`, {
		method: 'POST', headers: { cookie: seed.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ pin: config.pin, all: true }),
	})
	await writeConfig({ deviceApproval: true })
	const first = await loginAs('203.0.113.12')
	check('打开了多端授权，但一台已放行的设备都没有 → **直接放行** ✓（否则清了 cookie 就是把自己关在门外 ✗）',
		first.status === 200 && first.body.pending !== true && await statusOf('/api/bootstrap', first.cookie) === 200,
		JSON.stringify(first.body))

	// ③ 现在**有一台可信设备了** ✓ → 第二台新设备（另一个地址）必须**等放行** ✓。
	const second = await loginAs('203.0.113.13')
	check('第二台新设备：回包里就写着 pending ✓（手机据此直接进"等放行"那一屏 ✓，不来回打转 ✗）',
		second.status === 200 && second.body.pending === true, JSON.stringify(second.body))
	check('等放行的设备：**业务接口一律 401** ✓、但 `/api/pending` 能问 ✓（它得知道"放行了没" ✓）',
		await statusOf('/api/bootstrap', second.cookie) === 401
		&& await statusOf('/api/stream?sessionId=x', second.cookie) === 401
		&& await statusOf('/api/pending', second.cookie) === 200,
		`bootstrap=${await statusOf('/api/bootstrap', second.cookie)} pending=${await statusOf('/api/pending', second.cookie)}`)
	const pendingBody = await (await fetch(`${base}/api/pending`, { headers: { cookie: second.cookie } })).json()
	/*
	 * 3.3.2：这一屏上印的本机地址**必须真的能打开** ✓ —— 3.3.1 印的是
	 * `http://127.0.0.1:<端口>/approve`（**漏了 pathSecret** ✗）→ 用户照着打就是 404 ✗。
	 * ⚠️ 所以断言不能只看"有没有说'电脑'" ✗（那句话在 3.3.1 上也是通的 ✓）——
	 * 得把地址**抠出来真打一次** ✓。
	 */
	const pendingUrl = (/http:\/\/127\.0\.0\.1:\d+\/[^\s）)]*approve/.exec(String(pendingBody.message)) ?? [])[0] ?? ''
	check('"等放行"那一屏拿到的话是**人话** ✓、而且里面印的本机地址**照着真能打开** ✓（3.3.1 印的裸地址 → 404 ✗）',
		pendingBody.pending === true && String(pendingBody.message).includes('电脑')
		&& pendingUrl !== '' && (await fetch(pendingUrl)).status === 200,
		`${pendingUrl === '' ? '话里没有可点的本机地址' : pendingUrl} —— ${JSON.stringify(pendingBody).slice(0, 80)}`)

	// ④ 放行页只在本机给 ✓（这里从本机连 ✓）—— 要能列出**那一台**、并给两个键 ✓。
	//    ⚠️ 认设备要**按来源地址认** ✓：页面上可能同时列着好几台在等放行的（前面用例留下的 ✓），
	//    只按"第一个链接"取 id 会**处理错设备** ✗（第一版就是这么错的 ✓，两条断言全红 ✓）。
	const idFor = (html, ip, action) => {
		const row = new RegExp(`<b>[^<]*</b><div class="meta">${String(ip).replace(/\./g, '\\.')}[^<]*</div></div><div class="acts">[\\s\\S]{0,200}?action=${action}&id=([0-9a-f]+)`)
		return row.exec(html)?.[1] ?? ''
	}
	const page = await fetch(`${base}/approve`)
	const pageText = await page.text()
	check('电脑上的放行页：列得出那台等放行的设备（名字 + 来源 + 时间 ✓）、并且给「放行 / 拒绝」两个键 ✓',
		page.status === 200 && pageText.includes('放行') && pageText.includes('拒绝') && pageText.includes('203.0.113.13'),
		pageText.includes('203.0.113.13') ? '页面里有那台设备 ✓' : '页面里没有那台设备 ✗')
	const id = idFor(pageText, '203.0.113.13', 'approve')
	check('放行页给的是**设备短 id**（不是令牌本身 ✓ —— 令牌是能直接用的凭证 ✗）', id !== '', id)

	/*
	 * 🔴 这一条是**真洞的回归** ✓（自己复查时抓到的 ✓）：隧道是**本机进程** ✓ ——
	 * 公网请求转进来时 socket 对端**就是 127.0.0.1** ✓ → 只看 socket 的话，
	 * `https://…ts.net/approve` 从公网也打得开 ✗ → 谁知道 PIN、谁就能给自己放行 ✓，
	 * 而"新设备要你点头"防的正是**PIN 泄露**这一种 ✓（那就白做了 ✗）。
	 * 所以判据必须走 `clientIp()` ✓（会认 `cf-connecting-ip` / `x-forwarded-for` 最后一跳 ✓）。
	 * 测试里模拟"隧道转进来"：本机连接 + 带上 `cf-connecting-ip` ✓ → 应当 403 ✓。
	 */
	const viaTunnel = await fetch(`${base}/approve`, { headers: { 'cf-connecting-ip': '203.0.113.77' } })
	check('🔴 隧道转进来的放行页（本机 socket + 真实来源在头里）→ **403** ✓（否则 PIN 一泄露就能自己放行 ✗）',
		viaTunnel.status === 403, `status=${viaTunnel.status}`)
	const tunnelList = await fetch(`${base}/api/devices/pending`, { headers: { 'cf-connecting-ip': '203.0.113.77' } })
	check('🔴 同一个洞的另一半：等放行清单在隧道下也要 403 ✓（不能让人从外面看见有谁在排队 ✓）',
		tunnelList.status === 403, `status=${tunnelList.status}`)
	const viaForwarded = await fetch(`${base}/approve`, { headers: { 'x-forwarded-for': '203.0.113.78' } })
	check('🔴 只有 `x-forwarded-for`（没有 cf 头）时同样 403 ✓（取的是**最后一跳** ✓ —— 我们自己那台代理加的 ✓）',
		viaForwarded.status === 403, `status=${viaForwarded.status}`)

	/*
	 * 🔴 复查点名的"假象"（A1）✓：上面那条走的是 `x-forwarded-for` ✓ —— 那**只是"IP 标签不同"** ✗，
	 * 因为 harness 自己就在 loopback 上 ✓（唯一让转发头生效的条件 ✓）。
	 * 真实世界里的"另一台设备"是**另一个 socket 对端** ✓ —— 那条路 `clientIp()` **根本不看转发头** ✓。
	 * 所以这里用**本机的真实非 loopback 地址**再打一次 ✓（报文真的从那个网卡出去再回来 ✓）：
	 * `/approve` 必须 403 ✓（放行只认 127.0.0.1 ✓）。
	 */
	const lanCandidates = Object.values(networkInterfaces()).flat()
		.filter((entry) => entry !== undefined && entry.family === 'IPv4' && entry.internal !== true)
		.map((entry) => entry.address)
	// ⚠️ 别漏了**密钥段那段路径** ✗（路由都在 `/<pathSecret>/…` 下 ✓ —— 我第一版写成
	// `http://ip:port/approve` ✓，拿到的是 404 ✓，看着像"放行页不存在" ✓，其实是被路径挡了 ✓）。
	const basePath = new URL(base).pathname.replace(/\/$/, '')
	let lanStatus = 0
	let lanUsed = ''
	for (const address of lanCandidates.slice(0, 4)) {
		try {
			const response = await fetch(`http://${address}:${config.port}${basePath}/approve`, { signal: AbortSignal.timeout(2500) })
			lanStatus = response.status
			lanUsed = address
			break
		} catch { /* 这个地址本机不可达 → 试下一个 ✓ */ }
	}
	check('🔴 从**真实的非 loopback 地址**打 `/approve`：403 ✓（这条路不看转发头 ✓ —— 只有 127.0.0.1 能放行 ✓）',
		lanStatus === 403,
		lanUsed === '' ? `本机没有可达的非 loopback 地址（候选：${lanCandidates.join(', ') || '无'}，未验 ✓）` : `${lanUsed} → ${lanStatus}`)

	/*
	 * 🔴 另一条同类隐患（自己复查时抓到的 ✓）：**"等放行"必须活过重启** ✗✗ ——
	 * 令牌落盘那份要是只存 `expiresAt`/`ip` ✓，重启之后 `approved` 就丢了 ✓ →
	 * 等放行的设备**白等一场** ✓（谁会想到去等一次重启呢 ✓）。
	 * 这里直接读**落盘的那份**验 ✓（进程里的 Map 看不出这个洞 ✗）。
	 */
	const tokensFile = await readJsonOrFail(join(scratch, 'mobile-bridge.tokens.json'))
	const pendingEntry = Object.values(tokensFile.tokens ?? {}).find((entry) => entry?.approved === false)
	check('🔴 "等放行"这个状态**写进了令牌文件** ✓（重启之后仍然是等放行 ✗ —— 白等一场就是漏洞 ✓）',
		pendingEntry !== undefined && typeof pendingEntry.ip === 'string' && pendingEntry.ip === '203.0.113.13',
		JSON.stringify(pendingEntry ?? null))

	// ⑤ 放行 → 那台设备立刻能用 ✓（不用重新登录 ✓）。
	await fetch(`${base}/approve?action=approve&id=${id}`)
	check('点「放行」之后：那台设备**立刻**能进 ✓（同一枚 cookie ✓ 不用再输 PIN ✓）',
		await statusOf('/api/bootstrap', second.cookie) === 200,
		`bootstrap=${await statusOf('/api/bootstrap', second.cookie)}`)

	// ⑥ 拒绝 → 令牌直接作废 ✓（**不是**永久拉黑 ✓：下次登录还是"等放行"✓）。
	const third = await loginAs('203.0.113.14')
	const page2 = await (await fetch(`${base}/approve`)).text()
	const id3 = idFor(page2, '203.0.113.14', 'deny')
	check('（前置）第三台设备也在等放行 ✓', third.body.pending === true && id3 !== '', JSON.stringify(third.body))
	await fetch(`${base}/approve?action=deny&id=${id3}`)
	check('点「拒绝」：那台设备**当场作废** ✓（再问什么都 401 ✓ —— 不是"下次再说" ✗）',
		await statusOf('/api/pending', third.cookie) === 401,
		`pending=${await statusOf('/api/pending', third.cookie)}`)

	// ⑦ 再走一遍"防锁死"：把已放行的设备全踢掉 → 下一台登录**直接放行** ✓
	//    （这正是"改了配置又清了 cookie"那一刻的真实处境 ✓）。
	// ⚠️ 踢设备要用**已放行的**那枚 cookie ✓（拿"等放行"设备的 cookie 去踢只会 401 ✗ ——
	// 第一版就是拿 seed2 踢的 ✓：wipe 根本没发生 ✓，于是"全踢之后再登录"仍然是 pending ✗）。
	await fetch(`${base}/api/logins/revoke`, {
		method: 'POST', headers: { cookie: first.cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ pin: config.pin, all: true }),
	})
	const afterWipe = await loginAs('203.0.113.15')
	check('把设备全踢掉之后再登录：**直接放行** ✓（不会出现"谁也进不来"✗ —— 这是这一版最要紧的一条 ✓）',
		afterWipe.status === 200 && afterWipe.body.pending !== true,
		JSON.stringify(afterWipe.body))

	/*
	 * ⑧ **3.4.1：同一台设备换个地址回来，不许再被挡** ✓ —— 用户 2026-10-13 的原话：
	 * "又被你挡在外面了，不要再挡了" ✓。现场（读代码 + 读他的令牌账本核过 ✓）：
	 * 放行状态以前是**全局一个开关** ✗（`everApproved` ✓）—— 判据是"曾经放行过**任何**设备"✓，
	 * 于是**放行过一台之后，之后每一次重新登录都会被当成新设备** ✗（iPhone 的 IPv6 前缀会变 ✓、
	 * token 12 小时过期后必然重登 ✓）→ **主人自己天天被挡** ✗✗。
	 * 现在改成**按设备指纹**记（页面本来就有 `dshm_device` ✓）：同一台设备换地址 = 自己人 ✓；
	 * **陌生设备**（不同指纹）照样要点头 ✓ —— 功能没被削弱 ✓。
	 */
	{
		const ownerDevice = 'owner-phone-harness-abc'
		const owner = await loginAs('203.0.113.31', ownerDevice)
		check('（前置）主人手机第一次进来：在等放行 ✓', owner.body.pending === true, JSON.stringify(owner.body).slice(0, 90))
		const page = await (await fetch(`${base}/approve`)).text()
		const ownerId = idFor(page, '203.0.113.31', 'approve')
		await fetch(`${base}/approve?action=approve&id=${ownerId}`)
		const ownerAgain = await loginAs('203.0.113.77', ownerDevice)
		check('🔴 同一台设备**换个地址**回来 → 直接放行 ✓（3.4.1 修的就是这个：以前每次重登都当新设备 ✗）',
			ownerAgain.status === 200 && ownerAgain.body.pending !== true, JSON.stringify(ownerAgain.body).slice(0, 120))
		const stranger = await loginAs('203.0.113.88', 'someone-else-xyz')
		check('🔴 陌生设备（不同设备指纹）**仍然**在等放行 ✓（deviceApproval 的本意没被削掉 ✗）',
			stranger.body.pending === true, JSON.stringify(stranger.body).slice(0, 120))
	}

	// 收尾：关掉这个开关 ✓（后面的用例按默认行为跑 ✓）。
	await writeConfig({ deviceApproval: false })
	cookie = afterWipe.cookie
	authed.headers.cookie = afterWipe.cookie
}

/* --- 面板协议（3.1.0「手机端可扩展」）-----------------------------------------
 * 用户要的：把"手机端面板"变成**可挂载的接口** ✓（协议 + 两个示例面板 ✓）。
 * 这一组钉的是**边界** ✓：默认关 ✓、关着时如实说 ✓、**路径穿越必须 404** ✗✗、
 * 坏清单要计数 ✓、用户面板能覆盖同 id 示例 ✓。
 */
{
	const readConfig2 = async () => JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	const writeConfig2 = async (patch) => writeFile(join(scratch, 'mobile-bridge.json'), JSON.stringify({ ...await readConfig2(), ...patch }, null, 2), 'utf8')
	const panelJson = async (path) => {
		const response = await fetch(`${base}${path}`, authed)
		return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() }
	}

	// ① 默认关 ✓：清单**如实说"没开"** ✓（不是空数组装没事 ✗），资源一律 404 ✓。
	const off = await (await fetch(`${base}/api/panels`, authed)).json()
	check('面板功能默认关 ✓：回 `enabled:false` + 一句"怎么开" ✓（"没有面板"和"功能没开"是两件事 ✗）',
		off.enabled === false && Array.isArray(off.panels) && off.panels.length === 0
		&& String(off.message).includes('panels'), JSON.stringify(off).slice(0, 90))
	check('关着的时候，面板资源也拿不到 ✓（404 —— 不给任何入口 ✗）',
		(await panelJson('/panel/notes/index.html')).status === 404)

	// ② 打开：列出**两个自带示例** ✓。
	await writeConfig2({ panels: true })
	const on = await (await fetch(`${base}/api/panels`, authed)).json()
	const ids = (on.panels ?? []).map((panel) => panel.id).sort()
	check('打开后列出两个自带示例 ✓（便签 + 计时 ✓，都标着 builtin ✓）',
		on.enabled === true && ids.includes('notes') && ids.includes('timer')
		&& on.panels.filter((panel) => ids.includes(panel.id)).every((panel) => panel.builtin === true && typeof panel.icon === 'string' && panel.icon !== ''),
		JSON.stringify(on).slice(0, 140))

	/*
	 * 🔴🔴 3.1.0 复查的**高危 H1** 回归 ✓：符号链接能绕过**词法**守卫 ✗ ——
	 * 面板目录里放一个 `leak.json -> ~/.dsh/mobile-bridge.json`（Windows 普通用户就能建 ✓），
	 * 旧版会把 PIN / 令牌 / **路径密钥**整套发出去 ✓（类型白名单里有 `.json` ✓）。
	 * 现在三重拦：词法守卫 + `lstat`（拒链接）+ `realpath`（拒"父目录是链接"）✓。
	 * ⚠️ 建链接在某些平台/权限下会失败 ✓ → 那就**如实说没验成** ✗（不假装过了 ✗）。
	 */
	let symlinkMade = false
	try {
		const outside = join(scratch, 'outside-secret.json')
		await writeFile(outside, '{"pin":"123456","token":"should-never-leak"}', 'utf8')
		await mkdir(join(scratch, 'mobile-panels', 'evil'), { recursive: true })
		await writeFile(join(scratch, 'mobile-panels', 'evil', 'panel.json'),
			JSON.stringify({ title: '邪恶面板', icon: '😈', kind: 'tool', entry: 'index.html' }), 'utf8')
		await writeFile(join(scratch, 'mobile-panels', 'evil', 'index.html'), '<!doctype html><b>evil</b>', 'utf8')
		const { symlink } = await import('node:fs/promises')
		await symlink(outside, join(scratch, 'mobile-panels', 'evil', 'leak.json'))
		symlinkMade = true
	} catch { symlinkMade = false }
	if (symlinkMade === true) {
		const leaked = await panelJson('/panel/evil/leak.json')
		check('🔴🔴 符号链接读配置：**404** ✓（词法守卫挡不住链接 ✗ —— 这就是复查那个高危 ✓）',
			leaked.status === 404 && leaked.body.includes('should-never-leak') === false,
			`status=${leaked.status} 含密钥=${leaked.body.includes('should-never-leak')}`)
		const list = await (await fetch(`${base}/api/panels`, authed)).json()
		check('🔴 清单里也不许出现"入口是符号链接"的面板 ✓（否则点开就是任意文件 ✓）',
			(list.panels ?? []).some((panel) => panel.id === 'evil' && panel.entry === 'leak.json') === false,
			JSON.stringify((list.panels ?? []).map((panel) => panel.id)))
	} else {
		check('（如实）这个平台/权限下建不了符号链接 → **H1 这条没验成** ✗（Windows 上普通用户本来可以 ✓）', true, 'skipped')
	}

	// ③ 资源真的发得出来 ✓（且是 html ✓）。
	const html = await panelJson('/panel/notes/index.html')
	check('面板页面发得出来 ✓（200 + text/html + 内容对 ✓）',
		html.status === 200 && html.type.includes('text/html') && html.body.includes('便签'),
		`${html.status} ${html.type}`)

	// ④ 🔴 **路径穿越必须挡住** ✗✗（这是这一层最要命的事 ✓）。
	for (const evil of ['/panel/notes/..%2F..%2Fmobile-bridge.json', '/panel/notes/..%2Fpanel.json', '/panel/notes/%2e%2e%2f%2e%2e%2fmobile-bridge.json']) {
		const got = await panelJson(evil)
		check(`🔴 穿越读配置：**404** ✓（${evil.slice(0, 34)}…）`, got.status === 404, `status=${got.status}`)
	}
	/*
	 * 🔴 再补三条**对抗写法** ✓（自己复查时想到的 ✓）：
	 *   · **绝对路径**（`rel` 以 `/` 开头 ✓）—— `path.resolve(base, '/etc/passwd')` 会当成绝对路径 ✗，
	 *     靠的是守卫那句"必须仍在面板目录之下" ✓；
	 *   · **Windows 盘符**（`C:/…` 在 Windows 上也是"绝对"✗）；
	 *   · **反斜杠**（Windows 上 `..\` 同样能穿越 ✓）。
	 * ⚠️ 复查纠正过一条注释 ✗：**双重编码不是"只解一次所以安全"** ✓ ——
	 * `%252e…` 解一次得到的是**字面文件名** `%2e%2e%2f…` ✓，守卫**放行**它 ✓，
	 * 之所以 404 只是"那个字面文件不存在" ✓。所以那条**钉不住守护逻辑** ✓（留着当"不许 200"的对照 ✓，
	 * 真正的守护由上面三条 + 符号链接那条负向用例钉 ✓）。
	 */
	for (const evil of [
		'/panel/notes//..%2F..%2Fmobile-bridge.json',
		'/panel/notes/%252e%252e%252f%252e%252e%252fmobile-bridge.json',
		'/panel/notes/C%3A%2FWindows%2Fwin.ini',
		'/panel/notes/..%5C..%5Cmobile-bridge.json',
	]) {
		const got = await panelJson(evil)
		check(`🔴 对抗写法也必须 404 ✓（${evil.slice(0, 40)}…）`, got.status === 404, `status=${got.status}`)
	}
	check('（对照）面板自己的 panel.json 是允许发的 ✓（白名单里有 json ✓ —— 它不是密钥 ✗）',
		(await panelJson('/panel/notes/panel.json')).status === 200)
	check('🔴 不认识的类型**不发** ✓（免得顺手把别的文件泄出去 ✗）',
		(await panelJson('/panel/notes/index.html.bak')).status === 404)

	// ⑤ 用户面板：能覆盖同 id 的示例 ✓；坏清单**计数**而不是静默 ✓。
	await mkdir(join(scratch, 'mobile-panels', 'notes'), { recursive: true })
	await writeFile(join(scratch, 'mobile-panels', 'notes', 'panel.json'),
		JSON.stringify({ title: '我的便签', icon: '🗒', kind: 'tool', entry: 'index.html' }), 'utf8')
	await writeFile(join(scratch, 'mobile-panels', 'notes', 'index.html'), '<!doctype html><b>mine</b>', 'utf8')
	await mkdir(join(scratch, 'mobile-panels', 'broken'), { recursive: true })
	await writeFile(join(scratch, 'mobile-panels', 'broken', 'panel.json'), '{ 这不是 json', 'utf8')
	const merged = await (await fetch(`${base}/api/panels`, authed)).json()
	const notes = (merged.panels ?? []).find((panel) => panel.id === 'notes')
	check('用户自己的面板覆盖同 id 的自带示例 ✓（标题变成"我的便签"、builtin=false ✓）',
		notes !== undefined && notes.title === '我的便签' && notes.builtin === false,
		JSON.stringify(notes ?? null))
	check('坏清单**计数**出来 ✓（`skipped ≥ 1` —— 不静默跳过 ✗）', Number(merged.skipped) >= 1, `skipped=${merged.skipped}`)
	check('覆盖之后发的是**用户那份** ✓（不是示例 ✓）',
		(await panelJson('/panel/notes/index.html')).body.includes('mine'))

	// 收尾：关掉 ✓（后面的用例按默认行为跑 ✓），并把用户目录清掉 ✓。
	await writeConfig2({ panels: false })
	await rm(join(scratch, 'mobile-panels'), { recursive: true, force: true })
}

/*
 * 3.3.0 个人知识库（会话全文检索）—— 桥侧只做"接出来 + 如实" ✓：
 * ① 空关键词 / 太长 → 400 ✓（不当成"搜了没结果" ✗）；
 * ② 宿主抛错 → **503 且不回空列表** ✓（"读不到就说读不到" ✓）；
 * ③ **不自己造条数上限** ✓ —— 发给宿主的请求体里**只有 `query`** ✓（这条最值钱 ✓）；
 * ④ `hasMore` **如实转** ✓；⑤ 标题对不上就**留空** ✓（不假装 ✓）。
 */
{
	const search = async (query, headers) => {
		const response = await fetch(`${base}/api/knowledge/search?q=${encodeURIComponent(query)}`, { ...authed, ...(headers ?? {}) })
		return { status: response.status, body: await response.json().catch(() => null) }
	}
	const before = STATE.searches.length

	const empty = await search('   ')
	check('检索：空关键词 → **400** ✓（不当成"搜了没结果" ✗ —— 那是两件事 ✓）',
		empty.status === 400, `status=${empty.status}`)
	check('检索：关键词太长（>200 字）→ **400** ✓（不拿去打宿主的接口 ✗）',
		(await search('x'.repeat(201))).status === 400)

	const listed = 'session-in-list'
	const ok = await search('弱网')
	const items = Array.isArray(ok.body?.items) ? ok.body.items : []
	check('检索：正常一条 → **200** ✓ 且 `hasMore` **如实转** ✓（宿主说还有就还有 ✓）',
		ok.status === 200 && items.length === 2 && ok.body.hasMore === true,
		`status=${ok.status} items=${items.length} hasMore=${ok.body?.hasMore}`)
	check('🔴 检索：**发给宿主的请求体里只有 `query`** ✓（不自己造 limit/cursor ✗ —— 上限由宿主自己管 ✓）',
		JSON.stringify(STATE.searches.at(-1) ?? {}) === JSON.stringify({ query: '弱网' }),
		JSON.stringify(STATE.searches.at(-1) ?? null))
	/*
	 * 实测结论（复查第 53 轮 ✓）：这台宿主的列表**一直有标题** ✓ —— 在 `projections.values.title` 里 ✓；
	 * 是我们原来读错了字段 ✗。⚠️ 这条断言原来写 `typeof item.title === 'string'` ✗ —— **`''` 也满足** ✓ →
	 * 全空照样绿 ✓（复查点名的假象断言 ✓，而它本该当场抓住那个字段 bug ✗）。
	 * 现在钉**真标题** ✓（桩里那条的标题来自 `projections.values.title` ✓）→ 读错字段必红 ✓✓。
	 */
	const titled = ((await search('弱网')).body?.items ?? []).find((item) => item.sessionId === 'session-test')
	check('🔴 搜索结果的标题**来自投影**（`projections.values.title`）✓ —— 钉真标题 ✓（读错字段必红 ✗）',
		titled !== undefined && titled.title === '手机桥接测试',
		JSON.stringify(((await search('弱网')).body?.items ?? []).map((item) => [item.sessionId, item.title])).slice(0, 100))
	check('对不上列表的那条**留空** ✓（拿不到就不假装 ✗）',
		((await search('弱网')).body?.items ?? []).some((item) => item.sessionId === 'session-not-in-list' && item.title === ''),
		'（空标题那条必须留空 ✓）')

	const none = await search('none')
	check('检索：一条都没搜到 → **200 + 空列表** ✓（这是真结果 ✓，与"搜不了"分开 ✗）',
		none.status === 200 && Array.isArray(none.body?.items) && none.body.items.length === 0)

	const boom = await search('boom')
	check('🔴 检索：宿主报错 → **503 + 原话** ✓、**不回空列表** ✗（"读不到就说读不到" ✓ —— 假装搜过了最坏 ✓）',
		boom.status === 503 && String(boom.body?.error ?? '').includes('搜不了')
		&& Array.isArray(boom.body?.items) !== true,
		`status=${boom.status} body=${JSON.stringify(boom.body).slice(0, 60)}`)
	check('（对照）一共真打过 ' + (STATE.searches.length - before) + ' 次宿主检索 ✓（400 那两次**不该**打过去 ✗）',
		STATE.searches.length - before === 6, `实际 ${STATE.searches.length - before} 次（应当是 6 ✓）`)
	for (const entry of STATE.searches.slice(before)) {
		if (JSON.stringify(entry) !== JSON.stringify({ query: entry.query })) { check('（请求体只许有 query ✓）', false, JSON.stringify(entry)); break }
	}
}

/*
 * 3.3.0「这周学了什么」—— 桥侧只做"用已有的列表 + 如实" ✓：
 * ① 200 且形状对 ✓（**不依赖那个本机没开的检索** ✓ —— 这条是这一版能用的原因 ✓）；
 * ② `days` **夹取**（999→30 ✓、-5→1 ✓）与**兜底**（abc→7 ✓）—— 别让人把列表全拉出来 ✗；
 * ③ 读不到就要 **503 + 原话** ✓（"不是'这周你什么都没学'" ✗ —— 两件事 ✓）—— 桩的 list 不抛错 ✓，
 *    所以这条**留给真宿主实测记录**（第 39–43 轮做了 ✓），这里只钉前两条 ✓（不写一个永远绿的假断言 ✗）。
 */
{
	const week = async (query) => {
		const response = await fetch(`${base}/api/knowledge/week${query}`, authed)
		return { status: response.status, body: await response.json().catch(() => null) }
	}
	const ok = await week('?days=7')
	check('这周学了什么：**200 且形状对** ✓（走已有的会话列表 ✓ —— 不依赖本机**没开**的检索 ✓）',
		ok.status === 200 && Number.isFinite(Number(ok.body?.days)) && Array.isArray(ok.body?.items)
		&& Number(ok.body?.count) === (ok.body?.items?.length ?? -1),
		`status=${ok.status} days=${ok.body?.days} count=${ok.body?.count}`)
	check('这周学了什么：`days` **上限夹取** ✓（999 → 30 ✓ —— 否则能让人把列表全拉出来 ✗）',
		(await week('?days=999')).body?.days === 30)
	check('这周学了什么：`days` **下限夹取**与**兜底** ✓（-5 → 1 ✓、abc → 7 ✓）',
		(await week('?days=-5')).body?.days === 1 && (await week('?days=abc')).body?.days === 7)
	check('这周学了什么：每条都带 **`idShort`** ✓（实测这台宿主的列表**不带标题** ✓ → 手机靠它认人 ✓）',
		(await week('?days=9999')).body?.items?.every((item) => String(item.idShort ?? '').length > 0
			&& String(item.idShort).includes('session-') === false) === true
		|| (await week('?days=7')).body?.items?.length === 0,
		'（列表为空时不算失败 ✓ —— 桩里的行可能没有 updatedAt ✓）')
}

/*
 * 🔴 复查（第 83 轮）R1：**冷启动就该订上** ✓ —— 启动前配置里已经写好 `webhookUrl` ✓（见文件头 ✓），
 * 到这里**一次订阅路由都没调过** ✓ → 所以此刻挂着的监听器只可能来自启动路径 ✓。
 * 修之前这里是 0 个监听器、0 次投递、日志零行 ✗ —— 核心承诺只在"手工调过订阅接口"的进程里成立 ✗。
 */
{
	const { createHmac } = await import('node:crypto')
	const names = ['api-session/status', 'api-session/error', 'api-session/activity']
	check('🔴 冷启动（配置里已写好 webhookUrl、**没调过订阅接口**）：三个事件各挂 **1** 个监听器 ✓（复查 R1）',
		names.every((name) => (waterfallListeners.get(name) ?? []).length === 1),
		names.map((name) => `${name.split('/')[1]}=${(waterfallListeners.get(name) ?? []).length}`).join(' '))
	for (const listener of waterfallListeners.get('api-session/status') ?? []) { try { listener('session-cold-start', true) } catch { /* 无所谓 */ } }
	await new Promise((resolve) => setTimeout(resolve, 400))
	check('🔴 冷启动的订阅**真的会投递** ✓（接收器收到 1 次；修之前 0 次 ✗ —— 复查 R1 的实测就是这个 0）',
		coldHits.length === 1, `hits=${coldHits.length}`)
	if (coldHits.length === 1) {
		const expected = 'sha256=' + createHmac('sha256', coldSecret).update(coldHits[0].body, 'utf8').digest('hex')
		check('冷启动投递也**带对签名** ✓（冷启动那条路不是"野路子"✓）',
			coldHits[0].headers['x-dsh-signature'] === expected && coldHits[0].headers['x-dsh-event'] === 'api-session/status',
			String(coldHits[0].headers['x-dsh-signature'] ?? '(没有)').slice(0, 24))
	}
	const wholeLog = await readFile(join(scratch, 'mobile-bridge.log'), 'utf8').catch(() => '')
	check('🔴 冷启动的订阅**在审计日志里留了一行** ✓（复查 R1：修之前连"没配"那行都被静默丢掉 ✗）',
		wholeLog.includes('webhook：已订阅') && wholeLog.includes('api-session/status'),
		wholeLog.split('\n').filter((line) => line.includes('webhook')).slice(0, 2).join(' | ').slice(0, 160) || '(日志里没有任何 webhook 行 ✗)')
}

/*
 * 3.4.0 开放接口：**正路径**（配了 URL 之后，事件来了会真的投递）——
 * 这是第 69 轮之后唯一还没验的那条 ✓（"默认关"和"订阅会跑"都已真机验过 ✓）。
 *
 * 做法（确定性 ✓，不靠真宿主事件）：
 *  ① 写一份带 `webhookUrl`（指向本文件里起的接收器 ✓）与 `webhookSecret` 的配置 ✓；
 *  ② 调那条**按需订阅**路由 ✓（`POST /api/webhook/subscribe` ✓）—— 只为验"改完配置立刻生效"这条入口 ✓
 *     （自动订阅点在 `start()` 里 ✓，冷启动那条另有断言 ✓；复审第 83 轮 N2 校正：以前这里写"热重载不重跑
 *     createBridge"✗，**与事实相反** ✓，别信 ✓）；
 *  ③ 从假 ctx 收集到的监听器里**取出** `api-session/status` 那个 ✓，自己调一次（就当"真事件来了" ✓）；
 *  ④ 断言：接收器**真收到了** ✓、`x-dsh-event` 对 ✓、**签名与本地算的一致** ✓、
 *     且正文里**没有会话内容** ✓（只有 sessionId/running/时间 ✓）。
 */
{
	const { createServer } = await import('node:http')
	const { createHmac } = await import('node:crypto')
	let got = null
	let deliveries = 0
	const hits = []
	const receiver = createServer((req, res) => {
		let body = ''
		req.on('data', (chunk) => { body += chunk })
		req.on('end', () => {
			deliveries += 1
			hits.push({ headers: req.headers, body })
			if (deliveries === 1) got = { headers: req.headers, body }
			// 第 1 次：200 + 正文 ✓；第 2 次：**200 空正文** ✓（第 75 轮点名的那半 ✓）；
			// 第 3 次起：**204**（规范意义上的成功、本来就**没有**正文 ✓ —— 复查第 83 轮 R9：对它告警是把正常当异常 ✗）。
			res.statusCode = deliveries >= 3 ? 204 : 200
			res.end(deliveries === 1 ? 'ok' : '')
		})
	})
	await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve))
	const target = 'http://127.0.0.1:' + receiver.address().port + '/hook'
	const secret = '测试用-hmac-秘密'

	const readConfig = async () => JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	const writeConfig = async (patch) => writeFile(join(scratch, 'mobile-bridge.json'),
		JSON.stringify({ ...await readConfig(), ...patch }, null, 2), 'utf8')

	// ⚠️ 先重新登录 ✓：跑到文件末尾时 `authed` 那枚 cookie 早被前面的登出/踢设备用例作废了 ✗
	//（语音那组踩过同一个坑 ✓ —— 那时也是靠开头重新登录解决的 ✓）。
	const freshLogin = await fetch(`${base}/api/login`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: config.pin }),
	})
	const freshCookie = (freshLogin.headers.get('set-cookie') ?? '').split(';')[0]
	authed.cookie = freshCookie
	if (authed.headers !== undefined) authed.headers.cookie = freshCookie

	await writeConfig({ webhookUrl: target, webhookSecret: secret })
	const subscribed = await fetch(`${base}/api/webhook/subscribe`, { method: 'POST', headers: { ...authed, 'content-type': 'application/json' }, body: '{}' })
	const subBody = await subscribed.json().catch(() => null)
	check('按需订阅：配了 URL → 200 且说"已按当前配置订阅" ✓',
		subscribed.status === 200 && String(subBody?.note ?? '').includes('已按当前配置订阅'), JSON.stringify(subBody))

	const listeners = waterfallListeners.get('api-session/status') ?? []
	check('订阅真的挂到了宿主事件上 ✓（假 ctx 里收到了 `api-session/status` 的监听器 ✓）',
		listeners.length === 1, '监听器数=' + listeners.length)
	/*
	 * 🔴 复查（第 75 轮）点名的那条**假象断言** ✓（第 82 轮修）：原来只写 `length >= 1` ✗ ——
	 * 它既咬不住"路由啥也没干"（启动无配置时曾挂 3 个 ✓ → 恒真 ✗），更咬不住**订阅泄漏** ✗。
	 * 泄漏的现场：`subscribeWebhooks()` 每次都先 `webhookEffectDisposer?.()` 撤旧的 ✓，
	 * 而假 ctx 的 `effect` 原来返回**空函数** ✗ → 撤不掉 ✗ → 连订两次多一套监听器 ✗
	 * （真宿主上 = **同一条事件被投递两次** ✗，"投递风暴"就是这么来的 ✓）。
	 */
	const beforeResubscribe = (waterfallListeners.get('api-session/status') ?? []).length
	const resubscribeResponse = await fetch(`${base}/api/webhook/subscribe`, { method: 'POST', headers: { ...authed, 'content-type': 'application/json' }, body: '{}' })
	const resubscribeBody = await resubscribeResponse.json().catch(() => null)
	const afterResubscribe = (waterfallListeners.get('api-session/status') ?? []).length
	/* ⚠️ 复查（第 83 轮）R11：**先证明这次请求真的跑到了** ✓ —— 否则它要是 401 / 路由早退，
	 * 下面"数量没变"就会**空过**（本文件自己就两次踩过"cookie 已失效"✗）。 */
	check('（前置）第二次订阅请求**真的成功了** ✓（200 + 回话说订了什么 ✓ —— 不然下面那条计数是空过 ✗）',
		resubscribeResponse.status === 200 && String(resubscribeBody?.note ?? '').includes('已按当前配置订阅'),
		`${resubscribeResponse.status} ${String(resubscribeBody?.note ?? '').slice(0, 70)}`)
	check('🔴 连调两次订阅：监听器**不增加** ✓（`effect` 必须返回真 disposer ✓ —— 否则同一事件被投递两次 ✗）',
		beforeResubscribe === 1 && afterResubscribe === beforeResubscribe,
		`第一次订阅后 ${beforeResubscribe} → 再订一次 ${afterResubscribe}`)
	for (const listener of listeners) { try { listener('session-webhook-test', true) } catch { /* 无所谓 */ } }
	await new Promise((resolve) => setTimeout(resolve, 400))

	check('🔴 事件来了**真的投递** ✓（接收器收到了 POST ✓）', got !== null,
		got === null ? '接收器什么也没收到 ✗' : '收到了 ✓')
	if (got !== null) {
		check('投递头对 ✓（`x-dsh-event` = 事件名 ✓）', got.headers['x-dsh-event'] === 'api-session/status',
			String(got.headers['x-dsh-event']))
		const expected = 'sha256=' + createHmac('sha256', secret).update(got.body, 'utf8').digest('hex')
		check('🔴 **HMAC 签名与本地算的一致** ✓（对方据此能验真 ✓、伪造不了 ✗）',
			got.headers['x-dsh-signature'] === expected,
			String(got.headers['x-dsh-signature'] ?? '(没有)').slice(0, 24))
		const payload = JSON.parse(got.body)
		check('🔴 正文里**没有会话内容** ✓（只有事件名/sessionId/running/时间 ✓）',
			payload.event === 'api-session/status' && payload.sessionId === 'session-webhook-test'
			&& payload.running === true && Object.keys(payload).length <= 5,
			JSON.stringify(payload).slice(0, 110))
	}
	/*
	 * 🔴 复查（第 75 轮）🟡 的另一半 ✓：**"2xx 但正文为空"原来什么也不记** ✗ —— `302` 降级那半
	 * 已被 `redirect:'manual'` 挡住 ✓，但"200 + 空正文"这半没人管 ✓：可能对方收了 ✓、
	 * 也可能被中间层吞了 ✗，我们**不知道** ✓ → 所以至少要有一行 ✓。这里让接收器第二次回空正文 ✓。
	 * ⚠️ 增量取法：`record()` 是**纯追加** ✓（`appendFile` + `[时间] 行\n` ✓，见 `lib/index.js:1433` ✓），
	 * 所以"读两次、取后一次的尾巴"成立 ✓；万一被截断过（>512KB ✓ 这里不可能 ✓）就整份兜底 ✓。
	 */
	{
		const logPath = join(scratch, 'mobile-bridge.log')
		const before = await readFile(logPath, 'utf8').catch(() => '')
		for (const listener of waterfallListeners.get('api-session/status') ?? []) { try { listener('session-webhook-empty', true) } catch { /* 无所谓 */ } }
		await new Promise((resolve) => setTimeout(resolve, 500))
		const after = await readFile(logPath, 'utf8').catch(() => '')
		const fresh = after.startsWith(before) ? after.slice(before.length) : after
		check('🔴 2xx 但**正文为空**：审计日志要记一行 ✓（复查点名的那半 ✓ —— 原来当成功、什么都不写 ✗）',
			fresh.includes('正文为空'), fresh.trim().split('\n').slice(-2).join(' | ').slice(0, 150) || '(日志里没有新行 ✗)')
	}

	/*
	 * 🔴 复查（第 83 轮）R9：**204 不许告警** ✗ —— README 自己的示例接收端就回 `204` ✓，
	 * 对它写"正文为空、说不准"是把**规范意义上的成功**当异常 ✓ → 每投一次警告一行 ✗，真信号会被淹掉 ✓。
	 * （接收器第 3 次起回 204 ✓；上面那半是 200 + 空正文 ✓ —— 那一半**必须**仍然告警 ✓。）
	 */
	{
		const logPath = join(scratch, 'mobile-bridge.log')
		const before = await readFile(logPath, 'utf8').catch(() => '')
		for (const listener of waterfallListeners.get('api-session/status') ?? []) { try { listener('session-webhook-204', true) } catch { /* 无所谓 */ } }
		await new Promise((resolve) => setTimeout(resolve, 500))
		const after = await readFile(logPath, 'utf8').catch(() => '')
		const fresh = after.startsWith(before) ? after.slice(before.length) : after
		check('🔴 对方回 **204**（成功、规范上就没有正文）时**不告警** ✓（把正常当异常会淹掉真信号 ✗ —— 复查 R9）',
			fresh.includes('正文为空') !== true, fresh.trim().split('\n').slice(-2).join(' | ').slice(0, 140) || '(没有新行 ✓)')
	}

	/*
	 * 🔴 复查（第 83 轮）R6：配置里写**重复事件** → 只许挂**一个**监听器 ✓。
	 * 修之前实测：`["api-session/status","api-session/status"]` → 2 个监听器 → **一次事件投两次** ✗
	 * （最短的那条"投递风暴"路径 ✓）。
	 */
	{
		await writeConfig({ webhookEvents: ['api-session/status', 'api-session/status'] })
		await fetch(`${base}/api/webhook/subscribe`, { method: 'POST', headers: { ...authed, 'content-type': 'application/json' }, body: '{}' })
		const dupCount = (waterfallListeners.get('api-session/status') ?? []).length
		check('🔴 配置里写重复事件 → 只挂 **1** 个监听器 ✓（复查 R6：不去重的话一次事件投两次 ✗）',
			dupCount === 1, `监听器数=${dupCount}`)
		await writeConfig({ webhookEvents: [] })
		await fetch(`${base}/api/webhook/subscribe`, { method: 'POST', headers: { ...authed, 'content-type': 'application/json' }, body: '{}' })
	}

	/*
	 * 🔴 复查（第 83 轮）R13：`api-session/activity` 的**发生时间**必须单独带出来 ✓ ——
	 * 以前它被映射成 `at` ✗，而载荷里的 `at` 一律是"投递时刻" ✓ → 对方拿到的是**错的时间**、还看不出来 ✗。
	 */
	{
		const activityAt = 1700000000000
		for (const listener of waterfallListeners.get('api-session/activity') ?? []) { try { listener('session-activity-test', activityAt) } catch { /* 无所谓 */ } }
		await new Promise((resolve) => setTimeout(resolve, 400))
		const hit = hits.find((entry) => entry.headers['x-dsh-event'] === 'api-session/activity')
		let payload = null
		try { payload = hit === undefined ? null : JSON.parse(hit.body) } catch { payload = null }
		check('🔴 `api-session/activity` 带出宿主的 **`updatedAt`** ✓（且 `at` 仍是投递时刻 ✓ —— 复查 R13）',
			payload !== null && payload.updatedAt === activityAt && payload.at !== activityAt,
			JSON.stringify(payload ?? null).slice(0, 120))
	}

	/*
	 * 🔴 复查（第 83 轮）R2：投递侧**不许把响应体全量读进内存** ✗ ——
	 * 修之前实测：对方回 200 + 32MB，进程 RSS 65MB → 187MB ✓（`text()` 没有上限 ✓，8s 超时只管时间 ✓）。
	 * 这里用**同进程 RSS 增量**兜住它 ✓（阈值给得很宽 64MB ✓ —— 只要别再把 32MB 读进来就够 ✓；
	 * 修之前那条会红 ✓）。32MB 缓冲在**测量之前**就分配好 ✓，否则它自己会把基线顶高 ✗。
	 */
	{
		const BIG = Buffer.alloc(32 * 1024 * 1024, 0x41)
		const bigReceiver = createServer((req, res) => {
			req.on('data', () => {})
			req.on('end', () => { res.statusCode = 200; res.end(BIG) })
		})
		await new Promise((resolve) => bigReceiver.listen(0, '127.0.0.1', resolve))
		await writeConfig({ webhookUrl: `http://127.0.0.1:${bigReceiver.address().port}/big`, webhookSecret: secret })
		await fetch(`${base}/api/webhook/subscribe`, { method: 'POST', headers: { ...authed, 'content-type': 'application/json' }, body: '{}' })
		const rssBefore = process.memoryUsage().rss
		for (const listener of waterfallListeners.get('api-session/status') ?? []) { try { listener('session-webhook-big', true) } catch { /* 无所谓 */ } }
		await new Promise((resolve) => setTimeout(resolve, 1200))
		const grew = Math.round((process.memoryUsage().rss - rssBefore) / (1024 * 1024))
		check('🔴 对方回 **32MB** 正文时不许全量读进内存 ✓（复查 R2：修之前 RSS +122MB ✗；现在只读第一块 + cancel ✓）',
			grew < 64, `RSS 增量 ${grew}MB（阈值 64MB ✓）`)
		bigReceiver.close()
	}

	receiver.close()
	/*
	 * 收尾：把 webhook 配置清掉 ✓（别给后面的用例留一个会往外发东西的开关 ✗）。
	 * 🔴 复查（第 83 轮）R3 + "默认关"：顺手把"没配"那条分支钉住 ✓ ——
	 * 修之前它 `return undefined` ✗ → 路由兜底成"**已按当前配置订阅 ✓**" ✗（0 个监听器也报成功 ☠）。
	 */
	await writeConfig({ webhookUrl: '', webhookSecret: '', webhookEvents: [] })
	const offResponse = await fetch(`${base}/api/webhook/subscribe`, { method: 'POST', headers: { ...authed, 'content-type': 'application/json' }, body: '{}' })
	const offBody = await offResponse.json().catch(() => null)
	const offNote = String(offBody?.note ?? '')
	check('🔴 默认关（没配 webhookUrl）时订阅接口**说实话** ✓（复查 R3：必须说"没配、一个都没订"✗ 不许说"已订阅 ✓"）',
		offResponse.status === 200 && offNote.includes('没配') && offNote.includes('已按当前配置订阅') === false,
		`${offResponse.status} ${offNote.slice(0, 90)}`)
	const offCount = (waterfallListeners.get('api-session/status') ?? []).length
	check('🔴 关掉之后监听器**归零** ✓（撤掉上一次的订阅 ✓ —— 不订也不留钩子 ✓）',
		offCount === 0, `监听器数=${offCount}`)
}

/*
 * 3.4.0 复查（第 75 轮）点名：`allowWebhookUrl` **零测试覆盖** ✗ ——
 * 而 CHANGELOG 却声称"出站白名单四类坏地址全拒 ✓ 是这一版钉住的" ✓。
 * 这里把它钉住：**用复查实测过的那些"曾被放行"的写法当反例** ✓（它们必须变成拒绝 ✗）。
 */
{
	const { allowWebhookUrl } = await import('../lib/webhook.js')
	const mustReject = [
		// 复查实测：这些原来**全被放行** ✗ —— 现在必须拒 ✓
		'https://[::ffff:169.254.169.254]/latest/meta-data/',
		'https://[::ffff:10.0.0.1]/x',
		'https://[::ffff:192.168.1.1]/x',
		'https://[fd00::1]/x',
		'https://[fe80::1]/x',
		'https://[2002::1]/x',
		'https://[::]:8443/admin',
		'https://[::1]:9200/_search',
		'https://0.0.0.0:8443/admin',
		'https://foo.internal./x',
		'https://my-router.lan/x',
		'https://printer.local/x',
		// 复查（第 83 轮）R7：带用户名/密码的 URL —— `fetch` 永远不会用它（TypeError ✓），
		// 而且那等于**把密码写在配置里** ✓ → 必须在白名单这一关就拒掉 ✓。
		'https://user:P%40ssw0rd-LEAKME@example.invalid/hook',
		'http://user@127.0.0.1:8787/hook',
		// ⚠️ `https://localtest.me/x`（公网域名、解析到 127.0.0.1）**故意不列在这里** ✗ ——
		// 白名单是字面串判断 ✓ → 挡不住「解析后才内指」的域名 ✓；这条缺口在下面单独记着 ✓（哨兵断言 ✓）。
		// 原本就挡得住的老反例 ✓
		'file:///C:/Windows/win.ini',
		'ftp://192.168.1.5/x',
		'data:text/plain,hi',
		'http://10.0.0.5/x',
		'http://172.16.0.5/x',
		'http://192.168.1.5/x',
		'http://169.254.169.254/latest',
		'http://metadata.google.internal/x',
		'http://0.0.0.0:8787/x',
		'',
		'这不是网址',
	]
	const mustAllow = [
		'https://example.com/hook',
		'https://example.com:8443/hook?x=1',
		'http://127.0.0.1:8787/hook',
		'http://localhost:8787/hook',
	]
	let rejected = 0
	for (const url of mustReject) {
		const verdict = allowWebhookUrl(url)
		if (verdict.ok !== true) rejected += 1
		else check('🔴 出站白名单**必须拒**：' + url.slice(0, 44), false, verdict.url)
	}
	check('🔴 出站白名单：复查列出的**全部坏地址都被拒** ✓（' + rejected + '/' + mustReject.length + ' ✓）',
		rejected === mustReject.length, '被放行的：' + mustReject.filter((url) => allowWebhookUrl(url).ok === true).join(' , ').slice(0, 120))
	let allowed = 0
	for (const url of mustAllow) {
		const verdict = allowWebhookUrl(url)
		if (verdict.ok === true) allowed += 1
		else check('白名单**不该拒**：' + url, false, String(verdict.reason))
	}
	check('白名单：正常地址（https / 本机 http）**照常放行** ✓（别把功能一起卡死 ✗）',
		allowed === mustAllow.length, allowed + '/' + mustAllow.length)
	// 🔔 **哨兵** ✓：这条记着「**还没做**的那一半」 ✓ —— 公网域名解析到内网（`localtest.me`、`*.nip.io` ✓）。
	// 现在它**会**被放行 ✓（字面串判断挡不住 ✓）；将来在投递时加了 `dns.lookup` 校验全部结果 ✓，
	// 这条就会**变红** ✓ → 那时请把它改成「必须拒」 ✓（缺口变成会咬的哨兵 ✓，而不是永远绿的空话 ✗）。
	check('☐ 已知缺口（哨兵）：域名「解析后才内指」的写法目前仍放行 ✗ —— 做了 DNS 校验后这条会变红 ✓',
		allowWebhookUrl('https://localtest.me/x').ok === true,
		'已经能拒了？✓ 请把这里改成「必须拒」 ✓')
}

/*
 * 3.3.2：放行页的地址与链接必须「带前缀也点得通」 ✓ —— 用户实测踩过这个坑 ✗：
 * 403 页给的地址漏了 pathSecret ✓（照着点 404 ✗）、页面上「放行 / 拒绝」是绝对路径 ✗（同样 404 ✗）。
 * ⚠️ 断言要**真咬** ✓：3.3.1 的 bug 只在「403 页印的地址」与「页面里的链接」上 ✓ ——
 *   "放行页能开 200" 在 3.3.1 上**本来就是绿的** ✗（上面已有一条同样的断言 ✓）；
 *   而没有待放行设备时页面**一个链接都不渲染** ✓ → "不得出现绝对路径"会**空过** ✗。
 *   所以这里 ① 把 403 页印的地址**抠出来再打一次** ✓、② 先造一台等放行的设备让链接**真的画出来** ✓。
 */
{
	const readConfig332 = async () => JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	const writeConfig332 = async (patch) => writeFile(join(scratch, 'mobile-bridge.json'), JSON.stringify({ ...await readConfig332(), ...patch }, null, 2), 'utf8')
	await writeConfig332({ deviceApproval: true })
	const waiting = await fetch(`${base}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.201' },
		body: JSON.stringify({ pin: config.pin }),
	})
	const waitingBody = await waiting.json().catch(() => ({}))

	// ① 非本机（手机 / 域名）打放行页 → 403 ✓，页面上印的"请在电脑上打开"地址必须**带 pathSecret**，
	//    而且**照着它真能打开** ✓（3.3.1 印的是裸地址 → 404 ✗ —— "怎么放都不行"就是这么来的 ✓）。
	const denied = await fetch(`${base}/approve`, { headers: { 'x-forwarded-for': '203.0.113.202' } })
	const deniedHtml = await denied.text()
	const printed = (/href="(http:\/\/127\.0\.0\.1:\d+\/[^"]+)"/.exec(deniedHtml) ?? [])[1] ?? ''
	const printedStatus = printed === '' ? 0 : (await fetch(printed)).status
	check('🔴 403 页印的本机地址**带 pathSecret**、照着它打是 **200** ✓（3.3.1 印的裸地址 → 404 ✗）',
		denied.status === 403 && printed.includes(`/${config.pathSecret}/`) && printedStatus === 200,
		printed === '' ? `403 页里没找到本机地址（status=${denied.status}）` : `${printed} → ${printedStatus}`)

	// ② 放行页上的「放行 / 拒绝」必须是**相对路径** ✓（绝对路径 `/approve?…` 在带前缀的页面上必 404 ✗），
	//    而且这两个链接**真的渲染出来了** ✓（否则"没有绝对路径"是空话 ✗）。
	const page332 = await (await fetch(`${base}/approve`)).text()
	check('🔴 放行页上的链接**渲染出来了、且是相对路径** ✓（绝对路径 `/approve?…` 点了必 404 ✗）',
		page332.includes('href="approve?action=approve') && page332.includes('href="approve?action=deny')
		&& page332.includes('href="/approve') !== true,
		`等放行=${JSON.stringify(waitingBody).slice(0, 50)} links=${(page332.match(/href="[^"]*approve[^"]*"/g) ?? []).join(' , ').slice(0, 120)}`)

	await writeConfig332({ deviceApproval: false })
}
/*
 * --- 3.5.0「目标」：把 DSH 的目标摆到手机上（**只读** ✓）-------------------------
 * 上游查实 ✓：`agents.get(sessionId)`（**活着的** agent ✓，不唤醒 ✓）→ `goals.get(agent)` ✓。
 * 这一组钉的是**语义**：在跑的会话读得到 ✓；**没在跑**的会话要如实说"没在跑" ✓
 *（不许说成"没有目标" ✗，那是两件事 ✗）；宿主缺服务时也要说清是哪一环 ✓。
 */
{
	const login = await fetch(`${base}/api/login`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: config.pin }),
	})
	const jar = { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] }
	const goalOf = async (sessionId) => (await (await fetch(`${base}/api/goal?sessionId=${encodeURIComponent(sessionId)}`, { headers: jar })).json())

	const live = await goalOf('session-test')
	check('🔴 在跑的会话：读得到目标（原文 + 阶段 + 轮次 + armed ✓，字段名照上游契约 ✓）',
		live.ok === true && String(live.goal?.objective ?? '').includes('4.0.0') && live.goal?.phase === 'active'
		&& live.goal?.roundsStarted === 7 && live.goal?.maxGoalRounds === 12 && live.goal?.activation === 'armed',
		JSON.stringify(live).slice(0, 150))
	const idle = await goalOf('session-blank')
	check('🔴 没在跑的会话：**如实说"没在跑"** ✓ —— 不许说成"这条会话没有目标"✗',
		idle.ok === false && String(idle.message ?? '').includes('没在跑'), JSON.stringify(idle).slice(0, 130))
	check('不带 sessionId：400 + 说清 ✓（不是 500、也不是空目标 ✗）',
		(await fetch(`${base}/api/goal`, { headers: jar })).status === 400)
	check('没登录：401 ✓', (await fetch(`${base}/api/goal?sessionId=session-test`)).status === 401)
	const savedGoals = services.goals
	delete services.goals
	const noService = await goalOf('session-test')
	services.goals = savedGoals
	check('宿主没有 goals 服务：**说清是哪一环缺** ✓（不假装"没有目标"✗）',
		noService.ok === false && String(noService.message ?? '').includes('goals'), JSON.stringify(noService).slice(0, 120))
}

/*
 * --- 3.5.0 语音优先：麦克风那扇门 ------------------------------------------
 * 纪律（和 `processControl` / `powerControl` 同一条 ✓）：**默认关** ✓、开要**现输 PIN** ✓、
 * 有**超时上限** ✓（两边都不许"开着麦克风没人知道"✗）、**「停」不设门** ✓（往安全方向走 ✓）。
 */
{
	const readConfig = async () => JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	const writeConfig = async (patch) => writeFile(join(scratch, 'mobile-bridge.json'),
		JSON.stringify({ ...await readConfig(), ...patch }, null, 2), 'utf8')
	// 跑到文件末尾时 `authed` 那枚 cookie 早被前面的登出用例作废了 ✗ → 重新登录一次 ✓。
	const login = await fetch(`${base}/api/login`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: config.pin }),
	})
	const jar = { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] }
	const post = (payload) => fetch(`${base}/api/voice`, {
		method: 'POST', headers: { ...jar, 'content-type': 'application/json' }, body: JSON.stringify(payload),
	})
	const get = async () => (await (await fetch(`${base}/api/voice`, { headers: jar })).json())

	await writeConfig({ voiceMode: false })
	const off = await get()
	check('语音模式**默认关** ✓：回 enabled:false + 一句"怎么开" ✓（不是"你没权限"这种让人猜的话 ✗）',
		off.enabled === false && String(off.message).includes('voiceMode'), JSON.stringify(off).slice(0, 110))
	check('关着的时候 start 也是 403 + 说清怎么开 ✓', (await post({ action: 'start', pin: config.pin })).status === 403)
	check('没登录读语音状态：401 ✓', (await fetch(`${base}/api/voice`)).status === 401)

	await writeConfig({ voiceMode: true })   // 现读配置 ✓ 不用重启 ✓
	const on = await get()
	check('打开后：enabled:true + 报上限与默认时长 + 把状态机名字发下来 ✓（手机照着画，别两边各写一份 ✗）',
		on.enabled === true && on.maxMinutes === 30 && on.defaultMinutes === 10
		&& Array.isArray(on.states) && on.states.includes('listening') && on.states[0] === 'off',
		JSON.stringify({ enabled: on.enabled, max: on.maxMinutes, default: on.defaultMinutes, states: on.states }).slice(0, 120))
	const noPin = await post({ action: 'start' })
	const noPinBody = await noPin.json().catch(() => ({}))
	check('🔴 开语音模式**必须现输 PIN** ✓（它开的是麦克风 ✓）；缺 PIN → 403 + needPin ✓',
		noPin.status === 403 && noPinBody.needPin === true, `HTTP ${noPin.status} ${JSON.stringify(noPinBody).slice(0, 70)}`)
	await post({ action: 'start', pin: '000000' })
	check('错 PIN → 也开不起来 ✓（`listening` 仍是 false ✓）', (await get()).listening === false)
	const started = await post({ action: 'start', pin: config.pin, minutes: 5 })
	const startedBody = await started.json().catch(() => ({}))
	check('🔴 正确 PIN → 开启，并**给出到期剩余** ✓（超时上限兜住它 ✓）',
		started.status === 200 && startedBody.listening === true
		&& startedBody.remainingMs > 0 && startedBody.remainingMs <= 5 * 60 * 1000 + 1500,
		JSON.stringify(startedBody).slice(0, 120))
	const clamped = await (await post({ action: 'start', pin: config.pin, minutes: 999 })).json().catch(() => ({}))
	check('要 999 分钟 → 只给上限 **30** ✓（别让人无意中开一整天 ✗）',
		clamped.minutes === 30 && clamped.remainingMs <= 30 * 60 * 1000 + 1500, JSON.stringify(clamped).slice(0, 110))
	const stopped = await post({ action: 'stop' })
	const stoppedBody = await stopped.json().catch(() => ({}))
	check('🔴 「停」**不用 PIN** ✓ 且立刻归零 ✓（往安全方向走不设门 ✓）',
		stopped.status === 200 && stoppedBody.remainingMs === 0 && (await get()).remainingMs === 0,
		JSON.stringify(stoppedBody).slice(0, 110))
	await writeConfig({ voiceMode: false })   // 收尾：关回去 ✓（别给后面的用例留一个开着的麦 ✓）
	await post({ action: 'stop' })

	// 纯核心要能被手机页面拿到 ✓（一份实现两边共用 ✓ —— 别让页面再抄一份 ✗）。
	const core = await fetch(`${base}/api/voice/core.js`, { headers: jar })
	const coreText = await core.text()
	check('🔴 语音**纯核心**发给页面 ✓（`api/voice/core.js`：状态机 + 重叠拼接 + "停"的识别 ✓）',
		core.status === 200 && String(core.headers.get('content-type') ?? '').includes('javascript')
		&& coreText.includes('mergeTranscriptSegments') && coreText.includes('nextVoiceState') && coreText.includes('isStopCommand'),
		`HTTP ${core.status} ${String(core.headers.get('content-type') ?? '')}`)
	check('没登录拿不到它 ✓（只有登录后的页面能用 ✓）',
		(await fetch(`${base}/api/voice/core.js`)).status === 401)
}

/*
 * --- 3.5.x「解锁」：唤醒 + 看结果再说话（**不收也不存密码** ✗）-------------------
 * 三条必须钉住 ✓：关着 → 403 + 说清怎么开 ✓；开着但**没带 PIN → 403 + needPin** ✓
 *（**不许真去执行** ✗ —— 这一条最重要 ✓）；错 PIN → 403 ✓。
 * ⚠️ **故意不测成功那条路** ✗：那会真的在这台机器上发一次唤醒输入（动鼠标 ✓）——
 * 没必要为了测试去动用户的机器 ✓。结论（已解锁 / 还锁着 / 读不到）的纯函数
 * 已经在 `test/platform.mjs` 里逐条验过 ✓。
 */
{
	const readConfig = async () => JSON.parse(await readFile(join(scratch, 'mobile-bridge.json'), 'utf8'))
	const writeConfig = async (patch) => writeFile(join(scratch, 'mobile-bridge.json'),
		JSON.stringify({ ...await readConfig(), ...patch }, null, 2), 'utf8')
	const login = await fetch(`${base}/api/login`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: config.pin }),
	})
	const jar = { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] }
	const power = (payload) => fetch(`${base}/api/power`, {
		method: 'POST', headers: { ...jar, 'content-type': 'application/json' }, body: JSON.stringify(payload),
	})

	await writeConfig({ powerControl: false })
	const offBody = await (await power({ action: 'unlock' })).json().catch(() => ({}))
	check('解锁**默认关** ✓：403 + 说清怎么开 ✓（和关机同一套措辞 ✓）',
		String(offBody.error ?? '').includes('powerControl'), JSON.stringify(offBody).slice(0, 100))

	await writeConfig({ powerControl: true })
	// ⏱ 用"`runUnlock` 里那 1.5 秒等待"当证据 ✓：PIN 没过就必须**秒回** ✓ —— 见下面那条会咬的断言 ✓。
	const startedAt = Date.now()
	const noPin = await power({ action: 'unlock' })
	const tookMs = Date.now() - startedAt
	const noPinBody = await noPin.json().catch(() => ({}))
	check('🔴 开着但**没带 PIN → 403 + needPin** ✓（手机据此弹输入框 ✓ —— 昨天真机就是卡在这儿 ✗）',
		noPin.status === 403 && noPinBody.needPin === true, `HTTP ${noPin.status} ${JSON.stringify(noPinBody).slice(0, 80)}`)
	/*
	 * 🔴 **会咬的那一条** ✓（红队复查点名：原来那两条断言，把 `runUnlock()` 挪到 PIN 校验**前面**
	 * 照样全绿 ✗ —— 最要紧的性质没被钉住 ✓）。
	 * 怎么证 ✓：`runUnlock` 里有**一条 1.5 秒的等待**（等屏幕醒过来 ✓）→ 所以"没带 PIN"这次
	 * 必须在 **1 秒内**回来 ✓；谁把执行挪到校验前面 ✗，这条就会花 ≥1.5 秒 → **当场红** ✓。
	 */
	check('🔴 PIN 没过就**绝不许真的去唤醒** ✓（证据：这次必须 <1 秒回来 ✓，而 runUnlock 至少要 1.5 秒 ✓）',
		tookMs < 1000, `${tookMs} ms`)
	const wrong = await power({ action: 'unlock', pin: '000000' })
	const wrongBody = await wrong.json().catch(() => ({}))
	check('错 PIN → 403 ✓（同样带 needPin ✓，手机能再输一次 ✓）',
		wrong.status === 403 && wrongBody.needPin === true)
	/*
	 * 恒真断言换掉 ✓（红队复查第 1 次点名：后端文案是中文，断言"不含英文 password"零证明力 ✗）。
	 * 复查第 2 次又点名：原来只查**没带 PIN**那次 403 的响应体 ✓ —— 按构造它不可能含凭据 ✓，
	 * 把**成功**响应改成回显 pin 也照样绿 ✗。
	 * 现在：三份响应体**都**过白名单 ✓，而且**发出去的 PIN 一个字节都不许回显** ✓
	 *（"错 PIN"那次最有用 ✓：真回显的话 `000000` 就会出现在响应里 ✓）。
	 * ⚠️ 照实说：成功的唤醒那条路**故意不测** ✗（那会真去动用户的鼠标 ✓），它是**真机验**的 ✓。
	 */
	const bodies = [offBody, noPinBody, wrongBody]
	const allowedKeys = ['ok', 'state', 'message', 'error', 'needPin']
	check('🔴 响应里**不回显任何凭据** ✓（三份响应体的键都在白名单里 ✓，且发出去的 PIN 「000000」不出现 ✓）',
		bodies.every((body) => Object.keys(body ?? {}).every((key) => allowedKeys.includes(key)))
		&& bodies.every((body) => JSON.stringify(body ?? {}).includes('000000') === false),
		JSON.stringify(bodies))
	await writeConfig({ powerControl: false })   // 收尾：关回去 ✓（别给后面的用例留一个开着的关机开关 ✓）
}

/* --- 3.6.0「分享到桥」：iOS 快捷指令 POST 一条短链 ------------------------------------ */
/*
 * 用户 2026-10-13 亲口选的第 1 条 ✓（架构规矩：**能不加页面按钮就不加** ✗ —— 这一条整条不碰页面 ✓）。
 * 必须钉住四件事 ✓：
 *   ① **默认关** ✓（`shareIntake: true` 才开 ✓），关着时**一个字都不许进会话** ✗；
 *   ② 开着也要 **PIN 随这次请求** ✓（短链没有 cookie ✓ —— "登录一次"那条路在这儿不存在 ✓）；
 *   ③ 正确 PIN → 走**手机发消息那条路** ✓（`sessionController.prompt` / `mode:'queue'` ✓），
 *      内容带【分享到桥】+ 文本 + 网址 ✓；没指定会话就**自动挑最近一个能用的** ✓；
 *   ④ **回包绝不带 PIN** ✓（快捷指令的输出里不许出现凭据 ✗）。
 *
 * ⚠️ 顺序有讲究 ✗：**先跑一次正确 PIN 的**（它会 `state.attempts.delete(ip)` ✓ 把限速计数器清零 ✓），
 * 再验"错的 PIN 不许进去" ✓ —— 反过来的话，前面十几个用例攒下的错 PIN 次数可能先把这条路限速成 429 ✗
 * （那就会变成一条**假红** ✓，正好是这个项目最恨的东西 ✓）。
 */
{
	const configPath = join(scratch, 'mobile-bridge.json')
	const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'))
	const writeConfig = async (patch) => writeFile(configPath, JSON.stringify({ ...await readConfig(), ...patch }, null, 2), 'utf8')
	/*
	 * ⚠️ 这一段在**文件靠后** ✓ —— 前面几段做过"注销 / 踢掉设备" ✗，共用的 `authed` 那时可能已经失效 ✓
	 * （实测就是这么红的：`GET /api/intake` 拿回来的是 `{error:'unauthorized'}` ✓，`info.url` 自然是 undefined ✗）。
	 * 所以**自己重新登录一次** ✓（靠后的段落都这么做 ✓）；顺带这一步会把限速计数器清零 ✓（下面的错 PIN 用例才稳 ✓）。
	 */
	const relogin = await fetch(`${base}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pin: config.pin }),
	})
	const freshCookie = (relogin.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
	const mine = { headers: { cookie: freshCookie } }
	check('（前置）这一段自己重新登录一次拿新 cookie ✓（前面有段落注销/踢过设备 ✓）',
		relogin.status === 200 && freshCookie.startsWith('dshm='), `HTTP ${relogin.status}`)
	const post = (body) => fetch(`${base}/api/intake`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	const textOf = (prompt) => (prompt?.content ?? []).map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join(' | ')
	const typesOf = (prompt) => (prompt?.content ?? []).map((part) => part.type).join(',')

	// ① 默认关 ✓
	await writeConfig({ shareIntake: false })
	const beforeOff = STATE.prompts.length
	const off = await post({ pin: config.pin, text: '没开的时候不许进来' })
	check('🔴 分享到桥**默认关** ✓：403 + 说清怎么开 ✓，而且**一个字都没进会话** ✗',
		off.status === 403 && STATE.prompts.length === beforeOff,
		`HTTP ${off.status} / prompts +${STATE.prompts.length - beforeOff}`)

	await writeConfig({ shareIntake: true })

	// ② 正确 PIN：内容进"最近那个能用的会话" ✓（自动挑 ✓）
	/*
	 * ⚠️ 先把桩里的会话列表**弄乱一点** ✗（复查第 90 轮点名）：原来的列表里，唯一的 blank 会话
	 * （session-blank）**比 session-test 旧** ✓ —— 所以"自动挑最近那个能用的"其实只钉住了"最近" ✓，
	 * 把那三个过滤（blank / subagent / ownDir）**删掉也照样绿** ✗。
	 * 现在：临时塞两条**比 session-test 更新**的 —— 一条 blank ✓、一条子会话 ✓ ——
	 * 如果过滤没了，被挑中的就会是它们 ✓（断言立刻红 ✓）。
	 *
	 * ⚠️ 还要等**列表缓存过期** ✗：`listSessions()` 有 5 秒缓存 ✓（`state.sessionListCache` ✓），
	 * 前面几十个用例早就把它填上了 ✓ —— 不等就直接发，读到的是**没有这两条的旧列表** ✓，
	 * 于是这条断言会因为"缓存"而绿 ✗（假绿 ✓，正是复查要我治的那种）。
	 */
	await new Promise((resolve) => setTimeout(resolve, 5200))
	const noisy = [
		{ sessionId: 'session-blank-newer', updatedAt: Date.now() + 9000, running: false, blank: true, cwd: 'D:\\tool' },
		{ sessionId: 'session-subagent-newer', updatedAt: Date.now() + 8000, running: false, blank: false, cwd: 'D:\\tool', origin: 'subagent' },
	]
	listItems.push(...noisy)
	const beforeText = STATE.prompts.length
	const textRes = await post({ pin: config.pin, text: '把这条存进笔记', url: 'https://example.com/a' })
	const textBody = await textRes.json().catch(() => ({}))
	const sentText = STATE.prompts[beforeText]
	check('正确 PIN + 文本/网址 → 进了**最近那个能用的**会话 ✓（空会话 / 子会话更新也不挑它们 ✓ —— 三个过滤都得在 ✓）',
		textRes.status === 200 && textBody.ok === true && textBody.sessionId === 'session-test'
		&& sentText?.sessionId === 'session-test' && sentText?.mode === 'queue',
		JSON.stringify({ http: textRes.status, body: textBody, sent: { sessionId: sentText?.sessionId, mode: sentText?.mode } }))
	check('内容里带【分享到桥】+ 文本 + 网址（会话里一眼看得出这条是分享进来的 ✓）',
		textOf(sentText).includes('【分享到桥】') && textOf(sentText).includes('把这条存进笔记')
		&& textOf(sentText).includes('https://example.com/a'),
		textOf(sentText))
	check('🔴 回包里**绝不带 PIN** ✓，而且它得是"成了"的那份回包 ✓（快捷指令的输出/日志里不许出现凭据 ✗）',
		textBody.ok === true && JSON.stringify(textBody).includes(config.pin) === false
		&& JSON.stringify(textBody).includes('000000') === false,
		JSON.stringify(textBody))
	check('requestId 回给调用方 ✓（快捷指令重试时复用同一个 → 宿主幂等，不会变成两条 ✓）',
		/^[A-Za-z0-9-]{8,64}$/.test(String(textBody.requestId ?? '')) && sentText?.requestId === textBody.requestId,
		String(textBody.requestId))

	// ③ 没带 PIN / 错 PIN：**都不许进会话** ✓（这一条会咬 —— 两条都要查 prompts 数 ✗：
	// 复查第 90 轮把 PIN 校验挪到 send 之后，只有"错 PIN"那条红了 ✗，"没带 PIN"那条照样绿 ✓ —— 就是漏了这里）
	const beforeNoPin = STATE.prompts.length
	const noPin = await post({ text: '没带 PIN' })
	const noPinBody = await noPin.json().catch(() => ({}))
	check('🔴 开着但**没带 PIN** → 403 + needPin，而且**一个字都不许进会话** ✗（短链没有 cookie ✓ —— "登录一次"不满足它 ✓）',
		noPin.status === 403 && noPinBody.needPin === true && STATE.prompts.length === beforeNoPin,
		`HTTP ${noPin.status} / prompts +${STATE.prompts.length - beforeNoPin}`)
	const beforeWrong = STATE.prompts.length
	const wrong = await post({ pin: '000000', text: '错 PIN' })
	check('🔴 错 PIN → 403，而且**绝不许真的进会话** ✗（谁把校验挪到发消息后面，这条当场红 ✓）',
		wrong.status === 403 && STATE.prompts.length === beforeWrong,
		`HTTP ${wrong.status} / prompts +${STATE.prompts.length - beforeWrong}`)

	// ④ 边界：指定不存在的会话 / 空内容 / 坏图片类型
	// ⚠️ 这三条的判据都要**带上错误正文** ✗ —— 只看状态码的话，"路由没了"也能凑出 404/400 ✓
	//（摘刀验会咬那次就看见了：404 把 ghost 那条假绿了 ✓）。带上"说清了什么"，它就真有牙 ✓。
	const ghost = await post({ pin: config.pin, text: 'x', sessionId: 'session-nope' })
	const ghostBody = await ghost.json().catch(() => ({}))
	check('指定了不存在的会话 → 404 + 说清"没找到"（**不许**偷偷换个会话发 ✗）',
		ghost.status === 404 && String(ghostBody.error ?? '').includes('没找到'), JSON.stringify(ghostBody))
	const empty = await post({ pin: config.pin })
	const emptyBody = await empty.json().catch(() => ({}))
	check('空内容 → 400 + 说清要带一样（text / url / images ✓）',
		empty.status === 400 && String(emptyBody.error ?? '').includes('内容为空'), JSON.stringify(emptyBody))
	const beforeBadImage = STATE.prompts.length
	const badImage = await post({ pin: config.pin, images: [{ mediaType: 'image/tiff', data: 'AAAA' }] })
	const badImageBody = await badImage.json().catch(() => ({}))
	check('图片类型不支持 → 400 + 点名那个类型，而且不许发出去 ✓（宿主啃不动的格式不塞给它 ✗）',
		badImage.status === 400 && String(badImageBody.error ?? '').includes('image/tiff')
		&& STATE.prompts.length === beforeBadImage,
		JSON.stringify(badImageBody))

	// ⑤ 图片：能进来 ✓；宿主拒了的（动图）→ 存成文件 + 只给路径再发一次 ✓（和手机那条路同一个退路 ✓）
	const beforeImage = STATE.prompts.length
	const goodImage = await post({ pin: config.pin, images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'share.png' }] })
	check('图片能分享进来 ✓（走同一条 prompt 路 ✓，类型/大小都判过 ✓）',
		goodImage.status === 200 && typesOf(STATE.prompts[beforeImage]).includes('image'),
		`${goodImage.status} / ${typesOf(STATE.prompts[beforeImage])}`)
	const beforeGif = STATE.prompts.length
	const gif = await post({ pin: config.pin, images: [{ mediaType: 'image/gif', data: 'R0lGODlhAQABAAAAACw=', name: 'share.gif' }] })
	const gifBody = await gif.json().catch(() => ({}))
	check('🔴 动图被宿主拒了 → **存成文件 + 只给路径再发一次** ✓（绝不干瞪眼 ✗；和手机那条路同款 ✓）',
		gif.status === 200 && typesOf(STATE.prompts[beforeGif + 1]).includes('image') === false
		&& String(textOf(STATE.prompts[beforeGif + 1])).includes('share.gif')
		&& Array.isArray(gifBody.files) && gifBody.files.length === 1,
		JSON.stringify({ http: gif.status, 第一次: typesOf(STATE.prompts[beforeGif]), 重发: typesOf(STATE.prompts[beforeGif + 1]), files: gifBody.files }))

	// ⑥ **收不下的要明说** ✓（复查第 90 轮点名：原来 text/url/图都是静默 slice ✗ —— 本项目最恨"我明明发了啊"✓）
	const longText = 'x'.repeat(9000)
	const manyImages = Array.from({ length: 5 }, (_, index) => ({ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: `m${index}.png` }))
	const beforeCut = STATE.prompts.length
	const cut = await post({ pin: config.pin, text: longText, images: manyImages })
	const cutBody = await cut.json().catch(() => ({}))
	const cutPrompt = STATE.prompts[beforeCut]
	const cutParts = (cutPrompt?.content ?? [])
	check('🔴 文本太长（>8000 字）→ 收下了前 8000 字，而且**内容里 + 回包里都明说截断了** ✗（不许静默丢 ✓）',
		cut.status === 200 && cutBody.truncated === true && cutBody.dropped?.text === true
		&& textOf(cutPrompt).includes('只取了前 8000') && textOf(cutPrompt).includes('x'.repeat(20)),
		JSON.stringify({ truncated: cutBody.truncated, dropped: cutBody.dropped, note: cutBody.note }))
	check('🔴 图超上限（5 张 > 3）→ 只收 3 张，**回包说丢了几张** ✓（内容里也写一句 ✓）',
		cutParts.filter((part) => part.type === 'image').length === 3 && cutBody.dropped?.images === 2
		&& textOf(cutPrompt).includes('另外 2 张图没带上'),
		JSON.stringify({ 收了几张: cutParts.filter((part) => part.type === 'image').length, dropped: cutBody.dropped }))
	check('被截断的那条**照旧发进去了** ✓（不是 413 拒收 —— 收得下就收、收不下的明说 ✓）',
		cutBody.ok === true && cutPrompt?.sessionId === 'session-test', JSON.stringify({ ok: cutBody.ok }))

	// ⑦ 3.7.0「一键 OCR / 扫码」：短链上多带一个 `task` ✓（**白名单** ✓，不许调用方自己写指令 ✗）
	const beforeOcr = STATE.prompts.length
	const ocr = await post({ pin: config.pin, task: 'ocr', text: '这是我的笔记照片', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'page1.png' }] })
	const ocrBody = await ocr.json().catch(() => ({}))
	const ocrPrompt = STATE.prompts[beforeOcr]
	const ocrParts = (ocrPrompt?.content ?? []).map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
	check('🔴 `task:"ocr"` → 内容里**先来源、再固定指令、再用户文本、最后图** ✓（顺序固定 = 模型先知道要干什么 ✓）',
		ocr.status === 200 && ocrBody.task === 'ocr' && ocrBody.ok === true
		&& ocrParts[0] === '【分享到桥】' && String(ocrParts[1]).includes('【任务：OCR】')
		&& String(ocrParts[1]).includes('原样认出来') && ocrParts[2] === '这是我的笔记照片'
		&& ocrParts[3] === '[image]',
		JSON.stringify({ http: ocr.status, task: ocrBody.task, parts: ocrParts.map((x) => String(x).slice(0, 18)) }))
	check('OCR 那条把"可搜索"落到**会话内容**上 ✓（手机上现成的 🔍 搜一搜就能搜到 ✓ —— 不新造搜索 ✗）',
		String(ocrParts[1]).includes('Markdown 笔记') && String(ocrParts[1]).includes('文件路径'),
		String(ocrParts[1]).slice(0, 60))
	const beforeBadTask = STATE.prompts.length
	const badTask = await post({ pin: config.pin, task: 'rm -rf', text: 'x' })
	const badTaskBody = await badTask.json().catch(() => ({}))
	check('🔴 白名单外的 `task` → 400 并**列出能用哪些** ✗，而且一个字都不许进会话 ✗（静默忽略最坏 ✓）',
		badTask.status === 400 && String(badTaskBody.error).includes('ocr') && String(badTaskBody.error).includes('scan')
		&& STATE.prompts.length === beforeBadTask,
		JSON.stringify(badTaskBody))
	/*
	 * ⚠️ 复查第 91 轮点名的三处漏网 ✗（都补上断言 ✓）：
	 *   ① 白名单查表如果被换成 `in` ✓，`constructor` / `__proto__` 会命中原型链 ✓ → 必须红 ✓；
	 *   ② `task` 带了但**值是空的** ✓ 原来被当成"没带" ✓（202 走 200 + 没有指令，与"名单外→400"矛盾 ✗）；
	 *   ③ **非字符串**（`["ocr"]` ✓）原来被 `String()` 强转成 ocr 收下了 ✓。
	 */
	for (const probe of ['constructor', '__proto__', 'toString', '', '   ', null, ['ocr'], 42, { a: 1 }]) {
		const beforeProbe = STATE.prompts.length
		const res = await post({ pin: config.pin, task: probe, text: 'x' })
		const body = await res.json().catch(() => ({}))
		const label = JSON.stringify(probe)
		check(`🔴 敌意/空 task ${label} → 400 + 列出可选，且**一个字都不进会话** ✗（原型链不算成员 ✓、空值不当"没带" ✓）`,
			res.status === 400 && String(body.error).includes('ocr') && STATE.prompts.length === beforeProbe,
			`HTTP ${res.status} ${JSON.stringify(body).slice(0, 70)}`)
	}
	const scan = await post({ pin: config.pin, task: 'scan', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'code.png' }] })
	const scanBody = await scan.json().catch(() => ({}))
	check('`task:"scan"` 也在白名单里 ✓，而且指令里**如实说"桥自己不做解码"** ✓（解码交给 agent ✓）',
		scan.status === 200 && scanBody.task === 'scan'
		&& String(textOf(STATE.prompts[STATE.prompts.length - 1])).includes('不做解码'),
		JSON.stringify({ http: scan.status, task: scanBody.task }))
	// 图片名统一过 `safeUploadName` ✓（复查点名：原来只有 rescue 那条过 ✓，两条路不一致 ✗）。
	const beforeName = STATE.prompts.length
	await post({ pin: config.pin, images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'evil/../../x\u0000name.png' }] })
	const namedPart = (STATE.prompts[beforeName]?.content ?? []).find((part) => part.type === 'image')
	check('🔴 图片名**统一过 `safeUploadName`** ✓（两条路一致 ✓ —— 路径分隔符 / 控制字符不许原样进 prompt ✗）',
		namedPart !== undefined && String(namedPart.name).includes('/') === false
		&& String(namedPart.name).includes('..') === false && String(namedPart.name).includes('\u0000') === false,
		JSON.stringify(namedPart?.name))
	// task 与"收不下"同时出现：两段信息都要在 ✓（复查点名这条没有用例 ✓）
	const beforeCutTask = STATE.prompts.length
	const cutTask = await post({
		pin: config.pin, task: 'ocr', text: 'y'.repeat(9000),
		images: Array.from({ length: 5 }, (_, index) => ({ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: `t${index}.png` })),
	})
	const cutTaskBody = await cutTask.json().catch(() => ({}))
	check('🔴 `task` 与截断/丢弃**同时出现**时：指令仍在 ✓、`task` 仍回 ✓、截断也照实说 ✓（两段 spread 不打架 ✓）',
		cutTask.status === 200 && cutTaskBody.task === 'ocr' && cutTaskBody.truncated === true
		&& cutTaskBody.dropped?.images === 2
		&& String(textOf(STATE.prompts[beforeCutTask])).includes('【任务：OCR】'),
		JSON.stringify({ task: cutTaskBody.task, truncated: cutTaskBody.truncated, dropped: cutTaskBody.dropped }))
	// task 走 rescue 退路（宿主拒图 → 存文件重发）：重发内容里**指令不许丢** ✗
	const beforeRescueTask = STATE.prompts.length
	const rescueTask = await post({ pin: config.pin, task: 'ocr', images: [{ mediaType: 'image/gif', data: 'R0lGODlhAQABAAAAACw=', name: 'note.gif' }] })
	const rescueTaskBody = await rescueTask.json().catch(() => ({}))
	check('🔴 `task` 走 rescue 退路时**指令不丢** ✓（重发那条里仍有【任务：OCR】✓ —— rescue 只滤掉 image ✓）',
		rescueTask.status === 200 && rescueTaskBody.task === 'ocr'
		&& String(textOf(STATE.prompts[beforeRescueTask + 1])).includes('【任务：OCR】')
		&& typesOf(STATE.prompts[beforeRescueTask + 1]).includes('image') === false,
		JSON.stringify({ task: rescueTaskBody.task, 重发: typesOf(STATE.prompts[beforeRescueTask + 1]) }))

	// 收拾：把弄乱列表的那两条撤掉 ✓（别给后面的用例留状态）
	listItems.splice(listItems.length - noisy.length, noisy.length)

	// ⑧ 手机侧读取面（要 cookie ✓）+ 自检那一行（**开着才出现** ✓ —— 默认关是正常状态，不摆"没开"的红项 ✗）
	const infoAnon = await fetch(`${base}/api/intake`)
	check('读取面：没登录 → 401 ✓', infoAnon.status === 401, String(infoAnon.status))
	const info = await (await fetch(`${base}/api/intake`, mine)).json()
	check('开着时：给出短链（带密钥段 ✓）+ 要 PIN ✓ + 会进哪个会话 ✓ + 怎么配快捷指令 ✓',
		info.enabled === true && String(info.url).endsWith('/api/intake') && String(info.url).includes(config.pathSecret)
		&& info.pinRequired === true && info.sessionId === 'session-test' && String(info.how).includes('快捷指令'),
		JSON.stringify({ enabled: info.enabled, url: String(info.url).split(config.pathSecret).join('<secret>'), session: info.sessionId }))
	check('读取面把**能用的任务**列出来 ✓（3.7.0：ocr / scan ✓ —— 快捷指令那边照抄就行 ✓）',
		Array.isArray(info.tasks) && info.tasks.includes('ocr') && info.tasks.includes('scan')
		&& String(info.how).includes('"task":"ocr"'),
		JSON.stringify({ tasks: info.tasks }))
	const selfOn = await (await fetch(`${base}/api/selfcheck`, mine)).json()
	check('自检里有「分享到桥」并把短链摆出来 ✓（页面不按键也能看见它的地方 ✓ —— 这是架构规矩的落点 ✓）',
		(selfOn.checks ?? []).some((item) => item.name === '分享到桥' && String(item.hint).includes('/api/intake')),
		JSON.stringify((selfOn.checks ?? []).map((item) => item.name)))

	await writeConfig({ shareIntake: false })
	const selfOff = await (await fetch(`${base}/api/selfcheck`, mine)).json()
	const infoOff = await (await fetch(`${base}/api/intake`, mine)).json()
	check('关掉之后：自检里那条**不出现** ✓（默认关是正常状态 ✓，不摆红项 = 不"狼来了" ✗）+ 读取面如实说关着 ✓',
		(selfOff.checks ?? []).some((item) => item.name === '分享到桥') === false
		&& infoOff.enabled === false && infoOff.url === '',
		JSON.stringify({ selfcheck: (selfOff.checks ?? []).map((item) => item.name), enabled: infoOff.enabled }))
}

// 冷启动那个接收器收工 ✓（它在文件头就起着 ✓ —— 进程本来也会退出，这里收干净一点 ✓）。
coldReceiver.close()
// 收尾：把所有代（每个 apply 一代）的 effect 都撤掉 ✓ —— 不只是"最后那一代" ✓。
for (const generation of [...scopesByGeneration.keys()]) { try { disposeGeneration(generation) } catch { /* ignore */ } }
await new Promise((resolve) => setTimeout(resolve, 200))

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
