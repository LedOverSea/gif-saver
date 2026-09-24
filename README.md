# xgif

从 X（Twitter）链接保存**原始 GIF / 视频（MP4）/ 图片**的工具。命令行 + 本地 Web 界面，**零第三方依赖**。

复制推文链接 → 粘贴 → 得到 X 上那个 GIF 的原始文件。适用于 `https://x.com/i/status/2101055391488696737` 这类链接。

---

## 一、两种用法

需要先装 **Node.js 18+**（[nodejs.org](https://nodejs.org/)，一路下一步即可）。不需要 `npm install`，没有任何依赖。

### 用法 A：图形界面（推荐）

双击 **`xgif-ui.cmd`**，会自动打开浏览器并进入界面，然后：

- 在输入框里粘贴推文链接（**Ctrl+V** 直接粘，粘完会自动开始解析）
- 或者点「读剪贴板」按钮，或者把链接**直接拖到页面上**
- 解析出结果后，点缩略图上的「保存」（存原始 MP4），或点「转 GIF」转成动图
- 下方「已保存」区域是画廊，点任意一项即可预览，右上角「打开文件夹」直接定位到磁盘目录
- **要给 QQ 发动图**：在画廊里点那个 GIF 的「复制」，然后到 QQ 聊天窗口 Ctrl+V（详见第二节）

也可以用命令行启动：

```powershell
node ui.mjs                      # 默认 http://127.0.0.1:43110/
node ui.mjs --port 8080          # 换端口（被占用时会自动 +1）
node ui.mjs --out "D:\gifs"      # 换保存目录
node ui.mjs --no-open            # 不自动打开浏览器
```

界面功能：链接解析预览、原图/视频缩略图、逐条进度条、批量保存、已保存画廊、拖拽、剪贴板读取、深色主题、Esc 关闭预览。

### 用法 B：命令行

```powershell
node xgif.cmd          # 双击：粘贴链接后回车，可连粘多条
node xgif.mjs "https://x.com/i/status/2101055391488696737"
node xgif.mjs "https://x.com/..." -o "D:\gifs"     # 指定目录
node xgif.mjs --clip                               # 读剪贴板
node xgif.mjs "https://x.com/..." --json           # 只看元数据不下载
"https://x.com/..." | node xgif.mjs                # 管道粘贴
```

| 参数 | 说明 |
|---|---|
| `-o, --out <目录>` | 保存目录，默认 `./downloads` |
| `--proxy <URL>` | 显式指定代理，如 `http://127.0.0.1:7890`（需 Node 24+） |
| `--no-auto-proxy` | 关闭"直连不通时自动改用系统代理" |
| `--clip` | 从 Windows 剪贴板读取链接 |
| `--json` | 只打印解析到的元数据，不下载 |
| `-q, --quiet` | 不显示进度 |
| `-h, --help` / `-v, --version` | 帮助 / 版本 |

支持的链接形式：`x.com/i/status/ID`、`x.com/用户名/status/ID`、`x.com/i/web/status/ID`、
`twitter.com/.../status/ID`、`.../status/ID/photo/1`、带 `?s=20` 等跟踪参数、
`mobile.twitter.com/.../statuses/ID`，以及纯数字 ID。

## 二、MP4 还是 GIF？

X 早已不再存储真正的 GIF：用户上传的 GIF 会被转码成 **H.264 无声 MP4**，托管在 `video.twimg.com`。
本工具两种都能给，各有取舍：

| | 原始 MP4（默认，「保存」） | 动画 GIF（「转 GIF」） |
|---|---|---|
| 本质 | X 上的原始文件 | 重新编码的 256 色动图 |
| 画质 | 原始画质 | 降到 256 色（带抖动补偿） |
| 体积 | 示例推文 117 KB | 同一条内容转 240 宽后约 572 KB |
| 依赖 | 无 | 无（浏览器解码 + JS 编码，**不需要 ffmpeg**） |
| 用途 | 存档、剪辑、发视频 | **发到 QQ / 微信当表情包** |

**要发 QQ 就用「转 GIF」。** 尺寸和体积都可以在界面里调（宽度 / 帧率 / 时长上限 / 抖动），
转完会提示体积；超过 5MB 会给警告。

### 关于 QQ 的 GIF

- **QQ 没有私有动图格式，收的就是标准 GIF。** QQ 官方机器人富媒体文档写明：图片类型支持
  `jpg / png / gif / webp / bmp`，发送后直接展示图片，软限制 20MB（超过会降级成文件卡片）。
  QQ 客户端「自定义表情」单张上限约 5MB；微信/QQ 表情包的通行尺寸约 240×240。
- **真正的坑是「复制」这个动作，不是格式。** 在浏览器里复制图片，剪贴板里放的是 `image/png`
  —— **只有当前这一帧**，粘到 QQ 就是张静态图。想让 QQ 收到动图，必须把 **`.gif` 文件本身**
  放进剪贴板（`CF_HDROP` 文件列表）。本工具的「复制」按钮做的正是这件事。
- 三种送进 QQ 的方式，任选：
  1. 画廊里点 GIF 的「复制」→ 到 QQ 聊天窗口 **Ctrl+V**
  2. 点「打开文件夹」，把 `.gif` **拖进** QQ 聊天窗口
  3. 在 QQ 里点「发送图片」，选中那个 `.gif`
- 需要真 `.gif` 之外的特殊格式（比如自己再压一版），也可以拿 MP4 自己转：
  `ffmpeg -i in.mp4 -vf "fps=15,scale=240:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" out.gif`

## 三、网络要求与代理（重要）

本工具涉及两个域名，可达性完全不同。以下是**实测结果**（中国大陆网络）：

| 域名 | 作用 | 直连 |
|---|---|---|
| `api.fxtwitter.com` | 解析推文 → 拿到媒体直链 | ✅ 200 OK，约 300 ms |
| `video.twimg.com` | **真正的 GIF / 视频文件** | ❌ TLS 握手后被 RST（ECONNRESET） |
| `pbs.twimg.com` | 图片、封面图 | ❌ TCP 连接超时 |

**所以：开发不需要一直开 VPN，运行下载必须开。**

- **开发阶段**：零第三方依赖，不需要 `npm install`，写代码和跑测试（`npm test`）全离线完成。只有 `git clone` / `git push` GitHub 时才通常需要。
- **运行阶段**：媒体域名被阻断，必须有可用的翻墙通道。

工具会自动处理，**通常不需要你手动配置**：

1. **TUN / 全局模式** —— 直连就通，工具直接用直连（最省事，推荐）。
2. **只开了系统代理**（如 Clash 的"系统代理"开关）—— 工具启动时会探测 `video.twimg.com`，
   发现直连不通就**自动读取 Windows 系统代理并改走它**：

   ```
   ⚠ 直连 X 媒体域名失败，自动改用系统代理 http://127.0.0.1:7890
   ```

3. **想手动指定** —— `--proxy http://127.0.0.1:7890`，或设环境变量 `XGIF_PROXY` / `HTTPS_PROXY`。
   走代理需要 **Node.js 24+**（本工具用它的 `--use-env-proxy` 能力让 `fetch` 读取代理变量）；
   旧版 Node 会明确报错并提示改用 TUN 模式，不会静默失败。
   用 `--no-auto-proxy` 可关闭自动探测。

实测数据：走代理时解析约 0.5 s，下载 117 KB 约 0.3 s。下载到的 MP4 经校验为 `avc1` 轨、
`498x360`、无音频轨，与接口声明的分辨率完全一致。

## 四、界面为什么用「本地 Web」而不是 Electron / 原生控件

因为**网页 UI 不是原生 GUI 的替代品，而是它的底座**：

- Tauri 本质就是"一个 webview 装网页"，Electron 同理。现在写 HTML/CSS/JS，
  将来想要托盘图标、剪贴板监听、安装包，外面套一层 Tauri 即可，界面代码几乎不用改；
  反过来先写 WinForms/Qt，将来想换就得全废重写。
- **缩略图、网格画廊**这类需求在 HTML 里是降维打击：`<img>` / `<video>` 天然支持，
  CSS Grid 几行搞定；原生控件 GUI 要逐个框架接图片控件、自己管布局。
- 和核心逻辑**零摩擦**：`xgif.mjs` 本身就是 ESM 模块，界面直接 `import` 复用解析 / 选流 / 下载 / 代理探测。
- 迭代快：改完 CSS 刷新浏览器即可，没有编译或打包步骤。

两个实现上的关键决策：

**1. 媒体统一由本地服务转发（`/proxy`），不让浏览器直连。**
浏览器走的是「系统代理」，而 Node 进程可能用的是 `--proxy` / `XGIF_PROXY`。
统一从服务端转发，两种代理模式下的预览和缩略图行为才一致。
只允许转发 `pbs.twimg.com` 与 `video.twimg.com`（https），避免把这个接口变成 SSRF 跳板。
顺带也绕开了跨域问题——实测这两个 CDN 虽然返回 `Access-Control-Allow-Origin: *`，但不依赖它更稳。

**2. 画廊缩略图不生成图片文件。**
用 `<video src="/media/xxx.mp4#t=0.5" preload="metadata">` 让浏览器自己解码第一帧当缩略图，
不需要 ffmpeg，也不占额外磁盘。`/media` 实现了完整的 Range 支持（含 416 处理），
所以视频能拖进度条、能即时播放。

## 五、故障排查

**双击 `xgif-ui.cmd` / `xgif.cmd` 没有任何反应（窗口都不弹）**
根因通常是批处理文件被写成了 LF 换行——cmd.exe 要求 **CRLF**，遇到纯 LF 会报
`The syntax of the command is incorrect.` 并静默退出。本仓库的两个 `.cmd` 均为 CRLF + 纯 ASCII，
如果你手工改过它们，注意别把换行符改坏。

**界面打得开，但解析提示失败**
翻墙通道没生效。界面上会提示，`toast` 里也会写。检查 VPN 是否在运行；
若用系统代理模式，注意服务端启动时会打印它探测到的代理地址。

**浏览器里点「读剪贴板」没反应**
浏览器剪贴板 API 需要安全上下文与授权。`127.0.0.1` 算安全上下文，正常情况下会弹权限询问；
被拒绝就在输入框里直接 Ctrl+V。

**提示"走代理需要 Node.js 24+"**
升级 Node，或把 VPN 切到 TUN / 全局模式，就不需要代理参数了。

**提示"推文不存在 / 已被删除 / 账号受保护"**
该推文不可公开访问。NSFW、年龄限制、受保护账号的内容本工具不支持。

## 六、已知限制

- **登录墙内容不支持**：NSFW、年龄限制、受保护账号、地区限制的推文拿不到直链，需要带 Cookie 的登录态，本工具不做。
- **依赖第三方接口**：`api.fxtwitter.com` 是免费公共服务，可能限流或变更；媒体直链由 X 控制，可能随政策变化。
- **不支持 t.co 短链**：请使用展开后的 `x.com/.../status/ID` 链接。
- **不做真 GIF 转码**（见第二节，故意为之）。
- 界面服务只监听 `127.0.0.1`，不做多用户 / 远程访问设计。

## 七、项目结构

```
xgif.mjs              核心 + 命令行（URL 解析 / 选流 / 下载 / 代理探测 / 交互）
ui.mjs                本地 Web 服务（静态资源 + API + 媒体转发代理）
public/index.html     界面（单文件，内联 CSS/JS，无构建步骤）
public/convert.js     视频 → GIF：用 <video>+canvas 抽帧（复用浏览器解码器）
public/gif.js         GIF89a 编码器（中位切分调色板 + Floyd–Steinberg 抖动 + LZW）
xgif.cmd              Windows 命令行启动器
xgif-ui.cmd           Windows 界面启动器
test/smoke.mjs        核心离线自测（不联网）
test/gif-smoke.mjs    GIF 编码器自测（用 GDI+ 交叉验证）
test/ui-smoke.mjs     界面与服务端自测
test/browser-e2e.mjs  无头浏览器端到端：真实视频 → 动画 GIF
package.json
```

服务端接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 界面页面 |
| GET | `/api/parse?url=` | 解析推文，返回规范化的媒体列表 |
| POST | `/api/save` | 下载并保存 MP4，NDJSON 流式返回进度 |
| POST | `/api/save-gif?name=` | 保存浏览器转好的 GIF（校验 GIF 文件头） |
| POST | `/api/copy-file` | 把文件本身放进剪贴板（供 QQ 粘贴动图） |
| GET | `/api/library` | 已保存文件列表 |
| GET | `/media/<文件名>` | 本地文件（支持 Range） |
| GET | `/proxy?u=` | 转发 X CDN 媒体（域名白名单 + Range 透传） |
| POST | `/api/reveal` | 在资源管理器中打开保存目录 |

安全：只监听 `127.0.0.1`；`/media` 做路径规范化防穿越；`/proxy` 只允许两个 CDN 域名且强制 https；
写操作要求自定义请求头 `x-xgif: 1`（会触发 CORS 预检，而本服务不返回 CORS 头，因此跨站脚本无法触发）。

**转 GIF 为什么不用 ffmpeg**：浏览器本来就能解码 H.264（你都能在预览里播放它），
所以让 `<video>` + `<canvas>` 负责抽帧，再用自己写的 `gif.js` 编码成 GIF89a 就够了 ——
用户不需要装任何外部程序，项目也保持零依赖。编码器包含中位切分量化、可选的
Floyd–Steinberg 抖动、以及 GIF 变体 LZW（位宽增长规则对齐 Acme GifEncoder）。

代价是编码期间主线程会被占用一两秒（界面短暂卡顿），这个取舍换来了「零安装」。

**解析**走 [FxTwitter](https://github.com/FixTweet/FxTwitter) 的公开接口 `api.fxtwitter.com/status/<id>`：
免费、无需登录、无需 API Key、无需 Cookie。这避开了三个坑：官方 X API 的付费门槛、
guest token 的签名轮换、以及 syndication 接口的 token 算法变更。
**降级预案**：如果 FxTwitter 不可用，可以再挂一个 yt-dlp 子进程后端，当前版本刻意不做以保持零依赖。

## 八、测试

```powershell
npm test                    # 四套都跑
node test/smoke.mjs         # 核心：离线
node test/gif-smoke.mjs     # GIF 编码器：用 GDI+ 交叉验证
node test/ui-smoke.mjs      # 界面与服务端
node test/browser-e2e.mjs   # 无头浏览器端到端（需要 Chrome/Edge + 代理）
```

- **核心（16 项，全离线）**：URL 解析 6 例、文件名净化、字节格式化、选流逻辑
  （多码率 / GIF / m3u8 回退 / 无 MP4）、以及基于本地 HTTP 服务器的完整下载管道
  （2 MB 下载后逐字节比对、`.part` 清理、空响应体、HTTP 404）。
- **GIF 编码器（10 项）**：关键是**用真实第三方解码器当裁判**，而不是自己编码自己解码
  ——那样两边共享同一个错误规则也会「通过」。这里用 Windows 自带的 GDI+：
  ① 让 GDI+ 生成参考 GIF，验证本项目的解码逻辑符合规范；
  ② 用本项目编码器生成 GIF，让 GDI+ 加载并回读像素，验证编码器符合规范；
  ③ 让 GDI+ 确认多帧 GIF 的帧数。另含渐变图量化误差（平均通道误差 3.23）与边界用例。
- **界面与服务端（21 项）**：自己拉起服务再关掉。覆盖静态页、`/media` 的完整响应 /
  Range / 越界 416 / 路径穿越防护、`/proxy` 白名单与协议校验、`/api/save-gif` 的
  往返一致性与格式校验、`/api/copy-file` 的 404 分支；联网用例（真实推文解析、
  缩略图 JPEG 校验、视频 Range 透传、真实下载 120,076 字节）在无代理时自动跳过。
  其中「剪贴板里是文件而不是位图」这条会覆盖系统剪贴板，默认跳过，
  用 `$env:XGIF_TEST_CLIPBOARD='1'` 显式开启。
- **浏览器端到端（6 项）**：用无头 Chrome/Edge 加载一个临时页面，该页面
  **import 的是界面同一个 `convert.js`**，把真实视频转成 GIF 再回传校验。
  实测产物 240×173 / 23 帧 / 571.5 KB，且 23 帧长度各不相同（证明抽帧真的在动）。
  加 `$env:XGIF_E2E_KEEP='1'` 可把产物留到 `downloads/` 里。

> 这套浏览器测试不是摆设：它第一次运行就抓到了一个真 bug —— 抽帧时把裸像素数组
> 直接 push 给了 `encodeGif`，而它需要的是 `{ data, delayMs }` 对象。
> 前面所有测试都发现不了，因为它们都是直接喂正确对象给编码器的。

## 九、免责声明

本项目仅用于个人备份与学习。下载的内容版权归原作者所有，请勿用于再分发或商业用途。
使用前请自行确认符合 X 的服务条款及你所在地区的法律法规。作者不对任何误用负责。

## License

MIT
