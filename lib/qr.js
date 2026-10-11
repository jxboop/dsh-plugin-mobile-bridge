/**
 * 零依赖 QR 编码器（byte 模式，纠错等级 M，版本 1–10）。
 *
 * 为什么自己写而不是找现成的：
 *   ① 插件的运行时依赖**必须保持零** ✓（只用 Node 内置模块，见 package.json ✓）；
 *   ② **绝不能用在线二维码服务** ✗✗ —— 要编码的地址里带着 `pathSecret`
 *      （`https://<机器>.<tailnet>.ts.net/<pathSecret>/` ✓），把它发给第三方等于把密钥送出去 ✓。
 *
 * 覆盖范围：版本 1–10、纠错等级 M（v10-M 能装 213 字节 ✓，够放网址 + 一点余量 ✓）。
 * 版本按数据长度**自动选**（够用就取最小的 ✓ —— 码越小越容易扫 ✓）。
 *
 * 正确性怎么保证：`test/qr.mjs` 里做**往返解码** ✓ —— 把生成的矩阵画成位图，
 * 交给真正的解码器（jsqr，仅测试依赖 ✓）读回来，必须和原文一字不差 ✓。
 * 单靠"看起来像个二维码"是不够的 ✗：错一个模块就是"扫不出来"，比没有更糟 ✓。
 */

/** 每个版本（1–10）在纠错等级 M 下的分块结构（ISO/IEC 18004 表 9 ✓）。 */
const VERSIONS = [
	// version, ecPerBlock, [ [blocks, dataCodewordsPerBlock], ... ]
	{ version: 1, ec: 10, groups: [[1, 16]] },
	{ version: 2, ec: 16, groups: [[1, 28]] },
	{ version: 3, ec: 26, groups: [[1, 44]] },
	{ version: 4, ec: 18, groups: [[2, 32]] },
	{ version: 5, ec: 24, groups: [[2, 43]] },
	{ version: 6, ec: 16, groups: [[4, 27]] },
	{ version: 7, ec: 18, groups: [[4, 31]] },
	{ version: 8, ec: 22, groups: [[2, 38], [2, 39]] },
	{ version: 9, ec: 22, groups: [[3, 36], [2, 37]] },
	{ version: 10, ec: 26, groups: [[4, 43], [1, 44]] },
]

/** 每个版本的对齐图形中心坐标（ISO 表 E.1 ✓）。 */
const ALIGNMENT = {
	1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
	6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

/** 版本信息（v7 起才有）18 位，ISO 表 D.1 ✓。 */
const VERSION_INFO = { 7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3 }

/** 纠错等级 M 对应的 2 位标识（ISO 表 12：L=01、M=00、Q=11、H=10 ✓）。 */
const EC_BITS = 0b00

/* ------------------------------------------------------------------ GF(256) */

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
	let x = 1
	for (let i = 0; i < 255; i++) {
		EXP[i] = x
		LOG[x] = i
		x <<= 1
		// 本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D ✓
		if ((x & 0x100) !== 0) x ^= 0x11D
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

/** 生成 n 个纠错码字的生成多项式（首一，系数按从高到低 ✓）。 */
function generatorPoly(n) {
	let poly = [1]
	for (let i = 0; i < n; i++) {
		const next = new Array(poly.length + 1).fill(0)
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j]
			next[j + 1] ^= mul(poly[j], EXP[i])
		}
		poly = next
	}
	return poly
}

function mul(a, b) {
	if (a === 0 || b === 0) return 0
	return EXP[LOG[a] + LOG[b]]
}

/** 对一段数据算 n 个纠错码字（多项式长除法 ✓）。 */
function eccFor(data, n) {
	const gen = generatorPoly(n)
	const rest = new Uint8Array(data.length + n)
	rest.set(data)
	for (let i = 0; i < data.length; i++) {
		const factor = rest[i]
		if (factor === 0) continue
		for (let j = 0; j < gen.length; j++) rest[i + j] ^= mul(gen[j], factor)
	}
	return rest.slice(data.length)
}

/* ------------------------------------------------------------------- 位流 */

function pushBits(bits, value, length) {
	for (let i = length - 1; i >= 0; i--) bits.push(((value >>> i) & 1) === 1)
}

/** 字符计数指示符的位宽（byte 模式，版本 1–9 是 8 位，10–26 是 16 位 ✓）。 */
const countBits = (version) => (version <= 9 ? 8 : 16)

function totalDataCodewords(spec) {
	return spec.groups.reduce((sum, [blocks, data]) => sum + blocks * data, 0)
}

function pickVersion(byteLength) {
	for (const spec of VERSIONS) {
		// 4 位模式指示符 + 字符计数 + 数据 + 最多 4 位结束符，换算成字节数要装得下 ✓。
		const capacity = totalDataCodewords(spec)
		const needed = Math.ceil((4 + countBits(spec.version) + byteLength * 8) / 8)
		if (needed <= capacity) return spec
	}
	throw new Error(`qr: 内容太长（${byteLength} 字节），本编码器只支持到版本 10-M（213 字节）`)
}

/* ------------------------------------------------------------------- 矩阵 */

class Matrix {
	constructor(size) {
		this.size = size
		this.modules = Array.from({ length: size }, () => new Array(size).fill(false))
		this.reserved = Array.from({ length: size }, () => new Array(size).fill(false))
	}
	set(row, col, dark, reserve = true) {
		if (row < 0 || col < 0 || row >= this.size || col >= this.size) return
		this.modules[row][col] = dark === true
		if (reserve) this.reserved[row][col] = true
	}
	/** 功能图形：找正 + 分隔 + 定时 + 定位 + 固定黑点 + 格式/版本信息区。 */
	drawFunctionPatterns(version) {
		const size = this.size
		const finder = (row, col) => {
			for (let r = -1; r <= 7; r++) {
				for (let c = -1; c <= 7; c++) {
					if (r < 0 || c < 0 || r > 6 || c > 6) { this.set(row + r, col + c, false); continue }
					const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
					this.set(row + r, col + c, ring !== 2)
				}
			}
		}
		finder(0, 0)
		finder(0, size - 7)
		finder(size - 7, 0)

		// 定时图形（第 6 行 / 第 6 列，黑白交替 ✓）
		for (let i = 8; i < size - 8; i++) {
			this.set(6, i, i % 2 === 0)
			this.set(i, 6, i % 2 === 0)
		}

		// 定位图形（对齐）—— 跳过与三个找正图形重叠的位置 ✓
		const centers = ALIGNMENT[version] ?? []
		for (const row of centers) {
			for (const col of centers) {
				const nearFinder = (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)
				if (nearFinder) continue
				for (let r = -2; r <= 2; r++) {
					for (let c = -2; c <= 2; c++) {
						const ring = Math.max(Math.abs(r), Math.abs(c))
						this.set(row + r, col + c, ring !== 1)
					}
				}
			}
		}

		// 固定黑点 + 格式信息占位（先都标成 reserved，真正取值在下面几步 ✓）
		this.set(size - 8, 8, true)
		for (let i = 0; i < 9; i++) {
			if (i !== 6) { this.set(8, i, false); this.set(i, 8, false) }
		}
		for (let i = 0; i < 8; i++) {
			this.set(8, size - 1 - i, false)
			this.set(size - 1 - i, 8, false)
		}
		// 版本信息区（v7 起）先占位，避免数据写进去 ✓
		if (version >= 7) {
			for (let i = 0; i < 6; i++) {
				for (let j = 0; j < 3; j++) {
					this.set(size - 11 + j, i, false)
					this.set(i, size - 11 + j, false)
				}
			}
		}
	}
	drawFormat(ecBits, mask) {
		const size = this.size
		// 15 位：5 位数据（纠错等级 2 位 + 掩码 3 位）+ 10 位 BCH(15,5)，最后异或 0x5412 ✓
		const data = (ecBits << 3) | mask
		let rest = data << 10
		for (let i = 14; i >= 10; i--) {
			if (((rest >>> i) & 1) === 1) rest ^= 0x537 << (i - 10)
		}
		const bits = ((data << 10) | rest) ^ 0x5412
		const at = (i) => ((bits >>> i) & 1) === 1
		/*
		 * ⚠️ 位序**不能想当然**：15 位里 bit14 是最高位，而它放在 (8,0)（左上角横条的最左格 ✓）。
		 * 第一版我把 `at(i)` 直接铺在 (8,i) 上（顺序反了 ✗），结果解码器连"纠错等级 + 掩码"
		 * 都读不出来 —— 表现为**所有码都扫不出来** ✓（`test/qr.mjs` 的往返解码当场抓到 ✓）。
		 * 布局按 ISO/IEC 18004 图 25：
		 *   第一份：(8,0..5)=bit14..9、(8,7)=bit8、(8,8)=bit7、(7,8)=bit6、(5,8..0,8)=bit5..0
		 *   第二份：左下竖条 (size-1..size-7,8)=bit0..6；右上横条 (8,size-8..size-1)=bit7..14
		 *   （(size-8,8) 是那颗**固定黑点**，不参与格式信息 ✓）
		 */
		for (let i = 0; i <= 5; i++) this.set(8, i, at(14 - i))
		this.set(8, 7, at(8))
		this.set(8, 8, at(7))
		this.set(7, 8, at(6))
		// 左下竖条：(0,8)=bit0 … (5,8)=bit5 ✓（**别写成镜像** ✗ —— 第一版就是这么错的）
		for (let i = 0; i <= 5; i++) this.set(i, 8, at(i))
		for (let i = 0; i <= 6; i++) this.set(size - 1 - i, 8, at(i))
		for (let i = 7; i <= 14; i++) this.set(8, size - 15 + i, at(i))
	}
	drawVersion(version) {
		if (version < 7) return
		const info = VERSION_INFO[version]
		const size = this.size
		for (let i = 0; i < 18; i++) {
			const bit = ((info >>> i) & 1) === 1
			const row = Math.floor(i / 3)
			const col = i % 3
			this.set(size - 11 + col, row, bit)
			this.set(row, size - 11 + col, bit)
		}
	}
	/** 数据位的之字形填充（从右下角起，两列一组，避开功能图形 ✓）。 */
	placeData(bits) {
		const size = this.size
		let index = 0
		let upward = true
		for (let right = size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5   // 让开第 6 列（竖定时图形 ✓）
			for (let step = 0; step < size; step++) {
				const row = upward ? size - 1 - step : step
				for (let j = 0; j < 2; j++) {
					const col = right - j
					if (this.reserved[row][col] === true) continue
					this.modules[row][col] = index < bits.length ? bits[index] === true : false
					index += 1
				}
			}
			upward = !upward
		}
	}
	applyMask(mask) {
		const size = this.size
		for (let row = 0; row < size; row++) {
			for (let col = 0; col < size; col++) {
				if (this.reserved[row][col] === true) continue
				if (maskAt(mask, row, col) === true) this.modules[row][col] = this.modules[row][col] !== true
			}
		}
	}
}

/** 8 种掩码（ISO 表 10 ✓）。 */
function maskAt(mask, row, col) {
	switch (mask) {
		case 0: return (row + col) % 2 === 0
		case 1: return row % 2 === 0
		case 2: return col % 3 === 0
		case 3: return (row + col) % 3 === 0
		case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
		case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
		case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
		case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
		default: return false
	}
}

/** 四个惩罚项（ISO 表 11 ✓）—— 选惩罚最低的掩码，扫起来最稳 ✓。 */
function penalty(modules) {
	const size = modules.length
	let score = 0
	const runScore = (len) => (len >= 5 ? 3 + (len - 5) : 0)
	const lines = []
	for (let i = 0; i < size; i++) {
		lines.push(modules[i].map((v) => (v === true ? 1 : 0)))
		lines.push(modules.map((row) => (row[i] === true ? 1 : 0)))
	}
	// ① 同色连续 ≥5；③ 出现 1011101 0000 / 0000 1011101 这样的"像找正图形"的花纹
	for (const line of lines) {
		let run = 1
		for (let i = 1; i < line.length; i++) {
			if (line[i] === line[i - 1]) run += 1
			else { score += runScore(run); run = 1 }
		}
		score += runScore(run)
		const text = line.join('')
		for (const pattern of ['10111010000', '00001011101']) {
			let at = text.indexOf(pattern)
			while (at !== -1) { score += 40; at = text.indexOf(pattern, at + 1) }
		}
	}
	// ② 2×2 同色块
	for (let row = 0; row < size - 1; row++) {
		for (let col = 0; col < size - 1; col++) {
			const a = modules[row][col]
			if (a === modules[row][col + 1] && a === modules[row + 1][col] && a === modules[row + 1][col + 1]) score += 3
		}
	}
	// ④ 黑白比例偏离 50%
	let dark = 0
	for (const row of modules) for (const value of row) if (value === true) dark += 1
	const percent = (dark * 100) / (size * size)
	score += Math.floor(Math.abs(percent - 50) / 5) * 10
	return score
}

/* ------------------------------------------------------------------- 组装 */

/** 把数据码字按块分组、算纠错、再交错排列（ISO 7.6 ✓）。 */
function interleave(dataCodewords, spec) {
	const blocks = []
	let offset = 0
	for (const [count, dataLength] of spec.groups) {
		for (let i = 0; i < count; i++) {
			const data = dataCodewords.slice(offset, offset + dataLength)
			offset += dataLength
			blocks.push({ data, ec: eccFor(data, spec.ec) })
		}
	}
	const out = []
	const maxData = Math.max(...blocks.map((block) => block.data.length))
	for (let i = 0; i < maxData; i++) {
		for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
	}
	for (let i = 0; i < spec.ec; i++) {
		for (const block of blocks) out.push(block.ec[i])
	}
	return out
}

/**
 * 生成二维码矩阵。
 * @param {string} text 要编码的内容（按 UTF-8 字节编码 ✓）
 * @returns {{ size: number, version: number, mask: number, modules: boolean[][] }}
 */
export function qrMatrix(text) {
	const bytes = Buffer.from(String(text), 'utf8')
	const spec = pickVersion(bytes.length)
	const version = spec.version
	const capacity = totalDataCodewords(spec)

	const bits = []
	pushBits(bits, 0b0100, 4)                  // byte 模式 ✓
	pushBits(bits, bytes.length, countBits(version))
	for (const byte of bytes) pushBits(bits, byte, 8)
	// 结束符最多 4 位，然后补 0 到字节边界 ✓
	for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(false)
	while (bits.length % 8 !== 0) bits.push(false)
	// 交替填充 0xEC / 0x11 到满 ✓
	const padBytes = [0xEC, 0x11]
	let padIndex = 0
	while (bits.length < capacity * 8) {
		pushBits(bits, padBytes[padIndex % 2], 8)
		padIndex += 1
	}

	const dataCodewords = []
	for (let i = 0; i < bits.length; i += 8) {
		let value = 0
		for (let j = 0; j < 8; j++) value = (value << 1) | (bits[i + j] === true ? 1 : 0)
		dataCodewords.push(value)
	}
	const finalCodewords = interleave(dataCodewords, spec)
	const finalBits = []
	for (const codeword of finalCodewords) for (let i = 7; i >= 0; i--) finalBits.push(((codeword >>> i) & 1) === 1)

	const size = version * 4 + 17
	let best = null
	for (let mask = 0; mask < 8; mask++) {
		const matrix = new Matrix(size)
		matrix.drawFunctionPatterns(version)
		matrix.placeData(finalBits)
		matrix.applyMask(mask)
		matrix.drawFormat(EC_BITS, mask)
		matrix.drawVersion(version)
		const score = penalty(matrix.modules)
		if (best === null || score < best.score) best = { score, mask, matrix }
	}
	return { size, version, mask: best.mask, modules: best.matrix.modules }
}

/**
 * 生成 SVG（给桌面角标/地址卡用 ✓）。**不用 canvas**：注入到 DSH 界面里的 HTML
 * 越简单越好，SVG 一行 path 就够，而且放大不糊 ✓。
 * @param {string} text
 * @param {{ scale?: number, quiet?: number, dark?: string, light?: string }} [options]
 */
export function qrSvg(text, options = {}) {
	const scale = Number.isFinite(options.scale) && options.scale > 0 ? Math.floor(options.scale) : 4
	const quiet = Number.isFinite(options.quiet) && options.quiet >= 0 ? Math.floor(options.quiet) : 4
	const dark = typeof options.dark === 'string' && options.dark !== '' ? options.dark : '#000'
	const light = typeof options.light === 'string' && options.light !== '' ? options.light : '#fff'
	const { size, modules } = qrMatrix(text)
	// 一个 path 装下所有黑块（每个模块一个小方块）—— 比 size² 个 <rect> 小一个数量级 ✓。
	const parts = []
	for (let row = 0; row < size; row++) {
		for (let col = 0; col < size; col++) {
			if (modules[row][col] !== true) continue
			parts.push(`M${(col + quiet) * scale} ${(row + quiet) * scale}h${scale}v${scale}h-${scale}z`)
		}
	}
	const extent = (size + quiet * 2) * scale
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}" viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges">`
		+ `<rect width="${extent}" height="${extent}" fill="${light}"/>`
		+ `<path d="${parts.join('')}" fill="${dark}"/>`
		+ '</svg>'
}
