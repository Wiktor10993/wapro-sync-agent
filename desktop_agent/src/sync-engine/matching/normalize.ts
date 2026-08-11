/**
 * Normalizacja tekstu do dopasowania po nazwie (Poziom 3).
 * Bez zależności — testowalne w izolacji.
 */

/** Szum marketingowy usuwany z nazw przed porównaniem. */
const MARKETING_NOISE = [
  'hit', 'gratis', 'promocja', 'promo', 'nowosc', 'nowość', 'nowy', 'nowa', 'nowe',
  'mega', 'super', 'extra', 'ekstra', 'wyprzedaz', 'wyprzedaż', 'okazja', 'rabat',
  'bestseller', 'polecany', 'polecane', 'oryginalny', 'oryginalne', 'premium',
  'najlepszy', 'najlepsza', 'tanio', 'taniej', 'zestaw', 'komplet', 'sztuk', 'szt'
]

/** Jednostki rozpoznawane jako parametry ilościowe/wymiarowe. */
const UNIT_RE = /\b(\d+(?:[.,]\d+)?)\s?(kg|g|mg|ml|l|cm|mm|m|szt|x|pcs|w|v|ah|mah)\b/gi

/** Usuwa polskie diakrytyki (ł→l, ą→a, …). */
export function stripDiacritics(s: string): string {
  return String(s ?? '')
    .replace(/ł/gi, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/**
 * Normalizuje nazwę: bez diakrytyków, małe litery, bez interpunkcji, bez szumu
 * marketingowego, pojedyncze spacje. Parametry (2kg, 300ml) ZOSTAWIAMY sklejone,
 * bo są kluczowe do rozróżnienia wariantów.
 */
export function normalizeName(input: string): string {
  let s = stripDiacritics(input).toLowerCase()

  // Sklej liczbę z jednostką: "2 kg" -> "2kg", żeby był jednym tokenem.
  s = s.replace(UNIT_RE, (_m, num: string, unit: string) => `${num.replace(',', '.')}${unit.toLowerCase()}`)

  // Interpunkcja -> spacja.
  s = s.replace(/[^a-z0-9]+/g, ' ').trim()

  // Usuń słowa-szum (ale zostaw tokeny z cyframi/parametrami).
  const noise = new Set(MARKETING_NOISE.map((w) => stripDiacritics(w).toLowerCase()))
  s = s
    .split(' ')
    .filter((t) => t.length > 0 && !noise.has(t))
    .join(' ')
    .trim()

  return s
}

/** Zbiór tokenów (dł. ≥ 2) znormalizowanej nazwy — do podobieństwa Jaccarda. */
export function tokenSet(name: string): Set<string> {
  const norm = normalizeName(name)
  return new Set(norm.split(' ').filter((t) => t.length >= 2))
}

/**
 * Wyłuskuje parametry (liczba+jednostka oraz samodzielne liczby) — muszą się
 * zgadzać, żeby uznać dopasowanie po nazwie (inaczej „2kg" i „5kg" byłyby bliskie).
 */
export function extractParams(name: string): Set<string> {
  const s = stripDiacritics(name).toLowerCase()
  const params = new Set<string>()
  let m: RegExpExecArray | null
  const re = new RegExp(UNIT_RE.source, 'gi')
  while ((m = re.exec(s)) !== null) {
    params.add(`${m[1].replace(',', '.')}${m[2].toLowerCase()}`)
  }
  // Samodzielne liczby (np. rozmiar), których nie złapała jednostka.
  for (const num of s.replace(UNIT_RE, ' ').match(/\b\d+(?:[.,]\d+)?\b/g) ?? []) {
    params.add(num.replace(',', '.'))
  }
  return params
}

/** Odległość Levenshteina (iteracyjna, O(n·m) pamięci O(min)). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/** Jaccard na zbiorach tokenów: |A∩B| / |A∪B|. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Łączne podobieństwo nazw (0..1): średnia ważona Jaccarda tokenów i
 * znormalizowanej odległości Levenshteina całych ciągów. Jaccard łapie kolejność
 * słów, Levenshtein — literówki.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na && !nb) return 1
  if (!na || !nb) return 0

  const jac = jaccard(tokenSet(a), tokenSet(b))
  const dist = levenshtein(na, nb)
  const lev = 1 - dist / Math.max(na.length, nb.length)

  return 0.65 * jac + 0.35 * lev
}

/** Czy wszystkie parametry produktu Wapro występują w kandydacie (i odwrotnie). */
export function paramsMatch(a: string, b: string): boolean {
  const pa = extractParams(a)
  const pb = extractParams(b)
  if (pa.size === 0 && pb.size === 0) return true
  // Każdy parametr z jednej strony musi być po drugiej — inaczej to inny wariant.
  for (const p of pa) if (!pb.has(p)) return false
  for (const p of pb) if (!pa.has(p)) return false
  return true
}
