import { useEffect } from 'react'
import {
  AlertCircle,
  ArrowDownToLine,
  CircleCheck,
  ExternalLink,
  Loader2,
  RefreshCw,
  Sparkles,
  X
} from 'lucide-react'
import type { UpdateCheckResult } from '../shared/types'

interface UpdateModalProps {
  currentVersion: string
  result: UpdateCheckResult | null
  checking: boolean
  error: string | null
  onClose: () => void
  onRetry: () => void
  onDownload: (url: string) => void
  onOpenRelease: (url: string) => void
}

function releaseDate(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

function packageLabel(): string {
  if (window.framekit.platform === 'darwin') return 'macOS 安装包'
  if (window.framekit.platform === 'win32') return 'Windows 安装包'
  return '安装包'
}

export default function UpdateModal({
  currentVersion,
  result,
  checking,
  error,
  onClose,
  onRetry,
  onDownload,
  onOpenRelease
}: UpdateModalProps): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    document.body.classList.add('modal-open')
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('modal-open')
    }
  }, [onClose])

  const hasUpdate = Boolean(result?.hasUpdate)
  const published = result ? releaseDate(result.publishedAt) : ''

  return (
    <div className="modal-backdrop update-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="update-modal"
        role="dialog"
        aria-modal="true"
        aria-label="检查更新"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="update-header">
          <div className="update-heading">
            <span className={`update-mark${hasUpdate ? ' has-update' : ''}`}>
              <RefreshCw size={19} className={checking ? 'spin' : ''} />
            </span>
            <div>
              <span className="update-kicker">RELEASE CHANNEL / STABLE</span>
              <h2>软件更新</h2>
            </div>
          </div>
          <button type="button" className="icon-button large" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="update-body">
          <div className="update-version-board">
            <div>
              <span>当前版本</span>
              <strong>v{currentVersion || '—'}</strong>
            </div>
            <span className="update-version-line" />
            <div className={hasUpdate ? 'is-latest' : ''}>
              <span>最新正式版</span>
              <strong>{result ? `v${result.latestVersion}` : '检查中'}</strong>
            </div>
          </div>

          {checking && (
            <div className="update-state">
              <Loader2 size={30} className="spin" />
              <h3>正在连接 GitHub Releases</h3>
              <p>读取最新正式版本与安装包信息…</p>
            </div>
          )}

          {!checking && error && (
            <div className="update-state is-error">
              <AlertCircle size={30} />
              <h3>暂时无法检查更新</h3>
              <p>{error}</p>
              <button type="button" className="button ghost" onClick={onRetry}>
                <RefreshCw size={14} />
                重新检查
              </button>
            </div>
          )}

          {!checking && !error && result && !hasUpdate && (
            <div className="update-state is-current">
              <CircleCheck size={34} />
              <h3>当前已是最新正式版</h3>
              <p>
                你正在使用 FrameKit v{result.currentVersion}，无需更新。
                {published && ` 最新版本发布于 ${published}。`}
              </p>
            </div>
          )}

          {!checking && !error && result && hasUpdate && (
            <div className="update-release">
              <div className="update-release-title">
                <span>
                  <Sparkles size={16} />
                  发现新版本
                </span>
                <strong>v{result.latestVersion}</strong>
                {published && <small>{published}</small>}
              </div>
              <div className="update-notes">
                <span>更新说明</span>
                <div>{result.releaseNotes || '本次正式版暂未提供详细更新说明。'}</div>
              </div>
            </div>
          )}
        </div>

        <footer className="update-footer">
          <span className="update-source">GitHub · {result?.releaseTag || 'latest release'}</span>
          <div className="update-actions">
            {result && (
              <button
                type="button"
                className="button ghost"
                onClick={() => onOpenRelease(result.releaseUrl)}
              >
                <ExternalLink size={14} />
                发布页
              </button>
            )}
            {!checking && (
              <button type="button" className="button ghost" onClick={onRetry}>
                <RefreshCw size={14} />
                重新检查
              </button>
            )}
            {result && hasUpdate && result.downloadUrl ? (
              <button
                type="button"
                className="button primary"
                onClick={() => onDownload(result.downloadUrl as string)}
              >
                <ArrowDownToLine size={15} />
                下载 {packageLabel()}
              </button>
            ) : (
              !checking && (
                <button type="button" className="button primary" onClick={onClose}>
                  完成
                </button>
              )
            )}
          </div>
        </footer>
      </section>
    </div>
  )
}
