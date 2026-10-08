/**
 * 把一份会话日志导出成**人能读的对话记录**（Markdown）。
 *
 *   node tools/export-session.mjs <sessionId|日志文件> [--out 文件] [--max 4000] [--tools] [--reasoning]
 *
 * 为什么需要它：DSH 的会话日志是 zstd 压缩的分帧 jsonl（`.dsh/sessions/<cwd>/<id>/session.v3.jsonl.zstd`），
 * 人打不开、别的会话也读不了 —— 但"换个会话继续"的时候，历史就在里面。
 * 导成 Markdown 之后：可以被检索、可以只读需要的段落，**不必把几十万 token 的历史重新塞进上下文**
 * （那正是余额掉得快的原因）。
 *
 * 默认口径
 *   - 用户消息：原文
 *   - 助手消息：正文（推理过程默认丢掉，`--reasoning` 才带上）
 *   - 工具调用/结果：一行摘要（名字 + 开头一小段），`--tools` 才展开更多
 *   - 每条消息按 `--max`（默认 4000 字符）截断，避免一条超长输出把文件撑爆
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
	const index = argv.indexOf(name)
	return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const target = argv.find((item, index) => item.startsWith('--') === false && (index === 0 || argv[index - 1].startsWith('--') === false))
if (target === undefined) {
	console.error('用法: node tools/export-session.mjs <sessionId|日志文件> [--out 文件] [--max 4000] [--tools] [--reasoning]')
	process.exit(2)
}
const maxChars = Number(value('--max', 4000))
const withTools = flag('--tools')
const withReasoning = flag('--reasoning')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

/** 按 sessionId 找到它的日志文件。 */
function locate(key) {
	if (existsSync(key) && statSync(key).isFile()) return key
	const root = join(dshHome, 'sessions')
	const found = []
	const walk = (dir, depth) => {
		if (depth > 4) return
		let entries = []
		try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
		for (const entry of entries) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) { walk(full, depth + 1); continue }
			if (entry.name === 'session.v3.jsonl.zstd' && full.includes(key)) found.push(full)
		}
	}
	walk(root, 0)
	return found[0] ?? null
}

const file = locate(target)
if (file === null) { console.error('找不到会话日志: ' + target); process.exit(1) }

const buf = readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const hits = []
let index = 0
while ((index = buf.indexOf(magic, index)) >= 0) { hits.push(index); index += 4 }
let text = ''
for (let i = 0; i < hits.length; i += 1) {
	const slice = buf.slice(hits[i], i + 1 < hits.length ? hits[i + 1] : buf.length)
	try { text += zstdDecompressSync(slice).toString('utf8') + '\n' } catch { /* 半帧跳过 */ }
}
const events = []
for (const line of text.split('\n')) {
	if (line.trim() === '') continue
	try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
}

const clip = (value, limit = maxChars) => {
	const string = String(value ?? '')
	return string.length <= limit ? string : string.slice(0, limit) + `\n…（截断，原文还有 ${string.length - limit} 字符）`
}
/**
 * 运行时注入的"用户消息"不算用户说的话。
 *
 * DSH 会把运行环境快照 / 技能清单 / 审批状态当作 user 消息写进日志（它们确实是"喂给模型的用户角色内容"），
 * 直接导出会让记录里全是这种噪音 —— 一次会话里有几十条。所以按开头特征滤掉。
 */
const INJECTED = [
	'Current runtime context',
	'<system-reminder>',
	'The approval policy changed',
	'Approval prompts are disabled',
	'This is an automatically generated checkpoint',
]
const isInjected = (body) => INJECTED.some((prefix) => body.startsWith(prefix))
const stamp = (ms) => new Date(Number(ms ?? 0)).toLocaleString()
const textOfBlocks = (blocks, kinds) => (blocks ?? [])
	.filter((block) => block && kinds.includes(block.type))
	.map((block) => block.text ?? '')
	.join('\n')
	.trim()

const lines = []
const header = events.find((event) => event.type === 'session')
const sessionId = header?.id ?? basename(file.replace(/[\\/]session\.v3\.jsonl\.zstd$/, ''))
lines.push(`# 对话记录：${sessionId}`)
lines.push('')
lines.push(`- 导出时间：${new Date().toLocaleString()}`)
lines.push(`- 来源日志：\`${file}\``)
lines.push(`- 事件总数：${events.length}`)
lines.push(`- 工作目录：${header?.cwd ?? '（未知）'}`)
lines.push('')

let users = 0
let assistants = 0
let toolCalls = 0
for (const event of events) {
	const time = event.time ?? event.createdAt
	if (event.type === 'user/message') {
		const body = textOfBlocks(event.data?.content, ['text'])
		if (body === '' || isInjected(body)) continue
		users += 1
		lines.push(`## 👤 用户 · ${stamp(time)}`)
		lines.push('')
		lines.push(clip(body))
		lines.push('')
	} else if (event.type === 'assistant/message') {
		const blocks = event.data?.message?.content ?? []
		const body = textOfBlocks(blocks, ['text'])
		const reasoning = withReasoning ? textOfBlocks(blocks, ['reasoning']) : ''
		if (body === '' && reasoning === '') continue
		assistants += 1
		lines.push(`## 🤖 助手 · ${stamp(time)}`)
		lines.push('')
		if (reasoning !== '') { lines.push('<details><summary>思考过程</summary>'); lines.push(''); lines.push(clip(reasoning)); lines.push(''); lines.push('</details>'); lines.push('') }
		if (body !== '') { lines.push(clip(body)); lines.push('') }
	} else if (event.type === 'tool/call') {
		toolCalls += 1
		const name = event.data?.name ?? '?'
		const args = String(event.data?.arguments ?? '')
		lines.push(`- 🔧 \`${name}\` ${stamp(time)}${withTools ? '' : ''}：\`${clip(args, withTools ? 1200 : 240).replace(/\n/g, ' ')}\``)
	} else if (event.type === 'tool/result' && withTools) {
		const body = textOfBlocks(event.data?.message?.content?.[0]?.content, ['text', 'tool-result'])
		if (body !== '') lines.push(`  ↳ 结果：${clip(body, 1200).replace(/\n/g, ' ')}`)
	}
}

const out = value('--out', join(process.cwd(), `对话记录-${sessionId.slice(0, 20)}.md`))
writeFileSync(out, lines.join('\n'), 'utf8')
console.log(`已导出：${out}`)
console.log(`用户消息 ${users} 条 · 助手消息 ${assistants} 条 · 工具调用 ${toolCalls} 次 · 文件 ${(statSync(out).size / 1024).toFixed(1)} KB`)
