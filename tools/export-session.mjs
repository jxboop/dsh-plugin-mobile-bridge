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
 * 口径（默认）
 *   - 用户消息：原文
 *   - 助手消息：正文（推理过程默认丢掉，`--reasoning` 才带上）
 *   - 工具调用/结果：一行摘要（名字 + 开头一小段），`--tools` 才展开更多
 *   - 每条消息按 `--max`（默认 4000 字符）截断，避免一条超长输出把文件撑爆
 *
 * ⚠️ 2.7.0 起，**核心实现搬到了 `lib/export.js`** ✓ —— 手机桥的「导出/分享」接口用的是同一份 ✓。
 * 这个文件现在只是个命令行壳子 ✓（免得两处各写一遍、早晚对不上 ✗）。
 */
import { writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { locateSessionLog, readSessionEvents, eventsToMarkdown } from '../lib/export.js'

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

const file = locateSessionLog(target, { exact: false })
if (file === null) { console.error('找不到会话日志: ' + target); process.exit(1) }

const events = readSessionEvents(file)
const result = eventsToMarkdown(events, {
	file,
	maxChars: Number(value('--max', 4000)),
	withTools: flag('--tools'),
	withReasoning: flag('--reasoning'),
})
const out = value('--out', join(process.cwd(), `对话记录-${result.sessionId.slice(0, 20)}.md`))
writeFileSync(out, result.markdown, 'utf8')
console.log(`已导出：${out}`)
console.log(`用户消息 ${result.users} 条 · 助手消息 ${result.assistants} 条 · 工具调用 ${result.toolCalls} 次 · 文件 ${(statSync(out).size / 1024).toFixed(1)} KB`)
