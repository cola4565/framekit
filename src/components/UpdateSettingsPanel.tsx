import { useEffect, useState } from 'react'
import { Loader2, Save, Settings2 } from 'lucide-react'
import type { UpdateSettings } from '../shared/types'

interface UpdateSettingsPanelProps {
  settings: UpdateSettings | null
  onSaved: (settings: UpdateSettings) => void
}

const EMPTY: UpdateSettings = {
  source: 'github',
  feedUrl: '',
  mirror: '',
  proxy: ''
}

export default function UpdateSettingsPanel({
  settings,
  onSaved
}: UpdateSettingsPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<UpdateSettings>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (settings) setDraft(settings)
  }, [settings])

  const update = <K extends keyof UpdateSettings>(
    key: K,
    value: UpdateSettings[K]
  ): void => {
    setDraft((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await window.framekit.saveUpdateSettings?.(draft)
      if (result) {
        setDraft(result)
        onSaved(result)
      }
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="update-settings">
      <div className="update-settings-head">
        <span className="update-settings-title">
          <Settings2 size={14} />
          更新设置
        </span>
        <small>网络受限时可切换更新源</small>
      </div>

      <div className="update-settings-row">
        <label htmlFor="update-source">更新源</label>
        <select
          id="update-source"
          value={draft.source}
          onChange={(event) =>
            update('source', event.target.value as UpdateSettings['source'])
          }
        >
          <option value="github">GitHub 官方 Release</option>
          <option value="custom">自定义更新源</option>
        </select>
      </div>

      {draft.source === 'custom' && (
        <div className="update-settings-row">
          <label htmlFor="update-feed">更新源地址</label>
          <input
            id="update-feed"
            type="url"
            placeholder="https://example.com/framekit/latest.json"
            value={draft.feedUrl}
            onChange={(event) => update('feedUrl', event.target.value)}
          />
          <small>返回版本号、说明与安装包地址的 JSON；不通时会自动回退到 GitHub。</small>
        </div>
      )}

      <div className="update-settings-row">
        <label htmlFor="update-proxy">更新代理</label>
        <input
          id="update-proxy"
          type="text"
          placeholder="留空跟随系统代理，或 http://127.0.0.1:7890"
          value={draft.proxy}
          onChange={(event) => update('proxy', event.target.value)}
        />
        <small>仅影响检查更新与下载更新包，不影响素材解析。</small>
      </div>

      <div className="update-settings-row">
        <label htmlFor="update-mirror">下载镜像</label>
        <input
          id="update-mirror"
          type="url"
          placeholder="留空直连 GitHub，或 https://mirror.example/"
          value={draft.mirror}
          onChange={(event) => update('mirror', event.target.value)}
        />
        <small>只作用于安装包下载；文件仍按官方清单校验，镜像内容被改动就不会安装。</small>
      </div>

      <div className="update-settings-actions">
        <button type="button" className="button ghost" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          {saved ? '已保存' : '保存设置'}
        </button>
      </div>
    </div>
  )
}
