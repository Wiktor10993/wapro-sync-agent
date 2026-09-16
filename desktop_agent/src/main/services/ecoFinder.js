/**
 * ecoFinder.js — best-effort wykrywanie folderu importu ECO/EDI dla WAPRO.
 *
 * WAŻNE: to NIE jest magiczne wykrycie „tego jedynego" folderu — ścieżka importu
 * bywa w rejestrze/konfiguracji per-stanowisko i różni się między instalacjami.
 * Zwracamy więc listę KANDYDATÓW (foldery, które istnieją i pasują nazwą do
 * ECO/EDI/import/wymiana), a operator potwierdza właściwy. Skan jest ograniczony
 * (lista typowych ścieżek + płytka rekursja), żeby nie mielić całego dysku.
 */

import fs from 'node:fs'
import path from 'node:path'

const NAME_RE = /eco|edi|import|wymian|zamow|integr|wapro/i
const MAX_DEPTH = 2
const MAX_RESULTS = 40

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function scanShallow(root, depth, out) {
  if (depth < 0 || out.size >= MAX_RESULTS) return
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.size >= MAX_RESULTS) break
    if (!e.isDirectory()) continue
    const full = path.join(root, e.name)
    if (NAME_RE.test(e.name)) out.add(full)
    if (depth > 0) scanShallow(full, depth - 1, out)
  }
}

/** @returns {string[]} lista istniejących folderów-kandydatów. */
export function findEcoFolders() {
  const env = process.env
  const out = new Set()

  const roots = [
    'C:\\WAPRO',
    'C:\\Program Files\\WAPRO',
    'C:\\Program Files (x86)\\WAPRO',
    'C:\\Asseco',
    'C:\\ECO',
    'C:\\EDI',
    'C:\\Wymiana',
    'C:\\WAPRO\\ECO',
    'C:\\WAPRO\\EDI',
    'D:\\WAPRO',
    'D:\\ECO',
    'D:\\EDI',
    env.ProgramData ? path.join(env.ProgramData, 'WAPRO') : null,
    env.ProgramData ? path.join(env.ProgramData, 'Asseco') : null,
    env.PUBLIC ? path.join(env.PUBLIC, 'Documents') : null,
    env.USERPROFILE ? path.join(env.USERPROFILE, 'Documents') : null
  ].filter(Boolean)

  // 1) roots pasujące nazwą i istniejące
  for (const r of roots) if (isDir(r) && NAME_RE.test(path.basename(r))) out.add(r)
  // 2) płytki skan pod istniejącymi rootami
  for (const r of roots) if (isDir(r)) scanShallow(r, MAX_DEPTH, out)

  return [...out].slice(0, MAX_RESULTS)
}
