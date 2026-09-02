import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  activateKey,
  configureApi,
  fetchCdn,
  fetchLibrary,
  fetchRank,
  fetchSearch,
  fetchSeries,
  getApiBase,
  getApiKey,
  getDownloadDir,
  getMergeAfter,
  getWriteNfo,
  loadPrefs,
  migrateMergeDefault,
  normalizeCast,
  remaining,
  saveSettings,
  type Celebrity,
  type Episode,
  type KeyInfo,
  type RankItem,
  type SeriesDetail,
  type SeriesHit,
} from './api'
import { getDeviceFingerprint } from './license'
import './App.css'

type Nav = 'home' | 'search' | 'rank' | 'queue' | 'settings'
type TaskStatus = 'queued' | 'running' | 'done' | 'error'
type SeriesPhase = 'downloading' | 'merging' | 'done' | 'error'

type SeriesGroup = {
  seriesId: string
  title: string
  cover: string
  phase: SeriesPhase
  label: string
  done: number
  total: number
  failed: number
  queued: number
  running: number
  received: number
  bytesTotal: number
  epFirst: number
  epLast: number
  hint: string
  message: string
  pct: number
}


type Task = {
  id: string
  seriesId: string
  title: string
  ep: number
  vid: string
  status: TaskStatus
  received: number
  total: number
  message: string
  kind?: 'ep' | 'merge'
  cover?: string
  tags?: string[]
  intro?: string
  actors?: string
  celebrities?: Celebrity[]
  epTitle?: string
  totalEps?: number
}


const RANKS = [
  { id: 'hot-drama', label: '热播' },
  { id: 'hot-real-drama', label: '真人' },
  { id: 'hot-ai-drama', label: 'AI剧' },
  { id: 'hot-comic-drama', label: '漫剧' },
] as const

const licenseStatusLabels: Record<KeyInfo['status'], string> = {
  pending: '待激活',
  active: '已激活',
  expired: '已到期',
  disabled: '不可用',
}

function episodeCount(item: {
  episodeCnt?: number
  totalEps?: number
  epCnt?: number
  episodes?: number | unknown[]
}): number {
  if (typeof item.episodeCnt === 'number' && item.episodeCnt > 0) return item.episodeCnt
  if (typeof item.totalEps === 'number' && item.totalEps > 0) return item.totalEps
  if (typeof item.epCnt === 'number' && item.epCnt > 0) return item.epCnt
  if (typeof item.episodes === 'number' && item.episodes > 0) return item.episodes
  if (Array.isArray(item.episodes) && item.episodes.length > 0) return item.episodes.length
  return 0
}

function safeName(name: string) {
  const cleaned = Array.from(name.replace(/[<>:"/\\|?*]/g, '_'))
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
  return cleaned.slice(0, 80) || 'series'
}

function joinPath(root: string, ...parts: string[]) {
  const sep = root.includes('/') && !root.includes('\\') ? '/' : '\\'
  return [root.replace(/[\\/]+$/, ''), ...parts.map((p) => p.replace(/^[\\/]+|[\\/]+$/g, ''))].join(sep)
}

function seriesDir(root: string, title: string) {
  return joinPath(root, safeName(title))
}

function seasonDir(root: string, title: string) {
  return joinPath(seriesDir(root, title), 'Season 1')
}


function groupSeries(tasks: Task[]): SeriesGroup[] {
  const order: string[] = []
  const map = new Map<string, Task[]>()
  for (const task of tasks) {
    if (!map.has(task.seriesId)) {
      order.push(task.seriesId)
      map.set(task.seriesId, [])
    }
    map.get(task.seriesId)!.push(task)
  }
  return order.map((seriesId) => {
    const list = map.get(seriesId) || []
    const eps = list.filter((task) => task.kind !== 'merge' && task.ep > 0)
    const merge = list.find((task) => task.kind === 'merge' || task.ep === 0)
    const first = eps[0] || list[0]
    const total = eps.length
    const done = eps.filter((task) => task.status === 'done').length
    const failed = eps.filter((task) => task.status === 'error').length
    const queued = eps.filter((task) => task.status === 'queued').length
    const running = eps.filter((task) => task.status === 'running').length
    const working = eps.some((task) => task.status === 'queued' || task.status === 'running')
    const mergeFailed = Boolean(merge && merge.status === 'error')
    let phase: SeriesPhase = 'downloading'
    if (working) phase = 'downloading'
    else if (merge && (merge.status === 'queued' || merge.status === 'running')) phase = 'merging'
    else if (failed > 0 && done + failed === total) phase = 'error'
    else if (mergeFailed) phase = 'error'
    else if (total > 0 && done === total) phase = 'done'
    const label = mergeFailed
      ? '合并失败'
      : phase === 'downloading'
        ? '下载中'
        : phase === 'merging'
          ? '合并中'
          : phase === 'done'
            ? '已完成'
            : '失败'
    const bytes = eps.reduce((sum, task) => sum + task.received, 0)
    const bytesTotal = eps.reduce((sum, task) => sum + task.total, 0)
    const pct = total === 0 ? 0 : phase === 'done' || mergeFailed ? 100 : Math.round((done / total) * 100)
    const ordered = [...eps].sort((a, b) => a.ep - b.ep)
    const epFirst = ordered[0]?.ep || 1
    const epLast = ordered[ordered.length - 1]?.ep || total
    const hint = mergeFailed
      ? merge?.message || '合并失败'
      : phase === 'merging'
        ? `合并为 S01E${String(epFirst).padStart(2, '0')}-E${String(epLast).padStart(2, '0')}`
        : phase === 'done'
          ? `已保存到 Season 1`
          : phase === 'error'
            ? `${failed} 集失败`
            : `第 ${epFirst}–${epLast} 集`
    return {
      seriesId,
      title: first?.title || seriesId,
      cover: first?.cover || '',
      phase,
      label,
      done,
      total,
      failed,
      queued,
      running,
      received: bytes,
      bytesTotal,
      epFirst,
      epLast,
      hint,
      message: `${label}【${done}/${total}】`,
      pct: bytesTotal > 0 ? Math.round((bytes / bytesTotal) * 100) : pct,
    }
  })
}

function QueueRing({ value, error = false }: { value: number; error?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  const r = 24
  const c = 2 * Math.PI * r
  return (
    <div className={error ? 'queue-ring error' : 'queue-ring'}>
      <svg viewBox="0 0 64 64" aria-hidden>
        <circle cx="32" cy="32" r={r} />
        <circle cx="32" cy="32" r={r} strokeDasharray={`${(pct / 100) * c} ${c}`} />
      </svg>
      <span>{pct}%</span>
    </div>
  )
}

function QueueCard({
  g,
  onRetryMerge,
  onRetryDownloads,
}: {
  g: SeriesGroup
  onRetryMerge?: (seriesId: string) => void
  onRetryDownloads?: (seriesId: string) => void
}) {
  const progress = Math.max(0, Math.min(100, Math.round(g.pct)))
  const stateClass = g.phase === 'error' ? 'error' : g.phase === 'done' ? 'done' : g.phase === 'merging' ? 'merging' : 'active'
  return (
    <li className={`queue-row ${g.phase}`}>
      <div className="queue-cover-wrap">
        {g.cover ? <img className="queue-cover" src={g.cover} alt={`${g.title} 海报`} /> : <div className="queue-cover" />}
        <span className={`queue-cover-state ${stateClass}`} aria-hidden />
      </div>
      <div className="queue-meta">
        <div className="queue-title-line">
          <strong>{g.title}</strong>
          <span className={`queue-state ${stateClass}`}>{g.label}</span>
        </div>
        <div className="queue-subline">
          <span>{g.done}/{g.total} 集完成</span>
          <span>{g.hint}</span>
        </div>
        <div className="queue-progress" aria-label={`${progress}%`}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="queue-foot">
          <small>{g.running > 0 ? `${g.running} 集正在下载` : g.queued > 0 ? `${g.queued} 集等待中` : g.message}</small>
          <b>{progress}%</b>
        </div>
        <div className="queue-actions">
          {g.failed > 0 && onRetryDownloads ? (
            <button type="button" className="queue-retry secondary" onClick={() => onRetryDownloads(g.seriesId)}>
              重试失败集
            </button>
          ) : null}
          {g.label === '合并失败' && onRetryMerge ? (
            <button type="button" className="queue-retry" onClick={() => onRetryMerge(g.seriesId)}>
              重试合并
            </button>
          ) : null}
        </div>
      </div>
      <QueueRing value={g.pct} error={g.phase === 'error'} />
    </li>
  )
}

function QueueOverview({ tasks, onOpenSettings }: { tasks: Task[]; onOpenSettings: () => void }) {
  const episodes = tasks.filter((task) => task.kind !== 'merge')
  const running = episodes.filter((task) => task.status === 'running').length
  const queued = episodes.filter((task) => task.status === 'queued').length
  const done = episodes.filter((task) => task.status === 'done').length
  const failed = episodes.filter((task) => task.status === 'error').length
  return (
    <div className="queue-overview">
      <div className="queue-heading">
        <div>
          <p className="eyebrow">DOWNLOAD CENTER</p>
          <h1>下载队列</h1>
          <p>最多同时下载 2 集，完成后自动整理到剧集目录。</p>
        </div>
        <button type="button" className="queue-settings" onClick={onOpenSettings}>
          下载设置 <span aria-hidden>↗</span>
        </button>
      </div>
      <div className="queue-stats" aria-label="下载统计">
        <div><span className="queue-stat-dot active" />进行中<strong>{running}</strong></div>
        <div><span className="queue-stat-dot queued" />等待中<strong>{queued}</strong></div>
        <div><span className="queue-stat-dot done" />已完成<strong>{done}</strong></div>
        <div><span className="queue-stat-dot error" />失败<strong>{failed}</strong></div>
      </div>
    </div>
  )
}






function App() {
  const [nav, setNav] = useState<Nav>('home')
  const [base, setBase] = useState(getApiBase)
  const [key, setKey] = useState(getApiKey)
  const [dir, setDir] = useState(getDownloadDir)
  const [mergeAfter, setMergeAfter] = useState(getMergeAfter)
  const [writeNfo, setWriteNfo] = useState(getWriteNfo)
  const [prefsReady, setPrefsReady] = useState(false)
  const [info, setInfo] = useState<KeyInfo | null>(null)
  const [deviceCode, setDeviceCode] = useState('')
  const [licenseChecked, setLicenseChecked] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [bootError, setBootError] = useState('')
  const [busy, setBusy] = useState(false)
  const [homeLoading, setHomeLoading] = useState(() => Boolean(getApiBase() && getApiKey()))
  const [searchLoading, setSearchLoading] = useState(false)
  const [rankLoading, setRankLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)

  const [home, setHome] = useState<SeriesHit[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SeriesHit[]>([])
  const [rankId, setRankId] = useState<(typeof RANKS)[number]['id']>('hot-drama')
  const [rankItems, setRankItems] = useState<RankItem[]>([])
  const [detail, setDetail] = useState<SeriesDetail | null>(null)
  const [detailCover, setDetailCover] = useState('')
  const [detailTags, setDetailTags] = useState<string[]>([])
  const [detailIntro, setDetailIntro] = useState('')
  const [detailActors, setDetailActors] = useState('')
  const [detailCast, setDetailCast] = useState<Celebrity[]>([])
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [tasks, setTasks] = useState<Task[]>([])
  const authAttempt = useRef(0)
  const running = useRef(0)
  const started = useRef(new Set<string>())
  const nfoReady = useRef(new Set<string>())
  const coverReady = useRef(new Set<string>())
  const mergeJobs = useRef<Array<{ key: string; seriesId: string; title: string; ids: string[]; folder: string; epFirst: number; epLast: number }>>([])
  const mergeStarted = useRef(new Set<string>())

  const ready = prefsReady && licenseChecked && info?.status === 'active'

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const prefs = await loadPrefs()
      if (cancelled) return
      const nextBase = (prefs?.apiBase || getApiBase()).trim().replace(/\/+$/, '')
      const nextKey = prefs?.apiKey || getApiKey()
      const nextDir = prefs?.downloadDir || getDownloadDir()
      const hasDisk = Boolean(prefs && (prefs.apiBase || prefs.apiKey || prefs.downloadDir))
      const nextMerge = migrateMergeDefault() ? false : hasDisk ? Boolean(prefs?.mergeAfter) : getMergeAfter()
      const nextNfo = hasDisk ? Boolean(prefs?.writeNfo) : getWriteNfo()
      setBase(nextBase)
      setKey(nextKey)
      setDir(nextDir)
      setMergeAfter(nextMerge)
      setWriteNfo(nextNfo)
      saveSettings(nextBase, nextKey, nextDir, nextMerge, nextNfo)
      setPrefsReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    const promise = listen<{ taskId: string; received: number; total: number }>('download-progress', (ev) => {
      const p = ev.payload
      setTasks((list) =>
        list.map((t) => (t.id === p.taskId ? { ...t, received: p.received, total: p.total } : t)),
      )
    })
    void promise
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const authBase = getApiBase()
    const authKey = getApiKey()
    if (!prefsReady || !authBase || !authKey) {
      return
    }
    let cancelled = false
    const attempt = ++authAttempt.current
    void (async () => {
      await Promise.resolve()
      if (cancelled || authAttempt.current !== attempt) return
      setAuthLoading(true)
      setBootError('')
      try {
        const fingerprint = await getDeviceFingerprint()
        if (cancelled || authAttempt.current !== attempt) return
        configureApi(authBase, fingerprint.deviceCode)
        setDeviceCode(fingerprint.deviceCode)
        const data = await remaining(fingerprint.deviceCode)
        if (cancelled || authAttempt.current !== attempt) return
        setInfo(data)
        setLicenseChecked(data?.status === 'active')
      } catch (e) {
        if (!cancelled && authAttempt.current === attempt) {
          setInfo(null)
          setLicenseChecked(false)
          setBootError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!cancelled && authAttempt.current === attempt) setAuthLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [prefsReady])

  useEffect(() => {
    if (!ready || !deviceCode) return
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (cancelled) return
      setHomeLoading(true)
      try {
        const lib = await fetchLibrary()
        if (!cancelled) setHome((lib.series || []).filter((s) => s.seriesId && s.title))
      } catch (e) {
        if (!cancelled) setBootError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setHomeLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ready, deviceCode])


  useEffect(() => {
    if (!ready || !deviceCode || nav !== 'rank') return
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (cancelled) return
      setRankLoading(true)
      try {
        const data = await fetchRank(rankId)
        if (!cancelled) setRankItems(data.items || [])
      } catch (e) {
        if (!cancelled) setBootError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setRankLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [nav, rankId, ready, deviceCode])

  async function onSave() {
    const nextBase = base.trim().replace(/\/+$/, '')
    const nextKey = key.trim()
    if (!nextBase) {
      setBootError('请先填写授权网关地址')
      return
    }
    try {
      const parsed = new URL(nextBase)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('授权网关地址必须使用 http 或 https')
    } catch (e) {
      setBootError(e instanceof Error && e.message.includes('必须') ? e.message : '授权网关地址格式无效')
      return
    }
    if (!nextKey) {
      setBootError('请先填写卡密')
      return
    }
    authAttempt.current += 1
    saveSettings(nextBase, nextKey, dir, mergeAfter, writeNfo)
    setBase(nextBase)
    setKey(nextKey)
    setBusy(true)
    setBootError('')
    setLicenseChecked(false)
    setInfo(null)
    try {
      const fingerprint = await getDeviceFingerprint()
      configureApi(nextBase, fingerprint.deviceCode)
      setDeviceCode(fingerprint.deviceCode)
      const data = await activateKey(nextKey, fingerprint.deviceCode)
      setInfo(data)
      setLicenseChecked(data.status === 'active')
      const lib = await fetchLibrary()
      setHome((lib.series || []).filter((s) => s.seriesId && s.title))
      setNav('home')
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function updateMergeAfter(next: boolean) {
    if (next && !mergeAfter) {
      const confirmed = window.confirm(
        '危险操作：合并成功后会删除原始分集文件，只保留一份整部 MP4。请确认已备份分集文件。',
      )
      if (!confirmed) return
    }
    setMergeAfter(next)
    saveSettings(base, key, dir, next, writeNfo)
  }

  async function openSeries(id: string, meta?: SeriesHit | RankItem) {
    setBootError('')
    setDetail(null)
    setDetailLoading(true)
    setDetailCover(meta?.cover || '')
    setDetailTags(meta?.tags || [])
    setDetailIntro(meta?.intro || '')
    setDetailActors(meta && 'actors' in meta ? meta.actors || '' : '')
    setDetailCast(normalizeCast(meta))
    try {
      const d = await fetchSeries(id)
      setDetail(d)
      setDetailCover(d.cover || meta?.cover || '')
      setDetailTags(d.tags || meta?.tags || [])
      setDetailIntro(d.intro || meta?.intro || '')
      setDetailActors(d.actors || (meta && 'actors' in meta ? meta.actors || '' : ''))
      let cast = normalizeCast(meta)
      if (cast.length === 0) cast = normalizeCast(d)
      setDetailCast(cast)
      const next: Record<string, boolean> = {}
      for (const ep of d.episodes || []) next[ep.vid] = true
      setPicked(next)
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e))
    } finally {
      setDetailLoading(false)
    }
  }


  async function onSearch(ev: FormEvent) {
    ev.preventDefault()
    if (!query.trim()) return
    setDetail(null)
    setDetailLoading(false)
    setNav('search')
    setSearchLoading(true)
    try {
      const d = await fetchSearch(query.trim())
      setHits((d.series || []).filter((s) => s.seriesId && s.title))
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearchLoading(false)
    }
  }

  async function pickDir() {
    try {
      const chosen = await invoke<string | null>('pick_directory')
      if (chosen) {
        setDir(chosen)
        saveSettings(getApiBase() || base, getApiKey() || key, chosen, mergeAfter, writeNfo)
      }
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e))
    }
  }

  function enqueue(detail: SeriesDetail, episodes: Episode[]) {
    const folder = getDownloadDir() || dir
    if (!folder) {
      setDetail(null)
      setNav('settings')
      setBootError('先设置下载目录')
      return
    }
    const existing = new Set(
      tasks
        .filter((task) => task.kind !== 'merge' && task.seriesId === detail.seriesId && task.status !== 'error')
        .map((task) => task.ep),
    )
    const selected = new Set(existing)
    const eps = [...episodes]
      .sort((a, b) => a.ep - b.ep)
      .filter((ep) => {
        if (selected.has(ep.ep)) return false
        selected.add(ep.ep)
        return true
      })
    if (eps.length === 0) {
      setBootError('所选集数已在下载队列中')
      return
    }
    const stamp = Date.now()
    const season = seasonDir(folder, detail.title)
    const add: Task[] = eps.map((ep) => ({
      id: `${detail.seriesId}-${ep.vid}-${stamp}-${ep.ep}`,
      seriesId: detail.seriesId,
      title: detail.title,
      ep: ep.ep,
      vid: ep.vid,
      status: 'queued' as const,
      received: 0,
      total: 0,
      message: '',
      kind: 'ep' as const,
      cover: detailCover,
      tags: detailTags,
      intro: detailIntro,
      actors: detailActors,
      celebrities: detailCast,
      epTitle: ep.title || `第 ${ep.ep} 集`,
      totalEps: episodeCount(detail) || episodes.length,
    }))
    if (mergeAfter && add.length >= 2) {
      mergeJobs.current.push({
        key: `${detail.seriesId}-${stamp}`,
        seriesId: detail.seriesId,
        title: detail.title,
        ids: add.map((t) => t.id),
        folder: season,
        epFirst: add[0].ep,
        epLast: add[add.length - 1].ep,
      })
    }
    setDetail(null)
    setTasks((list) => [...add, ...list])
    setNav('queue')
  }



  useEffect(() => {
    const next = tasks.find((t) => t.status === 'queued' && !started.current.has(t.id))
    if (!next || running.current >= 2) return
    started.current.add(next.id)
    running.current += 1
    setTasks((list) => list.map((t) => (t.id === next.id ? { ...t, status: 'running' } : t)))
    void (async () => {
      try {
        const cdn = await fetchCdn(next.vid)
        const root = getDownloadDir() || dir
        const show = seriesDir(root, next.title)
        const dest = seasonDir(root, next.title)
        const filename = `${next.title} - S01E${String(next.ep).padStart(2, '0')}`
        let path = ''
        let lastError: unknown
        for (const url of [cdn.url, ...(cdn.backupUrls || [])].filter(Boolean)) {
          try {
            path = await invoke<string>('download_decrypt', {
              taskId: next.id,
              url,
              keyHex: cdn.key || '',
              destDir: dest,
              filename,
            })
            break
          } catch (error) {
            lastError = error
          }
        }
        if (!path) throw lastError instanceof Error ? lastError : new Error('所有 CDN 地址均不可用')
        if (writeNfo) {
          try {
            if (next.cover && !coverReady.current.has(next.seriesId)) {
              await invoke('download_cover', { url: next.cover, destPath: joinPath(show, 'poster.jpg') })
              coverReady.current.add(next.seriesId)
            }
            if (!nfoReady.current.has(next.seriesId)) {
              await invoke('write_tvshow_nfo', {
                folder: show,
                meta: {
                  title: next.title,
                  plot: next.intro || '',
                  genres: next.tags || [],
                  actors: next.actors || '',
                  cast: (next.celebrities || []).map((person) => ({
                    name: person.nickname || person.name || '',
                    role: person.role,
                    thumb: person.avatar || person.thumb,
                  })),
                  episodeCount: next.totalEps || 0,
                  uniqueId: next.seriesId,
                },
              })
              nfoReady.current.add(next.seriesId)
            }
            await invoke('write_episode_nfo', {
              mediaPath: path,
              showTitle: next.title,
              episode: next.ep,
              title: next.epTitle,
            })
          } catch {
            /* video already saved */
          }
        }
        setTasks((list) =>
          list.map((t) => (t.id === next.id ? { ...t, status: 'done', message: path, received: t.total || t.received } : t)),
        )
      } catch (e) {
        setTasks((list) =>
          list.map((t) =>
            t.id === next.id ? { ...t, status: 'error', message: e instanceof Error ? e.message : String(e) } : t,
          ),
        )
      } finally {
        running.current = Math.max(0, running.current - 1)
      }
    })()
  }, [tasks, dir, writeNfo])

  useEffect(() => {
    for (const job of mergeJobs.current) {
      if (mergeStarted.current.has(job.key)) continue
      const parts = job.ids.map((id) => tasks.find((t) => t.id === id))
      if (parts.some((t) => !t || t.status === 'queued' || t.status === 'running')) continue
      mergeStarted.current.add(job.key)
      const mergeId = `merge-${job.key}`
      if (parts.some((t) => t && t.status === 'error')) {
        setTasks((list) => [
          {
            id: mergeId,
            seriesId: job.seriesId,
            title: job.title,
            ep: 0,
            vid: '',
            status: 'error',
            received: 0,
            total: 0,
            message: '有分集失败，未合并',
            kind: 'merge',
          },
          ...list,
        ])
        continue
      }
      const done = parts
        .filter((t): t is Task => Boolean(t && t.status === 'done' && t.message))
        .sort((a, b) => a.ep - b.ep)
      const files = done.map((t) => t.message)
      if (files.length < 2) continue
      const pad = (n: number) => String(n).padStart(2, '0')
      const output = joinPath(job.folder, `${job.title} - S01E${pad(job.epFirst)}-E${pad(job.epLast)}.mp4`)
      setTasks((list) => [
        {
          id: mergeId,
          seriesId: job.seriesId,
          title: job.title,
          ep: 0,
          vid: '',
          status: 'running',
          received: 0,
          total: 1,
          message: '正在合并…',
          kind: 'merge',
        },
        ...list,
      ])
      void invoke<string>('merge_collections', { inputPaths: files, outputPath: output })
        .then(async (path) => {
          const stale = files.filter((file) => file && file !== path)
          if (stale.length) {
            await invoke('remove_files', { paths: stale }).catch(() => undefined)
          }
          setTasks((list) =>
            list.map((t) =>
              t.id === mergeId ? { ...t, status: 'done', message: path, received: 1, total: 1 } : t,
            ),
          )
        })
        .catch((e) => {
          setTasks((list) =>
            list.map((t) =>
              t.id === mergeId ? { ...t, status: 'error', message: e instanceof Error ? e.message : String(e) } : t,
            ),
          )
        })
    }
  }, [tasks, dir])
  function retryMerge(seriesId: string) {
    for (const job of mergeJobs.current) {
      if (job.seriesId !== seriesId) continue
      mergeStarted.current.delete(job.key)
    }
    setTasks((list) => list.filter((t) => !(t.kind === 'merge' && t.seriesId === seriesId)))
  }

  function retryDownloads(seriesId: string) {
    for (const job of mergeJobs.current) {
      if (job.seriesId === seriesId) mergeStarted.current.delete(job.key)
    }
    setTasks((list) =>
      list
        .filter((task) => !(task.kind === 'merge' && task.seriesId === seriesId))
        .map((task) => {
          if (task.kind === 'ep' && task.seriesId === seriesId && task.status === 'error') {
            started.current.delete(task.id)
            return { ...task, status: 'queued', received: 0, total: 0, message: '' }
          }
          return task
        }),
    )
  }




  const selectedEps = useMemo(() => {
    if (!detail) return []
    return (detail.episodes || []).filter((ep) => picked[ep.vid])
  }, [detail, picked])

  const seriesGroups = useMemo(() => groupSeries(tasks), [tasks])
  const activeGroups = seriesGroups.filter((g) => g.phase === 'downloading' || g.phase === 'merging')
  const doneGroups = seriesGroups.filter((g) => g.phase === 'done' || g.phase === 'error')



  return (
    <div className="shell">
      <header className="titlebar" data-tauri-drag-region>
        <strong>DuckDuck</strong>
        <span className="titlebar-status">
          {info ? `${licenseStatusLabels[info.status]}${info.expire_time ? ` · ${info.expire_time}` : ''}` : '未激活'}
        </span>
        <div className="win-btns">
          <button
            type="button"
            aria-label="最小化"
            title="最小化"
            onClick={() => {
              try {
                void getCurrentWindow().minimize()
              } catch {
                /* browser preview */
              }
            }}
          >
            ─
          </button>
          <button
            type="button"
            aria-label="最大化"
            title="最大化"
            onClick={() => {
              try {
                void getCurrentWindow().toggleMaximize()
              } catch {
                /* browser preview */
              }
            }}
          >
            □
          </button>
          <button
            type="button"
            className="close"
            aria-label="关闭"
            title="关闭"
            onClick={() => {
              try {
                void getCurrentWindow().close()
              } catch {
                /* browser preview */
              }
            }}
          >
            ×
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="rail">
          <form className="search" onSubmit={onSearch}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索剧名" />
          </form>
          <nav>
            {(
              [
                ['home', '首页'],
                ['search', '搜索'],
                ['rank', '榜单'],
                ['queue', '下载'],
                ['settings', '设置'],
              ] as Array<[Nav, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={nav === id ? 'on' : ''}
                onClick={() => {
                  setDetail(null)
                  setDetailLoading(false)
                  setNav(id)
                }}
              >
                {label}
                {id === 'queue' && activeGroups.length > 0 ? <em>{activeGroups.length}</em> : null}
              </button>
            ))}
          </nav>
          {info && (
            <div className="keychip">
              <small>剩余</small>
              <b>{info.status === 'active' ? `${info.remain_days.toFixed(2)} 天` : licenseStatusLabels[info.status]}</b>
            </div>
          )}
        </aside>

        <main className="main">
          {bootError ? <div className="banner" role="alert">{bootError}</div> : null}
          {prefsReady && !ready && nav !== 'settings' ? (
            <section className="gate">
              <h1>{authLoading ? '正在校验卡密' : '先激活卡密'}</h1>
              <p>填写授权网关地址和卡密，激活后即可浏览和下载 1080p。</p>
              <button type="button" className="primary" onClick={() => setNav('settings')} disabled={authLoading}>
                {authLoading ? '校验中…' : '打开设置'}
              </button>
            </section>
          ) : null}

          {ready && nav === 'home' && !detail && !detailLoading ? (
            <PosterGrid title="首页" items={home} loading={homeLoading} onOpen={openSeries} />
          ) : null}

          {ready && nav === 'search' && !detail && !detailLoading ? (
            <PosterGrid title={query ? `搜索 · ${query}` : '搜索'} items={hits} loading={searchLoading} onOpen={openSeries} />
          ) : null}

          {ready && nav === 'rank' && !detail && !detailLoading ? (
            <section>
              <div className="toolbar">
                <h1>榜单</h1>
                <div className="pills">
                  {RANKS.map((r) => (
                    <button key={r.id} type="button" className={rankId === r.id ? 'on' : ''} onClick={() => setRankId(r.id)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
              {rankLoading ? (
                <SkeletonGrid />
              ) : (
                <div className="grid">
                  {rankItems.map((item) => {
                    const n = episodeCount(item)
                    return (
                      <button key={item.seriesId} type="button" className="card" onClick={() => void openSeries(item.seriesId, item)}>
                        {item.cover ? <img src={item.cover} alt={`${item.title} 海报`} /> : <div className="ph" />}
                        {item.rank ? <span className="rank">{item.rank}</span> : null}
                        {n > 0 ? <span className="epbadge">{n} 集</span> : null}
                        <cite>{item.title}</cite>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          ) : null}

          {detailLoading && !detail ? <DetailSkeleton cover={detailCover} /> : null}

          {detail ? (
            <section className="emby">
              <div
                className="hero"
                style={detailCover ? { backgroundImage: `url(${detailCover})` } : undefined}
              >
                <div className="hero-scrim">
                  <button
                    type="button"
                    className="back"
                    onClick={() => {
                      setDetail(null)
                      setDetailLoading(false)
                    }}
                  >
                    返回
                  </button>
                  <div className="hero-row">
                    {detailCover ? <img className="poster" src={detailCover} alt={`${detail.title} 海报`} /> : <div className="poster ph" />}
                    <div className="hero-meta">
                      <h1>{detail.title}</h1>
                      <p className="facts">
                        {episodeCount(detail) || detail.episodes.length} 集 · 1080p HEVC
                      </p>
                      {detailTags.length > 0 ? (
                        <div className="tags">
                          {detailTags.map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                      ) : null}
                      {detailIntro ? <p className="intro">{detailIntro}</p> : null}
                      <div className="detail-actions">
                        <button
                          type="button"
                          onClick={() => {
                            const all = Object.fromEntries((detail.episodes || []).map((ep) => [ep.vid, true]))
                            setPicked(all)
                          }}
                        >
                          全选
                        </button>
                        <button type="button" onClick={() => setPicked({})}>
                          清空
                        </button>
                        <label className="optchip">
                          <input
                            type="checkbox"
                            checked={mergeAfter}
                            onChange={(e) => updateMergeAfter(e.target.checked)}
                          />
                          合并已选集 <span className="optchip-note">{mergeAfter ? '已开启' : '默认关闭'}</span>
                        </label>
                        <label className="optchip">
                          <input
                            type="checkbox"
                            checked={writeNfo}
                            onChange={(e) => {
                              const next = e.target.checked
                              setWriteNfo(next)
                              saveSettings(base, key, dir, mergeAfter, next)
                            }}
                          />
                          封面 NFO
                        </label>
                        <button
                          type="button"
                          className="primary"
                          onClick={() => enqueue(detail, selectedEps)}
                          disabled={selectedEps.length === 0}
                        >
                          下载 {selectedEps.length} 集
                        </button>
                      </div>
                      {mergeAfter ? (
                        <div className="merge-warning" role="alert">
                          <strong>危险操作</strong>
                          <span>整批合并成功后会删除原始分集文件，只保留一份整部 MP4。请确认已完成备份。</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
              <div className="season">
                <h2>剧集</h2>
                <div className="ep-list">
                  {(detail.episodes || []).map((ep) => (
                    <label key={ep.vid} className={picked[ep.vid] ? 'ep-row on' : 'ep-row'}>
                      <input
                        type="checkbox"
                        checked={!!picked[ep.vid]}
                        onChange={(e) => setPicked((p) => ({ ...p, [ep.vid]: e.target.checked }))}
                      />
                      <span className="ep-no">{String(ep.ep).padStart(2, '0')}</span>
                      <span className="ep-name">{ep.title || `第 ${ep.ep} 集`}</span>
                    </label>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {nav === 'queue' && !detail ? (
            <section className="queue">
              <QueueOverview tasks={tasks} onOpenSettings={() => setNav('settings')} />
              {seriesGroups.length === 0 ? (
                <div className="queue-empty">
                  <span className="queue-empty-icon" aria-hidden>↓</span>
                  <strong>还没有下载任务</strong>
                  <p>打开一部剧，勾选需要的集数，就会显示在这里。</p>
                  <button type="button" className="primary" onClick={() => setNav('home')}>浏览剧集</button>
                </div>
              ) : null}
              {activeGroups.length > 0 ? (
                <>
                  <h2>下载中</h2>
                  <ul>
                    {activeGroups.map((g) => (
                      <QueueCard key={g.seriesId} g={g} onRetryMerge={retryMerge} onRetryDownloads={retryDownloads} />
                    ))}
                  </ul>
                </>
              ) : null}
              {doneGroups.length > 0 ? (
                <>
                  <h2>已完成</h2>
                  <ul>
                    {doneGroups.map((g) => (
                      <QueueCard key={g.seriesId} g={g} onRetryMerge={retryMerge} onRetryDownloads={retryDownloads} />
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}

          {nav === 'settings' && !detail ? (
            <section className="settings">
              <h1>设置</h1>
              <h2>下载</h2>
              <label>
                下载目录
                <div className="row">
                  <input
                    value={dir}
                    onChange={(e) => setDir(e.target.value)}
                    onBlur={() => saveSettings(base, key, dir, mergeAfter, writeNfo)}
                    placeholder="D:\\Videos"
                  />
                  <button type="button" onClick={() => void pickDir()}>
                    浏览
                  </button>
                </div>
              </label>
              <label className="settings-opt">
                <input
                  type="checkbox"
                  checked={mergeAfter}
                  onChange={(e) => updateMergeAfter(e.target.checked)}
                />
                <span>
                  <b>合并全部已选集 <em className="danger-label">危险操作</em></b>
                  <small>默认关闭。合并成功后会删除原始分集文件，只保留一份整部 MP4。</small>
                  {mergeAfter ? <small className="merge-warning-inline">已开启，请确认分集文件已备份。</small> : null}
                </span>
              </label>
              <label className="settings-opt">
                <input
                  type="checkbox"
                  checked={writeNfo}
                  onChange={(e) => {
                    const next = e.target.checked
                    setWriteNfo(next)
                    saveSettings(base, key, dir, mergeAfter, next)
                  }}
                />
                <span>
                  <b>自动下载封面并生成 NFO</b>
                  <small>剧集目录里写入 poster.jpg、tvshow.nfo 和每集 .nfo，给 Emby 刮削</small>
                </span>
              </label>
              <h2>授权</h2>
              <label>
                授权网关地址
                <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://license.example.com" />
              </label>
              <label>
                卡密
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="YC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX" />
              </label>
              <button type="button" className="primary" disabled={busy} onClick={() => void onSave()}>
                {busy ? '正在接入…' : '保存并激活'}
              </button>
              {info ? (
                <p className="hint">
                  状态 {info.status}
                  {info.expire_time ? ` · 到期 ${info.expire_time}` : ''}
                </p>
              ) : null}
            </section>
          ) : null}
        </main>
      </div>
    </div>
  )
}

function SkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="grid">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card sk-card">
          <div className="ph sk" />
          <cite className="sk sk-line" />
        </div>
      ))}
    </div>
  )
}

function DetailSkeleton({ cover }: { cover: string }) {
  return (
    <section className="emby">
      <div className="hero" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        <div className="hero-scrim">
          <div className="sk sk-chip" />
          <div className="hero-row">
            {cover ? <img className="poster" src={cover} alt="剧集海报预览" /> : <div className="poster sk" />}
            <div className="hero-meta">
              <div className="sk sk-title" />
              <div className="sk sk-line" />
              <div className="sk sk-intro" />
              <div className="detail-actions">
                <div className="sk sk-btn" />
                <div className="sk sk-btn" />
                <div className="sk sk-btn wide" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="season">
        <h2>剧集</h2>
        <div className="ep-list">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="ep-row sk-ep" />
          ))}
        </div>
      </div>
    </section>
  )
}

function PosterGrid({
  title,
  items,
  onOpen,
  loading = false,
}: {
  title: string
  items: SeriesHit[]
  onOpen: (id: string, item: SeriesHit) => void
  loading?: boolean
}) {
  return (
    <section>
      <div className="toolbar">
        <h1>{title}</h1>
        <span>{loading ? '加载中…' : `${items.length} 部`}</span>
      </div>
      {loading ? <SkeletonGrid /> : null}
      {!loading && items.length === 0 ? <p className="empty">暂无内容</p> : null}
      {!loading ? (
        <div className="grid">
          {items.map((item) => {
            const n = episodeCount(item)
            return (
              <button key={item.seriesId} type="button" className="card" onClick={() => void onOpen(item.seriesId, item)}>
                {item.cover ? <img src={item.cover} alt={`${item.title} 海报`} /> : <div className="ph" />}
                {n > 0 ? <span className="epbadge">{n} 集</span> : null}
                <cite>{item.title}</cite>
              </button>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}


export default App
