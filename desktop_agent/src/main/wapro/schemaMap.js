/**
 * MAPA SCHEMATU WAPRO MAG / WF-MAG
 * ================================
 *
 * WAŻNE — przeczytaj przed wdrożeniem u klienta.
 *
 * Wapro Mag występuje w wielu wersjach (WF-Mag 7.x, Wapro Mag 8.x+), a nazwy
 * kolumn potrafią się różnić między wydaniami i konfiguracjami. Poniższy profil
 * `WFMAG_DEFAULT` odzwierciedla typowy układ, ale NIE jest gwarantowany dla
 * każdej instalacji.
 *
 * Dlatego zapytania NIE są zaszyte w kodzie — budowane są z tej mapy, a przed
 * pierwszym uruchomieniem należy odpalić introspekcję (`introspect.js`), która
 * sprawdza na żywej bazie, czy tabele i kolumny faktycznie istnieją, i podpowiada
 * najbliższe dopasowania. Rozbieżności koryguje się w GUI (zakładka "Ustawienia
 * Bazy" → "Mapowanie schematu"), bez dotykania kodu.
 *
 * Wszystkie identyfikatory przechodzą przez quoteIdent() i są walidowane
 * regexem — mapa pochodzi z konfiguracji, więc traktujemy ją jak dane wejściowe.
 */

/**
 * Domyślny profil dla realnego WAPRO Mag / WF-Mag (potwierdzony ze schematu
 * fizycznego bazy). WAŻNE: w realnym WFMag stan magazynowy jest trzymany
 * BEZPOŚREDNIO w tabeli `ARTYKUL` (kolumny STAN, ZAREZERWOWANO, ID_MAGAZYNU) —
 * dlatego sekcje `artykuly` i `stany` wskazują TĘ SAMĄ tabelę. Gdy obie sekcje
 * wskazują jedną tabelę, zapytanie budujemy bez JOIN-a (tryb jednotabelowy).
 */
export const WFMAG_DEFAULT = {
  name: 'WAPRO Mag / WF-Mag (realny schemat)',
  schema: 'dbo',

  artykuly: {
    table: 'ARTYKUL',
    id: 'ID_ARTYKULU',
    // Kandydaci na SKU — bierzemy pierwszy niepusty, w tej kolejności.
    skuColumns: ['INDEKS_KATALOGOWY', 'INDEKS_HANDLOWY'],
    barcode: 'KOD_KRESKOWY',
    name: 'NAZWA',
    // W WFMag artykuł „wyłączony" oznacza kolumna ZABLOKOWANY (0/1).
    archivedFlag: 'ZABLOKOWANY',
    typeColumn: null,
    excludedTypes: [],
  },

  // Ta sama tabela co artykuły — stan i rezerwacja są kolumnami ARTYKUL.
  stany: {
    table: 'ARTYKUL',
    articleId: 'ID_ARTYKULU',
    warehouseId: 'ID_MAGAZYNU',
    quantity: 'STAN',
    // Rezerwacja w WFMag to ZAREZERWOWANO (nie „REZERWACJA").
    reserved: 'ZAREZERWOWANO',
  },

  magazyny: {
    table: 'MAGAZYN',
    id: 'ID_MAGAZYNU',
    symbol: 'SYMBOL',
    name: 'NAZWA',
  },

  kontrahenci: {
    table: 'KONTRAHENT',
    id: 'ID_KONTRAHENTA',
    code: 'KOD',
    name: 'NAZWA',
    nip: 'NIP',
  },
};

export const PROFILES = {
  WFMAG_DEFAULT,
};

// ---------------------------------------------------------------------------
// Adaptacyjne rozwiązywanie kolumn stanów (różne wersje Wapro / WF-Mag)
// ---------------------------------------------------------------------------

/**
 * Kandydaci nazw kolumn per rola. Kolejność = priorytet. Do listy zawsze
 * doklejamy najpierw nazwę z mapy schematu (jeśli podana), potem typowe
 * warianty spotykane w różnych wydaniach Wapro Mag / WF-Mag.
 *
 * Dzięki temu, gdy u klienta brakuje np. `REZERWACJA`, zapytanie samo się do
 * tego dostosuje (pominie odejmowanie rezerwacji) zamiast wywalać się na
 * „Invalid column name". Kolumny WYMAGANE, których nie ma, zgłaszamy jako błąd
 * konfiguracji — z czytelnym komunikatem, nie surowym SQL-em.
 */
export const STOCK_COLUMN_CANDIDATES = {
  // ARTYKUŁY (realny WFMag: tabela ARTYKUL)
  artId: ['ID_ARTYKULU', 'ID_TOWARU', 'ID'],
  name: ['NAZWA', 'NAZWA_TOWARU', 'NAZWA_PELNA', 'OPIS'],
  // WFMag: podstawowy EAN to ARTYKUL.KOD_KRESKOWY.
  barcode: ['KOD_KRESKOWY', 'PODSTAWOWY_KOD_KRESKOWY', 'KODKRESKOWY', 'EAN', 'KOD_EAN', 'KOD_PRODUCENTA'],
  // WFMag: artykuł wyłączony = ZABLOKOWANY.
  archived: ['ZABLOKOWANY', 'ARCHIWALNY', 'ARCHIWUM', 'CZY_ARCHIWALNY'],
  sku: ['INDEKS_KATALOGOWY', 'INDEKS_HANDLOWY', 'INDEKS', 'SYMBOL', 'KOD', 'KOD_TOWARU'],
  // STANY (w WFMag te kolumny są w tej samej tabeli ARTYKUL)
  stanArticleId: ['ID_ARTYKULU', 'ID_TOWARU'],
  warehouseId: ['ID_MAGAZYNU', 'ID_MAG', 'MAGAZYN'],
  quantity: ['STAN', 'ILOSC', 'STAN_MAGAZYNOWY', 'STAN_HANDLOWY', 'ILOSC_DOSTEPNA'],
  // WFMag: rezerwacja = ZAREZERWOWANO.
  reserved: ['ZAREZERWOWANO', 'REZERWACJA', 'REZERWACJE', 'STAN_REZERWACJI', 'ILOSC_REZ', 'ILOSC_ZAREZERWOWANA'],
};

/** Normalizuje wejście do Set<UPPERCASE>. Akceptuje Set, tablicę lub iterowalne. */
function toUpperSet(columns) {
  const out = new Set();
  for (const c of columns || []) out.add(String(c).toUpperCase());
  return out;
}

/** Pierwsza istniejąca kolumna z listy kandydatów (case-insensitive) albo null. */
function firstExisting(upperSet, candidates = []) {
  for (const c of candidates) {
    if (c && upperSet.has(String(c).toUpperCase())) return c;
  }
  return null;
}

/** Wszystkie istniejące kolumny z listy (z zachowaniem kolejności, bez duplikatów). */
function allExisting(upperSet, candidates = []) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c) continue;
    const up = String(c).toUpperCase();
    if (upperSet.has(up) && !seen.has(up)) {
      seen.add(up);
      out.push(c);
    }
  }
  return out;
}

/**
 * Na podstawie REALNYCH kolumn tabel `artykuly` i `stany` (z INFORMATION_SCHEMA)
 * oraz mapy schematu ustala, których kolumn faktycznie użyć.
 *
 * @param {object} map          scalona mapa (mergeProfile)
 * @param {Iterable<string>} artColumns   nazwy kolumn tabeli artykułów
 * @param {Iterable<string>} stanyColumns nazwy kolumn tabeli stanów
 * @returns {{
 *   artId:string|null, name:string|null, barcode:string|null, archived:string|null,
 *   skuColumns:string[], stanArticleId:string|null, warehouseId:string|null,
 *   quantity:string|null, reserved:string|null, missingRequired:string[], droppedOptional:string[]
 * }}
 */
export function resolveStockColumns(map, artColumns, stanyColumns) {
  const A = toUpperSet(artColumns);
  const S = toUpperSet(stanyColumns);
  const C = STOCK_COLUMN_CANDIDATES;

  // Do każdej roli: najpierw nazwa z mapy, potem domyślni kandydaci.
  const withMapped = (mapped, defaults) => [
    ...(Array.isArray(mapped) ? mapped : [mapped]).filter(Boolean),
    ...defaults,
  ];

  const artId = firstExisting(A, withMapped(map.artykuly.id, C.artId));
  const name = firstExisting(A, withMapped(map.artykuly.name, C.name));
  const barcode = firstExisting(A, withMapped(map.artykuly.barcode, C.barcode));
  const archived = firstExisting(A, withMapped(map.artykuly.archivedFlag, C.archived));
  const skuColumns = allExisting(A, withMapped(map.artykuly.skuColumns, C.sku));

  const stanArticleId = firstExisting(S, withMapped(map.stany.articleId, C.stanArticleId));
  const warehouseId = firstExisting(S, withMapped(map.stany.warehouseId, C.warehouseId));
  const quantity = firstExisting(S, withMapped(map.stany.quantity, C.quantity));
  const reserved = firstExisting(S, withMapped(map.stany.reserved, C.reserved));

  const missingRequired = [];
  if (!artId) missingRequired.push('ID artykułu (ARTYKULY)');
  if (!name) missingRequired.push('nazwa artykułu (ARTYKULY)');
  if (skuColumns.length === 0) missingRequired.push('kolumna SKU/indeks (ARTYKULY)');
  if (!stanArticleId) missingRequired.push('ID artykułu w stanach (STANY)');
  if (!warehouseId) missingRequired.push('ID magazynu (STANY)');
  if (!quantity) missingRequired.push('kolumna stanu/ilości (STANY)');

  // Opcjonalne, których nie znaleziono — do logu (zmienia zachowanie, ale nie blokuje).
  const droppedOptional = [];
  if (!barcode) droppedOptional.push('kod kreskowy/EAN');
  if (!archived) droppedOptional.push('flaga archiwum');
  if (!reserved) droppedOptional.push('rezerwacja');

  return {
    artId, name, barcode, archived, skuColumns,
    stanArticleId, warehouseId, quantity, reserved,
    missingRequired, droppedOptional,
  };
}

/** Regex bezpiecznego identyfikatora SQL Server. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$#]{0,127}$/;

/**
 * Waliduje i cytuje identyfikator. Rzuca, jeśli nazwa nie wygląda na
 * identyfikator — to nasza ostatnia linia obrony przed wstrzyknięciem
 * przez zmanipulowaną konfigurację.
 */
export function quoteIdent(name, label = 'identyfikator') {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error(`Nieprawidłowy ${label} w mapie schematu: ${JSON.stringify(name)}`);
  }
  return `[${name}]`;
}

export function qualified(schema, table) {
  return `${quoteIdent(schema, 'schemat')}.${quoteIdent(table, 'tabela')}`;
}

/**
 * Zwraca wyrażenie SQL dla kolumny OPCJONALNEJ:
 *   - gdy kolumna istnieje  → bezpieczny, cytowany odnośnik `alias.[NAZWA]`,
 *   - gdy kolumny brak       → literał domyślny (np. `0`, `''`).
 *
 * Dzięki temu zapytanie nigdy nie odwołuje się do nieistniejącej kolumny,
 * a zestaw kolumn wynikowych jest ZAWSZE taki sam, niezależnie od wersji Wapro.
 *
 * @param {string|null} name        realna nazwa kolumny albo null
 * @param {object} opts
 * @param {string} [opts.alias]     alias tabeli (np. 'a' lub 's')
 * @param {string} opts.defaultSql  literał SQL użyty, gdy kolumny brak
 */
export function optionalColumnExpr(name, { alias = '', defaultSql } = {}) {
  if (!name) return defaultSql;
  const ref = quoteIdent(name, 'kolumna');
  return alias ? `${alias}.${ref}` : ref;
}

/**
 * Schemat konkretnej sekcji. Pozwala, by tabele były ROZPROSZONE po różnych
 * schematach (np. artykuły w `dbo`, stany w `wapro`) — każda sekcja może mieć
 * własne pole `schema`, a gdy go brak, dziedziczy globalny `map.schema`.
 */
export function sectionSchema(map, section) {
  const s = map?.[section]?.schema;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : map.schema;
}

/** Cytowany, w pełni kwalifikowany odnośnik do tabeli danej sekcji. */
export function sectionRef(map, section) {
  return qualified(sectionSchema(map, section), map[section].table);
}

// ---------------------------------------------------------------------------
// Dopasowywanie tabel po frazach kluczowych (klient z nietypowymi nazwami)
// ---------------------------------------------------------------------------

/**
 * Reguły dopasowania nazwy tabeli do roli. Dla każdej roli:
 *   include   — frazy, których obecność świadczy o roli (z wagą),
 *   boost     — frazy podbijające pewność (nie wystarczą same),
 *   penalize  — frazy obniżające dopasowanie (rozróżniają role zbliżone).
 *
 * Rozróżnienie „stany" vs „magazyny": STANY_MAGAZYNOWE zawiera oba słowa —
 * dla roli `stany` słowo `magazyn` podbija wynik, a dla roli `magazyny`
 * obecność `stan` go obniża, żeby czysta tabela MAGAZYNY wygrywała.
 */
export const TABLE_ROLE_MATCHERS = {
  artykuly: {
    include: [['artykul', 5], ['towar', 5], ['produkt', 4], ['asortyment', 3], ['indeks', 2], ['kartotek', 2]],
    boost: [],
    penalize: [['stan', 2], ['magazyn', 2]],
  },
  stany: {
    include: [['stan', 5], ['remanent', 3]],
    boost: [['magazyn', 2], ['ilosc', 1]],
    penalize: [],
  },
  magazyny: {
    include: [['magazyn', 5], ['sklad', 2]],
    boost: [],
    penalize: [['stan', 4]],
  },
};

/** Normalizuje nazwę do porównań: wielkie litery, bez znaków niealfanumerycznych. */
function normalizeName(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * Ocenia, jak dobrze nazwa tabeli pasuje do roli ('artykuly'|'stany'|'magazyny').
 * Zwraca liczbę: 0 = brak dopasowania, wyższa = pewniejsze.
 *
 * @param {string} tableName
 * @param {'artykuly'|'stany'|'magazyny'} role
 * @returns {number}
 */
export function scoreTableForRole(tableName, role) {
  const rules = TABLE_ROLE_MATCHERS[role];
  if (!rules) return 0;

  const hay = normalizeName(tableName).replace(/\s+/g, '');
  const has = (needle) => hay.includes(needle.toUpperCase());

  let base = 0;
  for (const [word, weight] of rules.include) {
    if (has(word)) base += weight;
  }
  // Bez trafienia w słowo bazowe rola w ogóle nie wchodzi w grę.
  if (base === 0) return 0;

  let score = base;
  for (const [word, weight] of rules.boost || []) {
    if (has(word)) score += weight;
  }
  for (const [word, weight] of rules.penalize || []) {
    if (has(word)) score -= weight;
  }
  return Math.max(0, score);
}

/**
 * Dla listy tabel zwraca posortowane sugestie per rola.
 *
 * @param {Array<string|{name:string}>} tables
 * @returns {{artykuly:Array, stany:Array, magazyny:Array}}
 */
export function suggestTablesByRole(tables = []) {
  const items = tables.map((t) => (typeof t === 'string' ? { name: t } : t));
  const out = { artykuly: [], stany: [], magazyny: [] };

  for (const role of Object.keys(out)) {
    out[role] = items
      .map((t) => ({ ...t, score: scoreTableForRole(t.name, role) }))
      .filter((t) => t.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }
  return out;
}

/**
 * Scala profil użytkownika z domyślnym (płytkie scalanie per sekcja).
 */
export function mergeProfile(overrides = {}) {
  const base = WFMAG_DEFAULT;
  const out = { ...base };
  for (const section of ['artykuly', 'stany', 'magazyny', 'kontrahenci']) {
    out[section] = { ...base[section], ...(overrides[section] || {}) };
  }
  if (typeof overrides.schema === 'string' && overrides.schema.trim() !== '') {
    out.schema = overrides.schema.trim();
  }
  return out;
}

/**
 * Lista obiektów wymaganych do działania SyncUp — używana przez introspekcję.
 */
export function requiredObjects(map) {
  return [
    {
      section: 'artykuly',
      schema: sectionSchema(map, 'artykuly'),
      table: map.artykuly.table,
      columns: [
        map.artykuly.id,
        ...map.artykuly.skuColumns,
        map.artykuly.name,
        map.artykuly.barcode,
        map.artykuly.archivedFlag,
        map.artykuly.typeColumn,
      ].filter(Boolean),
      required: [map.artykuly.id],
    },
    {
      section: 'stany',
      schema: sectionSchema(map, 'stany'),
      table: map.stany.table,
      columns: [
        map.stany.articleId,
        map.stany.warehouseId,
        map.stany.quantity,
        map.stany.reserved,
      ].filter(Boolean),
      required: [map.stany.articleId, map.stany.warehouseId, map.stany.quantity],
    },
    {
      section: 'magazyny',
      schema: sectionSchema(map, 'magazyny'),
      table: map.magazyny.table,
      columns: [map.magazyny.id, map.magazyny.symbol, map.magazyny.name].filter(Boolean),
      required: [map.magazyny.id],
    },
  ];
}
