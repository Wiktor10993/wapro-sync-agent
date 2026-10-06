import { randomUUID } from 'node:crypto'
import { getAllegroAccount, listAllegroAccountsPublic } from '../store.js'
import { allegroApi, getValidAccessToken, interpretAllegroError } from './allegroAuth.js'
import { buildNameIndex, extractEanFromOffer, pickOfferId } from './allegroSyncCore.js'

// Re-eksport czystych helperów, żeby reszta kodu mogła je brać z tego modułu.
export { buildNameIndex, extractEanFromOffer, normalizeTitle, pickOfferId } from './allegroSyncCore.js'

/**
 * SYNCHRONIZACJA STANÓW WAPRO → ALLEGRO (bezpośrednio, bez BaseLinkera)
 * ====================================================================
 *
 * Wapro Mag jest jedynym źródłem prawdy dla stanów. Obsługujemy WIELE kont
 * Allegro (ta sama aplikacja, osobne autoryzacje) — każda funkcja przyjmuje
 * `accountId` (domyślnie 'primary' = konto główne). Token i sandbox rozwiązujemy
 * per konto; mapa ofert jest cache'owana osobno dla każdego konta.
 */

const OFFERS_PAGE_LIMIT = 1000 // maksimum akceptowane przez /sale/offers
const OFFER_MAP_TTL_MS = 5 * 60 * 1000

// Throttling wysyłki: Allegro nie przyjmuje setek PATCH-y na sekundę bez limitu.
const OFFER_PUSH_BATCH = 40 // co ile ofert robimy pauzę
const OFFER_PUSH_DELAY_MS = 300 // pauza między paczkami (ms)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Oddaje wątek zdarzeń — długa pętla nie zamraża UI procesu głównego. */
const yieldToEventLoop = () => new Promise((r) => setImmediate(r))

/** Token + sandbox dla danego konta. */
async function resolveCtx(accountId, log) {
  const token = await getValidAccessToken(accountId, log)
  const sandbox = Boolean(getAllegroAccount(accountId)?.sandbox)
  return { token, sandbox }
}

/** Czy błąd oznacza „oferty już nie ma" (zakończona/zarchiwizowana/404). */
function isOfferGone(err) {
  const e = err || {}
  if (e.status === 404) return true
  if (/NOT_FOUND|OFFER_ENDED|ARCHIV|ENDED/i.test(String(e.code ?? ''))) return true
  return /nie znaleziono oferty|offer not found|zakończ|zakoncz|zarchiwiz|archiv|ended|no such offer|not found/i.test(
    String(e.message ?? '')
  )
}

// ---------------------------------------------------------------------------
// Mapa ofert (z cache'em per konto)
// ---------------------------------------------------------------------------

/** @type {Map<string, {maps:any, at:number}>} cache map ofert per accountId */
const _offerCache = new Map()

/** Wymusza przebudowę mapy ofert (dla konta albo wszystkich). */
export function invalidateOfferMap(accountId = null) {
  if (accountId) _offerCache.delete(accountId)
  else _offerCache.clear()
}

async function buildOfferMaps(sandbox, token) {
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

  const byName = buildNameIndex(collected)
  console.log(
    `[Allegro] Zbudowano mapę ofert: ${bySku.size} po SKU, ${byEan.size} po EAN, ${byName.size} po unikalnym tytule (z ${collected.length} ofert).`
  )
  return { bySku, byEan, byName }
}

async function getOfferMaps(accountId, sandbox, token, { force = false } = {}) {
  const cached = _offerCache.get(accountId)
  const fresh = cached?.maps && Date.now() - cached.at < OFFER_MAP_TTL_MS
  if (fresh && !force) return cached.maps
  const maps = await buildOfferMaps(sandbox, token)
  _offerCache.set(accountId, { maps, at: Date.now() })
  return maps
}

// ---------------------------------------------------------------------------
// Aktualizacja stanu oferty
// ---------------------------------------------------------------------------

/** `PATCH /sale/product-offers/{offerId}` z ciałem `{ stock: { available } }`. */
async function setOfferStock(sandbox, token, offerId, quantity) {
  const available = Math.max(0, Math.trunc(Number(quantity) || 0))
  return allegroApi(sandbox, token, `/sale/product-offers/${encodeURIComponent(offerId)}`, {
    method: 'PATCH',
    body: { stock: { available } }
  })
}

/** Zmiana statusu publikacji (END/ACTIVATE) przez idempotentny command (UUID). */
async function setOfferPublication(sandbox, token, offerId, action) {
  const commandId = randomUUID()
  return allegroApi(sandbox, token, `/sale/offer-publication-commands/${commandId}`, {
    method: 'PUT',
    body: {
      publication: { action },
      offerCriteria: [{ offers: [{ id: String(offerId) }], type: 'CONTAINS_OFFERS' }]
    }
  })
}

/** Kończy ofertę (stan ≤ 0). Rzuca błędem przy niepowodzeniu. */
export async function endOffer(accountId, offerId, log = () => {}) {
  const { token, sandbox } = await resolveCtx(accountId, log)
  await setOfferPublication(sandbox, token, offerId, 'END')
  log('info', `Allegro[${accountId}]: zakończono ofertę ${offerId} (stan ≤ 0).`)
}

/** Wznawia zakończoną ofertę. true = sukces; false = nie da się (needs_relist). */
export async function activateOffer(accountId, offerId, log = () => {}) {
  const { token, sandbox } = await resolveCtx(accountId, log)
  try {
    await setOfferPublication(sandbox, token, offerId, 'ACTIVATE')
    log('info', `Allegro[${accountId}]: wznowiono ofertę ${offerId} (towar wrócił).`)
    return true
  } catch (err) {
    if (isOfferGone(err)) {
      log('warn', `Allegro[${accountId}]: oferty ${offerId} nie można wznowić (wygasła/usunięta) — wymaga ponownego wystawienia.`)
      return false
    }
    throw err
  }
}

/** Surowa lista ofert (offerId/sku/ean/name) — dla silnika. */
export async function listOffers(accountId = 'primary', log = () => {}) {
  const { token, sandbox } = await resolveCtx(accountId, log)
  const out = []
  let offset = 0
  let total = null
  for (let page = 0; page < 200; page++) {
    const data = await allegroApi(sandbox, token, `/sale/offers?limit=${OFFERS_PAGE_LIMIT}&offset=${offset}`)
    const offers = data?.offers ?? []
    if (total == null) total = Number(data?.totalCount ?? data?.count ?? 0) || null
    if (offers.length === 0) break
    for (const o of offers) {
      out.push({
        offerId: String(o?.id ?? ''),
        sku: String(o?.external?.id ?? '').trim(),
        ean: extractEanFromOffer(o),
        name: String(o?.name ?? '')
      })
    }
    offset += offers.length
    if (offers.length < OFFERS_PAGE_LIMIT) break
    if (total != null && offset >= total) break
  }
  return out
}

/** Lista ofert wraz ze stanem — do eksportu CSV i raportu. */
export async function listOffersWithStock(accountId = 'primary', log = () => {}) {
  const { token, sandbox } = await resolveCtx(accountId, log)
  const out = []
  let offset = 0
  let total = null
  for (let page = 0; page < 200; page++) {
    const data = await allegroApi(sandbox, token, `/sale/offers?limit=${OFFERS_PAGE_LIMIT}&offset=${offset}`)
    const offers = data?.offers ?? []
    if (total == null) total = Number(data?.totalCount ?? data?.count ?? 0) || null
    if (offers.length === 0) break
    for (const o of offers) {
      out.push({
        offerId: String(o?.id ?? ''),
        sku: String(o?.external?.id ?? '').trim(),
        ean: extractEanFromOffer(o),
        name: String(o?.name ?? ''),
        quantity: Number(o?.stock?.available ?? o?.stock?.sold ?? 0) || 0,
        status: String(o?.publication?.status ?? o?.sellingMode?.format ?? '')
      })
    }
    offset += offers.length
    if (offers.length < OFFERS_PAGE_LIMIT) break
    if (total != null && offset >= total) break
  }
  return out
}

/** Oferty ze stanem ze WSZYSTKICH autoryzowanych kont (eksport/raport). */
export async function listOffersWithStockAll(log = () => {}) {
  const accounts = listAllegroAccountsPublic().filter((a) => a.authorized)
  const out = []
  for (const a of accounts) {
    try {
      const offers = await listOffersWithStock(a.id, log)
      for (const o of offers) out.push({ ...o, accountId: a.id, accountLabel: a.label })
    } catch (err) {
      log('warn', `Allegro[${a.id}]: pobranie ofert nieudane: ${err.message}`)
    }
  }
  return out
}

/** Ustawia stan JEDNEJ oferty i RZUCA surowym błędem (dla Action Center). */
export async function setSingleOfferStock(accountId, offerId, quantity, log = () => {}) {
  const { token, sandbox } = await resolveCtx(accountId, log)
  await setOfferStock(sandbox, token, offerId, quantity)
}

/** Ustawia stan wskazanych ofert. Zwraca zbiór zaktualizowanych offerId. */
export async function setOffersStock(accountId, items, log = () => {}) {
  const { token, sandbox } = await resolveCtx(accountId, log)
  const list = items ?? []
  const updated = new Set()
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    try {
      await setOfferStock(sandbox, token, it.offerId, it.quantity)
      updated.add(String(it.offerId))
    } catch (err) {
      log('warn', `Allegro[${accountId}]: oferta ${it.offerId} — ${interpretAllegroError(err)}`)
    }
    if ((i + 1) % OFFER_PUSH_BATCH === 0 && i + 1 < list.length) {
      await sleep(OFFER_PUSH_DELAY_MS)
      await yieldToEventLoop()
    }
  }
  return updated
}

/** Etykieta klucza dopasowania do logów. */
const VIA_LABEL = { ean: 'EAN', sku: 'SKU', title: 'Tytuł' }

/**
 * Aktualizuje stany ofert konta na podstawie pozycji z Wapro (EAN → SKU → Tytuł).
 * @returns {Promise<{updated:number, unmapped:string[], viaEan:number, viaSku:number, viaTitle:number, failed:number}>}
 */
export async function updateOfferStockByCode(accountId, rows, log = () => {}) {
  if (!rows?.length) return { updated: 0, unmapped: [], viaEan: 0, viaSku: 0, viaTitle: 0, failed: 0 }

  const { token, sandbox } = await resolveCtx(accountId, log)

  const asItem = (r) => ({ sku: r.sku, barcode: r.barcode, name: r.name })
  const label = (r) => String(r.sku || r.barcode || r.name || '?')

  let maps = await getOfferMaps(accountId, sandbox, token)

  const resolve = () => rows.map((r) => ({ code: label(r), quantity: r.quantity, hit: pickOfferId(maps, asItem(r)) }))
  let resolved = resolve()
  if (resolved.some((r) => !r.hit)) {
    maps = await getOfferMaps(accountId, sandbox, token, { force: true })
    resolved = resolve()
  }

  const notUpdated = []
  const viaCount = { ean: 0, sku: 0, title: 0 }
  let updated = 0
  let failed = 0
  let archivedZero = 0

  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i]
    if (!r.hit) {
      notUpdated.push(r.code)
      continue
    }
    try {
      await setOfferStock(sandbox, token, r.hit.offerId, r.quantity)
      updated++
      viaCount[r.hit.via] = (viaCount[r.hit.via] || 0) + 1
    } catch (err) {
      if (Number(r.quantity) === 0 && isOfferGone(err)) {
        archivedZero++
        log('info', `Allegro[${accountId}]: ${r.code} — oferta wycofana, stan 0 → pomijam (Archiwum).`)
      } else {
        failed++
        notUpdated.push(r.code)
        log('warn', `Allegro[${accountId}]: oferta ${r.hit.offerId} (kod ${r.code}) — ${interpretAllegroError(err)}`)
      }
    }
    if ((i + 1) % OFFER_PUSH_BATCH === 0 && i + 1 < resolved.length) {
      await sleep(OFFER_PUSH_DELAY_MS)
      await yieldToEventLoop()
    }
  }

  if (updated > 0) {
    log('success', `Allegro[${accountId}]: zaktualizowano ${updated} ofert (EAN: ${viaCount.ean}, SKU: ${viaCount.sku}, Tytuł: ${viaCount.title}).`)
  }
  if (archivedZero > 0) {
    log('info', `Allegro[${accountId}]: ${archivedZero} pozycji „0 na stanie (Archiwum)" — pominięto.`)
  }
  const unmappedCount = notUpdated.length - failed
  if (unmappedCount > 0) {
    const sample = notUpdated.slice(0, 5).join(', ')
    log('warn', `Allegro[${accountId}]: ${unmappedCount} pozycji bez oferty (np. ${sample}).`)
  }

  return { updated, unmapped: notUpdated, viaEan: viaCount.ean, viaSku: viaCount.sku, viaTitle: viaCount.title, failed }
}
