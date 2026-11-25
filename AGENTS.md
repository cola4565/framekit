# FrameKit 项目基线

面向视频剪辑 / 后期工作者的跨平台桌面工具箱。当前只有一个模块：**网页素材解析器**（图片、音频、视频、字幕、其他文件）。仓库：`cola4565/framekit`，当前版本 **1.3.7**，已发布 Windows NSIS 安装包与 macOS DMG（arm64 / x64）。

## 技术栈

- Electron 45.4.1 + React 19 + TypeScript 5.9，构建用 electron-vite 6（Vite 8 / rolldown）
- 打包 electron-builder 26，Windows 目标 NSIS x64，macOS 目标 DMG（x64 + arm64）
- 自动更新 electron-updater 6.8（GitHub provider，读取 Release 的 `latest.yml`）
- 解析：cheerio 1.2（静态 HTML；由 electron-vite 打入主进程包）
- 图标：lucide-react（由 Vite 打入渲染进程包）
- 音视频合并：ffmpeg-static 5.3.0（打包时 `asarUnpack`，运行时替换为 `app.asar.unpacked` 路径）
- 无数据库；下载历史写在 userData 的 JSON 文件里

`react`、`react-dom`、`lucide-react`、`cheerio` 已移到 `devDependencies`，因为它们会在构建时被打包；`dependencies` 只保留运行时必须由 Electron 加载的 `ffmpeg-static` 与 `electron-updater`。

## 目录与职责

```
electron/
  main.ts              主进程入口、IPC 注册、单实例锁、菜单
  preload.ts           contextBridge 暴露 window.framekit
  parser.ts            解析编排：静态扫描 → 爱给网 / Bilibili / 抖音专用解析 →（可选）深度嗅探
  extractor.ts         静态 HTML/CSS/JSON-LD/脚本资源提取、URL 规整、文件名清洗
  sniffer.ts           隐藏浏览器深度嗅探（执行脚本、滚动、监听网络）
  bilibili.ts          Bilibili 会话、登录、播放信息、清晰度与音轨匹配
  douyin.ts            抖音持久会话、登录、DASH 流捕获与音视频配对
  aigei.ts             爱给网持久会话、登录、下载规格读取与正常下载入口
  weibo.ts             微博视频解析（mid 提取、访客身份、移动端接口直取 + 浏览器兜底）
  cctv.ts              央视网点播解析（页面编号、播放接口、HLS 清晰度）
  hls.ts               HLS 清单解析（master / media playlist、分片与清晰度）
  downloader.ts        下载队列：并发 3、Range/Referer/Cookie、DASH 合并、HLS 分片封装、取消、删除
  download-history.ts  下载记录持久化（最多 200 条）
  media-protocol.ts    framekit-media:// 预览代理（补请求头、转发 Range）
  thumbnail.ts        framekit-thumb:// 视频封面抽帧（ffmpeg 首帧 + 浏览器回退）
  github-fallback.ts  GitHub 免鉴权端点解析（tag / atom feed / 资产列表 / 自建 feed）
  update-settings.ts  更新设置持久化（更新源 / 镜像 / 代理）
  storage.ts           数据根目录选择、旧数据迁移、非 C 盘路径配置
  cache-cleanup.ts     清理 Electron 缓存，保留 Cookie、登录态、下载历史与用户素材
  updater.ts           GitHub Releases 检查更新 + 更新包下载/静默安装
src/
  App.tsx              主界面状态：解析、筛选、选择、队列、更新
  components/          Sidebar / ResourceCard / PreviewModal / DownloadDrawer / UpdateModal / EmptyState
  shared/types.ts      全量类型（MediaResource / DownloadProgress / FramekitApi ...）
  shared/media.ts      预览代理 URL 与“最低清晰度”选择
  shared/version.ts    semver 比较
  styles.css           全部样式（深色 UI，尺寸偏小，改样式先看变量区）
scripts/               冒烟测试、演示服务器、构建清理
```

## 关键实现约定

- **Bilibili 是 DASH**：视频流与音频流分离，`.m4s` 不能直接当成品播放。解析时每个清晰度生成一条资源，携带 `audioUrl`；下载时分别拉流再用 ffmpeg `-c copy` 合并为 MP4。
- **Bilibili 防盗链**：直链必须带 `Range: bytes=0-`、`Referer: https://www.bilibili.com/`，登录后还要带 Cookie；否则返回 HTTP 567。
- **不能只按媒体域名判断 Bilibili**：清晰度可能分配到 `bilivideo.com`、`bilivideo.cn` 或 `akamaized.net`。统一按 `resource.pageUrl` 是否为 bilibili 页面来判断是否走专用请求头 / 预览代理。
- **抖音是 DASH**：视频流与音频流分离，按 URL 的 `l` 参数配对；下载后由 ffmpeg 合并为标准 MP4。抖音登录使用 `persist:douyin`，检测 `sessionid` / `sessionid_ss` / `sid_tt`。
- **爱给网搜索页与条目页不同**：搜索页只读取 `fast-video-url` 的 Base64 低清预览，并过滤掉站点 UI 图片；条目页通过 CDP（Chrome DevTools Protocol，浏览器调试协议）读取下载规格与登录状态。
- **爱给网登录与下载**：`persist:aigei` 保存站点登录态；只调用页面正常的 `itemFileDown` 入口。未登录、验证码、VIP、铜币或商用授权限制都必须保留提示，不得绕过。
- **微博视频靠 mid 解析，不靠嗅探**：微博未登录时先跳 `passport.weibo.com/visitor/visitor` 算设备指纹，静态扫描只能拿到 9KB 的访客系统页。正确做法是从地址里取出 mid —— `tv/show/<oid>:<mid>` 路径里的、或个人主页 `?layerid=<mid>` 的（layerid 就是被点开那条视频的 mid）—— 再用 `m.weibo.cn/statuses/show?id=<mid>` 取 `page_info.media_info.stream_url`。接口通常 1 秒内返回，浏览器嗅探要 7 秒以上且常失败。
- **微博接口的字段形态**：`page_info.page_pic` 是 `{ url, width, height }` 对象不是字符串；`media_info` 只有 `stream_url` / `stream_url_hd` / `duration` 三个字段；接口要用手机 UA（iPhone）才直接响应，否则要先拿访客 Cookie。`Session.fetch` 的 `json()` 不可靠，统一用 `text()` 再 `JSON.parse`。
- **微博访客身份**：`persist:weibo` 保存 SUB Cookie。`ensureVisitorIdentity()` 访问一次 `m.weibo.cn` 就能拿到，之后接口与页面都能用，不必每次重算指纹。
- **央视网点播已改成 HLS**：页面里 `video.chapters[].url` 可能全是空串，只有 `hls_url` 有效。`electron/cctv.ts` 先从页面取 `guid` / `parentGuid`，再查 `api.cntv.cn/video/videoinfoByGuid` 与 `vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=...`，最后读 master playlist 列出清晰度。不要只靠静态扫描找 MP4。
- **HLS 下载**：`.m3u8` 资源走 `downloader.ts` 的 `runHls()`：顺序拉取 TS / fMP4 分片写入单个临时文件，再用 ffmpeg `-c copy` 封装为 MP4，音轨随分片一起保留。进度按已完成分片时长计算（`DownloadProgress.percent`），不要用 `content-length` 推断。加密 HLS（AES-128）与 `EXT-X-BYTERANGE` 分片会明确报不支持。
- **HLS 是“不可直接播放但可下载”**：资源保持 `isStream: true`，`src/shared/media.ts` 的 `isHlsResource()` 负责放行下载；`App.tsx` 的批量过滤、`ResourceCard` 与 `PreviewModal` 的下载按钮都要用它判断，DASH `.mpd` 仍然禁用下载。预览显示封面，不要尝试把 m3u8 直接塞给 `<video>`。
- **专用解析的判断要看原始地址**：`parsePage` 里微博的判断必须用 `pageUrl`（用户输入的原始地址），不能用静态扫描的 `finalUrl`——微博会把它改成 `passport.weibo.com`，导致适配器根本不触发。
- **webRequest 监听必须回调**：Electron 的 `webRequest.onBeforeRequest` 监听器必须调用 `callback({})`，否则会挂起页面请求。爱给网曾因漏掉回调导致下载按钮和预览全部读不到。
- **预览代理**：`framekit-media://media/?url=...&referer=...`。新增 scheme 时记得同步 `index.html` 的 CSP（`img-src` / `media-src` 已包含 `framekit-media:`）。
- **视频封面**：解析阶段先从 `<video poster>` / Open Graph / 结构化缩略图回填；仍无封面时由 `electron/thumbnail.ts` 用内置 ffmpeg 抽首帧（`scale=480:-2 -q:v 4 -f mjpeg`），ffmpeg 失败回退到隐藏 BrowserWindow `capturePage()`。走自定义 scheme `framekit-thumb://thumb/?url=...&referer=...`，`index.html` 的 CSP `img-src` 需包含 `framekit-thumb:`。封面缓存在 `userData/thumbnails/<sha1>.jpg`，上限 200 个，按 mtime 淘汰。
- **封面请求头要跟站点走**：抽帧请求头与 `electron/downloader.ts` 的 `requestHeaders` 保持一致（Bilibili 需要 `Range: bytes=0-` + Referer + Cookie，抖音 / 爱给网按页面来源带 Referer 与 Cookie）。微博等 CDN 直链返回 403 时，必须使用完整签名 URL（含 `ssig` / `Expires` / `label` / `media_id` 等参数），简化 URL 必然失败。
- **检查更新有多条通道**：`electron/updater.ts` 按顺序尝试「自建更新源 → GitHub API → GitHub 网页端点」，任一通道成功即返回，`UpdateCheckResult.source` 标记实际来源（`feed` / `api` / `web`）。GitHub API 对代理出口 IP 的匿名请求限流很严（403 / 429），网页通道不消耗 API 配额。
- **Electron 的 net.fetch 拿不到重定向后的 URL**：`response.url` 是空串，`redirect: 'manual'` 会抛 `Redirect was cancelled`。取最新 tag 要从 `releases/latest` 页面的 `og:url` 里解析，或用 atom feed 的第一个条目。magpie 用的是 Go 的 `http.Client`（能读 `Location` 头），不能直接照搬。
- **atom feed 的 id 不是 releases/tag 格式**：形如 `tag:github.com,2008:Repository/1459836626/v1.3.3`，版本号在最后一段。
- **更新设置**：`electron/update-settings.ts` 存在 `userData/config/update-settings.json`。自定义更新源是不消耗 GitHub 配额的兜底；镜像只改下载地址，SHA-512 校验仍按官方清单执行；代理只影响更新检查与下载。
- **预览用最低清晰度，下载用所选清晰度**：`lowestQualityVariant()` 按 `groupId` 找同组资源，`PreviewModal` 的 `playbackResource` 与 `resource` 分离。
- **下载队列**：记录持久化；删除记录会删磁盘文件；删除时先 `abort` 并等待运行中的 Promise 结束再删，避免“删完又被重命名写回”；打开队列每 5 秒校验文件是否存在。
- **关闭与托盘**：关闭按钮统一走 `window:close-request` → 渲染层确认弹窗 → `window:close-action`；托盘常驻，Windows 最小化隐藏到系统托盘，macOS 使用菜单栏模板图标且原生黄色最小化保留 Dock 行为。
- **安装与更新**：Windows 使用 assisted NSIS（`oneClick: false` + `allowToChangeInstallationDirectory: true` + `perMachine: false`），首次安装可选安装盘/目录；`assets/installer.nsh` 的 `customInstallMode` 强制当前用户安装，避免每次更新请求管理员权限。更新走 `electron-updater`，`autoDownload=false`，点击“立即更新”才下载；`quitAndInstall(true, true)` 以 `--updated /S` 静默安装，NSIS 复用 HKCU 的 `InstallLocation`，不会重新询问目录。`main.ts` 在调用安装前先置 `appQuitting=true`，避免关闭确认弹窗拦截。
- **更新清单**：每次 Release 必须同时上传 `latest.yml` 与 `.exe.blockmap`；`scripts/github-release.mjs` 已包含。缺少 `latest.yml` 时 `electron-updater` 会直接报错。
- **首次迁移**：1.2.0 及更早版本没有 `electron-updater`，升级到 1.3.1 必须手动安装一次；1.3.0 起才能应用内静默更新。macOS 未签名/未公证，暂不启用静默安装（`canAutoUpdate` 只在 Windows 打包版为 true）。
- **安全模型**：`contextIsolation` + `sandbox`，关闭 `nodeIntegration`；渲染进程只能通过 preload 暴露的 API 操作文件与网络。

## 开发与测试

```bash
npm install            # 若 ffmpeg-static 下载失败：见下方“网络”
npm run dev            # 开发版（FRAMEKIT_DEBUG_PORT=9222 可开 CDP）
npm run typecheck
npm run test:parser    # 静态解析
npm run test:download  # 普通下载
npm run test:update    # 版本比较
npm run test:storage   # 数据目录 / 环境变量回归
npm run test:cctv      # 央视网地址识别与 HLS 清单解析
npm run test:deep      # 深度嗅探（需要 Electron）
npm run test:ui        # 需要先 npm run demo + npm run dev
npm run test:bilibili  # 真实 Bilibili 解析 + 下载 + 合并校验（需要网络/可能需登录）
```

UI 冒烟需要两个后台进程：`npm run demo`（127.0.0.1:8787）与 `FRAMEKIT_DEBUG_PORT=9222 npm run dev`，然后 `npm run test:ui`。

## 数据位置

- Windows 打包版数据根目录：安装盘下的 `FrameKitData`，例如装在 `D:\FrameKit` 时使用 `D:\FrameKitData`；装在 C 盘时会优先选第一个可写的非 C 盘。`FRAMEKIT_DATA_DIR` 可覆盖。
  - `data/`：Electron `userData` / `sessionData`，包含 `download-history.json`、`Partitions/bilibili|douyin|aigei|weibo/`、Local Storage、Preferences
  - `cache/`、`logs/`、`crashDumps/`、`temp/`、`local/`、`roaming/`：Chromium 缓存、日志、崩溃转储、临时文件与进程级环境目录
  - **不要改写 `process.env.LOCALAPPDATA` / `APPDATA` / `TEMP` / `TMP`**：这些变量会被 `shell.openExternal` 启动的默认浏览器继承，导致系统浏览器把用户配置目录重建到 FrameKit 数据目录。需要重定向临时目录时用 `storage.ts` 的 `buildChildEnv()` 传给子进程；更新器缓存用 `baseCachePath` 显式指定。
  - `local/framekit-updater/`：electron-updater 下载缓存
  - `.framekit-data`：卸载器用来确认这是 FrameKit 数据目录的标记文件
- 旧版 `%APPDATA%\framekit` 会在首次启动 1.3.2+ 时迁移到新数据根目录（跳过缓存），随后删除旧目录；`%LOCALAPPDATA%\framekit*` 旧缓存直接清理。
- macOS 仍使用 Electron 默认的 `~/Library/Application Support/FrameKit`（macOS 文件系统通常大小写不敏感）。
- Windows 文件系统大小写不敏感，`framekit` 与 `FrameKit` 指向同一目录，不是两份数据。
- 打包产物在 `release/`（已 gitignore）。`node scripts/clean-build.mjs` 会在构建前删除旧 `out/` 与 `release/`，只生成当前版本产物。
- 运行时缓存清理只删除已知 Electron 缓存目录；不得删除 Cookie、Local Storage（本地存储）、下载历史或用户素材。
- Windows 卸载彻底清理应用数据：`deleteAppDataOnUninstall: true`，并由 `assets/installer.nsh` 额外清理 `local/framekit-updater` 与所有带 `.framekit-data` 标记的 `FrameKitData` 目录；更新过程中的临时卸载用 `${isUpdated}` 跳过清理。用户实际下载的素材在下载目录中，不删除。macOS 是 DMG 拖拽安装，没有卸载器，删除 App 不会自动清数据，需手动删除 `~/Library/Application Support` 下对应目录。

## 发版流程（简版）

详细命令与排障见 `docs/MAINTAINER.md`。

1. 改 `package.json` 版本：`npm version x.y.z --no-git-tag-version`
2. 更新 `CHANGELOG.md`、`README.md` 下载链接，写 `.tmp/release-notes-x.y.z.md`
3. 打包：`npm run dist:win`（必须走可用代理，见下）
4. 验证：安装包版本号、`app.asar.unpacked/.../ffmpeg.exe`、打包后应用跑一次解析/合并
5. 提交并推送 `main`
6. 创建 Release 并上传 Windows 资产（exe + blockmap + `latest.yml`），随后触发 macOS 工作流
7. 用应用内“检查更新”确认能识别新版本，并验证“立即更新 → 下载进度 → 重启并安装”全流程

## 网络与发布链路注意事项

- 终端里存在黑洞代理 `HTTPS_PROXY=http://127.0.0.1:9`，会覆盖系统代理，导致 `github.com` 超时。构建/推送前设置：
  `$env:HTTPS_PROXY='http://127.0.0.1:7890'; $env:HTTP_PROXY='http://127.0.0.1:7890'`（以本机实际代理端口为准）
- `git push` 到 `github.com` 直连会超时，但在可用代理下正常；GitHub 凭据由 `gh auth login` 管理（`gh auth setup-git`）。
- `ffmpeg-static` 安装需要访问 GitHub，失败时用：
  `$env:FFMPEG_BINARIES_URL='https://registry.npmmirror.com/-/binary/ffmpeg-static'; npm install ffmpeg-static@5.3.0`
- electron-builder 首次打包会下载 `winCodeSign` 等工具；同样需要代理（或 `ELECTRON_BUILDER_BINARIES_MIRROR` 镜像）。
- 发布脚本：`scripts/github-release.mjs`（`npm run release:github`，创建/更新 Release、上传 exe + blockmap、触发 macOS 工作流，token 取 `GH_PUBLISH_TOKEN` 或 `gh auth token`）。
- macOS DMG 不在本地构建，由 `.github/workflows/release.yml` 在 `macos-latest` 上构建并上传。

## 已踩过的问题（不要重复）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 下载 Bilibili 返回 HTTP 567 | 缺少 `Range` 头 | 所有 Bilibili 直链固定带 `Range: bytes=0-`，并补 Referer / Cookie |
| 下载的视频没有声音 | DASH 音视频分离，只存了视频流 | 下载 `audioUrl` 后用 ffmpeg 合并，界面显示“正在合并音视频…” |
| 部分视频预览打不开 | 直链被分到 `akamaized.net` 等 CDN，未走代理 | 按页面来源判断，而不是只匹配 `bilivideo.com` |
| 预览请求被拒 | `file://` 页面没有 Referer | 统一走 `framekit-media://` 代理 |
| 打包后合并失败 | ffmpeg 在 asar 内不可执行 | `asarUnpack` + 运行时把 `app.asar` 替换为 `app.asar.unpacked` |
| 测试脚本解析完就退出 | 隐藏窗口销毁触发 `window-all-closed` | 测试脚本里注册 `app.on('window-all-closed', () => undefined)` |
| 删除队列项后文件又出现 | 与重命名/合并存在竞态 | 删除时 abort 并 await 运行中的 Promise，重命名后再检查 `removed` |
| 队列里文件已删但状态还是完成 | 只信任内存状态 | 打开队列时校验 `filePath`，缺失则标记“文件已在磁盘上删除” |
| 重启后队列清空 | 记录只在内存 | 持久化到 `download-history.json` |
| 爱给网页面没有下载按钮/预览 | `onBeforeRequest` 监听器未调用 `callback({})`，请求被挂起 | 监听器内先记录再回调；页面加载后留出反爬跳转时间 |
| 爱给网搜索结果混入大量图片 | 样式表在视频过滤后又补回图片 | 视频搜索页跳过样式表扫描，并在合并后再次过滤 |
| 爱给网动态读取被 iframe 导航打断 | 同源空白 iframe 频繁创建 | 使用 CDP `Runtime.evaluate`，不要依赖短生命周期 `executeJavaScript` |
| `npm run test:*` 报 `spawn EPERM` | 沙箱禁止 esbuild 子进程 | 在沙箱外运行或提权 |
| 数据目录里多出几百 MB 的 `Microsoft/Edge` | 1.3.2 起的 `storage.ts` 全局改写了 `process.env.LOCALAPPDATA`，`shell.openExternal` 启动的默认浏览器继承后把自己的用户配置目录重建到了 FrameKit 数据目录 | 不再改写 `LOCALAPPDATA`/`APPDATA`/`TEMP`/`TMP`；ffmpeg 用 `buildChildEnv()` 显式传 TEMP，更新器缓存用 `baseCachePath` 显式指定；`npm run test:storage` 防回归 |
| 点更新后弹 NSIS 安装向导 | 旧实现只打开安装包；或安装包改成了 assisted 但未走 `--updated /S` | 应用内 `electron-updater` + `quitAndInstall(true, true)`；首次安装才显示向导 |
| 无法选择安装盘 | one-click 安装器固定装到 `%LOCALAPPDATA%\Programs` | `oneClick: false` + `allowToChangeInstallationDirectory: true`，并强制当前用户安装 |
| 自动更新报缺少 `latest.yml` | 发布脚本只上传了 exe 与 blockmap | 发布资产必须包含 `latest.yml` |
| 开发模式点更新报错 | `electron-updater` 需要打包后的 `app-update.yml` | 用 `release/win-unpacked/FrameKit.exe` 或安装版测试 |
| 视频没有封面 / 预览只显示占位图 | 页面没有 `poster` / `og:image`，播放失败时也没有兜底画面 | 抽帧封面兜底：`electron/thumbnail.ts` 走 `framekit-thumb://`，播放失败时 `PreviewModal` 显示封面 |
| 微博视频封面请求 403 | CDN 直链需要完整签名参数，简化 URL 无效 | 使用解析得到的完整签名 URL（`ssig` / `Expires` / `label` / `media_id`），并带正确 Referer |
| 检查更新提示"请求频率受限" | GitHub API 对代理出口 IP 限流（匿名配额 60/小时/IP） | 自动回退网页通道；必要时在更新设置里填自建更新源 |
| 网页通道拿不到最新版本号 | Electron `net.fetch` 不暴露重定向后的 `response.url` | 从 `releases/latest` 的 `og:url` 解析 tag，或用 atom feed 第一个条目 |
| Electron 开发模式启动即 FATAL | `node_modules/electron/dist` 的 ACL 缺少 ALL APPLICATION PACKAGES 沙箱读取权 | `icacls "node_modules\electron\dist" /grant *S-1-15-2-1:(OI)(CI)(RX) /T`（需在 cmd 里跑，PowerShell 会吃掉括号） |
| 微博个人主页地址解析不出视频 | `layerid` 被页面丢弃，且列表是 SPA 懒加载，嗅探抓不到 | 从地址取 `layerid` 作为 mid，走移动端接口直取播放地址 |
| 微博接口报 `data argument must be of type string` | `page_info.page_pic` 是对象被当成字符串传给了 `makeResource` | 用 `extractPosterUrl()` 兼容对象与字符串两种形态 |
| 微博接口拿不到某条 mid | 该条在移动端接口不可见 | 回退内置浏览器嗅探 `tv/show` 页的真实网络请求 |
| 央视网点播页解析不到视频 | 页面只给 `hls_url`，`video.chapters[].url` 是空串 | 走 `electron/cctv.ts`：guid → videoinfoByGuid → getHttpVideoInfo → master m3u8 |
| HLS 下载后没有声音或文件损坏 | 只保存了 m3u8，或分片顺序 / 封装方式不对 | 按清单顺序拼接分片，再用 ffmpeg `-c copy -movflags +faststart` 封装 MP4 |
| HLS 队列进度一直不动 | 分片响应没有 `content-length` | 使用已完成分片时长 / 清单总时长计算 `DownloadProgress.percent` |

## 边界与后续方向

- 不做 DRM 解密、不绕过付费墙；仅用于下载用户有权保存的内容。
- HLS（`.m3u8`）已支持未加密分片的下载与 MP4 封装；AES-128 加密、`EXT-X-BYTERANGE` 与独立音频 rendition 仍未实现。
- YouTube 等站点没有专用适配器。
- 爱给网官方 API 使用独立 API Key、额度与授权范围，不等于网页全部资源；详见 `docs/PLATFORM-NOTES.md`。
- 安装包未做商业代码签名/公证，SmartScreen / Gatekeeper 会提示未知开发者；macOS 静默更新要等签名与公证完成后再开启。
- 可选后续：断点续传、HLS 合并、更多站点适配、下载队列暂停/重试、签名与自动更新。

## 修改代码时的约定

- UI 文案用中文；不要引入多余依赖；新类型放 `src/shared/types.ts`，跨进程数据结构保持同步。
- 改 IPC 时同时更新 `preload.ts`、`FramekitApi` 与主进程 handler，并在渲染层做“方法不存在”的降级（旧 preload 会直接抛错）。
- 改下载/解析逻辑后至少跑 `typecheck` + 对应冒烟；涉及 Bilibili 时跑 `test:bilibili`。
- 不要提交 `release/`、`.tmp/`、`out/`、`node_modules/`。
