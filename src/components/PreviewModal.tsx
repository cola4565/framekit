import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  ExternalLink,
  FileText,
  Music,
  X
} from 'lucide-react'
import type { MediaResource } from '../shared/types'
import { formatBytes, formatDuration, kindMeta, sourceMeta } from '../shared/format'
import { toPreviewUrl } from '../shared/media'

interface PreviewModalProps {
  resource: MediaResource
  playbackResource?: MediaResource
  onClose: () => void
  onDownload: (resource: MediaResource) => void
  onCopy: (resource: MediaResource) => void
  onOpenExternal: (url: string) => void
}

export default function PreviewModal({
  resource,
  playbackResource,
  onClose,
  onDownload,
  onCopy,
  onOpenExternal
}: PreviewModalProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [mediaError, setMediaError] = useState(false)
  const playback = playbackResource ?? resource

  const videoSrc = useMemo(
    () => toPreviewUrl(playback.url, playback.pageUrl),
    [playback.url, playback.pageUrl]
  )
  const audioSrc = useMemo(
    () => (playback.audioUrl ? toPreviewUrl(playback.audioUrl, playback.pageUrl) : undefined),
    [playback.audioUrl, playback.pageUrl]
  )
  const posterSrc = useMemo(
    () => (playback.poster ? toPreviewUrl(playback.poster, playback.pageUrl) : undefined),
    [playback.poster, playback.pageUrl]
  )

  useEffect(() => {
    setMediaError(false)
  }, [resource.id])

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

  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!playback.audioUrl || !video || !audio) return

    const syncTime = (): void => {
      if (Math.abs(audio.currentTime - video.currentTime) > 0.25) {
        audio.currentTime = video.currentTime
      }
    }
    const syncVolume = (): void => {
      audio.volume = video.volume
      audio.muted = video.muted
    }
    const playAudio = (): void => {
      syncTime()
      syncVolume()
      audio.playbackRate = video.playbackRate
      void audio.play().catch(() => undefined)
    }
    const pauseAudio = (): void => {
      audio.pause()
    }
    const seekAudio = (): void => {
      syncTime()
    }
    const rateAudio = (): void => {
      audio.playbackRate = video.playbackRate
    }
    const endAudio = (): void => {
      audio.pause()
    }

    video.addEventListener('play', playAudio)
    video.addEventListener('pause', pauseAudio)
    video.addEventListener('seeking', seekAudio)
    video.addEventListener('seeked', seekAudio)
    video.addEventListener('timeupdate', syncTime)
    video.addEventListener('volumechange', syncVolume)
    video.addEventListener('ratechange', rateAudio)
    video.addEventListener('ended', endAudio)
    if (!video.paused) playAudio()

    return () => {
      video.removeEventListener('play', playAudio)
      video.removeEventListener('pause', pauseAudio)
      video.removeEventListener('seeking', seekAudio)
      video.removeEventListener('seeked', seekAudio)
      video.removeEventListener('timeupdate', syncTime)
      video.removeEventListener('volumechange', syncVolume)
      video.removeEventListener('ratechange', rateAudio)
      video.removeEventListener('ended', endAudio)
      audio.pause()
    }
  }, [playback.audioUrl, playback.url])

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
            <img
              src={toPreviewUrl(resource.url, resource.pageUrl)}
              alt={resource.label || resource.filename}
              referrerPolicy="no-referrer"
            />
          )}
          {resource.kind === 'video' && !resource.isStream && (
            <video
              ref={videoRef}
              src={videoSrc}
              poster={posterSrc}
              controls
              autoPlay
              playsInline
              onError={() => setMediaError(true)}
            />
          )}
          {resource.kind === 'video' && !resource.isStream && playback.audioUrl && (
            <audio ref={audioRef} src={audioSrc} preload="auto" hidden />
          )}
          {resource.kind === 'video' && !resource.isStream && mediaError && (
            <div className="preview-fallback">
              <FileText size={48} strokeWidth={1.2} />
              <h3>当前直链无法直接播放</h3>
              <p>该链接可能已过期或存在防盗链限制。可以先下载，合并后会生成可播放的 MP4。</p>
            </div>
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
              <audio src={toPreviewUrl(resource.url, resource.pageUrl)} controls autoPlay />
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
            {playback !== resource && playback.qualityLabel && (
              <span className="preview-quality-hint">
                预览 {playback.qualityLabel} · 下载 {resource.qualityLabel ?? '当前所选'}
              </span>
            )}
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
