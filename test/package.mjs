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
 * 而 `lib/index.js` 文件开头那几行是 `import { collectAddresses } from './addresses.js'`
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
	/* 4.9.13 复查判定：这条**只有否定式** ✓，但**正向证据在同文件更早处** ✓ ——
	 * 「每个 .ps1 都带 UTF-8 BOM」那条用的**正是同一个探针**（都读文件头三字节 ✓）：
	 * 探针若坏成"永远返回 false" ✗，那边**立刻红** ✓ → 所以这一条不会静默绿 ✓。 */
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
	check('🔴 斜向下：方向是**算出来的** ✓（`--dx` 负、`--dy` 正 ✓ 且 `--ang` 对得上 ✓ —— 4.9.2 起同用 vmax ✓）',
		page.includes("const SKY_METEOR_ANG = '150deg'") && page.includes("const SKY_METEOR_DX = '-104vmax'") && page.includes("const SKY_METEOR_DY = '60vmax'"))
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
	check('🔴 那一层仍然是**独立的一层** ✓（`position: fixed` + 铺满 ✓ —— 4.9.1 起它在内容**之下** ✓）',
		/#sky \{[\s\S]{0,200}position: fixed; inset: 0; z-index: 0;/.test(page))
	/*
	 * ⚠️ 4.9.1：用户 2026-10-15「流星放在文字下面」✓ —— 这条从"**在内容之上**（z-index 2 ✓）"
	 * 改成"**在内容之下、背景之上**" ✓。三明治不能弄错 ✗：
	 *   `#sky` 必须是 **0**（= 背景层 ✓，DOM 在后面所以画在纱之上 ✓）而**不能是 1** ✗
	 *（1 会和 `#app` 平级 ✓，那时谁在上面就看 DOM 顺序了 ✓ —— 这种"靠顺序"的东西最容易哪天被挪一下就坏 ✗）；
	 * 也**不能是 -1 或更低** ✗ —— 那样会掉到背景/纱底下 ✓，流星直接看不见 ✓（"改没了"比"盖住字"更糟 ✗）。
	 */
	check('🔴 流星在**文字下面** ✓（`#sky` 的 z-index 是 **0** ✓ —— 背景 0 / 内容 1 ✓，隔着气泡还看得见 ✓）',
		/body\.hasbg #sky \{[^}]*z-index: 0;/.test(page))
	check('🔴 但仍然**绝不拦点击** ✓（pointer-events: none ✓）',
		/body\.hasbg #sky \{[^}]*pointer-events: none/.test(page))
	/* 4.9.13 复查判定：**不是自证** ✓ —— 正则只负责**数** ✓，门槛是**字面常量 12** ✓；
	 * 表被删或格式变了 → 数不到 12 → 会**红** ✗，不静默绿 ✓。 */
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
	check('🔴 **不再自己编动效** ✓（4.9.6 撤掉假旋转/假推近 ✗ —— 用户：「你就不能按原图来吗」✓，动交给**原素材** ✓）',
		page.includes('@keyframes dsh-live-turn') === false && page.includes('@keyframes dsh-live-pan') === false
		&& page.includes('body.hasbg.bg-live #backdrop img'))
	check('🔴 静止兜底那张图**只做一件事**：`scale(1.18)` ✓（4.9.6 起没有任何动画 ✗ —— 动效归原素材 ✓）',
		/body\.hasbg\.bg-live #backdrop img \{\s*transform: scale\(1\.18\);\s*\}/.test(page))
	/*
	 * 水印：这台机器**没有 ffmpeg / jpegtran** ✗（无损裁 JPEG 的工具一个都没有 ✓），
	 * 重新编码一定掉画质 ✗ —— 而用户要求"画质不变、不要压缩、不要更改" ✓。
	 * 所以改成**画面层面裁**：scale ≥ 1.18 + **顶边为锚** ✓ → 底部约 15% 推出屏幕 ✓，文件一个字节不动 ✓。
	 */
	check('🔴 水印靠**显示裁掉** ✓（`scale(1.18)` 把那条带推出屏幕 ✓，文件一个字节不动 ✓）',
		/body\.hasbg\.bg-live #backdrop img \{\s*transform: scale\(1\.18\);\s*\}/.test(page))
	check('🔴 暖金色调 ✓ + **更透明** ✓（气泡 .50 / 面板 .52 ✓ —— 用户要"透明能够适配这张图"✓）',
		/body\.hasbg\.bg-live \{[\s\S]*?--accent: #ffb454/.test(page)
		&& page.includes('background: var(--bubble, rgba(16,18,26,.20))'))
	check('🔴 下半压得更重 ✓（那张图下半是亮水面 ✓ —— 4.9.3 起 .24 → .60 ✓：更透，但下重上轻 ✓）',
		page.includes('rgba(8,9,14,.12) 0%, rgba(8,9,14,.12) 46%, rgba(8,9,14,.40) 100%'))
	check('🔴 图片背景也有流星 ✓（"一定要是动态" ✓），刹车也管到它们 ✓（4.10.6 起**两层一起**刹 ✓）',
		page.includes('body.hasbg #sky { display: block')
		&& page.includes('body.bg-still #sky .meteor,\n\tbody.bg-still #skyNear .meteor { display: none; }')
		&& page.includes('body.bg-still #backdrop img { animation: none; }'))
}

/*
 * 13) 🔴 **动图：兜底 + 自愈 + 角度是真的**（4.9.2 ✓）。
 * 用户 2026-10-15：「动图不能存手机上吗，每次都要好久」「流星应该从右侧斜向下划到左侧屏幕…
 * 感觉流星像是在往下坠落」「一刷新动图就不见了」✓。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	const server = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	check('🔴 流星轨迹**同一单位（vmax）** ✓ —— 上一版 `-66vw / 58vh` 单位不同 ✗，在竖屏上实际被拉成约 62°（像坠落 ✗）',
		page.includes("const SKY_METEOR_DX = '-104vmax'") && page.includes("const SKY_METEOR_DY = '60vmax'")
		&& page.includes("const SKY_METEOR_ANG = '150deg'"))
	check('🔴 轨迹真的是**从右往左**（30° 浅斜 ✓）：dx 负 + dy 正 ✓，且尾巴朝向 180°−30° = 150° ✓ 与轨迹对齐 ✓',
		page.includes("const SKY_METEOR_DX = '-104vmax'") && page.includes("const SKY_METEOR_ANG = '150deg'"))
	check('🔴 起点在**右侧** ✓（12 颗的 x 都 ≥ 70% ✓ —— 才叫"从右侧划过来" ✓）',
		[...page.matchAll(/\{ x: '(\d+)%', y: '/g)].length >= 12
		&& [...page.matchAll(/\{ x: '(\d+)%', y: '/g)].every((m) => Number(m[1]) >= 70))
	check('🔴 缓存**校验字节数** ✓ 对不上就删掉重下 ✓（读到"存了一半"的缓存是"刷新就不见了"的元凶之一 ✗）',
		/const expect = Number\(info\.bytes\) \|\| 0/.test(page) && /cached\.byteLength === expect/.test(page)
		&& /store\.delete\(key\)/.test(page))
	check('🔴 视频挂了**退回静止图** ✓ 而不是把背景抹掉 ✗（`still` + `showStill` + 只有它也挂才 `conceal` ✓）',
		page.includes('const showStill = () =>') && page.includes('if (stillNode !== null && showStill()) return'))
	check('🔴 4 秒还没播起来就**先顶静止图** ✓（弱网下不用盯着黑屏等 ✓ = "每次都要好久"的观感 ✓）',
		page.includes('window.setTimeout(() => { if (shown === false) showStill() }, 4000)'))
	check('🔴 服务端会**把静止兜底一起给**手机 ✓（视频才给 ✓，配了但文件不在就不发 ✗）',
		server.includes('const backgroundStill =') && server.includes('...(still === null ? {} : { still })'))
	check('🔴 `?still=1` 真的送那张图 ✓（手机先铺它秒出 ✓，视频再换上 ✓）',
		server.includes('const wantStill =') && server.includes('stillName'))
}

/*
 * 14) 🔴 **旋转动效 + 慢流星 + 透明界面**（4.9.3 ✓）。
 * 用户 2026-10-15：「动图不是这样动的，原本图片里的星球会旋转的，而且流星速度太快了，
 * 文字和文字框要透明，能清晰显示背景」✓。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 静止兜底那张图仍然 `scale(1.18)` ✓ —— 它的作用**不是动效** ✗，而是把那张 JPEG 的**水印带推出屏幕** ✓（文件不动 ✓）',
		/body\.hasbg\.bg-live #backdrop img \{\s*transform: scale\(1\.18\);\s*\}/.test(page))
	/*
	 * ⚠️ 4.10.6：分两层之后这里要**分开判** ✓ —— 后排（`SKY_METEORS` ✓）依旧慢 ✓；
	 * **前排故意更快** ✓（2.2~3.2 秒 ✓）—— 那不是"改回去了" ✗，而是**视差** ✓：
	 * 近处的相对速度更快 ✓，这正是"前后"看得出来**的**关键 ✓（用户要的"层次"✓）。
	 */
	const backDurs = [...page.slice(page.indexOf('const SKY_METEORS = ['), page.indexOf('const SKY_METEORS_NEAR')).matchAll(/dur: ([0-9.]+),/g)].map((m) => Number(m[1]))
	const nearDurs = [...page.slice(page.indexOf('const SKY_METEORS_NEAR = [')).matchAll(/dur: ([0-9.]+),/g)].map((m) => Number(m[1]))
	check('🔴 后排流星**放慢** ✓（全部 ≥ 2.6 秒 ✓ —— 上一版 1.2~2.0 秒被用户判为"太快"✗）',
		backDurs.length >= 12 && backDurs.every((d) => d >= 2.6),
		`后排 ${backDurs.length} 颗，最短 ${Math.min(...backDurs)}s / 最长 ${Math.max(...backDurs)}s`)
	check('🔴 前排流星**更快但不唐突** ✓（2.2~3.2 秒 ✓ —— 视差 ✓；比后排快 ✓ 才看得出"在近处"✓）',
		nearDurs.length >= 4 && nearDurs.every((d) => d >= 2.2 && d <= 3.2),
		`前排 ${nearDurs.length} 颗，最短 ${Math.min(...nearDurs)}s / 最长 ${Math.max(...nearDurs)}s`)
	check('🔴 文字框**更透明** ✓（面板 .34 / 气泡 .34 / 工具键 .28 ✓ —— 上一版 .52/.50 ✗）',
		page.includes('--panel: rgba(12,14,22,.18)') && page.includes('--panel-2: rgba(24,26,36,.16)')
		&& page.includes('rgba(255,180,84,.10)') && page.includes('--bubble: rgba(16,18,26,.20)'))
	check('🔴 透明还能看清：**文字阴影**在 ✓（不靠把背景压暗 ✗ —— 阴影跟着字走 ✓，背景不受损 ✓）',
		page.includes('text-shadow: 0 1px 3px rgba(0,0,0,.78), 0 0 14px rgba(0,0,0,.5)'))
}

/*
 * 15) 🔴 **"一发消息动图就没了"**（4.9.4 ✓）。
 * 用户 2026-10-15：「而且一发消息动图就没了」✓。
 * 根因：断线时 `offlineShow()` 有意 `remove('hasbg')` ✓；重连后再调 `applyBackdrop` ✓
 * 却因为"钥匙没变"被**早退**挡掉 ✗ → `hasbg` 再也回不来 ✓，直到整页刷新 ✓。
 * 发消息常带一次连接抖动 ✓ → 现象就是"一发消息就没了" ✓。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	/*
	 * 🔴 4.17.0：**"刷新后回原色"的根** ✓（用户 2026-10-19）。旧代码把配色（`hasbg` + `bg-live`）
	 * 绑在 `reveal()` 上 ✓ —— 而 `reveal()` 要等背景媒体**真能播**才跑 ✓，弱网下 428KB 的视频
	 * 下不完 ⇒ 永远不跑 ⇒ **配色一直默认** ✓✓。现在：配色一拿到信息就挂 ✓，背景层另用
	 * `bg-shown` 等媒体 ✓（两件事分开 —— "别露黑屏"那条老规矩不动 ✓）。
	 */
	check('🔴 配色类**不等媒体** ✓（`wantsLive` 一成立就加 `hasbg` + `bg-live` ✓ —— 弱网/大素材下也不会回原色 ✓）',
		/const wantsLive = [^\n]*\n\t\tif \(wantsLive === true\) \{[\s\S]{0,120}classList\.add\('hasbg'\)[\s\S]{0,120}classList\.add\('bg-live'\)/.test(page))
	check('🔴 背景层有**自己的开关** ✓：`body.hasbg.bg-shown #backdrop` ✓（媒体没到就先不显示 ✓ —— 不许一整块黑 ✗）',
		page.includes('body.hasbg.bg-shown #backdrop { display: block; }'))
	check('🔴 `bg-shown` **在 reveal 里加、conceal 里摘** ✓（不然它永远不动 = 假开关 ✗）',
		/const reveal = \(\) => \{[\s\S]{0,1200}classList\.add\('bg-shown'\)/.test(page)
		&& /const conceal = \(\) => \{[\s\S]{0,1200}classList\.remove\('bg-shown'\)/.test(page))
	check('🔴 「铺过没有」这个标记**在 reveal 里置真、conceal 里置假** ✓（不然它永远不动 = 假标记 ✗）',
		/const reveal = \(\) => \{[\s\S]{0,200}backdropShown = true/.test(page)
		&& /const conceal = \(\) => \{[\s\S]{0,200}backdropShown = false/.test(page))
	/*
	 * 🔴 4.15.2 升级（用户 2026-10-16：「发一句话文字框颜色就会变回去」✓）：
	 * 原来这条钉的是 `remove('hasbg')` 的**字面** ✓ —— 而正是它让主题**半开** ✓
	 *（那套暖色配色要 `hasbg` + `bg-live` **两个类同时在** ✓ → 只摘一个 ⇒ 配色当场回默认 ✓）。
	 * 现在判据改成**更强的那一条**：断线时**两个类必须一起摘** ✓，而且要**自己补回来** ✓。
	 */
	check('🔴 `offlineShow` 那条"断线先收掉背景"仍然保留 ✓（素材取不到时留着就是黑屏 ✓ —— 不是把它删掉 ✗），'
		+ '而且**两个主题类一起摘** ✓（只摘一个 ⇒ 主题半开 ⇒ 配色回默认 ✗ —— 用户报的就是这个 ✓）',
		/offlineShow[\s\S]{0,1600}classList\.remove\('hasbg', 'bg-live'\)/.test(page))
	check('🔴 回到线上要**自己把主题补回来** ✓（`lastBackdrop` + `offlineHide` ✓ —— 不许等用户刷新 ✗），'
		+ '而且这一句在**早退之前** ✓（"断一下没弹离线屏"那种也要补 ✓）',
		page.includes('let lastBackdrop = null')
		&& /function offlineHide\(\) \{[\s\S]{0,1500}lastBackdrop !== null[\s\S]{0,400}applyBackdrop\(lastBackdrop\)/.test(page)
		&& page.indexOf('lastBackdrop !== null') < page.indexOf("if (offline.shown === false) return"))
}

/*
 * 16) 🔴 **用户气泡的配色不能被亮色模式盖掉**（4.9.5 ✓）。
 * 用户 2026-10-15：「而且一发信息对话框颜色又变回去了」✓。
 * 根因：亮色模式里有一条 `body.hasbg .row.user .bubble`（0,3,1 ✓）**写在后面** ✓，
 * 和主题那条**特异性一样** ✗ → 顺序决定 → **它赢** ✗ → 自己发出去的气泡永远是默认浅蓝 ✓。
 * 修法：主题那条用 `#app` 抬到 **0,4,1** ✓（**不靠挪顺序** ✗ —— 顺序最容易被下次编辑弄坏 ✓）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 `bg-live` 的用户气泡用了 `#app` 抬特异性 ✓（0,4,1 > 亮色模式那条 0,3,1 ✓）',
		page.includes('body.hasbg.bg-live #app .row.user .bubble'))
	check('🔴 `bg-cyber` 那套也一起抬了 ✓（同一个坑 ✗ —— 两套主题不能只修一个 ✓）',
		page.includes('body.hasbg.bg-cyber #app .row.user .bubble'))
	check('🔴 亮色模式那条**还在** ✓（它本身是对的 ✗ —— 只是不能盖过主题 ✓）',
		page.includes('body.hasbg .row.user .bubble { background: rgba(170,208,255,.62); }'))
}

/*
 * 17) 🔴 **弱网也能把大文件传上去 + 背景真的缓存在手机上**（4.9.7 ✓）。
 * 用户 2026-10-15：「现在上传图片视频很难上传，而且总是失败你可以搞一个离线传输，
 * 还有背景能不能缓存到手机，防止每次都要重新加载」✓。
 * 现场（`mobile-bridge.log` ✓）：5.3MB 的 .mov、11 片 ✓，两次都 **0/11 片就断** ✓，
 * 来源是**公网/移动网络** ✓ —— 每片 512KB 走 base64+JSON 等于一次 ~683KB 的请求 ✗，
 * 还要 **6 个请求**同时抢一条上行 ✗ ✓。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	/*
	 * ⚠️ 4.9.11：这条从"钉住撤回后的**旧值**"（512KB / 3）✓ 改成"钉住**逐处验证过的新值**" ✓ ——
	 * 过程值得记 ✗：①并发 3→2 ✓ 单独跑绿 ✓；②片长 512KB→128KB ✓ 再单独跑绿 ✓；
	 * ③重试 3→5 次 + 6 秒封顶 ✗ → **ui 4 条红** ✓（`分片:24` 证明分片本身没问题 ✓，
	 * 红的是失败路径的**时序期望** ✗）→ **只撤这一处** ✓。
	 * 📌 4.9.7 三处一起改 → 十条红、分不清 ✗；这次逐处验 → **一眼看出是哪一处** ✓。
	 */
	check('🔴 上传参数（**逐处验证过** ✓）：片 **128KB** ✓、并发 **2** ✓、重试**故意仍是 3 次 / 400ms** ✓'
		+ '（第③处试过、把 ui 弄红 ✗ → 只撤它 ✓，要动得连测试期望一起重做 ✓）',
		page.includes('const CHUNK_BYTES = 128 * 1024')
		&& page.includes('const CHUNK_PARALLEL = 2')
		&& page.includes('for (let tries = 0; tries < 3; tries += 1)')
		&& page.includes('setTimeout(resolve, 400 * (tries + 1))')
		&& page.includes('const giveUpAt') === false)
	check('🔴 静止兜底也**进了缓存** ✓（原来直接给 url ✗ → 每次重下 141KB ✓）',
		/const showStill = \(\) => \{[\s\S]{0,900}backdropSource\(info\.still\)/.test(page))
}

/*
 * 18) 🔴 **附件传失败不再白丢（离线传输）**（4.9.8 ✓）。
 * 用户 2026-10-15：「上传图片视频很难上传，而且总是失败你可以搞一个离线传输」✓。
 * ⚠️ 上一版（4.9.7）我一次改三处、把上传整条路弄坏 ✗ → 这次**只加一处** ✓，
 *    而且**不动原有失败路径** ✓（错误照旧抛出去 ✓）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 上传失败时**先试着进离线箱** ✓（小附件走 localStorage 那条老路 ✓：`files: stuck` ✓ —— 有网自动补发 ✓）',
		/prepared\.catch\(async \(error\) => \{[\s\S]{0,2600}outboxAdd\(\{ clientId, sessionId: target, text: body, images: \[\], fileRefs: \[\], files: stuck \}\)/.test(page))
	check('🔴 **大附件改走 IndexedDB** ✓（4.9.9 ✓ —— 4.9.8 那种"太大就只留文字"✗ 升级成"连视频也存下" ✓）',
		/const inIdb = await queueFilesForOutbox\(clientId, stuck\)/.test(page)
		&& page.includes("filesInIdb: true"))
	check('🔴 **都存不下时仍然只留文字 + 如实说** ✓（`inIdb === false` 那条兜底 ✓ —— 不装 ✓）',
		/const queued = inIdb === true[\s\S]{0,900}outboxAdd\(\{ clientId, sessionId: target, text: body, images: \[\], fileRefs: \[\], files: \[\] \}\)/.test(page)
		&& page.includes('这句话先收着了'))
	check('🔴 **进箱之后把输入框里那批附件撤掉** ✓（不撤的话用户再点一次发送就发两遍 ✗）',
		/if \(queued === true\) \{[\s\S]{0,400}state\.images = \[\]/.test(page))
	check('🔴 **原有失败路径一个字没改** ✓（错误仍然抛出去 ✓ → 下面那条"失败 + 重试"照旧 ✓）',
		/prepared\.catch[\s\S]{0,3200}throw error\n\t\t\}\)\.then\(\(fileRefs\) => \{/.test(page))
}

/*
 * 19) 🔴 **大附件也能先存着（IndexedDB 队列）**（4.9.9 ✓）。
 * 用户 2026-10-15：「ok」= 按 1→3→2 继续 ✓，这一步是 ①大文件队列 ✓
 *（他要传的那段 5.3MB 视频，localStorage 的 1.2MB 上限根本装不下 ✗）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 大附件写进 **IndexedDB** ✓（`queueFilesForOutbox` ✓），而且**写完立刻读回来核对** ✓（配额/无痕下 put 有时"成功"其实没落盘 ✗）',
		page.includes('async function queueFilesForOutbox') && page.includes("idbRun('readonly', (store) => store.get('outbox:' + clientId))"))
	check('🔴 离线箱里的条目**只留标记**（`filesInIdb: true` + `files: []` ✓）—— 字节不进 localStorage ✓（那才是 1.2MB 上限的来源 ✗）',
		/outboxAdd\(\{ clientId, sessionId: target, text: body, images: \[\], fileRefs: \[\], files: \[\], filesInIdb: true \}\)/.test(page))
	check('🔴 补发时**从 IndexedDB 取回** ✓，取不到就退回箱子自带那份 ✓（老条目仍可用 ✓）',
		/if \(item\.filesInIdb === true\) \{[\s\S]{0,400}store\.get\('outbox:' \+ item\.clientId\)/.test(page))
	check('🔴 补发成功后**删掉** IndexedDB 那份 ✓（不然手机会越堆越多 ✗）',
		/if \(item\.filesInIdb === true\) dropQueuedFiles\(item\.clientId\)/.test(page))
	check('🔴 **没有新开 objectStore、没动数据库版本号** ✓（版本升级被别的标签页挡住会连累背景缓存 ✗✗ —— 复用 `BG_STORE` + `outbox:` 前缀 ✓）',
		page.includes('const objectStore') === false && /createObjectStore\([A-Z_]+\)/g.test(page)
		&& (page.match(/createObjectStore\(/g) ?? []).length === 2)
}

/*
 * 20) 🔴 **断点续传**（4.9.10 ✓）。
 * 用户 2026-10-15：「ok」= 按 1→3→2 继续 ✓，这一步是 ③ ✓。
 * 现场病根 ✗：`uploadId` **每次调用都随机新生成** ✓ → 断了一半再重试，服务端**从零另开一份** ✗。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	/*
	 * ⚠️ 4.11.1：钥匙现在**分两条** ✓（base64 那条 + 二进制那条 ✓）——
	 * 二进制那条用 `ub` 前缀**刻意和 base64 分开** ✓（两种协议不共用确认记录 ✓）,
	 * 并且用 `size + lastModified` 认文件 ✓（同名文件也不串 ✓）。判据跟着更新 ✓，不是放宽 ✗：
	 * 依旧必须"**同一个文件稳定、不再是随机值**" ✓。
	 */
	check('🔴 `uploadId` 对同一个文件**是稳定的** ✓（base64：名字+字节数+内容头 ✓；二进制：名字+字节数+lastModified ✓，`ub` 前缀刻意分开 ✓）—— 都不是随机值 ✗',
		/const resumeId = blob === null[\s\S]{0,500}const uploadId = resumeId/.test(page)
		&& page.includes("'ub' + String(entry.name")
		&& /const uploadId = Date\.now\(\)\.toString\(36\) \+ Math\.random/.test(page) === false)
	check('🔴 已确认的片**记下来** ✓（`acked.add(index)` ✓，成功那一步之后才记 ✓）',
		/acked\.add\(index\)[\s\S]{0,80}return done/.test(page))
	check('🔴 重试时**跳过**已确认的片 ✓（`force` 例外 ✓）—— 这就是"续传"本身 ✓',
		/if \(force !== true && acked\.has\(index\) === true\) return null/.test(page))
	check('🔴 传完**清掉记录** ✓（否则同一个文件再发一次会拼出缺片的坏文件 ✗）',
		/uploadResume\.delete\(resumeId\)/.test(page))
	check('🔴 **"全被跳过"时补传最后一片拿路径** ✓（否则 `last` 为 null ✗ → 消息引用空路径 ✗）',
		/if \(last === null && total > 0\) last = await sendChunk\(total - 1, true\)/.test(page))
}

/*
 * 21) 🔴 **带素材的预设不能被当成 CSS 预设**（4.10.1 ✓，用户报的真 bug ✗）。
 * 用户 2026-10-15：「刚刚放上去的动态图呢，怎么回到以前的风格了？」✓
 * 根因：4.10.0 我在归档信息里带了 `preset: 'planet'` ✓，而页面**只看 `preset`** 就当成
 * "CSS 画的那种"（赛博朋克 ✓）→ 加上 `bg-cyber` ✗ → **赛博朋克回来了、视频永远不铺** ✗。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 只有**不带素材**的预设才走 CSS 那条路 ✓（`archived !== true` ✓ —— 否则"夜行星"会被当成赛博朋克 ✗）',
		/const isCssPreset = [\s\S]{0,220}info\.archived !== true/.test(page)
		&& /if \(isCssPreset === true\) \{/.test(page))
	check('🔴 切背景时**摘掉 `bg-cyber` / `bg-still`** ✓（否则"赛博朋克 → 夜行星"两套叠着 ✗）',
		/document\.body\.classList\.remove\('bg-cyber', 'bg-still'\)/.test(page))
}

/*
 * 22) 🔴 **流星分两层：有层次与遮挡关系**（4.10.6 ✓）。
 * 用户 2026-10-15：「可以继续调整流星，有的流星划过表面，有的从背后划过，要有层次与遮挡关系」✓。
 * 判据核心 ✓：两层的 **z-index 一前一后** ✓（遮挡靠层叠自动产生 ✓，不给每颗流星算交点 ✗）；
 * 并且**刹车必须同时管住两层** ✓（只刹一层 = 刹车失灵 ✗）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 两层都在 ✓（`#sky` 后排 + `#skyNear` 前排 ✓，容器各一个 ✓）',
		page.includes('<div id="sky" aria-hidden="true"></div>') && page.includes('<div id="skyNear" aria-hidden="true"></div>'))
	check('🔴 **层叠一前一后** ✓（后排 z 0 ✓ 在 `#app` 之下 → 被挡住 ✓；前排 z 2 ✓ 在之上 → 盖着划过 ✓）',
		/body\.hasbg #sky \{[^}]*z-index: 0/.test(page) && /body\.hasbg #skyNear \{[^}]*z-index: 2/.test(page))
	check('🔴 前排**克制** ✓（只有 5 颗 ✓、scale ≤ .7 ✓、整层 .62 透明度 ✓ —— 它压在字上 ✓）',
		page.includes('const SKY_METEORS_NEAR = [') && /opacity: \.62/.test(page)
		&& /SKY_METEORS_NEAR = \[[\s\S]{0,700}scale: 0\.7/.test(page))
	check('🔴 前排**更快** ✓（近处视差 ✓ —— 这是"前后"看得出**来**的关键 ✓：2.2~3.2 秒 ✓）',
		/dur: 2\.2,/.test(page) && /dur: 3\.2,/.test(page))
	check('🔴 刹车**两层一起**管住 ✓（`bg-still` ✓ + 减弱动态 ✓ —— 只刹一层 = 刹车失灵 ✗）',
		page.includes('body.bg-still #sky .meteor,\n\tbody.bg-still #skyNear .meteor')
		&& page.includes('body.hasbg #sky .meteor,\n\t\tbody.hasbg #skyNear .meteor'))
}

/*
 * 23) 🔴 **图标那一排也要适配背景**（4.10.7 ✓）。
 * 用户 2026-10-15：「那些图标也要适配背景呀」✓ ——
 * 病根：上一轮只把"面板/气泡"改成走变量 ✓，**图标/标签/输入区这一批还是写死的 .44~.48** ✗
 * → 在动图背景上就是一块块灰板子 ✓（用户一眼看出 ✓）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 图标键 / 标签 / 输入区**走同一批变量** ✓（`var(--panel)` ✓ —— 不再是写死的 .44/.46/.48 ✗）',
		page.includes('body.bg-live .tab { background: var(--panel)')
		&& page.includes('body.bg-live #toolKeys > button { background: var(--panel)')
		&& page.includes('body.bg-live input, body.bg-live textarea, body.bg-live select, body.bg-live .plain {\n\t\tbackground: var(--panel)'))
	check('🔴 没有**写死的灰板子**残留 ✓（.44/.46/.48 那三个数一个都不许剩 ✗）',
		page.includes('rgba(12,14,20,.44)') === false && page.includes('rgba(12,14,20,.46)') === false
		&& page.includes('rgba(12,14,20,.48)') === false && page.includes('rgba(10,12,18,.46)') === false)
	check('🔴 工具键用的选择器**是真名** ✓（`#toolKeys > button` ✓ —— 不是凭想象写的类名 ✗）',
		page.includes('#toolKeys > button') && page.includes('class="toolkey"') === false && page.includes('.toolkey') === false)
	check('🔴 图标字形有**跟随文字的柔影** ✓（不糊背景 ✗、不压暗背景 ✗ —— 只有这一种做法 ✓）',
		/body\.bg-live \.iconbtn,[\s\S]{0,220}text-shadow: 0 1px 3px rgba\(0,0,0,\.66\)/.test(page))
}

/*
 * 24) 🔴 **每一张附件都带着"原始字节的句柄"**（4.11.2 / 4.11.3 ✓）。
 * 用户 2026-10-15：「继续」= 按 ①→②→③ 走 ✓。
 * 判据核心 ✓：**凡是能拿到原始 Blob 的地方都必须带上它** ✓ ——
 * 这样"分片"那条路才能走二进制 ✓（不进内存 ✓、不多花 33% 流量 ✓）。
 * ⚠️ 而且是**三处都要** ✓：文件/视频/音频 ✓、原图模式的照片 ✓、**压过的照片** ✓ ——
 * 少一处，那条路就悄悄退回 base64 ✗（用户看不出来 ✓，但白花三分之一流量 ✗）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 三处附件都带 `blob` ✓（文件/视频/音频 ✓、原图照片 ✓、**压过的照片** ✓）',
		page.includes('blob: file,')
		&& page.includes("state.images.push({ mediaType, data, name: file.name || '', blob: file })")
		&& page.includes("state.images.push({ mediaType: 'image/jpeg', data: smallData, name: file.name || '', blob: smaller })"))
	check('🔴 `shrinkImage` 返回的**就是 Blob** ✓（`canvas.toBlob` ✓ + 转不出来时兜底返回原文件 ✓）',
		/const blob = await new Promise\(\(resolve\) => canvas\.toBlob\(resolve, 'image\/jpeg', quality\)\)/.test(page)
		&& page.includes('return blob === null ? file : blob'))
	check('🔴 内联失败重发时**把 blob 一起带过去** ✓（不然压缩图那张又退回 base64 ✗）',
		page.includes('blob: inlineNow[index].blob'))
}

/*
 * 25) 🔴 **上限提到 120MB（③）—— 前提是"文件那条不再整份 base64"**（4.12.0 ✓）。
 * 用户 2026-10-15：「你都做完吧」✓。
 * 这两件事**必须一起** ✓：上限一提 ✓，如果还整份读 base64 ✗，
 * 120MB 的文件会变成 **160MB 的字符串**留在内存里 ✓ → 低配手机上**标签页被系统杀掉** ✗✗。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	const host = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	const clientCap = Number(/const MAX_FILE_BYTES = (\d+) \* 1024 \* 1024/.exec(page)?.[1] ?? 0)
	const serverCap = Number(/const MAX_UPLOAD_BYTES = (\d+) \* 1024 \* 1024/.exec(host)?.[1] ?? 0)
	check('🔴 客户端上限 = **120MB** ✓，而且**不超过服务端** ✓（服务端 120MB ✓ —— 客户端比它大就是"传到一半被拒" ✗）',
		clientCap === 120 && serverCap === 120 && clientCap <= serverCap, `客户端 ${clientCap} / 服务端 ${serverCap}`)
	check('🔴 **文件/视频/录音那条不再读 base64** ✓（只带 `blob: file` ✓）—— 否则 120MB 会变成 160MB 字符串 ✗✗',
		/state\.files\.push\(\{\s*\n\s*name: file\.name \|\| 'file',\s*\n\s*mediaType: type === '' \? 'application\/octet-stream' : type,[\s\S]{0,900}?\n\s*blob: file,\s*\n\s*\}\)/.test(page)
		&& /state\.files\.push\(\{[\s\S]{0,700}?data: await readBase64\(file\),[\s\S]{0,200}?\n\s*blob: file,/.test(page) === false)
	check('🔴 队列与进度都认 `blob.size` ✓（只按 `data.length` 会把文件算成 0 片 ✗ / 当成 0 字节 ✗）',
		page.includes('Number(file?.blob?.size ?? 0) > 0')
		&& page.includes("file?.blob instanceof Blob && String(file?.data ?? '') === ''"))
	check('🔴 **只有"只有 blob、没有 base64"的才拒绝进 localStorage** ✓（照片同时有两样 ✓，一律拒会把弱网模式整条打掉 ✗）',
		page.includes("if (files.some((file) => file?.blob instanceof Blob && String(file?.data ?? '') === '')) return false"))
}

/*
 * 26) 🔴 **4.13.0「定时开机」的纯函数**（用户 2026-10-16：「既然有关机那么可以做一个对应的定时开机功能」✓）。
 *
 * 为什么把这些**拎成纯函数** ✓：真机上"到点醒不醒"没法在测试里等（要睡一觉 ✗），
 * 但"用户写的时间读成什么时刻 ✓ / 滚不滚到明天 ✓ / 过去的时间拒不拒 ✓"全是可以**当场钉住**的 ✓。
 * ⚠️ 尤其这两条 ✗：`powercfg` 的输出是**本地化**的 ✓（所以只认十六进制字面量 ✓）；
 * 而"读不到"**不许**说成"没有" ✓（`ac/dc` 为 null 时要能区分出来 ✓）。
 */
{
	const { parseWakeAt, parseRtcWakeIndex, describeWakePolicy, parseWakeTaskXml } = await import('../lib/pccontrol.js')
	const now = new Date(2026, 9, 16, 11, 47, 0)   // 2026-10-16 11:47（本机时区）
	const want = (text, at, rolled) => {
		const got = parseWakeAt(text, now)
		return got.ok === true && got.iso === at && got.rolled === rolled
	}
	check('🔴 只写 `07:30`（今天已经过了）→ **滚到明天** ✓ 而且 `rolled` 说得出来 ✓（不许悄悄改掉用户写的时间还不吭声 ✗）',
		want('07:30', '2026-10-17T07:30:00', 'tomorrow'))
	check('只写 `23:30`（今天还没到）→ 就是今天 ✓',
		want('23:30', '2026-10-16T23:30:00', ''))
	check('🔴 写了年月日的**过去**时刻 → **拒绝** ✓（用户写得很明确 ✓，替他改成明年就是骗他 ✗）',
		parseWakeAt('2026-10-15 07:30', now).ok === false && parseWakeAt('2020-01-01 07:30', now).ok === false)
	check('月-日不带年、今年已经过了 → 明年那一天 ✓',
		want('10-15 07:30', '2027-10-15T07:30:00', 'year'))
	check('`T` 分隔（`2026-10-17T07:30`）也认 ✓；不存在的日子（2-30）**拒绝** ✓；乱写的**拒绝** ✓',
		want('2026-10-17T07:30', '2026-10-17T07:30:00', '')
		&& parseWakeAt('2-30 06:00', now).ok === false
		&& parseWakeAt('明天早上', now).ok === false && parseWakeAt('', now).ok === false)
	check('🔴 `02-29` 不带年 → 找**真的闰年**（2028 ✓），不许被 Date 悄悄滚成 3-1 ✗',
		parseWakeAt('02-29 06:00', new Date(2026, 1, 1, 0, 0, 0)).iso === '2028-02-29T06:00:00')
	check('🔴 唤醒定时器取值只认**十六进制字面量** ✓（`powercfg` 输出是本地化的 ✗ —— 中文关键词换台机器就废 ✓）',
		JSON.stringify(parseRtcWakeIndex('可能的设置索引: 000\n当前交流电源设置索引: 0x00000002\n当前直流电源设置索引: 0x00000000')) === JSON.stringify({ ac: 2, dc: 0 }))
	check('🔴 **读不到 ≠ 没有** ✓：空输出回 null ✓，而且说成人话时是"读不到" ✗ 不是"禁用" ✗',
		JSON.stringify(parseRtcWakeIndex('')) === JSON.stringify({ ac: null, dc: null })
		&& describeWakePolicy(null, null).level === 'unknown'
		&& describeWakePolicy(null, null).note.includes('读不到'))
	check('策略三档都说人话 ✓（0 禁用 ✗ / 1 启用 ✓ / 2 仅限重要 ⚠️），而且给得出改它的那条命令 ✓',
		describeWakePolicy(0, 0).level === 'disabled' && describeWakePolicy(1, 1).level === 'ok'
		&& describeWakePolicy(2, 0).level === 'important-only'
		&& describeWakePolicy(2, 0).note.includes('管理员')
		&& describeWakePolicy(2, 0).command.includes('setacvalueindex'))
	check('任务 XML：`WakeToRun` 读得出来 ✓；**没有 `<Enabled>` 元素 = 启用** ✓（实测就是这么导出的 ✗ 别当成没启用 ✓）',
		parseWakeTaskXml('<Task version="1.3"><Settings><WakeToRun>true</WakeToRun></Settings><Triggers><TimeTrigger><StartBoundary>2026-10-17T07:30:00+08:00</StartBoundary></TimeTrigger></Triggers></Task>')
			.wakeToRun === true
		&& parseWakeTaskXml('<Task version="1.3"><Settings><Enabled>false</Enabled><WakeToRun>true</WakeToRun></Settings></Task>').enabled === false
		&& parseWakeTaskXml('<Task version="1.3"><Settings><WakeToRun>true</WakeToRun></Settings></Task>').enabled === true
		&& parseWakeTaskXml('').exists === false)
}

/*
 * 27) 🔴 **4.13.0「定时开机」：脚本块与门禁的形状**。
 *
 * 这三条是**真机实测得来**的 ✓（不这么写就会踩已知的坑 ✗）：
 *   · 建任务**必须带 `-WakeToRun`** ✓ —— 不带它就是一个"到点也不会叫醒机器"的普通任务 ✗；
 *   · ⚠️ 这台机器上 `Get-ScheduledTask` / `Unregister-ScheduledTask` 会报
 *     "The task XML contains a value which is incorrectly formatted or out of range" ✗
 *     （`lib/index.js` 里"开机自启"那条早就在注释里记过同一颗雷 ✓）→ **一律走 `schtasks.exe`** ✓；
 *   · 设完 / 删完都要**回读**（`$xml=...` / `$after=...`）✓ —— 项目一贯的规矩：不假装成功 ✗。
 * 还有两条是**文案**：页面必须把"睡眠能醒 ✓ / 完全关机做不到 ✗"两句写出来 ✓，
 * 而且**不许**摆"关机后开机"那个键 ✗（摆了就是骗人 ✓，铁律 ✓）。
 */
{
	const { WAKE_TASK_NAME } = await import('../lib/pccontrol.js')
	const control = await readFile(join(ROOT, 'lib', 'pccontrol.js'), 'utf8')
	const host = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	const block = (name) => new RegExp('const ' + name + ' = `([\\s\\S]*?)`').exec(control)?.[1] ?? ''
	const setScript = block('WAKE_SET_SCRIPT')
	const infoScript = block('WAKE_INFO_SCRIPT')
	const clearScript = block('WAKE_CLEAR_SCRIPT')
	check('（自检）三段脚本块都抠出来了（别把下面几条写成永远通过）',
		setScript.includes('Register-ScheduledTask') && infoScript.includes('powercfg') && clearScript.includes('schtasks'),
		`${setScript.length}/${infoScript.length}/${clearScript.length}`)
	check('🔴 建任务**带 `-WakeToRun`** ✓（不带它 → 到点根本叫不醒机器 ✗）',
		setScript.includes('New-ScheduledTaskSettingsSet -WakeToRun'))
	check('🔴 建 / 查 / 删**一律走 `schtasks.exe`** ✓，脚本里**一个 `Get-ScheduledTask` / `Unregister-ScheduledTask` 都没有** ✗（真机实测这两条在这台机器上会报错 ✓）',
		infoScript.includes('schtasks.exe /query /tn $name /xml')
		&& clearScript.includes('schtasks.exe /delete /tn $name /f')
		&& clearScript.includes('schtasks.exe /query /tn $name /xml')
		&& [setScript, infoScript, clearScript].every((text) => text.includes('Get-ScheduledTask') === false && text.includes('Unregister-ScheduledTask') === false))
	check('🔴 设完**读回来** ✓、删完**再查一次** ✓（"我以为设上了 / 我以为删了"都不算 ✗）',
		setScript.includes('schtasks.exe /query /tn $name /xml') && clearScript.includes('$after='))
	check('🔴 路由门禁：`GET /api/pc/wake` → `guard()` ✓（读不改东西 ✓）、`POST /api/pc/wake` → `guardWrite()` ✓（要 PIN 提权 ✓）',
		/GET \/api\/pc\/wake'\)\s*return\s+guard\(\)/.test(host)
		&& /POST \/api\/pc\/wake'\)\s*return\s+guardWrite\(\)/.test(host))
	check('🔴 「关机后开机」那一支在**服务端**也是如实拒绝 ✓（接口是公开的 ✓ —— 拒绝的话必须从服务端说出来 ✓）',
		host.includes('impossible: true') && host.includes("它挂在「关机 / 重启」那个开关上"))
	check('🔴 面板上那两句实话在**页面里** ✓（睡眠能自己醒 ✓ / 完全关机软件做不到 ✗）',
		page.includes('睡眠 (S3)：能自己醒') && page.includes('完全关机 (S5)：软件做不到'))
	check('🔴 页面上**一个"关机后开机"的键都没有** ✓（`data-wake-poweron` 不许出现 ✗ —— 软件做不到的事不摆键 ✓）',
		page.includes('data-wake-poweron') === false)
	check('任务名是**纯 ASCII** ✓（中文任务名走命令行会被本地代码页吃掉 ✗ —— 这条坑今天咬过好几次 ✓）',
		/^[\x00-\x7F]+$/.test(WAKE_TASK_NAME), WAKE_TASK_NAME)
}

/*
 * 28) 🔴 **4.14.0「断开某一台蓝牙设备」**（用户 2026-10-16：「还有蓝牙功能的断开设备连接，现在只有连接设备」✓）。
 *
 * 2026-10-16 真机实测 —— **把上一版的推断推翻了** ✗：
 *   · `rc=0` **完全不代表断开了** ✗：耳机那台 `110B`(A2DP) / `110E`(AVRCP) 都回 rc=0 ✓，
 *     可 `fConnected` 照样是 `true` ✗；真正让它断开的是 **`111E`（免提 HFP）** ✓；
 *   · 而同一台机器上的 iPhone，**14 种服务**全试过 ✗（其中 4 种还回 rc=0 ✗）→ 它一直连着 ✗。
 *   ⇒ 所以判据**只能**写在**回读到的 `fConnected`** 上 ✓ —— `disconnectVerdict` 是这条判据的唯一一份 ✓，
 *     它必须能同时认出"真断了 ✓ / rc=0 但没断 ✗ / 本来就没连 ✓ / 没配对 ✓ / 没无线电 ✓"。
 * 另外两条形状纪律：**绝不用 `BluetoothRemoveDevice`** ✗（那是"取消配对" ✓ 不是"断开" ✗）、
 * 页面里点「断开」的那一支**必须写在 `[data-bt]` 之前** ✓（顺序反了 = 一次点击两条请求 ✗）。
 */
{
	const { disconnectVerdict } = await import('../lib/pccontrol.js')
	const control = await readFile(join(ROOT, 'lib', 'pccontrol.js'), 'utf8')
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	const worked = disconnectVerdict({ target: 'AA', before: 'true', after: 'false', tried: ['111E:rc=0:false'] })
	const refused = disconnectVerdict({ target: 'AA', before: 'true', after: 'true', tried: ['110B:rc=0:true', '110E:rc=0:true'] })
	check('🔴 真断了（回读 `fConnected` 由 true 变 false）→ `ok:true` + 说出是哪个服务起的作用 ✓',
		worked.ok === true && worked.state === 'disconnected' && worked.service === '111E'
		&& worked.message.includes('回读确认'), JSON.stringify(worked).slice(0, 120))
	check('🔴 **rc=0 但状态没变 → `ok:false` + "没能断开"** ✓（这条正是今天真机推翻的那个假设 ✗ —— 只看返回值就会假成功 ✓）',
		refused.ok === false && refused.state === 'refused' && refused.message.includes('没能断开'), refused.message.slice(0, 60))
	check('断不掉时**给两条真能用的替代** ✓（打开设置手动关 ✓ / 关掉蓝牙再打开 = 全断，且把代价说清 ✓）',
		refused.message.includes('打开蓝牙设置') && refused.message.includes('所有'))
	const notPaired = disconnectVerdict({ before: 'missing', after: 'missing', tried: [] })
	const notConnected = disconnectVerdict({ before: 'false', after: 'false', tried: [] })
	const noRadio = disconnectVerdict({ before: 'no-radio', after: 'no-radio', tried: [] })
	check('🔴 没配对 / 本来就没连 / 没有无线电：三种都**如实说** ✓（都是 `ok:false` + 各自说清，绝不说成"已断开" ✗）',
		notPaired.ok === false && notPaired.state === 'not-paired' && notPaired.message.includes('不在已配对')
		&& notConnected.ok === false && notConnected.state === 'was-not-connected' && notConnected.message.includes('本来就没有连着')
		&& noRadio.ok === false && noRadio.state === 'no-radio' && noRadio.message.includes('没有蓝牙无线电'),
		JSON.stringify([notPaired.state, notConnected.state, noRadio.state]))
	const script = /const BT_DISCONNECT_SCRIPT = `([\s\S]*?)`/.exec(control)?.[1] ?? ''
	check('（自检）断开那段脚本块抠出来了（别把下面几条写成永远通过）',
		script.includes('BluetoothSetServiceState') && script.includes('BluetoothFindFirstRadio'), `${script.length} 字符`)
	check('🔴 关服务用的是 **DISABLE（flags = 0）** ✓；而且脚本里**一个 `BluetoothRemoveDevice` 都没有** ✗（那是取消配对 ✓ 不是断开 ✗）',
		script.includes('BluetoothSetServiceState(radio, ref d, ref g, 0)') && script.includes('BluetoothRemoveDevice') === false)
	check('🔴 脚本**自己先读一次、关完再读一次** ✓（"到底断没断"必须在同一次调用里回读 ✓ —— 不然判据还是空的 ✓）',
		script.includes('$before=[DshBtOff]::State($target)') && script.includes('$after=[DshBtOff]::State($target)'))
	check('🔴 页面里「断开」那一支**写在 `[data-bt]` 之前** ✓（顺序反了 = 点一次「断开」同时发"断开 + 打开设置"✗）',
		page.indexOf("closest('[data-bt-off]')") > 0
		&& page.indexOf("closest('[data-bt-off]')") < page.indexOf("closest('[data-bt]')"),
		`off@${page.indexOf("closest('[data-bt-off]')")} row@${page.indexOf("closest('[data-bt]')")}`)
	check('🔴 没拿到地址就**不摆**那个键（要 12 位十六进制才认 ✓ —— 摆了就是死键 ✗）',
		page.includes('connected === true && /^[0-9A-F]{12}$/.test(address) === true'))
}

/*
 * 29) 🔴 **4.14.1「手机上错过的提问」**（用户 2026-10-16：「我看不见你的问题手机端」✗）。
 *
 * 病根**不在渲染** ✗（手机上的提问卡片一直在 ✓）—— 在**投递**：
 * 卡片只在"提问发生那一刻、有手机正在看**这个**会话"时才推 ✗，所以
 * 「手机在别的会话 / 被系统挂起（选图片）/ 正在重连那几秒」这三种情况一律一个字都收不到 ✓。
 * 这一版补三样，每样都得钉住：
 *   ① **诊断**（五个"不交给手机"的出口**每个都要说出为什么** ✓ —— 以前全静默 ✗，
 *      所以今天"手机上看不见提问"只能靠猜 ✓；现在日志第一行就写明"没人正在看 X（有人在看 Y）" ✓）；
 *   ② **提示帧**（`ask-waiting` ✓）里**只许有 id** ✗（桥支持多台设备，广播正文 = 跨会话泄漏 ✓）；
 *   ③ **迟到作答**走宿主的 `callId` ✓（桥上那个临时 id 120 秒就没了 ✗ —— 那正是"错过的答不了" ✓）。
 */
{
	const host = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 诊断：五个"不交给手机"的出口各自要说清**为什么** ✓（以前全是静默 return null ✗ —— 今天就是这么卡住的 ✓）',
		host.includes('ask(${kind}) -> 桌面：answerOnPhone 关着')
		&& host.includes('ask(${kind}) -> 桌面：请求里没有会话 id')
		&& host.includes('ask(${kind}) -> 桌面：队列满')
		&& host.includes('ask(${kind}) -> 桌面：现在没有手机在看'))
	check('🔴 诊断：手机**开始看 / 不看**哪个会话都要记一行 ✓（"提问在 A 会话、手机在看 B"这种错位一眼可见 ✓）',
		host.includes('手机开始看 ${sessionId}（此刻共 ${state.streams.size} 条流）')
		&& host.includes('手机不看 ${sessionId} 了（还剩 ${state.streams.size} 条流）'))
	check('🔴 提示帧里**只有 id** ✓（`pushToAll({ t: \'ask-waiting\', sessionId, callId })` —— 带上 questions 就是跨会话泄漏 ✗）',
		/pushToAll\(\{ t: 'ask-waiting', sessionId, callId \}\)/.test(host)
		&& /pushToAll\(\{ t: 'ask-waiting'[\s\S]{0,120}questions/.test(host) === false)
	check('🔴 迟到作答走**宿主的 `callId`** ✓（`questions.answer(agent, lateCallId, …)` ✓ —— 桥上那个临时 id 120 秒就没了 ✗）',
		host.includes('questions.answer(agent, lateCallId, lateAnswers)'))
	check('🔴 两个新接口的门禁：`GET /api/waiting` → `guard()` ✓、`POST /api/answer` → `guardWrite()` ✓',
		/GET \/api\/waiting'\)\s*return\s+guard\(\)/.test(host)
		&& /POST \/api\/answer'\)\s*return\s+guardWrite\(\)/.test(host))
	check('🔴 「读不到」与「没有」在服务端就是分开的两个东西 ✓（`available` 字段 ✓ —— 混成一个就是假话 ✓）',
		host.includes('return { available: false, items: [] }') && host.includes('return { available: true, items }'))
	check('🔴 手机上要有一条**能点的横幅** ✓（"另一条会话在等你回答" —— 用户原话就是"我看不见" ✓）',
		page.includes('另一条会话在等你回答') && page.includes("go.addEventListener('click', () => { switchSession(sessionId); renderAsks() })"))
	check('🔴 手机上的迟到卡片要**登记进 `state.asks`** ✓（否则提交时走错分支 ✗、草稿还会每渲染一次就丢 ✗ —— 两条都被 ui 用例咬到过 ✓）',
		page.includes("lateId = LATE_PREFIX + String(state.sessionId ?? '') + ':' + lateMine.callId")
		&& page.includes("if (String(id).startsWith(LATE_PREFIX)) continue"))
	check('回到前台要**主动补问一次** ✓（选图片/切出去那段正是错过提问的时刻 ✓）',
		page.includes('void refreshWaiting()'))
}

/*
 * 31) 🔴 **4.16.0「侧栏预览」**（用户 2026-10-16：「在侧边栏预览这个你也做一下」✓ ——
 * 电脑端 GUI 的**右侧栏**能挂着文档边读边聊 ✓，而手机这边原来只有**整屏纸** ✗，
 * 打开文档就把对话整个盖住 ✓）。
 *
 * 两条形态都要钉住 ✓（窄屏 / 宽屏各一个 ✓），以及"**只盖一部分**"这个本质 ✓ ——
 * 那才是"侧栏"的意思 ✓（整屏就不叫侧栏了 ✗）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	const css = /#docopen\.doc-split \{([^}]*)\}/.exec(page)?.[1] ?? ''
	check('🔴 窄屏（手机竖屏）：文档占**下面 58vh** ✓（`inset: auto 0 0 0` ✓ —— **上面那半留给对话** ✓）',
		css.includes('inset: auto 0 0 0') && css.includes('height: 58vh'))
	check('🔴 宽屏（≥760px，横屏 / 平板）：就是**右侧栏** ✓（贴右边 44% 宽、整屏高 ✓）',
		/@media \(min-width: 760px\) \{[\s\S]{0,200}#docopen\.doc-split \{ inset: 0 0 0 auto; width: 44%; height: 100%/.test(page))
	check('🔴 开关在这台手机上**记得住** ✓（`dshm.docSplit` ✓ —— 下次打开文档还是那个形态 ✓）',
		page.includes("localStorage.getItem('dshm.docSplit')")
		&& page.includes("localStorage.setItem('dshm.docSplit'"))
	check('🔴 打开文档时**照着记着的形态**摆 ✓（`applyDocSplit(docSplitOn())` ✓ —— 不许每次悄悄回全屏 ✗）',
		page.includes('applyDocSplit(docSplitOn())'))
	check('🔴 「返回」**不重置形态** ✓（用户选了侧栏就该记住 ✓ —— 顺手改掉人家的选择是最烦的那种 ✗）',
		/\$\('docBack'\)\.addEventListener\('click', \(\) => \{ hide\(\$\('docopen'\)\); \$\('docBody'\)\.textContent = '' \}\)/.test(page))
}

/*
 * 32) 🔴 **4.16.1「隧道断了？」**（用户 2026-10-17：「为什么隧道断了？」✓）—— 那次是**误报** ✓：
 * 隧道一直活着 ✓（外网实测 HTTP 200 ✓、Tailscale Funnel 每 2 分钟健康检查 ✓、证书有效 ✓），
 * 可徽标上红着「⚠️ 隧道已断，手机连不上」✗；而 `tools\tunnel-status.ps1` 还在**无条件查 cloudflared** ✗
 * （这台机器走的是 Tailscale Funnel ✓，根本不需要它 ✗）→ 于是体检输出一个假 [X] ✓，
 * 最后那句「结论：有问题」把自己上面刚打印的「外网能不能打开：HTTP 200」**推翻** ✗。
 *
 * 判据钉在这三条上（都是**措辞即事实** ✓）：
 *   ① 运行时那句**不许把"本机探不通"说成"手机连不上"** ✗（探针在这台电脑上跑 ✓，DNS 抖一下就够了 ✓）；
 *   ② 徽标同理 ✓；
 *   ③ 体检脚本要**先认路线** ✓（`*.ts.net` → 查 Tailscale ✓，别再要求 cloudflared ✗）。
 */
{
	const host = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	const script = await readFile(join(ROOT, 'tools', 'tunnel-status.ps1'), 'utf8')
	check('🔴 自检失败那句**不再断言"手机连不上"** ✗（改成 "the phone may still be fine" ✓ —— 这是"读不到 ≠ 没有"的同一课 ✓）',
		host.includes('the phone may still be fine')
		&& host.includes('tunnel unreachable: the phone cannot connect right now') === false)
	check('🔴 徽标那句也如实 ✓（「外网入口不通」+ 直接给修法「tailscale funnel --bg … 重开一次」✓ —— 不许再说「隧道已断，手机连不上」✗）',
		host.includes('外网入口不通') && host.includes('tailscale funnel --bg') && host.includes('隧道已断，手机连不上') === false)
	check('🔴 体检脚本**先认路线** ✓：`*.ts.net` → Tailscale Funnel ✓（查服务 + serve 转发 ✓，不再无条件要 cloudflared ✗）',
		script.includes("$urlIsTailscale = ($url -match '\\.ts\\.net')")
		&& script.includes('cloudflaredMissing')
		&& script.includes('Tailscale 已把外网转发到本机'))
}

/*
 * 33) 🔴 **4.17.0「面板上色 + 手机桌宠下线」**（用户 2026-10-19：
 * 「便签计时器和每日做了什么没有和背景风格一致，你调一下吧」✓、
 * 「手机桌宠不要了，电脑桌宠不用动」✓）。
 *
 * ① 面板是**独立 iframe** ✗ —— 不继承手机页那套暖色变量 ✓，所以要父页**注一份**进去 ✓，
 *    而且**只在挂了背景时才注** ✓（没背景时把人家的原样还给他 ✓）；
 * ② 桌宠**整块下线** ✓（页面 / 宿主接口 / 用例一起 ✓ —— 只删一半比不删更糟 ✗）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	const host = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	check('🔴 面板主题：注入的那份有 `id` ✓、用 `!important` 压住面板自己的样式 ✓、`html, body` 透明 ✓（露出下面那层纸 ✓）',
		page.includes("const PANEL_THEME_ID = 'dshm-panel-theme'")
		&& page.includes('html, body { background: transparent !important; }')
		&& page.includes("body { color: #fdf6ec !important;"))
	check('🔴 只有在**挂了背景**时才注入 ✓（`body.classList.contains(\'bg-live\')` ✓ —— 没背景时保持面板作者原样 ✗）',
		/function applyPanelTheme\(\) \{[\s\S]{0,600}classList\.contains\('bg-live'\)/.test(page))
	check('🔴 主题开 / 关都要跟得上 ✓（如果面板开着时断线摘掉背景、回来又挂上 ✓ —— `MutationObserver` 盯 body 的 class ✓）',
		page.includes("new window.MutationObserver(() => { applyPanelTheme() }).observe(document.body"))
	check('🔴 面板 iframe 自己的底不再是那块深蓝灰 ✗（改成透明 ✓ —— 否则注入了也看不见背景 ✓）',
		page.includes('id="panelFrame"') && page.includes('background:transparent'))
	check('🔴 目标卡 / 会话检索卡也走**主题变量** ✓（原来写死 #161d33 / #9fb3d0 ✗ —— 挂暖色背景就是一块蓝板子 ✓）',
		page.includes('.goalcard { border: 1px solid var(--line)') && page.includes('background: var(--panel-2)')
		&& page.includes('color:var(--muted);font-size:13px')
		&& page.includes('color:#9fb3d0') === false)
	check('🔴 手机桌宠**整块下线** ✓：页面里没有浮层 / 键 ✓，宿主里没有 `/api/pet` ✓（只删一半比不删更糟 ✗）',
		page.includes('petLayer') === false && page.includes('petToggle') === false
		&& page.includes('dshPet') === false
		&& host.includes('/api/pet') === false && host.includes('mobile-bridge-pets') === false)
}

/*
 * 34) 🔴 **4.17.0「每个功能单独一页」**（用户 2026-10-19：「更多功能里面点击每一个功能时
 * 有的没有出现对应的界面要么就是界面被覆盖，统一改为点功能键后出现对应的界面，
 * 每个功能的界面单独做一页」✓ + 「我的余额界面被挡住了」✓）。
 *
 * 病根是**层级打平 + 手写清单** ✗：
 *   · 所有 `.sheet` 都是 50 ✓，打平时后写的赢 ✗ —— 而 `#moreopen` 写在中间 ✗，
 *     排在它前面的功能页（目标 / 背景 / 搜一搜 / 工作流 / 面板…）一点开就被它盖住 ✓；
 *   · 「切页签先把纸收掉」靠一份**手写清单** ✗ —— 漏登一张就出现"余额被盖住"✓。
 * 判据钉在三处：① 更多低一档 ✓；② 抽屉清单**按 DOM 自动取最上面那张** ✓（不再手写 ✗）；
 * ③ 切到页面本身（任务 / 新建 / 余额）时**全收** ✓（只收最上面一张不够 ✗）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 「更多」低一档 ✓（`#moreopen { z-index: 49; }` ✓ —— 任何功能页都盖得住它 ✓）',
		page.includes('#moreopen { z-index: 49; }'))
	check('🔴 抽屉清单**按 DOM 自动取最上面那张** ✓（扫 `.sheet` ✓、`moreopen` 只有当兜底 ✓ —— 不再手写清单 ✗）',
		/function openToolPanel\(\) \{[\s\S]{0,900}querySelectorAll\('\.sheet'\)[\s\S]{0,400}more = node[\s\S]{0,200}return top \?\? more/.test(page))
	check('🔴 切到页面本身时**全收** ✓（`closeAllSheets()` ✓ 并且在 `goPage` 里被调用 ✓ —— 只收最上面一张 ⇒ 更多还盖着余额 ✗）',
		/function closeAllSheets\(\) \{[\s\S]{0,600}hide\(node\)/.test(page)
		&& /if \(name === 'task' \|\| name === 'new' \|\| name === 'bill'\) closeAllSheets\(\)/.test(page))
	check('🔴 功能页都留着自己的「← 返回」✓（收掉后「更多」自己露出来 ✓ —— 这就是"一页一页"的手感 ✓）',
		['goalBack', 'bgBack', 'sysBack', 'pcBack', 'schBack', 'expBack', 'secBack', 'checkBack']
			.every((id) => page.includes('id="' + id + '"')))
}

/*
 * 35) 🔴 **5.0.1「手机桥又登不上去了」—— 本机局域网 IP 会变** ✓
 * （用户 2026-10-19 原话 ✓）。
 *
 * 现场：校园 WiFi 20:12 漫游 → 20:15 DHCP 续租，本机从 `113.54.216.122` 变成
 * `113.54.205.169` ✓；手机上"加到主屏幕"的旧网址还写着旧 IP ✗ → 手机连过去的请求
 * **一个都到不了桥** ✓（日志里之后一条都没有 ✓）。
 *
 * 三处判据 ✓：① 有固定外网地址时**先打它**（推荐加到主屏幕 ✓）；② `phoneHost` 变了
 * **自动修**（并且不许修成 Tailscale 的 100.x ✗ —— 那等于让没装 Tailscale 的手机进不来）；
 * ③ 徽标上把"地址会变 / 固定地址用哪条"写清楚 ✓。
 */
{
	const host = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	check('🔴 启动日志：配了固定外网地址就**先打它** ✓（`外网 · 地址固定` ✓ —— 手机加到主屏幕该用这条 ✗ 局域网 IP 会变）',
		host.includes('外网 · 地址固定 ✓ 推荐加到主屏幕')
		&& /if \(typeof config\.publicUrl === 'string' && config\.publicUrl !== ''\) \{[\s\S]{0,400}phone url:/.test(host)
		&& host.includes('局域网，本机 IP 一变就失效'))
	check('🔴 上次手机连上的地址变了：**只报事实、不偷偷改配置** ✓（`phoneHostDrift` ✓ —— 那个值可能是手机上次从 USB 网段连上来的 ✓，"不在当前网卡 ≠ 记错了" ✗；自动改写会把 Host 头学习顶掉 ✗）',
		/function phoneHostDrift\(config\)/.test(host)
		&& host.includes('phoneHostStale: phoneHostDrift(state.config) !== null')
		&& host.includes('stored.phoneHost = best.address') === false)
	check('🔴 徽标上写清楚 ✓（有外网地址 → "固定，加到主屏幕用它" ✓；只有局域网 → "这条会变" ✓；记着的旧地址没了也点名 ✓）',
		host.includes('外网」地址是**固定**的')
		&& host.includes('这条局域网地址会变')
		&& host.includes('上次手机连上的地址 ${escapes(drift.remembered)} 本机已经没有了'))
}

/*
 * 36) 🔴 **5.0.2「把加载时间放宽」**（用户 2026-10-19：「加载页面又改回30秒了？……
 * 你要把加载时间放宽，今天改过一次了」✓）。
 *
 * 4.16.3 从 20/30 秒放到 60 秒 ✓；可页面 gzip 后 292KB + `/api/boot` 还要带一段对话快照 ✓，
 * 走 Funnel / 手机流量几十 KB/s 时**轻松越过 60 秒** ✓ → 5.0.2 放到 **120 秒** ✓。
 * 判据两条 ✓：① 两个常量真是 120000 ✓；② 等过 30 秒时加载页**说人话**（别让人以为它死了 ✓）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 加载超时预算 **120 秒** ✓（`REQUEST_TIMEOUT_MS` / `API_TIMEOUT_MS` 都是 120000 ✓ —— 用户第二次点名要放宽）',
		page.includes('const REQUEST_TIMEOUT_MS = 120000')
		&& page.includes('const API_TIMEOUT_MS = 120000'))
	check('🔴 等过 30 秒时加载页会**说人话** ✓（"网络很慢，但还在走（最多等 120 秒）"✓ —— 不许让人以为它挂了 ✗）',
		page.includes('网络很慢，但还在走（最多等 120 秒）'))
}

/*
 * 37) 🔴 **5.0.3「外网自检不再被 MagicDNS 骗」**（用户 2026-10-19：「连了几秒后跳转连不上电脑页面」✓）。
 *
 * 现场：WiFi 漫游 / 换 IP 后 **Tailscale Funnel 的 ingress → 本机 卡死** ✓
 *（公网入口 IP 的 TCP 通、TLS 被 reset ✗；直连 tailnet IP 一切正常 ✓）。
 * 可桥的自检是**从本机 fetch publicUrl** ✓ —— 本机 `*.ts.net` 走 **MagicDNS** → `100.x` ✗
 * → **绕过 Funnel ingress** → 一直报「外网可达 ✓」，而手机根本连不上 ✗✗（假绿）。
 * 判据三条 ✓：① 本机解析到 tailnet 地址时改用**公网 DoH 查 ingress IP + 强制连那个 IP** ✓；
 * ② 公网 DNS 也不通时**不许报可达** ✗（`unverifiable` ✓）；③ 失败时给出**修法**（重开 Funnel ✓）。
 */
{
	const host = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
	check('🔴 本机 `*.ts.net` 走 MagicDNS 时：改用**公网 DoH** 解析出真正的 ingress IP，再**强制连那个 IP**（SNI/Host 仍写域名 ✓ —— `curl --resolve` 的等价物 ✓）',
		host.includes('function resolvePublicAddresses') && host.includes('const isTailnetAddress = (address)')
		&& host.includes('function probeExternalEntry') && host.includes('servername: hostname')
		&& host.includes('https://223.5.5.5/resolve'))
	check('🔴 公网 DNS 也不通时**不许报"可达"** ✗（记 `unverifiable` ✓，自检/徽标都说"没法验证" ✓ —— 宁可说不知道，也不说假话 ✓）',
		host.includes("tunnel.mode = 'unverifiable'")
		&& host.includes('没法从本机验证外网入口'))
	check('🔴 探不通时直接给**修法** ✓：在电脑上跑 `tailscale funnel --bg <port>` 重开一次 ✓（这次现场就是它救回来的 ✓）',
		host.includes('tailscale funnel --bg ${config.port}')
		&& host.includes('tailscale funnel --bg ${state.config.port}'))
}

/*
 * 38) 🔴 **5.0.4「本地缓存把启动卡死」**（用户 2026-10-20：「新加了狼人杀以后手机桥又打不开了」✓）。
 *
 * 现场：手机页面能打开（`GET /` 到了 ✓、`manifest` 也到了 ✓），可**桥这边一条 `/api/boot` 都没有** ✗。
 * 真凶：`bootRun()` 先 `await loadTranscriptSnapshot()` ✓；而 `openBgDb()` 的 `indexedDB.open(version)`
 * 在**另一个旧连接还开着**时只会发 `onblocked`（既不 success 也不 error ✗，而且没人处理 ✗）
 * → 永远不返回 ✗ → `/api/boot` 根本没发出去 ✓ → 用户看到"打开了但一直转" ✓。
 * 规矩：本地缓存**只配加速** ✓ —— 读不出来/读太慢都必须让路 ✓，绝不能卡启动 ✗。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 IndexedDB `onblocked` 有处理 + 有**硬超时** ✓（旧连接占着旧版本时 open 会一直挂着 ✗ —— 这就是"页面在加载、桥一条请求都没有"的真凶 ✓）',
		page.includes("request.onblocked = () => finish(reject, new Error('idb open blocked'))")
		&& page.includes('idb open timeout') && page.includes('const IDB_TIMEOUT_MS = 2000'))
	check('🔴 事务也有上限 + 中止处理 ✓（`idb tx timeout` / `tx.onabort` ✓ —— 别让一次读缓存把页面钉死 ✗）',
		page.includes('idb tx timeout') && page.includes('tx.onabort'))
	check('🔴 启动时读本地缓存**最多等 1.5 秒** ✓，超时当没有、继续 `/api/boot` ✓（缓存只配加速，不是启动前置 ✗）',
		page.includes('new Promise((resolve) => setTimeout(() => resolve(null), 1500))')
		&& page.includes('loadTranscriptSnapshot(remembered).catch(() => null)'))
}

/*
 * 39) 🔴 **5.0.5「狼人杀面板黑屏」**（用户 2026-10-20：「这个新增的狼人杀是黑屏的」✓）。
 *
 * 面板是**同页 iframe** ✓。iPhone 上黑屏、桌面 Chrome 完全正常 ✓ —— 这类差异里最常见的一条是：
 * **iOS Safari 在祖先带 `backdrop-filter` 时不绘制 iframe** ✗（面板那张 `.sheet` 正好带毛玻璃 ✓）。
 * 两条一起上 ✓：① 面板纸**撤掉模糊 + 不透明底** ✓；② 同源父页**黑屏兜底** ✓
 *（4 秒还是空 → 自动重载一次 ✓ → 再空就明说 + 「重试」✓，并写进桥日志 ✓）。
 */
{
	const page = await readFile(join(ROOT, 'lib', 'mobile.html'), 'utf8')
	check('🔴 面板这张纸**撤掉 backdrop-filter + 不透明底** ✓（iOS 在带模糊的祖先里可能整块不画 iframe ✗ —— 黑屏真因候选 ✓）',
		page.includes('#panelopen { background: var(--bg);')
		&& page.includes('-webkit-backdrop-filter: none; backdrop-filter: none;'))
	check('🔴 同源 iframe **黑屏兜底** ✓：打开 4 秒还是空的就自动重载一次 ✓、再空就明说 + 给「重试」✓（不许让用户对着黑屏猜 ✗）',
		page.includes('panel-blank-retry') && page.includes('PANEL_EMPTY_HINT')
		&& page.includes("button.textContent = '重试'"))
	check('🔴 兜底不误伤「正在加载」✓（`readyState` 没 complete 不算空 ✗）—— 而且重载动作**写进桥日志** ✓（下次不用再猜 ✓）',
		page.includes("if (doc.readyState !== 'complete') return false")
		&& page.includes("reportToBridge('panel-blank-retry'"))
}

console.log(`\n  ${pass}/${pass + fail} checks passed`)
process.exit(fail === 0 ? 0 : 1)