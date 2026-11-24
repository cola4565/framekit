import { app, net, session } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateCheckResult, UpdateDownloadState } from '../src/shared/types'
import { isNewerVersion, normalizeVersion } from '../src/shared/version'
import {
  applyMirror,
  fetchLatestTag,
  fetchReleaseAssets,
  fetchReleaseFeed,
  findAssetApiUrl,
  parseCustomFeed,
  type Fetcher
} from './github-fallback'
import { getUpdateSettings } from './update-settings'

const RELEASE_API = 'https://api.github.com/repos/cola4565/framekit/releases/latest'
const RELEASE_PAGE = 'https://github.com/cola4565/framekit/releases/latest'
const RELEASE_TAG_PAGE = 'https://github.com/cola4565/framekit/releases/tag'

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
    return new Error('GitHub 请求频率受限')
  }
  return new Error(`检查更新失败（GitHub 返回 ${status}）`)
}

async function checkViaApi(
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string
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
    downloadName: download?.name ?? null,
    source: 'api'
  }
}

/**
 * API 限流时的回退通道：改用普通网页端点读取同一份 Release 数据。
 * 这些请求不占用 REST API 配额，代理出口 IP 被限流时依然可用。
 */
async function checkViaWebEndpoints(
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string
): Promise<UpdateCheckResult> {
  // 走 Electron 的 Chromium 网络栈，沿用系统代理设置；
  // 宿主 Node 的 fetch 不读取系统代理，用户开代理时会直接失败。
  const fetcher: Fetcher = (input, init) =>
    net.fetch(applyMirror(getUpdateSettings().mirror, input), {
      headers: init?.headers,
      redirect: init?.redirect,
      signal: AbortSignal.timeout(15000)
    })

  // 两个独立来源取最新正式版 tag，互为备份。
  // feed 的第一个条目就是最新正式版（atom 按发布时间倒序，且不含草稿/预发布）。
  const feed = await fetchReleaseFeed(fetcher)
  const tagName = (await fetchLatestTag(fetcher)) ?? feed?.tagName ?? null
  if (!tagName) {
    throw new Error('无法读取 GitHub 最新正式版，请稍后再试')
  }

  const latestVersion = normalizeVersion(tagName)
  const assets = await fetchReleaseAssets(tagName, fetcher)

  const assetList = (assets ?? []).map((asset) => ({
    name: asset.name,
    size: asset.size,
    browser_download_url: asset.browserDownloadUrl
  }))
  const download = chooseDownload(assetList, platform, arch)

  const matchedFeed = feed?.tagName === tagName ? feed : null

  return {
    currentVersion: normalizeVersion(currentVersion),
    latestVersion,
    releaseTag: tagName,
    releaseName: matchedFeed?.name || `FrameKit ${latestVersion}`,
    releaseNotes: matchedFeed?.body ?? '',
    releaseUrl: matchedFeed?.htmlUrl || `${RELEASE_TAG_PAGE}/${tagName}`,
    publishedAt: matchedFeed?.publishedAt ?? '',
    hasUpdate: isNewerVersion(latestVersion, currentVersion),
    downloadUrl: download?.browser_download_url ?? null,
    downloadName: download?.name ?? null,
    source: 'web'
  }
}

/**
 * 自建更新源（update feed）：一份描述最新版本的 JSON。
 * 不依赖 GitHub API 配额，适合放在自己的服务器或 CDN 上。
 */
async function checkViaCustomFeed(
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string,
  feedUrl: string,
  fetcher: Fetcher
): Promise<UpdateCheckResult> {
  const response = await fetcher(feedUrl, {
    headers: { 'user-agent': `FrameKit/${currentVersion}`, accept: 'application/json' },
    redirect: 'follow'
  })
  if (!response.ok) {
    throw new Error(`更新源返回 ${response.status}`)
  }
  const feed = parseCustomFeed(await response.json())
  if (!feed) {
    throw new Error('更新源返回的版本信息不完整')
  }

  const latestVersion = normalizeVersion(feed.version)
  const assets = (feed.assets ?? []).map((asset) => ({
    name: asset.name,
    size: asset.size ?? 0,
    browser_download_url: asset.url,
    api_url: asset.api ?? null
  }))
  const download = chooseDownload(assets, platform, arch)

  return {
    currentVersion: normalizeVersion(currentVersion),
    latestVersion,
    releaseTag: `v${latestVersion}`,
    releaseName: `FrameKit ${latestVersion}`,
    releaseNotes: feed.notes ?? '',
    releaseUrl: feed.url || RELEASE_PAGE,
    publishedAt: feed.published_at ?? '',
    hasUpdate: isNewerVersion(latestVersion, currentVersion),
    downloadUrl: download?.browser_download_url ?? null,
    downloadName: download?.name ?? null,
    source: 'feed'
  }
}

/**
 * 取得某个资产在 GitHub API 路由上的直链。
 * github.com 的下载地址在部分网络下会一直 504，而同一文件走 API 路由能立刻传输。
 */
export async function resolveAssetApiUrl(
  tagName: string,
  fileName: string,
  fetcher: Fetcher
): Promise<string | null> {
  try {
    const response = await fetcher(
      `https://api.github.com/repos/cola4565/framekit/releases/tags/${encodeURIComponent(tagName)}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'user-agent': 'FrameKit/updater'
        },
        redirect: 'follow'
      }
    )
    if (!response.ok) return null
    return findAssetApiUrl(await response.json(), fileName)
  } catch {
    return null
  }
}

export async function checkForUpdates(
  currentVersion: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): Promise<UpdateCheckResult> {
  const settings = getUpdateSettings()
  const fetcher: Fetcher = (input, init) =>
    net.fetch(input, {
      headers: init?.headers,
      redirect: init?.redirect,
      signal: AbortSignal.timeout(15000)
    })

  // 自建更新源优先：它不消耗 GitHub 配额，也不受 GitHub 限流影响。
  if (settings.source === 'custom' && settings.feedUrl) {
    try {
      return await checkViaCustomFeed(
        currentVersion,
        platform,
        arch,
        settings.feedUrl,
        fetcher
      )
    } catch (error) {
      // 自建源不通时继续走 GitHub，不让用户卡在单一数据源上。
      console.error('Custom update feed failed, falling back to GitHub:', error)
    }
  }

  try {
    return await checkViaApi(currentVersion, platform, arch)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 只对限流与网络抖动回退；版本解析类错误应直接暴露给用户。
    const recoverable = /频率受限|无法连接 GitHub|返回了无法读取/.test(message)
    if (!recoverable) throw error

    try {
      return await checkViaWebEndpoints(currentVersion, platform, arch)
    } catch {
      throw new Error(
        /频率受限/.test(message)
          ? 'GitHub 请求频率受限，且备用通道暂时不可用，请稍后再试'
          : message
      )
    }
  }
}

let updateListener: ((state: UpdateDownloadState) => void) | null = null
let updaterWired = false
let installing = false
let lastProgress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }

/**
 * 设置更新专用代理。
 * - `direct`：直连，不走系统代理。
 * - `http://` / `https://` / `socks5://` / `socks5h://`：指定代理。
 * - 留空：跟随系统代理（默认）。
 */
export async function applyUpdateProxy(proxy: string): Promise<void> {
  try {
    if (!proxy || proxy === 'direct') {
      await session.defaultSession.setProxy({ mode: 'direct' })
      return
    }
    await session.defaultSession.setProxy({ proxyRules: proxy })
  } catch (error) {
    console.error('FrameKit update proxy setup failed:', error)
  }
}

let mirrorInterceptorInstalled = false

/**
 * 把镜像应用到更新下载。
 *
 * electron-updater 自己发请求，不走我们的 fetcher，所以镜像在它的下载层拦截：
 * 用 session 的 webRequest 把 github.com 的地址改写到镜像前缀下。
 * 安装包的 SHA-512 校验仍由 electron-updater 按更新清单执行，
 * 镜像改了字节就装不上。
 */
function installMirrorInterceptor(): void {
  if (mirrorInterceptorInstalled) return
  mirrorInterceptorInstalled = true

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const mirror = getUpdateSettings().mirror
    if (!mirror) {
      callback({})
      return
    }
    const rewritten = applyMirror(mirror, details.url)
    callback(rewritten === details.url ? {} : { redirectURL: rewritten })
  })
}

/**
 * 把镜像前缀应用到 github.com 的地址上。
 * 更新清单与安装包都走镜像；清单里的 SHA-512 仍然用来校验下载到的文件，
 * 镜像改了字节就会校验失败，不会被安装。
 */
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

  // 更新专用代理：留空跟随系统代理；'direct' 表示直连。
  const settings = getUpdateSettings()
  if (settings.proxy) {
    void applyUpdateProxy(settings.proxy)
  }
  installMirrorInterceptor()

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
