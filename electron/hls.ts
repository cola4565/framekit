export interface HlsVariant {
  url: string
  bandwidth?: number
  width?: number
  height?: number
}

export interface HlsSegment {
  url: string
  duration: number
}

export interface HlsMediaPlaylist {
  segments: HlsSegment[]
  duration: number
  encrypted: boolean
  initSegment?: string
  hasByteRange: boolean
}

export function isHlsUrl(rawUrl: string): boolean {
  try {
    return /\.m3u8$/i.test(new URL(rawUrl).pathname)
  } catch {
    return false
  }
}

function attributeOf(line: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[,:])\\s*${name}=("[^"]*"|[^,]*)`, 'i').exec(line)
  return match?.[1]?.replace(/^"|"$/g, '').trim()
}

function resolveUri(rawUri: string, baseUrl: string): string | null {
  try {
    return new URL(rawUri, baseUrl).toString()
  } catch {
    return null
  }
}

export function parseHlsMaster(text: string, baseUrl: string): HlsVariant[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const variants: HlsVariant[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue

    const bandwidth = Number.parseInt(attributeOf(line, 'BANDWIDTH') ?? '', 10)
    const resolution = /RESOLUTION=(\d+)x(\d+)/i.exec(line)
    let cursor = index + 1
    while (cursor < lines.length && (!lines[cursor] || lines[cursor].startsWith('#'))) {
      cursor += 1
    }
    const uri = lines[cursor]
    if (!uri) continue

    const resolved = resolveUri(uri, baseUrl)
    if (!resolved) continue
    variants.push({
      url: resolved,
      bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : undefined,
      width: resolution ? Number.parseInt(resolution[1], 10) : undefined,
      height: resolution ? Number.parseInt(resolution[2], 10) : undefined
    })
    index = cursor
  }

  return variants
}

export function parseHlsMedia(text: string, baseUrl: string): HlsMediaPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const segments: HlsSegment[] = []
  let pendingDuration = 0
  let duration = 0
  let encrypted = false
  let initSegment: string | undefined
  let hasByteRange = false

  for (const line of lines) {
    if (!line) continue

    if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice('#EXTINF:'.length))
      pendingDuration = Number.isFinite(value) && value > 0 ? value : 0
      continue
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const method = attributeOf(line, 'METHOD')?.toUpperCase()
      if (method && method !== 'NONE') encrypted = true
      continue
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = attributeOf(line, 'URI')
      if (uri) initSegment = resolveUri(uri, baseUrl) ?? undefined
      continue
    }

    if (line.startsWith('#EXT-X-BYTERANGE') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      hasByteRange = true
      continue
    }

    if (line.startsWith('#')) continue

    const resolved = resolveUri(line, baseUrl)
    if (!resolved) continue
    segments.push({ url: resolved, duration: pendingDuration })
    duration += pendingDuration
    pendingDuration = 0
  }

  return { segments, duration, encrypted, initSegment, hasByteRange }
}

export function bestHlsVariant(variants: HlsVariant[]): HlsVariant | undefined {
  return variants.reduce<HlsVariant | undefined>((best, variant) => {
    if (!best) return variant
    const bestScore = (best.height ?? 0) * 100000 + (best.bandwidth ?? 0)
    const score = (variant.height ?? 0) * 100000 + (variant.bandwidth ?? 0)
    return score > bestScore ? variant : best
  }, undefined)
}

export function qualityLabelOfVariant(variant: HlsVariant): string {
  if (variant.height) return `${variant.height}P`
  if (variant.bandwidth) return `${Math.round(variant.bandwidth / 1000)} kbps`
  return '原画'
}
