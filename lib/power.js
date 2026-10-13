/**
 * 电脑端一键动作：锁屏 / 关机 / 重启（2.7.0 ★4）。
 *
 * 来源：用户上次直接找我说「帮我关机」✓ —— 那就把它做成一个正经按钮 ✓。
 *
 * 纪律（照交接文档 ✓，也照这个项目一贯的规矩 ✓）：
 *   · **锁屏**：一键、不用 PIN ✓ —— 它是"往安全方向走"的动作（把人挡在外面 ✓），
 *     多拦一道只会拦着正要离开的人 ✗；
 *   · **关机 / 重启**：默认**关** ✗（配置里 `powerControl: true` 才开 ✓）、**必须现输 PIN** ✓、
 *     界面上**要点两次**才真的执行 ✓（第一次是"我选它"，第二次是"真的执行"✓）；
 *   · 执行时**给 20 秒倒计时**（`shutdown /t 20` ✓）—— 这期间手机上还能「取消关机」 ✓
 *     （`shutdown /a` ✓）。有倒计时才谈得上"点错了还能救" ✓。
 *
 * 这一模块只做"构造命令 + 执行 + 确认"，"该不该执行"由路由层判 ✓（和 lib/system.js 一个分工 ✓）。
 */

import { execFile } from 'node:child_process'
import { platformId, lockCommand, wakeCommand, unlockProbeCommand, unlockVerdict,
	powerCommand as platformPowerCommand } from './platform.js'

export const LOCK = 'lock'
export const SHUTDOWN = 'shutdown'
export const RESTART = 'restart'
export const CANCEL = 'cancel'
/** 3.5.x 新动作 ✓：**解锁**（诚实版 ✓ —— 见下面 `runUnlock` 的注释 ✓）。 */
export const UNLOCK = 'unlock'

/** 关机/重启的倒计时秒数（这段时间内手机上可以取消 ✓）。 */
export const POWER_DELAY_SECONDS = 20

/**
 * 纯函数：给定动作 → 该跑什么命令（**测试就靠它** ✓ —— 没有它就只能拿真机关机来测了 ✗）。
 *
 * 2026-10-13（macOS 适配 ✓）：多了一个可选的 `platform` ✓ ——
 * **Windows 上的返回值与以前逐字段一致** ✓✓（`file` / `args` 都不动 ✓，`/c mobile-bridge` 也留着 ✓），
 * 只是把 mac 那一支（以及"这台系统做不到"的诚实结论 ✓）接进来了 ✓。
 * @returns {{ file: string, args: string[] } | null} 不认识的动作 / 这台系统做不到 → null ✓
 */
export function powerCommand(action, seconds = POWER_DELAY_SECONDS, platform = process.platform) {
	const wait = Math.max(0, Math.min(600, Math.floor(Number(seconds) || 0)))
	const id = platformId(platform)
	if (action === LOCK) {
		// 锁屏：Windows 上就这一条（不用 shutdown /l —— 那个在某些配置下会走注销 ✗）；mac 走 ⌃⌘Q ✓。
		if (id === 'win32') return { file: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] }
		const shaped = lockCommand(id)
		return shaped.can === true ? { file: shaped.command, args: shaped.args } : null
	}
	if (id === 'win32') {
		switch (action) {
			case SHUTDOWN:
				// 注释用 ASCII：`/c` 的文字会进 Windows 的关机提示，中文在部分代码页下是乱码 ✗。
				return { file: 'shutdown.exe', args: ['/s', '/t', String(wait), '/c', 'mobile-bridge'] }
			case RESTART:
				return { file: 'shutdown.exe', args: ['/r', '/t', String(wait), '/c', 'mobile-bridge'] }
			case CANCEL:
				return { file: 'shutdown.exe', args: ['/a'] }
			default:
				return null
		}
	}
	// mac（以及以后要加的别的系统 ✓）：形态在 lib/platform.js 里 ✓ —— 包括"做不到"的那几条 ✓。
	const shaped = platformPowerCommand(id, action === SHUTDOWN ? 'shutdown' : action === RESTART ? 'restart' : action === CANCEL ? 'cancel' : '', wait)
	if (shaped.can !== true) return null
	return { file: shaped.command, args: shaped.args }
}

/**
 * 真跑一条命令。不假装成功：失败把系统原话带回去 ✓。
 */
export function runPower(action, seconds = POWER_DELAY_SECONDS, platform = process.platform) {
	const command = powerCommand(action, seconds, platform)
	if (command === null) return Promise.resolve({ ok: false, message: '不支持的动作（或者这台系统做不到 ✓）' })
	return runCommand(command)
}

function runCommand(command, timeout = 10000) {
	return new Promise((resolve) => {
		execFile(command.file, command.args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
			if (error !== null) {
				resolve({ ok: false, message: String(stderr ?? '').trim() || String(error.message), output: String(stdout ?? '') })
				return
			}
			resolve({ ok: true, message: String(stdout ?? '').trim(), output: String(stdout ?? ''), command: `${command.file} ${command.args.join(' ')}` })
		})
	})
}

/**
 * 3.5.x「解锁」（用户 2026-10-13：「既然可以锁屏电脑那也加一个解锁的功能」✓）。
 *
 * ⚠️ **诚实版的解锁** ✗ —— 说清它是什么、不是什么 ✓：
 *   · **不是**"手机输密码帮你解锁" ✗：锁屏跑在系统的**安全桌面**（Winlogon ✓）上 ✓，
 *     普通程序既不能注入按键、也不能代提交凭据 ✓ —— 这是系统**设计** ✓。
 *     本项目**不收、不存、不转发**用户的开机密码 ✗（这条是硬线 ✓）。
 *   · **是**"发一次无害的**唤醒输入** ✓，然后**看结果再说话**" ✓：
 *     唤醒 → 查一次（Windows 查 `LogonUI.exe` ✓）→ 三种结论照实报 ✓
 *     （已解锁 ✓ / 还锁着要密码 ✗ / **读不到状态** ✓）。
 *     没设密码、或已自动登录的机器，到唤醒这一步就**真的解开了** ✓ —— 那是真的 ✓，不是话术 ✓。
 */
export async function runUnlock(platform = process.platform) {
	const id = platformId(platform)
	const wake = wakeCommand(id)
	if (wake.can !== true) return { ok: false, state: 'unknown', message: wake.note }
	const woke = await runCommand({ file: wake.command, args: wake.args }, 8000)
	if (woke.ok !== true) {
		// 唤醒都发不出去 —— 照样**照实说** ✓（不说"已解锁"✗，也不说"还锁着"✗）。
		return { ok: false, state: 'unknown', message: '唤醒输入没能发出去（' + woke.message + '）✗ —— 状态读不到 ✓' }
	}
	// 给屏幕一点时间醒过来 ✓（太快去查会查到一个还没反应的瞬间 ✓）。
	await new Promise((resolve) => setTimeout(resolve, 1500))
	const probe = unlockProbeCommand(id)
	if (probe.can !== true) {
		const verdict = unlockVerdict(id, { ok: false, message: probe.note })
		return { ok: false, state: verdict.state, message: verdict.message }
	}
	const probed = await runCommand({ file: probe.command, args: probe.args }, 8000)
	const verdict = unlockVerdict(id, { ok: probed.ok === true, output: probed.output, message: probed.message })
	return { ok: verdict.state === 'unlocked', state: verdict.state, message: verdict.message }
}
