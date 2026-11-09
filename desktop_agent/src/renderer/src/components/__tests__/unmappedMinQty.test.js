import { describe, expect, it } from 'vitest'
import { passesMinQty } from '../ActionCenter.jsx'

describe('filtr „Stan WAPRO" w Niezmapowanych', () => {
  const wapro = (quantity) => ({ source: 'wapro', quantity })

  it('„wszystkie" (0) przepuszcza każdą pozycję, także stan 0', () => {
    expect(passesMinQty(wapro(0), 0)).toBe(true)
  })

  it('ukrywa pozycje WAPRO ze stanem poniżej progu', () => {
    expect(passesMinQty(wapro(0), 1)).toBe(false)
    expect(passesMinQty(wapro(1), 2)).toBe(false)
    expect(passesMinQty(wapro(2), 2)).toBe(true)
    expect(passesMinQty(wapro(15), 10)).toBe(true)
  })

  it('brak stanu traktuje jak 0', () => {
    expect(passesMinQty({ source: 'wapro' }, 1)).toBe(false)
  })

  it('sprzedaże z kanału zostają zawsze widoczne', () => {
    expect(passesMinQty({ source: 'allegro', sku: 'oferta:123', quantity: 0 }, 5)).toBe(true)
    expect(passesMinQty({ source: 'baselinker', quantity: 0 }, 1)).toBe(true)
  })
})
