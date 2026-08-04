import { randomUUID } from 'node:crypto'

/**
 * Klient Cloud Huba. Node 18+ ma wbudowany fetch i AbortSignal.timeout,
 * więc obywamy się bez axiosa.
 */

class HubError extends Error {
  constructor(message, { status = 0, code = 'hub_error', body = null } = {}) {
    super(message)
    this.name = 'HubError'
    this.status = status
    this.code = code
    this.body = body
  }
}

export { HubError }

function requireConfig(cloud) {
  if (!cloud?.baseUrl) {
    throw new HubError('Nie skonfigurowano adresu Cloud Huba (zakładka "Konto Cloud").', {
      code: 'no_base_url'
    })
  }
  if (!cloud?.apiKey) {
    throw new HubError('Brak klucza API agenta (zakładka "Konto Cloud").', { code: 'no_api_key' })
  }
}

async function call(cloud, method, path, body = null, { timeoutMs = 30000 } = {}) {
  requireConfig(cloud)

  const url = `${cloud.baseUrl.replace(/\/+$/, '')}${path}`

  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new HubError(`Przekroczono czas oczekiwania (${timeoutMs / 1000}s) na odpowiedź huba.`, {
        code: 'timeout'
      })
    }
    throw new HubError(
      `Nie można połączyć się z Cloud Hubem (${url}). Sprawdź adres i połączenie z internetem. Szczegóły: ${err.message}`,
      { code: 'network' }
    )
  }

  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { _raw: text }
  }

  if (res.status === 401) {
    throw new HubError('Hub odrzucił klucz API. Wygeneruj nowy klucz i wklej go w ustawieniach.', {
      status: 401,
      code: 'unauthorized',
      body: data
    })
  }

  // 207 = częściowe powodzenie; obsługujemy je wyżej, nie traktujemy jak błąd.
  if (res.status >= 400 && res.status !== 207) {
    const msg = data?.error?.message || `HTTP ${res.status}`
    throw new HubError(`Cloud Hub: ${msg}`, {
      status: res.status,
      code: data?.error?.code || 'http_error',
      body: data
    })
  }

  return { status: res.status, data }
}

export const hubClient = {
  async health(cloud) {
    // /api/health nie wymaga klucza, ale i tak go wysyłamy — nie szkodzi.
    const url = `${String(cloud.baseUrl || '').replace(/\/+$/, '')}/api/health`
    if (!cloud?.baseUrl) {
      throw new HubError('Nie podano adresu Cloud Huba.', { code: 'no_base_url' })
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      throw new HubError(`Hub odpowiedział HTTP ${res.status} na /api/health.`, { status: res.status })
    }
    return res.json()
  },

  /**
   * Wysyła paczkę stanów. Zwraca raport huba.
   * @param {Array<{sku:string, quantity:number}>} items
   */
  async syncInventory(cloud, items, batchId = randomUUID()) {
    const { status, data } = await call(cloud, 'POST', '/api/sync-inventory', {
      batch_id: batchId,
      items
    })
    return { partial: status === 207, report: data?.report ?? data, batchId }
  },

  async getOrders(cloud, limit = 50) {
    const { data } = await call(cloud, 'GET', `/api/get-orders?limit=${encodeURIComponent(limit)}`)
    return { orders: data?.orders ?? [], counts: data?.counts ?? {} }
  },

  async ackOrders(cloud, queueIds, success = true, error = null, waproRef = null) {
    const { data } = await call(cloud, 'POST', '/api/ack-orders', {
      queue_ids: queueIds,
      success,
      error,
      wapro_ref: waproRef
    })
    return data?.updated ?? 0
  }
}
