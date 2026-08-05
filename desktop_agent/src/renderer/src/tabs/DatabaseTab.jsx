import { useEffect, useMemo, useState } from 'react'
import { Checkbox, Field } from '../components/ui.jsx'

const EMPTY_DB = {
  host: '',
  port: 1433,
  instanceName: '',
  database: '',
  user: '',
  password: '',
  encrypt: false,
  trustServerCertificate: true
}

const ROLE_LABELS = {
  artykuly: 'Tabela produktów (artykuły / towary)',
  stany: 'Tabela stanów magazynowych',
  magazyny: 'Tabela magazynów'
}

const ROLE_DEFAULTS = {
  artykuly: 'dbo.ARTYKULY',
  stany: 'dbo.STANY_MAGAZYNOWE',
  magazyny: 'dbo.MAGAZYNY'
}

/** Buduje „schemat.tabela" z zapisanej mapy schematu (albo domyślnej). */
function currentFullName(schemaMap, role) {
  const sec = schemaMap?.[role]
  if (sec?.table) {
    const schema = sec.schema || schemaMap?.schema || 'dbo'
    return `${schema}.${sec.table}`
  }
  return ROLE_DEFAULTS[role]
}

/** Rozbija „schemat.tabela" na części (pierwsza kropka rozdziela schemat). */
function splitFullName(full) {
  const i = String(full).indexOf('.')
  return i === -1
    ? { schema: 'dbo', table: String(full) }
    : { schema: full.slice(0, i), table: full.slice(i + 1) }
}

/** Pola awaryjnego mapowania kolumn: [klucz stanu formularza, sekcja, pole w mapie, etykieta, placeholder]. */
const COLUMN_OVERRIDE_FIELDS = [
  ['artId', 'artykuly', 'id', 'ID artykułu', 'ID_ARTYKULU'],
  ['name', 'artykuly', 'name', 'Nazwa artykułu', 'NAZWA'],
  ['sku', 'artykuly', 'skuColumns', 'SKU / indeks (po przecinku)', 'INDEKS_KATALOGOWY, INDEKS_HANDLOWY'],
  ['barcode', 'artykuly', 'barcode', 'Kod kreskowy / EAN', 'PODSTAWOWY_KOD_KRESKOWY'],
  ['archivedFlag', 'artykuly', 'archivedFlag', 'Flaga archiwum', 'ARCHIWALNY'],
  ['articleId', 'stany', 'articleId', 'ID artykułu w stanach', 'ID_ARTYKULU'],
  ['warehouseId', 'stany', 'warehouseId', 'ID magazynu', 'ID_MAGAZYNU'],
  ['quantity', 'stany', 'quantity', 'Stan / ilość', 'STAN'],
  ['reserved', 'stany', 'reserved', 'Rezerwacja', 'REZERWACJA']
]

/** Buduje stan formularza kolumn z zapisanej mapy schematu. */
function columnFormFrom(schemaMap) {
  const out = {}
  for (const [key, section, field] of COLUMN_OVERRIDE_FIELDS) {
    const val = schemaMap?.[section]?.[field]
    out[key] = Array.isArray(val) ? val.join(', ') : val || ''
  }
  return out
}

export default function DatabaseTab({ settings, busy, run, onSaved }) {
  const [form, setForm] = useState(() => ({ ...EMPTY_DB, ...settings.db, password: '' }))
  const [testResult, setTestResult] = useState(null)
  const [introspection, setIntrospection] = useState(null)

  // Wyszukiwarka / selektor tabel
  const [discovery, setDiscovery] = useState(null)
  const [tableMap, setTableMap] = useState(() => ({
    artykuly: currentFullName(settings.schemaMap, 'artykuly'),
    stany: currentFullName(settings.schemaMap, 'stany'),
    magazyny: currentFullName(settings.schemaMap, 'magazyny')
  }))

  // Diagnostyka schematu + awaryjne nadpisywanie kolumn
  const [diagnostics, setDiagnostics] = useState(null)
  const [colForm, setColForm] = useState(() => columnFormFrom(settings.schemaMap))

  useEffect(() => {
    setColForm(columnFormFrom(settings.schemaMap))
  }, [settings.schemaMap])

  useEffect(() => {
    setForm({ ...EMPTY_DB, ...settings.db, password: '' })
  }, [settings.db])

  useEffect(() => {
    setTableMap({
      artykuly: currentFullName(settings.schemaMap, 'artykuly'),
      stany: currentFullName(settings.schemaMap, 'stany'),
      magazyny: currentFullName(settings.schemaMap, 'magazyny')
    })
  }, [settings.schemaMap])

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [key]: value }))
  }

  const errors = useMemo(() => {
    const e = {}
    if (!form.host.trim()) e.host = 'Podaj adres IP lub nazwę serwera.'
    if (!form.database.trim()) e.database = 'Podaj nazwę bazy Wapro.'
    if (!form.user.trim()) e.user = 'Podaj nazwę użytkownika MSSQL.'
    const port = Number(form.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      e.port = 'Port musi być z zakresu 1–65535.'
    }
    return e
  }, [form])

  const hasErrors = Object.keys(errors).length > 0

  const handleSave = async (e) => {
    e.preventDefault()
    if (hasErrors) return
    const saved = await run('save-db', () => window.agent.saveDbSettings(form), 'Ustawienia bazy zapisane.')
    if (saved) {
      setForm((f) => ({ ...f, password: '' }))
      onSaved()
    }
  }

  const handleDiscover = async () => {
    const data = await run('discover', () => window.agent.discoverTables())
    if (!data) return
    setDiscovery(data)
    // Jeśli któraś rola jeszcze wskazuje domyślną nazwę, której w bazie nie ma —
    // podstawiamy najlepszą sugestię, żeby użytkownik od razu widział trafienie.
    const names = new Set(data.tables.map((t) => t.fullName))
    setTableMap((prev) => {
      const next = { ...prev }
      for (const role of ['artykuly', 'stany', 'magazyny']) {
        const best = data.suggestions[role]?.[0]?.fullName
        if (best && !names.has(prev[role])) next[role] = best
      }
      return next
    })
  }

  const handleSaveTableMap = async () => {
    const base = settings.schemaMap || {}
    const overrides = { ...base }
    for (const role of ['artykuly', 'stany', 'magazyny']) {
      const { schema, table } = splitFullName(tableMap[role])
      overrides[role] = { ...(base[role] || {}), schema, table }
    }
    const saved = await run(
      'save-tablemap',
      () => window.agent.saveSchemaMap(overrides),
      'Zapisano mapowanie tabel.'
    )
    if (saved) onSaved()
  }

  // Lista opcji do dropdowna: sugerowane (dla roli) na górze, potem wszystkie.
  const optionsFor = (role) => {
    const all = discovery?.tables ?? []
    const suggested = discovery?.suggestions?.[role] ?? []
    const current = tableMap[role]
    const known = new Set(all.map((t) => t.fullName))
    // Gdy jeszcze nie wyszukiwano — pokaż przynajmniej bieżącą wartość.
    const currentList = known.has(current) ? [] : [{ fullName: current, name: current }]
    return { all, suggested, currentList }
  }

  const missingTables = introspection?.tables?.filter((t) => !t.exists) ?? []

  const handleDiagnostics = async () => {
    const data = await run('diagnostics', () => window.agent.schemaDiagnostics())
    if (data) setDiagnostics(data)
  }

  const handleSaveColumns = async () => {
    const base = settings.schemaMap || {}
    // Startujemy od kopii sekcji; puste pole USUWA nadpisanie (powrót do auto).
    const art = { ...(base.artykuly || {}) }
    const stany = { ...(base.stany || {}) }
    const target = { artykuly: art, stany: stany }

    for (const [key, section, field] of COLUMN_OVERRIDE_FIELDS) {
      const raw = String(colForm[key] ?? '').trim()
      if (field === 'skuColumns') {
        const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
        if (list.length) target[section][field] = list
        else delete target[section][field]
      } else if (raw) {
        target[section][field] = raw
      } else {
        delete target[section][field]
      }
    }

    const overrides = { ...base, artykuly: art, stany: stany }
    const saved = await run(
      'save-cols',
      () => window.agent.saveSchemaMap(overrides),
      'Zapisano awaryjne mapowanie kolumn.'
    )
    if (saved) {
      onSaved()
      // Odśwież diagnostykę, jeśli była otwarta — pokaże efekt nadpisania.
      if (diagnostics) handleDiagnostics()
    }
  }

  const setCol = (key) => (e) => setColForm((f) => ({ ...f, [key]: e.target.value }))

  return (
    <form className="grid" onSubmit={handleSave}>
      <section className="card">
        <h2>Połączenie z bazą Wapro Mag</h2>

        <Field label="Host / adres IP serwera" error={errors.host}>
          <input value={form.host} onChange={set('host')} placeholder="192.168.1.10 lub SERWER" />
        </Field>

        <div className="field-row">
          <Field label="Port" error={errors.port}>
            <input
              type="number"
              value={form.port}
              onChange={set('port')}
              disabled={form.instanceName.trim() !== ''}
            />
          </Field>
          <Field label="Instancja nazwana (opcjonalnie)">
            <input value={form.instanceName} onChange={set('instanceName')} placeholder="SQLEXPRESS" />
          </Field>
        </div>

        <Field label="Nazwa bazy danych" error={errors.database}>
          <input value={form.database} onChange={set('database')} placeholder="WAPRO_MAG" />
        </Field>

        <Field label="Użytkownik" error={errors.user}>
          <input value={form.user} onChange={set('user')} placeholder="sa" autoComplete="off" />
        </Field>

        <Field label="Hasło" hint="Pozostaw puste, aby nie zmieniać zapisanego hasła.">
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            placeholder="••••••••"
            autoComplete="new-password"
          />
        </Field>

        <Checkbox checked={form.encrypt} onChange={set('encrypt')}>
          Szyfruj połączenie (TLS)
        </Checkbox>
        <Checkbox checked={form.trustServerCertificate} onChange={set('trustServerCertificate')}>
          Ufaj certyfikatowi serwera (zalecane dla instalacji lokalnych)
        </Checkbox>

        <div className="button-row">
          <button type="submit" className="btn btn--primary" disabled={hasErrors || busy === 'save-db'}>
            {busy === 'save-db' ? 'Zapisuję…' : 'Zapisz ustawienia'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={hasErrors || busy === 'test-db'}
            onClick={async () => {
              setTestResult(null)
              const data = await run('test-db', () => window.agent.testDbConnection(form))
              if (data) setTestResult(data)
            }}
          >
            {busy === 'test-db' ? 'Testuję…' : 'Testuj połączenie'}
          </button>
        </div>

        {testResult && (
          <div className="result result--ok">
            Połączono z <strong>{testResult.serwer}</strong>, baza <strong>{testResult.baza}</strong>,
            wersja {testResult.wersja}.
          </div>
        )}
      </section>

      <section className="card">
        <h2>Weryfikacja schematu</h2>
        <p className="hint">
          Sprawdza na żywej bazie, czy tabele <code>ARTYKULY</code>, <code>STANY_MAGAZYNOWE</code>{' '}
          i <code>MAGAZYNY</code> mają oczekiwane kolumny. Uruchom po pierwszym połączeniu —
          różne wersje WF-Maga bywają rozbieżne.
        </p>

        <button
          type="button"
          className="btn"
          disabled={busy === 'introspect'}
          onClick={async () => {
            setIntrospection(null)
            const data = await run('introspect', () => window.agent.introspectSchema())
            if (data) setIntrospection(data)
          }}
        >
          {busy === 'introspect' ? 'Sprawdzam…' : 'Sprawdź schemat'}
        </button>

        {introspection && (
          <div className={`result ${introspection.ok ? 'result--ok' : 'result--warn'}`}>
            <p>{introspection.summary}</p>
            <ul className="schema-list">
              {introspection.tables.map((t) => (
                <li key={t.table}>
                  <strong>{t.table}</strong>{' '}
                  {!t.exists && <span className="tag tag--error">tabela nie istnieje</span>}
                  {t.exists && t.missingRequired.length === 0 && (
                    <span className="tag tag--ok">OK ({t.columnCount} kolumn)</span>
                  )}
                  {t.missingRequired?.length > 0 && (
                    <span className="tag tag--error">
                      brak wymaganych: {t.missingRequired.join(', ')}
                    </span>
                  )}
                  {t.missingOptional?.length > 0 && (
                    <span className="tag tag--warn">
                      brak opcjonalnych: {t.missingOptional.join(', ')}
                    </span>
                  )}
                  {t.suggestions && Object.keys(t.suggestions).length > 0 && (
                    <ul className="schema-list__hints">
                      {Object.entries(t.suggestions).map(([col, hints]) => (
                        <li key={col}>
                          <code>{col}</code> → może chodzi o: {hints.join(', ')}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {!introspection.ok && (
              <p className="hint">
                Nie znaleziono domyślnych tabel? Skorzystaj z sekcji{' '}
                <strong>„Mapowanie tabel"</strong> poniżej — wyszukaj tabele w bazie i wskaż
                właściwe ręcznie. Do czasu poprawy synchronizacja stanów będzie zwracać błąd.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="card card--wide">
        <h2>Mapowanie tabel (produkty / stany / magazyny)</h2>
        <p className="hint">
          Jeśli u klienta tabele mają nietypowe nazwy, prefiksy albo leżą w innym schemacie,
          wyszukaj je w bazie i wskaż ręcznie. Wybór zapisujemy w konfiguracji — synchronizacja
          zawsze korzysta ze wskazanych tabel.
        </p>

        <div className="button-row">
          <button
            type="button"
            className="btn"
            disabled={busy === 'discover'}
            onClick={handleDiscover}
          >
            {busy === 'discover' ? 'Szukam…' : 'Wyszukaj tabele w bazie'}
          </button>
          {discovery && (
            <span className="hint">
              Znaleziono {discovery.tables.length} tabel. Sugestie oznaczone „★".
            </span>
          )}
        </div>

        {missingTables.length > 0 && (
          <div className="result result--warn">
            Weryfikacja nie znalazła:{' '}
            {missingTables.map((t) => `${t.schema}.${t.table}`).join(', ')}. Wskaż właściwe
            tabele poniżej.
          </div>
        )}

        {['artykuly', 'stany', 'magazyny'].map((role) => {
          const { all, suggested, currentList } = optionsFor(role)
          const suggestedNames = new Set(suggested.map((s) => s.fullName))
          return (
            <Field key={role} label={ROLE_LABELS[role]}>
              <select
                value={tableMap[role]}
                onChange={(e) => setTableMap((m) => ({ ...m, [role]: e.target.value }))}
              >
                {currentList.map((t) => (
                  <option key={`cur-${t.fullName}`} value={t.fullName}>
                    {t.fullName} (bieżąca)
                  </option>
                ))}
                {suggested.length > 0 && (
                  <optgroup label="Sugerowane">
                    {suggested.map((t) => (
                      <option key={`sug-${t.fullName}`} value={t.fullName}>
                        ★ {t.fullName}
                      </option>
                    ))}
                  </optgroup>
                )}
                {all.length > 0 && (
                  <optgroup label="Wszystkie tabele">
                    {all
                      .filter((t) => !suggestedNames.has(t.fullName))
                      .map((t) => (
                        <option key={`all-${t.fullName}`} value={t.fullName}>
                          {t.fullName}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </Field>
          )
        })}

        <div className="button-row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy === 'save-tablemap'}
            onClick={handleSaveTableMap}
          >
            {busy === 'save-tablemap' ? 'Zapisuję…' : 'Zapisz mapowanie tabel'}
          </button>
        </div>
        <p className="hint">
          Po zapisaniu uruchom ponownie „Sprawdź schemat", aby potwierdzić, że wskazane tabele
          mają wymagane kolumny.
        </p>
      </section>

      <section className="card card--wide">
        <h2>Diagnostyka schematu stanów</h2>
        <p className="hint">
          Pokazuje, jak resolver rozwiązał każdą kolumnę na tej bazie: która realna kolumna
          została użyta i czy dla opcjonalnych (rezerwacja, archiwum, EAN) zadziałał plastyczny
          fallback. „Koło ratunkowe" dla nietypowych baz klientów.
        </p>

        <div className="button-row">
          <button
            type="button"
            className="btn"
            disabled={busy === 'diagnostics'}
            onClick={handleDiagnostics}
          >
            {busy === 'diagnostics' ? 'Wykrywam…' : 'Wykryj ponownie schemat / Odśwież status'}
          </button>
        </div>

        {diagnostics && (
          <div className={`result ${diagnostics.ok ? 'result--ok' : 'result--warn'}`}>
            <p>
              Tabele:{' '}
              <code>{diagnostics.tables.artykuly.schema}.{diagnostics.tables.artykuly.table}</code>{' '}
              ({diagnostics.tables.artykuly.columnCount} kol.) i{' '}
              <code>{diagnostics.tables.stany.schema}.{diagnostics.tables.stany.table}</code>{' '}
              ({diagnostics.tables.stany.columnCount} kol.).{' '}
              {diagnostics.ok
                ? 'Wszystkie wymagane kolumny znalezione.'
                : `Brakuje wymaganych: ${diagnostics.missingRequired.join(', ')}.`}
            </p>
            <table className="minitable minitable--full">
              <thead>
                <tr><th>Pole</th><th>Tabela</th><th>Kolumna</th><th>Status</th></tr>
              </thead>
              <tbody>
                {diagnostics.fields.map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td className="small">{f.section}</td>
                    <td>{f.resolved ? <code>{f.resolved}</code> : <span className="small">—</span>}</td>
                    <td>
                      {f.required && !f.found && <span className="tag tag--error">BRAK — WYMAGANA</span>}
                      {f.found && <span className="tag tag--ok">znaleziono</span>}
                      {!f.required && !f.found && (
                        <span className="tag tag--warn">fallback: {f.fallback}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card--wide">
        <h2>Awaryjne mapowanie kolumn (ustawienia zaawansowane)</h2>
        <p className="hint">
          Wypełnij tylko, gdy automatyczny resolver nie trafił w nietypową nazwę kolumny u
          klienta. Puste pole = tryb automatyczny (nazwa wykryta z listy wariantów). Wpisana
          nazwa ma pierwszeństwo. SKU możesz podać jako kilka kolumn po przecinku.
        </p>

        {COLUMN_OVERRIDE_FIELDS.map(([key, section, , label, placeholder]) => (
          <Field key={key} label={`${label} (${section})`}>
            <input value={colForm[key]} onChange={setCol(key)} placeholder={placeholder} autoComplete="off" />
          </Field>
        ))}

        <div className="button-row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy === 'save-cols'}
            onClick={handleSaveColumns}
          >
            {busy === 'save-cols' ? 'Zapisuję…' : 'Zapisz awaryjne mapowanie kolumn'}
          </button>
        </div>
        <p className="hint">
          Po zapisaniu kliknij „Wykryj ponownie schemat", aby potwierdzić, że nadpisane kolumny
          zostały poprawnie rozpoznane.
        </p>
      </section>
    </form>
  )
}
