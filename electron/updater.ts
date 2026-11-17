import { net } from 'electron'
import type { UpdateCheckResult } from '../src/shared/types'
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
