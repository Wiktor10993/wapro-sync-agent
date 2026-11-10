import { describe, expect, it } from 'vitest'
import { isSaleItem, passesUnmappedFilter } from '../ActionCenter.jsx'

const wapro = (quantity) => ({ source: 'wapro', sku: 'SKU', quantity })
// Sprzedaż z zamówienia Allegro: quantity = sprzedane sztuki, nie stan WAPRO.
const sale = (quantity) => ({ source: 'allegro', sku: 'oferta:15429366395', quantity })

describe('filtry listy „Niezmapowane produkty"', () => {
  it('rozpoznaje sprzedaże z zamówień', () => {
    expect(isSaleItem(sale(1))).toBe(true)
    expect(isSaleItem(wapro(1))).toBe(false)
  })

  it('bez filtrów pokazuje wszystko', () => {
    expect(passesUnmappedFilter(wapro(0))).toBe(true)
    expect(passesUnmappedFilter(sale(3))).toBe(true)
  })

  it('próg stanu działa na towary z WAPRO', () => {
    expect(passesUnmappedFilter(wapro(0), { minQty: 1 })).toBe(false)
    expect(passesUnmappedFilter(wapro(4), { minQty: 5 })).toBe(false)
    expect(passesUnmappedFilter(wapro(5), { minQty: 5 })).toBe(true)
    expect(passesUnmappedFilter({ source: 'wapro' }, { minQty: 1 })).toBe(false)
  })

  it('przy progu stanu ukrywa sprzedaże — nie mają stanu WAPRO (zgłoszenie klientki: „powyżej 5 sztuk")', () => {
    expect(passesUnmappedFilter(sale(1), { minQty: 5 })).toBe(false)
    expect(passesUnmappedFilter(sale(10), { minQty: 5 })).toBe(false)
  })

  it('„towary z WAPRO" ukrywa sprzedaże, „sprzedaże" ukrywa towary i ignoruje próg', () => {
    expect(passesUnmappedFilter(sale(1), { kind: 'wapro' })).toBe(false)
    expect(passesUnmappedFilter(wapro(7), { kind: 'wapro', minQty: 5 })).toBe(true)
    expect(passesUnmappedFilter(wapro(7), { kind: 'sales' })).toBe(false)
    expect(passesUnmappedFilter(sale(1), { kind: 'sales', minQty: 20 })).toBe(true)
  })
})
