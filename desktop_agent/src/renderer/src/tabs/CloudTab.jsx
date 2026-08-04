import { useEffect, useState } from 'react'
import { Field } from '../components/ui.jsx'

export default function CloudTab({ settings, busy, run, onSaved }) {
  const [form, setForm] = useState({ baseUrl: settings.cloud?.baseUrl || '', apiKey: '' })
  const [health, setHealth] = useState(null)

  useEffect(() => {
    setForm({ baseUrl: settings.cloud?.baseUrl || '', apiKey: '' })
  }, [settings.cloud])

  const urlError =
    form.baseUrl && !/^https?:\/\/.+/i.test(form.baseUrl)
      ? 'Adres musi zaczynać się od http:// lub https://'
      : form.baseUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(form.baseUrl)
        ? null
        : null

  const insecure =
    form.baseUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(form.baseUrl)

  const handleSave = async (e) => {
    e.preventDefault()
    if (urlError) return
    const saved = await run(
      'save-cloud',
      () => window.agent.saveCloudSettings(form),
      'Zapisano dane Cloud Hub.'
    )
    if (saved) {
      setForm((f) => ({ ...f, apiKey: '' }))
      onSaved()
    }
  }

  const panelUrl = form.baseUrl ? `${form.baseUrl.replace(/\/+$/, '')}/admin` : null

  return (
    <form className="grid" onSubmit={handleSave}>
      <section className="card">
        <h2>Autoryzacja Cloud Hub</h2>

        <Field label="Adres Cloud Huba" error={urlError}>
          <input
            value={form.baseUrl}
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            placeholder="https://hub.twojafirma.pl"
          />
        </Field>

        {insecure && (
          <div className="result result--warn">
            Adres bez HTTPS. Klucz API i dane zamówień będą przesyłane otwartym tekstem —
            użyj HTTPS, chyba że hub stoi w tej samej sieci lokalnej.
          </div>
        )}

        <Field
          label="Klucz API agenta"
          hint={
            settings.cloud?.hasApiKey
              ? 'Klucz jest zapisany. Wpisz nowy tylko jeśli chcesz go zmienić.'
              : 'Wygeneruj w panelu huba (zakładka „Agenci”) albo poleceniem register_agent.php'
          }
        >
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            placeholder={settings.cloud?.hasApiKey ? '•••••••••••••' : 'wha_…'}
            autoComplete="off"
          />
        </Field>

        <div className="button-row">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy === 'save-cloud' || !!urlError}
          >
            {busy === 'save-cloud' ? 'Zapisuję…' : 'Zapisz'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy === 'test-cloud'}
            onClick={async () => {
              setHealth(null)
              const data = await run('test-cloud', () => window.agent.testCloud(form))
              if (data) setHealth(data)
            }}
          >
            {busy === 'test-cloud' ? 'Sprawdzam…' : 'Sprawdź połączenie'}
          </button>
        </div>

        {health && (
          <div className="result result--ok">
            Hub odpowiada. Wersja schematu bazy: {health.schema_version}, czas serwera:{' '}
            {health.time}.
          </div>
        )}
      </section>

      <section className="card">
        <h2>Panel huba</h2>
        <p className="hint">
          Autoryzacja konta Allegro, mapowania SKU, kolejka zamówień i logi Anti-Loop
          znajdują się w panelu webowym huba — nie w tej aplikacji.
        </p>

        {panelUrl ? (
          <div className="button-row">
            <button
              type="button"
              className="btn"
              onClick={() => window.agent.openExternal(panelUrl)}
            >
              Otwórz panel w przeglądarce
            </button>
            <code className="small">{panelUrl}</code>
          </div>
        ) : (
          <p className="hint">Podaj adres huba, żeby zobaczyć link do panelu.</p>
        )}

        <h3 className="subhead">Kolejność konfiguracji</h3>
        <ol className="steps">
          <li>W panelu huba utwórz agenta i skopiuj klucz API.</li>
          <li>Wklej klucz powyżej i zapisz.</li>
          <li>W panelu połącz konto Allegro (OAuth) i uzupełnij token BaseLinkera.</li>
          <li>Uruchom automatyczne pobranie mapowań SKU.</li>
          <li>Wróć tutaj i uruchom harmonogram.</li>
        </ol>
      </section>
    </form>
  )
}
