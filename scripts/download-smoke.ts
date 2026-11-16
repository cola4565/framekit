import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { DownloadManager } from '../electron/downloader'
import type { DownloadProgress } from '../src/shared/types'

const payloadA = Buffer.alloc(96 * 1024, 7)
const payloadB = Buffer.from('FrameKit download fixture')

async function main(): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === '/file-a.mp4') {
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(payloadA.byteLength)
      })
      response.end(payloadA)
      return
    }
    if (request.url === '/file-b') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(payloadB.byteLength),
        'content-disposition': "attachment; filename*=UTF-8''frame%20b.bin"
      })
      response.end(payloadB)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`
  const workspaceTemp = resolve('.tmp')
  await mkdir(workspaceTemp, { recursive: true })
  const destination = await mkdtemp(join(workspaceTemp, 'download-smoke-'))
  const updates: DownloadProgress[] = []

  try {
    const manager = new DownloadManager((progress) => {
      updates.push(progress)
    })

    const result = await manager.enqueue(
      [
        {
          id: 'a',
          url: `${origin}/file-a.mp4`,
          filename: 'clip.mp4',
          kind: 'video',
          pageUrl: origin
        },
        {
          id: 'b',
          url: `${origin}/file-b`,
          filename: 'file-b.bin',
          kind: 'other',
          pageUrl: origin
        }
      ],
      destination
    )
    assert.equal(result.queued, 2)

    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const done = new Set(
        updates.filter((update) => update.status === 'done').map((update) => update.id)
      )
      if (done.has('a') && done.has('b')) break
      const failed = updates.find(
        (update) => update.status === 'error' || update.status === 'canceled'
      )
      if (failed) throw new Error(failed.error || `download ${failed.id} failed`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80))
    }

    const done = updates.filter((update) => update.status === 'done')
    assert.equal(done.length, 2, 'expected both tasks to finish')
    const fileA = done.find((update) => update.id === 'a')
    const fileB = done.find((update) => update.id === 'b')
    assert.ok(fileA?.filePath)
    assert.ok(fileB?.filePath)
    assert.equal(fileB?.filename, 'frame b.bin')

    const downloadedA = await readFile(fileA.filePath)
    const downloadedB = await readFile(fileB.filePath)
    assert.equal(downloadedA.byteLength, payloadA.byteLength)
    assert.equal(downloadedB.toString(), payloadB.toString())

    console.log('PASS download smoke')
    console.log(JSON.stringify({ destination, files: [fileA.filename, fileB.filename] }, null, 2))
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(destination, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error('FAIL download smoke')
  console.error(error)
  process.exitCode = 1
})
