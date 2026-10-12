import { useCallback, useEffect, useState } from 'react'

/**
 * Mapowanie produktów po CSV (#4: wybór kanału Allegro / BaseLinker / oba).
 * Wzorzec z WAPRO → operator uzupełnia ID ofert → import. WAPRO nadrzędny;
 * wiersze bez odpowiednika → produkty-widma (magazyn pośredni).
 */
export default function MapowanieTab({ busy, run }) {
  const [channels, setChannels] = useState({ allegro: true, baselinker: true })
  const [importResult, setImportResult] = useState(null)
  const [phantoms, setPhantoms] = useState([])

  const loadPhantoms = useCallback(async () => {
    const r = await window.agent.mappingListPhantom()
    if (r.ok) setPhantoms(r.data || [])
  }, [])

  useEffect(() => { loadPhantoms() }, [loadPhantoms])

  const noChannel = !channels.allegro && !channels.baselinker

  const doTemplate = useCallback(async () => {
    const picked = await window.agent.pickExportFolder()
    if (!picked.ok || !picked.data) return
    await run('template', () => window.agent.mappingTemplate(picked.data), 'Wzorzec CSV zapisany.')
  }, [run])

  const doImport = useCallback(async () => {
    const picked = await window.agent.pickCsvFile()
    if (!picked.ok || !picked.data) return
    const data = await run('import', () => window.agent.mappingImport(picked.data, channels), 'Mapowanie wczytane.')
    if (data) { setImportResult(data); loadPhantoms() }
  }, [run, channels, loadPhantoms])

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
    await run('bulk-tpl', () => window.agent.mappingBulkTemplate(picked.data), 'Wzorzec zapisany.')
  }, [run])

  const bulkImport = useCallback(async () => {
    const picked = await window.agent.pickCsvFile()
    if (!picked.ok || !picked.data) return
    const d = await run('bulk-imp', () => window.agent.mappingBulkImport(picked.data), 'Masowe mapowanie wczytane.')
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
      {/* ---- Masowe mapowanie (nadrzędne wobec auto-dopasowania) ---- */}
      <section className="card">
        <h2>Masowe mapowanie (CSV) — wpływa na wysyłkę stanów</h2>
        <p className="muted">
          Wgraj JEDEN plik CSV: klucz produktu (<code>indeks</code> lub <code>ean</code>) + <code>allegro_nr_aukcji</code> i/lub <code>baselinker_product_id</code>.
          Te mapowania są <strong>nadrzędne</strong> wobec auto-dopasowania — produkt trafi dokładnie na wskazaną ofertę.
          Przy wielu kontach Allegro numer aukcji sam wskazuje właściwe konto.
        </p>
        <p className="result-summary">
          Zapisane mapowania — Allegro: <strong>{bulkCounts.allegro}</strong>, BaseLinker: <strong>{bulkCounts.baselinker}</strong>
        </p>
        <div className="button-row">
          <button type="button" className="btn" onClick={bulkTemplate} disabled={busy === 'bulk-tpl'}>Pobierz wzorzec</button>
          <button type="button" className="btn btn--primary" onClick={bulkImport} disabled={busy === 'bulk-imp'}>
            {busy === 'bulk-imp' ? <><span className="spinner" /> Wczytuję…</> : 'Wgraj plik CSV'}
          </button>
          <button type="button" className="btn btn--small" onClick={() => bulkClear('allegro')} disabled={busy === 'bulk-clr'}>Wyczyść Allegro</button>
          <button type="button" className="btn btn--small" onClick={() => bulkClear('baselinker')} disabled={busy === 'bulk-clr'}>Wyczyść Base</button>
        </div>
        {bulkResult && (
          <p className="result-summary">
            Wczytano — Allegro: <strong>{bulkResult.allegro}</strong>, BaseLinker: <strong>{bulkResult.baselinker}</strong>,
            pominięto {bulkResult.skipped} (z {bulkResult.rows} wierszy).
          </p>
        )}
      </section>

      <section className="card">
        <h2>Mapowanie produktów po CSV</h2>
        <p className="muted">
          Pobierz wzorzec (stan WAPRO), uzupełnij <code>allegro_offer_id</code> i/lub <code>baselinker_product_id</code>, wgraj z powrotem.
          WAPRO jest magazynem nadrzędnym; wiersze bez odpowiednika trafią do „produktów-widm".
        </p>

        <div className="field-row" style={{ marginBottom: 8 }}>
          <strong style={{ marginRight: 8 }}>Mapuję kanał:</strong>
          <label><input type="checkbox" checked={channels.allegro} onChange={(e) => setChannels((c) => ({ ...c, allegro: e.target.checked }))} /> Allegro</label>
          <label><input type="checkbox" checked={channels.baselinker} onChange={(e) => setChannels((c) => ({ ...c, baselinker: e.target.checked }))} /> BaseLinker</label>
        </div>
        {noChannel && <p className="muted" style={{ color: '#c0392b' }}>Zaznacz przynajmniej jeden kanał.</p>}

        <div className="button-row">
          <button type="button" className="btn" onClick={doTemplate} disabled={busy === 'template'}>Pobierz wzorzec CSV</button>
          <button type="button" className="btn btn--primary" onClick={doImport} disabled={busy === 'import' || noChannel}>
            {busy === 'import' ? <><span className="spinner" /> Wczytuję…</> : 'Wgraj mapowanie z CSV'}
          </button>
        </div>
        {importResult && (
          <p className="result-summary">
            Zmapowano — Allegro: <strong>{importResult.mappedAllegro}</strong>, BaseLinker: <strong>{importResult.mappedBaselinker}</strong>,
            widma: <strong>{importResult.phantom}</strong>, pominięte: {importResult.skipped} (z {importResult.rows} wierszy).
          </p>
        )}

        <h3 style={{ marginTop: 16 }}>Produkty-widma ({phantoms.length})</h3>
        <p className="muted">Mapowanie wskazuje ofertę, ale produktu nie ma w WAPRO — baza produktów które nie istnieją.</p>
        {phantoms.length === 0 ? (
          <p className="muted">Brak — wszystkie zmapowane wiersze mają odpowiednik w WAPRO.</p>
        ) : (
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
        )}
      </section>
    </div>
  )
}
