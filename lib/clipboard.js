/**
 * 剪贴板 & 截屏（2.7.0 池子里的 ★4：「电脑截图 → 手机立刻看到 ✓；手机复制的文字 → 进电脑剪贴板 ✓」）。
 *
 * 两条**安全/正确性**要点，都在这儿定死：
 *
 * ① **文字内容绝不走命令行** ✗✗。剪贴板里的东西是**用户随便什么东西**（可能带引号、换行、`$(…)`、
 *    中文、emoji ✓）—— 塞进 `powershell -Command "Set-Clipboard '…'"` 会同时踩两个雷：
 *    编码被 ANSI 代码页吃掉 ✗ + 内容被当成 PowerShell 代码执行 ✗（这就是注入 ✓）。
 *    所以：**内容一律走 stdin** ✓，命令行里只有 ASCII ✓。
 *
 * ② **截图是这台机器的屏幕**（可能含密码、聊天、任何东西 ✓）—— 所以它只挂在**已登录**的接口后面 ✓
 *    （和别的接口同一把锁 ✓），而且要**用完即删**（临时文件不留 ✓）。
 *
 * 插件依旧零依赖 ✓（`execFile` + PowerShell/.NET ✓，Node 侧不引任何图像库 ✓）。
 */

import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 跑一段 PowerShell：**命令用 ASCII 写，内容走 stdin** ✓。
 * 先把控制台输入编码设成 UTF-8（PS 5.1 默认按 ANSI 读管道 ✗，中文/emoji 会烂 ✓）。
 */
const PREAMBLE = '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false);'
const OUTPUT_UTF8 = '$OutputEncoding = [System.Text.UTF8Encoding]::new($false);'

function runPowerShell(script, { input = '', timeoutMs = 20000 } = {}) {
	// -EncodedCommand：命令本身也走 base64（UTF-16LE）—— 连"脚本里有中文"都不怕 ✓。
	const encoded = Buffer.from(`${PREAMBLE}${OUTPUT_UTF8}${script}`, 'utf16le').toString('base64')
	return new Promise((resolve) => {
		const child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
			{ timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error !== null && String(stdout ?? '') === '') {
					resolve({ ok: false, text: '', error: String(stderr ?? '').trim() || String(error.message) })
					return
				}
				resolve({ ok: true, text: String(stdout ?? ''), error: '' })
			})
		if (input !== '') child.stdin?.end(input, 'utf8')
		else child.stdin?.end()
	})
}

/** 读电脑剪贴板（纯文本 ✓；图片/文件会变成空 —— 那就如实说读不到 ✓）。
 *
 * ⚠️ **stdout 只走 ASCII**：让 PowerShell 把文字 **base64** 出来，Node 这边解码 ✓。
 * 为什么不能直接 `Get-Clipboard -Raw` 读 stdout：PS 5.1 的 stdout 走**控制台代码页** ✗，
 * 中文/emoji 到 Node 这边就是乱码 —— 2026-10-12 真机验证当场撞到 ✓（写进去、回读是一串
 * 问号方块 ✓）。**这里故意不把那段乱码原样粘上**：它含 U+FFFD，会触发"乱码自检" ✓
 * （`test/package.mjs` 那条守卫就是这么把我自己抓了一次的 ✓）。
 */
export async function readClipboard() {
	const result = await runPowerShell(
		'$t = Get-Clipboard -Raw -ErrorAction Stop; if ($null -eq $t) { "" } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }',
	)
	if (result.ok !== true) return { ok: false, error: result.error }
	const base64 = result.text.trim()
	if (base64 === '') return { ok: true, text: '' }
	try {
		return { ok: true, text: Buffer.from(base64, 'base64').toString('utf8') }
	} catch (error) {
		return { ok: false, error: `剪贴板文字解不开：${String(error?.message ?? error)}` }
	}
}

/** 把文字放进电脑剪贴板（**内容走 stdin，而且是 base64** ✓ —— 不碰代码页、也不会被当代码执行 ✓）。 */
export async function writeClipboard(text) {
	const value = String(text ?? '')
	if (value.length > 200000) return { ok: false, error: '内容太长了（上限 20 万字符）' }
	const encoded = Buffer.from(value, 'utf8').toString('base64')
	const result = await runPowerShell(
		'$b = [Console]::In.ReadToEnd(); $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b.Trim())); Set-Clipboard -Value $t -ErrorAction Stop; "ok"',
		{ input: encoded },
	)
	if (result.ok !== true) return { ok: false, error: result.error }
	return { ok: true, bytes: Buffer.byteLength(value, 'utf8') }
}

/**
 * 截屏 → PNG 字节。@param {{ maxWidth?: number }} options 宽了会等比缩小（手机上看得清就行 ✓，别传几 MB 过去 ✗）。
 */
export async function captureScreen(options = {}) {
	const maxWidth = Number.isFinite(options.maxWidth) && options.maxWidth >= 320 ? Math.floor(options.maxWidth) : 1280
	const target = join(tmpdir(), `dsh-screen-${randomBytes(6).toString('hex')}.png`)
	/*
	 * CopyFromScreen 要有**交互桌面** ✓：锁屏/无人登录时会抛 ✓ —— 那就如实把原因带回去 ✓
	 * （"截不到"和"截到一张全黑"是两件事，不能含糊 ✓）。
	 */
	const script = [
		'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
		'$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
		'$src = New-Object System.Drawing.Bitmap $b.Width, $b.Height;',
		'$g = [System.Drawing.Graphics]::FromImage($src);',
		'$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $src.Size);',
		`$max = ${maxWidth};`,
		'if ($src.Width -gt $max) {',
		'  $h = [int]($src.Height * $max / $src.Width);',
		'  $dst = New-Object System.Drawing.Bitmap $max, $h;',
		'  $g2 = [System.Drawing.Graphics]::FromImage($dst);',
		'  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
		'  $g2.DrawImage($src, 0, 0, $max, $h);',
		'  $dst.Save($env:DSH_SCREEN_OUT, [System.Drawing.Imaging.ImageFormat]::Png);',
		'  $g2.Dispose(); $dst.Dispose();',
		'} else {',
		'  $src.Save($env:DSH_SCREEN_OUT, [System.Drawing.Imaging.ImageFormat]::Png);',
		'}',
		'$g.Dispose(); $src.Dispose();',
		'"ok"',
	].join('\n')
	const encoded = Buffer.from(`${PREAMBLE}${OUTPUT_UTF8}${script}`, 'utf16le').toString('base64')
	const result = await new Promise((resolve) => {
		execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
			{ timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, DSH_SCREEN_OUT: target } },
			(error, stdout, stderr) => {
				if (error !== null) { resolve({ ok: false, error: String(stderr ?? '').trim() || String(error.message) }); return }
				resolve({ ok: true, text: String(stdout ?? '') })
			})
	})
	if (result.ok !== true || result.text.includes('ok') === false) {
		return { ok: false, error: result.error === '' ? '截屏命令没有成功（锁屏或没有交互桌面时就是这样）' : result.error }
	}
	try {
		const bytes = await readFile(target)
		return { ok: true, bytes, width: maxWidth, at: Date.now() }
	} catch (error) {
		return { ok: false, error: `截屏文件读不到：${String(error?.message ?? error)}` }
	} finally {
		// 用完即删 ✓（屏幕内容不该在磁盘上留着 ✓）。
		unlink(target).catch(() => {})
	}
}
