import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const imageColors = ['#ff6a3d', '#73a6ff', '#53d18b', '#c588ff', '#f0b35a', '#ff7aa8']

function svgImage(index: number, label: string): string {
  const color = imageColors[index % imageColors.length]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${color}"/>
        <stop offset="1" stop-color="#0b0c10"/>
      </linearGradient>
      <pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse">
        <path d="M48 0H0V48" fill="none" stroke="rgba(255,255,255,.08)"/>
      </pattern>
    </defs>
    <rect width="1280" height="800" fill="url(#g)"/>
    <rect width="1280" height="800" fill="url(#p)"/>
    <circle cx="980" cy="200" r="210" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
    <circle cx="980" cy="200" r="145" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="2"/>
    <text x="80" y="650" fill="white" font-family="Arial, sans-serif" font-size="80" font-weight="700">${label}</text>
    <text x="84" y="704" fill="rgba(255,255,255,.56)" font-family="Arial, sans-serif" font-size="26" letter-spacing="8">FRAMEKIT DEMO ASSET</text>
  </svg>`
}

const page = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Neon Coast — Demo Gallery</title>
    <meta property="og:title" content="Neon Coast — Demo Gallery" />
    <meta property="og:description" content="A local demonstration page for FrameKit." />
    <meta property="og:site_name" content="FrameKit Demo" />
    <meta property="og:image" content="/images/hero.svg" />
    <link rel="icon" href="/favicon.svg" />
    <style>
      body { margin: 0; background: #0e1015; color: #fff; font-family: sans-serif; }
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; padding: 40px; }
      .grid img { width: 100%; border-radius: 12px; }
      .bg { height: 320px; background-image: url('/images/background.svg'); background-size: cover; }
    </style>
  </head>
  <body>
    <div class="bg"></div>
    <div class="grid">
      <img src="/images/01.svg" alt="Neon Coast 01" width="1280" height="800" />
      <img src="/images/02.svg" alt="Neon Coast 02" width="1280" height="800" />
      <img src="/images/03.svg" alt="Neon Coast 03" width="1280" height="800" />
      <img data-src="/images/04.svg" alt="Lazy loaded frame" />
      <img src="/images/05.svg" alt="Color study" />
      <img src="/images/06.svg" alt="Night plate" />
    </div>
    <video src="/media/trailer.mp4" poster="/images/07.svg" controls width="1280" height="720">
      <source src="/media/trailer.webm" type="video/webm" />
    </video>
    <audio src="/media/soundtrack.mp3" controls></audio>
    <a href="/media/cut.mov" download>Download edit</a>
    <a href="/docs/storyboard.pdf">Storyboard PDF</a>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"ImageObject","contentUrl":"/images/08.svg","width":1280,"height":800}
    </script>
  </body>
</html>`

const server = createServer((request, response) => {
  const url = request.url ?? '/'
  if (url === '/' || url === '/demo') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page)
    return
  }
  if (url === '/favicon.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' })
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#ff6a3d"/><path d="M18 18h28v28H18z" fill="none" stroke="white" stroke-width="3"/></svg>'
    )
    return
  }
  const imageMatch = url.match(/^\/images\/(\d+)\.svg/)
  if (imageMatch) {
    response.writeHead(200, {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=600'
    })
    response.end(svgImage(Number(imageMatch[1]), `FRAME ${imageMatch[1]}`))
    return
  }
  if (url === '/images/background.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' })
    response.end(svgImage(9, 'NEON COAST'))
    return
  }
  if (url.startsWith('/media/') || url.startsWith('/docs/')) {
    response.writeHead(200, {
      'content-type': url.endsWith('.mp4')
        ? 'video/mp4'
        : url.endsWith('.webm')
          ? 'video/webm'
          : url.endsWith('.mp3')
            ? 'audio/mpeg'
            : url.endsWith('.pdf')
              ? 'application/pdf'
              : 'video/quicktime',
      'content-length': '1024'
    })
    response.end(Buffer.alloc(1024, 0))
    return
  }
  response.writeHead(404)
  response.end('not found')
})

server.listen(8787, '127.0.0.1', () => {
  const address = server.address() as AddressInfo
  console.log(`FrameKit demo page: http://127.0.0.1:${address.port}/demo`)
})
