# YCDownload App 端对接授权中间件

本文说明 Tauri/React 客户端如何接入授权服务。客户端只知道授权网关地址，不应该知道受保护业务服务的位置。所有搜索、解析、下载、图表等业务请求都必须经过中间件的 `/api/proxy/*`。

## 1. 地址和启动方式

本地开发默认地址：

```text
授权中间件：http://127.0.0.1:8787
```

启动：

```powershell
npm run build
npm run server:start
npm run tauri:dev
```

App 端通过 `VITE_LICENSE_SERVER_URL` 配置授权服务地址。生产环境应配置为 HTTPS 域名，例如：

```text
VITE_LICENSE_SERVER_URL=https://license.example.com
```

不要把 `ADMIN_TOKEN`、`KEY_PEPPER`、`UPSTREAM_TOKEN` 或真实后端地址编译到安装包内。

## 2. 获取设备码

Tauri 原生命令 `get_device_fingerprint` 会在本机读取以下信息：操作系统/架构、MAC、时区、语言、主板、内存、磁盘。原始值只在 Rust 进程内参与 SHA-256 合并，App 和服务端只使用 `YC1-...` 设备码。

```ts
import { invoke } from '@tauri-apps/api/core'

type DeviceFingerprint = {
  deviceCode: string
  operatingSystem: string
  macAddress: string
  timezone: string
  language: string
  motherboard: string
  memory: string
  disk: string
}

const fingerprint = await invoke<DeviceFingerprint>('get_device_fingerprint')
// 只把 fingerprint.deviceCode 发给授权服务
```

当前仓库的封装是 [`src/license.ts`](../src/license.ts)。浏览器开发模式没有 Tauri IPC 时会生成 `WEB1-...` 测试设备码；正式桌面包必须使用 Tauri 原生命令。

## 3. 首次激活卡密

请求：

```http
POST /api/license/activate
Content-Type: application/json

{
  "key": "YC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX",
  "deviceCode": "YC1-..."
}
```

成功响应：

```json
{
  "token": "<opaque-session-token>",
  "status": "active",
  "license": {
    "id": "...",
    "keyPrefix": "YC-ABCDE",
    "status": "active",
    "deviceCode": "YC1-...",
    "expiresAt": "2035-01-01T00:00:00.000Z",
    "maxCalls": 100,
    "usedCalls": 0,
    "maxChartViews": 20,
    "usedChartViews": 0
  }
}
```

激活规则：

- 卡密第一次激活时绑定 `deviceCode`。
- 同一卡密提交不同设备码返回 HTTP `409 device_mismatch`。
- 卡密只保存服务端哈希，明文卡密只在管理员生成时展示一次。
- 当前封装会优先使用 `localStorage`，并在 Tauri 桌面端同步到应用数据目录的 `license-token` 作为 dev origin 变化后的持久化兜底；生产建议替换为 Tauri OS Keychain/凭据存储，避免明文持久化。

客户端调用示例：

```ts
import { activateLicense, getDeviceFingerprint } from './license'

const { deviceCode } = await getDeviceFingerprint()
const result = await activateLicense(inputKey, deviceCode)
console.log(result.license.expiresAt)
```

## 4. 启动时校验会话

App 启动后读取本地 token，并携带当前设备码校验：

```http
GET /api/license/validate
Authorization: Bearer <token>
x-device-code: YC1-...
```

HTTP `200` 表示可以继续使用；以下情况应删除本地 token 并显示激活页：

- HTTP `401 unauthorized`：token 不存在、过期或卡密已被撤销
- HTTP `409 device_mismatch`：设备码变化或被篡改
- HTTP `403 expired`：卡密已到期

仓库中的 `validateLicense(deviceCode)` 已包含无效 token 清理逻辑。

## 5. 代理真实业务请求

真实业务路径只需要在 `/api/proxy` 后拼接原后端路径。例如真实后端存在 `GET /api/search?q=关键词`：

```http
GET /api/proxy/api/search?q=关键词
Authorization: Bearer <token>
x-device-code: YC1-...
```

TypeScript 推荐使用：

```ts
import { getDeviceFingerprint, proxyBackend } from './license'

const { deviceCode } = await getDeviceFingerprint()
const searchResult = await proxyBackend<unknown>(
  '/api/search?q=' + encodeURIComponent(keyword),
  deviceCode,
)
```

POST/PUT/PATCH/DELETE 的 JSON 请求同样走代理：

```ts
await proxyBackend('/api/jobs', deviceCode, {
  method: 'POST',
  body: JSON.stringify({ /* 真实后端请求参数 */ }),
})
```

中间件会在服务端固定拼接内部业务地址，不会使用客户端提交的目标主机，因此客户端无法通过修改 URL 绕过收费层。公开给 App 的接口清单以授权网关 `/openapi.json` 为准。

## 6. 图表观看配额

每次真正打开图表前调用一次：

```http
POST /api/usage/chart-view
Authorization: Bearer <token>
x-device-code: YC1-...
Content-Type: application/json

{}
```

返回：

```json
{ "allowed": true, "remaining": 19 }
```

只有返回 `allowed: true` 才渲染图表；HTTP `429 chart_quota_exhausted` 时显示“图表观看次数已用尽”。封装函数为 `countChartView(deviceCode)`。

## 7. 调用次数和错误处理

`/api/proxy/*` 每通过授权检查就预扣一次 `usedCalls`，这样并发请求不会超出上限；即使上游网络失败，该次尝试也会计入调用量。达到上限返回 HTTP `429 call_quota_exhausted`。

常见错误码：

| HTTP | error | 客户端处理 |
| --- | --- | --- |
| 401 | `unauthorized` | 清理 token，回到激活页 |
| 403 | `invalid_key` / `expired` / `revoked` | 展示卡密状态，不重试 |
| 409 | `device_mismatch` | 提示联系管理员换机解绑 |
| 429 | `call_quota_exhausted` | 禁用业务入口，提示调用次数用尽 |
| 429 | `chart_quota_exhausted` | 不渲染图表，提示观看次数用尽 |
| 502 | `upstream_unavailable` | 展示后端暂时不可用，可有限重试 |

## 8. 管理员和联调检查

管理员页面：`http://127.0.0.1:8787/admin`。管理员令牌通过 `Authorization: Bearer <ADMIN_TOKEN>` 传递，不要放进 App。

完整中间件说明：`http://127.0.0.1:8787/docs`。

联调顺序建议：

1. `GET /health` 确认授权服务启动。
2. 管理员生成一张短期测试卡密。
3. App 用当前设备码激活，再用另一串设备码确认 `device_mismatch`。
4. 调用真实后端的 `/api/health` 或 `/api/search`，确认请求只经过 `/api/proxy/*`。
5. 将 `maxChartViews` 设为 `1`，第二次图表请求确认 `chart_quota_exhausted`。
6. 用 `/api/admin/licenses/:id/expiry-check?at=未来 ISO 时间` 验证到期分支。

设备码并不是硬件级 DRM；客户端可以被逆向或伪造。收费和权限的最终边界必须保持在服务端。当前服务端 JSON 文件适合单实例联调，多实例生产应迁移到 PostgreSQL/Redis。

## 9. 受保护业务接口（通过收费层代理）

当前中间件只在服务端读取内部 OpenAPI，并在 `http://127.0.0.1:8787/openapi.json` 输出脱敏后的合并 OpenAPI。业务路径会自动加上 `/api/proxy` 前缀：

```text
业务接口：GET /api/search?q=关键词
App 端： GET /api/proxy/api/search?q=关键词
```

每个代理请求都必须带：

```http
Authorization: Bearer <license-session-token>
x-device-code: YC1-...
```

代理会原样转发 HTTP 方法、查询参数和 JSON 请求体，并把服务端配置的内部凭据注入业务服务；App 端绝不能直接请求内部业务服务。

### CDN 直链

#### `GET /api/proxy/api/library`

本地剧库列表，无参数。

当前空库响应：

```json
{ "series": [], "count": 0 }
```

#### `GET /api/proxy/api/search?q={q}`

本地剧库搜索。`q` 可选，含剧名、单集标题或 `vid`。

```json
{ "hits": [], "count": 0 }
```

#### `GET /api/proxy/api/series/{sid}`

本地剧集明细。路径参数 `sid` 为剧集 ID。未先抓取时返回 404，提示先调用 `/api/series/{sid}/fetch`。

成功响应示例：

```json
{ "seriesId": "...", "title": "...", "episodes": [{ "ep": 1, "vid": "..." }], "totalEps": 2 }
```

#### `GET /api/proxy/api/ep/{vid}`

单集本地信息。路径参数 `vid` 为视频 ID；没有本地明文时返回 404。

#### `GET /api/proxy/api/ep/{vid}/cdn?quality=1080p`

获取 CDN 直链和该集专属解密 key。`quality` 可选：`1080p`、`720p`、`540p`、`480p`、`360p`，默认 `1080p`。

响应字段：

```json
{
  "vid": "...",
  "quality": "1080p",
  "url": "https://...",
  "backupUrls": ["https://..."],
  "urlExpire": 1788186190,
  "duration": 63.972,
  "key": "<episode-key>",
  "vmVid": "...",
  "via": "anon"
}
```

`url` 和 `backupUrls` 是有时效的签名地址，只应在实际下载请求期间使用，不要持久化到 Key 管理系统；YCDownload 不提供媒体播放功能。

### 网站抓取

#### `GET /api/proxy/api/web/category`

分类剧集分页，响应包含 `vidList`。查询参数：

- `page_num`：页码，整数，最小 1，默认 1。
- `size`：每页条数，整数 1–24，默认 24。
- `sort_type`：`1` 最热、`2` 最新，可空。
- `gender`：`1` 男频、`0` 女频，可空。
- `background`、`topic`、`setting`、`time`：分类筛选值，格式如 `cate_xxx`，可空。

响应结构：

```json
{
  "pageNum": 1,
  "pageSize": 24,
  "total": 463,
  "series": [{
    "seriesId": "...", "seriesName": "...", "seriesCover": "https://...",
    "episodeCnt": 5, "intro": "...", "tags": ["爱情"],
    "celebrities": [{ "nickname": "...", "avatar": "https://...", "sub_title": "...", "celebrity_id": "..." }],
    "vidList": ["..."]
  }]
}
```

#### `GET /api/proxy/api/web/category/filters`

分类导航选项。返回对象包含 `背景`、`主题`、`设定`、`受众`、`时间` 等分类数组；数组内容随上游数据变化。

#### `GET /api/proxy/api/web/rank/{name}?page=1`

榜单分页。`name` 必须是：`hot-drama`（红果热播）、`hot-real-drama`（真人剧）、`hot-ai-drama`（AI 剧）、`hot-comic-drama`（漫剧）。`page` 为大于等于 1 的整数，默认 1。

响应结构：

```json
{
  "name": "红果热播榜", "route": "hot-drama", "page": 1,
  "items": [{
    "rank": 1, "seriesId": "...", "title": "...", "cover": "https://...",
    "heat": "7437万", "score": "9.1", "favorites": "134.8万", "likes": "601.5万",
    "tags": ["都市"], "intro": "...", "epCnt": 3, "firstVid": "..."
  }],
  "count": 20
}
```

#### `GET /api/proxy/api/web/search?q={q}`

站内搜索，直接抓取 SSR 搜索页。`q` 可选，支持剧名或演员。

响应结构：

```json
{
  "actors": [],
  "series": [{
    "seriesId": "...", "title": "...", "cover": "https://...",
    "tags": ["剧情"], "actors": "", "intro": "...",
    "vidList": ["..."], "firstVid": "...", "episodeCnt": 38
  }],
  "count": 10
}
```

#### `POST /api/proxy/api/web/search/db/build?max_pages=60`

全量抓取分类并落盘元数据缓存，不是普通搜索必需接口。`max_pages` 为 1–100 的整数，默认 60。该接口会产生实际抓取工作，App 不应在启动时自动调用。

#### `GET /api/proxy/api/web/series/{sid}`

站内单剧详情和视频列表。`sid` 为剧集 ID。

```json
{ "seriesId": "...", "title": "...", "episodes": [{ "ep": 1, "vid": "..." }], "totalEps": 2 }
```

### 任务和批量下载

#### `POST /api/proxy/api/series/{sid}/fetch`

后台获取整剧清单。`sid` 为剧集 ID。成功响应由任务实现决定，通常包含任务 ID 或抓取结果；此接口会产生后台工作。

#### `POST /api/proxy/api/series/{sid}/download?quality=1080p`

后台下载并解密整剧（`batch_1080p`）。`sid` 为剧集 ID；`quality` 可选 `1080p`、`720p`、`540p`、`480p`、`360p`，默认 `1080p`。该请求会产生真实下载任务，不能用健康检查代替。

#### `GET /api/proxy/api/jobs`

任务列表。当前无任务响应：

```json
{ "jobs": [] }
```

#### `GET /api/proxy/api/jobs/{jid}`

任务状态和日志尾部。`jid` 为任务 ID。响应字段由任务类型决定，客户端至少应保留 `jid` 并轮询直到任务完成/失败。

### 系统

#### `GET /api/proxy/api/health`

业务服务环境体检，无业务参数。收费层会移除服务端文件路径和文档入口，只返回安全字段：

```json
{
  "ok": true,
  "time": "2026-08-31 16:21:41"
}
```

### 上游统一错误

业务服务对路径参数、查询参数校验失败返回 HTTP `422`，格式为：

```json
{
  "detail": [{ "loc": ["query", "page"], "msg": "...", "type": "..." }]
}
```

业务资源不存在通常返回 HTTP `404` 和字符串 `detail`。收费层自身错误仍按本文第 7 节处理；当内部业务服务无法连接时，收费层返回 HTTP `502 upstream_unavailable`。

## 10. 机器可读文档

App 或接口工具不要手抄字段，直接导入：

```text
http://127.0.0.1:8787/openapi.json
```

该文件包含：

- `/api/license/*` 授权接口
- `/api/usage/chart-view` 图表配额接口
- `/api/proxy/*` 收费层代理路径
- 从内部 OpenAPI 合并来的全部业务方法、参数和 422 响应定义

业务 OpenAPI 没有为大多数业务响应声明强类型 schema，因此上面给出的响应示例来自当前服务端联调数据，字段可能随着业务数据变化；客户端应按字段存在性兼容处理。
