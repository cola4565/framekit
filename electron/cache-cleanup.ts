import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, session } from 'electron'
import { getDataRoot } from './storage'

const CACHE_NAMES = new Set([
  'cache',
  'code cache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'gpucache',
  'grshader_cache',
  'shader_cache',
  'cachestorage',
  'scriptcache'
])

async function removeNamedDirectories(root: string, depth = 0): Promise<void> {
  if (depth > 6) return
  if (!existsSync(root)) return
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    if (CACHE_NAMES.has(entry.name.toLowerCase())) {
      await rm(path, { recursive: true, force: true })
      continue
    }
    await removeNamedDirectories(path, depth + 1)
  }
}

export async function clearRuntimeCaches(): Promise<void> {
  const userData = app.getPath('userData')
  const roots = new Set<string>([
    userData,
    app.getPath('sessionData'),
    join(userData, 'Partitions')
  ])
  // Windows 打包版把缓存路径指向 <dataRoot>/cache；单独加入，
  // 避免不同 Chromium 版本把部分缓存写到 userData 之外。
  // 不要用 app.getPath('cache')：实测在 Windows 上会返回 %APPDATA% 根目录，
  // 递归清理会误删其他应用的 Cache 目录。
  const dataRoot = getDataRoot()
  if (dataRoot) roots.add(join(dataRoot, 'cache'))
  for (const name of ['bilibili', 'douyin', 'aigei', 'weibo']) {
    try {
      const browserSession = session.fromPartition(`persist:${name}`)
      await browserSession.clearCache()
      roots.add(browserSession.getStoragePath() ?? join(userData, 'Partitions', name))
    } catch {
      // Cleanup must not delay shutdown or affect login state.
    }
  }
  try {
    await session.defaultSession.clearCache()
  } catch {
    // Ignore unavailable sessions during shutdown.
  }
  for (const root of roots) {
    try {
      const resolved = await stat(root)
      if (!resolved.isDirectory()) continue
      await removeNamedDirectories(root)
    } catch {
      // Locked cache files are harmless and will be retried next launch.
    }
  }
}
