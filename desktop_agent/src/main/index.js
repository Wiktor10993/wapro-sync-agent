import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CH } from '../shared/channels.js'
import {
  getAppearance,
  getDbSettings,
  getPublicIntegrations,
  getPublicSettings,
  getSchemaMap,
  getSyncSettings,
  resetStockCache,
  saveAllegroSettings,
  saveAppearance,
  saveBaseLinkerSettings,
  saveDbSettings,
  saveSchemaMap,
  saveSyncSettings
} from './store.js'
import { closePool, initPool, testConnection } from './wapro/pool.js'
import { fetchStockSnapshot, fetchWarehouses } from './wapro/inventoryRepository.js'
import { discoverTables, introspectSchema } from './wapro/introspect.js'
import {
  ensureStagingSchema,
  listStagedOrders,
  stagingSchemaStatus
} from './wapro/orderRepository.js'
import { bufferStats } from './wapro/bufferReflector.js'
import {
  authorizeAllegro,
  disconnectAllegro,
  fetchAllegroOrders,
  testAllegroConnection
} from './services/allegroAuth.js'
import {
  getOrderStatusList,
  getOrders as getBaseLinkerOrders,
  testBaseLinkerConnection
} from './services/baselinkerApi.js'
import {
  dryRunOrder,
  isRunning,
  runAllegroSyncUp,
  runReflector,
  runSyncDown,
  runSyncUp
} from './services/syncService.js'
import { isSchedulerRunning, startScheduler, stopScheduler } from './services/scheduler.js'
import { closeLogger, getLogDirectory, writeLogLine } from './services/fileLogger.js'
import { createTray, destroyTray, getAutoStart, setAutoStart, updateTrayMenu } from './services/tray.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Tryb deweloperski — bez dodatkowych zależności, wprost z API Electrona. */
const isDev = !app.isPackaged

let mainWindow = null
let isQuitting = false
let lastStatus = { schedulerRunning: false }

// Pojedyncza instancja — dwa agenty na tej samej bazie robiłyby podwójne wysyłki.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// ---------------------------------------------------------------------------
// Logowanie
// ---------------------------------------------------------------------------

const LOG_BUFFER = []
const LOG_BUFFER_MAX = 500

/** @param {'info'|'warn'|'error'|'success'} level */
function log(level, message) {
  const entry = { level, message, at: new Date().toISOString() }

  LOG_BUFFER.push(entry)
  if (LOG_BUFFER.length > LOG_BUFFER_MAX) LOG_BUFFER.shift()

  console.log(`[${entry.at}] ${level.toUpperCase()}: ${message}`)
  writeLogLine(level, message)

  // Okno mogło zostać zamknięte w trakcie zadania tła.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CH.EVT_LOG, entry)
  }
}

function emitStatus(patch) {
  lastStatus = { ...lastStatus, ...patch }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CH.EVT_STATUS, patch)
  }

  updateTrayMenu({ ...lastStatus, ...getPublicSettings() }, trayHandlers)
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

const trayHandlers = {
  onShow: () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  },
  onSyncUp: () => {
    runSyncUp(log).catch((err) => log('error', `SyncUp z traya: ${err.message}`))
  },
  onSyncDown: () => {
    runSyncDown(log).catch((err) => log('error', `SyncDown z traya: ${err.message}`))
  },
  onToggleScheduler: () => {
    isSchedulerRunning() ? stopScheduler() : startScheduler(log, emitStatus)
    emitStatus({ schedulerRunning: isSchedulerRunning() })
  },
  onQuit: () => {
    isQuitting = true
    app.quit()
  }
}

// ---------------------------------------------------------------------------
// Okno
// ---------------------------------------------------------------------------

function createWindow(startHidden = false) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Wapro ⇄ Allegro / BaseLinker — Agent',
    // Bez tego przy ciemnym motywie mignie białe okno zanim wczyta się CSS.
    backgroundColor: '#0f141a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      // Twarde wymogi bezpieczeństwa — renderer nie dotyka Node'a.
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!startHidden) mainWindow.show()
  })

  // Zamknięcie krzyżykiem chowa do traya — agent musi działać dalej.
  mainWindow.on('close', (event) => {
    if (!isQuitting && getAppearance().minimizeToTray) {
      event.preventDefault()
      mainWindow.hide()

      if (process.platform === 'darwin') app.dock?.hide()
      log('info', 'Okno ukryte — agent pracuje w tle (ikona w zasobniku).')
    }
  })

  // Linki zewnętrzne w przeglądarce systemowej, nie w oknie aplikacji.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// Handlery IPC
// ---------------------------------------------------------------------------

/**
 * Rejestruje handler z jednolitą obsługą błędów.
 * Rzucony wyjątek wraca do renderera jako odrzucona obietnica — preload
 * zamienia go na {ok:false, error}.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return await fn(payload)
    } catch (err) {
      log('error', `${channel}: ${err.message}`)
      throw err
    }
  })
}

function registerIpc() {
  // --- ustawienia --------------------------------------------------------
  handle(CH.SETTINGS_GET, async () => ({
    ...getPublicSettings(),
    logs: LOG_BUFFER.slice(-200),
    schedulerRunning: isSchedulerRunning(),
    autoStart: getAutoStart(),
    logPath: getLogDirectory()
  }))

  handle(CH.SETTINGS_SAVE_DB, async (payload) => {
    const saved = saveDbSettings(payload || {})
    // Zmiana parametrów unieważnia dotychczasowy pool.
    await closePool()
    log('success', `Zapisano ustawienia bazy (${saved.host}/${saved.database}).`)
    return saved
  })

  handle(CH.SETTINGS_SAVE_SYNC, async (payload) => {
    const saved = saveSyncSettings(payload || {})
    log('success', 'Zapisano ustawienia synchronizacji.')
    if (isSchedulerRunning()) {
      startScheduler(log, emitStatus) // przeładuj interwały
    }
    return saved
  })

  handle(CH.SETTINGS_SAVE_SCHEMA_MAP, async (payload) => {
    const saved = saveSchemaMap(payload || {})
    log('success', 'Zapisano mapowanie schematu Wapro.')
    return saved
  })

  handle(CH.SETTINGS_SAVE_APP, async (payload) => {
    const saved = saveAppearance(payload || {})
    log('success', 'Zapisano ustawienia aplikacji.')
    return saved
  })

  // --- baza --------------------------------------------------------------
  handle(CH.DB_TEST, async (payload) => {
    // Pozwalamy testować dane z formularza jeszcze przed zapisem.
    const settings = payload && payload.host ? { ...getDbSettings(), ...payload } : getDbSettings()
    const info = await testConnection(settings)
    log('success', `Połączono z MSSQL: ${info.serwer} / ${info.baza} (v${info.wersja}).`)
    return info
  })

  handle(CH.DB_WAREHOUSES, async () => {
    const list = await fetchWarehouses(getDbSettings(), getSchemaMap())
    log('info', `Odczytano ${list.length} magazynów.`)
    return list
  })

  handle(CH.DB_INTROSPECT, async () => {
    const report = await introspectSchema(getDbSettings(), getSchemaMap())
    log(report.ok ? 'success' : 'warn', `Introspekcja schematu: ${report.summary}`)
    return report
  })

  handle(CH.DB_DISCOVER_TABLES, async () => {
    const result = await discoverTables(getDbSettings())
    log(
      'info',
      `Wyszukiwanie tabel: ${result.tables.length} tabel w bazie ` +
        `(produkty: ${result.suggestions.artykuly.length}, stany: ${result.suggestions.stany.length}, ` +
        `magazyny: ${result.suggestions.magazyny.length} sugestii).`
    )
    return result
  })

  handle(CH.DB_PREVIEW_STOCK, async ({ limit = 25 } = {}) => {
    const sync = getSyncSettings()
    const rows = await fetchStockSnapshot(getDbSettings(), {
      warehouseIds: sync.warehouseIds,
      subtractReserved: sync.subtractReserved,
      skipArchived: sync.skipArchived,
      aggregateWarehouses: sync.aggregateWarehouses,
      schemaOverrides: getSchemaMap()
    })
    return { total: rows.length, sample: rows.slice(0, Math.max(1, Math.min(200, limit))) }
  })

  handle(CH.DB_STAGING_STATUS, async () => stagingSchemaStatus(getDbSettings()))

  handle(CH.DB_STAGING_CREATE, async () => ensureStagingSchema(getDbSettings(), log))

  handle(CH.DB_STAGED_ORDERS, async ({ status = '', limit = 100 } = {}) =>
    listStagedOrders(getDbSettings(), { status, limit })
  )

  handle(CH.DB_BUFFER_STATS, async () => bufferStats(getDbSettings()))

  handle(CH.DB_REFLECT_BUFFER, async () => runReflector(log))

  handle(CH.DB_REFLECT_PREVIEW, async () => runReflector(log, { dryRun: true }))

  // --- integracje bezpośrednie -------------------------------------------
  // Wszystkie zwracają wyłącznie dane publiczne — sekrety nie opuszczają
  // procesu głównego.

  handle(CH.INTEGRATIONS_GET, async () => getPublicIntegrations())

  handle(CH.INTEGRATIONS_SAVE_BASELINKER, async (payload) => {
    const saved = saveBaseLinkerSettings(payload || {})
    log('success', 'Zapisano ustawienia BaseLinkera.')
    return saved
  })

  handle(CH.INTEGRATIONS_SAVE_ALLEGRO, async (payload) => {
    // Diagnostyka: co dokładnie dotarło z UI do procesu głównego.
    console.log('[IPC] save-allegro — payload:', {
      clientId: payload?.clientId || '(brak)',
      clientSecret: payload?.clientSecret ? '(podano)' : '(puste — bez zmian)',
      redirectUri: payload?.redirectUri || '(brak)',
      sandbox: payload?.sandbox
    })
    log(
      'info',
      `Zapis Allegro: Client ID ${payload?.clientId ? 'podany' : 'BRAK'}, ` +
        `secret ${payload?.clientSecret ? 'podany' : 'bez zmian'}.`
    )

    const before = getPublicIntegrations().allegro.authorized
    const saved = saveAllegroSettings(payload || {})

    // Potwierdzenie z odczytu po zapisie — jeśli tu jest pusto, problem jest
    // w zapisie/konfiguracji, a nie w UI.
    console.log('[IPC] save-allegro — po zapisie clientId w konfiguracji:', saved.allegro.clientId || '(brak!)')

    if (before && !saved.allegro.authorized) {
      log('warn', 'Zmiana Client ID lub adresu powrotnego unieważniła tokeny — autoryzuj konto ponownie.')
    } else {
      log('success', `Zapisano ustawienia Allegro (Client ID: ${saved.allegro.clientId || 'brak'}).`)
    }
    return saved
  })

  handle(CH.INTEGRATIONS_TEST_BASELINKER, async ({ token } = {}) =>
    testBaseLinkerConnection(token, log)
  )

  handle(CH.INTEGRATIONS_TEST_ALLEGRO, async () => testAllegroConnection(log))

  handle(CH.INTEGRATIONS_ALLEGRO_AUTHORIZE, async () => {
    const result = await authorizeAllegro(log)
    return { ...result, integrations: getPublicIntegrations() }
  })

  handle(CH.INTEGRATIONS_ALLEGRO_DISCONNECT, async () => {
    disconnectAllegro(log)
    return getPublicIntegrations()
  })

  handle(CH.INTEGRATIONS_BL_ORDERS, async (opts = {}) => {
    const orders = await getBaseLinkerOrders(opts, log)
    // Do GUI wysyłamy skrót — pełne payloady potrafią mieć setki kilobajtów.
    return {
      count: orders.length,
      sample: orders.slice(0, 20).map((o) => ({
        id: o.order_id,
        date: o.date_add,
        buyer: o.delivery_fullname || o.invoice_fullname || o.email || '',
        items: (o.products ?? []).length,
        source: o.order_source ?? ''
      }))
    }
  })

  handle(CH.INTEGRATIONS_BL_STATUSES, async () => getOrderStatusList(log))

  handle(CH.INTEGRATIONS_ALLEGRO_ORDERS, async (opts = {}) => {
    const orders = await fetchAllegroOrders(opts, log)
    return {
      count: orders.length,
      sample: orders.slice(0, 20).map((o) => ({
        id: o.id,
        date: o.updatedAt ?? o.boughtAt ?? '',
        buyer:
          o.buyer?.login ||
          [o.buyer?.firstName, o.buyer?.lastName].filter(Boolean).join(' ') ||
          '',
        items: (o.lineItems ?? []).length,
        status: o.fulfillment?.status ?? ''
      }))
    }
  })

  // --- synchronizacja ----------------------------------------------------
  handle(CH.SYNC_RUN_UP, async () => runSyncUp(log))
  handle(CH.SYNC_RUN_UP_ALLEGRO, async () => runAllegroSyncUp(log))
  handle(CH.SYNC_RUN_DOWN, async () => runSyncDown(log))

  handle(CH.SYNC_DRY_RUN, async () => {
    // Bierzemy jedno zamówienie prosto z BaseLinkera i pokazujemy, co by się
    // stało — bez zapisu do bazy.
    const orders = await getBaseLinkerOrders({}, log)
    if (orders.length === 0) {
      return { empty: true, message: 'Brak zamówień w BaseLinkerze — nie ma czego symulować.' }
    }
    const result = await dryRunOrder(orders[0], 'baselinker')
    log('info', `Symulacja zapisu: ${result.ref} (${result.status}).`)
    return result
  })

  handle(CH.SYNC_START_SCHEDULER, async () => {
    const r = startScheduler(log, emitStatus)
    emitStatus({ schedulerRunning: isSchedulerRunning() })
    return r
  })

  handle(CH.SYNC_STOP_SCHEDULER, async () => {
    log('info', 'Zatrzymano harmonogram.')
    const r = stopScheduler()
    emitStatus({ schedulerRunning: false })
    return r
  })

  handle(CH.SYNC_STATUS, async () => ({
    schedulerRunning: isSchedulerRunning(),
    syncUpRunning: isRunning('up'),
    syncUpAllegroRunning: isRunning('upAllegro'),
    syncDownRunning: isRunning('down'),
    reflectRunning: isRunning('reflect'),
    ...getPublicSettings()
  }))

  handle(CH.SYNC_RESET_CACHE, async () => {
    resetStockCache()
    log('warn', 'Wyczyszczono pamięć stanów — następny SyncUp wyśle wszystkie SKU.')
    return { ok: true }
  })

  // --- system ------------------------------------------------------------
  handle(CH.APP_PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Wybierz folder na pliki XML dla Wapro',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle(CH.APP_PICK_WATCH_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Wskaż folder nasłuchu Wapro (skąd ERP wczytuje pliki ECO)',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle(CH.APP_VERSION, async () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform
  }))

  handle(CH.APP_OPEN_LOGS, async () => {
    await shell.openPath(getLogDirectory())
    return { path: getLogDirectory() }
  })

  handle(CH.APP_OPEN_EXTERNAL, async ({ url } = {}) => {
    // Otwieramy wyłącznie http(s) — bez tego renderer mógłby wywołać
    // dowolne polecenie systemowe przez schemat file:// czy custom protocol.
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('Dozwolone są wyłącznie adresy http:// i https://')
    }
    await shell.openExternal(url)
    return { ok: true }
  })

  handle(CH.APP_AUTOSTART_GET, async () => getAutoStart())

  handle(CH.APP_AUTOSTART_SET, async ({ enabled } = {}) => {
    const result = setAutoStart(Boolean(enabled))
    saveAppearance({ autoStart: result.enabled })
    log('info', `Uruchamianie z systemem: ${result.enabled ? 'włączone' : 'wyłączone'}.`)
    return result
  })
}

// ---------------------------------------------------------------------------
// Cykl życia
// ---------------------------------------------------------------------------

if (gotLock) {
  app.on('second-instance', () => {
    trayHandlers.onShow()
  })

  app.whenReady().then(async () => {
    // Na Windowsie decyduje o grupowaniu okien na pasku zadań i o ikonie
    // w powiadomieniach. Na innych systemach wywołanie jest nieszkodliwe.
    if (process.platform === 'win32') {
      app.setAppUserModelId('pl.integracja.waproagent')
    }

    // Interfejs jest ciemny — wymuszamy ciemne elementy natywne (pasek tytułu,
    // okna dialogowe, menu kontekstowe), żeby nie odcinały się od aplikacji.
    nativeTheme.themeSource = 'dark'

    registerIpc()
    createTray(trayHandlers)

    // Start z autostartu (--hidden) nie powinien wyskakiwać oknem na pulpit.
    const startHidden =
      process.argv.includes('--hidden') || getAppearance().startMinimized

    createWindow(startHidden)

    log('info', `Agent uruchomiony (v${app.getVersion()}, ${process.platform}, Electron ${process.versions.electron}).`)

    // Wstępne nawiązanie połączenia z bazą — nie blokuje startu GUI,
    // ale od razu pokazuje w logu, czy dane logowania są poprawne.
    try {
      await initPool(getDbSettings(), log)
    } catch (err) {
      log('warn', `Inicjalizacja puli MSSQL: ${err.message}`)
    }

    try {
      if (getSyncSettings().enabled) {
        startScheduler(log, emitStatus)
      }
      emitStatus({ schedulerRunning: isSchedulerRunning() })
    } catch (err) {
      log('error', `Nie udało się uruchomić harmonogramu: ${err.message}`)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else trayHandlers.onShow()
    })
  })
}

app.on('window-all-closed', () => {
  // Celowo NIE kończymy aplikacji — agent żyje w zasobniku.
  // Wyjście następuje wyłącznie przez „Zakończ” w menu traya.
})

app.on('before-quit', async () => {
  isQuitting = true
  stopScheduler()
  destroyTray()
  await closePool()
  log('info', 'Agent zatrzymany.')
  closeLogger()
})

// Nieobsłużone odrzucenia obietnic nie mogą ubić agenta działającego 24/7.
process.on('unhandledRejection', (reason) => {
  log('error', `Nieobsłużone odrzucenie obietnicy: ${reason?.message ?? reason}`)
})
process.on('uncaughtException', (err) => {
  log('error', `Nieprzechwycony wyjątek: ${err.message}`)
})
