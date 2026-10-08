/**
 * Client-side check of lib/mobile.html.
 *
 * Loads the real page in jsdom, stubs `fetch`/`EventSource`, then drives the
 * SSE frames the Host would send and asserts what actually lands in the DOM.
 * Catches reducer and rendering regressions that a screenshot cannot.
 *
 *   node test/ui.mjs
 *
 * 需要 jsdom（仅测试依赖，不是插件依赖）：在仓库根目录跑一次 `npm install` 即可。
 * 若本机已有临时安装（`..\_verify`），会自动回退使用，无需额外操作。
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * jsdom 只是这个测试的依赖，**不是插件的运行时依赖**（插件只用 Node 内置模块）。
 *
 * 先按正常方式解析（仓库根目录装了 devDependencies 就能用），再退回开发机上的
 * `..\_verify` 临时安装。两条都不通时给出能照做的提示 —— 之前这里直接抛
 * `Cannot find module 'jsdom'`，陌生人在自己的克隆里只会看到一个没头没尾的崩溃，
 * 而 README 又把这份测试列成"可以直接跑"。
 */
function loadJsdom() {
	const attempts = [
		join(HERE, '..', 'anchor.cjs'),                  // 仓库自身（npm install 之后）
		join(HERE, '..', '..', '_verify', 'anchor.cjs'), // 开发机上的临时安装
	]
	const tried = []
	for (const anchor of attempts) {
		try {
			return createRequire(anchor)('jsdom')
		} catch (error) {
			tried.push(`${anchor}  (${error.code ?? error.message})`)
		}
	}
	console.error('这个测试需要 jsdom（仅测试依赖，不是插件依赖）。先装一次：\n')
	console.error('    npm install\n')
	console.error('尝试过的解析位置：')
	for (const line of tried) console.error(`  - ${line}`)
	process.exit(2)
}

const { JSDOM, VirtualConsole } = loadJsdom()

/** Stand-in for the server-computed page tag; the marker ships once. */
const PAGE_TAG = 'testtag000001'
const html = (await readFile(join(HERE, '..', 'lib', 'mobile.html'), 'utf8'))
	.replace('__DSH_PAGE_TAG__', PAGE_TAG)

/**
 * 页面真实所在的地址：**藏在密钥段后面**。
 *
 * 这个前缀是必须的。页面用的是相对地址（`fetch('api/bootstrap')`），浏览器会把它
 * 解析到当前页面的目录下 —— 只有让 jsdom 的页面地址也带密钥段，mock 才和线上同形。
 * 曾经这里写的是不带密钥的 `http://127.0.0.1:3081/`，而 mock 又按 `startsWith('/api/')`
 * 匹配：相对地址解析出来是 `api/bootstrap`（无前导斜杠），永远匹配不上 → 每个请求都
 * 404 → bootstrap 失败 → 整个测试静默烂掉。相对地址 + 带密钥的基准地址才是对的组合。
 */
const SECRET = '0123456789abcdef'
const SECRET_PREFIX = `/${SECRET}/`
const PAGE_URL = `http://127.0.0.1:3081${SECRET_PREFIX}`

/** jsdom refuses real navigation; that refusal is how we observe a reload. */
const jsdomErrors = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (error) => { jsdomErrors.push(String(error?.message ?? error)) })

const results = []
const check = (name, ok, detail = '') => {
	results.push({ name, ok })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const SESSION = 'session-ui-test'
const SESSIONS = [
	{ sessionId: SESSION, title: '手机界面测试', cwd: 'D:\\learn\\deepseek学习', running: false, blank: false, updatedAt: 2000 },
	{ sessionId: 'session-older', title: '旧会话', cwd: 'D:\\tool', running: false, blank: false, updatedAt: 1000 },
	// 第三个会话专门留给"从没打开过"的场景：缓存测试要验证"没缓存的会话照旧拉整段"，
	// 而任何被切走过的会话都会被记进缓存（这正是那个功能的定义），所以需要一个新的。
	{ sessionId: 'session-fresh', title: '没打开过的会话', cwd: 'D:\\tool', running: false, blank: false, updatedAt: 500 },
]

const requests = []
const opened = []
/** Text handed to the clipboard path, captured from the scratch textarea. */
const copied = []
/** Answer the two confirm() guards; flipped per assertion below. */
const confirms = []
let confirmAnswer = true
let source = null
/** Every EventSource the page ever opened, so a reconnect can be observed. */
const sources = []
/** Flip to make the next /api/prompt answer 403 + needPin (elevation expired). */
let promptNeedsPin = false
/** Flip to make /api/answer report the question as already finished (409). */
let answerExpired = false
/** Records the stub serves for GET /api/transcript (the non-streaming pull). */
let transcriptRecords = []
/** 非 null 时，/api/transcript 先等这个 promise 再回 —— 用来制造"会话已经换了，回包才到"。 */
let transcriptHold = null
/** 专门喂给 session-older 的记录：竞态测试要能分辨"这份是哪个会话的"。 */
let olderTranscriptRecords = []
/** 分片上传收到的片（每片一条），断言"大文件真的被切片了"。 */
const uploaded = []
/** 宿主下发的背景（bootstrap 里带）。设成 null 就模拟"没配背景"。 */
let backdropInfo = { url: 'api/background', mediaType: 'video/quicktime', kind: 'video', bytes: 4096 }
/** /api/prompt 回给手机的 requestId（宿主会把它放进 agent/inbox/spliced）。 */
let lastPromptRequestId = ''
let promptSeq = 0
/** 撤回请求（POST /api/recall）。 */
const recalls = []
/** 宿主侧"这台手机看过说明页"的标记（bootstrap 里下发 / POST /api/welcomed 里写回）。 */
let welcomedOnServer = false
/** 让接下来一次 /api/recall 以指定状态失败（模拟"已经开始处理，撤不回来"的 409）。 */
let recallFailStatus = 0
/** 卡住 /api/boot 的回包：用来验证"本地那份先铺上、不用等下载"。 */
let bootHold = null
/** 记录假的 XHR 报过的 (loaded,total) 组合，验证加载条是按字节走的。 */
const progressReports = []
/** 让接下来 N 次 /api/prompt 在 fetch 层直接失败（模拟隧道抖动 → 页面该自动重试）。 */
let promptFailTimes = 0
/** 每次 /api/prompt 带上的 requestId（断言重试复用它）。 */
const promptIds = []

/**
 * 权限接口的替身。真宿主里权限预设是**按会话**存的（写进会话日志，桌面端看得到），
 * 手机只读一份快照、写一次切换。`elevated` 模拟"令牌还有效、但这台机器要你重新
 * 证明是本人"——就是宿主重启后恢复的手机令牌那个状态。
 */
const permState = {
	preset: 'danger-full-access',
	elevated: true,
	writes: [],
}
const permRequests = []

function jsonResponse(body, status = 200) {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	})
}

/**
 * 像浏览器那样解析请求地址：相对地址以页面地址（含密钥段）为基准。
 * 记录两份 —— `url` 是解析后的完整路径（用来断言"没跑出密钥段"），
 * `path` 是剥掉密钥段之后的路径（用来路由和断言具体接口）。
 */
function resolveRequest(input) {
	const raw = String(input)
	try {
		const resolved = new URL(raw, PAGE_URL)
		return resolved.pathname + resolved.search
	} catch {
		return raw
	}
}

/** bootstrap / boot 共用的那部分（真宿主也是同一个 buildBootstrap）。 */
function bootstrapBody() {
	return {
		sessions: SESSIONS,
		failure: null,
		background: backdropInfo,
		// 宿主记着"这台手机看过说明页"没有（换地址/无痕时本地标记会丢，靠它兜底）。
		welcomed: welcomedOnServer,
		// 真宿主也会发这个：断线时它是同 WiFi 下的兜底出路。
		addresses: [{ address: '192.168.1.20', interface: 'WLAN', label: 'WLAN', url: 'http://192.168.1.20:3081/0123456789abcdef/' }],
		// 和页面当前 origin 不同的正式地址：用来验证「切到当前地址」。
		publicUrl: 'https://example.ts.net/0123456789abcdef/',
	}
}

async function stubFetch(input, options = {}) {
	const full = resolveRequest(input)
	const path = full.startsWith(SECRET_PREFIX) ? `/${full.slice(SECRET_PREFIX.length)}` : full
	requests.push({ url: full, path, options })
	if (path.startsWith('/api/transcript')) {
		// 只卡住【第一次】请求：制造"回包还在路上，用户已经换了会话"这一幕。
		const held = transcriptHold
		transcriptHold = null
		if (held !== null) await held
		return jsonResponse({
			cursor: 9,
			hasMore: false,
			records: path.includes('session-older') ? olderTranscriptRecords : transcriptRecords,
		})
	}
	if (path.startsWith('/api/login')) return jsonResponse({ ok: true })
	if (path.startsWith('/api/permission')) {
		if (options.method === 'POST') {
			const body = JSON.parse(options.body ?? '{}')
			permRequests.push(body)
			// 宿主对"放开"这类改动要求提权；收紧到只读是例外（往安全方向走）。
			if (permState.elevated !== true && body.preset !== 'read-only') {
				return jsonResponse({ error: '改权限需要重新输入 PIN', needPin: true }, 403)
			}
			permState.preset = body.preset
			permState.writes.push(body)
		}
		const labels = { 'read-only': '只读', 'workspace-write': '可写工作区', 'danger-full-access': '完全放开' }
		const details = {
			'read-only': '能看、能读文件，不能改任何东西。看资料、查代码用这档。',
			'workspace-write': '能在项目文件夹里建文件、改文件、跑命令；动到文件夹外面时要问你一次。',
			'danger-full-access': '整台机器都能改、命令不再逐条问你。只在你盯着它干活时用。',
		}
		return jsonResponse({
			current: permState.preset,
			label: labels[permState.preset],
			options: Object.keys(labels).map((value) => ({ value, label: labels[value], detail: details[value] })),
		})
	}
	if (path.startsWith('/api/answer')) {
		if (answerExpired) return jsonResponse({ error: '这条提问已经失效（可能超时，或已在别处回答）' }, 409)
		return jsonResponse({ ok: true })
	}
	if (path.startsWith('/api/boot')) {
		// 卡住回包：验证"本地那份先铺上，不用等下载"（松手由测试控制）。
		if (bootHold !== null) { const held = bootHold; bootHold = null; await held }
		// 打开时的一次性请求：会话列表 + 上次那个会话的对话，一起回来。
		// 真宿主没带 sessionId 时（首装、清了站点数据）transcript 就是 null —— 别在这里
		// 假装给了对话，否则"跳过重复拉取"这条会被一个不存在的场景喂成假的。
		const wanted = /sessionId=([^&]+)/.exec(path)
		if (wanted === null) return jsonResponse({ ...bootstrapBody(), transcript: null })
		const records = wanted[1].includes('session-older') ? olderTranscriptRecords : transcriptRecords
		// 和真宿主一致：带 since=（手机上留着上次那份）时只回"这之后的新记录"并标 partial。
		const since = /[?&]since=(\d+)/.exec(path)
		if (since !== null && Number(since[1]) === 9) {
			return jsonResponse({ ...bootstrapBody(), transcript: { cursor: 9, hasMore: false, records: [], partial: true } })
		}
		return jsonResponse({ ...bootstrapBody(), transcript: { cursor: 9, hasMore: false, records } })
	}
	if (path.startsWith('/api/bootstrap')) return jsonResponse(bootstrapBody())
	if (path.startsWith('/api/welcomed')) {
		welcomedOnServer = true
		return jsonResponse({ ok: true })
	}
	if (path.startsWith('/api/attachment')) return jsonResponse({ mediaType: 'image/png', data: 'iVBORw0KGgo=' })
	if (path.startsWith('/api/upload')) {
		const body = JSON.parse(options.body ?? '{}')
		uploaded.push(body)
		return jsonResponse({
			ok: true,
			done: body.index === body.total - 1,
			name: body.name,
			mediaType: body.mediaType,
			path: 'C:\\Users\\Kim\\.dsh\\mobile-uploads\\test-' + body.name,
		})
	}
	if (path.startsWith('/api/prompt')) {
		// 提权过期：令牌有效，但这台机器要你重新证明是本人（宿主重启后即是此态）。
		if (promptNeedsPin) return jsonResponse({ error: '需要重新输入 PIN 才能执行操作', needPin: true }, 403)
		const body = JSON.parse(options.body ?? '{}')
		promptIds.push(body.requestId)
		// 模拟"隧道抖一下"：fetch 层直接失败（连状态码都没有），页面该自动重试。
		if (promptFailTimes > 0) {
			promptFailTimes -= 1
			return Promise.reject(new TypeError('Load failed'))
		}
		lastPromptRequestId = body.requestId ?? ('req-' + (++promptSeq))
		return jsonResponse({ accepted: true, requestId: lastPromptRequestId })
	}
	if (path.startsWith('/api/recall')) {
		const body = JSON.parse(options.body ?? '{}')
		recalls.push(body)
		if (recallFailStatus !== 0) {
			const status = recallFailStatus
			recallFailStatus = 0
			return jsonResponse({ error: '这条已经开始处理了（已经在跑）' }, status)
		}
		return jsonResponse({ ok: true })
	}
	if (path.startsWith('/api/cancel')) return jsonResponse({ accepted: true })
	if (path.startsWith('/api/logout')) return jsonResponse({ ok: true })
	if (path.startsWith('/api/workspaces')) {
		return jsonResponse({
			workspaces: [
				{ id: 'ws-1', title: 'deepseek学习', path: 'D:\\learn\\deepseek学习' },
				{ id: 'ws-2', title: '皇室', path: 'D:\\tool\\皇室' },
			],
			presets: [{ id: 'default', name: '默认' }, { id: 'video', name: '视频' }],
		})
	}
	if (path.startsWith('/api/session')) return jsonResponse({ sessionId: 'session-created', agentPreset: 'default' })
	if (path.startsWith('/api/balance')) {
		return jsonResponse({
			ok: true,
			isAvailable: true,
			cached: false,
			keySource: 'credentials',
			topUpUrl: 'https://platform.deepseek.com/top_up',
			at: Date.now(),
			balances: [{ currency: 'CNY', total: 12.34, totalText: '12.34', granted: 2, toppedUp: 10.34 }],
		})
	}
	return jsonResponse({ error: 'not found' }, 404)
}

class FakeEventSource {
	constructor(url) {
		this.raw = String(url)
		// 同样按页面地址解析，保留查询串（断言要用到 sessionId）。
		try { this.url = new URL(this.raw, PAGE_URL).href } catch { this.url = this.raw }
		this.readyState = 1
		source = this
		sources.push(this)
	}
	close() { this.readyState = 2 }
	emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

// 先把 /api/boot 卡住（必须在页面启动之前挂上，否则第一发就出去了）：
// 这样才能验证"回包还没到，本地那份已经铺好了"。
let releaseBoot = () => {}
bootHold = new Promise((resolve) => { releaseBoot = resolve })

const dom = new JSDOM(html, {
	url: PAGE_URL,
	runScripts: 'dangerously',
	pretendToBeVisual: true,
	virtualConsole,
	beforeParse(window) {
		window.fetch = stubFetch
		window.EventSource = FakeEventSource
		// 页面启动时用 XHR 拉 /api/boot（要真实的下载进度：XHR 的 progress 与
		// content-length 同口径，fetch 的流是解压后的字节、算不准）。jsdom 没有网络，
		// 这里给一个最小实现：走同一套 stubFetch，并按"整包两次进度"回报。
		window.XMLHttpRequest = class {
			constructor() {
				this.status = 0
				this.responseText = ''
				this.onprogress = null
				this.onload = null
				this.onerror = null
				this.ontimeout = null
			}
			open(method, path) { this.path = String(path) }
			setRequestHeader() {}
			send() {
				stubFetch(this.path, {}).then(async (response) => {
					this.status = response.status
					this.responseText = await response.text()
					if (typeof this.onprogress === 'function') {
						const total = Math.max(1, this.responseText.length)
						progressReports.push([Math.floor(total / 2), total], [total, total])
						this.onprogress({ lengthComputable: true, loaded: Math.floor(total / 2), total })
						this.onprogress({ lengthComputable: true, loaded: total, total })
					}
					if (typeof this.onload === 'function') this.onload()
				}).catch(() => { this.status = 0; if (typeof this.onerror === 'function') this.onerror() })
			}
		}
		// 按"老用户"来：手机本地记着上次那个会话。真手机每次进来都是这个状态，
		// 而首装那趟（没有这个标记）另有一条用例专门查。
		try { window.localStorage.setItem('dshm.session', SESSION) } catch { /* jsdom 里不该失败，失败就按首装算 */ }
		// 而且手机上还留着上次那份对话（切到别的 App 再点回来就是这个状态）：
		// 页面应该**先把这份铺上**，再去后台补新的 —— 不用等整段重新下载。
		try {
			window.localStorage.setItem('dshm.transcript.' + SESSION, JSON.stringify({
				sessionId: SESSION,
				cursor: 9,
				at: Date.now(),
				items: [
					{ kind: 'user', content: [{ type: 'text', text: '上次留着的那句话' }] },
					{ kind: 'assistant', content: [{ type: 'text', text: '上次留着的那句回答' }], reasoning: '', cursor: false, reasoningOpen: false },
				],
			}))
		} catch { /* 同上 */ }
		// jsdom 不会解码图片：给一个假 bitmap，让"转格式"那条路能走到画布那一步
		// （没有 canvas 包时 getContext 返回 null，于是页面按设计退回"当文件发"）。
		window.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
		// jsdom does not implement window.open; the top-up button needs it.
		window.open = (url) => { opened.push(String(url)); return null }
		window.confirm = (message) => { confirms.push(String(message)); return confirmAnswer }
		// jsdom has no clipboard; the page's legacy path must be what gets used
		// over plain http anyway.
		window.document.execCommand = (command) => {
			if (command !== 'copy') return false
			const area = window.document.querySelector('textarea[readonly]')
			copied.push(area ? area.value : '')
			return true
		}
	},
})

const { window } = dom
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const $ = (id) => window.document.getElementById(id)
const textOf = (id) => $(id).textContent.trim()

/* --- 从别的窗口点回来：先铺上本地那份，不等下载 ---------------------------- */
/*
 * 现场：切到别的 App 再点回来，页面又被系统回收重开一次，于是又是加载页 + 重下整段
 * 对话。现在手机上留着一份现场（IndexedDB，写不进去就退到 localStorage），
 * 回来先把这份铺好，再去后台补新的那几条。
 *
 * 同时这也是加载条的用例：进度要**按真实字节走**、而且一直在动（不是卡在一个数上）。
 */
{
	await wait(90)
	const boot = window.__dshBoot()
	check('加载页报得出真实进度（不是死的一格）',
		boot !== undefined && boot.target > 0 && boot.shown > 0, JSON.stringify(boot))
	check('恢复本地那份之后进度会往前走并说明在同步',
		boot.target >= 22 && /恢复|同步|连电脑/.test(boot.label), JSON.stringify(boot))
	check('本地那份已经铺进对话区（还没等到电脑回包）',
		$('log').textContent.includes('上次留着的那句话'), $('log').textContent.trim().slice(0, 40))
	check('但界面还没显示出来（能不能看要等鉴权，别让捡到手机的人直接读到）',
		window.getComputedStyle($('app')).display === 'none', window.getComputedStyle($('app')).display)

	// 放行 /api/boot：带上 since=9 → 宿主只回"没有新记录"的增量，历史必须留着
	releaseBoot()
	await wait(220)
	const after = window.__dshBoot()
	check('回包到位后进度到 100（并且是按字节报的）',
		after.target === 100 || progressReports.length > 0, JSON.stringify({ after, reports: progressReports.length }))
	check('增量回包不会把本地那份历史冲掉',
		$('log').textContent.includes('上次留着的那句话') && $('log').textContent.includes('上次留着的那句回答'),
		$('log').textContent.trim().slice(0, 50))
}

await wait(150)

check('bootstrap shows the app and hides the PIN gate',
	window.getComputedStyle($('app')).display !== 'none' && window.getComputedStyle($('gate')).display === 'none',
	`app=${window.getComputedStyle($('app')).display} gate=${window.getComputedStyle($('gate')).display}`)
check('session picker is populated', $('session').options.length === 3, `${$('session').options.length} options`)
check('the most recent session is selected and streamed',
	$('session').value === SESSION && source !== null && source.url.includes(SESSION),
	`value=${$('session').value} url=${source?.url}`)
// 第一次连上就把说明页弹出来（后面还有一整段专门查它的内容和"只看一次"）。
// 这一条必须放在【任何提问/审批帧之前】：真有卡片进来时说明页要让位（见后文）。
check('说明页在第一次连上后自动弹出',
	$('welcome') !== null && window.getComputedStyle($('welcome')).display !== 'none',
	$('welcome') === null ? 'no #welcome' : `display=${$('welcome').style.display}`)

/* --- 每个请求都必须落在密钥段之内 ---------------------------------------- */

// 页面藏在随机密钥段后面；只要有一处退回绝对路径，线上就是 404。
// mock 按浏览器语义解析相对地址，所以这里断言的正是线上会发生的事 ——
// 这也正是当初让整个测试静默烂掉的那个漂移。
const escaped = requests.filter((entry) => !entry.url.startsWith(SECRET_PREFIX))
check('所有 fetch 都落在密钥段之内', escaped.length === 0,
	escaped.length === 0 ? `${requests.length} 个请求` : escaped.map((e) => e.url).join(', '))
check('EventSource 也在密钥段之内',
	source !== null && source.url.includes(SECRET_PREFIX), source?.url)

/* --- 开机只跑一个来回 ---------------------------------------------------- */
/*
 * 现场：进 App 要等两次往返（列表 + 对话）。隧道慢时一个来回好几秒，加起来就是
 * 用户看到的"进去太慢"。现在合并成 /api/boot 一次拿齐 —— 而且开了长连接之后
 * 不许再顺手补一次 /api/transcript，那等于把省下来的那个来回又还回去。
 */
{
	const bootCalls = requests.filter((entry) => entry.path.startsWith('/api/boot')).length
	const transcriptCalls = requests.filter((entry) => entry.path.startsWith('/api/transcript')).length
	const bootPath = requests.find((entry) => entry.path.startsWith('/api/boot'))?.path ?? ''
	check('开机只请求 /api/boot 一次（不再先 bootstrap 再 transcript）',
		bootCalls === 1, `${bootCalls}× boot`)
	check('boot 带上本地记住的会话（否则拿回来的不是用户上次看的那个）',
		bootPath.includes(`sessionId=${SESSION}`), bootPath)
	check('/api/boot 已经带回对话 → 开长连接时不再重复拉一次 transcript',
		transcriptCalls === 0, `${transcriptCalls}× transcript`)

	// 但"跳过"必须认【哪一个会话】，不能只认"刚才拉过"。boot 带回的是上次记住的那个
	// 会话，而 loadSessions 可能选中另一个（记住的被删了/不在列表里）—— 那时如果不拉，
	// 画面上就留着别的会话的对话，标题却是新的。
	const switchBefore = requests.filter((entry) => entry.path.startsWith('/api/transcript')).length
	$('session').value = 'session-older'
	$('session').dispatchEvent(new window.Event('change'))
	await wait(120)
	const switchAfter = requests.filter((entry) => entry.path.startsWith('/api/transcript')).length
	check('刚开机就换会话时，照样去拉新会话的对话（跳过只对同一个会话生效）',
		switchAfter === switchBefore + 1, `${switchBefore} -> ${switchAfter}`)

	// 换回来，后面的用例接着在原来的会话上跑。
	$('session').value = SESSION
	$('session').dispatchEvent(new window.Event('change'))
	await wait(120)
}

/* --- durable history arrives as a snapshot ------------------------------- */

source.emit({
	t: 'snapshot',
	cursor: 4,
	hasMore: false,
	records: [
		{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '帮我看下这张图' }, { type: 'image', attachment: { attachmentId: 'att-9', mediaType: 'image/png', bytes: 10, width: 4, height: 4 } }] } } },
		{ type: 'event', event: { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '这是鲸鱼' }] } } } },
		{ type: 'event', event: { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 2, callId: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' } } },
		{ type: 'event', event: { type: 'tool/result', seq: 4, time: 4, data: { turn: 1, step: 2, message: { id: 'm3', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '文件内容 ABC' }] }] } } } },
	],
})
await wait(120)

const body = $('log').textContent
check('user text renders', body.includes('帮我看下这张图'))
check('assistant text renders', body.includes('这是鲸鱼'))
check('tool call renders with its result merged',
	body.includes('read') && body.includes('文件内容 ABC'), body.replace(/\s+/g, ' ').slice(0, 90))
// 附件现在直接给真 URL（api/media），不再取 base64 拼 data: —— iOS 对 data: 图片的
// 长按菜单里没有"存储到照片"，用户就没法把素材存进相册。
{
	const img = window.document.querySelector('#log img')
	const src = img === null ? '' : img.getAttribute('src')
	check('历史图片走真 URL（能长按存相册，不是 data:）',
		img !== null && src.startsWith('api/media?') && src.includes('attachmentId=att-9')
		&& img.getAttribute('data-full') === src,
		src)
	check('附件不再走 base64 的 /api/attachment',
		requests.filter((entry) => entry.path.startsWith('/api/attachment')).length === 0,
		`${requests.filter((entry) => entry.path.startsWith('/api/attachment')).length} attachment fetches`)
}
check('history image element is present', window.document.querySelectorAll('#log img').length === 1)

/* --- agent 在电脑上产出的素材：路径要变成能看、能存的图 ------------------- */
/*
 * 现场：agent 在电脑上做了图/视频，对话里只有一行绝对路径 —— 手机上什么都看不到，
 * 更别说存进相册。页面现在把这种路径渲染成真图（api/file），点开全屏、长按可存。
 */
{
	source.emit({
		t: 'event',
		event: {
			type: 'assistant/message', seq: 40, time: 40,
			data: {
				turn: 4, step: 1,
				message: {
					id: 'm40', role: 'assistant',
					content: [{ type: 'text', text: '素材做好了：D:\\learn\\deepseek学习\\out\\封面.png 和 D:\\learn\\deepseek学习\\out\\成片.mp4' }],
				},
			},
		},
	})
	await wait(140)
	const shots = [...window.document.querySelectorAll('#log img.shot')]
		.filter((node) => String(node.getAttribute('src')).startsWith('api/file?path='))
	const videos = window.document.querySelectorAll('#log video.shot')
	check('回复里的图片路径变成了真图（api/file，能长按存相册）',
		shots.length === 1 && String(shots[0].getAttribute('src')).includes(encodeURIComponent('封面.png')),
		`${shots.length} 图 / src=${shots[0]?.getAttribute('src')}`)
	check('视频路径变成可播放的视频条', videos.length === 1, `${videos.length} video`)
	check('图片下面告诉用户怎么存进相册',
		window.document.querySelector('#log .shothint') !== null
		&& window.document.querySelector('#log').textContent.includes('存储到照片'))

	// 点图 → 全屏看图（真 URL，长按就是"存储到照片"）
	shots[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	const viewer = $('viewer')
	check('点图打开全屏看图（长按可存）',
		viewer !== null && viewer.classList.contains('on')
		&& viewer.querySelector('img') !== null
		&& String(viewer.querySelector('img').getAttribute('src')).startsWith('api/file?path='),
		viewer === null ? 'no #viewer' : viewer.querySelector('img')?.getAttribute('src'))
	$('viewerClose').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
	check('关闭按钮收起看图层', $('viewer').classList.contains('on') === false)
}

/* --- 桌面端那块「交付物」也要出现在手机上 --------------------------------- */
/*
 * agent 交付素材时发的是 `deliverables/presented` 事件，页面以前完全忽略它 ——
 * 而"电脑给的素材"往往就是这里列的文件（封面图、数据图、文案 md）。
 */
{
	source.emit({
		t: 'event',
		event: {
			type: 'deliverables/presented', seq: 41, time: 41,
			data: {
				turn: 4, callId: 'c41',
				files: [
					{ description: '封面：成都绕城绿道 104.2 公里', path: 'D:\\自媒体\\图片\\第4篇-1-封面.png' },
					{ description: '文案草稿', path: 'D:\\自媒体\\第4篇-发布素材.md' },
				],
			},
		},
	})
	await wait(150)
	const box = window.document.querySelector('#log .deliver')
	check('交付物事件会渲染成一块「素材」区（以前整条被丢掉）', box !== null, box === null ? '没有 .deliver' : 'ok')
	check('交付物里的图片给缩略图（能点开、能长按存相册）',
		box !== null && box.querySelector('img.shot') !== null
		&& String(box.querySelector('img.shot').getAttribute('src')).startsWith('api/file?path='),
		box?.querySelector('img.shot')?.getAttribute('src'))
	check('交付物里的文字文件也给一行说明（至少知道电脑上有什么）',
		box !== null && box.textContent.includes('发布素材.md') && box.textContent.includes('文案草稿'),
		box?.textContent?.trim().slice(0, 60))
}

/* --- live streaming ------------------------------------------------------ */

source.emit({ t: 'event', event: { type: 'turn/start', seq: 5, time: 5, data: { turn: 2 } } })
source.emit({ t: 'delta', frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 2, step: 1, startedAfterSeq: 4 } })
source.emit({ t: 'delta', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 6, chunk: { type: 'text-delta', index: 0, text: '正在' } } })
source.emit({ t: 'delta', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 7, chunk: { type: 'text-delta', index: 0, text: '处理' } } })
await wait(120)

check('live deltas accumulate in a streaming bubble', $('log').textContent.includes('正在处理'))
// 运行中【不能】把发送键藏掉：后端本来就是 queue 模式，插话会被排进当前回合。
// 以前这里只留「停止」，用户在 agent 跑的时候想补一句，只能干等它结束。
check('a running turn shows BOTH stop and 插话 (interject)',
	window.getComputedStyle($('stop')).display !== 'none'
	&& window.getComputedStyle($('send')).display !== 'none'
	&& $('send').textContent === '插话',
	`stop=${window.getComputedStyle($('stop')).display} send=${window.getComputedStyle($('send')).display} label=${$('send').textContent}`)
check('运行中两个键会收窄，窄屏上不至于把输入框挤没',
	$('compose').classList.contains('two'))

// 插话走的就是普通发送 → 后端 queue 模式。这里确认键是活的、请求发得出去。
const beforeInterject = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
$('text').value = '顺便再看下这个'
$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(90)
check('运行中点「插话」会把消息发出去（排队进当前回合）',
	requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === beforeInterject + 1,
	`${beforeInterject} -> ${requests.filter((entry) => entry.path.startsWith('/api/prompt')).length}`)
// 插话进的是队列，对话里不会马上出现。必须给一句确认，否则用户看到的是"发了没反应"。
check('插话后明确回一句"已插话"（不是静默收下）',
	$('banner').textContent.includes('已插话'), $('banner').textContent)

source.emit({ t: 'event', event: { type: 'assistant/message', seq: 6, time: 8, data: { turn: 2, step: 1, message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: '正在处理完成' }] } } } })
source.emit({ t: 'event', event: { type: 'turn/end', seq: 7, time: 9, data: { turn: 2, reason: { kind: 'completed' } } } })
await wait(120)

check('the finalized message replaces the streaming bubble',
	$('log').textContent.includes('正在处理完成') && !$('log').textContent.includes('正在处理\n'))
check('turn end restores the send button', window.getComputedStyle($('send')).display !== 'none')

/* --- composing and sending ---------------------------------------------- */

const input = $('text')
input.value = '帮我把这张图转成文字'
$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(80)

// 上面「插话」也是一次 /api/prompt，所以这里必须取最后一次，不能取第一次。
const promptCall = requests.filter((entry) => entry.path.startsWith('/api/prompt')).pop()
const promptBody = promptCall ? JSON.parse(promptCall.options.body) : null
check('send posts the session, text and images',
	promptBody?.sessionId === SESSION && promptBody?.text === '帮我把这张图转成文字' && Array.isArray(promptBody?.images),
	JSON.stringify(promptBody))
check('the composer is cleared after sending', input.value === '')

// Ctrl/Cmd+Enter 走的是另一条路（直接调 send），只靠按钮 disabled 挡不住连按两下 ——
// 同一个 prompt 会发两次，两次都是要花钱的一轮。
{
	const before = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	input.value = '连按两下只许发一次'
	const keydown = () => $('text').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
	keydown()
	keydown()
	await wait(120)
	const after = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	check('Ctrl+Enter 连按两下不会把同一句话发两遍', after === before + 1, `${before} -> ${after}`)
	input.value = ''
}

/* --- attaching a photo from the phone ------------------------------------ */

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const file = new window.File([png], 'photo.png', { type: 'image/png' })
Object.defineProperty($('file'), 'files', { value: [file], configurable: true })
$('file').dispatchEvent(new window.Event('change', { bubbles: true }))
await wait(120)

check('a picked photo is previewed before sending', $('thumbs').querySelectorAll('img').length === 1)

$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(80)
const lastPrompt = requests.filter((entry) => entry.path.startsWith('/api/prompt')).pop()
const imageBody = JSON.parse(lastPrompt.options.body)
check('the picked photo is sent as base64 with its media type',
	imageBody.images.length === 1 && imageBody.images[0].mediaType === 'image/png' && imageBody.images[0].data.length > 20,
	`mediaType=${imageBody.images[0]?.mediaType} dataLen=${imageBody.images[0]?.data?.length}`)
check('the preview is cleared after sending', $('thumbs').querySelectorAll('img').length === 0)

/* --- 动图 / 视频 / 别的图片格式：一个都不许静默丢掉 ---------------------- */
/*
 * 现场：用户在手机上发动图，点了半天只有"发送失败"。宿主只认 png/jpeg/webp/gif，
 * 别的格式（HEIC/BMP…）在手机上先转成 PNG；转不了的、以及视频，走 files 那条路 ——
 * 电脑把它们存成文件、把路径写进任务，agent 照样能用。
 */
{
	const pick = (f) => {
		Object.defineProperty($('file'), 'files', { value: [f], configurable: true })
		$('file').dispatchEvent(new window.Event('change', { bubbles: true }))
	}

	// 1) GIF：宿主认，就直接当图片发
	pick(new window.File([new Uint8Array([71, 73, 70, 56, 57, 97])], 'funny.gif', { type: 'image/gif' }))
	await wait(140)
	check('动图（GIF）当图片预览，不会被丢掉', $('thumbs').querySelectorAll('img').length === 1,
		`${$('thumbs').querySelectorAll('img').length} img / ${$('thumbs').querySelectorAll('.chip').length} chip`)

	// 2) 视频：变成一张待发卡片
	pick(new window.File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], 'clip.mp4', { type: 'video/mp4' }))
	await wait(160)
	check('视频变成一张待发卡片（不是静默丢弃）',
		$('thumbs').querySelectorAll('.chip').length === 1
		&& $('thumbs').textContent.includes('clip.mp4'),
		$('thumbs').textContent.trim().slice(0, 40))

	const before = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	uploaded.length = 0
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(200)
	const sentBody = JSON.parse(requests.filter((entry) => entry.path.startsWith('/api/prompt')).pop().options.body)
	check('视频先分片上传，再只把路径放进任务（大包必被隧道掐断）',
		requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === before + 1
		&& uploaded.length >= 1 && uploaded[0].total === 1
		&& uploaded[0].name === 'clip.mp4'
		&& sentBody.fileRefs?.length === 1 && sentBody.fileRefs[0].path.includes('mobile-uploads')
		&& sentBody.images.length === 1,
		JSON.stringify({ 片: uploaded.length, refs: sentBody.fileRefs, images: sentBody.images?.length }))
	check('分片上传的片名带上了 uploadId 与序号（服务端要靠它拼回去）',
		uploaded[0].uploadId !== undefined && uploaded[0].index === 0,
		JSON.stringify({ id: uploaded[0]?.uploadId, index: uploaded[0]?.index, total: uploaded[0]?.total }))
	check('发完清空：图片和文件卡片都不留下',
		$('thumbs').querySelectorAll('img').length === 0 && $('thumbs').querySelectorAll('.chip').length === 0)

	// 3) 宿主不认的图片格式：先试着在手机上演成 PNG；转不了就退回"当文件发"
	pick(new window.File([new Uint8Array([66, 77, 1, 2, 3])], 'shot.bmp', { type: 'image/bmp' }))
	await wait(200)
	const fallbackChip = $('thumbs').querySelectorAll('.chip').length === 1
	check('转不了的图片格式会退回"当文件发"，而不是消失', fallbackChip, $('thumbs').textContent.trim().slice(0, 40))
	// 清干净，别影响后面的检查
	$('thumbs').querySelector('button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
	check('卡片上的 × 能把它拿掉', $('thumbs').querySelectorAll('.chip').length === 0)
}

/* --- 「文件」键：任意文件（PDF / 文档 / 压缩包）原样传到电脑 ----------------- */
/*
 * 现场：手机上只能挑照片和视频（选择器写着 accept="image/*,video/*"），
 * 想发一个 PDF 或压缩包**根本没有入口**。后端那条路其实早就通了
 * （分片上传 → 电脑存盘 → 路径写进任务），缺的只是一个不限制类型的选择器。
 */
{
	const fire = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	let opened = 0
	const anyInput = $('fileAny')
	const realClick = anyInput.click.bind(anyInput)
	anyInput.click = () => { opened += 1 }
	fire($('pickAny'))
	check('点「文件」开的是不限制类型的选择器（不写 accept 才选得到 PDF/文档）',
		opened === 1 && (anyInput.getAttribute('accept') ?? '') === '',
		`opened=${opened} accept=${anyInput.getAttribute('accept')}`)
	anyInput.click = realClick

	const pickAny = (list) => {
		Object.defineProperty(anyInput, 'files', { value: list, configurable: true })
		anyInput.dispatchEvent(new window.Event('change', { bubbles: true }))
	}

	pickAny([new window.File([new Uint8Array([37, 80, 68, 70])], 'report.pdf', { type: 'application/pdf' })])
	await wait(180)
	check('PDF 变成一张待发卡片（既不丢弃，也不当成图片预览）',
		$('thumbs').querySelectorAll('.chip').length === 1
		&& $('thumbs').textContent.includes('report.pdf')
		&& $('thumbs').querySelectorAll('img').length === 0,
		`chips=${$('thumbs').querySelectorAll('.chip').length} imgs=${$('thumbs').querySelectorAll('img').length}`)

	uploaded.length = 0
	const promptsBefore = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	fire($('send'))
	await wait(260)
	const fileBody = JSON.parse(requests.filter((entry) => entry.path.startsWith('/api/prompt')).pop().options.body)
	check('文件先分片上传，任务里只放路径（requests 里没有大包）',
		requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === promptsBefore + 1
		&& uploaded.length === 1 && uploaded[0].name === 'report.pdf'
		&& fileBody.fileRefs?.length === 1 && fileBody.fileRefs[0].path.includes('mobile-uploads')
		&& (fileBody.images ?? []).length === 0,
		JSON.stringify({ 片: uploaded.length, refs: fileBody.fileRefs, images: fileBody.images?.length }))
	check('文件发完也清空', $('thumbs').querySelectorAll('.chip').length === 0)

	// 宿主一次只收 3 个（fileRefs = slice(0,3)）：第 4 个必须在手机上就被拦下并说明白 ——
	// 让它默默消失，就是用户最怕的"我明明发了"。
	pickAny([1, 2, 3, 4].map((n) => new window.File([new Uint8Array([110 + n])], `f${n}.txt`, { type: 'text/plain' })))
	await wait(360)
	check('一次最多 3 个文件：第 4 个被拦下，而且说清原因（不是静默丢掉）',
		$('thumbs').querySelectorAll('.chip').length === 3
		&& $('banner').textContent.includes('最多 3 个'),
		`chips=${$('thumbs').querySelectorAll('.chip').length} banner=${$('banner').textContent.slice(0, 50)}`)

	for (let i = 0; i < 3; i += 1) {
		$('thumbs').querySelector('button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(40)
	}
	check('清空后没有残留附件', $('thumbs').querySelectorAll('.chip').length === 0)
}

/* --- cancel -------------------------------------------------------------- */

$('stop').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(60)
const cancelCall = requests.find((entry) => entry.path.startsWith('/api/cancel'))
check('stop cancels the running session',
	cancelCall !== undefined && JSON.parse(cancelCall.options.body).sessionId === SESSION)

/* --- the new-task panel -------------------------------------------------- */

const sheet = $('view-new')
const tabButton = (name) => window.document.querySelector(`#tabs button[data-tab="${name}"]`)
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

check('three tabs are rendered', window.document.querySelectorAll('#tabs button').length === 3)
check('the panel starts closed', window.getComputedStyle(sheet).display === 'none')

click(tabButton('new'))
await wait(180)

check('新建 opens a panel over the current view, not in place of it',
	window.getComputedStyle(sheet).display !== 'none' && window.getComputedStyle($('view-task')).display !== 'none',
	`sheet=${window.getComputedStyle(sheet).display} task=${window.getComputedStyle($('view-task')).display}`)
check('the tab bar never marks 新建 as active', tabButton('new').classList.contains('active') === false)
check('the panel carries its own title', sheet.querySelector('.sheetbar .title').textContent === '新建任务')
check('the header is left alone', $('heading').textContent === '会话', $('heading').textContent)
check('workspaces render as picks', window.document.querySelectorAll('#workspaces .pick').length === 2)
check('the first workspace starts selected', window.document.querySelectorAll('#workspaces .pick.on').length === 1)
check('presets populate the picker', $('preset').options.length === 3, `${$('preset').options.length} options`)

click(window.document.querySelectorAll('#workspaces .pick')[1])
await wait(40)
check('tapping a workspace moves the selection',
	window.document.querySelectorAll('#workspaces .pick')[1].classList.contains('on'))

// 取消 is the exit the screen was missing; it must also protect a draft.
$('cwd').value = 'D:\\tmp\\draft'
confirms.length = 0
confirmAnswer = false
click($('newBack'))
await wait(40)
check('返回 asks before discarding a typed draft',
	confirms.length === 1 && window.getComputedStyle(sheet).display !== 'none',
	`confirms=${confirms.length} sheet=${window.getComputedStyle(sheet).display}`)
confirmAnswer = true
click($('newBack'))
await wait(40)
check('返回 closes the panel once confirmed', window.getComputedStyle(sheet).display === 'none')
check('返回 clears the draft', $('cwd').value === '')

// A stray tap on the primary action must not silently start a billable turn.
click(tabButton('new'))
await wait(150)
click(window.document.querySelectorAll('#workspaces .pick')[1])
await wait(30)
$('firstText').value = '先看看这个目录'
confirms.length = 0
confirmAnswer = false
click($('createBtn'))
await wait(80)
check('creating with a first message asks before running it',
	confirms.length === 1 && requests.filter((entry) => entry.path.startsWith('/api/session')).length === 0,
	`confirms=${confirms.length}`)

confirmAnswer = true
click($('createBtn'))
await wait(300)

const createCall = requests.find((entry) => entry.path.startsWith('/api/session'))
check('create posts the chosen workspace',
	createCall !== undefined && JSON.parse(createCall.options.body).workspaceId === 'ws-2',
	createCall ? createCall.options.body : 'no call')
const createdPrompts = requests.filter((entry) => entry.path.startsWith('/api/prompt'))
check('the first message goes to the new session',
	JSON.parse(createdPrompts[createdPrompts.length - 1].options.body).sessionId === 'session-created')
check('create closes the panel and lands on the task tab',
	window.getComputedStyle(sheet).display === 'none' && window.getComputedStyle($('view-task')).display !== 'none')
check('the first-message box is cleared', $('firstText').value === '')

/* --- balance screen ------------------------------------------------------ */

click(tabButton('bill'))
await wait(220)

const bill = $('billBody').textContent
check('余额 loads without pressing refresh', bill.includes('12.34'), bill.slice(0, 60))
check('granted and topped-up splits render', bill.includes('2.00') && bill.includes('10.34'))
check('the account state renders', bill.includes('可用'))

click($('billTopUp'))
check('去充值 opens the official page', opened[0] === 'https://platform.deepseek.com/top_up', opened[0])

click(tabButton('task'))
await wait(60)
check('switching back restores the conversation',
	window.getComputedStyle($('view-task')).display !== 'none' && $('log').textContent.includes('这是鲸鱼'))

/* --- thinking split, expandable state, and copy -------------------------- */

const REASONING = '先想清楚再动手，第一句话要短。'
const ANSWER = '这是分开之后渲染的回答。'

source.emit({
	t: 'snapshot', tag: PAGE_TAG, cursor: 10, hasMore: false,
	records: [
		{ type: 'event', event: { type: 'assistant/message', seq: 8, time: 1, data: { turn: 1, step: 1, message: { id: 'm9', role: 'assistant', content: [{ type: 'reasoning', text: REASONING }, { type: 'text', text: ANSWER }] } } } },
		{ type: 'event', event: { type: 'tool/call', seq: 9, time: 2, data: { turn: 1, step: 2, callId: 'c9', name: 'read', arguments: '{}' } } },
		{ type: 'event', event: { type: 'tool/result', seq: 10, time: 3, data: { turn: 1, step: 2, message: { id: 'm10', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'TOOL_OUTPUT_LINE' }] }] } } } },
	],
})
await wait(160)

const think = $('log').querySelector('details.think')
const answerBubble = Array.from($('log').querySelectorAll('.bubble')).find((node) => node.textContent.includes(ANSWER))
check('thinking renders as its own region, outside the answer bubble',
	think !== null && think.textContent.includes(REASONING) && answerBubble !== undefined && !answerBubble.textContent.includes(REASONING),
	think === null ? 'no details element' : 'ok')
check('thinking is collapsed by default once the message is finished', think?.open === false)
check('the answer still renders in its own bubble', answerBubble !== undefined)

// Both expansions are rebuilt from state on every frame, so they must be
// written back into state or they snap shut mid-stream.
think.open = true
think.dispatchEvent(new window.Event('toggle'))
await wait(40)
source.emit({ t: 'delta', frame: { type: 'chunk', attemptId: 'a2', revision: 2, index: 0, time: 4, chunk: { type: 'text-delta', index: 0, text: '追加' } } })
await wait(110)
check('an opened thinking block survives a re-render', $('log').querySelector('details.think')?.open === true)

click($('log').querySelector('.tool'))
await wait(40)
source.emit({ t: 'delta', frame: { type: 'chunk', attemptId: 'a2', revision: 2, index: 0, time: 5, chunk: { type: 'text-delta', index: 0, text: '再追加' } } })
await wait(110)
check('an expanded tool block survives a re-render',
	$('log').querySelector('.tool')?.classList.contains('open') === true)

// The bug this section exists for: text-delta used to overwrite the whole
// content array, so thinking vanished the moment the answer began.
source.emit({ t: 'delta', frame: { type: 'start', attemptId: 'a3', revision: 3, turn: 2, step: 1, startedAfterSeq: 10 } })
source.emit({ t: 'delta', frame: { type: 'chunk', attemptId: 'a3', revision: 3, index: 0, time: 6, chunk: { type: 'reasoning-delta', index: 0, text: 'STREAM_THINK' } } })
source.emit({ t: 'delta', frame: { type: 'chunk', attemptId: 'a3', revision: 3, index: 1, time: 7, chunk: { type: 'text-delta', index: 0, text: 'STREAM_ANSWER' } } })
await wait(140)
const streaming = $('log').textContent
check('thinking survives after the answer starts streaming',
	streaming.includes('STREAM_THINK') && streaming.includes('STREAM_ANSWER'))

// A live selection must freeze the transcript, or copying while it streams is
// impossible: every frame would drop the selection.
const target = Array.from($('log').querySelectorAll('.bubble')).find((node) => node.textContent.includes(ANSWER))
const range = window.document.createRange()
range.selectNodeContents(target)
const selection = window.getSelection()
selection.removeAllRanges()
selection.addRange(range)
const frozen = $('log').innerHTML
source.emit({ t: 'delta', frame: { type: 'chunk', attemptId: 'a3', revision: 3, index: 2, time: 8, chunk: { type: 'text-delta', index: 0, text: 'FROZEN' } } })
await wait(160)
check('a live text selection freezes the transcript', $('log').innerHTML === frozen)
selection.removeAllRanges()
await wait(320)
check('the transcript catches up once the selection is released', $('log').innerHTML !== frozen)

// Long-press is the copy gesture; a plain tap must not copy.
// Re-query: the render above replaced every node in the transcript.
const liveBubble = () => Array.from($('log').querySelectorAll('.bubble')).find((node) => node.textContent.includes(ANSWER))

copied.length = 0
liveBubble().dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }))
await wait(700)
liveBubble().dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }))
check('long-press copies the block text', copied.length === 1 && copied[0].includes(ANSWER), `${copied.length} copy call(s): ${JSON.stringify(copied[0] ?? '')}`)
check('the copy is confirmed with a toast',
	$('toast').classList.contains('on') && $('toast').textContent.includes('已复制'), $('toast').textContent)

copied.length = 0
liveBubble().dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }))
liveBubble().dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }))
await wait(700)
check('a quick tap does not trigger a copy', copied.length === 0)

/* --- 看得见的「复制」按钮 ------------------------------------------------- */
/*
 * 长按能复制，但那是**藏在手势里的**（没人会去猜）。所以每条气泡外侧再放一个
 * 可见的「复制」。它必须留在 .bubble **外面**：长按复制取的是 .bubble 的
 * innerText，按钮塞进气泡就会被一起复制出一句"复制"。
 */
source.emit({
	t: 'event',
	event: { type: 'user/message', seq: 11, time: 9, data: { id: 'u11', role: 'user', content: [{ type: 'text', text: 'USER_COPY_ME' }] } },
})
await wait(160)

const buttonIn = (needle) => Array.from($('log').querySelectorAll('button[data-copy]'))
	.find((node) => (node.closest('.row')?.textContent ?? '').includes(needle))

const userCopy = buttonIn('USER_COPY_ME')
const answerCopy = buttonIn(ANSWER)
check('每条对话（自己和 agent 的）外侧都有一个看得见的「复制」',
	userCopy !== undefined && answerCopy !== undefined && userCopy.textContent === '复制',
	`user=${userCopy !== undefined} assistant=${answerCopy !== undefined}`)
check('「复制」按钮在气泡外面（长按取值不会把"复制"两个字带上）',
	userCopy.closest('.bubble') === null && answerCopy.closest('.bubble') === null)

copied.length = 0
click(userCopy)
await wait(40)
check('点「复制」复制的是这条消息的正文',
	copied.length === 1 && copied[0].includes('USER_COPY_ME'), `${copied.length} call(s): ${JSON.stringify(copied[0] ?? '')}`)
check('复制后有提示（不然用户不知道成没成）',
	$('toast').classList.contains('on') && $('toast').textContent.includes('已复制'), $('toast').textContent)

copied.length = 0
click(answerCopy)
await wait(40)
check('agent 气泡复制到的是回答正文（不含思考过程）',
	copied.length === 1 && copied[0].includes(ANSWER) && !copied[0].includes(REASONING),
	`${copied.length} call(s): ${JSON.stringify(copied[0] ?? '')}`)

/* --- 提权过期：服务器要 PIN，页面必须真的把输入框给出来 ------------------- */
/*
 * 宿主重启后恢复的会话是【有效但不提权】的：聊天记录照常读，一动手就被
 * guardWrite 拒掉（403 + needPin）。页面曾经只认 401，于是屏幕上只闪一句
 * "需要重新输入 PIN"，而 PIN 输入框根本不在 —— 用户只能靠点「退出」绕回门口，
 * 看起来就是"一会儿要 PIN、一会儿又跳回会话界面"。
 */

promptNeedsPin = true
input.value = '这条应该被拒一次'
click($('send'))
await wait(180)

check('403 + needPin 会把 PIN 门打开（否则用户无处输入）',
	window.getComputedStyle($('gate')).display !== 'none' && window.getComputedStyle($('app')).display === 'none',
	`gate=${window.getComputedStyle($('gate')).display} app=${window.getComputedStyle($('app')).display}`)
check('PIN 门带着可读的说明', $('gateError').textContent.includes('PIN'), $('gateError').textContent)
check('被拒之后草稿没丢（别把用户输入弄没）', input.value === '这条应该被拒一次', input.value)

// 重新登录还必须把 SSE 重新接上：sessionId 没变，旧的 connect() 判定会跳过重连，
// 结果是页面看着一切正常，却再也收不到任何实时更新。
promptNeedsPin = false
const streamsBefore = sources.length
$('pin').value = '123456'
click($('gateBtn'))
await wait(300)

check('重新输入 PIN 后回到会话界面',
	window.getComputedStyle($('gate')).display === 'none' && window.getComputedStyle($('app')).display !== 'none',
	`gate=${window.getComputedStyle($('gate')).display} app=${window.getComputedStyle($('app')).display}`)
check('重新登录后 SSE 重新连上（否则页面静默不再更新）',
	sources.length === streamsBefore + 1, `${streamsBefore} -> ${sources.length}`)

/* --- 手机上回答提问 / 批准操作 ------------------------------------------- */
/*
 * 宿主把 agent 的提问和工具审批推到这条流上。手机上必须能直接答，否则用户只能
 * 干看着 agent 停在那里，或者被迫跑回电脑前面点。
 */

// 问题文本来自模型 —— 必须当【文本】渲染，绝不能当 HTML 解析。
const XSS = '<img src=x onerror="window.__pwned=1">'
source.emit({
	t: 'interaction',
	kind: 'question',
	id: 'ask-1',
	payload: {
		questions: [
			{ id: 'q1', header: '方案', question: '用哪个？' + XSS, options: [{ label: '甲', description: '快' }, { label: '乙' }] },
			{ id: 'q2', question: '还有什么要补充？' },
		],
	},
})
await wait(90)

const askBox = $('ask')
check('提问卡片出现在输入框上方', window.getComputedStyle(askBox).display !== 'none')
check('问题文本渲染出来了', askBox.textContent.includes('用哪个？'))
check('选项渲染成按钮', askBox.querySelectorAll('.opt').length === 2)
check('模型给的 HTML 只当文本，不当标记（防 XSS）',
	askBox.querySelectorAll('img').length === 0 && window.__pwned === undefined,
	`imgs=${askBox.querySelectorAll('img').length}`)

const answerCalls = () => requests.filter((entry) => entry.path.startsWith('/api/answer'))

// 第一个问题没答就不许提交，并且要说清差哪个。
click(askBox.querySelector('.row .go'))
await wait(70)
check('没答完不让提交，并说明还差哪个问题',
	answerCalls().length === 0 && askBox.textContent.includes('还有问题没答'))

// 选第二个选项 + 给【第二题】填自定义文字，再提交。
click(askBox.querySelectorAll('.opt')[1])
const customInputs = askBox.querySelectorAll('.custom')
check('每题都有自己的自定义输入框', customInputs.length === 2, `${customInputs.length}`)
customInputs[1].value = '补充一句'
customInputs[1].dispatchEvent(new window.Event('input', { bubbles: true }))
click(askBox.querySelector('.row .go'))
await wait(140)

const answerCall = answerCalls().pop()
const answerBody = answerCall ? JSON.parse(answerCall.options.body) : null
check('提交后发出 POST api/answer', answerCall !== undefined)
check('答案编码与桌面端一致（单选且填了自定义时 selected 让位给 custom）',
	answerBody?.answers?.[0]?.selected?.[0] === '乙' && answerBody?.answers?.[1]?.custom === '补充一句',
	JSON.stringify(answerBody))
check('答完卡片自动消失', window.getComputedStyle($('ask')).display === 'none')

// 审批卡片：两个按钮，点了就把 outcome 交出去。
source.emit({ t: 'interaction', kind: 'approval', id: 'ask-2', payload: { toolName: 'pwsh', reason: '要删文件' } })
await wait(90)
check('审批卡片说明是哪个工具、为什么',
	$('ask').textContent.includes('pwsh') && $('ask').textContent.includes('要删文件'))
const denyButton = Array.from($('ask').querySelectorAll('.row button')).find((node) => node.textContent.includes('拒绝'))
denyButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(140)
check('「拒绝」提交 rejected',
	JSON.parse(answerCalls().pop()?.options?.body ?? '{}').outcome === 'rejected',
	answerCalls().pop()?.options?.body)

// interaction-end：超时、或已经被别的手机答了，卡片要撤掉。
source.emit({ t: 'interaction', kind: 'approval', id: 'ask-3', payload: { toolName: 'read' } })
await wait(70)
check('第三张卡片出现', window.getComputedStyle($('ask')).display !== 'none')
source.emit({ t: 'interaction-end', id: 'ask-3' })
await wait(70)
check('interaction-end 撤掉卡片（超时或别人先答了）', window.getComputedStyle($('ask')).display === 'none')

// 卡片必须挂在 main【外面】。放进 #view-task 里的话，用户切到「余额」就完全看不到
// 提问 —— 而 agent 正在那儿等，只能干等到超时回到桌面。
check('提问卡片不在 #view-task 里面（切页签也看得见）',
	$('ask').closest('#view-task') === null && $('ask').parentElement?.id === 'app',
	$('ask').parentElement?.id)

// 重推同一个 id 必须保住草稿：重连、多开一条流，宿主都会重推；直接覆盖会把勾选清光。
const QA = { questions: [{ id: 'q1', question: '再问一次', options: [{ label: '甲' }, { label: '乙' }] }] }
source.emit({ t: 'interaction', kind: 'question', id: 'ask-4', payload: QA })
await wait(80)
click($('ask').querySelectorAll('.opt')[0])
await wait(40)
check('单选点击后选项高亮', $('ask').querySelectorAll('.opt')[0].classList.contains('on'))
source.emit({ t: 'interaction', kind: 'question', id: 'ask-4', payload: QA })
await wait(80)
check('同一个 id 重推后勾选还在（草稿没被清掉）',
	$('ask').querySelectorAll('.opt')[0].classList.contains('on'))

// 单选下填自定义文字要清掉已选：服务端编码就是 custom 非空时丢弃 selected，
// 界面不跟上就会"看着选中了，提交的却是另一回事"。
const box4 = $('ask')
const custom4 = box4.querySelector('.custom')
custom4.value = '我自己写'
custom4.dispatchEvent(new window.Event('input', { bubbles: true }))
await wait(50)
check('单选下填自定义会清掉已选（与官方语义一致）', box4.querySelectorAll('.opt.on').length === 0)

// 反过来：点了选项要把自定义文字撤掉，否则 custom 非空让服务端丢掉 selected，
// 用户会以为"点了没用"。
click(box4.querySelectorAll('.opt')[1])
await wait(50)
check('单选下点选项会撤回自定义文字',
	box4.querySelector('.custom').value === '' && box4.querySelectorAll('.opt.on').length === 1)
source.emit({ t: 'interaction-end', id: 'ask-4' })
await wait(60)

// 提问在服务端已经结束（超时 / 已在别处回答）→ 卡片必须撤掉。
// 不撤的话它会永远赖在屏幕上，用户点一次报一次错，还不知道该干什么。
source.emit({ t: 'interaction', kind: 'approval', id: 'ask-6', payload: { toolName: 'read' } })
await wait(80)
answerExpired = true
click($('ask').querySelector('.row button'))
await wait(160)
check('提问已结束时撤掉卡片，而不是永远报错',
	window.getComputedStyle($('ask')).display === 'none')
answerExpired = false

/* --- 断线必须【说出来】，不能只把一个 9px 的圆点变红 --------------------- */
/*
 * 以前就是 `source.onerror = () => setStatus('down')`：用户看到"不动了"，
 * 却分不清是电脑睡了、隧道换了新网址、还是自己断网，只能自己刷新撞运气。
 */
const linkText = () => ($('linkbar')?.textContent ?? '')
check('提示条存在且默认收起',
	$('linkbar') !== null && window.getComputedStyle($('linkbar')).display === 'none')
check('提示条不在 #view-task 里（切页签也看得见）', $('linkbar')?.closest('#view-task') === null)

source.onerror?.()
await wait(90)
check('断线时弹出提示条（不再只有一个变色的圆点）',
	$('linkbar') !== null && window.getComputedStyle($('linkbar')).display !== 'none')
check('提示条说清可能的原因', linkText().includes('电脑睡眠') || linkText().includes('隧道'))
check('提示条给出局域网兜底地址（同一 WiFi 下不依赖隧道）',
	linkText().includes('192.168.1.20') && linkText().includes('改用局域网地址'))
check('提示条告诉用户去电脑上跑体检脚本', linkText().includes('tunnel-status.ps1'))
// 停在一条已经失效的旧地址上时（页面还能显示、但所有请求都失败），唯一能自救的
// 出路就是切到宿主当前地址 —— 这正是"打开就是一片空白"的那个场景。
check('停在失效旧地址上时给出「切到当前地址」',
	linkText().includes('切到当前地址') && linkText().includes('example.ts.net'),
	linkText().slice(0, 80))

// 收到心跳就说明对面还在，提示条自己收起。
source.emit({ t: 'ping' })
await wait(70)
check('收到宿主心跳后提示条自动收起',
	$('linkbar') !== null && window.getComputedStyle($('linkbar')).display === 'none')

/* --- 打不开的会话（agent 的子会话）不能说成"断线" ------------------------- */
/*
 * 真事故：手机上默认选中的那个会话是 agent 自己派生的子会话，宿主回
 * "subagent Sessions require their durable parent address"。页面把这条当普通断线
 * 处理 —— 弹"和电脑断开了 / 你正在用的地址已经失效"，把用户引去换地址，而
 * 浏览器还会每三秒自动重连一次，连一整晚。
 */
$('session').value = 'session-older'
$('session').dispatchEvent(new window.Event('change', { bubbles: true }))
await wait(140)
check('切到另一个会话会重开一条流', source !== null && source.url.includes('session-older'))

// 会话在不在跑必须跟着会话走：以前 state.running 只由流事件写，换会话后不会重置，
// 于是切到一条闲着的会话，按钮还写着「插话」、停止键还亮着，发一条普通消息还会
// 回一句假的"已插话"。
source.emit({ t: 'event', event: { type: 'turn/start', seq: 90, time: Date.now(), data: { turn: 3 } } })
await wait(80)
check('（前置）运行中按钮是「插话」', $('send').textContent === '插话', $('send').textContent)
$('session').value = SESSION
$('session').dispatchEvent(new window.Event('change', { bubbles: true }))
await wait(120)
check('切到没在跑的会话后按钮回到「发送」、停止键收起',
	$('send').textContent === '发送' && window.getComputedStyle($('stop')).display === 'none',
	`label=${$('send').textContent} stop=${window.getComputedStyle($('stop')).display}`)
$('session').value = 'session-older'
$('session').dispatchEvent(new window.Event('change', { bubbles: true }))
await wait(140)

source.emit({ t: 'error', unsupported: true, message: 'subagent Sessions require their durable parent address' })
await wait(140)
check('子会话报错时讲的是"这个会话打不开"，不是"你的地址已失效"',
	linkText().includes('子会话') && !linkText().includes('地址已经失效'), linkText().slice(0, 90))
check('子会话报错也不谎报"和电脑断开了"', !linkText().includes('断开了'), linkText().slice(0, 60))
check('子会话报错后主动关掉那条流（浏览器才不会每三秒自动重连一整晚）',
	source.readyState === 2, `readyState=${source.readyState}`)
check('会话区域给出下一步（换一个会话），而不是"正在读取…"',
	$('log').textContent.includes('换一个会话'), $('log').textContent.trim().slice(0, 60))

// 再切回它一次：不许重新开流。
const streamsBeforeRetry = sources.length
$('session').value = SESSION
$('session').dispatchEvent(new window.Event('change', { bubbles: true }))
await wait(120)
$('session').value = 'session-older'
$('session').dispatchEvent(new window.Event('change', { bubbles: true }))
await wait(150)
check('已经判过"打不开"的会话不会再被重连（每次都失败，白烧流量）',
	sources.length === streamsBeforeRetry + 1, `${streamsBeforeRetry} -> ${sources.length}`)

// 回到正常会话：后面还有一半检查要靠它。
$('session').value = SESSION
$('session').dispatchEvent(new window.Event('change', { bubbles: true }))
await wait(140)
source.emit({ t: 'ping' })
await wait(80)
check('换回正常会话后提示条收起',
	window.getComputedStyle($('linkbar')).display === 'none', linkText().slice(0, 60))

/* --- 迟到的旧回包不许贴到新会话上 ---------------------------------------- */
/*
 * 场景：请求 A 的回包还在路上，用户已经切到了 B。以前回包一到就无条件贴上去，
 * 于是 B 的标题下面挂着 A 的对话，后面的事件还全接在错的对话上，自己永远好不了。
 */
{
	olderTranscriptRecords = [{
		type: 'event',
		event: { type: 'user/message', seq: 91, time: Date.now(), data: { id: 'late', role: 'user', content: [{ type: 'text', text: '迟到的是 session-older 的内容' }] } },
	}]
	let release = null
	transcriptHold = new Promise((resolve) => { release = resolve })
	$('session').value = 'session-older'
	$('session').dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(60)                                  // 这一条 transcript 被卡在路上
	$('session').value = SESSION
	$('session').dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(60)
	release()                                       // 旧回包现在才到
	await wait(160)
	check('迟到的旧会话回包不会贴到新会话上（否则标题和内容对不上）',
		!$('log').textContent.includes('迟到的是 session-older 的内容'), $('log').textContent.trim().slice(0, 60))
	olderTranscriptRecords = []
	transcriptHold = null
}

/* --- 插话发出去以后要看得见、能撤回 -------------------------------------- */
/*
 * 现场：手机上插话发出去之后**什么都看不到** —— 排队的内容要等这一轮跑完才进对话，
 * 中间那段空白让人以为没发出去。现在先在本地显示出来（虚线边 + 状态），并给撤回按钮。
 */
{
	const text = $('text')
	// 这套测试前面已经发过好几条（插话、Ctrl+Enter、照片、视频），它们也会留下回声；
	// 这里只认自己刚发的那条，别被前面的条数影响。
	const mine = (needle) => [...window.document.querySelectorAll('#log .bubble.pending')]
		.filter((node) => node.textContent.includes(needle))
	text.value = '这是刚插的话'
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(140)

	let bubbles = mine('这是刚插的话')
	check('发出去之后立刻能在对话里看到自己发了什么（不再是空白）',
		bubbles.length === 1 && bubbles[0].textContent.includes('这是刚插的话'),
		`${bubbles.length} 条回声 / ${bubbles[0]?.textContent?.trim().slice(0, 30)}`)
	check('回声上写着状态（排队中 / 已发出）',
		/排队中|已发出/.test(bubbles[0]?.textContent ?? ''), bubbles[0]?.textContent?.trim().slice(0, 40))
	check('回声带撤回按钮', bubbles[0]?.querySelector('[data-recall]') !== null)

	// 宿主把排队内容推过来：靠 rpcId 认出"这条就是手机上刚发的"
	source.emit({
		t: 'event',
		event: {
			type: 'agent/inbox/spliced', seq: 71, time: 71,
			data: { target: 'next-turn', start: 0, inserted: [{ id: 'queue-1', role: 'user', source: { kind: 'user', rpcId: lastPromptRequestId }, content: [{ type: 'text', text: '这是刚插的话' }] }] },
		},
	})
	await wait(120)
	bubbles = mine('这是刚插的话')
	check('对上排队条目后状态变成"排队中"',
		/排队中/.test(bubbles[0]?.textContent ?? ''), bubbles[0]?.textContent?.trim().slice(0, 40))

	recalls.length = 0
	bubbles[0].querySelector('[data-recall]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(160)
	check('点撤回 → 真的按队列表项 id 去撤（POST /api/recall）',
		recalls.length === 1 && recalls[0].itemId === 'queue-1' && recalls[0].sessionId === SESSION,
		JSON.stringify(recalls[0]))
	check('撤回成功后那条回声消失', mine('这是刚插的话').length === 0, `${mine('这是刚插的话').length} 条`)

	// 不撤回、让真消息进来：回声也要自己让位（否则同一句话显示两遍）
	text.value = '这句会真的发出去'
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(140)
	check('（前置）又出现一条回声', mine('这句会真的发出去').length === 1)
	source.emit({
		t: 'event',
		event: { type: 'user/message', seq: 72, time: 72, data: { id: 'm72', role: 'user', content: [{ type: 'text', text: '这句会真的发出去' }] } },
	})
	await wait(140)
	check('真消息进对话后回声自动撤掉（不会显示两遍）',
		mine('这句会真的发出去').length === 0 && $('log').textContent.includes('这句会真的发出去'),
		`${mine('这句会真的发出去').length} 条回声`)
}

/* --- 电脑上的插话也要看得见；插话要能"改一下再发" -------------------------- */
/*
 * 现场两件事：
 *   1. 电脑上插的话，手机上完全看不到 —— 要等这一轮跑完、真消息进了对话才冒出来，
 *      用户以为"电脑上插的话没生效"；
 *   2. 手机上插话发出去之后发现要改，只能撤回再重打一遍。
 * 现在：别人发的排队项也画出来（标清来源），每条排队中的插话都给「修改」——
 * 原文放回输入框，先撤回再放回去（顺序不能反，否则改完一发就是两条）。
 */
{
	const composer = $('text')
	const pendingBubbles = () => [...window.document.querySelectorAll('#log .bubble.pending')]
	const findBubble = (needle) => pendingBubbles().find((node) => node.textContent.includes(needle))

	// 1) 电脑插的一句：手机上从没见过这条，宿主直接推了 inbox/spliced
	source.emit({
		t: 'event',
		event: {
			type: 'agent/inbox/spliced', seq: 80, time: 80,
			data: {
				target: 'next-turn', start: 0,
				inserted: [{ id: 'queue-desktop', role: 'user', source: { kind: 'user', rpcId: 'rpc-desktop-1' }, content: [{ type: 'text', text: '电脑上插的一句话' }] }],
			},
		},
	})
	await wait(140)
	const desktopBubble = findBubble('电脑上插的一句话')
	check('电脑上的插话手机上也能看到（不再等这一轮跑完才出现）',
		desktopBubble !== undefined, `${pendingBubbles().length} 条回声`)
	check('并且标清了来源（不然用户会以为是自己什么时候发过）',
		(desktopBubble?.textContent ?? '').includes('电脑/别处发来的'),
		desktopBubble?.textContent?.trim().slice(0, 46))
	check('电脑发来的那条一样能改、能撤',
		desktopBubble?.querySelector('[data-edit]') !== null && desktopBubble?.querySelector('[data-recall]') !== null)

	recalls.length = 0
	composer.value = ''
	desktopBubble.querySelector('[data-edit]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(180)
	check('点「修改」：原文被放回输入框（不必再打一遍）',
		composer.value === '电脑上插的一句话', JSON.stringify(composer.value))
	check('点「修改」：先把排队项撤回来（否则改完一发就重复一条）',
		recalls.length === 1 && recalls[0].itemId === 'queue-desktop', JSON.stringify(recalls[0]))
	check('撤回成功后那条回声消失（改完发出去就是唯一的一条）',
		findBubble('电脑上插的一句话') === undefined)

	// 2) 撤不回来（已经开始处理）时：文字照样放回去，但必须明说再发会多一条
	source.emit({
		t: 'event',
		event: {
			type: 'agent/inbox/spliced', seq: 81, time: 81,
			data: {
				target: 'next-turn', start: 0,
				inserted: [{ id: 'queue-late', role: 'user', source: { kind: 'user', rpcId: 'rpc-late-1' }, content: [{ type: 'text', text: '已经开始跑的那句' }] }],
			},
		},
	})
	await wait(140)
	const lateBubble = findBubble('已经开始跑的那句')
	check('（前置）又出现一条可改的回声', lateBubble !== undefined)
	recallFailStatus = 409
	composer.value = ''
	lateBubble.querySelector('[data-edit]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(200)
	check('撤不回来时原文照样放回输入框', composer.value === '已经开始跑的那句', JSON.stringify(composer.value))
	check('并且如实说明"再发会多出一条"（不能让人以为撤回成功了）',
		(findBubble('已经开始跑的那句')?.textContent ?? '').includes('再发会多出一条'),
		findBubble('已经开始跑的那句')?.textContent?.trim().slice(-40))
	check('这条不再显示可点的撤回/修改（点了也没用）',
		findBubble('已经开始跑的那句')?.querySelector('[data-edit]') === null)

	// 3) 同一条 splice 事件被重放（重连/快照重放）不许画出两条一样的
	const beforeReplay = pendingBubbles().filter((node) => node.textContent.includes('已经开始跑的那句')).length
	source.emit({
		t: 'event',
		event: {
			type: 'agent/inbox/spliced', seq: 82, time: 82,
			data: {
				target: 'next-turn', start: 0,
				inserted: [{ id: 'queue-late', role: 'user', source: { kind: 'user', rpcId: 'rpc-late-1' }, content: [{ type: 'text', text: '已经开始跑的那句' }] }],
			},
		},
	})
	await wait(120)
	check('同一条排队项被重放时不会画出两条（重连后最常见）',
		pendingBubbles().filter((node) => node.textContent.includes('已经开始跑的那句')).length === beforeReplay,
		`${beforeReplay} -> ${pendingBubbles().filter((node) => node.textContent.includes('已经开始跑的那句')).length}`)

	// 收尾：把这条回声清掉，别影响后面的用例
	const dismiss = findBubble('已经开始跑的那句')?.querySelector('[data-dismiss]')
	if (dismiss !== null && dismiss !== undefined) dismiss.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	composer.value = ''
	await wait(80)
}

/* --- 初始对话不能只靠长连接 ---------------------------------------------- */
/*
 * 真事故：有些通道会把大响应缓冲住 —— 手机打开页面一片空白，**直到电脑那边发了
 * 一条新消息**，那 200 多 KB 的快照才跟着被冲出来。普通请求不踩这个坑
 * （bootstrap 一直都能通），所以页面必须能用它把对话拉回来。
 */
transcriptRecords = [{
	type: 'event',
	event: { type: 'user/message', seq: 99, time: Date.now(), data: { id: 't1', role: 'user', content: [{ type: 'text', text: '这条是普通请求拉回来的' }] } },
}]
click($('reload'))
await wait(260)
check('「刷新」用普通请求把对话拉回来（不依赖长连接能不能推流）',
	$('log').textContent.includes('这条是普通请求拉回来的'),
	`transcript 请求 ${requests.filter((e) => e.path.startsWith('/api/transcript')).length} 次; log="${$('log').textContent.trim().slice(0, 30)}"`)
transcriptRecords = []

/* --- 空会话不能是一片全白 ------------------------------------------------ */
/*
 * render() 以前在没内容时就是 log.innerHTML = '' —— 一个字都不说。而页面记着上次
 * 选的会话，若它恰好是空的，用户就会"每次打开都空白"，只能以为坏了。
 */
source.emit({ t: 'snapshot', tag: PAGE_TAG, cursor: 30, hasMore: false, records: [] })
await wait(180)
check('空会话会给出说明，而不是一片全白',
	$('log').textContent.trim().length > 0, `"${$('log').textContent.trim().slice(0, 46)}"`)
check('说明指向了下拉框或读取状态',
	/下拉框|读取/.test($('log').textContent), $('log').textContent.trim().slice(0, 40))

/* --- 首次进入的「开始使用」说明页 ---------------------------------------- */
{
	// 开机那一下已经查过"自动弹出"（见文件开头）；这里查内容、收起，以及"只看一次"。
	check('说明页讲清了四件能做的事',
		$('welcome').textContent.includes('下达任务')
		&& $('welcome').textContent.includes('看实时进度')
		&& $('welcome').textContent.includes('批准操作')
		&& $('welcome').textContent.includes('插话'),
		$('welcome').textContent.replace(/\s+/g, ' ').slice(0, 60))
	check('说明页提醒了添加到主屏幕', $('welcome').textContent.includes('添加到主屏幕'))

	click($('welcomeGo'))
	await wait(60)
	check('点「开始使用」就收起，并记住不再弹第二次',
		window.getComputedStyle($('welcome')).display === 'none'
		&& window.localStorage.getItem('dshm.welcomed') === '1',
		`display=${$('welcome').style.display} flag=${window.localStorage.getItem('dshm.welcomed')}`)
	// 光记在手机本地不够：换地址（Funnel ↔ 局域网是不同 origin）、无痕浏览、清站点数据
	// 都会把本地标记弄丢 —— 那正是"每次退出重进都弹一遍"的原因。所以要告诉宿主一份。
	check('同时把"看过了"写到宿主那边（换地址/无痕也不会重复弹）',
		welcomedOnServer === true
		&& requests.some((entry) => entry.path.startsWith('/api/welcomed')),
		`server=${welcomedOnServer}`)

	// 第二次连上不该再弹。localStorage 被清掉（无痕模式）这种极端情况，也要靠内存里的
	// 标记兜住 —— 否则同一台手机上每次重连都弹一遍，比没有说明页还烦。
	window.localStorage.removeItem('dshm.welcomed')
	click($('logout'))
	await wait(220)
	$('pin').value = '123456'
	click($('gateBtn'))
	await wait(320)
	check('同一次打开里不会再弹第二次（无痕模式也不反复打扰）',
		window.getComputedStyle($('welcome')).display === 'none',
		`display=${$('welcome').style.display}`)
	check('退出再登录后照样回到会话界面',
		window.getComputedStyle($('app')).display !== 'none',
		`app=${window.getComputedStyle($('app')).display}`)

	// 真有提问/审批时说明页必须让位：卡片是流内元素，会被全屏的说明页挡在后面，
	// 而说明页里恰好写着"需要你拍板时会弹出卡片"。
	$('welcome').style.display = 'flex'          // 把说明页摆回屏幕上（前面已经点掉过）
	source.emit({ t: 'interaction', id: 'q-welcome', kind: 'question', payload: { questions: [{ id: 'q1', header: '确认', question: '要不要继续？', options: [] }] } })
	await wait(120)
	check('提问进来时说明页自动让位（否则卡片被挡着，用户什么都看不到）',
		window.getComputedStyle($('welcome')).display === 'none',
		`display=${$('welcome').style.display}`)
	source.emit({ t: 'interaction-end', id: 'q-welcome' })
	await wait(80)
}

/* --- 无痕模式：localStorage 会【抛异常】，页面不许因此死掉 --------------- */
/*
 * iOS Safari 无痕下 getItem 照常、setItem 抛 QuotaExceededError。以前那句 setItem
 * 就夹在 `state.sessionId = chosen` 和 `connect()` 之间：一抛，流不开、对话不拉，
 * 屏幕全白，而用户看着一切正常（还登录着）。当时 5 个套件全绿 —— 编辑器里的
 * localStorage 不会抛。
 */
{
	const storage = window.localStorage
	const proto = Object.getPrototypeOf(storage)
	const realSet = proto.setItem
	proto.setItem = () => { throw new window.Error('QuotaExceededError') }
	const streamsBefore = sources.length
	const pullsBefore = requests.filter((entry) => entry.path.startsWith('/api/transcript')).length
	click($('logout'))
	await wait(240)
	$('pin').value = '123456'
	click($('gateBtn'))
	await wait(340)
	check('无痕模式下（写不进去）重新登录照样连上流',
		sources.length === streamsBefore + 1, `${streamsBefore} -> ${sources.length}`)
	// 这条以前断言"必须再拉一次 /api/transcript"。现在切走又切回会先铺上本地那份现场
	// （见会话缓存），长连接带着 since= 只补新记录 —— 少一个来回，但屏幕上必须有内容。
	const pullsAfter = requests.filter((entry) => entry.path.startsWith('/api/transcript')).length
	check('无痕模式下重新登录后对话还在（不是一片空白）',
		$('log').textContent.trim().length > 20,
		`transcript ${pullsBefore} -> ${pullsAfter}，画面 ${$('log').textContent.trim().length} 字符`)
	proto.setItem = realSet
}

/* --- 自定义背景：宿主给了就铺，没给就一点痕迹都不留 ---------------------- */
/*
 * 用户把自己手机上传的一段 .mov 设成界面背景。iOS 上视频要自动播，muted /
 * playsinline / autoplay 三个都得在；格式手机不认时必须整层撤掉 —— 背景是装饰，
 * 不能因为它让界面用不了。
 */
{
	check('宿主给了背景也不会一上来就铺（视频还在加载时那是一整块黑）',
		window.document.body.classList.contains('hasbg') === false, window.document.body.className)
	const video = $('backdrop').querySelector('video')
	check('背景是 <video> 且 muted + loop + playsinline（少一个 iOS 就不播）',
		video !== null && video.muted === true && video.loop === true
		&& (video.hasAttribute('playsinline') || video.playsInline === true),
		video === null ? 'no video' : `muted=${video.muted} loop=${video.loop} playsinline=${video.hasAttribute('playsinline')}`)
	check('背景地址走密钥段内的相对路径', video !== null && video.getAttribute('src') === 'api/background',
		video?.getAttribute('src'))
	// 真的开始播 → 这时候才铺（顺序反了就是给用户一个黑屏）
	video.dispatchEvent(new window.Event('playing'))
	await wait(60)
	check('开始播放后才铺满整屏（body 上打 hasbg）',
		window.document.body.classList.contains('hasbg'), window.document.body.className)

	// 换回"没配背景"：整层要收干净
	backdropInfo = null
	click($('reload'))
	await wait(220)
	check('没配背景时整层撤掉（页面回到原样，不留黑底）',
		window.document.body.classList.contains('hasbg') === false
		&& $('backdrop').querySelectorAll('video, img').length === 0,
		`class=${window.document.body.className} nodes=${$('backdrop').querySelectorAll('video, img').length}`)
	backdropInfo = { url: 'api/background', mediaType: 'video/quicktime', kind: 'video', bytes: 4096 }
	click($('reload'))
	await wait(220)
	const again = $('backdrop').querySelector('video')
	again?.dispatchEvent(new window.Event('playing'))
	await wait(60)
	check('再配回来也照样生效（同样要等它真的播起来）',
		window.document.body.classList.contains('hasbg') && again !== null,
		window.document.body.className)
}

/* --- 加载页 / 原图模式 / 发送自动重试 ------------------------------------ */
{
	// 加载页的 HTML 必须一渲染就有（等 JS 起来再画就晚了）。
	check('页面自带加载页（HTML 一渲染就显示）',
		html.includes('id="boot"') && html.includes('id="bootFill"'))
	check('加载页按真实进度推进完就收起',
		$('boot') === null || $('boot').classList.contains('done'),
		$('boot') === null ? '已移除' : $('boot').className)

	// 原图模式：不压缩、不转格式，直接当文件原样传（发背景那种要画质的图）
	const rawToggle = $('rawToggle')
	check('有个「原图」开关', rawToggle !== null)
	rawToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
	check('打开后按钮亮起', rawToggle.classList.contains('on'))

	const bigPng = new window.File([new Uint8Array(4096).fill(7)], 'cover.png', { type: 'image/png' })
	Object.defineProperty($('file'), 'files', { value: [bigPng], configurable: true })
	$('file').dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(180)
	check('原图模式下图片变成"原文件"卡片（不再走压缩那条路）',
		$('thumbs').querySelectorAll('.chip').length === 1 && $('thumbs').querySelectorAll('img').length === 0,
		$('thumbs').textContent.trim().slice(0, 30))

	uploaded.length = 0
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(260)
	check('原图模式下按原字节分片上传（电脑拿到的就是原图）',
		uploaded.length >= 1 && uploaded[0].name === 'cover.png'
		&& uploaded[0].mediaType === 'image/png',
		JSON.stringify({ 片: uploaded.length, 名: uploaded[0]?.name }))

	// 关掉原图模式，别影响后面的检查；顺便验证自动重试：
	// 第一次网络层失败（fetch 直接抛）→ 自动再试一次 → 成功，而且 requestId 复用。
	rawToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
	check('再点一下关掉原图模式', rawToggle.classList.contains('on') === false)

	promptFailTimes = 1
	promptIds.length = 0
	$('text').value = '自动重试一次也要发出去'
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(2200)
	check('网络抖一下（第一次直接失败）会自动重试并成功',
		promptIds.length === 2, `${promptIds.length} 次尝试`)
	check('重试用的是同一个 requestId（宿主幂等，不会变成两条）',
		promptIds.length === 2 && promptIds[0] === promptIds[1], promptIds.join(' / '))
	promptFailTimes = 0
}

/* --- 手机上"拖一下又弹回原处、看不到消息" ---------------------------------- */
/*
 * 现场：界面像被钉在一处，拖动后自己弹回去，历史消息根本翻不动。
 * 根因两条，都是渲染策略造成的（跟网络、桥、隧道无关）：
 *   1. 每帧 `log.innerHTML = …` 整段重排 → 滚动位置每次都被重置，手指拖多少抹多少；
 *   2. content-visibility 对还没渲染过的行只能用 contain-intrinsic-size 估算高度，
 *      scrollHeight 因此是说谎的：滚到那儿行高突然变大，视口内容被顶回去。
 * 现在：增量渲染（只动真正变化的那一条）+ 拖动期间冻结渲染 + 按"离底部多远"锚定。
 */
{
	const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '')
	const rule = /([^{}]*)\{[^{}]*content-visibility[^{}]*\}/.exec(css)
	// 治本的选择：**一处都不用**。content-visibility 会让没渲染过的块按估算高度参与
	// scrollHeight，"往上滚进历史时位置被顶回去"就是它造成的；而按 key 复用节点之后，
	// 它那点性能收益也不成立（真浏览器实测：去掉它流式期间最长掉帧反而从 108ms 降到 61ms）。
	check('页面里不用 content-visibility（估算高度 = 说谎的 scrollHeight）',
		rule === null, rule === null ? '（没有这条声明）' : rule[0].slice(0, 60))
}

{
	const log = $('log')
	// jsdom 不做排版，把"高度"喂进去才能测滚动锚定：高度按子节点数算，好预测。
	// 高度按"子节点数 + 文字长度"算：这样"内容变长"在测试里也能反映到 scrollHeight 上。
	const heightOf = () => 200 * log.children.length + log.textContent.length
	Object.defineProperty(log, 'scrollHeight', { configurable: true, get: heightOf })
	Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 400 })
	// 派发一次 scroll，让页面按真实语义更新 state.stick（jsdom 里改 scrollTop 不会自己触发）。
	const noteScrolled = () => log.dispatchEvent(new window.Event('scroll'))

	// 1) 往上翻着看历史时来了新消息：老节点必须原样留着，滚动位置不能被抢。
	//    先摆一个"已经有内容"的会话：一片空白时第一条消息属于结构变化（keep=0），
	//    本来就会走整段重排，测不出增量。
	source.emit({
		t: 'snapshot',
		cursor: 900,
		hasMore: false,
		records: [
			{ type: 'event', event: { type: 'user/message', seq: 901, time: 901, data: { id: 's1', role: 'user', content: [{ type: 'text', text: '增量渲染的底子一' }] } } },
			{ type: 'event', event: { type: 'assistant/message', seq: 902, time: 902, data: { turn: 91, step: 1, message: { id: 's2', role: 'assistant', content: [{ type: 'text', text: '增量渲染的底子二' }] } } } },
			{ type: 'event', event: { type: 'tool/call', seq: 903, time: 903, data: { turn: 91, step: 2, callId: 'sc1', name: 'read', arguments: '{"file_path":"a.txt"}' } } },
		],
	})
	await wait(140)
	const nodesBefore = [...log.children]
	check('对话区里已经有内容可测', nodesBefore.length > 0, String(nodesBefore.length))
	log.scrollTop = 300
	noteScrolled()
	source.emit({
		t: 'event',
		event: { type: 'user/message', seq: 190, time: 190, data: { id: 'm190', role: 'user', content: [{ type: 'text', text: '追加一条，看你跳不跳' }] } },
	})
	await wait(90)
	const nodesAfter = [...log.children]
	// 断言的是"节点有没有被销毁"：整段重排（旧实现）会把每一行都重建，
	// 新实现只可能动尾部，之前的节点必须原样还在 DOM 里。
	// 本地回声（虚线气泡）是例外：真消息进来时它本来就该被替换掉，不算被销毁。
	const stable = (nodes) => nodes.filter((node) => node.querySelector('.bubble.pending') === null)
	check('追加新消息时，原来的行一个都没被销毁（增量渲染，不是整段重排）',
		stable(nodesBefore).every((node) => nodesAfter.includes(node)),
		`${nodesBefore.length} -> ${nodesAfter.length}`)
	check('新消息确实画出来了', log.textContent.includes('追加一条，看你跳不跳'))
	check('往上翻着看历史时追加消息，不抢滚动位置', log.scrollTop === 300, String(log.scrollTop))

	// 2) 流式输出只改最后一条：前缀节点必须原地不动（否则每帧都在重置滚动）。
	const prefix = [...log.children]
	source.emit({
		t: 'event',
		event: { type: 'assistant/message', seq: 191, time: 191, data: { turn: 19, step: 1, message: { id: 'm191', role: 'assistant', content: [{ type: 'text', text: '正在输出' }] } } },
	})
	await wait(60)
	const prefixNow = [...log.children]
	source.emit({
		t: 'event',
		event: { type: 'assistant/message', seq: 192, time: 192, data: { turn: 19, step: 1, message: { id: 'm191', role: 'assistant', content: [{ type: 'text', text: '正在输出，第二段' }] } } },
	})
	await wait(90)
	const afterStream = [...log.children]
	check('流式增量只动尾巴，前面的节点原地不动',
		stable(prefix).every((node) => afterStream.includes(node)) && stable(prefixNow).every((node) => afterStream.includes(node)),
		`${prefix.length} 个前缀节点`)

	// 3) 中间的内容变了（早先那条长高了）→ 位置按"离底部多远"锚回来，
	//    并且后面已经铺好的节点**一个都不重建** —— 这是 iOS 上"回弹"的真正解药：
	//    在滚动容器里删/建节点会让 iOS 把滚动位置复位，而流式输出每帧都在改 DOM。
	//    先摆三条：用户 → 工具（早先的那条） → 助手（最后一条）。
	source.emit({
		t: 'snapshot',
		cursor: 600,
		hasMore: false,
		records: [
			{ type: 'event', event: { type: 'user/message', seq: 601, time: 601, data: { id: 'k1', role: 'user', content: [{ type: 'text', text: '锚定测试的第一条' }] } } },
			{ type: 'event', event: { type: 'tool/call', seq: 602, time: 602, data: { turn: 91, step: 2, callId: 'anchor-call', name: 'pwsh', arguments: '{}' } } },
			{ type: 'event', event: { type: 'assistant/message', seq: 603, time: 603, data: { turn: 91, step: 3, message: { id: 'k3', role: 'assistant', content: [{ type: 'text', text: '锚定测试的最后一条' }] } } } },
		],
	})
	await wait(150)
	const tailNode = log.lastElementChild
	log.scrollTop = 300
	noteScrolled()
	const gapFromBottom = heightOf() - 300
	await wait(460) // 让"刚被用户滚过"的窗口过去（真实场景里内容变化通常晚得多）
	// 工具的输出来了 → 中间那条变长（它后面还有人，所以属于"结构变化"）
	source.emit({
		t: 'event',
		event: { type: 'tool/result', seq: 604, time: 604, data: { turn: 91, step: 2, message: { id: 'k4', role: 'user', content: [{ type: 'tool-result', toolCallId: 'anchor-call', content: [{ type: 'text', text: '很长很长的工具输出'.repeat(40) }] }] } } },
	})
	await wait(160)
	check('早先的内容变长时，后面已铺好的节点原地不动（按 key 复用，不重建）',
		log.lastElementChild === tailNode, log.lastElementChild === tailNode ? 'same node' : 'node was recreated')
	const expected = Math.max(0, heightOf() - gapFromBottom)
	check('位置按"离底部多远"锚回来（不是写回旧的 scrollTop）',
		log.scrollTop === expected && expected !== 300,
		`scrollTop=${log.scrollTop}（期望 ${expected}，写回旧值会停在 300）`)

	// 4) 手指按住时冻结渲染：拖动期间绝不能被重排抢走位置，松手后必须补画。
	const frozenAt = log.children.length
	log.dispatchEvent(new window.Event('touchstart'))
	source.emit({
		t: 'event',
		event: { type: 'user/message', seq: 1900, time: 1900, data: { id: 'm1900', role: 'user', content: [{ type: 'text', text: '拖动期间到的消息' }] } },
	})
	await wait(160)
	check('手指按住时先不重排（拖多少都不会被抹掉）', log.children.length === frozenAt, `${frozenAt} -> ${log.children.length}`)
	log.dispatchEvent(new window.Event('touchend'))
	await wait(340)
	check('松手后补画一次，消息不会丢',
		log.children.length > frozenAt && log.textContent.includes('拖动期间到的消息'),
		`${frozenAt} -> ${log.children.length}`)
}

/* --- 切走再切回来不再"又要加载" --------------------------------------------- */
/*
 * 现场：换到别的对话再换回来，屏幕先空白一下，再等一次整段对话下载（隧道上好几秒），
 * 而这份内容刚刚就在屏幕上。现在切走前把现场按会话存一份（内存里，最多 4 份），
 * 切回来先立刻铺上，再让长连接带着 since=<cursor> 去补"新的那几条"（通常一条都没有）。
 */
{
	const log = $('log')
	source.emit({
		t: 'snapshot',
		cursor: 500,
		hasMore: false,
		records: [
			{ type: 'event', event: { type: 'user/message', seq: 499, time: 499, data: { id: 'c1', role: 'user', content: [{ type: 'text', text: '缓存测试的消息一' }] } } },
			{ type: 'event', event: { type: 'assistant/message', seq: 500, time: 500, data: { turn: 50, step: 1, message: { id: 'c2', role: 'assistant', content: [{ type: 'text', text: '缓存测试的回答二' }] } } } },
		],
	})
	await wait(120)
	check('缓存测试前对话里有内容', log.textContent.includes('缓存测试的消息一'))

	const pullsBefore = requests.filter((entry) => entry.path.startsWith('/api/transcript')).length
	const others = [...$('session').options].map((option) => option.value).filter((value) => value !== SESSION)
	check('测试前提：下拉框里还有另一个会话可以切', others.length > 0, `${$('session').options.length} 个选项`)
	// 用一个【从没打开过】的会话来验证"没缓存就照旧拉整段"（切走过的都会被缓存，
	// 那正是这个功能的定义）。
	const fresh = others.includes('session-fresh') ? 'session-fresh' : (others[0] ?? SESSION)

	// 切到一个没打开过的会话：没有缓存 → 走老路（拉整段）。
	$('session').value = fresh
	$('session').dispatchEvent(new window.Event('change'))
	await wait(200)
	const freshStream = sources[sources.length - 1]
	const pullsAfterFresh = requests.filter((entry) => entry.path.startsWith('/api/transcript')).length
	check('没有缓存的会话照旧去拉整段（不会假装有内容）',
		pullsAfterFresh === pullsBefore + 1, `transcript ${pullsBefore} -> ${pullsAfterFresh}`)
	check('没有缓存的会话不带 since（手上没有内容，不能报序号）',
		!freshStream.url.includes('since='), freshStream.url)

	// 切回来：这一次必须"立刻"有内容 —— 同一句同步断言里都不出现空白。
	$('session').value = SESSION
	$('session').dispatchEvent(new window.Event('change'))
	const instant = log.textContent
	check('切回刚看过的会话：立刻就有内容（不再空白、也不用等下载）',
		instant.includes('缓存测试的消息一') && instant.includes('缓存测试的回答二'),
		`${instant.trim().length} 字符`)
	const warmStream = sources[sources.length - 1]
	check('切回来时不再重拉整段对话（省掉一个来回）',
		requests.filter((entry) => entry.path.startsWith('/api/transcript')).length === pullsBefore + 1,
		`transcript ${pullsBefore} -> ${requests.filter((entry) => entry.path.startsWith('/api/transcript')).length}`)
	check('切回来时长连接带着 since=<cursor>（宿主只补新记录）',
		warmStream.url.includes('since=500'), warmStream.url)

	// 增量快照（partial）只追加，绝不能把历史冲掉 —— 它里面本来就只有新记录。
	source.emit({
		t: 'snapshot',
		partial: true,
		cursor: 501,
		hasMore: false,
		records: [{ type: 'event', event: { type: 'user/message', seq: 501, time: 501, data: { id: 'c3', role: 'user', content: [{ type: 'text', text: '增量来的新消息' }] } } }],
	})
	await wait(120)
	check('增量快照不会把历史冲掉，只把新记录接在后面',
		log.textContent.includes('缓存测试的消息一') && log.textContent.includes('增量来的新消息'),
		log.textContent.replace(/\s+/g, ' ').slice(0, 80))
}

/* --- 发完消息后"光标钉住视线"：往上滑一点就被拽回底部 ---------------------- */
/*
 * 现场：发出一句话之后，界面牢牢贴着底部的那个光标，上下滑都会自动弹回那里，看不了消息。
 * 两个原因叠在一起：
 *   1. "算不算在底部"的阈值是 120px，而流式输出每帧都重排一次 —— 手指刚往上滑一点
 *      就被判成"仍在底部"，立刻贴回去；
 *   2. 输入框还聚焦着，iOS 会不停把光标滚进可视区，跟用户抢滚动。
 * 现在：手指一碰对话区就停止跟随 + 收键盘，松手落在底部才恢复跟随；阈值收到 24px。
 */
{
	const log = $('log')
	const heightOf = () => 200 * log.children.length
	const viewport = () => 400
	Object.defineProperty(log, 'scrollHeight', { configurable: true, get: heightOf })
	Object.defineProperty(log, 'clientHeight', { configurable: true, get: viewport })
	// jsdom 不夹取 scrollTop，真浏览器会：夹一下，免得"贴底"在测试里跑出可滚动范围。
	let scrollTopValue = 0
	Object.defineProperty(log, 'scrollTop', {
		configurable: true,
		get: () => scrollTopValue,
		set: (value) => {
			const max = Math.max(0, heightOf() - viewport())
			scrollTopValue = Math.max(0, Math.min(Number(value) || 0, max))
		},
	})
	const bottom = () => Math.max(0, heightOf() - viewport())
	const notScrolling = () => log.dispatchEvent(new window.Event('scroll'))

	// 先摆在"贴着底部"（等价于刚发完消息那一瞬间）
	log.scrollTop = bottom()
	notScrolling()

	// 手指按住，往上滑 60px —— 老阈值 120px 会把这判成"还在底部"
	log.dispatchEvent(new window.Event('touchstart'))
	log.scrollTop = log.scrollTop - 60
	const parked = log.scrollTop
	// 流式输出还在继续（这会触发重排）
	source.emit({
		t: 'event',
		event: { type: 'assistant/message', seq: 5100, time: 5100, data: { turn: 77, step: 1, message: { id: 'm5100', role: 'assistant', content: [{ type: 'text', text: '滑上去之后又输出了一段' }] } } },
	})
	await wait(80)
	log.dispatchEvent(new window.Event('touchend'))
	await wait(280)
	check('往上滑一点就不会被拽回底部（视线不再被光标钉住）',
		log.scrollTop === parked, `scrollTop=${log.scrollTop} 期望${parked}`)
	check('确实没有贴到底（贴底才是老 bug 的表现）',
		log.scrollTop !== bottom(), `scrollTop=${log.scrollTop} 底部=${bottom()}`)

	// 松手时就在底部 → 跟随要恢复（别把"跟着新消息走"一起关掉）
	log.scrollTop = bottom()
	log.dispatchEvent(new window.Event('touchstart'))
	log.dispatchEvent(new window.Event('touchend'))
	await wait(280)
	source.emit({
		t: 'event',
		event: { type: 'assistant/message', seq: 5101, time: 5101, data: { turn: 77, step: 1, message: { id: 'm5101', role: 'assistant', content: [{ type: 'text', text: '又一段' }] } } },
	})
	await wait(90)
	check('松手时就在底部 → 继续跟着新消息走',
		log.scrollTop === bottom(), `scrollTop=${log.scrollTop} 底部=${bottom()}`)

	// 键盘：碰对话区就收起来（iOS 上聚焦的输入框会把光标一直滚回可视区）
	$('text').focus()
	check('（前置）输入框拿到焦点', window.document.activeElement === $('text'))
	log.dispatchEvent(new window.Event('touchstart'))
	check('碰对话区就收起键盘（不然 iOS 会一直把光标滚回来，和用户抢滚动）',
		window.document.activeElement !== $('text'))
	log.dispatchEvent(new window.Event('touchend'))
	await wait(200)

	// 「回到最新」：不再自动把视线拽回去，但给一个明确的回去入口。
	log.scrollTop = Math.max(0, bottom() - 300)
	log.dispatchEvent(new window.Event('touchstart'))
	log.dispatchEvent(new window.Event('touchend'))
	await wait(280)
	source.emit({
		t: 'event',
		event: { type: 'assistant/message', seq: 5200, time: 5200, data: { turn: 99, step: 1, message: { id: 'm5200', role: 'assistant', content: [{ type: 'text', text: '新内容来了，但不许拽我' }] } } },
	})
	await wait(90)
	check('往上翻着看时出现「回到最新」（有明确出路，而不是自动拽回去）',
		window.getComputedStyle($('tonew')).display !== 'none', window.getComputedStyle($('tonew')).display)
	check('新内容没有把视线拽走', log.scrollTop < bottom(), `scrollTop=${log.scrollTop} 底部=${bottom()}`)
	$('tonew').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(90)
	check('点它就贴回底部并收起按钮',
		log.scrollTop === bottom() && window.getComputedStyle($('tonew')).display === 'none',
		`scrollTop=${log.scrollTop} 底部=${bottom()} display=${window.getComputedStyle($('tonew')).display}`)
}

/* --- 生图面板 与 权限面板（输入框旁边那两个新键）--------------------------- */
/*
 * 两个键都必须在输入框那一排里（用户不用去别的页签找），都必须是全屏面板
 * （和「新建」一样的形态），而且**发出去之前用户能看见将要发生什么**：
 * 生图给的是"将要发给 agent 的那句话"原文，权限给的是每档能干什么。
 */
{
	const nextFrame = async () => {
		for (let index = 0; index < 3; index += 1) {
			await new Promise((resolve) => window.requestAnimationFrame(resolve))
		}
	}
	const compose = $('compose')
	const tools = $('tools')
	const genPanel = $('genopen')
	const permPanel = $('permopen')
	const textarea = $('text')

	check('生图键在输入区上方那一排工具键里', tools.contains($('genBtn')))
	check('权限键也在那一排里', tools.contains($('permBtn')))
	check('工具键排和输入框排在同一个输入区里（没被挪到别的地方）',
		$('composer').contains(tools) && $('composer').contains(compose))
	check('两个面板都先收着', window.getComputedStyle(genPanel).display === 'none' && window.getComputedStyle(permPanel).display === 'none')

	$('genBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	check('点「生图」弹出面板（盖在当前内容上，不换页签）',
		window.getComputedStyle(genPanel).display !== 'none' && window.getComputedStyle($('view-task')).display !== 'none')
	check('生图面板自己写着标题', $('genopen').textContent.includes('生成图片'))

	// 一次点完：描述 + 竖屏 + 固定种子 → 预览里就该出现这句话。
	textarea.value = ''
	textarea.style.height = ''
	const promptBox = $('genPrompt')
	promptBox.value = 'a red apple on a white table, soft daylight, photo'
	promptBox.dispatchEvent(new window.Event('input', { bubbles: true }))
	$('genopen').querySelectorAll('.genopt')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	$('genSeed').value = '12345'
	$('genSeed').dispatchEvent(new window.Event('input', { bubbles: true }))
	const preview = $('genPreview').textContent
	check('预览里就是将要发给 agent 的那句话（原样、不猜）',
		preview.includes('image_generate') && preview.includes('a red apple on a white table, soft daylight, photo'),
		preview.slice(0, 60))
	check('选的尺寸进了预览', preview.includes('1024x1536'), preview.slice(0, 80))
	check('填了种子就带上种子（便于重出同一张）', preview.includes('种子：12345'), preview.slice(0, 100))

	// 第一次直接把话放进输入框让用户过目，而不是当场发出去（一按就花钱，不能偷偷发）。
	const promptsBefore = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	$('genGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
	check('第一次点「生成」：话放进输入框，等用户自己按发送',
		textarea.value.includes('image_generate') && textarea.value.includes('a red apple'),
		JSON.stringify(textarea.value.slice(0, 40)))
	check('这一刻还没有发出任何任务（不偷偷花钱）',
		requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === promptsBefore)
	check('生图面板顺势收起（下一步是发送）', window.getComputedStyle(genPanel).display === 'none')
	check('输入框跟着长高（那句话有好几行，不能被切成一条缝）',
		textarea.style.height !== '' && textarea.style.height !== 'auto', textarea.style.height)

	// 第二次再点「生成」：照发（用户已经过目过一次）。
	$('genBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	$('genGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	check('第二次点「生成」：直接发出去',
		requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === promptsBefore + 1,
		`${promptsBefore} -> ${requests.filter((entry) => entry.path.startsWith('/api/prompt')).length}`)

	// 返回要确认，不能一点就把写好的描述弄没。
	$('genBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	$('genPrompt').value = 'a cat'
	window.confirm = () => { confirmAnswer = false; return confirmAnswer }
	$('genBack').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	check('描述没写完就点返回：先问一句，面板留着（草稿不丢）',
		window.getComputedStyle(genPanel).display !== 'none', window.getComputedStyle(genPanel).display)
	window.confirm = () => { confirmAnswer = true; return confirmAnswer }
	$('genBack').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	check('确认放弃后才真的收起', window.getComputedStyle(genPanel).display === 'none')

	// 权限面板：三档、人话、当前档打勾、改权限要重新输 PIN。
	$('permBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	check('点🔐弹出权限面板', window.getComputedStyle(permPanel).display !== 'none')
	check('权限是按会话读的（请求带上了当前 sessionId）',
		permRequests.length === 0 && requests.some((entry) => entry.path === '/api/permission?sessionId=' + SESSION),
		requests.filter((entry) => entry.path.startsWith('/api/permission')).map((entry) => entry.path).join(' | '))
	check('三档都在，而且是中文标签', permPanel.querySelectorAll('.permopt').length === 3 && permPanel.textContent.includes('可写工作区'),
		permPanel.textContent.replace(/\s+/g, ' ').slice(0, 90))
	check('当前那档打勾了（灰底那颗点会被点亮）',
		permPanel.querySelector('.permopt.on')?.dataset.perm === 'danger-full-access',
		permPanel.querySelector('.permopt.on')?.dataset.perm)
	check('每档都写着能干什么', permPanel.textContent.includes('不能改任何东西'), '')
	check('锁上那颗角标点染的是当前档位', $('composer').dataset.perm === 'danger-full-access', $('composer').dataset.perm)

	// 换成只读 = 收紧，不用重新验 PIN。
	permPanel.querySelector('.permopt[data-perm="read-only"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	$('permApply').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	check('发出去的写请求带着 sessionId 与档位',
		permRequests.at(-1)?.sessionId === SESSION && permRequests.at(-1)?.preset === 'read-only',
		JSON.stringify(permRequests.at(-1)))
	check('切成功后面板收起并回一句人话',
		window.getComputedStyle(permPanel).display === 'none' && $('banner').textContent.includes('权限已改成'),
		$('banner').textContent)
	check('角标跟着换成新档位', $('composer').dataset.perm === 'read-only', $('composer').dataset.perm)

	// 提权过期：令牌还能用（读得到），但一动手就被 403 + needPin 拦下。
	// 桩里直接把"提权"这一位翻掉即可 —— jsdom 的 fetch 不解析相对地址，
	// 真去 POST /api/logout 只会因为 URL 解析失败而假红。
	permState.elevated = false
	$('permBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	check('提权过期时权限仍然读得到（不是一片空白）',
		window.getComputedStyle(permPanel).display !== 'none' && permPanel.querySelectorAll('.permopt').length === 3,
		`${permPanel.querySelectorAll('.permopt').length} 档`)
	permPanel.querySelector('.permopt[data-perm="workspace-write"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	$('permApply').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	check('被拒时把 PIN 门打开（用户不是卡在"提示要输 PIN 却到处没有输入框"）',
		window.getComputedStyle($('gate')).display !== 'none' && window.getComputedStyle($('app')).display === 'none',
		`gate=${window.getComputedStyle($('gate')).display}`)
	check('被拒时没有改坏当前档位', permState.preset === 'read-only', permState.preset)
	// PIN 门是盖在 app 上面的一层：面板的可见性这时被它挡住，但面板本身没收起、
	// 用户点的那档也还在 —— 验完 PIN 回来直接接着点「应用」，不用重选一遍。
	check('面板和选择都留着（PIN 门后面点的还是刚才那档）',
		permPanel.style.display === 'flex'
		&& permPanel.querySelector('.permopt.on')?.dataset.perm === 'workspace-write',
		`display=${permPanel.style.display} picked=${permPanel.querySelector('.permopt.on')?.dataset.perm}`)

	$('pin').value = '123456'
	$('gateBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(160)
	check('输对 PIN 后回到会话界面', window.getComputedStyle($('app')).display !== 'none')
	permState.elevated = true
	$('permApply').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	check('验过 PIN 后再点「应用」就改成了', permState.preset === 'workspace-write', permState.preset)
	check('改完收起面板并回一句人话',
		window.getComputedStyle(permPanel).display === 'none' && $('banner').textContent.includes('权限已改成'),
		$('banner').textContent)

	// 后面还有会话切换/流式等用例：把它们要的现场还原回去（提到放开档、回到可见状态）。
	permState.preset = 'danger-full-access'
	permState.elevated = true
	$('composer').dataset.perm = 'danger-full-access'
	await nextFrame()
}

/* --- stale-page self-heal ------------------------------------------------ */
/* A phone that stays open across a server restart must notice that the build
   changed. Asserted last, because a real reload would reset the DOM. */

const reloads = () => jsdomErrors.filter((message) => /navigation|reload/i.test(message)).length

const metaTag = window.document.querySelector('meta[name="dsh-page-tag"]')
check('the served page carries the real tag, not the marker',
	metaTag !== null && metaTag.content === PAGE_TAG, metaTag === null ? 'meta missing' : metaTag.content)

const before = reloads()
source.emit({ t: 'snapshot', tag: PAGE_TAG, cursor: 4, hasMore: false, records: [] })
await wait(90)
check('a snapshot from the same build never reloads', reloads() === before, `${reloads()} reload(s)`)

source.emit({ t: 'snapshot', tag: 'a-different-build', cursor: 4, hasMore: false, records: [] })
await wait(120)
check('a snapshot from a newer build reloads the page', reloads() === before + 1, `${reloads()} reload(s)`)

const afterFirst = reloads()
source.emit({ t: 'snapshot', tag: 'a-different-build', cursor: 4, hasMore: false, records: [] })
await wait(120)
check('the same stale tag never reloads twice (no loop)', reloads() === afterFirst, `${reloads()} reload(s)`)

dom.window.close()

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
