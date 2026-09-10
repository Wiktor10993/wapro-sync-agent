/**
 * Klient API BaseLinkera (TypeScript) z poprawką ERROR_STORAGE_ID.
 *
 * PUNKT 4: identyfikatory katalogu i magazynu bierzemy WPROST z konfiguracji jako
 * czyste wartości — bez sztywnego doklejania prefiksu „bl_". `inventory_id` idzie
 * jako liczba, a klucz magazynu jako dokładnie ta wartość, którą wskazał operator
 * (numeryczna albo pełny klucz typu „bl_1"). Dzięki temu, gdy konfiguracja ma
 * poprawny magazyn, nie ma już „nie znaleziono magazynu".
 *
 * Wszystkie wywołania przechodzą przez batching + retry (429) z batchRunner.
 */

import { withRetry, DEFAULT_BATCH_OPTIONS, type BatchOptions } from '../sync/batchRunner'
import { getLimiter } from '../util/rateLimiter'

const ENDPOINT = 'https://api.baselinker.com/connector.php'
const TIMEOUT_MS = 30_000

/** Max produktów na jedno wywołanie updateInventoryProductsStock. */
const BL_MAX_PRODUCTS_PER_CALL = 1000

/**
 * Limit API BaseLinkera: 100 req/min na token. Trzymamy 90/min jako margines,
 * żeby proaktywnie NIE dobijać do limitu (retry w batchRunner to tylko siatka).
 */
const BL_RATE_MAX = 90
const BL_RATE_WINDOW_MS = 60_000

export interface BaselinkerConfig {
  token: string
  /** ID katalogu — czysta liczba z konfiguracji. */
  inventoryId: number
  /**
   * Klucz magazynu używany w mapie stanów. Bierzemy DOKŁADNIE to, co w konfiguracji
   * (np. „bl_1" lub numeryczne „0"). NIE doklejamy prefiksu w kodzie.
   */
  warehouseId: string
}

export interface StockUpdateItem {
  productId: string
  variantId?: string
  quantity: number
}

export interface BaselinkerError extends Error {
  status?: number
  code?: string
}

function blError(message: string, code?: string, status?: number): BaselinkerError {
  const e = new Error(message) as BaselinkerError
  e.code = code
  e.status = status
  return e
}

export class BaselinkerClient {
  constructor(private readonly config: BaselinkerConfig) {}

  /** Limiter współdzielony przez wszystkie instancje z tym samym tokenem. */
  private get limiter() {
    return getLimiter(`baselinker:${this.config.token}`, { max: BL_RATE_MAX, windowMs: BL_RATE_WINDOW_MS })
  }

  /** Surowe wywołanie metody API. Odpowiedź ZAWSZE ma HTTP 200 — o błędzie decyduje `status`. */
  async call<T = any>(method: string, parameters: Record<string, unknown> = {}): Promise<T> {
    // Proaktywny throttling: czekamy na wolny slot w oknie 90/min ZANIM wyślemy.
    await this.limiter.take()
    let res: Response
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'X-BLToken': this.config.token,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (err) {
      const e = err as Error
      throw blError(`Brak połączenia z BaseLinker: ${e.message}`, 'network')
    }

    if (res.status !== 200) throw blError(`BaseLinker HTTP ${res.status} (${method}).`, 'http_error', res.status)

    const data = (await res.json()) as { status?: string; error_code?: string; error_message?: string } & T
    if (data?.status !== 'SUCCESS') {
      const code = data?.error_code ?? 'UNKNOWN'
      // ERROR_STORAGE_ID / ERROR_INVENTORY_* — podpowiadamy, że to kwestia konfiguracji ID.
      const hint =
        code === 'ERROR_STORAGE_ID'
          ? ' Sprawdź ID magazynu/katalogu w konfiguracji (czyste ID, bez doklejania prefiksu).'
          : ''
      const e = blError(`${data?.error_message ?? 'Błąd BaseLinker'} (${code}).${hint}`, code)
      // 429 mapujemy na status, żeby batchRunner mógł ponowić.
      if (code === 'ERROR_RATE_LIMIT') e.status = 429
      throw e
    }
    return data
  }

  /** Lista katalogów — do walidacji `inventory_id`. */
  async getInventories(): Promise<Array<{ inventory_id: number; name: string }>> {
    const data = await withRetry(() => this.call<{ inventories: Record<string, any> }>('getInventories'))
    return Object.entries(data.inventories ?? {}).map(([id, inv]) => ({
      inventory_id: Number(inv?.inventory_id ?? id),
      name: String(inv?.name ?? id)
    }))
  }

  /** Lista magazynów katalogu — do walidacji klucza magazynu (bez zgadywania „bl_"). */
  async getInventoryWarehouses(): Promise<Array<{ warehouse_id: number; warehouse_type: string; name: string }>> {
    const data = await withRetry(() => this.call<{ warehouses: any[] }>('getInventoryWarehouses'))
    return (data.warehouses ?? []).map((w) => ({
      warehouse_id: Number(w?.warehouse_id),
      warehouse_type: String(w?.warehouse_type ?? ''),
      name: String(w?.name ?? '')
    }))
  }

  /** Strona listy produktów katalogu — do budowy indeksu ofert (SKU/EAN/nazwa). */
  async getInventoryProductsList(page = 1): Promise<Record<string, any>> {
    const data = await withRetry(() =>
      this.call<{ products: Record<string, any> }>('getInventoryProductsList', {
        inventory_id: this.config.inventoryId,
        page: Math.max(1, page)
      })
    )
    return data.products ?? {}
  }

  /**
   * Aktualizacja stanów. `products` to OBIEKT kluczowany po product_id, a wartością
   * jest mapa { <warehouseId>: quantity }. Klucz magazynu = config.warehouseId
   * (czysta wartość z konfiguracji, bez prefiksu).
   *
   * @returns liczba wysłanych pozycji.
   */
  async updateInventoryProductsStock(items: StockUpdateItem[], batchOptions: Partial<BatchOptions> = {}): Promise<number> {
    if (!items.length) return 0

    const inventoryId = Number(this.config.inventoryId)
    if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
      throw blError('Nieprawidłowe inventory_id w konfiguracji (oczekiwano liczby).', 'ERROR_INVENTORY_ID')
    }
    const warehouseKey = String(this.config.warehouseId ?? '').trim()
    if (!warehouseKey) {
      throw blError('Brak klucza magazynu w konfiguracji.', 'ERROR_STORAGE_ID')
    }

    const opts = { ...DEFAULT_BATCH_OPTIONS, batchSize: BL_MAX_PRODUCTS_PER_CALL, ...batchOptions }
    let sent = 0

    // Ręczne paczkowanie po limicie API (1000), z retry na 429.
    for (let i = 0; i < items.length; i += opts.batchSize) {
      const slice = items.slice(i, i + opts.batchSize)
      const products: Record<string, Record<string, number>> = {}
      for (const it of slice) {
        const key = it.variantId && it.variantId !== '0' ? String(it.variantId) : String(it.productId)
        if (!key || key === '0') continue
        products[key] = { [warehouseKey]: Math.max(0, Math.trunc(Number(it.quantity) || 0)) }
      }
      const count = Object.keys(products).length
      if (count === 0) continue

      await withRetry(() => this.call('updateInventoryProductsStock', { inventory_id: inventoryId, products }), opts)
      sent += count
      if (i + opts.batchSize < items.length && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs))
      }
    }

    return sent
  }
}
