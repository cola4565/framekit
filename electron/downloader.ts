import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import type {
  DownloadProgress,
  DownloadRequest,
  DownloadStatus,
  ResourceKind,
  StartDownloadsResult
} from '../src/shared/types'
import { sanitizeFilename } from './extractor'

const CONCURRENCY = 3
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 FrameKit/0.1'
const FFMPEG_PATH = (() => {
  if (!ffmpegStatic) return null
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath && ffmpegStatic.includes('app.asar')) {
    return ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
  }
  return ffmpegStatic
})()

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg'
}

interface DownloadTask {
  request: DownloadRequest
  status: DownloadStatus
  received: number
  total?: number
  speed: number
  destination: string
  filename: string
  filePath?: string
  error?: string
  controller: AbortController
  startedAt?: number
  finishedAt?: number
  message?: string
  phase?: 'download' | 'merge'
  tempPaths: string[]
  removed?: boolean
}

type DownloadListener = (progress: DownloadProgress) => void

function decodeDispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined
  const encoded = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^["']|["']$/g, ''))
    } catch {
      return encoded
    }
  }
  const plain = header.match(/filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i)
  return plain?.[1] ?? plain?.[2]?.trim()
}

function ensureExtension(
  filename: string,
  mime: string | undefined,
  kind: ResourceKind
): string {
  const sanitized = sanitizeFilename(basename(filename))
  if (extname(sanitized)) return sanitized
  const extension =
    MIME_EXTENSION[mime ?? ''] ?? (kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'bin')
  return `${sanitized}.${extension}`
}

function availablePath(destination: string, filename: string, reserved: Set<string>): string {
  const extension = extname(filename)
  const stem = filename.slice(0, Math.max(0, filename.length - extension.length))
  let index = 0
  let candidate = join(destination, filename)

  while (existsSync(candidate) || reserved.has(candidate.toLowerCase())) {
    index += 1
    candidate = join(destination, `${stem} (${index})${extension}`)
  }
  reserved.add(candidate.toLowerCase())
  return candidate
}

function friendlyError(error: unknown): string {
  if (!(error instanceof Error)) return '下载失败'
  if (error.name === 'AbortError') return '已取消'
  const message = error.message
  if (/HTTP 403/.test(message)) return '服务器拒绝访问（HTTP 403），可能存在防盗链或需要登录'
  if (/HTTP 404/.test(message)) return '文件不存在（HTTP 404）'
  if (/HTTP 401/.test(message)) return '需要登录后才能下载（HTTP 401）'
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return '网络连接失败，请检查网络或稍后重试'
  }
  return message
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

function requestHeaders(
  target: string,
  pageUrl: string,
  extra?: Record<string, string>,
  cookie?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...extra
  }
  if (isBilibiliMediaUrl(target) || isBilibiliPageUrl(pageUrl)) {
    headers.referer = 'https://www.bilibili.com/'
    // Bilibili 的直链要求带 Range，否则统一返回 HTTP 567。
    headers.range = 'bytes=0-'
    if (cookie) headers.cookie = cookie
  } else if (pageUrl) {
    headers.referer = pageUrl
  }
  return headers
}

function runFfmpeg(args: string[], signal: AbortSignal): Promise<void> {
  if (!FFMPEG_PATH) return Promise.reject(new Error('未找到内置 ffmpeg，无法合并音视频'))

  return new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(FFMPEG_PATH, args, {
      windowsHide: true,
      signal,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-5000)
    })
    child.once('error', rejectRun)
    child.once('close', (code) => {
      if (code === 0) {
        resolveRun()
      } else {
        rejectRun(new Error(stderr.trim() || `ffmpeg 合并失败（退出码 ${code ?? 'unknown'}）`))
      }
    })
  })
}

export class DownloadManager {
  private tasks = new Map<string, DownloadTask>()
  private activeIds = new Set<string>()
  private running = new Map<string, Promise<void>>()
  private reservedPaths = new Set<string>()
  private listener: DownloadListener

  constructor(listener: DownloadListener) {
    this.listener = listener
  }

  private emit(task: DownloadTask): void {
    if (task.removed) return
    const progress: DownloadProgress = {
      id: task.request.id,
      url: task.request.url,
      filename: task.filename,
      kind: task.request.kind,
      status: task.status,
      received: task.received,
      total: task.total,
      speed: task.speed,
      error: task.error,
      filePath: task.filePath,
      destination: task.destination,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      message: task.message,
      phase: task.phase
    }
    this.listener(progress)
  }

  async enqueue(
    requests: DownloadRequest[],
    destination: string
  ): Promise<StartDownloadsResult> {
    const absoluteDestination = resolve(destination)
    await mkdir(absoluteDestination, { recursive: true })

    let queued = 0
    const seen = new Set<string>()
    for (const request of requests) {
      if (seen.has(request.id)) continue
      seen.add(request.id)
      let parsed: URL
      try {
        parsed = new URL(request.url)
      } catch {
        continue
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue

      const existing = this.tasks.get(request.id)
      if (existing && ['queued', 'downloading'].includes(existing.status)) continue

      const task: DownloadTask = {
        request,
        status: 'queued',
        received: 0,
        speed: 0,
        destination: absoluteDestination,
        filename: ensureExtension(request.filename, undefined, request.kind),
        controller: new AbortController(),
        tempPaths: []
      }
      this.tasks.set(request.id, task)
      queued += 1
      this.emit(task)
    }

    this.pump()
    return { queued, destination: absoluteDestination }
  }

  cancel(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status === 'queued') {
      task.status = 'canceled'
      task.error = '已取消'
      task.finishedAt = Date.now()
      this.emit(task)
      return
    }
    if (task.status === 'downloading') {
      task.controller.abort()
    }
  }

  filePathOf(id: string): string | undefined {
    return this.tasks.get(id)?.filePath
  }

  async remove(id: string): Promise<{ removed: boolean; deletedFile: boolean }> {
    const task = this.tasks.get(id)
    if (!task) return { removed: false, deletedFile: false }

    const wasActive = task.status === 'downloading'
    task.removed = true
    if (wasActive) task.controller.abort()
    this.tasks.delete(id)
    this.activeIds.delete(id)

    const running = this.running.get(id)
    if (running) {
      await Promise.race([running.catch(() => undefined), new Promise((r) => setTimeout(r, 10000))])
    }

    const targets = new Set<string>()
    if (task.filePath) targets.add(task.filePath)
    for (const tempPath of task.tempPaths) targets.add(tempPath)
    if (task.filePath) {
      targets.add(`${task.filePath}.part`)
      targets.add(`${task.filePath}.video.part`)
      targets.add(`${task.filePath}.audio.part`)
    }

    let deletedFile = false
    for (const target of targets) {
      const existed = existsSync(target)
      await unlink(target).catch(() => undefined)
      if (existed) deletedFile = true
    }
    if (task.filePath) this.reservedPaths.delete(task.filePath.toLowerCase())
    return { removed: true, deletedFile }
  }

  private pump(): void {
    if (this.activeIds.size >= CONCURRENCY) return

    for (const task of this.tasks.values()) {
      if (this.activeIds.size >= CONCURRENCY) break
      if (task.status !== 'queued' || this.activeIds.has(task.request.id)) continue
      this.activeIds.add(task.request.id)
      const running = this.run(task).finally(() => {
        this.activeIds.delete(task.request.id)
        this.running.delete(task.request.id)
        this.pump()
      })
      this.running.set(task.request.id, running)
    }
  }

  private async run(task: DownloadTask): Promise<void> {
    task.status = 'downloading'
    task.startedAt = Date.now()
    this.emit(task)

    if (task.request.audioUrl) {
      await this.runMerged(task)
      return
    }

    let partPath: string | undefined
    let fileStream: ReturnType<typeof createWriteStream> | undefined
    try {
      const response = await fetch(task.request.url, {
        headers: requestHeaders(
          task.request.url,
          task.request.pageUrl,
          undefined,
          task.request.cookie
        ),
        redirect: 'follow',
        signal: task.controller.signal
      })

      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }

      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      const dispositionName = decodeDispositionFilename(response.headers.get('content-disposition'))
      task.filename = ensureExtension(
        dispositionName || task.request.filename,
        mime,
        task.request.kind
      )
      task.filePath = availablePath(task.destination, task.filename, this.reservedPaths)
      task.filename = basename(task.filePath)
      const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
      task.total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
      partPath = `${task.filePath}.part`
      task.tempPaths.push(partPath)
      this.emit(task)

      const stream = createWriteStream(partPath, { flags: 'w' })
      fileStream = stream
      const reader = response.body?.getReader()
      if (!reader) throw new Error('服务器没有返回文件内容')

      let lastEmit = Date.now()
      let lastSampleAt = Date.now()
      let lastSampleBytes = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue

        const buffer = Buffer.from(value)
        if (!stream.write(buffer)) {
          await new Promise<void>((resolveDrain, rejectDrain) => {
            const onDrain = (): void => {
              stream.off('error', onError)
              resolveDrain()
            }
            const onError = (error: Error): void => {
              stream.off('drain', onDrain)
              rejectDrain(error)
            }
            stream.once('drain', onDrain)
            stream.once('error', onError)
          })
        }
        task.received += buffer.byteLength

        const now = Date.now()
        if (now - lastEmit >= 120) {
          const seconds = Math.max(0.001, (now - lastSampleAt) / 1000)
          task.speed = (task.received - lastSampleBytes) / seconds
          lastSampleAt = now
          lastSampleBytes = task.received
          lastEmit = now
          this.emit(task)
        }
      }

      await new Promise<void>((resolveEnd, rejectEnd) => {
        fileStream?.once('error', rejectEnd)
        fileStream?.end(resolveEnd)
      })
      fileStream = undefined

      await rename(partPath, task.filePath)
      partPath = undefined
      if (task.removed) {
        await unlink(task.filePath).catch(() => undefined)
        return
      }
      task.status = 'done'
      task.speed = 0
      task.finishedAt = Date.now()
      if (task.total && task.received > task.total) task.total = task.received
      this.emit(task)
    } catch (error) {
      fileStream?.destroy()
      if (partPath) {
        await unlink(partPath).catch(() => undefined)
      }
      task.status = task.controller.signal.aborted ? 'canceled' : 'error'
      task.speed = 0
      task.error = friendlyError(error)
      task.finishedAt = Date.now()
      this.emit(task)
    } finally {
      if (task.filePath) this.reservedPaths.delete(task.filePath.toLowerCase())
    }
  }

  private async downloadPart(
    url: string,
    partPath: string,
    task: DownloadTask,
    primary: boolean
  ): Promise<void> {
    const response = await fetch(url, {
      headers: requestHeaders(url, task.request.pageUrl, undefined, task.request.cookie),
      redirect: 'follow',
      signal: task.controller.signal
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`HTTP ${response.status}`)
    }

    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(contentLength) && contentLength > 0) {
      task.total = primary ? contentLength : (task.total ?? 0) + contentLength
    } else if (primary) {
      task.total = undefined
    }
    task.message = primary ? '正在下载视频流…' : '正在下载音频流…'
    task.phase = 'download'
    this.emit(task)

    const stream = createWriteStream(partPath, { flags: 'w' })
    const reader = response.body?.getReader()
    if (!reader) throw new Error('服务器没有返回文件内容')

    let lastEmit = Date.now()
    let lastSampleAt = Date.now()
    let lastSampleBytes = task.received
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const buffer = Buffer.from(value)
        if (!stream.write(buffer)) {
          await new Promise<void>((resolveDrain, rejectDrain) => {
            const onDrain = (): void => {
              stream.off('error', onError)
              resolveDrain()
            }
            const onError = (error: Error): void => {
              stream.off('drain', onDrain)
              rejectDrain(error)
            }
            stream.once('drain', onDrain)
            stream.once('error', onError)
          })
        }
        task.received += buffer.byteLength

        const now = Date.now()
        if (now - lastEmit >= 120) {
          const seconds = Math.max(0.001, (now - lastSampleAt) / 1000)
          task.speed = (task.received - lastSampleBytes) / seconds
          lastSampleAt = now
          lastSampleBytes = task.received
          lastEmit = now
          this.emit(task)
        }
      }
      await new Promise<void>((resolveEnd, rejectEnd) => {
        stream.once('error', rejectEnd)
        stream.end(resolveEnd)
      })
    } catch (error) {
      stream.destroy()
      throw error
    }
  }

  private async runMerged(task: DownloadTask): Promise<void> {
    const finalPath = availablePath(
      task.destination,
      ensureExtension(task.request.filename, 'video/mp4', 'video'),
      this.reservedPaths
    )
    task.filePath = finalPath
    task.filename = basename(finalPath)
    const videoPart = `${finalPath}.video.part`
    const audioPart = `${finalPath}.audio.part`
    const mergedPath = `${finalPath}.merge-${process.pid}.mp4`
    task.tempPaths.push(videoPart, audioPart, mergedPath)

    try {
      if (!FFMPEG_PATH) throw new Error('未找到内置 ffmpeg，无法合并音视频')
      task.phase = 'download'
      task.message = '正在下载视频流…'
      this.emit(task)
      await this.downloadPart(task.request.url, videoPart, task, true)

      task.message = '正在下载音频流…'
      this.emit(task)
      await this.downloadPart(task.request.audioUrl as string, audioPart, task, false)

      task.phase = 'merge'
      task.message = '正在合并音视频…'
      task.speed = 0
      this.emit(task)
      await runFfmpeg(
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          videoPart,
          '-i',
          audioPart,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          mergedPath
        ],
        task.controller.signal
      )

      const merged = await stat(mergedPath)
      await unlink(videoPart).catch(() => undefined)
      await unlink(audioPart).catch(() => undefined)
      await rename(mergedPath, finalPath)
      if (task.removed) {
        await unlink(finalPath).catch(() => undefined)
        return
      }
      task.received = merged.size
      task.total = merged.size
      task.status = 'done'
      task.speed = 0
      task.finishedAt = Date.now()
      task.message = '音视频已合并'
      this.emit(task)
    } catch (error) {
      await unlink(videoPart).catch(() => undefined)
      await unlink(audioPart).catch(() => undefined)
      await unlink(mergedPath).catch(() => undefined)
      task.status = task.controller.signal.aborted ? 'canceled' : 'error'
      task.speed = 0
      task.message = undefined
      task.error = friendlyError(error)
      task.finishedAt = Date.now()
      this.emit(task)
    } finally {
      this.reservedPaths.delete(finalPath.toLowerCase())
    }
  }
}
