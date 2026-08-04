import { useCallback, useEffect, useState } from 'react'
import { Empty, Tag, formatDate, formatMoney } from '../components/ui.jsx'

const STATUSES = [
  { value: '', label: 'Wszystkie' },
  { value: 'NOWE', label: 'Nowe' },
  { value: 'WYEKSPORTOWANE', label: 'Wyeksportowane' },
  { value: 'PRZETWORZONE', label: 'Przetworzone' },
  { value: 'BLAD', label: 'Błędne' },
  { value: 'POMINIETE', label: 'Pominięte' }
]

/** Kolor etykiety statusu — spójny z semantyką przepływu. */
function statusTone(status) {
  if (status === 'PRZETWORZONE') return 'ok'
  if (status === 'BLAD') return 'error'
  if (status === 'WYEKSPORTOWANE') return 'muted'
  return 'warn'
}

/**
 * Podgląd zamówień zapisanych w tabeli pośredniej `integracja.ZAMOWIENIA`.
 * Dostępny wyłącznie w trybie bazowym — w trybie XML nie ma czego pokazywać,
 * bo zamówienia są plikami w folderze.
 */
export default function OrdersTab({ settings, busy, run }) {
  const [status, setStatus] = useState('')
  const [orders, setOrders] = useState([])
  const [staging, setStaging] = useState(null)
  const [dryRun, setDryRun] = useState(null)
  const [stats, setStats] = useState(null)
  const [reflect, setReflect] = useState(null)
  const [loaded, setLoaded] = useState(false)

  const isStagingMode = settings.sync?.orderMode === 'staging'

  const refresh = useCallback(async () => {
    const st = await run('staging-status', () => window.agent.stagingStatus())
    if (st) setStaging(st)

    if (st?.ready) {
      const data = await run('staged-orders', () => window.agent.listStagedOrders({ status, limit: 200 }))
      if (data) setOrders(data)

      const s = await run('buffer-stats', () => window.agent.bufferStats())
      if (s) setStats(s)
    }
    setLoaded(true)
  }, [run, status])

  useEffect(() => {
    if (isStagingMode) refresh()
    else setLoaded(true)
  }, [isStagingMode, refresh])

  if (!isStagingMode) {
    return (
      <div className="grid">
        <section className="card card--wide">
          <h2>Tryb plików XML</h2>
          <p className="hint">
            Zamówienia są zapisywane jako pliki XML w folderze{' '}
            <code>{settings.sync?.xmlOutputFolder || '(nie wybrano)'}</code> i wciągane
            do Wapro przez import ECO. W tym trybie agent nie prowadzi własnego rejestru —
            historia jest w panelu Cloud Huba oraz w samym folderze.
          </p>
          <p className="hint">
            Aby zobaczyć tu listę zamówień, przełącz tryb na <strong>tabelę pośrednią</strong>{' '}
            w zakładce „Synchronizacja”.
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="grid">
      <section className="card card--wide">
        <h2>Tabela pośrednia w bazie Wapro</h2>

        {staging && !staging.ready && (
          <div className="result result--warn">
            <p>
              Schemat <code>integracja</code>{' '}
              {staging.exists ? 'jest niekompletny' : 'jeszcze nie istnieje'}.
              {staging.missing.length > 0 && <> Brakuje: {staging.missing.join(', ')}.</>}
            </p>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy === 'staging-create'}
              onClick={async () => {
                await run('staging-create', () => window.agent.createStagingSchema(), 'Schemat utworzony.')
                refresh()
              }}
            >
              {busy === 'staging-create' ? 'Tworzę…' : 'Utwórz schemat'}
            </button>
            <p className="hint">
              Tworzone są wyłącznie nowe obiekty w schemacie <code>integracja</code>.
              Tabele Wapro nie są modyfikowane.
            </p>
          </div>
        )}

        {staging?.ready && (
          <div className="result result--ok">
            Schemat <code>integracja</code> gotowy — komplet tabel, widok i procedury.
          </div>
        )}

        <div className="button-row">
          <button
            type="button"
            className="btn"
            disabled={busy === 'dryrun'}
            onClick={async () => {
              const r = await run('dryrun', () => window.agent.dryRun())
              if (r) setDryRun(r)
            }}
          >
            {busy === 'dryrun' ? 'Symuluję…' : 'Symulacja zapisu (bez zmian w bazie)'}
          </button>
        </div>

        {dryRun && (
          <div className={`result ${dryRun.empty ? 'result--warn' : 'result--ok'}`}>
            {dryRun.empty ? (
              dryRun.message
            ) : (
              <>
                <p>
                  <strong>{dryRun.ref}</strong> — {dryRun.preview?.items?.length ?? 0} pozycji,{' '}
                  {dryRun.preview?.unmatchedCount ?? 0} bez odpowiednika w kartotece.
                </p>
                <table className="minitable">
                  <thead>
                    <tr>
                      <th>LP</th><th>SKU</th><th>Nazwa</th><th className="num">Ilość</th><th>Dopasowanie</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dryRun.preview?.items ?? []).map((it) => (
                      <tr key={it.lp}>
                        <td>{it.lp}</td>
                        <td><code>{it.sku || it.fallbackRef}</code></td>
                        <td>{it.name}</td>
                        <td className="num">{it.quantity}</td>
                        <td>
                          <Tag tone={it.matchStatus === 'OK' ? 'ok' : 'warn'}>
                            {it.matchStatus === 'OK' ? `ID ${it.idArtykulu}` : 'brak w kartotece'}
                          </Tag>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="hint">
                  Symulacja niczego nie zapisała. Zamówienie wróci do kolejki huba
                  i zostanie przetworzone przy następnym SyncDown.
                </p>
              </>
            )}
          </div>
        )}
      </section>

      {/* ---- Reflektor: bufor → folder nasłuchu Wapro ---- */}
      <section className="card card--wide">
        <h2>Eksport bufora do Wapro</h2>

        {stats && (
          <div className="statrow">
            <div className="statbox"><b>{stats.NOWE}</b>czeka na eksport</div>
            <div className="statbox"><b>{stats.WYEKSPORTOWANE}</b>wyeksportowane</div>
            <div className="statbox"><b>{stats.PRZETWORZONE}</b>wciągnięte do Wapro</div>
            <div className={`statbox ${stats.BLAD > 0 ? 'statbox--bad' : ''}`}>
              <b>{stats.BLAD}</b>błędne
            </div>
          </div>
        )}

        <p className="hint">
          Agent zamienia wiersze bufora na pliki ECO — z wypełnionym{' '}
          <code>ID_ARTYKULU</code> — i odkłada je do folderu nasłuchu:{' '}
          <code>{settings.sync?.waproWatchFolder || '(nie wybrano)'}</code>.
          Dokument tworzy już Wapro własnym importem, więc numeracja, kontrahenci
          i rejestry VAT pozostają w gestii ERP.
        </p>

        {!settings.sync?.reflectToXml && (
          <div className="result result--warn">
            Eksport z bufora jest wyłączony. Zamówienia zostaną w tabeli
            <code> integracja.ZAMOWIENIA</code> i ktoś będzie musiał wciągnąć je ręcznie.
            Włącz opcję w zakładce „Synchronizacja”.
          </div>
        )}

        <div className="button-row">
          <button
            type="button"
            className="btn"
            disabled={busy === 'reflect-preview'}
            onClick={async () => {
              const r = await run('reflect-preview', () => window.agent.previewReflect())
              if (r) setReflect(r)
            }}
          >
            {busy === 'reflect-preview' ? 'Sprawdzam…' : 'Podejrzyj, co poszłoby do Wapro'}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy === 'reflect' || !settings.sync?.waproWatchFolder}
            onClick={async () => {
              const r = await run('reflect', () => window.agent.reflectBuffer())
              if (r) setReflect(r)
              refresh()
            }}
          >
            {busy === 'reflect' ? 'Eksportuję…' : 'Eksportuj teraz'}
          </button>
        </div>

        {reflect && (
          <div className={`result ${reflect.notRun ? 'result--warn' : 'result--ok'}`}>
            {reflect.notRun && <p>{reflect.reason}</p>}

            {reflect.dryRun && (
              <>
                <p>
                  Do eksportu gotowych: <strong>{reflect.pending}</strong> zamówień.
                  Poniżej podgląd pierwszych {reflect.preview?.length ?? 0}.
                </p>
                {(reflect.preview ?? []).map((p) => (
                  <details key={p.id} className="xmlpreview">
                    <summary>
                      <code>{p.file}</code> — {p.items} poz.
                      {p.unmatched > 0 && (
                        <span className="warn-marker"> ⚠ {p.unmatched} bez ID_ARTYKULU</span>
                      )}
                    </summary>
                    <pre>{p.xml}</pre>
                  </details>
                ))}
              </>
            )}

            {!reflect.dryRun && !reflect.notRun && (
              <p>
                Wyeksportowano <strong>{reflect.exported}</strong>, plik już istniał w{' '}
                {reflect.skipped ?? 0} przypadkach, błędów {reflect.failed ?? 0}.
                {reflect.files?.length > 0 && (
                  <> Pliki: {reflect.files.slice(0, 5).join(', ')}
                  {reflect.files.length > 5 && ` i ${reflect.files.length - 5} więcej`}.</>
                )}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="card card--wide">
        <div className="card__header">
          <h2>Zamówienia w tabeli pośredniej</h2>
          <div className="button-row button-row--tight">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="select--inline">
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <button type="button" className="btn" onClick={refresh} disabled={busy === 'staged-orders'}>
              {busy === 'staged-orders' ? 'Wczytuję…' : 'Odśwież'}
            </button>
          </div>
        </div>

        {!loaded && <Empty>Wczytywanie…</Empty>}
        {loaded && orders.length === 0 && (
          <Empty>Brak zamówień. Uruchom „Pobierz zamówienia” na Dashboardzie.</Empty>
        )}

        {orders.length > 0 && (
          <table className="minitable minitable--full">
            <thead>
              <tr>
                <th>ID</th><th>Źródło</th><th>Numer obcy</th><th>Nabywca</th>
                <th className="num">Wartość</th><th className="num">Pozycji</th>
                <th>Status</th><th>Dokument</th><th>Utworzono</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>{o.source}</td>
                  <td><code>{o.ref}</code></td>
                  <td>{o.buyer}</td>
                  <td className="num">{formatMoney(o.total, o.currency)}</td>
                  <td className="num">
                    {o.itemCount}
                    {o.unmatchedCount > 0 && (
                      <span className="warn-marker" title={`${o.unmatchedCount} pozycji bez artykułu w Wapro`}>
                        {' '}⚠ {o.unmatchedCount}
                      </span>
                    )}
                  </td>
                  <td>
                    <Tag tone={statusTone(o.status)}>{o.status}</Tag>
                  </td>
                  <td>{o.documentNumber || '—'}</td>
                  <td className="small">{formatDate(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="hint">
          Przepływ statusów: <code>NOWE</code> → agent generuje plik →{' '}
          <code>WYEKSPORTOWANE</code> → Wapro wczytuje dokument i wywołuje{' '}
          <code>integracja.SP_OZNACZ_PRZETWORZONE</code> → <code>PRZETWORZONE</code>.
          Zamówienia zatrzymane na <code>WYEKSPORTOWANE</code> oznaczają, że plik leży
          w folderze, ale ERP go jeszcze nie wciągnął.
        </p>
      </section>
    </div>
  )
}
