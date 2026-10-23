/**
 * dsh-plugin-mobile-bridge — a LAN-only mobile surface for DeepSeek Harness.
 *
 * Two jobs, one listener:
 *   1. photos taken on the phone become real Session attachments (base64 prompt
 *      content the Host promotes to durable references), so the desktop agent
 *      sees them exactly like a desktop upload;
 *   2. the phone can pick a Session, submit a task, watch it run frame by frame
 *      and cancel it.
 *
 * It deliberately does NOT ride the DSH web carrier: that one is a desktop UI
 * bound to loopback by default, and exposing it would publish the whole GUI to
 * every host on the network. This listener owns its own port, its own PIN, and
 * serves only the compact phone page.
 *
 * Host-only, plain ESM, no build step, no runtime dependencies.
 */

import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createReadStream } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { readFileSync, appendFileSync, statSync, openSync, readSync, closeSync, unlinkSync, existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile, appendFile, stat, unlink, mkdir, rename, open, readdir, rm } from 'node:fs/promises'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import net from 'node:net'
import { join, resolve, sep, extname, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectAddresses, describeAddress } from './addresses.js'
import { qrSvg } from './qr.js'
import { collectPanels, readPanelAsset } from './panels.js'
import { allowWebhookUrl, buildWebhookPayload, webhookHeaders } from './webhook.js'
// 3.5.0 语音优先：状态机的**名字与顺序**只有一份 ✓（手机照着画 ✓，别两边各写一份 ✗）。
import { VOICE_STATES } from './voice.js'
import { sampleSystem, killProcess, processAlive, killVerdict } from './system.js'
import { powerCommand, runPower, POWER_DELAY_SECONDS, LOCK, SHUTDOWN, RESTART, CANCEL, runUnlock, UNLOCK } from './power.js'
import { readClipboard, writeClipboard, captureScreen } from './clipboard.js'
/*
 * 4.5.0「手机上控制电脑」✓（用户 2026-10-14：静音 / 音量 / 亮度 / 联网 / 电量 / 蓝牙设备与开关 ✓）——
 * 平台相关的活儿都在 `lib/pccontrol.js` ✓（和 `system.js` / `power.js` 同一个分层 ✓）。
 */
import { snapshot as pcSnapshot, listBluetooth, applyAudio, applyBrightness, setBluetoothRadio, openBluetoothSettings, disconnectBluetoothDevice } from './pccontrol.js'
/*
 * 4.13.0「定时开机」✓（用户 2026-10-16：「既然有关机那么可以做一个对应的定时开机功能」✓）——
 * ⚠️ 它**只在睡眠 (S3) 这一层成立** ✗；完全关机 (S5) 软件做不到 ✓（只能靠主板 BIOS 的 RTC ✓）。
 * 那笔账（含四件真机实测的事）写在 `lib/pccontrol.js` 下半部分 ✓。
 */
import { parseWakeAt, describeWakePolicy, readWakeInfo, setWakeTask, clearWakeTask, WAKE_TASK_NAME, WAKE_POLICY_COMMAND } from './pccontrol.js'
import { exportSessionMarkdown } from './export.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CONFIG_FILE = 'mobile-bridge.json'
/**
 * Issued phone tokens, so a server restart does not log every phone out.
 * Kept out of mobile-bridge.json so clearing a session never risks the PIN.
 */
const TOKENS_FILE = 'mobile-bridge.tokens.json'
const ACCESS_LOG = 'mobile-bridge.log'
const ACCESS_LOG_LIMIT = 512 * 1024
const PAGE_FILE = join(HERE, 'mobile.html')
/** Replaced at serve time with this build's page tag. */
const PAGE_TAG_MARKER = '__DSH_PAGE_TAG__'
/**
 * 4.7.0：**自带背景预设**的白名单 ✓（目前就一个赛博朋克 ✓）。
 * 值会写进配置 ✓、也会跟着 bootstrap 给到手机 ✓ —— 所以只认表里这几个 ✓，
 * 写别的等于没设 ✓（不给"随便塞个字符串进去"留口子 ✗）。
 */
const BACKGROUND_PRESETS = ['cyberpunk', 'planet']
/*
 * 🔴 4.10.0：**「夜行星」这个风格是"带素材的预设"** ✓（用户 2026-10-15：
 * 「你把这个背景归档到背景风格里面（新建一个背景风格）」✓）。
 *
 * ⚠️ 两条底线 ✗：
 *   ① **素材一个字节都不改** ✓ —— 归档就是**逐字节复制** ✓（用户对那支视频说过"不要更改"✓）；
 *   ② **素材永远不进插件、不进 Release** ✗ —— 那是用户自己的东西 ✓，
 *      所以归档只写到**他本机的目录**（`~/.dsh/mobile-bridge-presets/<名字>/` ✓），
 *      插件里只留"有这么个风格、素材在哪个目录"这点**代码** ✓。
 *
 * 于是"预设"分成两种 ✓：
 *   · `cyberpunk` 这种 = **纯 CSS 画的** ✓（不要文件 ✓）；
 *   · `planet` 这种   = **自带素材** ✓（素材归档在本机目录里 ✓，`preset.json` 记着文件名和字节数 ✓）。
 */
/** 带素材的预设（归档目录里得有 `preset.json` ✓ 才算数 ✓）。 */
const ARCHIVED_PRESETS = { planet: { label: '夜行星' } }
/** 版本与"最近更新"也是发页面时注入的（见 startPageInfo）。 */
const VERSION_MARKER = '__DSH_BRIDGE_VERSION__'
const WHATSNEW_MARKER = '__DSH_WHATSNEW__'
const THEMES_MARKER = '__DSH_THEMES__'
// 4.4.0：按"代"的总结 ✓ 与 5.0 预告 ✓（同样是发页面时注入 ✓，页面只负责画 ✓）。
const ERAS_MARKER = '__DSH_ERAS__'
const NEXTUP_MARKER = '__DSH_NEXTUP__'

/**
 * 「1.0 → 今」按**主题**的汇总（用户 2026-10-09 明确要求：要汇总，不要一版版罗列）。
 *
 * 为什么手写而不是从 CHANGELOG 自动归类：主题是**编辑判断**，机械按关键词分桶只会出一堆
 * 碎条（"图片改了 3 次"这种）。每条都对着 CHANGELOG 核过，括号里是**首次引入的版本**。
 * 维护成本就是发版时看一眼要不要补一行 —— 比让用户在一屏版本号里自己找划算。
 */
const WHATS_NEW_THEMES = [
	/*
	 * ⚠️ 4.3.1（用户 2026-10-14：「找到 1.0 以前版本的更新内容并补全到说明里」✓）：
	 * 这份汇总原来**从 1.0 写起** ✗ —— 而 0.1 → 0.9.12 有四十多版（仓库提交历史里都在 ✓）。
	 * 现在补上「起步」这一行 ✓，并且说明页那两个标题也从「1.0 → 今」改成「0.1 → 今」✓。
	 */
	['🧱 起步（0.1 → 0.9.12）', '手机上第一次能看进度 / 能回话 / 能回答提问与批准操作（0.3.0 / 0.5.0）；图与视频、任何格式都能发（0.6.0）；装成 App（PWA，0.8.0）；0.9 那一串手感：首屏 90KB→20KB、换会话不再重新加载（0.9.0 / 0.9.7）'],
	['🌍 外网分享 · Tailscale 必装（5.0.0）', '手机上的「分享」给的那份零基础安装文案**按"外网也能连"重写** ✓：**Tailscale 是必装前置**（下载地址在文案里**点得动** ✓）、步骤含开 Funnel ✓、把固定 https 地址写进 `publicUrl` ✓、以及"**关掉 WiFi 用流量验一次**" ✓；网页版与文本版仍是同一处内容源 ✓'],
	['🌈 跟着背景走 · 每个功能一页（4.17.0）', '**暖色配色不再等背景视频播起来** ✓（弱网下刷新后界面不会又回原色 ✓，背景照旧等能播才铺 ✓）；「更多」里点任何功能都**盖在它上面、各自一页** ✓（不再被「更多」盖住 ✓）；点「余额」会把开着的纸全收掉 ✓；便签 / 计时器 / 目标卡 / 搜一搜的卡片跟着背景同一套暖色 ✓；**手机桌宠下线** ✓（电脑网页端那只没动 ✓）'],
	['🎤 录音与转文字', '从"手机上找录音文件再发"变成网页里直接录（1.5.0）；一节课的录音也能转，上限 3 小时（1.4.1）；回答旁边点 🔊 用手机自己的声音念出来（2.6.0）'],
	['🎬 视频', '手机发的视频自动抽 6 帧给模型看、里面的语音转成文字，原片留在电脑上（1.3.16 / 1.3.17）'],
	['🖼 图片', '多选一次发一批、自动压到合适大小、发出去就能在手机上看到真图（1.3.11～1.3.15）；点小图看全屏大图、长按存相册（2.8.0）；大图切片上传时屏幕上写着"传到第几片"（3.5.0）'],
	['📄 文件与文档', '任意文件都能传到电脑；PDF / 压缩包 / 代码直接给路径让 agent 自己打开读；电脑上的文稿手机上能直接打开（2.1.0）；**📄 文档「侧栏预览」（4.16.0）：纸面右上多一个「侧栏」键 —— 窄屏缩到下面半屏、宽屏（≥760px）就是右侧栏 ✓，上面那半照旧是对话，能边看文档边聊 ✓；选择记在这台手机上 ✓、按「返回」也不会把它改回来 ✓**'],
	['📊 PPT · 表格（2026-10-23）', '手机浏览器渲染不了 pptx / xlsx ✓ → **在电脑上转一次**：PPT 用 PowerPoint **逐页导成 JPG**（手机上左右滑 / 点按钮翻页，最多 40 页 ✓）、Excel 用 Excel 读成**行×列**（最多 300×30 ✓）、CSV / TSV 直接解析 ✓；表格是**真表格**（表头固定、宽表横着滑 ✓），不是一坨逗号文本 ✗；按「路径 + 大小 + mtime」**缓存** ✓（第二次打开秒开 ✓、不用再启 PowerPoint/Excel ✓）；转不出来就**如实说 + 给「下载」** ✓（不会白屏 ✗）；JSON 只给缓存目录里的产物 ✓、密钥文件照旧不给 ✓'],
	['📱 手机界面', '几个页面左右滑着换（1.7.0，2.0.0 起面板上也行）；开始页显示版本与更新（1.8.0 / 2.0.0）；会话能置顶 / 打星 / 删除、顶端显示当前模型（2.5.0 / 2.6.0）；键盘手感 Enter 直接发、↑ 取上一条（2.8.0）；工具键那一排能收起（2.8.0）；**收起顶栏后点 ⌄ 弹一张纸（展开 / 说明 / 刷新 / 退出 / 当前模型一个都不丢）+ 「停止」两下才真停（第一下一个请求都不发）**（4.3.0）；**工具排瘦身（16 键 → 5 键 + 「更多」一张纸，每行带文字说明）**（4.5.2）；**左滑＝返回上一步**（4.6.1）；**自带「赛博朋克」背景：纯 CSS 画的霓虹地平线 + 透视网格 + 扫描线 —— 不用传图、不占流量、任何分辨率都清晰；4.8.0 起它默认就在动，4.8.1 把动态感做足（六层同动；压暗层让开、气泡更透 —— 隔着气泡就看得见在动）、**4.8.2 画了月亮和真流星，流星从对话框上面划过；4.8.3 月亮更真实且在背景层半透明、流星沿轨道斜向下飞、删掉那圈丑斜线；4.9.0 支持**任意图片/视频背景**：缓慢推近（Ken Burns）+ 流星划过 + 配色跟着图走（暖金示例）、面板更透明，水印可在**画面层面**裁掉而不改文件；4.9.1 流星改到**文字下面**（从文字后面过 ✓）；4.9.2 流星轨道改用同单位算（真 30° 浅斜、从右往左 ✓）、动图压缩 8 倍 + **静止图兜底**；4.9.3 动效改成**慢速旋转**（「星球在转」✓）、流星放慢到 2.6~4.4 秒、界面**更透明**（面板/气泡 .34，靠**文字阴影**保清晰 ✓）；4.9.4 修「**一发消息背景就没了**」（断线收掉背景后重连没补回来 ✗）；4.9.5 修「**一发信息气泡颜色变回去**」；4.9.6 **撤掉我自己编的假动效**（推近/旋转都去掉 ✓），换上用户给的**原动图**（逐字节装 ✓ 不动它 ✓）；4.9.7 静止兜底也进手机缓存；4.9.8 附件传失败不再白丢（进离线箱 ✓ 有网自动补发 ✓）；4.9.9 大附件也能先存着（字节进 IndexedDB ✓）；4.9.10 **断点续传**；4.9.11 **弱网上传参数**（片 512KB→128KB、并发 3→2 ✓）；4.9.12 测试套件打磨（堵掉两处「空数组恒真」的假绿 ✓）；4.9.13 **给探针加自检**（否定式断言必须证明自己找得到东西 ✓）+ **把人工判定写进注释** ✓**，配色跟着换成霓虹青 + 品红**（4.7.0 / 4.8.0）；**4.10.0 新背景风格「夜行星」：把用户那支星球实况视频**归档成"自带素材的预设"** —— 素材逐字节复制到他本机的风格目录（不进插件、不进发布发布 ✓），选这个风格就**连同素材一起装回来**；素材丢了会**如实显示没有背景**（不假装铺着 ✓）**；**4.10.1 修：带素材的风格被当成"纯画面风格"（用户看到"回到以前的风格"✓）—— 两种风格分道扬镳 ✓；切风格时先摘掉赛博朋克那层（防两套叠着 ✓）**；**4.10.2 修根因：离线旧副本的名字写死了 → 手机一直吃旧页面（"刷新了还是老样子"✓）—— 现在名字跟着版本走 ✓，每版自动作废旧副本**；**4.10.3 对话框再透一档：助手气泡底色原来写死（调变量调不到它 ✗）→ 改成走变量 + 轻微背景模糊（背景看得见、字更清楚 ✓）**；**4.10.4 撤掉背景模糊：透明的意思是看得见背景（不是把背景糊掉 ✓）—— 只动前景（文字阴影 ✓），不动背景 ✗**；**4.10.5 修「一发信息对话框又变回原色」：助手气泡的配色被亮色模式那条老规则压住（4.9.5 只修了用户气泡 ✗）—— 两套主题都用 `#app` 钉死特异性 ✓**；**4.10.6 流星分两层：后排被气泡挡住、前排盖着气泡划过（z-index 自动产生遮挡 ✓，前排少/小/淡/更快 = 视差 ✓；刹车两层一起管 ✓）**；**4.10.7 图标/标签/输入区也适配背景：走同一批变量（上一轮只改了面板气泡 ✗）+ 图标暖色柔影（仍然不碰背景 ✓）**；**4.10.8 补端到端测试：归档风格真摆一份素材、真发请求、真取回来（含 Range 206 ✓、字节数对得上 ✓）—— 这正是 4.10.1 那个 bug 逃过测试的地方 ✓**；**4.11.0 服务端支持二进制分片：客户端可直接发 file.slice（不进内存 ✓、流量少 33% ✓），与老的 JSON 分片共用同一份"定位写 + 片号集合判收齐"逻辑（向后兼容 ✓）**；**4.11.1 视频/文件上传改走二进制：每片直接从磁盘流式读（少 33% 流量 ✓），照片那条路一字未动 ✓（向后兼容 ✓）**；**4.11.2 内联失败后的切片重发也走二进制（原图那条 ✓；压过的刻意不改 ✗ —— 免得切片的和发出去的不是同一张图 ✓）**；**4.11.3 压缩照片也带上原始 Blob（三处附件全带 ✓）—— 上一版那个"故意的例外"其实是我没查，已纠正 ✓**；**4.12.0 大视频能发了：上限 28MB→120MB（与服务端对齐 ✓），前提是文件/视频/录音**不再整份读进内存**（只带磁盘句柄、分片从磁盘流式读 ✓）—— 两件事必须一起上 ✓**'],
	['🔌 连不上时', '不再黑屏 / 白屏，改成一整屏说明 + 自动重试 + 离线能读上次对话（1.6.0）；电脑睡眠后 45 秒提示、90 秒自动重连（2.0.1）；弱网模式（2.8.0）；离线发件箱：没网先写、有网自动补发（2.7.0）'],
	['🎨 生图 / 生视频', '说一句话就出图，也能出视频（1.4.0）；国内推荐用智谱的免费模型'],
	['🚀 连得更稳', '开机自启 + 掉线提醒 + 一键自检（七条只读检查，每条带"怎么办"）（2.7.0 / 2.8.0）；地址卡 + 二维码，手机扫一下就进（2.7.0）'],
	['💻 手机上管电脑', 'CPU / 内存 / 磁盘 / 网速、一键结束卡死的 node（2.7.0）；锁屏 / 关机 / 重启（默认关）（2.7.0）；剪贴板互通 + 截屏（要现输 PIN）（2.7.0 / 2.7.3）；**剪贴板历史（最近 20 条，只在手机上）+ 屏幕「取字」（交给 agent 认字存成可搜索的笔记）**（3.8.0）；**💤 我睡了（一键锁屏 + 明早提醒）+ 🎬 专注模式（静音通知 + 专注中徽章 + 打点）**（3.9.0）；**🎬 录屏遥控（手机开始 / 停止电脑录屏，10 分钟硬上限）+ ⏳ 一次性分享链接（看过一次就作废）**（4.0.0）；**🔓 解锁入口重做（唤醒到登录界面，密码仍要你自己按）+ 📤 顶部分享键（一键拿到"零基础安装文案"，不含任何凭据）**（4.1.0）；**📤 分享网页版（一份单文件安装页，同学浏览器直接打开就能读）**（4.2.0）；**网页版分享的收尾（失败时会明说 ✓、说明页也讲了它 ✓）**（4.2.1）；**🖥 手机直接控制这台电脑：静音 / 音量 / 亮度 / 联网 / 电量 / 蓝牙开关与设备列表（默认关；亮度只对笔记本内置屏有效，蓝牙"连接某台设备"系统没有可靠接口 —— 面板里只有"打开蓝牙设置"）**（4.5.0）；**蓝牙设备列表换系统原生接口（16 秒 → 0.8 秒、带"已连接 / 未连接"）+ 列表里点一台直接到系统蓝牙设置**（4.5.1 蓝牙开关 / 4.6.0 列表 ✓）；**⏰ 定时开机（4.13.0）：睡眠里到点唤醒 ✓（完全关机 S5 软件做不到 ✗ —— 只能靠 BIOS ✓）；🔌 蓝牙「断开某一台」（4.14.0）：已连接那几行右边多一个「断开」✓ —— ⚠️ 断没断**以回读到的连接状态为准** ✓（rc=0 骗过人 ✗）、有的设备（比如 iPhone）就是断不掉 → 那就**如实说没断成** ✗ 并给两条替代 ✓；"连接"仍然只能去系统设置里点 ✗（实测 rc=87 ✓）**'],
	['🗂 会话与知识库', '对话导出 Markdown / 分享（2.7.0）；转写存成笔记、出提纲与复习卡（2.7.0）；🔍 搜这台电脑上的会话内容（不上云）与"这周学了什么"（3.3.0）'],
	['🧩 能自己长', '手机端面板协议：电脑上放一个目录 + panel.json 就多一个键（3.1.0）；工作流编排：一行一步串起来跑、能定时（3.2.0）'],
	['🔗 分享与开放', '受限只读链接：给别人临时看某一篇、可撤销（2.7.0）；开放接口：会话开始跑 / 跑完 / 出错 / 有新活动时往你自己的网址 POST 一条带签名的小消息（默认关）（3.4.0）'],
	['📲 把东西分享进电脑', '任何 App 点「分享」→ iOS 快捷指令 → 内容进电脑上最近那个会话（**手机上不用点桥里的任何键** ✓；默认关、每次都要带 PIN）（3.6.0）；同一条短链加 `"task":"ocr"` = **拍张照就认字并存成可搜索的笔记** ✓、`"task":"scan"` = 扫码查一下它是什么 ✓（3.7.0）'],
	['🔑 电脑开关机与解锁', '手机上锁屏 / 关机 / 重启（2.7.0）；**解锁**是诚实版：只发一次无害唤醒输入、再看结果 —— 已解锁就说已解锁、要密码就说要密码、读不到就说读不到（3.5.0）；**⏰ 定时开机（4.13.0）：写一个时刻（`07:30` / `10-17 07:30` / `2026-10-17 07:30`），到点在「睡眠」里把机器叫醒 ✓ —— ⚠️ 但**完全关机 (S5) 软件做不到** ✗（那时系统没在运行 ✓，任何软件都不存在 ✓），只能靠主板 BIOS 的 RTC 定时开机 ✓；"BIOS 里设没设"Windows 查不到 ✗，所以**不摆那个键** ✗、接口上**谁来问都如实拒绝** ✓；面板还会把唤醒定时器策略（交流 / 电池两档）与那个任务的 `WakeToRun` **当场读回来**摆给你看 ✓**'],
	['🔐 安全', 'PIN 登录 + 网址里带一段密钥；令牌会过期；每档权限允许做什么手机上看得见（2.5.0）；**新建任务时就能先挑定**这一档（3.5.0）；新设备要你点头，而且是**按设备记**的：放行过的那台手机换网络 / 重登都直接进（3.0.0 / 3.4.1）；**跑安全检查不再往你的登录账本写假设备（并清掉了历史那批）**（4.3.0）'],
	['📦 安装与更新', '一条命令装、一条命令更新；从 GitHub 装必须 ≥ 1.8.2（更早的包缺文件，装上去页面打不开）；说明页随版本一起更新（3.4.2）；**说明页现在还能"一代一代看"每一代改了什么，末尾有下一版预告（写明是愿景、不写日期）**（4.4.0 / 5.0.0 起顺延成 5.1 预告）']
]

/*
 * ⚠️ 4.4.0（用户 2026-10-14：「分别总结一下 0.1 到 1.0、1.0 到 2.0、2.0 到 3.0、3.0 到 4.0
 * 分别改变了什么并添加到说明，然后写到 5.0 版本的预告」✓）：
 *
 * 上面那份 `WHATS_NEW_THEMES` 是**按主题横向**汇总 ✓；这一份是**按"代"纵向**总结 ✓ ——
 * 两者不重复：主题那份回答"录音这件事怎么一路变好的"，这一份回答"每一代整体主线是什么"。
 *
 * 内容来源（一条都编不得 ✗）：
 *  · 0.1 → 1.0：`CHANGELOG.md` 尾部的逐版表 + `HANDOFF.md`（0.9.4→0.9.12 那张表 ✓）；
 *  · 1.0 → 2.0：`CHANGELOG.md` 的 1.x 各节 + 当年那份《手机桥-更新汇总-1.0到2.0.md》✓；
 *  · 2.0 → 3.0 / 3.0 → 4.0：`CHANGELOG.md` 的 2.x / 3.x 各节（版本号就是各功能的首次引入版 ✓）。
 */
const WHATS_NEW_ERAS = [
	['0.1 → 1.0', '（2026-10-03 ~ 10-08，四十多版）手机第一次"能用"：能看 agent 的进度、能回话（0.1）→ **能回答它的提问、批准它要动电脑的操作**（0.3.0）→ 运行中能插话 + 第一版说明页（0.5.0）→ 图 / 动图 / 视频 / 任何格式都能发（0.6.0）→ 装成 App（0.8.0）→ 0.9 那一串手感（首屏 90KB→20KB、换会话不再重新加载）。**1.0 的界线**：手机第一次同时具备"产出"（生图）与"治理"（权限看得见、改得动）'],
	['1.0 → 2.0', '（10-08 ~ 10-09）从"能干活"到"用起来顺手"：复制键 + 任意文件（1.1.0）→ 说明页按设备记、顶栏随时能重看（1.2.0）→ 手机自己换背景（1.3.0）→ 修掉一批"其实一直坏着"的（加载页百分比冻住、boot 从没设超时、图片错位、图看不到、缓存导致改了不生效）→ 多选发图 / 自动压缩 / 分片上传（1.3.11 ~ 1.3.15）→ 视频抽帧 + 语音转文字（1.3.16 / 1.3.17）→ 生视频（1.4.0）→ 网页里直接录音（1.5.0）→ 连不上不再黑屏（1.6.0）→ 左右滑换页（1.7.0）→ 版本说明页（1.8.0）→ 面板上也能滑、加回到底部，并修掉"哨兵从来没生效过"这种真 bug（2.0.0）'],
	['2.0 → 3.0', '（10-09 ~ 10-11）从"单机好用"到"**能管电脑、能分享、能离线**"：手机上打开电脑的文档（2.1.0）→ 会话置顶 / 打星 / 删除、顶端显示当前模型（2.5.0 / 2.6.0）→ 一大批"手机上管电脑"：CPU / 内存 / 磁盘 / 网速、一键结束卡死的 node、锁屏 / 关机 / 重启、剪贴板互通、截屏（2.7.0）→ 会话导出与分享、受限只读链接、搜会话、**离线发件箱**（没网先写、有网自动补发）、开机自启、地址卡 + 二维码（2.7.0）→ 键盘手感与工具键收起、弱网模式、大图切片进度（2.8.0）→ 备份 / 换手机（2.9.0）'],
	['3.0 → 4.0', '（10-11 ~ 10-14）从"手机遥控"长成"**有协议的平台、还能把东西分享进电脑**"：新设备按设备记（3.0.0）→ 面板协议：电脑上放个目录就多一个键（3.1.0）→ 工作流编排、能定时（3.2.0）→ 搜这台电脑上的会话内容（不上云）（3.3.0）→ 开放接口：会话开始 / 跑完 / 出错时往你自己的网址 POST 一条带签名的消息（默认关）（3.4.0）→ 解锁（诚实版）+ 新建任务时就能先挑权限档（3.5.0）→ 任何 App 点分享就能进电脑、拍张照认字 / 扫码（3.6.0 / 3.7.0）→ 剪贴板历史 + 屏幕取字（3.8.0）→ 我睡了 / 专注模式（3.9.0）→ 录屏遥控 + 一次性分享链接（4.0.0）'],
	['4.0 → 今天', '（10-14）把"分享给别人用"这条路走通：解锁入口重做 + 顶部分享键（4.1.0）→ 分享网页版（单文件安装页，4.2.0 / 4.2.1）→ 折叠顶栏一张纸 + 「停止」两下才真停 + **安装文案重写**（4.3.0）→ 说明页从 0.1 写起（4.3.1）'],
]

/*
 * 下一站：5.1 预告 ✓（用户 2026-10-14：「写到 5.0 版本的预告」✓）。
 *
 * 🔴 5.0.0 已发布（2026-10-19）✓ —— 那版发的是"分享安装文案按外网写" ✓，
 * 而这条「开放平台」的愿景**还没实现** ✓ → 顺延成 **5.1 预告** ✓
 *（不能让一个已经发出去的版本号还挂着"预告" ✗ —— 用户会以为开放平台已经有了 ✓）。
 *
 * ⚠️ 口径照项目里那份定稿（`手机桥-2.5.0交接` 的「总路线（续）：4.1.0 → 5.0.0」✓）：
 * **这是愿景，不是排期** ✗ —— 项目自己就那么标的 ✓（"能不能走到那一步，前提是前面每一段
 * 都真的稳定跑着、并且有真人在用"✓）。所以这段文案里**不许出现日期、不许写成待办清单** ✗。
 */
const WHATS_NEW_NEXT = {
	version: '5.1.0',
	title: '开放平台',
	lead: '从一个插件，长成"个人 AI 操作系统的入口"。',
	items: [
		'开放标准协议 —— 别人也能写面板、工作流、客户端',
		'第三方硬件与服务接入（不只手机这一种入口）',
		'完整文档与教程：从"照着装"到"照着做"',
		'社区与模板生态：好用的面板 / 工作流可以直接拿来',
	],
	between: '5.1 之前那几代（批量部署 / 人格与角色 / 数据与隐私中心 / 多通道中继 / 跨平台客户端 / 长期支持）是**方向，不是承诺** ✓。',
	note: '⚠️ 这是**愿景，不是排期** —— 项目里一直是这么标的：要走到那一步，前提是前面每一段都真的稳定跑着、并且有真人在用。',
}

/**
 * 本插件的版本号 —— **现读 package.json**，不在这儿另抄一份。
 *
 * 抄一份的下场是迟早对不上：改了 package.json 忘了改这里，用户看到的版本就是假的，
 * 而"版本号"恰恰是排查"你到底装的是哪一版"唯一可靠的东西。
 */
let cachedVersion = ''
function bridgeVersion() {
	if (cachedVersion !== '') return cachedVersion
	try {
		const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
		cachedVersion = String(pkg.version ?? '0.0.0')
	} catch {
		cachedVersion = '未知'
	}
	return cachedVersion
}

/**
 * "更新了什么" —— 直接从 CHANGELOG.md 的头部**现读**（同样是为了不手抄）。
 *
 * 取每一节的小标题行（`### 加…` / `### 修…`）；页面上默认只摆最近三版（手机上别一屏糊满），
 * 点「展开全部更新」看完整历史（用户 2026-10-09 要求：说明里得能看到 1.0 → 2.0 全量）。
 * 全文仍然看 CHANGELOG。读不到就返回空数组，页面上那一块自己收起来 —— 绝不让它变成报错。
 */
/**
 * 用户向的更新说明（`USERNEWS.md`）：版本 → 一行句人话 ✓。
 * 由 `whatsNew()` 用来覆盖 CHANGELOG 推导出来的行 —— 工程日志保持原样，手机上看的是这一份 ✓。
 */
let cachedUserNews = null
function userNews() {
	if (cachedUserNews !== null) return cachedUserNews
	const map = {}
	try {
		const text = readFileSync(join(HERE, '..', 'USERNEWS.md'), 'utf8')
		// ## 1.0 之前 是没有版本号的那段起步（仓库第一条正式记录就是 1.0.0）—— 单独收 ✓。
		const head = /^##\s+(1\.0\s*之前|[0-9][^\s—–-]*)/gm
		const marks = []
		for (let m = head.exec(text); m !== null; m = head.exec(text)) marks.push({ version: m[1], at: m.index, end: head.lastIndex })
		for (let i = 0; i < marks.length; i += 1) {
			const body = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : text.length)
			const lines = body.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.startsWith('- '))
				.map((line) => line.replace(/^-\s+/, '').replace(/\*\*/g, '').trim())
				.filter((line) => line !== '')
			if (lines.length > 0) map[marks[i].version] = lines.slice(0, 3)
		}
	} catch { /* 没有就用 CHANGELOG 的 */ }
	cachedUserNews = map
	return map
}

let cachedWhatsNew = null
function whatsNew(limit = 500) {
	if (cachedWhatsNew !== null) return cachedWhatsNew
	const sections = []
	try {
		const text = readFileSync(join(HERE, '..', 'CHANGELOG.md'), 'utf8')
		/*
		 * ⚠️ 标题后面**允许有别的东西**（`## 2.0.0 — 2026-10-09 · **最终版**`）。
		 *
		 * 原来这里是 `…(\S+)\s*$`（要求日期就是行尾），结果我给 2.0.0 标题加了"· 最终版"
		 * 之后，**这一整节被静默跳过** —— 手机上的"最新版本"就退回到 1.8.2 ✗
		 * （用户现场：登录页与说明页都显示 1.8.2，而 package.json 与服务端发出去的 HTML 都是 2.0.0）。
		 * 所以：日期之后一律容忍。
		 */
		const head = /^##\s+([0-9][^\s—–-]*)\s*[—–-]\s*(\S+)(?:\s+.*)?$/gm
		const marks = []
		for (let match = head.exec(text); match !== null; match = head.exec(text)) {
			marks.push({ version: match[1], date: match[2], at: match.index, end: head.lastIndex })
		}
		for (let i = 0; i < marks.length && sections.length < limit; i += 1) {
			const body = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : text.length)
			const raw = body.split(/\r?\n/)
			/*
			 * **版本一个都不许少**（用户 2026-10-09：要看到 1.0 → 2.0 全量），
			 * **但维护者向的行要滤掉**（用户 2026-10-11：「更新内容测试是什么意思，没有意义好吗」）。
			 *
			 * 这两条曾经互相打架：白名单（只留 加/改/修…）会把写法不同的标题静默丢掉（32 版只剩 15 ✗）；
			 * 干脆不筛又会让「测试」「实现上的小心处」这类行直接摆到用户面前 ✗。
			 * 所以现在这样：**版本照收，行按黑名单滤**；某一版过滤后什么都不剩（整版都是内部改动），
			 * 就明说一句"内部改动" —— 既不多一行废话，也不假装那一版不存在 ✓。
			 */
			const MAINTENANCE = /^(测试|实现|内部|文档|顺带|为什么|感谢|配置|注意|发布|值|彩蛋|教训|已知未修|发布前|自检|复核|口径)/
			const isBodyLine = (line) => line !== '' && line.startsWith('>') === false
				&& line.startsWith('|') === false && line.startsWith('-') === false
				&& line.startsWith('#') === false && line.startsWith('```') === false
			let lines = raw
				.filter((line) => /^###\s+/.test(line))
				.map((line) => line.replace(/^###\s+/, '').replace(/\*\*/g, '').trim())
				.filter((line) => line !== '' && MAINTENANCE.test(line) === false)
			/*
			 * 早期几版（1.0.0 那批）正文用的是 `**1. 手机端生图（…）**` 这种**加粗小标题** ✗，
			 * 而 `###` 只有光秃秃一个「新增」「修复」—— 只读 `###` 的结果是手机上那几个版本
			 * 只剩两个字 ✗（用户 2026-10-11：「1.0.0 的更新内容去哪里了？为什么只有一两个字」）。
			 * 所以：`###` 是"光杆分类"（或压根没有）时，把正文里的**加粗小标题**收进来当内容 ✓。
			 */
			const bare = (line) => /^(新增|新加|加|改|修改|修|修复|变更|优化|调整|删|删除|移除|其它|其他|说明)$/.test(line)
			// "光杆分类"还包括很短、没有说明的字（比如「已知限制」4 个字）——整行都很短就算光杆 ✓。
			if (lines.length === 0 || lines.every((line) => bare(line) || line.length <= 6)) {
				const bold = raw
					.map((line) => line.trim())
					.map((line) => /^\*\*[^*]+\*\*$/.test(line) ? line.replace(/\*\*/g, '').trim() : '')
					.filter((line) => line !== '' && MAINTENANCE.test(line) === false)
				const bodies = raw.map((line) => line.trim())
					.filter((line) => isBodyLine(line) && /^\*\*/.test(line) === false && MAINTENANCE.test(line) === false)
					.map((line) => line.replace(/\*\*/g, ''))
				const picked = (bold.length > 0 ? bold : bodies).slice(0, 3)
				if (picked.length > 0) lines = picked
			}
			if (lines.length === 0) {
				const first = raw.map((line) => line.trim()).find((line) => isBodyLine(line) && MAINTENANCE.test(line) === false)
				lines = first !== undefined ? [first.replace(/\*\*/g, '')] : ['（这一版是内部改动，没有用户能感知的变化）']
			}
			/*
			 * **用户向覆盖**（2026-10-11 用户：「说明更新内容读者都不明白什么意思」✓）：
			 * CHANGELOG 是写给维护者的（字段名、"光杆标题"、测试……读者看不懂 ✗），
			 * 所以说明页优先用 `USERNEWS.md` 里那一句人话 ✓；没写到的版本再退回 CHANGELOG ✓。
			 */
			const friendly = userNews()[marks[i].version]
			sections.push({ version: marks[i].version, date: marks[i].date, lines: friendly ?? lines })
		}
		/*
		 * 「1.0 之前」那段：用户要求「还有 1.0 以前的版本也要写」—— 仓库里没有 0.x 的正式版本
		 * （第一条记录就是 1.0.0 ✗），所以不编造版本号 ✗，改成把这段"起步"作为**最后一条**附上 ✓。
		 */
		const earliest = userNews()['1.0 之前']
		if (earliest !== undefined && sections.some((section) => section.version === '1.0 之前') === false) {
			sections.push({ version: '1.0 之前', date: '起步', lines: earliest })
		}
	} catch { /* 读不到就没有 */ }
	cachedWhatsNew = sections
	return sections
}

/**
 * 开始页（PIN 登录页 + 「开始使用」说明页）上要显示的版本信息。
 *
 * 用户在开始页最想知道的两件事：**我连的是哪一版**、**这一版变了什么**。
 * 两样都从插件自己的文件里现读（package.json / CHANGELOG.md），不手抄。
 */
function startPageInfo() {
	const sections = whatsNew()
	return {
		version: bridgeVersion(),
		whatsNew: sections,
	}
}

const DEFAULT_PORT = 3081
/**
 * 宿主（DSH）的图片白名单只有这四种。别的格式（HEIC/BMP/TIFF/动图变体…）走
 * `files` 那条路：落到电脑磁盘上，把路径写进任务里，agent 用工具去读。
 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BASE64 = 12 * 1024 * 1024
const MAX_IMAGES_PER_PROMPT = 20
/** 手机发文件（视频、PDF、huge 图）时的上限：单个 40 MB base64（约 30 MB 原文件）。 */
const MAX_FILE_BASE64 = 40 * 1024 * 1024
const MAX_FILES_PER_PROMPT = 3
/** 手机上传的文件落在这里（相对 ~/.dsh）。 */
const UPLOAD_DIR = 'mobile-uploads'
/**
 * 分片上传：一次请求只带一小片。
 *
 * 为什么必须分片：隧道那头（Tailscale 入口）对**慢的、大的**请求会直接掐断 ——
 * 实测 IPv6 入口一个 16 MB 请求回 408，6.7 MB 要 89 秒。手机上行更慢，一整块发
 * 过去必然死在边缘，用户只看到"发送失败 http 403"（边缘的错误页不是 JSON）。
 * 每片 384 KB 原文件，请求体约 512 KB，走慢链路也就几秒。
 */
const UPLOAD_CHUNK_BYTES = 384 * 1024
const MAX_UPLOAD_CHUNKS = 4000
const MAX_UPLOAD_BYTES = 120 * 1024 * 1024
/**
 * 手机发来的视频：抽几帧当图片交给模型。
 *
 * 模型本身**看不了视频**，以前只能给一个路径、让 agent 自己去 ffmpeg。现在桥直接抽帧：
 * 均匀取 6 帧、宽 768、JPEG，一次约 0.3~0.5 MB 的 base64 —— 模型能"看懂视频里发生了什么"，
 * 而且原文件路径照样给（要原片、要音频时还能用工具）。
 *
 * 帧数别贪多：每多一帧就多一份 base64，慢上行下这是纯负担；6 帧对"这是啥视频"足够。
 */
const VIDEO_FRAME_COUNT = 6
const VIDEO_FRAME_WIDTH = 768
/** 抽帧最多等多久：超了就只给路径，绝不让一条消息卡在这上面。 */
const VIDEO_FRAME_TIMEOUT_MS = 20000
/** 比这还长的视频跳过抽帧（真机上是几十分钟的录屏，抽帧既慢又没意义）。 */
const VIDEO_FRAME_MAX_SECONDS = 30 * 60
/** 视频扩展名 → mediaType（手机偶尔不给 content-type，靠扩展名兜底）。 */
const VIDEO_EXTENSIONS = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.avi': 'video/x-msvideo',
	'.mkv': 'video/x-matroska',
	'.3gp': 'video/3gpp',
}
/** `/api/file` 一次最多发多大的媒体（素材图/短视频够用，别拿它下电影）。 */
const MAX_SERVED_FILE_BYTES = 200 * 1024 * 1024
/** 文档（PDF/表格/文稿/文本）单独一个更小的闸：手机上打开几十 MB 的文件只会卡死。 */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

/**
 * 语音转文字（ASR）：手机发的语音/录音，模型也能"读懂"。
 *
 * 用智谱 GLM-ASR（用户 2026-10-09 要求）。为什么不用本地 whisper：
 * ① 这台机器上**已经填过智谱 key**（生图插件用的同一个平台），不用再注册、不用下模型；
 * ② 中文识别质量好、抗噪，价格 0.06 元/分钟（一分钟语音六分钱）；
 * ③ 本地 whisper 要下 75~150 MB 模型 + 编译 C++，在这台机的网速下不划算。
 *
 * ⚠️ 接口硬限制：**单次 ≤30 秒、≤25 MB**。所以长音频必须切片（25 秒一段），
 * 切片之间用 `prompt` 把上一段结果传过去当上下文 —— 否则句子会在切口处断掉。
 */
const ASR_DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4'
const ASR_DEFAULT_MODEL = 'glm-asr-2512'
/** 每段 25 秒（接口上限 30 秒，留点余量）。 */
const ASR_SEGMENT_SECONDS = 25
/**
 * 超过这个时长就不转。
 *
 * 原来是 10 分钟 —— 用户 2026-10-09 问「上课录音再发给你你能识别吗」，10 分钟这个闸
 * 会把一整节课（45~90 分钟）直接挡在门外。现在放到 **3 小时**，并且把**花的钱**说出来
 * （0.06 元/分钟，一节课约 2.7 元）：该拦的是"误把几小时的录音发过来"，不是上课录音。
 * 想更省：在 `mobile-bridge.json` 里把 `asrMaxMinutes` 调小。
 */
const ASR_MAX_MINUTES = 180
/** 智谱 GLM-ASR 的单价（元/分钟）——只用来在消息里报个大概，不参与计费。 */
const ASR_YUAN_PER_MINUTE = 0.06
const ASR_TIMEOUT_MS = 60000
/** 音频扩展名 → mediaType。 */
const AUDIO_EXTENSIONS = {
	'.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.wav': 'audio/wav',
	'.caf': 'audio/x-caf',
	'.amr': 'audio/amr',
	'.ogg': 'audio/ogg',
	'.opus': 'audio/opus',
	'.flac': 'audio/flac',
	'.wma': 'audio/x-ms-wma',
	'.aiff': 'audio/aiff',
}
/** 能当手机界面背景的扩展名。视频给 <video>，图片给 <img>。 */
const BACKDROP_TYPES = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
}

/**
 * 视频抽帧：把"agent 看不了视频"这件事补上（用户 2026-10-09 的要求）。
 *
 * 为什么用 ffmpeg：手机上发来的视频五花八门（iPhone 的 .mov/HEVC、安卓的 .mp4、录屏的
 * .mkv），浏览器和 Node 都解不了；ffmpeg 是唯一一个"什么都能解"的现成工具。
 *
 * 为什么把输出**落成文件**而不是接管道：受限沙箱里 Node 的 `stdio:'pipe'` 会直接
 * EPERM（拿不到输出，还看不出是为什么）。走临时文件这条路在哪都能用。
 */

/** 找 ffmpeg/ffprobe：配置里指定的 → ~/.dsh/bin → PATH。找不到就退回"只给路径"。 */
function resolveMediaBinary(name, configured) {
	if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
	const local = join(homedir(), '.dsh', 'bin', process.platform === 'win32' ? `${name}.exe` : name)
	try {
		statSync(local)
		return local
	} catch { /* 没装在那儿 */ }
	return name  // 交给 PATH 去找；找不到时 spawn 会 error，调用方按"没有"处理
}

/**
 * 跑一个媒体命令，把 stdout/stderr 落到临时文件后读回来。
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, failed:boolean}>}
 */
function runMediaCommand(command, args, timeoutMs = VIDEO_FRAME_TIMEOUT_MS) {
	return new Promise((resolve) => {
		const stamp = `${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`
		const outPath = join(tmpdir(), `dsh-ff-out-${stamp}.txt`)
		const errPath = join(tmpdir(), `dsh-ff-err-${stamp}.txt`)
		let outFd = -1
		let errFd = -1
		try {
			outFd = openSync(outPath, 'w')
			errFd = openSync(errPath, 'w')
		} catch {
			resolve({ code: null, stdout: '', stderr: '', failed: true })
			return
		}
		let child
		try {
			child = spawn(command, args, { stdio: ['ignore', outFd, errFd], windowsHide: true })
		} catch {
			closeSync(outFd); closeSync(errFd)
			resolve({ code: null, stdout: '', stderr: '', failed: true })
			return
		}
		let settled = false
		const finish = (code, failed) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			try { closeSync(outFd) } catch { /* 已关 */ }
			try { closeSync(errFd) } catch { /* 已关 */ }
			let stdout = ''
			let stderr = ''
			try { stdout = readFileSync(outPath, 'utf8') } catch { /* 没有就没有 */ }
			try { stderr = readFileSync(errPath, 'utf8') } catch { /* 同上 */ }
			try { unlinkSync(outPath) } catch { /* 同上 */ }
			try { unlinkSync(errPath) } catch { /* 同上 */ }
			resolve({ code, stdout, stderr, failed })
		}
		const timer = setTimeout(() => {
			try { child.kill() } catch { /* 已经退了 */ }
			finish(null, true)
		}, timeoutMs)
		child.on('error', () => finish(null, true))
		child.on('close', (code) => finish(code, code !== 0))
	})
}

/**
 * ffmpeg 到底有没有。
 *
 * ⚠️ **只缓存"成功"**（2026-10-09 修）：原来是"探一次就定终身"✗ —— 那次探测只要失败一次
 * （插件刚热重载、进程正忙、8 秒超时…），就会被**永久记成"没有 ffmpeg"**，
 * 之后每一段录音/视频都被当成"只给路径的普通文件"发出去，而且**一句话都不说** ✗。
 * 现场：用户对着手机说了一段话，模型收到的是"图片之外的内容我没法直接看" ——
 * 而 ffmpeg 明明就装在 `~/.dsh/bin/ffmpeg.exe`。
 */
let mediaToolsProbe = null
async function mediaToolsAvailable(ffmpegPath) {
	if (mediaToolsProbe === true) return true
	const result = await runMediaCommand(ffmpegPath, ['-version'], 15000)
	const ok = result.failed !== true && /ffmpeg version/i.test(result.stdout + result.stderr)
	// 成功才记；失败不记，下次要用时再探一遍（代价就是一次 15 秒内的 spawn）。
	if (ok) mediaToolsProbe = true
	else if (mediaToolsProbe !== true) mediaToolsProbe = null
	return ok
}

/** 视频多长（秒）。ffprobe 拿不到就用 ffmpeg 自己报的时长兜底；都没辙返回 null。 */
async function probeVideoSeconds(ffprobePath, path, ffmpegPath) {
	const result = await runMediaCommand(ffprobePath, [
		'-v', 'error',
		'-show_entries', 'format=duration',
		'-of', 'default=noprint_wrappers=1:nokey=1',
		path,
	], 10000)
	const seconds = Number(String(result.stdout).trim())
	if (Number.isFinite(seconds) && seconds > 0) return seconds
	// ffprobe 没装/失败：ffmpeg 读一下容器头就会在日志里打 `Duration: 00:00:03.00`。
	const fallback = await runMediaCommand(ffmpegPath, ['-hide_banner', '-i', path], 12000)
	const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(fallback.stderr)
	if (match === null) return null
	const value = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
	return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 抽帧：均匀取 count 帧，缩到 width 宽，JPEG。
 *
 * 每一帧单独 `-ss` 定位取（输入定位是**快速跳**，不用从头解码），6 帧通常 1 秒内。
 * @returns {Promise<Array<{seconds:number, base64:string}>>}
 */
async function extractVideoFrames(path, { ffmpegPath, ffprobePath, count = VIDEO_FRAME_COUNT, width = VIDEO_FRAME_WIDTH } = {}) {
	if ((await mediaToolsAvailable(ffmpegPath)) !== true) return []
	const probe = ffprobePath ?? resolveMediaBinary('ffprobe', process.env.DSH_BRIDGE_FFPROBE)
	const seconds = await probeVideoSeconds(probe, path, ffmpegPath)
	if (seconds === null || seconds > VIDEO_FRAME_MAX_SECONDS) return []
	const dir = join(tmpdir(), `dsh-frames-${process.pid}-${randomBytes(4).toString('hex')}`)
	const frames = []
	try {
		await mkdir(dir, { recursive: true })
		for (let index = 0; index < count; index += 1) {
			// 取每段的中点：开头/结尾常是黑屏或过场，中点最能代表这一段。
			const at = Math.min(Math.max((seconds * (index + 0.5)) / count, 0), Math.max(0, seconds - 0.05))
			const target = join(dir, `frame-${index}.jpg`)
			const result = await runMediaCommand(ffmpegPath, [
				'-hide_banner', '-loglevel', 'error', '-y',
				'-ss', at.toFixed(3),
				'-i', path,
				'-frames:v', '1',
				'-vf', `scale=${width}:-2`,
				'-q:v', '4',
				target,
			], VIDEO_FRAME_TIMEOUT_MS)
			if (result.failed === true) continue
			try {
				const buffer = await readFile(target)
				if (buffer.length > 0) frames.push({ seconds: at, base64: buffer.toString('base64') })
			} catch { /* 这一帧没出来（视频太短/位置超出），跳过 */ }
		}
	} finally {
		try { await rm(dir, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
	}
	return frames
}

/**
 * 拼一个 multipart/form-data 请求体（不引第三方库：就一个文件 + 几个文本字段）。
 * @returns {{boundary:string, body:Buffer}}
 */
function multipartBody(fields, file) {
	const boundary = `----dshbridge${randomBytes(9).toString('hex')}`
	const chunks = []
	for (const [name, value] of Object.entries(fields)) {
		chunks.push(Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
			'utf8',
		))
	}
	if (file !== null && file !== undefined) {
		chunks.push(Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
			+ `Content-Type: ${file.type}\r\n\r\n`,
			'utf8',
		))
		chunks.push(file.buffer)
		chunks.push(Buffer.from('\r\n', 'utf8'))
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
	return { boundary, body: Buffer.concat(chunks) }
}

/** 智谱 key：配置里的 asrKey 优先；没配就顺带用生图插件那份（同一个平台，用户已经填过）。 */
function resolveAsrKey(configured) {
	if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
	try {
		const raw = readFileSync(join(homedir(), '.dsh', 'image-gen.json'), 'utf8')
		const parsed = JSON.parse(raw)
		const key = parsed?.zhipu?.key
		if (typeof key === 'string' && key.trim() !== '') return key.trim()
	} catch { /* 没装生图插件/没填 key：那就没有 ASR */ }
	return ''
}

/**
 * 把一段音频（或视频里的音轨）转成文字。
 *
 * 流程：探时长 →（探不到也照转）→ ffmpeg 切成 25 秒的 mp3（单声道 16 k）→ 逐段调 ASR
 * （上一段的结果当 prompt 传下去，句子不会在切口断掉）→ 拼起来。
 *
 * ⚠️ **时长未知也要转**（2026-10-09 修，关键）：
 * 手机网页里录的那段 opus/webm（MediaRecorder 产出）**没有时长头** —— ffprobe 和
 * `ffmpeg -i` 都报 `Duration: N/A` ✗。原来这里"探不到时长就 return null"，
 * 于是**所有网页录音永远转不出文字**（用户对着手机说了半天，模型只收到一个文件路径 ✗，
 * 而且提示词还瞎猜是"接口/网络问题"）。现在：探不到就把时长当作**未知**，照样切段转写；
 * "太长"这道闸改用**段数**兜（切到超过上限就不再切），转完用段数×25 秒估个时长给用户看。
 *
 * @returns {Promise<{text:string, seconds:number, segments:number}|null>} 失败一律 null（绝不让发消息失败）
 */
async function transcribeMedia(path, { key, baseUrl, model, maxMinutes, ffmpegPath, ffprobePath } = {}) {
	if (typeof key !== 'string' || key === '') return null
	if ((await mediaToolsAvailable(ffmpegPath)) !== true) return null
	const probe = ffprobePath ?? resolveMediaBinary('ffprobe', process.env.DSH_BRIDGE_FFPROBE)
	const probed = await probeVideoSeconds(probe, path, ffmpegPath)
	const limitMinutes = Number.isFinite(maxMinutes) && maxMinutes > 0 ? maxMinutes : ASR_MAX_MINUTES
	const maxSegments = Math.ceil(limitMinutes * 60 / ASR_SEGMENT_SECONDS) + 1
	if (probed !== null && probed > limitMinutes * 60) {
		return { text: '', seconds: probed, segments: 0, skipped: 'too-long' }
	}
	const seconds = probed ?? 0
	const dir = join(tmpdir(), `dsh-asr-${process.pid}-${randomBytes(4).toString('hex')}`)
	const parts = []
	// 时长：探得到用真的；探不到（网页录音的 webm）切完段用"段数×25 秒"估。
	// **必须声明在 try 外面** —— 最后拼结果时要用它，放 try 里就成块作用域，外面直接 ReferenceError。
	let measured = seconds
	try {
		await mkdir(dir, { recursive: true })
		const pattern = join(dir, 'seg-%03d.mp3')
		const cut = await runMediaCommand(ffmpegPath, [
			'-hide_banner', '-loglevel', 'error', '-y',
			'-i', path,
			'-vn',                       // 视频只要音轨
			'-ac', '1', '-ar', '16000',
			'-c:a', 'libmp3lame', '-b:a', '48k',
			'-f', 'segment', '-segment_time', String(ASR_SEGMENT_SECONDS), '-reset_timestamps', '1',
			pattern,
		], 120000)
		if (cut.failed === true) return null
		const files = (await readdir(dir)).filter((name) => name.endsWith('.mp3')).sort()
		if (files.length === 0) return null
		// 时长探不到时（网页录音的 webm 就是），"太长"这道闸改用段数兜：
		// 切出来的段数超过上限就不再往下转，免得一个几小时的文件把额度烧光。
		measured = probed !== null ? probed : files.length * ASR_SEGMENT_SECONDS
		if (probed === null && files.length > maxSegments) {
			return { text: '', seconds: measured, segments: 0, skipped: 'too-long' }
		}
		const endpoint = `${String(baseUrl ?? ASR_DEFAULT_BASE).replace(/\/+$/, '')}/audio/transcriptions`
		let context = ''
		for (const name of files) {
			const buffer = await readFile(join(dir, name))
			const fields = { model: model ?? ASR_DEFAULT_MODEL, stream: 'false' }
			// 上一段的结尾当上下文：GLM-ASR 的 prompt 字段就是干这个的（官方建议 <8000 字）。
			if (context !== '') fields.prompt = context.slice(-2000)
			const { boundary, body } = multipartBody(fields, { name, type: 'audio/mpeg', buffer })
			const controller = typeof AbortController === 'function' ? new AbortController() : null
			const timer = controller === null ? 0 : setTimeout(() => controller.abort(), ASR_TIMEOUT_MS)
			try {
				const res = await fetch(endpoint, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${key}`,
						'content-type': `multipart/form-data; boundary=${boundary}`,
					},
					body,
					...(controller === null ? {} : { signal: controller.signal }),
				})
				const text = await res.text()
				if (res.ok === false) return parts.length > 0 ? { text: parts.join(''), seconds: measured, segments: parts.length } : null
				let parsed = {}
				try { parsed = JSON.parse(text) } catch { return null }
				const piece = String(parsed?.text ?? '').trim()
				if (piece !== '') { parts.push(piece); context = piece }
			} catch {
				// 某一段失败：已经转出来的部分照样交出去（半份转写也比没有强）。
				return parts.length > 0 ? { text: parts.join(''), seconds: measured, segments: parts.length } : null
			} finally {
				if (timer !== 0) clearTimeout(timer)
			}
		}
	} finally {
		try { await rm(dir, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
	}
	if (parts.length === 0) return null
	// 时长未知的（网页录音）用段数×25 秒估一个，用户看到的"约 N 秒/花了多少钱"才不是 0。
	return { text: parts.join(''), seconds: measured, segments: parts.length }
}

/**
 * 按**内容**判断媒体类型，不只信扩展名。
 * 手机相册里存下来的东西经常扩展名骗人：用户发的 `1791380138027.jpeg`，内容其实是
 * `ftypheic`（iPhone 拍的 HEIC 图）；更早那段 `1791373673274.mov` 则是 `ftypqt`（视频）。
 * 两者头 8 字节都以 `ftyp` 开头，必须看**major brand** 才分得开 ——
 * 认成视频去 `<video>` 播会失败，认成 jpeg 去 `<img>` 解也会失败，用户看到的就是
 * "设了背景却没背景"。
 */
function sniffBytes(buf) {
	if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
		const brand = buf.subarray(8, 12).toString('latin1').trim()
		if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
		if (['avif', 'avis'].includes(brand)) return 'image/avif'
		return 'video/mp4'
	}
	if (buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video/webm'
	if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
	if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
	if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
	if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
	return ''
}

/**
 * **文档**类型表（2.1.0 起）。
 *
 * 为什么单独一张表：`mediaTypeOf()` 只认图片/视频（按内容嗅探），于是 agent 在电脑上产出的
 * 文稿、PDF、Markdown、代码，手机上只能看到一个路径、点不开 ✗。用户要的就是"能打开它发我的文档"。
 *
 * 只按**扩展名**认（文档没有可靠的魔数；PDF 有 `%PDF`，但那也只是锦上添花），
 * 认不出的类型一律不服务 —— 宁可说"这个手机上看不了"，也不要变成一个通用文件下载器。
 */
const DOC_TYPES = {
	'.md': 'text/markdown; charset=utf-8',
	'.markdown': 'text/markdown; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.log': 'text/plain; charset=utf-8',
	'.csv': 'text/csv; charset=utf-8',
	'.tsv': 'text/tab-separated-values; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.yml': 'text/plain; charset=utf-8',
	'.yaml': 'text/plain; charset=utf-8',
	'.xml': 'text/plain; charset=utf-8',
	'.ini': 'text/plain; charset=utf-8',
	'.sql': 'text/plain; charset=utf-8',
	'.py': 'text/plain; charset=utf-8',
	'.js': 'text/plain; charset=utf-8',
	'.mjs': 'text/plain; charset=utf-8',
	'.ts': 'text/plain; charset=utf-8',
	'.ps1': 'text/plain; charset=utf-8',
	'.sh': 'text/plain; charset=utf-8',
	'.bat': 'text/plain; charset=utf-8',
	'.c': 'text/plain; charset=utf-8',
	'.h': 'text/plain; charset=utf-8',
	'.cpp': 'text/plain; charset=utf-8',
	'.java': 'text/plain; charset=utf-8',
	'.go': 'text/plain; charset=utf-8',
	'.rs': 'text/plain; charset=utf-8',
	'.pdf': 'application/pdf',
	'.doc': 'application/msword',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xls': 'application/vnd.ms-excel',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.ppt': 'application/vnd.ms-powerpoint',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'.zip': 'application/zip',
}

/** 手机上**能直接在页面里看**的（其余给"下载/用别的 App 打开"）。 */
const INLINE_TYPES = new Set([
	'text/markdown; charset=utf-8', 'text/plain; charset=utf-8', 'text/csv; charset=utf-8',
	'text/tab-separated-values; charset=utf-8', 'application/json; charset=utf-8', 'application/pdf',
])

/**
 * Office / 表格的**手机预览**（2026-10-23 用户：「手机桥帮我加上 ppt 和表格渲染功能」✓）。
 *
 * 为什么不在手机上直接渲染：浏览器没有 pptx / xlsx 渲染器 ✗；让用户下载后用 WPS 打开也太绕 ✗。
 * 做法：**在电脑上转一次** —— PowerPoint COM 逐页导 JPG ✓、Excel COM 读成「行×列」✓、
 * CSV/TSV 直接解析 ✓；结果按「路径 + 大小 + mtime」缓存在 `~/.dsh/mobile-bridge/preview-cache` ✓，
 * 同一份文件第二次打开就是读缓存 ✓。转换是**串行**的（COM 不能并发 ✓），失败了就如实说 + 给「下载」✓。
 *
 * 安全：和 `/api/file` 同一条规矩 —— 必须在桥认识的目录里 ✓、密钥类文件一律不给 ✓、
 * 超过文档大小上限不给 ✓、只认白名单扩展名 ✓（不做通用文件读取器 ✗）。
 */
const PREVIEW_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000
const PREVIEW_CACHE_MAX_DIRS = 60
const PREVIEW_MAX_SLIDES = 40
const PREVIEW_MAX_ROWS = 300
const PREVIEW_MAX_COLS = 30
const PREVIEW_CELL_MAX_CHARS = 400
const PREVIEW_TOTAL_CELLS = 5000
const PREVIEW_WIDTH = 1280

/** 先看内容，认不出再看扩展名（图片/视频），最后才按文档扩展名认。 */
function mediaTypeOf(path) {
	const lower = extname(path).toLowerCase()
	const ext = BACKDROP_TYPES[lower] ?? DOC_TYPES[lower] ?? ''
	try {
		const fd = openSync(path, 'r')
		const head = Buffer.alloc(16)
		const read = readSync(fd, head, 0, 16, 0)
		closeSync(fd)
		const sniffed = sniffBytes(head.subarray(0, read))
		if (sniffed !== '') return sniffed
	} catch { /* 读不到就按扩展名 */ }
	return ext
}

/**
 * 读出图片的像素尺寸（PNG/JPEG/GIF/WebP）。读不出来返回 undefined。
 *
 * 为什么需要它：手机页面里的图**必须预留尺寸**，否则每张图下载完都会把它下面的内容
 * 顶下去 —— 用户看到的就是"看着看着就串位了（错位）"。附件（会话里的图）自带
 * width/height，可电脑上产出的图只给了一行路径，尺寸只有服务端知道。
 *
 * 只读文件头（最多 256KB，JPEG 的 SOF 段偶尔在几 KB 之后），不整文件解码。
 */
function imageSizeOf(path) {
	let fd
	let buf
	try {
		fd = openSync(path, 'r')
		buf = Buffer.alloc(256 * 1024)
		const read = readSync(fd, buf, 0, buf.length, 0)
		buf = buf.subarray(0, read)
	} catch {
		return undefined
	} finally {
		if (fd !== undefined) { try { closeSync(fd) } catch { /* 关不掉就算了 */ } }
	}
	if (buf.length < 16) return undefined
	// PNG：IHDR 紧跟 8 字节签名，宽高各 4 字节大端。
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
	}
	// GIF：逻辑屏幕宽高各 2 字节小端。
	if (buf.subarray(0, 4).toString('latin1') === 'GIF8') {
		return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
	}
	// WebP：VP8X 直接给画布尺寸（24 位小端，存的是"减一"）；VP8 有损在帧头里。
	if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
		const tag = buf.subarray(12, 16).toString('latin1')
		if (tag === 'VP8X' && buf.length >= 30) {
			return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
		}
		if (tag === 'VP8 ' && buf.length >= 30) {
			return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF }
		}
		return undefined
	}
	// JPEG：扫段找 SOF（0xC0–0xCF，排除 0xC4/0xC8/0xCC），高在 +5、宽在 +7。
	if (buf[0] === 0xFF && buf[1] === 0xD8) {
		let at = 2
		while (at + 9 < buf.length) {
			if (buf[at] !== 0xFF) { at += 1; continue }
			const marker = buf[at + 1]
			if (marker === 0xFF || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { at += 2; continue }
			const length = buf.readUInt16BE(at + 2)
			const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
			if (isSof) return { height: buf.readUInt16BE(at + 5), width: buf.readUInt16BE(at + 7) }
			if (length < 2) break
			at += 2 + length
		}
	}
	return undefined
}

const COOKIE = 'dshm'
/**
 * 这台手机的**长期身份**（不是登录凭据）：只用来记「开始使用说明页看过没有」。
 *
 * 为什么不能用来源 IP 记：隧道（Tailscale Funnel / cloudflared）下，所有手机在宿主
 * 眼里是**同一个地址**（回环或隧道出口）。于是出现过这种现场 —— 一台手机点过
 * 「开始使用」，**之后所有手机（同学、新手机、无痕窗口）进来都再也不弹说明页**，
 * 新人一脸茫然。按设备记账才对；代价是"清了站点数据"会再看一遍说明，可以接受。
 */
const DEVICE_COOKIE = 'dshm_device'
// A stolen cookie used to stay valid for a month, which is a long time to notice a
// phone that went missing. Twelve hours is the default now; two weeks is the cap.
const DEFAULT_TOKEN_TTL_HOURS = 12
const MAX_TOKEN_TTL_HOURS = 24 * 14
// Reading history takes a session. Making this machine DO something takes the PIN
// again, valid for this long. It is the difference between a leaked cookie being a
// privacy problem and it being a remote-code-execution problem.
//
// ⚠️ 2026-10-14 用户亲口：「提权默认只保持 15 分钟改成一个小时」✓ —— 默认从 15 改成 **60** ✓。
// 上限仍是 240 ✓（`MAX_ELEVATION_MINUTES` ✓）。⚠️ 老用户注意 ✗：这一条**只在"配置里没写"时生效** ✓ ——
// 已经跑过一次的机器，`mobile-bridge.json` 里那份 `elevationMinutes`（当年写进去的 15 ✓）
// 是**显式值** ✓，会被原样沿用 ✓（本次连他那份配置一起改了 ✓，见 CHANGELOG ✓）。
const DEFAULT_ELEVATION_MINUTES = 60
const MAX_ELEVATION_MINUTES = 240
// Live SSE streams held by one phone are one or two. The cap exists because this
// listener is reachable from the internet through the tunnel, and an unbounded
// fan-out is a cheap way to exhaust the process the whole harness runs in.
const MAX_LIVE_STREAMS = 6
/**
 * 手机没回答时，等多久把提问交还给桌面（官方 api-remotes 的应答者）。
 *
 * waterfall 是【顺序】的：我们 prepend 在最前面，所以在我们返回之前，桌面根本
 * 看不到这个提问。等太久 = 桌面上的批准框迟迟不出现；等太短 = 用户正在手机上
 * 读题就被抢走。120 秒对"正在看手机"的人是够的。
 */
const INTERACTION_TIMEOUT_MS = 120_000
/** 同时挂起的提问上限，防止某个 agent 疯狂提问把内存撑爆。 */
const MAX_PENDING_INTERACTIONS = 16
/**
 * 一次快照最多发给手机多少字节。
 *
 * 手机端绝不能收到整段历史。实测一段聊了几小时的会话：日志 9.7 MB，只要 40 条消息
 * 就展开成 195 条记录、**979 KB** —— 手机（尤其走隧道时）根本传不完，一断线又从头再传，
 * 用户看到的就是永远停在"正在读取会话内容…"。
 */
const SNAPSHOT_BUDGET_BYTES = 240_000
/**
 * 一次快照向宿主最多要多少条消息。
 *
 * 为什么从 40 提到 80：**40 条太容易被"顶出去"** —— 用户报"手机端看不到图片"时，
 * 那张 `image_generate` 的记录在 seq 3528、而当时游标已经 4004，它早已滑出窗口，
 * 手机刷新也找不回来。字节预算（`SNAPSHOT_BUDGET_BYTES`）才是真正的护栏：超了就从
 * 最旧的开始丢，所以**要得更多不会让手机收到更大的包**，只会让"最近这一屏"更完整。
 */
const SNAPSHOT_MAX_MESSAGES = 80
/** 单条文本/工具输出截断到这个长度；真正的大块内容在电脑上看。 */
const SNAPSHOT_TEXT_LIMIT = 4000
// A ceiling on live phone sessions. One per address is the rule (see issueToken);
// this is the backstop so nothing can grow without bound.
const MAX_LIVE_TOKENS = 8
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 12
// A second, global cap. Twelve tries per address per ten minutes is nothing to a
// single host and everything to a botnet with a few thousand of them, so the
// distributed case needs its own ceiling. Sixty failures across everyone in ten
// minutes cannot happen by accident: mistyping a six-digit PIN sixty times in ten
// minutes is not a thing people do. That pins distributed guessing to about 8.6k
// tries a day against a million-combination space.
const LOGIN_MAX_ATTEMPTS_GLOBAL = 60

/* --------------------------------------------------------------- balance */

/** Same credential ref the balance badge uses, so both read one stored key. */
const CRED_REF = 'DEEPSEEK_API_KEY'
/** Primary endpoint plus the documented compatibility prefix. */
const BALANCE_URLS = ['https://api.deepseek.com/user/balance', 'https://api.deepseek.com/v1/user/balance']
const BALANCE_TIMEOUT_MS = 15000
/** The phone may pull-to-refresh; upstream should still be asked rarely. */
const BALANCE_CACHE_MS = 60000
/**
 * There is no public recharge API — DeepSeek only exposes the platform page.
 * The app therefore links out instead of pretending to move money.
 */
const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

/** Hard dependency: every route reads the Session domain through it. */
export const inject = ['sessionController']

/* ------------------------------------------------------------------ config */

/*
 * 「这台插件的数据目录」**在模块加载那一刻定死** ✓ —— 不每次现读 `process.env.DSH_HOME` ✗。
 *
 * 🔴 4.3.0 修的真 bug（第 97 轮顺手查实的"跑一次测试就往真实账本写假登录"的**真机制** ✓）：
 *   **错 PIN 那条审计是"发了就不管"的** ✓ —— `noteLoginFailure()` 里是 `void auditLogin(...)` ✓
 *   （刻意的：审计写不进去绝不挡住"这次 PIN 不对"这个判断 ✓，见那条注释 ✓）。
 *   于是错 PIN 的回包**先走** ✓，`appendFile` 还在后面等着 ✓ —— 这个窗口里谁改了 `DSH_HOME` ✓，
 *   这次写盘就**跟着新值走** ✓ → 写到别的目录里去 ✗（`test/security.mjs` 原来的形状正是
 *   "临时 DSH_HOME 起一次性实例 → 再还原" ✓；实测每一次跑就往真实 `~/.dsh` 落 15 行 ✓、
 *   全是 `192.0.2.x` + `ua=node` 的假设备 ✓ —— 用户从「安全审计」里看到的就是它们 ✓）。
 *   ⚠️ 注意区分：**成功**登录那条审计是 `await` 的 ✓（宿主那边等它写完再回包 ✓），
 *   所以这一类污染只从**失败尝试**那条无 await 的路来 ✓ —— 别把两句写混 ✗。
 *   进程里换数据目录本来就极罕见 ✓，而"换目录之后，一条**属于旧目录**的迟到写盘跑到新目录"
 *   则是纯粹的错 ✓ —— 所以把归属钉在**加载那一刻** ✓：同一个实例的每次文件操作都落在同一个目录 ✓。
 */
const bridgeHome = (() => {
	const configured = (process.env.DSH_HOME ?? '').trim()
	return configured === '' ? join(homedir(), '.dsh') : configured
})()

function dshHome() {
	return bridgeHome
}

async function loadConfig() {
	const file = join(dshHome(), CONFIG_FILE)
	let stored = {}
	try {
		stored = JSON.parse(await readFile(file, 'utf8'))
	} catch {
		stored = {}
	}
	const port = Number.isInteger(stored.port) && stored.port > 0 && stored.port < 65536 ? stored.port : DEFAULT_PORT
	const pin = typeof stored.pin === 'string' && /^\d{6}$/.test(stored.pin)
		? stored.pin
		: String(randomInt(100000, 1000000))
	// The address a phone last reached us on. Remembering it is what makes the
	// USB link usable without the operator working out which adapter to use.
	const phoneHost = typeof stored.phoneHost === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(stored.phoneHost)
		? stored.phoneHost
		: ''
	// A public entry point (Cloudflare quick tunnel), written by D:\dsh\tunnel-start.ps1.
	// Display-only: the badge shows it so the operator never has to hunt the log file
	// for the current URL, which changes on every tunnel restart.
	const publicUrl = typeof stored.publicUrl === 'string' && /^https:\/\/[^\s"'<>]+$/.test(stored.publicUrl)
		? stored.publicUrl
		: ''
	// 每条路由都藏在一个随机段后面。隧道域名本身已经不可枚举（Cloudflare 用泛域名
	// 证书，具体主机名不会进证书透明日志），但网址万一从日志行、截图或同步的浏览器
	// 历史里泄漏出去，光有域名也不该够用。必须声明在 `const config` 之前。
	const pathSecret = typeof stored.pathSecret === 'string' && /^[0-9a-f]{16}$/.test(stored.pathSecret)
		? stored.pathSecret
		: randomBytes(8).toString('hex')
	const tokenTtlHours = Number.isInteger(stored.tokenTtlHours) && stored.tokenTtlHours >= 1 && stored.tokenTtlHours <= MAX_TOKEN_TTL_HOURS
		? stored.tokenTtlHours
		: DEFAULT_TOKEN_TTL_HOURS
	// 安全优先：令牌绑定签发时的来源地址。手机换网络就要重新输 PIN，但偷走的
	// cookie 换一台机器就是废纸。不想这样就把 bindTokenToIp 设成 false。
	// 默认 false = 只告警不吊销（移动网络必需）。设成 true 才启用严格的"换地址即吊销"。
	const bindTokenToIp = stored.bindTokenToIp === true
	const elevationMinutes = Number.isInteger(stored.elevationMinutes) && stored.elevationMinutes >= 1 && stored.elevationMinutes <= MAX_ELEVATION_MINUTES
		? stored.elevationMinutes
		: DEFAULT_ELEVATION_MINUTES
	// 排查用的崩溃探针开关。必须原样带回去：下面"配置有变化就整体重写"那一步只写这里
	// 列出的字段，漏掉它就会把用户手动加的这一行悄悄抹掉。
	const crashProbe = stored.crashProbe === true
	// 手机优先回答提问 / 批准操作。默认【关】。
	//
	// 开着的时候，"正在看这个会话的手机"会抢在桌面前面拿到提问；手机 120 秒不答
	// 才轮到桌面。对纯桌面用户来说这是退步（批准框会晚两分钟才出现），所以默认关，
	// 谁需要谁开。没手机在看这个会话时，无论开关如何都是桌面先拿到。
	const answerOnPhone = stored.answerOnPhone === true
	/*
	 * 3.0.0 ★④「多端授权」：新设备登录后**先不生效**，等你在电脑上放行一次 ✓。
	 *
	 * ⚠️ **默认关** ✓（安全类功能一律默认关 ✓）—— 它会把"有 PIN 就能进"变成"有 PIN + 放行一次" ✓，
	 * 对只用一台手机的人是多一步 ✗，所以谁需要谁开 ✓（配置里写 `deviceApproval: true` ✓）。
	 *
	 * ⚠️ 防锁死（这一条比功能本身重要 ✗✗）：
	 *   · **一台已放行的设备都没有时，直接放行** ✓ —— 全新安装、或者把设备全踢掉之后，
	 *     下一次登录永远进得来 ✓（否则改了配置又清掉 cookie 就是"把自己关在门外" ✓）；
	 *   · 放行入口给的是**电脑本机**（loopback ✓）：只有坐在这台电脑前的人才打得开 ✓
	 *     —— 这比"再输一次 PIN"更接近"本人" ✓（PIN 可能被别人看到 ✓）。
	 */
	const deviceApproval = stored.deviceApproval === true
	// 手机界面的背景（用户自己挑的一段视频/一张图）：指向 ~/.dsh/mobile-uploads/ 里的
	// 文件名。和 crashProbe 一样必须原样带回去，否则下一次配置重写会把它抹掉。
	const backgroundFile = typeof stored.backgroundFile === 'string' && /^[^\\/]{1,120}$/.test(stored.backgroundFile)
		? stored.backgroundFile
		: ''
	/*
	 * 4.7.0「自带的赛博朋克背景」✓（用户 2026-10-15：「制作背景要有赛博朋克风格」✓）：
	 * **CSS 画出来的** ✓ —— 不带图片、不占流量、任何分辨率都清晰 ✓
	 *（也不用去碰"生成图带水印"那条麻烦路 ✓）。
	 * 白名单只认这一个值 ✓（写别的等于没设 ✓）—— 以后要多几个预设，就在这儿加 ✓。
	 */
	const backgroundPreset = typeof stored.backgroundPreset === 'string' && BACKGROUND_PRESETS.includes(stored.backgroundPreset)
		? stored.backgroundPreset
		: ''
	/*
	 * 4.8.0：自带预设**动不动** ✓（用户 2026-10-15：「最好是动态的背景」✓）。
	 * 缺省 = **动** ✓（只有明确写了 `false` 才静 ✓ —— 用户要的就是动态 ✓，不该默认把他要的东西关掉 ✗）。
	 * 这是给手机省电、或者看久了晕的人留的刹车 ✓。
	 */
	const backgroundMotion = stored.backgroundMotion === false ? false : true
	/*
	 * 🔴 4.9.2：**动图的静止兜底** ✓（用户 2026-10-15：「一刷新动图就不见了」「每次都要好久」✓）。
	 * 背景是视频时，把同一张图的静止版也告诉手机 ✓ —— 手机**先铺静止版（144KB，秒出 ✓）**、
	 * 视频能播了再换上 ✓；视频万一挂了（弱网 / 缓存读到半截 / 解码失败 ✓）
	 * 也**绝不会变成"没有背景"** ✗ —— 这正是用户遇到的"刷新就不见了" ✓。
	 */
	const backgroundStill = typeof stored.backgroundStill === 'string' && /^[^\\/]{1,120}$/.test(stored.backgroundStill)
		? stored.backgroundStill
		: ''
	// 视频抽帧用的 ffmpeg/ffprobe：默认去 ~/.dsh/bin 找、再退回 PATH；这里可以写死具体路径。
	// 和 crashProbe 一样必须原样带回去，否则下次配置重写会把它抹掉。
	const ffmpegPath = typeof stored.ffmpegPath === 'string' && stored.ffmpegPath.length <= 400
		? stored.ffmpegPath
		: ''
	const ffprobePath = typeof stored.ffprobePath === 'string' && stored.ffprobePath.length <= 400
		? stored.ffprobePath
		: ''
	// 语音转文字：asrKey 留空时自动复用生图插件那份智谱 key（同一个平台，用户已经填过）。
	// asrBaseUrl 可改（自建代理/测试桩）；asrMaxMinutes 是"多长就不转"的省钱闸。
	const asrKey = typeof stored.asrKey === 'string' && stored.asrKey.length <= 400 ? stored.asrKey : ''
	const asrBaseUrl = typeof stored.asrBaseUrl === 'string' && stored.asrBaseUrl.length <= 400 ? stored.asrBaseUrl : ''
	const asrModel = typeof stored.asrModel === 'string' && stored.asrModel.length <= 100 ? stored.asrModel : ''
	// 上限必须和 ASR_MAX_MINUTES 一致（2026-10-09 修：以前这里写死 120，而真正生效的上限
	// 和文档都是 180 —— 用户写 150 会被**静默丢弃**、回落成 180，配置还会被重写抹掉那一行）。
	const asrMaxMinutes = Number.isFinite(stored.asrMaxMinutes) && stored.asrMaxMinutes >= 1 && stored.asrMaxMinutes <= ASR_MAX_MINUTES
		? stored.asrMaxMinutes
		: 0
	// 2.7.0：两个**安全开关**（默认都关 ✓）—— 结束进程 / 关机重启。
	// 判据与四道闸写在 lib/system.js 与 lib/power.js 开头 ✓。
	const processControl = stored.processControl === true
	const powerControl = stored.powerControl === true
	/*
	 * 4.5.0「手机上控制电脑」✓（用户 2026-10-14 点名要的七件事 ✓）—— **默认关** ✗，
	 * 同 `processControl` / `powerControl` 一条纪律 ✓：手机上能让电脑"动手"的东西，
	 * 默认一律关着 ✓、要用户自己写进配置 ✓、而且**关掉立刻生效** ✓（路由里现读文件 ✓）。
	 * 只读的那几样（电量 / 联网 ✓）也要这个开关打开才给看 ✓ —— 它们是"这台电脑的状态" ✓，
	 * 不该在用户没点头的时候被手机端读走 ✓。
	 */
	const pcControl = stored.pcControl === true
	/*
	 * 3.5.0「语音优先」的总开关 ✓ —— **默认关** ✗（它开的是**麦克风** ✓，按项目铁律走 ✓）。
	 * 开的时候还要**现输 PIN** ✓（见 `/api/voice` 的 start ✓），并且有**空闲超时** ✓
	 *（手机上看得到倒计时 ✓ —— 不许"开着麦克风没人知道" ✗）。
	 */
	const voiceMode = stored.voiceMode === true
	const config = {
		version: 1,
		port,
		pin,
		...(phoneHost === '' ? {} : { phoneHost }),
		...(publicUrl === '' ? {} : { publicUrl }),
		pathSecret,
		tokenTtlHours,
		bindTokenToIp,
		// 3.0.0 ★④：安全开关，**默认关** ✓（和 processControl / powerControl 同一条纪律 ✓）。
		...(deviceApproval ? { deviceApproval: true } : {}),
		elevationMinutes,
		...(crashProbe ? { crashProbe: true } : {}),
		...(answerOnPhone ? { answerOnPhone: true } : {}),
		// 2.7.0 ★3/★4：两个**安全开关**（默认都关 ✓）。改了立刻生效（路由里现读文件 ✓）。
		...(processControl ? { processControl: true } : {}),
		...(powerControl ? { powerControl: true } : {}),
		// 4.5.0：手机上控制电脑（静音 / 音量 / 亮度 / 蓝牙开关 ✓）—— 同一条纪律：**默认关** ✓、现读 ✓。
		...(pcControl ? { pcControl: true } : {}),
		// 3.5.0：语音优先的总开关（默认关 ✓，开了才允许"一直听着麦克风" ✓）。
		...(voiceMode ? { voiceMode: true } : {}),
		...(backgroundFile === '' ? {} : { backgroundFile }),
		// 4.7.0：自带背景预设（赛博朋克 ✓）—— 和 backgroundFile 二选一 ✓，同一个字段口径 ✓。
		...(backgroundPreset === '' ? {} : { backgroundPreset }),
		// 4.8.0：动 / 静（缺省是动 ✓ —— 只有明确关掉才写进配置 ✓）。
		...(backgroundMotion === false ? { backgroundMotion: false } : {}),
		// 4.9.2：动图的静止兜底（视频挂了就顶它 ✓）。
		...(backgroundStill === '' ? {} : { backgroundStill }),
		...(ffmpegPath === '' ? {} : { ffmpegPath }),
		...(ffprobePath === '' ? {} : { ffprobePath }),
		...(asrKey === '' ? {} : { asrKey }),
		...(asrBaseUrl === '' ? {} : { asrBaseUrl }),
		...(asrModel === '' ? {} : { asrModel }),
		...(asrMaxMinutes === 0 ? {} : { asrMaxMinutes }),
	}

	/*
	 * 写完已知字段后，把**用户自己加的键**原样带回去 ✓。
	 *
	 * 这个函数有一张白名单，每次重写配置文件都会把不在名单里的键**静默抹掉** ✗ ——
	 * `asrMaxMinutes` 就这么丢过一次（见上面那段注释 ✓），2026-10-11 加 `processControl`
	 * 时又差点重演 ✓。所以这里不再靠"记得往名单里加"：**凡是不认识的键一律保留** ✓。
	 */
	let preserved = 0
	const known = new Set(Object.keys(config))
	for (const [key, value] of Object.entries(stored)) {
		if (known.has(key) === false) { config[key] = value; preserved += 1 }
	}

	if (preserved > 0
		|| stored.port !== port || stored.pin !== pin || (stored.publicUrl ?? '') !== publicUrl
		|| (stored.pathSecret ?? '') !== pathSecret || (stored.tokenTtlHours ?? 0) !== tokenTtlHours
		|| stored.bindTokenToIp !== bindTokenToIp || (stored.elevationMinutes ?? 0) !== elevationMinutes
		|| (stored.backgroundFile ?? '') !== backgroundFile || (stored.backgroundPreset ?? '') !== backgroundPreset
		|| (stored.backgroundMotion === false) !== (backgroundMotion === false) || (stored.ffmpegPath ?? '') !== ffmpegPath
		|| (stored.ffprobePath ?? '') !== ffprobePath || (stored.asrKey ?? '') !== asrKey
		|| (stored.asrBaseUrl ?? '') !== asrBaseUrl || (stored.asrModel ?? '') !== asrModel
		|| (stored.asrMaxMinutes ?? 0) !== asrMaxMinutes
		|| (stored.processControl === true) !== processControl
		|| (stored.powerControl === true) !== powerControl
		|| (stored.pcControl === true) !== pcControl) {
		await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
	}
	return { config, file }
}

/** The random segment every route sits behind, as a `/xxxx/` suffix. */
function secretSuffix(config) {
	const secret = typeof config?.pathSecret === 'string' ? config.pathSecret : ''
	return secret === '' ? '/' : `/${secret}/`
}

/**
 * Join a `http://host:port/` base with the secret segment.
 *
 * **幂等**：`publicUrl` 这个配置项是脚本/人工都会去写的（`tunnel-start.ps1` 写裸地址 ✓，
 * 但 2.7.0 的 `boot-up.ps1` 一开始写成了带密钥段的完整地址 ✗）—— 不判一下就会变成
 * `…/<secret>/<secret>/`：徽标显示错、隧道自检探的是错地址、手机拿到的"切到当前地址"
 * 直接打不开 ✗，而且**只会在手机上一用就撞上**（"上下游"检查抓到的真 bug ✓）。
 */
function withSecret(config, base) {
	const trimmed = String(base).replace(/\/+$/, '')
	const suffix = secretSuffix(config)          // '/<secret>/'，没有密钥时是 '/'
	const bare = suffix.replace(/\/$/, '')       // '/<secret>'，没有密钥时是 ''
	if (bare !== '' && trimmed.endsWith(bare) === true) return trimmed + '/'
	return trimmed + suffix
}

/**
 * 🔴 5.0.3：**从本机验"外网入口"**（用户 2026-10-19：「连了几秒后跳转连不上电脑页面」✓）。
 *
 * 现场（真实 ✓）：WiFi 漫游 / 换 IP 之后，Tailscale Funnel 的 **ingress → 本机** 那段卡死了 ✗ ——
 * 公网入口 IP 的 TCP 能连、**TLS 握手被 reset** ✓；而本机直连 tailnet IP `100.x:443` 一切正常 ✓。
 * 可桥原来的自检是**从本机 fetch `publicUrl`** ✓ —— 本机 `*.ts.net` 走 **MagicDNS**，
 * 解析成 `100.x`（tailnet IP）✗ → **绕过了 Funnel 的 ingress** ✓ →
 * 于是它一直报「外网可达 ✓」，而手机根本连不上 ✗✗（假绿 ✓）。
 *
 * 现在两条路分开 ✓：
 *   · 本机解析到的是**公网地址** → 照旧 fetch（那就是真外网路径 ✓）；
 *   · 本机解析到的是 **Tailscale 网段（100.64/10 / fd7a:115c:a1e0::/48）** → 说明只是 MagicDNS 抄近路 ✓，
 *     改用**公网 DNS（DoH）**查出真正的 ingress IP ✓，再**强制连那个 IP**、SNI/Host 仍写域名 ✓
 *     （`curl --resolve` 的等价物 ✓）—— 探的就是"外网进来那一段" ✓。
 *   · 公网 DNS 也不通 → 状态记为 `unverifiable` ✓，**不许报"可达"** ✗（宁可说"没法验证" ✓）。
 */
const isTailnetAddress = (address) => {
	const text = String(address ?? '')
	if (text.startsWith('fd7a:115c:a1e0:') === true) return true
	const match = /^(\d+)\.(\d+)\./.exec(text)
	return match !== null && Number(match[1]) === 100 && Number(match[2]) >= 64 && Number(match[2]) <= 127
}

/** 公网 DoH（JSON 版 ✓ —— 国内可达的两家 ✓；Cloudflare 在这台机器上不通 ✗，不列）。 */
const PUBLIC_DOH = [
	(name, type) => `https://223.5.5.5/resolve?name=${encodeURIComponent(name)}&type=${type}`,
	(name, type) => `https://doh.pub/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
]

/** 用公网 DNS 解析（**不走**本机 MagicDNS ✓）——拿 Funnel 真正的 ingress IP ✓。 */
async function resolvePublicAddresses(hostname) {
	const types = [['A', 1], ['AAAA', 28]]
	for (const build of PUBLIC_DOH) {
		const found = []
		for (const [type, code] of types) {
			try {
				const res = await fetch(build(hostname, type), {
					headers: { accept: 'application/dns-json' },
					signal: AbortSignal.timeout(4000),
				})
				if (res.ok !== true) continue
				const body = await res.json()
				for (const answer of Array.isArray(body?.Answer) ? body.Answer : []) {
					if (Number(answer?.type) === code && typeof answer?.data === 'string') found.push(answer.data)
				}
			} catch { /* 换下一家 / 下一种类型 ✓ */ }
		}
		if (found.length > 0) return [...new Set(found)]
	}
	return []
}

/** 本机 DNS 解析（带 1.5 秒上限 ✓ —— 测试里缺省域名解析慢时别把整套拖住 ✗）。 */
async function systemAddresses(hostname) {
	try {
		const rows = await Promise.race([
			dnsLookup(hostname, { all: true, verbatim: true }),
			new Promise((resolve) => setTimeout(() => resolve([]), 1500)),
		])
		return (Array.isArray(rows) ? rows : []).map((row) => String(row?.address ?? '')).filter((item) => item !== '')
	} catch { return [] }
}

/** 强制连某个 IP、SNI/Host 仍写域名（= `curl --resolve` ✓）——探"外网入口"时必须这样 ✓。 */
function probeExternalEntry({ hostname, address, port, path, timeoutMs = 8000 }) {
	return new Promise((resolve) => {
		let settled = false
		const finish = (ok, detail) => { if (settled === false) { settled = true; resolve({ ok, detail }) } }
		let req = null
		try {
			req = httpsRequest({
				host: address,
				port,
				path,
				method: 'GET',
				servername: hostname,
				rejectUnauthorized: true,
				headers: { host: port === 443 ? hostname : `${hostname}:${port}`, accept: 'application/json' },
				timeout: timeoutMs,
			}, (res) => {
				res.resume()
				finish(res.statusCode < 500, `HTTP ${res.statusCode}`)
			})
		} catch (error) {
			finish(false, String(error?.code ?? error?.message ?? error))
			return
		}
		req.on('timeout', () => { req.destroy(); finish(false, 'timeout') })
		req.on('error', (error) => finish(false, String(error?.code ?? error?.message ?? error)))
		req.end()
	})
}

/**
 * 🔴 5.0.1：**本机的局域网 IP 会变** ✓（用户 2026-10-19：「手机桥又登不上去了」✓）。
 *
 * 现场（真实时间线 ✓）：校园 WiFi 在 **20:12 漫游**（Netwtw06 7003）→ **20:15 DHCP 续租**，
 * 本机地址从 `113.54.216.122` 变成 `113.54.205.169` ✓；而手机上"加到主屏幕"的那个网址
 * 还写着旧 IP ✗ → 手机连过去的请求**一个都到不了桥** ✓（`mobile-bridge.log` 里之后一条都没有）。
 *
 * ⚠️ 这里**只判断、不改配置** ✗（第一版我自己写成"自动把 phoneHost 改成当前地址" ✓ → 当场栽了 ✓）：
 * `phoneHost` 的语义是「**手机上次真的从哪个地址连上来**」✓ —— 它可以是 USB 网段 / 热点网段，
 * 甚至现在不在网卡列表里 ✓（手机拔了线 ✓）。"不在当前网卡列表 ≠ 记错了" ✗，自动改写会
 * 把"Host 头学到的地址"顶掉 ✓（harness 的三条学习用例当场红 ✓）。
 * 所以这里只回答"记着的那个地址现在还属于这台机器吗" ✓ —— 调用方去**说清楚** ✓
 *（启动日志 / 徽标 / bootstrap 的 `phoneHostStale` ✓），由用户决定要不要换地址开 ✓。
 */
function phoneHostDrift(config) {
	const remembered = typeof config?.phoneHost === 'string' ? config.phoneHost : ''
	if (remembered === '') return null
	const addresses = lanAddresses(remembered)
	if (addresses.some((entry) => entry.address === remembered)) return null
	return { remembered }
}

/* --------------------------------------------------------------- addresses */

/**
 * Every non-loopback IPv4 a phone might reach, best candidate first. The
 * ordering rules live in `addresses.js`; this only supplies the live interfaces.
 */
function lanAddresses(preferred = '') {
	return collectAddresses(networkInterfaces(), preferred)
}

/* ------------------------------------------------------------------- auth */

function hashOf(value) {
	return createHash('sha256').update(String(value)).digest()
}

function sameSecret(left, right) {
	return timingSafeEqual(hashOf(left), hashOf(right))
}

function parseCookies(header) {
	const jar = {}
	for (const part of String(header ?? '').split(';')) {
		const index = part.indexOf('=')
		if (index < 0) continue
		jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
	}
	return jar
}

/** Loopback means the only possible caller is our own cloudflared. */
function isLoopbackPeer(peer) {
	return peer === '::1' || peer === '127.0.0.1' || peer === '::ffff:127.0.0.1'
}

/**
 * The address the login throttle counts against.
 *
 * Reading `x-forwarded-for` unconditionally hands the throttle key to the caller:
 * a fresh fake value per request is a fresh bucket, so a six-digit PIN can be
 * walked through without limit. Forwarded headers are therefore read only when
 * the socket peer is loopback (the request came through our own cloudflared),
 * and `cf-connecting-ip` wins there because the Cloudflare edge overwrites
 * whatever a client sends in it. A client-supplied `x-forwarded-for` entry
 * survives, so when that header is the only one present its LAST entry is the
 * one our own proxy added — never the first, which the caller controls.
 */
function clientIp(req) {
	const peer = req.socket.remoteAddress ?? 'unknown'
	if (!isLoopbackPeer(peer)) return peer
	const cf = req.headers['cf-connecting-ip']
	if (typeof cf === 'string' && cf.trim() !== '') return cf.trim()
	const forwarded = req.headers['x-forwarded-for']
	if (typeof forwarded === 'string' && forwarded.trim() !== '') {
		const parts = forwarded.split(',').map((part) => part.trim()).filter((part) => part !== '')
		if (parts.length > 0) return parts[parts.length - 1]
	}
	return peer
}

/**
 * 设备线索（2.8.0 ★2 的登录审计要"哪台设备" ✓）。
 *
 * 只留前 120 字：审计要的是"同一台手机每次看起来一样"✓，不是把整串 UA 存下来 ✗。
 * User-Agent 是**客户端自己写的** ✗ —— 所以它只当线索，绝不当证据（真正的凭据是 PIN ✓）。
 */
function userAgentOf(req) {
	return String(req?.headers?.['user-agent'] ?? '').slice(0, 120)
}

/**
 * 「开始使用」说明页的内容版本。
 *
 * 为什么要有版本号：这份说明只在**第一次连上**时自动讲一遍，之后就不再打扰 —— 但
 * 说明的**内容**是会改的（新增了哪些按键、生图要注意什么）。改版后如果还按"这台设备
 * 看过"一刀切，老用户永远看不到新内容，只能自己想起来点「说明」。
 * 所以：内容一改就 +1，服务端按设备记"看过的是第几版"，版本落后就再讲一遍。
 */
const WELCOME_VERSION = 28
/*
 * 4.1.0：**本版版本号读真值** ✓（`package.json` 的 version ✓）—— 分享出去的那份安装文案里要写版本 ✓，
 * 手写就会漂 ✗（本项目已经栽过好几次「文档里的数字和实测不一致」✓）。读不到就退回一个明确的值 ✓，
 * **绝不编一个看起来对的版本号** ✗。
 */
const PLUGIN_VERSION = (() => {
	try {
		const raw = readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
		const parsed = JSON.parse(raw)
		return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : 'unknown'
	} catch { return 'unknown' }
})()

/**
 * 把存下来的"看过"记录换算成版本号。
 *
 * 兼容老数据：v1 时代存的是**毫秒时间戳**（形如 1792078785000），直接当版本号会变成
 * 一个远大于 WELCOME_VERSION 的数 → 新版说明再也不弹。所以明显是时间戳的一律算第 1 版。
 */
function welcomedVersion(stored) {
	const value = Number(stored)
	if (!Number.isFinite(value)) return 0
	return value > 1e6 ? 1 : value
}

/**
 * 读这台手机的设备标识；没有就**现发一个**（写进 set-cookie）。
 *
 * 只认 cookie，不看 IP：IP 在隧道后面是所有手机共用的（见 DEVICE_COOKIE 的注释）。
 * 拿不到/被禁用 cookie 时每次都会是新标识 —— 页面自己的 localStorage 标记还兜一层，
 * 最坏情况是"说明页多弹一次"，比"新人永远看不到说明"好得多。
 */
function deviceId(req, res) {
	const found = parseCookies(req.headers.cookie)[DEVICE_COOKIE]
	if (typeof found === 'string' && found !== '') return found
	const fresh = randomUUID()
	if (res !== undefined && res !== null && typeof res.setHeader === 'function') {
		// 400 天，跟"这台设备"同寿。Secure 不能写死：这页面同时跑在明文 HTTP 的
		// 局域网/热点上，加了 Secure 就被丢掉（和登录 cookie 同一个理由）。
		const cookie = `${DEVICE_COOKIE}=${fresh}; SameSite=Lax; Path=/; Max-Age=${400 * 24 * 60 * 60}`
		const existing = res.getHeader('set-cookie')
		if (existing === undefined) res.setHeader('set-cookie', cookie)
		else if (Array.isArray(existing)) res.setHeader('set-cookie', existing.concat(cookie))
		else res.setHeader('set-cookie', [existing, cookie])
	}
	return fresh
}

/* -------------------------------------------------------------- http utils */

/**
 * Headers every response carries. `referrer-policy: no-referrer` matters more than
 * it looks: the random path segment lives in the URL, so any outbound navigation or
 * subresource would otherwise hand that segment to a third party in Referer.
 */
const SECURITY_HEADERS = {
	'cache-control': 'no-store',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'x-frame-options': 'DENY',
}

function sendJson(res, status, value) {
	const raw = Buffer.from(JSON.stringify(value), 'utf8')
	// 会话快照动辄两百多 KB，手机上（5G + 隧道）每次都要真传一遍 —— gzip 之后只剩
	// 十分之一左右。小响应不压（省那点字节不如省一次 CPU + 免得多一层）。
	if (res.gzipOk === true && raw.length >= 1024) {
		const packed = gzipSync(raw)
		res.writeHead(status, {
			...SECURITY_HEADERS,
			'content-type': 'application/json; charset=utf-8',
			'content-encoding': 'gzip',
			'content-length': packed.length,
		})
		res.end(packed)
		return
	}
	res.writeHead(status, {
		...SECURITY_HEADERS,
		'content-type': 'application/json; charset=utf-8',
		'content-length': raw.length,
	})
	res.end(raw)
}

async function readBody(req, limit = MAX_BODY_BYTES) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > limit) throw new Error('payload too large')
		chunks.push(chunk)
	}
	if (chunks.length === 0) return {}
	const text = Buffer.concat(chunks).toString('utf8')
	if (text.trim() === '') return {}
	return JSON.parse(text)
}

/* ---------------------------------------------------------------- balance */

/**
 * Credential resolution mirrors the balance badge plugin on purpose: the same
 * layered store, the same ref, so a key installed once serves both. The key is
 * read, used for one upstream call and never returned over the wire.
 */
function credentialFileCandidates() {
	const candidates = []
	/*
	 * ⚠️ 4.3.0：用**定死的** `bridgeHome` ✓，不再现读 env ✗ —— 同一条纪律（一个实例一个数据目录 ✓）。
	 * 差别只在"进程中途有人换了 DSH_HOME"这一种情形 ✓：现读会去新目录找钥匙 ✗（原来那把还在旧目录 ✓）。
	 */
	candidates.push(join(bridgeHome, '.credentials.yaml'))
	const profile = process.env.USERPROFILE ?? process.env.HOME
	if (typeof profile === 'string' && profile.length > 0) candidates.push(join(profile, '.dsh', '.credentials.yaml'))
	return candidates
}

/** Read `DEEPSEEK_API_KEY` out of one YAML refs section without a YAML parser. */
function readKeyFromFile() {
	for (const file of credentialFileCandidates()) {
		let text
		try {
			text = readFileSync(file, 'utf8')
		} catch {
			continue
		}
		const match = text.match(new RegExp(`(?:^|\\n)\\s*${CRED_REF}\\s*:\\s*([^\\r\\n#]+)`))
		if (match === null) continue
		const value = match[1].trim().replace(/^['"]|['"]$/g, '').trim()
		if (value.length > 0) return { value, source: 'file' }
	}
	return { value: '', source: 'unavailable' }
}

/** Prefer the credential service; fall back to the layered file. */
async function resolveApiKey(ctx) {
	const credentials = ctx.get('credentials')
	if (credentials !== undefined && typeof credentials.resolve === 'function') {
		try {
			const resolved = await credentials.resolve(CRED_REF)
			if (resolved !== null && typeof resolved === 'object' && typeof resolved.value === 'string') {
				const value = resolved.value.trim()
				if (value.length > 0) return { value, source: String(resolved.source ?? 'credentials') }
			}
		} catch {
			// A failing service must not hide a perfectly good stored key.
		}
	}
	return readKeyFromFile()
}

function toBalanceEntry(entry) {
	if (entry === null || typeof entry !== 'object') return null
	const total = Number(entry.total_balance)
	if (!Number.isFinite(total)) return null
	return {
		currency: typeof entry.currency === 'string' ? entry.currency : 'CNY',
		total,
		totalText: typeof entry.total_balance === 'string' ? entry.total_balance : String(total),
		granted: Number(entry.granted_balance),
		toppedUp: Number(entry.topped_up_balance),
	}
}

async function queryBalance(key) {
	let lastError = '上游不可达'
	for (const url of BALANCE_URLS) {
		let response
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
				signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
			})
		} catch (error) {
			lastError = String(error?.message ?? error)
			continue
		}
		if (response.status === 401 || response.status === 403) {
			return { ok: false, reason: 'auth', message: `API Key 被拒绝（HTTP ${response.status}）` }
		}
		if (!response.ok) {
			lastError = `HTTP ${response.status}`
			continue
		}
		let data
		try {
			data = await response.json()
		} catch {
			lastError = '响应不是合法 JSON'
			continue
		}
		const entries = Array.isArray(data?.balance_infos) ? data.balance_infos : []
		const balances = entries.map(toBalanceEntry).filter((entry) => entry !== null)
		if (balances.length === 0) return { ok: false, reason: 'shape', message: '接口未返回余额条目' }
		return { ok: true, isAvailable: data.is_available === true, balances, at: Date.now() }
	}
	return { ok: false, reason: 'network', message: lastError }
}

/* ------------------------------------------------------- 手机上传的文件 */

/**
 * 手机上传的文件名：只留基名、去掉路径分隔符与控制字符。
 * 这个名字会直接进磁盘路径，所以绝不能让它有机会跳出上传目录。
 */
function safeUploadName(raw) {
	const base = String(raw ?? '').split(/[\\/]/).pop() ?? ''
	const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim()
	const name = cleaned === '' ? 'file' : cleaned
	return name.length > 80 ? `${name.slice(0, 60)}${name.slice(-16)}` : name
}

function uploadsDir() {
	return join(dshHome(), UPLOAD_DIR)
}

/**
 * 🔴 4.10.0：**带素材的预设**放哪儿 ✓ —— 和上传目录**平级**（`~/.dsh/mobile-bridge-presets/<名字>/` ✓）。
 * ⚠️ 为什么不放进插件包 ✗：素材是**用户自己的东西** ✓（他那支星球视频 ✓），
 * 进包就等于跟着 Release 发给所有人 ✗ —— 那是侵权 ✓。放他本机 ✓，插件里只留代码 ✓。
 */
function presetDir(preset) {
	return join(dshHome(), 'mobile-bridge-presets', safeUploadName(String(preset ?? '')))
}


/** 把 base64 落到 ~/.dsh/mobile-uploads/，返回原始名、类型和磁盘绝对路径。 */
async function saveUpload({ name, mediaType, data }) {
	const dir = uploadsDir()
	await mkdir(dir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
	const target = join(dir, `${stamp}-${randomBytes(2).toString('hex')}-${safeUploadName(name)}`)
	await writeFile(target, Buffer.from(String(data ?? ''), 'base64'))
	return { name: safeUploadName(name), mediaType: String(mediaType ?? ''), path: target }
}

/**
 * 写进任务里的一段说明。模型看不了视频，但 agent 有工具 —— 把"文件在哪、是什么、
 * 能拿它干什么"说清楚，比丢一个看不懂的附件有用得多。
 */
function describeSavedFiles(files) {
	if (!Array.isArray(files) || files.length === 0) return ''
	const lines = files.map((entry) =>
		`- ${entry.name}${entry.mediaType === '' ? '' : `（${entry.mediaType}）`} → ${entry.path}`)
	return [
		'【手机上传的文件】用户从手机发来了下面这些文件，已经存在这台电脑上：',
		...lines,
		'图片之外的内容我没法直接看，请用工具打开/处理（视频可以用 ffmpeg 抽帧或转码）。',
	].join('\n')
}

/**
 * 只认自己上传目录里的文件：手机可以随便传内容，但不能借这条接口读电脑上任意路径。
 * （真路径解析过，`..` 逃不出去。）
 */
function safeUploadRef(candidate) {
	const raw = String(candidate ?? '')
	if (raw === '') return null
	const dir = uploadsDir()
	const resolved = resolve(raw)
	if (resolved !== dir && resolved.startsWith(dir + sep) === false) return null
	return resolved
}

/* ------------------------------------------------------------- the bridge */

function createBridge(ctx) {
	const state = {
		server: null,
		listening: false,
		config: null,
		configFile: '',
		tokensFile: '',
		accessLog: '',
		/** 运行期记账：见 record()/trimAccessLog()，估算值够用（不是精确字节数）。 */
		accessLogBytes: 0,
		accessLogTrimming: false,
		sessions: new Map(),
		attempts: new Map(),
		recentFailures: [],
		// token -> 提权到期时间。与 sessions 分开，读历史不需要它。
		elevated: new Map(),
		// 令牌被从别的地址使用的记录，用于事后追查。
		foreignUses: [],
		/**
		 * 2.8.0 ★2：最近一次**陌生设备登录成功**（`{ip, at}`）—— 桌面角标据此报警 ✓。
		 * 只在"以前有过成功登录、这个地址没见过"时才置上 ✓（第一次装机不算陌生 ✓，见 auditLogin）。
		 */
		newDevice: null,
		streams: new Set(),
		/**
		 * 用 `{kind:'session'}` 地址跟不了的会话（agent 自己派生的子会话）。
		 * 第一次跟随失败时记下来：从列表里拿掉，免得用户一次次选中一个打不开的会话，
		 * 每三秒重连一次，还看到一个"和电脑断开了"的红字（其实连接好得很）。
		 */
		unfollowable: new Set(),
		/** 会话列表里见过的 cwd：`/api/file` 用它判断"这个路径能不能发给手机"。 */
		sessionCwds: new Set(),
		/** 会话列表的短命缓存（5 秒）：手机一次打开会连着要两份，重连时更是一串。 */
		sessionListCache: null,
		/**
		 * 已经看过"开始使用"说明页的手机：来源地址 -> 时间。
		 *
		 * 为什么要在服务端再记一份：页面用 localStorage 记，但换地址（Funnel ↔ 局域网
		 * 是不同 origin，各存各的）、无痕浏览、或者手机清了站点数据之后标记就没了 ——
		 * 表现就是"每次进来都弹一遍说明页"。这份跟着令牌文件落盘，重载/重启也在。
		 */
		welcomed: new Map(),
		/**
		 * 3.4.1：**按设备**记住"已放行" ✓ —— deviceKey(哈希) -> { at, ip, ua }。
		 *
		 * 为什么非改不可 ✗（用户 2026-10-13 亲口："又被你挡在外面了，不要再挡了"✓）：
		 * 原来只有一个**全局**标记 `everApproved` ✓，判据是"曾经放行过任何设备"✓ →
		 * **放行过一台之后，之后每一次重新登录都会被判成"新设备"要再点头** ✗
		 * （换 IP 也一样 ✗：iPhone 的 IPv6 前缀会变 ✓；token 12 小时过期后必然重登 ✓）
		 * —— 也就是**主人自己天天被挡** ✗✗，而 deviceApproval 的本意只是"**陌生设备**要点头"✓。
		 * 现在：设备的**稳定指纹**（页面自己的 `dshm_device` ✓，见 `mobile.html`）过了哈希存一份 ✓，
		 * 同一台设备再登录（哪怕换了地址 ✓）**直接放行** ✓；**没见过的设备**照样要点头 ✓。
		 * 跟着令牌文件落盘 ✓（重载/重启不丢 ✓）。
		 */
		devices: new Map(),
		/**
		 * 3.5.0「语音优先」：麦克风那扇门的**开多久** ✓（`{ until, startedAt, by }` ✓）。
		 * 只在内存里 ✓（重启即关 ✓ —— 更安全的方向 ✓）；默认 `until: 0` = 关着 ✓。
		 */
		voice: { until: 0, startedAt: 0, by: '' },
		/**
		 * 正在等手机回答的提问/审批：id -> { kind, sessionId, settle, timer, signal }。
		 * agent 调 ask_user_question、或某个工具需要批准时，waterfall 会在这里挂起，
		 * 手机点完才放行；手机不理就超时交给桌面。
		 */
		pending: new Map(),
		/** 已排定的关机/重启（2.7.0 ★4）：{ kind, at, seconds } —— 手机上据此显示「取消」✓。 */
		power: null,
		/** Last time each peer was recorded, so a retry storm cannot flood the log. */
		peers: new Map(),
		/**
		 * 外网隧道的可达性（由角标那 120 秒一次的探测维护 ✓；`at` = 上次探测时间 ✓）。
		 *
		 * ⚠️ 必须放在**这里**（共享状态）✗ 不能是 `installBadge` 的局部变量：
		 * 2026-10-12 真机抓到 —— `/api/selfcheck` 里直接读了 `tunnel`（那是个只在
		 * `installBadge` 里存在的名字 ✗），**配了 publicUrl 的机器**（用户这台就是 ✓）
		 * 一请求就 ReferenceError → 整个自检接口 500 ✓。harness 当时没配 publicUrl，
		 * 那条分支根本没被求值 ✓，所以 15 条自检断言全绿也照样漏到线上 ✗。
		 *
		 * `ok` 是**三态**：`null` = 还没探过 ✓（冷视角复查抓到的第二个洞：初值原来写 `true`，
		 * 于是"没测过"被说成"外网可达 ✓" —— 正是"绝不假装"要挡的那种 ✗）。
		 */
		tunnel: { ok: null, fails: 0, at: 0, probedUrl: '', probe: null },
		/** One upstream balance call per minute, shared by every phone. */
		balance: { at: 0, value: null, inflight: null },
		/** Hash of the served page, so a stale client can reload itself. */
		pageTag: '',
		page: '',
		/** gzip 过的同一份页面：手机上首屏小一个量级。null = 不压缩。 */
		pageGzip: null,
		/** 整页强 ETag（渲染后的内容哈希）—— 浏览器据此走 304，不用重下 ✓。 */
		pageEtag: '',
	}

	const log = (message) => console.log(`[mobile-bridge] ${message}`)
	const warn = (message) => console.error(`[mobile-bridge] ${message}`)

	/**
	 * Durable evidence of who actually reached this listener. When the phone
	 * cannot connect, this file answers the only question that matters: did the
	 * packets arrive at all? Nothing here means the network never delivered
	 * them (client isolation, wrong subnet, firewall); a connection line means
	 * the network is fine and the problem is above it.
	 */
	function record(line) {
		/*
		 * 复查（第 83 轮）🔴 R1：`state.accessLog` 要等 `start()` 里那一句才设 ✓ —— 在那之前 `record()`
		 * 是**空操作** ✗ → "启动早期那几行"被**静默丢掉** ✗（最该留下的那种话反而看不见 ✗）。
		 * 现在：没设就按**默认路径现算一份** ✓（路径与 `start()` 里那句一致 ✓），不再静默丢 ✓。
		 */
		if (state.accessLog === '') state.accessLog = join(dshHome(), ACCESS_LOG)
		/*
		 * 运行期也要限长（2026-10-09 修）：以前只在 start() 判一次文件大小，于是运行期
		 * 谁都拦不住它长 —— 未授权探测（鉴权之前就记一行）和 clientlog（只要 cookie，
		 * 单次能写三百来字）都能把 mobile-bridge.log 撑成无限大。
		 *
		 * 超了就**只留最近的半截**（不是删掉整个文件）：用户报障时要的正是最近那几行。
		 */
		state.accessLogBytes += line.length + 30
		if (state.accessLogBytes > ACCESS_LOG_LIMIT) { void trimAccessLog(); return }
		void appendFile(state.accessLog, `[${new Date().toISOString()}] ${line}\n`, 'utf8').catch(() => {})
	}

	/** 把访问日志截到最近一半（同一时刻只允许一个截断在跑）。 */
	async function trimAccessLog() {
		if (state.accessLogTrimming) return
		state.accessLogTrimming = true
		try {
			const text = await readFile(state.accessLog, 'utf8').catch(() => '')
			const tail = text.slice(-Math.floor(ACCESS_LOG_LIMIT / 2))
			await writeFile(state.accessLog, `[${new Date().toISOString()}] trimmed (kept the newest half)\n${tail}`, 'utf8')
			state.accessLogBytes = tail.length
		} catch { /* 截断失败就让它继续记，总比没有日志强 */ }
		finally { state.accessLogTrimming = false }
	}

	function notePeer(ip, what) {
		const now = Date.now()
		if ((state.peers.get(ip) ?? 0) > now - 60000) return
		state.peers.set(ip, now)
		record(`${what} from ${ip}`)
	}

	/**
	 * Learn the address a phone actually used. The Host header of an
	 * authenticated request names the local address that reached it — strictly
	 * better evidence than guessing which adapter is the USB link, and the only
	 * signal available at all on a network where the phone cannot be probed.
	 */
	/**
	 * 这个地址值不值得记成「手机是从这儿连进来的」✓ ——
	 * 只认**私网段**（10./172.16-31./192.168.）与 **Tailscale 100.64/10** ✓；
	 * 公网地址一律不记 ✗（记了就会在二维码里给一个明文、且迟早失效的地址 ✗）。
	 */
	function isRememberableHost(host) {
		const octets = host.split('.').map(Number)
		if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
		const [a, b] = octets
		if (a === 10) return true                                  // 10.0.0.0/8
		if (a === 172 && b >= 16 && b <= 31) return true           // 172.16.0.0/12
		if (a === 192 && b === 168) return true                    // 192.168.0.0/16
		if (a === 100 && b >= 64 && b <= 127) return true          // Tailscale 100.64.0.0/10
		return false
	}

	function rememberHost(req) {
		const raw = String(req.headers.host ?? '')
		const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0]
		if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('127.')) return
		// 🔴 2026-10-17：**只记私网/Tailscale 的地址** ✓ —— 注释说这里是 "the local address" ✓，
		// 可原来的检查只排除 127. ✗ → 从公网 http 连一次，**公网 IPv4 就被记成 phoneHost** ✗，
		// 于是二维码/徽标长期给一个「明文 + 会随宽带更换而失效」的地址 ✗。
		if (!isRememberableHost(host)) return
		if (state.config.phoneHost === host) return
		state.config.phoneHost = host
		void writeFile(state.configFile, `${JSON.stringify(state.config, null, 2)}\n`, 'utf8')
			.catch(() => { /* a read-only home must not break serving */ })
		record(`phone reached us on ${host}`)
	}

	/**
	 * 3.0.0 ★④：这个开关**现读配置文件** ✓（和 processControl / powerControl 一样 ✓）——
	 * 用户改完 `mobile-bridge.json` 不用重启就生效 ✓，测试也能中途打开它 ✓。
	 * ⚠️ 它必须放在**服务这一层**（`state` 在这儿 ✓）—— 第一版写在配置解析那段里 ✗，
	 * 于是 `issueToken` 根本看不到它 ✓，登录当场 500 ✓（harness 一眼逮住 ✓）。
	 */
	function deviceApprovalEnabled() {
		try {
			const fresh = JSON.parse(readFileSync(state.configFile, 'utf8'))
			return fresh?.deviceApproval === true
		} catch {
			// 读不到就沿用启动时那份 ✓（别因为文件半写就突然放宽 ✓）。
			return state.config?.deviceApproval === true
		}
	}

	function issueToken(ip, req) {
		const token = randomBytes(24).toString('base64url')
		const boundIp = String(ip ?? '')
		// One live session per address: signing in again retires the previous token
		// instead of stacking another one beside it. Re-entering the PIN used to add
		// a fresh session every time, which is how a dozen "phone logins" piled up.
		for (const [existing, record] of state.sessions) {
			if (record.ip === boundIp) {
				state.sessions.delete(existing)
				state.elevated.delete(existing)
			}
		}
		// Backstop, oldest first, so a stream of new addresses cannot grow the set.
		while (state.sessions.size >= MAX_LIVE_TOKENS) {
			const oldest = state.sessions.keys().next().value
			if (oldest === undefined) break
			state.sessions.delete(oldest)
			state.elevated.delete(oldest)
		}
		/*
		 * 3.0.0 ★④：这台新设备算"已放行"还是"等放行" ✓。
		 * ⚠️ **没有任何已放行过的设备时，直接放行** ✓✓ —— 全新安装（或用户**明确**"踢掉全部设备"）之后，
		 * 下一次登录永远进得来 ✓（不然"开了这个开关 + 清了 cookie"= 把自己关在门外 ✗）。
		 *
		 * ⚠️ 3.0.0 冷视角复查抓到：第一版这里看的是**当前还活着的会话** ✗ →
		 * 而本机 `tokenTtlHours` 是 12 小时 ✓ → 已放行设备的令牌一过期 ✓（`authed()` 会把过期会话删掉 ✓）
		 * → `alreadyTrusted` 变假 ✓ → **下一个拿 PIN 登进来的人自动放行** ✓✗ ——
		 * 也就是说"新设备要你点头"每天必然白给一段时间 ✓（复原告状：功能被自己的防锁死规则削掉了 ✓）。
		 * 现在改成**持久化的"曾经放行过"**（`state.everApproved` ✓ 跟着令牌文件落盘 ✓）：
		 * 令牌过期**不再**等于豁免 ✓；真正的全量重置只走一个**显式**动作 ——
		 * 「踢掉全部设备」（`/api/logins/revoke` 带 `all: true` ✓，见 handleRevokeDevices）✓。
		 */
		const alreadyTrusted = state.everApproved === true
		/*
		 * 3.4.1：**按设备**判"是不是自己人" ✓（上面 `devices` 那段注释写了为什么 ✗）。
		 * 三个来源，任一成立就算自己人 ✓：① 这台设备放过行 ✓（稳定指纹 ✓，换 IP 也算 ✓）；
		 * ② 这个**来源地址**上已有放行过的会话 ✓（旧行为，别回归 ✗）；
		 * ③ `everApproved`（"从没放行过任何设备"的首次/全清之后 ✓ —— 防锁死 ✓）。
		 * ⚠️ 顺序与含义要小心 ✗：`anyTrusted === false` 才走③；一旦有设备被信任过 ✓，
		 * **陌生设备就必须点头** ✓（这正是 deviceApproval 的意义 ✓）。
		 */
		const deviceKey = deviceKeyOf(req)
		const trustedByDevice = deviceKey !== '' && state.devices.has(deviceKey) === true
		const trustedByIp = [...state.sessions.values()].some((entry) => entry.approved === true && entry.ip === boundIp)
		const anyTrusted = state.devices.size > 0 || alreadyTrusted === true
		const approved = deviceApprovalEnabled() !== true
			|| trustedByDevice === true || trustedByIp === true || anyTrusted !== true
		if (approved === true) {
			state.everApproved = true
			// 放行即登记这台设备 ✓（下次换地址/换 token 都还认它 ✓）。
			if (deviceKey !== '') state.devices.set(deviceKey, { at: Date.now(), ip: boundIp, ua: shortDeviceLabel(req) })
			persistTokens()
		}
		state.sessions.set(token, {
			expiresAt: Date.now() + state.tokenTtlMs,
			ip: boundIp,
			approved,
			at: Date.now(),
			ua: shortDeviceLabel(req),
			...(deviceKey === '' ? {} : { device: deviceKey }),
		})
		state.elevated.set(token, Date.now() + state.elevationMs)
		persistTokens()
		if (approved !== true) record(`新设备在等放行（${boundIp}）—— 到电脑上打开 /approve 放行 ✓`)
		return token
	}

	/** 设备名：只留人类看得懂的一小段 ✓（完整 UA 又长又没用 ✓，但要去掉换行免得打乱日志 ✓）。 */
	function shortDeviceLabel(req) {
		const raw = typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : ''
		const clean = raw.replace(/\s+/g, ' ').trim()
		if (clean === '') return '未知设备'
		return clean.length > 60 ? clean.slice(0, 60) + '…' : clean
	}

	/**
	 * 3.4.1：设备的**稳定指纹** ✓ —— 页面在 `localStorage` 里生成、并写成 `dshm_device` cookie ✓
	 * （见 `mobile.html` ✓，它本来就在用：说明页的"看过"标记就是按它记的 ✓）。
	 * 为什么不用 IP ✗：iPhone 的 IPv6 前缀会变 ✓、换网络（家/公司/蜂窝）也变 ✓
	 * → 按 IP 记 = **主人自己每次都被当成新设备** ✗（用户 2026-10-13 的投诉 ✓）。
	 * 只存哈希 ✓（原值不落盘 ✓）；拿不到就给空串 ✓（退回旧行为 ✓，不回归 ✗）。
	 */
	function deviceKeyOf(req) {
		const raw = parseCookies(req.headers.cookie)['dshm_device']
		if (typeof raw !== 'string' || raw === '') return ''
		return createHash('sha256').update(raw).digest('hex').slice(0, 16)
	}

	/**
	 * 3.0.0 ★④：设备 id —— **绝不把令牌本身发给页面** ✗（那是能直接用的凭证 ✓），
	 * 只给一个短哈希 ✓（够用来"放行这一台"✓，拿到它什么也做不了 ✓）。
	 */
	function deviceIdOf(token) {
		return createHash('sha256').update(String(token)).digest('hex').slice(0, 12)
	}

	/** 等放行的设备清单 ✓（给电脑上的放行页用 ✓）。 */
	function pendingDevices() {
		const list = []
		for (const [token, record] of state.sessions) {
			if (record.approved !== false) continue
			if (record.expiresAt < Date.now()) continue
			list.push({ id: deviceIdOf(token), ip: String(record.ip ?? ''), ua: String(record.ua ?? ''), at: Number(record.at ?? 0) })
		}
		return list
	}

	/** 放行 / 拒绝一台设备 ✓。返回是否找到了那一台 ✓。 */
	function decideDevice(id, approve) {
		// ⚠️ 变量名**不能叫 record** ✗ —— 那会遮蔽同作用域的日志函数 `record()` ✓，
		// 于是 `record(...)` 变成"把对象当函数调"，当场 TypeError ✓（这个坑注释里记过一次 ✓）。
		for (const [token, deviceRecord] of state.sessions) {
			if (deviceIdOf(token) !== id) continue
			if (approve === true) {
				deviceRecord.approved = true
				// 放行成功也记进"曾经放行过" ✓（下次令牌过期不该把这条豁免重新打开 ✗）。
				state.everApproved = true
				// 3.4.1：**记的是这台设备** ✓ —— 它以后换地址/换 token 都直接放行 ✓（别再挡主人 ✗）。
				if (typeof deviceRecord.device === 'string' && deviceRecord.device !== '') {
					state.devices.set(deviceRecord.device, {
						at: Date.now(), ip: String(deviceRecord.ip ?? ''), ua: String(deviceRecord.ua ?? ''),
					})
				}
				persistTokens()
				record(`新设备已放行：${deviceRecord.ua ?? ''} / ${deviceRecord.ip ?? ''}`)
				return true
			}
			// 拒绝 = 直接把令牌作废 ✓（下次登录还是"等放行"✓，不是"永久拉黑"✗）。
			state.sessions.delete(token)
			state.elevated.delete(token)
			persistTokens()
			record(`新设备被拒绝：${deviceRecord.ua ?? ''} / ${deviceRecord.ip ?? ''}`)
			return true
		}
		return false
	}

	/** 3.4.1：令牌文件写的**串行化**开关 ✓（并发写会把文件写成两段 JSON ✗，见 `persistTokens` 里的注释 ✓）。 */
	let persistInFlight = false
	let persistAgain = false

	/**
	 * Tokens used to live only in this Map, so every `dsh web` restart dropped
	 * the phone back to the PIN gate. The file is the durable half; the Map
	 * stays authoritative so expiry and logout still revoke immediately.
	 */
	function persistTokens() {
		if (state.tokensFile === '') return
		/*
		 * ⚠️ 3.4.1：**必须串行** ✗ —— 3.4.1 之前这个方法只在登录/放行/登出这些**低频**路径上被调 ✓，
		 * 现在 `authed()` 里"第一次见到某台设备就登记"也会调它 ✓（请求是并发的：SSE 流 + 轮询 + 上传 ✓）
		 * → 两三个 `writeFile` 同时打同一个文件 ✗ → **文件被写成两段 JSON 拼在一起** ✓
		 * （harness 当场报 `Unexpected non-whitespace character after JSON at position 377` ✗，
		 * 而且接着的真实后果是"重启后全部手机掉线"✗✗）。
		 * 修法：**在飞就标记，写完再补一次** ✓（合并写、永远只有一个写者 ✓）。
		 */
		if (persistInFlight === true) { persistAgain = true; return }
		persistInFlight = true
		// `welcomed` 一起落盘：手机被清掉站点数据 / 换了地址（不同 origin 的
		// localStorage 是各存各的）/ 用的是无痕浏览时，页面自己的标记就没了 ——
		// 那会让"开始使用"说明页每次进来都弹一遍。服务端记一份就稳了。
		const payload = {
			version: 1,
			tokens: Object.fromEntries(state.sessions),
			welcomed: Object.fromEntries(state.welcomed),
			// 3.0.0 ★④：**"曾经放行过任何设备"** 要落盘 ✓ —— 只活一次的标记会让
			// "令牌一过期就自动放行"（见 issueToken 的注释 ✓）。
			...(state.everApproved === true ? { everApproved: true } : {}),
			// 3.4.1：**放行过的设备**也要落盘 ✓（否则重载一次就把"这台是自己人"忘了 ✗ →
			// 下一次登录又被挡 ✓ —— 正是用户今天的投诉 ✓）。
			...(state.devices.size > 0 ? { devices: Object.fromEntries(state.devices) } : {}),
		}
		void writeFile(state.tokensFile, `${JSON.stringify(payload)}\n`, 'utf8')
			.catch(() => {})
			.finally(() => {
				persistInFlight = false
				if (persistAgain === true) { persistAgain = false; persistTokens() }
			})
	}

	async function loadTokens() {
		state.tokensFile = join(dshHome(), TOKENS_FILE)
		let stored = null
		try {
			stored = JSON.parse(await readFile(state.tokensFile, 'utf8'))
		} catch (error) {
			/*
			 * ⚠️ 3.4.1：这里原来**默默 return** ✗ —— 于是"令牌文件写坏了"这件事
			 * 既没人知道 ✓（用户只会看到手机全掉线 ✓），也没人去修 ✓。
			 * 现在**记一行** ✓（读不到就说读不到 ✓）；文件会在下一次 `persistTokens()` 时被覆盖成好的 ✓。
			 */
			if (error?.code !== 'ENOENT') record(`令牌文件读不出来（${String(error?.code ?? error?.name ?? 'error')}）—— 已按"没有令牌"处理 ✓（下一次写盘会覆盖成好的 ✓）`)
			return
		}
		const now = Date.now()
		let live = 0
		for (const [token, record] of Object.entries(stored?.tokens ?? {})) {
			if (typeof token !== 'string' || token === '') continue
			// Older files stored a bare expiry number. Accept both shapes so an
			// upgrade does not silently log the phone out.
			const expiresAt = typeof record === 'number' ? record : Number(record?.expiresAt)
			if (!Number.isFinite(expiresAt) || expiresAt <= now) continue
			const ip = typeof record === 'object' && record !== null && typeof record.ip === 'string' ? record.ip : ''
			/*
			 * 3.0.0 ★④：**"等放行"这件事必须活过重启** ✗✗ ——
			 * 第一版这里只恢复 `expiresAt`/`ip` ✓，于是 `approved` 丢了 ✓ →
			 * 重启一次，等放行的设备就"自动被放行"了 ✓（谁会想到去等一次重启呢 ✓）。
			 * 判据：**显式写成 `false` 的才是等放行** ✓；老文件里没有这个字段 ✓ → 按已放行恢复 ✓
			 * （它们本来就是这功能之前签发的 ✓，不能因为升级就把人踢出去 ✗）。
			 */
			const approved = record?.approved === false ? false : true
			const ua = typeof record?.ua === 'string' ? record.ua : ''
			const at = Number(record?.at) > 0 ? Number(record.at) : 0
			state.sessions.set(token, { expiresAt, ip, approved, ...(ua === '' ? {} : { ua }), ...(at === 0 ? {} : { at }) })
			// A restored session is NOT elevated: after a restart the phone must prove
			// the PIN again before it can make this machine do anything.
			live += 1
		}
		if (live > 0) log(`restored ${live} phone session(s)`)
		// 3.0.0 ★④："曾经放行过"也一起恢复 ✓（丢了它 = 令牌一过期就自动放行所有人 ✗）。
		if (stored?.everApproved === true) state.everApproved = true
		// 3.4.1：**放行过的设备**一起恢复 ✓（这条是"主人不再被挡"的关键 ✓ ——
		// 丢了它，重载之后主人换地址再登录就又变成"新设备" ✗）。
		for (const [key, value] of Object.entries(stored?.devices ?? {})) {
			if (typeof key === 'string' && key !== '') {
				state.devices.set(key, {
					at: Number(value?.at) > 0 ? Number(value.at) : 0,
					ip: typeof value?.ip === 'string' ? value.ip : '',
					ua: typeof value?.ua === 'string' ? value.ua : '',
				})
			}
		}
		if (state.devices.size > 0) log(`restored ${state.devices.size} trusted device(s)`)
		// 已经看过"开始使用"的手机（按来源地址记）：页面自己的 localStorage 可能因为
		// 换地址/无痕/清数据而丢，服务端这份不会。
		for (const [key, at] of Object.entries(stored?.welcomed ?? {})) {
			if (typeof key === 'string' && key !== '' && Number.isFinite(Number(at))) {
				state.welcomed.set(key, Number(at))
			}
		}
	}

	function authed(req) {
		const token = parseCookies(req.headers.cookie)[COOKIE]
		if (typeof token !== 'string' || token === '') return false
		// 变量名不能叫 record —— 那会遮蔽同作用域里的日志函数 record()，
		// 于是这一行的 record(...) 变成"把对象当函数调用"，抛 TypeError。
		// 它只在【令牌被异地使用】这条路径上触发，所以平时看不出来，
		// 一旦手机换 IP 就当场把整个 DSH 进程打死。
		const tokenRecord = state.sessions.get(token)
		if (tokenRecord === undefined) return false
		// 3.0.0 ★④：**等放行的设备不算已登录** ✓ —— 它只能访问"我还在等"那一两条路 ✓。
		if (tokenRecord.approved === false) return false
		if (tokenRecord.expiresAt < Date.now()) {
			state.sessions.delete(token)
			state.elevated.delete(token)
			return false
		}
		/*
		 * 3.4.1：**已放行的会话一露面，就把它的设备登记下来** ✓ ——
		 * 用户手上这枚令牌本来就是放行过的 ✓（3.4.0 时代签发的 ✓）：升级之后它下一次请求
		 * 就把"这台是自己人"记上 ✓ → **下一次重登不会再被挡** ✓（不必等用户再手动放行一次 ✓）。
		 * 只在"新设备"时写一次盘 ✓（不是每个请求都写 ✗）。
		 */
		if (state.devices.has(deviceKeyOf(req)) !== true) {
			const key = deviceKeyOf(req)
			if (key !== '') {
				state.devices.set(key, { at: Date.now(), ip: clientIp(req), ua: shortDeviceLabel(req) })
				persistTokens()
			}
		}
		// A token seen from an address other than the one it was issued to.
		//
		// Revoking on every change sounds like the right control and is unusable in
		// practice: a phone rotates addresses constantly — carrier NAT, IPv6 privacy
		// extensions, IPv6/IPv4 fallback — and the phone that owns the token was being
		// logged out several times an hour. It surfaced as "the page is blank": the
		// stream 401'd before it ever delivered a transcript.
		//
		// So: always RECORD a move (visible in /api/bootstrap's `foreignUses` and in
		// the access log), and only REVOKE when strict binding is explicitly asked for.
		if (tokenRecord.ip !== '') {
			const seen = clientIp(req)
			if (seen !== tokenRecord.ip) {
				const issuedTo = tokenRecord.ip
				const known = state.foreignUses.some((entry) => entry.seen === seen && entry.issuedTo === issuedTo)
				if (!known) {
					state.foreignUses.push({ at: Date.now(), seen, issuedTo })
					if (state.foreignUses.length > 50) state.foreignUses.shift()
				}
				if (state.config?.bindTokenToIp === true) {
					record(`token issued to ${issuedTo} used from ${seen} -> revoked (strict ip binding)`)
					state.sessions.delete(token)
					state.elevated.delete(token)
					persistTokens()
					return false
				}
				// Warn-only: adopt the new address so each move is reported once.
				tokenRecord.ip = seen
				if (!known) record(`token issued to ${issuedTo} used from ${seen} -> allowed (warn-only)`)
			}
		}
		return true
	}

	/** 读过 cookie 还不够：让这台机器干活需要最近输过一次 PIN。 */
	function elevated(req) {
		const token = parseCookies(req.headers.cookie)[COOKIE]
		if (typeof token !== 'string' || token === '') return false
		const until = state.elevated.get(token)
		if (until === undefined) return false
		if (until < Date.now()) {
			state.elevated.delete(token)
			return false
		}
		return true
	}

	function throttleLogin(ip) {
		const now = Date.now()
		// Global window first. It is only READ here; entries are appended by
		// noteLoginFailure, so a successful login never counts against it.
		while (state.recentFailures.length > 0 && now - state.recentFailures[0] > LOGIN_WINDOW_MS) {
			state.recentFailures.shift()
		}
		if (state.recentFailures.length >= LOGIN_MAX_ATTEMPTS_GLOBAL) return false

		const entry = state.attempts.get(ip)
		if (entry === undefined || now - entry.startedAt > LOGIN_WINDOW_MS) {
			state.attempts.set(ip, { startedAt: now, count: 1 })
			return true
		}
		entry.count += 1
		return entry.count <= LOGIN_MAX_ATTEMPTS
	}

	/**
	 * Recorded only when a PIN is actually rejected.
	 *
	 * 2.8.0 ★2「安全审计」：除了计数（桌面角标据此显示"有人正在试 PIN" ✓），还**留一行账** ✓ ——
	 * "什么时候、从哪个地址、试的是哪一道 PIN" ✓。审计是**事后能查**的意思：
	 * 写不进去绝不许挡住原本的判断 ✗（`auditLogin` 自己吞掉异常 ✓）。
	 * 不传 detail 的调用方只计数、不落账 ✓ —— 宁可账上少一行，也不记一行假的 ✗。
	 */
	function noteLoginFailure(detail) {
		state.recentFailures.push(Date.now())
		if (detail === undefined || detail === null) return
		void auditLogin({
			ip: String(detail.ip ?? ''),
			ua: String(detail.ua ?? ''),
			ok: false,
			what: String(detail.what ?? 'pin'),
		})
	}

	/* ------------------------------------------------------------ sessions */

	/**
	 * 手机能不能把某个路径当媒体读走。
	 *
	 * 只认桥认识的目录：工作区（注册表里的那些）、每个会话自己的 cwd、~/.dsh（附件与
	 * 上传）、以及系统临时目录。加上"必须是图片/视频"，这条接口就不是任意文件读取。
	 */
	function isServablePath(path) {
		const roots = new Set()
		const registry = ctx.get('workspaceRegistry')
		if (registry !== undefined && typeof registry.list === 'function') {
			try {
				for (const workspace of registry.list()) {
					if (typeof workspace?.path === 'string' && workspace.path !== '') roots.add(resolve(workspace.path))
				}
			} catch { /* 注册表坏了不该让接口 500 */ }
		}
		for (const value of state.sessionCwds) roots.add(resolve(value))
		roots.add(resolve(dshHome()))
		roots.add(resolve(tmpdir()))
		for (const root of roots) {
			if (path === root || path.startsWith(root + sep)) return true
		}
		return false
	}

	/**
	 * 密钥类文件：**任何情况下都不通过手机发出去**（2026-10-10 加文档类型时补的洞）。
	 *
	 * 为什么必须单独列：`~/.dsh` 是允许目录之一 ✓，而 2.1.0 起 `.json` 算"文档"了 ✗ ——
	 * 于是 `mobile-bridge.json`（PIN 明文）、`.credentials.yaml`（模型 key）、`image-gen.json`
	 * （生图 key）都会变成"点一下就下载"，等于把钥匙挂在门上。
	 */
	const SENSITIVE_NAMES = new Set([
		'mobile-bridge.json', 'mobile-bridge.tokens.json', 'mobile-bridge-start-error.log',
		'image-gen.json', 'settings.yaml', 'settings.yaml.imported',
		'.credentials.yaml', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials.json',
	])
	function isSensitivePath(path) {
		const name = basename(path).toLowerCase()
		if (SENSITIVE_NAMES.has(name)) return true
		if (name.startsWith('.env')) return true
		if (/\.(key|pem|pfx|p12|keystore|jks)$/i.test(name)) return true
		// 手机桥自己的 token 库、以及 dsh 的凭据目录整个不给。
		if (path.includes(`${sep}mobile-bridge.tokens`)) return true
		return false
	}

	/**
	 * 🔴 4.10.0：读**归档预设**的元数据 ✓（`preset.json` ✓）。读不到就返回 null ✓（调用方如实说"素材不在了"✗）。
	 */
	function readPresetMeta(preset) {
		try {
			const meta = JSON.parse(readFileSync(join(presetDir(preset), 'preset.json'), 'utf8'))
			if (meta === null || typeof meta !== 'object') return null
			return meta
		} catch { return null }
	}

	/**
	 * 🔴 4.10.0：归档预设 → 报给页面 ✓。
	 * ⚠️ 形状和"普通背景文件"**一模一样** ✓（`url` / `mediaType` / `bytes` / `still` ✓）——
	 * 这样页面那套（缓存 key ✓、静止兜底 ✓、视频层 ✓、亮度适配 ✓）**一行都不用改** ✓。
	 */
	function archivedPresetInfo(preset) {
		const meta = readPresetMeta(preset)
		if (meta === null) return null
		const dir = presetDir(preset)
		const file = safeUploadName(String(meta.file ?? ''))
		if (file === '') return null
		const path = join(dir, file)
		const mediaType = mediaTypeOf(path)
		if (mediaType === '') return null
		try {
			const info = statSync(path)
			const tag = `preset=${encodeURIComponent(preset)}`
			const url = `api/background?${tag}&v=${info.size}-${Math.round(info.mtimeMs)}`
			let still = null
			const stillName = safeUploadName(String(meta.still ?? ''))
			if (mediaType.startsWith('video/') && stillName !== '') {
				const stillPath = join(dir, stillName)
				if (mediaTypeOf(stillPath).startsWith('image/')) {
					try {
						const stillInfo = statSync(stillPath)
						still = {
							url: `api/background?${tag}&still=1&v=${stillInfo.size}-${Math.round(stillInfo.mtimeMs)}`,
							mediaType: mediaTypeOf(stillPath),
							bytes: stillInfo.size,
						}
					} catch { still = null }
				}
			}
			return {
				preset,
				archived: true,
				url,
				mediaType,
				kind: mediaType.startsWith('video/') ? 'video' : 'image',
				bytes: info.size,
				...(still === null ? {} : { still }),
			}
		} catch { return null }
	}

	/**
	 * 🔴 4.10.0：**把当前背景归档成一个风格** ✓（用户：「你把这个背景归档到背景风格里面」✓）。
	 * ⚠️ **逐字节复制** ✓（`readFile` + `writeFile` ✓ —— 用户对这支视频说过"不要更改"✓）；
	 *    复制源在 uploads 目录（可写 ✓），所以不会踩"只读源 `EPERM`"那个坑 ✓。
	 * 返回归档后的 info ✓（失败返回 null ✓，调用方据此如实报错 ✓）。
	 */
	async function archivePreset(preset) {
		if (Object.prototype.hasOwnProperty.call(ARCHIVED_PRESETS, preset) === false) return null
		const file = typeof state.config?.backgroundFile === 'string' ? state.config.backgroundFile : ''
		if (file === '') return null
		const src = safeUploadRef(join(uploadsDir(), file))
		if (src === null) return null
		const dir = presetDir(preset)
		await mkdir(dir, { recursive: true })
		const bytes = await readFile(src)
		await writeFile(join(dir, safeUploadName(file)), bytes)
		let still = ''
		const stillName = typeof state.config?.backgroundStill === 'string' ? state.config.backgroundStill : ''
		if (stillName !== '') {
			const stillSrc = safeUploadRef(join(uploadsDir(), stillName))
			if (stillSrc !== null) {
				try {
					await writeFile(join(dir, safeUploadName(stillName)), await readFile(stillSrc))
					still = safeUploadName(stillName)
				} catch { still = '' }
			}
		}
		const mediaType = mediaTypeOf(join(dir, safeUploadName(file)))
		await writeFile(join(dir, 'preset.json'), `${JSON.stringify({
			preset,
			label: ARCHIVED_PRESETS[preset].label,
			file: safeUploadName(file),
			still,
			mediaType,
			bytes: bytes.length,
			archivedAt: new Date().toISOString(),
		}, null, 2)}\n`, 'utf8')
		return archivedPresetInfo(preset)
	}

	/** 背景文件还在不在、是什么类型 —— 页面据此决定要不要铺视频层。 */
	function backgroundInfo() {		/*
		 * 4.7.0：**自带预设优先** ✓ —— 它是 CSS 画的 ✓，不用文件、不用下载 ✓，
		 * 所以只要设了就直接回一个带 `preset` 的对象 ✓（页面据此加 `.bg-cyber` ✓）。
		 */
		const preset = typeof state.config?.backgroundPreset === 'string' ? state.config.backgroundPreset : ''
		/*
		 * 🔴 4.10.0：**带素材的预设**（`planet` / 夜行星 ✓）先走这一步 ✓ ——
		 * 素材归档在**本机**预设目录里 ✓（不进插件 ✓），这里把它**当成普通背景文件**报给页面 ✓
		 * （同样的 `url/mediaType/bytes/still` 形状 ✓ → 页面那套（缓存 ✓、静止兜底 ✓、亮度适配 ✓）全都照旧 ✓）。
		 */
		if (Object.prototype.hasOwnProperty.call(ARCHIVED_PRESETS, preset)) {
			const archived = archivedPresetInfo(preset)
			if (archived !== null) return archived
			/*
			 * ⚠️ 归档**不在了**（用户清理过 / 换了电脑 ✓）→ **不糊弄** ✗：
			 * 不返回"风格用上了"的假象 ✓，而是**如实返回 null**（= 没背景 ✓）+ 记一行日志 ✓。
			 */
			log(`背景风格「${ARCHIVED_PRESETS[preset].label}」的素材不在了（${presetDir(preset)}）—— 手机上会显示没有背景`)
			return null
		}
		if (BACKGROUND_PRESETS.includes(preset)) return { preset, kind: 'preset', motion: state.config?.backgroundMotion !== false }
		const name = typeof state.config?.backgroundFile === 'string' ? state.config.backgroundFile : ''
		if (name === '') return null
		const path = safeUploadRef(join(uploadsDir(), name))
		if (path === null) return null
		const mediaType = mediaTypeOf(path)
		if (mediaType === '') return null
		try {
			const info = statSync(path)
			// `?v=` 是给手机那层本地缓存用的：它按 url+bytes 存 IndexedDB，
			// 换了背景（哪怕碰巧字节数一样）也必须换 key，否则"换了却没变"。
			const url = `api/background?v=${info.size}-${Math.round(info.mtimeMs)}`
			/*
			 * 4.9.2：动图 → 顺带把**静止兜底**也给它 ✓（手机先铺静止版秒出 ✓，视频能播再换 ✓）。
			 * 只在"背景是视频、而且配置里确实配了一张存在的静止图"时才给 ✓ ——
			 * 配了但文件不在就**不发** ✗（发一个取不到的地址，等于让手机白试一次 ✗）。
			 */
			let still = null
			/*
			 * ⚠️ 这里**必须从 `state.config` 读** ✗ —— 我第一版直接引用了配置解析那个作用域的
			 * `backgroundStill` ✓，而它**不在这个作用域里** ✓ → 抛 ReferenceError → 被下面的 `catch` 吞掉 ✓
			 * → `backgroundInfo()` **一律返回 null** ✗（连图片背景都一起没了 ✓）。
			 * harness 两条断言当场红 ✓（"bootstrap 把背景告诉页面""背景地址带版本号"✓）。
			 * 现在和 `backgroundFile` 用**同一个口径** ✓（`state.config` ✓）。
			 */
			const stillName = typeof state.config?.backgroundStill === 'string' ? state.config.backgroundStill : ''
			if (mediaType.startsWith('video/') && stillName !== '') {
				const stillPath = safeUploadRef(join(uploadsDir(), stillName))
				if (stillPath !== null && mediaTypeOf(stillPath).startsWith('image/')) {
					try {
						const stillInfo = statSync(stillPath)
						still = {
							url: `api/background?still=1&v=${stillInfo.size}-${Math.round(stillInfo.mtimeMs)}`,
							mediaType: mediaTypeOf(stillPath),
							bytes: stillInfo.size,
						}
					} catch { still = null }
				}
			}
			return {
				url,
				mediaType,
				kind: mediaType.startsWith('video/') ? 'video' : 'image',
				bytes: info.size,
				...(still === null ? {} : { still }),
			}
		} catch {
			return null
		}
	}

	/**
	 * 2.6.0：宿主的**真值模型**（`modelSelection` 投影）。
	 *
	 * 用户 2026-10-11：「任务界面上的模型显示，电脑端换的也要看得见」——以前手机上显示的
	 * 是**手机自己记的** `dshm.model` ✗，所以在电脑上换过模型，手机仍然写着"模型：默认"
	 * ✗（2.4.2 的已知限制）。现在直接读宿主给每一行会话带的投影：
	 * `next` 是"下一次请求会用的"，`lastUsed` 是"上一次真用过的"，两个都空才是真没有。
	 */
	function modelOf(values) {
		const state = values?.modelSelection
		if (state === null || state === undefined || typeof state !== 'object') return null
		const picked = state.next ?? state.lastUsed
		if (picked === null || picked === undefined || typeof picked !== 'object') return null
		if (typeof picked.provider !== 'string' || typeof picked.model !== 'string') return null
		return {
			provider: picked.provider,
			model: picked.model,
			reasoningEffort: typeof picked.reasoningEffort === 'string' ? picked.reasoningEffort : '',
		}
	}

	/**
	 * 这一行会话要不要**从手机列表里藏起来**（默认藏，列表底部那个「显示全部」能看回来）。
	 *
	 * 用户 2026-10-11：「agent 子对话以及测试对话就不要显示在对话框里了，占位置」。两条判据：
	 *   1. `subagent` —— agent 自己派生的子会话（`origin:'subagent'` 或带 parentSessionId）。
	 *      它们本来也**打不开**（宿主只认父会话地址），摆在列表里只有坏处 ✗。
	 *   2. `ownDir` —— cwd 就在**桥自己的目录**里：那是开发/自检跑出来的会话（"输出数字1到1200"
	 *      这类）。用户的工作区在别处，所以这条不会误伤他自己的会话 ✓。
	 * 两条都是**手机这一侧的显示规则**：宿主数据一个字不改 ✓，桌面上照旧全都能看到 ✓。
	 */
	function isSubagentSummary(summary) {
		if (summary.origin === 'subagent') return true
		return typeof summary.parentSessionId === 'string' && summary.parentSessionId !== ''
	}

	/** 桥自己所在的目录（插件包根目录）：在这里跑起来的会话是自检/开发留下的。 */
	const OWN_DIR = resolve(HERE, '..')
	function isOwnCwd(cwd) {
		if (typeof cwd !== 'string' || cwd === '') return false
		const clean = resolve(cwd).replace(/[\\/]+$/, '').toLowerCase()
		return clean === OWN_DIR.replace(/[\\/]+$/, '').toLowerCase()
	}

	/**
	 * 2.8.0 ★12：这个会话**累计**烧了多少 token —— 直接读宿主的 `tokenUsage` 投影 ✓。
	 *
	 * 为什么用投影而不是自己数：宿主 `@deepseek-ai/dsh-token-meter` 的
	 * `tokenUsageProjectionDefinition`（`key: 'tokenUsage'`）本来就是"每个 assistant 结算
	 * 记一次、重试时替换那一次、不会重复累加"的纯函数折叠 ✓ —— 自己照着日志再数一遍，
	 * 只会把"重试要不要算两次"这类语义做错 ✓。
	 * 字段名照宿主那份 state schema：`uncachedInputTokens / outputTokens / cacheReadTokens /
	 * cacheWriteTokens` ✓（**不是** `inputTokens` ✗ —— 读外部数据的字段名先看清楚 ✓）。
	 * 读不到（宿主没装 token-meter / 这一行是冷会话）就回 `null` ✓ —— **绝不编一个数** ✗。
	 */
	function tokenUsageOf(values) {
		const totals = values?.tokenUsage
		if (totals === null || totals === undefined || typeof totals !== 'object') return null
		const numbers = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
			.map((key) => Number(totals[key] ?? 0))
		if (numbers.some((value) => Number.isFinite(value) === false || value < 0)) return null
		const [uncached, output, cacheRead, cacheWrite] = numbers
		// 输入口径 = 没命中缓存的 + 命中缓存的 + 写缓存的 ✓（三块互不重叠 ✓）；`total` 再带上输出 ✓。
		const input = uncached + cacheRead + cacheWrite
		if (input === 0 && output === 0) return null
		return { input, output, cacheRead, cacheWrite, total: input + output }
	}

	function summarize(summary) {
		const values = summary.projections?.values ?? {}
		let title = ''
		for (const [key, value] of Object.entries(values)) {
			if (typeof value === 'string' && key.toLowerCase().includes('title')) { title = value; break }
		}
		return {
			sessionId: summary.sessionId,
			title: title === '' ? (summary.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '(未命名)' : title,
			cwd: summary.cwd ?? '',
			running: summary.running === true,
			blank: summary.blank === true,
			updatedAt: summary.updatedAt,
			model: modelOf(values),
			// 2.8.0 ★12：本会话累计 token（宿主投影 ✓；读不到就是 null ✓）。
			usage: tokenUsageOf(values),
			subagent: isSubagentSummary(summary),
			ownDir: isOwnCwd(summary.cwd),
		}
	}

	/** 宿主工作区里**已归档**的会话 id（手机上的「删除」就落在归档上，见 handleArchiveSession）。 */
	function archivedSessionIds() {
		try {
			const registry = ctx.get('workspaceRegistry')
			const ids = registry?.archivedSessionIds
			return Array.isArray(ids) ? new Set(ids) : new Set()
		} catch {
			return new Set()
		}
	}

	async function listSessions() {
		// 几秒内的重复调用直接复用：手机打开一次会连着要两份（boot + loadSessions），
		// 断线重连时更是一串 —— 每次都去问宿主 40 多个会话，纯属白等。
		const now = Date.now()
		if (state.sessionListCache !== null && now - state.sessionListCache.at < 5000) {
			return state.sessionListCache.value
		}
		const controller = ctx.sessionController
		const value = await controller.list({}, AbortSignal.timeout(15000))
		const entries = (value.items ?? []).map(summarize)
		for (const entry of entries) {
			if (entry.cwd !== '') state.sessionCwds.add(entry.cwd)
		}
		const archived = archivedSessionIds()
		const listed = entries
			// 子会话打不开就别摆出来（见 state.unfollowable）。
			.filter((entry) => state.unfollowable.has(entry.sessionId) === false)
			// 手机上说"删掉"的会话：宿主的归档集合里一出现就**不再列出来** ✓
			// （归档是宿主的原生"从列表拿掉"，记录还在，电脑端能取消归档找回来）。
			.filter((entry) => archived.has(entry.sessionId) === false)
			.sort((left, right) => right.updatedAt - left.updatedAt)
		state.sessionListCache = { at: now, value: listed }
		return listed
	}

	/**
	 * DSH 里 agent 自己派生的子会话不能用 `{kind:'session'}` 地址跟随，宿主会回
	 * "subagent Sessions require their durable parent address"。手机端不做子会话
	 * 地址（那是给桌面 UI 用的），但必须把这件事**说清楚**：以前它跟普通断线一样
	 * 只报"和电脑断开了 / 你的地址已失效"，用户会以为桥坏了。
	 */
	const isUnfollowable = (message) => /subagent/i.test(message)

	/**
	 * The wire log carries an `assistant/message` payload whose `stream` field
	 * repeats every delta already delivered live. Dropping it keeps a snapshot
	 * of a long session inside a phone's patience.
	 */
	function trimEvent(event) {
		if (event?.type !== 'assistant/message' || event.data === null || typeof event.data !== 'object') return event
		const { stream, ...rest } = event.data
		return { ...event, data: rest }
	}

	/* -------------------------------------------------------------- routes */

	async function handleLogin(req, res) {
		const ip = clientIp(req)
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		/*
		 * 顺序很重要：**先验 PIN，再判限流**。
		 *
		 * 限流拦的是"猜密码"这件事，所以只该拦**输错**的那些。之前是先判限流，于是
		 * 页面在开机/隧道抖动时自动重试几次（1.3.10 的行为，成功也照记数）就把自己的
		 * IP 打到 429 —— 密码明明是对的却被关在门外，而且**输对也恢复不了**（根本走不到
		 * 验 PIN 那一步）。真机上实测撞了一次。
		 * 只拦错误尝试对防爆破是等价的（攻击者永远只有 N 次/窗口），而且主人不会被
		 * 自己的重试或别人的攻击锁在门外（后者等于免费 DoS）。
		 */
		if (!sameSecret(String(body.pin ?? ''), state.config.pin)) {
			if (!throttleLogin(ip)) {
				sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' })
				return
			}
			warn(`failed PIN attempt from ${ip}`)
			record(`PIN rejected from ${ip}`)
			noteLoginFailure({ ip, ua: userAgentOf(req), what: 'login' })
			sendJson(res, 401, { error: 'PIN 不正确' })
			return
		}
		record(`PIN accepted from ${ip}`)
		/*
		 * 2.8.0 ★2：登录历史落一行账 ✓ —— 陌生地址由 auditLogin 顺手报警（角标 + 日志 ✓）。
		 * 这里**等它写完**再回包 ✓：手机要知道"这是不是一台新设备"（自己也好心里有数 ✓），
		 * 而这个文件最多 256KB，读一次 + 追加一行的代价可以忽略 ✓。
		 */
		const audited = await auditLogin({ ip, ua: userAgentOf(req), ok: true, what: 'login' })
		// 输对了就把这个 IP 的尝试计数清零，恢复正常使用。
		state.attempts.delete(ip)
		// An existing session is elevated in place; only a fresh login rotates the
		// cookie. Rotating on every PIN re-entry would leave a trail of live tokens.
		const presented = parseCookies(req.headers.cookie)[COOKIE]
		const held = typeof presented === 'string' ? state.sessions.get(presented) : undefined
		const reuse = held !== undefined && (state.config?.bindTokenToIp === false || held.ip === ip)
		const token = reuse ? presented : issueToken(ip, req)
		state.elevated.set(token, Date.now() + state.elevationMs)
		// `Secure` has to be conditional: this very page is also served over plain
		// HTTP on the LAN/hotspot, and a Secure cookie is dropped there — which would
		// look exactly like a wrong PIN and be near-impossible to diagnose.
		const secureFlag = String(req.headers['x-forwarded-proto'] ?? '') === 'https' ? '; Secure' : ''
		res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${secureFlag}; Max-Age=${Math.floor(state.tokenTtlMs / 1000)}`)
		// `firstSeen` 是**提示性**的 ✓：这台设备在历史上第一次成功登录（不等于"有危险" ✗，
		// 但"你自己的手机换了网络"也会命中 —— 所以话要说得让人能自己判断 ✓）。
		// 3.0.0 ★④：**等放行的设备**要在回包里说清 ✓ —— 手机据此直接进"等放行"那一屏 ✓，
		// 而不是进去了又被 401 弹回输 PIN（那会变成"输了也对、就是进不去"的循环 ✗）。
		const pending = state.sessions.get(token)?.approved === false
		sendJson(res, 200, { ok: true, firstSeen: audited?.firstSeen === true, from: ip, pending })
	}

	/** bootstrap 的内容（单独抽出来：`/api/boot` 要把这份和对话快照拼在一个响应里）。 */
	async function buildBootstrap(req, res) {
		let sessions = []
		let failure = null
		try {
			sessions = await listSessions()
		} catch (error) {
			failure = String(error?.message ?? error)
		}
		return {
			sessions,
			failure,
			// Full entries, not bare strings: the phone page and the desktop badge
			// both need to say *why* a candidate is first (USB link / remembered).
			addresses: lanAddresses(state.config.phoneHost ?? '').map((entry) => {
				const described = describeAddress(entry, state.config.port)
				return { ...entry, ...described, url: withSecret(state.config, described.url) }
			}),
			phoneHost: state.config.phoneHost ?? '',
			// 5.0.1：记着的那个地址**已经不属于这台机器**了（换 WiFi / DHCP 续租 ✓）——
			// 手机若还停在旧地址上，请求到不了这里 ✓；页面可以据此提示"换当前地址 / 用固定外网地址"✓。
			// 只报事实 ✓，**不偷偷改配置** ✗（那个值可能是手机上次从 USB 网段连上来的 ✓）。
			phoneHostStale: phoneHostDrift(state.config) !== null,
			port: state.config.port,
			// 当前对外的正式地址（含密钥段）。页面会把它记进 localStorage：万一用户
			// 停在一条【已经失效的旧地址】上（页面还能从内存/缓存显示，但所有请求都
			// 失败 → 一片空白），他能一键切回当前地址，而不是对着空白干瞪眼。
			publicUrl: typeof state.config.publicUrl === 'string' && state.config.publicUrl !== ''
				? withSecret(state.config, state.config.publicUrl)
				: '',
			pageTag: state.pageTag,
			// 手机界面的背景（用户自己挑的视频/图）。没有就是 null，页面保持原样。
			background: backgroundInfo(),
			// 这台手机看过"开始使用"没有 —— 页面据此决定要不要再弹（本地标记丢了也不会重复弹）。
			// 按**设备**记，不按 IP：隧道后面所有手机是同一个 IP（见 DEVICE_COOKIE）。
			// 内容改版（WELCOME_VERSION +1）后这里会重新变 false，让老设备再看一遍新说明。
			welcomed: welcomedVersion(state.welcomed.get(deviceId(req, res))) >= WELCOME_VERSION,
			/*
			 * 4.14.1：**手机上错过的提问** ✓（超时了但宿主还收得住的那几条 ✓）。
			 * 放在 bootstrap 里，手机一打开就知道"有条提问在别的会话等它" ✓ ——
			 * 正文只走登录之后这条路 ✓，推送那条提示帧里**只有 id** ✗（见 `pushToAll` ✓）。
			 */
			waiting: continuedQuestions(),
			security: {
				recentFailures: state.recentFailures.length,
				windowMinutes: Math.round(LOGIN_WINDOW_MS / 60000),
				locked: state.recentFailures.length >= LOGIN_MAX_ATTEMPTS_GLOBAL,
				tokenBoundToIp: state.config?.bindTokenToIp !== false,
				requirePinForWrites: true,
				elevated: elevated(req),
				foreignUses: state.foreignUses.slice(-5),
				/*
				 * 2.8.0 ★2：最近一次"陌生设备登录"的**时间**（页面据此提一句 ✓）；
				 * **只给时间，不给 IP** ✗ —— bootstrap 只要 cookie，而 IP 属于
				 * "要现输 PIN 才看得到的那份账"（`/api/logins` ✓）。冷视角复查点过这一条 ✓。
				 */
				newDeviceAt: state.newDevice === null ? null : Number(state.newDevice.at),
				// 当前还在登录态的**设备台数**（不泄漏令牌、也不算过期的 ✓）。
				liveLogins: liveTokenCount(),
			},
		}
	}

	async function handleBootstrap(req, res) {
		sendJson(res, 200, await buildBootstrap(req, res))
	}

	/**
	 * `/api/boot`：一次请求把"打开手机桥"要的两样东西都取回来。
	 *
	 * 为什么要合并：隧道慢的时候（实测经过旧金山 DERP 时一个来回 8 秒），分开要
	 * bootstrap + transcript 两个来回 = 十几秒；合成一个就少一半等待。
	 */
	async function handleBoot(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		// 页面手机上留着上次那份对话时会带 since= 回来（切到别的 App 再回来、
		// PWA 被系统回收后重开）→ 只补新的那几条，几十字节，不用再等整段下载。
		const since = parseSince(url.searchParams.get('since'))
		const payload = await buildBootstrap(req, res)
		// 显式给 null：页面靠 `body.transcript` 是否存在来判断要不要贴对话，
		// 字段时有时无会让客户端契约变成口头约定。
		payload.transcript = null
		if (sessionId !== '') {
			try {
				const transcript = await buildTranscript(sessionId)
				if (since !== null && Array.isArray(transcript.records)) {
					const sliced = sliceSince(transcript.records, transcript.cursor ?? 0, since)
					if (sliced.partial === true) {
						transcript.partial = true
						transcript.records = sliced.records
					}
				}
				payload.transcript = transcript
			} catch (error) {
				payload.transcript = { records: [], cursor: 0, hasMore: false, error: String(error?.message ?? error) }
			}
		}
		sendJson(res, 200, payload)
	}

	/** Everything the "new task" screen needs to offer a destination. */
	async function handleWorkspaces(res) {
		const workspaces = []
		const registry = ctx.get('workspaceRegistry')
		if (registry !== undefined && typeof registry.list === 'function') {
			try {
				for (const workspace of registry.list()) {
					workspaces.push({ id: workspace.id, title: workspace.title, path: workspace.path })
				}
			} catch (error) {
				warn(`workspace list failed: ${String(error?.message ?? error)}`)
			}
		}
		const presets = []
		const presetsService = ctx.get('agentPresets')
		if (presetsService !== undefined && typeof presetsService.list === 'function') {
			try {
				/*
				 * 优先用 `remoteExportList()`：它在每个预设上多给一个 **`isDefault`**
				 * （宿主当前选定的默认预设是哪个）。
				 *
				 * 为什么需要它：用户报「手机新建对话明显会变贵」—— 新建面板上的预设下拉默认是
				 * 「（用默认）」，但"默认到底是哪个"以前在手机上**看不见** ✗。现在把它显示出来，
				 * 贵不贵在选择之前就看得见 ✓。
				 */
				const roster = typeof presetsService.remoteExportList === 'function'
					? (await presetsService.remoteExportList())?.presets ?? await presetsService.list()
					: await presetsService.list()
				for (const preset of roster) {
					// A broken preset stays on the roster but can never mount, so
					// offering it here would only produce a late failure.
					if (typeof preset.broken === 'string' && preset.broken !== '') continue
					presets.push({
						id: preset.id,
						name: preset.name ?? preset.id,
						description: preset.description ?? '',
						isDefault: preset.isDefault === true,
					})
				}
			} catch (error) {
				warn(`preset list failed: ${String(error?.message ?? error)}`)
			}
		}
		sendJson(res, 200, { workspaces, presets })
	}

	/* ------------------------------------------------- 模型选择（2.4.0） */
	/**
	 * 用户要求：「添加模型调用，手机上能调用不同模型」。
	 *
	 * 宿主给的口子和桌面端完全一样：
	 *   `sessionController.modelCatalog()` → `{ groups: [{ provider, models: [...] }] }`
	 *   `sessionController.selectModel({ sessionId, provider, model })`（**按会话**生效 ✓）
	 * 这儿只做透传 —— 不缓存、不改写，桌面端和手机端看到的是同一份目录 ✓。
	 */
	async function handleModels(res) {
		try {
			const catalog = await ctx.sessionController.modelCatalog()
			const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
			sendJson(res, 200, { groups })
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	async function handleSelectModel(req, res) {
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const sessionId = String(body.sessionId ?? '')
		const provider = String(body.provider ?? '')
		const model = String(body.model ?? '')
		if (sessionId === '' || provider === '' || model === '') {
			sendJson(res, 400, { error: '需要 sessionId / provider / model' })
			return
		}
		const request = { sessionId, provider, model }
		if (typeof body.reasoningEffort === 'string' && body.reasoningEffort !== '') request.reasoningEffort = body.reasoningEffort
		try {
			const selected = await ctx.sessionController.selectModel(request)
			record(`model selected ${provider}/${model} for ${sessionId}`)
			sendJson(res, 200, { selected: selected?.selected ?? { provider, model } })
		} catch (error) {
			record(`model select rejected for ${sessionId}: ${String(error?.message ?? error)}`)
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	/* --------------------------------------------- 删除会话（2.6.0） */
	/**
	 * 用户要求：「再加一个删除对话按钮，并且要输入 pin 才能删除对话」。
	 *
	 * **落地成宿主的「归档」**（`workspaceRegistry.archiveSession`）：这是 DSH 自己对
	 * "把会话从列表里拿掉"唯一的原生操作 —— 桌面端会话菜单里那一项就是它 ✓。
	 * 桥**绝不自己删会话文件** ✗：手删 JSONL 会绕过宿主的 sqlite 索引、附件目录和
	 * 派生会话的血缘，那是真会弄坏东西的做法；而归档是可逆的（电脑端能取消归档找回来）✓。
	 *
	 * **为什么每次都要重新输 PIN**（而不是复用"15 分钟内提权过"）：这是手机上唯一
	 * 不可从手机撤销的操作，所以门槛单独抬高一级 —— 手上有一部已解锁手机的人，不能
	 * 直接把你几十个会话从列表里清空 ✗。PIN 错了同样进**登录限速**（否则这个接口就是
	 * 一个不限次的 PIN 试错口 ✗）。这条在 README 和 CHANGELOG 里都写明了。
	 */
	async function handleArchiveSession(req, res) {
		const ip = clientIp(req)
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const sessionId = String(body.sessionId ?? '')
		if (sessionId === '') {
			sendJson(res, 400, { error: '缺少 sessionId' })
			return
		}
		if (!sameSecret(String(body.pin ?? ''), state.config.pin)) {
			if (!throttleLogin(ip)) {
				sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' })
				return
			}
			warn(`failed PIN attempt (delete session) from ${ip}`)
			record(`删除会话：PIN 不正确 <- ${ip}`)
			noteLoginFailure({ ip, ua: userAgentOf(req), what: 'delete-session' })
			// **403 而不是 401**：401 在页面上等于"登录没了"→ 会弹 PIN 登录门、把整个界面
			// 盖掉 ✗。这里要的是"这条操作没被批准，原因写在这一行上"✓（客户端据此把
			// 这句话显示在删除纸里，用户直接在原地重输）。
			sendJson(res, 403, { error: 'PIN 不正确 —— 会话没有删除' })
			return
		}
		// 输对了就把这个 IP 的尝试计数清零（和登录同一条规矩）。
		state.attempts.delete(ip)
		const registry = ctx.get('workspaceRegistry')
		if (registry === undefined || typeof registry.archiveSession !== 'function') {
			sendJson(res, 501, { error: '这台电脑上的 DSH 没有工作区归档能力，手机删不了会话' })
			return
		}
		try {
			// `stopActivity` 只在用户明确同意"连正在跑的一起停"时才带上（见手机上的二次确认）。
			await registry.archiveSession(sessionId, { stopActivity: body.stop === true })
		} catch (error) {
			const name = String(error?.name ?? '')
			if (name === 'WorkspaceActiveSessionError') {
				const activity = Array.isArray(error?.activity) ? error.activity : []
				sendJson(res, 409, {
					error: '这个会话正在跑 —— 要先把它停掉才能删',
					activity: activity.map((entry) => String(entry?.kind ?? entry ?? '')),
				})
				return
			}
			if (name === 'WorkspaceUnknownSessionError') {
				sendJson(res, 404, { error: '这个会话已经不在电脑上了' })
				return
			}
			throw error
		}
		/*
		 * 会话列表有 5 秒缓存（见 listSessions）—— 不立刻作废的话，用户删完刷新还是能
		 * 看见那一条 ✓→ 那是"删了没反应"的经典观感。
		 */
		state.sessionListCache = null
		record(`会话已删除（归档）${sessionId} <- ${ip}`)
		sendJson(res, 200, { archived: true, sessionId })
	}

	/* --------------------------- 电脑状态 / 结束进程（2.7.0 ★3）与一键动作（★4） */
	/**
	 * 安全开关**每次请求现读配置文件** ✓ —— 不缓存。
	 *
	 * 为什么破例（别处都是启动时读一次）：这类开关是**放宽"手机能干什么"**的东西 ✓，
	 * 而"关掉"必须**立刻**生效 ✓。用户发现不对想关掉它，却还得重启 DSH 才生效 ——
	 * 那这一分钟就是敞着的 ✗。（`processControl` = 结束进程；`powerControl` = 关机/重启 ✓。）
	 */
	function processControlFlag(key) {
		try {
			const stored = JSON.parse(readFileSync(join(dshHome(), CONFIG_FILE), 'utf8'))
			return stored[key] === true
		} catch {
			return false
		}
	}

	/*
	 * ------------------------------------------------------------------ 4.5.0 手机上控制电脑
	 *
	 * 用户 2026-10-14：「做一键给电脑静音，调低亮度，调低调高音量，调高亮度，联网检查，
	 * 电量检查，蓝牙连接，蓝牙设备显示的功能的功能」✓ —— 七件事 ✓。
	 *
	 * 两条闸（照 `processControl` 那套 ✓）：
	 *   · `GET  /api/pc` → `guard()` ✓（只读 ✓，不要 PIN ✓）：快状态 —— 音量 / 亮度 / 电量 / 联网 ✓；
	 *   · `POST /api/pc` → `guardWrite()` ✓（**让电脑动手** ✓，要 PIN 提权 ✓）：
	 *     静音 / 音量 / 亮度 / 蓝牙开关 / 打开蓝牙设置 / 查设备列表 ✓。
	 * 两个都要 `pcControl: true` ✓（默认关 ✓、现读 ✓）。关着时**明说怎么开** ✓，不是一句 403 了事 ✓。
	 */
	const PC_OFF = '电脑控制默认关闭 —— 在 mobile-bridge.json 里加 "pcControl": true 再试（改完立刻生效，不用重启）✓'

	async function handlePcState(res) {
		if (processControlFlag('pcControl') === false) {
			sendJson(res, 200, { enabled: false, note: PC_OFF })
			return
		}
		try {
			const state = await pcSnapshot()
			sendJson(res, 200, { enabled: true, ...state })
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	async function handlePcAction(req, res) {
		if (processControlFlag('pcControl') === false) {
			sendJson(res, 403, { error: PC_OFF })
			return
		}
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const action = String(body?.action ?? '')
		const step = Number.isFinite(Number(body?.step)) ? Math.max(1, Math.min(25, Math.round(Number(body.step)))) : 10
		try {
			if (action === 'refresh') {
				sendJson(res, 200, { ok: true, action, ...(await pcSnapshot()) })
				return
			}
			if (action === 'mute' || action === 'unmute' || action === 'toggleMute') {
				const now = await pcSnapshot()
				// 读不到当前状态时**不猜** ✓：toggle 就直接回"读不到" ✓（宁可让用户按"静音"那个明确的键 ✓）。
				const want = action === 'mute' ? true : action === 'unmute' ? false : null
				const muted = want === null ? (now.audio === null ? null : now.audio.muted === false) : want
				if (muted === null) {
					sendJson(res, 200, { ok: false, action, message: '读不到当前的音量状态，改用「静音 / 取消静音」这两个明确的键 ✓' })
					return
				}
				const after = await applyAudio({ muted })
				sendJson(res, 200, { ok: after !== null, action, audio: after, message: after === null ? '静音没设成功（读不回来）' : '' })
				return
			}
			if (action === 'volumeUp' || action === 'volumeDown' || action === 'volume') {
				const now = await pcSnapshot()
				if (now.audio === null) {
					sendJson(res, 200, { ok: false, action, message: '读不到当前的音量，改不了（这台机器的音频接口没认出来）✓' })
					return
				}
				const base = typeof body?.value === 'number' ? Number(body.value) : now.audio.volume + (action === 'volumeDown' ? -step : step)
				const after = await applyAudio({ volume: base, muted: false })
				sendJson(res, 200, { ok: after !== null, action, audio: after, message: after === null ? '音量没设成功（读不回来）' : '' })
				return
			}
			if (action === 'brightnessUp' || action === 'brightnessDown' || action === 'brightness') {
				const now = await pcSnapshot()
				if (now.brightness.supported === false) {
					sendJson(res, 200, { ok: false, action, message: '这台机器没有可调的内置屏幕（台式机 / 只接外接屏时就是这样）✓' })
					return
				}
				const base = typeof body?.value === 'number' ? Number(body.value) : (now.brightness.level ?? 50) + (action === 'brightnessDown' ? -step : step)
				const after = await applyBrightness(base)
				sendJson(res, 200, {
					ok: after.supported === true, action, brightness: after,
					message: after.supported === false ? '这台机器没有可调的内置屏幕 ✓' : '',
				})
				return
			}
			if (action === 'bluetoothDevices') {
				sendJson(res, 200, { ok: true, action, bluetooth: await listBluetooth() })
				return
			}
			/*
			 * 蓝牙开 / 关 ✓（4.5.1 做回来的 ✓）：**发出去 + 轮询真实状态** ✓ ——
			 * 4.5.0 发布前删过一次 ✗（PS 5.1 里 `SetStateAsync` 的 `AsTask` 绑不上 ✓，
			 * 看着像"系统不让调" ✓）；后来探明白**副作用其实执行了** ✓、坏的只是"等结果"那一步 ✓，
			 * 所以改成不等它、直接**读回真状态** ✓（详见 `lib/pccontrol.js` 顶部的两笔账 ✓）。
			 */
			if (action === 'bluetoothOn' || action === 'bluetoothOff') {
				const want = action === 'bluetoothOn'
				const result = await setBluetoothRadio(want)
				sendJson(res, 200, {
					ok: result.ok, action, radio: result.radio,
					message: result.ok ? '' : (result.reason === 'no-radio'
						? '这台机器没有蓝牙无线电 ✓'
						: `蓝牙没动成（现在读到的是 ${result.radio === '' ? '读不到' : result.radio}）—— 可以在「打开蓝牙设置」里手点 ✓`),
				})
				return
			}
			if (action === 'bluetoothSettings') {
				const result = await openBluetoothSettings()
				sendJson(res, 200, {
					ok: result.ok, action,
					message: result.ok ? '已经在电脑上打开蓝牙设置 —— 连接 / 配对新设备在这儿点一下 ✓' : '没能打开蓝牙设置页',
				})
				return
			}
			/*
			 * 4.14.0「断开某一台」（用户 2026-10-16：「还有蓝牙功能的断开设备连接，现在只有连接设备」✓）。
			 * ⚠️ 结论一律**照实转**（`disconnectVerdict` 里写死了判据：回读到的 `fConnected` ✓）——
			 * 断不掉就说断不掉 ✗（`ok:false` + 怎么手动关 ✓），**绝不**因为"命令发出去了"就说断了 ✗。
			 * 目标按**地址**找 ✓（名字会重 ✓）：`body.device` 就是这个地址 ✓。
			 */
			if (action === 'bluetoothDisconnect') {
				const verdict = await disconnectBluetoothDevice(String(body?.device ?? ''))
				record(`断开蓝牙设备 ${String(body?.device ?? '')}：${verdict.state}${verdict.ok === true ? '（回读确认 ✓）' : ''}`)
				sendJson(res, 200, { ok: verdict.ok === true, action, state: verdict.state, service: verdict.service, message: verdict.message })
				return
			}
			sendJson(res, 400, { error: '不认识的 action：' + action, actions: ['refresh', 'mute', 'unmute', 'toggleMute', 'volumeUp', 'volumeDown', 'volume', 'brightnessUp', 'brightnessDown', 'brightness', 'bluetoothDevices', 'bluetoothOn', 'bluetoothOff', 'bluetoothSettings', 'bluetoothDisconnect'] })
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	async function handleSystem(res) {		try {
			const snapshot = await sampleSystem()
			const enabled = processControlFlag('processControl')
			sendJson(res, 200, {
				...snapshot,
				killEnabled: enabled,
				// 手机要知道"这台机器上 node 进程是不是都能杀"：自己/子进程一律不行 ✓（见 system.js ✓）。
				killNote: enabled
					? '结束进程已开启：只能结束 node 进程，且不能是 DSH 本体或它正在用的子进程 ✓'
					: '结束进程默认关闭 —— 要开就在 mobile-bridge.json 里加 "processControl": true（改完立刻生效，不用重启）✓',
			})
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	async function handleKillProcess(req, res) {
		const ip = clientIp(req)
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		if (processControlFlag('processControl') !== true) {
			sendJson(res, 403, { error: '结束进程默认关闭 —— 在 mobile-bridge.json 里加 "processControl": true 再试（改完立刻生效）' })
			return
		}
		const pid = Number(body.pid)
		if (!Number.isInteger(pid) || pid <= 0) {
			sendJson(res, 400, { error: '缺少 pid' })
			return
		}
		if (!sameSecret(String(body.pin ?? ''), state.config.pin)) {
			if (!throttleLogin(ip)) {
				sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' })
				return
			}
			warn(`failed PIN attempt (kill process) from ${ip}`)
			record(`结束进程：PIN 不正确 <- ${ip}`)
			noteLoginFailure({ ip, ua: userAgentOf(req), what: 'kill-process' })
			// 403 而不是 401：401 会让页面弹登录门、把整个界面盖掉 ✗（和"删除会话"同一条规矩 ✓）。
			sendJson(res, 403, { error: 'PIN 不正确 —— 没有结束任何进程' })
			return
		}
		state.attempts.delete(ip)
		// full=true：判"能不能杀"要看**全部**进程 ✓（手机那份是精简列表，用它会把真实存在的进程说成"没有" ✗）。
		const snapshot = await sampleSystem({ full: true })
		const verdict = killVerdict(pid, snapshot.processes)
		if (verdict.ok !== true) {
			sendJson(res, verdict.status, { error: verdict.error })
			return
		}
		const killed = await killProcess(pid)
		/*
		 * "杀了"必须**确认过**再说 ✓（不假装成功 ✗）。
		 *
		 * ⚠️ 冷视角复查留下的待办之一：`processAlive()` 会返回 **null** ✓ —— 那是"**读不到**进程表"
		 * （PowerShell 不可用之类 ✓），**不等于"它已经没了"** ✗。原来这里把 null 和 true 混在一条
		 * 分支里，说成"已发出结束请求，但它还在" ✓ —— 听着像"还在"，其实**根本没确认** ✓。
		 * 现在三种情形分开说 ✓，`alive` 也**原样**回给手机（null 就是 null ✓，不洗成 false ✗）。
		 */
		const alive = await processAlive(pid)
		if (killed.ok !== true && alive !== false) {
			sendJson(res, 500, { error: `结束失败：${killed.message}` })
			return
		}
		record(`结束进程 ${pid}（${verdict.target.name}）<- ${ip}${alive === false ? '' : '（没能确认是否真的结束）'}`)
		sendJson(res, 200, {
			killed: true,
			pid,
			name: verdict.target.name,
			alive,
			message: alive === false
				? '已经结束了（确认过 ✓）'
				: (alive === true ? '命令发了，但它还在（可能在做收尾）' : '命令发了，但**没法确认**它有没有真的结束（读不到进程表）'),
		})
	}

	/*
	 * 电脑端一键动作（2.7.0 ★4：锁屏 / 关机 / 重启）。
	 *
	 * 用户上次直接找我说「帮我关机」✓，那就做成按钮 ✓。纪律见 lib/power.js 开头：
	 * 锁屏一键 ✓；关机/重启**默认关 + 现输 PIN + 点两次 + 20 秒倒计时可取消** ✓。
	 *
	 * 关机前**先自检** ✓（交接文档点名要这条 ✓）：桥在不在听、桌面端在不在听、开机自启装没装、
	 * 有没有会话在跑 —— "关完回来连不上"这种坑，答案基本都在这四条里 ✓。
	 * （文档里还提到"publish 目录干净"：那是**这个项目维护者自己**的检查项，插件不可能知道
	 * 用户的发布目录在哪 ✗，所以没做 —— 不装作有 ✓。）
	 */
	const AUTOSTART_TASK = 'DSH 手机桥 · 开机自启'

	function portOpen(port) {
		return new Promise((resolve) => {
			const socket = new net.Socket()
			const done = (value) => { socket.destroy(); resolve(value) }
			socket.setTimeout(700)
			socket.once('connect', () => done(true))
			socket.once('timeout', () => done(false))
			socket.once('error', () => done(false))
			socket.connect(Number(port), '127.0.0.1')
		})
	}

	/** 开机自启装没装（任务 + 稳定副本两步都看 ✓ —— 只看一个都可能骗人 ✓）。 */
	async function autostartInstalled() {
		const script = join(dshHome(), 'launcher', 'boot-up.ps1')
		if (existsSync(script) === false) return false
		/*
		 * ⚠️ 两条踩过的坑，都写在这儿：
		 *   ① **不要用 `Get-ScheduledTask`** ✗ —— 这台机器上有个任务的 XML 坏了，整个 cmdlet
		 *      会抛 "The task XML contains a value which is incorrectly formatted"，于是**任何**
		 *      查询都拿不到东西 → 明明装好的任务被报成"没装" ✗（真机验证当场撞到 ✓）。
		 *      `schtasks.exe` 走的是另一条 API，不受影响 ✓。
		 *   ② **中文任务名不要走命令行** ✗ —— 会被 Windows 的 ANSI 代码页吃掉 ✓。
		 *      所以这里**不按名字查**：把全部任务列出来，用 **ASCII 特征**（boot-up.ps1 的路径 ✓）
		 *      去匹配 ✓ —— 命令行里一个中文都没有，匹配的也是纯 ASCII ✓。
		 */
		const out = await new Promise((resolve) => {
			execFile('schtasks.exe', ['/query', '/fo', 'CSV', '/v'],
				{ timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
				(error, stdout) => resolve(String(stdout ?? '')))
		})
		return out.toLowerCase().includes('boot-up.ps1')
	}

	async function powerPreflight() {
		const bridgePort = Number(state.config.port)
		const checks = []
		checks.push(await portOpen(bridgePort)
			? { name: '手机桥在监听', ok: true, hint: `端口 ${bridgePort}` }
			: { name: '手机桥在监听', ok: false, hint: `端口 ${bridgePort} 没有应答 —— 关完可能连不上，先确认插件在跑` })
		checks.push(await portOpen(3080)
			? { name: '桌面端在监听', ok: true, hint: '端口 3080' }
			: { name: '桌面端在监听', ok: false, hint: '端口 3080 没有应答（也许你现在就没开着桌面端）' })
		checks.push(await autostartInstalled()
			? { name: '开机自启已装', ok: true, hint: '关机后再开机会自动拉起 DSH + 桥 + 隧道' }
			: { name: '开机自启已装', ok: false, hint: '没装：关完得自己点桌面图标才能连上（跑一次 tools\\autostart.ps1 装上）' })
		let running = 0
		try {
			const value = await ctx.sessionController.list({}, AbortSignal.timeout(8000))
			running = (value.items ?? []).filter((item) => item.running === true).length
		} catch { running = -1 }
		checks.push(running === 0
			? { name: '没有会话在跑', ok: true, hint: '现在关机不会打断正在干的活' }
			: { name: '没有会话在跑', ok: false, hint: running < 0 ? '读不到会话列表（不确定有没有在跑的）' : `有 ${running} 个会话正在跑 —— 关机 = 正在干的活直接断` })
		return checks
	}

	async function handlePowerInfo(res) {
		const enabled = processControlFlag('powerControl')
		sendJson(res, 200, {
			// 锁屏永远可用（它是往安全方向走 ✓）；关机/重启要在配置里显式打开 ✓。
			lockEnabled: true,
			powerEnabled: enabled,
			delaySeconds: POWER_DELAY_SECONDS,
			note: enabled
				? '关机 / 重启已开启：每次都要现输 PIN，并且要点两次才执行；执行后有 20 秒可以取消 ✓'
				: '关机 / 重启默认关闭 —— 要开就在 mobile-bridge.json 里加 "powerControl": true（改完立刻生效，不用重启）✓',
			preflight: await powerPreflight(),
			pending: state.power,
		})
	}

	async function handlePower(req, res) {
		const ip = clientIp(req)
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const action = String(body.action ?? '')

		/*
		 * 3.5.x「解锁」（用户 2026-10-13：「既然可以锁屏电脑那也加一个解锁的功能」✓）。
		 * ⚠️ 与其它动作三点不同 ✓：
		 *   ① 它**不是一条命令** ✓（"唤醒输入 + 查一次状态"两步 ✓，见 runUnlock ✓）→ 所以必须放在
		 *      下面那个 `powerCommand(action) === null` 判断**之前** ✗（否则会被当成非法动作 400 ✓）；
		 *   ② 它是**放宽方向**的动作（等于把人放进来 ✓）→ 挂 powerControl（**默认关** ✓）+
		 *      **PIN 必须在这次请求里** ✓（走 requirePinOr403 ✓ → 它会回 `needPin: true` ✓，
		 *      手机据此弹输入框 ✓；2026-10-13 真机日志的教训：**"登录一次"不算** ✗）；
		 *   ③ **单步执行** ✓（不像关机那样要点两次 ✓）—— 它本来就"能救" ✓：再锁一次就回去了 ✓。
		 * ⚠️ 它**不收也不存密码** ✗（见 lib/platform.js 顶部 ✓）：只发一次无害唤醒输入 ✓，
		 *    然后**看结果再说话** ✓（已解锁 / 还锁着要密码 / 读不到状态 ✓）。
		 */
		if (action === UNLOCK) {
			if (processControlFlag('powerControl') !== true) {
				sendJson(res, 403, { error: '解锁默认关闭 —— 在 mobile-bridge.json 里加 "powerControl": true 再试（改完立刻生效）' })
				return
			}
			if (await requirePinOr403(req, res, body, { what: '解锁电脑', code: 'power-unlock', why: '它等于把人放进来' }) !== true) return
			/*
			 * ⚠️ 2026-10-13 **红队复查逮到的第二处** ✗：锁屏有 3 秒闸 ✓，解锁**一条都没有** ✗ ——
			 * 拿得到 PIN 的人可以高频重复拉唤醒（每次一个 powershell + 1.5 秒等待 + 一次查询 ✓），
			 * 还能跟**免 PIN 的锁屏**组成"锁-解-锁"循环骚扰正坐在电脑前的人 ✗。
			 * 现在：同款 3 秒最短间隔 + 单飞（上一次没跑完就直接 429 ✓）。
			 */
			if (Date.now() - Number(state.lastUnlockAt ?? 0) < 3000) {
				sendJson(res, 429, { error: '刚试过 —— 隔 3 秒再试（防被反复唤醒）' })
				return
			}
			if (state.unlocking === true) {
				sendJson(res, 429, { error: '上一次唤醒还在进行 ✓ 稍等一下再点' })
				return
			}
			state.lastUnlockAt = Date.now()
			state.unlocking = true
			let unlocked
			try {
				unlocked = await runUnlock()
			} finally {
				state.unlocking = false   // 单飞标记**必须**在 finally 里清 ✓（不然一次异常就永久卡住 ✗）
			}
			// 日志只记**结论** ✓（已解锁 / 还锁着 / 读不到 ✓）—— 不记任何凭据 ✗（我们本来也不收 ✓）。
			record(`解锁：${unlocked.state} <- ${ip}`)
			sendJson(res, 200, { ok: unlocked.ok === true, state: unlocked.state, message: unlocked.message })
			return
		}
		if (powerCommand(action, POWER_DELAY_SECONDS) === null) {
			sendJson(res, 400, { error: 'action 只能是 lock / shutdown / restart / cancel' })
			return
		}

		// 锁屏（2.7.1 冷视角复查 **#2**）：往安全方向走**不等于**可以把开关交给别人 ✗ ——
		// 原来"拿着会话 cookie 的人就能反复锁你的电脑、解锁后再锁、而且一个字都不记" ✓。
		// 现在：3 秒最短间隔 + 每次记一行日志 ✓。
		if (action === LOCK) {
			if (Date.now() - Number(state.lastLockAt ?? 0) < 3000) {
				sendJson(res, 429, { error: '刚锁过 —— 隔 3 秒再试（防被人反复锁屏）' })
				return
			}
			state.lastLockAt = Date.now()
			record(`锁屏 <- ${ip}`)
		}

		// 取消关机：**安全方向**的动作（只是撤掉一次还没执行的关机 ✓），不用 PIN ✓。
		if (action === CANCEL) {
			const result = await runPower(CANCEL)
			state.power = null
			record(`取消关机/重启 <- ${ip}`)
			sendJson(res, result.ok === true ? 200 : 409, result.ok === true
				? { cancelled: true, message: '已经取消' }
				: { error: `没有可取消的关机（或者系统拒绝了）：${result.message}` })
			return
		}

		if (action !== LOCK) {
			// 关机/重启：默认关 + 现输 PIN（和"删除会话""结束进程"同一套 ✓）。
			if (processControlFlag('powerControl') !== true) {
				sendJson(res, 403, { error: '关机 / 重启默认关闭 —— 在 mobile-bridge.json 里加 "powerControl": true 再试（改完立刻生效）' })
				return
			}
			if (!sameSecret(String(body.pin ?? ''), state.config.pin)) {
				if (!throttleLogin(ip)) {
					sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' })
					return
				}
				warn(`failed PIN attempt (power) from ${ip}`)
				record(`${action === SHUTDOWN ? '关机' : '重启'}：PIN 不正确 <- ${ip}`)
				noteLoginFailure({ ip, ua: userAgentOf(req), what: action === SHUTDOWN ? 'shutdown' : 'restart' })
				sendJson(res, 403, { error: 'PIN 不正确 —— 没有执行任何动作' })
				return
			}
			state.attempts.delete(ip)
		}

		// dryRun：只回报"会跑哪条命令" ✓（测试用它，免得为了验一次真去关机 ✗）。
		if (body.dryRun === true) {
			const command = powerCommand(action, POWER_DELAY_SECONDS)
			sendJson(res, 200, { dryRun: true, action, command: `${command.file} ${command.args.join(' ')}` })
			return
		}

		const result = await runPower(action, POWER_DELAY_SECONDS)
		if (result.ok !== true) {
			sendJson(res, 500, { error: `没执行成功：${result.message}` })
			return
		}
		if (action === SHUTDOWN || action === RESTART) {
			state.power = { kind: action, at: Date.now(), seconds: POWER_DELAY_SECONDS }
			record(`${action === SHUTDOWN ? '关机' : '重启'}已排定（${POWER_DELAY_SECONDS} 秒后执行，可取消）<- ${ip}`)
			sendJson(res, 200, {
				ok: true,
				action,
				seconds: POWER_DELAY_SECONDS,
				message: `已排定：${POWER_DELAY_SECONDS} 秒后${action === SHUTDOWN ? '关机' : '重启'} —— 这期间可以点「取消」`,
			})
			return
		}
		record(`锁屏 <- ${ip}`)
		sendJson(res, 200, { ok: true, action: LOCK, message: '已锁屏' })
	}

	/*
	 * ---------------------------------------------------------------- 4.13.0「定时开机」
	 *
	 * 用户 2026-10-16 原话：「既然有关机那么可以做一个对应的定时开机功能」✓。
	 *
	 * ⚠️ 这条路**必须分层说** ✗（本项目底线：做不到就说做不到 ✓ —— 尤其是"开机"这种事 ✓）：
	 *   · **睡眠 (S3)**：能 ✓（系统还活着 ✓，计划任务带 `WakeToRun` 就有权把它叫醒 ✓）——
	 *     这是这一版**真的做出来**的那一半 ✓；
	 *   · **休眠 (S4)**：本来也能 ✓，但这台机器上休眠**没启用** ✗（照实说 ✓）；
	 *   · **完全关机 (S5)**：**软件做不到** ✗✗ —— 系统没在运行 ✓，任何软件都不存在 ✓。
	 *     只能靠主板 BIOS/UEFI 的 RTC 定时开机 ✓；而且"BIOS 里设没设"Windows **查不到** ✗。
	 *     ⇒ 所以这里**不摆那个键** ✗，并且**谁来问都如实拒绝** ✓（见下面 `poweron` 那一支 ✓）。
	 *
	 * 门禁照"关机 / 重启"那一套 ✓（用户交接文档点名 ✓）：`guardWrite()`（PIN 提权 ✓）+
	 * 配置里 `powerControl: true`（**默认关** ✓、现读 ✓）。读的那条只走 `guard()` ✓（它不改任何东西 ✓）。
	 *
	 * ⚠️ 交接文档里原话是"`powercfg /waketimers` 要提权 → 走 `elevationMinutes` + PIN 就行" ✗ ——
	 * **这一版把它改对了** ✓：`elevationMinutes` 只是"最近输过 PIN"的窗口 ✓，**不是** Windows 管理员
	 * 权限 ✗（`elevated(req)` 见上 ✓），插件跑在普通用户下 ✓、也不该偷偷提权 ✗。
	 * 所以：**能读就读 ✓；读不到就照实说"要管理员、读不到"** ✓，绝不把它当成"没有唤醒定时器" ✗。
	 */
	const WAKE_OFF = '定时开机默认关闭 —— 它挂在「关机 / 重启」那个开关上：在 mobile-bridge.json 里加 "powerControl": true 再试（改完立刻生效，不用重启）✓'
	const WAKE_S5_ERROR = '完全关机之后到点开机，**软件做不到** ✗ —— 那时候系统没在运行 ✓，任何软件都不存在 ✓。'
		+ '只能靠主板 BIOS/UEFI 里的 RTC 定时开机（各家叫法：RTC Alarm Power On / Resume by RTC Alarm / Wake on RTC / Power On By RTC ✓），设好之后不需要任何软件 ✓；'
		+ '而"BIOS 里设没设"，Windows 这边**查不到** ✗ —— 只能开机时自己进 BIOS 看一眼 ✓。'
	const WAKE_TRUTH = {
		sleep: '睡眠 (S3) 能自己醒 ✓ —— 那时系统还活着 ✓，"唤醒定时器"才有权把机器叫醒 ✓',
		shutdown: '完全关机 (S5) **软件做不到** ✗ —— 系统没在运行，任何软件都不存在 ✓，只能去主板 BIOS 里设 RTC 定时开机 ✓',
		hibernate: '休眠 (S4) 本来也能 ✓，但这台机器上休眠**没启用** ✗（`powercfg /a` 里写着「尚未启用休眠」✓）',
		biosUndetectable: 'BIOS 里设没设，Windows 这边**查不到** ✗（没有这个接口 ✓）—— 只能开机时自己进 BIOS 看一眼 ✓',
		biosNames: ['RTC Alarm Power On', 'Resume by RTC Alarm', 'Wake on RTC', 'Power On By RTC'],
	}

	async function handleWakeInfo(res) {
		const enabled = processControlFlag('powerControl') === true
		let info = null
		let error = ''
		try {
			info = await readWakeInfo()
		} catch (thrown) {
			error = String(thrown?.message ?? thrown)
		}
		sendJson(res, 200, {
			enabled,
			note: enabled
				? '定时开机已开启 ✓：写一个时刻（只响一次 ✓，再设一个就换掉它 ✓），到点在**睡眠**里把机器叫醒 ✓。完全关机之后开机，软件做不到 ✗。'
				: WAKE_OFF,
			truth: WAKE_TRUTH,
			policyCommand: WAKE_POLICY_COMMAND,
			taskName: WAKE_TASK_NAME,
			// ⚠️ 读不到就**明说读不到** ✓（`error` 非空 + 下面几项是 null ✓）—— 这是这一段最要紧的一条 ✗。
			error,
			task: info === null ? null : info.task,
			policy: info === null ? null : info.policy,
			wakeTimers: info === null ? null : info.wakeTimers,
		})
	}

	async function handleWakeAction(req, res) {
		const ip = clientIp(req)
		if (processControlFlag('powerControl') !== true) {
			sendJson(res, 403, { error: WAKE_OFF })
			return
		}
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const action = String(body?.action ?? '')
		/*
		 * 🔴 「完全关机后到点开机」这一类动作：**一个字都不许含糊** ✗ —— 如实拒绝 ✓。
		 * 为什么连"键"都不摆还要留着这支分支 ✓：因为**接口是公开的** ✓（任何客户端都能 POST ✓），
		 * 要是这里落到"不认识的 action"里一并 400 ✓，回复里就没有"为什么做不到"那句话 ✗ ——
		 * 而"为什么"正是这一版最该说清的东西 ✓（`test/harness.mjs` 有一条用例专门盯着它 ✓）。
		 */
		if (action === 'poweron' || action === 'boot' || action === 'on' || action === 'wakeFromShutdown') {
			record(`定时开机：**拒绝**了"关机后开机"这个动作（软件做不到 ✓）<- ${ip}`)
			sendJson(res, 400, { ok: false, impossible: true, error: WAKE_S5_ERROR, biosNames: WAKE_TRUTH.biosNames })
			return
		}
		if (action === 'set') {
			const parsed = parseWakeAt(String(body?.at ?? ''))
			if (parsed.ok !== true) {
				sendJson(res, 400, { error: parsed.error })
				return
			}
			// dryRun：只回报"会设成什么" ✓（测试用它 ✓ —— 免得为了验一次在用户机器上真的建任务 ✓）。
			if (body.dryRun === true) {
				let policy = null
				try { policy = (await readWakeInfo()).policy } catch { policy = null }
				sendJson(res, 200, {
					dryRun: true, action, taskName: WAKE_TASK_NAME, at: parsed.iso, atText: parsed.text, rolled: parsed.rolled,
					wakeToRun: true, executable: 'powershell.exe',
					command: `Register-ScheduledTask -TaskName ${WAKE_TASK_NAME} -WakeToRun -At ${parsed.iso} -Force`,
					policy, truth: WAKE_TRUTH,
				})
				return
			}
			// 3 秒最短间隔 + 单飞（照「解锁」那两条 ✓ —— 建任务要起一个 PowerShell ✓，别让人高频拉 ✓）。
			if (Date.now() - Number(state.lastWakeAt ?? 0) < 3000) {
				sendJson(res, 429, { error: '刚设过 —— 隔 3 秒再试 ✓' })
				return
			}
			if (state.waking === true) {
				sendJson(res, 429, { error: '上一次还在设 ✓ 稍等一下再点' })
				return
			}
			state.lastWakeAt = Date.now()
			state.waking = true
			let result
			try {
				result = await setWakeTask(parsed.iso)
			} finally {
				state.waking = false   // 单飞标记**必须**在 finally 里清 ✓（不然一次异常就永久卡住 ✗）
			}
			if (result.ok !== true) {
				record(`定时唤醒：设 ${parsed.text} **没成功** <- ${ip}`)
				sendJson(res, 500, {
					ok: false,
					error: '没能建上那个计划任务（或者建上了、但回读不到"唤醒"标志）✗ —— 没有假装成功 ✓',
					task: result.task,
				})
				return
			}
			record(`定时唤醒：设到 ${parsed.text}（本机时间 ✓）<- ${ip}`)
			sendJson(res, 200, {
				ok: true, action, taskName: WAKE_TASK_NAME, at: parsed.iso, atText: parsed.text, rolled: parsed.rolled,
				rolledNote: parsed.rolled === 'tomorrow'
					? '你写的那个点今天已经过了 ✓ → 定到了**明天** ✓（说一声，免得你以为定在今天 ✗）'
					: parsed.rolled === 'year' ? '你写的那一天今年已经过了 ✓ → 定到了**明年**那一天 ✓' : '',
				task: result.task,
				message: `已设好：${parsed.text} 到点唤醒 ✓（只响一次 ✓；要改就再设一个 ✓）`,
			})
			return
		}
		if (action === 'clear') {
			const result = await clearWakeTask()
			if (result.gone !== true) {
				record(`定时唤醒：取消失败 <- ${ip}`)
				sendJson(res, 500, { ok: false, error: '那个计划任务还在 ✓ —— 没能删掉 ✗（没有假装删掉 ✓）' })
				return
			}
			record(`定时唤醒：取消${result.wasThere === true ? '' : '（本来就没有 ✓）'} <- ${ip}`)
			sendJson(res, 200, {
				ok: true, action, removed: result.wasThere === true,
				message: result.wasThere === true ? '已经取消了 ✓（删完回读确认过 ✓）' : '本来就没有这个定时唤醒 ✓',
			})
			return
		}
		sendJson(res, 400, { error: '不认识的 action：' + action, actions: ['set', 'clear'] })
	}

	/* ---------------------------- 剪贴板 & 截屏（2.7.0 池子里的 ★4） */
	/*
	 * 文档原话：「电脑截图 → 手机立刻看到 ✓；手机复制的文字 → 进电脑剪贴板 ✓」。
	 * 实现与安全要点见 lib/clipboard.js 开头（**内容走 stdin**、截图用完即删 ✓）。
	 *
	 * 为什么剪贴板不要 PIN：能拿到这台手机 + 登录态的人，本来就能给 agent 发指令（那更狠 ✓）——
	 * 多一道 PIN 只是让"把手机上的验证码粘到电脑上"这种日常动作变烦 ✗。代价是**记一行日志** ✓，
	 * 出问题时 `mobile-bridge.log` 里看得见谁、什么时候 ✓。
	 */
	/*
	 * 剪贴板 & 截屏（2.7.0 ★4）+ **2.7.3 收紧：要现输 PIN** ✓（2026-10-12 用户拍的决定）。
	 *
	 * 为什么改：这两样是"cookie 泄漏 ≈ 拿到你的屏幕和剪贴板"（剪贴板里可能是密码/验证码 ✓）。
	 * 复查时它被列为**设计取舍** ✓，用户看过之后选了"**要 PIN**" ✓，那就照办 ✓：
	 * `POST` 从 body 读 `pin` ✓；`GET` 从 **`x-dsh-pin` 头**读 ✓ ——
	 * **绝不放进 URL** ✗（URL 会进日志/历史/Referer ✓）。
	 *
	 * ⚠️ 3.0.0 冷视角复查抓到的一个**功能性漏洞**（这条以前一直没被发现 ✓）：
	 * 403 里必须带 **`needPin: true`** ✗ —— 手机端只在看到这个字段时才**把 PIN 门弹出来** ✓
	 * （`mobile.html` 的 api() 分支 ✓）；不带的话用户只看到一行"要 PIN"的字 ✓、
	 * **没有任何地方能输入 PIN** ✗。云端语音转写也走这个函数 ✓ ——
	 * 那就会出现"文案写着要输 PIN、注释写着要输 PIN、harness 也写着要输 PIN，就是接不上" ✓
	 * （复查原话 ✓）。剪贴板/截屏当年也一直是这个状态 ✓，一并修掉 ✓。
	 */
	async function requirePinOr403(req, res, body, subject = { what: '剪贴板/截屏', code: 'clipboard-or-screen', why: '剪贴板可能有密码，屏幕更是整屏' }) {
		const ip = clientIp(req)
		const pin = String(body?.pin ?? req.headers['x-dsh-pin'] ?? '')
		if (pin !== '' && sameSecret(pin, state.config.pin)) {
			state.attempts.delete(ip)
			return true
		}
		if (!throttleLogin(ip)) {
			sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' })
			return false
		}
		if (pin === '') {
			/* 复查（第 83 轮）R12：这句与下面的审计行原来**写死了"剪贴板/截屏"** ✗ ——
			 * 3.4.0 的 webhook 测试投递也走这个函数 ✓，于是手机上会看到"剪贴板可能有密码"这种对不上的话 ✗。
			 * 现在按调用方给的主题说人话 ✓（默认值与原样一字不差 ✓，剪贴板那两条路不受影响 ✓）。 */
			sendJson(res, 403, { needPin: true, error: `这一项要 PIN —— 在手机上输一次才看得到（${subject.why}）✓` })
			return false
		}
		warn(`failed PIN attempt (${subject.code}) from ${ip}`)
		record(`${subject.what}：PIN 不正确 <- ${ip}`)
		noteLoginFailure({ ip, ua: userAgentOf(req), what: subject.code })
		// 同上：**PIN 输错也要带 `needPin: true`** ✓ —— 手机要能再弹一次输入框让用户重输 ✓
		//（不带的话，"输错一次"就变成"这条路从此没有任何入口" ✓）。
		sendJson(res, 403, { needPin: true, error: 'PIN 不正确 —— 没有给出任何内容' })
		return false
	}

	async function handleClipboardGet(req, res) {
		if (await requirePinOr403(req, res) !== true) return
		const result = await readClipboard()
		if (result.ok !== true) {
			sendJson(res, 503, { error: `读不到电脑剪贴板：${result.error}` })
			return
		}
		sendJson(res, 200, { text: result.text, length: result.text.length })
	}

	async function handleClipboardSet(req, res) {
		const ip = clientIp(req)
		let body
		try {
			body = await readBody(req, 256 * 1024)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		if (await requirePinOr403(req, res, body) !== true) return
		if (typeof body.text !== 'string') {
			sendJson(res, 400, { error: '缺少 text' })
			return
		}
		const result = await writeClipboard(body.text)
		if (result.ok !== true) {
			sendJson(res, 503, { error: `写不进电脑剪贴板：${result.error}` })
			return
		}
		record(`写电脑剪贴板：${result.bytes} 字节 <- ${ip}`)
		sendJson(res, 200, { ok: true, bytes: result.bytes, message: '已经放进电脑剪贴板了' })
	}

	/* --------- 语音转文字（3.0.0 ★③「语音往返」：说 → 文字）--------- */
	/*
	 * 上游查实（2026-10-12，用的是**只读 inspect** ✓，没有猜）：
	 * 宿主有 `speechController`（`@deepseek-ai/dsh-experimental-api-speech-to-text` ✓），
	 * 而且**在当前 profile 里是活的** ✓ —— 契约：
	 *   · `catalog()` → 可用识别器 + 默认选择 + **录制上限**（`maxAudioBytes` / `maxDurationSeconds` ✓）；
	 *   · `transcribe({ audioBase64, providerId?, language? }, signal)` → 纯转写 ✓，
	 *     **不往会话里加事件** ✓（原文：final transcript without adding a Session event ✓）——
	 *     正是"说出来 → 变成文字，发不发由我自己按"要的语义 ✓；
	 *   · `prepare(providerId)` / `follow(signal)` → 第一次用可能要下模型 ✓。
	 *
	 * 四条纪律（都是这个项目反复踩出来的 ✓）：
	 *   ① 服务**可能不在**（实验性、可能没启用 ✓）→ `ctx.get()` + undefined 检查 ✓，
	 *      不在就**如实说"这台电脑没开语音"** ✓，绝不假装转出一个空字符串 ✗；
	 *   ② 识别器可能是**云的** ✓（`location: 'cloud'` ✓）→ 那种情况音频会离开这台电脑 ✗ →
	 *      **必须现输 PIN** ✓（和剪贴板/截屏同一档 ✓）；本地的登录即可 ✓；
	 *   ③ 超上限**先拒再传** ✓（宿主的 `maxAudioBytes` 是硬闸 ✓），并说清大概多少 MB ✓；
	 *   ④ 日志里**只记字数与秒数** ✓，**绝不记转出来的内容** ✗（那可能是家里的对话 ✓）。
	 */
	const MAX_TRANSCRIBE_BODY = 24 * 1024 * 1024
	const TRANSCRIBE_TIMEOUT_MS = 120000

	const speechService = () => { try { return ctx.get('speechController') } catch { return undefined } }

	const speechUnavailable = (res) => sendJson(res, 200, {
		ok: true,
		available: false,
		message: '这台电脑没开语音转文字（宿主的语音服务没启用）—— 语音那一条先按「录音发过去」用 ✓',
	})

	async function handleSpeech(res) {
		const speech = speechService()
		if (speech === undefined || typeof speech.catalog !== 'function') return speechUnavailable(res)
		try {
			const catalog = speech.catalog()
			sendJson(res, 200, {
				ok: true,
				available: true,
				providers: (catalog?.providers ?? []).map((item) => ({
					id: String(item?.id ?? ''),
					name: String(item?.name ?? ''),
					location: String(item?.location ?? ''),          // 'host-local' | 'cloud'
					languages: Array.isArray(item?.languages) ? item.languages.slice(0, 12).map((one) => String(one)) : [],
					phase: String(item?.preparation?.phase ?? ''),   // unprepared / downloading / ready / failed…
					message: String(item?.preparation?.message ?? ''),
				})),
				selection: {
					providerId: String(catalog?.selection?.providerId ?? ''),
					language: String(catalog?.selection?.language ?? ''),
				},
				maxAudioBytes: Number(catalog?.maxAudioBytes ?? 0),
				maxDurationSeconds: Number(catalog?.maxDurationSeconds ?? 0),
			})
		} catch (error) {
			sendJson(res, 503, { error: `读不到语音设置：${String(error?.message ?? error)}` })
		}
	}

	/** 第一次用要"准备识别器"（下模型之类 ✓）——单独一条路，手机可以看着进度 ✓。 */
	async function handleSpeechPrepare(req, res) {
		const speech = speechService()
		if (speech === undefined || typeof speech.prepare !== 'function') return speechUnavailable(res)
		let body
		try { body = await readBody(req, 64 * 1024) } catch { sendJson(res, 400, { error: 'bad request' }); return }
		let catalog = null
		try { catalog = speech.catalog() } catch { catalog = null }
		const providerId = String(body?.providerId ?? catalog?.selection?.providerId ?? '')
		if (providerId === '') { sendJson(res, 400, { error: '认不出要用哪个识别器（宿主没给默认值）' }); return }
		try {
			/*
			 * ⚠️⚠️ **必须 await** ✗✗（3.0.0 冷视角复查抓到的**崩溃级** bug）：
			 * 宿主这个 `prepare` 是 **async** ✓，而它的失败是这条路的**常态** ✓
			 *（"第一次用要下模型" —— 下不动/没网/被墙都会 reject ✓）。
			 * 第一版没 await ✓ → 那个 rejection **逃出这个 try/catch** ✓ →
			 * unhandled rejection → Node ≥15 默认 `--unhandled-rejections=throw` →
			 * **整个 DSH 进程被打死** ✓（而同一刻我们已经回了"已经开始准备了 ✓" ✓，
			 * 用户看到的是"手机上说着准备、电脑上整个掉线" ✓）。
			 * 这个形状本项目踩过两次（`authed()` 里 `record` 被遮蔽那次也是"一按就打死整个进程" ✓）。
			 */
			await speech.prepare(providerId)
			record(`语音：准备识别器 ${providerId} <- ${clientIp(req)}`)
			sendJson(res, 200, { ok: true, providerId, message: '已经开始准备了（第一次用要下模型，慢的话几分钟）✓' })
		} catch (error) {
			sendJson(res, 503, { error: `准备不了：${String(error?.message ?? error)}` })
		}
	}

	async function handleTranscribe(req, res) {
		const speech = speechService()
		if (speech === undefined || typeof speech.transcribe !== 'function') {
			sendJson(res, 503, { error: '这台电脑没开语音转文字（宿主的语音服务没启用）' })
			return
		}
		let body
		try {
			body = await readBody(req, MAX_TRANSCRIBE_BODY)
		} catch {
			sendJson(res, 413, { error: `录音太大了（上限 ${Math.round(MAX_TRANSCRIBE_BODY / 1024 / 1024)} MB）—— 短一点再试 ✓` })
			return
		}
		const audioBase64 = String(body?.audioBase64 ?? '')
		if (audioBase64 === '') {
			sendJson(res, 400, { error: '缺少 audioBase64（要 16k 单声道 WAV 的 base64）' })
			return
		}
		let catalog = null
		try { catalog = speech.catalog() } catch { catalog = null }
		const providerId = String(body?.providerId ?? catalog?.selection?.providerId ?? '')
		const provider = (catalog?.providers ?? []).find((item) => String(item?.id ?? '') === providerId) ?? null
		const location = String(provider?.location ?? '')
		// 云识别器 = 音频要出这台电脑 ✗ → 现输 PIN ✓（本地识别器不拦 ✓）。
		if (location === 'cloud' && await requirePinOr403(req, res, body) !== true) return
		// ③ 超上限先拒 ✓（base64 约为原始字节的 4/3 ✓）。
		const maxBytes = Number(catalog?.maxAudioBytes ?? 0)
		const estimated = Math.floor(audioBase64.length * 3 / 4)
		if (maxBytes > 0 && estimated > maxBytes) {
			sendJson(res, 413, {
				error: `这段录音约 ${Math.round(estimated / 1024 / 1024 * 10) / 10} MB，超过宿主的单次上限 `
					+ `${Math.round(maxBytes / 1024 / 1024 * 10) / 10} MB —— 说短一点再试 ✓`,
			})
			return
		}
		const language = String(body?.language ?? catalog?.selection?.language ?? '')
		try {
			const transcript = await speech.transcribe({
				audioBase64,
				...(providerId === '' ? {} : { providerId }),
				...(language === '' ? {} : { language }),
			}, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS))
			const text = String(transcript?.text ?? '')
			// ④ 只记字数/秒数，**不记内容** ✗。
			record(`语音转文字：${text.length} 字 / ${Math.round(Number(transcript?.audioSeconds ?? 0))} 秒音频 / ${location || '未知位置'} <- ${clientIp(req)}`)
			sendJson(res, 200, {
				ok: true, text,
				audioSeconds: Number(transcript?.audioSeconds ?? 0),
				inferenceSeconds: Number(transcript?.inferenceSeconds ?? 0),
				providerId, location,
			})
		} catch (error) {
			// 第一次用最常见的失败是"识别器还没准备好" ✓ —— 把"怎么办"一起说了 ✓。
			sendJson(res, 503, {
				error: `转写失败：${String(error?.message ?? error)}`,
				...(String(provider?.preparation?.phase ?? '') === 'unprepared'
					? { hint: '识别器还没准备好（第一次用要下模型）—— 在手机上点「准备识别器」再试 ✓' }
					: {}),
			})
		}
	}

	/* --------- 多端授权（3.0.0 ★④）--------- */
	/*
	 * 手机侧只看这一条 ✓：我到底"能用了"还是"还在等" ✓。
	 * ⚠️ 它必须**登录之外**单独判 ✓（等放行的设备 `authed()` 是 false ✓）——
	 * 所以这里直接读 cookie 里的令牌 ✓，只回"是不是等放行"这一件事 ✓（不回任何别的数据 ✓）。
	 */
	function handlePending(req, res) {
		const token = parseCookies(req.headers.cookie)[COOKIE]
		const tokenRecord = typeof token === 'string' && token !== '' ? state.sessions.get(token) : undefined
		if (tokenRecord === undefined || tokenRecord.expiresAt < Date.now()) {
			sendJson(res, 401, { error: 'unauthorized' })
			return
		}
		const pending = tokenRecord.approved === false
		sendJson(res, 200, {
			ok: true,
			pending,
			approved: pending !== true,
			deviceApproval: deviceApprovalEnabled() === true,
			waiting: pending === true ? pendingDevices().length : 0,
			message: pending === true
				// ⚠️ 3.3.2 修（与 403 页同一类 ✗）：这里原来印的是 `http://127.0.0.1:<端口>/approve` ✓
				//   —— **漏了 pathSecret** ✗（照它打是 404 ✓），而这个地址就在手机"等放行"那一屏上 ✓。
				//   现在按**当前配置**拼完整地址 ✓（`withSecret` 是幂等的 ✓，别手拼 ✗）。
				? `这台设备还在等放行：请在**电脑上**打开 DSH 的徽标页（或 ${withSecret(state.config, `http://127.0.0.1:${state.port ?? state.config?.port ?? 3081}`)}approve）点一次「放行」✓`
				: '已经可以用了 ✓',
		})
	}

	/**
	 * 放行页 ✓ —— **只给电脑本机**（loopback ✓）。
	 *
	 * 为什么用 loopback 当"本人"的凭据 ✗：手机（Tailscale / 局域网）不是 loopback ✓，
	 * 只有**坐在这台电脑前**的人打得开 ✓ —— 这比"再输一次 PIN"更接近"本人" ✓
	 * （PIN 可能被别人看见 ✓，而这台电脑就在你手边 ✓）。
	 */
	function handleApprovePage(req, res, url) {
		if (fromThisComputer(req) !== true) {
			// 不是本机（含**隧道转进来的公网请求** ✗）：**明说**去电脑上做 ✓
			//（不假装成功 ✓，也不给任何放行入口 ✗）。
			res.statusCode = 403
			res.setHeader('content-type', 'text/html; charset=utf-8')
			// 把**可点的本机地址**直接给出来 ✓（复查提醒：写"用域名打开"的用户会顺手点徽标里那条
			// 公网地址 ✓ → 403 → 以为功能坏了 ✗，而这一页又没告诉他该用哪个 ✓）。
			// ⚠️ 3.3.2 修（用户实测）：这里原来给的是**不带 pathSecret** 的地址 ✗
			//   `http://127.0.0.1:3081/approve` → **404** ✗（路由实际挂在带前缀的地址上 ✓）
			//   → 用户照着这一页的提示点，永远打不开放行页 ✗（"怎么放都不行"就是这么来的 ✓）。
			const localPort = state.port ?? state.config?.port ?? 3081
			const localSecret = String(state.config?.pathSecret ?? '')
			const local = `http://127.0.0.1:${localPort}/${localSecret === '' ? '' : localSecret + '/'}approve`
			res.end('<!doctype html><meta charset="utf-8"><title>只能在电脑上放行</title>'
				+ '<body style="font:15px/1.7 system-ui,sans-serif;margin:0;padding:26px;background:#0f1620;color:#e8eef7">'
				+ '<h1 style="font-size:18px">放行只能在**这台电脑**上做</h1>'
				+ '<p style="color:#9fb3d0">你现在的地址不是本机 —— 手机、域名、局域网 IP 都会被拒 ✓（这是有意的 ✓：'
				+ '这一页的作用就是"必须有人坐在这台电脑前" ✓）。</p>'
				+ `<p>请在电脑上打开：<a style="color:#8ce0a0" href="${local}">${local}</a></p>`
				+ '</body>')
			return
		}
		const pending = pendingDevices()
		if (url.searchParams.get('action') === 'approve' || url.searchParams.get('action') === 'deny') {
			const approve = url.searchParams.get('action') === 'approve'
			const id = String(url.searchParams.get('id') ?? '')
			const found = decideDevice(id, approve)
			res.statusCode = 200
			res.setHeader('content-type', 'text/html; charset=utf-8')
			res.end(approvePageHtml(pending, found
				? (approve === true ? '已放行 ✓ 那台设备下一刷就能用 ✓' : '已拒绝 ✓ 那台设备现在进不来 ✓')
				: '没找到那台设备（可能已经过期或已被处理 ✓）'))
			return
		}
		res.statusCode = 200
		res.setHeader('content-type', 'text/html; charset=utf-8')
		res.end(approvePageHtml(pending, ''))
	}

	function approvePageHtml(pending, note) {
		const esc = (text) => String(text ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
		const rows = pending.length === 0
			? '<p class="none">现在没有设备在等放行 ✓</p>'
			: pending.map((entry) => '<div class="row"><div><b>' + esc(entry.ua) + '</b><div class="meta">'
				+ esc(entry.ip) + ' · ' + new Date(entry.at).toLocaleString() + '</div></div>'
				+ '<div class="acts"><a class="ok" href="approve?action=approve&id=' + esc(entry.id) + '">放行</a>'
				+ '<a class="no" href="approve?action=deny&id=' + esc(entry.id) + '">拒绝</a></div></div>').join('')
		return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
			+ '<title>新设备放行 · 手机桥</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:24px;background:#0f1620;color:#e8eef7}'
			+ 'h1{font-size:18px;margin:0 0 6px}p{color:#9fb3d0;margin:6px 0}.note{color:#8ce0a0}'
			+ '.row{display:flex;justify-content:space-between;gap:12px;align-items:center;border:1px solid #26374d;border-radius:10px;padding:12px;margin:10px 0}'
			+ '.meta{color:#7f93ad;font-size:12px}.acts{display:flex;gap:8px;flex:none}'
			+ 'a{text-decoration:none;padding:6px 14px;border-radius:8px;font-weight:600}'
			+ '.ok{background:#2ecc71;color:#04213d}.no{background:#3a2530;color:#ffd7d7;border:1px solid #6b3a45}</style>'
			+ '<h1>有新设备想连上手机桥</h1>'
			+ '<p>只在这台电脑上打得开这一页 ✓ —— 确认是你在给新手机 / 新浏览器开门，再点「放行」✓。</p>'
			+ (note === '' ? '' : '<p class="note">' + esc(note) + '</p>')
			+ rows
	}

	/** 等放行清单（给电脑端徽标用 ✓）：**只在本机给** ✓。 */
	function handlePendingList(req, res) {
		if (fromThisComputer(req) !== true) {
			sendJson(res, 403, { error: '这个接口只在这台电脑上给（放行必须在电脑上做 ✓）' })
			return
		}
		sendJson(res, 200, { ok: true, enabled: deviceApprovalEnabled() === true, pending: pendingDevices() })
	}

	/**
	 * 3.0.0 ★④：这个请求**是不是真的坐在电脑前**发出来的 ✓。
	 *
	 * ⚠️ **不能只看 socket 地址** ✗✗ —— 这是个真洞的形状：隧道/代理都是**本机进程** ✓，
	 * 它把公网请求转发进来时 socket 对端可能是 127.0.0.1 ✓ → 只看 socket 的话，
	 * `/approve` 从**公网**也打得开 ✗ → 谁知道 PIN、谁就能自己给自己放行 ✓
	 *（而"新设备要你点头"防的正是**PIN 泄露**这一种 ✓，那就白做了 ✗）。
	 *
	 * ⚠️ **但本机实测的机制和"代理一定是本机"不一样** ✓（3.0.0 冷视角复查用只读探针实测 ✓，
	 * 结论写在这儿，免得下一个维护者按错的前提做判断 ✗）：
	 *   · 本机的公网入口是 **Tailscale Funnel**（`https://…ts.net -> proxy http://127.0.0.1:3081` ✓）；
	 *   · **经 Funnel 到达的请求，源站看到的对端是 tailnet 地址**（实测记成 `100.122.188.30` ✓，
	 *     **不是** 127.0.0.1 ✓），而且 Tailscale **不写** `x-forwarded-for` / `cf-connecting-ip` ✓；
	 *   · 我伪造 `x-forwarded-for: 127.0.0.1` 也**无效** ✓ —— 因为 `clientIp()` 对**非 loopback 对端
	 *     一律不看转发头** ✓（`clientIp` 第一行就 return ✓）。
	 * 所以：**公网打不开 `/approve`** ✓，靠的是"代理保留了源地址、且没注入转发头" ✓ ——
	 * 这是**实测事实** ✓，不是"代理是本机所以要看头"那个推理 ✓。
	 * ⚠️ 如果哪天换成 **cloudflared**，安全性就取决于"Cloudflare 边车会覆盖客户端自带的
	 * `cf-connecting-ip`"这一条 ✓（`clientIp()` 的注释里写着这个假设 ✓，但**没有实测过** ✗）——
	 * 换链接方式时请把这条重新验一遍 ✓。
	 */
	function fromThisComputer(req) {
		return isLoopbackPeer(clientIp(req)) === true
	}

	/* --------- 手机端面板协议（3.1.0「手机端可扩展」）--------- */
	/*
	 * 上游/环境无依赖 ✓ —— 这一层就是**文件 + 一条清单** ✓（协议与守卫都在 `lib/panels.js` ✓，单测在那儿 ✓）。
	 * ⚠️ 信任边界必须说清（代码和界面都要说 ✓）：面板与手机页**同源** ✓ → 它拿得到手机页的 cookie ✓，
	 * 也就是**装一个面板 = 把手机端的一切交给它** ✓。所以：
	 *   · 整个功能**默认关** ✗（`panels: true` 才开 ✓）；
	 *   · "谁能装"的边界 = "**谁能写这台电脑的 `~/.dsh`**" ✓ —— 那本来就是完全信任 ✓；
	 *   · 文件读取一律过 `safePanelFile()` ✓（`/panel/notes/../../mobile-bridge.json` 这种**绝不能读到** ✗）。
	 */
	const panelsBuiltinDir = join(HERE, 'panels')
	const panelsUserDir = () => join(dshHome(), 'mobile-panels')

	function panelsEnabled() {
		try {
			const fresh = JSON.parse(readFileSync(state.configFile, 'utf8'))
			return fresh?.panels === true
		} catch {
			return state.config?.panels === true
		}
	}

	/* --------- 3.5.0：把"目标"摆到手机上（**只读** ✓）--------- */
	/*
	 * 上游查实（2026-10-13 ✓，`cordis_inspect_query` 的 Service provider ✓）：
	 *   · `agents.get(sessionId)` → **活着的** agent ✓（`Agent = { id }` ✓）—— 是"查"不是"唤醒" ✓；
	 *   · `goals.get(agent)` → `GoalView | undefined` ✓（`@Remote('get')` ✓；
	 *     字段照契约 ✓：objective / phase / roundsStarted / maxGoalRounds / activation / revision / updatedAt ✓）。
	 * ⚠️ 三条纪律 ✓：
	 *   ① **只读** ✓（不 create / edit / pause / resume / complete / clear ✗ —— 那些会动目标的阶段与轮次 ✓，
	 *      属于"放宽动作" ✓，要另开一条路 + 现输 PIN ✓，这一版不做 ✗）；
	 *   ② 会话**没在跑**时 `agents.get` 给 undefined ✓ → 就**如实说"这条会话现在没在跑"** ✓，
	 *      绝不编一个目标、也绝不说成"这条会话没有目标" ✗（那是两件事 ✗）；
	 *   ③ 宿主没有 `goals` / `agents` 服务时 ✓，说清**是哪一环没有** ✓（不假装没有目标 ✗）。
	 */
	function goalViewOf(sessionId) {
		const optional = (name) => { try { return ctx.get(name) } catch { return undefined } }
		const agents = optional('agents')
		if (agents === undefined || typeof agents.get !== 'function') {
			return { ok: false, reason: '这台宿主没有 agents 服务 —— 读不到目标 ✓' }
		}
		const agent = agents.get(sessionId)
		if (agent === undefined) {
			return { ok: false, reason: '这条会话现在没在跑（目标是"活着的 agent"身上那份 ✓）—— 打开这条会话再刷新一次 ✓' }
		}
		const goals = optional('goals')
		if (goals === undefined || typeof goals.get !== 'function') {
			return { ok: false, reason: '这台宿主没有 goals 服务 —— 读不到目标 ✓' }
		}
		let view
		try { view = goals.get(agent) } catch (error) {
			return { ok: false, reason: '读目标失败（' + String(error?.code ?? error?.name ?? 'error') + '）✓' }
		}
		if (view === undefined || view === null) return { ok: true, goal: null, reason: '' }
		return {
			ok: true,
			reason: '',
			goal: {
				objective: String(view.objective ?? ''),
				phase: String(view.phase ?? ''),
				roundsStarted: Number(view.roundsStarted ?? 0),
				maxGoalRounds: Number(view.maxGoalRounds ?? 0),
				activation: String(view.activation ?? ''),
				revision: Number(view.revision ?? 0),
				updatedAt: Number(view.updatedAt ?? 0),
				...(view.blockedReason === undefined || view.blockedReason === null ? {} : {
					blockedReason: {
						code: String(view.blockedReason?.code ?? ''),
						message: String(view.blockedReason?.message ?? ''),
					},
				}),
			},
		}
	}

	function handleGoal(res, url) {
		const sessionId = String(url.searchParams.get('sessionId') ?? '')
		if (sessionId === '') { sendJson(res, 400, { error: '要带 sessionId ✓' }); return }
		const found = goalViewOf(sessionId)
		// 读不到就**说读不到 + 为什么** ✓ —— 绝不假装"这条会话没有目标"✗。
		sendJson(res, 200, {
			ok: found.ok === true,
			...(found.goal === undefined ? {} : { goal: found.goal }),
			...(found.reason === '' ? {} : { message: found.reason }),
		})
	}

	/* --------- 3.5.0：语音优先（免手对话）的开关 --------- */
	/*
	 * 为什么这一层要有服务端开关 ✗：免手对话 = **麦克风一直开着** ✓，那是隐私面 ✓（铁律：**默认关** ✓）。
	 * 服务端只做三件事 ✓：① 报"能不能开 / 还能开多久"✓；② 开的时候**要现输 PIN** ✓；
	 * ③ 拿一个**超时上限**兜住它 ✓（手机上也会倒计时 ✓ —— 两边都不许"开着麦克风没人知道"✗）。
	 * 切片 / 转写 / 拼接 / 播报全在手机侧 ✓（宿主没有流式识别 ✓，纯逻辑见 `lib/voice.js` ✓）。
	 */
	const VOICE_DEFAULT_MINUTES = 10
	const VOICE_MAX_MINUTES = 30

	/** 现读配置 ✓（和 `panels` / `deviceApproval` 同一口径 ✓：改完立刻生效 ✓）。 */
	function voiceModeEnabled() {
		try {
			const fresh = JSON.parse(readFileSync(state.configFile, 'utf8'))
			return fresh?.voiceMode === true
		} catch {
			// 读不到就沿用启动时那份 ✓（别因为文件半写就突然放宽 ✓）。
			return state.config?.voiceMode === true
		}
	}

	function voiceRemainingMs() {
		const until = Number(state.voice?.until ?? 0)
		return until > Date.now() ? until - Date.now() : 0
	}

	function handleVoice(res) {
		const enabled = voiceModeEnabled() === true
		const remainingMs = voiceRemainingMs()
		sendJson(res, 200, {
			ok: true,
			enabled,
			listening: remainingMs > 0,
			remainingMs,
			defaultMinutes: VOICE_DEFAULT_MINUTES,
			maxMinutes: VOICE_MAX_MINUTES,
			// 状态机的名字与顺序也发下去 ✓ —— 手机照着画 ✓，免得两边各写一份、慢慢对不上 ✗。
			states: VOICE_STATES,
			message: enabled === true
				? (remainingMs > 0 ? '语音模式开着 ✓（到点会自己关 ✓）' : '可以开 ✓ —— 开的时候要现输一次 PIN ✓')
				: '语音模式没开（在 ~/.dsh/mobile-bridge.json 里加 "voiceMode": true ✓）',
		})
	}

	/**
	 * 3.5.0：把**纯核心那份实现**发给手机页面 ✓（状态机 / 切片重叠拼接 / "停"的识别 ✓）。
	 * 为什么这么做 ✗：这些逻辑手机侧也要用 ✓（切片与拼接都发生在手机上 ✓，见 `lib/voice.js` 顶部 ✓）——
	 * 要是让 `mobile.html` 再抄一份 ✗，两边就会慢慢对不上 ✓（本项目为此吃过亏 ✓）。
	 * 所以：**一份实现，两边共用** ✓；只有登录后拿得到 ✓（它是纯函数 ✓，没有密钥 ✓）。
	 */
	function handleVoiceCore(res) {
		try {
			const code = readFileSync(join(HERE, 'voice.js'), 'utf8')
			res.statusCode = 200
			res.setHeader('content-type', 'text/javascript; charset=utf-8')
			res.setHeader('cache-control', 'no-store')
			res.setHeader('x-content-type-options', 'nosniff')
			res.end(code)
		} catch (error) {
			// 读不到就**说读不到** ✓（不发给页面一份空文件 → 那边 import 成功却什么都没导出 ✗）。
			sendJson(res, 500, { error: '读不到语音核心（' + String(error?.code ?? error?.name ?? 'error') + '）' })
		}
	}

	async function handleVoiceSet(req, res) {
		let body
		try { body = await readBody(req, 8 * 1024) } catch { sendJson(res, 400, { error: 'bad request' }); return }
		const action = String(body?.action ?? '')
		if (voiceModeEnabled() !== true) {
			// 关着也要**说清怎么开** ✓（和面板同一个口径 ✓ —— 别让人以为"我没有权限"✗）。
			sendJson(res, 403, { error: '语音模式没开（在 ~/.dsh/mobile-bridge.json 里加 "voiceMode": true ✓）' })
			return
		}
		if (action === 'stop') {
			// 「停」**不设门** ✓ —— 它是往安全方向走 ✓（和"收紧到只读"同一条规矩 ✓）。
			state.voice = { until: 0, startedAt: 0, by: '' }
			record(`语音模式：已停（${clientIp(req)}）`)
			sendJson(res, 200, { ok: true, listening: false, remainingMs: 0, message: '已停 ✓ 麦克风不再采集 ✓' })
			return
		}
		if (action !== 'start' && action !== 'extend') {
			sendJson(res, 400, { error: '不认识的动作（start / stop / extend ✓）' })
			return
		}
		// 开 / 续期都要**现输 PIN** ✓（和"读剪贴板 / 截屏"同级 ✓ —— 它开的是麦克风 ✓）。
		if (await requirePinOr403(req, res, body, { what: '开启语音模式（开麦克风）', code: 'voice-mode', why: '它会一直听着麦克风' }) !== true) return
		const wanted = Number(body?.minutes)
		/*
		 * ⚠️ 超上限**夹到上限** ✓，不要静默回默认值 ✗ —— 用户要 999 分钟却拿到 10 分钟，
		 * 只会觉得"怎么自己关了" ✓（手机那边会把分钟数显示出来 ✓，所以这里必须给实话 ✓）。
		 */
		const minutes = Number.isFinite(wanted) && wanted >= 1
			? Math.min(Math.floor(wanted), VOICE_MAX_MINUTES)
			: VOICE_DEFAULT_MINUTES
		const now = Date.now()
		state.voice = { until: now + minutes * 60 * 1000, startedAt: now, by: clientIp(req) }
		record(`语音模式：${action === 'extend' ? '续期' : '开启'} ${minutes} 分钟（${clientIp(req)}）`)
		sendJson(res, 200, {
			ok: true,
			listening: true,
			minutes,
			remainingMs: minutes * 60 * 1000,
			message: `${action === 'extend' ? '已续期' : '已开启'} ${minutes} 分钟 ✓ 到点会自己关 ✓`,
		})
	}

	/* --------- 开放接口：出站投递的"测一次"（3.4.0 第一刀）--------- */
	/*
	 * 为什么先做这个 ✓：webhook 最难自证的就是"到底发不发得出去" ✓ ——
	 * 给一个"**配之前先测一次**"的接口 ✓（`POST /api/webhook/test` ✓），
	 * 拿它验签名、验投递、验白名单 ✓。
	 *
	 * ⚠️ 复查（第 83 轮）R8.4：这里原来写着"**用户能在手机上当场看到结果** ✓" ✗ ——
	 * **手机侧没有任何 webhook 配置入口** ✓（复审第 83 轮 N4 校正：现在 `lib/mobile.html` 里只有一处
	 * 文案 `webhook-test` ✓ —— 那是 R12 给"登录失败原因"补的标签 ✓，**不是**配置界面 ✓；README 也如实写了 ✓）；
	 * 现在只有**接口**（curl / 别的程序调 ✓），说法按事实收 ✓。
	 *
	 * ⚠️ 按项目铁律 ✓：**默认关** ✗（`webhookUrl` 没配就什么都不发 ✓）、
	 * 配置与测试都要**现输 PIN** ✓（`requirePinOr403` ✓ 会带 `needPin: true` ✓，手机会弹输入框 ✓）；
	 * 日志**只记事件名与目标主机** ✓ —— **正文不记** ✗（那是会话相关的元信息 ✓）。
	 * ⚠️ 顺带记一条**如实**的口径 ✓：这个接口拿着 PIN 就能对任意 https 主机发一次固定正文的 POST
	 * 并拿到状态码 ✓ —— 在"解析后才内指"的域名（`*.nip.io` ✓）那条**已知缺口**没做之前 ✓，
	 * 它相当于一个**受 PIN 保护的 SSRF 探针** ✓（威胁模型里"能拿到 PIN = 已完全信任" ✓，但它不是零风险 ✓）。
	 */

	async function handleWebhookTest(req, res) {
		let body
		try { body = await readBody(req, 8 * 1024) } catch { sendJson(res, 400, { error: 'bad request' }); return }
		if (await requirePinOr403(req, res, body, { what: 'webhook 测试投递', code: 'webhook-test', why: '它会让电脑往外发一条请求' }) !== true) return
		const raw = String(body?.url ?? webhookConfig().url ?? '')
		const allowed = allowWebhookUrl(raw)
		if (allowed.ok !== true) {
			sendJson(res, 400, { error: '这个地址不能用：' + allowed.reason })
			return
		}
		const payload = buildWebhookPayload('webhook/test', { message: '这是手机桥发的一次测试投递 ✓' }, Date.now())
		const text = JSON.stringify(payload)
		const headers = webhookHeaders(payload.event, webhookConfig().secret, text, payload.at)
		try {
			const response = await fetch(allowed.url, {
				method: 'POST', headers, body: text, signal: AbortSignal.timeout(8000), redirect: 'manual',
			})
			// 日志只记"事件名 + 目标主机 + 状态码" ✓（正文不记 ✗）。
			record(`webhook 测试投递 <- ${clientIp(req)}：${payload.event} → ${new URL(allowed.url).host} (${response.status})`)
			sendJson(res, 200, {
				ok: true, delivered: response.status >= 200 && response.status < 300,
				status: response.status, target: new URL(allowed.url).host,
				signed: headers['x-dsh-signature'] !== undefined,
				payload,
			})
		} catch (error) {
			/*
			 * 复查（第 83 轮）R7：原来日志截 60 字、**回包却把 `error.message` 原样发出去** ✗ ——
			 * fetch 的凭据报错里带着**整个 URL**（含 `user:pass@` ✓）→ 等于把它回给了手机 ✗。
			 * 现在两边都说同一句人话 ✓（R7 已在白名单里先拒掉这种地址 ✓，这里是第二道 ✓）。
			 */
			const raw = String(error?.message ?? error)
			const reason = /includes credentials/.test(raw)
				? '地址里带了用户名/密码 —— 去掉 https://user:pass@ 这一段 ✓'
				: raw.slice(0, 80)
			record(`webhook 测试投递失败 <- ${clientIp(req)}：${payload.event}（${reason}）`)
			// 读不到就说读不到 ✓（不假装发成功 ✗）。
			sendJson(res, 502, { error: '发不出去：' + reason, target: new URL(allowed.url).host })
		}
	}

	async function handlePanels(res) {
		if (panelsEnabled() !== true) {
			// 关着就**如实说关着** ✓（回空数组 + 一句为什么 ✓ —— 不然"没有面板"和"功能没开"分不清 ✗）。
			sendJson(res, 200, { ok: true, enabled: false, panels: [], skipped: 0, message: '面板功能没开（在 mobile-bridge.json 里加 "panels": true ✓）' })
			return
		}
		const { panels, skipped, skippedReasons } = await collectPanels({ builtinDir: panelsBuiltinDir, userDir: panelsUserDir() })
		sendJson(res, 200, {
			ok: true, enabled: true, skipped,
			// 3.1.0 复查 M2/M3：**为什么没挂上**要说出来 ✓（旧版只有一个数字 ✓，
			// 用户看到"面板不见了 + skipped:0"= 零线索 ✗）。
			...(Array.isArray(skippedReasons) && skippedReasons.length > 0 ? { skippedReasons } : {}),
			panels: panels.map((panel) => ({ id: panel.id, title: panel.title, icon: panel.icon, kind: panel.kind, entry: panel.entry, builtin: panel.builtin })),
		})
	}

	async function handlePanelAsset(req, res, url) {
		if (panelsEnabled() !== true) { sendJson(res, 404, { error: 'not found' }); return }
		// URL 形如 `/panel/<id>/<相对路径>` ✓（route 已经把密钥段剥掉了 ✓）。
		const rest = url.pathname.replace(/^.*\/panel\//, '')
		const slash = rest.indexOf('/')
		if (slash <= 0) { sendJson(res, 404, { error: 'not found' }); return }
		const id = rest.slice(0, slash)
		let rel = rest.slice(slash + 1)
		try { rel = decodeURIComponent(rel) } catch { sendJson(res, 404, { error: 'not found' }); return }
		const { panels } = await collectPanels({ builtinDir: panelsBuiltinDir, userDir: panelsUserDir() })
		const panel = panels.find((item) => item.id === id)
		if (panel === undefined) { sendJson(res, 404, { error: 'no such panel' }); return }
		const asset = await readPanelAsset(panel.dir, rel)
		if (asset.ok !== true) {
			/*
			 * ⚠️ 复查 L5：面板资源出错时**不能走 `sendJson`** ✗ —— 它带 `x-frame-options: DENY` ✓，
			 * iframe 里导航到这种响应会被浏览器拒渲染 ✓ → 用户看到的是一屏**纯白** ✓，
			 * 连"为什么"都没有（会话过期 401 / 页面 >512KB 的 413 都会这样 ✓）。
			 */
			res.statusCode = asset.status
			res.setHeader('content-type', 'text/html; charset=utf-8')
			res.end('<!doctype html><meta charset="utf-8"><body style="font:15px/1.7 system-ui,sans-serif;padding:22px;background:#0f1620;color:#e8eef7">'
				+ '这个面板资源取不到：' + String(asset.error ?? 'not found').replace(/[<>&"]/g, '') + '（换个面板或刷新手机页试试 ✓）</body>')
			return
		}
		res.statusCode = 200
		res.setHeader('content-type', asset.type)
		res.setHeader('cache-control', 'no-store')
		// 复查 L9：和主页面/图标一样带上这两条 ✓（同一台服务器上只有面板资源不带的，本身就不一致 ✓）。
		res.setHeader('x-content-type-options', 'nosniff')
		res.setHeader('referrer-policy', 'no-referrer')
		res.end(asset.body)
	}

	/* --------- 个人知识库（3.3.0）：会话全文检索 --------- */
	/*
	 * 上游查实（第 30/32 轮 ✓）：`sessionController.search({ query })` ✓
	 * → `{ items: [{ sessionId, snippet }], hasMore }` ✓（**不会唤醒 agent** ✓）。
	 * ⚠️ 所以这一刀**不自建索引** ✗、**不自己造 limit** ✗ —— 宿主给多少就多少 ✓，`hasMore` 如实转 ✓。
	 * ⚠️ **await + catch 都要有** ✓（3.0.0 那次"漏 await 打死整个 DSH"的教训 ✓）。
	 */
	/**
	 * 3.3.0 复查抓到的**我自己的错** ✗✗：我以为"这台宿主的列表不带标题" ✓，于是把
	 * `row.title / name / label / projections.title / projections.name` 一路兜底 ✓ ——
	 * **全读错了** ✗。标题在 **`projections.values.title`** ✓（宿主契约 `SessionSummary` 里
	 * 根本没有 `title` 字段 ✓，标题在投影里 ✓）—— 桥自己的 `summarize()`（约 1892 行 ✓）**早就在读对的地方** ✓。
	 * 证据（复查实测）：同一次 `list()`，`/api/boot` 83 条标题**全非空** ✓，而我这条路由 43 条**全空** ✓，
	 * 其中 41 条在 boot 里有真标题 ✓。
	 * ⚠️ 这比"没标题"严重得多 ✓：我还把它当**宿主的缺陷**写进了 CHANGELOG/README/USERNEWS ✗
	 *（诚实性问题 ✓ —— 文档必须跟着改 ✓）。
	 */
	function titleOfSummary(row) {
		const values = row?.projections?.values
		if (values === null || typeof values !== 'object') return ''
		for (const key of Object.keys(values)) {
			if (key.toLowerCase().includes('title') !== true) continue
			const value = values[key]
			if (typeof value === 'string' && value.trim() !== '') return value.trim()
		}
		return ''
	}

	async function handleKnowledgeSearch(req, res, url) {
		const query = String(url.searchParams.get('q') ?? '').trim()
		if (query === '') { sendJson(res, 400, { error: '要搜什么？（给一个关键词 ✓）' }); return }
		if (query.length > 200) { sendJson(res, 400, { error: '关键词太长了（最多 200 字 ✓）' }); return }
		try {
			const value = await ctx.sessionController.search({ query }, AbortSignal.timeout(15000))
			/*
			 * 复查（第 53 轮）第 ① 条 ✗：「不假装」在"宿主给了、桥丢了"这条路上有个洞 ✓ ——
			 * 桥原来对形状不对的条目一律当空 ✓ 且静默丢掉 sessionId 为空的 ✓ →
			 * 手机就会说"没搜到" ✓，而其实是搜到了但桥读不懂 ✗（用户以为本地没内容 ✓）。
			 * 现在：raw/dropped 自证 ✓；全军覆没时直接 503 + 原话 ✓（不装"没结果" ✗）。
			 */
			const rawItems = Array.isArray(value?.items) ? value.items : []
			const items = rawItems.map((item) => ({
				sessionId: String(item?.sessionId ?? ''),
				snippet: String(item?.snippet ?? '').slice(0, 400),
			})).filter((item) => item.sessionId !== '')
			if (rawItems.length > 0 && items.length === 0) {
				sendJson(res, 503, { error: `搜到了 ${rawItems.length} 条，但桥读不懂它们的形状（这一版只认 sessionId+snippet）—— 与其显示"没搜到"，不如如实说 ✗` })
				return
			}
			// 会话标题：从已有的列表里对一下 ✓（列表本来就是桥在用的 ✓ —— 顺带给手机"点进去"用 ✓）。
			const titles = new Map()
			try {
				const listed = await ctx.sessionController.list({}, AbortSignal.timeout(8000))
				for (const row of Array.isArray(listed?.items) ? listed.items : []) {
					titles.set(String(row?.sessionId ?? ''), titleOfSummary(row))
				}
			} catch { /* 标题拿不到就不给标题 ✓ —— 结果本身照样能用 ✓（不假装 ✓） */ }
			sendJson(res, 200, {

				ok: true, query, hasMore: value?.hasMore === true,
				raw: rawItems.length, dropped: rawItems.length - items.length,
				items: items.map((item) => ({ ...item, title: titles.get(item.sessionId) ?? '',
						idShort: String(item.sessionId).replace(/^session-/, '').slice(0, 8) })),
			})
		} catch (error) {
			// 读不到就说读不到 ✓（这台 DSH 的检索没生效 / 会话太多超时 ✓），**不假装搜过了** ✗。
			sendJson(res, 503, { error: '搜不了：' + String(error?.message ?? error) })
		}
	}

/* --------- 个人知识库（3.3.0）：这周学了什么 --------- */
	/*
	 * 为什么先做这个 ✓：第 37 轮**真宿主实测**发现，本机的会话检索是**关的** ✗
	 * （`SessionQueryError: session search is disabled` ✓ —— 要另挂 `@deepseek-ai/dsh-session-query` ✓）。
	 * 而"按时间浏览 / 这周学了什么"**不依赖检索** ✓ —— 它只用**已经在用的** `list` ✓
	 *（2.7.0 就在调 ✓）→ 所以这一版**能用的部分**就是这个 ✓。
	 *
	 * ⚠️ 诚实边界：这是"**最近 N 天有活动的会话**" ✓，不是"真的读懂了学了什么" ✗ ——
	 * 标题空就说空 ✓（不编 ✗）；手机上再把这一段交给 agent 写总结是**下一步** ✓（这一版先如实列出 ✓）。
	 */
	async function handleKnowledgeWeek(res, url) {
		const raw = Number(url.searchParams.get('days') ?? '7')
		// 只允许 1–30 天 ✓（别让人传个 100000 天把列表全拉出来 ✓）。
		const days = Number.isFinite(raw) ? Math.min(30, Math.max(1, Math.round(raw))) : 7
		const since = Date.now() - days * 24 * 60 * 60 * 1000
		try {
			const listed = await ctx.sessionController.list({}, AbortSignal.timeout(8000))
			const rows = Array.isArray(listed?.items) ? listed.items : []
			const items = []
			/*
			 * 3.3.0 复查两条必修之二 ✗：这里原来只按时间筛 ✓ → **绕过了桥自己早就有的两道过滤** ✓：
			 *   ① **手机上删过（归档）的会话会回来** ✓（`listSessions()` 一直在挡 ✓，week 漏了 ✓）；
			 *   ② **子会话**当可点卡片 ✓ → 点开必然"打不开" ✓（用户 2026-10-11 的原话：
			 *      "agent 子对话以及测试对话就不要显示在对话框里了，占位置" ✓ —— 规则和助手都已存在 ✓，
			 *      这里不是"留到设置版"的取舍 ✗，是**漏** ✓）。复查实测：43 条里 2 条是归档、**20 条是子会话** ✓。
			 */
			const archived = archivedSessionIds()
			for (const row of rows) {
				const id = String(row?.sessionId ?? '')
				if (archived.has(id) === true) continue
				if (state.unfollowable.has(id) === true) continue
				const updatedAt = Number(row?.updatedAt ?? 0)
				/*
				 * 复查低项 ✓：显式判"有限" ✓ —— 若宿主哪天把 `updatedAt` 换成 ISO 字符串 ✓，
				 * `Number('2026-…')` = NaN ✓，而 `NaN < since` 为**假** ✗ → 整行会被当成"本周有活动" ✓，
				 * 于是"最近 7 天"悄悄变成"全部会话" ✓（现在宿主是数字 ✓，这是防将来 ✓）。
				 */
				if (Number.isFinite(updatedAt) !== true) continue
				if (updatedAt < since) continue
				items.push({
					sessionId: id,
					// 复查两条必修之一 ✓：标题在**投影**里（`projections.values.title`）✓ ——
					// 我原来读的 `title/name/label/projections.title` 全是错的字段 ✗（详见 titleOfSummary 的注释 ✓）。
					title: titleOfSummary(row),
					idShort: id.replace(/^session-/, '').slice(0, 8),
					updatedAt,
					running: row?.running === true,
					// 手机侧本来就有"默认不显示子会话/独立目录"的开关 ✓ → 把判据发出去 ✓（让它自己决定 ✓）。
					subagent: row?.subagent === true,
					ownDir: row?.ownDir === true,
				})
			}
			items.sort((left, right) => right.updatedAt - left.updatedAt)

			/*
			 * 复查实测：days=30 → count=86 / items=60 ✓ —— 手机只显示 60 ✓ 且完全没说 ✗
			 *（"未来某周悄悄少一半"✓）→ 现在把 truncated 说出去 ✓，让手机能讲清 ✓。
			 */
			sendJson(res, 200, { ok: true, days, since, count: items.length, truncated: items.length > 60, items: items.slice(0, 60) })
		} catch (error) {
			// 同一条纪律 ✓：**读不到就说读不到** ✗（不假装"这周你什么都没学" ✓）。
			sendJson(res, 503, { error: '看不了：' + String(error?.message ?? error) })
		}
	}

	async function handleScreen(req, res) {
		if (await requirePinOr403(req, res) !== true) return
		const shot = await captureScreen({ maxWidth: 1280 })
		if (shot.ok !== true) {
			// 截不到就**如实说原因** ✓（锁屏 / 没有交互桌面是最常见的两种 ✓）—— 绝不回一张黑图 ✗。
			sendJson(res, 503, { error: `截不到屏：${shot.error}` })
			return
		}
		res.writeHead(200, {
			'content-type': 'image/png',
			'content-length': String(shot.bytes.length),
			// 屏幕内容一个字都不许缓存 ✓。
			'cache-control': 'no-store, must-revalidate',
		})
		res.end(shot.bytes)
	}

	/**
	 * 3.8.0「屏幕取字」✓：截当前屏幕 → **连同那句 OCR 指令**交给 agent ✓
	 * （与 3.7.0 的 `task:"ocr"` 用的是**同一句常量** ✓ —— 一份实现两处用 ✓，免得两边说法慢慢不一样 ✗）。
	 *
	 * 三条纪律：
	 *   ① **不新开写入通道** ✗：还是 `sessionController.prompt`（`mode:'queue'` ✓）—— 和手机上点「发送」同级 ✓；
	 *   ② **要 PIN** ✓：截屏本来就要 ✓（整屏可能有密码/隐私 ✓），而这一步还会**替你指挥 agent** ✓，更要 ✓；
	 *   ③ **桥自己不认字** ✗：图和指令交给电脑上的 agent ✓（它本来会看图 ✓）→ 零新依赖 ✓。
	 * ⚠️ 目标会话：和「分享到桥」同一条挑选规则 ✓（最近一个能用的 ✓ —— 不让人先选 ✓）。
	 */
	async function handleScreenOcr(req, res) {
		/*
		 * ⚠️ 复查第 92 轮：**先把 body 读干净再回绝** ✓（项目自己在 `drainRequest` 那条注释里写着这条纪律 ✗）。
		 * 这条路的 PIN 只从**头**里取 ✓（不读 body ✓），所以"读干净"就是**丢弃式地读掉** ✓
		 * —— 它不缓冲 ✓、也就不违反"别先攒大包再判"那条 ✓；不读的话，带 body 只带头时会**留半截连接** ✗。
		 */
		await drainRequest(req)
		if (await requirePinOr403(req, res, {}, {
			what: '屏幕取字', code: 'screen-ocr', why: '它会把这张屏幕直接交给 agent',
		}) !== true) return
		const shot = await captureScreen({ maxWidth: 1280 })
		if (shot.ok !== true) { sendJson(res, 503, { error: `截不到屏：${shot.error}` }); return }
		let target
		try {
			target = await intakeTarget('')
		} catch (error) {
			sendJson(res, 503, { error: `读不到电脑上的会话列表：${String(error?.message ?? error)}` })
			return
		}
		if (target.error !== undefined) { sendJson(res, 409, { error: target.error }); return }
		const picked = target.picked
		const sessionId = String(picked.sessionId)
		const requestId = randomUUID()
		try {
			const accepted = await ctx.sessionController.prompt({
				requestId,
				sessionId,
				mode: 'queue',
				clientTimeZone: 'Asia/Shanghai',
				content: [
					{ type: 'text', text: '【分享到桥】' },
					{ type: 'text', text: INTAKE_TASKS.ocr },
					{ type: 'text', text: '（这张是**电脑当前的屏幕** ✓ —— 手机上点「取字」那一刻截的 ✓。）' },
					{ type: 'image', mediaType: 'image/png', data: shot.bytes.toString('base64'), name: 'screen.png' },
				],
			}, AbortSignal.timeout(30000))
			record(`screen-ocr accepted for ${sessionId} (${shot.bytes.length} bytes)`)
			sendJson(res, 200, {
				ok: true,
				sessionId,
				title: String(picked.title ?? ''),
				requestId,
				accepted: accepted?.accepted === true,
			})
		} catch (error) {
			const message = String(error?.message ?? error)
			record(`screen-ocr rejected for ${sessionId}: ${message}`)
			sendJson(res, 502, { error: `这次没进去：${message}`, sessionId })
		}
	}

	/* ------------- 4.0.0「🎬 录屏遥控」：手机开始 / 停止电脑录屏（ffmpeg 现成 ✓） ------------- */
	/**
	 * 三条纪律 ✓（和本项目每一个"能指挥这台电脑"的功能一样 ✓）：
	 *   ① **默认关** ✓（`screenRecord: true` 才开 ✓，每次请求现读配置 ✓）；
	 *   ② **要 PIN** ✓（它把**整块屏幕**录下来 ✓ —— 比截屏更敏感 ✓，还得能停得掉 ✓）；
	 *   ③ **有硬上限** ✓：`-t <秒>` 交给 **ffmpeg 自己**到点停 ✓ —— 不靠手机计时 ✓
	 *      （手机断了 / 页面关了 / 桥被热重载都不会让它录到把磁盘写满 ✓），回包里把上限一起说清 ✓。
	 * ⚠️ 录下来的东西**只落在这台电脑上** ✓（`~/.dsh/recordings/` ✓），桥不往任何地方发 ✗。
	 */
	const RECORD_MAX_SECONDS = 600
	const recordDir = () => join(dshHome(), 'recordings')
	let recording = null
	/** 刚录完那一条 ✓（自动到点停 / 出错退出后，stop 与 status 还能报出来 ✓ —— 复查第 94 轮点名）。 */
	let lastRecording = null

	function recordingStatus() {
		if (recording === null) {
			return lastRecording === null ? { recording: false } : { recording: false, last: lastRecording }
		}
		let sizeBytes = 0
		try { sizeBytes = statSync(recording.file).size } catch { sizeBytes = 0 }
		return {
			recording: true,
			file: recording.file,
			seconds: Math.round((Date.now() - recording.startedAt) / 1000),
			maxSeconds: recording.maxSeconds,
			sizeBytes,
		}
	}

	/** 停：先让它**自己收尾** ✓（ffmpeg 认 stdin 上的 `q` ✓）；8 秒还不走就强停 ✓ 并照实说没等它收尾 ✗。 */
	async function stopRecording() {
		if (recording === null) return { ok: false }
		const current = recording
		recording = null
		let graceful = true
		try {
			current.proc.stdin?.write('q')
			await new Promise((resolve) => {
				const timer = setTimeout(() => {
					graceful = false
					try { current.proc.kill() } catch { /* 已经没了 ✓ */ }
					resolve()
				}, 8000)
				current.proc.once('close', () => { clearTimeout(timer); resolve() })
			})
		} catch {
			graceful = false
			try { current.proc.kill() } catch { /* 忽略 */ }
		}
		let sizeBytes = 0
		try { sizeBytes = statSync(current.file).size } catch { sizeBytes = 0 }
		lastRecording = { file: current.file, sizeBytes, at: Date.now() }
		return { ok: true, file: current.file, sizeBytes, graceful, maxSeconds: current.maxSeconds }
	}

	async function handleRecord(req, res) {
		let body = {}
		try { body = await readBody(req, 8192) } catch { body = {} }
		if (processControlFlag('screenRecord') !== true) {
			sendJson(res, 403, { error: '录屏默认关闭 —— 在 mobile-bridge.json 里加 "screenRecord": true 再试（改完立刻生效）' })
			return
		}
		if (await requirePinOr403(req, res, body, {
			what: '录屏', code: 'screen-record', why: '它会把整块屏幕录下来',
		}) !== true) return
		const action = String(body.action ?? '').trim()
		if (action === 'status') { sendJson(res, 200, { ok: true, ...recordingStatus() }); return }
		if (action === 'stop') {
			const stopped = await stopRecording()
			if (stopped.ok !== true) {
				// 已经自己停了（到点 / 出错）也把**刚录的那条**报出来 ✓ —— 别让文件信息消失 ✓。
				// ⚠️ 复审第 94 轮点名 ✗：手机那边**只显示 `error` 这一句** ✓（`last` 这个 JSON 字段它不读 ✗）
				// → 只放字段等于没放 ✓，文件名/大小/时间必须**写进话里** ✓。
				sendJson(res, 409, {
					error: lastRecording === null
						? '现在没有在录 —— 不用停 ✓'
						: `现在没有在录 —— 它已经自己停了 ✓；最后那条是 ${basename(lastRecording.file)}`
							+ `（约 ${Math.round(lastRecording.sizeBytes / 1024)} KB，${new Date(lastRecording.at).toLocaleString()}）✓`,
					...(lastRecording === null ? {} : { last: lastRecording }),
				})
				return
			}
			record(`录屏停止（${basename(stopped.file)}，${stopped.sizeBytes} 字节）`)
			sendJson(res, 200, {
				ok: true,
				file: stopped.file,
				sizeBytes: stopped.sizeBytes,
				note: stopped.sizeBytes > 0
					? `录好了 ✓ 文件就在电脑上：${stopped.file}（约 ${Math.round(stopped.sizeBytes / 1024)} KB ✓）`
					// ⚠️ 空文件**必须照实说** ✗ —— 锁屏时 gdigrab 抓不到画面 ✓，别让人以为录到了 ✓。
					: '停了，但文件是**空的** —— 多半是没抓到画面（锁屏？）✗ 别以为录到了 ✓',
				...(stopped.graceful === true ? {} : { warning: '它没在 8 秒内自己收尾，被强停了 —— 文件可能不完整 ✓' }),
			})
			return
		}
		if (action !== 'start') {
			sendJson(res, 400, { error: `不认识的 action「${action}」—— 只能是 start / stop / status ✓` })
			return
		}
		if (recording !== null) {
			sendJson(res, 409, { error: '已经在录了 —— 要重来先 stop ✓', ...recordingStatus() })
			return
		}
		const ffmpeg = resolveMediaBinary('ffmpeg', state.config?.ffmpegPath ?? process.env.DSH_BRIDGE_FFMPEG)
		if (typeof ffmpeg !== 'string' || ffmpeg === '' || existsSync(ffmpeg) !== true) {
			sendJson(res, 503, {
				error: '这台电脑上没找到 ffmpeg —— 录屏要靠它 ✓（放一个到 ~/.dsh/bin/，或在配置里写 ffmpegPath ✓）',
			})
			return
		}
		const want = Number(body.seconds) > 0 ? Math.floor(Number(body.seconds)) : RECORD_MAX_SECONDS
		const maxSeconds = Math.min(RECORD_MAX_SECONDS, Math.max(5, want))
		await mkdir(recordDir(), { recursive: true }).catch(() => {})
		// ⚠️ 带上**毫秒** ✗（复审点名：只到秒的话，同秒两条 start 会撞同一个文件名 ✓，第二条 `-y` 把第一条覆盖掉 ✓）。
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
		const file = join(recordDir(), `rec-${stamp}.mp4`)
		// Windows 抓桌面用 gdigrab ✓（别的平台按各自那套 ✓ —— 不假装都能用 ✗）。
		const input = process.platform === 'win32'
			? ['-f', 'gdigrab', '-framerate', '15', '-i', 'desktop']
			: ['-f', 'x11grab', '-framerate', '15', '-i', process.env.DISPLAY ?? ':0.0']
		try {
			const proc = spawn(ffmpeg, [
				'-hide_banner', '-loglevel', 'error', '-y', ...input,
				'-t', String(maxSeconds), '-pix_fmt', 'yuv420p', file,
			], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
			// ⚠️ stderr **不能再丢掉** ✗：`-loglevel error` 的意义就是把「抓不到屏幕」这类话交出来 ✓。
			let spawnError = ''
			proc.stderr?.on('data', (chunk) => { spawnError += String(chunk) })
			/*
			 * 🔴 复查第 94 轮的头号问题 ✗：**spawn 成功 ≠ 真的录上了** ✓。
			 * 锁屏 / gdigrab 打不开桌面 / Wayland 没有 x11grab 时，ffmpeg 会**几毫秒内退出** ✓ ——
			 * 原来这时已经回了 200「开始录了」✗，用户要等 10 分钟才发现是个空文件 ✓（假承诺 ✓）。
			 * 所以先等 1.5 秒 ✓，**它还在跑**才算开始 ✓；已经退了 → 503 + ffmpeg 的原话 ✓。
			 */
			/*
			 * ⚠️ **先占位、再判活** ✗（复审第 94 轮抓到的**真 bug** ✓）：原来在 `await` **之后**才置 `recording` ✓，
			 * 于是这 1.5 秒里**第二条 start 也能过「已经在录了」那道闸** ✓（`guard()` 只是同步鉴权 ✓、不排队 ✓）
			 * → **两个 ffmpeg 同时录** ✓，而文件名只到秒 ✓ → 同秒两条撞同一个 .mp4 ✓（第二条 `-y` 覆盖 ✓），
			 * `recording` 只留第二条 ✓ → 第一条成**幽灵**：停不掉、一路录满 600 秒 ✗
			 *（正好违反本功能自己写的「还得能停得掉」✓）。所以**先占位** ✓，判退时再让位 ✓。
			 */
			recording = { proc, file, startedAt: Date.now(), maxSeconds }
			await new Promise((resolve) => setTimeout(resolve, 1500))
			if (proc.exitCode !== null || proc.signalCode !== null) {
				if (recording !== null && recording.proc === proc) recording = null
				let earlySize = 0
				try { earlySize = statSync(file).size } catch { earlySize = 0 }
				sendJson(res, 503, {
					error: `它起来就退了（多半抓不到这块屏幕：锁屏？Wayland？）—— ffmpeg 说：${spawnError.trim().slice(-200) || '(没说什么)'}`,
					bytes: earlySize,
				})
				return
			}
			// 到点自己停 / 出错 → 状态回到"没在录" ✓（这行是"别留下一个永远在录的假状态"✓）。
			proc.once('close', () => {
				if (recording !== null && recording.proc === proc) recording = null
				// 自己到点停 / 中途出错 → 也把这一条记下来 ✓（不然用户拿不回文件 ✓）。
				let size = 0
				try { size = statSync(file).size } catch { size = 0 }
				lastRecording = { file, sizeBytes: size, at: Date.now() }
			})
			proc.once('error', () => { if (recording !== null && recording.proc === proc) recording = null })
			// 日志只记**文件名** ✗（完整路径含用户名 ✓，而日志会随 /api/diag 外发 ✓）。
			record(`录屏开始（${basename(file)}，上限 ${maxSeconds} 秒）`)
			sendJson(res, 200, {
				ok: true,
				file,
				maxSeconds,
				note: `开始录了 ✓ 最多录 ${Math.floor(maxSeconds / 60)} 分 ${maxSeconds % 60} 秒就**自动停** ✓`
					+ '（不靠手机计时 ✓ —— 手机断了、页面关了也照样到点停 ✓）；要提前停就点「停止录屏」✓',
			})
		} catch (error) {
			recording = null
			sendJson(res, 503, { error: `起不来：${String(error?.message ?? error)}` })
		}
	}

	// 插件被卸载 / 热重载时，**别留一个还在录的进程** ✓（不然它一直录到上限 ✓ —— 用户不知道 ✓）。
	ctx.effect(() => () => { void stopRecording() })

	/* ------------------------------- 会话导出 / 分享（2.7.0 池子里的 ★5） */
	/*
	 * 文档原话：「一次对话导出 Markdown 或图片 ✓ → 发微信 / 存相册 ✓（`tools/export-session.mjs` 现成 ✓）」。
	 * 现成的那份核心已经抽到 `lib/export.js` ✓ —— **脚本和桥共用一份实现** ✓
	 * （重构前后逐行比对过：1036 行一字不差 ✓，只差"导出时间"那一行 ✓）。
	 *
	 * 图片版没做 ✗：手机端要画长图得自己写 canvas 排版（还容易糊 ✗），而「Markdown 下载 + 复制全文 +
	 * 系统分享」已经把"发微信/存档"这条链路走通了 ✓ —— 先做能用透的那条 ✓，不为了对齐一句话硬做半成品 ✗。
	 */
	async function handleExportSession(res, query) {
		const id = String(query.get('id') ?? '')
		// id 里带路径分隔符 = 想读别的东西 ✗ —— 直接拒（`lib/export.js` 里是按目录名精确匹配 ✓，这里是第二道 ✓）。
		if (id === '' || /[\\/]/.test(id) === true || id.length > 120) {
			sendJson(res, 400, { error: '缺少 id（或者 id 不合法）' })
			return
		}
		const rawMax = Number(query.get('max') ?? 4000)
		const result = exportSessionMarkdown(id, {
			maxChars: Math.min(20000, Math.max(500, Number.isFinite(rawMax) ? rawMax : 4000)),
			withTools: query.get('tools') === '1',
			withReasoning: query.get('reasoning') === '1',
		})
		if (result.ok !== true) {
			sendJson(res, 404, { error: result.error })
			return
		}
		if (query.get('info') === '1') {
			sendJson(res, 200, {
				sessionId: result.sessionId,
				users: result.users,
				assistants: result.assistants,
				toolCalls: result.toolCalls,
				bytes: Buffer.byteLength(result.markdown, 'utf8'),
				file: result.file,
			})
			return
		}
		// 文件名带中文 → 同时给 ASCII 版和 RFC 5987 版 ✓（老浏览器认前者、新的认后者 ✓）。
		const ascii = `dialog-${id.slice(0, 24)}.md`
		const pretty = encodeURIComponent(`对话记录-${id.slice(0, 24)}.md`)
		res.writeHead(200, {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${pretty}`,
			'cache-control': 'no-store',
		})
		record(`导出会话 ${id} <- 手机`)
		res.end(result.markdown)
	}

	/* ------------------------------- 定时任务面板（2.7.0 池子里的 ★6） */
	/*
	 * 上游先查清了（**不猜** ✓）：DSH 有 `@deepseek-ai/dsh-schedule` 这个插件，它注册的服务就叫
	 * **`schedule`** ✓（`super(ctx, "schedule")`），暴露：
	 *   `create(sessionId, request, signal)` ✓ / `list({ sessionId })` ✓ / `catalog()` ✓ /
	 *   `history(request)` ✓ / `delete({ id, sessionId }, signal)` ✓ / `update(request, signal)` ✓
	 * 请求形状就是 `schedule_create` 那个工具的入参 ✓（prompt + title + 六选一的定时器 ✓）。
	 *
	 * 所以**绝不自己写 timer** ✗✗：那是重复造轮子，而且"任务存在哪、重启后还在不在、
	 * 电脑当时没开怎么办"这些语义宿主已经处理好了 ✓（任务持久化在 storage domain ✓，
	 * 到点是把提示**投递进那个会话** ✓ —— 正是用户要的"每晚 23:00 整理今天的笔记" ✓）。
	 * 桥这一层只做"翻译 + 转发" ✓。
	 */
	const scheduleService = () => {
		try { return ctx.get('schedule') } catch { return undefined }
	}

	/** 只把手机要显示/编辑的字段挑出来 ✓（宿主的记录形状很细，整包塞给手机是白流量 ✗）。 */
	const trimSchedule = (task) => ({
		id: task.id,
		title: task.title ?? '',
		prompt: task.prompt ?? '',
		scheduledAt: task.scheduledAt ?? null,
		repeat: task.repeat ?? null,
		status: task.status ?? 'active',
		sessionId: task.sessionId ?? null,
	})

	async function handleScheduleList(res, query) {
		const service = scheduleService()
		if (service === undefined || service === null) {
			sendJson(res, 501, { error: '这台 DSH 没装 schedule 插件 —— 定时面板用不了（别的功能不受影响 ✓）' })
			return
		}
		const sessionId = String(query.get('sessionId') ?? '')
		try {
			const tasks = sessionId === '' ? await service.catalog() : await service.list({ sessionId })
			sendJson(res, 200, {
				sessionId: sessionId === '' ? null : sessionId,
				count: tasks.length,
				tasks: tasks.map(trimSchedule),
				note: '定时任务由 DSH 的 schedule 服务托管：任务存在宿主的存储里 ✓，到点是把提示投进那个会话 ✓',
			})
		} catch (error) {
			sendJson(res, 500, { error: `读不到定时任务：${String(error?.message ?? error)}` })
		}
	}

	async function handleScheduleWrite(req, res) {
		const service = scheduleService()
		if (service === undefined || service === null) {
			sendJson(res, 501, { error: '这台 DSH 没装 schedule 插件 —— 定时面板用不了' })
			return
		}
		let body
		try {
			body = await readBody(req, 64 * 1024)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const sessionId = String(body.sessionId ?? '')
		if (sessionId === '') {
			sendJson(res, 400, { error: '缺少 sessionId —— 定时任务必须绑一个会话（到点往那个会话里发提示 ✓）' })
			return
		}
		const action = String(body.action ?? 'create')
		try {
			if (action === 'delete') {
				const result = await service.delete({ id: String(body.id ?? ''), sessionId })
				if (result?.deleted !== true) {
					sendJson(res, 404, { error: '没找到这条定时任务（可能已经删了）' })
					return
				}
				record(`删除定时任务 ${body.id} <- 手机`)
				sendJson(res, 200, { deleted: true, id: result.id })
				return
			}
			if (action !== 'create') {
				sendJson(res, 400, { error: 'action 只能是 create / delete' })
				return
			}
			const prompt = String(body.prompt ?? '').trim()
			if (prompt === '') {
				sendJson(res, 400, { error: '缺少 prompt —— 到点要发什么？' })
				return
			}
			// 定时器**六选一** ✓（宿主会自己校验"只能给一个"，但先在这儿挡一道，错误更好懂 ✓）。
			const selectors = ['at', 'after_seconds', 'every_seconds', 'daily', 'weekly', 'cron'].filter((key) => body[key] !== undefined)
			if (selectors.length !== 1) {
				sendJson(res, 400, { error: '定时器要给且只给一个：at / after_seconds / every_seconds / daily / weekly / cron' })
				return
			}
			const request = {
				prompt,
				title: String(body.title ?? '').trim().slice(0, 120) || prompt.slice(0, 40),
				[selectors[0]]: body[selectors[0]],
			}
			const created = await service.create(sessionId, request)
			record(`新建定时任务「${request.title}」<- 手机`)
			sendJson(res, 200, { created: true, task: trimSchedule({ ...created, sessionId }) })
		} catch (error) {
			// 宿主会抛"输入不合法"这类错误 ✓ —— 把它的原话带回去，别换成一句没用的"失败" ✗。
			sendJson(res, 400, { error: `没建成/没删掉：${String(error?.message ?? error)}` })
		}
	}

	/* ------------------------- 学习向：转写 → 提纲 / 复习卡（2.7.0 池子里的 ★9） */
	/*
	 * 文档原话：「录音/网课转写后自动出**提纲 + 复习卡**存到电脑 ✓（挂机刷课那条我不做 ✗）」。
	 *
	 * 拆成两件事，各归各的：
	 *   ① **转写原文落盘** ✓ —— 桥自己写（确定性 ✓）：`~/.dsh/mobile-bridge/notes/<日期>-<标题>.md`
	 *      （手机上转写完就存，不依赖模型听不听话 ✓）；
	 *   ② **提纲 + 复习卡** ✓ —— 交给**宿主里的 agent** ✓：桥把"原文 + 明确的输出要求"作为一条消息
	 *      发进那个会话 ✓（复用已有的提示通道 ✓，不另造一套模型调用 ✗）。
	 * 这么分的好处：即使 agent 那一步没做，**原文也已经安全存在电脑上** ✓（丢不了 ✓）。
	 */
	const NOTES_DIR = () => join(dshHome(), 'mobile-bridge', 'notes')

	async function handleSaveNote(req, res) {
		let body
		try {
			body = await readBody(req, 512 * 1024)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const text = String(body.text ?? '')
		if (text.trim() === '') {
			sendJson(res, 400, { error: '没有正文 —— 转写是空的？' })
			return
		}
		// 文件名只用安全字符 ✓（标题里可能有 `/`、`:`、emoji ✓ —— 绝不能让它决定路径 ✗）。
		const rawTitle = String(body.title ?? '转写').slice(0, 60)
		const slug = rawTitle.replace(/[^\p{L}\p{N}\-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'note'
		const now = new Date()
		const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
		const clock = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
		const dir = NOTES_DIR()
		const file = join(dir, `${stamp}-${clock}-${slug}.md`)
		try {
			await mkdir(dir, { recursive: true })
			const header = [
				`# ${rawTitle}`,
				'',
				`- 保存时间：${now.toLocaleString()}`,
				typeof body.sessionId === 'string' && body.sessionId !== '' ? `- 会话：${body.sessionId}` : '',
				typeof body.durationSeconds === 'number' && body.durationSeconds > 0 ? `- 录音时长：${Math.round(body.durationSeconds / 60)} 分钟` : '',
				'',
				'## 转写原文',
				'',
			].filter((line) => line !== '').join('\n')
			await writeFile(file, `${header}\n${text}\n`, 'utf8')
		} catch (error) {
			sendJson(res, 500, { error: `存不下来：${String(error?.message ?? error)}` })
			return
		}
		record(`转写存盘：${file} <- 手机`)
		sendJson(res, 200, { saved: true, file, bytes: Buffer.byteLength(text, 'utf8'), message: '转写原文已经存到电脑上了 ✓' })
	}

	/* ------------- 4.1.0「分享安装」：给别人一份能照着装的零基础文案 ------------- */
	/**
	 * 用户 2026-10-14 亲口要的 ✓：「顶部增加一个分享按钮，能分享当前版本的零基础安装文案」✓。
	 * 设计：**服务端单点生成** ✓（版本号读真值 ✓、步骤与 README 同一套说法 ✓）→ 页面上只负责显示/复制/系统分享 ✓。
	 * ⚠️ 三条底线 ✓：
	 *   ① **不含任何凭据** ✗（pathSecret / PIN / 本机地址 / 隧道域名 一个都不许出现 ✓ —— 这条文案是**对外**的 ✓）；
	 *   ② **不假装能一键装** ✗ —— 它是一份**说明**，不是安装器 ✓（诚实写清要哪两样前置 ✓）；
	 *   ③ **版本号必须是真的** ✓（读 package.json ✓，读不到写 unknown ✗ 不编 ✓）。
	 */
	/**
	 * 4.2.0：**一处内容源** ✓ —— 文本版与网页版都从这儿出 ✗（两边各写一份必然会慢慢说不一样 ✓）。
	 */
	function installDoc() {
		return {
			version: PLUGIN_VERSION,
			repo: 'https://github.com/jxboop/dsh-plugin-mobile-bridge',
			title: '手机桥 v' + PLUGIN_VERSION + ' —— 用手机操控这台电脑上的 DSH（零基础安装）',
			what: [
				'一句话：手机上打开一个网页，就能看你电脑上 agent 的进度、给它回话、拍张图发过去、看电脑屏幕。',
				'它只连**你自己的**电脑 —— 不上任何云，手机和电脑之间直连；外网那条路走**你自己的 Tailscale**（不经过任何第三方服务器）。',
				'装完手机桌面上会多一个图标，点开就是它（可以像 App 一样全屏用，没有浏览器地址栏）。',
			],
			need: [
				'**电脑上已经装好 DSH 并且能跑起来** —— 这是一个 DSH 的扩展插件，不是能单独运行的程序。',
				'**电脑上要有 Node 22 或更新**（命令行敲 `node -v` 能看到版本号；没有就先去 nodejs 官网装一个 LTS 版）。',
				'**装插件的那条命令需要 Git**（电脑上敲 `git --version` 能看到版本号；没有就装一次 Git for Windows）。',
				'**Tailscale：必装（电脑）** —— 去 https://tailscale.com/download 下载安装、登录一次（邮箱 / Google / 微软账号都行）。'
					+ '装完右下角托盘里会出现一个图标。**这就是"从外网也能连"的前提**：不装它，手机只能和电脑在同一个 WiFi 下用。',
				'**Tailscale 里的「外网入口」（Funnel）要开一次** —— 第一次执行第 5 步那条命令时，它会给你一条开启 HTTPS 的链接，'
					+ '用浏览器点开确认一次就行（同一个 tailnet 只开一次）。开完之后地址是**固定的 https 地址**，电脑重启也不变。',
			],
			steps: [
				'电脑上打开一个终端（Windows 按 Win 键搜「PowerShell」）。敲 `node -v` 和 `git --version`，两条都能打印出版本号，就可以往下走。',
				'电脑上装插件：`dsh plugin --profile web add github:jxboop/dsh-plugin-mobile-bridge`（直接从 GitHub 装，不需要手动下载任何东西 —— 但**必须先有 Git**）。',
				'重启 DSH（插件只在启动时加载一次）。',
				'装 Tailscale：打开 https://tailscale.com/download 下载安装，登录一次；然后在终端敲 `tailscale status`（不是内部命令的话，把终端关掉重开一次）—— 能看到你自己这台电脑的名字，就说明登录好了。',
				'开外网入口：`tailscale funnel --bg 3081`。第一次它会打印一条「开启 HTTPS / Funnel」的链接，用浏览器打开点一下确认；'
					+ '开好后这条命令会打印一条 `https://<电脑名>.<tailnet>.ts.net/` 的地址，把它记下来（`tailscale funnel status` 也能再看到）。',
				'把这条 https 地址写进手机桥配置：打开 `%USERPROFILE%\\.dsh\\mobile-bridge.json`，在里面加一行 `"publicUrl": "https://<电脑名>.<tailnet>.ts.net"`'
					+ '（值就是第 5 步打印的那条，**结尾不要带斜杠**），保存。',
				'再重启一次 DSH。看**桌面 DSH 左下角那个蓝色徽标**：配置对了的话，上面会多一行 `🌍 外网 https://……ts.net/<密钥段>/` ——'
					+ '这就是手机要打开的正式地址（日志里那两行 `phone url: http://192.168……` 是**局域网**地址，外网地址看徽标这一行；'
					+ '手机上「🩺 一键自检」里的「外网隧道」也是它）。',
				'**从外网验一次（这一步别跳过）**：手机**关掉 WiFi、只用流量**，打开上面徽标里那条 https 地址 —— 能看到登录页，就说明"在外面也能连"成立。'
					+ '（同一个 WiFi 能打开，**不代表**外网能打开 ✓。）',
				'在手机上输入电脑那两行日志里的 6 位 PIN，进去。然后把这一页**「加到主屏幕」**：iPhone 用 Safari 点底部分享按钮 →「添加到主屏幕」；安卓用 Chrome 点右上角三个点 →「添加到主屏幕」。以后点桌面上那个图标就直接进来，跟 App 一样。',
				'（可选，不想把端口暴露到公网的替代做法）手机也装 Tailscale、登录**同一个账号**，然后用电脑的 `100.x.x.x` 地址连'
					+ '（形如 `http://100.x.x.x:3081/<密钥段>/`）—— 这条路只有你自己 tailnet 里的设备能连，外网游客打不开。',
			],
			trouble: [
				'**命令报 `ERR_PNPM_GIT_RESOLVE_FAILED`**：电脑上没有 Git。装一次 Git for Windows，回来重跑那条命令。',
				'**插件装上了，但手机页面一直转圈**：多半是忘了重启 DSH（插件只在启动时加载）。',
				'**`tailscale` 不是内部或外部命令**：装完 Tailscale 要把终端**关掉重开**（PATH 才会生效）；还不行就用完整路径：`& "C:\\Program Files\\Tailscale\\tailscale.exe" funnel --bg 3081`。',
				'**`tailscale funnel` 提示要先开 HTTPS / Funnel 没开**：照它打印的那条链接，用浏览器打开点一次确认（tailnet 的 HTTPS 功能）；开完回来重跑那条命令。',
				'**徽标上没有「🌍 外网 …」那一行**：说明 `%USERPROFILE%\\.dsh\\mobile-bridge.json` 里的 `publicUrl` 没写对'
					+ '（键名就是 publicUrl、值不要带结尾斜杠、必须是 https 开头），改完**重启 DSH**（不是刷新手机页面）。',
				'**手机用流量打不开、但同一个 WiFi 能打开**：先在电脑上敲 `tailscale funnel status`，看还有没有 `3081` 那一行'
					+ '（目标应该是本机的 3081 端口）；没有就重跑第 5 步。也可能是运营商 DNS 还没刷新，等 1 分钟或换一下网络再试。',
				'**手机能打开、但操作被拒**：那是要你在手机上输一次电脑的 6 位 PIN（默认一小时会再问一次，这是设计，不是掉线）。',
				'**电脑上第一次启动会弹防火墙提示**：勾「专用网络」就够；要走外网再勾「公用网络」（Funnel 走的是本机回环，通常不受影响）。',
			],
			secrets: '那 6 位 PIN 和网址里那串随机字符是这台电脑自己生成的，等于钥匙 —— **别发到群里**。这条文案是我自己生成的，里面**没有**你的密码、密钥或内网地址，可以放心转发。',
			footer: '（这条由手机桥 v' + PLUGIN_VERSION + ' 自己生成：里面**没有**任何密码、密钥或你的内网地址，可以直接转发 ✓）',
		}
	}

	/**
	 * 文本版（手机上「复制全文」拿到的就是它 ✓，也是系统分享出去的内容 ✓）。
	 *
	 * ⚠️ 4.3.0：用户当场说「安装文案一点都不详细」✗ —— 三句话确实不够一个零基础的同学照着装 ✓。
	 * 现在按"先看要什么 → 一步步敲 → 卡住了怎么办"三段重写 ✓：每条都写出**敲什么、看到什么算过** ✓，
	 * 并且保持**没有任何凭据** ✓（只在文字里提"电脑上那行日志"✓，绝不写真实 PIN / 密钥 / 内网地址 ✗）。
	 */
	function buildInstallText() {
		const doc = installDoc()
		return [
			doc.title,
			'',
			'== 这是什么 ==',
			...doc.what,
			'',
			'== 装之前要有的东西（5 样）==',
			...doc.need.map((line, index) => '  ' + (index + 1) + ') ' + line),
			'',
			'== 照着装好（细分成 10 小步，照着走就行）==',
			...doc.steps.map((line, index) => '  ' + (index + 1) + ') ' + line),
			'',
			'== 卡住了看这里 ==',
			...doc.trouble.map((line) => '  · ' + line),
			'',
			'== 安全 ==',
			doc.secrets,
			'',
			'仓库（README 里有完整步骤、常见问题、以及每一版改了什么）：' + doc.repo,
			'',
			doc.footer,
		].join('\n')
	}

	/**
	 * 4.2.0「网页版分享」✓（用户 2026-10-14：「分享按钮加一个网页版分享（方便同学阅读）」✓）：
	 * 生成一份**单文件、自带样式、手机上能舒服读**的静态页面 ✓ —— 同学拿到这个文件直接浏览器打开就行 ✓，
	 * **不需要你电脑在线** ✗（也不经过任何服务器 ✓）。
	 * ⚠️ 三条 ✓：① 内容与文本版**同源**（都走 installDoc ✓）；② **没有任何凭据** ✗（只有仓库链接 ✓）；
	 * ③ **不带脚本** ✗（纯静态 ✓，同学那边打开更放心 ✓）。
	 */
	function buildInstallHtml() {
		const doc = installDoc()
		const esc = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
		// 文本里的 `**强调**` 变 <strong> ✓、`` `命令` `` 变 <code> ✓（同一份文案 ✓）——
		// ⚠️ 4.3.0 冷视角复查点名的黄 ✓：原来只转 `**` ✗，反引号**原样落在网页版里** ✓
		// （同学看到的是带反引号的 `node -v` ✓）。现在两种标记都转 ✓（`.replace` 都是全局 ✓）。
		const rich = (value) => esc(value)
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/`([^`]+)`/g, '<code>$1</code>')
			/*
			 * 🔴 5.0.0：文案里的裸网址要**点得动** ✓（用户 2026-10-19：分享出去要能照着装 ✓）——
			 * 现在 Tailscale 是必装前置 ✓，那条下载地址在网页版里必须是可点的链接 ✓，
			 * 否则同学只能手抄 `https://tailscale.com/download` ✗。
			 */
			.replace(/(https:\/\/[^\s<>"'）)]+)/g, '<a href="$1" rel="noreferrer">$1</a>')
		const list = (rows) => rows.map((row) => '<li>' + rich(row) + '</li>').join('')
		return '<!doctype html><html lang="zh"><meta charset="utf-8">'
			+ '<meta name="viewport" content="width=device-width,initial-scale=1">'
			// 同学那边打开时**别把来源带出去** ✓；也不许被嵌进别的站 ✓。
			+ '<meta name="referrer" content="no-referrer">'
			+ '<title>' + esc(doc.title) + '</title>'
			+ '<style>'
			+ ':root{color-scheme:dark light}'
			+ 'body{margin:0;padding:22px 18px 40px;background:#0f1424;color:#e6ecff;'
			+ 'font:15px/1.75 -apple-system,BlinkMacSystemFont,「PingFang SC」,「Microsoft YaHei」,sans-serif}'
			+ 'main{max-width:640px;margin:0 auto}'
			+ 'h1{font-size:20px;line-height:1.5;margin:0 0 6px}'
			+ 'p{margin:10px 0}'
			+ 'h2{font-size:15px;margin:26px 0 6px;color:#8fb4ff}'
			+ 'ul,ol{margin:6px 0;padding-left:1.35em}'
			+ 'li{margin:6px 0}'
			+ 'strong{color:#fff}'
			+ 'a{color:#8fb4ff;word-break:break-all}'
			// ⚠️ 4.3.0：网页版里 `命令` 现在渲染成 <code> ✓ —— 给它一点底色 ✓（否则和正文混在一起看不清 ✓）。
			+ 'code{background:#1b2440;border-radius:4px;padding:1px 5px;font-size:13px;word-break:break-all}'
			+ 'footer{margin-top:30px;padding-top:14px;border-top:1px solid #26304a;color:#93a1c4;font-size:13px}'
			+ '</style>'
			+ '<main>'
			+ '<h1>' + esc(doc.title) + '</h1>'
			+ '<h2>这是什么</h2>'
			+ doc.what.map((line) => '<p>' + rich(line) + '</p>').join('')
			+ '<h2>装之前要有的东西（5 样）</h2><ol>' + list(doc.need) + '</ol>'
			+ '<h2>照着装好（细分成 10 小步，照着走就行）</h2><ol>' + list(doc.steps) + '</ol>'
			+ '<h2>卡住了看这里</h2><ul>' + list(doc.trouble) + '</ul>'
			+ '<h2>安全</h2><p>' + rich(doc.secrets) + '</p>'
			+ '<h2>仓库</h2><p><a href="' + esc(doc.repo) + '" rel="noreferrer">' + esc(doc.repo) + '</a>'
			+ '　（README 里有完整步骤、常见问题、以及每一版改了什么）</p>'
			+ '<footer>' + rich(doc.footer) + '</footer>'
			+ '</main></html>'
	}

	/**
	 * `GET /api/install` ✓：要登录 ✓（是**你自己**拿去分享 ✓，不是给外人抓取的接口 ✓）—— 不需要 PIN ✗（里面没有秘密 ✓）。
	 * `?format=html` → **网页版**（单文件 ✓，同学直接打开就能读 ✓）；不带 → JSON（文本版 ✓，给复制/系统分享用 ✓）。
	 */
	async function handleInstallInfo(res, query) {
		if (String(query?.get('format') ?? '') === 'html') {
			const html = buildInstallHtml()
			const bytes = Buffer.from(html, 'utf8')
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'content-length': String(bytes.length),
				// 自己下载/另存都行 ✓，但不许被中间缓存住 ✓。
				'cache-control': 'no-store, must-revalidate',
				'x-frame-options': 'DENY',
				'referrer-policy': 'no-referrer',
			})
			res.end(bytes)
			return
		}
		sendJson(res, 200, { version: PLUGIN_VERSION, text: buildInstallText() })
	}

	/* ---------------------- 受限只读链接（2.7.0 池子里的 ★10，最后一个带安全闸的） */
	/*
	 * 文档原话：「给另一台设备/家人一个"只能看某个会话"的临时链接 ✓，可随时撤销 ✓；
	 * **默认关** ✓、开必须**重输 PIN** ✓」。
	 *
	 * 三条硬设计：
	 *   ① **默认关** ✓（`shareLinks: true` 才开 ✓，和其它安全开关一样**每次请求现读配置** ✓ ——
	 *      关掉立刻生效 ✓）；
	 *   ② **令牌是独立的一次性凭证** ✓（32 位随机 ✓、有到期时间 ✓、只绑定**一个**会话 ✓、
	 *      比对用 `timingSafeEqual` ✓）—— 它**不是** PIN、也**不是** pathSecret ✓（拿到了也只能看那一份 ✓）；
	 *   ③ **只读**：那一页是**服务端渲染的一张快照** ✓（没有输入框、没有写接口 ✓），
	 *      内容直接复用 ★5 的 `lib/export.js` ✓（会话 → Markdown ✓，不重复实现 ✓）。
	 */
	const SHARES_FILE = 'mobile-bridge.shares.json'
	const SHARE_MAX_HOURS = 24 * 7
	const shareFile = () => join(dshHome(), SHARES_FILE)

	function loadShares() {
		try {
			const parsed = JSON.parse(readFileSync(shareFile(), 'utf8'))
			return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.token === 'string') : []
		} catch { return [] }
	}

	function saveShares(list) {
		return writeFile(shareFile(), `${JSON.stringify(list, null, 2)}\n`, 'utf8').catch(() => {})
	}

	/** 过期的顺手清掉 ✓（读的时候就清，不需要定时器 ✓）。 */
	function activeShares() {
		const now = Date.now()
		const all = loadShares()
		const alive = all.filter((item) => Number(item.expiresAt) > now)
		if (alive.length !== all.length) void saveShares(alive)
		return alive
	}

	const escapesHtml = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))

	async function handleShareList(res) {
		if (processControlFlag('shareLinks') !== true) {
			sendJson(res, 200, { enabled: false, links: [], note: '只读链接默认关闭 —— 要开就在 mobile-bridge.json 里加 "shareLinks": true（改完立刻生效）✓' })
			return
		}
		// 2.7.1 冷视角复查 **#8（低）**：原来这里的 url 没端口、没 `?t=`（等于打不开 ✗），
		// token 还被截成 6 位（列表项再也撤不掉 ✓）。改成和"生成"那处同一套拼法 ✓、给全 token ✓。
		const shareRemote = typeof state.config.publicUrl === 'string' && state.config.publicUrl !== '' ? state.config.publicUrl : ''
		const shareBase = (shareRemote !== '' ? withSecret(state.config, shareRemote) : withSecret(state.config, `http://127.0.0.1:${state.config.port}`)).replace(/\/$/, '')
		const links = activeShares().map((item) => ({
			token: item.token,
			sessionId: item.sessionId,
			expiresAt: item.expiresAt,
			// 4.0.0：一次性链接要能一眼看出来 ✓（列表上标着 ✓，免得你以为它还能给别人看 ✓）。
			once: item.once === true,
			usedAt: Number(item.usedAt) > 0 ? Number(item.usedAt) : 0,
			url: `${shareBase}/share?t=${item.token}`,
		}))
		sendJson(res, 200, { enabled: true, links })
	}

	async function handleShareCreate(req, res) {
		const ip = clientIp(req)
		let body
		try {
			body = await readBody(req, 8192)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		if (processControlFlag('shareLinks') !== true) {
			sendJson(res, 403, { error: '只读链接默认关闭 —— 在 mobile-bridge.json 里加 "shareLinks": true 再试（改完立刻生效）' })
			return
		}
		const sessionId = String(body.sessionId ?? '')
		if (sessionId === '' || /[\\/]/.test(sessionId) === true) {
			sendJson(res, 400, { error: '缺少合法的 sessionId' })
			return
		}
		if (!sameSecret(String(body.pin ?? ''), state.config.pin)) {
			if (!throttleLogin(ip)) {
				sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' })
				return
			}
			record(`生成只读链接：PIN 不正确 <- ${ip}`)
			noteLoginFailure({ ip, ua: userAgentOf(req), what: 'share-link' })
			sendJson(res, 403, { error: 'PIN 不正确 —— 没有生成任何链接' })
			return
		}
		state.attempts.delete(ip)
		const hours = Math.min(SHARE_MAX_HOURS, Math.max(1, Number(body.hours) > 0 ? Math.floor(Number(body.hours)) : 24))
		/*
		 * 4.0.0「一次性分享链接」✓（池子第 5 条 ✓）：在**现有的只读链接**上加一层语义 ✓ ——
		 * `once: true` 时，**第一次成功打开就作废** ✓（第二次来会拿到 410 + 说清 ✓，不是含糊的 404 ✓）。
		 * ⚠️ 三条照旧 ✓：默认关（`shareLinks` ✓）、要现输 PIN ✓、随时可撤销 ✓ —— 一样都不放松 ✓。
		 */
		const once = body.once === true
		const token = randomBytes(16).toString('hex')
		const list = activeShares()
		list.push({ token, sessionId, createdAt: Date.now(), expiresAt: Date.now() + hours * 3600000, ...(once ? { once: true } : {}) })
		await saveShares(list)
		record(`生成只读链接（会话 ${sessionId}，${hours} 小时${once ? '，**一次性**' : ''}）<- ${ip}`)
		// 链接给的是**外网可达的那个地址** ✓（外网没配就退局域网 ✓）—— 家人/另一台设备才打得开 ✓。
		const remote = typeof state.config.publicUrl === 'string' && state.config.publicUrl !== '' ? state.config.publicUrl : ''
		const base = remote !== '' ? withSecret(state.config, remote) : withSecret(state.config, `http://127.0.0.1:${state.config.port}`)
		sendJson(res, 200, {
			created: true,
			token,
			once,
			expiresAt: Date.now() + hours * 3600000,
			url: `${base.replace(/\/$/, '')}/share?t=${token}`,
			message: once
				? '一次性只读链接已生成（**谁先打开谁看，看完就作废** ✓；' + hours + ' 小时内没打开也会过期 ✓）'
				: `只读链接已生成（${hours} 小时后失效 ✓，随时可以撤销 ✓）`,
		})
	}

	async function handleShareRevoke(req, res) {
		/*
		 * 2.7.1 冷视角复查 **#7（中低）**：撤销是"安全方向"，但**不该让偷到 cookie 的人拿它做破坏** ✗
		 * （把你家人的页面一次性全撤掉 ✓）—— 要求功能仍开着 ✓，并记下是谁撤的 ✓。
		 */
		if (processControlFlag('shareLinks') !== true) {
			sendJson(res, 403, { error: '只读链接没开 —— 没什么可撤的（要先在配置里打开 shareLinks）' })
			return
		}
		let body
		try {
			body = await readBody(req, 8192)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const token = String(body.token ?? '')
		record(`撤销只读链接 <- ${clientIp(req)}`)
		const list = loadShares()
		const next = list.filter((item) => item.token !== token)
		if (next.length === list.length) {
			sendJson(res, 404, { error: '没有这条链接（可能已经过期或被撤销）' })
			return
		}
		await saveShares(next)
		sendJson(res, 200, { revoked: true })
	}

	/** 客人那一页（**不需要登录 cookie** ✓ —— 令牌本身就是凭证 ✓，而且只给这一份 ✓）。 */
	async function handleShareView(req, res, query) {
		const token = String(query.get('t') ?? '')
		if (token.length < 16) {
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
			res.end('链接无效或已失效')
			return
		}
		const found = activeShares().find((item) => {
			try { return timingSafeEqual(Buffer.from(item.token, 'utf8'), Buffer.from(token, 'utf8')) } catch { return false }
		})
		/*
		 * 4.0.0「一次性链接」✓：**第一次打开就记账作废** ✓。
		 * ⚠️ 为什么留一条 410 而不是让它变成 404 ✗：404 是"这条链接不存在" ✓ ——
		 * 而这里是"存在过、**已经被人看过了**" ✓，两件事对用户意义完全不同 ✓
		 *（他得知道"是别人先看了"而不是"我抄错了链接"✓）。
		 * 记账要**先写盘再回页面** ✓：反过来的话，进程在中间挂掉就会漏掉一次消耗 ✓（等于这个人白看两次 ✓）。
		 */
		if (found !== undefined && found.once === true && Number(found.usedAt) > 0) {
			res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, must-revalidate' })
			res.end('这条**一次性**链接已经用过了 —— 别人打开过一次它就作废了 ✓（要看请让对方再发一条 ✓）')
			return
		}
		if (found !== undefined && found.once === true) {
			const all = loadShares()
			const next = all.map((item) => (item.token === found.token ? { ...item, usedAt: Date.now() } : item))
			await saveShares(next)
			record(`一次性只读链接被使用（会话 ${found.sessionId}）<- ${clientIp(req)}`)
		}
		if (found === undefined) {
			/*
			 * 2.7.1 冷视角复查 **#3（中）**：这条路径**不用登录** ✓（令牌即凭证 ✓），
			 * 原来却**完全没有限速** ✗ —— 外人可以匿名无限刷（每次失败还会去遍历会话目录 ✓）。
			 * 令牌 32 位随机猜不中 ✓，但"没有闸的猜测入口"本身就该堵 ✓。
			 */
			if (!throttleLogin(clientIp(req))) {
				res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' })
				res.end('尝试太频繁，请稍后再试')
				return
			}
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
			res.end('链接无效或已失效（可能已过期或被撤销）')
			return
		}
		const exported = exportSessionMarkdown(found.sessionId)
		const until = new Date(found.expiresAt).toLocaleString()
		const body = exported.ok === true
			? escapesHtml(exported.markdown)
			: `（读不到这份会话的内容：${escapesHtml(exported.error)}）`
		// 只读快照 ✓：没有表单、没有输入框、没有脚本 ✓（客人那台设备上什么也改不了 ✓）。
		const html = `<!doctype html><html lang="zh"><meta charset="utf-8">`
			+ `<meta name="viewport" content="width=device-width,initial-scale=1">`
			+ `<title>只读对话 · ${escapesHtml(found.sessionId.slice(0, 18))}</title>`
			+ `<body style="margin:0;background:#101426;color:#dbe4ff;font:13px/1.7 ui-monospace,Menlo,monospace">`
			+ `<div style="position:sticky;top:0;background:rgba(178,120,20,.95);color:#fff;padding:6px 10px;font-weight:700">`
			+ `🔒 只读快照${found.once === true ? '（**一次性**：这一页看过就作废，刷新也会失效 ✓）' : ''} —— 到 ${escapesHtml(until)} 失效；只能看这一份对话，改不了任何东西</div>`
			+ `<pre style="white-space:pre-wrap;word-break:break-word;padding:14px;margin:0">${body}</pre></body></html>`
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store, must-revalidate',
			// 客人页不许被嵌进别的站点 ✓，也不许把来源信息带出去 ✓。
			'x-frame-options': 'DENY',
			'referrer-policy': 'no-referrer',
		})
		res.end(html)
	}

	/* ------------- 3.6.0「分享到桥」：iOS 快捷指令 + 一条 HTTP 短链 ------------- */
	/*
	 * 用户 2026-10-13 亲口选的 8 条里的**第 1 条** ✓（也是他自己排的次序里的第一条 ✓）：
	 * 「任何 App → 分享 → 「手机桥」→ 内容进电脑会话」✓。
	 *
	 * 🔴 **架构规矩（用户明确采纳 ✓「按你说的来」）**：**能不加页面按钮就不加** ✗ ——
	 * 这一条**整条不碰页面** ✓：页面上没有新键、没有新面板 ✓，只有**一条 HTTP 短链** ✓
	 * + 说明页里的一段字 ✓ + 自检里那一条（开着了才出现 ✓）。
	 * 为什么（用血换的 ✗）：`mobile.html` 已经 10.8k 行 ✓，"事件绑定 + 面板重渲染"那次为了
	 * **一个按钮**折腾了 5 轮 ✗（`#powerUnlock`）—— 短链 + 快捷指令那条路完全不碰页面 ✓
	 * → 更稳、更快，也不用再赌"这个节点会不会被重画掉"✓。
	 *
	 * 三条安全设计（和「受限只读链接」同一套纪律 ✓）：
	 *   ① **默认关** ✓：`shareIntake: true` 才开 ✓，和其它开关一样**每次请求现读配置** ✓（关掉立刻生效 ✓）；
	 *   ② **两道凭证缺一不可** ✓：网址里必须有 **pathSecret** ✓（没有就 404 ✓ —— 这一闸是全局的 ✓）
	 *      ＋ 请求里必须有 **PIN** ✓（`body.pin` 或 `x-dsh-pin` 头 ✓，走 `requirePinOr403` ✓ ——
	 *      错一次就**记一笔账** ✓：审计留一行 + 桌面角标会显示"有人正在试 PIN" ✓；
	 *      ⚠️ **说清楚**：它不是"错一次就封" ✗ —— 是**同一 IP 10 分钟内错满 12 次**才封 10 分钟 ✓
	 *      （`LOGIN_MAX_ATTEMPTS` ✓，和登录那条路同一个闸 ✓；复查第 90 轮点名这里原来写满了 ✓）；
	 *   ③ **不新开写入通道** ✗：复用手机发消息那条路 ✓（`sessionController.prompt`，`mode:'queue'` ✓ ——
	 *      排队语义和手机上点「发送」一模一样 ✓，宿主对同一个 `requestId` 幂等 ✓，重试不会变两条 ✓）。
	 *
	 * ⚠️ **为什么"只是发一条消息"也要 PIN** ✗：它等于**替你指挥这台机器** ✓ —— 和手机上点「发送」同级 ✓
	 * （那条路走 `guardWrite`，也要提权 ✓）。而短链是**没有 cookie** 的 ✓，所以只能要"随这次请求的 PIN" ✓
	 * —— 这条正是 2026-10-13 真机日志教的那一课 ✓（`PIN accepted` 紧跟 `403` ✓："登录一次"不算 ✓）。
	 */
	const INTAKE_TEXT_MAX = 8000
	const INTAKE_URL_MAX = 2000
	/** 一次最多几张图 ✓（分享表里带 3 张已经到顶了 ✓；它是"分享"，不是"批量上传" ✓）。 */
	const INTAKE_MAX_IMAGES = 3
	/**
	 * 这条路的包上限 ✓ —— **比 prompt 那条小得多** ✗：它是全项目**唯一一条没有 cookie 的写路由** ✓，
	 * 更没有理由先缓冲一个 128MB 的包才说"PIN 不对" ✓（复查第 90 轮点名 ✓）。
	 * 上限 = 3 张图（base64）+ 一点余量给文本 ✓。
	 */
	const INTAKE_BODY_BYTES = MAX_IMAGE_BASE64 * INTAKE_MAX_IMAGES + 256 * 1024

	/** 这一刻的短链 ✓（和只读链接**同一套拼法** ✓ —— 端口与密钥段都不许漏 ✗，2.7.1 复查点名过 ✓）。 */
	function intakeUrl() {
		const remote = typeof state.config?.publicUrl === 'string' && state.config.publicUrl !== '' ? state.config.publicUrl : ''
		const base = remote !== ''
			? withSecret(state.config, remote)
			: withSecret(state.config, `http://127.0.0.1:${state.config?.port ?? 3081}`)
		return `${String(base).replace(/\/+$/, '')}/api/intake`
	}

	/**
	 * 现读配置里的布尔开关 ✓ —— 复用 `processControlFlag`（**名字是历史遗留** ✓：
	 * 它其实就是"现读配置里的一个 true/false 开关" ✓，`shareLinks` / `processControl` 都走它 ✓）。
	 */
	function intakeEnabled() {
		return processControlFlag('shareIntake') === true
	}

	/**
	 * 3.7.0：**白名单任务预设** ✓ —— 短链上多带一个 `"task"`，这条内容交给 agent 时就**附一句固定指令** ✓
	 * （"拍张照点一下就走"就是它 ✓；池子里的「拍图一键 OCR → 可搜索」与「扫码」这两条都落在同一个机制上 ✓）。
	 *
	 * 为什么是**白名单常量**、不许调用方自己写指令 ✗：这条链是凭证（密钥段 + PIN ✓），但它仍然是
	 * **公开形状**的接口 ✓ —— 允许自由文本指令 = 白送一个"远程指挥 agent"的入口 ✗（那等于把"分享"
	 * 偷偷升级成"任意执行" ✓）。白名单里每个任务都是**只读 / 整理**性质的 ✓（认字、查一下、整理成笔记 ✓），
	 * 没有一个是"改文件 / 跑命令 / 装东西"✗。
	 * ⚠️ **说法要收窄**（复查第 91 轮点名 ✗）：白名单管的是 **`task` 这个字段** ✓ —— 它不接受自由指令 ✓；
	 * 而 `text` 与图片名仍然是**调用方自己的内容** ✓（它们本来就是"分享进来的东西" ✓，这一版不去改写 ✗，
	 * 但也**不拿它们当系统指令用** ✓）。别把这件事说成"整条接口都不接受自由文本" ✗。
	 *
	 * 「可搜索」怎么实现 ✓：识别出来的文字**落在会话里** ✓ —— 手机上现成的 🔍 搜一搜（搜会话内容 ✓）
	 * 就能搜到它 ✓，不用新造一套搜索 ✗（这也是"别重造轮子"那条纪律 ✓）。
	 */
	const INTAKE_TASKS = {
		ocr: '【任务：OCR】把这条消息里图片上的文字**原样认出来**（保留换行与段落，别改写、别总结），'
			+ '存成一份 Markdown 笔记（文件名 `ocr-YYYYMMDD-短关键词.md`，放在这个会话的工作目录里），'
			+ '然后在回复里给出**文件路径** + 识别出来的文字。图里没有文字就直说没有 ✓。',
		scan: '【任务：扫码】这条消息里的图片是一张二维码 / 条形码 / ISBN 条码的照片：'
			+ '把码里的内容解出来（电脑上有能用的工具就用，没有就自己写一小段脚本解 —— 桥自己**不做解码** ✗），'
			+ '再**查一下它是什么**（书号查书名与作者、网址看一眼是什么、别的码照实说是什么码），'
			+ '把结论回给我 ✓；解不出来就直说解不出来 ✓。',
	}

	/** 目标会话：手机可以指定 ✓；没指定就**自动挑"最近一个能用的"** ✓（分享这条路不许让人先选 ✗）。 */
	async function intakeTarget(sessionId) {
		const listed = await listSessions()
		if (sessionId !== '') {
			const found = listed.find((entry) => entry.sessionId === sessionId) ?? null
			return found === null ? { error: '指定的会话在电脑上没找到（可能已归档/关掉了）' } : { picked: found }
		}
		// 子会话 / 自检会话 / 空会话都不算"能用" ✓（手机上那份列表也默认不摆它们 ✓）。
		const picked = listed.find((entry) => entry.blank !== true && entry.subagent !== true && entry.ownDir !== true) ?? null
		return picked === null ? { error: '电脑上还没有可用的会话 —— 先在手机上开一个（或指定 sessionId）' } : { picked }
	}

	/**
	 * `POST /api/intake` —— 快捷指令 POST 到这里 ✓（**没有 cookie** ✓，靠"短链里的密钥段 + 这次请求里的 PIN"✓）。
	 *
	 * 支持的三种输入（够快捷指令的分享表用了 ✓）：`text` ✓ / `url` ✓ / `images[{mediaType,data}]` ✓
	 * （base64 ✓ —— 快捷指令里「Base64 编码」一下就能带过来 ✓）。
	 * ⚠️ 照实说：**分享文件（PDF 等）这一版没做** ✗ —— 大文件要走分片上传 ✓，而快捷指令里拼分片不值得 ✓；
	 * 真要发文件：手机上用「文件」键 ✓（那条路已经现成 ✓）。
	 */
	/**
	 * 把请求体**读干净**再回绝 ✓ —— 只读一半就 `return` 会把连接留成半截 ✗
	 * （`handleClientLog` 那边踩过这个坑 ✓：客户端看到的是 ECONNRESET，而且那条半截连接会毒到
	 * 紧随其后的请求 ✓）。读进来的东西直接丢掉 ✓（不存、不记 ✓）。
	 */
	async function drainRequest(req) {
		try { for await (const _chunk of req) { /* 丢掉 ✓ */ } } catch { /* 读挂了也照样回绝 ✓ */ }
	}

	async function handleIntake(req, res) {
		/*
		 * ① **先判开关、再读包** ✗（复查第 90 轮点名 ✓）：这是全项目唯一一条**没有 cookie** 的写路由 ✓ ——
		 * 没理由让它先缓冲一个大包才说"没开" ✓。关着时把包读干净（别留半截连接 ✓）再 403 ✓。
		 */
		if (intakeEnabled() !== true) {
			await drainRequest(req)
			sendJson(res, 403, { error: '「分享到桥」默认关闭 —— 在 ~/.dsh/mobile-bridge.json 里加 "shareIntake": true（改完立刻生效）✓' })
			return
		}
		let body
		try {
			body = await readBody(req, INTAKE_BODY_BYTES)
		} catch (error) {
			sendJson(res, 413, {
				error: `分享的包太大或格式不对（上限约 ${Math.round(INTAKE_BODY_BYTES / 1024 / 1024)} MB —— `
					+ `一次最多 ${INTAKE_MAX_IMAGES} 张图 ✓）：${String(error?.message ?? error)}`,
			})
			return
		}
		// ② PIN 必须在**这一次请求**里 ✓（短链没有 cookie ✓，不存在"登录一次"那条路 ✓）。
		if (await requirePinOr403(req, res, body, {
			what: '分享到桥', code: 'share-intake', why: '它会把这条内容直接交给 agent',
		}) !== true) return

		/*
		 * ③ 任务预设（3.7.0 ✓）：白名单外的一律 **400 并列出能用哪些** ✗ —— 悄悄忽略掉 `task`
		 * 是最坏的一种（用户以为"它帮我 OCR 了" ✓，其实只是把图丢进去 ✓）。
		 * ⚠️ 复查第 91 轮补的三处漏网 ✗：
		 *   ① **带了 `task` 但值是空的**（`""` / `null` ✓）原来被当成"没带" ✓ → 现在 400 ✓
		 *      （要么别带这个字段 ✓、要么写对 ✓ —— 与"名单外 → 400"的口径一致 ✓）；
		 *   ② **非字符串**（`["ocr"]` / 数字 ✓）原来被 `String()` 强转成 `"ocr"` 收下了 ✓ → 现在只认字符串 ✓；
		 *   ③ 白名单查表用 `hasOwnProperty.call` ✓（`constructor` / `__proto__` / `toString` 都拿不到指令 ✓），
		 *      并**由断言钉住** ✓（不然把它换成 `in` 也照样绿 ✗）。
		 */
		const hasTask = body !== null && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'task')
		const rawTask = body?.task
		const taskKey = typeof rawTask === 'string' ? rawTask.trim() : ''
		if (hasTask === true && (typeof rawTask !== 'string' || taskKey === ''
			|| Object.prototype.hasOwnProperty.call(INTAKE_TASKS, taskKey) !== true)) {
			const shown = typeof rawTask === 'string' ? `「${taskKey.slice(0, 40)}」` : JSON.stringify(rawTask ?? null).slice(0, 40)
			sendJson(res, 400, {
				error: `task 只认这几个：${Object.keys(INTAKE_TASKS).join(' / ')} —— `
					+ (taskKey === '' && typeof rawTask === 'string' ? '这次给的是空的（要么别带这个字段 ✓，要么写对 ✓）' : `这次给的是 ${shown}`),
			})
			return
		}
		/*
		 * ③ 内容 + **截断/丢弃都要说出来** ✗（复查第 90 轮点名：原来 text `slice(0,8000)`、url `slice(0,2000)`、
		 * 图超 20 直接 slice ✓ —— 回包和日志都不提丢了什么 ✗，正是本项目最恨的"我明明发了啊" ✓）。
		 * 规矩：**能收就收，收不下的明说** ✓ —— 内容里补一句、回包给计数、日志记下来 ✓。
		 */
		const rawText = String(body?.text ?? '').trim()
		const rawUrl = String(body?.url ?? '').trim()
		const text = rawText.slice(0, INTAKE_TEXT_MAX)
		const url = rawUrl.slice(0, INTAKE_URL_MAX)
		const allImages = Array.isArray(body?.images) ? body.images : []
		const images = allImages.slice(0, INTAKE_MAX_IMAGES)
		const cutText = rawText.length > INTAKE_TEXT_MAX
		const cutUrl = rawUrl.length > INTAKE_URL_MAX
		const droppedImages = Math.max(0, allImages.length - INTAKE_MAX_IMAGES)
		// ③ 内容：来源写最前面 ✓ —— 会话里一眼看得出"这条不是我手打的"✓（用户也会想知道它是谁塞进来的 ✓）。
		//    带 `task` 时，**固定指令紧跟来源** ✓（在图片之前 ✓ —— 模型按顺序看 ✓，"先知道要干什么"更稳 ✓）。
		const content = [{ type: 'text', text: '【分享到桥】' }]
		if (taskKey !== '') content.push({ type: 'text', text: INTAKE_TASKS[taskKey] })
		if (text !== '') content.push({ type: 'text', text })
		if (url !== '') content.push({ type: 'text', text: url })
		const loses = []
		if (cutText) loses.push(`文本太长，只取了前 ${INTAKE_TEXT_MAX} 字（原本 ${rawText.length} 字）`)
		if (cutUrl) loses.push(`网址太长，只取了前 ${INTAKE_URL_MAX} 字符`)
		if (droppedImages > 0) loses.push(`另外 ${droppedImages} 张图没带上（一次最多 ${INTAKE_MAX_IMAGES} 张）`)
		if (loses.length > 0) content.push({ type: 'text', text: `（分享到桥：${loses.join('；')} ✓）` })
		for (const image of images) {
			const mediaType = String(image?.mediaType ?? '')
			const data = String(image?.data ?? '')
			if (IMAGE_TYPES.has(mediaType) !== true) { sendJson(res, 400, { error: `不支持的图片类型: ${mediaType}` }); return }
			if (data === '' || data.length > MAX_IMAGE_BASE64) { sendJson(res, 400, { error: '图片为空或过大' }); return }
			content.push({
				type: 'image',
				mediaType,
				data,
				/*
				 * ⚠️ 复查第 91 轮：**成功这条路也要过 `safeUploadName`** ✗ —— 原来只有 rescue 那条过 ✓，
				 * 于是带路径分隔符 / 控制字符 / 超长的图片名能**原样进 prompt** ✓（两条路不一致 ✓）。
				 * 名字只是给人看的标签 ✓，过一遍没有任何损失 ✓。
				 */
				...(typeof image?.name === 'string' && image.name !== '' ? { name: safeUploadName(image.name) } : {}),
			})
		}
		if (text === '' && url === '' && images.length === 0) {
			sendJson(res, 400, { error: '内容为空：text / url / images 至少要带一样 ✓' })
			return
		}

		let target
		try {
			target = await intakeTarget(String(body?.sessionId ?? ''))
		} catch (error) {
			sendJson(res, 503, { error: `读不到电脑上的会话列表：${String(error?.message ?? error)}` })
			return
		}
		if (target.error !== undefined) { sendJson(res, target.error.includes('还没有可用') ? 409 : 404, { error: target.error }); return }
		const picked = target.picked
		const sessionId = String(picked.sessionId)
		const supplied = String(body?.requestId ?? '')
		const requestId = /^[A-Za-z0-9-]{8,64}$/.test(supplied) ? supplied : randomUUID()
		const send = async (parts) => ctx.sessionController.prompt(
			{ requestId, sessionId, mode: 'queue', content: parts, clientTimeZone: 'Asia/Shanghai' },
			AbortSignal.timeout(30000),
		)
		try {
			const accepted = await send(content)
			record(`intake accepted for ${sessionId} (${images.length} image(s), ${text.length} char(s), url=${url === '' ? 'no' : 'yes'}` +
				`${loses.length > 0 ? `, 截断/丢弃：${loses.join('；')}` : ''})`)
			// ⚠️ 回包里**绝不带 PIN** ✓（只回"进了哪个会话" ✓ —— 快捷指令上要能确认它落对了地方 ✓）；
			// 截断/丢弃的计数也一并回 ✓（复查第 90 轮点名：不许静默丢 ✗）。
			sendJson(res, 200, {
				ok: true,
				sessionId,
				title: String(picked.title ?? ''),
				requestId,
				accepted: accepted?.accepted === true,
				images: images.length,
				...(taskKey === '' ? {} : { task: taskKey }),
				...(loses.length > 0 ? { truncated: true, dropped: { text: cutText, url: cutUrl, images: droppedImages }, note: loses.join('；') } : {}),
			})
			return
		} catch (error) {
			const message = String(error?.message ?? error)
			record(`intake rejected for ${sessionId}: ${message}`)
			// 图片被宿主拒了（最常见是**动图**：宿主解码多帧图会失败 ✓）→ 存成文件 + 只给路径再发一次 ✓
			// （和手机那条路同一个退路 ✓ —— 别让用户干瞪眼 ✗）。
			if (images.length > 0 && !isUnfollowable(message)) {
				try {
					const rescued = []
					for (const image of images) {
						const name = safeUploadName(String(image?.name ?? `share-${rescued.length + 1}`))
						rescued.push(await saveUpload({ name, mediaType: String(image?.mediaType ?? ''), data: String(image?.data ?? '') }))
					}
					const retryContent = content.filter((entry) => entry.type !== 'image')
					const note = describeSavedFiles(rescued)
					if (note !== '') retryContent.push({ type: 'text', text: note })
					const accepted = await send(retryContent)
					record(`intake rescued ${rescued.length} image(s) as files for ${sessionId}`)
					/*
					 * ⚠️ 别乱归因 ✗（复查第 90 轮点名）：失败原因**不一定是"解码不了"** ✓ ——
					 * 也可能是会话忙 / 宿主内部报错 ✓。所以只有**看起来像解码失败**时才那么说 ✓，
					 * 其余照实说"带图没送成 + 宿主原话" ✓。
					 */
					const decodeish = /decode|decod|image|gif|unsupported|invalid|format/i.test(message)
					sendJson(res, 200, {
						ok: true,
						sessionId,
						title: String(picked.title ?? ''),
						requestId,
						accepted: accepted?.accepted === true,
						images: 0,
						files: rescued.map((entry) => entry.name),
						...(taskKey === '' ? {} : { task: taskKey }),
						note: decodeish
							? '图片电脑解不开，已经存成文件、把路径交给 agent 了 ✓'
							: `这次带图没送成（${message}）—— 已经改成文件、把路径交给 agent 了 ✓`,
					})
					return
				} catch (retryError) {
					record(`intake rescue failed for ${sessionId}: ${String(retryError?.message ?? retryError)}`)
				}
			}
			sendJson(res, 502, { error: `这次没进去：${message}`, sessionId })
		}
	}

	/** `GET /api/intake` —— 手机（有 cookie ✓）读"开没开 / 短链是什么 / 会进哪个会话"✓（只读 ✓）。 */
	async function handleIntakeInfo(res) {
		const enabled = intakeEnabled() === true
		let picked = null
		if (enabled === true) {
			try {
				const target = await intakeTarget('')
				picked = target.picked ?? null
			} catch { picked = null }
		}
		sendJson(res, 200, {
			enabled,
			url: enabled === true ? intakeUrl() : '',
			pinRequired: true,
			// 3.7.0：白名单任务预设 ✓ —— 短链上带 `"task":"ocr"` 就等于"一键 OCR" ✓（手机不用懂怎么认字 ✓）。
			tasks: Object.keys(INTAKE_TASKS),
			sessionId: picked === null ? '' : String(picked.sessionId),
			title: picked === null ? '' : String(picked.title ?? ''),
			how: enabled === true
				? 'iOS 快捷指令：① 新建快捷指令并打开「在分享表单中显示」② 「接收」文本与网址（和图片）'
					+ '③ 「获取 URL 内容」POST 到上面这个地址，请求体 JSON 写 {"pin":"六位 PIN","text":"…"}'
					+ '④ 想"一键 OCR"就再加 "task":"ocr"（拍张照点一下就让它认字并存成可搜索的笔记 ✓），'
					+ '扫码用 "task":"scan" ✓ ⑤ 分享时选它就行 ✓'
				: '「分享到桥」默认关闭 —— 在 ~/.dsh/mobile-bridge.json 里加 "shareIntake": true（改完立刻生效）✓',
		})
	}

	/* --------------- 一键自检（2.8.0 池子里的 ★1「桥的一键自检 + 修复建议」） --------------- */
	/*
	 * 用户的痛：连不上时不知道**卡在哪一环** ✗（今天手工查了好几次 ✓）。
	 * 这一版把它做成一个按钮 ✓ —— 大部分是**接出来**：
	 *   · 四条现成 ✓：`powerPreflight()`（桥在听 / 桌面端在听 / 开机自启装没装 / 有没有会话在跑 ✓，
	 *     每条都带 `hint` = "怎么办" ✓）；
	 *   · 再加：外网隧道通不通 ✓、写权限（能不能往上传目录写 ✓）、ffmpeg 在不在 ✓（转写/抽帧要用 ✓）。
	 * 纪律：**只读** ✓（不启动任何东西 ✗ —— 那是 `tools/boot-up.ps1` 的活 ✓）；**读不到就说读不到** ✗
	 * （绝不假装 ok ✓，照 ★3 那条 ✓）。**不含**"publish 目录干净" ✗ —— 插件不该知道维护者的发布目录 ✓。
	 */
	/**
	 * `probe` = true 时**先探一次再报** ✓（用户点 🩺 就是想知道"现在通不通" ✓）。
	 * 冷视角复查抓到：`state.tunnel.ok` 初值原来写 `true`，而探测只在角标那条路里注册 ——
	 * `webServer` 缺失时**根本没人探** ✗，"没测过"于是被说成"外网可达 ✓"。
	 * 现在三态分明：`null` = 没测过 ✓（如实说，并给出立刻确认的办法 ✓）。
	 */
	async function tunnelCheck(probe) {
		const remote = typeof state.config?.publicUrl === 'string' && state.config.publicUrl !== '' ? state.config.publicUrl : ''
		if (remote === '') return { name: '外网隧道', ok: true, hint: '没配外网 —— 只在局域网用；要外网就配 publicUrl ✓' }
		const tunnel = state.tunnel
		// 该不该现探：没探过 / 探的是**别的地址**（隧道重启会换域名 ✓）/ 已经超过 120 秒 ✓。
		const current = withSecret(state.config, remote)
		const stale = tunnel.ok === null || tunnel.probedUrl !== current || Date.now() - Number(tunnel.at ?? 0) > 120000
		if (probe === true && stale && typeof tunnel.probe === 'function') {
			try { await tunnel.probe() } catch { /* 探测自己吞异常；这里失败就当"不通" */ }
		}
		const funnelHint = `在电脑上跑 \`tailscale funnel --bg ${state.config.port}\` 重开一次`
		/*
		 * 🔴 5.0.3：三种状态都要说清，尤其**不许假绿** ✗ ——
		 *   ① `unverifiable`：本机 MagicDNS 抄近路 + 公网 DNS 也不通 ⇒ 说"没法验证" ✓，不说"可达" ✗；
		 *   ② `ok === false`：探的是**公网入口 IP**（MagicDNS 近路已绕开 ✓）⇒ 失败大概率是真坏了 ✓，
		 *      直接给修法（重开 Funnel ✓），同时保留"手机可能仍能连"（本机网络问题也会失败 ✓）；
		 *   ③ `ok === true`：说清是从公网入口 IP 实测的 ✓（不是 MagicDNS 近路 ✓）。
		 */
		if (tunnel.mode === 'unverifiable') {
			return { name: '外网隧道', ok: false, hint: `没法从本机验证外网入口（本机 *.ts.net 走 MagicDNS、公网 DNS 也不通）—— 手机连不上就${funnelHint}；先用局域网地址也行 ✓` }
		}
		if (tunnel.ok === false) {
			const tried = tunnel.mode === 'external-ingress' && tunnel.address !== ''
				? `（走公网入口 IP ${tunnel.address} 也连不上${tunnel.detail ? `：${tunnel.detail}` : ''}）`
				: (tunnel.detail ? `（${tunnel.detail}）` : '')
			return { name: '外网隧道', ok: false, hint: `外网入口不通 ✗${tried} —— ${funnelHint}（或 tools\\tunnel-status.ps1 看逐项）；手机此时可用局域网地址 ✓` }
		}
		if (tunnel.ok === true) {
			const how = tunnel.mode === 'external-ingress' && tunnel.address !== ''
				? `（从公网入口 IP ${tunnel.address} 实测 ✓）`
				: ''
			return { name: '外网隧道', ok: true, hint: `外网可达 ✓${how}（手机在任何网络下都能连 ✓）` }
		}
		if (Number(tunnel.fails ?? 0) > 0) {
			// 探了一次没通（还没到"连续两次"的改判门槛 ✓）—— 如实说"这一次没通" ✓，
			// 不因为"门槛没到"就把它说成没事 ✗。
			return { name: '外网隧道', ok: false, hint: `刚探了一次**没通**（桥要连续两次才改判，这里如实说这一次的结果）—— ${funnelHint}；手机此时可用局域网地址 ✓` }
		}
		// 没测过：**不许说"可达"** ✗ —— 说清"还没测到"和两条立刻确认的路 ✓。
		return {
			name: '外网隧道',
			ok: true,
			hint: typeof tunnel.probe === 'function'
				? '还没探测过（桥每 120 秒探一次）—— 这次没能确认；再点一次「重新检查」就会现探 ✓'
				: '这台组合没有注册隧道探测（桌面角标没装上）—— 跑 tools\\tunnel-status.ps1 确认 ✓',
		}
	}

	async function collectSelfcheck(options = {}) {
		const checks = await powerPreflight()
		// ① 外网隧道：配了 publicUrl 才有意义 ✓；`probe:true`（手机点 🩺）时先现探一次 ✓。
		checks.push(await tunnelCheck(options.probe === true))
		// ② 写权限：能不能往上传目录写（不能写 = 发图/发文件会失败 ✗）
		try {
			const dir = join(dshHome(), 'mobile-uploads')
			await mkdir(dir, { recursive: true })
			const probe = join(dir, '.selfcheck')
			await writeFile(probe, 'ok', 'utf8')
			await unlink(probe).catch(() => {})
			checks.push({ name: '写权限', ok: true, hint: '上传目录可写 ✓' })
		} catch (error) {
			checks.push({ name: '写权限', ok: false, hint: `往 ~/.dsh/mobile-uploads 写不进去：${String(error?.message ?? error)}` })
		}
		// ③ ffmpeg：转写/视频抽帧要用 ✓（没配就看 ~/.dsh/bin ✓，再没有就说没有 ✓）
		const ffmpeg = typeof state.config.ffmpegPath === 'string' && state.config.ffmpegPath !== ''
			? state.config.ffmpegPath
			: join(dshHome(), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
		checks.push(existsSync(ffmpeg)
			? { name: 'ffmpeg', ok: true, hint: `找到 ${ffmpeg} ✓（视频抽帧/语音转写要用 ✓）` }
			: { name: 'ffmpeg', ok: false, hint: '没找到 —— 视频抽帧会不可用；想要就把它放到 ~/.dsh/bin 或在配置里写 ffmpegPath ✓' })
		/*
		 * ④ 分享到桥（3.6.0 ✓）：**只在开着的时候**加这一条 ✓。
		 * 默认关是绝大多数人的正常状态 ✓ —— 摆一条"没开"的红项就是"狼来了"（复查第 83 轮的教训 ✓，
		 * 和"没配 webhookSecret 就不加警告"同一个道理 ✓）。怎么开写在说明页里 ✓；开着的时候
		 * 把短链摆在这儿 ✓ —— 用户要照抄进快捷指令 ✓（这是它唯一的"看得见"的地方 ✓，页面不用加键 ✓）。
		 */
		if (processControlFlag('shareIntake') === true) {
			checks.push({ name: '分享到桥', ok: true, hint: `已开启 ✓ 短链：${intakeUrl()}（快捷指令 POST 它，带上 PIN ✓）` })
		}
		return checks
	}

	async function handleSelfcheck(res) {
		// 手机点这个键 = 想知道"现在通不通" ✓ → 让隧道那一条**现探一次** ✓（只读，不启动东西 ✓）。
		const checks = await collectSelfcheck({ probe: true })
		const bad = checks.filter((item) => item.ok !== true).length
		sendJson(res, 200, {
			ok: bad === 0,
			bad,
			count: checks.length,
			at: Date.now(),
			checks,
			note: bad === 0 ? '全部正常 ✓' : `有 ${bad} 项要处理（每项后面就是"怎么办" ✓）`,
		})
	}

	/* --------------- 诊断包（2.8.0 池子里的 ★4「错误一键重试 + 诊断包」） --------------- */
	/*
	 * 现场：出问题时用户只能说"不 work" ✗ —— 而这台机器上的证据散在四处
	 * （`mobile-bridge.log` / `dsh-crash.log` / 登录账 / 自检结果 ✓），让他一个个找、
	 * 一个个发，等于让他干我们该干的活 ✓。这一条把它们**拼成一份可下载的文本** ✓，
	 * 手机上一个键就拿到 ✓。
	 *
	 * 三条纪律：
	 *   ① **脱敏**：PIN 与密钥段（网址里那串）一律换成占位符 ✗✗ —— 诊断包是要发出去的 ✓；
	 *   ② **限量**：每份日志只截最近一段 ✓（几十 KB，微信也发得动 ✓）—— 绝不整份塞进去 ✓；
	 *   ③ **只读**：登录即可 ✓（它只"把现状说出来"，不改任何东西 ✓）。
	 */
	const DIAG_TAIL_BYTES = 48 * 1024

	/**
	 * 把不该出门的东西替换掉 ✓。
	 *
	 * 必做的两样：PIN 与密钥段（网址里那串）✓。
	 * 再加两条**通用**的（纵深防御 ✓，不是保证 ✗ —— 冷视角复查提醒过：只洗两个已知常量
	 * 就敢在界面上承诺"会被替换掉"，是把话说满了 ✓）：
	 *   · `Authorization: Bearer …` 这类整段；· `sk-…` / `sk_…` 形状的 key（DeepSeek/OpenAI 都是这个形状 ✓）。
	 * 最后**回一句"洗没洗成"** ✓：配置读不到时（pin / pathSecret 为空）就在包里写明
	 * "没能确认脱敏" ✓ —— 绝不静默假设自己洗过了 ✗。
	 */
	function redactDiag(text) {
		let out = String(text ?? '')
		const secret = String(state.config?.pathSecret ?? '')
		const pin = String(state.config?.pin ?? '')
		const missing = []
		if (secret !== '') out = out.split(secret).join('<密钥段>')
		else missing.push('密钥段')
		if (pin !== '') out = out.split(pin).join('<PIN>')
		else missing.push('PIN')
		/*
		 * 复查（第 83 轮）R5：**`webhookSecret` 以前不在脱敏名单里** ✗ ——
		 * 实测它（或它的尾部片段）能进 `mobile-bridge.log` ✓，而诊断包又会把日志尾塞进来 ✓
		 * → 等于随 `/api/diag` 发出去 ✗。这里按"整段替换"补上 ✓（尾部片段那一半靠
		 * `webhookConfig()` 不再记 `error.message` 挡住了 ✓，见那边注释 ✓）。
		 * ⚠️ 没配 `webhookSecret` 时**不**往 `missing` 里加 ✓ —— 那是绝大多数人的正常状态 ✓，
		 * 加了会让每一份诊断包都顶着"没能确认脱敏"的警告 ✗（狼来了 ✓）。
		 */
		const webhookSecret = String(state.config?.webhookSecret ?? '')
		if (webhookSecret.length >= 4) out = out.split(webhookSecret).join('<webhook 密钥>')
		// 复审 R7 同类 + N5：`https://user:pass@host/` 里的凭据也不能随包发出去 ✓。
		// ⚠️ 正则里**必须排除 `?` `#` `/`** ✓ —— 否则 `https://example.com?x=a@b` 这种
		// "查询串里带 @"的正常地址会被误洗 ✓（复审第 83 轮 N5 实测 ✓）。
		out = out.replace(/(https?:\/\/)[^/\s?#@]{1,120}@/gi, '$1<已隐去用户名/密码>@')
		out = out.replace(/(Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 <已隐去>')
		out = out.replace(/sk[-_][A-Za-z0-9_-]{12,}/g, '<已隐去的 key>')
		if (missing.length > 0) {
			out = `⚠️ 这份包里**没能确认脱敏**：读不到 ${missing.join(' 与 ')}（配置文件里是空的？）—— `
				+ '发出去之前请自己扫一眼有没有密钥。\n\n' + out
		}
		return out
	}

	/** 只留最后 N 字节（按行切开，别把半行留下 ✓）。 */
	function tailOf(text, bytes = DIAG_TAIL_BYTES) {
		const raw = String(text ?? '')
		if (raw.length <= bytes) return raw
		const cut = raw.slice(-bytes)
		const nl = cut.indexOf('\n')
		return `…（更早的内容省略了，只留最近约 ${Math.round(bytes / 1024)} KB）\n${nl < 0 ? cut : cut.slice(nl + 1)}`
	}

	/** 读一个文件的尾部（读不到就回一句人话 ✓，不假装读到 ✓）。 */
	async function tailFile(file, bytes = DIAG_TAIL_BYTES) {
		try {
			return tailOf(await readFile(file, 'utf8'), bytes)
		} catch (error) {
			return `（读不到 ${file}：${String(error?.code ?? error?.message ?? error)}）`
		}
	}

	/** 一行里不许出现换行 ✓（IP / UA 都是外部来的字串 —— 换行会把包的结构撑乱 ✓）。 */
	const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ')

	async function handleDiag(res) {
		// 诊断包**不现探隧道** ✓（它是"把现状收齐"，不该让下载等 8 秒 ✓）—— 报上次探测的时间 ✓。
		const checks = await collectSelfcheck({ probe: false })
		const now = new Date()
		const remote = typeof state.config.publicUrl === 'string' && state.config.publicUrl !== '' ? state.config.publicUrl : ''
		const probedAt = Number(state.tunnel.at ?? 0) > 0 ? new Date(Number(state.tunnel.at)).toLocaleString() : '还没探过'
		const lines = []
		lines.push('手机桥 · 诊断包（可以整份发给维护者 ✓）')
		lines.push('='.repeat(46))
		lines.push(`生成时间：${now.toLocaleString()}（${now.toISOString()}）`)
		lines.push(`桥版本：${bridgeVersion()}   ·   Node ${process.version}   ·   ${process.platform} ${process.arch}`)
		lines.push(`端口：${state.config.port}   ·   外网：${remote === '' ? '没配（只在局域网用）' : `已配（隧道 ${state.tunnel.ok === false ? '不通 ✗' : (state.tunnel.ok === true ? '通 ✓' : '没探过')}；上次探测 ${probedAt}）`}`)
		lines.push(`登录态设备：${liveTokenCount()} 台   ·   最近登录失败：${state.recentFailures.length} 次   ·   待回答的卡片：${state.pending.size} 个`)
		lines.push('')
		lines.push('## 自检（只读，和手机上 🩺 那份同源）')
		for (const item of checks) lines.push(`${item.ok === true ? '[ok]' : '[!!]'} ${item.name} —— ${item.hint}`)
		lines.push('')
		lines.push('## 登录账（最近 10 条；IP 是来源地址，走外网时是隧道那端的）')
		const logins = (await readLoginLog()).slice(-10)
		if (logins.length === 0) lines.push('（还没有登录记录）')
		for (const item of logins) {
			lines.push(`${new Date(Number(item.at ?? 0)).toLocaleString()}  ${item.ok === true ? '成功' : '失败'}  ${oneLine(item.what)}  ${oneLine(item.ip)}${item.firstSeen === true ? '  [新设备]' : ''}  ua=${oneLine(item.ua)}`)
		}
		lines.push('')
		lines.push('## 审批账（最近 5 条）')
		try {
			const text = await readFile(approvalLogFile(), 'utf8')
			const rows = text.split('\n').filter((line) => line.trim() !== '').slice(-5)
			if (rows.length === 0) lines.push('（还没有审批记录）')
			for (const row of rows) lines.push(row)
		} catch {
			lines.push('（还没有审批记录 / 读不到）')
		}
		lines.push('')
		lines.push(`## mobile-bridge.log（尾部 ${Math.round(DIAG_TAIL_BYTES / 1024)} KB）`)
		lines.push(await tailFile(state.accessLog))
		lines.push('')
		lines.push('## dsh-crash.log（尾部；只有开过崩溃探针才有内容）')
		lines.push(await tailFile(join(dshHome(), 'dsh-crash.log'), 16 * 1024))
		lines.push('')
		lines.push('（完）')
		const body = redactDiag(lines.join('\n'))
		/*
		 * 文件名叫纯 ASCII ✓：中文文件名要按 RFC 5987 编码，浏览器与微信处理得不一致 ✗
		 * —— 这是"发给我"的东西，打不开就等于没做 ✓。
		 */
		const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
		const raw = Buffer.from(body, 'utf8')
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': 'text/plain; charset=utf-8',
			'content-disposition': `attachment; filename="mobile-bridge-diag-${stamp}.txt"`,
			'content-length': raw.length,
		})
		res.end(raw)
	}

	/** Create one ordinary Session; the first message goes through /api/prompt. */	async function handleCreateSession(req, res) {
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const request = {}
		if (typeof body.workspaceId === 'string' && body.workspaceId !== '') request.workspaceId = body.workspaceId
		if (typeof body.cwd === 'string' && body.cwd !== '') request.cwd = body.cwd
		if (typeof body.agentPreset === 'string' && body.agentPreset !== '') request.agentPreset = body.agentPreset
		if (Object.keys(request).length === 0) {
			sendJson(res, 400, { error: '需要 workspaceId、cwd 或 agentPreset 之一' })
			return
		}
		try {
			const created = await ctx.sessionController.create(request)
			record(`session created ${created.sessionId} <- ${clientIp(req)}`)
			sendJson(res, 200, { sessionId: created.sessionId, agentPreset: created.agentPreset ?? null })
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	/**
	 * 权限档位的中文说法。宿主只给预设名（read-only / workspace-write /
	 * danger-full-access），手机上必须说人话 —— 用户要一眼看懂"我现在放开了多少"。
	 * 未来多出未知预设时退回预设名本身，不编造说明。
	 */
	const PERMISSION_TEXT = {
		'read-only': { label: '只读', detail: '能看、能读文件，不能改任何东西。看资料、查代码用这档。' },
		'workspace-write': { label: '可写工作区', detail: '能在项目文件夹里建文件、改文件、跑命令；动到文件夹外面时要问你一次。' },
		'danger-full-access': { label: '完全放开', detail: '整台机器都能改、命令不再逐条问你。只在你盯着它干活时用。' },
	}

	/** 权限服务 + 会话对象（读和写都要这两样）。缺一样就返回一句能懂的原因。 */
	function permissionRig(sessionId) {
		const presets = ctx.get('permissionPresets')
		if (presets === undefined || typeof presets.current !== 'function' || typeof presets.set !== 'function') {
			return { error: '这台电脑上的 DSH 没装权限预设（permissionPresets），手机上改不了权限。' }
		}
		const sessions = ctx.get('sessions')
		if (sessions === undefined || typeof sessions.get !== 'function') {
			return { error: '读不到会话列表，手机上改不了权限。' }
		}
		const session = sessions.get(sessionId)
		if (session === undefined) {
			return { error: '这个会话在电脑上没找到（可能已经关掉了）—— 换一个会话再试。' }
		}
		return { presets, session }
	}

	/** 一档权限 → 手机要的纯数据（人话标签 ✓；未知预设退回预设名 + 宿主给的沙箱/审批 ✓，不编造 ✓）。 */
	function permissionOptionOf(value, presets) {
		if (typeof value !== 'string' || value === '') return null
		let spec = null
		try { spec = presets.resolve(value) } catch { spec = null }
		const text = PERMISSION_TEXT[value]
		return {
			value,
			label: text?.label ?? value,
			detail: text?.detail ?? (spec === null ? '' : `沙箱 ${spec.sandbox} · 审批 ${spec.approval}`),
			sandbox: spec?.sandbox ?? null,
			approval: spec?.approval ?? null,
		}
	}

	/** 权限快照：现在哪档 + 所有可选档位（都是纯数据，直接给手机渲染）。 */
	function permissionSnapshot(session, presets) {
		const current = String(presets.current(session) ?? '')
		const options = []
		const append = (value) => {
			if (typeof value !== 'string' || value === '' || options.some((entry) => entry.value === value)) return
			const option = permissionOptionOf(value, presets)
			if (option !== null) options.push(option)
		}
		for (const name of presets.names) append(name)
		// custom = 沙箱与审批的组合不落在任何预设上（比如在桌面上手动调过某一项）。
		// 仍然摆在列表里，用户才知道"现在这档不是我以为的那档"。
		append(current)
		return { current, options, label: PERMISSION_TEXT[current]?.label ?? current }
	}

	/**
	 * 权限**目录**（3.5.0 ✓）：手机在「新建任务」那张纸上**会话还不存在** ✗，所以拿不到
	 * `permissionSnapshot`（它要一个 session ✓）—— 这时它需要的是"这台电脑上默认是哪档 ✓、
	 * 有哪些档可选 ✓"，好让人**在创建之前**就定下权限 ✓（用户 2026-10-13：「新建任务时没有
	 * 权限选择」✗ —— 以前只能在建完之后去 🔐 改 ✓，于是"这条任务按什么权限跑"是建完才知道的 ✗）。
	 *
	 * 真值来自宿主 `permissionPresets.catalog()` ✓（`defaultPreset` + `options` ✓）——
	 * 桥**不自己编档位** ✓（用户机器上有可能装了别的预设 ✓，人话表里没有的就退回预设名本身 ✓）。
	 */
	function permissionCatalog() {
		const presets = ctx.get('permissionPresets')
		if (presets === undefined || typeof presets.catalog !== 'function') {
			return { error: '这台电脑上的 DSH 没装权限预设（permissionPresets），手机上选不了权限。' }
		}
		let catalog = null
		try { catalog = presets.catalog() } catch { catalog = null }
		if (catalog === null || catalog === undefined) {
			return { error: '这台电脑上的权限目录读不到 —— 新建时先不动它（按默认走）。' }
		}
		const options = []
		const append = (value) => {
			if (typeof value !== 'string' || value === '' || options.some((entry) => entry.value === value)) return
			const option = permissionOptionOf(value, presets)
			if (option !== null) options.push(option)
		}
		for (const option of (Array.isArray(catalog.options) ? catalog.options : [])) append(String(option?.value ?? ''))
		const defaultPreset = String(catalog.defaultPreset ?? '')
		// 默认那一档**必须在列表里** ✓：前端拿它做「跟随默认（不改）」的对照 ✓，
		// 也是"用户什么都没选、这次就按它跑"的那个答案 ✓。
		append(defaultPreset)
		return { current: '', defaultPreset, options }
	}

	/** 读：这台电脑的默认档与可选档（**没有会话**时用 ✓ —— 新建面板 ✓）。 */
	async function handlePermissionCatalog(res) {
		const catalog = permissionCatalog()
		if (catalog.error !== undefined) { sendJson(res, 404, { error: catalog.error }); return }
		sendJson(res, 200, catalog)
	}

	/** 读：这个会话现在允许 agent 做到哪一步。 */
	async function handlePermission(req, res, url) {
		const sessionId = String(url.searchParams.get('sessionId') ?? '')
		if (sessionId === '') { sendJson(res, 400, { error: '缺少 sessionId' }); return }
		const rig = permissionRig(sessionId)
		if (rig.error !== undefined) { sendJson(res, 404, { error: rig.error }); return }
		try {
			sendJson(res, 200, permissionSnapshot(rig.session, rig.presets))
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	/**
	 * 写：切换这个会话的权限档位。
	 *
	 * 这条路走 guardWrite —— 也就是**必须提权**（PIN 门），和 cancel / prompt 一个待遇。
	 * 唯一的例外是"切到只读"：那是收紧，不是放开，手机重新登录一下也无所谓，
	 * 但它不需要额外的证明（用户想赶紧锁上时，多一道门只会拦着好人）。
	 */
	async function handleSetPermission(res, body, req) {
		const sessionId = String(body.sessionId ?? '')
		const preset = String(body.preset ?? '')
		if (sessionId === '' || preset === '') { sendJson(res, 400, { error: '需要 sessionId 与 preset' }); return }
		const rig = permissionRig(sessionId)
		if (rig.error !== undefined) { sendJson(res, 404, { error: rig.error }); return }
		try {
			rig.presets.set(rig.session, preset)
			const snapshot = permissionSnapshot(rig.session, rig.presets)
			record(`permission -> ${snapshot.current} for ${sessionId} <- ${clientIp(req)}`)
			sendJson(res, 200, snapshot)
		} catch (error) {
			sendJson(res, 400, { error: String(error?.message ?? error) })
		}
	}

	/**
	 * Account balance. Cached, and single-flight so two phones opening the tab
	 * at once still produce exactly one upstream call.
	 */
	/**
	 * 启动（或复用）一次上游余额查询。绝不阻塞调用方。
	 */
	function kickBalanceRefresh() {
		if (state.balance.inflight !== null) return state.balance.inflight
		const pending = (async () => {
			const key = await resolveApiKey(ctx)
			if (key.value === '') {
				return { ok: false, reason: 'missing-key', message: `没有找到 ${CRED_REF}，先在桌面端配置 API Key` }
			}
			const result = await queryBalance(key.value)
			return { ...result, keySource: key.source }
		})()
		state.balance.inflight = pending
		pending
			.then((value) => { state.balance.value = value; state.balance.at = Date.now() })
			.catch(() => {})
			.finally(() => { if (state.balance.inflight === pending) state.balance.inflight = null })
		return pending
	}

	async function handleBalance(res, force) {
		const now = Date.now()
		if (!force && state.balance.value !== null && now - state.balance.at < BALANCE_CACHE_MS) {
			sendJson(res, 200, { ...state.balance.value, cached: true, topUpUrl: TOP_UP_URL })
			return
		}
		// 有旧值就先给旧值，后台去刷新 —— 别让手机为一次余额查询干等 15 秒。
		// 上游慢的时候，挂着的请求会把浏览器对同一域名的并发连接占满，于是
		// 连对话都加载不出来（用户看到的就是"又慢又空白"）。
		// 只有显式 refresh=1（用户主动点刷新）或从来没有过值时，才让调用方等。
		if (!force && state.balance.value !== null) {
			kickBalanceRefresh()
			sendJson(res, 200, { ...state.balance.value, cached: true, stale: true, topUpUrl: TOP_UP_URL })
			return
		}
		let value
		try {
			value = await kickBalanceRefresh()
		} catch (error) {
			value = { ok: false, reason: 'internal', message: String(error?.message ?? error) }
		}
		sendJson(res, 200, { ...value, cached: false, topUpUrl: TOP_UP_URL })
	}

	async function handlePrompt(req, res) {
		let body
		try {
			// 这条路上的包最大：手机可能一次发来一段视频（base64 之后再大三分之一）。
			body = await readBody(req, MAX_BODY_BYTES * 4)
		} catch (error) {
			sendJson(res, 413, { error: `请求过大或格式错误: ${String(error?.message ?? error)}` })
			return
		}
		const sessionId = String(body.sessionId ?? '')
		if (sessionId === '') {
			sendJson(res, 400, { error: '缺少 sessionId' })
			return
		}
		const content = []
		const text = String(body.text ?? '').trim()
		if (text !== '') content.push({ type: 'text', text })

		const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES_PER_PROMPT) : []
		for (const image of images) {
			const mediaType = String(image?.mediaType ?? '')
			const data = String(image?.data ?? '')
			if (!IMAGE_TYPES.has(mediaType)) {
				sendJson(res, 400, { error: `不支持的图片类型: ${mediaType}` })
				return
			}
			if (data === '' || data.length > MAX_IMAGE_BASE64) {
				sendJson(res, 400, { error: '图片为空或过大' })
				return
			}
			content.push({
				type: 'image',
				mediaType,
				data,
				...(typeof image?.name === 'string' && image.name !== '' ? { name: image.name } : {}),
			})
		}

		// 图片以外的任何东西（视频、PDF、宿主不认的图片格式…）都落到磁盘上，
		// 把路径写进任务里 —— 模型本身"看"不了视频，但 agent 能用工具去处理它。
		const savedFiles = []
		// (a) 已经分片传完的：手机只发路径，请求体很小（大文件必须走这条）。
		//
		// ⚠️ 但**大图也走这条** —— 以前一律当"文件"下发（只给路径），于是模型根本看不到图，
		// 只能回一句"图片之外的内容我没法直接看，请用工具打开/处理"。用户看到的就是
		// "我发的图发不出去"（2026-10-09 现场：用户手机发的照片变成了一个文件路径）。
		// 现在：上传上来的**静态图**，只要宿主认这个类型、体积也过得去，就按**图片附件**下发，
		// 让模型直接看图；其余（视频/PDF/动图/超大图）仍然走路径那套。
		//
		// ⚠️ 另一个 2026-10-09 的坑：这里原来对**所有**附件都 `slice(0, MAX_FILES_PER_PROMPT)`
		// （3 个）—— 用户多选 5 张图会被**静默丢掉 2 张**（"我明明发了啊"）。图片按
		// MAX_IMAGES_PER_PROMPT 算，普通文件仍按 3 个算。
		const allRefs = Array.isArray(body.fileRefs) ? body.fileRefs : []
		const refs = []
		let imageRefs = 0
		let fileRefs = 0
		for (const entry of allRefs) {
			const mediaType = String(entry?.mediaType ?? '')
			const isImage = mediaType === 'image/png' || mediaType === 'image/jpeg'
			if (isImage) {
				if (imageRefs >= MAX_IMAGES_PER_PROMPT) continue
				imageRefs += 1
			} else {
				if (fileRefs >= MAX_FILES_PER_PROMPT) continue
				fileRefs += 1
			}
			refs.push(entry)
		}
		for (const entry of refs) {
			const path = safeUploadRef(entry?.path)
			if (path === null) { sendJson(res, 400, { error: '文件引用不在上传目录里，已拒绝' }); return }
			let info
			try {
				info = await stat(path)
			} catch {
				sendJson(res, 400, { error: `文件不存在（可能上传没完成）: ${path}` })
				return
			}
			const name = safeUploadName(String(entry?.name ?? 'file'))
			const mediaType = String(entry?.mediaType ?? '')
			// 动图（gif/webp）**不能**走内联图片：宿主解码多帧图会失败，视频同理。
			const still = mediaType === 'image/png' || mediaType === 'image/jpeg'
			const limit = Math.floor(MAX_IMAGE_BASE64 * 0.75)  // base64 之后约 4/3，留出 JSON 余量
			if (still && info.size > 0 && info.size <= limit) {
				try {
					const bytes = await readFile(path)
					content.push({ type: 'image', mediaType, data: bytes.toString('base64'), name })
					continue
				} catch { /* 读不出来就退回"当文件"，别把整条消息弄失败 */ }
			}
			/*
			 * 先判音频，再判视频 —— 顺序不能反。
			 *
			 * 网页里录的音是 **opus/webm**（体积只有系统录音的三分之一），文件后缀就是 `.webm`；
			 * 而 `.webm` 同时在 VIDEO_EXTENSIONS 里。只看扩展名的话，一段纯音频会被当成视频：
			 * 去抽帧（抽不到）、还会给模型一句"这是视频"的错话。所以**声明是 audio/* 就一律当音频**，
			 * 扩展名只用来兜底（有些上传不带 content-type）。
			 */
			const audioType = mediaType.startsWith('audio/') === true
				? mediaType
				: (AUDIO_EXTENSIONS[extname(name).toLowerCase()] ?? '')
			/*
			 * 视频：抽几帧当**图片**交给模型。
			 *
			 * 模型看不了视频，以前只能给一个路径让 agent 自己 ffmpeg —— 用户要的是
			 * "发的视频 agent 直接能看懂"（2026-10-09 要求）。这里抽 6 帧均匀分布，
			 * 每帧宽 768 的 JPEG；帧的秒数写进文字里，模型才知道先后顺序。
			 * 抽不动（没装 ffmpeg / 太长的录屏 / 解码失败）就照旧只给路径，不影响发送。
			 */
			const videoType = audioType !== ''
				? ''
				: (mediaType.startsWith('video/') === true
					? mediaType
					: (VIDEO_EXTENSIONS[extname(name).toLowerCase()] ?? ''))
			const asrKey = resolveAsrKey(state.config?.asrKey)
			const asrOptions = {
				key: asrKey,
				baseUrl: state.config?.asrBaseUrl,
				model: state.config?.asrModel,
				maxMinutes: state.config?.asrMaxMinutes,
				ffmpegPath: resolveMediaBinary('ffmpeg', state.config?.ffmpegPath ?? process.env.DSH_BRIDGE_FFMPEG),
				ffprobePath: resolveMediaBinary('ffprobe', state.config?.ffprobePath ?? process.env.DSH_BRIDGE_FFPROBE),
			}
			if (videoType !== '' && info.size > 0 && info.size <= MAX_UPLOAD_BYTES) {
				try {
					const frames = await extractVideoFrames(path, {
						// ⚠️ 这里必须走 `state.config`：`config` 是在 start() 里才绑定的
						// （`const { config } = await loadConfig()`），handlePrompt 定义在它之前，
						// 直接写 `config.ffmpegPath` 会抛 ReferenceError —— 被下面的 catch 吞掉，
						// 表现就是"视频一帧都没抽出来"，而且日志里只有一句 failed（harness 抓到的）。
						ffmpegPath: asrOptions.ffmpegPath,
						ffprobePath: asrOptions.ffprobePath,
					})
					if (frames.length > 0) {
						for (const [index, frame] of frames.entries()) {
							content.push({
								type: 'image',
								mediaType: 'image/jpeg',
								data: frame.base64,
								name: `${name} 第 ${index + 1} 帧（${frame.seconds.toFixed(1)} 秒）`,
							})
						}
						record(`video frames: ${frames.length} from ${name}`)
					}
					// 视频里的**声音**也转成文字：光看图会漏掉"讲了什么"。
					if (asrKey !== '') {
						const said = await transcribeMedia(path, asrOptions)
						if (said !== null && said.skipped === undefined && said.text !== '') {
							content.push({
								type: 'text',
								text: `【视频语音转写】${name}（约 ${Math.round(said.seconds)} 秒，${said.segments} 段，`
									+ `转写约 ${ASR_YUAN_PER_MINUTE} 元/分钟 ≈ ${(said.seconds / 60 * ASR_YUAN_PER_MINUTE).toFixed(2)} 元）：\n${said.text}`,
							})
							// 日志里带一小段预览：转写是不是乱码/空转，看日志就能判（不然只能靠猜）。
							record(`asr(video): ${said.text.length} chars from ${name}: ${said.text.slice(0, 40).replace(/\s+/g, ' ')}`)
						}
					}
					content.push({
						type: 'text',
						text: `（${name} 是视频：上面是自动抽的帧${frames.length > 0 ? '' : '（这次没抽出来）'}`
							+ `，按时间顺序；要看细节可以让我用 ffmpeg 处理这个文件。）`,
					})
				} catch (error) {
					record(`video frames failed for ${name}: ${String(error?.message ?? error)}`)
				}
			}
			/*
			 * 音频：转成文字交给模型。
			 *
			 * 手机上的语音备忘录/录音（.m4a/.caf/.mp3…）模型同样读不了，以前只能给路径。
			 * 现在直接转写（智谱 GLM-ASR，0.06 元/分钟）：用户"发一段语音让它干活"就成立了。
			 * 网页里现录的那段（opus/webm）走的也是这里 —— 客户端保证带上 `audio/webm`，
			 * 上面判类型时音频优先，所以不会被当视频。没有 key / 没装 ffmpeg / 太长 →
			 * 退回"只给路径"，绝不让发消息失败。
			 */
			if (audioType !== '' && info.size > 0) {
				try {
					const said = await transcribeMedia(path, asrOptions)
					if (said !== null && said.skipped === 'too-long') {
						const minutes = Math.round(said.seconds / 60)
						content.push({
							type: 'text',
							text: `（${name} 有 ${minutes} 分钟，超过自动转写的上限`
								+ ` ${state.config?.asrMaxMinutes ?? ASR_MAX_MINUTES} 分钟，没转。`
								+ `要转的话：把 ~/.dsh/mobile-bridge.json 的 asrMaxMinutes 调大（转写约 ${ASR_YUAN_PER_MINUTE} 元/分钟，`
								+ `这段约 ${(minutes * ASR_YUAN_PER_MINUTE).toFixed(1)} 元），或者让我用工具分段处理。）`,
						})
					} else if (said !== null && said.text !== '') {
						const minutes = said.seconds / 60
						content.push({
							type: 'text',
							text: `【语音转写】${name}（约 ${Math.round(said.seconds / 60 * 10) / 10} 分钟，${said.segments} 段，`
								+ `转写约 ${ASR_YUAN_PER_MINUTE} 元/分钟 ≈ ${(minutes * ASR_YUAN_PER_MINUTE).toFixed(2)} 元）：\n${said.text}`,
						})
						record(`asr(audio): ${said.text.length} chars from ${name}: ${said.text.slice(0, 40).replace(/\s+/g, ' ')}`)
					} else if (asrKey === '') {
						content.push({ type: 'text', text: `（${name} 是音频；电脑上没配语音转写的 key，这里只给路径。）` })
					} else {
						/*
						 * key 有、但转写没成。**必须说清为什么**（2026-10-09 修）：
						 * 以前这里是**静默**的 —— 用户对着手机说了一段话，模型只看到"这是一个文件"，
						 * 谁都不知道音频压根没转。现场就是本机 `~/.dsh/bin/ffmpeg.exe` 明明在，
						 * 但探测失败被永久缓存成"没有"。
						 */
						const tools = await mediaToolsAvailable(asrOptions.ffmpegPath)
						content.push({
							type: 'text',
							text: tools === true
								? `（${name} 是音频，这次转写没成功（多半是接口/网络问题）；文件就在电脑上，可以让我再试一次。）`
								: `（${name} 是音频，但**这台电脑没找到 ffmpeg**，所以没转成文字。`
									+ `放一个 ffmpeg.exe 到 ~/.dsh/bin/（或 winget install Gyan.FFmpeg）之后重发一次就能自动转。）`,
						})
						record(`asr(audio) skipped for ${name}: ffmpeg=${tools === true ? 'ok' : 'missing'}`)
					}
				} catch (error) {
					record(`asr failed for ${name}: ${String(error?.message ?? error)}`)
				}
			}
			savedFiles.push({ name, mediaType, path })
		}
		// (b) 小文件仍然可以随任务一起带过来（一次请求搞定，少一次往返）。
		const incoming = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES_PER_PROMPT) : []
		for (const entry of incoming) {
			const name = safeUploadName(String(entry?.name ?? 'file'))
			const data = String(entry?.data ?? '')
			if (data === '') { sendJson(res, 400, { error: `文件为空: ${name}` }); return }
			if (data.length > MAX_FILE_BASE64) {
				sendJson(res, 413, { error: `${name} 太大，请用分片上传（手机上会自动走这条路）` })
				return
			}
			try {
				const saved = await saveUpload({ name, mediaType: String(entry?.mediaType ?? ''), data })
				savedFiles.push(saved)
			} catch (error) {
				sendJson(res, 500, { error: `保存 ${name} 失败: ${String(error?.message ?? error)}` })
				return
			}
		}
		const fileNote = describeSavedFiles(savedFiles)
		if (fileNote !== '') content.push({ type: 'text', text: fileNote })

		if (content.length === 0) {
			sendJson(res, 400, { error: '内容为空' })
			return
		}

		try {
			// requestId 要回给手机：DSH 会把同一份 rpcId 放进 `agent/inbox/spliced`
			// 事件，手机靠它对上"我刚发的那句" —— 于是能显示"排队中"并给出撤回按钮。
			//
			// 手机可以自己带一个 id（重试时复用同一个）：DSH 对同一个 requestId 是
			// **幂等**的（`hasPromptRequest` 直接返回 accepted），所以"网络抖一下自动重试"
			// 不会变成两条消息。
			const supplied = String(body.requestId ?? '')
			const requestId = /^[A-Za-z0-9-]{8,64}$/.test(supplied) ? supplied : randomUUID()
			const accepted = await ctx.sessionController.prompt(
				{
					requestId,
					sessionId,
					mode: 'queue',
					content,
					clientTimeZone: 'Asia/Shanghai',
				},
				AbortSignal.timeout(30000),
			)
			log(`prompt accepted for ${sessionId} (${images.length} image(s), ${savedFiles.length} file(s), ${text.length} char(s))`)
			sendJson(res, 200, {
				accepted: accepted.accepted === true,
				requestId,
				files: savedFiles.map((entry) => entry.name),
			})
			return
		} catch (error) {
			const message = String(error?.message ?? error)
			record(`prompt rejected for ${sessionId}: ${message}`)

			// 图片这条路被宿主拒了（最常见的元凶是**动图**：宿主解码多帧图会失败）。
			// 别让用户干瞪眼：把图也存成文件、用路径再发一次，任务照样能下去。
			if (images.length > 0 && !isUnfollowable(message)) {
				try {
					const rescued = []
					for (const image of images) {
						const name = safeUploadName(String(image?.name ?? `image-${rescued.length + 1}`))
						rescued.push(await saveUpload({ name, mediaType: String(image?.mediaType ?? ''), data: String(image?.data ?? '') }))
					}
					const retryContent = content.filter((entry) => entry.type !== 'image')
					const note = describeSavedFiles(rescued)
					if (note !== '') retryContent.push({ type: 'text', text: note })
					const retryId = randomUUID()
					const accepted = await ctx.sessionController.prompt(
						{
							requestId: retryId,
							sessionId,
							mode: 'queue',
							content: retryContent,
							clientTimeZone: 'Asia/Shanghai',
						},
						AbortSignal.timeout(30000),
					)
					record(`prompt retried as files for ${sessionId} (${rescued.length} saved)`)
					sendJson(res, 200, {
						accepted: accepted.accepted === true,
						requestId: retryId,
						files: rescued.map((entry) => entry.name),
						degraded: true,
					})
					return
				} catch (retryError) {
					record(`prompt retry failed for ${sessionId}: ${String(retryError?.message ?? retryError)}`)
				}
			}

			// 子会话（agent 自己派生的）也收不了手机发来的消息，处理方式和"跟随失败"一致：
			// 标记 + 从列表里拿掉，页面就能说"这个会话在手机上打不开"，而不是干巴巴一句失败。
			const unsupported = isUnfollowable(message)
			if (unsupported) state.unfollowable.add(sessionId)
			sendJson(res, unsupported ? 409 : 500, unsupported
				? { error: message, unsupported: true }
				: { error: message })
		}
	}

	/**
	 * 分片上传：手机把大文件切成小片，一片一个请求。
	 *
	 * 不这么做就发不了大文件 —— 隧道入口会掐断"慢而大"的请求（实测 IPv6 入口
	 * 16 MB 回 408、6.7 MB 要 89 秒），手机上行更慢，一整块必死。每片 384 KB，
	 * 单次请求 ~512 KB，慢链路也就几秒。
	 *
	 * ⚠️ 2026-10-09「传图太慢，要能多张一起发」：以前这里 `appendFile` 按**到达顺序**追加，
	 * 于是手机只能一片一片串行发（乱序到达会把文件拼错，而且是**静默**拼错）。现在支持
	 * **按偏移写**（`chunkBytes` + `size`），片与片之间就没有先后要求了 —— 手机可以并发发 3~4 片，
	 * 传图快一截。为了兼容手机上可能缓存的旧页面：不带 `size`/`chunkBytes` 时仍走原来的顺序追加。
	 *
	 * 安全：只在 ~/.dsh/mobile-uploads/ 下写；片名由服务端生成（uploadId 只许
	 * [A-Za-z0-9_-]），文件名照旧过 safeUploadName，`..` 没有落脚点。
	 */
	/**
	 * 每个分片上传"已收到哪些片"（uploadId → { total, size, got:Set, at }）。
	 *
	 * 并发乱序下不能只看文件长度判断收齐：高位片先到会把文件撑到目标长度，中间其实还是零。
	 * 这份状态在内存里（重启就没了）—— 手机端的重试会重新走一遍，不会有坏账。
	 */
	const uploadProgress = new Map()

	/**
	 * 清理**没拼完的分片残局**（`.part-*`）。
	 *
	 * 为什么需要：手机上行不稳时，"传了第 0 片就断了"的残片会留在上传目录里越攒越多
	 * （2026-10-09 实测：一次会话留下 7 个，每个正好 384 KB = 一片）。它们永远不会被
	 * 收尾改名，也就不可能被引用 —— 纯垃圾，删掉是安全的。
	 */
	async function sweepStaleParts(maxAgeMs = 60 * 60 * 1000) {
		try {
			const dir = uploadsDir()
			const entries = await readdir(dir)
			const cutoff = Date.now() - maxAgeMs
			let removed = 0
			for (const name of entries) {
				if (name.startsWith('.part-') === false) continue
				const path = join(dir, name)
				try {
					const info = await stat(path)
					if (info.mtimeMs > cutoff) continue
					await unlink(path)
					removed += 1
				} catch { /* 别人正在写/刚被删掉：跳过 */ }
			}
			if (removed > 0) record(`swept ${removed} stale upload part(s)`)
		} catch { /* 目录不存在等等，无所谓 */ }
	}

	/** 4.11.0：原样读请求体（**二进制安全** ✓）—— `readBody` 是「读完就按 JSON 解析」✗，二进制片不能用它 ✓。 */
	async function readRawBody(req, limit) {
		const chunks = []
		let size = 0
		for await (const chunk of req) {
			size += chunk.length
			if (size > limit) throw new Error('payload too large')
			chunks.push(chunk)
		}
		return Buffer.concat(chunks)
	}

	/**
	 * 🔴 4.11.0：**按偏移写入一片 + 收齐时改名交回路径** ✓。
	 *
	 * 这段是从 `handleUpload` 里**原样搬出来**的 ✓（一行逻辑都没改 ✗）——
	 * 因为新的**二进制分片**和原来的 JSON 分片必须**共用同一份** ✓：
	 * 那份"用**片号集合**判收齐（而不是看文件长度 ✓）"的仔细逻辑 ✓，
	 * 只该有一处 ✓ —— 复制粘贴出去迟早会分叉 ✗（本项目在这类"两份实现"上栽过 ✓）。
	 */
	async function writePositionedChunk({ uploadId, index, total, size, chunkBytes, name, mediaType, bytes, res }) {
		const offset = index * chunkBytes
		const expected = index === total - 1 ? size - offset : chunkBytes
		if (offset < 0 || offset >= size || expected <= 0 || bytes.length !== expected) {
			sendJson(res, 400, { error: `chunk 尺寸不符（第 ${index} 片应为 ${expected} 字节，收到 ${bytes.length}）` })
			return
		}
		const dir = uploadsDir()
		await mkdir(dir, { recursive: true })
		const partFile = join(dir, `.part-${uploadId}`)
		try {
			// 所有片一律**定位写**（连第 0 片也是）：并发下第 0 片完全可能最后才到，
			// 那种时候若还用 writeFile 就会把已经写好的片**截断**掉。
			let handle = null
			try {
				handle = await open(partFile, 'r+')
			} catch {
				// 文件还不存在（这一片先到了）：按偏移补零建出来，位置就都是对的。
				await writeFile(partFile, Buffer.alloc(offset))
				handle = await open(partFile, 'r+')
			}
			try {
				await handle.write(bytes, 0, bytes.length, offset)
			} finally {
				await handle.close()
			}
		} catch (error) {
			sendJson(res, 500, { error: `写入失败: ${String(error?.message ?? error)}` })
			return
		}
		const written = (await stat(partFile)).size
		/*
		 * 收齐的判断**不能只看文件长度**：乱序 + 补零建文件的组合下，高位的片先到就能把
		 * 文件"撑"到 size，而中间/开头其实还是零 —— 那样就会把一个**前面全是零**的文件收尾
		 * 交出去（harness 里真踩到：首字节是 NUL）。所以按**已收到的片号集合**判断。
		 */
		let progress = uploadProgress.get(uploadId)
		if (progress === undefined || progress.total !== total || progress.size !== size) {
			progress = { total, size, got: new Set(), at: Date.now() }
			uploadProgress.set(uploadId, progress)
		}
		progress.got.add(index)
		progress.at = Date.now()
		// 顺手清理超时的残局（手机中途放弃的上传），别让这张表无限长。
		if (uploadProgress.size > 64) {
			const cutoff = Date.now() - 15 * 60 * 1000
			for (const [key, value] of uploadProgress) {
				if (value.at < cutoff) uploadProgress.delete(key)
			}
		}
		if (progress.got.size < total || written < size) {
			sendJson(res, 200, { ok: true, received: progress.got.size, total, bytes: written, partial: true })
			return
		}
		uploadProgress.delete(uploadId)
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
		const target = join(dir, `${stamp}-${randomBytes(2).toString('hex')}-${name}`)
		try {
			await rename(partFile, target)
		} catch (error) {
			sendJson(res, 500, { error: `收尾失败: ${String(error?.message ?? error)}` })
			return
		}
		record(`upload saved: ${target} (${written} bytes, ${total} chunks, 二进制分片)`)
		sendJson(res, 200, { ok: true, done: true, name, mediaType, path: target, bytes: written })
	}

	/**
	 * 🔴 4.11.0：**二进制分片**（`application/octet-stream` ✓）—— 手机那边把 `file.slice(a,b)`
	 * **直接当请求体**发 ✓，浏览器自己从磁盘流式读 ✓ → **不进内存、也不再多花 33% 流量** ✓。
	 *
	 * ⚠️ 元数据走**请求头** ✓（不塞进 query ✗ —— 文件名是用户的东西 ✓，别让它进访问日志 ✓）。
	 * ⚠️ 与 JSON 分片**完全向后兼容** ✓：老页面照旧发 JSON ✓，这条路只是**多一种收法** ✓，
	 *    所以可以先上线不破坏任何东西 ✓✓（今天定的顺序 ✓）。
	 */
	async function handleUploadBinary(req, res) {
		const head = (name) => String(req.headers[name] ?? '').trim()
		const uploadId = head('x-upload-id')
		const name = safeUploadName(head('x-upload-name') || 'file')
		const mediaType = head('x-upload-type')
		const index = Number(head('x-upload-index'))
		const total = Number(head('x-upload-total'))
		const size = Number(head('x-upload-size'))
		const chunkBytes = Number(head('x-upload-chunk-bytes'))
		if (/^[A-Za-z0-9_-]{1,40}$/.test(uploadId) === false) { sendJson(res, 400, { error: 'bad uploadId' }); return }
		if (Number.isSafeInteger(index) === false || Number.isSafeInteger(total) === false) { sendJson(res, 400, { error: 'bad index' }); return }
		if (total < 1 || total > MAX_UPLOAD_CHUNKS || index < 0 || index >= total) { sendJson(res, 400, { error: 'bad range' }); return }
		const positioned = Number.isSafeInteger(size) && size > 0 && size <= MAX_UPLOAD_BYTES
			&& Number.isSafeInteger(chunkBytes) && chunkBytes >= 64 * 1024 && chunkBytes <= 4 * 1024 * 1024
		if (positioned === false) { sendJson(res, 400, { error: 'bad size/chunkBytes' }); return }
		let bytes
		try {
			// 上限给一点余量 ✓（判断本身在 `writePositionedChunk` 里做 ✓，这里只防"超大 body 打死进程"✗）。
			bytes = await readRawBody(req, chunkBytes + 1024)
		} catch {
			sendJson(res, 413, { error: 'chunk too large' })
			return
		}
		if (bytes.length === 0) { sendJson(res, 400, { error: 'empty chunk' }); return }
		await writePositionedChunk({ uploadId, index, total, size, chunkBytes, name, mediaType, bytes, res })
	}

	async function handleUpload(req, res) {
		/*
		 * 🔴 4.11.0：**先分流二进制** ✓ —— 必须在 `readBody` **之前** ✓，
		 * 因为它是"读完就按 JSON 解析"✗，拿它读二进制片会当场炸 ✓。
		 */
		if (String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) {
			await handleUploadBinary(req, res)
			return
		}
		let body
		try {
			body = await readBody(req, 2 * 1024 * 1024)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const uploadId = String(body.uploadId ?? '')
		const index = Number(body.index)
		const total = Number(body.total)
		const name = safeUploadName(String(body.name ?? 'file'))
		const data = String(body.data ?? '')
		if (/^[A-Za-z0-9_-]{1,40}$/.test(uploadId) === false) { sendJson(res, 400, { error: 'bad uploadId' }); return }
		if (Number.isSafeInteger(index) === false || Number.isSafeInteger(total) === false) { sendJson(res, 400, { error: 'bad index' }); return }
		if (total < 1 || total > MAX_UPLOAD_CHUNKS || index < 0 || index >= total) { sendJson(res, 400, { error: 'bad range' }); return }
		if (data === '') { sendJson(res, 400, { error: 'empty chunk' }); return }
		const bytes = Buffer.from(data, 'base64')

		// 新协议（可乱序）：手机报上"总字节数 + 每片字节数"，服务端按偏移写、按总长判断收完。
		const size = Number(body.size)
		const chunkBytes = Number(body.chunkBytes)
		const positioned = Number.isSafeInteger(size) && size > 0 && size <= MAX_UPLOAD_BYTES
			&& Number.isSafeInteger(chunkBytes) && chunkBytes >= 64 * 1024 && chunkBytes <= 4 * 1024 * 1024
		if (positioned) {
			// 4.11.0：这段**搬进了 `writePositionedChunk`** ✓ —— 二进制分片走的是**同一份** ✓。
			await writePositionedChunk({
				uploadId, index, total, size, chunkBytes, name,
				mediaType: String(body.mediaType ?? ''), bytes, res,
			})
			return
		}

		// 旧协议（顺序追加）：手机上缓存的老页面还在用，别把它发过来的东西拼坏。
		if (bytes.length > UPLOAD_CHUNK_BYTES + 1024) { sendJson(res, 413, { error: 'chunk too large' }); return }

		const dir = uploadsDir()
		await mkdir(dir, { recursive: true })
		const partFile = join(dir, `.part-${uploadId}`)
		try {
			if (index === 0) await writeFile(partFile, bytes)
			else await appendFile(partFile, bytes)
		} catch (error) {
			sendJson(res, 500, { error: `写入失败: ${String(error?.message ?? error)}` })
			return
		}
		const written = (await stat(partFile)).size
		if (written > MAX_UPLOAD_BYTES) {
			await unlink(partFile).catch(() => {})
			sendJson(res, 413, { error: `文件太大（上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB）` })
			return
		}
		if (index < total - 1) {
			sendJson(res, 200, { ok: true, received: index + 1, total, bytes: written })
			return
		}
		// 最后一片：改名成正式文件，把路径交回手机（它随后放进 fileRefs）。
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
		const target = join(dir, `${stamp}-${randomBytes(2).toString('hex')}-${name}`)
		try {
			await rename(partFile, target)
		} catch (error) {
			sendJson(res, 500, { error: `收尾失败: ${String(error?.message ?? error)}` })
			return
		}
		record(`upload saved: ${target} (${written} bytes, ${total} chunks)`)
		sendJson(res, 200, { ok: true, done: true, name, mediaType: String(body.mediaType ?? ''), path: target, bytes: written })
	}

	/**
	 * 手机界面的背景：用户挑的那段视频/图片，从上传目录里原样发出去。
	 *
	 * 必须支持 Range —— iOS Safari 放视频会先发一个 `Range: bytes=0-1` 试探，
	 * 只回 200 的话它可能直接不播。ETag 用文件的 mtime+size，手机第二次打开就走
	 * 304，不用把几 MB 再下一遍（移动网络下这很值钱）。
	 */
	/**
	 * 换手机界面的背景（也能清掉）。`name` 只能是上传目录里的文件名。
	 *
	 * 为什么要这个接口：以前换背景得「把文件发进某个会话 → 让 agent 把文件名写进
	 * `~/.dsh/mobile-bridge.json` 的 `backgroundFile` → 重载插件」——那是我干的活，
	 * 不是用户干的活。现在手机自己选一张图 / 动图 / 视频就能换。
	 *
	 * 只改 `backgroundFile` **这一个键**：同一个文件里还有 publicUrl（隧道脚本每次
	 * 重启都会改写它）、crashProbe 等别人管的字段，整份按内存重写会把它们覆盖回旧值。
	 */
	async function saveBackgroundName(name) {
		const file = join(dshHome(), CONFIG_FILE)
		let stored = {}
		try {
			stored = JSON.parse(await readFile(file, 'utf8'))
		} catch {
			stored = {}
		}
		if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) stored = {}
		if (name === '') delete stored.backgroundFile
		else {
			stored.backgroundFile = name
			// 4.7.0：文件和预设**二选一** ✓（同时设两个等于两套背景打架 ✗）。
			delete stored.backgroundPreset
			delete state.config.backgroundPreset
		}
		await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
		if (name === '') delete state.config.backgroundFile
		else state.config.backgroundFile = name
	}

	/**
	 * 4.7.0：设 / 清**自带背景预设** ✓（目前只有 `cyberpunk` ✓ —— CSS 画的赛博朋克 ✓）。
	 * 同样**只改这一个键** ✓ + 和 `backgroundFile` 二选一 ✓（先备份在案见 CHANGELOG ✓）。
	 */
	async function saveBackgroundPreset(preset) {
		const file = join(dshHome(), CONFIG_FILE)
		let stored = {}
		try {
			stored = JSON.parse(await readFile(file, 'utf8'))
		} catch {
			stored = {}
		}
		if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) stored = {}
		if (preset === '') {
			delete stored.backgroundPreset
			// 4.8.0：预设没了，「动 / 静」这个键也没意义了 ✓ —— 一起清掉 ✓（不留等默认值的僵尸键 ✓）。
			delete stored.backgroundMotion
			delete state.config.backgroundPreset
			delete state.config.backgroundMotion
		} else {
			stored.backgroundPreset = preset
			// 二选一 ✓：设预设就把图片背景摘掉 ✓（不然页面不知道该铺哪个 ✗）。
			delete stored.backgroundFile
			delete state.config.backgroundFile
			state.config.backgroundPreset = preset
		}
		await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
	}

	/**
	 * 4.8.0：自带预设**动 / 静** ✓（用户 2026-10-15：「最好是动态的背景」✓）。
	 * 缺省是动 ✓ —— 只有明确写 `false` 才存 ✓（存 `true` 反而要把键删掉 ✓，
	 * 这样配置里不会留一堆"等于默认值"的键 ✓）。
	 */
	async function saveBackgroundMotion(motion) {
		const file = join(dshHome(), CONFIG_FILE)
		let stored = {}
		try {
			stored = JSON.parse(await readFile(file, 'utf8'))
		} catch {
			stored = {}
		}
		if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) stored = {}
		if (motion === false) stored.backgroundMotion = false
		else delete stored.backgroundMotion
		await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
		state.config.backgroundMotion = motion !== false
	}

	async function handleSetBackground(req, res) {
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		if (body?.clear === true) {
			await saveBackgroundName('')
			await saveBackgroundPreset('')
			sendJson(res, 200, { ok: true, background: null })
			return
		}
		/*
		 * 4.7.0：设**自带预设**（赛博朋克 ✓）—— 只认白名单 ✓，写别的回 400 并把能用的列出来 ✓
		 *（照 `/api/record` 那套"绝不落到默认动作"的纪律 ✓）。
		 */
		if (typeof body?.preset === 'string') {
			const preset = body.preset.trim()
			if (preset !== '' && BACKGROUND_PRESETS.includes(preset) === false) {
				sendJson(res, 400, { error: '不认识的背景预设：' + preset, presets: BACKGROUND_PRESETS })
				return
			}
			await saveBackgroundPreset(preset)
			sendJson(res, 200, { ok: true, background: backgroundInfo() })
			return
		}
		/*
		 * 4.8.0：**动 / 静** ✓（只对自带预设生效 ✓ —— 图片背景静态、视频背景本来就会动 ✓，
		 * 这个开关管不着它们 ✗，所以没设预设时直接说清 ✓，不静默什么都不做 ✗）。
		 */
		if (typeof body?.motion === 'boolean') {
			if (BACKGROUND_PRESETS.includes(String(state.config?.backgroundPreset ?? '')) === false) {
				sendJson(res, 400, { error: '「动 / 静」只对自带背景（赛博朋克）有效 —— 先换上它，或者这是图片 / 视频背景' })
				return
			}
			await saveBackgroundMotion(body.motion)
			sendJson(res, 200, { ok: true, background: backgroundInfo() })
			return
		}
		// ⚠️ 手机上传完之后手上有两样东西：`name` 是**手机上的原始文件名**，
		// `path` 是服务端存盘后的真实路径（文件名带了时间戳+随机前缀）。
		// 只认 `name` 就会去找一个根本不存在的文件 → "这个文件不在了，重新上传一次"。
		// （同学报的"换背景失效"就是这个。）两个都收，但一律走目录校验。
		const fromPath = String(body?.path ?? '')
		const path = safeUploadRef(fromPath !== '' ? fromPath : join(uploadsDir(), String(body?.name ?? '')))
		if (path === null) { sendJson(res, 400, { error: '背景只能从上传目录里挑' }); return }
		let info
		try {
			info = await stat(path)
		} catch {
			sendJson(res, 404, { error: '这个文件不在了，重新上传一次' })
			return
		}
		if (info.size === 0) { sendJson(res, 400, { error: '文件是空的' }); return }
		const mediaType = mediaTypeOf(path)
		if (mediaType.startsWith('image/') === false && mediaType.startsWith('video/') === false) {
			sendJson(res, 400, {
				error: `背景只能是图片 / 动图 / 视频，这个是 ${mediaType === '' ? '未知类型' : mediaType}`,
			})
			return
		}
		// 配置里记的是**磁盘上的文件名**（backgroundInfo 就是拿它 join 上传目录的）。
		await saveBackgroundName(path.split(sep).pop() ?? 'background')
		sendJson(res, 200, { ok: true, background: backgroundInfo() })
	}

	async function handleBackground(req, res) {
		/*
		 * 4.9.2：`?still=1` → 送**静止兜底**那张图 ✓（用户：「一刷新动图就不见了」「每次都要好久」✓）。
		 * 手机先铺它（144KB 级 ✓ 秒出 ✓），视频能播再换上 ✓；视频挂了它就是最后一道保险 ✓。
		 */
		const query = String(req.url ?? '').split('?')[1] ?? ''
		const wantStill = /(^|&)still=1(&|$)/.test(query)
		/*
		 * 🔴 4.10.0：`?preset=<名字>` → 从**归档目录**取素材 ✓（"夜行星"这种自带素材的风格 ✓）。
		 * ⚠️ 文件名一律来自**我们自己写的 `preset.json`** ✓，再用 `safeUploadName` 洗一遍 ✓ ——
		 * 不拿 URL 里的字串去拼路径 ✗（那才是目录穿越的口子 ✗）。
		 */
		const wantPreset = decodeURIComponent(/(^|&)preset=([^&]+)/.exec(query)?.[2] ?? '')
		const meta = wantPreset === '' ? null : readPresetMeta(wantPreset)
		const fromConfig = wantStill
			? (typeof state.config?.backgroundStill === 'string' ? state.config.backgroundStill : '')
			: (typeof state.config?.backgroundFile === 'string' ? state.config.backgroundFile : '')
		const name = meta === null ? fromConfig : safeUploadName(String((wantStill ? meta.still : meta.file) ?? ''))
		if (name === '') { sendJson(res, 404, { error: 'no background' }); return }
		const path = meta === null ? safeUploadRef(join(uploadsDir(), name)) : join(presetDir(wantPreset), name)
		if (path === null) { sendJson(res, 404, { error: 'no background' }); return }
		let info
		try {
			info = await stat(path)
		} catch {
			sendJson(res, 404, { error: 'no background' }); return
		}
		const mediaType = mediaTypeOf(path) || 'application/octet-stream'
		const etag = `"bg-${info.size}-${Math.round(info.mtimeMs)}"`
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304, { ...SECURITY_HEADERS, etag })
			res.end()
			return
		}
		const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
		if (range !== null) {
			const start = range[1] === '' ? Math.max(0, info.size - Number(range[2] ?? 0)) : Number(range[1])
			const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
			if (Number.isFinite(start) === false || Number.isFinite(end) === false || start > end || start >= info.size) {
				res.writeHead(416, { ...SECURITY_HEADERS, 'content-range': `bytes */${info.size}` })
				res.end()
				return
			}
			res.writeHead(206, {
				...SECURITY_HEADERS,
				'content-type': mediaType,
				'content-length': end - start + 1,
				'content-range': `bytes ${start}-${end}/${info.size}`,
				'accept-ranges': 'bytes',
				etag,
				'cache-control': 'private, max-age=3600',
			})
			createReadStream(path, { start, end }).pipe(res)
			return
		}
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': mediaType,
			'content-length': info.size,
			'accept-ranges': 'bytes',
			etag,
			'cache-control': 'private, max-age=3600',
		})
		createReadStream(path).pipe(res)
	}

	/**
	 * 撤回一条还没开始处理的排队消息（手机上的「撤回」按钮）。
	 *
	 * DSH 的 `updateQueue` 支持 `{kind:'remove'}`：只要那条还在队列里就真能拿掉。
	 * 已经开始跑了就撤不回来 —— 这时候如实说清楚（409），别假装成功。
	 */
	async function handleRecall(req, res) {
		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		const sessionId = String(body.sessionId ?? '')
		const itemId = String(body.itemId ?? '')
		if (sessionId === '' || itemId === '') { sendJson(res, 400, { error: '缺少 sessionId 或 itemId' }); return }
		try {
			await ctx.sessionController.updateQueue(
				{ sessionId, itemId, action: { kind: 'remove' } },
				AbortSignal.timeout(15000),
			)
			record(`queue item ${itemId} removed from ${sessionId}`)
			sendJson(res, 200, { ok: true })
		} catch (error) {
			const message = String(error?.message ?? error)
			record(`queue remove failed for ${sessionId}/${itemId}: ${message}`)
			const gone = /queue-item-not-found|not found|no longer pending/i.test(message)
			sendJson(res, gone ? 409 : 500, {
				error: gone ? '这条已经开始处理了，撤不回来了' : message,
			})
		}
	}

	/** 手机的"说明页看过了"记到服务端（按**设备**），换地址/无痕也不会重复弹。 */
	async function handleWelcomeSeen(req, res) {
		const key = deviceId(req, res)
		if (key !== '') {
			// 存**版本号**（不是时间戳）：说明内容改版后能按版本再讲一遍。
			state.welcomed.set(key, WELCOME_VERSION)
			persistTokens()
		}
		sendJson(res, 200, { ok: true })
	}

	/* ------------------------------------------- 装成 App（PWA）要的那几样东西 */

	/**
	 * 「添加到主屏幕」用的一套：manifest + 图标 + service worker。
	 *
	 * iPhone 上装不了原生 App（要 Mac + 开发者账号，而且 App Store 上架），但
	 * **PWA 不需要商店**：Safari 里「分享 → 添加到主屏幕」之后，图标、全屏、启动
	 * 图、离线可用全都有，用起来和 App 没差别。这也正是用户能拿到的最接近"装个 App"
	 * 的办法。图标是 tools/make-icons.mjs 生成的真 PNG（iOS 不认 SVG 图标）。
	 */
	const ICON_FILES = new Set(['icon-180.png', 'icon-192.png', 'icon-512.png'])

	function handleManifest(res) {
		const body = JSON.stringify({
			name: 'DSH 手机桥',
			short_name: '手机桥',
			description: '在手机上驱动你电脑上的 DeepSeek Harness：发图/发视频、下任务、看实时进度、存素材。',
			start_url: './',
			scope: './',
			display: 'standalone',
			orientation: 'portrait',
			background_color: '#0b1220',
			theme_color: '#0b1220',
			icons: [
				{ src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
				{ src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
			],
		}, null, '\t')
		const buffer = Buffer.from(body, 'utf8')
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': 'application/manifest+json; charset=utf-8',
			'content-length': buffer.length,
			'cache-control': 'private, max-age=600',
		})
		res.end(buffer)
	}

	function handleIcon(req, res, url) {
		const name = url.pathname.split('/').pop() ?? ''
		if (ICON_FILES.has(name) === false) { sendJson(res, 404, { error: 'no such icon' }); return }
		let bytes
		try {
			bytes = readFileSync(join(HERE, 'icons', name))
		} catch {
			sendJson(res, 404, { error: 'icon missing' }); return
		}
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': 'image/png',
			'content-length': bytes.length,
			'cache-control': 'private, max-age=86400',
		})
		res.end(bytes)
	}

	/**
	 * Service worker：只为一件事 —— 让"从主屏幕点开"这一步**不用等网络**。
	 * 页面本身走 network-first（page tag 靠它自重载，绝不能吃旧缓存），
	 * 图标走 cache-first；`/api/*` 一律不碰（那是实时数据）。断网时给一张缓存的壳。
	 *
	 * 🔴🔴 4.10.2：**壳缓存名必须跟着插件版本走** ✓（用户 2026-10-15：「刷新后对话框没变回去」✓）。
	 * 老代码写死 `dshm-shell-v3` ✗ —— 它**永远不变** ✓ → 一旦导航请求落到缓存（弱网/隧道抖一下 ✓），
	 * 手机拿到的是**旧页面** ✓✓ → **这一整天所有页面侧修复都到不了手机** ✗
	 *（用户看到的就是"改了没反应/回到老样子"✓）。
	 * 现在名字里带**当前版本** ✓ → 新版本发布 → SW 的 `install` 换新壳 ✓、
	 * `activate` 里那句 `caches.delete` **顺手把旧壳删掉** ✓（那行本来就在 ✓，只是名字没变所以永远删不到东西 ✗）。
	 * ⚠️ 只动**壳缓存**这条线 ✗ —— 导航依然是 **network-first** ✓（绝不能改成 cache-first ✗：那会让页面永远停在旧版 ✓）。
	 */
	const SERVICE_WORKER = `const CACHE = 'dshm-shell-${PLUGIN_VERSION}'
const SHELL = ['./', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']
self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (event) => {
	event.waitUntil(caches.keys()
		.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
		.then(() => self.clients.claim()))
})
self.addEventListener('fetch', (event) => {
	const request = event.request
	if (request.method !== 'GET') return
	let url
	try { url = new URL(request.url) } catch { return }
	if (url.origin !== self.location.origin) return
	if (url.pathname.includes('/api/') || url.pathname.endsWith('/sw.js')) return
	if (request.mode === 'navigate') {
		// 页面：**先网络、缓存只兜断网**。
		//
		// 这里曾经是"有缓存就先给缓存"（后台再更新缓存），也就是**实际上 cache-first** ——
		// 与注释里写的"绝不能吃旧缓存"正好相反。后果不是"慢一点"，而是
		// **改了手机页面，用户在手机上刷新也永远看不到**：旧 HTML 一直在跑。
		// 现场：2026-10-08 修好"工具结果里的图不显示"（1.3.7）之后，用户刷新仍然是老样子，
		// 因为 Service Worker 一直把上一版页面递给他。所以这里必须是"网络优先"：
		// 只有网络真失败（断网/桥没起来）才拿缓存里那张壳。
		event.respondWith(fetch(request).then((response) => {
			if (response.ok === true) {
				const copy = response.clone()
				caches.open(CACHE).then((cache) => cache.put('./', copy)).catch(() => {})
			}
			return response
		}).catch(() => caches.match('./').then((hit) => hit ?? Response.error())))
		return
	}
	if (/\\/icon-\\d+\\.png$|\\/manifest\\.webmanifest$/.test(url.pathname)) {
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
			const copy = response.clone()
			caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
			return response
		})))
	}
})
`

	function handleServiceWorker(res) {
		const buffer = Buffer.from(SERVICE_WORKER, 'utf8')
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': 'text/javascript; charset=utf-8',
			'content-length': buffer.length,
			'cache-control': 'no-cache',
			// 允许它在密钥段这一层生效（脚本自己就在那个目录下，属保险）。
			'service-worker-allowed': secretSuffix(state.config),
		})
		res.end(buffer)
	}

	async function handleCancel(req, res) {		let body
		try {
			body = await readBody(req, 4096)
		} catch {
			sendJson(res, 400, { error: 'bad request' })
			return
		}
		try {
			const value = await ctx.sessionController.cancel({ sessionId: String(body.sessionId ?? '') })
			sendJson(res, 200, { accepted: value.accepted === true })
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	async function handleAttachment(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		const attachmentId = url.searchParams.get('attachmentId') ?? ''
		try {
			const value = await ctx.sessionController.attachment({ sessionId, attachmentId })
			sendJson(res, 200, { mediaType: value.attachment.mediaType, data: value.data })
		} catch (error) {
			// The detail goes to the log, never to the caller: it can carry absolute
			// paths from inside the harness, and handing those to a remote peer is a
			// free map of the machine.
			warn(`attachment lookup failed: ${String(error?.message ?? error)}`)
			sendJson(res, 404, { error: 'attachment not found' })
		}
	}

	/**
	 * 附件走**真正的二进制 URL**（`/api/media`）。
	 *
	 * 为什么要多这一个接口：以前页面把附件取成 base64 再拼成 `data:` URI。iOS Safari
	 * 对 `data:` 图片**不给"存储到照片"**（长按只有"拷贝"），用户的诉求恰恰是"把电脑
	 * 给的素材存进手机相册"。真 URL 才长按可存，而且顺带省掉了 base64 那 33% 膨胀。
	 */
	async function handleMedia(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		const attachmentId = url.searchParams.get('attachmentId') ?? ''
		if (sessionId === '' || attachmentId === '') { sendJson(res, 400, { error: '缺少参数' }); return }
		let value
		try {
			value = await ctx.sessionController.attachment({ sessionId, attachmentId })
		} catch (error) {
			warn(`media lookup failed: ${String(error?.message ?? error)}`)
			sendJson(res, 404, { error: 'attachment not found' })
			return
		}
		const mediaType = String(value?.attachment?.mediaType ?? 'application/octet-stream')
		let bytes
		try {
			bytes = Buffer.from(String(value?.data ?? ''), 'base64')
		} catch {
			sendJson(res, 500, { error: 'attachment decode failed' })
			return
		}
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': mediaType,
			'content-length': bytes.length,
			'cache-control': 'private, max-age=3600',
		})
		res.end(bytes)
	}

	/**
	 * 手机把"我这儿出错了"写进桥日志：`POST /api/clientlog {event, detail, bytes}`。
	 *
	 * 为什么需要它：**客户端根本没发出去的失败，服务端一行日志都没有** —— 用户报
	 * "手机发图发不出去"时，日志里干干净净，只能靠猜（2026-10-09 就是这么卡住的）。
	 * 有了这条通道，手机上任何"读图失败/转码回退/发送失败"都会带着文件类型、大小、
	 * 分支与状态码出现在 `mobile-bridge.log` 里，下一次不用再猜。
	 */
	async function handleClientLog(req, res) {
		/*
		 * 这里**不用 readBody**：它在超限时中途抛错，留下的半截请求会让连接被掰断 ——
		 * 客户端看到的是 ECONNRESET（不是干净的 413），而且那条被污染的连接会毒到
		 * 紧随其后的请求（harness 里真炸过一次）。上报是 best-effort：读满上限就把
		 * 多余的丢掉，但**一定把流读完**，让连接保持干净。
		 */
		let raw = ''
		let overflow = false
		try {
			for await (const chunk of req) {
				if (raw.length + chunk.length > 64 * 1024) { overflow = true; continue }
				raw += chunk.toString('utf8')
			}
		} catch { /* 读挂了也照样回 200：上报绝不能反过来影响用户 */ }
		let body = {}
		try { body = raw.trim() === '' ? {} : JSON.parse(raw) } catch { body = {} }
		const event = String(body?.event ?? '').slice(0, 60)
		const detail = String(body?.detail ?? '').replace(/\s+/g, ' ').slice(0, 300)
		const bytes = Number(body?.bytes ?? 0)
		record(`client ${event === '' ? '(未命名)' : event}: ${detail}${overflow ? ' [体超限，已截断]' : ''}` +
			(Number.isFinite(bytes) && bytes > 0 ? ` [${bytes} bytes]` : ''))
		sendJson(res, 200, { ok: true, truncated: overflow })
	}

	/**
	 * 一张图/一段视频的**像素尺寸**：`/api/size?path=<绝对路径>` → `{width,height,mediaType}`。
	 *
	 * 为什么要它：手机上的图必须**预留尺寸**，否则每张图下载完都会把它下面的内容顶下去 ——
	 * 用户看到的就是"看着看着就串位（错位）"。会话里的附件自带 width/height，而电脑上产出的
	 * 素材在对话里只有一行路径，尺寸只有服务端知道（这里只读文件头，不解码整图）。
	 * 认不出尺寸（例如某些 WebP）就回 `{unknown:true}`，让页面用一个保守的占位比例。
	 */
	async function handleSize(req, res, url) {
		const requested = String(url.searchParams.get('path') ?? '')
		if (requested === '') { sendJson(res, 400, { error: '缺少 path' }); return }
		let path
		try {
			path = resolve(requested)
		} catch {
			sendJson(res, 400, { error: 'bad path' }); return
		}
		const mediaType = mediaTypeOf(path)
		// 这个接口只回答"图片多大"，所以非图片一律 415（文档类型表是给 /api/file 用的）。
		if (mediaType.startsWith('image/') === false) { sendJson(res, 415, { error: '只支持图片' }); return }
		if (isServablePath(path) === false) { sendJson(res, 403, { error: '这个路径不在允许的目录里' }); return }
		let info
		try {
			info = await stat(path)
		} catch {
			sendJson(res, 404, { error: '文件不存在' }); return
		}
		if (info.isFile() !== true) { sendJson(res, 404, { error: '不是文件' }); return }
		const size = imageSizeOf(path)
		if (size === undefined || size.width <= 0 || size.height <= 0) {
			sendJson(res, 200, { mediaType, unknown: true })
			return
		}
		sendJson(res, 200, { mediaType, width: size.width, height: size.height })
	}

	/* ---------------- Office / 表格预览（PPT → 逐页 JPG；Excel → 行×列） ---------------- */
	/*
	 * 用户 2026-10-23：「手机桥帮我加上 ppt 和表格渲染功能」✓。
	 * 细节都写在上面的常量注释里了 ✓；这里只强调两条纪律：
	 *   ① 转换产物**只给缓存目录 + 白名单扩展名** ✓（别把这里做成任意文件转码器 ✗）；
	 *   ② 转换失败**如实说 + 给下载出路** ✓（不假装能看 ✗，也不留白屏 ✗）。
	 */
	const previewCacheRoot = () => join(dshHome(), 'mobile-bridge', 'preview-cache')
	const previewScriptPath = () => join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'office-preview.ps1')
	let previewQueue = Promise.resolve()

	function previewKindOf(path) {
		const ext = extname(path).toLowerCase()
		if (ext === '.ppt' || ext === '.pptx' || ext === '.pptm') return 'slides'
		if (ext === '.xls' || ext === '.xlsx' || ext === '.xlsm' || ext === '.xlsb') return 'sheet'
		if (ext === '.csv' || ext === '.tsv') return 'delimited'
		return ''
	}

	function previewCacheDir(path, info) {
		const key = createHash('sha1')
			.update(`${path}|${String(info.size)}|${String(Math.round(info.mtimeMs))}`)
			.digest('hex').slice(0, 20)
		return join(previewCacheRoot(), key)
	}

	/** 串行执行（PowerPoint / Excel COM 同时开两份很容易互相卡住 ✓）。 */
	function enqueuePreview(task) {
		const run = previewQueue.then(task, task)
		previewQueue = run.then(() => undefined, () => undefined)
		return run
	}

	function execFileAsync(file, args, options = {}) {
		return new Promise((resolvePromise, reject) => {
			execFile(file, args, { windowsHide: true, timeout: options.timeout ?? 180_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return }
				resolvePromise({ stdout, stderr })
			})
		})
	}

	/** 跑 tools/office-preview.ps1（PowerPoint/Excel COM），返回它写出来的 result.json。 */
	async function runOfficePreview(mode, path, outDir) {
		const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
		const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', previewScriptPath(), '-Mode', mode, '-Path', path, '-OutDir', outDir]
		if (mode === 'slides') args.push('-MaxSlides', String(PREVIEW_MAX_SLIDES), '-Width', String(PREVIEW_WIDTH))
		else args.push('-MaxRows', String(PREVIEW_MAX_ROWS), '-MaxCols', String(PREVIEW_MAX_COLS))
		await mkdir(outDir, { recursive: true })
		await execFileAsync(existsSync(powershell) ? powershell : 'powershell.exe', args)
		const raw = await readFile(join(outDir, 'result.json'), 'utf8')
		let result = null
		try { result = JSON.parse(raw) } catch { result = null }
		if (result === null || result.ok !== true) throw new Error(String(result?.error ?? '转换脚本没有给出结果'))
		return result
	}

	/** 缓存清理：只清很久没用的 / 只留最近 N 份（都是 best-effort ✓）。 */
	async function prunePreviewCache() {
		try {
			const root = previewCacheRoot()
			const names = await readdir(root)
			const rows = []
			for (const name of names) {
				try {
					const info = await stat(join(root, name))
					if (info.isDirectory() !== true) continue
					rows.push({ name, mtimeMs: info.mtimeMs })
				} catch { /* 正在被删也无所谓 */ }
			}
			rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
			const now = Date.now()
			for (const [index, row] of rows.entries()) {
				if (index < PREVIEW_CACHE_MAX_DIRS && now - row.mtimeMs < PREVIEW_CACHE_MAX_AGE_MS) continue
				await rm(join(root, row.name), { recursive: true, force: true }).catch(() => {})
			}
		} catch { /* 缓存目录还没建 / 被占用：都不该影响这一次预览 */ }
	}

	/** 缓存里有没有一份**当前文件**的幻灯片结果（目录键里含 mtime ✓，所以命中就是新鲜的 ✓）。 */
	async function readSlidesCache(cacheDir) {
		try {
			const result = JSON.parse(await readFile(join(cacheDir, 'result.json'), 'utf8'))
			if (result?.ok !== true || result.kind !== 'slides') return null
			const exported = Number(result.exported ?? 0)
			if (exported < 1) return null
			for (let index = 1; index <= exported; index += 1) {
				const info = await stat(join(cacheDir, `slide-${index}.jpg`))
				if (info.isFile() !== true || info.size < 1000) return null
			}
			return result
		} catch { return null }
	}

	async function ensureSlidesPreview(path, info) {
		const cacheDir = previewCacheDir(path, info)
		const cached = await readSlidesCache(cacheDir)
		if (cached !== null) return { result: cached, cacheDir }
		return await enqueuePreview(async () => {
			const again = await readSlidesCache(cacheDir)
			if (again !== null) return { result: again, cacheDir }
			await prunePreviewCache()
			const result = await runOfficePreview('slides', path, cacheDir)
			if (Number(result.exported ?? 0) < 1) throw new Error('这份 PPT 没有导出任何一页')
			return { result, cacheDir }
		})
	}

	/** CSV/TSV：不劳驾 Excel ✓（秒开），只要一个够用的解析（引号 / 逗号 / 换行 ✓）。 */
	function parseDelimited(raw, delimiter) {
		const text = String(raw).replace(/^\uFEFF/, '')
		const rows = []
		let row = []
		let field = ''
		let quoted = false
		for (let index = 0; index < text.length; index += 1) {
			const char = text[index]
			if (quoted === true) {
				if (char === '"') {
					if (text[index + 1] === '"') { field += '"'; index += 1 } else { quoted = false }
				} else field += char
				continue
			}
			if (char === '"') { quoted = true; continue }
			if (char === delimiter) { row.push(field); field = ''; continue }
			if (char === '\n' || char === '\r') {
				if (char === '\r' && text[index + 1] === '\n') index += 1
				row.push(field); field = ''
				rows.push(row); row = []
				continue
			}
			field += char
		}
		if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
		return rows
	}

	async function ensureDelimitedPreview(path) {
		const raw = await readFile(path, 'utf8')
		const delimiter = extname(path).toLowerCase() === '.tsv' ? '\t' : ','
		const all = parseDelimited(raw, delimiter)
		const rows = all.slice(0, PREVIEW_MAX_ROWS).map((row) => row.slice(0, PREVIEW_MAX_COLS).map((cell) => {
			const text = String(cell ?? '')
			return text.length > PREVIEW_CELL_MAX_CHARS ? text.slice(0, PREVIEW_CELL_MAX_CHARS) : text
		}))
		return {
			kind: 'sheet',
			sheets: [{
				name: basename(path),
				rows,
				totalRows: all.length,
				totalCols: all.reduce((max, row) => Math.max(max, row.length), 0),
				truncated: all.length > PREVIEW_MAX_ROWS || all.some((row) => row.length > PREVIEW_MAX_COLS),
			}],
		}
	}

	async function ensureSheetPreview(path, info) {
		const cacheDir = previewCacheDir(path, info)
		try {
			const cached = JSON.parse(await readFile(join(cacheDir, 'result.json'), 'utf8'))
			if (cached?.ok === true && cached.kind === 'sheet') return cached
		} catch { /* 没有缓存：现转 */ }
		return await enqueuePreview(async () => {
			try {
				const again = JSON.parse(await readFile(join(cacheDir, 'result.json'), 'utf8'))
				if (again?.ok === true && again.kind === 'sheet') return again
			} catch { /* 现转 */ }
			await prunePreviewCache()
			return await runOfficePreview('sheet', path, cacheDir)
		})
	}

	/** `GET /api/preview?path=<绝对路径>`：PPT → 页数 / 尺寸；Excel → 行×列（最多 300×30）。 */
	async function handlePreview(req, res, url) {
		const requested = String(url.searchParams.get('path') ?? '')
		if (requested === '') { sendJson(res, 400, { error: '缺少 path' }); return }
		let path
		try { path = resolve(requested) } catch { sendJson(res, 400, { error: 'bad path' }); return }
		if (isSensitivePath(path)) { sendJson(res, 403, { error: '这个文件不给（里面是密钥）' }); return }
		if (isServablePath(path) === false) { sendJson(res, 403, { error: '这个路径不在允许的目录里' }); return }
		const kind = previewKindOf(path)
		if (kind === '') { sendJson(res, 415, { error: '这个类型不做预览（只支持 PPT / Excel / CSV）—— 点「下载」用手机上的 App 打开' }); return }
		let info
		try { info = await stat(path) } catch { sendJson(res, 404, { error: '文件不存在' }); return }
		if (info.isFile() !== true) { sendJson(res, 404, { error: '不是文件' }); return }
		if (info.size > MAX_DOCUMENT_BYTES) {
			sendJson(res, 413, { error: '文件太大，手机上预览不了（超过 ' + Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024) + ' MB）—— 点「下载」' })
			return
		}
		const name = basename(path)
		try {
			if (kind === 'slides') {
				const { result } = await ensureSlidesPreview(path, info)
				const exported = Number(result.exported ?? 0)
				record(`预览：${name} → ${exported}/${Number(result.count ?? exported)} 页幻灯片`)
				sendJson(res, 200, {
					ok: true, kind: 'slides', path, name,
					count: Number(result.count ?? exported), exported,
					truncated: result.truncated === true,
					width: Number(result.width ?? PREVIEW_WIDTH), height: Number(result.height ?? 720),
				})
				return
			}
			if (kind === 'sheet') {
				const result = await ensureSheetPreview(path, info)
				const sheets = Array.isArray(result.sheets) ? result.sheets : []
				// 总格子数再兜一层（Excel 的 300×30 已经是上限；这里防的是多张表叠起来）
				let budget = PREVIEW_TOTAL_CELLS
				const trimmed = sheets.map((sheet) => {
					const rows = Array.isArray(sheet.rows) ? sheet.rows : []
					const kept = []
					for (const row of rows) {
						if (budget <= 0) break
						const cells = Array.isArray(row) ? row.slice(0, PREVIEW_MAX_COLS) : []
						budget -= Math.max(1, cells.length)
						kept.push(cells)
					}
					return { ...sheet, rows: kept }
				})
				record(`预览：${name} → ${trimmed.length} 张表（${trimmed.map((sheet) => sheet.name).join(' / ')}）`)
				sendJson(res, 200, { ok: true, kind: 'sheet', path, name, sheets: trimmed })
				return
			}
			const result = await ensureDelimitedPreview(path)
			record(`预览：${name} → ${result.sheets[0].rows.length} 行表格`)
			sendJson(res, 200, { ok: true, kind: 'sheet', path, name, sheets: result.sheets })
		} catch (error) {
			const message = String(error?.message ?? error)
			record(`预览失败：${name} → ${message}`)
			sendJson(res, 500, {
				ok: false,
				error: '转换失败：' + message,
				hint: '这台电脑要用 PowerPoint / Excel 来转（Office 得装好且能打开）。点右上角「下载」，用手机上的 WPS / Office 打开也行 ✓',
			})
		}
	}

	/** `GET /api/preview/asset?path=<绝对路径>&n=<第几页>`：幻灯片导出的 JPG。 */
	async function handlePreviewAsset(req, res, url) {
		const requested = String(url.searchParams.get('path') ?? '')
		const page = Number(url.searchParams.get('n') ?? NaN)
		if (requested === '' || Number.isFinite(page) === false) { sendJson(res, 400, { error: '缺少 path / n' }); return }
		let path
		try { path = resolve(requested) } catch { sendJson(res, 400, { error: 'bad path' }); return }
		if (isSensitivePath(path)) { sendJson(res, 403, { error: '这个文件不给（里面是密钥）' }); return }
		if (isServablePath(path) === false) { sendJson(res, 403, { error: '这个路径不在允许的目录里' }); return }
		if (previewKindOf(path) !== 'slides') { sendJson(res, 415, { error: '这个文件不是幻灯片' }); return }
		let info
		try { info = await stat(path) } catch { sendJson(res, 404, { error: '文件不存在' }); return }
		const cacheDir = previewCacheDir(path, info)
		const n = Math.round(page)
		if (n < 1 || n > PREVIEW_MAX_SLIDES) { sendJson(res, 404, { error: '没有这一页' }); return }
		const file = join(cacheDir, `slide-${n}.jpg`)
		let fileInfo
		try { fileInfo = await stat(file) } catch { sendJson(res, 404, { error: '这一页还没转好，回去重新打开一次' }); return }
		if (fileInfo.isFile() !== true) { sendJson(res, 404, { error: '这一页还没转好' }); return }
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': 'image/jpeg',
			'content-length': fileInfo.size,
			'cache-control': 'private, max-age=3600',
		})
		createReadStream(file).pipe(res)
	}

	/**
	 * 把电脑上的一张图/一段视频发给手机：`/api/file?path=<绝对路径>`。
	 *
	 * 场景：agent 在电脑上做了素材（`image_generate` 的图、脚本截的图、导出的视频），
	 * 对话里只有一行路径 —— 手机上看不到，也没法存。这个接口让那些路径变成真图片。
	 *
	 * 只发**图片/视频**，而且必须在桥认识的目录里（工作区、会话目录、~/.dsh、
	 * 临时目录）。否则它就成了"任意文件读取"，那不是一个手机控制台该有的能力。
	 */
	async function handleFile(req, res, url) {
		const requested = String(url.searchParams.get('path') ?? '')
		if (requested === '') { sendJson(res, 400, { error: '缺少 path' }); return }
		let path
		try {
			path = resolve(requested)
		} catch {
			sendJson(res, 400, { error: 'bad path' }); return
		}
		// 密钥类文件一律不给 —— 2.1.0 加了"文档"类型之后，`mobile-bridge.json`（里面有 PIN）
		// 也会落进 `.json` 这一档，那就等于把门钥匙挂到门上 ✗。
		if (isSensitivePath(path)) { sendJson(res, 403, { error: '这个文件不给（里面是密钥）' }); return }
		// 类型按**内容**认（扩展名经常骗人，见 sniffBytes），认不出才看扩展名；文档按扩展名。
		const mediaType = mediaTypeOf(path)
		if (mediaType === '') { sendJson(res, 415, { error: '这个类型手机上看不了（只支持图片/视频/文档）' }); return }
		if (isServablePath(path) === false) { sendJson(res, 403, { error: '这个路径不在允许的目录里' }); return }
		const isInline = INLINE_TYPES.has(mediaType)
		// 文档另给一个更小的闸：手机上打开一个 100 MB 的 PDF/表格只会卡死。
		const limit = isInline || mediaType.startsWith('text/') || DOC_TYPES[extname(path).toLowerCase()] !== undefined
			? MAX_DOCUMENT_BYTES
			: MAX_SERVED_FILE_BYTES
		let info
		try {
			info = await stat(path)
		} catch {
			sendJson(res, 404, { error: '文件不存在' }); return
		}
		if (info.isFile() !== true) { sendJson(res, 404, { error: '不是文件' }); return }
		if (info.size > limit) {
			sendJson(res, 413, { error: isInline ? '文件太大，手机上打不开（超过 ' + Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024) + ' MB）' : '文件太大' })
			return
		}
		// 文档给个明确的名字 + 是否内联：`?inline=1` 让浏览器直接在页面里渲染（PDF/文本），
		// 否则（Office 文档）当下载 —— 浏览器本来就渲染不了 docx/xlsx，下载后用别的 App 打开最靠谱。
		// 图片/视频一律 inline（它们本来就是要显示出来的）。
		const disposition = isInline === false
			? 'inline'
			: (String(url.searchParams.get('inline') ?? '') === '1' ? 'inline' : 'attachment')
		const dispositionHeader = `${disposition}; filename*=UTF-8''${encodeURIComponent(basename(path))}`
		const etag = `"file-${info.size}-${Math.round(info.mtimeMs)}"`
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304, { ...SECURITY_HEADERS, etag })
			res.end()
			return
		}
		const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
		if (range !== null) {
			const start = range[1] === '' ? Math.max(0, info.size - Number(range[2] ?? 0)) : Number(range[1])
			const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
			if (Number.isFinite(start) === false || Number.isFinite(end) === false || start > end || start >= info.size) {
				res.writeHead(416, { ...SECURITY_HEADERS, 'content-range': `bytes */${info.size}` })
				res.end()
				return
			}
			res.writeHead(206, {
				...SECURITY_HEADERS,
				'content-type': mediaType,
				'content-disposition': dispositionHeader,
				'content-length': end - start + 1,
				'content-range': `bytes ${start}-${end}/${info.size}`,
				'accept-ranges': 'bytes',
				etag,
				'cache-control': 'private, max-age=600',
			})
			createReadStream(path, { start, end }).pipe(res)
			return
		}
		res.writeHead(200, {
			...SECURITY_HEADERS,
			'content-type': mediaType,
			'content-disposition': dispositionHeader,
			'content-length': info.size,
			'accept-ranges': 'bytes',
			etag,
			'cache-control': 'private, max-age=600',
		})
		createReadStream(path).pipe(res)
	}

	/**
	 * 把一条记录里的超长字符串截断。工具输出（一条命令几十 KB）是大头。
	 * 带深度上限，防止意外的循环引用把递归卡死。
	 */
	function shrinkRecord(value, depth = 0) {
		if (typeof value === 'string') {
			return value.length > SNAPSHOT_TEXT_LIMIT
				? `${value.slice(0, SNAPSHOT_TEXT_LIMIT)}\n…（已截断，原文 ${value.length} 字；完整内容在电脑上看）`
				: value
		}
		if (Array.isArray(value)) {
			if (depth > 12) return []
			return value.map((item) => shrinkRecord(item, depth + 1))
		}
		if (value !== null && typeof value === 'object') {
			if (depth > 12) return null
			const out = {}
			for (const [key, item] of Object.entries(value)) out[key] = shrinkRecord(item, depth + 1)
			return out
		}
		return value
	}

	/**
	 * 把快照压到预算之内：先截断超长文本，再从【最旧的】开始丢，直到整包够小。
	 * 手机上看到的是最近的对话，而不是九兆历史的开头。
	 *
	 * `trimEvent` 必须先过一遍：`assistant/message` 的 `data.stream` 里装着这条消息
	 * 已经逐字推过的全部增量，**是一堆短字符串**（不是超长文本），所以 shrinkRecord
	 * 的 4000 字截断对它完全无效。实测一条这样的记录能让 /api/transcript 回 782 KB
	 * —— 正好把这个接口存在的理由（别让手机收到大包）又踩回去。
	 */
	function fitSnapshot(records) {
		const shrunk = Array.isArray(records)
			? records.map((entry) => {
				const trimmed = entry?.type === 'event' ? { ...entry, event: trimEvent(entry.event) } : entry
				return shrinkRecord(trimmed)
			})
			: []
		let from = 0
		let bytes = JSON.stringify(shrunk).length
		while (bytes > SNAPSHOT_BUDGET_BYTES && from < shrunk.length - 1) {
			bytes -= JSON.stringify([shrunk[from]]).length - 2   // 减去这条加它前后逗号的近似长度
			from += 1
		}
		const kept = shrunk.slice(from)
		return { records: kept, dropped: from, bytes: JSON.stringify(kept).length }
	}

	/**
	 * 用一次【普通请求】把最近的对话取回去。
	 *
	 * 为什么必须有它：有些通道会把大响应缓冲住，直到有更多数据把它冲出来。
	 * 实测症状 —— 手机打开页面一片空白，**直到电脑那边发了一条新消息**，快照才跟着
	 * 冲出来。SSE 的初始快照是 200 多 KB 的一次性写入，正好踩这个坑；而 bootstrap
	 * 这种普通请求从来都是立刻送达的。所以初始对话走这里，实时增量仍走 SSE：
	 * 能推就推，推不动也不至于什么都看不见。
	 */
	/** 取一份裁过的对话快照（`/api/transcript` 与 `/api/boot` 共用）。 */
	async function buildTranscript(sessionId, signal) {
		const controller = new AbortController()
		const stop = () => controller.abort()
		if (signal !== undefined) {
			if (signal.aborted) controller.abort()
			else signal.addEventListener('abort', stop, { once: true })
		}
		const empty = () => ({ pageTag: state.pageTag, cursor: 0, hasMore: false, records: [] })
		let timedOut = false
		const timer = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
		try {
			const frames = ctx.sessionController.follow(
				{ address: { kind: 'session', sessionId }, maxMessages: SNAPSHOT_MAX_MESSAGES, assistantStream: false },
				controller.signal,
			)
			for await (const frame of frames) {
				if (frame.type !== 'snapshot') continue
				const fitted = fitSnapshot(frame.records)
				return {
					pageTag: state.pageTag,
					cursor: frame.cursor,
					hasMore: frame.hasMore === true || fitted.dropped > 0,
					records: fitted.records,
				}
			}
			return empty()
		} catch (error) {
			const message = String(error?.message ?? error)
			// 子会话打不开不算"出错"：给手机一个明确的 unsupported，让它说人话。
			if (isUnfollowable(message)) {
				state.unfollowable.add(sessionId)
				return { ...empty(), unsupported: true, reason: message }
			}
			// 自己掐的 15 秒表不算"出错"：给一个空快照，页面本来就会忽略空结果。
			if (timedOut) return empty()
			throw error
		} finally {
			clearTimeout(timer)
			if (signal !== undefined) signal.removeEventListener('abort', stop)
			controller.abort()
		}
	}

	/**
	 * `since=` 的解析：只接受非负整数，别的（空、乱写、负数、小数）一律当没带。
	 * @returns {number|null}
	 */
	function parseSince(raw) {
		if (raw === null || raw === undefined || raw === '') return null
		const value = Number(raw)
		return Number.isInteger(value) && value >= 0 ? value : null
	}

	/**
	 * 客户端说"我手上已经有到 since 为止的内容" → 只回它没见过的记录。
	 *
	 * 为什么值得做：手机切到别的会话再切回来，原来要把整段对话（实测 40 KB gzip、
	 * 隧道上好几秒）重下一遍 —— 而这份内容刚刚还在屏幕上。带上序号之后，通常一条
	 * 都不用发；用户感觉到的差别是"秒开"和"又转圈"。
	 *
	 * 安全性（宁可多发，绝不能少发）：只有当 since 落在本份快照的序号范围内时才敢裁剪。
	 * 客户端比快照里最旧的记录还旧（页面放了很久、历史被裁掉或被压缩重排过）时，
	 * 它缺的那一段谁也补不上 —— 那就老实回整段。
	 *
	 * @returns {{ records: unknown[], partial: boolean }} partial=true 表示"这只是增量"。
	 */
	function sliceSince(records, cursor, since) {
		if (since === null || typeof cursor !== 'number' || since > cursor) return { records, partial: false }
		const seqs = []
		for (const record of records) {
			const seq = record?.event?.seq ?? record?.seq
			if (typeof seq === 'number') seqs.push(seq)
		}
		if (seqs.length === 0) return { records, partial: false }
		const oldest = Math.min(...seqs)
		// 客户端比我们能给的最旧记录还旧 → 中间那段补不上，回整段。
		if (since < oldest - 1) return { records, partial: false }
		return { records: records.filter((record) => (record?.event?.seq ?? 0) > since), partial: true }
	}

	async function handleTranscript(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		if (sessionId === '') { sendJson(res, 400, { error: '缺少 sessionId' }); return }
		const since = parseSince(url.searchParams.get('since'))
		// 手机切走 / 关掉页面时，这次请求就没人在听了。往一条已经断掉的 socket 上
		// writeHead 会抛，而这里抛在 await 之外就是进程级 uncaught —— 和 handleStream
		// 里那个坑是同一个，代价都是整台 DSH 倒下。所以每次写之前先确认还活着。
		const alive = () => res.writableEnded !== true && res.destroyed !== true
		const controller = new AbortController()
		// 监听 res 而不是 req：res 的 close 只会在这条响应真的收尾之后才响，
		// 而 req 的 close 在普通 GET 上可能早于我们的异步读取，会把功能整个掐掉。
		res.on('error', () => controller.abort())
		res.on('close', () => controller.abort())
		try {
			const payload = await buildTranscript(sessionId, controller.signal)
			if (!alive()) return
			// 带了 since 且手上确实有内容 → 只回新记录（平时一条都没有）。
			if (since !== null && Array.isArray(payload.records)) {
				const sliced = sliceSince(payload.records, payload.cursor ?? 0, since)
				if (sliced.partial === true) {
					payload.partial = true
					payload.records = sliced.records
				}
			}
			sendJson(res, 200, payload)
		} catch (error) {
			if (!alive()) return
			if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
		}
	}

	/** Server-sent events over one Session's durable log. */
	async function handleStream(req, res, url) {
		const sessionId = url.searchParams.get('sessionId') ?? ''
		if (sessionId === '') {
			sendJson(res, 400, { error: '缺少 sessionId' })
			return
		}
		// `since=` —— 客户端说"我手上已经有到这个序号为止的内容了"。
		const since = parseSince(url.searchParams.get('since'))
		// Refuse BEFORE the 200. Announcing a stream and then hanging up looks
		// exactly like a broken connection and is miserable to diagnose.
		if (state.streams.size >= MAX_LIVE_STREAMS) {
			record(`stream refused: ${state.streams.size} already live`)
			sendJson(res, 503, { error: 'too many live streams' })
			return
		}
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		})
		res.write(': connected\n\n')

		const controller = new AbortController()
		// sessionId 留在 entry 上：agent 提问时要推给【正在看这个会话】的手机，
		// 推错会话比不推更糟（用户会在一个无关的对话里看到别人的提问）。
		const entry = { res, controller, sessionId }
		state.streams.add(entry)
		/*
		 * 4.14.1：手机一开始看某个会话就记一行 ✓ —— 和 `askPhone` 里那句
		 * "现在没有手机在看 X（此刻有人在看：…）"配成一对 ✓，
		 * 于是"提问发生时手机到底在看哪个会话"从日志里**直接读得出来** ✓
		 *（以前只有一条 `GET /api/stream`、不带会话名 ✗ —— 用户报"手机上看不见提问"时，
		 *  最要紧的那个事实恰好是唯一没被记下来的 ✓）。
		 */
		record(`手机开始看 ${sessionId}（此刻共 ${state.streams.size} 条流）`)

		// `res.write` on an ended response does NOT throw — it emits an
		// asynchronous 'error' event, and an unhandled one takes the whole Node
		// process down. That is exactly how a plugin reload (which ends every
		// stream) used to kill the running DSH, so both halves are needed:
		// an 'error' listener, and a guard before every write.
		res.on('error', () => controller.abort())
		req.on('close', () => controller.abort())

		const writable = () => controller.signal.aborted !== true && res.writableEnded !== true && res.destroyed !== true

		const keepAlive = setInterval(() => {
			if (!writable()) return
			// 必须是【真数据帧】，不能只是 `: ping` 注释：注释走不到 EventSource 的
			// onmessage，手机就分不清"这个会话本来就没动静"和"连接已经半死"。
			// 电脑睡眠时 onerror 往往不响，只有这个心跳能证明对面还在说话。
			try { res.write(`data: ${JSON.stringify({ t: 'ping', at: Date.now() })}\n\n`) } catch { controller.abort() }
		}, 20000)

		const write = (payload) => {
			if (!writable()) return
			try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { controller.abort() }
		}
		// 广播提问/审批时要隔着 entry 拿到它自己的 write（每个流一个闭包）。
		entry.write = write

		// 还没答的提问要补推一次。提问只在发生时推一次，手机刷新一下就再也看不到了 ——
		// 而宿主仍在傻等，用户则以为"agent 卡住了"。
		for (const waiter of state.pending.values()) {
			if (waiter.sessionId !== sessionId) continue
			write({ t: 'interaction', kind: waiter.kind, id: waiter.id, payload: waiter.payload })
		}

		try {
			const frames = ctx.sessionController.follow(
				{ address: { kind: 'session', sessionId }, maxMessages: SNAPSHOT_MAX_MESSAGES, assistantStream: true },
				controller.signal,
			)
			for await (const frame of frames) {
				if (!writable()) break
				if (frame.type === 'snapshot') {
					// 绝不把整段历史原样塞给手机：压到预算内，必要时丢掉最旧的记录。
					const fitted = fitSnapshot(frame.records)
					// 客户端带了 since=（它手上已经有到那儿为止的内容）→ 只补新的。
					const sliced = sliceSince(fitted.records, frame.cursor ?? 0, since)
					write({
						t: 'snapshot',
						tag: state.pageTag,
						cursor: frame.cursor,
						hasMore: frame.hasMore === true || fitted.dropped > 0,
						records: sliced.records,
						// 明确告诉页面"这只是增量，别拿它当成整段" —— 页面据此只追加，
						// 不清空重建（否则历史会被这份只有新记录的快照抹掉）。
						partial: sliced.partial === true ? true : undefined,
					})
				} else if (frame.type === 'event') {
					write({ t: 'event', event: trimEvent(frame.event) })
				} else if (frame.type === 'assistant-stream') {
					write({ t: 'delta', frame: frame.frame })
				}
			}
			write({ t: 'end' })
		} catch (error) {
			const message = String(error?.message ?? error)
			const unsupported = isUnfollowable(message)
			if (unsupported) state.unfollowable.add(sessionId)
			if (!controller.signal.aborted) {
				// unsupported=true 是给页面看的明确信号：这不是网络断了，是这个会话
				// 本身在手机上打不开，别弹"地址已失效"，也别每三秒重连一次。
				write(unsupported ? { t: 'error', message, unsupported: true } : { t: 'error', message })
			}
		} finally {
			clearInterval(keepAlive)
			state.streams.delete(entry)
			// 4.14.1：走了也记一行 ✓（配对上面那条"开始看" ✓ —— 只剩一条流时能看出是谁在挂着 ✓）。
			record(`手机不看 ${sessionId} 了（还剩 ${state.streams.size} 条流）`)
			try { if (res.writableEnded !== true) res.end() } catch { /* closed */ }
		}
	}

	/* ------------------------------------------------- 提问 / 审批（手机作答） */

	/** 正在看某个会话的手机流。空数组 = 没人在看。 */
	function watchersOf(sessionId) {
		const list = []
		for (const entry of state.streams) {
			if (entry.sessionId === sessionId && typeof entry.write === 'function') list.push(entry)
		}
		return list
	}

	/** 把一帧推给正在看这个会话的所有手机流。 */
	function pushToSession(sessionId, payload) {
		for (const entry of watchersOf(sessionId)) entry.write(payload)
	}

	/**
	 * 推给**所有**在线手机流（不分会话）✓ —— 4.14.1 新增，只用来发"提示"帧 ✓。
	 *
	 * ⚠️ 这里**只许放 id，不许放提问正文** ✗：桥支持多台设备（用户自己的几台手机 ✓，
	 * 而且历史上还放行过别的设备 ✓），把"另一个会话问了什么"广播出去等于**跨会话泄漏** ✗。
	 * 正文只在**登录之后**、并且**真的切到那个会话**时才取 ✓（`/api/waiting` ✓，和看会话本身同一个门槛 ✓）。
	 */
	function pushToAll(payload) {
		for (const entry of state.streams) {
			if (typeof entry.write === 'function') entry.write(payload)
		}
	}

	/**
	 * 4.14.1：**手机上错过的提问，回来还答得了吗** ✓ —— 答案在宿主自己那儿，不用桥另记一份 ✓：
	 * `userQuestions.continued(agent)` 给的正是"这条提问超时了、但**仍可迟到作答**"的那些 ✓
	 *（对应投影里 `active[].state === 'continued'` ✓）。`agents.roots()` 给活着的根 agent ✓，
	 * 而根 agent 的 `id` **就是会话 id** ✓（`dsh-agent` 的类型就是这么标的 ✓）。
	 *
	 * ⚠️ 宿主没有这两个服务 / 读的时候抛了 → 回 `available: false` ✓ ——
	 * **不许把"读不到"说成"没有提问"** ✗（这一版最较真的那条纪律 ✓）。
	 */
	function continuedQuestions() {
		const read = (name) => { try { return ctx.get(name) } catch { return undefined } }
		const agents = read('agents')
		const questions = read('userQuestions')
		if (agents === undefined || questions === undefined
			|| typeof agents.roots !== 'function' || typeof questions.continued !== 'function') {
			return { available: false, items: [] }
		}
		const items = []
		try {
			for (const agent of agents.roots() ?? []) {
				const sessionId = String(agent?.id ?? '')
				if (sessionId === '') continue
				for (const item of questions.continued(agent) ?? []) {
					const callId = String(item?.callId ?? '')
					if (callId === '') continue
					items.push({ sessionId, callId, questions: Array.isArray(item?.questions) ? item.questions : [] })
				}
			}
		} catch (error) {
			warn(`cannot read continued questions: ${String(error?.message ?? error)}`)
			return { available: false, items: [] }
		}
		return { available: true, items }
	}

	/**
	 * 挂起一个等待手机回答的交互。
	 *
	 * 返回 null = "这次不该由手机答"（功能没开 / 没人看这个会话 / 队列已满），
	 * 调用方必须立刻 next() 让桌面接手 —— 这是保证【桌面体验一点不变】的关键。
	 * 返回 Promise = 已经推给手机了，等它回答；超时或请求被取消则 fallthrough。
	 */
	function askPhone(kind, sessionId, payload, signal) {
		/*
		 * 🔴 4.14.1 诊断（用户 2026-10-16：「我看不见你的问题手机端」✗，而日志里**一条提问记录都没有** ✗）：
		 * 这条路上有**五个**"还是不交给手机"的出口 ✓ —— 以前它们**全部静默** ✗，
		 * 于是"手机没弹卡片"只能靠猜 ✓（这正是"以前能用、现在看不见"最难查的地方 ✓）。
		 * 现在每个出口都记一行**为什么** ✓，而且"没人在看"那一支还会**把当前有人在看的会话列出来** ✓ ——
		 * 这样"提问在 A 会话发生、而手机正在看 B 会话"这种最常见的错位一眼就能看见 ✓。
		 * 代价：一天几行日志 ✓（可接受 ✓）。
		 */
		if (state.config?.answerOnPhone !== true) {
			record(`ask(${kind}) -> 桌面：answerOnPhone 关着`)
			return null
		}
		if (sessionId === '') {
			record(`ask(${kind}) -> 桌面：请求里没有会话 id（request.agent 缺失）`)
			return null
		}
		if (state.pending.size >= MAX_PENDING_INTERACTIONS) {
			warn(`refusing to queue another ${kind}: ${state.pending.size} already pending`)
			record(`ask(${kind}) -> 桌面：队列满（${state.pending.size} 条还没答）`)
			return null
		}
		const watchers = watchersOf(sessionId)
		if (watchers.length === 0) {
			const watching = [...state.streams].map((entry) => String(entry.sessionId ?? '')).filter((id) => id !== '')
			record(`ask(${kind}) -> 桌面：现在没有手机在看 ${sessionId}`
				+ `（此刻有人在看：${watching.length === 0 ? '没有任何会话' : watching.join(' / ')}）`)
			return null
		}

		const id = randomBytes(9).toString('base64url')
		let settle = () => {}
		const promise = new Promise((resolve) => { settle = resolve })
		// 变量名【不能】叫 record —— 那会遮蔽同作用域里的日志函数 record()，
		// 于是这一行下面的 record(...) 变成 TypeError 把宿主打死。这个坑踩过一次了。
		// id/payload 也存在 waiter 上：手机刷新或重连时要把没答的提问补推一次。
		const waiter = { id, kind, sessionId, payload, timer: null, answer: null, cancel: null }

		const finish = (outcome) => {
			if (state.pending.get(id) !== waiter) return
			state.pending.delete(id)
			if (waiter.timer !== null) { clearTimeout(waiter.timer); waiter.timer = null }
			if (signal !== undefined) signal.removeEventListener('abort', onAbort)
			// 让其余手机把这张卡片撤掉（超时、被别的手机答了、或请求已取消）。
			pushToSession(sessionId, { t: 'interaction-end', id })
			settle(outcome)
		}
		// 取消和超时是两件事，必须分开：
		//   超时 → 用户可能只是没看手机，交给桌面接着问；
		//   取消 → agent 已经放弃了（用户按了停止、会话结束），这时候再去 next()
		//          会让桌面弹出一个【已经作废】的批准框，用户点了也毫无意义。
		const onAbort = () => finish({ kind: 'cancelled' })

		waiter.answer = (value) => finish({ kind: 'answer', value })
		waiter.cancel = () => finish({ kind: 'fallthrough' })
		state.pending.set(id, waiter)
		waiter.timer = setTimeout(() => finish({ kind: 'fallthrough' }), INTERACTION_TIMEOUT_MS)
		if (signal !== undefined) {
			if (signal.aborted === true) { finish({ kind: 'fallthrough' }); return null }
			signal.addEventListener('abort', onAbort, { once: true })
		}
		for (const entry of watchers) entry.write({ t: 'interaction', kind, id, payload })
		record(`waiting for the phone to answer a ${kind} in ${sessionId}`)
		return promise
	}

	/**
	 * 手机优先的提问应答者。
	 *
	 * 必须 prepend 在官方 api-remotes 之前：waterfall 是顺序的，谁先返回谁作数；
	 * 排在它后面就永远不会被调用。只有【有手机正在看这个会话】时我们才接管。
	 */
	function onUserQuestion(request, next) {
		const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : ''
		const waiting = askPhone('question', sessionId, {
			questions: Array.isArray(request?.questions) ? request.questions : [],
		}, request?.signal)
		if (waiting === null) {
			/*
			 * 4.14.1：这次没交给手机（多半是**没人正在看这个会话** ✓ —— 用户报"手机上看不见提问"就是这个 ✓）。
			 * 桌面照旧立刻接手 ✓，同时给**所有**在线手机发一条**只有 id** 的提示 ✓ ——
			 * 手机据此显示「另一条会话在等你回答 ✓」，点过去就能看到并**迟到作答** ✓
			 *（那条路在 `handleAnswer` 里 ✓，靠宿主的 `userQuestions.continued` ✓）。
			 */
			const callId = String(request?.wait?.callId ?? '')
			if (callId !== '' && sessionId !== '') pushToAll({ t: 'ask-waiting', sessionId, callId })
			return next()
		}
		return waiting.then((outcome) => {
			if (outcome.kind === 'answer') return outcome.value
			// 请求已作废：调用方早就放弃了，别再往桌面递 —— 那会弹出一个空的问答框。
			if (outcome.kind === 'cancelled') return undefined
			return next()
		})
	}

	/** 手机优先的审批应答者。同上：没手机看着就立刻交还桌面。 */
	function onApprovalRequest(request, next) {
		const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : ''
		const waiting = askPhone('approval', sessionId, {
			toolName: String(request?.toolName ?? ''),
			callId: String(request?.callId ?? ''),
			reason: String(request?.reason ?? ''),
		}, request?.signal)
		if (waiting === null) return next()
		return waiting.then((outcome) => {
			if (outcome.kind === 'answer') return outcome.value
			// 'cancelled' 本身就是合法的 ApprovalOutcome（请求已撤回），
			// 比 undefined 更准确，调用方按"不允许"处理，失败关闭。
			if (outcome.kind === 'cancelled') return 'cancelled'
			return next()
		})
	}

	/** 手机提交的答案。形状在这里校验 —— 畸形数据绝不能塞回 DSH。 */
	/* ---------------------------- 审批记录（2.5.0 遗留的 ③「谁在什么设备上批了什么」） */
	/*
	 * 为什么要它：手机上点头"允许一次"是在**放开权限** ✓ —— 事后总得能回答
	 * "这次是谁批的、从哪台设备批的" ✓（本机 IP 就是设备线索 ✓）。
	 * 落成一行一条 JSONL（`~/.dsh/mobile-bridge.approvals.jsonl` ✓），超 256KB 只留后 200 行 ✓。
	 * **写不进去不许挡住审批本身** ✗ —— 只记一行到 mobile-bridge.log ✓（审计是"事后能查"，
	 * 不是"审批的前置条件" ✓）。
	 */
	const APPROVAL_LOG = 'mobile-bridge.approvals.jsonl'
	const approvalLogFile = () => join(dshHome(), APPROVAL_LOG)

	async function auditApproval(entry) {
		try {
			await appendFile(approvalLogFile(), `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf8')
			const info = await stat(approvalLogFile()).catch(() => null)
			if (info !== null && info.size > 256 * 1024) {
				const text = await readFile(approvalLogFile(), 'utf8')
				await writeFile(approvalLogFile(), `${text.split('\n').filter((line) => line.trim() !== '').slice(-200).join('\n')}\n`, 'utf8')
			}
		} catch {
			record('审批记录写不进去（磁盘或权限？）—— 审批本身没受影响 ✓')
		}
	}

	async function handleApprovals(res, query) {
		const limitRaw = Number(query.get('limit') ?? 50)
		const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50))
		try {
			const text = await readFile(approvalLogFile(), 'utf8')
			const lines = text.split('\n').filter((line) => line.trim() !== '')
			const records = lines.slice(-limit).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((item) => item !== null)
			sendJson(res, 200, { count: records.length, total: lines.length, records })
		} catch {
			// 文件还不存在 = 还没有任何审批 ✓ —— 这不是错误 ✗。
			sendJson(res, 200, { count: 0, total: 0, records: [], note: '还没有审批记录 ✓' })
		}
	}

	/* ----------------- 登录审计 / 陌生设备 / 踢掉设备（2.8.0 ★2「安全审计 + 陌生设备提醒」） */
	/*
	 * 用户要的：「登录历史 ✓；**陌生 IP 第一次登录就通知** ✓；一键踢掉 ✓」。
	 *
	 * 三件事的分工（照 2.5.0 审批记录那套 ✓，**不另造** ✗）：
	 *   · 落盘：`~/.dsh/mobile-bridge.logins.jsonl`，一行一条 `{at, ip, ua, ok, what, firstSeen}` ✓；
	 *   · **陌生设备** = 这个地址**从来没有成功登录过** ✓ —— 失败尝试**不算** ✓
	 *     （否则攻击者先试错一次就把自己洗成"已知设备"，这个提醒就废了 ✗）；
	 *   · 通知：桌面角标 + `mobile-bridge.log` 各一条 ✓，且提示里**写清"走外网时这是隧道那端的地址"** ✓
	 *     （不写清会把用户吓一跳 ✓ —— 手机换 WiFi/流量时地址本来就会变 ✓）。
	 * 超 256KB 只留后 200 行 ✓（照 auditApproval ✓）—— 审计**不许无限长** ✗。
	 */
	const LOGIN_LOG = 'mobile-bridge.logins.jsonl'
	const loginLogFile = () => join(dshHome(), LOGIN_LOG)

	/** 读回登录账（文件不存在 = 还没有任何登录记录 ✓，不是错误 ✗）。 */
	async function readLoginLog() {
		try {
			const text = await readFile(loginLogFile(), 'utf8')
			return text.split('\n').filter((line) => line.trim() !== '')
				.map((line) => { try { return JSON.parse(line) } catch { return null } })
				.filter((item) => item !== null)
		} catch {
			return []
		}
	}

	/**
	 * 记一行登录账。返回这一条（调用方要拿 `firstSeen` ✓）；写不进去返回 `null` ✓ ——
	 * **审计失败绝不挡住登录/拒绝本身** ✗（只往 mobile-bridge.log 记一句 ✓）。
	 */
	async function auditLogin(entry) {
		try {
			const previous = await readLoginLog()
			const known = new Set(previous.filter((item) => item.ok === true).map((item) => String(item.ip ?? '')))
			const hadSuccess = known.size > 0
			const firstSeen = entry.ok === true && known.has(entry.ip) === false
			const line = {
				at: Date.now(),
				ip: String(entry.ip ?? ''),
				ua: String(entry.ua ?? '').slice(0, 120),
				ok: entry.ok === true,
				what: String(entry.what ?? 'login'),
				firstSeen,
			}
			await appendFile(loginLogFile(), `${JSON.stringify(line)}\n`, 'utf8')
			const info = await stat(loginLogFile()).catch(() => null)
			if (info !== null && info.size > 256 * 1024) await trimLoginLog()
			// 报警只在"以前有过成功登录、这个地址没见过"时打 ✓ —— 第一次装机不算"陌生设备" ✗，
			// 否则每个人的第一眼就是一条红字，提醒从此没人看 ✓。
			if (firstSeen && hadSuccess) {
				state.newDevice = { ip: line.ip, at: line.at }
				record(`新设备登录：${line.ip}（走外网时这是隧道那端的地址，不一定等于手机自己的；不是你自己的话，点桌面角标的「踢掉所有手机登录」）`)
			}
			return line
		} catch {
			record('登录记录写不进去（磁盘或权限？）—— 登录本身没受影响 ✓')
			return null
		}
	}

	/**
	 * 账本限长（超 256KB 时只留 200 行 ✓）。
	 *
	 * ⚠️ **成功的那几行优先留** ✓ —— 冷视角复查抓到的洞：原来一律"留最后 200 行"，
	 * 而**错 PIN 也落账**（未认证就能打 ✓），于是约 1300 次错 PIN 就能把真实记录全顶掉，
	 * 面板随即显示"✓ 没有陌生设备" ✗ —— 一个被攻击者造出来的"一切正常" ✓。
	 * 现在：成功的留最近 120 条 ✓（"陌生设备"判定靠的就是它们 ✓），失败只留最近 80 条 ✓。
	 * 仍然是"有限长" ✓，只是把**判定所依赖的那部分**保护起来了 ✓。
	 */
	async function trimLoginLog() {
		const text = await readFile(loginLogFile(), 'utf8')
		const rows = text.split('\n').filter((line) => line.trim() !== '')
		const parsed = rows.map((line) => { try { return { line, item: JSON.parse(line) } } catch { return null } }).filter((row) => row !== null)
		const successes = parsed.filter((row) => row.item.ok === true).slice(-120)
		const failures = parsed.filter((row) => row.item.ok !== true).slice(-80)
		const kept = successes.concat(failures)
			.sort((left, right) => Number(left.item.at ?? 0) - Number(right.item.at ?? 0))
		await writeFile(loginLogFile(), `${kept.map((row) => row.line).join('\n')}\n`, 'utf8')
		return kept.length
	}

	/** 还在有效期内的令牌数（`state.sessions` 里可能留着过期的 —— 只有被用到那一刻才清 ✗）。 */
	function liveTokenCount() {
		const now = Date.now()
		let live = 0
		for (const value of state.sessions.values()) if (Number(value.expiresAt) > now) live += 1
		return live
	}

	/**
	 * 登录历史 / 当前设备（2.8.0 ★2）。
	 *
	 * **要现输 PIN** ✓（`x-dsh-pin` 头，绝不进 URL ✓）—— 和"看电脑剪贴板 / 截图"同一条纪律 ✓：
	 * 这份账里有**这台电脑的网络史**（谁从哪个地址登录过、现在还有几台在线 ✓），
	 * 拿到一个 cookie 就能读走，代价和"cookie 泄漏"不相称 ✓（冷视角复查点名过这一条 ✓）。
	 * 判定"这台手机"用**令牌**而不是 IP ✓：`authed()` 那条 warn-only 路径会把令牌记的来源地址
	 * 改写成调用方当前地址 ✗，于是"IP 相等"几乎恒真 ✓（复查抓到的第 3 条 ✓）——
	 * 令牌是这张表的主键，用它最直白 ✓。
	 */
	async function handleLogins(req, res, query) {
		const limitRaw = Number(query.get('limit') ?? 20)
		const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20))
		const records = await readLoginLog()
		const now = Date.now()
		const mineToken = parseCookies(req.headers.cookie)[COOKIE]
		const devices = []
		for (const [token, value] of state.sessions) {
			if (Number(value.expiresAt) <= now) continue
			devices.push({
				ip: String(value.ip ?? ''),
				expiresAt: Number(value.expiresAt),
				// **绝不回令牌本身** ✗ —— 只回"是不是你正在用的这一张" ✓。
				current: token === mineToken,
			})
		}
		const strangers = records.filter((item) => item.ok === true && item.firstSeen === true)
		sendJson(res, 200, {
			total: records.length,
			count: Math.min(limit, records.length),
			// 最近的在前 ✓（列表第一行就是刚发生的那次 ✓）。
			records: records.slice(-limit).reverse(),
			devices,
			deviceCount: devices.length,
			firstSeenCount: strangers.length,
			lastNewDevice: state.newDevice === null ? null : { ip: state.newDevice.ip, at: state.newDevice.at },
			// 账本被截过就说清 ✓（"只有 200 行"这件事不许瞒着 ✓）。
			trimmed: records.length >= 200,
			note: records.length === 0 ? '还没有登录记录 ✓' : '',
		})
	}

	/**
	 * 手机上的「踢掉其它设备」（2.8.0 ★2）—— **要现输 PIN** ✓。
	 *
	 * 为什么不直接用桌面那个 `/revoke`：那条**只认本机**（loopback ✓ —— 这样即使密钥泄漏，
	 * 外人也无法把你踢下线 ✓），人在外面时够不着 ✓。这一条给手机用，门槛换成
	 * "登录态 + 现输 PIN"（和"删除会话"同级 ✓）：它是**收回**权限 ✗ 不是放宽 ✓，
	 * 但仍然要证明是本人 ✓（否则捡到手机的人能把你自己的其它设备踢掉 ✓）。
	 * 默认**只踢其它** ✓：点一下就把自己也踢下线，用户只会以为按坏了 ✗。
	 */
	async function handleRevokeDevices(req, res) {
		const ip = clientIp(req)
		let body
		try { body = await readBody(req, 4096) } catch { sendJson(res, 400, { error: 'bad request' }); return }
		if (!sameSecret(String(body.pin ?? ''), state.config.pin)) {
			if (!throttleLogin(ip)) {
				sendJson(res, 429, { error: '尝试次数过多，请 10 分钟后再试' })
				return
			}
			warn(`failed PIN attempt (revoke devices) from ${ip}`)
			record(`踢掉其它设备：PIN 不正确 <- ${ip}`)
			noteLoginFailure({ ip, ua: userAgentOf(req), what: 'revoke-devices' })
			sendJson(res, 403, { error: 'PIN 不正确 —— 没有踢掉任何设备' })
			return
		}
		state.attempts.delete(ip)
		const keepSelf = body.all !== true
		const mine = parseCookies(req.headers.cookie)[COOKIE]
		/*
		 * 3.0.0 ★④：**"踢掉全部设备"是唯一把"曾经放行过"清掉的动作** ✓ ——
		 * 它是个显式选择 ✓（"我怀疑设备被偷了，全清" ✓）→ 之后下一次登录**直接放行** ✓
		 * （不然用户会把自己锁在门外 ✗）。只踢"别台"不清这个标记 ✓（本轮那台还在 ✓）。
		 */
		if (keepSelf !== true) {
			state.everApproved = false
			// 3.4.1：**"踢掉全部设备"也是把"放行过的设备"清空的动作** ✓ ——
			// 用户的显式选择（"我怀疑设备被偷了"✓）→ 之后第一台登录**直接放行** ✓（不然把自己锁在门外 ✗）。
			state.devices.clear()
		}
		let revoked = 0
		for (const token of [...state.sessions.keys()]) {
			if (keepSelf && token === mine) continue
			state.sessions.delete(token)
			state.elevated.delete(token)
			revoked += 1
		}
		persistTokens()
		record(`踢掉 ${revoked} 个手机登录 <- ${ip}${keepSelf ? '（保留了当前这台 ✓）' : '（包括当前这台 ✓）'}`)
		// `selfRevoked`：把"你自己这台也被踢了"说明白 ✓（否则页面只会突然跳回登录门 ✓）。
		sendJson(res, 200, { ok: true, revoked, keptSelf: keepSelf, selfRevoked: keepSelf !== true, left: liveTokenCount() })
	}

	async function handleAnswer(req, res) {
		let body
		try { body = await readBody(req, 32 * 1024) } catch { sendJson(res, 400, { error: 'bad request' }); return }
		const id = typeof body?.id === 'string' ? body.id : ''
		const waiter = state.pending.get(id)
		/*
		 * 🔴 4.14.1「迟到作答」✓（用户 2026-10-16：「我看不见你的问题手机端」✓）：
		 * `id` 是**桥上那条活着的等待** ✓ —— 只有手机当时在看这个会话才会有 ✓（所以它 120 秒就没了 ✗）。
		 * 而 `callId` 是**宿主自己那条提问的身份** ✓：超时之后它仍然是 `continued` ✓（还能答 ✓），
		 * 所以手机**回来得晚**也能补答 ✓ —— 这就是"以前能用、后来手机上看不见"最要紧的那一半 ✓。
		 * 两条路的校验各走各的 ✓：活着的走 waiter ✓、迟到的那条**让宿主自己判**（它回 false 就是结束了 ✓）。
		 */
		const lateCallId = typeof body?.callId === 'string' ? body.callId : ''
		if (waiter === undefined && lateCallId !== '') {
			const read = (name) => { try { return ctx.get(name) } catch { return undefined } }
			const agents = read('agents')
			const questions = read('userQuestions')
			if (agents === undefined || questions === undefined || typeof questions.answer !== 'function') {
				sendJson(res, 503, { error: '这台宿主没有「迟到作答」这条路 ✓ —— 请到电脑上回答 ✓' })
				return
			}
			const sessionId = String(body?.sessionId ?? '')
			const agent = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
			if (agent === undefined || agent === null) {
				// 会话没在跑 = 那条提问已经没人接得住了 ✓ —— 如实说，别假装答上了 ✗。
				sendJson(res, 409, { error: '这条会话现在没在跑 ✓ —— 这条提问已经答不了了（到电脑上看看它最后说了什么 ✓）' })
				return
			}
			const rawLate = Array.isArray(body?.answers) ? body.answers : null
			if (rawLate === null) { sendJson(res, 400, { error: '缺少 answers' }); return }
			const lateAnswers = { answers: rawLate.map((item) => ({
				id: String(item?.id ?? ''),
				selected: Array.isArray(item?.selected) ? item.selected.map(String) : [],
				...(typeof item?.custom === 'string' && item.custom !== '' ? { custom: item.custom } : {}),
			})) }
			let accepted = false
			try {
				accepted = questions.answer(agent, lateCallId, lateAnswers) === true
			} catch (error) {
				// 宿主的原话最准（比如"每个问题必须且只能答一次"✓）—— 照实转 ✓，不编 ✗。
				sendJson(res, 409, { error: `这条提问已经答不上了：${String(error?.message ?? error)}` })
				return
			}
			if (accepted !== true) {
				sendJson(res, 409, { error: '这条提问已经结束了（答过了，或会话已经翻篇）✓' })
				return
			}
			record(`answered a late question from the phone (${lateCallId})`)
			sendJson(res, 200, { ok: true, late: true })
			return
		}
		if (waiter === undefined) {
			// 超时了、已经被别的手机答了、或插件重启过 —— 都不是错误，只是卡片过期。
			sendJson(res, 409, { error: '这条提问已经失效（可能超时，或已在别处回答）' })
			return
		}
		let value
		if (waiter.kind === 'question') {
			const raw = Array.isArray(body?.answers) ? body.answers : null
			if (raw === null) { sendJson(res, 400, { error: '缺少 answers' }); return }
			value = {
				answers: raw.map((item) => ({
					id: String(item?.id ?? ''),
					selected: Array.isArray(item?.selected) ? item.selected.map(String) : [],
					...(typeof item?.custom === 'string' && item.custom !== '' ? { custom: item.custom } : {}),
				})),
			}
		} else {
			const outcome = String(body?.outcome ?? '')
			if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled') {
				sendJson(res, 400, { error: 'outcome 必须是 allowed-once / rejected / cancelled' })
				return
			}
			value = outcome
			// ③ 审批记录：**只记审批** ✓（"提问"是另一回事，不进这份账 ✓）。
			// 设备线索就是来源 IP ✓（手机在外网就是隧道那端的地址 ✓）。
			void auditApproval({
				kind: 'approval',
				sessionId: waiter.sessionId ?? null,
				tool: waiter.toolName ?? waiter.payload?.toolName ?? null,
				outcome,
				ip: clientIp(req),
				via: 'phone',
			})
		}
		waiter.answer(value)
		record(`answered a ${waiter.kind} from the phone`)
		sendJson(res, 200, { ok: true })
	}

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
		// Every route lives under the random segment. Failing closed only when the
		// secret is actually present keeps a half-written config from locking the
		// operator out of their own bridge.
		const secret = state.config?.pathSecret
		if (typeof secret === 'string' && secret !== '') {
			const prefix = `/${secret}`
			if (url.pathname === prefix) {
				res.writeHead(302, { location: `${prefix}/` })
				res.end()
				return
			}
			if (!url.pathname.startsWith(`${prefix}/`)) {
				// Logged WITHOUT the path: it is a probe or a typo, and writing the
				// caller's guess down would put whatever they sent into our log.
				record(`${req.method} <no-secret> <- ${clientIp(req)}`)
				sendJson(res, 404, { error: 'not found' })
				return
			}
			url.pathname = url.pathname.slice(prefix.length)
		}
		// gzip 只对认它的客户端开（Safari / Chrome 都认）。sendJson 与页面都看这个标记。
		res.gzipOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
		const route = `${req.method} ${url.pathname}`
		const ip = clientIp(req)
		record(`${route} <- ${ip}`)
		if (authed(req)) rememberHost(req)
		// Every request is logged before authorization, so a bare line is NOT
		// proof it succeeded — that misreading cost real diagnosis time once.
		// Rejections and server errors get their outcome appended.
		//
		// ⚠️ 2026-10-09：原来只记 401 与 5xx，于是 **413（请求体过大）这类"发不出去"
		// 的失败在日志里完全看不见** —— 用户报"手机发图发不出去"时，日志里一行都没有，
		// 只能靠猜。现在 4xx 全记（含 400/403/413/415），排查时一眼能看到结果码。
		res.on('finish', () => {
			if (res.statusCode >= 400) record(`${route} <- ${ip} -> ${res.statusCode}`)
		})

		const guard = () => {
			if (authed(req)) return true
			sendJson(res, 401, { error: 'unauthorized' })
			return false
		}
		// Writes cost the PIN again. A leaked cookie can read history; it cannot make
		// this machine run anything, cancel your work, or start new sessions.
		const guardWrite = () => {
			if (!guard()) return false
			if (elevated(req)) return true
			sendJson(res, 403, { error: '需要重新输入 PIN 才能执行操作', needPin: true })
			return false
		}

		void (async () => {
			try {
				if (route === 'GET /' || route === 'GET /index.html') {
					/*
					 * 用户 2026-10-18：「可以缓存到手机上吗」✓ —— 之前这里是 `no-store` ✗，
					 * 于是**每打开一次就重下整页**（gzip 后 285 KB ✗）。在慢线路上（Funnel 1–2 KB/s ✗）
					 * 那就是永远打不开 ✓；在快线路上也是白花流量 ✓。
					 *
					 * 现在：`no-cache` + **强 ETag** ✓ —— 浏览器**存**页、但每次都来校验 ✓：
					 * 没变就回 **304（几十字节 ✓）**，变了才重下 ✓ —— 既**不会拿到旧页面** ✗，
					 * 又不用重下 ✓。ETag 由**渲染后的整页**算 ✓（版本号/更新历史一变就换 ✓）。
					 */
					const etag = state.pageEtag
					if (etag !== '' && String(req.headers['if-none-match'] ?? '') === etag) {
						res.writeHead(304, {
							etag,
							'cache-control': 'no-cache, must-revalidate',
							'pragma': 'no-cache',
							'expires': '0',
							'x-content-type-options': 'nosniff',
							'referrer-policy': 'no-referrer',
							'x-frame-options': 'DENY',
						})
						res.end()
						return
					}
					res.writeHead(200, {
						'content-type': 'text/html; charset=utf-8',
						// `no-cache` = 可以存、但必须先校验 ✓（`no-store` 是"不许存" ✗，那才导致每次都重下）。
						'cache-control': 'no-cache, must-revalidate',
						'pragma': 'no-cache',
						'expires': '0',
						'x-content-type-options': 'nosniff',
						etag,
						// 密钥路径就在这个 URL 里，绝不能经 Referer 泄漏给第三方
						'referrer-policy': 'no-referrer',
						'x-frame-options': 'DENY',
						// 整页 90 多 KB，手机上每次打开都要真传一遍 —— 启动时压好存着，
						// gzip 之后 20 KB 出头（第二次打开走 304 ✓，一个字节都不用重下 ✓）。
						...(state.pageGzip !== null && res.gzipOk === true
							? { 'content-encoding': 'gzip', 'content-length': state.pageGzip.length }
							: { 'content-length': Buffer.byteLength(state.page) }),
					})
					res.end(state.pageGzip !== null && res.gzipOk === true ? state.pageGzip : state.page)
					return
				}
				if (route === 'POST /api/login') return await handleLogin(req, res)
				if (route === 'POST /api/logout') {
					const token = parseCookies(req.headers.cookie)[COOKIE]
					if (typeof token === 'string') {
						state.sessions.delete(token)
						state.elevated.delete(token)
					}
					persistTokens()
					res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`)
					return sendJson(res, 200, { ok: true })
				}
				if (route === 'GET /api/bootstrap') return guard() ? await handleBootstrap(req, res) : undefined
				if (route === 'GET /api/boot') return guard() ? await handleBoot(req, res, url) : undefined
				if (route === 'GET /api/stream') return guard() ? await handleStream(req, res, url) : undefined
				if (route === 'GET /api/transcript') return guard() ? await handleTranscript(req, res, url) : undefined
				if (route === 'POST /api/prompt') return guardWrite() ? await handlePrompt(req, res) : undefined
				if (route === 'POST /api/clientlog') return guard() ? await handleClientLog(req, res) : undefined
				if (route === 'POST /api/upload') return guardWrite() ? await handleUpload(req, res) : undefined
				if (route === 'POST /api/cancel') return guardWrite() ? await handleCancel(req, res) : undefined
				if (route === 'POST /api/recall') return guardWrite() ? await handleRecall(req, res) : undefined
				if (route === 'POST /api/welcomed') return guard() ? await handleWelcomeSeen(req, res) : undefined
				if (route === 'GET /api/attachment') return guard() ? await handleAttachment(req, res, url) : undefined
				if (route === 'GET /api/media') return guard() ? await handleMedia(req, res, url) : undefined
				if (route === 'GET /api/size') return guard() ? await handleSize(req, res, url) : undefined
				if (route === 'GET /api/file') return guard() ? await handleFile(req, res, url) : undefined
	if (route === 'GET /api/preview') return guard() ? await handlePreview(req, res, url) : undefined
	if (route === 'GET /api/preview/asset') return guard() ? await handlePreviewAsset(req, res, url) : undefined
				if (route === 'GET /api/background') return guard() ? await handleBackground(req, res) : undefined
				// 换背景是**这台电脑**的显示设置（不改任何权限、不指挥 agent），所以只要
				// 登录过就能改；但它是写配置，仍走 guard()，没 PIN 门就不给写。
				if (route === 'POST /api/background') return guard() ? await handleSetBackground(req, res) : undefined
				// 装成 App 的三件套：manifest / 图标 / service worker（都不需要登录态，
				// 因为它们只是静态资源，而且 iOS 取 apple-touch-icon 时不一定带 cookie）。
				if (route === 'GET /manifest.webmanifest') return handleManifest(res)
				if (route === 'GET /sw.js') return handleServiceWorker(res)
				if (url.pathname.endsWith('.png') && ICON_FILES.has(url.pathname.split('/').pop() ?? '')) {
					return handleIcon(req, res, url)
				}
				if (route === 'GET /api/balance') return guard() ? await handleBalance(res, url.searchParams.get('refresh') === '1') : undefined
				if (route === 'GET /api/workspaces') return guard() ? await handleWorkspaces(res) : undefined
				if (route === 'GET /api/system') return guard() ? await handleSystem(res) : undefined
			// 4.5.0：电脑控制 —— 读状态只要登录 ✓；让它动手（音量/亮度/蓝牙）要 PIN 提权 ✓。
			if (route === 'GET /api/pc') return guard() ? await handlePcState(res) : undefined
			if (route === 'POST /api/pc') return guardWrite() ? await handlePcAction(req, res) : undefined
				// 结束进程（2.7.0 ★3）：**只走 guard() + 请求体现输的 PIN**，和"删除会话"同一套纪律 ✓
				// （不用 guardWrite 的"15 分钟内提权过" ✓ —— 见 lib/system.js 的四道闸注释 ✓）。
				if (route === 'POST /api/system/kill') return guard() ? await handleKillProcess(req, res) : undefined
				// 电脑端一键动作（2.7.0 ★4）：读状态（含关机前自检 ✓）+ 执行锁屏/关机/重启/取消 ✓
				if (route === 'GET /api/power') return guard() ? await handlePowerInfo(res) : undefined
				if (route === 'POST /api/power') return guard() ? await handlePower(req, res) : undefined
				/*
				 * 4.13.0「定时开机」✓：读那条只走 `guard()` ✓（它不改任何东西 ✓，而且"到底能不能做到"
				 * 这段实话要能读到 ✓）；设 / 取消走 `guardWrite()` ✓（**让这台机器到点自己动** ✓ ——
				 * 和"关机 / 重启"同一档 ✓），另外再挂配置里的 `powerControl` ✓（默认关 ✓、现读 ✓）。
				 */
				if (route === 'GET /api/pc/wake') return guard() ? await handleWakeInfo(res) : undefined
				if (route === 'POST /api/pc/wake') return guardWrite() ? await handleWakeAction(req, res) : undefined
				// 剪贴板 & 截屏（2.7.0 ★4）：都要登录 ✓；写剪贴板只记日志不额外要 PIN ✓（理由见上面 ✓）
				// 2.7.3：这三样**要现输 PIN** ✓（用户 2026-10-12 的决定 —— 剪贴板可能有密码、屏幕是整屏 ✓）
				if (route === 'GET /api/clipboard') return guard() ? await handleClipboardGet(req, res) : undefined
				if (route === 'POST /api/clipboard') return guard() ? await handleClipboardSet(req, res) : undefined
				if (route === 'GET /api/screen') return guard() ? await handleScreen(req, res) : undefined
				// 3.8.0「屏幕取字」✓：截屏 + OCR 指令 → 交给 agent ✓（要 PIN ✓ —— 在 handler 里走 requirePinOr403 ✓）。
				if (route === 'POST /api/screen/ocr') return guard() ? await handleScreenOcr(req, res) : undefined
				// 4.0.0「录屏遥控」✓：默认关 + 要 PIN + 硬上限（ffmpeg 自己到点停 ✓）。
				if (route === 'POST /api/record') return guard() ? await handleRecord(req, res) : undefined
				// 一键自检（2.8.0 ★1）：**只读诊断**，登录即可 ✓ —— 不要 PIN（它不是"放宽权限" ✓）
				// 3.0.0 ★④「多端授权」：
				//   · `/api/pending` 是**等放行的设备唯一能问的那一条** ✓（`authed()` 对它是 false ✓）；
				//   · `/approve` 与 `/api/devices/pending` **只在本机（loopback）给** ✓ ——
				//     手机（隧道/局域网）打不开 ✓，这是"本人坐在这台电脑前"最接近的凭据 ✓。
				if (route === 'GET /api/pending') return handlePending(req, res)
				if (route === 'GET /approve') return handleApprovePage(req, res, url)
				if (route === 'GET /api/devices/pending') return handlePendingList(req, res)
				if (route === 'GET /api/selfcheck') return guard() ? await handleSelfcheck(res) : undefined
				// 3.1.0 面板协议：清单与静态资源 ✓（清单登录即可 ✓；面板文件由面板自己带 ✓）。
				// 3.4.0 开放接口：**测一次投递**（默认关 ✓、要现输 PIN ✓、出站地址走白名单 ✓）
				if (route === 'POST /api/webhook/test') return guard() ? await handleWebhookTest(req, res) : undefined
				/* 3.4.0：**按需把订阅跑一遍** ✓（改完配置不想重启时的入口 ✓）。
				 * ⚠️ 复查（第 83 轮）R8.2：这里原来写着"热重载**不会**重跑 createBridge"✗ ——
				 * 与同一版里另一处注释正好相反 ✗，**两句都别信** ✓：现在**不赌重载语义** ✓ ——
				 * 自动订阅点已经挪进 `start()`（配置就绪之后 ✓，冷启动/重启/重载都覆盖 ✓），
				 * 这条路由只负责"手动再跑一遍"（幂等 ✓）。 */
				// 用 `guard()`（登录即可 ✓）而不是 `guardWrite()`：它**不改任何配置** ✓ ——
				// 只是拿当前配置重新订阅一遍 ✓（改配置本身仍然是改电脑上的文件 ✓，不是这个路由的权限面 ✓）。
				// 每次调用都会往审计日志写一行（成功说订了哪些 ✓、没配说默认关 ✓、失败说为什么 ✓）。
				if (route === 'POST /api/webhook/subscribe') {
					if (guard() !== true) return undefined
					let note = ''
					try {
						// 复查（第 75 轮）🟡 + 第 83 轮 R3：note **必须是订阅函数的真实结果** ✓ ——
						// 兜底那句原来写成"已按当前配置订阅 ✓" ✗（**假成功** ☠ —— 实测 0 个监听器也报成功 ✓）。
						// 现在：函数不回话就只说"没回话、去查日志" ✓，**绝不说成功** ✗。
						note = subscribeWebhooks() ?? '订阅函数没有回话（内部异常 ✓）—— 请看审计日志 ✗'
					} catch (error) {
						note = '订阅失败：' + String(error?.message ?? error)
					}
					sendJson(res, 200, { ok: true, note })
					return undefined
				}
				if (route === 'GET /api/panels') return guard() ? await handlePanels(res) : undefined
				// 3.3.0 个人知识库：会话全文检索 ✓（登录即可 ✓ —— 搜的是**这台电脑上的**会话内容 ✓）。
				if (route === 'GET /api/knowledge/search') return guard() ? await handleKnowledgeSearch(req, res, url) : undefined
				// 3.3.0：**这周学了什么** ✓ —— 只用已有的会话列表 ✓（不依赖那个本机没开的检索 ✓）。
				if (route === 'GET /api/knowledge/week') return guard() ? await handleKnowledgeWeek(res, url) : undefined
				if (route.startsWith('GET /panel/')) return guard() ? await handlePanelAsset(req, res, url) : undefined
				// 语音转文字（3.0.0 ★③）：读设置登录即可 ✓；转写本身是"把你的话变成文字" ✓，
				// **不改任何东西、也不往会话里加事件** ✓ —— 只有用到**云**识别器时才现输 PIN ✓
				//（那一步音频会离开这台电脑 ✓，闸门在 handler 里按 provider 的位置判 ✓）。
				if (route === 'GET /api/speech') return guard() ? await handleSpeech(res) : undefined
				// 3.5.0 语音优先：麦克风那扇门 ✓（默认关 ✓、开要现输 PIN ✓、有超时上限 ✓）。
				// 3.5.0：把"目标"摆到手机上 ✓（**只读** ✓ —— 会动目标的动作不在这一版里 ✗）。
				if (route === 'GET /api/goal') return guard() ? handleGoal(res, url) : undefined
				if (route === 'GET /api/voice') return guard() ? handleVoice(res) : undefined
				// 3.5.0：语音的**纯核心**发给页面 ✓（一份实现两边共用 ✓，手机动态 import 它 ✓）。
				if (route === 'GET /api/voice/core.js') return guard() ? handleVoiceCore(res) : undefined
				if (route === 'POST /api/voice') return guard() ? await handleVoiceSet(req, res) : undefined
				if (route === 'POST /api/speech/prepare') return guard() ? await handleSpeechPrepare(req, res) : undefined
				if (route === 'POST /api/transcribe') return guard() ? await handleTranscribe(req, res) : undefined
				// 诊断包（2.8.0 ★4）：把日志 / 自检 / 登录账拼成一份**脱敏后**的文本 ✓（登录即可 ✓）。
				if (route === 'GET /api/diag') return guard() ? await handleDiag(res) : undefined
				// 会话导出（2.7.0 ★5）：Markdown 下载（`&info=1` 时只回报条数 ✓）
				if (route === 'GET /api/export/session') return guard() ? await handleExportSession(res, url.searchParams) : undefined
				// 定时任务（2.7.0 ★6）：读（列这份会话的 / 全部 ✓）+ 建/删 ✓（转发给宿主的 schedule 服务 ✓）
				if (route === 'GET /api/schedule') return guard() ? await handleScheduleList(res, url.searchParams) : undefined
				// ⚠️ 2.7.1 冷视角复查 **#1（高）**：**必须 `guardWrite()`** ✓ ——
				// 定时任务是"往某个会话里种一条持久化指令"（到点宿主把它当提示投进去、agent 自主执行 ✓），
				// 而原来只走 `guard()` ✗ → 偷到一个会话 cookie 就能给**任意** sessionId 排任务，
				// 从"只读泄漏"升级成"在你机器上干活"，而且**重启后还在** ✗。和"改权限"同级 ✓。
				if (route === 'POST /api/schedule') return guardWrite() ? await handleScheduleWrite(req, res) : undefined
				// 学习向（2.7.0 ★9）：把转写原文存到电脑 ✓（提纲/复习卡交给会话里的 agent ✓）
				if (route === 'POST /api/note') return guard() ? await handleSaveNote(req, res) : undefined
				// 受限只读链接（2.7.0 ★10）：列表/生成/撤销都要登录 ✓；**客人那一页不要 cookie** ✓（令牌即凭证 ✓）
				if (route === 'GET /api/share') return guard() ? await handleShareList(res) : undefined
				// 4.1.0「分享安装」✓：登录才给 ✓（给的是「你自己拿去转发」的文案 ✓，里面无凭据 ✓）。
				// 4.2.0：`?format=html` 给**网页版**（单文件 ✓，同学直接打开就能读 ✓）。
				if (route === 'GET /api/install') return guard() ? await handleInstallInfo(res, url.searchParams) : undefined
				if (route === 'POST /api/share') return guard() ? await handleShareCreate(req, res) : undefined
				if (route === 'POST /api/share/revoke') return guard() ? await handleShareRevoke(req, res) : undefined
				if (route === 'GET /share') return await handleShareView(req, res, url.searchParams)
				// 3.6.0「分享到桥」（快捷指令那条路 ✓）：**故意不套 `guard()`** ✗ —— 短链没有 cookie ✓，
				// 它的两道闸是"网址里的 pathSecret"✓（全局那一闸：没有就 404 ✓）+"这次请求里的 PIN" ✓
				// （在 handleIntake 里走 `requirePinOr403` ✓ —— 错一次就记一笔账 ✓、同 IP 10 分钟内错满 12 次封 10 分钟 ✓）。
				// 读状态那条仍然要登录 ✓（短链里带密钥段 ✓，绝不白给 ✗）。
				if (route === 'POST /api/intake') return await handleIntake(req, res)
				if (route === 'GET /api/intake') return guard() ? await handleIntakeInfo(res) : undefined
		// 模型目录 / 按会话切模型（2.4.0）：和桌面端同一份目录、同一个接口。
		if (route === 'GET /api/models') return guard() ? await handleModels(res) : undefined
		if (route === 'POST /api/model') return guardWrite() ? await handleSelectModel(req, res) : undefined
				// 权限：读不需要额外证明；写要提权（PIN 门），**收紧到只读除外** ——
				// 那是往安全的方向走，多拦一道只会拦着正在赶紧锁上的人。
				if (route === 'GET /api/permission') return guard() ? await handlePermission(req, res, url) : undefined
				// 3.5.0：**新建任务**那张纸要在会话存在之前就挑权限 ✓（读的是宿主的默认档 + 可选档 ✓）。
				// 这是**另一个资源**（"这台电脑的权限目录" ✓），不是"某个会话的当前档" ✗ ——
				// 所以没并进 `/api/permission`（那条路缺 sessionId 仍然是 400 ✓，契约不变 ✓）。
				if (route === 'GET /api/permission/catalog') return guard() ? await handlePermissionCatalog(res) : undefined
				if (route === 'POST /api/permission') {
					if (!guard()) return undefined
					let body
					try {
						body = await readBody(req, 4096)
					} catch {
						sendJson(res, 400, { error: 'bad request' })
						return undefined
					}
					// 收紧到只读不用再验一次 PIN；其余档位（含放开）必须提权，
					// 否则"捡到解锁手机的人"可以直接把整台机器放开。
					if (String(body.preset ?? '') !== 'read-only' && !elevated(req)) {
						sendJson(res, 403, { error: '改权限需要重新输入 PIN', needPin: true })
						return undefined
					}
					return await handleSetPermission(res, body, req)
				}
				if (route === 'POST /api/session') return guardWrite() ? await handleCreateSession(req, res) : undefined
				// 删除会话（2.6.0）：**只走 guard()（cookie）+ 请求体里现输的 PIN**，
				// 故意不用 guardWrite() 的"15 分钟内提权过" —— 见 handleArchiveSession 里的说明。
				if (route === 'POST /api/session/archive') return guard() ? await handleArchiveSession(req, res) : undefined
				// 回答提问 / 批准操作也算"指挥这台机器"，所以和 prompt 一样要提权：
				// 光有 cookie 不足以让外人替你在批准框上点"允许"。
				/*
				 * 4.14.1：手机的「另一条会话在等你回答」靠这两条 ✓ ——
				 * 读要登录 ✓（正文只在这儿给 ✓，推送帧里只有 id ✗）；作答走 `handleAnswer` 的迟到那支 ✓。
				 */
				if (route === 'GET /api/waiting') return guard() ? sendJson(res, 200, continuedQuestions()) : undefined
				if (route === 'POST /api/answer') return guardWrite() ? await handleAnswer(req, res) : undefined
				// ③ 审批记录（2.5.0 遗留）：只读，登录即可 ✓（"谁在什么设备上批了什么" ✓）
				if (route === 'GET /api/approvals') return guard() ? await handleApprovals(res, url.searchParams) : undefined
				// 安全审计（2.8.0 ★2）：登录历史 + 当前还在登录的设备（**绝不回令牌** ✓）。
				// ⚠️ **要现输 PIN** ✓（走 `x-dsh-pin` 头 —— GET 也不能把 PIN 放进 URL ✓）：
				// 这份账里有这台电脑的网络史 ✓，和"看剪贴板/截图"同一级（冷视角复查点名过 ✓）。
				if (route === 'GET /api/logins') {
					if (!guard()) return undefined
					if (!await requirePinOr403(req, res)) return undefined
					return await handleLogins(req, res, url.searchParams)
				}
				// 踢掉其它设备：**登录 + 现输 PIN** ✓（收回权限不用 loopback，见 handleRevokeDevices ✓）。
				if (route === 'POST /api/logins/revoke') return guard() ? await handleRevokeDevices(req, res) : undefined
				// 一键踢掉所有手机登录。只接受本机（loopback）调用，所以即使密钥泄漏，
				// 外人也无法用它把你踢下线。顺带清掉提权状态。
				if (route === 'POST /api/revoke' || route === 'GET /revoke') {
					if (!isLoopbackPeer(req.socket.remoteAddress ?? '')) {
						sendJson(res, 403, { error: 'only from this machine' })
						return
					}
					const revoked = state.sessions.size
					state.sessions.clear()
					state.elevated.clear()
					persistTokens()
					record(`revoked ${revoked} phone session(s) on request from this machine`)
					if (req.method === 'GET') {
						res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' })
						res.end(`<!doctype html><meta charset="utf-8"><title>已吊销</title><body style="font:15px/1.6 system-ui;padding:24px"><p>已吊销 <b>${revoked}</b> 个手机登录。</p><p>手机上需要重新输入 PIN。</p></body>`)
						return
					}
					return sendJson(res, 200, { ok: true, revoked })
				}
				sendJson(res, 404, { error: 'not found' })
			} catch (error) {
				warn(`route ${route} failed: ${String(error?.stack ?? error)}`)
				if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
				else try { res.end() } catch { /* closed */ }
			}
		})()
	})

	/* --------------------------------------------------------------- start */

	// A raw TCP connection is recorded before any HTTP parsing, so a phone that
	// reaches the port but fails higher up still leaves a trace.
	server.on('connection', (socket) => {
		notePeer(socket.remoteAddress ?? 'unknown', 'tcp connection')
	})

	// This listener is reachable from the internet through the tunnel, so bound
	// everything a slow or hostile peer could hold open. Node's defaults are
	// generous: a 300s request timeout is five minutes of held sockets each.
	// requestTimeout stays well above what a phone needs to upload a 12MB image on
	// cellular, which is exactly what the 32MB body cap exists to allow.
	server.headersTimeout = 20_000
	server.requestTimeout = 180_000
	server.keepAliveTimeout = 5_000
	server.maxHeadersCount = 64
	server.maxConnections = 64

	/* --------- 开放接口：**事件订阅接线**（3.4.0 第二刀）--------- */
	/*
	 * 上游查实（第 61/62 轮 ✓）：宿主有 80 个可监听事件 ✓；写法照本插件 `ctx.effect` 的先例 ✓
	 * （`ctx.on` 返回 disposer ✓ 包进 `ctx.effect` ✓）。
	 *
	 * ⚠️ **只订 `emit` 类事件** ✗：`user-questions/request` / `approval/request` 是 **waterfall** ✓ ——
	 * 订阅它们必须调用 `next()` 并给出决定 ✓，乱订会**干扰宿主自己的流程** ✗（那是最坏的一种 bug ✓）。
	 * 这两个留给下一刀 ✓（要按 waterfall 的规矩写 ✓ 并单独测 ✓）。
	 *
	 * 所以这一刀订的是三个 **emit**：
	 *   · `api-session/status(sessionId, running)` ✓ —— 开始跑 / 跑完了 ✓；
	 *   · `api-session/error(sessionId, message)` ✓ —— 出错了 ✓；
	 *   · `api-session/activity(sessionId, updatedAt)` ✓ —— 有新活动 ✓。
	 *
	 * 铁律 ✓：**默认关** ✗（没配 `webhookUrl` 就一条都不订 ✓）；投递**一次不重试** ✓
	 * （重试会把"对方挂了"放大成雪崩 ✓ —— 要重试得有退避与上限，那是下一刀 ✓），
	 * 失败**如实记一行** ✓（不静默丢 ✗）；正文**不带会话内容** ✗。
	 */
	const WEBHOOK_EVENTS = ['api-session/status', 'api-session/error', 'api-session/activity']
	/** 复查（第 83 轮）R2：只探响应体的**前一小块** ✓（够回答"正文空不空" ✓，不会把 32MB 读进内存 ✗）。 */
	const WEBHOOK_BODY_PROBE = 1024

	/** 事件参数 → 我们的载荷字段 ✓（每个事件的形状不同 ✓ → 一对一映射 ✓，不猜 ✗）。 */
	function webhookDataOf(name, args) {
		if (name === 'api-session/status') return { sessionId: String(args[0] ?? ''), running: args[1] === true }
		if (name === 'api-session/error') return { sessionId: String(args[0] ?? ''), message: String(args[1] ?? '').slice(0, 300) }
		/* ⚠️ 复查（第 83 轮）R13：这里原来写成 `at` ✗ —— 而 `buildWebhookPayload` **只认 now** ✓，
		 * 于是"活动真正发生的时间"被静默换成"投递时刻" ✗，字段名还一样、对方根本看不出来 ✓。
		 * 现在放成独立字段 `updatedAt` ✓（`at` 保持"投递时刻"的口径 ✓，与 README 表格一致 ✓）。 */
		if (name === 'api-session/activity') return { sessionId: String(args[0] ?? ''), updatedAt: Number(args[1] ?? 0) }
		return {}
	}

	/** 投递一次 ✓（fire-and-forget ✓ —— 失败只记一行 ✓，绝不 await 进宿主的调用栈 ✗）。 */
	function deliverWebhook(name, data) {
		const allowed = allowWebhookUrl(webhookConfig().url)
		if (allowed.ok !== true) return
		const payload = buildWebhookPayload(name, data, Date.now())
		const text = JSON.stringify(payload)
		const headers = webhookHeaders(name, webhookConfig().secret, text, payload.at)
		void fetch(allowed.url, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(8000), redirect: 'manual' })
			.then(async (response) => {
				if (response.status < 200 || response.status >= 300) {
					record(`webhook 投递被拒：${name} → ${new URL(allowed.url).host} (${response.status})`)
					return
				}
				/*
				 * 复查（第 75 轮）🟡：原来 **2xx 就当成功** ✓ —— 而 `302` 能把 POST 降级成 GET 且丢正文 ✓
				 * （复查实测 `bytes:0` ✓）。加 `redirect:'manual'` 之后 3xx 会落进上面那条 ✓。
				 *
				 * ⚠️ 复查（第 83 轮）在同一个地方又抓到三件事 ✓：
				 *  · **R2**：`await response.text()` **没有上限** ✗ —— 实测一条 200 + 32MB 正文就能把
				 *    宿主进程 RSS 从 65MB 顶到 187MB ✓（8s 超时只管"时间" ✓ 不管"体积" ✗）→
				 *    改成**只读第一块** ✓（`readFirstChunk` ✓，读完立刻 `cancel()` ✓）。
				 *  · **R4**：原来那个 `moved`（"地址被改写"）**只会误报** ✗ —— `redirect:'manual'` 下
				 *    3xx 已被上面拦住 ✓、真重定向 URL 不会变 ✓；反而带 `#片段` 的正常 200 会被记成
				 *    "被改写 ✗"（复查实测 ✓）。**删掉** ✓，口径写清："manual 下 URL 不会变" ✓。
				 *  · **R9**：`204`（README 自己示例就是它 ✓）是**规范意义上的成功且没有正文** ✓ ——
				 *    对它报"正文为空、说不准"是把正常当异常 ✗ → `204` 不记 ✓；
				 *    只有"2xx + 空正文 + **不是** 204"才记一行 ✓（保住 ③ 要的那半 ✓、不淹掉真信号 ✓）。
				 */
				const probe = await readFirstChunk(response, WEBHOOK_BODY_PROBE)
				if (response.status !== 204 && probe === '') {
					record(`webhook 投递：${name} → ${new URL(allowed.url).host} (${response.status}) **正文为空** ✓（对方没回内容：收没收到说不准 ✓ 这里只如实记一行 ✓）`)
				}
			})
			.catch((error) => {
				const raw = String(error?.message ?? error)
				// R7：fetch 对带凭据的 URL 会抛 TypeError，**message 里带着原 URL** ✗ → 别原样记 ✓。
				const reason = /includes credentials/.test(raw) ? '地址里带了用户名/密码（去掉 https://user:pass@ 那一段 ✓）' : raw.slice(0, 60)
				record(`webhook 投递失败：${name} → ${new URL(allowed.url).host}（${reason}）`)
			})
	}

	/**
	 * 只取响应体的**第一块** ✓（复查第 83 轮 R2）—— 目的只是回答"正文空不空" ✓，
	 * 绝不能为了这个把整个响应体读进内存 ✗（32MB 就能把宿主顶掉 ✓）。读完立刻 `cancel()` ✓。
	 */
	async function readFirstChunk(response, cap) {
		const reader = response.body?.getReader?.()
		if (reader === undefined) return ''
		try {
			const { done, value } = await reader.read()
			if (done === true || value === undefined) return ''
			return Buffer.from(value).toString('utf8').slice(0, cap)
		} catch {
			// 读不到就当"读不到" ✓（下面会按"正文为空 + 不是 204"记一行 ✓，不假装成功 ✗）。
			return ''
		} finally {
			try { await reader.cancel() } catch { /* 无所谓 */ }
		}
	}

	/**
	 * webhook 的配置**现读文件** ✓ —— 与 `deviceApprovalEnabled()` / `panelsEnabled()` 同一口径 ✓。
	 *
	 * ⚠️ 为什么必须这样 ✗（第 70 轮实测抓到的真因 ✓）：原来 `subscribeWebhooks()` 读的是
	 * `state.config?.webhookUrl` ✓ —— 那是**启动那一刻的快照** ✓ → 启动之后改配置文件，
	 * 它**看不见** ✓（手机上"改了配置却没生效"就是这么来的 ✓，而别的开关都能即时生效 ✓）。
	 * 现在：读 `state.configFile` ✓；读不到就退回内存快照 ✓（**不假装**：退回时会照旧用它 ✓）。
	 */
	function webhookConfig() {
		/*
		 * ⚠️ 复查（第 75 轮）🟡：原来的 catch **退回启动快照** ✗ →
		 * "把配置文件删掉 / 写坏 JSON，它**还在往外发**" ✓，而且**没有一行日志**说"退回旧配置" ✗
		 * —— 用户明明已经把配置删了 ✓，却还在投递 ✓（最难接受的那种静默 ✓）。
		 * 修法 ✓：**fail-closed** —— 只要 `state.configFile` 已经就绪（非空 ✓）而读/解析失败 ✓，
		 * 就**按"关"处理**（空 url / 空 secret ✓）并 `record` 一行 ✓。
		 * 只有"还没就绪"（启动早期 ✓，`configFile === ''` ✓）才用内存快照 —— 那时它是最新的 ✓。
		 */
		const fromSnapshot = () => ({
			url: typeof state.config?.webhookUrl === 'string' ? state.config.webhookUrl : '',
			secret: typeof state.config?.webhookSecret === 'string' ? state.config.webhookSecret : '',
			events: Array.isArray(state.config?.webhookEvents) ? state.config.webhookEvents : [],
		})
		if (typeof state.configFile !== 'string' || state.configFile === '') return fromSnapshot()
		try {
			const stored = JSON.parse(readFileSync(state.configFile, 'utf8'))
			return {
				url: typeof stored?.webhookUrl === 'string' ? stored.webhookUrl : '',
				secret: typeof stored?.webhookSecret === 'string' ? stored.webhookSecret : '',
				events: Array.isArray(stored?.webhookEvents) ? stored.webhookEvents : [],
			}
		} catch (error) {
			/*
			 * 文件在、但读不到/不是 JSON ✓ → **按关处理** ✓（绝不拿旧配置继续发 ✗），并留下一行证据 ✓。
			 * ⚠️ 复查（第 83 轮）R5：**不要把 `error.message` 整段记进来** ✗ —— V8 的 JSON 报错会
			 * 把出错位置附近约 10 个字**原样带进 message** ✓（实测：配置写坏时 `webhookSecret` 的尾部
			 * 会跟着进 `mobile-bridge.log` ✓、再随 `/api/diag` 发出去 ✗）。所以只留
			 * `code`（ENOENT ✓）或 `name`（SyntaxError ✓）这类**不带内容**的信息 ✓。
			 */
			try { record(`webhook：配置读不出来（${String(error?.code ?? error?.name ?? 'error')}）—— 按【关】处理 ✓（不拿旧配置继续发 ✗）`) } catch { /* 记账失败也不能反过来放行 */ }
			return { url: '', secret: '', events: [] }
		}
	}
	let webhookEffectDisposer = null

	/**
	 * ⚠️ **幂等** ✗（第 73 轮自查）：这个函数会被调多次（启动、按需订阅接口 ✓）——
	 * 每调一次就多挂一套监听器的话 ✓，同一条事件会被**投递多次** ✗
	 *（而且热重载/反复配置都会放大它 ✓）。所以：**先撤掉上一次的订阅** ✓ 再挂新的 ✓。
	 */
	function subscribeWebhooks() {
		try { webhookEffectDisposer?.() } catch { /* 撤不掉也无所谓，下面会覆盖引用 */ }
		webhookEffectDisposer = null
		const cfg = webhookConfig()
		const allowed = allowWebhookUrl(cfg.url)
		if (allowed.ok !== true) {
			/* ⚠️ 这里原来只用 `log()` ✓ —— 而 `log()` 走 **console.log**（DSH 控制台 ✓），
			 * 审计文件 `mobile-bridge.log` 里**看不到** ✗ → 所以改用 `record()` ✓：
			 * "webhook 开没开"正是审计日志该回答的问题 ✓。
			 * ⚠️ 复查（第 83 轮）🟠 R3：这里原来只 `return`（**不回话**）✗ → 路由那行
			 * `subscribeWebhooks() ?? '已按当前配置订阅 ✓'` 的兜底就成了**假成功** ✗
			 * （实测：0 个监听器，用户却看到"已订阅 ✓"✗）。现在**返回一句真话** ✓ ——
			 * 日志 / 回包 / 事实三者一致 ✓。 */
			const msg = '没配 webhookUrl —— 默认关 ✓，一个都没订 ✗（在 ~/.dsh/mobile-bridge.json 里加上 webhookUrl 再来调一次 ✓）'
			record('webhook：' + msg)
			return msg
		}
		const configured = Array.isArray(cfg.events) && cfg.events.length > 0 ? cfg.events : WEBHOOK_EVENTS
		/* ⚠️ 复查（第 83 轮）R6：必须**去重** ✓ ——
		 * `webhookEvents: ["api-session/status","api-session/status"]` 会给同一条事件挂**两个**监听器 ✓、
		 * 一次事件投两次 ✓（复查实测 ✓，最短的"投递风暴"路径 ✓）。 */
		const wanted = [...new Set(configured.filter((name) => WEBHOOK_EVENTS.includes(name)))]
		const dropped = configured.length - wanted.length
			if (wanted.length === 0) {
				/* 复查（第 75 轮）🟡：`webhookEvents: ["bogus"]` → 过滤后 0 个监听器 ✓
				 * 而路由还回 200「已按当前配置订阅」✗ → 用户以为订上了 ✓ 实际零订阅零投递零日志 ✗。
				 * 现在：**如实说出来** ✓（审计日志一行 + 回包带上原因 ✓），并提示可选值 ✓。 */
				const msg = 'webhookEvents 过滤后没有匹配的事件 —— 一个都没订 ✗（可选：' + WEBHOOK_EVENTS.join('、') + ' ✓）'
				record('webhook：' + msg)
				return msg
			}
		webhookEffectDisposer = ctx.effect(() => {
			const offs = wanted.map((name) => ctx.on(name, (...args) => { deliverWebhook(name, webhookDataOf(name, args)) }))
			return () => { for (const off of offs) { try { off?.() } catch { /* 无所谓 */ } } }
		}, 'mobile-bridge:webhook')
		/* 复查（第 75 轮）🟡：CHANGELOG 说「审计日志能查开没开 / 订了哪些」 ✓ ——
		 * 但成功这条只走 `log()`（= console.log ✓），审计文件里查不到 ✗。
		 * 与其把文档改弱 ✗，不如**让代码兑现承诺** ✓：成功也记一行 ✓（含订了哪几个 ✓、目标主机 ✓）。
		 * 复查（第 83 轮）R6：配置里被丢掉/重复的项也**如实说一句** ✓（别让用户以为都订上了 ✗）。 */
		const target = new URL(allowed.url).host
		record(`webhook：已订阅 ${wanted.join('、')} → ${target}`
			+ (dropped > 0 ? `（配置里有 ${dropped} 项重复或不在可选范围 ✓ 只订一次 ✓）` : ''))
		log(`webhook：已订阅 ${wanted.join('、')} → ${target}`)
		return `已按当前配置订阅 ✓（${wanted.join('、')} → ${target} ✓）`
	}

	/*
	 * 3.4.0 订阅**不在这里做** ✗ —— 复查（第 83 轮）🔴 R1：这里是 `createBridge()` 的顶层 ✓，
	 * 跑在 `start()` **之前** ✓，那一刻 `state.config === null` / `state.configFile === ''` /
	 * `state.accessLog === ''` ✓ → 配置只能读到空 url ✓、走"没配"分支 ✓、连那行日志都被静默丢掉 ✗
	 * → **冷启动/重启后一个监听器都没有** ✗（实测：listeners=0、hits=0、日志零行 ✓；
	 * 只有手工 POST 一次 `/api/webhook/subscribe` 才有救 ✓ —— 而那正是用户不会做的事 ✗）。
	 * 现在改到 `start()` 里、**配置与审计日志都就绪之后**再订 ✓（见 `start()` 里那一刀 ✓）。
	 * "热重载会不会重跑"这件事不用赌 ✓：真重跑就重订一次（`subscribeWebhooks` 幂等 ✓），
	 * 不重跑也有 `start()` 那一刀 ✓。
	 */

	async function start() {
		const { config, file } = await loadConfig()
		state.config = config
		state.tokenTtlMs = config.tokenTtlHours * 60 * 60 * 1000
		state.elevationMs = config.elevationMinutes * 60 * 1000
		state.configFile = file
		// The page tag lets a phone that stayed open across a server restart
		// notice that its UI is stale and reload itself.
		const rawPage = await readFile(PAGE_FILE, 'utf8')
		state.pageTag = createHash('sha256').update(rawPage).digest('hex').slice(0, 12)
		/*
		 * ⚠️ 这里必须用 **replaceAll**，不是 replace。
		 *
		 * `String.replace(字符串, …)` 只换**第一处**：页面标签在源文件里出现两次（HTML 注释
		 * + 客户端脚本），版本标记也出现两次（登录页 + 说明页）—— 只换第一处的结果是
		 * "说明页上摆着一串 __DSH_BRIDGE_VERSION__"给用户看。这个坑是写版本说明时被
		 * ui 测试里那条"页面里不许漏出注入标记"当场抓到的。
		 */
		state.page = rawPage
			.replaceAll(PAGE_TAG_MARKER, state.pageTag)
			/*
			 * 开始页上的版本说明（用户要求「开始页加入版本说明」）。
			 *
			 * 版本号与"最近更新"都从插件自己的文件里现读（package.json / CHANGELOG.md），
			 * 不在这儿手抄一份 —— 手抄的那份迟早会和实际发布的对不上，而版本号恰恰是
			 * 排查"你到底装的是哪一版"的唯一可靠依据。
			 *
			 * 更新清单用 **JSON** 注入、在客户端用 textContent 建节点（不拼 HTML）：
			 * CHANGELOG 是我们自己的文本，但"把文本当 HTML 塞进页面"这种事一次都别做。
			 */
			.replaceAll(VERSION_MARKER, String(bridgeVersion()).replace(/[&<>"]/g, (ch) => (
				{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
			)))
			/*
			 * 更新清单走 `<script type="application/json">`：只需要把 `<` 换成 `\u003c`
			 * （JSON 里合法、且能挡住 `</script>`），不要再做 HTML 转义 —— 那会把引号
			 * 变成 `&quot;`，JSON 直接解析不了。
			 */
			.replaceAll(WHATSNEW_MARKER, JSON.stringify(whatsNew()).replace(/</g, '\\u003c'))
			// 主题汇总（"要汇总，不要一版版罗列"）：同样走 JSON，客户端用 textContent 建节点。
			.replaceAll(THEMES_MARKER, JSON.stringify(WHATS_NEW_THEMES).replace(/</g, '\\u003c'))
			// 4.4.0：按"代"的总结 ✓ + 5.0 预告 ✓（同上：只注入数据 ✓，画由页面画 ✓）。
			.replaceAll(ERAS_MARKER, JSON.stringify(WHATS_NEW_ERAS).replace(/</g, '\\u003c'))
			.replaceAll(NEXTUP_MARKER, JSON.stringify(WHATS_NEW_NEXT).replace(/</g, '\\u003c'))
		state.pageEtag = '"page-' + createHash('sha256').update(state.page).digest('hex').slice(0, 16) + '"'
		try {
			state.pageGzip = gzipSync(Buffer.from(state.page, 'utf8'))
		} catch {
			state.pageGzip = null
		}

		state.accessLog = join(dshHome(), ACCESS_LOG)
		try {
			const info = await stat(state.accessLog)
			if (info.size > ACCESS_LOG_LIMIT) await unlink(state.accessLog)
			// 已有体积也要记进来，否则记账从 0 开始、运行期那一层限长会晚一整轮才生效。
			else state.accessLogBytes = info.size
		} catch { /* no log yet */ }
		record(`listener starting on 0.0.0.0:${config.port}`)

		/*
		 * 3.4.0 订阅 ✓ —— **必须在配置与审计日志都就绪之后** ✗（复查第 83 轮 R1 🔴）：
		 * 冷启动 / 重启 / 热重载都靠这一刀把订阅挂上 ✓（以前它跑在 `createBridge` 顶层、早于这里 ✓
		 * → 配了 `webhookUrl` 也一个监听器都不挂 ✗，而且一行日志都没有 ✗）。
		 * 幂等 ✓（`subscribeWebhooks` 先撤旧的再挂新的 ✓）；失败**写进审计日志** ✓，不静默 ✗。
		 */
		try { subscribeWebhooks() } catch (error) { record(`webhook 订阅失败：${String(error?.message ?? error).slice(0, 120)}`) }

		// 顺手清掉上次留下的"传了一半"的残片（手机上行不稳时的常态）。后台跑，不挡启动。
		void sweepStaleParts()

		await loadTokens()

		await new Promise((resolve, reject) => {
			server.once('error', reject)
			server.listen(config.port, '0.0.0.0', () => {
				server.removeListener('error', reject)
				state.listening = true
				resolve()
			})
		})

		const addresses = lanAddresses(config.phoneHost ?? '')
		log(`listening on 0.0.0.0:${config.port}, PIN ${config.pin}`)
		/*
		 * 🔴 5.0.1：**有固定外网地址就先打它** ✓（用户 2026-10-19 踩的坑 ✓）。
		 * 手机"加到主屏幕"的那条网址如果写的是局域网 IP ✗ —— 校园 WiFi 一漫游 / 一续租就换 IP ✓，
		 * 旧网址连不上 ✓，而手机那边**什么都推不过去**（它根本到不了桥 ✓）→ 表现就是「又登不上去了」✓。
		 * 所以：有 `publicUrl` 时先打那条**地址固定**的 ✓，局域网那几行标清楚"会变" ✓。
		 */
		if (typeof config.publicUrl === 'string' && config.publicUrl !== '') {
			log(`phone url: ${withSecret(config, config.publicUrl)}  (外网 · 地址固定 ✓ 推荐加到主屏幕)`)
		}
		for (const entry of addresses) log(`phone url: http://${entry.address}:${config.port}/  (${entry.interface} · 局域网，本机 IP 一变就失效)`)
		if (addresses.length === 0) warn('no non-loopback IPv4 address found; the phone cannot reach this host yet')
		const drift = phoneHostDrift(config)
		if (drift !== null) {
			warn(`上次手机连上的地址 ${drift.remembered} 现在不属于这台机器了（换 WiFi / DHCP 换 IP）`
				+ ' —— 手机上存着那个旧地址的网址会打不开（桥这边收不到请求）✓；'
				+ '恢复办法：用桌面徽标的二维码重新打开一次，或者改用上面那条固定的外网地址 ✓')
		}

		installBadge(ctx, config, () => state.recentFailures.length, record, () => state.newDevice, state.tunnel)
	}

	function stop() {
		for (const entry of state.streams) {
			try { entry.controller.abort() } catch { /* already gone */ }
			try { entry.res.end() } catch { /* already closed */ }
		}
		state.streams.clear()
		// 挂起的提问必须放行：不放行等于把 agent 永久卡死在一个等不到答案的
		// waterfall 上（插件重载时尤其明显）。
		for (const waiter of [...state.pending.values()]) {
			try { waiter.cancel() } catch { /* already settled */ }
		}
		state.pending.clear()
		state.sessions.clear()
		if (state.listening) {
			state.listening = false
			try { server.close() } catch { /* already closed */ }
			// server.close() 只停止【接受新连接】：已经建立起来的 keep-alive 连接
			// 会继续被这个【会话已清空】的实例服务，于是返回莫名的 401 —— 手机
			// 复用连接时就表现为"刚重载完又让我输 PIN"。必须显式踢掉它们。
			// （插件重载就是这么工作的：旧 fiber 停、新 fiber 起，同一个端口。）
			try { server.closeIdleConnections?.() } catch { /* older node */ }
			try { server.closeAllConnections?.() } catch { /* older node */ }
		}
		log('stopped')
	}

	return { start, stop, onUserQuestion, onApprovalRequest }
}

/* ------------------------------------------------------------ desktop hint */

/**
 * A one-line badge in the desktop GUI so the URL and PIN are discoverable
 * without reading files. Inline styles only, outside `#root`, so React cannot
 * be affected by it.
 *
 * The tap runs on every index response, so the address list is recomputed each
 * time: switching to a hotspot or USB tethering adds a reachable address that
 * appears without restarting the server.
 *
 * `record` 必须由调用方传进来：这个函数是**模块级**的，而日志器 `record()` 定义在
 * `createBridge` 里面。直接在这里写 `record(...)` 会抛 ReferenceError，而本函数是在
 * `start()` 的最后一行被调用的 —— 一抛就打断整个 start：**角标消失、隧道自检也永不启动**。
 * （这个坑真踩过：236 条测试全绿，因为它压根没覆盖到角标这条路径。）
 */
function installBadge(ctx, config, failureCount, record, newDeviceInfo, tunnelState) {
	const web = ctx.get('webServer')
	if (web === undefined || typeof web.tapIndex !== 'function') {
		// 明说为什么没有角标。以前这里静默 return，于是"界面上没有那个蓝条"
		// 完全无从查起 —— 而隧道自检也跟着不跑。
		record('desktop badge skipped: this composition has no webServer.tapIndex')
		return
	}
	record('desktop badge installed')

	// tunnel-start.ps1 rewrites `publicUrl` in the config file every time the tunnel
	// restarts (quick-tunnel hostnames are not stable). The badge is the only place
	// that URL is surfaced, so re-read it on each index response — a cached copy
	// would quietly send the phone to a dead host.
	const configPath = join(dshHome(), CONFIG_FILE)
	const refreshPublicUrl = () => {
		try {
			const stored = JSON.parse(readFileSync(configPath, 'utf8'))
			const next = typeof stored.publicUrl === 'string' && /^https:\/\/[^\s"'<>]+$/.test(stored.publicUrl)
				? stored.publicUrl
				: ''
			if (next !== (config.publicUrl ?? '')) config.publicUrl = next
		} catch {
			// Missing or half-written file: keep the last known value, say nothing.
		}
	}

	// 隧道死活要自己探，不能等用户撞上去才知道。免费隧道的网址每次重启都会变，
	// 旧网址静默失效 —— 徽标上那条"外网地址"就成了一句假话，而用户直到掏出手机
	// 打不开才反应过来。
	//
	// 这份状态**由外面传进来** ✓（`state.tunnel`）：`/api/selfcheck` 与 `/api/diag`
	// 也要读它 ✓ —— 2026-10-12 就是因为这里是个局部变量，配了外网的机器上自检整条 500 ✗。
	const tunnel = tunnelState ?? { ok: null, fails: 0, at: 0, probedUrl: '', probe: null }
	/** 5.0.1：上一次报过的那条"地址变了" ✓ —— 只在变化时报一次（别每 2 分钟刷一行 ✗）。 */
	let lastDriftLogged = ''
	const probeTunnel = async () => {
		refreshPublicUrl()
		// 🔴 5.0.1：每 2 分钟看一次"上次手机连上的地址还属于本机吗" ✓（今天 20:15 就是在运行中变的 ✓）——
		// 只**说**不**改** ✓（原因见 `phoneHostDrift` 的注释 ✓）；变化只在第一次报，别每 2 分钟刷一行 ✗。
		const drift = phoneHostDrift(config)
		const driftLine = drift === null ? '' : String(drift.remembered)
		if (driftLine !== lastDriftLogged) {
			lastDriftLogged = driftLine
			if (driftLine !== '') {
				record(`上次手机连上的地址 ${driftLine} 现在不属于这台机器了（换 WiFi / DHCP 换 IP）`
					+ ' —— 手机上存着旧地址的网址会打不开；用桌面徽标二维码重开一次，或改用固定外网地址 ✓')
			}
		}
		const target = typeof config.publicUrl === 'string' ? config.publicUrl : ''
		// 没配外网 = **没得探** ✓ —— 状态回到 `null`（"没测过"），**不是** `true`（"可达"）✗。
		// 这里踩过一次：初版在没配外网时置了 `true`，于是后来配上外网、自检却拿着那条旧结论说
		// "外网可达 ✓" —— 一次都没探过 ✓（harness 里当场红 ✓）。
		if (target === '') {
			tunnel.ok = null
			tunnel.fails = 0
			tunnel.at = Date.now()
			tunnel.probedUrl = ''
			tunnel.mode = ''
			tunnel.address = ''
			tunnel.detail = ''
			return
		}
		const fullUrl = withSecret(config, target)
		let parsed = null
		try { parsed = new URL(fullUrl) } catch { parsed = null }
		if (parsed === null) {
			tunnel.ok = null
			tunnel.fails = 0
			tunnel.at = Date.now()
			tunnel.probedUrl = fullUrl
			tunnel.mode = 'bad-url'
			tunnel.detail = 'publicUrl 不是合法地址'
			return
		}
		const hostname = parsed.hostname
		const port = parsed.port === '' ? 443 : Number(parsed.port)
		const requestPath = `${parsed.pathname}${parsed.search}`
		/*
		 * 🔴 5.0.3：**先看本机解析出来的是不是 tailnet 地址** ✓ ——
		 * 是 ⇒ 只是 MagicDNS 抄近路（`*.ts.net` → 100.x ✓），必须换公网 DNS 拿到真 ingress 再探 ✓；
		 * 不是 ⇒ 本机解析到的就是公网入口 ✓，照旧直接 fetch（那就是外网路径 ✓）。
		 */
		const local = await systemAddresses(hostname)
		const magicDnsShortcut = local.length > 0 && local.every((address) => isTailnetAddress(address))
		let reachable = false
		let detail = ''
		const mode = magicDnsShortcut ? 'external-ingress' : 'external'
		let address = local[0] ?? ''
		if (magicDnsShortcut) {
			const ingress = await resolvePublicAddresses(hostname)
			if (ingress.length === 0) {
				// ⚠️ 公网 DNS 也不通 ⇒ **不测就不许说可达** ✗（宁可说"没法验证" ✓）。
				tunnel.ok = null
				tunnel.fails = 0
				tunnel.at = Date.now()
				tunnel.probedUrl = fullUrl
				tunnel.mode = 'unverifiable'
				tunnel.address = ''
				tunnel.detail = '本机解析走 MagicDNS、公网 DNS 也不通，没法验证外网入口'
				record('tunnel self-check cannot verify the public entry: this PC resolves the public host through MagicDNS, '
					+ 'and public DNS is unreachable from here (the phone may still be fine; run tools\\tunnel-status.ps1)')
				return
			}
			address = ingress[0]
			const result = await probeExternalEntry({ hostname, address, port, path: requestPath })
			reachable = result.ok
			detail = result.detail
		} else {
			try {
				// 只要 Cloudflare 把请求转到了本机，隧道就是活的（哪怕是 404）。
				// 隧道死了会拿到 5xx 错误页，或者根本连不上。
				const res = await fetch(fullUrl, {
					redirect: 'manual',
					signal: AbortSignal.timeout(8000),
				})
				reachable = res.status < 500
				detail = `HTTP ${res.status}`
			} catch (error) {
				reachable = false
				detail = String(error?.code ?? error?.name ?? error?.message ?? error)
			}
		}
		// 只记失败次数，别在这里就把 ok 置真 —— 否则下面那条"恢复了"永远不触发
		// （ok 已经被这一行改回去了，`tunnel.ok === false` 不可能成立）。
		if (reachable) tunnel.fails = 0
		else tunnel.fails += 1
		// 探过就得记时间与**探的是哪个地址** ✓：免费隧道每次重启都换域名 ✓，
		// 换了就得重新探（拿旧结论说新地址可达，就是我们最不想要的那种假话 ✗）。
		tunnel.at = Date.now()
		tunnel.probedUrl = fullUrl
		tunnel.mode = mode
		tunnel.address = address
		tunnel.detail = detail
		// 一次成功就立刻说通 ✓（原来要等 fails 归零那条分支，中间有一段"已经通了还报不通" ✓）。
		if (tunnel.fails === 0 && tunnel.ok !== true) {
			tunnel.ok = true
			record(`tunnel is reachable again (verified ${mode === 'external-ingress' ? `through the real public entry ${address}` : 'over the public path'})`)
		}
		if (tunnel.fails >= 2 && tunnel.ok !== false) {
			tunnel.ok = false
			// 必须用 record()（写进 mobile-bridge.log）。log()/warn() 只到 stdout/stderr，
			// 而 DSH 不捕获它们 —— 把"隧道断了"这种要人命的消息说到没人看的地方，
			// 等于没说。
			/*
			 * 🔴 4.16.1（用户 2026-10-17：「为什么隧道断了？」✓）：**别过度断言** ✗ ——
			 * 探针在这台电脑上跑 ✓，DNS/网络抖一下也会失败 ✓，所以**不能**说死"手机连不上" ✗。
			 * 🔴 5.0.3：但现在**测的路不一样了** ✓ —— 本机走 MagicDNS 时，探的是
			 * **公网 ingress IP** ✓（`probeExternalEntry` ✓），失败指向"入口真的坏了" ✓；
			 * 所以除了保留"手机可能仍能连" ✓，还要**给出修法**：重开 Funnel ✓。
			 */
			record('tunnel self-check failed from this PC: the probe could not reach the public entry point '
				+ `(${detail}; ${mode === 'external-ingress' ? `tried the real ingress ${address}` : 'normal DNS path'}). `
				+ 'The phone may still be fine (a DNS/network hiccup on this machine is enough) — '
				+ `if the phone cannot connect, re-open Funnel on this PC: tailscale funnel --bg ${config.port} `
				+ '(see tools\\tunnel-status.ps1 for the itemized result)')
		}
	}
	// 把探测函数**登记到共享状态上** ✓：手机点 🩺 时就能现探一次 ✓
	// （冷视角复查抓到的第二个洞：没这一条时，`webServer` 缺失的组合里根本没人探过隧道，
	// 而自检却敢说"外网可达 ✓" ✗ —— 现在登记了函数，"没测过"还能被当场测掉 ✓）。
	tunnel.probe = probeTunnel


	try {
		ctx.effect(() => {
			const timer = setInterval(() => { probeTunnel().catch(() => {}) }, 120000)
			probeTunnel().catch(() => {})
			return () => clearInterval(timer)
		}, 'mobile-bridge:tunnel-probe')

		// ⚠️ 复审（第 83 轮 N2）：这段注释原来写"热重载**不**重跑 start、所以订阅只能挂 apply 路径" ✗ ——
		// **与事实相反** ✓：cordis 的 fiber 重载/重启是 dispose 之后**重跑 apply** ✓ → 那条 effect 里的
		// `createBridge()` **和** `start()` 都会再跑一遍 ✓（线上日志里 `listener starting` 出现 66 次 ✓
		// 就是证据 ✓，含 20 秒间隔的那几次 ✓）。所以订阅放在 `start()` 里**同时覆盖**冷启动 / 重启 / 热重载 ✓
		//（见那一刀的注释 ✓）；这里**不再放任何"以为重载不会跑"的逻辑** ✗。
		//
		// ⚠️⚠️ 必须**自己 try/catch 并 record** ✗：这一整段外面那个 catch 只 `console.error` ✓
		// → 订阅里任何一次抛错都会被**静默吞掉**（既不进审计日志 ✓、手机上也无感 ✓）——
		// 第 65–67 轮我查了三次"为什么日志里没有那行" ✗，根因就是它 ✓。
		// 现在：失败会**明确写进 mobile-bridge.log** ✓（"读不到就说读不到" ✓，订阅不上也要说 ✓）。
		/*
		 * ⚠️ **这里不再调 `subscribeWebhooks()`** ✓ —— 自动订阅点在 `start()` 里（配置就绪之后 ✓，
		 * 见那一刀的注释 ✓）。
		 * ⚠️ 复查（第 83 轮）R8.1：这一段原来引用的行号（5958 / 5993）**全是错的** ✗ ——
		 * **代码注释里不写行号** ✓（一改就过期 ✓，而"过期注释"比没有注释更坏 ✗），只写函数名与位置关系 ✓：
		 * `subscribeWebhooks()` 就定义在 `handleWebhookTest` 所在的那个外层函数里 ✓（`state` 可见 ✓、
		 * 也写得进审计日志 ✓）；第 65–68 轮踩的那个坑（`subscribeWebhooks is not defined` 被外层 catch
		 * **静默吞掉** ✗，查了三轮才看见 ✓）靠两条解决 ✓：**放进同一作用域** ✓ + **自己 try/catch 并 `record`** ✓
		 *（失败会明确写进 `mobile-bridge.log` ✓，不再"静默无声" ✓）。
		 */
	} catch (error) {
		console.error(`[mobile-bridge] tunnel probe skipped: ${String(error?.message ?? error)}`)
	}

	const render = () => {
		refreshPublicUrl()
		const addresses = lanAddresses(config.phoneHost ?? '')
		const primary = addresses[0]
		const others = addresses.slice(1)
		const escapes = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
		const remote = typeof config.publicUrl === 'string' && config.publicUrl !== '' ? config.publicUrl : ''
		// The tunnel answers "reach me from anywhere", so it leads when it is set.
		// Its URL changes whenever the tunnel restarts, which is exactly why it is
		// surfaced here instead of living only in a log file.
		const remoteLine = remote === ''
			? ''
			: tunnel.ok === false
				// 4.16.1：**不许把"本机探不通"说成"手机连不上"** ✗（本机 DNS/网络抖一下也会失败 ✓）。
				// 5.0.3：但现在探的是**公网入口 IP** ✓（MagicDNS 近路已绕开 ✓）——
				// 失败基本就是入口真坏了 ✓，所以除了解释，直接给修法（重开 Funnel ✓）。
				? `🌍 外网 <b>${escapes(withSecret(config, remote))}</b> <span style="color:#ffd0d0;font-weight:700">⚠️ 外网入口不通（本机走公网入口 IP 也连不上）—— 在电脑上跑 <code>tailscale funnel --bg ${config.port}</code> 重开一次；手机可能仍能连（本机网络问题也会这样）</span><br>`
				: tunnel.mode === 'unverifiable'
					? `🌍 外网 <b>${escapes(withSecret(config, remote))}</b> <span style="color:#ffe0a8;font-weight:700">⚠️ 没法从本机验证外网入口（本机 MagicDNS 走近路、公网 DNS 也不通）—— 手机连不上就重开一次 Funnel</span><br>`
					: `🌍 外网 <b>${escapes(withSecret(config, remote))}</b><br>`
		// The badge used to disappear on any click, which made it impossible to
		// select the URL it exists to show: clicking to start a selection removed it.
		// Text stays selectable now and hiding is an explicit ✕ in the corner.
		/*
		 * 地址卡（2.7.0 ★2「地址卡 + 二维码」）：
		 *   · 码里编的是**手机该打开的那个完整地址**（带密钥段 ✓）—— 扫一次直接进，不用手输 ✓；
		 *   · **隧道断了就不编外网地址** ✗：编一个扫了也打不开的码，比没有更糟 ✓
		 *     （★2 的硬要求："地址来源要实测可用再显示"）；这时改编局域网地址并说明白 ✓；
		 *   · 二维码**本地生成**（`lib/qr.js` ✓、零依赖 ✓）—— 绝不把带密钥段的地址发给
		 *     在线二维码服务 ✗✗（那等于把密钥送出去 ✓）。
		 */
		const lanUrl = primary === undefined ? '' : withSecret(config, describeAddress(primary, config.port).url)
		const externalUrl = remote === '' ? '' : withSecret(config, remote)
		const qrTarget = externalUrl !== '' && tunnel.ok !== false ? externalUrl : lanUrl
		const qrNote = qrTarget === ''
			? '<div style="color:#ffd0d0">现在没有可用地址：插数据线开「USB 网络共享」，或把隧道拉起来。</div>'
			: (qrTarget === externalUrl && externalUrl !== ''
				? '<div style="opacity:.85">外网地址 —— 手机在任何网络下都能打开</div>'
				: '<div style="opacity:.85">局域网地址 —— 手机连同一个 WiFi 时可用</div>')
		const cardBody = [
			'<div style="font-weight:700">📷 扫码进手机端</div>',
			qrTarget === ''
				? ''
				: `<div style="background:#fff;border-radius:10px;padding:8px;margin:8px 0;display:inline-block;line-height:0">${qrSvg(qrTarget, { scale: 5 })}</div>`,
			qrNote,
			qrTarget === '' ? '' : `<div style="margin-top:6px">${escapes(qrTarget)}</div>`,
			`<div style="margin-top:8px">PIN <b>${escapes(config.pin)}</b>（第一次打开要输它）</div>`,
			tunnel.ok === false && externalUrl !== ''
				? `<div style="color:#ffd0d0;margin-top:6px">⚠️ 外网入口当前不通（本机走公网入口也连不上）—— 在电脑上跑 <code>tailscale funnel --bg ${config.port}</code> 重开一次；这个码先走局域网</div>`
				: '',
		].join('')
		const cardToggle = '<span id="dsh-mobile-bridge-card-toggle" style="cursor:pointer;text-decoration:underline;color:#cfe0ff">📷 地址卡（扫码）</span>'

		const shell = (body) => [
			'<div id="dsh-mobile-bridge-badge" style="position:fixed;left:12px;bottom:12px;z-index:2147483000;',
			'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dbe4ff;background:rgba(43,63,214,.94);',
			'border-radius:10px;padding:9px 30px 9px 13px;box-shadow:0 6px 20px rgba(0,0,0,.35);',
			'user-select:text;-webkit-user-select:text;cursor:auto;',
			'max-width:min(92vw,620px);word-break:break-all;line-height:1.6">',
			body,
			'<span id="dsh-mobile-bridge-hide" title="隐藏（刷新页面后重新出现）" style="position:absolute;top:3px;right:7px;cursor:pointer;opacity:.65;font-size:14px;line-height:1;padding:2px 5px">&#10005;</span>',
			'</div>',
			// 地址卡（2.7.0 ★2）：点一下把二维码摊开，手机扫一次就进 ✓
			'<div id="dsh-mobile-bridge-card" style="display:none;position:fixed;left:12px;bottom:96px;z-index:2147483001;',
			'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#dbe4ff;background:rgba(24,34,84,.97);',
			'border-radius:12px;padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,.45);max-width:min(92vw,340px)">',
			cardBody,
			'<div style="margin-top:8px"><span id="dsh-mobile-bridge-card-close" style="cursor:pointer;text-decoration:underline;opacity:.85">收起</span></div>',
			'</div>',
			'<script>(function(){',
			'var h=document.getElementById("dsh-mobile-bridge-hide");',
			'if(h){h.addEventListener("click",function(e){e.stopPropagation();var b=document.getElementById("dsh-mobile-bridge-badge");var c=document.getElementById("dsh-mobile-bridge-card");if(b){b.remove()}if(c){c.remove()}});}',
			'var t=document.getElementById("dsh-mobile-bridge-card-toggle");',
			'var c=document.getElementById("dsh-mobile-bridge-card");',
			'if(t&&c){t.addEventListener("click",function(e){e.stopPropagation();c.style.display=(c.style.display==="none"?"block":"none")});}',
			'var x=document.getElementById("dsh-mobile-bridge-card-close");',
			'if(x&&c){x.addEventListener("click",function(e){e.stopPropagation();c.style.display="none"});}',
			'})();</script>',
		].join('')

		if (primary === undefined) {
			return shell([
				remote === ''
					? '📱 手机端：没有找到可用的局域网地址（网线/热点都没连？）'
					: `${remoteLine}<span style="opacity:.85">PIN <b>${escapes(config.pin)}</b> · 局域网地址暂时没有</span>`,
				`<div>${cardToggle}</div>`,
			].join(''))
		}
		const { url: baseUrl, label } = describeAddress(primary, config.port)
		const url = withSecret(config, baseUrl)
		// Visibility is half of security: if someone is grinding at the PIN, the
		// operator should see it without going to look for it.
		const failures = typeof failureCount === 'function' ? failureCount() : 0
		const alarm = failures >= 3
			? `<br><span style="color:#ffd0d0;font-weight:700">有人正在试 PIN：最近 ${Math.round(LOGIN_WINDOW_MS / 60000)} 分钟内 ${failures} 次失败</span>`
			: ''
		/*
		 * 2.8.0 ★2「陌生设备提醒」：新地址**第一次成功登录**就在这儿说一声 ✓。
		 * 只挂 24 小时 ✓ —— 一条警报挂一整年，等于没有警报 ✗。
		 * 话里必须带那句"走外网时这是隧道那端的地址" ✓：手机换 WiFi/流量本来就会变地址，
		 * 不写清的话，用户会以为家里进了人 ✓。
		 */
		const seenDevice = typeof newDeviceInfo === 'function' ? newDeviceInfo() : null
		const deviceAlarm = seenDevice !== null && seenDevice !== undefined
			&& Number.isFinite(Number(seenDevice.at)) && Date.now() - Number(seenDevice.at) < 24 * 3600 * 1000
			? `<br><span style="color:#ffe0a8;font-weight:700">🆕 新设备 ${escapes(String(seenDevice.ip ?? '?'))} 登录过（${escapes(new Date(Number(seenDevice.at)).toLocaleString())}）</span>`
				+ '<br><span style="opacity:.85">手机换 WiFi / 切流量时地址本来就会变；走外网时这是<b>隧道那端</b>的地址，不一定是手机自己的。不是你自己的话，点下面「踢掉所有手机登录」。</span>'
			: ''
		const alt = others.length > 0
			? '备用 ' + others.map((entry) => `${escapes(entry.address)} (${escapes(entry.interface)})`).join(' / ')
			: ''
		// Nothing directly phone-facing and no phone has ever reached us: say what
		// is missing rather than leaving a campus address that will not work.
		const hint = primary.direct === true || primary.learned === true
			? ''
			: '<br><span style="opacity:.75">还没有直连链路：插数据线并在手机上开启「USB 网络共享」/ 个人热点</span>'
		/*
		 * 🔴 5.0.1：**把"地址会变"写在徽标上** ✓（用户 2026-10-19 就是被这个坑掉的 ✓）。
		 * 手机上"加到主屏幕"的网址如果是局域网 IP ✗ —— 换 WiFi / DHCP 续租一换 IP ✓ 就再也打不开 ✓，
		 * 而手机那边连不上时**没有任何办法把新地址推过去** ✗。所以有固定外网地址就直接指它 ✓。
		 */
		const stability = remote === ''
			? '<br><span style="opacity:.8">⚠️ 这条局域网地址会变（换 WiFi / DHCP 续租）—— 手机上的旧地址会打不开；换 IP 后扫下面二维码重新打开，或配一条固定的外网地址（Tailscale Funnel）</span>'
			: '<br><span style="opacity:.8">✅ 上面那条「外网」地址是**固定**的 —— 手机加到主屏幕请用它（下面这条局域网地址会随 IP 变 ✗）</span>'
		// 🔴 5.0.1：**上次手机连上的地址已经不属于本机** → 直接点名 ✓（不是吓人：手机那边确实会打不开 ✓）。
		const drift = phoneHostDrift(config)
		const driftLine = drift === null
			? ''
			: `<br><span style="color:#ffd0a8">⚠️ 上次手机连上的地址 ${escapes(drift.remembered)} 本机已经没有了（换 WiFi / IP 变了）—— 手机上存着它的旧网址会打不开；扫下面二维码重开一次，或把固定外网地址加到主屏幕</span>`
		return shell([
			remoteLine,
			`📱 局域网 <b>${escapes(url)}</b><br>`,
			`<span style="opacity:.85">${escapes(label)} · PIN <b>${escapes(config.pin)}</b>`,
			alt === '' ? '' : `<br>${alt}`,
			hint,
			stability,
			driftLine,
			alarm,
			deviceAlarm,
			'</span>',
			`<div>${cardToggle}</div>`,
			`<a href="http://127.0.0.1:${config.port}/${config.pathSecret}/revoke" target="_blank" onclick="event.stopPropagation()" style="color:#ffc9c9;display:inline-block;margin-top:5px;text-decoration:underline">踢掉所有手机登录</a>`,
		].join(''))
	}

	try {
		ctx.effect(
			() => web.tapIndex((html) => {
				const badge = render()
				return html.includes('</body>') ? html.replace('</body>', `${badge}</body>`) : html + badge
			}),
			'mobile-bridge:desktop-badge',
		)
	} catch (error) {
		console.error(`[mobile-bridge] badge injection skipped: ${String(error?.message ?? error)}`)
	}
}

/* ------------------------------------------------------------------- apply */

export function apply(ctx) {
	// 崩溃探针 —— 默认【关闭】。
	//
	// 它当初是为了抓"宿主每隔几分钟静默死亡"：把 uncaughtException 和 exit 事件写进
	// ~/.dsh/dsh-crash.log。那两个 bug（record 重名遮蔽、route 的 TDZ）已经定位并修好，
	// 日志里之后只剩心跳。
	//
	// 之所以默认关：这段代码跑在【宿主进程】里 —— 它会注册全局异常处理器、每 30 秒写盘，
	// 早期版本甚至猴补丁改写 process.exit。对一个装给别人用的插件来说，这是不该有的
	// 副作用。要在这台机器上排查新的静默死亡，往 ~/.dsh/mobile-bridge.json 加一行
	// "crashProbe": true 再重启即可。
	let crashProbe = false
	try {
		crashProbe = JSON.parse(readFileSync(join(dshHome(), CONFIG_FILE), 'utf8')).crashProbe === true
	} catch { /* 没有配置文件 = 不开探针 */ }

	if (crashProbe) {
		const crashLog = join(dshHome(), 'dsh-crash.log')
		// 这两个处理器必须【同步】写盘：下一行就是 process.exit(1)，异步 appendFile 会在
		// 写入落盘前就被杀掉 —— 探针曾因此整整一轮只记下"我调用了 exit"，没有异常本身。
		const burp = (kind, detail) => {
			try {
				appendFileSync(crashLog, `${new Date().toISOString()} [${process.pid}] ${kind}: ${detail}\n`)
			} catch { /* 记录失败也不能改变退出行为 */ }
		}
		const onRejection = (reason) => {
			burp('unhandledRejection', `${String(reason?.stack ?? reason)}`)
			process.exit(1)
		}
		const onException = (error) => {
			burp('uncaughtException', `${String(error?.stack ?? error)}`)
			process.exit(1)
		}
		// 静默死亡只有两种可能：显式 process.exit，或者被外部杀掉。'exit' 事件只在前者
		// 触发（TerminateProcess 不触发），有它就足以分辨 —— 不需要去猴补丁 process.exit。
		const onExit = (code) => {
			try { appendFileSync(crashLog, `${new Date().toISOString()} [${process.pid}] exit-event code=${code}\n`) } catch { /* ignore */ }
		}
		process.on('unhandledRejection', onRejection)
		process.on('uncaughtException', onException)
		process.on('exit', onExit)
		// 心跳带内存占用：如果是几小时后慢慢涨到 OOM，这条能看出来。
		const beat = setInterval(() => {
			const mb = Math.round(process.memoryUsage().rss / 1048576)
			try { appendFileSync(crashLog, `${new Date().toISOString()} [${process.pid}] heartbeat: alive rss=${mb}MB\n`) } catch { /* ignore */ }
		}, 30000)
		ctx.effect(() => () => {
			process.removeListener('unhandledRejection', onRejection)
			process.removeListener('uncaughtException', onException)
			process.removeListener('exit', onExit)
			clearInterval(beat)
		}, 'mobile-bridge:crash-probe')
	}

	ctx.effect(() => {
		const bridge = createBridge(ctx)
		// 应答者必须【prepend】在官方 api-remotes 之前。waterfall 是顺序的：排到
		// 它后面就永远不会被调用 —— 官方那一环会一直等到浏览器作答为止。
		const offQuestion = ctx.on('user-questions/request',
			(request, next) => bridge.onUserQuestion(request, next), { prepend: true })
		const offApproval = ctx.on('approval/request',
			(request, next) => bridge.onApprovalRequest(request, next), { prepend: true })
		bridge.start().catch((error) => {
			/*
			 * 端口被占是【重启 / 升级之后】最可能撞上的那一个：上一份 DSH 还没退干净，
			 * 3081 还握在它手里。原始栈对用户毫无用处，所以额外给一句能照着做的人话；
			 * 栈照旧原样留着（真要排障时它是唯一依据）。
			 */
			const busy = error?.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(error?.message ?? ''))
			/*
			 * 提示**英文在前、中文在后**：Windows 控制台默认是 GBK，纯中文那版在窗口/日志里
			 * 会显示成乱码（实测）。英文那行任何编码下都读得懂，中文那行留给看得懂的人。
			 */
			const hint = busy
				? '\n  → Port busy: another DSH is probably still holding it (or two are running).'
					+ '\n  → Fix: stop the other DSH first (desktop shortcut "停止 DeepSeek Harness"), then start again;'
					+ ' or change "port" in ~/.dsh/mobile-bridge.json.'
					+ '\n  → 端口被占用：多半是上一份 DSH 还没退干净，或者同时开着两份。'
					+ '\n  → 处理：先停干净再开，或者改 ~/.dsh/mobile-bridge.json 里的 "port" 换一个端口。'
					+ '\n  → 这一份插件已被跳过，手机现在连不上；上面这条修好、重启 DSH 即可恢复。'
				: ''
			const text = `${String(error?.stack ?? error)}${hint}`
			console.error(`[mobile-bridge] failed to start: ${text}`)
			// DSH's stderr is not captured anywhere readable, so a start failure
			// would otherwise be invisible. This file is diagnostic only.
			appendFile(join(dshHome(), 'mobile-bridge-start-error.log'),
				`${new Date().toISOString()} ${text}\n`).catch(() => {})
		})
		return () => {
			offQuestion()
			offApproval()
			return bridge.stop()
		}
	}, 'mobile-bridge:listener')
}

// Exported for the security regression suite (test/security.mjs). The throttle key
// is the most security-critical decision in this file, so it is asserted directly
// with synthetic requests rather than only through live ones.
export { clientIp, isLoopbackPeer }
