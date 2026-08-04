import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * Log do pliku z rotacją rozmiarową.
 *
 * Agent działa u klienta miesiącami bez nadzoru — logi w pamięci znikają przy
 * restarcie, a to właśnie one są potrzebne, gdy ktoś dzwoni z pytaniem „czemu
 * wczoraj nie zsynchronizowało". Rotacja po 5 MB, 5 plików wstecz: łącznie
 * do 25 MB, co przy typowym ruchu wystarcza na kilka tygodni historii.
 *
 * Zapis jest synchroniczny — celowo. Log ma przetrwać nawet twarde ubicie
 * procesu, a wolumen (kilkadziesiąt linii na przebieg) nie uzasadnia
 * kolejkowania asynchronicznego.
 */

const MAX_BYTES = 5 * 1024 * 1024
const MAX_FILES = 5

let logPath = null
let stream = null

function resolveLogPath() {
  if (logPath) return logPath
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  logPath = path.join(dir, 'agent.log')
  return logPath
}

function rotateIfNeeded() {
  const file = resolveLogPath()

  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return // plik jeszcze nie istnieje
  }

  if (size < MAX_BYTES) return

  if (stream) {
    stream.end()
    stream = null
  }

  // agent.log.4 → agent.log.5, ..., agent.log → agent.log.1
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const from = `${file}.${i}`
    const to = `${file}.${i + 1}`
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to)
    } catch {
      /* rotacja best-effort — brak miejsca nie może zatrzymać agenta */
    }
  }

  try {
    fs.renameSync(file, `${file}.1`)
  } catch {
    /* ignorujemy */
  }
}

export function writeLogLine(level, message) {
  try {
    rotateIfNeeded()

    if (!stream) {
      stream = fs.createWriteStream(resolveLogPath(), { flags: 'a' })
      stream.on('error', (err) => {
        console.error('[fileLogger] Błąd zapisu logu:', err.message)
        stream = null
      })
    }

    stream.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(7)} ${message}\n`)
  } catch (err) {
    // Log nie może wywrócić aplikacji — najwyżej nie będzie logu.
    console.error('[fileLogger]', err.message)
  }
}

export function getLogFilePath() {
  return resolveLogPath()
}

export function getLogDirectory() {
  return path.dirname(resolveLogPath())
}

/** Ostatnie N linii — do podglądu w GUI po restarcie. */
export function readRecentLines(count = 200) {
  try {
    const content = fs.readFileSync(resolveLogPath(), 'utf8')
    return content.trimEnd().split('\n').slice(-count)
  } catch {
    return []
  }
}

export function closeLogger() {
  if (stream) {
    stream.end()
    stream = null
  }
}
