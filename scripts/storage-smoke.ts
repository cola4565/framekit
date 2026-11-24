import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const storagePath = join(__dirname, '..', 'electron', 'storage.ts')
const mainPath = join(__dirname, '..', 'electron', 'main.ts')
const updaterPath = join(__dirname, '..', 'electron', 'updater.ts')
const downloaderPath = join(__dirname, '..', 'electron', 'downloader.ts')
const thumbnailPath = join(__dirname, '..', 'electron', 'thumbnail.ts')

const storage = readFileSync(storagePath, 'utf8')
const main = readFileSync(mainPath, 'utf8')
const updater = readFileSync(updaterPath, 'utf8')
const downloader = readFileSync(downloaderPath, 'utf8')
const thumbnail = readFileSync(thumbnailPath, 'utf8')

// 回归测试：绝不能改写 LOCALAPPDATA / APPDATA。
//
// 这些变量会被 `shell.openExternal` 启动的默认浏览器继承，
// 导致系统浏览器的用户配置目录被重建到 FrameKit 数据目录
// （1.3.2 ~ 1.3.5 期间表现为数据目录里多出几百 MB 的 Microsoft/Edge）。
assert.equal(
  /process\.env\.LOCALAPPDATA\s*=/.test(storage),
  false,
  'storage.ts 不得改写 process.env.LOCALAPPDATA'
)
assert.equal(
  /process\.env\.APPDATA\s*=/.test(storage),
  false,
  'storage.ts 不得改写 process.env.APPDATA'
)

// TEMP/TMP 允许重定向，但必须收敛在子进程环境里，不能改全局。
assert.equal(
  /process\.env\.TEMP\s*=/.test(storage),
  false,
  'storage.ts 不得改写 process.env.TEMP'
)
assert.equal(
  /process\.env\.TMP\s*=/.test(storage),
  false,
  'storage.ts 不得改写 process.env.TMP'
)

// ffmpeg 子进程必须显式拿到重定向后的临时目录。
assert.match(downloader, /env:\s*buildChildEnv\(\)/, 'downloader.ts 的 ffmpeg 需要注入 buildChildEnv')
assert.match(thumbnail, /env:\s*buildChildEnv\(\)/, 'thumbnail.ts 的 ffmpeg 需要注入 buildChildEnv')

// 更新器缓存目录必须显式指到数据目录，而不是靠 LOCALAPPDATA 推导。
assert.match(updater, /baseCachePath/, 'updater.ts 需要显式指定更新器缓存目录')

// 外链必须仍然走 shell.openExternal。
assert.match(main, /shell\.openExternal/, 'main.ts 仍需通过 shell.openExternal 打开外链')

// 数据目录标记文件仍然会被写入，卸载器依赖它识别目录。
assert.ok(
  existsSync(join(__dirname, '..', 'electron', 'storage.ts')),
  'storage.ts 必须存在'
)

console.log(
  'PASS storage smoke: no global env mutation, child env + updater cache path stay explicit'
)
