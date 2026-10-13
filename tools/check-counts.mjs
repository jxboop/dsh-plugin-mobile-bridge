/**
 * 文档里的"项数"对不对 —— 一条命令算给你看 ✓。
 *
 *   node tools/check-counts.mjs
 *
 * 为什么要有它（2026-10-12 真踩过 ✓）：发 2.10.0 时我在 CHANGELOG / README / 交接文档里
 * 手写套件项数，**加错了一处**（写成 1022，实际 1035 ✗）—— 而"套件全绿"的断言只保证
 * 测试通过，**不保证文档里的数字是对的** ✗。这类错读者一眼看不出来，却会让人以为
 * "少跑了几个套件" ✓。
 *
 * 做法：真跑一遍**九个**套件 → 从输出里取每套的项数 → 和 README / CHANGELOG 最新一节里写的
 * 数字逐项比对 ✓。**不求人肉核对** ✓。
 * ⚠️ 它**不替代**发版前跑全套 ✓（这里跑一遍是为了取数，失败也会报出来 ✓）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
/*
 * 门槛里的**九个**套件 ✓（文档口径就是"九个套件共 X 项" ✓ —— 别写"十个" ✗，那会把没数的算进去 ✓）。
 *
 * ⚠️ `test/voice.mjs`（33 条**语音草稿**）**故意不在这里** ✗：语音那一版按用户要求先跳过 ✓，
 * 文件留在仓库里、能单独跑 ✓，但不该拿一份"没发的功能"去卡发版 ✓。
 * ⚠️ 关键是这条口径**白纸黑字写在代码里** ✓ —— 不能让它变成"静默跳过" ✗
 * （那正是下面 `section === ''` 那段"匹配不到就报错退出"要治的最坏情况：假绿发生器 ✓；
 * 复查第 89 轮又拿这件事点了一次 ✓）。
 */
const SUITES = ['package', 'harness', 'qr', 'ui', 'security', 'crashprobe', 'addresses', 'offline', 'platform']

/** 从一套测试的输出里取"X/Y checks passed"或"共 N 项，通过 M，失败 K"里的**总数**。 */
function countOf(name) {
	const file = join(ROOT, 'test', `${name}.mjs`)
	if (existsSync(file) === false) return null
	const run = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
	const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
	if (run.status !== 0) {
		console.error(`✗ ${name} 退出码 ${run.status} —— 先把它跑绿再谈数字`)
		const tail = out.trim().split('\n').slice(-6).join('\n')
		console.error(tail)
		return null
	}
	const passed = /(\d+)\/(\d+) checks passed/.exec(out)
	if (passed !== null) return Number(passed[2])
	const chinese = /共\s*(\d+)\s*项，通过\s*(\d+)，失败\s*(\d+)/.exec(out)
	if (chinese !== null) return Number(chinese[1])
	console.error(`✗ ${name} 的输出里没找到项数（格式变了？）`)
	return null
}

const counts = {}
for (const name of SUITES) counts[name] = countOf(name)
const missing = SUITES.filter((name) => counts[name] === null)
if (missing.length > 0) {
	console.error(`\n拿不到这些套件的项数：${missing.join(', ')}`)
	process.exit(1)
}
const total = SUITES.reduce((sum, name) => sum + counts[name], 0)
const line = SUITES.map((name) => `${name} ${counts[name]}`).join(' · ')
console.log(`\n实测：**${total} 项**（${line}）\n`)

/** 文档里那一行怎么写都行，只要**每个数字都对** ✓（顺序、分隔符、加粗都不计较 ✓）。 */
const files = ['README.md', 'CHANGELOG.md']
let bad = 0
for (const file of files) {
	const text = readFileSync(join(ROOT, file), 'utf8')
	// 只看"最新那一节"：CHANGELOG 取第一个 `### 测试` 块；README 取"N 个套件共 …"那段。
	//
	// ⚠️ 2026-10-13 修：这里原来写死 `八个套件共` ✗ —— 加了第 9、10 个套件之后 README 改成
	// "十个套件共"，它就**匹配不到、直接跳过** ✓（还打印"跳过"✓）→ README 的数字**根本没被查** ✗✗。
	// 这正是这个脚本要防的东西里最坏的一种：**静默跳过 = 假绿发生器** ✗。现在：数量词放宽 ✓，
	// 而且**匹配不到就报错退出** ✗（不许再有"跳过"这条退路 ✓）。
	const section = file === 'CHANGELOG.md'
		? (text.match(/### 测试[\s\S]*?(?=\n## |\n### )/) ?? [''])[0]
		: (text.match(/[一二三四五六七八九十]+个套件共[\s\S]{0,400}/) ?? [''])[0]
	if (section === '') {
		console.log(`✗ ${file} 里没找到项数段 —— 不许静默跳过 ✗（README 那句要写成"N 个套件共 **X 项**（…）"✓）`)
		bad += 1
		continue
	}
	const found = {}
	for (const name of SUITES) {
		const match = new RegExp(`${name}\\*{0,2}\\s*\\*{0,2}\\s*(\\d+)`, 'i').exec(section)
		if (match !== null) found[name] = Number(match[1])
	}
	const totalMatch = /(\d{3,5})\s*项/.exec(section)
	const problems = []
	if (totalMatch !== null && Number(totalMatch[1]) !== total) problems.push(`总数写的是 ${totalMatch[1]}，实测 ${total}`)
	for (const name of SUITES) {
		if (found[name] !== undefined && found[name] !== counts[name]) problems.push(`${name} 写的是 ${found[name]}，实测 ${counts[name]}`)
	}
	if (problems.length === 0) console.log(`✓ ${file}：数字与实测一致`)
	else { bad += 1; console.error(`✗ ${file}：${problems.join('；')}`) }
}
if (bad > 0) {
	console.error('\n把上面那几处改成实测值再发版 ✓（这类错读者一眼看不出来 ✗）')
	process.exit(1)
}
console.log('\n✓ 文档里的项数都对得上 ✓')
