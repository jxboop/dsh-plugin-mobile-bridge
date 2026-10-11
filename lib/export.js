/**
 * 会话日志 → Markdown（2.7.0 池子里的 ★5「会话导出 / 分享」）。
 *
 * 这份实现**就是** `tools/export-session.mjs` 里那份 ✓ —— 今晚把核心抽到这儿，
 * 让**脚本和桥共用一份** ✓（不然两处各写一遍，早晚对不上 ✗）。
 * 行为口径完全照旧：用户消息原文 ✓、助手正文（推理默认丢 ✓）、工具调用一行摘要 ✓、
 * 运行时注入的"用户消息"滤掉 ✓（不然记录里全是环境快照那种噪音 ✓）。
 *
 * 为什么要导出：DSH 的会话日志是 **zstd 分帧 jsonl**，人打不开、别的会话也读不了 ✓；
 * 导成 Markdown 之后能检索、能只读需要的段落 ✓ —— 而不是把几十万 token 的历史重新塞回上下文 ✓。
 *
 * 零依赖 ✓（`node:zlib` 的 zstd 就够 ✓）。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

/** 运行时注入的"用户消息"不算用户说的话（前缀特征 ✓，和脚本里那张表一致 ✓）。 */
const INJECTED = [
	'Current runtime context',
	'<system-reminder>',
	'The approval policy changed',
	'Approval prompts are disabled',
	'This is an automatically generated checkpoint',
]

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/**
 * 按 sessionId 找会话日志。
 *
 * ⚠️ **别把日志文件名写死成 `session.v3.jsonl.zstd`** ✗ —— 2026-10-12 真机验证当场撞到：
 * 当前会话写的是 **`session.v4.jsonl.zstd`** ✓（磁盘上 v3 有 61 份、v4 有 19 份 ✓），
 * 而"现成脚本"里写死了 v3 ✗ → **所有新会话都导不出来**（点导出只会说"找不到日志" ✓）。
 * 内容格式两代一样（zstd 分帧 + 同样的 JSON 事件 ✓，只有头里的 `version` 不同 ✓），所以：
 * **认所有 `session.v<N>.jsonl.zstd`** ✓，同一目录有多份时**取版本号最大**的那份 ✓。
 *
 * @param {string} key 会话 id（或直接的日志文件路径 ✓）
 * @param {{ exact?: boolean }} [options] exact=true 时只认"目录名 === id" ✓（桥走这条，避免 id 撞前缀 ✗）
 */
export function locateSessionLog(key, options = {}) {
	if (existsSync(key) && statSync(key).isFile()) return key
	const root = join(dshHome(), 'sessions')
	const found = []
	const walk = (dir, depth) => {
		if (depth > 4) return
		let entries = []
		try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
		for (const entry of entries) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) { walk(full, depth + 1); continue }
			const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(entry.name)
			if (match === null) continue
			if (options.exact === true ? basename(dir) === key : full.includes(key)) {
				found.push({ full, version: Number(match[1]), modified: statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? 0 })
			}
		}
	}
	walk(root, 0)
	if (found.length === 0) return null
	// 版本号大的优先 ✓；同版本就取最近写过的 ✓（两个都在时别导出旧的那份 ✗）。
	found.sort((left, right) => (right.version - left.version) || (right.modified - left.modified))
	return found[0].full
}

/** zstd 分帧 → 事件数组（坏帧/坏行跳过 ✓，绝不因为一行坏数据整份导出失败 ✗）。 */
export function readSessionEvents(file) {
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
	return events
}

/**
 * 事件数组 → Markdown。
 * @param {any[]} events
 * @param {{ file?: string, sessionId?: string, maxChars?: number, withTools?: boolean, withReasoning?: boolean, now?: Date }} [options]
 */
export function eventsToMarkdown(events, options = {}) {
	const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? Math.floor(options.maxChars) : 4000
	const withTools = options.withTools === true
	const withReasoning = options.withReasoning === true
	const clip = (value, limit = maxChars) => {
		const string = String(value ?? '')
		return string.length <= limit ? string : `${string.slice(0, limit)}\n…（截断，原文还有 ${string.length - limit} 字符）`
	}
	const isInjected = (body) => INJECTED.some((prefix) => body.startsWith(prefix))
	const stamp = (ms) => new Date(Number(ms ?? 0)).toLocaleString()
	const textOfBlocks = (blocks, kinds) => (blocks ?? [])
		.filter((block) => block && kinds.includes(block.type))
		.map((block) => block.text ?? '')
		.join('\n')
		.trim()

	const lines = []
	const header = events.find((event) => event.type === 'session')
	const sessionId = options.sessionId ?? header?.id ?? '（未知）'
	lines.push(`# 对话记录：${sessionId}`)
	lines.push('')
	lines.push(`- 导出时间：${(options.now ?? new Date()).toLocaleString()}`)
	if (typeof options.file === 'string') lines.push(`- 来源日志：\`${options.file}\``)
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
			lines.push(`- 🔧 \`${name}\` ${stamp(time)}：\`${clip(args, withTools ? 1200 : 240).replace(/\n/g, ' ')}\``)
		} else if (event.type === 'tool/result' && withTools) {
			const body = textOfBlocks(event.data?.message?.content?.[0]?.content, ['text', 'tool-result'])
			if (body !== '') lines.push(`  ↳ 结果：${clip(body, 1200).replace(/\n/g, ' ')}`)
		}
	}
	return { markdown: lines.join('\n'), users, assistants, toolCalls, sessionId, file: options.file ?? null }
}

/** 一步到位：sessionId → Markdown（桥的接口就用它 ✓）。 */
export function exportSessionMarkdown(sessionId, options = {}) {
	const file = locateSessionLog(sessionId, { exact: options.exact !== false })
	if (file === null) return { ok: false, error: '找不到这份会话的日志（可能已经被清理了）' }
	try {
		const events = readSessionEvents(file)
		return { ok: true, ...eventsToMarkdown(events, { ...options, file, sessionId }) }
	} catch (error) {
		return { ok: false, error: `读会话日志失败：${String(error?.message ?? error)}` }
	}
}
