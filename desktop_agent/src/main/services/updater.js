/**
 * updater.js — automatyczne aktualizacje (OTA) przez electron-updater + GitHub Releases.
 *
 * Repo publiczne → nie trzeba tokenu. CI buduje instalator + latest.yml na tag,
 * a tutaj: sprawdzamy feed (po starcie i co CHECK_INTERVAL_MS — agent działa
 * tygodniami bez restartu), pobieramy w tle i informujemy renderer (toast).
 *
 * v6.4: łatki zdalne — pobrana aktualizacja instaluje się SAMA, gdy agent jest
 * bezczynny (żadna synchronizacja nie trwa), najwcześniej INSTALL_DELAY_MS po
 * pobraniu. Klient może też kliknąć „Zainstaluj" wcześniej (quitAndInstall).
 * Wydania muszą być opublikowane (nie Draft) — szkiców electron-updater nie widzi.
 *
 * electron-updater ładujemy LENIWIE — brak zależności (przed `npm install`) nie
 * może wywalać procesu głównego.
 */

let autoUpdater = null
let sendEvent = () => {}
let logger = () => {}
let isBusy = () => false
let installTimer = null

const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000 // co 2 h
const INSTALL_DELAY_MS = 5 * 60 * 1000 // 5 min na reakcję klienta po pobraniu
const INSTALL_RETRY_MS = 60 * 1000 // gdy trwa synchronizacja — próbuj co minutę

async function load() {
  if (autoUpdater) return autoUpdater
  const mod = await import('electron-updater')
  autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater ?? mod.default
  return autoUpdater
}

/** Inicjalizacja przy starcie (tylko w wersji spakowanej). */
export async function initUpdater({ isDev, onEvent, log, busy } = {}) {
  sendEvent = typeof onEvent === 'function' ? onEvent : () => {}
  logger = typeof log === 'function' ? log : () => {}
  isBusy = typeof busy === 'function' ? busy : () => false
  if (isDev) return
  try {
    const up = await load()
    up.autoDownload = true
    up.autoInstallOnAppQuit = true

    up.on('checking-for-update', () => sendEvent({ state: 'checking' }))
    up.on('update-available', (i) => { logger('info', `Aktualizacja dostępna: v${i?.version}`); sendEvent({ state: 'available', version: i?.version }) })
    up.on('update-not-available', () => sendEvent({ state: 'none' }))
    up.on('download-progress', (p) => sendEvent({ state: 'downloading', percent: Math.round(p?.percent ?? 0) }))
    up.on('update-downloaded', (i) => {
      logger('success', `Aktualizacja v${i?.version} pobrana — instalacja automatyczna za ${INSTALL_DELAY_MS / 60000} min (gdy nie trwa synchronizacja).`)
      sendEvent({ state: 'ready', version: i?.version })
      scheduleAutoInstall(i?.version)
    })
    up.on('error', (e) => {
      logger('warn', `Auto-update: ${String(e?.message ?? e).split('\n')[0]}`)
      sendEvent({ state: 'error', message: String(e?.message ?? e) })
    })

    const check = () => up.checkForUpdates().catch((e) => logger('warn', `Sprawdzenie aktualizacji: ${e?.message ?? e}`))
    // Sprawdzenie po starcie (z opóźnieniem, żeby nie kolidować z inicjalizacją okna) i cyklicznie.
    setTimeout(check, 8000)
    setInterval(check, CHECK_INTERVAL_MS).unref?.()
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

/** Instalacja bez udziału klienta, gdy agent jest bezczynny. */
function scheduleAutoInstall(version) {
  if (installTimer) return
  const attempt = () => {
    if (isBusy()) {
      installTimer = setTimeout(attempt, INSTALL_RETRY_MS)
      return
    }
    installTimer = null
    logger('info', `Instaluję aktualizację v${version ?? ''} — agent uruchomi się ponownie.`)
    quitAndInstall()
  }
  installTimer = setTimeout(attempt, INSTALL_DELAY_MS)
}

/** Instalacja pobranej aktualizacji (restart aplikacji) — na kliknięcie klienta lub automatycznie. */
export function quitAndInstall() {
  // isSilent=true: instalator NSIS bez okien; isForceRunAfter=true: agent wraca sam.
  if (autoUpdater) autoUpdater.quitAndInstall(true, true)
}
