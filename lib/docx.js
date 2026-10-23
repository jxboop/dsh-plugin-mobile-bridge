/**
 * Word（.docx）→ 手机可读的 HTML（**不经过 Microsoft Word**）。
 *
 * 为什么不用 Word COM：这台机器上 `Word.Documents.Open` 能开、但 `SaveAs2(..., wdFormatFilteredHTML)`
 * 会一直挂着（实测 >60 秒，像是卡在某个不可见对话框）✗ —— 手机等不起。
 * docx 本质是个 ZIP + XML ✓：直接把 `word/document.xml` 读出来自己渲染 ✓（段落 / 加粗 / 斜体 /
 * 标题 / 表格 / 图片），几百 KB 的文档是毫秒级 ✓。
 *
 * 支持：`.docx` / `.docm` / `.dotx`（都是 OOXML 包）✓；老式二进制 `.doc` **不支持**（照旧给下载 ✓）。
 *
 * 安全：只产出一段**静态 HTML**（文本全转义 ✓、不执行任何脚本 ✓、图片以 data: URI 内联 ✓），
 * 页面用 `<iframe sandbox srcdoc>` 把它关起来显示 ✓。
 */

import { inflateRawSync } from 'node:zlib'

const MAX_IMAGES = 16
const MAX_IMAGE_BYTES = 1_500_000
const MAX_TOTAL_IMAGE_BYTES = 6_000_000
const MAX_PARAGRAPHS = 3000
const MAX_TABLE_CELLS = 3000
const MAX_HTML_BYTES = 3_000_000

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(value) {
	return String(value).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, token) => {
		if (token.startsWith('#x') || token.startsWith('#X')) return String.fromCodePoint(Number.parseInt(token.slice(2), 16) || 0)
		if (token.startsWith('#')) return String.fromCodePoint(Number.parseInt(token.slice(1), 10) || 0)
		return XML_ENTITIES[token] ?? whole
	})
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

/** 读 ZIP 中央目录：只要名字 → 字节（docx 通常几百 KB，全读也行；这里按需解压）。 */
export function readZip(buffer) {
	const entries = new Map()
	let eocd = -1
	for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 66_000); index -= 1) {
		if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break }
	}
	if (eocd < 0) throw new Error('不是有效的 docx（ZIP 结尾没找到）')
	const count = buffer.readUInt16LE(eocd + 10)
	const cdOffset = buffer.readUInt32LE(eocd + 16)
	if (cdOffset === 0xffffffff) throw new Error('这个 docx 太大了（ZIP64 不支持）')
	let cursor = cdOffset
	for (let index = 0; index < count; index += 1) {
		if (buffer.readUInt32LE(cursor) !== 0x02014b50) break
		const method = buffer.readUInt16LE(cursor + 10)
		const compressedSize = buffer.readUInt32LE(cursor + 20)
		const nameLength = buffer.readUInt16LE(cursor + 28)
		const extraLength = buffer.readUInt16LE(cursor + 30)
		const commentLength = buffer.readUInt16LE(cursor + 32)
		const localOffset = buffer.readUInt32LE(cursor + 42)
		const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength).replace(/\\/g, '/')
		if (localOffset !== 0xffffffff) {
			const localNameLength = buffer.readUInt16LE(localOffset + 26)
			const localExtraLength = buffer.readUInt16LE(localOffset + 28)
			const dataStart = localOffset + 30 + localNameLength + localExtraLength
			const raw = buffer.subarray(dataStart, dataStart + compressedSize)
			try {
				entries.set(name, method === 0 ? raw : inflateRawSync(raw))
			} catch { /* 单个条目坏了不该毁整篇文档 */ }
		}
		cursor += 46 + nameLength + extraLength + commentLength
	}
	return entries
}

function parseAttributes(tag) {
	const out = {}
	const pattern = /([A-Za-z0-9_:.-]+)\s*=\s*"([^"]*)"/g
	let match = pattern.exec(tag)
	while (match !== null) {
		out[match[1]] = decodeXml(match[2])
		match = pattern.exec(tag)
	}
	return out
}

/** `word/_rels/document.xml.rels` → rId → 包内路径（`media/image1.png` → `word/media/image1.png`）。 */
function parseRelationships(entries) {
	const map = new Map()
	const raw = entries.get('word/_rels/document.xml.rels')
	if (raw === undefined) return map
	const text = raw.toString('utf8')
	for (const match of text.matchAll(/<Relationship\b[^>]*\/?>/g)) {
		const attrs = parseAttributes(match[0])
		const id = String(attrs.Id ?? '')
		let target = String(attrs.Target ?? '')
		if (id === '' || target === '') continue
		if (/^https?:/i.test(target)) continue
		if (target.startsWith('/')) target = target.slice(1)
		else target = 'word/' + target.replace(/^\.\//, '')
		map.set(id, target.replace(/\\/g, '/'))
	}
	return map
}

const MEDIA_TYPES = {
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
	'.bmp': 'image/bmp', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
	'.emf': '', '.wmf': '', '.svg': 'image/svg+xml',
}

function imageDataUri(entries, rels, relId, budget) {
	const target = rels.get(relId)
	if (target === undefined) return null
	const raw = entries.get(target)
	if (raw === undefined) return null
	const ext = (target.match(/\.[A-Za-z0-9]+$/) ?? [''])[0].toLowerCase()
	const mediaType = MEDIA_TYPES[ext]
	if (mediaType === undefined || mediaType === '') return null
	if (raw.length > MAX_IMAGE_BYTES || budget.bytes + raw.length > MAX_TOTAL_IMAGE_BYTES || budget.count >= MAX_IMAGES) return null
	budget.bytes += raw.length
	budget.count += 1
	return `data:${mediaType};base64,${raw.toString('base64')}`
}

/** 段落样式 → 标题层级（中文版 Word 的样式名是「标题 1」这类）。 */
function headingLevel(style, outline) {
	const value = String(style ?? '').toLowerCase()
	if (/^(heading\s*1|title)$/.test(value) || /标题\s*1/.test(value)) return 1
	if (/^heading\s*2/.test(value) || /标题\s*2/.test(value)) return 2
	if (/^heading\s*3/.test(value) || /标题\s*3/.test(value)) return 3
	if (/^heading\s*[4-6]/.test(value) || /标题\s*[4-6]/.test(value)) return 3
	if (outline === '' || outline === null || outline === undefined) return 0
	const level = Number(outline)
	if (Number.isFinite(level) && level >= 0 && level <= 5) return Math.min(3, level + 1)
	return 0
}

/**
 * docx → HTML 片段。返回 `{ html, paragraphs, tables, images, truncated }`。
 * HTML 里**只有**段落 / 标题 / 加粗 / 斜体 / 表格 / 图片，不含脚本、样式表或外链 ✓。
 */
export function docxToHtml(buffer) {
	const entries = readZip(buffer)
	const documentXml = entries.get('word/document.xml')
	if (documentXml === undefined) throw new Error('这个 .docx 里没有正文（word/document.xml）')
	const rels = parseRelationships(entries)
	const xml = String(documentXml.toString('utf8'))
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
	const budget = { bytes: 0, count: 0 }
	const body = []
	const stack = [{ kind: 'body', parts: body }]
	let truncated = false
	let paragraphs = 0
	let tables = 0
	let cells = 0

	const current = () => stack[stack.length - 1]
	const append = (fragment) => {
		const context = current()
		if (context.kind === 'p') context.html.push(fragment)
		else if (context.kind === 'cell') context.html.push(fragment)
		else context.parts.push(fragment)
	}

	// 扫描 XML：`<tag ...>` 与文本交替
	const tokenPattern = /<[^>]*>|[^<]+/g
	let match = tokenPattern.exec(xml)
	let run = null
	let insideText = false
	while (match !== null) {
		const token = match[0]
		if (token.startsWith('<!--')) { // 注释可能被 `<` 切碎，直接跳过到 `-->`
			if (token.includes('-->')) { match = tokenPattern.exec(xml); continue }
		}
		if (token.startsWith('<?')) { match = tokenPattern.exec(xml); continue }
		if (token.startsWith('<')) {
			if (token.startsWith('</')) {
				const name = token.slice(2).split(/[\s>/]/)[0]
				if (name === 'w:p') {
					const context = stack.pop()
					if (context === undefined) break
					const paragraph = renderParagraph(context)
					if (paragraph !== '') {
						if (current().kind === 'table' || current().kind === 'row') {
							// 表格单元格外的孤立段落：包一层
							append('<p>' + paragraph + '</p>')
						} else append(paragraph)
						paragraphs += 1
					}
					run = null
					insideText = false
				} else if (name === 'w:tc') {
					const cell = stack.pop()
					if (cell === undefined) break
					const row = current()
					if (row.kind === 'row') row.cells.push('<td>' + cell.html.join('') + '</td>')
				} else if (name === 'w:tr') {
					const row = stack.pop()
					if (row === undefined) break
					const table = current()
					if (table.kind === 'table') table.rows.push('<tr>' + row.cells.join('') + '</tr>')
				} else if (name === 'w:tbl') {
					const table = stack.pop()
					if (table === undefined) break
					tables += 1
					// 第一行当表头（Word 里绝大多数表格第一行就是表头 ✓）
					const head = table.rows.length > 0 ? table.rows[0].replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>') : ''
					const rest = table.rows.slice(1)
					append('<table>' + (head === '' ? '' : '<thead>' + head + '</thead>') + '<tbody>' + rest.join('') + '</tbody></table>')
				} else if (name === 'w:r') {
					if (run !== null && run.text !== '') flushRun(run)
					run = null
				} else if (name === 'w:rPr') {
					if (run !== null) run.insideProps = false
				} else if (name === 'w:pPr') {
					const context = current()
					if (context.kind === 'p') context.insideProps = false
				} else if (name === 'w:t') {
					insideText = false
				}
				match = tokenPattern.exec(xml)
				continue
			}

			const name = token.slice(1).split(/[\s>/]/)[0]
			const selfClosing = token.endsWith('/>')
			if (selfClosing === true && (name === 'w:p' || name === 'w:tbl' || name === 'w:tr' || name === 'w:tc' || name === 'w:r')) {
				// 自闭合的空容器（`<w:p/>` 之类）：不压栈，免得把后文全装进去 ✗
				match = tokenPattern.exec(xml)
				continue
			}
			if (name === 'w:p') {
				stack.push({ kind: 'p', html: [], style: '', outline: '', align: '', bullet: false, insideProps: false })
				paragraphs += 1
			} else if (name === 'w:tbl') {
				stack.push({ kind: 'table', rows: [] })
			} else if (name === 'w:tr') {
				stack.push({ kind: 'row', cells: [] })
			} else if (name === 'w:tc') {
				stack.push({ kind: 'cell', html: [] })
				cells += 1
			} else if (name === 'w:r') {
				run = { text: '', bold: false, italic: false, underline: false, strike: false, insideProps: false, breaks: 0 }
			} else if (name === 'w:rPr') {
				if (run !== null) run.insideProps = true
			} else if (name === 'w:pPr') {
				const context = current()
				if (context.kind === 'p') context.insideProps = true
			} else if (name === 'w:t') {
				insideText = true
			} else if (name === 'w:br' || name === 'w:cr') {
				if (run !== null) flushRun(run, '<br>')
			} else if (name === 'w:tab') {
				if (run !== null) run.text += '\t'
			} else if (run !== null && run.insideProps === true) {
				const attrs = parseAttributes(token)
				// OOXML 的属性名带命名空间（`w:val`），这里容错两种写法 ✓
				const val = attrs['w:val'] ?? attrs.val ?? attrs['val']
				if (name === 'w:b') run.bold = val === undefined || (String(val) !== '0' && String(val) !== 'false')
				else if (name === 'w:i') run.italic = val === undefined || (String(val) !== '0' && String(val) !== 'false')
				else if (name === 'w:u') run.underline = String(val ?? 'single') !== 'none'
				else if (name === 'w:strike') run.strike = val === undefined || String(val) !== '0'
			} else if (current().kind === 'p' && current().insideProps === true) {
				const paragraph = current()
				const props = parseAttributes(token)
				const val = props['w:val'] ?? props.val
				if (name === 'w:pStyle') paragraph.style = String(val ?? '')
				else if (name === 'w:outlineLvl') paragraph.outline = String(val ?? '')
				else if (name === 'w:jc') paragraph.align = String(val ?? '')
				else if (name === 'w:numPr') paragraph.bullet = true
			} else if (name === 'a:blip' || name === 'v:imagedata') {
				const attrs = parseAttributes(token)
				const relId = String(attrs['r:embed'] ?? attrs['r:id'] ?? '')
				if (relId !== '') {
					const uri = imageDataUri(entries, rels, relId, budget)
					append(uri === null ? '[图片]' : '<img alt="图片" src="' + uri + '">')
				}
			}
			match = tokenPattern.exec(xml)
			continue
		}

		// 文本 token
		if (insideText === true && run !== null) {
			run.text += decodeXml(token)
		}
		match = tokenPattern.exec(xml)
	}

	function flushRun(target, extra = '') {
		if (target === null) return
		const text = escapeHtml(target.text).replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;')
		let html = text
		if (target.underline === true) html = '<u>' + html + '</u>'
		if (target.italic === true) html = '<em>' + html + '</em>'
		if (target.bold === true) html = '<strong>' + html + '</strong>'
		if (target.strike === true) html = '<s>' + html + '</s>'
		if (html !== '') append(html)
		if (extra !== '') append(extra)
		target.text = ''
	}

	function renderParagraph(context) {
		const html = context.html.join('')
		if (html.trim() === '') return ''
		const level = headingLevel(context.style, context.outline)
		if (level > 0) return `<h${level}>${html}</h${level}>`
		const align = context.align === 'center' ? ' style="text-align:center"' : context.align === 'right' ? ' style="text-align:right"' : ''
		if (context.bullet === true) return `<div class="li"${align}>• ${html}</div>`
		return `<p${align}>${html}</p>`
	}

	let html = body.join('')
	if (paragraphs > MAX_PARAGRAPHS || cells > MAX_TABLE_CELLS) truncated = true
	if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
		html = html.slice(0, MAX_HTML_BYTES)
		truncated = true
	}
	return { html, paragraphs, tables, cells, images: budget.count, truncated }
}

/** 套上移动端可读的纸面样式（整份 HTML；里面不会执行脚本 ✓）。 */
export function wrapDocxHtml(fragment) {
	return '<!doctype html><html><head><meta charset="utf-8">'
		+ '<meta name="viewport" content="width=device-width, initial-scale=1">'
		+ '<style>'
		+ 'html,body{margin:0;padding:0;background:#fff;color:#1b1b1f;font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}'
		+ 'body{padding:14px 16px 28px;word-break:break-word}'
		+ 'p{margin:.55em 0}h1,h2,h3{line-height:1.35;margin:.9em 0 .45em}h1{font-size:1.45em}h2{font-size:1.25em}h3{font-size:1.1em}'
		+ 'img{max-width:100%;height:auto;border-radius:4px}'
		+ 'table{border-collapse:collapse;width:100%;margin:.7em 0;font-size:14px}'
		+ 'th,td{border:1px solid #d0d0d4;padding:5px 8px;text-align:left;vertical-align:top}'
		+ 'th{background:#f4f4f6;font-weight:600}.li{margin:.35em 0;padding-left:.2em}'
		+ 's{opacity:.7}'
		+ '</style></head><body>' + fragment + '</body></html>'
}
