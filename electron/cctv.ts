import { net } from 'electron'
import type { MediaResource, ParseProgress } from '../src/shared/types'
import { sanitizeFilename } from './extractor'
import {
  bestHlsVariant,
  parseHlsMaster,
  qualityLabelOfVariant,
  type HlsVariant
} from './hls'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 15000

interface CctvPageIds {
  guid: string
  parentGuid?: string
  serviceId: string
}

interface CctvVideoInfo {
  title?: string
  brief?: string
  img?: string
  len?: string
  pid?: string
}

interface CctvPlayInfo {
  hls_url?: string
  title?: string
  image?: string
  video?: { totalLength?: string }
}

export interface CctvExtractResult {
  finalUrl: string
  title: string
  description?: string
  favicon?: string
  resources: MediaResource[]
  warnings: string[]
}

function isCctvHost(hostname: string): boolean {
  return hostname === 'cctv.com' || hostname.endsWith('.cctv.com')
}

/**
 * 央视网的点播页有两种常见路径：
 * - `tv.cctv.com/2025/10/07/VIDE....shtml`
 * - `news.cctv.com/.../video/....shtml`
 */
export function isCctvVideoUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    const hostname = parsed.hostname.toLowerCase()
    if (!isCctvHost(hostname)) return false
    if (/\/(?:video|VIDE)/i.test(parsed.pathname)) return true
    return /\/\d{4}\/\d{2}\/\d{2}\/VIDE[A-Za-z0-9]+\.s?html?$/i.test(parsed.pathname)
  } catch {
    return false
  }
}

export function extractCctvIds(html: string): CctvPageIds | null {
  const guid =
    /var\s+guid\s*=\s*["']([a-f0-9]{32})["']/i.exec(html)?.[1] ??
    /videoCenterId\s*[:=]\s*["']([a-f0-9]{32})["']/i.exec(html)?.[1]
  if (!guid) return null

  const parentGuid = /var\s+parentGuid\s*=\s*["']([a-f0-9]{32})["']/i.exec(html)?.[1]
  const serviceId =
    /serviceId\s*[:=]\s*["']([A-Za-z0-9_-]+)["']/i.exec(html)?.[1] ??
    /[?&]serviceId=([A-Za-z0-9_-]+)/i.exec(html)?.[1] ??
    'tvcctv'

  return { guid, parentGuid, serviceId }
}

function parseDurationText(value: string | undefined): number | undefined {
  if (!value) return undefined
  const clock = /^(\d+):(\d{2}):(\d{2})$/.exec(value.trim())
  if (clock) {
    return (
      Number.parseInt(clock[1], 10) * 3600 +
      Number.parseInt(clock[2], 10) * 60 +
      Number.parseInt(clock[3], 10)
    )
  }
  const seconds = Number.parseFloat(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function absoluteUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return undefined
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await net.fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://tv.cctv.com/'
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`CCTV 接口返回 HTTP ${response.status}`)
  }
  return response.text()
}

async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('CCTV 接口返回了无法读取的数据')
  }
}

async function loadPlayInfo(
  ids: CctvPageIds,
  info: CctvVideoInfo
): Promise<{ pid: string; play: CctvPlayInfo }> {
  const candidates = [ids.parentGuid, info.pid, ids.guid].filter(
    (value): value is string => Boolean(value)
  )
  let lastError: unknown

  for (const pid of candidates) {
    try {
      const play = await fetchJson<CctvPlayInfo>(
        `https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=${encodeURIComponent(pid)}`
      )
      if (play.hls_url) return { pid, play }
      lastError = new Error('播放接口没有返回 HLS 地址')
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('没有找到可播放的视频信息')
}

export async function extractCctvPage(
  pageUrl: string,
  onProgress: (progress: ParseProgress) => void
): Promise<CctvExtractResult> {
  onProgress({ stage: 'browser', message: '识别到央视网，正在读取页面视频编号…', percent: 46 })

  const html = await fetchText(pageUrl)
  const ids = extractCctvIds(html)
  if (!ids) throw new Error('页面里没有找到央视网视频编号')

  onProgress({ stage: 'parse', message: '正在读取央视网播放信息…', percent: 58 })
  const info = await fetchJson<CctvVideoInfo>(
    `https://api.cntv.cn/video/videoinfoByGuid?guid=${encodeURIComponent(ids.guid)}&serviceId=${encodeURIComponent(ids.serviceId)}`
  )
  const { pid, play } = await loadPlayInfo(ids, info)

  const hlsUrl = absoluteUrl(play.hls_url, pageUrl)
  if (!hlsUrl) throw new Error('央视网没有返回可用的 HLS 播放地址')

  onProgress({ stage: 'parse', message: '正在读取 HLS 清晰度清单…', percent: 72 })

  let variants: HlsVariant[] = []
  try {
    const master = await fetchText(hlsUrl)
    variants = parseHlsMaster(master, hlsUrl)
  } catch {
    // 清单读取失败时仍然保留 HLS 地址，下载阶段会再试一次。
  }
  if (variants.length === 0) variants = [{ url: hlsUrl }]

  const title =
    info.title?.trim() || play.title?.trim() || new URL(pageUrl).hostname
  const titleBase = sanitizeFilename(title.replace(/\.[a-z0-9]{1,8}$/i, '')).slice(0, 80)
  const poster = absoluteUrl(info.img || play.image, pageUrl)
  const duration =
    Number.parseFloat(play.video?.totalLength ?? '') || parseDurationText(info.len)
  const groupId = `cctv-${pid}`
  const warnings: string[] = [
    '央视网使用 HLS 分片，下载时会自动抓取分片并封装为 MP4（含音轨）。'
  ]

  const resources: MediaResource[] = variants.map((variant, index) => {
    const quality = qualityLabelOfVariant(variant)
    const detail = [
      variant.width && variant.height ? `${variant.width}×${variant.height}` : '',
      variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : ''
    ]
      .filter(Boolean)
      .join(' · ')

    return {
      id: `cctv_${pid}_${variant.height ?? variant.bandwidth ?? index}`,
      url: variant.url,
      kind: 'video',
      source: 'network',
      pageUrl,
      filename: `${titleBase || 'cctv-video'}-${sanitizeFilename(quality)}.mp4`,
      extension: 'mp4',
      mime: 'video/mp4',
      width: variant.width,
      height: variant.height,
      duration,
      poster,
      label: ['CCTV', detail].filter(Boolean).join(' · '),
      discoveryLabel: '央视网 HLS · 自动封装 MP4',
      isStream: true,
      qualityLabel: quality,
      groupId
    }
  })

  if (resources.length === 1) {
    const only = bestHlsVariant(variants)
    const detail = only?.height
      ? `${only.width ?? ''}×${only.height}`.replace(/^×/, '')
      : only?.bandwidth
        ? `${Math.round(only.bandwidth / 1000)} kbps`
        : '单一清晰度'
    warnings.push(`站点当前只提供 ${detail} 这一路 HLS 清晰度，没有更高码率可选。`)
  }

  onProgress({
    stage: 'merge',
    message: `央视网解析完成，共 ${resources.length} 个 HLS 清晰度`,
    percent: 90
  })

  return {
    finalUrl: pageUrl,
    title,
    description: info.brief?.trim() || undefined,
    favicon: 'https://tv.cctv.com/favicon.ico',
    resources,
    warnings
  }
}
