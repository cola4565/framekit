import { useEffect } from 'react'
import {
  Download,
  ExternalLink,
  FileText,
  Music,
  X
} from 'lucide-react'
import type { MediaResource } from '../shared/types'
import { formatBytes, formatDuration, kindMeta, sourceMeta } from '../shared/format'

interface PreviewModalProps {
  resource: MediaResource
  onClose: () => void
  onDownload: (resource: MediaResource) => void
  onCopy: (resource: MediaResource) => void
  onOpenExternal: (url: string) => void
}

export default function PreviewModal({
  resource,
  onClose,
  onDownload,
  onCopy,
  onOpenExternal
}: PreviewModalProps): React.JSX.Element {
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

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label="资源预览"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="preview-header">
          <div>
            <span className="preview-kicker">
              {kindMeta[resource.kind].label}预览 · {sourceMeta[resource.source]}
            </span>
            <h2>{resource.label || resource.filename}</h2>
          </div>
          <button type="button" className="icon-button large" onClick={onClose} aria-label="关闭预览">
            <X size={18} />
          </button>
        </header>

        <div className={`preview-stage kind-${resource.kind}`}>
          {resource.kind === 'image' && (
            <img src={resource.url} alt={resource.label || resource.filename} referrerPolicy="no-referrer" />
          )}
          {resource.kind === 'video' && !resource.isStream && (
            <video
              src={resource.url}
              poster={resource.poster}
              controls
              autoPlay
              playsInline
            />
          )}
          {resource.kind === 'audio' && !resource.isStream && (
            <div className="audio-preview">
              <div className="audio-record">
                <Music size={54} strokeWidth={1.2} />
              </div>
              <div className="audio-wave-large" aria-hidden="true">
                {Array.from({ length: 52 }, (_, index) => (
                  <i key={index} style={{ height: `${15 + ((index * 29) % 75)}%` }} />
                ))}
              </div>
              <audio src={resource.url} controls autoPlay />
            </div>
          )}
          {(resource.isStream || resource.kind === 'other') && (
            <div className="preview-fallback">
              <FileText size={48} strokeWidth={1.2} />
              <h3>{resource.isStream ? '这是流媒体清单，不是完整成片' : '此类型没有内置预览'}</h3>
              <p>
                {resource.isStream
                  ? 'HLS / DASH 需要下载分片并重新封装。当前版本可以先复制地址，后续转码模块会支持合并。'
                  : '可以复制直链，或直接在系统浏览器中打开查看。'}
              </p>
            </div>
          )}
        </div>

        <footer className="preview-footer">
          <div className="preview-details">
            <span>.{resource.extension}</span>
            {resource.width && resource.height && (
              <span>
                {resource.width} × {resource.height}
              </span>
            )}
            {resource.duration && <span>{formatDuration(resource.duration)}</span>}
            {resource.size && <span>{formatBytes(resource.size)}</span>}
            {resource.mime && <span>{resource.mime}</span>}
          </div>
          <div className="preview-actions">
            <button type="button" className="button ghost" onClick={() => onOpenExternal(resource.url)}>
              <ExternalLink size={15} />
              浏览器打开
            </button>
            <button type="button" className="button ghost" onClick={() => onCopy(resource)}>
              复制直链
            </button>
            <button
              type="button"
              className="button primary"
              disabled={resource.isStream}
              onClick={() => onDownload(resource)}
            >
              <Download size={15} />
              下载素材
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
