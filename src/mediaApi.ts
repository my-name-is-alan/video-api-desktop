import { proxyBackend } from './license'

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

export async function fetchCategory(deviceCode: string, page = 1, size = 24) {
  return proxyBackend<{ series?: ApiCategoryItem[]; total?: number; pageNum?: number }>(`/api/web/category?page_num=${page}&size=${size}&sort_type=1`, deviceCode)
}

export async function fetchSearch(deviceCode: string, keyword: string) {
  return proxyBackend<{ series?: ApiCategoryItem[]; actors?: unknown[]; count?: number }>(`/api/web/search?q=${encodeURIComponent(keyword)}`, deviceCode)
}

export async function fetchRank(deviceCode: string, ranking: 'hot-drama' | 'hot-real-drama' | 'hot-ai-drama' | 'hot-comic-drama', page = 1) {
  return proxyBackend<{ items?: ApiRankItem[]; count?: number; name?: string }>(`/api/web/rank/${ranking}?page=${page}`, deviceCode)
}

export async function fetchSeriesDetail(deviceCode: string, seriesId: string) {
  return proxyBackend<ApiSeriesDetail>(`/api/web/series/${encodeURIComponent(seriesId)}`, deviceCode)
}

export async function startSeriesDownload(deviceCode: string, seriesId: string, quality = '1080p') {
  return proxyBackend<DownloadStartResponse>(`/api/series/${encodeURIComponent(seriesId)}/download?quality=${quality}`, deviceCode, { method: 'POST' })
}

export async function fetchJobs(deviceCode: string) {
  return proxyBackend<{ jobs?: ApiJob[] }>('/api/jobs', deviceCode)
}

export async function fetchJob(deviceCode: string, jobId: string) {
  return proxyBackend<ApiJob>(`/api/jobs/${encodeURIComponent(jobId)}`, deviceCode)
}

export async function fetchHealth(deviceCode: string) {
  return proxyBackend<{ ok?: boolean; time?: string }>('/api/health', deviceCode)
}
