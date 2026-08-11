/**
 * Delta Sync — wysyłamy TYLKO produkty, których stan realnie się zmienił.
 *
 * WF-Mag nie ma pewnego znacznika zmiany, więc detekcję robimy po stronie agenta:
 * hash(sku|quantity) porównywany ze snapshotem z poprzedniego cyklu. Zamiast
 * mielić 16 000 pozycji za każdym razem, przetwarzamy tylko delty.
 */

import { createHash } from 'node:crypto'
import type { StockRow, DeltaResult } from '../types'

/** Stabilny hash stanu pozycji. Zależy od SKU i ilości (te decydują o wysyłce). */
export function hashRow(row: Pick<StockRow, 'sku' | 'quantity'>): string {
  return createHash('sha1').update(`${row.sku}|${row.quantity}`).digest('hex')
}

/**
 * Wylicza delty względem poprzednich hashy.
 *  - `changed` — pozycje ze zmienioną ilością (lub nowe),
 *  - `removed` — SKU, które zniknęły ze snapshotu (zerujemy stan w kanałach),
 *  - `hashes`  — nowy komplet hashy do zapisania po udanej wysyłce.
 */
export function computeDelta(snapshot: StockRow[], previousHashes: Record<string, string> = {}): DeltaResult {
  const hashes: Record<string, string> = {}
  const changed: StockRow[] = []

  for (const row of snapshot) {
    if (!row.sku) continue
    const h = hashRow(row)
    hashes[row.sku] = h
    if (previousHashes[row.sku] !== h) changed.push(row)
  }

  const removed = Object.keys(previousHashes).filter((sku) => !(sku in hashes))
  for (const sku of removed) {
    changed.push({ idArtykulu: 0, sku, ean: '', name: '(usunięty/zarchiwizowany)', quantity: 0, warehouseId: null })
  }

  return { changed, hashes, removed }
}

/**
 * Zatwierdza hashe TYLKO dla pozycji faktycznie wysłanych (updatedSkus).
 * Niedopasowane / nieudane zostają bez hasha, żeby ponowić w kolejnym cyklu.
 */
export function commitHashes(
  previousHashes: Record<string, string>,
  newHashes: Record<string, string>,
  updatedSkus: Iterable<string>
): Record<string, string> {
  const committed = { ...previousHashes }
  for (const sku of updatedSkus) {
    if (newHashes[sku]) committed[sku] = newHashes[sku]
    else delete committed[sku]
  }
  return committed
}
