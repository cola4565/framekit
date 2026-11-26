import { BrowserWindow, session, type Session } from 'electron'
import type {
  MediaResource,
  ParseProgress,
  ResourceKind
} from '../src/shared/types'
import {
  classifyResource,
  extractorConstants,
  makeResource,
  mergeResources,
  normalizeUrl
} from './extractor'
import {
  mergeGenericCandidates,
  parseJsonText,
  scanJsonPayload,
  type GenericMediaCandidate
} from './generic'
import { parseHlsMaster, qualityLabelOfVariant } from './hls'

const MAX_NETWORK_RESOURCES = 700
const LOAD_TIMEOUT_MS = 28000
const SNAPSHOT_TIMEOUT_MS = 9000
const MAX_JSON_BODIES = 80
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024
const MAX_JSON_TOTAL_BYTES = 24 * 1024 * 1024
const MAX_BODY_CONCURRENCY = 4
const JSON_BODY_WAIT_MS = 4000
const MAX_HLS_MASTERS = 6
const HLS_FETCH_TIMEOUT_MS = 12000
const MAX_GENERIC_CANDIDATES = 1200
const SNIFF_PARTITION = 'framekit-sniff'

let sharedSniffSession: Session | null = null
let activeNetworkMap: Map<string, MediaResource> | null = null

/**
 * 深度嗅探的会话必须复用。
 *
 * 以前每次解析都会用随机 partition 新建一个 session，Electron 会把它一直
 * 留在进程里，长时间使用后这些 session 会越积越多。这里改成固定的
 * 非持久 partition：不写盘，解析结束后清掉缓存与存储即可。
 */
function getSniffSession(): Session {
  if (sharedSniffSession) return sharedSniffSession
  const target = session.fromPartition(SNIFF_PARTITION, { cache: false })
  target.setUserAgent(extractorConstants.USER_AGENT)
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  target.setPermissionCheckHandler(() => false)
  target.on('will-download', (event) => event.preventDefault())
  sharedSniffSession = target
  return target
}

interface SniffImage {
  url: string
  width?: number
  height?: number
  alt?: string
}

interface SniffVideo {
  url: string
  poster?: string
  width?: number
  height?: number
  duration?: number
  sources?: Array<{ url: string; mime?: string }>
}

interface SniffAudio {
  url: string
  duration?: number
  sources?: Array<{ url: string; mime?: string }>
}

interface SniffSource {
  url: string
  mime?: string
  parent: 'video' | 'audio' | 'other'
}

interface SniffEntry {
  url: string
  type?: string
}

interface DomSnapshot {
  title?: string
  ogTitle?: string
  description?: string
  siteName?: string
  favicon?: string
  images: SniffImage[]
  videos: SniffVideo[]
  audios: SniffAudio[]
  sources: SniffSource[]
  backgrounds: string[]
  links: string[]
  entries: SniffEntry[]
  states?: Array<{ name: string; text: string }>
}

export interface SniffPageResult {
  pageUrl: string
  finalUrl: string
  title?: string
  description?: string
  siteName?: string
  favicon?: string
  resources: MediaResource[]
  warnings: string[]
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function headerValue(
  headers: Record<string, string[]> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  return entry?.[1]?.[0]
}

function mimeKind(mime: string | undefined): ResourceKind | undefined {
  if (!mime) return undefined
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.includes('mpegurl') || mime.includes('dash+xml')) return 'video'
  return undefined
}

function shouldSkipNetworkUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true
  if (/\/favicon\.ico(?:$|\?)/i.test(url)) return true
  if (/[?&](?:width|height)=1(?:&|$)/i.test(url)) return true
  return false
}

function networkLabel(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const name = decodeURIComponent(parsed.pathname.split('/').pop() ?? '')
    return name || parsed.hostname
  } catch {
    return undefined
  }
}

function labelFromInitiator(type: string | undefined): string {
  if (type === 'img') return '动态图片请求'
  if (type === 'media' || type === 'video') return '动态媒体请求'
  if (type === 'fetch' || type === 'xmlhttprequest') return '脚本请求资源'
  return '网络请求'
}

const DOM_SNAPSHOT_SCRIPT = String.raw`
(() => {
  const absolute = (value) => {
    if (!value || typeof value !== 'string') return '';
    if (/^(data|blob|javascript):/i.test(value)) return '';
    try { return new URL(value, document.baseURI).href; } catch (_) { return ''; }
  };
  const meta = (name) => {
    const element = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
    return element ? element.getAttribute('content') || '' : '';
  };
  const number = (value) => Number.isFinite(value) && value > 0 ? value : undefined;
  const images = Array.from(document.querySelectorAll('img')).slice(0, 500).map((image) => ({
    url: absolute(image.currentSrc || image.src || image.getAttribute('data-src')),
    width: number(image.naturalWidth) || number(parseFloat(image.getAttribute('width'))),
    height: number(image.naturalHeight) || number(parseFloat(image.getAttribute('height'))),
    alt: image.alt || image.title || ''
  })).filter((image) => image.url);
  const videos = Array.from(document.querySelectorAll('video')).slice(0, 100).map((video) => ({
    url: absolute(video.currentSrc || video.src),
    poster: absolute(video.poster),
    width: number(video.videoWidth),
    height: number(video.videoHeight),
    duration: number(video.duration),
    sources: Array.from(video.querySelectorAll('source')).map((source) => ({
      url: absolute(source.src || source.getAttribute('src')),
      mime: source.type || ''
    })).filter((source) => source.url)
  })).filter((video) => video.url || video.sources.length);
  const audios = Array.from(document.querySelectorAll('audio')).slice(0, 100).map((audio) => ({
    url: absolute(audio.currentSrc || audio.src),
    duration: number(audio.duration),
    sources: Array.from(audio.querySelectorAll('source')).map((source) => ({
      url: absolute(source.src || source.getAttribute('src')),
      mime: source.type || ''
    })).filter((source) => source.url)
  })).filter((audio) => audio.url || audio.sources.length);
  const sources = Array.from(document.querySelectorAll('source')).slice(0, 300).map((source) => {
    const parent = source.parentElement;
    return {
      url: absolute(source.src || source.getAttribute('src')),
      mime: source.type || '',
      parent: parent && parent.tagName === 'VIDEO' ? 'video' : parent && parent.tagName === 'AUDIO' ? 'audio' : 'other'
    };
  }).filter((source) => source.url);
  const backgrounds = [];
  const backgroundUrls = new Set();
  if (document.body) {
    const elements = document.querySelectorAll('body *');
    const scanLimit = Math.min(elements.length, 6000);
    for (let index = 0; index < scanLimit; index += 1) {
      const element = elements[index];
      if (backgroundUrls.size >= 160) break;
      if (element.offsetParent === null) continue;
      const background = getComputedStyle(element).backgroundImage;
      if (!background || background === 'none') continue;
      const matches = background.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/g);
      for (const match of matches) {
        const value = absolute(match[1] || match[2] || match[3] || '');
        if (value && !backgroundUrls.has(value)) {
          backgroundUrls.add(value);
          backgrounds.push(value);
        }
      }
    }
  }
  const links = Array.from(document.querySelectorAll('a[href], area[href]')).slice(0, 1800)
    .map((link) => absolute(link.href || link.getAttribute('href')))
    .filter(Boolean);
  const entries = performance.getEntriesByType('resource').slice(-2200).map((entry) => ({
    url: entry.name,
    type: entry.initiatorType || ''
  }));
  const states = [];
  const stateDigests = new Set();
  const MAX_STATE_COUNT = 12;
  const MAX_STATE_ITEM_CHARS = 1000000;
  const MAX_STATE_CHARS = 6000000;
  let stateChars = 0;
  const limitedJson = (value, limit) => {
    let chars = 0;
    let tooLarge = false;
    try {
      return JSON.stringify(value, (key, item) => {
        chars += 12 + String(key).length + (typeof item === 'string' ? item.length : 0);
        if (chars > limit) {
          tooLarge = true;
          throw new Error('state-too-large');
        }
        return item;
      });
    } catch (_) {
      return tooLarge ? null : undefined;
    }
  };
  const pushState = (name, value) => {
    if (!name || states.length >= MAX_STATE_COUNT || stateChars >= MAX_STATE_CHARS) return;
    const limit = Math.min(MAX_STATE_ITEM_CHARS, MAX_STATE_CHARS - stateChars);
    try {
      const text = limitedJson(value, limit);
      if (!text || text.length < 8 || text.length > MAX_STATE_ITEM_CHARS) return;
      if (stateChars + text.length > MAX_STATE_CHARS) return;
      const digest = text.slice(0, 180);
      if (stateDigests.has(digest)) return;
      stateDigests.add(digest);
      stateChars += text.length;
      states.push({ name: String(name), text });
    } catch (_) {
      // 运行时状态可能包含循环引用或不可序列化值，跳过即可。
    }
  };
  const stateNames = [
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
  ];
  for (const name of stateNames) {
    try {
      if (window[name] !== undefined) pushState(name, window[name]);
    } catch (_) {
      // 忽略被页面代理或抛错的全局变量。
    }
  }
  for (const script of Array.from(document.querySelectorAll('script')).slice(0, 120)) {
    if (states.length >= MAX_STATE_COUNT || stateChars >= MAX_STATE_CHARS) break;
    const type = (script.type || '').toLowerCase();
    const id = script.id || '';
    if (!type.includes('json') && !/NEXT_DATA|APOLLO_STATE|INITIAL_STATE/i.test(id)) continue;
    const text = script.textContent || '';
    if (
      text.length < 8 ||
      text.length > MAX_STATE_ITEM_CHARS ||
      stateChars + text.length > MAX_STATE_CHARS ||
      stateDigests.has(text.slice(0, 180))
    ) {
      continue;
    }
    stateDigests.add(text.slice(0, 180));
    stateChars += text.length;
    states.push({ name: id || type || 'JSON', text });
  }
  const icon = document.querySelector('link[rel~="icon"]');
  return {
    title: document.title || '',
    ogTitle: meta('og:title') || meta('twitter:title') || '',
    description: meta('og:description') || meta('description') || '',
    siteName: meta('og:site_name') || '',
    favicon: icon ? absolute(icon.href) : '',
    images,
    videos,
    audios,
    sources,
    backgrounds,
    links,
    entries,
    states
  };
})()
`

function snapshotResources(snapshot: DomSnapshot, pageUrl: string): MediaResource[] {
  const resources: MediaResource[] = []

  for (const image of snapshot.images) {
    const normalized = normalizeUrl(image.url, pageUrl)
    if (!normalized) continue
    resources.push(
      makeResource(
        {
          url: normalized,
          hint: 'image',
          source: 'network',
          discoveryLabel: '浏览器 DOM',
          label: image.alt || undefined,
          width: image.width,
          height: image.height
        },
        pageUrl
      )
    )
  }

  for (const video of snapshot.videos) {
    const normalized = normalizeUrl(video.url, pageUrl)
    const poster = normalizeUrl(video.poster, pageUrl) ?? undefined
    if (normalized) {
      resources.push(
        makeResource(
          {
            url: normalized,
            hint: 'video',
            source: 'network',
            discoveryLabel: '浏览器 DOM',
            poster,
            width: video.width,
            height: video.height,
            duration: video.duration
          },
          pageUrl
        )
      )
    }
    for (const source of video.sources ?? []) {
      const sourceUrl = normalizeUrl(source.url, pageUrl)
      if (!sourceUrl) continue
      resources.push(
        makeResource(
          {
            url: sourceUrl,
            hint: 'video',
            mime: source.mime,
            source: 'network',
            discoveryLabel: '浏览器 DOM',
            poster,
            width: video.width,
            height: video.height,
            duration: video.duration
          },
          pageUrl
        )
      )
    }
    if (poster) {
      resources.push(
        makeResource(
          {
            url: poster,
            hint: 'image',
            source: 'network',
            discoveryLabel: '动态视频封面'
          },
          pageUrl
        )
      )
    }
  }

  for (const audio of snapshot.audios) {
    const normalized = normalizeUrl(audio.url, pageUrl)
    if (normalized) {
      resources.push(
        makeResource(
          {
            url: normalized,
            hint: 'audio',
            source: 'network',
            discoveryLabel: '浏览器 DOM',
            duration: audio.duration
          },
          pageUrl
        )
      )
    }
    for (const source of audio.sources ?? []) {
      const sourceUrl = normalizeUrl(source.url, pageUrl)
      if (!sourceUrl) continue
      resources.push(
        makeResource(
          {
            url: sourceUrl,
            hint: 'audio',
            mime: source.mime,
            source: 'network',
            discoveryLabel: '浏览器 DOM',
            duration: audio.duration
          },
          pageUrl
        )
      )
    }
  }

  for (const source of snapshot.sources) {
    const normalized = normalizeUrl(source.url, pageUrl)
    if (!normalized) continue
    const hint: ResourceKind =
      source.parent === 'audio' ? 'audio' : source.parent === 'video' ? 'video' : 'other'
    resources.push(
      makeResource(
        {
          url: normalized,
          hint,
          mime: source.mime,
          source: 'network',
          discoveryLabel: '动态媒体源'
        },
        pageUrl
      )
    )
  }

  for (const background of snapshot.backgrounds) {
    const normalized = normalizeUrl(background, pageUrl)
    if (!normalized) continue
    const classified = classifyResource(normalized, 'image')
    if (classified.kind !== 'image') continue
    resources.push(
      makeResource(
        {
          url: normalized,
          hint: 'image',
          source: 'network',
          discoveryLabel: '动态背景图片'
        },
        pageUrl
      )
    )
  }

  for (const link of snapshot.links) {
    const normalized = normalizeUrl(link, pageUrl)
    if (!normalized) continue
    const classified = classifyResource(normalized)
    if (classified.kind === 'other') continue
    resources.push(
      makeResource(
        {
          url: normalized,
          hint: classified.kind,
          source: 'network',
          discoveryLabel: '动态页面链接'
        },
        pageUrl
      )
    )
  }

  for (const entry of snapshot.entries) {
    const normalized = normalizeUrl(entry.url, pageUrl)
    if (!normalized) continue
    const hint = entry.type === 'img' ? 'image' : entry.type === 'media' ? 'video' : undefined
    const classified = classifyResource(normalized, hint)
    if (classified.kind === 'other') continue
    resources.push(
      makeResource(
        {
          url: normalized,
          hint,
          source: 'network',
          discoveryLabel: labelFromInitiator(entry.type)
        },
        pageUrl
      )
    )
  }

  return resources
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  promise.catch(() => undefined)
  return Promise.race([
    promise,
    delay(milliseconds).then(() => fallback)
  ])
}

function capGenericCandidates(candidates: GenericMediaCandidate[]): boolean {
  if (candidates.length <= MAX_GENERIC_CANDIDATES) return false
  candidates.sort((a, b) => b.score - a.score)
  candidates.length = MAX_GENERIC_CANDIDATES
  return true
}

function shouldCaptureJsonEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (!/^https?:$/i.test(parsed.protocol)) return false
    return !/(?:analytics|collect|beacon|tracking|telemetry|pageview|sentry|bugsnag|doubleclick|googletagmanager|google-analytics|hm\.baidu|cnzz|umeng|hotjar|clarity)/i.test(
      `${parsed.hostname}${parsed.pathname}`
    )
  } catch {
    return false
  }
}

function genericCandidateToResource(
  candidate: GenericMediaCandidate,
  pageUrl: string
): MediaResource {
  return makeResource(
    {
      url: candidate.url,
      hint: candidate.hint,
      source: candidate.source,
      discoveryLabel: candidate.discoveryLabel,
      label: candidate.label,
      mime: candidate.mime,
      size: candidate.size,
      width: candidate.width,
      height: candidate.height,
      duration: candidate.duration,
      poster: candidate.poster,
      audioUrl: candidate.audioUrl,
      audioMime: candidate.audioMime,
      qualityId: candidate.qualityId,
      qualityLabel: candidate.qualityLabel,
      groupId: candidate.groupId,
      stream:
        candidate.hint === 'video' && hasStreamExtension(candidate.url)
          ? true
          : undefined
    },
    pageUrl
  )
}

function isHlsMasterUrl(url: string): boolean {
  try {
    return /\.m3u8$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function hasStreamExtension(url: string): boolean {
  try {
    return /\.(?:m3u8|mpd)$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

async function expandGenericHlsResources(
  resources: MediaResource[],
  sniffSession: Session,
  pageUrl: string
): Promise<{ resources: MediaResource[]; warnings: string[] }> {
  const masters = resources
    .filter((resource) => resource.kind === 'video' && isHlsMasterUrl(resource.url))
    .slice(0, MAX_HLS_MASTERS)
  if (masters.length === 0) return { resources, warnings: [] }

  const warnings: string[] = []
  const expanded = new Map<string, MediaResource[]>()
  let variantCount = 0
  let failed = 0
  let separateAudioCount = 0

  await Promise.all(
    masters.map(async (master) => {
      try {
        const response = await sniffSession.fetch(master.url, {
          headers: {
            'user-agent': extractorConstants.USER_AGENT,
            accept: '*/*',
            referer: pageUrl
          },
          signal: AbortSignal.timeout(HLS_FETCH_TIMEOUT_MS)
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`HTTP ${response.status}`)
        }
        const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
        if (Number.isFinite(declaredLength) && declaredLength > 2_000_000) {
          await response.body?.cancel()
          throw new Error('清单过大')
        }
        const text = await response.text()
        if (text.length > 2_000_000) throw new Error('清单过大')
        if (/#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO/i.test(text)) separateAudioCount += 1

        const variants = parseHlsMaster(text, master.url)
        if (variants.length < 2) return

        const baseName = master.filename.replace(/\.[a-z0-9]{1,8}$/i, '')
        const groupId = `generic-hls-${master.id}`
        const masterLabel = master.label || baseName
        const variantLabels = variants.map(qualityLabelOfVariant)
        const labelCounts = new Map<string, number>()
        for (const label of variantLabels) {
          labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
        }
        const nextResources = variants.map((variant, index) => {
          const baseQuality = variantLabels[index]
          const quality =
            (labelCounts.get(baseQuality) ?? 0) > 1 && variant.bandwidth
              ? `${baseQuality} · ${Math.round(variant.bandwidth / 1000)} kbps`
              : baseQuality
          const resource = makeResource(
            {
              url: variant.url,
              hint: 'video',
              mime: 'video/mp4',
              source: 'network',
              discoveryLabel: '通用提取 · HLS 清晰度',
              label: `${masterLabel} · ${quality}`,
              filename: `${baseName}-${quality}.mp4`,
              width: variant.width,
              height: variant.height,
              duration: master.duration,
              poster: master.poster,
              qualityLabel: quality,
              groupId,
              stream: true
            },
            pageUrl
          )
          return {
            ...resource,
            extension: 'mp4',
            mime: 'video/mp4'
          }
        })

        expanded.set(master.url, nextResources)
        variantCount += nextResources.length
      } catch {
        failed += 1
      }
    })
  )

  if (expanded.size > 0) {
    const merged: MediaResource[] = []
    for (const resource of resources) {
      const variants = expanded.get(resource.url)
      if (variants) merged.push(...variants)
      else merged.push(resource)
    }
    warnings.push(`通用提取：已将 HLS 清单展开为 ${variantCount} 个可选清晰度。`)
    if (failed > 0) {
      warnings.push('通用提取：部分 HLS 清单读取失败，已保留原始清单地址。')
    }
    if (separateAudioCount > 0) {
      warnings.push(
        '通用提取：部分 HLS 清单使用独立音轨（EXT-X-MEDIA），当前下载只包含视频分片。'
      )
    }
    return {
      resources: mergeResources([], merged),
      warnings
    }
  }
  if (failed > 0) {
    warnings.push('通用提取：部分 HLS 清单读取失败，已保留原始清单地址。')
  }
  if (separateAudioCount > 0) {
    warnings.push(
      '通用提取：部分 HLS 清单使用独立音轨（EXT-X-MEDIA），当前下载只包含视频分片。'
    )
  }
  return { resources, warnings }
}

export async function sniffPage(
  pageUrl: string,
  onProgress: (progress: ParseProgress) => void
): Promise<SniffPageResult> {
  const sniffSession = getSniffSession()

  const networkMap = new Map<string, MediaResource>()
  activeNetworkMap = networkMap

  sniffSession.webRequest.onResponseStarted({ urls: ['*://*/*'] }, (details) => {
    if (activeNetworkMap !== networkMap) return
    if (networkMap.size >= MAX_NETWORK_RESOURCES) return
    if (shouldSkipNetworkUrl(details.url)) return
    if (['stylesheet', 'script', 'font', 'cspReport'].includes(details.resourceType)) return

    const mime = headerValue(details.responseHeaders, 'content-type')?.split(';')[0].trim().toLowerCase()
    if (mime === 'video/mp2t') return

    const hint: ResourceKind | undefined =
      details.resourceType === 'image'
        ? 'image'
        : details.resourceType === 'media'
          ? mime?.startsWith('audio/')
            ? 'audio'
            : 'video'
          : mimeKind(mime)

    const classified = classifyResource(details.url, hint, mime)
    if (classified.kind === 'other') return
    if ((classified.kind === 'video' || classified.kind === 'audio') &&
        ['ts', 'm4s', 'cmfv', 'cmfa'].includes(classified.extension)) {
      return
    }

    const sizeValue = headerValue(details.responseHeaders, 'content-length')
    const size = sizeValue ? Number.parseInt(sizeValue, 10) : undefined
    if (classified.kind === 'image' && size !== undefined && size > 0 && size < 256) return

    const resource = makeResource(
      {
        url: details.url,
        hint,
        mime,
        size: Number.isFinite(size) ? size : undefined,
        source: 'network',
        discoveryLabel: labelFromInitiator(details.resourceType),
        label: networkLabel(details.url)
      },
      pageUrl
    )
    networkMap.set(resource.url, resource)
  })

  onProgress({ stage: 'browser', message: '正在启动内置浏览器…', percent: 58 })

  const browser = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1440,
    height: 1000,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: sniffSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
      images: true,
      webgl: false
    }
  })
  browser.webContents.setAudioMuted(true)
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  browser.webContents.on('will-navigate', (event, targetUrl) => {
    if (!/^https?:\/\//i.test(targetUrl)) event.preventDefault()
  })

  const warnings: string[] = []
  let loadError: string | undefined
  const jsonCandidates: GenericMediaCandidate[] = []
  const responseInfo = new Map<string, string>()
  const bodyTasks = new Set<Promise<void>>()
  const debuggerSession = browser.webContents.debugger
  let jsonBodyCount = 0
  let jsonBytes = 0
  let genericTruncated = false
  let activeBodyReads = 0
  const bodyReadWaiters: Array<() => void> = []

  const acquireBodyRead = async (): Promise<void> => {
    if (activeBodyReads < MAX_BODY_CONCURRENCY) {
      activeBodyReads += 1
      return
    }
    await new Promise<void>((resolve) => bodyReadWaiters.push(resolve))
    activeBodyReads += 1
  }

  const releaseBodyRead = (): void => {
    activeBodyReads -= 1
    bodyReadWaiters.shift()?.()
  }

  const onCdpMessage = (_event: unknown, method: string, params: unknown): void => {
    const payload = params as {
      requestId?: string
      type?: string
      response?: {
        url?: string
        mimeType?: string
        status?: number
        headers?: Record<string, string>
      }
    }
    const requestId = String(payload.requestId ?? '')
    if (!requestId) return

    if (method === 'Network.responseReceived') {
      if (!['XHR', 'Fetch'].includes(payload.type ?? '')) return
      const url = payload.response?.url
      if (!url || !shouldCaptureJsonEndpoint(url)) return
      const mime = (payload.response?.mimeType ?? '').toLowerCase()
      if (
        mime.includes('html') ||
        mime.includes('css') ||
        mime.includes('javascript') ||
        mime.includes('event-stream') ||
        mime.includes('wasm') ||
        mime.startsWith('image/') ||
        mime.startsWith('video/') ||
        mime.startsWith('audio/') ||
        mime.startsWith('font/')
      ) {
        return
      }
      const contentLength = Number.parseInt(
        payload.response?.headers?.['content-length'] ??
          payload.response?.headers?.['Content-Length'] ??
          '',
        10
      )
      if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) return
      if (responseInfo.size >= MAX_JSON_BODIES) return
      responseInfo.set(requestId, url)
      return
    }

    if (method === 'Network.loadingFailed') {
      responseInfo.delete(requestId)
      return
    }

    if (method !== 'Network.loadingFinished') return
    const infoUrl = responseInfo.get(requestId)
    if (!infoUrl) return
    responseInfo.delete(requestId)
    if (jsonBodyCount >= MAX_JSON_BODIES) return
    jsonBodyCount += 1

    const task = (async (): Promise<void> => {
      await acquireBodyRead()
      try {
        const result = await withTimeout(
          debuggerSession.sendCommand('Network.getResponseBody', { requestId }),
          3500,
          null
        )
        if (!result) return
        const raw = result as { body?: string; base64Encoded?: boolean }
        if (typeof raw.body !== 'string') return
        const body = raw.base64Encoded
          ? Buffer.from(raw.body, 'base64').toString('utf8')
          : raw.body
        if (body.length < 8 || body.length > MAX_JSON_BODY_BYTES) return
        if (jsonBytes + body.length > MAX_JSON_TOTAL_BYTES) {
          genericTruncated = true
          return
        }
        jsonBytes += body.length
        const parsed = parseJsonText(body)
        if (parsed === null) return
        const scan = scanJsonPayload(parsed, {
          pageUrl,
          baseUrl: infoUrl,
          requestUrl: infoUrl,
          discoveryLabel: '通用提取 · 接口 JSON',
          source: 'network'
        })
        genericTruncated = genericTruncated || scan.truncated
        jsonCandidates.push(...scan.candidates)
        if (capGenericCandidates(jsonCandidates)) genericTruncated = true
      } catch {
        // 响应体可能已被浏览器回收，或请求被页面取消；跳过即可。
      } finally {
        releaseBodyRead()
      }
    })().finally(() => bodyTasks.delete(task))

    bodyTasks.add(task)
  }

  try {
    onProgress({ stage: 'browser', message: '正在准备接口响应捕获…', percent: 60 })
    await browser.loadURL('about:blank')
    try {
      debuggerSession.attach('1.3')
      debuggerSession.on('message', onCdpMessage)
      const enabled = await withTimeout(
        debuggerSession.sendCommand('Network.enable').then(() => true),
        4000,
        false
      )
      if (!enabled) throw new Error('Network.enable 超时')
    } catch (error) {
      try {
        if (debuggerSession.isAttached()) debuggerSession.detach()
      } catch {
        // 某些平台在页面尚未就绪时 detach 会抛错，忽略即可。
      }
      warnings.push(
        `接口响应捕获不可用：${
          error instanceof Error ? error.message : '未知错误'
        }。将继续使用页面 DOM 与网络请求嗅探。`
      )
    }

    onProgress({ stage: 'browser', message: '正在加载页面并执行脚本…', percent: 64 })
    await Promise.race([
      browser.loadURL(pageUrl).catch((error: unknown) => {
        loadError = error instanceof Error ? error.message : '页面加载失败'
      }),
      delay(LOAD_TIMEOUT_MS).then(() => {
        if (!browser.isDestroyed()) browser.webContents.stop()
      })
    ])

    if (loadError) warnings.push(`页面加载未完全成功：${loadError}`)

    onProgress({ stage: 'network', message: '正在等待动态资源与懒加载内容…', percent: 74 })
    await delay(1800)

    if (!browser.isDestroyed()) {
      await browser.webContents
        .executeJavaScript(
          String.raw`
            new Promise((resolve) => {
              let steps = 0;
              const started = Date.now();
              const timer = setInterval(() => {
                window.scrollBy(0, Math.max(window.innerHeight * 0.85, 700));
                steps += 1;
                const reachedEnd = window.scrollY + window.innerHeight >= document.body.scrollHeight - 80;
                if (steps >= 9 || reachedEnd || Date.now() - started > 4200) {
                  clearInterval(timer);
                  window.scrollTo(0, 0);
                  setTimeout(resolve, 450);
                }
              }, 360);
            })
          `,
          true
        )
        .catch(() => undefined)
    }

    await delay(1100)
    if (bodyTasks.size > 0) {
      onProgress({
        stage: 'network',
        message: '正在读取接口返回的媒体地址…',
        percent: 80
      })
      await Promise.race([
        Promise.allSettled([...bodyTasks]),
        delay(JSON_BODY_WAIT_MS)
      ])
    }

    onProgress({ stage: 'network', message: '正在整理浏览器中加载的媒体…', percent: 82 })

    let snapshot: DomSnapshot | null = null
    if (!browser.isDestroyed()) {
      const rawSnapshot = await Promise.race([
        browser.webContents.executeJavaScript(DOM_SNAPSHOT_SCRIPT, true).catch(() => null),
        delay(SNAPSHOT_TIMEOUT_MS).then(() => null)
      ])
      snapshot = rawSnapshot as DomSnapshot | null
    }

    const currentUrl = browser.isDestroyed() ? '' : browser.webContents.getURL()
    const finalUrl =
      !currentUrl || /^about:/i.test(currentUrl) ? pageUrl : currentUrl
    const snapshotList = snapshot ? snapshotResources(snapshot, finalUrl) : []
    const runtimeCandidates: GenericMediaCandidate[] = []
    for (const state of snapshot?.states ?? []) {
      const payload = parseJsonText(state.text)
      if (payload === null) continue
      const scan = scanJsonPayload(payload, {
        pageUrl: finalUrl,
        baseUrl: finalUrl,
        discoveryLabel: '通用提取 · 运行时对象',
        source: 'script',
        groupIdPrefix: `${finalUrl}|${state.name}`
      })
      genericTruncated = genericTruncated || scan.truncated
      runtimeCandidates.push(...scan.candidates)
      if (capGenericCandidates(runtimeCandidates)) genericTruncated = true
    }

    const genericCandidates = mergeGenericCandidates(jsonCandidates, runtimeCandidates)
    const genericResources = genericCandidates.map((candidate) =>
      genericCandidateToResource(candidate, finalUrl)
    )
    const mergedResources = mergeResources(
      mergeResources([...networkMap.values()], snapshotList),
      genericResources
    )
    const hls = await expandGenericHlsResources(mergedResources, sniffSession, finalUrl)
    warnings.push(...hls.warnings)
    const resources = hls.resources.slice(
      0,
      extractorConstants.MAX_RESOURCES
    )

    if (genericCandidates.length > 0) {
      warnings.push(
        `通用提取（启发式）从接口响应与运行时对象中发现 ${genericCandidates.length} 项资源，可能包含推荐位、广告或封面图，请核对后下载。`
      )
    }
    if (genericTruncated) {
      warnings.push('通用提取：接口或页面状态数据较多，已限制扫描数量。')
    }

    if (resources.length > 0) {
      const streamCount = resources.filter((resource) => resource.isStream).length
      if (streamCount > 0) {
        warnings.push(
          `发现 ${streamCount} 个流媒体清单/分片入口；HLS 会在下载后自动封装为 MP4。`
        )
      }
      if (resources.some((resource) => /\.mpd$/i.test(new URL(resource.url).pathname))) {
        warnings.push(
          '发现 DASH 清单（.mpd）。当前通用下载器只支持 HLS，DASH 仍需要专用站点适配器。'
        )
      }
    } else {
      warnings.push(
        '深度嗅探没有发现可直接下载的媒体。页面可能需要登录、存在防盗链，或媒体由加密流媒体播放。'
      )
    }

    const favicon = normalizeUrl(snapshot?.favicon, finalUrl) ?? undefined
    return {
      pageUrl,
      finalUrl,
      title: snapshot?.ogTitle || snapshot?.title || undefined,
      description: snapshot?.description || undefined,
      siteName: snapshot?.siteName || undefined,
      favicon,
      resources,
      warnings
    }
  } finally {
    if (activeNetworkMap === networkMap) {
      activeNetworkMap = null
      sniffSession.webRequest.onResponseStarted({ urls: ['*://*/*'] }, null)
    }
    try {
      debuggerSession.removeListener('message', onCdpMessage)
      if (debuggerSession.isAttached()) debuggerSession.detach()
    } catch {
      // 页面已销毁时 debugger 可能自动断开。
    }
    if (!browser.isDestroyed()) browser.destroy()
    sniffSession.clearCache().catch(() => undefined)
    sniffSession.clearStorageData().catch(() => undefined)
  }
}
