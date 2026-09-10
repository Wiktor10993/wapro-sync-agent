import { useCallback, useEffect, useState } from 'react'

/**
 * Analityka (v6): Ostatnio wyłączone / Kończy się / Trendujące / Starczy na X dni.
 * Dane z silnika historii sprzedaży (spadki stanu WAPRO + zamówienia kanałów).
 */
const VIEWS = [
  { id: 'recent', label: 'Ostatnio wyłączone' },
  { id: 'ending', label: 'Kończy się' },
  { id: 'trending', label: 'Trendujące' },
  { id: 'forecast', label: 'Starczy na (dni)' }
]

export default function AnalitykaTab({ busy, run }) {
  const [view, setView] = useState('recent')
  const [threshold, setThreshold] = useState(5)
  const [maxDays, setMaxDays] = useState('')
  const [data, setData] = useState(null)
  const [recent, setRecent] = useState([])

  const loadRecent = useCallback(async () => {
    const r = await window.agent.analyticsRecentEnded()
    if (r.ok) setRecent(r.data || [])
  }, [])

  useEffect(() => { loadRecent() }, [loadRecent])

  const analyze = useCallback(async () => {
    const d = await run('analyze', () => window.agent.analyticsCompute({ lowStockThreshold: Number(threshold) || 5 }), 'Analiza gotowa.')
    if (d) setData(d)
  }, [run, threshold])

  const ingest = useCallback(async () => {
    await run('ingest', () => window.agent.analyticsIngest(60), 'Zaktualizowano dane sprzedaży z zamówień.')
    analyze()
  }, [run, analyze])

  const forecastRows = (data?.forecast || []).filter((r) => (maxDays === '' ? true : r.daysLeft <= Number(maxDays)))

  return (
    <div className="tab-narzedzia">
      <section className="card">
        <h2>Analityka sprzedaży</h2>
        <p className="muted">
          Prędkość, trend i prognoza zapasu na bazie historii. Źródło uzupełnij zamówieniami z kanałów,
          a z czasem agent sam buduje historię ze spadków stanu WAPRO.
        </p>
        <div className="button-row">
          <button type="button" className="btn btn--primary" onClick={analyze} disabled={busy === 'analyze'}>
            {busy === 'analyze' ? <><span className="spinner" /> Analizuję…</> : 'Analizuj'}
          </button>
          <button type="button" className="btn" onClick={ingest} disabled={busy === 'ingest'}>
            {busy === 'ingest' ? <><span className="spinner" /> Pobieram…</> : 'Zaktualizuj dane sprzedaży (zamówienia)'}
          </button>
        </div>
        {data && (
          <p className="muted" style={{ marginTop: 8 }}>
            Źródło prędkości: <strong>{data.meta.source}</strong> · okno {data.meta.windowDays} dni · pokrycie snapshotów: {data.meta.coverageDays} dni · {data.meta.wapro} poz. WAPRO
          </p>
        )}

        <div className="tabs tabs--sub" style={{ marginTop: 12 }}>
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className={`tabs__item ${view === v.id ? 'tabs__item--active' : ''}`} onClick={() => setView(v.id)}>
              {v.label}
              {v.id === 'recent' && ` (${recent.length})`}
              {data && v.id === 'ending' && ` (${data.ending.length})`}
              {data && v.id === 'trending' && ` (${data.trending.length})`}
              {data && v.id === 'forecast' && ` (${data.forecast.length})`}
            </button>
          ))}
        </div>

        {/* Ostatnio wyłączone */}
        {view === 'recent' && (
          <div className="table-scroll" style={{ maxHeight: 360, overflow: 'auto', marginTop: 8 }}>
            <table className="data-table">
              <thead><tr><th>Kanał</th><th>Oferta</th><th>SKU</th><th>EAN</th><th>Wyłączono</th></tr></thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={`${r.channel}:${r.offerId}`}>
                    <td>{r.channel}</td><td>{r.offerId}</td><td>{r.sku}</td><td>{r.ean}</td>
                    <td>{String(r.endedAt).replace('T', ' ').slice(0, 16)}</td>
                  </tr>
                ))}
                {recent.length === 0 && <tr><td colSpan={5} className="muted">Brak — nic nie zeszło ostatnio do zera.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {/* Kończy się */}
        {view === 'ending' && (
          <>
            <div className="field-row" style={{ marginTop: 10 }}>
              <label>Próg „mniej niż": <input type="number" min="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} style={{ width: 70 }} /></label>
              <button type="button" className="btn btn--small" onClick={analyze} disabled={busy === 'analyze'}>Przelicz</button>
            </div>
            <AnalyticsTable rows={data?.ending} cols={['sku', 'ean', 'nazwa', 'stan', 'szt./dzień', 'starczy (dni)']} pick={(r) => [r.sku, r.ean, r.name, r.qty, r.daily, r.daysLeft ?? '—']} empty="Najpierw kliknij Analizuj." />
          </>
        )}

        {/* Trendujące */}
        {view === 'trending' && (
          <AnalyticsTable rows={data?.trending} cols={['sku', 'nazwa', 'stan', 'ost. 7 dni/d', 'poprz. 7 dni/d', 'trend ×']} pick={(r) => [r.sku, r.name, r.qty, r.v7, r.vPrev, r.trend]} empty="Najpierw kliknij Analizuj." />
        )}

        {/* Starczy na X dni */}
        {view === 'forecast' && (
          <>
            <div className="field-row" style={{ marginTop: 10 }}>
              <label>Pokaż tylko starczy poniżej: <input type="number" min="1" placeholder="dni" value={maxDays} onChange={(e) => setMaxDays(e.target.value)} style={{ width: 80 }} /> dni</label>
            </div>
            <AnalyticsTable rows={forecastRows} cols={['sku', 'nazwa', 'stan', 'szt./dzień', 'starczy (dni)']} pick={(r) => [r.sku, r.name, r.qty, r.daily, r.daysLeft]} empty="Najpierw kliknij Analizuj." />
          </>
        )}
      </section>
    </div>
  )
}

function AnalyticsTable({ rows, cols, pick, empty }) {
  return (
    <div className="table-scroll" style={{ maxHeight: 360, overflow: 'auto', marginTop: 8 }}>
      <table className="data-table">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {(rows || []).slice(0, 500).map((r, i) => (
            <tr key={i}>{pick(r).map((v, k) => <td key={k}>{v}</td>)}</tr>
          ))}
          {(!rows || rows.length === 0) && <tr><td colSpan={cols.length} className="muted">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
