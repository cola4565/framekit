import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell
} from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { DownloadRequest, ParseOptions } from '../src/shared/types'
import { getBilibiliAuthStatus, getBilibiliCookieHeader, loginBilibili } from './bilibili'
import { DownloadHistory } from './download-history'
import { DownloadManager } from './downloader'
import { installMediaProtocol, registerMediaScheme } from './media-protocol'
import { parsePage } from './parser'
import { checkForUpdates } from './updater'

const isMac = process.platform === 'darwin'
let mainWindow: BrowserWindow | null = null

registerMediaScheme()

if (process.env.FRAMEKIT_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.FRAMEKIT_DEBUG_PORT)
}

const downloadHistory = new DownloadHistory()

const downloadManager = new DownloadManager((progress) => {
  downloadHistory.record(progress)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download:progress', progress)
  }
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0b0e',
    title: 'FrameKit 后期工具箱',
    titleBarStyle: 'hidden',
    ...(isMac
      ? {
          trafficLightPosition: { x: 18, y: 18 }
        }
      : {
          titleBarOverlay: {
            color: '#0a0b0e',
            symbolColor: '#d8dbe4',
            height: 52
          }
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: '文件',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      role: 'window',
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.handle('app:get-version', async () => app.getVersion())

  ipcMain.handle('window:minimize', async () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimizable()) {
      mainWindow.minimize()
      return true
    }
    return false
  })

  ipcMain.handle('updates:check', async () => checkForUpdates(app.getVersion()))

  ipcMain.handle('bilibili:auth-status', async () => getBilibiliAuthStatus())

  ipcMain.handle('bilibili:login', async () => loginBilibili(mainWindow))

  ipcMain.handle('parse:page', async (event, rawUrl: unknown, rawOptions: unknown) => {
    if (typeof rawUrl !== 'string') throw new Error('网址参数无效')
    const options: ParseOptions = {
      deep: Boolean(
        rawOptions && typeof rawOptions === 'object' && 'deep' in rawOptions
          ? (rawOptions as { deep?: unknown }).deep
          : false
      )
    }
    return parsePage(rawUrl, options, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('parse:progress', progress)
      }
    })
  })

  ipcMain.handle(
    'downloads:start',
    async (_event, rawRequests: unknown, rawDestination: unknown) => {
      if (!Array.isArray(rawRequests) || typeof rawDestination !== 'string') {
        throw new Error('下载参数无效')
      }
      const cookie = await getBilibiliCookieHeader()
      const requests: DownloadRequest[] = []
      for (const item of rawRequests) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        if (
          typeof record.id !== 'string' ||
          typeof record.url !== 'string' ||
          typeof record.filename !== 'string' ||
          typeof record.pageUrl !== 'string' ||
          !['image', 'video', 'audio', 'other'].includes(String(record.kind))
        ) {
          continue
        }
        requests.push({
          id: record.id,
          url: record.url,
          filename: record.filename,
          pageUrl: record.pageUrl,
          kind: record.kind as DownloadRequest['kind'],
          audioUrl:
            typeof record.audioUrl === 'string' &&
            Boolean(record.audioUrl) &&
            /^https?:\/\//i.test(record.audioUrl)
              ? record.audioUrl
              : undefined,
          audioMime: typeof record.audioMime === 'string' ? record.audioMime : undefined,
          cookie: cookie || undefined
        })
      }
      return downloadManager.enqueue(requests, rawDestination)
    }
  )

  ipcMain.handle('downloads:cancel', async (_event, id: unknown) => {
    if (typeof id === 'string') downloadManager.cancel(id)
  })

  ipcMain.handle('downloads:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string') return { removed: false, deletedFile: false }
    const result = await downloadManager.remove(id)
    const record = downloadHistory.take(id)
    let deletedFile = result.deletedFile
    if (record?.filePath && existsSync(record.filePath)) {
      await unlink(record.filePath).catch(() => undefined)
      deletedFile = !existsSync(record.filePath)
    }
    return { removed: result.removed || Boolean(record), deletedFile }
  })

  ipcMain.handle('downloads:list', async () => downloadHistory.list())

  ipcMain.handle('downloads:clear', async () => {
    downloadHistory.clear()
  })

  ipcMain.handle('downloads:verify', async (_event, ids: unknown) => {
    if (!Array.isArray(ids)) return []
    const history = downloadHistory.list()
    const missing: string[] = []
    for (const id of ids) {
      if (typeof id !== 'string') continue
      const filePath =
        downloadManager.filePathOf(id) ?? history.find((item) => item.id === id)?.filePath
      if (filePath && !existsSync(filePath)) missing.push(id)
    }
    return missing
  })

  ipcMain.handle('dialog:choose-directory', async () => {
    if (!mainWindow) throw new Error('窗口尚未准备好')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择素材保存目录',
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('shell:reveal', async (_event, rawPath: unknown) => {
    if (typeof rawPath === 'string' && rawPath) {
      shell.showItemInFolder(rawPath)
    }
  })

  ipcMain.handle('app:open-external', async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string') return
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        await shell.openExternal(parsed.href)
      }
    } catch {
      return
    }
  })

  ipcMain.handle('clipboard:write', async (_event, rawText: unknown) => {
    if (typeof rawText === 'string') clipboard.writeText(rawText)
  })

  ipcMain.handle('clipboard:read', async () => clipboard.readText())
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.framekit.desktop')
    }
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    installMediaProtocol()
    await downloadHistory.load()
    buildMenu()
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  app.on('before-quit', () => {
    downloadHistory.flushSync()
  })
}
