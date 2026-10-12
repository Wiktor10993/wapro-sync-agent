/**
 * bulkMapping.js — masowe mapowanie ręczne z CSV (override wysyłki stanów).
 *
 * Operator wgrywa JEDEN plik CSV, gdzie dla produktu podaje klucz (SKU/indeks lub
 * EAN) oraz numer aukcji Allegro i/lub numer produktu BaseLinker. Zapisujemy to do
 * `manual_mappings`, którą PRODUKCYJNA wysyłka stanów traktuje jako nadrzędne
 * dopasowanie (przed fuzzy). Dla Allegro wiele kont działa automatycznie — numer
 * aukcji należy do jednego konta, więc trafia tam, gdzie powinien.
 *
 * Parser jest elastyczny: rozpoznaje różne nazwy kolumn (polskie i angielskie).
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { parseCsv } from './mappingCsv.js'
import { snapshotWapro, toCsv } from './exportService.js'
import { getBufferDb } from './bufferDb.js'

// Aliasy nagłówków (po lowercase + trim). Pierwszy znaleziony wygrywa.
const KEY_SKU = ['sku', 'indeks', 'indeks_katalogowy', 'indeks_handlowy', 'symbol', 'kod_towaru', 'kod']
const KEY_EAN = ['ean', 'kod_kreskowy', 'gtin', 'barcode']
const KEY_ALLEGRO = ['allegro', 'allegro_offer_id', 'allegro_nr_aukcji', 'nr_aukcji', 'aukcja', 'oferta', 'offer_id', 'allegro_id']
const KEY_BASE = ['baselinker', 'baselinker_product_id', 'base', 'nr_base', 'base_product_id', 'product_id', 'bl_id', 'magazyn_base']

function pick(rec, aliases) {
  for (const a of aliases) {
    const v = rec[a]
    if (v != null && String(v).trim() !== '') return String(v).trim()
  }
  return ''
}

/**
 * Importuje masowe mapowanie z pliku CSV.
 * @returns {Promise<{rows:number, allegro:number, baselinker:number, skipped:number}>}
 */
export async function importBulkMapping(filePath, log = () => {}) {
  if (!filePath) throw new Error('Nie wskazano pliku CSV.')
  const text = await fs.readFile(filePath, 'utf8')
  const { records } = parseCsv(text)
  if (records.length === 0) throw new Error('Plik CSV nie zawiera wierszy z danymi.')

  const db = await getBufferDb()
  let allegro = 0
  let baselinker = 0
  let skipped = 0

  const tx = db.db.transaction((rows) => {
    for (const rec of rows) {
      const sku = pick(rec, KEY_SKU)
      const ean = pick(rec, KEY_EAN)
      const allegroId = pick(rec, KEY_ALLEGRO)
      const baseId = pick(rec, KEY_BASE)

      if (!sku && !ean) { skipped++; continue } // brak klucza — nie wiadomo co mapować
      if (!allegroId && !baseId) { skipped++; continue } // brak numeru oferty

      if (allegroId) { db.upsertManualMapping({ channel: 'allegro', offerId: allegroId, sku, ean }); allegro++ }
      if (baseId) { db.upsertManualMapping({ channel: 'baselinker', offerId: baseId, sku, ean }); baselinker++ }
    }
  })
  tx(records)

  log('success', `Masowe mapowanie: Allegro ${allegro}, BaseLinker ${baselinker} (pominięto ${skipped} z ${records.length} wierszy).`)
  return { rows: records.length, allegro, baselinker, skipped }
}

/** Ile mapowań jest zapisanych (per kanał). */
export async function bulkMappingCounts() {
  const db = await getBufferDb()
  return { allegro: db.countManualMappings('allegro'), baselinker: db.countManualMappings('baselinker') }
}

/** Czyści mapowania (kanał albo wszystko). */
export async function clearBulkMapping(channel) {
  const db = await getBufferDb()
  db.clearManualMappings(channel || undefined)
  return bulkMappingCounts()
}

/** Wzorcowy CSV z pozycjami WAPRO i pustymi kolumnami na numery ofert. */
export async function exportBulkTemplate(folder, log = () => {}) {
  if (!folder) throw new Error('Nie wskazano folderu na wzorzec.')
  await fs.mkdir(folder, { recursive: true })
  const wapro = await snapshotWapro()
  const headers = ['indeks_katalogowy', 'ean', 'nazwa', 'allegro_nr_aukcji', 'baselinker_product_id']
  const rows = wapro.map((w) => [w.sku, w.ean, w.name, '', ''])
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
  const file = path.join(folder, `mapowanie_masowe_wzorzec_${stamp}.csv`)
  await fs.writeFile(file, toCsv(headers, rows), 'utf8')
  log('success', `Wzorzec masowego mapowania: ${rows.length} pozycji → ${path.basename(file)}`)
  return { file, count: rows.length }
}
