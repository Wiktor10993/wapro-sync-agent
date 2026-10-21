import { useCallback, useEffect, useState } from 'react'

/**
 * Mapowanie produktów z pliku CSV (v6.5): jeden wzorzec z kolumną na każde konto
 * Allegro i na BaseLinkera (+ instrukcja). Wypełniona komórka = mapujemy ten
 * kanał/konto, pusta = bez zmian. Produkty-widma (ze starszego importu) poniżej.
 */
export default function MapowanieTab({ busy, run }) {
  const [phantoms, setPhantoms] = useState([])

  const loadPhantoms = useCallback(async () => {
    const r = await window.agent.mappingListPhantom()
    if (r.ok) setPhantoms(r.data || [])
  }, [])

  useEffect(() => { loadPhantoms() }, [loadPhantoms])

  const resolvePhantom = useCallback(
    async (id) => {
      await run('phantom', () => window.agent.mappingResolvePhantom(id, 'ignore'))
      loadPhantoms()
    },
    [run, loadPhantoms]
  )

  // --- masowe mapowanie (override wysyłki stanów) --------------------------
  const [bulkCounts, setBulkCounts] = useState({ allegro: 0, baselinker: 0 })
  const [bulkResult, setBulkResult] = useState(null)

  const loadBulkCounts = useCallback(async () => {
    const r = await window.agent.mappingBulkCounts()
    if (r.ok) setBulkCounts(r.data || { allegro: 0, baselinker: 0 })
  }, [])
  useEffect(() => { loadBulkCounts() }, [loadBulkCounts])

  const bulkTemplate = useCallback(async () => {
    const picked = await window.agent.pickExportFolder()
    if (!picked.ok || !picked.data) return
    await run('bulk-tpl', () => window.agent.mappingBulkTemplate(picked.data), 'Wzorzec i instrukcja zapisane.')
  }, [run])

  const bulkImport = useCallback(async () => {
    const picked = await window.agent.pickCsvFile()
    if (!picked.ok || !picked.data) return
    const d = await run('bulk-imp', () => window.agent.mappingBulkImport(picked.data), 'Mapowanie wczytane.')
    if (d) { setBulkResult(d); loadBulkCounts() }
  }, [run, loadBulkCounts])

  const bulkClear = useCallback(
    async (channel) => {
      if (!window.confirm(`Wyczyścić zapisane mapowania (${channel})?`)) return
      await run('bulk-clr', () => window.agent.mappingBulkClear(channel))
      loadBulkCounts()
    },
    [run, loadBulkCounts]
  )

  return (
    <div className="tab-narzedzia">
      <section className="card">
        <h2>Mapowanie produktów (plik CSV) — wpływa na wysyłkę stanów</h2>
        <p className="muted">
          1. Pobierz wzorzec — jeden wiersz na produkt WAPRO, już uzupełniony tym, co jest zmapowane teraz.
          Obok zapisuje się plik <code>_INSTRUKCJA.txt</code> z opisem kolumn.
          <br />
          2. Wpisz numery ofert w kolumny: <code>allegro_&lt;konto&gt;_numer_oferty</code> (osobna kolumna dla każdego konta Allegro)
          i <code>baselinker_id_produktu</code>.
          <br />
          3. Wgraj plik. <strong>Wpisane oba numery → mapujemy oba kanały, jeden → tylko ten, pusta komórka → bez zmian.</strong>{' '}
          Mapowanie z pliku ma pierwszeństwo przed automatycznym, a zmapowane produkty wyślą stan w najbliższej synchronizacji.
        </p>
        <p className="result-summary">
          Zapisane mapowania — Allegro: <strong>{bulkCounts.allegro}</strong>, BaseLinker: <strong>{bulkCounts.baselinker}</strong>
        </p>
        <div className="button-row">
          <button type="button" className="btn" onClick={bulkTemplate} disabled={busy === 'bulk-tpl'}>
            {busy === 'bulk-tpl' ? <><span className="spinner" /> Przygotowuję…</> : 'Pobierz wzorzec + instrukcję'}
          </button>
          <button type="button" className="btn btn--primary" onClick={bulkImport} disabled={busy === 'bulk-imp'}>
            {busy === 'bulk-imp' ? <><span className="spinner" /> Wczytuję…</> : 'Wgraj plik mapowania'}
          </button>
          <button type="button" className="btn btn--small" onClick={() => bulkClear('allegro')} disabled={busy === 'bulk-clr'}>Wyczyść Allegro</button>
          <button type="button" className="btn btn--small" onClick={() => bulkClear('baselinker')} disabled={busy === 'bulk-clr'}>Wyczyść Base</button>
        </div>
        {bulkResult && (
          <div className={`result ${bulkResult.errors ? 'result--warn' : 'result--ok'}`}>
            <p style={{ margin: 0 }}>
              Zmapowano — Allegro: <strong>{bulkResult.allegro}</strong>
              {bulkResult.perAccount && Object.keys(bulkResult.perAccount).length > 0 && (
                <> ({Object.entries(bulkResult.perAccount).map(([k, v]) => `${k}: ${v}`).join(', ')})</>
              )}
              , BaseLinker: <strong>{bulkResult.baselinker}</strong>. Wierszy bez numerów: {bulkResult.skipped} (z {bulkResult.rows}).
            </p>
            {bulkResult.errors > 0 && (
              <p style={{ margin: '6px 0 0' }}>
                Błędne wiersze: <strong>{bulkResult.errors}</strong> — pominięte, reszta zapisana.
                {bulkResult.errorsFile && <> Lista z powodami: <code>{bulkResult.errorsFile}</code></>}
              </p>
            )}
          </div>
        )}
      </section>

      {phantoms.length > 0 && (
      <section className="card">
        <h2>Produkty-widma ({phantoms.length})</h2>
        <p className="muted">Mapowanie wskazuje ofertę, ale produktu nie ma w WAPRO — baza produktów które nie istnieją.</p>
        <div className="table-scroll" style={{ maxHeight: 240, overflow: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>SKU</th><th>EAN</th><th>Nazwa</th><th>Allegro</th><th>BaseLinker</th><th></th></tr></thead>
              <tbody>
                {phantoms.map((p) => (
                  <tr key={p.id}>
                    <td>{p.sku}</td><td>{p.ean}</td><td>{p.name}</td>
                    <td>{p.allegroOfferId}</td><td>{p.baselinkerProductId}</td>
                    <td><button type="button" className="btn btn--small" onClick={() => resolvePhantom(p.id)} disabled={busy === 'phantom'}>Ukryj</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
        </div>
      </section>
      )}
    </div>
  )
}
