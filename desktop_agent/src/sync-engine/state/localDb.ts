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
`

export class LocalDatabase {
  readonly db: Database.Database

  constructor(filePath: string) {
    this.db = new Database(filePath)
    this.db.exec(SCHEMA)
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
    const existing = this.db
      .prepare(`SELECT id, attempts FROM sync_errors WHERE sku = ? AND channel = ? AND status = 'open'`)
      .get(e.sku, e.channel) as any
    if (existing) {
      this.db.prepare(`UPDATE sync_errors SET target_qty=?, error_code=?, error_message=?, offer_id=?, attempts=attempts+1, last_attempt_at=datetime('now') WHERE id=?`)
        .run(e.targetQuantity, e.errorCode, e.errorMessage, e.offerId, existing.id)
      return existing.id
    }
    const info = this.db
      .prepare(
        `INSERT INTO sync_errors (channel, sku, ean, offer_id, direction, target_qty, error_code, error_message)
         VALUES (@channel, @sku, @ean, @offerId, @direction, @targetQuantity, @errorCode, @errorMessage)`
      )
      .run({ channel: e.channel, sku: e.sku, ean: e.ean, offerId: e.offerId ?? null, direction: e.direction, targetQuantity: e.targetQuantity, errorCode: e.errorCode, errorMessage: e.errorMessage })
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
  return { id: r.id, channel: r.channel, sku: r.sku, ean: r.ean, offerId: r.offer_id ?? null, direction: r.direction, targetQuantity: r.target_qty, errorCode: r.error_code, errorMessage: r.error_message, attempts: r.attempts, createdAt: r.created_at, lastAttemptAt: r.last_attempt_at, status: r.status }
}
