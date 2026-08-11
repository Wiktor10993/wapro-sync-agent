# Test lokalny na Macu (Apple Silicon) — od zera do działającej synchronizacji

Cel: mieć **100% pewności**, że silnik zadziała u klienta — testujemy na lokalnym
SQL Serverze z realistyczną strukturą i danymi WFMag (branża wędkarska).

## 0. Wymagania

- **Docker Desktop** (dla Apple Silicon).
- **Node 18+** (`node -v`).
- **VS Code** (do debugowania).
- Terminal w katalogu `desktop_agent/`.

## 1. Postaw lokalną bazę (Docker, arm64)

```bash
cd desktop_agent
docker compose -f testing/docker-compose.yml up -d
# (albo: npm run db:up)
docker ps            # kontener wapro-mssql-test powinien być "Up"
docker logs -f wapro-mssql-test   # poczekaj na "SQL Server is now ready" (~20-40s)
```

Obraz `azure-sql-edge` ma natywny arm64 — rusza bez emulacji. Hasło SA:
`Wapro_Test_123!` (port `1433`).

> Fallback: gdyby `azure-sql-edge` był u Ciebie niedostępny (Microsoft go wygasza),
> użyj pełnego SQL Servera przez Rosetta — w `docker-compose.yml` podmień obraz na
> `mcr.microsoft.com/mssql/server:2022-latest` i `platform: linux/amd64`. Reszta bez zmian.

## 2. Załóż schemat i wgraj dane testowe

```bash
npm install                      # m.in. mssql + typy + vitest
node testing/seed.mjs            # (albo: npm run db:seed)
```

Skrypt tworzy bazę `WAPRO`, tabele `ARTYKUL`, `KOD_KRESKOWY`, `MAGAZYN` oraz
`INTEG.INTEG_LOG_SYNC`, a potem wgrywa **15 artykułów** (woblery, kulki proteinowe,
kołowrotki). Na końcu wypisze `widoczne_pozycje = 14` (jeden jest `ZABLOKOWANY`).

Konfiguracja połączenia dla seeda (domyślne pasują do dockera):
```bash
MSSQL_HOST=localhost MSSQL_PORT=1433 MSSQL_USER=sa MSSQL_PASSWORD='Wapro_Test_123!' node testing/seed.mjs
```

## 3. Uruchom agenta i wskaż lokalną bazę

```bash
npm run dev
```

W aplikacji → **Ustawienia Bazy**:
- Host: `localhost`  (albo `127.0.0.1`)
- Port: `1433`
- Baza: `WAPRO`
- Użytkownik: `sa`
- Hasło: `Wapro_Test_123!`
- ✅ „Ufaj certyfikatowi serwera" (TLS zostaw wyłączony)

Kliknij **„Testuj połączenie"** → zielone. Potem **„Sprawdź schemat"** → powinno
pokazać `ARTYKUL` (produkty i stany) oraz `MAGAZYN` na zielono (domyślne v3 pasują
do naszego schematu — nic nie mapujesz ręcznie).

**„Podejrzyj stany z Wapro"** → lista **14 pozycji**. Zwróć uwagę:
- „HIT! Wobler Salmo Perch 8cm …" → stan **10** (12 − 2 rezerwacji),
- „Podbierak Delphin Omega Carp" → stan **0** (3 − 3 rezerwacji),
- „ARCHIWALNY …" → **nie ma go** (ZABLOKOWANY).

To potwierdza odczyt + `STAN - ZAREZERWOWANO` + filtr blokady na żywej bazie.

## 4. Testy silnika dopasowań (Vitest)

```bash
npx vitest run src/sync-engine
# albo: npm test
```

Sprawdza: normalizację nazw (usuwanie „HIT/GRATIS", polskich znaków), poziomy
EAN → SKU → nazwa, ochronę po parametrze (2kg vs 5kg / 16mm vs 20mm) oraz
`NEEDS_REVIEW` przy niejednoznaczności. Dane w teście odwzorowują nasz seed.

Które pozycje testują który poziom (do ręcznego przeklikania z prawdziwym kanałem):
| Pozycja (Wapro) | Poziom | Dlaczego |
|---|---|---|
| Wobler Salmo Perch 8cm (EAN 5901234000018) | 1 | dopasowanie po EAN |
| MEGA Wobler Rapala CountDown 7cm (brak EAN) | 2 | tylko SKU `RAP-CD-07S` |
| Wobler Jaxon Karaś 5cm (brak EAN/SKU) | 3 | tylko nazwa (po normalizacji) |
| Kulki Truskawka 16mm vs 20mm vs 24mm | guard | ten sam produkt, różny parametr → nie mylimy |
| Kulki Wanilia 20mm vs Wanilla 20mm | review | near-duplikat → `NEEDS_REVIEW` |

## 5. Debugowanie całego procesu w VS Code

1. Skopiuj `testing/vscode-launch.json` → `desktop_agent/.vscode/launch.json`.
2. Skopiuj `testing/.env.example` → `testing/.env` (dostosuj, jeśli trzeba).
3. Ustaw breakpointy w kluczowych miejscach:
   - `src/sync-engine/orchestrator.ts` — pętla delty i wysyłka paczek,
   - `src/sync-engine/db/waproRepository.ts` — `getPool()` / `fetchStockSnapshot()` (pula, NOLOCK),
   - `src/sync-engine/sync/batchRunner.ts` — `withRetry()` (429/backoff),
   - `src/sync-engine/sync/loopGuard.ts` — `filterEchoes()`.
4. F5 → **„Debug: Electron Main"**. Wykonaj ręczną synchronizację w UI i śledź:
   - czy pula połączeń jest reużywana (jeden `ConnectionPool`, nie N),
   - czy delta zawiera tylko zmienione pozycje,
   - czy paczki idą z opóźnieniem (throttling), a 429 są ponawiane,
   - czy loop guard tłumi echa.

Dla samych błędów asynchroniczności/puli najwygodniej: **„Debug: Seed"** (izolowany
`mssql`) — łapiesz problemy połączenia bez całego Electrona.

## 6. Sprawdź delta-sync, loop guard i dziennik

**Delta:** po pierwszej synchronizacji zmień jeden stan w bazie i ponów:
```sql
UPDATE WAPRO.dbo.ARTYKUL SET STAN = 99 WHERE INDEKS_KATALOGOWY = 'KP-TRU-16';
```
Druga synchronizacja powinna przetworzyć **1 pozycję** (nie 14) — to delta.

**Loop guard:** ponów synchronizację od razu drugi raz bez zmian w bazie → 0 wysyłek
(echo/idempotencja).

**Dziennik:** zakładka **„Dziennik"** w aplikacji (filtr po SKU/statusie) albo:
```sql
SELECT TOP 50 TS, CHANNEL, SKU, EAN, STATUS, MESSAGE
FROM WAPRO.INTEG.INTEG_LOG_SYNC WITH (NOLOCK) ORDER BY TS DESC;
```

## 6a. Symulacja Stateful Sync + Action Center (na żywo)

Po skonfigurowaniu bazy i „Podejrzyj stany":

1. Wejdź w zakładkę **„Problemy"**.
2. Kliknij **„Skanuj WAPRO (scenariusz C)"** — orchestrator ładuje lokalny bufor
   SQLite z bazy i próbuje wysłać stany na kanały. Bez skonfigurowanych kluczy
   BaseLinker/Allegro zobaczysz w podzakładce **„Niezmapowane produkty"** pozycje,
   których automat nie dopasował (to jest oczekiwane — Fuzzy Matching zadziała, gdy
   podłączysz realne oferty kanału).
3. W panelu **„Niezmapowane produkty"** przetestuj ręczne łączenie: wybierz kanał,
   wpisz ID oferty (lub EAN) i kliknij **„Połącz"** — mapowanie zapisze się na stałe
   w `sync-buffer.db`.
4. **Scenariusz A/B (sprzedaż z kanału):** w pasku „Symulacja" wybierz kanał, wpisz
   SKU (np. `KP-TRU-16`) i nowy stan (np. `20`), kliknij **„Symuluj sprzedaż"**.
   Sprawdź:
   - stan w buforze zszedł,
   - w `INTEG.WAPRO_DELTA_BUFOR` pojawił się wpis (rezerwacja/dokument do WAPRO):
     ```sql
     SELECT TOP 20 * FROM WAPRO.INTEG.WAPRO_DELTA_BUFOR ORDER BY TS DESC;
     ```
   - drugi kanał dostał aktualizację (albo błąd → podzakładka „Błędy synchronizacji").
5. **Loop Guard:** zaraz po symulacji sprzedaży kliknij ponownie „Skanuj WAPRO".
   Zmiana zainicjowana przez kanał **nie** powinna wywołać ponownej wysyłki tej samej
   delty (echo tłumione). To samo potwierdzają testy Vitest (`orchestrator.test.ts`).
6. **Błędy + Retry:** żeby zobaczyć kolejkę błędów, ustaw celowo zły token/ofertę
   kanału i zasymuluj sprzedaż — wpis „SKU X — błąd: …" trafi do „Błędy synchronizacji"
   z przyciskami **Ponów (Retry)** / **Ignoruj**.

> Uwaga: `better-sqlite3` to moduł natywny. Po `npm install` na Macu zwykle zbuduje
> się automatycznie; gdyby Electron zgłaszał niezgodność ABI, uruchom
> `npx electron-rebuild -f -w better-sqlite3` (lub `npm i -D @electron/rebuild`).

## 7. Zamknięcie / czyszczenie

```bash
docker compose -f testing/docker-compose.yml down          # zatrzymaj (dane zostają w wolumenie)
docker compose -f testing/docker-compose.yml down -v       # usuń też dane (czysty start)
```

## Troubleshooting

- **„Login failed for user 'sa'"** — kontener jeszcze wstaje (poczekaj) albo hasło
  nie spełnia polityki złożoności (musi mieć duże/małe/cyfrę/znak — nasze spełnia).
- **„Cannot connect / ECONNREFUSED"** — sprawdź `docker ps` i port 1433; upewnij się,
  że w GUI wyłączony jest „Szyfruj (TLS)" i włączony „Ufaj certyfikatowi".
- **Puste stany / błąd kolumn** — kliknij „Sprawdź schemat"; przy naszym seedzie
  domyślny profil v3 (ARTYKUL/ARTYKUL/MAGAZYN) pasuje bez mapowania.
- **Wolno / timeouty przy dużych danych** — to test batchingu; zwiększ `delayMs`
  albo zmniejsz `batchSize` w konfiguracji orchestratora.
- **azure-sql-edge nie startuje na arm64** — użyj fallbacku z sekcji 1.
