import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { getLogDirectory } from './fileLogger.js'

/**
 * Ikona w zasobniku systemowym.
 *
 * Agent musi działać w tle także po zamknięciu okna — zamknięcie krzyżykiem
 * chowa aplikację do traya zamiast ją kończyć (poza jawnym „Zakończ”).
 * Bez tego użytkownik zamyka okno po konfiguracji i synchronizacja przestaje
 * działać, o czym dowiaduje się dopiero po nadsprzedaży.
 *
 * Ikonę rysujemy programowo (PNG w base64), żeby nie ciągnąć plików binarnych
 * przez proces budowania.
 */

let tray = null

/** Kwadrat 16×16 w kolorze akcentu — wystarcza jako wskaźnik statusu. */
function buildIcon(active) {
  const size = 16
  const buffer = Buffer.alloc(size * size * 4)

  // RGBA: zielony gdy synchronizacja działa, szary gdy zatrzymana.
  const [r, g, b] = active ? [30, 122, 77] : [107, 116, 128]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // Zaokrąglone rogi — prosty test odległości od środka.
      const dx = x - 7.5
      const dy = y - 7.5
      const inside = Math.abs(dx) < 6.5 && Math.abs(dy) < 6.5 && dx * dx + dy * dy < 72

      buffer[i] = r
      buffer[i + 1] = g
      buffer[i + 2] = b
      buffer[i + 3] = inside ? 255 : 0
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size })
}

/**
 * @param {object} handlers
 * @param {() => void} handlers.onShow
 * @param {() => void} handlers.onSyncUp
 * @param {() => void} handlers.onSyncDown
 * @param {() => void} handlers.onToggleScheduler
 * @param {() => void} handlers.onQuit
 */
export function createTray(handlers) {
  if (tray) return tray

  tray = new Tray(buildIcon(false))
  tray.setToolTip('Wapro Sync Agent')

  tray.on('double-click', () => handlers.onShow())

  updateTrayMenu({ schedulerRunning: false }, handlers)

  return tray
}

export function updateTrayMenu(state, handlers) {
  if (!tray) return

  const running = Boolean(state.schedulerRunning)

  tray.setImage(buildIcon(running))
  tray.setToolTip(
    running
      ? `Wapro Sync Agent — synchronizacja aktywna${
          state.lastSyncUpAt ? `\nOstatnie stany: ${new Date(state.lastSyncUpAt).toLocaleString('pl-PL')}` : ''
        }`
      : 'Wapro Sync Agent — zatrzymany'
  )

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: running ? '● Synchronizacja aktywna' : '○ Synchronizacja zatrzymana', enabled: false },
      { type: 'separator' },
      { label: 'Otwórz okno', click: () => handlers.onShow() },
      { type: 'separator' },
      { label: 'Wyślij stany teraz', click: () => handlers.onSyncUp() },
      { label: 'Pobierz zamówienia teraz', click: () => handlers.onSyncDown() },
      { type: 'separator' },
      {
        label: running ? 'Zatrzymaj harmonogram' : 'Uruchom harmonogram',
        click: () => handlers.onToggleScheduler()
      },
      { label: 'Otwórz folder z logami', click: () => shell.openPath(getLogDirectory()) },
      { type: 'separator' },
      { label: `Wersja ${app.getVersion()}`, enabled: false },
      { label: 'Zakończ', click: () => handlers.onQuit() }
    ])
  )
}

export function destroyTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

/**
 * Uruchamianie razem z systemem.
 * Na Linuksie Electron nie obsługuje tego jednolicie — tam zwracamy false
 * i GUI ukrywa opcję, zamiast obiecywać coś, co nie zadziała.
 */
export function setAutoStart(enabled) {
  if (process.platform === 'linux') {
    return { supported: false, enabled: false }
  }

  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    openAsHidden: true,
    // --hidden pozwala main wykryć start z autostartu i nie pokazywać okna.
    args: enabled ? ['--hidden'] : []
  })

  return { supported: true, enabled: app.getLoginItemSettings().openAtLogin }
}

export function getAutoStart() {
  if (process.platform === 'linux') {
    return { supported: false, enabled: false }
  }
  return { supported: true, enabled: app.getLoginItemSettings().openAtLogin }
}
