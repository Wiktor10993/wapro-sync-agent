import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Zakładka „Ignorowane" (v6.8): towary WAPRO, które synchronizacja ma pomijać.
 * Zaznaczone pozycje nie są dopasowywane ani wysyłane (BaseLinker, każde konto
 * Allegro) i nie trafiają do „Problemy". Usunięcie z listy = powrót do
 * synchronizacji w następnym cyklu.
 *
 * Długie listy renderujemy stronami — tysiące wierszy naraz blokowały okno.
 */

const PAGE = 100

const CHANNEL_LABEL = { '*': 'Wszystkie kanały', allegro: 'Allegro', baselinker: 'BaseLinker' }

function ChannelSelect({ value, onChange, id }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="*">Wszystkie kanały</option>
      <option value="allegro">Tylko Allegro</option>
      <option value="baselinker">Tylko BaseLinker</option>
    </select>
  )
}

/** Proste filtrowanie po SKU / EAN / nazwie (bez wielkości liter). */
function useFiltered(items, query) {
  return useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => `${it.sku} ${it.ean} ${it.name}`.toLowerCase().includes(q))
  }, [items, query])
}

function Pager({ page, pages, onPage }) {
  if (pages <= 1) return null
  return (
    <div className="ign-pager">
      <button type="button" className="btn btn--tiny" onClick={() => onPage(page - 1)} disabled={page <= 0}>‹ Poprzednia</button>
      <span className="small">Strona {page + 1} z {pages}</span>
      <button type="button" className="btn btn--tiny" onClick={() => onPage(page + 1)} disabled={page >= pages - 1}>Następna ›</button>
    </div>
  )
}

/** Zaznaczanie wierszy po kluczu + „zaznacz widoczne". */
function useSelection() {
  const [sel, setSel] = useState(() => new Set())
  const toggle = (key) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const setMany = (keys, on) =>
    setSel((s) => {
      const n = new Set(s)
      for (const k of keys) on ? n.add(k) : n.delete(k)
      return n
    })
  const clear = () => setSel(new Set())
  return { sel, toggle, setMany, clear }
}

export default function IgnorowaneTab() {
  const [ignored, setIgnored] = useState([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState(null)

  const reload = useCallback(async () => {
    setLoading(true)
    const r = await window.agent.ignoredList()
    setLoading(false)
    if (r.ok) setIgnored(r.data || [])
    else setMsg({ ok: false, text: r.error })
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const add = useCallback(
    async (items) => {
      if (items.length === 0) return
      const r = await window.agent.ignoredAdd(items)
      if (!r.ok) return setMsg({ ok: false, text: r.error })
      setMsg({ ok: true, text: `Dodano ${r.data.added} pozycji. Na liście: ${r.data.total}. Synchronizacja będzie je pomijać.` })
      reload()
    },
    [reload]
  )

  const remove = useCallback(
    async (items) => {
      if (items.length === 0) return
      const r = await window.agent.ignoredRemove(items)
      if (!r.ok) return setMsg({ ok: false, text: r.error })
      setMsg({ ok: true, text: `Przywrócono ${r.data.removed} pozycji — wrócą do synchronizacji w następnym cyklu.` })
      reload()
    },
    [reload]
  )

  return (
    <div className="grid">
      <section className="card card--wide">
        <h2>Ignorowane pozycje</h2>
        <p className="hint">
          Zaznaczone tu towary są <strong>pomijane przez synchronizację stanów</strong> (BaseLinker i każde konto Allegro):
          program ich nie dopasowuje, nie wysyła stanu i nie pokazuje w „Problemy". Kliknięcie „Ignoruj" w „Problemy"
          też dopisuje towar do tej listy. Usunięcie z listy przywraca synchronizację od następnego cyklu.
        </p>
        {msg && <div className={`result ${msg.ok ? 'result--ok' : 'result--warn'}`}>{msg.text}</div>}
        <IgnoredList items={ignored} loading={loading} onRemove={remove} onReload={reload} />
      </section>

      <AddBySku onAdd={add} />
      <PickFromWapro ignored={ignored} onAdd={add} />
    </div>
  )
}

/* ============================ Lista ignorowanych ========================= */

function IgnoredList({ items, loading, onRemove, onReload }) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const { sel, toggle, setMany, clear } = useSelection()
  const keyOf = (it) => `${it.sku}\u0001${it.channel}`

  const filtered = useFiltered(items, query)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const safePage = Math.min(page, pages - 1)
  const visible = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE)
  const allVisibleSelected = visible.length > 0 && visible.every((it) => sel.has(keyOf(it)))

  const removeSelected = async () => {
    const chosen = items.filter((it) => sel.has(keyOf(it)))
    await onRemove(chosen.map((it) => ({ sku: it.sku, channel: it.channel })))
    clear()
  }

  return (
    <>
      <div className="field-row field-row--tight">
        <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} placeholder="Szukaj: SKU, EAN, nazwa…" />
        <button type="button" className="btn" onClick={onReload} disabled={loading}>{loading ? 'Wczytuję…' : 'Odśwież'}</button>
        <button type="button" className="btn btn--primary" onClick={removeSelected} disabled={sel.size === 0}>
          Przywróć zaznaczone ({sel.size})
        </button>
      </div>
      <p className="small">Na liście: <strong>{items.length}</strong>{query && <> · pasuje: {filtered.length}</>}</p>

      {loading ? (
        <div className="ac-loading"><span className="spinner spinner--lg" aria-hidden="true" /> Wczytuję…</div>
      ) : items.length === 0 ? (
        <p className="empty-state">Lista jest pusta — synchronizacja obejmuje wszystkie towary.</p>
      ) : (
        <>
          <table className="minitable minitable--full">
            <thead>
              <tr>
                <th className="ign-check">
                  <input type="checkbox" checked={allVisibleSelected} onChange={(e) => setMany(visible.map(keyOf), e.target.checked)} aria-label="Zaznacz widoczne" />
                </th>
                <th>SKU</th><th>EAN</th><th>Nazwa</th><th>Kanał</th><th>Skąd</th><th>Dodano</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((it) => (
                <tr key={keyOf(it)}>
                  <td className="ign-check"><input type="checkbox" checked={sel.has(keyOf(it))} onChange={() => toggle(keyOf(it))} aria-label={`Zaznacz ${it.sku}`} /></td>
                  <td><code>{it.sku}</code></td>
                  <td><code>{it.ean || '—'}</code></td>
                  <td>{it.name || '—'}</td>
                  <td><span className="tag tag--muted">{CHANNEL_LABEL[it.channel] ?? it.channel}</span></td>
                  <td className="small">{it.note || 'ręcznie'}</td>
                  <td className="small">{it.createdAt}</td>
                  <td>
                    <button type="button" className="btn btn--tiny" onClick={() => onRemove([{ sku: it.sku, channel: it.channel }])}>Przywróć</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={safePage} pages={pages} onPage={setPage} />
        </>
      )}
    </>
  )
}

/* ============================ Dodaj po SKU ============================== */

function AddBySku({ onAdd }) {
  const [text, setText] = useState('')
  const [channel, setChannel] = useState('*')
  const [busy, setBusy] = useState(false)

  // Jedno SKU w wierszu; akceptujemy też przecinki/średniki/tabulatory (wklejka z Excela).
  const skus = useMemo(
    () => [...new Set(text.split(/[\n\r,;\t]+/).map((s) => s.trim()).filter(Boolean))],
    [text]
  )

  const submit = async () => {
    setBusy(true)
    await onAdd(skus.map((sku) => ({ sku, channel, note: 'Wklejone SKU' })))
    setBusy(false)
    setText('')
  }

  return (
    <section className="card card--wide">
      <h2>Dodaj po indeksie (SKU)</h2>
      <p className="hint">Wklej indeksy WAPRO — jeden w wierszu (można skopiować kolumnę z Excela).</p>
      <textarea className="ign-textarea" value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder={'np.\nBB-FC-14G\nBB-FC-9G'} />
      <div className="field-row field-row--tight">
        <label htmlFor="ign-add-ch" className="small">Pomijaj dla:</label>
        <ChannelSelect id="ign-add-ch" value={channel} onChange={setChannel} />
        <button type="button" className="btn btn--primary" onClick={submit} disabled={busy || skus.length === 0}>
          {busy ? 'Dodaję…' : `Dodaj do ignorowanych (${skus.length})`}
        </button>
      </div>
    </section>
  )
}

/* ======================= Wybierz z towarów WAPRO ======================== */

function PickFromWapro({ ignored, onAdd }) {
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [channel, setChannel] = useState('*')
  const [hideIgnored, setHideIgnored] = useState(true)
  const { sel, toggle, setMany, clear } = useSelection()

  const load = async () => {
    setLoading(true)
    setError(null)
    const r = await window.agent.ignoredPickList()
    setLoading(false)
    if (r.ok) setRows(r.data || [])
    else setError(r.error)
  }

  // Bieżący stan listy ignorowanych (po dodaniu/przywróceniu bez ponownego czytania WAPRO).
  const ignoredSkus = useMemo(() => new Set(ignored.map((it) => it.sku)), [ignored])
  const base = useMemo(() => (rows ?? []).filter((r) => !hideIgnored || !ignoredSkus.has(r.sku)), [rows, hideIgnored, ignoredSkus])
  const filtered = useFiltered(base, query)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const safePage = Math.min(page, pages - 1)
  const visible = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE)
  const allVisibleSelected = visible.length > 0 && visible.every((r) => sel.has(r.sku))

  const addSelected = async () => {
    const chosen = (rows ?? []).filter((r) => sel.has(r.sku))
    await onAdd(chosen.map((r) => ({ sku: r.sku, ean: r.ean, name: r.name, channel, note: 'Wybrane z WAPRO' })))
    clear()
  }

  const selectAllFiltered = () => setMany(filtered.map((r) => r.sku), true)

  return (
    <section className="card card--wide">
      <h2>Wybierz z towarów WAPRO</h2>
      <p className="hint">Wczytaj listę towarów, wyszukaj i zaznacz te, które program ma pomijać.</p>
      {rows === null ? (
        <div className="button-row">
          <button type="button" className="btn btn--primary" onClick={load} disabled={loading}>
            {loading ? <><span className="spinner" aria-hidden="true" /> Wczytuję towary…</> : 'Wczytaj towary z WAPRO'}
          </button>
        </div>
      ) : (
        <>
          <div className="field-row field-row--tight">
            <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} placeholder="Szukaj: SKU, EAN, nazwa…" />
            <label className="small ign-inline">
              <input type="checkbox" checked={hideIgnored} onChange={(e) => { setHideIgnored(e.target.checked); setPage(0) }} /> ukryj już ignorowane
            </label>
            <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? 'Wczytuję…' : 'Odśwież'}</button>
          </div>
          <div className="field-row field-row--tight">
            <button type="button" className="btn btn--tiny" onClick={selectAllFiltered} disabled={filtered.length === 0}>
              Zaznacz wszystkie wyniki ({filtered.length})
            </button>
            <button type="button" className="btn btn--tiny" onClick={clear} disabled={sel.size === 0}>Odznacz</button>
            <label htmlFor="ign-pick-ch" className="small">Pomijaj dla:</label>
            <ChannelSelect id="ign-pick-ch" value={channel} onChange={setChannel} />
            <button type="button" className="btn btn--primary" onClick={addSelected} disabled={sel.size === 0}>
              Ignoruj zaznaczone ({sel.size})
            </button>
          </div>
          <p className="small">Towarów: <strong>{rows.length}</strong>{(query || hideIgnored) && <> · widocznych: {filtered.length}</>}</p>
          {filtered.length === 0 ? (
            <p className="empty-state">Brak towarów dla tego filtra.</p>
          ) : (
            <>
              <table className="minitable minitable--full">
                <thead>
                  <tr>
                    <th className="ign-check">
                      <input type="checkbox" checked={allVisibleSelected} onChange={(e) => setMany(visible.map((r) => r.sku), e.target.checked)} aria-label="Zaznacz widoczne" />
                    </th>
                    <th>SKU</th><th>EAN</th><th>Nazwa</th><th className="num">Stan</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.sku}>
                      <td className="ign-check"><input type="checkbox" checked={sel.has(r.sku)} onChange={() => toggle(r.sku)} aria-label={`Zaznacz ${r.sku}`} /></td>
                      <td><code>{r.sku}</code></td>
                      <td><code>{r.ean || '—'}</code></td>
                      <td>{r.name || '—'}</td>
                      <td className="num">{r.quantity}</td>
                      <td>{ignoredSkus.has(r.sku) && <span className="tag tag--muted">ignorowany</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager page={safePage} pages={pages} onPage={setPage} />
            </>
          )}
        </>
      )}
      {error && <div className="result result--warn">{error}</div>}
    </section>
  )
}
