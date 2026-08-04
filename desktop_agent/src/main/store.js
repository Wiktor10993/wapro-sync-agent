import Store from 'electron-store'
import { safeStorage } from 'electron'

/**
 * Trwałe ustawienia agenta.
 *
 * Hasło do MSSQL i klucz API huba szyfrujemy przez `safeStorage` (Keychain na
 * macOS, DPAPI na Windows). Gdy szyfrowanie nie jest dostępne (rzadkie, np.
 * Linux bez keyringu), zapisujemy jawnie i sygnalizujemy to w GUI — użytkownik
 * ma prawo wiedzieć, że plik konfiguracyjny zawiera hasło.
 */

const schema = {
  db: {
    type: 'object',
    default: {
      host: '',
      port: 1433,
      instanceName: '',
      database: '',
      user: '',
      passwordEnc: '',
      passwordPlain: '',
      encrypt: false,
      trustServerCertificate: true
    }
  },
  cloud: {
    type: 'object',
    default: {
      baseUrl: '',
      apiKeyEnc: '',
      apiKeyPlain: ''
    }
  },
  sync: {
    type: 'object',
    default: {
      enabled: false,
      inventoryIntervalMinutes: 10,
      ordersIntervalMinutes: 5,
      warehouseIds: [],
      subtractReserved: true,
      skipArchived: true,
      aggregateWarehouses: true,
      batchSize: 500,
      ordersBatchSize: 50,
      // Tryb zapisu zamówień: 'xml' (pliki importu ECO) albo 'staging'
      // (tabela pośrednia w schemacie `integracja` bazy Wapro)
      orderMode: 'xml',
      xmlOutputFolder: '',
      // Gdy true, zamówienie z pozycją nieodnalezioną w kartotece Wapro
      // jest odrzucane zamiast zapisywane z ostrzeżeniem.
      requireAllMatched: false,
      // --- reflektor bufora (tryb 'staging') ---------------------------
      // Po zapisie do tabeli pośredniej generuj z niej pliki XML ECO
      // do folderu nasłuchu Wapro. To domyka „ostatni milimetr" integracji.
      reflectToXml: true,
      waproWatchFolder: '',
      // Eksportuj tylko zamówienia, w których wszystkie pozycje mają
      // dopasowany ID_ARTYKULU.
      reflectOnlyMatched: false,
      reflectIntervalMinutes: 5,
      // --- kanał Allegro (bezpośrednia wysyłka stanów, obok BaseLinkera) ---
      // Gdy true, harmonogram wysyła stany także wprost na Allegro.
      allegroStockEnabled: false
    }
  },
  appearance: {
    type: 'object',
    default: {
      minimizeToTray: true,
      autoStart: false,
      startMinimized: false
    }
  },
  /**
   * Bezpośrednie integracje z kanałami sprzedaży.
   *
   * UWAGA BEZPIECZEŃSTWA: trzymanie `client_secret` Allegro i tokenu
   * BaseLinkera na komputerze klienta oznacza, że każdy, kto ma dostęp do tego
   * konta systemowego, może się nimi posłużyć. Sekrety szyfrujemy przez
   * `safeStorage` (Keychain / DPAPI), ale to chroni plik konfiguracyjny —
   * nie chroni przed osobą zalogowaną na tym koncie. Gdy klient ma wielu
   * pracowników na jednym komputerze, bezpieczniej trzymać klucze w Cloud Hubie
   * i zostawić agentowi wyłącznie klucz API huba.
   */
  integrations: {
    type: 'object',
    default: {
      baselinker: {
        tokenEnc: '',
        tokenPlain: '',
        inventoryId: '',
        warehouseId: 'bl_1',
        // Wynik ostatniego testu połączenia — pokazywany w GUI.
        lastCheckAt: null,
        lastCheckOk: null,
        lastCheckMessage: ''
      },
      allegro: {
        clientId: '',
        clientSecretEnc: '',
        clientSecretPlain: '',
        // Adres powrotny musi być zarejestrowany w panelu Allegro
        // co do znaku. Dla aplikacji desktopowych używamy pętli zwrotnej.
        redirectUri: 'http://localhost:8123/callback',
        sandbox: false,
        // Tokeny uzyskane w przepływie authorization code + PKCE
        accessTokenEnc: '',
        accessTokenPlain: '',
        refreshTokenEnc: '',
        refreshTokenPlain: '',
        expiresAt: null,
        scope: '',
        authorizedAt: null,
        accountLogin: '',
        lastCheckAt: null,
        lastCheckOk: null,
        lastCheckMessage: ''
      }
    }
  },
  schemaMap: {
    type: 'object',
    default: {}
  },
  cache: {
    type: 'object',
    default: {
      stockHashes: {},
      lastSyncUpAt: null,
      lastSyncDownAt: null,
      // Osobna pamięć hashy dla kanału Allegro — dzięki temu wysyłka na
      // BaseLinker i na Allegro liczą zmiany niezależnie (włączenie jednego
      // kanału nie „zjada" zmian drugiego).
      stockHashesAllegro: {},
      lastSyncUpAllegroAt: null
    }
  }
}

export const store = new Store({ name: 'wapro-agent-config', schema })

// ---------------------------------------------------------------------------
// Szyfrowanie sekretów
// ---------------------------------------------------------------------------

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptSecret(plain) {
  if (!plain) return { enc: '', plainFallback: '' }
  if (encryptionAvailable()) {
    return { enc: safeStorage.encryptString(plain).toString('base64'), plainFallback: '' }
  }
  return { enc: '', plainFallback: plain }
}

function decryptSecret(enc, plainFallback) {
  if (enc && encryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch (err) {
      // Typowo: konfiguracja skopiowana z innego komputera/profilu.
      console.error('[store] Nie udało się odszyfrować sekretu:', err.message)
      return ''
    }
  }
  return plainFallback || ''
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export function getDbSettings({ withSecret = true } = {}) {
  const db = store.get('db')
  return {
    ...db,
    passwordEnc: undefined,
    passwordPlain: undefined,
    password: withSecret ? decryptSecret(db.passwordEnc, db.passwordPlain) : ''
  }
}

export function saveDbSettings(input) {
  const current = store.get('db')
  const next = {
    host: String(input.host ?? current.host ?? '').trim(),
    port: Number(input.port) || 1433,
    instanceName: String(input.instanceName ?? '').trim(),
    database: String(input.database ?? current.database ?? '').trim(),
    user: String(input.user ?? current.user ?? '').trim(),
    encrypt: Boolean(input.encrypt),
    trustServerCertificate: input.trustServerCertificate !== false,
    passwordEnc: current.passwordEnc,
    passwordPlain: current.passwordPlain
  }

  // Puste hasło z formularza = "nie zmieniaj" (GUI nie odsyła zapisanego hasła).
  if (typeof input.password === 'string' && input.password !== '') {
    const { enc, plainFallback } = encryptSecret(input.password)
    next.passwordEnc = enc
    next.passwordPlain = plainFallback
  }

  store.set('db', next)
  return getDbSettings({ withSecret: false })
}

export function getCloudSettings({ withSecret = true } = {}) {
  const cloud = store.get('cloud')
  return {
    baseUrl: cloud.baseUrl,
    apiKey: withSecret ? decryptSecret(cloud.apiKeyEnc, cloud.apiKeyPlain) : '',
    hasApiKey: Boolean(cloud.apiKeyEnc || cloud.apiKeyPlain)
  }
}

export function saveCloudSettings(input) {
  const current = store.get('cloud')
  const next = {
    baseUrl: String(input.baseUrl ?? current.baseUrl ?? '').replace(/\/+$/, ''),
    apiKeyEnc: current.apiKeyEnc,
    apiKeyPlain: current.apiKeyPlain
  }

  if (typeof input.apiKey === 'string' && input.apiKey !== '') {
    const { enc, plainFallback } = encryptSecret(input.apiKey)
    next.apiKeyEnc = enc
    next.apiKeyPlain = plainFallback
  }

  store.set('cloud', next)
  return getCloudSettings({ withSecret: false })
}

export function getSyncSettings() {
  return store.get('sync')
}

export function saveSyncSettings(input) {
  const current = store.get('sync')
  const next = {
    ...current,
    ...input,
    inventoryIntervalMinutes: Math.max(1, Number(input.inventoryIntervalMinutes) || current.inventoryIntervalMinutes),
    ordersIntervalMinutes: Math.max(1, Number(input.ordersIntervalMinutes) || current.ordersIntervalMinutes),
    reflectIntervalMinutes: Math.max(
      1,
      Number(input.reflectIntervalMinutes) || current.reflectIntervalMinutes || 5
    ),
    batchSize: Math.max(1, Math.min(1000, Number(input.batchSize) || current.batchSize)),
    warehouseIds: Array.isArray(input.warehouseIds)
      ? input.warehouseIds.map(Number).filter((n) => Number.isFinite(n))
      : current.warehouseIds
  }
  store.set('sync', next)
  return next
}

// ---------------------------------------------------------------------------
// Integracje: BaseLinker i Allegro
// ---------------------------------------------------------------------------

/**
 * Odczyt konfiguracji integracji.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.withSecrets] true → zwraca odszyfrowane sekrety
 *        (tylko do użytku w procesie głównym; NIGDY nie wysyłaj do renderera)
 */
export function getIntegrations({ withSecrets = false } = {}) {
  const raw = store.get('integrations')
  const bl = raw.baselinker ?? {}
  const al = raw.allegro ?? {}

  const blToken = decryptSecret(bl.tokenEnc, bl.tokenPlain)
  const alSecret = decryptSecret(al.clientSecretEnc, al.clientSecretPlain)
  const alAccess = decryptSecret(al.accessTokenEnc, al.accessTokenPlain)
  const alRefresh = decryptSecret(al.refreshTokenEnc, al.refreshTokenPlain)

  const expiresAt = al.expiresAt ? new Date(al.expiresAt).getTime() : 0
  const tokenExpired = expiresAt > 0 && expiresAt <= Date.now()

  return {
    baselinker: {
      inventoryId: bl.inventoryId ?? '',
      warehouseId: bl.warehouseId ?? 'bl_1',
      hasToken: Boolean(blToken),
      // Podgląd, po którym operator rozpozna klucz, nie ujawniając go.
      tokenPreview: maskSecret(blToken),
      lastCheckAt: bl.lastCheckAt ?? null,
      lastCheckOk: bl.lastCheckOk ?? null,
      lastCheckMessage: bl.lastCheckMessage ?? '',
      ...(withSecrets ? { token: blToken } : {})
    },
    allegro: {
      clientId: al.clientId ?? '',
      redirectUri: al.redirectUri ?? 'http://localhost:8123/callback',
      sandbox: Boolean(al.sandbox),
      hasClientSecret: Boolean(alSecret),
      clientSecretPreview: maskSecret(alSecret),
      authorized: Boolean(alAccess),
      hasRefreshToken: Boolean(alRefresh),
      tokenExpired,
      expiresAt: al.expiresAt ?? null,
      scope: al.scope ?? '',
      authorizedAt: al.authorizedAt ?? null,
      accountLogin: al.accountLogin ?? '',
      lastCheckAt: al.lastCheckAt ?? null,
      lastCheckOk: al.lastCheckOk ?? null,
      lastCheckMessage: al.lastCheckMessage ?? '',
      ...(withSecrets
        ? { clientSecret: alSecret, accessToken: alAccess, refreshToken: alRefresh }
        : {})
    },
    encryptionAvailable: encryptionAvailable()
  }
}

/** Wersja bez sekretów — bezpieczna do wysłania do renderera. */
export function getPublicIntegrations() {
  return getIntegrations({ withSecrets: false })
}

/**
 * Zapis ustawień BaseLinkera.
 * Puste pole `token` oznacza „nie zmieniaj" — GUI nie odsyła zapisanego klucza.
 */
export function saveBaseLinkerSettings(input = {}) {
  const current = store.get('integrations')
  const bl = { ...current.baselinker }

  if (typeof input.token === 'string' && input.token.trim() !== '') {
    const { enc, plainFallback } = encryptSecret(input.token.trim())
    bl.tokenEnc = enc
    bl.tokenPlain = plainFallback
    // Zmiana klucza unieważnia poprzedni wynik testu.
    bl.lastCheckAt = null
    bl.lastCheckOk = null
    bl.lastCheckMessage = ''
  }

  if (input.inventoryId !== undefined) {
    bl.inventoryId = String(input.inventoryId ?? '').trim()
  }
  if (input.warehouseId !== undefined) {
    bl.warehouseId = String(input.warehouseId ?? '').trim() || 'bl_1'
  }

  store.set('integrations', { ...current, baselinker: bl })
  return getPublicIntegrations()
}

/**
 * Zapis danych aplikacji Allegro.
 * Zmiana clientId albo redirectUri unieważnia istniejące tokeny — zostały
 * wydane dla innej konfiguracji i i tak przestałyby działać.
 */
export function saveAllegroSettings(input = {}) {
  console.log('[store] saveAllegroSettings — wejście:', {
    clientId: input?.clientId ?? '(undefined — pole pominięte)',
    clientSecret:
      typeof input?.clientSecret === 'string' && input.clientSecret.trim() !== ''
        ? '(podano)'
        : '(puste/undefined — bez zmian)',
    redirectUri: input?.redirectUri ?? '(undefined)',
    sandbox: input?.sandbox
  })

  const current = store.get('integrations')
  const al = { ...current.allegro }

  const prevClientId = al.clientId
  const prevRedirect = al.redirectUri

  if (input.clientId !== undefined) {
    al.clientId = String(input.clientId ?? '').trim()
  }
  if (input.redirectUri !== undefined) {
    const uri = String(input.redirectUri ?? '').trim()
    al.redirectUri = uri || 'http://localhost:8123/callback'
  }
  if (input.sandbox !== undefined) {
    al.sandbox = Boolean(input.sandbox)
  }
  if (typeof input.clientSecret === 'string' && input.clientSecret.trim() !== '') {
    const { enc, plainFallback } = encryptSecret(input.clientSecret.trim())
    al.clientSecretEnc = enc
    al.clientSecretPlain = plainFallback
  }

  const identityChanged = al.clientId !== prevClientId || al.redirectUri !== prevRedirect
  if (identityChanged) {
    al.accessTokenEnc = ''
    al.accessTokenPlain = ''
    al.refreshTokenEnc = ''
    al.refreshTokenPlain = ''
    al.expiresAt = null
    al.authorizedAt = null
    al.accountLogin = ''
    al.lastCheckAt = null
    al.lastCheckOk = null
    al.lastCheckMessage = ''
  }

  store.set('integrations', { ...current, allegro: al })

  // Odczyt kontrolny prosto z pliku konfiguracyjnego — potwierdza, że dane
  // faktycznie się utrwaliły (a nie tylko przeszły przez pamięć).
  const persisted = store.get('integrations').allegro
  console.log('[store] saveAllegroSettings — utrwalono:', {
    clientId: persisted.clientId || '(brak!)',
    hasClientSecret: Boolean(persisted.clientSecretEnc || persisted.clientSecretPlain),
    redirectUri: persisted.redirectUri
  })

  return getPublicIntegrations()
}

/**
 * Utrwalenie tokenów po udanej autoryzacji lub odświeżeniu.
 *
 * @param {object} tokens
 * @param {string} tokens.accessToken
 * @param {string} [tokens.refreshToken] brak = zachowaj dotychczasowy
 * @param {number} [tokens.expiresIn] sekundy
 * @param {string} [tokens.scope]
 */
export function saveAllegroTokens(tokens = {}) {
  const current = store.get('integrations')
  const al = { ...current.allegro }

  if (tokens.accessToken) {
    const { enc, plainFallback } = encryptSecret(tokens.accessToken)
    al.accessTokenEnc = enc
    al.accessTokenPlain = plainFallback
  }
  if (tokens.refreshToken) {
    const { enc, plainFallback } = encryptSecret(tokens.refreshToken)
    al.refreshTokenEnc = enc
    al.refreshTokenPlain = plainFallback
  }
  if (tokens.expiresIn) {
    al.expiresAt = new Date(Date.now() + Number(tokens.expiresIn) * 1000).toISOString()
  }
  if (tokens.scope !== undefined) {
    al.scope = String(tokens.scope ?? '')
  }
  if (tokens.accountLogin !== undefined) {
    al.accountLogin = String(tokens.accountLogin ?? '')
  }

  al.authorizedAt = new Date().toISOString()

  store.set('integrations', { ...current, allegro: al })
  return getPublicIntegrations()
}

/** Odłączenie konta Allegro — usuwa tokeny, zostawia dane aplikacji. */
export function clearAllegroTokens() {
  const current = store.get('integrations')
  store.set('integrations', {
    ...current,
    allegro: {
      ...current.allegro,
      accessTokenEnc: '',
      accessTokenPlain: '',
      refreshTokenEnc: '',
      refreshTokenPlain: '',
      expiresAt: null,
      authorizedAt: null,
      accountLogin: '',
      scope: '',
      lastCheckAt: null,
      lastCheckOk: null,
      lastCheckMessage: ''
    }
  })
  return getPublicIntegrations()
}

/**
 * Zapis wyniku testu połączenia.
 * @param {'baselinker'|'allegro'} channel
 */
export function setIntegrationCheck(channel, ok, message) {
  const current = store.get('integrations')
  if (!current[channel]) return getPublicIntegrations()

  store.set('integrations', {
    ...current,
    [channel]: {
      ...current[channel],
      lastCheckAt: new Date().toISOString(),
      lastCheckOk: Boolean(ok),
      lastCheckMessage: String(message ?? '').slice(0, 500)
    }
  })
  return getPublicIntegrations()
}

/** Maskowanie sekretu do podglądu: pierwsze 4 i ostatnie 4 znaki. */
function maskSecret(secret) {
  if (!secret) return ''
  const s = String(secret)
  if (s.length <= 10) return '•'.repeat(s.length)
  return `${s.slice(0, 4)}${'•'.repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`
}

export function getAppearance() {
  return store.get('appearance')
}

export function saveAppearance(input) {
  const next = { ...store.get('appearance'), ...input }
  store.set('appearance', next)
  return next
}

export function getSchemaMap() {
  return store.get('schemaMap')
}

export function saveSchemaMap(map) {
  store.set('schemaMap', map && typeof map === 'object' ? map : {})
  return store.get('schemaMap')
}

export function getStockHashes() {
  return store.get('cache.stockHashes') || {}
}

export function setStockHashes(hashes) {
  store.set('cache.stockHashes', hashes)
}

/** Pamięć hashy dla kanału Allegro (niezależna od BaseLinkera). */
export function getAllegroStockHashes() {
  return store.get('cache.stockHashesAllegro') || {}
}

export function setAllegroStockHashes(hashes) {
  store.set('cache.stockHashesAllegro', hashes)
}

const SYNC_MARK_KEYS = {
  up: 'cache.lastSyncUpAt',
  down: 'cache.lastSyncDownAt',
  upAllegro: 'cache.lastSyncUpAllegroAt'
}

export function markSync(kind) {
  const key = SYNC_MARK_KEYS[kind] ?? SYNC_MARK_KEYS.down
  store.set(key, new Date().toISOString())
}

/**
 * Czyści pamięć hashy — wymusza pełną resynchronizację przy następnym SyncUp.
 * Domyślnie czyści oba kanały; można zawęzić do jednego.
 * @param {'all'|'baselinker'|'allegro'} [scope]
 */
export function resetStockCache(scope = 'all') {
  if (scope === 'all' || scope === 'baselinker') store.set('cache.stockHashes', {})
  if (scope === 'all' || scope === 'allegro') store.set('cache.stockHashesAllegro', {})
}

/** Bezpieczny zrzut ustawień do GUI — bez sekretów. */
export function getPublicSettings() {
  return {
    db: getDbSettings({ withSecret: false }),
    cloud: getCloudSettings({ withSecret: false }),
    sync: getSyncSettings(),
    appearance: getAppearance(),
    integrations: getPublicIntegrations(),
    schemaMap: getSchemaMap(),
    trackedSkuCount: Object.keys(getStockHashes()).length,
    trackedSkuCountAllegro: Object.keys(getAllegroStockHashes()).length,
    lastSyncUpAt: store.get('cache.lastSyncUpAt'),
    lastSyncDownAt: store.get('cache.lastSyncDownAt'),
    lastSyncUpAllegroAt: store.get('cache.lastSyncUpAllegroAt'),
    encryptionAvailable: encryptionAvailable()
  }
}
