/**
 * Loop Guard przy wielu kontach Allegro: wysyłka na konto A nie może tłumić
 * tej samej wartości dla tego samego SKU na koncie B (wspólna instancja guarda).
 */
import { describe, it, expect, vi } from 'vitest'
import { runInventorySync, type ChannelAdapter, type OrchestratorDeps } from '../orchestrator'
import { LoopGuard } from '../sync/loopGuard'
import type { StockRow, SyncLogEntry } from '../types'

const ROW: StockRow = { idArtykulu: 1, sku: 'KP-TRU-16', ean: '5901234000032', name: 'Kulki Proteinowe Truskawka 16mm', quantity: 30, warehouseId: null }

function allegroAccount(accountId: string, offerId: string) {
  const pushStock = vi.fn(async (items: Array<{ offerId: string; quantity: number }>) => ({
    updatedOfferIds: new Set(items.map((i) => String(i.offerId)))
  }))
  const adapter: ChannelAdapter = {
    channel: 'allegro',
    guardKey: `allegro:${accountId}`,
    fetchOffers: async () => [{ offerId, sku: ROW.sku, ean: ROW.ean, name: ROW.name }],
    pushStock
  }
  return { adapter, pushStock }
}

function deps(loopGuard: LoopGuard, logs: SyncLogEntry[]): OrchestratorDeps {
  let hashes: Record<string, string> = {} // osobne hashe per konto (jak w syncEngine.js)
  return {
    loadSnapshot: async () => [ROW],
    loadHashes: async () => hashes,
    saveHashes: async (h) => {
      hashes = h
    },
    writeLog: async (entries) => {
      logs.push(...entries)
    },
    loopGuard
  }
}

describe('Loop Guard — wiele kont Allegro', () => {
  it('to samo SKU i ilość trafia na oba konta w jednym cyklu', async () => {
    const guard = new LoopGuard()
    const a = allegroAccount('acc-A', 'OFFER-A')
    const b = allegroAccount('acc-B', 'OFFER-B')
    const logsA: SyncLogEntry[] = []
    const logsB: SyncLogEntry[] = []

    const sumA = await runInventorySync(a.adapter, deps(guard, logsA))
    const sumB = await runInventorySync(b.adapter, deps(guard, logsB))

    expect(sumA.changed).toBe(1)
    expect(sumB.changed).toBe(1)
    expect(a.pushStock).toHaveBeenCalledWith([{ offerId: 'OFFER-A', variantId: undefined, quantity: 30 }], {})
    expect(b.pushStock).toHaveBeenCalledWith([{ offerId: 'OFFER-B', variantId: undefined, quantity: 30 }], {})
    expect(logsB.some((l) => l.message.includes('Echo'))).toBe(false)
    // W dzienniku zostaje typ SyncChannel, nie klucz guarda.
    expect([...logsA, ...logsB].every((l) => l.channel === 'allegro')).toBe(true)
    expect(sumB.channel).toBe('allegro')
  })

  it('echo nadal tłumione w obrębie jednego konta', async () => {
    const guard = new LoopGuard()
    const a = allegroAccount('acc-A', 'OFFER-A')
    await runInventorySync(a.adapter, deps(guard, []))

    // Nowy zestaw hashy (np. reset) → delta jest, ale guard konta A widzi echo.
    const logs: SyncLogEntry[] = []
    const again = await runInventorySync(a.adapter, deps(guard, logs))

    expect(again.changed).toBe(0)
    expect(a.pushStock).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.message.includes('Echo'))).toBe(true)
  })
})
