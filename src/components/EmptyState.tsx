import { Layers, ScanSearch, Zap } from 'lucide-react'

export default function EmptyState(): React.JSX.Element {
  return (
    <section className="empty-state">
      <div className="empty-orbit" aria-hidden="true">
        <div className="orbit-ring ring-one" />
        <div className="orbit-ring ring-two" />
        <span className="orbit-core">
          <Layers size={30} strokeWidth={1.4} />
        </span>
        <span className="orbit-chip chip-one">
          <Zap size={12} /> IMG
        </span>
        <span className="orbit-chip chip-two">
          <Zap size={12} /> A/V
        </span>
      </div>
      <div>
        <span className="empty-kicker">
          <ScanSearch size={14} /> READY TO SCAN
        </span>
        <h2>粘贴一个网址，开始拆解素材</h2>
        <p>
          支持普通网页、图库、素材站与博客。深度嗅探会执行页面脚本，尽量捕获动态加载的媒体。
        </p>
      </div>
    </section>
  )
}
