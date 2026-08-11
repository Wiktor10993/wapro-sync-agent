import { useCallback, useEffect, useState } from 'react'

/**
 * Centrum Dowodzenia „Problemy / Wymaga uwagi" (renderer-local JSX).
 * Bez importów z sync-engine — dostaje `api` (funkcje IPC) z zewnątrz.
 */
export default function ActionCenter({ api }) {
  const [tab, setTab] = useState('unmapped')
  const [unmapped, setUnmapped] = useState([])
  const [errors, setErrors] = useState([])
  const [loading, setLoading] = useState(false)
  const [banner, setBanner] = useState(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [u, e] = await Promise.all([api.listUnmapped(), api.listErrors()])
      setUnmapped(u)
      setErrors(e)
    } catch (err) {
      setBanner({ ok: false, text: err?.message ?? 'Błąd odczytu.' })
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <div className="grid">
      <section className="card card--wide">
        <div className="card__header">
          <h2>Problemy / Wymaga uwagi</h2>
          <button type="button" className="btn btn--tiny" onClick={reload} disabled={loading}>
            {loading ? 'Odświeżam…' : 'Odśwież'}
          </button>
        </div>

        <div className="tabs tabs--sub">
          <button type="button" className={`tabs__item ${tab === 'unmapped' ? 'tabs__item--active' : ''}`} onClick={() => setTab('unmapped')}>
            Niezmapowane produkty {unmapped.length > 0 && <span className="tag tag--warn">{unmapped.length}</span>}
          </button>
          <button type="button" className={`tabs__item ${tab === 'errors' ? 'tabs__item--active' : ''}`} onClick={() => setTab('errors')}>
            Błędy synchronizacji {errors.length > 0 && <span className="tag tag--error">{errors.length}</span>}
          </button>
        </div>

        {banner && <div className={`result ${banner.ok ? 'result--ok' : 'result--warn'}`}>{banner.text}</div>}

        {tab === 'unmapped' ? (
          <UnmappedPanel items={unmapped} api={api} onDone={reload} onNotify={setBanner} />
        ) : (
          <ErrorsPanel items={errors} api={api} onDone={reload} onNotify={setBanner} />
        )}
      </section>
    </div>
  )
}

function UnmappedPanel({ items, api, onDone, onNotify }) {
  if (items.length === 0) return <p className="empty-state">Brak niezmapowanych produktów. 🎉</p>
  return (
    <table className="minitable minitable--full">
      <thead>
        <tr><th>Źródło</th><th>SKU</th><th>EAN</th><th>Nazwa</th><th className="num">Stan</th><th>Powód</th><th>Połącz ręcznie</th></tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <UnmappedRow key={it.id} item={it} api={api} onDone={onDone} onNotify={onNotify} />
        ))}
      </tbody>
    </table>
  )
}

function UnmappedRow({ item, api, onDone, onNotify }) {
  const [channel, setChannel] = useState(item.channel ?? 'baselinker')
  const [offerId, setOfferId] = useState('')
  const [ean, setEan] = useState(item.ean ?? '')
  const [busy, setBusy] = useState(false)

  const link = async () => {
    if (!offerId.trim() && !ean.trim()) {
      onNotify({ ok: false, text: 'Podaj ID oferty albo EAN.' })
      return
    }
    setBusy(true)
    try {
      await api.resolveMapping({ sku: item.sku, channel, offerId: offerId.trim(), ean: ean.trim() || undefined })
      onNotify({ ok: true, text: `Połączono ${item.sku} ↔ ${channel}:${offerId || '(po EAN)'}.` })
      onDone()
    } catch (e) {
      onNotify({ ok: false, text: e?.message ?? 'Nie udało się połączyć.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr>
      <td className="small">{item.source}</td>
      <td><code>{item.sku || '—'}</code></td>
      <td><code>{item.ean || '—'}</code></td>
      <td>{item.name}</td>
      <td className="num">{item.quantity}</td>
      <td className="small">
        {item.reason}
        {(item.candidates || []).length > 0 && (
          <div className="hint">Kandydaci: {item.candidates.map((c) => (
            <button key={c} type="button" className="btn btn--tiny" onClick={() => setOfferId(c)}>{c}</button>
          ))}</div>
        )}
      </td>
      <td>
        <div className="field-row field-row--tight">
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="baselinker">BaseLinker</option>
            <option value="allegro">Allegro</option>
          </select>
          <input value={offerId} onChange={(e) => setOfferId(e.target.value)} placeholder="ID oferty" />
          <input value={ean} onChange={(e) => setEan(e.target.value)} placeholder="EAN (opcjonalnie)" />
        </div>
        <div className="button-row button-row--tight">
          <button type="button" className="btn btn--primary btn--tiny" onClick={link} disabled={busy}>
            {busy ? 'Łączę…' : 'Połącz'}
          </button>
          <button type="button" className="btn btn--tiny" onClick={() => api.ignoreUnmapped(item.id).then(onDone)}>Ignoruj</button>
        </div>
      </td>
    </tr>
  )
}

function ErrorsPanel({ items, api, onDone, onNotify }) {
  const [busyId, setBusyId] = useState(null)
  if (items.length === 0) return <p className="empty-state">Brak błędów synchronizacji. ✅</p>

  const retry = async (id) => {
    setBusyId(id)
    try {
      const r = await api.retryError(id)
      onNotify({ ok: r.ok, text: r.message })
      onDone()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <table className="minitable minitable--full">
      <thead>
        <tr><th>Kanał</th><th>SKU</th><th>Oferta</th><th className="num">Docelowy stan</th><th>Błąd</th><th className="num">Prób</th><th>Akcje</th></tr>
      </thead>
      <tbody>
        {items.map((e) => (
          <tr key={e.id}>
            <td className="small">{e.channel}</td>
            <td><code>{e.sku || '—'}</code></td>
            <td className="small">{e.offerId || '—'}</td>
            <td className="num">{e.targetQuantity}</td>
            <td className="small"><span className="tag tag--error">{e.errorCode}</span> {e.errorMessage}</td>
            <td className="num">{e.attempts}</td>
            <td>
              <div className="button-row button-row--tight">
                <button type="button" className="btn btn--primary btn--tiny" onClick={() => retry(e.id)} disabled={busyId === e.id}>
                  {busyId === e.id ? 'Ponawiam…' : 'Ponów (Retry)'}
                </button>
                <button type="button" className="btn btn--tiny" onClick={() => api.ignoreError(e.id).then(onDone)}>Ignoruj</button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
