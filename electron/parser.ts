import type {
  ParseOptions,
  ParseProgress,
  ParseResult,
  MediaResource
} from '../src/shared/types'
import {
  mergeResources,
  parseStaticPage,
  statsForResources,
  validateAndNormalizePageUrl
} from './extractor'
import { extractBilibiliPage, isBilibiliVideoUrl } from './bilibili'
import { sniffPage } from './sniffer'

type ProgressReporter = (progress: ParseProgress) => void

function fallbackResult(url: string, error: unknown): ParseResult {
  return {
    pageUrl: url,
    finalUrl: url,
    title: new URL(url).hostname,
    mode: 'quick',
    resources: [],
    stats: statsForResources([]),
    warnings: [
      `静态扫描失败：${error instanceof Error ? error.message : '未知错误'}`,
      '已继续尝试深度嗅探。'
    ],
    elapsedMs: 0
  }
}

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.filter(Boolean))]
}

export async function parsePage(
  rawUrl: string,
  options: ParseOptions,
  onProgress: ProgressReporter = () => undefined
): Promise<ParseResult> {
  const startedAt = Date.now()
  const pageUrl = validateAndNormalizePageUrl(rawUrl)

  let quickResult: ParseResult
  try {
    quickResult = await parseStaticPage(pageUrl, onProgress)
  } catch (error) {
    if (!options.deep) throw error
    quickResult = fallbackResult(pageUrl, error)
  }

  if (isBilibiliVideoUrl(quickResult.finalUrl || pageUrl)) {
    onProgress({
      stage: 'browser',
      message: '识别到 Bilibili，正在读取清晰度与独立音轨…',
      percent: 48
    })
    try {
      const bilibili = await extractBilibiliPage(quickResult.finalUrl || pageUrl, onProgress)
      const resources = bilibili.resources
      onProgress({
        stage: 'done',
        message: `Bilibili 解析完成，共 ${bilibili.resources.length} 个清晰度`,
        percent: 100
      })
      return {
        ...quickResult,
        finalUrl: bilibili.finalUrl || quickResult.finalUrl,
        title: bilibili.title || quickResult.title,
        description: bilibili.description ?? quickResult.description,
        siteName: 'bilibili.com',
        favicon: bilibili.favicon ?? quickResult.favicon,
        mode: 'deep',
        resources,
        stats: statsForResources(resources),
        warnings: uniqueWarnings([...quickResult.warnings, ...bilibili.warnings]),
        elapsedMs: Date.now() - startedAt
      }
    } catch (error) {
      const warning = `Bilibili 专用解析失败：${
        error instanceof Error ? error.message : '未知错误'
      }`
      if (!options.deep) {
        return {
          ...quickResult,
          warnings: uniqueWarnings([...quickResult.warnings, warning]),
          elapsedMs: Date.now() - startedAt
        }
      }
      quickResult = {
        ...quickResult,
        warnings: uniqueWarnings([...quickResult.warnings, warning])
      }
    }
  }

  if (!options.deep || quickResult.resources.some((resource) => resource.source === 'direct')) {
    return {
      ...quickResult,
      mode: 'quick',
      elapsedMs: Date.now() - startedAt
    }
  }

  onProgress({ stage: 'browser', message: '静态扫描完成，准备深度嗅探…', percent: 54 })

  try {
    const sniffed = await sniffPage(quickResult.finalUrl, onProgress)
    const resources: MediaResource[] = mergeResources(quickResult.resources, sniffed.resources)
    const quickTitleIsWeak =
      !quickResult.title ||
      quickResult.title === new URL(quickResult.finalUrl).hostname ||
      quickResult.title.length < 2
    const warnings = uniqueWarnings([...quickResult.warnings, ...sniffed.warnings])

    onProgress({ stage: 'merge', message: '正在合并快速扫描与深度嗅探结果…', percent: 94 })
    const result: ParseResult = {
      ...quickResult,
      finalUrl: sniffed.finalUrl || quickResult.finalUrl,
      title: quickTitleIsWeak
        ? sniffed.title || quickResult.title
        : quickResult.title || sniffed.title || new URL(pageUrl).hostname,
      description: quickResult.description ?? sniffed.description,
      siteName: quickResult.siteName ?? sniffed.siteName,
      favicon: quickResult.favicon ?? sniffed.favicon,
      mode: 'deep',
      resources,
      stats: statsForResources(resources),
      warnings,
      elapsedMs: Date.now() - startedAt
    }
    onProgress({
      stage: 'done',
      message: `深度嗅探完成，共发现 ${resources.length} 项资源`,
      percent: 100
    })
    return result
  } catch (error) {
    const warning = `深度嗅探失败：${error instanceof Error ? error.message : '未知错误'}`
    return {
      ...quickResult,
      mode: 'deep',
      warnings: uniqueWarnings([...quickResult.warnings, warning]),
      elapsedMs: Date.now() - startedAt
    }
  }
}
