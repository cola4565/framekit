import type {
  ParseOptions,
  ParseProgress,
  ParseResult,
  MediaResource
} from '../src/shared/types'
import {
  applyFallbackPoster,
  mergeResources,
  parseStaticPage,
  statsForResources,
  validateAndNormalizePageUrl
} from './extractor'
import { extractBilibiliPage, isBilibiliVideoUrl } from './bilibili'
import { extractDouyinPage, isDouyinVideoUrl } from './douyin'
import { extractAigeiItemPage, isAigeiItemUrl } from './aigei'
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

function warningsAfterDedicatedParse(warnings: string[]): string[] {
  return uniqueWarnings(
    warnings.filter(
      (warning) =>
        !/页面源码中没有发现直链媒体/.test(warning) &&
        !/已继续尝试深度嗅探/.test(warning) &&
        !/^静态扫描失败：/.test(warning)
    )
  )
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

  if (isAigeiItemUrl(quickResult.finalUrl || pageUrl)) {
    onProgress({
      stage: 'browser',
      message: '识别到爱给网条目页，正在读取登录状态与下载规格…',
      percent: 48
    })
    try {
      const aigei = await extractAigeiItemPage(quickResult.finalUrl || pageUrl, onProgress)
      const hasOriginals = aigei.resources.some(
        (resource) => resource.discoveryLabel === '爱给网原片 · 站点正常下载流程'
      )
      const resources =
        aigei.resources.length > 0 ? aigei.resources : quickResult.resources
      const quickWarnings = quickResult.warnings.filter((warning) => {
        if (
          /页面源码中没有发现直链媒体/.test(warning) ||
          /已继续尝试深度嗅探/.test(warning) ||
          /^静态扫描失败：/.test(warning)
        ) {
          return false
        }
        if (hasOriginals && /爱给网条目页只公开低清预览/.test(warning)) return false
        return true
      })
      onProgress({
        stage: 'done',
        message: hasOriginals
          ? `爱给网解析完成，共 ${resources.length} 项原片资源`
          : '爱给网解析完成，当前仅提供低清预览',
        percent: 100
      })
      return {
        ...quickResult,
        finalUrl: aigei.finalUrl || quickResult.finalUrl,
        title: aigei.title || quickResult.title,
        description: aigei.description ?? quickResult.description,
        siteName: 'aigei.com',
        favicon: aigei.favicon ?? quickResult.favicon,
        mode: 'deep',
        resources,
        stats: statsForResources(resources),
        warnings: uniqueWarnings([...quickWarnings, ...aigei.warnings]),
        elapsedMs: Date.now() - startedAt
      }
    } catch (error) {
      const warning = `爱给网专用解析失败：${
        error instanceof Error ? error.message : '未知错误'
      }`
      quickResult = {
        ...quickResult,
        warnings: uniqueWarnings([...quickResult.warnings, warning])
      }
    }
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
        warnings: warningsAfterDedicatedParse([...quickResult.warnings, ...bilibili.warnings]),
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

  if (isDouyinVideoUrl(quickResult.finalUrl || pageUrl)) {
    onProgress({
      stage: 'browser',
      message: '识别到抖音，正在捕获视频流与音轨…',
      percent: 48
    })
    try {
      const douyin = await extractDouyinPage(quickResult.finalUrl || pageUrl, onProgress)
      const resources = douyin.resources
      onProgress({
        stage: 'done',
        message: `抖音解析完成，共 ${resources.length} 个视频`,
        percent: 100
      })
      return {
        ...quickResult,
        finalUrl: douyin.finalUrl || quickResult.finalUrl,
        title: douyin.title || quickResult.title,
        description: douyin.description ?? quickResult.description,
        siteName: 'douyin.com',
        favicon: douyin.favicon ?? quickResult.favicon,
        mode: 'deep',
        resources,
        stats: statsForResources(resources),
        warnings: warningsAfterDedicatedParse([...quickResult.warnings, ...douyin.warnings]),
        elapsedMs: Date.now() - startedAt
      }
    } catch (error) {
      const warning = `抖音专用解析失败：${
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
    const resources: MediaResource[] = applyFallbackPoster(
      mergeResources(quickResult.resources, sniffed.resources)
    )
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
