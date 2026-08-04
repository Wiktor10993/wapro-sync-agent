/**
 * Normalizacja zamówień z różnych kanałów do jednego kształtu.
 *
 * Allegro (checkout-form) i BaseLinker mają zupełnie inne struktury JSON.
 * Cała wiedza o tych różnicach siedzi tutaj — reszta kodu (generator XML,
 * zapis do bazy, UI) widzi już jednolity obiekt. Dzięki temu dołożenie
 * trzeciego kanału to jedna funkcja, a nie zmiany w pięciu miejscach.
 */

function num(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : fallback
}

function str(value, max = 255) {
  if (value === null || value === undefined) return ''
  return String(value).trim().slice(0, max)
}

/**
 * @typedef {object} NormalizedOrder
 * @property {string} source
 * @property {string} externalId
 * @property {string} documentRef      numer obcy dla Wapro
 * @property {string|null} orderedAt   ISO 8601
 * @property {object} buyer
 * @property {object} delivery
 * @property {Array<object>} items
 * @property {number} total
 * @property {string} currency
 * @property {string} notes
 */

/** @returns {NormalizedOrder} */
export function normalizeOrder(raw, source) {
  const order = raw ?? {}
  return source === 'allegro' ? fromAllegro(order) : fromBaseLinker(order)
}

// ---------------------------------------------------------------------------
// Allegro — struktura checkout-form
// ---------------------------------------------------------------------------

function fromAllegro(o) {
  const buyer = o.buyer ?? {}
  const invoice = o.invoice?.address ?? {}
  const delivery = o.delivery ?? {}
  const addr = delivery.address ?? {}

  const isCompany = Boolean(invoice.company?.name)

  const items = (o.lineItems ?? []).map((li, i) => ({
    lp: i + 1,
    // Sygnatura oferty (external.id) to nasz indeks z Wapro. Gdy jej brak,
    // zostawiamy id oferty — operator zobaczy „BRAK_ARTYKULU” i skoryguje.
    sku: str(li.offer?.external?.id ?? '', 128),
    fallbackRef: str(li.offer?.id ?? '', 128),
    barcode: '',
    name: str(li.offer?.name ?? '', 255),
    quantity: num(li.quantity, 1),
    priceGross: num(li.price?.amount, 0),
    vatRate: null
  }))

  const shippingCost = num(delivery.cost?.amount, 0)

  return {
    source: 'allegro',
    externalId: str(o.id, 128),
    documentRef: `ALLEGRO-${str(o.id, 120)}`,
    orderedAt: o.boughtAt ?? o.updatedAt ?? null,
    buyer: {
      name: isCompany
        ? str(invoice.company.name)
        : str([buyer.firstName, buyer.lastName].filter(Boolean).join(' ') || buyer.login || 'Klient detaliczny'),
      taxId: str(invoice.company?.taxId ?? '', 32),
      email: str(buyer.email ?? '', 160),
      phone: str(buyer.phoneNumber ?? '', 64),
      isCompany
    },
    delivery: {
      street: str(addr.street ?? invoice.street ?? ''),
      postCode: str(addr.zipCode ?? addr.postCode ?? invoice.zipCode ?? '', 16),
      city: str(addr.city ?? invoice.city ?? '', 128),
      countryCode: str(addr.countryCode ?? 'PL', 8),
      method: str(delivery.method?.name ?? '', 128),
      cost: shippingCost
    },
    items,
    total: num(o.summary?.totalToPay?.amount, 0),
    currency: str(o.summary?.totalToPay?.currency ?? 'PLN', 8),
    notes: str(o.messageToSeller ?? '', 4000)
  }
}

// ---------------------------------------------------------------------------
// BaseLinker — struktura getOrders / webhook
// ---------------------------------------------------------------------------

function fromBaseLinker(o) {
  const items = (o.products ?? []).map((p, i) => ({
    lp: i + 1,
    sku: str(p.sku ?? '', 128),
    fallbackRef: str(p.product_id ?? '', 128),
    barcode: str(p.ean ?? '', 64),
    name: str(p.name ?? '', 255),
    quantity: num(p.quantity, 1),
    // BaseLinker podaje cenę jednostkową brutto w `price_brutto`.
    priceGross: num(p.price_brutto, 0),
    vatRate: p.tax_rate === undefined ? null : num(p.tax_rate, 0)
  }))

  const isCompany = Boolean(str(o.invoice_company ?? ''))
  const total =
    num(o.delivery_price, 0) +
    items.reduce((sum, it) => sum + it.priceGross * it.quantity, 0)

  const orderedTs = num(o.date_confirmed, 0) || num(o.date_add, 0)

  return {
    source: 'baselinker',
    externalId: str(o.order_id, 128),
    documentRef: `BL-${str(o.order_id, 120)}`,
    orderedAt: orderedTs > 0 ? new Date(orderedTs * 1000).toISOString() : null,
    buyer: {
      name: isCompany
        ? str(o.invoice_company)
        : str(o.delivery_fullname || o.invoice_fullname || o.email || 'Klient detaliczny'),
      taxId: str(o.invoice_nip ?? '', 32),
      email: str(o.email ?? '', 160),
      phone: str(o.phone ?? '', 64),
      isCompany
    },
    delivery: {
      street: str(o.delivery_address ?? o.invoice_address ?? ''),
      postCode: str(o.delivery_postcode ?? o.invoice_postcode ?? '', 16),
      city: str(o.delivery_city ?? o.invoice_city ?? '', 128),
      countryCode: str(o.delivery_country_code ?? 'PL', 8),
      method: str(o.delivery_method ?? '', 128),
      cost: num(o.delivery_price, 0)
    },
    items,
    total: num(total, 0),
    currency: str(o.currency ?? 'PLN', 8),
    notes: str(o.user_comments ?? o.admin_comments ?? '', 4000)
  }
}

/**
 * Walidacja przed zapisem. Zwraca listę problemów — pusta oznacza,
 * że zamówienie nadaje się do przetworzenia.
 *
 * @returns {string[]}
 */
export function validateOrder(order) {
  const problems = []

  if (!order.externalId) problems.push('Brak identyfikatora zamówienia.')
  if (!order.items || order.items.length === 0) problems.push('Zamówienie nie zawiera pozycji.')
  if (!order.buyer?.name) problems.push('Brak danych nabywcy.')

  order.items?.forEach((item) => {
    if (!(item.quantity > 0)) {
      problems.push(`Pozycja ${item.lp}: ilość musi być większa od zera.`)
    }
    if (!item.sku && !item.fallbackRef) {
      problems.push(`Pozycja ${item.lp}: brak SKU i identyfikatora oferty.`)
    }
  })

  return problems
}
