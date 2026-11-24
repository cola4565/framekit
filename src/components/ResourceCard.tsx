import { useEffect, useState } from 'react'
import {
  Check,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  Music,
  Play
} from 'lucide-react'
import type { MediaResource } from '../shared/types'
import {
  formatBytes,
  formatDuration,
  hostOf,
  kindMeta,
  sourceMeta
} from '../shared/format'
import { toPreviewUrl, toThumbnailUrl } from '../shared/media'

interface ResourceCardProps {
  resource: MediaResource
  selected: boolean
  onToggle: (id: string) => void
  onPreview: (resource: MediaResource) => void
  onDownload: (resource: MediaResource) => void
  onCopy: (resource: MediaResource) => void
}

function resourceMeta(resource: MediaResource): string[] {
  const parts: string[] = [resource.extension.toUpperCase()]
  if (resource.width && resource.height) parts.push(`${resource.width}×${resource.height}`)
  if (resource.duration) parts.push(formatDuration(resource.duration))
  if (resource.size) parts.push(formatBytes(resource.size))
  return parts
}

export default function ResourceCard({
  resource,
  selected,
  onToggle,
  onPreview,
  onDownload,
  onCopy
}: ResourceCardProps): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false)
  const [coverLoading, setCoverLoading] = useState(false)
  const isImage = resource.kind === 'image'
  const isVideo = resource.kind === 'video'
  const isAudio = resource.kind === 'audio'
  const posterSource = isImage
    ? resource.url
    : isVideo
      ? resource.poster
      : undefined
  const posterUrl = posterSource
    ? toPreviewUrl(posterSource, resource.pageUrl)
    : undefined
  const coverUrl =
    isVideo && !resource.poster && !resource.isStream
      ? toThumbnailUrl(resource.url, resource.pageUrl)
      : undefined
  const showCover = Boolean((posterUrl || coverUrl) && !imageFailed)

  useEffect(() => {
    setImageFailed(false)
    setCoverLoading(Boolean(coverUrl))
  }, [coverUrl, posterUrl])
  const width = resource.width && resource.height ? `${resource.width} × ${resource.height}` : ''

  return (
    <article
      className={`resource-card kind-${resource.kind}${selected ? ' is-selected' : ''}`}
      onDoubleClick={() => onPreview(resource)}
    >
      <button
        type="button"
        className={`select-dot${selected ? ' is-selected' : ''}`}
        aria-label={selected ? '取消选择' : '选择资源'}
        aria-pressed={selected}
        onClick={() => onToggle(resource.id)}
      >
        {selected && <Check size={12} strokeWidth={3} />}
      </button>

      <button
        type="button"
        className="resource-thumb"
        onClick={() => onPreview(resource)}
        aria-label={`预览 ${resource.label || resource.filename}`}
      >
        {showCover ? (
          <img
            src={posterUrl ?? coverUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onLoad={() => setCoverLoading(false)}
            onError={() => {
              setImageFailed(true)
              setCoverLoading(false)
            }}
          />
        ) : coverLoading ? (
          <div className="file-visual is-loading" aria-hidden="true">
            <Loader2 size={30} strokeWidth={1.4} className="spin" />
            <span>生成封面</span>
          </div>
        ) : isAudio ? (
          <div className="audio-visual" aria-hidden="true">
            <Music size={32} strokeWidth={1.4} />
            <div className="waveform">
              {Array.from({ length: 22 }, (_, index) => (
                <i
                  key={index}
                  style={{ height: `${18 + ((index * 17) % 46)}%` }}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="file-visual" aria-hidden="true">
            <FileText size={34} strokeWidth={1.3} />
            <span>{resource.extension.toUpperCase()}</span>
          </div>
        )}

        <span className={`kind-chip kind-${resource.kind}`}>
          {isImage ? (
            <ImageIcon size={12} />
          ) : isVideo ? (
            <Play size={12} />
          ) : isAudio ? (
            <Music size={12} />
          ) : (
            <FileText size={12} />
          )}
          {kindMeta[resource.kind].label}
        </span>

        {isVideo && (
          <span className="play-overlay" aria-hidden="true">
            <Play size={20} fill="currentColor" />
          </span>
        )}
        {resource.isStream && <span className="stream-chip">HLS / DASH</span>}
        {resource.mergeAudio && <span className="audio-merge-chip">+ AUDIO</span>}
        {width && isImage && <span className="dimension-chip">{width}</span>}
      </button>

      <div className="resource-body">
        <div className="resource-heading">
          <h3 title={resource.label || resource.filename}>
            {resource.label || resource.filename}
          </h3>
          <span className="extension-pill">.{resource.extension}</span>
        </div>
        <div className="resource-meta">
          {resourceMeta(resource).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <div className="resource-foot">
          <span className={`source-dot source-${resource.source}`} />
          <span className="resource-source" title={resource.discoveryLabel}>
            {sourceMeta[resource.source]} · {hostOf(resource.url)}
          </span>
          {resource.mime && <span className="mime-tag">{resource.mime}</span>}
        </div>
      </div>

      <div className="resource-actions">
        <button
          type="button"
          className="icon-button"
          title="复制资源直链"
          onClick={() => onCopy(resource)}
        >
          <Copy size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="预览"
          onClick={() => onPreview(resource)}
        >
          <Play size={15} />
        </button>
        <button
          type="button"
          className="download-mini"
          title={resource.isStream ? '流媒体清单需要转码或专用下载器' : '下载此资源'}
          disabled={resource.isStream}
          onClick={() => onDownload(resource)}
        >
          <Download size={15} />
          下载
        </button>
      </div>
    </article>
  )
}
