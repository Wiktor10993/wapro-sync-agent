import { useEffect, useState } from 'react'
import { Checkbox, Row } from '../components/ui.jsx'

export default function AppTab({ settings, busy, run, onSaved }) {
  const [form, setForm] = useState(settings.appearance ?? {})
  const [version, setVersion] = useState(null)
  const autoStart = settings.autoStart ?? { supported: true, enabled: false }

  useEffect(() => setForm(settings.appearance ?? {}), [settings.appearance])

  useEffect(() => {
    window.agent.getVersion().then((r) => {
      if (r.ok) setVersion(r.data)
    })
  }, [])

  const save = async (patch) => {
    const next = { ...form, ...patch }
    setForm(next)
    await run('save-app', () => window.agent.saveAppSettings(next))
    onSaved()
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Zachowanie aplikacji</h2>

        <Checkbox
          checked={form.minimizeToTray}
          onChange={(e) => save({ minimizeToTray: e.target.checked })}
        >
          Zamknięcie okna chowa aplikację do zasobnika
        </Checkbox>
        <p className="hint">
          Zalecane. Agent musi działać w tle — po wyłączeniu tej opcji zamknięcie okna
          zatrzyma synchronizację, a o nadsprzedaży dowiesz się od klienta.
        </p>

        {autoStart.supported ? (
          <>
            <Checkbox
              checked={autoStart.enabled}
              onChange={async (e) => {
                await run('autostart', () => window.agent.setAutoStart(e.target.checked))
                onSaved()
              }}
            >
              Uruchamiaj razem z systemem
            </Checkbox>
            <Checkbox
              checked={form.startMinimized}
              onChange={(e) => save({ startMinimized: e.target.checked })}
            >
              Startuj zminimalizowany (bez pokazywania okna)
            </Checkbox>
          </>
        ) : (
          <p className="hint">
            Automatyczny start nie jest obsługiwany na tym systemie — skonfiguruj go
            w ustawieniach sesji swojego środowiska graficznego.
          </p>
        )}

        <div className="button-row">
          <button
            type="button"
            className="btn"
            disabled={busy === 'logs'}
            onClick={() => run('logs', () => window.agent.openLogs())}
          >
            Otwórz folder z logami
          </button>
        </div>
        <p className="hint">
          Logi są rotowane co 5 MB, przechowywane 5 plików wstecz. To pierwsze miejsce,
          do którego warto zajrzeć przy diagnozie.
        </p>
      </section>

      <section className="card">
        <h2>O aplikacji</h2>
        <dl className="kv">
          <Row label="Wersja agenta">{version?.app ?? '—'}</Row>
          <Row label="Electron">{version?.electron ?? '—'}</Row>
          <Row label="Node.js">{version?.node ?? '—'}</Row>
          <Row label="System">{version?.platform ?? '—'}</Row>
          <Row label="Folder logów">
            <code className="small">{settings.logPath ?? '—'}</code>
          </Row>
        </dl>

        <h3 className="subhead">Co robi ten agent</h3>
        <ul className="steps">
          <li>Czyta stany magazynowe z bazy Wapro Mag (tylko odczyt).</li>
          <li>Wysyła zmienione pozycje do Cloud Huba, który rozdziela je na Allegro i BaseLinker.</li>
          <li>Pobiera zamówienia z huba i zapisuje je jako pliki XML albo do tabeli pośredniej.</li>
        </ul>
        <p className="hint">
          Wapro pozostaje źródłem prawdy dla stanów — zmiany na kanałach sprzedaży
          nigdy nie nadpisują danych w ERP.
        </p>
      </section>
    </div>
  )
}
