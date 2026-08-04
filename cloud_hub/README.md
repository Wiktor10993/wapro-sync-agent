# Cloud Hub

Serwer pośredniczący między lokalnym agentem Wapro a kanałami sprzedaży
(Allegro, BaseLinker). PHP 8.1+ i SQLite, bez Composera — własny autoloader PSR-4.

Folder jest samowystarczalny: nie odwołuje się do niczego poza swoim drzewem.

---

## Szybki start (macOS / Linux)

```bash
cd ~/Desktop/projekt_test/cloud_hub

cp dev.env.example dev.env      # uzupełnij, jeśli masz konta Allegro/BaseLinker
source dev.env

php bin/migrate.php                          # utworzenie schematu bazy
php bin/create_admin.php dev admin           # konto do panelu (zapyta o hasło)
php bin/register_agent.php dev "Mac dev"     # klucz API — ZAPISZ, pokazany raz
php bin/seed_demo.php dev --orders=2         # dane demo bez kont zewnętrznych

php -S localhost:8000 -t public
```

Panel: **http://localhost:8000/admin** · API health: `curl localhost:8000/api/health`

Skrót do trzech pierwszych kroków: `./start-dev.sh`

---

## Wymagania

```bash
php -v                       # 8.1 lub wyżej
php -m | grep -E 'pdo_sqlite|curl'   # oba muszą być
```

Brakuje rozszerzeń? `brew reinstall php` (macOS) — nie kompiluj ręcznie.

---

## Struktura

```
cloud_hub/
├── bin/                      skrypty CLI i zadania cron
│   ├── migrate.php               schemat bazy (uruchom pierwszy)
│   ├── create_admin.php          konto do panelu
│   ├── register_agent.php        klucz API dla agenta desktopowego
│   ├── seed_demo.php             dane testowe bez kont Allegro/BaseLinker
│   ├── poll_allegro_events.php   cron: nasłuch zamówień Allegro
│   ├── poll_baselinker_orders.php cron: zapasowe pobieranie z BaseLinkera
│   ├── sync_sku_map.php          cron: odświeżanie mapowań SKU
│   └── prune_logs.php            cron: sprzątanie starych danych
│
├── config/config.php         konfiguracja (czyta zmienne środowiskowe)
│
├── public/                   ← DocumentRoot serwera WWW
│   ├── index.php                 front controller (API + panel + webhook)
│   ├── .htaccess                 przepisywanie URL dla Apache
│   └── assets/admin.css          style panelu
│
├── src/
│   ├── autoload.php              autoloader PSR-4 dla przestrzeni Hub\
│   ├── Database.php              schemat + wersjonowane migracje
│   ├── Admin/                    panel: Controller, View, 9 widoków
│   ├── Clients/                  HttpClient, AllegroClient, BaseLinkerClient
│   ├── Handlers/                 baselinker_webhook.php
│   ├── Http/                     Request, Response
│   ├── Security/                 AgentAuth (agenci), AdminAuth (panel)
│   ├── Services/                 AntiLoop, InventoryDispatcher, OrderQueue,
│   │                             SkuMapService, AllegroOAuth, TenantSettings
│   └── Support/                  Logger, JobRunner
│
├── storage/                  baza SQLite i logi (poza public/ — celowo)
├── przyklady/                nginx.conf, wzór CSV mapowań
├── dev.env.example           zmienne dla środowiska deweloperskiego
└── .env.example              zmienne dla produkcji
```

---

## Endpointy

| Metoda | Ścieżka | Autoryzacja | Opis |
|---|---|---|---|
| `GET` | `/api/health` | brak | Monitoring |
| `POST` | `/api/sync-inventory` | klucz agenta | Przyjęcie stanów + push na kanały |
| `GET` | `/api/get-orders` | klucz agenta | Wydanie paczki zamówień |
| `POST` | `/api/ack-orders` | klucz agenta | Potwierdzenie zapisu w Wapro |
| `POST` | `/webhooks/baselinker` | HMAC `X-BL-Signature` | Odbiór sprzedaży |
| `GET` | `/oauth/allegro/callback` | jednorazowy `state` | Powrót z autoryzacji |
| `*` | `/admin/*` | sesja panelu | Interfejs webowy |

Agent uwierzytelnia się nagłówkiem `Authorization: Bearer <api_key>`.
W bazie trzymany jest wyłącznie HMAC-SHA256 klucza.

`POST /api/sync-inventory` zwraca **207**, gdy część kanałów zawiodła —
agent wie wtedy, że ma ponowić.

---

## Zadania cron (produkcja)

```cron
*   * * * *  php /sciezka/cloud_hub/bin/poll_allegro_events.php     firma-abc
*/5 * * * *  php /sciezka/cloud_hub/bin/poll_baselinker_orders.php  firma-abc
0   3 * * *  php /sciezka/cloud_hub/bin/sync_sku_map.php            firma-abc both
15  3 * * *  php /sciezka/cloud_hub/bin/prune_logs.php              firma-abc 30
```

Każde zadanie ma lock plikowy (przebiegi się nie nakładają) i zapisuje wynik
do tabeli `job_runs`, widocznej w panelu.

---

## Wdrożenie produkcyjne

1. DocumentRoot **musi** wskazywać na `public/`. Katalog `storage/` z bazą
   leży poziom wyżej i nie może być osiągalny przez HTTP.
2. Ustaw `HUB_API_KEY_PEPPER` na własny sekret (`openssl rand -hex 32`).
   Zmiana tej wartości unieważnia wszystkie istniejące klucze agentów.
3. Skonfiguruj HTTPS — bez niego klucz API leci otwartym tekstem.
4. Przykładowa konfiguracja: `przyklady/nginx.conf`; dla Apache — `public/.htaccess`.

---

## Rozwiązywanie problemów

| Objaw | Przyczyna | Rozwiązanie |
|---|---|---|
| `unable to open database file` | brak katalogu albo złe uprawnienia | `mkdir -p storage && chmod 700 storage`, sprawdź `echo $HUB_DB_PATH` |
| `Nieprawidłowy lub brakujący klucz API` | agent ma stary klucz albo zmieniono pepper | wygeneruj klucz na nowo w panelu → Agenci |
| Panel przestaje reagować w trakcie synchronizacji | `php -S` jest jednowątkowy | normalne w trybie dev, poczekaj |
| `Brak tokenu Allegro` | nie przeszedł OAuth | panel → Ustawienia → Połącz konto Allegro |
| Webhook odrzucany (401) | niezgodny podpis | sprawdź `HUB_BL_WEBHOOK_SECRET` po obu stronach |

Logi: `storage/hub.log` (ścieżka z `HUB_LOG_PATH`).
