import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const realRoot = realpathSync(root)

for (const directory of ['out', 'release']) {
  const target = resolve(realRoot, directory)
  if (!target.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`拒绝清理项目目录之外的路径：${target}`)
  }
  await rm(target, { recursive: true, force: true })
  console.log(`已清理构建目录：${directory}/`)
}
