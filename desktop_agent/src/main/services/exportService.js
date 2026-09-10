/**
 * exportService.js — eksport stanów magazynowych do CSV (#1).
 *
 * Zrzuca aktualny snapshot z trzech źródeł (WAPRO / Allegro / BaseLinker) do
 * plików CSV oraz jeden plik „połączony" (side-by-side po EAN/SKU), żeby od razu
 * było widać rozjazdy. WAPRO jest źródłem prawdy.
 *
 * CSV: separator „;" (polski Excel), UTF-8 z BOM (poprawne polskie znaki),
 * pola z „;"/cudzysłowem/nową linią cytowane wg RFC 4180.
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { fetchStockSnapshot } from '../wapro/inventoryRepository.js'
import * as allegroSync from './allegroSync.js'
import * as blApi from './baselinkerApi.js'
import { getDbSettings, getSchemaMap, getSyncSettings } from '../store.js'

const BOM = '﻿'

/** Cytowanie pojedynczej komórki CSV (separator „;"). */
function cell(v) {
  const s = v == null ? '' : String(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Buduje CSV z nagłówków i wierszy (tablice wartości). */
export function toCsv(headers, rows) {
  const head = headers.map(cell).join(';')
  const body = rows.map((r) => r.map(cell).join(';')).join('\r\n')
  return BOM + head + '\r\n' + body + '\r\n'
}

/** Suma stanu z pola BaseLinkera (bywa liczbą albo mapą magazyn→ilość). */
function blStock(p) {
  const s = p?.stock ?? p?.quantity
  if (s == null) return 0
  if (typeof s === 'number') return s
  if (typeof s === 'object') return Object.values(s).reduce((a, b) => a + (Number(b) || 0), 0)
  return Number(s) || 0
}

// --- snapshoty ---------------------------------------------------------------

export async function snapshotWapro() {
  const sync = getSyncSettings()
  const rows = await fetchStockSnapshot(getDbSettings(), {
    warehouseIds: sync.warehouseIds,
    subtractReserved: sync.subtractReserved,
    skipArchived: sync.skipArchived,
    aggregateWarehouses: sync.aggregateWarehouses,
    schemaOverrides: getSchemaMap()
  })
  return rows.map((r) => ({
    id: r.sku,
    sku: r.sku,
    ean: r.barcode ?? '',
    name: r.name ?? '',
    quantity: Math.trunc(Number(r.quantity) || 0),
    warehouse: r.warehouseId ?? ''
  }))
}

export async function snapshotAllegro(log = () => {}) {
  const offers = await allegroSync.listOffersWithStock(log)
  return offers.map((o) => ({
    id: o.offerId,
    sku: o.sku ?? '',
    ean: o.ean ?? '',
    name: o.name ?? '',
    quantity: Math.trunc(Number(o.quantity) || 0),
    warehouse: 'allegro'
  }))
}

export async function snapshotBaselinker(log = () => {}) {
  const out = []
  for (let page = 1; page <= 200; page++) {
    const products = await blApi.getInventoryProductsList(page, log)
    const entries = Object.entries(products)
    if (entries.length === 0) break
    for (const [id, p] of entries) {
      out.push({
        id: String(id),
        sku: String(p?.sku ?? ''),
        ean: String(p?.ean ?? ''),
        name: String(p?.name ?? p?.text_fields?.name ?? ''),
        quantity: Math.trunc(blStock(p)),
        warehouse: 'baselinker'
      })
    }
    if (entries.length < 1000) break
  }
  return out
}

const COLS = ['zrodlo', 'id_oferty_sku', 'ean', 'nazwa', 'stan', 'magazyn', 'zaktualizowano']

function rowsFor(source, items, now) {
  return items.map((i) => [source, i.id, i.ean, i.name, i.quantity, i.warehouse, now])
}

/** Klucz łączenia: EAN, a gdy brak — SKU (wielkość liter bez znaczenia). */
function joinKey(i) {
  return (i.ean && String(i.ean).trim()) || (i.sku && String(i.sku).trim().toLowerCase()) || null
}

// --- główne wejście ----------------------------------------------------------

/**
 * Eksportuje wybrane źródła do folderu. Zwraca listę zapisanych plików.
 * @param {{folder:string, sources?:{wapro?:boolean, allegro?:boolean, baselinker?:boolean}, combined?:boolean}} opts
 */
export async function exportStocks({ folder, sources = {}, combined = true } = {}, log = () => {}) {
  if (!folder) throw new Error('Nie wskazano folderu docelowego eksportu.')
  await fs.mkdir(folder, { recursive: true })

  const want = {
    wapro: sources.wapro !== false,
    allegro: sources.allegro !== false,
    baselinker: sources.baselinker !== false
  }
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  const iso = now.toISOString()
  const written = []

  const data = {}
  if (want.wapro) {
    log('info', 'Eksport: pobieram stany WAPRO…')
    data.wapro = await snapshotWapro()
    const file = path.join(folder, `export_wapro_${stamp}.csv`)
    await fs.writeFile(file, toCsv(COLS, rowsFor('WAPRO', data.wapro, iso)), 'utf8')
    written.push({ source: 'WAPRO', file, count: data.wapro.length })
    log('success', `Eksport WAPRO: ${data.wapro.length} pozycji → ${path.basename(file)}`)
  }
  if (want.allegro) {
    log('info', 'Eksport: pobieram oferty Allegro…')
    data.allegro = await snapshotAllegro(log)
    const file = path.join(folder, `export_allegro_${stamp}.csv`)
    await fs.writeFile(file, toCsv(COLS, rowsFor('Allegro', data.allegro, iso)), 'utf8')
    written.push({ source: 'Allegro', file, count: data.allegro.length })
    log('success', `Eksport Allegro: ${data.allegro.length} ofert → ${path.basename(file)}`)
  }
  if (want.baselinker) {
    log('info', 'Eksport: pobieram produkty BaseLinker…')
    data.baselinker = await snapshotBaselinker(log)
    const file = path.join(folder, `export_baselinker_${stamp}.csv`)
    await fs.writeFile(file, toCsv(COLS, rowsFor('BaseLinker', data.baselinker, iso)), 'utf8')
    written.push({ source: 'BaseLinker', file, count: data.baselinker.length })
    log('success', `Eksport BaseLinker: ${data.baselinker.length} produktów → ${path.basename(file)}`)
  }

  // Plik połączony: WAPRO obok stanów kanałów po kluczu EAN/SKU.
  if (combined && data.wapro) {
    const idx = { allegro: new Map(), baselinker: new Map() }
    for (const i of data.allegro ?? []) { const k = joinKey(i); if (k) idx.allegro.set(k, i) }
    for (const i of data.baselinker ?? []) { const k = joinKey(i); if (k) idx.baselinker.set(k, i) }
    const headers = ['ean', 'sku', 'nazwa', 'stan_wapro', 'stan_allegro', 'stan_baselinker', 'rozjazd']
    const rows = data.wapro.map((w) => {
      const k = joinKey(w)
      const a = k ? idx.allegro.get(k) : null
      const b = k ? idx.baselinker.get(k) : null
      const aq = a ? a.quantity : ''
      const bq = b ? b.quantity : ''
      const diff = (a && a.quantity !== w.quantity) || (b && b.quantity !== w.quantity) ? 'TAK' : ''
      return [w.ean, w.sku, w.name, w.quantity, aq, bq, diff]
    })
    const file = path.join(folder, `export_polaczony_${stamp}.csv`)
    await fs.writeFile(file, toCsv(headers, rows), 'utf8')
    written.push({ source: 'Połączony', file, count: rows.length })
    log('success', `Eksport połączony: ${rows.length} wierszy → ${path.basename(file)}`)
  }

  return { folder, files: written }
}
