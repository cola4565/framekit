import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  classifyResource,
  normalizeUrl,
  parseStaticPage
} from '../electron/extractor'

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Fixture Gallery</title>
    <meta property="og:title" content="Fixture OG Title" />
    <meta property="og:description" content="A local fixture page." />
    <meta property="og:image" content="/og/cover.jpg" />
    <meta property="og:video" content="/video/og.mp4" />
    <link rel="icon" href="/favicon.png" />
    <link rel="stylesheet" href="/style.css" />
    <style>.hero { background-image: url('/bg/hero.webp'); }</style>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "ImageObject",
        "contentUrl": "/json/full.png",
        "width": 1200,
        "height": 800
      }
    </script>
    <script>
      window.__DATA__ = {
        "clip": "https:\\/\\/example.com\\/clips\\/teaser.mp4?token=1",
        "audio": "\\/audio\\/theme.mp3"
      };
    </script>
  </head>
  <body>
    <img src="/img/a.jpg" alt="Image A" width="640" height="480" />
    <img data-src="/img/lazy.png" srcset="/img/a.jpg 1x, /img/a@2x.jpg 2x" alt="Lazy" />
    <picture>
      <source srcset="/img/picture.avif 1x" />
      <img src="/img/fallback.jpg" alt="Picture fallback" />
    </picture>
    <video src="/video/main.mp4" poster="/video/poster.jpg" width="1920" height="1080">
      <source src="/video/main.webm" type="video/webm" />
    </video>
    <audio src="/audio/song.mp3"></audio>
    <a href="/downloads/cut.mov">Download cut</a>
    <a href="/docs/notes.pdf">Notes PDF</a>
    <a href="/about">About</a>
    <div style="background-image:url('/bg/inline.png')"></div>
  </body>
</html>`

async function main(): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === '/style.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
      response.end('body { background: url("../bg/css-bg.jpg") no-repeat; }')
      return
    }
    if (request.url === '/direct.mp4') {
      response.writeHead(200, { 'content-type': 'video/mp4' })
      response.end()
      return
    }
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const result = await parseStaticPage(`${origin}/`)
    const urls = result.resources.map((resource) => resource.url)

    assert.equal(result.title, 'Fixture OG Title')
    assert.ok(result.stats.images >= 8, `expected at least 8 images, got ${result.stats.images}`)
    assert.ok(result.stats.videos >= 3, `expected at least 3 videos, got ${result.stats.videos}`)
    assert.equal(result.stats.audios, 2)
    assert.equal(result.stats.others, 1)

    for (const expectedPath of [
      '/img/a.jpg',
      '/img/a@2x.jpg',
      '/img/lazy.png',
      '/img/picture.avif',
      '/img/fallback.jpg',
      '/video/main.mp4',
      '/video/main.webm',
      '/video/og.mp4',
      '/video/poster.jpg',
      '/audio/song.mp3',
      '/audio/theme.mp3',
      '/downloads/cut.mov',
      '/docs/notes.pdf',
      '/json/full.png',
      '/og/cover.jpg',
      '/bg/hero.webp',
      '/bg/inline.png',
      '/bg/css-bg.jpg',
      '/clips/teaser.mp4'
    ]) {
      assert.ok(
        urls.some((url) => new URL(url).pathname === expectedPath),
        `missing expected resource ${expectedPath}`
      )
    }

    assert.ok(!urls.some((url) => /^(?:data|blob):/i.test(url)))
    assert.equal(result.resources.find((resource) => resource.filename === 'cut.mov')?.kind, 'video')
    assert.equal(result.resources.find((resource) => resource.filename === 'notes.pdf')?.kind, 'other')
    assert.equal(
      result.resources.find((resource) => resource.filename === 'main.mp4')?.poster,
      `${origin}/video/poster.jpg`
    )

    const ogVideo = result.resources.find((resource) => resource.filename === 'og.mp4')
    assert.equal(
      ogVideo?.poster,
      `${origin}/og/cover.jpg`,
      '没有自带封面的视频应回退到页面封面'
    )

    const direct = await parseStaticPage(`${origin}/direct.mp4`)
    assert.equal(direct.resources.length, 1)
    assert.equal(direct.resources[0].kind, 'video')
    assert.equal(direct.resources[0].source, 'direct')

    assert.equal(classifyResource('https://cdn.example.com/a/master.m3u8').isStream, true)
    assert.equal(classifyResource('https://cdn.example.com/a/master.m3u8').kind, 'video')
    assert.equal(normalizeUrl('javascript:alert(1)', origin), null)
    assert.equal(normalizeUrl('//cdn.example.com/a.jpg', origin), 'http://cdn.example.com/a.jpg')

    console.log(
      `PASS parser smoke: ${result.stats.images} images, ${result.stats.videos} videos, ` +
        `${result.stats.audios} audio, ${result.stats.others} other, ` +
        `${result.stats.total} total in ${result.elapsedMs}ms`
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

main().catch((error: unknown) => {
  console.error('FAIL parser smoke')
  console.error(error)
  process.exitCode = 1
})
