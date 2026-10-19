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

import type { OfferCandidate, StockRow, SyncSummary, SyncChannel, SyncLogEntry, ReviewItem } from './types'
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
    for (const mm of options.manualOffers ?? []) {
      if (!offerIdSet.has(String(mm.offerId))) continue
      if (mm.sku) manualBySku.set(String(mm.sku), String(mm.offerId))
      if (mm.ean) manualByEan.set(String(mm.ean), String(mm.offerId))
    }

    const toPush: Array<{ offerId: string; variantId?: string; quantity: number; row: StockRow }> = []
    for (const row of afterEcho) {
      const forced =
        (row.sku && manualBySku.get(String(row.sku))) || (row.ean && manualByEan.get(String(row.ean))) || null
      if (forced) {
        toPush.push({ offerId: forced, quantity: row.quantity, row })
        continue
      }
      const m = matchProduct({ sku: row.sku, ean: row.ean, name: row.name }, index, options.matcher)
      if (m.status === 'MATCHED' && m.offerId) {
        toPush.push({ offerId: m.offerId, variantId: m.variantId, quantity: row.quantity, row })
      } else if (m.status === 'NEEDS_REVIEW') {
        needsReview++
        reviewItems.push({ sku: row.sku, ean: row.ean, name: row.name, quantity: row.quantity, reason: m.reason ?? 'Niejednoznaczne dopasowanie.', candidateOfferIds: m.candidateOfferIds ?? [] })
        log({ sku: row.sku, ean: row.ean, offerId: null, qtyBefore: null, qtyAfter: row.quantity, status: 'SKIPPED', message: `WYMAGA WERYFIKACJI: ${m.reason ?? ''}` })
      } else {
        skipped++
        log({ sku: row.sku, ean: row.ean, offerId: null, qtyBefore: null, qtyAfter: row.quantity, status: 'SKIPPED', message: `Brak dopasowania: ${m.reason ?? ''}` })
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

    return summary(channel, startedAt, checked, changed, needsReview, errors, skipped, reviewItems)
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
