/**
 * deadStockReport.js — analiza katalogu: martwe/brakujące stany, braki EAN (#2, #3, #4).
 *
 * Porównuje WAPRO (źródło prawdy) z ofertami Allegro ORAZ produktami BaseLinkera.
 * Dopasowanie: EAN → SKU → znormalizowana nazwa. Kategorie:
 *   - missingAllegro : WAPRO stan >0 i BRAK na Allegro,
 *   - missingBase    : WAPRO stan >0 i BRAK na BaseLinkerze,
 *   - dead           : WAPRO stan 0 i BRAK na obu kanałach,
 *   - noEan          : WAPRO bez kodu EAN (barki po starym Allegro),
 *   - mismatchAllegro/mismatchBase : jest oferta, ale stan kanału ≠ WAPRO.
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import * as allegroSync from './allegroSync.js'
import { snapshotWapro, snapshotBaselinker, toCsv } from './exportService.js'

/** Indeks pozycji kanału po EAN / SKU / nazwie (nazwa niejednoznaczna → null). */
function buildIndex(items) {
  const byEan = new Map()
  const bySku = new Map()
  const byName = new Map()
  for (const it of items) {
    if (it.ean) byEan.set(String(it.ean).trim(), it)
    if (it.sku) bySku.set(String(it.sku).trim().toLowerCase(), it)
    const n = allegroSync.normalizeTitle(it.name ?? '')
    if (n) byName.set(n, byName.has(n) ? null : it)
  }
  return { byEan, bySku, byName }
}

function findIn(idx, w) {
  if (w.ean && idx.byEan.has(String(w.ean).trim())) return idx.byEan.get(String(w.ean).trim())
  if (w.sku && idx.bySku.has(String(w.sku).trim().toLowerCase())) return idx.bySku.get(String(w.sku).trim().toLowerCase())
  const n = allegroSync.normalizeTitle(w.name ?? '')
  if (n && idx.byName.get(n)) return idx.byName.get(n)
  return null
}

/**
 * Buduje pełny raport katalogu.
 * @returns {{missingAllegro:[],missingBase:[],dead:[],noEan:[],mismatchAllegro:[],mismatchBase:[],counts:{}}}
 */
export async function buildReport(log = () => {}) {
  log('info', 'Raport katalogu: pobieram WAPRO…')
  const wapro = await snapshotWapro()
  log('info', 'Raport katalogu: pobieram oferty Allegro…')
  const allegro = await allegroSync.listOffersWithStock(log)
  log('info', 'Raport katalogu: pobieram produkty BaseLinker…')
  let base = []
  try {
    base = await snapshotBaselinker(log)
  } catch (err) {
    log('warn', `BaseLinker niedostępny — pomijam kolumnę Base: ${err?.message ?? err}`)
  }

  const aIdx = buildIndex(allegro)
  const bIdx = buildIndex(base)

  const missingAllegro = []
  const missingBase = []
  const dead = []
  const noEan = []
  const mismatchAllegro = []
  const mismatchBase = []

  for (const w of wapro) {
    const a = findIn(aIdx, w)
    const b = findIn(bIdx, w)
    const base_ = { sku: w.sku, ean: w.ean, name: w.name, waproQty: w.quantity }

    if (!w.ean) noEan.push({ ...base_, onAllegro: !!a, onBase: !!b })

    if (w.quantity > 0 && !a) missingAllegro.push(base_)
    if (w.quantity > 0 && !b) missingBase.push(base_)
    if (w.quantity <= 0 && !a && !b) dead.push(base_)

    if (a && Number(a.quantity) !== Number(w.quantity)) mismatchAllegro.push({ ...base_, channelQty: a.quantity, offerId: a.offerId ?? a.id })
    if (b && Number(b.quantity) !== Number(w.quantity)) mismatchBase.push({ ...base_, channelQty: b.quantity, offerId: b.id ?? b.offerId })
  }

  const counts = {
    wapro: wapro.length,
    allegro: allegro.length,
    base: base.length,
    missingAllegro: missingAllegro.length,
    missingBase: missingBase.length,
    dead: dead.length,
    noEan: noEan.length,
    mismatchAllegro: mismatchAllegro.length,
    mismatchBase: mismatchBase.length
  }
  log(
    'success',
    `Raport katalogu: brak na Allegro ${counts.missingAllegro}, brak na Base ${counts.missingBase}, bez EAN ${counts.noEan}, martwe ${counts.dead}.`
  )
  return { missingAllegro, missingBase, dead, noEan, mismatchAllegro, mismatchBase, counts }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

/** Zapisuje raport do plików CSV (po jednym na kategorię). */
export async function exportReport(folder, log = () => {}) {
  if (!folder) throw new Error('Nie wskazano folderu docelowego raportu.')
  await fs.mkdir(folder, { recursive: true })
  const rep = await buildReport(log)
  const s = stamp()
  const written = []

  const write = async (name, headers, rows) => {
    const file = path.join(folder, `${name}_${s}.csv`)
    await fs.writeFile(file, toCsv(headers, rows), 'utf8')
    written.push({ kind: name, file, count: rows.length })
  }

  await write('braki_allegro', ['sku', 'ean', 'nazwa', 'stan_wapro'], rep.missingAllegro.map((r) => [r.sku, r.ean, r.name, r.waproQty]))
  await write('braki_baselinker', ['sku', 'ean', 'nazwa', 'stan_wapro'], rep.missingBase.map((r) => [r.sku, r.ean, r.name, r.waproQty]))
  await write('bez_ean', ['sku', 'nazwa', 'stan_wapro', 'na_allegro', 'na_base'], rep.noEan.map((r) => [r.sku, r.name, r.waproQty, r.onAllegro ? 'TAK' : '', r.onBase ? 'TAK' : '']))
  await write('martwe', ['sku', 'ean', 'nazwa', 'stan_wapro'], rep.dead.map((r) => [r.sku, r.ean, r.name, r.waproQty]))

  return { folder, files: written, counts: rep.counts }
}
