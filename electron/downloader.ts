import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
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

export class DownloadManager {
  private tasks = new Map<string, DownloadTask>()
  private activeIds = new Set<string>()
  private reservedPaths = new Set<string>()
  private listener: DownloadListener

  constructor(listener: DownloadListener) {
    this.listener = listener
  }

  private emit(task: DownloadTask): void {
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
      finishedAt: task.finishedAt
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
        controller: new AbortController()
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

  private pump(): void {
    if (this.activeIds.size >= CONCURRENCY) return

    for (const task of this.tasks.values()) {
      if (this.activeIds.size >= CONCURRENCY) break
      if (task.status !== 'queued' || this.activeIds.has(task.request.id)) continue
      this.activeIds.add(task.request.id)
      void this.run(task).finally(() => {
        this.activeIds.delete(task.request.id)
        this.pump()
      })
    }
  }

  private async run(task: DownloadTask): Promise<void> {
    task.status = 'downloading'
    task.startedAt = Date.now()
    this.emit(task)

    let partPath: string | undefined
    let fileStream: ReturnType<typeof createWriteStream> | undefined
    try {
      const response = await fetch(task.request.url, {
        headers: {
          'user-agent': USER_AGENT,
          accept: '*/*',
          referer: task.request.pageUrl
        },
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
            stream.once('drain', resolveDrain)
            stream.once('error', rejectDrain)
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
}
