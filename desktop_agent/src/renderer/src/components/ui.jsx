/**
 * Wspólne, bezstanowe elementy interfejsu.
 * Wydzielone z App.jsx, żeby komponenty zakładek pozostały czytelne.
 */

export function Field({ label, hint, error, children }) {
  return (
    <div className={`field ${error ? 'field--error' : ''}`}>
      <label className="field__label">{label}</label>
      {children}
      {hint && !error && <span className="field__hint">{hint}</span>}
      {error && <span className="field__error">{error}</span>}
    </div>
  )
}

export function Row({ label, children }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

export function Badge({ ok, children }) {
  return <span className={`badge ${ok ? 'badge--ok' : 'badge--off'}`}>{children}</span>
}

export function Tag({ tone = 'muted', children }) {
  return <span className={`tag tag--${tone}`}>{children}</span>
}

export function StatusPill({ running }) {
  return (
    <div className={`pill ${running ? 'pill--on' : 'pill--off'}`}>
      <span className="pill__dot" />
      {running ? 'Synchronizacja aktywna' : 'Zatrzymana'}
    </div>
  )
}

export function Checkbox({ checked, onChange, children }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={!!checked} onChange={onChange} />
      {children}
    </label>
  )
}

export function Empty({ children }) {
  return <p className="empty-state">{children}</p>
}

export function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('pl-PL')
  } catch {
    return String(iso)
  }
}

export function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('pl-PL')
  } catch {
    return ''
  }
}

export function formatMoney(value, currency = 'PLN') {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(2)} ${currency}`
}
