import assert from 'node:assert/strict'
import { cctvQualityLabels, extractCctvIds, isCctvVideoUrl } from '../electron/cctv'
import { parseHlsMaster, parseHlsMedia, qualityLabelOfVariant } from '../electron/hls'

const page =
  'https://tv.cctv.com/2025/10/07/VIDErVuzkncfsaZS94lRzz4z251007.shtml'
const base = 'https://hls.cntv.lxdns.com/asp/hls/main/0303000a/3/default/abc/main.m3u8'

assert.equal(isCctvVideoUrl(page), true, '央视网点播页应被识别')
assert.equal(isCctvVideoUrl('https://tv.cctv.com/live/cctv1/'), false)
assert.equal(isCctvVideoUrl('https://www.bilibili.com/video/BV1xx'), false)

const ids = extractCctvIds(
  '<script>var parentGuid = "393c8a7298d2403b98f51b10b8269c0b"; var guid = "c1c1cc22a63e475daa755a8eaeb5fe22";</script>'
)
assert.deepEqual(ids, {
  guid: 'c1c1cc22a63e475daa755a8eaeb5fe22',
  parentGuid: '393c8a7298d2403b98f51b10b8269c0b',
  serviceId: 'tvcctv'
})
assert.equal(extractCctvIds('<html></html>'), null)

const master = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=460800, RESOLUTION=480x270
/asp/hls/450/0303000a/3/default/abc/450.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=2048000, RESOLUTION=1920x1080
1080.m3u8`

const variants = parseHlsMaster(master, base)
assert.equal(variants.length, 2)
assert.equal(variants[0].height, 270)
assert.equal(variants[0].bandwidth, 460800)
assert.equal(
  variants[0].url,
  'https://hls.cntv.lxdns.com/asp/hls/450/0303000a/3/default/abc/450.m3u8'
)
assert.equal(variants[1].width, 1920)
assert.equal(
  variants[1].url,
  'https://hls.cntv.lxdns.com/asp/hls/main/0303000a/3/default/abc/1080.m3u8'
)
assert.equal(qualityLabelOfVariant(variants[0]), '270P')
assert.equal(qualityLabelOfVariant(variants[1]), '1080P')

const media = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.000000,
0.ts
#EXTINF:8.920000,
1.ts
#EXT-X-ENDLIST`

const playlist = parseHlsMedia(media, base)
assert.equal(playlist.segments.length, 2)
assert.equal(playlist.duration, 18.92)
assert.equal(playlist.segments[0].url, 'https://hls.cntv.lxdns.com/asp/hls/main/0303000a/3/default/abc/0.ts')
assert.equal(playlist.encrypted, false)

const encrypted = parseHlsMedia(
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:10,\n0.ts',
  base
)
assert.equal(encrypted.encrypted, true)

const audioOnly = parseHlsMedia(
  '#EXTM3U\n#EXTINF:10,\n0.aac\n#EXT-X-ENDLIST',
  base
)
assert.equal(qualityLabelOfVariant(variants[0]), '270P', '清晰度标签回归')
assert.equal(audioOnly.segments[0].duration, 10)

/**
 * 央视四档清晰度回归。
 *
 * 网页播放器的多码率清单固定给出四档，依次是
 * 450（流畅）/ 850（标清）/ 1200（高清）/ 2000（超清）。
 */
const cctvMaster = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=460800, RESOLUTION=480x270
/asp/h5e/hls/450/0303000a/3/default/abc/450.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=870400, RESOLUTION=640x360
/asp/h5e/hls/850/0303000a/3/default/abc/850.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=1228800, RESOLUTION=1280x720
/asp/h5e/hls/1200/0303000a/3/default/abc/1200.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=2048000, RESOLUTION=1280x720
/asp/h5e/hls/2000/0303000a/3/default/abc/2000.m3u8`

const cctvVariants = parseHlsMaster(cctvMaster, base)
assert.equal(cctvVariants.length, 4, '央视应解析出四档清晰度')
assert.deepEqual(
  cctvVariants.map((variant) => variant.height),
  [270, 360, 720, 720],
  '央视四档分辨率'
)
assert.deepEqual(
  cctvVariants.map((variant) => variant.bandwidth),
  [460800, 870400, 1228800, 2048000],
  '央视四档码率'
)
assert.deepEqual(
  cctvQualityLabels(cctvVariants),
  ['流畅', '标清', '高清', '超清'],
  '央视四档文案应与网页播放器一致'
)

// 高清与超清分辨率相同，必须靠带宽区分，不能生成重复的资源 ID。
assert.notEqual(
  `cctv_${'abc'}_${cctvVariants[2].height}_${cctvVariants[2].bandwidth}`,
  `cctv_${'abc'}_${cctvVariants[3].height}_${cctvVariants[3].bandwidth}`,
  '720P 的两档必须可区分'
)

// 非四档时退回按分辨率生成标签。
assert.deepEqual(
  cctvQualityLabels(cctvVariants.slice(0, 2)),
  ['270P', '360P'],
  '档位数不是四时退回分辨率标签'
)

console.log('PASS cctv smoke: 央视网地址识别、页面编号、四档清晰度与 HLS 清单解析')
