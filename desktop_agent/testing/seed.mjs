/**
 * Seed lokalnej bazy testowej WAPRO — uruchamia 01_schema.sql i 02_seed.sql.
 * Używa sterownika `mssql` (już w projekcie), więc nie potrzeba sqlcmd.
 *
 *   node testing/seed.mjs
 *
 * Konfiguracja przez zmienne środowiskowe (domyślne = docker-compose):
 *   MSSQL_HOST=localhost MSSQL_PORT=1433 MSSQL_USER=sa MSSQL_PASSWORD='Wapro_Test_123!'
 */
import sql from 'mssql'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const config = {
  server: process.env.MSSQL_HOST || 'localhost',
  port: Number(process.env.MSSQL_PORT || 1433),
  user: process.env.MSSQL_USER || 'sa',
  password: process.env.MSSQL_PASSWORD || 'Wapro_Test_123!',
  database: 'master',
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  pool: { max: 2, min: 0, idleTimeoutMillis: 15000 }
}

/** Dzieli skrypt na paczki po liniach zawierających tylko GO. */
function splitBatches(sqlText) {
  return sqlText
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
}

async function runFile(pool, relPath) {
  const text = readFileSync(join(__dirname, relPath), 'utf8')
  const batches = splitBatches(text)
  console.log(`\n▶ ${relPath} — ${batches.length} paczek`)
  for (let i = 0; i < batches.length; i++) {
    try {
      const res = await pool.request().query(batches[i])
      if (res.recordset?.length) console.table(res.recordset)
    } catch (err) {
      console.error(`✖ Paczka ${i + 1} w ${relPath}:`, err.message)
      throw err
    }
  }
  console.log(`✓ ${relPath} OK`)
}

async function main() {
  console.log(`Łączę z ${config.server}:${config.port} jako ${config.user}…`)
  const pool = await new sql.ConnectionPool(config).connect()
  try {
    await runFile(pool, 'sql/01_schema.sql')
    await runFile(pool, 'sql/02_seed.sql')
    console.log('\n✅ Baza testowa WAPRO gotowa.')
  } finally {
    await pool.close()
  }
}

main().catch((err) => {
  console.error('\n❌ Seed nie powiódł się:', err.message)
  process.exit(1)
})
