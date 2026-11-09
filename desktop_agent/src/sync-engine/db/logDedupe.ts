/**
 * Tłumienie powtarzających się wpisów dziennika (INTEG_LOG_SYNC).
 *
 * Pozycje bez dopasowania / do weryfikacji nie zatwierdzają hasha, więc wracają
 * w KAŻDYM cyklu — bez tłumienia każdy cykl dopisywał tysiące identycznych
 * wierszy „Brak dopasowania" i tabela rosła bez końca (a odczyt w zakładce
 * Dziennik kończył się timeoutem 60 s).
 *
 * Wpis SKIPPED o tym samym (kanał, SKU, oferta, komunikat, stan po) zapisujemy
 * najwyżej raz na `windowMs`. SUCCESS i ERROR przechodzą zawsze.
 */

import type { SyncLogEntry } from '../types'

export interface LogDeduper {
  filter(entries: SyncLogEntry[]): SyncLogEntry[]
  /** Liczba zapamiętanych kluczy (diagnostyka/testy). */
  size(): number
}

export function createLogDeduper(
  { windowMs = 24 * 3600_000, maxKeys = 200_000, now = () => Date.now() }: { windowMs?: number; maxKeys?: number; now?: () => number } = {}
): LogDeduper {
  const seen = new Map<string, number>()

  const prune = (t: number) => {
    for (const [k, at] of seen) if (t - at >= windowMs) seen.delete(k)
    // Twardy limit pamięci — usuwamy najstarsze (Map zachowuje kolejność wstawiania).
    while (seen.size > maxKeys) {
      const first = seen.keys().next().value
      if (first === undefined) break
      seen.delete(first)
    }
  }

  return {
    filter(entries) {
      const t = now()
      const out: SyncLogEntry[] = []
      for (const e of entries) {
        if (e.status !== 'SKIPPED') {
          out.push(e)
          continue
        }
        const key = [e.channel, e.direction, e.sku ?? '', e.offerId ?? '', e.qtyAfter ?? '', e.message ?? ''].join('\u0001')
        const at = seen.get(key)
        if (at !== undefined && t - at < windowMs) continue
        seen.delete(key)
        seen.set(key, t)
        out.push(e)
      }
      if (seen.size > maxKeys) prune(t)
      return out
    },
    size: () => seen.size
  }
}
