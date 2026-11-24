import { app, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateCheckResult, UpdateDownloadState } from '../src/shared/types'
import { isNewerVersion, normalizeVersion } from '../src/shared/version'

const RELEASE_API = 'https://api.github.com/repos/cola4565/framekit/releases/latest'
const RELEASE_PAGE = 'https://github.com/cola4565/framekit/releases/latest'

interface GithubReleaseAsset {
  name: string
  size: number
  browser_download_url: string
}

interface GithubRelease {
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  published_at: string
  draft: boolean
  prerelease: boolean
  assets: GithubReleaseAsset[]
}

function chooseDownload(
  assets: GithubReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string
): GithubReleaseAsset | null {
  if (platform === 'win32') {
    return (
      assets.find(
        (asset) => /Windows/i.test(asset.name) && /\.exe$/i.test(asset.name)
      ) ?? null
    )
  }

  if (platform === 'darwin') {
    const macAssets = assets.filter(
      (asset) => /macOS/i.test(asset.name) && /\.dmg$/i.test(asset.name)
    )
    const preferredArch = arch === 'arm64' ? /arm64/i : /x64|x86_64/i
    return (
      macAssets.find((asset) => preferredArch.test(asset.name)) ??
      macAssets[0] ??
      null
    )
  }

  return null
}

function requestError(status: number): Error {
  if (status === 404) {
    return new Error('GitHub 上还没有可用的正式版本发布记录')
  }
  if (status === 403 || status === 429) {
    return new Error('GitHub 请求频率受限，请稍后再试')
  }
  return new Error(`检查更新失败（GitHub 返回 ${status}）`)
}

export async function checkForUpdates(
  currentVersion: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): Promise<UpdateCheckResult> {
  let response: Response
  try {
    response = await net.fetch(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `FrameKit/${currentVersion}`
      },
      signal: AbortSignal.timeout(15000)
    })
  } catch {
    throw new Error('无法连接 GitHub，请检查网络或代理设置后重试')
  }

  if (!response.ok) throw requestError(response.status)

  let release: GithubRelease
  try {
    release = (await response.json()) as GithubRelease
  } catch {
    throw new Error('GitHub 返回了无法读取的版本信息')
  }

  if (!release || typeof release.tag_name !== 'string') {
    throw new Error('GitHub 返回的版本信息不完整')
  }
  if (release.draft || release.prerelease) {
    throw new Error('当前没有可用的正式版本')
  }

  const latestVersion = normalizeVersion(release.tag_name)
  const download = chooseDownload(release.assets ?? [], platform, arch)

  return {
    currentVersion: normalizeVersion(currentVersion),
    latestVersion,
    releaseTag: release.tag_name,
    releaseName: release.name?.trim() || `FrameKit ${latestVersion}`,
    releaseNotes: (release.body ?? '').trim(),
    releaseUrl: release.html_url || RELEASE_PAGE,
    publishedAt: release.published_at,
    hasUpdate: isNewerVersion(latestVersion, currentVersion),
    downloadUrl: download?.browser_download_url ?? null,
    downloadName: download?.name ?? null
  }
}

let updateListener: ((state: UpdateDownloadState) => void) | null = null
let updaterWired = false
let installing = false
let lastProgress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }

function emitUpdateState(state: UpdateDownloadState): void {
  updateListener?.(state)
}

function readableUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/app-update\.yml|Cannot find module/i.test(message)) {
    return '缺少自动更新配置，请重新安装最新正式版后再试'
  }
  if (/latest(-mac)?\.yml|HTTP 404|status code 404/i.test(message)) {
    return 'GitHub 发布页缺少更新清单，请前往发布页手动下载安装包'
  }
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|ERR_INTERNET/i.test(message)) {
    return '更新包下载失败，请检查网络或代理后重试'
  }
  if (/code signature|signature/i.test(message)) {
    return '安装包签名校验失败，请前往发布页手动下载'
  }
  return message || '更新失败，请稍后重试'
}

export function canAutoUpdate(): boolean {
  return app.isPackaged && process.platform === 'win32'
}

export function initializeUpdater(onState: (state: UpdateDownloadState) => void): void {
  updateListener = onState
  if (updaterWired) return
  updaterWired = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  autoUpdater.on('download-progress', (progress) => {
    lastProgress = {
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    }
    emitUpdateState({ phase: 'downloading', ...lastProgress })
  })

  autoUpdater.on('update-downloaded', () => {
    emitUpdateState({
      phase: 'downloaded',
      percent: 100,
      transferred: lastProgress.total || lastProgress.transferred,
      total: lastProgress.total,
      bytesPerSecond: 0
    })
  })

  autoUpdater.on('error', (error) => {
    emitUpdateState({
      phase: 'error',
      ...lastProgress,
      message: readableUpdateError(error)
    })
  })
}

export async function downloadUpdate(): Promise<void> {
  if (!canAutoUpdate()) {
    throw new Error(
      process.platform === 'darwin'
        ? 'macOS 自动安装需要 Apple 开发者签名，当前请下载 DMG 覆盖安装'
        : '开发模式或当前平台不支持应用内自动更新，请使用打包后的安装版'
    )
  }

  installing = false
  lastProgress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
  emitUpdateState({ phase: 'downloading', ...lastProgress })

  try {
    const result = await autoUpdater.checkForUpdates()
    const latestVersion = result?.updateInfo.version
    if (!latestVersion) throw new Error('没有可用的更新信息')
    if (!isNewerVersion(latestVersion, app.getVersion())) {
      throw new Error('当前已是最新版本')
    }
    await autoUpdater.downloadUpdate()
  } catch (error) {
    const message = readableUpdateError(error)
    emitUpdateState({ phase: 'error', ...lastProgress, message })
    throw new Error(message)
  }
}

export async function installUpdate(): Promise<void> {
  if (!canAutoUpdate()) {
    throw new Error('当前版本不支持应用内安装更新')
  }
  if (installing) return
  installing = true

  await new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(true, true)
        resolve()
      } catch (error) {
        installing = false
        reject(new Error(readableUpdateError(error)))
      }
    })
  })
}
