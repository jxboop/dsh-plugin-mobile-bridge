/**
 * 跨平台的「动电脑」命令形态 —— **纯函数** ✓（零依赖 ✓，不执行任何东西 ✗）。
 *
 * 为什么先抽这一个文件 ✗：这些命令**各自只能在自己的系统上跑** ✓（Windows 上验不了 mac 的 ✓），
 * 但"命令长什么样、哪一步做不到"是**纯逻辑** ✓ —— 抽出来就能在**任何一台机器上**验 ✓
 *（`test/platform.mjs` ✓），不必等真 Mac ✓。这也是 macOS 勘察报告 §7 的建议 ✓。
 *
 * ⚠️ 两条纪律 ✓：
 *   ① **能力差异写进返回值** ✓（`can` / `note` ✓）—— 不许让 mac 假装有 Windows 的东西 ✗。
 *      最典型的是关机：Windows 有 **20 秒系统倒计时 + `shutdown /a` 取消** ✓；
 *      **mac 没有** ✗ → 只能由插件自己计时 ✓（`note` 里写明 ✓ —— 照搬 Windows 语义就会做成
 *      "看着能取消"的假象 ✗，那是本项目最不能接受的一类错 ✓）。
 *   ② **绝不代输密码** ✓：锁屏跑在系统的安全桌面（Winlogon / loginwindow ✓）上 ✓，
 *      普通程序既不能注入按键、也不能代提交凭据 ✓（这是系统**设计** ✓）。
 *      所以"解锁"= **发一次无害的唤醒输入 + 再查一次状态** ✓，然后**照实**说结果 ✓
 *      （"已解锁" ✓ / "还锁着，要密码" ✓ / "读不到状态" ✓）—— 不猜、不装作成功 ✗。
 *      📌 本项目**不收、不存、不转发**用户的开机密码 ✗（见 `lib/power.js` 的口径 ✓）。
 */

/** 归一化平台名 ✓（只认我们要区分的三种 ✓）。 */
export function platformId(platform) {
	if (platform === 'win32') return 'win32'
	if (platform === 'darwin') return 'darwin'
	return 'other'
}

/** 锁屏 ✓（两边都有原生做法 ✓）。 */
export function lockCommand(platform) {
	if (platformId(platform) === 'win32') {
		return { can: true, command: 'rundll32.exe', args: ['user32.dll,LockWorkStation'], note: '' }
	}
	if (platformId(platform) === 'darwin') {
		// ⌃⌘Q 是 mac 的锁屏键 ✓；**要"辅助功能"权限** ✓（没给就是没反应 —— 所以 note 要写上 ✓）。
		return {
			can: true, command: 'osascript',
			args: ['-e', 'tell application "System Events" to keystroke "q" using {control down, command down}'],
			note: 'mac 走 ⌃⌘Q ✓，需要给"辅助功能"权限 ✓',
		}
	}
	return { can: false, command: '', args: [], note: `这台系统（${platform}）没有实现锁屏 ✓` }
}

/**
 * **唤醒输入** ✓ —— 屏幕黑着/屏保时把它叫醒 ✓。**不代输任何密码** ✗。
 * win32 用一次 1 像素的鼠标移动 ✓（`mouse_event` ✓，无害 ✓）；mac 用 `caffeinate -u -t 1` ✓
 *（声明"用户活动" ✓ —— 正是唤醒 ✓，而且**不需要任何权限** ✓，比 osascript 稳 ✓）。
 */
export function wakeCommand(platform) {
	if (platformId(platform) === 'win32') {
		const code = '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);'
		return {
			can: true, command: 'powershell.exe',
			args: ['-NoProfile', '-NonInteractive', '-Command',
				`Add-Type -Namespace DshWake -Name U -MemberDefinition '${code}'; [DshWake.U]::mouse_event(1,1,0,0,0)`],
			note: '',
		}
	}
	if (platformId(platform) === 'darwin') {
		return { can: true, command: 'caffeinate', args: ['-u', '-t', '1'], note: '' }
	}
	return { can: false, command: '', args: [], note: `这台系统（${platform}）没有实现唤醒 ✓` }
}

/**
 * 查"还锁着没" ✓ —— 解锁那一步**必须看结果再说话** ✓（这是这一条的全部意义 ✓）。
 * win32：`LogonUI.exe` 还在 = 锁屏还在 ✓（它只在锁屏期间跑 ✓）。
 * mac：**没有**"不装东西、又可靠"的查询 ✓（`CGSessionCopyCurrentDictionary` 要 Python/objc ✓）→
 * 如实标 `can: false` ✓，留一句"这条要在真 Mac 上定" ✓，**不编一个看起来能用的** ✗。
 */
export function unlockProbeCommand(platform) {
	if (platformId(platform) === 'win32') {
		return { can: true, command: 'tasklist.exe', args: ['/FI', 'IMAGENAME eq LogonUI.exe', '/NH'], note: '' }
	}
	if (platformId(platform) === 'darwin') {
		return {
			can: false, command: '', args: [],
			note: 'mac 上没有"不装东西又可靠"的锁屏状态查询 ✓ —— 这条要真机定 ✓（先不做假的 ✗）',
		}
	}
	return { can: false, command: '', args: [], note: `这台系统（${platform}）没有实现锁屏查询 ✓` }
}

/** `tasklist` 的输出判据 ✓（纯函数 ✓，好单测 ✓）：还能看到 LogonUI.exe 就是还锁着 ✓。 */
export function lockedFromTasklist(output) {
	return /LogonUI\.exe/i.test(String(output ?? ''))
}

/**
 * 「解锁」的**结论** ✓（纯函数 ✓）—— 输入是唤醒之后那次查询的结果 ✓，输出是**照实**要说的话 ✓。
 *
 * 三种结果，一个都不许含糊 ✓：
 *   · `unlocked` ✓ —— 查得到、而且锁屏不在了 ✓ → 真的解开了 ✓（没设密码 / 已自动登录的机器就是这样 ✓）；
 *   · `locked`   ✗ —— 查得到、锁屏还在 ✓ → **要密码** ✓，程序不能代按 ✓（这条最要紧：不能写成"失败"了事 ✓，
 *                 要在电脑上弹提示 + 响一声 ✓ —— 人在门口得知道 ✓）；
 *   · `unknown`  ✓ —— **查不到**（命令失败 / 这台系统没有这条查询 ✓）→ 就说**读不到** ✓，
 *                 既不猜"解开了" ✗，也不猜"还锁着" ✗。
 */
export function unlockVerdict(platform, probe) {
	const id = platformId(platform)
	if (id === 'darwin') {
		return {
			state: 'unknown',
			message: 'mac 上还没有"不装东西又可靠"的锁屏查询 ✓ —— 唤醒试过了 ✓，但是否解开**读不到** ✗（这条要真机定 ✓）',
		}
	}
	if (id !== 'win32') {
		return { state: 'unknown', message: `这台系统（${platform}）没有实现"解锁" ✓` }
	}
	if (probe?.ok !== true) {
		return { state: 'unknown', message: '读不到锁屏状态（' + String(probe?.message ?? '查询失败') + '）✗ —— 唤醒试过了 ✓，是否解开不知道 ✓' }
	}
	/*
	 * ⚠️ 2026-10-13 **红队复查逮到的撒谎路** ✗（原实现只看退出码 ✓）：
	 * 实测本机 tasklist /FI "IMAGENAME eq LogonUI.exe" /NH —— **命中与不命中都是 EXIT=0** ✓，
	 * 退出码根本不含"跑成了没"的信息 ✗ → 只要 stdout 空/乱码（编码、管道、策略拦截 ✓）
	 * 就会被说成「已解锁 ✓」✗✗。所以结论必须由**正向信号**推出来 ✓，认不出来一律 unknown ✓：
	 *   · 看到 LogonUI.exe → **还锁着** ✓；
	 *   · 看到"没有运行的任务 / No tasks are running"这类**空结果**标记 → **已解锁** ✓；
	 *   · 其它（空、乱码、没见过的本地化表头 ✓）→ **读不到** ✓（宁可说不知道，也不说错 ✗）。
	 */
	const signals = unlockSignals(probe.output)
	if (signals === 'locked') {
		return { state: 'locked', message: '还锁着 ✗ —— 这台电脑的锁屏要密码 ✓，程序**不能代按** ✗；去电脑上按一下就行 ✓（电脑上已经弹了提示 ✓）' }
	}
	if (signals === 'unlocked') {
		return { state: 'unlocked', message: '锁屏已经不在了 ✓（这台电脑没设密码 / 已自动登录 ✓ —— 唤醒之后它就进来了 ✓）' }
	}
	return {
		state: 'unknown',
		message: '读不到锁屏状态（唤醒试过了 ✓，但查询回的内容认不出来 ✓）—— 去电脑上看一眼最准 ✓',
	}
}

/**
 * 从一次查询的输出里读出**正向信号** ✓（纯函数 ✓，红队复查后加的 ✓）。
 * 认不出来就 unknown ✓ —— 这是这一条的全部意义：**不许由"没匹配到"反推结论** ✗。
 */
export function unlockSignals(output) {
	const text = String(output ?? '')
	if (/LogonUI\.exe/i.test(text) === true) return 'locked'
	// 空结果标记（中英文各一种 ✓）；别的语言认不出来 → unknown ✓（保守 ✓）。
	if (/没有运行的任务|No tasks are running|no match for the specified criteria/i.test(text) === true) return 'unlocked'
	return 'unknown'
}

/**
 * 关机 / 重启 / **取消** ✓。
 * ⚠️ mac **没有**系统级倒计时、也没有 `shutdown /a` 这种取消 ✓ → `cancel.can === false` ✓，
 * 由插件自己计时并自己"取消"（其实就是不发那条命令 ✓ —— 这一层含义写在 `note` 里 ✓）。
 */
export function powerCommand(platform, action, delaySeconds = 20) {
	const seconds = Math.max(0, Math.floor(Number(delaySeconds) || 0))
	if (platformId(platform) === 'win32') {
		if (action === 'shutdown') return { can: true, command: 'shutdown.exe', args: ['/s', '/t', String(seconds)], note: '' }
		if (action === 'restart') return { can: true, command: 'shutdown.exe', args: ['/r', '/t', String(seconds)], note: '' }
		if (action === 'cancel') return { can: true, command: 'shutdown.exe', args: ['/a'], note: '' }
		return { can: false, command: '', args: [], note: `不认识的关机动作：${action} ✗` }
	}
	if (platformId(platform) === 'darwin') {
		if (action === 'shutdown') return { can: true, command: 'osascript', args: ['-e', 'tell application "System Events" to shut down'], note: 'mac 立即执行 ✓ 没有系统倒计时 ✓' }
		if (action === 'restart') return { can: true, command: 'osascript', args: ['-e', 'tell application "System Events" to restart'], note: 'mac 立即执行 ✓ 没有系统倒计时 ✓' }
		if (action === 'cancel') return { can: false, command: '', args: [], note: 'mac 没有系统级取消 ✓ —— 倒计时要**插件自己计时**，取消就是"不发那条命令" ✓（别做成假的可取消 ✗）' }
		return { can: false, command: '', args: [], note: `不认识的关机动作：${action} ✗` }
	}
	return { can: false, command: '', args: [], note: `这台系统（${platform}）没有实现关机 ✓` }
}

/**
 * 剪贴板读 / 写 ✓。
 * ⚠️ 写**一律走 stdin** ✓（`pbcopy` 读 stdin ✓；Windows 用 `$input | Set-Clipboard` ✓）——
 * 正好满足本项目那条纪律：**剪贴板内容绝不走命令行参数** ✗（那会被进程列表看到 ✓）。
 */
export function clipboardCommand(platform, action) {
	if (platformId(platform) === 'win32') {
		if (action === 'read') return { can: true, command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], viaStdin: false, note: '' }
		if (action === 'write') return { can: true, command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'], viaStdin: true, note: '内容走 stdin ✓（不进命令行 ✓）' }
		return { can: false, command: '', args: [], viaStdin: false, note: `不认识的剪贴板动作：${action} ✗` }
	}
	if (platformId(platform) === 'darwin') {
		if (action === 'read') return { can: true, command: 'pbpaste', args: [], viaStdin: false, note: '' }
		if (action === 'write') return { can: true, command: 'pbcopy', args: [], viaStdin: true, note: '内容走 stdin ✓（天然满足"不进命令行"✓）' }
		return { can: false, command: '', args: [], viaStdin: false, note: `不认识的剪贴板动作：${action} ✗` }
	}
	return { can: false, command: '', args: [], viaStdin: false, note: `这台系统（${platform}）没有实现剪贴板 ✓` }
}

/** 截屏到指定文件 ✓（mac 要"屏幕录制"权限 ✓，第一次会弹窗 ✓）。 */
export function screenshotCommand(platform, file) {
	const target = String(file ?? '')
	if (target === '') return { can: false, command: '', args: [], note: '要给一个目标文件路径 ✓' }
	if (platformId(platform) === 'darwin') {
		// `-x` 不播放快门声 ✓（远程截屏响一声会很怪 ✓）。
		return { can: true, command: 'screencapture', args: ['-x', '-t', 'png', target], note: '需要"屏幕录制"权限 ✓（系统设置里给 ✓）' }
	}
	if (platformId(platform) === 'win32') {
		return { can: true, command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'DshScreenshot'], note: 'Windows 走 .NET 的 CopyFromScreen ✓（见 lib/clipboard.js ✓）' }
	}
	return { can: false, command: '', args: [], note: `这台系统（${platform}）没有实现截屏 ✓` }
}

/**
 * 结束进程 ✓。
 * ⚠️ mac 要**先 TERM 再复查再 KILL** ✓（直接 -9 会丢未保存的东西 ✗）；
 * Windows 那边现状是 `/T /F` ✓（保持不动 ✓）。
 */
export function killCommand(platform, pid, force = false) {
	const id = Math.floor(Number(pid) || 0)
	if (id <= 0) return { can: false, command: '', args: [], note: '要给一个有效的进程号 ✓' }
	if (platformId(platform) === 'win32') {
		return { can: true, command: 'taskkill.exe', args: ['/PID', String(id), '/T', ...(force === true ? ['/F'] : [])], note: force === true ? '强制 ✓' : '先温和一点 ✓' }
	}
	if (platformId(platform) === 'darwin') {
		return {
			can: true, command: 'kill', args: [force === true ? '-KILL' : '-TERM', String(id)],
			note: force === true ? '直接 KILL ✓（会丢未保存的东西 ✗ —— 只在 TERM 之后还活着时才用 ✓）' : '先 TERM ✓，过几秒复查 ✓，还活着再 KILL ✓',
		}
	}
	return { can: false, command: '', args: [], note: `这台系统（${platform}）没有实现结束进程 ✓` }
}
