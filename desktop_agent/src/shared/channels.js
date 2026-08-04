/**
 * Kontrakt IPC — jedyne źródło prawdy dla nazw kanałów.
 *
 * Importowane przez main, preload i renderer. Dzięki temu literówka w nazwie
 * kanału jest błędem importu, a nie cichym brakiem odpowiedzi.
 */

export const CH = {
  // --- ustawienia ---------------------------------------------------------
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE_DB: 'settings:save-db',
  SETTINGS_SAVE_CLOUD: 'settings:save-cloud',
  SETTINGS_SAVE_SYNC: 'settings:save-sync',
  SETTINGS_SAVE_SCHEMA_MAP: 'settings:save-schema-map',
  SETTINGS_SAVE_APP: 'settings:save-app',

  // --- baza Wapro ---------------------------------------------------------
  DB_TEST: 'db:test',
  DB_WAREHOUSES: 'db:warehouses',
  DB_INTROSPECT: 'db:introspect',
  DB_DISCOVER_TABLES: 'db:discover-tables',
  DB_PREVIEW_STOCK: 'db:preview-stock',
  DB_STAGING_STATUS: 'db:staging-status',
  DB_STAGING_CREATE: 'db:staging-create',
  DB_STAGED_ORDERS: 'db:staged-orders',
  DB_BUFFER_STATS: 'db:buffer-stats',
  DB_REFLECT_BUFFER: 'db:reflect-buffer',
  DB_REFLECT_PREVIEW: 'db:reflect-preview',

  // --- cloud --------------------------------------------------------------
  CLOUD_TEST: 'cloud:test',

  // --- integracje bezpośrednie (BaseLinker, Allegro) ----------------------
  INTEGRATIONS_GET: 'integrations:get',
  INTEGRATIONS_SAVE_BASELINKER: 'integrations:save-baselinker',
  INTEGRATIONS_SAVE_ALLEGRO: 'integrations:save-allegro',
  INTEGRATIONS_TEST_BASELINKER: 'integrations:test-baselinker',
  INTEGRATIONS_TEST_ALLEGRO: 'integrations:test-allegro',
  INTEGRATIONS_ALLEGRO_AUTHORIZE: 'integrations:allegro-authorize',
  INTEGRATIONS_ALLEGRO_DISCONNECT: 'integrations:allegro-disconnect',
  INTEGRATIONS_BL_ORDERS: 'integrations:baselinker-orders',
  INTEGRATIONS_BL_STATUSES: 'integrations:baselinker-statuses',
  INTEGRATIONS_ALLEGRO_ORDERS: 'integrations:allegro-orders',

  // --- synchronizacja -----------------------------------------------------
  SYNC_RUN_UP: 'sync:run-up',
  SYNC_RUN_UP_ALLEGRO: 'sync:run-up-allegro',
  SYNC_RUN_DOWN: 'sync:run-down',
  SYNC_DRY_RUN: 'sync:dry-run',
  SYNC_START_SCHEDULER: 'sync:start-scheduler',
  SYNC_STOP_SCHEDULER: 'sync:stop-scheduler',
  SYNC_STATUS: 'sync:status',
  SYNC_RESET_CACHE: 'sync:reset-cache',

  // --- system -------------------------------------------------------------
  APP_PICK_FOLDER: 'app:pick-folder',
  APP_PICK_WATCH_FOLDER: 'app:pick-watch-folder',
  APP_VERSION: 'app:version',
  APP_OPEN_LOGS: 'app:open-logs',
  APP_OPEN_EXTERNAL: 'app:open-external',
  APP_AUTOSTART_GET: 'app:autostart-get',
  APP_AUTOSTART_SET: 'app:autostart-set',

  // --- zdarzenia main → renderer (jednokierunkowe) ------------------------
  EVT_LOG: 'evt:log',
  EVT_STATUS: 'evt:status'
}

/** Kanały, na które renderer może się subskrybować. */
export const SUBSCRIBABLE = [CH.EVT_LOG, CH.EVT_STATUS]
