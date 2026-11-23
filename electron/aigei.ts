import { BrowserWindow, session, shell } from 'electron'
import type { OnBeforeRequestListenerDetails, Session } from 'electron'
import type { MediaResource, ParseProgress, ResourceKind } from '../src/shared/types'
import { sanitizeFilename } from './extractor'

const AIGEI_PARTITION = 'persist:aigei'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 32000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOGIN_POLL_MS = 1000
const DOWNLOAD_WAIT_MS = 9000

const configuredSessions = new WeakSet<Session>()
let cachedAuth = { value: false, at: 0 }
let cachedCookie = { value: '', at: 0 }
let authCheckPromise: Promise<boolean> | null = null
let activeDownloadCapture: ((url: string) => void) | null = null
let activeRequestCapture: ((details: OnBeforeRequestListenerDetails) => void) | null = null

function debugLog(message: string): void {
  if (process.env.FRAMEKIT_DEBUG_AIGEI) process.stdout.write(`[aigei] ${message}\n`)
}

interface AigeiRowInfo {
  index: number
  format: string
  quality: string
  resolution: string
  sizeText: string
  rurl: string
  vipMarked: boolean
}

interface AigeiPageInfo {
  ok: boolean
  error?: string
  itemId: string
  title: string
  description?: string
  poster?: string
  previewUrl?: string
  previewWidth?: number
  previewHeight?: number
  loggedIn: boolean
  buttonFound: boolean
  rows: AigeiRowInfo[]
}

interface AigeiTriggerResult {
  index: number
  url: string
  blocked: boolean
  error?: string
}

export interface AigeiExtractResult {
  finalUrl: string
  title: string
  description?: string
  favicon?: string
  resources: MediaResource[]
  warnings: string[]
}

const MEDIA_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'm4v',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'wav',
  'flac',
  'aac',
  'zip',
  'rar',
  '7z',
  'psd',
  'aep',
  'mogrt'
])

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), milliseconds)
  })
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isAigeiHost(hostname: string): boolean {
  return hostname === 'aigei.com' || hostname.endsWith('.aigei.com')
}

export function isAigeiPageUrl(rawUrl: string): boolean {
  try {
    return isAigeiHost(new URL(rawUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function isAigeiItemUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return isAigeiHost(parsed.hostname.toLowerCase()) && /^\/item\//i.test(parsed.pathname)
  } catch {
    return false
  }
}

function aigeiSession(): Session {
  const browserSession = session.fromPartition(AIGEI_PARTITION)
  if (configuredSessions.has(browserSession)) return browserSession
  configuredSessions.add(browserSession)
  browserSession.setUserAgent(USER_AGENT)
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.on('will-download', (event, item) => {
    const url = item.getURL()
    if (url) activeDownloadCapture?.(url)
    event.preventDefault()
  })
  browserSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    activeRequestCapture?.(details)
    callback({})
  })
  return browserSession
}

export async function getAigeiCookieHeader(): Promise<string> {
  if (Date.now() - cachedCookie.at < 15000) return cachedCookie.value
  try {
    const cookies = await aigeiSession().cookies.get({})
    const value = cookies
      .filter((cookie) => {
        const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
        return domain === 'aigei.com' || domain.endsWith('.aigei.com')
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
    cachedCookie = { value, at: Date.now() }
    return value
  } catch {
    return ''
  }
}

async function checkAuthInBrowser(): Promise<boolean> {
  const browser = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1200,
    height: 800,
    webPreferences: {
      session: aigeiSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  browser.webContents.setAudioMuted(true)
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await withTimeout(browser.loadURL('https://www.aigei.com/').catch(() => undefined), 20000, undefined)
    await delay(1800)
    const loggedIn = await loginStatusInWindow(browser)
    cachedAuth = { value: loggedIn, at: Date.now() }
    return loggedIn
  } catch {
    return cachedAuth.value
  } finally {
    if (!browser.isDestroyed()) browser.destroy()
  }
}

export async function getAigeiAuthStatus(force = false): Promise<boolean> {
  if (!force && Date.now() - cachedAuth.at < 60000) return cachedAuth.value
  if (authCheckPromise) return authCheckPromise
  authCheckPromise = checkAuthInBrowser().finally(() => {
    authCheckPromise = null
  })
  return authCheckPromise
}

function loginWindowAllowed(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const host = parsed.hostname.toLowerCase()
    return (
      isAigeiHost(host) ||
      host === 'qq.com' ||
      host.endsWith('.qq.com') ||
      host === 'wechat.com' ||
      host.endsWith('.wechat.com')
    )
  } catch {
    return false
  }
}

async function loginStatusInWindow(browser: BrowserWindow): Promise<boolean> {
  const result = await evaluateInPage<boolean>(
    browser,
    String.raw`(() => {
      const flag = window.isLogin;
      const userId = String(window.loginUserId || '').trim();
      const nameText = (document.querySelector('#loginUserInfoName')?.textContent || '').trim();
      const avatar = document.querySelector('#loginUserInfoAvatar1');
      return (
        flag === true ||
        flag === 'true' ||
        Boolean(userId && userId !== 'false' && userId !== '0') ||
        Boolean(nameText) ||
        Boolean(avatar && avatar.getAttribute('src'))
      );
    })()`,
    6000
  )
  return Boolean(result)
}

export async function loginAigei(parent: BrowserWindow | null): Promise<boolean> {
  if (await getAigeiAuthStatus()) return true

  const browser = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 880,
    minHeight: 640,
    show: true,
    title: '登录 爱给网 - FrameKit',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    ...(parent ? { parent } : {}),
    webPreferences: {
      session: aigeiSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false
    }
  })

  browser.webContents.setWindowOpenHandler(({ url }) => {
    if (loginWindowAllowed(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          webPreferences: {
            session: aigeiSession(),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false,
            spellcheck: false
          }
        }
      }
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(parsed.href)
      }
    } catch {
      // Ignore malformed popup URLs.
    }
    return { action: 'deny' }
  })

  browser.webContents.on('will-navigate', (event, targetUrl) => {
    if (!loginWindowAllowed(targetUrl)) event.preventDefault()
  })

  await browser.loadURL('https://www.aigei.com/').catch(() => undefined)

  return new Promise<boolean>((resolve) => {
    let settled = false
    let probing = false
    const finish = (loggedIn: boolean): void => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(timeoutTimer)
      if (loggedIn) {
        cachedAuth = { value: true, at: Date.now() }
        cachedCookie = { value: '', at: 0 }
      }
      if (!browser.isDestroyed()) browser.close()
      resolve(loggedIn)
    }
    const pollTimer = setInterval(() => {
      if (probing) return
      probing = true
      void loginStatusInWindow(browser)
        .then((loggedIn) => {
          if (loggedIn) finish(true)
        })
        .finally(() => {
          probing = false
        })
    }, LOGIN_POLL_MS)
    const timeoutTimer = setTimeout(() => finish(false), LOGIN_TIMEOUT_MS)
    browser.on('closed', () => finish(false))
  })
}

function decodeFastVideoUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/\s+/g, '')
  if (cleaned.length < 16 || !/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) return undefined
  try {
    const normalized = cleaned.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim()
    return /^https?:\/\//i.test(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

function parseResolution(value: string): { width?: number; height?: number } {
  const match = /(\d{2,5})\s*[x×]\s*(\d{2,5})/i.exec(value)
  if (!match) return {}
  const width = Number.parseInt(match[1], 10)
  const height = Number.parseInt(match[2], 10)
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : {}
}

function extensionFromFormat(format: string, url: string, kind: ResourceKind): string {
  const normalized = format.trim().toLowerCase()
  if (MEDIA_EXTENSIONS.has(normalized)) return normalized
  try {
    const extension = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? ''
    if (MEDIA_EXTENSIONS.has(extension)) return extension
  } catch {
    // Fall through to the kind default.
  }
  if (kind === 'video') return 'mp4'
  if (kind === 'audio') return 'mp3'
  return 'zip'
}

function kindFromFormat(format: string, url: string): ResourceKind {
  const extension = extensionFromFormat(format, url, 'other')
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(extension)) return 'video'
  if (['mp3', 'wav', 'flac', 'aac'].includes(extension)) return 'audio'
  return 'other'
}

function mimeFromExtension(extension: string): string | undefined {
  if (extension === 'mp4' || extension === 'm4v') return 'video/mp4'
  if (extension === 'mov') return 'video/quicktime'
  if (extension === 'webm') return 'video/webm'
  if (extension === 'mkv') return 'video/x-matroska'
  if (extension === 'mp3') return 'audio/mpeg'
  if (extension === 'wav') return 'audio/wav'
  if (extension === 'flac') return 'audio/flac'
  if (extension === 'aac') return 'audio/aac'
  if (extension === 'zip') return 'application/zip'
  if (extension === 'rar') return 'application/vnd.rar'
  if (extension === '7z') return 'application/x-7z-compressed'
  return undefined
}

function isAigeiDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.toLowerCase()
    if (!isAigeiHost(host)) return false
    if (/^\/(?:f|d|down|download)\//i.test(parsed.pathname)) return true
    const extension = parsed.pathname.split('.').pop()?.toLowerCase() ?? ''
    return MEDIA_EXTENSIONS.has(extension)
  } catch {
    return false
  }
}

function shouldCaptureRequest(details: OnBeforeRequestListenerDetails): string | undefined {
  if (!isAigeiDownloadUrl(details.url)) return undefined
  if (details.resourceType === 'image' || details.resourceType === 'stylesheet') return undefined
  return details.url
}

async function evaluateInPage<T>(
  browser: BrowserWindow,
  expression: string,
  timeoutMs: number
): Promise<T | null> {
  if (browser.isDestroyed()) return null
  const debuggerSession = browser.webContents.debugger
  const attached = debuggerSession.isAttached()
  try {
    if (!attached) debuggerSession.attach('1.3')
    const result = await withTimeout(
      debuggerSession.sendCommand('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      }),
      timeoutMs,
      null
    )
    if (!result || result.exceptionDetails) return null
    return (result.result?.value ?? null) as T | null
  } catch {
    return null
  } finally {
    if (!attached && debuggerSession.isAttached()) debuggerSession.detach()
  }
}

async function readAigeiPageInfo(browser: BrowserWindow): Promise<AigeiPageInfo | null> {
  return evaluateInPage<AigeiPageInfo>(
    browser,
    String.raw`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const meta = (name) => {
        const element = document.querySelector(
          'meta[property="' + name + '"], meta[name="' + name + '"]'
        );
        return element ? element.getAttribute('content') || '' : '';
      };
      const deadline = Date.now() + 16000;
      let button = null;
      while (!button && Date.now() < deadline) {
        button =
          document.querySelector('.item-view-box [id^="itemDownBtn_"]') ||
          document.querySelector('[id^="itemDownBtn_"]');
        if (!button) await sleep(250);
      }
      const titleNode =
        document.querySelector('.item-view-box .title-box .title-link b') ||
        document.querySelector('.item-view-box .title-box .title-link');
      const title =
        (titleNode && (titleNode.getAttribute('title') || titleNode.textContent || '').trim()) ||
        meta('og:title') ||
        document.title.replace(/\s*[-_]\s*(?:视频|爱剪辑|ae|会声会影|特效素材下载).*$/i, '').trim();
      const previewNode = document.querySelector('[fast-video-url]');
      const flag = window.isLogin;
      const userId = String(window.loginUserId || '').trim();
      const nameText = (document.querySelector('#loginUserInfoName')?.textContent || '').trim();
      const base = {
        itemId: button ? button.getAttribute('itemid') || '' : '',
        title,
        description: meta('og:description') || meta('description') || '',
        poster: meta('og:image') || '',
        previewUrl: previewNode
          ? previewNode.getAttribute('fast-video-url') || previewNode.getAttribute('data-fast-video-url') || ''
          : '',
        previewWidth: previewNode ? Number(previewNode.getAttribute('fast-video-width') || 0) : 0,
        previewHeight: previewNode ? Number(previewNode.getAttribute('fast-video-height') || 0) : 0,
        loggedIn:
          flag === true ||
          flag === 'true' ||
          Boolean(userId && userId !== 'false' && userId !== '0') ||
          Boolean(nameText),
        buttonFound: Boolean(button)
      };
      if (!button) {
        return { ok: false, error: '没有找到爱给网下载按钮', rows: [], ...base };
      }
      button.scrollIntoView({ block: 'center' });
      if (window.jQuery) {
        window.jQuery(button).trigger('mouseover');
        window.jQuery(button).trigger('mouseenter');
      } else {
        button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        button.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      }
      let rows = [];
      const menuDeadline = Date.now() + 10000;
      while (Date.now() < menuDeadline) {
        await sleep(250);
        rows = Array.from(document.querySelectorAll(
          '.video-down-dropdown-menu .table-body .table-row, .down-dropdown-menu .table-body .table-row'
        ));
        if (rows.length > 0) break;
      }
      const readText = (root, selector) => {
        const node = root.querySelector(selector);
        return node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : '';
      };
      return {
        ok: true,
        ...base,
        rows: rows.map((row, index) => {
          const anchor = row.querySelector('.item-down-btn');
          const token = row.querySelector('input[id^="itemInfoToken_"]');
          const vip = row.querySelector('.icon-vip-down-button');
          const style = vip ? getComputedStyle(vip) : null;
          return {
            index,
            format: readText(row, '.td-format'),
            quality: readText(row, '.td-quality'),
            resolution: readText(row, '.td-resolution'),
            sizeText: readText(row, '.td-size'),
            rurl:
              (anchor && anchor.getAttribute('rurl')) ||
              (token && token.getAttribute('rurl')) ||
              '',
            vipMarked: Boolean(
              vip && style && style.display !== 'none' && style.visibility !== 'hidden'
            )
          };
        })
      };
    })()`,
    28000
  )
}

async function triggerAigeiDownloads(browser: BrowserWindow): Promise<AigeiTriggerResult[]> {
  return (await evaluateInPage<AigeiTriggerResult[]>(
    browser,
    String.raw`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const captured = [];
      window.__framekitAigeiCaptured = captured;
      const record = (url) => {
        if (!url) return;
        const value = String(url).trim();
        if (!/^https?:\/\//i.test(value)) return;
        if (!captured.includes(value)) captured.push(value);
      };
      const scanFrames = () => {
        document.querySelectorAll('iframe').forEach((frame) => {
          record(frame.getAttribute('src'));
        });
      };
      const observer = new MutationObserver(scanFrames);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
      });
      scanFrames();
      const rows = Array.from(
        document.querySelectorAll(
          '.video-down-dropdown-menu .table-body .table-row, .down-dropdown-menu .table-body .table-row'
        )
      );
      const results = [];
      const visibleLogin = () => {
        return Array.from(
          document.querySelectorAll('.login-container-pop, .login-container, .login-box')
        ).some((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
      };

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const anchor = row.querySelector('.item-down-btn');
        if (!anchor || typeof itemFileDown !== 'function') {
          results.push({ index, url: '', blocked: false, error: '缺少下载入口' });
          continue;
        }
        const before = captured.length;
        try {
          itemFileDown(anchor, getDropdownBtnTipRender(anchor));
        } catch (error) {
          results.push({ index, url: '', blocked: false, error: String(error) });
          continue;
        }

        let url = '';
        let blocked = false;
        const deadline = Date.now() + 9000;
        while (Date.now() < deadline) {
          await sleep(250);
          if (captured.length > before) {
            url = captured[captured.length - 1];
            break;
          }
          if (visibleLogin()) {
            blocked = true;
            break;
          }
        }
        results.push({ index, url, blocked });
        if (blocked) break;
      }
      observer.disconnect();
      return results;
    })()`,
    DOWNLOAD_WAIT_MS * 8 + 5000
  )) ?? []
}

function rowLabel(row: AigeiRowInfo): string {
  return [row.quality, row.resolution, row.sizeText].filter(Boolean).join(' · ')
}

function parseDescriptionFacts(description: string | undefined): {
  duration?: number
  resolution?: string
} {
  const text = description ?? ''
  const duration = /时长\s*[:：]?\s*([0-9.]+)\s*(?:秒|s)/i.exec(text)?.[1]
  const resolution = /分辨率\s*[:：]?\s*([0-9]+\s*[x×]\s*[0-9]+)/i.exec(text)?.[1]
  return {
    duration: duration ? Number.parseFloat(duration) : undefined,
    resolution: resolution?.replace(/\s+/g, '')
  }
}

function previewResources(
  info: AigeiPageInfo,
  finalUrl: string,
  title: string
): MediaResource[] {
  const url = decodeFastVideoUrl(info.previewUrl)
  if (!url) return []
  const filename = sanitizeFilename(title.replace(/\.[a-z0-9]{1,8}$/i, '')).slice(0, 90)
  return [
    {
      id: `aigei-preview-${info.itemId || 'item'}`,
      url,
      kind: 'video',
      source: 'html',
      pageUrl: finalUrl,
      filename: `${filename || 'aigei-preview'}.mp4`,
      extension: 'mp4',
      mime: 'video/mp4',
      width: info.previewWidth,
      height: info.previewHeight,
      poster: info.poster || undefined,
      label: `${title} · ${info.previewWidth || 300}×${info.previewHeight || 168} 预览`,
      discoveryLabel: '爱给网公开预览 · 原片需登录及相应权限',
      isStream: false
    }
  ]
}

export async function extractAigeiItemPage(
  pageUrl: string,
  onProgress: (progress: ParseProgress) => void
): Promise<AigeiExtractResult> {
  const browserSession = aigeiSession()
  const browser = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1440,
    height: 1000,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  browser.webContents.setAudioMuted(true)
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const captured: string[] = []
  const capture = (url: string): void => {
    if (!isAigeiDownloadUrl(url) || captured.includes(url)) return
    captured.push(url)
  }
  activeDownloadCapture = capture
  activeRequestCapture = (details) => {
    const url = shouldCaptureRequest(details)
    if (url) capture(url)
  }

  try {
    onProgress({
      stage: 'browser',
      message: '正在打开爱给网条目页并读取下载规格…',
      percent: 62
    })
    await withTimeout(browser.loadURL(pageUrl).catch(() => undefined), PAGE_TIMEOUT_MS, undefined)
    await delay(3500)
    let info: AigeiPageInfo | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      debugLog('reading page info')
      info = await withTimeout(readAigeiPageInfo(browser), 30000, null)
      debugLog(`page info result: ${info?.ok ? 'ok' : 'failed'}`)
      if (info?.ok) break
      await delay(1200)
    }

    if (!info) throw new Error('读取爱给网页面信息超时，请稍后重试')

    const finalUrl = browser.isDestroyed() ? pageUrl : browser.webContents.getURL() || pageUrl
    const title = info.title.trim() || '爱给网素材'
    const description = info.description?.trim() || undefined
    const facts = parseDescriptionFacts(description)
    const warnings: string[] = []
    const qualitySummary = info.rows
      .map((row) => rowLabel(row))
      .filter(Boolean)
      .join('、')

    if (!info.loggedIn || !info.ok) {
      warnings.push(
        '未登录爱给网：当前只提供低清预览。点击网址旁的“登录爱给网”，完成登录后重新解析即可读取原片下载规格。'
      )
      if (!info.ok && info.error) {
        warnings.push(`条目页动态信息读取未完成：${info.error}，已保留公开预览。`)
      }
      if (qualitySummary) {
        warnings.push(`检测到站点提供的下载规格：${qualitySummary}。实际可用性由账号与会员权限决定。`)
      }
      warnings.push('本工具只走站点正常登录与下载入口，不绕过登录、验证码、会员或付费限制。')
      onProgress({ stage: 'merge', message: '爱给网未登录，保留低清预览…', percent: 92 })
      return {
        finalUrl,
        title,
        description,
        favicon: 'https://www.aigei.com/favicon.ico',
        resources: previewResources(info, finalUrl, title),
        warnings
      }
    }

    if (info.rows.length === 0) {
      warnings.push('登录状态已读取，但下载菜单没有返回清晰度规格，页面结构可能已更新。')
      warnings.push('当前保留条目页公开的低清预览。')
      return {
        finalUrl,
        title,
        description,
        favicon: 'https://www.aigei.com/favicon.ico',
        resources: previewResources(info, finalUrl, title),
        warnings
      }
    }

    onProgress({
      stage: 'network',
      message: `爱给网已登录，正在按站点流程获取 ${info.rows.length} 个规格的下载地址…`,
      percent: 76
    })
    const triggered = await withTimeout(
      triggerAigeiDownloads(browser),
      info.rows.length * DOWNLOAD_WAIT_MS + 5000,
      []
    )
    const byIndex = new Map(triggered.map((item) => [item.index, item]))
    const usedUrls = new Set(triggered.map((item) => item.url).filter(Boolean))
    const fallbackUrls = captured.filter((url) => !usedUrls.has(url))
    const missingRows = info.rows.filter((row) => {
      const result = byIndex.get(row.index)
      return !result?.url && !result?.blocked
    })
    if (fallbackUrls.length === missingRows.length && fallbackUrls.length > 0) {
      missingRows.forEach((row, index) => {
        byIndex.set(row.index, {
          index: row.index,
          url: fallbackUrls[index],
          blocked: false
        })
      })
    }
    const titleBase = sanitizeFilename(title.replace(/\.[a-z0-9]{1,8}$/i, '')).slice(0, 80)
    const resources: MediaResource[] = []
    let blockedCount = 0
    let failedCount = 0

    for (const row of info.rows) {
      const result = byIndex.get(row.index)
      if (result?.blocked) {
        blockedCount += 1
        continue
      }
      const url = result?.url?.trim()
      if (!url || !isAigeiDownloadUrl(url)) {
        failedCount += 1
        continue
      }
      const kind = kindFromFormat(row.format, url)
      const extension = extensionFromFormat(row.format, url, kind)
      const dimensions = parseResolution(row.resolution)
      const quality = row.quality || '原片'
      resources.push({
        id: `aigei_${info.itemId || 'item'}_${row.index}_${row.rurl || extension}`,
        url,
        kind,
        source: 'network',
        pageUrl: finalUrl,
        filename: `${titleBase || 'aigei-item'}-${sanitizeFilename(quality)}.${extension}`,
        extension,
        mime: mimeFromExtension(extension),
        width: dimensions.width ?? info.previewWidth ?? undefined,
        height: dimensions.height ?? info.previewHeight ?? undefined,
        duration: facts.duration,
        poster: info.poster || undefined,
        label: [row.format, row.quality, row.resolution, row.sizeText].filter(Boolean).join(' · '),
        discoveryLabel: '爱给网原片 · 站点正常下载流程',
        isStream: false,
        qualityLabel: quality,
        codec: row.format || undefined,
        groupId: `aigei-${info.itemId || 'item'}`
      })
    }

    if (resources.length > 0) {
      warnings.push(
        `已通过爱给网正常登录与下载入口获取 ${resources.length} 个原片地址；下载时请保持登录状态。`
      )
    }
    if (blockedCount > 0) {
      warnings.push(
        `有 ${blockedCount} 个规格点击后要求登录或更高权限，已跳过；请确认账号状态或会员权限。`
      )
    }
    if (failedCount > 0) {
      warnings.push(
        `有 ${failedCount} 个规格没有返回可用地址，可能需要 VIP 会员、版权商用授权，或该格式不提供下载。`
      )
    }
    if (resources.length === 0) {
      warnings.push('当前账号没有获取到可下载原片，已保留条目页公开的低清预览。')
    }

    onProgress({ stage: 'merge', message: '正在整理爱给网原片信息…', percent: 94 })
    return {
      finalUrl,
      title,
      description,
      favicon: 'https://www.aigei.com/favicon.ico',
      resources,
      warnings
    }
  } finally {
    activeDownloadCapture = null
    activeRequestCapture = null
    if (!browser.isDestroyed()) browser.destroy()
  }
}

