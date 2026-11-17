import { BrowserWindow, session, shell } from 'electron'
import type { Session } from 'electron'
import type { MediaResource, ParseProgress } from '../src/shared/types'
import { sanitizeFilename } from './extractor'

const BILIBILI_PARTITION = 'persist:bilibili'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 28000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const configuredSessions = new WeakSet<Session>()

interface BilibiliVideoStream {
  id: number
  codecid: number
  width: number
  height: number
  bandwidth: number
  baseUrl?: string
  base_url?: string
}

interface BilibiliAudioStream {
  id: number
  bandwidth: number
  mimeType?: string
  mime_type?: string
  baseUrl?: string
  base_url?: string
}

interface BilibiliFormat {
  quality: number
  newname?: string
  new_description?: string
  display_desc?: string
  need_login?: boolean
  need_vip?: boolean
}

interface BilibiliPageData {
  ok: boolean
  source: 'api' | 'page' | 'none'
  error?: string
  bvid?: string
  cid?: number
  page: number
  pageCount: number
  title?: string
  partTitle?: string
  poster?: string
  duration?: number
  video: BilibiliVideoStream[]
  audio: BilibiliAudioStream[]
  formats: BilibiliFormat[]
}

export interface BilibiliExtractResult {
  finalUrl: string
  title: string
  description?: string
  favicon?: string
  resources: MediaResource[]
  warnings: string[]
}

const QUALITY_NAMES: Record<number, string> = {
  127: '8K 超高清',
  126: '杜比视界',
  125: 'HDR 真彩',
  120: '4K 超清',
  116: '1080P60 高帧率',
  112: '1080P+ 高码率',
  80: '1080P 高清',
  74: '720P60 高帧率',
  64: '720P 准高清',
  32: '480P 标清',
  16: '360P 流畅',
  6: '240P 极速'
}

const CODEC_NAMES: Record<number, string> = {
  7: 'H.264',
  12: 'HEVC',
  13: 'AV1'
}

const CODEC_PRIORITY: Record<number, number> = {
  7: 0,
  12: 1,
  13: 2
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isBilibiliHost(hostname: string): boolean {
  return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')
}

function bilibiliSession(): Session {
  const browserSession = session.fromPartition(BILIBILI_PARTITION)
  if (configuredSessions.has(browserSession)) return browserSession
  configuredSessions.add(browserSession)
  browserSession.setUserAgent(USER_AGENT)
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.on('will-download', (event) => event.preventDefault())
  return browserSession
}

export function isBilibiliVideoUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.toLowerCase()
    if (host === 'b23.tv') return true
    return isBilibiliHost(host) && /^\/(?:video|list)\//i.test(parsed.pathname)
  } catch {
    return false
  }
}

export async function getBilibiliAuthStatus(): Promise<boolean> {
  const cookies = await bilibiliSession().cookies.get({ name: 'SESSDATA' })
  return cookies.some((cookie) => Boolean(cookie.value) && cookie.value !== 'deleted')
}

export async function getBilibiliCookieHeader(): Promise<string> {
  if (!(await getBilibiliAuthStatus())) return ''
  const cookies = await bilibiliSession().cookies.get({})
  return cookies
    .filter((cookie) => {
      const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
      return domain === 'bilibili.com' || domain.endsWith('.bilibili.com')
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

export async function loginBilibili(parent: BrowserWindow | null): Promise<boolean> {
  if (await getBilibiliAuthStatus()) return true

  const browser = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    show: true,
    title: '登录 Bilibili - FrameKit',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    ...(parent ? { parent } : {}),
    webPreferences: {
      session: bilibiliSession(),
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
      if (isBilibiliHost(parsed.hostname)) {
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
    try {
      const parsed = new URL(targetUrl)
      if (!isBilibiliHost(parsed.hostname)) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })

  await browser.loadURL('https://www.bilibili.com').catch(() => undefined)

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (loggedIn: boolean): void => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(timeoutTimer)
      if (!browser.isDestroyed()) browser.close()
      resolve(loggedIn)
    }
    const pollTimer = setInterval(() => {
      void getBilibiliAuthStatus().then((loggedIn) => {
        if (loggedIn) finish(true)
      })
    }, 1000)
    const timeoutTimer = setTimeout(() => finish(false), LOGIN_TIMEOUT_MS)
    browser.on('closed', () => finish(false))
  })
}

function qualityName(format: BilibiliFormat | undefined, quality: number): string {
  return (
    format?.new_description?.trim() ||
    format?.display_desc?.trim() ||
    format?.newname?.trim() ||
    QUALITY_NAMES[quality] ||
    `清晰度 ${quality}`
  )
}

function pickVideoStreams(videos: BilibiliVideoStream[]): BilibiliVideoStream[] {
  const byQuality = new Map<number, BilibiliVideoStream[]>()
  for (const video of videos) {
    const url = video.baseUrl || video.base_url
    if (!url || !Number.isFinite(video.id)) continue
    const group = byQuality.get(video.id) ?? []
    group.push(video)
    byQuality.set(video.id, group)
  }

  const chosen: BilibiliVideoStream[] = []
  for (const group of byQuality.values()) {
    group.sort((left, right) => {
      const codec =
        (CODEC_PRIORITY[left.codecid] ?? 99) - (CODEC_PRIORITY[right.codecid] ?? 99)
      return codec !== 0 ? codec : right.bandwidth - left.bandwidth
    })
    chosen.push(group[0])
  }

  return chosen.sort(
    (left, right) =>
      right.height - left.height ||
      right.bandwidth - left.bandwidth ||
      right.id - left.id
  )
}

function pickAudioStream(audio: BilibiliAudioStream[]): BilibiliAudioStream | undefined {
  return [...audio]
    .filter((item) => item.baseUrl || item.base_url)
    .sort((left, right) => right.bandwidth - left.bandwidth)[0]
}

function buildResources(
  data: BilibiliPageData,
  pageUrl: string,
  loggedIn: boolean
): { resources: MediaResource[]; warnings: string[] } {
  const audio = pickAudioStream(data.audio)
  const videos = pickVideoStreams(data.video)
  const formats = new Map(data.formats.map((format) => [format.quality, format]))
  const titleBase = sanitizeFilename(
    `${data.title || 'Bilibili'}${data.pageCount > 1 ? `-P${data.page}-${data.partTitle || ''}` : ''}`
  ).slice(0, 78)

  const resources: MediaResource[] = videos.map((video) => {
    const url = (video.baseUrl || video.base_url) as string
    const format = formats.get(video.id)
    const quality = qualityName(format, video.id)
    const codec = CODEC_NAMES[video.codecid] || `Codec ${video.codecid}`
    const access =
      format?.need_vip && !loggedIn ? ' · 大会员' : format?.need_login && !loggedIn ? ' · 登录' : ''
    const filename = sanitizeFilename(
      `${titleBase}-${quality}-${codec}${access}`
    )

    return {
      id: `bili-${data.bvid || 'video'}-${data.cid || 0}-${video.id}-${video.codecid}`,
      url,
      kind: 'video',
      source: 'network',
      pageUrl,
      filename: `${filename}.mp4`,
      extension: 'mp4',
      mime: 'video/mp4',
      width: video.width,
      height: video.height,
      duration: data.duration,
      poster: data.poster,
      label: `${quality} · ${codec}`,
      discoveryLabel: 'Bilibili 专用解析 · 下载后自动合并音轨',
      isStream: false,
      audioUrl: audio ? audio.baseUrl || audio.base_url : undefined,
      audioMime: audio?.mimeType || audio?.mime_type || 'audio/mp4',
      qualityId: video.id,
      qualityLabel: quality,
      codec,
      mergeAudio: Boolean(audio),
      groupId: `${data.bvid || 'video'}-${data.cid || 0}`
    }
  })

  const warnings: string[] = []
  if (!loggedIn) {
    warnings.push('未登录 Bilibili：当前只显示游客可用清晰度，登录后可获取账号或大会员清晰度。')
  }
  if (videos.length > 0 && !audio) {
    warnings.push('没有发现独立音频流，该视频可能是无声视频。')
  } else if (videos.length > 0 && audio) {
    warnings.push('已匹配 Bilibili 音频流，下载完成后会自动合并为标准 MP4。')
  }
  const unavailable = data.formats.filter(
    (format) => !videos.some((video) => video.id === format.quality)
  )
  if (unavailable.length > 0) {
    warnings.push(
      `有 ${unavailable.length} 个更高清晰度未包含在当前账号的播放信息中，可能需要登录、大会员或原片本身不提供该清晰度。`
    )
  }
  return { resources, warnings }
}

export async function extractBilibiliPage(
  pageUrl: string,
  onProgress: (progress: ParseProgress) => void
): Promise<BilibiliExtractResult> {
  const browserSession = bilibiliSession()
  const loggedIn = await getBilibiliAuthStatus()
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
      webgl: false
    }
  })
  browser.webContents.setAudioMuted(true)
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  try {
    onProgress({
      stage: 'browser',
      message: loggedIn
        ? '正在使用 Bilibili 登录会话读取播放信息…'
        : '正在读取 Bilibili 播放信息（游客模式）…',
      percent: 62
    })
    await Promise.race([
      browser.loadURL(pageUrl).catch(() => undefined),
      delay(PAGE_TIMEOUT_MS)
    ])
    await delay(1600)

    const data = (await browser.webContents.executeJavaScript(
      String.raw`(async () => {
        const initial = window.__INITIAL_STATE__ || {};
        const page = initial.p || 1;
        const pages = initial.videoData?.pages || [];
        const current = pages.find((item) => item.page === page) || {};
        const bvid = initial.bvid || initial.videoData?.bvid || '';
        const cid = current.cid || initial.cid || 0;
        let api = null;
        let error = '';
        if (bvid && cid) {
          try {
            const response = await fetch(
              'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
              '&cid=' + encodeURIComponent(cid) +
              '&qn=127&fnval=4048&fnver=0&fourk=1&platform=pc&high_quality=1',
              { credentials: 'include' }
            );
            const text = await response.text();
            try { api = JSON.parse(text); }
            catch { error = 'HTTP ' + response.status; }
          } catch (fetchError) {
            error = String(fetchError);
          }
        }
        const pagePlay = window.__playinfo__;
        const chosen = api && api.code === 0 && api.data?.dash ? api : pagePlay;
        const source = chosen === api ? 'api' : chosen === pagePlay ? 'page' : 'none';
        const dash = chosen?.data?.dash;
        return {
          ok: Boolean(dash),
          source,
          error: error || (api && api.code !== 0 ? api.message || ('code ' + api.code) : ''),
          bvid,
          cid,
          page,
          pageCount: pages.length || 1,
          title: initial.videoData?.title || document.title.replace(/_哔哩哔哩_bilibili$/, ''),
          partTitle: current.part || '',
          poster: initial.videoData?.pic || '',
          duration: dash?.duration || initial.videoData?.duration || 0,
          video: (dash?.video || []).map((item) => ({
            id: item.id,
            codecid: item.codecid,
            width: item.width,
            height: item.height,
            bandwidth: item.bandwidth,
            baseUrl: item.baseUrl || item.base_url,
            backupUrl: item.backupUrl || item.backup_url
          })),
          audio: (dash?.audio || []).map((item) => ({
            id: item.id,
            bandwidth: item.bandwidth,
            mimeType: item.mimeType || item.mime_type,
            baseUrl: item.baseUrl || item.base_url
          })),
          formats: (chosen?.data?.support_formats || []).map((item) => ({
            quality: item.quality,
            newname: item.newname,
            new_description: item.new_description,
            display_desc: item.display_desc,
            need_login: item.need_login,
            need_vip: item.need_vip
          }))
        };
      })()`,
      true
    )) as BilibiliPageData

    if (!data.ok || data.video.length === 0) {
      throw new Error(
        data.error || '没有获取到 Bilibili 视频流，请登录后重试或确认视频可正常播放'
      )
    }

    onProgress({ stage: 'merge', message: '正在整理清晰度与音轨…', percent: 90 })
    const { resources, warnings } = buildResources(
      data,
      browser.webContents.getURL() || pageUrl,
      loggedIn
    )
    if (resources.length === 0) {
      throw new Error('Bilibili 返回的播放信息中没有可用视频流')
    }
    if (!loggedIn) {
      warnings.unshift('登录 Bilibili 后重新解析，可显示当前账号可用的更高清晰度。')
    }

    const pageTitle = data.title?.trim() || 'Bilibili 视频'
    return {
      finalUrl: browser.webContents.getURL() || pageUrl,
      title:
        data.pageCount > 1
          ? `${pageTitle} · P${data.page}${data.partTitle ? ` ${data.partTitle}` : ''}`
          : pageTitle,
      description: data.partTitle || undefined,
      favicon: 'https://www.bilibili.com/favicon.ico',
      resources,
      warnings
    }
  } finally {
    if (!browser.isDestroyed()) browser.destroy()
  }
}
