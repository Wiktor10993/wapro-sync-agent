/**
 * Czyste funkcje pomocnicze synchronizacji z Allegro.
 *
 * Bez zależności od Electrona ani sieci — dzięki temu są w pełni testowalne
 * jednostkowo i współdzielone przez moduł `allegroSync.js`.
 */

/**
 * Wyłuskuje EAN/GTIN z obiektu oferty z listy `/sale/offers`. Lista bywa
 * skąpa — próbujemy kilku znanych miejsc, a gdy nic nie ma, zwracamy ''.
 */
export function extractEanFromOffer(offer) {
  if (!offer || typeof offer !== 'object') return ''
  const candidates = [
    offer.ean,
    offer.gtin,
    offer.product?.ean,
    offer.product?.gtin,
    ...(Array.isArray(offer.productSet)
      ? offer.productSet.map((p) => p?.product?.ean ?? p?.product?.gtin)
      : [])
  ]
  for (const c of candidates) {
    const v = String(c ?? '').trim()
    if (v) return v
  }
  return ''
}

/**
 * Normalizuje tytuł/nazwę do porównań: bez polskich znaków, małe litery,
 * bez interpunkcji, pojedyncze spacje. Dzięki temu „Kubek CZERWONY, 300ml"
 * i „kubek czerwony 300 ml" trafiają na ten sam klucz.
 */
export function normalizeTitle(s) {
  return String(s ?? '')
    .replace(/ł/gi, 'l') // 'ł' nie rozkłada się przez NFD — zamieniamy ręcznie
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // usuń pozostałe diakrytyki (ą, ę, ś, ć…)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Buduje indeks tytuł→offerId z listy ofert. Tytuły NIEJEDNOZNACZNE (ten sam
 * znormalizowany tytuł wskazuje na >1 ofertę) są POMIJANE — lepiej nie
 * zaktualizować stanu, niż trafić w złą ofertę.
 *
 * @param {Array<{id:string|number, name?:string}>} offers
 * @returns {Map<string,string>}
 */
export function buildNameIndex(offers = []) {
  const byName = new Map()
  const ambiguous = new Set()

  for (const o of offers) {
    const id = String(o?.id ?? '')
    const key = normalizeTitle(o?.name)
    if (!id || !key) continue

    if (ambiguous.has(key)) continue
    if (byName.has(key)) {
      if (byName.get(key) !== id) {
        // Kolizja tytułu — usuwamy z indeksu i oznaczamy jako niejednoznaczny.
        byName.delete(key)
        ambiguous.add(key)
      }
    } else {
      byName.set(key, id)
    }
  }
  return byName
}

/**
 * Ustala offerId dla pozycji z Wapro strategią wielopoziomową (fallback):
 *   1) EAN   — kod kreskowy (a pomocniczo indeks, bo bywa nim EAN),
 *   2) SKU   — indeks katalogowy/handlowy (a pomocniczo kod kreskowy),
 *   3) Tytuł — znormalizowana nazwa == znormalizowany tytuł oferty.
 *
 * @param {{bySku:Map, byEan:Map, byName:Map}} maps
 * @param {string|{sku?:string, barcode?:string, name?:string}} item
 *        string traktujemy jako sam kod (sku).
 * @returns {{offerId:string, via:'ean'|'sku'|'title'}|null}
 */
export function pickOfferId(maps, item) {
  const it = typeof item === 'string' ? { sku: item } : item || {}
  const sku = it.sku != null ? String(it.sku).trim() : ''
  const barcode = it.barcode != null ? String(it.barcode).trim() : ''
  const name = it.name != null ? String(it.name) : ''

  // 1. EAN — najpierw kod kreskowy, potem sam indeks.
  for (const code of [barcode, sku]) {
    if (code && maps.byEan?.has(code)) return { offerId: maps.byEan.get(code), via: 'ean' }
  }
  // 2. SKU — indeks, pomocniczo kod kreskowy.
  for (const code of [sku, barcode]) {
    if (code && maps.bySku?.has(code)) return { offerId: maps.bySku.get(code), via: 'sku' }
  }
  // 3. Tytuł — dopasowanie pomocnicze po znormalizowanej nazwie.
  const key = normalizeTitle(name)
  if (key && maps.byName?.has(key)) return { offerId: maps.byName.get(key), via: 'title' }

  return null
}

// ---------------------------------------------------------------------------
// Kody z pełnej oferty (GET /sale/product-offers/{id}) — automapowanie
// ---------------------------------------------------------------------------

/** Id parametrów Allegro: „Kod producenta" i „EAN (GTIN)". */
const PARAM_PRODUCER_CODE = '224017'
const PARAM_EAN = '225693'

function firstParamValue(params, id, nameRe) {
  for (const p of Array.isArray(params) ? params : []) {
    if (!p) continue
    if (String(p.id ?? '') !== id && !nameRe.test(String(p.name ?? ''))) continue
    const v = String((Array.isArray(p.values) ? p.values[0] : p.value) ?? '').trim()
    if (v) return v
  }
  return ''
}

/**
 * Wyłuskuje z pełnej oferty kody do dopasowania: sygnaturę (external.id), EAN
 * i „Kod producenta" — z parametrów oferty i produktów z productSet.
 * Lista `/sale/offers` tych parametrów nie zwraca, stąd osobny odczyt.
 *
 * @returns {{externalId:string, ean:string, producerCode:string}}
 */
export function extractOfferCodes(offer) {
  if (!offer || typeof offer !== 'object') return { externalId: '', ean: '', producerCode: '' }
  const paramSets = [offer.parameters]
  for (const ps of Array.isArray(offer.productSet) ? offer.productSet : []) paramSets.push(ps?.product?.parameters)
  let ean = ''
  let producerCode = ''
  for (const params of paramSets) {
    if (!ean) ean = firstParamValue(params, PARAM_EAN, /^(EAN|GTIN)/i)
    if (!producerCode) producerCode = firstParamValue(params, PARAM_PRODUCER_CODE, /^kod producenta$/i)
  }
  return {
    externalId: String(offer.external?.id ?? '').trim(),
    ean: ean || extractEanFromOffer(offer),
    producerCode
  }
}

/**
 * Ustala SKU (indeks WAPRO) pozycji zamówienia Allegro:
 *   1) mapowanie oferta → SKU (ręczne z CSV albo zapamiętane przy wysyłce stanów)
 *      — potwierdzone, że wskazuje istniejący indeks WAPRO,
 *   2) sygnatura oferty (offer.external.id).
 * @param {Map<string,string>} offerSku Map offerId → sku
 * @returns {string} '' gdy nie da się ustalić.
 */
export function resolveLineSku(lineItem, offerSku) {
  const offerId = String(lineItem?.offer?.id ?? '').trim()
  const mapped = offerId && offerSku?.get(offerId)
  if (mapped) return String(mapped).trim()
  return String(lineItem?.offer?.external?.id ?? '').trim()
}

/**
 * Łączy listę ofert z cache kodów z pełnej oferty (czysta funkcja).
 * @param {Map<string,{externalId:string,ean:string,producerCode:string}>} cache
 */
export function mergeOfferDetails(offers, cache) {
  return offers.map((o) => {
    const d = cache.get(String(o.offerId))
    if (!d) return { ...o, codes: [] }
    return {
      ...o,
      sku: o.sku || d.externalId || '',
      ean: o.ean || d.ean || '',
      codes: d.producerCode ? [d.producerCode] : []
    }
  })
}

/** Zapytanie do /order/checkout-forms (czysta funkcja — testowalna). */
export function buildOrdersQuery({ limit = 20, offset = 0, status = '', fulfillmentStatus = '', boughtFrom = '' } = {}) {
  const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, Number(limit) || 20))) })
  if (offset > 0) query.set('offset', String(Math.trunc(offset)))
  if (status) query.set('status', status)
  if (fulfillmentStatus) query.set('fulfillment.status', fulfillmentStatus)
  if (boughtFrom) {
    query.set('lineItems.boughtAt.gte', boughtFrom)
    query.set('sort', 'lineItems.boughtAt')
  }
  return query.toString()
}
