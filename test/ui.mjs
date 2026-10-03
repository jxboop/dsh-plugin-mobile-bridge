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
]

const requests = []
const opened = []
/** Text handed to the clipboard path, captured from the scratch textarea. */
const copied = []
/** Answer the two confirm() guards; flipped per assertion below. */
const confirms = []
let confirmAnswer = true
let source = null

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

function stubFetch(input, options = {}) {
	const full = resolveRequest(input)
	const path = full.startsWith(SECRET_PREFIX) ? `/${full.slice(SECRET_PREFIX.length)}` : full
	requests.push({ url: full, path, options })
	if (path.startsWith('/api/bootstrap')) return jsonResponse({ sessions: SESSIONS, failure: null })
	if (path.startsWith('/api/attachment')) return jsonResponse({ mediaType: 'image/png', data: 'iVBORw0KGgo=' })
	if (path.startsWith('/api/prompt')) return jsonResponse({ accepted: true })
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
	}
	close() { this.readyState = 2 }
	emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

const dom = new JSDOM(html, {
	url: PAGE_URL,
	runScripts: 'dangerously',
	pretendToBeVisual: true,
	virtualConsole,
	beforeParse(window) {
		window.fetch = stubFetch
		window.EventSource = FakeEventSource
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

await wait(150)

check('bootstrap shows the app and hides the PIN gate',
	window.getComputedStyle($('app')).display !== 'none' && window.getComputedStyle($('gate')).display === 'none',
	`app=${window.getComputedStyle($('app')).display} gate=${window.getComputedStyle($('gate')).display}`)
check('session picker is populated', $('session').options.length === 2, `${$('session').options.length} options`)
check('the most recent session is selected and streamed',
	$('session').value === SESSION && source !== null && source.url.includes(SESSION),
	`value=${$('session').value} url=${source?.url}`)

/* --- 每个请求都必须落在密钥段之内 ---------------------------------------- */

// 页面藏在随机密钥段后面；只要有一处退回绝对路径，线上就是 404。
// mock 按浏览器语义解析相对地址，所以这里断言的正是线上会发生的事 ——
// 这也正是当初让整个测试静默烂掉的那个漂移。
const escaped = requests.filter((entry) => !entry.url.startsWith(SECRET_PREFIX))
check('所有 fetch 都落在密钥段之内', escaped.length === 0,
	escaped.length === 0 ? `${requests.length} 个请求` : escaped.map((e) => e.url).join(', '))
check('EventSource 也在密钥段之内',
	source !== null && source.url.includes(SECRET_PREFIX), source?.url)

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
check('history image is requested once', requests.filter((entry) => entry.path.startsWith('/api/attachment')).length === 1,
	`${requests.filter((entry) => entry.path.startsWith('/api/attachment')).length} attachment fetches`)
check('history image element is present', window.document.querySelectorAll('#log img').length === 1)

/* --- live streaming ------------------------------------------------------ */

source.emit({ t: 'event', event: { type: 'turn/start', seq: 5, time: 5, data: { turn: 2 } } })
source.emit({ t: 'delta', frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 2, step: 1, startedAfterSeq: 4 } })
source.emit({ t: 'delta', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 6, chunk: { type: 'text-delta', index: 0, text: '正在' } } })
source.emit({ t: 'delta', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 7, chunk: { type: 'text-delta', index: 0, text: '处理' } } })
await wait(120)

check('live deltas accumulate in a streaming bubble', $('log').textContent.includes('正在处理'))
check('a running turn hides send and shows stop',
	window.getComputedStyle($('stop')).display !== 'none' && window.getComputedStyle($('send')).display === 'none',
	`stop=${window.getComputedStyle($('stop')).display} send=${window.getComputedStyle($('send')).display}`)

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

const promptCall = requests.find((entry) => entry.path.startsWith('/api/prompt'))
const promptBody = promptCall ? JSON.parse(promptCall.options.body) : null
check('send posts the session, text and images',
	promptBody?.sessionId === SESSION && promptBody?.text === '帮我把这张图转成文字' && Array.isArray(promptBody?.images),
	JSON.stringify(promptBody))
check('the composer is cleared after sending', input.value === '')

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
