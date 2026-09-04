import { getApiKey } from './api'
import { apiRequest } from './license'

function authedRequest<T>(path: string, init: RequestInit = {}) {
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

export type ApiCategoryItem = {
  seriesId?: string
  seriesName?: string
  title?: string
  seriesCover?: string
  cover?: string
  episodeCnt?: number
  epCnt?: number
  intro?: string
  tags?: string[]
  celebrities?: Array<{ nickname?: string; avatar?: string; sub_title?: string } | string>
  actors?: string
  vidList?: string[]
  firstVid?: string
}

export type ApiRankItem = {
  rank?: number
  seriesId?: string
  title?: string
  cover?: string
  heat?: string | number
  score?: string | number
  favorites?: string | number
  likes?: string | number
  tags?: string[]
  intro?: string
  epCnt?: number
  firstVid?: string
}

export type ApiJob = {
  jid?: string
  id?: string
  status?: string
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
  message?: string
  error?: string
  [key: string]: unknown
}

export type ApiSeriesDetail = {
  seriesId?: string
  title?: string
  episodes?: Array<{ ep?: number; vid?: string; title?: string; downloadUrl?: string }>
  totalEps?: number
  [key: string]: unknown
}

export type DownloadStartResponse = { jid?: string; jobId?: string; job_id?: string; id?: string; [key: string]: unknown }

export async function fetchCategory(_deviceCode: string, page = 1, size = 24) {
  return authedRequest<{ series?: ApiCategoryItem[]; total?: number; pageNum?: number }>(`/api/web/category?page_num=${page}&size=${size}&sort_type=1`)
}

export async function fetchSearch(_deviceCode: string, keyword: string) {
  return authedRequest<{ series?: ApiCategoryItem[]; actors?: unknown[]; count?: number }>(`/api/search?q=${encodeURIComponent(keyword)}`)
}

export async function fetchRank(_deviceCode: string, ranking: 'hot-drama' | 'hot-real-drama' | 'hot-ai-drama' | 'hot-comic-drama', page = 1) {
  return authedRequest<{ items?: ApiRankItem[]; count?: number; name?: string }>(`/api/web/rank/${ranking}?page=${page}`)
}

export async function fetchSeriesDetail(_deviceCode: string, seriesId: string) {
  return authedRequest<ApiSeriesDetail>(`/api/series/${encodeURIComponent(seriesId)}`)
}

export async function startSeriesDownload(_deviceCode: string, seriesId: string, quality = '1080p') {
  return authedRequest<DownloadStartResponse>(`/api/series/${encodeURIComponent(seriesId)}/download?quality=${quality}`, { method: 'POST' })
}

export async function fetchJobs(_deviceCode: string) {
  return authedRequest<{ jobs?: ApiJob[] }>('/api/jobs')
}

export async function fetchJob(_deviceCode: string, jobId: string) {
  return authedRequest<ApiJob>(`/api/jobs/${encodeURIComponent(jobId)}`)
}

export async function fetchHealth(_deviceCode: string) {
  return authedRequest<{ ok?: boolean; time?: string }>('/api/health')
}
