import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 更新设置。参考 magpie 的做法：更新源可以是自建的 feed（不依赖 GitHub API 配额），
 * 也可以是 GitHub；失败时按顺序回退。
 */

export type UpdateSource = 'github' | 'custom'

export interface UpdateSettings {
  /** 用哪个更新源：GitHub 官方 Release，或自建 feed。 */
  source: UpdateSource
  /** 自建 feed 地址；source 为 custom 时使用。 */
  feedUrl: string
  /** 下载镜像前缀，如 https://mirror.example/；放在 github.com 地址之前。 */
  mirror: string
  /** 更新专用代理；留空跟随系统代理。 */
  proxy: string
}

const SETTINGS_FILE = 'update-settings.json'

const DEFAULTS: UpdateSettings = {
  source: 'github',
  feedUrl: '',
  mirror: '',
  proxy: ''
}

let cached: UpdateSettings | null = null

function settingsPath(): string {
  const directory = join(app.getPath('userData'), 'config')
  mkdirSync(directory, { recursive: true })
  return join(directory, SETTINGS_FILE)
}

function sanitizeFeedUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  // 只允许 http(s)，避免 file:// 之类的协议被用来读本地文件。
  if (!/^https?:\/\//i.test(trimmed)) return ''
  return trimmed
}

function sanitizeMirror(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!/^https:\/\//i.test(trimmed)) return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

function sanitizeProxy(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed === 'direct') return 'direct'
  if (!/^(https?|socks5|socks5h):\/\//i.test(trimmed)) return ''
  return trimmed
}

export function getUpdateSettings(): UpdateSettings {
  if (cached) return cached
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>
    cached = {
      source: raw.source === 'custom' ? 'custom' : 'github',
      feedUrl: sanitizeFeedUrl(raw.feedUrl),
      mirror: sanitizeMirror(raw.mirror),
      proxy: sanitizeProxy(raw.proxy)
    }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

export function saveUpdateSettings(next: Partial<UpdateSettings>): UpdateSettings {
  const current = getUpdateSettings()
  const merged: UpdateSettings = {
    source: next.source === 'custom' ? 'custom' : 'github',
    feedUrl: sanitizeFeedUrl(next.feedUrl ?? current.feedUrl),
    mirror: sanitizeMirror(next.mirror ?? current.mirror),
    proxy: sanitizeProxy(next.proxy ?? current.proxy)
  }
  try {
    writeFileSync(settingsPath(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.error('FrameKit update settings save failed:', error)
  }
  cached = merged
  return merged
}

export function resetUpdateSettingsCache(): void {
  cached = null
}

export { dirname }
