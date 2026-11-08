/**
 * ignoredItems.js — lista pozycji WAPRO wykluczonych z synchronizacji (v6.8).
 *
 * Zakładka „Ignorowane": operator zaznacza towary, a wysyłka stanów (BaseLinker,
 * każde konto Allegro) i Action Center je pomijają — bez dopasowywania, bez
 * wysyłki, bez wpisów w „Problemy". Lista żyje w lokalnym buforze SQLite.
 */

import { getBufferDb } from './bufferDb.js'
import { snapshotWapro } from './exportService.js'

const CHANNELS = new Set(['*', 'allegro', 'baselinker'])

function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({
      sku: String(it?.sku ?? '').trim(),
      channel: CHANNELS.has(it?.channel) ? it.channel : '*',
      ean: String(it?.ean ?? '').trim(),
      name: String(it?.name ?? '').trim(),
      note: String(it?.note ?? '').trim()
    }))
    .filter((it) => it.sku)
}

export async function listIgnored() {
  const db = await getBufferDb()
  return db.listIgnored()
}

/** Dodaje pozycje. Zwraca { added, total }. */
export async function addIgnored(items, log = () => {}) {
  const clean = cleanItems(items)
  const db = await getBufferDb()
  const added = db.addIgnored(clean)
  if (added > 0) log('info', `Ignorowane: dodano ${added} pozycji — synchronizacja będzie je pomijać.`)
  return { added, total: db.listIgnored().length }
}

/** Usuwa pozycje (wracają do synchronizacji w następnym cyklu). Zwraca { removed, total }. */
export async function removeIgnored(items, log = () => {}) {
  const clean = cleanItems(items)
  const db = await getBufferDb()
  const removed = db.removeIgnored(clean)
  if (removed > 0) log('info', `Ignorowane: przywrócono ${removed} pozycji do synchronizacji.`)
  return { removed, total: db.listIgnored().length }
}

/**
 * Towary z WAPRO do wybrania w zakładce, z informacją, dla jakich kanałów są
 * już ignorowane.
 */
export async function pickList() {
  const [rows, db] = await Promise.all([snapshotWapro(), getBufferDb()])
  const bySku = new Map()
  for (const it of db.listIgnored()) {
    const list = bySku.get(it.sku) ?? []
    list.push(it.channel)
    bySku.set(it.sku, list)
  }
  // Snapshot może mieć kilka wierszy SKU (magazyny) — sumujemy w jedną pozycję.
  const merged = new Map()
  for (const r of rows) {
    if (!r.sku) continue
    const prev = merged.get(r.sku)
    if (prev) prev.quantity += r.quantity
    else merged.set(r.sku, { sku: r.sku, ean: r.ean, name: r.name, quantity: r.quantity, ignored: bySku.get(r.sku) ?? [] })
  }
  return [...merged.values()]
}
