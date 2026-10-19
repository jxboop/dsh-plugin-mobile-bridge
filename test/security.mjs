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
 *   - live  : real HTTP against the running bridge on 127.0.0.1. Only the
 *             **read-only** half touches the bridge you are actually using:
 *             secret-path gating, missing-auth 401s, response headers, log
 *             evidence. It talks to loopback only; never the tunnel.
 *   - probe : everything destructive — walking the login throttle, logging in for
 *             real, hammering the attachment endpoint, filling the SSE limit —
 *             runs against a throwaway instance started here on a temp DSH_HOME
 *             and a random port, torn down at the end.
 *
 * Why the probe instance exists: the login throttle keeps a *global* budget that
 * the phone shares. Running these checks against the live bridge spends that
 * budget, and a run that ends with the user locked out of their own phone is a
 * regression in the test, not in the product. It happened once; this is the fix.
 * The 192.0.2.x TEST-NET addresses keep the per-IP buckets apart as well.
 */

import { readFile, stat } from 'node:fs/promises'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
/*
 * ⚠️ 这份静态 import 在**设探针 `DSH_HOME` 之前**执行 ✓ —— 所以它拿到的是"**你真实那台**"的模块实例 ✓
 * （`clientIp` / `isLoopbackPeer` 是纯函数 ✓，不碰盘 ✓，所以现在没问题 ✓）。
 * 📌 但**别从这个实例里 import 会碰盘的东西** ✗（比如查配置、写账本那种 ✓）——
 * 那会静默落到真实 `~/.dsh` 里去 ✓（4.3.0 修的正是这一类 ✗）。真要用，就在设好 `DSH_HOME` 之后
 * 用 `import('...?probe')` 拿探针那一份 ✓（`startProbe` 就是这么做的 ✓）。
 */
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

/*
 * ⚠️ 4.3.0：**进程启动时**那个 `DSH_HOME`（在任何改动之前留的底 ✓）。
 *
 * 这一份要用来算两样**都属于"进来之前那台桥"**的东西 ✓：
 *   · 只读检查要打的配置 / 日志 ✓（见下面 `realDir` ✓）；
 *   · "真身那本账"的路径 ✓（要盯的就是它有没有被误写 ✓）。
 * ⚠️ 不能等到中途再读 ✗ —— 这个文件下面会把 `DSH_HOME` 指向探针家目录 ✓（`startProbe()` 里设的 ✓），
 * 那时再从 env 算，算出来的就是**探针**了 ✗（冷视角复查点名过这个坑 ✓）。
 */
const originalHome = (process.env.DSH_HOME ?? '').trim()
/** 进来之前那台桥的数据目录：原来没设就是 `~/.dsh` ✓。 */
const realDir = originalHome === '' ? join(homedir(), '.dsh') : originalHome

/*
 * ⚠️ 4.3.0：**真身那本账**（`<realDir>/mobile-bridge.logins.jsonl`）的路径与快照 ✓。
 * 拿它只为一件事：证明"跑完这一套，你真实那本账一个字节都没变" ✓（见文件末尾那条断言 ✓）。
 *
 * ⚠️ 用 `realDir` 而不是写死 `homedir()/.dsh` ✗ —— 冷视角复查点名的洞：外面显式设了
 * `DSH_HOME=<某个真目录>` 时（CI / 别的 harness 就是这么起的 ✓），被污染的是**那本**账 ✓，
 * 而写死的那条断言照样绿 ✓（等于没盯住 ✓）。
 */
const realLedgerPath = join(realDir, 'mobile-bridge.logins.jsonl')
/**
 * 数一数真实账本里**这套测试会写出来的那种假记录**（TEST-NET 网段 + `ua=node` ✓）。
 *
 * ⚠️ 4.3.0 检修（冷视角复查的橙 ✓）：原来只有"字节全同"一条判据 ✓ —— 它**会假红** ✗：
 * 这条桥是**活的** ✓，跑测试这会儿你手机正好登录一次（或账本超 256KB 触发 `trimLoginLog` 整体重写 ✓），
 * 字节就变了 ✓ → 门禁被一条**与你无关**的红卡住 ✗。真正要钉的是"**测试没往里写假记录**" ✓，
 * 所以判据换成**假记录条数没增加** ✓（字节/SHA 仍然打出来做参考 ✓，但不当通过条件 ✓）。
 *
 * ⚠️ 4.3.0 检修第二轮（复查点名的"新问题"✓）：**读不到不能和"0 条"混为一谈** ✗ ——
 * 原来 `catch { return 0 }` 会把"文件读不了"静默变成"0 条"✓ → 前后都 0 → **假绿** ✗
 *（而且与 `ledgerSnap` 拿到的 `exists:true` 自相矛盾 ✓）。现在读不到返回 `null` ✓，
 * 调用方**单独报一条红** ✓（照实说读不到，不假装"没问题" ✗）。
 */
const fakeRowCount = async () => {
	try {
		const text = await readFile(realLedgerPath, 'utf8')
		return text.split('\n').filter((line) => line.includes('192.0.2.') && line.includes('"ua":"node"')).length
	} catch { return null }
}
const ledgerSnap = async (path) => {
	try {
		const buf = await readFile(path)
		return { exists: true, bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex') }
	} catch {
		return { exists: false, bytes: 0, sha: '' }
	}
}
const realLedgerBefore = await ledgerSnap(realLedgerPath)
const fakeRowsBefore = await fakeRowCount()

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

/* ------------------------------------------------- 一次性实例（破坏性探测专用） */

const PROBE_PIN = '246810'
const PROBE_SECRET = 'fedcba9876543210'
const PROBE_TTL_HOURS = 12
const probeHome = mkdtempSync(join(tmpdir(), 'mb-sec-'))
/*
 * ⚠️ 4.3.0：`DSH_HOME` **只设一次、之后再不还原** ✓ —— 这一版连同上面 `bridgeHome` 那条
 * 「实例的数据目录在加载那刻定死」一起，才是"测试不写真实账本"的完整修法 ✓。
 *
 * 第 97 轮的诊断只说到一半 ✗（`process.env.DSH_HOME = realHome` 在没设时写成字符串 `"undefined"` ✓）
 * —— 那只解释"配置读不到 / 41 项静默跳过" ✗；**假登录记录**是另一件事 ✓：
 * 登录审计是异步的 ✓（回包不等它 ✓），**还原之后**那次 `appendFile` 才落地 ✓ →
 * 它跟着还原后的 `DSH_HOME` 走 ✓ → 写进真实 `~/.dsh` ✓（实测 +15 行 / 1437 字节 ✓，
 * 全是 `192.0.2.x` + `ua=node` ✓ —— 用户从「安全审计」里看到的那批假设备 ✓）。
 * 所以：**别在跑测试的时候动 DSH_HOME** ✓ —— 设成探针家目录，然后一路到底 ✓。
 * 真实配置在改之前先读一份上来（见下面 `realDir` ✓），只读检查打的是**你正在用的那台**桥 ✓。
 */
process.env.DSH_HOME = probeHome

/** 生成器要能挂住不返回，才测得出并发上限；abort 之后自己退出，不留悬挂的流。 */
const probeController = {
	create: async () => ({ id: 'probe' }),
	prompt: async () => ({ accepted: true }),
	cancel: async () => {},
	list: async () => [],
	attachment: async () => null,
	follow: async function* (_query, signal) {
		while (signal === undefined || signal.aborted !== true) {
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
	},
}

async function startProbe() {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		/*
		 * ⚠️ 每次尝试**换一个随机端口** ✓ —— 4.3.0 检修抓到过一次事故 ✗：
		 * 我为了造"探针起不来"的场景，临时把这一行改成**固定 37001** ✓，然后用**杀掉后台任务**的方式结束那次实验 ✓
		 * → 它脚本里的 `finally` 回滚**没跑到** ✓ → 固定端口就这么留在文件里 ✓ → 一旦 37001 被占 ✓，
		 * 四次重试全撞同一个端口 ✓、注释还写着"换个端口重来" ✗（EADDRINUSE 被吞 ✓，空转 24 秒后崩 ✓）。
		 * 📌 教训：**别用"杀掉任务"来结束带副作用的实验** ✗ —— 要先让它自己跑完（回滚在 finally 里 ✓）。
		 */
		const port = 37000 + Math.floor(Math.random() * 2000)
		writeFileSync(join(probeHome, 'mobile-bridge.json'), JSON.stringify({
			version: 1,
			port,
			pin: PROBE_PIN,
			pathSecret: PROBE_SECRET,
			tokenTtlHours: PROBE_TTL_HOURS,
			bindTokenToIp: false,
			elevationMinutes: 15,
		}, null, 2))

		process.env.DSH_HOME = probeHome
		const effects = []
		const cleanups = []
		const ctx = {
			sessionController: probeController,
			effect: (fn, tag) => { effects.push({ fn, tag }); return () => {} },
			get: () => undefined,
			on: () => {},
		}
		const mod = await import(`../lib/index.js?security-probe=${attempt}`)
		mod.apply(ctx)
		for (const entry of effects) {
			const cleanup = entry.fn()
			if (typeof cleanup === 'function') cleanups.push(cleanup)
		}

		const base = `http://127.0.0.1:${port}`
		for (let wait = 0; wait < 60; wait += 1) {
			await new Promise((resolve) => setTimeout(resolve, 100))
			const up = await fetch(`${base}/${PROBE_SECRET}/`, { redirect: 'manual' }).catch(() => null)
			if (up !== null) {
				return {
					base,
					stop: async () => { for (const fn of cleanups.reverse()) { try { await fn() } catch { /* 拆卸不该抛 */ } } },
				}
			}
		}
		// 端口可能被占：拆干净再换个端口重来。
		for (const fn of cleanups.reverse()) { try { await fn() } catch { /* ignore */ } }
	}
	return null
}

console.log('\n=== 一次性实例：破坏性探测打这里，不碰你正在用的那台桥 ===')
const probe = await startProbe()
// 起不来就明说，并且让下面每一项都失败 —— 静默跳过安全测试比测试失败更糟。
const probeBase = probe === null ? 'http://127.0.0.1:1' : probe.base
check('一次性实例起来了（没起来的话下面全都会红）', probe !== null, probeBase)

/* ------------------------------------------------------------------ setup */
/*
 * 「你正在用的那台桥」的配置：**只读它的文件，不动它** ✓。
 *
 * ⚠️ 路径必须用 `realDir`（**进程启动时**那个 `DSH_HOME` 算出来的 ✓）—— **不是**"每次现读 `DSH_HOME` 去拼" ✗：
 * 探针已经把 `DSH_HOME` 指到它自己的家目录了 ✓（`startProbe` 里设的 ✓），
 * 而探针自己也会写一份 `mobile-bridge.json` ✓ → 那样就会读到**探针那份** ✓，
 * 于是这几块"只读检查"打的是临时实例 ✓，**再没验证过你真身那台桥** ✗
 * （冷视角复查抓到的**静默缩水** ✓：注释还写着"打真桥" ✗、事实是打探针 ✓）。
 * 没设 `DSH_HOME`（最常见）时 `realDir` 就是 `~/.dsh` 那台 ✓ —— 与改造前行为一致 ✓。
 */
let config = null
let configWhy = ''
try {
	config = JSON.parse(await readFile(join(realDir, 'mobile-bridge.json'), 'utf8'))
} catch (error) {
	configWhy = String(error?.message ?? error)
}

/*
 * ⚠️ 「读不到配置」**不是**"可以安静跳过" ✗（4.3.0 修 ✓）：以前这里只印一句"跳过" ✗ →
 * 那几块只读检查**全都不跑** ✓ → 清一色绿 + exit 0 ✓ —— 正是它自己注释里说的"静默跳过安全测试比失败更糟" ✓
 * （第 97 轮那条"没设 DSH_HOME 就 10/10 假绿"就是这么来的 ✓）。三条一起立 ✓：
 *   ① 读不到就**逐条报红** ✓（看得见是哪些项没跑 ✓），不是一行"跳过" ✗；
 *   ② **汇总照常打印** ✓ —— 人工核对与"项数看得见"都靠那行 ✓
 *      （⚠️ 别写成"check-counts 靠它取数" ✗ —— 复查纠正过：`tools/check-counts.mjs` 先看**退出码** ✓，
 *      退出码不是 0 就直接报"先把它跑绿" ✗，读不到汇总 ✓；所以那是两道闸，别混成一句 ✓）；
 *   ③ 退出码 **1** ✓ —— 由末尾那条"有失败项就 exit 1"给 ✓（失败项就是这里补的那些 ✓）。
 * ⚠️ 这里补的失败项**只覆盖"只读检查"那几块** ✓；打探针的那几块在下面**照样会跑** ✓
 * （它们不依赖真桥配置 ✓）—— 所以"读不到配置"时也不是整套安全测试都没跑 ✓，别把话说过头 ✗。
 */
if (config === null) {
	console.log('\n  ✗ 读不到这台桥的 mobile-bridge.json —— 「只读检查」那几块（5 项）**没有跑** ✗')
	console.log(`     找的是：${join(realDir, 'mobile-bridge.json')}`)
	console.log(`     原因：${configWhy}`)
	console.log('     这不是"可以跳过"：先在这台机器上跑一次桥（让它写出配置）✓。\n')
	// 逐条记成失败项 ✓（名字**写清"那一块没跑"** ✓ —— 复查纠正过：这些是"块名"，
	// 与下面真正跑出来的那些 check 名字**不是**一一对应的 ✓，别写"与真实那条一致" ✗）。
	for (const name of [
		'实时：密钥路径门禁（配置读不到 → 这一块没跑）',
		'实时：所有接口都需要鉴权（配置读不到 → 这一块没跑）',
		'实时：穿过真实隧道，换伪造 IP 能否绕过（配置读不到 → 这一块没跑）',
		'实时：响应头（配置读不到 → 这一块没跑）',
		'实时：探测留痕，但密钥不落盘（配置读不到 → 这一块没跑）',
	]) {
		check(name, false, '读不到 mobile-bridge.json')
	}
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

	/*
	 * ⚠️ 4.3.0 检修第二轮（冷视角复查的橙 ✓）：**真桥那半段也必须自己吞网络失败** ✗ ——
	 * 桥在读配置之后、跑这几块之前挂掉/被拒 ✓，原来那些裸 `await fetch(...)` 会抛 TypeError ✓ →
	 * 又是"**崩在汇总之前**" ✗（门禁只能看到"拿不到项数" ✓，看不到"哪几项红了" ✗）。
	 * 所以这里和 `preq` 同一招 ✓：抓不到就回一个**状态 0 的合成响应** ✓，让每条断言各自报红 ✓。
	 */
	const synth = (error) => ({
		ok: false,
		status: 0,
		unavailable: String(error?.message ?? error),
		headers: { get: () => null, getSetCookie: () => [] },
		json: async () => ({}),
		text: async () => '',
	})
	const liveFetch = async (url, init) => { try { return await fetch(url, init) } catch (error) { return synth(error) } }
	const req = (path, init = {}, ip = TEST_IP_A) =>
		liveFetch(`${gate}${path}`, { ...init, headers: { 'x-forwarded-for': ip, ...(init.headers ?? {}) } })

	console.log('\n=== 实时：密钥路径门禁 ===')
	{
		for (const path of ['/', '/api/bootstrap', '/api/login', '/index.html']) {
			const res = await liveFetch(`${base}${path}`, { redirect: 'manual' })
			check(`无密钥路径 ${path} 被拒`, res.status === 404, `status ${res.status}`)
		}
		const page = await liveFetch(`${base}/${secret}/`, { redirect: 'manual' })
		check('带密钥路径首页可取', page.status === 200, `status ${page.status}`)
		const html = await page.text()
		check('页面用相对 API 路径（否则前缀下会 404）', html.includes("fetch('api/") && !html.includes("'/api/"))
		const redirect = await liveFetch(`${base}/${secret}`, { redirect: 'manual' })
		check(`${'/' + secret} 无尾斜杠时 302 到带斜杠`, redirect.status === 302, `status ${redirect.status}`)
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

	console.log('\n=== 实时：响应头（禁止缓存 / 防止密钥经 Referer 外泄）===')
	{
		const api = await req('/api/bootstrap')
		check('API 响应 cache-control: no-store', /no-store/i.test(api.headers.get('cache-control') ?? ''))
		check('API 响应 X-Content-Type-Options: nosniff', (api.headers.get('x-content-type-options') ?? '') === 'nosniff')
		check('API 响应 Referrer-Policy: no-referrer', (api.headers.get('referrer-policy') ?? '') === 'no-referrer')

		const page = await liveFetch(`${base}/${secret}/`, { redirect: 'manual' })
		check('页面 Referrer-Policy: no-referrer（密钥路径不随 Referer 外泄）', (page.headers.get('referrer-policy') ?? '') === 'no-referrer')
		/*
		 * 🔴 4.16.3 修正（**过期断言** ✗）：4.16.2 起**页面**不再 `no-store` ✓ ——
		 * 那一版的标题原话就是「页面不再每次重下：原来是 `cache-control: no-store` ✗」✓，
		 * 而这条断言**没跟着改** ✗ → 从那以后它一直是红的 ✓（security 54 项里唯一失败的那条 ✓）。
		 * 现在钉**真正的意图** ✓：页面**可以缓存** ✓、但**每次都要重新验证** ✓ + **有 etag** ✓
		 * → 重复打开走 **304**（几乎零下载 ✓✓），而换版本仍然**立刻**生效 ✓。
		 * ⚠️ 不是"删掉断言" ✗：换成更准的一条 ✓；也**不是纯否定** ✗ —— 正向证据是 `etag` ✓。
		 * ⚠️ 上面那条 **API** 的 `no-store` **不动** ✓ —— 接口响应本来就该禁缓存 ✓。
		 */
		const pageCache = page.headers.get('cache-control') ?? ''
		check('页面可缓存、但每次重新验证（no-store 已按 4.16.2 去掉 ✓ + 有 etag ✓ → 重复打开走 304 ✓）',
			/no-store/i.test(pageCache) === false
			&& /no-cache|must-revalidate/i.test(pageCache) === true
			&& (page.headers.get('etag') ?? '') !== '')
		check('页面 X-Frame-Options: DENY', (page.headers.get('x-frame-options') ?? '') === 'DENY')
	}

	console.log('\n=== 实时：探测留痕，但密钥不落盘 ===')
	{
		/*
		 * ⚠️ 这份日志属**你正在用的那台桥** ✓（`record()` 写在它自己的数据目录里 ✓）——
		 * 路径用 `realDir` ✓（**不是**"每次现读 `DSH_HOME` 去拼" ✗：那个函数已经删掉了 ✓ ——
		 * 它当初就是"会跟着探针 `DSH_HOME` 跑"的那条错路 ✓）。
		 *
		 * ⚠️ 4.3.0 检修（冷视角复查的橙 ✓）：`stat` / `readFile` **必须包 try/catch** ✗ ——
		 * 真桥还没写出 `mobile-bridge.log` 时（刚装、刚清理过 ✓）原来会在这里抛 ✓，
		 * 于是又是"崩在汇总之前" ✓ —— 与"汇总照常打印"的承诺相反 ✗。现在照实报红 ✓。
		 */
		const logPath = join(realDir, 'mobile-bridge.log')
		let offset = 0
		let logReadable = true
		try {
			// Byte offset, not a line count. Counting lines looked equivalent and was not:
			// concurrent appends make the trailing element of `split('\n')` shift, so the
			// slice could come back empty and both checks below failed for the wrong
			// reason. An offset cannot drift.
			offset = (await stat(logPath)).size
		} catch (error) {
			logReadable = false
			check('真桥的日志读得到 ✓（`realDir/mobile-bridge.log` ✓）', false, `${logPath}：${String(error?.message ?? error)}`)
		}
		const res = await fetch(`${base}/definitely-not-the-secret/api/bootstrap`).catch(() => null)
		check('不带密钥的请求返回 404', res?.status === 404, `status ${res?.status}`)

		// `record()` appends asynchronously, so poll instead of sleeping once.
		let fresh = ''
		for (let attempt = 0; attempt < 24 && logReadable === true; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 250))
			try {
				fresh = (await readFile(logPath)).subarray(offset).toString('utf8')
			} catch { fresh = '' }
			if (fresh.includes('<no-secret>')) break
		}
		const line = fresh.split('\n').find((entry) => entry.includes('<no-secret>'))
		check('未带密钥的请求被记为 <no-secret>', line !== undefined, (line ?? `新日志 ${fresh.length} 字节，未含标记`).trim())
		check('日志中不出现密钥路径', fresh.length > 0 && !fresh.includes(String(secret)))
	}
}

/* ------------------------- 一次性实例专属：不依赖真桥配置，永远都跑 --------- */
/*
 * ⚠️ 这三块（限速 / 正确登录 + 注销吊销 / 附件不泄漏 / SSE 上限）**全部只打探针** ✓ ——
 * 所以它们**不该**跟着"真桥配置读不到"一起被跳过 ✗（上一版把整个 `if (config !== null)` 包住一切 ✓，
 * 于是真桥配置一读不到，连"探针上的安全测试"也全没了 ✓ —— 那正是"静默跳过"换了个形状 ✓）。
 * 现在它们在外面：真桥配置读不到也照样跑 ✓，"探针那本账真的写到了"这条断言才有意义 ✓。
 */
/*
 * ⚠️ 4.3.0 检修（冷视角复查的橙 ✓）：`preq` 必须**自己吞掉网络层失败** ✗ ——
 * 探针没起来时（`probeBase` 落到 `127.0.0.1:1` ✓）原来是在这里**抛 ECONNREFUSED** ✓，
 * 于是整套在**汇总之前**就崩了 ✗ —— 与"探针起不来就让下面每一项都失败 ✓、汇总照常打印 ✓"的承诺相反 ✗
 * （门禁靠汇总取数 ✓，崩了就是"拿不到项数"而不是"看得出哪些项红了" ✗）。
 * 现在：抓不到就回一个**状态 0 的合成响应** ✓ → 下面每条断言各自报红 ✓、汇总照常打印 ✓。
 */
const preq = async (path, init = {}, ip = TEST_IP_A) => {
	try {
		return await fetch(`${probeBase}/${PROBE_SECRET}${path}`, { ...init, headers: { 'x-forwarded-for': ip, ...(init.headers ?? {}) } })
	} catch (error) {
		return {
			ok: false,
			status: 0,
			unavailable: String(error?.message ?? error),
			headers: { get: () => null, getSetCookie: () => [] },
			json: async () => ({}),
			text: async () => '',
		}
	}
}

console.log('\n=== 一次性实例：登录限速（真身的额度留给手机）===')
{
	// A FIXED address, on purpose. Locally the peer is loopback, and a loopback
	// peer is trusted to carry forwarding headers — that is not a hole, because
	// the only things that can reach this port from loopback are cloudflared and
	// code already running on this machine. Through the real edge a client can
	// neither forge `cf-connecting-ip` (Cloudflare answers 403) nor control the
	// last `x-forwarded-for` entry (our own proxy appends it), which is what
	// makes the same rotation useless there. That end-to-end case is the
	// optional tunnel run above; the unit block pins the logic itself.
	const codes = []
	for (let i = 0; i < 15; i += 1) {
		const res = await preq('/api/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pin: '000000' }),
		}, TEST_IP_A).catch(() => null)
		codes.push(res?.status ?? 0)
	}
	const throttled = codes.filter((code) => code === 429).length
	check('同一身份连续猜错会被限速（限速本身有效）', throttled > 0,
		`401×${codes.filter((c) => c === 401).length} 429×${throttled}`)
	// ⚠️ 4.3.0 检修（冷视角复查的白 ✓）：原来还挂着 `|| codes.length === 0` ✗ ——
	// `codes` 一定是 15 条（上面循环固定 15 次 ✓），那个分支**永远为假** ✓，是死代码 ✗。
	check('限速触发后不再继续放行（不是偶尔 429 一下）', throttled >= 2,
		`429×${throttled}`)
}

console.log('\n=== 一次性实例：正确登录 / cookie 标志 / 注销吊销 ===')
{
	const res = await preq('/api/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pin: PROBE_PIN }),
	}, TEST_IP_B)
	check('正确 PIN → 200', res.status === 200, `status ${res.status}`)

	const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
	const cookie = setCookies.filter(Boolean).join('; ')
	check('cookie 带 HttpOnly', /HttpOnly/i.test(cookie))
	check('cookie 带 SameSite=Lax', /SameSite=Lax/i.test(cookie))
	check('明文 HTTP 下不加 Secure（否则局域网登录会静默失效）', !/;\s*Secure/i.test(cookie))
	const maxAge = Number((/Max-Age=(\d+)/i.exec(cookie) ?? [])[1] ?? 0)
	check('cookie 有效期不超过配置值', maxAge > 0 && maxAge <= PROBE_TTL_HOURS * 3600, `Max-Age=${maxAge}s (配置 ${PROBE_TTL_HOURS}h)`)

	const token = (new RegExp(`${'dshm'}=([^;]+)`).exec(cookie) ?? [])[1] ?? ''
	check('拿到了会话令牌', token !== '')

	const authed = { cookie: `dshm=${token}`, 'content-type': 'application/json' }
	const boot = await preq('/api/bootstrap', { headers: authed }, TEST_IP_B)
	check('带 cookie 访问 bootstrap → 200', boot.status === 200, `status ${boot.status}`)
	const body = await boot.json().catch(() => ({}))
	const address = (body.addresses ?? [])[0]
	/*
	 * ⚠️ 4.3.0 检修（冷视角复查的橙/白 ✓）：这条原来写成 `address === undefined || …` ✗ ——
	 * 于是"bootstrap 一个地址都不回"时它**恒真** ✓（假装通过 ✗，而"手机拿不到带密钥的地址"恰恰是要防的 ✓）。
	 * 现在：**必须真有一条地址** ✓，而且它得带密钥段 ✓。
	 */
	check('广播给手机的地址带上了密钥路径',
		address !== undefined && String(address.url).includes(PROBE_SECRET), String(address?.url))

	const out = await preq('/api/logout', { method: 'POST', headers: authed }, TEST_IP_B)
	check('注销 → 200', out.status === 200, `status ${out.status}`)
	const after = await preq('/api/bootstrap', { headers: authed }, TEST_IP_B)
	check('注销后同一 cookie 失效 → 401', after.status === 401, `status ${after.status}`)
}

console.log('\n=== 一次性实例：附件接口不泄漏内部信息 ===')
{
	const login = await preq('/api/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pin: PROBE_PIN }),
	}, '192.0.2.103')
	const jar = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie')]).filter(Boolean).join('; ')
	const probeRes = await preq('/api/attachment?sessionId=x&attachmentId=..%2F..%2F..%2Fmobile-bridge.json', { headers: { cookie: jar } }, '192.0.2.103')
	const text = await probeRes.text()
	const leaks = /[A-Za-z]:[\\/]|\/Users\/|\/home\/|\.dsh|ENOENT|no such file/i.test(text)
	check('无效附件 ID 的响应不含内部路径 / 系统错误', !leaks, text.slice(0, 90))
}

console.log('\n=== 一次性实例：SSE 并发上限 ===')
{
	const login = await preq('/api/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pin: PROBE_PIN }),
	}, '192.0.2.104')
	const jar = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie')]).filter(Boolean).join('; ')

	const controllers = []
	let ok = 0
	let refused = 0
	for (let i = 0; i < 9; i += 1) {
		const ac = new AbortController()
		controllers.push(ac)
		fetch(`${probeBase}/${PROBE_SECRET}/api/stream?sessionId=${encodeURIComponent('probe-session')}`, {
			headers: { cookie: jar, 'x-forwarded-for': '192.0.2.104' },
			signal: ac.signal,
		}).then((res) => {
			if (res.status === 200) ok += 1
			else if (res.status === 503) refused += 1
			res.body?.cancel?.().catch(() => {})
		}).catch(() => {})
	}
	await new Promise((resolve) => setTimeout(resolve, 2500))
	check('并发流上限生效：放行一批、多余的 503', ok > 0 && refused > 0, `200×${ok} 503×${refused}`)
	controllers.forEach((ac) => ac.abort())
	await new Promise((resolve) => setTimeout(resolve, 300))
}

/* ------------------------------------------- 真实账本：跑完必须一个字节没变 */
/*
 * 🔴 这条是 4.3.0 加的**回归断言** ✓，也是整件事的收口 ✓。
 *
 * 用户是从「安全审计」里看到那批**幽灵设备**的 ✓（`192.0.2.x` + `ua=node` ✓ —— 全是这套测试
 * 自己造出来、却写进了他的真实账本 ✓）。第 97 轮先把它记成"测试污染" ✓，我这一轮测出真机制 ✓：
 * 探针的登录审计是**异步**的 ✓（回包不等它 ✓），而测试把 `DSH_HOME` **还原**了 ✓ →
 * 那条迟到的 `appendFile` 跟着还原后的值走 ✓ → 落进 `~/.dsh` ✓（实测每次跑 +15 行 ✓）。
 *
 * 修法两条一起上 ✓：① 探针实例的数据目录在**加载那刻定死** ✓（`lib/index.js` 的 `bridgeHome` ✓）；
 * ② 这套测试**中途不再动 `DSH_HOME`** ✓（在 `startProbe` 之前设成探针家目录，一路到底 ✓）。
 * 这条断言把结果钉死 ✓：**字节级**比对（不是行数 ✗ —— 行数被读法骗过一次 ✓）+
 * 探针自己那本账必须真的在 ✓（否则"什么都没写"也能骗过"真实账本没变" ✗）。
 *
 * ⚠️ 位置：**必须在 teardown 之前** ✗ —— 拆完就把 `probeHome` 删了 ✓，那时"探针账本在不在"就没法验了 ✓。
 */
{
	/*
	 * ⚠️ 探针自己那本账的路径**必须用绝对路径** ✓ —— 它真身就在 `probeHome` 下 ✓，
	 * 而进程里 `DSH_HOME` 的**名字**可能长得不一样 ✗（Windows 上 `os.tmpdir()` 会给 8.3 短名 ✓，
	 * 比如 `C:\Users\KIM~1\AppData\Local\Temp\...` ✓ —— 拿"那个会跟着 `DSH_HOME` 跑的旧函数"去拼会指到错的位置 ✓，
	 * 而"探针那本账没写到"这条断言就会**为错误的理由**报红 ✗ —— 实测踩过 ✓）。
	 */
	const realLedgerAfter = await ledgerSnap(realLedgerPath)
	const probeLedger = await ledgerSnap(join(probeHome, 'mobile-bridge.logins.jsonl'))
	/*
	 * ⚠️ 从**真实账本**里数"测试网段 / node 客户端"的行数 ✓ —— 这是用户看到的那种假设备 ✓。
	 * 读不到就当 0 ✓（文件不存在 = 没问题 ✓）。
	 */
	const fakeRows = await fakeRowCount()

	// 跑到这里 `DSH_HOME` 必须还指着探针家目录 ✓ —— 中途"还原"回去，就是这整件事的起因 ✓。
	/*
	 * ⚠️ 这条比的是**测试自己**写进 `process.env` 的值 ✓ —— 产品怎么坏它都不会红 ✗。
	 * 它**故意**只当"绊线" ✓：防的是"以后有人又把 `DSH_HOME` 中途换回真实目录" ✗
	 *（那正是假登录写进真账本的起因 ✓）。产品侧的真判据是下面那条"假记录没增加" ✓ ——
	 * 别把这条当成"产品没问题"的证据 ✗。
	 */
	check('跑测试不许把 DSH_HOME 换回真实目录 ✓（它一路指向探针家目录 ✓；这是一条**绊线** ✓）',
		process.env.DSH_HOME === probeHome,
		`DSH_HOME=${JSON.stringify(process.env.DSH_HOME)}`)
	/*
	 * ⚠️ 判据是"**假记录条数没增加**" ✓ —— 不是"字节全同" ✗（见 `fakeRowCount()` 那段注释：
	 * 这条桥是活的 ✓，跑测试期间你手机登录一次就会让字节变 ✓ → 假红卡门禁 ✗）。
	 * 字节/SHA 仍然打出来 ✓，只当参考 ✓。
	 * ⚠️ 读不到（`null`）时**单独报一条红** ✓ —— 不许"读不了"和"0 条"混在一起假装通过 ✗。
	 */
	if (fakeRows === null || fakeRowsBefore === null) {
		check('真实登录账本读得到 ✓（读不到就不能说"没多假记录" ✗）', false,
			`路径 ${realLedgerPath}：跑前 ${fakeRowsBefore === null ? '读不到' : fakeRowsBefore} / 跑后 ${fakeRows === null ? '读不到' : fakeRows}`)
	} else {
		check('🔴 跑完这套测试，你真实那本登录账里**一条假记录都没多** ✓（以前每跑一次 +15 行 ✗）',
			fakeRows === fakeRowsBefore,
			`测试网段 + ua=node 的行：跑前 ${fakeRowsBefore} → 跑后 ${fakeRows}；` +
			`字节 ${realLedgerBefore.bytes} → ${realLedgerAfter.bytes}` +
			`（字节相同=${realLedgerBefore.sha === realLedgerAfter.sha ? '是' : '否 —— 期间有真实登录/账本回收，属正常 ✓'}）`)
	}
	check('探针自己那本账**确实写到了** ✓（否则"真实账本没变"也可能只是"什么都没写" ✗）',
		probeLedger.exists && probeLedger.bytes > 0,
		`${probeLedger.exists ? probeLedger.bytes + ' 字节' : '没写'} @ ${join(probeHome, 'mobile-bridge.logins.jsonl')}`)
}

/* ---------------------------------------------------------------- teardown */

if (probe !== null) await probe.stop()
try { rmSync(probeHome, { recursive: true, force: true }) } catch { /* Windows 上文件可能还被占着 */ }

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
