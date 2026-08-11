/**
 * Wspólne typy silnika synchronizacji (WAPRO Mag ⇄ BaseLinker/Allegro).
 * Moduł niezależny od Electrona — w pełni testowalny.
 */

/** Pozycja stanu odczytana z Wapro (tabela ARTYKUL). */
export interface StockRow {
  idArtykulu: number
  sku: string // INDEKS_KATALOGOWY / INDEKS_HANDLOWY (pierwszy niepusty)
  ean: string // KOD_KRESKOWY
  name: string // NAZWA
  quantity: number // STAN - ZAREZERWOWANO (>= 0)
  warehouseId: number | null // ID_MAGAZYNU
}

/** Oferta/produkt po stronie kanału (BaseLinker/Allegro), do której dopasowujemy. */
export interface OfferCandidate {
  offerId: string // BaseLinker product_id / Allegro offer id
  variantId?: string
  sku: string
  ean: string
  name: string
}

export type MatchVia = 'ean' | 'sku' | 'name'

export type MatchStatus = 'MATCHED' | 'NEEDS_REVIEW' | 'NO_MATCH'

export interface MatchResult {
  status: MatchStatus
  offerId?: string
  variantId?: string
  via?: MatchVia
  /** 0..1 — pewność dopasowania (dla EAN/SKU = 1.0, dla nazwy = similarity). */
  confidence: number
  /** Powód, gdy NEEDS_REVIEW / NO_MATCH (do dziennika i UI). */
  reason?: string
  /** Kandydaci ofert, gdy dopasowanie jest niejednoznaczne. */
  candidateOfferIds?: string[]
}

export type SyncDirection = 'WAPRO_TO_CHANNEL' | 'CHANNEL_TO_WAPRO'
export type SyncChannel = 'baselinker' | 'allegro'
export type SyncEntryStatus = 'SUCCESS' | 'SKIPPED' | 'ERROR'

/** Pojedynczy wpis dziennika (tabela INTEG_LOG_SYNC). */
export interface SyncLogEntry {
  id?: number
  ts: string // ISO 8601
  direction: SyncDirection
  channel: SyncChannel
  sku: string
  ean: string
  offerId: string | null
  qtyBefore: number | null
  qtyAfter: number | null
  status: SyncEntryStatus
  message: string
}

/** Pozycja wymagająca ręcznej weryfikacji (niedopasowana / niejednoznaczna). */
export interface ReviewItem {
  sku: string
  ean: string
  name: string
  quantity: number
  reason: string
  candidateOfferIds: string[]
}

/** Podsumowanie cyklu synchronizacji — zasila modal w UI. */
export interface SyncSummary {
  channel: SyncChannel
  direction: SyncDirection
  startedAt: string
  finishedAt: string
  checked: number // sprawdzono produktów
  changed: number // zmieniono stany
  needsReview: number // wymaga weryfikacji
  errors: number
  skipped: number
  reviewItems: ReviewItem[]
}

/** Wynik delta-sync (tylko zmienione pozycje + nowe hashe). */
export interface DeltaResult {
  changed: StockRow[]
  hashes: Record<string, string>
  removed: string[]
}
