/**
 * rateLimiter.ts — proaktywny limiter zapytań (token-bucket, okno przesuwne).
 *
 * BaseLinker ma TWARDY limit 100 zapytań / minutę na token API. Po przekroczeniu
 * zwraca błąd / przestaje odpowiadać. `batchRunner.withRetry` łata to REAKTYWNIE
 * (ponawia po 429), ale lepiej w ogóle nie dobijać do limitu — dlatego każde
 * wywołanie API najpierw bierze „slot" z limitera i, jeśli okno jest pełne, CZEKA.
 *
 * Ustawiamy 90/min jako bezpieczny margines (zegar serwera, równoległe procesy,
 * retry). Limiter jest per-klucz (per token), więc wiele kont nie współdzieli puli.
 *
 * Użycie:
 *   const limiter = getLimiter(`baselinker:${token}`, { max: 90, windowMs: 60_000 })
 *   await limiter.take()          // czeka na wolny slot
 *   ... wykonaj request ...
 * albo:
 *   await limiter.run(() => fetch(...))
 */

export interface LimiterOptions {
  /** ile zapytań mieści się w oknie */ max: number
  /** długość okna w ms */ windowMs: number
}

export class RateLimiter {
  private readonly max: number
  private readonly windowMs: number
  /** znaczniki czasu wykonanych zapytań (rosnąco) w bieżącym oknie */
  private hits: number[] = []
  /** kolejka oczekujących (FIFO) — zachowuje kolejność zgłoszeń */
  private queue: Array<() => void> = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: LimiterOptions) {
    this.max = Math.max(1, opts.max)
    this.windowMs = Math.max(1, opts.windowMs)
  }

  /** Czeka na wolny slot i rejestruje trafienie. */
  take(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
      this.pump()
    })
  }

  /** Bierze slot i wykonuje funkcję. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.take()
    return fn()
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs
    let i = 0
    while (i < this.hits.length && this.hits[i] <= cutoff) i++
    if (i > 0) this.hits.splice(0, i)
  }

  private pump(): void {
    this.prune()
    while (this.queue.length > 0 && this.hits.length < this.max) {
      this.hits.push(Date.now())
      const resolve = this.queue.shift()!
      resolve()
    }
    if (this.queue.length > 0 && !this.timer) {
      const wait = Math.max(5, this.hits[0] + this.windowMs - Date.now())
      this.timer = setTimeout(() => {
        this.timer = null
        this.pump()
      }, wait)
    }
  }

  /** Diagnostyka: ile trafień w bieżącym oknie. */
  get windowUsage(): number {
    this.prune()
    return this.hits.length
  }

  /** Diagnostyka: ile zgłoszeń czeka w kolejce. */
  get queued(): number {
    return this.queue.length
  }
}

const registry = new Map<string, RateLimiter>()

/** Zwraca (lub tworzy) limiter dla klucza — jeden per token/kanał. */
export function getLimiter(key: string, opts: LimiterOptions): RateLimiter {
  let l = registry.get(key)
  if (!l) {
    l = new RateLimiter(opts)
    registry.set(key, l)
  }
  return l
}
