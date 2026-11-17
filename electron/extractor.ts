import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import type {
  DiscoverySource,
  MediaResource,
  ParseProgress,
  ParseResult,
  ParseStats,
  ResourceKind
} from '../src/shared/types'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 FrameKit/0.1'

const PAGE_LIMIT_BYTES = 12 * 1024 * 1024
const CSS_LIMIT_BYTES = 3 * 1024 * 1024
const MAX_RESOURCES = 900
const MAX_CSS_FILES = 8

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'svg',
  'ico',
  'tif',
  'tiff',
  'heic',
  'heif'
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

const OTHER_EXTENSIONS = new Set([
  'srt',
  'ass',
  'ssa',
  'vtt',
  'pdf',
  'zip',
  '7z',
  'rar',
  'json',
  'xml',
  'txt',
  'csv'
])

const ALL_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...OTHER_EXTENSIONS
]

const KIND_EXTENSION: Record<ResourceKind, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'mp3',
  other: 'bin'
}

const MIME_KIND: Record<string, ResourceKind> = {
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'image/svg+xml': 'image',
  'image/bmp': 'image',
  'image/tiff': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'video/x-msvideo': 'video',
  'video/x-matroska': 'video',
  'video/mpeg': 'video',
  'video/mp2t': 'video',
  'application/mp4': 'video',
  'application/x-mpegurl': 'video',
  'application/vnd.apple.mpegurl': 'video',
  'audio/mpegurl': 'video',
  'application/dash+xml': 'video',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/flac': 'audio',
  'audio/ogg': 'audio',
  'audio/opus': 'audio',
  'audio/aac': 'audio',
  'audio/webm': 'audio',
  'audio/x-aiff': 'audio'
}

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/mpeg': 'mpeg',
  'video/mp2t': 'ts',
  'application/x-mpegurl': 'm3u8',
  'application/vnd.apple.mpegurl': 'm3u8',
  'audio/mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/webm': 'weba',
  'audio/x-aiff': 'aiff'
}

const KIND_PRIORITY: Record<ResourceKind, number> = {
  video: 0,
  image: 1,
  audio: 2,
  other: 3
}

export interface Candidate {
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
  stream?: boolean
  audioUrl?: string
  audioMime?: string
  qualityId?: number
  qualityLabel?: string
  codec?: string
  mergeAudio?: boolean
}

interface ClassifiedResource {
  kind: ResourceKind
  extension: string
  isStream: boolean
}

interface ParsedPage {
  title: string
  description?: string
  siteName?: string
  favicon?: string
  resources: MediaResource[]
  warnings: string[]
}

type ProgressReporter = (progress: ParseProgress) => void

function cleanContentType(value?: string | null): string {
  return (value ?? '').split(';')[0].trim().toLowerCase()
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
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

export function normalizeUrl(rawValue: string | undefined, baseUrl: string): string | null {
  if (!rawValue) return null
  let raw = decodeEscapedUrl(rawValue.trim())
  raw = raw.replace(/^['"`]|['"`]$/g, '').trim()
  if (!raw || /^(?:data|blob|javascript|mailto|tel|about|file):/i.test(raw)) return null
  if (raw.startsWith('#')) return null
  if (/\$\{|\{\{|\}\}/.test(raw)) return null

  try {
    const parsed = new URL(raw, baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.hash = ''
    return parsed.href
  } catch {
    return null
  }
}

function extensionFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const basename = decodeURIComponent(parsed.pathname.split('/').pop() ?? '')
    const match = basename.match(/\.([a-z0-9]{1,8})$/i)
    if (match) return match[1].toLowerCase()

    const formatHint = parsed.search.match(
      /(?:format|type|ext|fm|output)=(jpe?g|png|gif|webp|avif|mp4|webm|mov|m3u8|mpd|mp3|wav|flac|m4a|aac)/i
    )
    return formatHint?.[1].toLowerCase() ?? ''
  } catch {
    return ''
  }
}

function kindFromExtension(extension: string): ResourceKind | undefined {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (OTHER_EXTENSIONS.has(extension)) return 'other'
  return undefined
}

export function classifyResource(
  url: string,
  hint?: ResourceKind,
  mimeHint?: string
): ClassifiedResource {
  const mime = cleanContentType(mimeHint)
  const extension = extensionFromUrl(url)
  const extensionKind = kindFromExtension(extension)
  const mimeKind = MIME_KIND[mime]
  const kind = mimeKind ?? extensionKind ?? hint ?? 'other'
  const isStream =
    extension === 'm3u8' ||
    extension === 'mpd' ||
    mime === 'application/x-mpegurl' ||
    mime === 'application/vnd.apple.mpegurl' ||
    mime === 'audio/mpegurl' ||
    mime === 'application/dash+xml'

  let resolvedExtension = extension
  if (!resolvedExtension || kindFromExtension(extension) === undefined) {
    resolvedExtension =
      MIME_EXTENSION[mime] ??
      (kind === 'image' ? 'jpg' : kind === 'video' ? (isStream ? 'm3u8' : 'mp4') : KIND_EXTENSION[kind])
  }

  if (isStream && !['m3u8', 'mpd'].includes(resolvedExtension)) {
    resolvedExtension = mime === 'application/dash+xml' ? 'mpd' : 'm3u8'
  }

  return { kind, extension: resolvedExtension, isStream }
}

export function sanitizeFilename(name: string): string {
  let sanitized = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()

  if (!sanitized) sanitized = 'resource'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)) sanitized = `_${sanitized}`
  return sanitized.slice(0, 120)
}

function filenameFromUrl(url: string, extension: string, kind: ResourceKind): string {
  try {
    const parsed = new URL(url)
    const rawBasename = decodeURIComponent(parsed.pathname.split('/').pop() ?? '')
    const withoutExtension = rawBasename.replace(/\.[a-z0-9]{1,8}$/i, '')
    const base = sanitizeFilename(withoutExtension || `resource-${kind}`)
    return `${base}.${extension || KIND_EXTENSION[kind]}`
  } catch {
    return `resource-${kind}.${extension || KIND_EXTENSION[kind]}`
  }
}

function hashId(url: string): string {
  return `r_${createHash('sha1').update(url).digest('hex').slice(0, 12)}`
}

export function makeResource(candidate: Candidate, pageUrl: string): MediaResource {
  const classified = classifyResource(candidate.url, candidate.hint, candidate.mime)
  return {
    id: hashId(candidate.url),
    url: candidate.url,
    kind: classified.kind,
    source: candidate.source,
    pageUrl,
    filename: filenameFromUrl(candidate.url, classified.extension, classified.kind),
    extension: classified.extension,
    mime: candidate.mime,
    size: candidate.size,
    width: candidate.width,
    height: candidate.height,
    duration: candidate.duration,
    poster: candidate.poster ? normalizeUrl(candidate.poster, pageUrl) ?? undefined : undefined,
    label: candidate.label?.trim() || undefined,
    discoveryLabel: candidate.discoveryLabel,
    isStream: candidate.stream ?? classified.isStream,
    audioUrl: candidate.audioUrl,
    audioMime: candidate.audioMime,
    qualityId: candidate.qualityId,
    qualityLabel: candidate.qualityLabel,
    codec: candidate.codec,
    mergeAudio: candidate.mergeAudio
  }
}

function mergeResource(existing: MediaResource, incoming: MediaResource): MediaResource {
  const incomingHasBetterKind = existing.kind === 'other' && incoming.kind !== 'other'
  return {
    ...existing,
    kind: incomingHasBetterKind ? incoming.kind : existing.kind,
    extension: incomingHasBetterKind ? incoming.extension : existing.extension,
    filename: incomingHasBetterKind ? incoming.filename : existing.filename,
    source: existing.source === 'html' && incoming.source === 'network' ? incoming.source : existing.source,
    discoveryLabel:
      !existing.discoveryLabel || existing.discoveryLabel === '页面内容'
        ? incoming.discoveryLabel
        : existing.discoveryLabel,
    label: existing.label ?? incoming.label,
    mime: existing.mime ?? incoming.mime,
    size: existing.size ?? incoming.size,
    width: existing.width ?? incoming.width,
    height: existing.height ?? incoming.height,
    duration: existing.duration ?? incoming.duration,
    poster: existing.poster ?? incoming.poster,
    isStream: existing.isStream || incoming.isStream,
    audioUrl: existing.audioUrl ?? incoming.audioUrl,
    audioMime: existing.audioMime ?? incoming.audioMime,
    qualityId: existing.qualityId ?? incoming.qualityId,
    qualityLabel: existing.qualityLabel ?? incoming.qualityLabel,
    codec: existing.codec ?? incoming.codec,
    mergeAudio: existing.mergeAudio || incoming.mergeAudio,
    groupId: existing.groupId ?? incoming.groupId
  }
}

export function mergeResources(
  first: MediaResource[],
  second: MediaResource[]
): MediaResource[] {
  const merged = new Map<string, MediaResource>()
  for (const resource of [...first, ...second]) {
    const existing = merged.get(resource.url)
    merged.set(resource.url, existing ? mergeResource(existing, resource) : resource)
  }
  return sortResources([...merged.values()])
}

function sortResources(resources: MediaResource[]): MediaResource[] {
  return resources.sort((a, b) => {
    const kindDelta = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]
    if (kindDelta !== 0) return kindDelta
    if (a.isStream !== b.isStream) return a.isStream ? 1 : -1
    return (a.label ?? a.filename).localeCompare(b.label ?? b.filename)
  })
}

export function statsForResources(resources: MediaResource[]): ParseStats {
  const stats: ParseStats = {
    images: 0,
    videos: 0,
    audios: 0,
    others: 0,
    total: resources.length,
    knownBytes: 0
  }
  for (const resource of resources) {
    if (resource.kind === 'image') stats.images += 1
    else if (resource.kind === 'video') stats.videos += 1
    else if (resource.kind === 'audio') stats.audios += 1
    else stats.others += 1
    if (resource.size) stats.knownBytes += resource.size
  }
  return stats
}

function attributesOf(element: unknown): Record<string, string> {
  const node = element as { attribs?: Record<string, string> }
  return node.attribs ?? {}
}

function parseDimensions(
  widthValue?: string,
  heightValue?: string
): Pick<Candidate, 'width' | 'height'> {
  return {
    width: finiteNumber(widthValue),
    height: finiteNumber(heightValue)
  }
}

function parseSrcset(value?: string): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
}

function parseJsonLd(
  raw: string,
  add: (
    candidate: Omit<Candidate, 'source' | 'discoveryLabel'> & {
      source?: DiscoverySource
      discoveryLabel?: string
    }
  ) => void
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }

  const walk = (value: unknown, inheritedHint?: ResourceKind, depth = 0): void => {
    if (depth > 7 || value == null) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inheritedHint, depth + 1)
      return
    }
    if (typeof value !== 'object') return

    const record = value as Record<string, unknown>
    const typeValue = record['@type']
    const types = Array.isArray(typeValue) ? typeValue.map(String) : [String(typeValue ?? '')]
    const typeString = types.join(' ').toLowerCase()
    const hint: ResourceKind | undefined = typeString.includes('video')
      ? 'video'
      : typeString.includes('audio')
        ? 'audio'
        : typeString.includes('image')
          ? 'image'
          : inheritedHint

    const width = finiteNumber(record.width)
    const height = finiteNumber(record.height)
    const duration = finiteNumber(record.duration)
    const name = typeof record.name === 'string' ? record.name : undefined

    const addUrl = (rawUrl: unknown, kindHint?: ResourceKind, kindLabel = '结构化数据'): void => {
      if (typeof rawUrl === 'string') {
        add({
          url: rawUrl,
          hint: kindHint ?? hint,
          source: 'jsonld',
          discoveryLabel: kindLabel,
          label: name,
          width,
          height,
          duration
        })
      }
    }

    addUrl(record.contentUrl, hint, '结构化数据')
    addUrl(record.thumbnailUrl, 'image', '结构化缩略图')
    addUrl(record.image, 'image', '结构化图片')
    addUrl(record.thumbnail, 'image', '结构化缩略图')

    for (const key of ['video', 'audio', 'associatedMedia', 'encoding']) {
      if (record[key]) walk(record[key], hint, depth + 1)
    }
  }

  walk(parsed)
}

function extractCssUrls(css: string): string[] {
  const urls: string[] = []
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    const value = match[1] ?? match[2] ?? match[3]
    if (value) urls.push(value)
  }
  return urls
}

function extractMediaUrlsFromScript(script: string): string[] {
  if (!script || script.length < 8) return []
  const normalized = decodeEscapedUrl(script)
  const extensionPattern = ALL_EXTENSIONS.join('|')
  const absolute = new RegExp(
    `https?://[^\\s"'\\\`<>]+?\\.(?:${extensionPattern})(?:\\?[^\\s"'\\\`<>]*)?`,
    'gi'
  )
  const relative = new RegExp(
    `(?:^|[\\s"'(=,])((?:\\/|\\.{1,2}\\/)[^\\s"'\\\`<>]+?\\.(?:${extensionPattern})(?:\\?[^\\s"'\\\`<>]*)?)`,
    'gi'
  )

  const found = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = absolute.exec(normalized)) !== null) {
    found.add(match[0])
    if (found.size >= 220) break
  }
  while ((match = relative.exec(normalized)) !== null) {
    found.add(match[1])
    if (found.size >= 300) break
  }
  return [...found]
}

function parseCharset(contentType: string | null): string {
  const match = contentType?.match(/charset\s*=\s*["']?([a-z0-9_-]+)/i)
  return match?.[1]?.toLowerCase() || 'utf-8'
}

async function readLimitedText(
  response: Response,
  limit: number,
  contentType: string | null
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new Error('页面内容过大，已停止读取')
    }
    chunks.push(value)
  }

  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return new TextDecoder(parseCharset(contentType)).decode(combined)
  } catch {
    return new TextDecoder('utf-8').decode(combined)
  }
}

async function fetchCssResource(
  url: string,
  add: (
    candidate: Omit<Candidate, 'source' | 'discoveryLabel'> & {
      source?: DiscoverySource
      discoveryLabel?: string
    }
  ) => void
): Promise<void> {
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/css,*/*;q=0.1'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000)
  })
  if (!response.ok) return
  const contentType = response.headers.get('content-type')
  const text = await readLimitedText(response, CSS_LIMIT_BYTES, contentType)
  for (const rawUrl of extractCssUrls(text)) {
    const resolved = normalizeUrl(rawUrl, response.url || url)
    if (resolved) {
      add({ url: resolved, hint: 'image', source: 'css', discoveryLabel: '样式表资源' })
    }
  }
}

function directParseResult(
  url: string,
  mime: string,
  size: number | undefined,
  title: string
): ParseResult {
  const kind = MIME_KIND[mime] ?? classifyResource(url, undefined, mime).kind
  const resource = makeResource(
    {
      url,
      hint: kind,
      mime,
      size,
      source: 'direct',
      discoveryLabel: '直接媒体地址',
      label: title || undefined
    },
    url
  )
  return {
    pageUrl: url,
    finalUrl: url,
    title,
    mode: 'quick',
    resources: [resource],
    stats: statsForResources([resource]),
    warnings: [],
    elapsedMs: 0
  }
}

function buildPageMetadata($: ReturnType<typeof load>): Omit<ParsedPage, 'resources' | 'warnings'> {
  const meta = new Map<string, string>()
  $('meta').each((_, element) => {
    const attrs = attributesOf(element)
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase()
    const content = attrs.content
    if (key && content && !meta.has(key)) meta.set(key, content)
  })

  const title = meta.get('og:title') ?? meta.get('twitter:title') ?? $('title').first().text().trim()
  const description = meta.get('og:description') ?? meta.get('description') ?? undefined
  const siteName = meta.get('og:site_name') ?? meta.get('application-name') ?? undefined

  let favicon: string | undefined
  $('link[rel]').each((_, element) => {
    if (favicon) return
    const attrs = attributesOf(element)
    const rel = (attrs.rel ?? '').toLowerCase()
    if (rel.split(/\s+/).some((value) => value.includes('icon')) && attrs.href) {
      favicon = attrs.href
    }
  })

  return {
    title: title.trim(),
    description: description?.trim(),
    siteName: siteName?.trim(),
    favicon
  }
}

function extractHtmlResources(
  html: string,
  pageUrl: string
): ParsedPage & { favicon?: string; stylesheetUrls: string[] } {
  const $ = load(html)
  const metadata = buildPageMetadata($)
  const candidates = new Map<string, Candidate>()
  const warnings: string[] = []

  const addCandidate = (
    candidate: Omit<Candidate, 'source' | 'discoveryLabel'> & {
      source?: DiscoverySource
      discoveryLabel?: string
    }
  ): void => {
    const resolved = normalizeUrl(candidate.url, pageUrl)
    if (!resolved) return
    if (candidates.size >= MAX_RESOURCES + 200) return
    const existing = candidates.get(resolved)
    const next: Candidate = {
      ...candidate,
      url: resolved,
      source: candidate.source ?? 'html',
      discoveryLabel: candidate.discoveryLabel ?? '页面内容'
    }
    if (!existing) {
      candidates.set(resolved, next)
      return
    }
    candidates.set(resolved, {
      ...existing,
      hint: existing.hint ?? next.hint,
      label: existing.label ?? next.label,
      mime: existing.mime ?? next.mime,
      size: existing.size ?? next.size,
      width: existing.width ?? next.width,
      height: existing.height ?? next.height,
      duration: existing.duration ?? next.duration,
      poster: existing.poster ?? next.poster,
      stream: existing.stream ?? next.stream
    })
  }

  const addSourceSet = (
    value: string | undefined,
    extra: Omit<Candidate, 'url' | 'source' | 'discoveryLabel'>,
    discoveryLabel: string
  ): void => {
    for (const url of parseSrcset(value)) {
      addCandidate({ ...extra, url, source: 'html', discoveryLabel })
    }
  }

  const metaKeys = [
    ['og:image', 'image', 'Open Graph 图片'],
    ['og:image:url', 'image', 'Open Graph 图片'],
    ['og:image:secure_url', 'image', 'Open Graph 图片'],
    ['twitter:image', 'image', 'Twitter 图片'],
    ['twitter:image:src', 'image', 'Twitter 图片'],
    ['og:video', 'video', 'Open Graph 视频'],
    ['og:video:url', 'video', 'Open Graph 视频'],
    ['og:video:secure_url', 'video', 'Open Graph 视频'],
    ['twitter:player:stream', 'video', 'Twitter 视频流'],
    ['og:audio', 'audio', 'Open Graph 音频'],
    ['og:audio:url', 'audio', 'Open Graph 音频'],
    ['og:audio:secure_url', 'audio', 'Open Graph 音频']
  ] as const

  for (const [key, hint, label] of metaKeys) {
    const content = $('meta').filter((_, element) => {
      const attrs = attributesOf(element)
      return (attrs.property ?? attrs.name ?? '').toLowerCase() === key
    }).first().attr('content')
    if (!content) continue
    const dimensions =
      hint === 'image'
        ? parseDimensions(
            $('meta[property="og:image:width"]').attr('content'),
            $('meta[property="og:image:height"]').attr('content')
          )
        : parseDimensions(
            $('meta[property="og:video:width"]').attr('content'),
            $('meta[property="og:video:height"]').attr('content')
          )
    addCandidate({
      url: content,
      hint,
      source: 'meta',
      discoveryLabel: label,
      label: metadata.title,
      ...dimensions,
      duration: finiteNumber($('meta[property="og:video:duration"]').attr('content'))
    })
  }

  $('img').each((_, element) => {
    const attrs = attributesOf(element)
    const extra = {
      hint: 'image' as const,
      label: attrs.alt || attrs.title || undefined,
      ...parseDimensions(attrs.width, attrs.height)
    }
    for (const key of [
      'src',
      'data-src',
      'data-original',
      'data-lazy-src',
      'data-actualsrc',
      'data-url',
      'data-image'
    ]) {
      if (attrs[key]) {
        addCandidate({ ...extra, url: attrs[key], source: 'html', discoveryLabel: '页面图片' })
      }
    }
    addSourceSet(attrs.srcset, extra, '响应式图片')
    addSourceSet(attrs['data-srcset'], extra, '懒加载图片')
    addSourceSet(attrs['data-lazy-srcset'], extra, '懒加载图片')
  })

  $('picture source').each((_, element) => {
    const attrs = attributesOf(element)
    const extra = {
      hint: 'image' as const,
      label: attrs.title || undefined,
      ...parseDimensions(attrs.width, attrs.height)
    }
    addSourceSet(attrs.srcset, extra, '响应式图片')
    addSourceSet(attrs['data-srcset'], extra, '响应式图片')
    if (attrs.src) {
      addCandidate({ ...extra, url: attrs.src, source: 'html', discoveryLabel: '响应式图片' })
    }
  })

  $('video').each((_, element) => {
    const attrs = attributesOf(element)
    const extra = {
      hint: 'video' as const,
      label: attrs.title || undefined,
      poster: attrs.poster,
      ...parseDimensions(attrs.width, attrs.height)
    }
    for (const key of ['src', 'data-src', 'data-video-src', 'data-url']) {
      if (attrs[key]) {
        addCandidate({ ...extra, url: attrs[key], source: 'html', discoveryLabel: '视频标签' })
      }
    }
    if (attrs.poster) {
      addCandidate({
        url: attrs.poster,
        hint: 'image',
        source: 'html',
        discoveryLabel: '视频封面',
        label: attrs.title || undefined
      })
    }
  })

  $('video source').each((_, element) => {
    const attrs = attributesOf(element)
    if (attrs.src) {
      addCandidate({
        url: attrs.src,
        hint: 'video',
        mime: cleanContentType(attrs.type),
        source: 'html',
        discoveryLabel: '视频源'
      })
    }
  })

  $('audio').each((_, element) => {
    const attrs = attributesOf(element)
    for (const key of ['src', 'data-src', 'data-audio-src', 'data-url']) {
      if (attrs[key]) {
        addCandidate({
          url: attrs[key],
          hint: 'audio',
          source: 'html',
          discoveryLabel: '音频标签'
        })
      }
    }
  })

  $('audio source').each((_, element) => {
    const attrs = attributesOf(element)
    if (attrs.src) {
      addCandidate({
        url: attrs.src,
        hint: 'audio',
        mime: cleanContentType(attrs.type),
        source: 'html',
        discoveryLabel: '音频源'
      })
    }
  })

  $('track').each((_, element) => {
    const attrs = attributesOf(element)
    if (attrs.src) {
      addCandidate({
        url: attrs.src,
        hint: 'other',
        source: 'html',
        discoveryLabel: attrs.kind ? `${attrs.kind} 字幕` : '字幕轨道'
      })
    }
  })

  $('a[href], area[href]').each((_, element) => {
    const attrs = attributesOf(element)
    const resolved = normalizeUrl(attrs.href, pageUrl)
    if (!resolved) return
    const extension = extensionFromUrl(resolved)
    if (!kindFromExtension(extension) && !attrs.download) return
    const kind = kindFromExtension(extension)
    if (!kind) return
    addCandidate({
      url: resolved,
      hint: kind,
      source: 'html',
      discoveryLabel: attrs.download ? '下载链接' : '页面链接',
      label: $(element).text().trim() || attrs.title || attrs.download || undefined
    })
  })

  $('link[href]').each((_, element) => {
    const attrs = attributesOf(element)
    const rel = (attrs.rel ?? '').toLowerCase()
    const as = (attrs.as ?? '').toLowerCase()
    const extension = extensionFromUrl(attrs.href)
    const kind = kindFromExtension(extension)
    if (!kind) return
    const hintedKind: ResourceKind =
      as === 'image' ? 'image' : as === 'video' ? 'video' : as === 'audio' ? 'audio' : kind
    if (rel && !/(?:preload|prefetch|icon|image_src|media)/.test(rel)) return
    addCandidate({
      url: attrs.href,
      hint: hintedKind,
      source: 'html',
      discoveryLabel: rel.includes('icon') ? '站点图标' : '预加载资源'
    })
  })

  $('embed[src], object[data]').each((_, element) => {
    const attrs = attributesOf(element)
    const url = attrs.src ?? attrs.data
    if (!url) return
    const extension = extensionFromUrl(url)
    const kind = kindFromExtension(extension)
    if (!kind) return
    addCandidate({ url, hint: kind, source: 'html', discoveryLabel: '嵌入媒体' })
  })

  const inlineStyles: string[] = []
  $('[style]').each((_, element) => {
    const style = attributesOf(element).style
    if (style) inlineStyles.push(style)
  })
  $('style').each((_, element) => {
    const style = $(element).text()
    if (style) inlineStyles.push(style)
  })
  for (const style of inlineStyles) {
    for (const rawUrl of extractCssUrls(style)) {
      const resolved = normalizeUrl(rawUrl, pageUrl)
      if (!resolved) continue
      const kind = classifyResource(resolved).kind
      if (kind === 'other') continue
      addCandidate({
        url: resolved,
        hint: kind,
        source: 'css',
        discoveryLabel: 'CSS 背景资源'
      })
    }
  }

  $('script').each((_, element) => {
    const attrs = attributesOf(element)
    const type = (attrs.type ?? '').toLowerCase()
    const scriptText = $(element).text()
    if (type.includes('ld+json')) {
      parseJsonLd(scriptText, addCandidate)
      return
    }
    if (attrs.src || type.includes('template') || type.includes('text/html')) return
    for (const rawUrl of extractMediaUrlsFromScript(scriptText)) {
      const resolved = normalizeUrl(rawUrl, pageUrl)
      if (!resolved) continue
      const extension = extensionFromUrl(resolved)
      const hint = kindFromExtension(extension)
      if (!hint) continue
      addCandidate({
        url: resolved,
        hint,
        source: 'script',
        discoveryLabel: '脚本内嵌资源'
      })
    }
  })

  const stylesheetUrls: string[] = []
  $('link[rel~="stylesheet"][href]').each((_, element) => {
    const resolved = normalizeUrl(attributesOf(element).href, pageUrl)
    if (resolved && stylesheetUrls.length < MAX_CSS_FILES && !stylesheetUrls.includes(resolved)) {
      stylesheetUrls.push(resolved)
    }
  })

  const resources = sortResources(
    [...candidates.values()].map((candidate) => makeResource(candidate, pageUrl))
  )

  if (resources.length === 0) {
    warnings.push('页面源码中没有发现直链媒体。可以尝试“深度嗅探”，它会执行页面脚本并监听网络请求。')
  }
  if (resources.length > MAX_RESOURCES) {
    warnings.push(`资源数量较多，仅保留前 ${MAX_RESOURCES} 项。`)
  }

  return {
    ...metadata,
    resources: resources.slice(0, MAX_RESOURCES),
    warnings,
    stylesheetUrls
  }
}

export function validateAndNormalizePageUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('请输入网页地址')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error('网址格式不正确')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http 或 https 网址')
  }
  return parsed.href
}

export async function parseStaticPage(
  rawUrl: string,
  onProgress: ProgressReporter = () => undefined
): Promise<ParseResult> {
  const startedAt = Date.now()
  const pageUrl = validateAndNormalizePageUrl(rawUrl)

  onProgress({ stage: 'fetch', message: '正在连接页面…', percent: 8 })
  const response = await fetch(pageUrl, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000)
  })

  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`页面请求失败：HTTP ${response.status}`)
  }

  const finalUrl = response.url || pageUrl
  const contentType = response.headers.get('content-type')
  const mime = cleanContentType(contentType)

  if (MIME_KIND[mime] || mime.includes('mpegurl') || mime.includes('dash+xml')) {
    const size = finiteNumber(response.headers.get('content-length'))
    await response.body?.cancel()
    const title = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() ?? '')
    const result = directParseResult(finalUrl, mime, size, title)
    result.elapsedMs = Date.now() - startedAt
    onProgress({ stage: 'done', message: '已识别直接媒体地址', percent: 100 })
    return result
  }

  if (!mime || (!mime.includes('html') && !mime.includes('xml') && !mime.startsWith('text/'))) {
    const size = finiteNumber(response.headers.get('content-length'))
    await response.body?.cancel()
    const title = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() ?? '')
    const result = directParseResult(finalUrl, mime || 'application/octet-stream', size, title)
    result.warnings.push('该地址返回的不是 HTML 页面，已作为直接文件列出。')
    result.elapsedMs = Date.now() - startedAt
    onProgress({ stage: 'done', message: '已识别直接文件地址', percent: 100 })
    return result
  }

  onProgress({ stage: 'parse', message: '正在分析页面结构与媒体标签…', percent: 28 })
  const html = await readLimitedText(response, PAGE_LIMIT_BYTES, contentType)
  const parsed = extractHtmlResources(html, finalUrl)

  onProgress({ stage: 'parse', message: '正在读取样式表资源…', percent: 46 })
  if (parsed.stylesheetUrls.length > 0) {
    const extraCandidates: Candidate[] = []
    const cssResults = await Promise.allSettled(
      parsed.stylesheetUrls.map((cssUrl) =>
        fetchCssResource(cssUrl, (candidate) => {
          const normalized = normalizeUrl(candidate.url, cssUrl)
          if (normalized) {
            extraCandidates.push({
              ...candidate,
              url: normalized,
              source: 'css',
              discoveryLabel: candidate.discoveryLabel ?? '样式表资源'
            })
          }
        })
      )
    )
    if (cssResults.every((result) => result.status === 'rejected') && parsed.resources.length === 0) {
      parsed.warnings.push('外部样式表读取失败，可能遗漏 CSS 背景图片。')
    }
    const cssResources = extraCandidates.map((candidate) => makeResource(candidate, finalUrl))
    parsed.resources = mergeResources(parsed.resources, cssResources).slice(0, MAX_RESOURCES)
  }

  parsed.favicon = normalizeUrl(parsed.favicon, finalUrl) ?? undefined
  const result: ParseResult = {
    pageUrl,
    finalUrl,
    title: parsed.title || new URL(finalUrl).hostname,
    description: parsed.description,
    siteName: parsed.siteName,
    favicon: parsed.favicon,
    mode: 'quick',
    resources: parsed.resources,
    stats: statsForResources(parsed.resources),
    warnings: parsed.warnings,
    elapsedMs: Date.now() - startedAt
  }

  onProgress({ stage: 'done', message: '快速扫描完成', percent: 100 })
  return result
}

export const extractorConstants = {
  USER_AGENT,
  MAX_RESOURCES
}
