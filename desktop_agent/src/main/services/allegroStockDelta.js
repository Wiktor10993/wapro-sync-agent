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
import { getDbSettings, listAllegroAccountsPublic } from '../store.js'
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
 * Pobiera nowe zamówienia Allegro ze WSZYSTKICH autoryzowanych kont i dopisuje
 * korekty stanu do bufora WAPRO. Dedup per konto (source = `allegro:<id>`).
 * @returns {Promise<{fetched:number, applied:number, skipped:number, orders:number}>}
 */
export async function pullAllegroStockDeltas(log = () => {}) {
  const accounts = listAllegroAccountsPublic().filter((a) => a.authorized)
  if (accounts.length === 0) return { fetched: 0, applied: 0, skipped: 0, orders: 0 }

  const db = await getBufferDb()
  const pool = await getPool(getDbSettings())
  await ensureDeltaTable(pool, log)

  const totals = { fetched: 0, applied: 0, skipped: 0, orders: 0 }
  for (const a of accounts) {
    const r = await pullForAccount(a, db, pool, log)
    totals.fetched += r.fetched
    totals.applied += r.applied
    totals.skipped += r.skipped
    totals.orders += r.orders
  }
  return totals
}

async function pullForAccount(account, db, pool, log) {
  const source = `allegro:${account.id}`
  let forms
  try {
    forms = await fetchAllegroOrders(account.id, { limit: 100, status: 'READY_FOR_PROCESSING' }, log)
  } catch (err) {
    log('warn', `Allegro→WAPRO (stan) konto „${account.label}": pobranie sprzedaży nieudane: ${err.message}`)
    return { fetched: 0, applied: 0, skipped: 0, orders: 0 }
  }
  if (!forms?.length) return { fetched: 0, applied: 0, skipped: 0, orders: 0 }

  let applied = 0
  let skipped = 0
  let orders = 0

  for (const f of forms) {
    const ref = String(f?.id ?? '')
    if (!ref) continue
    if (db.isSaleProcessed(source, ref)) {
      skipped++
      continue
    }

    const lines = []
    for (const li of f?.lineItems ?? []) {
      const sku = String(li?.offer?.external?.id ?? '').trim()
      const qty = Math.trunc(Number(li?.quantity) || 0)
      if (sku && qty > 0) lines.push({ sku, qty })
    }
    if (lines.length === 0) {
      db.markSaleProcessed(source, ref)
      continue
    }

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
      db.markSaleProcessed(source, ref)
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
  return { fetched: forms.length, applied, skipped, orders }
}
