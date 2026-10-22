import { useCallback, useState } from 'react'

/**
 * Raport katalogu (#2 „Bez EAN", #3 „Są w magazynie, brak na Allegro/Base").
 * Filtry = podzakładki: brak na Allegro / brak na Base / bez EAN / martwe.
 */
const VIEWS = [
  { id: 'missingBase', label: 'Brak na BaseLinker', cols: ['sku', 'ean', 'nazwa', 'stan_wapro'] },
  { id: 'noEan', label: 'Bez EAN', cols: ['sku', 'nazwa', 'stan_wapro', 'na_allegro', 'na_base'] },
  { id: 'dead', label: 'Martwe (0, nigdzie)', cols: ['sku', 'ean', 'nazwa', 'stan_wapro'] }
]

export default function RaportTab({ busy, run }) {
  const [report, setReport] = useState(null)
  const [view, setView] = useState('missingBase')

  const generate = useCallback(async () => {
    const data = await run('report', () => window.agent.reportDeadStock(), 'Raport gotowy.')
    if (data) setReport(data)
  }, [run])

  const exportCsv = useCallback(async () => {
    const picked = await window.agent.pickExportFolder()
    if (!picked.ok || !picked.data) return
    await run('report-export', () => window.agent.reportDeadStockExport(picked.data), 'Raport zapisany do CSV.')
  }, [run])

  // Każde konto Allegro osobno — „brak na Allegro" dotyczy konkretnego konta.
  const views = [
    ...(report?.accounts ?? []).map((a) => ({
      id: `missingAllegro:${a.id}`,
      label: `Brak na Allegro — ${a.label}`,
      cols: ['sku', 'ean', 'nazwa', 'stan_wapro', 'inne_konta'],
      rows: report.missingAllegroByAccount?.[a.id] ?? []
    })),
    ...VIEWS.map((v) => ({ ...v, rows: report?.[v.id] ?? [] }))
  ]
  const current = views.find((v) => v.id === view) ?? views[0]
  const rows = current?.rows ?? []
  const otherAccounts = (r) =>
    (report?.accounts ?? [])
      .filter((a) => r.allegro?.[a.id] && current?.id !== `missingAllegro:${a.id}`)
      .map((a) => `${a.label}: ${r.allegro[a.id]}`)
      .join(', ') || '—'

  const cell = (r, col) => {
    switch (col) {
      case 'sku': return r.sku
      case 'ean': return r.ean
      case 'nazwa': return r.name
      case 'stan_wapro': return r.waproQty
      case 'na_allegro': return r.onAllegro ? 'TAK' : '—'
      case 'inne_konta': return otherAccounts(r)
      case 'na_base': return r.onBase ? 'TAK' : '—'
      default: return ''
    }
  }

  return (
    <div className="tab-narzedzia">
      <section className="card">
        <h2>Raport katalogu</h2>
        <p className="muted">
          Porównanie WAPRO (źródło prawdy) z każdym kontem Allegro osobno i z BaseLinkerem. „Brak na…" = towar jest
          w WAPRO (&gt;0), ale nie ma go na danym koncie/kanale (utrata sprzedaży). „Bez EAN" = produkty bez kodu (barki po starym Allegro).
        </p>
        <div className="button-row">
          <button type="button" className="btn btn--primary" onClick={generate} disabled={busy === 'report'}>
            {busy === 'report' ? <><span className="spinner" /> Analizuję…</> : 'Generuj raport'}
          </button>
          <button type="button" className="btn" onClick={exportCsv} disabled={busy === 'report-export' || !report}>Eksportuj wszystko do CSV</button>
        </div>

        {report && (
          <>
            <div className="tabs tabs--sub" style={{ marginTop: 14 }}>
              {views.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`tabs__item ${view === v.id ? 'tabs__item--active' : ''}`}
                  onClick={() => setView(v.id)}
                >
                  {v.label} ({v.rows.length})
                </button>
              ))}
            </div>

            <div className="table-scroll" style={{ maxHeight: 340, overflow: 'auto', marginTop: 8 }}>
              <table className="data-table">
                <thead>
                  <tr>{current.cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.slice(0, 500).map((r, i) => (
                    <tr key={i}>{current.cols.map((c) => <td key={c}>{cell(r, c)}</td>)}</tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={current.cols.length} className="muted">Brak pozycji w tej kategorii — świetnie.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {rows.length > 500 && <p className="muted">Pokazano pierwsze 500 z {rows.length} — pełna lista w eksporcie CSV.</p>}
            <p className="muted" style={{ marginTop: 8 }}>
              Źródła: {report.counts.wapro} poz. WAPRO · {report.counts.allegro} ofert Allegro · {report.counts.base} prod. BaseLinker
            </p>
          </>
        )}
      </section>
    </div>
  )
}
