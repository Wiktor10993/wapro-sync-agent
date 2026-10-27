import { useCallback, useEffect, useState } from 'react'
import './styles.css'
import './sync-modal.css'
import './action-center.css'

import { StatusPill } from './components/ui.jsx'
import DashboardTab from './tabs/DashboardTab.jsx'
import DatabaseTab from './tabs/DatabaseTab.jsx'
import IntegrationsTab from './tabs/IntegrationsTab.jsx'
import SyncTab from './tabs/SyncTab.jsx'
import OrdersTab from './tabs/OrdersTab.jsx'
import ProblemyTab from './tabs/ProblemyTab.jsx'
import EksportTab from './tabs/EksportTab.jsx'
import RaportTab from './tabs/RaportTab.jsx'
import MapowanieTab from './tabs/MapowanieTab.jsx'
import AnalitykaTab from './tabs/AnalitykaTab.jsx'
import AppTab from './tabs/AppTab.jsx'
import AuditLogTab from './components/AuditLogTab.jsx'
import SyncSummaryModal from './components/SyncSummaryModal.jsx'
import UpdateToast from './components/UpdateToast.jsx'

/** Zakładka „Dziennik" — opakowuje AuditLogTab i podpina IPC (rozpakowanie {ok,data}). */
function DziennikTab() {
  const queryLogs = useCallback(async (filter) => {
    const r = await window.agent.queryAuditLog(filter)
    if (!r.ok) throw new Error(r.error)
    return r.data
  }, [])
  return <AuditLogTab queryLogs={queryLogs} />
}

/**
 * Powłoka aplikacji: boczne menu z sekcjami, wspólny stan ustawień, subskrypcje IPC.
 * Cała komunikacja z Node.js idzie przez `window.agent` wystawione w preload.
 */

const SECTIONS = [
  { title: 'Pulpit', items: [{ id: 'dashboard', label: 'Dashboard', Component: DashboardTab }] },
  {
    title: 'Konfiguracja',
    items: [
      { id: 'database', label: 'Ustawienia bazy', Component: DatabaseTab },
      { id: 'integrations', label: 'Integracje API', Component: IntegrationsTab },
      { id: 'app', label: 'Aplikacja', Component: AppTab }
    ]
  },
  {
    title: 'Synchronizacja',
    items: [
      { id: 'sync', label: 'Synchronizacja', Component: SyncTab },
      { id: 'orders', label: 'Zamówienia', Component: OrdersTab }
    ]
  },
  {
    title: 'Katalog i stany',
    items: [
      { id: 'export', label: 'Eksport CSV', Component: EksportTab },
      { id: 'report', label: 'Raport / Braki', Component: RaportTab },
      { id: 'mapping', label: 'Mapowanie', Component: MapowanieTab }
    ]
  },
  { title: 'Analityka', items: [{ id: 'analytics', label: 'Analityka', Component: AnalitykaTab }] },
  { title: 'Problemy', items: [{ id: 'problems', label: 'Problemy', Component: ProblemyTab }] },
  { title: 'System', items: [{ id: 'log', label: 'Dziennik', Component: DziennikTab }] }
]

const ALL_TABS = SECTIONS.flatMap((s) => s.items)

export default function App() {
  const [tab, setTab] = useState('dashboard')
  const [settings, setSettings] = useState(null)
  const [logs, setLogs] = useState([])
  const [status, setStatus] = useState({ schedulerRunning: false })
  const [banner, setBanner] = useState(null)
  const [busy, setBusy] = useState(null)
  const [syncSummary, setSyncSummary] = useState(null)
  const [version, setVersion] = useState('')

  const notify = useCallback((type, text) => {
    setBanner({ type, text })
    if (type === 'success') setTimeout(() => setBanner(null), 4000)
  }, [])

  // Numer wersji w nagłówku (i w nazwie okna — ustawia proces główny).
  useEffect(() => {
    window.agent.getVersion().then((r) => {
      if (r?.ok && r.data?.app) setVersion(r.data.app)
    })
  }, [])

  const checkUpdates = useCallback(async () => {
    setBusy('update-check')
    try {
      const r = await window.agent.updateCheck()
      const d = r?.ok ? r.data : null
      if (!d || !d.ok) notify('error', `Sprawdzenie aktualizacji nie powiodło się: ${d?.error ?? r?.error ?? 'nieznany błąd'}`)
      else if (d.available) notify('success', `Dostępna wersja ${d.latest} — pobieram w tle, zainstaluje się sama (albo kliknij „Zainstaluj" w powiadomieniu).`)
      else notify('success', `Masz najnowszą wersję (${d.current}).`)
    } finally {
      setBusy(null)
    }
  }, [notify])

  const refreshSettings = useCallback(async () => {
    const res = await window.agent.getSettings()
    if (res.ok) {
      setSettings(res.data)
      setStatus((s) => ({ ...s, schedulerRunning: res.data.schedulerRunning }))
    }
    return res.ok ? res.data : null
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await window.agent.getSettings()
      if (cancelled) return
      if (res.ok) {
        setSettings(res.data)
        setLogs(res.data.logs || [])
        setStatus((s) => ({ ...s, schedulerRunning: res.data.schedulerRunning }))
      } else {
        notify('error', `Nie udało się wczytać ustawień: ${res.error}`)
      }
    })()

    const offLog = window.agent.onLog((entry) => setLogs((prev) => [...prev.slice(-299), entry]))
    const offStatus = window.agent.onStatus((patch) => setStatus((prev) => ({ ...prev, ...patch })))
    return () => {
      cancelled = true
      offLog()
      offStatus()
    }
  }, [notify])

  const run = useCallback(
    async (key, fn, successMessage) => {
      setBusy(key)
      setBanner(null)
      try {
        const res = await fn()
        if (!res.ok) {
          notify('error', res.error)
          return null
        }
        if (successMessage) notify('success', successMessage)
        return res.data
      } finally {
        setBusy(null)
      }
    },
    [notify]
  )

  if (!settings) {
    return <div className="loading">Wczytywanie konfiguracji…</div>
  }

  const active = ALL_TABS.find((t) => t.id === tab) ?? ALL_TABS[0]
  const ActiveComponent = active.Component

  return (
    <div className="app app--sidebar">
      <header className="app__header">
        <div>
          <h1>
            Wapro Sync Agent{version && <span className="app__version">{version}</span>}
          </h1>
          <p className="app__subtitle">Wapro ⇄ Allegro / BaseLinker — Wapro Mag jest źródłem prawdy dla stanów</p>
        </div>
        <div className="app__header-actions">
          <button type="button" className="btn btn--small" onClick={checkUpdates} disabled={busy === 'update-check'}>
            {busy === 'update-check' ? 'Sprawdzam…' : 'Sprawdź aktualizacje'}
          </button>
          <StatusPill running={status.schedulerRunning} />
        </div>
      </header>

      {banner && (
        <div className={`banner banner--${banner.type}`} role="alert">
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Zamknij">×</button>
        </div>
      )}

      <div className="app__body">
        <aside className="sidebar">
          {SECTIONS.map((sec) => (
            <div className="sidebar__section" key={sec.title}>
              <div className="sidebar__title">{sec.title}</div>
              {sec.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={`sidebar__item ${tab === it.id ? 'sidebar__item--active' : ''}`}
                  onClick={() => setTab(it.id)}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <main className="content content--with-sidebar">
          <ActiveComponent
            settings={settings}
            logs={logs}
            status={status}
            busy={busy}
            run={run}
            onSaved={refreshSettings}
            onRefresh={refreshSettings}
            onSyncSummary={setSyncSummary}
          />
        </main>
      </div>

      <SyncSummaryModal summary={syncSummary} onClose={() => setSyncSummary(null)} />
      <UpdateToast />
    </div>
  )
}
