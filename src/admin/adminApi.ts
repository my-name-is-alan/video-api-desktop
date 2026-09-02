export type AdminLicense = {
  id: string
  keyPrefix: string
  status: 'active' | 'revoked' | 'expired' | 'quota_exhausted'
  deviceCode: string | null
  expiresAt: string | null
  maxCalls: number
  usedCalls: number
  maxChartViews: number
  usedChartViews: number
  note: string
  createdAt: string
  lastActivatedAt: string | null
  lastSeenAt: string | null
}

export type Overview = {
  counts: Record<string, number>
  totals: { calls: number; chartViews: number }
  chart: Array<{ day: string; calls: number; chartViews: number }>
  checkedAt: string
}

const baseUrl = window.location.origin
let adminToken = sessionStorage.getItem('ycdownload-admin-token') || ''

export function getAdminToken() { return adminToken }
export function setAdminToken(token: string) {
  adminToken = token.trim()
  sessionStorage.setItem('ycdownload-admin-token', adminToken)
}
export function clearAdminToken() {
  adminToken = ''
  sessionStorage.removeItem('ycdownload-admin-token')
}

async function request<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || '请求失败')
  return data as T
}

export function getOverview() { return request<Overview>('/api/admin/overview') }
export function getLicenses() { return request<{ licenses: AdminLicense[] }>('/api/admin/licenses') }
export function createLicenses(input: { count: number; expiresAt: string | null; maxCalls: number; maxChartViews: number; note?: string }) {
  return request<{ created: Array<{ key: string; license: AdminLicense }> }>('/api/admin/licenses', { method: 'POST', body: JSON.stringify(input) })
}
export function toggleLicense(id: string) { return request<{ license: AdminLicense }>(`/api/admin/licenses/${id}/revoke`, { method: 'POST' }) }
export function resetLicenseUsage(id: string) { return request<{ license: AdminLicense }>(`/api/admin/licenses/${id}/reset-usage`, { method: 'POST' }) }
export function unbindLicense(id: string) { return request<{ license: AdminLicense }>(`/api/admin/licenses/${id}/unbind`, { method: 'POST' }) }
export function checkExpiry(id: string, at?: string) {
  return request<{ expired: boolean; status: string; expiresAt: string | null; evaluatedAt: string }>(`/api/admin/licenses/${id}/expiry-check${at ? `?at=${encodeURIComponent(at)}` : ''}`)
}
