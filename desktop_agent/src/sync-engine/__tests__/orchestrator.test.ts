/**
 * Testy SyncOrchestrator: scenariusze A / B / C oraz Loop Guard.
 * Uruchom:  npx vitest run src/sync-engine
 *
 * Używa lokalnej bazy SQLite w pamięci (:memory:) + zamockowanych portów.
 * Wymaga zbudowanego better-sqlite3 dla Node (powstaje przy `npm install`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LocalDatabase } from '../state/localDb'
import { SyncOrchestrator, type ChannelPort, type WaproPort } from '../SyncOrchestrator'

const SKU = 'KP-TRU-16'

function channelMock(channel: 'baselinker' | 'allegro'): ChannelPort {
  return {
    channel,
    pushQuantity: vi.fn(async () => {}),
    listOffers: vi.fn(async () => [])
  }
}

let db: LocalDatabase
let bl: ChannelPort
let al: ChannelPort
let wapro: WaproPort
let orch: SyncOrchestrator

beforeEach(() => {
  db = new LocalDatabase(':memory:')
  db.upsertProduct({ sku: SKU, ean: '5901234000032', name: 'Kulki Proteinowe Truskawka 16mm', quantity: 30 })
  db.upsertMapping({ sku: SKU, channel: 'baselinker', offerId: 'BL1' })
  db.upsertMapping({ sku: SKU, channel: 'allegro', offerId: 'AL1' })

  bl = channelMock('baselinker')
  al = channelMock('allegro')
  wapro = { readSnapshot: vi.fn(async () => []), applyDelta: vi.fn(async () => {}) }

  orch = new SyncOrchestrator(db, { channels: { baselinker: bl, allegro: al }, wapro })
})

describe('Scenariusz A — sprzedaż na BaseLinkerze', () => {
  it('schodzi stan lokalnie, pisze do WAPRO i Allegro, pomija BaseLinker', async () => {
    await orch.onBaselinkerSale({ sku: SKU, newQuantity: 25 })

    expect(db.getProductBySku(SKU)!.quantity).toBe(25)
    expect(wapro.applyDelta).toHaveBeenCalledWith(expect.objectContaining({ sku: SKU, deltaQty: -5, targetQty: 25 }))
    expect(al.pushQuantity).toHaveBeenCalledWith('AL1', null, 25)
    expect(bl.pushQuantity).not.toHaveBeenCalled() // źródło pomijamy
  })
})

describe('Scenariusz B — sprzedaż na Allegro', () => {
  it('schodzi stan lokalnie, pisze do WAPRO i BaseLinkera, pomija Allegro', async () => {
    await orch.onAllegroSale({ sku: SKU, soldQuantity: 10 }) // 30 - 10 = 20

    expect(db.getProductBySku(SKU)!.quantity).toBe(20)
    expect(wapro.applyDelta).toHaveBeenCalledWith(expect.objectContaining({ sku: SKU, targetQty: 20 }))
    expect(bl.pushQuantity).toHaveBeenCalledWith('BL1', null, 20)
    expect(al.pushQuantity).not.toHaveBeenCalled()
  })
})

describe('Scenariusz C — skan WAPRO (zmiana fizyczna)', () => {
  it('wykrywa deltę i wysyła TYLKO ją na oba kanały', async () => {
    wapro.readSnapshot = vi.fn(async () => [{ sku: SKU, ean: '5901234000032', name: 'Kulki Proteinowe Truskawka 16mm', waproId: 1, quantity: 40 }])

    const res = await orch.scanWapro()

    expect(res.changed).toBe(1)
    expect(db.getProductBySku(SKU)!.quantity).toBe(40)
    expect(bl.pushQuantity).toHaveBeenCalledWith('BL1', null, 40)
    expect(al.pushQuantity).toHaveBeenCalledWith('AL1', null, 40)
    expect(wapro.applyDelta).not.toHaveBeenCalled() // WAPRO jest źródłem, nie piszemy zwrotnie
  })
})

describe('Loop Guard — ochrona przed pętlą zwrotną', () => {
  it('echo: WAPRO pokazuje wartość, którą właśnie wysłaliśmy → BRAK ponownej wysyłki', async () => {
    // Scenariusz A ustawia lokal=25 i zapisuje applied(baselinker, 25).
    await orch.onBaselinkerSale({ sku: SKU, newQuantity: 25 })
    ;(bl.pushQuantity as any).mockClear()
    ;(al.pushQuantity as any).mockClear()

    // Skaner WAPRO widzi 25 (echo naszego zapisu do WAPRO).
    wapro.readSnapshot = vi.fn(async () => [{ sku: SKU, ean: '', name: '', waproId: 1, quantity: 25 }])
    const res = await orch.scanWapro()

    expect(res.changed).toBe(0)
    expect(bl.pushQuantity).not.toHaveBeenCalled()
    expect(al.pushQuantity).not.toHaveBeenCalled()
  })

  it('prawdziwa zmiana fizyczna w oknie cooldownu (inna wartość) NIE jest tłumiona', async () => {
    await orch.onBaselinkerSale({ sku: SKU, newQuantity: 25 })
    ;(bl.pushQuantity as any).mockClear()
    ;(al.pushQuantity as any).mockClear()

    // WAPRO pokazuje 40 (ktoś fizycznie dołożył) — to NIE echo (25 ≠ 40).
    wapro.readSnapshot = vi.fn(async () => [{ sku: SKU, ean: '', name: '', waproId: 1, quantity: 40 }])
    const res = await orch.scanWapro()

    expect(res.changed).toBe(1)
    expect(db.getProductBySku(SKU)!.quantity).toBe(40)
    expect(bl.pushQuantity).toHaveBeenCalledWith('BL1', null, 40)
  })
})

describe('Kolejka błędów — push kończy się błędem', () => {
  it('błąd kanału trafia do sync_errors, nie ginie', async () => {
    al.pushQuantity = vi.fn(async () => {
      const e = new Error('Oferta zakończona') as any
      e.code = 'ALLEGRO_OFFER_ENDED'
      throw e
    })
    await orch.onBaselinkerSale({ sku: SKU, newQuantity: 25 })

    const errors = db.listErrors('open')
    expect(errors.length).toBe(1)
    expect(errors[0]).toMatchObject({ channel: 'allegro', sku: SKU, errorCode: 'ALLEGRO_OFFER_ENDED', targetQuantity: 25 })
  })
})

describe('Niezmapowany produkt → Action Center', () => {
  it('brak mapowania i brak ofert → wpis w unmapped_queue', async () => {
    db.upsertProduct({ sku: 'NOWY-1', ean: '', name: 'Wobler Nieznany 9cm', quantity: 5 })
    // brak mapowań; listOffers zwraca puste → matcher NO_MATCH
    wapro.readSnapshot = vi.fn(async () => [{ sku: 'NOWY-1', ean: '', name: 'Wobler Nieznany 9cm', waproId: 2, quantity: 5 }])
    await orch.scanWapro()

    const open = db.listUnmapped('open')
    expect(open.some((u) => u.sku === 'NOWY-1')).toBe(true)
  })
})
