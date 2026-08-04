import { getIntegrations, setIntegrationCheck } from '../store.js'

/**
 * KLIENT API BASELINKERA (bezpośrednio z agenta)
 * ==============================================
 *
 * BaseLinker wystawia jeden endpoint dla wszystkich metod:
 *   POST https://api.baselinker.com/connector.php
 *   nagłówek: X-BLToken
 *   ciało:    method=<nazwa>&parameters=<JSON>
 *
 * Pułapka, o którą łatwo się potknąć: **odpowiedź zawsze ma kod HTTP 200**,
 * także przy błędzie. O powodzeniu decyduje pole `status` w treści
 * ('SUCCESS' albo 'ERROR'). Kod, który sprawdza tylko `res.ok`, będzie
 * uznawał błędy za sukcesy.
 */

const ENDPOINT = 'https://api.baselinker.com/connector.php'
const TIMEOUT_MS = 25_000

/**
 * Surowe wywołanie metody API.
 *
 * @param {string} token klucz z panelu BaseLinkera
 * @param {string} method nazwa metody
 * @param {object} [parameters]
 */
export async function call(token, method, parameters = {}) {
  if (!token) {
    throw new Error('Nie podano tokenu BaseLinkera.')
  }

  let res
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-BLToken': token,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        method,
        parameters: JSON.stringify(parameters)
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`Przekroczono czas oczekiwania (${TIMEOUT_MS / 1000} s) na odpowiedź BaseLinkera.`)
    }
    throw new Error(`Brak połączenia z API BaseLinkera: ${err.message}`)
  }

  if (res.status !== 200) {
    throw new Error(`BaseLinker odpowiedział kodem HTTP ${res.status} (metoda ${method}).`)
  }

  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`BaseLinker zwrócił odpowiedź, której nie da się odczytać: ${text.slice(0, 200)}`)
  }

  if (data?.status !== 'SUCCESS') {
    throw new Error(interpretError(data, method))
  }

  return data
}

/** Tłumaczy kod błędu BaseLinkera na wskazówkę, co zrobić. */
function interpretError(data, method) {
  const code = data?.error_code ?? 'UNKNOWN'
  const message = data?.error_message ?? 'brak opisu'

  const hints = {
    ERROR_AUTH_TOKEN: 'Token jest nieprawidłowy. Wygeneruj nowy w panelu BaseLinkera (Moje konto → API).',
    ERROR_AUTH: 'Token został odrzucony. Sprawdź, czy nie wygasł i czy nie ma spacji na końcu.',
    ERROR_UNKNOWN_METHOD: `Metoda "${method}" nie istnieje w API BaseLinkera.`,
    ERROR_INVENTORY_NOT_FOUND: 'Nie znaleziono katalogu o podanym inventory_id.',
    ERROR_RATE_LIMIT: 'Przekroczono limit zapytań. Odczekaj minutę.'
  }

  return hints[code] ? `${hints[code]} (kod: ${code})` : `BaseLinker: ${message} (kod: ${code})`
}

// ---------------------------------------------------------------------------
// Test połączenia
// ---------------------------------------------------------------------------

/**
 * Sprawdza token i przy okazji zwraca listę katalogów — operator od razu widzi,
 * jakie `inventory_id` ma do wyboru, zamiast szukać go w panelu BaseLinkera.
 *
 * @param {string} [tokenOverride] token z formularza, jeszcze niezapisany
 */
export async function testBaseLinkerConnection(tokenOverride, log = () => {}) {
  const saved = getIntegrations({ withSecrets: true }).baselinker
  const token = (tokenOverride && tokenOverride.trim()) || saved.token

  if (!token) {
    const message = 'Nie podano tokenu BaseLinkera.'
    setIntegrationCheck('baselinker', false, message)
    return { ok: false, message }
  }

  try {
    const data = await call(token, 'getInventories')
    const inventories = Object.entries(data.inventories ?? {}).map(([id, inv]) => ({
      id: inv?.inventory_id ?? id,
      name: inv?.name ?? `Katalog ${id}`
    }))

    const message = inventories.length
      ? `Token poprawny. Dostępne katalogi: ${inventories.map((i) => `${i.name} (id ${i.id})`).join(', ')}.`
      : 'Token poprawny, ale konto nie ma jeszcze żadnego katalogu produktów.'

    setIntegrationCheck('baselinker', true, message)
    log('success', `BaseLinker: ${message}`)
    return { ok: true, message, inventories }
  } catch (err) {
    setIntegrationCheck('baselinker', false, err.message)
    log('error', `BaseLinker: ${err.message}`)
    return { ok: false, message: err.message }
  }
}

// ---------------------------------------------------------------------------
// Zamówienia
// ---------------------------------------------------------------------------

/**
 * Pobranie zamówień.
 *
 * @param {object} [opts]
 * @param {number} [opts.dateFrom] unix timestamp; domyślnie ostatnia doba
 * @param {number} [opts.statusId] filtr statusu
 * @param {boolean} [opts.includeUnconfirmed]
 */
export async function getOrders({ dateFrom, statusId, includeUnconfirmed = false } = {}, log = () => {}) {
  const { token } = getIntegrations({ withSecrets: true }).baselinker

  const params = {
    date_confirmed_from: dateFrom ?? Math.floor(Date.now() / 1000) - 86_400,
    get_unconfirmed_orders: includeUnconfirmed
  }
  if (statusId) params.status_id = statusId

  const data = await call(token, 'getOrders', params)
  const orders = data.orders ?? []

  log('info', `BaseLinker: pobrano ${orders.length} zamówień.`)
  return orders
}

/**
 * Utworzenie zamówienia w BaseLinkerze.
 *
 * Szkielet pod scenariusz odwrotny: sprzedaż zarejestrowana poza BaseLinkerem
 * (np. bezpośrednio w Wapro) ma trafić do wspólnej kolejki.
 *
 * @param {object} order zamówienie w formacie znormalizowanym (orderNormalizer)
 * @param {number} orderStatusId docelowy status w BaseLinkerze
 */
export async function addOrder(order, orderStatusId, log = () => {}) {
  const { token } = getIntegrations({ withSecrets: true }).baselinker

  if (!orderStatusId) {
    throw new Error('Nie podano statusu docelowego (order_status_id) dla nowego zamówienia.')
  }

  const params = {
    order_status_id: orderStatusId,
    date_add: order.orderedAt ? Math.floor(new Date(order.orderedAt).getTime() / 1000) : Math.floor(Date.now() / 1000),
    currency: order.currency ?? 'PLN',
    email: order.buyer?.email ?? '',
    phone: order.buyer?.phone ?? '',
    user_comments: order.notes ?? '',
    delivery_method: order.delivery?.method ?? '',
    delivery_price: Number(order.delivery?.cost ?? 0),
    delivery_fullname: order.buyer?.name ?? '',
    delivery_address: order.delivery?.street ?? '',
    delivery_postcode: order.delivery?.postCode ?? '',
    delivery_city: order.delivery?.city ?? '',
    delivery_country_code: order.delivery?.countryCode ?? 'PL',
    invoice_company: order.buyer?.isCompany ? order.buyer.name : '',
    invoice_nip: order.buyer?.taxId ?? '',
    products: (order.items ?? []).map((it) => ({
      name: it.name ?? '',
      sku: it.sku ?? '',
      ean: it.barcode ?? '',
      price_brutto: Number(it.priceGross ?? 0),
      tax_rate: it.vatRate ?? 23,
      quantity: Number(it.quantity ?? 1)
    }))
  }

  const data = await call(token, 'addOrder', params)
  log('success', `BaseLinker: utworzono zamówienie ${data.order_id}.`)
  return data.order_id
}

// ---------------------------------------------------------------------------
// Stany magazynowe
// ---------------------------------------------------------------------------

/**
 * Aktualizacja stanów w katalogu produktów.
 *
 * Poprawna metoda API dla katalogów to `updateInventoryProductsStock`.
 * Oczekuje ona `products` jako OBIEKTU (mapy) kluczowanego po ID produktu,
 * a wartością jest mapa stanów per magazyn:
 *   {
 *     "<product_id>": { "bl_1": 10 },
 *     "<product_id>": { "bl_1": 5 }
 *   }
 * `inventory_id` to ID KATALOGU (np. 111510), a klucz magazynu to `bl_<id>`.
 *
 * UWAGA: NIE wolno tu wysyłać tablicy tablic ([[pid, variant, {..}]]). Gdy
 * `products` jest tablicą, BaseLinker bierze indeksy tablicy jako ID produktu
 * (stąd „produkt o ID 0") i pozycje wewnętrzne jako numery magazynów (stąd
 * „nie znaleziono magazynu 1/2"). Musi to być obiekt kluczowany po product_id.
 *
 * @param {Array<{product_id:string|number, variant_id?:string|number, quantity:number}>} items
 */
export async function updateInventoryProductsStock(items, log = () => {}) {
  const bl = getIntegrations({ withSecrets: true }).baselinker

  if (!items?.length) {
    // Bez tej diagnostyki cichy „brak zmapowanych produktów" wyglądał jak brak
    // wywołania API — dlatego głośno mówimy, że POST-a celowo nie wysyłamy.
    console.warn('[BaseLinker] updateInventoryProductsStock: brak produktów do wysłania (pusta lista) — POST pominięty.')
    log('warn', 'BaseLinker: brak zmapowanych produktów — nie wysyłam żądania updateInventoryProductsStock.')
    return { updated: 0 }
  }

  const inventoryId = Number(bl.inventoryId)
  if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
    throw new Error('Nie ustawiono ID katalogu (inventory_id) w zakładce Integracje API.')
  }

  // Klucz magazynu ustalamy dynamicznie z katalogu (z fallbackiem na `0`),
  // żeby nie wysyłać stanu pod nieistniejący magazyn.
  const warehouseId = await resolveWarehouseKey(bl, log)
  let updated = 0

  // Limit API: 1000 produktów na wywołanie.
  for (let i = 0; i < items.length; i += 1000) {
    const chunk = items.slice(i, i + 1000)

    // products = mapa product_id -> { magazyn: ilość }. Dla wariantów kluczem
    // jest ID wariantu; dla produktu głównego (variant_id '0') — ID produktu.
    const products = {}
    let skipped = 0
    for (const item of chunk) {
      const variantId = String(item.variant_id ?? '0')
      const key = variantId !== '0' ? variantId : String(item.product_id)

      // Twardy bezpiecznik: bez realnego ID nie ma po co wysyłać — inaczej
      // wróciłoby „produkt o ID 0".
      if (!key || key === '0' || key === 'undefined' || key === 'null') {
        skipped++
        console.warn('[BaseLinker] Pomijam pozycję bez prawidłowego product_id:', JSON.stringify(item))
        continue
      }

      products[key] = { [warehouseId]: Math.max(0, Math.trunc(Number(item.quantity) || 0)) }
    }

    const count = Object.keys(products).length
    if (count === 0) {
      log('warn', `BaseLinker: paczka bez prawidłowych ID produktów (pominięto ${skipped}) — POST pominięty.`)
      continue
    }

    const payload = { inventory_id: inventoryId, products }

    // Pełny log żądania — dokładnie to, co ląduje w polu `parameters` POST-a.
    console.log(
      `[BaseLinker] → updateInventoryProductsStock (katalog ${inventoryId}, magazyn ${warehouseId}, ${count} poz.) payload:`,
      JSON.stringify(payload)
    )
    log('info', `BaseLinker: wysyłam updateInventoryProductsStock — katalog ${inventoryId}, ${count} pozycji (magazyn ${warehouseId}).`)

    const data = await call(bl.token, 'updateInventoryProductsStock', payload)

    // Pełny log odpowiedzi — status, licznik i ewentualne ostrzeżenia z API.
    console.log('[BaseLinker] ← updateInventoryProductsStock odpowiedź:', JSON.stringify(data))
    log(
      'info',
      `BaseLinker: odpowiedź updateInventoryProductsStock — status=${data?.status ?? '?'}` +
        (data?.counter !== undefined ? `, counter=${data.counter}` : '') +
        (data?.warnings ? `, warnings=${JSON.stringify(data.warnings)}` : '')
    )

    updated += count
  }

  log('success', `BaseLinker: zaktualizowano stany dla ${updated} produktów.`)
  return { updated }
}

/**
 * Lista magazynów katalogu. Klucz stanu w `updateInventoryProductsStock` musi
 * być jednym z tych magazynów w formacie `typ_id` (np. `bl_1`, `shop_5`).
 */
export async function getInventoryWarehouses(log = () => {}) {
  const { token } = getIntegrations({ withSecrets: true }).baselinker
  const data = await call(token, 'getInventoryWarehouses')
  const warehouses = data.warehouses ?? []
  log('info', `BaseLinker: katalog ma ${warehouses.length} magazyn(ów).`)
  return warehouses
}

/**
 * Ustala prawidłowy klucz magazynu dla stanów.
 *
 * BaseLinker odrzuca stan pod nieistniejącym magazynem (np. gołe `148541`
 * z ustawień) i zgłasza „nie znaleziono magazynu". Dlatego klucz ustalamy tak:
 *   1) pobieramy magazyny katalogu (`getInventoryWarehouses`) i dopasowujemy
 *      to, co skonfigurował użytkownik (pełny klucz `typ_id` albo samo id),
 *   2) jak nie ma dopasowania — bierzemy pierwszy magazyn z prawem edycji stanu,
 *   3) w ostateczności `0` = główny stan magazynowy katalogu.
 * Wynik cache'ujemy na krótko, żeby nie odpytywać API przy każdej paczce.
 */
let _warehouseKeyCache = { key: null, at: 0 }

export function invalidateWarehouseKey() {
  _warehouseKeyCache = { key: null, at: 0 }
}

async function resolveWarehouseKey(bl, log) {
  if (_warehouseKeyCache.key && Date.now() - _warehouseKeyCache.at < SKU_MAP_TTL_MS) {
    return _warehouseKeyCache.key
  }

  const configured = String(bl.warehouseId ?? '').trim()
  const keyOf = (w) => `${w?.warehouse_type ?? 'bl'}_${w?.warehouse_id}`
  let resolved = null

  try {
    const warehouses = await getInventoryWarehouses(log)
    const editable = warehouses.filter((w) => w?.stock_edition !== false)

    if (configured) {
      const hit = warehouses.find(
        (w) =>
          keyOf(w) === configured ||
          String(w?.warehouse_id) === configured ||
          `bl_${w?.warehouse_id}` === configured
      )
      if (hit) resolved = keyOf(hit)
    }
    if (!resolved && editable.length > 0) resolved = keyOf(editable[0])

    console.log(
      `[BaseLinker] Magazyny katalogu: ${
        warehouses.map((w) => keyOf(w) + (w?.stock_edition === false ? '(ro)' : '')).join(', ') || '—'
      }. Wybrany klucz stanu: ${resolved ?? '0 (fallback)'}.`
    )
  } catch (err) {
    console.warn('[BaseLinker] getInventoryWarehouses nieudane — używam klucza zapasowego:', err.message)
    // Lista niedostępna: ufamy skonfigurowanemu kluczowi tylko gdy wygląda na
    // poprawny (format „typ_id"); gołe numery odrzucamy na rzecz „0".
    if (configured && /^[a-z]+_\d+$/i.test(configured)) resolved = configured
  }

  if (!resolved) resolved = '0'

  _warehouseKeyCache = { key: resolved, at: Date.now() }
  return resolved
}

/**
 * Lista produktów w katalogu — do budowy mapowania SKU bez Cloud Huba.
 *
 * @param {number} [page]
 */
export async function getInventoryProductsList(page = 1, log = () => {}) {
  const bl = getIntegrations({ withSecrets: true }).baselinker

  const inventoryId = Number(bl.inventoryId)
  if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
    throw new Error('Nie ustawiono ID katalogu (inventory_id).')
  }

  const data = await call(bl.token, 'getInventoryProductsList', {
    inventory_id: inventoryId,
    page: Math.max(1, page)
  })

  const products = data.products ?? {}
  log('info', `BaseLinker: strona ${page} — ${Object.keys(products).length} produktów.`)
  return products
}

/** Lista statusów zamówień — potrzebna przy addOrder. */
export async function getOrderStatusList(log = () => {}) {
  const { token } = getIntegrations({ withSecrets: true }).baselinker
  const data = await call(token, 'getOrderStatusList')
  const statuses = data.statuses ?? []
  log('info', `BaseLinker: pobrano ${statuses.length} statusów zamówień.`)
  return statuses
}

// ---------------------------------------------------------------------------
// Mapowanie kod → product_id (lokalne, bez Cloud Huba)
// ---------------------------------------------------------------------------

/**
 * BaseLinker aktualizuje stany po `product_id`, a Wapro operuje na kodzie
 * towaru. Ten sam kod bywa w BaseLinkerze zapisany raz jako SKU, a raz jako
 * EAN (kod kreskowy) — dlatego z katalogu budujemy DWA indeksy:
 *   bySku  — dopasowanie po polu `sku`
 *   byEan  — dopasowanie po polu `ean` (kod kreskowy)
 * Przy rozwiązywaniu najpierw próbujemy po SKU, a gdy brak — po EAN. Dzięki
 * temu towar, który w Wapro ma kod zapisany jako EAN, i tak zostanie znaleziony.
 *
 * Mapę trzymamy w pamięci przez krótki czas — SyncUp wysyła tylko zmienione
 * pozycje, więc odpytywanie całego katalogu przy każdym przebiegu byłoby
 * marnotrawstwem.
 */
let _lookupCache = { lookup: null, at: 0 }
const SKU_MAP_TTL_MS = 5 * 60 * 1000

/** Wymusza przebudowę mapy przy następnym użyciu (np. po zmianie katalogu). */
export function invalidateSkuMap() {
  _lookupCache = { lookup: null, at: 0 }
}

async function buildLookup(log) {
  const bySku = new Map()
  const byEan = new Map()
  // Zabezpieczenie przed nieskończoną pętlą — 100 stron × 1000 = 100k produktów.
  for (let page = 1; page <= 100; page++) {
    const products = await getInventoryProductsList(page, log)
    const entries = Object.entries(products)
    if (entries.length === 0) break

    for (const [productId, prod] of entries) {
      const id = String(productId)
      const sku = String(prod?.sku ?? '').trim()
      const ean = String(prod?.ean ?? '').trim()
      // Pierwsze wystąpienie wygrywa — nie nadpisujemy istniejącego dopasowania
      // duplikatem kodu z innego produktu.
      if (sku && !bySku.has(sku)) bySku.set(sku, id)
      if (ean && !byEan.has(ean)) byEan.set(ean, id)
    }

    // Mniej niż pełna strona = koniec katalogu.
    if (entries.length < 1000) break
  }
  // Diagnostyka: ile kodów faktycznie zaindeksowaliśmy. Jeśli tu jest 0, to
  // znak, że `getInventoryProductsList` nie zwraca pól sku/ean i trzeba sięgnąć
  // po `getInventoryProductsData` — od razu widać to w terminalu.
  console.log(
    `[BaseLinker] Zbudowano indeks katalogu: ${bySku.size} SKU, ${byEan.size} EAN.`,
    bySku.size + byEan.size > 0
      ? `Przykłady SKU: ${[...bySku.keys()].slice(0, 3).join(', ') || '—'}; EAN: ${[...byEan.keys()].slice(0, 3).join(', ') || '—'}.`
      : '(Katalog nie zwrócił żadnych kodów!)'
  )
  return { bySku, byEan }
}

async function getLookup(log, { force = false } = {}) {
  const fresh = _lookupCache.lookup && Date.now() - _lookupCache.at < SKU_MAP_TTL_MS
  if (fresh && !force) return _lookupCache.lookup

  const lookup = await buildLookup(log)
  _lookupCache = { lookup, at: Date.now() }
  return lookup
}

/**
 * Aktualizuje stany w BaseLinkerze na podstawie listy {sku, quantity}.
 * Sam rozwiązuje kod → product_id z katalogu (po SKU, a w drugiej kolejności
 * po EAN), więc SyncUp nie musi znać ID ani wiedzieć, w którym polu kod siedzi.
 *
 * @param {Array<{sku:string, quantity:number}>} rows
 * @returns {Promise<{updated:number, unmapped:string[], viaEan:number}>}
 */
export async function updateStockBySku(rows, log = () => {}) {
  if (!rows?.length) return { updated: 0, unmapped: [], viaEan: 0 }

  let lookup = await getLookup(log)

  let mapped = []
  let unmapped = []
  let viaEan = 0
  const resolve = () => {
    mapped = []
    unmapped = []
    viaEan = 0
    for (const r of rows) {
      const code = String(r.sku)
      let pid = lookup.bySku.get(code)
      if (!pid) {
        pid = lookup.byEan.get(code)
        if (pid) viaEan++
      }
      if (pid) mapped.push({ product_id: pid, variant_id: '0', quantity: r.quantity })
      else unmapped.push(code)
    }
  }

  resolve()

  // Część kodów nie trafiła — katalog mógł się zmienić od ostatniego cache'u.
  // Odświeżamy mapę raz i próbujemy ponownie, zanim uznamy je za niedopasowane.
  if (unmapped.length > 0) {
    lookup = await getLookup(log, { force: true })
    resolve()
  }

  // Podsumowanie mapowania — dzięki temu w terminalu widać, czy w ogóle jest co
  // wysyłać (i czy zaraz padnie POST, czy zostanie pominięty z powodu 0 trafień).
  console.log(
    `[BaseLinker] Mapowanie stanów: ${rows.length} kodów na wejściu → ${mapped.length} zmapowanych ` +
      `(${viaEan} po EAN), ${unmapped.length} niedopasowanych.`
  )
  if (mapped.length > 0) {
    console.log('[BaseLinker] Zmapowane (product_id ← kod):', JSON.stringify(mapped.slice(0, 10)))
  }

  const { updated } = await updateInventoryProductsStock(mapped, log)

  if (viaEan > 0) {
    log('info', `BaseLinker: ${viaEan} pozycji dopasowano po kodzie EAN (brak dopasowania po SKU).`)
  }

  if (unmapped.length > 0) {
    log(
      'warn',
      `BaseLinker: ${unmapped.length} kodów bez odpowiednika w katalogu (ani SKU, ani EAN; np. ${unmapped
        .slice(0, 5)
        .join(', ')}). Dodaj produkty w BaseLinkerze albo popraw kody.`
    )
  }

  return { updated, unmapped, viaEan }
}
