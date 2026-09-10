import { useCallback, useState } from 'react'

/** Eksport stanów do CSV (#1): WAPRO / Allegro / BaseLinker + plik połączony. */
export default function EksportTab({ busy, run }) {
  const [src, setSrc] = useState({ wapro: true, allegro: true, baselinker: true })
  const [combined, setCombined] = useState(true)
  const [result, setResult] = useState(null)

  const doExport = useCallback(async () => {
    const picked = await window.agent.pickExportFolder()
    if (!picked.ok || !picked.data) return
    const data = await run(
      'export',
      () => window.agent.exportStocks({ folder: picked.data, sources: src, combined }),
      'Eksport zakończony.'
    )
    if (data) setResult(data)
  }, [run, src, combined])

  return (
    <div className="tab-narzedzia">
      <section className="card">
        <h2>Eksport stanów do CSV</h2>
        <p className="muted">Zrzut aktualnych stanów z wybranych źródeł (Excel, separator „;", UTF-8).</p>
        <div className="field-row">
          <label><input type="checkbox" checked={src.wapro} onChange={(e) => setSrc((s) => ({ ...s, wapro: e.target.checked }))} /> WAPRO</label>
          <label><input type="checkbox" checked={src.allegro} onChange={(e) => setSrc((s) => ({ ...s, allegro: e.target.checked }))} /> Allegro</label>
          <label><input type="checkbox" checked={src.baselinker} onChange={(e) => setSrc((s) => ({ ...s, baselinker: e.target.checked }))} /> BaseLinker</label>
          <label><input type="checkbox" checked={combined} onChange={(e) => setCombined(e.target.checked)} /> Plik połączony (porównanie)</label>
        </div>
        <div className="button-row">
          <button type="button" className="btn btn--primary" onClick={doExport} disabled={busy === 'export'}>
            {busy === 'export' ? <><span className="spinner" /> Eksportuję…</> : 'Wybierz folder i eksportuj'}
          </button>
        </div>
        {result && (
          <ul className="result-list">
            {result.files.map((f) => (
              <li key={f.file}>{f.source}: <strong>{f.count}</strong> poz. — <code>{f.file.split('/').pop()}</code></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
