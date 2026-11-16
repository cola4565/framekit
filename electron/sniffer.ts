import { randomUUID } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
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

const MAX_NETWORK_RESOURCES = 700
const LOAD_TIMEOUT_MS = 28000
const SNAPSHOT_TIMEOUT_MS = 9000

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
    for (const element of document.querySelectorAll('body *')) {
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
    entries
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

export async function sniffPage(
  pageUrl: string,
  onProgress: (progress: ParseProgress) => void
): Promise<SniffPageResult> {
  const partition = `sniff-${randomUUID()}`
  const sniffSession = session.fromPartition(partition, { cache: false })
  sniffSession.setUserAgent(extractorConstants.USER_AGENT)
  sniffSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  sniffSession.setPermissionCheckHandler(() => false)
  sniffSession.on('will-download', (event) => event.preventDefault())

  const networkMap = new Map<string, MediaResource>()

  sniffSession.webRequest.onResponseStarted({ urls: ['*://*/*'] }, (details) => {
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

  try {
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
    onProgress({ stage: 'network', message: '正在整理浏览器中加载的媒体…', percent: 82 })

    let snapshot: DomSnapshot | null = null
    if (!browser.isDestroyed()) {
      const rawSnapshot = await Promise.race([
        browser.webContents.executeJavaScript(DOM_SNAPSHOT_SCRIPT, true).catch(() => null),
        delay(SNAPSHOT_TIMEOUT_MS).then(() => null)
      ])
      snapshot = rawSnapshot as DomSnapshot | null
    }

    const finalUrl = browser.isDestroyed() ? pageUrl : browser.webContents.getURL() || pageUrl
    const snapshotList = snapshot ? snapshotResources(snapshot, finalUrl) : []
    const resources = mergeResources([...networkMap.values()], snapshotList).slice(
      0,
      extractorConstants.MAX_RESOURCES
    )

    if (resources.length > 0) {
      const streamCount = resources.filter((resource) => resource.isStream).length
      if (streamCount > 0) {
        warnings.push(
          `发现 ${streamCount} 个 HLS/DASH 流媒体清单。清单本身不是成片文件，后续需要转码或专用下载器处理。`
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
    if (!browser.isDestroyed()) browser.destroy()
    sniffSession.clearCache().catch(() => undefined)
    sniffSession.clearStorageData().catch(() => undefined)
  }
}
