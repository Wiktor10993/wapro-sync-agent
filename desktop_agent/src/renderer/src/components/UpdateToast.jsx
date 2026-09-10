import { useEffect, useState } from 'react'

/**
 * Toast aktualizacji (OTA). Nasłuchuje zdarzeń z main (evt:update) i pokazuje
 * stan: sprawdzanie / dostępna / pobieranie / gotowa. Instalacja tylko na klik.
 */
export default function UpdateToast() {
  const [st, setSt] = useState(null)

  useEffect(() => {
    const off = window.agent.onUpdate((payload) => setSt(payload))
    return off
  }, [])

  if (!st || st.state === 'none' || st.state === 'checking') return null

  let text = null
  let action = null
  if (st.state === 'available') text = `Dostępna aktualizacja v${st.version} — pobieram w tle…`
  else if (st.state === 'downloading') text = `Pobieranie aktualizacji… ${st.percent ?? 0}%`
  else if (st.state === 'ready') {
    text = `Aktualizacja v${st.version} gotowa.`
    action = (
      <button type="button" className="btn btn--primary btn--small" onClick={() => window.agent.updateInstall()}>
        Zainstaluj i uruchom ponownie
      </button>
    )
  } else if (st.state === 'error') text = `Aktualizacja: błąd (${st.message ?? 'nieznany'}).`

  if (!text) return null

  return (
    <div className="update-toast" role="status">
      <span>{text}</span>
      {action}
      <button type="button" className="update-toast__close" onClick={() => setSt(null)} aria-label="Zamknij">×</button>
    </div>
  )
}
