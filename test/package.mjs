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

console.log(`\n  ${pass}/${pass + fail} checks passed`)
process.exit(fail === 0 ? 0 : 1)
