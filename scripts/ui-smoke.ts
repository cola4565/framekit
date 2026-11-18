import { stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface CdpTarget {
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

interface CdpMessage {
  id?: number
  result?: unknown
  error?: { message: string }
  method?: string
}

interface UiSummary {
  title?: string
  cards?: number
  error?: string
  parsing?: boolean
}

interface QueueState {
  done?: boolean
  error?: string
  filename?: string
  badge?: string
}

const debugPort = process.env.FRAMEKIT_DEBUG_PORT ?? '9222'
const demoUrl = process.env.FRAMEKIT_DEMO_URL ?? 'http://127.0.0.1:8787/demo'

async function waitForTarget(): Promise<CdpTarget> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json`)
      const targets = (await response.json()) as CdpTarget[]
      const page = targets.find(
        (target) =>
          target.type === 'page' &&
          (target.url.includes('localhost') || target.url.startsWith('file:'))
      )
      if (page) return page
    } catch {
      // The dev server or Electron may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  }
  throw new Error('没有找到 FrameKit 渲染页面，请先启动开发版应用')
}

async function main(): Promise<void> {
  const target = await waitForTarget()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  let requestId = 0

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })

  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', () => resolveOpen(), { once: true })
    socket.addEventListener('error', () => rejectOpen(new Error('CDP 连接失败')), { once: true })
  })

  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    requestId += 1
    const id = requestId
    return new Promise<T>((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectSend(new Error(`CDP 命令超时：${method}`))
      }, 20000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveSend(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectSend(error)
        }
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  const evaluate = async (expression: string): Promise<unknown> => {
    const response = await send<{
      result: { value?: unknown }
      exceptionDetails?: { text: string }
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
    return response.result.value
  }

  await send('Page.enable')
  await send('Runtime.enable')

  const setUrl = await evaluate(`(() => {
    const input = document.querySelector('.url-field input');
    const button = document.querySelector('.parse-button');
    if (!input || !button) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(demoUrl)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  if (!setUrl) throw new Error('无法定位网址输入框')

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
  await evaluate("document.querySelector('.parse-button').click()")

  const deadline = Date.now() + 25000
  let summary: UiSummary | null = null

  while (Date.now() < deadline) {
    summary = (await evaluate(`(() => ({
      title: document.querySelector('.page-summary-copy h2')?.textContent || '',
      cards: document.querySelectorAll('.resource-card').length,
      error: document.querySelector('.error-banner span')?.textContent || '',
      parsing: Boolean(document.querySelector('.parse-progress'))
    }))()`)) as UiSummary
    if ((summary?.cards ?? 0) > 0 || summary?.error) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 350))
  }

  if (!summary || summary.error) {
    throw new Error(summary?.error || '解析结果没有出现')
  }
  if ((summary.cards ?? 0) < 5) {
    throw new Error(`解析结果过少：${summary.cards ?? 0}`)
  }

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 900))
  const screenshot = await send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  })
  const screenshotPath = resolve('.tmp/ui-results.png')
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))

  const detail = await evaluate(`(() => ({
    title: document.querySelector('.page-summary-copy h2')?.textContent || '',
    cards: document.querySelectorAll('.resource-card').length,
    filters: Array.from(document.querySelectorAll('.filter-tabs button')).map((button) => button.textContent.trim()),
    firstCard: document.querySelector('.resource-heading h3')?.textContent || ''
  }))()`)

  const downloadDirectory = resolve('.tmp', `ui-download-${Date.now()}`)
  await evaluate(`window.framekit.startDownloads([{
    id: 'ui-smoke-download',
    url: 'http://127.0.0.1:8787/slow/asset.bin',
    filename: 'ui-smoke.bin',
    kind: 'other',
    pageUrl: 'http://127.0.0.1:8787/demo'
  }], ${JSON.stringify(downloadDirectory)})`)
  await evaluate(`(() => {
    const trigger = document.querySelector('.queue-button');
    if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click();
  })()`)
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350))
  const drawerInteraction = await evaluate(`(async () => {
    const trigger = document.querySelector('.queue-button');
    const drawer = document.querySelector('.download-drawer');
    const initial = {
      expanded: trigger?.getAttribute('aria-expanded'),
      focused: document.activeElement?.getAttribute('aria-label'),
      opened: drawer?.classList.contains('is-open') || false,
      transition: drawer ? getComputedStyle(drawer).transitionProperty : ''
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closing = document.querySelector('.download-drawer');
    const result = {
      ...initial,
      closing: closing ? !closing.classList.contains('is-open') : false,
      hidden: closing?.getAttribute('aria-hidden') === 'true'
    };
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { ...result, removed: !document.querySelector('.download-drawer') };
  })()`)
  if (
    !drawerInteraction ||
    typeof drawerInteraction !== 'object' ||
    !('opened' in drawerInteraction) ||
    !drawerInteraction.opened ||
    !('closing' in drawerInteraction) ||
    !drawerInteraction.closing ||
    !('hidden' in drawerInteraction) ||
    !drawerInteraction.hidden ||
    !('removed' in drawerInteraction) ||
    !drawerInteraction.removed
  ) {
    console.error('Drawer interaction:', drawerInteraction)
    throw new Error('下载抽屉的 Esc 退出动画或卸载没有生效')
  }
  await evaluate("document.querySelector('.queue-button').click()")

  let queueState: QueueState | null = null
  let sawActiveBadge = false
  const queueDeadline = Date.now() + 12000
  while (Date.now() < queueDeadline) {
    queueState = (await evaluate(`(() => ({
      done: Boolean(document.querySelector('.download-drawer .queue-item.status-done')),
      error: document.querySelector('.download-drawer .queue-item.status-error .error-text')?.textContent || '',
      filename: document.querySelector('.download-drawer .queue-item.status-done h3')?.textContent || '',
      badge: document.querySelector('.queue-badge')?.textContent || ''
    }))()`)) as QueueState
    if (queueState.badge === '1') sawActiveBadge = true
    if (queueState?.done || queueState?.error) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  if (!queueState?.done) throw new Error(queueState?.error || '下载队列没有完成')
  if (!sawActiveBadge) throw new Error('下载进行时没有显示队列角标')

  let badgeAfterCompletion = 'missing'
  const badgeDeadline = Date.now() + 3000
  while (Date.now() < badgeDeadline) {
    badgeAfterCompletion = String(
      (await evaluate("document.querySelector('.queue-badge')?.textContent || ''")) ?? ''
    )
    if (!badgeAfterCompletion) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  if (badgeAfterCompletion) {
    throw new Error(`下载完成后角标仍在：${badgeAfterCompletion}`)
  }

  const downloadedFile = await stat(resolve(downloadDirectory, queueState.filename || 'ui-smoke.bin'))
  if (downloadedFile.size <= 0) throw new Error('下载文件为空')

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350))
  const queueScreenshot = await send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  })
  const queueScreenshotPath = resolve('.tmp/ui-queue.png')
  await writeFile(queueScreenshotPath, Buffer.from(queueScreenshot.data, 'base64'))

  console.log('PASS UI smoke')
  console.log(JSON.stringify(detail, null, 2))
  console.log(`Screenshot: ${screenshotPath}`)
  console.log(`Queue screenshot: ${queueScreenshotPath}`)
  socket.close()
}

main().catch((error: unknown) => {
  console.error('FAIL UI smoke')
  console.error(error)
  process.exitCode = 1
})
