import fs from 'node:fs/promises'
import path from 'node:path'
import { getPool, sql, translateError } from './pool.js'
import { buildEcoFromBuffer } from './ecoXml.js'
import { STAGING_SCHEMA, T_ITEMS, T_ORDERS } from './stagingSchema.js'

/**
 * REFLEKTOR BUFORA — „ostatni milimetr" integracji
 * ================================================
 *
 * Zamienia zamówienia z tabeli pośredniej `integracja.ZAMOWIENIA` na pliki XML
 * w formacie ECO i odkłada je do folderu nasłuchu Wapro. To ostatni etap, po
 * którym dane wchodzą do ERP jego własnym mechanizmem importu.
 *
 * DLACZEGO TĄ DROGĄ, A NIE TRIGGEREM WSTAWIAJĄCYM DOKUMENT ZAM
 * -------------------------------------------------------------
 * Natywny import Wapro sam załatwia numerację dokumentów, dopasowanie lub
 * założenie kontrahenta, rejestry VAT, powiązania magazynowe i rozrachunki.
 * Trigger wstawiający wiersze wprost do tabel dokumentów musiałby tę logikę
 * odtworzyć — a jej struktura różni się między wydaniami WF-Maga. Gorzej:
 * trigger wykonuje się w NASZEJ transakcji, więc błąd po stronie ERP potrafi
 * ją wycofać albo zostawić blokady na tabelach produkcyjnych.
 *
 * Reflektor odwraca ten układ: my przygotowujemy dane (dopasowany ID_ARTYKULU,
 * odfiltrowane duplikaty, komplet danych kontrahenta), a decyzję o utworzeniu
 * dokumentu podejmuje Wapro. Ryzyko dla danych księgowych: zerowe.
 *
 * IDEMPOTENCJA
 * ------------
 * Kolejność jest celowa: najpierw zapisujemy plik, dopiero potem oznaczamy
 * wiersz jako WYEKSPORTOWANY. Odwrotna kolejność groziłaby zgubieniem
 * zamówienia przy awarii dysku. Przy tej kolejności najgorszy scenariusz to
 * plik zapisany dwa razy — a przed tym broni sprawdzenie istnienia pliku
 * oraz licznik PROB_EKSPORTU.
 */

const MAX_EXPORT_ATTEMPTS = 5

/** Bezpieczna nazwa pliku: bez znaków, które Windows odrzuca. */
function safeFileName(zrodlo, idBufora, numerObcy) {
  const base = `${zrodlo}_${idBufora}_${numerObcy}`
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 120)
  return `${base}.xml`
}

/**
 * Pobiera zamówienia gotowe do eksportu wraz z pozycjami.
 *
 * @returns {Promise<Array<{header:object, items:Array<object>}>>}
 */
async function fetchPending(pool, { limit, requireAllMatched }) {
  const ordersTable = `[${STAGING_SCHEMA}].[${T_ORDERS}]`
  const itemsTable = `[${STAGING_SCHEMA}].[${T_ITEMS}]`

  const matchFilter = requireAllMatched
    ? `AND NOT EXISTS (SELECT 1 FROM ${itemsTable} p
                        WHERE p.ID_INTEGRACJA = z.ID_INTEGRACJA
                          AND p.DOPASOWANIE = 'BRAK_ARTYKULU')`
    : ''

  const headersRes = await pool
    .request()
    .input('limit', sql.Int, Math.max(1, Math.min(500, limit)))
    .input('maxProby', sql.Int, MAX_EXPORT_ATTEMPTS)
    .query(`
      SELECT TOP (@limit)
        z.ID_INTEGRACJA, z.ZRODLO, z.ID_ZEWNETRZNY, z.NUMER_OBCY, z.DATA_ZAMOWIENIA,
        z.KONTRAHENT_NAZWA, z.KONTRAHENT_NIP, z.KONTRAHENT_EMAIL, z.KONTRAHENT_TELEFON,
        z.ADRES_ULICA, z.ADRES_KOD, z.ADRES_MIASTO, z.ADRES_KRAJ,
        z.DOSTAWA_METODA, z.DOSTAWA_KOSZT, z.WARTOSC_BRUTTO, z.WALUTA, z.UWAGI,
        z.PROB_EKSPORTU
      FROM ${ordersTable} z
      WHERE z.STATUS = 'NOWE'
        AND z.PROB_EKSPORTU < @maxProby
        ${matchFilter}
      ORDER BY z.ID_INTEGRACJA
    `)

  const headers = headersRes.recordset
  if (headers.length === 0) return []

  // Pozycje jednym zapytaniem zamiast N+1.
  const request = pool.request()
  const params = headers.map((h, i) => {
    request.input(`id${i}`, sql.Int, h.ID_INTEGRACJA)
    return `@id${i}`
  })

  const itemsRes = await request.query(`
    SELECT ID_INTEGRACJA, LP, SKU, KOD_KRESKOWY, NAZWA AS NAZWA_POZYCJI,
           ILOSC, CENA_BRUTTO, STAWKA_VAT, ID_ARTYKULU, DOPASOWANIE
      FROM ${itemsTable}
     WHERE ID_INTEGRACJA IN (${params.join(', ')})
     ORDER BY ID_INTEGRACJA, LP
  `)

  const byOrder = new Map()
  for (const row of itemsRes.recordset) {
    const key = Number(row.ID_INTEGRACJA)
    if (!byOrder.has(key)) byOrder.set(key, [])
    byOrder.get(key).push(row)
  }

  return headers.map((header) => ({
    header,
    items: byOrder.get(Number(header.ID_INTEGRACJA)) ?? []
  }))
}

/**
 * Eksportuje bufor do folderu nasłuchu Wapro.
 *
 * @param {object} dbSettings
 * @param {object} options
 * @param {string} options.folder folder nasłuchu Wapro
 * @param {boolean} [options.requireAllMatched] pomijaj zamówienia z niedopasowanymi pozycjami
 * @param {number} [options.limit]
 * @param {boolean} [options.dryRun] nie zapisuj plików ani nie zmieniaj statusów
 * @param {(level:string,msg:string)=>void} [log]
 */
export async function reflectBufferToXml(dbSettings, options = {}, log = () => {}) {
  const {
    folder,
    requireAllMatched = false,
    limit = 100,
    dryRun = false
  } = options

  if (!folder || String(folder).trim() === '') {
    throw new Error('Nie wskazano folderu nasłuchu Wapro dla plików XML.')
  }

  const pool = await getPool(dbSettings)

  let pending
  try {
    pending = await fetchPending(pool, { limit, requireAllMatched })
  } catch (err) {
    throw translateError(err)
  }

  if (pending.length === 0) {
    log('info', 'Reflektor: brak zamówień do wyeksportowania.')
    return { exported: 0, skipped: 0, failed: 0, files: [] }
  }

  if (dryRun) {
    log('info', `Reflektor (symulacja): ${pending.length} zamówień gotowych do eksportu.`)
    return {
      dryRun: true,
      exported: 0,
      pending: pending.length,
      preview: pending.slice(0, 5).map(({ header, items }) => ({
        id: Number(header.ID_INTEGRACJA),
        ref: header.NUMER_OBCY,
        file: safeFileName(header.ZRODLO, header.ID_INTEGRACJA, header.NUMER_OBCY),
        items: items.length,
        unmatched: items.filter((i) => i.DOPASOWANIE === 'BRAK_ARTYKULU').length,
        xml: buildEcoFromBuffer(header, items)
      }))
    }
  }

  await fs.mkdir(folder, { recursive: true })

  const files = []
  let exported = 0
  let skipped = 0
  let failed = 0

  for (const { header, items } of pending) {
    const id = Number(header.ID_INTEGRACJA)
    const fileName = safeFileName(header.ZRODLO, id, header.NUMER_OBCY)
    const target = path.join(folder, fileName)

    try {
      if (items.length === 0) {
        await markError(pool, id, 'Zamówienie w buforze nie ma pozycji — nie ma czego eksportować.')
        failed++
        log('error', `Reflektor: bufor #${id} bez pozycji — oznaczono jako BLAD.`)
        continue
      }

      // Plik już leży w folderze — Wapro mógł go jeszcze nie wciągnąć.
      // Nie nadpisujemy, tylko domykamy status, żeby nie zapętlić eksportu.
      let alreadyThere = false
      try {
        await fs.access(target)
        alreadyThere = true
      } catch {
        alreadyThere = false
      }

      if (!alreadyThere) {
        const xml = buildEcoFromBuffer(header, items)

        // Zapis atomowy: .tmp → rename. Wapro nigdy nie zobaczy pliku
        // w połowie zapisu, co przy folderze nasłuchu jest krytyczne.
        const tmp = `${target}.tmp`
        await fs.writeFile(tmp, xml, 'utf8')
        await fs.rename(tmp, target)
      } else {
        skipped++
      }

      const updated = await markExported(pool, id, fileName)

      if (updated === 0) {
        // Ktoś zmienił status równolegle (np. operator albo drugi przebieg).
        log('warn', `Reflektor: bufor #${id} zmienił status w trakcie — pomijam.`)
        continue
      }

      exported++
      files.push(fileName)

      const unmatched = items.filter((i) => i.DOPASOWANIE === 'BRAK_ARTYKULU').length
      log(
        unmatched > 0 ? 'warn' : 'info',
        `Reflektor: ${fileName}` +
          (alreadyThere ? ' (plik już istniał)' : '') +
          (unmatched > 0 ? `, ${unmatched} pozycji bez ID_ARTYKULU` : '')
      )
    } catch (err) {
      failed++
      log('error', `Reflektor: bufor #${id} — ${err.message}`)

      // Licznik prób rośnie także przy błędzie, żeby uszkodzony rekord
      // nie blokował kolejki w nieskończoność.
      try {
        await bumpAttempts(pool, id, err.message)
      } catch {
        /* nie zagłuszamy pierwotnego błędu */
      }
    }
  }

  if (exported > 0) {
    log('success', `Reflektor: wyeksportowano ${exported} zamówień do ${folder}`)
  }

  return { exported, skipped, failed, files }
}

async function markExported(pool, idIntegracja, fileName) {
  const res = await pool
    .request()
    .input('ID_INTEGRACJA', sql.Int, idIntegracja)
    .input('PLIK', sql.NVarChar(400), fileName)
    .execute(`[${STAGING_SCHEMA}].[SP_OZNACZ_WYEKSPORTOWANE]`)

  return Number(res.recordset?.[0]?.ZAKTUALIZOWANO ?? 0)
}

async function markError(pool, idIntegracja, message) {
  await pool
    .request()
    .input('ID_INTEGRACJA', sql.Int, idIntegracja)
    .input('KOMUNIKAT', sql.NVarChar(1000), String(message).slice(0, 1000))
    .execute(`[${STAGING_SCHEMA}].[SP_OZNACZ_BLAD]`)
}

async function bumpAttempts(pool, idIntegracja, message) {
  await pool
    .request()
    .input('id', sql.Int, idIntegracja)
    .input('msg', sql.NVarChar(1000), String(message).slice(0, 1000))
    .query(`
      UPDATE [${STAGING_SCHEMA}].[${T_ORDERS}]
         SET PROB_EKSPORTU = PROB_EKSPORTU + 1,
             KOMUNIKAT_BLEDU = @msg,
             STATUS = CASE WHEN PROB_EKSPORTU + 1 >= ${MAX_EXPORT_ATTEMPTS} THEN 'BLAD' ELSE STATUS END
       WHERE ID_INTEGRACJA = @id
    `)
}

/**
 * Statystyki bufora — do kafelków w GUI.
 */
export async function bufferStats(dbSettings) {
  const pool = await getPool(dbSettings)

  const res = await pool.request().query(`
    SELECT STATUS, COUNT(*) AS ILE
      FROM [${STAGING_SCHEMA}].[${T_ORDERS}]
     GROUP BY STATUS
  `)

  const out = { NOWE: 0, WYEKSPORTOWANE: 0, PRZETWORZONE: 0, BLAD: 0, POMINIETE: 0 }
  for (const r of res.recordset) {
    out[String(r.STATUS)] = Number(r.ILE)
  }
  return out
}
