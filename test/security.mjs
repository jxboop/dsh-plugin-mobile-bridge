/**
 * Security regression suite for the mobile bridge.
 *
 * Every claim the hardening makes is asserted here, so "it is secure" is a thing
 * you re-run rather than a thing you are told. Run it after any edit:
 *
 *   node test/security.mjs
 *
 * Two kinds of check:
 *   - unit  : the throttle key, asserted on synthetic requests. This is the piece
 *             that decides whether a six-digit PIN can be walked through, and it
 *             is the one that silently regressed before, so it is pinned directly.
 *   - live  : real HTTP against the running bridge on 127.0.0.1, covering the
 *             secret path, authorization, the login throttle, cookie flags and
 *             logout revocation.
 *
 * The live half needs the bridge running. It talks to loopback only; it does not
 * touch the tunnel or the internet.
 *
 * Throttle probes deliberately use fixed TEST-NET addresses (192.0.2.x) so their
 * login budget is isolated and neither this machine nor your phone can be locked
 * out by running the suite.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { clientIp, isLoopbackPeer } from '../lib/index.js'

const TEST_IP_A = '192.0.2.101'
const TEST_IP_B = '192.0.2.102'

const results = []
function check(name, ok, detail = '') {
	results.push({ name, ok: Boolean(ok), detail })
	const mark = ok ? 'PASS' : 'FAIL'
	console.log(`  [${mark}] ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

function eq(name, actual, expected) {
	check(name, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

function dshDir() {
	const configured = (process.env.DSH_HOME ?? '').trim()
	return configured === '' ? join(homedir(), '.dsh') : configured
}

/* ------------------------------------------------------------------ unit */

console.log('\n=== 单元：限速的钥匙（clientIp）===')
{
	const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers })

	// The regression that mattered: a LAN/WAN caller must not be able to pick its
	// own throttle bucket by inventing a forwarding header.
	eq('非环回对端 + 伪造 X-Forwarded-For → 仍然按真实对端计',
		clientIp(req('192.168.1.50', { 'x-forwarded-for': '1.2.3.4' })), '192.168.1.50')
	eq('非环回对端 + 伪造 CF-Connecting-IP → 仍然按真实对端计',
		clientIp(req('10.0.0.9', { 'cf-connecting-ip': '8.8.8.8' })), '10.0.0.9')
	eq('非环回对端 + 两个头都伪造 → 仍然按真实对端计',
		clientIp(req('172.16.5.5', { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })), '172.16.5.5')

	// Through our own cloudflared the peer is loopback, and there the edge-set
	// header is authoritative.
	eq('环回对端 + CF-Connecting-IP → 采用它（边缘设置，客户端无法注入）',
		clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '9.9.9.9' })), '203.0.113.7')
	// With only x-forwarded-for present, our proxy APPENDS the real peer, so the
	// last entry is the trustworthy one — the first is caller-supplied.
	eq('环回对端 + 只有 XFF → 取【最后】一段（自家代理追加的）',
		clientIp(req('::1', { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })), '203.0.113.9')
	eq('环回对端 + 单段 XFF → 取该段',
		clientIp(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9')
	eq('环回对端 + 无任何头 → 退回对端地址', clientIp(req('127.0.0.1')), '127.0.0.1')

	check('isLoopbackPeer 认 ::1 / 127.0.0.1 / ::ffff:127.0.0.1',
		isLoopbackPeer('::1') && isLoopbackPeer('127.0.0.1') && isLoopbackPeer('::ffff:127.0.0.1'))
	check('isLoopbackPeer 拒绝普通地址',
		!isLoopbackPeer('192.168.1.2') && !isLoopbackPeer('::ffff:192.168.1.2') && !isLoopbackPeer(undefined))
}

/* ------------------------------------------------------------------ setup */

let config = null
try {
	config = JSON.parse(await readFile(join(dshDir(), 'mobile-bridge.json'), 'utf8'))
} catch (error) {
	console.log(`\n  无法读取 mobile-bridge.json：${String(error?.message ?? error)}`)
	console.log('  跳过实时检查（桥可能还没跑过）。\n')
}

if (config !== null) {
	const port = config.port
	const secret = config.pathSecret
	const base = `http://127.0.0.1:${port}`
	const gate = `${base}/${secret}`

	console.log('\n=== 配置 ===')
	check('pathSecret 是 16 位十六进制', typeof secret === 'string' && /^[0-9a-f]{16}$/.test(secret), String(secret))
	check('tokenTtlHours 在 1..336 之间', Number.isInteger(config.tokenTtlHours) && config.tokenTtlHours >= 1 && config.tokenTtlHours <= 336, String(config.tokenTtlHours))
	check('PIN 是 6 位数字', typeof config.pin === 'string' && /^\d{6}$/.test(config.pin))

	const req = (path, init = {}, ip = TEST_IP_A) =>
		fetch(`${gate}${path}`, { ...init, headers: { 'x-forwarded-for': ip, ...(init.headers ?? {}) } })

	console.log('\n=== 实时：密钥路径门禁 ===')
	{
		for (const path of ['/', '/api/bootstrap', '/api/login', '/index.html']) {
			const res = await fetch(`${base}${path}`, { redirect: 'manual' }).catch(() => null)
			check(`无密钥路径 ${path} 被拒`, res !== null && res.status === 404, `status ${res?.status}`)
		}
		const page = await fetch(`${base}/${secret}/`, { redirect: 'manual' })
		check('带密钥路径首页可取', page.status === 200)
		const html = await page.text()
		check('页面用相对 API 路径（否则前缀下会 404）', html.includes("fetch('api/") && !html.includes("'/api/"))
		const redirect = await fetch(`${base}/${secret}`, { redirect: 'manual' })
		check(`${'/' + secret} 无尾斜杠时 302 到带斜杠`, redirect.status === 302)
	}

	console.log('\n=== 实时：所有接口都需要鉴权 ===')
	{
		const gets = ['/api/bootstrap', '/api/balance', '/api/workspaces', '/api/stream?sessionId=x', '/api/attachment?a=1']
		const posts = ['/api/prompt', '/api/cancel', '/api/session']
		for (const path of gets) {
			const res = await req(path)
			check(`GET  ${path} 无 cookie → 401`, res.status === 401, `status ${res.status}`)
		}
		for (const path of posts) {
			const res = await req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
			check(`POST ${path} 无 cookie → 401`, res.status === 401, `status ${res.status}`)
		}
	}

	console.log('\n=== 实时：登录限速 ===')
	{
		// A FIXED address, on purpose. Locally the peer is loopback, and a loopback
		// peer is trusted to carry forwarding headers — that is not a hole, because
		// the only things that can reach this port from loopback are cloudflared and
		// code already running on this machine. Through the real edge a client can
		// neither forge `cf-connecting-ip` (Cloudflare answers 403) nor control the
		// last `x-forwarded-for` entry (our own proxy appends it), which is what
		// makes the same rotation useless there. That end-to-end case is the
		// optional tunnel run below; the unit block above pins the logic itself.
		const codes = []
		for (let i = 0; i < 15; i += 1) {
			const res = await req('/api/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pin: '000000' }),
			}, TEST_IP_A)
			codes.push(res.status)
		}
		const throttled = codes.filter((code) => code === 429).length
		check('同一身份连续猜错会被限速（限速本身有效）', throttled > 0,
			`401×${codes.filter((c) => c === 401).length} 429×${throttled}`)
	}

	const tunnel = (process.env.BRIDGE_TUNNEL_URL ?? '').trim().replace(/\/+$/, '')
	if (tunnel !== '' && typeof secret === 'string') {
		console.log('\n=== 实时：穿过真实隧道，换伪造 IP 能否绕过（关键回归）===')
		console.log(`  目标 ${tunnel}/${secret}/api/login`)
		console.log('  注意：这会消耗你这台机器真实出口 IP 的登录额度，10 分钟后自动恢复。')
		const codes = []
		for (let i = 0; i < 15; i += 1) {
			const res = await fetch(`${tunnel}/${secret}/api/login`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` },
				body: JSON.stringify({ pin: '000000' }),
			}).catch(() => null)
			codes.push(res?.status ?? 0)
		}
		const throttled = codes.filter((code) => code === 429).length
		check('穿隧道换伪造 IP 仍被限速（漏洞回归）', throttled > 0,
			`401×${codes.filter((c) => c === 401).length} 429×${throttled}`)
	}

	console.log('\n=== 实时：正确登录 / cookie 标志 / 注销吊销 ===')
	{
		const res = await req('/api/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pin: config.pin }),
		}, TEST_IP_B)
		check('正确 PIN → 200', res.status === 200, `status ${res.status}`)

		const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
		const cookie = setCookies.filter(Boolean).join('; ')
		check('cookie 带 HttpOnly', /HttpOnly/i.test(cookie))
		check('cookie 带 SameSite=Lax', /SameSite=Lax/i.test(cookie))
		check('明文 HTTP 下不加 Secure（否则局域网登录会静默失效）', !/;\s*Secure/i.test(cookie))
		const maxAge = Number((/Max-Age=(\d+)/i.exec(cookie) ?? [])[1] ?? 0)
		check('cookie 有效期不超过配置值', maxAge > 0 && maxAge <= config.tokenTtlHours * 3600, `Max-Age=${maxAge}s (配置 ${config.tokenTtlHours}h)`)

		const token = (new RegExp(`${'dshm'}=([^;]+)`).exec(cookie) ?? [])[1] ?? ''
		check('拿到了会话令牌', token !== '')

		const authed = { cookie: `dshm=${token}`, 'content-type': 'application/json' }
		const boot = await req('/api/bootstrap', { headers: authed }, TEST_IP_B)
		check('带 cookie 访问 bootstrap → 200', boot.status === 200, `status ${boot.status}`)
		const body = await boot.json().catch(() => ({}))
		const address = (body.addresses ?? [])[0]
		check('广播给手机的地址带上了密钥路径', address === undefined || String(address.url).includes(secret), String(address?.url))

		const out = await req('/api/logout', { method: 'POST', headers: authed }, TEST_IP_B)
		check('注销 → 200', out.status === 200, `status ${out.status}`)
		const after = await req('/api/bootstrap', { headers: authed }, TEST_IP_B)
		check('注销后同一 cookie 失效 → 401', after.status === 401, `status ${after.status}`)
	}

	console.log('\n=== 实时：响应头（禁止缓存 / 防止密钥经 Referer 外泄）===')
	{
		const api = await req('/api/bootstrap')
		check('API 响应 cache-control: no-store', /no-store/i.test(api.headers.get('cache-control') ?? ''))
		check('API 响应 X-Content-Type-Options: nosniff', (api.headers.get('x-content-type-options') ?? '') === 'nosniff')
		check('API 响应 Referrer-Policy: no-referrer', (api.headers.get('referrer-policy') ?? '') === 'no-referrer')

		const page = await fetch(`${base}/${secret}/`, { redirect: 'manual' })
		check('页面 Referrer-Policy: no-referrer（密钥路径不随 Referer 外泄）', (page.headers.get('referrer-policy') ?? '') === 'no-referrer')
		check('页面 cache-control 含 no-store', /no-store/i.test(page.headers.get('cache-control') ?? ''))
		check('页面 X-Frame-Options: DENY', (page.headers.get('x-frame-options') ?? '') === 'DENY')
	}

	console.log('\n=== 实时：附件接口不泄漏内部信息 ===')
	{
		const login = await req('/api/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pin: config.pin }),
		}, '192.0.2.103')
		const jar = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie')]).filter(Boolean).join('; ')
		const probe = await req('/api/attachment?sessionId=x&attachmentId=..%2F..%2F..%2Fmobile-bridge.json', { headers: { cookie: jar } }, '192.0.2.103')
		const text = await probe.text()
		const leaks = /[A-Za-z]:[\\/]|\/Users\/|\/home\/|\.dsh|ENOENT|no such file/i.test(text)
		check('无效附件 ID 的响应不含内部路径 / 系统错误', !leaks, text.slice(0, 90))
	}

	console.log('\n=== 实时：SSE 并发上限 ===')
	{
		const login = await req('/api/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pin: config.pin }),
		}, '192.0.2.104')
		const jar = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie')]).filter(Boolean).join('; ')
		const boot = await (await req('/api/bootstrap', { headers: { cookie: jar } }, '192.0.2.104')).json().catch(() => ({}))
		const liveId = (boot.sessions ?? [])[0]?.sessionId
		check('取到一个真实会话用于占用流', typeof liveId === 'string' && liveId !== '')

		const controllers = []
		let ok = 0
		let refused = 0
		for (let i = 0; i < 9; i += 1) {
			const ac = new AbortController()
			controllers.push(ac)
			fetch(`${gate}/api/stream?sessionId=${encodeURIComponent(liveId ?? 'x')}`, {
				headers: { cookie: jar, 'x-forwarded-for': '192.0.2.104' },
				signal: ac.signal,
			}).then((res) => {
				if (res.status === 200) ok += 1
				else if (res.status === 503) refused += 1
				res.body?.cancel?.().catch(() => {})
			}).catch(() => {})
		}
		await new Promise((resolve) => setTimeout(resolve, 2500))
		check('超过上限的并发流被 503 拒绝', refused > 0, `200×${ok} 503×${refused}`)
		controllers.forEach((ac) => ac.abort())
		await new Promise((resolve) => setTimeout(resolve, 300))
	}

	console.log('\n=== 实时：探测留痕，但密钥不落盘 ===')
	{
		const logPath = join(dshDir(), 'mobile-bridge.log')
		// Byte offset, not a line count. Counting lines looked equivalent and was not:
		// concurrent appends make the trailing element of `split('\n')` shift, so the
		// slice could come back empty and both checks below failed for the wrong
		// reason. An offset cannot drift.
		const offset = (await stat(logPath)).size
		const res = await fetch(`${base}/definitely-not-the-secret/api/bootstrap`).catch(() => null)
		check('不带密钥的请求返回 404', res?.status === 404, `status ${res?.status}`)

		// `record()` appends asynchronously and the SSE section just above leaves a
		// burst of writes queued, so poll instead of sleeping once.
		let fresh = ''
		for (let attempt = 0; attempt < 24; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 250))
			fresh = (await readFile(logPath)).subarray(offset).toString('utf8')
			if (fresh.includes('<no-secret>')) break
		}
		const line = fresh.split('\n').find((entry) => entry.includes('<no-secret>'))
		check('未带密钥的请求被记为 <no-secret>', line !== undefined, (line ?? `新日志 ${fresh.length} 字节，未含标记`).trim())
		check('日志中不出现密钥路径', fresh.length > 0 && !fresh.includes(String(secret)))
	}
}

/* ---------------------------------------------------------------- summary */

const failed = results.filter((entry) => !entry.ok)
console.log(`\n================ 汇总 ================`)
console.log(`  共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) {
	console.log('  失败项：')
	for (const entry of failed) console.log(`    - ${entry.name}  (${entry.detail})`)
}
console.log('')
process.exit(failed.length === 0 ? 0 : 1)
