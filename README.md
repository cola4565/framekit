# FrameKit 后期工具箱

面向视频剪辑与后期工作者的跨平台桌面工具集。当前首个模块是**网页素材解析器**：粘贴一个网址，提取页面里可下载的图片、音频、视频、字幕与其他文件。

支持 Windows 与 macOS，基于 Electron + React + TypeScript 构建，解析与下载全部在本机完成。

![FrameKit 素材解析界面](docs/screenshot-results.png)

![FrameKit 下载队列](docs/screenshot-downloads.png)

## 当前能力

- **快速扫描**：读取页面 HTML，解析 `img`、`srcset`、`picture`、`video`、`audio`、`a`、`link`、Open Graph、Twitter Card、JSON-LD、内联脚本与 CSS 背景图。
- **深度嗅探**：启动隐藏的内置浏览器执行页面脚本、滚动触发懒加载，并监听真实网络请求，捕获动态插入的图片、音视频、HLS/DASH 清单和脚本请求资源。
- **统一资源库**：按图片、视频、音频、其他分类；支持搜索、筛选、尺寸/时长/体积/MIME 展示。
- **内置预览**：图片、视频、音频和流媒体清单说明；支持复制直链和浏览器打开。
- **批量下载**：多选、队列并发、实时速度与进度、取消、文件名去重、Content-Disposition 文件名、`.part` 临时文件。
- **跨平台打包**：Windows NSIS 安装包与 macOS DMG 配置；应用图标已生成。

> 请只下载和使用你有权访问、保存的内容，并遵守目标网站的服务条款与版权要求。

## 使用方式

1. 打开应用，点击右上角“选择保存目录”。
2. 粘贴网页地址。
3. 默认使用“快速扫描”；如果页面由 JavaScript 动态加载，切换到“深度嗅探”。
4. 在结果中筛选、预览、勾选素材，然后下载。
5. 下载进度和文件位置在右上角“下载队列”中查看。

### 深度嗅探说明

深度嗅探使用独立的临时浏览器会话，通常需要 5–15 秒：

- 会执行页面脚本并滚动页面，触发懒加载内容。
- 会监听图片、媒体与脚本发起的网络请求。
- 不共享你日常浏览器的登录状态；需要登录才能看到的资源，当前版本无法直接读取。
- 不会绕过 DRM、付费墙或站点访问控制。

## 支持与边界

| 类型 | 支持情况 |
| --- | --- |
| 常规图片 | 支持 `<img>`、`srcset`、懒加载属性、CSS 背景、OG/Twitter、JSON-LD、脚本内 URL |
| 常规音视频 | 支持 `<video>`、`<audio>`、`<source>`、直链、网络请求捕获 |
| HLS / DASH | 能识别 `.m3u8` / `.mpd` 清单，但当前不会自动下载分片并封装成片 |
| 防盗链资源 | 预览可能失败；下载会携带页面 Referer，部分站点仍会拒绝 |
| 登录后资源 | 深度嗅探使用独立会话，不继承浏览器登录状态 |
| YouTube / Bilibili 等流媒体站 | 当前版本不内置专用站点解析器；需要后续接入 yt-dlp 类适配器 |
| 加密流媒体 | 不做 DRM 解密 |

## 开发环境

- Node.js `^20.19.0` 或 `>=22.12.0`
- npm 10+
- Windows 或 macOS

```powershell
npm install
npm run dev
```

如果 Electron 二进制下载被网络拦截，可使用镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node node_modules/electron/install.js
```

## 测试

```powershell
# 静态解析：DOM、srcset、OG、JSON-LD、脚本、CSS、直接媒体地址
npm run test:parser

# 多文件下载、进度回调、Content-Disposition 文件名
npm run test:download

# 动态资源嗅探（需要 Electron 图形环境）
npm run test:deep
```

界面自动化测试需要三个终端：

```powershell
# 终端 1：本地演示页面
npm run demo

# 终端 2：带本地调试端口的开发版
$env:FRAMEKIT_DEBUG_PORT = "9222"
npm run dev

# 终端 3：自动填写网址、解析、检查卡片、下载并截图
npm run test:ui
```

截图输出到 `.tmp/ui-results.png` 与 `.tmp/ui-queue.png`。

## 构建安装包

```powershell
# 仅编译
npm run build

# Windows NSIS 安装包
npm run dist:win

# macOS DMG（建议在 macOS 上执行）
npm run dist:mac
```

构建产物位于 `release/`。

macOS 的 DMG 打包、签名与公证需要在 macOS 上完成。当前配置未包含 Apple Developer 签名证书；正式分发前需配置 `CSC_LINK`、`CSC_KEY_PASSWORD` 与公证凭据。

## 架构

```text
electron/
  main.ts          主进程、窗口、菜单、IPC 注册
  parser.ts        快速扫描与深度嗅探的编排、结果合并
  extractor.ts     静态 HTML/CSS/脚本/元数据解析
  sniffer.ts       隐藏浏览器、DOM 快照、网络请求捕获
  downloader.ts    下载队列、进度、命名、落盘
  preload.ts       受限 IPC API 暴露
src/
  App.tsx          主界面与交互状态
  components/      资源卡片、预览、下载抽屉、侧栏
  shared/          跨进程类型与格式化工具
scripts/           解析、下载、动态嗅探、UI 自动化测试
assets/            应用图标
docs/              界面截图
```

主窗口启用 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`。深度嗅探窗口禁止弹窗、下载和非 HTTP(S) 导航，并拒绝所有权限请求。

## 后续模块

- 图片批处理：批量尺寸、格式转换、水印、色彩空间
- 音视频转码：代理文件、H.264/H.265、ProRes、序列封面
- 音频工具：提取、响度标准化、降噪、波形
- 字幕工具：SRT/ASS/VTT 转换、时间轴校正、翻译
- HLS/DASH 合并与 yt-dlp 适配器
- 登录态嗅探、Cookie 导入、下载断点续传
