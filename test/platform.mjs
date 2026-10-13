/**
 * 跨平台命令形态的单测 ✓（`lib/platform.js` ✓，零依赖 ✓）。
 *
 *   node test/platform.mjs
 *
 * ⚠️ 它是**第 9 个**套件 ✓，**已经进** `tools/check-counts.mjs` 的清单 ✓（3.5.0 起 ✓ ——
 * 早先那句"暂时不进、等下次发版并进去"是 3.4.x 时代留下的口径 ✗，早就对不上了 ✓，复查点名后改正 ✓）。
 *
 * 这里钉的**不是**"命令看着像" ✗，而是三条真会出错的东西 ✓：
 *   ① 能力差异**必须如实** ✓（mac 没有关机倒计时/取消 ✓ → `can:false` + 一句人话 ✓，
 *      不许让 mac 假装有 Windows 的东西 ✗ —— 那会做成"看着能取消"的假象 ✗）；
 *   ② **绝不代输密码** ✓（解锁那条路只有"唤醒输入 + 查状态" ✓，没有"提交凭据"的形态 ✓）；
 *   ③ **剪贴板写入走 stdin** ✓（内容不进命令行参数 ✓ —— 进程列表里看不到 ✓）。
 */
import { platformId, lockCommand, wakeCommand, unlockProbeCommand, lockedFromTasklist, unlockVerdict,
	powerCommand, clipboardCommand, screenshotCommand, killCommand } from '../lib/platform.js'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
	if (ok) { pass += 1; console.log(`  PASS  ${name}${detail === '' ? '' : '  — ' + detail}`) }
	else { fail += 1; console.log(`  FAIL  ${name}${detail === '' ? '' : '  — ' + detail}`) }
}

console.log('平台归一化')
check('只认三种 ✓（win32 / darwin / 其它 ✓）',
	platformId('win32') === 'win32' && platformId('darwin') === 'darwin'
	&& platformId('linux') === 'other' && platformId(undefined) === 'other')

console.log('锁屏')
check('Windows：LockWorkStation ✓', lockCommand('win32').command === 'rundll32.exe'
	&& lockCommand('win32').args[0].includes('LockWorkStation'))
check('mac：⌃⌘Q ✓，并且**说明**要辅助功能权限 ✓（没给就没反应 ✓）',
	lockCommand('darwin').command === 'osascript' && lockCommand('darwin').note.includes('辅助功能'))
check('别的系统：`can:false` + 说清是哪台 ✓（不留一个空命令 ✗）',
	lockCommand('linux').can === false && lockCommand('linux').note !== '')

console.log('解锁：只发唤醒输入 + 查状态，**绝不代输密码** ✗')
check('Windows 唤醒：一次 1 像素鼠标移动 ✓（无害 ✓）',
	wakeCommand('win32').command === 'powershell.exe' && wakeCommand('win32').args.join(' ').includes('mouse_event'))
check('mac 唤醒：`caffeinate -u -t 1` ✓（**不需要任何权限** ✓ —— 比 osascript 稳 ✓）',
	wakeCommand('darwin').command === 'caffeinate' && wakeCommand('darwin').args.join(' ') === '-u -t 1')
check('mac 唤醒那条**不提**任何密码 ✓（这条是硬线 ✓）',
	wakeCommand('darwin').args.join(' ').includes('password') === false
	&& wakeCommand('win32').args.join(' ').includes('password') === false)
check('Windows 查询：查 LogonUI.exe ✓', unlockProbeCommand('win32').args.join(' ').includes('LogonUI.exe'))
check('🔴 mac 查询：**如实标做不到** ✓（不编一个看起来能用的 ✗）',
	unlockProbeCommand('darwin').can === false && unlockProbeCommand('darwin').note.includes('真机'))
check('tasklist 判据：有 LogonUI.exe = 还锁着 ✓；没有 = 解开了 ✓',
	lockedFromTasklist('LogonUI.exe  1234 Console  1  10,000 K') === true
	&& lockedFromTasklist('信息: 没有运行的任务匹配指定标准。') === false)

console.log('关机 / 重启 / 取消')
check('Windows：/s /t 20 ✓、/r /t 20 ✓、/a 取消 ✓',
	powerCommand('win32', 'shutdown', 20).args.join(' ') === '/s /t 20'
	&& powerCommand('win32', 'restart', 20).args.join(' ') === '/r /t 20'
	&& powerCommand('win32', 'cancel').args.join(' ') === '/a')
check('🔴 mac：关机/重启能做 ✓，但**取消做不到** ✓ —— `can:false` + 写明"由插件自己计时" ✓',
	powerCommand('darwin', 'shutdown').can === true && powerCommand('darwin', 'restart').can === true
	&& powerCommand('darwin', 'cancel').can === false && powerCommand('darwin', 'cancel').note.includes('自己计时'))
check('mac 关机的 note 写明"没有系统倒计时" ✓（不让人以为和 Windows 一样 ✗）',
	powerCommand('darwin', 'shutdown').note.includes('没有系统倒计时'))
check('不认识的动作用 `can:false` 说清 ✓（不是静默执行 ✗）',
	powerCommand('win32', 'hibernate').can === false && powerCommand('darwin', 'hibernate').can === false)

console.log('剪贴板：内容**绝不进命令行** ✗')
check('Windows：读用 Get-Clipboard ✓、写用 `$input | Set-Clipboard` ✓',
	clipboardCommand('win32', 'read').args.join(' ').includes('Get-Clipboard')
	&& clipboardCommand('win32', 'write').args.join(' ').includes('Set-Clipboard'))
check('🔴 mac：`pbpaste` 读 ✓、`pbcopy` 写 ✓，**写走 stdin** ✓',
	clipboardCommand('darwin', 'read').command === 'pbpaste'
	&& clipboardCommand('darwin', 'write').command === 'pbcopy'
	&& clipboardCommand('darwin', 'write').viaStdin === true)
check('两边的"写"都标了 viaStdin ✓（调用方据此把内容喂进去 ✓，不会拼到参数里 ✗）',
	clipboardCommand('win32', 'write').viaStdin === true && clipboardCommand('darwin', 'write').viaStdin === true)

console.log('截屏 / 结束进程')
check('mac 截屏：`screencapture -x -t png <file>` ✓，并写明要屏幕录制权限 ✓',
	screenshotCommand('darwin', '/tmp/a.png').args.join(' ') === '-x -t png /tmp/a.png'
	&& screenshotCommand('darwin', '/tmp/a.png').note.includes('屏幕录制'))
check('没给目标文件 → `can:false` ✓（不截到不知哪里去 ✗）',
	screenshotCommand('darwin', '').can === false)
check('Windows 杀进程保持现状 /T /F ✓（不许悄悄改行为 ✗）',
	killCommand('win32', 4242, true).args.join(' ') === '/PID 4242 /T /F')
check('🔴 mac 杀进程：先 `-TERM` ✓，强制才 `-KILL` ✓，并说明会丢未保存的东西 ✓',
	killCommand('darwin', 4242).args.join(' ') === '-TERM 4242'
	&& killCommand('darwin', 4242, true).args.join(' ') === '-KILL 4242'
	&& killCommand('darwin', 4242, true).note.includes('未保存'))
check('无效进程号 → `can:false` ✓（不把 0/-1 交给系统 ✗）',
	killCommand('darwin', 0).can === false && killCommand('win32', -3).can === false)

console.log('「解锁」的结论：三种结果一个都不许含糊')
check('🔴 查得到、锁屏不在了 → **已解锁** ✓（没设密码的机器就是这样 ✓ —— 这是真的 ✓，不是话术 ✓）',
	unlockVerdict('win32', { ok: true, output: '信息: 没有运行的任务匹配指定标准。' }).state === 'unlocked')
check('🔴 查得到、锁屏还在 → **还锁着要密码** ✓，并且说清"程序不能代按" ✓（最要紧的一条 ✓）',
	unlockVerdict('win32', { ok: true, output: 'LogonUI.exe  1234' }).state === 'locked'
	&& unlockVerdict('win32', { ok: true, output: 'LogonUI.exe  1234' }).message.includes('不能代按'))
check('🔴 查不到 → **读不到状态** ✓ —— 既不猜"解开了"✗、也不猜"还锁着"✗',
	unlockVerdict('win32', { ok: false, message: '拒绝访问' }).state === 'unknown'
	&& unlockVerdict('win32', { ok: false, message: '拒绝访问' }).message.includes('不知道'))
check('mac：如实标"读不到" ✓（不编一个看起来能用的 ✗）',
	unlockVerdict('darwin', { ok: true, output: 'whatever' }).state === 'unknown'
	&& unlockVerdict('darwin', { ok: true, output: 'whatever' }).message.includes('读不到'))
check('别的系统：`unknown` + 说清是哪台 ✓', unlockVerdict('linux', {}).state === 'unknown')

console.log(`\n  ${pass}/${pass + fail} checks passed`)
process.exit(fail === 0 ? 0 : 1)
