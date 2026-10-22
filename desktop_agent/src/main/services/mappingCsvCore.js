/**
 * mappingCsvCore.js — czysta logika pliku mapowania (bez Electrona i bazy).
 *
 * Plik ma JEDEN wiersz na produkt WAPRO i osobne kolumny na numery ofert:
 *   indeks_wapro | ean | nazwa_wapro | stan_wapro |
 *   allegro_<konto1>_numer_oferty | allegro_<konto2>_numer_oferty |
 *   baselinker_id_produktu | zrodlo_mapowania (tylko informacyjna)
 *
 * Zasada: wypełniona komórka = mapujemy ten kanał/konto; pusta = bez zmian.
 * Wpisane oba (Allegro i BaseLinker) → mapujemy oba; jedno → tylko jedno.
 *
 * Rozpoznawanie kolumn jest tolerancyjne: działają też starsze pliki
 * (`indeks_katalogowy`, `allegro_nr_aukcji`, `baselinker_product_id`).
 */

/** Nagłówek → klucz porównawczy: małe litery, bez polskich znaków, `_` zamiast reszty. */
export function normalizeHeader(h) {
  return String(h ?? '')
    .replace(/ł/gi, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Krótki identyfikator konta do nagłówka kolumny (login albo nazwa konta). */
export function accountSlug(account) {
  const k = normalizeHeader(account?.accountLogin || account?.label || account?.id || 'konto')
  // Sama liczba (np. konto nazwane „1") nic nie mówi w nagłówku → „konto_1".
  return /^\d+$/.test(k) ? `konto_${k}` : k
}

/** Nagłówek kolumny stanu oferty na koncie Allegro (eksporty i raporty). */
export function allegroStockHeader(account) {
  return `stan_allegro_${accountSlug(account)}`
}

/**
 * Indeks ofert JEDNEGO konta Allegro do łączenia z pozycjami WAPRO w eksportach
 * i raportach: najpierw mapowanie oferta → indeks (CSV / automapowanie), potem
 * sygnatura, EAN i (unikalna) nazwa.
 * @param {Array<{offerId:string, sku?:string, ean?:string, name?:string}>} offers
 * @param {Map<string,string>} offerSku offerId → indeks WAPRO
 * @param {(s:string)=>string} normalizeName
 * @returns {(w:{sku:string, ean?:string, name?:string}) => object|null}
 */
export function buildAccountOfferFinder(offers, offerSku = new Map(), normalizeName = (s) => String(s ?? '').toLowerCase()) {
  const bySku = new Map()
  const byEan = new Map()
  const byName = new Map()
  for (const o of offers) {
    const mapped = offerSku.get(String(o.offerId))
    if (mapped) bySku.set(String(mapped).trim().toLowerCase(), o) // mapowanie wygrywa
  }
  for (const o of offers) {
    const ext = String(o.sku ?? '').trim().toLowerCase()
    if (ext && !bySku.has(ext)) bySku.set(ext, o)
    const ean = String(o.ean ?? '').trim()
    if (ean && !byEan.has(ean)) byEan.set(ean, o)
    const n = normalizeName(o.name ?? '')
    if (n) byName.set(n, byName.has(n) ? null : o)
  }
  return (w) => {
    const sku = String(w?.sku ?? '').trim().toLowerCase()
    if (sku && bySku.has(sku)) return bySku.get(sku)
    const ean = String(w?.ean ?? '').trim()
    if (ean && byEan.has(ean)) return byEan.get(ean)
    const n = normalizeName(w?.name ?? '')
    return (n && byName.get(n)) || null
  }
}

/** Nagłówek kolumny numeru oferty dla konta Allegro. */
export function allegroColumnHeader(account) {
  return `allegro_${accountSlug(account)}_numer_oferty`
}

export const BASELINKER_HEADER = 'baselinker_id_produktu'
export const INFO_HEADER = 'zrodlo_mapowania'

const SKU_EXACT = new Set(['sku', 'symbol', 'kod_towaru', 'kod'])
const EAN_EXACT = new Set(['kod_kreskowy', 'gtin', 'barcode'])
const ALLEGRO_LEGACY = new Set(['nr_aukcji', 'aukcja', 'oferta', 'offer_id'])
const BL_LEGACY = new Set(['base', 'nr_base', 'base_product_id', 'product_id', 'bl_id', 'magazyn_base'])
// Kolumny opisowe z nazwą kanału — NIE są numerami ofert (np. plik kontrolny).
const DESCRIPTIVE = /(^|_)(tytul|nazwa|kod_producenta|metoda|login|stan|zrodlo|uwagi|lista|listy)(_|$)/

/**
 * Rozpoznaje kolumny pliku.
 * @param {string[]} headers surowe nagłówki
 * @param {Array<{id:string,label?:string,accountLogin?:string}>} accounts konta Allegro
 * @returns {{sku:string|null, ean:string|null, baselinker:string[], allegro:Array<{header:string, accountId:string}>}}
 *          `header` = nagłówek po normalizacji (tak jak klucze rekordów z parseCsv po normalizeRecordKeys)
 */
export function classifyColumns(headers, accounts = []) {
  const out = { sku: null, ean: null, baselinker: [], allegro: [] }
  const slugs = accounts.map((a) => ({ id: a.id, slugs: [accountSlug(a), normalizeHeader(a.label), normalizeHeader(a.accountLogin)].filter((s) => s.length >= 1) }))

  for (const raw of headers) {
    const h = normalizeHeader(raw)
    if (!h) continue
    if (!out.sku && (SKU_EXACT.has(h) || h.startsWith('indeks'))) {
      out.sku = h
      continue
    }
    if (!out.ean && (EAN_EXACT.has(h) || h === 'ean' || h.startsWith('ean_'))) {
      out.ean = h
      continue
    }
    if (h.includes('allegro') || ALLEGRO_LEGACY.has(h)) {
      const rest = h.replace(/^allegro_?/, '')
      let acc = null
      let tail = h
      for (const a of slugs) {
        const s = a.slugs.find((x) => rest === x || rest.startsWith(`${x}_`))
        if (s) {
          acc = a
          tail = rest.slice(s.length)
          break
        }
      }
      // Nazwa konta może zawierać np. „stan" — opisowość sprawdzamy bez niej.
      if (DESCRIPTIVE.test(tail)) continue
      out.allegro.push({ header: h, accountId: acc?.id ?? '' })
      continue
    }
    if (DESCRIPTIVE.test(h)) continue
    if (/(^|_)(baselinker|bl)(_|$)/.test(h) || h === 'baselinker' || BL_LEGACY.has(h)) {
      out.baselinker.push(h)
    }
  }
  return out
}

/** Klucze rekordu z parseCsv → znormalizowane nagłówki. */
export function normalizeRecordKeys(rec) {
  const out = {}
  for (const [k, v] of Object.entries(rec)) {
    const nk = normalizeHeader(k)
    if (!(nk in out) || String(out[nk] ?? '').trim() === '') out[nk] = v
  }
  return out
}

/**
 * Wartość komórki: zdejmuje zapis ="…" (wzorzec chroni tak liczby przed Excelem),
 * spacje i apostrof wiodący.
 */
export function cleanCell(v) {
  let s = String(v ?? '').trim()
  const m = s.match(/^="?(.*?)"?$/)
  if (m) s = m[1]
  return s.replace(/^'/, '').replace(/\s+/g, '').trim()
}

const SCIENTIFIC = /^\d+([.,]\d+)?e\+?\d+$/i

/** Walidacja numeru oferty. @returns {string|null} komunikat błędu albo null */
export function validateOfferId(value, channel) {
  if (SCIENTIFIC.test(value)) {
    return `numer zapisany przez Excel w notacji naukowej (${value}) — ustaw format kolumny „Tekst" i wpisz numer ponownie`
  }
  if (channel === 'allegro' && !/^\d{8,14}$/.test(value)) {
    return `„${value}" nie wygląda na numer oferty Allegro (same cyfry, zwykle 11)`
  }
  if (channel === 'baselinker' && !/^\d{1,12}$/.test(value)) {
    return `„${value}" nie wygląda na ID produktu BaseLinker (same cyfry)`
  }
  return null
}

/**
 * Zamienia rekordy CSV na mapowania do zapisu.
 * @param {object[]} records rekordy z parseCsv
 * @param {ReturnType<typeof classifyColumns>} cols
 * @returns {{
 *   items: Array<{line:number, sku:string, ean:string, allegro:Array<{offerId:string, accountId:string}>, baselinker:string}>,
 *   errors: Array<{line:number, sku:string, message:string}>,
 *   empty: number
 * }}
 */
export function parseMappingRecords(records, cols) {
  const items = []
  const errors = []
  let empty = 0
  records.forEach((raw, i) => {
    const line = i + 2 // 1 = nagłówek
    const rec = normalizeRecordKeys(raw)
    const sku = cols.sku ? cleanCell(rec[cols.sku]) : ''
    const ean = cols.ean ? cleanCell(rec[cols.ean]) : ''

    const allegro = []
    let baselinker = ''
    let rowHasError = false
    for (const col of cols.allegro) {
      const v = cleanCell(rec[col.header])
      if (!v) continue
      const err = validateOfferId(v, 'allegro')
      if (err) {
        errors.push({ line, sku, message: `kolumna ${col.header}: ${err}` })
        rowHasError = true
        continue
      }
      allegro.push({ offerId: v, accountId: col.accountId })
    }
    for (const h of cols.baselinker) {
      const v = cleanCell(rec[h])
      if (!v) continue
      const err = validateOfferId(v, 'baselinker')
      if (err) {
        errors.push({ line, sku, message: `kolumna ${h}: ${err}` })
        rowHasError = true
        continue
      }
      baselinker = v
      break
    }

    if (allegro.length === 0 && !baselinker) {
      if (!rowHasError) empty++
      return
    }
    if (!sku && !ean) {
      errors.push({ line, sku: '', message: 'brak indeksu WAPRO i EAN — nie wiadomo, którego produktu dotyczy wiersz' })
      return
    }
    items.push({ line, sku, ean, allegro, baselinker })
  })
  return { items, errors, empty }
}

/** Komórka chroniona przed Excelem (długie liczby, wiodące zera). */
export function excelText(v) {
  const s = String(v ?? '')
  return s === '' ? '' : `="${s.replace(/"/g, '""')}"`
}

/** Etykieta źródła dopasowania do kolumny informacyjnej. */
export function viaLabel(via) {
  return { manual: 'ręcznie (CSV)', ean: 'auto: EAN', sku: 'auto: indeks/kod', name: 'auto: nazwa — sprawdź!' }[via] || via || ''
}

/**
 * Buduje wzorzec: nagłówki i wiersze (wartości już gotowe do toCsv).
 * @param {Array<{sku:string, ean:string, name:string, quantity:number}>} wapro
 * @param {Array<{id:string,label:string,accountLogin?:string}>} accounts
 * @param {{allegro: Map<string, Map<string,{offerId:string, via:string}>>, baselinker: Map<string,{offerId:string, via:string}>}} existing
 *        allegro: accountId → (sku → oferta); baselinker: sku → produkt
 */
export function buildTemplate(wapro, accounts, existing = { allegro: new Map(), baselinker: new Map() }) {
  const headers = ['indeks_wapro', 'ean', 'nazwa_wapro', 'stan_wapro', ...accounts.map(allegroColumnHeader), BASELINKER_HEADER, INFO_HEADER]
  const rows = wapro.map((w) => {
    const info = []
    const allegroCells = accounts.map((a) => {
      const hit = existing.allegro.get(a.id)?.get(w.sku)
      if (hit) info.push(`${accountSlug(a)}: ${viaLabel(hit.via)}`)
      return excelText(hit?.offerId ?? '')
    })
    const bl = existing.baselinker.get(w.sku)
    if (bl) info.push(`baselinker: ${viaLabel(bl.via)}`)
    return [excelText(w.sku), excelText(w.ean), w.name, w.quantity, ...allegroCells, excelText(bl?.offerId ?? ''), info.join('; ')]
  })
  return { headers, rows }
}

/** Treść instrukcji dołączanej do wzorca. */
export function templateInstructions(accounts, fileName) {
  const accLines = accounts.map(
    (a) => `  ${allegroColumnHeader(a)}  →  numer oferty na koncie Allegro „${a.label}"${a.accountLogin ? ` (login ${a.accountLogin})` : ''}`
  )
  return [
    'MAPOWANIE PRODUKTÓW WAPRO → ALLEGRO / BASELINKER',
    '================================================',
    '',
    `Plik: ${fileName}`,
    '',
    'Każdy wiersz to jeden produkt z WAPRO. Do każdego produktu wpisz numer oferty na kanale,',
    'na który ma trafiać jego stan. Mapowanie z pliku ma pierwszeństwo przed automatycznym.',
    '',
    'KOLUMNY',
    '  indeks_wapro           →  indeks produktu w WAPRO — NIE ZMIENIAJ',
    '  ean                    →  kod kreskowy z WAPRO (informacyjnie)',
    '  nazwa_wapro, stan_wapro →  informacyjnie',
    ...accLines,
    '                            numer oferty to cyfry z końca adresu oferty,',
    '                            np. allegro.pl/oferta/nazwa-produktu-12976534486 → 12976534486',
    `  ${BASELINKER_HEADER}  →  ID produktu w katalogu (magazynie) BaseLinkera — same cyfry`,
    `  ${INFO_HEADER}       →  jak produkt jest zmapowany teraz (informacyjnie, przy imporcie pomijana)`,
    '',
    'ZASADY',
    '  • Wpiszesz numer Allegro i ID BaseLinkera → mapujemy oba kanały.',
    '  • Wpiszesz tylko jedno → mapujemy tylko ten kanał (to konto).',
    '  • Pusta komórka → bez zmian (nic nie jest usuwane).',
    '  • Nowy numer w komórce ZASTĘPUJE poprzednie mapowanie tego produktu na tym koncie/kanale.',
    '  • Produkt sprzedawany na obu kontach Allegro → wpisz numer w obu kolumnach Allegro.',
    '  • Wpisy „auto: nazwa — sprawdź!" zostały dopasowane po nazwie — popraw, jeśli są błędne.',
    '',
    'EXCEL',
    '  • Przed wpisywaniem zaznacz kolumny z numerami i ustaw format komórek „Tekst",',
    '    inaczej Excel zamieni długie liczby na 1,29765E+10 i numer przepadnie.',
    '  • Zapisz jako „CSV UTF-8 (rozdzielany przecinkami)" — średnik też jest akceptowany.',
    '  • Wgraj plik w zakładce Mapowanie → „Wgraj plik mapowania".',
    '    Błędne wiersze nie przerywają importu — trafią do pliku *_bledy.csv obok wgranego pliku.',
    ''
  ].join('\r\n')
}

// --- parser CSV (separator „;" lub ",", cudzysłowy RFC 4180, BOM) ------------

export function parseCsv(text) {
  let s = String(text ?? '')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1) // BOM
  // Wykryj separator z pierwszej linii nagłówka.
  const firstLine = s.slice(0, s.search(/\r?\n/) >= 0 ? s.search(/\r?\n/) : s.length)
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','

  const rows = []
  let field = ''
  let row = []
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === sep) { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = [] }
    else if (c === '\r') { /* pomiń, \n domknie wiersz */ }
    else field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  if (rows.length === 0) return { headers: [], records: [] }

  const headers = rows[0].map((h) => h.trim().toLowerCase())
  const records = rows.slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, k) => [h, (r[k] ?? '').trim()])))
  return { headers, records }
}
