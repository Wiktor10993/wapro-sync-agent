import { contextBridge, ipcRenderer } from 'electron'
import { CH, SUBSCRIBABLE } from '../shared/channels.js'

/**
 * MOSTEK IPC (preload)
 * ====================
 *
 * Renderer NIE dostaje dostępu do `ipcRenderer` ani do Node'a. Wystawiamy
 * wyłącznie zamknięty zestaw funkcji — to jedyna powierzchnia, przez którą
 * frontend rozmawia z procesem main.
 *
 * Zasady:
 *  - contextIsolation: true, nodeIntegration: false (ustawiane w main),
 *  - `invoke` tylko na kanałach z CH — literał kanału nigdy nie pochodzi
 *    od renderera,
 *  - subskrypcje ograniczone do SUBSCRIBABLE i zwracające funkcję
 *    odsubskrybowania (bez tego React w StrictMode nawarstwia listenery).
 */

/** Owija invoke w jednolity kształt {ok, data|error} — renderer nie musi łapać. */
async function invoke(channel, payload) {
  try {
    const data = await ipcRenderer.invoke(channel, payload)
    return { ok: true, data }
  } catch (err) {
    // Electron opakowuje błąd main w string "Error: …" — obcinamy prefiks.
    const message = String(err?.message ?? err).replace(/^Error:\s*/, '')
    return { ok: false, error: message }
  }
}

const api = {
  // --- ustawienia ---------------------------------------------------------
  getSettings: () => invoke(CH.SETTINGS_GET),
  saveDbSettings: (payload) => invoke(CH.SETTINGS_SAVE_DB, payload),
  saveCloudSettings: (payload) => invoke(CH.SETTINGS_SAVE_CLOUD, payload),
  saveSyncSettings: (payload) => invoke(CH.SETTINGS_SAVE_SYNC, payload),
  saveSchemaMap: (payload) => invoke(CH.SETTINGS_SAVE_SCHEMA_MAP, payload),
  saveAppSettings: (payload) => invoke(CH.SETTINGS_SAVE_APP, payload),

  // --- baza Wapro ---------------------------------------------------------
  testDbConnection: (payload) => invoke(CH.DB_TEST, payload),
  listWarehouses: () => invoke(CH.DB_WAREHOUSES),
  introspectSchema: () => invoke(CH.DB_INTROSPECT),
  discoverTables: () => invoke(CH.DB_DISCOVER_TABLES),
  schemaDiagnostics: () => invoke(CH.DB_SCHEMA_DIAGNOSTICS),
  previewStock: (limit) => invoke(CH.DB_PREVIEW_STOCK, { limit }),
  stagingStatus: () => invoke(CH.DB_STAGING_STATUS),
  createStagingSchema: () => invoke(CH.DB_STAGING_CREATE),
  listStagedOrders: (filters) => invoke(CH.DB_STAGED_ORDERS, filters),
  bufferStats: () => invoke(CH.DB_BUFFER_STATS),
  reflectBuffer: () => invoke(CH.DB_REFLECT_BUFFER),
  previewReflect: () => invoke(CH.DB_REFLECT_PREVIEW),

  // --- cloud --------------------------------------------------------------
  testCloud: (payload) => invoke(CH.CLOUD_TEST, payload),

  // --- integracje bezpośrednie --------------------------------------------
  // Uwaga: te metody NIGDY nie zwracają sekretów. Odpowiedź zawiera tylko
  // flagi `hasToken` / `authorized` i zamaskowany podgląd klucza.
  getIntegrations: () => invoke(CH.INTEGRATIONS_GET),
  saveBaseLinker: (payload) => invoke(CH.INTEGRATIONS_SAVE_BASELINKER, payload),
  saveAllegro: (payload) => invoke(CH.INTEGRATIONS_SAVE_ALLEGRO, payload),
  testBaseLinker: (payload) => invoke(CH.INTEGRATIONS_TEST_BASELINKER, payload),
  testAllegro: () => invoke(CH.INTEGRATIONS_TEST_ALLEGRO),
  authorizeAllegro: () => invoke(CH.INTEGRATIONS_ALLEGRO_AUTHORIZE),
  disconnectAllegro: () => invoke(CH.INTEGRATIONS_ALLEGRO_DISCONNECT),
  fetchBaseLinkerOrders: (payload) => invoke(CH.INTEGRATIONS_BL_ORDERS, payload),
  fetchBaseLinkerStatuses: () => invoke(CH.INTEGRATIONS_BL_STATUSES),
  fetchAllegroOrders: (payload) => invoke(CH.INTEGRATIONS_ALLEGRO_ORDERS, payload),

  // --- synchronizacja -----------------------------------------------------
  runSyncUp: () => invoke(CH.SYNC_RUN_UP),
  runAllegroSyncUp: () => invoke(CH.SYNC_RUN_UP_ALLEGRO),
  runSyncDown: () => invoke(CH.SYNC_RUN_DOWN),
  dryRun: () => invoke(CH.SYNC_DRY_RUN),
  startScheduler: () => invoke(CH.SYNC_START_SCHEDULER),
  stopScheduler: () => invoke(CH.SYNC_STOP_SCHEDULER),
  getStatus: () => invoke(CH.SYNC_STATUS),
  resetCache: () => invoke(CH.SYNC_RESET_CACHE),

  // --- system -------------------------------------------------------------
  pickFolder: () => invoke(CH.APP_PICK_FOLDER),
  pickWatchFolder: () => invoke(CH.APP_PICK_WATCH_FOLDER),
  getVersion: () => invoke(CH.APP_VERSION),
  openLogs: () => invoke(CH.APP_OPEN_LOGS),
  openExternal: (url) => invoke(CH.APP_OPEN_EXTERNAL, { url }),
  getAutoStart: () => invoke(CH.APP_AUTOSTART_GET),
  setAutoStart: (enabled) => invoke(CH.APP_AUTOSTART_SET, { enabled }),

  // --- subskrypcje --------------------------------------------------------
  /**
   * @param {'evt:log'|'evt:status'} channel
   * @param {(payload:any)=>void} handler
   * @returns {()=>void} funkcja odsubskrybowania
   */
  subscribe(channel, handler) {
    if (!SUBSCRIBABLE.includes(channel)) {
      throw new Error(`Kanał "${channel}" nie jest dostępny do subskrypcji.`)
    }
    // Nie przekazujemy obiektu `event` do renderera — zawiera referencję
    // do sendera, czyli ścieżkę wyjścia z sandboxa.
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onLog: (handler) => api.subscribe(CH.EVT_LOG, handler),
  onStatus: (handler) => api.subscribe(CH.EVT_STATUS, handler)
}

contextBridge.exposeInMainWorld('agent', api)
