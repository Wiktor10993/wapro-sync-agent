import crypto from 'node:crypto'

/**
 * Wyliczanie różnic stanów względem poprzedniego snapshotu.
 *
 * WF-Mag nie udostępnia niezawodnego znacznika zmiany na STANY_MAGAZYNOWE
 * (brak ROWVERSION w standardowym schemacie), więc detekcję zmian robimy po
 * stronie agenta: trzymamy mapę sku → hash(ilość) i wysyłamy tylko delty.
 *
 * Alternatywa dla dużych baz: włączyć Change Tracking na poziomie SQL Server
 * (ALTER DATABASE … SET CHANGE_TRACKING = ON) i czytać CHANGETABLE().
 * Wymaga to uprawnień db_owner, których klient nie zawsze chce udzielić —
 * stąd diff jako domyślny, bezpieczny wariant.
 *
 * Moduł jest celowo wolny od zależności (tylko `crypto`), żeby dało się go
 * testować bez ładowania sterownika MSSQL.
 */

/**
 * @param {Array<{sku:string, quantity:number, name?:string}>} snapshot
 * @param {Record<string,string>} previousHashes
 * @returns {{changed:Array<{sku:string,quantity:number,name:string}>, hashes:Record<string,string>, removed:string[]}}
 */
export function diffSnapshot(snapshot, previousHashes = {}) {
  const hashes = {}
  const changed = []

  for (const row of snapshot) {
    const hash = crypto.createHash('sha1').update(`${row.sku}|${row.quantity}`).digest('hex')

    hashes[row.sku] = hash

    if (previousHashes[row.sku] !== hash) {
      changed.push({ sku: row.sku, quantity: row.quantity, name: row.name ?? '', barcode: row.barcode ?? '' })
    }
  }

  // SKU, które zniknęły z wyniku (np. artykuł zarchiwizowany) — zerujemy stan,
  // żeby nie zostawić ich na sprzedaży w kanałach.
  const removed = Object.keys(previousHashes).filter((sku) => !(sku in hashes))
  for (const sku of removed) {
    changed.push({ sku, quantity: 0, name: '(usunięty/zarchiwizowany)', barcode: '' })
  }

  return { changed, hashes, removed }
}
