/**
 * Rozszerzony dziennik operacji (PUNKT 3) — tabela INTEG_LOG_SYNC.
 *
 * Zapisujemy każdą próbę synchronizacji: timestamp, kierunek, kanał, SKU, EAN,
 * ID oferty, stan przed/po, status (SUCCESS/SKIPPED/ERROR) i komunikat.
 * Wpisy wstawiamy paczkowo (bulk), a odczyt ma wyszukiwanie i filtrowanie.
 *
 * Uwaga: to WŁASNY schemat `INTEG` — nie dotykamy tabel ERP.
 */

import sql from 'mssql'
import type { SyncLogEntry, SyncEntryStatus, SyncChannel, SyncDirection } from '../types'

const SCHEMA = 'INTEG'
const TABLE = 'INTEG_LOG_SYNC'

export interface LogFilter {
  channel?: SyncChannel
  direction?: SyncDirection
  status?: SyncEntryStatus
  /** Szukaj w SKU / EAN / offerId / message. */
  search?: string
  dateFrom?: string // ISO
  dateTo?: string // ISO
  limit?: number
  offset?: number
}

export class SyncLog {
  constructor(private readonly getPool: () => Promise<sql.ConnectionPool>) {}

  /** Tworzy schemat i tabelę, jeśli nie istnieją (idempotentnie). */
  async ensureSchema(): Promise<void> {
    const pool = await this.getPool()
    await pool.request().batch(`
      IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '${SCHEMA}')
        EXEC('CREATE SCHEMA ${SCHEMA}');
    `)
    await pool.request().batch(`
      IF OBJECT_ID('${SCHEMA}.${TABLE}', 'U') IS NULL
      CREATE TABLE ${SCHEMA}.${TABLE} (
        ID          BIGINT IDENTITY(1,1) PRIMARY KEY,
        TS          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
        DIRECTION   VARCHAR(20)    NOT NULL,
        CHANNEL     VARCHAR(20)    NOT NULL,
        SKU         VARCHAR(64)    NULL,
        EAN         VARCHAR(32)    NULL,
        OFFER_ID    VARCHAR(64)    NULL,
        QTY_BEFORE  INT            NULL,
        QTY_AFTER   INT            NULL,
        STATUS      VARCHAR(10)    NOT NULL,
        MESSAGE     NVARCHAR(1000) NULL
      );
    `)
    // Indeksy pod filtrowanie/wyszukiwanie.
    await pool.request().batch(`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_INTEG_LOG_TS' AND object_id=OBJECT_ID('${SCHEMA}.${TABLE}'))
        CREATE INDEX IX_INTEG_LOG_TS ON ${SCHEMA}.${TABLE} (TS DESC);
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_INTEG_LOG_SKU' AND object_id=OBJECT_ID('${SCHEMA}.${TABLE}'))
        CREATE INDEX IX_INTEG_LOG_SKU ON ${SCHEMA}.${TABLE} (SKU);
    `)
  }

  /** Zapis wielu wpisów w jednej operacji (Table-Valued nie jest wymagane — bulk). */
  async insertMany(entries: SyncLogEntry[]): Promise<void> {
    if (!entries.length) return
    const pool = await this.getPool()

    const table = new sql.Table(`${SCHEMA}.${TABLE}`)
    table.columns.add('TS', sql.DateTime2, { nullable: false })
    table.columns.add('DIRECTION', sql.VarChar(20), { nullable: false })
    table.columns.add('CHANNEL', sql.VarChar(20), { nullable: false })
    table.columns.add('SKU', sql.VarChar(64), { nullable: true })
    table.columns.add('EAN', sql.VarChar(32), { nullable: true })
    table.columns.add('OFFER_ID', sql.VarChar(64), { nullable: true })
    table.columns.add('QTY_BEFORE', sql.Int, { nullable: true })
    table.columns.add('QTY_AFTER', sql.Int, { nullable: true })
    table.columns.add('STATUS', sql.VarChar(10), { nullable: false })
    table.columns.add('MESSAGE', sql.NVarChar(1000), { nullable: true })

    for (const e of entries) {
      table.rows.add(
        new Date(e.ts),
        e.direction,
        e.channel,
        e.sku || null,
        e.ean || null,
        e.offerId,
        e.qtyBefore,
        e.qtyAfter,
        e.status,
        (e.message ?? '').slice(0, 1000)
      )
    }

    await pool.request().bulk(table)
  }

  /** Odczyt z filtrowaniem, wyszukiwaniem i paginacją (do zakładki UI). */
  async query(filter: LogFilter = {}): Promise<{ rows: SyncLogEntry[]; total: number }> {
    const pool = await this.getPool()
    const req = pool.request()
    const where: string[] = ['1=1']

    if (filter.channel) {
      req.input('channel', sql.VarChar(20), filter.channel)
      where.push('CHANNEL = @channel')
    }
    if (filter.direction) {
      req.input('direction', sql.VarChar(20), filter.direction)
      where.push('DIRECTION = @direction')
    }
    if (filter.status) {
      req.input('status', sql.VarChar(10), filter.status)
      where.push('STATUS = @status')
    }
    if (filter.dateFrom) {
      req.input('dateFrom', sql.DateTime2, new Date(filter.dateFrom))
      where.push('TS >= @dateFrom')
    }
    if (filter.dateTo) {
      req.input('dateTo', sql.DateTime2, new Date(filter.dateTo))
      where.push('TS <= @dateTo')
    }
    if (filter.search) {
      req.input('q', sql.NVarChar(200), `%${filter.search}%`)
      where.push('(SKU LIKE @q OR EAN LIKE @q OR OFFER_ID LIKE @q OR MESSAGE LIKE @q)')
    }

    const whereSql = where.join(' AND ')
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 100))
    const offset = Math.max(0, filter.offset ?? 0)
    req.input('limit', sql.Int, limit)
    req.input('offset', sql.Int, offset)

    const result = await req.query(`
      SELECT COUNT(*) OVER() AS TOTAL,
             ID, TS, DIRECTION, CHANNEL, SKU, EAN, OFFER_ID, QTY_BEFORE, QTY_AFTER, STATUS, MESSAGE
      FROM ${SCHEMA}.${TABLE} WITH (NOLOCK)
      WHERE ${whereSql}
      ORDER BY TS DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `)

    const rows: SyncLogEntry[] = result.recordset.map((r: any) => ({
      id: Number(r.ID),
      ts: new Date(r.TS).toISOString(),
      direction: r.DIRECTION,
      channel: r.CHANNEL,
      sku: r.SKU ?? '',
      ean: r.EAN ?? '',
      offerId: r.OFFER_ID ?? null,
      qtyBefore: r.QTY_BEFORE ?? null,
      qtyAfter: r.QTY_AFTER ?? null,
      status: r.STATUS,
      message: r.MESSAGE ?? ''
    }))

    const total = result.recordset.length ? Number(result.recordset[0].TOTAL) : 0
    return { rows, total }
  }
}
