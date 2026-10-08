/**
 * 余额报告：把这些天到底是谁在烧 token 算清楚。
 *
 *   node tools/token-report.mjs [--days 3] [--top 8] [--hours]
 *
 * 数据来源就是 DSH 自己的会话日志（`~/.dsh/sessions/<cwd>/<sessionId>/session.v3.jsonl.zstd`）：
 * 每条 `assistant/message` 都带 `usage`（inputTokens / cacheReadTokens / outputTokens /
 * reasoningTokens / totalTokens），全是本地文件，不联网、不花钱。
 *
 * 为什么值得做成工具：用户看到的是"余额掉得快"，但真正的问题是**结构性**的 ——
 * 每一轮、每一步都要把**整段上下文重发一次**，所以"上下文越长 × 步数越多"就是乘数。
 * 只有把每个会话的 token 摊开看，才知道该缩短哪个会话、少跑哪种任务。
 *
 * 口径说明（和 DSH 的 usage 字段一致）：
 *   total = inputTokens（未命中缓存的输入）+ cacheReadTokens（命中缓存的输入）+ outputTokens
 *   缓存命中的输入单价通常只有未命中的零头，所以"贵"的部分主要是 inputTokens 与 outputTokens。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
	const index = argv.indexOf(name)
	return index >= 0 && argv[index + 1] !== undefined ? Number(argv[index + 1]) : fallback
}
const days = argOf('--days', 3)
const top = argOf('--top', 8)
const wantHours = argv.includes('--hours')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsRoot = join(dshHome, 'sessions')
const projRoot = join(dshHome, 'storages', 'session_projcache', 'sessions')

/** 会话标题（投影缓存里有，读不到就退回短 id）。 */
function titleOf(sessionId) {
	try {
		const raw = JSON.parse(readFileSync(join(projRoot, sessionId + '.json'), 'utf8'))
		const rows = raw?.record?.rows ?? []
		for (const row of rows) {
			const title = row?.title?.val
			if (typeof title === 'string' && title !== '') return title
		}
	} catch { /* 没有就算了 */ }
	return sessionId.slice(0, 18)
}

/** 会话日志是"一帧一行"的 zstd（不是单一流），所以按 magic 切开逐帧解。 */
function readEvents(file) {
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

const localDay = (ms) => {
	const date = new Date(ms)
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const localHour = (ms) => new Date(ms).getHours()
const k = (n) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))

const cutoff = Date.now() - days * 86400_000
const perSession = new Map()
const perDay = new Map()
const perHourToday = new Map()
const today = localDay(Date.now())
let scanned = 0

const walk = (dir) => {
	let entries = []
	try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
	for (const entry of entries) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) { walk(full); continue }
		if (entry.name !== 'session.v3.jsonl.zstd') continue
		scanned += 1
		const sessionId = full.split(/[\\/]/).slice(-2)[0]
		let events
		try { events = readEvents(full) } catch { continue }
		for (const event of events) {
			if (event?.type !== 'assistant/message') continue
			const usage = event?.data?.usage
			const time = Number(event?.time ?? 0)
			if (usage === undefined || !Number.isFinite(time) || time < cutoff) continue
			const row = {
				input: Number(usage.inputTokens ?? 0),
				cache: Number(usage.cacheReadTokens ?? 0),
				output: Number(usage.outputTokens ?? 0),
				reasoning: Number(usage.reasoningTokens ?? 0),
				total: Number(usage.totalTokens ?? 0),
			}
			const bucket = perSession.get(sessionId) ?? { sessionId, calls: 0, input: 0, cache: 0, output: 0, reasoning: 0, total: 0, last: 0 }
			bucket.calls += 1
			bucket.input += row.input; bucket.cache += row.cache; bucket.output += row.output
			bucket.reasoning += row.reasoning; bucket.total += row.total
			bucket.last = Math.max(bucket.last, time)
			perSession.set(sessionId, bucket)

			const day = localDay(time)
			const dayBucket = perDay.get(day) ?? { input: 0, cache: 0, output: 0, total: 0, calls: 0 }
			dayBucket.input += row.input; dayBucket.cache += row.cache; dayBucket.output += row.output
			dayBucket.total += row.total; dayBucket.calls += 1
			perDay.set(day, dayBucket)

			if (day === today) {
				const hour = localHour(time)
				const hourBucket = perHourToday.get(hour) ?? { total: 0, output: 0, calls: 0 }
				hourBucket.total += row.total; hourBucket.output += row.output; hourBucket.calls += 1
				perHourToday.set(hour, hourBucket)
			}
		}
	}
}
if (!existsSync(sessionsRoot)) { console.error('找不到会话目录: ' + sessionsRoot); process.exit(1) }
walk(sessionsRoot)

console.log(`扫描 ${scanned} 份会话日志（最近 ${days} 天，DSH_HOME=${dshHome}）`)
console.log('')
console.log('== 按天（本地时间）==')
console.log('  日期          请求数   未命中输入    缓存输入      输出      合计')
for (const [day, value] of [...perDay.entries()].sort()) {
	console.log(`  ${day}  ${String(value.calls).padStart(6)}  ${k(value.input).padStart(10)}  ${k(value.cache).padStart(10)}  ${k(value.output).padStart(8)}  ${k(value.total).padStart(8)}`)
}

if (wantHours && perHourToday.size > 0) {
	console.log('')
	console.log(`== 今天按小时（${today}）==`)
	for (const [hour, value] of [...perHourToday.entries()].sort((a, b) => a[0] - b[0])) {
		const bar = '#'.repeat(Math.min(60, Math.round(value.total / Math.max(1, Math.max(...[...perHourToday.values()].map((v) => v.total))) * 60)))
		console.log(`  ${String(hour).padStart(2)}:00  ${k(value.total).padStart(8)}  ${bar}`)
	}
}

console.log('')
console.log(`== 最近 ${days} 天最烧 token 的 ${top} 个会话 ==`)
const ranked = [...perSession.values()].sort((a, b) => b.total - a.total).slice(0, top)
for (const value of ranked) {
	console.log(`  ${k(value.total).padStart(8)}  请求 ${String(value.calls).padStart(4)}次  未命中 ${k(value.input).padStart(7)}  缓存 ${k(value.cache).padStart(8)}  输出 ${k(value.output).padStart(7)}  ${titleOf(value.sessionId)}`)
	console.log(`             ${value.sessionId}  最后活动 ${new Date(value.last).toLocaleString()}`)
}
const grand = [...perSession.values()].reduce((sum, value) => sum + value.total, 0)
console.log('')
console.log(`合计（最近 ${days} 天）: ${k(grand)} tokens，其中未命中输入 ${k([...perSession.values()].reduce((s, v) => s + v.input, 0))}、输出 ${k([...perSession.values()].reduce((s, v) => s + v.output, 0))}`)
console.log('提示：未命中输入 = 每轮把整段上下文重发一遍里"没命中缓存"的部分；输出（含推理）单价最高。')
console.log('      上下文越长 × 步数越多 = 乘数。把长会话收尾、少跑"读一整个大文件/跑长测试"的任务，掉得就慢。')
