import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, session } from 'electron'

const CACHE_NAMES = new Set([
  'cache',
  'code cache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'gpucache',
  'grshader_cache',
  'shader_cache'
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
  for (const name of ['bilibili', 'douyin', 'aigei']) {
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
