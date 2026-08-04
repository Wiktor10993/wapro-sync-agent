import { getIntegrations } from '../store.js'
import { allegroApi, getValidAccessToken, interpretAllegroError } from './allegroAuth.js'
import { buildNameIndex, extractEanFromOffer, pickOfferId } from './allegroSyncCore.js'

// Re-eksport czystych helperów, żeby reszta kodu mogła je brać z tego modułu.
export { buildNameIndex, extractEanFromOffer, normalizeTitle, pickOfferId } from './allegroSyncCore.js'

/**
 * SYNCHRONIZACJA STANÓW WAPRO → ALLEGRO (bezpośrednio, bez BaseLinkera)
 * ====================================================================
 *
 * Wapro Mag jest jedynym źródłem prawdy dla stanów. Ten moduł:
 *   1) pobiera oferty sprzedawcy z Allegro (`GET /sale/offers`, stronicowane),
 *   2) buduje mapę kod → offerId, dopasowując po SYGNATURZE (external.id = SKU
 *      ustawiony przez sprzedawcę) oraz — gdy dostępny — po EAN/GTIN oferty,
 *   3) ustawia nowy stan oferty (`PATCH /sale/product-offers/{offerId}`
 *      z ciałem `{ stock: { available } }`).
 *
 * Token odświeżamy automatycznie przez `getValidAccessToken` (refresh_token),
 * więc harmonogram działa bez ręcznej reautoryzacji.
 */

const OFFERS_PAGE_LIMIT = 1000 // maksimum akceptowane przez /sale/offers
const OFFER_MAP_TTL_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Mapa ofert (z cache'em)
// ---------------------------------------------------------------------------

let _offerCache = { maps: null, at: 0 }

/** Wymusza przebudowę mapy ofert przy następnym użyciu. */
export function invalidateOfferMap() {
  _offerCache = { maps: null, at: 0 }
}

async function buildOfferMaps(sandbox, token, log) {
  const bySku = new Map()
  const byEan = new Map()
  const collected = [] // {id, name} do indeksu po tytule (potrzebuje całości)
  let offset = 0
  let total = null

  // Zabezpieczenie przed pętlą — 200 stron × 1000 = 200k ofert.
  for (let page = 0; page < 200; page++) {
    const data = await allegroApi(sandbox, token, `/sale/offers?limit=${OFFERS_PAGE_LIMIT}&offset=${offset}`)
    const offers = data?.offers ?? []
    if (total == null) total = Number(data?.totalCount ?? data?.count ?? 0) || null

    if (offers.length === 0) break

    for (const o of offers) {
      const id = String(o?.id ?? '')
      if (!id) continue
      const sku = String(o?.external?.id ?? '').trim()
      const ean = extractEanFromOffer(o)
      if (sku && !bySku.has(sku)) bySku.set(sku, id)
      if (ean && !byEan.has(ean)) byEan.set(ean, id)
      collected.push({ id, name: o?.name ?? '' })
    }

    offset += offers.length
    if (offers.length < OFFERS_PAGE_LIMIT) break
    if (total != null && offset >= total) break
  }

  // Indeks po tytule budujemy z całości (wykrycie niejednoznacznych tytułów).
  const byName = buildNameIndex(collected)

  console.log(
    `[Allegro] Zbudowano mapę ofert: ${bySku.size} po SKU, ${byEan.size} po EAN, ${byName.size} po unikalnym tytule (z ${collected.length} ofert).`
  )
  return { bySku, byEan, byName }
}

async function getOfferMaps(sandbox, token, log, { force = false } = {}) {
  const fresh = _offerCache.maps && Date.now() - _offerCache.at < OFFER_MAP_TTL_MS
  if (fresh && !force) return _offerCache.maps
  const maps = await buildOfferMaps(sandbox, token, log)
  _offerCache = { maps, at: Date.now() }
  return maps
}

// ---------------------------------------------------------------------------
// Aktualizacja stanu oferty
// ---------------------------------------------------------------------------

/**
 * Ustawia stan pojedynczej oferty.
 * `PATCH /sale/product-offers/{offerId}` z ciałem `{ stock: { available } }`.
 */
async function setOfferStock(sandbox, token, offerId, quantity) {
  const available = Math.max(0, Math.trunc(Number(quantity) || 0))
  return allegroApi(sandbox, token, `/sale/product-offers/${encodeURIComponent(offerId)}`, {
    method: 'PATCH',
    body: { stock: { available } }
  })
}

/** Etykieta klucza dopasowania do logów. */
const VIA_LABEL = { ean: 'EAN', sku: 'SKU', title: 'Tytuł' }

/**
 * Aktualizuje stany ofert na podstawie pozycji z Wapro. Dopasowanie
 * wielopoziomowe: EAN → SKU → Tytuł (patrz pickOfferId).
 *
 * Zwraca kształt zgodny z BaseLinkerowym updaterem: pole `unmapped` zawiera
 * kody NIEZAKTUALIZOWANE (bez dopasowania LUB z błędem wysyłki), żeby warstwa
 * synchronizacji nie zapisała ich hasha i ponowiła w kolejnym cyklu.
 *
 * @param {Array<{sku:string, barcode?:string, name?:string, quantity:number}>} rows
 * @returns {Promise<{updated:number, unmapped:string[], viaEan:number, viaSku:number, viaTitle:number, failed:number}>}
 */
export async function updateOfferStockByCode(rows, log = () => {}) {
  if (!rows?.length) return { updated: 0, unmapped: [], viaEan: 0, viaSku: 0, viaTitle: 0, failed: 0 }

  const token = await getValidAccessToken(log)
  const { allegro } = getIntegrations()
  const sandbox = Boolean(allegro.sandbox)

  const asItem = (r) => ({ sku: r.sku, barcode: r.barcode, name: r.name })
  const label = (r) => String(r.sku || r.barcode || r.name || '?')

  let maps = await getOfferMaps(sandbox, token, log)

  // Pierwsze rozwiązanie; gdy część pozycji nie trafia, odświeżamy mapę raz.
  const resolve = () => rows.map((r) => ({ code: label(r), quantity: r.quantity, hit: pickOfferId(maps, asItem(r)) }))
  let resolved = resolve()
  if (resolved.some((r) => !r.hit)) {
    maps = await getOfferMaps(sandbox, token, log, { force: true })
    resolved = resolve()
  }

  const notUpdated = []
  const viaCount = { ean: 0, sku: 0, title: 0 }
  let updated = 0
  let failed = 0

  for (const r of resolved) {
    if (!r.hit) {
      notUpdated.push(r.code)
      continue
    }
    try {
      await setOfferStock(sandbox, token, r.hit.offerId, r.quantity)
      updated++
      viaCount[r.hit.via] = (viaCount[r.hit.via] || 0) + 1
      console.log(
        `[Allegro] → stock offer ${r.hit.offerId} (kod ${r.code}, klucz ${VIA_LABEL[r.hit.via]}) = ${Math.max(0, Math.trunc(Number(r.quantity) || 0))}`
      )
    } catch (err) {
      failed++
      notUpdated.push(r.code)
      log('warn', `Allegro: oferta ${r.hit.offerId} (kod ${r.code}) — ${interpretAllegroError(err)}`)
    }
  }

  // Zbiorczy log z rozbiciem po kluczu dopasowania.
  if (updated > 0) {
    log(
      'success',
      `Allegro: zaktualizowano ${updated} ofert (EAN: ${viaCount.ean}, SKU: ${viaCount.sku}, Tytuł: ${viaCount.title}).`
    )
  }
  const unmappedCount = notUpdated.length - failed
  if (unmappedCount > 0) {
    const sample = notUpdated.slice(0, 5).join(', ')
    log('warn', `Allegro: ${unmappedCount} pozycji bez oferty (ani EAN, ani SKU, ani tytuł; np. ${sample}).`)
  }

  return {
    updated,
    unmapped: notUpdated,
    viaEan: viaCount.ean,
    viaSku: viaCount.sku,
    viaTitle: viaCount.title,
    failed
  }
}
