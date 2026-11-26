import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from 'electron'
import { parsePage } from '../electron/parser'

const page = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Generic Extractor Fixture</title>
    <meta property="og:description" content="Generic extraction fixture" />
  </head>
  <body>
    <h1>Generic extractor fixture</h1>
    <script>
      window.__INITIAL_STATE__ = {
        image: {
          url: '/media/still?id=7',
          width: 1280,
          height: 720
        }
      };
      window.playerVars = {
        audioUrl: '/media/static-audio?id=12'
      };
      setTimeout(() => {
        fetch('/api/play?vid=abc123').then((response) => response.text());
        window.__PLAYER__ = {
          video: {
            url: '/media/runtime?id=11',
            mimeType: 'video/mp4'
          }
        };
      }, 250);
    </script>
  </body>
</html>`

const playPayload = {
  code: 0,
  data: {
    vid: 'abc123',
    title: 'Generic Fixture',
    duration: 12,
    poster: '/media/cover?id=9',
    avatar: {
      url: '/media/avatar?id=3'
    },
    videoUrl: '/media/stream?id=9',
    playUrl: '/api/playurl?vid=abc123',
    audioUrl: '/media/audio?id=9',
    qualities: [
      {
        qualityLabel: '1080P',
        height: 1080,
        hlsUrl: '/hls/master.m3u8'
      }
    ],
    related: [
      {
        vid: 'other1',
        video: {
          url: '/media/other?id=21'
        }
      }
    ]
  }
}

const hlsMaster = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="main",DEFAULT=YES,URI="/hls/audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080
/hls/1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1920x1080
/hls/1080-low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720
/hls/720/index.m3u8
`

const hlsMedia = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
/hls/segment.ts
#EXT-X-ENDLIST
`

async function main(): Promise<void> {
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page)
      return
    }
    if (url.startsWith('/api/play')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(playPayload))
      return
    }
    if (url === '/hls/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end(hlsMaster)
      return
    }
    if (url.startsWith('/hls/') && url.endsWith('.m3u8')) {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end(hlsMedia)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const result = await parsePage(`${origin}/`, { deep: true }, (progress) => {
      console.log(`[${progress.percent}%] ${progress.message}`)
    })
    const urls = result.resources.map((resource) => resource.url)
    const video = result.resources.find((resource) => resource.url.includes('/media/stream?id=9'))
    const audio = result.resources.find((resource) => resource.url.includes('/media/audio?id=9'))
    const embeddedImage = result.resources.find((resource) =>
      resource.url.includes('/media/still?id=7')
    )
    const runtimeVideo = result.resources.find((resource) =>
      resource.url.includes('/media/runtime?id=11')
    )
    const staticAudio = result.resources.find((resource) =>
      resource.url.includes('/media/static-audio?id=12')
    )
    const relatedVideo = result.resources.find((resource) =>
      resource.url.includes('/media/other?id=21')
    )
    const hlsVariants = result.resources.filter((resource) =>
      resource.url.includes('/hls/')
    )

    assert.ok(video, 'expected the JSON video URL to be extracted')
    assert.ok(video.audioUrl?.includes('/media/audio?id=9'), 'expected the video to carry its audio track')
    assert.ok(audio, 'expected the standalone audio resource')
    assert.ok(embeddedImage, 'expected the embedded state image')
    assert.ok(runtimeVideo, 'expected the runtime global video')
    assert.ok(
      staticAudio,
      'expected every known state in the same script to be scanned'
    )
    assert.ok(relatedVideo, 'expected the related video from a nested object')
    assert.notEqual(
      relatedVideo.groupId,
      video.groupId,
      'videos with their own ids must not share a preview group'
    )
    assert.equal(hlsVariants.length, 3, 'expected all HLS variants')
    assert.deepEqual(
      hlsVariants.map((resource) => resource.qualityLabel).sort(),
      ['1080P · 1200 kbps', '1080P · 2000 kbps', '720P']
    )
    assert.equal(new Set(hlsVariants.map((resource) => resource.groupId)).size, 1)
    assert.ok(
      !urls.some((url) => url.includes('/api/play')),
      'the API endpoint itself must not be listed as a media resource'
    )
    assert.ok(
      !urls.some((url) => url.includes('/api/playurl')),
      'a playUrl field pointing at an API endpoint must not be listed as a media file'
    )
    assert.ok(
      !urls.some((url) => url.includes('/media/avatar')),
      'avatar images must not be listed as media resources'
    )
    assert.ok(
      result.warnings.some((warning) => warning.includes('通用提取')),
      'expected a heuristic-result warning'
    )
    assert.ok(
      result.warnings.some((warning) => warning.includes('独立音轨')),
      'expected a warning for separate HLS audio renditions'
    )

    console.log(`PASS generic extractor: ${result.resources.length} resources`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

app.disableHardwareAcceleration()
app.on('window-all-closed', () => undefined)

app.whenReady().then(async () => {
  try {
    await main()
  } catch (error) {
    console.error('FAIL generic extractor')
    console.error(error)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
