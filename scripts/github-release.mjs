import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { execFileSync } from 'node:child_process'

function readGhToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const token = process.env.GH_PUBLISH_TOKEN || readGhToken()
const repository = process.env.GITHUB_REPOSITORY || 'cola4565/framekit'
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = process.env.RELEASE_TAG || `v${version}`
const releaseName = `FrameKit ${version}`

if (!token) {
  throw new Error('缺少 GitHub 凭据：设置 GH_PUBLISH_TOKEN，或先执行 gh auth login')
}

const api = `https://api.github.com/repos/${repository}`
const commonHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'FrameKit-Releaser'
}

async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...commonHeaders, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15 * 60 * 1000)
  })
  const text = await response.text()
  if (!response.ok) {
    const error = new Error(`${init.method ?? 'GET'} ${url} -> ${response.status}: ${text}`)
    error.status = response.status
    throw error
  }
  return text ? JSON.parse(text) : null
}

const repo = await request(api, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ private: false })
})
console.log(`Repository visibility: ${repo.private ? 'private' : 'public'}`)

const bodyPath = process.env.RELEASE_NOTES_FILE || `.tmp/release-notes-${version}.md`
const body = readFileSync(bodyPath, 'utf8').trim()

let release
try {
  release = await request(`${api}/releases/tags/${tag}`)
  release = await request(`${api}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: releaseName,
      body,
      draft: false,
      prerelease: false
    })
  })
  console.log(`Updated release: ${release.html_url}`)
} catch (error) {
  if (error.status !== 404) throw error
  release = await request(`${api}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: releaseName,
      body,
      draft: false,
      prerelease: false
    })
  })
  console.log(`Created release: ${release.html_url}`)
}

const assets = [
  `release/FrameKit-${version}-Windows-x64.exe`,
  `release/FrameKit-${version}-Windows-x64.exe.blockmap`,
  'release/latest.yml'
]

const existingAssets = await request(`${api}/releases/${release.id}/assets`)
for (const filePath of assets) {
  const name = basename(filePath)
  const existing = existingAssets.find((asset) => asset.name === name)
  if (existing) {
    await request(`${api}/releases/assets/${existing.id}`, { method: 'DELETE' })
    console.log(`Removed existing asset: ${name}`)
  }

  const content = readFileSync(filePath)
  const uploaded = await request(
    `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(statSync(filePath).size)
      },
      body: content
    }
  )
  console.log(`Uploaded asset: ${uploaded.name} (${uploaded.size} bytes)`)
}

if (process.env.TRIGGER_MACOS === '1') {
  try {
    await request(`${api}/actions/workflows/release.yml/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' })
    })
    console.log('Triggered macOS release workflow')
  } catch (error) {
    console.log(`macOS workflow was not triggered: ${error.message}`)
  }
} else {
  console.log('macOS workflow will be triggered automatically by the new tag')
}

console.log(
  JSON.stringify(
    {
      repository,
      public: !repo.private,
      tag,
      releaseUrl: release.html_url,
      assets: assets.map((filePath) => basename(filePath))
    },
    null,
    2
  )
)
