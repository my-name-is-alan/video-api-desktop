import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

function loadDotEnv(file) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match || match[2].startsWith('#') || process.env[match[1]] !== undefined) continue
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
}

loadDotEnv(join(root, '.env'))

const dataDir = join(root, 'data')
const dataFile = join(dataDir, 'licenses.json')
const distDir = normalize(join(root, '..', 'dist'))
const port = Number(process.env.PORT || 8787)
const bind = process.env.BIND || '127.0.0.1'
const upstream = (process.env.UPSTREAM_URL || '').replace(/\/$/, '')
const upstreamToken = process.env.UPSTREAM_TOKEN || ''
const adminToken = process.env.ADMIN_TOKEN || 'change-me-in-production'
const keyPepper = process.env.KEY_PEPPER || 'change-me-in-production'

if (adminToken === 'change-me-in-production' || keyPepper === 'change-me-in-production') console.warn('WARNING: set ADMIN_TOKEN and KEY_PEPPER before exposing the license server')
if (!upstream) throw new Error('UPSTREAM_URL is required on the server')

const emptyStore = () => ({ licenses: [], sessions: [], usage: [] })
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
if (!existsSync(dataFile)) writeFileSync(dataFile, JSON.stringify(emptyStore(), null, 2))
let store = readStore()
let writeQueue = Promise.resolve()
let upstreamOpenApiCache = null

function readStore() {
  try { return { ...emptyStore(), ...JSON.parse(readFileSync(dataFile, 'utf8')) } } catch { return emptyStore() }
}
function persist() {
  writeQueue = writeQueue.then(() => writeFileSync(dataFile, JSON.stringify(store, null, 2)))
  return writeQueue
}
function now() { return new Date().toISOString() }
function id() { return randomBytes(12).toString('hex') }
function hash(value) { return createHash('sha256').update(`${keyPepper}:${value}`).digest('hex') }
function safeEqual(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}
function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(payload))
}
function error(res, status, message, code = 'bad_request') { json(res, status, { error: code, message }) }
function keyFormat(value) { return String(value || '').trim().toUpperCase().replace(/\s+/g, '') }
function limit(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0 }
function expiry(value) {
  if (value === null || value === undefined || value === '') return null
  const time = Date.parse(String(value)); if (!Number.isFinite(time)) throw new Error('expiresAt 必须是有效的 ISO 日期')
  return new Date(time).toISOString()
}
function makeKey() {
  const bytes = randomBytes(15).toString('hex').toUpperCase()
  return `YC-${bytes.slice(0, 5)}-${bytes.slice(5, 10)}-${bytes.slice(10, 15)}-${bytes.slice(15, 20)}-${bytes.slice(20, 30)}`
}
function publicLicense(license) { const safe = { ...license }; delete safe.keyHash; delete safe.lastIp; return safe }
function isExpired(license, at = Date.now()) { return Boolean(license.expiresAt && new Date(license.expiresAt).getTime() <= at) }
function statusAt(license, at = Date.now()) {
  if (license.status === 'revoked') return 'revoked'
  if (isExpired(license, at)) return 'expired'
  if (license.maxCalls > 0 && license.usedCalls >= license.maxCalls) return 'quota_exhausted'
  return 'active'
}
function statusOf(license) { return statusAt(license) }
function getLicenseByKey(key) {
  const keyHash = hash(keyFormat(key)); return store.licenses.find((license) => safeEqual(license.keyHash, keyHash))
}
function getSession(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const session = store.sessions.find((item) => safeEqual(item.tokenHash, hash(token)))
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null
  const license = store.licenses.find((item) => item.id === session.licenseId)
  if (!license || statusOf(license) !== 'active') return null
  return { session, license }
}
function requireAdmin(req, res) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  if (!safeEqual(token, adminToken)) { error(res, 401, '管理员令牌无效', 'admin_unauthorized'); return false }
  return true
}
async function body(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('请求体不能超过 1 MB'); chunks.push(chunk) }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('请求体必须是 JSON') }
}
function usageDay(at = new Date()) { return at.toISOString().slice(0, 10) }
function recordUsage(license, type, req) {
  const day = usageDay(); let item = store.usage.find((entry) => entry.day === day && entry.licenseId === license.id)
  if (!item) { item = { day, licenseId: license.id, calls: 0, chartViews: 0 }; store.usage.push(item) }
  item[type] += 1; license.lastSeenAt = now(); license.lastIp = req.socket.remoteAddress || null
}
function checkDevice(license, deviceCode) {
  if (!deviceCode || typeof deviceCode !== 'string' || deviceCode.length < 16) return '设备码无效'
  if (license.deviceCode && !safeEqual(license.deviceCode, deviceCode)) return '卡密已绑定到另一台设备'
  return null
}
function bindDevice(license, deviceCode) { if (!license.deviceCode) { license.deviceCode = deviceCode; license.deviceBoundAt = now() } }

async function activate(req, res) {
  let input; try { input = await body(req) } catch (e) { return error(res, 400, e.message) }
  const license = getLicenseByKey(keyFormat(input.key)); const deviceCode = String(input.deviceCode || '')
  if (!license) return error(res, 404, '卡密不存在', 'invalid_key')
  const status = statusOf(license); if (status !== 'active') return error(res, 403, `卡密当前不可用：${status}`, status)
  const deviceError = checkDevice(license, deviceCode); if (deviceError) return error(res, 409, deviceError, 'device_mismatch')
  bindDevice(license, deviceCode)
  const token = randomBytes(32).toString('base64url')
  store.sessions = store.sessions.filter((item) => item.licenseId !== license.id)
  store.sessions.push({ id: id(), licenseId: license.id, tokenHash: hash(token), createdAt: now(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() })
  license.lastActivatedAt = now(); await persist()
  return json(res, 200, { token, license: publicLicense(license), status: statusOf(license) })
}
async function validate(req, res) {
  const auth = getSession(req); if (!auth) return error(res, 401, '授权会话无效或已过期', 'unauthorized')
  if (checkDevice(auth.license, String(req.headers['x-device-code'] || ''))) return error(res, 409, '设备不匹配', 'device_mismatch')
  return json(res, 200, { status: statusOf(auth.license), license: publicLicense(auth.license) })
}
async function chartView(req, res) {
  const auth = getSession(req); if (!auth) return error(res, 401, '授权会话无效或已过期', 'unauthorized')
  if (checkDevice(auth.license, String(req.headers['x-device-code'] || ''))) return error(res, 409, '设备不匹配', 'device_mismatch')
  const license = auth.license
  if (license.maxChartViews > 0 && license.usedChartViews >= license.maxChartViews) return error(res, 429, '图表观看次数已用尽', 'chart_quota_exhausted')
  license.usedChartViews += 1; recordUsage(license, 'chartViews', req); await persist()
  return json(res, 200, { allowed: true, remaining: license.maxChartViews > 0 ? Math.max(license.maxChartViews - license.usedChartViews, 0) : null })
}
async function proxy(req, res, pathname) {
  const auth = getSession(req); if (!auth) return error(res, 401, '请先激活卡密', 'unauthorized')
  const deviceError = checkDevice(auth.license, String(req.headers['x-device-code'] || '')); if (deviceError) return error(res, 409, deviceError, 'device_mismatch')
  const license = auth.license
  if (license.maxCalls > 0 && license.usedCalls >= license.maxCalls) return error(res, 429, '调用次数已用尽', 'call_quota_exhausted')
  let payload = {}
  if (!['GET', 'HEAD'].includes(req.method)) { try { payload = await body(req) } catch (e) { return error(res, 400, e.message) } }
  license.usedCalls += 1; recordUsage(license, 'calls', req); await persist()
  const target = `${upstream}${pathname.replace(/^\/api\/proxy/, '')}${new URL(req.url, 'http://localhost').search}`
  const headers = { accept: req.headers.accept || 'application/json', 'content-type': req.headers['content-type'] || 'application/json', 'x-yc-license-id': license.id }
  if (upstreamToken) headers.authorization = `Bearer ${upstreamToken}`
  const response = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(payload) }).catch((e) => ({ error: e }))
  if (response.error) return error(res, 502, '业务服务暂时不可用', 'upstream_unavailable')
  let output = await response.text()
  if (pathname === '/api/proxy/api/health') {
    try {
      const health = JSON.parse(output)
      delete health.ffmpeg
      delete health.ffprobe
      delete health.docs
      output = JSON.stringify(health)
    } catch { /* keep non-JSON upstream response untouched */ }
  }
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'x-yc-remaining-calls': license.maxCalls > 0 ? String(Math.max(license.maxCalls - license.usedCalls, 0)) : 'unlimited' })
  res.end(output)
}

function adminOverview() {
  const counts = store.licenses.reduce((acc, license) => { acc[statusOf(license)] = (acc[statusOf(license)] || 0) + 1; return acc }, {})
  const totals = store.licenses.reduce((acc, license) => { acc.calls += license.usedCalls; acc.chartViews += license.usedChartViews; return acc }, { calls: 0, chartViews: 0 })
  const chart = Array.from({ length: 14 }, (_, index) => { const day = new Date(Date.now() - (13 - index) * 86400000).toISOString().slice(0, 10); const rows = store.usage.filter((item) => item.day === day); return { day, calls: rows.reduce((sum, item) => sum + item.calls, 0), chartViews: rows.reduce((sum, item) => sum + item.chartViews, 0) } })
  return { counts, totals, chart, checkedAt: now() }
}

const gatewayOpenApiPaths = {
  '/api/license/activate': {
    post: {
      tags: ['授权'], summary: '激活卡密并绑定一台设备', operationId: 'activate_license',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['key', 'deviceCode'], properties: { key: { type: 'string' }, deviceCode: { type: 'string', minLength: 16 } } } } } },
      responses: { 200: { description: '激活成功，返回会话 token 和授权额度' }, 403: { description: '卡密已到期/撤销/配额耗尽' }, 404: { description: '卡密不存在' }, 409: { description: '卡密已绑定其他设备' } },
    },
  },
  '/api/license/validate': {
    get: {
      tags: ['授权'], summary: '校验授权会话', operationId: 'validate_license', parameters: [{ name: 'x-device-code', in: 'header', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: '授权有效' }, 401: { description: '会话无效或过期' }, 409: { description: '设备不匹配' } },
    },
  },
  '/api/usage/chart-view': {
    post: {
      tags: ['用量'], summary: '消耗一次图表观看配额', operationId: 'count_chart_view', parameters: [{ name: 'x-device-code', in: 'header', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: '允许观看' }, 401: { description: '会话无效' }, 429: { description: '图表观看次数已用尽' } },
    },
  },
  '/api/proxy/{upstream_path}': {
    parameters: [{ name: 'upstream_path', in: 'path', required: true, schema: { type: 'string' }, description: '受保护业务路径，例如 api/search' }],
    summary: '收费层业务代理，请求会计入最多调用配额',
  },
}

async function mergedOpenApi() {
  const sanitize = (spec) => JSON.parse(JSON.stringify(spec).replaceAll(upstream, '[internal-upstream]'))
  if (upstreamOpenApiCache && upstreamOpenApiCache.expiresAt > Date.now()) return sanitize(upstreamOpenApiCache.spec)
  const response = await fetch(`${upstream}/openapi.json`).catch((error) => ({ error }))
  if (response.error || !response.ok) throw new Error('接口文档暂时不可用')
  const source = await response.json()
  const proxiedPaths = Object.fromEntries(Object.entries(source.paths || {}).map(([path, value]) => [`/api/proxy${path}`, value]))
  const sourceSafe = { ...source }
  delete sourceSafe.servers
  delete sourceSafe.externalDocs
  const spec = {
    ...sourceSafe,
    info: { title: 'YCDownload 授权网关 API', version: source.info?.version || '1.0.0', description: 'App 端只调用本文件中 /api/license、/api/usage 和 /api/proxy 路径。业务路径由授权网关转发到受保护服务。' },
    servers: [{ url: '/', description: '当前授权中间件' }],
    tags: [...(source.tags || []), { name: '授权' }, { name: '用量' }],
    paths: { ...gatewayOpenApiPaths, ...proxiedPaths },
  }
  upstreamOpenApiCache = { spec, expiresAt: Date.now() + 5 * 60 * 1000 }
  return sanitize(spec)
}
async function admin(req, res, pathname) {
  if (!requireAdmin(req, res)) return
  if (req.method === 'GET' && pathname === '/api/admin/overview') return json(res, 200, adminOverview())
  if (req.method === 'GET' && pathname === '/api/admin/licenses') { const status = new URL(req.url, 'http://localhost').searchParams.get('status'); return json(res, 200, { licenses: store.licenses.filter((license) => !status || statusOf(license) === status).map(publicLicense) }) }
  const match = pathname.match(/^\/api\/admin\/licenses\/([^/]+)(?:\/(revoke|reset-usage|expiry-check|unbind))?$/)
  if (match) {
    const license = store.licenses.find((item) => item.id === match[1]); if (!license) return error(res, 404, '卡密不存在', 'not_found')
    const action = match[2]
    if (req.method === 'POST' && action === 'revoke') { license.status = license.status === 'revoked' ? 'active' : 'revoked'; await persist(); return json(res, 200, { license: publicLicense(license), status: statusOf(license) }) }
    if (req.method === 'POST' && action === 'reset-usage') { license.usedCalls = 0; license.usedChartViews = 0; await persist(); return json(res, 200, { license: publicLicense(license) }) }
    if (req.method === 'POST' && action === 'unbind') { license.deviceCode = null; license.deviceBoundAt = null; store.sessions = store.sessions.filter((item) => item.licenseId !== license.id); await persist(); return json(res, 200, { license: publicLicense(license), status: statusOf(license) }) }
    if (req.method === 'GET' && action === 'expiry-check') { const candidate = new URL(req.url, 'http://localhost').searchParams.get('at'); const evaluatedAt = candidate ? Date.parse(candidate) : Date.now(); if (!Number.isFinite(evaluatedAt)) return error(res, 400, 'at 必须是有效的 ISO 日期'); return json(res, 200, { id: license.id, expiresAt: license.expiresAt, evaluatedAt: new Date(evaluatedAt).toISOString(), expired: isExpired(license, evaluatedAt), status: statusAt(license, evaluatedAt) }) }
    if (req.method === 'PATCH' && !action) {
      let input; try { input = await body(req) } catch (e) { return error(res, 400, e.message) }
      let nextExpiry = license.expiresAt; if (input.expiresAt !== undefined) { try { nextExpiry = expiry(input.expiresAt) } catch (e) { return error(res, 400, e.message) } }
      for (const field of ['maxCalls', 'maxChartViews', 'note']) if (input[field] !== undefined) license[field] = field.startsWith('max') ? limit(input[field]) : input[field]
      license.expiresAt = nextExpiry; await persist(); return json(res, 200, { license: publicLicense(license), status: statusOf(license) })
    }
  }
  if (req.method === 'POST' && pathname === '/api/admin/licenses') {
    let input; try { input = await body(req) } catch (e) { return error(res, 400, e.message) }
    let expiresAt; try { expiresAt = expiry(input.expiresAt) } catch (e) { return error(res, 400, e.message) }
    const count = Math.min(Math.max(Number(input.count) || 1, 1), 100); const created = []
    for (let index = 0; index < count; index += 1) { const plainKey = makeKey(); const license = { id: id(), keyHash: hash(plainKey), keyPrefix: plainKey.slice(0, 8), status: 'active', deviceCode: null, deviceBoundAt: null, expiresAt, maxCalls: limit(input.maxCalls), usedCalls: 0, maxChartViews: limit(input.maxChartViews), usedChartViews: 0, note: String(input.note || ''), createdAt: now(), lastActivatedAt: null, lastSeenAt: null, lastIp: null }; store.licenses.push(license); created.push({ key: plainKey, license: publicLicense(license) }) }
    await persist(); return json(res, 201, { created })
  }
  return error(res, 404, '管理员接口不存在', 'not_found')
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
function serveStatic(res, file) {
  if (!existsSync(file)) return false
  res.writeHead(200, { 'content-type': contentTypes[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
  res.end(readFileSync(file)); return true
}
function staticPath(pathname) {
  let decoded; try { decoded = decodeURIComponent(pathname) } catch { return null }
  const file = normalize(join(distDir, decoded.replace(/^\/+/, '')))
  return file === distDir || file.startsWith(`${distDir}${sep}`) ? file : null
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const pathname = requestUrl.pathname
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,x-device-code,x-yc-feature', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-max-age': '600' }); return res.end() }
  try {
    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, service: 'ycdownload-license-middleware' })
    if (req.method === 'GET' && pathname === '/openapi.json') { try { return json(res, 200, await mergedOpenApi()) } catch (e) { return error(res, 502, e.message, 'upstream_openapi_unavailable') } }
    if (req.method === 'GET' && pathname === '/docs') return json(res, 200, { service: 'YCDownload license middleware', openapi: '/openapi.json', endpoints: { activate: 'POST /api/license/activate', validate: 'GET /api/license/validate', proxy: '/api/proxy/*', chartView: 'POST /api/usage/chart-view', admin: '/api/admin/*' } })
    if (pathname.startsWith('/api/license/')) { if (req.method === 'POST' && pathname === '/api/license/activate') return activate(req, res); if (req.method === 'GET' && pathname === '/api/license/validate') return validate(req, res) }
    if (req.method === 'POST' && pathname === '/api/usage/chart-view') return chartView(req, res)
    if (pathname.startsWith('/api/proxy/')) return proxy(req, res, pathname)
    if (pathname.startsWith('/api/admin/')) return admin(req, res, pathname)
    if (req.method === 'GET' && pathname === '/admin') { const file = staticPath('/admin.html'); if (file && serveStatic(res, file)) return; return error(res, 503, 'Admin 前端尚未构建，请先运行 npm run build', 'admin_not_built') }
    if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/assets/'))) { const file = staticPath(pathname === '/' ? '/index.html' : pathname); if (file && serveStatic(res, file)) return }
    return error(res, 404, '接口不存在', 'not_found')
  } catch (e) { console.error(e); return error(res, 500, '服务内部错误', 'internal_error') }
})

server.listen(port, bind, () => console.log(`YCDownload license middleware listening on http://${bind}:${port}`))
