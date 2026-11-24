import { BrowserWindow, session, shell } from 'electron'
import type { OnResponseStartedListenerDetails, Session } from 'electron'
import type { MediaResource, ParseProgress } from '../src/shared/types'
import { classifyResource, extractorConstants, makeResource } from './extractor'

const WEIBO_PARTITION = 'persist:weibo'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const LOAD_TIMEOUT_MS = 30000
const SETTLE_MS = 6000
const SEED_TIMEOUT_MS = 12000

/** 移动端接口用手机 UA 响应更直接，也更容易拿到访客可见的内容。 */
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

/** 微博视频 CDN 直链的域名。 */
const VIDEO_CDN_HOSTS = ['video.weibocdn.com', 'f.video.weibocdn.com', 't.video.weibocdn.com']

interface WeiboMediaInfo {
  stream_url?: string
  stream_url_hd?: string
  duration?: number
}

interface WeiboPagePic {
  url?: string
  width?: string | number
  height?: string | number
}

interface WeiboPageInfo {
  type?: string
  title?: string
  page_title?: string
  page_pic?: WeiboPagePic | string
  media_info?: WeiboMediaInfo
}

interface WeiboStatus {
  mid?: string
  idstr?: string
  created_at?: string
  text_raw?: string
  text?: string
  user?: { screen_name?: string }
  page_info?: WeiboPageInfo
}

interface WeiboStatusResponse {
  ok?: number
  msg?: string
  data?: WeiboStatus
}

interface WeiboMetadata {
  title: string
  description?: string
  poster?: string
  width?: number
  height?: number
}

export interface WeiboExtractResult {
  finalUrl: string
  title: string
  description?: string
  favicon?: string
  resources: MediaResource[]
  warnings: string[]
}

const configuredSessions = new WeakSet<Session>()
let activeCapture: ((details: OnResponseStartedListenerDetails) => void) | null = null

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isWeiboHost(hostname: string): boolean {
  return (
    hostname === 'weibo.com' ||
    hostname.endsWith('.weibo.com') ||
    hostname === 'weibo.cn' ||
    hostname.endsWith('.weibo.cn')
  )
}

export function isWeiboPageUrl(rawUrl: string): boolean {
  try {
    return isWeiboHost(new URL(rawUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 微博视频的两种地址：
 * - `weibo.com/tv/show/<oid>:<mid>`：单条视频页，能直接拿到播放地址。
 * - `weibo.com/u/<uid>?...&layerid=<mid>`：个人主页 / 列表页，
 *   `layerid` 就是被点开那条视频的 mid。
 *
 * 列表页是 SPA，媒体由脚本懒加载，且未登录时会被微博的访客系统拦一层，
 * 静态扫描与一次性嗅探都拿不到视频。这里把 `layerid` 改写成
 * `tv/show` 单条视频页——访客系统会在那个页面正常放行。
 */
export function isWeiboVideoUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (!isWeiboHost(parsed.hostname.toLowerCase())) return false
    if (/^\/tv\/show\//i.test(parsed.pathname)) return true
    return Boolean(extractLayerId(rawUrl))
  } catch {
    return false
  }
}

/** 从地址里取出 `layerid`（列表页上被点开那条视频的 mid）。 */
export function extractLayerId(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    const value = parsed.searchParams.get('layerid')
    return value && /^\d{10,}$/.test(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 从地址里取出视频 mid。
 * - `weibo.com/tv/show/1034:<mid>`：路径里直接带 mid。
 * - `weibo.com/u/<uid>?...&layerid=<mid>`：列表页上被点开那条视频的 mid。
 * - `weibo.com/detail/<mid>` / `m.weibo.cn/detail/<mid>`：详情页。
 */
export function extractWeiboMid(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.toLowerCase()
    if (!isWeiboHost(host)) return null

    const tvShow = parsed.pathname.match(/^\/tv\/show\/[^/]*?:(\d{10,})/i)
    if (tvShow) return tvShow[1]

    const detail = parsed.pathname.match(/^\/(?:detail|status)\/(\d{10,})/i)
    if (detail) return detail[1]

    return extractLayerId(rawUrl)
  } catch {
    return null
  }
}

/** 把带 `layerid` 的地址改写成单条视频页地址。 */
export function toWeiboVideoPageUrl(rawUrl: string): string {
  const layerId = extractLayerId(rawUrl)
  if (!layerId) return rawUrl
  return `https://weibo.com/tv/show/1034:${layerId}`
}

function weiboSession(): Session {
  const browserSession = session.fromPartition(WEIBO_PARTITION)
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

export async function getWeiboCookieHeader(): Promise<string> {
  try {
    const cookies = await weiboSession().cookies.get({})
    return cookies
      .filter((cookie) => {
        const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
        return domain === 'weibo.com' || domain.endsWith('.weibo.com')
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
  } catch {
    return ''
  }
}

/**
 * 让微博发放访客身份（SUB Cookie）。
 *
 * 微博对未登录访客会先跳 `passport.weibo.com/visitor/visitor`，
 * 算完设备指纹才发 SUB。走一次首页就能拿到，之后接口与页面都能用。
 */
async function ensureVisitorIdentity(browserSession: Session): Promise<boolean> {
  try {
    const cookies = await browserSession.cookies.get({ domain: '.weibo.com' })
    const hasSub = cookies.some(
      (cookie) => cookie.name === 'SUB' && Boolean(cookie.value) && cookie.value !== 'deleted'
    )
    if (hasSub) return true
  } catch {
    return false
  }

  const seed = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  try {
    void seed.loadURL('https://m.weibo.cn/').catch(() => undefined)
    const deadline = Date.now() + SEED_TIMEOUT_MS
    while (Date.now() < deadline) {
      await delay(800)
      const cookies = await browserSession.cookies.get({ domain: '.weibo.com' })
      if (
        cookies.some(
          (cookie) => cookie.name === 'SUB' && Boolean(cookie.value) && cookie.value !== 'deleted'
        )
      ) {
        return true
      }
    }
  } catch {
    // Ignore and let the caller fall back.
  } finally {
    if (!seed.isDestroyed()) seed.destroy()
  }
  return false
}

/**
 * 用移动端接口读取一条微博的播放地址。
 *
 * `m.weibo.cn/statuses/show?id=<mid>` 在拿到访客 Cookie 后会返回
 * `page_info.media_info` 里的 stream_url 直链，比在网页里嗅探可靠得多：
 * 列表页（SPA + 懒加载）和访客跳转都会让嗅探失败，接口不受影响。
 */
async function fetchStatusByApi(
  browserSession: Session,
  mid: string
): Promise<WeiboStatus | null> {
  const apiUrl = `https://m.weibo.cn/statuses/show?id=${encodeURIComponent(mid)}`
  const response = await browserSession.fetch(apiUrl, {
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: `https://m.weibo.cn/detail/${mid}`,
      'x-requested-with': 'XMLHttpRequest',
      'user-agent': MOBILE_USER_AGENT
    },
    signal: AbortSignal.timeout(20000)
  })
  if (!response.ok) return null

  // Electron 的 Session.fetch 返回的 Response 里 json() 不可靠，
  // 统一按文本读再解析。
  const body = await response.text()
  let payload: WeiboStatusResponse
  try {
    payload = JSON.parse(body) as WeiboStatusResponse
  } catch {
    return null
  }
  if (!payload?.ok || !payload.data) return null
  return payload.data
}

function resourceFromStream(
  url: string,
  label: string,
  pageUrl: string,
  duration?: number
): MediaResource {
  return makeResource(
    {
      url,
      hint: 'video',
      mime: 'video/mp4',
      source: 'network',
      discoveryLabel: label,
      duration
    },
    pageUrl
  )
}

/**
 * 封面地址。微博接口的 `page_pic` 是 `{ url, width, height }` 对象，
 * 少数版本直接给字符串，两种都要认。
 */
function extractPosterUrl(pagePic: WeiboPagePic | string | undefined): string | undefined {
  if (!pagePic) return undefined
  if (typeof pagePic === 'string') return pagePic || undefined
  return typeof pagePic.url === 'string' && pagePic.url ? pagePic.url : undefined
}

function isVideoStreamUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    if (VIDEO_CDN_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) {
      return true
    }
  } catch {
    return false
  }
  return /\.(?:mp4|m3u8|mov|flv)(?:\?|$)/i.test(rawUrl)
}

function isPosterUrl(rawUrl: string): boolean {
  return /(?:^|\.)tvc\.sinaimg\.com|(?:^|\.)wx\d*\.sinaimg\.com/i.test(rawUrl)
}

export async function extractWeiboPage(
  rawUrl: string,
  onProgress: (progress: ParseProgress) => void
): Promise<WeiboExtractResult> {
  const browserSession = weiboSession()
  const mid = extractWeiboMid(rawUrl)
  const warnings: string[] = []

  // 通道一：接口。拿到访客身份后直接读 mid 的播放地址，
  // 列表页（SPA + 懒加载）和访客跳转都不会影响它。
  if (mid) {
    onProgress({ stage: 'browser', message: '正在获取微博访客身份…', percent: 48 })
    await ensureVisitorIdentity(browserSession)

    onProgress({ stage: 'network', message: '正在读取微博视频地址…', percent: 60 })
    const status = await fetchStatusByApi(browserSession, mid).catch(() => null)
    const media = status?.page_info?.media_info
    const streamUrls = [media?.stream_url_hd, media?.stream_url].filter(
      (value): value is string => typeof value === 'string' && value.startsWith('http')
    )

    if (streamUrls.length > 0) {
      const poster = extractPosterUrl(status?.page_info?.page_pic)
      const resources: MediaResource[] = streamUrls.map((url, index) => {
        const resource = resourceFromStream(
          url,
          index === 0 ? '微博视频（高清）' : '微博视频',
          rawUrl,
          media?.duration
        )
        if (poster) resource.poster = poster
        return resource
      })

      if (poster) {
        resources.push(
          makeResource(
            {
              url: poster,
              hint: 'image',
              source: 'network',
              discoveryLabel: '微博视频封面'
            },
            rawUrl
          )
        )
      }

      const title =
        status?.page_info?.page_title?.trim() ||
        status?.user?.screen_name?.trim() ||
        '微博视频'

      onProgress({
        stage: 'done',
        message: `微博解析完成，共 ${resources.length} 项资源`,
        percent: 100
      })
      return {
        finalUrl: `https://weibo.com/tv/show/1034:${mid}`,
        title,
        description: status?.text_raw?.trim() || status?.text?.trim() || undefined,
        favicon: 'https://weibo.com/favicon.ico',
        resources,
        warnings
      }
    }

    if (status) {
      warnings.push('微博接口没有返回该条微博的视频地址。')
    }
  }

  // 通道二：浏览器。接口拿不到时回到视频页嗅探真实网络请求。
  return sniffWeiboVideo(rawUrl, mid, browserSession, onProgress, warnings)
}

async function sniffWeiboVideo(
  rawUrl: string,
  mid: string | null,
  browserSession: Session,
  onProgress: (progress: ParseProgress) => void,
  warnings: string[]
): Promise<WeiboExtractResult> {
  const targetUrl = mid
    ? `https://weibo.com/tv/show/1034:${mid}`
    : toWeiboVideoPageUrl(rawUrl)

  const videos = new Map<string, MediaResource>()
  const posters = new Map<string, MediaResource>()

  activeCapture = (details) => {
    const url = details.url
    if (isVideoStreamUrl(url)) {
      if (videos.has(url)) return
      videos.set(
        url,
        makeResource(
          {
            url,
            hint: 'video',
            mime: 'video/mp4',
            source: 'network',
            discoveryLabel: '微博视频流'
          },
          targetUrl
        )
      )
      return
    }
    if (isPosterUrl(url) && !posters.has(url)) {
      posters.set(
        url,
        makeResource(
          {
            url,
            hint: 'image',
            source: 'network',
            discoveryLabel: '微博视频封面'
          },
          targetUrl
        )
      )
    }
  }

  const browser = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1440,
    height: 1000,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: browserSession,
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

  try {
    onProgress({ stage: 'browser', message: '正在打开微博视频页…', percent: 70 })

    // 访客系统会先跳一次 passport.weibo.com，再回到视频页；
    // 这里不等待 loadURL 完成，避免跳转链把调用挂死。
    void browser.loadURL(targetUrl).catch((error: unknown) => {
      warnings.push(
        `微博页面加载未完全成功：${error instanceof Error ? error.message : '未知错误'}`
      )
    })

    const deadline = Date.now() + LOAD_TIMEOUT_MS
    while (Date.now() < deadline) {
      await delay(900)
      if (videos.size > 0) break
      if (browser.isDestroyed()) break
    }

    onProgress({ stage: 'network', message: '正在等待视频地址加载…', percent: 82 })
    await delay(SETTLE_MS)

    let metadata: WeiboMetadata = { title: '' }
    if (!browser.isDestroyed()) {
      const raw = await browser.webContents
        .executeJavaScript(
          String.raw`(() => {
            const absolute = (value) => {
              if (!value || typeof value !== 'string') return '';
              if (/^(data|blob|javascript):/i.test(value)) return '';
              try { return new URL(value, document.baseURI).href; } catch (_) { return ''; }
            };
            const video = document.querySelector('video');
            const meta = (name) => {
              const element = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
              return element ? element.getAttribute('content') || '' : '';
            };
            return {
              title: meta('og:title') || document.title || '',
              description: meta('og:description') || meta('description') || '',
              poster: video ? absolute(video.poster) : absolute(meta('og:image')),
              width: video ? video.videoWidth : 0,
              height: video ? video.videoHeight : 0
            };
          })()`,
          true
        )
        .catch(() => null)
      if (raw) {
        metadata = {
          title: String((raw as { title?: string }).title ?? ''),
          description: String((raw as { description?: string }).description ?? '') || undefined,
          poster: String((raw as { poster?: string }).poster ?? '') || undefined,
          width: Number((raw as { width?: number }).width) || undefined,
          height: Number((raw as { height?: number }).height) || undefined
        }
      }
    }

    // 视频元素上的直链兜底：有些情况下请求没被监听到，但 DOM 里有。
    if (!browser.isDestroyed()) {
      const domUrls = await browser.webContents
        .executeJavaScript(
          String.raw`(() => {
            const absolute = (value) => {
              if (!value || typeof value !== 'string') return '';
              try { return new URL(value, document.baseURI).href; } catch (_) { return ''; }
            };
            const list = [];
            for (const video of document.querySelectorAll('video')) {
              const src = absolute(video.currentSrc || video.src);
              if (src) list.push(src);
              for (const source of video.querySelectorAll('source')) {
                const value = absolute(source.src || source.getAttribute('src'));
                if (value) list.push(value);
              }
            }
            return list;
          })()`,
          true
        )
        .catch(() => [] as string[])
      for (const url of domUrls as string[]) {
        if (!videos.has(url)) {
          videos.set(
            url,
            makeResource(
              {
                url,
                hint: 'video',
                mime: 'video/mp4',
                source: 'network',
                discoveryLabel: '微博视频流'
              },
              targetUrl
            )
          )
        }
      }
    }

    const resources: MediaResource[] = [...videos.values(), ...posters.values()].slice(
      0,
      extractorConstants.MAX_RESOURCES
    )

    if (videos.size === 0) {
      warnings.push(
        '没有抓到微博视频地址。该视频可能需要登录、已删除，或属于仅登录可见的内容。'
      )
    }

    const poster = metadata.poster
    if (poster) {
      for (const resource of resources) {
        if (resource.kind === 'video' && !resource.poster) {
          resource.poster = poster
        }
      }
    }

    const title = metadata.title.replace(/\s*-\s*视频\s*-\s*微博\s*$/, '').trim()

    return {
      finalUrl: browser.isDestroyed() ? targetUrl : browser.webContents.getURL() || targetUrl,
      title: title || '微博视频',
      description: metadata.description,
      favicon: 'https://weibo.com/favicon.ico',
      resources,
      warnings
    }
  } finally {
    activeCapture = null
    if (!browser.isDestroyed()) browser.destroy()
  }
}

/**
 * 在内置窗口里登录微博。访客身份看不到全部内容，登录后能读更多视频。
 */
export async function loginWeibo(parent: BrowserWindow | null): Promise<boolean> {
  const browser = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 880,
    minHeight: 640,
    show: true,
    title: '登录微博 - FrameKit',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    ...(parent ? { parent } : {}),
    webPreferences: {
      session: weiboSession(),
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
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(parsed.href)
      }
    } catch {
      // Ignore malformed popup URLs.
    }
    return { action: 'deny' }
  })

  await browser.loadURL('https://passport.weibo.com/').catch(() => undefined)

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(timeoutTimer)
      if (!browser.isDestroyed()) browser.destroy()
      resolve(ok)
    }
    const pollTimer = setInterval(() => {
      void browser.webContents
        .executeJavaScript(
          `(() => {
            const cookie = document.cookie || '';
            return /(^|;\\s*)SUB=([^;]+)/.test(cookie) && !/SUB=deleted/.test(cookie);
          })()`,
          true
        )
        .then((ok) => {
          if (ok) finish(true)
        })
        .catch(() => undefined)
    }, 1500)
    const timeoutTimer = setTimeout(() => finish(false), 5 * 60 * 1000)
  })
}

export async function getWeiboAuthStatus(): Promise<boolean> {
  try {
    const cookies = await weiboSession().cookies.get({})
    return cookies.some(
      (cookie) =>
        cookie.name === 'SUB' && Boolean(cookie.value) && cookie.value !== 'deleted'
    )
  } catch {
    return false
  }
}

export { classifyResource }
