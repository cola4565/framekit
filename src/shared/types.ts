export type ResourceKind = 'image' | 'video' | 'audio' | 'other'

export type DiscoverySource =
  | 'html'
  | 'css'
  | 'meta'
  | 'jsonld'
  | 'script'
  | 'network'
  | 'direct'

export interface MediaResource {
  id: string
  url: string
  kind: ResourceKind
  source: DiscoverySource
  pageUrl: string
  filename: string
  extension: string
  mime?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  poster?: string
  label?: string
  discoveryLabel: string
  isStream: boolean
  audioUrl?: string
  audioMime?: string
  qualityId?: number
  qualityLabel?: string
  codec?: string
  mergeAudio?: boolean
  groupId?: string
}

export interface ParseStats {
  images: number
  videos: number
  audios: number
  others: number
  total: number
  knownBytes: number
}

export interface ParseResult {
  pageUrl: string
  finalUrl: string
  title: string
  description?: string
  siteName?: string
  favicon?: string
  mode: 'quick' | 'deep'
  resources: MediaResource[]
  stats: ParseStats
  warnings: string[]
  elapsedMs: number
}

export interface ParseProgress {
  stage: 'fetch' | 'parse' | 'browser' | 'network' | 'merge' | 'done'
  message: string
  percent: number
}

export interface ParseOptions {
  deep: boolean
}

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'done'
  | 'error'
  | 'canceled'

export interface DownloadRequest {
  id: string
  url: string
  filename: string
  kind: ResourceKind
  pageUrl: string
  audioUrl?: string
  audioMime?: string
  cookie?: string
}

export interface DownloadProgress {
  id: string
  url: string
  filename: string
  kind: ResourceKind
  status: DownloadStatus
  received: number
  total?: number
  speed: number
  error?: string
  filePath?: string
  destination: string
  startedAt?: number
  finishedAt?: number
  message?: string
  phase?: 'download' | 'merge'
  fileMissing?: boolean
}

export interface StartDownloadsResult {
  queued: number
  destination: string
}

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  releaseTag: string
  releaseName: string
  releaseNotes: string
  releaseUrl: string
  publishedAt: string
  hasUpdate: boolean
  downloadUrl: string | null
  downloadName: string | null
}

export interface FramekitApi {
  platform: NodeJS.Platform
  getAppVersion: () => Promise<string>
  checkForUpdates: () => Promise<UpdateCheckResult>
  getBilibiliAuthStatus: () => Promise<boolean>
  loginBilibili: () => Promise<boolean>
  parsePage: (url: string, options: ParseOptions) => Promise<ParseResult>
  onParseProgress: (callback: (progress: ParseProgress) => void) => () => void
  chooseDirectory: () => Promise<string | null>
  startDownloads: (
    requests: DownloadRequest[],
    destination: string
  ) => Promise<StartDownloadsResult>
  cancelDownload: (id: string) => Promise<void>
  removeDownload: (id: string) => Promise<{ removed: boolean; deletedFile: boolean }>
  listDownloads: () => Promise<DownloadProgress[]>
  clearDownloads: () => Promise<void>
  verifyDownloads: (ids: string[]) => Promise<string[]>
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) => () => void
  revealFile: (filePath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  copyText: (text: string) => Promise<void>
  readClipboard: () => Promise<string>
}
