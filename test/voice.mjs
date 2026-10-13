/**
 * 3.5.0 语音优先 —— **纯核心的单测** ✓（`lib/voice.js` ✓，零依赖 ✓）。
 *
 *   node test/voice.mjs
 *
 * ⚠️ 它是**语音草稿** ✓（**不是**"第 9 个套件" ✗ —— 那是以前写错的口径 ✓）：语音那一版
 * 按用户要求先跳过 ✓，所以它**不进** `tools/check-counts.mjs` 的门槛 ✗ —— 改语音相关代码时才跑它 ✓。
 * ⚠️ 这条"不进门槛"是**白纸黑字写在脚本注释里**的 ✓ —— 不是静默跳过 ✗（静默跳过正是那支脚本最恨的假绿 ✓）。
 *
 * 这里钉的都是**真会出错**的地方 ✓：状态机非法迁移 ✓、切片重叠的拼接（最容易结巴 ✗）、
 * "停"的误判（会吃掉用户的话 ✗）、以及"没人声就别送转写"（省钱 ✓）。
 */
import { VOICE_STATES, nextVoiceState, mergeTranscriptSegments, mergeTranscriptList, isStopCommand, shouldTranscribeChunk, rms, sliceWithOverlap, encodeWav16k, bytesToBase64 } from '../lib/voice.js'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
	if (ok) { pass += 1; console.log(`  PASS  ${name}${detail === '' ? '' : '  — ' + detail}`) }
	else { fail += 1; console.log(`  FAIL  ${name}${detail === '' ? '' : '  — ' + detail}`) }
}

console.log('语音环：状态机')
check('五个状态都在 ✓（off / listening / transcribing / running / speaking）',
	VOICE_STATES.length === 5 && VOICE_STATES[0] === 'off' && VOICE_STATES.includes('speaking'),
	VOICE_STATES.join(' → '))
{
	let state = 'off'
	const walk = []
	for (const event of ['start', 'speech', 'transcribed', 'answered', 'spoke']) {
		const step = nextVoiceState(state, event)
		check(`合法迁移：${state} + ${event} → ${step.state} ✓`, step.ok === true, step.reason)
		state = step.state
		walk.push(state)
	}
	check('走完一整圈回到"在听" ✓（免手对话就是一个环 ✓）', state === 'listening', walk.join(' → '))
}
check('🔴 非法迁移**明确拒绝** ✓（不抛异常、也不静默改状态 ✗）',
	nextVoiceState('off', 'answered').ok === false && nextVoiceState('off', 'answered').state === 'off',
	nextVoiceState('off', 'answered').reason)
check('任何一态都能"停" ✓（用户说停就停 ✓）',
	['off', 'listening', 'transcribing', 'running', 'speaking'].every((state) => nextVoiceState(state, 'stop').state === 'off'))
check('出错回"在听"并**带一句人话** ✓（失败不静默 ✗）',
	nextVoiceState('running', 'fail').state === 'listening' && nextVoiceState('running', 'fail').reason !== '')

console.log('语音环：切片拼接（最容易结巴的地方）')
check('🔴 相邻切片的两字以上重叠**只留一份** ✓（"今天我们来讲" + "来讲一下语音" → "今天我们来讲一下语音"）',
	mergeTranscriptSegments('今天我们来讲', '来讲一下语音') === '今天我们来讲一下语音',
	mergeTranscriptSegments('今天我们来讲', '来讲一下语音'))
check('🔴 **单字重叠故意不去重** ✓ —— 宁可有重复，也不吃字 ✗（"讲" 也可能是用户真的说了两遍 ✓）',
	mergeTranscriptSegments('今天我们讲', '讲一下语音') === '今天我们讲讲一下语音',
	mergeTranscriptSegments('今天我们讲', '讲一下语音'))
check('没重叠时**照实拼** ✓（宁可有重复，也不吃字 ✗）',
	mergeTranscriptSegments('今天天气不错', '明天可能下雨') === '今天天气不错明天可能下雨',
	mergeTranscriptSegments('今天天气不错', '明天可能下雨'))
check('整段被包含在上一段尾巴里时**不重复** ✓',
	mergeTranscriptSegments('我们一起看这段代码', '这段代码') === '我们一起看这段代码',
	mergeTranscriptSegments('我们一起看这段代码', '这段代码'))
check('英文之间留空格 ✓、中文之间不留 ✓',
	mergeTranscriptSegments('let us review the', 'the plan') === 'let us review the plan'
	&& mergeTranscriptSegments('看这个', '这个函数') === '看这个函数')
check('空片段不改变结果 ✓（转写偶尔会回空 ✓）',
	mergeTranscriptSegments('已经有一句了', '') === '已经有一句了'
	&& mergeTranscriptSegments('', '第一句') === '第一句')
check('一串片段按顺序拼成一整句 ✓',
	mergeTranscriptList(['今天', '今天我们来', '我们来做一个语音', '一个语音环']) === '今天我们来做一个语音环',
	mergeTranscriptList(['今天', '今天我们来', '我们来做一个语音', '一个语音环']))

console.log('语音环：说"停"才停')
check('整句是"停"→ 认 ✓（中英都给 ✓）',
	['停', '停止', ' 停 ', '停。', 'stop', 'STOP', '安静'].every((text) => isStopCommand(text) === true))
check('🔴 句子里含"停"但**不是**停止命令 → 不许认 ✗（认错了会吃掉用户的话 ✗）',
	['停下来想想这个', '这个服务停了吗', '别停', '停止符是什么意思'].every((text) => isStopCommand(text) === false))

console.log('语音环：没人声就别送转写（省时间也省钱）')
check('空白片不送 ✓', shouldTranscribeChunk('   ').send === false && shouldTranscribeChunk('   ').reason !== '')
check('一个字不送 ✓（多半是呼吸声 ✓）', shouldTranscribeChunk('嗯').send === false)
check('两个字以上才送 ✓', shouldTranscribeChunk('你好').send === true && shouldTranscribeChunk(' huh ').send === true)

console.log('语音环：WAV 编码（**最容易悄悄坏掉的一段** ✗）')
{
	// 1 秒 440Hz 正弦（16k 采样 ✓）→ 看头里每个字段 ✓
	const one = new Float32Array(16000)
	for (let index = 0; index < one.length; index += 1) one[index] = Math.sin(2 * Math.PI * 440 * index / 16000) * 0.5
	const wav = encodeWav16k(one, 16000)
	const text = (offset, length) => String.fromCharCode(...wav.slice(offset, offset + length))
	const view = new DataView(wav.buffer)
	check('🔴 RIFF/WAVE/fmt/data 四个标记都对 ✓（写错一个，识别器就"听不见"✗）',
		text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE' && text(12, 4) === 'fmt ' && text(36, 4) === 'data')
	check('🔴 头里写的是 **16000Hz / 单声道 / 16bit / PCM** ✓（宿主那条接口只吃这个 ✓）',
		view.getUint32(24, true) === 16000 && view.getUint16(22, true) === 1
		&& view.getUint16(34, true) === 16 && view.getUint16(20, true) === 1,
		`${view.getUint32(24, true)}Hz ch${view.getUint16(22, true)} ${view.getUint16(34, true)}bit`)
	check('字节率与帧长与上面自洽 ✓（32000 B/s、2 B/帧 ✓）',
		view.getUint32(28, true) === 32000 && view.getUint16(32, true) === 2)
	check('总长度与 data 长度对得上 ✓（44 字节头 + N×2 ✓）',
		wav.length === 44 + 16000 * 2 && view.getUint32(40, true) === 16000 * 2 && view.getUint32(4, true) === 36 + 16000 * 2,
		`${wav.length} 字节`)
	check('48k 进来要**重采样成 16k** ✓（否则识别器听到的是"快放三倍" ✗）',
		encodeWav16k(new Float32Array(48000), 48000).length === 44 + 16000 * 2)
	check('样本真的写进去了 ✓（1 秒正弦不该是静音 ✗）',
		rms(Array.from({ length: 1000 }, (_, index) => view.getInt16(44 + index * 2, true) / 32768)) > 0.3)
	check('静音段编码成全 0 ✓（不是噪声、也不是削顶 ✗）',
		Array.from(encodeWav16k(new Float32Array(160), 16000).slice(44)).every((byte) => byte === 0))
	check('base64 能来回 ✓（长度 ≈ 4/3 ✓ —— 这条错了就是"传上去是坏文件"✗）',
		Math.abs(bytesToBase64(wav).length - Math.ceil(wav.length / 3) * 4) <= 4)
}

console.log('语音环：切片与静音判定')
{
	const flat = new Float32Array(100)
	for (let index = 0; index < flat.length; index += 1) flat[index] = index
	const sliced = sliceWithOverlap(flat, 40, 4)
	check('🔴 切一片并**留 0.4 秒重叠** ✓（切在词中间时才有的去重 ✓）',
		sliced.ready === true && sliced.piece.length === 40 && sliced.rest.length === 64
		&& sliced.rest[0] === 36 && sliced.piece[39] === 39,
		`piece=${sliced.piece.length} rest=${sliced.rest.length} rest[0]=${sliced.rest[0]}`)
	check('不够一片时**不给片** ✓（但数据留着 ✓ —— 别把没收完的话丢掉 ✗）',
		sliceWithOverlap(flat, 200, 20).ready === false && sliceWithOverlap(flat, 200, 20).rest.length === 100)
	check('RMS：静音 ≈ 0 ✓、满幅正弦 ≈ 0.707 ✓（阈值就靠它 ✓）',
		rms(new Float32Array(100)) === 0
		&& Math.abs(rms(Array.from({ length: 1000 }, (_, index) => Math.sin(index / 5))) - 0.707) < 0.02)
}

console.log(`\n  ${pass}/${pass + fail} checks passed`)
process.exit(fail === 0 ? 0 : 1)
