import { useCallback, useEffect, useState } from 'react'
import './styles.css'
import './sync-modal.css'

import { StatusPill } from './components/ui.jsx'
import DashboardTab from './tabs/DashboardTab.jsx'
import DatabaseTab from './tabs/DatabaseTab.jsx'
import IntegrationsTab from './tabs/IntegrationsTab.jsx'
import SyncTab from './tabs/SyncTab.jsx'
import OrdersTab from './tabs/OrdersTab.jsx'
import ProblemyTab from './tabs/ProblemyTab.jsx'
import AppTab from './tabs/AppTab.jsx'
import AuditLogTab from './components/AuditLogTab.jsx'
import SyncSummaryModal from './components/SyncSummaryModal.jsx'

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
 * Powłoka aplikacji: zakładki, wspólny stan ustawień, subskrypcje IPC.
 *
 * Cała komunikacja z Node.js idzie przez `window.agent` wystawione w preload.
 * Nie ma tu try/catch wokół IPC — preload zwraca już {ok, data|error}.
 */

const TABS = [
  { id: 'dashboard', label: 'Dashboard', Component: DashboardTab },
  { id: 'database', label: 'Ustawienia Bazy', Component: DatabaseTab },
  { id: 'integrations', label: 'Integracje API', Component: IntegrationsTab },
  { id: 'sync', label: 'Synchronizacja', Component: SyncTab },
  { id: 'orders', label: 'Zamówienia', Component: OrdersTab },
  { id: 'problems', label: 'Problemy', Component: ProblemyTab },
  { id: 'log', label: 'Dziennik', Component: DziennikTab },
  { id: 'app', label: 'Aplikacja', Component: AppTab }
]

export default function App() {
  const [tab, setTab] = useState('dashboard')
  const [settings, setSettings] = useState(null)
  const [logs, setLogs] = useState([])
  const [status, setStatus] = useState({ schedulerRunning: false })
  const [banner, setBanner] = useState(null)
  const [busy, setBusy] = useState(null)
  const [syncSummary, setSyncSummary] = useState(null)

  const notify = useCallback((type, text) => {
    setBanner({ type, text })
    if (type === 'success') {
      setTimeout(() => setBanner(null), 4000)
    }
  }, [])

  const refreshSettings = useCallback(async () => {
    const res = await window.agent.getSettings()
    if (res.ok) {
      setSettings(res.data)
      setStatus((s) => ({ ...s, schedulerRunning: res.data.schedulerRunning }))
    }
    return res.ok ? res.data : null
  }, [])

  // --- ładowanie ustawień + subskrypcje ------------------------------------
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

    // subscribe zwraca funkcję odsubskrybowania — bez tego React w trybie
    // StrictMode zarejestrowałby listenery dwukrotnie.
    const offLog = window.agent.onLog((entry) => {
      setLogs((prev) => [...prev.slice(-299), entry])
    })
    const offStatus = window.agent.onStatus((patch) => {
      setStatus((prev) => ({ ...prev, ...patch }))
    })

    return () => {
      cancelled = true
      offLog()
      offStatus()
    }
  }, [notify])

  /** Uruchamia akcję IPC z blokadą przycisku i obsługą banera. */
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

  const active = TABS.find((t) => t.id === tab) ?? TABS[0]
  const ActiveComponent = active.Component

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>Wapro ⇄ Allegro / BaseLinker</h1>
          <p className="app__subtitle">
            Agent lokalny — Wapro Mag jest źródłem prawdy dla stanów magazynowych
          </p>
        </div>
        <StatusPill running={status.schedulerRunning} />
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tabs__item ${tab === t.id ? 'tabs__item--active' : ''}`}
            onClick={() => setTab(t.id)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </nav>

      {banner && (
        <div className={`banner banner--${banner.type}`} role="alert">
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Zamknij">
            ×
          </button>
        </div>
      )}

      <main className="content">
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

      <SyncSummaryModal summary={syncSummary} onClose={() => setSyncSummary(null)} />
    </div>
  )
}
