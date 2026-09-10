/**
 * analytics.js — silnik historii sprzedaży i analityki (v6).
 *
 * Dwa źródła sprzedaży (wybór operatora: „oba"):
 *   1) spadki stanu WAPRO między snapshotami  → source 'wapro_delta'
 *      (źródło prawdy, łapie też sprzedaż stacjonarną, bez podwójnego liczenia),
 *   2) historyczne zamówienia BaseLinker/Allegro → source 'baselinker'/'allegro'
 *      (dane „od ręki", zanim uzbiera się historia WAPRO).
 *
 * Prędkość liczymy z WAPRO, gdy mamy pokrycie ≥3 dni snapshotów; wcześniej
 * z zamówień kanałów. Dzięki temu nie dublujemy sprzedaży w okresie nakładania.
 *
 * Pochodne metryki: prędkość (szt./dzień), trend (7 dni vs poprzednie 7),
 * dni zapasu = stan / prędkość.
 */

import { getBufferDb } from './bufferDb.js'
import { snapshotWapro } from './exportService.js'
import * as blApi from './baselinkerApi.js'
import { fetchAllegroOrders } from './allegroAuth.js'

const DAY = 86_400_000
const SNAPSHOT_MIN_INTERVAL_MS = 60 * 60 * 1000 // najwyżej 1 snapshot/godzinę
const RETENTION_DAYS = 120

/**
 * Zapisuje snapshot stanów WAPRO i wyprowadza sprzedaż jako spadki stanu.
 * Throttling: pomija, jeśli ostatni snapshot < 1h temu. Nieblokujące — wołane z sync.
 */
export async function recordSnapshot(rows, log = () => {}) {
  try {
    const db = await getBufferDb()
    const lastAt = (db.db.prepare('SELECT MAX(at_ms) AS m FROM stock_history').get())?.m ?? 0
    if (Date.now() - Number(lastAt) < SNAPSHOT_MIN_INTERVAL_MS) return { skipped: true }

    const prev = db.latestStockMap()
    const now = Date.now()
    const deltas = []
    for (const r of rows) {
      const before = prev.get(r.sku)
      if (before != null && r.quantity < before) {
        deltas.push({ sku: r.sku, ean: r.ean ?? '', qty: before - r.quantity, source: 'wapro_delta', ref: `${r.sku}:${now}`, atMs: now })
      }
    }
    if (deltas.length) db.recordSales(deltas)
    db.recordStockSnapshot(rows.map((r) => ({ sku: r.sku, quantity: r.quantity })))
    db.pruneHistory(now - RETENTION_DAYS * DAY)
    return { recorded: rows.length, sales: deltas.length }
  } catch (err) {
    log('warn', `Historia stanów: nie zapisano snapshotu (${err?.message ?? err}).`)
    return { error: String(err?.message ?? err) }
  }
}

/** Pobiera historyczne zamówienia z kanałów i zapisuje jako sprzedaż (dedup). */
export async function ingestOrders({ days = 60 } = {}, log = () => {}) {
  const db = await getBufferDb()
  const sinceSec = Math.floor((Date.now() - days * DAY) / 1000)
  let bl = 0
  let al = 0

  // --- BaseLinker ---
  try {
    const orders = await blApi.getOrders({ dateFrom: sinceSec, includeUnconfirmed: true }, log)
    const events = []
    for (const o of orders ?? []) {
      const atMs = Number(o?.date_add ?? o?.date_confirmed ?? Date.now() / 1000) * 1000
      for (const p of o?.products ?? []) {
        const sku = String(p?.sku ?? '').trim()
        const ean = String(p?.ean ?? '').trim()
        if (!sku && !ean) continue
        events.push({ sku, ean, qty: Number(p?.quantity) || 0, source: 'baselinker', ref: `${o.order_id}:${sku || p?.order_product_id || ean}`, atMs })
      }
    }
    bl = db.recordSales(events)
  } catch (err) {
    log('warn', `Ingest BaseLinker: ${err?.message ?? err}`)
  }

  // --- Allegro ---
  try {
    const forms = await fetchAllegroOrders({ limit: 100, status: '' }, log)
    const events = []
    for (const f of forms ?? []) {
      const atMs = Date.parse(f?.lineItems?.[0]?.boughtAt ?? f?.updatedAt ?? f?.revision?.createdAt ?? '') || Date.now()
      for (const li of f?.lineItems ?? []) {
        const sku = String(li?.offer?.external?.id ?? '').trim()
        if (!sku) continue
        events.push({ sku, ean: '', qty: Number(li?.quantity) || 0, source: 'allegro', ref: `${f.id}:${li?.id ?? sku}`, atMs })
      }
    }
    al = db.recordSales(events)
  } catch (err) {
    log('warn', `Ingest Allegro: ${err?.message ?? err}`)
  }

  log('success', `Historia sprzedaży: dodano ${bl} pozycji z BaseLinker, ${al} z Allegro (okno ${days} dni).`)
  return { baselinker: bl, allegro: al, days }
}

/**
 * Liczy analitykę per SKU + gotowe listy dla zakładek.
 * @param {{lowStockThreshold?:number, windowDays?:number, trendRatio?:number}} opts
 */
export async function computeAnalytics({ lowStockThreshold = 5, windowDays = 30, trendRatio = 1.3 } = {}, log = () => {}) {
  const db = await getBufferDb()
  const wapro = await snapshotWapro()
  const now = Date.now()

  const coverageDays = db.snapshotDayCount(now - windowDays * DAY)
  const useWapro = coverageDays >= 3
  const sources = useWapro ? ['wapro_delta'] : ['baselinker', 'allegro']

  const salesWin = db.salesBySku(now - windowDays * DAY, sources)
  const sales7 = db.salesBySku(now - 7 * DAY, sources)
  const salesPrev7 = db.salesBySkuBetween(now - 14 * DAY, now - 7 * DAY, sources)

  const ending = []
  const trending = []
  const forecast = []

  for (const w of wapro) {
    const soldWin = salesWin.get(w.sku) || 0
    const daily = soldWin / windowDays
    const daysLeft = daily > 0 ? w.quantity / daily : null
    const v7 = (sales7.get(w.sku) || 0) / 7
    const vPrev = (salesPrev7.get(w.sku) || 0) / 7
    const trend = vPrev > 0 ? v7 / vPrev : v7 > 0 ? Infinity : 0

    if (w.quantity > 0 && w.quantity <= lowStockThreshold) {
      ending.push({ sku: w.sku, ean: w.ean, name: w.name, qty: w.quantity, daily: round(daily), daysLeft: daysLeft == null ? null : Math.round(daysLeft) })
    }
    if (v7 > 0 && trend >= trendRatio) {
      trending.push({ sku: w.sku, ean: w.ean, name: w.name, qty: w.quantity, v7: round(v7), vPrev: round(vPrev), trend: trend === Infinity ? 'nowy' : round(trend) })
    }
    if (daily > 0) {
      forecast.push({ sku: w.sku, ean: w.ean, name: w.name, qty: w.quantity, daily: round(daily), daysLeft: Math.round(daysLeft) })
    }
  }

  ending.sort((a, b) => a.qty - b.qty)
  trending.sort((a, b) => (b.trend === 'nowy' ? Infinity : b.trend) - (a.trend === 'nowy' ? Infinity : a.trend))
  forecast.sort((a, b) => a.daysLeft - b.daysLeft)

  return {
    meta: {
      source: useWapro ? 'WAPRO (spadki stanu)' : 'zamówienia kanałów',
      coverageDays,
      windowDays,
      lowStockThreshold,
      wapro: wapro.length,
      generatedAt: new Date().toISOString()
    },
    ending,
    trending: trending.slice(0, 500),
    forecast: forecast.slice(0, 500)
  }
}

function round(n) {
  return Math.round(n * 100) / 100
}
