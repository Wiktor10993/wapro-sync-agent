/**
 * bulkMapping.js — mapowanie produktów z pliku CSV (override wysyłki stanów).
 *
 * Wzorzec ma wiersz na produkt WAPRO i OSOBNĄ kolumnę na numer oferty każdego
 * konta Allegro oraz kolumnę na ID produktu BaseLinker (opis kolumn w pliku
 * *_INSTRUKCJA.txt obok wzorca). Wypełniona komórka = mapujemy ten kanał/konto,
 * pusta = bez zmian. Zapis do `manual_mappings`, którą produkcyjna wysyłka stanów
 * traktuje jako nadrzędne dopasowanie (przed automatem).
 *
 * Logika pliku (kolumny, walidacja, wzorzec) jest w mappingCsvCore.js (testy).
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { parseCsv } from './mappingCsv.js'
import { snapshotWapro, toCsv } from './exportService.js'
import { getBufferDb } from './bufferDb.js'
import { forgetStockHashes, listAllegroAccountsPublic } from '../store.js'
import {
  accountSlug,
  buildTemplate,
  classifyColumns,
  parseMappingRecords,
  templateInstructions
} from './mappingCsvCore.js'

/** Konta Allegro do kolumn wzorca/importu (wszystkie skonfigurowane, równorzędnie). */
function allegroAccounts() {
  return listAllegroAccountsPublic().map((a) => ({ id: a.id, label: a.label, accountLogin: a.accountLogin }))
}

/**
 * Importuje mapowanie z pliku CSV.
 * @returns {Promise<{rows:number, allegro:number, baselinker:number, skipped:number, errors:number,
 *   errorsFile:string|null, perAccount:Record<string,number>, unknownSku:number}>}
 */
export async function importBulkMapping(filePath, log = () => {}) {
  if (!filePath) throw new Error('Nie wskazano pliku CSV.')
  const text = await fs.readFile(filePath, 'utf8')
  const { headers, records } = parseCsv(text)
  if (records.length === 0) throw new Error('Plik CSV nie zawiera wierszy z danymi.')

  const accounts = allegroAccounts()
  const cols = classifyColumns(headers, accounts)
  if (cols.allegro.length === 0 && cols.baselinker.length === 0) {
    throw new Error(
      `Nie znaleziono kolumny z numerem oferty Allegro ani ID BaseLinker (nagłówki: ${headers.join(', ')}). ` +
        'Pobierz aktualny wzorzec i wpisz numery w jego kolumny.'
    )
  }
  if (!cols.sku && !cols.ean) throw new Error('Brak kolumny z indeksem WAPRO (indeks_wapro) ani EAN.')

  const { items, errors, empty } = parseMappingRecords(records, cols)

  // Rozpoznanie produktu w WAPRO (po indeksie, a gdy brak — po EAN). Bez połączenia
  // z WAPRO zapisujemy klucze z pliku tak, jak są.
  let bySku = null
  let byEan = null
  try {
    const wapro = await snapshotWapro()
    bySku = new Map(wapro.map((w) => [String(w.sku).trim().toLowerCase(), w]))
    byEan = new Map(wapro.filter((w) => w.ean).map((w) => [String(w.ean).trim(), w]))
  } catch (err) {
    log('warn', `Mapowanie: brak odczytu WAPRO (${err.message}) — indeksy przyjmuję z pliku bez sprawdzania.`)
  }

  const db = await getBufferDb()
  const seenOffer = new Map() // offerId → linia (ta sama oferta w dwóch wierszach = błąd)
  const touched = { allegro: new Set(), baselinker: new Set() }
  const perAccount = {}
  let allegro = 0
  let baselinker = 0
  let unknownSku = 0

  const tx = db.db.transaction(() => {
    for (const it of items) {
      let sku = it.sku
      let ean = it.ean
      if (bySku) {
        const w = (sku && bySku.get(sku.toLowerCase())) || (ean && byEan.get(ean)) || null
        if (!w) {
          unknownSku++
          errors.push({ line: it.line, sku, message: `produktu ${sku || ean} nie ma w WAPRO — sprawdź indeks` })
          continue
        }
        sku = w.sku
        ean = ean || w.ean || ''
      }

      for (const a of it.allegro) {
        const key = `allegro:${a.offerId}`
        if (seenOffer.has(key)) {
          errors.push({ line: it.line, sku, message: `oferta Allegro ${a.offerId} jest już przypisana w wierszu ${seenOffer.get(key)}` })
          continue
        }
        seenOffer.set(key, it.line)
        db.replaceManualMappingsForSku('allegro', sku, a.accountId)
        db.upsertManualMapping({ channel: 'allegro', offerId: a.offerId, sku, ean, accountId: a.accountId })
        touched.allegro.add(sku)
        allegro++
        const label = accounts.find((x) => x.id === a.accountId)?.label || 'konto nieustalone'
        perAccount[label] = (perAccount[label] ?? 0) + 1
      }
      if (it.baselinker) {
        const key = `baselinker:${it.baselinker}`
        if (seenOffer.has(key)) {
          errors.push({ line: it.line, sku, message: `produkt BaseLinker ${it.baselinker} jest już przypisany w wierszu ${seenOffer.get(key)}` })
        } else {
          seenOffer.set(key, it.line)
          db.replaceManualMappingsForSku('baselinker', sku)
          db.upsertManualMapping({ channel: 'baselinker', offerId: it.baselinker, sku, ean })
          touched.baselinker.add(sku)
          baselinker++
        }
      }
    }
  })
  tx()

  // Zmapowane produkty wyślą stan w najbliższym SyncUp (nawet bez zmiany ilości).
  forgetStockHashes('allegro', touched.allegro)
  forgetStockHashes('baselinker', touched.baselinker)

  let errorsFile = null
  if (errors.length > 0) {
    errors.sort((a, b) => a.line - b.line)
    const parsed = path.parse(filePath)
    errorsFile = path.join(parsed.dir, `${parsed.name}_bledy.csv`)
    try {
      await fs.writeFile(errorsFile, toCsv(['wiersz', 'indeks_wapro', 'problem'], errors.map((e) => [e.line, e.sku, e.message])), 'utf8')
    } catch {
      errorsFile = null
    }
  }

  const accText = Object.entries(perAccount).map(([k, v]) => `${k}: ${v}`).join(', ')
  log(
    errors.length ? 'warn' : 'success',
    `Mapowanie z pliku: Allegro ${allegro}${accText ? ` (${accText})` : ''}, BaseLinker ${baselinker}; ` +
      `bez numerów ${empty}, błędne ${errors.length} (z ${records.length} wierszy)` +
      (errorsFile ? ` — szczegóły: ${path.basename(errorsFile)}` : '') +
      '. Stany zmapowanych produktów pójdą w najbliższej synchronizacji.'
  )
  return { rows: records.length, allegro, baselinker, skipped: empty, errors: errors.length, errorsFile, perAccount, unknownSku }
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

/**
 * Wzorzec: wszystkie produkty WAPRO + kolumna na każde konto Allegro + BaseLinker,
 * wypełniony obecnymi mapowaniami (ręcznymi i automatycznymi), plus instrukcja.
 */
export async function exportBulkTemplate(folder, log = () => {}) {
  if (!folder) throw new Error('Nie wskazano folderu na wzorzec.')
  await fs.mkdir(folder, { recursive: true })
  const wapro = await snapshotWapro()
  const db = await getBufferDb()
  const accounts = allegroAccounts()

  // Obecne mapowania: automatyczne (zapamiętane przy wysyłce), nadpisane ręcznymi.
  const allegroExisting = new Map(accounts.map((a) => [a.id, new Map()]))
  const offerOwner = new Map()
  for (const a of accounts) {
    for (const p of db.listOfferSkus(a.id)) {
      allegroExisting.get(a.id).set(p.sku, { offerId: p.offerId, via: p.via })
      offerOwner.set(p.offerId, a.id)
    }
  }
  const unassigned = new Map()
  for (const m of db.listManualMappingsFull('allegro')) {
    if (!m.sku) continue
    const owner = m.accountId || offerOwner.get(m.offerId) || ''
    if (owner && allegroExisting.has(owner)) allegroExisting.get(owner).set(m.sku, { offerId: m.offerId, via: 'manual' })
    else unassigned.set(m.sku, { offerId: m.offerId, via: 'manual' })
  }
  const columns = [...accounts]
  if (unassigned.size > 0) {
    // Mapowania ze starszych plików, których konta nie da się ustalić — osobna kolumna.
    const pseudo = { id: '__unassigned', label: 'konto nieustalone', accountLogin: 'konto_nieustalone' }
    columns.push(pseudo)
    allegroExisting.set(pseudo.id, unassigned)
  }
  const blExisting = new Map()
  for (const m of db.listManualMappingsFull('baselinker')) if (m.sku) blExisting.set(m.sku, { offerId: m.offerId, via: 'manual' })

  const { headers, rows } = buildTemplate(wapro, columns, { allegro: allegroExisting, baselinker: blExisting })
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
  const file = path.join(folder, `mapowanie_${stamp}.csv`)
  const instr = path.join(folder, `mapowanie_${stamp}_INSTRUKCJA.txt`)
  await fs.writeFile(file, toCsv(headers, rows), 'utf8')
  await fs.writeFile(instr, '﻿' + templateInstructions(columns, path.basename(file)), 'utf8')
  log(
    'success',
    `Wzorzec mapowania: ${rows.length} produktów, kolumny Allegro: ${columns.map((a) => accountSlug(a)).join(', ')} + BaseLinker → ${path.basename(file)} (instrukcja obok).`
  )
  return { file, instructions: instr, count: rows.length }
}
