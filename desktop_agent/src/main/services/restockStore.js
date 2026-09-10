/**
 * restockStore.js — trwała „pamięć wznowień" ofert (#2).
 *
 * Gdy WAPRO ma stan ≤ 0, kończymy ofertę Allegro (END) i zapisujemy ją tutaj.
 * W kolejnych cyklach, gdy towar wróci (>0), oferta jest wznawiana (ACTIVATE),
 * a wpis usuwany. Jeśli wznowienie się nie uda (oferta wygasła/usunięta),
 * oznaczamy pozycję jako `needs_relist` w kolejce błędów (Action Center).
 *
 * Używa tego samego pliku SQLite co Action Center (userData/sync-buffer.db).
 * better-sqlite3 w trybie WAL obsługuje kilka połączeń w obrębie procesu, więc
 * własny, leniwy uchwyt jest bezpieczny i nie koliduje z orchestratorem.
 */

import { getBufferDb as getDb } from './bufferDb.js'

/** Dodaje ofertę na listę obserwacji do wznowienia. */
export async function watchRestock(w) {
  ;(await getDb()).watchRestock(w)
}

/** Lista ofert oczekujących na wznowienie. */
export async function listRestock() {
  return (await getDb()).listRestock()
}

/** Usuwa z obserwacji po pomyślnym wznowieniu. */
export async function clearRestock(channel, offerId) {
  ;(await getDb()).clearRestock(channel, offerId)
}

/** Czy oferta jest obecnie „zakończona i obserwowana". */
export async function isWatched(channel, offerId) {
  return (await getDb()).isWatched(channel, offerId)
}

/**
 * Oferta wróciła na stan, ale nie da się jej automatycznie wznowić — do kolejki
 * błędów jako `needs_relist` (operator wystawia ponownie). Zdejmujemy też z
 * obserwacji, bo ponawianie ACTIVATE nic nie da.
 */
export async function flagNeedsRelist({ channel, offerId, sku = '', ean = '', quantity = 0 }) {
  const db = await getDb()
  db.enqueueError({
    channel,
    sku,
    ean,
    offerId,
    direction: 'WAPRO->CHANNEL',
    targetQuantity: Math.max(0, Math.trunc(Number(quantity) || 0)),
    errorCode: 'NEEDS_RELIST',
    errorMessage: 'Towar wrócił na stan, ale zakończonej oferty nie można wznowić (wygasła/usunięta). Wystaw ponownie.',
    category: 'needs_relist'
  })
  db.clearRestock(channel, offerId)
}
