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
import { uniqueAllegroAccounts } from './allegroAuth.js'
import { enrichOffers } from './allegroOfferDetails.js'
import * as restockStore from './restockStore.js'
import * as analytics from './analytics.js'
import { getBufferDb } from './bufferDb.js'
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
  const mapped = rows.map((r) => ({
    idArtykulu: 0,
    sku: r.sku,
    ean: r.barcode ?? '',
    name: r.name ?? '',
    quantity: r.quantity,
    warehouseId: r.warehouseId ?? null
  }))
  // v6: zapis snapshotu do historii sprzedaży (throttlowany, nieblokujący).
  analytics.recordSnapshot(mapped).catch(() => {})
  return mapped
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

function allegroAdapter(accountId, log, label = accountId) {
  const adapter = {
    channel: 'allegro',
    // Osobny klucz Loop Guarda per konto — echo z konta A nie tłumi wysyłki na konto B.
    guardKey: `allegro:${accountId}`,
    /** offerId z ostatniego pobrania — do diagnostyki mapowań spoza kont. */
    lastOfferIds: new Set(),
    async fetchOffers() {
      const offers = await allegroSync.listOffers(accountId, log)
      adapter.lastOfferIds = new Set(offers.map((o) => String(o.offerId)))
      // v6.4: automapowanie — EAN i „Kod producenta" z pełnej oferty (cache).
      return enrichOffers(accountId, offers, log, { label })
    },
    /**
     * #2: WAPRO jest źródłem prawdy.
     *  - stan ≤ 0  → ZAKOŃCZ ofertę (END) i zapisz do obserwacji (restock_watch),
     *  - stan > 0  → jeśli oferta była zakończona, najpierw WZNÓW (ACTIVATE),
     *                a potem ustaw stan; nieodwracalne → „needs_relist".
     */
    async pushStock(items, _batchOptions) {
      const zero = []
      const positive = []
      for (const i of items) {
        if (Math.trunc(Number(i.quantity) || 0) <= 0) zero.push(i)
        else positive.push(i)
      }
      const updatedOfferIds = new Set()

      // 1) Stan > 0 — wznów zakończone oferty, zanim ustawimy stan.
      for (const i of positive) {
        try {
          if (await restockStore.isWatched('allegro', i.offerId)) {
            const ok = await allegroSync.activateOffer(accountId, i.offerId, log)
            if (ok) await restockStore.clearRestock('allegro', i.offerId)
            else await restockStore.flagNeedsRelist({ channel: 'allegro', offerId: i.offerId, sku: i.sku ?? '', ean: i.ean ?? '', quantity: i.quantity })
          }
        } catch (err) {
          log('warn', `Allegro[${accountId}]: wznowienie oferty ${i.offerId} nie powiodło się: ${err?.message ?? err}`)
        }
      }
      // Ustawienie stanów (batchowane + throttling wewnątrz setOffersStock).
      const setUpdated = await allegroSync.setOffersStock(
        accountId,
        positive.map((i) => ({ offerId: i.offerId, quantity: i.quantity })),
        log
      )
      for (const id of setUpdated) updatedOfferIds.add(String(id))

      // 2) Stan ≤ 0 — zakończ ofertę i weź na obserwację do wznowienia.
      for (const i of zero) {
        try {
          await allegroSync.endOffer(accountId, i.offerId, log)
          await restockStore.watchRestock({ channel: 'allegro', offerId: i.offerId, sku: i.sku ?? '', ean: i.ean ?? '' })
        } catch (err) {
          // Oferty już nie ma → i tak traktujemy jako zamkniętą (nie kręcimy w kółko).
          log('info', `Allegro[${accountId}]: oferta ${i.offerId} już zakończona/nieobecna — pomijam (${err?.message ?? err}).`)
        }
        updatedOfferIds.add(String(i.offerId)) // zatwierdź hash: nie kończ jej co cykl
      }

      return { updatedOfferIds }
    }
  }
  return adapter
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

/** Ręczne mapowania (masowy CSV) dla kanału — override produkcyjnej wysyłki. */
async function loadManualOffers(channel, log) {
  try {
    const db = await getBufferDb()
    return db.listManualMappings(channel)
  } catch (err) {
    log('warn', `Mapowania ręczne niedostępne (${channel}): ${err.message}`)
    return []
  }
}

/** Synchronizacja stanów Wapro → BaseLinker przez nowy silnik. */
export async function runBaselinkerSync(log = () => {}) {
  await ensureAuditSchema()
  const manualOffers = await loadManualOffers('baselinker', log)
  const summary = await runInventorySync(
    baselinkerAdapter(log),
    {
      loadSnapshot,
      loadHashes: async () => getStockHashes(),
      saveHashes: async (h) => setStockHashes(h),
      writeLog: (entries) => syncLog.insertMany(entries),
      loopGuard
    },
    { matcher: {}, batch: batchFromSettings(), manualOffers }
  )
  if (summary.stats) {
    const st = summary.stats
    log(
      'info',
      `BaseLinker: produktów w katalogu ${st.offers}, mapowań CSV ${st.manualInAccount}/${st.manualTotal}; zmienione pozycje — ` +
        `ręcznie ${st.viaManual}, EAN ${st.viaEan}, SKU ${st.viaSku}, nazwa ${st.viaName}, bez dopasowania ${st.noMatch}.`
    )
  }
  return summary
}

/**
 * Synchronizacja stanów Wapro → Allegro przez nowy silnik — dla KAŻDEGO
 * autoryzowanego konta (osobne tokeny, osobna mapa ofert, osobne hashe stanów).
 * Zwraca zagregowane podsumowanie.
 */
export async function runAllegroSync(log = () => {}) {
  await ensureAuditSchema()
  // v6.4: bez duplikatów loginu (drugie konto autoryzowane na pierwsze → pomijamy z błędem).
  const accounts = await uniqueAllegroAccounts(log)
  if (accounts.length === 0) {
    log('warn', 'Allegro: brak autoryzowanego konta — pomijam.')
    return { checked: 0, changed: 0, needsReview: 0, errors: 0, accounts: 0 }
  }

  const manualOffers = await loadManualOffers('allegro', log)
  const db = await getBufferDb()
  const agg = { checked: 0, changed: 0, needsReview: 0, errors: 0, accounts: accounts.length }
  const seenOfferIds = new Set()
  let fetchedAll = true
  for (const a of accounts) {
    const adapter = allegroAdapter(a.id, log, a.label)
    try {
      log('info', `Allegro: synchronizacja stanów — konto „${a.label}"${a.accountLogin ? ` (${a.accountLogin})` : ''}.`)
      const summary = await runInventorySync(
        adapter,
        {
          loadSnapshot,
          loadHashes: async () => getAllegroStockHashes(a.id),
          saveHashes: async (h) => setAllegroStockHashes(a.id, h),
          writeLog: (entries) => syncLog.insertMany(entries),
          loopGuard
        },
        {
          matcher: {},
          batch: batchFromSettings(),
          manualOffers,
          // Zapamiętujemy oferta → SKU: zamówienia z ofert bez sygnatury też zdejmą stan WAPRO.
          onMatched: (pairs) => db.saveOfferSkus(a.id, pairs)
        }
      )
      agg.checked += summary.checked ?? 0
      agg.changed += summary.changed ?? 0
      agg.needsReview += summary.needsReview ?? 0
      agg.errors += summary.errors ?? 0
      if (summary.stats) log('info', describeStats(a.label, summary))
      for (const id of adapter.lastOfferIds) seenOfferIds.add(id)
    } catch (err) {
      fetchedAll = false
      agg.errors += 1
      log('error', `Allegro[${a.label}]: synchronizacja nieudana: ${err.message}`)
    }
  }

  // Ręczne mapowania wskazujące aukcje, których nie ma na ŻADNYM podłączonym koncie
  // (np. drugie konto nie jest naprawdę podłączone albo aukcja zarchiwizowana).
  if (fetchedAll && manualOffers.length > 0 && seenOfferIds.size > 0) {
    const missing = manualOffers.filter((m) => !seenOfferIds.has(String(m.offerId)))
    if (missing.length > 0) {
      const sample = missing.slice(0, 5).map((m) => m.offerId).join(', ')
      log(
        'warn',
        `Allegro: ${missing.length} z ${manualOffers.length} aukcji z mapowania CSV nie ma na żadnym podłączonym koncie (np. ${sample}). ` +
          'Sprawdź, czy każde konto Allegro jest autoryzowane na właściwy login.'
      )
    }
  }
  return agg
}

/** Jedna linia diagnostyki konta: skąd dopasowania i dlaczego nic nie poszło. */
function describeStats(label, summary) {
  const st = summary.stats
  return (
    `Allegro „${label}": ofert ${st.offers}, mapowań CSV na tym koncie ${st.manualInAccount}/${st.manualTotal}; ` +
    `zmienione pozycje — ręcznie ${st.viaManual}, EAN ${st.viaEan}, SKU/kod ${st.viaSku}, nazwa ${st.viaName}, ` +
    `do weryfikacji ${summary.needsReview}, bez dopasowania ${st.noMatch}; wysłano ${summary.changed}, błędy ${summary.errors}.`
  )
}

/** Odczyt dziennika dla zakładki UI. */
export async function queryAuditLog(filter = {}) {
  await ensureAuditSchema()
  return syncLog.query(filter)
}
