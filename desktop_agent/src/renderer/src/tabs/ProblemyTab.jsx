import { useMemo, useState } from 'react'
import ActionCenter from '../components/ActionCenter.jsx'

/**
 * Zakładka „Problemy / Wymaga uwagi" — opakowuje ActionCenter (podpięcie IPC,
 * rozpakowanie {ok,data}) i dokłada pasek symulacji do testów na żywo:
 * „Skanuj WAPRO" (scenariusz C) oraz symulacja sprzedaży z kanału (A/B).
 */
export default function ProblemyTab() {
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0) // wymusza remount ActionCenter po akcji

  // API stabilne (useMemo []), żeby useEffect w ActionCenter nie zapętlał się.
  const api = useMemo(() => {
    const unwrap = async (p) => {
      const r = await p
      if (!r.ok) throw new Error(r.error)
      return r.data
    }
    return {
      listUnmapped: () => unwrap(window.agent.acListUnmapped()),
      listErrors: () => unwrap(window.agent.acListErrors()),
      resolveMapping: (input) => unwrap(window.agent.acResolveMapping(input)),
      ignoreUnmapped: (id) => unwrap(window.agent.acIgnoreUnmapped(id)),
      retryError: (id) => unwrap(window.agent.acRetryError(id)),
      ignoreError: (id) => unwrap(window.agent.acIgnoreError(id))
    }
  }, [])

  const [sim, setSim] = useState({ channel: 'baselinker', sku: '', newQuantity: '' })

  const scan = async () => {
    setBusy(true)
    setMsg(null)
    const r = await window.agent.acScan()
    setBusy(false)
    setMsg(r.ok ? { ok: true, text: `Skan WAPRO: sprawdzono ${r.data.checked}, zmiany ${r.data.changed}, nowe ${r.data.newProducts}.` } : { ok: false, text: r.error })
    setNonce((n) => n + 1)
  }

  const simulateSale = async () => {
    if (!sim.sku.trim()) {
      setMsg({ ok: false, text: 'Podaj SKU produktu do symulacji.' })
      return
    }
    setBusy(true)
    setMsg(null)
    const event = { sku: sim.sku.trim(), newQuantity: Number(sim.newQuantity) || 0 }
    const r = await window.agent.acSimulateSale(sim.channel, event)
    setBusy(false)
    setMsg(r.ok ? { ok: true, text: `Symulacja sprzedaży na ${sim.channel}: ${sim.sku} → ${event.newQuantity}.` } : { ok: false, text: r.error })
    setNonce((n) => n + 1)
  }

  return (
    <div className="grid">
      <section className="card card--wide">
        <h2>Symulacja / sterowanie (test)</h2>
        <p className="hint">
          Do testu na żywo: najpierw „Skanuj WAPRO" (ładuje bufor i wysyła delty),
          potem zasymuluj sprzedaż z kanału, żeby zobaczyć scenariusze A/B i loop guard.
        </p>
        <div className="button-row">
          <button type="button" className="btn btn--primary" onClick={scan} disabled={busy}>
            {busy ? <><span className="spinner" aria-hidden="true" /> Skanuję WAPRO…</> : 'Skanuj WAPRO (scenariusz C)'}
          </button>
        </div>
        <div className="field-row field-row--tight" style={{ marginTop: 10 }}>
          <select value={sim.channel} onChange={(e) => setSim((s) => ({ ...s, channel: e.target.value }))}>
            <option value="baselinker">BaseLinker (scenariusz A)</option>
            <option value="allegro">Allegro (scenariusz B)</option>
          </select>
          <input value={sim.sku} onChange={(e) => setSim((s) => ({ ...s, sku: e.target.value }))} placeholder="SKU (np. KP-TRU-16)" />
          <input value={sim.newQuantity} onChange={(e) => setSim((s) => ({ ...s, newQuantity: e.target.value }))} placeholder="nowy stan" inputMode="numeric" />
          <button type="button" className="btn" onClick={simulateSale} disabled={busy}>Symuluj sprzedaż</button>
        </div>
        {msg && <div className={`result ${msg.ok ? 'result--ok' : 'result--warn'}`}>{msg.text}</div>}
      </section>

      <ActionCenter key={nonce} api={api} />
    </div>
  )
}
