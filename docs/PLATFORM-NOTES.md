# 站点与官方接口说明

本文记录 FrameKit 对爱给网（aigei.com）与抖音（douyin.com）的实现边界，避免把“能看见页面”误认为“拥有下载授权”。

## 爱给网会员与页面权限

爱给网的页面入口和官方 API（Application Programming Interface，应用程序接口）是两套不同授权体系：

- 搜索结果页通常公开 300×168 等低清预览片段，适合确认素材内容，但不等于原片下载权。
- 条目页可以读取站点展示的规格，例如 `1080P · 1920 x 1080 · 11m` 与 `720P · 1280 x 720 · 269k`；未登录时点击下载会进入登录提示，而不是直接返回原片地址。
- 登录后仍可能受 VIP（会员）、铜币、单条素材定价、商用授权、下载次数或账号状态限制。不同素材、清晰度、格式和授权范围的价格与可用性可能不同。
- FrameKit 只调用页面正常的登录与下载入口，并跳过被站点拦截的规格；不绕过验证码、登录、会员、付费或版权限制。
- 具体会员权益、铜币价格和商用许可以爱给网页面当前展示与官方协议为准，应用不应硬编码成永久不变的结论。

## 爱给网官方 API 权限

公开资料显示，爱给网开放平台使用独立的 API Key 与资源授权，并不会把网页上的所有素材自动开放给 API：

- 基址：`https://www.aigei.com/open/api/v1/video`
- 搜索：`POST /search`
- 下载：`GET /download?fileId=<文件 ID>`
- 鉴权：`Authorization: Bearer <API Key>`
- 官方 MCP（Model Context Protocol，模型上下文协议）入口：[https://www.aigei.com/mcp](https://www.aigei.com/mcp)
- 开源参考实现：[harry0703/MoneyPrinterTurbo · app/services/aigei.py](https://github.com/harry0703/MoneyPrinterTurbo/blob/main/app/services/aigei.py)

从该参考实现可以确认以下限制：

- API Key 有独立授权范围，错误或失效的 Key 会被拒绝。
- 搜索有额度限制，下载可能消耗铜币或账户余额；余额不足、额度耗尽或账号被限制时会返回对应错误。
- 平台存在约 `10 QPS（Queries Per Second，每秒查询次数）` 的请求频率限制，批量任务需要主动限速。
- 搜索结果只返回获得 API 授权的文件版本；参考实现对文件格式、大小、时长、画幅与报价做了二次筛选，不能假设网页上所有清晰度、源文件或商用素材都可用。
- 下载接口返回的是带签名、带时效的地址，不适合长期缓存或公开转发。
- API 授权、会员权益与商用版权是不同层面的限制；即使技术上下载成功，也不代表自动获得商用许可。

因此：**官方 API 不是网页资源的全量下载通道，也不能替代用户自己的账号登录与授权。**

## 抖音解析边界

- 抖音网页通常使用 DASH（Dynamic Adaptive Streaming over HTTP，动态自适应流媒体），视频流与音频流分开传输。
- FrameKit 使用独立持久会话捕获 `media-video-*` / `media-audio-*` 流，并按同一播放会话的 `l` 参数配对，再用内置 ffmpeg 合并为标准 MP4。
- 登录窗口只用于完成抖音站点正常登录，登录 Cookie 保存在本机 `persist:douyin` 会话中。
- 私密作品、地区限制、验证码、DRM（Digital Rights Management，数字版权管理）或账号无权访问的内容不会被绕过。

