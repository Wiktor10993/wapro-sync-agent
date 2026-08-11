/**
 * Repozytorium Wapro (MSSQL) — bezpieczna pula połączeń + odczyt raportowy z NOLOCK.
 *
 * PUNKT 5 (SQL):
 *  - Jedna, współdzielona pula `mssql` (nie otwieramy połączenia na zapytanie).
 *  - Odczyty raportowe z `WITH (NOLOCK)` — nie blokujemy pracowników klienta
 *    pracujących w Wapro (read-uncommitted; akceptowalne dla stanów do sprzedaży).
 *  - Zapisy (gdyby doszły) jawnie w transakcji przez `withTransaction`.
 *  - Wartości zawsze przez parametry; identyfikatory walidowane regexem.
 */

import sql from 'mssql'
import type { StockRow } from '../types'

export interface WaproConnectionConfig {
  host: string
  port?: number
  instanceName?: string
  database: string
  user: string
  password: string
  encrypt?: boolean
  trustServerCertificate?: boolean
  /** Maks. rozmiar puli — dobierz do obciążenia (domyślnie 5). */
  poolMax?: number
}

export interface StockQueryOptions {
  schema?: string // domyślnie 'dbo'
  articleTable?: string // domyślnie 'ARTYKUL' (realny WFMag)
  warehouseIds?: number[]
  subtractReserved?: boolean
  skipBlocked?: boolean
  aggregateWarehouses?: boolean
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$#]{0,127}$/
function ident(name: string, label = 'identyfikator'): string {
  if (!IDENT_RE.test(name)) throw new Error(`Nieprawidłowy ${label}: ${JSON.stringify(name)}`)
  return `[${name}]`
}

export class WaproRepository {
  private pool: sql.ConnectionPool | null = null
  private connecting: Promise<sql.ConnectionPool> | null = null

  constructor(private readonly config: WaproConnectionConfig) {}

  /** Zwraca (leniwie tworzoną) współdzieloną pulę połączeń. */
  async getPool(): Promise<sql.ConnectionPool> {
    if (this.pool?.connected) return this.pool
    if (this.connecting) return this.connecting

    const server = this.config.instanceName ? `${this.config.host}\\${this.config.instanceName}` : this.config.host
    const cfg: sql.config = {
      server,
      port: this.config.instanceName ? undefined : this.config.port ?? 1433,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      options: {
        encrypt: this.config.encrypt ?? false,
        trustServerCertificate: this.config.trustServerCertificate ?? true,
        enableArithAbort: true
      },
      pool: { max: this.config.poolMax ?? 5, min: 0, idleTimeoutMillis: 30_000 }
    }

    this.connecting = new sql.ConnectionPool(cfg)
      .connect()
      .then((p) => {
        this.pool = p
        this.connecting = null
        // Domyślnie READ UNCOMMITTED na tej puli — spójne z NOLOCK, brak blokad.
        return p
      })
      .catch((err) => {
        this.connecting = null
        throw err
      })

    return this.connecting
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close()
      this.pool = null
    }
  }

  /**
   * Odczyt snapshotu stanów z realnego WFMag (tabela ARTYKUL) z NOLOCK.
   * Stan efektywny = STAN - ZAREZERWOWANO (opcjonalnie), obcinany do >= 0.
   */
  async fetchStockSnapshot(options: StockQueryOptions = {}): Promise<StockRow[]> {
    const schema = ident(options.schema ?? 'dbo', 'schemat')
    const table = ident(options.articleTable ?? 'ARTYKUL', 'tabela')
    const subtract = options.subtractReserved ?? true
    const skipBlocked = options.skipBlocked ?? true
    const aggregate = options.aggregateWarehouses ?? true

    const pool = await this.getPool()
    const request = pool.request()

    const sku = `NULLIF(LTRIM(RTRIM(a.[INDEKS_KATALOGOWY])),'')`
    const skuExpr = `COALESCE(${sku}, NULLIF(LTRIM(RTRIM(a.[INDEKS_HANDLOWY])),''))`
    const qty = subtract
      ? `CAST(a.[STAN] AS DECIMAL(18,4)) - CAST(ISNULL(a.[ZAREZERWOWANO],0) AS DECIMAL(18,4))`
      : `CAST(a.[STAN] AS DECIMAL(18,4))`

    const where: string[] = [`${skuExpr} IS NOT NULL`]
    if (skipBlocked) where.push(`ISNULL(a.[ZABLOKOWANY],0) = 0`)

    if (options.warehouseIds?.length) {
      const params = options.warehouseIds.map((id, i) => {
        request.input(`mag${i}`, sql.Int, Number(id))
        return `@mag${i}`
      })
      where.push(`a.[ID_MAGAZYNU] IN (${params.join(', ')})`)
    }

    const whereSql = where.join(' AND ')

    // Uwaga: WITH (NOLOCK) = odczyt bez blokad (read-uncommitted).
    const query = aggregate
      ? `SELECT ${skuExpr} AS sku,
                MAX(a.[ID_ARTYKULU])       AS idArtykulu,
                MAX(a.[NAZWA])             AS nazwa,
                MAX(a.[KOD_KRESKOWY])      AS ean,
                SUM(${qty})                AS ilosc,
                NULL                       AS idMagazynu
         FROM ${schema}.${table} AS a WITH (NOLOCK)
         WHERE ${whereSql}
         GROUP BY ${skuExpr}
         ORDER BY sku`
      : `SELECT ${skuExpr} AS sku,
                a.[ID_ARTYKULU]   AS idArtykulu,
                a.[NAZWA]         AS nazwa,
                a.[KOD_KRESKOWY]  AS ean,
                ${qty}            AS ilosc,
                a.[ID_MAGAZYNU]   AS idMagazynu
         FROM ${schema}.${table} AS a WITH (NOLOCK)
         WHERE ${whereSql}
         ORDER BY sku, idMagazynu`

    const result = await request.query(query)
    return result.recordset.map((r: any) => ({
      idArtykulu: Number(r.idArtykulu) || 0,
      sku: String(r.sku).trim(),
      ean: r.ean == null ? '' : String(r.ean).trim(),
      name: r.nazwa == null ? '' : String(r.nazwa).trim(),
      quantity: Math.max(0, Math.floor(Number(r.ilosc) || 0)),
      warehouseId: r.idMagazynu == null ? null : Number(r.idMagazynu)
    }))
  }

  /**
   * Jawna transakcja dla zapisów (np. przyszły zapis zamówień do bufora).
   * Rollback przy błędzie, commit przy sukcesie.
   */
  async withTransaction<T>(work: (tx: sql.Transaction) => Promise<T>): Promise<T> {
    const pool = await this.getPool()
    const tx = new sql.Transaction(pool)
    await tx.begin()
    try {
      const out = await work(tx)
      await tx.commit()
      return out
    } catch (err) {
      try {
        await tx.rollback()
      } catch {
        /* rollback best-effort */
      }
      throw err
    }
  }
}
