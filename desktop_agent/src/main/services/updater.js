/**
 * updater.js — automatyczne aktualizacje (OTA) przez electron-updater + GitHub Releases.
 *
 * Repo publiczne → nie trzeba tokenu. CI buduje instalator + latest.yml na tag,
 * a tutaj: sprawdzamy feed, pobieramy w tle i informujemy renderer (toast).
 * Instalacja NASTĘPUJE dopiero na wyraźne kliknięcie klienta (quitAndInstall).
 *
 * electron-updater ładujemy LENIWIE — brak zależności (przed `npm install`) nie
 * może wywalać procesu głównego.
 */

let autoUpdater = null
let sendEvent = () => {}
let logger = () => {}

async function load() {
  if (autoUpdater) return autoUpdater
  const mod = await import('electron-updater')
  autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater ?? mod.default
  return autoUpdater
}

/** Inicjalizacja przy starcie (tylko w wersji spakowanej). */
export async function initUpdater({ isDev, onEvent, log } = {}) {
  sendEvent = typeof onEvent === 'function' ? onEvent : () => {}
  logger = typeof log === 'function' ? log : () => {}
  if (isDev) return
  try {
    const up = await load()
    up.autoDownload = true
    up.autoInstallOnAppQuit = true

    up.on('checking-for-update', () => sendEvent({ state: 'checking' }))
    up.on('update-available', (i) => { logger('info', `Aktualizacja dostępna: v${i?.version}`); sendEvent({ state: 'available', version: i?.version }) })
    up.on('update-not-available', () => sendEvent({ state: 'none' }))
    up.on('download-progress', (p) => sendEvent({ state: 'downloading', percent: Math.round(p?.percent ?? 0) }))
    up.on('update-downloaded', (i) => { logger('success', `Aktualizacja v${i?.version} pobrana — gotowa do instalacji.`); sendEvent({ state: 'ready', version: i?.version }) })
    up.on('error', (e) => sendEvent({ state: 'error', message: String(e?.message ?? e) }))

    // Sprawdzenie po starcie (z opóźnieniem, żeby nie kolidować z inicjalizacją okna).
    setTimeout(() => up.checkForUpdates().catch((e) => logger('warn', `Sprawdzenie aktualizacji: ${e?.message ?? e}`)), 8000)
  } catch (e) {
    logger('warn', `Auto-update wyłączony (brak electron-updater — uruchom „npm install"): ${e?.message ?? e}`)
  }
}

/** Ręczne sprawdzenie (przycisk w UI). */
export async function checkForUpdates() {
  try {
    const up = await load()
    const r = await up.checkForUpdates()
    return { ok: true, version: r?.updateInfo?.version ?? null }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** Instalacja pobranej aktualizacji (restart aplikacji) — na kliknięcie klienta. */
export function quitAndInstall() {
  if (autoUpdater) autoUpdater.quitAndInstall(false, true)
}
