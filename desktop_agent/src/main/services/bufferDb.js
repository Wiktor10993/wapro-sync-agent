/**
 * bufferDb.js — jeden współdzielony uchwyt do lokalnego bufora SQLite
 * (userData/sync-buffer.db), używany przez restockStore (#2) i mappingCsv (#3).
 *
 * Orchestrator Action Center trzyma własny uchwyt; SQLite w trybie WAL obsługuje
 * kilka połączeń w obrębie procesu. Tu utrzymujemy JEDEN handle dla lekkich
 * operacji (restock_watch, channel_mappings, phantom_products), żeby nie mnożyć
 * połączeń bez potrzeby.
 */

import path from 'node:path'
import { app } from 'electron'

let dbPromise = null

/** @returns {Promise<import('../../sync-engine/state/localDb').LocalDatabase>} */
export async function getBufferDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const { LocalDatabase } = await import('../../sync-engine/state/localDb')
      const dbPath = path.join(app.getPath('userData'), 'sync-buffer.db')
      return new LocalDatabase(dbPath)
    })()
  }
  return dbPromise
}
