import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, protocol, session } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { getAigeiCookieHeader } from './aigei'
import { getBilibiliCookieHeader } from './bilibili'
import { getDouyinCookieHeader } from './douyin'
import { buildChildEnv } from './storage'
import { getWeiboCookieHeader } from './weibo'

export const THUMBNAIL_SCHEME = 'framekit-thumb'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

const FFMPEG_PATH = (() => {
  if (!ffmpegStatic) return null
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath && ffmpegStatic.includes('app.asar')) {
    return ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
  }
  return ffmpegStatic
})()

const MAX_WIDTH = 480
const TIMEOUT_MS = 12000
const MAX_CACHE_FILES = 200
const MAX_CONCURRENT = 2
const BROWSER_TIMEOUT_MS = 25000
const THUMB_PARTITION = 'framekit-thumb'
const TEMP_FILE_PATTERN = /\.tmp-\d+-\d+$/

let sharedThumbnailSession: Electron.Session | null = null

/**
 * 封面兜底浏览器复用同一个非持久会话。
 *
 * 之前按 URL 哈希创建 partition，每遇到一个新视频就多一个 session，
 * 长会话里这些 session 不会被回收。固定 partition 不写盘，也不会无限增长。
 */
function getThumbnailSession(): Electron.Session {
  if (sharedThumbnailSession) return sharedThumbnailSession
  const target = session.fromPartition(THUMB_PARTITION, { cache: false })
  target.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  )
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  sharedThumbnailSession = target
  return target
}

interface ThumbnailRequest {
  url: string
  referer?: string
  cookie?: string
}

function isBilibiliMediaUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return (
      hostname === 'bilibili.com' ||
      hostname.endsWith('.bilibili.com') ||
      hostname === 'bilivideo.com' ||
      hostname.endsWith('.bilivideo.com') ||
      hostname === 'bilivideo.cn' ||
      hostname.endsWith('.bilivideo.cn')
    )
  } catch {
    return false
  }
}

function isBilibiliPageUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')
  } catch {
    return false
  }
}

function isDouyinPageUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'douyin.com' || hostname.endsWith('.douyin.com')
  } catch {
    return false
  }
}

function isAigeiPageUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'aigei.com' || hostname.endsWith('.aigei.com')
  } catch {
    return false
  }
}

function isWeiboPageUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return (
      hostname === 'weibo.com' ||
      hostname.endsWith('.weibo.com') ||
      hostname === 'weibo.cn' ||
      hostname.endsWith('.weibo.cn')
    )
  } catch {
    return false
  }
}

function requestHeaders(request: ThumbnailRequest): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9'
  }
  if (isBilibiliMediaUrl(request.url) || isBilibiliPageUrl(request.referer ?? '')) {
    headers.referer = 'https://www.bilibili.com/'
    if (request.cookie) headers.cookie = request.cookie
  } else if (isDouyinPageUrl(request.referer ?? '')) {
    headers.referer = 'https://www.douyin.com/'
    if (request.cookie) headers.cookie = request.cookie
  } else if (isAigeiPageUrl(request.referer ?? '')) {
    headers.referer = request.referer || 'https://www.aigei.com/'
    if (request.cookie) headers.cookie = request.cookie
  } else if (isWeiboPageUrl(request.referer ?? '')) {
    // 微博 CDN 直链要带来源页与访客 Cookie，否则 403。
    headers.referer = request.referer || 'https://weibo.com/'
    if (request.cookie) headers.cookie = request.cookie
  } else if (request.referer) {
    headers.referer = request.referer
  }
  return headers
}

let thumbnailDirectory = ''

function cacheDirectory(): string {
  if (thumbnailDirectory) return thumbnailDirectory
  const directory = join(app.getPath('userData'), 'thumbnails')
  mkdirSync(directory, { recursive: true })
  thumbnailDirectory = directory
  return directory
}

function cacheKey(request: ThumbnailRequest): string {
  return createHash('sha1')
    .update(`${request.url}\n${request.referer ?? ''}`)
    .digest('hex')
    .slice(0, 20)
}

async function pruneCache(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory)
    const now = Date.now()
    const stats = await Promise.all(
      entries.map(async (name) => {
        const path = join(directory, name)
        const info = await stat(path).catch(() => undefined)
        return { path, name, mtime: info?.mtimeMs ?? 0 }
      })
    )
    const staleTempCutoff = now - 60 * 60 * 1000
    const tempFiles = stats.filter((entry) => TEMP_FILE_PATTERN.test(entry.name))
    for (const entry of tempFiles) {
      if (entry.mtime >= staleTempCutoff) continue
      await rm(entry.path, { force: true }).catch(() => undefined)
    }
    // 容量只按正式缓存文件计算；正在写入的临时文件既不能计数也不能被淘汰。
    const cached = stats.filter((entry) => !TEMP_FILE_PATTERN.test(entry.name))
    if (cached.length <= MAX_CACHE_FILES) return
    cached.sort((left, right) => left.mtime - right.mtime)
    for (const entry of cached.slice(0, cached.length - MAX_CACHE_FILES)) {
      await rm(entry.path, { force: true }).catch(() => undefined)
    }
  } catch {
    // Cache pruning is best-effort.
  }
}

let pruneRunning: Promise<void> | null = null
let pruneQueued = false
let lastPruneAt = 0

function schedulePrune(directory: string): void {
  const now = Date.now()
  if (now - lastPruneAt < 20_000) return
  if (pruneRunning) {
    pruneQueued = true
    return
  }
  lastPruneAt = now
  pruneRunning = pruneCache(directory)
    .catch(() => undefined)
    .finally(() => {
      pruneRunning = null
      if (pruneQueued) {
        pruneQueued = false
        schedulePrune(directory)
      }
    })
}

function runFfmpeg(args: string[]): Promise<void> {
  if (!FFMPEG_PATH) return Promise.reject(new Error('未找到内置 ffmpeg，无法生成封面'))
  return new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(FFMPEG_PATH, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: buildChildEnv()
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-3000)
    })
    const timer = setTimeout(() => {
      child.kill()
      rejectRun(new Error('生成封面超时'))
    }, TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveRun()
      else rejectRun(new Error(stderr.trim() || `ffmpeg 生成封面失败（退出码 ${code ?? 'unknown'}）`))
    })
  })
}

let running = 0
const waiters: Array<() => void> = []

async function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  running += 1
}

function releaseSlot(): void {
  running -= 1
  const next = waiters.shift()
  if (next) next()
}

const inFlightThumbnails = new Map<
  string,
  Promise<{ data: Buffer; mime: string } | null>
>()
let thumbnailTempCounter = 0

async function commitTempFile(tempPath: string, target: string): Promise<void> {
  try {
    await rename(tempPath, target)
  } catch {
    await rm(target, { force: true }).catch(() => undefined)
    await rename(tempPath, target).catch(() => undefined)
  }
}

export function generateThumbnail(
  request: ThumbnailRequest
): Promise<{ data: Buffer; mime: string } | null> {
  if (!FFMPEG_PATH) return Promise.resolve(null)
  if (!/^https?:\/\//i.test(request.url)) return Promise.resolve(null)

  const key = cacheKey(request)
  const pending = inFlightThumbnails.get(key)
  if (pending) return pending
  const task = generateThumbnailInner(request, key).finally(() => {
    inFlightThumbnails.delete(key)
  })
  inFlightThumbnails.set(key, task)
  return task
}

async function generateThumbnailInner(
  request: ThumbnailRequest,
  key: string
): Promise<{ data: Buffer; mime: string } | null> {
  const directory = cacheDirectory()
  const target = join(directory, `${key}.jpg`)
  if (existsSync(target)) {
    const cached = await readFile(target).catch(() => undefined)
    if (cached?.length) {
      const now = new Date()
      await utimes(target, now, now).catch(() => undefined)
      return { data: cached, mime: 'image/jpeg' }
    }
  }

  const headers = requestHeaders(request)
  const headerText = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-headers',
    `${headerText}\r\n`,
    '-i',
    request.url,
    '-frames:v',
    '1',
    '-vf',
    `scale=${MAX_WIDTH}:-2`,
    '-q:v',
    '4',
    '-f',
    'mjpeg',
    `${target}.tmp-${process.pid}-${thumbnailTempCounter++}`
  ]
  const tempTarget = args[args.length - 1]

  let data: Buffer | null = null
  try {
    await acquireSlot()
    try {
      await runFfmpeg(args)
      data = (await readFile(tempTarget).catch(() => undefined)) ?? null
    } catch {
      // ffmpeg 失败时回退到隐藏浏览器截图；两者共用同一个并发槽，
      // 避免大量无封面视频同时创建隐藏窗口把内存与 CPU 打满。
      try {
        const fallback = await captureViaBrowser(request)
        if (fallback?.length) {
          data = fallback
          await writeFile(tempTarget, fallback)
        }
      } catch {
        // 两条路径都失败时由下面的空值检查统一清理。
      }
    }
  } finally {
    releaseSlot()
  }

  if (!data?.length) {
    await rm(tempTarget, { force: true }).catch(() => undefined)
    return null
  }
  await commitTempFile(tempTarget, target)
  schedulePrune(directory)
  return { data, mime: 'image/jpeg' }
}

async function captureViaBrowser(request: ThumbnailRequest): Promise<Buffer | null> {
  const browserSession = getThumbnailSession()

  const browser = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 720,
    height: 405,
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

  try {
    await Promise.race([
      browser.loadURL(request.url).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, BROWSER_TIMEOUT_MS))
    ])
    await new Promise<void>((resolve) => setTimeout(resolve, 1800))

    const ready = await browser.webContents
      .executeJavaScript(
        `(() => {
          const video = document.querySelector('video');
          if (!video) return false;
          if (!video.videoWidth && Number.isFinite(video.duration)) {
            video.currentTime = Math.min(1, video.duration / 3);
          }
          return true;
        })()`,
        true
      )
      .catch(() => false)
    if (!ready) return null

    await new Promise<void>((resolve) => setTimeout(resolve, 1200))

    return await browser.webContents
      .capturePage()
      .then((nativeImage) => {
        if (nativeImage.isEmpty()) return null
        return nativeImage.toJPEG(80)
      })
      .catch(() => null)
  } finally {
    if (!browser.isDestroyed()) browser.destroy()
    await browserSession.clearCache().catch(() => undefined)
  }
}

export function registerThumbnailScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: THUMBNAIL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: true
      }
    }
  ])
}

export async function installThumbnailProtocol(): Promise<void> {
  protocol.handle(THUMBNAIL_SCHEME, async (request) => {
    let target: string | null = null
    let referer: string | null = null
    try {
      const parsed = new URL(request.url)
      target = parsed.searchParams.get('url')
      const rawReferer = parsed.searchParams.get('referer')
      if (rawReferer && /^https?:\/\//i.test(rawReferer)) referer = rawReferer
    } catch {
      return new Response('Invalid thumbnail url', { status: 400 })
    }
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('Invalid thumbnail url', { status: 400 })
    }

    const cookie = await resolveCookie(referer)
    const thumbnail = await generateThumbnail({
      url: target,
      referer: referer ?? undefined,
      cookie
    })
    if (!thumbnail) {
      return new Response('Thumbnail unavailable', { status: 404 })
    }

    return new Response(new Uint8Array(thumbnail.data), {
      status: 200,
      headers: {
        'content-type': thumbnail.mime,
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*'
      }
    })
  })
}

async function resolveCookie(referer: string | null): Promise<string | undefined> {
  if (!referer) return undefined
  try {
    if (isBilibiliPageUrl(referer)) {
      return (await getBilibiliCookieHeader()) || undefined
    }
    if (isDouyinPageUrl(referer)) {
      return (await getDouyinCookieHeader()) || undefined
    }
    if (isAigeiPageUrl(referer)) {
      return (await getAigeiCookieHeader()) || undefined
    }
    if (isWeiboPageUrl(referer)) {
      return (await getWeiboCookieHeader()) || undefined
    }
  } catch {
    return undefined
  }
  return undefined
}
