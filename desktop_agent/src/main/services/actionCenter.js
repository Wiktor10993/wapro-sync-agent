/**
 * Wiring Stateful Sync do Electrona: buduje porty (BaseLinker/Allegro/WAPRO),
 * tworzy lokalną bazę SQLite i instancję SyncOrchestrator, wystawia funkcje dla IPC.
 *
 * electron-vite/esbuild rozwiązuje importy .ts, więc ten plik JS importuje moduł TS.
 */

import path from 'node:path'
import { app } from 'electron'

// UWAGA: LocalDatabase/SyncOrchestrator ładujemy LENIWIE (dynamiczny import),
// bo ciągną natywny `better-sqlite3`. Statyczny import na górze wywalałby cały
// proces główny przy starcie, gdyby moduł nie był jeszcze zbudowany.
import { getPool, sql } from '../wapro/pool.js'
import { fetchStockSnapshot } from '../wapro/inventoryRepository.js'
import * as blApi from './baselinkerApi.js'
import * as allegroSync from './allegroSync.js'
import { getDbSettings, getSchemaMap, getSyncSettings } from '../store.js'

let logger = () => {}
export function setActionCenterLogger(fn) {
  if (typeof fn === 'function') logger = fn
}

// ---------------------------------------------------------------------------
// Porty
// ---------------------------------------------------------------------------

const baselinkerPort = {
  channel: 'baselinker',
  async pushQuantity(offerId, variantId, quantity) {
    // updateInventoryProductsStock rzuca przy błędzie API (kod → sync_errors).
    await blApi.updateInventoryProductsStock(
      [{ product_id: offerId, variant_id: variantId ?? '0', quantity }],
      logger
    )
  },
  async listOffers() {
    const out = []
    for (let page = 1; page <= 100; page++) {
      const products = await blApi.getInventoryProductsList(page, logger)
      const entries = Object.entries(products)
      if (entries.length === 0) break
      for (const [id, p] of entries) {
        out.push({ offerId: String(id), sku: String(p?.sku ?? ''), ean: String(p?.ean ?? ''), name: String(p?.name ?? '') })
      }
      if (entries.length < 1000) break
    }
    return out
  }
}

const allegroPort = {
  channel: 'allegro',
  async pushQuantity(offerId, _variantId, quantity) {
    // setSingleOfferStock rzuca surowym błędem Allegro (status/kod → sync_errors).
    await allegroSync.setSingleOfferStock(offerId, quantity, logger)
  },
  async listOffers() {
    return allegroSync.listOffers(logger)
  }
}

// ---------------------------------------------------------------------------
// MOCK kanałów (do testu na żywo bez realnych kont) — włącz: WAPRO_MOCK_CHANNELS=1
// ---------------------------------------------------------------------------

const MOCK_CHANNELS = process.env.WAPRO_MOCK_CHANNELS === '1'

/** Oferty mocka dopasowane do seedu ARTYKULY (EAN / SKU / nazwa). */
const MOCK_OFFERS = [
  // Przynęta — dopasowanie po EAN; wysyłka CELOWO rzuca błąd (patrz niżej).
  { offerId: 'OFF-FEEDER', sku: '', ean: '5904619771106', name: 'Przynęta Feeder Bait Czinkers DUO 7/10mm' },
  // Wobler — dopasowanie po SKU (INDEKS).
  { offerId: 'OFF-WOB', sku: 'SAL-PER-08F', ean: '', name: 'Wobler Salmo Perch 8cm Floating' },
  // Kulki — bez SKU/EAN w ofercie → dopasowanie po NAZWIE (Fuzzy).
  { offerId: 'OFF-KP16', sku: '', ean: '', name: 'Kulki Proteinowe Truskawka 16mm 1kg' },
  // Oferta wycofana — pasuje po EAN, ale API zawsze zwraca 404 „nie znaleziono".
  // Towar ma 0 szt. → kategoria „0 na stanie (Archiwum)", nie krytyczny błąd.
  { offerId: 'OFF-GONE', sku: '', ean: '5905000000055', name: 'Wobler Wycofany 6cm' }
  // (Podbierak PDB-X nie ma oferty → „Niezmapowany produkt".)
]

function mockChannelPort(channel) {
  // „Zarchiwizowana oferta" — pierwszy push pada, ponowienie (Retry) już przechodzi.
  const failedOnce = new Set()
  return {
    channel,
    async listOffers() {
      logger('info', `[MOCK ${channel}] listOffers → ${MOCK_OFFERS.length} ofert.`)
      return MOCK_OFFERS.map((o) => ({ ...o }))
    },
    async pushQuantity(offerId, _variantId, quantity) {
      // Oferta wycofana — zawsze 404 (przy stanie 0 → „Archiwum", nie błąd krytyczny).
      if (offerId === 'OFF-GONE') {
        const e = new Error('Nie znaleziono oferty (404) — oferta wycofana/zarchiwizowana')
        e.code = 'ERROR_OFFER_NOT_FOUND'
        e.status = 404
        throw e
      }
      // Zarchiwizowana z niezerowym stanem — realny błąd, ale Retry go naprawia.
      if (offerId === 'OFF-FEEDER' && !failedOnce.has(offerId)) {
        failedOnce.add(offerId)
        const e = new Error('Oferta zarchiwizowana (400)')
        e.code = 'ERROR_400'
        e.status = 400
        throw e
      }
      logger('info', `[MOCK ${channel}] pushQuantity ${offerId} = ${quantity} (OK).`)
    }
  }
}

const waproPort = {
  async readSnapshot() {
    const sync = getSyncSettings()
    const rows = await fetchStockSnapshot(getDbSettings(), {
      warehouseIds: sync.warehouseIds,
      subtractReserved: sync.subtractReserved,
      skipArchived: sync.skipArchived,
      aggregateWarehouses: sync.aggregateWarehouses,
      schemaOverrides: getSchemaMap()
    })
    return rows.map((r) => ({ sku: r.sku, ean: r.barcode ?? '', name: r.name ?? '', waproId: null, quantity: r.quantity }))
  },
  async applyDelta({ sku, ean, deltaQty, targetQty, reason }) {
    // Zapis do bufora INTEG.WAPRO_DELTA_BUFOR (rezerwacja/dokument do wciągnięcia w ERP).
    // W produkcji tu wejdą procedury JL_*/AP_* Wapro.
    const pool = await getPool(getDbSettings())
    await pool
      .request()
      .input('sku', sql.VarChar(64), sku)
      .input('ean', sql.VarChar(32), ean || null)
      .input('delta', sql.Int, Math.trunc(deltaQty))
      .input('target', sql.Int, Math.trunc(targetQty))
      .input('reason', sql.NVarChar(200), reason || '')
      .query(`INSERT INTO INTEG.WAPRO_DELTA_BUFOR (SKU, EAN, DELTA_QTY, TARGET_QTY, REASON)
              VALUES (@sku, @ean, @delta, @target, @reason)`)
  }
}

// ---------------------------------------------------------------------------
// Orchestrator (singleton, leniwie)
// ---------------------------------------------------------------------------

let orchestrator = null
let initError = null

async function getOrchestrator() {
  if (orchestrator) return orchestrator
  if (initError) throw initError
  try {
    // Leniwe ładowanie — dopiero tu wciągamy better-sqlite3.
    const { LocalDatabase } = await import('../../sync-engine/state/localDb')
    const { SyncOrchestrator } = await import('../../sync-engine/SyncOrchestrator')
    const dbPath = path.join(app.getPath('userData'), 'sync-buffer.db')
    const db = new LocalDatabase(dbPath)
    const channels = MOCK_CHANNELS
      ? { baselinker: mockChannelPort('baselinker'), allegro: mockChannelPort('allegro') }
      : { baselinker: baselinkerPort, allegro: allegroPort }
    orchestrator = new SyncOrchestrator(
      db,
      { channels, wapro: waproPort },
      { loopGuardCooldownMs: 120_000, log: (level, message) => logger(level, message) }
    )
    logger('info', `Action Center: bufor SQLite w ${dbPath}${MOCK_CHANNELS ? ' [MOCK kanałów AKTYWNY]' : ''}.`)
    return orchestrator
  } catch (err) {
    initError = new Error(
      `Bufor SQLite (better-sqlite3) niedostępny. Uruchom „npm install", a przy niezgodności ABI ` +
        `„npx electron-rebuild -f -w better-sqlite3". Szczegóły: ${err?.message ?? err}`
    )
    throw initError
  }
}

// ---------------------------------------------------------------------------
// API dla IPC (wszystko async — czeka na leniwą inicjalizację)
// ---------------------------------------------------------------------------

export async function scanWapro() {
  return (await getOrchestrator()).scanWapro()
}

/** Symulacja sprzedaży z kanału (przycisk w UI / test). */
export async function simulateSale(channel, event) {
  const o = await getOrchestrator()
  return channel === 'allegro' ? o.onAllegroSale(event) : o.onBaselinkerSale(event)
}

export async function listUnmapped() {
  return (await getOrchestrator()).listUnmapped()
}
export async function listErrors() {
  return (await getOrchestrator()).listErrors()
}
export async function resolveMapping(input) {
  return (await getOrchestrator()).resolveMapping(input)
}
export async function ignoreUnmapped(id) {
  ;(await getOrchestrator()).ignoreUnmapped(Number(id))
  return { ok: true }
}
export async function retryError(id) {
  return (await getOrchestrator()).retryError(Number(id))
}
export async function ignoreError(id) {
  ;(await getOrchestrator()).ignoreError(Number(id))
  return { ok: true }
}
