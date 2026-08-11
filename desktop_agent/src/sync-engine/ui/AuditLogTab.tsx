/**
 * Zakładka Dziennika Operacji (PUNKT 3).
 * Wyszukiwanie i filtrowanie po kanale, kierunku, statusie, dacie i frazie
 * (SKU/EAN/offerId/message), z paginacją. Odpięta od IPC — dostaje `queryLogs`
 * jako prop, więc łatwo ją podłączyć i testować.
 */

import { useCallback, useEffect, useState } from 'react'
import type { SyncLogEntry, SyncChannel, SyncDirection, SyncEntryStatus } from '../types'

export interface LogFilterUI {
  channel?: SyncChannel
  direction?: SyncDirection
  status?: SyncEntryStatus
  search?: string
  dateFrom?: string
  dateTo?: string
  limit: number
  offset: number
}

export interface AuditLogTabProps {
  queryLogs: (filter: LogFilterUI) => Promise<{ rows: SyncLogEntry[]; total: number }>
  pageSize?: number
}

const STATUS_TONE: Record<SyncEntryStatus, string> = {
  SUCCESS: 'tag--ok',
  SKIPPED: 'tag--warn',
  ERROR: 'tag--error'
}

export default function AuditLogTab({ queryLogs, pageSize = 100 }: AuditLogTabProps) {
  const [filter, setFilter] = useState<LogFilterUI>({ limit: pageSize, offset: 0 })
  const [rows, setRows] = useState<SyncLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (f: LogFilterUI) => {
    setLoading(true)
    setError(null)
    try {
      const res = await queryLogs(f)
      setRows(res.rows)
      setTotal(res.total)
    } catch (e) {
      setError((e as Error)?.message ?? 'Błąd odczytu dziennika.')
    } finally {
      setLoading(false)
    }
  }, [queryLogs])

  useEffect(() => {
    load(filter)
  }, [load, filter])

  const set = <K extends keyof LogFilterUI>(key: K, value: LogFilterUI[K]) =>
    setFilter((f) => ({ ...f, [key]: value, offset: key === 'offset' ? (value as number) : 0 }))

  const page = Math.floor(filter.offset / filter.limit) + 1
  const pages = Math.max(1, Math.ceil(total / filter.limit))

  return (
    <div className="grid">
      <section className="card card--wide">
        <div className="card__header">
          <h2>Dziennik synchronizacji (INTEG_LOG_SYNC)</h2>
          <button type="button" className="btn btn--tiny" onClick={() => load(filter)} disabled={loading}>
            {loading ? 'Wczytuję…' : 'Odśwież'}
          </button>
        </div>

        <div className="field-row">
          <label>
            Szukaj (SKU / EAN / oferta / opis)
            <input
              value={filter.search ?? ''}
              onChange={(e) => set('search', e.target.value || undefined)}
              placeholder="np. 5904619771106"
            />
          </label>
          <label>
            Kanał
            <select value={filter.channel ?? ''} onChange={(e) => set('channel', (e.target.value || undefined) as SyncChannel)}>
              <option value="">wszystkie</option>
              <option value="baselinker">BaseLinker</option>
              <option value="allegro">Allegro</option>
            </select>
          </label>
          <label>
            Status
            <select value={filter.status ?? ''} onChange={(e) => set('status', (e.target.value || undefined) as SyncEntryStatus)}>
              <option value="">wszystkie</option>
              <option value="SUCCESS">SUCCESS</option>
              <option value="SKIPPED">SKIPPED</option>
              <option value="ERROR">ERROR</option>
            </select>
          </label>
        </div>

        <div className="field-row">
          <label>Od<input type="date" value={filter.dateFrom ?? ''} onChange={(e) => set('dateFrom', e.target.value || undefined)} /></label>
          <label>Do<input type="date" value={filter.dateTo ?? ''} onChange={(e) => set('dateTo', e.target.value || undefined)} /></label>
        </div>

        {error && <div className="result result--warn">{error}</div>}

        <table className="minitable minitable--full">
          <thead>
            <tr>
              <th>Czas</th><th>Kanał</th><th>SKU</th><th>EAN</th><th>Oferta</th>
              <th className="num">Przed</th><th className="num">Po</th><th>Status</th><th>Opis</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={9} className="empty-state">Brak wpisów dla tych filtrów.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small">{new Date(r.ts).toLocaleString('pl-PL')}</td>
                <td className="small">{r.channel}</td>
                <td><code>{r.sku || '—'}</code></td>
                <td><code>{r.ean || '—'}</code></td>
                <td className="small">{r.offerId || '—'}</td>
                <td className="num">{r.qtyBefore ?? '—'}</td>
                <td className="num">{r.qtyAfter ?? '—'}</td>
                <td><span className={`tag ${STATUS_TONE[r.status]}`}>{r.status}</span></td>
                <td className="small">{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="button-row">
          <button type="button" className="btn" disabled={page <= 1 || loading} onClick={() => set('offset', Math.max(0, filter.offset - filter.limit))}>
            ← Poprzednia
          </button>
          <span className="hint">Strona {page} z {pages} ({total} wpisów)</span>
          <button type="button" className="btn" disabled={page >= pages || loading} onClick={() => set('offset', filter.offset + filter.limit)}>
            Następna →
          </button>
        </div>
      </section>
    </div>
  )
}
