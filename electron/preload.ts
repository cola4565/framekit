import { contextBridge, ipcRenderer } from 'electron'
import type {
  DownloadProgress,
  DownloadRequest,
  FramekitApi,
  ParseOptions,
  ParseProgress,
  ParseResult,
  StartDownloadsResult,
  UpdateCheckResult
} from '../src/shared/types'

const api: FramekitApi = {
  platform: process.platform,
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
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
