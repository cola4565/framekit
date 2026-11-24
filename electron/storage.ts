import { app } from 'electron'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'

const DATA_FOLDER = 'FrameKitData'
const DATA_MARKER = '.framekit-data'
const CACHE_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GPUPersistentCache',
  'VideoDecodeStats',
  'Dictionaries',
  'blob_storage'
])

let dataRoot = ''
let legacyUserData = ''
let legacyLocalData = ''
let legacyUpdaterData = ''

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

function driveRootOf(target: string): string {
  const match = /^([A-Za-z]:)[\\/]/.exec(normalize(target))
  return match ? `${match[1].toUpperCase()}\\` : ''
}

function ensureWritableDirectory(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true })
    const probe = join(path, `.write-test-${process.pid}-${Date.now()}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function selectDataRoot(): string {
  const override = process.env.FRAMEKIT_DATA_DIR?.trim()
  if (override) return resolve(override)

  if (!app.isPackaged) {
    return join(process.cwd(), '.tmp', 'framekit-data')
  }

  const executableDir = dirname(process.execPath)
  const executableDrive = driveRootOf(executableDir)
  if (executableDrive && executableDrive !== 'C:\\') {
    const candidate = join(executableDrive, DATA_FOLDER)
    if (ensureWritableDirectory(candidate)) return candidate
  }

  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const candidate = `${letter}:\\${DATA_FOLDER}`
    if (existsSync(`${letter}:\\`) && ensureWritableDirectory(candidate)) return candidate
  }

  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'framekit')
}

function initializeDirectories(userData: string): void {
  const paths = {
    root: dataRoot,
    userData,
    sessionData: userData,
    cache: join(dataRoot, 'cache'),
    logs: join(dataRoot, 'logs'),
    crashDumps: join(dataRoot, 'crashDumps'),
    temp: join(dataRoot, 'temp'),
    local: join(dataRoot, 'local'),
    roaming: join(dataRoot, 'roaming')
  }

  for (const path of Object.values(paths)) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(dataRoot, DATA_MARKER), 'FrameKit data directory\n')

  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  app.setPath('cache', paths.cache)
  app.setPath('logs', paths.logs)
  app.setPath('crashDumps', paths.crashDumps)
  app.setPath('temp', paths.temp)

  process.env.LOCALAPPDATA = paths.local
  process.env.APPDATA = paths.roaming
  process.env.TEMP = paths.temp
  process.env.TMP = paths.temp
}

export function prepareStorage(): string {
  if (process.platform !== 'win32') {
    dataRoot = app.getPath('userData')
    return dataRoot
  }

  legacyUserData = process.env.APPDATA ? join(process.env.APPDATA, 'framekit') : ''
  legacyLocalData = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'framekit') : ''
  legacyUpdaterData = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'framekit-updater')
    : ''

  dataRoot = selectDataRoot()
  const userData = samePath(dataRoot, legacyUserData) ? dataRoot : join(dataRoot, 'data')
  initializeDirectories(userData)
  console.log(`FrameKit data directory: ${dataRoot}`)
  return dataRoot
}

export function migrateLegacyStorage(): void {
  if (process.platform !== 'win32' || !app.isPackaged || !dataRoot) return

  const target = samePath(dataRoot, legacyUserData) ? dataRoot : join(dataRoot, 'data')
  const migratedMarker = join(target, '.framekit-migrated')
  const sourceExists = Boolean(legacyUserData) && existsSync(legacyUserData)

  if (sourceExists && !samePath(legacyUserData, target)) {
    if (!existsSync(migratedMarker)) {
      try {
        cpSync(legacyUserData, target, {
          recursive: true,
          force: true,
          errorOnExist: false,
          filter: (source) => !CACHE_DIRS.has(basename(source))
        })
        writeFileSync(migratedMarker, 'migrated\n')
        rmSync(legacyUserData, { recursive: true, force: true })
      } catch (error) {
        console.error('FrameKit legacy data migration failed:', error)
      }
    } else {
      rmSync(legacyUserData, { recursive: true, force: true })
    }
  }

  for (const legacy of [legacyLocalData, legacyUpdaterData]) {
    if (!legacy || !existsSync(legacy)) continue
    if (samePath(legacy, dataRoot) || legacy.startsWith(`${dataRoot}\\`)) continue
    try {
      rmSync(legacy, { recursive: true, force: true })
    } catch (error) {
      console.error(`FrameKit legacy cache cleanup failed (${legacy}):`, error)
    }
  }

  if (sourceExists && existsSync(target) && readdirSync(target).length === 0) {
    console.warn('FrameKit legacy data was empty; keeping the new data directory')
  }
}
