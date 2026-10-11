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

export const LOCK = 'lock'
export const SHUTDOWN = 'shutdown'
export const RESTART = 'restart'
export const CANCEL = 'cancel'

/** 关机/重启的倒计时秒数（这段时间内手机上可以取消 ✓）。 */
export const POWER_DELAY_SECONDS = 20

/**
 * 纯函数：给定动作 → 该跑什么命令（**测试就靠它** ✓ —— 没有它就只能拿真机关机来测了 ✗）。
 * @returns {{ file: string, args: string[] } | null} 不认识的动作返回 null ✓
 */
export function powerCommand(action, seconds = POWER_DELAY_SECONDS) {
	const wait = Math.max(0, Math.min(600, Math.floor(Number(seconds) || 0)))
	switch (action) {
		case LOCK:
			// 锁屏：Windows 上就这一条（不用 shutdown /l —— 那个在某些配置下会走注销 ✗）。
			return { file: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] }
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

/** 真跑一条命令。不假装成功：失败把系统原话带回去 ✓。 */
export function runPower(action, seconds = POWER_DELAY_SECONDS) {
	const command = powerCommand(action, seconds)
	if (command === null) return Promise.resolve({ ok: false, message: '不支持的动作' })
	return new Promise((resolve) => {
		execFile(command.file, command.args, { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
			if (error !== null) {
				resolve({ ok: false, message: String(stderr ?? '').trim() || String(error.message) })
				return
			}
			resolve({ ok: true, message: String(stdout ?? '').trim(), command: `${command.file} ${command.args.join(' ')}` })
		})
	})
}
