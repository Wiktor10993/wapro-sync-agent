import cron from 'node-cron'
import { runAllegroSyncUp, runReflector, runSyncDown, runSyncUp } from './syncService.js'
import { getSyncSettings } from '../store.js'

/**
 * Harmonogram zadań tła.
 *
 * node-cron przyjmuje wyrażenia cron; interwał minutowy z ustawień zamieniamy
 * na `*&#47;N * * * *`. Dla N > 59 przechodzimy na wyrażenie godzinowe,
 * bo `*&#47;90` w polu minut nie ma sensu.
 */

let tasks = []
let statusEmitter = null

function intervalToCron(minutes) {
  const m = Math.max(1, Math.floor(Number(minutes) || 1))
  if (m < 60) return `*/${m} * * * *`
  const hours = Math.max(1, Math.round(m / 60))
  return `0 */${Math.min(23, hours)} * * *`
}

export function startScheduler(log, emitStatus) {
  stopScheduler()
  statusEmitter = emitStatus

  const sync = getSyncSettings()

  if (!sync.enabled) {
    log('info', 'Harmonogram wyłączony w ustawieniach.')
    emitStatus?.({ schedulerRunning: false })
    return { running: false }
  }

  const upExpr = intervalToCron(sync.inventoryIntervalMinutes)
  const downExpr = intervalToCron(sync.ordersIntervalMinutes)

  const guard = (name, fn) => async () => {
    try {
      await fn(log)
    } catch (err) {
      // Wyjątek w callbacku crona nie może zabić procesu main.
      log('error', `${name}: ${err.message}`)
    } finally {
      emitStatus?.({ lastRun: { task: name, at: new Date().toISOString() } })
    }
  }

  tasks = [
    cron.schedule(upExpr, guard('SyncUp', runSyncUp), { scheduled: true }),
    cron.schedule(downExpr, guard('SyncDown', runSyncDown), { scheduled: true })
  ]

  // Kanał Allegro (opcjonalny) — wysyłka stanów wprost na Allegro w tym samym
  // interwale co stany BaseLinkera. Ma własną pamięć hashy, więc nie koliduje.
  let allegroExpr = null
  if (sync.allegroStockEnabled) {
    allegroExpr = upExpr
    tasks.push(cron.schedule(allegroExpr, guard('Allegro SyncUp', runAllegroSyncUp), { scheduled: true }))
  }

  // Kolejne zadanie tylko w trybie bufora: sprząta po nieudanych eksportach
  // i wychwytuje wiersze dodane do bufora poza agentem.
  let reflectExpr = null
  if (sync.orderMode === 'staging' && sync.reflectToXml) {
    reflectExpr = intervalToCron(sync.reflectIntervalMinutes ?? 5)
    tasks.push(cron.schedule(reflectExpr, guard('Reflektor', runReflector), { scheduled: true }))
  }

  log(
    'success',
    `Harmonogram uruchomiony — stany co ${sync.inventoryIntervalMinutes} min, ` +
      `zamówienia co ${sync.ordersIntervalMinutes} min` +
      (allegroExpr ? `, stany Allegro co ${sync.inventoryIntervalMinutes} min` : '') +
      (reflectExpr ? `, eksport bufora co ${sync.reflectIntervalMinutes ?? 5} min.` : '.')
  )
  emitStatus?.({ schedulerRunning: true, upExpr, downExpr, allegroExpr, reflectExpr })

  return { running: true, upExpr, downExpr, allegroExpr, reflectExpr }
}

export function stopScheduler() {
  for (const t of tasks) {
    try {
      t.stop()
    } catch {
      /* ignorujemy */
    }
  }
  tasks = []
  statusEmitter?.({ schedulerRunning: false })
  return { running: false }
}

export function isSchedulerRunning() {
  return tasks.length > 0
}
