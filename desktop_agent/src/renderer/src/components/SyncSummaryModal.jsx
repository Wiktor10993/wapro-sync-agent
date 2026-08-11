import { useState } from 'react'

/**
 * Modal podsumowania synchronizacji (renderer-local JSX — bez importów z sync-engine,
 * żeby Vite nie próbował optymalizować modułów Node w przeglądarce).
 */
export default function SyncSummaryModal({ summary, onClose, onResolveItem }) {
  const [showReview, setShowReview] = useState(false)
  if (!summary) return null

  const durationMs = new Date(summary.finishedAt).getTime() - new Date(summary.startedAt).getTime()
  const durationS = Math.max(0, Math.round(durationMs / 100) / 10)

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card card" onClick={(e) => e.stopPropagation()}>
        <div className="card__header">
          <h2>Podsumowanie synchronizacji — {channelLabel(summary.channel)}</h2>
          <button type="button" className="btn btn--tiny" onClick={onClose} aria-label="Zamknij">×</button>
        </div>

        <div className="summary-grid">
          <Stat label="Sprawdzono" value={summary.checked} tone="muted" />
          <Stat label="Zmieniono stany" value={summary.changed} tone="ok" />
          <Stat label="Wymaga weryfikacji" value={summary.needsReview} tone={summary.needsReview ? 'warn' : 'muted'} />
          <Stat label="Pominięto" value={summary.skipped} tone="muted" />
          <Stat label="Błędy" value={summary.errors} tone={summary.errors ? 'error' : 'muted'} />
        </div>

        <p className="hint">Czas cyklu: {durationS}s. Kierunek: Wapro → {channelLabel(summary.channel)}.</p>

        {summary.needsReview > 0 && (
          <div className="result result--warn">
            <p>
              <strong>{summary.needsReview}</strong> pozycji nie wysłano automatycznie —
              dopasowanie było niepewne. Zweryfikuj je ręcznie w zakładce „Problemy".
            </p>
            <div className="button-row">
              <button type="button" className="btn" onClick={() => setShowReview((v) => !v)}>
                {showReview ? 'Ukryj listę' : `Pokaż listę (${(summary.reviewItems || []).length})`}
              </button>
            </div>
          </div>
        )}

        {showReview && (summary.reviewItems || []).length > 0 && (
          <div className="review-list">
            <table className="minitable minitable--full">
              <thead>
                <tr><th>SKU</th><th>EAN</th><th>Nazwa</th><th className="num">Stan</th><th>Powód</th><th></th></tr>
              </thead>
              <tbody>
                {summary.reviewItems.map((it, i) => (
                  <tr key={`${it.sku}-${i}`}>
                    <td><code>{it.sku || '—'}</code></td>
                    <td><code>{it.ean || '—'}</code></td>
                    <td>{it.name}</td>
                    <td className="num">{it.quantity}</td>
                    <td className="small">{it.reason}</td>
                    <td>
                      {onResolveItem && (
                        <button type="button" className="btn btn--tiny" onClick={() => onResolveItem(it)}>Popraw</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="button-row">
          <button type="button" className="btn btn--primary" onClick={onClose}>Zamknij</button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }) {
  return (
    <div className={`summary-stat summary-stat--${tone}`}>
      <div className="summary-stat__value">{value}</div>
      <div className="summary-stat__label">{label}</div>
    </div>
  )
}

function channelLabel(channel) {
  return channel === 'baselinker' ? 'BaseLinker' : channel === 'allegro' ? 'Allegro' : channel
}
