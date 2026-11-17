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

## 3. 测试矩阵

| 命令 | 覆盖范围 | 依赖 |
| --- | --- | --- |
| `npm run typecheck` | 全量 TS 类型 | 无 |
| `npm run test:parser` | 静态解析、去重、分类 | 无 |
| `npm run test:download` | 普通文件下载、重名处理 | 无 |
| `npm run test:update` | semver 比较与资产选择 | 无 |
| `npm run test:deep` | 深度嗅探 | Electron |
| `npm run test:bilibili` | 真实 Bilibili 解析 + 下载 + ffmpeg 合并 + 轨道校验 | 网络、Electron、可能需登录 |
| `npm run test:ui` | 真实界面解析 / 下载 / 角标 / 截图 | 需先启动 demo 与 dev |

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
npm version 1.2.0 --no-git-tag-version
```

同步修改：

- `CHANGELOG.md`：新增版本段落（新增 / 修复）
- `README.md`：`当前正式版` 与三条下载链接
- `.tmp/release-notes-<version>.md`：Release 正文（Markdown）

### 4.2 构建 Windows 安装包

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:HTTP_PROXY='http://127.0.0.1:7890'
npm run dist:win
```

产物：

- `release/FrameKit-<version>-Windows-x64.exe`
- `release/FrameKit-<version>-Windows-x64.exe.blockmap`
- `release/win-unpacked/`（用于快速验证）

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

仓库内没有常驻发布脚本，使用一次性 Node 脚本（参考 `.tmp/github-release.mjs`）：

1. 读取 `package.json` 的 `version` 作为 tag（`v<version>`）
2. 若 Release 不存在则创建，存在则 `PATCH` 正文
3. 删除同名旧资产后上传 exe 与 blockmap 到 `uploads.github.com`
4. 触发 `release.yml`（macOS 构建）

执行：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:GH_PUBLISH_TOKEN = (gh auth token)
$env:GITHUB_REPOSITORY='cola4565/framekit'
node .tmp/github-release.mjs
```

> 注意：推送 tag 本身也会触发 `release.yml`，脚本又手动 dispatch 一次，会产生两条并行构建。发版后保留一条、取消另一条即可。

### 4.6 收尾验证

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7890'
gh release view v<version> --repo cola4565/framekit --json assets --jq '.assets[].name'
```

应包含：

- `FrameKit-<version>-Windows-x64.exe`
- `FrameKit-<version>-Windows-x64.exe.blockmap`
- `FrameKit-<version>-macOS-arm64.dmg`
- `FrameKit-<version>-macOS-x64.dmg`

最后在旧版本应用中点“检查更新”，确认能识别新版本与正确安装包。

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
| macOS 构建失败 | 查看 Actions 日志；`CSC_IDENTITY_AUTO_DISCOVERY=false` 已在 workflow 中设置 |

## 7. 数据与清理

- 构建产物：`release/`、`out/`、`.tmp/`（均已 gitignore）
- 用户数据：`%APPDATA%\framekit`
  - `download-history.json`：可安全删除（会重建）
  - `Partitions/bilibili/`：删除后需重新登录 B 站
- 只保留当前版本的本地安装包，旧版本 exe / blockmap 及时删除

## 8. 版本策略

- 修复类：`1.1.x`
- 新功能 / 解析能力变化：`1.x.0`
- 破坏性数据结构或存储格式变化：`2.0.0`

发版前确保 `CHANGELOG.md`、`README.md`、Release Notes 三处版本一致。
