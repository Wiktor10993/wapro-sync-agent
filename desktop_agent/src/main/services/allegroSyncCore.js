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
