import { useCallback, useEffect, useState } from 'react'

/**
 * Centrum Dowodzenia „Problemy / Wymaga uwagi" (renderer-local JSX).
 * Trzy podzakładki: niezmapowane produkty, błędy synchronizacji (krytyczne)
 * oraz „0 na stanie (Archiwum)". Bez importów z sync-engine — dostaje `api`.
 */
function Spinner({ lg }) {
  return <span className={`spinner ${lg ? 'spinner--lg' : ''}`} aria-hidden="true" />
}

export default function ActionCenter({ api }) {
  const [tab, setTab] = useState('unmapped')
  const [unmapped, setUnmapped] = useState([])
  const [errors, setErrors] = useState([])
  const [loading, setLoading] = useState(true)
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

  const critical = errors.filter((e) => e.category !== 'archived_zero')
  const archived = errors.filter((e) => e.category === 'archived_zero')

  return (
    <div className="grid">
      <section className="card card--wide">
        <div className="card__header">
          <h2>Problemy / Wymaga uwagi</h2>
          <button type="button" className="btn btn--tiny" onClick={reload} disabled={loading}>
            {loading ? <><Spinner /> Odświeżam…</> : 'Odśwież'}
          </button>
        </div>

        <div className="tabs tabs--sub">
          <SubTab active={tab === 'unmapped'} onClick={() => setTab('unmapped')} label="Niezmapowane produkty" count={unmapped.length} tone="warn" />
          <SubTab active={tab === 'errors'} onClick={() => setTab('errors')} label="Błędy synchronizacji" count={critical.length} tone="error" />
          <SubTab active={tab === 'archived'} onClick={() => setTab('archived')} label="0 na stanie (Archiwum)" count={archived.length} tone="muted" />
        </div>

        {banner && <div className={`result ${banner.ok ? 'result--ok' : 'result--warn'}`}>{banner.text}</div>}

        {loading ? (
          <div className="ac-loading"><Spinner lg /> Wczytuję…</div>
        ) : tab === 'unmapped' ? (
          <UnmappedPanel items={unmapped} api={api} onDone={reload} onNotify={setBanner} />
        ) : tab === 'errors' ? (
          <ErrorsPanel items={critical} api={api} onDone={reload} onNotify={setBanner} />
        ) : (
          <ArchivedPanel items={archived} api={api} onDone={reload} />
        )}
      </section>
    </div>
  )
}

function SubTab({ active, onClick, label, count, tone }) {
  return (
    <button type="button" className={`tabs__item ${active ? 'tabs__item--active' : ''}`} onClick={onClick}>
      {label} {count > 0 && <span className={`tag tag--${tone}`}>{count}</span>}
    </button>
  )
}

/* ============================ Niezmapowane (I) ============================ */

function UnmappedPanel({ items, api, onDone, onNotify }) {
  if (items.length === 0) return <p className="empty-state">Brak niezmapowanych produktów. 🎉</p>
  return (
    <div className="ac-fade-in">
      {items.map((it) => (
        <UnmappedCard key={it.id} item={it} api={api} onDone={onDone} onNotify={onNotify} />
      ))}
    </div>
  )
}

function UnmappedCard({ item, api, onDone, onNotify }) {
  const [channel, setChannel] = useState(item.channel ?? 'baselinker')
  const [offerId, setOfferId] = useState('')
  const [ean, setEan] = useState(item.ean ?? '')
  const [busy, setBusy] = useState(false)

  const channelLabel = channel === 'allegro' ? 'Allegro' : 'BaseLinker'

  const link = async () => {
    if (!offerId.trim() && !ean.trim()) {
      onNotify({ ok: false, text: 'Podaj ID oferty albo EAN.' })
      return
    }
    setBusy(true)
    try {
      await api.resolveMapping({ sku: item.sku, channel, offerId: offerId.trim(), ean: ean.trim() || undefined })
      onNotify({ ok: true, text: `Połączono ${item.sku || item.name} ↔ ${channel}:${offerId || '(po EAN)'}.` })
      onDone()
    } catch (e) {
      onNotify({ ok: false, text: e?.message ?? 'Nie udało się połączyć.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ac-card">
      <div className="ac-card__head">
        <div>
          <div className="ac-card__name">{item.name || '(bez nazwy)'}</div>
          <div className="ac-card__meta">
            <span className="tag tag--muted">{item.source}</span>
            <span>SKU <code>{item.sku || '—'}</code></span>
            <span>EAN <code>{item.ean || '—'}</code></span>
            <span>stan <strong>{item.quantity}</strong></span>
          </div>
        </div>
      </div>

      <div className="ac-card__reason">
        {item.reason}
        {(item.candidates || []).length > 0 && (
          <span className="ac-chips">
            {item.candidates.map((c) => (
              <button key={c} type="button" className="btn btn--tiny" onClick={() => setOfferId(c)} title="Wstaw jako ID oferty">{c}</button>
            ))}
          </span>
        )}
      </div>

      <div className="ac-map">
        <div className="ac-field">
          <label htmlFor={`ch-${item.id}`}>Kanał</label>
          <select id={`ch-${item.id}`} value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="baselinker">BaseLinker</option>
            <option value="allegro">Allegro</option>
          </select>
        </div>
        <div className="ac-field ac-field--grow">
          <label htmlFor={`off-${item.id}`}>Wklej ID oferty z {channelLabel}</label>
          <input id={`off-${item.id}`} value={offerId} onChange={(e) => setOfferId(e.target.value)} placeholder={`np. product_id / offer-id z ${channelLabel}`} autoComplete="off" />
        </div>
        <div className="ac-field">
          <label htmlFor={`ean-${item.id}`}>EAN (opcjonalnie)</label>
          <input id={`ean-${item.id}`} value={ean} onChange={(e) => setEan(e.target.value)} placeholder="kod kreskowy" autoComplete="off" />
        </div>
        <div className="ac-map__actions">
          <button type="button" className="btn btn--primary" onClick={link} disabled={busy}>
            {busy ? <><Spinner /> Łączę…</> : 'Połącz'}
          </button>
          <button type="button" className="btn" onClick={() => api.ignoreUnmapped(item.id).then(onDone)} disabled={busy}>Ignoruj</button>
        </div>
      </div>
    </div>
  )
}

/* ============================ Błędy krytyczne (II) ======================= */

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
    <table className="minitable minitable--full ac-fade-in">
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
                  {busyId === e.id ? <><Spinner /> Ponawiam…</> : 'Ponów (Retry)'}
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

/* ==================== 0 na stanie / Archiwum (III) ======================= */

function ArchivedPanel({ items, api, onDone }) {
  if (items.length === 0) return <p className="empty-state">Brak pozycji w archiwum. 📦</p>
  return (
    <>
      <p className="hint">
        Towary ze stanem <strong>0</strong>, których oferty już nie ma na kanale (zakończone/zarchiwizowane).
        To normalny stan — nie wymaga naprawy. Możesz ukryć wpis z listy.
      </p>
      <table className="minitable minitable--full ac-fade-in">
        <thead>
          <tr><th>Kanał</th><th>SKU</th><th>EAN</th><th>Oferta</th><th>Status</th><th>Akcje</th></tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td className="small">{e.channel}</td>
              <td><code>{e.sku || '—'}</code></td>
              <td><code>{e.ean || '—'}</code></td>
              <td className="small">{e.offerId || '—'}</td>
              <td><span className="tag tag--muted">0 na stanie (Archiwum)</span></td>
              <td>
                <button type="button" className="btn btn--tiny" onClick={() => api.ignoreError(e.id).then(onDone)}>Ukryj</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
