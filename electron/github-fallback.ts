/**
 * GitHub API 限流（403 / 429）时的免鉴权回退通道。
 *
 * 这些端点属于普通网页请求，不消耗 REST API 配额：
 * - `releases/latest`：302 重定向到最新正式版 tag
 * - `releases.atom`：发布说明与发布时间
 * - `releases/expanded_assets/<tag>`：资产列表与下载地址
 */

export interface FallbackAsset {
  name: string
  size: number
  browserDownloadUrl: string
  apiUrl?: string
}

export interface FallbackRelease {
  tagName: string
  name: string
  body: string
  htmlUrl: string
  publishedAt: string
  assets: FallbackAsset[]
}

export type Fetcher = (
  input: string,
  init?: { headers?: Record<string, string>; redirect?: 'follow' | 'manual' }
) => Promise<Response>

export interface FeedRelease {
  version: string
  notes?: string
  url?: string
  published_at?: string
  assets?: Array<{
    name: string
    url: string
    size?: number
    api?: string
  }>
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseSizeLabel(label: string): number {
  const match = label.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i)
  if (!match) return 0
  const value = Number(match[1])
  const unit = match[2].toUpperCase()
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024
  }
  return Math.round(value * (multipliers[unit] ?? 1))
}

/**
 * 自建更新源（update feed）的响应格式。
 * magpie 用同样的思路：站点提供一份 JSON 描述最新版本，GitHub 只是备份。
 */
export function parseCustomFeed(payload: unknown): FeedRelease | null {
  if (!payload || typeof payload !== 'object') return null
  const feed = payload as Partial<FeedRelease>
  const version = typeof feed.version === 'string' ? feed.version.trim() : ''
  if (!version) return null
  return {
    version,
    notes: typeof feed.notes === 'string' ? feed.notes : '',
    url: typeof feed.url === 'string' ? feed.url : '',
    published_at:
      typeof feed.published_at === 'string' ? feed.published_at : '',
    assets: Array.isArray(feed.assets) ? feed.assets : []
  }
}

export interface ParsedFeed {
  tagName: string
  name: string
  body: string
  htmlUrl: string
  publishedAt: string
}

export function parseLatestTagFromHtml(html: string): string | null {
  const match =
    html.match(/<meta[^>]*property="og:url"[^>]*content="[^"]*\/releases\/tag\/([^"'?#]+)"/i) ??
    html.match(/<meta[^>]*content="[^"]*\/releases\/tag\/([^"'?#]+)"[^>]*property="og:url"/i) ??
    html.match(/\/releases\/tag\/(v\d+\.\d+\.\d+(?:-[^/?#"'<]+)?)/)
  if (!match) return null
  return decodeURIComponent(match[1])
}

export function parseReleaseFeed(xml: string): ParsedFeed | null {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g)
  if (!entries?.length) return null

  const entry = entries[0]
  // atom 的 id 形如 `tag:github.com,2008:Repository/1459836626/v1.3.3`，
  // 版本号在最后一段；兼容 `/releases/tag/<tag>` 写法。
  const tagMatch =
    entry.match(/<id>[^<]*\/releases\/tag\/([^<]+)<\/id>/) ??
    entry.match(/<id>[^<]*\/([^/<]+)<\/id>/)
  if (!tagMatch) return null

  const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/)
  const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/)
  const updatedMatch = entry.match(/<updated>([^<]+)<\/updated>/)
  const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)

  const rawBody = contentMatch?.[1] ?? ''
  const body = stripHtml(decodeEntities(rawBody))

  return {
    tagName: decodeEntities(tagMatch[1]).trim(),
    name: decodeEntities(titleMatch?.[1] ?? '').trim(),
    body,
    htmlUrl: linkMatch?.[1] ?? '',
    publishedAt: updatedMatch?.[1]?.trim() ?? ''
  }
}

export function parseReleaseAssets(html: string): FallbackAsset[] {
  const assets: FallbackAsset[] = []
  const itemPattern =
    /<a href="([^"]*\/releases\/download\/[^"]+)"[^>]*>\s*<span class="text-bold">([^<]+)<\/span>/g

  let match: RegExpExecArray | null
  while ((match = itemPattern.exec(html)) !== null) {
    const path = decodeEntities(match[1])
    const name = decodeEntities(match[2]).trim()
    if (!name) continue

    const tail = html.slice(match.index, match.index + 4000)
    const sizeMatch = tail.match(
      /class="color-fg-muted text-right flex-shrink-0 flex-grow-0[^"]*">\s*([\d.]+\s*[A-Za-z]+)\s*</
    )

    assets.push({
      name,
      size: sizeMatch ? parseSizeLabel(sizeMatch[1]) : 0,
      browserDownloadUrl: `https://github.com${path}`
    })
  }

  return assets
}

/**
 * GitHub 的 API 资产路由：`api.github.com/repos/<owner>/<repo>/releases/assets/<id>`。
 *
 * github.com 的下载地址（…/releases/download/<tag>/<file>）在部分网络下会一直返回
 * 504，而同一个文件走 API 路由（带 `Accept: application/octet-stream`）能立刻开始
 * 传输。magpie 也用这条路由作为下载失败后的第二条路。
 */
export function parseAssetApiUrl(assetUrl: string, tagName: string): string | null {
  const prefix = `https://github.com/`
  if (!assetUrl.startsWith(prefix)) return null
  const rest = assetUrl.slice(prefix.length)
  const parts = rest.split('/')
  if (parts.length !== 6) return null
  const [owner, repo, releases, download, tag, file] = parts
  if (releases !== 'releases' || download !== 'download') return null
  if (tag !== tagName) return null
  if (!file) return null
  return `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`
}

/**
 * 从 API 的 tag 响应里找出某个文件的 API 直链。
 * 返回 `api.github.com/repos/<owner>/<repo>/releases/assets/<id>`。
 */
export function findAssetApiUrl(
  tagResponse: unknown,
  fileName: string
): string | null {
  if (!tagResponse || typeof tagResponse !== 'object') return null
  const assets = (tagResponse as { assets?: unknown }).assets
  if (!Array.isArray(assets)) return null
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue
    const entry = asset as { name?: unknown; url?: unknown }
    if (entry.name !== fileName) continue
    if (typeof entry.url === 'string' && entry.url.startsWith('https://api.github.com/')) {
      return entry.url
    }
  }
  return null
}

/**
 * 把 github.com 的下载地址放到镜像前缀之后。
 * magpie 的做法：镜像只用于下载，更新清单仍然从源站读取，
 * 下载到的文件按源站给出的哈希校验，镜像改了字节就不会被安装。
 */
export function applyMirror(mirror: string, rawUrl: string): string {
  if (!mirror) return rawUrl
  let host = ''
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return rawUrl
  }
  const isGithub =
    host === 'github.com' ||
    host.endsWith('.github.com') ||
    host.endsWith('.githubusercontent.com')
  if (!isGithub) return rawUrl
  const prefix = mirror.endsWith('/') ? mirror : `${mirror}/`
  return `${prefix}${rawUrl}`
}

export async function fetchLatestTag(fetcher: Fetcher): Promise<string | null> {
  // Electron 的 net.fetch 不返回重定向后的最终 URL（response.url 为空串），
  // redirect: 'manual' 也会抛 "Redirect was cancelled"。
  // 因此改从页面里的 og:url 读取最新正式版 tag。
  const response = await fetcher(
    'https://github.com/cola4565/framekit/releases/latest',
    { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' }
  )
  if (!response.ok) return null
  const html = await response.text()
  return parseLatestTagFromHtml(html)
}

export async function fetchReleaseFeed(fetcher: Fetcher): Promise<ParsedFeed | null> {
  const response = await fetcher(
    'https://github.com/cola4565/framekit/releases.atom',
    { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' }
  )
  if (!response.ok) return null
  const xml = await response.text()
  return parseReleaseFeed(xml)
}

export async function fetchReleaseAssets(
  tagName: string,
  fetcher: Fetcher
): Promise<FallbackAsset[] | null> {
  const response = await fetcher(
    `https://github.com/cola4565/framekit/releases/expanded_assets/${encodeURIComponent(tagName)}`,
    { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' }
  )
  if (!response.ok) return null
  const html = await response.text()
  const assets = parseReleaseAssets(html)
  return assets.length ? assets : null
}
