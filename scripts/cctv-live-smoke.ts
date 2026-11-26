/**
 * 央视网真实解析验证。
 *
 * 这个脚本需要 Electron 运行时（`net.fetch` 依赖 Chromium 网络栈），
 * 因此不能像其他冒烟测试那样直接用 tsx 跑。
 *
 * 用法：
 *   npm run test:cctv:live
 */
import { app } from 'electron'
import { extractCctvPage } from '../electron/cctv'

const PAGE_URL = 'https://tv.cctv.com/2025/10/07/VIDErVuzkncfsaZS94lRzz4z251007.shtml'

app.on('window-all-closed', () => undefined)

app.whenReady().then(async () => {
  try {
    const result = await extractCctvPage(PAGE_URL, () => undefined)
    console.log(
      JSON.stringify(
        result.resources.map(
          ({ id, filename, url, qualityLabel, width, height, isStream }) => ({
            id,
            filename,
            qualityLabel,
            width,
            height,
            isStream,
            url
          })
        ),
        null,
        2
      )
    )
    if (result.resources.length !== 4) {
      throw new Error(`期望解析出 4 档清晰度，实际 ${result.resources.length} 档`)
    }
    const labels = result.resources.map((resource) => resource.qualityLabel)
    if (labels.join('/') !== '流畅/标清/高清/超清') {
      throw new Error(`清晰度文案不符合预期：${labels.join('/')}`)
    }
    console.log('PASS cctv live smoke: 央视网真实页面解析出四档清晰度')
  } catch (error) {
    console.error('FAIL cctv live smoke')
    console.error(error)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
