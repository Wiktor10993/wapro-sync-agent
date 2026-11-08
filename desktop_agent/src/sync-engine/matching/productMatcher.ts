/**
 * Wielopoziomowy silnik dopasowywania produktów (Poziom 1–3 + próg pewności).
 *
 *   Poziom 1: EAN (KOD_KRESKOWY)          — pewność 1.0
 *   Poziom 2: SKU (INDEKS_KATALOGOWY/HAND) — pewność 1.0
 *   Poziom 3: nazwa (fuzzy, po parametrach)— pewność = similarity
 *
 * Bezpieczny próg (Safety Threshold): gdy do jednej pozycji pasuje >1 oferta
 * (niejednoznaczność) albo podobieństwo nazwy jest poniżej progu, NIE dopasowujemy
 * automatycznie — zwracamy NEEDS_REVIEW, chroniąc przed wysłaniem złego stanu.
 */

import type { OfferCandidate, MatchResult } from '../types'
import { normalizeName, extractParams, tokensOfNorm, similarityOfNorm, JACCARD_WEIGHT, LEVENSHTEIN_WEIGHT } from './normalize'

export interface MatcherOptions {
  /** Minimalne podobieństwo nazwy, by w ogóle rozważyć dopasowanie (0..1). */
  nameThreshold: number
  /** Minimalna przewaga najlepszego kandydata nad drugim (uniknięcie remisu). */
  nameMargin: number
  /** Czy wymagać zgodności parametrów (2kg, 300ml) przy dopasowaniu po nazwie. */
  requireParamMatch: boolean
}

export const DEFAULT_MATCHER_OPTIONS: MatcherOptions = {
  nameThreshold: 0.82,
  nameMargin: 0.08,
  requireParamMatch: true
}

interface IndexedOffer {
  offer: OfferCandidate
  norm: string
  tokens: Set<string>
  params: Set<string>
}

export interface OfferIndex {
  bySku: Map<string, string | null> // sku -> offerId (null = niejednoznaczne)
  byNormSku: Map<string, string | null> // sku bez separatorów, małe litery -> offerId
  byEan: Map<string, string | null> // ean -> offerId (null = niejednoznaczne)
  offers: IndexedOffer[]
  /** token nazwy -> indeksy ofert, które go zawierają (zawężenie dopasowania po nazwie). */
  byToken?: Map<string, number[]>
}

/**
 * Buduje indeks ofert. Duplikaty EAN/SKU oznaczamy jako NIEJEDNOZNACZNE (null),
 * żeby matcher nie „strzelał" w pierwszą lepszą ofertę.
 */
/**
 * Klucz SKU bez separatorów i wielkości liter („00-30-71-30-0125" ≡ „003071300125").
 * Krótkie klucze (< 5 znaków) pomijamy — za duże ryzyko przypadkowej zgodności.
 */
export function normalizeSku(code: string): string {
  const k = String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return k.length >= 5 ? k : ''
}

function offerCodes(offer: OfferCandidate): string[] {
  const out = new Set<string>()
  for (const c of [offer.sku, ...(offer.codes ?? [])]) {
    const v = String(c ?? '').trim()
    if (v) out.add(v)
  }
  return [...out]
}

export function buildOfferIndex(offers: OfferCandidate[]): OfferIndex {
  const bySku = new Map<string, string | null>()
  const byNormSku = new Map<string, string | null>()
  const byEan = new Map<string, string | null>()
  const indexed: IndexedOffer[] = []
  const byToken = new Map<string, number[]>()

  const put = (map: Map<string, string | null>, key: string, id: string) => {
    if (!key) return
    if (!map.has(key)) map.set(key, id)
    else if (map.get(key) !== id) map.set(key, null) // kolizja → niejednoznaczne
  }

  for (const offer of offers) {
    const id = String(offer.offerId)
    for (const code of offerCodes(offer)) {
      put(bySku, code, id)
      put(byNormSku, normalizeSku(code), id)
    }
    put(byEan, String(offer.ean ?? '').trim(), id)
    const norm = normalizeName(offer.name ?? '')
    const tokens = tokensOfNorm(norm)
    const pos = indexed.length
    for (const t of tokens) {
      const list = byToken.get(t)
      if (list) list.push(pos)
      else byToken.set(t, [pos])
    }
    indexed.push({ offer, norm, tokens, params: extractParams(offer.name ?? '') })
  }

  return { bySku, byNormSku, byEan, offers: indexed, byToken }
}

export interface MatchInput {
  sku: string
  ean: string
  name: string
}

/**
 * Dopasowuje pojedynczą pozycję Wapro do oferty w kanale.
 */
export function matchProduct(
  input: MatchInput,
  index: OfferIndex,
  options: Partial<MatcherOptions> = {}
): MatchResult {
  const opts = { ...DEFAULT_MATCHER_OPTIONS, ...options }
  const ean = String(input.ean ?? '').trim()
  const sku = String(input.sku ?? '').trim()

  // --- Poziom 1: EAN ------------------------------------------------------
  if (ean && index.byEan.has(ean)) {
    const id = index.byEan.get(ean)
    if (id) return { status: 'MATCHED', offerId: id, via: 'ean', confidence: 1 }
    return {
      status: 'NEEDS_REVIEW',
      confidence: 0,
      reason: `EAN ${ean} występuje w kilku ofertach — niejednoznaczne.`,
      candidateOfferIds: collectByCode(index, 'ean', ean)
    }
  }

  // --- Poziom 2: SKU ------------------------------------------------------
  if (sku && index.bySku.has(sku)) {
    const id = index.bySku.get(sku)
    if (id) return { status: 'MATCHED', offerId: id, via: 'sku', confidence: 1 }
    return {
      status: 'NEEDS_REVIEW',
      confidence: 0,
      reason: `SKU ${sku} występuje w kilku ofertach — niejednoznaczne.`,
      candidateOfferIds: collectByCode(index, 'sku', sku)
    }
  }

  // --- Poziom 2b: SKU bez separatorów (np. kod producenta zapisany inaczej) --
  const normSku = normalizeSku(sku)
  if (normSku && index.byNormSku?.has(normSku)) {
    const id = index.byNormSku.get(normSku)
    if (id) return { status: 'MATCHED', offerId: id, via: 'sku', confidence: 1 }
    return {
      status: 'NEEDS_REVIEW',
      confidence: 0,
      reason: `SKU ${sku} (bez separatorów) występuje w kilku ofertach — niejednoznaczne.`,
      candidateOfferIds: collectByCode(index, 'sku', sku)
    }
  }

  // --- Poziom 3: nazwa (fuzzy) -------------------------------------------
  const name = String(input.name ?? '').trim()
  if (!name) {
    return { status: 'NO_MATCH', confidence: 0, reason: 'Brak EAN/SKU i pustej nazwy — nie ma jak dopasować.' }
  }

  let best: { id: string; score: number } | null = null
  let second = 0
  const prepared = prepareName(name)
  // Poniżej tej wartości kandydat nie zmieni wyniku: nie przekroczy progu ani
  // nie zbliży się do najlepszego na mniej niż margines.
  const minScore = opts.nameThreshold - opts.nameMargin

  for (const cand of nameCandidates(index, prepared.tokens, minScore)) {
    // Parametry (2kg, 14g) muszą być identyczne po obu stronach.
    if (opts.requireParamMatch && !sameParams(prepared.params, cand.params)) continue

    const score = similarityOfNorm(prepared.norm, prepared.tokens, cand.norm, cand.tokens, minScore)
    if (!best || score > best.score) {
      second = best ? best.score : second
      best = { id: cand.offer.offerId, score }
    } else if (score > second) {
      second = score
    }
  }

  if (!best || best.score < opts.nameThreshold) {
    return {
      status: 'NO_MATCH',
      confidence: best?.score ?? 0,
      reason: `Brak dopasowania po nazwie (najlepsze ${(best?.score ?? 0).toFixed(2)} < próg ${opts.nameThreshold}).`
    }
  }

  // Bezpieczny próg: najlepszy musi wyraźnie wygrywać z drugim.
  if (best.score - second < opts.nameMargin) {
    return {
      status: 'NEEDS_REVIEW',
      confidence: best.score,
      reason: `Dwie oferty pasują podobnie (${best.score.toFixed(2)} vs ${second.toFixed(2)}) — wymaga weryfikacji.`,
      candidateOfferIds: topNameCandidates(index, name, opts, 5)
    }
  }

  return { status: 'MATCHED', offerId: best.id, via: 'name', confidence: best.score }
}

/** Nazwa pozycji Wapro przygotowana raz na całe dopasowanie. */
function prepareName(name: string): { norm: string; tokens: Set<string>; params: Set<string> } {
  const norm = normalizeName(name)
  return { norm, tokens: tokensOfNorm(norm), params: extractParams(name) }
}

/** Zbiory parametrów równe (to samo, co wcześniej podzbiór + `paramsMatch`). */
function sameParams(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const p of a) if (!b.has(p)) return false
  return true
}

/**
 * Kandydaci do porównania nazw. Oferta bez żadnego wspólnego tokenu ma Jaccard 0,
 * więc jej wynik ≤ waga Levenshteina — gdy to mniej niż `minScore`, nie wpływa na
 * decyzję i można ją pominąć. Zamiast porównywać z każdą ofertą (N×M), bierzemy
 * tylko oferty ze wspólnym tokenem z indeksu odwróconego.
 */
function nameCandidates(index: OfferIndex, tokens: Set<string>, minScore: number): IndexedOffer[] {
  if (!index.byToken || tokens.size === 0 || minScore <= LEVENSHTEIN_WEIGHT) return index.offers
  const shared = new Map<number, number>()
  for (const t of tokens) for (const pos of index.byToken.get(t) ?? []) shared.set(pos, (shared.get(pos) ?? 0) + 1)
  // Jaccard znamy już z liczby wspólnych tokenów — odrzucamy tych, którzy nawet
  // z idealnym Levenshteinem nie dojdą do `minScore`.
  const out: number[] = []
  for (const [pos, common] of shared) {
    const jac = common / (tokens.size + index.offers[pos].tokens.size - common)
    if (JACCARD_WEIGHT * jac + LEVENSHTEIN_WEIGHT >= minScore) out.push(pos)
  }
  return out.sort((a, b) => a - b).map((pos) => index.offers[pos])
}

function collectByCode(index: OfferIndex, field: 'ean' | 'sku', code: string): string[] {
  const out: string[] = []
  for (const { offer } of index.offers) {
    if (field === 'ean') {
      if (String(offer.ean ?? '').trim() === code) out.push(String(offer.offerId))
    } else {
      const norm = normalizeSku(code)
      if (offerCodes(offer).some((c) => c === code || (norm && normalizeSku(c) === norm))) out.push(String(offer.offerId))
    }
  }
  return out
}

function topNameCandidates(index: OfferIndex, name: string, opts: MatcherOptions, limit: number): string[] {
  const input = prepareName(name)
  const minScore = opts.nameThreshold - opts.nameMargin
  return nameCandidates(index, input.tokens, minScore)
    .map((c) => ({ id: c.offer.offerId, score: similarityOfNorm(input.norm, input.tokens, c.norm, c.tokens, minScore) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => c.id)
}
