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

  const authorize = async () => {
    setAlResult(null)
    const r = await run('authorize', () => window.agent.authorizeAllegro())
    if (r) {
      setAlResult(
        r.ok
          ? { ok: true, message: `Autoryzacja zakończona${r.accountLogin ? ` — konto ${r.accountLogin}` : ''}.` }
          : { ok: false, message: r.error }
      )
      load()
    }
  }

  const testAl = async () => {
    setAlResult(null)
    const r = await run('test-al', () => window.agent.testAllegro())
    if (r) {
      setAlResult(r)
      load()
    }
  }

  const disconnect = async () => {
    if (!confirm('Odłączyć konto Allegro? Tokeny zostaną usunięte, dane aplikacji zostaną zachowane.')) {
      return
    }
    await run('disconnect', () => window.agent.disconnectAllegro(), 'Konto Allegro odłączone.')
    setAlResult(null)
    load()
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
          <h2>Allegro</h2>
          <AllegroBadge status={alStatus} />
        </div>

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
          <button
            type="button"
            className="btn btn--primary"
            onClick={authorize}
            disabled={busy === 'authorize' || !al.clientId || (!al.clientSecret && !alStatus.hasClientSecret)}
          >
            {busy === 'authorize' ? 'Czekam na przeglądarkę…' : 'Autoryzuj Allegro (OAuth)'}
          </button>
        </div>

        <div className="button-row button-row--tight">
          <button
            type="button"
            className="btn"
            onClick={testAl}
            disabled={busy === 'test-al' || !alStatus.authorized}
          >
            {busy === 'test-al' ? 'Sprawdzam…' : 'Testuj połączenie Allegro'}
          </button>
          {alStatus.authorized && (
            <button type="button" className="btn btn--danger" onClick={disconnect} disabled={busy === 'disconnect'}>
              Odłącz konto
            </button>
          )}
        </div>

        {busy === 'authorize' && (
          <div className="result result--warn">
            Otworzyłem przeglądarkę. Zaloguj się do Allegro i zatwierdź dostęp — aplikacja czeka
            na powrót (limit 5 minut). Jeśli nic się nie otworzyło, sprawdź, czy przeglądarka
            domyślna nie jest zablokowana.
          </div>
        )}

        <ResultBox result={alResult} status={alStatus} />

        {alStatus.authorized && (
          <dl className="kv" style={{ marginTop: 14 }}>
            {alStatus.accountLogin && <><dt>Konto</dt><dd>{alStatus.accountLogin}</dd></>}
            <dt>Token ważny do</dt>
            <dd>
              {formatDate(alStatus.expiresAt)}{' '}
              {alStatus.tokenExpired && <Tag tone="warn">wygasł</Tag>}
            </dd>
            <dt>Odświeżanie</dt>
            <dd>
              {alStatus.hasRefreshToken ? (
                <Tag tone="ok">automatyczne</Tag>
              ) : (
                <Tag tone="warn">brak refresh_token</Tag>
              )}
            </dd>
            {alStatus.scope && (
              <>
                <dt>Zakresy</dt>
                <dd className="small">{alStatus.scope}</dd>
              </>
            )}
          </dl>
        )}

        <div className="button-row">
          <button
            type="button"
            className="btn btn--tiny"
            disabled={busy === 'al-orders' || !alStatus.authorized}
            onClick={async () => {
              const r = await run('al-orders', () => window.agent.fetchAllegroOrders({ limit: 20 }))
              if (r) setPreview({ source: 'Allegro', ...r })
            }}
          >
            {busy === 'al-orders' ? 'Pobieram…' : 'Pobierz zamówienia do realizacji'}
          </button>
        </div>
      </form>

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

function AllegroBadge({ status }) {
  if (!status.authorized) return <Tag tone="muted">niepołączone</Tag>
  if (status.tokenExpired && !status.hasRefreshToken) return <Tag tone="error">token wygasł</Tag>
  if (status.lastCheckOk === false) return <Tag tone="error">błąd</Tag>
  return <Tag tone="ok">autoryzowane</Tag>
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
