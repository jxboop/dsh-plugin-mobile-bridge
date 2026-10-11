/**
 * QR 编码器的测试（`lib/qr.js`）。
 *
 *   node test/qr.mjs
 *
 * 为什么单开一个套件：二维码**错一个模块就是"扫不出来"**，比没有二维码更糟 ✗。
 * 所以这里不止"结构看起来对"，而是**真的解码回来**：把矩阵画成位图，交给真正的
 * 解码器（`jsqr`）读，必须和原文一字不差 ✓。
 *
 * `jsqr` 是**仅测试**依赖（放 `..\_verify`，和 jsdom 一个路子 ✓）—— 插件运行时
 * 依旧是零依赖 ✓。拿不到解码器时：结构断言照跑（硬门槛 ✓），往返解码会**显式报缺** ✗
 * 而不是静默跳过（静默跳过等于没有这条测试 ✓）。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { qrMatrix, qrSvg } from '../lib/qr.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))

function loadDecoder() {
	const attempts = [
		join(HERE, '..', 'anchor.cjs'),
		join(HERE, '..', '..', '_verify', 'anchor.cjs'),
	]
	for (const anchor of attempts) {
		try { return createRequire(anchor)('jsqr') } catch { /* 试下一个 */ }
	}
	return null
}
const decode = loadDecoder()

const results = []
let skipped = 0
const check = (name, ok, detail = '') => {
	results.push({ name, ok })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 把矩阵画成位图（RGBA），静区 4 模块、每模块 scale 像素 —— 解码器要的就是这个 ✓。 */
function toRgba(modules, scale = 4, quiet = 4) {
	const size = modules.length
	const extent = (size + quiet * 2) * scale
	const data = new Uint8ClampedArray(extent * extent * 4).fill(255)
	for (let row = 0; row < size; row++) {
		for (let col = 0; col < size; col++) {
			if (modules[row][col] !== true) continue
			for (let y = 0; y < scale; y++) {
				for (let x = 0; x < scale; x++) {
					const px = ((row + quiet) * scale + y) * extent + ((col + quiet) * scale + x)
					data[px * 4] = 0
					data[px * 4 + 1] = 0
					data[px * 4 + 2] = 0
					data[px * 4 + 3] = 255
				}
			}
		}
	}
	return { data, extent }
}

/** 自己把格式信息读回来：15 位 = (等级 2 位 + 掩码 3 位) + BCH(15,5)，整体异或 0x5412 ✓。 */
function readFormat(modules) {
	const size = modules.length
	const bit = (row, col) => (modules[row][col] === true ? 1 : 0)
	let bits = 0
	for (let i = 0; i <= 5; i++) bits = (bits << 1) | bit(8, i)
	bits = (bits << 1) | bit(8, 7)
	bits = (bits << 1) | bit(8, 8)
	bits = (bits << 1) | bit(7, 8)
	for (let i = 9; i <= 14; i++) bits = (bits << 1) | bit(14 - i, 8)
	const unmasked = bits ^ 0x5412
	// 校验 BCH：除以 0x537 余数必须为 0 ✓
	let rest = unmasked
	for (let i = 14; i >= 10; i--) if (((rest >>> i) & 1) === 1) rest ^= 0x537 << (i - 10)
	const ecBits = (unmasked >>> 13) & 0b11
	const mask = (unmasked >>> 10) & 0b111
	return { valid: rest === 0, ecBits, mask }
}

/* --- ① 结构 ----------------------------------------------------------------- */

{
	const qr = qrMatrix('HELLO WORLD')
	check('短内容自动选版本 1（够用就取最小的：码越小越容易扫）',
		qr.version === 1 && qr.size === 21, `version=${qr.version} size=${qr.size}`)

	const finderOk = (row, col) => {
		let ok = true
		for (let r = 0; r < 7; r++) {
			for (let c = 0; c < 7; c++) {
				const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
				if (qr.modules[row + r][col + c] !== (ring !== 2)) ok = false
			}
		}
		return ok
	}
	check('三个找正图形都在（左上 / 右上 / 左下）',
		finderOk(0, 0) && finderOk(0, qr.size - 7) && finderOk(qr.size - 7, 0))

	let timing = true
	for (let i = 8; i < qr.size - 8; i++) {
		if (qr.modules[6][i] !== (i % 2 === 0)) timing = false
		if (qr.modules[i][6] !== (i % 2 === 0)) timing = false
	}
	check('定时图形黑白交替（解码器靠它认列/行）', timing)

	const format = readFormat(qr.modules)
	check('格式信息自洽：BCH 校验通过、纠错等级是 M、掩码和返回值一致',
		format.valid === true && format.ecBits === 0b00 && format.mask === qr.mask,
		JSON.stringify({ ...format, reported: qr.mask }))
	check('深色模块比例不离谱（30%~70%，否则多半是掩码选错了）', (() => {
		let dark = 0
		for (const row of qr.modules) for (const value of row) if (value) dark += 1
		const percent = (dark * 100) / (qr.size * qr.size)
		return percent > 30 && percent < 70
	})())
}

/* --- ② 版本选择（装得下 / 装不下）------------------------------------------- */

{
	// byte 模式下的真实容量（ISO 表 7）：v1-M 装 **14** 字节、v2-M 装 26 字节 ✓
	// （别按"数据码字 16 个"想 —— 模式指示符 4 位 + 字符计数 8 位也占地方 ✓）
	const small = qrMatrix('x'.repeat(14))
	const bigger = qrMatrix('x'.repeat(30))
	check('14 字节还在版本 1，30 字节自动升级（容量按 ISO 表 7 ✓）',
		small.version === 1 && bigger.version === 3, `v${small.version} → v${bigger.version}`)

	// v7 起才写版本信息那块 18 位 ✓
	const v7 = qrMatrix('x'.repeat(140))
	check('长内容进到 v7+ 并把版本信息写进矩阵（BCH 18 位）', v7.version >= 7, `version=${v7.version}`)
	const expected = { 7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3 }[v7.version]
	if (expected !== undefined) {
		let got = 0
		for (let i = 17; i >= 0; i--) {
			const row = Math.floor(i / 3)
			const col = i % 3
			got = (got << 1) | (v7.modules[v7.size - 11 + col][row] === true ? 1 : 0)
		}
		check('版本信息那 18 位等于 ISO 表 D.1 的值（解码器据此判断码的大小）',
			got === expected, `0x${got.toString(16)} vs 0x${expected.toString(16)}`)
	} else {
		check('版本超过本编码器支持范围（不该发生）', false, `version=${v7.version}`)
	}

	let threw = false
	try { qrMatrix('x'.repeat(400)) } catch { threw = true }
	check('超长内容**明确报错**（不生成一个扫不出来的码 ✗）', threw)
}

/* --- ③ 往返解码（这条才是真门槛 ✓）------------------------------------------ */

if (decode === null) {
	/*
	 * 2.7.1：**明确 SKIP，不是"通过"、也不是"失败"** ✓。
	 *
	 * 现场（冷视角复查发现的真问题）：`jsqr` 装在**源码目录旁边**的 `..\_verify` ✓，
	 * 而**发布目录那份测试找不到它** ✗ → 在发布副本里跑 `node test/qr.mjs` 会红 ✓。
	 * 但往返解码**是编码器唯一的真验证** ✓ —— 悄悄跳过等于把它丢了 ✗✗，
	 * 所以这里打印得**很显眼**、并单独计入 skipped（汇总结尾会说出来 ✓）：
	 * 源码目录跑 = 12/12（含往返 ✓）；发布副本跑 = 11 通过 + **1 跳过（写明原因）** ✓。
	 * 要在这里也跑起来：`cd <插件目录>; npm i --no-save jsqr`（或把 jsqr 放到 `..\_verify` ✓）。
	 */
	skipped += 1
	console.log(`SKIP  往返解码（缺 jsqr —— 请在有 jsqr 的目录跑：npm i --no-save jsqr）  — 找到 ${process.cwd()}`)
} else {
	const payloads = [
		// 真实形状：桥给手机的那个地址（带密钥段 ✓）
		'https://crmer.tailc2a211.ts.net/06fa6e59f8d4e923/',
		// 局域网地址
		'http://192.168.1.20:3081/06fa6e59f8d4e923/',
		// 短内容 / 纯数字 / 带符号
		'HELLO WORLD',
		'123456',
		'tools/boot-up.ps1 -DryRun',
		// 长一点：走多块交错 + 纠错（v4-M 以上 ✓）
		'https://crmer.tailc2a211.ts.net/06fa6e59f8d4e923/?from=qr&ts=2026-10-11T23:59:59%2B08:00',
		'x'.repeat(180),
	]
	let allOk = true
	const failures = []
	for (const text of payloads) {
		const qr = qrMatrix(text)
		const { data, extent } = toRgba(qr.modules)
		const decoded = decode(data, extent, extent)
		const got = decoded === null || decoded === undefined ? null : decoded.data
		if (got !== text) {
			allOk = false
			failures.push(`v${qr.version} 长度 ${text.length}: ${got === null ? '(解不出来)' : `读回 "${String(got).slice(0, 30)}"`}`)
		}
	}
	check(`往返解码一字不差（${payloads.length} 个样本，含真实地址形状）`, allOk, failures.join(' | ') || '全部一致 ✓')
}

/* --- ④ SVG（桌面角标/地址卡用的那个）--------------------------------------- */

{
	const svg = qrSvg('https://example.ts.net/0123456789abcdef/')
	const qr = qrMatrix('https://example.ts.net/0123456789abcdef/')
	const extent = (qr.size + 8) * 4
	check('SVG 自带命名空间 + 尺寸 + 一个 path（不用 canvas、放大不糊）',
		svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.includes(`width="${extent}"`) && (svg.match(/<path /g) ?? []).length === 1,
		svg.slice(0, 90))
	check('SVG 可以安全地内联进网页（不含脚本/外链）',
		svg.includes('<script') === false && svg.includes('href') === false)
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipped > 0 ? ` · ${skipped} skipped（见上面 SKIP 那行 ✓）` : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
