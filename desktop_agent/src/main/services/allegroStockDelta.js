/**
 * allegroStockDelta.js — sprzedaż Allegro → korekta stanu WAPRO (v6.1).
 *
 * Allegro jest podpięte OSOBNO (nie przez BaseLinkera). Nie zaciągamy całego
 * zamówienia z danymi klienta — potrzebujemy tylko ZDJĄĆ STAN w WAPRO o sprzedaną
 * ilość. Robimy to przez bufor delt `INTEG.WAPRO_DELTA_BUFOR` (agent dopisuje
 * -ilość, a procedura po stronie WAPRO zdejmuje stan z kartoteki).
 *
 * Gwarancje:
 *  - dedup po id zamówienia (SQLite processed_sales) — brak podwójnego zdjęcia,
 *  - zapis wszystkich pozycji zamówienia w JEDNEJ transakcji; „przetworzone"
 *    oznaczamy dopiero po commitcie (gdy coś padnie — ponawiamy w kolejnym cyklu).
 */

import { getPool, sql } from '../wapro/pool.js'
import { getDbSettings } from '../store.js'
import { fetchAllegroOrders } from './allegroAuth.js'
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

/**
 * Pobiera nowe zamówienia Allegro i dopisuje korekty stanu do bufora WAPRO.
 * @returns {Promise<{fetched:number, applied:number, skipped:number, orders:number}>}
 */
export async function pullAllegroStockDeltas(log = () => {}) {
  let forms
  try {
    forms = await fetchAllegroOrders({ limit: 100, status: 'READY_FOR_PROCESSING' }, log)
  } catch (err) {
    log('warn', `Allegro→WAPRO (stan): pobranie sprzedaży nieudane: ${err.message}`)
    return { fetched: 0, applied: 0, skipped: 0, orders: 0 }
  }
  if (!forms?.length) return { fetched: 0, applied: 0, skipped: 0, orders: 0 }

  const db = await getBufferDb()
  const pool = await getPool(getDbSettings())
  await ensureDeltaTable(pool, log)

  let applied = 0
  let skipped = 0
  let orders = 0

  for (const f of forms) {
    const ref = String(f?.id ?? '')
    if (!ref) continue
    if (db.isSaleProcessed('allegro', ref)) {
      skipped++
      continue
    }

    // Zbierz pozycje (SKU = sygnatura oferty = indeks WAPRO).
    const lines = []
    for (const li of f?.lineItems ?? []) {
      const sku = String(li?.offer?.external?.id ?? '').trim()
      const qty = Math.trunc(Number(li?.quantity) || 0)
      if (sku && qty > 0) lines.push({ sku, qty })
    }
    if (lines.length === 0) {
      // Zamówienie bez rozpoznawalnego SKU — oznacz jako przetworzone, żeby nie wracało.
      db.markSaleProcessed('allegro', ref)
      continue
    }

    // Atomowo: albo wszystkie pozycje zamówienia, albo nic.
    const tx = new sql.Transaction(pool)
    try {
      await tx.begin()
      for (const ln of lines) {
        await new sql.Request(tx)
          .input('sku', sql.VarChar(64), ln.sku)
          .input('ean', sql.VarChar(32), null)
          .input('delta', sql.Int, -ln.qty)
          .input('target', sql.Int, null)
          .input('reason', sql.NVarChar(200), `Allegro sprzedaż ${ref}`)
          .query(`INSERT INTO ${DELTA_TABLE} (SKU, EAN, DELTA_QTY, TARGET_QTY, REASON) VALUES (@sku, @ean, @delta, @target, @reason)`)
      }
      await tx.commit()
      db.markSaleProcessed('allegro', ref)
      applied += lines.length
      orders++
    } catch (err) {
      await tx.rollback().catch(() => {})
      log('warn', `Allegro→WAPRO: zamówienie ${ref} nie zapisane (${err.message}) — ponowię w kolejnym cyklu.`)
    }
  }

  log(
    applied > 0 ? 'success' : 'info',
    `Allegro→WAPRO: zdjęto stan (delta) dla ${applied} pozycji z ${orders} nowych zamówień (pominięto ${skipped} już przetworzonych).`
  )
  return { fetched: forms.length, applied, skipped, orders }
}
