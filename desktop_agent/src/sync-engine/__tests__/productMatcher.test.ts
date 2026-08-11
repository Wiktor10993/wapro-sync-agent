/**
 * Testy silnika dopasowań. Uruchom pod Vitest:  npx vitest run src/sync-engine
 * (Vitest/esbuild obsługuje TS + importy bez rozszerzeń tak jak build aplikacji.)
 */
import { describe, it, expect } from 'vitest'
import { buildOfferIndex, matchProduct } from '../matching/productMatcher'
import { normalizeName, extractParams, paramsMatch, nameSimilarity } from '../matching/normalize'
import type { OfferCandidate } from '../types'

const offers: OfferCandidate[] = [
  { offerId: 'A', sku: 'ART-1', ean: '5904619771106', name: 'Zanęta Evolution 2kg Morwa/Ryba' },
  { offerId: 'B', sku: 'ART-2', ean: '5901234567890', name: 'Zanęta Evolution 2kg Bekon/Mięso' },
  { offerId: 'C', sku: 'ART-3', ean: '', name: 'Podbierak Delphin Omega Carp' },
  { offerId: 'D1', sku: 'DUP', ean: 'DUPEAN', name: 'Kubek' },
  { offerId: 'D2', sku: 'DUP', ean: 'DUPEAN', name: 'Kubek inny' }
]
const index = buildOfferIndex(offers)

describe('normalize', () => {
  it('usuwa szum marketingowy i polskie znaki', () => {
    expect(normalizeName('HIT! Zanęta ŚLIWKA gratis 2 kg')).toBe('zaneta sliwka 2kg')
  })
  it('wyłuskuje parametry z jednostkami', () => {
    expect([...extractParams('Zanęta 2kg wersja 3')].sort()).toEqual(['2kg', '3'])
  })
  it('paramsMatch odrzuca inny gramaż', () => {
    expect(paramsMatch('Zanęta 2kg', 'Zanęta 5kg')).toBe(false)
    expect(paramsMatch('Zanęta 2kg', 'Zaneta 2 kg')).toBe(true)
  })
})

describe('matchProduct — poziomy dopasowania', () => {
  it('Poziom 1: EAN', () => {
    const r = matchProduct({ sku: 'X', ean: '5904619771106', name: 'cokolwiek' }, index)
    expect(r).toMatchObject({ status: 'MATCHED', offerId: 'A', via: 'ean', confidence: 1 })
  })
  it('Poziom 2: SKU gdy brak EAN', () => {
    const r = matchProduct({ sku: 'ART-2', ean: '', name: 'x' }, index)
    expect(r).toMatchObject({ status: 'MATCHED', offerId: 'B', via: 'sku' })
  })
  it('Poziom 3: nazwa gdy brak EAN/SKU', () => {
    const r = matchProduct({ sku: 'NIEZNANY', ean: '', name: 'Podbierak Delphin Omega Carp' }, index)
    expect(r.status).toBe('MATCHED')
    expect(r.offerId).toBe('C')
    expect(r.via).toBe('name')
  })
  it('parametr chroni przed pomyłką gramażu (2kg vs 5kg)', () => {
    const r = matchProduct({ sku: 'NIEZNANY', ean: '', name: 'Zanęta Evolution 5kg Morwa/Ryba' }, index)
    expect(r.status).not.toBe('MATCHED')
  })
  it('niejednoznaczny EAN → NEEDS_REVIEW', () => {
    const r = matchProduct({ sku: 'X', ean: 'DUPEAN', name: 'y' }, index)
    expect(r.status).toBe('NEEDS_REVIEW')
    expect(r.candidateOfferIds).toEqual(expect.arrayContaining(['D1', 'D2']))
  })
  it('brak jakiegokolwiek dopasowania → NO_MATCH', () => {
    const r = matchProduct({ sku: 'NIC', ean: '', name: 'Zupełnie inny produkt XYZ' }, index)
    expect(r.status).toBe('NO_MATCH')
  })
  it('podobne nazwy bez wyraźnej przewagi → NEEDS_REVIEW', () => {
    // Obie zanęty 2kg są bardzo podobne — bez EAN/SKU nie zgadujemy.
    const r = matchProduct({ sku: 'NIEZNANY', ean: '', name: 'Zanęta Evolution 2kg' }, index)
    expect(['NEEDS_REVIEW', 'NO_MATCH']).toContain(r.status)
  })
})

describe('nameSimilarity', () => {
  it('identyczne = 1', () => expect(nameSimilarity('Kubek Czerwony', 'kubek czerwony')).toBeGreaterThan(0.99))
  it('różne < próg', () => expect(nameSimilarity('Kubek', 'Talerz')).toBeLessThan(0.5))
})
