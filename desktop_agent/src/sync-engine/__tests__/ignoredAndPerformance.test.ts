/**
 * v6.8: lista „Ignorowane" + przyspieszone dopasowanie po nazwie.
 *  - szybki matcher daje DOKŁADNIE te same decyzje co pełne porównanie N×M,
 *  - wysyłka stanów pomija ignorowane pozycje i nie zatwierdza ich hashy,
 *  - pamięć dopasowań nie liczy niezmienionych pozycji drugi raz,
 *  - „Ignoruj" w Action Center działa trwale (pozycja nie wraca po skanie).
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { buildOfferIndex, matchProduct, DEFAULT_MATCHER_OPTIONS } from '../matching/productMatcher'
import { nameSimilarity, paramsMatch } from '../matching/normalize'
import { runInventorySync, type ChannelAdapter, type MatchCache, type OrchestratorDeps } from '../orchestrator'
import { LoopGuard } from '../sync/loopGuard'
import { LocalDatabase } from '../state/localDb'
import { SyncOrchestrator, type ChannelPort } from '../SyncOrchestrator'
import type { OfferCandidate, StockRow } from '../types'

// --- dane testowe (deterministyczne) ---------------------------------------
let seed = 7
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
const words = ['Wobler', 'Ripper', 'Bladebite', 'Salmo', 'Perch', 'Fire', 'Craw', 'Kulki', 'Truskawka', 'Hot', 'Olive', 'Pro', 'Natural', 'UV']
const units = ['g', 'cm', 'mm', 'kg']
const randomName = () =>
  `${pick(words)} ${pick(words)} ${pick(words)}${rnd() < 0.5 ? ` ${pick(words)}` : ''} ${Math.floor(rnd() * 20) + 1}${pick(units)}`

/** Referencja: dopasowanie po nazwie dokładnie jak przed v6.8 (każdy z każdym). */
function bruteForceByName(name: string, offers: OfferCandidate[]) {
  const o = DEFAULT_MATCHER_OPTIONS
  let best: { id: string; score: number } | null = null
  let second = 0
  for (const cand of offers) {
    if (!paramsMatch(name, cand.name)) continue
    const score = nameSimilarity(name, cand.name)
    if (!best || score > best.score) {
      second = best ? best.score : second
      best = { id: cand.offerId, score }
    } else if (score > second) second = score
  }
  if (!best || best.score < o.nameThreshold) return { status: 'NO_MATCH' }
  if (best.score - second < o.nameMargin) return { status: 'NEEDS_REVIEW' }
  return { status: 'MATCHED', offerId: best.id }
}

describe('Szybkie dopasowanie po nazwie', () => {
  it('daje te same decyzje co pełne porównanie każdy z każdym', () => {
    const offers: OfferCandidate[] = Array.from({ length: 400 }, (_, i) => ({ offerId: `O${i}`, sku: '', ean: '', name: randomName() }))
    // Druga, prawie identyczna oferta dla części nazw → „wymaga weryfikacji".
    for (let i = 0; i < 30; i++) offers.push({ offerId: `D${i}`, sku: '', ean: '', name: `${offers[i].name} ` })
    const index = buildOfferIndex(offers)
    const names = [
      ...offers.slice(0, 150).map((o) => o.name.split(' ').reverse().join(' ')), // ta sama oferta, inna kolejność
      ...offers.slice(150, 200).map((o) => o.name.replace(/o/, '0')), // literówka
      ...Array.from({ length: 200 }, randomName)
    ]
    const statuses = new Set<string>()
    for (const name of names) {
      const fast = matchProduct({ sku: '', ean: '', name }, index)
      const ref = bruteForceByName(name, offers)
      statuses.add(ref.status)
      expect({ name, status: fast.status, offerId: fast.status === 'MATCHED' ? fast.offerId : undefined }).toEqual({
        name,
        status: ref.status,
        offerId: ref.status === 'MATCHED' ? ref.offerId : undefined
      })
    }
    // Dane pokrywają wszystkie gałęzie decyzji.
    expect(statuses).toEqual(new Set(['MATCHED', 'NEEDS_REVIEW', 'NO_MATCH']))
  })
})

// --- wysyłka stanów (runInventorySync) ----------------------------------------
const ROWS: StockRow[] = [
  { idArtykulu: 1, sku: 'BB-FC-14G', ean: '', name: 'Bladebite Fire Craw 14g', quantity: 5, warehouseId: null },
  { idArtykulu: 2, sku: 'BB-FC-9G', ean: '', name: 'Bladebite Fire Craw 9g', quantity: 0, warehouseId: null }
]

function setup(ignored: Set<string> = new Set()) {
  const pushStock = vi.fn(async (items: Array<{ offerId: string }>) => ({ updatedOfferIds: new Set(items.map((i) => i.offerId)) }))
  const adapter: ChannelAdapter = {
    channel: 'allegro',
    fetchOffers: async () => ROWS.map((r, i) => ({ offerId: `OF${i}`, sku: r.sku, ean: '', name: r.name })),
    pushStock
  }
  let hashes: Record<string, string> = {}
  const deps: OrchestratorDeps = {
    loadSnapshot: async () => ROWS,
    loadHashes: async () => hashes,
    saveHashes: async (h) => {
      hashes = h
    },
    writeLog: async () => {},
    loopGuard: new LoopGuard({ cooldownMs: 0 })
  }
  const isIgnored = (row: StockRow) => ignored.has(row.sku)
  return { adapter, deps, pushStock, isIgnored, hashes: () => hashes }
}

describe('Wysyłka stanów — lista „Ignorowane"', () => {
  it('pomija ignorowane pozycje i nie zatwierdza ich hasha', async () => {
    const ignored = new Set(['BB-FC-9G'])
    const s = setup(ignored)
    const sum = await runInventorySync(s.adapter, s.deps, { isIgnored: s.isIgnored })

    expect(sum.changed).toBe(1)
    expect(sum.stats?.ignored).toBe(1)
    expect(s.pushStock).toHaveBeenCalledTimes(1)
    expect(s.pushStock.mock.calls[0][0]).toEqual([{ offerId: 'OF0', variantId: undefined, quantity: 5 }])
    expect(Object.keys(s.hashes())).toEqual(['BB-FC-14G'])

    // Po usunięciu z listy pozycja wysyła się w następnym cyklu.
    ignored.clear()
    const sum2 = await runInventorySync(s.adapter, s.deps, { isIgnored: s.isIgnored })
    expect(sum2.changed).toBe(1)
    expect(s.pushStock.mock.calls[1][0]).toEqual([{ offerId: 'OF1', variantId: undefined, quantity: 0 }])
  })
})

describe('Pamięć dopasowań między cyklami', () => {
  it('zapamiętuje wynik i czyści go, gdy zmienią się oferty', async () => {
    const s = setup()
    const cache: MatchCache = { results: new Map() }
    // Pozycja bez dopasowania wraca w każdym cyklu (hash niezatwierdzony).
    s.adapter.fetchOffers = async () => [{ offerId: 'X', sku: 'INNY', ean: '', name: 'Zupełnie inna oferta 1kg' }]
    await runInventorySync(s.adapter, s.deps, { matchCache: cache })
    const fp = cache.fingerprint
    expect(cache.results.size).toBe(2)
    expect([...cache.results.values()].every((m) => m.status === 'NO_MATCH')).toBe(true)

    await runInventorySync(s.adapter, s.deps, { matchCache: cache })
    expect(cache.fingerprint).toBe(fp)

    s.adapter.fetchOffers = async () => [{ offerId: 'OF0', sku: 'BB-FC-14G', ean: '', name: 'Bladebite Fire Craw 14g' }]
    const sum = await runInventorySync(s.adapter, s.deps, { matchCache: cache })
    expect(cache.fingerprint).not.toBe(fp)
    expect(sum.changed).toBe(1)
  })
})

// --- Action Center (SyncOrchestrator + bufor SQLite) ------------------------
// Bazy zamykamy po każdym teście — otwarty uchwyt better-sqlite3 potrafi wywalić
// wątek vitest przy zamykaniu (segfault).
const openDbs: LocalDatabase[] = []
const newDb = () => {
  const db = new LocalDatabase(':memory:')
  openDbs.push(db)
  return db
}
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
})

describe('Action Center — „Ignoruj" działa trwale', () => {
  it('zignorowana pozycja trafia na listę i nie wraca po kolejnym skanie', async () => {
    const db = newDb()
    const port = (channel: 'allegro' | 'baselinker'): ChannelPort => ({ channel, pushQuantity: vi.fn(async () => {}), listOffers: vi.fn(async () => []) })
    const al = port('allegro')
    const bl = port('baselinker')
    let qty = 5
    const wapro = {
      readSnapshot: vi.fn(async () => [{ sku: 'NOWY-1', ean: '', name: 'Wobler Nieznany 9cm', waproId: 2, quantity: qty }]),
      applyDelta: vi.fn(async () => {})
    }
    const orch = new SyncOrchestrator(db, { channels: { baselinker: bl, allegro: al }, wapro })

    await orch.scanWapro()
    const open = db.listUnmapped('open')
    expect(open.length).toBe(2) // po jednym wpisie na kanał

    // Masowe „Ignoruj zaznaczone".
    expect(orch.ignoreUnmapped(open.map((u) => u.id))).toBe(2)
    expect(db.listUnmapped('open')).toEqual([])
    expect(db.listIgnored().map((i) => `${i.sku}:${i.channel}`).sort()).toEqual(['NOWY-1:allegro', 'NOWY-1:baselinker'])

    // Zmiana stanu w WAPRO → skan → pozycja NIE wraca do „Problemy".
    qty = 7
    await orch.scanWapro()
    expect(db.listUnmapped('open')).toEqual([])
    expect(al.pushQuantity).not.toHaveBeenCalled()

    // Przywrócenie z listy → kolejny skan znów ją pokazuje.
    db.removeIgnored([{ sku: 'NOWY-1', channel: 'allegro' }, { sku: 'NOWY-1', channel: 'baselinker' }])
    qty = 8
    await orch.scanWapro()
    expect(db.listUnmapped('open').length).toBe(2)
  })

  it('wpis „wszystkie kanały" zamyka otwarte pozycje obu kanałów', () => {
    const db = newDb()
    db.enqueueUnmapped({ source: 'wapro', channel: 'allegro', sku: 'A1', ean: '', name: 'x', quantity: 1, reason: '', candidates: [] })
    db.enqueueUnmapped({ source: 'wapro', channel: 'baselinker', sku: 'A1', ean: '', name: 'x', quantity: 1, reason: '', candidates: [] })
    expect(db.addIgnored([{ sku: 'A1' }, { sku: 'A1' }, { sku: '  ' }])).toBe(1)
    expect(db.listUnmapped('open')).toEqual([])
    expect(db.ignoredSkus('allegro').has('A1')).toBe(true)
    expect(db.ignoredSkus('baselinker').has('A1')).toBe(true)
  })
})
