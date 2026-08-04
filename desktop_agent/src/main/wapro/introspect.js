import { getPool, translateError } from './pool.js'
import { mergeProfile, requiredObjects, suggestTablesByRole } from './schemaMap.js'

/**
 * Introspekcja schematu Wapro.
 *
 * Uruchamiana z GUI ("Ustawienia Bazy" → "Sprawdź schemat"). Weryfikuje na
 * ŻYWEJ bazie, czy tabele i kolumny z mapy istnieją. Dla brakujących kolumn
 * podpowiada najbliższe nazwy z tej samej tabeli — dzięki temu wdrożenie
 * u klienta z nietypową wersją WF-Maga sprowadza się do poprawienia paru pól
 * w formularzu zamiast do debugowania zapytań.
 */

/** Prosta odległość Levenshteina — do podpowiedzi nazw kolumn. */
function distance(a, b) {
  const s = a.toUpperCase()
  const t = b.toUpperCase()
  const m = s.length
  const n = t.length
  if (m === 0) return n
  if (n === 0) return m

  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array(n + 1)

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

function suggest(target, candidates, limit = 3) {
  return candidates
    .map((c) => ({ name: c, d: distance(target, c) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, limit)
    .filter((x) => x.d <= Math.max(3, Math.floor(target.length / 2)))
    .map((x) => x.name)
}

/**
 * @returns {Promise<{ok:boolean, schema:string, tables:Array, summary:string}>}
 */
export async function introspectSchema(dbSettings, schemaOverrides = {}) {
  const map = mergeProfile(schemaOverrides)
  const pool = await getPool(dbSettings)

  let actual
  try {
    // Jedno zapytanie do INFORMATION_SCHEMA zamiast N zapytań per tabela.
    // Nie filtrujemy po schemacie — tabele klienta bywają ROZPROSZONE po
    // różnych schematach, a każda sekcja mapy może mieć własny.
    const res = await pool
      .request()
      .query(`
        SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
      `)
    actual = res.recordset
  } catch (err) {
    throw translateError(err)
  }

  // Kluczujemy po „SCHEMAT.TABELA", żeby rozróżnić tabele o tej samej nazwie
  // w różnych schematach. Dodatkowo zbieramy listę wszystkich pełnych nazw
  // (do podpowiedzi, gdy tabela z mapy nie istnieje).
  /** @type {Map<string, Map<string, object>>} */
  const byTable = new Map()
  const allFullNames = []
  for (const row of actual) {
    const key = `${String(row.TABLE_SCHEMA).toUpperCase()}.${String(row.TABLE_NAME).toUpperCase()}`
    if (!byTable.has(key)) {
      byTable.set(key, new Map())
      allFullNames.push(`${row.TABLE_SCHEMA}.${row.TABLE_NAME}`)
    }
    byTable.get(key).set(String(row.COLUMN_NAME).toUpperCase(), {
      name: row.COLUMN_NAME,
      type: row.DATA_TYPE,
      nullable: row.IS_NULLABLE === 'YES'
    })
  }

  const report = []
  let ok = true

  for (const spec of requiredObjects(map)) {
    const tableKey = `${String(spec.schema).toUpperCase()}.${spec.table.toUpperCase()}`
    const cols = byTable.get(tableKey)

    if (!cols) {
      ok = false
      report.push({
        table: spec.table,
        schema: spec.schema,
        section: spec.section,
        exists: false,
        missingRequired: spec.required,
        missingOptional: [],
        suggestions: {
          _table: suggest(spec.table, allFullNames)
        }
      })
      continue
    }

    const available = [...cols.values()].map((c) => c.name)
    const missingRequired = []
    const missingOptional = []
    const suggestions = {}

    for (const col of spec.columns) {
      if (cols.has(String(col).toUpperCase())) continue

      const isRequired = spec.required.includes(col)
      if (isRequired) {
        missingRequired.push(col)
        ok = false
      } else {
        missingOptional.push(col)
      }

      const hint = suggest(col, available)
      if (hint.length) suggestions[col] = hint
    }

    report.push({
      table: spec.table,
      schema: spec.schema,
      section: spec.section,
      exists: true,
      columnCount: available.length,
      missingRequired,
      missingOptional,
      suggestions
    })
  }

  const problems = report.filter((r) => !r.exists || r.missingRequired.length > 0)

  const summary = ok
    ? 'Schemat zgodny — wszystkie wymagane tabele i kolumny znalezione.'
    : `Wykryto ${problems.length} niezgodność(-ci). Popraw mapowanie w ustawieniach zaawansowanych.`

  return { ok, schema: map.schema, tables: report, summary }
}

/**
 * Wyszukiwarka tabel w bazie klienta.
 *
 * Odpytuje `sys.tables` (wszystkie schematy) i dopasowuje tabele do ról
 * (produkty / stany / magazyny) po frazach kluczowych w nazwie. Dzięki temu
 * wdrożenie u klienta z nietypowymi nazwami tabel („TW__Towar", „ST_Stany"
 * itp.) sprowadza się do wyboru z listy w GUI, a nie do zmian w kodzie.
 *
 * @returns {Promise<{tables:Array<{schema:string,name:string,fullName:string}>,
 *                     suggestions:{artykuly:Array,stany:Array,magazyny:Array}}>}
 */
export async function discoverTables(dbSettings) {
  const pool = await getPool(dbSettings)

  let rows
  try {
    const res = await pool.request().query(`
      SELECT s.name AS schema_name, t.name AS table_name
      FROM sys.tables AS t
      INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
      ORDER BY s.name, t.name
    `)
    rows = res.recordset
  } catch (err) {
    throw translateError(err)
  }

  const tables = rows.map((r) => ({
    schema: r.schema_name,
    name: r.table_name,
    fullName: `${r.schema_name}.${r.table_name}`
  }))

  // Ranking sugestii per rola — scorer działa na nazwie tabeli.
  const ranked = suggestTablesByRole(tables)
  // Ograniczamy sugestie do sensownej garści — pełna lista i tak jest w `tables`.
  const suggestions = {
    artykuly: ranked.artykuly.slice(0, 8),
    stany: ranked.stany.slice(0, 8),
    magazyny: ranked.magazyny.slice(0, 8)
  }

  return { tables, suggestions }
}

/**
 * Zwraca listę kolumn wskazanej tabeli — do podpowiedzi w GUI.
 */
export async function describeTable(dbSettings, tableName, schema = 'dbo') {
  const pool = await getPool(dbSettings)
  try {
    const res = await pool
      .request()
      .input('schema', schema)
      .input('table', tableName)
      .query(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
        ORDER BY ORDINAL_POSITION
      `)
    return res.recordset
  } catch (err) {
    throw translateError(err)
  }
}
