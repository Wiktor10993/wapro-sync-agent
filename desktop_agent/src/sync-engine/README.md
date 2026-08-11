# sync-engine — moduł raportowania, dopasowań i ochrony przed bottleneckami

Samodzielny moduł TypeScript dla integratora **WAPRO Mag ⇄ BaseLinker / Allegro**.
Nie zmienia istniejącego kodu JS — dokładasz go i podpinasz. Kompiluje się przez
`electron-vite` (esbuild ściąga typy).

## Zawartość

```
sync-engine/
  types.ts                     # wspólne typy (StockRow, MatchResult, SyncSummary, SyncLogEntry…)
  matching/
    normalize.ts               # normalizacja nazw (PL, szum marketingowy, parametry, Levenshtein/Jaccard)
    productMatcher.ts          # PUNKT 1: EAN → SKU → nazwa + próg pewności (NEEDS_REVIEW)
  sync/
    deltaSync.ts               # PUNKT 5: delta po hashach (tylko zmiany)
    batchRunner.ts             # PUNKT 5: batching + throttling + retry (429/5xx/timeout)
    loopGuard.ts               # PUNKT 5: ochrona przed pętlą zwrotną + blokada nakładania cykli
  channels/
    baselinkerClient.ts        # PUNKT 4: czyste ID (bez „bl_"), batch + retry, ERROR_STORAGE_ID
  db/
    waproRepository.ts         # PUNKT 5: pula mssql + odczyt z WITH (NOLOCK) + transakcje
    syncLog.ts                 # PUNKT 3: INTEG_LOG_SYNC (bulk insert + filtrowanie/wyszukiwanie)
  ui/
    SyncSummaryModal.tsx       # PUNKT 2: modal podsumowania cyklu
    AuditLogTab.tsx            # PUNKT 3: zakładka dziennika z filtrami
  orchestrator.ts              # spina wszystko → zwraca SyncSummary
  __tests__/productMatcher.test.ts
```

## Jak to działa razem (orchestrator)

```ts
import { WaproRepository } from './sync-engine/db/waproRepository'
import { SyncLog } from './sync-engine/db/syncLog'
import { BaselinkerClient } from './sync-engine/channels/baselinkerClient'
import { LoopGuard } from './sync-engine/sync/loopGuard'
import { runInventorySync, type ChannelAdapter } from './sync-engine/orchestrator'
import type { OfferCandidate } from './sync-engine/types'

const wapro = new WaproRepository(dbConfig)          // pula + NOLOCK
const log = new SyncLog(() => wapro.getPool())        // INTEG_LOG_SYNC
await log.ensureSchema()
const bl = new BaselinkerClient({ token, inventoryId: 111510, warehouseId: '0' }) // czyste ID
const loopGuard = new LoopGuard()                     // współdzielony między cyklami

// Adapter BaseLinkera dla orchestratora:
const baselinkerAdapter: ChannelAdapter = {
  channel: 'baselinker',
  async fetchOffers(): Promise<OfferCandidate[]> {
    const out: OfferCandidate[] = []
    for (let page = 1; page <= 100; page++) {
      const products = await bl.getInventoryProductsList(page)
      const ids = Object.keys(products)
      if (!ids.length) break
      for (const [id, p] of Object.entries<any>(products)) {
        out.push({ offerId: String(id), sku: String(p.sku ?? ''), ean: String(p.ean ?? ''), name: String(p.name ?? '') })
      }
      if (ids.length < 1000) break
    }
    return out
  },
  async pushStock(items, batchOptions) {
    const sent = await bl.updateInventoryProductsStock(
      items.map((i) => ({ productId: i.offerId, variantId: i.variantId, quantity: i.quantity })),
      batchOptions
    )
    // BaseLinker aktualizuje paczkę atomowo — uznajemy wszystkie za zaktualizowane.
    return { updatedOfferIds: new Set(items.slice(0, sent).map((i) => String(i.offerId))) }
  }
}

const summary = await runInventorySync(baselinkerAdapter, {
  loadSnapshot: () => wapro.fetchStockSnapshot({ articleTable: 'ARTYKUL' }),
  loadHashes: async () => store.get('cache.stockHashesBaselinker') ?? {},
  saveHashes: async (h) => store.set('cache.stockHashesBaselinker', h),
  writeLog: (entries) => log.insertMany(entries),
  loopGuard
}, {
  matcher: { nameThreshold: 0.82, nameMargin: 0.08 },
  batch: { batchSize: 500, delayMs: 300, retries: 4 }
})

// summary → wyślij do renderera i pokaż <SyncSummaryModal summary={summary} .../>
```

## Podpięcie UI (renderer)

```tsx
// Po zakończeniu cyklu (IPC zwraca SyncSummary):
<SyncSummaryModal summary={summary} onClose={() => setSummary(null)} />

// Zakładka dziennika — queryLogs wywołuje IPC → SyncLog.query():
<AuditLogTab queryLogs={(f) => window.agent.queryAuditLog(f)} />
```

## Zabezpieczenia przed wąskimi gardłami (PUNKT 5) — gdzie

| Ryzyko | Rozwiązanie | Plik |
|---|---|---|
| 16k pozycji w pętli, 429 Too Many Requests | batching + delay + concurrency + retry z backoffem i `Retry-After` | `sync/batchRunner.ts`, `channels/baselinkerClient.ts` |
| Mielenie całej bazy co cykl | delta po hashach — tylko zmiany; hashe zatwierdzane wyłącznie dla wysłanych | `sync/deltaSync.ts` |
| Pętla zwrotna (echo sprzedaży) | idempotencja + cooldown + globalna blokada przebiegu; ERP jedynym źródłem prawdy | `sync/loopGuard.ts` |
| Blokowanie pracowników w Wapro | pula `mssql` + `WITH (NOLOCK)` na odczytach + jawne transakcje na zapisach | `db/waproRepository.ts` |
| ERROR_STORAGE_ID | ID katalogu/magazynu wprost z konfiguracji, bez doklejania „bl_" | `channels/baselinkerClient.ts` |

## Testy

```bash
npm i -D vitest
npx vitest run src/sync-engine
```

## Wymagania środowiska
- Node 18+ (globalny `fetch`, `AbortSignal.timeout`).
- Pakiety: `mssql` (jest), typy `@types/mssql`, `@types/react` (devDependencies) do pełnego type-checku w IDE. Do samego builda esbuild ich nie wymaga.
- `tsconfig.json`: `"jsx": "react-jsx"`, `"moduleResolution": "bundler"` (lub „node16"), `"strict": true`.
