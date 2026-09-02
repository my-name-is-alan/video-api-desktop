import { invoke } from '@tauri-apps/api/core'

export type DeviceFingerprint = {
  deviceCode: string
  operatingSystem: string
  macAddress: string
  timezone: string
  language: string
  motherboard: string
  memory: string
  disk: string
}

export type License = {
  id: string
  keyPrefix: string
  status: string
  deviceCode: string | null
  expiresAt: string | null
  maxCalls: number
  usedCalls: number
  maxChartViews: number
  usedChartViews: number
  createdAt: string
  lastSeenAt: string | null
}

let serverUrl = (import.meta.env.VITE_LICENSE_SERVER_URL || 'http://127.0.0.1:8787').trim().replace(/\/+$/, '')
const tokenStorageKey = 'ycdownload-license-token'

export function setLicenseServerUrl(value: string) {
  const next = value.trim().replace(/\/+$/, '')
  if (next) serverUrl = next
}

class LicenseRequestError extends Error {
  status: number
  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'LicenseRequestError'
    this.status = status
    this.code = code
  }
}

async function loadToken() {
  const browserToken = localStorage.getItem(tokenStorageKey)
  if (browserToken) {
    // Migrate an existing dev-origin token into the Tauri app-data fallback.
    void invoke('save_license_token', { token: browserToken }).catch(() => undefined)
    return browserToken
  }
  try {
    const persistedToken = await invoke<string | null>('load_license_token')
    if (persistedToken) localStorage.setItem(tokenStorageKey, persistedToken)
    return persistedToken
  } catch {
    return null
  }
}

async function clearToken() {
  localStorage.removeItem(tokenStorageKey)
  try { await invoke('clear_license_token') } catch { /* browser dev mode */ }
}

async function browserFingerprint(): Promise<DeviceFingerprint> {
  const raw = [navigator.userAgent, navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone].join('|')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  const deviceCode = `WEB1-${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`
  return { deviceCode, operatingSystem: 'browser', macAddress: 'unavailable', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language, motherboard: 'unavailable', memory: 'unavailable', disk: 'unavailable' }
}

export async function getDeviceFingerprint(): Promise<DeviceFingerprint> {
  if (!('__TAURI_INTERNALS__' in window)) return browserFingerprint()
  return invoke<DeviceFingerprint>('get_device_fingerprint')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${serverUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new LicenseRequestError(payload.message || '授权服务请求失败', response.status, payload.error)
  return payload as T
}

export async function activateLicense(key: string, deviceCode: string) {
  const result = await request<{ token: string; license: License; status: string }>('/api/license/activate', { method: 'POST', body: JSON.stringify({ key, deviceCode }) })
  localStorage.setItem(tokenStorageKey, result.token)
  try { await invoke('save_license_token', { token: result.token }) } catch { /* browser dev mode */ }
  return result
}

export async function validateLicense(deviceCode: string) {
  const token = await loadToken()
  if (!token) return null
  try {
    return await request<{ license: License; status: string }>('/api/license/validate', { headers: { authorization: `Bearer ${token}`, 'x-device-code': deviceCode } })
  } catch (error) {
    if (error instanceof LicenseRequestError && [401, 403, 409].includes(error.status)) {
      await clearToken()
      return null
    }
    throw error
  }
}

export async function countChartView(deviceCode: string) {
  const token = await loadToken()
  if (!token) throw new Error('请先激活卡密')
  return request<{ allowed: boolean; remaining: number | null }>('/api/usage/chart-view', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-device-code': deviceCode }, body: '{}' })
}

/** All real download/search operations should use this gateway instead of calling
 * the upstream service from the Tauri webview. */
export async function proxyBackend<T>(path: string, deviceCode: string, init: RequestInit = {}) {
  const token = await loadToken()
  if (!token) throw new Error('请先激活卡密')
  return request<T>(`/api/proxy${path.startsWith('/') ? path : `/${path}`}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'x-device-code': deviceCode, ...(init.headers || {}) },
  })
}

export function clearLicense() { void clearToken() }

export function getLicenseServerUrl() { return serverUrl }
