import { useEffect, useRef } from 'react'
import { Minus, Power, X } from 'lucide-react'

interface CloseConfirmModalProps {
  activeDownloads: number
  onMinimize: () => void
  onQuit: () => void
  onCancel: () => void
}

export default function CloseConfirmModal({
  activeDownloads,
  onMinimize,
  onQuit,
  onCancel
}: CloseConfirmModalProps): React.JSX.Element {
  const minimizeButtonRef = useRef<HTMLButtonElement>(null)
  const isMac = window.framekit.platform === 'darwin'

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    minimizeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [onCancel])

  return (
    <div className="modal-backdrop close-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="close-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="close-modal-header">
          <div>
            <span className="close-modal-kicker">关闭选项</span>
            <h2 id="close-modal-title">关闭 FrameKit？</h2>
            <p>选择最小化到后台继续运行，或直接结束应用。</p>
          </div>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="取消关闭">
            <X size={17} />
          </button>
        </header>

        <div className="close-options">
          <button
            ref={minimizeButtonRef}
            type="button"
            className="close-option is-recommended"
            onClick={onMinimize}
          >
            <span className="close-option-icon">
              <Minus size={20} />
            </span>
            <span>
              <strong>{isMac ? '最小化到菜单栏' : '最小化到系统托盘'}</strong>
              <small>
                {isMac
                  ? '隐藏窗口并在菜单栏显示图标，右键图标可退出'
                  : '隐藏窗口并在右下角显示图标，右键图标可退出'}
              </small>
            </span>
          </button>
          <button type="button" className="close-option is-danger" onClick={onQuit}>
            <span className="close-option-icon">
              <Power size={20} />
            </span>
            <span>
              <strong>直接退出</strong>
              <small>
                {activeDownloads > 0
                  ? `将中断 ${activeDownloads} 个正在进行的下载`
                  : '结束应用进程，下次需重新打开'}
              </small>
            </span>
          </button>
        </div>

        <footer className="close-modal-footer">
          <span>按 Esc 可取消</span>
          <button type="button" className="button ghost" onClick={onCancel}>
            继续使用
          </button>
        </footer>
      </section>
    </div>
  )
}
