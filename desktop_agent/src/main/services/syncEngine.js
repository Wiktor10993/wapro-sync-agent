/**
 * Most między istniejącym agentem (JS) a nowym silnikiem (TypeScript).
 *
 * Reużywa sprawdzone elementy (adaptacyjny odczyt stanów, store, klienci kanałów),
 * a dokłada: ujednolicony matcher (EAN→SKU→nazwa + próg), delta-sync, batching,
 * loop guard i dziennik INTEG_LOG_SYNC. Zwraca `SyncSummary` do modala w UI.
 *
 * electron-vite/esbuild rozwiązuje importy .ts, więc ten plik JS może importować
 * moduł TypeScript wprost.
 */

import { runInventorySync } from '../../sync-engine/orchestrator'
import { LoopGuard } from '../../sync-engine/sync/loopGuard'
import { SyncLog } from '../../sync-engine/db/syncLog'

import { fetchStockSnapshot } from '../wapro/inventoryRepository.js'
import { getPool } from '../wapro/pool.js'
import * as blApi from './baselinkerApi.js'
import * as allegroSync from './allegroSync.js'
import {
  getAllegroStockHashes,
  getDbSettings,
  getIntegrations,
  getSchemaMap,
  getStockHashes,
  getSyncSettings,
  setAllegroStockHashes,
  setStockHashes
} from '../store.js'

// Współdzielone między cyklami (loop guard = pamięć echa + blokada nakładania).
const loopGuard = new LoopGuard()
const syncLog = new SyncLog(() => getPool(getDbSettings()))
let auditReady = false

/** Zakłada schemat dziennika (raz). Wywoływane też przy starcie z index.js. */
export async function ensureAuditSchema() {
  if (auditReady) return
  await syncLog.ensureSchema()
  auditReady = true
}

/** Odczyt stanów z Wapro → kształt StockRow silnika. */
async function loadSnapshot() {
  const sync = getSyncSettings()
  const rows = await fetchStockSnapshot(getDbSettings(), {
    warehouseIds: sync.warehouseIds,
    subtractReserved: sync.subtractReserved,
    skipArchived: sync.skipArchived,
    aggregateWarehouses: sync.aggregateWarehouses,
    schemaOverrides: getSchemaMap()
  })
  return rows.map((r) => ({
    idArtykulu: 0,
    sku: r.sku,
    ean: r.barcode ?? '',
    name: r.name ?? '',
    quantity: r.quantity,
    warehouseId: r.warehouseId ?? null
  }))
}

// ---------------------------------------------------------------------------
// Adaptery kanałów
// ---------------------------------------------------------------------------

function baselinkerAdapter(log) {
  return {
    channel: 'baselinker',
    async fetchOffers() {
      const out = []
      for (let page = 1; page <= 100; page++) {
        const products = await blApi.getInventoryProductsList(page, log)
        const entries = Object.entries(products)
        if (entries.length === 0) break
        for (const [id, p] of entries) {
          out.push({ offerId: String(id), sku: String(p?.sku ?? ''), ean: String(p?.ean ?? ''), name: String(p?.name ?? '') })
        }
        if (entries.length < 1000) break
      }
      return out
    },
    async pushStock(items, batchOptions) {
      const { updated } = await blApi.updateInventoryProductsStock(
        items.map((i) => ({ product_id: i.offerId, variant_id: i.variantId ?? '0', quantity: i.quantity })),
        log
      )
      // BaseLinker aktualizuje paczkę atomowo — sukces = wszystkie zaktualizowane.
      const set = new Set()
      if (updated > 0) for (const i of items) set.add(String(i.offerId))
      return { updatedOfferIds: set }
    }
  }
}

function allegroAdapter(log) {
  return {
    channel: 'allegro',
    async fetchOffers() {
      return allegroSync.listOffers(log)
    },
    async pushStock(items, _batchOptions) {
      const updatedOfferIds = await allegroSync.setOffersStock(
        items.map((i) => ({ offerId: i.offerId, quantity: i.quantity })),
        log
      )
      return { updatedOfferIds }
    }
  }
}

// ---------------------------------------------------------------------------
// Publiczne wejścia — zwracają SyncSummary
// ---------------------------------------------------------------------------

function batchFromSettings() {
  const sync = getSyncSettings()
  return {
    batchSize: Math.max(50, Math.min(1000, Number(sync.batchSize) || 500)),
    delayMs: Number(sync.batchDelayMs) || 300,
    concurrency: 1,
    retries: 4,
    retryBaseMs: 1000
  }
}

/** Synchronizacja stanów Wapro → BaseLinker przez nowy silnik. */
export async function runBaselinkerSync(log = () => {}) {
  await ensureAuditSchema()
  return runInventorySync(
    baselinkerAdapter(log),
    {
      loadSnapshot,
      loadHashes: async () => getStockHashes(),
      saveHashes: async (h) => setStockHashes(h),
      writeLog: (entries) => syncLog.insertMany(entries),
      loopGuard
    },
    { matcher: {}, batch: batchFromSettings() }
  )
}

/** Synchronizacja stanów Wapro → Allegro przez nowy silnik. */
export async function runAllegroSync(log = () => {}) {
  await ensureAuditSchema()
  return runInventorySync(
    allegroAdapter(log),
    {
      loadSnapshot,
      loadHashes: async () => getAllegroStockHashes(),
      saveHashes: async (h) => setAllegroStockHashes(h),
      writeLog: (entries) => syncLog.insertMany(entries),
      loopGuard
    },
    { matcher: {}, batch: batchFromSettings() }
  )
}

/** Odczyt dziennika dla zakładki UI. */
export async function queryAuditLog(filter = {}) {
  await ensureAuditSchema()
  return syncLog.query(filter)
}
