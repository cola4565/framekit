import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { DownloadProgress } from '../src/shared/types'

const MAX_RECORDS = 200

export class DownloadHistory {
  private items: DownloadProgress[] = []
  private saveTimer: NodeJS.Timeout | null = null

  private get file(): string {
    return join(app.getPath('userData'), 'download-history.json')
  }

  async load(): Promise<DownloadProgress[]> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as DownloadProgress[]
      if (Array.isArray(parsed)) {
        this.items = parsed
          .filter((item) => item && typeof item.id === 'string')
          .slice(0, MAX_RECORDS)
      }
    } catch {
      this.items = []
    }
    return this.list()
  }

  list(): DownloadProgress[] {
    return [...this.items]
  }

  record(progress: DownloadProgress): void {
    if (!['done', 'error', 'canceled'].includes(progress.status)) return
    const index = this.items.findIndex((item) => item.id === progress.id)
    if (index === -1) {
      this.items = [progress, ...this.items].slice(0, MAX_RECORDS)
    } else {
      const updated = [...this.items]
      updated[index] = progress
      this.items = updated
    }
    this.scheduleSave()
  }

  remove(id: string): void {
    this.items = this.items.filter((item) => item.id !== id)
    this.scheduleSave()
  }

  take(id: string): DownloadProgress | undefined {
    const record = this.items.find((item) => item.id === id)
    this.remove(id)
    return record
  }

  clear(): void {
    this.items = []
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, 300)
  }

  async flush(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify(this.items, null, 2), 'utf8')
    } catch {
      // History persistence is best-effort.
    }
  }

  flushSync(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.items, null, 2), 'utf8')
    } catch {
      // History persistence is best-effort.
    }
  }
}
