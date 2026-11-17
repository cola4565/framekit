import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from 'electron'
import { parsePage } from '../electron/parser'

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Dynamic Fixture</title>
    <meta property="og:description" content="Dynamic rendering fixture" />
    <style>
      body { font-family: sans-serif; }
      .spacer { height: 1200px; }
    </style>
  </head>
  <body>
    <h1>Dynamic resource fixture</h1>
    <img src="/static/existing.png" alt="Static resource" />
    <div class="spacer"></div>
    <script>
      setTimeout(() => {
        const image = new Image();
        image.src = '/dynamic/late-image.png?cache=1';
        document.body.appendChild(image);

        const video = document.createElement('video');
        video.src = '/dynamic/late-video.mp4';
        video.preload = 'auto';
        video.style.width = '320px';
        video.style.height = '180px';
        document.body.appendChild(video);
        video.load();

        const audio = document.createElement('audio');
        audio.src = '/dynamic/late-audio.mp3';
        audio.preload = 'auto';
        document.body.appendChild(audio);
        audio.load();

        const background = document.createElement('div');
        background.style.position = 'fixed';
        background.style.left = '0';
        background.style.top = '0';
        background.style.width = '64px';
        background.style.height = '64px';
        background.style.backgroundImage = 'url(/dynamic/late-bg.webp)';
        document.body.appendChild(background);
      }, 500);
    </script>
  </body>
</html>`

async function main(): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page)
      return
    }
    if (request.url === '/static/existing.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': '600' })
      response.end(Buffer.alloc(600, 5))
      return
    }
    if (request.url?.startsWith('/dynamic/late-image.png')) {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': '600'
      })
      response.end(Buffer.alloc(600, 1))
      return
    }
    if (request.url?.startsWith('/dynamic/late-video.mp4')) {
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': '2048'
      })
      response.end(Buffer.alloc(2048, 2))
      return
    }
    if (request.url?.startsWith('/dynamic/late-audio.mp3')) {
      response.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': '2048'
      })
      response.end(Buffer.alloc(2048, 3))
      return
    }
    if (request.url?.startsWith('/dynamic/late-bg.webp')) {
      response.writeHead(200, {
        'content-type': 'image/webp',
        'content-length': '700'
      })
      response.end(Buffer.alloc(700, 4))
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
    const paths = result.resources.map((resource) => new URL(resource.url).pathname)

    for (const expected of [
      '/dynamic/late-image.png',
      '/dynamic/late-video.mp4',
      '/dynamic/late-audio.mp3',
      '/dynamic/late-bg.webp',
      '/static/existing.png'
    ]) {
      assert.ok(paths.includes(expected), `missing dynamically loaded resource ${expected}`)
    }

    const kinds = new Set(result.resources.map((resource) => resource.kind))
    assert.ok(kinds.has('image'), 'expected image resources')
    assert.ok(kinds.has('video'), 'expected video resources')
    assert.ok(kinds.has('audio'), 'expected audio resources')

    console.log(
      `PASS deep sniff: ${result.resources.length} resources captured from ${result.finalUrl}`
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  try {
    await main()
  } catch (error) {
    console.error('FAIL deep sniff')
    console.error(error)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
