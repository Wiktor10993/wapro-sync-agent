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

  return (
    <div className="tab-narzedzia">
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
