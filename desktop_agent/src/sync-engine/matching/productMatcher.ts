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
import { normalizeName, nameSimilarity, paramsMatch, extractParams } from './normalize'

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
  params: Set<string>
}

export interface OfferIndex {
  bySku: Map<string, string | null> // sku -> offerId (null = niejednoznaczne)
  byEan: Map<string, string | null> // ean -> offerId (null = niejednoznaczne)
  offers: IndexedOffer[]
}

/**
 * Buduje indeks ofert. Duplikaty EAN/SKU oznaczamy jako NIEJEDNOZNACZNE (null),
 * żeby matcher nie „strzelał" w pierwszą lepszą ofertę.
 */
export function buildOfferIndex(offers: OfferCandidate[]): OfferIndex {
  const bySku = new Map<string, string | null>()
  const byEan = new Map<string, string | null>()
  const indexed: IndexedOffer[] = []

  const put = (map: Map<string, string | null>, key: string, id: string) => {
    if (!key) return
    if (!map.has(key)) map.set(key, id)
    else if (map.get(key) !== id) map.set(key, null) // kolizja → niejednoznaczne
  }

  for (const offer of offers) {
    const id = String(offer.offerId)
    put(bySku, String(offer.sku ?? '').trim(), id)
    put(byEan, String(offer.ean ?? '').trim(), id)
    indexed.push({ offer, norm: normalizeName(offer.name ?? ''), params: extractParams(offer.name ?? '') })
  }

  return { bySku, byEan, offers: indexed }
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

  // --- Poziom 3: nazwa (fuzzy) -------------------------------------------
  const name = String(input.name ?? '').trim()
  if (!name) {
    return { status: 'NO_MATCH', confidence: 0, reason: 'Brak EAN/SKU i pustej nazwy — nie ma jak dopasować.' }
  }

  let best: { id: string; score: number } | null = null
  let second = 0
  const inParams = extractParams(name)

  for (const cand of index.offers) {
    if (opts.requireParamMatch && !paramsSubsetOk(inParams, cand.params)) continue
    if (opts.requireParamMatch && !paramsMatch(name, cand.offer.name ?? '')) continue

    const score = nameSimilarity(name, cand.offer.name ?? '')
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

/** Czy parametry Wapro są podzbiorem parametrów kandydata (kandydat może mieć więcej). */
function paramsSubsetOk(inParams: Set<string>, candParams: Set<string>): boolean {
  if (inParams.size === 0) return true
  for (const p of inParams) if (!candParams.has(p)) return false
  return true
}

function collectByCode(index: OfferIndex, field: 'ean' | 'sku', code: string): string[] {
  const out: string[] = []
  for (const { offer } of index.offers) {
    const v = String((field === 'ean' ? offer.ean : offer.sku) ?? '').trim()
    if (v === code) out.push(String(offer.offerId))
  }
  return out
}

function topNameCandidates(index: OfferIndex, name: string, opts: MatcherOptions, limit: number): string[] {
  return index.offers
    .map((c) => ({ id: c.offer.offerId, score: nameSimilarity(name, c.offer.name ?? '') }))
    .filter((c) => c.score >= opts.nameThreshold - opts.nameMargin)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => c.id)
}
