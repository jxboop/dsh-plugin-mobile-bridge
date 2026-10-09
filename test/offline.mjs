/**
 * 连接失败整屏（1.6.0）的专门测试。
 *
 * 用户报「连接不上时不是黑屏就是白屏」—— 那是两种不同的失败：
 *   ① 设了背景素材、取不到 → 深色底上什么都没有（黑屏）；
 *   ② 连不上、没内容可渲染 → 空壳（白屏）。
 * ui.mjs 那套跑的是"连上之后"的正常流程，进不到这两个分支，所以这里**单独用一份
 * 永远失败的 stub** 把页面装起来，验的就是用户当时看到的那一屏。
 *
 *   node test/offline.mjs
 *
 * 需要 jsdom（仅测试依赖）—— 解析方式和 ui.mjs 一样。
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

function loadJsdom() {
	const attempts = [
		join(HERE, '..', 'anchor.cjs'),
		join(HERE, '..', '..', '_verify', 'anchor.cjs'),
	]
	for (const anchor of attempts) {
		try { return createRequire(anchor)('jsdom') } catch { /* 试下一个 */ }
	}
	console.error('这个测试需要 jsdom（仅测试依赖，不是插件依赖）。先装一次：\n\n    npm install\n')
	process.exit(2)
}

const { JSDOM, VirtualConsole } = loadJsdom()
const PAGE_TAG = 'offlinetag0001'
const html = (await readFile(join(HERE, '..', 'lib', 'mobile.html'), 'utf8')).replace('__DSH_PAGE_TAG__', PAGE_TAG)

const SECRET = 'deadbeefdeadbeef'
const PAGE_URL = `http://127.0.0.1:3081/${SECRET}/`

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
	if (ok) { pass += 1; console.log(`  PASS  ${name}${detail === '' ? '' : '  — ' + detail}`) }
	else { fail += 1; console.log(`  FAIL  ${name}${detail === '' ? '' : '  — ' + detail}`) }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 起一个"连不上电脑"的页面。
 *
 * @param {'down'|'401'|'recover'} mode down=请求全失败；401=服务端答话但没登录；
 *                                     recover=头两次失败、之后成功（验自动/手动重试能恢复）
 */
async function mount(mode) {
	const mode402 = { attempts: 0 }
	const response = (status, body) => ({
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => 'application/json' },
		json: async () => body,
		text: async () => JSON.stringify(body),
	})
	const stubFetch = async (input) => {
		const url = String(input)
		const path = url.replace(PAGE_URL, '').split('?')[0]
		if (path.includes('api/boot') || path.includes('api/bootstrap')) {
			mode402.attempts += 1
			if (mode === '401') return response(401, { error: 'unauthorized' })
			// down = 桥根本没起来：boot 也得失败，否则就是"连上了"，测不到那一屏。
			if (mode === 'down') throw new Error('network down')
			if (mode === 'recover' && mode402.attempts <= 1) throw new Error('network down')
			return response(200, { welcomed: true, transcript: { records: [], cursor: 0 } })
		}
		if (path.includes('api/')) throw new Error('network down')
		return response(404, {})
	}
	const dom = new JSDOM(html, {
		url: PAGE_URL,
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		virtualConsole: new VirtualConsole(),
		beforeParse(window) {
			window.fetch = stubFetch
			// 加载页那一步走 XHR（要真实下载进度）：这里让它立刻失败，等价于"桥没起来"。
			window.XMLHttpRequest = class {
				constructor() { this.status = 0; this.responseText = ''; this.timeout = 0 }
				open() {}
				setRequestHeader() {}
				send() { setTimeout(() => this.onerror?.(), 5) }
			}
			window.EventSource = class { constructor() {} close() {} addEventListener() {} }
			// 自动重试会调 location.reload()；jsdom 不支持导航，替掉它，好数次数。
			window.__reloads = 0
			try {
				Object.defineProperty(window.location, 'reload', {
					configurable: true,
					value: () => { window.__reloads += 1 },
				})
			} catch { /* 定义不了就跳过：断言里会体现 */ }
		},
	})
	await wait(120)
	return { dom, window: dom.window, stub: mode402 }
}

const $ = (window, id) => window.document.getElementById(id)
const visible = (window, id) => {
	const node = $(window, id)
	return node !== null && window.getComputedStyle(node).display !== 'none'
}
/** 轮询等待某个条件成立：固定 sleep 会被"这一跑恰好慢了一点"打成假红。 */
async function until(predicate, timeout = 3000) {
	const deadline = Date.now() + timeout
	for (;;) {
		if (predicate()) return true
		if (Date.now() > deadline) return false
		await wait(25)
	}
}
const waitShown = (window, id) => until(() => visible(window, id))

console.log('\n=== 冷启动就连不上（用户说的"白屏"现场）===')
{
	const { window } = await mount('down')
	const shown = await waitShown(window, 'offline')
	check('屏幕上出现了「连不上电脑」整屏（不是一片空白）', shown === true)
	check('加载页被盖住了（整屏 z-index 高于加载页）',
		Number(window.getComputedStyle($(window, 'offline')).zIndex)
		> Number(window.getComputedStyle($(window, 'boot')).zIndex || 0),
		`offline z=${window.getComputedStyle($(window, 'offline')).zIndex} boot z=${window.getComputedStyle($(window, 'boot')).zIndex || 0}`)
	check('第一句就说清是什么事，而不是留一片空白',
		$(window, 'offlineWhy').textContent.includes('电脑睡了')
		&& $(window, 'offlineWhy').textContent.includes('DSH'),
		$(window, 'offlineWhy').textContent.slice(0, 50))
	check('给了一颗能点的「重试」', $(window, 'offlineRetry') !== null && $(window, 'offlineRetry').textContent.includes('重试'))
	check('写着会自动重试（不用用户盯着屏幕）',
		$(window, 'offlineAuto').textContent.includes('自动重试'),
		$(window, 'offlineAuto').textContent)
	check('有排查清单（先看电脑睡没睡，而不是让人自己猜）',
		$(window, 'offlineHelp').textContent.includes('电脑是不是睡了')
		&& $(window, 'offlineHelp').textContent.includes('tunnel-status.ps1'))
	check('把当前地址原样摆出来（方便对着电脑核对）',
		$(window, 'offlineHelp').textContent.includes('当前地址')
		&& $(window, 'offlineHelp').textContent.includes('deadbeef'),
		$(window, 'offlineHelp').textContent.slice(-60))
	check('这一屏是压在最上面的固定层（盖得住背景素材与空壳）',
		window.getComputedStyle($(window, 'offline')).position === 'fixed'
		&& Number(window.getComputedStyle($(window, 'offline')).zIndex) >= 90,
		`${window.getComputedStyle($(window, 'offline')).position} z=${window.getComputedStyle($(window, 'offline')).zIndex}`)
	check('这一屏不透明（黑屏的成因就是透出深色底）',
		String(window.getComputedStyle($(window, 'offline')).backgroundImage).includes('gradient')
		|| String(window.getComputedStyle($(window, 'offline')).backgroundColor) !== 'rgba(0, 0, 0, 0)',
		window.getComputedStyle($(window, 'offline')).backgroundColor)
	window.close()
}

console.log('\n=== 设了背景素材又连不上（用户说的"黑屏"现场）===')
{
	const { window } = await mount('down')
	window.document.body.classList.add('hasbg')
	// 断网事件会把这一屏亮起来，同时把背景收掉 —— 背景留着就是那块黑。
	window.dispatchEvent(new window.Event('offline'))
	await wait(40)
	check('手机断网时整屏说的是「手机自己没网」（和"电脑连不上"要分开）',
		$(window, 'offlineTitle').textContent.includes('手机自己没网'),
		$(window, 'offlineTitle').textContent)
	check('背景被收掉了（不然就是一块黑）',
		window.document.body.classList.contains('hasbg') === false)
	check('断网时也给了重试键', $(window, 'offlineRetry') !== null)
	window.close()
}

console.log('\n=== 401 不是"连不上"（服务端明明答话了）===')
{
	const { window } = await mount('401')
	await wait(80)
	check('没登录时不弹「连不上电脑」，而是把登录页摆出来',
		visible(window, 'offline') === false && visible(window, 'gate') === true,
		`offline=${visible(window, 'offline')} gate=${visible(window, 'gate')}`)
	window.close()
}

console.log('\n=== 重试能恢复（原地重连，不整页刷新）===')
{
	const { window, stub } = await mount('recover')
	check('一开始连不上 → 整屏提示', (await waitShown(window, 'offline')) === true)
	const attemptsBefore = stub.attempts
	// 点「立即重试」：这次 boot 会成功（stub 只失败两次）。
	$(window, 'offlineRetry').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	const gone = await until(() => visible(window, 'offline') === false)
	check('点重试后连上了：这一屏自己消失，没有残留', gone === true, `offline=${visible(window, 'offline')}`)
	check('重试是**原地重跑**（又发了一次 boot 请求），不是整页刷新',
		stub.attempts > attemptsBefore && window.__reloads === 0,
		`boot 尝试 ${attemptsBefore} → ${stub.attempts}，reload ${window.__reloads} 次`)
	check('连上后应用界面出来了', visible(window, 'app') === true)
	window.close()
}

console.log(`\n  ${pass}/${pass + fail} checks passed`)
process.exit(fail === 0 ? 0 : 1)
