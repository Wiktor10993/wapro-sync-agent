/**
 * allegroOfferDetails.js — automapowanie ofert Allegro po kodach z pełnej oferty (v6.4).
 *
 * Lista `/sale/offers` nie zwraca parametrów oferty, a u wielu sprzedawców oferty
 * nie mają sygnatury (external.id). Indeks WAPRO bywa za to wpisany w parametr
 * „Kod producenta", a EAN w parametrze „EAN (GTIN)". Dociągamy je z
 * `GET /sale/product-offers/{id}` i trzymamy w cache SQLite (allegro_offer_details),
 * więc każdą ofertę czytamy raz (odświeżenie po DETAILS_MAX_AGE_MS).
 *
 * Budżet na cykl ogranicza liczbę odczytów — pełne pokrycie dużego konta
 * buduje się przez kilka cykli, bez blokowania wysyłki stanów.
 */

import { getBufferDb } from './bufferDb.js'
import * as allegroSync from './allegroSync.js'
import { extractOfferCodes, mergeOfferDetails } from './allegroSyncCore.js'

const DETAILS_BUDGET_PER_CYCLE = 3000
const DETAILS_MAX_AGE_MS = 30 * 86400_000

/**
 * Uzupełnia oferty o kody z pełnej oferty (EAN, sygnatura, kod producenta).
 * @param {string} accountId
 * @param {Array<{offerId:string, sku:string, ean:string, name:string}>} offers
 * @returns {Promise<Array<{offerId:string, sku:string, ean:string, name:string, codes:string[]}>>}
 */
export async function enrichOffers(accountId, offers, log = () => {}, { label = accountId, budget = DETAILS_BUDGET_PER_CYCLE } = {}) {
  const db = await getBufferDb()
  let cache = db.getOfferDetails(accountId)
  const now = Date.now()

  // Czytamy tylko oferty bez sygnatury — z sygnaturą dopasowanie po SKU już działa.
  const todo = offers
    .filter((o) => o.offerId && !o.sku)
    .filter((o) => {
      const c = cache.get(String(o.offerId))
      return !c || now - c.fetchedMs > DETAILS_MAX_AGE_MS
    })
    .map((o) => String(o.offerId))

  if (todo.length > 0) {
    const batch = todo.slice(0, budget)
    try {
      const full = await allegroSync.getOffersFull(accountId, batch, log)
      for (const [id, offer] of full) db.saveOfferDetails(accountId, id, offer ? extractOfferCodes(offer) : {})
      cache = db.getOfferDetails(accountId)
      const left = todo.length - full.size
      log(
        'info',
        `Allegro „${label}": automapowanie — odczytano kody (EAN / kod producenta) ${full.size} ofert` +
          (left > 0 ? `, pozostało ${left} (kolejne cykle).` : '.')
      )
    } catch (err) {
      log('warn', `Allegro „${label}": odczyt kodów ofert nieudany: ${err?.message ?? err}`)
    }
  }

  return mergeOfferDetails(offers, cache)
}
