/**
 * Lokalny bufor stanu (SQLite, better-sqlite3) — „Stateful Sync".
 *
 * Trzyma AUTORYTATYWNY, lokalny stan wiedzy agenta o każdym towarze oraz dwie
 * kolejki problemów operacyjnych (Action Center):
 *   - unmapped_queue : nowe/niezmapowane produkty (Kategoria I),
 *   - sync_errors    : błędy wysyłki delt do kanałów/WAPRO (Kategoria II).
 *
 * Plus tabela applied_deltas dla Loop Guarda (persystentna między restartami).
 *
 * better-sqlite3 jest SYNCHRONICZNE — idealne do procesu głównego Electrona.
 */

import Database from 'better-sqlite3'

export type Channel = 'baselinker' | 'allegro'
export type Origin = 'baselinker' | 'allegro' | 'wapro' | 'local' | 'manual'
export type MappingVia = 'ean' | 'sku' | 'name' | 'manual'
export type QueueStatus = 'open' | 'resolved' | 'ignored'

export interface LocalProduct {
  id: number
  sku: string
  ean: string
  name: string
  waproId: number | null
  quantity: number
  updatedAt: string
}

export interface ChannelMapping {
  id: number
  sku: string
  channel: Channel
  offerId: string
  variantId: string | null
  via: MappingVia
  confidence: number
  status: 'active' | 'ignored'
  updatedAt: string
}

export interface UnmappedItem {
  id: number
  source: Origin
  channel: Channel | null
  sku: string
  ean: string
  name: string
  quantity: number
  reason: string
  candidates: string[] // ofertowe ID kandydatów
  createdAt: string
  status: QueueStatus
}

/**
 * Kategoria wpisu w kolejce błędów:
 *  - 'error'         : krytyczny błąd wysyłki,
 *  - 'archived_zero' : „0 na stanie (Archiwum)" — stan 0 i oferty już nie ma (informacyjny),
 *  - 'needs_relist'  : towar wrócił (>0), ale zakończonej oferty nie da się automatycznie
 *                      wznowić (wygasła/usunięta) → operator wystawia ponownie.
 */
export type ErrorCategory = 'error' | 'archived_zero' | 'needs_relist'

/** Pozycja „na obserwacji do wznowienia" — oferta zakończona przy stanie ≤ 0. */
export interface RestockWatchItem {
  id: number
  sku: string
  ean: string
  channel: Channel
  offerId: string
  endedAt: string
}

/** Produkt-widmo: mapowanie z CSV wskazuje ofertę, ale nie ma go w WAPRO. */
export interface PhantomProduct {
  id: number
  sku: string
  ean: string
  name: string
  allegroOfferId: string
  baselinkerProductId: string
  createdAt: string
  status: QueueStatus
}

export interface SyncError {
  id: number
  channel: Channel | 'wapro'
  sku: string
  ean: string
  offerId: string | null
  direction: string // np. 'WAPRO->CHANNEL' / 'CHANNEL->WAPRO'
  targetQuantity: number
  errorCode: string
  errorMessage: string
  category: ErrorCategory
  attempts: number
  createdAt: string
  lastAttemptAt: string
  status: QueueStatus
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sku        TEXT NOT NULL UNIQUE,
  ean        TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  wapro_id   INTEGER,
  quantity   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_products_ean ON products(ean);

CREATE TABLE IF NOT EXISTS channel_mappings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sku        TEXT NOT NULL,
  channel    TEXT NOT NULL,
  offer_id   TEXT NOT NULL,
  variant_id TEXT,
  via        TEXT NOT NULL DEFAULT 'manual',
  confidence REAL NOT NULL DEFAULT 1.0,
  status     TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sku, channel)
);
CREATE INDEX IF NOT EXISTS ix_map_offer ON channel_mappings(channel, offer_id);

CREATE TABLE IF NOT EXISTS unmapped_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  channel    TEXT,
  sku        TEXT NOT NULL DEFAULT '',
  ean        TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  quantity   INTEGER NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT '',
  candidates TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status     TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS sync_errors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel       TEXT NOT NULL,
  sku           TEXT NOT NULL DEFAULT '',
  ean           TEXT NOT NULL DEFAULT '',
  offer_id      TEXT,
  direction     TEXT NOT NULL DEFAULT '',
  target_qty    INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'error',
  attempts      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  status        TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS applied_deltas (
  sku      TEXT NOT NULL,
  origin   TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  at_ms    INTEGER NOT NULL,
  PRIMARY KEY (sku)
);

-- #2: oferty zakończone przy stanie <= 0, do automatycznego wznowienia gdy towar wróci.
CREATE TABLE IF NOT EXISTS restock_watch (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sku       TEXT NOT NULL DEFAULT '',
  ean       TEXT NOT NULL DEFAULT '',
  channel   TEXT NOT NULL,
  offer_id  TEXT NOT NULL,
  ended_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel, offer_id)
);
CREATE INDEX IF NOT EXISTS ix_restock_sku ON restock_watch(sku);

-- #3: produkty-widma z importu CSV (mapowanie kanału bez odpowiednika w WAPRO).
CREATE TABLE IF NOT EXISTS phantom_products (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                    TEXT NOT NULL DEFAULT '',
  ean                    TEXT NOT NULL DEFAULT '',
  name                   TEXT NOT NULL DEFAULT '',
  allegro_offer_id       TEXT NOT NULL DEFAULT '',
  baselinker_product_id  TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  status                 TEXT NOT NULL DEFAULT 'open',
  UNIQUE(ean, allegro_offer_id, baselinker_product_id)
);

-- v6: historia stanów WAPRO (snapshoty co cykl) — do liczenia prędkości sprzedaży.
CREATE TABLE IF NOT EXISTS stock_history (
  sku      TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  at_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stockhist_sku_at ON stock_history(sku, at_ms);
CREATE INDEX IF NOT EXISTS ix_stockhist_at ON stock_history(at_ms);

-- v6: zdarzenia sprzedaży (seed z zamówień BL/Allegro + spadki stanu WAPRO).
-- source: 'baselinker' | 'allegro' | 'wapro_delta'. ref = klucz deduplikacji.
CREATE TABLE IF NOT EXISTS sales_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sku    TEXT NOT NULL DEFAULT '',
  ean    TEXT NOT NULL DEFAULT '',
  qty    INTEGER NOT NULL,
  source TEXT NOT NULL,
  ref    TEXT NOT NULL DEFAULT '',
  at_ms  INTEGER NOT NULL,
  UNIQUE(source, ref)
);
CREATE INDEX IF NOT EXISTS ix_sales_sku_at ON sales_events(sku, at_ms);
CREATE INDEX IF NOT EXISTS ix_sales_at ON sales_events(at_ms);
`

export class LocalDatabase {
  readonly db: Database.Database

  constructor(filePath: string) {
    this.db = new Database(filePath)
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** Lekka migracja dla istniejących baz (dokłada brakujące kolumny). */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(sync_errors)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'category')) {
      this.db.exec("ALTER TABLE sync_errors ADD COLUMN category TEXT NOT NULL DEFAULT 'error'")
    }
  }

  close(): void {
    this.db.close()
  }

  // --- products ----------------------------------------------------------
  getProductBySku(sku: string): LocalProduct | null {
    const r = this.db.prepare('SELECT * FROM products WHERE sku = ?').get(sku) as any
    return r ? mapProduct(r) : null
  }

  getProductByOffer(channel: Channel, offerId: string): LocalProduct | null {
    const r = this.db
      .prepare(
        `SELECT p.* FROM products p
         JOIN channel_mappings m ON m.sku = p.sku
         WHERE m.channel = ? AND m.offer_id = ? AND m.status = 'active'`
      )
      .get(channel, offerId) as any
    return r ? mapProduct(r) : null
  }

  upsertProduct(p: { sku: string; ean?: string; name?: string; waproId?: number | null; quantity: number }): void {
    this.db
      .prepare(
        `INSERT INTO products (sku, ean, name, wapro_id, quantity, updated_at)
         VALUES (@sku, @ean, @name, @waproId, @quantity, datetime('now'))
         ON CONFLICT(sku) DO UPDATE SET
           ean = excluded.ean, name = excluded.name,
           wapro_id = COALESCE(excluded.wapro_id, products.wapro_id),
           quantity = excluded.quantity, updated_at = datetime('now')`
      )
      .run({ sku: p.sku, ean: p.ean ?? '', name: p.name ?? '', waproId: p.waproId ?? null, quantity: Math.max(0, Math.trunc(p.quantity)) })
  }

  setQuantity(sku: string, quantity: number): void {
    this.db.prepare(`UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE sku = ?`).run(Math.max(0, Math.trunc(quantity)), sku)
  }

  allProducts(): LocalProduct[] {
    return (this.db.prepare('SELECT * FROM products').all() as any[]).map(mapProduct)
  }

  // --- mappings ----------------------------------------------------------
  getMapping(sku: string, channel: Channel): ChannelMapping | null {
    const r = this.db.prepare('SELECT * FROM channel_mappings WHERE sku = ? AND channel = ?').get(sku, channel) as any
    return r ? mapMapping(r) : null
  }

  upsertMapping(m: { sku: string; channel: Channel; offerId: string; variantId?: string | null; via?: MappingVia; confidence?: number }): void {
    this.db
      .prepare(
        `INSERT INTO channel_mappings (sku, channel, offer_id, variant_id, via, confidence, status, updated_at)
         VALUES (@sku, @channel, @offerId, @variantId, @via, @confidence, 'active', datetime('now'))
         ON CONFLICT(sku, channel) DO UPDATE SET
           offer_id = excluded.offer_id, variant_id = excluded.variant_id,
           via = excluded.via, confidence = excluded.confidence,
           status = 'active', updated_at = datetime('now')`
      )
      .run({ sku: m.sku, channel: m.channel, offerId: m.offerId, variantId: m.variantId ?? null, via: m.via ?? 'manual', confidence: m.confidence ?? 1 })
  }

  // --- unmapped queue (Kategoria I) --------------------------------------
  enqueueUnmapped(item: Omit<UnmappedItem, 'id' | 'createdAt' | 'status'>): number {
    // Deduplikacja: nie mnożymy tej samej otwartej pozycji (sku+channel+source).
    const existing = this.db
      .prepare(`SELECT id FROM unmapped_queue WHERE sku = ? AND IFNULL(channel,'') = ? AND source = ? AND status = 'open'`)
      .get(item.sku, item.channel ?? '', item.source) as any
    if (existing) {
      this.db.prepare(`UPDATE unmapped_queue SET quantity=?, reason=?, candidates=? WHERE id=?`)
        .run(item.quantity, item.reason, JSON.stringify(item.candidates ?? []), existing.id)
      return existing.id
    }
    const info = this.db
      .prepare(
        `INSERT INTO unmapped_queue (source, channel, sku, ean, name, quantity, reason, candidates)
         VALUES (@source, @channel, @sku, @ean, @name, @quantity, @reason, @candidates)`
      )
      .run({ source: item.source, channel: item.channel ?? null, sku: item.sku, ean: item.ean, name: item.name, quantity: item.quantity, reason: item.reason, candidates: JSON.stringify(item.candidates ?? []) })
    return Number(info.lastInsertRowid)
  }

  listUnmapped(status: QueueStatus = 'open'): UnmappedItem[] {
    return (this.db.prepare('SELECT * FROM unmapped_queue WHERE status = ? ORDER BY created_at DESC').all(status) as any[]).map(mapUnmapped)
  }

  setUnmappedStatus(id: number, status: QueueStatus): void {
    this.db.prepare('UPDATE unmapped_queue SET status = ? WHERE id = ?').run(status, id)
  }

  // --- sync errors (Kategoria II) ----------------------------------------
  enqueueError(e: Omit<SyncError, 'id' | 'attempts' | 'createdAt' | 'lastAttemptAt' | 'status'>): number {
    const category = e.category ?? 'error'
    const existing = this.db
      .prepare(`SELECT id, attempts FROM sync_errors WHERE sku = ? AND channel = ? AND status = 'open'`)
      .get(e.sku, e.channel) as any
    if (existing) {
      this.db.prepare(`UPDATE sync_errors SET target_qty=?, error_code=?, error_message=?, offer_id=?, category=?, attempts=attempts+1, last_attempt_at=datetime('now') WHERE id=?`)
        .run(e.targetQuantity, e.errorCode, e.errorMessage, e.offerId, category, existing.id)
      return existing.id
    }
    const info = this.db
      .prepare(
        `INSERT INTO sync_errors (channel, sku, ean, offer_id, direction, target_qty, error_code, error_message, category)
         VALUES (@channel, @sku, @ean, @offerId, @direction, @targetQuantity, @errorCode, @errorMessage, @category)`
      )
      .run({ channel: e.channel, sku: e.sku, ean: e.ean, offerId: e.offerId ?? null, direction: e.direction, targetQuantity: e.targetQuantity, errorCode: e.errorCode, errorMessage: e.errorMessage, category })
    return Number(info.lastInsertRowid)
  }

  getError(id: number): SyncError | null {
    const r = this.db.prepare('SELECT * FROM sync_errors WHERE id = ?').get(id) as any
    return r ? mapError(r) : null
  }

  listErrors(status: QueueStatus = 'open'): SyncError[] {
    return (this.db.prepare('SELECT * FROM sync_errors WHERE status = ? ORDER BY last_attempt_at DESC').all(status) as any[]).map(mapError)
  }

  setErrorStatus(id: number, status: QueueStatus): void {
    this.db.prepare('UPDATE sync_errors SET status = ? WHERE id = ?').run(status, id)
  }

  bumpErrorAttempt(id: number): void {
    this.db.prepare(`UPDATE sync_errors SET attempts = attempts + 1, last_attempt_at = datetime('now') WHERE id = ?`).run(id)
  }

  // --- restock watch (#2: wznowienia ofert) ------------------------------
  /** Dodaje ofertę na listę obserwacji do wznowienia (idempotentnie). */
  watchRestock(w: { sku?: string; ean?: string; channel: Channel; offerId: string }): void {
    this.db
      .prepare(
        `INSERT INTO restock_watch (sku, ean, channel, offer_id, ended_at)
         VALUES (@sku, @ean, @channel, @offerId, datetime('now'))
         ON CONFLICT(channel, offer_id) DO UPDATE SET
           sku = excluded.sku, ean = excluded.ean, ended_at = datetime('now')`
      )
      .run({ sku: w.sku ?? '', ean: w.ean ?? '', channel: w.channel, offerId: w.offerId })
  }

  listRestock(): RestockWatchItem[] {
    return (this.db.prepare('SELECT * FROM restock_watch ORDER BY ended_at ASC').all() as any[]).map(mapRestock)
  }

  /** Usuwa z obserwacji po pomyślnym wznowieniu. */
  clearRestock(channel: Channel, offerId: string): void {
    this.db.prepare('DELETE FROM restock_watch WHERE channel = ? AND offer_id = ?').run(channel, offerId)
  }

  isWatched(channel: Channel, offerId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM restock_watch WHERE channel = ? AND offer_id = ?').get(channel, offerId)
  }

  // --- phantom products (#3: mapowanie CSV bez odpowiednika w WAPRO) ------
  upsertPhantom(p: { sku?: string; ean?: string; name?: string; allegroOfferId?: string; baselinkerProductId?: string }): void {
    this.db
      .prepare(
        `INSERT INTO phantom_products (sku, ean, name, allegro_offer_id, baselinker_product_id, status)
         VALUES (@sku, @ean, @name, @allegro, @baselinker, 'open')
         ON CONFLICT(ean, allegro_offer_id, baselinker_product_id) DO UPDATE SET
           sku = excluded.sku, name = excluded.name`
      )
      .run({
        sku: p.sku ?? '',
        ean: p.ean ?? '',
        name: p.name ?? '',
        allegro: p.allegroOfferId ?? '',
        baselinker: p.baselinkerProductId ?? ''
      })
  }

  listPhantom(status: QueueStatus = 'open'): PhantomProduct[] {
    return (this.db.prepare('SELECT * FROM phantom_products WHERE status = ? ORDER BY created_at DESC').all(status) as any[]).map(mapPhantom)
  }

  setPhantomStatus(id: number, status: QueueStatus): void {
    this.db.prepare('UPDATE phantom_products SET status = ? WHERE id = ?').run(status, id)
  }

  // --- historia stanów + sprzedaż (v6 analityka) -------------------------
  /** Zapisuje snapshot stanów (bulk, jeden znacznik czasu). */
  recordStockSnapshot(rows: Array<{ sku: string; quantity: number }>): void {
    const at = Date.now()
    const stmt = this.db.prepare('INSERT INTO stock_history (sku, quantity, at_ms) VALUES (?, ?, ?)')
    const tx = this.db.transaction((items: Array<{ sku: string; quantity: number }>) => {
      for (const r of items) {
        if (!r.sku) continue
        stmt.run(r.sku, Math.trunc(Number(r.quantity) || 0), at)
      }
    })
    tx(rows)
  }

  /** Ostatni znany stan per SKU z historii (do wykrywania spadków = sprzedaży). */
  latestStockMap(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT sku, quantity FROM stock_history sh WHERE at_ms = (SELECT MAX(at_ms) FROM stock_history WHERE sku = sh.sku)')
      .all() as Array<{ sku: string; quantity: number }>
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.sku, r.quantity)
    return m
  }

  /** Wstawia zdarzenia sprzedaży z deduplikacją (source+ref). Zwraca liczbę nowych. */
  recordSales(events: Array<{ sku: string; ean?: string; qty: number; source: string; ref: string; atMs: number }>): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO sales_events (sku, ean, qty, source, ref, at_ms) VALUES (@sku, @ean, @qty, @source, @ref, @atMs)'
    )
    let inserted = 0
    const tx = this.db.transaction((items: typeof events) => {
      for (const e of items) {
        if (!e.sku && !e.ean) continue
        const info = stmt.run({ sku: e.sku ?? '', ean: e.ean ?? '', qty: Math.trunc(Number(e.qty) || 0), source: e.source, ref: e.ref, atMs: e.atMs })
        inserted += info.changes
      }
    })
    tx(events)
    return inserted
  }

  /** Suma sprzedanych sztuk per SKU od `sinceMs` (opcjonalnie filtr źródeł). */
  salesBySku(sinceMs: number, sources?: string[]): Map<string, number> {
    return this.salesBySkuBetween(sinceMs, Date.now(), sources)
  }

  salesBySkuBetween(fromMs: number, toMs: number, sources?: string[]): Map<string, number> {
    let sql = 'SELECT sku, SUM(qty) AS n FROM sales_events WHERE at_ms >= ? AND at_ms < ?'
    const args: any[] = [fromMs, toMs]
    if (sources && sources.length) {
      sql += ` AND source IN (${sources.map(() => '?').join(',')})`
      args.push(...sources)
    }
    sql += ' GROUP BY sku'
    const rows = this.db.prepare(sql).all(...args) as Array<{ sku: string; n: number }>
    const m = new Map<string, number>()
    for (const r of rows) if (r.sku) m.set(r.sku, Number(r.n) || 0)
    return m
  }

  /** Liczba różnych dni z zapisanym snapshotem od `sinceMs` (ocena pokrycia WAPRO). */
  snapshotDayCount(sinceMs: number): number {
    const r = this.db
      .prepare("SELECT COUNT(DISTINCT date(at_ms/1000,'unixepoch')) AS d FROM stock_history WHERE at_ms >= ?")
      .get(sinceMs) as { d: number }
    return Number(r?.d) || 0
  }

  /** Czyści historię starszą niż `beforeMs` (retencja). */
  pruneHistory(beforeMs: number): void {
    this.db.prepare('DELETE FROM stock_history WHERE at_ms < ?').run(beforeMs)
    this.db.prepare('DELETE FROM sales_events WHERE at_ms < ?').run(beforeMs)
  }

  // --- loop guard (applied deltas) ---------------------------------------
  recordApplied(sku: string, origin: Origin, quantity: number): void {
    this.db
      .prepare(
        `INSERT INTO applied_deltas (sku, origin, quantity, at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(sku) DO UPDATE SET origin = excluded.origin, quantity = excluded.quantity, at_ms = excluded.at_ms`
      )
      .run(sku, origin, Math.trunc(quantity), Date.now())
  }

  getApplied(sku: string): { origin: Origin; quantity: number; atMs: number } | null {
    const r = this.db.prepare('SELECT origin, quantity, at_ms FROM applied_deltas WHERE sku = ?').get(sku) as any
    return r ? { origin: r.origin, quantity: r.quantity, atMs: r.at_ms } : null
  }
}

// --- mapowanie wierszy -> obiekty --------------------------------------------
function mapProduct(r: any): LocalProduct {
  return { id: r.id, sku: r.sku, ean: r.ean ?? '', name: r.name ?? '', waproId: r.wapro_id ?? null, quantity: r.quantity, updatedAt: r.updated_at }
}
function mapMapping(r: any): ChannelMapping {
  return { id: r.id, sku: r.sku, channel: r.channel, offerId: r.offer_id, variantId: r.variant_id ?? null, via: r.via, confidence: r.confidence, status: r.status, updatedAt: r.updated_at }
}
function mapUnmapped(r: any): UnmappedItem {
  let candidates: string[] = []
  try { candidates = JSON.parse(r.candidates ?? '[]') } catch { candidates = [] }
  return { id: r.id, source: r.source, channel: r.channel ?? null, sku: r.sku, ean: r.ean, name: r.name, quantity: r.quantity, reason: r.reason, candidates, createdAt: r.created_at, status: r.status }
}
function mapError(r: any): SyncError {
  return { id: r.id, channel: r.channel, sku: r.sku, ean: r.ean, offerId: r.offer_id ?? null, direction: r.direction, targetQuantity: r.target_qty, errorCode: r.error_code, errorMessage: r.error_message, category: r.category ?? 'error', attempts: r.attempts, createdAt: r.created_at, lastAttemptAt: r.last_attempt_at, status: r.status }
}
function mapRestock(r: any): RestockWatchItem {
  return { id: r.id, sku: r.sku ?? '', ean: r.ean ?? '', channel: r.channel, offerId: r.offer_id, endedAt: r.ended_at }
}
function mapPhantom(r: any): PhantomProduct {
  return { id: r.id, sku: r.sku ?? '', ean: r.ean ?? '', name: r.name ?? '', allegroOfferId: r.allegro_offer_id ?? '', baselinkerProductId: r.baselinker_product_id ?? '', createdAt: r.created_at, status: r.status }
}
