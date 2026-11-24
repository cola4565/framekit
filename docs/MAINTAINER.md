# FrameKit 维护者手册

面向后续迭代的完整操作说明。项目基线（架构、约定、已知问题）见根目录 `AGENTS.md`。

## 1. 环境准备

```powershell
node -v          # 需要 Node 20+，当前环境为 Node 24
npm ci
```

如果 `ffmpeg-static` 下载失败：

```powershell
$env:FFMPEG_BINARIES_URL='https://registry.npmmirror.com/-/binary/ffmpeg-static'
npm install ffmpeg-static@5.3.0
```

任何时候需要访问 GitHub（打包、推送、发布），先给当前终端设置可用代理。本项目当前环境使用 `127.0.0.1:7890`：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:HTTP_PROXY='http://127.0.0.1:7890'
```

> 注意：终端默认可能带有 `HTTPS_PROXY=http://127.0.0.1:9`（黑洞端口），它会覆盖系统代理设置，必须显式改成真实代理。

## 2. 日常开发

```powershell
npm run dev          # electron-vite dev
npm run typecheck
```

调试渲染进程：

```powershell
$env:FRAMEKIT_DEBUG_PORT='9222'; npm run dev
# 之后可用 CDP: http://127.0.0.1:9222/json
```

如果 `npm run dev` 启动即报 `FATAL: ... Sandboxed processes cannot read ...\node_modules\electron\dist`，说明 Electron 二进制的 ACL 缺了沙箱读取权限（重装 Electron 或复制仓库后常见）。在 cmd 里执行（PowerShell 会把括号当成语法）：

```cmd
icacls "node_modules\electron\dist" /grant *S-1-15-2-1:(OI)(CI)(RX) /T
```

这只影响开发模式；打包产物在 `release\win-unpacked`，不受影响。

## 3. 测试矩阵

| 命令 | 覆盖范围 | 依赖 |
| --- | --- | --- |
| `npm run typecheck` | 全量 TS 类型 | 无 |
| `npm run test:parser` | 静态解析、去重、分类 | 无 |
| `npm run test:download` | 普通文件下载、重名处理 | 无 |
| `npm run test:update` | semver 比较与资产选择 | 无 |
| `npm run test:github` | 更新回退通道的解析：tag / atom feed / 资产列表 / 自建 feed / API 路由 / 镜像 | 无 |
| `npm run test:weibo` | 微博 mid / layerid 解析与视频地址识别 | 无 |
| `npm run test:deep` | 深度嗅探 | Electron |
| `npm run test:bilibili` | 真实 Bilibili 解析 + 下载 + ffmpeg 合并 + 轨道校验 | 网络、Electron、可能需登录 |
| `npm run test:ui` | 真实界面解析 / 下载 / 角标 / 截图 | 需先启动 demo 与 dev |

爱给网与抖音目前使用真实页面手动回归：爱给网至少检查“未登录只返回公开预览”与规格提示；抖音至少检查视频流、独立音频流和合并后的 MP4 轨道。

UI 冒烟完整流程（三个终端）：

```powershell
npm run demo
$env:FRAMEKIT_DEBUG_PORT='9222'; npm run dev
npm run test:ui
```

产物：`.tmp/ui-results.png`、`.tmp/ui-queue.png`。

## 4. 发版步骤

### 4.1 升版本

```powershell
npm version 1.3.1 --no-git-tag-version
```

同步修改：

- `CHANGELOG.md`：新增版本段落（新增 / 修复）
- `README.md`：`当前正式版` 与三条下载链接
- `.tmp/release-notes-<version>.md`：Release 正文，可从 `docs/release-notes-template.md` 复制后填写

### 4.2 构建 Windows 安装包

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:HTTP_PROXY='http://127.0.0.1:7890'
npm run dist:win
```

产物：

- `release/FrameKit-<version>-Windows-x64.exe`
- `release/FrameKit-<version>-Windows-x64.exe.blockmap`
- `release/latest.yml`（electron-updater 的版本与校验清单）
- `release/win-unpacked/`（用于快速验证）

`npm run dist:win` 会先执行构建清理，旧版本 exe、blockmap、DMG、`win-unpacked` 与旧 `out/` 不会混入本次产物。

如果卡在 `connect ETIMEDOUT ...:443`，说明 electron-builder 在下载 `winCodeSign` / `nsis`，检查代理是否生效。

### 4.3 构建后必须验证

```powershell
# 1) 版本号
(Get-Item release\FrameKit-<version>-Windows-x64.exe).VersionInfo.ProductVersion

# 2) ffmpeg 是否被解包
Get-ChildItem release\win-unpacked\resources\app.asar.unpacked\node_modules\ffmpeg-static
& release\win-unpacked\resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe -version

# 3) 启动打包版并跑真实链路
$env:FRAMEKIT_DEBUG_PORT='9333'
Start-Process -FilePath 'D:\小工具\release\win-unpacked\FrameKit.exe' -WindowStyle Hidden
$env:FRAMEKIT_DEBUG_PORT='9333'; npx tsx .tmp/bilibili-ui-e2e.ts   # 如该脚本仍存在
```

最低要求：版本号正确、ffmpeg 可执行、Bilibili 1080P 下载后 `0:v:0` 与 `0:a:0` 都能解码。

封面抽帧复用同一个内置 ffmpeg，所以上面第 2 步的 ffmpeg 校验同时覆盖了封面功能。抽帧本身不需要额外依赖，`electron/thumbnail.ts` 在主进程内直接调用 `ffmpeg-static`。

### 4.4 提交并推送

```powershell
git add -A
git commit -m "feat: <变更摘要> (v<version>)"
$env:HTTPS_PROXY='http://127.0.0.1:7890'
git push origin main
```

GitHub 凭据由 `gh` 管理：

```powershell
gh auth login -h github.com -p https -w
gh auth setup-git --hostname github.com
```

### 4.5 创建 Release 并上传 Windows 资产

发布脚本已随仓库提供：`scripts/github-release.mjs`（`npm run release:github`）：

1. 读取 `package.json` 的 `version` 作为 tag（`v<version>`）
2. 若 Release 不存在则创建，存在则 `PATCH` 正文
3. 删除同名旧资产后上传 exe、blockmap 与 `latest.yml` 到 `uploads.github.com`
4. 新 tag 会自动触发 `release.yml`（macOS 构建）；只有 tag 已存在时才需要 `TRIGGER_MACOS=1` 手动补触发

执行：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:GH_PUBLISH_TOKEN = (gh auth token)
$env:GITHUB_REPOSITORY='cola4565/framekit'
npm run release:github
```

> 默认不手动 dispatch，避免与 tag push 触发的构建重复。若确实需要补触发，设置 `TRIGGER_MACOS=1`。

### 4.6 收尾验证

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7890'
gh release view v<version> --repo cola4565/framekit --json assets --jq '.assets[].name'
```

应包含：

- `FrameKit-<version>-Windows-x64.exe`
- `FrameKit-<version>-Windows-x64.exe.blockmap`
- `latest.yml`
- `FrameKit-<version>-macOS-arm64.dmg`
- `FrameKit-<version>-macOS-x64.dmg`

最后在旧版本应用中点“检查更新”，确认能识别新版本与正确安装包。

Windows 还要验证两条链路：

1. 首次安装：运行 exe 应出现标准安装向导，能选择安装盘/目录；`assets/installer.nsh` 会强制当前用户安装，不需要管理员权限。
2. 静默更新：点击“立即更新”后在应用内显示下载进度，完成后“重启并安装”应沿用首次安装目录，不弹 NSIS 向导、不重新询问位置。

> 1.2.0 及更早版本没有内置 `electron-updater`，升级到 1.3.1 仍需手动安装一次；从 1.3.0 开始后续版本才能静默更新。macOS 应用内安装依赖 Apple 签名与公证，当前仍走 DMG 手动安装。

## 5. 发布链路说明

```
本地                          GitHub
────────────────────────────────────────────────────
git push  ───────────────▶  main
                            │
node github-release.mjs ───▶ Release v<version>
   ├─ 上传 Windows exe      │
   └─ dispatch workflow ───▶ release.yml (macos-latest)
                              ├─ npm ci
                              ├─ npm run dist:mac
                              └─ 上传两个 dmg 到同一 Release
```

`softprops/action-gh-release` 使用 `tag_name: v<version>`，Release 不存在时会自动创建，已存在则追加/覆盖资产。

## 6. 常见故障

| 现象 | 排查 |
| --- | --- |
| `connect ETIMEDOUT 192.30.255.113:443` | 代理未生效；确认 `HTTPS_PROXY` 指向真实代理，且未被 `127.0.0.1:9` 覆盖 |
| `git push` 卡住 / 403 | `gh auth status` 检查登录；必要时 `gh auth login` + `gh auth setup-git` |
| `spawn EPERM`（esbuild） | 沙箱限制；在沙箱外执行测试命令 |
| 打包后窗口白屏 | 检查 `out/renderer` 是否构建成功、CSP 是否拦截了新 scheme |
| 打包后合并报“未找到内置 ffmpeg” | 确认 `asarUnpack` 与 `FFMPEG_PATH` 的 `app.asar.unpacked` 替换逻辑 |
| 更新检查返回 403/429 | GitHub 限流；稍后重试，或确认未使用未授权的高频请求 |
| 更新时报缺少 `latest.yml` | Release 未上传更新清单；重新执行 `npm run release:github` 或手动补传 |
| 点“立即更新”又弹安装向导 | 更新器没有以 `/S` 启动安装包，或安装包缺少 `--updated` 逻辑；确认 `quitAndInstall(true, true)` 与 1.3.1+ |
| 首次安装无法选盘 | `nsis.oneClick` 被改回 true，或 `allowToChangeInstallationDirectory` 被关闭 |
| 开发模式下自动更新报错 | `electron-updater` 需要打包产物；用 `release/win-unpacked/FrameKit.exe` 测试 |
| macOS 构建失败 | 查看 Actions 日志；`CSC_IDENTITY_AUTO_DISCOVERY=false` 已在 workflow 中设置 |

## 7. 数据与清理

- 构建产物：`release/`、`out/`、`.tmp/`（均已 gitignore）
- 构建清理：`node scripts/clean-build.mjs` 删除旧 `out/` 与 `release/`；已接入 `npm run build` / `npm run dist*`
- Windows 用户数据根目录：安装盘下的 `FrameKitData`（例如 `D:\FrameKitData`）；若安装在 C 盘，会优先选第一个可写的非 C 盘。可用 `FRAMEKIT_DATA_DIR` 覆盖。
  - `data/download-history.json`：可安全删除（会重建）
  - `data/Partitions/bilibili/`：删除后需重新登录 B 站
  - `data/Partitions/douyin/`：删除后需重新登录抖音
  - `data/Partitions/aigei/`：删除后需重新登录爱给网
  - `data/Partitions/weibo/`：删除后需重新获取微博访客身份
  - `local/framekit-updater/`：更新包下载缓存
  - `.framekit-data`：卸载器识别数据目录的标记文件
- Windows 旧版 `%APPDATA%\framekit` 会在首次启动时迁移到新目录，然后删除；旧 `%LOCALAPPDATA%\framekit*` 缓存直接清理。macOS 保持 `~/Library/Application Support/FrameKit` 默认路径，不做重定向。
- **不要在 `storage.ts` 里改写 `process.env.LOCALAPPDATA` / `APPDATA` / `TEMP` / `TMP`**。1.3.2 ~ 1.3.5 期间这么做过，导致 `shell.openExternal` 启动的默认浏览器把自己的用户配置目录（实测 493MB 的 `Microsoft/Edge`）重建到 `D:\FrameKitData\local` 下。现在临时目录通过 `buildChildEnv()` 只传给 ffmpeg 子进程，更新器缓存通过 `baseCachePath` 显式指定；`npm run test:storage` 防回归。
- 运行时清理：启动后与退出前只删除 `Cache`、`Code Cache`、`GPUCache`、`Dawn*Cache`、`ShaderCache` 等已知 Electron 缓存目录；不会删除 Cookie、Local Storage（本地存储）、下载历史或用户素材
- Windows 卸载策略：`deleteAppDataOnUninstall: true`；`assets/installer.nsh` 还会清理更新器缓存与所有带 `.framekit-data` 标记的 `FrameKitData` 目录。用户下载的素材文件不删除。macOS 无卸载器，删除 App 后需手动清理 `~/Library/Application Support`。
- 只保留当前版本的本地安装包，旧版本 exe / blockmap 由构建清理自动删除

## 8. 版本策略

- 修复类：`1.1.x`
- 新功能 / 解析能力变化：`1.x.0`
- 破坏性数据结构或存储格式变化：`2.0.0`

发版前确保 `CHANGELOG.md`、`README.md`、Release Notes 三处版本一致。
