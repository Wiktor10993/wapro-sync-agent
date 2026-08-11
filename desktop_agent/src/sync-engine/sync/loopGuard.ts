/**
 * Ochrona przed pętlą zwrotną (Sync Loop Protection).
 *
 * Scenariusz ryzyka: sprzedaż na kanale → obniża stan na kanale → agent widzi
 * różnicę i wypycha; jednocześnie pobranie zamówienia obniża stan w ERP → agent
 * znów wypycha. Bez ochrony powstaje kaskada i „szarpanie" stanów.
 *
 * Zasady:
 *  1) ERP (Wapro) jest JEDYNYM źródłem prawdy — piszemy tylko ERP → kanał.
 *  2) Idempotencja: nigdy nie wysyłamy tej samej wartości dwa razy z rzędu
 *     (hash w delta-sync + `wasRecentlyPushed`).
 *  3) Cooldown: po wypchnięciu wartości dla SKU blokujemy ponowną wysyłkę tej
 *     samej wartości przez `cooldownMs` — tłumi echo ze zdarzeń kanału.
 *  4) Globalna blokada przebiegu: dwa cykle tego samego kanału nie nakładają się.
 */

export interface LoopGuardOptions {
  /** Okno tłumienia echa dla tej samej pary (sku,wartość) — ms. */
  cooldownMs: number
  /** Maksymalny rozmiar pamięci ostatnich wysyłek (ochrona pamięci). */
  maxEntries: number
}

export const DEFAULT_LOOP_GUARD_OPTIONS: LoopGuardOptions = {
  cooldownMs: 60_000,
  maxEntries: 100_000
}

interface PushRecord {
  quantity: number
  at: number
}

export class LoopGuard {
  private readonly opts: LoopGuardOptions
  private readonly lastPush = new Map<string, PushRecord>()
  private readonly running = new Set<string>()

  constructor(options: Partial<LoopGuardOptions> = {}) {
    this.opts = { ...DEFAULT_LOOP_GUARD_OPTIONS, ...options }
  }

  /** Klucz identyfikujący pozycję w danym kanale. */
  private key(channel: string, sku: string): string {
    return `${channel}::${sku}`
  }

  /**
   * Czy tę samą wartość wysłaliśmy niedawno (echo)? Jeśli tak — pomijamy,
   * żeby zdarzenie kanału nie wywołało ponownej, zbędnej wysyłki.
   */
  wasRecentlyPushed(channel: string, sku: string, quantity: number): boolean {
    const rec = this.lastPush.get(this.key(channel, sku))
    if (!rec) return false
    return rec.quantity === quantity && Date.now() - rec.at < this.opts.cooldownMs
  }

  /** Rejestruje udaną wysyłkę (do idempotencji i cooldownu). */
  recordPush(channel: string, sku: string, quantity: number): void {
    if (this.lastPush.size >= this.opts.maxEntries) this.evictOldest()
    this.lastPush.set(this.key(channel, sku), { quantity, at: Date.now() })
  }

  /** Filtruje pozycje: odrzuca te, które byłyby echem (ta sama wartość w cooldownie). */
  filterEchoes<T extends { sku: string; quantity: number }>(channel: string, rows: T[]): { toSend: T[]; suppressed: T[] } {
    const toSend: T[] = []
    const suppressed: T[] = []
    for (const r of rows) {
      if (this.wasRecentlyPushed(channel, r.sku, r.quantity)) suppressed.push(r)
      else toSend.push(r)
    }
    return { toSend, suppressed }
  }

  /** Globalna blokada przebiegu — zapobiega nakładaniu cykli tego samego kanału. */
  tryAcquire(channel: string): boolean {
    if (this.running.has(channel)) return false
    this.running.add(channel)
    return true
  }

  release(channel: string): void {
    this.running.delete(channel)
  }

  private evictOldest(): void {
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [k, v] of this.lastPush) {
      if (v.at < oldestAt) {
        oldestAt = v.at
        oldestKey = k
      }
    }
    if (oldestKey) this.lastPush.delete(oldestKey)
  }
}
