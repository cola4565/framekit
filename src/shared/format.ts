import type { DiscoverySource, ResourceKind } from './types'

export const kindMeta: Record<ResourceKind, { label: string; short: string }> = {
  image: { label: '图片', short: 'IMG' },
  video: { label: '视频', short: 'VID' },
  audio: { label: '音频', short: 'AUD' },
  other: { label: '其他', short: 'FILE' }
}

export const sourceMeta: Record<DiscoverySource, string> = {
  html: '页面源码',
  css: '样式资源',
  meta: '页面元数据',
  jsonld: '结构化数据',
  script: '脚本内嵌',
  network: '网络嗅探',
  direct: '直接地址'
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '未知大小'
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainder = total % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

export function formatSpeed(bytesPerSecond?: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function percentOf(received: number, total?: number): number {
  if (!total || total <= 0) return 0
  return Math.min(100, Math.round((received / total) * 100))
}
