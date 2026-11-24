import { contextBridge, ipcRenderer } from 'electron'
import type {
  DownloadProgress,
  DownloadRequest,
  FramekitApi,
  ParseOptions,
  ParseProgress,
  ParseResult,
  StartDownloadsResult,
  UpdateCheckResult,
  UpdateDownloadState,
  UpdateSettings
} from '../src/shared/types'

const api: FramekitApi = {
  platform: process.platform,
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  respondToClose: (action): Promise<boolean> => ipcRenderer.invoke('window:close-action', action),
  onCloseRequest: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('window:close-request', listener)
    ipcRenderer.send('window:close-ready')
    return () => ipcRenderer.removeListener('window:close-request', listener)
  },
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
  getUpdateSettings: (): Promise<UpdateSettings> => ipcRenderer.invoke('updates:get-settings'),
  saveUpdateSettings: (settings: Partial<UpdateSettings>): Promise<UpdateSettings> =>
    ipcRenderer.invoke('updates:save-settings', settings),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('updates:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updates:install'),
  onUpdateProgress: (callback: (state: UpdateDownloadState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdateDownloadState): void => {
      callback(state)
    }
    ipcRenderer.on('updates:progress', listener)
    return () => ipcRenderer.removeListener('updates:progress', listener)
  },
  getBilibiliAuthStatus: (): Promise<boolean> => ipcRenderer.invoke('bilibili:auth-status'),
  loginBilibili: (): Promise<boolean> => ipcRenderer.invoke('bilibili:login'),
  getAigeiAuthStatus: (): Promise<boolean> => ipcRenderer.invoke('aigei:auth-status'),
  loginAigei: (): Promise<boolean> => ipcRenderer.invoke('aigei:login'),
  getDouyinAuthStatus: (): Promise<boolean> => ipcRenderer.invoke('douyin:auth-status'),
  loginDouyin: (): Promise<boolean> => ipcRenderer.invoke('douyin:login'),
  parsePage: (url: string, options: ParseOptions): Promise<ParseResult> =>
    ipcRenderer.invoke('parse:page', url, options),
  onParseProgress: (callback: (progress: ParseProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ParseProgress): void => {
      callback(progress)
    }
    ipcRenderer.on('parse:progress', listener)
    return () => ipcRenderer.removeListener('parse:progress', listener)
  },
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:choose-directory'),
  startDownloads: (
    requests: DownloadRequest[],
    destination: string
  ): Promise<StartDownloadsResult> =>
    ipcRenderer.invoke('downloads:start', requests, destination),
  cancelDownload: (id: string): Promise<void> => ipcRenderer.invoke('downloads:cancel', id),
  removeDownload: (id: string): Promise<{ removed: boolean; deletedFile: boolean }> =>
    ipcRenderer.invoke('downloads:remove', id),
  listDownloads: (): Promise<DownloadProgress[]> => ipcRenderer.invoke('downloads:list'),
  clearDownloads: (): Promise<void> => ipcRenderer.invoke('downloads:clear'),
  verifyDownloads: (ids: string[]): Promise<string[]> =>
    ipcRenderer.invoke('downloads:verify', ids),
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: DownloadProgress): void => {
      callback(progress)
    }
    ipcRenderer.on('download:progress', listener)
    return () => ipcRenderer.removeListener('download:progress', listener)
  },
  revealFile: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:reveal', filePath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read')
}

contextBridge.exposeInMainWorld('framekit', api)
