import { useCallback, useEffect, useRef, useState } from 'react'
import { Checkbox, Field, Tag, formatDate } from '../components/ui.jsx'

/**
 * Zakładka „Integracje API".
 *
 * Konfiguracja bezpośrednich połączeń z BaseLinkerem i Allegro — bez
 * pośrednictwa Cloud Huba. Sekrety nigdy nie wracają z procesu głównego:
 * formularz pokazuje wyłącznie zamaskowany podgląd, a puste pole przy zapisie
 * oznacza „nie zmieniaj". Dzięki temu klucz nie krąży po IPC przy każdym
 * odświeżeniu widoku.
 */

const EMPTY_BL = { token: '', inventoryId: '', warehouseId: 'bl_1' }
const EMPTY_AL = { clientId: '', clientSecret: '', redirectUri: '', sandbox: false }

export default function IntegrationsTab({ busy, run }) {
  const [data, setData] = useState(null)
  const [bl, setBl] = useState(EMPTY_BL)
  const [al, setAl] = useState(EMPTY_AL)
  const [blResult, setBlResult] = useState(null)
  const [alResult, setAlResult] = useState(null)
  const [preview, setPreview] = useState(null)

  // Referencje do pól Allegro — czytamy z nich w chwili zapisu, niezależnie od
  // tego, czy stan React zdążył się odświeżyć.
  const clientIdRef = useRef(null)
  const clientSecretRef = useRef(null)
  const redirectUriRef = useRef(null)

  const load = useCallback(async () => {
    const res = await window.agent.getIntegrations()
    if (res.ok) {
      setData(res.data)
      setBl({
        token: '',
        inventoryId: res.data.baselinker.inventoryId ?? '',
        warehouseId: res.data.baselinker.warehouseId ?? 'bl_1'
      })
      setAl({
        clientId: res.data.allegro.clientId ?? '',
        clientSecret: '',
        redirectUri: res.data.allegro.redirectUri ?? '',
        sandbox: Boolean(res.data.allegro.sandbox)
      })
    }
    return res.ok ? res.data : null
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!data) {
    return <div className="loading">Wczytywanie konfiguracji integracji…</div>
  }

  const alStatus = data.allegro
  const blStatus = data.baselinker

  // ---- BaseLinker ---------------------------------------------------------

  const saveBl = async (e) => {
    e.preventDefault()
    const saved = await run('save-bl', () => window.agent.saveBaseLinker(bl), 'Zapisano ustawienia BaseLinkera.')
    if (saved) {
      setBl((f) => ({ ...f, token: '' }))
      load()
    }
  }

  const testBl = async () => {
    setBlResult(null)
    // Token z formularza pozwala przetestować klucz PRZED zapisaniem —
    // inaczej trzeba by zapisać potencjalnie zły klucz, żeby go sprawdzić.
    const r = await run('test-bl', () => window.agent.testBaseLinker({ token: bl.token }))
    if (r) {
      setBlResult(r)
      load()
    }
  }

  // ---- Allegro ------------------------------------------------------------

  const saveAl = async (e) => {
    e.preventDefault()
    setAlResult(null)

    // Czytamy prosto z DOM (referencje do inputów). Dzięki temu payload powstaje
    // z FAKTYCZNIE wpisanych wartości, nawet gdyby stan React `al` był o krok
    // z tyłu (np. bardzo szybkie kliknięcie tuż po wpisaniu / opóźniony re-render).
    // Referencja to źródło prawdy; stan `al` jest tylko awaryjnym fallbackiem.
    const clientId = String(clientIdRef.current?.value ?? al.clientId ?? '').trim()
    const clientSecret = clientSecretRef.current?.value ?? al.clientSecret ?? ''
    const redirectUri = String(redirectUriRef.current?.value ?? al.redirectUri ?? '').trim()

    // Walidacja: nie wysyłamy pustego Client ID do backendu — od razu mówimy
    // użytkownikowi, co uzupełnić, i przerywamy zapis.
    if (!clientId) {
      setAlResult({ ok: false, message: 'Podaj Client ID aplikacji Allegro — pole nie może być puste.' })
      clientIdRef.current?.focus()
      // Zsynchronizuj stan z pustym polem, żeby UI był spójny.
      setAl((f) => ({ ...f, clientId: '' }))
      return
    }

    const payload = { clientId, clientSecret, redirectUri, sandbox: Boolean(al.sandbox) }

    console.log('[UI] Zapis Allegro — payload z DOM:', {
      clientId,
      clientSecret: clientSecret ? '(podano)' : '(puste — bez zmian)',
      redirectUri: redirectUri || '(puste)',
      sandbox: payload.sandbox
    })

    const saved = await run('save-al', () => window.agent.saveAllegro(payload), 'Zapisano ustawienia Allegro.')
    if (saved) {
      console.log('[UI] Allegro zapisane — backend potwierdza clientId:', saved.allegro?.clientId || '(brak)')
      // Odzwierciedlamy w stanie to, co realnie zapisaliśmy (i czyścimy sekret).
      setAl((f) => ({ ...f, clientId, redirectUri, clientSecret: '' }))
      load()
    }
  }

  const redirectHint = al.redirectUri || alStatus.redirectUri

  return (
    <div className="grid">
      {/* ================= BaseLinker ================= */}
      <form className="card" onSubmit={saveBl}>
        <div className="card__header">
          <h2>BaseLinker</h2>
          <ConnectionBadge status={blStatus} label="token" />
        </div>

        <Field
          label="Token API"
          hint={
            blStatus.hasToken
              ? `Zapisany klucz: ${blStatus.tokenPreview}. Wpisz nowy tylko jeśli chcesz go zmienić.`
              : 'Panel BaseLinkera → Moje konto → API → Wygeneruj token.'
          }
        >
          <input
            type="password"
            value={bl.token}
            onChange={(e) => setBl((f) => ({ ...f, token: e.target.value }))}
            placeholder={blStatus.hasToken ? '•••••••••••••' : 'wklej token z panelu BaseLinkera'}
            autoComplete="off"
          />
        </Field>

        <div className="field-row">
          <Field label="ID katalogu (inventory_id)" hint="Wypełni się po teście połączenia.">
            <input
              value={bl.inventoryId}
              onChange={(e) => setBl((f) => ({ ...f, inventoryId: e.target.value }))}
              inputMode="numeric"
              placeholder="np. 1234"
            />
          </Field>
          <Field label="ID magazynu" hint="Domyślnie bl_1 — magazyn wewnętrzny.">
            <input
              value={bl.warehouseId}
              onChange={(e) => setBl((f) => ({ ...f, warehouseId: e.target.value }))}
              placeholder="bl_1"
            />
          </Field>
        </div>

        <div className="button-row">
          <button type="submit" className="btn btn--primary" disabled={busy === 'save-bl'}>
            {busy === 'save-bl' ? 'Zapisuję…' : 'Zapisz ustawienia'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={testBl}
            disabled={busy === 'test-bl' || (!bl.token && !blStatus.hasToken)}
          >
            {busy === 'test-bl' ? 'Sprawdzam…' : 'Testuj połączenie BaseLinker'}
          </button>
        </div>

        <ResultBox result={blResult} status={blStatus} />

        {blResult?.inventories?.length > 0 && (
          <div className="result result--ok">
            <p>Kliknij katalog, żeby wpisać jego ID do formularza:</p>
            <div className="button-row button-row--tight">
              {blResult.inventories.map((inv) => (
                <button
                  key={inv.id}
                  type="button"
                  className="btn btn--tiny"
                  onClick={() => setBl((f) => ({ ...f, inventoryId: String(inv.id) }))}
                >
                  {inv.name} ({inv.id})
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="button-row">
          <button
            type="button"
            className="btn btn--tiny"
            disabled={busy === 'bl-orders' || !blStatus.hasToken}
            onClick={async () => {
              const r = await run('bl-orders', () => window.agent.fetchBaseLinkerOrders({}))
              if (r) setPreview({ source: 'BaseLinker', ...r })
            }}
          >
            {busy === 'bl-orders' ? 'Pobieram…' : 'Pobierz zamówienia z ostatniej doby'}
          </button>
        </div>
      </form>

      {/* ================= Allegro ================= */}
      <form className="card" onSubmit={saveAl}>
        <div className="card__header">
          <h2>Aplikacja Allegro</h2>
        </div>
        <p className="hint">
          Dane aplikacji z panelu Allegro — wspólne dla wszystkich kont. Konta sprzedawcy podłączasz niżej, w sekcji „Konta Allegro".
        </p>

        <Field label="Client ID" hint="Panel Allegro → Moje aplikacje → dane aplikacji.">
          <input
            ref={clientIdRef}
            name="clientId"
            value={al.clientId}
            onChange={(e) => setAl((f) => ({ ...f, clientId: e.target.value }))}
            placeholder="np. 4a1b2c3d4e5f6789..."
            autoComplete="off"
          />
        </Field>

        <Field
          label="Client Secret"
          hint={
            alStatus.hasClientSecret
              ? `Zapisany sekret: ${alStatus.clientSecretPreview}. Wpisz nowy tylko przy zmianie.`
              : 'Sekret z tej samej sekcji panelu Allegro.'
          }
        >
          <input
            ref={clientSecretRef}
            name="clientSecret"
            type="password"
            value={al.clientSecret}
            onChange={(e) => setAl((f) => ({ ...f, clientSecret: e.target.value }))}
            placeholder={alStatus.hasClientSecret ? '•••••••••••••' : 'wklej client secret'}
            autoComplete="off"
          />
        </Field>

        <Field
          label="Adres powrotny (redirect URI)"
          hint="Musi być wpisany w panelu Allegro CO DO ZNAKU, razem z portem."
        >
          <input
            ref={redirectUriRef}
            name="redirectUri"
            value={al.redirectUri}
            onChange={(e) => setAl((f) => ({ ...f, redirectUri: e.target.value }))}
            placeholder="http://localhost:8123/callback"
          />
        </Field>

        <Checkbox
          checked={al.sandbox}
          onChange={(e) => setAl((f) => ({ ...f, sandbox: e.target.checked }))}
        >
          Środowisko testowe (sandbox)
        </Checkbox>

        <div className="result result--warn">
          <p style={{ margin: 0 }}>
            W panelu Allegro ustaw typ aplikacji na <strong>„z dostępem do przeglądarki"</strong>
            {' '}i dodaj adres powrotny:
          </p>
          <p style={{ margin: '6px 0 0' }}>
            <code>{redirectHint}</code>
          </p>
        </div>

        <div className="button-row">
          <button type="submit" className="btn" disabled={busy === 'save-al'}>
            {busy === 'save-al' ? 'Zapisuję…' : 'Zapisz ustawienia'}
          </button>
        </div>

        <ResultBox result={alResult} status={{}} />
      </form>

      {/* ================= Konta Allegro (równorzędne) ================= */}
      <AllegroAccountsCard busy={busy} run={run} canAuthorize={Boolean(alStatus.clientId && alStatus.hasClientSecret)} onPreview={setPreview} />

      {/* ================= Podgląd pobranych zamówień ================= */}
      {preview && (
        <section className="card card--wide">
          <div className="card__header">
            <h2>Zamówienia z: {preview.source}</h2>
            <button type="button" className="btn btn--tiny" onClick={() => setPreview(null)}>
              Zamknij
            </button>
          </div>

          {preview.count === 0 ? (
            <p className="empty-state">Brak zamówień spełniających kryteria.</p>
          ) : (
            <>
              <p className="hint">
                Znaleziono <strong>{preview.count}</strong>, poniżej pierwsze {preview.sample.length}.
                To wyłącznie podgląd — nic nie zostało zapisane do Wapro.
              </p>
              <table className="minitable minitable--full">
                <thead>
                  <tr>
                    <th>ID</th><th>Data</th><th>Nabywca</th>
                    <th className="num">Pozycji</th><th>Status / źródło</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((o) => (
                    <tr key={o.id}>
                      <td><code>{o.id}</code></td>
                      <td className="small">{formatOrderDate(o.date)}</td>
                      <td>{o.buyer || '—'}</td>
                      <td className="num">{o.items}</td>
                      <td className="small">{o.status || o.source || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {/* ================= Nota o bezpieczeństwie ================= */}
      <section className="card card--wide">
        <h2>Gdzie trafiają klucze</h2>
        <p className="hint">
          Token BaseLinkera i sekret Allegro są szyfrowane mechanizmem systemowym
          ({data.encryptionAvailable ? 'Keychain / DPAPI — aktywne' : 'NIEDOSTĘPNE na tym systemie'})
          i zapisywane w pliku konfiguracyjnym aplikacji. Renderer nigdy ich nie otrzymuje —
          widzisz wyłącznie zamaskowany podgląd.
        </p>
        {!data.encryptionAvailable && (
          <div className="result result--warn">
            System nie udostępnia magazynu kluczy, więc sekrety leżą w pliku konfiguracyjnym
            jawnym tekstem. Ogranicz dostęp do tego konta systemowego albo rozważ trzymanie
            kluczy w Cloud Hubie.
          </div>
        )}
        <p className="hint">
          Gdy z komputera korzysta kilka osób, bezpieczniej skonfigurować klucze w panelu
          Cloud Huba — agent dostaje wtedy tylko własny klucz API, a nie dostęp do konta
          sprzedażowego.
        </p>
      </section>
    </div>
  )
}

/* --------------------------------------------------------------------------
   Drobne komponenty pomocnicze
   -------------------------------------------------------------------------- */

function ConnectionBadge({ status, label }) {
  if (!status.hasToken) return <Tag tone="muted">brak {label}u</Tag>
  if (status.lastCheckOk === true) return <Tag tone="ok">połączono</Tag>
  if (status.lastCheckOk === false) return <Tag tone="error">błąd</Tag>
  return <Tag tone="warn">niesprawdzone</Tag>
}

/**
 * Konta Allegro — wszystkie RÓWNORZĘDNE (stany z WAPRO lecą na każde, sprzedaż
 * z każdego zdejmuje stan w WAPRO). Ta sama aplikacja (Client ID/Secret wyżej),
 * osobne autoryzacje. Konto „primary" różni się tylko miejscem zapisu tokenów.
 */
function AllegroAccountsCard({ busy, run, canAuthorize, onPreview }) {
  const [accounts, setAccounts] = useState([])
  const [newLabel, setNewLabel] = useState('')

  const reload = useCallback(async () => {
    const r = await window.agent.listAllegroAccounts()
    if (r.ok) setAccounts(r.data || [])
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  // To samo konto Allegro autoryzowane dwa razy (przeglądarka była zalogowana na inne konto).
  const duplicateOf = (a) => {
    const login = String(a.accountLogin || '').toLowerCase()
    if (!login || !a.authorized) return null
    const first = accounts.find((x) => x.authorized && String(x.accountLogin || '').toLowerCase() === login)
    return first && first.id !== a.id ? first : null
  }
  const connected = accounts.filter((a) => a.authorized && !duplicateOf(a)).length

  const addAccount = async () => {
    const r = await run('al-add', () => window.agent.addAllegroAccount(newLabel.trim()), 'Dodano konto — kliknij „Autoryzuj".')
    if (r?.accounts) {
      setAccounts(r.accounts)
      setNewLabel('')
    } else {
      reload()
    }
  }
  const authorize = async (id) => {
    const r = await run(`al-auth-${id}`, () => window.agent.authorizeAllegro(id))
    if (r && r.ok === false && r.error) window.alert(r.error)
    if (r?.accounts) setAccounts(r.accounts)
    else reload()
  }
  const test = async (id) => {
    await run(`al-test-${id}`, () => window.agent.testAllegro(id))
    reload()
  }
  const remove = async (a) => {
    const msg =
      a.id === 'primary'
        ? 'Odłączyć to konto Allegro? Tokeny zostaną usunięte (dane aplikacji zostają) — potem możesz autoryzować inne konto w tym miejscu.'
        : 'Usunąć to konto Allegro? Tokeny zostaną skasowane.'
    if (!window.confirm(msg)) return
    const r = await run(`al-del-${a.id}`, () => window.agent.disconnectAllegro(a.id))
    if (r?.accounts) setAccounts(r.accounts)
    else reload()
  }
  const orders = async (a) => {
    const r = await run(`al-orders-${a.id}`, () => window.agent.fetchAllegroOrders({ accountId: a.id, limit: 20 }))
    if (r) onPreview?.({ source: `Allegro — ${a.label}`, ...r })
  }

  return (
    <section className="card">
      <div className="card__header">
        <h2>Konta Allegro</h2>
        <Tag tone={connected >= 2 ? 'ok' : 'warn'}>połączone: {connected}</Tag>
      </div>
      <p className="hint">
        Wszystkie konta są równorzędne: stany z WAPRO lecą na każde konto, sprzedaż z każdego konta zdejmuje stan w WAPRO.
        Przed autoryzacją kolejnego konta <strong>wyloguj się z Allegro w przeglądarce</strong> (albo wklej link ze schowka
        w oknie prywatnym, Ctrl+Shift+N) — inaczej podłączy się konto, na które przeglądarka jest zalogowana.
      </p>

      <div className="account-list">
        {accounts.map((a, i) => {
          const dup = duplicateOf(a)
          return (
            <div key={a.id} className="account-card">
              <div className="account-card__head">
                <span className="account-card__name">Konto {i + 1}: {a.label}</span>
                {a.authorized ? (
                  <Tag tone={dup ? 'error' : 'ok'}>{a.accountLogin ? `login ${a.accountLogin}` : 'połączone'}</Tag>
                ) : (
                  <Tag tone="warn">niepołączone</Tag>
                )}
                {a.tokenExpired && !a.hasRefreshToken && <Tag tone="warn">token wygasł</Tag>}
                {dup && <Tag tone="error">to samo konto co „{dup.label}" — pomijane</Tag>}
              </div>
              {dup && (
                <p className="hint">
                  To konto nie jest synchronizowane, bo wskazuje ten sam login co „{dup.label}". Wyloguj się z Allegro
                  w przeglądarce i kliknij „Autoryzuj ponownie", logując się na właściwe konto.
                </p>
              )}
              {!dup && a.lastCheckOk === false && a.lastCheckMessage && <p className="hint">{a.lastCheckMessage}</p>}
              <div className="account-card__actions">
                <button
                  type="button"
                  className="btn btn--tiny"
                  disabled={busy === `al-auth-${a.id}` || !canAuthorize}
                  onClick={() => authorize(a.id)}
                >
                  {busy === `al-auth-${a.id}` ? 'Czekam na przeglądarkę…' : a.authorized ? 'Autoryzuj ponownie' : 'Autoryzuj'}
                </button>
                <button type="button" className="btn btn--tiny" disabled={busy === `al-test-${a.id}` || !a.authorized} onClick={() => test(a.id)}>
                  {busy === `al-test-${a.id}` ? 'Sprawdzam…' : 'Testuj'}
                </button>
                <button type="button" className="btn btn--tiny" disabled={busy === `al-orders-${a.id}` || !a.authorized} onClick={() => orders(a)}>
                  {busy === `al-orders-${a.id}` ? 'Pobieram…' : 'Zamówienia'}
                </button>
                {(a.id !== 'primary' || a.authorized) && (
                  <button type="button" className="btn btn--tiny btn--danger" onClick={() => remove(a)}>
                    {a.id === 'primary' ? 'Odłącz' : 'Usuń'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {!canAuthorize && <p className="hint">Najpierw zapisz Client ID i Client Secret w sekcji „Aplikacja Allegro".</p>}

      <div className="account-add">
        <input
          type="text"
          className="account-add__input"
          placeholder="Nazwa konta (opcjonalnie, np. Sklep 2)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          disabled={busy === 'al-add'}
        />
        <button type="button" className="btn btn--primary" disabled={busy === 'al-add'} onClick={addAccount}>
          {busy === 'al-add' ? 'Dodaję…' : '+ Dodaj konto'}
        </button>
      </div>
    </section>
  )
}

function ResultBox({ result, status }) {
  // Świeży wynik z bieżącej sesji ma pierwszeństwo nad zapisanym w konfiguracji.
  const shown = result
    ? { ok: result.ok, message: result.message, at: null }
    : status.lastCheckAt
      ? { ok: status.lastCheckOk, message: status.lastCheckMessage, at: status.lastCheckAt }
      : null

  if (!shown || !shown.message) return null

  return (
    <div className={`result ${shown.ok ? 'result--ok' : 'result--warn'}`}>
      <p>{shown.message}</p>
      {shown.at && <p className="hint" style={{ margin: 0 }}>Sprawdzono: {formatDate(shown.at)}</p>}
    </div>
  )
}

/** BaseLinker podaje datę jako unix timestamp, Allegro jako ISO. */
function formatOrderDate(value) {
  if (!value) return '—'
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pl-PL')
}
