/**
 * 央视网真实下载验证。
 *
 * 下载「流畅」到「超清」各取前几个分片，用 ffmpeg 验证：
 * - 产出的 MP4 分辨率与所选档位一致（不会串档）；
 * - 产物带音轨（不会是无声视频）。
 *
 * 用法：
 *   npm run test:cctv:download
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { extractCctvPage } from '../electron/cctv'

const PAGE_URL = 'https://tv.cctv.com/2025/10/07/VIDErVuzkncfsaZS94lRzz4z251007.shtml'
const PROBE_SEGMENTS = 3
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

function runFfmpeg(args: string[], allowProbeExit = false): Promise<string> {
  if (!FFMPEG_PATH) return Promise.reject(new Error('未找到 ffmpeg'))
  return new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(FFMPEG_PATH, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', rejectRun)
    child.once('close', (code) =>
      code === 0 || allowProbeExit
        ? resolveRun(stderr)
        : rejectRun(new Error(`ffmpeg 退出码 ${code ?? 'unknown'}：${stderr.slice(-800)}`))
    )
  })
}

async function main(): Promise<void> {
  if (!FFMPEG_PATH) throw new Error('未找到 ffmpeg，无法验证下载结果')
  const workspace = await mkdtemp(join(resolve('.tmp'), 'cctv-download-'))
  await mkdir(workspace, { recursive: true })

  try {
    const result = await extractCctvPage(PAGE_URL, () => undefined)
    if (result.resources.length !== 4) {
      throw new Error(`期望 4 档清晰度，实际 ${result.resources.length}`)
    }

    for (const resource of result.resources) {
      const label = resource.qualityLabel ?? '未知档位'
      const mediaResponse = await fetch(resource.url, {
        headers: { 'user-agent': USER_AGENT, referer: 'https://tv.cctv.com/' }
      })
      if (!mediaResponse.ok) throw new Error(`媒体清单返回 HTTP ${mediaResponse.status}`)
      const mediaText = await mediaResponse.text()
      const segmentUrls = mediaText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .slice(0, PROBE_SEGMENTS)
        .map((line) => new URL(line, resource.url).toString())

      if (segmentUrls.length === 0) throw new Error(`${label} 没有可下载的分片`)

      const segmentPaths: string[] = []
      for (let index = 0; index < segmentUrls.length; index += 1) {
        const segmentResponse = await fetch(segmentUrls[index], {
          headers: { 'user-agent': USER_AGENT, referer: 'https://tv.cctv.com/' }
        })
        if (!segmentResponse.ok) {
          throw new Error(`分片 ${segmentUrls[index]} 返回 HTTP ${segmentResponse.status}`)
        }
        const segmentPath = join(workspace, `seg-${index}.ts`)
        await writeFile(segmentPath, Buffer.from(await segmentResponse.arrayBuffer()))
        segmentPaths.push(segmentPath)
      }

      const merged = join(workspace, `${label}.mp4`)
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        `concat:${segmentPaths.join('|')}`,
        '-c',
        'copy',
        merged
      ])

      // `ffmpeg -i` 没有输出文件时退出码是 1，属于正常探测行为。
      const probe = await runFfmpeg(['-hide_banner', '-i', merged], true)
      const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(probe)
      const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(probe)
      const width = size ? Number.parseInt(size[1], 10) : 0
      const height = size ? Number.parseInt(size[2], 10) : 0
      const bytes = (await stat(merged)).size

      console.log(`${label}: ${width}×${height} 音轨=${hasAudio ? '有' : '无'} 大小=${bytes} 字节`)

      if (width !== resource.width || height !== resource.height) {
        throw new Error(
          `${label} 串档了：期望 ${resource.width}×${resource.height}，实际 ${width}×${height}`
        )
      }
      if (!hasAudio) throw new Error(`${label} 的视频没有音轨`)
    }

    console.log('PASS cctv download smoke: 四档清晰度下载后分辨率正确且都有音轨')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

app.on('window-all-closed', () => undefined)

app.whenReady().then(async () => {
  try {
    await main()
  } catch (error) {
    console.error('FAIL cctv download smoke')
    console.error(error)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
