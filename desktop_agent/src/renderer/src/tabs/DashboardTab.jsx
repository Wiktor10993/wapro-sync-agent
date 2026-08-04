import { useEffect, useRef, useState } from 'react'
import { Badge, Row, formatDate, formatTime } from '../components/ui.jsx'

export default function DashboardTab({ settings, logs, status, busy, run, onRefresh }) {
  const logRef = useRef(null)
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    // Autoscroll tylko gdy użytkownik jest przy dole — inaczej wyrywalibyśmy
    // mu widok przy przeglądaniu historii.
    const el = logRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [logs])

  const dbConfigured = Boolean(settings.db?.host && settings.db?.database)
  const bl = settings.integrations?.baselinker ?? {}
  const blConfigured = Boolean(bl.hasToken && bl.inventoryId)
  const allegroAuthorized = Boolean(settings.integrations?.allegro?.authorized)

  return (
    <div className="grid">
      <section className="card">
        <h2>Status systemu</h2>
        <dl className="kv">
          <Row label="Baza Wapro (MSSQL)">
            <Badge ok={dbConfigured}>
              {dbConfigured ? `${settings.db.host} / ${settings.db.database}` : 'nieskonfigurowana'}
            </Badge>
          </Row>
          <Row label="BaseLinker">
            <Badge ok={blConfigured}>
              {blConfigured ? `katalog ${bl.inventoryId}` : 'nieskonfigurowany'}
            </Badge>
          </Row>
          <Row label="Allegro">
            <Badge ok={allegroAuthorized}>
              {allegroAuthorized ? 'połączone' : 'niepołączone'}
            </Badge>
          </Row>
          <Row label="Harmonogram">
            <Badge ok={status.schedulerRunning}>
              {status.schedulerRunning ? 'działa' : 'zatrzymany'}
            </Badge>
          </Row>
          <Row label="Tryb zapisu zamówień">
            {settings.sync?.orderMode === 'staging' ? 'tabela pośrednia w bazie' : 'pliki XML (ECO)'}
          </Row>
          <Row label="SKU w pamięci agenta">{settings.trackedSkuCount ?? 0}</Row>
          <Row label="Ostatni SyncUp (BaseLinker)">{formatDate(settings.lastSyncUpAt)}</Row>
          {settings.sync?.allegroStockEnabled && (
            <Row label="Ostatni SyncUp (Allegro)">{formatDate(settings.lastSyncUpAllegroAt)}</Row>
          )}
          <Row label="Ostatni SyncDown (zamówienia)">{formatDate(settings.lastSyncDownAt)}</Row>
          <Row label="Szyfrowanie haseł">
            <Badge ok={settings.encryptionAvailable}>
              {settings.encryptionAvailable ? 'systemowe (Keychain/DPAPI)' : 'NIEDOSTĘPNE'}
            </Badge>
          </Row>
        </dl>

        {!settings.encryptionAvailable && (
          <div className="result result--warn">
            System nie udostępnia magazynu kluczy — hasło do MSSQL i klucz API są
            zapisane w pliku konfiguracyjnym jawnie. Ogranicz dostęp do konta użytkownika.
          </div>
        )}
      </section>

      <section className="card">
        <h2>Sterowanie</h2>

        {(!dbConfigured || !blConfigured) && (
          <p className="hint">
            Wskazówka: stany czytamy z{' '}
            {!dbConfigured ? <strong>bazy Wapro</strong> : 'bazy Wapro'} i wysyłamy do{' '}
            {!blConfigured ? <strong>BaseLinkera</strong> : 'BaseLinkera'} (token i ID katalogu
            w zakładce „Integracje API”). Synchronizacja działa w pełni lokalnie — bez chmury.
          </p>
        )}

        <div className="button-row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy === 'up' || !dbConfigured}
            onClick={() => run('up', () => window.agent.runSyncUp()).then(onRefresh)}
          >
            {busy === 'up' ? 'Wysyłam…' : 'Wyślij stany na BaseLinker'}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy === 'up-allegro' || !dbConfigured || !allegroAuthorized}
            title={!allegroAuthorized ? 'Najpierw połącz konto Allegro (zakładka Integracje API).' : undefined}
            onClick={() => run('up-allegro', () => window.agent.runAllegroSyncUp()).then(onRefresh)}
          >
            {busy === 'up-allegro' ? 'Wysyłam…' : 'Wyślij stany na Allegro'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy === 'down' || !blConfigured}
            onClick={() => run('down', () => window.agent.runSyncDown()).then(onRefresh)}
          >
            {busy === 'down' ? 'Pobieram…' : 'Pobierz zamówienia teraz'}
          </button>
          {status.schedulerRunning ? (
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy === 'sched'}
              onClick={() => run('sched', () => window.agent.stopScheduler(), 'Harmonogram zatrzymany.')}
            >
              Zatrzymaj harmonogram
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy === 'sched' || !dbConfigured}
              onClick={() => run('sched', () => window.agent.startScheduler(), 'Harmonogram uruchomiony.')}
            >
              Uruchom harmonogram
            </button>
          )}
        </div>

        <p className="hint">
          Ręczne uruchomienie nie koliduje z harmonogramem — jeśli zadanie już trwa,
          drugi przebieg zostanie pominięty.
        </p>

        <div className="button-row">
          <button
            type="button"
            className="btn"
            disabled={busy === 'preview' || !dbConfigured}
            onClick={async () => {
              const data = await run('preview', () => window.agent.previewStock(20))
              if (data) setPreview(data)
            }}
          >
            {busy === 'preview' ? 'Czytam…' : 'Podejrzyj stany z Wapro'}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy === 'reset'}
            onClick={() => {
              if (
                confirm(
                  'Wyczyścić pamięć stanów?\n\nNastępny SyncUp wyśle WSZYSTKIE SKU zamiast tylko zmienionych. ' +
                    'Użyj, gdy podejrzewasz rozjechanie stanów z kanałami.'
                )
              ) {
                run('reset', () => window.agent.resetCache(), 'Pamięć wyczyszczona.').then(onRefresh)
              }
            }}
          >
            Wymuś pełną resynchronizację
          </button>
        </div>

        {preview && (
          <div className="result result--ok">
            <p>
              Zapytanie zwróciło <strong>{preview.total}</strong> pozycji. Pierwsze{' '}
              {preview.sample.length}:
            </p>
            <table className="minitable">
              <thead><tr><th>SKU</th><th>Nazwa</th><th className="num">Stan</th></tr></thead>
              <tbody>
                {preview.sample.map((r) => (
                  <tr key={`${r.sku}-${r.warehouseId ?? 'agg'}`}>
                    <td><code>{r.sku}</code></td>
                    <td>{r.name}</td>
                    <td className="num">{r.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card--wide">
        <div className="card__header">
          <h2>Logi</h2>
          <button type="button" className="btn btn--tiny" onClick={() => window.agent.openLogs()}>
            Otwórz folder z logami
          </button>
        </div>
        <div className="log" ref={logRef}>
          {logs.length === 0 && <p className="log__empty">Brak wpisów.</p>}
          {logs.map((entry, i) => (
            <div key={`${entry.at}-${i}`} className={`log__line log__line--${entry.level}`}>
              <span className="log__time">{formatTime(entry.at)}</span>
              <span className="log__msg">{entry.message}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
