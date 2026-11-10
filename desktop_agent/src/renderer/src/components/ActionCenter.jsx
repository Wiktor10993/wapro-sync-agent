import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Centrum Dowodzenia „Problemy / Wymaga uwagi" (renderer-local JSX).
 * Trzy podzakładki: niezmapowane produkty, błędy synchronizacji (krytyczne)
 * oraz „0 na stanie (Archiwum)". Bez importów z sync-engine — dostaje `api`.
 *
 * v6.8: akcje (Ignoruj/Połącz/Ukryj) usuwają wpis lokalnie zamiast przeładowywać
 * całą listę, a listy są stronicowane — przy tysiącach pozycji każde kliknięcie
 * wczytywało i rysowało wszystko od nowa, co zawieszało okno.
 */

/** Ile kart/wierszy rysujemy naraz (reszta po „Pokaż kolejne"). */
const PAGE = 50

/** Progi filtra „Stan WAPRO" (0 = wszystkie). */
const MIN_QTY_OPTIONS = [0, 1, 2, 3, 5, 10, 20]
const MIN_QTY_KEY = 'ac.unmapped.minQty'

/** Filtr „Pokaż": wszystko / towary ze skanu WAPRO / sprzedaże z zamówień. */
const KIND_OPTIONS = [
  { value: 'all', label: 'wszystko' },
  { value: 'wapro', label: 'towary z WAPRO' },
  { value: 'sales', label: 'sprzedaże z zamówień' }
]
const KIND_KEY = 'ac.unmapped.kind'

function readStored(key, allowed, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const v = typeof fallback === 'number' ? Number(raw) : raw
    return allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* brak localStorage — filtr działa do zamknięcia okna */
  }
}

/**
 * Pozycja ze skanu WAPRO ma w `quantity` stan magazynowy. Pozycja ze sprzedaży
 * (`oferta:X`, source = kanał) ma tam liczbę SPRZEDANYCH sztuk — towaru nie ma
 * w WAPRO (brak indeksu), więc nie ma też stanu WAPRO.
 */
export function isSaleItem(item) {
  return item.source !== 'wapro'
}

/**
 * Łączny filtr listy „Niezmapowane produkty".
 * - `kind`: 'all' | 'wapro' | 'sales';
 * - `minQty` > 0: tylko towary z WAPRO o stanie ≥ minQty. Sprzedaże nie mają stanu
 *   WAPRO, więc przy ustawionym progu znikają (chyba że wybrano „sprzedaże" —
 *   wtedy próg nie ma zastosowania).
 */
export function passesUnmappedFilter(item, { kind = 'all', minQty = 0 } = {}) {
  const sale = isSaleItem(item)
  if (kind === 'wapro' && sale) return false
  if (kind === 'sales') return sale
  if (minQty > 0) return !sale && Number(item.quantity ?? 0) >= minQty
  return true
}

function Spinner({ lg }) {
  return <span className={`spinner ${lg ? 'spinner--lg' : ''}`} aria-hidden="true" />
}

export default function ActionCenter({ api }) {
  const [tab, setTab] = useState('unmapped')
  const [unmapped, setUnmapped] = useState([])
  const [errors, setErrors] = useState([])
  const [loading, setLoading] = useState(true)
  const [banner, setBanner] = useState(null)

  // `soft` — odświeżenie bez zasłaniania listy spinnerem (np. po Retry).
  const reload = useCallback(async ({ soft = false } = {}) => {
    if (!soft) setLoading(true)
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

  const critical = useMemo(() => errors.filter((e) => e.category !== 'archived_zero'), [errors])
  const archived = useMemo(() => errors.filter((e) => e.category === 'archived_zero'), [errors])

  // Natychmiastowe usunięcie z widoku — bez ponownego czytania całej kolejki.
  const dropUnmapped = useCallback((ids) => {
    const set = new Set(ids)
    setUnmapped((list) => list.filter((it) => !set.has(it.id)))
  }, [])
  const dropErrors = useCallback((ids) => {
    const set = new Set(ids)
    setErrors((list) => list.filter((it) => !set.has(it.id)))
  }, [])

  return (
    <div className="grid">
      <section className="card card--wide">
        <div className="card__header">
          <h2>Problemy / Wymaga uwagi</h2>
          <button type="button" className="btn btn--tiny" onClick={() => reload()} disabled={loading}>
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
          <UnmappedPanel items={unmapped} api={api} onRemoved={dropUnmapped} onNotify={setBanner} />
        ) : tab === 'errors' ? (
          <ErrorsPanel items={critical} api={api} onDone={() => reload({ soft: true })} onRemoved={dropErrors} onNotify={setBanner} />
        ) : (
          <ArchivedPanel items={archived} api={api} onRemoved={dropErrors} onNotify={setBanner} />
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

function useSearch(items) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => `${it.sku ?? ''} ${it.ean ?? ''} ${it.name ?? ''} ${it.offerId ?? ''}`.toLowerCase().includes(q))
  }, [items, query])
  return { query, setQuery, filtered }
}

function ShowMore({ shown, total, onMore }) {
  if (shown >= total) return null
  return (
    <div className="button-row">
      <button type="button" className="btn" onClick={onMore}>Pokaż kolejne {Math.min(PAGE, total - shown)} (z {total - shown})</button>
    </div>
  )
}

function UnmappedPanel({ items, api, onRemoved, onNotify }) {
  const [minQty, setMinQtyState] = useState(() => readStored(MIN_QTY_KEY, MIN_QTY_OPTIONS, 0))
  const [kind, setKindState] = useState(() => readStored(KIND_KEY, KIND_OPTIONS.map((o) => o.value), 'all'))
  const counts = useMemo(() => {
    let sales = 0
    for (const it of items) if (isSaleItem(it)) sales++
    return { all: items.length, sales, wapro: items.length - sales }
  }, [items])
  const shownByFilter = useMemo(() => items.filter((it) => passesUnmappedFilter(it, { kind, minQty })), [items, kind, minQty])
  const hiddenCount = items.length - shownByFilter.length
  const { query, setQuery, filtered } = useSearch(shownByFilter)
  const [limit, setLimit] = useState(PAGE)
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState(false)

  const resetView = () => {
    setLimit(PAGE)
    // Zaznaczenie ukrytych pozycji nie może zostać „w tle" (masowe Ignoruj).
    setSelected(new Set())
  }
  const setMinQty = (v) => {
    setMinQtyState(v)
    writeStored(MIN_QTY_KEY, v)
    resetView()
  }
  const setKind = (v) => {
    setKindState(v)
    writeStored(KIND_KEY, v)
    resetView()
  }
  const qtyFilterOff = kind === 'sales'

  if (items.length === 0) return <p className="empty-state">Brak niezmapowanych produktów. 🎉</p>

  const visible = filtered.slice(0, limit)
  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const ignore = async (ids) => {
    if (ids.length === 0) return
    setBusy(true)
    try {
      await api.ignoreUnmapped(ids)
      onRemoved(ids)
      setSelected((s) => {
        const n = new Set(s)
        for (const id of ids) n.delete(id)
        return n
      })
      onNotify({ ok: true, text: `Zignorowano ${ids.length} poz. — dopisane do zakładki „Ignorowane", nie wrócą przy kolejnym skanie.` })
    } catch (e) {
      onNotify({ ok: false, text: e?.message ?? 'Nie udało się zignorować.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ac-fade-in">
      <div className="field-row field-row--tight ac-toolbar">
        <input value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE) }} placeholder="Szukaj: SKU, EAN, nazwa…" />
        <label className="ac-qty-filter">
          Pokaż
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Rodzaj pozycji">
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label} ({counts[o.value]})</option>
            ))}
          </select>
        </label>
        <label className="ac-qty-filter" title={qtyFilterOff ? 'Sprzedaże z zamówień nie mają indeksu WAPRO, więc nie mają stanu WAPRO.' : undefined}>
          Stan WAPRO
          <select value={qtyFilterOff ? 0 : minQty} disabled={qtyFilterOff} onChange={(e) => setMinQty(Number(e.target.value))} aria-label="Minimalny stan WAPRO">
            {MIN_QTY_OPTIONS.map((v) => (
              <option key={v} value={v}>{v === 0 ? 'wszystkie' : `≥ ${v}`}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn--tiny" onClick={() => setSelected(new Set(filtered.map((it) => it.id)))} disabled={busy}>
          Zaznacz wszystkie ({filtered.length})
        </button>
        <button type="button" className="btn btn--tiny" onClick={() => setSelected(new Set())} disabled={selected.size === 0 || busy}>Odznacz</button>
        <button type="button" className="btn btn--primary" onClick={() => ignore([...selected])} disabled={selected.size === 0 || busy}>
          {busy ? <><Spinner /> Ignoruję…</> : `Ignoruj zaznaczone (${selected.size})`}
        </button>
      </div>
      {hiddenCount > 0 && (
        <p className="hint">
          Ukryto {hiddenCount} poz. przez filtry
          {!qtyFilterOff && minQty > 0 && kind === 'all' && counts.sales > 0
            ? ` (w tym ${counts.sales} sprzedaży z zamówień — nie mają indeksu WAPRO, więc nie mają stanu WAPRO; zobaczysz je w „Pokaż: sprzedaże z zamówień")`
            : ''}
          .
        </p>
      )}
      {kind !== 'wapro' && counts.sales > 0 && (
        <p className="hint">
          „Sprzedaże z zamówień" (SKU <code>oferta:…</code>) to oferty Allegro bez sygnatury i bez mapowania — program nie wie, z którego towaru
          WAPRO zdjąć sprzedane sztuki. Wpisz indeks WAPRO i kliknij „Połącz" albo „Ignoruj", jeśli oferta nie dotyczy WAPRO.
        </p>
      )}
      {filtered.length === 0 && <p className="empty-state">Brak pozycji dla wybranego filtra.</p>}
      {visible.map((it) => (
        <UnmappedCard
          key={it.id}
          item={it}
          api={api}
          checked={selected.has(it.id)}
          onToggle={() => toggle(it.id)}
          onIgnore={() => ignore([it.id])}
          onLinked={() => onRemoved([it.id])}
          onNotify={onNotify}
        />
      ))}
      <ShowMore shown={visible.length} total={filtered.length} onMore={() => setLimit((l) => l + PAGE)} />
    </div>
  )
}

function UnmappedCard({ item, api, checked, onToggle, onIgnore, onLinked, onNotify }) {
  const [channel, setChannel] = useState(item.channel ?? 'baselinker')
  const [offerId, setOfferId] = useState('')
  const [ean, setEan] = useState(item.ean ?? '')
  const [busy, setBusy] = useState(false)
  const [waproSku, setWaproSku] = useState('')

  const channelLabel = channel === 'allegro' ? 'Allegro' : 'BaseLinker'
  // Sprzedaż nieznanej oferty Allegro: oferta jest znana, brakuje INDEKSU WAPRO.
  const saleOfferId = (/^oferta:(.+)$/.exec(String(item.sku ?? '')) || [])[1]
  const isSaleOffer = Boolean(saleOfferId && saleOfferId !== '?')

  const linkSale = async () => {
    if (!waproSku.trim()) {
      onNotify({ ok: false, text: 'Podaj indeks (symbol) towaru z WAPRO.' })
      return
    }
    setBusy(true)
    try {
      await api.resolveMapping({ sku: item.sku, channel: 'allegro', offerId: saleOfferId, waproSku: waproSku.trim() })
      onNotify({ ok: true, text: `Połączono ofertę Allegro ${saleOfferId} → indeks WAPRO ${waproSku.trim()}.` })
      onLinked()
    } catch (e) {
      onNotify({ ok: false, text: e?.message ?? 'Nie udało się połączyć.' })
    } finally {
      setBusy(false)
    }
  }

  const link = async () => {
    if (!offerId.trim() && !ean.trim()) {
      onNotify({ ok: false, text: 'Podaj ID oferty albo EAN.' })
      return
    }
    setBusy(true)
    try {
      await api.resolveMapping({ sku: item.sku, channel, offerId: offerId.trim(), ean: ean.trim() || undefined })
      onNotify({ ok: true, text: `Połączono ${item.sku || item.name} ↔ ${channel}:${offerId || '(po EAN)'}.` })
      onLinked()
    } catch (e) {
      onNotify({ ok: false, text: e?.message ?? 'Nie udało się połączyć.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ac-card">
      <div className="ac-card__head">
        <input type="checkbox" className="ac-card__check" checked={checked} onChange={onToggle} aria-label={`Zaznacz ${item.sku || item.name}`} />
        <div>
          <div className="ac-card__name">{item.name || '(bez nazwy)'}</div>
          <div className="ac-card__meta">
            <span className="tag tag--muted">{item.source}</span>
            <span>SKU <code>{item.sku || '—'}</code></span>
            <span>EAN <code>{item.ean || '—'}</code></span>
            {isSaleItem(item)
              ? <span>sprzedano <strong>{item.quantity}</strong> szt.</span>
              : <span>stan WAPRO <strong>{item.quantity}</strong></span>}
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

      {isSaleOffer ? (
      <div className="ac-map">
        <div className="ac-field ac-field--grow">
          <label htmlFor={`wsku-${item.id}`}>Indeks WAPRO dla oferty Allegro {saleOfferId}</label>
          <input id={`wsku-${item.id}`} value={waproSku} onChange={(e) => setWaproSku(e.target.value)} placeholder="symbol / indeks towaru z WAPRO" autoComplete="off" />
        </div>
        <div className="ac-map__actions">
          <button type="button" className="btn btn--primary" onClick={linkSale} disabled={busy}>
            {busy ? <><Spinner /> Łączę…</> : 'Połącz'}
          </button>
          <button type="button" className="btn" onClick={onIgnore} disabled={busy}>Ignoruj</button>
        </div>
      </div>
      ) : (
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
          <button type="button" className="btn" onClick={onIgnore} disabled={busy}>Ignoruj</button>
        </div>
      </div>
      )}
    </div>
  )
}

/* ============================ Błędy krytyczne (II) ======================= */

/** Ukrycie/zignorowanie wpisu błędu — od razu znika z widoku. */
async function hideError(api, id, onRemoved, onNotify) {
  try {
    await api.ignoreError(id)
    onRemoved([id])
  } catch (e) {
    onNotify?.({ ok: false, text: e?.message ?? 'Nie udało się ukryć wpisu.' })
  }
}

function ErrorsPanel({ items, api, onDone, onRemoved, onNotify }) {
  const [busyId, setBusyId] = useState(null)
  const { query, setQuery, filtered } = useSearch(items)
  const [limit, setLimit] = useState(PAGE)
  if (items.length === 0) return <p className="empty-state">Brak błędów synchronizacji. ✅</p>
  const visible = filtered.slice(0, limit)

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
    <>
    <div className="field-row field-row--tight">
      <input value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE) }} placeholder="Szukaj: SKU, EAN, oferta…" />
    </div>
    <table className="minitable minitable--full ac-fade-in">
      <thead>
        <tr><th>Kanał</th><th>SKU</th><th>Oferta</th><th className="num">Docelowy stan</th><th>Błąd</th><th className="num">Prób</th><th>Akcje</th></tr>
      </thead>
      <tbody>
        {visible.map((e) => (
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
                <button type="button" className="btn btn--tiny" onClick={() => hideError(api, e.id, onRemoved, onNotify)}>Ignoruj</button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    <ShowMore shown={visible.length} total={filtered.length} onMore={() => setLimit((l) => l + PAGE)} />
    </>
  )
}

/* ==================== 0 na stanie / Archiwum (III) ======================= */

function ArchivedPanel({ items, api, onRemoved, onNotify }) {
  const [limit, setLimit] = useState(PAGE)
  if (items.length === 0) return <p className="empty-state">Brak pozycji w archiwum. 📦</p>
  const visible = items.slice(0, limit)
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
          {visible.map((e) => (
            <tr key={e.id}>
              <td className="small">{e.channel}</td>
              <td><code>{e.sku || '—'}</code></td>
              <td><code>{e.ean || '—'}</code></td>
              <td className="small">{e.offerId || '—'}</td>
              <td><span className="tag tag--muted">0 na stanie (Archiwum)</span></td>
              <td>
                <button type="button" className="btn btn--tiny" onClick={() => hideError(api, e.id, onRemoved, onNotify)}>Ukryj</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ShowMore shown={visible.length} total={items.length} onMore={() => setLimit((l) => l + PAGE)} />
    </>
  )
}
