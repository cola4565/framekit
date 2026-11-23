# FrameKit 项目基线

面向视频剪辑 / 后期工作者的跨平台桌面工具箱。当前只有一个模块：**网页素材解析器**（图片、音频、视频、字幕、其他文件）。仓库：`cola4565/framekit`，当前版本 **1.2.0**，已发布 Windows NSIS 安装包与 macOS DMG（arm64 / x64）。

## 技术栈

- Electron 45.3.3 + React 19 + TypeScript 5.9，构建用 electron-vite 6（Vite 8 / rolldown）
- 打包 electron-builder 26，Windows 目标 NSIS x64，macOS 目标 DMG（x64 + arm64）
- 解析：cheerio 1.2（静态 HTML；由 electron-vite 打入主进程包）
- 图标：lucide-react（由 Vite 打入渲染进程包）
- 音视频合并：ffmpeg-static 5.3.0（打包时 `asarUnpack`，运行时替换为 `app.asar.unpacked` 路径）
- 无数据库；下载历史写在 userData 的 JSON 文件里

`react`、`react-dom`、`lucide-react`、`cheerio` 已移到 `devDependencies`，因为它们会在构建时被打包；`dependencies` 只保留运行时必须由 Electron 加载的 `ffmpeg-static`。

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
  downloader.ts        下载队列：并发 3、Range/Referer/Cookie、DASH 合并、取消、删除
  download-history.ts  下载记录持久化（最多 200 条）
  media-protocol.ts    framekit-media:// 预览代理（补请求头、转发 Range）
  cache-cleanup.ts     清理 Electron 缓存，保留 Cookie、登录态、下载历史与用户素材
  updater.ts           GitHub Releases 检查更新
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
- **webRequest 监听必须回调**：Electron 的 `webRequest.onBeforeRequest` 监听器必须调用 `callback({})`，否则会挂起页面请求。爱给网曾因漏掉回调导致下载按钮和预览全部读不到。
- **预览代理**：`framekit-media://media/?url=...&referer=...`。新增 scheme 时记得同步 `index.html` 的 CSP（`img-src` / `media-src` 已包含 `framekit-media:`）。
- **预览用最低清晰度，下载用所选清晰度**：`lowestQualityVariant()` 按 `groupId` 找同组资源，`PreviewModal` 的 `playbackResource` 与 `resource` 分离。
- **下载队列**：记录持久化；删除记录会删磁盘文件；删除时先 `abort` 并等待运行中的 Promise 结束再删，避免“删完又被重命名写回”；打开队列每 5 秒校验文件是否存在。
- **关闭与托盘**：关闭按钮统一走 `window:close-request` → 渲染层确认弹窗 → `window:close-action`；托盘常驻，Windows 最小化隐藏到系统托盘，macOS 使用菜单栏模板图标且原生黄色最小化保留 Dock 行为。
- **安全模型**：`contextIsolation` + `sandbox`，关闭 `nodeIntegration`；渲染进程只能通过 preload 暴露的 API 操作文件与网络。

## 开发与测试

```bash
npm install            # 若 ffmpeg-static 下载失败：见下方“网络”
npm run dev            # 开发版（FRAMEKIT_DEBUG_PORT=9222 可开 CDP）
npm run typecheck
npm run test:parser    # 静态解析
npm run test:download  # 普通下载
npm run test:update    # 版本比较
npm run test:deep      # 深度嗅探（需要 Electron）
npm run test:ui        # 需要先 npm run demo + npm run dev
npm run test:bilibili  # 真实 Bilibili 解析 + 下载 + 合并校验（需要网络/可能需登录）
```

UI 冒烟需要两个后台进程：`npm run demo`（127.0.0.1:8787）与 `FRAMEKIT_DEBUG_PORT=9222 npm run dev`，然后 `npm run test:ui`。

## 数据位置

- 用户数据目录：`%APPDATA%\framekit`（macOS 为 `~/Library/Application Support/framekit`）
  - `download-history.json`：下载队列历史
  - `Partitions/bilibili/`：Bilibili 登录 Cookie（`SESSDATA`）
  - `Partitions/douyin/`：抖音登录 Cookie 与站点会话
  - `Partitions/aigei/`：爱给网登录 Cookie 与站点会话
- Windows 文件系统大小写不敏感，`framekit` 与 `FrameKit` 指向同一目录，不是两份数据。
- 打包产物在 `release/`（已 gitignore）。`node scripts/clean-build.mjs` 会在构建前删除旧 `out/` 与 `release/`，只生成当前版本产物。
- 运行时缓存清理只删除已知 Electron 缓存目录；不得删除 Cookie、Local Storage（本地存储）、下载历史或用户素材。
- 卸载默认保留用户数据（`deleteAppDataOnUninstall: false`），避免误删素材和登录态。

## 发版流程（简版）

详细命令与排障见 `docs/MAINTAINER.md`。

1. 改 `package.json` 版本：`npm version x.y.z --no-git-tag-version`
2. 更新 `CHANGELOG.md`、`README.md` 下载链接，写 `.tmp/release-notes-x.y.z.md`
3. 打包：`npm run dist:win`（必须走可用代理，见下）
4. 验证：安装包版本号、`app.asar.unpacked/.../ffmpeg.exe`、打包后应用跑一次解析/合并
5. 提交并推送 `main`
6. 创建 Release 并上传 Windows 资产，随后触发 macOS 工作流
7. 用应用内“检查更新”确认能识别新版本

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

## 边界与后续方向

- 不做 DRM 解密、不绕过付费墙；仅用于下载用户有权保存的内容。
- HLS（`.m3u8`）目前只识别清单，分片下载与合并未实现。
- YouTube 等站点没有专用适配器。
- 爱给网官方 API 使用独立 API Key、额度与授权范围，不等于网页全部资源；详见 `docs/PLATFORM-NOTES.md`。
- 安装包未做商业代码签名/公证，SmartScreen / Gatekeeper 会提示未知开发者。
- 可选后续：断点续传、HLS 合并、更多站点适配、下载队列暂停/重试、签名与自动更新。

## 修改代码时的约定

- UI 文案用中文；不要引入多余依赖；新类型放 `src/shared/types.ts`，跨进程数据结构保持同步。
- 改 IPC 时同时更新 `preload.ts`、`FramekitApi` 与主进程 handler，并在渲染层做“方法不存在”的降级（旧 preload 会直接抛错）。
- 改下载/解析逻辑后至少跑 `typecheck` + 对应冒烟；涉及 Bilibili 时跑 `test:bilibili`。
- 不要提交 `release/`、`.tmp/`、`out/`、`node_modules/`。
