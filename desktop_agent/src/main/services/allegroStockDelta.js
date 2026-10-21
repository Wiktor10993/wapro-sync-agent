/**
 * allegroStockDelta.js — sprzedaż Allegro → korekta stanu WAPRO (v6.1).
 *
 * Allegro jest podpięte OSOBNO (nie przez BaseLinkera). Nie zaciągamy całego
 * zamówienia z danymi klienta — potrzebujemy tylko ZDJĄĆ STAN w WAPRO o sprzedaną
 * ilość. Robimy to przez bufor delt `INTEG.WAPRO_DELTA_BUFOR` (agent dopisuje
 * -ilość, a procedura po stronie WAPRO zdejmuje stan z kartoteki).
 *
 * Gwarancje:
 *  - dedup po pozycji zamówienia (SQLite processed_sales) — brak podwójnego zdjęcia,
 *  - SKU pozycji: mapowanie oferta → indeks (CSV / automapowanie), potem sygnatura,
 *  - zapis wszystkich pozycji zamówienia w JEDNEJ transakcji; „przetworzone"
 *    oznaczamy dopiero po commitcie (gdy coś padnie — ponawiamy w kolejnym cyklu).
 */

import { getPool, sql } from '../wapro/pool.js'
import { getAllegroSalesSince, getDbSettings, setAllegroSalesSince } from '../store.js'
import { fetchPaidAllegroOrdersSince, uniqueAllegroAccounts } from './allegroAuth.js'
import { resolveLineSku } from './allegroSyncCore.js'
import { getBufferDb } from './bufferDb.js'

const DELTA_TABLE = 'INTEG.WAPRO_DELTA_BUFOR'

/** Zakłada schemat/tabelę bufora (jeśli konto ma prawa DDL); inaczej zakłada, że istnieje. */
async function ensureDeltaTable(pool, log) {
  try {
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'INTEG') EXEC('CREATE SCHEMA INTEG');
      IF OBJECT_ID('INTEG.WAPRO_DELTA_BUFOR', 'U') IS NULL
        CREATE TABLE INTEG.WAPRO_DELTA_BUFOR (
          ID INT IDENTITY(1,1) PRIMARY KEY,
          SKU VARCHAR(64) NOT NULL,
          EAN VARCHAR(32) NULL,
          DELTA_QTY INT NOT NULL,
          TARGET_QTY INT NULL,
          REASON NVARCHAR(200) NULL,
          STATUS VARCHAR(20) NOT NULL DEFAULT 'NEW',
          CREATED_AT DATETIME NOT NULL DEFAULT GETDATE()
        );`)
  } catch (err) {
    log('info', `Bufor delt: nie tworzę tabeli (zakładam, że wdrożona po stronie WAPRO): ${err.message}`)
  }
}

/** Okno wstecz (dni), z którego co cykl pobieramy opłacone zamówienia. */
const LOOKBACK_DAYS = 7

/**
 * Pobiera nowe zamówienia Allegro ze WSZYSTKICH autoryzowanych kont (bez duplikatów
 * loginu) i dopisuje korekty stanu do bufora WAPRO. Dedup per pozycja zamówienia
 * (source = `allegro:<id>`, ref = `<zamówienie>:<pozycja>`).
 * @returns {Promise<{fetched:number, applied:number, skipped:number, orders:number, unresolved:number}>}
 */
export async function pullAllegroStockDeltas(log = () => {}) {
  const accounts = await uniqueAllegroAccounts(log)
  const totals = { fetched: 0, applied: 0, skipped: 0, orders: 0, unresolved: 0 }
  if (accounts.length === 0) return totals

  const db = await getBufferDb()
  const pool = await getPool(getDbSettings())
  await ensureDeltaTable(pool, log)

  for (const a of accounts) {
    const r = await pullForAccount(a, db, pool, log)
    for (const k of Object.keys(totals)) totals[k] += r[k] ?? 0
  }
  return totals
}

async function pullForAccount(account, db, pool, log) {
  const empty = { fetched: 0, applied: 0, skipped: 0, orders: 0, unresolved: 0 }
  const source = `allegro:${account.id}`

  // Pierwsze uruchomienie: ustawiamy znacznik „od teraz" — bez zdejmowania wstecz.
  const since = getAllegroSalesSince(account.id)
  if (!since) {
    setAllegroSalesSince(account.id, new Date().toISOString())
    log('info', `Allegro→WAPRO „${account.label}": start zdejmowania stanów za sprzedaż od teraz (starsze zamówienia pomijam).`)
    return empty
  }
  const windowStart = new Date(Math.max(new Date(since).getTime(), Date.now() - LOOKBACK_DAYS * 86400_000)).toISOString()

  let forms
  try {
    forms = await fetchPaidAllegroOrdersSince(account.id, windowStart, log)
  } catch (err) {
    log('warn', `Allegro→WAPRO (stan) konto „${account.label}": pobranie sprzedaży nieudane: ${err.message}`)
    return empty
  }
  if (!forms?.length) return empty

  const offerSku = db.offerSkuMap(account.id)
  let applied = 0
  let skipped = 0
  let orders = 0
  let unresolved = 0

  for (const f of forms) {
    const ref = String(f?.id ?? '')
    if (!ref) continue
    // Zgodność wstecz: zamówienie oznaczone w całości (v6.1–6.3) — pomijamy.
    if (db.isSaleProcessed(source, ref)) {
      skipped++
      continue
    }

    const lines = []
    for (const li of f?.lineItems ?? []) {
      const lineRef = `${ref}:${li?.id ?? li?.offer?.id ?? ''}`
      if (db.isSaleProcessed(source, lineRef)) {
        skipped++
        continue
      }
      const qty = Math.trunc(Number(li?.quantity) || 0)
      if (qty <= 0) {
        db.markSaleProcessed(source, lineRef)
        continue
      }
      const sku = resolveLineSku(li, offerSku)
      if (!sku) {
        // Bez SKU nie wiemy, co zdjąć. NIE oznaczamy — gdy pojawi się mapowanie
        // (CSV / automapowanie), pozycja zejdzie w kolejnym cyklu (w oknie LOOKBACK_DAYS).
        unresolved++
        try {
          db.enqueueUnmapped({
            source: 'allegro',
            channel: 'allegro',
            sku: `oferta:${li?.offer?.id ?? '?'}`,
            ean: '',
            name: String(li?.offer?.name ?? ''),
            quantity: qty,
            reason: `Sprzedaż na koncie „${account.label}" (zamówienie ${ref}) — oferta bez sygnatury i bez mapowania na indeks WAPRO.`,
            candidates: []
          })
        } catch {
          /* kolejka pomocnicza */
        }
        continue
      }
      lines.push({ sku, qty, lineRef })
    }
    if (lines.length === 0) continue

    const tx = new sql.Transaction(pool)
    try {
      await tx.begin()
      for (const ln of lines) {
        await new sql.Request(tx)
          .input('sku', sql.VarChar(64), ln.sku)
          .input('ean', sql.VarChar(32), null)
          .input('delta', sql.Int, -ln.qty)
          .input('target', sql.Int, null)
          .input('reason', sql.NVarChar(200), `Allegro (${account.label}) sprzedaż ${ref}`)
          .query(`INSERT INTO ${DELTA_TABLE} (SKU, EAN, DELTA_QTY, TARGET_QTY, REASON) VALUES (@sku, @ean, @delta, @target, @reason)`)
      }
      await tx.commit()
      for (const ln of lines) db.markSaleProcessed(source, ln.lineRef)
      applied += lines.length
      orders++
    } catch (err) {
      await tx.rollback().catch(() => {})
      log('warn', `Allegro→WAPRO konto „${account.label}": zamówienie ${ref} nie zapisane (${err.message}) — ponowię w kolejnym cyklu.`)
    }
  }

  if (applied > 0 || orders > 0) {
    log('success', `Allegro→WAPRO „${account.label}": zdjęto stan dla ${applied} pozycji z ${orders} zamówień (pominięto ${skipped}).`)
  }
  if (unresolved > 0) {
    log('warn', `Allegro→WAPRO „${account.label}": ${unresolved} pozycji sprzedaży bez indeksu WAPRO (oferta bez sygnatury i mapowania) — czekają na mapowanie (Action Center).`)
  }
  return { fetched: forms.length, applied, skipped, orders, unresolved }
}
