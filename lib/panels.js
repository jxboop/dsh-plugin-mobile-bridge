/**
 * 手机端面板协议（3.1.0「手机端可扩展」）—— 零依赖、可单测 ✓。
 *
 * 用户要的（总路线原话）：把"手机端面板"变成**可挂载的接口** ✓ ——
 * 第三方/自研面板能注册进手机 UI（工具键、抽屉、整屏 ✓）；先做**协议 + 两个示例面板** ✓，
 * 再把桥自己的面板逐步迁过去 ✓。
 *
 * 协议就三样（越少越活得久 ✓）：
 *   ① **清单**：每个面板一个目录，里面一个 `panel.json` ✓
 *      `{ "title": "便签", "icon": "📝", "kind": "tool" | "sheet" | "screen", "entry": "index.html" }` ✓；
 *   ② **静态资源**：同目录下的 html/js/css，桥按 `/panel/<id>/<文件>` 原样发出去 ✓
 *      （所以面板里写相对路径 `api/xxx` 就是在调桥的接口 ✓ —— 与手机页同源 ✓）；
 *   ③ **信任边界（必须说清 ✓）**：同源 = 面板能拿手机页的 cookie ✓，
 *      也就是说**装一个面板 = 把手机端的一切交给它** ✓。
 *      所以：整个面板功能**默认关** ✗（`panels: true` 才开 ✓），
 *      而"谁能装"的边界是"**谁能写这台电脑的 `~/.dsh`**" ✓ —— 那本来就是完全信任 ✓。
 *
 * ⚠️ 路径穿越是这一层最要命的事 ✓：`/panel/notes/../../mobile-bridge.json`
 * 绝不能读到桥的配置文件 ✗ —— 所以所有文件读取都过 `safePanelFile()` ✓（只单测它 ✓）。
 *
 * ⚠️⚠️ **词法守卫不够：符号链接** ✗✗（3.1.0 冷视角复查实测抓到的**高危**）：
 * `safePanelFile()` 只做字符串 `resolve` ✓，而 `stat`/`readFile` **会跟随符号链接** ✗ ——
 * 面板目录里放一个 `leak.json -> ~/.dsh/mobile-bridge.json` 就能把 PIN / 令牌 / **路径密钥**
 * 整套读走 ✓（Windows 上普通用户不用管理员就能建链接 ✓）。文档里原先那句
 * "所有文件读取都过 safePanelFile ✓ 就够了"是**虚假安全保证** ✗（比没有更糟 ✓）。
 * 现在三重：① 词法守卫 ✓；② 一律 `lstat` 且**拒符号链接** ✓；
 * ③ `realpath` 之后必须仍在 `realpath(面板目录)` 之下 ✓（挡"父目录本身是链接"与中间段 ✓）。
 */
import { readFile, readdir, stat, lstat, realpath } from 'node:fs/promises'
import { join, resolve, sep, extname } from 'node:path'

/** 清单里允许的几种落点 ✓（先都用"工具键 + 整屏"这一种表现 ✓，字段留着给以后分化 ✓）。 */
export const PANEL_KINDS = new Set(['tool', 'sheet', 'screen'])
/** 单个面板文件的上限 ✓（面板是界面，不是素材库 ✓）。 */
export const PANEL_FILE_MAX = 512 * 1024
/** 面板 id 的合法形状 ✓（它同时会进 URL 与目录名 ✓）。 */
const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 面板文件只发这几种（不认识的类型**不发** ✗ —— 免得把 .json 配置顺手泄出去 ✓）。 */
const PANEL_TYPES = new Map([
	['.html', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.mjs', 'text/javascript; charset=utf-8'],
	['.css', 'text/css; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.svg', 'image/svg+xml'],
	['.png', 'image/png'],
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.webp', 'image/webp'],
	['.gif', 'image/gif'],
])

export function contentTypeOf(name) {
	return PANEL_TYPES.get(extname(String(name ?? '')).toLowerCase()) ?? ''
}

/**
 * 把一份 `panel.json` 规整成可信的清单 ✓；不合格就返回 null ✓（**跳过并计数**，不静默当没事 ✓）。
 * `builtin` 用来标记"这是桥自带的示例" ✓（界面上要能分清 ✓）。
 */
export function normalizeManifest(raw, id, { builtin = false } = {}) {
	if (typeof id !== 'string' || PANEL_ID.test(id) !== true) return null
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
	const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim().slice(0, 40) : ''
	if (title === '') return null
	const icon = typeof raw.icon === 'string' && raw.icon.trim() !== '' ? raw.icon.trim().slice(0, 4) : '🧩'
	const kind = PANEL_KINDS.has(String(raw.kind)) ? String(raw.kind) : 'tool'
	// 入口文件只允许"同目录下的相对路径" ✓（不许 `../`、不许绝对路径 ✗）。
	const entry = typeof raw.entry === 'string' && raw.entry !== '' ? raw.entry : 'index.html'
	if (safePanelFile('/panel-root', entry) === null) return null
	return { id, title, icon, kind, entry, builtin: builtin === true }
}

/**
 * 面板目录里某个相对路径能不能读 ✓ —— 能读就返回**绝对路径**，不能就 null ✓。
 * 判据两条：① 规范化之后**必须还在 root 之下** ✓（`..` 一律挡掉 ✓）；
 * ② 不许是 root 本身 ✓（目录不是文件 ✓）。
 */
export function safePanelFile(root, rel) {
	if (typeof root !== 'string' || root === '' || typeof rel !== 'string' || rel === '') return null
	// URL 里的 `/` 已经解码过；这里再挡一次反斜杠（Windows 上 `..\` 同样是穿越 ✓）。
	if (rel.includes('\0') || rel.includes('\\')) return null
	const base = resolve(root)
	const target = resolve(base, rel)
	if (target === base) return null
	if (target.startsWith(base + sep) !== true) return null
	return target
}

/**
 * 3.1.0 复查 H1：**角色是普通文件、且不是符号链接、且 realpath 仍在面板目录内** ✓。
 * 三重都要过 ✓ —— 少一条就等于没拦 ✓（词法守卫挡不住链接 ✓，lstat 挡不住"父目录是链接" ✓）。
 */
async function safeRegularFile(root, rel) {
	const target = safePanelFile(root, rel)
	if (target === null) return null
	try {
		const info = await lstat(target)
		if (info.isFile() !== true) return null
		if (info.isSymbolicLink() === true) return null
		// ⚠️ 目录本身也可能是链接 ✓（或链接在中间某一段 ✓）—— realpath 之后必须还在 realpath(root) 之下 ✓。
		const realRoot = await realpath(root)
		const realTarget = await realpath(target)
		if (realTarget.startsWith(realRoot + sep) !== true) return null
		return { file: target, size: info.size }
	} catch {
		return null
	}
}

/** 读一个面板目录：有合法 `panel.json` 才算一个面板 ✓。 */
async function readPanelDir(dir, id, { builtin }) {
	// 面板目录自己也不许是符号链接 ✓（否则整个"目录之内"的判断都建立在别人的地盘上 ✓）。
	try {
		const info = await lstat(dir)
		if (info.isDirectory() !== true || info.isSymbolicLink() === true) return null
	} catch {
		return null
	}
	let raw = ''
	try {
		raw = await readFile(join(dir, 'panel.json'), 'utf8')
	} catch {
		return null
	}
	let parsed = null
	try { parsed = JSON.parse(raw) } catch { return null }
	const manifest = normalizeManifest(parsed, id, { builtin })
	if (manifest === null) return null
	// 入口文件必须真的在（清单说 `index.html` 而文件不在 = 点开是 404 ✗，不如现在就不列 ✓）。
	const entryFile = await safeRegularFile(dir, manifest.entry)
	if (entryFile === null) return null
	return { ...manifest, dir }
}

/**
 * 收集面板：**内置示例** + **用户自己的**（`<userDir>/<id>/panel.json` ✓）。
 * 同 id 时用户那份优先 ✓（用户能覆盖示例 ✓）；返回 `{ panels, skipped }` ✓
 * —— `skipped` 是"目录里有东西但清单不合格"的个数 ✓（要能说出来，别静默 ✓）。
 */
export async function collectPanels({ builtinDir = '', userDir = '' } = {}) {
	const found = new Map()
	const skipped = []
	const scan = async (root, builtin) => {
		if (typeof root !== 'string' || root === '') return
		let names = []
		try {
			names = await readdir(root)
		} catch (error) {
			/*
			 * ⚠️ 读不到用户目录**不能当"没有面板"** ✗（3.1.0 复查 M3：权限 / 拼错 / DSH_HOME 指别处 ✓，
			 * 全都变成"列表里没有"且 `skipped: 0` ✓ —— 正是这一版想消灭的静默 ✓）。往上带原因 ✓。
			 */
			if (builtin !== true && error?.code !== 'ENOENT') skipped.push(`${root}：读不到（${String(error?.code ?? error?.message ?? error)}）`)
			return
		}
		for (const name of names.sort()) {
			if (PANEL_ID.test(name) !== true) {
				// ⚠️ 目录名不合规也要**说一声** ✓（复查 M2：README 教过中文目录名 ✓，
				// 而中文名在旧版是 `continue` 且不计数 ✓ → 用户看到 `skipped: 0` + 面板不见 ✓，零线索 ✗）。
				try {
					const info = await lstat(join(root, name))
					if (info.isDirectory() === true) {
						await readFile(join(root, name, 'panel.json'), 'utf8')
						skipped.push(`${name}：目录名不合规（只能用 小写字母/数字/短横线，最多 32 字 ✓）`)
					}
				} catch { /* 没有 panel.json 的普通目录不算"坏面板" ✓ */ }
				continue
			}
			const panel = await readPanelDir(join(root, name), name, { builtin })
			if (panel === null) { skipped.push(`${name}：清单不合格或入口文件不在（或者它是符号链接 ✓）`); continue }
			found.set(name, panel)
		}
	}
	// ⚠️ 顺序有讲究 ✗：**先内置、后用户** ✓ —— 后扫到的覆盖先扫到的 ✓，
	// 所以用户自己的面板能盖掉同 id 的示例 ✓（第一版写反了 ✓：示例把用户那份盖掉了 ✓，
	// 症状是"我把自己的便签放进 ~/.dsh 了，手机上还是示例的" ✓）。
	await scan(builtinDir, true)
	await scan(userDir, false)
	return { panels: [...found.values()].sort((left, right) => left.id.localeCompare(right.id)), skipped: skipped.length, skippedReasons: skipped.slice(0, 8) }
}

/** 读面板里的一个文件 ✓（大小与类型在这里把住 ✓，**符号链接在这里被拒** ✓）。 */
export async function readPanelAsset(dir, rel) {
	const type = contentTypeOf(rel)
	if (type === '') return { ok: false, status: 404, error: '这个类型不发（面板只发 html/js/css/json/图片）' }
	const checked = await safeRegularFile(dir, rel)
	if (checked === null) return { ok: false, status: 404, error: 'not found' }
	if (checked.size > PANEL_FILE_MAX) return { ok: false, status: 413, error: `这个文件太大（上限 ${Math.round(PANEL_FILE_MAX / 1024)} KB）` }
	try {
		const body = await readFile(checked.file)
		return { ok: true, status: 200, type, body }
	} catch {
		return { ok: false, status: 404, error: 'not found' }
	}
}
