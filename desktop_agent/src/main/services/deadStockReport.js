/**
 * deadStockReport.js — analiza katalogu: martwe/brakujące stany, braki EAN (#2, #3, #4).
 *
 * Porównuje WAPRO (źródło prawdy) z ofertami KAŻDEGO konta Allegro osobno ORAZ
 * produktami BaseLinkera. Dopasowanie Allegro: mapowanie oferta → indeks
 * (CSV / automapowanie) → sygnatura → EAN → nazwa. Kategorie:
 *   - missingAllegroByAccount : WAPRO stan >0 i BRAK na danym koncie Allegro
 *     (missingAllegro = brak na co najmniej jednym koncie, z listą kont),
 *   - missingBase    : WAPRO stan >0 i BRAK na BaseLinkerze,
 *   - dead           : WAPRO stan 0 i BRAK na obu kanałach,
 *   - noEan          : WAPRO bez kodu EAN (barki po starym Allegro),
 *   - mismatchAllegro/mismatchBase : jest oferta, ale stan kanału ≠ WAPRO.
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import * as allegroSync from './allegroSync.js'
import { loadAllegroByAccount, snapshotWapro, snapshotBaselinker, toCsv } from './exportService.js'
import { BASELINKER_HEADER, accountSlug, allegroColumnHeader, excelText } from './mappingCsvCore.js'

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
 * Buduje pełny raport katalogu. Allegro liczone OSOBNO dla każdego konta —
 * „brak na Allegro" znaczy brak na danym koncie, a nie na obu łącznie.
 * @returns {{accounts:[], missingAllegro:[], missingAllegroByAccount:{}, missingBase:[], dead:[], noEan:[],
 *   mismatchAllegro:[], mismatchBase:[], counts:{}}}
 */
export async function buildReport(log = () => {}) {
  log('info', 'Raport katalogu: pobieram WAPRO…')
  const wapro = await snapshotWapro()
  log('info', 'Raport katalogu: pobieram oferty Allegro (każde konto osobno)…')
  const allegro = await loadAllegroByAccount(log)
  log('info', 'Raport katalogu: pobieram produkty BaseLinker…')
  let base = []
  try {
    base = await snapshotBaselinker(log)
  } catch (err) {
    log('warn', `BaseLinker niedostępny — pomijam kolumnę Base: ${err?.message ?? err}`)
  }

  const bIdx = buildIndex(base)
  const accounts = allegro.map((a) => ({ id: a.account.id, label: a.account.label, accountLogin: a.account.accountLogin || '', slug: accountSlug(a.account) }))

  const missingAllegro = []
  const missingAllegroByAccount = Object.fromEntries(accounts.map((a) => [a.id, []]))
  const missingBase = []
  const dead = []
  const noEan = []
  const mismatchAllegro = []
  const mismatchBase = []

  for (const w of wapro) {
    const b = findIn(bIdx, w)
    const offers = {} // accountId → offerId
    const missingOn = []
    const row = { sku: w.sku, ean: w.ean, name: w.name, waproQty: w.quantity, allegro: offers, baseId: b ? b.id : '' }

    for (const acc of allegro) {
      const o = acc.find(w)
      if (o) {
        offers[acc.account.id] = o.offerId
        if (Number(o.quantity) !== Number(w.quantity)) {
          mismatchAllegro.push({ ...row, account: acc.account.label, channelQty: o.quantity, offerId: o.offerId })
        }
      } else if (w.quantity > 0) {
        missingOn.push(acc.account.label)
        missingAllegroByAccount[acc.account.id].push(row)
      }
    }
    const onAllegro = Object.keys(offers).length > 0

    if (!w.ean) noEan.push({ ...row, onAllegro, onBase: !!b })
    if (missingOn.length > 0) missingAllegro.push({ ...row, missingOn })
    if (w.quantity > 0 && !b) missingBase.push(row)
    if (w.quantity <= 0 && !onAllegro && !b) dead.push(row)
    if (b && Number(b.quantity) !== Number(w.quantity)) mismatchBase.push({ ...row, channelQty: b.quantity, offerId: b.id })
  }

  const counts = {
    wapro: wapro.length,
    allegro: allegro.reduce((n, a) => n + a.offers.length, 0),
    base: base.length,
    missingAllegro: missingAllegro.length,
    missingBase: missingBase.length,
    dead: dead.length,
    noEan: noEan.length,
    mismatchAllegro: mismatchAllegro.length,
    mismatchBase: mismatchBase.length
  }
  for (const a of accounts) counts[`missingAllegro:${a.id}`] = missingAllegroByAccount[a.id].length

  const perAcc = accounts.map((a) => `${a.label} ${counts[`missingAllegro:${a.id}`]}`).join(', ')
  log(
    'success',
    `Raport katalogu: brak na Allegro — ${perAcc || 'brak kont'}; brak na Base ${counts.missingBase}, bez EAN ${counts.noEan}, martwe ${counts.dead}.`
  )
  return { accounts, missingAllegro, missingAllegroByAccount, missingBase, dead, noEan, mismatchAllegro, mismatchBase, counts }
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

  // Kolumny numerów ofert każdego konta (nagłówki jak w pliku mapowania).
  const accHeaders = rep.accounts.map((a) => allegroColumnHeader(a))
  const accCells = (r) => rep.accounts.map((a) => excelText(r.allegro?.[a.id] ?? ''))
  const head = ['indeks_wapro', 'ean', 'nazwa_wapro', 'stan_wapro']
  const base = (r) => [excelText(r.sku), excelText(r.ean), r.name, r.waproQty]

  for (const a of rep.accounts) {
    // Brak na TYM koncie; obok numery z pozostałych kont (np. do wystawienia/zmapowania).
    await write(`braki_allegro_${a.slug}`, [...head, ...accHeaders, BASELINKER_HEADER], rep.missingAllegroByAccount[a.id].map((r) => [...base(r), ...accCells(r), excelText(r.baseId)]))
  }
  await write('braki_baselinker', [...head, ...accHeaders, BASELINKER_HEADER], rep.missingBase.map((r) => [...base(r), ...accCells(r), '']))
  await write('bez_ean', [...head, ...accHeaders, BASELINKER_HEADER], rep.noEan.map((r) => [...base(r), ...accCells(r), excelText(r.baseId)]))
  await write('martwe', head, rep.dead.map(base))
  await write(
    'rozjazdy_allegro',
    ['konto_allegro', 'numer_oferty', ...head, 'stan_allegro'],
    rep.mismatchAllegro.map((r) => [r.account, excelText(r.offerId), ...base(r), r.channelQty])
  )

  return { folder, files: written, counts: rep.counts }
}
