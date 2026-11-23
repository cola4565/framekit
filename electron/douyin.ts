import { createHash } from 'node:crypto'
import { BrowserWindow, session, shell } from 'electron'
import type { OnResponseStartedListenerDetails, Session } from 'electron'
import type { MediaResource, ParseProgress } from '../src/shared/types'
import { sanitizeFilename } from './extractor'

const DOUYIN_PARTITION = 'persist:douyin'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const LOAD_TIMEOUT_MS = 32000
const CAPTURE_TIMEOUT_MS = 18000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOGIN_POLL_MS = 1000
const LOGIN_COOKIE_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_tt'])

interface DouyinStream {
  url: string
  kind: 'video' | 'audio'
  mime?: string
  at: number
  sessionKey: string
  bitrate: number
}

interface DouyinMetadata {
  title: string
  description?: string
  poster?: string
  width?: number
  height?: number
  duration?: number
}

export interface DouyinExtractResult {
  finalUrl: string
  title: string
  description?: string
  favicon?: string
  resources: MediaResource[]
  warnings: string[]
}

const configuredSessions = new WeakSet<Session>()
let activeCapture: ((details: OnResponseStartedListenerDetails) => void) | null = null
let cachedCookie = { value: '', at: 0 }
let cachedAuth = { value: false, at: 0 }

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), milliseconds)
  })
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isDouyinHost(hostname: string): boolean {
  return hostname === 'douyin.com' || hostname.endsWith('.douyin.com')
}

export function isDouyinPageUrl(rawUrl: string): boolean {
  try {
    return isDouyinHost(new URL(rawUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function isDouyinVideoUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.toLowerCase()
    if (host === 'v.douyin.com') return true
    return isDouyinHost(host) && /^\/(?:video|note)\/\d+/i.test(parsed.pathname)
  } catch {
    return false
  }
}

function douyinSession(): Session {
  const browserSession = session.fromPartition(DOUYIN_PARTITION)
  if (configuredSessions.has(browserSession)) return browserSession
  configuredSessions.add(browserSession)
  browserSession.setUserAgent(USER_AGENT)
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.on('will-download', (event) => event.preventDefault())
  browserSession.webRequest.onResponseStarted({ urls: ['*://*/*'] }, (details) => {
    activeCapture?.(details)
  })
  return browserSession
}

export async function getDouyinCookieHeader(): Promise<string> {
  if (Date.now() - cachedCookie.at < 15000) return cachedCookie.value
  try {
    const cookies = await douyinSession().cookies.get({})
    const value = cookies
      .filter((cookie) => {
        const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
        return domain === 'douyin.com' || domain.endsWith('.douyin.com')
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
    cachedCookie = { value, at: Date.now() }
    return value
  } catch {
    return ''
  }
}

export async function getDouyinAuthStatus(force = false): Promise<boolean> {
  if (!force && Date.now() - cachedAuth.at < 60000) return cachedAuth.value
  try {
    const cookies = await douyinSession().cookies.get({})
    const loggedIn = cookies.some(
      (cookie) =>
        LOGIN_COOKIE_NAMES.has(cookie.name) &&
        Boolean(cookie.value) &&
        cookie.value !== 'deleted'
    )
    cachedAuth = { value: loggedIn, at: Date.now() }
    return loggedIn
  } catch {
    return cachedAuth.value
  }
}

function loginHostAllowed(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.toLowerCase()
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      (isDouyinHost(host) ||
        host === 'iesdouyin.com' ||
        host.endsWith('.iesdouyin.com'))
    )
  } catch {
    return false
  }
}

export async function loginDouyin(parent: BrowserWindow | null): Promise<boolean> {
  if (await getDouyinAuthStatus(true)) return true

  const browser = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    show: true,
    title: '登录抖音 - FrameKit',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    ...(parent ? { parent } : {}),
    webPreferences: {
      session: douyinSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false
    }
  })

  browser.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (loginHostAllowed(url)) {
        void browser.loadURL(parsed.href)
      } else if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(parsed.href)
      }
    } catch {
      // Ignore malformed popup URLs.
    }
    return { action: 'deny' }
  })

  browser.webContents.on('will-navigate', (event, targetUrl) => {
    if (!loginHostAllowed(targetUrl)) event.preventDefault()
  })

  await browser.loadURL('https://www.douyin.com/').catch(() => undefined)

  return new Promise<boolean>((resolve) => {
    let settled = false
    let probing = false
    const finish = (loggedIn: boolean): void => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(timeoutTimer)
      if (loggedIn) {
        cachedAuth = { value: true, at: Date.now() }
        cachedCookie = { value: '', at: 0 }
      }
      if (!browser.isDestroyed()) browser.close()
      resolve(loggedIn)
    }
    const pollTimer = setInterval(() => {
      if (probing) return
      probing = true
      void getDouyinAuthStatus(true)
        .then((loggedIn) => {
          if (loggedIn) finish(true)
        })
        .finally(() => {
          probing = false
        })
    }, LOGIN_POLL_MS)
    const timeoutTimer = setTimeout(() => finish(false), LOGIN_TIMEOUT_MS)
    browser.on('closed', () => finish(false))
  })
}

function streamFromDetails(details: OnResponseStartedListenerDetails): DouyinStream | null {
  if (!/^https?:\/\//i.test(details.url)) return null
  let parsed: URL
  try {
    parsed = new URL(details.url)
  } catch {
    return null
  }

  const host = parsed.hostname.toLowerCase()
  if (!host.endsWith('douyinvod.com') && !host.endsWith('douyin.com')) return null
  if (/douyin_pc_client|uuu_265|\/obj\/douyin-pc-web\//i.test(details.url)) return null

  const path = parsed.pathname.toLowerCase()
  const mime = headerValue(details.responseHeaders, 'content-type')
    ?.split(';')[0]
    .trim()
    .toLowerCase() ?? ''
  const isAudio = path.includes('media-audio') || mime.startsWith('audio/')
  const isVideo = path.includes('media-video') || (!isAudio && mime.startsWith('video/'))
  if (!isAudio && !isVideo) return null

  const bitrate = Number.parseInt(parsed.searchParams.get('br') ?? '', 10)
  return {
    url: details.url,
    kind: isAudio ? 'audio' : 'video',
    mime: mime || undefined,
    at: Date.now(),
    sessionKey: parsed.searchParams.get('l') ?? '',
    bitrate: Number.isFinite(bitrate) ? bitrate : 0
  }
}

function headerValue(
  headers: OnResponseStartedListenerDetails['responseHeaders'],
  name: string
): string | undefined {
  if (!headers) return undefined
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name)
  return key ? headers[key]?.[0] : undefined
}

function pickBest(streams: DouyinStream[]): DouyinStream | undefined {
  return [...streams].sort((left, right) => right.bitrate - left.bitrate)[0]
}

function groupStreams(streams: DouyinStream[]): Array<{
  video: DouyinStream
  audio?: DouyinStream
}> {
  const groups = new Map<string, { videos: DouyinStream[]; audios: DouyinStream[] }>()
  let anonymousIndex = 0
  for (const stream of streams) {
    const key = stream.sessionKey || `anonymous-${anonymousIndex++}`
    const group = groups.get(key) ?? { videos: [], audios: [] }
    if (stream.kind === 'audio') group.audios.push(stream)
    else group.videos.push(stream)
    groups.set(key, group)
  }

  const paired: Array<{ video: DouyinStream; audio?: DouyinStream }> = []
  for (const group of groups.values()) {
    const video = pickBest(group.videos)
    if (!video) continue
    paired.push({ video, audio: pickBest(group.audios) })
  }

  if (paired.length === 0) {
    const video = pickBest(streams.filter((stream) => stream.kind === 'video'))
    if (video) {
      const audio = pickBest(streams.filter((stream) => stream.kind === 'audio'))
      paired.push({ video, audio })
    }
  }

  return paired.sort((left, right) => left.video.at - right.video.at)
}

function cleanTitle(value: string | undefined): string {
  return (value ?? '').replace(/\s*[-|]\s*抖音\s*$/i, '').trim()
}

function hashId(url: string): string {
  return `douyin_${createHash('sha1').update(url).digest('hex').slice(0, 12)}`
}

function formatBitrate(bitrate: number): string {
  if (bitrate <= 0) return ''
  return bitrate >= 1000 ? `${(bitrate / 1000).toFixed(1)}Mbps` : `${Math.round(bitrate)}kbps`
}

export async function extractDouyinPage(
  pageUrl: string,
  onProgress: (progress: ParseProgress) => void
): Promise<DouyinExtractResult> {
  const browserSession = douyinSession()
  const browser = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1280,
    height: 820,
    backgroundColor: '#000000',
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  browser.webContents.setAudioMuted(true)
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const streams: DouyinStream[] = []
  const seen = new Set<string>()
  const capture = (details: OnResponseStartedListenerDetails): void => {
    const stream = streamFromDetails(details)
    if (!stream || seen.has(stream.url)) return
    seen.add(stream.url)
    streams.push(stream)
  }
  activeCapture = capture

  try {
    onProgress({
      stage: 'browser',
      message: '识别到抖音，正在启动专用播放器嗅探…',
      percent: 62
    })

    await withTimeout(browser.loadURL(pageUrl).catch(() => undefined), LOAD_TIMEOUT_MS, undefined)
    if (!browser.isDestroyed()) {
      await delay(1800)
      await browser.webContents
        .executeJavaScript(
          String.raw`
            new Promise((resolve) => {
              const video = document.querySelector('video');
              if (video) {
                video.muted = true;
                video.play().catch(() => {});
              }
              setTimeout(resolve, 900);
            })
          `,
          true
        )
        .catch(() => undefined)
    }

    onProgress({
      stage: 'network',
      message: '正在捕获抖音视频流与独立音频流…',
      percent: 76
    })

    const startedWaiting = Date.now()
    while (Date.now() - startedWaiting < CAPTURE_TIMEOUT_MS) {
      const hasVideo = streams.some((stream) => stream.kind === 'video')
      const hasAudio = streams.some((stream) => stream.kind === 'audio')
      if (hasVideo && hasAudio) break
      if (hasVideo && Date.now() - startedWaiting > 6000) break
      await delay(250)
    }

    const metadata = (await withTimeout(
      browser.isDestroyed()
        ? Promise.resolve(null)
        : browser.webContents.executeJavaScript(
            String.raw`(() => {
              const meta = (name) => {
                const element = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
                return element ? element.getAttribute('content') || '' : '';
              };
              const video = document.querySelector('video');
              return {
                title: meta('og:title') || document.title || '',
                description: meta('og:description') || meta('description') || '',
                poster: meta('og:image') || '',
                width: video && video.videoWidth ? video.videoWidth : undefined,
                height: video && video.videoHeight ? video.videoHeight : undefined,
                duration: video && Number.isFinite(video.duration) ? video.duration : undefined
              };
            })()`,
            true
          ),
      8000,
      null
    )) as DouyinMetadata | null

    const groups = groupStreams(streams)
    if (groups.length === 0) {
      throw new Error(
        '抖音页面没有返回可下载的视频流，可能需要完成验证码、登录，或该视频已设为不可访问'
      )
    }

    const finalUrl = browser.isDestroyed() ? pageUrl : browser.webContents.getURL() || pageUrl
    const title = cleanTitle(metadata?.title) || '抖音视频'
    const titleBase =
      sanitizeFilename(title.split('#')[0].trim()).slice(0, 70) || 'douyin-video'
    const awemeId =
      /\/video\/(\d+)/.exec(finalUrl)?.[1] ?? /\/video\/(\d+)/.exec(pageUrl)?.[1] ?? 'video'
    const warnings: string[] = []

    const resources: MediaResource[] = groups.map((group, index) => {
      const video = group.video
      const audio = group.audio
      const suffix = groups.length > 1 ? `-${index + 1}` : ''
      const bitrateLabel = formatBitrate(video.bitrate)
      const quality = bitrateLabel ? ` · ${bitrateLabel}` : ''
      return {
        id: hashId(video.url),
        url: video.url,
        kind: 'video',
        source: 'network',
        pageUrl: finalUrl,
        filename: `${titleBase}${suffix}.mp4`,
        extension: 'mp4',
        mime: 'video/mp4',
        width: metadata?.width,
        height: metadata?.height,
        duration: metadata?.duration,
        poster: metadata?.poster || undefined,
        label: `${title}${quality}`,
        discoveryLabel: '抖音专用解析 · 下载后自动合并音轨',
        isStream: false,
        audioUrl: audio?.url,
        audioMime: 'audio/mp4',
        qualityLabel: bitrateLabel || undefined,
        mergeAudio: Boolean(audio),
        groupId: `douyin-${awemeId}`
      }
    })

    if (resources.some((resource) => resource.mergeAudio)) {
      warnings.push('抖音的视频流与音频流是分离的，下载完成后会自动合并为标准 MP4。')
    } else {
      warnings.push('没有捕获到独立音频流，下载结果可能是无声视频。')
    }

    onProgress({ stage: 'merge', message: '正在整理抖音视频信息…', percent: 94 })

    return {
      finalUrl,
      title,
      description: metadata?.description || undefined,
      favicon: 'https://www.douyin.com/favicon.ico',
      resources,
      warnings
    }
  } finally {
    activeCapture = null
    if (!browser.isDestroyed()) browser.destroy()
  }
}
