import path from 'node:path'
import fs from 'node:fs/promises'
import { fetchStockSnapshot } from '../wapro/inventoryRepository.js'
import { diffSnapshot } from '../wapro/stockDiff.js'
import { buildEcoOrderXml } from '../wapro/ecoXml.js'
import { normalizeOrder, validateOrder } from '../wapro/orderNormalizer.js'
import { ensureStagingSchema, writeOrderToStaging } from '../wapro/orderRepository.js'
import { reflectBufferToXml } from '../wapro/bufferReflector.js'
import * as blApi from './baselinkerApi.js'
import * as allegroSync from './allegroSync.js'
import * as syncEngine from './syncEngine.js'
import {
  getAllegroStockHashes,
  getDbSettings,
  getSchemaMap,
  getStockHashes,
  getSyncSettings,
  markSync,
  setAllegroStockHashes,
  setStockHashes
} from '../store.js'

/**
 * Zadania synchronizacji.
 *
 *  SyncUp   — stany Wapro → BaseLinker i/lub Allegro (bezpośrednio, bez Huba)
 *  SyncDown — zamówienia z BaseLinkera → pliki XML (ECO) LUB tabela pośrednia
 *
 * Oba są chronione flagą „w toku”: scheduler nie uruchomi drugiego przebiegu,
 * dopóki nie skończy się poprzedni. Bez tego wolna baza powoduje nakładanie
 * przebiegów i podwójne wysyłki.
 */

const running = { up: false, upAllegro: false, down: false, reflect: false }

export function isRunning(kind) {
  return running[kind] === true
}

// ===========================================================================
// SyncUp — stany (rdzeń współdzielony przez kanały)
// ===========================================================================

/**
 * Wspólny rdzeń wysyłki stanów. Kanał (BaseLinker/Allegro) wstrzykujemy jako
 * `target`, dzięki czemu logika czytania z Wapro, diffowania i księgowania
 * hashy jest jedna, a różni się wyłącznie funkcja wysyłająca i pamięć hashy.
 *
 * @param {{
 *   name:string, runningKey:string, markKey:string,
 *   getHashes:()=>object, setHashes:(h:object)=>void,
 *   update:(rows:Array, log:Function)=>Promise<{updated:number, unmapped:string[]}>
 * }} target
 */
async function runStockSyncUp(target, log = () => {}) {
  if (running[target.runningKey]) {
    log('warn', `${target.name} SyncUp już trwa — pomijam ten przebieg.`)
    return { skipped: true }
  }
  running[target.runningKey] = true

  try {
    const db = getDbSettings()
    const sync = getSyncSettings()
    const schemaMap = getSchemaMap()

    log('info', `${target.name} SyncUp: pobieram stany z Wapro…`)

    const snapshot = await fetchStockSnapshot(db, {
      warehouseIds: sync.warehouseIds,
      subtractReserved: sync.subtractReserved,
      skipArchived: sync.skipArchived,
      aggregateWarehouses: sync.aggregateWarehouses,
      schemaOverrides: schemaMap
    })

    log('info', `${target.name} SyncUp: odczytano ${snapshot.length} pozycji.`)

    const previous = target.getHashes()
    const { changed, hashes } = diffSnapshot(snapshot, previous)

    if (changed.length === 0) {
      log('info', `${target.name} SyncUp: brak zmian — nic nie wysyłam.`)
      markSync(target.markKey)
      return { sent: 0, changed: 0 }
    }

    log('info', `${target.name} SyncUp: ${changed.length} zmienionych pozycji, wysyłam.`)

    const batchSize = sync.batchSize || 500
    let sent = 0
    // Hashe zapisujemy paczka po paczce — gdy trzecia padnie, pierwsze dwie
    // nie zostaną wysłane ponownie, a trzecia tak.
    const committedHashes = { ...previous }

    for (let i = 0; i < changed.length; i += batchSize) {
      const chunk = changed.slice(i, i + batchSize)
      // Przekazujemy też kod kreskowy i nazwę — kanał Allegro używa ich do
      // wielopoziomowego dopasowania (EAN → SKU → tytuł). BaseLinker ignoruje
      // nadmiarowe pola.
      const payload = chunk.map((r) => ({
        sku: r.sku,
        barcode: r.barcode ?? '',
        name: r.name ?? '',
        quantity: r.quantity
      }))

      const { updated, unmapped } = await target.update(payload, log)
      sent += updated

      // Hash zapisujemy tylko dla kodów FAKTYCZNIE zaktualizowanych. Niedopasowane
      // lub nieudane zostawiamy bez hasha, żeby ponowić w kolejnym cyklu.
      const unmappedSet = new Set(unmapped)
      for (const row of chunk) {
        if (unmappedSet.has(String(row.sku))) continue
        if (hashes[row.sku]) committedHashes[row.sku] = hashes[row.sku]
        else delete committedHashes[row.sku]
      }
      target.setHashes(committedHashes)
    }

    markSync(target.markKey)
    log('success', `${target.name} SyncUp zakończony: zaktualizowano ${sent} pozycji.`)
    return { sent, changed: changed.length }
  } catch (err) {
    log('error', `${target.name} SyncUp nie powiódł się: ${err.message}`)
    throw err
  } finally {
    running[target.runningKey] = false
  }
}

/**
 * Wysyłka stanów na BaseLinker — przez NOWY silnik (orchestrator):
 * delta-sync + matcher (EAN→SKU→nazwa + próg) + batching/retry + loop guard + audyt.
 * Zwraca `SyncSummary` do modala w UI. Zachowujemy flagę `running` dla SYNC_STATUS.
 */
export async function runSyncUp(log = () => {}) {
  if (running.up) {
    log('warn', 'BaseLinker SyncUp już trwa — pomijam.')
    return { skipped: true }
  }
  running.up = true
  try {
    const summary = await syncEngine.runBaselinkerSync(log)
    markSync('up')
    log('success', `BaseLinker: sprawdzono ${summary.checked}, zmieniono ${summary.changed}, do weryfikacji ${summary.needsReview}, błędy ${summary.errors}.`)
    return summary
  } catch (err) {
    log('error', `BaseLinker SyncUp nie powiódł się: ${err.message}`)
    throw err
  } finally {
    running.up = false
  }
}

/** Wysyłka stanów na Allegro — przez nowy silnik (własna pamięć hashy). */
export async function runAllegroSyncUp(log = () => {}) {
  if (running.upAllegro) {
    log('warn', 'Allegro SyncUp już trwa — pomijam.')
    return { skipped: true }
  }
  running.upAllegro = true
  try {
    const summary = await syncEngine.runAllegroSync(log)
    markSync('upAllegro')
    log('success', `Allegro: sprawdzono ${summary.checked}, zmieniono ${summary.changed}, do weryfikacji ${summary.needsReview}, błędy ${summary.errors}.`)
    return summary
  } catch (err) {
    log('error', `Allegro SyncUp nie powiódł się: ${err.message}`)
    throw err
  } finally {
    running.upAllegro = false
  }
}

// ===========================================================================
// SyncDown — zamówienia
// ===========================================================================

export async function runSyncDown(log = () => {}) {
  if (running.down) {
    log('warn', 'SyncDown już trwa — pomijam ten przebieg.')
    return { skipped: true }
  }
  running.down = true

  try {
    const sync = getSyncSettings()

    log('info', 'SyncDown: pobieram zamówienia z BaseLinkera…')
    const rawOrders = await blApi.getOrders({ includeUnconfirmed: false }, log)

    // Ujednolicamy kształt do tego, którego oczekują zapisywacze XML/bufora.
    // Bez Cloud Huba nie ma kolejki ani potwierdzeń — deduplikację robimy
    // lokalnie (istniejący plik XML / rekord w tabeli pośredniej).
    const orders = rawOrders.map((o) => ({
      queue_id: o.order_id,
      external_id: o.order_id,
      source: 'baselinker',
      order: o
    }))
    const counts = { fetched: orders.length }

    if (orders.length === 0) {
      log('info', 'SyncDown: brak nowych zamówień.')
      markSync('down')
      return { written: 0, counts }
    }

    log('info', `SyncDown: otrzymano ${orders.length} zamówień, tryb "${sync.orderMode}".`)

    const result =
      sync.orderMode === 'staging'
        ? await writeOrdersToDatabase(orders, sync, log)
        : await writeOrdersToXml(orders, sync, log)

    markSync('down')
    log(
      result.failed.length ? 'warn' : 'success',
      `SyncDown zakończony: ${result.ok.length} zapisanych, ${result.failed.length} błędów, ${result.duplicates} duplikatów.`
    )

    // W trybie bufora domykamy łańcuch od razu — operator nie musi czekać
    // na kolejny cykl harmonogramu, żeby zamówienie trafiło do Wapro.
    let reflected = null
    if (sync.orderMode === 'staging' && sync.reflectToXml && result.ok.length > 0) {
      try {
        reflected = await runReflector(log)
      } catch (err) {
        // Zamówienia są już bezpiecznie w buforze — nieudany eksport
        // zostanie ponowiony przez harmonogram. Nie cofamy SyncDown.
        log('warn', `Eksport z bufora nie powiódł się, ponowię w następnym cyklu: ${err.message}`)
      }
    }

    return {
      written: result.ok.length,
      failed: result.failed.length,
      duplicates: result.duplicates,
      reflected,
      counts
    }
  } catch (err) {
    log('error', `SyncDown nie powiódł się: ${err.message}`)
    throw err
  } finally {
    running.down = false
  }
}

// ---------------------------------------------------------------------------
// Tryb 1: pliki XML
// ---------------------------------------------------------------------------

async function writeOrdersToXml(orders, sync, log) {
  const folder = sync.xmlOutputFolder
  if (!folder) {
    throw new Error('Nie wskazano folderu na pliki XML (zakładka „Synchronizacja”).')
  }

  await fs.mkdir(folder, { recursive: true })

  const ok = []
  const failed = []
  let duplicates = 0

  for (const entry of orders) {
    try {
      const problems = validateOrder(normalizeOrder(entry.order, entry.source))
      if (problems.length > 0) {
        failed.push({ queueId: entry.queue_id, error: problems.join(' ') })
        log('error', `SyncDown: ${entry.external_id} — ${problems.join(' ')}`)
        continue
      }

      const xml = buildEcoOrderXml(entry.order, entry.source)
      const safeId = String(entry.external_id).replace(/[^A-Za-z0-9._-]/g, '_')
      const file = path.join(folder, `${entry.source}_${safeId}.xml`)

      // Plik już istnieje = zamówienie było już wyeksportowane.
      // Nie nadpisujemy — operator mógł go już wciągnąć do Wapro.
      try {
        await fs.access(file)
        duplicates++
        ok.push({ queueId: entry.queue_id, ref: path.basename(file) })
        log('info', `SyncDown: ${path.basename(file)} już istnieje — pomijam.`)
        continue
      } catch {
        // Plik nie istnieje — zapisujemy.
      }

      // Zapis atomowy: najpierw .tmp, potem rename. Wapro nigdy nie zobaczy
      // pliku w połowie zapisu.
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, xml, 'utf8')
      await fs.rename(tmp, file)

      ok.push({ queueId: entry.queue_id, ref: path.basename(file) })
      log('info', `SyncDown: zapisano ${path.basename(file)}`)
    } catch (err) {
      failed.push({ queueId: entry.queue_id, error: err.message })
      log('error', `SyncDown: zamówienie ${entry.external_id} — ${err.message}`)
    }
  }

  return { ok, failed, duplicates }
}

// ---------------------------------------------------------------------------
// Tryb 2: tabela pośrednia w bazie Wapro
// ---------------------------------------------------------------------------

async function writeOrdersToDatabase(orders, sync, log) {
  const db = getDbSettings()
  const schemaMap = getSchemaMap()

  // Schemat zakładamy leniwie — przy pierwszym zamówieniu, nie przy starcie.
  await ensureStagingSchema(db, log)

  const ok = []
  const failed = []
  let duplicates = 0

  for (const entry of orders) {
    try {
      const result = await writeOrderToStaging(db, entry.order, entry.source, {
        schemaOverrides: schemaMap,
        requireAllMatched: Boolean(sync.requireAllMatched)
      })

      switch (result.status) {
        case 'inserted':
          ok.push({ queueId: entry.queue_id, ref: `INT-${result.id}` })
          log(
            result.unmatchedCount > 0 ? 'warn' : 'info',
            `SyncDown: zapisano ${result.ref} (id=${result.id})` +
              (result.unmatchedCount > 0
                ? `, ${result.unmatchedCount} pozycji bez odpowiednika w kartotece`
                : '')
          )
          break

        case 'duplicate':
          duplicates++
          ok.push({ queueId: entry.queue_id, ref: result.id ? `INT-${result.id}` : result.ref })
          log('info', `SyncDown: ${result.ref} już było w tabeli pośredniej — pomijam.`)
          break

        case 'invalid':
          failed.push({ queueId: entry.queue_id, error: result.problems.join(' ') })
          log('error', `SyncDown: ${result.ref} — ${result.problems.join(' ')}`)
          break

        default:
          failed.push({ queueId: entry.queue_id, error: `Nieoczekiwany status: ${result.status}` })
      }
    } catch (err) {
      failed.push({ queueId: entry.queue_id, error: err.message })
      log('error', `SyncDown: zamówienie ${entry.external_id} — ${err.message}`)
    }
  }

  return { ok, failed, duplicates }
}

/**
 * Podgląd zapisu bez modyfikacji bazy — używany przez przycisk „Symulacja”
 * w GUI, żeby klient mógł zobaczyć efekt przed uruchomieniem trybu bazowego.
 */
export async function dryRunOrder(rawOrder, source) {
  return writeOrderToStaging(getDbSettings(), rawOrder, source, {
    dryRun: true,
    schemaOverrides: getSchemaMap()
  })
}

// ===========================================================================
// Reflektor bufora — „ostatni milimetr”
// ===========================================================================

/**
 * Eksportuje zamówienia z tabeli pośredniej do folderu nasłuchu Wapro.
 *
 * Uruchamiany trzema drogami: automatycznie po SyncDown, cyklicznie
 * z harmonogramu (bufor mógł zostać uzupełniony ręcznie albo poprzedni
 * eksport padł) oraz z przycisku w GUI.
 */
export async function runReflector(log = () => {}, { dryRun = false } = {}) {
  const sync = getSyncSettings()

  // Uwaga na nazewnictwo: `notRun` sygnalizuje, że reflektor w ogóle nie
  // wystartował. Pole `skipped` w wyniku właściwego przebiegu oznacza co innego
  // — liczbę zamówień, dla których plik już istniał.
  if (sync.orderMode !== 'staging') {
    return { notRun: true, reason: 'Reflektor działa tylko w trybie tabeli pośredniej.' }
  }
  if (!sync.reflectToXml && !dryRun) {
    return { notRun: true, reason: 'Eksport z bufora wyłączony w ustawieniach.' }
  }

  if (running.reflect) {
    log('warn', 'Reflektor już pracuje — pomijam ten przebieg.')
    return { notRun: true, reason: 'Poprzedni przebieg wciąż trwa.' }
  }
  running.reflect = true

  try {
    return await reflectBufferToXml(
      getDbSettings(),
      {
        folder: sync.waproWatchFolder,
        requireAllMatched: Boolean(sync.reflectOnlyMatched),
        limit: 200,
        dryRun
      },
      log
    )
  } catch (err) {
    log('error', `Reflektor nie powiódł się: ${err.message}`)
    throw err
  } finally {
    running.reflect = false
  }
}
