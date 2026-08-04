import { getPool, sql, translateError } from './pool.js'
import { mergeProfile, quoteIdent, sectionRef, sectionSchema } from './schemaMap.js'

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
 * Zwraca zbiór (uppercase) nazw kolumn danej tabeli z INFORMATION_SCHEMA.
 * Dzięki temu przed użyciem kolumny (np. kodu kreskowego) sprawdzamy, czy w
 * ogóle istnieje w danej wersji Wapro — różne wydania mają różne schematy.
 */
async function fetchColumnSet(pool, schema, table) {
  const res = await pool
    .request()
    .input('schema', schema)
    .input('table', table)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
    `)
  return new Set(res.recordset.map((r) => String(r.COLUMN_NAME).toUpperCase()))
}

/**
 * Wybiera pierwszą z kandydujących kolumn, która NAPRAWDĘ istnieje w tabeli.
 * Zwraca nazwę kolumny (tak jak podana w kandydatach) albo null.
 */
function pickExistingColumn(columnSet, candidates = []) {
  for (const c of candidates) {
    if (c && columnSet.has(String(c).toUpperCase())) return c
  }
  return null
}

/**
 * Buduje wyrażenie wybierające pierwszy niepusty kandydat na SKU.
 * W Wapro część kartotek ma wypełniony tylko indeks katalogowy, część tylko
 * handlowy — COALESCE po NULLIF radzi sobie z obiema sytuacjami.
 */
function buildSkuExpression(map, alias = 'a') {
  const cols = map.artykuly.skuColumns
    .filter(Boolean)
    .map((c) => `NULLIF(LTRIM(RTRIM(${alias}.${quoteIdent(c, 'kolumna SKU')})), '')`)

  if (cols.length === 0) {
    throw new Error('Mapa schematu nie definiuje żadnej kolumny SKU.')
  }
  return cols.length === 1 ? cols[0] : `COALESCE(${cols.join(', ')})`
}

/**
 * Buduje wyrażenie ilości. Rezerwacje odejmujemy opcjonalnie — u części klientów
 * kolumna rezerwacji nie istnieje lub nie jest używana.
 */
function buildQuantityExpression(map, { subtractReserved }, alias = 's') {
  const stan = `${alias}.${quoteIdent(map.stany.quantity, 'kolumna stanu')}`

  if (!subtractReserved || !map.stany.reserved) {
    return `CAST(${stan} AS DECIMAL(18,4))`
  }
  const rez = `${alias}.${quoteIdent(map.stany.reserved, 'kolumna rezerwacji')}`
  return `CAST(${stan} AS DECIMAL(18,4)) - CAST(ISNULL(${rez}, 0) AS DECIMAL(18,4))`
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

  const map = mergeProfile(schemaOverrides)
  const pool = await getPool(dbSettings)

  const artykuly = sectionRef(map, 'artykuly')
  const stany = sectionRef(map, 'stany')

  const skuExpr = buildSkuExpression(map, 'a')
  const qtyExpr = buildQuantityExpression(map, { subtractReserved }, 's')

  const colArtId = quoteIdent(map.artykuly.id, 'ID artykułu')
  const colStanArt = quoteIdent(map.stany.articleId, 'ID artykułu w stanach')
  const colStanMag = quoteIdent(map.stany.warehouseId, 'ID magazynu')
  const colNazwa = quoteIdent(map.artykuly.name, 'nazwa artykułu')

  // Kod kreskowy (EAN) — kolumna OPCJONALNA i zależna od wersji Wapro. Zanim
  // wstawimy ją do zapytania, sprawdzamy w INFORMATION_SCHEMA, czy istnieje.
  // Kolejność kandydatów: najpierw ta z mapy schematu, potem typowe warianty.
  // Gdy żadnej nie ma — bezpiecznie zwracamy pusty string, nie wywalając SQL-a.
  const artSchema = sectionSchema(map, 'artykuly')
  const artColumns = await fetchColumnSet(pool, artSchema, map.artykuly.table)
  const barcodeCandidates = [
    map.artykuly.barcode,
    'PODSTAWOWY_KOD_KRESKOWY',
    'KOD_KRESKOWY',
    'KODKRESKOWY',
    'EAN',
    'KOD_EAN'
  ]
  const barcodeName = pickExistingColumn(artColumns, barcodeCandidates)
  const barcodeCol = barcodeName
    ? `a.${quoteIdent(barcodeName, 'kod kreskowy')}`
    : `CAST('' AS NVARCHAR(1))`
  if (!barcodeName) {
    console.warn(
      `[Wapro] Tabela ${artSchema}.${map.artykuly.table} nie ma kolumny kodu kreskowego ` +
        `(sprawdzono: ${barcodeCandidates.filter(Boolean).join(', ')}). ` +
        `Pole barcode = '' — dopasowanie ofert Allegro po EAN będzie ograniczone (zostają SKU i tytuł).`
    )
  }

  // --- filtry -------------------------------------------------------------
  const where = [`${skuExpr} IS NOT NULL`]
  const request = pool.request()

  if (skipArchived && map.artykuly.archivedFlag) {
    where.push(`ISNULL(a.${quoteIdent(map.artykuly.archivedFlag, 'flaga archiwum')}, 0) = 0`)
  }

  if (Array.isArray(warehouseIds) && warehouseIds.length > 0) {
    // Parametryzujemy każdy magazyn osobno — brak konkatenacji wartości.
    const params = warehouseIds.map((id, i) => {
      const p = `mag${i}`
      request.input(p, sql.Int, Number(id))
      return `@${p}`
    })
    where.push(`s.${colStanMag} IN (${params.join(', ')})`)
  }

  const whereSql = where.join('\n      AND ')

  // --- zapytanie ----------------------------------------------------------
  const query = aggregateWarehouses
    ? `
    SELECT
      ${skuExpr}                       AS sku,
      MAX(a.${colNazwa})               AS nazwa,
      MAX(${barcodeCol})               AS kod,
      SUM(${qtyExpr})                  AS ilosc,
      NULL                             AS id_magazynu
    FROM ${stany} AS s
    INNER JOIN ${artykuly} AS a
      ON a.${colArtId} = s.${colStanArt}
    WHERE ${whereSql}
    GROUP BY ${skuExpr}
    ORDER BY sku`
    : `
    SELECT
      ${skuExpr}          AS sku,
      a.${colNazwa}       AS nazwa,
      ${barcodeCol}       AS kod,
      ${qtyExpr}          AS ilosc,
      s.${colStanMag}     AS id_magazynu
    FROM ${stany} AS s
    INNER JOIN ${artykuly} AS a
      ON a.${colArtId} = s.${colStanArt}
    WHERE ${whereSql}
    ORDER BY sku, id_magazynu`

  try {
    const result = await request.query(query)

    return result.recordset.map((row) => ({
      sku: String(row.sku).trim(),
      name: row.nazwa == null ? '' : String(row.nazwa).trim(),
      barcode: row.kod == null ? '' : String(row.kod).trim(),
      // Stany w Wapro to NUMERIC — na kanały sprzedaży idzie liczba całkowita.
      // Obcinamy w dół: lepiej sprzedać mniej niż mieć nadsprzedaż.
      quantity: Math.max(0, Math.floor(Number(row.ilosc) || 0)),
      warehouseId: row.id_magazynu == null ? null : Number(row.id_magazynu)
    }))
  } catch (err) {
    throw translateError(err)
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
