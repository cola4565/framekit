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

/**
 * 数据根目录。Windows 打包版位于安装盘下（如 `D:\FrameKitData`），
 * macOS / 开发版沿用 Electron 默认的 userData。
 */
export function getDataRoot(): string {
  return dataRoot
}

/**
 * 子进程环境变量。
 *
 * 这里只覆盖 TEMP/TMP，让 ffmpeg 的临时文件留在数据目录里，
 * 避免写到 C 盘。刻意不改写 LOCALAPPDATA / APPDATA：
 * 那两个变量会被 `shell.openExternal` 启动的默认浏览器继承，
 * 导致系统浏览器的用户配置目录被重建到 FrameKit 数据目录里
 * （表现为数据目录里多出几百 MB 的 `Microsoft/Edge`）。
 */
export function buildChildEnv(): NodeJS.ProcessEnv {
  // 冒烟测试在没有 Electron 运行时的情况下会直接调用这个函数，
  // 此时拿不到 app.getPath，退回系统默认临时目录即可。
  let temp = process.env.TEMP || process.env.TMP
  try {
    temp = app.getPath('temp')
  } catch {
    // 保留系统默认值。
  }
  return { ...process.env, TEMP: temp, TMP: temp }
}

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
