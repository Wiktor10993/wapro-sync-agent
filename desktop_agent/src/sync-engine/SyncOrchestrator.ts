/**
 * SyncOrchestrator — trójkierunkowa synchronizacja WAPRO ⇄ BaseLinker ⇄ Allegro
 * z lokalnym buforem SQLite (Stateful Sync).
 *
 * Scenariusze:
 *   A) Sprzedaż na BaseLinkerze → lokalny stan w dół → push do WAPRO i Allegro.
 *   B) Sprzedaż na Allegro       → lokalny stan w dół → push do WAPRO i BaseLinker.
 *   C) Skan WAPRO (dostawa/inwentaryzacja) → wykryj deltę → push TYLKO delty na kanały.
 *
 * Loop Guard: zmiana zainicjowana przez kanał, po zapisie do WAPRO, NIE jest
 * traktowana przez skaner WAPRO jako nowa zmiana (cooldown + porównanie z lokalem).
 *
 * Problemy trafiają do kolejek (Action Center): niezmapowane produkty i błędy wysyłki.
 */

import type { OfferCandidate } from './types'
import { buildOfferIndex, matchProduct, type OfferIndex, type MatcherOptions } from './matching/productMatcher'
import type { LocalDatabase, Channel, Origin, LocalProduct } from './state/localDb'

/** Oddaje kontrolę pętli zdarzeń — dzięki temu ciężka pętla nie zawiesza UI. */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Czy błąd oznacza „oferty już nie ma" (zakończona/zarchiwizowana/404). */
function isOfferGoneError(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string }
  if (e?.status === 404) return true
  if (/NOT_FOUND|OFFER_ENDED|ARCHIV|ENDED/i.test(String(e?.code ?? ''))) return true
  return /nie znaleziono oferty|offer not found|zakończ|zakoncz|zarchiwiz|archiv|ended|no such offer|not found/i.test(
    String(e?.message ?? '')
  )
}

/** Port kanału (BaseLinker/Allegro) — orchestrator nie zna szczegółów API. */
export interface ChannelPort {
  channel: Channel
  /** Ustawia stan oferty. RZUCA błąd { code?, message } przy niepowodzeniu. */
  pushQuantity(offerId: string, variantId: string | null, quantity: number): Promise<void>
  /** Lista ofert kanału (do automatycznego mapowania nowych produktów). */
  listOffers(): Promise<OfferCandidate[]>
}

/** Port WAPRO — odczyt stanów i zapis delty (dokument/rezerwacja). */
export interface WaproPort {
  readSnapshot(): Promise<Array<{ sku: string; ean: string; name: string; waproId: number | null; quantity: number }>>
  applyDelta(input: {
    sku: string
    ean: string
    name: string
    deltaQty: number
    targetQty: number
    reason: string
  }): Promise<void>
}

export interface OrchestratorOptions {
  loopGuardCooldownMs?: number
  offerCacheTtlMs?: number
  matcher?: Partial<MatcherOptions>
  log?: (level: string, message: string) => void
}

/** Zdarzenie sprzedaży z kanału. Można podać stan absolutny albo deltę zejścia. */
export interface SaleEvent {
  offerId?: string
  sku?: string
  ean?: string
  name?: string
  /** Nowy, wynikowy stan po sprzedaży (absolutnie). */
  newQuantity?: number
  /** Alternatywnie: o ile zeszło (dodatnia liczba). */
  soldQuantity?: number
}

interface OfferCache {
  index: OfferIndex
  at: number
}

export class SyncOrchestrator {
  private readonly cooldownMs: number
  private readonly cacheTtlMs: number
  private readonly log: (level: string, message: string) => void
  private readonly offerCache = new Map<Channel, OfferCache>()

  constructor(
    private readonly db: LocalDatabase,
    private readonly ports: { channels: Record<Channel, ChannelPort>; wapro: WaproPort },
    private readonly options: OrchestratorOptions = {}
  ) {
    this.cooldownMs = options.loopGuardCooldownMs ?? 120_000
    this.cacheTtlMs = options.offerCacheTtlMs ?? 5 * 60_000
    this.log = options.log ?? (() => {})
  }

  // =========================================================================
  // Scenariusz A / B — sprzedaż na kanale
  // =========================================================================

  async onBaselinkerSale(event: SaleEvent): Promise<void> {
    await this.onChannelSale('baselinker', event)
  }

  async onAllegroSale(event: SaleEvent): Promise<void> {
    await this.onChannelSale('allegro', event)
  }

  private async onChannelSale(source: Channel, event: SaleEvent): Promise<void> {
    const product = this.identifyProduct(source, event)
    if (!product) {
      // Nowy/niezmapowany towar przyszedł z kanału → do Action Center.
      this.db.enqueueUnmapped({
        source,
        channel: source,
        sku: event.sku ?? '',
        ean: event.ean ?? '',
        name: event.name ?? '',
        quantity: event.newQuantity ?? 0,
        reason: `Sprzedaż na ${source}, ale produktu nie ma w lokalnym buforze (oferta ${event.offerId ?? '?'}).`,
        candidates: event.offerId ? [event.offerId] : []
      })
      this.log('warn', `${source}: sprzedaż niezmapowanego produktu → Action Center.`)
      return
    }

    const oldQty = product.quantity
    const newQty = this.resolveNewQuantity(product, event)
    if (newQty === oldQty) return

    // 1) Lokalny bufor = źródło prawdy dla „ostatnio znanego" stanu.
    this.db.setQuantity(product.sku, newQty)
    this.db.recordApplied(product.sku, source, newQty)

    // 2) Push do WAPRO (delta) i do DRUGIEGO kanału (stan absolutny). Źródło pomijamy.
    await this.pushToWapro(product, newQty - oldQty, newQty, `Sprzedaż na ${source}`)
    const other: Channel = source === 'baselinker' ? 'allegro' : 'baselinker'
    await this.pushToChannel(other, { ...product, quantity: newQty }, newQty)
  }

  // =========================================================================
  // Scenariusz C — skan WAPRO (dostawa / inwentaryzacja / zejście fizyczne)
  // =========================================================================

  async scanWapro(): Promise<{ checked: number; changed: number; newProducts: number }> {
    const snapshot = await this.ports.wapro.readSnapshot()
    let changed = 0
    let newProducts = 0
    let processed = 0

    for (const row of snapshot) {
      // Oddaj wątek co 100 pozycji — UI pozostaje płynne przy tysiącach SKU.
      if (++processed % 100 === 0) await yieldToEventLoop()
      if (!row.sku) continue
      const local = this.db.getProductBySku(row.sku)

      // Loop Guard: ECHO = świeża delta z kanału, a WAPRO pokazuje DOKŁADNIE tę
      // wysłaną wartość. Wtedy nie wysyłamy ponownie (przerwanie pętli). Jeśli
      // WAPRO pokazuje INNĄ wartość — to prawdziwa zmiana fizyczna, obsłuż niżej.
      const applied = this.db.getApplied(row.sku)
      const isEcho =
        applied &&
        applied.origin !== 'wapro' &&
        applied.quantity === row.quantity &&
        Date.now() - applied.atMs < this.cooldownMs
      if (isEcho) {
        if (local && local.quantity !== row.quantity) this.db.setQuantity(row.sku, row.quantity)
        continue
      }

      if (!local) {
        // Nowy produkt fizycznie w WAPRO — dodaj do bufora i spróbuj zmapować kanały.
        this.db.upsertProduct({ sku: row.sku, ean: row.ean, name: row.name, waproId: row.waproId, quantity: row.quantity })
        this.db.recordApplied(row.sku, 'wapro', row.quantity)
        newProducts++
        const fresh = this.db.getProductBySku(row.sku)!
        await this.pushToChannel('baselinker', fresh, row.quantity)
        await this.pushToChannel('allegro', fresh, row.quantity)
        continue
      }

      if (row.quantity === local.quantity) continue

      // Realna zmiana fizyczna (dostawa/inwentaryzacja/zejście) → wyślij TYLKO deltę.
      this.db.upsertProduct({ sku: row.sku, ean: row.ean, name: row.name, waproId: row.waproId, quantity: row.quantity })
      this.db.recordApplied(row.sku, 'wapro', row.quantity)
      changed++
      const fresh = this.db.getProductBySku(row.sku)!
      await this.pushToChannel('baselinker', fresh, row.quantity)
      await this.pushToChannel('allegro', fresh, row.quantity)
    }

    return { checked: snapshot.length, changed, newProducts }
  }

  // =========================================================================
  // Push helpers + kolejkowanie problemów
  // =========================================================================

  private async pushToChannel(channel: Channel, product: LocalProduct, quantity: number): Promise<void> {
    const mapping = await this.resolveMappingOrQueue(channel, product)
    if (!mapping) return // trafiło do „Niezmapowane produkty"

    try {
      await this.ports.channels[channel].pushQuantity(mapping.offerId, mapping.variantId, quantity)
      this.log('info', `${channel}: ${product.sku} → ${quantity} (oferta ${mapping.offerId}).`)
    } catch (err) {
      const e = err as { code?: string; message?: string }
      // „0 na stanie (Archiwum)": towar ma 0 szt., a oferty już nie ma — to nie
      // krytyczny błąd, tylko naturalny stan. Oznaczamy osobną kategorią i pomijamy.
      const archivedZero = quantity === 0 && isOfferGoneError(err)
      this.db.enqueueError({
        channel,
        sku: product.sku,
        ean: product.ean,
        offerId: mapping.offerId,
        direction: 'WAPRO->CHANNEL',
        targetQuantity: quantity,
        errorCode: e?.code ?? (archivedZero ? 'ARCHIVED_ZERO' : 'ERROR'),
        errorMessage: e?.message ?? String(err),
        category: archivedZero ? 'archived_zero' : 'error'
      })
      if (archivedZero) {
        this.log('warn', `${channel}: ${product.sku} — oferta zarchiwizowana, stan 0 → pomijam (Archiwum).`)
      } else {
        this.log('error', `${channel}: błąd ${product.sku} — ${e?.message ?? err} → Action Center.`)
      }
    }
  }

  private async pushToWapro(product: LocalProduct, deltaQty: number, targetQty: number, reason: string): Promise<void> {
    try {
      await this.ports.wapro.applyDelta({ sku: product.sku, ean: product.ean, name: product.name, deltaQty, targetQty, reason })
      this.log('info', `WAPRO: ${product.sku} Δ${deltaQty} → ${targetQty} (${reason}).`)
    } catch (err) {
      const e = err as { code?: string; message?: string }
      this.db.enqueueError({
        channel: 'wapro',
        sku: product.sku,
        ean: product.ean,
        offerId: null,
        direction: 'CHANNEL->WAPRO',
        targetQuantity: targetQty,
        errorCode: e?.code ?? 'ERROR',
        errorMessage: e?.message ?? String(err),
        category: 'error'
      })
      this.log('error', `WAPRO: błąd zapisu ${product.sku} — ${e?.message ?? err} → Action Center.`)
    }
  }

  /** Zwraca mapowanie lub — po nieudanym auto-dopasowaniu — kolejkuje do Action Center. */
  private async resolveMappingOrQueue(channel: Channel, product: LocalProduct): Promise<{ offerId: string; variantId: string | null } | null> {
    const existing = this.db.getMapping(product.sku, channel)
    if (existing && existing.status === 'active') return { offerId: existing.offerId, variantId: existing.variantId }

    // Auto-dopasowanie (EAN → SKU → nazwa + próg).
    const index = await this.getOfferIndex(channel)
    const m = matchProduct({ sku: product.sku, ean: product.ean, name: product.name }, index, this.options.matcher)
    if (m.status === 'MATCHED' && m.offerId) {
      this.db.upsertMapping({ sku: product.sku, channel, offerId: m.offerId, variantId: m.variantId ?? null, via: m.via, confidence: m.confidence })
      return { offerId: m.offerId, variantId: m.variantId ?? null }
    }

    // Nie mamy pewności → Kategoria I (ręczna decyzja operatora).
    this.db.enqueueUnmapped({
      source: 'wapro',
      channel,
      sku: product.sku,
      ean: product.ean,
      name: product.name,
      quantity: product.quantity,
      reason: m.reason ?? `Brak pewnego dopasowania w kanale ${channel}.`,
      candidates: m.candidateOfferIds ?? []
    })
    return null
  }

  // =========================================================================
  // Action Center — akcje operatora
  // =========================================================================

  /** Ręczne połączenie towaru z ofertą kanału (zapis na stałe). */
  async resolveMapping(input: { sku: string; channel: Channel; offerId: string; variantId?: string | null; ean?: string }): Promise<void> {
    if (input.ean) {
      const p = this.db.getProductBySku(input.sku)
      if (p) this.db.upsertProduct({ sku: p.sku, ean: input.ean, name: p.name, waproId: p.waproId, quantity: p.quantity })
    }
    this.db.upsertMapping({ sku: input.sku, channel: input.channel, offerId: input.offerId, variantId: input.variantId ?? null, via: 'manual', confidence: 1 })

    // Zamknij pasujące wpisy „niezmapowane".
    for (const item of this.db.listUnmapped('open')) {
      if (item.sku === input.sku && (item.channel === input.channel || item.channel === null)) {
        this.db.setUnmappedStatus(item.id, 'resolved')
      }
    }

    // Od razu wypchnij bieżący stan, żeby oferta była aktualna.
    const product = this.db.getProductBySku(input.sku)
    if (product) await this.pushToChannel(input.channel, product, product.quantity)
    this.log('success', `Zmapowano ręcznie ${input.sku} ↔ ${input.channel}:${input.offerId}.`)
  }

  ignoreUnmapped(id: number): void {
    this.db.setUnmappedStatus(id, 'ignored')
  }

  /** Ponów wysyłkę delty z kolejki błędów. */
  async retryError(id: number): Promise<{ ok: boolean; message: string }> {
    const err = this.db.getError(id)
    if (!err || err.status !== 'open') return { ok: false, message: 'Wpis nie istnieje lub został już zamknięty.' }
    const product = this.db.getProductBySku(err.sku)
    if (!product) return { ok: false, message: `Brak produktu ${err.sku} w buforze.` }

    try {
      if (err.channel === 'wapro') {
        await this.ports.wapro.applyDelta({ sku: product.sku, ean: product.ean, name: product.name, deltaQty: 0, targetQty: product.quantity, reason: 'Retry z Action Center' })
      } else {
        const mapping = this.db.getMapping(product.sku, err.channel)
        if (!mapping) return { ok: false, message: `Brak mapowania ${product.sku} → ${err.channel}. Zmapuj ręcznie.` }
        await this.ports.channels[err.channel].pushQuantity(mapping.offerId, mapping.variantId, product.quantity)
      }
      this.db.setErrorStatus(id, 'resolved')
      this.log('success', `Retry OK: ${err.sku} (${err.channel}).`)
      return { ok: true, message: 'Ponowiono i zsynchronizowano.' }
    } catch (e) {
      this.db.bumpErrorAttempt(id)
      const msg = (e as Error)?.message ?? String(e)
      this.log('error', `Retry nieudany: ${err.sku} — ${msg}.`)
      return { ok: false, message: msg }
    }
  }

  ignoreError(id: number): void {
    this.db.setErrorStatus(id, 'ignored')
  }

  // Dane dla UI:
  listUnmapped() {
    return this.db.listUnmapped('open')
  }
  listErrors() {
    return this.db.listErrors('open')
  }

  // =========================================================================
  // Wewnętrzne
  // =========================================================================

  private identifyProduct(source: Channel, event: SaleEvent): LocalProduct | null {
    if (event.offerId) {
      const byOffer = this.db.getProductByOffer(source, event.offerId)
      if (byOffer) return byOffer
    }
    if (event.sku) return this.db.getProductBySku(event.sku)
    return null
  }

  private resolveNewQuantity(product: LocalProduct, event: SaleEvent): number {
    if (typeof event.newQuantity === 'number') return Math.max(0, Math.trunc(event.newQuantity))
    if (typeof event.soldQuantity === 'number') return Math.max(0, product.quantity - Math.trunc(event.soldQuantity))
    return product.quantity
  }

  private async getOfferIndex(channel: Channel): Promise<OfferIndex> {
    const cached = this.offerCache.get(channel)
    if (cached && Date.now() - cached.at < this.cacheTtlMs) return cached.index
    const offers = await this.ports.channels[channel].listOffers()
    const index = buildOfferIndex(offers)
    this.offerCache.set(channel, { index, at: Date.now() })
    return index
  }

  invalidateOfferCache(channel?: Channel): void {
    if (channel) this.offerCache.delete(channel)
    else this.offerCache.clear()
  }
}
