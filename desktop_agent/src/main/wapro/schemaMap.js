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

/** Domyślny profil dla WF-Mag / Wapro Mag. */
export const WFMAG_DEFAULT = {
  name: 'WF-Mag / Wapro Mag (domyślny)',
  schema: 'dbo',

  artykuly: {
    table: 'ARTYKULY',
    id: 'ID_ARTYKULU',
    // Kandydaci na SKU — bierzemy pierwszy niepusty, w tej kolejności.
    skuColumns: ['INDEKS_KATALOGOWY', 'INDEKS_HANDLOWY'],
    barcode: 'PODSTAWOWY_KOD_KRESKOWY',
    name: 'NAZWA',
    // Kolumna oznaczająca artykuł archiwalny (0/1). null = brak filtra.
    archivedFlag: 'ARCHIWALNY',
    // Kolumna typu artykułu (np. usługi wykluczamy z synchronizacji). null = brak.
    typeColumn: 'TYP_ARTYKULU',
    excludedTypes: [],
  },

  stany: {
    table: 'STANY_MAGAZYNOWE',
    articleId: 'ID_ARTYKULU',
    warehouseId: 'ID_MAGAZYNU',
    quantity: 'STAN',
    // Kolumna rezerwacji — odejmowana od stanu, jeśli włączone w ustawieniach.
    reserved: 'REZERWACJA',
  },

  magazyny: {
    table: 'MAGAZYNY',
    id: 'ID_MAGAZYNU',
    symbol: 'SYMBOL',
    name: 'NAZWA',
  },

  kontrahenci: {
    table: 'KONTRAHENCI',
    id: 'ID_KONTRAHENTA',
    code: 'KOD',
    name: 'NAZWA',
    nip: 'NIP',
  },
};

export const PROFILES = {
  WFMAG_DEFAULT,
};

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
