import assert from 'node:assert/strict'
import {
  applyMirror,
  findAssetApiUrl,
  parseAssetApiUrl,
  parseCustomFeed,
  parseLatestTagFromHtml,
  parseReleaseAssets,
  parseReleaseFeed
} from '../electron/github-fallback'

// --- 最新 tag：从 og:url 读取（Electron 的 net.fetch 不暴露重定向后的 URL） ---
assert.equal(
  parseLatestTagFromHtml(
    '<meta property="og:url" content="/cola4565/framekit/releases/tag/v1.3.3" />'
  ),
  'v1.3.3'
)
assert.equal(
  parseLatestTagFromHtml(
    '<meta content="/cola4565/framekit/releases/tag/v1.2.0" property="og:url" />'
  ),
  'v1.2.0'
)
assert.equal(
  parseLatestTagFromHtml('<a href="/cola4565/framekit/releases/tag/v9.9.9">x</a>'),
  'v9.9.9'
)
assert.equal(parseLatestTagFromHtml('<html>no release here</html>'), null)

// --- atom feed：第一个条目是最新正式版 ---
const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1459836626/v1.3.3</id>
    <link type="text/html" rel="alternate" href="https://github.com/cola4565/framekit/releases/tag/v1.3.3"/>
    <title>FrameKit 1.3.3</title>
    <updated>2026-11-24T03:26:57Z</updated>
    <content type="html">&lt;h2&gt;FrameKit 1.3.3&lt;/h2&gt;
&lt;p&gt;新增了&lt;strong&gt;视频封面&lt;/strong&gt;功能&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1459836626/v1.3.2</id>
    <title>FrameKit 1.3.2</title>
    <updated>2026-11-24T02:09:36Z</updated>
    <content type="html">&lt;p&gt;旧版本&lt;/p&gt;</content>
  </entry>
</feed>`

const feed = parseReleaseFeed(feedXml)
assert.ok(feed, '应能解析出 feed')
assert.equal(feed.tagName, 'v1.3.3', '应取第一个条目作为最新版本')
assert.equal(feed.name, 'FrameKit 1.3.3')
assert.equal(feed.publishedAt, '2026-11-24T03:26:57Z')
assert.equal(feed.htmlUrl, 'https://github.com/cola4565/framekit/releases/tag/v1.3.3')
assert.ok(feed.body.includes('新增了视频封面功能'), `正文应去标签并还原实体：${feed.body}`)
assert.ok(!feed.body.includes('<strong>'), '正文应去掉 HTML 标签')
assert.ok(!feed.body.includes('&lt;'), '正文应还原 HTML 实体')

assert.equal(parseReleaseFeed('<feed></feed>'), null)

// --- 资产列表 ---
const assetsHtml = `<li>
  <a href="/cola4565/framekit/releases/download/v1.3.3/FrameKit-1.3.3-Windows-x64.exe" rel="nofollow" class="wb-break-all">
    <span class="text-bold">FrameKit-1.3.3-Windows-x64.exe</span>
  </a>
  <span class="color-fg-muted text-right flex-shrink-0 flex-grow-0 ml-2">126 MB</span>
</li>
<li>
  <a href="/cola4565/framekit/releases/download/v1.3.3/FrameKit-1.3.3-macOS-arm64.dmg" rel="nofollow">
    <span class="text-bold">FrameKit-1.3.3-macOS-arm64.dmg</span>
  </a>
  <span class="color-fg-muted text-right flex-shrink-0 flex-grow-0 ml-2">1.5 GB</span>
</li>`

const assets = parseReleaseAssets(assetsHtml)
assert.equal(assets.length, 2)
assert.equal(assets[0].name, 'FrameKit-1.3.3-Windows-x64.exe')
assert.equal(assets[0].size, 126 * 1024 * 1024)
assert.equal(
  assets[0].browserDownloadUrl,
  'https://github.com/cola4565/framekit/releases/download/v1.3.3/FrameKit-1.3.3-Windows-x64.exe'
)
assert.equal(assets[1].name, 'FrameKit-1.3.3-macOS-arm64.dmg')
assert.equal(assets[1].size, Math.round(1.5 * 1024 * 1024 * 1024))

// --- 自建更新源（update feed） ---
const feedRelease = parseCustomFeed({
  version: '1.4.0',
  notes: '自建源的新版本',
  url: 'https://example.com/releases/1.4.0',
  published_at: '2026-12-01T00:00:00Z',
  assets: [
    {
      name: 'FrameKit-1.4.0-Windows-x64.exe',
      url: 'https://github.com/cola4565/framekit/releases/download/v1.4.0/FrameKit-1.4.0-Windows-x64.exe',
      size: 140000000
    }
  ]
})
assert.ok(feedRelease)
assert.equal(feedRelease.version, '1.4.0')
assert.equal(feedRelease.notes, '自建源的新版本')
assert.equal(feedRelease.assets?.length, 1)

assert.equal(parseCustomFeed({ notes: '没有版本号' }), null)
assert.equal(parseCustomFeed(null), null)
assert.equal(parseCustomFeed('not an object'), null)

// --- GitHub API 资产路由 ---
assert.equal(
  parseAssetApiUrl(
    'https://github.com/cola4565/framekit/releases/download/v1.3.3/FrameKit-1.3.3-Windows-x64.exe',
    'v1.3.3'
  ),
  'https://api.github.com/repos/cola4565/framekit/releases/tags/v1.3.3'
)
assert.equal(
  parseAssetApiUrl(
    'https://github.com/cola4565/framekit/releases/download/v1.3.2/FrameKit-1.3.2-Windows-x64.exe',
    'v1.3.3'
  ),
  null,
  'tag 不匹配时不应给路由'
)
assert.equal(parseAssetApiUrl('https://example.com/a.exe', 'v1.3.3'), null)

const tagResponse = {
  assets: [
    {
      name: 'FrameKit-1.3.3-Windows-x64.exe',
      url: 'https://api.github.com/repos/cola4565/framekit/releases/assets/12345'
    },
    { name: 'other.txt', url: 'https://api.github.com/repos/cola4565/framekit/releases/assets/999' }
  ]
}
assert.equal(
  findAssetApiUrl(tagResponse, 'FrameKit-1.3.3-Windows-x64.exe'),
  'https://api.github.com/repos/cola4565/framekit/releases/assets/12345'
)
assert.equal(findAssetApiUrl(tagResponse, 'missing.exe'), null)
assert.equal(findAssetApiUrl(null, 'x'), null)

// --- 镜像前缀 ---
assert.equal(
  applyMirror(
    'https://mirror.example/',
    'https://github.com/cola4565/framekit/releases/download/v1.3.3/app.exe'
  ),
  'https://mirror.example/https://github.com/cola4565/framekit/releases/download/v1.3.3/app.exe'
)
assert.equal(
  applyMirror('https://mirror.example', 'https://github.com/x/y.exe'),
  'https://mirror.example/https://github.com/x/y.exe',
  '镜像前缀应自动补上斜杠'
)
assert.equal(
  applyMirror('https://mirror.example/', 'https://example.com/a.exe'),
  'https://example.com/a.exe',
  '非 GitHub 地址不走镜像'
)
assert.equal(applyMirror('', 'https://github.com/x/y.exe'), 'https://github.com/x/y.exe')

console.log('PASS github fallback parse smoke: tag, atom feed, asset list, custom feed, api route and mirror')
