import { net, protocol, session } from 'electron'

export const MEDIA_SCHEME = 'framekit-media'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control'
]

const BILIBILI_PARTITION = 'persist:bilibili'
let cachedCookie = { value: '', at: 0 }

async function bilibiliCookieHeader(): Promise<string> {
  if (Date.now() - cachedCookie.at < 30_000) return cachedCookie.value
  try {
    const cookies = await session.fromPartition(BILIBILI_PARTITION).cookies.get({})
    const value = cookies
      .filter((cookie) => {
        const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
        return domain === 'bilibili.com' || domain.endsWith('.bilibili.com')
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
    cachedCookie = { value, at: Date.now() }
    return value
  } catch {
    return ''
  }
}

function hostMatches(hostname: string, suffixes: string[]): boolean {
  return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
}

export function isBilibiliHostUrl(rawUrl: string): boolean {
  try {
    return hostMatches(new URL(rawUrl).hostname.toLowerCase(), ['bilibili.com'])
  } catch {
    return false
  }
}

export function isBilibiliMediaUrl(rawUrl: string): boolean {
  try {
    return hostMatches(new URL(rawUrl).hostname.toLowerCase(), [
      'bilibili.com',
      'bilivideo.com',
      'bilivideo.cn',
      'hdslb.com'
    ])
  } catch {
    return false
  }
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
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

function badRequest(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  })
}

export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let target: string | null = null
    let referer: string | null = null
    try {
      const parsed = new URL(request.url)
      target = parsed.searchParams.get('url')
      const rawReferer = parsed.searchParams.get('referer')
      if (rawReferer && /^https?:\/\//i.test(rawReferer)) referer = rawReferer
    } catch {
      return badRequest('Invalid media url')
    }
    if (!target || !/^https?:\/\//i.test(target)) return badRequest('Invalid media url')

    const bilibili =
      isBilibiliMediaUrl(target) || (Boolean(referer) && isBilibiliHostUrl(referer as string))
    const headers = new Headers({
      'user-agent': USER_AGENT,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9'
    })
    if (bilibili) {
      headers.set('referer', 'https://www.bilibili.com/')
      const cookie = await bilibiliCookieHeader()
      if (cookie) headers.set('cookie', cookie)
    } else if (referer) {
      headers.set('referer', referer)
    }

    const range = request.headers.get('range')
    if (range) {
      headers.set('range', range)
    } else if (bilibili) {
      headers.set('range', 'bytes=0-')
    }

    let upstream: Response
    try {
      upstream = await net.fetch(target, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        redirect: 'follow'
      })
    } catch (error) {
      return badRequest(`Media fetch failed: ${String(error)}`, 502)
    }

    const responseHeaders = new Headers()
    for (const name of PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) responseHeaders.set(name, value)
    }
    if (!responseHeaders.has('accept-ranges')) responseHeaders.set('accept-ranges', 'bytes')
    responseHeaders.set('access-control-allow-origin', '*')

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    })
  })
}
