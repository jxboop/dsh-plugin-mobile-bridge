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
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, appendFileSync } from 'node:fs'
import { readFile, writeFile, appendFile, stat, unlink } from 'node:fs/promises'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
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
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BASE64 = 12 * 1024 * 1024
const MAX_IMAGES_PER_PROMPT = 20

const COOKIE = 'dshm'
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
 * 手机端绝不能收到整段历史。实测一段聊了几小时的会话：日志 9.7 MB，`maxMessages: 40`
 * 展开成 195 条记录、**979 KB** —— 手机（尤其走隧道时）根本传不完，一断线又从头再传，
 * 用户看到的就是永远停在"正在读取会话内容…"。
 */
const SNAPSHOT_BUDGET_BYTES = 240_000
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
	}

	if (stored.port !== port || stored.pin !== pin || (stored.publicUrl ?? '') !== publicUrl
		|| (stored.pathSecret ?? '') !== pathSecret || (stored.tokenTtlHours ?? 0) !== tokenTtlHours
		|| stored.bindTokenToIp !== bindTokenToIp || (stored.elevationMinutes ?? 0) !== elevationMinutes) {
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
	const body = Buffer.from(JSON.stringify(value), 'utf8')
	res.writeHead(status, {
		...SECURITY_HEADERS,
		'content-type': 'application/json; charset=utf-8',
		'content-length': body.length,
	})
	res.end(body)
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
		const payload = { version: 1, tokens: Object.fromEntries(state.sessions) }
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
		const controller = ctx.sessionController
		const value = await controller.list({}, AbortSignal.timeout(15000))
		return (value.items ?? []).map(summarize).sort((left, right) => right.updatedAt - left.updatedAt)
	}

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

	async function handleBootstrap(_req, res) {		let sessions = []
		let failure = null
		try {
			sessions = await listSessions()
		} catch (error) {
			failure = String(error?.message ?? error)
		}
		sendJson(res, 200, {
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
			security: {
				recentFailures: state.recentFailures.length,
				windowMinutes: Math.round(LOGIN_WINDOW_MS / 60000),
				locked: state.recentFailures.length >= LOGIN_MAX_ATTEMPTS_GLOBAL,
				tokenBoundToIp: state.config?.bindTokenToIp !== false,
				requirePinForWrites: true,
				elevated: elevated(_req),
				foreignUses: state.foreignUses.slice(-5),
			},
		})
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
			body = await readBody(req)
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
		if (content.length === 0) {
			sendJson(res, 400, { error: '内容为空' })
			return
		}

		try {
			const accepted = await ctx.sessionController.prompt(
				{
					requestId: randomUUID(),
					sessionId,
					mode: 'queue',
					content,
					clientTimeZone: 'Asia/Shanghai',
				},
				AbortSignal.timeout(30000),
			)
			log(`prompt accepted for ${sessionId} (${images.length} image(s), ${text.length} char(s))`)
			sendJson(res, 200, { accepted: accepted.accepted === true })
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	async function handleCancel(req, res) {
		let body
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
	 */
	function fitSnapshot(records) {
		const shrunk = Array.isArray(records) ? records.map((entry) => shrinkRecord(entry)) : []
		let from = 0
		let bytes = JSON.stringify(shrunk).length
		while (bytes > SNAPSHOT_BUDGET_BYTES && from < shrunk.length - 1) {
			bytes -= JSON.stringify([shrunk[from]]).length - 2   // 减去这条加它前后逗号的近似长度
			from += 1
		}
		const kept = shrunk.slice(from)
		return { records: kept, dropped: from, bytes: JSON.stringify(kept).length }
	}

	/** Server-sent events over one Session's durable log. */
	async function handleStream(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		if (sessionId === '') {
			sendJson(res, 400, { error: '缺少 sessionId' })
			return
		}
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
				{ address: { kind: 'session', sessionId }, maxMessages: 40, assistantStream: true },
				controller.signal,
			)
			for await (const frame of frames) {
				if (!writable()) break
				if (frame.type === 'snapshot') {
					// 绝不把整段历史原样塞给手机：压到预算内，必要时丢掉最旧的记录。
					const fitted = fitSnapshot(frame.records)
					write({
						t: 'snapshot',
						tag: state.pageTag,
						cursor: frame.cursor,
						hasMore: frame.hasMore === true || fitted.dropped > 0,
						records: fitted.records,
					})
				} else if (frame.type === 'event') {
					write({ t: 'event', event: trimEvent(frame.event) })
				} else if (frame.type === 'assistant-stream') {
					write({ t: 'delta', frame: frame.frame })
				}
			}
			write({ t: 'end' })
		} catch (error) {
			if (!controller.signal.aborted) write({ t: 'error', message: String(error?.message ?? error) })
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
					})
					res.end(state.page)
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
				if (route === 'GET /api/stream') return guard() ? await handleStream(req, res, url) : undefined
				if (route === 'POST /api/prompt') return guardWrite() ? await handlePrompt(req, res) : undefined
				if (route === 'POST /api/cancel') return guardWrite() ? await handleCancel(req, res) : undefined
				if (route === 'GET /api/attachment') return guard() ? await handleAttachment(req, res, url) : undefined
				if (route === 'GET /api/balance') return guard() ? await handleBalance(res, url.searchParams.get('refresh') === '1') : undefined
				if (route === 'GET /api/workspaces') return guard() ? await handleWorkspaces(res) : undefined
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
