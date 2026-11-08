/**
 * Orchestrator cyklu synchronizacji stanów ERP → kanał.
 *
 * Spina wszystkie moduły i egzekwuje ochronę przed wąskimi gardłami:
 *   1. Delta Sync   — czyta pełny snapshot, ale przetwarza tylko zmiany.
 *   2. Loop Guard   — tłumi echa i blokuje nakładanie cykli.
 *   3. Matcher      — EAN → SKU → nazwa, z progiem pewności (NEEDS_REVIEW).
 *   4. Batching     — wysyłka paczkami z throttlingiem i retry (429).
 *   5. Audit        — każdy wynik trafia do INTEG_LOG_SYNC.
 *   6. Summary      — zwraca SyncSummary do modala w UI.
 */

import type { MatchResult, OfferCandidate, StockRow, SyncSummary, SyncChannel, SyncLogEntry, ReviewItem, SyncMatchStats } from './types'
import { computeDelta, commitHashes } from './sync/deltaSync'
import { LoopGuard } from './sync/loopGuard'
import { buildOfferIndex, matchProduct, type MatcherOptions } from './matching/productMatcher'
import { processInBatches, type BatchOptions } from './sync/batchRunner'

/** Adapter kanału (BaseLinker/Allegro) — orchestrator nie zna szczegółów API. */
export interface ChannelAdapter {
  channel: SyncChannel
  /**
   * Klucz Loop Guarda (blokada przebiegu + tłumienie echa). Domyślnie = `channel`.
   * Przy wielu kontach tego samego kanału (np. Allegro) podaj `allegro:<accountId>`,
   * żeby wysyłka na konto A nie tłumiła tej samej wartości na koncie B.
   */
  guardKey?: string
  /** Pobiera oferty/produkty kanału do zbudowania indeksu dopasowań. */
  fetchOffers(): Promise<OfferCandidate[]>
  /**
   * Wysyła paczkę stanów. Zwraca zbiór offerId, które faktycznie zaktualizowano
   * (żeby zatwierdzić hashe tylko dla nich).
   */
  pushStock(
    items: Array<{ offerId: string; variantId?: string; quantity: number }>,
    batchOptions: Partial<BatchOptions>
  ): Promise<{ updatedOfferIds: Set<string> }>
}

/**
 * Pamięć wyników dopasowania między cyklami (per kanał/konto). Pozycje bez
 * dopasowania nie zatwierdzają hasha, więc wracają w KAŻDYM cyklu — bez pamięci
 * dopasowanie po nazwie (N×M) liczyło się od nowa i blokowało aplikację.
 * Wynik jest ważny, dopóki lista ofert (`fingerprint`) się nie zmieni.
 */
export interface MatchCache {
  fingerprint?: string
  results: Map<string, MatchResult>
}

/** Co ile pozycji oddajemy wątek, żeby okno aplikacji nie zamarzało. */
const YIELD_EVERY = 100
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Odcisk listy ofert (FNV-1a) — zmiana oferty unieważnia pamięć dopasowań. */
export function offersFingerprint(offers: OfferCandidate[]): string {
  let h = 0x811c9dc5
  const feed = (str: string) => {
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  for (const o of offers) {
    feed(`${o.offerId}\u0001${o.variantId ?? ''}\u0001${o.sku}\u0001${o.ean}\u0001${o.name}\u0001${(o.codes ?? []).join(',')}\u0002`)
  }
  return `${offers.length}:${h.toString(16)}`
}

export interface OrchestratorDeps {
  loadSnapshot: () => Promise<StockRow[]>
  loadHashes: () => Promise<Record<string, string>>
  saveHashes: (hashes: Record<string, string>) => Promise<void>
  writeLog: (entries: SyncLogEntry[]) => Promise<void>
  loopGuard: LoopGuard
}

export interface OrchestratorOptions {
  matcher?: Partial<MatcherOptions>
  batch?: Partial<BatchOptions>
  /** Ile logów zebrać w pamięci przed zrzutem do bazy (bulk). */
  logFlushEvery?: number
  /**
   * Ręczne mapowania (masowy import CSV): wymuszają konkretną ofertę dla SKU/EAN,
   * zanim zadziała fuzzy. Stosujemy TYLKO gdy oferta jest w bieżącym fetchu
   * (czyli należy do tego konta) — dzięki temu ten sam plik obsługuje wiele kont.
   */
  manualOffers?: Array<{ offerId: string; sku?: string; ean?: string }>
  /**
   * Wywoływane z dopasowaniami (oferta → SKU) z przebiegu, zanim ruszy wysyłka —
   * np. żeby zapamiętać je do rozpoznawania SKU w zamówieniach.
   */
  onMatched?: (pairs: Array<{ offerId: string; sku: string; via: string }>) => void | Promise<void>
  /**
   * Pozycje z listy „Ignorowane" — pomijane przed dopasowaniem i wysyłką.
   * Hasha nie zatwierdzamy, więc po usunięciu z listy zsynchronizują się same.
   */
  isIgnored?: (row: StockRow) => boolean
  /** Pamięć dopasowań między cyklami (patrz `MatchCache`). */
  matchCache?: MatchCache
}

export async function runInventorySync(
  adapter: ChannelAdapter,
  deps: OrchestratorDeps,
  options: OrchestratorOptions = {}
): Promise<SyncSummary> {
  const channel = adapter.channel
  const guardKey = adapter.guardKey ?? channel
  const startedAt = new Date().toISOString()
  const logs: SyncLogEntry[] = []
  const reviewItems: ReviewItem[] = []
  let changed = 0
  let needsReview = 0
  let errors = 0
  let skipped = 0

  const nowIso = () => new Date().toISOString()
  const log = (e: Omit<SyncLogEntry, 'ts' | 'channel' | 'direction'>) =>
    logs.push({ ts: nowIso(), channel, direction: 'WAPRO_TO_CHANNEL', ...e })
  let flushed = false
  const flushLogs = async () => {
    if (flushed || logs.length === 0) return
    flushed = true
    await deps.writeLog(logs)
  }

  // Blokada nakładania cykli (ochrona przed pętlą / równoległymi przebiegami).
  if (!deps.loopGuard.tryAcquire(guardKey)) {
    return summary(channel, startedAt, 0, 0, 0, 0, 0, [])
  }

  try {
    // 1) Snapshot + delta — przetwarzamy tylko zmiany.
    const snapshot = await deps.loadSnapshot()
    const previousHashes = await deps.loadHashes()
    const { changed: delta, hashes } = computeDelta(snapshot, previousHashes)
    const checked = snapshot.length

    if (delta.length === 0) {
      await deps.saveHashes(hashes)
      return summary(channel, startedAt, checked, 0, 0, 0, 0, [])
    }

    // 2) Loop Guard — odrzuć echa (ta sama wartość wysłana niedawno).
    const { toSend: afterEcho, suppressed } = deps.loopGuard.filterEchoes(guardKey, delta)
    for (const r of suppressed) {
      skipped++
      log({ sku: r.sku, ean: r.ean, offerId: null, qtyBefore: null, qtyAfter: r.quantity, status: 'SKIPPED', message: 'Echo tłumione (loop guard).' })
    }

    // 3) Indeks ofert + dopasowanie (EAN → SKU → nazwa) z progiem pewności.
    const offers = await adapter.fetchOffers()
    const index = buildOfferIndex(offers)

    // Override: ręczne mapowania ograniczone do ofert obecnych w TYM fetchu
    // (czyli należących do tego konta). Wymuszają ofertę przed fuzzy-matchem.
    const offerIdSet = new Set(offers.map((o) => String(o.offerId)))
    const manualBySku = new Map<string, string>()
    const manualByEan = new Map<string, string>()
    const stats: SyncMatchStats = {
      offers: offers.length,
      manualInAccount: 0,
      manualTotal: options.manualOffers?.length ?? 0,
      viaManual: 0,
      viaEan: 0,
      viaSku: 0,
      viaName: 0,
      noMatch: 0,
      ignored: 0
    }
    for (const mm of options.manualOffers ?? []) {
      if (!offerIdSet.has(String(mm.offerId))) continue
      stats.manualInAccount++
      if (mm.sku) manualBySku.set(String(mm.sku), String(mm.offerId))
      if (mm.ean) manualByEan.set(String(mm.ean), String(mm.offerId))
    }

    const cache = options.matchCache
    if (cache) {
      const fp = offersFingerprint(offers)
      if (cache.fingerprint !== fp) {
        cache.fingerprint = fp
        cache.results.clear()
      }
    }
    const matchRow = (row: StockRow): MatchResult => {
      if (!cache) return matchProduct({ sku: row.sku, ean: row.ean, name: row.name }, index, options.matcher)
      const key = `${row.sku}\u0001${row.ean}\u0001${row.name}`
      let m = cache.results.get(key)
      if (!m) {
        m = matchProduct({ sku: row.sku, ean: row.ean, name: row.name }, index, options.matcher)
        cache.results.set(key, m)
      }
      return m
    }

    const toPush: Array<{ offerId: string; variantId?: string; quantity: number; row: StockRow; via: string }> = []
    let processed = 0
    for (const row of afterEcho) {
      if (++processed % YIELD_EVERY === 0) await yieldToEventLoop()
      if (options.isIgnored?.(row)) {
        stats.ignored = (stats.ignored ?? 0) + 1
        continue
      }
      const forced =
        (row.sku && manualBySku.get(String(row.sku))) || (row.ean && manualByEan.get(String(row.ean))) || null
      if (forced) {
        stats.viaManual++
        toPush.push({ offerId: forced, quantity: row.quantity, row, via: 'manual' })
        continue
      }
      const m = matchRow(row)
      if (m.status === 'MATCHED' && m.offerId) {
        if (m.via === 'ean') stats.viaEan++
        else if (m.via === 'sku') stats.viaSku++
        else stats.viaName++
        toPush.push({ offerId: m.offerId, variantId: m.variantId, quantity: row.quantity, row, via: m.via ?? '' })
      } else if (m.status === 'NEEDS_REVIEW') {
        needsReview++
        reviewItems.push({ sku: row.sku, ean: row.ean, name: row.name, quantity: row.quantity, reason: m.reason ?? 'Niejednoznaczne dopasowanie.', candidateOfferIds: m.candidateOfferIds ?? [] })
        log({ sku: row.sku, ean: row.ean, offerId: null, qtyBefore: null, qtyAfter: row.quantity, status: 'SKIPPED', message: `WYMAGA WERYFIKACJI: ${m.reason ?? ''}` })
      } else {
        skipped++
        stats.noMatch++
        log({ sku: row.sku, ean: row.ean, offerId: null, qtyBefore: null, qtyAfter: row.quantity, status: 'SKIPPED', message: `Brak dopasowania: ${m.reason ?? ''}` })
      }
    }

    if (options.onMatched && toPush.length > 0) {
      try {
        await options.onMatched(toPush.filter((p) => p.row.sku).map((p) => ({ offerId: p.offerId, sku: p.row.sku, via: p.via })))
      } catch {
        /* zapamiętanie dopasowań jest pomocnicze — nie blokuje wysyłki */
      }
    }

    // 4) Wysyłka paczkami z throttlingiem/retry; zatwierdzamy hashe tylko dla OK.
    const updatedSkus = new Set<string>()

    await processInBatches(
      toPush,
      async (batch) => {
        try {
          const { updatedOfferIds } = await adapter.pushStock(
            batch.map((b) => ({ offerId: b.offerId, variantId: b.variantId, quantity: b.quantity })),
            options.batch ?? {}
          )
          for (const b of batch) {
            const ok = updatedOfferIds.has(String(b.offerId))
            if (ok) {
              changed++
              updatedSkus.add(b.row.sku)
              deps.loopGuard.recordPush(guardKey, b.row.sku, b.quantity)
              log({ sku: b.row.sku, ean: b.row.ean, offerId: b.offerId, qtyBefore: null, qtyAfter: b.quantity, status: 'SUCCESS', message: `Zaktualizowano ofertę ${b.offerId}.` })
            } else {
              errors++
              log({ sku: b.row.sku, ean: b.row.ean, offerId: b.offerId, qtyBefore: null, qtyAfter: b.quantity, status: 'ERROR', message: `Kanał nie potwierdził oferty ${b.offerId}.` })
            }
          }
        } catch (err) {
          // Cała paczka padła — logujemy błąd per pozycja, hashy NIE zatwierdzamy.
          const msg = (err as Error)?.message ?? String(err)
          for (const b of batch) {
            errors++
            log({ sku: b.row.sku, ean: b.row.ean, offerId: b.offerId, qtyBefore: null, qtyAfter: b.quantity, status: 'ERROR', message: `Błąd wysyłki paczki: ${msg}` })
          }
        }
      },
      options.batch ?? {}
    )

    // 5) Zatwierdź hashe tylko dla faktycznie wysłanych — reszta ponowi się w kolejnym cyklu.
    const committed = commitHashes(previousHashes, hashes, updatedSkus)
    await deps.saveHashes(committed)

    // 6) Zrzut dziennika (raz).
    await flushLogs()

    return { ...summary(channel, startedAt, checked, changed, needsReview, errors, skipped, reviewItems), stats }
  } finally {
    deps.loopGuard.release(guardKey)
    // Gdyby przebieg padł wyjątkiem przed zrzutem — dopisujemy logi best-effort.
    try {
      await flushLogs()
    } catch {
      /* nie maskujemy oryginalnego błędu */
    }
  }
}

function summary(
  channel: SyncChannel,
  startedAt: string,
  checked: number,
  changed: number,
  needsReview: number,
  errors: number,
  skipped: number,
  reviewItems: ReviewItem[]
): SyncSummary {
  return {
    channel,
    direction: 'WAPRO_TO_CHANNEL',
    startedAt,
    finishedAt: new Date().toISOString(),
    checked,
    changed,
    needsReview,
    errors,
    skipped,
    reviewItems
  }
}
