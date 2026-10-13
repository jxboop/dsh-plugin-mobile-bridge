/**
 * 3.5.0 语音优先（免手对话）—— **纯函数核心** ✓（零依赖 ✓，只用 Node 内置 ✓）。
 *
 * 为什么核心在这边 ✗：宿主 `speechController` **没有流式识别** ✓（`transcribe` 是一次性的 ✓，
 * 见 3.5.0 的勘察 ✓），所以"一直听"只能由**手机侧切片** ✓：采一小段 → 编码 WAV → 逐段转写 ✓
 * → 把片段拼成一句话 ✓。拼接里最容易错的是**重叠去重** ✓（4 秒切片 + 0.4 秒重叠 ✓，
 * 切在词中间时同一截会被转两遍 ✗）—— 那是纯逻辑 ✓，放这儿，能单测 ✓。
 *
 * ⚠️ 这一版的安全口径（项目铁律 ✓）：**默认关** ✗（`voiceMode` 不配就是关的 ✓）、
 * 开的时候**要现输 PIN** ✓（它开的是麦克风 ✓，和"读剪贴板/截屏"同级 ✓）、
 * **空闲超时自动关** ✓（手机上倒计时看得见 ✓）。
 */

/** 语音环的五个状态 ✓ —— 每一态都必须**在手机上看得见** ✗（不许"开了没开不知道"✓）。 */
export const VOICE_STATES = ['off', 'listening', 'transcribing', 'running', 'speaking']

/**
 * 状态机 ✓（纯查表 ✓，好读也好测）。
 *
 * `off → listening → transcribing → running → speaking → listening` ✓
 *   · `speech`：这一片里**有人声** ✓ → 去转写；
 *   · `transcribed`：转写回来了 ✓ → 发出去（开了自动发）→ agent 在跑；
 *   · `answered`：这一轮跑完了 ✓ → 开始念；
 *   · `spoke`：念完了 ✓ → 回去听；
 *   · `stop` / `fail`：任何一态都能进 ✓（**失败不静默** ✗：带一句人话回去 ✓）。
 */
const TRANSITIONS = {
	off: { start: 'listening' },
	listening: { speech: 'transcribing' },
	transcribing: { transcribed: 'running' },
	running: { answered: 'speaking' },
	speaking: { spoke: 'listening' },
}

/**
 * 走一步状态机 ✓。
 * 返回值一律是 `{ state, ok, reason }` ✓ —— **非法迁移不抛异常也不静默** ✗：
 * `ok: false` + 一句人话 ✓（手机上照实说"现在不能这样"✓，代码里也看得见 ✓）。
 */
export function nextVoiceState(state, event) {
	const from = VOICE_STATES.includes(state) === true ? state : 'off'
	if (event === 'stop') return { state: 'off', ok: true, reason: '' }
	if (event === 'fail') return { state: 'listening', ok: true, reason: '语音环出错了 —— 已经回到"在听" ✓' }
	const to = TRANSITIONS[from]?.[event]
	if (to === undefined) {
		return { state: from, ok: false, reason: `在 ${from} 这一态不能 ${event} ✗（先 stop 再重来 ✓）` }
	}
	return { state: to, ok: true, reason: '' }
}

/**
 * 把两段转写**拼成一句** ✓ —— 处理"切片重叠"带来的重复 ✓。
 *
 * 现场 ✗：切片是 4 秒 + 重叠 0.4 秒 ✓，所以相邻两段的文本尾巴/开头**天然有一截重复** ✓
 * （例："今天我们讲" / "讲一下语音" → 正确是"今天我们讲一下语音" ✓，
 * 直接相加会变成"今天我们讲讲一下语音" ✗ —— 用户看到的就是"它怎么结巴了"✓）。
 * 做法 ✓：在 `previous` 的**尾巴**里找最长的、同时是 `incoming` **开头**的片段 ✓
 * （长度 2～24 字 ✓）→ 把那一段去掉再拼 ✓。
 * ⚠️ 找不到重叠时**照实拼** ✓（宁可有重复，也不要**吃字** ✗ —— 吃字是更坏的错 ✓）。
 */
export function mergeTranscriptSegments(previous, incoming, options = {}) {
	const before = String(previous ?? '')
	const next = String(incoming ?? '').trim()
	if (next === '') return before
	if (before === '') return next
	const maxOverlap = Number.isFinite(options.maxOverlap) ? Number(options.maxOverlap) : 24
	const minOverlap = Number.isFinite(options.minOverlap) ? Number(options.minOverlap) : 2
	const limit = Math.min(maxOverlap, before.length, next.length)
	let cut = 0
	for (let length = limit; length >= minOverlap; length -= 1) {
		if (before.slice(-length) === next.slice(0, length)) { cut = length; break }
	}
	const rest = next.slice(cut)
	// 英文之间要留个空格 ✓（中文不加 ✓ —— 加了反而难看 ✓）。
	const needsSpace = rest !== '' && /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(rest)
	return before + (needsSpace ? ' ' : '') + rest
}

/** 片段数组 → 一句话 ✓（顺序拼 ✓，空片段跳过 ✓）。 */
export function mergeTranscriptList(segments, options = {}) {
	let text = ''
	for (const segment of Array.isArray(segments) ? segments : []) text = mergeTranscriptSegments(text, segment, options)
	return text
}

/**
 * 是不是"停" ✓（用户说一句就停 ✓）。
 * ⚠️ 只认**整句就是停**的写法 ✗ —— "停下来想想这个" 是内容 ✓，不能当成停止命令 ✗
 *（认错了会**吃掉用户的话** ✗，那比"没停下来"更糟 ✓）。
 */
const STOP_WORDS = ['停', '停止', '停下', '别说了', '不说了', '安静', '关闭', 'stop', 'quiet', 'shut up']
export function isStopCommand(text) {
	const clean = String(text ?? '').trim().toLowerCase().replace(/[\s。！!，,、.？?~～]+$/g, '')
	return STOP_WORDS.includes(clean)
}

/**
 * 这一片要不要**送去转写** ✓（省时间也省钱 ✓）。
 * 判据：去掉空白后**至少有 2 个字** ✓（纯噪声/呼吸声会被 VAD 与这条一起挡掉 ✓）。
 * 回到调用方的是 `{ send, reason }` ✓ —— 不送也**说得清为什么** ✓。
 */
export function shouldTranscribeChunk(text) {
	const clean = String(text ?? '').replace(/\s+/g, '')
	if (clean === '') return { send: false, reason: '这一片里没有人声 ✓' }
	if (clean.length < 2) return { send: false, reason: '太短了（可能只是呼吸声 ✓）' }
	return { send: true, reason: '' }
}

/** 声压（RMS）✓ —— 静音判定用它 ✓（阈值在调用方 ✓，这里只报数 ✓）。 */
export function rms(samples) {
	const list = samples ?? []
	if (list.length === 0) return 0
	let sum = 0
	for (let index = 0; index < list.length; index += 1) sum += list[index] * list[index]
	return Math.sqrt(sum / list.length)
}

/**
 * 切一片，**尾巴留一截重叠** ✓ —— 切在词中间时，那一截会在下一片里再出现一次 ✓，
 * 于是拼接时**有机会去重** ✓（`mergeTranscriptSegments` ✓）。
 * 返回 `{ piece, rest }` ✓（不改原数组 ✓ —— 调用方自己决定怎么存 ✓）。
 */
export function sliceWithOverlap(samples, sliceLength, keepLength) {
	const list = samples ?? []
	const slice = Math.max(1, Math.floor(Number(sliceLength) || 1))
	const keep = Math.max(0, Math.min(Math.floor(Number(keepLength) || 0), slice - 1))
	if (list.length < slice) return { piece: new Float32Array(0), rest: Float32Array.from(list), ready: false }
	return {
		piece: Float32Array.from(list.slice(0, slice)),
		rest: Float32Array.from(list.slice(slice - keep)),
		ready: true,
	}
}

/**
 * Float32 采样 → **16k 单声道 16bit WAV** 的字节 ✓。
 *
 * 为什么必须单测这一段 ✗：宿主那条 `/api/transcribe` 只吃"**16k 单声道 WAV 的 base64**" ✓
 *（它的 400 提示原话 ✓）。头写错一个字段（采样率 / 声道数 / 位深 / 长度 ✓）→ 要么当场 400 ✓，
 * 要么**更坏**：识别器吃进去却转出空白 ✗ —— 用户看到的是"它听不见我说话"✓，最难查 ✓。
 * 所以这里把字节**摆整齐** ✓，并由 `test/voice.mjs` 逐字段核对 ✓。
 *
 * 重采样是**线性抽样** ✓（够用 ✓：这是给识别器听的 ✓，不是给人听的 ✓）。
 */
export function encodeWav16k(samples, sampleRate) {
	const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 16000
	const ratio = rate > 16000 ? rate / 16000 : 1
	const input = samples ?? []
	const length = Math.max(1, Math.floor(input.length / ratio))
	const out = new Float32Array(length)
	for (let index = 0; index < length; index += 1) {
		const at = index * ratio
		const low = Math.floor(at)
		const high = Math.min(input.length - 1, low + 1)
		out[index] = input[low] * (1 - (at - low)) + input[high] * (at - low)
	}
	const bytes = new Uint8Array(44 + out.length * 2)
	const view = new DataView(bytes.buffer)
	const tag = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)) }
	tag(0, 'RIFF')
	view.setUint32(4, 36 + out.length * 2, true)   // 后面还有多少字节 ✓
	tag(8, 'WAVE')
	tag(12, 'fmt ')
	view.setUint32(16, 16, true)        // fmt 块长度 ✓
	view.setUint16(20, 1, true)         // 1 = PCM ✓
	view.setUint16(22, 1, true)         // 单声道 ✓
	view.setUint32(24, 16000, true)     // 采样率 **16000** ✓
	view.setUint32(28, 32000, true)     // 字节率 = 16000 × 1 × 2 ✓
	view.setUint16(32, 2, true)         // 每帧 2 字节 ✓
	view.setUint16(34, 16, true)        // 16 bit ✓
	tag(36, 'data')
	view.setUint32(40, out.length * 2, true)
	for (let index = 0; index < out.length; index += 1) {
		const clamped = Math.max(-1, Math.min(1, out[index]))
		view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
	}
	return bytes
}

/** 字节 → base64 ✓（浏览器用 `btoa` ✓、Node 用 `Buffer` ✓ —— 两边都能跑同一份 ✓）。 */
export function bytesToBase64(bytes) {
	const list = bytes ?? new Uint8Array(0)
	if (typeof btoa === 'function') {
		let binary = ''
		for (let index = 0; index < list.length; index += 1) binary += String.fromCharCode(list[index])
		return btoa(binary)
	}
	return Buffer.from(list).toString('base64')
}
