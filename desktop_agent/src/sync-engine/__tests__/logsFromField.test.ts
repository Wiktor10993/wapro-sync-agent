/**
 * v6.8.1: poprawki po logach od klientki.
 *  - dziennik INTEG_LOG_SYNC nie dopisuje co cykl tych samych „Brak dopasowania",
 *  - mapowanie sprzedaży nieznanej oferty (`oferta:<id>`) zapisuje oferta → indeks WAPRO.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { createLogDeduper } from '../db/logDedupe'
import { LocalDatabase } from '../state/localDb'
import { SyncOrchestrator, type ChannelPort } from '../SyncOrchestrator'
import type { SyncLogEntry } from '../types'

const entry = (over: Partial<SyncLogEntry> = {}): SyncLogEntry => ({
  ts: new Date().toISOString(),
  direction: 'WAPRO_TO_CHANNEL',
  channel: 'allegro',
  sku: 'A1',
  ean: '',
  offerId: null,
  qtyBefore: null,
  qtyAfter: 3,
  status: 'SKIPPED',
  message: 'Brak dopasowania: brak oferty',
  ...over
})

describe('Dziennik — tłumienie powtórek SKIPPED', () => {
  it('ten sam wpis SKIPPED zapisuje raz na okno, SUCCESS/ERROR zawsze', () => {
    let t = 0
    const d = createLogDeduper({ windowMs: 1000, now: () => t })
    expect(d.filter([entry(), entry({ status: 'SUCCESS', message: 'ok' })])).toHaveLength(2)
    // Kolejny cykl: ta sama pozycja bez dopasowania → pomijamy; sukces i błąd przechodzą.
    t = 500
    const second = d.filter([entry(), entry({ status: 'SUCCESS', message: 'ok' }), entry({ status: 'ERROR', message: 'x' })])
    expect(second.map((e) => e.status)).toEqual(['SUCCESS', 'ERROR'])
    // Zmiana stanu → to inna informacja → zapisujemy.
    expect(d.filter([entry({ qtyAfter: 4 })])).toHaveLength(1)
    // Po upływie okna znów zapisujemy (żeby dziennik nie „zapomniał" problemu na zawsze).
    t = 1600
    expect(d.filter([entry()])).toHaveLength(1)
  })

  it('pamięć jest ograniczona', () => {
    const d = createLogDeduper({ maxKeys: 10, now: () => 0 })
    d.filter(Array.from({ length: 50 }, (_, i) => entry({ sku: `S${i}` })))
    expect(d.size()).toBeLessThanOrEqual(10)
  })
})

const openDbs: LocalDatabase[] = []
const newDb = () => {
  const db = new LocalDatabase(':memory:')
  openDbs.push(db)
  return db
}
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
})

describe('Action Center — sprzedaż nieznanej oferty Allegro', () => {
  const makeOrch = (db: LocalDatabase) => {
    const port = (channel: 'allegro' | 'baselinker'): ChannelPort => ({ channel, pushQuantity: vi.fn(async () => {}), listOffers: vi.fn(async () => []) })
    const wapro = { readSnapshot: vi.fn(async () => []), applyDelta: vi.fn(async () => {}) }
    return new SyncOrchestrator(db, { channels: { baselinker: port('baselinker'), allegro: port('allegro') }, wapro })
  }

  it('zapisuje mapowanie oferta → indeks WAPRO widoczne dla Allegro→WAPRO', async () => {
    const db = newDb()
    const orch = makeOrch(db)
    db.enqueueUnmapped({ source: 'allegro', channel: 'allegro', sku: 'oferta:19060020488', ean: '', name: 'Wobler', quantity: 1, reason: '', candidates: [] })

    await orch.resolveMapping({ sku: 'oferta:19060020488', channel: 'allegro', offerId: '19060020488', waproSku: 'WOB-123' })

    expect(db.offerSkuMap('dowolne-konto').get('19060020488')).toBe('WOB-123')
    expect(db.listUnmapped('open')).toEqual([])
  })

  it('odrzuca „mapowanie" oferty na samą siebie (bez indeksu WAPRO)', async () => {
    const db = newDb()
    const orch = makeOrch(db)
    await expect(orch.resolveMapping({ sku: 'oferta:1', channel: 'allegro', offerId: '1' })).rejects.toThrow(/indeks/)
    await expect(orch.resolveMapping({ sku: 'oferta:1', channel: 'allegro', offerId: '1', waproSku: '1' })).rejects.toThrow(/indeks/)
    expect(db.offerSkuMap('x').size).toBe(0)
  })

  it('zignorowana oferta nie wraca do kolejki', () => {
    const db = newDb()
    db.addIgnored([{ sku: 'oferta:777', channel: 'allegro' }])
    expect(db.isIgnored('oferta:777', 'allegro')).toBe(true)
    expect(db.enqueueUnmapped({ source: 'allegro', channel: 'allegro', sku: 'oferta:777', ean: '', name: '', quantity: 1, reason: '', candidates: [] })).toBe(0)
  })
})

describe('„Problemy" zamykają się po udanym dopasowaniu (problem 5)', () => {
  const enqueue = (db: LocalDatabase, sku: string, channel: 'allegro' | 'baselinker', ean = '') =>
    db.enqueueUnmapped({ source: 'wapro', channel, sku, ean, name: sku, quantity: 1, reason: '', candidates: [] })

  it('sprzątanie zamyka wpisy zmapowane CSV, automapowaniem (inne konto) i dla oferta:<id>', () => {
    const db = newDb()
    enqueue(db, 'CSV-1', 'allegro')
    enqueue(db, 'AUTO-1', 'allegro')
    enqueue(db, 'BL-1', 'baselinker')
    enqueue(db, 'EAN-ONLY', 'baselinker', '5900000000001')
    enqueue(db, 'BRAK-1', 'allegro')
    db.enqueueUnmapped({ source: 'allegro', channel: 'allegro', sku: 'oferta:555', ean: '', name: '', quantity: 1, reason: '', candidates: [] })
    db.enqueueUnmapped({ source: 'allegro', channel: 'allegro', sku: 'oferta:999', ean: '', name: '', quantity: 1, reason: '', candidates: [] })

    db.upsertManualMapping({ channel: 'allegro', offerId: '100', sku: 'CSV-1', accountId: 'primary' })
    db.saveOfferSkus('acc_drugie', [{ offerId: '200', sku: 'AUTO-1', via: 'ean' }, { offerId: '555', sku: 'WOB-9', via: 'name' }])
    db.upsertManualMapping({ channel: 'baselinker', offerId: 'P1', sku: 'BL-1' })
    db.upsertManualMapping({ channel: 'baselinker', offerId: 'P2', ean: '5900000000001' })
    // Stare „mapowanie" oferty na samą siebie nie może zamykać innych wpisów.
    db.upsertMapping({ sku: 'oferta:999', channel: 'allegro', offerId: '999' })

    expect(db.closeResolvedUnmapped()).toBe(5)
    expect(db.listUnmapped('open').map((u) => u.sku).sort()).toEqual(['BRAK-1', 'oferta:999'])
    // Idempotentne.
    expect(db.closeResolvedUnmapped()).toBe(0)
  })

  it('udane dopasowanie w synchronizacji zamyka wpis tylko w swoim kanale', () => {
    const db = newDb()
    enqueue(db, 'S1', 'allegro')
    enqueue(db, 'S1', 'baselinker')
    expect(db.resolveUnmappedForSkus('allegro', ['S1', 'S1', ''])).toBe(1)
    expect(db.listUnmapped('open').map((u) => u.channel)).toEqual(['baselinker'])
  })

  it('skan WAPRO nie zgłasza SKU zmapowanego CSV na innym koncie i listUnmapped sprząta', async () => {
    const db = newDb()
    const port = (channel: 'allegro' | 'baselinker'): ChannelPort => ({ channel, pushQuantity: vi.fn(async () => {}), listOffers: vi.fn(async () => []) })
    const al = port('allegro')
    const wapro = {
      readSnapshot: vi.fn(async () => [{ sku: 'CSV-2', ean: '', name: 'Wobler X', waproId: 1, quantity: 4 }]),
      applyDelta: vi.fn(async () => {})
    }
    const orch = new SyncOrchestrator(db, { channels: { baselinker: port('baselinker'), allegro: al }, wapro })
    db.upsertManualMapping({ channel: 'allegro', offerId: '300', sku: 'CSV-2', accountId: 'acc_inne' })

    await orch.scanWapro()
    expect(db.listUnmapped('open').map((u) => `${u.sku}:${u.channel}`)).toEqual(['CSV-2:baselinker'])
    expect(al.pushQuantity).not.toHaveBeenCalled()

    // Mapowanie BL pojawia się później (np. import CSV) → lista sama się czyści.
    db.upsertManualMapping({ channel: 'baselinker', offerId: 'P9', sku: 'CSV-2' })
    expect(orch.listUnmapped()).toEqual([])
  })
})
