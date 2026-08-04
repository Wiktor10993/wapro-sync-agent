import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOrder, validateOrder } from '../src/main/wapro/orderNormalizer.js'

const allegroOrder = {
  id: 'f5c3d8a1-0000-4444-8888-abcdef012345',
  boughtAt: '2026-07-30T09:15:00.000Z',
  messageToSeller: 'Proszę o fakturę',
  buyer: {
    login: 'jan_k',
    firstName: 'Jan',
    lastName: 'Kowalski',
    email: 'jan@example.pl',
    phoneNumber: '600100200'
  },
  delivery: {
    address: { street: 'Długa 5/2', zipCode: '00-001', city: 'Warszawa', countryCode: 'PL' },
    method: { name: 'Kurier DPD' },
    cost: { amount: '15.99' }
  },
  lineItems: [
    {
      offer: { id: '1234567890', name: 'Wiertło 6 mm', external: { id: 'WIERT-06' } },
      quantity: 3,
      price: { amount: '24.90' }
    },
    {
      // Oferta bez sygnatury — musi wpaść na fallbackRef.
      offer: { id: '9876543210', name: 'Śruba M8' },
      quantity: 100,
      price: { amount: '0.45' }
    }
  ],
  summary: { totalToPay: { amount: '106.69', currency: 'PLN' } }
}

const baselinkerOrder = {
  order_id: '778899',
  date_confirmed: 1785400000,
  currency: 'PLN',
  email: 'anna@example.pl',
  phone: '501200300',
  user_comments: 'Prezent',
  invoice_company: 'ACME sp. z o.o.',
  invoice_nip: '5252445767',
  delivery_fullname: 'Anna Nowak',
  delivery_address: 'Polna 12',
  delivery_postcode: '31-000',
  delivery_city: 'Kraków',
  delivery_country_code: 'PL',
  delivery_method: 'InPost Paczkomat',
  delivery_price: 12.99,
  products: [
    { product_id: '555', sku: 'FARBA-BIALA-5L', ean: '5901234123457', name: 'Farba biała 5 l', quantity: 2, price_brutto: 89.0, tax_rate: 23 }
  ]
}

describe('normalizeOrder — Allegro', () => {
  const o = normalizeOrder(allegroOrder, 'allegro')

  it('mapuje identyfikator i numer obcy', () => {
    assert.equal(o.source, 'allegro')
    assert.equal(o.externalId, allegroOrder.id)
    assert.equal(o.documentRef, `ALLEGRO-${allegroOrder.id}`)
  })

  it('składa nazwę nabywcy z imienia i nazwiska', () => {
    assert.equal(o.buyer.name, 'Jan Kowalski')
    assert.equal(o.buyer.isCompany, false)
    assert.equal(o.buyer.email, 'jan@example.pl')
  })

  it('czyta SKU z sygnatury oferty (external.id)', () => {
    assert.equal(o.items[0].sku, 'WIERT-06')
    assert.equal(o.items[0].quantity, 3)
    assert.equal(o.items[0].priceGross, 24.9)
  })

  it('gdy brak sygnatury, zostawia id oferty jako fallback', () => {
    assert.equal(o.items[1].sku, '')
    assert.equal(o.items[1].fallbackRef, '9876543210')
  })

  it('numeruje pozycje od 1', () => {
    assert.deepEqual(o.items.map((i) => i.lp), [1, 2])
  })

  it('przenosi koszt i metodę dostawy', () => {
    assert.equal(o.delivery.cost, 15.99)
    assert.equal(o.delivery.method, 'Kurier DPD')
    assert.equal(o.delivery.postCode, '00-001')
  })
})

describe('normalizeOrder — Allegro, zamówienie firmowe', () => {
  it('preferuje nazwę firmy z danych do faktury', () => {
    const o = normalizeOrder(
      { ...allegroOrder, invoice: { address: { company: { name: 'BETA S.A.', taxId: '1234563218' } } } },
      'allegro'
    )
    assert.equal(o.buyer.name, 'BETA S.A.')
    assert.equal(o.buyer.taxId, '1234563218')
    assert.equal(o.buyer.isCompany, true)
  })
})

describe('normalizeOrder — BaseLinker', () => {
  const o = normalizeOrder(baselinkerOrder, 'baselinker')

  it('mapuje identyfikator z order_id', () => {
    assert.equal(o.externalId, '778899')
    assert.equal(o.documentRef, 'BL-778899')
  })

  it('rozpoznaje nabywcę firmowego', () => {
    assert.equal(o.buyer.name, 'ACME sp. z o.o.')
    assert.equal(o.buyer.isCompany, true)
    assert.equal(o.buyer.taxId, '5252445767')
  })

  it('czyta SKU i EAN z produktu', () => {
    assert.equal(o.items[0].sku, 'FARBA-BIALA-5L')
    assert.equal(o.items[0].barcode, '5901234123457')
    assert.equal(o.items[0].vatRate, 23)
  })

  it('wylicza wartość jako pozycje + dostawa', () => {
    // 2 × 89.00 + 12.99
    assert.equal(o.total, 190.99)
  })

  it('konwertuje uniksowy znacznik czasu na ISO', () => {
    assert.equal(o.orderedAt, new Date(1785400000 * 1000).toISOString())
  })
})

describe('normalizeOrder — dane brzegowe', () => {
  it('nie wywraca się na pustym obiekcie', () => {
    const o = normalizeOrder({}, 'allegro')
    assert.equal(o.items.length, 0)
    assert.equal(o.buyer.name, 'Klient detaliczny')
    assert.equal(o.currency, 'PLN')
  })

  it('przyjmuje przecinek jako separator dziesiętny', () => {
    const o = normalizeOrder(
      { order_id: '1', products: [{ sku: 'A', quantity: 1, price_brutto: '12,50' }] },
      'baselinker'
    )
    assert.equal(o.items[0].priceGross, 12.5)
  })

  it('przycina zbyt długie nazwy do limitu kolumny', () => {
    const o = normalizeOrder(
      { order_id: '1', products: [{ sku: 'A', quantity: 1, name: 'x'.repeat(400) }] },
      'baselinker'
    )
    assert.equal(o.items[0].name.length, 255)
  })
})

describe('validateOrder', () => {
  it('akceptuje poprawne zamówienie', () => {
    assert.deepEqual(validateOrder(normalizeOrder(allegroOrder, 'allegro')), [])
  })

  it('odrzuca zamówienie bez pozycji', () => {
    const problems = validateOrder(normalizeOrder({ id: 'x', buyer: { login: 'a' } }, 'allegro'))
    assert.ok(problems.some((p) => p.includes('nie zawiera pozycji')))
  })

  it('odrzuca pozycję z ilością zero', () => {
    const o = normalizeOrder(
      { order_id: '1', products: [{ sku: 'A', quantity: 0 }] },
      'baselinker'
    )
    const problems = validateOrder(o)
    assert.ok(problems.some((p) => p.includes('ilość musi być większa od zera')))
  })

  it('odrzuca pozycję bez SKU i bez identyfikatora oferty', () => {
    const o = normalizeOrder({ order_id: '1', products: [{ quantity: 1 }] }, 'baselinker')
    const problems = validateOrder(o)
    assert.ok(problems.some((p) => p.includes('brak SKU')))
  })
})
