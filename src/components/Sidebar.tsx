import type { ComponentType } from 'react'
import {
  FileText,
  Film,
  Image,
  Layers,
  Music,
  RefreshCw,
  ShieldCheck
} from 'lucide-react'

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

interface ToolItem {
  label: string
  description: string
  icon: IconType
  active?: boolean
  upcoming?: boolean
}

const tools: ToolItem[] = [
  {
    label: '素材解析',
    description: '网页图片 / 音频 / 视频',
    icon: Layers,
    active: true
  },
  {
    label: '图片批处理',
    description: '尺寸 / 格式 / 水印',
    icon: Image,
    upcoming: true
  },
  {
    label: '音视频转码',
    description: '代理文件 / 序列封面',
    icon: Film,
    upcoming: true
  },
  {
    label: '音频工具',
    description: '提取 / 响度 / 降噪',
    icon: Music,
    upcoming: true
  },
  {
    label: '字幕工具',
    description: 'SRT / ASS / 时间轴',
    icon: FileText,
    upcoming: true
  }
]

interface SidebarProps {
  version: string
  onCheckUpdates: () => void
}

export default function Sidebar({ version, onCheckUpdates }: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-section-label">TOOLKIT</div>
      <nav className="sidebar-nav" aria-label="工具模块">
        {tools.map((tool) => {
          const Icon = tool.icon
          return (
            <button
              key={tool.label}
              type="button"
              className={`nav-item${tool.active ? ' is-active' : ''}${tool.upcoming ? ' is-upcoming' : ''}`}
              disabled={tool.upcoming}
              title={tool.upcoming ? '即将上线' : tool.description}
            >
              <span className="nav-icon">
                <Icon size={18} strokeWidth={1.8} />
              </span>
              <span className="nav-copy">
                <span className="nav-label">{tool.label}</span>
                <span className="nav-description">{tool.description}</span>
              </span>
              {tool.upcoming && <span className="soon-tag">SOON</span>}
            </button>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="privacy-note">
          <ShieldCheck size={16} strokeWidth={1.8} />
          <div>
            <strong>本地解析</strong>
            <span>资源不经过云端中转</span>
          </div>
        </div>
        <button
          type="button"
          className="nav-item compact is-action"
          onClick={onCheckUpdates}
          title="检查更新"
        >
          <span className="nav-icon">
            <RefreshCw size={16} strokeWidth={1.8} />
          </span>
          <span className="nav-copy">
            <span className="nav-label">关于与更新</span>
          </span>
          <span className="version-tag">v{version || '1.0.0'}</span>
        </button>
      </div>
    </aside>
  )
}
