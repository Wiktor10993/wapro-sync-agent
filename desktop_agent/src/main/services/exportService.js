/**
 * exportService.js — eksport stanów magazynowych do CSV (#1).
 *
 * Zrzuca aktualny snapshot z trzech źródeł (WAPRO / Allegro / BaseLinker) do
 * plików CSV oraz jeden plik „połączony" (side-by-side), żeby od razu było widać
 * rozjazdy. WAPRO jest źródłem prawdy. Allegro: KAŻDE KONTO OSOBNO — osobny plik
 * i osobne kolumny `allegro_<konto>_numer_oferty` / `stan_allegro_<konto>`.
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
import { uniqueAllegroAccounts } from './allegroAuth.js'
import { getBufferDb } from './bufferDb.js'
import {
  BASELINKER_HEADER,
  accountSlug,
  allegroColumnHeader,
  allegroStockHeader,
  buildAccountOfferFinder,
  excelText
} from './mappingCsvCore.js'

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

/**
 * Oferty Allegro OSOBNO dla każdego konta (bez duplikatów loginu) + wyszukiwarka
 * oferty dla pozycji WAPRO (mapowanie oferta → indeks, sygnatura, EAN, nazwa).
 * @returns {Promise<Array<{account:object, offers:object[], offerSku:Map<string,string>, find:(w:object)=>object|null}>>}
 */
export async function loadAllegroByAccount(log = () => {}) {
  const db = await getBufferDb()
  const out = []
  for (const account of await uniqueAllegroAccounts(log)) {
    let offers = []
    try {
      offers = await allegroSync.listOffersWithStock(account.id, log)
    } catch (err) {
      log('warn', `Allegro „${account.label}": pobranie ofert nieudane — konto pominięte w pliku: ${err.message}`)
      continue
    }
    const offerSku = db.offerSkuMap(account.id)
    out.push({ account, offers, offerSku, find: buildAccountOfferFinder(offers, offerSku, allegroSync.normalizeTitle) })
  }
  return out
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
const ALLEGRO_COLS = ['konto_allegro', 'login_allegro', 'numer_oferty', 'sygnatura', 'indeks_wapro', 'ean', 'nazwa', 'stan', 'status', 'zaktualizowano']

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
    log('info', 'Eksport: pobieram oferty Allegro (każde konto osobno)…')
    data.allegro = await loadAllegroByAccount(log)
    for (const acc of data.allegro) {
      const slug = accountSlug(acc.account)
      const file = path.join(folder, `export_allegro_${slug}_${stamp}.csv`)
      const rows = acc.offers.map((o) => [
        acc.account.label,
        acc.account.accountLogin || '',
        excelText(o.offerId),
        o.sku,
        excelText(acc.offerSku.get(String(o.offerId)) ?? ''),
        excelText(o.ean),
        o.name,
        o.quantity,
        o.status,
        iso
      ])
      await fs.writeFile(file, toCsv(ALLEGRO_COLS, rows), 'utf8')
      written.push({ source: `Allegro — ${acc.account.label}`, file, count: rows.length })
      log('success', `Eksport Allegro „${acc.account.label}": ${rows.length} ofert → ${path.basename(file)}`)
    }
  }
  if (want.baselinker) {
    log('info', 'Eksport: pobieram produkty BaseLinker…')
    data.baselinker = await snapshotBaselinker(log)
    const file = path.join(folder, `export_baselinker_${stamp}.csv`)
    await fs.writeFile(file, toCsv(COLS, rowsFor('BaseLinker', data.baselinker, iso)), 'utf8')
    written.push({ source: 'BaseLinker', file, count: data.baselinker.length })
    log('success', `Eksport BaseLinker: ${data.baselinker.length} produktów → ${path.basename(file)}`)
  }

  // Plik połączony: WAPRO obok ofert KAŻDEGO konta Allegro i BaseLinkera. Nagłówki
  // są zgodne z plikiem mapowania — po poprawkach można go wgrać jako mapowanie.
  if (combined && data.wapro) {
    const blIdx = new Map()
    for (const i of data.baselinker ?? []) { const k = joinKey(i); if (k) blIdx.set(k, i) }
    const accs = data.allegro ?? []
    const headers = [
      'indeks_wapro', 'ean', 'nazwa_wapro', 'stan_wapro',
      ...accs.flatMap((a) => [allegroColumnHeader(a.account), allegroStockHeader(a.account)]),
      BASELINKER_HEADER, 'stan_baselinker', 'rozjazd'
    ]
    const rows = data.wapro.map((w) => {
      const k = joinKey(w)
      const b = k ? blIdx.get(k) : null
      const cells = []
      const diffs = []
      for (const a of accs) {
        const o = a.find(w)
        cells.push(excelText(o?.offerId ?? ''), o ? o.quantity : '')
        if (o && Number(o.quantity) !== Number(w.quantity)) diffs.push(accountSlug(a.account))
      }
      if (b && Number(b.quantity) !== Number(w.quantity)) diffs.push('baselinker')
      return [excelText(w.sku), excelText(w.ean), w.name, w.quantity, ...cells, excelText(b?.id ?? ''), b ? b.quantity : '', diffs.join(', ')]
    })
    const file = path.join(folder, `export_polaczony_${stamp}.csv`)
    await fs.writeFile(file, toCsv(headers, rows), 'utf8')
    written.push({ source: 'Połączony', file, count: rows.length })
    log('success', `Eksport połączony: ${rows.length} wierszy, kolumny Allegro: ${accs.map((a) => accountSlug(a.account)).join(', ') || 'brak'} → ${path.basename(file)}`)
  }

  return { folder, files: written }
}
