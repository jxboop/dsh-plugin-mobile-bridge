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
import { existsSync } from 'node:fs'
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

// 3) 别再用"逐个文件列举"的写法：新增一个 lib 下的文件就会再漏一次。
check('files 覆盖整个 lib/（而不是逐个文件列举）',
	(Array.isArray(pkg.files) ? pkg.files : []).some((pattern) => String(pattern).replace(/^\.\//, '').replace(/\/+$/, '') === 'lib'),
	JSON.stringify(pkg.files))

console.log(`\n  ${pass}/${pass + fail} checks passed`)
process.exit(fail === 0 ? 0 : 1)
