import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildEcoOrderXml, xmlEscape } from '../src/main/wapro/ecoXml.js'

describe('xmlEscape', () => {
  it('escapuje wszystkie pięć encji XML', () => {
    assert.equal(xmlEscape(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;')
  })

  it('escapuje ampersand przed pozostałymi (bez podwójnego escapowania)', () => {
    assert.equal(xmlEscape('<b>'), '&lt;b&gt;')
    assert.equal(xmlEscape('&lt;'), '&amp;lt;')
  })

  it('nie rusza polskich znaków', () => {
    assert.equal(xmlEscape('Śruba ocynkowana ąęćłńóśźż'), 'Śruba ocynkowana ąęćłńóśźż')
  })

  it('zamienia null/undefined na pusty string', () => {
    assert.equal(xmlEscape(null), '')
    assert.equal(xmlEscape(undefined), '')
  })
})

describe('buildEcoOrderXml', () => {
  const order = {
    id: 'ABC-123',
    boughtAt: '2026-07-30T09:15:00.000Z',
    buyer: {
      firstName: 'Jan',
      lastName: 'Kowalski & Syn',
      email: 'jan@example.pl',
      phoneNumber: '600100200'
    },
    delivery: {
      address: { street: 'Długa 5/<b>2</b>', zipCode: '00-001', city: 'Warszawa', countryCode: 'PL' },
      method: { name: 'Kurier' },
      cost: { amount: '15.99' }
    },
    lineItems: [
      { offer: { name: 'Śruba M8 "ocynk"', external: { id: 'SRUB-M8' } }, quantity: 100, price: { amount: '0.45' } }
    ],
    summary: { totalToPay: { amount: '60.99', currency: 'PLN' } }
  }

  const xml = buildEcoOrderXml(order, 'allegro')

  it('zaczyna się deklaracją XML w UTF-8', () => {
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  })

  it('ustawia typ dokumentu ZO', () => {
    assert.match(xml, /<TYP>ZO<\/TYP>/)
  })

  it('escapuje ampersand w nazwie nabywcy', () => {
    assert.match(xml, /<NAZWA>Jan Kowalski &amp; Syn<\/NAZWA>/)
    assert.ok(!xml.includes('Kowalski & Syn'))
  })

  it('escapuje znaczniki HTML w adresie', () => {
    assert.match(xml, /<ULICA>Długa 5\/&lt;b&gt;2&lt;\/b&gt;<\/ULICA>/)
  })

  it('escapuje cudzysłowy w nazwie towaru', () => {
    assert.match(xml, /<NAZWA>Śruba M8 &quot;ocynk&quot;<\/NAZWA>/)
  })

  it('formatuje cenę z dwoma miejscami po przecinku', () => {
    assert.match(xml, /<CENA_BRUTTO>0\.45<\/CENA_BRUTTO>/)
    assert.match(xml, /<KOSZT>15\.99<\/KOSZT>/)
  })

  it('bierze datę z pola boughtAt', () => {
    assert.match(xml, /<DATA>2026-07-30<\/DATA>/)
  })

  it('nie zawiera niezescapowanych ostrych nawiasów w danych', () => {
    // Wszystkie znaczniki są ASCII; treść z <b> została zescapowana.
    const insideText = xml.replace(/<\/?[A-Z_?][^>]*>/g, '')
    assert.ok(!insideText.includes('<'), 'znaleziono niezescapowany "<" w danych')
  })

  it('produkuje dokument parsowalny — tagi są zbalansowane', () => {
    const opens = [...xml.matchAll(/<([A-Z_]+)>/g)].map((m) => m[1])
    const closes = [...xml.matchAll(/<\/([A-Z_]+)>/g)].map((m) => m[1])
    assert.equal(opens.length, closes.length)

    const stack = []
    for (const token of xml.matchAll(/<(\/?)([A-Z_]+)>/g)) {
      if (token[1] === '') stack.push(token[2])
      else assert.equal(stack.pop(), token[2], `niedopasowany tag ${token[2]}`)
    }
    assert.equal(stack.length, 0)
  })

  it('generuje jedną POZYCJĘ na pozycję zamówienia', () => {
    const many = buildEcoOrderXml(
      {
        order_id: '1',
        products: [
          { sku: 'A', quantity: 1, price_brutto: 1 },
          { sku: 'B', quantity: 2, price_brutto: 2 },
          { sku: 'C', quantity: 3, price_brutto: 3 }
        ]
      },
      'baselinker'
    )
    assert.equal([...many.matchAll(/<POZYCJA>/g)].length, 3)
    assert.match(many, /<LP>3<\/LP>/)
  })
})
