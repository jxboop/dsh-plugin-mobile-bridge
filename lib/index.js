/**
 * dsh-plugin-mobile-bridge — a LAN-only mobile surface for DeepSeek Harness.
 *
 * Two jobs, one listener:
 *   1. photos taken on the phone become real Session attachments (base64 prompt
 *      content the Host promotes to durable references), so the desktop agent
 *      sees them exactly like a desktop upload;
 *   2. the phone can pick a Session, submit a task, watch it run frame by frame
 *      and cancel it.
 *
 * It deliberately does NOT ride the DSH web carrier: that one is a desktop UI
 * bound to loopback by default, and exposing it would publish the whole GUI to
 * every host on the network. This listener owns its own port, its own PIN, and
 * serves only the compact phone page.
 *
 * Host-only, plain ESM, no build step, no runtime dependencies.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { readFile, writeFile, appendFile, stat, unlink, mkdir, rename } from 'node:fs/promises'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { join, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectAddresses, describeAddress } from './addresses.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CONFIG_FILE = 'mobile-bridge.json'
/**
 * Issued phone tokens, so a server restart does not log every phone out.
 * Kept out of mobile-bridge.json so clearing a session never risks the PIN.
 */
const TOKENS_FILE = 'mobile-bridge.tokens.json'
const ACCESS_LOG = 'mobile-bridge.log'
const ACCESS_LOG_LIMIT = 512 * 1024
const PAGE_FILE = join(HERE, 'mobile.html')
/** Replaced at serve time with this build's page tag. */
const PAGE_TAG_MARKER = '__DSH_PAGE_TAG__'

const DEFAULT_PORT = 3081
/**
 * 宿主（DSH）的图片白名单只有这四种。别的格式（HEIC/BMP/TIFF/动图变体…）走
 * `files` 那条路：落到电脑磁盘上，把路径写进任务里，agent 用工具去读。
 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BASE64 = 12 * 1024 * 1024
const MAX_IMAGES_PER_PROMPT = 20
/** 手机发文件（视频、PDF、huge 图）时的上限：单个 40 MB base64（约 30 MB 原文件）。 */
const MAX_FILE_BASE64 = 40 * 1024 * 1024
const MAX_FILES_PER_PROMPT = 3
/** 手机上传的文件落在这里（相对 ~/.dsh）。 */
const UPLOAD_DIR = 'mobile-uploads'
/**
 * 分片上传：一次请求只带一小片。
 *
 * 为什么必须分片：隧道那头（Tailscale 入口）对**慢的、大的**请求会直接掐断 ——
 * 实测 IPv6 入口一个 16 MB 请求回 408，6.7 MB 要 89 秒。手机上行更慢，一整块发
 * 过去必然死在边缘，用户只看到"发送失败 http 403"（边缘的错误页不是 JSON）。
 * 每片 384 KB 原文件，请求体约 512 KB，走慢链路也就几秒。
 */
const UPLOAD_CHUNK_BYTES = 384 * 1024
const MAX_UPLOAD_CHUNKS = 4000
const MAX_UPLOAD_BYTES = 120 * 1024 * 1024
/** `/api/file` 一次最多发多大的媒体（素材图/短视频够用，别拿它下电影）。 */
const MAX_SERVED_FILE_BYTES = 200 * 1024 * 1024
/** 能当手机界面背景的扩展名。视频给 <video>，图片给 <img>。 */
const BACKDROP_TYPES = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
}

/**
 * 按**内容**判断媒体类型，不只信扩展名。
 *
 * 手机相册里存下来的东西经常扩展名骗人：用户发的 `1791380138027.jpeg`，内容其实是
 * `ftypheic`（iPhone 拍的 HEIC 图）；更早那段 `1791373673274.mov` 则是 `ftypqt`（视频）。
 * 两者头 8 字节都以 `ftyp` 开头，必须看**major brand** 才分得开 ——
 * 认成视频去 `<video>` 播会失败，认成 jpeg 去 `<img>` 解也会失败，用户看到的就是
 * "设了背景却没背景"。
 */
function sniffBytes(buf) {
	if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
		const brand = buf.subarray(8, 12).toString('latin1').trim()
		if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
		if (['avif', 'avis'].includes(brand)) return 'image/avif'
		return 'video/mp4'
	}
	if (buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video/webm'
	if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
	if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
	if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
	if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
	return ''
}

/** 先看内容，认不出再看扩展名。 */
function mediaTypeOf(path) {
	const ext = BACKDROP_TYPES[extname(path).toLowerCase()] ?? ''
	try {
		const fd = openSync(path, 'r')
		const head = Buffer.alloc(16)
		const read = readSync(fd, head, 0, 16, 0)
		closeSync(fd)
		const sniffed = sniffBytes(head.subarray(0, read))
		if (sniffed !== '') return sniffed
	} catch { /* 读不到就按扩展名 */ }
	return ext
}

const COOKIE = 'dshm'
/**
 * 这台手机的**长期身份**（不是登录凭据）：只用来记「开始使用说明页看过没有」。
 *
 * 为什么不能用来源 IP 记：隧道（Tailscale Funnel / cloudflared）下，所有手机在宿主
 * 眼里是**同一个地址**（回环或隧道出口）。于是出现过这种现场 —— 一台手机点过
 * 「开始使用」，**之后所有手机（同学、新手机、无痕窗口）进来都再也不弹说明页**，
 * 新人一脸茫然。按设备记账才对；代价是"清了站点数据"会再看一遍说明，可以接受。
 */
const DEVICE_COOKIE = 'dshm_device'
// A stolen cookie used to stay valid for a month, which is a long time to notice a
// phone that went missing. Twelve hours is the default now; two weeks is the cap.
const DEFAULT_TOKEN_TTL_HOURS = 12
const MAX_TOKEN_TTL_HOURS = 24 * 14
// Reading history takes a session. Making this machine DO something takes the PIN
// again, valid for this long. It is the difference between a leaked cookie being a
// privacy problem and it being a remote-code-execution problem.
const DEFAULT_ELEVATION_MINUTES = 15
const MAX_ELEVATION_MINUTES = 240
// Live SSE streams held by one phone are one or two. The cap exists because this
// listener is reachable from the internet through the tunnel, and an unbounded
// fan-out is a cheap way to exhaust the process the whole harness runs in.
const MAX_LIVE_STREAMS = 6
/**
 * 手机没回答时，等多久把提问交还给桌面（官方 api-remotes 的应答者）。
 *
 * waterfall 是【顺序】的：我们 prepend 在最前面，所以在我们返回之前，桌面根本
 * 看不到这个提问。等太久 = 桌面上的批准框迟迟不出现；等太短 = 用户正在手机上
 * 读题就被抢走。120 秒对"正在看手机"的人是够的。
 */
const INTERACTION_TIMEOUT_MS = 120_000
/** 同时挂起的提问上限，防止某个 agent 疯狂提问把内存撑爆。 */
const MAX_PENDING_INTERACTIONS = 16
/**
 * 一次快照最多发给手机多少字节。
 *
 * 手机端绝不能收到整段历史。实测一段聊了几小时的会话：日志 9.7 MB，只要 40 条消息
 * 就展开成 195 条记录、**979 KB** —— 手机（尤其走隧道时）根本传不完，一断线又从头再传，
 * 用户看到的就是永远停在"正在读取会话内容…"。
 */
const SNAPSHOT_BUDGET_BYTES = 240_000
/**
 * 一次快照向宿主最多要多少条消息。
 *
 * 为什么从 40 提到 80：**40 条太容易被"顶出去"** —— 用户报"手机端看不到图片"时，
 * 那张 `image_generate` 的记录在 seq 3528、而当时游标已经 4004，它早已滑出窗口，
 * 手机刷新也找不回来。字节预算（`SNAPSHOT_BUDGET_BYTES`）才是真正的护栏：超了就从
 * 最旧的开始丢，所以**要得更多不会让手机收到更大的包**，只会让"最近这一屏"更完整。
 */
const SNAPSHOT_MAX_MESSAGES = 80
/** 单条文本/工具输出截断到这个长度；真正的大块内容在电脑上看。 */
const SNAPSHOT_TEXT_LIMIT = 4000
// A ceiling on live phone sessions. One per address is the rule (see issueToken);
// this is the backstop so nothing can grow without bound.
const MAX_LIVE_TOKENS = 8
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 12
// A second, global cap. Twelve tries per address per ten minutes is nothing to a
// single host and everything to a botnet with a few thousand of them, so the
// distributed case needs its own ceiling. Sixty failures across everyone in ten
// minutes cannot happen by accident: mistyping a six-digit PIN sixty times in ten
// minutes is not a thing people do. That pins distributed guessing to about 8.6k
// tries a day against a million-combination space.
const LOGIN_MAX_ATTEMPTS_GLOBAL = 60

/* --------------------------------------------------------------- balance */

/** Same credential ref the balance badge uses, so both read one stored key. */
const CRED_REF = 'DEEPSEEK_API_KEY'
/** Primary endpoint plus the documented compatibility prefix. */
const BALANCE_URLS = ['https://api.deepseek.com/user/balance', 'https://api.deepseek.com/v1/user/balance']
const BALANCE_TIMEOUT_MS = 15000
/** The phone may pull-to-refresh; upstream should still be asked rarely. */
const BALANCE_CACHE_MS = 60000
/**
 * There is no public recharge API — DeepSeek only exposes the platform page.
 * The app therefore links out instead of pretending to move money.
 */
const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

/** Hard dependency: every route reads the Session domain through it. */
export const inject = ['sessionController']

/* ------------------------------------------------------------------ config */

function dshHome() {
	const configured = (process.env.DSH_HOME ?? '').trim()
	return configured === '' ? join(homedir(), '.dsh') : configured
}

async function loadConfig() {
	const file = join(dshHome(), CONFIG_FILE)
	let stored = {}
	try {
		stored = JSON.parse(await readFile(file, 'utf8'))
	} catch {
		stored = {}
	}
	const port = Number.isInteger(stored.port) && stored.port > 0 && stored.port < 65536 ? stored.port : DEFAULT_PORT
	const pin = typeof stored.pin === 'string' && /^\d{6}$/.test(stored.pin)
		? stored.pin
		: String(randomInt(100000, 1000000))
	// The address a phone last reached us on. Remembering it is what makes the
	// USB link usable without the operator working out which adapter to use.
	const phoneHost = typeof stored.phoneHost === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(stored.phoneHost)
		? stored.phoneHost
		: ''
	// A public entry point (Cloudflare quick tunnel), written by D:\dsh\tunnel-start.ps1.
	// Display-only: the badge shows it so the operator never has to hunt the log file
	// for the current URL, which changes on every tunnel restart.
	const publicUrl = typeof stored.publicUrl === 'string' && /^https:\/\/[^\s"'<>]+$/.test(stored.publicUrl)
		? stored.publicUrl
		: ''
	// 每条路由都藏在一个随机段后面。隧道域名本身已经不可枚举（Cloudflare 用泛域名
	// 证书，具体主机名不会进证书透明日志），但网址万一从日志行、截图或同步的浏览器
	// 历史里泄漏出去，光有域名也不该够用。必须声明在 `const config` 之前。
	const pathSecret = typeof stored.pathSecret === 'string' && /^[0-9a-f]{16}$/.test(stored.pathSecret)
		? stored.pathSecret
		: randomBytes(8).toString('hex')
	const tokenTtlHours = Number.isInteger(stored.tokenTtlHours) && stored.tokenTtlHours >= 1 && stored.tokenTtlHours <= MAX_TOKEN_TTL_HOURS
		? stored.tokenTtlHours
		: DEFAULT_TOKEN_TTL_HOURS
	// 安全优先：令牌绑定签发时的来源地址。手机换网络就要重新输 PIN，但偷走的
	// cookie 换一台机器就是废纸。不想这样就把 bindTokenToIp 设成 false。
	// 默认 false = 只告警不吊销（移动网络必需）。设成 true 才启用严格的"换地址即吊销"。
	const bindTokenToIp = stored.bindTokenToIp === true
	const elevationMinutes = Number.isInteger(stored.elevationMinutes) && stored.elevationMinutes >= 1 && stored.elevationMinutes <= MAX_ELEVATION_MINUTES
		? stored.elevationMinutes
		: DEFAULT_ELEVATION_MINUTES
	// 排查用的崩溃探针开关。必须原样带回去：下面"配置有变化就整体重写"那一步只写这里
	// 列出的字段，漏掉它就会把用户手动加的这一行悄悄抹掉。
	const crashProbe = stored.crashProbe === true
	// 手机优先回答提问 / 批准操作。默认【关】。
	//
	// 开着的时候，"正在看这个会话的手机"会抢在桌面前面拿到提问；手机 120 秒不答
	// 才轮到桌面。对纯桌面用户来说这是退步（批准框会晚两分钟才出现），所以默认关，
	// 谁需要谁开。没手机在看这个会话时，无论开关如何都是桌面先拿到。
	const answerOnPhone = stored.answerOnPhone === true
	// 手机界面的背景（用户自己挑的一段视频/一张图）：指向 ~/.dsh/mobile-uploads/ 里的
	// 文件名。和 crashProbe 一样必须原样带回去，否则下一次配置重写会把它抹掉。
	const backgroundFile = typeof stored.backgroundFile === 'string' && /^[^\\/]{1,120}$/.test(stored.backgroundFile)
		? stored.backgroundFile
		: ''
	const config = {
		version: 1,
		port,
		pin,
		...(phoneHost === '' ? {} : { phoneHost }),
		...(publicUrl === '' ? {} : { publicUrl }),
		pathSecret,
		tokenTtlHours,
		bindTokenToIp,
		elevationMinutes,
		...(crashProbe ? { crashProbe: true } : {}),
		...(answerOnPhone ? { answerOnPhone: true } : {}),
		...(backgroundFile === '' ? {} : { backgroundFile }),
	}

	if (stored.port !== port || stored.pin !== pin || (stored.publicUrl ?? '') !== publicUrl
		|| (stored.pathSecret ?? '') !== pathSecret || (stored.tokenTtlHours ?? 0) !== tokenTtlHours
		|| stored.bindTokenToIp !== bindTokenToIp || (stored.elevationMinutes ?? 0) !== elevationMinutes
		|| (stored.backgroundFile ?? '') !== backgroundFile) {
		await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
	}
	return { config, file }
}

/** The random segment every route sits behind, as a `/xxxx/` suffix. */
function secretSuffix(config) {
	const secret = typeof config?.pathSecret === 'string' ? config.pathSecret : ''
	return secret === '' ? '/' : `/${secret}/`
}

/** Join a bare `http://host:port/` base with the secret segment. */
function withSecret(config, base) {
	return String(base).replace(/\/+$/, '') + secretSuffix(config)
}

/* --------------------------------------------------------------- addresses */

/**
 * Every non-loopback IPv4 a phone might reach, best candidate first. The
 * ordering rules live in `addresses.js`; this only supplies the live interfaces.
 */
function lanAddresses(preferred = '') {
	return collectAddresses(networkInterfaces(), preferred)
}

/* ------------------------------------------------------------------- auth */

function hashOf(value) {
	return createHash('sha256').update(String(value)).digest()
}

function sameSecret(left, right) {
	return timingSafeEqual(hashOf(left), hashOf(right))
}

function parseCookies(header) {
	const jar = {}
	for (const part of String(header ?? '').split(';')) {
		const index = part.indexOf('=')
		if (index < 0) continue
		jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
	}
	return jar
}

/** Loopback means the only possible caller is our own cloudflared. */
function isLoopbackPeer(peer) {
	return peer === '::1' || peer === '127.0.0.1' || peer === '::ffff:127.0.0.1'
}

/**
 * The address the login throttle counts against.
 *
 * Reading `x-forwarded-for` unconditionally hands the throttle key to the caller:
 * a fresh fake value per request is a fresh bucket, so a six-digit PIN can be
 * walked through without limit. Forwarded headers are therefore read only when
 * the socket peer is loopback (the request came through our own cloudflared),
 * and `cf-connecting-ip` wins there because the Cloudflare edge overwrites
 * whatever a client sends in it. A client-supplied `x-forwarded-for` entry
 * survives, so when that header is the only one present its LAST entry is the
 * one our own proxy added — never the first, which the caller controls.
 */
function clientIp(req) {
	const peer = req.socket.remoteAddress ?? 'unknown'
	if (!isLoopbackPeer(peer)) return peer
	const cf = req.headers['cf-connecting-ip']
	if (typeof cf === 'string' && cf.trim() !== '') return cf.trim()
	const forwarded = req.headers['x-forwarded-for']
	if (typeof forwarded === 'string' && forwarded.trim() !== '') {
		const parts = forwarded.split(',').map((part) => part.trim()).filter((part) => part !== '')
		if (parts.length > 0) return parts[parts.length - 1]
	}
	return peer
}

/**
 * 「开始使用」说明页的内容版本。
 *
 * 为什么要有版本号：这份说明只在**第一次连上**时自动讲一遍，之后就不再打扰 —— 但
 * 说明的**内容**是会改的（新增了哪些按键、生图要注意什么）。改版后如果还按"这台设备
 * 看过"一刀切，老用户永远看不到新内容，只能自己想起来点「说明」。
 * 所以：内容一改就 +1，服务端按设备记"看过的是第几版"，版本落后就再讲一遍。
 */
const WELCOME_VERSION = 2

/**
 * 把存下来的"看过"记录换算成版本号。
 *
 * 兼容老数据：v1 时代存的是**毫秒时间戳**（形如 1792078785000），直接当版本号会变成
 * 一个远大于 WELCOME_VERSION 的数 → 新版说明再也不弹。所以明显是时间戳的一律算第 1 版。
 */
function welcomedVersion(stored) {
	const value = Number(stored)
	if (!Number.isFinite(value)) return 0
	return value > 1e6 ? 1 : value
}

/**
 * 读这台手机的设备标识；没有就**现发一个**（写进 set-cookie）。
 *
 * 只认 cookie，不看 IP：IP 在隧道后面是所有手机共用的（见 DEVICE_COOKIE 的注释）。
 * 拿不到/被禁用 cookie 时每次都会是新标识 —— 页面自己的 localStorage 标记还兜一层，
 * 最坏情况是"说明页多弹一次"，比"新人永远看不到说明"好得多。
 */
function deviceId(req, res) {
	const found = parseCookies(req.headers.cookie)[DEVICE_COOKIE]
	if (typeof found === 'string' && found !== '') return found
	const fresh = randomUUID()
	if (res !== undefined && res !== null && typeof res.setHeader === 'function') {
		// 400 天，跟"这台设备"同寿。Secure 不能写死：这页面同时跑在明文 HTTP 的
		// 局域网/热点上，加了 Secure 就被丢掉（和登录 cookie 同一个理由）。
		const cookie = `${DEVICE_COOKIE}=${fresh}; SameSite=Lax; Path=/; Max-Age=${400 * 24 * 60 * 60}`
		const existing = res.getHeader('set-cookie')
		if (existing === undefined) res.setHeader('set-cookie', cookie)
		else if (Array.isArray(existing)) res.setHeader('set-cookie', existing.concat(cookie))
		else res.setHeader('set-cookie', [existing, cookie])
	}
	return fresh
}

/* -------------------------------------------------------------- http utils */

/**
 * Headers every response carries. `referrer-policy: no-referrer` matters more than
 * it looks: the random path segment lives in the URL, so any outbound navigation or
 * subresource would otherwise hand that segment to a third party in Referer.
 */
const SECURITY_HEADERS = {
	'cache-control': 'no-store',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'x-frame-options': 'DENY',
}

function sendJson(res, status, value) {
	const raw = Buffer.from(JSON.stringify(value), 'utf8')
	// 会话快照动辄两百多 KB，手机上（5G + 隧道）每次都要真传一遍 —— gzip 之后只剩
	// 十分之一左右。小响应不压（省那点字节不如省一次 CPU + 免得多一层）。
	if (res.gzipOk === true && raw.length >= 1024) {
		const packed = gzipSync(raw)
		res.writeHead(status, {
			...SECURITY_HEADERS,
			'content-type': 'application/json; charset=utf-8',
			'content-encoding': 'gzip',
			'content-length': packed.length,
		})
		res.end(packed)
		return
	}
	res.writeHead(status, {
		...SECURITY_HEADERS,
		'content-type': 'application/json; charset=utf-8',
		'content-length': raw.length,
	})
	res.end(raw)
}

async function readBody(req, limit = MAX_BODY_BYTES) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) throw new Error('payload too large')
		chunks.push(chunk)
	}
	if (chunks.length === 0) return {}
	const text = Buffer.concat(chunks).toString('utf8')
	if (text.trim() === '') return {}
	return JSON.parse(text)
}

/* ---------------------------------------------------------------- balance */

/**
 * Credential resolution mirrors the balance badge plugin on purpose: the same
 * layered store, the same ref, so a key installed once serves both. The key is
 * read, used for one upstream call and never returned over the wire.
 */
function credentialFileCandidates() {
	const candidates = []
	const home = (process.env.DSH_HOME ?? '').trim()
	if (home !== '') candidates.push(join(home, '.credentials.yaml'))
	const profile = process.env.USERPROFILE ?? process.env.HOME
	if (typeof profile === 'string' && profile.length > 0) candidates.push(join(profile, '.dsh', '.credentials.yaml'))
	return candidates
}

/** Read `DEEPSEEK_API_KEY` out of one YAML refs section without a YAML parser. */
function readKeyFromFile() {
	for (const file of credentialFileCandidates()) {
		let text
		try {
			text = readFileSync(file, 'utf8')
		} catch {
			continue
		}
		const match = text.match(new RegExp(`(?:^|\\n)\\s*${CRED_REF}\\s*:\\s*([^\\r\\n#]+)`))
		if (match === null) continue
		const value = match[1].trim().replace(/^['"]|['"]$/g, '').trim()
		if (value.length > 0) return { value, source: 'file' }
	}
	return { value: '', source: 'unavailable' }
}

/** Prefer the credential service; fall back to the layered file. */
async function resolveApiKey(ctx) {
	const credentials = ctx.get('credentials')
	if (credentials !== undefined && typeof credentials.resolve === 'function') {
		try {
			const resolved = await credentials.resolve(CRED_REF)
			if (resolved !== null && typeof resolved === 'object' && typeof resolved.value === 'string') {
				const value = resolved.value.trim()
				if (value.length > 0) return { value, source: String(resolved.source ?? 'credentials') }
			}
		} catch {
			// A failing service must not hide a perfectly good stored key.
		}
	}
	return readKeyFromFile()
}

function toBalanceEntry(entry) {
	if (entry === null || typeof entry !== 'object') return null
	const total = Number(entry.total_balance)
	if (!Number.isFinite(total)) return null
	return {
		currency: typeof entry.currency === 'string' ? entry.currency : 'CNY',
		total,
		totalText: typeof entry.total_balance === 'string' ? entry.total_balance : String(total),
		granted: Number(entry.granted_balance),
		toppedUp: Number(entry.topped_up_balance),
	}
}

async function queryBalance(key) {
	let lastError = '上游不可达'
	for (const url of BALANCE_URLS) {
		let response
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
				signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
			})
		} catch (error) {
			lastError = String(error?.message ?? error)
			continue
		}
		if (response.status === 401 || response.status === 403) {
			return { ok: false, reason: 'auth', message: `API Key 被拒绝（HTTP ${response.status}）` }
		}
		if (!response.ok) {
			lastError = `HTTP ${response.status}`
			continue
		}
		let data
		try {
			data = await response.json()
		} catch {
			lastError = '响应不是合法 JSON'
			continue
		}
		const entries = Array.isArray(data?.balance_infos) ? data.balance_infos : []
		const balances = entries.map(toBalanceEntry).filter((entry) => entry !== null)
		if (balances.length === 0) return { ok: false, reason: 'shape', message: '接口未返回余额条目' }
		return { ok: true, isAvailable: data.is_available === true, balances, at: Date.now() }
	}
	return { ok: false, reason: 'network', message: lastError }
}

/* ------------------------------------------------------- 手机上传的文件 */

/**
 * 手机上传的文件名：只留基名、去掉路径分隔符与控制字符。
 * 这个名字会直接进磁盘路径，所以绝不能让它有机会跳出上传目录。
 */
function safeUploadName(raw) {
	const base = String(raw ?? '').split(/[\\/]/).pop() ?? ''
	const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim()
	const name = cleaned === '' ? 'file' : cleaned
	return name.length > 80 ? `${name.slice(0, 60)}${name.slice(-16)}` : name
}

function uploadsDir() {
	return join(dshHome(), UPLOAD_DIR)
}

/** 把 base64 落到 ~/.dsh/mobile-uploads/，返回原始名、类型和磁盘绝对路径。 */
async function saveUpload({ name, mediaType, data }) {
	const dir = uploadsDir()
	await mkdir(dir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
	const target = join(dir, `${stamp}-${randomBytes(2).toString('hex')}-${safeUploadName(name)}`)
	await writeFile(target, Buffer.from(String(data ?? ''), 'base64'))
	return { name: safeUploadName(name), mediaType: String(mediaType ?? ''), path: target }
}

/**
 * 写进任务里的一段说明。模型看不了视频，但 agent 有工具 —— 把"文件在哪、是什么、
 * 能拿它干什么"说清楚，比丢一个看不懂的附件有用得多。
 */
function describeSavedFiles(files) {
	if (!Array.isArray(files) || files.length === 0) return ''
	const lines = files.map((entry) =>
		`- ${entry.name}${entry.mediaType === '' ? '' : `（${entry.mediaType}）`} → ${entry.path}`)
	return [
		'【手机上传的文件】用户从手机发来了下面这些文件，已经存在这台电脑上：',
		...lines,
		'图片之外的内容我没法直接看，请用工具打开/处理（视频可以用 ffmpeg 抽帧或转码）。',
	].join('\n')
}

/**
 * 只认自己上传目录里的文件：手机可以随便传内容，但不能借这条接口读电脑上任意路径。
 * （真路径解析过，`..` 逃不出去。）
 */
function safeUploadRef(candidate) {
	const raw = String(candidate ?? '')
	if (raw === '') return null
	const dir = uploadsDir()
	const resolved = resolve(raw)
	if (resolved !== dir && resolved.startsWith(dir + sep) === false) return null
	return resolved
}

/* ------------------------------------------------------------- the bridge */

function createBridge(ctx) {
	const state = {
		server: null,
		listening: false,
		config: null,
		configFile: '',
		tokensFile: '',
		accessLog: '',
		sessions: new Map(),
		attempts: new Map(),
		recentFailures: [],
		// token -> 提权到期时间。与 sessions 分开，读历史不需要它。
		elevated: new Map(),
		// 令牌被从别的地址使用的记录，用于事后追查。
		foreignUses: [],
		streams: new Set(),
		/**
		 * 用 `{kind:'session'}` 地址跟不了的会话（agent 自己派生的子会话）。
		 * 第一次跟随失败时记下来：从列表里拿掉，免得用户一次次选中一个打不开的会话，
		 * 每三秒重连一次，还看到一个"和电脑断开了"的红字（其实连接好得很）。
		 */
		unfollowable: new Set(),
		/** 会话列表里见过的 cwd：`/api/file` 用它判断"这个路径能不能发给手机"。 */
		sessionCwds: new Set(),
		/** 会话列表的短命缓存（5 秒）：手机一次打开会连着要两份，重连时更是一串。 */
		sessionListCache: null,
		/**
		 * 已经看过"开始使用"说明页的手机：来源地址 -> 时间。
		 *
		 * 为什么要在服务端再记一份：页面用 localStorage 记，但换地址（Funnel ↔ 局域网
		 * 是不同 origin，各存各的）、无痕浏览、或者手机清了站点数据之后标记就没了 ——
		 * 表现就是"每次进来都弹一遍说明页"。这份跟着令牌文件落盘，重载/重启也在。
		 */
		welcomed: new Map(),
		/**
		 * 正在等手机回答的提问/审批：id -> { kind, sessionId, settle, timer, signal }。
		 * agent 调 ask_user_question、或某个工具需要批准时，waterfall 会在这里挂起，
		 * 手机点完才放行；手机不理就超时交给桌面。
		 */
		pending: new Map(),
		/** Last time each peer was recorded, so a retry storm cannot flood the log. */
		peers: new Map(),
		/** One upstream balance call per minute, shared by every phone. */
		balance: { at: 0, value: null, inflight: null },
		/** Hash of the served page, so a stale client can reload itself. */
		pageTag: '',
		page: '',
		/** gzip 过的同一份页面：手机上首屏小一个量级。null = 不压缩。 */
		pageGzip: null,
	}

	const log = (message) => console.log(`[mobile-bridge] ${message}`)
	const warn = (message) => console.error(`[mobile-bridge] ${message}`)

	/**
	 * Durable evidence of who actually reached this listener. When the phone
	 * cannot connect, this file answers the only question that matters: did the
	 * packets arrive at all? Nothing here means the network never delivered
	 * them (client isolation, wrong subnet, firewall); a connection line means
	 * the network is fine and the problem is above it.
	 */
	function record(line) {
		if (state.accessLog === '') return
		void appendFile(state.accessLog, `[${new Date().toISOString()}] ${line}\n`, 'utf8').catch(() => {})
	}

	function notePeer(ip, what) {
		const now = Date.now()
		if ((state.peers.get(ip) ?? 0) > now - 60000) return
		state.peers.set(ip, now)
		record(`${what} from ${ip}`)
	}

	/**
	 * Learn the address a phone actually used. The Host header of an
	 * authenticated request names the local address that reached it — strictly
	 * better evidence than guessing which adapter is the USB link, and the only
	 * signal available at all on a network where the phone cannot be probed.
	 */
	function rememberHost(req) {
		const raw = String(req.headers.host ?? '')
		const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0]
		if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('127.')) return
		if (state.config.phoneHost === host) return
		state.config.phoneHost = host
		void writeFile(state.configFile, `${JSON.stringify(state.config, null, 2)}\n`, 'utf8')
			.catch(() => { /* a read-only home must not break serving */ })
		record(`phone reached us on ${host}`)
	}

	function issueToken(ip) {
		const token = randomBytes(24).toString('base64url')
		const boundIp = String(ip ?? '')
		// One live session per address: signing in again retires the previous token
		// instead of stacking another one beside it. Re-entering the PIN used to add
		// a fresh session every time, which is how a dozen "phone logins" piled up.
		for (const [existing, record] of state.sessions) {
			if (record.ip === boundIp) {
				state.sessions.delete(existing)
				state.elevated.delete(existing)
			}
		}
		// Backstop, oldest first, so a stream of new addresses cannot grow the set.
		while (state.sessions.size >= MAX_LIVE_TOKENS) {
			const oldest = state.sessions.keys().next().value
			if (oldest === undefined) break
			state.sessions.delete(oldest)
			state.elevated.delete(oldest)
		}
		state.sessions.set(token, { expiresAt: Date.now() + state.tokenTtlMs, ip: boundIp })
		state.elevated.set(token, Date.now() + state.elevationMs)
		persistTokens()
		return token
	}

	/**
	 * Tokens used to live only in this Map, so every `dsh web` restart dropped
	 * the phone back to the PIN gate. The file is the durable half; the Map
	 * stays authoritative so expiry and logout still revoke immediately.
	 */
	function persistTokens() {
		if (state.tokensFile === '') return
		// `welcomed` 一起落盘：手机被清掉站点数据 / 换了地址（不同 origin 的
		// localStorage 是各存各的）/ 用的是无痕浏览时，页面自己的标记就没了 ——
		// 那会让"开始使用"说明页每次进来都弹一遍。服务端记一份就稳了。
		const payload = {
			version: 1,
			tokens: Object.fromEntries(state.sessions),
			welcomed: Object.fromEntries(state.welcomed),
		}
		void writeFile(state.tokensFile, `${JSON.stringify(payload)}\n`, 'utf8').catch(() => {})
	}

	async function loadTokens() {
		state.tokensFile = join(dshHome(), TOKENS_FILE)
		let stored = null
		try {
			stored = JSON.parse(await readFile(state.tokensFile, 'utf8'))
		} catch {
			return
		}
		const now = Date.now()
		let live = 0
		for (const [token, record] of Object.entries(stored?.tokens ?? {})) {
			if (typeof token !== 'string' || token === '') continue
			// Older files stored a bare expiry number. Accept both shapes so an
			// upgrade does not silently log the phone out.
			const expiresAt = typeof record === 'number' ? record : Number(record?.expiresAt)
			if (!Number.isFinite(expiresAt) || expiresAt <= now) continue
			const ip = typeof record === 'object' && record !== null && typeof record.ip === 'string' ? record.ip : ''
			state.sessions.set(token, { expiresAt, ip })
			// A restored session is NOT elevated: after a restart the phone must prove
			// the PIN again before it can make this machine do anything.
			live += 1
		}
		if (live > 0) log(`restored ${live} phone session(s)`)
		// 已经看过"开始使用"的手机（按来源地址记）：页面自己的 localStorage 可能因为
		// 换地址/无痕/清数据而丢，服务端这份不会。
		for (const [key, at] of Object.entries(stored?.welcomed ?? {})) {
			if (typeof key === 'string' && key !== '' && Number.isFinite(Number(at))) {
				state.welcomed.set(key, Number(at))
			}
		}
	}

	function authed(req) {
		const token = parseCookies(req.headers.cookie)[COOKIE]
		if (typeof token !== 'string' || token === '') return false
		// 变量名不能叫 record —— 那会遮蔽同作用域里的日志函数 record()，
		// 于是这一行的 record(...) 变成"把对象当函数调用"，抛 TypeError。
		// 它只在【令牌被异地使用】这条路径上触发，所以平时看不出来，
		// 一旦手机换 IP 就当场把整个 DSH 进程打死。
		const tokenRecord = state.sessions.get(token)
		if (tokenRecord === undefined) return false
		if (tokenRecord.expiresAt < Date.now()) {
			state.sessions.delete(token)
			state.elevated.delete(token)
			return false
		}
		// A token seen from an address other than the one it was issued to.
		//
		// Revoking on every change sounds like the right control and is unusable in
		// practice: a phone rotates addresses constantly — carrier NAT, IPv6 privacy
		// extensions, IPv6/IPv4 fallback — and the phone that owns the token was being
		// logged out several times an hour. It surfaced as "the page is blank": the
		// stream 401'd before it ever delivered a transcript.
		//
		// So: always RECORD a move (visible in /api/bootstrap's `foreignUses` and in
		// the access log), and only REVOKE when strict binding is explicitly asked for.
		if (tokenRecord.ip !== '') {
			const seen = clientIp(req)
			if (seen !== tokenRecord.ip) {
				const issuedTo = tokenRecord.ip
				const known = state.foreignUses.some((entry) => entry.seen === seen && entry.issuedTo === issuedTo)
				if (!known) {
					state.foreignUses.push({ at: Date.now(), seen, issuedTo })
					if (state.foreignUses.length > 50) state.foreignUses.shift()
				}
				if (state.config?.bindTokenToIp === true) {
					record(`token issued to ${issuedTo} used from ${seen} -> revoked (strict ip binding)`)
					state.sessions.delete(token)
					state.elevated.delete(token)
					persistTokens()
					return false
				}
				// Warn-only: adopt the new address so each move is reported once.
				tokenRecord.ip = seen
				if (!known) record(`token issued to ${issuedTo} used from ${seen} -> allowed (warn-only)`)
			}
		}
		return true
	}

	/** 读过 cookie 还不够：让这台机器干活需要最近输过一次 PIN。 */
	function elevated(req) {
		const token = parseCookies(req.headers.cookie)[COOKIE]
		if (typeof token !== 'string' || token === '') return false
		const until = state.elevated.get(token)
		if (until === undefined) return false
		if (until < Date.now()) {
			state.elevated.delete(token)
			return false
		}
		return true
	}

	function throttleLogin(ip) {
		const now = Date.now()
		// Global window first. It is only READ here; entries are appended by
		// noteLoginFailure, so a successful login never counts against it.
		while (state.recentFailures.length > 0 && now - state.recentFailures[0] > LOGIN_WINDOW_MS) {
			state.recentFailures.shift()
		}
		if (state.recentFailures.length >= LOGIN_MAX_ATTEMPTS_GLOBAL) return false

		const entry = state.attempts.get(ip)
		if (entry === undefined || now - entry.startedAt > LOGIN_WINDOW_MS) {
			state.attempts.set(ip, { startedAt: now, count: 1 })
			return true
		}
		entry.count += 1
		return entry.count <= LOGIN_MAX_ATTEMPTS
	}

	/** Recorded only when a PIN is actually rejected. */
	function noteLoginFailure() {
		state.recentFailures.push(Date.now())
	}

	/* ------------------------------------------------------------ sessions */

	/**
	 * 手机能不能把某个路径当媒体读走。
	 *
	 * 只认桥认识的目录：工作区（注册表里的那些）、每个会话自己的 cwd、~/.dsh（附件与
	 * 上传）、以及系统临时目录。加上"必须是图片/视频"，这条接口就不是任意文件读取。
	 */
	function isServablePath(path) {
		const roots = new Set()
		const registry = ctx.get('workspaceRegistry')
		if (registry !== undefined && typeof registry.list === 'function') {
			try {
				for (const workspace of registry.list()) {
					if (typeof workspace?.path === 'string' && workspace.path !== '') roots.add(resolve(workspace.path))
				}
			} catch { /* 注册表坏了不该让接口 500 */ }
		}
		for (const value of state.sessionCwds) roots.add(resolve(value))
		roots.add(resolve(dshHome()))
		roots.add(resolve(tmpdir()))
		for (const root of roots) {
			if (path === root || path.startsWith(root + sep)) return true
		}
		return false
	}

	/** 背景文件还在不在、是什么类型 —— 页面据此决定要不要铺视频层。 */
	function backgroundInfo() {
		const name = typeof state.config?.backgroundFile === 'string' ? state.config.backgroundFile : ''
		if (name === '') return null
		const path = safeUploadRef(join(uploadsDir(), name))
		if (path === null) return null
		const mediaType = mediaTypeOf(path)
		if (mediaType === '') return null
		try {
			const info = statSync(path)
			// `?v=` 是给手机那层本地缓存用的：它按 url+bytes 存 IndexedDB，
			// 换了背景（哪怕碰巧字节数一样）也必须换 key，否则"换了却没变"。
			return {
				url: `api/background?v=${info.size}-${Math.round(info.mtimeMs)}`,
				mediaType,
				kind: mediaType.startsWith('video/') ? 'video' : 'image',
				bytes: info.size,
			}
		} catch {
			return null
		}
	}

	function summarize(summary) {
		const values = summary.projections?.values ?? {}
		let title = ''
		for (const [key, value] of Object.entries(values)) {
			if (typeof value === 'string' && key.toLowerCase().includes('title')) { title = value; break }
		}
		return {
			sessionId: summary.sessionId,
			title: title === '' ? (summary.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '(未命名)' : title,
			cwd: summary.cwd ?? '',
			running: summary.running === true,
			blank: summary.blank === true,
			updatedAt: summary.updatedAt,
		}
	}

	async function listSessions() {
		// 几秒内的重复调用直接复用：手机打开一次会连着要两份（boot + loadSessions），
		// 断线重连时更是一串 —— 每次都去问宿主 40 多个会话，纯属白等。
		const now = Date.now()
		if (state.sessionListCache !== null && now - state.sessionListCache.at < 5000) {
			return state.sessionListCache.value
		}
		const controller = ctx.sessionController
		const value = await controller.list({}, AbortSignal.timeout(15000))
		const entries = (value.items ?? []).map(summarize)
		for (const entry of entries) {
			if (entry.cwd !== '') state.sessionCwds.add(entry.cwd)
		}
		const listed = entries
			// 子会话打不开就别摆出来（见 state.unfollowable）。
			.filter((entry) => state.unfollowable.has(entry.sessionId) === false)
			.sort((left, right) => right.updatedAt - left.updatedAt)
		state.sessionListCache = { at: now, value: listed }
		return listed
	}

	/**
	 * DSH 里 agent 自己派生的子会话不能用 `{kind:'session'}` 地址跟随，宿主会回
	 * "subagent Sessions require their durable parent address"。手机端不做子会话
	 * 地址（那是给桌面 UI 用的），但必须把这件事**说清楚**：以前它跟普通断线一样
	 * 只报"和电脑断开了 / 你的地址已失效"，用户会以为桥坏了。
	 */
	const isUnfollowable = (message) => /subagent/i.test(message)

	/**
	 * The wire log carries an `assistant/message` payload whose `stream` field
	 * repeats every delta already delivered live. Dropping it keeps a snapshot
	 * of a long session inside a phone's patience.
	 */
	function trimEvent(event) {
		if (event?.type !== 'assistant/message' || event.data === null || typeof event.data !== 'object') return event
		const { stream, ...rest } = event.data
		return { ...event, data: rest }
	}

	/* -------------------------------------------------------------- routes */

	async function handleLogin(req, res) {
		const ip = clientIp(req)
		if (!throttleLogin(ip)) {
			sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' })
			return
		}
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		if (!sameSecret(String(body.pin ?? ''), state.config.pin)) {
			warn(`failed PIN attempt from ${ip}`)
			record(`PIN rejected from ${ip}`)
			noteLoginFailure()
			sendJson(res, 401, { error: 'PIN 不正确' })
			return
		}
		record(`PIN accepted from ${ip}`)
		// An existing session is elevated in place; only a fresh login rotates the
		// cookie. Rotating on every PIN re-entry would leave a trail of live tokens.
		const presented = parseCookies(req.headers.cookie)[COOKIE]
		const held = typeof presented === 'string' ? state.sessions.get(presented) : undefined
		const reuse = held !== undefined && (state.config?.bindTokenToIp === false || held.ip === ip)
		const token = reuse ? presented : issueToken(ip)
		state.elevated.set(token, Date.now() + state.elevationMs)
		// `Secure` has to be conditional: this very page is also served over plain
		// HTTP on the LAN/hotspot, and a Secure cookie is dropped there — which would
		// look exactly like a wrong PIN and be near-impossible to diagnose.
		const secureFlag = String(req.headers['x-forwarded-proto'] ?? '') === 'https' ? '; Secure' : ''
		res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${secureFlag}; Max-Age=${Math.floor(state.tokenTtlMs / 1000)}`)
		sendJson(res, 200, { ok: true })
	}

	/** bootstrap 的内容（单独抽出来：`/api/boot` 要把这份和对话快照拼在一个响应里）。 */
	async function buildBootstrap(req, res) {
		let sessions = []
		let failure = null
		try {
			sessions = await listSessions()
		} catch (error) {
			failure = String(error?.message ?? error)
		}
		return {
			sessions,
			failure,
			// Full entries, not bare strings: the phone page and the desktop badge
			// both need to say *why* a candidate is first (USB link / remembered).
			addresses: lanAddresses(state.config.phoneHost ?? '').map((entry) => {
				const described = describeAddress(entry, state.config.port)
				return { ...entry, ...described, url: withSecret(state.config, described.url) }
			}),
			phoneHost: state.config.phoneHost ?? '',
			port: state.config.port,
			// 当前对外的正式地址（含密钥段）。页面会把它记进 localStorage：万一用户
			// 停在一条【已经失效的旧地址】上（页面还能从内存/缓存显示，但所有请求都
			// 失败 → 一片空白），他能一键切回当前地址，而不是对着空白干瞪眼。
			publicUrl: typeof state.config.publicUrl === 'string' && state.config.publicUrl !== ''
				? withSecret(state.config, state.config.publicUrl)
				: '',
			pageTag: state.pageTag,
			// 手机界面的背景（用户自己挑的视频/图）。没有就是 null，页面保持原样。
			background: backgroundInfo(),
			// 这台手机看过"开始使用"没有 —— 页面据此决定要不要再弹（本地标记丢了也不会重复弹）。
			// 按**设备**记，不按 IP：隧道后面所有手机是同一个 IP（见 DEVICE_COOKIE）。
			// 内容改版（WELCOME_VERSION +1）后这里会重新变 false，让老设备再看一遍新说明。
			welcomed: welcomedVersion(state.welcomed.get(deviceId(req, res))) >= WELCOME_VERSION,
			security: {
				recentFailures: state.recentFailures.length,
				windowMinutes: Math.round(LOGIN_WINDOW_MS / 60000),
				locked: state.recentFailures.length >= LOGIN_MAX_ATTEMPTS_GLOBAL,
				tokenBoundToIp: state.config?.bindTokenToIp !== false,
				requirePinForWrites: true,
				elevated: elevated(req),
				foreignUses: state.foreignUses.slice(-5),
			},
		}
	}

	async function handleBootstrap(req, res) {
		sendJson(res, 200, await buildBootstrap(req, res))
	}

	/**
	 * `/api/boot`：一次请求把"打开手机桥"要的两样东西都取回来。
	 *
	 * 为什么要合并：隧道慢的时候（实测经过旧金山 DERP 时一个来回 8 秒），分开要
	 * bootstrap + transcript 两个来回 = 十几秒；合成一个就少一半等待。
	 */
	async function handleBoot(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		// 页面手机上留着上次那份对话时会带 since= 回来（切到别的 App 再回来、
		// PWA 被系统回收后重开）→ 只补新的那几条，几十字节，不用再等整段下载。
		const since = parseSince(url.searchParams.get('since'))
		const payload = await buildBootstrap(req, res)
		// 显式给 null：页面靠 `body.transcript` 是否存在来判断要不要贴对话，
		// 字段时有时无会让客户端契约变成口头约定。
		payload.transcript = null
		if (sessionId !== '') {
			try {
				const transcript = await buildTranscript(sessionId)
				if (since !== null && Array.isArray(transcript.records)) {
					const sliced = sliceSince(transcript.records, transcript.cursor ?? 0, since)
					if (sliced.partial === true) {
						transcript.partial = true
						transcript.records = sliced.records
					}
				}
				payload.transcript = transcript
			} catch (error) {
				payload.transcript = { records: [], cursor: 0, hasMore: false, error: String(error?.message ?? error) }
			}
		}
		sendJson(res, 200, payload)
	}

	/** Everything the "new task" screen needs to offer a destination. */
	async function handleWorkspaces(res) {
		const workspaces = []
		const registry = ctx.get('workspaceRegistry')
		if (registry !== undefined && typeof registry.list === 'function') {
			try {
				for (const workspace of registry.list()) {
					workspaces.push({ id: workspace.id, title: workspace.title, path: workspace.path })
				}
			} catch (error) {
				warn(`workspace list failed: ${String(error?.message ?? error)}`)
			}
		}
		const presets = []
		const presetsService = ctx.get('agentPresets')
		if (presetsService !== undefined && typeof presetsService.list === 'function') {
			try {
				for (const preset of await presetsService.list()) {
					// A broken preset stays on the roster but can never mount, so
					// offering it here would only produce a late failure.
					if (typeof preset.broken === 'string' && preset.broken !== '') continue
					presets.push({ id: preset.id, name: preset.name ?? preset.id, description: preset.description ?? '' })
				}
			} catch (error) {
				warn(`preset list failed: ${String(error?.message ?? error)}`)
			}
		}
		sendJson(res, 200, { workspaces, presets })
	}

	/** Create one ordinary Session; the first message goes through /api/prompt. */
	async function handleCreateSession(req, res) {
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const request = {}
		if (typeof body.workspaceId === 'string' && body.workspaceId !== '') request.workspaceId = body.workspaceId
		if (typeof body.cwd === 'string' && body.cwd !== '') request.cwd = body.cwd
		if (typeof body.agentPreset === 'string' && body.agentPreset !== '') request.agentPreset = body.agentPreset
		if (Object.keys(request).length === 0) {
			sendJson(res, 400, { error: '需要 workspaceId、cwd 或 agentPreset 之一' })
			return
		}
		try {
			const created = await ctx.sessionController.create(request)
			record(`session created ${created.sessionId} <- ${clientIp(req)}`)
			sendJson(res, 200, { sessionId: created.sessionId, agentPreset: created.agentPreset ?? null })
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	/**
	 * 权限档位的中文说法。宿主只给预设名（read-only / workspace-write /
	 * danger-full-access），手机上必须说人话 —— 用户要一眼看懂"我现在放开了多少"。
	 * 未来多出未知预设时退回预设名本身，不编造说明。
	 */
	const PERMISSION_TEXT = {
		'read-only': { label: '只读', detail: '能看、能读文件，不能改任何东西。看资料、查代码用这档。' },
		'workspace-write': { label: '可写工作区', detail: '能在项目文件夹里建文件、改文件、跑命令；动到文件夹外面时要问你一次。' },
		'danger-full-access': { label: '完全放开', detail: '整台机器都能改、命令不再逐条问你。只在你盯着它干活时用。' },
	}

	/** 权限服务 + 会话对象（读和写都要这两样）。缺一样就返回一句能懂的原因。 */
	function permissionRig(sessionId) {
		const presets = ctx.get('permissionPresets')
		if (presets === undefined || typeof presets.current !== 'function' || typeof presets.set !== 'function') {
			return { error: '这台电脑上的 DSH 没装权限预设（permissionPresets），手机上改不了权限。' }
		}
		const sessions = ctx.get('sessions')
		if (sessions === undefined || typeof sessions.get !== 'function') {
			return { error: '读不到会话列表，手机上改不了权限。' }
		}
		const session = sessions.get(sessionId)
		if (session === undefined) {
			return { error: '这个会话在电脑上没找到（可能已经关掉了）—— 换一个会话再试。' }
		}
		return { presets, session }
	}

	/** 权限快照：现在哪档 + 所有可选档位（都是纯数据，直接给手机渲染）。 */
	function permissionSnapshot(session, presets) {
		const current = String(presets.current(session) ?? '')
		const options = []
		const append = (value) => {
			if (typeof value !== 'string' || value === '' || options.some((entry) => entry.value === value)) return
			let spec = null
			try { spec = presets.resolve(value) } catch { spec = null }
			const text = PERMISSION_TEXT[value]
			options.push({
				value,
				label: text?.label ?? value,
				detail: text?.detail ?? (spec === null ? '' : `沙箱 ${spec.sandbox} · 审批 ${spec.approval}`),
				sandbox: spec?.sandbox ?? null,
				approval: spec?.approval ?? null,
			})
		}
		for (const name of presets.names) append(name)
		// custom = 沙箱与审批的组合不落在任何预设上（比如在桌面上手动调过某一项）。
		// 仍然摆在列表里，用户才知道"现在这档不是我以为的那档"。
		append(current)
		return { current, options, label: PERMISSION_TEXT[current]?.label ?? current }
	}

	/** 读：这个会话现在允许 agent 做到哪一步。 */
	async function handlePermission(req, res, url) {
		const sessionId = String(url.searchParams.get('sessionId') ?? '')
		if (sessionId === '') { sendJson(res, 400, { error: '缺少 sessionId' }); return }
		const rig = permissionRig(sessionId)
		if (rig.error !== undefined) { sendJson(res, 404, { error: rig.error }); return }
		try {
			sendJson(res, 200, permissionSnapshot(rig.session, rig.presets))
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	/**
	 * 写：切换这个会话的权限档位。
	 *
	 * 这条路走 guardWrite —— 也就是**必须提权**（PIN 门），和 cancel / prompt 一个待遇。
	 * 唯一的例外是"切到只读"：那是收紧，不是放开，手机重新登录一下也无所谓，
	 * 但它不需要额外的证明（用户想赶紧锁上时，多一道门只会拦着好人）。
	 */
	async function handleSetPermission(res, body, req) {
		const sessionId = String(body.sessionId ?? '')
		const preset = String(body.preset ?? '')
		if (sessionId === '' || preset === '') { sendJson(res, 400, { error: '需要 sessionId 与 preset' }); return }
		const rig = permissionRig(sessionId)
		if (rig.error !== undefined) { sendJson(res, 404, { error: rig.error }); return }
		try {
			rig.presets.set(rig.session, preset)
			const snapshot = permissionSnapshot(rig.session, rig.presets)
			record(`permission -> ${snapshot.current} for ${sessionId} <- ${clientIp(req)}`)
			sendJson(res, 200, snapshot)
		} catch (error) {
			sendJson(res, 400, { error: String(error?.message ?? error) })
		}
	}

	/**
	 * Account balance. Cached, and single-flight so two phones opening the tab
	 * at once still produce exactly one upstream call.
	 */
	/**
	 * 启动（或复用）一次上游余额查询。绝不阻塞调用方。
	 */
	function kickBalanceRefresh() {
		if (state.balance.inflight !== null) return state.balance.inflight
		const pending = (async () => {
			const key = await resolveApiKey(ctx)
			if (key.value === '') {
				return { ok: false, reason: 'missing-key', message: `没有找到 ${CRED_REF}，先在桌面端配置 API Key` }
			}
			const result = await queryBalance(key.value)
			return { ...result, keySource: key.source }
		})()
		state.balance.inflight = pending
		pending
			.then((value) => { state.balance.value = value; state.balance.at = Date.now() })
			.catch(() => {})
			.finally(() => { if (state.balance.inflight === pending) state.balance.inflight = null })
		return pending
	}

	async function handleBalance(res, force) {
		const now = Date.now()
		if (!force && state.balance.value !== null && now - state.balance.at < BALANCE_CACHE_MS) {
			sendJson(res, 200, { ...state.balance.value, cached: true, topUpUrl: TOP_UP_URL })
			return
		}
		// 有旧值就先给旧值，后台去刷新 —— 别让手机为一次余额查询干等 15 秒。
		// 上游慢的时候，挂着的请求会把浏览器对同一域名的并发连接占满，于是
		// 连对话都加载不出来（用户看到的就是"又慢又空白"）。
		// 只有显式 refresh=1（用户主动点刷新）或从来没有过值时，才让调用方等。
		if (!force && state.balance.value !== null) {
			kickBalanceRefresh()
			sendJson(res, 200, { ...state.balance.value, cached: true, stale: true, topUpUrl: TOP_UP_URL })
			return
		}
		let value
		try {
			value = await kickBalanceRefresh()
		} catch (error) {
			value = { ok: false, reason: 'internal', message: String(error?.message ?? error) }
		}
		sendJson(res, 200, { ...value, cached: false, topUpUrl: TOP_UP_URL })
	}

	async function handlePrompt(req, res) {
		let body
		try {
			// 这条路上的包最大：手机可能一次发来一段视频（base64 之后再大三分之一）。
			body = await readBody(req, MAX_BODY_BYTES * 4)
		} catch (error) {
			sendJson(res, 413, { error: `请求过大或格式错误: ${String(error?.message ?? error)}` })
			return
		}
		const sessionId = String(body.sessionId ?? '')
		if (sessionId === '') {
			sendJson(res, 400, { error: '缺少 sessionId' })
			return
		}
		const content = []
		const text = String(body.text ?? '').trim()
		if (text !== '') content.push({ type: 'text', text })

		const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES_PER_PROMPT) : []
		for (const image of images) {
			const mediaType = String(image?.mediaType ?? '')
			const data = String(image?.data ?? '')
			if (!IMAGE_TYPES.has(mediaType)) {
				sendJson(res, 400, { error: `不支持的图片类型: ${mediaType}` })
				return
			}
			if (data === '' || data.length > MAX_IMAGE_BASE64) {
				sendJson(res, 400, { error: '图片为空或过大' })
				return
			}
			content.push({
				type: 'image',
				mediaType,
				data,
				...(typeof image?.name === 'string' && image.name !== '' ? { name: image.name } : {}),
			})
		}

		// 图片以外的任何东西（视频、PDF、宿主不认的图片格式…）都落到磁盘上，
		// 把路径写进任务里 —— 模型本身"看"不了视频，但 agent 能用工具去处理它。
		const savedFiles = []
		// (a) 已经分片传完的：手机只发路径，请求体很小（大文件必须走这条）。
		const refs = Array.isArray(body.fileRefs) ? body.fileRefs.slice(0, MAX_FILES_PER_PROMPT) : []
		for (const entry of refs) {
			const path = safeUploadRef(entry?.path)
			if (path === null) { sendJson(res, 400, { error: '文件引用不在上传目录里，已拒绝' }); return }
			try {
				await stat(path)
			} catch {
				sendJson(res, 400, { error: `文件不存在（可能上传没完成）: ${path}` })
				return
			}
			savedFiles.push({ name: safeUploadName(String(entry?.name ?? 'file')), mediaType: String(entry?.mediaType ?? ''), path })
		}
		// (b) 小文件仍然可以随任务一起带过来（一次请求搞定，少一次往返）。
		const incoming = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES_PER_PROMPT) : []
		for (const entry of incoming) {
			const name = safeUploadName(String(entry?.name ?? 'file'))
			const data = String(entry?.data ?? '')
			if (data === '') { sendJson(res, 400, { error: `文件为空: ${name}` }); return }
			if (data.length > MAX_FILE_BASE64) {
				sendJson(res, 413, { error: `${name} 太大，请用分片上传（手机上会自动走这条路）` })
				return
			}
			try {
				const saved = await saveUpload({ name, mediaType: String(entry?.mediaType ?? ''), data })
				savedFiles.push(saved)
			} catch (error) {
				sendJson(res, 500, { error: `保存 ${name} 失败: ${String(error?.message ?? error)}` })
				return
			}
		}
		const fileNote = describeSavedFiles(savedFiles)
		if (fileNote !== '') content.push({ type: 'text', text: fileNote })

		if (content.length === 0) {
			sendJson(res, 400, { error: '内容为空' })
			return
		}

		try {
			// requestId 要回给手机：DSH 会把同一份 rpcId 放进 `agent/inbox/spliced`
			// 事件，手机靠它对上"我刚发的那句" —— 于是能显示"排队中"并给出撤回按钮。
			//
			// 手机可以自己带一个 id（重试时复用同一个）：DSH 对同一个 requestId 是
			// **幂等**的（`hasPromptRequest` 直接返回 accepted），所以"网络抖一下自动重试"
			// 不会变成两条消息。
			const supplied = String(body.requestId ?? '')
			const requestId = /^[A-Za-z0-9-]{8,64}$/.test(supplied) ? supplied : randomUUID()
			const accepted = await ctx.sessionController.prompt(
				{
					requestId,
					sessionId,
					mode: 'queue',
					content,
					clientTimeZone: 'Asia/Shanghai',
				},
				AbortSignal.timeout(30000),
			)
			log(`prompt accepted for ${sessionId} (${images.length} image(s), ${savedFiles.length} file(s), ${text.length} char(s))`)
			sendJson(res, 200, {
				accepted: accepted.accepted === true,
				requestId,
				files: savedFiles.map((entry) => entry.name),
			})
			return
		} catch (error) {
			const message = String(error?.message ?? error)
			record(`prompt rejected for ${sessionId}: ${message}`)

			// 图片这条路被宿主拒了（最常见的元凶是**动图**：宿主解码多帧图会失败）。
			// 别让用户干瞪眼：把图也存成文件、用路径再发一次，任务照样能下去。
			if (images.length > 0 && !isUnfollowable(message)) {
				try {
					const rescued = []
					for (const image of images) {
						const name = safeUploadName(String(image?.name ?? `image-${rescued.length + 1}`))
						rescued.push(await saveUpload({ name, mediaType: String(image?.mediaType ?? ''), data: String(image?.data ?? '') }))
					}
					const retryContent = content.filter((entry) => entry.type !== 'image')
					const note = describeSavedFiles(rescued)
					if (note !== '') retryContent.push({ type: 'text', text: note })
					const retryId = randomUUID()
					const accepted = await ctx.sessionController.prompt(
						{
							requestId: retryId,
							sessionId,
							mode: 'queue',
							content: retryContent,
							clientTimeZone: 'Asia/Shanghai',
						},
						AbortSignal.timeout(30000),
					)
					record(`prompt retried as files for ${sessionId} (${rescued.length} saved)`)
					sendJson(res, 200, {
						accepted: accepted.accepted === true,
						requestId: retryId,
						files: rescued.map((entry) => entry.name),
						degraded: true,
					})
					return
				} catch (retryError) {
					record(`prompt retry failed for ${sessionId}: ${String(retryError?.message ?? retryError)}`)
				}
			}

			// 子会话（agent 自己派生的）也收不了手机发来的消息，处理方式和"跟随失败"一致：
			// 标记 + 从列表里拿掉，页面就能说"这个会话在手机上打不开"，而不是干巴巴一句失败。
			const unsupported = isUnfollowable(message)
			if (unsupported) state.unfollowable.add(sessionId)
			sendJson(res, unsupported ? 409 : 500, unsupported
				? { error: message, unsupported: true }
				: { error: message })
		}
	}

	/**
	 * 分片上传：手机把大文件切成小片，一片一个请求。
	 *
	 * 不这么做就发不了大文件 —— 隧道入口会掐断"慢而大"的请求（实测 IPv6 入口
	 * 16 MB 回 408、6.7 MB 要 89 秒），手机上行更慢，一整块必死。每片 384 KB，
	 * 单次请求 ~512 KB，慢链路也就几秒。
	 *
	 * 安全：只在 ~/.dsh/mobile-uploads/ 下写；片名由服务端生成（uploadId 只许
	 * [A-Za-z0-9_-]），文件名照旧过 safeUploadName，`..` 没有落脚点。
	 */
	async function handleUpload(req, res) {
		let body
		try {
			body = await readBody(req, 2 * 1024 * 1024)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const uploadId = String(body.uploadId ?? '')
		const index = Number(body.index)
		const total = Number(body.total)
		const name = safeUploadName(String(body.name ?? 'file'))
		const data = String(body.data ?? '')
		if (/^[A-Za-z0-9_-]{1,40}$/.test(uploadId) === false) { sendJson(res, 400, { error: 'bad uploadId' }); return }
		if (Number.isSafeInteger(index) === false || Number.isSafeInteger(total) === false) { sendJson(res, 400, { error: 'bad index' }); return }
		if (total < 1 || total > MAX_UPLOAD_CHUNKS || index < 0 || index >= total) { sendJson(res, 400, { error: 'bad range' }); return }
		if (data === '') { sendJson(res, 400, { error: 'empty chunk' }); return }
		const bytes = Buffer.from(data, 'base64')
		if (bytes.length > UPLOAD_CHUNK_BYTES + 1024) { sendJson(res, 413, { error: 'chunk too large' }); return }

		const dir = uploadsDir()
		await mkdir(dir, { recursive: true })
		const partFile = join(dir, `.part-${uploadId}`)
		try {
			if (index === 0) await writeFile(partFile, bytes)
			else await appendFile(partFile, bytes)
		} catch (error) {
			sendJson(res, 500, { error: `写入失败: ${String(error?.message ?? error)}` })
			return
		}
		const written = (await stat(partFile)).size
		if (written > MAX_UPLOAD_BYTES) {
			await unlink(partFile).catch(() => {})
			sendJson(res, 413, { error: `文件太大（上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB）` })
			return
		}
		if (index < total - 1) {
			sendJson(res, 200, { ok: true, received: index + 1, total, bytes: written })
			return
		}
		// 最后一片：改名成正式文件，把路径交回手机（它随后放进 fileRefs）。
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
		const target = join(dir, `${stamp}-${randomBytes(2).toString('hex')}-${name}`)
		try {
			await rename(partFile, target)
		} catch (error) {
			sendJson(res, 500, { error: `收尾失败: ${String(error?.message ?? error)}` })
			return
		}
		record(`upload saved: ${target} (${written} bytes, ${total} chunks)`)
		sendJson(res, 200, { ok: true, done: true, name, mediaType: String(body.mediaType ?? ''), path: target, bytes: written })
	}

	/**
	 * 手机界面的背景：用户挑的那段视频/图片，从上传目录里原样发出去。
	 *
	 * 必须支持 Range —— iOS Safari 放视频会先发一个 `Range: bytes=0-1` 试探，
	 * 只回 200 的话它可能直接不播。ETag 用文件的 mtime+size，手机第二次打开就走
	 * 304，不用把几 MB 再下一遍（移动网络下这很值钱）。
	 */
	/**
	 * 换手机界面的背景（也能清掉）。`name` 只能是上传目录里的文件名。
	 *
	 * 为什么要这个接口：以前换背景得「把文件发进某个会话 → 让 agent 把文件名写进
	 * `~/.dsh/mobile-bridge.json` 的 `backgroundFile` → 重载插件」——那是我干的活，
	 * 不是用户干的活。现在手机自己选一张图 / 动图 / 视频就能换。
	 *
	 * 只改 `backgroundFile` **这一个键**：同一个文件里还有 publicUrl（隧道脚本每次
	 * 重启都会改写它）、crashProbe 等别人管的字段，整份按内存重写会把它们覆盖回旧值。
	 */
	async function saveBackgroundName(name) {
		const file = join(dshHome(), CONFIG_FILE)
		let stored = {}
		try {
			stored = JSON.parse(await readFile(file, 'utf8'))
		} catch {
			stored = {}
		}
		if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) stored = {}
		if (name === '') delete stored.backgroundFile
		else stored.backgroundFile = name
		await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
		if (name === '') delete state.config.backgroundFile
		else state.config.backgroundFile = name
	}

	async function handleSetBackground(req, res) {
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		if (body?.clear === true) {
			await saveBackgroundName('')
			sendJson(res, 200, { ok: true, background: null })
			return
		}
		// ⚠️ 手机上传完之后手上有两样东西：`name` 是**手机上的原始文件名**，
		// `path` 是服务端存盘后的真实路径（文件名带了时间戳+随机前缀）。
		// 只认 `name` 就会去找一个根本不存在的文件 → "这个文件不在了，重新上传一次"。
		// （同学报的"换背景失效"就是这个。）两个都收，但一律走目录校验。
		const fromPath = String(body?.path ?? '')
		const path = safeUploadRef(fromPath !== '' ? fromPath : join(uploadsDir(), String(body?.name ?? '')))
		if (path === null) { sendJson(res, 400, { error: '背景只能从上传目录里挑' }); return }
		let info
		try {
			info = await stat(path)
		} catch {
			sendJson(res, 404, { error: '这个文件不在了，重新上传一次' })
			return
		}
		if (info.size === 0) { sendJson(res, 400, { error: '文件是空的' }); return }
		const mediaType = mediaTypeOf(path)
		if (mediaType.startsWith('image/') === false && mediaType.startsWith('video/') === false) {
			sendJson(res, 400, {
				error: `背景只能是图片 / 动图 / 视频，这个是 ${mediaType === '' ? '未知类型' : mediaType}`,
			})
			return
		}
		// 配置里记的是**磁盘上的文件名**（backgroundInfo 就是拿它 join 上传目录的）。
		await saveBackgroundName(path.split(sep).pop() ?? 'background')
		sendJson(res, 200, { ok: true, background: backgroundInfo() })
	}

	async function handleBackground(req, res) {
		const name = typeof state.config?.backgroundFile === 'string' ? state.config.backgroundFile : ''
		if (name === '') { sendJson(res, 404, { error: 'no background' }); return }
		const path = safeUploadRef(join(uploadsDir(), name))
		if (path === null) { sendJson(res, 404, { error: 'no background' }); return }
		let info
		try {
			info = await stat(path)
		} catch {
			sendJson(res, 404, { error: 'no background' }); return
		}
		const mediaType = mediaTypeOf(path) || 'application/octet-stream'
		const etag = `"bg-${info.size}-${Math.round(info.mtimeMs)}"`
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304, { ...SECURITY_HEADERS, etag })
			res.end()
			return
		}
		const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
		if (range !== null) {
			const start = range[1] === '' ? Math.max(0, info.size - Number(range[2] ?? 0)) : Number(range[1])
			const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
			if (Number.isFinite(start) === false || Number.isFinite(end) === false || start > end || start >= info.size) {
				res.writeHead(416, { ...SECURITY_HEADERS, 'content-range': `bytes */${info.size}` })
				res.end()
				return
			}
			res.writeHead(206, {
				...SECURITY_HEADERS,
				'content-type': mediaType,
				'content-length': end - start + 1,
				'content-range': `bytes ${start}-${end}/${info.size}`,
				'accept-ranges': 'bytes',
				etag,
				'cache-control': 'private, max-age=3600',
			})
			createReadStream(path, { start, end }).pipe(res)
			return
		}
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': mediaType,
			'content-length': info.size,
			'accept-ranges': 'bytes',
			etag,
			'cache-control': 'private, max-age=3600',
		})
		createReadStream(path).pipe(res)
	}

	/**
	 * 撤回一条还没开始处理的排队消息（手机上的「撤回」按钮）。
	 *
	 * DSH 的 `updateQueue` 支持 `{kind:'remove'}`：只要那条还在队列里就真能拿掉。
	 * 已经开始跑了就撤不回来 —— 这时候如实说清楚（409），别假装成功。
	 */
	async function handleRecall(req, res) {
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const sessionId = String(body.sessionId ?? '')
		const itemId = String(body.itemId ?? '')
		if (sessionId === '' || itemId === '') { sendJson(res, 400, { error: '缺少 sessionId 或 itemId' }); return }
		try {
			await ctx.sessionController.updateQueue(
				{ sessionId, itemId, action: { kind: 'remove' } },
				AbortSignal.timeout(15000),
			)
			record(`queue item ${itemId} removed from ${sessionId}`)
			sendJson(res, 200, { ok: true })
		} catch (error) {
			const message = String(error?.message ?? error)
			record(`queue remove failed for ${sessionId}/${itemId}: ${message}`)
			const gone = /queue-item-not-found|not found|no longer pending/i.test(message)
			sendJson(res, gone ? 409 : 500, {
				error: gone ? '这条已经开始处理了，撤不回来了' : message,
			})
		}
	}

	/** 手机的"说明页看过了"记到服务端（按**设备**），换地址/无痕也不会重复弹。 */
	async function handleWelcomeSeen(req, res) {
		const key = deviceId(req, res)
		if (key !== '') {
			// 存**版本号**（不是时间戳）：说明内容改版后能按版本再讲一遍。
			state.welcomed.set(key, WELCOME_VERSION)
			persistTokens()
		}
		sendJson(res, 200, { ok: true })
	}

	/* ------------------------------------------- 装成 App（PWA）要的那几样东西 */

	/**
	 * 「添加到主屏幕」用的一套：manifest + 图标 + service worker。
	 *
	 * iPhone 上装不了原生 App（要 Mac + 开发者账号，而且 App Store 上架），但
	 * **PWA 不需要商店**：Safari 里「分享 → 添加到主屏幕」之后，图标、全屏、启动
	 * 图、离线可用全都有，用起来和 App 没差别。这也正是用户能拿到的最接近"装个 App"
	 * 的办法。图标是 tools/make-icons.mjs 生成的真 PNG（iOS 不认 SVG 图标）。
	 */
	const ICON_FILES = new Set(['icon-180.png', 'icon-192.png', 'icon-512.png'])

	function handleManifest(res) {
		const body = JSON.stringify({
			name: 'DSH 手机桥',
			short_name: '手机桥',
			description: '在手机上驱动你电脑上的 DeepSeek Harness：发图/发视频、下任务、看实时进度、存素材。',
			start_url: './',
			scope: './',
			display: 'standalone',
			orientation: 'portrait',
			background_color: '#0b1220',
			theme_color: '#0b1220',
			icons: [
				{ src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
				{ src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
			],
		}, null, '\t')
		const buffer = Buffer.from(body, 'utf8')
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': 'application/manifest+json; charset=utf-8',
			'content-length': buffer.length,
			'cache-control': 'private, max-age=600',
		})
		res.end(buffer)
	}

	function handleIcon(req, res, url) {
		const name = url.pathname.split('/').pop() ?? ''
		if (ICON_FILES.has(name) === false) { sendJson(res, 404, { error: 'no such icon' }); return }
		let bytes
		try {
			bytes = readFileSync(join(HERE, 'icons', name))
		} catch {
			sendJson(res, 404, { error: 'icon missing' }); return
		}
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': 'image/png',
			'content-length': bytes.length,
			'cache-control': 'private, max-age=86400',
		})
		res.end(bytes)
	}

	/**
	 * Service worker：只为一件事 —— 让"从主屏幕点开"这一步**不用等网络**。
	 * 页面本身走 network-first（page tag 靠它自重载，绝不能吃旧缓存），
	 * 图标走 cache-first；`/api/*` 一律不碰（那是实时数据）。断网时给一张缓存的壳。
	 */
	const SERVICE_WORKER = `const CACHE = 'dshm-shell-v2'
const SHELL = ['./', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']
self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (event) => {
	event.waitUntil(caches.keys()
		.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
		.then(() => self.clients.claim()))
})
self.addEventListener('fetch', (event) => {
	const request = event.request
	if (request.method !== 'GET') return
	let url
	try { url = new URL(request.url) } catch { return }
	if (url.origin !== self.location.origin) return
	if (url.pathname.includes('/api/') || url.pathname.endsWith('/sw.js')) return
	if (request.mode === 'navigate') {
		// 页面：**先网络、缓存只兜断网**。
		//
		// 这里曾经是"有缓存就先给缓存"（后台再更新缓存），也就是**实际上 cache-first** ——
		// 与注释里写的"绝不能吃旧缓存"正好相反。后果不是"慢一点"，而是
		// **改了手机页面，用户在手机上刷新也永远看不到**：旧 HTML 一直在跑。
		// 现场：2026-10-08 修好"工具结果里的图不显示"（1.3.7）之后，用户刷新仍然是老样子，
		// 因为 Service Worker 一直把上一版页面递给他。所以这里必须是"网络优先"：
		// 只有网络真失败（断网/桥没起来）才拿缓存里那张壳。
		event.respondWith(fetch(request).then((response) => {
			if (response.ok === true) {
				const copy = response.clone()
				caches.open(CACHE).then((cache) => cache.put('./', copy)).catch(() => {})
			}
			return response
		}).catch(() => caches.match('./').then((hit) => hit ?? Response.error())))
		return
	}
	if (/\\/icon-\\d+\\.png$|\\/manifest\\.webmanifest$/.test(url.pathname)) {
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
			const copy = response.clone()
			caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
			return response
		})))
	}
})
`

	function handleServiceWorker(res) {
		const buffer = Buffer.from(SERVICE_WORKER, 'utf8')
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': 'text/javascript; charset=utf-8',
			'content-length': buffer.length,
			'cache-control': 'no-cache',
			// 允许它在密钥段这一层生效（脚本自己就在那个目录下，属保险）。
			'service-worker-allowed': secretSuffix(state.config),
		})
		res.end(buffer)
	}

	async function handleCancel(req, res) {		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		try {
			const value = await ctx.sessionController.cancel({ sessionId: String(body.sessionId ?? '') })
			sendJson(res, 200, { accepted: value.accepted === true })
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	async function handleAttachment(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		const attachmentId = url.searchParams.get('attachmentId') ?? ''
		try {
			const value = await ctx.sessionController.attachment({ sessionId, attachmentId })
			sendJson(res, 200, { mediaType: value.attachment.mediaType, data: value.data })
		} catch (error) {
			// The detail goes to the log, never to the caller: it can carry absolute
			// paths from inside the harness, and handing those to a remote peer is a
			// free map of the machine.
			warn(`attachment lookup failed: ${String(error?.message ?? error)}`)
			sendJson(res, 404, { error: 'attachment not found' })
		}
	}

	/**
	 * 附件走**真正的二进制 URL**（`/api/media`）。
	 *
	 * 为什么要多这一个接口：以前页面把附件取成 base64 再拼成 `data:` URI。iOS Safari
	 * 对 `data:` 图片**不给"存储到照片"**（长按只有"拷贝"），用户的诉求恰恰是"把电脑
	 * 给的素材存进手机相册"。真 URL 才长按可存，而且顺带省掉了 base64 那 33% 膨胀。
	 */
	async function handleMedia(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		const attachmentId = url.searchParams.get('attachmentId') ?? ''
		if (sessionId === '' || attachmentId === '') { sendJson(res, 400, { error: '缺少参数' }); return }
		let value
		try {
			value = await ctx.sessionController.attachment({ sessionId, attachmentId })
		} catch (error) {
			warn(`media lookup failed: ${String(error?.message ?? error)}`)
			sendJson(res, 404, { error: 'attachment not found' })
			return
		}
		const mediaType = String(value?.attachment?.mediaType ?? 'application/octet-stream')
		let bytes
		try {
			bytes = Buffer.from(String(value?.data ?? ''), 'base64')
		} catch {
			sendJson(res, 500, { error: 'attachment decode failed' })
			return
		}
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': mediaType,
			'content-length': bytes.length,
			'cache-control': 'private, max-age=3600',
		})
		res.end(bytes)
	}

	/**
	 * 把电脑上的一张图/一段视频发给手机：`/api/file?path=<绝对路径>`。
	 *
	 * 场景：agent 在电脑上做了素材（`image_generate` 的图、脚本截的图、导出的视频），
	 * 对话里只有一行路径 —— 手机上看不到，也没法存。这个接口让那些路径变成真图片。
	 *
	 * 只发**图片/视频**，而且必须在桥认识的目录里（工作区、会话目录、~/.dsh、
	 * 临时目录）。否则它就成了"任意文件读取"，那不是一个手机控制台该有的能力。
	 */
	async function handleFile(req, res, url) {
		const requested = String(url.searchParams.get('path') ?? '')
		if (requested === '') { sendJson(res, 400, { error: '缺少 path' }); return }
		let path
		try {
			path = resolve(requested)
		} catch {
			sendJson(res, 400, { error: 'bad path' }); return
		}
		// 类型按**内容**认（扩展名经常骗人，见 sniffBytes），认不出才看扩展名。
		const mediaType = mediaTypeOf(path)
		if (mediaType === '') { sendJson(res, 415, { error: '只支持图片和视频' }); return }
		if (isServablePath(path) === false) { sendJson(res, 403, { error: '这个路径不在允许的目录里' }); return }
		let info
		try {
			info = await stat(path)
		} catch {
			sendJson(res, 404, { error: '文件不存在' }); return
		}
		if (info.isFile() !== true) { sendJson(res, 404, { error: '不是文件' }); return }
		if (info.size > MAX_SERVED_FILE_BYTES) { sendJson(res, 413, { error: '文件太大' }); return }
		const etag = `"file-${info.size}-${Math.round(info.mtimeMs)}"`
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304, { ...SECURITY_HEADERS, etag })
			res.end()
			return
		}
		const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
		if (range !== null) {
			const start = range[1] === '' ? Math.max(0, info.size - Number(range[2] ?? 0)) : Number(range[1])
			const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
			if (Number.isFinite(start) === false || Number.isFinite(end) === false || start > end || start >= info.size) {
				res.writeHead(416, { ...SECURITY_HEADERS, 'content-range': `bytes */${info.size}` })
				res.end()
				return
			}
			res.writeHead(206, {
				...SECURITY_HEADERS,
				'content-type': mediaType,
				'content-length': end - start + 1,
				'content-range': `bytes ${start}-${end}/${info.size}`,
				'accept-ranges': 'bytes',
				etag,
				'cache-control': 'private, max-age=600',
			})
			createReadStream(path, { start, end }).pipe(res)
			return
		}
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': mediaType,
			'content-length': info.size,
			'accept-ranges': 'bytes',
			etag,
			'cache-control': 'private, max-age=600',
		})
		createReadStream(path).pipe(res)
	}

	/**
	 * 把一条记录里的超长字符串截断。工具输出（一条命令几十 KB）是大头。
	 * 带深度上限，防止意外的循环引用把递归卡死。
	 */
	function shrinkRecord(value, depth = 0) {
		if (typeof value === 'string') {
			return value.length > SNAPSHOT_TEXT_LIMIT
				? `${value.slice(0, SNAPSHOT_TEXT_LIMIT)}\n…（已截断，原文 ${value.length} 字；完整内容在电脑上看）`
				: value
		}
		if (Array.isArray(value)) {
			if (depth > 12) return []
			return value.map((item) => shrinkRecord(item, depth + 1))
		}
		if (value !== null && typeof value === 'object') {
			if (depth > 12) return null
			const out = {}
			for (const [key, item] of Object.entries(value)) out[key] = shrinkRecord(item, depth + 1)
			return out
		}
		return value
	}

	/**
	 * 把快照压到预算之内：先截断超长文本，再从【最旧的】开始丢，直到整包够小。
	 * 手机上看到的是最近的对话，而不是九兆历史的开头。
	 *
	 * `trimEvent` 必须先过一遍：`assistant/message` 的 `data.stream` 里装着这条消息
	 * 已经逐字推过的全部增量，**是一堆短字符串**（不是超长文本），所以 shrinkRecord
	 * 的 4000 字截断对它完全无效。实测一条这样的记录能让 /api/transcript 回 782 KB
	 * —— 正好把这个接口存在的理由（别让手机收到大包）又踩回去。
	 */
	function fitSnapshot(records) {
		const shrunk = Array.isArray(records)
			? records.map((entry) => {
				const trimmed = entry?.type === 'event' ? { ...entry, event: trimEvent(entry.event) } : entry
				return shrinkRecord(trimmed)
			})
			: []
		let from = 0
		let bytes = JSON.stringify(shrunk).length
		while (bytes > SNAPSHOT_BUDGET_BYTES && from < shrunk.length - 1) {
			bytes -= JSON.stringify([shrunk[from]]).length - 2   // 减去这条加它前后逗号的近似长度
			from += 1
		}
		const kept = shrunk.slice(from)
		return { records: kept, dropped: from, bytes: JSON.stringify(kept).length }
	}

	/**
	 * 用一次【普通请求】把最近的对话取回去。
	 *
	 * 为什么必须有它：有些通道会把大响应缓冲住，直到有更多数据把它冲出来。
	 * 实测症状 —— 手机打开页面一片空白，**直到电脑那边发了一条新消息**，快照才跟着
	 * 冲出来。SSE 的初始快照是 200 多 KB 的一次性写入，正好踩这个坑；而 bootstrap
	 * 这种普通请求从来都是立刻送达的。所以初始对话走这里，实时增量仍走 SSE：
	 * 能推就推，推不动也不至于什么都看不见。
	 */
	/** 取一份裁过的对话快照（`/api/transcript` 与 `/api/boot` 共用）。 */
	async function buildTranscript(sessionId, signal) {
		const controller = new AbortController()
		const stop = () => controller.abort()
		if (signal !== undefined) {
			if (signal.aborted) controller.abort()
			else signal.addEventListener('abort', stop, { once: true })
		}
		const empty = () => ({ pageTag: state.pageTag, cursor: 0, hasMore: false, records: [] })
		let timedOut = false
		const timer = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
		try {
			const frames = ctx.sessionController.follow(
				{ address: { kind: 'session', sessionId }, maxMessages: SNAPSHOT_MAX_MESSAGES, assistantStream: false },
				controller.signal,
			)
			for await (const frame of frames) {
				if (frame.type !== 'snapshot') continue
				const fitted = fitSnapshot(frame.records)
				return {
					pageTag: state.pageTag,
					cursor: frame.cursor,
					hasMore: frame.hasMore === true || fitted.dropped > 0,
					records: fitted.records,
				}
			}
			return empty()
		} catch (error) {
			const message = String(error?.message ?? error)
			// 子会话打不开不算"出错"：给手机一个明确的 unsupported，让它说人话。
			if (isUnfollowable(message)) {
				state.unfollowable.add(sessionId)
				return { ...empty(), unsupported: true, reason: message }
			}
			// 自己掐的 15 秒表不算"出错"：给一个空快照，页面本来就会忽略空结果。
			if (timedOut) return empty()
			throw error
		} finally {
			clearTimeout(timer)
			if (signal !== undefined) signal.removeEventListener('abort', stop)
			controller.abort()
		}
	}

	/**
	 * `since=` 的解析：只接受非负整数，别的（空、乱写、负数、小数）一律当没带。
	 * @returns {number|null}
	 */
	function parseSince(raw) {
		if (raw === null || raw === undefined || raw === '') return null
		const value = Number(raw)
		return Number.isInteger(value) && value >= 0 ? value : null
	}

	/**
	 * 客户端说"我手上已经有到 since 为止的内容" → 只回它没见过的记录。
	 *
	 * 为什么值得做：手机切到别的会话再切回来，原来要把整段对话（实测 40 KB gzip、
	 * 隧道上好几秒）重下一遍 —— 而这份内容刚刚还在屏幕上。带上序号之后，通常一条
	 * 都不用发；用户感觉到的差别是"秒开"和"又转圈"。
	 *
	 * 安全性（宁可多发，绝不能少发）：只有当 since 落在本份快照的序号范围内时才敢裁剪。
	 * 客户端比快照里最旧的记录还旧（页面放了很久、历史被裁掉或被压缩重排过）时，
	 * 它缺的那一段谁也补不上 —— 那就老实回整段。
	 *
	 * @returns {{ records: unknown[], partial: boolean }} partial=true 表示"这只是增量"。
	 */
	function sliceSince(records, cursor, since) {
		if (since === null || typeof cursor !== 'number' || since > cursor) return { records, partial: false }
		const seqs = []
		for (const record of records) {
			const seq = record?.event?.seq ?? record?.seq
			if (typeof seq === 'number') seqs.push(seq)
		}
		if (seqs.length === 0) return { records, partial: false }
		const oldest = Math.min(...seqs)
		// 客户端比我们能给的最旧记录还旧 → 中间那段补不上，回整段。
		if (since < oldest - 1) return { records, partial: false }
		return { records: records.filter((record) => (record?.event?.seq ?? 0) > since), partial: true }
	}

	async function handleTranscript(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		if (sessionId === '') { sendJson(res, 400, { error: '缺少 sessionId' }); return }
		const since = parseSince(url.searchParams.get('since'))
		// 手机切走 / 关掉页面时，这次请求就没人在听了。往一条已经断掉的 socket 上
		// writeHead 会抛，而这里抛在 await 之外就是进程级 uncaught —— 和 handleStream
		// 里那个坑是同一个，代价都是整台 DSH 倒下。所以每次写之前先确认还活着。
		const alive = () => res.writableEnded !== true && res.destroyed !== true
		const controller = new AbortController()
		// 监听 res 而不是 req：res 的 close 只会在这条响应真的收尾之后才响，
		// 而 req 的 close 在普通 GET 上可能早于我们的异步读取，会把功能整个掐掉。
		res.on('error', () => controller.abort())
		res.on('close', () => controller.abort())
		try {
			const payload = await buildTranscript(sessionId, controller.signal)
			if (!alive()) return
			// 带了 since 且手上确实有内容 → 只回新记录（平时一条都没有）。
			if (since !== null && Array.isArray(payload.records)) {
				const sliced = sliceSince(payload.records, payload.cursor ?? 0, since)
				if (sliced.partial === true) {
					payload.partial = true
					payload.records = sliced.records
				}
			}
			sendJson(res, 200, payload)
		} catch (error) {
			if (!alive()) return
			if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	/** Server-sent events over one Session's durable log. */
	async function handleStream(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		if (sessionId === '') {
			sendJson(res, 400, { error: '缺少 sessionId' })
			return
		}
		// `since=` —— 客户端说"我手上已经有到这个序号为止的内容了"。
		const since = parseSince(url.searchParams.get('since'))
		// Refuse BEFORE the 200. Announcing a stream and then hanging up looks
		// exactly like a broken connection and is miserable to diagnose.
		if (state.streams.size >= MAX_LIVE_STREAMS) {
			record(`stream refused: ${state.streams.size} already live`)
			sendJson(res, 503, { error: 'too many live streams' })
			return
		}
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		})
		res.write(': connected\n\n')

		const controller = new AbortController()
		// sessionId 留在 entry 上：agent 提问时要推给【正在看这个会话】的手机，
		// 推错会话比不推更糟（用户会在一个无关的对话里看到别人的提问）。
		const entry = { res, controller, sessionId }
		state.streams.add(entry)

		// `res.write` on an ended response does NOT throw — it emits an
		// asynchronous 'error' event, and an unhandled one takes the whole Node
		// process down. That is exactly how a plugin reload (which ends every
		// stream) used to kill the running DSH, so both halves are needed:
		// an 'error' listener, and a guard before every write.
		res.on('error', () => controller.abort())
		req.on('close', () => controller.abort())

		const writable = () => controller.signal.aborted !== true && res.writableEnded !== true && res.destroyed !== true

		const keepAlive = setInterval(() => {
			if (!writable()) return
			// 必须是【真数据帧】，不能只是 `: ping` 注释：注释走不到 EventSource 的
			// onmessage，手机就分不清"这个会话本来就没动静"和"连接已经半死"。
			// 电脑睡眠时 onerror 往往不响，只有这个心跳能证明对面还在说话。
			try { res.write(`data: ${JSON.stringify({ t: 'ping', at: Date.now() })}\n\n`) } catch { controller.abort() }
		}, 20000)

		const write = (payload) => {
			if (!writable()) return
			try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { controller.abort() }
		}
		// 广播提问/审批时要隔着 entry 拿到它自己的 write（每个流一个闭包）。
		entry.write = write

		// 还没答的提问要补推一次。提问只在发生时推一次，手机刷新一下就再也看不到了 ——
		// 而宿主仍在傻等，用户则以为"agent 卡住了"。
		for (const waiter of state.pending.values()) {
			if (waiter.sessionId !== sessionId) continue
			write({ t: 'interaction', kind: waiter.kind, id: waiter.id, payload: waiter.payload })
		}

		try {
			const frames = ctx.sessionController.follow(
				{ address: { kind: 'session', sessionId }, maxMessages: SNAPSHOT_MAX_MESSAGES, assistantStream: true },
				controller.signal,
			)
			for await (const frame of frames) {
				if (!writable()) break
				if (frame.type === 'snapshot') {
					// 绝不把整段历史原样塞给手机：压到预算内，必要时丢掉最旧的记录。
					const fitted = fitSnapshot(frame.records)
					// 客户端带了 since=（它手上已经有到那儿为止的内容）→ 只补新的。
					const sliced = sliceSince(fitted.records, frame.cursor ?? 0, since)
					write({
						t: 'snapshot',
						tag: state.pageTag,
						cursor: frame.cursor,
						hasMore: frame.hasMore === true || fitted.dropped > 0,
						records: sliced.records,
						// 明确告诉页面"这只是增量，别拿它当成整段" —— 页面据此只追加，
						// 不清空重建（否则历史会被这份只有新记录的快照抹掉）。
						partial: sliced.partial === true ? true : undefined,
					})
				} else if (frame.type === 'event') {
					write({ t: 'event', event: trimEvent(frame.event) })
				} else if (frame.type === 'assistant-stream') {
					write({ t: 'delta', frame: frame.frame })
				}
			}
			write({ t: 'end' })
		} catch (error) {
			const message = String(error?.message ?? error)
			const unsupported = isUnfollowable(message)
			if (unsupported) state.unfollowable.add(sessionId)
			if (!controller.signal.aborted) {
				// unsupported=true 是给页面看的明确信号：这不是网络断了，是这个会话
				// 本身在手机上打不开，别弹"地址已失效"，也别每三秒重连一次。
				write(unsupported ? { t: 'error', message, unsupported: true } : { t: 'error', message })
			}
		} finally {
			clearInterval(keepAlive)
			state.streams.delete(entry)
			try { if (res.writableEnded !== true) res.end() } catch { /* closed */ }
		}
	}

	/* ------------------------------------------------- 提问 / 审批（手机作答） */

	/** 正在看某个会话的手机流。空数组 = 没人在看。 */
	function watchersOf(sessionId) {
		const list = []
		for (const entry of state.streams) {
			if (entry.sessionId === sessionId && typeof entry.write === 'function') list.push(entry)
		}
		return list
	}

	/** 把一帧推给正在看这个会话的所有手机流。 */
	function pushToSession(sessionId, payload) {
		for (const entry of watchersOf(sessionId)) entry.write(payload)
	}

	/**
	 * 挂起一个等待手机回答的交互。
	 *
	 * 返回 null = "这次不该由手机答"（功能没开 / 没人看这个会话 / 队列已满），
	 * 调用方必须立刻 next() 让桌面接手 —— 这是保证【桌面体验一点不变】的关键。
	 * 返回 Promise = 已经推给手机了，等它回答；超时或请求被取消则 fallthrough。
	 */
	function askPhone(kind, sessionId, payload, signal) {
		if (state.config?.answerOnPhone !== true) return null
		if (sessionId === '') return null
		if (state.pending.size >= MAX_PENDING_INTERACTIONS) {
			warn(`refusing to queue another ${kind}: ${state.pending.size} already pending`)
			return null
		}
		const watchers = watchersOf(sessionId)
		if (watchers.length === 0) return null

		const id = randomBytes(9).toString('base64url')
		let settle = () => {}
		const promise = new Promise((resolve) => { settle = resolve })
		// 变量名【不能】叫 record —— 那会遮蔽同作用域里的日志函数 record()，
		// 于是这一行下面的 record(...) 变成 TypeError 把宿主打死。这个坑踩过一次了。
		// id/payload 也存在 waiter 上：手机刷新或重连时要把没答的提问补推一次。
		const waiter = { id, kind, sessionId, payload, timer: null, answer: null, cancel: null }

		const finish = (outcome) => {
			if (state.pending.get(id) !== waiter) return
			state.pending.delete(id)
			if (waiter.timer !== null) { clearTimeout(waiter.timer); waiter.timer = null }
			if (signal !== undefined) signal.removeEventListener('abort', onAbort)
			// 让其余手机把这张卡片撤掉（超时、被别的手机答了、或请求已取消）。
			pushToSession(sessionId, { t: 'interaction-end', id })
			settle(outcome)
		}
		// 取消和超时是两件事，必须分开：
		//   超时 → 用户可能只是没看手机，交给桌面接着问；
		//   取消 → agent 已经放弃了（用户按了停止、会话结束），这时候再去 next()
		//          会让桌面弹出一个【已经作废】的批准框，用户点了也毫无意义。
		const onAbort = () => finish({ kind: 'cancelled' })

		waiter.answer = (value) => finish({ kind: 'answer', value })
		waiter.cancel = () => finish({ kind: 'fallthrough' })
		state.pending.set(id, waiter)
		waiter.timer = setTimeout(() => finish({ kind: 'fallthrough' }), INTERACTION_TIMEOUT_MS)
		if (signal !== undefined) {
			if (signal.aborted === true) { finish({ kind: 'fallthrough' }); return null }
			signal.addEventListener('abort', onAbort, { once: true })
		}
		for (const entry of watchers) entry.write({ t: 'interaction', kind, id, payload })
		record(`waiting for the phone to answer a ${kind} in ${sessionId}`)
		return promise
	}

	/**
	 * 手机优先的提问应答者。
	 *
	 * 必须 prepend 在官方 api-remotes 之前：waterfall 是顺序的，谁先返回谁作数；
	 * 排在它后面就永远不会被调用。只有【有手机正在看这个会话】时我们才接管。
	 */
	function onUserQuestion(request, next) {
		const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : ''
		const waiting = askPhone('question', sessionId, {
			questions: Array.isArray(request?.questions) ? request.questions : [],
		}, request?.signal)
		if (waiting === null) return next()
		return waiting.then((outcome) => {
			if (outcome.kind === 'answer') return outcome.value
			// 请求已作废：调用方早就放弃了，别再往桌面递 —— 那会弹出一个空的问答框。
			if (outcome.kind === 'cancelled') return undefined
			return next()
		})
	}

	/** 手机优先的审批应答者。同上：没手机看着就立刻交还桌面。 */
	function onApprovalRequest(request, next) {
		const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : ''
		const waiting = askPhone('approval', sessionId, {
			toolName: String(request?.toolName ?? ''),
			callId: String(request?.callId ?? ''),
			reason: String(request?.reason ?? ''),
		}, request?.signal)
		if (waiting === null) return next()
		return waiting.then((outcome) => {
			if (outcome.kind === 'answer') return outcome.value
			// 'cancelled' 本身就是合法的 ApprovalOutcome（请求已撤回），
			// 比 undefined 更准确，调用方按"不允许"处理，失败关闭。
			if (outcome.kind === 'cancelled') return 'cancelled'
			return next()
		})
	}

	/** 手机提交的答案。形状在这里校验 —— 畸形数据绝不能塞回 DSH。 */
	async function handleAnswer(req, res) {
		let body
		try { body = await readBody(req, 32 * 1024) } catch { sendJson(res, 400, { error: 'bad request' }); return }
		const id = typeof body?.id === 'string' ? body.id : ''
		const waiter = state.pending.get(id)
		if (waiter === undefined) {
			// 超时了、已经被别的手机答了、或插件重启过 —— 都不是错误，只是卡片过期。
			sendJson(res, 409, { error: '这条提问已经失效（可能超时，或已在别处回答）' })
			return
		}
		let value
		if (waiter.kind === 'question') {
			const raw = Array.isArray(body?.answers) ? body.answers : null
			if (raw === null) { sendJson(res, 400, { error: '缺少 answers' }); return }
			value = {
				answers: raw.map((item) => ({
					id: String(item?.id ?? ''),
					selected: Array.isArray(item?.selected) ? item.selected.map(String) : [],
					...(typeof item?.custom === 'string' && item.custom !== '' ? { custom: item.custom } : {}),
				})),
			}
		} else {
			const outcome = String(body?.outcome ?? '')
			if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled') {
				sendJson(res, 400, { error: 'outcome 必须是 allowed-once / rejected / cancelled' })
				return
			}
			value = outcome
		}
		waiter.answer(value)
		record(`answered a ${waiter.kind} from the phone`)
		sendJson(res, 200, { ok: true })
	}

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
		// Every route lives under the random segment. Failing closed only when the
		// secret is actually present keeps a half-written config from locking the
		// operator out of their own bridge.
		const secret = state.config?.pathSecret
		if (typeof secret === 'string' && secret !== '') {
			const prefix = `/${secret}`
			if (url.pathname === prefix) {
				res.writeHead(302, { location: `${prefix}/` })
				res.end()
				return
			}
			if (!url.pathname.startsWith(`${prefix}/`)) {
				// Logged WITHOUT the path: it is a probe or a typo, and writing the
				// caller's guess down would put whatever they sent into our log.
				record(`${req.method} <no-secret> <- ${clientIp(req)}`)
				sendJson(res, 404, { error: 'not found' })
				return
			}
			url.pathname = url.pathname.slice(prefix.length)
		}
		// gzip 只对认它的客户端开（Safari / Chrome 都认）。sendJson 与页面都看这个标记。
		res.gzipOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
		const route = `${req.method} ${url.pathname}`
		const ip = clientIp(req)
		record(`${route} <- ${ip}`)
		if (authed(req)) rememberHost(req)
		// Every request is logged before authorization, so a bare line is NOT
		// proof it succeeded — that misreading cost real diagnosis time once.
		// Rejections and server errors get their outcome appended.
		res.on('finish', () => {
			if (res.statusCode === 401 || res.statusCode >= 500) record(`${route} <- ${ip} -> ${res.statusCode}`)
		})

		const guard = () => {
			if (authed(req)) return true
			sendJson(res, 401, { error: 'unauthorized' })
			return false
		}
		// Writes cost the PIN again. A leaked cookie can read history; it cannot make
		// this machine run anything, cancel your work, or start new sessions.
		const guardWrite = () => {
			if (!guard()) return false
			if (elevated(req)) return true
			sendJson(res, 403, { error: '需要重新输入 PIN 才能执行操作', needPin: true })
			return false
		}

		void (async () => {
			try {
				if (route === 'GET /' || route === 'GET /index.html') {
					res.writeHead(200, {
						'content-type': 'text/html; charset=utf-8',
						// Older Safari ignores no-store on its own; the other two
						// headers are what stop it resurrecting a stale page.
						'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
						'pragma': 'no-cache',
						'expires': '0',
						'x-content-type-options': 'nosniff',
						// 密钥路径就在这个 URL 里，绝不能经 Referer 泄漏给第三方
						'referrer-policy': 'no-referrer',
						'x-frame-options': 'DENY',
						// 整页 90 多 KB，手机上每次打开都要真传一遍 —— 启动时压好存着，
						// gzip 之后 20 KB 出头（第二次打开还有 service worker 兜着）。
						...(state.pageGzip !== null && res.gzipOk === true
							? { 'content-encoding': 'gzip', 'content-length': state.pageGzip.length }
							: { 'content-length': Buffer.byteLength(state.page) }),
					})
					res.end(state.pageGzip !== null && res.gzipOk === true ? state.pageGzip : state.page)
					return
				}
				if (route === 'POST /api/login') return await handleLogin(req, res)
				if (route === 'POST /api/logout') {
					const token = parseCookies(req.headers.cookie)[COOKIE]
					if (typeof token === 'string') {
						state.sessions.delete(token)
						state.elevated.delete(token)
					}
					persistTokens()
					res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`)
					return sendJson(res, 200, { ok: true })
				}
				if (route === 'GET /api/bootstrap') return guard() ? await handleBootstrap(req, res) : undefined
				if (route === 'GET /api/boot') return guard() ? await handleBoot(req, res, url) : undefined
				if (route === 'GET /api/stream') return guard() ? await handleStream(req, res, url) : undefined
				if (route === 'GET /api/transcript') return guard() ? await handleTranscript(req, res, url) : undefined
				if (route === 'POST /api/prompt') return guardWrite() ? await handlePrompt(req, res) : undefined
				if (route === 'POST /api/upload') return guardWrite() ? await handleUpload(req, res) : undefined
				if (route === 'POST /api/cancel') return guardWrite() ? await handleCancel(req, res) : undefined
				if (route === 'POST /api/recall') return guardWrite() ? await handleRecall(req, res) : undefined
				if (route === 'POST /api/welcomed') return guard() ? await handleWelcomeSeen(req, res) : undefined
				if (route === 'GET /api/attachment') return guard() ? await handleAttachment(req, res, url) : undefined
				if (route === 'GET /api/media') return guard() ? await handleMedia(req, res, url) : undefined
				if (route === 'GET /api/file') return guard() ? await handleFile(req, res, url) : undefined
				if (route === 'GET /api/background') return guard() ? await handleBackground(req, res) : undefined
				// 换背景是**这台电脑**的显示设置（不改任何权限、不指挥 agent），所以只要
				// 登录过就能改；但它是写配置，仍走 guard()，没 PIN 门就不给写。
				if (route === 'POST /api/background') return guard() ? await handleSetBackground(req, res) : undefined
				// 装成 App 的三件套：manifest / 图标 / service worker（都不需要登录态，
				// 因为它们只是静态资源，而且 iOS 取 apple-touch-icon 时不一定带 cookie）。
				if (route === 'GET /manifest.webmanifest') return handleManifest(res)
				if (route === 'GET /sw.js') return handleServiceWorker(res)
				if (url.pathname.endsWith('.png') && ICON_FILES.has(url.pathname.split('/').pop() ?? '')) {
					return handleIcon(req, res, url)
				}
				if (route === 'GET /api/balance') return guard() ? await handleBalance(res, url.searchParams.get('refresh') === '1') : undefined
				if (route === 'GET /api/workspaces') return guard() ? await handleWorkspaces(res) : undefined
				// 权限：读不需要额外证明；写要提权（PIN 门），**收紧到只读除外** ——
				// 那是往安全的方向走，多拦一道只会拦着正在赶紧锁上的人。
				if (route === 'GET /api/permission') return guard() ? await handlePermission(req, res, url) : undefined
				if (route === 'POST /api/permission') {
					if (!guard()) return undefined
					let body
					try {
						body = await readBody(req, 4096)
					} catch {
						sendJson(res, 400, { error: 'bad request' })
						return undefined
					}
					// 收紧到只读不用再验一次 PIN；其余档位（含放开）必须提权，
					// 否则"捡到解锁手机的人"可以直接把整台机器放开。
					if (String(body.preset ?? '') !== 'read-only' && !elevated(req)) {
						sendJson(res, 403, { error: '改权限需要重新输入 PIN', needPin: true })
						return undefined
					}
					return await handleSetPermission(res, body, req)
				}
				if (route === 'POST /api/session') return guardWrite() ? await handleCreateSession(req, res) : undefined
				// 回答提问 / 批准操作也算"指挥这台机器"，所以和 prompt 一样要提权：
				// 光有 cookie 不足以让外人替你在批准框上点"允许"。
				if (route === 'POST /api/answer') return guardWrite() ? await handleAnswer(req, res) : undefined
				// 一键踢掉所有手机登录。只接受本机（loopback）调用，所以即使密钥泄漏，
				// 外人也无法用它把你踢下线。顺带清掉提权状态。
				if (route === 'POST /api/revoke' || route === 'GET /revoke') {
					if (!isLoopbackPeer(req.socket.remoteAddress ?? '')) {
						sendJson(res, 403, { error: 'only from this machine' })
						return
					}
					const revoked = state.sessions.size
					state.sessions.clear()
					state.elevated.clear()
					persistTokens()
					record(`revoked ${revoked} phone session(s) on request from this machine`)
					if (req.method === 'GET') {
						res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' })
						res.end(`<!doctype html><meta charset="utf-8"><title>已吊销</title><body style="font:15px/1.6 system-ui;padding:24px"><p>已吊销 <b>${revoked}</b> 个手机登录。</p><p>手机上需要重新输入 PIN。</p></body>`)
						return
					}
					return sendJson(res, 200, { ok: true, revoked })
				}
				sendJson(res, 404, { error: 'not found' })
			} catch (error) {
				warn(`route ${route} failed: ${String(error?.stack ?? error)}`)
				if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
				else try { res.end() } catch { /* closed */ }
			}
		})()
	})

	/* --------------------------------------------------------------- start */

	// A raw TCP connection is recorded before any HTTP parsing, so a phone that
	// reaches the port but fails higher up still leaves a trace.
	server.on('connection', (socket) => {
		notePeer(socket.remoteAddress ?? 'unknown', 'tcp connection')
	})

	// This listener is reachable from the internet through the tunnel, so bound
	// everything a slow or hostile peer could hold open. Node's defaults are
	// generous: a 300s request timeout is five minutes of held sockets each.
	// requestTimeout stays well above what a phone needs to upload a 12MB image on
	// cellular, which is exactly what the 32MB body cap exists to allow.
	server.headersTimeout = 20_000
	server.requestTimeout = 180_000
	server.keepAliveTimeout = 5_000
	server.maxHeadersCount = 64
	server.maxConnections = 64

	async function start() {
		const { config, file } = await loadConfig()
		state.config = config
		state.tokenTtlMs = config.tokenTtlHours * 60 * 60 * 1000
		state.elevationMs = config.elevationMinutes * 60 * 1000
		state.configFile = file
		// The page tag lets a phone that stayed open across a server restart
		// notice that its UI is stale and reload itself.
		const rawPage = await readFile(PAGE_FILE, 'utf8')
		state.pageTag = createHash('sha256').update(rawPage).digest('hex').slice(0, 12)
		state.page = rawPage.replace(PAGE_TAG_MARKER, state.pageTag)
		try {
			state.pageGzip = gzipSync(Buffer.from(state.page, 'utf8'))
		} catch {
			state.pageGzip = null
		}

		state.accessLog = join(dshHome(), ACCESS_LOG)
		try {
			const info = await stat(state.accessLog)
			if (info.size > ACCESS_LOG_LIMIT) await unlink(state.accessLog)
		} catch { /* no log yet */ }
		record(`listener starting on 0.0.0.0:${config.port}`)

		await loadTokens()

		await new Promise((resolve, reject) => {
			server.once('error', reject)
			server.listen(config.port, '0.0.0.0', () => {
				server.removeListener('error', reject)
				state.listening = true
				resolve()
			})
		})

		const addresses = lanAddresses()
		log(`listening on 0.0.0.0:${config.port}, PIN ${config.pin}`)
		for (const entry of addresses) log(`phone url: http://${entry.address}:${config.port}/  (${entry.interface})`)
		if (addresses.length === 0) warn('no non-loopback IPv4 address found; the phone cannot reach this host yet')

		installBadge(ctx, config, () => state.recentFailures.length, record)
	}

	function stop() {
		for (const entry of state.streams) {
			try { entry.controller.abort() } catch { /* already gone */ }
			try { entry.res.end() } catch { /* already closed */ }
		}
		state.streams.clear()
		// 挂起的提问必须放行：不放行等于把 agent 永久卡死在一个等不到答案的
		// waterfall 上（插件重载时尤其明显）。
		for (const waiter of [...state.pending.values()]) {
			try { waiter.cancel() } catch { /* already settled */ }
		}
		state.pending.clear()
		state.sessions.clear()
		if (state.listening) {
			state.listening = false
			try { server.close() } catch { /* already closed */ }
			// server.close() 只停止【接受新连接】：已经建立起来的 keep-alive 连接
			// 会继续被这个【会话已清空】的实例服务，于是返回莫名的 401 —— 手机
			// 复用连接时就表现为"刚重载完又让我输 PIN"。必须显式踢掉它们。
			// （插件重载就是这么工作的：旧 fiber 停、新 fiber 起，同一个端口。）
			try { server.closeIdleConnections?.() } catch { /* older node */ }
			try { server.closeAllConnections?.() } catch { /* older node */ }
		}
		log('stopped')
	}

	return { start, stop, onUserQuestion, onApprovalRequest }
}

/* ------------------------------------------------------------ desktop hint */

/**
 * A one-line badge in the desktop GUI so the URL and PIN are discoverable
 * without reading files. Inline styles only, outside `#root`, so React cannot
 * be affected by it.
 *
 * The tap runs on every index response, so the address list is recomputed each
 * time: switching to a hotspot or USB tethering adds a reachable address that
 * appears without restarting the server.
 *
 * `record` 必须由调用方传进来：这个函数是**模块级**的，而日志器 `record()` 定义在
 * `createBridge` 里面。直接在这里写 `record(...)` 会抛 ReferenceError，而本函数是在
 * `start()` 的最后一行被调用的 —— 一抛就打断整个 start：**角标消失、隧道自检也永不启动**。
 * （这个坑真踩过：236 条测试全绿，因为它压根没覆盖到角标这条路径。）
 */
function installBadge(ctx, config, failureCount, record) {
	const web = ctx.get('webServer')
	if (web === undefined || typeof web.tapIndex !== 'function') {
		// 明说为什么没有角标。以前这里静默 return，于是"界面上没有那个蓝条"
		// 完全无从查起 —— 而隧道自检也跟着不跑。
		record('desktop badge skipped: this composition has no webServer.tapIndex')
		return
	}
	record('desktop badge installed')

	// tunnel-start.ps1 rewrites `publicUrl` in the config file every time the tunnel
	// restarts (quick-tunnel hostnames are not stable). The badge is the only place
	// that URL is surfaced, so re-read it on each index response — a cached copy
	// would quietly send the phone to a dead host.
	const configPath = join(dshHome(), CONFIG_FILE)
	const refreshPublicUrl = () => {
		try {
			const stored = JSON.parse(readFileSync(configPath, 'utf8'))
			const next = typeof stored.publicUrl === 'string' && /^https:\/\/[^\s"'<>]+$/.test(stored.publicUrl)
				? stored.publicUrl
				: ''
			if (next !== (config.publicUrl ?? '')) config.publicUrl = next
		} catch {
			// Missing or half-written file: keep the last known value, say nothing.
		}
	}

	// 隧道死活要自己探，不能等用户撞上去才知道。免费隧道的网址每次重启都会变，
	// 旧网址静默失效 —— 徽标上那条"外网地址"就成了一句假话，而用户直到掏出手机
	// 打不开才反应过来。
	const tunnel = { ok: true, fails: 0 }
	const probeTunnel = async () => {
		refreshPublicUrl()
		const target = typeof config.publicUrl === 'string' ? config.publicUrl : ''
		if (target === '') { tunnel.ok = true; tunnel.fails = 0; return }
		try {
			// 只要 Cloudflare 把请求转到了本机，隧道就是活的（哪怕是 404）。
			// 隧道死了会拿到 5xx 错误页，或者根本连不上。
			const res = await fetch(withSecret(config, target), {
				redirect: 'manual',
				signal: AbortSignal.timeout(8000),
			})
			// 只记失败次数，别在这里就把 ok 置真 —— 否则下面那条"恢复了"永远不触发
			// （ok 已经被这一行改回去了，`tunnel.ok === false` 不可能成立）。
			if (res.status < 500) tunnel.fails = 0
			else tunnel.fails += 1
		} catch {
			tunnel.fails += 1
		}
		if (tunnel.fails >= 2 && tunnel.ok !== false) {
			tunnel.ok = false
			// 必须用 record()（写进 mobile-bridge.log）。log()/warn() 只到 stdout/stderr，
			// 而 DSH 不捕获它们 —— 把"隧道断了"这种要人命的消息说到没人看的地方，
			// 等于没说。
			record('tunnel unreachable: the phone cannot connect right now (run tools\\tunnel-status.ps1)')
		} else if (tunnel.ok === false && tunnel.fails === 0) {
			tunnel.ok = true
			record('tunnel is reachable again')
		}
	}

	try {
		ctx.effect(() => {
			const timer = setInterval(() => { probeTunnel().catch(() => {}) }, 120000)
			probeTunnel().catch(() => {})
			return () => clearInterval(timer)
		}, 'mobile-bridge:tunnel-probe')
	} catch (error) {
		console.error(`[mobile-bridge] tunnel probe skipped: ${String(error?.message ?? error)}`)
	}

	const render = () => {
		refreshPublicUrl()
		const addresses = lanAddresses(config.phoneHost ?? '')
		const primary = addresses[0]
		const others = addresses.slice(1)
		const escapes = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
		const remote = typeof config.publicUrl === 'string' && config.publicUrl !== '' ? config.publicUrl : ''
		// The tunnel answers "reach me from anywhere", so it leads when it is set.
		// Its URL changes whenever the tunnel restarts, which is exactly why it is
		// surfaced here instead of living only in a log file.
		const remoteLine = remote === ''
			? ''
			: tunnel.ok === false
				? `🌍 外网 <b>${escapes(withSecret(config, remote))}</b> <span style="color:#ffd0d0;font-weight:700">⚠️ 隧道已断，手机连不上</span><br>`
				: `🌍 外网 <b>${escapes(withSecret(config, remote))}</b><br>`
		// The badge used to disappear on any click, which made it impossible to
		// select the URL it exists to show: clicking to start a selection removed it.
		// Text stays selectable now and hiding is an explicit ✕ in the corner.
		const shell = (body) => [
			'<div id="dsh-mobile-bridge-badge" style="position:fixed;left:12px;bottom:12px;z-index:2147483000;',
			'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dbe4ff;background:rgba(43,63,214,.94);',
			'border-radius:10px;padding:9px 30px 9px 13px;box-shadow:0 6px 20px rgba(0,0,0,.35);',
			'user-select:text;-webkit-user-select:text;cursor:auto;',
			'max-width:min(92vw,620px);word-break:break-all;line-height:1.6">',
			body,
			'<span id="dsh-mobile-bridge-hide" title="隐藏（刷新页面后重新出现）" style="position:absolute;top:3px;right:7px;cursor:pointer;opacity:.65;font-size:14px;line-height:1;padding:2px 5px">&#10005;</span>',
			'</div>',
			'<script>(function(){var h=document.getElementById("dsh-mobile-bridge-hide");if(h){h.addEventListener("click",function(e){e.stopPropagation();var b=document.getElementById("dsh-mobile-bridge-badge");if(b){b.remove()}});}})();</script>',
		].join('')

		if (primary === undefined) {
			return shell(remote === ''
				? '📱 手机端：没有找到可用的局域网地址（网线/热点都没连？）'
				: `${remoteLine}<span style="opacity:.85">PIN <b>${escapes(config.pin)}</b> · 局域网地址暂时没有</span>`)
		}
		const { url: baseUrl, label } = describeAddress(primary, config.port)
		const url = withSecret(config, baseUrl)
		// Visibility is half of security: if someone is grinding at the PIN, the
		// operator should see it without going to look for it.
		const failures = typeof failureCount === 'function' ? failureCount() : 0
		const alarm = failures >= 3
			? `<br><span style="color:#ffd0d0;font-weight:700">有人正在试 PIN：最近 ${Math.round(LOGIN_WINDOW_MS / 60000)} 分钟内 ${failures} 次失败</span>`
			: ''
		const alt = others.length > 0
			? '备用 ' + others.map((entry) => `${escapes(entry.address)} (${escapes(entry.interface)})`).join(' / ')
			: ''
		// Nothing directly phone-facing and no phone has ever reached us: say what
		// is missing rather than leaving a campus address that will not work.
		const hint = primary.direct === true || primary.learned === true
			? ''
			: '<br><span style="opacity:.75">还没有直连链路：插数据线并在手机上开启「USB 网络共享」/ 个人热点</span>'
		return shell([
			remoteLine,
			`📱 局域网 <b>${escapes(url)}</b><br>`,
			`<span style="opacity:.85">${escapes(label)} · PIN <b>${escapes(config.pin)}</b>`,
			alt === '' ? '' : `<br>${alt}`,
			hint,
			alarm,
			'</span>',
			`<a href="http://127.0.0.1:${config.port}/${config.pathSecret}/revoke" target="_blank" onclick="event.stopPropagation()" style="color:#ffc9c9;display:inline-block;margin-top:5px;text-decoration:underline">踢掉所有手机登录</a>`,
		].join(''))
	}

	try {
		ctx.effect(
			() => web.tapIndex((html) => {
				const badge = render()
				return html.includes('</body>') ? html.replace('</body>', `${badge}</body>`) : html + badge
			}),
			'mobile-bridge:desktop-badge',
		)
	} catch (error) {
		console.error(`[mobile-bridge] badge injection skipped: ${String(error?.message ?? error)}`)
	}
}

/* ------------------------------------------------------------------- apply */

export function apply(ctx) {
	// 崩溃探针 —— 默认【关闭】。
	//
	// 它当初是为了抓"宿主每隔几分钟静默死亡"：把 uncaughtException 和 exit 事件写进
	// ~/.dsh/dsh-crash.log。那两个 bug（record 重名遮蔽、route 的 TDZ）已经定位并修好，
	// 日志里之后只剩心跳。
	//
	// 之所以默认关：这段代码跑在【宿主进程】里 —— 它会注册全局异常处理器、每 30 秒写盘，
	// 早期版本甚至猴补丁改写 process.exit。对一个装给别人用的插件来说，这是不该有的
	// 副作用。要在这台机器上排查新的静默死亡，往 ~/.dsh/mobile-bridge.json 加一行
	// "crashProbe": true 再重启即可。
	let crashProbe = false
	try {
		crashProbe = JSON.parse(readFileSync(join(dshHome(), CONFIG_FILE), 'utf8')).crashProbe === true
	} catch { /* 没有配置文件 = 不开探针 */ }

	if (crashProbe) {
		const crashLog = join(dshHome(), 'dsh-crash.log')
		// 这两个处理器必须【同步】写盘：下一行就是 process.exit(1)，异步 appendFile 会在
		// 写入落盘前就被杀掉 —— 探针曾因此整整一轮只记下"我调用了 exit"，没有异常本身。
		const burp = (kind, detail) => {
			try {
				appendFileSync(crashLog, `${new Date().toISOString()} [${process.pid}] ${kind}: ${detail}\n`)
			} catch { /* 记录失败也不能改变退出行为 */ }
		}
		const onRejection = (reason) => {
			burp('unhandledRejection', `${String(reason?.stack ?? reason)}`)
			process.exit(1)
		}
		const onException = (error) => {
			burp('uncaughtException', `${String(error?.stack ?? error)}`)
			process.exit(1)
		}
		// 静默死亡只有两种可能：显式 process.exit，或者被外部杀掉。'exit' 事件只在前者
		// 触发（TerminateProcess 不触发），有它就足以分辨 —— 不需要去猴补丁 process.exit。
		const onExit = (code) => {
			try { appendFileSync(crashLog, `${new Date().toISOString()} [${process.pid}] exit-event code=${code}\n`) } catch { /* ignore */ }
		}
		process.on('unhandledRejection', onRejection)
		process.on('uncaughtException', onException)
		process.on('exit', onExit)
		// 心跳带内存占用：如果是几小时后慢慢涨到 OOM，这条能看出来。
		const beat = setInterval(() => {
			const mb = Math.round(process.memoryUsage().rss / 1048576)
			try { appendFileSync(crashLog, `${new Date().toISOString()} [${process.pid}] heartbeat: alive rss=${mb}MB\n`) } catch { /* ignore */ }
		}, 30000)
		ctx.effect(() => () => {
			process.removeListener('unhandledRejection', onRejection)
			process.removeListener('uncaughtException', onException)
			process.removeListener('exit', onExit)
			clearInterval(beat)
		}, 'mobile-bridge:crash-probe')
	}

	ctx.effect(() => {
		const bridge = createBridge(ctx)
		// 应答者必须【prepend】在官方 api-remotes 之前。waterfall 是顺序的：排到
		// 它后面就永远不会被调用 —— 官方那一环会一直等到浏览器作答为止。
		const offQuestion = ctx.on('user-questions/request',
			(request, next) => bridge.onUserQuestion(request, next), { prepend: true })
		const offApproval = ctx.on('approval/request',
			(request, next) => bridge.onApprovalRequest(request, next), { prepend: true })
		bridge.start().catch((error) => {
			console.error(`[mobile-bridge] failed to start: ${String(error?.stack ?? error)}`)
			// DSH's stderr is not captured anywhere readable, so a start failure
			// would otherwise be invisible. This file is diagnostic only.
			appendFile(join(dshHome(), 'mobile-bridge-start-error.log'),
				`${new Date().toISOString()} ${String(error?.stack ?? error)}\n`).catch(() => {})
		})
		return () => {
			offQuestion()
			offApproval()
			return bridge.stop()
		}
	}, 'mobile-bridge:listener')
}

// Exported for the security regression suite (test/security.mjs). The throttle key
// is the most security-critical decision in this file, so it is asserted directly
// with synthetic requests rather than only through live ones.
export { clientIp, isLoopbackPeer }
