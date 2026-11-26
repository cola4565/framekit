import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Clipboard,
  Download,
  ExternalLink,
  FileText,
  Film,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Layers,
  Loader2,
  LogIn,
  Music,
  RefreshCw,
  Search,
  X,
  Zap
} from 'lucide-react'
import DownloadDrawer from './components/DownloadDrawer'
import CloseConfirmModal from './components/CloseConfirmModal'
import EmptyState from './components/EmptyState'
import PreviewModal from './components/PreviewModal'
import ResourceCard from './components/ResourceCard'
import Sidebar from './components/Sidebar'
import { isHlsResource, lowestQualityVariant } from './shared/media'
import UpdateModal from './components/UpdateModal'
import type {
  DownloadProgress,
  MediaResource,
  ParseProgress,
  ParseResult,
  ResourceKind,
  UpdateCheckResult,
  UpdateDownloadState,
  UpdateSettings
} from './shared/types'
import {
  formatBytes,
  hostOf,
  kindMeta,
  percentOf
} from './shared/format'

type FilterKey = 'all' | ResourceKind
type ToastTone = 'info' | 'success' | 'error'

interface ToastState {
  id: number
  message: string
  tone: ToastTone
}

const SAVE_PATH_KEY = 'framekit.destination'
const PROGRESS_STEPS = [
  { label: '连接', threshold: 8 },
  { label: '解析', threshold: 28 },
  { label: '浏览器', threshold: 58 },
  { label: '合并', threshold: 94 }
]

function readSavedPath(): string {
  try {
    return localStorage.getItem(SAVE_PATH_KEY) ?? ''
  } catch {
    return ''
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cleaned = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    return cleaned || '操作失败'
  }
  return '操作失败，请重试'
}

function folderLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

export default function App(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [deep, setDeep] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<ParseProgress | null>(null)
  const [result, setResult] = useState<ParseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [preview, setPreview] = useState<MediaResource | null>(null)
  const [destination, setDestination] = useState(readSavedPath)
  const [queueOpen, setQueueOpen] = useState(false)
  const [closePromptOpen, setClosePromptOpen] = useState(false)
  const [downloads, setDownloads] = useState<DownloadProgress[]>([])
  const removedDownloadIds = useRef<Set<string>>(new Set())
  const downloadsRef = useRef<DownloadProgress[]>([])
  const [toast, setToast] = useState<ToastState | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadState | null>(null)
  const [updateSettings, setUpdateSettings] = useState<UpdateSettings | null>(null)
  const [bilibiliLoggedIn, setBilibiliLoggedIn] = useState(false)
  const [bilibiliLoginBusy, setBilibiliLoginBusy] = useState(false)
  const [aigeiLoggedIn, setAigeiLoggedIn] = useState(false)
  const [aigeiLoginBusy, setAigeiLoginBusy] = useState(false)
  const [douyinLoggedIn, setDouyinLoggedIn] = useState(false)
  const [douyinLoginBusy, setDouyinLoginBusy] = useState(false)
  const [weiboLoggedIn, setWeiboLoggedIn] = useState(false)
  const [weiboLoginBusy, setWeiboLoginBusy] = useState(false)
  const toastTimer = useRef<number | null>(null)
  const toastId = useRef(0)

  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastId.current += 1
    setToast({ id: toastId.current, message, tone })
    toastTimer.current = window.setTimeout(() => setToast(null), 3600)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.framekit
      .getAppVersion()
      .then((version) => {
        if (active) setAppVersion(version)
      })
      .catch(() => {
        if (active) setAppVersion('1.0.0')
      })
    return () => {
      active = false
    }
  }, [])

  const isBilibiliInput = useMemo(() => {
    try {
      const parsed = new URL(url.trim())
      return (
        parsed.hostname === 'b23.tv' ||
        parsed.hostname === 'bilibili.com' ||
        parsed.hostname.endsWith('.bilibili.com')
      )
    } catch {
      return false
    }
  }, [url])

  const isAigeiInput = useMemo(() => {
    try {
      const parsed = new URL(url.trim())
      return parsed.hostname === 'aigei.com' || parsed.hostname.endsWith('.aigei.com')
    } catch {
      return false
    }
  }, [url])

  const isDouyinInput = useMemo(() => {
    try {
      const parsed = new URL(url.trim())
      return (
        parsed.hostname === 'v.douyin.com' ||
        parsed.hostname === 'douyin.com' ||
        parsed.hostname.endsWith('.douyin.com')
      )
    } catch {
      return false
    }
  }, [url])

  const isWeiboInput = useMemo(() => {
    try {
      const parsed = new URL(url.trim())
      const host = parsed.hostname
      return (
        host === 'weibo.com' ||
        host.endsWith('.weibo.com') ||
        host === 'weibo.cn' ||
        host.endsWith('.weibo.cn')
      )
    } catch {
      return false
    }
  }, [url])

  useEffect(() => {
    if (!isBilibiliInput) return
    let active = true
    void window.framekit
      .getBilibiliAuthStatus()
      .then((loggedIn) => {
        if (active) setBilibiliLoggedIn(loggedIn)
      })
      .catch(() => {
        if (active) setBilibiliLoggedIn(false)
      })
    return () => {
      active = false
    }
  }, [isBilibiliInput])

  useEffect(() => {
    if (!isAigeiInput) return
    let active = true
    void window.framekit
      .getAigeiAuthStatus()
      .then((loggedIn) => {
        if (active) setAigeiLoggedIn(loggedIn)
      })
      .catch(() => {
        if (active) setAigeiLoggedIn(false)
      })
    return () => {
      active = false
    }
  }, [isAigeiInput])

  useEffect(() => {
    if (!isDouyinInput) return
    let active = true
    void window.framekit
      .getDouyinAuthStatus()
      .then((loggedIn) => {
        if (active) setDouyinLoggedIn(loggedIn)
      })
      .catch(() => {
        if (active) setDouyinLoggedIn(false)
      })
    return () => {
      active = false
    }
  }, [isDouyinInput])

  useEffect(() => {
    if (!isWeiboInput) return
    let active = true
    void window.framekit
      .getWeiboAuthStatus?.()
      .then((loggedIn) => {
        if (active) setWeiboLoggedIn(Boolean(loggedIn))
      })
      .catch(() => {
        if (active) setWeiboLoggedIn(false)
      })
    return () => {
      active = false
    }
  }, [isWeiboInput])

  useEffect(() => {
    try {
      if (destination) localStorage.setItem(SAVE_PATH_KEY, destination)
    } catch {
      // The browser storage is optional; the selected folder still works for this session.
    }
  }, [destination])

  useEffect(() => {
    return window.framekit.onParseProgress((nextProgress) => {
      setProgress(nextProgress)
    })
  }, [])

  useEffect(() => {
    return window.framekit.onDownloadProgress((nextProgress) => {
      if (removedDownloadIds.current.has(nextProgress.id)) return
      setDownloads((current) => {
        const index = current.findIndex((task) => task.id === nextProgress.id)
        if (index === -1) return [nextProgress, ...current]
        const updated = [...current]
        updated[index] = nextProgress
        return updated
      })
    })
  }, [])

  useEffect(() => {
    const subscribe = window.framekit.onUpdateProgress
    if (typeof subscribe !== 'function') return
    return subscribe((state) => {
      setUpdateDownload(state)
      if (state.phase === 'downloaded') {
        notify('更新包已下载完成，重启应用即可完成安装', 'success')
      } else if (state.phase === 'error') {
        notify(state.message || '更新下载失败', 'error')
      }
    })
  }, [notify])

  useEffect(() => {
    const onCloseRequest = window.framekit.onCloseRequest
    if (typeof onCloseRequest !== 'function') return
    return onCloseRequest(() => setClosePromptOpen(true))
  }, [])

  useEffect(() => {
    const listDownloads = window.framekit.listDownloads
    if (typeof listDownloads !== 'function') return
    void listDownloads
      .call(window.framekit)
      .then((history) => {
        setDownloads((current) => {
          const known = new Set(current.map((task) => task.id))
          const restored = history.filter(
            (task) => !known.has(task.id) && !removedDownloadIds.current.has(task.id)
          )
          return [...current, ...restored]
        })
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    downloadsRef.current = downloads
  }, [downloads])

  useEffect(() => {
    if (!queueOpen) return
    const verifyDownloads = window.framekit.verifyDownloads
    if (typeof verifyDownloads !== 'function') return
    let cancelled = false

    const verify = async (): Promise<void> => {
      const ids = downloadsRef.current
        .filter((task) => task.status === 'done' && task.filePath)
        .map((task) => task.id)
      if (ids.length === 0) return
      const missing = await verifyDownloads
        .call(window.framekit, ids)
        .catch(() => [] as string[])
      if (cancelled) return
      const missingIds = new Set(missing)
      setDownloads((current) => {
        let changed = false
        const next = current.map((task) => {
          if (task.status !== 'done' || !task.filePath) return task
          const isMissing = missingIds.has(task.id)
          if (Boolean(task.fileMissing) === isMissing) return task
          changed = true
          return { ...task, fileMissing: isMissing }
        })
        return changed ? next : current
      })
    }

    void verify()
    const timer = window.setInterval(() => void verify(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [queueOpen])

  const chooseDirectory = useCallback(async (): Promise<string | null> => {
    try {
      const chosen = await window.framekit.chooseDirectory()
      if (chosen) {
        setDestination(chosen)
        notify('素材保存目录已更新', 'success')
      }
      return chosen
    } catch (chooseError) {
      notify(errorMessage(chooseError), 'error')
      return null
    }
  }, [notify])

  const handleParse = async (): Promise<void> => {
    const trimmed = url.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setError(null)
    setResult(null)
    setSelected(new Set())
    setPreview(null)
    setProgress({ stage: 'fetch', message: '正在准备解析…', percent: 2 })
    try {
      const parsed = await window.framekit.parsePage(trimmed, { deep })
      setResult(parsed)
      setFilter('all')
      setQuery('')
      if (parsed.resources.length === 0) {
        notify('没有发现可下载资源，可以尝试深度嗅探', 'info')
      } else {
        notify(`发现 ${parsed.resources.length} 项资源`, 'success')
      }
    } catch (parseError) {
      const message = errorMessage(parseError)
      setError(message)
      notify(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handlePaste = async (): Promise<void> => {
    try {
      const text = await window.framekit.readClipboard()
      if (!text.trim()) {
        notify('剪贴板里没有文本', 'info')
        return
      }
      const matchingUrl = text.match(/https?:\/\/[^\s"'<>]+/i)?.[0]
      setUrl(matchingUrl ?? text.trim())
    } catch (pasteError) {
      notify(errorMessage(pasteError), 'error')
    }
  }

  const handleCheckUpdates = useCallback(async (): Promise<void> => {
    setUpdateOpen(true)
    setUpdateChecking(true)
    setUpdateError(null)
    setUpdateDownload((current) => (current?.phase === 'error' ? null : current))
    // 更新设置按需读取；旧版本 preload 没有这个方法时静默跳过。
    void window.framekit
      .getUpdateSettings?.()
      .then((settings) => setUpdateSettings(settings ?? null))
      .catch(() => undefined)
    try {
      const info = await window.framekit.checkForUpdates()
      setUpdateResult(info)
      if (info.hasUpdate) notify(`发现新版本 v${info.latestVersion}`, 'success')
    } catch (checkError) {
      setUpdateResult(null)
      setUpdateError(errorMessage(checkError))
    } finally {
      setUpdateChecking(false)
    }
  }, [notify])

  const handleStartUpdate = useCallback(async (): Promise<void> => {
    const downloadUpdate = window.framekit.downloadUpdate
    if (typeof downloadUpdate !== 'function') {
      notify('请重启 FrameKit 后再更新', 'error')
      return
    }
    setUpdateDownload({
      phase: 'downloading',
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0
    })
    try {
      await downloadUpdate.call(window.framekit)
    } catch (downloadError) {
      const message = errorMessage(downloadError)
      setUpdateDownload({
        phase: 'error',
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
        message
      })
      notify(message, 'error')
    }
  }, [notify])

  const handleInstallUpdate = useCallback(async (): Promise<void> => {
    const installUpdate = window.framekit.installUpdate
    if (typeof installUpdate !== 'function') {
      notify('请重启 FrameKit 后再安装更新', 'error')
      return
    }
    try {
      await installUpdate.call(window.framekit)
    } catch (installError) {
      notify(errorMessage(installError), 'error')
    }
  }, [notify])

  const handleBilibiliLogin = useCallback(async (): Promise<void> => {
    if (bilibiliLoginBusy) return
    setBilibiliLoginBusy(true)
    try {
      const loggedIn = await window.framekit.loginBilibili()
      setBilibiliLoggedIn(loggedIn)
      notify(
        loggedIn ? 'Bilibili 登录成功，重新解析可获取更高清晰度' : 'Bilibili 登录未完成',
        loggedIn ? 'success' : 'info'
      )
    } catch (loginError) {
      notify(errorMessage(loginError), 'error')
    } finally {
      setBilibiliLoginBusy(false)
    }
  }, [bilibiliLoginBusy, notify])

  const handleAigeiLogin = useCallback(async (): Promise<void> => {
    if (aigeiLoginBusy) return
    setAigeiLoginBusy(true)
    try {
      const loggedIn = await window.framekit.loginAigei()
      setAigeiLoggedIn(loggedIn)
      notify(
        loggedIn
          ? '爱给网登录成功，重新解析可读取原片下载规格'
          : '爱给网登录未完成',
        loggedIn ? 'success' : 'info'
      )
    } catch (loginError) {
      notify(errorMessage(loginError), 'error')
    } finally {
      setAigeiLoginBusy(false)
    }
  }, [aigeiLoginBusy, notify])

  const handleDouyinLogin = useCallback(async (): Promise<void> => {
    if (douyinLoginBusy) return
    setDouyinLoginBusy(true)
    try {
      const loggedIn = await window.framekit.loginDouyin()
      setDouyinLoggedIn(loggedIn)
      notify(
        loggedIn ? '抖音登录成功，重新解析可读取账号可访问的视频' : '抖音登录未完成',
        loggedIn ? 'success' : 'info'
      )
    } catch (loginError) {
      notify(errorMessage(loginError), 'error')
    } finally {
      setDouyinLoginBusy(false)
    }
  }, [douyinLoginBusy, notify])

  const handleWeiboLogin = useCallback(async (): Promise<void> => {
    if (weiboLoginBusy) return
    const login = window.framekit.loginWeibo
    if (typeof login !== 'function') {
      notify('请重启 FrameKit 后再登录微博', 'error')
      return
    }
    setWeiboLoginBusy(true)
    try {
      const loggedIn = await login()
      setWeiboLoggedIn(loggedIn)
      notify(
        loggedIn ? '微博登录成功，重新解析可读取更多视频' : '微博登录未完成',
        loggedIn ? 'success' : 'info'
      )
    } catch (loginError) {
      notify(errorMessage(loginError), 'error')
    } finally {
      setWeiboLoginBusy(false)
    }
  }, [weiboLoginBusy, notify])

  const toggleResource = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const copyResource = async (resource: MediaResource): Promise<void> => {
    try {
      await window.framekit.copyText(resource.url)
      notify('资源直链已复制', 'success')
    } catch (copyError) {
      notify(errorMessage(copyError), 'error')
    }
  }

  const openExternal = async (targetUrl: string): Promise<void> => {
    try {
      await window.framekit.openExternal(targetUrl)
    } catch (openError) {
      notify(errorMessage(openError), 'error')
    }
  }

  const queueResources = useCallback(
    async (resources: MediaResource[], openQueue = true): Promise<void> => {
      const downloadable = resources.filter(
        (resource) => !resource.isStream || isHlsResource(resource)
      )
      const skipped = resources.length - downloadable.length
      if (downloadable.length === 0) {
        notify('该流媒体清单暂不支持直接下载', 'error')
        return
      }

      let targetDirectory = destination
      if (!targetDirectory) {
        targetDirectory = (await chooseDirectory()) ?? ''
        if (!targetDirectory) return
      }

      try {
        const response = await window.framekit.startDownloads(
          downloadable.map((resource) => ({
            id: resource.id,
            url: resource.url,
            filename: resource.filename,
            kind: resource.kind,
            pageUrl: resource.pageUrl,
            audioUrl: resource.audioUrl,
            audioMime: resource.audioMime,
            isStream: resource.isStream
          })),
          targetDirectory
        )
        if (openQueue) setQueueOpen(true)
        if (response.queued === 0) {
          notify('所选任务已经在下载队列中', 'info')
        } else {
          notify(
            skipped > 0
              ? `已加入 ${response.queued} 个下载任务，跳过 ${skipped} 个暂不支持的流媒体清单`
              : `已加入 ${response.queued} 个下载任务`,
            'success'
          )
        }
      } catch (downloadError) {
        notify(errorMessage(downloadError), 'error')
      }
    },
    [chooseDirectory, destination, notify]
  )

  const handleReveal = (filePath: string): void => {
    void window.framekit.revealFile(filePath)
  }

  const handleCancelDownload = (id: string): void => {
    void window.framekit.cancelDownload(id)
  }

  const closeQueue = useCallback(() => setQueueOpen(false), [])

  const handleCloseAction = useCallback(async (action: 'minimize' | 'quit'): Promise<void> => {
    const respondToClose = window.framekit.respondToClose
    if (typeof respondToClose !== 'function') {
      notify('请重启 FrameKit 后再关闭窗口', 'error')
      return
    }
    setClosePromptOpen(false)
    try {
      const handled = await respondToClose.call(window.framekit, action)
      if (!handled) {
        setClosePromptOpen(true)
        notify('当前窗口无法执行该操作', 'error')
      }
    } catch (closeError) {
      setClosePromptOpen(true)
      notify(errorMessage(closeError), 'error')
    }
  }, [notify])

  const cancelClosePrompt = useCallback(() => setClosePromptOpen(false), [])

  const handleRemoveDownload = useCallback(
    async (id: string): Promise<void> => {
      const removeDownload = window.framekit.removeDownload
      if (typeof removeDownload !== 'function') {
        notify('请重启 FrameKit 后再删除下载', 'error')
        return
      }
      removedDownloadIds.current.add(id)
      setDownloads((current) => current.filter((task) => task.id !== id))
      try {
        const result = await removeDownload.call(window.framekit, id)
        notify(result.deletedFile ? '已删除下载和文件' : '已从队列移除', 'success')
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },
    [notify]
  )

  const filteredResources = useMemo(() => {
    if (!result) return []
    const normalizedQuery = query.trim().toLowerCase()
    return result.resources.filter((resource) => {
      if (filter !== 'all' && resource.kind !== filter) return false
      if (!normalizedQuery) return true
      return [resource.label, resource.filename, resource.url, resource.mime, resource.extension]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery))
    })
  }, [filter, query, result])

  const selectedResources = useMemo(
    () => result?.resources.filter((resource) => selected.has(resource.id)) ?? [],
    [result, selected]
  )
  const selectedBytes = selectedResources.reduce((total, resource) => total + (resource.size ?? 0), 0)
  const allFilteredSelected =
    filteredResources.length > 0 && filteredResources.every((resource) => selected.has(resource.id))
  const activeDownloads = downloads.filter((task) =>
    ['queued', 'downloading'].includes(task.status)
  ).length

  const filterOptions: Array<{
    key: FilterKey
    label: string
    count: number
    icon: typeof Layers
  }> = result
    ? [
        { key: 'all', label: '全部', count: result.stats.total, icon: Layers },
        { key: 'image', label: '图片', count: result.stats.images, icon: ImageIcon },
        { key: 'video', label: '视频', count: result.stats.videos, icon: Film },
        { key: 'audio', label: '音频', count: result.stats.audios, icon: Music },
        { key: 'other', label: '其他', count: result.stats.others, icon: FileText }
      ]
    : []

  const downloadMenuLabel = activeDownloads > 0 ? `${activeDownloads} 个下载中` : '下载队列'
  const updateLabel =
    updateDownload?.phase === 'downloaded'
      ? '重启安装更新'
      : updateDownload?.phase === 'downloading'
        ? `更新中 ${updateDownload.percent}%`
        : updateResult?.hasUpdate
          ? `v${updateResult.latestVersion} 可用`
          : '检查更新'
  const platformClass = `platform-${window.framekit.platform}`

  return (
    <div className={`app-shell ${platformClass}`}>
      <header className="appbar">
        <div className="brand">
          <span className="brand-mark">
            <Film size={19} strokeWidth={1.8} />
          </span>
          <span className="brand-copy">
            <strong>FRAMEKIT</strong>
            <small>后期工具箱</small>
          </span>
        </div>
        <span className="appbar-divider" />
        <div className="appbar-context">
          <Layers size={14} />
          素材解析
          <span className="context-beta">BETA</span>
        </div>
        <div className="appbar-spacer" />
        <div className="appbar-actions">
          <button
            type="button"
            className={`appbar-button update-check-button${
              updateResult?.hasUpdate ||
              updateDownload?.phase === 'downloading' ||
              updateDownload?.phase === 'downloaded'
                ? ' has-update'
                : ''
            }`}
            onClick={() => void handleCheckUpdates()}
            title="检查 GitHub 上的最新正式版"
          >
            <RefreshCw
              size={15}
              className={updateChecking || updateDownload?.phase === 'downloading' ? 'spin' : ''}
            />
            <span>{updateLabel}</span>
          </button>
          <button
            type="button"
            className="appbar-button destination-top"
            onClick={() => void chooseDirectory()}
            title={destination || '选择素材保存目录'}
          >
            <FolderOpen size={15} />
            <span>{destination ? folderLabel(destination) : '选择保存目录'}</span>
          </button>
          <button
            type="button"
            className={`appbar-button queue-button${queueOpen ? ' is-active' : ''}`}
            onClick={() => setQueueOpen((current) => !current)}
            aria-expanded={queueOpen}
            aria-controls="download-queue"
          >
            <Download size={15} />
            <span>{downloadMenuLabel}</span>
            {activeDownloads > 0 && <b className="queue-badge">{activeDownloads}</b>}
          </button>
        </div>
      </header>

      <div className="workspace">
        <Sidebar version={appVersion} onCheckUpdates={() => void handleCheckUpdates()} />

        <main className="main-content">
          <section className={`hero${result ? ' is-compact' : ''}`}>
            <div className="hero-copy">
              <span className="hero-kicker">
                <span className="kicker-line" />
                MODULE 01 / ASSET EXTRACTOR
              </span>
              <h1>
                网页素材，
                <span>一网打尽。</span>
              </h1>
              <p>
                粘贴参考网页或素材站链接，自动提取可下载的图片、音频与视频。
                支持动态加载、CSS 背景与脚本内嵌资源。
              </p>
              <div className="hero-tags">
                <span>IMG</span>
                <span>AUDIO</span>
                <span>VIDEO</span>
                <span>HLS / DASH DETECT</span>
              </div>
            </div>
            <div className="hero-graphic" aria-hidden="true">
              <div className="graphic-grid" />
              <div className="graphic-frame frame-large">
                <span />
              </div>
              <div className="graphic-frame frame-small">
                <span />
              </div>
              <div className="graphic-scanline" />
              <div className="graphic-label label-top">FIND</div>
              <div className="graphic-label label-bottom">EXTRACT</div>
              <div className="graphic-counter">
                <b>01</b>
                <span>MEDIA<br />PARSER</span>
              </div>
            </div>
          </section>

          <section className="parser-panel">
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void handleParse()
              }}
            >
              <div className="url-field">
                <Globe size={20} strokeWidth={1.6} />
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="粘贴网页地址，例如 https://example.com/gallery"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoComplete="off"
                  aria-label="要解析的网页地址"
                />
                {url && !loading && (
                  <button
                    type="button"
                    className="clear-url"
                    onClick={() => setUrl('')}
                    aria-label="清空网址"
                  >
                    <X size={15} />
                  </button>
                )}
                <button type="button" className="paste-button" onClick={() => void handlePaste()}>
                  <Clipboard size={15} />
                  粘贴
                </button>
              </div>

              <div className="parser-options">
                <div className="parser-options-left">
                  <div className="mode-selector" role="group" aria-label="解析模式">
                    <button
                      type="button"
                      className={!deep ? 'is-active' : ''}
                      onClick={() => setDeep(false)}
                    >
                      <Zap size={16} />
                      <span>
                        <strong>快速扫描</strong>
                        <small>源码 + CSS + 元数据</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={deep ? 'is-active' : ''}
                      onClick={() => setDeep(true)}
                    >
                      <Globe size={16} />
                      <span>
                        <strong>深度嗅探</strong>
                        <small>执行脚本 + 网络监听</small>
                      </span>
                      <em>SLOW</em>
                    </button>
                </div>
                  {isBilibiliInput && (
                    <button
                      type="button"
                      className={`bilibili-login-button${bilibiliLoggedIn ? ' is-logged-in' : ''}`}
                      onClick={() => void handleBilibiliLogin()}
                      disabled={bilibiliLoginBusy}
                      title={
                        bilibiliLoggedIn
                          ? 'Bilibili 已登录；重新解析可获取账号清晰度'
                          : '登录 Bilibili，获取账号或大会员清晰度'
                      }
                    >
                      {bilibiliLoginBusy ? (
                        <Loader2 size={15} className="spin" />
                      ) : bilibiliLoggedIn ? (
                        <Check size={15} />
                      ) : (
                        <LogIn size={15} />
                      )}
                      {bilibiliLoggedIn ? 'B站已登录' : '登录 B站'}
                    </button>
                  )}
                  {isAigeiInput && (
                    <button
                      type="button"
                      className={`bilibili-login-button${aigeiLoggedIn ? ' is-logged-in' : ''}`}
                      onClick={() => void handleAigeiLogin()}
                      disabled={aigeiLoginBusy}
                      title={
                        aigeiLoggedIn
                          ? '爱给网已登录；重新解析可读取原片下载规格'
                          : '登录爱给网，按站点正常入口读取原片'
                      }
                    >
                      {aigeiLoginBusy ? (
                        <Loader2 size={15} className="spin" />
                      ) : aigeiLoggedIn ? (
                        <Check size={15} />
                      ) : (
                        <LogIn size={15} />
                      )}
                      {aigeiLoggedIn ? '爱给网已登录' : '登录爱给网'}
                    </button>
                  )}
                  {isDouyinInput && (
                    <button
                      type="button"
                      className={`bilibili-login-button${douyinLoggedIn ? ' is-logged-in' : ''}`}
                      onClick={() => void handleDouyinLogin()}
                      disabled={douyinLoginBusy}
                      title={
                        douyinLoggedIn
                          ? '抖音已登录；重新解析可读取账号可访问的视频'
                          : '登录抖音，处理需要登录或验证码的视频'
                      }
                    >
                      {douyinLoginBusy ? (
                        <Loader2 size={15} className="spin" />
                      ) : douyinLoggedIn ? (
                        <Check size={15} />
                      ) : (
                        <LogIn size={15} />
                      )}
                      {douyinLoggedIn ? '抖音已登录' : '登录抖音'}
                    </button>
                  )}
                  {isWeiboInput && (
                    <button
                      type="button"
                      className={`bilibili-login-button${weiboLoggedIn ? ' is-logged-in' : ''}`}
                      onClick={() => void handleWeiboLogin()}
                      disabled={weiboLoginBusy}
                      title={
                        weiboLoggedIn
                          ? '微博已登录；重新解析可读取仅登录可见的视频'
                          : '登录微博，处理仅登录可见或需要验证的视频'
                      }
                    >
                      {weiboLoginBusy ? (
                        <Loader2 size={15} className="spin" />
                      ) : weiboLoggedIn ? (
                        <Check size={15} />
                      ) : (
                        <LogIn size={15} />
                      )}
                      {weiboLoggedIn ? '微博已登录' : '登录微博'}
                    </button>
                  )}

                </div>

                <div className="parse-submit">
                  <span className="mode-hint">
                    {isBilibiliInput
                      ? 'Bilibili 会读取独立音轨并按账号权限列出清晰度'
                      : isAigeiInput
                        ? '爱给网登录后可读取原片；未登录只显示低清预览'
                        : isDouyinInput
                          ? '抖音会捕获独立音视频流；需要时可在应用内登录'
                        : isWeiboInput
                          ? '微博按视频 id 读取播放地址；登录后可看仅登录可见的内容'
                        : deep
                          ? '会启动内置浏览器，通常需要 5–15 秒'
                          : '速度最快，适合静态图和直链资源'}
                  </span>
                  <button
                    type="submit"
                    className="parse-button"
                    disabled={!url.trim() || loading}
                  >
                    {loading ? (
                      <>
                        <Loader2 size={18} className="spin" />
                        解析中
                      </>
                    ) : (
                      <>
                        <Search size={18} />
                        解析素材
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>

            {loading && progress && (
              <div className="parse-progress">
                <div className="parse-progress-head">
                  <span>
                    <Loader2 size={14} className="spin" />
                    {progress.message}
                  </span>
                  <strong>{Math.round(percentOf(progress.percent, 100))}%</strong>
                </div>
                <div className="parse-progress-track">
                  <i style={{ width: `${Math.max(2, progress.percent)}%` }} />
                </div>
                <div className="parse-steps">
                  {PROGRESS_STEPS.map((step) => (
                    <span
                      key={step.label}
                      className={progress.percent >= step.threshold ? 'is-reached' : ''}
                    >
                      {step.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {error && (
            <div className="error-banner">
              <AlertCircle size={17} />
              <div>
                <strong>解析没有完成</strong>
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => void handleParse()}>
                <RefreshCw size={14} />
                重试
              </button>
            </div>
          )}

          {!result && !loading && <EmptyState />}

          {result && (
            <section className="results">
              <div className="page-summary">
                <div className="page-favicon">
                  {result.favicon ? (
                    <img
                      src={result.favicon}
                      alt=""
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        event.currentTarget.style.display = 'none'
                      }}
                    />
                  ) : (
                    <Globe size={22} />
                  )}
                </div>
                <div className="page-summary-copy">
                  <div className="summary-kicker">
                    <span className={`mode-badge mode-${result.mode}`}>
                      {result.mode === 'deep' ? '深度嗅探' : '快速扫描'}
                    </span>
                    <span>{(result.elapsedMs / 1000).toFixed(1)}s</span>
                    <span>{hostOf(result.finalUrl)}</span>
                  </div>
                  <h2 title={result.title}>{result.title}</h2>
                  {result.description && <p>{result.description}</p>}
                </div>
                <div className="summary-stats">
                  <div>
                    <b>{result.stats.total}</b>
                    <span>资源</span>
                  </div>
                  <div>
                    <b>{formatBytes(result.stats.knownBytes)}</b>
                    <span>已知体积</span>
                  </div>
                </div>
                <div className="summary-actions">
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => void openExternal(result.finalUrl)}
                  >
                    <ExternalLink size={14} />
                    打开网页
                  </button>
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => void handleParse()}
                  >
                    <RefreshCw size={14} />
                    重新解析
                  </button>
                </div>
              </div>

              {result.warnings.length > 0 && (
                <div className="warning-list">
                  {result.warnings.map((warning) => (
                    <div key={warning}>
                      <AlertCircle size={15} />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="results-toolbar">
                <div className="filter-tabs">
                  {filterOptions.map((option) => {
                    const Icon = option.icon
                    return (
                      <button
                        key={option.key}
                        type="button"
                        className={filter === option.key ? 'is-active' : ''}
                        onClick={() => setFilter(option.key)}
                      >
                        <Icon size={15} />
                        {option.label}
                        <b>{option.count}</b>
                      </button>
                    )
                  })}
                </div>
                <div className="toolbar-spacer" />
                <label className="resource-search">
                  <Search size={15} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索文件名或类型"
                    aria-label="搜索资源"
                  />
                  {query && (
                    <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
                      <X size={14} />
                    </button>
                  )}
                </label>
              </div>

              {filteredResources.length > 0 && (
                <div className="selection-row">
                  <button
                    type="button"
                    className={`select-all${allFilteredSelected ? ' is-selected' : ''}`}
                    onClick={() => {
                      setSelected((current) => {
                        const next = new Set(current)
                        if (allFilteredSelected) {
                          for (const resource of filteredResources) next.delete(resource.id)
                        } else {
                          for (const resource of filteredResources) next.add(resource.id)
                        }
                        return next
                      })
                    }}
                  >
                    <span className="check-box">
                      {allFilteredSelected && <Check size={12} strokeWidth={3} />}
                    </span>
                    全选当前 {filteredResources.length} 项
                  </button>
                  <span className="selection-count">
                    {selected.size > 0 ? `已选择 ${selected.size} 项` : '双击卡片可预览'}
                  </span>
                  {selected.size > 0 && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setSelected(new Set())}
                    >
                      清空选择
                    </button>
                  )}
                </div>
              )}

              {filteredResources.length > 0 ? (
                <div className="resource-grid">
                  {filteredResources.map((resource) => (
                    <ResourceCard
                      key={resource.id}
                      resource={resource}
                      selected={selected.has(resource.id)}
                      onToggle={toggleResource}
                      onPreview={setPreview}
                      onDownload={(item) => void queueResources([item])}
                      onCopy={(item) => void copyResource(item)}
                    />
                  ))}
                </div>
              ) : (
                <div className="no-results">
                  <Search size={30} strokeWidth={1.3} />
                  <h3>{query ? '没有匹配的资源' : `没有${filter === 'all' ? '' : kindMeta[filter].label}资源`}</h3>
                  <p>{query ? '换一个关键词，或清空搜索条件。' : '切换筛选条件，或使用深度嗅探重新解析。'}</p>
                  {query && (
                    <button type="button" className="button ghost" onClick={() => setQuery('')}>
                      清空搜索
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      {selected.size > 0 && !preview && (
        <div className="bulk-bar">
          <div className="bulk-count">
            <span className="bulk-badge">{selected.size}</span>
            <div>
              <strong>已选择 {selected.size} 项素材</strong>
              <span>{selectedBytes > 0 ? `已知体积 ${formatBytes(selectedBytes)}` : '体积将在下载时探测'}</span>
            </div>
          </div>
          <div className="bulk-actions">
            <button
              type="button"
              className="bulk-folder"
              onClick={() => void chooseDirectory()}
              title={destination || '选择保存目录'}
            >
              <FolderOpen size={15} />
              {destination ? '更改目录' : '选择目录'}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => void queueResources(selectedResources)}
            >
              <Download size={16} />
              下载所选
            </button>
            <button
              type="button"
              className="bulk-close"
              onClick={() => setSelected(new Set())}
              aria-label="取消选择"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      <DownloadDrawer
        open={queueOpen}
        tasks={downloads}
        destination={destination}
        onClose={closeQueue}
        onChooseDirectory={() => void chooseDirectory()}
        onReveal={handleReveal}
        onCancel={handleCancelDownload}
        onRemove={(id) => void handleRemoveDownload(id)}
        onClearFinished={() => {
          setDownloads((current) =>
            current.filter((task) => ['queued', 'downloading'].includes(task.status))
          )
          const clearDownloads = window.framekit.clearDownloads
          if (typeof clearDownloads === 'function') {
            void clearDownloads.call(window.framekit)
          }
        }}
      />

      {preview && (
        <PreviewModal
          resource={preview}
          playbackResource={lowestQualityVariant(preview, result?.resources)}
          onClose={() => setPreview(null)}
          onDownload={(resource) => {
            setPreview(null)
            void queueResources([resource])
          }}
          onCopy={(resource) => void copyResource(resource)}
          onOpenExternal={(targetUrl) => void openExternal(targetUrl)}
        />
      )}

      {updateOpen && (
        <UpdateModal
          currentVersion={appVersion || updateResult?.currentVersion || '1.0.0'}
          result={updateResult}
          checking={updateChecking}
          error={updateError}
          downloadState={updateDownload}
          settings={updateSettings}
          onClose={() => setUpdateOpen(false)}
          onRetry={() => void handleCheckUpdates()}
          onStartUpdate={() => void handleStartUpdate()}
          onInstall={() => void handleInstallUpdate()}
          onDownloadInstaller={(targetUrl) => {
            void openExternal(targetUrl)
            notify('安装包下载已在浏览器中打开', 'success')
          }}
          onOpenRelease={(targetUrl) => void openExternal(targetUrl)}
          onSettingsSaved={(settings) => {
            setUpdateSettings(settings)
            notify('更新设置已保存', 'success')
          }}
        />
      )}

      {closePromptOpen && (
        <CloseConfirmModal
          activeDownloads={activeDownloads}
          onMinimize={() => void handleCloseAction('minimize')}
          onQuit={() => void handleCloseAction('quit')}
          onCancel={cancelClosePrompt}
        />
      )}

      {toast && (
        <div
          key={toast.id}
          className={`toast toast-${toast.tone}${queueOpen ? ' with-drawer' : ''}`}
          role="status"
        >
          <span className="toast-icon">
            {toast.tone === 'error' ? (
              <AlertCircle size={16} />
            ) : toast.tone === 'success' ? (
              <Check size={16} />
            ) : (
              <Zap size={16} />
            )}
          </span>
          {toast.message}
        </div>
      )}
    </div>
  )
}
