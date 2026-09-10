/**
 * mappingCsv.js — mapowanie produktów kanał↔WAPRO przez plik CSV (#3).
 *
 * Model: WAPRO to magazyn nadrzędny; aplikacja trzyma „magazyn pośredni"
 * (channel_mappings + products w SQLite). Operator pobiera wzorcowy CSV
 * (wiersze z WAPRO), uzupełnia kolumny `allegro_offer_id` i
 * `baselinker_product_id`, wgrywa z powrotem. Import:
 *   - dopasowuje wiersz do WAPRO po INDEKS (SKU) lub EAN,
 *   - zapisuje mapowanie do channel_mappings (klucz sku → oferta kanału),
 *   - wiersze bez odpowiednika w WAPRO trafiają do phantom_products
 *     („baza produktów które nie istnieją") — do decyzji w Action Center.
 *
 * Import jest addytywny i idempotentny (upsert), bezpieczny do wielokrotnego wgrania.
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { snapshotWapro, toCsv } from './exportService.js'
import { getBufferDb } from './bufferDb.js'

const TEMPLATE_HEADERS = [
  'wapro_id',
  'indeks_katalogowy',
  'ean',
  'nazwa',
  'wapro_stan',
  'allegro_offer_id',
  'baselinker_product_id'
]

// --- wzorcowy CSV ------------------------------------------------------------

/** Buduje wzorcowy CSV z aktualnego stanu WAPRO (2 ostatnie kolumny puste). */
export async function exportTemplate(folder, log = () => {}) {
  if (!folder) throw new Error('Nie wskazano folderu na wzorzec CSV.')
  await fs.mkdir(folder, { recursive: true })
  const wapro = await snapshotWapro()
  const rows = wapro.map((w) => [w.id, w.sku, w.ean, w.name, w.quantity, '', ''])
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  const file = path.join(folder, `mapping_wzorzec_${stamp}.csv`)
  await fs.writeFile(file, toCsv(TEMPLATE_HEADERS, rows), 'utf8')
  log('success', `Wzorzec mapowania: ${rows.length} pozycji → ${path.basename(file)}`)
  return { file, count: rows.length }
}

// --- parser CSV (separator „;" lub ",", cudzysłowy RFC 4180, BOM) ------------

export function parseCsv(text) {
  let s = String(text ?? '')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1) // BOM
  // Wykryj separator z pierwszej linii nagłówka.
  const firstLine = s.slice(0, s.search(/\r?\n/) >= 0 ? s.search(/\r?\n/) : s.length)
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','

  const rows = []
  let field = ''
  let row = []
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === sep) { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = [] }
    else if (c === '\r') { /* pomiń, \n domknie wiersz */ }
    else field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  if (rows.length === 0) return { headers: [], records: [] }

  const headers = rows[0].map((h) => h.trim().toLowerCase())
  const records = rows.slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, k) => [h, (r[k] ?? '').trim()])))
  return { headers, records }
}

// --- import ------------------------------------------------------------------

/**
 * Importuje mapowanie z pliku CSV. Wybór kanału decyduje, które kolumny są brane
 * pod uwagę (#4): { allegro?:bool, baselinker?:bool } — domyślnie oba.
 * @returns podsumowanie.
 */
export async function importMapping(filePath, options = {}, log = () => {}) {
  if (!filePath) throw new Error('Nie wskazano pliku CSV z mapowaniem.')
  const useAllegro = options?.channels?.allegro !== false
  const useBaselinker = options?.channels?.baselinker !== false
  if (!useAllegro && !useBaselinker) throw new Error('Nie wybrano żadnego kanału do zmapowania.')
  const text = await fs.readFile(filePath, 'utf8')
  const { records } = parseCsv(text)
  if (records.length === 0) throw new Error('Plik CSV nie zawiera wierszy z danymi.')

  // Indeks WAPRO po SKU i EAN — do rozpoznania, czy produkt istnieje.
  const wapro = await snapshotWapro()
  const bySku = new Map()
  const byEan = new Map()
  for (const w of wapro) {
    if (w.sku) bySku.set(String(w.sku).trim().toLowerCase(), w)
    if (w.ean) byEan.set(String(w.ean).trim(), w)
  }

  const db = await getBufferDb()
  let mappedAllegro = 0
  let mappedBaselinker = 0
  let phantom = 0
  let skipped = 0

  const tx = db.db.transaction((rows) => {
    for (const rec of rows) {
      const sku = String(rec.indeks_katalogowy ?? rec.sku ?? '').trim()
      const ean = String(rec.ean ?? '').trim()
      // Respektuj wybór kanału — pomijamy kolumnę niewybranego kanału.
      const allegro = useAllegro ? String(rec.allegro_offer_id ?? '').trim() : ''
      const baselinker = useBaselinker ? String(rec.baselinker_product_id ?? '').trim() : ''
      if (!allegro && !baselinker) { skipped++; continue } // nic do zmapowania

      const w = (sku && bySku.get(sku.toLowerCase())) || (ean && byEan.get(ean)) || null
      if (w) {
        if (allegro) { db.upsertMapping({ sku: w.sku, channel: 'allegro', offerId: allegro, via: 'manual', confidence: 1 }); mappedAllegro++ }
        if (baselinker) { db.upsertMapping({ sku: w.sku, channel: 'baselinker', offerId: baselinker, via: 'manual', confidence: 1 }); mappedBaselinker++ }
        // upewnij się, że produkt istnieje w magazynie pośrednim
        db.upsertProduct({ sku: w.sku, ean: w.ean, name: w.name, quantity: w.quantity })
      } else {
        // brak w WAPRO → produkt-widmo
        db.upsertPhantom({ sku, ean, name: String(rec.nazwa ?? '').trim(), allegroOfferId: allegro, baselinkerProductId: baselinker })
        phantom++
      }
    }
  })
  tx(records)

  log(
    'success',
    `Import mapowania: Allegro ${mappedAllegro}, BaseLinker ${mappedBaselinker}, widma ${phantom}, pominięte ${skipped} (z ${records.length} wierszy).`
  )
  return { rows: records.length, mappedAllegro, mappedBaselinker, phantom, skipped }
}

export async function listPhantom() {
  return (await getBufferDb()).listPhantom('open')
}

export async function resolvePhantom(id, action) {
  const db = await getBufferDb()
  db.setPhantomStatus(Number(id), action === 'ignore' ? 'ignored' : 'resolved')
  return { ok: true }
}
