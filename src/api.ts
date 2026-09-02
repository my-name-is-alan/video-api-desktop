import { invoke } from '@tauri-apps/api/core'

export type KeyInfo = {
  status: 'pending' | 'active' | 'expired' | 'disabled'
  expire_time: string
  remain_seconds: number
  remain_days: number
  plan_days: number
}

export type Celebrity = {
  nickname?: string
  name?: string
  avatar?: string
  sub_title?: string
  role?: string
  celebrity_id?: string
  thumb?: string
}

export type SeriesHit = {
  seriesId: string
  title: string
  cover: string
  tags?: string[]
  actors?: string
  celebrities?: Celebrity[]
  intro?: string
  firstVid?: string
  episodeCnt?: number
  totalEps?: number
  epCnt?: number
  episodes?: number | Episode[]
  vidList?: string[]
}

export type RankItem = {
  rank?: number
  seriesId: string
  title: string
  cover: string
  heat?: string
  score?: string
  tags?: string[]
  intro?: string
  actors?: string
  celebrities?: Celebrity[]
  episodeCnt?: number
  totalEps?: number
  epCnt?: number
}

export type Episode = {
  ep: number
  vid: string
  title?: string
  local?: boolean
}

export type SeriesDetail = {
  seriesId: string
  title: string
  cover?: string
  intro?: string
  tags?: string[]
  actors?: string
  celebrities?: Celebrity[]
  totalEps?: number
  episodes: Episode[]
}

export function normalizeCast(source?: {
  celebrities?: unknown
  actors?: unknown
  cast?: unknown
} | null): Celebrity[] {
  if (!source) return []
  const out: Celebrity[] = []
  const seen = new Set<string>()
  const push = (person: Celebrity) => {
    const name = (person.nickname || person.name || '').trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    out.push({ ...person, nickname: name })
  }
  const eat = (raw: unknown) => {
    if (!raw) return
    if (typeof raw === 'string') {
      for (const part of raw.split(/[/、,，|]/)) {
        const name = part.trim()
        if (name) push({ nickname: name })
      }
      return
    }
    if (!Array.isArray(raw)) return
    for (const item of raw) {
      if (typeof item === 'string') push({ nickname: item })
      else if (item && typeof item === 'object') push(item as Celebrity)
    }
  }
  eat(source.celebrities)
  eat(source.cast)
  eat(source.actors)
  return out
}


export type CdnInfo = {
  vid: string
  quality: string
  url: string
  backupUrls?: string[]
  key?: string
  duration?: number
  urlExpire?: number
}

const K_BASE = 'yc.apiBase'
const K_KEY = 'yc.apiKey'
const K_DIR = 'yc.downloadDir'
const K_MERGE = 'yc.mergeAfter'
const K_NFO = 'yc.writeNfo'

export function getApiBase() {
  return (localStorage.getItem(K_BASE) || '').replace(/\/$/, '')
}

export function getApiKey() {
  return localStorage.getItem(K_KEY) || ''
}

export function getDownloadDir() {
  return localStorage.getItem(K_DIR) || ''
}

export function getMergeAfter() {
  return localStorage.getItem(K_MERGE) !== '0'
}

export function getWriteNfo() {
  return localStorage.getItem(K_NFO) !== '0'
}

export type AppPrefs = {
  apiBase: string
  apiKey: string
  downloadDir: string
  mergeAfter: boolean
  writeNfo: boolean
}

export async function loadPrefs(): Promise<AppPrefs | null> {
  try {
    return await invoke<AppPrefs>('load_prefs')
  } catch {
    return null
  }
}

export function saveSettings(
  base: string,
  key: string,
  dir: string,
  mergeAfter = getMergeAfter(),
  writeNfo = getWriteNfo(),
) {
  const apiBase = base.replace(/\/$/, '')
  const apiKey = key.trim()
  localStorage.setItem(K_BASE, apiBase)
  localStorage.setItem(K_KEY, apiKey)
  localStorage.setItem(K_DIR, dir)
  localStorage.setItem(K_MERGE, mergeAfter ? '1' : '0')
  localStorage.setItem(K_NFO, writeNfo ? '1' : '0')
  void invoke('save_prefs', {
    prefs: {
      apiBase,
      apiKey,
      downloadDir: dir,
      mergeAfter,
      writeNfo,
    },
  }).catch(() => {
    /* browser preview */
  })
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = getApiBase()
  const key = getApiKey()
  if (!base) throw new Error('请先填写接口地址')
  if (!key) throw new Error('请先填写 API Key')
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(text.slice(0, 160) || `HTTP ${res.status}`)
  }
  if (!res.ok) {
    const err = data as { error?: { message?: string }; message?: string }
    throw new Error(err?.error?.message || err?.message || `HTTP ${res.status}`)
  }
  return data as T
}

export function remaining() {
  return request<KeyInfo>('/api/key')
}

export function activateKey() {
  return request<KeyInfo>('/api/key/activate', { method: 'POST' })
}

export function fetchLibrary() {
  return request<{ series?: SeriesHit[]; count?: number }>('/api/library')
}

export function fetchSearch(q: string) {
  return request<{ series?: SeriesHit[]; actors?: unknown[]; count?: number }>(`/api/search?q=${encodeURIComponent(q)}`)
}

export function fetchRank(name: string) {
  return request<{ name?: string; items?: RankItem[] }>(`/api/web/rank/${name}`)
}

export function fetchSeries(id: string) {
  return request<SeriesDetail>(`/api/series/${encodeURIComponent(id)}`)
}

export function fetchWebSeries(id: string) {
  return request<SeriesDetail>(`/api/web/series/${encodeURIComponent(id)}`)
}


export function fetchCdn(vid: string) {
  return request<CdnInfo>(`/api/ep/${encodeURIComponent(vid)}/cdn?quality=1080p`)
}
