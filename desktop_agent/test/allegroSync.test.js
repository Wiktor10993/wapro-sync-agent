import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractEanFromOffer,
  normalizeTitle,
  buildNameIndex,
  pickOfferId
} from '../src/main/services/allegroSyncCore.js'

describe('extractEanFromOffer', () => {
  it('czyta EAN z pola ean', () => {
    assert.equal(extractEanFromOffer({ ean: '5904619771106' }), '5904619771106')
  })
  it('czyta z gtin, gdy brak ean', () => {
    assert.equal(extractEanFromOffer({ gtin: '1234567890123' }), '1234567890123')
  })
  it('czyta z zagnieżdżonego product.ean', () => {
    assert.equal(extractEanFromOffer({ product: { ean: '9990001112223' } }), '9990001112223')
  })
  it('czyta z productSet', () => {
    assert.equal(extractEanFromOffer({ productSet: [{ product: { ean: '7770001112223' } }] }), '7770001112223')
  })
  it('zwraca pusty string, gdy nic nie ma', () => {
    assert.equal(extractEanFromOffer({ id: '1', name: 'x' }), '')
    assert.equal(extractEanFromOffer(null), '')
  })
})

describe('normalizeTitle', () => {
  it('usuwa polskie znaki, interpunkcję i nadmiar spacji', () => {
    assert.equal(normalizeTitle('Kubek CZERWONY, 300ml — Łódź ĄĘŚĆ'), 'kubek czerwony 300ml lodz aesc')
  })
  it('różne zapisy dają ten sam klucz', () => {
    assert.equal(normalizeTitle('Talerz  Głęboki!'), normalizeTitle('talerz gleboki'))
  })
})

describe('buildNameIndex', () => {
  it('indeksuje unikalne tytuły', () => {
    const idx = buildNameIndex([{ id: '1', name: 'Kubek' }, { id: '2', name: 'Talerz' }])
    assert.equal(idx.get('kubek'), '1')
    assert.equal(idx.get('talerz'), '2')
  })
  it('pomija tytuły niejednoznaczne (kolizja → nie zgadujemy)', () => {
    const idx = buildNameIndex([
      { id: '1', name: 'Kubek Czerwony' },
      { id: '2', name: 'kubek  czerwony' },
      { id: '3', name: 'Unikat' }
    ])
    assert.equal(idx.has('kubek czerwony'), false)
    assert.equal(idx.get('unikat'), '3')
  })
})

describe('pickOfferId — strategia EAN → SKU → Tytuł', () => {
  const maps = {
    bySku: new Map([['ART-1', '111'], ['ART-2', '222']]),
    byEan: new Map([['5904619771106', '333']]),
    byName: new Map([['kubek czerwony', '444']])
  }

  it('1) dopasowanie po EAN (kod kreskowy)', () => {
    assert.deepEqual(pickOfferId(maps, { sku: 'X', barcode: '5904619771106', name: 'y' }), {
      offerId: '333',
      via: 'ean'
    })
  })
  it('2) gdy brak EAN — po SKU', () => {
    assert.deepEqual(pickOfferId(maps, { sku: 'ART-1', barcode: '', name: 'y' }), {
      offerId: '111',
      via: 'sku'
    })
  })
  it('3) gdy brak EAN i SKU — po tytule', () => {
    assert.deepEqual(pickOfferId(maps, { sku: 'X', barcode: '', name: 'Kubek  CZERWONY!' }), {
      offerId: '444',
      via: 'title'
    })
  })
  it('EAN ma priorytet nad SKU, gdy oba trafiają', () => {
    const m = { bySku: new Map([['C', 'sku']]), byEan: new Map([['C', 'ean']]), byName: new Map() }
    assert.equal(pickOfferId(m, { sku: 'C', barcode: 'C' }).via, 'ean')
  })
  it('indeks (sku) bywa też EAN — łapiemy po EAN, gdy brak kodu kreskowego', () => {
    const m = { bySku: new Map(), byEan: new Map([['590123', 'e']]), byName: new Map() }
    assert.deepEqual(pickOfferId(m, { sku: '590123', barcode: '', name: '' }), { offerId: 'e', via: 'ean' })
  })
  it('brak dopasowania → null', () => {
    assert.equal(pickOfferId(maps, { sku: 'NIC', barcode: '', name: 'nieznane' }), null)
  })
  it('akceptuje sam string jako kod', () => {
    assert.deepEqual(pickOfferId(maps, 'ART-2'), { offerId: '222', via: 'sku' })
  })
})
