import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { DownloadManager } from '../electron/downloader'
import type { DownloadProgress } from '../src/shared/types'

const payloadA = Buffer.alloc(96 * 1024, 7)
const payloadB = Buffer.from('FrameKit download fixture')
let cancelTimer: NodeJS.Timeout | undefined
const hlsRequests: string[] = []

const FFMPEG_PATH = (() => {
  if (!ffmpegStatic) return null
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath && ffmpegStatic.includes('app.asar')) {
    return ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
  }
  return ffmpegStatic
})()

function runFfmpeg(args: string[]): Promise<void> {
  if (!FFMPEG_PATH) return Promise.reject(new Error('未找到 ffmpeg'))
  return new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true, stdio: 'ignore' })
    child.once('error', rejectRun)
    child.once('close', (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`ffmpeg 退出码 ${code ?? 'unknown'}`))
    )
  })
}

interface VideoProbe {
  width: number
  height: number
  hasAudio: boolean
}

/**
 * 用 ffmpeg 探测产物的分辨率与音轨。
 *
 * 央视这类 HLS 的关键回归点是“下载的档位对不对”和“有没有音轨”，
 * 直接读封装结果比读日志更可靠。
 */
function probeVideo(filePath: string): Promise<VideoProbe> {
  if (!FFMPEG_PATH) return Promise.reject(new Error('未找到 ffmpeg'))
  return new Promise<VideoProbe>((resolveProbe, rejectProbe) => {
    const child = spawn(
      FFMPEG_PATH,
      ['-hide_banner', '-i', filePath],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', rejectProbe)
    child.once('close', () => {
      const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr)
      const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(stderr)
      if (!size) {
        rejectProbe(new Error(`无法从 ffmpeg 输出解析视频分辨率：${stderr.slice(-600)}`))
        return
      }
      resolveProbe({
        width: Number.parseInt(size[1], 10),
        height: Number.parseInt(size[2], 10),
        hasAudio
      })
    })
  })
}

/**
 * 生成真实的 MPEG-TS 分片。
 *
 * HLS 下载的最后一步会用 ffmpeg 把 TS 重新封装成 MP4，
 * 所以测试必须用真实可解码的 TS，否则封装阶段一定失败。
 */
async function makeTsSegment(
  target: string,
  width: number,
  height: number,
  frequency: number
): Promise<void> {
  await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${width}x${height}:rate=15:duration=1`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=1`,
    '-c:v',
    'mpeg2video',
    '-c:a',
    'aac',
    '-f',
    'mpegts',
    target
  ])
}

/**
 * 构造一个最小的 HLS 假流：
 * - `/hls/master.m3u8` 是多码率清单（两档）；
 * - `/hls/450.m3u8` / `/hls/1200.m3u8` 是各自的媒体清单；
 * - 分片内容用可辨识的字节，便于验证“下载的是所选档位而不是最高档”。
 */
function hlsFixture(): { master: string; media450: string; media1200: string } {
  const master = [
    '#EXTM3U',
    // 故意把高清单放在前面：这样“最后一档”和“最佳档”不是同一个，
    // 测试才能真正区分“按清单顺序取” 和 “按带宽/分辨率取最佳”。
    '#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=1228800, RESOLUTION=1280x720',
    '1200.m3u8',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=460800, RESOLUTION=480x270',
    '450.m3u8',
    ''
  ].join('\n')
  const media450 = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXTINF:4.0,',
    'seg-450-0.ts',
    '#EXTINF:4.0,',
    'seg-450-1.ts',
    '#EXT-X-ENDLIST',
    ''
  ].join('\n')
  const media1200 = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXTINF:4.0,',
    'seg-1200-0.ts',
    '#EXTINF:4.0,',
    'seg-1200-1.ts',
    '#EXT-X-ENDLIST',
    ''
  ].join('\n')
  return { master, media450, media1200 }
}

async function main(): Promise<void> {
  const hls = hlsFixture()
  const hlsWorkspace = await mkdtemp(join(resolve('.tmp'), 'hls-smoke-'))
  const segmentPaths = new Map<string, string>()
  for (const [name, width, height, frequency] of [
    ['seg-450-0.ts', 480, 270, 440],
    ['seg-450-1.ts', 480, 270, 440],
    ['seg-1200-0.ts', 1280, 720, 880],
    ['seg-1200-1.ts', 1280, 720, 880]
  ] as const) {
    const path = join(hlsWorkspace, name)
    await makeTsSegment(path, width, height, frequency)
    segmentPaths.set(name, path)
  }

  const server = createServer((request, response) => {
    if (request.url?.startsWith('/hls/')) {
      hlsRequests.push(request.url)
      if (request.url === '/hls/master.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
        response.end(hls.master)
        return
      }
      if (request.url === '/hls/450.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
        response.end(hls.media450)
        return
      }
      if (request.url === '/hls/1200.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
        response.end(hls.media1200)
        return
      }
      const segmentPath = segmentPaths.get(request.url.slice('/hls/'.length))
      if (!segmentPath) {
        response.writeHead(404)
        response.end('no segment')
        return
      }
      response.writeHead(200, { 'content-type': 'video/mp2t' })
      response.end(readFileSync(segmentPath))
      return
    }
    if (request.url === '/file-a.mp4') {
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(payloadA.byteLength)
      })
      response.end(payloadA)
      return
    }
    if (request.url === '/file-b') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(payloadB.byteLength),
        'content-disposition': "attachment; filename*=UTF-8''frame%20b.bin"
      })
      response.end(payloadB)
      return
    }
    if (request.url === '/slow-cancel.mp4') {
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(payloadA.byteLength * 100)
      })
      cancelTimer = setInterval(() => response.write(payloadA), 20)
      request.on('close', () => {
        if (cancelTimer) clearInterval(cancelTimer)
      })
      return
    }
    response.writeHead(404)
    response.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`
  const workspaceTemp = resolve('.tmp')
  await mkdir(workspaceTemp, { recursive: true })
  const destination = await mkdtemp(join(workspaceTemp, 'download-smoke-'))
  const updates: DownloadProgress[] = []

  try {
    const manager = new DownloadManager((progress) => {
      updates.push(progress)
    })

    const result = await manager.enqueue(
      [
        {
          id: 'a',
          url: `${origin}/file-a.mp4`,
          filename: 'clip.mp4',
          kind: 'video',
          pageUrl: origin
        },
        {
          id: 'b',
          url: `${origin}/file-b`,
          filename: 'file-b.bin',
          kind: 'other',
          pageUrl: origin
        }
      ],
      destination
    )
    assert.equal(result.queued, 2)

    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const done = new Set(
        updates.filter((update) => update.status === 'done').map((update) => update.id)
      )
      if (done.has('a') && done.has('b')) break
      const failed = updates.find(
        (update) => update.status === 'error' || update.status === 'canceled'
      )
      if (failed) throw new Error(failed.error || `download ${failed.id} failed`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80))
    }

    const done = updates.filter((update) => update.status === 'done')
    assert.equal(done.length, 2, 'expected both tasks to finish')
    const fileA = done.find((update) => update.id === 'a')
    const fileB = done.find((update) => update.id === 'b')
    assert.ok(fileA?.filePath)
    assert.ok(fileB?.filePath)
    assert.equal(fileB?.filename, 'frame b.bin')

    const downloadedA = await readFile(fileA.filePath)
    const downloadedB = await readFile(fileB.filePath)
    assert.equal(downloadedA.byteLength, payloadA.byteLength)
    assert.equal(downloadedB.toString(), payloadB.toString())

    await manager.enqueue(
      [{
        id: 'cancel-remove',
        url: `${origin}/slow-cancel.mp4`,
        filename: 'cancel-remove.mp4',
        kind: 'video',
        pageUrl: origin
      }],
      destination
    )
    while (!updates.some((update) => update.id === 'cancel-remove' && update.received > 0)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    const removal = await manager.remove('cancel-remove')
    assert.equal(removal.removed, true)
    assert.equal(updates.some((update) => update.id === 'cancel-remove' && update.status === 'done'), false)

    /**
     * HLS 选档回归：
     * 1. 下载低档（450）时不能偷偷升到高档（1200）；
     * 2. 下载高档时必须拿到 1200 的媒体清单；
     * 3. 两者都要产出带音轨的 MP4；
     * 4. 请求 master 清单（通用 .m3u8 资源）时应自动挑最高档。
     */
    for (const [taskId, url, expectedWidth, expectedHeight] of [
      ['hls-low', '/hls/450.m3u8', 480, 270],
      ['hls-high', '/hls/1200.m3u8', 1280, 720],
      ['hls-master', '/hls/master.m3u8', 1280, 720]
    ] as const) {
      hlsRequests.length = 0
      const enqueued = await manager.enqueue(
        [{
          id: taskId,
          url: `${origin}${url}`,
          filename: `${taskId}.mp4`,
          kind: 'video',
          pageUrl: origin,
          isStream: true
        }],
        destination
      )
      assert.equal(enqueued.queued, 1, `${taskId} should be queued`)

      const hlsDeadline = Date.now() + 60000
      let hlsDone: DownloadProgress | undefined
      while (Date.now() < hlsDeadline) {
        const failed = updates.find(
          (update) =>
            update.id === taskId && (update.status === 'error' || update.status === 'canceled')
        )
        if (failed) throw new Error(failed.error || `${taskId} failed`)
        hlsDone = updates.find((update) => update.id === taskId && update.status === 'done')
        if (hlsDone) break
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120))
      }
      assert.ok(hlsDone?.filePath, `${taskId} should produce a file`)

      const probe = await probeVideo(hlsDone.filePath)
      assert.equal(probe.width, expectedWidth, `${taskId} width`)
      assert.equal(probe.height, expectedHeight, `${taskId} height`)
      assert.ok(probe.hasAudio, `${taskId} should keep the audio track`)

      const expectedVariant = expectedHeight >= 720 ? '1200' : '450'
      const otherVariant = expectedVariant === '450' ? '1200' : '450'
      assert.ok(
        hlsRequests.includes(`/hls/${expectedVariant}.m3u8`),
        `${taskId} should fetch the ${expectedVariant} media playlist`
      )
      assert.equal(
        hlsRequests.some((url) => url.includes(`seg-${otherVariant}-`)),
        false,
        `${taskId} must not download segments from the other quality`
      )
    }

    // 清理阶段也要删掉已经落盘的文件。
    const hlsDoneTask = updates.find(
      (update) => update.id === 'hls-low' && update.status === 'done'
    )
    if (hlsDoneTask?.filePath) {
      const removal = await manager.remove('hls-low')
      assert.equal(removal.removed, true)
      assert.equal(existsSync(hlsDoneTask.filePath), false, 'removing should delete the file')
    }

    console.log('PASS download smoke')
    console.log(JSON.stringify({ destination, files: [fileA.filename, fileB.filename] }, null, 2))
  } finally {
    if (cancelTimer) clearInterval(cancelTimer)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(destination, { recursive: true, force: true })
    await rm(hlsWorkspace, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error('FAIL download smoke')
  console.error(error)
  process.exitCode = 1
})
