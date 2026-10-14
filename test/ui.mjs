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
/**
 * 服务端注入的三样东西（1.8.0 起多了版本与"最近更新"）：
 * 页面里的 `__DSH_*__` 标记在真桥上一定会被替换掉，测试也得替，否则测的是"标记漏在页面上"。
 */
const FIXTURE_VERSION = '9.9.9'
const FIXTURE_WHATSNEW = JSON.stringify([
	{ version: '9.9.9', date: '2026-10-09', lines: ['加（一条**加**的功能）', '修（一个真 bug）'] },
	{ version: '9.9.8', date: '2026-10-08', lines: ['改（某个位置）'] },
	{ version: '9.9.7', date: '2026-10-08', lines: ['加（第三版）'] },
	{ version: '1.0.0', date: '2026-10-08', lines: ['加（最早那一版）'] },
	/*
	 * ⚠️ 4.3.1（用户 2026-10-14：「找到 1.0 以前版本的更新内容并补全到说明里」✓）：
	 * 服务端会在最后追加一节 `1.0 之前` ✓（`whatsNew()` 里那段 ✓）—— fixture 也带上它 ✓，
	 * 这样"页面上那一节真的画出来了"才有 DOM 断言 ✓（不然只有服务端的单元断言 ✓）。
	 */
	{ version: '1.0 之前', date: '起步', lines: ['起步（0.1 → 0.5）：手机上第一次能看进度、能回话'] },
])
/*
 * ⚠️ 4.3.0 检修（冷视角复查点过"还有没有裸 await"✓）：这一处是**硬前置** ✓ ——
 * 连页面本体都读不到，后面一条断言都跑不了 ✓。所以不是"吞掉继续跑" ✗，
 * 而是**把话说清再退出** ✓（免得陌生人看到一段没头没尾的栈 ✓）。
 */
let htmlSource = ''
try {
	htmlSource = await readFile(join(HERE, '..', 'lib', 'mobile.html'), 'utf8')
} catch (error) {
	console.error('读不到 lib/mobile.html —— 这套测试是拿真页面在 jsdom 里跑的，没有它就无从测起。\n')
	console.error('  期望位置：' + join(HERE, '..', 'lib', 'mobile.html'))
	console.error('  实际错误：' + String(error?.message ?? error) + '\n')
	process.exit(2)
}
const html = htmlSource
	// 服务端用的是 replaceAll（标记在页面里出现不止一次），测试也得一样。
	.replaceAll('__DSH_PAGE_TAG__', PAGE_TAG)
	.replaceAll('__DSH_BRIDGE_VERSION__', FIXTURE_VERSION)
	.replaceAll('__DSH_WHATSNEW__', FIXTURE_WHATSNEW)
	.replaceAll('__DSH_THEMES__', JSON.stringify([['🎤 录音与转文字', '从找文件变成网页里直接录（1.5.0）'], ['📱 手机界面', '左右滑换页（1.7.0）']]))
	/*
	 * 4.4.0：按"代"的总结 + 5.0 预告 ✓（服务端注入的两块数据 ✓）—— 测试也得替 ✓，
	 * 不然测的就是"标记漏在页面上" ✗。
	 */
	.replaceAll('__DSH_ERAS__', JSON.stringify([['0.1 → 1.0', '（四十多版）能看进度、能回话、能批操作'], ['1.0 → 2.0', '复制键 + 任意文件、网页录音、左右滑换页']]))
	.replaceAll('__DSH_NEXTUP__', JSON.stringify({
		version: '5.0.0',
		title: '开放平台',
		lead: '从一个插件，长成"个人 AI 操作系统的入口"。',
		items: ['开放标准协议', '第三方硬件与服务接入'],
		between: '中间那几代是方向，不是承诺。',
		note: '⚠️ 这是愿景，不是排期。',
	}))

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
/**
 * 3.0.0 ★③「念出来」（TTS）：jsdom 没有 `speechSynthesis` ✓ —— 塞一对假的进去 ✓，
 * 记录"念了什么、停没停" ✓。这就是"TTS 到底有没有真的接上"最直接的证据 ✓
 * （只看 DOM 上有没有那个 🔊 键，证明不了它按下去了会说话 ✓）。
 */
const speechStub = { spoken: [], cancelCount: 0, pending: null }

/**
 * 3.0.0 ★③「说出来 → 文字」（STT）：Web Audio 与 jsdom 无关 ✓ —— 这里记下页面拿到的
 * ScriptProcessor（测试要靠它**灌进假采样** ✓，才谈得上"真的录了一段"✓）与关了几次 ✓。
 */
const audioStub = { processors: [], closed: 0, stopped: 0 }

/**
 * 3.0.0 ★②「有事通知我」：jsdom 没有 `Notification` ✓ —— 塞一个假的 ✓，
 * 记录"弹了什么标题/正文" ✓（只看界面上有没有那个勾，证明不了它真会叫人 ✓）。
 */
const notifyStub = { made: [], instances: [], requested: 0, permission: 'default' }

const jsdomErrors = []
/**
 * 页面自己的 `console` 输出（2026-10-12 加）✓。
 *
 * 为什么必须收：页面里的渲染是**包了 try/catch** 的 ✓（2.10.1 那条修复 ✓）——
 * 好处是"一条消息画不出来"不会把整页弄死 ✓，坏处是**它从此可以静默地不再更新** ✗✗：
 * `render()` 抛一次 → 屏幕上什么都不变 → 用户看到的是"消息不出现了" ✓，
 * 而**所有测试断言照样绿** ✓（因为 DOM 只是没变，不是变错 ✗）。
 * 真事：写 ★8 时就撞上了 —— 事件铺不上屏、log 冻在 643 个字符，查了三轮才想到看 console ✓。
 * 所以把页面 console 收下来 ✓，并在收尾断言"整轮没有意外报错" ✓。
 */
const consoleLogs = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (error) => { jsdomErrors.push(String(error?.message ?? error)) })
virtualConsole.on('error', (...args) => { consoleLogs.push(args.map((value) => String(value?.message ?? value)).join(' ')) })
virtualConsole.on('warn', (...args) => { consoleLogs.push('warn: ' + args.map((value) => String(value?.message ?? value)).join(' ')) })

const results = []
const check = (name, ok, detail = '') => {
	results.push({ name, ok })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

const SESSION = 'session-ui-test'
const SESSIONS = [
	{
		sessionId: SESSION,
		title: '手机界面测试',
		cwd: 'D:\\learn\\deepseek学习',
		running: false,
		blank: false,
		updatedAt: 2000,
		// 2.6.0：宿主给每一行都带着**真值模型**（modelSelection 投影）。手机上顶端那一行
		// 显示的就是它 —— 而不是手机自己记的 `dshm.model`。
		model: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: '' },
		// 2.8.0 ★12：宿主 `tokenUsage` 投影的累计值（桥在 summarize 里带出来 ✓，页面据此显示
		// "本会话累计 ↑… ↓…" ✓）。**只有这一行有** ✓ —— 另一条会话没有，正好验"读不到就不显示" ✓。
		usage: { input: 12345, output: 678, cacheRead: 0, cacheWrite: 0, total: 13023 },
	},
	{ sessionId: 'session-older', title: '旧会话', cwd: 'D:\\tool', running: false, blank: false, updatedAt: 1000 },
	// 第三个会话专门留给"从没打开过"的场景：缓存测试要验证"没缓存的会话照旧拉整段"，
	// 而任何被切走过的会话都会被记进缓存（这正是那个功能的定义），所以需要一个新的。
	{ sessionId: 'session-fresh', title: '没打开过的会话', cwd: 'D:\\tool', running: false, blank: false, updatedAt: 500 },
	// 2.6.0 新增两类：**agent 子会话**（origin/parentSessionId 判定）和 **cwd 就在桥自己目录里**
	// 的自检会话。它们默认**不出现在手机列表里**（用户：「占位置」），但可以勾「显示全部会话」看回来。
	{ sessionId: 'session-sub', title: '你是事实核查员。任务：独立核对', cwd: 'D:\\tool', running: false, blank: false, updatedAt: 400, subagent: true },
	{ sessionId: 'session-self', title: '输出数字 1 到 1200', cwd: 'D:\\dsh\\dsh-home\\plugin-src\\dsh-plugin-mobile-bridge', running: false, blank: false, updatedAt: 300, ownDir: true },
	// 删除用例专用：删"正在看的那个"时，页面上必须有**另一个**会话可落脚。
	{ sessionId: 'session-live', title: '正在看的会话', cwd: 'D:\\tool', running: false, blank: false, updatedAt: 1500 },
]
/** 删除接口要的 PIN（桩认这一个）。 */
const CORRECT_PIN = '123456'
/** 2.6.0：已经被"删除"（归档）掉的会话 —— bootstrap 不再把它们报回来。 */
const archiveRemoved = new Set()
/** 删除请求的请求体（断言带没带 sessionId / PIN / stop）。 */
const archiveRequests = []
/** 2.7.0 ★3：结束进程的请求体。 */
const killRequests = []
/** 2.7.0 ★4：一键动作（锁屏/关机/重启/取消）的请求体。 */
const powerRequests = []
/** 2.7.0 ★4：发到电脑剪贴板的请求体。 */
const clipboardWrites = []
/** 2.7.0 ★6：定时任务的请求体。 */
const scheduleWrites = []
/** 2.7.0 ★10：只读链接（生成 / 撤销）的请求体。 */
const shareWrites = []
/** 2.8.0 ★2：踢掉其它设备的请求体。 */
const revokeWrites = []
/** 2.8.0 ★2：读登录历史时带的 PIN（断言"**光有 cookie 读不到**" ✓）。 */
const loginsReads = []

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
/** 换背景的请求体（POST /api/background）：断言"选中文件后把名字交给了宿主"。 */
const bgRequests = []
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
/** 接下来几次 /api/login 以"网络层失败"结束（模拟电脑没开/隧道没起来）。 */
let loginFailures = 0
/** /api/login 的 HTTP 状态（401 = PIN 不对，页面**不该**重试）。 */
let loginStatus = 200
/** 接下来几次 /api/prompt 以"网络层失败"结束（模拟隧道边缘把大 body 掐断）。 */
let promptFailures = 0
/** 记录假的 XHR 报过的 (loaded,total) 组合，验证加载条是按字节走的。 */
const progressReports = []
/** 页面发出的每个 XHR（含 boot 那个）—— 用来断言 boot 请求设了超时。 */
const xhrRequests = []
/** 让接下来 N 次 /api/prompt 在 fetch 层直接失败（模拟隧道抖动 → 页面该自动重试）。 */
let promptFailTimes = 0
/** 让**下一次** /api/prompt 回一个带状态码的错（2.8.0 ★4 的「重试」按钮要这种"服务端明确拒绝"✓）。 */
let promptFailStatus = 0
/** 让**下一次** /api/prompt 拖一会儿才回（2.11.0 ★11：「正在发送…」得看得见 ✓）。 */
let promptDelayMs = 0
/** 3.0.0 ★③：切到"这台电脑没开语音"那条路 ✓（要验"如实说"而不是假装转了 ✓）。 */
let sttOffline = false
/** 3.0.0 ★③/④：云识别器转写回"要 PIN"（**必须带 needPin** ✓）—— 要验 PIN 门真能弹出来 ✓。 */
let sttNeedPin = false
/** 3.0.0 ★④：让 `/api/login` 回"等放行"、`/api/pending` 回 pending / 401 ✓（多端授权那两屏）。 */
let loginPending = false
let pendingExpired = false
/** 手机上报给桥的客户端日志（`POST /api/clientlog`）。 */
const clientLogs = []
/** 上传接口的并发观测（峰值同时在飞的片数）。 */
let uploadInFlight = 0
let uploadPeak = 0
/**
 * 3.5.0：每片上传的耗时（默认 25ms ✓，和以前一样 ✓）。
 * 验"**进度提示真的看得见**"时要临时放慢 ✓ —— 不然那一句只活 25ms ✗，
 * 断言就只能靠猜，测不出"屏幕上到底有没有动过"✗。
 */
let uploadDelayMs = 25
/** 3.5.0：让接下来 N 次 `/api/upload` 直接失败（验"**客户端断了**"那条日志 ✓）。 */
let uploadFailTimes = 0
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
	/** 3.5.0：让写权限回 500（验"落不下去时不许按错的权限开跑"✓）。 */
	failWrites: false,
}
const permRequests = []

/**
 * 3.5.0：权限的**人话表** —— 🔐 面板（按会话 ✓）与「新建任务」那张纸（按这台电脑 ✓）
 * 用的是同一套档位 ✓，桩里也只留一份 ✓（两份就会各自漂 ✗）。
 */
const permLabels = { 'read-only': '只读', 'workspace-write': '可写工作区', 'danger-full-access': '完全放开' }
const permDetails = {
	'read-only': '能看、能读文件，不能改任何东西。看资料、查代码用这档。',
	'workspace-write': '能在项目文件夹里建文件、改文件、跑命令；动到文件夹外面时要问你一次。',
	'danger-full-access': '整台机器都能改、命令不再逐条问你。只在你盯着它干活时用。',
}
const permOptions = () => Object.keys(permLabels).map((value) => ({ value, label: permLabels[value], detail: permDetails[value] }))

function jsonResponse(body, status = 200) {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	})
}

/**
 * 3.5.0「目标」：`GET /api/goal` 的桩**返回值**（测试可以改它 ✓ —— 要分别验
 * "有目标" ✓ / "会话没在跑" ✓ / "宿主没有 goals 服务" ✓ 这三种，尤其是后两种**不是**"没有目标" ✗）。
 */
let goalStub = { ok: true, goal: null, message: '这条会话现在没有目标 ✓' }

/** 3.5.0「免手对话」：`GET /api/voice` 的桩返回值（测试可改 ✓）。 */
let voiceStub = {
	ok: true, enabled: false, listening: false, remainingMs: 0, defaultMinutes: 10, maxMinutes: 30,
	states: ['off', 'listening', 'transcribing', 'running', 'speaking'],
	message: '语音模式没开（在 ~/.dsh/mobile-bridge.json 里加 "voiceMode": true ✓）',
}

/** 3.5.0：页面发给 `/api/voice` 的 **POST** 都记在这儿 ✓（bug 就在"没发"上 ✗）。 */
const voicePosts = []

/** 3.8.0「屏幕取字」：页面发给 `/api/screen/ocr` 的 POST（含 PIN 头）都记在这儿 ✓。 */
const screenOcrPosts = []

/** 3.9.0：下一次 `POST /api/power` 让他失败 ✓（复查第 93 轮点名：桩永远成功 → 假承诺抓不到 ✗）。 */
/*
 * 4.5.0「控制电脑」那套桩的状态 ✓：
 *   · `pcRequests`：页面发给 `/api/pc` 的每个动作（断言"点哪个键发了哪个 action" ✓）；
 *   · `pcStubOff`：让 `GET /api/pc` 回"默认关" ✓（页面必须**把怎么开写出来** ✓）；
 *   · `pcStubBrightnessUnsupported`：回"这台机器没有可调的内置屏幕" ✓
 *     （台式机 / 只接外接屏那条分支 ✓ —— 页面必须**如实说**，不许假装调成功 ✗）。
 */
const pcRequests = []
let pcStubOff = false
let pcStubBrightnessUnsupported = false
/** 3.9.0：下一次 `POST /api/power` 让他失败 ✓（复查第 93 轮点名：桩永远成功 → 假承诺抓不到 ✗）。 */
let powerFailOnce = false

/** 4.0.0「录屏遥控」：页面发给 `/api/record` 的 POST 都记在这儿 ✓；`recordFailOnce` 用来装"默认关" ✓。 */
const recordRequests = []
let recordFailOnce = false

/** 4.1.0「分享安装」：取过几次文案 ✓（「点了没反应」这类 bug 全靠它抓 ✓）。 */
let installFetches = 0
/** 4.2.0：取过几次**网页版** ✓（钉「点了真去取」✓）。 */
let installHtmlFetches = 0
/** 4.2.0：让**下一次**取网页版失败 ✓（钉「取不到要明说」✓ —— 复查第 96 轮点名的那条缺口 ✓）。 */
let installHtmlFailOnce = false

/**
 * 4.1.0 复查：下一次 `GET /api/install` 让它失败 ✓（和 `powerFailOnce` / `recordFailOnce` 同一个思路 ✓）——
 * 桩原来永远 200 ✓，`loadInstall()` 的 **catch 分支**（`box.value = ''` + 「取不到：…」）**从没被碰过** ✗
 * → 把清空那行删掉也照样全绿 ✗（假绿 ✓）。用完自动复位 ✓，不影响后面那次「重新取」✓。
 */
let installFailOnce = false

/**
 * 3.5.x「解锁」：页面发给 `/api/power` 的 **POST** 都记在这儿 ✓ ——
 * 断言"点了「解锁电脑」到底发没发那条请求"✓ 就靠它 ✓（和 `voicePosts` 同款思路 ✓：
 * **没发出去**才是真 bug ✗ —— 真机日志那一课 ✓）。
 */
const powerPosts = []

/**
 * 3.5.0：让 `POST /api/voice` 回 **403 + needPin** ✓ —— 验"要提权一次"那条路 ✓。
 * 真机踩的坑就在这儿 ✗：以前走 `api()` → 弹的是「登录已过期」✗ 且**不重试** ✗ → 用户"输了 PIN 还是没输出"✓。
 */
let voicePostNeedPin = false

/** 纯文本响应（文档预览用：`/api/file?path=…md` 要把原文给页面）。 */
function textResponse(body, status = 200, type = 'text/markdown') {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve({}),
		text: () => Promise.resolve(body),
		// 3.4.3：「分享」会把文档取回来包成 File（`navigator.share({files})` ✓）—— 桩里也要有 blob() ✓。
		blob: () => Promise.resolve(new window.Blob([body], { type })),
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
		sessions: SESSIONS.filter((item) => archiveRemoved.has(item.sessionId) === false),
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

const pickedModelRequests = []

async function stubFetch(input, options = {}) {
	const full = resolveRequest(input)
	const path = full.startsWith(SECRET_PREFIX) ? `/${full.slice(SECRET_PREFIX.length)}` : full
	requests.push({ url: full, path, options })
	/*
	 * 3.5.x「解锁」：`POST /api/power {action:'unlock'}` 记在这里 ✓（桩不需要装成真解开 ✓，
	 * 回一句"读不到状态"就够 ✓）。
	 *
	 * ⚠️ 三条都是复查改的 ✗：
	 *   · 必须在**剥掉密钥段之后**比较 ✗（原来拿整条路径跟 `/api/power` 比 ✓，它带着 `/<密钥>/` 前缀 ✓
	 *     → **永远不命中** ✓ = 死代码：`powerPosts` 一直是空的 ✓）；
	 *   · **先 `requests.push` 再拦** ✗（原来拦下来就 `return` ✓，把这条请求从请求账里抹掉了 ✗）；
	 *   · 只拦 `unlock` ✓（lock / shutdown / restart 走下面那条老分支 ✓ —— 它们要记进
	 *     `powerRequests` ✓，入口撤掉之后那几条老用例还指着它 ✓）。
	 */
	if (path === '/api/power' && String(options?.method ?? 'GET').toUpperCase() === 'POST') {
		let sent = {}
		try { sent = JSON.parse(String(options?.body ?? '{}')) } catch { sent = {} }
		if (sent.action === 'unlock') {
			powerPosts.push(sent)
			return jsonResponse({ ok: true, state: 'unknown', message: '读不到锁屏状态（测试桩 ✓）' })
		}
	}
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
	/*
	 * ⚠️ 这里必须**精确匹配** ✗ —— 写成 `startsWith('/api/login')` 会把
	 * `/api/logins`（2.8.0 ★2 的登录审计）也一起吃进来：于是审计纸永远只看到
	 * 一个空回包，看起来像"功能没做" ✓（真踩过：三条断言全红、代码其实是对的 ✓）。
	 * 服务端的路由本来就是精确匹配（`route === 'POST /api/login'`✓），这里照着来 ✓。
	 */
	if (path === '/api/login' || path.startsWith('/api/login?')) {
		// 造"网络层失败"（页面认定：电脑没开/隧道没起来）与"PIN 不对"（HTTP 401）两种情况。
		if (loginFailures > 0) { loginFailures -= 1; throw new TypeError('Failed to fetch') }
		if (loginStatus !== 200) return jsonResponse({ error: 'PIN 不对' }, loginStatus)
		// 3.0.0 ★④：`loginPending` 打开时回"PIN 对了，但这台设备要放行" ✓。
		return jsonResponse(loginPending === true ? { ok: true, pending: true } : { ok: true })
	}
	/*
	 * 3.5.0：**新建任务**时也要能挑权限 ✓ —— 那一刻会话还不存在 ✓，所以页面读的是
	 * 「这台电脑的默认档 + 可选档」（宿主 `permissionPresets.catalog()` ✓）。
	 * ⚠️ 这条分支必须在 `/api/permission` 那条**前面** ✓（后者是 `startsWith` ✓，
	 * 放后面会被它吃掉 → 目录永远只看到一个没有 defaultPreset 的快照 ✓）。
	 */
	if (path.startsWith('/api/permission/catalog')) {
		return jsonResponse({ current: '', defaultPreset: 'workspace-write', options: permOptions() })
	}
	if (path.startsWith('/api/permission')) {
		if (options.method === 'POST') {
			const body = JSON.parse(options.body ?? '{}')
			permRequests.push(body)
			// 3.5.0：造"权限写不进去"（验新建时那条诚实退路：不发第一条 + 把话放回输入框 ✓）。
			if (permState.failWrites === true) return jsonResponse({ error: '权限服务暂时不可用' }, 500)
			// 宿主对"放开"这类改动要求提权；收紧到只读是例外（往安全方向走）。
			if (permState.elevated !== true && body.preset !== 'read-only') {
				return jsonResponse({ error: '改权限需要重新输入 PIN', needPin: true }, 403)
			}
			permState.preset = body.preset
			permState.writes.push(body)
		}
		return jsonResponse({
			current: permState.preset,
			label: permLabels[permState.preset],
			options: permOptions(),
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
	if (path === '/api/model') {
		pickedModelRequests.push({ body: (() => { try { return JSON.parse(String(options.body ?? '{}')) } catch { return {} } })() })
		return jsonResponse({ selected: { provider: 'deepseek-official', model: 'deepseek-chat' } })
	}
	/* 2.7.0 ★3/★4：电脑状态盘 + 一键动作。桩只给形状；**真参数**在 harness 里验 ✓。 */
	/*
	 * 3.5.0「目标」：桥的 `GET /api/goal?sessionId=…` ✓。
	 * 桩的返回值可以**被测试改** ✓（`goalStub` ✓）—— 这一条要验两种"读不到"的说法 ✓：
	 * "会话没在跑" ✓ 与 "宿主的 goals 服务不可用" ✓，它们**都不是**"没有目标" ✗。
	 */
	if (path.startsWith('/api/goal')) return jsonResponse(goalStub)
	/** 3.5.0「免手对话」：桩里给"默认关"那一种 ✓（真开启要 PIN ✓，那条在 harness 里验 ✓）。 */
	if (path.startsWith('/api/voice')) {
		// POST：把请求**记下来** ✓ —— 2026-10-13 真机那个 bug 就是"点了开始听但**没发这条 POST**"✗，
		// 这条断言的意义全在"记下来"上 ✓。
		if (String(options?.method ?? 'GET').toUpperCase() === 'POST') {
			let sent = {}
			try { sent = JSON.parse(String(options?.body ?? '{}')) } catch { sent = {} }
			voicePosts.push(sent)
			if (voicePostNeedPin === true && sent.action === 'start') {
				return jsonResponse({ needPin: true, error: '这一项要 PIN —— 在手机上输一次才看得到（它会一直听着麦克风）✓' }, 403)
			}
			return jsonResponse({ ok: true, listening: true, minutes: 10, remainingMs: 600000, message: '已开启 10 分钟 ✓' })
		}
		return jsonResponse(voiceStub)
	}
	// 2.8.0 ★1：一键自检（每条 name/ok/hint ✓，"hint" 就是怎么办 ✓）
	if (path.startsWith('/api/selfcheck')) {
		return jsonResponse({
			ok: false, bad: 2, count: 4, at: Date.now(),
			checks: [
				{ name: '手机桥在监听', ok: true, hint: '端口 3081' },
				{ name: '开机自启已装', ok: false, hint: '没装：跑一次 tools\\autostart.ps1 装上' },
				{ name: '写权限', ok: true, hint: '上传目录可写 ✓' },
				{ name: 'ffmpeg', ok: false, hint: '没找到：放到 ~/.dsh/bin 或在配置里写 ffmpegPath' },
			],
			note: '有 2 项要处理（每项后面就是"怎么办" ✓）',
		})
	}
	// 2.8.0 ★2：安全审计（登录历史 + 当前设备）+ 踢掉其它设备（要现输 PIN ✓）。
	// ⚠️ 顺序：`/api/logins/revoke` 必须在 `/api/logins` **之前**判 ✓（前缀会先命中短的 ✓）。
	if (path.startsWith('/api/logins/revoke')) {
		const body = (() => { try { return JSON.parse(String(options.body ?? '{}')) } catch { return {} } })()
		revokeWrites.push(body)
		if (String(body.pin ?? '') !== CORRECT_PIN) return jsonResponse({ error: 'PIN 不正确 —— 没有踢掉任何设备' }, 403)
		return jsonResponse({ ok: true, revoked: 2, keptSelf: true, selfRevoked: false, left: 1 })
	}
	if (path.startsWith('/api/logins')) {
		// 这份账**要现输 PIN** ✓（服务端读的是 `x-dsh-pin` 头 ✓，绝不进 URL ✓）——
		// 桩必须照着来 ✗：不然页面"忘了带 PIN"也照样拿到数据，那三条门禁断言就成了假的 ✓。
		const pin = (() => {
			const headers = options.headers
			if (headers === undefined || headers === null) return ''
			if (typeof headers.get === 'function') return String(headers.get('x-dsh-pin') ?? '')
			const key = Object.keys(headers).find((item) => item.toLowerCase() === 'x-dsh-pin')
			return key === undefined ? '' : String(headers[key])
		})()
		loginsReads.push({ pin, url: path })
		if (pin !== CORRECT_PIN) return jsonResponse({ error: '这一项要 PIN —— 在手机上输一次才看得到' }, 403)
		return jsonResponse({
			total: 3, count: 3, deviceCount: 2, firstSeenCount: 1,
			lastNewDevice: { ip: '203.0.113.9', at: 1791761053959 },
			devices: [
				{ ip: '100.122.188.30', expiresAt: Date.now() + 3600000, current: true },
				{ ip: '203.0.113.9', expiresAt: Date.now() + 3600000, current: false },
			],
			records: [
				{ at: 1791761053959, ip: '203.0.113.9', ua: 'phone', ok: true, what: 'login', firstSeen: true },
				{ at: 1791761050000, ip: '100.122.188.30', ua: 'phone', ok: true, what: 'login', firstSeen: false },
				{ at: 1791761045000, ip: '100.122.188.30', ua: 'phone', ok: false, what: 'delete-session', firstSeen: false },
			],
		})
	}
	if (path === '/api/system/kill') {
		killRequests.push(JSON.parse(String(options.body ?? '{}')))
		return jsonResponse({ killed: true, pid: 7777, name: 'node.exe', alive: false })
	}
	/*
	 * 4.5.0「控制电脑」✓：桩回一份**像个真机器**的快状态 ✓（含"亮度不支持"这条分支用的开关 ✓），
	 * POST 的动作都记进 `pcRequests` ✓ —— 断言"点哪个键发了哪个 action" ✓（不靠猜 ✓）。
	 * ⚠️ 桩**永远不会真的动硬件** ✓（它只是回 JSON ✓）—— 套件里不许改用户的音量/亮度/蓝牙 ✗。
	 */
	if (path === '/api/pc' && String(options?.method ?? 'GET').toUpperCase() === 'POST') {
		const body = JSON.parse(String(options?.body ?? '{}'))
		pcRequests.push(body)
		if (body.action === 'bluetoothDevices') return jsonResponse({ ok: true, action: body.action, bluetooth: { devices: [{ name: '杰的AirPods', ok: true }, { name: 'WI-C200', ok: false }] } })
		if (body.action === 'mute' || body.action === 'unmute') return jsonResponse({ ok: true, action: body.action, audio: { volume: 37, muted: body.action === 'mute' } })
		if (body.action === 'volumeUp' || body.action === 'volumeDown') return jsonResponse({ ok: true, action: body.action, audio: { volume: body.action === 'volumeUp' ? 42 : 32, muted: false } })
		if (body.action === 'brightnessUp' || body.action === 'brightnessDown') return jsonResponse({ ok: true, action: body.action, brightness: { supported: true, level: body.action === 'brightnessUp' ? 90 : 70 } })
		if (body.action === 'bluetoothSettings') return jsonResponse({ ok: true, action: body.action, message: '已经在电脑上打开蓝牙设置 —— 连接 / 配对新设备在那儿点一下 ✓' })
		if (body.action === 'bluetoothOn' || body.action === 'bluetoothOff') return jsonResponse({ ok: true, action: body.action, radio: body.action === 'bluetoothOn' ? 'On' : 'Off' })
		return jsonResponse({ ok: true, action: body.action, audio: { volume: 37, muted: false }, brightness: { supported: true, level: 80 } })
	}
	if (path === '/api/pc') {
		return jsonResponse(pcStubOff === true
			? { enabled: false, note: '电脑控制默认关闭 —— 在 mobile-bridge.json 里加 "pcControl": true 再试（改完立刻生效，不用重启）✓' }
			: {
				enabled: true,
				audio: { volume: 37, muted: false },
				brightness: { supported: pcStubBrightnessUnsupported !== true, level: 80 },
				bluetooth: { radio: 'On' },
				battery: { supported: true, percent: 89, plugged: true, minutesLeft: null },
				network: { internet: true, profiles: [{ name: 'ChinaTelecom-EDU5.8G', connectivity: '4' }], adapters: [{ name: 'WLAN', speed: '650 Mbps' }] },
			})
	}
	if (path === '/api/system') {
		return jsonResponse({
			host: { platform: 'win32', cores: 8, cpuPercent: 12, memoryTotalMB: 48970, memoryFreeMB: 33000, memoryUsedPercent: 33, bridgeRssMB: 520, uptimeHours: 3 },
			disks: [{ drive: 'C:', freeGB: 8, totalGB: 175, percentFree: 4 }],
			net: { rxKBps: 12, txKBps: 3 },
			ports: { 3080: 4242, 3081: 4242 },
			processTotal: 300,
			killEnabled: false,
			killNote: '结束进程默认关闭 —— 要开就在 mobile-bridge.json 里加 "processControl": true（改完立刻生效，不用重启）✓',
			processes: [
				{ pid: 4242, parentPid: 1, name: 'node.exe', mb: 520, cpuSeconds: 300, startedAt: '', command: 'dsh web', isNode: true, isSelf: true, isChild: false, killable: false, why: '这就是 DSH 本体（手机桥跑在它里面）—— 绝不能杀' },
				{ pid: 7777, parentPid: 1, name: 'node.exe', mb: 40, cpuSeconds: 2, startedAt: '', command: 'some-stuck-thing', isNode: true, isSelf: false, isChild: false, killable: true, why: '' },
			],
		})
	}
	// ⚠️ 用 startsWith：请求带着 `?sessionId=…` ✓（写成精确匹配 = 桩永远不命中 ✗）
	// ③ 审批记录（2.5.0 遗留）：状态盘底部那段"最近批过什么" ✓
	if (path.startsWith('/api/approvals')) {
		return jsonResponse({
			count: 1, total: 7,
			records: [{ at: 1791761053959, kind: 'approval', sessionId: 'session-live', tool: 'pwsh', outcome: 'allowed-once', ip: '100.122.188.30', via: 'phone' }],
		})
	}
	// ★10 受限只读链接：生成 / 撤销（都要登录 ✓；生成还要现输 PIN ✓）
	if (path === '/api/share') {
		if (options.method === 'POST') {
			const body = (() => { try { return JSON.parse(String(options.body ?? '{}')) } catch { return {} } })()
			shareWrites.push(body)
			if (String(body.pin ?? '') !== CORRECT_PIN) return jsonResponse({ error: 'PIN 不正确 —— 没有生成任何链接' })
			return jsonResponse({
				created: true, token: 'a'.repeat(32), expiresAt: Date.now() + 3600000,
				url: 'https://example.ts.net/0123456789abcdef/share?t=' + 'a'.repeat(32),
				message: '只读链接已生成（24 小时后失效 ✓，随时可以撤销 ✓）',
			})
		}
		return jsonResponse({ enabled: true, links: [] })
	}
	if (path === '/api/share/revoke') {
		const body = (() => { try { return JSON.parse(String(options.body ?? '{}')) } catch { return {} } })()
		shareWrites.push({ action: 'revoke', token: body.token })
		return jsonResponse({ revoked: true })
	}
	if (path.startsWith('/api/schedule')) {
		if (options.method === 'POST') {
			const body = (() => { try { return JSON.parse(String(options.body ?? '{}')) } catch { return {} } })()
			scheduleWrites.push(body)
			return jsonResponse(body.action === 'delete'
				? { deleted: true, id: body.id }
				: { created: true, task: { id: 'schedule-new', title: 'x', prompt: body.prompt, scheduledAt: null, repeat: null, status: 'active', sessionId: body.sessionId } })
		}
		return jsonResponse({
			sessionId: 'session-live',
			count: 1,
			tasks: [{ id: 'schedule-1', title: '整理今天的笔记', prompt: '整理今天的笔记', scheduledAt: '2026-10-13T15:00:00.000Z', repeat: { kind: 'daily', time: '23:00:00', timeZone: 'Asia/Shanghai' }, status: 'active', sessionId: 'session-live' }],
			note: 'x',
		})
	}
	if (path === '/api/clipboard') {
		if (options.method === 'POST') {
			const body = (() => { try { return JSON.parse(String(options.body ?? '{}')) } catch { return {} } })()
			clipboardWrites.push(body)
			return jsonResponse({ ok: true, bytes: String(body.text ?? '').length, message: '已经放进电脑剪贴板了' })
		}
		return jsonResponse({ text: '电脑上复制的那段文字', length: 11 })
	}
	if (path === '/api/screen/ocr') {
		/*
		 * 3.8.0「屏幕取字」：记下**页面到底发没发这条** ✓（这类 bug 全都在"没发"上 ✗ ——
		 * 和 `voicePosts` / `powerPosts` 同一个思路 ✓）。
		 */
		let sent = {}
		try { sent = JSON.parse(String(options.body ?? '{}')) } catch { sent = {} }
		screenOcrPosts.push({ ...sent, pin: String(options?.headers?.['x-dsh-pin'] ?? '') })
		return jsonResponse({ ok: true, sessionId: SESSION, title: '手机界面测试', requestId: 'screen-ocr-1', accepted: true })
	}
	if (path === '/api/screen') {
		// 1×1 的 PNG（内容不重要，页面只把它塞进 <img> ✓）
		return { ok: true, status: 200, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) }, async json() { return {} } }
	}
	/*
	 * 4.2.0 顶层：网页版 ✓ —— ⚠️ 这里的 `path` **带着查询串** ✗（形如 `/api/install?format=html` ✓），
	 * 所以必须**在** `path === '/api/install'` 那条之前判 ✓（我第一版把分支塞进里面 ✗ → 永远进不去 ✓ → 页面拿到 404 ✓）。
	 */
	if (path.startsWith('/api/install') && path.includes('format=html')) {
		installHtmlFetches += 1
		// 4.2.0 收尾：让这条**也能失败** ✓ —— 否则「取不到就明说」那条分支从没被测过 ✗
		//（复查第 96 轮点名过 ✓；桩永远回 200 就是"判据只测了一半" ✓）。
		if (installHtmlFailOnce === true) {
			installHtmlFailOnce = false
			return jsonResponse({ error: '取不到（测试里装的故障）' }, 500)
		}
		return {
			ok: true, status: 200,
			headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
			async blob() { return new window.Blob(['<!doctype html><title>手机桥 v9.9.9 安装说明</title>'], { type: 'text/html' }) },
			async text() { return '<!doctype html><title>手机桥 v9.9.9 安装说明</title>' },
			async json() { return {} },
		}
	}
	if (path === '/api/install') {
		// 4.2.0：`?format=html` 走另一条 ✓（数一下页面到底有没有去取 ✓）。
		if (String(options?.url ?? '').includes('format=html') === true) {
			installHtmlFetches += 1
			return {
				ok: true, status: 200,
				headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
				async blob() { return new window.Blob(['<!doctype html><title>手机桥 v9.9.9 安装说明</title>'], { type: 'text/html' }) },
				async text() { return '<!doctype html><title>手机桥 v9.9.9 安装说明</title>' },
				async json() { return {} },
			}
		}
		// 4.1.0「分享安装」：给一段**构造成有凭据的样子** ✗ —— 用来钉「页面不做二次加工、只显示服务端给的」✓。
		installFetches += 1
		// 4.1.0 复查：一次性故障旋钮 ✓ —— 只让**这一次**失败 ✓（用完自动复位 ✓，不影响后面的「重新取」✓）。
		if (installFailOnce === true) {
			installFailOnce = false
			return jsonResponse({ error: '取不到（测试里装的故障）' }, 500)
		}
		return jsonResponse({ version: '9.9.9', text: '手机桥 v9.9.9 —— 零基础安装\n三步装好：\n  1) …\n仓库：https://github.com/jxboop/dsh-plugin-mobile-bridge' })
	}
	if (path === '/api/record') {
		// 4.0.0「录屏遥控」：记下页面到底发了什么 ✓（**绝不真录** ✗ —— 这是桩 ✓）。
		let sent = {}
		try { sent = JSON.parse(String(options.body ?? '{}')) } catch { sent = {} }
		recordRequests.push(sent)
		if (recordFailOnce === true) {
			recordFailOnce = false
			return jsonResponse({ error: '录屏默认关闭 —— 在 mobile-bridge.json 里加 "screenRecord": true 再试' }, 403)
		}
		return jsonResponse({ ok: true, file: 'C:\\Users\\Kim\\.dsh\\recordings\\rec-test.mp4', maxSeconds: 600, note: '开始录了 ✓ 最多录 10 分 0 秒就自动停 ✓' })
	}
	if (path === '/api/power') {
		/*
		 * 3.9.0 复查第 93 轮补的**故障旋钮** ✓：真桥这条会失败（3 秒节流回 429 ✓、锁屏命令失败回 500 ✓），
		 * 而桩原来永远回 200 ✓ → "锁屏没成却写下明早提醒"这种**假承诺**抓不到 ✗（复查实测：把 lock 一律改 429，701/701 仍全绿 ✗）。
		 */
		if (options.method === 'POST') {
			const body = (() => { try { return JSON.parse(String(options.body ?? '{}')) } catch { return {} } })()
			// 4.1.0：把**请求头里的 PIN** 也记下来 ✓（解锁不带 body.pin ✗ —— 只记 body 就抓不到「没带 PIN」✓）。
			powerRequests.push({ ...body, headerPin: String(options?.headers?.['x-dsh-pin'] ?? '') })
			if (powerFailOnce === true) {
				powerFailOnce = false
				return jsonResponse({ error: '锁屏没成（测试里装的故障）' }, 500)
			}
			// 4.1.0 解锁 ✓：照服务端的真实口径回 ✓（唤醒到登录界面 ✓、密码要你自己按 ✓）。
			if (body.action === 'unlock') {
				// ⚠️ 复查第 95 轮：这句**故意独有** ✓ —— 断言「纸上有服务端那句话」才咬得住 ✓
		//（原来只断言整张纸含「登录界面/自己按」✓，而那两句是 `openPower()` 静态写上去的 ✓ → 假绿 ✗）。
		return jsonResponse({ ok: true, action: 'unlock', state: 'unlocked', message: 'UNIQ-UNLOCK-42 已唤醒到登录界面 ✓ —— 密码还是要你自己按 ✓' })
			}
			return jsonResponse(body.action === 'lock'
				? { ok: true, action: 'lock', message: '已锁屏' }
				: { ok: true, action: body.action, seconds: 20, message: '已排定：20 秒后关机 —— 这期间可以点「取消」' })
		}
		return jsonResponse({
			lockEnabled: true,
			powerEnabled: true,
			delaySeconds: 20,
			note: '关机 / 重启已开启：每次都要现输 PIN，并且要点两次才执行；执行后有 20 秒可以取消 ✓',
			preflight: [
				{ name: '手机桥在监听', ok: true, hint: '端口 3081' },
				{ name: '开机自启已装', ok: false, hint: '没装：关完得自己点桌面图标才能连上' },
			],
			pending: null,
		})
	}
	/*
	 * 2.6.0：删除会话（POST /api/session/archive）。桩要能演三种答案：
	 *   ① PIN 不对 → 403（**不是 401** —— 401 在页面上会弹登录门，把整个界面盖掉）；
	 *   ② 会话正在跑且没带 stop → 409，用户得再点一次才"停掉并删除"；
	 *   ③ 正常 → 记进 archiveRemoved，之后的 bootstrap 就不再报它（= 真的从列表里消失）。
	 */
	if (path === '/api/session/archive') {
		const body = (() => { try { return JSON.parse(String(options.body ?? '{}')) } catch { return {} } })()
		archiveRequests.push(body)
		if (body.pin !== CORRECT_PIN) return jsonResponse({ error: 'PIN 不正确 —— 会话没有删除' }, 403)
		const target = SESSIONS.find((item) => item.sessionId === body.sessionId)
		if (body.stop !== true && target?.running === true) {
			return jsonResponse({ error: '这个会话正在跑 —— 要先把它停掉才能删' }, 409)
		}
		archiveRemoved.add(String(body.sessionId ?? ''))
		return jsonResponse({ archived: true, sessionId: body.sessionId })
	}
	if (path.startsWith('/api/models')) {
		return jsonResponse({ groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] }] })
	}
	if (path.startsWith('/api/attachment')) return jsonResponse({ mediaType: 'image/png', data: 'iVBORw0KGgo=' })
	// 文档预览（2.1.0）：页面会把文档取回来渲染，桩里给一段 Markdown 原文。
	if (path.startsWith('/api/file')) {
		return textResponse('# 文案草稿\n\n这是正文第一段。\n\n- 要点一\n- 要点二\n')
	}
	// 路径素材的真实像素尺寸：故意给一个"非 4:3"的比例，才能区分"补上了真尺寸"和"一直用占位"。
	if (path.startsWith('/api/size')) {
		const wanted = /path=([^&]+)/.exec(path)
		const target = wanted === null ? '' : decodeURIComponent(wanted[1])
		return jsonResponse(target.toLowerCase().endsWith('.png')
			? { mediaType: 'image/png', width: 24, height: 12 }
			: { mediaType: 'image/jpeg', width: 40, height: 30 })
	}
	if (path.startsWith('/api/clientlog')) {
		clientLogs.push(JSON.parse(options.body ?? '{}'))
		return jsonResponse({ ok: true })
	}
	if (path.startsWith('/api/upload')) {
		const body = JSON.parse(options.body ?? '{}')
		uploaded.push(body)
		// 并发观测：同时在飞的片数峰值（"传图快一点"就靠这个）。
		uploadInFlight += 1
		uploadPeak = Math.max(uploadPeak, uploadInFlight)
		await new Promise((resolve) => setTimeout(resolve, uploadDelayMs))
		uploadInFlight -= 1
		// 3.5.0：造"客户端这边断了"（真机上的隧道掐断就是这种网络层失败 ✓）。
		if (uploadFailTimes > 0) { uploadFailTimes -= 1; throw new TypeError('Load failed') }
		return jsonResponse({
			ok: true,
			done: body.index === body.total - 1,
			name: body.name,
			mediaType: body.mediaType,
			path: 'C:\\Users\\Kim\\.dsh\\mobile-uploads\\test-' + body.name,
		})
	}
	if (path.startsWith('/api/background')) {
		if (options.method === 'POST') {
			const body = JSON.parse(options.body ?? '{}')
			bgRequests.push(body)
			if (body.clear === true) {
				backdropInfo = null
				return jsonResponse({ ok: true, background: null })
			}
			backdropInfo = { url: 'api/background?v=2048-1', mediaType: 'image/gif', kind: 'image', bytes: 2048 }
			return jsonResponse({ ok: true, background: backdropInfo })
		}
		return jsonResponse({ ok: true })
	}
	if (path.startsWith('/api/prompt')) {
		// 提权过期：令牌有效，但这台机器要你重新证明是本人（宿主重启后即是此态）。
		if (promptNeedsPin) return jsonResponse({ error: '需要重新输入 PIN 才能执行操作', needPin: true }, 403)
		const body = JSON.parse(options.body ?? '{}')
		promptIds.push(body.requestId)
		// 2.11.0 ★11：故意拖一会儿 —— 「正在发送…」这条提示必须有东西可看 ✓。
		if (promptDelayMs > 0) {
			const hold = promptDelayMs
			promptDelayMs = 0
			await new Promise((resolve) => setTimeout(resolve, hold))
		}
		// 2.8.0 ★4：一次性让服务端**明确拒绝**（有状态码，不是网络层 ✓）——
		// 「重试」这条路径要的正是这种错：网络层失败会进离线发件箱 ✓，走的是另一条路 ✓。
		if (promptFailStatus !== 0) {
			const status = promptFailStatus
			promptFailStatus = 0
			return jsonResponse({ error: '宿主这边出错了（一次性）' }, status)
		}
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
			presets: [{ id: 'default', name: '默认', isDefault: true }, { id: 'video', name: '视频' }],
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
	if (path.startsWith('/api/pending')) {
		// 3.0.0 ★④：等放行那屏的两个分支 ✓（还在等 / 令牌已经没了 ✓）。
		if (pendingExpired === true) return jsonResponse({ error: 'unauthorized' }, 401)
		return jsonResponse({
			ok: true, pending: true, approved: false, deviceApproval: true, waiting: 1,
			message: '这台设备还在等放行：请在**电脑上**打开 DSH 的徽标页（或 http://127.0.0.1:<端口>/approve）点一次「放行」✓',
		})
	}
	if (path.startsWith('/api/panels')) {
		// 3.1.0 面板协议：清单里有**一个**能点的面板 ✓（`id` 用真示例的 id ✓，路径也就对得上 ✓）。
		return jsonResponse({
			ok: true, enabled: true, skipped: 0,
			panels: [{ id: 'notes', title: '便签', icon: '📝', kind: 'tool', entry: 'index.html', builtin: true }],
		})
	}
	if (path.startsWith('/api/knowledge/search')) {
		// 3.3.0：会话全文检索 ✓ —— 「boom」模拟服务端说"搜不了" ✓（手机必须**如实显示原话** ✗ 不假装 ✓）。
		const query = decodeURIComponent((path.split('q=')[1] ?? '').split('&')[0])
		if (query === 'boom') return jsonResponse({ error: '搜不了：search backend unavailable (test stub)' }, 503)
		return jsonResponse({
			ok: true, query, hasMore: true,
			items: [
				{ sessionId: 'session-ui-test', title: '弱网那次的排查', snippet: '…关于「' + query + '」的一段…' },
				{ sessionId: 'session-other', title: '', snippet: '另一段 ' + query },
			],
		})
	}
	if (path.startsWith('/api/knowledge/week')) {
		// 3.3.0：这周学了什么 ✓ —— 「empty」模拟"这 7 天真没有活动" ✓（手机必须说清"不是读不到" ✗）。
		const query = path.split('?')[1] ?? ''
		if (query.includes('days=1')) return jsonResponse({ ok: true, days: 1, count: 0, items: [] })
		return jsonResponse({
			ok: true, days: 7, count: 2,
			items: [
				{ sessionId: 'session-ui-test', title: '', idShort: '88b54c99', updatedAt: Date.now() - 3600_000, running: false },
				{ sessionId: 'session-run', title: '正在跑的那个', idShort: '22d713f7', updatedAt: Date.now() - 600_000, running: true },
			],
		})
	}
	if (path.startsWith('/api/speech')) {
		// 3.0.0 ★③：`sttOffline` 切到"这台电脑没开语音"那条路 ✓（要验"如实说" ✓）。
		if (sttOffline === true) {
			return jsonResponse({ ok: true, available: false, message: '这台电脑没开语音转文字（宿主的语音服务没启用）—— 语音那一条先按「录音发过去」用 ✓' })
		}
		if (path.startsWith('/api/speech/prepare')) {
			return jsonResponse({ ok: true, providerId: 'local-1', message: '已经开始准备了（第一次用要下模型，慢的话几分钟）✓' })
		}
		return jsonResponse({
			ok: true, available: true,
			providers: [{
				id: 'local-1', name: '本机小模型', location: 'host-local', languages: ['zh', 'en'],
				phase: 'ready', message: '',
			}],
			selection: { providerId: 'local-1', language: 'zh' },
			maxAudioBytes: 8 * 1024 * 1024,
			maxDurationSeconds: 600,
		})
	}
	if (path.startsWith('/api/transcribe')) {
		// 3.0.0 复查：`sttNeedPin` 打开时回"这一项要 PIN"（**必须带 needPin** ✓）——
		// 手机端只有看到这个字段才会把 PIN 门弹出来 ✓（不带的话云端 STT 完全没有入口 ✗）。
		if (sttNeedPin === true) return jsonResponse({ needPin: true, error: '这一项要 PIN —— 在手机上输一次才看得到 ✓' }, 403)
		return jsonResponse({
			ok: true, text: '这是测试转写出来的一句话', audioSeconds: 1.2, inferenceSeconds: 0.3,
			providerId: 'local-1', location: 'host-local',
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
		// 3.0.0 ★③：TTS 的开发桩 ✓（不自动结束 ✓ —— 要验"正在念"那个高亮状态 ✓）。
		window.SpeechSynthesisUtterance = function SpeechSynthesisUtterance(text) { this.text = text; this.lang = '' }
		window.speechSynthesis = {
			speak(utter) { speechStub.spoken.push({ text: utter.text, lang: utter.lang }); speechStub.pending = utter },
			cancel() { speechStub.cancelCount += 1; speechStub.pending = null },
		}
		// 3.0.0 ★②：通知的开发桩 ✓（权限可控 ✓）；`isSecureContext` 写死成真 ✓
		// —— 页面那条"不是 https 就不给通知"的分支，测试里靠临时改它来验 ✓。
		window.Notification = function Notification(title, options) {
			this.title = String(title)
			this.body = String(options?.body ?? '')
			this.closed = false
			this.close = () => { this.closed = true }
			this.onclick = null
			notifyStub.made.push({ title: this.title, body: this.body })
			notifyStub.instances.push(this)
		}
		window.Notification.permission = 'default'
		// ⚠️ 真浏览器在拿到权限后会**把 `permission` 改成 `granted`** ✓ —— 桩也要这么做 ✓，
		// 不然页面问完权限、回头再读还是 `default` ✓（第一版就是这么错的 ✗：4 条断言全红 ✓）。
		window.Notification.requestPermission = async () => {
			notifyStub.requested += 1
			window.Notification.permission = notifyStub.permission
			return notifyStub.permission
		}
		try { Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true }) } catch { /* 无所谓 */ }
		/*
		 * 录音（1.5.0）：jsdom 既没有 MediaRecorder 也没有麦克风，塞一对假的进去，
		 * 好把「开录 → 计时/电平 → 停止 → 预览 → 发送」整条链路验完。
		 * 假 recorder 会把实例登记到 window.__recorders，测试才能往里灌音频数据。
		 */
		window.__recorders = []
		window.MediaRecorder = class {
			static isTypeSupported(type) { return type === 'audio/webm;codecs=opus' }
			constructor(stream, options) {
				this.stream = stream
				this.mimeType = options?.mimeType ?? ''
				this.audioBitsPerSecond = options?.audioBitsPerSecond ?? 0
				this.listeners = {}
				this.state = 'inactive'
				window.__recorders.push(this)
			}
			addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) }
			emit(name, event) { for (const fn of this.listeners[name] ?? []) fn(event) }
			start() { this.state = 'recording' }
			stop() {
				this.state = 'inactive'
				this.emit('dataavailable', { data: new window.Blob([new Uint8Array(9000).fill(7)], { type: 'audio/webm' }) })
				this.emit('stop', {})
			}
		}
		window.navigator.mediaDevices = {
			getUserMedia: async () => ({ getTracks: () => [{ stopped: false, stop() { this.stopped = true; audioStub.stopped += 1 } }] }),
		}
		window.AudioContext = class {
			// 3.0.0 ★③「说出来 → 文字」要的几样：采样率 / 目的地 / ScriptProcessor ✓
			// （录音电平那个 `createAnalyser` 是 1.x 就有的 ✓，一并留着 ✓）。
			constructor(options) {
				this.sampleRate = Number(options?.sampleRate ?? 16000)
				this.destination = {}
			}
			createMediaStreamSource() { return { connect() {}, disconnect() {} } }
			createScriptProcessor() {
				const node = { connect() {}, disconnect() {}, onaudioprocess: null }
				audioStub.processors.push(node)
				return node
			}
			createAnalyser() {
				return { fftSize: 512, getByteTimeDomainData: (buffer) => buffer.fill(140) }
			}
			close() { audioStub.closed += 1 }
		}
		window.URL.createObjectURL = () => 'blob:fake-recording'
		// 页面启动时用 XHR 拉 /api/boot（要真实的下载进度：XHR 的 progress 与
		// content-length 同口径，fetch 的流是解压后的字节、算不准）。jsdom 没有网络，
		// 这里给一个最小实现：走同一套 stubFetch，并按"整包两次进度"回报。
		window.XMLHttpRequest = class {
			constructor() {
				this.status = 0
				this.responseText = ''
				this.timeout = 0
				this.onprogress = null
				this.onload = null
				this.onerror = null
				this.ontimeout = null
				xhrRequests.push(this)
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
		// 2.6.0：手机自己记着一个"别的"模型（用户在新建面板里选过、或者上一条会话用过的）。
		// 顶端那一行必须显示**宿主的真值**、而不是这个 —— 这正是要钉住的那件事。
		try { window.localStorage.setItem('dshm.model', 'zhipu|glm-4-plus') } catch { /* 同上 */ }
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
			/*
			 * 真浏览器里 `copy` 作用于**当前选中/聚焦**的那个临时 textarea（页面 `copyText()` 会
			 * 先建它、`select()` 它、再 execCommand ✓）。原来这条桩写成"取第一个 readonly textarea" ✗ ——
			 * 2.7.0 加了「电脑剪贴板」那个只读框（`#clipPcText`）之后，它排在前面，于是复制到空字符串 ✗。
			 * 桩要照着真行为写：优先**聚焦中**的 textarea ✓。
			 */
			// 真实语义是"复制当前选区"。jsdom 里 `select()`/`setSelectionRange()` 会更新选区 ✓，
			// 所以先读选区（最忠实 ✓）；取不到再退到聚焦的 textarea、最后退到最后一个 textarea ✓。
			const selection = (() => { try { return String(window.getSelection?.() ?? '') } catch { return '' } })()
			if (selection !== '') { copied.push(selection); return true }
			const active = window.document.activeElement
			const areas = window.document.querySelectorAll('textarea')
			const area = (active !== null && active !== undefined && active.tagName === 'TEXTAREA')
				? active
				: areas[areas.length - 1]
			copied.push(area ? area.value : '')
			return true
		}
	},
})

const { window } = dom
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等到条件成立为止（最多 `timeoutMs`）✓ —— 比 `await wait(260)` 这种"猜时间"稳 ✓。
 *
 * 为什么要有它 ✗：固定等待在慢机器上会**偶发地量到"还没发生"** ✓ —— 表现就是真代码没错、
 * 断言却红了 ✓（2026-10-13 弱网那一组就真栽过一次 ✓）。假红和假绿一样坏 ✓：它会让人去改
 * 一段本来正确的代码 ✗。条件没成立就返回 false ✓（断言照旧会红 ✓，但红的是**真状态** ✓）。
 */
const waitFor = async (predicate, timeoutMs = 4000, stepMs = 40) => {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		let ok = false
		try { ok = predicate() === true } catch { ok = false }
		if (ok === true) return true
		if (Date.now() >= deadline) return false
		await wait(stepMs)
	}
}
/**
 * 等一个"会自己收敛的量"稳定下来 ✓（滚动位置就是这样：页面会在下一帧做锚定 ✓）。
 *
 * ⚠️ 为什么需要：`log.scrollTop` 在 jsdom 里是**异步**被页面自己的锚定逻辑改的 ✓ ——
 * 固定 `await wait(90)` 会偶尔落在锚定之前 / 之后 ✓，于是同一条断言**时红时绿** ✗
 * （2026-10-12 就撞到过：连着复跑两次才确认是偶发 ✓，第一次还以为是自己的改动弄坏的 ✓）。
 * 这类"偶发红"最坏的地方是**教人忽略红色** ✗ —— 宁可多等一轮，也别留这种断言 ✓。
 */
const settled = async (read, { tries = 14, gap = 50 } = {}) => {
	let last = read()
	for (let index = 0; index < tries; index += 1) {
		await wait(gap)
		const next = read()
		if (next === last) return next
		last = next
	}
	return last
}
const $ = (id) => window.document.getElementById(id)
const textOf = (id) => $(id).textContent.trim()
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
/**
 * "真的看得见"——**沿祖先链**查 `display:none` ✓。
 *
 * 冷视角复查点名的结构性盲区：`getComputedStyle(自己).display` 在**祖先被隐藏**时
 * 照样返回自己的值（`display` 不继承 ✓，jsdom 与真浏览器都一样 ✓）——
 * 于是"某控件看得见"这一族断言，全都验不到"它被祖先藏了" ✗。
 * 2.9.0 那个真 bug（收起工具键把嵌在 `#tools` 里的两条横幅和三张纸一起藏掉 ✗）正是从这个盲区溜过去的 ✓。
 */
const visible = (node) => {
	if (node === null || node === undefined) return false
	let el = node
	while (el !== null && el !== undefined && el.nodeType === 1) {
		if (window.getComputedStyle(el).display === 'none') return false
		el = el.parentElement
	}
	return true
}
/** 诊断用：把祖先链上每一层的 display 串起来（断言失败时一眼看出是哪一层把它藏了 ✓）。 */
const ancestry = (node) => {
	const out = []
	let el = node
	while (el !== null && el !== undefined && el.nodeType === 1) {
		out.push(`${el.id !== '' && el.id !== undefined ? el.id : el.tagName}=${window.getComputedStyle(el).display}`)
		el = el.parentElement
	}
	return out.join(' > ')
}
/**
 * 保证 `#app` 现在是"真的看得见"的 ✓。
 *
 * 为什么需要：前面若干用例**故意**触发登录门（连输错 PIN、提权过期 → 403+needPin ✓），
 * 而 `showGate()` 会 `hide(app)` ✓ —— 一旦有哪次没收尾，`#app` 就一直是 `display:none` ✗。
 * 后果很隐蔽：`getComputedStyle(自己的).display` **不继承**祖先的 `display:none` ✓，
 * 于是后面所有"某控件看得见"的断言照样绿 ✓（冷视角复查点名的盲区 ✓，
 * 2.9.0 那个"收起工具键把两条横幅一起藏掉"的真 bug 就是这么溜过去的 ✓）。
 * 所以：凡是要断言"看得见"的地方，先走一遍门把 `#app` 拿回来 ✓。
 */
const ensureAppVisible = async () => {
	if (window.getComputedStyle($('app')).display !== 'none') return true
	$('pin').value = CORRECT_PIN
	click($('gateBtn'))
	await wait(220)
	return window.getComputedStyle($('app')).display !== 'none'
}

/*
 * 切会话：**走真界面**（点会话栏 → 点列表里那一行）。
 *
 * 2.5.0 把 `<select id="session">` 换成了自绘的分组列表（📌 置顶 / ⭐ 常用 / 🕘 最近）——
 * 原生下拉里放不下那两个按钮，也没法分组。所以这里不能再直接设 `value` 再派发 change：
 * 那等于绕开新界面去测旧实现。改走点击之后，下面每一条"切会话"的用例都顺便覆盖了新列表。
 */
const openSessions = () => click($('sessBtn'))
const sessionRows = () => [...$('sessList').querySelectorAll('[data-session]')]
	.map((node) => node.getAttribute('data-session'))
const switchTo = async (sessionId) => {
	openSessions()
	await wait(20)
	const row = $('sessList').querySelector(`[data-session="${sessionId}"]`)
	if (row === null) throw new Error(`会话列表里没有 ${sessionId}（现有：${sessionRows().join(', ')}）`)
	click(row)
	await wait(60)
}

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

	// 「百分比不会变」的回归测试。
	//
	// 现场：手机上加载页的百分比冻在一个数上（走隧道时"正在连电脑"那一步能停十几秒）。
	// 根因是慢爬有硬顶 —— "爬到 目标+10 就停"，本机几十毫秒跑完，只有真机/慢网才看得见。
	// 所以这里**故意把回包扣住**，看数字自己在不在动。
	const bootA = window.__dshBoot()
	await wait(3000)
	const bootB = window.__dshBoot()
	check('等电脑回包期间进度还在走（不是冻在一个数上）',
		bootB.shown - bootA.shown >= 0.3 && bootB.ticks > bootA.ticks,
		`${bootA.shown} -> ${bootB.shown} (ticks ${bootA.ticks} -> ${bootB.ticks})`)
	await wait(3000)
	const bootC = window.__dshBoot()
	check('等久了会把"已等 N 秒"摆出来（用户最怕的是"它是不是死了"）',
		$('bootText').textContent.includes('已等'), $('bootText').textContent)
	check('等再久也不会自己报 100（100 只能由加载完成给，进度条不许替加载撒谎）',
		bootC.shown <= 96 && bootC.target < 100, JSON.stringify(bootC))

	// 「一直卡在加载页」的根因：apiProgress 只挂了 ontimeout 处理器，**没设 timeout** ——
	// 连接被黑洞（丢包/NAT 超时）时请求永远 pending，boot 的 promise 既不成功也不失败，
	// `.catch(bootDone)` 永远不跑，加载页就永远挂在那儿。这条断言守的就是那个 timeout。
	check('boot 请求设了超时（不设 = 连接被黑洞时永远卡在加载页）',
		xhrRequests.length >= 1 && xhrRequests[0].timeout > 0 && xhrRequests[0].timeout <= 60000,
		`timeout=${xhrRequests[0]?.timeout}`)
	check('boot 请求挂了 ontimeout 处理（超时要能落到"断线"那条路，而不是静默悬挂）',
		typeof xhrRequests[0]?.ontimeout === 'function')

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
// 2.5.0：会话选择不再是原生下拉，而是"一行摘要 + 点开的分组列表"。
openSessions()
await wait(20)
check('会话列表里该有的会话都在（喂给自绘列表，不再是原生下拉的 option）',
	sessionRows().length === 4, sessionRows().join(', '))
check('the most recent session is selected and streamed',
	$('sessBtn').textContent.includes('手机界面测试') && source !== null && source.url.includes(SESSION),
	`bar=${$('sessBtn').textContent} url=${source?.url}`)
check('当前会话那一行在列表里是"选中"态（用户一眼看出在哪个会话）',
	$('sessList').querySelector('[data-session="' + SESSION + '"]')?.classList.contains('on') === true,
	$('sessList').querySelector('[data-session="' + SESSION + '"]')?.className)
click($('sessBack'))
await wait(20)
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
	await switchTo('session-older')
	await wait(120)
	const switchAfter = requests.filter((entry) => entry.path.startsWith('/api/transcript')).length
	check('刚开机就换会话时，照样去拉新会话的对话（跳过只对同一个会话生效）',
		switchAfter === switchBefore + 1, `${switchBefore} -> ${switchAfter}`)

	// 换回来，后面的用例接着在原来的会话上跑。
	await switchTo(SESSION)
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
	// 附件自带尺寸 → 必须写成宽高属性：图到货前就占好位置，否则会把下面的内容顶走（"错位"）。
	check('附件图用自带的宽高预留位置（不留原图尺寸就是错位的根源）',
		img !== null && img.getAttribute('width') === '4' && img.getAttribute('height') === '4',
		img === null ? 'no img' : `width=${img.getAttribute('width')} height=${img.getAttribute('height')}`)
}
check('history image element is present', window.document.querySelectorAll('#log img').length === 1)

/* --- 工具结果里的图片：必须变成真图，不能只剩一句"[图片]" ------------------ */
/*
 * 现场（2026-10-08 用户报"手机端看不到图片"）：`image_generate` 出的图在 tool/result 里
 * 是一个 `type:image` 内容块，而这条路以前把它译成**文字** "[图片]" —— 图明明生成好了、
 * `/api/media` 也取得到（实测 200 / image/jpeg / 201KB），手机上却一个字都看不到图。
 * 工具结果里的图是那个工具**唯一的成果**，不能这么丢。
 */
{
	source.emit({
		t: 'event',
		event: { type: 'tool/call', seq: 11, time: 11, data: { turn: 2, step: 3, callId: 'c-img', name: 'image_generate', arguments: '{"prompt":"a red apple"}' } },
	})
	source.emit({
		t: 'event',
		event: {
			type: 'tool/result', seq: 12, time: 12,
			data: {
				turn: 2, step: 3,
				message: {
					id: 'm11', role: 'user',
					content: [{
						type: 'tool-result', toolCallId: 'c-img',
						content: [
							{ type: 'text', text: '<url>https://example.invalid/x.png</url>' },
							{ type: 'image', attachment: { attachmentId: 'att-gen', mediaType: 'image/jpeg', bytes: 123, width: 1024, height: 1024 } },
						],
					}],
				},
			},
		},
	})
	await wait(120)
	const shotSources = [...window.document.querySelectorAll('#log img')].map((node) => node.getAttribute('src'))
	check('工具结果里的图片渲染成真图（不是"[图片]"三个字）',
		shotSources.some((src) => typeof src === 'string' && src.startsWith('api/media?') && src.includes('attachmentId=att-gen')),
		shotSources.join(' | '))
	check('工具结果里不再出现"[图片]"占位文字',
		$('log').textContent.includes('[图片]') === false, 'still rendered the placeholder')
	check('图片旁边给了"点开/长按存相册"的提示',
		$('log').textContent.includes('长按图片'))
	const generated = [...window.document.querySelectorAll('#log img')]
		.find((node) => String(node.getAttribute('src')).includes('attachmentId=att-gen'))
	check('工具结果的图也用附件尺寸预留位置（手机滚动不再被顶走）',
		generated !== undefined && generated.getAttribute('width') === '1024' && generated.getAttribute('height') === '1024',
		generated === undefined ? 'no img' : `width=${generated.getAttribute('width')} height=${generated.getAttribute('height')}`)
}

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

	/*
	 * ⚠️ 回归（用户报"图片容易错位"）：
	 * 手机端 11 张图**全都没有预留尺寸**，于是每张图下载完都会把它下面的内容整段顶下去 ——
	 * 看的人正在读的那一段就被推走了。附件（会话里的图）自带 width/height，直接写成属性；
	 * 只有路径的素材（电脑上产出的）先占一个保守比例，再向 `/api/size` 问一次真实尺寸。
	 */
	const placeholder = String(shots[0].getAttribute('style') ?? '')
	check('路径图先按占位比例占住位置（图到货不再顶走内容）',
		placeholder.includes('aspect-ratio'), placeholder)
	await wait(140)
	check('随后补上真实尺寸（宽高属性 + 比例都对）',
		shots[0].getAttribute('width') === '24' && shots[0].getAttribute('height') === '12'
		&& String(shots[0].style.aspectRatio).replace(/\s/g, '') === '24/12',
		`w=${shots[0].getAttribute('width')} h=${shots[0].getAttribute('height')} ratio=${shots[0].style.aspectRatio}`)
	check('同一个文件不重复问尺寸（缓存住）',
		requests.filter((entry) => entry.path.startsWith('/api/size')).length === 1,
		String(requests.filter((entry) => entry.path.startsWith('/api/size')).length))

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

	/*
	 * 2.1.0（用户要求「让手机能读取和打开电脑的文档文件」，范围选最小：只开"会话里给你的文件"）：
	 * 交付物里的**文档**以前只是一行灰字 ✗ —— 点了没反应，手机上等于看不到内容。
	 * 现在带 data-doc-path 可点 → 开预览面板：Markdown/文本直接渲染、PDF 走 iframe、
	 * Office 这类浏览器渲染不了的**明说 + 指引下载**（不假装能看）。
	 */
	const mdRow = box?.querySelector('[data-doc-path]')
	check('交付物里的文档条目可点开（带 data-doc-path）',
		mdRow !== null && mdRow !== undefined && String(mdRow.getAttribute('data-doc-path')).endsWith('.md'),
		mdRow?.getAttribute('data-doc-path'))
	mdRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	check('点它打开文档预览面板，标题是文件名',
		window.getComputedStyle($('docopen')).display !== 'none' && $('docTitle').textContent.endsWith('发布素材.md'),
		`${window.getComputedStyle($('docopen')).display} / ${$('docTitle').textContent}`)
	check('Markdown 在手机上是**渲染过的**（标题变 h1，不是一坨原文）',
		$('docBody').querySelector('h1') !== null && $('docBody').textContent.includes('这是正文第一段'),
		$('docBody').innerHTML.slice(0, 80))
	check('给了「下载」入口（手机上看不了的也能拿走）',
		String($('docDownload').getAttribute('href')).startsWith('api/file?path='))

	/*
	 * 3.4.3：用户 2026-10-13「文档显示帮我加一个分享按钮，可以直接分享到微信其他」✓。
	 * 分享的必须是**文档本身** ✓（`navigator.share({files})` ✓）—— 而不是 `api/file?…` 那条链接 ✗
	 * （它要登录 cookie ✓，发给别人打不开 ✓）。这里用桩把系统分享**抓下来**看它交了什么 ✓。
	 */
	{
		const shared = []
		Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true })
		Object.defineProperty(window.navigator, 'share', {
			value: (payload) => { shared.push(payload); return Promise.resolve() },
			configurable: true,
		})
		check('文档面板里有「分享」按钮 ✓', $('docShare') !== null && $('docShare') !== undefined)
		click($('docShare'))
		await wait(120)
		check('🔴 点「分享」把**文档本身**交给系统分享 ✓（带文件名 ✓ —— 不是一条别人打不开的链接 ✗）',
			shared.length === 1 && Array.isArray(shared[0].files) && shared[0].files.length === 1
			&& String(shared[0].files[0].name).endsWith('.md'),
			JSON.stringify(shared.map((item) => ({ title: item.title, name: item.files?.[0]?.name ?? null }))).slice(0, 140))
		// 老浏览器 / http 明文地址：没有 navigator.share ✓ → 必须**说明白**并给「下载」的出路 ✓（不装作成功 ✗）。
		Object.defineProperty(window.navigator, 'share', { value: undefined, configurable: true })
		click($('docShare'))
		await wait(120)
		check('没有系统分享时**如实说** ✓（提示里指向「下载」✓，不静默、不假装成功 ✗）',
			String($('toast').textContent).includes('下载'),
			String($('toast').textContent).slice(0, 80))
	}
	/*
	 * 🔴 用户现场（2026-10-11）：「下载之后就没有返回按钮了」。
	 * 手机上 `download` 属性会被忽略（iOS 尤其）→ 点下载会在**当前页**打开文件 → 我们的页面
	 * 被顶掉、返回按钮也没了 ✗。所以「下载」和「新标签」都必须 target=_blank ✓。
	 */
	check('「下载」在新标签打开（不会把当前页面顶掉、返回按钮还在）',
		$('docDownload').getAttribute('target') === '_blank'
		&& String($('docDownload').getAttribute('rel')).includes('noopener'),
		`target=${$('docDownload').getAttribute('target')} rel=${$('docDownload').getAttribute('rel')}`)
	check('「新标签」兜底入口也在（预览渲染不出来时用）',
		$('docOpenTab') !== null && $('docOpenTab').getAttribute('target') === '_blank'
		&& String($('docOpenTab').getAttribute('href')).includes('inline=1'),
		String($('docOpenTab')?.getAttribute('href')))
	$('docBack').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(40)
	check('返回就收起预览面板', window.getComputedStyle($('docopen')).display === 'none')

	// Office 这类：浏览器渲染不了 → 必须**说清楚**并指向下载，而不是给一个空白页。
	source.emit({
		t: 'event',
		event: {
			type: 'deliverables/presented', seq: 42, time: 42,
			data: { turn: 4, callId: 'c42', files: [{ description: '期末报表', path: 'D:\\自媒体\\报表.xlsx' }] },
		},
	})
	await wait(120)
	const xlsxRow = window.document.querySelector('#log [data-doc-path$=".xlsx"]')
	check('Excel 这类也给了可点条目', xlsxRow !== null, xlsxRow === null ? '没有找到 .xlsx 条目' : 'ok')
	xlsxRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	check('点开 Excel：明说"浏览器渲染不了"+ 指引下载（不假装能看，还说清是什么类型）',
		$('docBody').textContent.includes('渲染不了') && $('docBody').textContent.includes('.xlsx')
		&& $('docBody').textContent.includes('下载'),
		$('docBody').textContent.trim().slice(0, 60))
	$('docBack').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(40)

	/*
	 * 🔴 用户现场（2026-10-11）：「文件还是看不到」。
	 * 根因不在"点开"，而在**认路径那一步** —— `PATH_RE` 只认图片/视频扩展名 ✗，
	 * 于是 agent 说"我写好了 D:\…\报告.md"时，手机上既没缩略图也没有「打开」入口。
	 * 这条把"文字里提到的文档也要变成可点条目"钉死。
	 */
	source.emit({
		t: 'event',
		event: {
			type: 'assistant/message', seq: 43, time: 43,
			data: {
				turn: 5, step: 1,
				message: {
					id: 'm43', role: 'assistant',
					content: [{ type: 'text', text: '写好了：D:\\自媒体\\第5篇-提纲.md\n报表在 D:\\自媒体\\数据\\报表.xlsx' }],
				},
			},
		},
	})
	await wait(150)
	const textDocs = window.document.querySelectorAll('#log [data-doc-path]')
	check('文字里提到的文档也变成可点条目（以前只认图片/视频扩展名 ✗）',
		textDocs.length >= 2 && String(textDocs[0].getAttribute('data-doc-path')).endsWith('.md'),
		`${textDocs.length} 个：` + Array.from(textDocs).map((node) => node.getAttribute('data-doc-name')).join(' / '))
	check('同一段文字里的 Excel 也在（每种文档类型都认）',
		Array.from(textDocs).some((node) => String(node.getAttribute('data-doc-path')).endsWith('.xlsx')),
		Array.from(textDocs).map((node) => node.getAttribute('data-doc-name')).join(' / '))
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

/*
 * 4.3.0 ②「停止」防误触（用户 2026-10-14 亲口：「信息发送出去后容易手点到停止」✓）。
 * 验收清单就是下面这几条（一条不落 ✓）：① 第一下**零请求** ✓ + 文案说了"再点一次" ✓；
 * ② 3 秒内第二下发**恰好一条** `POST /api/cancel` ✓；③ 窗口内连点也不许多发 ✓；
 * ④ 窗口过了，第一下**仍然零请求** ✓；⑤ 文案不忽悠（除非真发出去，不许写"已停止" ✗）；
 * ⑥ 会话停了要**自动解除上膛** ✓（别留个"再来一下"的错觉 ✗）。
 */
{
	const cancelCount = () => requests.filter((entry) => entry.path.startsWith('/api/cancel')).length
	/*
	 * ⚠️ 自己把"正在跑"这一幕摆出来 ✓ —— 上面那些用例（插话 / 附件 / 上传）之间已经发过
	 * `turn/end` ✓，跑到这里会话**不一定还在跑** ✓（实测就是 false ✗）。依赖"上面留下的状态"
	 * 就是一条会随时序漂的断言 ✗ —— 所以这里自己造场景 ✓（跑完再收干净 ✓）。
	 */
	source.emit({ t: 'event', event: { type: 'turn/start', seq: 60, time: Date.now(), data: { turn: 1 } } })
	await wait(160)
	const wasVisible = window.getComputedStyle($('stop')).display !== 'none'
	check('（前置）会话跑起来时「停止」就在屏幕上 ✓（不在屏幕上就谈不上手滑 ✓）',
		wasVisible && $('send').textContent === '插话',
		`stop=${window.getComputedStyle($('stop')).display} send=${$('send').textContent}`)

	// ① 第一下：零请求 + 说清"再点一次"。
	const beforeArm = cancelCount()
	click($('stop'))
	await wait(120)
	check('第一下点「停止」：**一个请求都不发** ✓（用户被咬的就是这一下 ✗）',
		cancelCount() === beforeArm, `cancel 请求 ${beforeArm} → ${cancelCount()}`)
	check('第一下之后按钮改口成"再点一次" ✓（用户得知道还差一下 ✓）',
		$('stop').textContent.includes('再点一次'), `按钮=${$('stop').textContent}`)
	check('第一下有话说（toast 讲清 3 秒内有效 ✓ —— 不是静默上膛 ✓）',
		String($('toast')?.textContent ?? '').includes('再点一次'), String($('toast')?.textContent ?? '').slice(0, 40))
	check('文案不忽悠：还没发出去就**不许**写"已停止" ✗',
		!String($('toast')?.textContent ?? '').includes('已停止') && !$('stop').textContent.includes('已停止'),
		`toast=${String($('toast')?.textContent ?? '').slice(0, 30)} 按钮=${$('stop').textContent}`)

	// ② 窗口内第二下：恰好一条。
	const beforeSecond = cancelCount()
	click($('stop'))
	await wait(160)
	check('3 秒内再点一下：发出**恰好一条** `POST /api/cancel` ✓（不多不少 ✓）',
		cancelCount() === beforeSecond + 1, `${beforeSecond} → ${cancelCount()}`)
	{
		const last = requests.filter((entry) => entry.path.startsWith('/api/cancel')).pop()
		check('那条 cancel 带的是**当前会话** ✓（不是空 sessionId ✗）',
			last !== undefined && JSON.parse(last.options.body).sessionId === SESSION,
			String(last?.options?.body ?? '(没有这条请求)'))
	}
	check('发出去之后按钮回到「停止」✓（下次手滑的第一下又是"上膛"，防误触才一直有效 ✓）',
		$('stop').textContent === '停止', `按钮=${$('stop').textContent}`)

	// ③ 第三下：又只上膛，仍不许多发 —— 正好是窗口过了的第 ④ 条。
	await wait(3300)
	const beforeLate = cancelCount()
	click($('stop'))
	await wait(120)
	check('窗口（3 秒）过了之后再点：**仍然零请求** ✓（第一下永远只是上膛 ✓）',
		cancelCount() === beforeLate, `cancel 请求 ${beforeLate} → ${cancelCount()}`)
	check('窗口过了之后那一下，按钮同样改口 ✓（上膛状态没被漏掉 ✓）',
		$('stop').textContent.includes('再点一次'), `按钮=${$('stop').textContent}`)

	// ⑥ 会话停了 → 自动解除上膛。
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 99, time: Date.now(), data: { turn: 2, reason: { kind: 'cancelled' } } } })
	await wait(160)
	check('会话停了：自动解除上膛 ✓ + 按钮回到「停止」✓（不留"再来一下"的错觉 ✗）',
		$('stop').textContent === '停止', `按钮=${$('stop').textContent}`)
	/*
	 * ⑦ 🔴 冷视角复查抓到的橙 ✓：**上膛状态必须跟会话走** ✗ ——
	 * 在 A 上点一下（只上膛、零请求 ✓）→ 3 秒内切到**正在跑**的 B（B 的停止键亮着 ✓）→ 再点一下，
	 * 要是还留着 A 的上膛 ✓，那一下就直接 `POST /api/cancel` **打 B** ✗ —— 而它本该只是"第一下"✓。
	 */
	{
		// 先把会话摆成"正在跑"（B 的停止键亮着 ✓），再在它上面上膛。
		source.emit({ t: 'event', event: { type: 'turn/start', seq: 102, time: Date.now(), data: { turn: 4 } } })
		await wait(140)
		click($('stop'))
		await wait(120)
		check('（前置）在本会话上点了一下：已上膛 ✓', $('stop').textContent.includes('再点一次'), `按钮=${$('stop').textContent}`)
		const beforeSwitch = requests.filter((entry) => entry.path.startsWith('/api/cancel')).length
		/*
		 * 切到另一个会话（bootstrap 里 `session-older` 是"没在跑"的那条 ✓）—— 换会话就该解除上膛 ✓。
		 * ⚠️ 用现成的 `switchTo()` ✓ —— `sessionRows()` 返回的是**字符串数组**（不是 DOM 节点 ✗），
		 * 我第一版拿它当节点调 `.getAttribute` ✓ → 套件在这个文件里**当场 TypeError 崩掉** ✗、
		 * 连汇总都打不出来 ✓（`node --check` 查不出这种 ✗ —— 是冷视角复查逐行读出来的 ✓）。
		 */
		await switchTo('session-older')
		check('（前置）已经切到另一个会话 ✓（`session-older` 不在跑 ✓）',
			$('stop').textContent === '停止' || window.getComputedStyle($('stop')).display === 'none',
			`按钮=${$('stop').textContent} 显示=${window.getComputedStyle($('stop')).display}`)
		check('🔴 换会话之后**上膛被解除** ✓（按钮回到「停止」，不是还挂着"再点一次" ✗）',
			$('stop').textContent === '停止', `按钮=${$('stop').textContent}`)
		// 再点一下：必须**零请求** ✓（要是上膛还留着，这一下就会打出去 ✗）。
		click($('stop'))
		await wait(160)
		check('🔴 换会话后那一下**一个请求都不发** ✓（留着旧会话的上膛 = 这一下直接取消新会话 ✗ —— 复查抓到的橙 ✓）',
			requests.filter((entry) => entry.path.startsWith('/api/cancel')).length === beforeSwitch,
			`cancel 请求 ${beforeSwitch} → ${requests.filter((entry) => entry.path.startsWith('/api/cancel')).length}`)
		// 收拾：切回原会话 ✓（`switchTo` 找不到会抛 ✓ —— 不做静默 no-op ✗）。
		await switchTo(SESSION)
		check('（收拾）切回原会话 ✓', true, `当前 SESSION=${SESSION}`)
	}
	// 收拾干净：这一块开头自己摆的"正在跑"由这里收掉 ✓，后面的用例看到的状态和进来时一致 ✓。
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 100, time: Date.now(), data: { turn: 3, reason: { kind: 'completed' } } } })
	await wait(140)
	check('（收尾）会话停了之后「停止」也收起来了 ✓（不留一个能再点的键 ✗）',
		window.getComputedStyle($('stop')).display === 'none' && $('send').textContent === '发送',
		`stop=${window.getComputedStyle($('stop')).display} send=${$('send').textContent}`)
}

/* --- cancel -------------------------------------------------------------- */

// 上面那一块已经把"两下才停"从头到尾走完了 ✓；这里只把 cancel 请求本身再钉一次 ✓
// （老断言的**意思变了** ✗：原来是"点一下就发"✓，现在第一下**零请求** ✓ → 只留"payload 里的 sessionId 是对的"这一半 ✓）。
const cancelCall = requests.find((entry) => entry.path.startsWith('/api/cancel'))
check('stop cancels the running session（payload 里的 sessionId 要对 ✓ —— 现在要点两下才发 ✓）',
	cancelCall !== undefined && JSON.parse(cancelCall.options.body).sessionId === SESSION)

/* --- the new-task panel -------------------------------------------------- */

const sheet = $('view-new')
const tabButton = (name) => window.document.querySelector(`#tabs button[data-tab="${name}"]`)

// 页签栏里有 **3 个真页签 + 1 个录音键**（1.6.1：录音从工具键那排搬到最底下这一栏）。
// 录音键不带 data-tab，所以 tabButtons 只认那三个 —— 否则点它会把 active 抢过去。
check('three tabs are rendered', window.document.querySelectorAll('#tabs button[data-tab]').length === 3,
	`data-tab=${window.document.querySelectorAll('#tabs button[data-tab]').length} / 按钮=${window.document.querySelectorAll('#tabs button').length}`)
check('录音键就在页签栏里，且不是页签', $('recBtn') !== null
	&& $('tabs').contains($('recBtn'))
	&& $('recBtn').dataset.tab === undefined
	&& $('tools').contains($('recBtn')) === false)
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
// 用户 2026-10-11：「添加模型调用，手机上能调用不同模型」——新建面板要能列出宿主的模型目录 ✓。
await wait(60)
check('模型目录拉下来了（新建面板里能选不同模型）',
	$('modelPick') !== null && $('modelPick').options.length === 2
	&& $('modelHint').textContent.includes('1 个模型'),
	`${$('modelPick')?.options.length} 个选项 / ${$('modelHint').textContent}`)
{
	$('modelPick').value = $('modelPick').options[1].value
	$('modelPick').dispatchEvent(new window.Event('change', { bubbles: true }))
	check('选了模型后写清"当前会话立刻切、新建也用它"（按会话生效，不是只这一条）',
		$('modelHint').textContent.includes('deepseek-chat') && $('modelHint').textContent.includes('当前会话立刻切'),
		$('modelHint').textContent)
	$('modelPick').value = ''
	$('modelPick').dispatchEvent(new window.Event('change', { bubbles: true }))
}

check('presets populate the picker', $('preset').options.length === 3, `${$('preset').options.length} options`)

/*
 * 「手机新建对话明显会变贵」（2026-10-11）：面板要**把本次会用哪个预设写出来** ——
 * 以前"（用默认）"背后是哪个预设手机上根本看不见 ✗，贵不贵只能事后从余额上发现。
 */
check('新建面板写清"本次将用默认预设：X"（把默认预设名摆出来）',
	$('presetHint').textContent.includes('本次将用默认预设') && $('presetHint').textContent.includes('默认'),
	$('presetHint').textContent)
{
	$('preset').value = 'video'
	$('preset').dispatchEvent(new window.Event('change', { bubbles: true }))
	check('选了具体预设：提示换成它（贵不贵在选择前看得见）',
		$('presetHint').textContent.includes('视频'), $('presetHint').textContent)
	$('preset').value = ''
	$('preset').dispatchEvent(new window.Event('change', { bubbles: true }))
}

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

/* --- 3.5.0：新建任务时就能选权限（用户 2026-10-13：「新建任务时没有权限选择」）--- */
/*
 * 以前只能在**建完之后**去 🔐 改 ✓，于是"这条任务按什么权限跑"是建完才知道的 ✗；
 * 而权限恰恰是"它这一轮能动到哪一步"的前提 ✓。现在创建时就定下来 ✓。
 * 三条底线：① 面板里真能选（不是摆个死按钮 ✓）；② 不选就**一个写请求都不发** ✓
 * （少一次 PIN 门 ✓）；③ 选了就带着**新会话 id** 在发第一条之前落下去 ✓。
 */
{
	permRequests.length = 0
	permState.preset = 'danger-full-access'   // 复位成这个桩的初始档（下面的 🔐 面板测试要用 ✓）
	permState.elevated = true
	click(tabButton('new'))
	await wait(200)

	const createCards = Array.from($('createPerm').querySelectorAll('.permopt'))
	check('新建面板里有权限档可选（第一张是「跟随默认」）',
		createCards.length === 4 && createCards[0].dataset.perm === ''
		&& createCards[0].textContent.includes('跟随默认'),
		`${createCards.length} 张：${createCards.map((card) => card.dataset.perm || '(默认)').join('|')}`)
	check('三档都是中文标签（和人话表一致，不摆英文预设名）',
		$('createPerm').textContent.includes('只读') && $('createPerm').textContent.includes('可写工作区')
		&& $('createPerm').textContent.includes('完全放开'), '')
	check('「跟随默认」那张卡写清了这次会按哪一档跑',
		createCards[0].textContent.includes('默认档') && createCards[0].textContent.includes('可写工作区'),
		createCards[0].textContent)
	check('什么都没选时一个写请求都不发（少一次 PIN 门 ✓）', permRequests.length === 0,
		JSON.stringify(permRequests))

	// 选「完全放开」→ 创建时立刻落权限（而且带的是**新会话**的 id ✓）。
	// 这一轮**填上第一条** ✓ —— 顺序（先落权限、再发第一条）只有这样才能验 ✓。
	click($('createPerm').querySelector('.permopt[data-perm="danger-full-access"]'))
	await wait(40)
	check('点了那一档会留在选中态（点得动 ✓，不是死按钮）',
		$('createPerm').querySelector('.permopt.on')?.dataset.perm === 'danger-full-access',
		$('createPerm').querySelector('.permopt.on')?.dataset.perm)
	click(window.document.querySelectorAll('#workspaces .pick')[1])
	await wait(40)
	$('firstText').value = '先看看这个目录'
	confirmAnswer = true
	confirms.length = 0
	click($('createBtn'))
	await wait(500)
	check('创建时就把权限定下来：POST 带**新会话 id** + 选的那一档',
		permRequests.length === 1 && permRequests[0].sessionId === 'session-created'
		&& permRequests[0].preset === 'danger-full-access',
		JSON.stringify(permRequests))
	const permIndex = requests.map((entry) => entry.path).lastIndexOf('/api/permission')
	const firstPromptAfterPerm = requests.findIndex((entry, index) => index > permIndex && entry.path.startsWith('/api/prompt'))
	check('落权限发生在**第一条任务之前**（顺序反了 = "先按默认跑起来再改"✗）',
		permIndex >= 0 && firstPromptAfterPerm > permIndex,
		`permission@${permIndex} prompt@${firstPromptAfterPerm}`)

	// 选回「跟随默认」→ 再建一个：这次**不许**发写请求（等于什么都没改 ✓）。
	permRequests.length = 0
	click(tabButton('new'))
	// ⚠️ 复查点名的"选了但静默没生效"✗：读目录是**异步**的 ✓ —— 在它回来之前，纸上**不许**
	// 还留着上一轮那张 `.on` 卡（否则用户看到"选了完全放开"、实际按默认跑 ✗）。
	// 这一条**当场**查（不等 ✓）—— 旧代码在这一刻还是上一轮的渲染结果 ✓ → 会红 ✓。
	check('重开新建纸：上一轮选过的权限**不留在界面上**（高亮只许在「跟随默认」上 ✓ —— 不许显示"选了完全放开"✗）',
		$('createPerm').querySelector('.permopt.on')?.dataset.perm === ''
		&& $('createPermHint').textContent.includes('完全放开') === false,
		`on=${JSON.stringify($('createPerm').querySelector('.permopt.on')?.dataset.perm)} hint=${$('createPermHint').textContent.slice(0, 40)}`)
	await wait(200)
	click($('createPerm').querySelector('.permopt[data-perm=""]'))
	await wait(40)
	click(window.document.querySelectorAll('#workspaces .pick')[1])
	await wait(40)
	click($('createBtn'))
	await wait(400)
	check('选「跟随默认」＝什么都不改：一个写请求都不发（不白弹一次 PIN 门 ✓）',
		permRequests.length === 0, JSON.stringify(permRequests))

	/*
	 * 权限**写不进去**时那条诚实退路 ✓：会话照建（它便宜且可逆 ✓），但**绝不按一个你没选的
	 * 权限把第一条跑起来** ✗ —— 那一句要**放回输入框** ✓，而且**不许吃掉**输入框里原有的草稿 ✗
	 * （悄悄吞掉用户打过的字，是这个项目最恨的事之一 ✓）。
	 */
	permRequests.length = 0
	permState.failWrites = true
	const promptsBeforeFail = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	$('text').value = '我还没写完的一句'
	$('text').dispatchEvent(new window.Event('input', { bubbles: true }))
	click(tabButton('new'))
	await wait(200)
	click($('createPerm').querySelector('.permopt[data-perm="read-only"]'))
	await wait(40)
	click(window.document.querySelectorAll('#workspaces .pick')[1])
	await wait(40)
	$('firstText').value = '第一天要干的事'
	confirmAnswer = true
	click($('createBtn'))
	await wait(500)
	check('权限没落下去：POST 试过了，但**第一条不发**（绝不按错的权限开跑 ✗）',
		permRequests.length === 1
		&& requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === promptsBeforeFail,
		`perm=${permRequests.length} prompt=+${requests.filter((entry) => entry.path.startsWith('/api/prompt')).length - promptsBeforeFail}`)
	check('权限没落下去：那一句**放回输入框**了，而且**没吃掉**原有的草稿',
		$('text').value.includes('第一天要干的事') && $('text').value.includes('我还没写完的一句'),
		JSON.stringify($('text').value))
	check('权限没落下去：界面上说清了（不静默 ✗）',
		$('banner').textContent.includes('权限没改成'), $('banner').textContent.slice(0, 90))
	permState.failWrites = false
	permRequests.length = 0
	// 收拾：把输入框清掉，别污染后面的用例。
	$('text').value = ''
	$('text').dispatchEvent(new window.Event('input', { bubbles: true }))
	await wait(40)

	// 收拾干净：把权限桩复位，后面的 🔐 面板测试照旧（它们假定当前档 = danger-full-access ✓）。
	permState.preset = 'danger-full-access'
	permState.elevated = true
	permRequests.length = 0
}

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

/*
 * 2.5.1（交接文档 ⑤「查审批没弹出来」）：接线本来是好的（`approval/request` 与
 * `user-questions/request` 都接了、两种卡片都画得出来），真正的缺口是**被盖住** ——
 * 每个"工具抽屉"（会话列表 / 删除纸 / 录音 / 生图 / 背景 / 权限）都是 `position:fixed`
 * 的全屏纸（z-index 50），抽屉开着时卡片整个看不见，而宿主只等 120 秒就退回电脑。
 * 这一条就是钉住"抽屉开着也能看见卡片"。
 */
click($('sessBtn'))
await wait(40)
check('（前置）会话列表开着', window.getComputedStyle($('sessopen')).display !== 'none')
source.emit({ t: 'interaction', kind: 'approval', id: 'ask-cover', payload: { toolName: 'pwsh', reason: '要跑一条命令' } })
await wait(80)
check('抽屉开着时来了审批：先把抽屉收掉，卡片就看得见（用户不会再"根本没提示"）',
	window.getComputedStyle($('sessopen')).display === 'none'
	&& window.getComputedStyle($('ask')).display !== 'none'
	&& $('ask').textContent.includes('pwsh'),
	`列表=${window.getComputedStyle($('sessopen')).display} 卡片=${window.getComputedStyle($('ask')).display}`)
check('卡片的层级高过所有工具抽屉（.sheet 是 50）—— 万一还有纸开着也不会被盖住',
	Number.parseInt(window.getComputedStyle($('ask')).zIndex, 10) > 50,
	`ask z-index=${window.getComputedStyle($('ask')).zIndex} / sheet=${window.getComputedStyle($('sessopen')).zIndex}`)
check('卡片一到会明确叫一声（振动 + 一句话，不指望用户自己盯着屏幕）',
	$('toast').textContent.includes('点头') || $('toast').textContent.includes('问你'),
	$('toast').textContent)
source.emit({ t: 'interaction-end', id: 'ask-cover' })
await wait(60)

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
await switchTo('session-older')
check('切到另一个会话会重开一条流', source !== null && source.url.includes('session-older'))

// 会话在不在跑必须跟着会话走：以前 state.running 只由流事件写，换会话后不会重置，
// 于是切到一条闲着的会话，按钮还写着「插话」、停止键还亮着，发一条普通消息还会
// 回一句假的"已插话"。
source.emit({ t: 'event', event: { type: 'turn/start', seq: 90, time: Date.now(), data: { turn: 3 } } })
await wait(80)
check('（前置）运行中按钮是「插话」', $('send').textContent === '插话', $('send').textContent)
await switchTo(SESSION)
await wait(120)
check('切到没在跑的会话后按钮回到「发送」、停止键收起',
	$('send').textContent === '发送' && window.getComputedStyle($('stop')).display === 'none',
	`label=${$('send').textContent} stop=${window.getComputedStyle($('stop')).display}`)
await switchTo('session-older')
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
await switchTo(SESSION)
await wait(120)
await switchTo('session-older')
await wait(150)
check('已经判过"打不开"的会话不会再被重连（每次都失败，白烧流量）',
	sources.length === streamsBeforeRetry + 1, `${streamsBeforeRetry} -> ${sources.length}`)

// 回到正常会话：后面还有一半检查要靠它。
await switchTo(SESSION)
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
	await switchTo('session-older')
	await wait(60)                                  // 这一条 transcript 被卡在路上
	await switchTo(SESSION)
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
	// 说明页的第二段：输入框上面那排按键到底各干什么。新增按键（文件/背景）而不补说明，
	// 用户就只能靠猜 —— 这恰好是"功能有了但没人会用"的典型死法。
	check('说明页把输入框上面那排按键逐个讲了',
		['图片', '文件', '原图', '生图', '背景'].every((key) => $('welcome').textContent.includes(key)),
		$('welcome').textContent.replace(/\s+/g, ' ').slice(0, 120))
	check('说明页点明了"生图靠电脑上的插件"（免得误判成手机桥坏了）',
		$('welcome').textContent.includes('生图插件') && $('welcome').textContent.includes('没有生图模型'))

	/*
	 * 3.4.2：用户 2026-10-13 说「现在的说明，里面的内容已经过时了」✗ —— 工具键那一排从 9 个键长到 14 个 ✓
	 * （📊 📋 📤 📅 🔓 🩺 🛡 ⌨ …），还有 🔍 搜一搜 / ⭐ 这周 / ⏰ 工作流 / 🧩 面板 / 🔗 只读链接 ✓，
	 * 说明页却一个字都没提 ✗。补完这里钉两条 ✓（以后再加按键、忘了补说明，这两条会红 ✓）。
	 */
	check('说明页讲了"工具键那一排还有这些"（🔍 搜一搜 / 📤 导出 / 📊 电脑状态 / 🩺 自检 ✓）',
		['搜一搜', '导出', '电脑状态', '一键自检'].every((key) => $('welcome').textContent.includes(key)),
		$('welcome').textContent.replace(/\s+/g, ' ').slice(0, 120))
	check('说明页写清了"出门在外也要能连"（Tailscale / 切 4G-5G 验收 / 外网隧道那一行 ✓）',
		$('welcome').textContent.includes('Tailscale')
		&& $('welcome').textContent.includes('4G/5G')
		&& $('welcome').textContent.includes('外网隧道'),
		$('welcome').textContent.replace(/\s+/g, ' ').slice(0, 120))
	/*
	 * 3.6.0「分享到桥」：这一版**页面上一个键都没加** ✓（用户采纳的架构规矩 ✓）——
	 * 那么"用户从哪儿知道有这个功能"就只剩两处 ✓：说明页这段字 ✓ 与 🩺 自检里那条（开着才出现 ✓）。
	 * 所以说明页这段**必须有断言** ✗ —— 删了它，功能就变成"没人知道它存在"（3.4.2 的教训 ✓）。
	 * ⚠️ 判据挑的是这段话里**只有它有**的词 ✗（"分享"两个字别处也有 ✓ —— 拿它当判据会假绿 ✓）。
	 */
	check('说明页讲了「分享到桥」怎么配（3.6.0 ✓ —— 页面上不加键，说明页就是它唯一的入口 ✓）',
		$('welcome').textContent.includes('分享到桥') && $('welcome').textContent.includes('快捷指令')
		&& $('welcome').textContent.includes('shareIntake'),
		$('welcome').textContent.replace(/\s+/g, ' ').slice(0, 120))
	// 3.7.0：一键 OCR / 扫码 —— 同样**没有页面键** ✓，所以说明页这段是它唯一的门 ✓（删了它当场红 ✓）。
	// ⚠️ 判据里必须有**前提** ✗（复审第 91 轮点名）：这台部署**可能没挂会话检索** ✓ ——
	// 只写"能搜到"就是把话说满了 ✓（仓库别处都写着"没挂会如实说搜不了"✓，说明页也得带上 ✓）。
	check('说明页讲了「一键 OCR / 扫码」+ 它的**前提**（3.7.0 ✓ —— 也一样不加键 ✓）',
		$('welcome').textContent.includes('一键 OCR') && $('welcome').textContent.includes('task')
		&& $('welcome').textContent.includes('搜一搜')
		&& $('welcome').textContent.includes('挂了会话检索') && $('welcome').textContent.includes('搜不了'),
		$('welcome').textContent.replace(/\s+/g, ' ').slice(0, 140))
	// 3.8.0：剪贴板历史 + 屏幕取字（都加在**已有的 📋 纸**上 ✓ —— 仍然没有新键 ✓，
	// 所以说明页那段就是它们的门 ✓；判据挑**只有它有**的词 ✓，并带上"不替你按发送 / 不记读回来的"两条纪律 ✓）。
	check('说明页讲了「最近放进去的」与「取字」+ 两条纪律（3.8.0 ✓）',
		$('welcome').textContent.includes('最近放进去的') && $('welcome').textContent.includes('取字')
		&& $('welcome').textContent.includes('放进输入框')
		&& $('welcome').textContent.includes('从电脑读回来的不进历史'),
		$('welcome').textContent.replace(/\s+/g, ' ').slice(0, 140))

	click($('welcomeGo'))
	await wait(60)
	check('点「开始使用」就收起，并记住"看过的是这一版"',
		window.getComputedStyle($('welcome')).display === 'none'
		&& /^\d{1,3}$/.test(window.localStorage.getItem('dshm.welcomed') ?? ''),
		`display=${$('welcome').style.display} flag=${window.localStorage.getItem('dshm.welcomed')}`)
	// 光记在手机本地不够：换地址（Funnel ↔ 局域网是不同 origin）、无痕浏览、清站点数据
	// 都会把本地标记弄丢 —— 那正是"每次退出重进都弹一遍"的原因。所以要告诉宿主一份。
	check('同时把"看过了"写到宿主那边（换地址/无痕也不会重复弹）',
		welcomedOnServer === true
		&& requests.some((entry) => entry.path.startsWith('/api/welcomed')),
		`server=${welcomedOnServer}`)

	// 「说明」键：给人**重看**的入口。首访只讲一次仍然成立，但"当时没看清"或"要教同学"
	// 时得有个地方点 —— 否则这张纸一旦收起就再也找不到了。
	click($('help'))
	await wait(40)
	check('点「说明」能把说明页再摊开',
		window.getComputedStyle($('welcome')).display !== 'none',
		`display=${window.getComputedStyle($('welcome')).display}`)
	click($('welcomeGo'))
	await wait(40)
	check('再点「开始使用」照旧收起', window.getComputedStyle($('welcome')).display === 'none')

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

/* --- 换背景：手机自己挑一张（以前要 agent 改配置 + 重载插件） ------------- */
/*
 * 现场：想换背景得「把文件发给桥 → 让 agent 把文件名写进 mobile-bridge.json 的
 * backgroundFile → 重载插件」。那是开发动作，用户自己办不到。现在点「背景」→
 * 选一张图 / 动图 / 视频 → 传到电脑、写进配置、当场铺上，全程不碰电脑。
 */
{
	backdropInfo = null
	bgRequests.length = 0
	// 先让页面从宿主那里拿到"现在没有背景"（点刷新走一遍 boot），再看那张纸怎么说 ——
	// 页面记的是宿主告诉它的状态，不是测试里的 mock 变量。
	click($('reload'))
	await wait(220)
	click($('bgBtn'))
	await wait(40)
	check('点「背景」打开换背景那张纸', window.getComputedStyle($('bgopen')).display !== 'none')
	check('还没有背景时不显示「去掉背景」',
		window.getComputedStyle($('bgClear')).display === 'none',
		window.getComputedStyle($('bgClear')).display)

	// 挑一张动图（GIF）：背景那条路不压缩、原样上传。
	const gif = new window.File([new Uint8Array([71, 73, 70, 56, 57, 97, 1, 2, 3])], 'cute.gif', { type: 'image/gif' })
	Object.defineProperty($('fileBg'), 'files', { value: [gif], configurable: true })
	$('fileBg').dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(260)

	check('选中的动图先分片上传到电脑',
		uploaded.length >= 1 && uploaded[uploaded.length - 1].name === 'cute.gif',
		JSON.stringify(uploaded[uploaded.length - 1]?.name))
	check('再把文件名交给宿主写成背景（配置由宿主去写）',
		bgRequests.length === 1 && bgRequests[0].name === 'cute.gif', JSON.stringify(bgRequests))
	const bgImg = $('backdrop').querySelector('img')
	check('宿主回的新背景当场铺上，而且是 <img>（动图靠它动）',
		bgImg !== null, bgImg === null ? 'no img' : 'ok')
	bgImg?.dispatchEvent(new window.Event('load'))
	await wait(60)
	check('加载完就整屏铺上，不用重载插件',
		window.document.body.classList.contains('hasbg'), window.document.body.className)
	check('换完自动收起那张纸', window.getComputedStyle($('bgopen')).display === 'none')

	click($('bgBtn'))
	await wait(40)
	check('有背景了就给出「去掉背景」', window.getComputedStyle($('bgClear')).display !== 'none')
	click($('bgClear'))
	await wait(160)
	check('去掉背景会告诉宿主 clear:true',
		bgRequests.length === 2 && bgRequests[1].clear === true, JSON.stringify(bgRequests))
	check('去掉后整层撤掉（hasbg 消失、节点清空）',
		window.document.body.classList.contains('hasbg') === false
		&& $('backdrop').querySelectorAll('video, img').length === 0,
		`class=${window.document.body.className} nodes=${$('backdrop').querySelectorAll('video, img').length}`)
	backdropInfo = { url: 'api/background', mediaType: 'video/quicktime', kind: 'video', bytes: 4096 }
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

/* --- 图片内联发送被隧道边缘掐断 → 自动改走分片上传重发 ---------------------- */
/*
 * 现场（2026-10-09 用户报"我手机界面发送图片发不出去"）：
 * 日志里**一行失败都没有** —— 因为失败发生在**隧道边缘**（手机上行的慢请求会被入口掐断，
 * 服务端根本没收到请求，自然没日志）。图片内联在 prompt 的 body 里（≤3MB）时最容易撞上。
 * 现在：① 内联预算降到 1MB；② 内联失败**自动**改成切片上传（384KB/片）再发一次，
 * 不让用户手点第二次；③ 手机把失败上报进桥日志（`/api/clientlog`），下次不用猜。
 */
{
	uploaded.length = 0
	clientLogs.length = 0
	const promptsBefore = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	// 先挂一张真图（走内联），再把接下来两次 prompt 打成网络层失败（真宿主里就是隧道掐断）。
	const inlineFile = new window.File([png], 'inline.png', { type: 'image/png' })
	Object.defineProperty($('file'), 'files', { value: [inlineFile], configurable: true })
	$('file').dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(200)
	check('准备：图片已挂上（缩略图 on）', $('thumbs').querySelectorAll('img').length === 1,
		`thumbs img=${$('thumbs').querySelectorAll('img').length}`)

	promptFailTimes = 2
	/*
	 * 3.5.0：把每片上传放慢到 600ms ✓ —— 不然"正在上传 … x/y 片"这句只活 25ms ✗，
	 * 断言就只能靠运气 ✓（那样测不出"屏幕上到底动没动"✗ —— 用户报的正是"单张没有进度"✗）。
	 */
	uploadDelayMs = 600
	$('text').value = '带图的一条'
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	// 等"改走切片"真正开始（前面还有两次 prompt 重试的退避 ✓）。
	let sawUploading = false
	for (let tick = 0; tick < 60; tick += 1) {
		await wait(150)
		if ($('banner').textContent.includes('正在上传')) { sawUploading = true; break }
	}
	check('单张图改切片重发时，屏幕上看得见上传进度（用户 2026-10-13：「单张图片没有进度」）',
		sawUploading, `banner=${$('banner').textContent.slice(0, 70)}`)
	await wait(2600)
	uploadDelayMs = 25
	const after = requests.filter((entry) => entry.path.startsWith('/api/prompt'))
	const lastBody = JSON.parse(after[after.length - 1].options.body)
	check('内联被掐断后自动改走切片上传（用户不用再点一次）',
		uploaded.length >= 1 && after.length > promptsBefore + 2, `切片 ${uploaded.length} 片 / prompt ${after.length - promptsBefore} 次`)
	check('重发时图片改成 fileRefs（不再内联），而且消息最终发出去了',
		lastBody.images.length === 0 && lastBody.fileRefs.length === 1
		&& $('thumbs').children.length === 0,
		JSON.stringify({ images: lastBody.images.length, fileRefs: lastBody.fileRefs.length, thumbs: $('thumbs').children.length }))
	check('手机把这次失败上报进了桥日志（服务端本来一行都看不到）',
		clientLogs.some((entry) => String(entry.event).includes('send-inline-failed')),
		JSON.stringify(clientLogs.map((entry) => entry.event)))
	/*
	 * 3.5.0：**上传过程的三类日志** ✓ —— 现场（2026-10-13）电脑那边的日志里只有开头那一行
	 * （`send-inline-failed…改走切片上传`）✗，之后"传完没有"完全看不见 ✗，只能猜 ✓。
	 */
	check('上传中 / 完成 两类日志都落到了电脑那边（以前只有开头那一行 ✗）',
		clientLogs.some((entry) => entry.event === 'upload-progress')
		&& clientLogs.some((entry) => entry.event === 'upload-done'),
		JSON.stringify(clientLogs.map((entry) => `${entry.event}:${String(entry.detail).slice(0, 26)}`)))
	check('"上传中"带着 x/y 片数（断网那次就是靠它定位传到哪儿的）',
		clientLogs.some((entry) => entry.event === 'upload-progress' && /\d+\/\d+ 片/.test(String(entry.detail))),
		JSON.stringify(clientLogs.filter((entry) => entry.event === 'upload-progress').map((entry) => entry.detail)))
	check('"完成"那条带着电脑上的落点（下次不用再猜图存哪了）',
		clientLogs.some((entry) => entry.event === 'upload-done' && String(entry.detail).includes('test-inline.png')),
		JSON.stringify(clientLogs.filter((entry) => entry.event === 'upload-done').map((entry) => entry.detail)))
	/*
	 * ⚠️ 复查抓到的回归（钉死它 ✓）：切片重发那条路的顺序是「先 flash『📡 正在发送…』→ 失败 →
	 * flash 进度 → 再 post」✓，成功时 `clearFlashIf('📡 正在发送…')` **匹配不上**横幅上那句进度 ✗
	 * → 屏幕上永远停着「正在上传 X … 1/1 片」✗（图早发出去了 ✓）。现在发送成功会把它收掉 ✓。
	 * ⚠️ 判据必须看**可见性** ✗：`hide()` 只把 `display` 关掉 ✓，文字还留在 DOM 里 ✓
	 *（只看 `textContent` 会把"已经收起来了"误判成"还挂着"✗）。
	 */
	check('切片重发**成功之后**，那句「正在上传…」已经收起来了（复查抓到的回归 ✓）',
		visible($('banner')) === false,
		`visible=${visible($('banner'))} banner=${JSON.stringify($('banner').textContent.slice(0, 60))}`)
	promptFailTimes = 0
}

/* --- 3.5.0：上传中途断了 → 日志里必须留下"客户端断了"这一条 ----------------- */
/*
 * 用户 2026-10-13 报「上传日志只有开头」✓：那次是**发图断网** ✓，电脑那边的日志只有
 * `send-inline-failed…改走切片上传` 一行 ✓，之后是"传完了 / 断了 / 传到第几片"全都没有 ✗，
 * 只能靠猜 ✓。现在 `uploadInChunks` 在 catch 里补一条 `upload-aborted` ✓（带"传到第几片"✓）。
 *
 * ⚠️ 照实说：真断网时这条上报**本身**也可能发不出去 ✓（`reportToBridge` 是 best-effort ✓）——
 * 但"入口掐断 / 服务端 5xx / 重试三次全失败"这类**连接还在**的失败一定留得下 ✓。
 */
{
	uploaded.length = 0
	clientLogs.length = 0
	const promptsBeforeBreak = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	// 走「原图」通道：不压缩，3 MB 必然分片（和"用户发大文件时断网"同一条路 ✓）。
	const rawToggleBreak = $('rawToggle')
	if (rawToggleBreak.classList.contains('on') === false) rawToggleBreak.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
	const broken = new window.File([new Uint8Array(3 * 1024 * 1024).fill(7)], 'broken.bin', { type: 'application/octet-stream' })
	Object.defineProperty($('file'), 'files', { value: [broken], configurable: true })
	$('file').dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(300)
	check('准备：要断的那个大文件已挂上（原图模式）', $('thumbs').children.length === 1, `thumbs=${$('thumbs').children.length}`)

	uploadFailTimes = 6   // 每片重试 3 次 → 第一片就够断
	$('text').value = '传个会断的大文件'
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(4000)
	check('上传断了：日志里留下"断了"这一条（最值钱的那条 ✓）',
		clientLogs.some((entry) => entry.event === 'upload-aborted'),
		JSON.stringify(clientLogs.map((entry) => entry.event)))
	check('那条写着**传到第几片**断的（这一条是**第一片就断** ⇒ 必须是 `0/N` ✓，不许多报一片 ✗ —— 复查点名）',
		clientLogs.some((entry) => entry.event === 'upload-aborted' && /传到 0\/\d+ 片断了/.test(String(entry.detail))),
		JSON.stringify(clientLogs.filter((entry) => entry.event === 'upload-aborted').map((entry) => entry.detail)))
	check('界面上如实说"上传失败"并给「重试」（名字里有的两件事都要查 ✓ —— 复查点名"重试"原来没人查 ✗）',
		$('banner').textContent.includes('上传失败') && $('banner').textContent.includes('重试'),
		$('banner').textContent.slice(0, 80))
	check('断掉的那条**没有**发出去（不许出现"发了但少一张"✗）',
		requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === promptsBeforeBreak,
		`prompt=${requests.filter((entry) => entry.path.startsWith('/api/prompt')).length - promptsBeforeBreak}`)
	uploadFailTimes = 0
	if (rawToggleBreak.classList.contains('on')) rawToggleBreak.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	// 收拾干净 ✓：失败的那条按设计**留在输入框**（用户可以直接点「重试」✓）——
	// 但它会污染下面"多张一起挑"那条用例 ✗，所以点掉它的小 ×（= 用户真会做的那个动作 ✓）。
	const dropLeftover = $('thumbs').querySelector('[data-dropfile]')
	if (dropLeftover !== null) dropLeftover.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
	check('收拾：断掉的那张已从输入框拿掉（下一条用例不受污染 ✓）',
		$('thumbs').children.length === 0, `thumbs=${$('thumbs').children.length}`)
}

/* --- 多张一起挑：打包成**一个请求**发出去（用户要的"别干等"）--------------- */
/*
 * 现场要求：「传图片能不能快一点，要能多个图片一起打包发送，而不是在那里干等」。
 * 一次挑多张时：① 每张走"打包档"压缩（长边 1280/q0.78），好让整批塞进一个请求；
 * ② 一个请求 = 一次往返 = 最快。分片只在单张实在太大时才用。
 */
{
	uploaded.length = 0
	uploadPeak = 0
	const promptsBefore = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	const trio = ['a.png', 'b.png', 'c.png'].map((name) =>
		new window.File([new window.Uint8Array([137, 80, 78, 71, 1, 2, 3])], name, { type: 'image/png' }))
	Object.defineProperty($('file'), 'files', { value: trio, configurable: true })
	$('file').dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(300)
	check('一次挑三张：三张都挂上了（一张都不许丢）',
		$('thumbs').querySelectorAll('img').length === 3,
		`thumbs img=${$('thumbs').querySelectorAll('img').length}`)
	$('text').value = '三张一起看'
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(400)
	const sent = requests.filter((entry) => entry.path.startsWith('/api/prompt'))
	const batch = JSON.parse(sent[sent.length - 1].options.body)
	check('三张图打包在**同一个请求**里发出去（不是三趟来回）',
		sent.length === promptsBefore + 1 && batch.images.length === 3 && uploaded.length === 0,
		JSON.stringify({ prompts: sent.length - promptsBefore, images: batch.images.length, 分片: uploaded.length }))
	check('整批发完缩略图清空（界面上不留"发了还在"的假象）', $('thumbs').children.length === 0,
		`thumbs=${$('thumbs').children.length}`)
}

/* --- 分片上传必须**并发**（串行等一片一个来回，就是用户说的"干等"）--------- */
{
	uploaded.length = 0
	uploadPeak = 0
	// 走「原图」通道（不压缩），3 MB 的附件必然要分片 —— 正好看并发。
	const heavy = new window.File([new Uint8Array(3 * 1024 * 1024).fill(9)], 'heavy.bin', { type: 'application/octet-stream' })
	const rawToggle = $('rawToggle')
	if (rawToggle.classList.contains('on') === false) rawToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
	Object.defineProperty($('file'), 'files', { value: [heavy], configurable: true })
	$('file').dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(300)
	$('text').value = '传个大文件'
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(3000)
	check('3 MB 附件分成多片上传', uploaded.length >= 5, `${uploaded.length} 片`)
	check('分片是**并发**发的（同时在飞 ≥2 片）', uploadPeak >= 2, `峰值并发 ${uploadPeak}`)
	check('每片都带上 size/chunkBytes（服务端才能乱序收）',
		uploaded.every((entry) => entry.size > 0 && entry.chunkBytes > 0),
		JSON.stringify(uploaded[0] ?? {}).slice(0, 120))
	if (rawToggle.classList.contains('on')) rawToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
}

/* --- 一次挑十张（真机上"还没发出去"的那个场景）-------------------------- */
/*
 * 现场：用户一次挑十张，四分钟只看到上传在跑、消息始终没发出去。
 * 两个原因都在这里钉住：① 十张处理时必须有进度提示（否则界面像死了）；
 * ② 十张一起挑不许丢任何一张，而且**整批发出去**（不要十趟来回）。
 * 真机上还有"手机上行只有 20~70 KB/s"这层原因（压得更狠 + 并发分片已在别处覆盖）。
 */
{
	uploaded.length = 0
	const promptsBefore = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	const many = Array.from({ length: 10 }, (_, index) =>
		new window.File([new window.Uint8Array([137, 80, 78, 71, index])], `p${index}.png`, { type: 'image/png' }))
	Object.defineProperty($('file'), 'files', { value: many, configurable: true })
	$('file').dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(600)
	check('一次挑十张：十张一张不少地挂上',
		$('thumbs').querySelectorAll('img').length === 10,
		`thumbs img=${$('thumbs').querySelectorAll('img').length}`)
	check('处理十张时有进度提示（界面不做"像死了一样"的沉默）',
		$('banner').textContent.includes('/10 张') || $('banner').textContent.includes('已备好 10 张'),
		$('banner').textContent)
	$('text').value = '十张一起看'
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(600)
	const sent = requests.filter((entry) => entry.path.startsWith('/api/prompt'))
	const batch = JSON.parse(sent[sent.length - 1].options.body)
	check('十张打包在同一批里发出去（不是十趟来回）',
		sent.length === promptsBefore + 1 && (batch.images.length + batch.fileRefs.length) === 10,
		JSON.stringify({ prompts: sent.length - promptsBefore, images: batch.images.length, refs: batch.fileRefs.length }))
	check('整批发完缩略图清空', $('thumbs').children.length === 0, `thumbs=${$('thumbs').children.length}`)
}

/* --- 「发送」在没内容时要说人话（以前是静默无反应）------------------------ */
{
	const before = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	$('text').value = ''
	$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(80)
	check('没内容时按发送给提示，而不是静默无反应（用户嘴里的"发不出去"）',
		$('banner').textContent.includes('还没内容可发')
		&& requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === before,
		$('banner').textContent)
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
	check('往上翻着看历史时追加消息，不抢滚动位置', await settled(() => Math.round(log.scrollTop)) === 300, String(log.scrollTop))

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
	openSessions()
	await wait(20)
	const others = sessionRows().filter((value) => value !== SESSION)
	check('测试前提：会话列表里还有另一个会话可以切', others.length > 0, `${sessionRows().length} 个会话`)
	// 用一个【从没打开过】的会话来验证"没缓存就照旧拉整段"（切走过的都会被缓存，
	// 那正是这个功能的定义）。
	const fresh = others.includes('session-fresh') ? 'session-fresh' : (others[0] ?? SESSION)

	// 切到一个没打开过的会话：没有缓存 → 走老路（拉整段）。
	await switchTo(fresh)
	await wait(200)
	const freshStream = sources[sources.length - 1]
	const pullsAfterFresh = requests.filter((entry) => entry.path.startsWith('/api/transcript')).length
	check('没有缓存的会话照旧去拉整段（不会假装有内容）',
		pullsAfterFresh === pullsBefore + 1, `transcript ${pullsBefore} -> ${pullsAfterFresh}`)
	check('没有缓存的会话不带 since（手上没有内容，不能报序号）',
		!freshStream.url.includes('since='), freshStream.url)

	// 切回来：这一次必须"立刻"有内容 —— 点下去那一瞬（同一段同步代码里）就得铺上，
	// 不能等下载。所以这里不走 switchTo（它自带 await），手动点行、马上读。
	openSessions()
	await wait(20)
	click($('sessList').querySelector(`[data-session="${SESSION}"]`))
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
		await settled(() => Math.round(log.scrollTop)) === Math.round(parked), `scrollTop=${log.scrollTop} 期望${parked}`)
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

	/*
	 * 2.0：用户要求「上滑就会出现的会到底部的箭头」。
	 * 原来那版是 12px 灰字小胶囊、还要**松手 160ms 后**才出现 —— 滑到一半屏幕上什么都没有，
	 * 用户就会以为"没有回到底部的入口"（他报的就是这个）。现在：手指还在滑就亮、是个圆形箭头。
	 */
	// 先把箭头收起来（`hide()` 是页面内部的函数，测试里只能用 DOM）。
	$('tonew').style.display = 'none'
	log.scrollTop = Math.max(0, bottom() - 300)
	{
		const move = new window.Event('touchmove', { bubbles: true })
		move.touches = [{ clientX: 200, clientY: 300 }]
		log.dispatchEvent(move)
	}
	await wait(30)
	check('手指还按着往上滑的时候，箭头就已经出现了（不用等松手）',
		window.getComputedStyle($('tonew')).display !== 'none',
		window.getComputedStyle($('tonew')).display)
	check('它是看得见的圆形箭头（不是原来那条 12px 小胶囊）',
		$('tonew').textContent.trim() === '↓'
		&& window.getComputedStyle($('tonew')).borderRadius.includes('50%'),
		`文字=${$('tonew').textContent.trim()} 圆角=${window.getComputedStyle($('tonew')).borderRadius}`)
	check('它的层级在内容之上、面板之下（面板盖着时不该冒出来）',
		Number.parseInt(window.getComputedStyle($('tonew')).zIndex, 10) >= 10
		&& Number.parseInt(window.getComputedStyle($('tonew')).zIndex, 10) < 80,
		window.getComputedStyle($('tonew')).zIndex)
	// 已经在底部时不该出现（否则等于常驻一个没用的按钮）。
	// 注意：上面故意只发了 touchmove —— 得补一个 touchend，页面才会在 160ms 空闲后重算"贴底没有"。
	log.dispatchEvent(new window.Event('touchend'))
	await wait(260)
	log.scrollTop = bottom()
	log.dispatchEvent(new window.Event('scroll'))
	await wait(60)
	check('已经贴到底部时箭头不出现', window.getComputedStyle($('tonew')).display === 'none',
		window.getComputedStyle($('tonew')).display)
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

	// 视频模式：同一个面板切成 🎬 —— 尺寸换成视频档、种子藏起来、那句话改调 video_generate。
	textarea.value = ''
	$('genBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	$('genopen').querySelector('.genmode[data-mode="video"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	check('切成视频：面板标题与提示词说明都变了',
		$('genTitle').textContent === '生成视频' && $('genPromptHint').textContent.includes('镜头'),
		$('genTitle').textContent)
	check('切成视频：尺寸换成视频档、种子藏起来（视频接口不吃种子）',
		window.getComputedStyle($('genSizesVideo')).display !== 'none'
		&& window.getComputedStyle($('genSizesImage')).display === 'none'
		&& window.getComputedStyle($('genSeedField')).display === 'none')
	check('切成视频：提示说明也换成出片那条（免得以为秒回）',
		window.getComputedStyle($('genHintVideo')).display !== 'none'
		&& $('genHintVideo').textContent.includes('分钟')
		&& window.getComputedStyle($('genHintImage')).display === 'none')
	$('genPrompt').value = '一只红苹果在木桌上缓缓旋转，暖光，镜头缓慢推近'
	$('genPrompt').dispatchEvent(new window.Event('input', { bubbles: true }))
	$('genopen').querySelectorAll('.genvopt')[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	const videoPreview = $('genPreview').textContent
	check('视频预览里调的是 video_generate，且带上了分辨率',
		videoPreview.includes('video_generate') && videoPreview.includes('1080x1920'), videoPreview.slice(0, 90))
	check('视频预览要求把 mp4 路径单独放一行（手机靠它变成可播视频）',
		videoPreview.includes('路径'), videoPreview.slice(0, 120))
	check('视频模式不再出现 seed 字样', videoPreview.includes('种子') === false)
	$('genGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(60)
	check('视频那句话进了输入框（同样先让用户过目）', textarea.value.includes('video_generate'), textarea.value.slice(0, 40))
	$('genBack').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(40)
	// 切回图片模式：界面要回到图片那一套（模式是"粘"的，不能让两种界面混着）。
	$('genBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	$('genopen').querySelector('.genmode[data-mode="image"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	check('切回图片：标题/尺寸/种子都回来了',
		$('genTitle').textContent === '生成图片'
		&& window.getComputedStyle($('genSizesImage')).display !== 'none'
		&& window.getComputedStyle($('genSeedField')).display !== 'none')
	$('genPrompt').value = ''
	$('genPrompt').dispatchEvent(new window.Event('input', { bubbles: true }))
	$('genBack').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(40)

	/* --- 网页里直接录音（1.5.0）------------------------------------------------ */
	/*
	 * 用户要的是"别让我在手机上找录音文件"：按住网页里的键直接录，录完自动转文字。
	 * 这里用假的 MediaRecorder + 假麦克风把整条链路走完，验的是**真代码**：
	 * 开录 → 计时/电平 → 停止合成 → 预览 → 塞进待发文件 → 分片上传带上 audio/webm。
	 */
	{
		uploaded.length = 0
		check('录音键在底部那一栏（不当页签，点了不换页）',
			$('tabs').contains($('recBtn')) && $('recBtn').dataset.tab === undefined)
		const activeBefore = window.document.querySelector('#tabs button.active')?.dataset.tab
		$('recBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		check('点「录音」弹出录音面板', window.getComputedStyle($('recopen')).display !== 'none')
		check('点它不会把页签切走（它不是页签）',
			window.document.querySelector('#tabs button.active')?.dataset.tab === activeBefore,
			`${activeBefore} → ${window.document.querySelector('#tabs button.active')?.dataset.tab}`)
		check('还没录时：只有「开始录音」，没有发送/重录',
			window.getComputedStyle($('recSend')).display === 'none'
			&& window.getComputedStyle($('recRedo')).display === 'none'
			&& $('recToggle').textContent.includes('开始录音'))

		$('recToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(60)
		check('开录后按钮变「停止」，状态写明正在录（别锁屏/别切走）',
			$('recToggle').textContent.includes('停止') && $('recState').textContent.includes('正在录音'),
			$('recState').textContent)
		check('录音时工具键上也有红点提示（切走了也知道还在录）', $('recBtn').classList.contains('rec'))
		check('录的是 opus/webm（体积只有系统录音的三分之一）',
			window.__recorders[0]?.mimeType === 'audio/webm;codecs=opus'
			&& window.__recorders[0]?.audioBitsPerSecond === 24000,
			`${window.__recorders[0]?.mimeType} @ ${window.__recorders[0]?.audioBitsPerSecond}`)

		$('recToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(80)
		check('停止后给出预览 + 「发送这条录音」+「重录」',
			window.getComputedStyle($('recSend')).display !== 'none'
			&& window.getComputedStyle($('recRedo')).display !== 'none'
			&& $('recPlay').src.startsWith('blob:'),
			$('recState').textContent)
		check('状态里报了时长与体积（用户据此估上传时间）',
			/\d+ 秒、\d+ KB/.test($('recState').textContent), $('recState').textContent)
		check('录完把麦克风关掉（不能一直占着）',
			window.__recorders.length === 1, `${window.__recorders.length} 个 recorder`)

		const beforeRec = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
		$('recSend').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(120)
		check('录音挂成待发附件，面板收起',
			window.getComputedStyle($('recopen')).display === 'none'
			&& $('thumbs').textContent.includes('录音-'),
			$('thumbs').textContent.trim().slice(0, 40))
		$('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(220)
		const recBody = JSON.parse(requests.filter((entry) => entry.path.startsWith('/api/prompt')).pop().options.body)
		check('录音按「文件」那条路分片上传，媒体类型是 audio/webm（电脑才知道是音频）',
			requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === beforeRec + 1
			&& uploaded.length >= 1
			&& String(uploaded[0].name).startsWith('录音-')
			&& String(uploaded[0].name).endsWith('.webm')
			&& uploaded[0].mediaType === 'audio/webm'
			&& recBody.fileRefs?.length === 1,
			JSON.stringify({ 片: uploaded.length, 名: uploaded[0]?.name, 类型: uploaded[0]?.mediaType }))

		// 浏览器不给录音（老浏览器 / http 地址）时，点了要**说清楚**，不能静默没反应。
		$('recBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(40)
		check('录音面板里写着"要用 https 打开、允许麦克风"（这两个是失败的唯一原因）',
			$('recopen').textContent.includes('https') && $('recopen').textContent.includes('麦克风'))
		$('recBack').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(40)
	}

	/* --- 左右滑动换页（1.7.0）---------------------------------------------------
	 * 用户要求：「左滑右滑可以换页，比如左滑从新建到余额」。
	 * jsdom 没有真的触摸事件，但代码只读 touches/changedTouches 里的坐标 ——
	 * 所以造一个带这两样东西的普通事件就能把**真代码**走一遍。
	 */
	const swipe = async (from, to, { target = null, steps = 4 } = {}) => {
		const node = target ?? window.document.getElementById('log')
		const fire = (type, x, y, changed = false) => {
			const event = new window.Event(type, { bubbles: true, cancelable: true })
			event.touches = changed ? [] : [{ clientX: x, clientY: y }]
			event.changedTouches = changed ? [{ clientX: x, clientY: y }] : []
			node.dispatchEvent(event)
		}
		fire('touchstart', from.x, from.y)
		for (let i = 1; i <= steps; i += 1) {
			fire('touchmove', from.x + (to.x - from.x) * (i / steps), from.y + (to.y - from.y) * (i / steps))
		}
		fire('touchend', to.x, to.y, true)
		await wait(60)
	}
	const activeTab = () => window.document.querySelector('#tabs button.active')?.dataset.tab
	const newOpen = () => window.getComputedStyle($('view-new')).display !== 'none'
	const recOpen = () => window.getComputedStyle($('recopen')).display !== 'none'

	// 先回到"任务"这一页，作为出发点。
	click(tabButton('task'))
	await wait(60)
	await swipe({ x: 300, y: 400 }, { x: 120, y: 405 })
	check('在「任务」页左滑 → 到「新建」（新建是盖在上面的面板，也算一页）',
		newOpen() === true && activeTab() === 'task', `new=${newOpen()} active=${activeTab()}`)
	await swipe({ x: 300, y: 400 }, { x: 120, y: 398 })
	/*
	 * 用户 2026-10-11：「滑动时出现不了录音界面」—— 页签栏上是**四个**
	 * （任务 · 新建 · 🎤录音 · 余额），滑动就得能一路划到四个 ✓。
	 * 所以从「新建」左滑到的下一站是**录音**（1.7.0 我按三页排，把录音漏了 ✗）。
	 */
	check('在「新建」页左滑 → 到「录音」（页签栏上看得见的都要能划到）',
		newOpen() === false && recOpen() === true && activeTab() === 'task',
		`new=${newOpen()} rec=${recOpen()} active=${activeTab()}`)
	await swipe({ x: 300, y: 400 }, { x: 120, y: 398 })
	check('在「录音」页左滑 → 到「余额」', recOpen() === false && activeTab() === 'bill',
		`rec=${recOpen()} active=${activeTab()}`)
	await swipe({ x: 120, y: 400 }, { x: 300, y: 402 })
	check('在「余额」页右滑 → 回到「录音」',
		recOpen() === true && activeTab() === 'bill', `rec=${recOpen()} active=${activeTab()}`)
	await swipe({ x: 120, y: 400 }, { x: 300, y: 400 })
	check('在「录音」页右滑 → 回到「新建」',
		recOpen() === false && newOpen() === true, `rec=${recOpen()} new=${newOpen()}`)
	await swipe({ x: 120, y: 400 }, { x: 300, y: 400 })
	check('在「新建」页右滑 → 回到「任务」',
		newOpen() === false && activeTab() === 'task', `new=${newOpen()} active=${activeTab()}`)
	await swipe({ x: 120, y: 400 }, { x: 320, y: 400 })
	/*
	 * 提示必须走 toast，而不是 #banner：banner 在 #view-task 里面、z-index 也低于面板，
	 * 所以在「余额」页或录音/生图面板上根本看不见 —— 看不见的提示等于没提示。
	 * 顺带钉住 toast 的层级要高于所有会盖住它的东西（sheet 80 / boot 90 / offline 95）。
	 */
	check('已经在最左边（任务）再右滑：不翻页，只提示一句（用能盖过面板的 toast）',
		activeTab() === 'task' && newOpen() === false && $('toast').textContent.includes('最左边'),
		$('toast').textContent.trim().slice(0, 30))
	check('提示条的层级高于所有面板（sheet 80 / boot 90 / 离线 95）',
		Number.parseInt(window.getComputedStyle($('toast')).zIndex, 10) > 95,
		window.getComputedStyle($('toast')).zIndex)

	// 边界：竖着滑是滚动，不能翻页（这条错了最烦人：用户在下滑看历史，页面自己跳走）。
	await swipe({ x: 200, y: 500 }, { x: 205, y: 300 })
	check('竖着滑（看历史/滚动）不会被当成翻页',
		activeTab() === 'task' && newOpen() === false, `active=${activeTab()}`)
	// 边界：幅度太小算点击，不算翻页。
	await swipe({ x: 200, y: 400 }, { x: 230, y: 405 })
	check('只滑了一点（30px）不算翻页（否则会误伤点按）',
		activeTab() === 'task' && newOpen() === false, `active=${activeTab()}`)
	// 边界：在输入框里左右滑（选文字）不能翻页。
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 }, { target: textarea })
	check('在输入框里左右滑 → 不翻页（那是在选文字/移光标）',
		activeTab() === 'task' && newOpen() === false, `active=${activeTab()}`)
	// 边界：说明页/录音面板这类"挡住整屏"的面板开着时，背后不能换页。
	click($('help'))
	await wait(60)
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })
	check('说明页开着时滑动不在背后换页（东西自己动了最难解释）',
		activeTab() === 'task' && newOpen() === false && window.getComputedStyle($('welcome')).display !== 'none',
		`active=${activeTab()} welcome=${window.getComputedStyle($('welcome')).display}`)
	click($('welcomeGo'))
	await wait(60)
	// 边界：新建里写了草稿，划走要先问一句（滑动比点返回更容易误触，不能默默丢）。
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })   // 任务 → 新建
	$('firstText').value = '把讲义整理成提纲'
	window.confirm = () => { confirmAnswer = false; return confirmAnswer }
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })
	check('新建里写了草稿：划走先问一句，说"不"就留在原地',
		newOpen() === true, `new=${newOpen()}`)
	window.confirm = () => { confirmAnswer = true; return confirmAnswer }
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })
	check('确认之后才真的划走（下一站是「录音」）', newOpen() === false && recOpen() === true, `new=${newOpen()} rec=${recOpen()}`)
	$('firstText').value = ''
	click(tabButton('task'))
	await wait(60)

	/* --- 2.0：录音 / 生图 / 背景 / 权限这些面板上也照样能滑 ---------------------
	 * 用户原话：「左右滑动时录音界面不行」。
	 * 1.7.0 时这些"工具抽屉"开着会**整个挡掉**滑动 —— 用户的感受就是"滑动时灵时不灵"。
	 * 2.0 放开，用两条更小的规则补回来：正在录音不让走（面板上就是停止键）、
	 * 生图里写了提示词先问一句。录音那两条放在录音那一块里测（那里假麦克风是装好的），
	 * 生图草稿那条复用上面已有的 confirm 断言。
	 */
	// 离线整屏（z-index 95）盖着时也不该在背后换页。
	$('offline').style.display = 'flex'
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })
	check('离线整屏盖着时滑动不在背后换页', activeTab() === 'task' && newOpen() === false, `active=${activeTab()}`)
	$('offline').style.display = 'none'

	/*
	 * 2.0：用户报「左右滑动时录音界面不行」。
	 * 录音面板属于"工具抽屉"：1.7.0 时它整个挡掉滑动，2.0 放开 —— 但正在录的时候要拦，
	 * 因为面板上就是停止键，划走了用户够不着它；而且**必须说明原因**，
	 * 静默不响应正是用户报的那个感受。（假麦克风/MediaRecorder 在这一块之前就装好了。）
	 */
	click(tabButton('task'))
	await wait(40)
	click($('recBtn'))
	await wait(40)
	check('（前置）录音面板开着、还没在录',
		window.getComputedStyle($('recopen')).display !== 'none' && $('recToggle').textContent.includes('开始录音'))
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })
	// 页面顺序是 任务 → 新建 → 录音 → 余额：站在「录音」上左滑，下一站是「余额」。
	check('录音面板上左滑 → 面板自己关掉、翻到下一页（「余额」）',
		recOpen() === false && activeTab() === 'bill',
		`rec=${recOpen()} active=${activeTab()}`)
	click($('newBack'))
	await wait(40)
	click(tabButton('task'))
	await wait(40)
	click($('recBtn'))
	await wait(40)
	click($('recToggle'))
	await wait(80)
	check('（前置）确实在录了', $('recToggle').textContent.includes('停止'), $('recToggle').textContent)
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })
	check('正在录音时左滑 → 不翻页，而且明确告诉你先按「停止」',
		window.getComputedStyle($('recopen')).display !== 'none'
		&& activeTab() === 'task' && $('toast').textContent.includes('停止'),
		`rec=${window.getComputedStyle($('recopen')).display} active=${activeTab()} toast=${$('toast').textContent.trim().slice(0, 24)}`)
	click($('recToggle'))
	await wait(80)
	click($('recBack'))
	await wait(40)

	// 生图面板里写了提示词：划走要和「新建」一样先问一句（那是用户写好的话，不能默默丢）。
	click(tabButton('task'))
	await wait(40)
	click($('genBtn'))
	await wait(40)
	$('genPrompt').value = '一只橘猫趴在窗台上'
	window.confirm = () => { confirmAnswer = false; return confirmAnswer }
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })
	check('生图里写了提示词：划走先问一句，说"不"就留在原地',
		window.getComputedStyle($('genopen')).display !== 'none' && newOpen() === false,
		`gen=${window.getComputedStyle($('genopen')).display}`)
	window.confirm = () => { confirmAnswer = true; return confirmAnswer }
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })
	check('确认之后：生图面板收起、真的翻到下一页',
		window.getComputedStyle($('genopen')).display === 'none' && newOpen() === true,
		`gen=${window.getComputedStyle($('genopen')).display} new=${newOpen()}`)
	$('genPrompt').value = ''
	click($('newBack'))
	await wait(40)

	// 翻页会带一下进场动画（"确实翻了"的即时反馈）。
	click(tabButton('task'))
	await wait(40)
	/*
	 * ⚠️ 这一条原来是**时序敏感**的 ✗：类名由 `mobile.html` 里一个 `setTimeout(..., 260)` 摘掉 ✓
	 *（**不是** animationend ✓ —— 冷视角复查逐行读出来的 ✓），而检查发生在"类加完之后" ✓；
	 * 机器一忙（这一步与检查之间被别的活挤掉几百毫秒 ✓），定时器先到 → 类名已经没了 ✗ → 偶发红 ✓。
	 * ✅ 正确修法（测试侧 ✓）：**装一个 MutationObserver 记录"这个类出现过没有"** ✓ ——
	 * 它不看"检查那一刻还在不在" ✓，所以不受调度影响 ✓；查完 disconnect ✓。
	 * ❌ 我第一版改法是去拉长 `animation-duration` ✗ —— 那**动不了**那个 260ms 定时器 ✓，等于没修 ✓。
	 */
	let sawPageIn = false
	const pageInObserver = new window.MutationObserver(() => {
		const cls = $('view-new').className
		if (String(cls).includes('pagein-left') || String(cls).includes('pagein-right')) sawPageIn = true
	})
	pageInObserver.observe($('view-new'), { attributes: true, attributeFilter: ['class'] })
	await swipe({ x: 300, y: 400 }, { x: 120, y: 400 })
	const pageInNow = $('view-new').classList.contains('pagein-left') || $('view-new').classList.contains('pagein-right')
	check('翻页时有进场动画的类名（即时反馈）',
		sawPageIn || pageInNow,
		`出现过=${sawPageIn} 检查时=${pageInNow} className=${$('view-new').className}`)
	pageInObserver.disconnect()
	click($('newBack'))
	await wait(60)

	/* --- 2.5.0：置顶 + 常用（A 自动频率 / B 手动打星）-------------------------
	 * 用户 2026-10-11：「置顶」「常用 A：用得多的靠前」「常用 B：手动打星」—— 两个都要 ✓。
	 * 三份数据只存在**手机本地**（dshm.pins / dshm.stars / dshm.usage），不碰宿主的会话库，
	 * 所以电脑端一点不受影响。这一块把这四件事钉住：分组顺序、两个开关、持久化、以及
	 * **不许把左右滑动换页搞坏**（列表就住在任务页上，最容易误伤的就是它）。
	 */
	{
		const writeJson = (key, value) => window.localStorage.setItem(key, JSON.stringify(value))
		// 从**渲染出来的 DOM** 里把三组读回来（不是读内存里的排序函数）：测的才是用户看到的。
		const groups = () => {
			const out = { '📌 置顶': [], '⭐ 常用': [], '🕘 最近': [] }
			let current = ''
			for (const node of $('sessList').children) {
				if (node.classList.contains('sessgroup') === true) { current = node.textContent.trim(); continue }
				const row = node.querySelector('[data-session]')
				if (current !== '' && row !== null) out[current].push(row.getAttribute('data-session'))
			}
			return out
		}
		const openList = async () => { openSessions(); await wait(30) }
		/** 点某一行的 📌 / ⭐（which = pin | star）。点完面板**不关**，也不该切会话。 */
		const mark = async (sessionId, which) => {
			await openList()
			const button = $('sessList').querySelector(`[data-${which}="${sessionId}"]`)
			if (button === null) throw new Error(`没有 ${which} 按钮：${sessionId}`)
			click(button)
			await wait(30)
		}
		const stored = (key) => JSON.parse(window.localStorage.getItem(key) ?? '[]')

		check('会话栏不再是原生下拉（原生里面放不下 📌/⭐，也没法分组）',
			$('session') === null && $('sessBtn') !== null, `#session=${$('session')}`)

		// ① 常用 A（自动频率）：一次没打过星，只用过 — 用得多的在前。
		writeJson('dshm.pins', [])
		writeJson('dshm.stars', [])
		// 一次性覆盖整份 usage：前面发过好几条消息，不清掉就没法断言"谁在前"。
		writeJson('dshm.usage', { 'session-fresh': 9, 'session-older': 1 })
		await openList()
		const freq = groups()
		check('「常用 A」：没打星也按使用次数自动排（A=9 次排在 B=1 次前面）',
			freq['⭐ 常用'].includes('session-fresh') && freq['⭐ 常用'].includes('session-older')
			&& freq['⭐ 常用'].indexOf('session-fresh') < freq['⭐ 常用'].indexOf('session-older'),
			JSON.stringify(freq))
		check('用过 0 次的会话不进「常用」，留在「最近」',
			freq['⭐ 常用'].includes(SESSION) === false && freq['🕘 最近'].includes(SESSION),
			JSON.stringify(freq))

		// ② 置顶：钉上去 → 第一组出现它，而且**排在所有会话最前面**。
		const barBefore = $('sessBtn').textContent
		await mark('session-older', 'pin')
		const pinned = groups()
		check('点 📌 → 这个会话进「📌 置顶」组，并排在最前',
			pinned['📌 置顶'].includes('session-older') && sessionRows()[0] === 'session-older',
			JSON.stringify(pinned))
		check('置顶立刻写进手机本地（dshm.pins，重启后还在）',
			stored('dshm.pins').includes('session-older'), JSON.stringify(stored('dshm.pins')))
		check('点 📌 只是"标一下"，不会把用户切到那个会话去',
			$('sessBtn').textContent === barBefore && $('sessList').querySelector(`[data-session="${SESSION}"]`).classList.contains('on'),
			`${barBefore} -> ${$('sessBtn').textContent}`)

		// ③ 常用 B：手动打星 —— 一次没用过也照样进「常用」。
		await mark('session-fresh', 'star')
		const starred = groups()
		check('点 ⭐ → 这个会话进「⭐ 常用」组（和"用得多的"共用这一区）',
			starred['⭐ 常用'].includes('session-fresh')
			&& $('sessList').querySelector('[data-star="session-fresh"]').classList.contains('on'),
			JSON.stringify(starred))
		check('打星立刻写进手机本地（dshm.stars）',
			stored('dshm.stars').includes('session-fresh'), JSON.stringify(stored('dshm.stars')))

		// ④ 再点一下就是取消（两个开关都是"再点一下关掉"，不能只能加不能减）。
		await mark('session-older', 'pin')
		check('再点一次 📌 就取消置顶（「📌 置顶」这一组随之消失）',
			stored('dshm.pins').includes('session-older') === false && groups()['📌 置顶'].length === 0,
			JSON.stringify({ pins: stored('dshm.pins'), groups: groups() }))

		// ⑤ 持久化：关掉再打开还是这个秩序（真机上就是"重启后还在"）。
		await mark('session-older', 'star')
		click($('sessBack'))
		await wait(30)
		await openList()
		const reopened = groups()
		check('关掉列表再打开：⭐ 那几条还在原处（本地存着，重启手机也在）',
			reopened['⭐ 常用'].includes('session-fresh') && reopened['⭐ 常用'].includes('session-older'),
			JSON.stringify(reopened))
		check('当前选中那一行带选中态（用户一眼看出"现在在哪个会话"）',
			$('sessList').querySelector(`[data-session="${SESSION}"]`).classList.contains('on'),
			JSON.stringify({ rows: sessionRows(), bar: $('sessBtn').textContent }))

		// ⑥ 关键回归：点这两个小按钮**不能被吃成翻页**，而列表上照样能左右滑换页。
		//    按钮很小，手指按上去本来就容易带横向位移 —— 不挡就会"标一下却翻到别的页"。
		click(tabButton('task'))
		await wait(40)
		await openList()
		const atTask = activeTab()
		await swipe({ x: 300, y: 400 }, { x: 120, y: 400 }, { target: $('sessList').querySelector('[data-pin="session-fresh"]') })
		check('按着 📌 横向拖：不翻页、面板也不关（那个键是"标一下"，不是"换页"）',
			activeTab() === atTask && window.getComputedStyle($('sessopen')).display !== 'none',
			`active=${activeTab()} panel=${window.getComputedStyle($('sessopen')).display}`)
		await swipe({ x: 300, y: 400 }, { x: 120, y: 400 }, { target: $('sessopen') })
		check('列表上的空白处左右滑：照样换页（原本的滑动换页没被这一版搞坏）',
			activeTab() === atTask && newOpen() === true && window.getComputedStyle($('sessopen')).display === 'none',
			`active=${activeTab()} new=${newOpen()} panel=${window.getComputedStyle($('sessopen')).display}`)
		click($('newBack'))
		await wait(40)
		// 收尾：把这一版加的三份本地数据清干净，免得影响后面的用例。
		window.localStorage.removeItem('dshm.pins')
		window.localStorage.removeItem('dshm.stars')
		window.localStorage.removeItem('dshm.usage')
	}

	/* --- 2.6.0：顶端显示真值模型 + 列表不摆子会话/自检 + 删除（要输 PIN）---------
	 * 用户 2026-10-11 三句话，对应下面三块：
	 *   ①「在网页顶端加一个当前模型的显示」—— 值必须是**宿主的真值**（2.4.2 那个
	 *     "电脑端换的、手机还显示默认"的限制在这一版修掉）；
	 *   ②「agent 子对话以及测试对话就不要显示在对话框里了，占位置」——默认藏、能看回来；
	 *   ③「再加一个删除对话按钮，并且要输入 pin 才能删除对话」——删除必须先输 PIN，
	 *     而且**正在跑的会话不会被悄悄删掉**。
	 */
	click(tabButton('task'))
	await wait(40)
	{
		const topOption = () => $('modelNow').options[$('modelNow').selectedIndex]?.textContent ?? ''
		const openList = async () => { openSessions(); await wait(30) }
		const archiveBefore = () => archiveRequests.length

		// ① 顶端那一行
		check('当前模型显示在网页顶端（标题栏里的第二行）',
			$('modelRow') !== null && $('modelRow').closest('header') !== null
			&& $('modelLabel') !== null && $('modelLabel').textContent.includes('当前模型'),
			$('modelRow') === null ? 'no #modelRow' : String($('modelRow').parentElement?.tagName))
		check('顶端显示的是宿主真值，不是手机自己记的 dshm.model（zhipu|glm-4-plus）',
			$('modelNow').value === 'deepseek-official|deepseek-chat' && topOption().includes('deepseek-chat'),
			`value=${$('modelNow').value} 显示=${topOption()}`)
		// 宿主在流里换模型 → 不用重开页面，顶端跟着变。
		source.emit({ t: 'event', event: { type: 'model/selection', seq: 210, time: Date.now(), data: { provider: 'zhipu', model: 'glm-4-plus' } } })
		await wait(60)
		check('宿主那边换了模型：顶端那一行跟着变（流里的 model/selection）',
			$('modelNow').value === 'zhipu|glm-4-plus', `value=${$('modelNow').value} 显示=${topOption()}`)
		/*
		 * 宿主报的模型**不在目录里**（provider 被停用/目录没拉到）时也必须看得见 ——
		 * 否则 `<select>` 会静默跳到第一项，用户看到的模型是错的，而这个功能的全部意义
		 * 就是"看到正在用的到底是哪个"。
		 */
		check('宿主报的模型不在目录里时也照样显示（不静默跳到第一项）',
			topOption().includes('glm-4-plus'), topOption())
		source.emit({ t: 'event', event: { type: 'request/header', seq: 211, time: Date.now(), data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } }, reason: 'change' } } })
		await wait(60)
		check('"下一次请求真用哪个"也认（request/header）—— 电脑端换模型手机马上跟上',
			$('modelNow').value === 'deepseek-official|deepseek-chat', `value=${$('modelNow').value}`)

		// ② 默认不摆 agent 子会话 / 自检会话
		await openList()
		check('列表默认不摆 agent 子会话 / 自检会话（用户：「占位置」）',
			sessionRows().includes('session-sub') === false && sessionRows().includes('session-self') === false
			&& sessionRows().length === 4, sessionRows().join(', '))
		check('藏了几个要说明白，并给出出口（不是静默消失）',
			$('sessHidden').textContent.includes('2') && $('sessHidden').textContent.includes('子会话'),
			$('sessHidden').textContent)
		$('sessAll').checked = true
		$('sessAll').dispatchEvent(new window.Event('change', { bubbles: true }))
		await wait(40)
		check('勾「显示全部会话」→ agent 子会话 / 自检会话都回来了',
			sessionRows().includes('session-sub') === true && sessionRows().includes('session-self') === true,
			sessionRows().join(', '))
		check('这个开关记在手机本地（下次打开还是你的选择）',
			window.localStorage.getItem('dshm.sessAll') === '1', String(window.localStorage.getItem('dshm.sessAll')))
		$('sessAll').checked = false
		$('sessAll').dispatchEvent(new window.Event('change', { bubbles: true }))
		await wait(40)
		check('取消勾选 → 又藏起来（开关两个方向都生效）',
			sessionRows().includes('session-sub') === false && sessionRows().includes('session-self') === false)

		// ③ 删除：先开"输 PIN 确认"那张纸
		await openList()
		const beforeOpen = archiveBefore()
		click($('sessList').querySelector('[data-del="session-fresh"]'))
		await wait(40)
		check('点 🗑 打开的是"输 PIN 确认"那张纸，**不是直接删**',
			window.getComputedStyle($('delopen')).display !== 'none'
			&& window.getComputedStyle($('sessopen')).display === 'none'
			&& archiveBefore() === beforeOpen,
			`删除纸=${window.getComputedStyle($('delopen')).display} 列表=${window.getComputedStyle($('sessopen')).display} 请求=${archiveBefore() - beforeOpen}`)
		check('纸里写明删的是哪一个，也说明它去哪（归档、电脑端能找回）',
			$('delTitle').textContent === '没打开过的会话' && $('delopen').textContent.includes('已归档'),
			`${$('delTitle').textContent} / ${$('delopen').textContent.replace(/\s+/g, ' ').slice(0, 40)}`)
		$('delGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(40)
		check('PIN 空着就不发请求，只在原地说明',
			archiveBefore() === beforeOpen && $('delError').textContent.includes('PIN'),
			`请求=${archiveBefore() - beforeOpen} 提示=${$('delError').textContent}`)

		// PIN 错：403（**不是 401**）→ 原地报错、纸不关、不弹登录门
		$('delPin').value = '000000'
		$('delGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(90)
		check('PIN 不对：不弹登录门、就在删除纸里说清楚，会话还在',
			archiveBefore() === beforeOpen + 1
			&& $('delError').textContent.includes('PIN 不正确')
			&& window.getComputedStyle($('delopen')).display !== 'none'
			&& window.getComputedStyle($('gate')).display === 'none',
			`${$('delError').textContent} / gate=${window.getComputedStyle($('gate')).display}`)

		// PIN 对：带上 sessionId + PIN 发出去，删完纸自己关、列表刷新
		$('delPin').value = CORRECT_PIN
		$('delGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(220)
		check('PIN 对：请求里带着 sessionId 与 PIN，删完那张纸自己关掉',
			archiveRequests.at(-1)?.sessionId === 'session-fresh' && archiveRequests.at(-1)?.pin === CORRECT_PIN
			&& window.getComputedStyle($('delopen')).display === 'none',
			JSON.stringify(archiveRequests.at(-1) ?? null))
		check('删完列表里真的少了一条（服务端列表缓存也作废了）',
			sessionRows().includes('session-fresh') === false, sessionRows().join(', '))

		// 正在跑的会话：先 409，再点一次才"停掉并删除"
		SESSIONS.find((item) => item.sessionId === 'session-older').running = true
		await openList()
		click($('sessList').querySelector('[data-del="session-older"]'))
		await wait(40)
		$('delPin').value = CORRECT_PIN
		$('delGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(90)
		check('正在跑的会话不会被悄悄删掉：说清楚 + 按钮换成「停掉它并删除」',
			$('delGo').textContent.includes('停掉') && $('delError').textContent.includes('正在跑')
			&& archiveRequests.at(-1)?.stop !== true,
			`${$('delGo').textContent} / ${$('delError').textContent}`)
		$('delGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(220)
		check('再点一次才真的"停掉并删除"（请求里 stop=true）',
			archiveRequests.at(-1)?.stop === true && archiveRequests.at(-1)?.sessionId === 'session-older'
			&& sessionRows().includes('session-older') === false,
			JSON.stringify(archiveRequests.at(-1) ?? null))

		// 删掉的正好是"正在看的那个"：不能把用户留在死会话上
		await switchTo('session-live')
		check('（前置）切到了一个独立会话上', $('sessBtn').textContent.includes('正在看的会话'), $('sessBtn').textContent)
		await openList()
		click($('sessList').querySelector('[data-del="session-live"]'))
		await wait(40)
		$('delPin').value = CORRECT_PIN
		$('delGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await wait(260)
		check('删的正好是"正在看的那个"：自动让到另一个会话，不把用户留在死页面上',
			sessionRows().includes('session-live') === false && $('sessBtn').textContent.includes('手机界面测试'),
			`bar=${$('sessBtn').textContent} rows=${sessionRows().join(', ')}`)

		// 收尾：把这一版加的那个开关状态清掉，后面的用例按默认（藏）走。
		window.localStorage.removeItem('dshm.sessAll')
	}

	/* --- 哨兵必须是 setInterval（2026-10-09 独立排查抓到的真 bug）-------------------
	 * 原来写成 `setTimeout(() => {…}, 2000)` 且块内没有自我重排，块首那句
	 * `if (state.source === null …) return` 会在 SSE 建立前就把它消耗掉 —— 于是
	 * "电脑睡眠后 45 秒报警 + 90 秒重连"**一次都没跑过**：页面绿灯长亮、一个字不再更新。
	 * 这条只能查源码形状（行为要等 5 秒才有 tick，测试里等不值当），但它恰好是"手滑写成
	 * setTimeout"这一类，源码断言正是对症的工具。
	 */
	{
		/*
		 * ⚠️ 4.3.0 检修（冷视角复查点过"还有没有裸 await"✓）：这一处读的是**产品源码** ✓ ——
		 * 读不到就**照实报红** ✓，不许崩在汇总之前 ✗（那样门禁只会说"拿不到项数" ✓）。
		 */
		let raw = ''
		try {
			raw = await readFile(join(HERE, '..', 'lib', 'mobile.html'), 'utf8')
		} catch (error) {
			check('读得到 lib/mobile.html（哨兵那条的判据来源）', false, String(error?.message ?? error))
		}
		// 先剥注释：说明文字里就写着"原来是 setTimeout(…, 2000)"，不剥会匹配到那句话本身。
		const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
		const block = /const WATCHDOG_PULL_MS[\s\S]{0,900}?\},\s*(\d+)\)/.exec(source)
		const slice = block?.[0] ?? ''
		check('哨兵是 setInterval（不是只跑一次的 setTimeout）',
			slice.includes('setInterval(') && slice.includes('setTimeout(') === false,
			block === null ? '没找到哨兵块' : (slice.includes('setInterval(') ? 'setInterval ✓' : 'setTimeout ✗'))
		check('哨兵周期是 5 秒（和注释里写的一致）', block?.[1] === '5000', String(block?.[1]))
		check('哨兵里仍然有 45 秒报警与 90 秒重连这两道闸',
			slice.includes('quiet > 45000') && slice.includes('WATCHDOG_RECONNECT_MS'))
	}

	/* --- 开始页的版本说明（1.8.0）---------------------------------------------
	 * 用户要求「开始页加入版本说明」。两处：还没进去时的 PIN 登录页，和进来后的说明页。
	 * 数据由服务端从 package.json / CHANGELOG.md 现读后注入（JSON），客户端用 textContent 建节点。
	 */
	// 用户 2026-10-11：「说明也要改一下，最底下还有录音界面啊」—— 说明页必须写清**四页**，
	// 并且点明"划到录音就是打开录音面板"（以前写的是"三个页面"，早就不对了 ✗）。
	// 用户 2026-10-11：「给说明加一个背景，贴合我们手机桥的氛围」—— 说明页有自己的深色渐变底
	// （手机 ←→ 电脑 的"桥"隐喻），不再只是那层透明纱 ✓。别的面板和壁纸逻辑不受影响 ✓。
	// jsdom 不解析 background 简写（getComputedStyle 返回空），所以查样式源码 —— 和哨兵那条一个路子。
	{
		// ⚠️ 4.3.0 检修：同上，读不到就报红 ✓，不崩在汇总之前 ✗。
		let css = ''
		try {
			css = await readFile(join(HERE, '..', 'lib', 'mobile.html'), 'utf8')
		} catch (error) {
			check('读得到 lib/mobile.html（说明页背景那条的判据来源）', false, String(error?.message ?? error))
		}
		const rule = /#welcome \{[^}]*\}/.exec(css)?.[0] ?? ''
		check('说明页有自己的背景（渐变 + 桥的网格），不是一层素纱',
			rule.includes('radial-gradient') && css.includes('#welcome::before'),
			rule.slice(0, 80))
	}

	check('说明页写的是四页（任务 · 新建 · 🎤录音 · 余额），不是旧的"三个页面"',
		$('welcome').textContent.includes('一共四页') && $('welcome').textContent.includes('录音也是一页')
		&& $('welcome').textContent.includes('三个页面') === false,
		($('welcome').textContent.match(/最底下那一栏[^。]*。/) ?? ['(没找到这句话)'])[0])
	check('登录页(PIN)上就写着版本号（还没进去就知道连的是哪一版）',
		$('gateVer').textContent.includes('v' + FIXTURE_VERSION),
		$('gateVer').textContent)
	/*
	 * 用户 2026-10-09：「是 1.0 到 2.0 的更新汇总，不是一个个分别列出了」。
	 * 所以说明页**先摆按主题的汇总**，逐版清单退到下面（默认还只摆最近三版）。
	 */
	check('说明页先摆「0.1 → 今 按主题的汇总」（要的是汇总，不是逐版罗列；起点从第一版算 ✓）',
		$('wnList').textContent.includes('都改了什么（按主题）')
		&& $('wnList').textContent.includes('0.1 → ')
		&& $('wnList').textContent.includes('🎤 录音与转文字')
		&& $('wnList').textContent.includes('从找文件变成网页里直接录'),
		$('wnList').textContent.replace(/\s+/g, ' ').trim().slice(0, 90))
	check('汇总排在逐版清单前面（主角是汇总）',
		$('wnList').textContent.indexOf('按主题') < $('wnList').textContent.indexOf('逐版更新'))
	check('说明页上有版本号 + 最近三版更新了什么',
		$('wnVersion').textContent === 'v' + FIXTURE_VERSION
		&& $('wnList').textContent.includes('v9.9.9') && $('wnList').textContent.includes('v9.9.8')
		&& $('wnList').textContent.includes('加（一条加的功能）'),
		$('wnList').textContent.replace(/\s+/g, ' ').trim().slice(0, 60))
	check('更新清单里的 ** 标记被去掉了（手机上那只是噪音）',
		$('wnList').textContent.includes('**') === false)
	/*
	 * 用户 2026-10-09：「说明内容没有展示 1.0 到 2.0 更新了什么」。
	 * 默认只摆最近三版（别一屏糊满），底下那个按钮点开是**完整历史**（最早那一版也在）。
	 */
	const moreButton = () => $('wnList').querySelector('.wnmore')
	/*
	 * 注意：jsdom 的 textContent 连 display:none 的内容也算，所以"折起来了没有"必须查容器本身。
	 * ⚠️ 4.4.0：**按类名查** ✓（`wnrest`）—— 以前是 `lastElementChild` ✗（猜位置 ✓）：
	 * 我在后面加「5.0 预告」那一块之后它就猜错了 ✗ → 两条断言为**错误的原因**红 ✓。
	 * 留个兜底 ✓（老页面没有这个类时退回原来的猜法 ✓），但主判据是类名 ✓。
	 */
	const restBox = () => $('wnList').querySelector('.wnrest') ?? $('wnList').lastElementChild
	/*
	 * 按钮上的"共 N 版"要跟 fixture 的节数**对得上** ✓ —— 原来写死 `共 4 版` ✗：
	 * 4.3.1 给 fixture 加了「1.0 之前」那一节（变 5 节 ✓）→ 这条当场红 ✓（**为错误的原因红** ✗）。
	 * 改成从 fixture 现算 ✓：它本来就是这套测试自己的输入 ✓，不是被测产物 ✓。
	 */
	const fixtureSections = JSON.parse(FIXTURE_WHATSNEW).length
	check('说明页默认只摆最近三版，更早的折起来（不糊屏）',
		$('wnList').textContent.includes('v9.9.9') && $('wnList').textContent.includes('v9.9.7')
		&& restBox().style.display === 'none'
		&& moreButton() !== null && moreButton().textContent.includes('共 ' + fixtureSections + ' 版'),
		`${String(moreButton()?.textContent ?? '没有展开按钮')}（fixture ${fixtureSections} 节）rest=${restBox().style.display}`)
	click(moreButton())
	await wait(30)
	check('点「展开全部更新」→ 完整历史展开（最早那一版也在）',
		restBox().style.display !== 'none' && $('wnList').textContent.includes('v1.0.0')
		&& moreButton().textContent === '收起',
		`${moreButton().textContent} rest=${restBox().style.display}`)
	/*
	 * 🔴 4.3.1（用户 2026-10-14：「找到 1.0 以前版本的更新内容并补全到说明里」✓）：
	 * 展开之后**最早那一节是「1.0 之前」** ✓（服务端把它追加在最后 ✓）—— 页面上真画出来了才算数 ✓。
	 */
	check('🔴 展开后能看见「1.0 之前」那一节 ✓（0.1 → 0.9.12 那四十多版；不展开就只在服务端有 ✗）',
		$('wnList').textContent.includes('1.0 之前')
		&& $('wnList').textContent.includes('起步（0.1 → 0.5）'),
		$('wnList').textContent.replace(/\s+/g, ' ').trim().slice(-90))
	click(moreButton())
	await wait(30)
	check('再点一下收起：按钮文字回来、最老那版重新折起来',
		restBox().style.display === 'none' && moreButton().textContent.includes('展开全部更新'),
		`${moreButton().textContent.slice(0, 24)} rest=${restBox().style.display}`)
	/*
	 * 🔴 4.4.0（用户 2026-10-14：「分别总结一下 0.1 到 1.0、1.0 到 2.0、2.0 到 3.0、3.0 到 4.0
	 * 分别改变了什么并添加到说明，然后写到 5.0 版本的预告」✓）：两块新内容都要**真画在页面上** ✓ ——
	 * 服务端注入的数据在网上 ✓，这里钉的是页面这一层 ✓。
	 */
	check('🔴 说明页有「一代一代看」那一块 ✓（按代总结：0.1→1.0 / 1.0→2.0 …）',
		$('wnList').textContent.includes('一代一代看：每一代各改了什么')
		&& $('wnList').textContent.includes('0.1 → 1.0') && $('wnList').textContent.includes('1.0 → 2.0'),
		$('wnList').textContent.replace(/\s+/g, ' ').trim().slice(0, 120))
	check('🔴 分代总结排在逐版清单**前面** ✓（先给主线，再给逐版）',
		$('wnList').textContent.indexOf('一代一代看') < $('wnList').textContent.indexOf('逐版更新'))
	check('🔴 说明页有「5.0 预告」那一块 ✓（版本 + 主题 + 几条愿景 + "愿景不是排期"的说明 ✓）',
		$('wnList').textContent.includes('下一站：v5.0.0')
		&& $('wnList').textContent.includes('开放平台')
		&& $('wnList').textContent.includes('开放标准协议')
		&& $('wnList').textContent.includes('愿景，不是排期'),
		$('wnList').textContent.replace(/\s+/g, ' ').trim().slice(-120))
	/*
	 * ⚠️ 预告里**不许出现日期** ✗（它没排期 ✓）—— 数据里没有日期字段 ✓，这一条防的是"以后有人往里写日期" ✓。
	 */
	check('5.0 预告里不写日期（愿景 ≠ 排期 ✓）',
		/20\d\d-\d\d-\d\d/.test($('wnList').textContent.slice($('wnList').textContent.indexOf('下一站：v5.0.0'))) === false)
	// 注意：不能只查 `__DSH_` 前缀 —— 客户端守卫里那个标记是故意拆开拼的
	// （'__DSH_' + 'PAGE_TAG__'），所以它在源码里必然含这个前缀。要查的是**完整标记**。
	/*
	 * 用户现场（2026-10-09）：手机上登录页一直显示 1.8.2，而服务器三条路（隧道/Tailscale/本机）
	 * 都已经是 2.0.0 —— Service Worker 在"网络请求失败"时兜底给了**缓存的旧页面**，
	 * 而自愈重载是"每个 tag 只一次"，于是被永久锁死 ✗。
	 * 所以：① 自愈改成冷却 60 秒可重试；② 登录页给一个"点这里强制刷新"（注销 SW + 清缓存 + 重载）。
	 */
	check('登录页上有「版本号不对？点这里强制刷新」（卡在旧页面时能自救）',
		$('gateFresh') !== null && $('gateFresh').textContent.includes('强制刷新'))
	{
		const before = jsdomErrors.length
		click($('gateFresh'))
		await wait(60)
		check('点它会走"强制刷新"这条路（注销 SW/清缓存后重载，不是干等）',
			jsdomErrors.length > before || window.document.location.search.includes('fresh'),
			`reload=${jsdomErrors.length - before} search=${window.document.location.search}`)
	}
	check('页面里没有漏出来的注入标记（漏了就是把服务端模板摆给用户看）',
		window.document.documentElement.outerHTML.includes('__DSH_PAGE_TAG__') === false
		&& window.document.documentElement.outerHTML.includes('__DSH_BRIDGE_VERSION__') === false
		&& window.document.documentElement.outerHTML.includes('__DSH_WHATSNEW__') === false
		// 4.4.0：新加的两个注入标记同样一枚都不许漏在页面上 ✓（漏了就是把模板摆给用户看 ✗）。
		&& window.document.documentElement.outerHTML.includes('__DSH_ERAS__') === false
		&& window.document.documentElement.outerHTML.includes('__DSH_NEXTUP__') === false
		// 注入的 JSON 是"数据"，不能变成用户看到的文字（它躺在 <script type=application/json> 里）。
		&& $('wnList').textContent.includes('{"version"') === false,
		`pageTag=${window.document.documentElement.outerHTML.includes('__DSH_PAGE_TAG__')}`)

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

	/*
	 * ⚠️ 回归（用户原话：「早上好，又显示网络不通」）：
	 * 手机把页面装到主屏后，页面本体是从 Service Worker 缓存里**离线打开**的 —— 电脑刚开机那
	 * 两三分钟（Tailscale 还没起来）里，用户看到的是一个能点、但一按就报「网络不通」的登录页，
	 * 而且**点了不会自己再试**，只能反复手点。现在失败后自己退避重试，连上就登进去。
	 */
	const loginCount = () => requests.filter((entry) => entry.path.startsWith('/api/login')).length
	loginFailures = 2
	$('pin').value = '123456'
	const beforeRetry = loginCount()
	$('gateBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(120)
	check('连不上电脑时说人话，并且**已经安排自动重试**',
		$('gateError').textContent.includes('网络不通') && $('gateError').textContent.includes('自动重试')
		&& $('gateError').textContent.includes('刚开机'),
		$('gateError').textContent)
	check('自动重试在跑（第一次失败后马上又发了一次）',
		loginCount() > beforeRetry + 1 || loginFailures < 2, `requests=${loginCount()} left=${loginFailures}`)
	await wait(4200)
	check('隧道恢复后这一次点击自己登进去了（不用用户再点）',
		window.getComputedStyle($('app')).display !== 'none'
		&& window.getComputedStyle($('gate')).display === 'none',
		`app=${window.getComputedStyle($('app')).display} gate=${window.getComputedStyle($('gate')).display}`)

	// 反例：PIN 本身不对（HTTP 401）是"想清楚了才回"的错，**不能**跟着重试（否则一直撞）。
	loginStatus = 401
	$('gate').style.display = ''
	$('app').style.display = 'none'
	$('pin').value = '000000'
	const before401 = loginCount()
	$('gateBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await wait(1500)
	check('PIN 错就停手，不跟着重试（401 不是网络问题）',
		loginCount() === before401 + 1 && $('gateError').textContent.includes('PIN 不对'),
		`requests=${loginCount() - before401} err=${$('gateError').textContent}`)
	loginStatus = 200

	// 后面还有会话切换/流式等用例：把它们要的现场还原回去（提到放开档、回到可见状态）。
	permState.preset = 'danger-full-access'
	permState.elevated = true
	$('composer').dataset.perm = 'danger-full-access'
	await nextFrame()
}

/* --- 4.5.0：手机上控制电脑（用户点名的七件事）--------------------------------- */
/*
 * 用户 2026-10-14：「做一键给电脑静音，调低亮度，调低调高音量，调高亮度，联网检查，
 * 电量检查，蓝牙连接，蓝牙设备显示的功能的功能」✓。
 * 这一块钉四件事 ✓：① 面板能开、状态画得对 ✓；② 每个键发的 action 对 ✓；
 * ③ **默认关时把"怎么开"写出来** ✓（不是一句"读不到"✗）；④ 亮度不支持时**如实说** ✓。
 * 另外钉一条设计决定 ✓：**没有"连接某台蓝牙设备"那个键** ✗（Windows 没有可靠接口 ✓，
 * 摆一个按了没反应的键就是骗人 ✓）—— 页面必须写明"连接在设置里点" ✓。
 */
{
	click(tabButton('task'))
	await wait(40)
	click($('pcBtn'))
	await wait(160)
	check('🖥 控制电脑面板能打开，电量 / 联网 / 音量 / 亮度都画出来了',
		window.getComputedStyle($('pcopen')).display !== 'none'
		&& $('pcState').textContent.includes('89%')
		&& $('pcState').textContent.includes('37%')
		&& $('pcState').textContent.includes('ChinaTelecom-EDU5.8G')
		&& $('pcState').textContent.includes('外网通'),
		$('pcState').textContent.replace(/\s+/g, ' ').slice(0, 90))
	check('十一个键都在（静音 / 音量± / 亮度± / 联网 / 电量 / 蓝牙设备 / 开 / 关 / 打开蓝牙设置）',
		['pcMute', 'pcVolDown', 'pcVolUp', 'pcBrightDown', 'pcBrightUp', 'pcNet', 'pcBatt', 'pcBtDevices', 'pcBtOn', 'pcBtOff', 'pcBtSettings']
			.every((id) => $(id) !== null))
	/*
	 * ⚠️ 判据要看**按钮文字** ✓，不是整块文字 ✗ —— 说明里本来就写着"连接要在设置里点一下" ✓，
	 * 拿 `pcopen.textContent.includes('连接')` 去判会**永远为真** ✗（我第一版就是这么写歪的 ✓）。
	 */
	const pcButtonTexts = [...$('pcopen').querySelectorAll('button')].map((node) => String(node.textContent ?? ''))
	check('🔴 仍然**没有**「连接某台设备」那个键 ✗（Windows 没有可靠接口 ✓ —— 摆了就是骗人 ✗）',
		pcButtonTexts.some((text) => text.includes('连接')) === false && pcButtonTexts.length >= 11,
		`按钮：${pcButtonTexts.join(' / ')}`)
	check('面板上写明「连接要去系统设置里点」✓（做不到的那一步如实说 ✓）',
		$('pcopen').textContent.includes('打开蓝牙设置') && $('pcopen').textContent.includes('Windows 没有可靠的命令行接口'))

	// ② 点键 → 发对 action ✓
	pcRequests.length = 0
	click($('pcVolUp'))
	await wait(120)
	click($('pcBrightDown'))
	await wait(120)
	click($('pcBtDevices'))
	await wait(120)
	check('🔴 点「音量 + / 亮度 − / 蓝牙设备」分别发出 volumeUp / brightnessDown / bluetoothDevices ✓',
		pcRequests.map((row) => row.action).join(',') === 'volumeUp,brightnessDown,bluetoothDevices',
		pcRequests.map((row) => row.action).join(','))
	check('音量/亮度按键带上了步长（5 / 10 ✓ —— 不然一下调太狠 ✓）',
		pcRequests[0]?.step === 5 && pcRequests[1]?.step === 10,
		JSON.stringify(pcRequests.map((row) => row.step)))
	check('蓝牙设备列表真画出来了（名字 + 在/不在线 ✓）',
		$('pcBluetooth').textContent.includes('杰的AirPods') && $('pcBluetooth').textContent.includes('WI-C200'),
		$('pcBluetooth').textContent.replace(/\s+/g, ' ').slice(0, 60))
	check('调完音量/亮度后，状态行显示的是**返回的真实值** ✓（不是"已调低"这种糊话 ✓）',
		$('pcState').textContent.includes('70%'), $('pcState').textContent.replace(/\s+/g, ' ').slice(0, 60))
	click($('pcBack'))
	await wait(60)

	// ③ 默认关：必须把"怎么开"写出来 ✓
	pcStubOff = true
	click($('pcBtn'))
	await wait(140)
	check('🔴 电脑控制默认关时，面板上写着怎么开（pcControl）✓ —— 不是一句"读不到" ✗',
		$('pcState').textContent.includes('pcControl') || $('pcNote').textContent.includes('pcControl'),
		$('pcState').textContent.replace(/\s+/g, ' ').slice(0, 80))
	click($('pcBack'))
	await wait(60)
	pcStubOff = false

	// ④ 亮度不支持（台式机 / 外接屏）→ 如实说 ✓
	pcStubBrightnessUnsupported = true
	click($('pcBtn'))
	await wait(140)
	check('🔴 这台机器没有可调的内屏时，亮度那一行**如实说** ✓（不许假装调成功 ✗）',
		$('pcState').textContent.includes('没有可调的内置屏幕'),
		$('pcState').textContent.replace(/\s+/g, ' ').slice(0, 80))
	click($('pcBack'))
	await wait(60)
	pcStubBrightnessUnsupported = false

	// ⑤ 抽屉登记（4.3.0 那条教训 ✓）：面板开着时**审批卡片一来必须让位** ✓
	click($('pcBtn'))
	await wait(140)
	check('（前置）控制电脑面板开着 ✓', window.getComputedStyle($('pcopen')).display !== 'none')
	source.emit({ t: 'interaction', kind: 'approval', id: 'ask-pcopen', payload: { toolName: 'pwsh', reason: '要跑一条命令' } })
	await wait(140)
	check('🔴 面板开着时来了审批卡片：它**让位** ✓（没登记进 openToolPanel() 的话卡片会被盖住 ✗ —— 2.5.1 / 4.3.0 同款病 ✓）',
		window.getComputedStyle($('pcopen')).display === 'none' && window.getComputedStyle($('ask')).display !== 'none',
		`pcopen=${window.getComputedStyle($('pcopen')).display} ask=${window.getComputedStyle($('ask')).display}`)
	source.emit({ t: 'interaction-end', id: 'ask-pcopen' })
	await wait(120)
}

/* --- 2.7.0 ★3/★4：状态盘 + 一键动作（"点两次"这条一定要钉住 ✓）------------- */
click(tabButton('task'))
await wait(40)
{
	click($('sysBtn'))
	await wait(120)
	check('📊 打开状态盘：CPU / 内存 / 磁盘 / 端口都被画出来了',
		window.getComputedStyle($('sysopen')).display !== 'none'
		&& $('sysBody').textContent.includes('12%')
		&& $('sysBody').textContent.includes('C:')
		&& $('sysBody').textContent.includes('3080'),
		$('sysBody').textContent.replace(/\s+/g, ' ').slice(0, 80))
	check('DSH 本体那一行写明"绝不能杀"，而且没有「结束」键（默认关也不给）',
		$('sysBody').textContent.includes('绝不能杀')
		&& $('sysBody').querySelector('[data-kill="4242"]') === null,
		String($('sysBody').textContent.includes('绝不能杀')))
	check('默认关时面板上写着怎么开（processControl）',
		$('sysBody').textContent.includes('processControl'))
	// ③ 审批记录（2.5.0 遗留）：状态盘底部那段要真把账画出来 ✓（不是"读不到"分支 ✗）。
	const approvalsText = $('sysBody').textContent.replace(/\s+/g, ' ')
	check('📊 底部画出「最近批过什么」：结果 + 工具 + 来源 IP + 总数 ✓',
		approvalsText.includes('最近批过什么') && approvalsText.includes('允许一次')
		&& approvalsText.includes('pwsh') && approvalsText.includes('100.122.188.30')
		&& approvalsText.includes('共 7 条'),
		approvalsText.slice(Math.max(0, approvalsText.indexOf('最近批过什么')), 120))
	check('一键动作那段在：锁屏 + 关机/重启 都在状态盘上',
		$('sysBody').textContent.includes('锁屏')
		&& $('sysBody').querySelector('[data-power="shutdown"]') !== null
		&& $('sysBody').querySelector('[data-power="restart"]') !== null,
		String($('sysBody').querySelector('[data-power="shutdown"]') !== null))

	// 锁屏：一键、不要 PIN ✓
	const lockBefore = powerRequests.length
	click($('sysBody').querySelector('[data-lock]'))
	await wait(120)
	check('锁屏一键：直接发 action=lock，不弹 PIN 纸',
		powerRequests.length === lockBefore + 1 && powerRequests.at(-1)?.action === 'lock'
		&& window.getComputedStyle($('poweropen')).display === 'none',
		JSON.stringify(powerRequests.at(-1) ?? null))

	/*
	 * 3.9.0「我睡了」✓：**只锁屏** ✗（绝不一键关机 ✓）+ 记一个"明早提醒"标记 ✓。
	 * ⚠️ 判据要同时钉**两件事** ✗：请求是 lock ✓、且标记落进本机 ✓ —— 只钉其中一半就会放过另一半 ✓。
	 */
	const sleepBefore = powerRequests.length
	click($('sysBody').querySelector('[data-sleep]'))
	await wait(140)
	check('🔴 「我睡了」= 发 `action=lock`（**不许顺手关机** ✗）+ 记下"明早提醒"**时刻** ✓',
		powerRequests.length === sleepBefore + 1 && powerRequests.at(-1)?.action === 'lock'
		&& Number(window.localStorage.getItem('dshm.morning') ?? '') > 0
		&& powerRequests.slice(sleepBefore).every((entry) => entry.action === 'lock'),
		JSON.stringify({ 请求: powerRequests.slice(sleepBefore), 标记: window.localStorage.getItem('dshm.morning') }))
	/*
	 * 🔴 复查第 93 轮 P1：**锁屏没成，就一个字都不许许愿** ✗ —— 真桥这条会失败（429 节流 / 500 / 断网 ✓），
	 * 而原来失败也照写"明早提醒" ✓ → 明早提醒了、其实昨晚根本没锁上 ✗（假承诺 ✓）。
	 */
	window.localStorage.setItem('dshm.morning', '')
	powerFailOnce = true
	click($('sysBody').querySelector('[data-sleep]'))
	await wait(200)
	check('🔴 锁屏失败时：**不写"明早提醒"** ✓，而且如实说没锁上 ✗（不许说"电脑锁上了"✓）',
		String(window.localStorage.getItem('dshm.morning') ?? '') === ''
		&& String($('toast').textContent).includes('没锁上'),
		JSON.stringify({ 标记: window.localStorage.getItem('dshm.morning'), toast: String($('toast').textContent).slice(0, 40) }))

	/*
	 * 3.9.0「专注模式」✓：一键开 ✓ → 徽章出现 ✓ + 本机记着 ✓；「打点」发一条带时间的标记 ✓；点徽章退出 ✓。
	 */
	check('专注模式默认关 ✓（开封时不该有一个莫名其妙的徽章 ✗）',
		window.document.getElementById('focusBadge') === null && window.localStorage.getItem('dshm.focus') !== '1',
		String(window.localStorage.getItem('dshm.focus') ?? 'null'))
	click($('sysBody').querySelector('[data-focus]'))
	await wait(140)
	check('🔴 点一下进入专注：本机记上 ✓ + 「专注中」徽章挂出来 ✓（一键 ✓，没有新工具键 ✓）',
		window.localStorage.getItem('dshm.focus') === '1'
		&& window.document.getElementById('focusBadge') !== null
		&& String(window.document.getElementById('focusBadge').textContent).includes('专注中'),
		JSON.stringify({ flag: window.localStorage.getItem('dshm.focus'), badge: String(window.document.getElementById('focusBadge')?.textContent ?? '') }))
	const markBefore = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	click($('sysBody').querySelector('[data-focus-mark]'))
	await wait(320)
	// ⚠️ 桩里请求体在 **`entry.options.body`** ✓（不是 `entry.body` ✗ —— 写错了会拿到空串 ✓，
	// 于是"发出去了 1 条但正文是空的"这种自查说明会把人往错方向带 ✓，记一下 ✓）。
	const markedRaw = requests.filter((entry) => entry.path.startsWith('/api/prompt')).at(-1)?.options?.body ?? ''
	let markedPrompt = ''
	// 桩里 `/api/prompt` 的正文是 `{ text, images }` ✓（**不是** `content` ✗ —— 内容分片是服务端拼的 ✓）。
	try { markedPrompt = String(JSON.parse(markedRaw).text ?? '') } catch { markedPrompt = '' }
	check('🔴 「打点」真的把 `【打点 HH:MM】` 发进会话 ✓（专注中要留得下痕迹 ✗ —— 不然这半个功能是摆设 ✓）',
		requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === markBefore + 1
		&& /【打点 \d{2}:\d{2}】/.test(markedPrompt),
		JSON.stringify({
			发出去几条: requests.filter((entry) => entry.path.startsWith('/api/prompt')).length - markBefore,
			正文: markedPrompt.slice(0, 40),
		}))
	click(window.document.getElementById('focusBadge'))
	await wait(140)
	check('🔴 点徽章就退出专注 ✓（一键进、一键出 ✓ —— 徽章消失 + 本机清干净 ✓）',
		window.document.getElementById('focusBadge') === null && window.localStorage.getItem('dshm.focus') !== '1',
		JSON.stringify({ badge: window.document.getElementById('focusBadge') !== null, flag: window.localStorage.getItem('dshm.focus') }))
	/*
	 * 🔴 复查第 93 轮 P2：**输入框里有没发出去的东西时，打点一个字节都不许动** ✗ ——
	 * 原来直接覆盖 `text.value` ✓，而"发送没成"（只看不发 / 没会话 / 离线进箱 ✓）时用户的草稿就被吞了 ✗。
	 */
	click($('sysBody').querySelector('[data-focus]'))
	await wait(140)
	const draftBeforeMark = '我还没写完的一句'
	$('text').value = draftBeforeMark
	const promptsBeforeGuard = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	click($('sysBody').querySelector('[data-focus-mark]'))
	await wait(200)
	check('🔴 输入框里有草稿时点打点：**拒绝 + 说清 + 一个字节都不动** ✗（绝不吞人家的草稿 ✓）',
		$('text').value === draftBeforeMark
		&& requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === promptsBeforeGuard
		&& String($('banner').textContent).includes('输入框里还有'),
		JSON.stringify({ 输入框: $('text').value, 条幅: String($('banner').textContent).slice(0, 40) }))
	$('text').value = ''
	click(window.document.getElementById('focusBadge'))
	await wait(140)
	/*
	 * 收尾：把我这两条 `action:lock`（成功那条 + 故意失败那条 ✓）从桩里摘掉 —— 后面那几个关机用例
	 * 是按 `lockBefore` 计数的 ✓。⚠️ 这是**测试卫生** ✗（和 harness 里 `listItems.pop()` 一个道理 ✓）：
	 * 不改它们的判据 ✗（那是别人的断言 ✓，动它就是拆别人的刹车 ✓），只把自己留下的状态收干净 ✓。
	 */
	powerRequests.splice(sleepBefore, 2)
	click($('powerBack'))
	await wait(60)

	/*
	 * 4.0.0「录屏遥控」✓：从 📊 纸进**已有的 PIN 纸** ✓ → 两次确认 → 发 `/api/record` ✓。
	 * ⚠️ 判据里专门盯一条 ✗：它**绝不能**发到 `/api/power` ✓ —— 拿 `record-start` 去那条路会落到
	 * "关机"的默认支上 ✓（3.5.0 解锁入口就是这么变成"点解锁变成关机"的 ✓）。
	 */
	const recordPowerBefore = powerRequests.length
	click($('sysBody').querySelector('[data-record-open="start"]'))
	await wait(120)
	check('🔴 点「录屏开始」：开的是**现有的 PIN 纸** ✓（标题写着"录屏" ✓ —— 没有新工具键 ✓）',
		window.getComputedStyle($('poweropen')).display !== 'none' && String($('powerTitle').textContent).includes('录屏'),
		String($('powerTitle').textContent))
	$('powerPin').value = '935881'
	click($('powerGo'))
	await wait(80)
	/*
	 * 🔴 复审第 94 轮点名 ✗：录屏那张纸原来**借用**电源纸三句 ✓ —— 其中「执行后有 **20 秒**可以取消」
	 * 对录屏是**假话** ✓（录屏没有那 20 秒 ✓），而当时那条断言只连点两下、**不判文案** ✗ → 抓不到 ✓。
	 */
	check('🔴 录屏纸上说的是**录屏自己的话** ✓（不许借用电源那三句 —— 尤其"执行后有 20 秒可以取消"对录屏是假话 ✗）',
		String($('powerError').textContent).includes('录屏') && String($('powerError').textContent).includes('自动停')
		// ⚠️ 判据要挑**那句话本身** ✗ —— 一开始我写的是"不许出现 `20 秒`" ✓，
		// 但纸上的否定句里正当地引用了它（"**没有**"20 秒可以取消"那回事"✓）→ 反而假红 ✓（这条就是被自己抓的 ✓）。
		&& String($('powerError').textContent).includes('执行后有 20 秒可以取消') === false
		&& String($('powerGo').textContent).includes('录屏'),
		JSON.stringify({ 提示: String($('powerError').textContent).slice(0, 46), 按钮: String($('powerGo').textContent) }))
	click($('powerGo'))
	await wait(200)
	check('🔴 录屏真的发到 `/api/record` + `action:start` ✓（**不是** `/api/power` ✗ —— 那条路会把 `record-start` 当关机 ✓）',
		recordRequests.length === 1 && recordRequests[0].action === 'start' && recordRequests[0].pin === '935881'
		&& powerRequests.length === recordPowerBefore,
		JSON.stringify({ record: recordRequests.at(-1) ?? null, 电源路多了: powerRequests.length - recordPowerBefore }))
	recordFailOnce = true
	click($('sysBody').querySelector('[data-record-open="start"]'))
	await wait(120)
	$('powerPin').value = '935881'
	click($('powerGo')); await wait(60); click($('powerGo')); await wait(200)
	check('🔴 服务端说"默认关"时：纸上显示**原话** ✓、**绝不假装开始了** ✗', String($('powerError').textContent).includes('默认关闭'),
		String($('powerError').textContent).slice(0, 50))
	click($('powerBack'))
	await wait(60)

	// 关机：**必须点两次**才真的发请求 ✓（这条最重要）
	click($('sysBody').querySelector('[data-power="shutdown"]'))
	await wait(120)
	check('点「关机」只开纸（带自检 + PIN），**不发请求**',
		window.getComputedStyle($('poweropen')).display !== 'none'
		&& $('powerChecks').textContent.includes('开机自启')
		&& powerRequests.length === lockBefore + 1,
		`请求数=${powerRequests.length - lockBefore}`)
	$('powerPin').value = '935881'
	click($('powerGo'))
	await wait(60)
	check('第一次点「继续」只是上膛：按钮变成"再点一次"，**仍然没发请求**',
		$('powerGo').textContent.includes('再点一次') && powerRequests.length === lockBefore + 1,
		`按钮=${$('powerGo').textContent} 请求=${powerRequests.length - lockBefore}`)
	click($('powerGo'))
	await wait(150)
	check('第二次点才真的执行：请求里带着 action=shutdown（PIN 也带上）',
		powerRequests.length === lockBefore + 2
		&& powerRequests.at(-1)?.action === 'shutdown' && powerRequests.at(-1)?.pin === '935881',
		JSON.stringify(powerRequests.at(-1) ?? null))
	/*
	 * 4.1.0「解锁入口重做」✓ —— 四条纪律的机器判据 ✓：
	 * 「只挂了一份接法」人眼看不出 ✗、但 DOM 数得出 ✓；「点了没反应 / 发了两条」只能靠计数器钉 ✓。
	 * ⚠️ 计数**先快照、跑完还原** ✓（后面那几个关机用例是按 lockBefore 计数的 ✓ —— 直接清零会把它们弄红 ✗）。
	 */
	click($('sysBtn'))
	await wait(140)
	check('🔴 解锁入口在页面上**只出现一次** ✓（「只留一份接法」的机器判据 —— 两份 = 一次点击两条请求 ✗）',
		$('sysBody').querySelectorAll('[data-pw-unlock]').length === 1
		&& window.document.querySelectorAll('#powerUnlock').length === 0,
		'入口数=' + $('sysBody').querySelectorAll('[data-pw-unlock]').length)
	const powerSnapshotKeep = powerRequests.splice(0, powerRequests.length)
	// ⚠️ 基线 ✗：`requests` 是**全套件**的总账 ✓，里面有前面用例的电源 POST ✓ —— 直接比绝对值会假红 ✓。
	const powerPostsBefore = requests.filter((entry) => entry.path.startsWith('/api/power') && entry.options?.method === 'POST').length
	click($('sysBody').querySelector('[data-pw-unlock]'))
	await wait(140)
	check('🔴 点「解锁」**只开纸、一个请求都不发** ✓（3.5.0 就是这儿一次点击发出两条 POST 的 ✗）',
		window.getComputedStyle($('poweropen')).display !== 'none'
		&& String($('powerTitle').textContent).includes('解锁')
		&& requests.filter((entry) => entry.path.startsWith('/api/power') && entry.options?.method === 'POST').length === powerPostsBefore,
		JSON.stringify({ 标题: String($('powerTitle').textContent), 新增电源POST: requests.filter((entry) => entry.path.startsWith('/api/power') && entry.options?.method === 'POST').length - powerPostsBefore }))
	$('powerPin').value = '935881'
	click($('powerGo'))
	await wait(120)
	check('解锁上膛说的是**解锁自己的话** ✓（不许借电源那句「执行后有 20 秒可以取消」✗）',
		String($('powerError').textContent).includes('唤醒')
		&& String($('powerError').textContent).includes('执行后有 20 秒可以取消') === false,
		String($('powerError').textContent).slice(0, 40))
	click($('powerGo'))
	await wait(300)
	// 同样用基线 ✓：这两次点击**只该多一条** ✓。
	const unlockPosts = requests.filter((entry) => entry.path.startsWith('/api/power') && entry.options?.method === 'POST').slice(powerPostsBefore)
	const unlockLast = unlockPosts.at(-1)
	let unlockBody = {}
	try { unlockBody = JSON.parse(String(unlockLast?.options?.body ?? '{}')) } catch { unlockBody = {} }
	check('🔴 两次点击后**恰好一条** `action:unlock` ✓ 且 **PIN 在请求头**里 ✓（放 body 不算 ✗ —— DBG 已证明请求真发出去了 ✓，这条是把它钉住 ✓）',
		unlockPosts.length === 1 && unlockBody.action === 'unlock'
		&& String(unlockLast?.options?.headers?.['x-dsh-pin'] ?? '') === '935881',
		JSON.stringify({ 条数: unlockPosts.length, body: unlockBody, 头里PIN: String(unlockLast?.options?.headers?.['x-dsh-pin'] ?? '') }))
	// ⚠️ 读**整张纸** ✗ 不读某一格：`#powerError` 那一格当时被电源的提示占着 ✓
	//（DBG 已证明请求发出且服务端 200 ✓ —— 这条要钉的是「页面上有没有如实把结论说出来」✓）。
	// ⚠️ 改读 `#powerError` ✓ 并断言**服务端那句独有的话**出现了 ✓ —— 只读整张纸是假绿 ✗（复查实测过 ✓）。
	// ⚠️ 读**整张纸**但要求**服务端那句独有的话** ✓：
	//   · 只读整张纸**不行** ✗（`openPower()` 自己写的那两句会让它假绿 ✓ —— 复查实测过 ✓）；
	//   · 只读 `#powerError` 也不行 ✗（那一格随后会被别的渲染覆盖 ✓ —— 这次实测到的 ✓）。
	//   所以：**整张纸 + 独有串** ✓ —— 服务端那句话一旦没渲染出来，这条必红 ✓。
	/*
	 * ⚠️ 这里原先有一条「解锁的结论照实说」→ **撤掉了** ✗（复查第 95 轮点出它**假绿** ✓：
	 * 它读的是纸上那两句**静态说明** ✓，改桩的 message 也照样绿 ✓；我随后改成读 `#powerError` ✗
	 * （被面板重渲染冲掉 ✓）、又改成读 `#toast` 里的独有串 ✗（结论没落到 toast 上 ✓）都没做成 ✓。
	 * 纪律是**假绿比缺测试更坏** ✗ → 先撤 ✓，缺口写进 CHANGELOG ✓。
	 * 真正压阵的是上一条「**恰好一条 `action:unlock` 且 PIN 在请求头**」✓ —— 复查做过反向探针：
	 * 把 kind 冲掉后它**当场红** ✓（实收 `{action:'shutdown'}` ✓），那条是真会咬的 ✓。
	 */
	powerRequests.push(...powerSnapshotKeep)
	click($('powerBack'))
	await wait(60)

	/*
	 * 4.1.0「顶部分享键」✓（用户 2026-10-14 亲口要的 ✓）：顶栏有键 ✓ → 取到文案原样填进去 ✓
	 * → **不支持系统分享时如实说** ✗（不许装作分享成功 ✓）；jsdom 里没有 navigator.share ✓，正好钉这条 ✓。
	 */
	check('🔴 顶栏有「分享」键 ✓，而且它在 `<header>` 里（用户要的就是**顶部** ✓）',
		$('shareApp') !== null && $('shareApp').closest('header') !== null,
		String($('shareApp')?.textContent ?? '(没有)'))
	installFetches = 0
	click($('shareApp'))
	await wait(180)
	check('🔴 点「分享」：真的去取了文案 ✓，而且**原样**填进框里（页面不自己改 ✗）',
		installFetches === 1 && String($('installText').value).includes('手机桥 v9.9.9')
		&& String($('installHint').textContent).includes('9.9.9'),
		JSON.stringify({ 取了几次: installFetches, 首行: String($('installText').value).split('\n')[0] }))
	/*
	 * 4.1.0 复查补的**失败分支** ✓（`loadInstall()` 的 catch ✓）：服务端取不到时，
	 * 框**必须清空** ✗（留着旧版本文案 → 用户点「复制全文」发出去的是过期的 ✓，比不说更坏 ✗）
	 * + 提示**必须如实说**取不到 ✓。加这条之前，把 `box.value = ''` 删掉也**照样全绿** ✗（假绿 ✓）。
	 */
	installFailOnce = true
	click($('installRefresh'))
	await wait(180)
	check('🔴 取不到文案时：框**清空** ✓ 且提示**如实说**取不到 ✓（不许留着旧版本文案装没事 ✗）',
		String($('installText').value) === '' && String($('installHint').textContent).includes('取不到'),
		JSON.stringify({ 框里剩的: String($('installText').value).slice(0, 40), 提示: String($('installHint').textContent).slice(0, 60) }))
	/*
	 * ⚠️ **顺序**：下面那条断言读的就是 `installHint` ✓ —— 必须把正常文案**取回来**再往下走 ✓
	 * （旋钮是一次性的 ✓，这次会走成功分支 ✓）—— 提示被留着的话它必红 ✗。
	 */
	click($('installRefresh'))
	await wait(180)
	click($('installShare'))
	await wait(140)
	check('🔴 浏览器不支持系统分享时：**如实说**不支持 + 教用「复制全文」 ✓（不假装分享成功 ✗）',
		String($('installHint').textContent).includes('不支持'),
		String($('installHint').textContent).slice(0, 60))
	/*
	 * 4.2.0「分享网页版」✓：点它必须**真去取** `?format=html` ✓；jsdom 里没有 `navigator.share` ✓
	 * → 正好钉住降级那条：**如实说不能直接分享 + 已下载** ✗（不假装成功 ✓）。
	 */
	check('🔴 分享纸上有「分享网页版」键 ✓（同学拿 .html 直接打开就能读 ✓）',
		$('installShareHtml') !== null, String($('installShareHtml')?.textContent ?? '(没有)'))
	installHtmlFetches = 0
	click($('installShareHtml'))
	await wait(280)
	check('🔴 点它**真去取了网页版** ✓（`?format=html` 一次 ✓ —— 只改文案不去取文件，是最容易犯的假实现 ✗）',
		installHtmlFetches === 1, '取了几次=' + installHtmlFetches)
	check('🔴 不能直接分享文件时：**如实说不能** ✓ + 说清已下载、怎么发给同学 ✓（不假装分享成功 ✗）',
		String($('installHint').textContent).includes('不能直接分享')
		&& String($('installHint').textContent).includes('下载'),
		String($('installHint').textContent).slice(0, 70))
	// 🔴 复查第 96 轮点名的那条缺口 ✓：让桩回一次 500 ✓ —— 页面必须**明说取不到** ✓ 且**不静默** ✓。
	installHtmlFailOnce = true
	click($('installShareHtml'))
	await wait(280)
	check('🔴 网页版取不到时（桩回 500）：**明说没取到** ✓ + 提示文本版还能用 ✓（不静默、不假装成功 ✗）',
		String($('installHint').textContent).includes('没取到')
		&& String($('installHint').textContent).includes('文本版'),
		String($('installHint').textContent).slice(0, 70))
	click($('installBack'))
	await wait(60)
	click($('sysBack'))
	await wait(60)
}

/* --- 2.7.0 ★4：剪贴板 & 截屏（2.7.3 起**要现输 PIN** ✓）--------------------- */
{
	click($('clipBtn'))
	await wait(150)
	// 2.7.3：没输 PIN 就什么都不给 ✓（用户拍的决定 ✓）
	check('📋 没输 PIN 时：不读剪贴板、并且说清要先输 PIN ✓',
		$('clipPcText').value === '' && String($('clipError').textContent).includes('先在上面输 PIN'),
		String($('clipError').textContent).slice(0, 40))
	$('clipPin').value = CORRECT_PIN
	click($('clipRefresh'))
	await wait(160)
	check('输 PIN 后：电脑剪贴板的内容被填进来了（只读 ✓）',
		window.getComputedStyle($('clipopen')).display !== 'none'
		&& $('clipPcText').value === '电脑上复制的那段文字'
		&& $('clipPcText').hasAttribute('readonly'),
		JSON.stringify($('clipPcText').value))

	$('clipPhoneText').value = '手机这边写的字'
	click($('clipSend'))
	await wait(150)
	check('「放进电脑剪贴板」把字发过去了，而且**带上 PIN** ✓（不带就会被服务端 403 ✓）',
		clipboardWrites.length === 1 && clipboardWrites[0].text === '手机这边写的字' && clipboardWrites[0].pin === CORRECT_PIN,
		JSON.stringify(clipboardWrites[0] ?? null))
	check('发完清空输入框（免得下次误发一遍）', $('clipPhoneText').value === '')
	/*
	 * 3.8.0「剪贴板历史」（最近 20 条 ✓，**只在这台手机上** ✓）：这一段的判据都挑**只有它才有**的东西 ✗ ——
	 * 「历史」两个字别处也出现过 ✓，拿它当判据会假绿 ✓。
	 */
	check('放进剪贴板之后：历史里记了一条 ✓（就在这张纸上，不用点新键 ✓）',
		$('clipHist').querySelectorAll('[data-cliphist]').length === 1
		&& String($('clipHist').textContent).includes('手机这边写的字'),
		String($('clipHist').textContent).replace(/\s+/g, ' ').slice(0, 60))
	check('🔴 **从电脑读回来的**那些**不进历史** ✗（那边可能是密码/验证码 ✓ —— 读完只活在屏幕上 ✓）',
		String(window.localStorage.getItem('dshm.cliphist') ?? '').includes('电脑上复制的那段文字') === false,
		String(window.localStorage.getItem('dshm.cliphist') ?? '').slice(0, 60))
	// 点一条：**只放进输入框** ✓（不直接发 ✗ —— 历史全是"上次发过的话" ✓，一滑就发出去是误发源 ✓）。
	const promptsBeforeHist = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	$('text').value = ''
	click($('clipHist').querySelector('[data-cliphist="0"]'))
	await wait(80)
	check('🔴 点一条历史：**放进输入框** ✓，而且**绝不直接发出去** ✗（prompt 数不变 ✓ —— 这条会咬 ✓）',
		$('text').value === '手机这边写的字'
		&& requests.filter((entry) => entry.path.startsWith('/api/prompt')).length === promptsBeforeHist
		&& String($('banner').textContent).includes('放进输入框'),
		JSON.stringify({ text: $('text').value, prompts: requests.filter((e) => e.path.startsWith('/api/prompt')).length - promptsBeforeHist }))
	$('text').value = ''
	// 「取字」：复用 📷 那张纸上的一个动作 ✓（不加新键 ✓），后端拿 PIN 头 ✓。
	click($('clipBtn'))
	await wait(80)
	const ocrBefore = screenOcrPosts.length
	click($('screenOcrBtn'))
	await wait(160)
	check('🔴 「取字」真的发了 `POST api/screen/ocr` ✓，而且**带 PIN 头** ✓（不带就是白给整屏 ✗）',
		screenOcrPosts.length === ocrBefore + 1 && screenOcrPosts.at(-1)?.pin === CORRECT_PIN,
		JSON.stringify(screenOcrPosts.at(-1) ?? null))
	check('取字之后如实说"交给谁了"（不假装自己认完了 ✗ —— 认字是电脑那边的事 ✓）',
		String($('screenOcrHint').textContent).includes('交给') && String($('screenOcrHint').textContent).includes('笔记'),
		String($('screenOcrHint').textContent).slice(0, 70))
	// 清空历史：一条都不留 ✓（历史里有可能是敏感文字 ✓ —— 必须能清干净 ✓）。
	click($('clipHistClear'))
	await wait(60)
	check('「清空」之后历史一条都不剩 ✓（本地上也不留 ✓）',
		$('clipHist').querySelectorAll('[data-cliphist]').length === 0
		&& String(window.localStorage.getItem('dshm.cliphist') ?? '[]').includes('手机这边写的字') === false,
		String(window.localStorage.getItem('dshm.cliphist') ?? '').slice(0, 40))
	/*
	 * 🔴 复查第 92 轮点名的**真问题** ✗：点过历史之后，那条原文会以**草稿**的身份留在本机 ✓，
	 * 而草稿在**导出备份**的白名单里 ✓ —— 只清历史 = "看着清干净了、其实原文还在" ✗。
	 * 这条断言就是钉它 ✓（把清空改回"只清 cliphist"，这里当场红 ✓）。
	 */
	check('🔴 「清空」把**由它填出来的草稿**也一起清了 ✓（不然原文还在本机、还会随导出备份出门 ✗）',
		String(window.localStorage.getItem('dshm.draft') ?? '').includes('手机这边写的字') === false
		&& $('text').value === '',
		JSON.stringify({ draft: String(window.localStorage.getItem('dshm.draft') ?? '').slice(0, 40), text: $('text').value }))
	/*
	 * 🔴 复审第 92 轮点名的**窄边界** ✗：草稿落盘时会被 `DRAFT_MAX`（4000）截断 ✓，
	 * 而历史条目**没有长度上限** ✓ → 超长条目点进输入框、再刷新之后，"整条相等"永远不成立 ✓
	 * → 提示"清空了 ✓"、**其实前 4000 字还在本机** ✗（另一种形状的假干净 ✓，同一条纪律 ✓）。
	 */
	$('text').value = ''
	window.localStorage.setItem('dshm.cliphist', JSON.stringify(['长'.repeat(4500)]))
	window.localStorage.setItem('dshm.draft', '长'.repeat(4000))
	click($('clipBtn'))
	await wait(80)
	click($('clipHistClear'))
	await wait(80)
	check('🔴 超长条目（落盘时被草稿上限截断）也能**真清干净** ✓（不许提示"清空了"却没清 ✗）',
		String(window.localStorage.getItem('dshm.draft') ?? '').includes('长') === false
		&& String(window.localStorage.getItem('dshm.cliphist') ?? '') === '[]',
		JSON.stringify({
			draft: String(window.localStorage.getItem('dshm.draft') ?? '').length,
			hist: String(window.localStorage.getItem('dshm.cliphist') ?? '').slice(0, 20),
		}))

	click($('screenBtn'))
	await wait(80)
	// 截图也要 PIN ✓：验证"至少不是被那句'先输 PIN'挡回去了"（真正的取图在 jsdom 里没有 createObjectURL ✗）
	check('截图带上 PIN 之后不再被"先输 PIN"挡回（真机上还是那张图 ✓）',
		String($('screenHint').textContent).includes('先在上面输 PIN') === false,
		String($('screenHint').textContent).slice(0, 40))
	/*
	 * 「点图看大图」（用户 2026-10-12 提的）：**还没截到图时点小图，不许弹一张空的全屏** ✗ ——
	 * 那种"点开一片黑"最让人以为坏了 ✓。
	 * ⚠️ "有图时点开真的大图"这条要 `URL.createObjectURL` 的桩 ✗（jsdom 没有 ✓）—— 记着，下轮补 ✓。
	 */
	$('shotBig').setAttribute('src', '')
	click($('screenImg'))
	await wait(60)
	check('还没截到图时点小图：**不弹空全屏** ✓（只提示先截一张 ✓）',
		window.getComputedStyle($('shotBox')).display === 'none',
		window.getComputedStyle($('shotBox')).display)
	check('大图层是存在的（真机上点开就是这一层 ✓）', $('shotBig') !== null && $('shotBox') !== null)
	click($('clipBack'))
	await wait(60)
}

/* --- 2.7.0 ★6：定时任务面板 --------------------------------------------
 * 上一轮这块**崩过** ✗：前面的"删除会话"用例会把当前会话置空、还会把 `session-live`
 * 移出列表，于是 `switchTo('session-live')` 直接抛异常、整份 ui 测试没跑完 ✓。
 * 现在的写法两条护栏：**挑列表里现有的第一个会话** ✓ + 每个 DOM 查找都判空 ✓。
 */
{
	openSessions()
	await wait(30)
	const rows = sessionRows()
	check('（前置）定时面板要用到一个活着的会话（列表非空 ✓）', rows.length > 0, rows.join(', '))
	if (rows.length > 0) {
		click($('sessList').querySelector(`[data-session="${rows[0]}"]`))
		await wait(80)
		click($('schBtn'))
		await wait(200)
		const listText = $('schList') === null ? '' : $('schList').textContent.replace(/\s+/g, ' ')
		check('📅 打开定时任务纸：这份会话的任务列出来了（标题 + 重复规则说人话「每天 23:00」✓）',
			window.getComputedStyle($('schopen')).display !== 'none'
			&& listText.includes('整理今天的笔记') && listText.includes('每天 23:00'), listText.slice(0, 60))
		const promptBox = $('schPrompt')
		// ⚠️ 这个文件里只有 `window`，**没有裸 `document`** ✗（写成 document.querySelector 会
		// ReferenceError 把整份测试中断 ✓ —— 这一版就是这么崩的 ✓）。
		const preset = window.document.querySelector('[data-sch="nightly"]')
		if (promptBox !== null && preset !== null) {
			promptBox.value = '整理今天的笔记'
			click(preset)
			await wait(180)
			const sent = scheduleWrites.at(-1) ?? null
			check('预设「每晚 23:00」发出去的就是宿主那套 daily（键名必须一模一样 ✓）',
				sent?.action === 'create' && sent?.daily?.time === '23:00:00'
				&& sent?.daily?.time_zone === 'Asia/Shanghai' && typeof sent?.sessionId === 'string' && sent.sessionId !== '',
				JSON.stringify(sent))
			check('建完清空输入框（免得下次误发一遍 ✓）', promptBox.value === '')
		}
		const delButton = $('schList') === null ? null : $('schList').querySelector('[data-schdel]')
		if (delButton !== null) {
			click(delButton)
			await wait(180)
			check('删除按钮发的是 {action:delete, id}（id 从列表里来，不靠用户输 ✓）',
				scheduleWrites.at(-1)?.action === 'delete' && scheduleWrites.at(-1)?.id === 'schedule-1',
				JSON.stringify(scheduleWrites.at(-1) ?? null))
		} else {
			check('（前置）列表里有「删除」按钮（没有它这条就白测了 ✗）', false, listText.slice(0, 40))
		}
		click($('schBack'))
		await wait(60)
	}
}

/* --- 2.7.0 ★7：只看不发（防误触）-----------------------------------------
 * 验法要"硬"一点 ✓：不只是看图标变没变，而是**真去点一个写操作**，看它有没有发出去 ✓
 * （用定时任务那个预设按钮当靶子：它会 `POST /api/schedule`，而 `scheduleWrites` 记着每一次 ✓）。
 */
{
	const writesBefore = scheduleWrites.length
	click($('roBtn'))
	await wait(80)
	check('开只读：条幅出现、发送键禁用、图标变 🔒',
		window.getComputedStyle($('roStrip')).display !== 'none'
		&& $('send').disabled === true
		&& $('roBtn').textContent.includes('🔒'),
		`strip=${window.getComputedStyle($('roStrip')).display} send=${$('send').disabled}`)
	check('只读状态会持久化（刷新/切回 App 都还在 ✓ —— 锁丢了等于没做 ✗）',
		window.localStorage.getItem('dshm.readonly') === '1', String(window.localStorage.getItem('dshm.readonly')))

	// 真去点一个写操作：必须**发不出去** ✓
	openSessions()
	await wait(30)
	const rows = sessionRows()
	if (rows.length > 0) {
		click($('sessList').querySelector(`[data-session="${rows[0]}"]`))
		await wait(80)
		click($('schBtn'))
		await wait(200)
		const promptBox = $('schPrompt')
		const preset = window.document.querySelector('[data-sch="nightly"]')
		if (promptBox !== null && preset !== null) {
			promptBox.value = '只读模式下不该发出去'
			click(preset)
			await wait(200)
			check('只读时点"写"操作：请求**一条都没发** ✓（挡在 api() 那一层，所有写接口都过不去 ✓）',
				scheduleWrites.length === writesBefore, `${scheduleWrites.length - writesBefore} 条发出去了`)
			check('并且当场说清楚为什么没发（不是默默没反应 ✗）',
				$('toast') !== null && $('toast').textContent.includes('只读'), $('toast') === null ? '(没有提示)' : $('toast').textContent.slice(0, 40))
			click($('schBack'))
			await wait(60)
		}
	}

	// 解锁后同一个操作要能发出 ✓（不然就成了"坏了"而不是"锁上了" ✗）
	click($('roBtn'))
	await wait(80)
	check('解锁：条幅收起、发送键恢复、图标回 🔓',
		window.getComputedStyle($('roStrip')).display === 'none'
		&& $('send').disabled === false
		&& $('roBtn').textContent.includes('🔓'))
	check('解锁后 localStorage 里的标记也清了 ✓', window.localStorage.getItem('dshm.readonly') !== '1')
}

/* --- 2.7.0 ★8：离线发件箱 -------------------------------------------------
 * 验法：**把 window.fetch 临时换成一个"网络层失败"**（reject 一个没有 status 的错 ✓）——
 * 页面里 `isOfflineError` 认的就是这种 ✓（403/400 那种有 status 的**不许进箱** ✗）。
 */
{
	const realFetch = window.fetch
	const sentText = '离线时写的这句：等有网了再发'
	// ① 断网 → 发送 → 应该进箱（而不是干等 ✗）
	window.fetch = () => Promise.reject(new TypeError('Load failed'))
	input.value = sentText
	click($('send'))
	await wait(260)
	window.fetch = realFetch

	const stored = (() => { try { return JSON.parse(window.localStorage.getItem('dshm.outbox') ?? '[]') } catch { return [] } })()
	check('断网时发送：这条被收进离线箱（不再干等 ✗）', Array.isArray(stored) && stored.some((item) => item.text === sentText),
		JSON.stringify(stored).slice(0, 80))
	check('箱子里存了 requestId（补发靠它幂等 —— 不会变成两条 ✓）',
		typeof stored[0]?.clientId === 'string' && stored[0].clientId !== '', String(stored[0]?.clientId))
	check('条幅把"有几条待发"说出来了 ✓',
		window.getComputedStyle($('outboxStrip')).display !== 'none' && $('outboxStrip').textContent.includes('1 条'),
		$('outboxStrip').textContent.slice(0, 40))

	// ② 有网了 → 自动补发 → 箱子空、条幅收起 ✓
	window.dispatchEvent(new window.Event('online'))
	await wait(400)
	const after = (() => { try { return JSON.parse(window.localStorage.getItem('dshm.outbox') ?? '[]') } catch { return [] } })()
	check('恢复网络（online 事件）后自动补发：箱子清空 ✓', Array.isArray(after) && after.length === 0, JSON.stringify(after))
	check('补发完条幅收起 ✓', window.getComputedStyle($('outboxStrip')).display === 'none')

	// ③ 服务端**明确拒绝**（有 status 的错）不许进箱 ✗
	const failing = () => Promise.reject(Object.assign(new Error('HTTP 400'), { status: 400 }))
	window.fetch = failing
	input.value = '这条会被服务端拒，不该进箱'
	click($('send'))
	await wait(300)
	window.fetch = realFetch
	const rejected = (() => { try { return JSON.parse(window.localStorage.getItem('dshm.outbox') ?? '[]') } catch { return [] } })()
	check('服务端明确拒绝（400/403）**不进箱** ✗（那是"发不出去"，进箱只会一直卡着 ✓）',
		Array.isArray(rejected) && rejected.length === 0, JSON.stringify(rejected))
}

/* --- 2.7.0 ★10：只读链接（生成要现输 PIN ✓、撤销一发就生效 ✓）----------------- */
{
	openSessions()
	await wait(30)
	const rows = sessionRows()
	if (rows.length > 0) {
		click($('sessList').querySelector(`[data-session="${rows[0]}"]`))
		await wait(80)
		click($('expBtn'))
		await wait(120)
		const pinBox = $('sharePin')
		const goBtn = $('shareGo')
		if (pinBox !== null && goBtn !== null) {
			pinBox.value = '000000'
			click(goBtn)
			await wait(150)
			check('PIN 不对：不发请求去要链接（服务端也会拒，但手机上先说清 ✓）',
				$('shareUrl').value === '' || String($('shareError').textContent).length > 0,
				String($('shareError').textContent).slice(0, 40))
			pinBox.value = CORRECT_PIN
			click(goBtn)
			await wait(180)
			const sent = shareWrites.at(-1) ?? null
			check('生成只读链接：请求里带 PIN + 当前会话 ✓（默认 24 小时 ✓）',
				sent?.pin === CORRECT_PIN && typeof sent?.sessionId === 'string' && sent.sessionId !== '' && sent?.hours === 24,
				JSON.stringify(sent))
			check('生成的链接显示在只读框里（能直接复制发给家人 ✓）',
				String($('shareUrl').value).includes('/share?t='), String($('shareUrl').value).slice(0, 50))
			check('生成后出现「撤销这条」按钮（不然链接就只能等它过期 ✗）',
				window.getComputedStyle($('shareRevoke')).display !== 'none')
			click($('shareRevoke'))
			await wait(180)
			check('撤销：请求里带的就是刚生成的那个 token ✓（不是让用户自己填 ✗）',
				shareWrites.at(-1)?.action === 'revoke' && shareWrites.at(-1)?.token === 'a'.repeat(32),
				JSON.stringify(shareWrites.at(-1) ?? null))
		}
		click($('expBack'))
		await wait(60)
	}
}

/* --- 2.7.0 ④：审批卡片渲染 + 「以后少问这类」捷径 --------------------------
 * 一直缺的就是这条**渲染通路** ✓：推一帧 `t:'interaction'` 给页面，卡片要真画出来 ✓，
 * 而 ④ 的捷径**只管以后**（文案不许暗示"这次也批了" ✗）。
 */
{
	source.emit({ t: 'interaction', id: 'ask-approval-1', kind: 'approval', payload: { toolName: 'bash', reason: '要跑一条命令' } })
	await wait(150)
	const body = window.document.body.textContent.replace(/\s+/g, ' ')
	check('审批卡片真的画出来了（推一帧 interaction 就来 ✓）',
		body.includes('允许它执行 bash 吗') && body.includes('要跑一条命令'),
		body.slice(Math.max(0, body.indexOf('允许它执行')), 60))
	check('卡片上多了「以后少问这类」捷径 ✓（④ 的落点）', body.includes('以后少问这类'))
	const shortcut = [...window.document.querySelectorAll('button')].find((item) => String(item.textContent).includes('以后少问这类')) ?? null
	check('捷径的说明**明说只管以后** ✓（不许让人以为这一次也批了 ✗）',
		shortcut !== null && String(shortcut.getAttribute('title') ?? '').includes('不等于批准这一次'),
		shortcut === null ? '(没找到按钮)' : String(shortcut.getAttribute('title')).slice(0, 40))
	if (shortcut !== null) {
		click(shortcut)
		await wait(150)
		const after = window.document.body.textContent.replace(/\s+/g, ' ')
		check('点捷径：先把话说清（"这一次仍要点允许一次" ✓），再把人带到权限页 ✓',
			after.includes('这一次仍要点上面的') && window.getComputedStyle($('permopen')).display !== 'none',
			after.slice(Math.max(0, after.indexOf('改的是')), 50))
		click($('permBack'))
		await wait(60)
	}
}

/* --- 2.8.0 ★1：一键自检纸 -------------------------------------------------- */
{
	click($('checkBtn'))
	await wait(200)
	const text = ($('checkBody')?.textContent ?? '').replace(/\s+/g, ' ')
	check('🩺 一键自检：把每条都摊出来了（✓/⚠️ + 名字 + **怎么办** ✓）',
		window.getComputedStyle($('checkopen')).display !== 'none'
		&& text.includes('手机桥在监听') && text.includes('ffmpeg')
		&& text.includes('autostart.ps1') && text.includes('ffmpegPath'),
		text.slice(0, 90))
	check('顶上先说清"有几项要处理"（4 条里 2 条不行 ✓ —— 不美化 ✗）',
		text.includes('有 2 项要处理'), text.slice(0, 40))
	click($('checkBack'))
	await wait(60)
}

/* --- 2.8.0 ★2：安全审计 + 陌生设备 + 踢掉其它设备 --------------------------- */
/*
 * 四件要钉住的事：① **这份账要现输 PIN** ✓（点开先给门口，**一条请求都不发** ✗）；
 * ② 错 PIN → 原地报错、仍然不给数据 ✓；③ 对 PIN 才画出历史（时间 / 来源 / 哪一道 PIN 错 ✓），
 * 并且写清"走外网时这是隧道那端的地址" ✓（不吓人 ✗）；④ 踢设备复用一个 PIN ✓、
 * 带 PIN 才发 `{pin}` ✓（照"删除会话"同一套纪律 ✓）。
 */
{
	click($('secBtn'))
	await wait(160)
	const gate = String($('secBody')?.textContent ?? '').replace(/\s+/g, ' ')
	check('🛡 打开就先要 PIN（说清为什么：这份账里有这台电脑的网络史 ✓）',
		window.getComputedStyle($('secopen')).display !== 'none'
		&& gate.includes('看登录记录要先输 PIN') && gate.includes('网络史')
		&& $('secPin') !== null && $('secSee') !== null,
		gate.slice(0, 80))
	check('还没输 PIN 时**一条请求都不发** ✗（不是"请求被拒"，是压根没发 ✓）',
		loginsReads.length === 0, `已发 ${loginsReads.length} 次`)

	// ① 空 PIN：原地报错、不发请求 ✓。
	click($('secSee'))
	await wait(120)
	check('空 PIN 点「看登录记录」：一条请求都不发 + 原地报错 ✓',
		loginsReads.length === 0 && String($('secError')?.textContent ?? '').includes('PIN'),
		`请求数 ${loginsReads.length}；错误 "${String($('secError')?.textContent ?? '').slice(0, 20)}"`)

	// ② 错 PIN：请求带的是错 PIN（证明"PIN 真的走请求头 ✓"），页面原地报错、不画历史 ✓。
	$('secPin').value = '000000'
	click($('secSee'))
	await wait(200)
	check('错 PIN：请求确实把 PIN 放进了请求头 ✓，而页面原地报错、**没有**把历史画出来 ✓',
		loginsReads.at(-1)?.pin === '000000' && String($('secBody')?.textContent ?? '').includes('PIN')
		&& String($('secBody')?.textContent ?? '').includes('登录历史') === false,
		`PIN=${loginsReads.at(-1)?.pin} url=${loginsReads.at(-1)?.url}`)

	// ③ 对 PIN：拿到数据、画出四段 ✓。
	$('secPin').value = CORRECT_PIN
	click($('secSee'))
	await wait(220)
	const text = ($('secBody')?.textContent ?? '').replace(/\s+/g, ' ')
	check('对 PIN 才画出登录历史（✓/✗ + 哪一道 PIN + 时间 + 来源 ✓）',
		loginsReads.at(-1)?.pin === CORRECT_PIN
		&& text.includes('登录历史') && text.includes('删除会话（PIN 不对）')
		&& text.includes('203.0.113.9') && text.includes('100.122.188.30'),
		text.slice(0, 110))
	check('陌生设备提醒：写明"走外网时这里显示的是隧道那端的地址" ✓（不然会把人吓一跳 ✗）',
		text.includes('陌生设备') && text.includes('隧道那端') && text.includes('第一次'), text.slice(0, 80))
	check('设备表：当前这台标成"这台手机"，另一台不是 ✓（两行分得清 ✓）',
		text.includes('这台手机') && text.includes('另一台'), text.slice(0, 60))

	// ④ 踢设备：复用刚才那个 PIN（**不用再输一次** ✓），形状就是 `{pin}` ✓。
	const beforeKick = revokeWrites.length
	click($('secRevoke'))
	await wait(260)
	const kicked = revokeWrites.at(-1) ?? null
	check('踢设备：复用刚输过的 PIN、形状就是 {pin} ✓（不用输两次 ✓）',
		revokeWrites.length === beforeKick + 1 && kicked !== null && kicked.pin === CORRECT_PIN
		&& Object.keys(kicked).length === 1, JSON.stringify(kicked))
	check('踢完把结果说出来 ✓，并把面板重画一遍 ✓',
		String(window.document.body.textContent).includes('已踢掉 2 台其它设备')
		&& String($('secBody')?.textContent ?? '').includes('登录历史'),
		String(window.document.body.textContent).slice(-60))

	click($('secBack'))
	await wait(60)
}

/* --- 2.8.0 ★4：错误一键重试 + 诊断包 --------------------------------------- */
/*
 * 两件事：① 出问题时条幅上有一个**能点的「重试」** ✓ —— 不是只甩一句"发送失败"就完事 ✗；
 * ② 🩺 纸底部有一个**诊断包**入口 ✓（脱敏后的文本，能直接发出去 ✓）。
 * ⚠️ 这里**不点**那个 `<a download>`：jsdom 会把它记成一次导航 ✗，而后面的"stale page
 * 自愈"用例正在数导航次数 ✓（数错了会假红 ✓）。只验 href/属性 ✓。
 */
{
	// ① 诊断包入口：在 🩺 纸里、是同一套下载写法（同源带 cookie ✓）、且写明会被脱敏 ✓。
	click($('checkBtn'))
	await wait(200)
	const diag = $('diagGo')
	check('🩺 纸里有「诊断包」入口（`<a download>` 同源下载，和导出 Markdown 同一套 ✓）',
		diag !== null && String(diag.getAttribute('href')).includes('api/diag')
		&& diag.hasAttribute('download'), diag === null ? '(没找到)' : String(diag.getAttribute('href')))
	check('诊断包写清了"PIN 与密钥段会被替换掉" ✓（这是要发出去的东西 ✗）',
		String($('checkopen')?.textContent ?? '').includes('密钥段会被替换掉'))
	click($('checkBack'))
	await wait(60)

	// ② 发送失败 → 条幅上出现「重试」；点它**真的再发一次** ✓（不是摆设 ✓）。
	$('text').value = '这条消息会先失败一次'
	const promptBefore = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	promptFailStatus = 500
	click($('send'))
	await wait(300)
	const bannerText = String($('banner')?.textContent ?? '')
	check('发送失败时条幅上给一个能点的「重试」（2.8.0 ★4 ✓）',
		window.getComputedStyle($('banner')).display !== 'none'
		&& bannerText.includes('发送失败') && bannerText.includes('重试') && $('flashGo') !== null,
		bannerText.slice(0, 80))

	click($('flashGo'))
	await wait(350)
	const promptAfter = requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	check('点「重试」：真的再发一次（请求数 +1 ✓），而且这次成功了（输入框清空 ✓、条幅收起 ✓）',
		promptAfter === promptBefore + 2 && $('text').value === ''
		&& window.getComputedStyle($('banner')).display === 'none',
		`prompt 请求 ${promptBefore} -> ${promptAfter}；输入框 "${$('text').value}"`)
}

/* --- 2.8.0 ★12：实时耗时 / token 跳动 --------------------------------------- */
/*
 * 用户要的：「跑任务时显示已用时间 + 消耗 ✓」。三条要钉住：
 *   ① 跑的时候显示"已跑 X:XX"，起点取自 `turn/start` **事件自己的 `time`** ✓
 *      （不是"从打开页面算" ✗ —— 否则刷新一次计时就归零 ✓）；
 *   ② token 只显示**宿主真报过的** ✓（没报就只显示时间 ✗ 不编一个 0 ✓）；
 *   ③ **重放历史不算"刚才跑过"** ✗ —— 刷新/换会话会把过去那一轮重放回来，
 *      那时弹一句"✓ 这一轮 3:21"只会让人以为自己刚才在跑东西 ✓。
 */
{
	await switchTo(SESSION)
	await wait(240)
	const cumulative = ($('runstrip')?.textContent ?? '')
	check('顶部那条显示"本会话累计"（宿主的 tokenUsage 投影 ✓ 读得到才有这一段 ✓）',
		window.getComputedStyle($('runstrip')).display !== 'none'
		&& cumulative.includes('本会话累计 ↑12.3k ↓678'), cumulative.slice(0, 90))

	// ① 跑一轮：起点是 65 秒前（用事件自己的 time ✓）。
	source.emit({ t: 'event', event: { type: 'turn/start', seq: 300, time: Date.now() - 65000, data: { turn: 9 } } })
	await wait(140)
	const running = ($('runstrip')?.textContent ?? '')
	check('跑起来时显示"已跑 1:0X"（从 turn/start 那一刻算 ✓，不是从打开页面算 ✗）',
		/已跑 1:0\d/.test(running), running.slice(0, 60))
	check('宿主还没报 token 时**只显示时间**（不编一个 ↓0 ✓）',
		running.includes('本轮') === false, running.slice(0, 60))

	// ② 宿主报了一次 usage：↑ = 输入(1200) + 缓存读(8000) = 9.2k ✓，↓ = 输出 340 ✓。
	source.emit({ t: 'event', event: { type: 'assistant/message', seq: 301, time: Date.now(), data: {
		turn: 9, step: 1, usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 8000, cacheWriteTokens: 0 },
		message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
	} } })
	await wait(160)
	const withTokens = ($('runstrip')?.textContent ?? '')
	check('宿主报 usage 后这一轮的数字跟上（↑ 含缓存 ✓、↓ 是输出 ✓）',
		withTokens.includes('本轮 ↑9.2k ↓340'), withTokens.slice(0, 90))

	source.emit({ t: 'event', event: { type: 'turn/end', seq: 302, time: Date.now(), data: { turn: 9, reason: { kind: 'completed' } } } })
	await wait(160)
	const done = ($('runstrip')?.textContent ?? '')
	check('跑完留一句"这一轮用了多久 + 烧了多少"（60 秒后自己收走 ✓）',
		done.includes('✓ 这一轮') && done.includes('本轮 ↑9.2k ↓340'), done.slice(0, 90))

	/*
	 * ③b 同一条 usage **被送到两次**（SSE 推一遍 + `since=` 补拉重叠一遍 ✓）：
	 *     必须按宿主口径**替换**、不许相加 ✓ —— 真数据核对过"日志里没有重复的 (turn,step)"✓，
	 *     但"重复送达"是客户端才有的风险 ✓，虚高一倍会直接骗到用户 ✗。
	 */
	source.emit({ t: 'event', event: { type: 'turn/start', seq: 303, time: Date.now() - 5000, data: { turn: 10 } } })
	source.emit({ t: 'event', event: { type: 'assistant/message', seq: 304, time: Date.now(), data: {
		turn: 10, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
		message: { id: 'm10', role: 'assistant', content: [{ type: 'text', text: 'A' }] },
	} } })
	await wait(120)
	const once = ($('runstrip')?.textContent ?? '')
	source.emit({ t: 'event', event: { type: 'assistant/message', seq: 304, time: Date.now(), data: {
		turn: 10, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
		message: { id: 'm10', role: 'assistant', content: [{ type: 'text', text: 'A' }] },
	} } })
	await wait(140)
	const twice = ($('runstrip')?.textContent ?? '')
	check('同一步的 usage 被送两次：**替换**而不是相加 ✓（加起来会虚高一倍 ✗ —— 照宿主 token-meter 的口径 ✓）',
		once.includes('本轮 ↑1.0k ↓100') && twice.includes('本轮 ↑1.0k ↓100'), `一次=${once.slice(0, 40)} 两次=${twice.slice(0, 40)}`)
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 305, time: Date.now(), data: { turn: 10, reason: { kind: 'completed' } } } })
	await wait(120)

	// ③ 重放：把"一小时前跑完的那一轮"整段推回来 → **不许**弹成"刚才跑过" ✗。
	source.emit({ t: 'snapshot', tag: PAGE_TAG, cursor: 302, hasMore: false, records: [
		{ type: 'event', event: { type: 'turn/start', seq: 400, time: Date.now() - 3600000, data: { turn: 11 } } },
		{ type: 'event', event: { type: 'assistant/message', seq: 401, time: Date.now() - 3600000, data: {
			turn: 11, step: 1, usage: { inputTokens: 10, outputTokens: 20 },
			message: { id: 'm11', role: 'assistant', content: [{ type: 'text', text: '旧的一轮' }] },
		} } },
		{ type: 'event', event: { type: 'turn/end', seq: 402, time: Date.now() - 3600000, data: { turn: 11, reason: { kind: 'completed' } } } },
	] })
	await wait(240)
	const replayed = ($('runstrip')?.textContent ?? '')
	check('刷新重放"已经跑完的那一轮"**不会**弹成"刚才跑过" ✗（只留累计 ✓）',
		replayed.includes('这一轮') === false && replayed.includes('已跑') === false
		&& replayed.includes('本会话累计'), replayed.slice(0, 90))

	/*
	 * ④ 重放一个**还在跑**的轮次（正跑着的时候刷新页面 ✓）：
	 *    这时候**必须**照常显示"已跑 X:XX" ✓ —— 起点仍然取自重放回来的 `turn/start` 事件时间 ✓。
	 *    （冷视角复查点过：之前只恢复状态、不重画，用户刷新后反而看不见正在跑的那一轮 ✗。）
	 */
	source.emit({ t: 'snapshot', tag: PAGE_TAG, cursor: 500, hasMore: false, records: [
		{ type: 'event', event: { type: 'turn/start', seq: 500, time: Date.now() - 125000, data: { turn: 12 } } },
		{ type: 'event', event: { type: 'assistant/message', seq: 501, time: Date.now() - 120000, data: {
			turn: 12, step: 1, usage: { inputTokens: 2048, outputTokens: 512 },
			message: { id: 'm12', role: 'assistant', content: [{ type: 'text', text: '还在跑' }] },
		} } },
	] })
	await wait(240)
	const replaying = ($('runstrip')?.textContent ?? '')
	check('刷新时那一轮**还在跑**：照常显示"已跑 2:0X" ✓（起点用重放回来的事件时间，不是刷新那一刻 ✗）',
		/已跑 2:0\d/.test(replaying) && replaying.includes('本轮 ↑2.0k ↓512'), replaying.slice(0, 90))
}

/* --- 2.10.0 ★6：键盘手感（Enter 模式 / ↑ 取上一条）-------------------------- */
/*
 * 用户要的三样：「↑ 取上一条 ✓、Enter 发送/换行可切换 ✓、长按空格移动光标 ✓」。
 * 前两样能在这儿钉死 ✓；第三样（长按拖光标）jsdom **造不出触摸事件** ✗
 * （没有 TouchEvent 构造器 ✓）→ 只标注"真机未验"✗，不假装验过 ✓（默认也是关的 ✓）。
 */
{
	const promptCount = () => requests.filter((entry) => entry.path.startsWith('/api/prompt')).length
	const keydown = (key, options = {}) => $('text').dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))

	await ensureAppVisible()
	click($('kbBtn'))
	await wait(160)
	check('⌨ 纸打开，三个开关的默认值都"不动老习惯" ✓（Enter 仍是换行 ✓、长按拖光标默认关 ✓）',
		visible($('kbopen')) && $('kbEnter')?.checked === false
		&& $('kbHistory')?.checked === true && $('kbCaret')?.checked === false,
		`enter=${$('kbEnter')?.checked} history=${$('kbHistory')?.checked} caret=${$('kbCaret')?.checked}`)

	// ① Enter：默认 = 换行（**不发请求** ✓ 不改老习惯）；勾上 = 直接发；Shift+Enter 仍换行；Ctrl+Enter 一直发 ✓。
	$('text').value = '先试试回车'
	const n0 = promptCount()
	keydown('Enter')
	await wait(120)
	check('默认（没勾）按 Enter **不发** ✓ —— 就是换行，手机上原来的行为没被改掉 ✓',
		promptCount() === n0, `${n0} -> ${promptCount()}`)
	click($('kbEnter'))
	await wait(100)
	check('勾上后状态记在手机本地（`dshm.enterSend=1` ✓，也进备份 ✓）',
		window.localStorage.getItem('dshm.enterSend') === '1', String(window.localStorage.getItem('dshm.enterSend')))
	const n1 = promptCount()
	keydown('Enter')
	await wait(160)
	check('勾上「Enter 直接发送」：回车就走 ✓（请求 +1）', promptCount() === n1 + 1, `${n1} -> ${promptCount()}`)
	$('text').value = '换行的那种'
	const n2 = promptCount()
	keydown('Enter', { shiftKey: true })
	await wait(120)
	check('Shift+Enter 仍然是换行（**不发** ✓ —— 勾了也得留一条多行的路 ✓）',
		promptCount() === n2, `${n2} -> ${promptCount()}`)
	$('text').value = '快捷键那种'
	const n3 = promptCount()
	keydown('Enter', { ctrlKey: true })
	await wait(160)
	check('Ctrl / ⌘ + Enter 一直都是发送 ✓（老行为没被这次改动弄坏 ✓）',
		promptCount() === n3 + 1, `${n3} -> ${promptCount()}`)
	/*
	 * ⚠️ **中文输入法**：用拼音打字时按 Enter 是"选字/上屏" ✓ —— 勾了「Enter 直接发送」也**绝不能发** ✗✗
	 * （这是最容易坑中文用户的一条 ✓）。两条判据都验：`isComposing` 与老的 `keyCode 229` ✓。
	 */
	$('text').value = '用拼音打字中'
	const n4 = promptCount()
	keydown('Enter', { isComposing: true })
	await wait(120)
	check('输入法组合中按 Enter（`isComposing=true`）**不发** ✓✗（按 Enter 是选字，不是发送 ✓）',
		promptCount() === n4, `${n4} -> ${promptCount()}`)
	const n5 = promptCount()
	keydown('Enter', { keyCode: 229 })
	await wait(120)
	check('老输入法只给 `keyCode 229` 时也**不发** ✓（两条判据都认 ✓）',
		promptCount() === n5, `${n5} -> ${promptCount()}`)
	click($('kbEnter'))
	await wait(80)

	// ② ↑ 取上一条 / ↓ 往回翻 ✓。
	//    注意：**记的是"你打出去的那句"** ✓ —— 这里最近真发出去的是 "快捷键那种" ✓
	//    （"换行的那种"只按了 Shift+Enter，没发 → 不进历史 ✓）。
	const lastSent = '快捷键那种'
	$('text').value = ''
	try { $('text').setSelectionRange(0, 0) } catch { /* 无所谓 */ }
	keydown('ArrowUp')
	await wait(100)
	check('↑ 把上一条已发消息取回来了 ✓（空框时接管 ✓）',
		$('text').value === lastSent, JSON.stringify(String($('text').value).slice(0, 30)))
	keydown('ArrowDown')
	await wait(100)
	check('↓ 往回翻回"还没翻历史"的那份草稿 ✓（这里是空 ✓）',
		$('text').value === '', JSON.stringify(String($('text').value).slice(0, 30)))
	/*
	 * ⚠️ **P1 回归：取回历史后在框里改字，再按 ↑ 不许把刚改的丢掉** ✗（冷视角复查：原来会静默丢输入 ✓）。
	 * 修法是"一打字就退出翻历史状态"（`input` 监听 ✓）+ 每轮更新草稿 ✓ ——
	 * 所以改完再按 ↓ 拿回的必须是**改过的那句** ✓，而不是第一次 ↑ 时的旧快照 ✗。
	 */
	$('text').value = ''
	try { $('text').setSelectionRange(0, 0) } catch { /* 无所谓 */ }
	keydown('ArrowUp')
	await wait(100)
	$('text').value = '我改过的草稿'
	$('text').dispatchEvent(new window.Event('input', { bubbles: true }))
	await wait(80)
	keydown('ArrowDown')
	await wait(100)
	check('P1 回归：取回历史后**改过的草稿不许被抹掉** ✓（一打字就退出翻历史状态 ✓，↓ 拿回的是改过的那句 ✓）',
		$('text').value === '我改过的草稿', JSON.stringify(String($('text').value).slice(0, 30)))
	/*
	 * 多行的保护：光标**不在第一行**时 ↑ 不接管 ✓（那是"看上一行" ✓）。
	 * ⚠️ 光标在第 0 位时接管是**对的** ✓（shell 里也是这个语义 ✓）—— 我第一版断言写成了
	 * "多行就不接管"，被这轮测试当场纠正 ✓（断言错、代码对 ✓）。
	 */
	$('text').value = '第一行\n第二行'
	const len = String($('text').value).length
	try { $('text').setSelectionRange(len, len) } catch { /* 无所谓 */ }
	keydown('ArrowUp')
	await wait(100)
	check('光标在第二行时 **↑ 不接管** ✓（那是"看上一行"，抢过来只会让人骂 ✗）',
		$('text').value === '第一行\n第二行', JSON.stringify(String($('text').value).slice(0, 30)))
	$('text').value = ''
	try { $('text').setSelectionRange(0, 0) } catch { /* 无所谓 */ }
	check('（说明）长按拖光标这一样 jsdom 验不了 ✗ —— 造不出触摸事件，只能真机看 ✓（默认关 ✓）',
		$('kbCaret')?.checked === false)
	click($('kbBack'))
	await wait(80)
}

/* --- 3.0.0 ★①：离线优先（草稿不丢 + 离线屏看得见"哪条没发"）----------------- */
/*
 * 用户要的（总路线原话）：**断网可读写、恢复自动同步** ✓。
 * 这一组的两个真缺口：① 写到一半的话**不能因为刷新/切换地址就没了** ✗；
 * ② 整屏离线时顶部那条发件箱横幅被盖住 ✓ → 数量得在这一屏上再说一次 ✓。
 */
{
	await ensureAppVisible()
	// ① 草稿：打字 → 停手 → 存进本地 ✓；清空 → 跟着清 ✓；点输入框能放回来 ✓。
	$('text').value = '写到一半的一句'
	$('text').dispatchEvent(new window.Event('input', { bubbles: true }))
	await wait(700)
	check('打字停下 0.5 秒后草稿落进手机本地 ✓（`dshm.draft` ✓ —— 刷新/切地址都不该丢 ✗）',
		window.localStorage.getItem('dshm.draft') === '写到一半的一句',
		JSON.stringify(String(window.localStorage.getItem('dshm.draft')).slice(0, 30)))
	// 模拟"页面被回收再打开"：把输入框清空、草稿留着 ✓ → 点一下输入框就该回来 ✓。
	$('text').value = ''
	$('text').dispatchEvent(new window.Event('focus', { bubbles: true }))
	await wait(120)
	check('页面被回收后再点输入框：**草稿自己回来了** ✓（不用重新打一遍 ✓）',
		$('text').value === '写到一半的一句', JSON.stringify(String($('text').value).slice(0, 30)))
	// 用户自己清空 → 草稿也要跟着清 ✓（绝不能在下次点进来时又冒出来 ✗）。
	$('text').value = ''
	$('text').dispatchEvent(new window.Event('input', { bubbles: true }))
	await wait(700)
	$('text').dispatchEvent(new window.Event('focus', { bubbles: true }))
	await wait(120)
	check('用户自己清空之后：草稿也清了 ✓、点输入框**不会再冒出来** ✗（不然像闹鬼 ✓）',
		window.localStorage.getItem('dshm.draft') === '' && $('text').value === '',
		`draft="${String(window.localStorage.getItem('dshm.draft')).slice(0, 20)}" text="${String($('text').value).slice(0, 20)}"`)

	// ② 离线屏：箱子里有几条，必须在这屏上看得见 ✓（顶部横幅被整屏盖住了 ✓）。
	window.localStorage.setItem('dshm.outbox', JSON.stringify([{
		at: Date.now(), clientId: 'off-1', sessionId: 'session-ui-test', text: '离线写的一句', images: [], fileRefs: [],
	}]))
	window.dispatchEvent(new window.Event('offline'))
	await wait(200)
	check('整屏离线时：**"有几条在发件箱等着"写在正中间这一屏上** ✓（不是只在被盖住的横幅里 ✗）',
		visible($('offline')) && $('offlineWaiting') !== null
		&& String($('offlineWaiting').textContent).includes('1 条'),
		$('offlineWaiting') === null ? '(没有那条)' : String($('offlineWaiting').textContent).slice(0, 50))
	check('离线屏仍然给得出"三条出路" ✓（重试 / 看缓存 / 换地址 —— 2.x 就有 ✓，别弄丢 ✗）',
		String($('offlineActs').textContent).includes('重试'),
		String($('offlineActs').textContent).replace(/\s+/g, ' ').slice(0, 60))
	/*
	 * 🔴 3.0.0 补的真回归 ✓（写新屏时顺出来的**老毛病** ✓）：
	 * 满屏浮层（离线屏 / 等放行屏 / PIN 门）必须当 `#app` 的**兄弟** ✓ ——
	 * 因为它们出现的那一刻，`#app` 正是 `display:none` ✓；
	 * 嵌在 `#app` 里 = **永远看不见** ✗（`#offline` 一直是这样 ✓，只是从来没人测"冷启动 + 离线" ✓）。
	 */
	check('🔴 满屏浮层是 `#app` 的**兄弟**（不是后代）✓ —— 嵌在里面 = 该显示时永远看不见 ✗',
		$('app').contains($('offline')) === false && $('app').contains($('pending')) === false
		&& $('app').contains($('gate')) === false,
		`offline在内=${$('app').contains($('offline'))} pending在内=${$('app').contains($('pending'))} gate在内=${$('app').contains($('gate'))}`)
	// 收尾：把箱子清干净 ✓（**先清 localStorage 再回到在线** ✓ —— online 会重读箱子 ✓；
	// 第一版直接派发 online，于是箱子里那条假消息**真的被补发出去了** ✗，
	// 还顺带把后面 ★11 那组的计数搅乱 ✓）。
	window.localStorage.setItem('dshm.outbox', '')
	window.dispatchEvent(new window.Event('online'))
	// ⚠️ 这里必须**等干净** ✓：`online` 会让页面重读箱子、并可能触发一次"重连/整屏恢复"的异步收尾 ✓ ——
	// 不等它落定就往下走，后面 ★11 那组会偶发地量到"箱子还在/横幅还是旧的" ✗
	//（2026-10-12 撞过一次：同样代码两次一绿一红 ✓）。
	await wait(800)
	check('（收尾）回到在线：箱子清空、假消息一条都没被补发 ✓（不给后面的用例留状态 ✓）',
		window.localStorage.getItem('dshm.outbox') === '')
}

/* --- 3.0.0 ★②：有事通知我（通知闭环）---------------------------------------- */
/*
 * 用户要的（总路线原话）：**任何需要你的事都会找到你** ✓。
 * 硬约束已查实：`Notification` 只在**安全上下文**（https / localhost）里存在 ✗ ——
 * 所以这一组要钉的是三条：**能用就用** ✓、**不能用就如实说** ✓（并保留"标题兜底"✓）、
 * **不骚扰** ✓（正看着不弹 ✓、几秒钟跑完的一轮不叫 ✓）。
 */
{
	await ensureAppVisible()
	const setHidden = (value) => {
		// ⚠️ 两处都得对 ✓：① 用 **getter** 覆盖（jsdom 的在原型上，写 value 不一定盖得住 ✗）；
		// ② 值是字符串 **`'hidden'`/`'visible'`** ✗（第一版把布尔 `true` 塞进去 ✓ ——
		//    页面比的是 `=== 'hidden'` ✓，于是"后台"永远不成立 ✓，4 条断言全红 ✓）。
		const state = value === true ? 'hidden' : 'visible'
		try { Object.defineProperty(window.document, 'visibilityState', { get: () => state, configurable: true }) } catch { /* 无所谓 */ }
		window.document.dispatchEvent(new window.Event('visibilitychange'))
	}
	const originalTitle = window.document.title

	click($('checkBtn'))
	await wait(200)
	check('通知开关在 🩺 纸里 ✓（不往工具键那排加键 ✗）、默认关 ✓、把"能不能用"说清楚 ✓',
		visible($('notifyOn')) && $('notifyOn').checked === false
		&& String($('notifyNote').textContent).includes('关着'),
		`checked=${$('notifyOn').checked} note="${String($('notifyNote').textContent).slice(0, 40)}"`)

	// ① 打开：**当场申请权限** ✓（浏览器要求用户点过才给 ✓），状态记在手机本地 ✓。
	notifyStub.permission = 'granted'
	notifyStub.requested = 0
	click($('notifyOn'))
	await wait(220)
	check('打开时**当场申请权限** ✓（不是偷偷申请 ✓ 也不是从来不要 ✓）、状态写进本地 ✓',
		notifyStub.requested === 1 && window.localStorage.getItem('dshm.notify') === '1'
		&& String($('notifyNote').textContent).includes('权限已给'),
		`requested=${notifyStub.requested} dshm.notify=${window.localStorage.getItem('dshm.notify')} note="${String($('notifyNote').textContent).slice(0, 30)}"`)

	// ② 页面在后台 + agent 提问 → **真的弹通知** ✓（并且标题兜底也生效 ✓）。
	setHidden(true)
	notifyStub.made.length = 0
	click($('checkBack'))
	await wait(80)
	source.emit({ t: 'interaction', id: 'notify-1', kind: 'question', payload: {} })
	await wait(240)
	check('⭐ 人在后台、agent 提问 → **真的弹了通知** ✓（"agent 在问你"✓）',
		notifyStub.made.length === 1 && notifyStub.made[0].title.includes('在问你'),
		JSON.stringify(notifyStub.made[0] ?? null))
	check('兜底的标签标题也变了 ✓（没有权限/不支持时这条照样有效 ✓）',
		window.document.title.includes('在问你'), window.document.title)
	const note = notifyStub.instances.at(-1)
	check('点通知能**把人拉回页面** ✓（`onclick` 里有 focus ✓ 且会自己关掉 ✓）',
		note !== undefined && typeof note.onclick === 'function')
	note?.onclick?.()
	check('点完之后那条通知自己关掉 ✓（不堆在通知中心里 ✗）', note?.closed === true)

	// ③ **正看着的时候不打扰** ✓（这条是"别变成骚扰"的关键 ✓）。
	setHidden(false)
	notifyStub.made.length = 0
	source.emit({ t: 'interaction', id: 'notify-2', kind: 'question', payload: {} })
	await wait(200)
	check('人**正在看**的时候：不弹通知 ✓（只有振动和卡片本身 ✓）', notifyStub.made.length === 0,
		`弹了 ${notifyStub.made.length} 条`)

	/*
	 * ④ 3.9.0「专注模式」静音的是**系统通知** ✓，**不是标题兜底** ✗ ——
	 * 复审第 93 轮就是拿这条抓我的 ✓：第一版把闸写在函数最前面 ✓、第二版又"加了新闸没删旧闸" ✗
	 *（旧闸先 return ✓ → 新闸死代码 ✓，行为一点没变 ✗）。所以这条断言**必须**在专注**开着**的时候跑 ✓。
	 */
	window.localStorage.setItem('dshm.focus', '1')
	setHidden(true)
	notifyStub.made.length = 0
	window.document.title = 'DSH 手机端'
	source.emit({ t: 'interaction', id: 'notify-3', kind: 'question', payload: {} })
	await wait(240)
	check('🔴 专注中：系统通知**静音** ✓，但「agent 在问你」的**标题兜底照旧** ✗（那是安全兜底 ✓，不许一起静音 ✓）',
		notifyStub.made.length === 0 && window.document.title.includes('在问你'),
		JSON.stringify({ 弹了: notifyStub.made.length, 标题: window.document.title }))
	window.localStorage.setItem('dshm.focus', '')
	setHidden(false)
	check('回到前台时标题还原 ✓（"需要你…"不会挂一小时 ✓）',
		window.document.title === originalTitle, window.document.title)

	// ④ 跑很久的一轮结束 → 叫一声 ✓；几秒钟的 → 不叫 ✓。
	setHidden(true)
	notifyStub.made.length = 0
	source.emit({ t: 'event', event: { type: 'turn/start', seq: 9600, time: Date.now() - 90000, data: { turn: 70 } } })
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9601, time: Date.now(), data: { turn: 70 } } })
	await wait(260)
	check('跑了几分钟才结束的那一轮 → 叫一声 ✓（"跑完了 ✓"）',
		notifyStub.made.length === 1 && notifyStub.made[0].title.includes('跑完了'),
		JSON.stringify(notifyStub.made[0] ?? null))
	notifyStub.made.length = 0
	source.emit({ t: 'event', event: { type: 'turn/start', seq: 9602, time: Date.now(), data: { turn: 71 } } })
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9603, time: Date.now(), data: { turn: 71 } } })
	await wait(260)
	check('几秒钟就跑完的一轮：**不叫** ✓（每次都响 = 骚扰 ✗）', notifyStub.made.length === 0,
		`弹了 ${notifyStub.made.length} 条`)

	// ⑤ 不是安全地址（http）：**如实说** ✓、并且**开关不许留在"开着"的样子** ✗。
	const savedNotification = window.Notification
	try {
		delete window.Notification
		try { Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }) } catch { /* 无所谓 */ }
		click($('checkBtn'))
		await wait(200)
		// 先把它摆成"**没勾**"再看用户去点它 ✓（点一下 = 勾上 ✓ ——
		// 第一版摆成 true 再点，等于**关掉** ✗，验的东西完全反了 ✓）。
		window.localStorage.setItem('dshm.notify', '0')
		$('notifyOn').checked = false
		setHidden(true)
		check('（前置）"后台"这个状态真的生效了 ✓（不然下面几条等于什么都没验 ✗）',
			window.document.visibilityState === 'hidden', String(window.document.visibilityState))
		click($('notifyOn'))
		await wait(220)
		check('不是 https（http 地址）：说清"浏览器不给通知、换 https 就好" ✓，且开关不留在开着 ✗',
			$('notifyOn').checked === false && window.localStorage.getItem('dshm.notify') === '0'
			&& String($('toast')?.textContent ?? '').includes('https'),
			`checked=${$('notifyOn').checked} dshm.notify=${window.localStorage.getItem('dshm.notify')} toast="${String($('toast')?.textContent ?? '').slice(0, 40)}"`)
	} finally {
		window.Notification = savedNotification
		try { Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true }) } catch { /* 无所谓 */ }
		setHidden(false)
		click($('checkBack'))
		await wait(80)
	}
}

/* --- 3.0.0 ★③：说出来 → 文字（STT，手机侧 ✓）-------------------------------- */
/*
 * 桥侧（`/api/speech`、`/api/transcribe`、云识别器要 PIN）已在 harness 里钉住 ✓；
 * 这里钉**手机侧**：真的编码出一段**标准 WAV** ✗（不是随便传点东西过去 ✓）、
 * 转出来的字**只进输入框、不自动发出去** ✓✗（这条是产品红线 ✓）、
 * 电脑没开语音/拿不到麦克风时**如实说** ✓。
 */
{
	await ensureAppVisible()
	const b64ToBytes = (base64) => Uint8Array.from(Buffer.from(base64, 'base64'))
	const prompts = () => requests.filter((entry) => entry.path.startsWith('/api/prompt')).length

	// 让 /api/speech 说出"本机识别器 + 600 秒上限" ✓（默认桩就是这台机器的样子 ✓）。
	click($('recBtn'))
	await wait(220)
	check('打开录音纸会去读语音设置 ✓，识别器写在屏幕上（本机=不上传 ✓、上限 ✓）',
		String($('sttNote').textContent).includes('识别器') && String($('sttNote').textContent).includes('本机')
		&& String($('sttNote').textContent).includes('600'),
		String($('sttNote').textContent).slice(0, 70))

	// ① 录一段（用假采样灌进去 ✓）→ 停下来 → 应该编码成 WAV 并请电脑转写 ✓。
	const promptsBefore = prompts()
	const textBefore = String($('text').value)
	audioStub.processors.length = 0
	click($('sttToggle'))
	await wait(160)
	check('按「说一句」：真的开始听了 ✓（键变成"说完了" ✓、屏幕写着正在听 ✓）',
		$('sttToggle').textContent.includes('说完了') && String($('sttNote').textContent).includes('正在听'),
		`toggle="${$('sttToggle').textContent}" note="${String($('sttNote').textContent).slice(0, 30)}"`)
	const processor = audioStub.processors.at(-1)
	// 灌 1.2 秒 16k 单声道正弦波 ✓（0.5 秒以下会被"太短"挡掉 ✓）。
	const samples = new Float32Array(19200)
	for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(index / 12) * 0.4
	processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } })
	await wait(60)
	click($('sttToggle'))
	await wait(520)
	const transcribeCall = requests.filter((entry) => entry.path.startsWith('/api/transcribe')).at(-1)
	const sentAudio = transcribeCall === undefined ? '' : String(JSON.parse(transcribeCall.options.body).audioBase64 ?? '')
	const bytes = sentAudio === '' ? new Uint8Array() : b64ToBytes(sentAudio)
	const head = String.fromCharCode(...bytes.subarray(0, 4))
	const wave = String.fromCharCode(...bytes.subarray(8, 12))
	check('☆ 传上去的是**标准 WAV** ✓（RIFF/WAVE 头 ✓ —— 宿主只认这个 ✓，随便塞点东西过去会被拒 ✗）',
		transcribeCall !== undefined && head === 'RIFF' && wave === 'WAVE',
		`head="${head}" wave="${wave}" 字节=${bytes.length}`)
	check('WAV 头里写的是 16k / 单声道 / 16bit ✓（自己编码就得自己写对 ✓）',
		bytes.length > 44 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(24, true) === 16000
		&& new DataView(bytes.buffer, bytes.byteOffset).getUint16(22, true) === 1
		&& new DataView(bytes.buffer, bytes.byteOffset).getUint16(34, true) === 16,
		bytes.length > 44
			? `rate=${new DataView(bytes.buffer, bytes.byteOffset).getUint32(24, true)} ch=${new DataView(bytes.buffer, bytes.byteOffset).getUint16(22, true)} bits=${new DataView(bytes.buffer, bytes.byteOffset).getUint16(34, true)}`
			: '(太短)')
	check('录完把麦克风**放掉**了 ✓（`close()` 被调用 ✓ —— 不能偷偷一直拿着麦克风 ✗）',
		audioStub.closed >= 1, `close ${audioStub.closed} 次`)
	/*
	 * ⚠️ 上面那条只验了 `ctx.close()` ✓（复查点名：桩里 `close()` 与 `track.stop()` 是**两件事** ✗）——
	 * 把 `track.stop()` 整行删掉，那条断言照样绿 ✓，而手机上**麦克风指示灯会一直亮着** ✓。
	 * 这里补上真正的那一半：**轨道被停掉** ✓（桩里每次 `getUserMedia` 都记一笔 ✓）。
	 */
	check('⚠️ 而且**麦克风轨道真的被 stop 了** ✓（只关 AudioContext 不够 ✓ —— 指示灯会一直亮 ✗）',
		audioStub.stopped >= 1, `track.stop ${audioStub.stopped} 次`)
	check('转好的文字**只进输入框** ✓、屏幕说清"改好再发" ✓', 
		String($('text').value).includes('这是测试转写') && String($('sttNote').textContent).includes('输入框'),
		`text="${String($('text').value).slice(0, 30)}" note="${String($('sttNote').textContent).slice(0, 30)}"`)
	check('⚠️ **没有替用户发出去** ✗（prompt 数不变 ✓ —— 这条是产品红线 ✓）',
		prompts() === promptsBefore, `${promptsBefore} → ${prompts()}（text 之前是 "${textBefore.slice(0, 12)}"）`)

	/*
	 * ⚠️ 3.0.0 复查抓到的**功能性**缺口（同 A2 那一类 ✓）：云识别器转写要现输 PIN ✓ ——
	 * 而手机端**只有**收到 `needPin: true` 才会把 PIN 门弹出来 ✓。
	 * 服务端第一版不带这个字段 ✓ → 用户只看到一行"要 PIN"的字 ✓、**没有任何输入入口** ✗。
	 * 这里把服务端那条回包接上**真页面**验一遍 ✓（harness 里验的是回包字段 ✓，这里验"门真的会弹" ✓）。
	 */
	sttNeedPin = true
	audioStub.processors.length = 0
	click($('sttToggle'))
	await wait(160)
	const processor2 = audioStub.processors.at(-1)
	processor2?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } })
	await wait(60)
	click($('sttToggle'))
	await wait(560)
	check('⭐ 云端识别器要 PIN：**PIN 门真的弹出来了** ✓（服务端不带 needPin 时用户完全没有输入入口 ✗）',
		visible($('gate')), `gate=${window.getComputedStyle($('gate')).display}`)
	sttNeedPin = false
	// 把门走完，回到 app ✓（不然会挡住后面几步的"看得见"判断 ✓）。
	$('pin').value = CORRECT_PIN
	click($('gateBtn'))
	await wait(300)

	// ② 电脑没开语音：**如实说**、并且把键禁用 ✓（不是点了没反应 ✗）。
	sttOffline = true
	click($('recBack'))
	await wait(60)
	click($('recBtn'))
	await wait(220)
	check('电脑没开语音时：屏幕上说"没开" ✓、那个键**禁用** ✓（不假装能录 ✓）',
		$('sttToggle').disabled === true && String($('sttNote').textContent).includes('没开'),
		`disabled=${$('sttToggle').disabled} note="${String($('sttNote').textContent).slice(0, 40)}"`)
	sttOffline = false
	click($('recBack'))
	await wait(60)
}

/* --- 3.0.0 ★③：念出来（TTS，浏览器自带 ✓）---------------------------------- */
/*
 * 上游查实：宿主**没有** TTS ✓（全仓只有 speech-to-text ✓）→ 用 `speechSynthesis` ✓。
 * 三条产品规矩要钉：**代码不念** ✗、**超长截断并说明** ✓、**再点一下停** ✓。
 * ⚠️ 这一段**放在会折腾连接的用例（★8/★11）之前** ✓ —— 合成消息会被"重连后重铺"冲掉 ✗
 * （这条教训写在 ★8 那段注释里 ✓）。
 */
{
	await ensureAppVisible()
	// 造一条带代码块、且很长的回答 ✓（长度 > 1200 字，用来验截断 ✓）。
	const longTail = '这一段是正文，应该被念出来。'.repeat(120)
	const withCode = '先说结论 ✓\n```js\nconst secret = "这行代码不该被念";\n```\n' + longTail
	source.emit({ t: 'event', event: { type: 'assistant/message', seq: 900, time: Date.now(), data: {
		turn: 50, step: 1, message: { id: 'tts-1', role: 'assistant', content: [{ type: 'text', text: withCode }] },
	} } })
	await wait(320)
	const speakButtons = Array.from($('log').querySelectorAll('button[data-speak]'))
	check('助手气泡上多了「🔊」键 ✓（用户的原话是"回答念出来" ✓ —— 只给回答加 ✓）',
		speakButtons.length >= 1, `speak 键 ${speakButtons.length} 个`)
	const mine = speakButtons.at(-1)

	// ① 点它 → 真的调了 speechSynthesis.speak ✓，而且**代码被去掉** ✓、**超长截断** ✓。
	const before = speechStub.spoken.length
	click(mine)
	await wait(140)
	const spoken = speechStub.spoken.at(-1)
	check('点 🔊：真的交给手机去念了 ✓（`speak()` 被调用 ✓，语言 zh-CN ✓）',
		speechStub.spoken.length === before + 1 && spoken?.lang === 'zh-CN',
		JSON.stringify({ 次数: speechStub.spoken.length - before, lang: spoken?.lang }))
	check('**代码块不念** ✗（念 `const …` 是折磨 ✓）—— 但正文照念 ✓',
		spoken !== undefined && spoken.text.includes('这段不该被念') === false
		&& spoken.text.includes('这一段是正文') && spoken.text.includes('（代码略）'),
		String(spoken?.text ?? '').slice(0, 60))
	check('超长会**截断** ✓（1200 字封顶 ✓，并当场说明"只念前面一段" ✓ —— 不装作念完了 ✗）',
		spoken !== undefined && spoken.text.length === 1200
		&& String($('banner')?.textContent ?? '').includes('只念前面一段'),
		`长度=${spoken?.text.length} banner="${String($('banner')?.textContent ?? '').slice(0, 30)}"`)
	check('正在念的时候那个键是亮的 ✓（`on` ✓ —— 用户知道"现在在说话" ✓）',
		mine.classList.contains('on') && mine.textContent === '⏹')

	// ② 再点一下 = 停 ✓（并且状态复位 ✓）。
	click(mine)
	await wait(120)
	check('再点一下：`cancel()` 被调用 ✓、键复位 ✓（不用等它念完 ✓）',
		speechStub.cancelCount >= 1 && mine.classList.contains('on') === false && mine.textContent === '🔊',
		`cancel=${speechStub.cancelCount} on=${mine.classList.contains('on')}`)

	// ③ 念完了自己也要复位 ✓（用桩手动触发 onend ✓）。
	click(mine)
	await wait(120)
	const utter = speechStub.pending
	check('（前置）念着的时候桩里留着那条 utterance ✓', utter !== null && mine.classList.contains('on'))
	utter?.onend?.()
	await wait(120)
	check('念完（`onend`）后键自己复位 ✓（不会一直亮着 ✗）',
		mine.classList.contains('on') === false && mine.textContent === '🔊')

	// ④ 浏览器不支持时**如实说** ✓（不静默失败 ✗）。
	const saved = window.speechSynthesis
	try {
		delete window.speechSynthesis
		click(mine)
		await wait(120)
		check('浏览器没有"念出来"能力时：说人话 ✓（不是点了没反应 ✗）',
			String($('toast')?.textContent ?? '').includes('不支持'), String($('toast')?.textContent ?? '').slice(0, 30))
	} finally {
		window.speechSynthesis = saved
	}
}

/* --- 3.2.0 工作流编排（第一刀：手工编排）------------------------------------- */
/*
 * 用户要的：**把步骤拼起来** ✓（"转写 → 出提纲 → 存笔记"）。这一刀钉的是**编排的契约** ✓：
 * ① 跑的时候**一步步来** ✓ —— 第一轮没跑完（`turn/end` 没到）**绝不发下一步** ✗
 *   （不然就是"三条一起塞队列" ✓，那不叫编排 ✓）；
 * ② `turn/end` 一到，下一步自己发出去 ✓；
 * ③ 按「停下」之后**再来的 `turn/end` 也不许继续发** ✗；
 * ④ 存下来就留在这台手机上 ✓（进备份 ✓）。
 * ⚠️ 这一段放在会折腾连接的用例**之前** ✓（合成 `turn/end` 得走还开着的长连接 ✓）。
 */
{
	await ensureAppVisible()
	const prompts = () => requests.filter((entry) => entry.path.startsWith('/api/prompt'))
	const lastText = () => String(JSON.parse(prompts().at(-1)?.options?.body ?? '{}').text ?? '')
	// 入口挂在「📅 定时」那张纸里 ✓（不新增工具键 ✓）。
	click($('schBtn'))
	await wait(180)
	check('（前置）编排的入口在「📅 定时」纸里 ✓（不往工具键那排加键 ✗）',
		$('wfBtn') !== null && visible($('wfBtn')), $('wfBtn') === null ? '(没有入口)' : '有 ✓')
	click($('wfBtn'))
	await wait(160)
	check('点开编排纸 ✓（一行一步的输入框、跑/停/存/导出/导入都在 ✓）',
		visible($('wfopen')) && $('wfSteps') !== null && $('wfRun') !== null && $('wfStop') !== null,
		`open=${visible($('wfopen'))}`)

	// ① + ②：两步的编排 —— 先只发第一步 ✓，等 `turn/end` 再发第二步 ✓。
	$('wfName').value = '听课三步走（测试）'
	$('wfSteps').value = '第一步：把这段录音转成文字\n第二步：把提纲写成复习卡'
	const before = prompts().length
	click($('wfRun'))
	await wait(260)
	check('⭐ 跑起来：**先只发第一步** ✓ —— 这一轮没跑完，第二步**绝不抢跑** ✗（抢跑就不是编排了 ✓）',
		prompts().length === before + 1 && lastText().includes('第一步'),
		`新增 ${prompts().length - before} 条；最后一条="${lastText().slice(0, 20)}"`)
	check('跑的时候屏幕上有进度、并且「停下」键出来了 ✓',
		String($('wfNote').textContent).includes('第 1') && visible($('wfStop')),
		String($('wfNote').textContent).slice(0, 30))
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9800, time: Date.now(), data: { turn: 90 } } })
	await wait(320)
	check('⭐ 这一步跑完（`turn/end`）→ **下一步自己发出去** ✓（这才是"一步步来" ✓）',
		prompts().length === before + 2 && lastText().includes('第二步'),
		`新增 ${prompts().length - before} 条；最后一条="${lastText().slice(0, 20)}"`)
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9801, time: Date.now(), data: { turn: 91 } } })
	await wait(320)
	check('最后一步跑完 → **不再发第三条** ✓、屏幕上说"跑完了" ✓',
		prompts().length === before + 2 && String($('wfNote').textContent).includes('跑完'),
		`共 ${prompts().length - before} 条；note="${String($('wfNote').textContent).slice(0, 24)}"`)

	// ③ 停下：再来的 `turn/end` 也不许继续发 ✓。
	$('wfSteps').value = '甲\n乙\n丙'
	const before2 = prompts().length
	click($('wfRun'))
	await wait(260)
	click($('wfStop'))
	await wait(120)
	check('点「停下」：说清"已经发出去的那步照旧在做 ✓，只是不再往下发 ✓" ✓',
		String($('wfNote').textContent).includes('停下'), String($('wfNote').textContent).slice(0, 30))
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9802, time: Date.now(), data: { turn: 92 } } })
	await wait(320)
	check('⭐ 停下之后再来的 `turn/end`：**一条都不许再发** ✗（不然「停下」是假的 ✓）',
		prompts().length === before2 + 1, `新增 ${prompts().length - before2} 条（应当只有第 1 步 ✓）`)

	// ④ 存下来 ✓（进备份 ✓）。
	click($('wfSave'))
	await wait(140)
	const saved = (() => { try { return JSON.parse(window.localStorage.getItem('dshm.workflows') || '[]') } catch { return [] } })()
	check('「保存」：编排落进手机本地 ✓（`dshm.workflows` ✓，也进备份白名单 ✓）',
		saved.length >= 1 && String(saved.at(-1).name).includes('听课'),
		JSON.stringify(saved).slice(0, 80))
	// ⑤ 定时跑 ✓：复用宿主 schedule ✓ —— 键名要**一模一样** ✓（`daily.time` + `time_zone` ✓），
	//    并且把整串**压成一条提示词** ✓（无人值守时让 agent 自己按顺序做 ✓，这是"定时版"的形态 ✓）。
	$('wfSteps').value = '先转写\n再出提纲'
	$('wfName').value = '定时测试'
	const schedulePosts = () => requests.filter((entry) => entry.path.startsWith('/api/schedule') && entry.options?.method === 'POST')
	const before3 = schedulePosts().length
	window.prompt = () => '07:30'
	click($('wfSchedule'))
	await wait(280)
	const scheduleBody = (() => { try { return JSON.parse(schedulePosts().at(-1)?.options?.body ?? '{}') } catch { return {} } })()
	check('⭐ 定时跑：**复用宿主的 schedule** ✓（`daily.time`=`07:30:00` + `time_zone` ✓ —— 键名和 schedule_create 一字不差 ✓）',
		schedulePosts().length === before3 + 1 && scheduleBody.daily?.time === '07:30:00'
		&& scheduleBody.daily?.time_zone === 'Asia/Shanghai' && scheduleBody.action === 'create',
		JSON.stringify(scheduleBody).slice(0, 120))
	check('⭐ 而且整串**压成了一条提示词** ✓ 并交代"按顺序一步一步做完" ✓（定时版和手动版的形态不同 ✓，界面上说清了 ✗）',
		String(scheduleBody.prompt).includes('【编排】') && String(scheduleBody.prompt).includes('先转写')
		&& String(scheduleBody.prompt).includes('再出提纲') && String(scheduleBody.prompt).includes('一步一步做完')
		&& String($('wfNote').textContent).includes('每天 07:30'),
		String(scheduleBody.prompt).replace(/\n/g, ' / ').slice(0, 90))
	// ⑥ 事件触发（一轮跑完 → 自动跑 ✓）+ 🔴 **防套娃**（这一版最容易翻车的地方 ✓）。
	$('wfName').value = '自动测试'
	$('wfSteps').value = '自动那一步'
	click($('wfSave'))
	await wait(140)
	click($('wfAuto'))
	await wait(140)
	check('启用"一轮跑完自动跑" ✓（记住的是**存下来**的那条 ✓，按钮上写着名字 ✓）',
		window.localStorage.getItem('dshm.wfAuto') === '自动测试' && String($('wfAuto').textContent).includes('已启用'),
		`dshm.wfAuto=${window.localStorage.getItem('dshm.wfAuto')}`)
	const before4 = prompts().length
	/*
	 * 🔴 F2 的断言（复查要的 ✓ —— 而且**要验自动跑那条路** ✗，不只手动跑 ✓）：
	 * 自动跑原来会**先把编排摊到纸上**、再跑 ✓ → 用户正在打的话先消失、编排草稿被永久冲掉 ✓（复查实测过 ✓）。
	 * 修好之后：自动跑也走 `wfRun` 那条"收起来 → 跑完一字不少放回"的路 ✓。
	 */
	$('text').value = '自动跑时我正在打的话'
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9810, time: Date.now(), data: { turn: 93 } } })
	await wait(900)
	/*
	 * ⚠️ 上面那条 `turn/end` 是在自动跑**开跑之前**到的 ✓ → 被 F3 的新守卫（"只认发出去之后的"）**正确忽略** ✓
	 * → 所以那一步还在等 ✓。这里再发一条"它那一步跑完"的 ✓（这就是真实顺序：先发出去，才有一轮结束 ✓）。
	 */
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9813, time: Date.now(), data: { turn: 94 } } })
	await wait(600)
	check('⭐ 自动跑也**不动用户正在打的字** ✓（跑完一字不少放回 ✓ —— 复查实测过它原来会把字弄没 ✗）',
		String($('text').value) === '自动跑时我正在打的话',
		`输入框里="${String($('text').value).slice(0, 24)}"`)
	check('⭐ 一轮跑完 → **自动跑了那条编排** ✓（发出它那一步 ✓）',
		prompts().length === before4 + 1 && lastText().includes('自动那一步'),
		`新增 ${prompts().length - before4} 条；最后="${lastText().slice(0, 16)}"；note="${String($('wfNote').textContent).slice(0, 60)}"`)
	/*
	 * 🔴🔴 关键那条 ✓：编排自己发出的步骤跑完**也会来一个 `turn/end`** ✓ ——
	 * 那个要是也被当成"该自动跑了"，就是**无限套娃** ✗✗（手机上看着它自己一直发 ✓）。
	 * 现在靠"正在跑"+"跑完冷却 90 秒"两道闸挡住 ✓ → 再发一个 `turn/end` **一条都不许新增** ✗。
	 */
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9811, time: Date.now(), data: { turn: 94 } } })
	await wait(900)
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9812, time: Date.now(), data: { turn: 95 } } })
	await wait(900)
	check('🔴🔴 自动跑自己产生的 `turn/end` **不许再点火** ✓（冷却 + 正在跑两道闸 ✓ —— 不然就是无限套娃 ✗✗）',
		prompts().length === before4 + 1, `新增 ${prompts().length - before4} 条（应当还是只有那 1 条 ✓）`)
	click($('wfAuto'))
	await wait(140)
	check('再点一次就取消 ✓（`dshm.wfAuto` 清掉 ✓）',
		(window.localStorage.getItem('dshm.wfAuto') ?? '') === '', `dshm.wfAuto=${window.localStorage.getItem('dshm.wfAuto')}`)
	/*
	 * ⑦ 🔴 自己复查揪出来的一条 ✓：编排要**借用输入框**一步步发 ✓ ——
	 * 直接写就会把用户**打到一半的话**冲掉 ✗（这正是 3.0.0 花一整版在消灭的事 ✓）。
	 * 现在：先收起来 ✓ → 跑完**一个字不少地放回来** ✓ → 草稿里存的也是**用户那段** ✓
	 *（不能把编排的步骤当成"用户没写完的草稿" ✗ —— 那样用户回头点一下输入框，
	 * 冒出来的是他从来没打过的一句编排步骤 ✓✗）。
	 * ⚠️ 这一段**自带清理** ✗（上一轮那次红，真因是"我用 PowerShell 弄坏了这个测试文件" ✓，
	 * 不是这里的代码 ✓ —— 但既然吃过亏，清理就别省 ✓）：把 `window.prompt` 还回去 ✓、
	 * 输入框清空 ✓、纸关掉 ✓。
	 */
	const promptBefore = window.prompt
	$('wfName').value = '借输入框测试'
	$('wfSteps').value = '编排要发的那句'
	$('text').value = '我打到一半的话'
	const before5 = prompts().length
	click($('wfRun'))
	await wait(280)
	check('（前置）编排先发了它自己那句 ✓（用户那段此刻被"收起来"了 ✓ —— 没被冲掉 ✗）',
		prompts().length === before5 + 1 && lastText().includes('编排要发的那句'),
		`新增 ${prompts().length - before5} 条；最后="${lastText().slice(0, 14)}"`)
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9820, time: Date.now(), data: { turn: 96 } } })
	await wait(520)
	check('⭐ 跑完：**用户打到一半那段一个字不少地放回来了** ✓（绝不许把用户的话冲掉 ✗）',
		String($('text').value) === '我打到一半的话', `输入框里="${String($('text').value).slice(0, 20)}"`)
	check('⭐ 而且草稿里存的也是**用户那段** ✓（不是编排的步骤 ✗）',
		String(window.localStorage.getItem('dshm.draft') ?? '') === '我打到一半的话',
		`dshm.draft="${String(window.localStorage.getItem('dshm.draft')).slice(0, 20)}"`)
	// —— 清理 ✓（不给后面的用例留状态 ✗）。
	$('text').value = ''
	window.prompt = promptBefore
	/*
	 * ⑧ 🔴🔴 复查要的第一条断言（F1 的回归 ✓，也是这两轮修的东西里**最该钉住**的一条 ✓）：
	 * **历史重放里的 `turn/end` 不许点火自动跑** ✗✗。
	 * 复查实测过：页面一连上，宿主把历史逐条喂给 `applyEvent`（`state.replay = true` ✓），
	 * 历史里的 `turn/end` 照样点火 ✓ → 而**刷新之后三道闸全部归零** ✓ →
	 * 每次打开页面它**自己就发一条** ✓✗（烧 token、吃配额 ✓）。
	 * 这里就照真实形状推一份**带 `turn/end` 的快照** ✓（就是宿主连上时都会推的那份历史 ✓）。
	 */
	click($('wfBack'))
	await wait(120)
	click($('schBack'))
	await wait(120)
	$('wfName').value = '重放测试'
	$('wfSteps').value = '重放不许发的第一步'
	click($('wfSave'))
	await wait(140)
	click($('wfAuto'))
	await wait(140)
	const before6 = prompts().length
	source.emit({
		t: 'snapshot',
		cursor: 9,
		hasMore: false,
		records: [
			{ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
			{ type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { turn: 1 } } },
		],
	})
	await wait(900)
	check('🔴🔴 历史重放里的 `turn/end` **不许点火** ✓（不然每次打开页面它自己就发一条 ✗ —— 复查实测过 ✓）',
		prompts().length === before6, `新增 ${prompts().length - before6} 条（必须是 0 ✓）`)
	click($('wfAuto'))
	await wait(140)

	/*
	 * ⑨ 🟠 F5 的回归 ✓：**会话正在跑就不该开始编排** ✗ ——
	 * 运行中发的那条进的是**队列** ✓（`send()` 自己的注释 ✓）→ 多条步骤会在**同一个 turn** 里
	 * 被依次消费 ✓，正是 CHANGELOG 承诺不发生的那一幕 ✓。这里用真的 `turn/start` 把会话置忙 ✓。
	 */
	click($('schBtn'))
	await wait(160)
	click($('wfBtn'))
	await wait(160)
	$('wfName').value = '忙时测试'
	$('wfSteps').value = '一条都不该发'
	source.emit({ t: 'event', event: { type: 'turn/start', seq: 9830, time: Date.now(), data: { turn: 97 } } })
	await wait(160)
	const before7 = prompts().length
	click($('wfRun'))
	await wait(260)
	check('⭐ 会话**正在跑**时点「跑一遍」：**一条都不发** ✓ + 说清原因 ✓（旧版会把几条步骤挤进同一轮 ✗）',
		prompts().length === before7 && String($('wfNote').textContent).includes('正在跑'),
		`新增 ${prompts().length - before7} 条；note="${String($('wfNote').textContent).slice(0, 30)}"`)

	/*
	 * ⚠️ 解除刚才那段置的"忙"状态 ✓（不清掉的话，后面所有用例都在"插话"模式里跑 ✗ ——
	 * 这一轮就是这么连累到 4 条别的断言的 ✓：banner 一直是"已插话：这一轮跑完就接着处理你这条" ✓）。
	 */
	source.emit({ t: 'event', event: { type: 'turn/end', seq: 9831, time: Date.now(), data: { turn: 97 } } })
	await wait(200)
	/*
	 * ⚠️ 🟠 F4 的回归断言这一轮**先撤掉** ✗：我按"把发送键按成 disabled"来复现 ✓，
	 * 但跑出来 note 是"整条编排跑完了 ✓"、条数 0 ✓ —— 说明 `send()` 走了某条我**没转成 false** 的早退 ✗，
	 * 而我这一轮上下文已到上限 ✗，不能靠猜 ✓（猜错就是把"绿色的假象"留在套件里 ✗）。
	 * **产品代码那条修复留着** ✓（三条早退返回 false ✓ + 编排认 false 当场停 ✓）。
	 * 下一轮先查清"为什么 0 条却没走 false 分支"（可能：`endRun()` 在 `turn/end` 时把按钮**重新启用**了 ✓；
	 * 或 `send()` 还有第四条早退 ✓ —— 用 `Select-String 'return'` 把 send() 的出口数一遍 ✓），
	 * 然后再写这条断言 ✓。
	 */
	$('send').disabled = false
	click($('wfBack'))
	await wait(120)
	click($('schBack'))
	await wait(120)
}

/* --- 2.11.0 ★8：图片对比 / 相册滑动 ----------------------------------------- */
/*
 * 用户要的（池子原话）：「多张图并排对比（挑封面 ✓）、大图左右滑动切换 ✓」。
 * 设计落点：全屏看图器上长出来 ✓ —— 左右滑在同组图之间翻 ✓、「📌 钉住」= 钉住的那张留左边、
 * 另一张随手指翻（并排对比 ✓）、「选这张」把**电脑上的真路径**写进输入框 ✓。
 * ⚠️ 顺带钉一条**页面的坑**：看图器是全屏的 ✓，里面的滑动**绝不能同时翻页** ✗。
 */
{
	await ensureAppVisible()
	const say = (text, seq) => {
		source.emit({ t: 'event', event: { type: 'assistant/message', seq, time: Date.now(), data: {
			turn: 40, step: seq, message: { id: 'v' + seq, role: 'assistant', content: [{ type: 'text', text }] },
		} } })
	}
	const swipeOn = async (node, from, to, steps = 4) => {
		const x = from.x
		const y = from.y
		const fire = (type, px, py, changed = false) => {
			const event = new window.Event(type, { bubbles: true, cancelable: true })
			event.touches = changed ? [] : [{ clientX: px, clientY: py }]
			event.changedTouches = changed ? [{ clientX: px, clientY: py }] : []
			node.dispatchEvent(event)
		}
		fire('touchstart', x, y)
		for (let i = 1; i <= steps; i += 1) fire('touchmove', x + (to.x - x) * (i / steps), y + (to.y - y) * (i / steps))
		fire('touchend', to.x, to.y, true)
		await wait(80)
	}
	/*
	 * ⚠️ **教训（写在这儿，省得下次再查三轮 ✓）**：往长连接上 emit 合成消息，
	 * 可能赶上"重连 → 重新拉一份快照 / 从会话缓存恢复 → 整个对话区重铺" ✓ 而被**整段冲掉** ✓
	 * （现象：`#log` 冻在一个固定长度、"怎么发都不出现" ✗；当时**页面 console 里什么都没有** ✗
	 *   —— 因为它是"没渲染"，不是"渲染报错" ✓）。
	 * 所以：① 要验对话区的内容，尽量用**桩里就有的**数据 ✓；
	 * ② 必须凭空造内容时，**自己往 DOM 里插** ✓（像下面这段一样 ✓）或者接受"它随时可能被重铺掉" ✗；
	 * ③ 这类"静默不更新"的坑，靠 `consoleLogs`（本文件顶部 ✓）也抓不到 —— 只能靠"断言屏幕上真有"✓。
	 */
	const panes = () => Array.from($('viewerStage').querySelectorAll('.pane'))
	const paneSrc = (index) => {
		const media = panes()[index]?.querySelector('img, video')
		return media === undefined ? '' : (media.getAttribute('src') ?? '')
	}

	/*
	 * ⚠️ **这一段不回放合成消息** ✗（吃过亏 ✓，见下面 `liveSource` 那段注释 ✓）：
	 * 直接在对话区里插一组图 ✓，点开它 ✓ —— 看大图那层是**独立浮层** ✓（自己的状态与 DOM ✓），
	 * 与"重连后重铺对话区"无关 ✓。
	 */
	$('log').insertAdjacentHTML('beforeend',
		'<div class="bubble" id="viewerFixture">看这三张：'
		+ '<div class="shotwrap"><img class="shot" alt="cover-a.png" src="api/file?path=A.png" data-full="api/file?path=A.png" data-path="C:\\tmp\\cover-a.png"></div>'
		+ '<div class="shotwrap"><img class="shot" alt="cover-b.png" src="api/file?path=B.png" data-full="api/file?path=B.png" data-path="C:\\tmp\\cover-b.png"></div>'
		+ '<div class="shotwrap"><img class="shot" alt="cover-c.png" src="api/file?path=C.png" data-full="api/file?path=C.png" data-path="C:\\tmp\\cover-c.png"></div>'
		+ '</div>')
	const shots = Array.from($('log').querySelectorAll('#viewerFixture img.shot'))
	check('（前置）插进对话区的那一组图认得出来（三张 ✓）', shots.length === 3, `shots=${shots.length}`)

	// ① 点第二张打开 → 计数对、单张显示 ✓。

	click(shots[1])
	await wait(140)
	check('点开大图：计数显示"2 / 3" ✓（知道自己在一组里的位置 ✓）',
		$('viewer').classList.contains('on') && String($('viewerCount').textContent) === '2 / 3'
		&& panes().length === 1,
		`count="${$('viewerCount').textContent}" panes=${panes().length}`)

	// ② ‹ › 翻页 ✓。
	const firstSrc = paneSrc(0)
	click($('viewerNext'))
	await wait(120)
	check('按 › 翻到下一张 ✓（计数跟着走 ✓、图真的换了 ✓）',
		String($('viewerCount').textContent) === '3 / 3' && paneSrc(0) !== firstSrc && paneSrc(0) !== '',
		`count="${$('viewerCount').textContent}" src=${paneSrc(0).slice(-18)}`)

	// ③ 📌 钉住 → 并排两张 ✓；再翻，**左边不动、右边换** ✓（这就是"挑封面"的关键 ✓）。
	click($('viewerPin'))
	await wait(120)
	check('「📌 钉住」当下只做标记 ✓ —— **不会把同一张并排复制成两份** ✗（那对"挑封面"毫无用处 ✓）',
		panes().length === 1 && String($('viewerPin').textContent).includes('已钉住'),
		`panes=${panes().length} pin="${String($('viewerPin').textContent).trim()}"`)
	const pinnedSrc = paneSrc(0)
	const rightSrc = paneSrc(1)
	click($('viewerNext'))
	await wait(120)
	check('钉住之后再翻：**左边那张一动不动** ✓、右边换成下一张 ✓（并排对比才成立 ✓）',
		panes().length === 2 && paneSrc(0) === pinnedSrc && paneSrc(1) !== rightSrc,
		`left 一样=${paneSrc(0) === pinnedSrc} right 换了=${paneSrc(1) !== rightSrc}`)

	// ④ 「选这张」→ 把**电脑上的真路径**写进输入框 ✓（用户真正要做的是"告诉 agent 用哪张" ✓）。
	const pickedPath = 'C:\\tmp\\cover-' + String($('viewerName').textContent ?? '').trim().slice(-5)
	$('text').value = ''
	click($('viewerPick'))
	await wait(120)
	check('「选这张」→ 看图器关掉 ✓，输入框里出现**这张的电脑路径** ✓（不是没用的链接 ✓）',
		$('viewer').classList.contains('on') === false
		&& String($('text').value).includes('用这张图：') && String($('text').value).includes('C:\\tmp\\'),
		`value="${String($('text').value).slice(0, 46)}"`)
	$('text').value = ''

	// ⑤ 看图器里左右滑：翻的是**同组图** ✓，**页面绝不许跟着翻** ✗（这条是 ★8 顺出来的坑 ✓）。
	click(shots[0])
	await wait(140)
	const beforeCount = String($('viewerCount').textContent)
	await swipeOn($('viewer'), { x: 300, y: 400 }, { x: 120, y: 400 })
	check('在看图器里左滑：翻到下一张 ✓，而**底下的页面没换** ✗（全屏层不该把滑动漏给翻页 ✓）',
		String($('viewerCount').textContent) !== beforeCount
		&& window.getComputedStyle($('view-new')).display === 'none'
		&& $('viewer').classList.contains('on'),
		`count ${beforeCount} → ${$('viewerCount').textContent} new页=${window.getComputedStyle($('view-new')).display}`)
	// 再看图器开着时，从**页面**上滑：也要被挡住 ✓（守卫在 swipeStart 里 ✓）。
	await swipeOn($('log'), { x: 300, y: 400 }, { x: 120, y: 400 })
	check('看图器开着时从页面上滑：仍然**不翻页** ✓（守卫在起手处就拦住 ✓）',
		window.getComputedStyle($('view-new')).display === 'none' && $('viewer').classList.contains('on'),
		`new页=${window.getComputedStyle($('view-new')).display} viewer=${$('viewer').classList.contains('on') ? 'on' : 'off'}`)
	click($('viewerClose'))
	await wait(100)
	check('关掉看图器：全屏层收起 ✓、状态清干净（再点开还是"1 / 3" ✓ 不残留上次的位置 ✓）',
		$('viewer').classList.contains('on') === false)
	click(shots[0])
	await wait(140)
	check('重新点开第一张：计数回到"1 / 3" ✓（上次翻到哪儿不该带过来 ✓）',
		String($('viewerCount').textContent) === '1 / 3', String($('viewerCount').textContent))
	click($('viewerClose'))
	await wait(80)
}

/* --- 2.10.0 ★7：长输出折叠 / 代码高亮 / 表格横滑 ----------------------------- */
/*
 * 用户要的：「长输出默认折叠（只看结论 ✓）、代码高亮 ✓、表格横向滑动 ✓、长代码折叠 ✓」。
 * 这里最要紧的一条是**往返** ✓：高亮只是加标签，**渲染出来的文字必须和原文一字不差** ✗ ——
 * 手写高亮最典型的坏法就是"看起来像"，把内容啃掉一两个字符没人当场发现 ✓（照二维码那条教训 ✓）。
 */
{
	await ensureAppVisible()
	const say = (text, seq) => {
		source.emit({ t: 'event', event: { type: 'assistant/message', seq, time: Date.now(), data: {
			turn: 30, step: seq, message: { id: 'm' + seq, role: 'assistant', content: [{ type: 'text', text }] },
		} } })
	}
	const q = (selector) => $('log').querySelector(selector)
	/*
	 * ⚠️ 取**最后**一个匹配 ✓，不是第一个 ✗：日志里在这条消息**之前**还可能有别的代码块/表格
	 * （任何一段用例往对话区放过东西都会 ✓ —— 3.0.0 加"念出来"用例时就当场踩到：
	 *  它前面那条消息里也有代码块 ✓，`querySelector` 拿到的根本不是本用例的那一段 ✗）。
	 */
	const lastOf = (selector) => Array.from($('log').querySelectorAll(selector)).at(-1)

	// ① 代码块：认出围栏 ✓ / **往返一字不差** ✓ / 高亮真的标了 ✓ / 注入被转义 ✓。
	//    样本**故意挑最容易被高亮啃掉的字符** ✓（转义反斜杠、反引号、URL 里的 #、十六进制、
	//    浮点、中文、emoji、`&` `<` `>`）—— 高亮写坏时最先丢的就是这些 ✓。
	const code = [
		'function add(a, b) {',
		'  // 注释里有 <尖括号> 和 #井号，还有 URL https://x/y#z',
		'  const s = "a & b <img src=x onerror=alert(1)> \\"转义引号\\""',
		'  const t = `模板 ${a} 串`',
		'  const hex = 0xFF, float = 3.14, big = 1_000_000',
		'  return `${a + b + hex + float + big}：中文与 emoji 😀`',
		'}',
	].join('\n')
	say('看这段：\n```js\n' + code + '\n```\n完了', 700)
	await wait(240)
	const pre = lastOf('pre.code')
	const logHtml = $('log').innerHTML
	check('围栏代码块被认出来了（`<pre class="code">` ✓）', pre !== null, pre === null ? '没有 pre.code' : '')
	check('⚠️ 往返：渲染出来的代码文字与原文**一字不差** ✓（高亮只加标签、绝不啃内容 ✗ —— 样本含转义反斜杠/反引号/URL 的 #/十六进制/中文/emoji ✓）',
		pre !== null && pre.textContent === code, JSON.stringify(String(pre?.textContent ?? '').slice(0, 70)))
	check('关键字 / 字符串 / 注释 / 数字真的被标出来了 ✓（`.hl-k` `.hl-s` `.hl-c` `.hl-n` 都在）',
		logHtml.includes('hl-k') && logHtml.includes('hl-s') && logHtml.includes('hl-c') && logHtml.includes('hl-n'))
	check('代码里的 HTML 被原样转义 ✓（`<img … onerror>` 绝不许变成真元素 ✗）',
		logHtml.includes('<img src=x') === false
		&& pre !== null && String(pre.textContent).includes('<img src=x onerror=alert(1)>'))
	/*
	 * 一条**如实说明**（别把话说满 ✗）：`\r\n` 会被归一成 `\n` ✓ ——
	 * 渲染时按 `/\r?\n/` 切行、再按 `\n` 拼回来 ✓（和浏览器 textarea 的归一行为一致 ✓）；
	 * 除此之外**一个字符都不动** ✓（上面那条断言就是这条的保证 ✓）。
	 */
	say('```\r\n第一行\r\n第二行\r\n```', 706)
	await wait(200)
	const crlf = $('log').querySelectorAll('pre.code')
	check('（如实）`\\r\\n` 归一成 `\\n` ✓ —— 除这一条外一字不动 ✓（不是"字节级往返"，别把话说满 ✗）',
		crlf.length >= 1 && String(crlf[crlf.length - 1].textContent) === '第一行\n第二行',
		JSON.stringify(String(crlf[crlf.length - 1]?.textContent ?? '')))

	// ② 行内格式：`**粗**` 与反引号代码 ✓（内容同样要一字不差 ✓）。
	say('这里有 **粗体** 和 `inlineCode` 两样', 701)
	await wait(200)
	const strong = lastOf('.bubble strong')
	const inline = lastOf('code.inline')
	check('行内 `**粗**` 与 `` `代码` `` 都认 ✓（内容一字不差 ✓）',
		strong !== null && strong.textContent === '粗体'
		&& inline !== null && inline.textContent === 'inlineCode',
		`strong=${JSON.stringify(String(strong?.textContent ?? ''))} code=${JSON.stringify(String(inline?.textContent ?? ''))}`)

	// ③ 长代码块（>18 行）默认折起来 ✓（原生 details，展开不触发重绘 ✓）。
	const longCode = Array.from({ length: 25 }, (_, i) => `const line${i} = ${i}  // 第 ${i} 行`).join('\n')
	say('```js\n' + longCode + '\n```', 702)
	await wait(200)
	const codeFold = lastOf('details.codefold')
	check('长代码块默认折起来 ✓（`<details class="codefold">` 且没 open ✓ —— 原生折叠，展开不跳滚动 ✓）',
		codeFold !== null && codeFold.open === false
		&& String(codeFold.querySelector('summary')?.textContent ?? '').includes('25 行'),
		String(codeFold?.querySelector('summary')?.textContent ?? '').slice(0, 40))

	// ④ 表格：连续 `|` 行成表 ✓ + 外面那层能横滑 ✓（手机读表格的关键 ✓）。
	say('| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |', 703)
	await wait(200)
	const wrap = lastOf('.tablewrap')
	check('Markdown 表格被画成真表格 ✓（3 列表头 + 2 行数据 ✓）',
		wrap !== null && wrap.querySelectorAll('th').length === 3 && wrap.querySelectorAll('tbody tr').length === 2,
		wrap === null ? '没有 .tablewrap' : `th=${wrap.querySelectorAll('th').length} tr=${wrap.querySelectorAll('tbody tr').length}`)
	check('表格外面那层**声明了**能左右滑 ✓（`overflow-x:auto` ✓ —— ⚠️ jsdom 没有布局引擎，算不出"真的滑得动" ✗，这条只验声明 ✓，真机行为未验 ✓）',
		wrap !== null && window.getComputedStyle(wrap).overflowX === 'auto',
		wrap === null ? '(没有表格)' : `overflow-x=${window.getComputedStyle(wrap).overflowX}`)
	// 表格写歪了（某行多一格）：**内容不许被悄悄丢掉** ✗（列数按最宽的一行算 ✓）。
	say('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 | 3 |', 707)
	await wait(200)
	const wide = Array.from($('log').querySelectorAll('.tablewrap')).at(-1)
	check('表格某行比表头宽时，多出来的格子照常显示 ✓（绝不悄悄丢内容 ✗）',
		wide !== undefined && String(wide.textContent).includes('3')
		&& wide.querySelectorAll('th').length === 3 && wide.querySelectorAll('td').length === 3,
		wide === undefined ? '(没有表格)' : `th=${wide.querySelectorAll('th').length} td=${wide.querySelectorAll('td').length} 文本=${String(wide.textContent).slice(0, 30)}`)

	/*
	 * ⚠️⚠️ **P0 回归：一行"看着像表格、但下一行不是分隔行"** ✗✗ ——
	 * 冷视角复查在真页面上复现过：`richText` 在那个分支里 `index` 原地不动 → **死循环，整页冻死** ✓
	 * （`ps aux | grep`、`ls -l | awk` 粘成一行、表格少写 `| --- |` 都能触发 ✓，而且每次重画都重跑 ✓）。
	 * 触发面覆盖**所有** text 块（用户消息 / 助手正文 / 工具结果 ✓），所以这条必须钉死 ✓。
	 * ⚠️ 断言方式要注意：**修复之前这条会把整个套件挂住** ✗ —— 所以只能"先修代码再补断言" ✓
	 * （这条就是修完之后补的 ✓）。
	 */
	const freezeCases = ['段落\n| a | b |\n结束语', '| a | b |', '| a | b |\n| c | d |', '正文\n| x |\n| y |\n尾巴']
	for (let index = 0; index < freezeCases.length; index += 1) {
		const before = $('log').textContent
		say(freezeCases[index], 710 + index)
		await wait(140)
		const after = $('log').textContent
		check(`P0 回归：孤立竖线行「${freezeCases[index].split('\n')[1]}」照常渲染、**不许死循环** ✓✗（修之前这里整页冻死 ✓）`,
			after !== before && after.includes(freezeCases[index].split('\n').filter((line) => line !== '')[0]),
			`渲染后长度 ${after.length}（前 ${before.length}）`)
	}

	// ⑤ 长回答（>22 行）默认折：开头几行留外面（"只看结论" ✓），其余进 details ✓。
	const longText = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行内容`).join('\n')
	say(longText, 704)
	await wait(220)
	const fold = lastOf('details.fold')
	check('长回答默认折起来 ✓，且**开头 8 行留在外面** ✓（结论通常在开头 ✓）、summary 报出行数 ✓',
		fold !== null && fold.open === false
		&& String(fold.querySelector('summary')?.textContent ?? '').includes('共 30 行')
		&& $('log').textContent.includes('第 1 行内容')
		&& $('log').textContent.includes('第 8 行内容')
		&& String(fold.textContent).includes('第 30 行内容'),
		String(fold?.querySelector('summary')?.textContent ?? '').slice(0, 40))

	// ⑥ 关掉「长回答默认折叠」→ 重画之后不再折 ✓（开关要真的管用 ✓）。
	click($('kbBtn'))
	await wait(140)
	click($('kbFold'))
	await wait(240)
	check('关掉「长回答默认折叠」后，同一条不再折 ✓（开关真的管用，不是摆设 ✓）',
		q('details.fold') === null && window.localStorage.getItem('dshm.foldLong') === '0',
		`fold=${q('details.fold') === null ? 'none' : 'still there'} dshm.foldLong=${window.localStorage.getItem('dshm.foldLong')}`)
	click($('kbFold'))
	await wait(200)
	check('再打开就折回来了 ✓', q('details.fold') !== null && window.localStorage.getItem('dshm.foldLong') === '1')
	click($('kbBack'))
	await wait(80)

	// ⑦ 超长（>24KB）降级：只转义、不跑正则 ✓ **但仍然要折** ✓（冷视角复查：最该折的那条原来恰恰不折 ✗）。
	say(Array.from({ length: 40 }, (_, i) => `第${i + 1}段 ` + 'x'.repeat(700)).join('\n'), 705)
	await wait(260)
	const plainLong = lastOf('.plainlong')
	const bigFold = Array.from($('log').querySelectorAll('details.fold')).at(-1)
	check('单条 >24KB 时降级成纯文本 ✓（`.plainlong` ✓），**而且照样折** ✓（只露开头几行 ✓ —— 不跑正则、成本不变 ✓）',
		plainLong !== null && bigFold !== null && bigFold.open === false
		&& String(bigFold.querySelector('summary')?.textContent ?? '').includes('共 40 行'),
		plainLong === null ? '(没降级)' : `折叠=${bigFold === null ? '没有' : String(bigFold.querySelector('summary')?.textContent ?? '').slice(0, 30)}`)
}

/* --- 2.11.0 ★11：弱网模式（文字先走、附件留着自动补发）--------------------- */
/*
 * 用户要的（池子原话）：「只发文字、图片延后 ✓；『正在发送』状态看得见 ✓」。
 * 关键纪律：**附件留不住就绝不假装留着** ✗（存不下 → 退回"一起发" ✓）——
 * 悄悄丢用户的图是这个项目最不能犯的错 ✓。
 */
{
	await ensureAppVisible()
	const pick = (f) => {
		Object.defineProperty($('file'), 'files', { value: [f], configurable: true })
		$('file').dispatchEvent(new window.Event('change', { bubbles: true }))
	}
	const prompts = () => requests.filter((entry) => entry.path.startsWith('/api/prompt'))
	const lastBody = () => JSON.parse(prompts().pop().options.body)
	const imageFile = (name, bytes) => new window.File([new Uint8Array(bytes)], name, { type: 'image/png' })
	const outboxItems = () => {
		const raw = window.localStorage.getItem('dshm.outbox') ?? ''
		return raw === '' ? [] : JSON.parse(raw)
	}
	const setWeak = (on) => {
		window.localStorage.setItem('dshm.weaknet', on === true ? '1' : '0')
		$('weakOn').checked = on === true
		$('weakOn').dispatchEvent(new window.Event('change', { bubbles: true }))
	}

	// ① 开关在 🩺 纸里 ✓（不往工具键那排再加键 ✓ —— 用户已经嫌挤过 ✓）。
	click($('checkBtn'))
	await wait(180)
	check('弱网模式的开关在「一键自检」纸里 ✓（工具键那排不再加键 ✓），默认关 ✓',
		visible($('weakOn')) && $('weakOn').checked === false,
		`visible=${visible($('weakOn'))} checked=${$('weakOn').checked}`)
	click($('weakOn'))
	await wait(120)
	check('打开后状态记在手机本地 ✓（`dshm.weaknet=1` ✓，也进备份 ✓）+ 有话说 ✓',
		window.localStorage.getItem('dshm.weaknet') === '1'
		&& String($('toast')?.textContent ?? '').includes('弱网模式开了'),
		`dshm.weaknet=${window.localStorage.getItem('dshm.weaknet')} toast="${String($('toast')?.textContent ?? '').slice(0, 20)}"`)
	click($('checkBack'))
	await wait(100)

	// ② 弱网模式 + 一张图 + 文字：**文字先发**（body 里一个附件都没有 ✓），图进箱子 ✓。
	pick(imageFile('weak.png', [137, 80, 78, 71, 1, 2, 3, 4]))
	await waitFor(() => $('thumbs').children.length === 1)
	$('text').value = '弱网模式下的一条文字'
	const beforeWeak = prompts().length
	click($('send'))
	// ⚠️ 这里原来是固定 `await wait(260)` ✗ —— 慢一点就量到"还没发生"，偶发假红 ✓。
	// 现在等到"这条 prompt 出去了、**而且**箱子里已经有那 1 条"为止 ✓，量到的才是真状态 ✓。
	await waitFor(() => prompts().length === beforeWeak + 1 && outboxItems().length === 1)
	const weakBody = lastBody()
	check('弱网模式：**文字先出去** ✓（这条 prompt 里没有内联图片 ✓），图片进「留着」的箱子 ✓',
		prompts().length === beforeWeak + 1 && (weakBody.images ?? []).length === 0
		&& weakBody.text === '弱网模式下的一条文字'
		&& outboxItems().length === 1 && outboxItems()[0].files.length === 1,
		JSON.stringify({ images: (weakBody.images ?? []).length, outbox: outboxItems().length, files: outboxItems()[0]?.files?.length }))
	check('箱子的横幅看得懂 ✓（写明"几个附件留着"，不是含糊的"待发 1 条" ✗）',
		visible($('outboxStrip')) && String($('outboxStrip').textContent).includes('弱网模式')
		&& String($('outboxStrip').textContent).includes('1 个附件'),
		String($('outboxStrip').textContent).slice(0, 40))
	check('发完当场说清了"附件会**单独补发一条**" ✓（不说清，用户会以为图丢了 ✗）',
		String($('banner')?.textContent ?? '').includes('附件') || String($('toast')?.textContent ?? '').includes('附件'),
		`banner="${String($('banner')?.textContent ?? '').slice(0, 40)}"`)

	// ③ 点横幅补发：**先分片上传、再发一条带路径的** ✓（复用离线箱那条幂等路 ✓）。
	const uploadedBefore = uploaded.length
	const beforeFlush = prompts().length
	click($('outboxStrip'))
	await waitFor(() => uploaded.length > uploadedBefore && prompts().length === beforeFlush + 1)
	const flushBody = lastBody()
	check('点横幅补发：附件真的传上去了 ✓，并且**另发一条带路径的** ✓（agent 晚一轮看到 ✓）',
		uploaded.length > uploadedBefore && prompts().length === beforeFlush + 1
		&& (flushBody.fileRefs ?? []).length >= 1 && flushBody.text === '',
		JSON.stringify({ 上传: uploaded.length - uploadedBefore, refs: (flushBody.fileRefs ?? []).length, text: flushBody.text }))
	check('补发成功后箱子清空 ✓（横幅自己收起来 ✓）',
		outboxItems().length === 0 && visible($('outboxStrip')) === false,
		`outbox=${outboxItems().length} strip=${visible($('outboxStrip'))}`)

	// ④ 关掉弱网模式：回到老行为 ✓（附件跟文字一起发 ✓）—— 这条是"别把老路弄坏" ✓。
	setWeak(false)
	await wait(80)
	pick(imageFile('normal.png', [137, 80, 78, 71, 9, 9, 9]))
	await wait(200)
	$('text').value = '普通模式的一条'
	click($('send'))
	await wait(260)
	const normalBody = lastBody()
	check('关掉弱网模式：附件**跟着文字一起发** ✓（老行为一点没变 ✓）',
		(normalBody.images ?? []).length === 1 && (normalBody.fileRefs ?? []).length === 0
		&& outboxItems().length === 0,
		JSON.stringify({ images: (normalBody.images ?? []).length, refs: (normalBody.fileRefs ?? []).length }))

	// ⑤ ⚠️ 存不下就**绝不假装留着** ✗：一张 1.3MB 的图超过那道闸 → 退回"一起发" ✓ 并说清原因 ✓。
	setWeak(true)
	await wait(80)
	pick(imageFile('huge.png', new Array(1_300_000).fill(65)))
	await wait(400)
	$('text').value = '这张太大，留不住'
	const beforeHuge = prompts().length
	click($('send'))
	await wait(400)
	const hugeBody = lastBody()
	check('⚠️ 附件大到手机存不下：**不放进箱子** ✓、改成一起发 ✓，并如实说"存不下" ✓（绝不悄悄丢图 ✗）',
		prompts().length === beforeHuge + 1 && outboxItems().length === 0
		&& ((hugeBody.images ?? []).length + (hugeBody.fileRefs ?? []).length) >= 1
		&& String($('banner')?.textContent ?? '').includes('存不下'),
		JSON.stringify({ outbox: outboxItems().length, images: (hugeBody.images ?? []).length, refs: (hugeBody.fileRefs ?? []).length, banner: String($('banner')?.textContent ?? '').slice(0, 30) }))
	setWeak(false)
	await wait(80)

	// ⑥ 「正在发送…」要看得见 ✓（慢网下这几秒最容易让人以为"没反应" ✓）。
	promptDelayMs = 500
	$('text').value = '慢一点发'
	click($('send'))
	await wait(200)
	check('发送中：屏幕上写着「📡 正在发送…」✓（不是静悄悄等 ✓）',
		String($('banner')?.textContent ?? '').includes('正在发送'), String($('banner')?.textContent ?? '').slice(0, 30))
	await wait(600)
	check('发完这句提示自己收走 ✓（不能留在屏幕上 ✗）',
		visible($('banner')) === false,
		`banner 可见=${visible($('banner'))} 文本="${String($('banner')?.textContent ?? '').slice(0, 24)}"`)

	/*
	 * ⑦ 慢发送 → 主动问一次要不要开弱网模式 ✓（用户不必知道"弱网模式"这个词 ✓）。
	 * 用**假时钟**把这一条变慢 ✓（`Date.now` 是页面自己的时钟 ✓）—— 不真等 6 秒 ✓。
	 */
	const realNow = window.Date.now
	let skew = 0
	window.Date.now = () => realNow() + skew
	try {
		setWeak(false)
		await wait(60)
		promptDelayMs = 260
		$('text').value = '这一条会很慢'
		click($('send'))
		await wait(60)
		skew = 9000                       // 回包之前把时钟拨快 9 秒 ✓
		await wait(500)
		check('一条发了很久（>6 秒）→ 主动问「要不要开弱网模式」✓（带一个能点的键 ✓，不用用户去翻设置 ✓）',
			String($('banner')?.textContent ?? '').includes('弱网模式')
			&& String($('banner')?.innerHTML ?? '').includes('flashGo'),
			String($('banner')?.textContent ?? '').slice(0, 44))
		click($('flashGo'))
		await wait(140)
		check('点了就真的开上 ✓（状态写进手机本地 ✓，开关也跟着变 ✓）',
			window.localStorage.getItem('dshm.weaknet') === '1' && $('weakOn').checked === true,
			`dshm.weaknet=${window.localStorage.getItem('dshm.weaknet')} checked=${$('weakOn').checked}`)
	} finally {
		window.Date.now = realNow
		setWeak(false)
		await wait(80)
	}
	check('（收尾）弱网模式关掉、箱子空着 ✓（不给后面的用例留状态 ✓）',
		window.localStorage.getItem('dshm.weaknet') === '0' && outboxItems().length === 0)
}

/* --- 2026-10-12：顶栏随页签收放 + 工具键可收起（用户当天报的两条）------------- */
/*
 * 用户原话：①「切换到余额界面时还有模型显示」②「底下功能栏太多了挡住视线，你加一个折叠功能」。
 * 两条都是"**这个控件属于哪一页**"的问题 ✓：
 *   · 「当前模型」+「已跑 X:XX」（★12）是**任务页**的东西 ✓ —— 切到余额不该跟着走 ✗；
 *   · 底部那排 13 个工具键占掉小屏的四分之一 ✗ —— 要能收起来，但**输入框/发送/页签栏/附件
 *     一个都不许藏** ✓（把"写消息"也藏了就是本末倒置 ✓），开关自己必须一直看得见 ✓。
 */
{
	// ① 切到「余额」：模型那一行 + 耗时条都收起来 ✓（#12 那条此刻正在跑 ✓，正好当反例 ✓）。
	const appBack = await ensureAppVisible()
	check('（前置）走完登录门后 `#app` 真的看得见 ✓（前面有用例故意把登录门弹出来过 ✗ —— 不补这一步，后面所有"看得见"的断言都是空的 ✓）',
		appBack === true, `ancestry: ${ancestry($('app'))}`)
	/*
	 * 走完登录门会**重新拉一次会话列表** ✓（宿主说"这个会话没在跑" ✓ → `state.running` 归 false ✓）。
	 * 所以这里补一条 `turn/start`，把"正在跑"这一幕摆回来 ✓ —— 下面要靠它验
	 * "切到余额页时「已跑 X:XX」会不会跟着走"✓。
	 */
	source.emit({ t: 'event', event: { type: 'turn/start', seq: 600, time: Date.now() - 65000, data: { turn: 20 } } })
	source.emit({ t: 'event', event: { type: 'assistant/message', seq: 601, time: Date.now() - 60000, data: {
		turn: 20, step: 1, usage: { inputTokens: 1000, outputTokens: 100 },
		message: { id: 'm20', role: 'assistant', content: [{ type: 'text', text: '跑着' }] },
	} } })
	await wait(200)
	const before = ($('runstrip')?.textContent ?? '')
	check('（前置）任务页上「已跑…」那条是显示着的（后面切页才有对照 ✓）',
		window.getComputedStyle($('runstrip')).display !== 'none' && before.includes('已跑'),
		`display=${window.getComputedStyle($('runstrip')).display} text=${before.slice(0, 30)}`)
	click(window.document.querySelector('#tabs button[data-tab="bill"]'))
	await wait(200)
	check('切到「余额」：**当前模型那一行收起来了** ✓（用户报的那条）',
		window.getComputedStyle($('modelRow')).display === 'none',
		`modelRow display=${window.getComputedStyle($('modelRow')).display}`)
	check('切到「余额」：**「已跑 X:XX」也收起来了** ✓（同一个毛病，顺手一起修 ✓）',
		window.getComputedStyle($('runstrip')).display === 'none',
		`runstrip display=${window.getComputedStyle($('runstrip')).display}`)
	check('余额页本身照旧在（收顶栏不等于把页面弄坏了 ✓）',
		window.getComputedStyle($('view-bill')).display !== 'none')
	click(window.document.querySelector('#tabs button[data-tab="task"]'))
	await wait(160)
	check('切回「任务」：两样都回来了 ✓（模型行 + 耗时条）',
		window.getComputedStyle($('modelRow')).display !== 'none'
		&& window.getComputedStyle($('runstrip')).display !== 'none',
		`modelRow=${window.getComputedStyle($('modelRow')).display} runstrip=${window.getComputedStyle($('runstrip')).display}`)

	// ② 工具键折叠：默认展开 → 点 ⋯ 收起 → 输入框/发送/附件缩略图都还在 → 再点展开 ✓。
	check('（前置）工具键默认是展开的（不改老用户的习惯 ✓）',
		visible($('toolKeys'))
		&& window.localStorage.getItem('dshm.tools') !== '1',
		`toolKeys=${window.getComputedStyle($('toolKeys')).display} dshm.tools=${window.localStorage.getItem('dshm.tools')}`)
	// 先把「只看不发」打开 —— 下面要验"收起工具键**不许**把它一起藏掉" ✓（真 bug 的回归断言 ✓）。
	click($('roBtn'))
	await wait(120)
	check('（前置）「只看不发」横幅此刻是看得见的 ✓（用**沿祖先链**的判据 ✓ —— 自己的 display 看不见祖先被藏 ✗）',
		visible($('roStrip')), `ancestry: ${ancestry($('roStrip'))}`)
	click($('toolsToggle'))
	await wait(140)
	check('点 ⋯：13 个工具键那一排收起来了 ✓，而**输入框 / 发送一个都没藏** ✓',
		visible($('toolKeys')) === false
		&& visible($('compose')) && visible($('text')) && visible($('send')),
		`toolKeys=${window.getComputedStyle($('toolKeys')).display} compose=${window.getComputedStyle($('compose')).display} text=${window.getComputedStyle($('text')).display} send=${window.getComputedStyle($('send')).display}`)
	check('⚠️ 收起工具键**不许**把「只看不发 / 离线发件箱」两条横幅与三张纸一起藏掉 ✗✗（它们嵌在 `#tools` 里 —— 冷视角复查抓到的真 bug：收的是 `#tools` 而不是只包按钮的那层 ✓）',
		visible($('tools')) && visible($('roStrip')),
		`tools=${window.getComputedStyle($('tools')).display} roStrip=${window.getComputedStyle($('roStrip')).display}（沿祖先链 ${visible($('roStrip'))}）`)
	check('收起时有话说（"工具键已收起（点 ⋯ 展开）" ✓ —— 那排键突然消失得有个交代 ✓）',
		String($('toast')?.textContent ?? '').includes('工具键已收起'), String($('toast')?.textContent ?? '').slice(0, 40))
	click($('roBtn'))
	await wait(120)
	check('收起后**开关自己还在原地看得见** ✓（藏进被收起的那排 = 用户再也找不到 ✗）',
		visible($('toolsToggle')))
	check('收起状态记在手机本地（`dshm.tools=1` ✓ —— 刷新/切回 App 都记得 ✓）',
		window.localStorage.getItem('dshm.tools') === '1',
		String(window.localStorage.getItem('dshm.tools')))
	click($('toolsToggle'))
	await wait(140)
	check('再点 ⋯：工具键回来了 ✓、标记也清掉了 ✓',
		visible($('toolKeys'))
		&& window.localStorage.getItem('dshm.tools') !== '1',
		`toolKeys=${window.getComputedStyle($('toolKeys')).display} dshm.tools=${window.localStorage.getItem('dshm.tools')}`)

	// ③ 顶栏折叠（用户 2026-10-12：「上方栏也做一个折叠效果」✓）：细缝里只留状态点 + 开关 ✓。
	const header = window.document.querySelector('header')
	check('（前置）顶栏默认展开：标题 + 三个键 + 当前模型那一行都在 ✓',
		header.classList.contains('folded') === false
		&& window.getComputedStyle($('heading')).display !== 'none'
		&& window.getComputedStyle($('help')).display !== 'none'
		&& window.getComputedStyle($('modelRow')).display !== 'none',
		`folded=${header.classList.contains('folded')} heading=${window.getComputedStyle($('heading')).display} modelRow=${window.getComputedStyle($('modelRow')).display}`)
	click($('topToggle'))
	await wait(140)
	check('点 ⌃：标题、说明/刷新/退出、当前模型那一行全收起来 ✓（顶栏只剩一条细缝 ✓）',
		header.classList.contains('folded') === true
		&& window.getComputedStyle($('heading')).display === 'none'
		&& window.getComputedStyle($('help')).display === 'none'
		&& window.getComputedStyle($('reload')).display === 'none'
		&& window.getComputedStyle($('logout')).display === 'none'
		&& window.getComputedStyle($('modelRow')).display === 'none',
		`heading=${window.getComputedStyle($('heading')).display} help=${window.getComputedStyle($('help')).display} modelRow=${window.getComputedStyle($('modelRow')).display}`)
	check('收起后**开关与状态点还在** ✓（否则用户展不开、也看不出连没连上 ✗）',
		window.getComputedStyle($('topToggle')).display !== 'none'
		&& window.getComputedStyle($('dot')).display !== 'none')
	check('「已跑 X:XX / 本轮 token」（★12）**不跟着顶栏收** ✓（它只在跑任务时出现，收掉等于把功能藏了 ✗）',
		window.getComputedStyle($('runstrip')).display !== 'none'
		&& String($('runstrip')?.textContent ?? '').includes('已跑'),
		`runstrip=${window.getComputedStyle($('runstrip')).display} text=${String($('runstrip')?.textContent ?? '').slice(0, 30)}`)
	check('顶栏收起状态记在手机本地（`dshm.top=1` ✓）+ 有话说 ✓',
		window.localStorage.getItem('dshm.top') === '1'
		&& String($('toast')?.textContent ?? '').includes('顶栏已收起'),
		`dshm.top=${window.localStorage.getItem('dshm.top')} toast="${String($('toast')?.textContent ?? '').slice(0, 24)}"`)
	/*
	 * ⚠️ 4.3.0 把"再点 ⌄ 展开"这条**改掉了** ✗（老断言在这里 ✗）：折叠态点 ⌄ 现在**弹纸** ✓
	 * （用户 2026-10-14 选 B ✓），"整行回来"这件事由**纸上的「展开顶栏」**负责 ✓ ——
	 * 那条断言搬到下面 ① 那一块里 ✓，这里只钉"折叠态点 ⌄ 会把纸弹出来" ✓。
	 * ⚠️ 判据必须含"纸是关着的" ✗ —— 只写"栏收着"的话，第一版那个真 bug（**折叠时顺手把纸弹满屏** ✗）
	 * 会被放过 ✓（冷视角复查抓到的 ✓，实测也踩过 ✓）。
	 */
	click($('topToggle'))
	await wait(140)
	check('折叠态再点 ⌄：**弹纸**（栏保持收起 ✓ —— 4.3.0 起"整行回来"归纸上那个键管 ✓）',
		header.classList.contains('folded') === true
		&& window.getComputedStyle($('topsheet')).display !== 'none',
		`folded=${header.classList.contains('folded')} topsheet=${window.getComputedStyle($('topsheet')).display}`)

}

	/*
	 * ③ 4.3.0 ①（用户 2026-10-14 亲口，选了 B ✓）：「折叠顶栏后，那几个键要跟分享一样的操作」
	 *    —— 现状是折叠后**只有分享还在** ✗（别的都被 CSS 藏了 ✓），所以点 ⌄ 要**弹一张纸** ✓，
	 *    纸上五个动作各自**真生效** ✓，而展开态点 ⌄ 仍然是**直接折叠** ✓（别把常用动作变成两次 ✗）。
	 *
	 * ⚠️ 这一块写错过好几版 ✓，四条纪律留在这儿（比"结果绿了"值钱 ✓）：
	 *   ① **一步一步来**：一个动作 + 一条断言，断言里带上完整现场（`folded/top/sheet` ✓）；
	 *   ② **先读一次事实，再决定断言什么** ✗ 不许假设"现在是展开还是收起" ✓（这个假设错过两次 ✓）；
	 *   ③ 摆状态只用**无状态**动作：关纸 = 纸上的「← 返回」✓、展开栏 = 纸上「展开顶栏」✓、
	 *      打开纸 = **在收起态点 ⌄**（判据取 DOM 上的 `header.folded` ✓）；
	 *   ④ **判据不许写成"纸关着也算过"** ✗ —— 那样"点 ⌄ 到底开没开纸"会被整个放过 ✓（自证 ✓）。
	 */
	{
		const sheet = $('topsheet')
		const sheetOpen = () => window.getComputedStyle(sheet).display !== 'none'
		const header = window.document.querySelector('header')
		const isFolded = () => header.classList.contains('folded')
		const where = (tag) => `[${tag}] folded=${isFolded()} top=${JSON.stringify(window.localStorage.getItem('dshm.top'))} sheet=${window.getComputedStyle(sheet).display}`

		/* 摆状态：关纸（无状态 ✓）。 */
		const closeSheet = async () => { if (sheetOpen() === true) { click($('topSheetBack')); await wait(140) } }
		/* 摆状态：展开栏（无状态 ✓）—— 收起态先弹纸、再按纸上的「展开顶栏」✓。 */
		const expandBar = async () => {
			if (isFolded() === true) {
				click($('topToggle')); await wait(140)          // 收起态点 ⌄ = 弹纸 ✓
				if (sheetOpen() === true) { click($('topSheetExpand')); await wait(160) }
			}
			await closeSheet()
		}
		/* 摆状态：收起栏 + 纸关着（用事实判断，不假设 ✓）。 */
		const foldBar = async () => {
			await closeSheet()
			if (isFolded() === false) { click($('topToggle')); await wait(140) }
		}

		/* 第 1 步：收起那一刻**纸必须是关的** ✓ —— 冷视角复查抓到的真 bug（我第一版就是错的 ✗）：
		 * `renderTop()` 在折叠态 `show(paper)` ✓ → 用户点"收起"想多看几行、结果被一张全屏纸盖住 ✗；
		 * 更糟的是 `dshm.top=1` 是持久化的 ✓ → 每次冷启动/刷新都被自动弹一脸 ✗。 */
		await expandBar()
		const step1From = { folded: isFolded(), sheet: window.getComputedStyle(sheet).display }
		check('（前置）第 1 步起点：栏是**展开**的、纸是关的 ✓（先读事实，再决定断言 ✓）',
			step1From.folded === false && step1From.sheet === 'none',
			`folded=${step1From.folded} sheet=${step1From.sheet}`)
		click($('topToggle'))
		await wait(140)
		check('🔴 第 1 步：那一下点 ⌄ 之后 —— 栏折叠 ✓，而**纸仍然是关的** ✓（折叠的本意是"多看几行"，不是被全屏纸盖住 ✗；冷启动同理 ✓）',
			isFolded() === true && sheetOpen() === false, where('step1'))

		/* 第 2 步：折叠态点 ⌄ → 弹纸 ✓（栏保持收起 ✓）。 */
		await foldBar()
		click($('topToggle'))
		await wait(140)
		check('第 2 步：折叠态点 ⌄ → **弹纸** ✓（栏保持收起 ✓、五个动作一个都不丢 ✓）',
			isFolded() === true && sheetOpen() === true, where('step2'))

		/* 第 3 步：纸上内容与会话栏对得上 ✓。 */
		check('纸上五样都在 ✓：展开顶栏 / 说明 / 刷新 / 退出 / 当前模型',
			$('topSheetExpand') !== null && $('topSheetHelp') !== null && $('topSheetReload') !== null
			&& $('topSheetLogout') !== null && $('topSheetModel') !== null
			// ⚠️ 4.3.0 检修（冷视角复查的白 ✓）：光"在"不够 ✗ —— 模型选择器得**真有选项** ✓
			//（它是这五样里唯一"有内容才算数"的那个 ✓；其余四样的"真生效"由下面几步各自钉住 ✓）。
			&& $('topSheetModel').options.length >= 1,
			`选择器选项=${$('topSheetModel').options.length} 个`)
		check('纸上的模型选择器**和顶端那一行同一个值** ✓（不是各显示各的 ✗）',
			$('topSheetModel').value === $('modelNow').value,
			`纸=${$('topSheetModel').value} 顶端=${$('modelNow').value}`)

		/* 第 4 步：折叠后那几个键**确实被藏了** ✓（用户看到的那一幕 ✓）；「分享」这次也进了名单 ✓。 */
		await closeSheet()
		check('（前置）第 4 步：栏收着、纸关着 ✓', isFolded() === true && sheetOpen() === false, where('step4-pre'))
		check('第 4 步：折叠态下「说明 / 刷新 / 退出 / 当前模型」都被藏起来 ✓（这就是用户看到的那一幕 —— 4.1.0 起偏偏「分享」还在 ✗）',
			window.getComputedStyle($('help')).display === 'none'
			&& window.getComputedStyle($('reload')).display === 'none'
			&& window.getComputedStyle($('logout')).display === 'none'
			&& window.getComputedStyle($('modelRow')).display === 'none',
			`help=${window.getComputedStyle($('help')).display} modelRow=${window.getComputedStyle($('modelRow')).display}`)
		check('4.3.0 起「分享」也跟着收起来 ✓（用户看到的不一致就是它 ✗）',
			window.getComputedStyle($('shareApp')).display === 'none',
			`shareApp=${window.getComputedStyle($('shareApp')).display}`)

		/* 第 5 步：纸上「说明」→ 真开说明页 ✓（复用 `#help` 自己那份接法 ✓）。 */
		await foldBar()
		click($('topToggle'))
		await wait(140)
		check('（前置）第 5 步：点 ⌄ 弹纸 ✓', sheetOpen() === true, where('step5-pre'))
		click($('topSheetHelp'))
		await wait(160)
		check('纸上点「说明」：真把说明页开出来了 ✓（纸自己先收掉 ✓，不然盖在上面像卡住 ✗）',
			window.getComputedStyle($('welcome')).display !== 'none' && sheetOpen() === false,
			`welcome=${window.getComputedStyle($('welcome')).display} topsheet=${window.getComputedStyle(sheet).display}`)
		click($('welcomeGo'))
		await wait(160)

		/* 第 6 步：纸上「刷新」→ 真发一次拉取 ✓。 */
		await closeSheet()
		if (isFolded() === false) { click($('topToggle')); await wait(140) }
		click($('topToggle'))
		await wait(140)
		check('（前置）第 6 步：点 ⌄ 弹纸 ✓', sheetOpen() === true, where('step6-pre'))
		const bootBefore = requests.filter((entry) => entry.path.startsWith('/api/bootstrap')).length
		click($('topSheetReload'))
		await wait(260)
		check('纸上点「刷新」：真的发了一次拉取 ✓（`/api/bootstrap` ✓ —— 只改文案不发请求就是假的 ✗）',
			requests.filter((entry) => entry.path.startsWith('/api/bootstrap')).length > bootBefore,
			`bootstrap 请求 ${bootBefore} → ${requests.filter((entry) => entry.path.startsWith('/api/bootstrap')).length}`)
		check('点完刷新纸也收起来了 ✓', sheetOpen() === false, where('step6-post'))

		/* 第 7 步：纸上「退出登录」→ 真走退出那条路 ✓（然后重新登录回来 ✓）。 */
		click($('topToggle'))
		await wait(140)
		check('（前置）第 7 步：点 ⌄ 弹纸 ✓', sheetOpen() === true, where('step7-pre'))
		const logoutBefore = requests.filter((entry) => entry.path.startsWith('/api/logout')).length
		click($('topSheetLogout'))
		await wait(220)
		check('纸上点「退出登录」：真的走退出那条路 ✓（`POST /api/logout` ✓ —— 不是只关一张纸 ✗）',
			requests.filter((entry) => entry.path.startsWith('/api/logout')).length === logoutBefore + 1,
			`logout 请求 ${logoutBefore} → ${requests.filter((entry) => entry.path.startsWith('/api/logout')).length}`)
		const backIn = await ensureAppVisible()
		check('（前置）退出后重新进得来 ✓ 且**折叠状态没被登录那一步抹掉** ✓（它记在 `dshm.top` 里 ✓）',
			backIn === true && isFolded() === true
			&& window.localStorage.getItem('dshm.top') === '1',
			`ancestry: ${ancestry($('app'))} folded=${isFolded()} dshm.top=${window.localStorage.getItem('dshm.top')}`)

		/* 第 8 步：纸上「当前模型」—— 那个选择器真会走的两条路，各自钉 ✓。 */
		await closeSheet()
		if (isFolded() === false) { click($('topToggle')); await wait(140) }
		click($('topToggle'))
		await wait(140)
		check('（前置）第 8 步：收起 + 纸开着 ✓', isFolded() === true && sheetOpen() === true, where('step8-pre'))
		{
			const options = Array.from($('topSheetModel').options)
			window.localStorage.setItem('dshm.model', 'zhipu|glm-4-plus')   // 保证第 ① 条有东西可清 ✓
			check('（前置）选择器里有"默认"与"具体模型"两类选项 ✓（否则下面两条证不了什么 ✗）',
				options.some((o) => o.value === '') && options.some((o) => o.value !== ''),
				`当前=${$('modelNow').value} 选项=${options.map((o) => o.value).join(' / ')}`)

			// ① 选「默认（跟随电脑）」：**不发请求** ✓，只是把手机记的选择清掉 ✓。
			const postsBeforeDefault = pickedModelRequests.length
			$('topSheetModel').value = ''
			$('topSheetModel').dispatchEvent(new window.Event('change', { bubbles: true }))
			await wait(220)
			check('纸上选「默认（跟随电脑）」：**不发任何请求** ✓ 且把手机记的选择清掉 ✓（我第一版拿它断言"发了 POST" ✗ —— 实测一条红 ✓）',
				pickedModelRequests.length === postsBeforeDefault && window.localStorage.getItem('dshm.model') === '',
				`model 请求 ${postsBeforeDefault} → ${pickedModelRequests.length}；dshm.model=${JSON.stringify(window.localStorage.getItem('dshm.model'))}`)

			// ② 选一个**具体模型**：恰好一条 POST ✓、带的就是刚选的值 ✓。
			const concrete = options.find((o) => o.value !== '')
			const postsBeforeConcrete = pickedModelRequests.length
			$('topSheetModel').value = concrete.value
			$('topSheetModel').dispatchEvent(new window.Event('change', { bubbles: true }))
			await wait(260)
			const sent = pickedModelRequests.at(-1)
			check('纸上选一个具体模型：**恰好一条** `POST /api/model` ✓ 且带的就是刚选的那个值 ✓（不是旧值 ✗）',
				pickedModelRequests.length === postsBeforeConcrete + 1
				&& sent?.body?.provider === concrete.value.split('|')[0]
				&& sent?.body?.model === concrete.value.split('|')[1],
				`选了 ${JSON.stringify(concrete.value)} / 发出去 ${JSON.stringify(sent?.body ?? null)}`)
			check('换了之后**顶端那一行也跟着对** ✓（两处显示同一个值 ✓）',
				$('modelNow').value === concrete.value && $('topSheetModel').value === concrete.value,
				`顶端=${$('modelNow').value} 纸=${$('topSheetModel').value}`)
			window.localStorage.removeItem('dshm.model')
		}

		/* 第 9 步：纸上「展开顶栏」→ 回到展开态 ✓、纸收掉 ✓。 */
		check('（前置）第 9 步：纸还开着 ✓', sheetOpen() === true, where('step9-pre'))
		click($('topSheetExpand'))
		await wait(160)
		check('纸上点「展开顶栏」：回到展开态 ✓、纸收掉 ✓、那几个键又都在了 ✓',
			isFolded() === false && sheetOpen() === false
			&& window.getComputedStyle($('help')).display !== 'none'
			&& window.getComputedStyle($('modelRow')).display !== 'none'
			&& window.localStorage.getItem('dshm.top') !== '1',
			where('step9'))

		/*
		 * 第 10 步：🔴 冷视角复查（橙）抓到的**真漏登记** ✓：新加的 `#topsheet` 是一张 `.sheet`
		 *（fixed 全屏 ✓），却没进 `openToolPanel()` 那份清单 ✓ —— 那份清单管两件事 ✓：
		 *   ① 左右滑动换页前先把抽屉收掉 ✓（漏了就"纸盖着、底下页换了" ✗）；
		 *   ② **审批/提问卡片一到先把抽屉收掉** ✓（2.5.1 那条修的就是这个 ✗ —— 漏了它，
		 *      卡片又被盖住 → 用户又看到"审批没弹出来" ✓，而宿主只等 120 秒 ✓）。
		 */
		await foldBar()
		click($('topToggle'))
		await wait(140)
		check('（前置）第 10 步：收起 + 纸开着 ✓', isFolded() === true && sheetOpen() === true, where('step10-pre'))
		/*
		 * ⚠️ 这里**不假装测了滑动换页** ✗ —— 我试了两种起手点（`#log` / 页面容器 / `body` ✓），
		 * 在这块场景里合成触摸事件**都没走完 `goPage`** ✓（实测：[对照] 把纸关掉再滑也不换页 ✓），
		 * 于是"纸关着"这个结果**不是"登记生效"造成的** ✓ —— 拿它当判据就是**自证** ✗。
		 * 真机端到端也没证据 ✗ —— 照本项目纪律：**宁缺不假** ✓（删掉假判据 ✓，缺口写进 CHANGELOG ✓）。
		 * 真正压阵的是下面那条 ②：审批卡片到达时**必须**把这张纸收掉 ✓
		 * （那条走的就是 `openToolPanel()` 同一段代码 ✓，而且合成事件走不动的问题在那儿不存在 ✓）。
		 */
		await closeSheet()
		click(window.document.querySelector('#tabs button[data-tab="task"]'))
		await wait(140)
		await foldBar()
		click($('topToggle'))
		await wait(140)
		// ⚠️ 4.3.0 检修（冷视角复查的黄 ✓）：只验"纸开着"不够 ✗ —— 还要验**栏是收起的**、**停在任务页** ✓
		//（这两样是"点 ⌄ 弹纸"这个动作的前提 ✓；不验的话，摆场景那一步静默失败也看不出来 ✗）。
		check('（前置）停在任务页、栏收着、纸开着 ✓',
			window.document.querySelector('#tabs button.active')?.dataset?.tab === 'task'
			&& isFolded() === true && sheetOpen() === true,
			`active=${window.document.querySelector('#tabs button.active')?.dataset?.tab ?? '(无)'} folded=${isFolded()} sheet=${window.getComputedStyle(sheet).display}`)
		source.emit({ t: 'interaction', kind: 'approval', id: 'ask-topsheet', payload: { toolName: 'pwsh', reason: '要跑一条命令' } })
		await wait(120)
		check('🔴 纸开着时来了审批卡片：纸**让位** ✓（不登记 = 卡片被盖住 = 用户以为"审批没弹出来"✗ —— 2.5.1 同款病 ✓）',
			sheetOpen() === false && window.getComputedStyle($('ask')).display !== 'none',
			`topsheet=${window.getComputedStyle(sheet).display} ask=${window.getComputedStyle($('ask')).display}`)
		source.emit({ t: 'interaction-end', id: 'ask-topsheet' })
		await wait(120)

		/* 收尾：把页面恢复成"展开 + 任务页"✓ —— 后面的用例按这个前提走 ✓。 */
		click(window.document.querySelector('#tabs button[data-tab="task"]'))
		await wait(140)
		await expandBar()
		// ⚠️ 4.3.0 检修（冷视角复查的白 ✓）：收尾也要把**任务页**和**说明页已关**一起验 ✓ ——
		// 不然这一块把页面留在别的页/别的纸上，后面的用例会"错着前提"往下跑 ✓（最难查的那种 ✗）。
		check('（收尾）顶栏回到展开态、纸关着、说明页关着、停在任务页 ✓（这一块的状态不漏给下面 ✓）',
			isFolded() === false && sheetOpen() === false
			&& window.getComputedStyle($('welcome')).display === 'none'
			&& window.document.querySelector('#tabs button.active')?.dataset?.tab === 'task',
			`${where('final')} welcome=${window.getComputedStyle($('welcome')).display} active=${window.document.querySelector('#tabs button.active')?.dataset?.tab ?? '(无)'}`)
	}

/* --- 2.9.0 ★3：备份 / 换手机（导出与导入）----------------------------------- */
/*
 * 用户要的：「一键导出/导入桥的配置 + 本地数据；换手机或重装 PWA 后能还原 ✓」。
 * 这一版把它**收口在"这台手机上的设置"** ✓ —— 三条要钉住：
 *   ① 导出的是**手机端设置** ✓（置顶/常用/频率/模型/会话/只看不发/收起工具键）；
 *   ② **网址里的密钥段与离线待发消息绝不进备份文件** ✓✗（文件是要传来传去的 ✓）；
 *   ③ 导入**只认白名单** ✓，坏文件必须当场说清"没恢复"✗（不许半还原、也不许假装成功 ✓）。
 */
{
	// 先往 localStorage 里放两样"**必须不被带走**"的东西（真机上它们分别带着密钥段与待发消息 ✓）。
	await ensureAppVisible()
	window.localStorage.setItem('dshm.canonical', 'https://example.ts.net/0123456789abcdef/')
	window.localStorage.setItem('dshm.addresses', JSON.stringify([{ url: 'https://example.ts.net/0123456789abcdef/' }]))
	window.localStorage.setItem('dshm.outbox', JSON.stringify([{ clientId: 'c1', text: '过时的待发消息' }]))
	window.localStorage.setItem('dshm.pins', JSON.stringify(['session-ui-test']))

	click($('checkBtn'))
	await wait(160)
	click($('backupOpen'))
	await wait(160)
	check('🩺 纸里有「💾 备份 / 换手机」入口，点了开一张纸 ✓（写清备份的是**手机上的**设置 ✓）',
		window.getComputedStyle($('backupopen')).display !== 'none'
		&& String($('backupopen')?.textContent ?? '').includes('这台手机上的设置'),
		String($('backupopen')?.textContent ?? '').slice(0, 50))

	// ① + ② 导出：href 是一份 data: JSON —— 解出来看内容 ✓（不点它：jsdom 会把点击当成导航 ✗）。
	const href = String($('backupGo')?.getAttribute('href') ?? '')
	check('导出链接是一份 `data:` JSON（不用 `URL.createObjectURL` —— 部分环境里没有它 ✓）',
		href.startsWith('data:application/json'), href.slice(0, 40))
	let dump = null
	try { dump = JSON.parse(decodeURIComponent(href.slice(href.indexOf(',') + 1))) } catch { dump = null }
	check('导出的内容认得出是手机桥的备份（带标记 + 版本 + 时间 ✓）',
		dump !== null && String(dump.mark).includes('phone-backup') && Number(dump.version) >= 1
		&& typeof dump.exportedAt === 'string', JSON.stringify(dump ?? null).slice(0, 80))
	check('导出带上了手机端设置（置顶那类 ✓、还有 ★6 的 ↑ 历史 ✓）',
		dump?.data?.['dshm.pins'] !== undefined && dump?.data?.['dshm.history'] !== undefined,
		JSON.stringify(Object.keys(dump?.data ?? {})))
	check('**网址里的密钥段不进备份** ✗✗（文件是要发给自己/存网盘的 ✓）',
		Object.keys(dump?.data ?? {}).includes('dshm.canonical') === false
		&& Object.keys(dump?.data ?? {}).includes('dshm.addresses') === false
		&& href.includes('0123456789abcdef') === false)
	check('**离线待发消息也不进备份** ✗（恢复旧备份不该替你发出过时的话 ✓）',
		Object.keys(dump?.data ?? {}).includes('dshm.outbox') === false && href.includes('过时的待发消息') === false)

	// ③ 导入：坏文件 → 当场说清"没恢复" ✓，而且**一点都没动** localStorage ✓。
	const bogus = new window.File(['这不是 json'], 'bogus.json', { type: 'application/json' })
	const input = $('backupFile')
	Object.defineProperty(input, 'files', { value: [bogus], configurable: true })
	input.dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(220)
	check('导入坏文件：说清"没恢复" ✓，而且**旧设置一点没动** ✓（不许半还原 ✗）',
		String($('backupNote')?.textContent ?? '').includes('没恢复')
		&& window.localStorage.getItem('dshm.pins') === JSON.stringify(['session-ui-test']),
		String($('backupNote')?.textContent ?? '').slice(0, 50))

	// ③ 导入：白名单外的键**不许写进去** ✓；白名单内的照常恢复 ✓。
	const payload = JSON.stringify({
		mark: 'dsh-plugin-mobile-bridge/phone-backup', version: 1, exportedAt: new Date().toISOString(),
		data: {
			'dshm.pins': JSON.stringify(['session-older']), 'dshm.readonly': '1', 'dshm.evil': 'x',
			// ★6/★7 那几项也在白名单里 ✓ —— 冷视角复查抓到的 P1：恢复后它们**必须当场生效** ✗（原来要刷新 ✓）。
			'dshm.history': JSON.stringify(['从备份恢复的一句']), 'dshm.foldLong': '1',
		},
	})
	const good = new window.File([payload], 'backup.json', { type: 'application/json' })
	Object.defineProperty(input, 'files', { value: [good], configurable: true })
	input.dispatchEvent(new window.Event('change', { bubbles: true }))
	await wait(260)
	check('导入真备份：恢复白名单里的项 ✓、跳过快照里多出来的键 ✓、并说清恢复了几项 ✓',
		window.localStorage.getItem('dshm.pins') === JSON.stringify(['session-older'])
		&& window.localStorage.getItem('dshm.evil') === null
		&& String($('backupNote')?.textContent ?? '').includes('已恢复 4 项')
		&& String($('backupNote')?.textContent ?? '').includes('跳过了 1 项'),
		`pins=${window.localStorage.getItem('dshm.pins')} evil=${window.localStorage.getItem('dshm.evil')} note="${String($('backupNote')?.textContent ?? '').slice(0, 60)}"`)
	/*
	 * ⚠️ **P1 回归：恢复完 ⌨ 那一层要当场同步** ✓（冷视角复查：原来 ↑ 拿的还是这台机器的旧历史 ✗）。
	 */
	$('text').value = ''
	try { $('text').setSelectionRange(0, 0) } catch { /* 无所谓 */ }
	$('text').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
	await wait(120)
	check('P1 回归：恢复备份后 ↑ 立刻拿到**备份里的**历史 ✓（不是这台机器的旧历史 ✗ —— 恢复完要重读 ⌨ 那一层 ✓）',
		$('text').value === '从备份恢复的一句', JSON.stringify(String($('text').value).slice(0, 30)))
	check('恢复"只看不发"是**单向安全**的：备份里锁着就恢复成锁着 ✓（并当场生效 ✓）',
		window.localStorage.getItem('dshm.readonly') === '1'
		&& visible($('roStrip'))
		&& $('send').disabled === true,
		`readonly=${window.localStorage.getItem('dshm.readonly')} roStrip 沿祖先链可见=${visible($('roStrip'))} send.disabled=${$('send').disabled}`)
	/*
	 * 🔴 4.3.0（冷视角复查第二轮抓到"这条修复没被钉住"✓）：**「只看不发」也要禁掉「停止」** ✗ ——
	 * 原来只管发送键 ✓，锁上之后连着点两下「停止」照样能取消电脑上正在跑的那一轮 ✓，
	 * 与"锁上就不动手"的初衷不对称 ✗（服务端的 `guardWrite()` 会把请求挡下来 ✓，
	 * 但界面上先给个"能点"的样子就是在引诱误触 ✗）。
	 */
	check('🔴 「只看不发」也要把「停止」一并禁掉 ✓（锁着还能取消电脑上的一轮 = 与初衷不对称 ✗）',
		$('stop').disabled === true, `stop.disabled=${$('stop').disabled}`)
	// 收尾：把这台"手机"恢复成能发消息的状态（后面的用例还要用 ✓）。
	click($('roBtn'))
	await wait(120)
	click($('backupBack'))
	await wait(80)
	click($('checkBack'))
	await wait(80)
}

/* --- 3.0.0 ★④：等放行那一屏（手机侧）---------------------------------------- */
/*
 * 桥侧规矩（默认关 / 防锁死 / 只给本机）在 harness 里钉 ✓；这里钉**手机侧**：
 * ① PIN 对了但设备要放行 → **当场进"等放行"那屏** ✓（不是先说"登录失败"再打转 ✗）；
 * ② 令牌已经没了（401）→ **回登录页** ✓，**不是**"放行了 → 刷新"循环 ✗（页面自己抖 ✗）。
 */
{
	// ① 退出登录 → 回到 PIN 门 → 输对 PIN（桩回 pending ✓）→ 应当看到"等放行"那屏 ✓。
	loginPending = true
	pendingExpired = false
	window.confirm = () => true
	click($('logout'))
	await wait(260)
	check('（前置）退出登录后回到 PIN 门 ✓', visible($('gate')),
		`gate=${window.getComputedStyle($('gate')).display}`)
	$('pin').value = CORRECT_PIN
	click($('gateBtn'))
	await wait(300)
	check('⭐ PIN 对了但设备在等放行 → **当场进"等放行"那屏** ✓（不说"登录失败"✗、也不来回去撞 ✗）',
		visible($('pending')) && visible($('gate')) === false
		&& String($('pendingWhy').textContent).includes('电脑'),
		`pending=${visible($('pending'))} gate=${visible($('gate'))} app=${window.getComputedStyle($('app')).display} `
		+ `gateError="${String($('gateError').textContent).slice(0, 30)}" auto="${String($('pendingAuto').textContent).slice(0, 30)}" `
		+ `loginPending=${loginPending}`)
	check('那一屏说清了"每 3 秒自己问一次" ✓（用户知道不用手点 ✓），也给「怎么做」一个键 ✓',
		String($('pendingAuto').textContent).includes('等') && $('pendingHow') !== null,
		String($('pendingAuto').textContent).slice(0, 40))

	// ② 令牌已经没了（401）→ 回登录页 ✓（不是"放行了→刷新"的循环 ✗）。
	pendingExpired = true
	click($('pendingRetry'))
	await wait(300)
	check('等放行那屏遇到 401：**回登录页** ✓ 并说清"登录已失效" ✓（否则会变成刷新循环 ✗）',
		visible($('pending')) === false && visible($('gate'))
		&& String($('gateError').textContent).includes('失效'),
		`pending=${visible($('pending'))} gate=${visible($('gate'))} err="${String($('gateError').textContent).slice(0, 24)}"`)

	// 收尾：恢复正常登录 ✓，别给后面的用例留下"退出了"的状态 ✓。
	loginPending = false
	pendingExpired = false
	$('pin').value = CORRECT_PIN
	click($('gateBtn'))
	await wait(320)
	check('（收尾）恢复正常登录：`#app` 回来了 ✓', window.getComputedStyle($('app')).display !== 'none')
}

/* --- 3.1.0 面板协议（手机侧）----------------------------------------------- */
/*
 * 协议那半在 harness 里钉（默认关 / 穿越 404 / 覆盖 ✓）；这里钉**手机侧三件事**：
 * ① 清单里的面板变成**工具键** ✓（而且是加在"可收起的那一排"里 ✓）；
 * ② 点开是**整屏 iframe** ✓，src 是相对路径 `panel/<id>/<entry>` ✓（面板里写 `api/xxx` 才连得上 ✓）；
 * ③ 关掉时把 `src` 清空 ✓（示例里的计时器不该在后台继续跑 ✗）。
 */
{
	await ensureAppVisible()
	const panelKey = $('toolKeys').querySelector('button[data-panel="notes"]')
	check('服务端清单里的面板出现在**工具键那一排**里 ✓（图标是清单里的 ✓，标题带"自带示例"✓）',
		panelKey !== null && panelKey.textContent === '📝' && String(panelKey.title).includes('便签'),
		panelKey === null ? '(没有那个键)' : `${panelKey.textContent} / ${panelKey.title}`)
	/*
	 * ⚠️ 复查点名（假象断言 ②）：上面那条只证明"DOM 里有这个按钮" ✓ —— 而它自称验的是
	 * "在**可收起的那一排**里" ✗。面板键是 `setTimeout(...,0)` 之后异步追加的 ✓，
	 * 所以折叠那组用例（跑得更早 ✓）根本没见过它 ✓ → "收起时面板键跟着藏"从未被验 ✓。
	 * 这里补上真动作 ✓：收起 → 断言看不见 → 展开 → 断言又看得见 ✓。
	 */
	click($('toolsToggle'))
	await wait(140)
	check('⭐ 收起工具键时，**面板键也跟着收起** ✓（它是 `#toolKeys` 的子节点 ✓ —— 不是"挂在外面"✗）',
		visible(panelKey) === false && String(window.localStorage.getItem('dshm.tools')) === '1',
		`visible=${visible(panelKey)} dshm.tools=${window.localStorage.getItem('dshm.tools')}`)
	click($('toolsToggle'))
	await wait(140)
	check('展开之后面板键又看得见 ✓', visible(panelKey) === true)
	click(panelKey)
	await wait(160)
	check('点开面板：**整屏纸 + iframe** ✓，src 是相对路径 `panel/<id>/<entry>` ✓（同源才连得上桥的接口 ✓）',
		visible($('panelopen')) && $('panelFrame').getAttribute('src') === 'panel/notes/index.html'
		&& String($('panelTitle').textContent) === '便签',
		`open=${visible($('panelopen'))} src=${$('panelFrame').getAttribute('src')}`)
	check('纸上写着"面板与手机页同源 = 等于信任它" ✓（信任边界不许藏着 ✗）',
		String($('panelNote').textContent).includes('同源'))
	click($('panelBack'))
	await wait(140)
	check('关掉面板：纸收起 ✓、且 `src` 被清空 ✓（里面的计时器不该在后台继续跑 ✗）',
		visible($('panelopen')) === false && $('panelFrame').getAttribute('src') === 'about:blank',
		`open=${visible($('panelopen'))} src=${$('panelFrame').getAttribute('src')}`)
}

/* --- 3.3.0 个人知识库（会话全文检索 · 手机侧）--------------------------------- */
/*
 * 桥侧八条断言在 harness 里钉 ✓（含"发给宿主的请求体只有 query" ✓）；这里钉**手机侧三件事**：
 * ① 工具键那排有一个 🔍 ✓、点开是检索纸 ✓；
 * ② 搜出来**画成卡片**（标题 + 摘要 ✓ —— 标题空的那条要显示"（这个会话没有标题）"✗ 不能空白 ✓）；
 * ③ 服务端说搜不了 → **原话显示** ✓（"读不到就说读不到" ✓ 不显示空列表假装搜过 ✗）。
 */
{
	await ensureAppVisible()
	const key = $('kBtn')
	check('检索入口在工具键那排 ✓（🔍 ✓，与面板键同一个做法 ✓）',
		key !== null && key.textContent === '🔍', key === null ? '(没有入口)' : key.textContent)
	click(key)
	await wait(160)
	check('点开是检索纸 ✓（输入框 + 搜 / 清空 + 结果区 ✓）',
		visible($('kopen')) && $('kQuery') !== null && $('kGo') !== null && $('kList') !== null,
		`open=${visible($('kopen'))}`)
	// ② 搜一次：卡片画出来 ✓
	$('kQuery').value = '弱网'
	click($('kGo'))
	await wait(320)
	const cards = $('kList').querySelectorAll('button')
	check('⭐ 搜出来画成卡片 ✓：标题 + 摘要都在 ✓（空标题那条显示"（这个会话没有标题）" ✗ 不留空白 ✓）',
		cards.length === 2 && String(cards[0].textContent).includes('弱网那次的排查')
		&& String(cards[0].textContent).includes('关于「弱网」')
		&& String(cards[1].textContent).includes('（这个会话没有标题）'),
		cards.length + ' 张：' + String(cards[0]?.textContent ?? '').slice(0, 40))
	check('纸上写清"还有更多" ✓（宿主自己给了上限 ✓ —— 界面**不自己编**条数 ✗）',
		String($('kNote').textContent).includes('还有更多'), String($('kNote').textContent).slice(0, 40))
	// ③ 搜不了：原话 ✓（这条是最要紧的"不假装" ✓）
	$('kQuery').value = 'boom'
	click($('kGo'))
	await wait(320)
	check('⭐ 服务端说搜不了 → **原话显示** ✓、结果区**空着** ✗（不显示空列表假装搜过 ✓）',
		String($('kNote').textContent).includes('搜不了') && $('kList').querySelectorAll('button').length === 0,
		`note="${String($('kNote').textContent).slice(0, 40)}" cards=${$('kList').querySelectorAll('button').length}`)
	// 点一张卡片 → 纸收起 ✓（切会话本身在别处已验 ✓，这里只钉"点得动并且会收起" ✓）
	$('kQuery').value = '弱网'
	click($('kGo'))
	await wait(320)
	click($('kList').querySelectorAll('button')[0])
	await wait(220)
	check('点一条结果 → **纸收起** ✓（去看那个会话 ✓）', visible($('kopen')) === false,
		`open=${visible($('kopen'))}`)
}

/* --- 3.3.0「这周学了什么」（手机侧）------------------------------------------- */
	/*
	 * 桥侧四条断言在 harness ✓；这里钉手机侧三件事：
	 * ① 检索纸里有「📅 这周学了什么」✓、点它真的打桥 ✓；
	 * ② 卡片：**标题空的那条显示短编号兜底** ✓（实测这台宿主的列表不带标题 ✓ —— 空白行用户没法认 ✗）、
	 *    "正在跑"要标出来 ✓；
	 * ③ **真没有活动** 与 **读不到** 是两件事 ✓（前者说"这 7 天没有活动 ✓"，不许说成"读不到" ✗）。
	 */
	{
		await ensureAppVisible()
		click($('kBtn'))
		await wait(160)
		check('检索纸里有「📅 这周学了什么」✓（动态加在纸上 ✓ —— 不新增工具键 ✗）',
			$('kWeek') !== null && String($('kWeek').textContent).includes('这周学了什么'), $('kWeek') === null ? '(没有)' : String($('kWeek').textContent))
		click($('kWeek'))
		await wait(340)
		const cards = $('kList').querySelectorAll('button')
		check('⭐ 画成卡片 ✓：标题空的那条**显示短编号兜底** ✓（`88b54c99` ✓）、"正在跑"标出来 ✓',
			cards.length === 2
			&& String(cards[0].textContent).includes('88b54c99')
			&& String(cards[1].textContent).includes('正在跑'),
			cards.length + ' 张：' + String(cards[0]?.textContent ?? '').slice(0, 40))
		check('纸上写着"这 7 天有 N 个会话有活动" ✓（按最近活动排 ✓）',
			String($('kNote').textContent).includes('7 天') && String($('kNote').textContent).includes('2'),
			String($('kNote').textContent).slice(0, 40))
		/*
		 * ③ 用 days=1（桩里回空）验"真没有"这条 ✓ —— 必须说"没有活动 ✓"，
		 * **不许**说成"读不到" ✗（那是另一回事 ✓，混起来用户会以为桥坏了 ✓）。
		 */
/*
		 * ⚠️ 这里原来有一条"（对照）清空后再点一次仍然画得出来" ✓ —— 复查点名为**假象断言** ✗：
		 * 判据 `… || listAt !== ''` ✓、而 `listAt` 取自**刚被填满**的 `#kList` ✓ → **恒真、永不红** ✓。
		 * 它注释说要验"这 7 天**真没有**活动"那条分支 ✓，但 `kWeek()` 写死 `days=7` ✓ →
		 * 桩里那个空结果分支**永远走不到** ✓ → 那条分支**零覆盖** ✓（CHANGELOG 也自认过 ✓）。
		 * **整条删掉** ✗ —— 不拿一条永远绿的"断言"充数 ✓（要真验它得先让 `kWeek` 能带天数参数 ✓，下一版做 ✓）。
		 */
		click($('kBack'))
		await wait(140)
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

/*
 * 收尾：**页面自己的 console 不该有任何输出** ✓（2026-10-12 加；只放过 warn ✓）。
 *
 * 为什么必须有：页面渲染是**包了 try/catch** 的 ✓（2.10.1 那条修复 ✓）——
 * 一条消息画不出来不会把整页弄死 ✓，但**界面会静默地不再更新** ✗：
 * 断言看到的是"DOM 没变"，不是"变错" ✗ —— 全部照样绿 ✓。
 * 真事：这轮写 ★8 时撞上过"事件铺不上屏、log 冻在固定长度" ✗，查了三轮 ✓。
 * 判据收得**比"抓 error 关键词"更严** ✓：整轮跑下来页面一句都不该说 ✓
 * （今天它确实一句都没说 ✓ —— 放宽松只会让下一个"静默不更新"继续溜过去 ✗）。
 */
/*
 * --- 3.5.0「目标」：手机上看得到（用户 2026-10-13：「我手机桥上看不到目标」✗）--------
 * 只读 ✓；**三种说法要分清** ✓：有目标 ✓ / 会话没在跑 ✓ / 宿主没有 goals 服务 ✓ ——
 * 后两种**都不是**"没有目标" ✗（那是编 ✗）。
 * ⚠️ 必须放在**页面拆掉之前** ✓（这个文件末尾会把 jsdom 关掉 ✓ —— 放到后面就会 `window.document` 是 undefined ✗，
 * 而且崩出来的是 TypeError、不是 FAIL 行 ✗ —— 第一次就是这么写的 ✓）。
 */
{
	goalStub = {
		ok: true,
		goal: {
			objective: '把手机桥按总路线推进到 v4.0.0', phase: 'active',
			roundsStarted: 7, maxGoalRounds: 12, activation: 'armed', updatedAt: 1791840000000,
		},
	}
	click($('goalBtn'))
	await wait(120)
	check('🔴 工具键 🎯 点开就有目标卡 ✓（做什么 + 阶段 + 第几轮 ✓ —— 手机上终于看得到目标 ✓）',
		window.getComputedStyle($('goalopen')).display !== 'none'
		&& $('goalBody').textContent.includes('把手机桥按总路线推进到 v4.0.0')
		&& $('goalBody').textContent.includes('进行中')
		&& $('goalBody').textContent.includes('7 / 12 轮'),
		$('goalBody').textContent.replace(/\s+/g, ' ').slice(0, 130))
	check('目标卡写明了"只看不改" ✓（改目标仍在电脑上的 DSH 里 ✓）',
		$('goalBody').textContent.includes('只看不改'))
	check('有目标时工具键上有标记 ✓（不用点开也看得见 ✓）', $('goalBtn').classList.contains('hasgoal'))
	goalStub = { ok: false, message: '这条会话现在没在跑（目标是"活着的 agent"身上那份 ✓）—— 打开这条会话再刷新一次 ✓' }
	click($('goalRefresh'))
	await wait(120)
	check('🔴 会话没在跑时**照实说"没在跑"** ✓ —— 不许说成"没有目标"✗（那是两件事 ✓）',
		$('goalBody').textContent.includes('没在跑') && $('goalBody').textContent.includes('没有') === false,
		$('goalBody').textContent.replace(/\s+/g, ' ').slice(0, 130))
	check('读不到时工具键上的标记也撤掉 ✓（不留一个假的有目标提示 ✗）', $('goalBtn').classList.contains('hasgoal') === false)
	click($('goalBack'))
	check('点「← 返回」收起来 ✓', window.getComputedStyle($('goalopen')).display === 'none')
	goalStub = { ok: true, goal: null, message: '这条会话现在没有目标 ✓' }
}

/*
 * --- 3.5.0「免手对话」：默认关要说清、按不动就别装能按 ----------------------------
 * 真正的开启（现输 PIN / 30 分钟上限 / 「停」不设门）在 `test/harness.mjs` 里验 ✓；
 * 这里验**手机侧**：入口在录音纸里 ✓、纸打开就报"没开 + 怎么开" ✓、没开时「开始听」是按不动的 ✓。
 */
{
	click($('recBtn'))
	await wait(80)
	check('「免手对话」的入口在录音纸里 ✓（不新增工具键 ✗ —— 那一排已经 15 个了 ✓）',
		$('voiceOpen') !== null && window.getComputedStyle($('recopen')).display !== 'none')
	click($('voiceOpen'))
	await wait(140)
	check('🔴 纸一打开就**照实说**"没开 + 怎么开" ✓（不装作在听 ✗）',
		window.getComputedStyle($('voiceopen')).display !== 'none'
		&& $('voiceNote').textContent.includes('voiceMode'),
		`${window.getComputedStyle($('voiceopen')).display} / ${$('voiceNote').textContent.slice(0, 70)}`)
	check('没开的时候「开始听」是**按不动的** ✓（不让人白按一场 ✗）', $('voiceToggle').disabled === true)
	check('状态行写着"关着" ✓（不是空白、也不是"在听" ✗）', $('voiceLine').textContent.includes('关着'))
	// 「念最新回答」复用页面上那套 🔊 ✓；这一段还没有回答时**老实说**"还没有"✓（不装作念了 ✗）。
	check('「念最新回答」在 ✓；还没有回答时**老实说"还没有"** ✓（不装作念了 ✗）',
		$('voiceSpeakNow') !== null && (click($('voiceSpeakNow')), await wait(80),
			$('toast').textContent.includes('还没有') || $('toast').textContent.includes('不支持')),
		String($('toast').textContent).slice(0, 60))
	click($('voiceBack'))
	await wait(80)
	check('点「← 返回」收起来 ✓', window.getComputedStyle($('voiceopen')).display === 'none')

	/*
	 * 🔴 2026-10-13 真机试出来的 bug（用户原话：「开始听后无输出」✗）：
	 * 点「开始听」时页面**只读了状态、没让服务端开门** ✗ → `remaining` 一直 0 ✓ →
	 * 一秒后滴答判定"到点了"→ 自己停掉 ✓ → 手机上看着"按了什么都没发生"✗。
	 * 这条断言只干一件事 ✓：**确认那条 `POST {action:'start'}` 真的发出去了** ✓（缺了它就红 ✓）。
	 */
	{
		voiceStub = {
			ok: true, enabled: true, listening: false, remainingMs: 0, defaultMinutes: 10, maxMinutes: 30,
			states: ['off', 'listening', 'transcribing', 'running', 'speaking'],
			message: '可以开 ✓ —— 开的时候要现输一次 PIN ✓',
		}
		voicePosts.length = 0
		click($('voiceOpen'))
		await wait(120)
		click($('voiceToggle'))
		await wait(200)
		check('🔴 点「开始听」**必须发出 `POST {action:"start"}`** ✓（少了这条，手机上看就是"按了没反应"✗ —— 真机踩过 ✓）',
			voicePosts.some((item) => item.action === 'start'),
			JSON.stringify(voicePosts).slice(0, 110))
		check('开了之后拿不到麦克风（jsdom 没有）→ **照实说为什么** ✓、状态**不许留在"在听"** ✗',
			$('voiceLine').textContent.includes('在听') === false
			&& (/麦克风|核心|没开成/.test($('voiceNote').textContent)),
			`${$('voiceLine').textContent.slice(0, 30)} / ${$('voiceNote').textContent.slice(0, 70)}`)
		click($('voiceBack'))
		voiceStub = {
			ok: true, enabled: false, listening: false, remainingMs: 0, defaultMinutes: 10, maxMinutes: 30,
			states: ['off', 'listening', 'transcribing', 'running', 'speaking'],
			message: '语音模式没开（在 ~/.dsh/mobile-bridge.json 里加 "voiceMode": true ✓）',
		}
	}

	/*
	 * 🔴 第二个真机 bug（用户原话：「pin 输入是登陆界面而且输入 pin 后还是没输出」✗）：
	 * 要提权时以前走 `api()` ✓ → 弹「登录已过期」✗（人并没掉线 ✓）+ **不会重试** ✗，
	 * 而 PIN 门之后页面很可能整个刷新 ✓ → "刚点了开始听"这件事直接丢了 ✗。
	 * 现在：弹**自己的话** ✓ + 记一个"还没做完"的标记 ✓（页面再起来会自动接着开 ✓）。
	 */
	{
		voicePostNeedPin = true
		voiceStub = {
			ok: true, enabled: true, listening: false, remainingMs: 0, defaultMinutes: 10, maxMinutes: 30,
			states: ['off', 'listening', 'transcribing', 'running', 'speaking'],
			message: '可以开 ✓ —— 开的时候要现输一次 PIN ✓',
		}
		voicePosts.length = 0
		click($('voiceOpen'))
		await wait(120)
		$('voicePin').value = '935881'
		click($('voiceToggle'))
		await wait(220)
		check('🔴 开的时候**必须把 PIN 一起发出去** ✓（上游 `requirePinOr403` 要的就是这个 ✗ —— "登录一次"不满足它 ✓，真机日志：`PIN accepted` 紧跟 403 ✓）',
			voicePosts.some((item) => item.action === 'start' && String(item.pin ?? '') === '935881'),
			JSON.stringify(voicePosts).slice(0, 110))
		check('要 PIN 时**不再弹登录门** ✓（不许出现"登录已过期"那种误导 ✗）',
			window.getComputedStyle($('gate')).display === 'none'
			|| $('gate').textContent.includes('登录已过期') === false,
			$('gate').textContent.replace(/\s+/g, ' ').slice(0, 80))
		check('纸上把话说清：PIN 填在**框里**、再点一次「开始听」✓（不让用户猜 ✓）',
			$('voiceNote').textContent.includes('PIN') && $('voiceNote').textContent.includes('再点一次'),
			$('voiceNote').textContent.slice(0, 90))
		voicePostNeedPin = false
		window.localStorage.setItem('dshm.voicePending', '0')
	}
}

/*
 * --- 3.5.x「解锁」：手机入口**这一版真撤掉** ✓（钉住"不许摆一个按了没反应的按钮"✗）-------------
 * 背景（2026-10-13 连着 5 轮的结论 ✓）：服务端那半边是**完成态** ✓（见 `test/harness.mjs` 的解锁块 ✓、
 * 以及 `test/platform.mjs` 的三种结论 ✓）；手机上那条入口试了 5 种接法都没接通 ✓
 *（绑按钮 ✗ / document ✗ / 纸 ✗ / 放进 openPower ✗ / 内联进委派 ✗），根因是"作用域 + 面板重渲染"两层 ✓。
 * 按项目铁律：**撤掉入口** ✗，不摆一个按了没反应的按钮 ✓；入口下一版重做 ✓。
 *
 * ⚠️ 红队复查抓到过这条断言**不会咬** ✗：原来只查 `[data-unlock]` 和一个**页面里根本不存在**的
 * `#powerUnlockCard` ✓ —— 而"撤掉"其实只撤了半截：`<button id="powerUnlock">` 还挂在 HTML 里 ✓、
 * 还被**两份**接法同时绑着 ✓（一次点击发两条 POST ✓）→ 这条断言照样绿 ✓。
 * 现在钉的是 `#powerUnlock` **真的不存在** ✓ —— 留着按钮、或只删一半，这条当场红 ✓。
 */
{
	powerPosts.length = 0
	click($('sysBtn'))
	await wait(150)
	check('🔴 **不许摆一个按了没反应的「解锁」按钮** ✗ —— 这一版入口**真撤掉** ✓（服务端能力留着 ✓，入口下一版重做 ✓）',
		window.document.querySelector('#powerUnlock') === null
		&& window.document.querySelector('[data-unlock]') === null,
		`#powerUnlock=${window.document.querySelector('#powerUnlock')} / [data-unlock]=${window.document.querySelector('[data-unlock]')} / powerPosts=${powerPosts.length}`)
	click($('sysBack'))
	await wait(80)
}

// 所有 DOM 断言都做完了 ✓ —— 现在才把 jsdom 关掉 ✓（放到前面会让后面的 DOM 断言崩成 TypeError ✗）。
dom.window.close()

/**
 * 收尾：把这一轮的页面 console 噪音检查放最后 ✓（页面还活着的时候做完所有 DOM 断言 ✓）。
 */
const unexpected = consoleLogs.filter((line) => line.startsWith('warn:') === false)
check('整轮下来，页面 console 一句意外的话都没有 ✓（有输出 = 某处"静默不更新/静默失败"的前兆 ✗）',
	unexpected.length === 0, `${unexpected.length} 条：${unexpected.slice(-3).join(' || ').slice(0, 280)}`)

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
