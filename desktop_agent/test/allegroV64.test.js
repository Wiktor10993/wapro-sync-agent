import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOrdersQuery,
  extractOfferCodes,
  mergeOfferDetails,
  resolveLineSku
} from '../src/main/services/allegroSyncCore.js'

describe('buildOrdersQuery', () => {
  it('READY_FOR_PROCESSING idzie jako status, nie fulfillment.status (inaczej HTTP 400)', () => {
    const q = new URLSearchParams(buildOrdersQuery({ limit: 100, status: 'READY_FOR_PROCESSING' }))
    assert.equal(q.get('status'), 'READY_FOR_PROCESSING')
    assert.equal(q.has('fulfillment.status'), false)
    assert.equal(q.get('limit'), '100')
  })
  it('okno czasu + sortowanie + stronicowanie', () => {
    const q = new URLSearchParams(buildOrdersQuery({ limit: 500, offset: 200, boughtFrom: '2026-10-20T00:00:00.000Z' }))
    assert.equal(q.get('limit'), '100')
    assert.equal(q.get('offset'), '200')
    assert.equal(q.get('lineItems.boughtAt.gte'), '2026-10-20T00:00:00.000Z')
    assert.equal(q.get('sort'), 'lineItems.boughtAt')
  })
})

describe('extractOfferCodes', () => {
  it('czyta kod producenta i EAN z parametrów produktu', () => {
    const offer = {
      external: null,
      productSet: [
        {
          product: {
            parameters: [
              { id: '224017', name: 'Kod producenta', values: ['00-30-71-30-0125'] },
              { id: '225693', name: 'EAN (GTIN)', values: ['5901828825217'] }
            ]
          }
        }
      ]
    }
    assert.deepEqual(extractOfferCodes(offer), { externalId: '', ean: '5901828825217', producerCode: '00-30-71-30-0125' })
  })
  it('czyta z parametrów oferty po nazwie i sygnaturę', () => {
    const offer = { external: { id: 'ABC-1' }, parameters: [{ id: 'x', name: 'Kod producenta', values: ['K-9'] }] }
    assert.deepEqual(extractOfferCodes(offer), { externalId: 'ABC-1', ean: '', producerCode: 'K-9' })
  })
  it('pusty obiekt → puste kody', () => {
    assert.deepEqual(extractOfferCodes(null), { externalId: '', ean: '', producerCode: '' })
  })
})

describe('resolveLineSku', () => {
  const map = new Map([['111', '00-40-00-00-0500']])
  it('mapowanie oferta → SKU ma pierwszeństwo przed sygnaturą', () => {
    assert.equal(resolveLineSku({ offer: { id: '111', external: { id: 'COS' } } }, map), '00-40-00-00-0500')
  })
  it('bez mapowania bierze sygnaturę', () => {
    assert.equal(resolveLineSku({ offer: { id: '222', external: { id: 'SYG-1' } } }, map), 'SYG-1')
  })
  it('bez mapowania i sygnatury → pusty', () => {
    assert.equal(resolveLineSku({ offer: { id: '333' } }, map), '')
  })
})

describe('mergeOfferDetails', () => {
  it('uzupełnia EAN/sygnaturę i dodaje kod producenta jako kod SKU', () => {
    const cache = new Map([['1', { externalId: '', ean: '590', producerCode: 'KP-1', fetchedMs: 0 }]])
    const [a, b] = mergeOfferDetails(
      [
        { offerId: '1', sku: '', ean: '', name: 'A' },
        { offerId: '2', sku: 'S2', ean: '', name: 'B' }
      ],
      cache
    )
    assert.deepEqual(a, { offerId: '1', sku: '', ean: '590', name: 'A', codes: ['KP-1'] })
    assert.deepEqual(b, { offerId: '2', sku: 'S2', ean: '', name: 'B', codes: [] })
  })
})
