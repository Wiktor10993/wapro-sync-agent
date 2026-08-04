import { getPool, sql, translateError } from './pool.js'
import { mergeProfile, qualified, quoteIdent } from './schemaMap.js'
import { DDL, STAGING_SCHEMA, T_ITEMS, T_ORDERS } from './stagingSchema.js'
import { normalizeOrder, validateOrder } from './orderNormalizer.js'

/**
 * Zapis zamówień do tabeli pośredniej w bazie Wapro.
 *
 * Gwarancje:
 *  - IDEMPOTENCJA: unikalny indeks (ZRODLO, ID_ZEWNETRZNY) + sprawdzenie przed
 *    insertem. Ponowne przetworzenie tego samego zamówienia nie tworzy duplikatu.
 *  - ATOMOWOŚĆ: nagłówek i pozycje w jednej transakcji. Awaria w połowie zostawia
 *    bazę bez „ogryzka” zamówienia bez pozycji.
 *  - BRAK INGERENCJI W ERP: piszemy wyłącznie do schematu `integracja`.
 *    Na tabelach Wapro wykonujemy TYLKO SELECT (dopasowanie artykułów).
 */

// ---------------------------------------------------------------------------
// Tworzenie schematu
// ---------------------------------------------------------------------------

/**
 * Zakłada schemat `integracja` wraz z tabelami, widokiem i procedurami.
 * Idempotentne — bezpieczne przy każdym starcie agenta.
 */
export async function ensureStagingSchema(dbSettings, log = () => {}) {
  const pool = await getPool(dbSettings)
  const created = []

  for (const step of DDL) {
    try {
      await pool.request().batch(step.sql)
      created.push(step.name)
    } catch (err) {
      // Najczęstsza przyczyna: użytkownik MSSQL bez prawa CREATE.
      if (/permission|CREATE SCHEMA|denied/i.test(String(err.message))) {
        throw new Error(
          `Brak uprawnień do utworzenia obiektu "${step.name}". ` +
            `Użytkownik MSSQL potrzebuje jednorazowo praw CREATE SCHEMA / CREATE TABLE / CREATE PROCEDURE. ` +
            `Szczegóły: ${err.message}`
        )
      }
      throw translateError(err)
    }
  }

  log('success', `Schemat "${STAGING_SCHEMA}" gotowy (${created.length} obiektów zweryfikowanych).`)
  return { created }
}

/** Czy schemat pośredni istnieje i ma komplet obiektów? */
export async function stagingSchemaStatus(dbSettings) {
  const pool = await getPool(dbSettings)

  const res = await pool.request().input('schema', STAGING_SCHEMA).query(`
    SELECT o.name, o.type_desc
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE s.name = @schema
  `)

  const names = res.recordset.map((r) => String(r.name).toUpperCase())
  const required = [
    T_ORDERS,
    T_ITEMS,
    'V_DO_IMPORTU',
    'SP_OZNACZ_WYEKSPORTOWANE',
    'SP_OZNACZ_PRZETWORZONE',
    'SP_OZNACZ_BLAD'
  ]
  const missing = required.filter((r) => !names.includes(r))

  return { exists: names.length > 0, missing, ready: missing.length === 0 }
}

// ---------------------------------------------------------------------------
// Dopasowanie SKU do kartoteki
// ---------------------------------------------------------------------------

/**
 * Szuka ID_ARTYKULU dla listy SKU. Wyłącznie SELECT na dbo.ARTYKULY.
 *
 * @returns {Promise<Map<string, number>>} SKU (wielkimi literami) → ID_ARTYKULU
 */
export async function matchArticles(dbSettings, skus, schemaOverrides = {}) {
  const unique = [...new Set(skus.filter(Boolean).map((s) => String(s).trim()))]
  if (unique.length === 0) return new Map()

  const map = mergeProfile(schemaOverrides)
  const pool = await getPool(dbSettings)

  const table = qualified(map.schema, map.artykuly.table)
  const colId = quoteIdent(map.artykuly.id, 'ID artykułu')
  const skuCols = map.artykuly.skuColumns.filter(Boolean)
  const barcodeCol = map.artykuly.barcode

  const result = new Map()

  // SQL Server ma limit 2100 parametrów — dzielimy na paczki po 500.
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500)
    const request = pool.request()

    const params = chunk.map((sku, j) => {
      const p = `sku${j}`
      request.input(p, sql.NVarChar(128), sku)
      return `@${p}`
    })
    const inList = params.join(', ')

    // Każda kolumna-kandydat jest osobnym warunkiem OR; kolejność wyników
    // nie ma znaczenia, bo i tak mapujemy po zwróconej wartości.
    const conditions = skuCols.map(
      (c) => `LTRIM(RTRIM(${quoteIdent(c, 'kolumna SKU')})) IN (${inList})`
    )
    if (barcodeCol) {
      conditions.push(`LTRIM(RTRIM(${quoteIdent(barcodeCol, 'kod kreskowy')})) IN (${inList})`)
    }

    const selectCols = [
      `${colId} AS id_artykulu`,
      ...skuCols.map((c, k) => `LTRIM(RTRIM(${quoteIdent(c, 'kolumna SKU')})) AS sku${k}`)
    ]
    if (barcodeCol) {
      selectCols.push(`LTRIM(RTRIM(${quoteIdent(barcodeCol, 'kod kreskowy')})) AS barcode`)
    }

    try {
      const res = await request.query(`
        SELECT ${selectCols.join(', ')}
          FROM ${table}
         WHERE ${conditions.join(' OR ')}
      `)

      const wanted = new Set(chunk.map((s) => s.toUpperCase()))

      for (const row of res.recordset) {
        const id = Number(row.id_artykulu)
        for (const [key, value] of Object.entries(row)) {
          if (key === 'id_artykulu' || value == null) continue
          const candidate = String(value).trim().toUpperCase()
          if (candidate !== '' && wanted.has(candidate) && !result.has(candidate)) {
            result.set(candidate, id)
          }
        }
      }
    } catch (err) {
      throw translateError(err)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------

/**
 * Zapisuje jedno zamówienie do tabeli pośredniej.
 *
 * @param {object} options
 * @param {boolean} options.dryRun gdy true — nic nie zapisuje, zwraca podgląd
 * @returns {Promise<{status:'inserted'|'duplicate'|'invalid'|'dry-run', id?:number, ref:string, problems?:string[], preview?:object}>}
 */
export async function writeOrderToStaging(dbSettings, rawOrder, source, options = {}) {
  const { dryRun = false, schemaOverrides = {}, requireAllMatched = false } = options

  const order = normalizeOrder(rawOrder, source)
  const problems = validateOrder(order)

  if (problems.length > 0) {
    return { status: 'invalid', ref: order.documentRef, problems }
  }

  // --- dopasowanie artykułów -------------------------------------------
  const lookupKeys = order.items.flatMap((it) => [it.sku, it.barcode, it.fallbackRef].filter(Boolean))
  const matches = await matchArticles(dbSettings, lookupKeys, schemaOverrides)

  const items = order.items.map((it) => {
    const candidates = [it.sku, it.barcode, it.fallbackRef].filter(Boolean)
    let idArtykulu = null
    for (const c of candidates) {
      const hit = matches.get(String(c).trim().toUpperCase())
      if (hit !== undefined) {
        idArtykulu = hit
        break
      }
    }
    return { ...it, idArtykulu, matchStatus: idArtykulu === null ? 'BRAK_ARTYKULU' : 'OK' }
  })

  const unmatched = items.filter((i) => i.matchStatus === 'BRAK_ARTYKULU')

  if (requireAllMatched && unmatched.length > 0) {
    return {
      status: 'invalid',
      ref: order.documentRef,
      problems: [
        `Nie znaleziono w kartotece Wapro ${unmatched.length} pozycji: ` +
          unmatched.map((i) => i.sku || i.fallbackRef).join(', ')
      ]
    }
  }

  if (dryRun) {
    return {
      status: 'dry-run',
      ref: order.documentRef,
      preview: { ...order, items, unmatchedCount: unmatched.length }
    }
  }

  // --- zapis w transakcji ------------------------------------------------
  const pool = await getPool(dbSettings)
  const transaction = new sql.Transaction(pool)

  const ordersTable = `[${STAGING_SCHEMA}].[${T_ORDERS}]`
  const itemsTable = `[${STAGING_SCHEMA}].[${T_ITEMS}]`

  await transaction.begin()

  try {
    // Sprawdzenie duplikatu wewnątrz transakcji — dwa równoległe przebiegi
    // agenta nie wstawią tego samego zamówienia dwa razy.
    const dup = await new sql.Request(transaction)
      .input('zrodlo', sql.NVarChar(32), order.source)
      .input('ext', sql.NVarChar(128), order.externalId)
      .query(`SELECT ID_INTEGRACJA FROM ${ordersTable} WHERE ZRODLO = @zrodlo AND ID_ZEWNETRZNY = @ext`)

    if (dup.recordset.length > 0) {
      await transaction.rollback()
      return {
        status: 'duplicate',
        id: Number(dup.recordset[0].ID_INTEGRACJA),
        ref: order.documentRef
      }
    }

    const headerRes = await new sql.Request(transaction)
      .input('zrodlo', sql.NVarChar(32), order.source)
      .input('ext', sql.NVarChar(128), order.externalId)
      .input('numer', sql.NVarChar(160), order.documentRef)
      .input('data', sql.DateTime2, order.orderedAt ? new Date(order.orderedAt) : new Date())
      .input('knt_nazwa', sql.NVarChar(255), order.buyer.name)
      .input('knt_nip', sql.NVarChar(32), order.buyer.taxId || null)
      .input('knt_email', sql.NVarChar(160), order.buyer.email || null)
      .input('knt_tel', sql.NVarChar(64), order.buyer.phone || null)
      .input('ulica', sql.NVarChar(255), order.delivery.street || null)
      .input('kod', sql.NVarChar(16), order.delivery.postCode || null)
      .input('miasto', sql.NVarChar(128), order.delivery.city || null)
      .input('kraj', sql.NVarChar(8), order.delivery.countryCode || null)
      .input('dost_metoda', sql.NVarChar(128), order.delivery.method || null)
      .input('dost_koszt', sql.Decimal(18, 4), order.delivery.cost)
      .input('wartosc', sql.Decimal(18, 4), order.total)
      .input('waluta', sql.NVarChar(8), order.currency)
      .input('uwagi', sql.NVarChar(sql.MAX), order.notes || null)
      .input('json', sql.NVarChar(sql.MAX), JSON.stringify(rawOrder))
      .query(`
        INSERT INTO ${ordersTable}
          (ZRODLO, ID_ZEWNETRZNY, NUMER_OBCY, DATA_ZAMOWIENIA,
           KONTRAHENT_NAZWA, KONTRAHENT_NIP, KONTRAHENT_EMAIL, KONTRAHENT_TELEFON,
           ADRES_ULICA, ADRES_KOD, ADRES_MIASTO, ADRES_KRAJ,
           DOSTAWA_METODA, DOSTAWA_KOSZT, WARTOSC_BRUTTO, WALUTA, UWAGI, SUROWY_JSON)
        OUTPUT INSERTED.ID_INTEGRACJA
        VALUES
          (@zrodlo, @ext, @numer, @data,
           @knt_nazwa, @knt_nip, @knt_email, @knt_tel,
           @ulica, @kod, @miasto, @kraj,
           @dost_metoda, @dost_koszt, @wartosc, @waluta, @uwagi, @json)
      `)

    const idIntegracja = Number(headerRes.recordset[0].ID_INTEGRACJA)

    for (const item of items) {
      await new sql.Request(transaction)
        .input('id', sql.Int, idIntegracja)
        .input('lp', sql.Int, item.lp)
        .input('sku', sql.NVarChar(128), item.sku || item.fallbackRef || null)
        .input('ean', sql.NVarChar(64), item.barcode || null)
        .input('nazwa', sql.NVarChar(255), item.name || null)
        .input('ilosc', sql.Decimal(18, 4), item.quantity)
        .input('cena', sql.Decimal(18, 4), item.priceGross)
        .input('vat', sql.Decimal(9, 4), item.vatRate)
        .input('id_art', sql.Int, item.idArtykulu)
        .input('dop', sql.NVarChar(24), item.matchStatus)
        .query(`
          INSERT INTO ${itemsTable}
            (ID_INTEGRACJA, LP, SKU, KOD_KRESKOWY, NAZWA, ILOSC, CENA_BRUTTO, STAWKA_VAT, ID_ARTYKULU, DOPASOWANIE)
          VALUES (@id, @lp, @sku, @ean, @nazwa, @ilosc, @cena, @vat, @id_art, @dop)
        `)
    }

    await transaction.commit()

    return {
      status: 'inserted',
      id: idIntegracja,
      ref: order.documentRef,
      unmatchedCount: unmatched.length
    }
  } catch (err) {
    try {
      await transaction.rollback()
    } catch {
      // Transakcja mogła już zostać przerwana przez serwer — rollback wtedy rzuca.
    }

    if (/UQ_INT_ZAM_ZRODLO_ID|duplicate key/i.test(String(err.message))) {
      return { status: 'duplicate', ref: order.documentRef }
    }
    throw translateError(err)
  }
}

/**
 * Lista zamówień w tabeli pośredniej — do podglądu w GUI.
 */
export async function listStagedOrders(dbSettings, { status = '', limit = 100 } = {}) {
  const pool = await getPool(dbSettings)
  const request = pool.request()

  let where = ''
  if (status !== '') {
    request.input('status', sql.NVarChar(24), status)
    where = 'WHERE z.STATUS = @status'
  }

  const res = await request.query(`
    SELECT TOP (${Math.max(1, Math.min(500, Number(limit) || 100))})
      z.ID_INTEGRACJA, z.ZRODLO, z.ID_ZEWNETRZNY, z.NUMER_OBCY, z.STATUS,
      z.KONTRAHENT_NAZWA, z.WARTOSC_BRUTTO, z.WALUTA,
      z.DATA_ZAMOWIENIA, z.DATA_UTWORZENIA, z.NUMER_DOKUMENTU, z.KOMUNIKAT_BLEDU,
      (SELECT COUNT(*) FROM [${STAGING_SCHEMA}].[${T_ITEMS}] p
        WHERE p.ID_INTEGRACJA = z.ID_INTEGRACJA) AS POZYCJI,
      (SELECT COUNT(*) FROM [${STAGING_SCHEMA}].[${T_ITEMS}] p
        WHERE p.ID_INTEGRACJA = z.ID_INTEGRACJA AND p.DOPASOWANIE = 'BRAK_ARTYKULU') AS NIEDOPASOWANYCH
    FROM [${STAGING_SCHEMA}].[${T_ORDERS}] z
    ${where}
    ORDER BY z.ID_INTEGRACJA DESC
  `)

  return res.recordset.map((r) => ({
    id: Number(r.ID_INTEGRACJA),
    source: r.ZRODLO,
    externalId: r.ID_ZEWNETRZNY,
    ref: r.NUMER_OBCY,
    status: r.STATUS,
    buyer: r.KONTRAHENT_NAZWA,
    total: Number(r.WARTOSC_BRUTTO ?? 0),
    currency: r.WALUTA,
    orderedAt: r.DATA_ZAMOWIENIA,
    createdAt: r.DATA_UTWORZENIA,
    documentNumber: r.NUMER_DOKUMENTU,
    error: r.KOMUNIKAT_BLEDU,
    itemCount: Number(r.POZYCJI ?? 0),
    unmatchedCount: Number(r.NIEDOPASOWANYCH ?? 0)
  }))
}
