import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  activateKey,
  fetchCdn,
  fetchLibrary,
  fetchRank,
  fetchSearch,
  fetchSeries,
  fetchWebSeries,
  getApiBase,
  getApiKey,
  getDownloadDir,
  getMergeAfter,
  getWriteNfo,
  loadPrefs,
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
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
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
}: {
  g: SeriesGroup
  onRetryMerge?: (seriesId: string) => void
}) {
  return (
    <li className={`queue-row ${g.phase}`}>
      {g.cover ? <img className="queue-cover" src={g.cover} alt="" /> : <div className="queue-cover" />}
      <div className="queue-meta">
        <strong>{g.title}</strong>
        <small>
          {g.label}【{g.done}/{g.total}】
        </small>
        <small>{g.hint}</small>
        {g.label === '合并失败' && onRetryMerge ? (
          <button type="button" className="queue-retry" onClick={() => onRetryMerge(g.seriesId)}>
            重试合并
          </button>
        ) : null}
      </div>
      <QueueRing value={g.pct} error={g.phase === 'error'} />
    </li>
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
  const running = useRef(0)
  const started = useRef(new Set<string>())
  const nfoReady = useRef(new Set<string>())
  const mergeJobs = useRef<Array<{ key: string; seriesId: string; title: string; ids: string[]; folder: string; epFirst: number; epLast: number }>>([])
  const mergeStarted = useRef(new Set<string>())

  const ready = prefsReady && Boolean(base.trim() && key.trim())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const prefs = await loadPrefs()
      if (cancelled) return
      const nextBase = (prefs?.apiBase || getApiBase()).replace(/\/$/, '')
      const nextKey = prefs?.apiKey || getApiKey()
      const nextDir = prefs?.downloadDir || getDownloadDir()
      const hasDisk = Boolean(prefs && (prefs.apiBase || prefs.apiKey || prefs.downloadDir))
      const nextMerge = hasDisk ? Boolean(prefs?.mergeAfter) : getMergeAfter()
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
    const un = listen<{ taskId: string; received: number; total: number }>('download-progress', (ev) => {
      const p = ev.payload
      setTasks((list) =>
        list.map((t) => (t.id === p.taskId ? { ...t, received: p.received, total: p.total } : t)),
      )
    })
    return () => {
      void un.then((fn) => fn())
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    setHomeLoading(true)
    void (async () => {
      try {
        const data = await remaining()
        setInfo(data)
        if (data.status === 'pending') {
          const act = await activateKey()
          setInfo(act)
        }
        const lib = await fetchLibrary()
        setHome((lib.series || []).filter((s) => s.seriesId && s.title))
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e))
      } finally {
        setHomeLoading(false)
      }
    })()
  }, [ready])


  useEffect(() => {
    if (!ready || nav !== 'rank') return
    setRankLoading(true)
    void fetchRank(rankId)
      .then((d) => setRankItems(d.items || []))
      .catch((e) => setBootError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRankLoading(false))
  }, [nav, rankId, ready])

  async function onSave() {
    saveSettings(base, key, dir, mergeAfter, writeNfo)
    setBusy(true)
    setBootError('')
    try {
      let data = await remaining()
      if (data.status === 'pending') data = await activateKey()
      setInfo(data)
      const lib = await fetchLibrary()
      setHome((lib.series || []).filter((s) => s.seriesId && s.title))
      setNav('home')
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
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
      let cast = normalizeCast(meta)
      if (cast.length === 0) cast = normalizeCast(d)
      if (cast.length === 0) {
        const page = await fetchWebSeries(id).catch(() => null)
        if (page) cast = normalizeCast(page)
      }
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
    const stamp = Date.now()
    const season = seasonDir(folder, detail.title)
    const eps = [...episodes].sort((a, b) => a.ep - b.ep)
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
        const path = await invoke<string>('download_decrypt', {
          taskId: next.id,
          url: cdn.url,
          keyHex: cdn.key || '',
          destDir: dest,
          filename,
        })
        if (writeNfo) {
          try {
            if (!nfoReady.current.has(next.seriesId)) {
              nfoReady.current.add(next.seriesId)
              if (next.cover) {
                await invoke('download_cover', { url: next.cover, destPath: joinPath(show, 'poster.jpg') })
              }
              await invoke('write_tvshow_nfo', {
                folder: show,
                meta: {
                  title: next.title,
                  plot: next.intro || '',
                  genres: next.tags || [],
                  actors: next.actors || '',
                  episodeCount: next.totalEps || 0,
                  uniqueId: next.seriesId,
                },
              })
            }
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
        <strong>YCDownload</strong>
        <span className="titlebar-status">
          {info ? `${info.status}${info.expire_time ? ` · ${info.expire_time}` : ''}` : '未登录'}
        </span>
        <div className="win-btns">
          <button
            type="button"
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
              <b>{info.status === 'pending' ? '待激活' : `${info.remain_days.toFixed(2)} 天`}</b>
            </div>
          )}
        </aside>

        <main className="main">
          {bootError ? <div className="banner">{bootError}</div> : null}
          {prefsReady && !ready && nav !== 'settings' ? (
            <section className="gate">
              <h1>先接入卡网</h1>
              <p>填写已部署的发卡站点地址和 Key，激活后即可浏览和下载 1080p。</p>
              <button type="button" className="primary" onClick={() => setNav('settings')}>
                打开设置
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
                        {item.cover ? <img src={item.cover} alt="" /> : <div className="ph" />}
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
                    {detailCover ? <img className="poster" src={detailCover} alt="" /> : <div className="poster ph" />}
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
                            onChange={(e) => {
                              const next = e.target.checked
                              setMergeAfter(next)
                              saveSettings(base, key, dir, next, writeNfo)
                            }}
                          />
                          合并整部
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
              <h1>下载队列</h1>
              {seriesGroups.length === 0 ? <p className="empty">还没有任务。打开一部剧勾选集数即可。</p> : null}
              {activeGroups.length > 0 ? (
                <>
                  <h2>下载中</h2>
                  <ul>
                    {activeGroups.map((g) => (
                      <QueueCard key={g.seriesId} g={g} onRetryMerge={retryMerge} />
                    ))}
                  </ul>
                </>
              ) : null}
              {doneGroups.length > 0 ? (
                <>
                  <h2>已完成</h2>
                  <ul>
                    {doneGroups.map((g) => (
                      <QueueCard key={g.seriesId} g={g} onRetryMerge={retryMerge} />
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
                  onChange={(e) => {
                    const next = e.target.checked
                    setMergeAfter(next)
                    saveSettings(base, key, dir, next, writeNfo)
                  }}
                />
                <span>
                  <b>自动合并多集为一部</b>
                  <small>同一批下载完成后，在剧集目录里再生成一份整部 mp4</small>
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
              <h2>账号</h2>
              <label>
                卡网地址
                <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://你的发卡域名" />
              </label>
              <label>
                API Key
                <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." />
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
            {cover ? <img className="poster" src={cover} alt="" /> : <div className="poster sk" />}
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
                {item.cover ? <img src={item.cover} alt="" /> : <div className="ph" />}
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
