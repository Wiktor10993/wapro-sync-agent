/**
 * Batching + throttling + retry (Rate Limiting / 429).
 *
 * Przy ~16 000 produktów NIE wolno uderzać do API pojedynczo w pętli. Ten moduł:
 *  - dzieli dane na paczki (batchSize),
 *  - odstępuje między paczkami (delayMs),
 *  - ogranicza równoległość (concurrency),
 *  - ponawia z backoffem przy 429 / błędach przejściowych.
 */

export interface BatchOptions {
  batchSize: number
  /** Opóźnienie między kolejnymi paczkami (ms). */
  delayMs: number
  /** Ile paczek równolegle (domyślnie 1 = sekwencyjnie, najbezpieczniej). */
  concurrency: number
  /** Ile prób ponowienia paczki przy błędzie przejściowym. */
  retries: number
  /** Bazowy backoff (ms), rośnie wykładniczo: base * 2^n. */
  retryBaseMs: number
}

export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
  batchSize: 500,
  delayMs: 300,
  concurrency: 1,
  retries: 4,
  retryBaseMs: 1000
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Czy błąd wygląda na przejściowy (retry ma sens): 429 / 5xx / timeout / sieć. */
export function isRetryableError(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string } | undefined
  const status = e?.status
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true
  const msg = String(e?.message ?? e ?? '')
  return /429|Too Many Requests|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|rate.?limit/i.test(msg)
}

/** Wyłuskuje Retry-After (sekundy) z błędu, jeśli API je zwróciło. */
function retryAfterMs(err: unknown): number | null {
  const e = err as { retryAfter?: number; headers?: Record<string, string> } | undefined
  const ra = e?.retryAfter ?? Number(e?.headers?.['retry-after'])
  return Number.isFinite(ra) && ra! > 0 ? ra! * 1000 : null
}

/** Uruchamia `fn` z ponawianiem i wykładniczym backoffem. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Pick<BatchOptions, 'retries' | 'retryBaseMs'> = DEFAULT_BATCH_OPTIONS,
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === opts.retries || !isRetryableError(err)) break
      const wait = retryAfterMs(err) ?? opts.retryBaseMs * 2 ** attempt
      onRetry?.(attempt + 1, wait, err)
      await sleep(wait)
    }
  }
  throw lastErr
}

/** Dzieli tablicę na paczki. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size))
  return out
}

export interface BatchProgress {
  batchIndex: number
  batchCount: number
  processed: number
  total: number
}

/**
 * Przetwarza `items` paczkami z throttlingiem, równoległością i retry.
 * `handler` dostaje jedną paczkę i zwraca dowolny wynik (agregowany w tablicę).
 */
export async function processInBatches<T, R>(
  items: T[],
  handler: (batch: T[], meta: BatchProgress) => Promise<R>,
  options: Partial<BatchOptions> = {},
  onProgress?: (p: BatchProgress) => void,
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void
): Promise<R[]> {
  const opts = { ...DEFAULT_BATCH_OPTIONS, ...options }
  const batches = chunk(items, opts.batchSize)
  const results: R[] = []
  let processed = 0

  for (let i = 0; i < batches.length; i += opts.concurrency) {
    const window = batches.slice(i, i + opts.concurrency)

    const settled = await Promise.all(
      window.map((batch, k) => {
        const meta: BatchProgress = {
          batchIndex: i + k,
          batchCount: batches.length,
          processed: processed + batch.length,
          total: items.length
        }
        return withRetry(() => handler(batch, meta), opts, onRetry)
      })
    )

    for (const r of settled) results.push(r)
    processed += window.reduce((s, b) => s + b.length, 0)
    onProgress?.({ batchIndex: i, batchCount: batches.length, processed, total: items.length })

    // Throttling — nie po ostatniej paczce.
    if (i + opts.concurrency < batches.length && opts.delayMs > 0) {
      await sleep(opts.delayMs)
    }
  }

  return results
}
