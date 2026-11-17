import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app } from 'electron'
import ffmpegPath from 'ffmpeg-static'
import { extractBilibiliPage } from '../electron/bilibili'
import { DownloadManager } from '../electron/downloader'
import type { DownloadProgress } from '../src/shared/types'

const url =
  process.env.BILIBILI_TEST_URL ||
  'https://www.bilibili.com/video/BV1tyCABwEmR/?p=6'
const destination = resolve('.tmp', 'bilibili-merge-smoke')
const keepFile = process.env.KEEP_MEDIA === '1'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

app.on('window-all-closed', () => undefined)

app.whenReady().then(async () => {
  try {
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })

    const parsed = await extractBilibiliPage(url, (progress) => {
      console.log('PARSE', progress.message)
    })
    const resource = [...parsed.resources]
      .filter((item) => item.audioUrl)
      .sort((left, right) => (left.height ?? 0) - (right.height ?? 0))[0]
    if (!resource?.audioUrl) throw new Error('没有找到带独立音轨的清晰度')
    console.log(`DOWNLOAD ${resource.label} ${resource.filename}`)

    const state: { latest: DownloadProgress | null } = { latest: null }
    let lastLog = 0
    const manager = new DownloadManager((progress) => {
      state.latest = progress
      const now = Date.now()
      if (now - lastLog > 3000 || progress.status !== 'downloading') {
        lastLog = now
        console.log('STATUS', progress.status, progress.phase || '', progress.message || '')
      }
    })

    await manager.enqueue(
      [
        {
          id: 'bilibili-merge-smoke',
          url: resource.url,
          filename: resource.filename,
          kind: 'video',
          pageUrl: parsed.finalUrl,
          audioUrl: resource.audioUrl,
          audioMime: resource.audioMime
        }
      ],
      destination
    )

    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      if (state.latest && ['done', 'error', 'canceled'].includes(state.latest.status)) break
      await delay(300)
    }
    const finished = state.latest
    if (!finished || finished.status !== 'done' || !finished.filePath) {
      throw new Error(finished?.error || '下载合并未完成')
    }
    if (!existsSync(finished.filePath)) throw new Error('合并后的文件不存在')
    if (!ffmpegPath) throw new Error('未找到 ffmpeg-static')

    const size = (await stat(finished.filePath)).size
    for (const [label, args] of [
      ['video', ['-map', '0:v:0']],
      ['audio', ['-map', '0:a:0']]
    ] as const) {
      const check = spawnSync(
        ffmpegPath,
        ['-v', 'error', '-i', finished.filePath, ...args, '-t', '1', '-f', 'null', '-'],
        { encoding: 'utf8' }
      )
      if (check.status !== 0) throw new Error(`${label} 轨道无效: ${check.stderr}`)
    }

    console.log(
      JSON.stringify(
        {
          status: finished.status,
          filePath: finished.filePath,
          size,
          videoTrackOk: true,
          audioTrackOk: true,
          files: await readdir(destination)
        },
        null,
        2
      )
    )
    if (!keepFile) await rm(destination, { recursive: true, force: true })
  } catch (error) {
    console.error('FAIL', error)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
