import { createHash } from 'node:crypto'
import type { DiscoverySource, ResourceKind } from '../src/shared/types'

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'svg',
  'heic',
  'heif',
  'tif',
  'tiff'
])

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
  'avi',
  'flv',
  'wmv',
  'mpeg',
  'mpg',
  'ts',
  'm3u8',
  'mpd'
])

const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'ogg',
  'oga',
  'opus',
  'wma',
  'aiff',
  'aif'
])

const SUBTITLE_EXTENSIONS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub'])

const STRONG_MEDIA_KEYS = new Set([
  'videourl',
  'video_url',
  'videofile',
  'video_file',
  'playurl',
  'play_url',
  'playaddr',
  'play_addr',
  'streamurl',
  'stream_url',
  'hlsurl',
  'hls_url',
  'dashurl',
  'dash_url',
  'mp4url',
  'mp4_url',
  'm3u8url',
  'm3u8_url',
  'mpdurl',
  'mpd_url',
  'audiourl',
  'audio_url',
  'audiofile',
  'audio_file',
  'musicurl',
  'music_url',
  'soundurl',
  'sound_url',
  'backupurl',
  'backup_url',
  'backupurls',
  'backup_urls',
  'mainurl',
  'main_url',
  'sourceurl',
  'source_url',
  'contenturl',
  'content_url',
  'downloadurl',
  'download_url',
  'fileurl',
  'file_url',
  'mediaurl',
  'media_url'
])

const URL_KEYS = new Set([
  'url',
  'src',
  'file',
  'link',
  'path',
  'address',
  'source',
  'stream',
  'play',
  'video',
  'audio',
  'media',
  'download',
  'content'
])

const IMAGE_KEYS = new Set([
  'image',
  'imageurl',
  'image_url',
  'img',
  'imgurl',
  'img_url',
  'pic',
  'picurl',
  'pic_url',
  'picture',
  'poster',
  'posterurl',
  'poster_url',
  'cover',
  'coverurl',
  'cover_url',
  'thumbnail',
  'thumbnailurl',
  'thumbnail_url',
  'thumb',
  'thumburl',
  'thumb_url'
])

const AUDIO_KEYS = new Set([
  'audio',
  'audiourl',
  'audio_url',
  'audiofile',
  'audio_file',
  'music',
  'musicurl',
  'music_url',
  'sound',
  'soundurl',
  'sound_url'
])

const SUBTITLE_KEYS = new Set([
  'subtitle',
  'subtitles',
  'caption',
  'captions',
  'vtt',
  'srt',
  'ass'
])

const QUALITY_LABEL_KEYS = [
  'qualitylabel',
  'quality_label',
  'qualityname',
  'quality_name',
  'definition',
  'def',
  'grade'
]

const QUALITY_ID_KEYS = ['quality', 'qn', 'qualityid', 'quality_id']
const WIDTH_KEYS = ['width', 'videowidth', 'video_width']
const HEIGHT_KEYS = ['height', 'videoheight', 'video_height']
const DURATION_KEYS = ['duration', 'length', 'videoduration', 'video_duration']
const SIZE_KEYS = ['size', 'filesize', 'file_size', 'contentlength', 'content_length']
const POSTER_KEYS = ['poster', 'cover', 'thumbnail', 'thumb', 'pic']
const TITLE_KEYS = ['title', 'caption', 'description', 'name', 'filename']
const IDENTITY_KEYS = [
  'id',
  'vid',
  'videoId',
  'video_id',
  'bvid',
  'cid',
  'guid',
  'fileId',
  'file_id',
  'mediaId',
  'media_id',
  'episodeId',
  'episode_id',
  'aid',
  'avid',
  'dashId',
  'dash_id'
]

const MAX_DEPTH = 14
const MAX_NODES = 16000
const MAX_STRING_LENGTH = 1_500_000
const MAX_CANDIDATES = 500
const MIN_SCORE = 4
const IGNORED_IDENTITIES = new Set(['0', '-1', 'null', 'undefined', 'false', 'none'])

const NOISE_HOST_PATTERNS = [
  /(?:^|\.)google-analytics\.com$/i,
  /(?:^|\.)googletagmanager\.com$/i,
  /(?:^|\.)doubleclick\.net$/i,
  /(?:^|\.)sentry\.io$/i,
  /(?:^|\.)bugsnag\.com$/i,
  /(?:^|\.)hm\.baidu\.com$/i,
  /(?:^|\.)cnzz\.com$/i,
  /(?:^|\.)umeng\.com$/i,
  /(?:^|\.)clarity\.ms$/i,
  /(?:^|\.)hotjar\.com$/i
]

const NOISE_PATH_PATTERN = /(?:analytics|collect|beacon|tracking|telemetry|pageview|\/log(?:ging)?\/)/i
const NOISE_KEY_PATTERN = /(?:avatar|icon|logo|sprite|emoji|badge|qrcode|qr_code|favicon)/i
const WEAK_PATH_PATTERN = /(?:recommend|related|hot|rank|banner|advert|advertise|promo|sidebar|footer|header)/i
const MEDIA_PATH_PATTERN =
  /(?:video|videos|movie|play|player|stream|media|audio|music|hls|dash|source|file|download|mp4|m3u8|mpd)/i
const PLAY_HINT_PATTERN = /(?:^|[._])play(?:er)?/

export interface GenericMediaCandidate {
  url: string
  hint?: ResourceKind
  source: DiscoverySource
  discoveryLabel: string
  label?: string
  mime?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  poster?: string
  audioUrl?: string
  audioMime?: string
  qualityId?: number
  qualityLabel?: string
  groupId?: string
  score: number
}

export interface GenericScanContext {
  pageUrl: string
  baseUrl: string
  requestUrl?: string
  discoveryLabel: string
  source: DiscoverySource
  groupIdPrefix?: string
}

export interface GenericScanResult {
  candidates: GenericMediaCandidate[]
  truncated: boolean
}

export interface EmbeddedScript {
  type?: string
  id?: string
  text: string
}

export interface EmbeddedScanResult extends GenericScanResult {
  stateCount: number
  warnings: string[]
}

interface QualityInfo {
  label?: string
  id?: number
  width?: number
  height?: number
  duration?: number
  size?: number
}

interface UrlValue {
  url: string
  mime?: string
}

function hashKey(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function decodeEscapedUrl(value: string): string {
  return value
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003f/gi, '?')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
}

function absoluteUrl(rawValue: unknown, baseUrl: string): string | undefined {
  if (typeof rawValue !== 'string') return undefined
  let raw = decodeEscapedUrl(rawValue.trim())
  raw = raw.replace(/^['"`]|['"`]$/g, '').trim()
  if (!raw || raw.length > 20_000) return undefined
  if (/^(?:data|blob|javascript|mailto|tel|about|file):/i.test(raw)) return undefined
  if (raw.startsWith('#') || /\$\{|\{\{|\}\}/.test(raw)) return undefined

  try {
    const parsed = new URL(raw, baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    parsed.hash = ''
    return parsed.href
  } catch {
    return undefined
  }
}

function extensionOf(url: string): string {
  try {
    const parsed = new URL(url)
    const basename = decodeURIComponent(parsed.pathname.split('/').pop() ?? '')
    const extension = /\.([a-z0-9]{1,8})$/i.exec(basename)?.[1]
    if (extension) return extension.toLowerCase()
    const formatHint = parsed.search.match(
      /(?:format|type|ext|fm|output)=(jpe?g|png|gif|webp|avif|mp4|webm|mov|m3u8|mpd|mp3|wav|flac|m4a|aac)/i
    )
    return formatHint?.[1]?.toLowerCase() ?? ''
  } catch {
    return ''
  }
}

function kindFromExtension(extension: string): ResourceKind | undefined {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (SUBTITLE_EXTENSIONS.has(extension)) return 'other'
  return undefined
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, '')
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseFloat(value.replace(/,/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item)
      if (found) return found
    }
  }
  return undefined
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const found = finiteNumber(record[key])
    if (found !== undefined) return found
  }
  return undefined
}

function sizeFromRecord(record: Record<string, unknown>): number | undefined {
  for (const key of SIZE_KEYS) {
    const value = record[key]
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value > 0) return value
      continue
    }
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || /[x×]/i.test(trimmed)) continue
    const unitMatch = /^([\d.]+)\s*(kb|kib|mb|mib|gb|gib|b)$/i.exec(trimmed)
    if (unitMatch) {
      const amount = Number.parseFloat(unitMatch[1])
      if (!Number.isFinite(amount) || amount <= 0) continue
      const unit = unitMatch[2].toLowerCase()
      const multiplier =
        unit === 'gb' || unit === 'gib'
          ? 1024 ** 3
          : unit === 'mb' || unit === 'mib'
            ? 1024 ** 2
            : unit === 'kb' || unit === 'kib'
              ? 1024
              : 1
      return Math.round(amount * multiplier)
    }
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const amount = Number.parseFloat(trimmed)
      if (Number.isFinite(amount) && amount > 0) return amount
    }
  }
  return undefined
}

function firstText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed && !/^https?:\/\//i.test(trimmed)) return trimmed
    }
  }
  return undefined
}

function hintFromKey(key: string): ResourceKind | undefined {
  const normalized = normalizeKey(key)
  if (!normalized) return undefined
  if (AUDIO_KEYS.has(normalized) || /(?:^|_)audio(?:$|_)|music|sound|voice/.test(normalized)) {
    return 'audio'
  }
  if (SUBTITLE_KEYS.has(normalized) || /subtitle|caption/.test(normalized)) return 'other'
  if (IMAGE_KEYS.has(normalized) || /(?:^|_)(?:image|img|pic|poster|cover|thumbnail|thumb)(?:$|_)/.test(normalized)) {
    return 'image'
  }
  if (
    STRONG_MEDIA_KEYS.has(normalized) ||
    /video|movie|film|stream|hls|dash|mp4|m3u8|mpd/.test(normalized) ||
    PLAY_HINT_PATTERN.test(normalized)
  ) {
    return 'video'
  }
  return undefined
}

function hintFromPath(path: string[]): ResourceKind | undefined {
  const joined = path.join('.').toLowerCase()
  if (/audio|music|sound|voice/.test(joined)) return 'audio'
  if (/subtitle|caption/.test(joined)) return 'other'
  if (/image|img|poster|cover|thumbnail|thumb/.test(joined)) return 'image'
  if (
    /video|movie|film|stream|media|hls|dash|quality|qualities|source/.test(joined) ||
    PLAY_HINT_PATTERN.test(joined)
  ) {
    return 'video'
  }
  return undefined
}

function hintFromRecord(record: Record<string, unknown>): ResourceKind | undefined {
  for (const key of ['mediaType', 'media_type', 'mimeType', 'mime_type', 'mime', 'contentType', 'content_type', 'type', 'format']) {
    const value = record[key]
    if (typeof value !== 'string') continue
    const lower = value.toLowerCase()
    if (lower.startsWith('audio/')) return 'audio'
    if (lower.startsWith('video/') || lower.includes('mpegurl') || lower.includes('dash+xml')) {
      return 'video'
    }
    if (lower.startsWith('image/')) return 'image'
    if (lower === 'audio' || lower === 'music') return 'audio'
    if (lower === 'video' || lower === 'movie' || lower === 'hls' || lower === 'dash') return 'video'
    if (lower === 'image' || lower === 'picture') return 'image'
  }
  return undefined
}

function looksLikeMediaUrl(url: string): boolean {
  const extension = extensionOf(url)
  if (kindFromExtension(extension)) return true
  try {
    const parsed = new URL(url)
    const haystack = `${parsed.pathname}${parsed.search}`.toLowerCase()
    return /(?:^|[./_-])(?:m3u8|mpd|mp4|webm|m4v|mp3|m4a|aac|flac|wav)(?:$|[?&#/_-])/.test(
      haystack
    )
  } catch {
    return false
  }
}

function looksLikeLikelyMediaEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (NOISE_PATH_PATTERN.test(parsed.pathname)) return false
    const haystack = `${parsed.pathname}${parsed.search}`.toLowerCase()
    if (WEAK_PATH_PATTERN.test(haystack)) return false
    if (/\.(?:html?|php|aspx?|jsp|do)$/i.test(parsed.pathname)) return false
    return MEDIA_PATH_PATTERN.test(haystack)
  } catch {
    return false
  }
}

function looksLikeApiEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url)
    const haystack = `${parsed.pathname}${parsed.search}`.toLowerCase()
    return (
      /(?:^|\/)(?:api|ajax|graphql)\//.test(haystack) ||
      /(?:playurl|getplay|playinfo|videoinfo|getvideo|getdetail|detail)\b/.test(haystack)
    )
  } catch {
    return true
  }
}

function isNoiseUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (NOISE_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) return true
    if (NOISE_PATH_PATTERN.test(parsed.pathname)) return true
    if (/\/favicon\.ico(?:$|\?)/i.test(parsed.toString())) return true
    return false
  } catch {
    return true
  }
}

function qualityFromRecord(record: Record<string, unknown>): QualityInfo {
  const info: QualityInfo = {}
  const label = firstText(record, QUALITY_LABEL_KEYS)
  if (label && label.length <= 40) info.label = label

  for (const key of QUALITY_ID_KEYS) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      info.id = Math.round(value)
      break
    }
  }

  info.width = firstNumber(record, WIDTH_KEYS)
  info.height = firstNumber(record, HEIGHT_KEYS)

  const resolution = record.resolution
  if (typeof resolution === 'string') {
    const match = /(\d{2,5})\s*[x×]\s*(\d{2,5})/i.exec(resolution)
    if (match) {
      info.width ??= Number.parseInt(match[1], 10)
      info.height ??= Number.parseInt(match[2], 10)
    }
  }

  if (!info.label && info.height) info.label = `${info.height}P`
  if (!info.label) {
    const definition = record.definition
    if (typeof definition === 'string' && /^(?:\d{3,4}[pPiI]|4k|8k)$/i.test(definition.trim())) {
      info.label = definition.trim().toUpperCase()
    }
  }

  const durationMs = finiteNumber(record.durationMs ?? record.duration_ms)
  const duration = firstNumber(record, DURATION_KEYS)
  info.duration = durationMs ? durationMs / 1000 : duration
  info.size = sizeFromRecord(record)
  return info
}

function mimeFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ['mimeType', 'mime_type', 'mime', 'contentType', 'content_type']) {
    const value = record[key]
    if (typeof value === 'string' && /^[\w.+-]+\/[\w.+-]+/i.test(value)) {
      return value.split(';')[0].trim().toLowerCase()
    }
  }
  return undefined
}

function posterFromRecord(record: Record<string, unknown>, baseUrl: string): string | undefined {
  for (const key of POSTER_KEYS) {
    const value = record[key]
    const url = typeof value === 'string' ? absoluteUrl(value, baseUrl) : extractUrlValue(value, baseUrl)?.url
    if (url) return url
  }
  return undefined
}

function labelFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of TITLE_KEYS) {
    const value = record[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (
        trimmed &&
        trimmed.length <= 120 &&
        !/^https?:\/\//i.test(trimmed) &&
        !/^(?:\d{3,4}[pPiI]|4k|8k|hdr|h\.?265|av1)$/i.test(trimmed)
      ) {
        return trimmed
      }
    }
  }
  return undefined
}

function extractUrlValue(value: unknown, baseUrl: string): UrlValue | undefined {
  if (typeof value === 'string') {
    const url = absoluteUrl(value, baseUrl)
    return url ? { url } : undefined
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractUrlValue(item, baseUrl)
      if (found) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  for (const key of ['url', 'src', 'baseUrl', 'base_url', 'playUrl', 'play_url', 'backupUrl', 'backup_url']) {
    const url = absoluteUrl(record[key], baseUrl)
    if (url) {
      return {
        url,
        mime: mimeFromRecord(record)
      }
    }
  }
  return undefined
}

function extractUrlByKeys(
  record: Record<string, unknown>,
  keys: string[],
  baseUrl: string
): UrlValue | undefined {
  for (const key of keys) {
    const found = extractUrlValue(record[key], baseUrl)
    if (found) return found
  }
  return undefined
}

function identityOf(record: Record<string, unknown>): string | undefined {
  for (const key of IDENTITY_KEYS) {
    const value = record[key]
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim()
      if (!text || text.length > 120) continue
      if (IGNORED_IDENTITIES.has(text.toLowerCase())) continue
      return `${key}:${text}`
    }
  }
  return undefined
}

function groupIdFor(
  context: GenericScanContext,
  path: string[],
  record?: Record<string, unknown>,
  inheritedGroup?: string
): string {
  const identity = record ? identityOf(record) : undefined
  if (identity) {
    return `generic-${hashKey(`${context.groupIdPrefix ?? context.pageUrl}|${identity}`)}`
  }
  if (inheritedGroup) return inheritedGroup
  const stablePath = path.filter((segment) => !/^\d+$/.test(segment)).join('.')
  return `generic-${hashKey(
    `${context.groupIdPrefix ?? context.requestUrl ?? context.pageUrl}|${stablePath}`
  )}`
}

function registerCandidate(
  map: Map<string, GenericMediaCandidate>,
  candidate: GenericMediaCandidate
): void {
  if (map.size >= MAX_CANDIDATES) return
  const existing = map.get(candidate.url)
  if (!existing) {
    map.set(candidate.url, candidate)
    return
  }

  map.set(candidate.url, {
    ...existing,
    hint: existing.hint ?? candidate.hint,
    label: existing.label ?? candidate.label,
    mime: existing.mime ?? candidate.mime,
    size: existing.size ?? candidate.size,
    width: existing.width ?? candidate.width,
    height: existing.height ?? candidate.height,
    duration: existing.duration ?? candidate.duration,
    poster: existing.poster ?? candidate.poster,
    audioUrl: existing.audioUrl ?? candidate.audioUrl,
    audioMime: existing.audioMime ?? candidate.audioMime,
    qualityId: existing.qualityId ?? candidate.qualityId,
    qualityLabel: existing.qualityLabel ?? candidate.qualityLabel,
    groupId: existing.groupId ?? candidate.groupId,
    score: Math.max(existing.score, candidate.score),
    discoveryLabel:
      existing.score >= candidate.score ? existing.discoveryLabel : candidate.discoveryLabel
  })
}

function candidateScore(
  url: string,
  key: string | undefined,
  hint: ResourceKind | undefined,
  strongKey: boolean,
  inheritedHint: ResourceKind | undefined,
  path: string[],
  hasPair: boolean
): number {
  let score = 0
  const joinedPath = path.join('.').toLowerCase()
  if (looksLikeMediaUrl(url)) score += 6
  if (strongKey) score += 4
  if (hint) score += 1
  if (inheritedHint) score += 1
  if (hint && inheritedHint && hint !== inheritedHint) score += 1
  if (key && (URL_KEYS.has(key) || IMAGE_KEYS.has(key) || AUDIO_KEYS.has(key)) && inheritedHint) {
    score += 1
  }
  if (hasPair) score += 2
  if (looksLikeLikelyMediaEndpoint(url)) score += 1
  if (joinedPath.match(MEDIA_PATH_PATTERN)) score += 1
  if (key && NOISE_KEY_PATTERN.test(key)) score -= 5
  if (key && WEAK_PATH_PATTERN.test(key)) score -= 2
  if (NOISE_KEY_PATTERN.test(joinedPath)) score -= 5
  if (WEAK_PATH_PATTERN.test(joinedPath)) score -= 2
  if (isNoiseUrl(url)) score -= 10
  if (!looksLikeMediaUrl(url) && looksLikeApiEndpoint(url)) score -= 8
  if (!looksLikeMediaUrl(url) && !looksLikeLikelyMediaEndpoint(url)) score -= 3
  return score
}

export function scanJsonPayload(
  payload: unknown,
  context: GenericScanContext
): GenericScanResult {
  const candidates = new Map<string, GenericMediaCandidate>()
  let nodes = 0
  let truncated = false

  const walk = (
    value: unknown,
    path: string[],
    inheritedHint: ResourceKind | undefined,
    inheritedLabel: string | undefined,
    inheritedPoster: string | undefined,
    inheritedGroup: string | undefined,
    depth: number
  ): void => {
    if (depth > MAX_DEPTH) {
      truncated = true
      return
    }
    if (value == null) return
    if (typeof value === 'string') {
      if (value.length <= MAX_STRING_LENGTH && /^[\s]*[{[][\s\S]*[}\]]\s*$/.test(value)) {
        try {
          walk(
            JSON.parse(value),
            path,
            inheritedHint,
            inheritedLabel,
            inheritedPoster,
            inheritedGroup,
            depth + 1
          )
        } catch {
          // 普通字符串里也会出现 URL，交给下面的直接扫描。
        }
      }
      return
    }
    if (Array.isArray(value)) {
      nodes += 1
      if (nodes > MAX_NODES) {
        truncated = true
        return
      }
      for (const item of value) {
        walk(
          item,
          path,
          inheritedHint,
          inheritedLabel,
          inheritedPoster,
          inheritedGroup,
          depth + 1
        )
      }
      return
    }
    if (typeof value !== 'object') return

    nodes += 1
    if (nodes > MAX_NODES) {
      truncated = true
      return
    }

    const record = value as Record<string, unknown>
    const recordHint = hintFromRecord(record)
    const contextHint = hintFromPath(path) ?? inheritedHint
    const objectHint = recordHint ?? contextHint
    const quality = qualityFromRecord(record)
    const mime = mimeFromRecord(record)
    const poster = posterFromRecord(record, context.baseUrl) ?? inheritedPoster
    const label = labelFromRecord(record) ?? inheritedLabel
    const groupId = groupIdFor(context, path, record, inheritedGroup)

    const videoValue =
      extractUrlByKeys(record, [
        'videoUrl',
        'video_url',
        'playUrl',
        'play_url',
        'playAddr',
        'play_addr',
        'streamUrl',
        'stream_url',
        'hlsUrl',
        'hls_url',
        'dashUrl',
        'dash_url',
        'mp4Url',
        'mp4_url',
        'm3u8Url',
        'm3u8_url',
        'mpdUrl',
        'mpd_url',
        'mainUrl',
        'main_url',
        'backupUrl',
        'backup_url',
        'fileUrl',
        'file_url'
      ], context.baseUrl) ?? extractUrlValue(record.video, context.baseUrl)

    const audioValue =
      extractUrlByKeys(record, [
        'audioUrl',
        'audio_url',
        'audioFile',
        'audio_file',
        'musicUrl',
        'music_url',
        'soundUrl',
        'sound_url'
      ], context.baseUrl) ?? extractUrlValue(record.audio, context.baseUrl)

    const fallbackVideoUrl =
      objectHint === 'video'
        ? extractUrlByKeys(record, ['url', 'src', 'file', 'source', 'stream'], context.baseUrl)
        : undefined
    const videoUrl = videoValue ?? fallbackVideoUrl
    const pairedAudioUrl =
      audioValue &&
      (looksLikeMediaUrl(audioValue.url) || !looksLikeApiEndpoint(audioValue.url))
        ? audioValue.url
        : undefined

    if (videoUrl) {
      const score = candidateScore(
        videoUrl.url,
        'videoUrl',
        'video',
        true,
        objectHint,
        path,
        Boolean(audioValue)
      )
      if (score >= MIN_SCORE) {
        registerCandidate(candidates, {
          url: videoUrl.url,
          hint: 'video',
          source: context.source,
          discoveryLabel: context.discoveryLabel,
          label,
          mime: videoUrl.mime ?? mime,
          size: quality.size,
          width: quality.width,
          height: quality.height,
          duration: quality.duration,
          poster,
          audioUrl: pairedAudioUrl,
          audioMime: pairedAudioUrl ? audioValue?.mime : undefined,
          qualityId: quality.id,
          qualityLabel: quality.label,
          groupId,
          score
        })
      }
    }

    if (audioValue && audioValue.url !== videoUrl?.url) {
      const score = candidateScore(
        audioValue.url,
        'audioUrl',
        'audio',
        true,
        'audio',
        path,
        Boolean(videoUrl)
      )
      if (score >= MIN_SCORE) {
        registerCandidate(candidates, {
          url: audioValue.url,
          hint: 'audio',
          source: context.source,
          discoveryLabel: context.discoveryLabel,
          label,
          mime: audioValue.mime ?? mime,
          duration: quality.duration,
          groupId,
          score
        })
      }
    }

    for (const [rawKey, child] of Object.entries(record)) {
      if (rawKey === '__proto__' || rawKey === 'constructor' || rawKey === 'prototype') continue
      const key = normalizeKey(rawKey)
      const childHint = hintFromKey(rawKey) ?? objectHint
      const strongKey =
        STRONG_MEDIA_KEYS.has(key) || IMAGE_KEYS.has(key) || AUDIO_KEYS.has(key)
      const isUrlKey = URL_KEYS.has(key)

      if (typeof child === 'string') {
        const childUrl = absoluteUrl(child, context.baseUrl)
        if (!childUrl) continue
        if (childUrl === videoUrl?.url || childUrl === audioValue?.url) continue
        if (
          !looksLikeMediaUrl(childUrl) &&
          !strongKey &&
          !(isUrlKey && objectHint) &&
          !looksLikeLikelyMediaEndpoint(childUrl)
        ) {
          continue
        }
        const candidateHint = kindFromExtension(extensionOf(childUrl)) ?? childHint
        const score = candidateScore(
          childUrl,
          key,
          candidateHint,
          strongKey,
          objectHint,
          path,
          false
        )
        if (score < MIN_SCORE) continue
        registerCandidate(candidates, {
          url: childUrl,
          hint: candidateHint,
          source: context.source,
          discoveryLabel: context.discoveryLabel,
          label,
          mime: candidateHint === 'audio' ? mime : undefined,
          size: quality.size,
          width: quality.width,
          height: quality.height,
          duration: quality.duration,
          poster: candidateHint === 'image' ? undefined : poster,
          qualityId: quality.id,
          qualityLabel: quality.label,
          groupId: candidateHint === 'video' ? groupId : undefined,
          score
        })
        continue
      }

      if (Array.isArray(child)) {
        if (key && NOISE_KEY_PATTERN.test(key) && !looksLikeMediaUrl(firstString(child) ?? '')) {
          continue
        }
        walk(
          child,
          [...path, rawKey],
          childHint,
          label,
          poster,
          groupId,
          depth + 1
        )
        continue
      }

      if (child && typeof child === 'object') {
        walk(
          child,
          [...path, rawKey],
          childHint,
          label,
          poster,
          groupId,
          depth + 1
        )
      }
    }
  }

  walk(payload, [], undefined, undefined, undefined, undefined, 0)

  return {
    candidates: [...candidates.values()].sort((a, b) => b.score - a.score),
    truncated
  }
}

function sliceBalancedJson(text: string, startIndex: number): string | null {
  const open = text[startIndex]
  if (open !== '{' && open !== '[') return null
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let quote = ''
  let escaped = false
  const limit = Math.min(text.length, startIndex + MAX_STRING_LENGTH)

  for (let index = startIndex; index < limit; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === quote) inString = false
      continue
    }

    if (character === '"' || character === "'") {
      inString = true
      quote = character
      continue
    }
    if (character === open) depth += 1
    if (character === close) {
      depth -= 1
      if (depth === 0) return text.slice(startIndex, index + 1)
    }
  }
  return null
}

function parseJsonLoose(text: string): unknown | null {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // JSONP：callback({...}); 或 HTML 注释包裹的 JSON。
  }

  const jsonp = /^[\w$.]+\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/.exec(trimmed)
  if (jsonp) {
    try {
      return JSON.parse(jsonp[1])
    } catch {
      return null
    }
  }

  const firstObject = trimmed.search(/[{\[]/)
  if (firstObject < 0) return null
  const balanced = sliceBalancedJson(trimmed, firstObject)
  if (!balanced) return null
  try {
    return JSON.parse(balanced)
  } catch {
    return null
  }
}

export function parseJsonText(text: string): unknown | null {
  return parseJsonLoose(text)
}

const KNOWN_STATE_NAMES = [
  '__INITIAL_STATE__',
  '__NEXT_DATA__',
  '__NUXT__',
  '__APOLLO_STATE__',
  '__PRELOADED_STATE__',
  '__INITIAL_DATA__',
  '__PLAYER__',
  '__PLAYER_CONFIG__',
  'playerVars',
  'videoData',
  'html5VideoData',
  '__videoInfo',
  '__VIDEO_INFO__',
  'playerConfig',
  'videoInfo',
  'mediaInfo',
  'playInfo',
  'streamData',
  'dashData'
]

const KNOWN_STATE_PATTERN = new RegExp(
  `(?:window\\.)?(${KNOWN_STATE_NAMES.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('|')})\\s*=\\s*`,
  'g'
)

const GENERIC_STATE_PATTERN =
  /(?:var|let|const)\s+([A-Za-z_$][\w$]*(?:video|player|media|stream|play|dash|hls|source)[\w$]*)\s*=\s*/gi

export function extractEmbeddedMediaCandidates(
  scripts: EmbeddedScript[],
  context: GenericScanContext
): EmbeddedScanResult {
  const candidates = new Map<string, GenericMediaCandidate>()
  const warnings: string[] = []
  let truncated = false
  let stateCount = 0

  const scanState = (stateName: string, payload: unknown): void => {
    if (stateCount >= 40) {
      truncated = true
      return
    }
    stateCount += 1
    const safeName = stateName.slice(0, 36)
    const scan = scanJsonPayload(payload, {
      ...context,
      discoveryLabel: `${context.discoveryLabel} · ${safeName}`,
      groupIdPrefix: `${context.groupIdPrefix ?? context.pageUrl}|${safeName}`
    })
    truncated = truncated || scan.truncated
    for (const candidate of scan.candidates) registerCandidate(candidates, candidate)
  }

  for (const script of scripts) {
    if (!script.text || script.text.length > MAX_STRING_LENGTH * 2) {
      if (script.text.length > MAX_STRING_LENGTH * 2) truncated = true
      continue
    }

    const type = (script.type ?? '').toLowerCase()
    const id = script.id ?? ''
    const isJsonScript =
      type.includes('json') ||
      /__NEXT_DATA__|__APOLLO_STATE__|__INITIAL_STATE__/i.test(id)

    if (isJsonScript) {
      const payload = parseJsonLoose(script.text)
      if (payload !== null) {
        scanState(id || type || 'JSON', payload)
      }
      continue
    }

    const names = new Set<string>()
    for (const pattern of [KNOWN_STATE_PATTERN, GENERIC_STATE_PATTERN]) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(script.text)) !== null) {
        if (names.size >= 24) break
        const name = match[1] ?? 'state'
        if (names.has(name)) continue
        names.add(name)
        const start = match.index + match[0].length
        let cursor = start
        while (cursor < script.text.length && /\s/.test(script.text[cursor])) cursor += 1
        const json = sliceBalancedJson(script.text, cursor)
        if (!json) continue
        const payload = parseJsonLoose(json)
        if (payload !== null) scanState(name, payload)
      }
    }
  }

  if (truncated) {
    warnings.push('通用提取：页面内嵌数据较大，已限制扫描深度与数量。')
  }

  return {
    candidates: [...candidates.values()].sort((a, b) => b.score - a.score),
    truncated,
    stateCount,
    warnings
  }
}

export function mergeGenericCandidates(
  ...groups: GenericMediaCandidate[][]
): GenericMediaCandidate[] {
  const merged = new Map<string, GenericMediaCandidate>()
  for (const group of groups) {
    for (const candidate of group) registerCandidate(merged, candidate)
  }
  return [...merged.values()].sort((a, b) => b.score - a.score)
}
