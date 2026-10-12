/**
 * 3.4.0 开放接口（REST + Webhook）—— 第一刀：**只做出站投递的地基** ✓。
 *
 * 上游已查实（第 61/62 轮 ✓）：
 *  · 宿主有 **80 个可监听事件** ✓（`cordis_inspect_query` 的 `Event` provider ✓）——
 *    本插件**实际只订三个 `emit` 类** ✓（就在 `lib/index.js` 的 `WEBHOOK_EVENTS` ✓）：
 *    `api-session/status`（开始跑 / 跑完 ✓）、`api-session/error`（出错 ✓）、
 *    `api-session/activity`（有新活动 ✓）—— **订阅宿主的**，不自己造一套 ✗。
 *    ⚠️ **更正（第 82 轮）**：这里原来把 `user-questions/request`（"要你点头"）列成"首选三个"之一 ✗ ——
 *    它是 **waterfall** 类 ✓，订阅者**必须调 `next()` 并给出决定** ✓，乱订会干扰宿主流程 ✗
 *    （`lib/index.js` 里那两条 approval / question 接管就是 waterfall ✓，**别再给它加订阅** ✗）。
 *  · 本插件订阅的写法：`ctx.effect(() => { const off = ctx.on(name, …); return () => off() }, 'label')` ✓
 *    （照 `ctx.effect` 那三处先例 ✓）。
 *
 * ⚠️ 安全口径（项目铁律 ✓，这一层也照办 ✓）：
 *  · **默认关** ✗（没配 `webhookUrl` 就什么都不发 ✓）；
 *  · 出站地址**只允许** `http://127.0.0.1`/`http://localhost` 或 `https://` ✓ ——
 *    `file:`/`ftp:`/`data:` 一律拒 ✗；**内网/元数据地址**（`169.254.169.254` ✓、
 *    `10./172.16./192.168.` ✓、`.internal` ✓）也拒 ✗（**SSRF 面**要自己挡 ✓，等出事了再挡就晚了 ✗）；
 *  · 投递带 **HMAC 签名头** ✓（双方可验真 ✓，别人伪造不了 ✗）；
 *  · 载荷**默认不带会话内容** ✗（只带事件名/会话 id/时间/状态 ✓）—— 想带内容要单独开 ✓ 并写明后果 ✓。
 *
 * ⚠️ **更正（第 82 轮 / 第 83 轮复查）**：这里原来写"真正的事件订阅接线是下一刀 ✓ / 还不能说事件会自己发出去" ✗ ——
 * **接线早就做完了** ✓：`lib/index.js` 里的 `subscribeWebhooks()`（就在 `handleWebhookTest` 所在的那个外层函数里 ✓）
 * 在 **`start()` 里、配置与审计日志都就绪之后**自动订一次 ✓（复查第 83 轮 🔴 R1：以前它跑在 `createBridge` 顶层，
 * 早于 `start()` ✓ → 冷启动/重启后**一个监听器都没有** ✗，而且日志零行 ✗）；`POST /api/webhook/subscribe`
 * 可以按需再订一次 ✓（幂等 ✓）。
 * ⚠️ 另外：**注释里不写行号** ✓（第 83 轮复查抓到三处行号全过期 ✗ —— 真值在改，注释不会自己跟着改 ✓）。
 * 所以"配了 URL + 事件来了真投递"这条**已经成立** ✓（harness 里有冷启动与正路径两条断言 ✓，第 70 轮手工端到端也验过 ✓）。
 * 本文件自己只是**纯函数**（白名单 / 载荷 / 签名 / 头 ✓），不碰 `ctx` ✓、也不发请求 ✓。
 */
import { createHmac } from 'node:crypto'

/** 出站地址白名单 ✓：本机 http ✓ 或任意 https ✓；其余一律拒 ✗。 */
export function allowWebhookUrl(raw) {
	const text = String(raw ?? '').trim()
	if (text === '') return { ok: false, reason: '没填地址' }
	let parsed = null
	try { parsed = new URL(text) } catch { return { ok: false, reason: '这不是一个合法网址' } }
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		return { ok: false, reason: '只允许 http/https（file:、ftp:、data: 这些一律不发）' }
	}
	/*
	 * ⚠️ 复查（第 83 轮）R7：**带用户名/密码的 URL 一律拒** ✗ ——
	 * 原来只看 hostname ✓ → `https://user:P%40ssw0rd@example.invalid/hook` 判 ok ✓，
	 * 而 `fetch()` **永远拒绝**构造这种请求 ✓（`TypeError: … includes credentials` ✓）
	 * → "配了却永远不投" ✗，而且那种 URL 本身就是**把密码写在配置里** ✓。
	 */
	if (parsed.username !== '' || parsed.password !== '') {
		return { ok: false, reason: '地址里不要带用户名/密码（fetch 也不会用它们，去掉 https://user:pass@ 这一段）' }
	}
	/*
	 * ⚠️ 3.4.0 复查（第 75 轮）实测：原来按**字面串**判 ✓ → 这些全被放行 ✗：
	 *   `https://[::ffff:169.254.169.254]/`（v4-mapped 云元数据 ✓）、`https://[fd00::1]/`（ULA ✓）、
	 *   `https://[fe80::1]/`（链路本地 ✓）、`https://[::]:8443/`（未指定 ✓）、
	 *   `https://0.0.0.0:8443/` ✓、`https://foo.internal./`（**尾点**绕过后缀判断 ✓）。
	 * 修法（**保守优先** ✓）：① 尾点去掉再判 ✓；② **IPv6 字面量一律拒** ✗ ——
	 * ULA/链路本地/v4-mapped/未指定 这一族规则难穷举 ✓，而实际用法里几乎用不到 ✓（要投本机就写 127.0.0.1 ✓）；
	 * ③ `0.0.0.0`/`0.x` 拒 ✓；④ 内网后缀再加 `.lan`/`.local` ✓。
	 * ⚠️ **还没做**（如实 ✗）：**域名解析到内网**（`*.nip.io`、`localtest.me` ✓）这类要在**投递时**用
	 * `dns.lookup` 校验**全部**结果才能挡住 ✓ —— 那需要把这一步挪到异步路径上 ✓，留给下一轮 ✓
	 *（当前威胁模型里"能改配置的人=已完全信任" ✓，所以先按"防手滑"标准收 ✓，但这条不假装已解决 ✗）。
	 */
	const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
	if (host.startsWith('[') || host.includes(':')) {
		return { ok: false, reason: '不支持 IPv6 地址（要投本机请写 127.0.0.1）' }
	}
	const loopback = host === '127.0.0.1' || host === 'localhost'
	if (parsed.protocol === 'http:' && loopback !== true) {
		return { ok: false, reason: '明文 http 只允许本机（127.0.0.1 / localhost）—— 其它一律要 https' }
	}
	if (host === '0.0.0.0' || /^0\./.test(host)) {
		return { ok: false, reason: '0.0.0.0 不是一个目的地' }
	}
	if (host === '169.254.169.254' || host === 'metadata.google.internal') {
		return { ok: false, reason: '这是云元数据地址，不能作为投递目标' }
	}
	if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
		|| host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.local')) {
		return { ok: false, reason: '这是内网地址，不能作为投递目标（要投本机就用 127.0.0.1）' }
	}
	return { ok: true, url: parsed.toString() }
}

/** 载荷 ✓：**默认只有元信息** ✓（事件名/会话 id/时间/状态 ✓）—— 会话内容要单独开 ✗。 */
export function buildWebhookPayload(event, data, now = Date.now()) {
	const payload = { event: String(event ?? ''), at: Number(now) }
	const record = data !== null && typeof data === 'object' ? data : {}
	if (typeof record.sessionId === 'string' && record.sessionId !== '') payload.sessionId = record.sessionId
	if (typeof record.running === 'boolean') payload.running = record.running
	/* 复查（第 83 轮）R13：`api-session/activity` 的**发生时间**（宿主给的 ✓）单独一个字段 ✓ ——
	 * `at` 一律是**投递时刻** ✓（以前它被静默换成了投递时间 ✗，对方看不出来 ✓）。 */
	if (typeof record.updatedAt === 'number' && record.updatedAt > 0) payload.updatedAt = record.updatedAt
	if (typeof record.status === 'string' && record.status !== '') payload.status = record.status
	if (typeof record.turn === 'number') payload.turn = record.turn
	if (typeof record.message === 'string' && record.message !== '') payload.message = record.message.slice(0, 300)
	return payload
}

/** 签名 ✓：`sha256=<hex>`（与 GitHub 的 `X-Hub-Signature-256` 同形 ✓ —— 别人的程序好接 ✓）。 */
export function signWebhookBody(secret, body) {
	const key = String(secret ?? '')
	if (key === '') return ''
	return 'sha256=' + createHmac('sha256', key).update(String(body), 'utf8').digest('hex')
}

/** 头 ✓：把"是什么事件、什么时候、签名"三件事说清 ✓。 */
export function webhookHeaders(event, secret, body, now = Date.now()) {
	const headers = {
		'content-type': 'application/json; charset=utf-8',
		'x-dsh-event': String(event ?? ''),
		'x-dsh-timestamp': String(Number(now)),
		'user-agent': 'dsh-mobile-bridge-webhook/1',
	}
	const signature = signWebhookBody(secret, body)
	if (signature !== '') headers['x-dsh-signature'] = signature
	return headers
}
