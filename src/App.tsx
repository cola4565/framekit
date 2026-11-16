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
  Music,
  RefreshCw,
  Search,
  X,
  Zap
} from 'lucide-react'
import DownloadDrawer from './components/DownloadDrawer'
import EmptyState from './components/EmptyState'
import PreviewModal from './components/PreviewModal'
import ResourceCard from './components/ResourceCard'
import Sidebar from './components/Sidebar'
import type {
  DownloadProgress,
  MediaResource,
  ParseProgress,
  ParseResult,
  ResourceKind
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
  const [downloads, setDownloads] = useState<DownloadProgress[]>([])
  const [toast, setToast] = useState<ToastState | null>(null)
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
      setDownloads((current) => {
        const index = current.findIndex((task) => task.id === nextProgress.id)
        if (index === -1) return [nextProgress, ...current]
        const updated = [...current]
        updated[index] = nextProgress
        return updated
      })
    })
  }, [])

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
      const downloadable = resources.filter((resource) => !resource.isStream)
      const skipped = resources.length - downloadable.length
      if (downloadable.length === 0) {
        notify('HLS / DASH 清单不能直接作为成片下载', 'error')
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
            pageUrl: resource.pageUrl
          })),
          targetDirectory
        )
        if (openQueue) setQueueOpen(true)
        if (response.queued === 0) {
          notify('所选任务已经在下载队列中', 'info')
        } else {
          notify(
            skipped > 0
              ? `已加入 ${response.queued} 个下载任务，跳过 ${skipped} 个流媒体清单`
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
            className="appbar-button destination-top"
            onClick={() => void chooseDirectory()}
            title={destination || '选择素材保存目录'}
          >
            <FolderOpen size={15} />
            <span>{destination ? folderLabel(destination) : '选择保存目录'}</span>
          </button>
          <button
            type="button"
            className={`appbar-button${queueOpen ? ' is-active' : ''}`}
            onClick={() => setQueueOpen(true)}
          >
            <Download size={15} />
            <span>{downloadMenuLabel}</span>
            {downloads.length > 0 && <b>{downloads.length}</b>}
          </button>
        </div>
      </header>

      <div className="workspace">
        <Sidebar />

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

                <div className="parse-submit">
                  <span className="mode-hint">
                    {deep ? '会启动内置浏览器，通常需要 5–15 秒' : '速度最快，适合静态图和直链资源'}
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
        onClose={() => setQueueOpen(false)}
        onChooseDirectory={() => void chooseDirectory()}
        onReveal={handleReveal}
        onCancel={handleCancelDownload}
        onClearFinished={() =>
          setDownloads((current) =>
            current.filter((task) => ['queued', 'downloading'].includes(task.status))
          )
        }
      />

      {preview && (
        <PreviewModal
          resource={preview}
          onClose={() => setPreview(null)}
          onDownload={(resource) => {
            setPreview(null)
            void queueResources([resource])
          }}
          onCopy={(resource) => void copyResource(resource)}
          onOpenExternal={(targetUrl) => void openExternal(targetUrl)}
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
