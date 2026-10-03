# dsh-plugin-mobile-bridge

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的手机端桥接插件：
> **在手机上导入图片、下发任务、实时看输出**，从同一个 WiFi、USB 共享、或者外网隧道都行。

在电脑上跑 DSH，在手机上用。不用装 App，打开浏览器就是控制台。

---

## 它能做什么

- **手机直接发图**（截图、拍的照片）给 DSH，不用再经过微信/QQ 中转
- **新建任务、下发指令、取消运行**，实时看思考过程和工具调用
- **按会话回看**历史，支持长文本长按复制
- **余额查询**（配合余额插件的同一份凭据）
- **地址自动排序**：USB 共享 / 蓝牙 PAN / 个人热点 / 局域网，哪个能通就把哪个排前面
- **外网可达**：附带 Cloudflare 隧道脚本，任何网络都能连（不需要公网 IP、不用改路由器）

---

## 安装

**前置条件**：你得先有一个能正常运行的 DSH —— 这是个扩展插件，不是独立程序。需要 Node 22 以上（用的都是内置模块，没有构建步骤）。

### 1. 装插件

```bash
# 从 GitHub 安装（`link:` 只接受本地路径，网址要用 git+https 或 github: 简写）
dsh plugin --profile web add git+https://github.com/jxboop/dsh-plugin-mobile-bridge.git

# 等价写法
dsh plugin --profile web add github:jxboop/dsh-plugin-mobile-bridge

# 从本地目录（改代码时用）
dsh plugin --profile web add link:/path/to/dsh-plugin-mobile-bridge
```

装完**重启 DSH**，日志里会出现：

```
[mobile-bridge] listening on 0.0.0.0:3081, PIN 123456
[mobile-bridge] phone url: http://192.168.1.20:3081/ab12cd34ef56ab78/  (WLAN)
```

### 更新到最新版

**把上面那条安装命令原样再跑一遍就行**，不需要先卸载：

```bash
dsh plugin --profile web add github:jxboop/dsh-plugin-mobile-bridge
```

然后重启 DSH。（`dsh plugin` 是 pnpm 的转发器；对分支形式的 git 依赖，`add` 会重新解析到最新提交。实测 0.2.2 → 0.3.0 可直接升级。）想确认装到了哪一版：看 `<profile>/node_modules/dsh-plugin-mobile-bridge/package.json` 的 `version`。

### 2. 首次启动会自动生成配置

`~/.dsh/mobile-bridge.json`（Windows：`%USERPROFILE%\.dsh\mobile-bridge.json`）：

```json
{
  "version": 1,
  "port": 3081,
  "pin": "123456",
  "pathSecret": "ab12cd34ef56ab78",
  "tokenTtlHours": 12,
  "bindTokenToIp": false,
  "elevationMinutes": 15
}
```

**`pin` 和 `pathSecret` 都是自动生成的，别外传。** 在 DSH 界面左下角的徽标上能直接看到完整网址和 PIN。

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | 3081 | 监听端口 |
| `pin` | 随机 6 位 | 登录密码 |
| `pathSecret` | 随机 16 位十六进制 | **所有路由都藏在这个随机段后面**，没有它一律 404 |
| `tokenTtlHours` | 12 | 登录令牌有效期（上限 14 天） |
| `bindTokenToIp` | false | 是否**严格**绑定令牌的来源 IP。默认 `false`：地址变化只**记录告警**（在 `/api/bootstrap` 的 `foreignUses` 里可见），不吊销登录。设 `true` 则换地址即吊销 —— **移动网络下不可用**（运营商 NAT、IPv6 隐私扩展会不停换地址，手机会被反复踢下线），只适合固定网络 |
| `elevationMinutes` | 15 | 输一次 PIN 后，多久内可以"指挥 DSH 干活" |
| `crashProbe` | false | **排查用，平时别开。** 设为 `true` 会把宿主的 uncaughtException / exit 事件写进 `~/.dsh/dsh-crash.log`（含每 30 秒一条内存心跳）。它跑在宿主进程里、会注册全局处理器并持续写盘，所以默认关闭。 |
| `answerOnPhone` | false | 让**手机**回答 agent 的提问（`ask_user_question`）和工具审批。默认关：开着时"正在看这个会话的手机"会抢在桌面前面拿到提问，桌面要等 120 秒才轮到。没有手机在看这个会话时，无论开关如何都是桌面先拿到。 |

### 为什么过一会儿又让我输 PIN？

这是设计如此，不是掉线。手机上有两种状态：

- **已登录**（有 cookie）：能看会话列表和聊天记录。令牌默认 12 小时有效，所以**重启电脑、重启 DSH 都不会把你踢出去**。
- **已提权**（最近输过一次 PIN）：才能让这台电脑干活 —— 下发任务、取消、新建会话。

**提权默认只保持 15 分钟**（`elevationMinutes`），过期后第一次动手会重新弹出 PIN 门；宿主重启后恢复的会话同样不带提权。觉得输得太勤就把它调大，上限 240 分钟：

```json
{ "elevationMinutes": 240 }
```

> 如果你看到"需要重新输入 PIN"却找不到输入框，那是 0.2.0 及更早版本的 bug（页面只认 401、不认服务器用来表达提权的 `403 + needPin`，于是提示了却没有门）。**0.2.1 起已修复**：过期时页面会直接把 PIN 门打开。


### 3. 放行防火墙（Windows）

首次启动会弹 Windows 防火墙提示。**只勾"专用网络"**即可（手机和电脑在同一 WiFi 时够用）。若要走外网隧道，勾"公用网络"。

---

## 外网访问（可选）

局域网之外也能连。`tools/` 下有一套脚本，用的是 Cloudflare 免费快速隧道：**不需要公网 IP、不需要改路由器、不需要注册账号**。

```powershell
# 1. 下载 cloudflared.exe 放到 tools/ 目录
#    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe

# 2. 启动隧道（会打印完整网址并复制到剪贴板）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\tunnel-start.ps1

# 3. 不用时关掉
powershell -NoProfile -ExecutionPolicy Bypass -File tools\tunnel-stop.ps1
```

其它工具：

| 脚本 | 用途 |
|---|---|
| `tools/tunnel-status.ps1` | **体检**：隧道现在是死是活（进程、端口、外网实测），手机上出现错误页时先跑它 |
| `tools/show-phone-url.ps1` | 一个可复制的小窗口，显示外网/局域网网址 + PIN（带刷新按钮） |
| `tools/revoke-phone.ps1` | **应急**：一键吊销所有手机登录（两步确认，防误触） |

### 在手机上回答 agent 的提问

agent 卡在 `ask_user_question` 上等你选，或者某个工具调用需要你点头时，**手机上会直接出现一张卡片**：选项按钮、可多选、也能自己写一段话；审批则是「允许一次 / 拒绝」两个键。答完 agent 立刻继续，不用你跑回电脑前面。

默认关闭，打开方式：

```json
{ "answerOnPhone": true }
```

打开后改配置需**重启 DSH**（或重载插件）生效。

**它怎么决定谁来答：**

| 情况 | 谁作答 |
|---|---|
| 有手机正在看着这个会话 | **手机**（桌面等 120 秒才轮到，防手机没答导致卡死） |
| 没有手机在看这个会话 | **桌面**，和我们没插手时一模一样 |
| 手机答了，别的手机也开着 | 先答的算数，其余卡片自动撤掉 |

**几个已经处理好的细节：**

- **答案要提权**：和下发任务一样，光有 cookie 不够，得最近输过 PIN —— 否则偷走 cookie 的人能替你在批准框上点"允许"。
- **同一个提问不能答两次**：用过的 id 立刻失效。
- **手机刷新不会丢卡片**：新开的流会把还没答的提问补推一次。
- **问题文本来自模型，一律当纯文本渲染**（`textContent`，不是 `innerHTML`），模型塞不进脚本。

### 手机上是 Cloudflare 错误页？（Error 1033 / 1016）

**这两个错都不是插件的问题，而是隧道没了。**

| 错误 | 含义 |
|---|---|
| **1033** Cloudflare Tunnel error | 这个主机名**曾经**是一条隧道，但现在没有任何隧道连着它 |
| **1016** Origin DNS error | 这个主机名已经**完全解析不到**了（隧道早就没了） |

**最常见的两个原因：**

1. **免费快速隧道的网址，每次 cloudflared 重启都会换一个。** 旧网址**永久失效，救不回来** —— 不是"过一会儿就好"，是那个域名再也不属于你了。手机上收藏的旧网址永远打不开。
2. **跑隧道的电脑睡眠 / 休眠 / 合盖了**，或者换了网络、被安全软件或加速器掐掉了连接 —— 隧道随之中断。

**怎么办：**

```powershell
# 先体检：一眼看出是进程没了、端口没起、还是网址失效
powershell -NoProfile -ExecutionPolicy Bypass -File tools\tunnel-status.ps1

# 网址失效就重拿一个（先停再起，确保拿到全新的）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\tunnel-stop.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\tunnel-start.ps1
```

`tunnel-start.ps1` 会**真的从外网打开一次**再告诉你成功了 —— 如果它说"没能通过外网验证"，那就是**现在把网址给手机也没用**，直接照它列的原因排查，别浪费时间。

想要**一个永不变的网址**，只有两条路：Cloudflare **命名隧道**（要有自己的域名 + 账号），或者用 **Tailscale / ZeroTier** 这类组网工具（推荐：地址固定、端到端加密、且完全不暴露到公网）。

> ⚠️ 免费快速隧道的**网址每次重启都会变**，而且是一条**公开网址** —— 拿到的人都能看到 PIN 登录页。手机桥有 PIN 认证和限速兜着，但**别把网址发到群里**。

---

## 安全模型

这个桥可以经隧道暴露到公网，所以"安全"必须是**能验证**的，不是一句承诺。

### 已实施的防护

| 防护 | 说明 |
|---|---|
| **随机路径前缀** | 所有路由藏在 `/<pathSecret>/` 后面。无密钥路径一律 404 |
| **限速的钥匙不可伪造** | 只在 socket 对端是 loopback（即自家 cloudflared）时才读转发头；`cf-connecting-ip` 优先，`x-forwarded-for` 取**最后一段**（自家代理追加的），**绝不取第一段**（那是调用方可控的） |
| **两级登录限速** | 每地址 12 次/10 分钟 + **所有人合计** 60 次/10 分钟 |
| **令牌绑定来源 IP** | 偷走的 cookie 换一台机器就是废纸 |
| **写操作需要再验 PIN** | cookie 只能**读**；下发指令/取消/新建会话需要 15 分钟内输过一次 PIN |
| **Cookie `Secure` 条件化** | HTTPS 下带 `Secure`，明文 HTTP 下不带（否则局域网登录会静默失效） |
| **令牌 12 小时过期** | 上限 14 天，`/api/logout` 立即吊销 |
| **SSE 连接上限** | `MAX_LIVE_STREAMS = 6`，超限 503 |
| **网络层超时与连接上限** | `headersTimeout 20s`（挡 slowloris）、`requestTimeout 180s`、`maxConnections 64` |
| **统一安全响应头** | `nosniff`、`X-Frame-Options: DENY`、`cache-control: no-store`、**`Referrer-Policy: no-referrer`**（防止密钥路径经 Referer 泄漏） |
| **不回显内部错误** | 细节只进日志，不回给调用方 |
| **探测留痕但密钥不落盘** | 无密钥请求记为 `GET <no-secret> <- ip`；日志里永远不出现密钥路径 |

### 怎么验证（请自己跑）

```bash
node test/security.mjs
```

50 项断言：限速钥匙的单元断言、密钥路径门禁、每个接口的未授权拒绝、限速生效、cookie 标志、令牌有效期、注销吊销、响应头、SSE 上限、附件不泄漏、日志脱敏。退出码非 0 即有失败。

要连**真实 Cloudflare 边缘**一起验（会消耗本机出口 IP 的登录额度，10 分钟后自愈）：

```powershell
$env:BRIDGE_TUNNEL_URL='https://<你的隧道域名>'
node test/security.mjs
```

其它测试。先装一次测试依赖（`jsdom`，只有 UI 测试用它；插件本身零运行时依赖）：

```bash
npm install
```

| 文件 | 内容 | 需要 |
|---|---|---|
| `test/crashprobe.mjs` | 崩溃探针开关：默认不碰宿主全局状态、开启后能在配置重写中存活（17 项） | — |
| `test/harness.mjs` | 桥的端到端行为：PIN 门、cookie、prompt 组装、SSE 扇出、取消、附件、新建会话、余额缓存、重启保活（含"恢复的会话可读但不可写 = 403+needPin"）、注销，以及**手机作答全链路**（提问推送到流上 / POST api/answer 收答案 / 防重放 / 审批 outcome 校验）（59 项） | — |
| `test/ui.mjs` | 手机页面的 DOM 与交互：含"没有请求跑出密钥段"、"提权过期时必须把 PIN 门打开"、以及**提问与审批卡片**（渲染、作答编码、防 XSS、interaction-end 撤卡）（76 项） | jsdom |
| `test/addresses.mjs` | 地址排序与分类（16 项） | — |
| `test/shot.mjs` | 真浏览器截图 + 布局测量 | Windows + Edge |
| `test/phone-diag.mjs` | 真浏览器诊断：抓页面异常、控制台、网络状态码 | Windows + Edge |

```bash
npm test          # security 50 + crashprobe 17 + harness 59 + addresses 16 = 142 项，无需浏览器
npm run test:all  # 再加上 ui 的 76 项，共 218 项
```

### 仍未消除的风险（如实列出）

- **Cloudflare 能看到明文**：HTTPS 在其边缘终结，prompt、会话内容、附件对它都是明文
- **会话记录无独立保护**：拿到有效 cookie 即可读取全部历史
- **公网攻击面是一个手写的 Node HTTP 服务**：没有框架兜底
- **免费快速隧道**：无可用性保证，网址每次重启都会变
- **不用时请关闭**：`tools/tunnel-stop.ps1`。不暴露就没有攻击面，这是最有效的一条

---

## 已知坑（作者踩过的，写在代码注释里）

1. `res.write()` 写到已断开的响应上**不会同步抛错**，而是**异步 emit `'error'`** —— 无人监听时 Node 直接抛出，整个宿主进程陪葬。所以每一处响应都要挂 `res.on('error')`。
2. **不要用局部变量遮蔽同名函数**。曾经有一个 `const record = ...` 遮蔽了日志函数 `record()`，只在"令牌异地使用"这条路径上抛 `TypeError`，把整个 DSH 打死，排查了很久。
3. **退出前要同步落盘**。异常处理器里用异步 `appendFile` 再 `process.exit()`，写入不会完成 —— 探针会把证据弄丢。
4. `pnpm`/`npx` 建的联接，`Target` 可能是**相对路径**，重建时要相对**原联接所在目录**解析。
5. `robocopy` **默认跟进目录联接**，会把链接指向的整棵树也复制过来。
6. **`str.Replace()` 替换的是【全部】匹配，不是第一处。** 曾用带锚点的替换插入 `/api/revoke` 路由，而那个锚点在文件里出现了两次：一处正确，另一处落在无密钥的 404 分支里、位于 `const route` 之前 —— 于是手机浏览器自动请求 `/favicon.ico` 时抛 `ReferenceError: Cannot access 'route' before initialization`，整个宿主进程直接退出。表现是"**手机一连上就崩**"。插入唯一代码块必须用强制唯一匹配的编辑方式，或先断言出现次数。
7. **配置重写要带上所有字段。** `loadConfig()` 只写它列出的字段；新增的排查开关漏掉，就会被下一次"配置有变化"的重写悄悄抹掉（`crashProbe` 踩过）。
8. **测试会因为路径形态漂移而静默烂掉。** 页面改成相对地址（`api/...`）后，UI 测试的 mock 仍在按 `startsWith('/api/...')` 匹配，于是每个请求都 404 —— 测试不是失败，是**整个不工作了**。同一类漂移还让 `harness.mjs` 一次废掉 37 条断言（它的 `base` 里没有密钥段，于是 PIN 门、cookie、SSE、取消、余额缓存全部 404），让 `shot.mjs` 永远拿不到截图。规则：**测试里凡是拼 URL，都必须从配置里读密钥段，绝不硬编码绝对路径**；mock 要按浏览器语义把相对地址解析到带密钥段的页面地址上，并断言"没有请求跑出密钥段"。

---

## 兼容性

- 需要 DSH（peerDependency：`@deepseek-ai/cordis`）
- 纯 ESM，无构建步骤，无运行时依赖（只用 Node 内置模块）
- 只在 Windows 上实测过；监听、认证、页面都是平台无关的

## License

MIT
