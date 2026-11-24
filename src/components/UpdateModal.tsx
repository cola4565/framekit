import { useEffect } from 'react'
import {
  AlertCircle,
  ArrowDownToLine,
  CircleCheck,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCw,
  Sparkles,
  X
} from 'lucide-react'
import type { UpdateCheckResult, UpdateDownloadState } from '../shared/types'
import { formatBytes, formatSpeed } from '../shared/format'

interface UpdateModalProps {
  currentVersion: string
  result: UpdateCheckResult | null
  checking: boolean
  error: string | null
  downloadState: UpdateDownloadState | null
  onClose: () => void
  onRetry: () => void
  onStartUpdate: () => void
  onInstall: () => void
  onDownloadInstaller: (url: string) => void
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
  downloadState,
  onClose,
  onRetry,
  onStartUpdate,
  onInstall,
  onDownloadInstaller,
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
  const canAutoUpdate = Boolean(result?.canAutoUpdate)
  const phase = downloadState?.phase ?? null
  const busy = phase === 'downloading'
  const ready = phase === 'downloaded'
  const failed = phase === 'error'
  const percent = Math.max(0, Math.min(100, downloadState?.percent ?? 0))
  const manualOnly = hasUpdate && !canAutoUpdate

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
              <RefreshCw size={19} className={checking || busy ? 'spin' : ''} />
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
              {manualOnly && (
                <p className="update-manual-hint">
                  {window.framekit.platform === 'darwin'
                    ? 'macOS 应用内静默安装需要 Apple 开发者签名与公证；当前请下载 DMG 覆盖安装。'
                    : '当前构建暂不支持应用内安装，请下载安装包。安装此版本后，后续更新将自动静默完成。'}
                </p>
              )}
            </div>
          )}

          {!checking && !error && hasUpdate && canAutoUpdate && downloadState && (
            <div className={`update-progress is-${downloadState.phase}`} aria-live="polite">
              {busy && (
                <>
                  <div className="update-progress-head">
                    <span>
                      <ArrowDownToLine size={13} />
                      正在后台下载更新包
                    </span>
                    <strong>{percent}%</strong>
                  </div>
                  <div className="update-progress-track">
                    <i style={{ width: `${percent}%` }} />
                  </div>
                  <small>
                    {formatBytes(downloadState.transferred)} / {formatBytes(downloadState.total)}
                    {formatSpeed(downloadState.bytesPerSecond)
                      ? ` · ${formatSpeed(downloadState.bytesPerSecond)}`
                      : ''}
                  </small>
                  <p>下载完成后点击“重启并安装”即可，安装过程不会打开向导，也不需要选择安装位置。</p>
                </>
              )}

              {ready && (
                <div className="update-ready-row">
                  <CircleCheck size={20} />
                  <div>
                    <strong>更新包已就绪</strong>
                    <span>点击“重启并安装”，FrameKit 会自动完成安装并重新启动。</span>
                  </div>
                </div>
              )}

              {failed && (
                <div className="update-ready-row is-error">
                  <AlertCircle size={20} />
                  <div>
                    <strong>更新下载失败</strong>
                    <span>{downloadState.message || '请检查网络后重试。'}</span>
                  </div>
                </div>
              )}
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
            {!checking && !busy && (
              <button type="button" className="button ghost" onClick={onRetry}>
                <RefreshCw size={14} />
                重新检查
              </button>
            )}
            {!checking && hasUpdate && canAutoUpdate ? (
              ready ? (
                <button type="button" className="button primary" onClick={onInstall}>
                  <RotateCw size={15} />
                  重启并安装
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  onClick={onStartUpdate}
                  disabled={busy}
                >
                  {busy ? <Loader2 size={15} className="spin" /> : <ArrowDownToLine size={15} />}
                  {busy ? `正在下载 ${percent}%` : failed ? '重试更新' : '立即更新'}
                </button>
              )
            ) : manualOnly && result?.downloadUrl ? (
              <button
                type="button"
                className="button primary"
                onClick={() => onDownloadInstaller(result.downloadUrl as string)}
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
