import { useEffect, useState } from 'react'
import { Checkbox, Field } from '../components/ui.jsx'

export default function SyncTab({ settings, busy, run, onSaved }) {
  const [form, setForm] = useState(settings.sync)
  const [warehouses, setWarehouses] = useState([])

  useEffect(() => setForm(settings.sync), [settings.sync])

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [key]: value }))
  }

  const toggleWarehouse = (id) => {
    setForm((f) => {
      const ids = new Set(f.warehouseIds || [])
      if (ids.has(id)) ids.delete(id)
      else ids.add(id)
      return { ...f, warehouseIds: [...ids] }
    })
  }

  const handleSave = async (e) => {
    e.preventDefault()
    const saved = await run(
      'save-sync',
      () => window.agent.saveSyncSettings(form),
      'Zapisano ustawienia synchronizacji.'
    )
    if (saved) onSaved()
  }

  return (
    <form className="grid" onSubmit={handleSave}>
      <section className="card">
        <h2>Harmonogram</h2>

        <Checkbox checked={form.enabled} onChange={set('enabled')}>
          Włącz automatyczną synchronizację
        </Checkbox>

        <Checkbox checked={Boolean(form.allegroStockEnabled)} onChange={set('allegroStockEnabled')}>
          Wysyłaj stany także bezpośrednio na Allegro (obok BaseLinkera)
        </Checkbox>
        <p className="hint">
          Wymaga połączonego konta Allegro (zakładka „Integracje API”). Stany trafiają wprost
          na oferty — dopasowanie po SKU (sygnatura oferty) lub EAN. Kanał ma własną pamięć
          zmian, więc nie koliduje z wysyłką do BaseLinkera.
        </p>

        <div className="field-row">
          <Field label="Stany — co ile minut">
            <input
              type="number"
              min="1"
              value={form.inventoryIntervalMinutes}
              onChange={set('inventoryIntervalMinutes')}
            />
          </Field>
          <Field label="Zamówienia — co ile minut">
            <input
              type="number"
              min="1"
              value={form.ordersIntervalMinutes}
              onChange={set('ordersIntervalMinutes')}
            />
          </Field>
        </div>

        <div className="field-row">
          <Field label="Wielkość paczki stanów" hint="Ile SKU w jednej paczce wysyłanej do BaseLinkera.">
            <input type="number" min="1" max="1000" value={form.batchSize} onChange={set('batchSize')} />
          </Field>
          <Field label="Zamówień na przebieg">
            <input
              type="number"
              min="1"
              max="200"
              value={form.ordersBatchSize ?? 50}
              onChange={set('ordersBatchSize')}
            />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>Źródło stanów</h2>

        <div className="button-row">
          <button
            type="button"
            className="btn"
            disabled={busy === 'warehouses'}
            onClick={async () => {
              const data = await run('warehouses', () => window.agent.listWarehouses())
              if (data) setWarehouses(data)
            }}
          >
            {busy === 'warehouses' ? 'Wczytuję…' : 'Wczytaj listę magazynów'}
          </button>
        </div>

        {warehouses.length > 0 && (
          <div className="warehouse-list">
            {warehouses.map((w) => (
              <Checkbox
                key={w.id}
                checked={(form.warehouseIds || []).includes(w.id)}
                onChange={() => toggleWarehouse(w.id)}
              >
                {w.symbol ? `${w.symbol} — ` : ''}
                {w.name || `Magazyn ${w.id}`}
              </Checkbox>
            ))}
            <p className="hint">Brak zaznaczenia = wszystkie magazyny.</p>
          </div>
        )}

        <Checkbox checked={form.subtractReserved} onChange={set('subtractReserved')}>
          Odejmuj rezerwacje od stanu
        </Checkbox>
        <Checkbox checked={form.skipArchived} onChange={set('skipArchived')}>
          Pomijaj artykuły archiwalne
        </Checkbox>
        <Checkbox checked={form.aggregateWarehouses} onChange={set('aggregateWarehouses')}>
          Sumuj stany ze wszystkich wybranych magazynów
        </Checkbox>

        <p className="hint">
          Stany ułamkowe są zaokrąglane w dół — lepiej sprzedać mniej niż mieć nadsprzedaż.
        </p>
      </section>

      <section className="card card--wide">
        <h2>Zapis zamówień do Wapro</h2>

        <Field label="Tryb">
          <select value={form.orderMode} onChange={set('orderMode')}>
            <option value="xml">Pliki XML (import ECO) — zalecane na start</option>
            <option value="staging">Tabela pośrednia w bazie Wapro (schemat „integracja”)</option>
          </select>
        </Field>

        {form.orderMode === 'xml' && (
          <>
            <Field label="Folder na pliki XML">
              <div className="field-row field-row--tight">
                <input value={form.xmlOutputFolder || ''} readOnly placeholder="Nie wybrano" />
                <button
                  type="button"
                  className="btn"
                  disabled={busy === 'folder'}
                  onClick={async () => {
                    const folder = await run('folder', () => window.agent.pickFolder())
                    if (folder) setForm((f) => ({ ...f, xmlOutputFolder: folder }))
                  }}
                >
                  Wybierz…
                </button>
              </div>
            </Field>
            <p className="hint">
              Agent nie nadpisuje istniejących plików — zamówienie już wyeksportowane
              jest pomijane, żeby nie zdublować dokumentu, który operator zdążył wciągnąć.
            </p>
          </>
        )}

        {form.orderMode === 'staging' && (
          <>
            <div className="result result--ok">
              Agent zapisuje zamówienia do własnego schematu <code>integracja</code> w bazie
              Wapro. <strong>Tabele ERP nie są modyfikowane</strong> — na nich wykonujemy
              wyłącznie odczyt przy dopasowywaniu artykułów.
            </div>

            <Checkbox checked={form.requireAllMatched} onChange={set('requireAllMatched')}>
              Odrzucaj zamówienia z pozycjami nieodnalezionymi w kartotece Wapro
            </Checkbox>
            <p className="hint">
              Wyłączone: zamówienie zostanie zapisane, a niedopasowane pozycje oznaczone jako{' '}
              <code>BRAK_ARTYKULU</code> — operator uzupełni je ręcznie. Włączone: takie
              zamówienie wraca do kolejki jako błędne i nie trafia do bazy.
            </p>

            <h3 className="subhead">Eksport z bufora do Wapro („ostatni milimetr”)</h3>

            <Checkbox checked={form.reflectToXml} onChange={set('reflectToXml')}>
              Generuj z bufora pliki XML do folderu nasłuchu Wapro
            </Checkbox>
            <p className="hint">
              Zalecane. Bez tego zamówienia zostają w tabeli <code>integracja.ZAMOWIENIA</code>
              {' '}i ktoś musi je stamtąd wciągnąć ręcznie. Z włączoną opcją agent odkłada
              gotowe pliki ECO — z już dopasowanym <code>ID_ARTYKULU</code> — a Wapro wczytuje
              je swoim własnym mechanizmem importu.
            </p>

            {form.reflectToXml && (
              <>
                <Field label="Folder nasłuchu Wapro">
                  <div className="field-row field-row--tight">
                    <input
                      value={form.waproWatchFolder || ''}
                      readOnly
                      placeholder="Nie wybrano"
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === 'watchfolder'}
                      onClick={async () => {
                        const folder = await run('watchfolder', () => window.agent.pickWatchFolder())
                        if (folder) setForm((f) => ({ ...f, waproWatchFolder: folder }))
                      }}
                    >
                      Wybierz…
                    </button>
                  </div>
                </Field>

                <div className="field-row">
                  <Field label="Eksport z bufora — co ile minut">
                    <input
                      type="number"
                      min="1"
                      value={form.reflectIntervalMinutes ?? 5}
                      onChange={set('reflectIntervalMinutes')}
                    />
                  </Field>
                  <div />
                </div>

                <Checkbox checked={form.reflectOnlyMatched} onChange={set('reflectOnlyMatched')}>
                  Eksportuj tylko zamówienia w pełni dopasowane do kartoteki
                </Checkbox>
                <p className="hint">
                  Włączone: zamówienie z pozycją bez <code>ID_ARTYKULU</code> czeka w buforze,
                  aż ktoś uzupełni kartotekę — nie trafi do Wapro niekompletne.
                </p>
              </>
            )}
          </>
        )}

        <div className="button-row">
          <button type="submit" className="btn btn--primary" disabled={busy === 'save-sync'}>
            {busy === 'save-sync' ? 'Zapisuję…' : 'Zapisz ustawienia'}
          </button>
        </div>
      </section>
    </form>
  )
}
