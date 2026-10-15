/**
 * 打包完整性（1.8.2 起）。跑法：
 *
 *   node test/package.mjs
 *
 * 为什么单开一个文件：这个 bug 在**本地永远看不见**。
 *
 * 我这台机器上用 `link:` 装插件 —— 它直接指向源码目录，也就是"整份源码都在"，
 * 所以 `files` 字段漏了哪个文件我一点感觉都没有。可是**从 GitHub 装的同学**，
 * pnpm 会按 `files` 打包：漏掉的文件根本不在包里。实测 1.8.1 的包：
 *
 *   package/lib/mobile.html   package/lib/index.js   package/package.json
 *   package/README.md         package/cordis.patch.yml        ← 就这些
 *
 * 而 `lib/index.js` 第 29 行是 `import { collectAddresses } from './addresses.js'`
 * —— 于是插件一加载就报找不到模块，手机页面打不开、一直转圈。
 * `lib/icons/*` 也一样漏了（图标 404）。
 *
 * 是同学那边（他自己的 DeepSeek）先报出来的：症状 + 排查办法 + 绕过办法都对。
 * 这条测试就是让同类错误**在下一次发布前**自己撞上来。
 */

import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
	if (ok) { pass += 1; console.log(`  PASS  ${name}${detail === '' ? '' : '  — ' + detail}`) }
	else { fail += 1; console.log(`  FAIL  ${name}${detail === '' ? '' : '  — ' + detail}`) }
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const entry = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')

/** `files` 是 glob 列表，这里只需要判断"这个相对路径会不会被打进去"。 */
function packedBy(rel) {
	const patterns = Array.isArray(pkg.files) ? pkg.files : []
	return patterns.some((pattern) => {
		const clean = String(pattern).replace(/^\.\//, '').replace(/\/+$/, '')
		return clean === rel || rel.startsWith(clean + '/') || clean === rel.replace(/\/[^/]+$/, '')
	})
}

// 1) 入口里 import 的每一个**本地相对模块**都必须在包里。
//    只查相对导入：`node:` 和裸包名由依赖负责，不归 files 管。
const localImports = [...entry.matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1])
check('入口里的相对导入都被解析出来了（自检：别把这条测试写成永远通过）',
	localImports.length > 0, localImports.join(', '))

const missing = []
for (const spec of localImports) {
	const rel = spec.replace(/^\.\//, 'lib/')
	if (rel.endsWith('.html')) continue          // 非 JS 资源单独判下面那条
	if (existsSync(join(ROOT, rel)) === false) continue
	if (packedBy(rel) === false) missing.push(rel)
}
check('入口 import 的本地模块一个都没被 files 落下（1.8.1 就是漏了 lib/addresses.js）',
	missing.length === 0, missing.join(', ') || localImports.join(', '))

// 2) 页面、图标这些"运行时才去取"的资源也得在包里 —— 它们不是 import，
//    上面那条查不到，所以按已知清单单独钉住。
for (const rel of ['lib/mobile.html', 'lib/icons/icon-180.png', 'lib/icons/icon-192.png', 'lib/icons/icon-512.png', 'cordis.patch.yml']) {
	check(`打包包含 ${rel}`, existsSync(join(ROOT, rel)) && packedBy(rel))
}

/*
 * 2b) **运行时会去读的数据文件**也必须在包里。
 *
 * 这条是同学那边报出来的（他自己的 DeepSeek 核对文案时发现）：`CHANGELOG.md` 没进 files，
 * 于是 `github:` 装的用户，服务端 `whatsNew()`（index.js 里 `readFileSync(join(HERE,'..','CHANGELOG.md'))`）
 * 读不到东西 → 「说明」页那块**是空的**，只有版本号。
 * 我本地是 `link:` 装（源码目录就在旁边），所以这条永远不会在我这儿露馅 ——
 * 和 1.8.2 漏 addresses.js 是**同一类盲区**，所以用同一张网兜住。
 */
{
	const entryText = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	const readFromRoot = [...entryText.matchAll(/readFileSync\(\s*join\(\s*HERE\s*,\s*'\.\.'\s*,\s*'([^']+)'/g)].map((m) => m[1])
	check('从包根目录读的文件被认出来了（自检）', readFromRoot.length > 0, readFromRoot.join(', '))
	// 这几个 npm 永远会打（不受 files 影响），别把它们算成"漏了"。
	const alwaysPacked = new Set(['package.json', 'README.md', 'LICENSE', 'LICENCE'])
	for (const name of readFromRoot) {
		if (alwaysPacked.has(name)) continue
		check(`打包包含运行时读取的 ${name}`, existsSync(join(ROOT, name)) && packedBy(name))
	}
}

// 3) 别再用"逐个文件列举"的写法：新增一个 lib 下的文件就会再漏一次。
check('files 覆盖整个 lib/（而不是逐个文件列举）',
	(Array.isArray(pkg.files) ? pkg.files : []).some((pattern) => String(pattern).replace(/^\.\//, '').replace(/\/+$/, '') === 'lib'),
	JSON.stringify(pkg.files))

/*
 * 4) **每个 .ps1 都必须带 UTF-8 BOM**（2026-10-11 真踩过 ✗）。
 *
 * PowerShell 5.1 在没有 BOM 时按 **ANSI（GBK）** 读 .ps1 —— 里面的中文注释会被解成乱码，
 * 有些字节序列还会把字符串的引号"吃掉"，于是脚本**直接语法错误**（报的还是
 * "Try statement is missing its Catch or Finally block" 这种完全不指向真因的话 ✗）。
 * 仓库里原有 11 个脚本都带 BOM ✓，所以这条是"跟着现有约定走"的机械检查 ——
 * 新加脚本忘了 BOM，在这里就会红，而不是等到用户双击运行才发现 ✓。
 */
{
	const toolsDir = join(ROOT, 'tools')
	const scripts = existsSync(toolsDir)
		? readdirSync(toolsDir).filter((name) => name.toLowerCase().endsWith('.ps1'))
		: []
	check('（自检）tools/ 下确实有 .ps1 可查', scripts.length > 0, `${scripts.length} 个`)
	const missingBom = scripts.filter((name) => {
		const bytes = readFileSync(join(toolsDir, name))
		return !(bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
	})
	check('每个 .ps1 都带 UTF-8 BOM（PS 5.1 无 BOM 会按 GBK 读 → 中文把脚本读坏）',
		missingBom.length === 0, missingBom.join(', ') || `${scripts.length} 个都带 ✓`)
}

/*
 * 5) **文本源里不许有"乱码替换字符"（U+FFFD）**（2026-10-11 真出过事故 ✗）。
 *
 * 现场：用 PowerShell 的 `Get-Content -Raw` + `Set-Content` 改 `lib/index.js` ——
 * PS 5.1 按 **ANSI/GBK** 读 UTF-8，中文被双重编码写回，**1641 个字符变成 U+FFFD**、
 * 还丢了换行，脚本直接语法崩 ✗。这种伤在 `git diff` 里非常显眼，但在"改完就跑测试"的
 * 节奏里，最该被**最便宜的一条断言**当场拦住 ✓ —— 所以放这儿。
 *
 * ⚠️ 顺带记下正确做法：改这些文件**只用编辑工具/Node**，别用 PS 的文本管道 ✗。
 */
{
	const { readdirSync: readdirNames } = await import('node:fs')
	const targets = []
	const walk = (dir, depth) => {
		if (depth > 2) return
		for (const name of readdirNames(join(ROOT, dir), { withFileTypes: true })) {
			if (name.name === 'node_modules' || name.name === '.git') continue
			const rel = dir === '' ? name.name : `${dir}/${name.name}`
			if (name.isDirectory()) { walk(rel, depth + 1); continue }
			if (/\.(js|mjs|html|md|json|ps1|yml)$/i.test(name.name)) targets.push(rel)
		}
	}
	walk('lib', 0)
	walk('test', 0)
	walk('tools', 0)
	/*
	 * 根目录这几份**也是文本源**（说明页读 `USERNEWS.md`、更新历史读 `CHANGELOG.md` ✓）——
	 * 以前没扫它们，所以一次"用 PS 改 README"留下的伤**谁也看不见** ✗（见下面那条 BOM 断言 ✓）。
	 */
	for (const name of ['README.md', 'CHANGELOG.md', 'USERNEWS.md', 'package.json', 'cordis.patch.yml']) {
		if (existsSync(join(ROOT, name))) targets.push(name)
	}
	check('（自检）扫到了该扫的文本源', targets.length > 10, `${targets.length} 个`)
	const mojibake = targets.filter((rel) => readFileSync(join(ROOT, rel), 'utf8').includes('\uFFFD'))
	check('没有文件被写成乱码（U+FFFD 一个都不许有 —— PS 文本管道改文件会留下它 ✗）',
		mojibake.length === 0, mojibake.join(', ') || `${targets.length} 个文件都干净 ✓`)
	/*
	 * **BOM 只该出现在 `.ps1` 上**（2026-10-12 加 ✓）。
	 *
	 * 现场：为了改两个数字，用 PowerShell 的 `Get-Content -Raw` + `Set-Content` 写了 `README.md` ——
	 * PS 5.1 的 `Set-Content -Encoding UTF8` 会**顺手加一个 BOM** ✗。内容没坏、U+FFFD 也没有，
	 * 所以当时**没有任何断言会红** ✓（假绿）；但它在 diff 里是一处噪声，Node 读文本时首行还会多一个 \uFEFF ✗。
	 * 需要 BOM 的只有 `.ps1`（PS 5.1 靠它认 UTF-8 ✓），其它文件一律不该有 ✓。
	 */
	const hasBom = (rel) => {
		const bytes = readFileSync(join(ROOT, rel))
		return bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
	}
	const ps1 = targets.filter((rel) => rel.toLowerCase().endsWith('.ps1'))
	const bomNotPs1 = targets.filter((rel) => rel.toLowerCase().endsWith('.ps1') === false && hasBom(rel))
	check('BOM 只出现在 .ps1 上（别处带 BOM = 用 PS 文本管道写过的白噪声 ✗）',
		bomNotPs1.length === 0, bomNotPs1.join(', ') || `非 .ps1 的 ${targets.length - ps1.length} 个文件都没有 BOM ✓`)
}

/*
 * 6) 说明页顶上那份「1.0 → 今 按主题的汇总」**必须跟着版本走**（3.4.2 加 ✓）。
 *
 * 现场（用户 2026-10-13 原话）：「说明 1.0 到 3.4.2 内容还是没改啊，都是 2.0 版本及以前的内容」✗ ——
 * 那份汇总是**手写**的（`lib/index.js` 的 `WHATS_NEW_THEMES` ✓），而维护成本只有一句
 * "发版时看一眼要不要补一行" ✓ —— 结果 **2.7 → 3.4 一整段都没补** ✗，用户看到的就是过时的说明 ✓。
 * 现在钉住：主题汇总里**至少一条提到当前 `major.minor`** ✓（发版时不补就红 ✓，逼着看一眼 ✓）。
 */
{
	const entrySource = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	const block = /const WHATS_NEW_THEMES = \[([\s\S]*?)\n\]/.exec(entrySource)?.[1] ?? ''
	const current = String(pkg.version).split('.').slice(0, 2).join('.')
	check('（自检）主题汇总那段被解析出来了（别把这条测试写成永远通过）',
		block.length > 200, `${block.length} 字符`)
	check(`说明页的「1.0 → 今 主题汇总」提到了当前版本（${current}）—— 发版忘了补，这里就红`,
		block.includes(current), current)
}

/*
 * 7) **文档里的默认值必须等于代码里的默认值**（4.3.0 加 ✓）。
 *
 * 现场（用户 2026-10-14）：「提权默认只保持 15 分钟改成一个小时」✓ —— 这类"改一个默认值"最容易漏的是
 * **文档里那两处** ✗（README 的 JSON 示例 + 字段表 ✓），而漏了没人看得出来 ✓（代码对、文档旧 ✓）。
 * 所以钉住：`DEFAULT_ELEVATION_MINUTES` 那个数字，必须**同时**出现在 README 的字段表行里 ✓。
 * ⚠️ 另一件必须写下来的事 ✗：这条默认值**只在配置里没写时生效** ✓ —— 老机器的
 * `mobile-bridge.json` 里那份显式值会被原样沿用 ✓（改默认救不了老机器 ✓，得改配置 ✓，
 * 4.3.0 就是这么做的 ✓ —— 见 CHANGELOG ✓）。
 */
{
	const entrySource = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
	const minutes = (/(?:^|\n)const DEFAULT_ELEVATION_MINUTES = (\d+)/.exec(entrySource) ?? [])[1] ?? ''
	check('（自检）从代码里读到了 DEFAULT_ELEVATION_MINUTES（别把这条写成永远通过）',
		/^\d+$/.test(minutes), minutes === '' ? '(没读到)' : `${minutes} 分钟`)
	check(`README 的字段表写的就是代码里的默认值（${minutes} 分钟）—— 改默认值忘了改文档，这里就红`,
		minutes !== '' && new RegExp('\\| `elevationMinutes` \\| ' + minutes + ' \\|').test(readme),
		(readme.match(/\| `elevationMinutes` \| (\d+) \|/) ?? ['(没找到字段表行)'])[0])
}

/*
 * 8) **电脑控制那两条路由必须挂在正确的闸上**（4.5.0 加 ✓）。
 *
 * 为什么用"读源码"这种形状来钉 ✗：提权是**按令牌**记的 ✓（`elevated(req)` ✓），
 * 而套件里要拿到令牌必须先输 PIN ✓ → **造不出"登录了但没提权"的会话** ✗，
 * 那条 `403 + needPin` 从 HTTP 层测不了 ✓（harness 里已注明"不假装测过" ✓）。
 * 所以这里至少要钉住：**动硬件的那条走 `guardWrite()`** ✓、只读那条走 `guard()` ✓ ——
 * 谁哪天把它改成 `guard()`，这里就红 ✓（这是这类回归**唯一**能自动拦住的地方 ✓）。
 */
{
	const entrySource = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	check('🔴 `POST /api/pc` 必须走 `guardWrite()` ✓（音量/亮度/蓝牙是"让电脑动手" ✓ —— 改成 guard() 就红 ✓）',
		/POST \/api\/pc'\)\s*return\s+guardWrite\(\)/.test(entrySource))
	check('`GET /api/pc` 只走 `guard()` ✓（读状态不改东西 ✓，不该多要一次 PIN ✓）',
		/GET \/api\/pc'\)\s*return\s+guard\(\)/.test(entrySource))
}

/*
 * 9) **`lib/pccontrol.js` 里的 PowerShell 脚本块必须是纯 ASCII**（4.6.0 加 ✓）。
 *
 * 现场（2026-10-15，一天之内咬了四次 ✗）：那些脚本是当**命令行参数**传给 PowerShell 5.1 的 ✓，
 * 中文进去会被按本地代码页解掉 ✗ —— **不会报语法错** ✓，只会**静默失灵** ✗
 *（第一版把中文关键词写进 PS 正则 ✓ → 脚本跑不通还卡满超时 ✓、列表回空 ✓）。
 * 所以拿一条断言把它钉住 ✓：脚本块里出现非 ASCII 就红 ✓。
 * 提取方法：从 `const X = ` 后面那个反引号开始扫 ✓ —— 要**认 `\`` 转义** ✗
 *（脚本里有 `IAsyncOperation\`1` 这种 PS 泛型名 ✓，认错了会把块切短 ✓）。
 */
{
	const source = await readFile(join(ROOT, 'lib', 'pccontrol.js'), 'utf8')
	const blocks = []
	const marker = /const\s+[A-Z_]+\s*=\s*`/g
	for (let m = marker.exec(source); m !== null; m = marker.exec(source)) {
		let i = m.index + m[0].length
		let out = ''
		while (i < source.length) {
			const ch = source[i]
			if (ch === '\\') { out += source.slice(i, i + 2); i += 2; continue }
			if (ch === '`') break
			out += ch
			i += 1
		}
		blocks.push(out)
	}
	check('（自检）从 lib/pccontrol.js 里抠出了 PowerShell 脚本块（别把这条写成永远通过）',
		blocks.length >= 3, `${blocks.length} 块`)
	const badLines = []
	for (const block of blocks) {
		for (const line of block.split('\n')) {
			if (/[^\x00-\x7F]/.test(line)) badLines.push(line.trim().slice(0, 60))
		}
	}
	check('🔴 PowerShell 脚本块里**一个非 ASCII 字符都没有** ✓（中文进去不会报错、只会静默失灵 ✗ —— 今天咬了四次 ✓）',
		badLines.length === 0, badLines.slice(0, 3).join(' ｜ ') || `${blocks.length} 块全是 ASCII ✓`)
}

/*
 * 10) 🔴 **赛博朋克背景：够动 + 不被挡住**（4.8.1 ✓）。
 *
 * 现场（用户 2026-10-15：「背景没有动态感太烂了不够惊艳，而且会被挡住」✓）：
 *   ① 上一版只有 1.7s 的网格 + 4.2s 的呼吸 ✓ → 看着几乎像静止 ✗；
 *   ② 压暗层 .45/.68 把整屏压黑 ✓ + 气泡太实 ✓ → 背景基本被挡没了 ✗。
 * 这几条把"修好之后的样子"钉住 ✓ —— 以后谁再把它调回去，测试就红 ✓。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	const layers = ['dsh-aurora', 'dsh-grid-flow', 'dsh-horizon-pulse', 'dsh-scan-drift', 'dsh-glitch', 'dsh-meteor-fly', 'dsh-moon-glow']
	check('🔴 够动：**五层以上**各自在动 ✓（光晕 / 网格 / 霓虹雨 / 地平线 / 扫描线 + 偶发故障闪 ✓）—— 上一版只有两层 ✗',
		layers.every((name) => page.includes('@keyframes ' + name)),
		layers.filter((name) => page.includes('@keyframes ' + name) === false).join(' ') || `${layers.length} 个动画都在 ✓`)
	check('🔴 网格速度是调快之后的 **0.85s** ✓（上一版 1.7s 被用户判为"没有动态感" ✗ —— 别再调回去 ✓）',
		page.includes('body.bg-cyber .scrim::before { animation: dsh-grid-flow 0.85s linear infinite; }'))
	check('🔴 网格透明度是 **.92** ✓（上一版 .72 压太狠 ✗ —— 保读字靠压暗层和气泡底 ✓，不是把网格调暗 ✗）',
		/body\.bg-cyber \.scrim::before \{[\s\S]*?opacity: \.92;/.test(page))
	check('🔴 不被挡住：压暗层让到 **.20/.34** ✓（上一版 .45/.68 把背景压没了 ✗）',
		page.includes('body.hasbg.bg-cyber #backdrop .scrim { background: linear-gradient(180deg, rgba(6,8,18,.20), rgba(6,8,18,.34)); }'))
	/*
	 * ⚠️ 4.8.3：这条原来盯的是 `.scrim::after`（那层斜线 ✗）—— 用户说「那些背景里面的线条…很丑」✓，
	 * 那层已经**删掉** ✓，所以改盯现在真正动起来的那几层 ✓（含新加的流星和月晕 ✓）。
	 */
	check('🔴 两条刹车**盖全**所有动起来的层 ✓（4.8.3 新加了流星和月晕 ✗ —— 漏一个就是"关不掉的动画" ✗）',
		/body\.bg-cyber\.bg-still[\s\S]{0,500}#sky \.meteor[\s\S]{0,200}moon::before/.test(page)
		&& /prefers-reduced-motion: reduce[\s\S]{0,500}#sky \.meteor[\s\S]{0,200}moon::before/.test(page))
	check('🔴 那层"很丑的斜线"**确实删掉了** ✓（`.scrim::after` 和 `dsh-rain` 都不该再出现 ✓）',
		page.includes('dsh-rain') === false && page.includes('.scrim::after {') === false)
	check('🔴 动画**只碰** background-position / opacity ✓（碰 filter/blur/宽高就会在手机上掉帧发热 ✗）',
		[...page.matchAll(/@keyframes (dsh-[a-z-]+) \{([\s\S]*?)\n\t\}/g)]
			.every(([, , body]) => /^(?:(?!filter|blur|width|height|inset|margin|padding|left|top)[\s\S])*$/.test(body)),
		[...page.matchAll(/@keyframes (dsh-[a-z-]+)/g)].map((m) => m[1]).join(' '))
}

/*
 * 11) 🔴 **月亮 + 流星（不是线）**（4.8.2 ✓）。
 * 用户 2026-10-15：「这流星雨就是线啊，你好歹把他改成流星的模样，最好再加上好看的月亮…
 * 而且可以流星雨划过对话框，更有感觉」✓。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 有星星那一层 ✓（`#sky` ✓ —— 月亮和流星都在这儿 ✓）', page.includes('<div id="sky"'))
	check('🔴 流星**有头**：亮核是独立一层 ✓（拖尾里那颗发光点 ✓）—— 上一版就是一条等宽的线 ✗',
		/#sky \.meteor \.streak::after \{[\s\S]*?radial-gradient\(circle, #ffffff/.test(page))
	check('🔴 流星**有尾**：拖尾是**渐隐**的 ✓（从透明到白 ✓）—— 等宽实线看着就是划线 ✗',
		/#sky \.meteor \.streak \{[\s\S]*?linear-gradient\(90deg,[\s\S]*?rgba\(255,255,255,0\)[\s\S]*?#ffffff 100%\)/.test(page))
	/*
	 * 🔴 4.8.3：**运动方式必须"轨迹和朝向分开"** ✓（用户：「你这个流星动作很奇怪」✓）。
	 * 上一版一个元素上写 `rotate() translate()` ✗ —— 位移在旋转后的坐标系里 ✓ → 尾巴方向和飞行方向不一定一致 ✓。
	 * 现在外层只管位移 ✓、内层只管朝向 ✓（`--dx/--dy/--ang` 三个变量必须**一起存在** ✓）。
	 */
	check('🔴 流星把"轨迹"和"朝向"拆成两层 ✓（外层 translate + 内层 rotate ✓ —— 上一版混在一起才显得奇怪 ✗）',
		/#sky \.meteor \{[\s\S]*?translate3d\(var\(--dx\), var\(--dy\)/.test(page)
		&& /#sky \.meteor \.streak \{[\s\S]*?transform: rotate\(var\(--ang\)\)/.test(page))
	check('🔴 斜向下：方向是**算出来的** ✓（`--dx` 负、`--dy` 正 ✓ 且 `--ang` 对得上 ✓ —— 不是凑的 ✗）',
		page.includes("const SKY_METEOR_ANG = '139deg'") && page.includes("const SKY_METEOR_DX = '-66vw'") && page.includes("const SKY_METEOR_DY = '58vh'"))
	check('🔴 月亮**搬到背景层**了 ✓（`#backdrop .moon` ✓）而且是**半透明** ✓（用户：「改成透明的放背景里」✓）',
		/body\.bg-cyber #backdrop \.moon \{[\s\S]*?opacity: \.72;/.test(page) && page.includes('#sky .moon') === false)
	check('🔴 月亮**不是个白球** ✓：月海 + 环形山 + **偏心的月相暗影** ✓（`::after` ✓ —— 这一层是"像不像真的"的分水岭 ✓）',
		page.includes('body.bg-cyber #backdrop .moon::after')
		&& /rgba\(118,136,184,\.45\)/.test(page) && /rgba\(6,10,26,\.66\)/.test(page))
	/*
	 * ⚠️ 这里第一版我写成 `page.match(/#sky \.moon::after \{[\s\S]*?radial-gradient/g).length >= 4` ✗ ——
	 * **非贪婪匹配到第一个 radial-gradient 就收尾** ✓，永远只能数到 1 ✓（断言当场红 ✓，等于自己抓自己 ✓）。
	 * 正确写法：先把**整块**抠出来 ✓，再在块里数 ✓。
	 */
	const moonCraters = /#sky \.moon::after \{([\s\S]*?)\n\t\}/.exec(page)?.[1] ?? ''
	check('🔴 「非常丑的那些斜线」没了 ✓，而月亮和流星还在 ✓（星空层里只剩流星 ✓ —— 月亮在背景层 ✓）',
		page.includes('<div id="sky"') && page.includes('body.bg-cyber #backdrop .moon {')
		&& page.includes('#sky .meteor .streak {'))
	check('🔴 **划过对话框** ✓：这一层在内容**之上**（z-index 2 > `#app` 的 1 ✓）',
		/z-index: 2;[\s\S]{0,200}pointer-events: none/.test(page))
	check('🔴 但**绝不拦点击** ✗ —— `pointer-events: none` ✓（划过归划过，点了必须有反应 ✓）',
		/body\.bg-cyber #sky \{[\s\S]*?pointer-events: none/.test(page))
	check('🔴 流星参数是**固定表** ✓（12 颗都在 ✓），不用 `Math.random()` ✗（随机会让截图对不上 ✓）',
		page.includes('const SKY_METEORS = [') && (page.match(/\{ x: '[+-]?\d+%', y: '/g) ?? []).length >= 12
		&& /SKY_METEORS[\s\S]{0,40}Math\.random/.test(page) === false,
		`${(page.match(/\{ x: '[+-]?\d+%', y: '/g) ?? []).length} 颗`)
	check('🔴 刹车管到流星 ✓（静下来 / 减弱动态 → `.meteor` 直接不显示 ✓，月亮留着 ✓）',
		page.includes('body.bg-cyber.bg-still #sky .meteor { display: none; }')
		&& page.includes('body.bg-cyber #sky .meteor { display: none; }'))
	check('🔴 流星只动 transform / opacity ✓（手机上才不掉帧 ✓）',
		/@keyframes dsh-meteor-fly \{[\s\S]*?\n\t\}/.exec(page)?.[0] !== undefined
		&& /filter|blur|width:|height:|margin:/.test(/@keyframes dsh-meteor-fly \{[\s\S]*?\n\t\}/.exec(page)[0]) === false)
}

/*
 * 12) 🔴 **任意图片背景也能"活"+ 配色跟着图走**（4.9.0 ✓）。
 * 用户 2026-10-15：「去水印后装上，画质不变，不要压缩，不要更改，然后对话框和文字改成合适的风格
 * 以及透明能够适配这张图片，一定要是动态图片装上去」✓。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 图片背景**会动** ✓（Ken Burns 缓慢推近 ✓ —— 静态图也有镜头感 ✓）',
		page.includes('body.hasbg.bg-live #backdrop img') && page.includes('@keyframes dsh-live-pan'))
	check('🔴 动效只碰 transform ✓（手机上不掉帧 ✓）',
		/from \{ transform: scale\(1\.18\)[\s\S]{0,120}to \{ transform: scale\(1\.28\)/.test(page))
	/*
	 * 水印：这台机器**没有 ffmpeg / jpegtran** ✗（无损裁 JPEG 的工具一个都没有 ✓），
	 * 重新编码一定掉画质 ✗ —— 而用户要求"画质不变、不要压缩、不要更改" ✓。
	 * 所以改成**画面层面裁**：scale ≥ 1.18 + **顶边为锚** ✓ → 底部约 15% 推出屏幕 ✓，文件一个字节不动 ✓。
	 */
	check('🔴 水印靠**显示裁掉** ✓（最小 scale 仍 ≥ 1.18 ✓、以顶边为锚 ✓ —— 全程不会露出来 ✓，文件不改 ✓）',
		page.includes('transform-origin: 50% 0') && /from \{ transform: scale\(1\.18\)/.test(page)
		&& page.includes('scale(1.28)'))
	check('🔴 暖金色调 ✓ + **更透明** ✓（气泡 .50 / 面板 .52 ✓ —— 用户要"透明能够适配这张图"✓）',
		/body\.hasbg\.bg-live \{[\s\S]*?--accent: #ffb454/.test(page)
		&& page.includes('body.hasbg.bg-live .bubble { background: rgba(16,18,26,.50)'))
	check('🔴 下半压得更重 ✓（那张图下半是亮水面 ✓ —— .30 → .62 ✓）',
		page.includes('rgba(8,9,14,.30) 0%, rgba(8,9,14,.30) 46%, rgba(8,9,14,.62) 100%'))
	check('🔴 图片背景也有流星 ✓（"一定要是动态" ✓），刹车也管到它们 ✓',
		page.includes('body.hasbg #sky { display: block') && page.includes('body.bg-still #sky .meteor { display: none; }')
		&& page.includes('body.bg-still #backdrop img { animation: none; }'))
}

console.log(`\n  ${pass}/${pass + fail} checks passed`)
process.exit(fail === 0 ? 0 : 1)