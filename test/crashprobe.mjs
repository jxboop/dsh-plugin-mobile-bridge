/**
 * 崩溃探针开关的回归测试。
 *
 * 两件事必须守住：
 *
 * 1. 探针默认【关闭】。它跑在宿主进程里 —— 注册全局异常处理器、每 30 秒写盘，
 *    早期版本甚至猴补丁改写 process.exit。这些副作用绝不该出现在一个装给别人用的
 *    插件里，所以只有显式 `"crashProbe": true` 才允许启用。
 *
 * 2. crashProbe 必须能在配置重写中存活。loadConfig() 在"配置有变化"时会用一组
 *    固定字段整体重写配置文件；漏掉 crashProbe 就会把用户手动加的那行悄悄抹掉。
 *    测试用非法 tokenTtlHours 强制触发那次重写。
 *
 * 两个用例各用独立的临时 DSH_HOME 和独立端口。曾经共用一个目录时踩过坑：
 * bridge.start() 是异步的，loadConfig 惰性读文件，后一个用例改写端口会让前一个
 * 用例绑到新端口上 —— 那是测试竞态，不是产品缺陷。
 *
 * 假 ctx 按真实 Cordis 的语义模拟：apply() 期间注册的 ctx.effect 都归当前 fiber，
 * fiber 拆卸时【全部】清理器一起跑。
 *
 * 用法：node test/crashprobe.mjs [要测的 index.js 路径]
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = process.argv[2] ?? join(HERE, '..', 'lib', 'index.js')
const MODULE = pathToFileURL(resolve(TARGET)).href

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
	if (ok) { pass++; console.log(`  [PASS] ${label}${detail ? '  — ' + detail : ''}`) }
	else { fail++; console.log(`  [FAIL] ${label}${detail ? '  — ' + detail : ''}`) }
}

const homeA = mkdtempSync(join(tmpdir(), 'mb-probe-a-'))
const homeB = mkdtempSync(join(tmpdir(), 'mb-probe-b-'))
const cfgOf = (home) => join(home, 'mobile-bridge.json')
const crashOf = (home) => join(home, 'dsh-crash.log')

const BASE_PORT = 34000 + Math.floor(Math.random() * 2000)
const base = (port) => ({
	version: 1,
	port,
	pin: '123456',
	pathSecret: '0123456789abcdef',
	tokenTtlHours: 12,
	bindTokenToIp: false,
	elevationMinutes: 15,
})

const stubController = {
	create: async () => ({ id: 'stub' }),
	prompt: async () => {},
	cancel: async () => {},
	follow: async () => () => {},
	attachment: async () => null,
}

/** 模拟一个 fiber：apply 期间注册的 effect 在 teardown 时一起清理。 */
const makeCtx = () => {
	const effects = []
	const cleanups = []
	const ctx = {
		sessionController: stubController,
		effect: (fn, tag) => { effects.push({ fn, tag }); return () => {} },
		get: () => undefined,
		on: () => {},
	}
	const mount = () => {
		for (const e of effects) {
			const cleanup = e.fn()
			if (typeof cleanup === 'function') cleanups.push({ tag: e.tag, cleanup })
		}
	}
	const teardown = async () => {
		for (const c of cleanups.reverse()) {
			try { await c.cleanup() } catch { /* 拆卸不该抛 */ }
		}
		cleanups.length = 0
	}
	return { ctx, effects, mount, teardown }
}

const counts = () => ({
	unc: process.listenerCount('uncaughtException'),
	rej: process.listenerCount('unhandledRejection'),
	exit: process.listenerCount('exit'),
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

console.log(`目标模块: ${resolve(TARGET)}`)
console.log(`临时 HOME: A=${homeA}  B=${homeB}   基准端口 ${BASE_PORT}`)

/* ------------------------------------------------- A. 默认关闭 */
console.log('\n=== A. 默认（无 crashProbe）：不该动宿主的全局状态 ===')
process.env.DSH_HOME = homeA
writeFileSync(cfgOf(homeA), JSON.stringify(base(BASE_PORT), null, 2))
const exitBefore = process.exit
const beforeA = counts()
const modA = await import(`${MODULE}?a`)
const A = makeCtx()
modA.apply(A.ctx)
A.mount()
await wait(500)                      // 让 start() 真正绑上端口，再拆
const afterA = counts()

check('未注册 uncaughtException', afterA.unc === beforeA.unc, `${beforeA.unc} -> ${afterA.unc}`)
check('未注册 unhandledRejection', afterA.rej === beforeA.rej, `${beforeA.rej} -> ${afterA.rej}`)
check('未注册 exit', afterA.exit === beforeA.exit, `${beforeA.exit} -> ${afterA.exit}`)
check('未猴补丁 process.exit', process.exit === exitBefore)
check('未生成 dsh-crash.log', !existsSync(crashOf(homeA)))
check('没有注册 crash-probe effect（整段被跳过）',
	A.effects.every((e) => e.tag !== 'mobile-bridge:crash-probe'),
	A.effects.map((e) => e.tag).join(', '))
check('listener effect 仍然注册（插件本体不受影响）',
	A.effects.some((e) => e.tag === 'mobile-bridge:listener'))
await A.teardown()
await wait(300)

/* ------------------------------------------------- B. 显式开启 */
console.log('\n=== B. crashProbe:true：启用探针，且能在配置重写中存活 ===')
process.env.DSH_HOME = homeB
// tokenTtlHours: 0 非法 → loadConfig 归一化为 12 → 与文件不同 → 触发整体重写。
// 这正是要守的场景。
writeFileSync(cfgOf(homeB), JSON.stringify({ ...base(BASE_PORT + 1), tokenTtlHours: 0, crashProbe: true }, null, 2))
const beforeB = counts()
const modB = await import(`${MODULE}?b`)
const B = makeCtx()
modB.apply(B.ctx)
B.mount()
const afterB = counts()

check('注册了 uncaughtException', afterB.unc === beforeB.unc + 1, `${beforeB.unc} -> ${afterB.unc}`)
check('注册了 unhandledRejection', afterB.rej === beforeB.rej + 1, `${beforeB.rej} -> ${afterB.rej}`)
check('注册了 exit', afterB.exit === beforeB.exit + 1, `${beforeB.exit} -> ${afterB.exit}`)
check('注册了 crash-probe effect', B.effects.some((e) => e.tag === 'mobile-bridge:crash-probe'))

await wait(1500)

const round = JSON.parse(readFileSync(cfgOf(homeB), 'utf8'))
check('配置确实被重写过（tokenTtlHours 被归一化）', round.tokenTtlHours === 12, `tokenTtlHours=${round.tokenTtlHours}`)
check('★ 重写后 crashProbe 仍然存在', round.crashProbe === true, `crashProbe=${JSON.stringify(round.crashProbe)}`)

// 心跳要 30 秒才落一次，等不起；直接触发一次真实的 exit 处理器，证明写盘通路是通的。
process.emit('exit', 0)
await wait(150)
const logged = existsSync(crashOf(homeB)) ? readFileSync(crashOf(homeB), 'utf8') : ''
check('探针写盘通路可用', logged.includes('exit-event code=0'), logged.split('\n').filter(Boolean).pop() ?? '(空)')

await B.teardown()
await wait(300)
const afterTeardown = counts()
check('fiber 拆卸后移除 uncaughtException', afterTeardown.unc === beforeB.unc, `${afterTeardown.unc}`)
check('fiber 拆卸后移除 unhandledRejection', afterTeardown.rej === beforeB.rej, `${afterTeardown.rej}`)
check('fiber 拆卸后移除 exit', afterTeardown.exit === beforeB.exit, `${afterTeardown.exit}`)

/* ------------------------------------------------- 收尾 */
for (const h of [homeA, homeB]) {
	try { rmSync(h, { recursive: true, force: true }) } catch { /* 临时目录，删不掉不影响结论 */ }
}

console.log('\n================ 汇总 ================')
console.log(`  共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
