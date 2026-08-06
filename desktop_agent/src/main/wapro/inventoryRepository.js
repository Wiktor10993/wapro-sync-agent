import { getPool, sql, translateError } from './pool.js'
import {
  mergeProfile,
  optionalColumnExpr,
  quoteIdent,
  resolveStockColumns,
  sectionRef,
  sectionSchema
} from './schemaMap.js'

// Reeksport dla zgodności — logika diffu żyje w osobnym, bezzależnościowym module.
export { diffSnapshot } from './stockDiff.js'

/**
 * Repozytorium stanów magazynowych Wapro Mag.
 *
 * Zapytania budowane są z mapy schematu (schemaMap.js), nie zaszyte na sztywno —
 * pozwala to obsłużyć różnice między wersjami WF-Mag bez zmiany kodu.
 * Identyfikatory przechodzą przez quoteIdent(), wartości zawsze przez parametry
 * `mssql`. Nigdy nie sklejamy wartości do SQL-a.
 */

/**
 * Cache introspekcji kolumn. Bez niego każdy przebieg SyncUp (a przy dwóch
 * kanałach — BaseLinker i Allegro — dwa przebiegi) odpytywałby
 * INFORMATION_SCHEMA po kilka razy na cykl. Krótki TTL + ręczne unieważnianie
 * przy zapisie ustawień bazy/schematu daje aktualność bez zbędnych round-tripów.
 */
const _columnCache = new Map() // key -> { set, at }
const COLUMN_CACHE_TTL_MS = 60_000

/**
 * Krótki memo snapshotu stanów. Gdy włączone są OBA kanały (BaseLinker
 * i Allegro), ich przebiegi SyncUp startują w tym samym interwale — bez tego
 * pełny odczyt stanów z Wapro leciałby dwa razy w ciągu kilku sekund. TTL jest
 * celowo krótki (sekundy): dedupuje bliskie w czasie przebiegi, a nie cały cykl.
 */
const _snapshotCache = new Map() // key -> { rows, at }
const SNAPSHOT_CACHE_TTL_MS = 8_000

/** Klucz cache — rozróżnia bazy, żeby nie mieszać schematów między klientami. */
function dbCacheKey(dbSettings, schema, table) {
  return `${dbSettings?.host || '?'}/${dbSettings?.database || '?'}::${schema}.${table}`
}

/** Czyści cache introspekcji i snapshotu (po zmianie ustawień bazy/schematu). */
export function invalidateColumnCache() {
  _columnCache.clear()
  _snapshotCache.clear()
}

/**
 * Zwraca zbiór (uppercase) nazw kolumn danej tabeli z INFORMATION_SCHEMA.
 * Wynik jest cache'owany (TTL) — chyba że wymusimy odświeżenie (`force`).
 */
async function fetchColumnSet(pool, schema, table, { force = false, cacheKey = '' } = {}) {
  if (!force && cacheKey) {
    const hit = _columnCache.get(cacheKey)
    if (hit && Date.now() - hit.at < COLUMN_CACHE_TTL_MS) return hit.set
  }

  const res = await pool
    .request()
    .input('schema', schema)
    .input('table', table)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
    `)
  const set = new Set(res.recordset.map((r) => String(r.COLUMN_NAME).toUpperCase()))
  if (cacheKey) _columnCache.set(cacheKey, { set, at: Date.now() })
  return set
}

/**
 * Buduje wyrażenie SKU z REALNIE istniejących kolumn indeksu.
 * COALESCE po NULLIF radzi sobie, gdy część kartotek ma wypełniony tylko
 * indeks katalogowy, a część tylko handlowy.
 */
function buildSkuExpression(cols, alias = 'a') {
  const exprs = cols.skuColumns.map(
    (c) => `NULLIF(LTRIM(RTRIM(${alias}.${quoteIdent(c, 'kolumna SKU')})), '')`
  )
  return exprs.length === 1 ? exprs[0] : `COALESCE(${exprs.join(', ')})`
}

/**
 * Buduje wyrażenie ilości. Rezerwacja jest OPCJONALNA — gdy kolumny brak,
 * podstawiamy literał `0` (efekt: rezerwacja = 0), więc wyrażenie jest zawsze
 * poprawne, niezależnie od wersji Wapro.
 */
function buildQuantityExpression(cols, { subtractReserved }, alias = 's') {
  const stan = `CAST(${alias}.${quoteIdent(cols.quantity, 'kolumna stanu')} AS DECIMAL(18,4))`

  if (!subtractReserved) return stan

  // cols.reserved === null → default '0'; inaczej odnośnik do realnej kolumny.
  const rez = optionalColumnExpr(cols.reserved, { alias, defaultSql: '0' })
  return `${stan} - CAST(ISNULL(${rez}, 0) AS DECIMAL(18,4))`
}

/**
 * Pobiera pełny snapshot stanów dla wskazanych magazynów.
 *
 * @param {object} dbSettings ustawienia połączenia
 * @param {object} options
 * @param {number[]} options.warehouseIds ID magazynów (pusta tablica = wszystkie)
 * @param {boolean} options.subtractReserved czy odjąć rezerwacje
 * @param {boolean} options.skipArchived czy pominąć artykuły archiwalne
 * @param {boolean} options.aggregateWarehouses czy zsumować stany po SKU
 * @param {object} options.schemaOverrides nadpisania mapy schematu
 * @returns {Promise<Array<{sku:string, quantity:number, name:string, warehouseId:number|null}>>}
 */
export async function fetchStockSnapshot(dbSettings, options = {}) {
  const {
    warehouseIds = [],
    subtractReserved = true,
    skipArchived = true,
    aggregateWarehouses = true,
    schemaOverrides = {}
  } = options

  // Memo snapshotu: gdy oba kanały odpytują w tym samym cyklu, DB czytamy raz.
  const snapKey = `${dbCacheKey(dbSettings, '_', '_')}|${JSON.stringify({
    warehouseIds,
    subtractReserved,
    skipArchived,
    aggregateWarehouses,
    schemaOverrides
  })}`
  const cachedSnap = _snapshotCache.get(snapKey)
  if (cachedSnap && Date.now() - cachedSnap.at < SNAPSHOT_CACHE_TTL_MS) {
    return cachedSnap.rows
  }

  const map = mergeProfile(schemaOverrides)
  const pool = await getPool(dbSettings)

  const artykuly = sectionRef(map, 'artykuly')
  const stany = sectionRef(map, 'stany')
  const artSchema = sectionSchema(map, 'artykuly')
  const stanySchema = sectionSchema(map, 'stany')

  // --- adaptacyjne rozwiązanie kolumn ------------------------------------
  // Pobieramy realne kolumny obu tabel i dopasowujemy nazwy do tej instalacji
  // Wapro. Kolumny opcjonalne (rezerwacja, archiwum, EAN), których brak,
  // po prostu pomijamy — zamiast wywalać się na „Invalid column name".
  const [artColumns, stanyColumns] = await Promise.all([
    fetchColumnSet(pool, artSchema, map.artykuly.table, {
      cacheKey: dbCacheKey(dbSettings, artSchema, map.artykuly.table)
    }),
    fetchColumnSet(pool, stanySchema, map.stany.table, {
      cacheKey: dbCacheKey(dbSettings, stanySchema, map.stany.table)
    })
  ])

  const cols = resolveStockColumns(map, artColumns, stanyColumns)
  if (cols.missingRequired.length > 0) {
    throw new Error(
      `Wapro: w tabelach ${artSchema}.${map.artykuly.table} / ${stanySchema}.${map.stany.table} ` +
        `nie znaleziono wymaganych kolumn: ${cols.missingRequired.join(', ')}. ` +
        `Popraw mapowanie schematu (zakładka „Ustawienia Bazy”) lub wskaż właściwe tabele.`
    )
  }
  if (cols.droppedOptional.length > 0) {
    console.warn(
      `[Wapro] Kolumny opcjonalne pominięte (brak w tej wersji Wapro): ${cols.droppedOptional.join(', ')}. ` +
        (cols.reserved ? '' : 'Rezerwacje NIE są odejmowane. ') +
        (cols.barcode ? '' : 'Dopasowanie ofert po EAN ograniczone (zostają SKU i tytuł).')
    )
  }

  // Tryb JEDNOTABELOWY (realny WFMag): gdy artykuły i stany to ta sama tabela
  // (ARTYKUL trzyma STAN/ZAREZERWOWANO/ID_MAGAZYNU), pomijamy JOIN i czytamy
  // wszystko z jednego aliasu `a`. W przeciwnym razie klasyczny JOIN a↔s.
  const singleTable =
    artSchema.toUpperCase() === stanySchema.toUpperCase() &&
    String(map.artykuly.table).toUpperCase() === String(map.stany.table).toUpperCase()
  const stanAlias = singleTable ? 'a' : 's'

  const skuExpr = buildSkuExpression(cols, 'a')
  const qtyExpr = buildQuantityExpression(cols, { subtractReserved }, stanAlias)

  const colArtId = quoteIdent(cols.artId, 'ID artykułu')
  const colStanArt = quoteIdent(cols.stanArticleId, 'ID artykułu w stanach')
  const colStanMag = quoteIdent(cols.warehouseId, 'ID magazynu')
  const colNazwa = quoteIdent(cols.name, 'nazwa artykułu')

  // Kolumny OPCJONALNE → wyrażenie z domyślnym literałem, gdy kolumny brak.
  // Kod kreskowy: '' zamiast kolumny; flaga archiwum: 0 (czyli „nie archiwalny”),
  // więc filtr `= 0` przepuszcza wszystko, gdy kolumny nie ma.
  const barcodeCol = optionalColumnExpr(cols.barcode, { alias: 'a', defaultSql: `CAST('' AS NVARCHAR(1))` })
  const archivedExpr = `ISNULL(${optionalColumnExpr(cols.archived, { alias: 'a', defaultSql: '0' })}, 0)`

  // --- filtry -------------------------------------------------------------
  const where = [`${skuExpr} IS NOT NULL`]
  const request = pool.request()

  if (skipArchived) {
    // Gdy kolumny archiwum brak, archivedExpr == ISNULL(0,0) == 0 → warunek
    // zawsze prawdziwy (wszystko widoczne). Zero odwołań do nieistniejącej kolumny.
    where.push(`${archivedExpr} = 0`)
  }

  if (Array.isArray(warehouseIds) && warehouseIds.length > 0) {
    // Parametryzujemy każdy magazyn osobno — brak konkatenacji wartości.
    const params = warehouseIds.map((id, i) => {
      const p = `mag${i}`
      request.input(p, sql.Int, Number(id))
      return `@${p}`
    })
    where.push(`${stanAlias}.${colStanMag} IN (${params.join(', ')})`)
  }

  const whereSql = where.join('\n      AND ')

  // FROM: jednotabelowo (ARTYKUL) bez JOIN-a, albo klasyczny JOIN artykuły↔stany.
  const fromClause = singleTable
    ? `FROM ${artykuly} AS a`
    : `FROM ${stany} AS s
    INNER JOIN ${artykuly} AS a
      ON a.${colArtId} = s.${colStanArt}`

  // --- zapytanie ----------------------------------------------------------
  const query = aggregateWarehouses
    ? `
    SELECT
      ${skuExpr}                       AS sku,
      MAX(a.${colNazwa})               AS nazwa,
      MAX(${barcodeCol})               AS kod,
      SUM(${qtyExpr})                  AS ilosc,
      NULL                             AS id_magazynu
    ${fromClause}
    WHERE ${whereSql}
    GROUP BY ${skuExpr}
    ORDER BY sku`
    : `
    SELECT
      ${skuExpr}          AS sku,
      a.${colNazwa}       AS nazwa,
      ${barcodeCol}       AS kod,
      ${qtyExpr}          AS ilosc,
      ${stanAlias}.${colStanMag}     AS id_magazynu
    ${fromClause}
    WHERE ${whereSql}
    ORDER BY sku, id_magazynu`

  try {
    const result = await request.query(query)

    const rows = result.recordset.map((row) => ({
      sku: String(row.sku).trim(),
      name: row.nazwa == null ? '' : String(row.nazwa).trim(),
      barcode: row.kod == null ? '' : String(row.kod).trim(),
      // Stany w Wapro to NUMERIC — na kanały sprzedaży idzie liczba całkowita.
      // Obcinamy w dół: lepiej sprzedać mniej niż mieć nadsprzedaż.
      quantity: Math.max(0, Math.floor(Number(row.ilosc) || 0)),
      warehouseId: row.id_magazynu == null ? null : Number(row.id_magazynu)
    }))

    _snapshotCache.set(snapKey, { rows, at: Date.now() })
    return rows
  } catch (err) {
    throw translateError(err)
  }
}

/**
 * Diagnostyka schematu stanów — „koło ratunkowe" dla GUI.
 *
 * Pokazuje, jak resolver rozwiązał każdą kolumnę: która realna kolumna została
 * użyta, czy kolumna opcjonalna została znaleziona, czy zadziałał plastyczny
 * fallback, oraz których kolumn WYMAGANYCH brakuje. Zawsze wymusza świeżą
 * introspekcję (pomija cache), bo to jawne „wykryj ponownie".
 *
 * @returns {Promise<object>}
 */
export async function getStockSchemaDiagnostics(dbSettings, schemaOverrides = {}) {
  const map = mergeProfile(schemaOverrides)
  const pool = await getPool(dbSettings)

  const artSchema = sectionSchema(map, 'artykuly')
  const stanySchema = sectionSchema(map, 'stany')

  const [artColumns, stanyColumns] = await Promise.all([
    fetchColumnSet(pool, artSchema, map.artykuly.table, { force: true }),
    fetchColumnSet(pool, stanySchema, map.stany.table, { force: true })
  ])
  // Odśwież też cache używany przez synchronizację, żeby był spójny z podglądem.
  _columnCache.set(dbCacheKey(dbSettings, artSchema, map.artykuly.table), { set: artColumns, at: Date.now() })
  _columnCache.set(dbCacheKey(dbSettings, stanySchema, map.stany.table), { set: stanyColumns, at: Date.now() })

  const cols = resolveStockColumns(map, artColumns, stanyColumns)

  const toField = (key, label, section, required, resolved, fallback) => {
    const isArr = Array.isArray(resolved)
    const found = isArr ? resolved.length > 0 : Boolean(resolved)
    return {
      key,
      label,
      section,
      required,
      resolved: isArr ? resolved.join(', ') : resolved || null,
      found,
      usedFallback: required ? false : !found,
      fallback: fallback ?? null
    }
  }

  const fields = [
    toField('artId', 'ID artykułu', 'artykuly', true, cols.artId),
    toField('name', 'Nazwa artykułu', 'artykuly', true, cols.name),
    toField('sku', 'SKU / indeks', 'artykuly', true, cols.skuColumns),
    toField('barcode', 'Kod kreskowy / EAN', 'artykuly', false, cols.barcode, "'' (pusty)"),
    toField('archived', 'Flaga archiwum', 'artykuly', false, cols.archived, '0 (brak filtra — widać wszystko)'),
    toField('stanArticleId', 'ID artykułu w stanach', 'stany', true, cols.stanArticleId),
    toField('warehouseId', 'ID magazynu', 'stany', true, cols.warehouseId),
    toField('quantity', 'Stan / ilość', 'stany', true, cols.quantity),
    toField('reserved', 'Rezerwacja', 'stany', false, cols.reserved, '0 (nie odejmowana)')
  ]

  return {
    ok: cols.missingRequired.length === 0,
    tables: {
      artykuly: { schema: artSchema, table: map.artykuly.table, columnCount: artColumns.size },
      stany: { schema: stanySchema, table: map.stany.table, columnCount: stanyColumns.size }
    },
    fields,
    missingRequired: cols.missingRequired,
    droppedOptional: cols.droppedOptional
  }
}

/**
 * Lista magazynów — do wyboru w GUI.
 */
export async function fetchWarehouses(dbSettings, schemaOverrides = {}) {
  const map = mergeProfile(schemaOverrides)
  const pool = await getPool(dbSettings)

  const table = sectionRef(map, 'magazyny')
  const id = quoteIdent(map.magazyny.id, 'ID magazynu')
  const symbol = map.magazyny.symbol ? quoteIdent(map.magazyny.symbol, 'symbol') : null
  const name = map.magazyny.name ? quoteIdent(map.magazyny.name, 'nazwa magazynu') : null

  const cols = [`${id} AS id`]
  cols.push(symbol ? `${symbol} AS symbol` : `CAST('' AS NVARCHAR(1)) AS symbol`)
  cols.push(name ? `${name} AS nazwa` : `CAST('' AS NVARCHAR(1)) AS nazwa`)

  try {
    const result = await pool.request().query(
      `SELECT ${cols.join(', ')} FROM ${table} ORDER BY 1`
    )
    return result.recordset.map((r) => ({
      id: Number(r.id),
      symbol: String(r.symbol ?? '').trim(),
      name: String(r.nazwa ?? '').trim()
    }))
  } catch (err) {
    throw translateError(err)
  }
}
