import assert from 'node:assert/strict'
import {
  extractLayerId,
  extractWeiboMid,
  isWeiboPageUrl,
  isWeiboVideoUrl,
  toWeiboVideoPageUrl
} from '../electron/weibo'

// 微博视频地址的两种形态
const profile =
  'https://weibo.com/u/7871239944?tabtype=newVideo&layerid=5367298737311369'
const tvShow = 'https://weibo.com/tv/show/1034:5367286987685917?from=old_pc_videoshow'

assert.equal(isWeiboPageUrl(profile), true)
assert.equal(isWeiboPageUrl(tvShow), true)
assert.equal(isWeiboPageUrl('https://www.bilibili.com/video/BV1xx'), false)

assert.equal(isWeiboVideoUrl(profile), true, '带 layerid 的列表页应识别为视频地址')
assert.equal(isWeiboVideoUrl(tvShow), true, 'tv/show 应识别为视频地址')
assert.equal(
  isWeiboVideoUrl('https://weibo.com/u/7871239944?tabtype=newVideo'),
  false,
  '没有 layerid 的主页不算视频地址'
)
assert.equal(isWeiboVideoUrl('https://www.bilibili.com/video/BV1xx'), false)

// layerid 就是被点开那条视频的 mid
assert.equal(extractLayerId(profile), '5367298737311369')
assert.equal(extractLayerId(tvShow), null)
assert.equal(extractLayerId('https://weibo.com/u/1?layerid=abc'), null)

// mid 的三种来源
assert.equal(extractWeiboMid(profile), '5367298737311369')
assert.equal(extractWeiboMid(tvShow), '5367286987685917')
assert.equal(extractWeiboMid('https://weibo.com/detail/5367286987685917'), '5367286987685917')
assert.equal(extractWeiboMid('https://m.weibo.cn/detail/5367286987685917'), '5367286987685917')
assert.equal(extractWeiboMid('https://weibo.com/u/7871239944'), null)

// 改写成单条视频页
assert.equal(
  toWeiboVideoPageUrl(profile),
  'https://weibo.com/tv/show/1034:5367298737311369'
)
assert.equal(toWeiboVideoPageUrl(tvShow), tvShow, '已经是视频页的地址保持原样')

console.log('PASS weibo smoke: mid / layerid 解析与视频地址识别')
