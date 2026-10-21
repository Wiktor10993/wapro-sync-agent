/**
 * v6.4: automapowanie po kodzie producenta / SKU bez separatorów + diagnostyka przebiegu.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildOfferIndex, matchProduct, normalizeSku } from '../matching/productMatcher'
import { runInventorySync, type ChannelAdapter } from '../orchestrator'
import { LoopGuard } from '../sync/loopGuard'
import type { StockRow } from '../types'

describe('matcher — kody dodatkowe', () => {
  const index = buildOfferIndex([
    { offerId: 'A1', sku: '', ean: '', name: 'Atraktor Team Dragon Aniseed', codes: ['00-30-71-30-0125'] },
    { offerId: 'A2', sku: '', ean: '', name: 'Booster Dragon Magnum', codes: ['004012010500'] }
  ])

  it('dopasowuje po kodzie producenta = indeks', () => {
    const m = matchProduct({ sku: '00-30-71-30-0125', ean: '', name: 'cokolwiek' }, index)
    expect(m).toMatchObject({ status: 'MATCHED', offerId: 'A1', via: 'sku' })
  })

  it('dopasowuje kod zapisany bez separatorów', () => {
    const m = matchProduct({ sku: '00-40-12-01-0500', ean: '', name: 'x' }, index)
    expect(m).toMatchObject({ status: 'MATCHED', offerId: 'A2', via: 'sku' })
  })

  it('ten sam kod (po normalizacji) w dwóch ofertach → do weryfikacji, nie strzelamy', () => {
    const dup = buildOfferIndex([
      { offerId: 'B1', sku: '', ean: '', name: 'x', codes: ['KP-77-01'] },
      { offerId: 'B2', sku: '', ean: '', name: 'y', codes: ['KP7701'] }
    ])
    const m = matchProduct({ sku: 'KP 77/01', ean: '', name: 'z' }, dup)
    expect(m.status).toBe('NEEDS_REVIEW')
    expect(m.candidateOfferIds).toEqual(['B1', 'B2'])
  })

  it('krótkie kody nie są normalizowane', () => {
    expect(normalizeSku('A-1')).toBe('')
    expect(normalizeSku('00-30-71')).toBe('003071')
  })
})

describe('orchestrator — statystyki i zapamiętane dopasowania', () => {
  it('raportuje źródła dopasowań i przekazuje pary oferta → SKU', async () => {
    const rows: StockRow[] = [
      { idArtykulu: 1, sku: 'M-0001', ean: '', name: 'Ręczny', quantity: 5, warehouseId: null },
      { idArtykulu: 2, sku: '00-30-71-30-0125', ean: '', name: 'Kodowy', quantity: 7, warehouseId: null },
      { idArtykulu: 3, sku: 'BRAK-999', ean: '', name: 'Zupełnie inny produkt', quantity: 1, warehouseId: null }
    ]
    const adapter: ChannelAdapter = {
      channel: 'allegro',
      guardKey: 'allegro:acc',
      fetchOffers: async () => [
        { offerId: 'OM', sku: '', ean: '', name: 'Oferta ręczna' },
        { offerId: 'OK', sku: '', ean: '', name: 'Oferta kodowa', codes: ['00-30-71-30-0125'] }
      ],
      pushStock: vi.fn(async (items: Array<{ offerId: string }>) => ({ updatedOfferIds: new Set(items.map((i) => i.offerId)) }))
    }
    const onMatched = vi.fn()
    const s = await runInventorySync(
      adapter,
      { loadSnapshot: async () => rows, loadHashes: async () => ({}), saveHashes: async () => {}, writeLog: async () => {}, loopGuard: new LoopGuard() },
      { manualOffers: [{ offerId: 'OM', sku: 'M-0001' }, { offerId: 'NIE-TU', sku: 'X' }], batch: { delayMs: 0 }, onMatched }
    )
    expect(s.changed).toBe(2)
    expect(s.stats).toMatchObject({ offers: 2, manualInAccount: 1, manualTotal: 2, viaManual: 1, viaSku: 1, noMatch: 1 })
    expect(onMatched).toHaveBeenCalledWith([
      { offerId: 'OM', sku: 'M-0001', via: 'manual' },
      { offerId: 'OK', sku: '00-30-71-30-0125', via: 'sku' }
    ])
  })
})
