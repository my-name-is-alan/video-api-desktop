import { useEffect, useMemo, useState } from 'react'
import {
  checkExpiry,
  clearAdminToken,
  createLicenses,
  getAdminToken,
  getLicenses,
  getOverview,
  resetLicenseUsage,
  setAdminToken,
  toggleLicense,
  unbindLicense,
  type AdminLicense,
  type Overview,
} from './adminApi'

type View = 'overview' | 'licenses' | 'usage'
type Toast = { tone: 'success' | 'error'; message: string }

const statusLabels: Record<AdminLicense['status'], string> = {
  active: '有效', revoked: '已撤销', expired: '已到期', quota_exhausted: '配额耗尽',
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '永久'
}
function formatDay(value: string) { return value.slice(5).replace('-', '/') }
function percent(used: number, max: number) { return max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0 }

export function AdminApp() {
  const [token, setToken] = useState(getAdminToken())
  const [authenticated, setAuthenticated] = useState(Boolean(getAdminToken()))
  const [view, setView] = useState<View>('overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [licenses, setLicenses] = useState<AdminLicense[]>([])
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [search, setSearch] = useState('')

  const notify = (next: Toast) => { setToast(next); window.setTimeout(() => setToast(null), 3200) }
  const refresh = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [nextOverview, nextLicenses] = await Promise.all([getOverview(), getLicenses()])
      setOverview(nextOverview); setLicenses(nextLicenses.licenses); setAuthenticated(true)
    } catch (error) {
      if (!silent) notify({ tone: 'error', message: error instanceof Error ? error.message : '管理员令牌无效' })
      if (String(error).includes('令牌') || String(error).includes('unauthorized')) { clearAdminToken(); setAuthenticated(false) }
    } finally { setLoading(false) }
  }
  useEffect(() => {
    if (!authenticated) return
    const timer = window.setTimeout(() => { void refresh(true) }, 0)
    return () => window.clearTimeout(timer)
  }, [authenticated])

  const filteredLicenses = useMemo(() => licenses.filter((license) => `${license.keyPrefix}${license.deviceCode || ''}${license.note}`.toLowerCase().includes(search.toLowerCase())), [licenses, search])
  const topCalls = Math.max(...(overview?.chart.map((item) => item.calls) || [1]), 1)

  if (!authenticated) return <Login token={token} setToken={setToken} onLogin={() => { setAdminToken(token); setAuthenticated(true) }} />

  const mutate = async (action: () => Promise<unknown>, message: string) => {
    try { await action(); notify({ tone: 'success', message }); await refresh(true) } catch (error) { notify({ tone: 'error', message: error instanceof Error ? error.message : '操作失败' }) }
  }

  return <div className="console-shell">
    <aside className="console-sidebar">
      <div className="console-brand"><span className="brand-orb">V</span><span><strong>Vellum</strong><small>授权控制台</small></span></div>
      <div className="sidebar-caption">WORKSPACE</div>
      <nav className="console-nav" aria-label="管理导航">
        <NavItem active={view === 'overview'} icon="⌂" label="概览" onClick={() => setView('overview')} />
        <NavItem active={view === 'licenses'} icon="⌁" label="激活 Key" onClick={() => setView('licenses')} badge={licenses.length} />
        <NavItem active={view === 'usage'} icon="◒" label="用量分析" onClick={() => setView('usage')} />
      </nav>
      <div className="sidebar-footer"><div className="server-status"><span /> <span><strong>Gateway online</strong><small>授权服务正常</small></span></div><button className="sidebar-logout" onClick={() => { clearAdminToken(); setAuthenticated(false) }}>退出控制台</button></div>
    </aside>
    <main className="console-main">
      <header className="console-header"><div><p className="overline">VELLUM CONSOLE / {view.toUpperCase()}</p><h1>{view === 'overview' ? '授权概览' : view === 'licenses' ? '激活 Key' : '用量分析'}</h1><p className="header-subtitle">管理卡密生命周期、设备绑定与服务调用额度。</p></div><div className="header-actions"><span className="last-sync">同步于 {overview ? new Date(overview.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—'}</span><button className="icon-button" aria-label="刷新" onClick={() => void refresh()}>{loading ? '…' : '↻'}</button><div className="admin-avatar">AD</div></div></header>
      {view === 'overview' && <OverviewView overview={overview} licenses={licenses} topCalls={topCalls} onManage={() => setView('licenses')} />}
      {view === 'usage' && <UsageView overview={overview} topCalls={topCalls} />}
      {view === 'licenses' && <LicensesView licenses={filteredLicenses} search={search} setSearch={setSearch} onCreate={() => setShowCreate(true)} onToggle={(id) => void mutate(() => toggleLicense(id), 'Key 状态已更新')} onReset={(id) => void mutate(() => resetLicenseUsage(id), '用量已重置')} onUnbind={(id) => void mutate(() => unbindLicense(id), '设备绑定已清除')} onExpiry={async (id) => { try { const result = await checkExpiry(id); notify({ tone: result.expired ? 'error' : 'success', message: result.expired ? '该 Key 已到期' : `当前有效 · 到期日 ${formatDate(result.expiresAt)}` }) } catch (error) { notify({ tone: 'error', message: error instanceof Error ? error.message : '到期检查失败' }) } }} />}
    </main>
    {showCreate && <CreateKeyDialog onClose={() => setShowCreate(false)} onCreated={async (created) => { setShowCreate(false); await refresh(true); notify({ tone: 'success', message: `已生成 ${created} 张 Key，明文仅展示一次` }) }} />}
    {toast && <div className={`console-toast ${toast.tone}`}>{toast.tone === 'success' ? '✓' : '!'} {toast.message}</div>}
  </div>
}

function Login({ token, setToken, onLogin }: { token: string; setToken: (value: string) => void; onLogin: () => void }) {
  return <div className="login-screen"><div className="login-card"><div className="console-brand"><span className="brand-orb">V</span><span><strong>Vellum</strong><small>授权控制台</small></span></div><div className="login-rule" /><p className="overline">PRIVATE ADMIN AREA</p><h1>进入授权控制台</h1><p>使用服务端 `ADMIN_TOKEN` 继续。令牌只保存在当前浏览器会话。</p><label htmlFor="admin-token">管理员令牌</label><input id="admin-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && onLogin()} placeholder="输入 ADMIN_TOKEN" autoFocus /><button className="primary-button login-button" onClick={onLogin}>验证并进入 <span>→</span></button></div></div>
}

function NavItem({ active, icon, label, badge, onClick }: { active: boolean; icon: string; label: string; badge?: number; onClick: () => void }) { return <button className={`console-nav-item ${active ? 'active' : ''}`} onClick={onClick}><span className="nav-glyph">{icon}</span><span>{label}</span>{badge !== undefined && <em>{badge}</em>}</button> }

function OverviewView({ overview, licenses, topCalls, onManage }: { overview: Overview | null; licenses: AdminLicense[]; topCalls: number; onManage: () => void }) {
  const evaluatedAt = overview ? Date.parse(overview.checkedAt) : 0
  const expiring = overview ? licenses.filter((license) => license.expiresAt && new Date(license.expiresAt).getTime() - evaluatedAt < 7 * 86400000 && license.status === 'active').length : 0
  return <div className="view-stack"><section className="metric-grid"><Metric label="有效 Key" value={overview?.counts.active || 0} detail={`${licenses.length} 张已创建`} accent="violet" /><Metric label="累计接口调用" value={overview?.totals.calls || 0} detail="所有授权设备" accent="blue" /><Metric label="图表观看" value={overview?.totals.chartViews || 0} detail="独立观看配额" accent="mint" /><Metric label="7 日内到期" value={expiring} detail={expiring ? '需要处理' : '暂无到期风险'} accent={expiring ? 'amber' : 'slate'} /></section><div className="dashboard-grid"><section className="surface usage-card"><div className="surface-heading"><div><p className="overline">ACTIVITY / 14 DAYS</p><h2>服务调用趋势</h2></div><span className="legend"><i />接口调用</span></div><div className="bar-chart">{overview?.chart.map((item) => <div className="bar-column" key={item.day}><div className="bar-value">{item.calls || ''}</div><div className="bar-track"><span style={{ height: `${Math.max(3, (item.calls / topCalls) * 100)}%` }} /></div><small>{formatDay(item.day)}</small></div>)}</div></section><section className="surface quick-card"><div className="surface-heading"><div><p className="overline">QUICK ACTIONS</p><h2>常用操作</h2></div></div><button className="action-row" onClick={onManage}><span className="action-icon violet">＋</span><span><strong>生成激活 Key</strong><small>批量创建并设置配额</small></span><b>→</b></button><button className="action-row" onClick={onManage}><span className="action-icon blue">⌁</span><span><strong>检查设备绑定</strong><small>查看当前授权设备</small></span><b>→</b></button></section></div><section className="surface recent-card"><div className="surface-heading"><div><p className="overline">RECENT KEYS</p><h2>最近激活 Key</h2></div><button className="text-button" onClick={onManage}>查看全部 →</button></div><LicenseRows licenses={licenses.slice(0, 5)} compact /></section></div>
}

function UsageView({ overview, topCalls }: { overview: Overview | null; topCalls: number }) { return <div className="view-stack"><section className="surface usage-card usage-large"><div className="surface-heading"><div><p className="overline">USAGE ANALYTICS</p><h2>调用与图表观看</h2><p className="surface-description">近 14 天授权层记录的服务消耗。</p></div><div className="usage-totals"><strong>{overview?.totals.calls || 0}</strong><span>接口调用</span><strong>{overview?.totals.chartViews || 0}</strong><span>图表观看</span></div></div><div className="bar-chart large">{overview?.chart.map((item) => <div className="bar-column" key={item.day}><div className="bar-value">{item.calls || ''}</div><div className="bar-track"><span style={{ height: `${Math.max(3, (item.calls / topCalls) * 100)}%` }} /></div><small>{formatDay(item.day)}</small></div>)}</div></section></div> }

function Metric({ label, value, detail, accent }: { label: string; value: number; detail: string; accent: string }) { return <div className={`metric-card ${accent}`}><div className="metric-icon">{accent === 'violet' ? '⌁' : accent === 'blue' ? '↗' : accent === 'mint' ? '◒' : '◷'}</div><span>{label}</span><strong>{value.toLocaleString()}</strong><small>{detail}</small></div> }

function LicensesView({ licenses, search, setSearch, onCreate, onToggle, onReset, onUnbind, onExpiry }: { licenses: AdminLicense[]; search: string; setSearch: (value: string) => void; onCreate: () => void; onToggle: (id: string) => void; onReset: (id: string) => void; onUnbind: (id: string) => void; onExpiry: (id: string) => void }) { return <div className="view-stack"><section className="surface key-toolbar"><div><p className="overline">LICENSE INVENTORY</p><h2>全部激活 Key</h2><p className="surface-description">每张 Key 仅绑定一台设备，所有用量由授权层统一计数。</p></div><button className="primary-button" onClick={onCreate}>＋ 新建 Key</button></section><section className="surface key-table-card"><div className="table-tools"><div className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Key、设备码或备注" /></div><span className="result-count">{licenses.length} 张 Key</span></div><LicenseRows licenses={licenses} onToggle={onToggle} onReset={onReset} onUnbind={onUnbind} onExpiry={onExpiry} /></section></div> }

function LicenseRows({ licenses, compact = false, onToggle, onReset, onUnbind, onExpiry }: { licenses: AdminLicense[]; compact?: boolean; onToggle?: (id: string) => void; onReset?: (id: string) => void; onUnbind?: (id: string) => void; onExpiry?: (id: string) => void }) { if (!licenses.length) return <div className="table-empty"><span>⌁</span><strong>暂无 Key</strong><small>创建一张 Key 后会显示在这里</small></div>; return <div className="license-table"><div className="table-head"><span>Key</span><span>状态</span><span>设备绑定</span><span>调用用量</span><span>到期时间</span><span /></div>{licenses.map((license) => <div className="table-row" key={license.id}><div className="key-cell"><span className="key-mark">K</span><span><strong>{license.keyPrefix}···</strong><small>{license.note || '未添加备注'}</small></span></div><div><span className={`status-pill ${license.status}`}><i />{statusLabels[license.status]}</span></div><div className="device-cell">{license.deviceCode ? <><span className="device-dot" />{license.deviceCode.slice(0, 12)}···</> : <span className="muted">未绑定</span>}</div><div className="quota-cell"><span>{license.usedCalls} / {license.maxCalls || '∞'}</span>{!compact && license.maxCalls > 0 && <div className="quota-track"><i style={{ width: `${percent(license.usedCalls, license.maxCalls)}%` }} /></div>}</div><div className="expiry-cell">{formatDate(license.expiresAt)}{license.lastSeenAt && !compact && <small>最近 {new Date(license.lastSeenAt).toLocaleDateString('zh-CN')}</small>}</div>{!compact && <div className="row-actions"><button title="到期测试" onClick={() => onExpiry?.(license.id)}>◷</button><button title="重置用量" onClick={() => onReset?.(license.id)}>↺</button>{license.deviceCode && <button title="解除绑定" onClick={() => onUnbind?.(license.id)}>⌘</button>}<button className={license.status === 'revoked' ? 'restore' : 'danger'} title={license.status === 'revoked' ? '恢复' : '撤销'} onClick={() => onToggle?.(license.id)}>{license.status === 'revoked' ? '恢复' : '撤销'}</button></div>}</div>)}</div> }

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (count: number) => Promise<void> }) { const [count, setCount] = useState(1); const [days, setDays] = useState(30); const [calls, setCalls] = useState(100); const [charts, setCharts] = useState(20); const [note, setNote] = useState(''); const [saving, setSaving] = useState(false); const submit = async () => { setSaving(true); try { const result = await createLicenses({ count, expiresAt: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null, maxCalls: calls, maxChartViews: charts, note }); const plaintext = result.created.map((item) => item.key).join('\n'); await navigator.clipboard?.writeText(plaintext); window.alert(`已生成 ${result.created.length} 张 Key，明文已复制到剪贴板：\n\n${plaintext}`); await onCreated(result.created.length) } finally { setSaving(false) } }; return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="create-dialog"><div className="dialog-header"><div><p className="overline">NEW LICENSE BATCH</p><h2>生成激活 Key</h2></div><button className="close-button" onClick={onClose}>×</button></div><p className="dialog-description">创建后明文只展示一次，请在交付前保存好卡密。</p><div className="form-grid"><label>生成数量<input type="number" min="1" max="100" value={count} onChange={(event) => setCount(Math.min(100, Math.max(1, Number(event.target.value))))} /></label><label>有效天数<input type="number" min="0" value={days} onChange={(event) => setDays(Math.max(0, Number(event.target.value)))} /></label><label>最多调用<input type="number" min="0" value={calls} onChange={(event) => setCalls(Math.max(0, Number(event.target.value)))} /><small>0 = 不限</small></label><label>图表观看<input type="number" min="0" value={charts} onChange={(event) => setCharts(Math.max(0, Number(event.target.value)))} /><small>0 = 不限</small></label></div><label className="wide-field">备注<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：年包 / 渠道 A" /></label><div className="dialog-footer"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving} onClick={() => void submit()}>{saving ? '生成中…' : '生成并复制 Key'}</button></div></div></div> }
