import type { MediaResource } from './types'

const PROXY_HOST_SUFFIXES = [
  'bilibili.com',
  'bilivideo.com',
  'bilivideo.cn',
  'hdslb.com',
  'douyin.com',
  'douyinvod.com',
  'douyinpic.com',
  'aigei.com'
]

const THUMBNAIL_SCHEME = 'framekit-thumb'

function isBilibiliUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')
  } catch {
    return false
  }
}

export function needsMediaProxy(rawUrl: string | undefined, pageUrl?: string): boolean {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return false
  if (pageUrl && isBilibiliUrl(pageUrl)) return true
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return PROXY_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
    )
  } catch {
    return false
  }
}

export function toPreviewUrl(rawUrl: string, referer?: string): string {
  if (!needsMediaProxy(rawUrl, referer)) return rawUrl
  const params = new URLSearchParams({ url: rawUrl })
  const safeReferer = referer && /^https?:\/\//i.test(referer) ? referer : ''
  if (safeReferer) params.set('referer', safeReferer)
  return `framekit-media://media/?${params.toString()}`
}

export function toThumbnailUrl(rawUrl: string, referer?: string): string {
  if (!/^https?:\/\//i.test(rawUrl)) return rawUrl
  const params = new URLSearchParams({ url: rawUrl })
  const safeReferer = referer && /^https?:\/\//i.test(referer) ? referer : ''
  if (safeReferer) params.set('referer', safeReferer)
  return `${THUMBNAIL_SCHEME}://thumb/?${params.toString()}`
}

/**
 * HLS 清单本身不能直接播放，但可以下载分片后在本地封装成 MP4。
 * 目前只把 `.m3u8` 视为可下载流；DASH `.mpd` 仍需专用处理。
 */
export function isHlsResource(resource: MediaResource): boolean {
  if (!resource.isStream) return false
  try {
    return /\.m3u8$/i.test(new URL(resource.url).pathname)
  } catch {
    return false
  }
}

export function lowestQualityVariant(
  resource: MediaResource,
  all: MediaResource[] | undefined
): MediaResource {
  if (!resource.groupId || !all) return resource
  const siblings = all.filter(
    (item) => item.groupId === resource.groupId && item.kind === 'video' && item.audioUrl
  )
  if (siblings.length < 2) return resource
  return siblings.reduce((lowest, item) =>
    (item.height ?? 0) < (lowest.height ?? 0) ? item : lowest
  )
}
