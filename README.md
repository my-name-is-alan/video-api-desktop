# YCDownload

YCDownload 是一个“轻 Tauri 壳 + 授权中间件 + 真实业务后端”的桌面工具。Tauri 只负责展示界面、读取本机指纹和保存授权会话；真实下载、解析和其它复杂业务应通过授权中间件转发到后端，不要在安装包内写入后端密钥。

## 本地开发

```bash
npm install
copy server\.env.example server\.env  # PowerShell 可使用 Copy-Item
# 必须设置内部 UPSTREAM_URL；再设置 ADMIN_TOKEN、KEY_PEPPER、UPSTREAM_TOKEN
npm run build
npm run server:start
npm run tauri:dev
```

管理员控制台：<http://127.0.0.1:8787/admin>。首次启动会在 `server/data/licenses.json` 创建本地数据文件（已被 git 忽略）。这是单实例轻量存储；多实例生产部署应把 `licenses/sessions/usage` 迁移到 PostgreSQL/Redis，并把管理员页放到 HTTPS 反向代理之后。生产环境必须替换 `.env.example` 中的两个 `change-me` 默认值，并使用 HTTPS 反向代理。

### 网关边界

上游服务地址只存在于服务端的 `UPSTREAM_URL` 环境变量中。不会出现在客户端、健康检查、管理员页面、公开文档或 OpenAPI 响应里；App 只能访问授权网关的 `/api/*`。

## 授权流程

1. Tauri 原生层收集操作系统/架构、MAC、时区、语言、主板序列、内存和磁盘信息。
2. 原始值只在本机参与 SHA-256 合并，WebView 和服务端只收到 `YC1-...` 设备码，不上传硬件明细。
3. `POST /api/license/activate` 首次使用卡密时绑定设备码，并返回 30 天会话令牌。再次激活必须是同一设备。
4. 所有业务请求走 `/api/proxy/*`，服务端校验卡密状态、有效期、设备和“最多调用”配额；图表页面调用 `/api/usage/chart-view` 消耗独立的图表观看配额。

设备码是稳定的伪匿名标识，不是无法破解的 DRM。真正的权限边界在服务端；不要把 `KEY_PEPPER`、管理员令牌或上游凭据编译进 Tauri。
由于时区/语言也参与合并，用户主动修改系统区域后可能产生新设备码；换机或此类变更由管理员使用 `unbind` 后重新激活。支付渠道/订单系统尚未包含在这一层，当前由管理员批量生成卡密后交付。

## 中间件接口

| 接口 | 作用 |
| --- | --- |
| `POST /api/license/activate` | `{ key, deviceCode }` 激活并绑定单设备 |
| `GET /api/license/validate` | `Authorization: Bearer <token>` + `x-device-code` 校验会话 |
| `POST /api/usage/chart-view` | 消耗一次图表观看次数 |
| `ANY /api/proxy/*` | 在授权和配额通过后转发到服务端配置的受保护业务服务 |
| `GET /api/admin/overview` | 管理员统计和近 14 日调用图表 |
| `GET/POST/PATCH /api/admin/licenses` | 查询、批量生成、更新卡密 |
| `POST .../:id/revoke` | 撤销/恢复卡密 |
| `POST .../:id/reset-usage` | 重置调用和图表计数 |
| `POST .../:id/unbind` | 管理员处理换机，清除设备绑定并使旧会话失效 |
| `GET .../:id/expiry-check?at=...` | 只读到期测试，可传未来 ISO 时间，不修改卡密 |

完整机器可读说明见 <http://127.0.0.1:8787/docs>，合并后的 OpenAPI 见 <http://127.0.0.1:8787/openapi.json>（包含授权层和受保护业务代理路径）。

### Docker

```bash
npm run build
docker build -f server/Dockerfile -t ycdownload-license .
docker run --rm -p 8787:8787 --env-file server/.env -e BIND=0.0.0.0 -v ${PWD}/server/data:/app/server/data ycdownload-license
```

容器默认监听 `0.0.0.0:8787`；上游地址只由容器内的 `UPSTREAM_URL` 注入，绝不会返回给客户端。

## 构建

```bash
npm run build
npm run tauri:build
```

## 影视媒体能力

界面使用 React Spectrum 2（`@react-spectrum/s2`）Provider、Tabs、Card、TextField、SearchField、Button、ProgressBar 和 StatusLight，提供媒体浏览和下载队列。用户从接口返回的作品/集数直接点击“一键下载”，Emby `.nfo` 是下载成功后的自动副产物，不提供独立编辑工作台。

桌面端媒体能力位于 `src-tauri/src/media.rs`：

- `get_media_tools_status`：检查 FFmpeg / FFprobe 是否可用
- `probe_media`：供下载流程读取容器、时长、大小、分辨率及音视频编码
- `merge_collections`：使用 FFmpeg concat demuxer 合并多个已下载集合，保持无损封装
- `generate_emby_nfo` / `write_emby_nfo`：由下载完成流程根据接口元数据生成并写入 Emby `.nfo`

工具按以下优先级查找：`YCDOWNLOAD_FFMPEG` / `YCDOWNLOAD_FFPROBE` 环境变量、安装目录中的可执行文件、安装目录 `binaries` 子目录，最后回退到系统 `PATH`。如需随 Windows 安装包发布，请将带 target triple 的文件放入 `src-tauri/binaries/`，并在 `tauri.conf.json` 的 `bundle.externalBin` 中声明对应的 `binaries/ffmpeg` 和 `binaries/ffprobe`；仓库不直接提交第三方二进制文件。

iOS 端不能直接启动本地 FFmpeg 进程，后续应将合并能力抽到服务端或接入系统媒体框架；当前 FFmpeg 仅用于桌面端多集合合并，应用不提供播放功能。

前端入口为 `src/App.tsx`，管理员前端入口为 `src/admin/AdminApp.tsx`，授权客户端为 `src/license.ts`，媒体命令为 `src-tauri/src/media.rs`，Tauri 原生入口和设备指纹实现为 `src-tauri/src/lib.rs`，服务端为 `server/server.mjs`。管理员页由 Vite 生成 `dist/admin.html` 和独立资源，不在 Node 服务里拼接 HTML。

App 端完整对接步骤见 [`docs/APP_INTEGRATION.md`](docs/APP_INTEGRATION.md)。
