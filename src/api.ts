import { invoke } from '@tauri-apps/api/core'
import { apiRequest, setLicenseServerUrl } from './license'

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
const K_MERGE_DEFAULT_VERSION = 'yc.mergeAfterDefaultV2'

export function getApiBase() {
  return (localStorage.getItem(K_BASE) || '').trim().replace(/\/+$/, '')
}

export function getApiKey() {
  return localStorage.getItem(K_KEY) || ''
}

export function getDownloadDir() {
  return localStorage.getItem(K_DIR) || ''
}

export function getMergeAfter() {
  return localStorage.getItem(K_MERGE) === '1'
}

export function migrateMergeDefault() {
  if (localStorage.getItem(K_MERGE_DEFAULT_VERSION) === '1') return false
  localStorage.setItem(K_MERGE_DEFAULT_VERSION, '1')
  return true
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
  const apiBase = base.trim().replace(/\/+$/, '')
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

export function configureApi(base: string, _deviceCode = '') {
  setLicenseServerUrl(base)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = getApiKey()
  if (!key) throw new Error('请先填写卡密')
  return apiRequest<T>(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  })
}

export async function remaining(_deviceCode = '') {
  return request<KeyInfo>('/api/key')
}

export async function activateKey(key = getApiKey(), _deviceCode = '') {
  if (!key.trim()) throw new Error('请先填写卡密')
  return request<KeyInfo>('/api/key/activate', { method: 'POST' })
}

function normalizeSeries(raw: Partial<SeriesHit> & { seriesName?: string; seriesCover?: string }): SeriesHit {
  return {
    seriesId: raw.seriesId || '',
    title: raw.title || raw.seriesName || '',
    cover: raw.cover || raw.seriesCover || '',
    tags: raw.tags,
    actors: raw.actors,
    celebrities: raw.celebrities,
    intro: raw.intro,
    firstVid: raw.firstVid,
    episodeCnt: raw.episodeCnt,
    totalEps: raw.totalEps,
    epCnt: raw.epCnt,
    episodes: raw.episodes,
    vidList: raw.vidList,
  }
}

export async function fetchLibrary() {
  const data = await request<{ series?: Array<Partial<SeriesHit> & { seriesName?: string; seriesCover?: string }>; count?: number }>(
    '/api/library',
  )
  return { ...data, series: (data.series || []).map(normalizeSeries) }
}

export async function fetchSearch(q: string) {
  const data = await request<{ series?: Array<Partial<SeriesHit> & { seriesName?: string; seriesCover?: string }>; actors?: unknown[]; count?: number }>(
    `/api/search?q=${encodeURIComponent(q)}`,
  )
  return { ...data, series: (data.series || []).map(normalizeSeries) }
}

export async function fetchRank(name: string) {
  const data = await request<{ name?: string; items?: Array<RankItem & { seriesName?: string; seriesCover?: string }> }>(
    `/api/web/rank/${encodeURIComponent(name)}`,
  )
  return {
    ...data,
    items: (data.items || []).map((item) => ({
      ...item,
      seriesId: item.seriesId || '',
      title: item.title || item.seriesName || '',
      cover: item.cover || item.seriesCover || '',
    })),
  }
}
async function fetchSeriesViaGateway(id: string) {
  const data = await request<Partial<SeriesDetail> & { seriesName?: string; seriesCover?: string; episodes?: Array<Partial<Episode>> }>(
    `/api/series/${encodeURIComponent(id)}`,
  )
  return {
    seriesId: data.seriesId || id,
    title: data.title || data.seriesName || id,
    cover: data.cover || data.seriesCover,
    intro: data.intro,
    tags: data.tags,
    actors: data.actors,
    celebrities: data.celebrities,
    totalEps: data.totalEps,
    episodes: (data.episodes || [])
      .map((episode) => ({ ep: Number(episode.ep) || 0, vid: episode.vid || '', title: episode.title, local: episode.local }))
      .filter((episode) => episode.ep > 0 && episode.vid),
  } satisfies SeriesDetail
}

export function fetchSeries(id: string) {
  return fetchSeriesViaGateway(id)
}

export function fetchWebSeries(id: string) {
  return fetchSeriesViaGateway(id)
}

export async function fetchCdn(vid: string) {
  const data = await request<CdnInfo & { backup_urls?: string[]; url_expire?: number }>(
    `/api/ep/${encodeURIComponent(vid)}/cdn?quality=1080p`,
  )
  return {
    ...data,
    vid: data.vid || vid,
    quality: data.quality || '1080p',
    backupUrls: data.backupUrls || data.backup_urls,
    urlExpire: data.urlExpire || data.url_expire,
  }
}
