import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Download,
  FolderOpen,
  List,
  Trash2,
  X
} from 'lucide-react'
import type { DownloadProgress } from '../shared/types'
import { formatBytes, formatSpeed, kindMeta, percentOf } from '../shared/format'

const DRAWER_EXIT_MS = 220

interface DownloadDrawerProps {
  open: boolean
  tasks: DownloadProgress[]
  destination: string
  onClose: () => void
  onChooseDirectory: () => void
  onReveal: (filePath: string) => void
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onClearFinished: () => void
}

function statusLabel(task: DownloadProgress): string {
  if (task.fileMissing) return '文件已在磁盘上删除'
  if (task.status === 'queued') return '等待中'
  if (task.status === 'downloading') {
    if (task.phase === 'merge') return task.message || '正在合并音视频…'
    return task.total
      ? `${formatBytes(task.received)} / ${formatBytes(task.total)}`
      : formatBytes(task.received)
  }
  if (task.status === 'done') return formatBytes(task.received)
  if (task.status === 'canceled') return '已取消'
  return task.error || '下载失败'
}

export default function DownloadDrawer({
  open,
  tasks,
  destination,
  onClose,
  onChooseDirectory,
  onReveal,
  onCancel,
  onRemove,
  onClearFinished
}: DownloadDrawerProps): React.JSX.Element | null {
  const drawerRef = useRef<HTMLElement>(null)
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    setClosing(true)
    const timer = window.setTimeout(() => setMounted(false), DRAWER_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const focusFrame = window.requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [onClose, open])

  if (!mounted) return null
  const activeCount = tasks.filter((task) => ['queued', 'downloading'].includes(task.status)).length
  const finishedCount = tasks.length - activeCount

  return (
    <>
      <div
        className={`drawer-scrim${closing ? ' is-closing' : ''}`}
        onClick={onClose}
        role="presentation"
      />
      <aside
        ref={drawerRef}
        id="download-queue"
        className={`download-drawer${closing ? ' is-closing' : ''}`}
        aria-label="下载队列"
        role="dialog"
        aria-modal="true"
      >
        <header className="drawer-header">
          <div className="drawer-title">
            <span className="drawer-icon">
              <List size={18} />
            </span>
            <div>
              <h2>下载队列</h2>
              <p>{activeCount > 0 ? `${activeCount} 个任务进行中` : '所有任务已处理'}</p>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭下载队列">
            <X size={17} />
          </button>
        </header>

        {tasks.length === 0 ? (
          <div className="drawer-empty">
            <Download size={34} strokeWidth={1.3} />
            <h3>还没有下载任务</h3>
            <p>选择解析结果中的素材，点击下载后会出现在这里。</p>
          </div>
        ) : (
          <div className="queue-list">
            {tasks.map((task) => {
              const percent = percentOf(task.received, task.total)
              return (
                <article
                  key={`${task.id}-${task.startedAt ?? 'queued'}`}
                  className={`queue-item status-${task.status}${task.fileMissing ? ' is-missing' : ''}`}
                >
                  <div className={`queue-kind kind-${task.kind}`}>
                    {task.status === 'done' ? (
                      <Check size={17} />
                    ) : task.status === 'error' ? (
                      <AlertCircle size={17} />
                    ) : (
                      <Download size={17} />
                    )}
                  </div>
                  <div className="queue-main">
                    <div className="queue-heading">
                      <h3 title={task.filename}>{task.filename}</h3>
                      <span>{kindMeta[task.kind].short}</span>
                    </div>
                    <div className="queue-progress">
                      <div
                        className="queue-progress-bar"
                        style={{ width: `${task.status === 'done' ? 100 : percent}%` }}
                      />
                    </div>
                    <div className="queue-status">
                      <span className={task.status === 'error' ? 'error-text' : ''}>
                        {statusLabel(task)}
                      </span>
                      {task.status === 'downloading' && task.phase !== 'merge' && (
                        <span>{formatSpeed(task.speed)}</span>
                      )}
                    </div>
                  </div>
                  <div className="queue-actions">
                    {task.status === 'downloading' || task.status === 'queued' ? (
                      <button
                        type="button"
                        className="text-button danger"
                        onClick={() => onCancel(task.id)}
                      >
                        取消
                      </button>
                    ) : null}
                    {task.status !== 'downloading' &&
                      task.status !== 'queued' &&
                      task.filePath &&
                      !task.fileMissing && (
                        <button
                          type="button"
                          className="icon-button"
                          title="在文件夹中显示"
                          onClick={() => onReveal(task.filePath!)}
                        >
                          <FolderOpen size={16} />
                        </button>
                      )}
                    <button
                      type="button"
                      className="icon-button danger"
                      title={task.fileMissing ? '移除这条记录' : '从队列删除并删除文件'}
                      aria-label="删除下载和文件"
                      onClick={() => onRemove(task.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}

        <footer className="drawer-footer">
          <button type="button" className="destination-row" onClick={onChooseDirectory}>
            <FolderOpen size={16} />
            <span>
              <small>保存位置</small>
              <strong title={destination || '尚未选择目录'}>
                {destination || '点击选择素材目录'}
              </strong>
            </span>
          </button>
          {finishedCount > 0 && (
            <button
              type="button"
              className="text-button"
              title="只清空列表记录，不删除已下载文件"
              onClick={onClearFinished}
            >
              <Trash2 size={14} />
              清空列表
            </button>
          )}
        </footer>
      </aside>
    </>
  )
}
