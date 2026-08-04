import sql from 'mssql'

/**
 * Zarządzanie połączeniem z MSSQL (Wapro Mag).
 *
 * Trzymamy jeden pool na proces. Zmiana ustawień w GUI zamyka stary pool
 * i otwiera nowy — bez restartu aplikacji.
 */

let pool = null
let poolFingerprint = null
let connecting = null

function fingerprint(cfg) {
  return [cfg.server, cfg.port, cfg.database, cfg.user, cfg.encrypt, cfg.instanceName].join('|')
}

/**
 * Buduje konfigurację `mssql` z ustawień zapisanych w electron-store.
 */
export function buildConfig(settings) {
  const {
    host,
    port = 1433,
    instanceName = '',
    database,
    user,
    password,
    encrypt = false,
    trustServerCertificate = true,
    connectionTimeout = 15000,
    requestTimeout = 60000,
    poolMax = 5
  } = settings || {}

  if (!host || String(host).trim() === '') {
    throw new Error('Nie podano hosta / adresu IP serwera MSSQL.')
  }
  if (!database || String(database).trim() === '') {
    throw new Error('Nie podano nazwy bazy danych Wapro.')
  }
  if (!user) {
    throw new Error('Nie podano użytkownika MSSQL.')
  }

  const config = {
    server: String(host).trim(),
    port: Number(port) || 1433,
    database: String(database).trim(),
    user: String(user),
    password: String(password ?? ''),
    connectionTimeout: Number(connectionTimeout),
    requestTimeout: Number(requestTimeout),
    pool: {
      max: Number(poolMax) || 5,
      min: 0,
      idleTimeoutMillis: 30000
    },
    options: {
      encrypt: Boolean(encrypt),
      // Instalacje lokalne prawie zawsze mają certyfikat self-signed.
      trustServerCertificate: Boolean(trustServerCertificate),
      enableArithAbort: true,
      // Zwracaj DECIMAL/NUMERIC jako number — stany magazynowe w Wapro
      // to zwykle NUMERIC(14,4).
      useUTC: true
    }
  }

  // Instancja nazwana (np. SQLEXPRESS) — wtedy port jest ignorowany
  // na rzecz SQL Browser.
  if (String(instanceName).trim() !== '') {
    config.options.instanceName = String(instanceName).trim()
    delete config.port
  }

  return config
}

/**
 * Zwraca aktywny pool, tworząc go w razie potrzeby.
 * Bezpieczne przy równoległych wywołaniach (współdzielona obietnica).
 */
export async function getPool(settings) {
  const config = buildConfig(settings)
  const fp = fingerprint(config)

  if (pool && pool.connected && poolFingerprint === fp) {
    return pool
  }

  if (connecting) {
    return connecting
  }

  connecting = (async () => {
    if (pool) {
      try {
        await pool.close()
      } catch {
        /* zamykamy best-effort */
      }
      pool = null
    }

    const newPool = new sql.ConnectionPool(config)

    // Bez tego handlera błąd poolu po nawiązaniu połączenia (np. zerwana sieć)
    // wywala proces main.
    newPool.on('error', (err) => {
      console.error('[MSSQL] Błąd poolu:', err.message)
    })

    try {
      await newPool.connect()
    } catch (err) {
      throw translateError(err)
    }

    pool = newPool
    poolFingerprint = fp
    return pool
  })()

  try {
    return await connecting
  } finally {
    connecting = null
  }
}

/**
 * Jawna inicjalizacja puli.
 *
 * `getPool()` i tak tworzy pulę leniwie, ale przy starcie aplikacji chcemy
 * wiedzieć od razu, czy dane logowania są poprawne — zamiast dowiadywać się
 * o tym przy pierwszej synchronizacji o 3 w nocy. Ta funkcja nigdy nie rzuca:
 * zwraca opis wyniku, żeby brak połączenia nie blokował startu GUI.
 *
 * @param {object} settings ustawienia połączenia
 * @param {(level:string, message:string)=>void} [log]
 * @returns {Promise<{ok:boolean, info?:object, error?:string}>}
 */
export async function initPool(settings, log = () => {}) {
  if (!settings?.host || !settings?.database) {
    log('info', 'Pomijam inicjalizację puli MSSQL — baza nie jest jeszcze skonfigurowana.')
    return { ok: false, error: 'Baza nie jest skonfigurowana.' }
  }

  try {
    const p = await getPool(settings)
    const res = await p.request().query(`
      SELECT
        DB_NAME()                        AS baza,
        @@SERVERNAME                     AS serwer,
        SERVERPROPERTY('ProductVersion') AS wersja
    `)
    const info = res.recordset[0]

    log('success', `Pula MSSQL gotowa: ${info.serwer} / ${info.baza} (v${info.wersja}).`)
    return { ok: true, info }
  } catch (err) {
    const message = translateError(err).message
    log('warn', `Nie udało się nawiązać połączenia z bazą przy starcie: ${message}`)
    return { ok: false, error: message }
  }
}

/** Czy pula jest aktualnie połączona? */
export function isPoolConnected() {
  return Boolean(pool && pool.connected)
}

export async function closePool() {
  if (pool) {
    try {
      await pool.close()
    } catch {
      /* ignorujemy */
    }
    pool = null
    poolFingerprint = null
  }
}

/**
 * Test połączenia — używany przez przycisk "Testuj połączenie" w GUI.
 * Zwraca wersję serwera i nazwę bazy, żeby użytkownik miał potwierdzenie,
 * że trafił we właściwą instancję.
 */
export async function testConnection(settings) {
  const p = await getPool(settings)
  const result = await p.request().query(`
    SELECT
      DB_NAME()                        AS baza,
      @@SERVERNAME                     AS serwer,
      SERVERPROPERTY('ProductVersion') AS wersja,
      SYSDATETIME()                    AS czas_serwera
  `)
  return result.recordset[0]
}

/**
 * Tłumaczy techniczne błędy sterownika na komunikaty zrozumiałe dla klienta,
 * który nie jest informatykiem.
 */
export function translateError(err) {
  const msg = String(err?.message || err)
  const code = err?.code || err?.originalError?.code

  if (code === 'ELOGIN' || /Login failed/i.test(msg)) {
    return new Error(
      'Logowanie odrzucone. Sprawdź użytkownika i hasło. ' +
        'Jeśli SQL Server używa tylko uwierzytelniania Windows, włącz tryb mieszany.'
    )
  }
  if (code === 'ESOCKET' || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(msg)) {
    return new Error(
      'Nie można nawiązać połączenia z serwerem. Sprawdź adres IP i port, ' +
        'czy usługa SQL Server działa oraz czy zapora nie blokuje portu 1433.'
    )
  }
  if (/instance.*not found|SQL Server Browser/i.test(msg)) {
    return new Error(
      'Nie znaleziono instancji nazwanej. Upewnij się, że nazwa jest poprawna ' +
        'i że usługa SQL Server Browser jest uruchomiona.'
    )
  }
  if (/Cannot open database/i.test(msg)) {
    return new Error('Baza o podanej nazwie nie istnieje lub użytkownik nie ma do niej dostępu.')
  }
  if (/self signed certificate|certificate/i.test(msg)) {
    return new Error(
      'Problem z certyfikatem SSL serwera. Zaznacz opcję "Ufaj certyfikatowi serwera".'
    )
  }
  return new Error(`Błąd bazy danych: ${msg}`)
}

export { sql }
