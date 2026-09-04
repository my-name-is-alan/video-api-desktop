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

let serverUrl = (import.meta.env.VITE_LICENSE_SERVER_URL || '').trim().replace(/\/+$/, '')

export function setLicenseServerUrl(value: string) {
  const next = value.trim().replace(/\/+$/, '')
  if (next) serverUrl = next
}

export function getLicenseServerUrl() {
  return serverUrl
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

function headerRecord(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value })
    return out
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value
    return out
  }
  return { ...headers }
}

function errorMessage(payload: unknown, status: number, raw: string): string {
  if (payload && typeof payload === 'object') {
    if ('error' in payload) {
      const nested = payload.error
      if (nested && typeof nested === 'object' && 'message' in nested && typeof nested.message === 'string' && nested.message.trim()) {
        return nested.message
      }
      if (typeof nested === 'string' && nested.trim()) return nested
    }
    if ('message' in payload && typeof payload.message === 'string' && payload.message.trim()) return payload.message
    if ('detail' in payload && typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail
  }
  const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 160)
  return snippet || `授权服务请求失败 (HTTP ${status})`
}

function errorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return undefined
  const nested = payload.error
  if (nested && typeof nested === 'object' && 'type' in nested && typeof nested.type === 'string') return nested.type
  return undefined
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!serverUrl) throw new Error('请先填写授权网关地址')
  const headers = headerRecord(init.headers)
  const body = typeof init.body === 'string' ? init.body : null
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json'
  }
  let status = 0
  let raw = ''
  if ('__TAURI_INTERNALS__' in window) {
    const result = await invoke<{ status: number; body: string }>('license_http', {
      url: `${serverUrl}${path}`,
      method: (init.method || 'GET').toUpperCase(),
      headers,
      body,
    })
    status = result.status
    raw = result.body || ''
  } else {
    const response = await fetch(`${serverUrl}${path}`, { ...init, headers })
    status = response.status
    raw = await response.text()
  }
  let payload: unknown = {}
  if (raw) {
    try {
      payload = JSON.parse(raw)
    } catch {
      if (status < 200 || status >= 300) {
        throw new LicenseRequestError(errorMessage(null, status, raw), status)
      }
      throw new LicenseRequestError(raw.slice(0, 160) || `HTTP ${status}`, status)
    }
  }
  if (status < 200 || status >= 300) {
    throw new LicenseRequestError(errorMessage(payload, status, raw), status, errorCode(payload))
  }
  return payload as T
}
