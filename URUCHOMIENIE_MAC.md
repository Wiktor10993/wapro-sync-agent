# Uruchomienie deweloperskie na macOS — krok po kroku

Instrukcja zakłada, że nie masz jeszcze nic zainstalowanego poza systemem.
Każde polecenie można skopiować i wkleić do Terminala.

Czas: około 40 minut, z czego 20 to pobieranie obrazu SQL Servera.

---

## Gdzie ma leżeć projekt

Cała paczka trafia na Pulpit:

```
~/Desktop/projekt_test/
├── cloud_hub/            backend PHP + panel + baza SQLite
├── desktop_agent/        aplikacja Electron/React
├── nasluch_wapro/        (utworzysz w kroku 2) folder na pliki ECO
├── README.md             opis całości
└── URUCHOMIENIE_MAC.md   ten plik
```

Sprawdź, czy wszystko jest na miejscu:

```bash
ls ~/Desktop/projekt_test
# cloud_hub  desktop_agent  README.md  URUCHOMIENIE_MAC.md
```

Oba podfoldery są **niezależne** — mają własne README, własne zależności
i nie odwołują się do niczego poza swoim drzewem.

---

## 0. Co będzie potrzebne

| Narzędzie | Do czego | Skąd |
|---|---|---|
| Homebrew | instalator reszty | https://brew.sh |
| PHP 8.1+ | Cloud Hub | `brew install php` |
| Node.js 18+ | Desktop Agent | `brew install node` |
| Docker Desktop | SQL Server dla atrapy Wapro | https://www.docker.com/products/docker-desktop |
| sqlcmd | ładowanie skryptów SQL | `brew install sqlcmd` |

Instalacja jednym poleceniem (Homebrew musi już być):

```bash
brew install php node sqlcmd
```

Sprawdzenie wersji:

```bash
php -v      # oczekiwane 8.1 lub wyżej
node -v     # oczekiwane v18 lub wyżej
```

PHP z Homebrew ma `pdo_sqlite` i `curl` włączone domyślnie. Sprawdź na wszelki wypadek:

```bash
php -m | grep -E 'pdo_sqlite|curl'
# powinno wypisać: curl, pdo_sqlite
```

Jeśli któregoś brakuje — nie kombinuj z kompilacją, po prostu `brew reinstall php`.

---

## 1. Cloud Hub — serwer PHP + baza SQLite

### 1.1. Przygotuj katalog na bazę i logi

To jest ten moment, w którym najczęściej wysypuje się na uprawnieniach. Klucz:
**baza musi leżeć poza `public/`**, a katalog musi być zapisywalny dla użytkownika,
który uruchamia PHP (czyli dla Ciebie, nie dla `www-data`).

```bash
cd ~/Desktop/projekt_test/cloud_hub

mkdir -p storage
chmod 700 storage     # tylko Ty — wystarczy i jest bezpiecznie
```

Katalog `storage/` jest już w paczce, ale `mkdir -p` nie zaszkodzi.

Dlaczego `700`, a nie `777`: na Macu serwer deweloperski (`php -S`) działa na Twoim
koncie, więc `777` niczego nie naprawia, a tylko otwiera plik dla wszystkich.
Jeśli mimo to dostaniesz „unable to open database file", sprawdź **właściciela katalogu**:

```bash
ls -ld storage
# drwx------  ...  twoj_login  staff  ...   ← tak ma być
```

> **Projekt leży na Pulpicie — jedna uwaga o macOS.** Przy pierwszym poleceniu
> odczytującym pliki z Pulpitu system pokaże okienko „Terminal chce uzyskać dostęp
> do plików w folderze Pulpit". **Kliknij „Zezwól".** Jeśli przez pomyłkę odmówisz,
> dostaniesz `Operation not permitted` — napraw to w
> *Ustawienia systemowe → Prywatność i ochrona → Pliki i foldery → Terminal*.

### 1.2. Zmienne środowiskowe

Gotowy szablon jest w paczce — wystarczy go skopiować:

```bash
cp dev.env.example dev.env
```

Wczytaj zmienne (musisz to robić w **każdym** nowym oknie Terminala):

```bash
source dev.env
```

Do testów bez kont Allegro i BaseLinkera nie musisz w nim niczego zmieniać.

> Puste `ALLEGRO_*` i `BASELINKER_*` są w porządku — na tym etapie testujemy
> bez prawdziwych kont. Skrypt `seed_demo.php` podstawi zamówienia sam.

### 1.3. Zainicjuj bazę

```bash
php bin/migrate.php
```

Oczekiwany wynik:

```
Baza: /Users/ty/Desktop/projekt_test/cloud_hub/storage/hub.sqlite
Wersja schematu: 2
Tabele: action_logs, admin_sessions, admin_users, agents, auth_tokens, inventory_state,
        job_runs, oauth_states, order_queue, schema_meta, sku_map, sync_cursors, tenant_settings
```

Weryfikacja, że plik faktycznie powstał i jest zapisywalny:

```bash
ls -l storage/hub.sqlite
# -rw-------  1 twoj_login  staff  ...  hub.sqlite

# Sanity check zawartości (opcjonalnie, sqlite3 jest w systemie):
sqlite3 storage/hub.sqlite ".tables"
```

**Gdy zobaczysz `unable to open database file`:**

1. Sprawdź, czy `$HUB_DB_PATH` wskazuje na istniejący katalog — `echo $HUB_DB_PATH`.
2. Sprawdź, czy zrobiłeś `source dev.env` w tym oknie Terminala.
3. Sprawdź, czy Terminal ma zgodę na dostęp do Pulpitu (patrz ramka wyżej) —
   `ls ~/Desktop/projekt_test` musi działać bez błędu.

### 1.4. Konto do panelu

```bash
php bin/create_admin.php dev admin
# poprosi o hasło (min. 10 znaków, nie będzie widoczne podczas wpisywania)
```

### 1.5. Klucz API dla agenta

```bash
php bin/register_agent.php dev "Mac deweloperski"
```

**Skopiuj wypisany klucz `wha_...` do notatnika** — nie zostanie pokazany ponownie.

### 1.6. Uruchom serwer

```bash
php -S localhost:8000 -t public
```

Ważne: `-t public` wskazuje katalog dokumentów. Bez tego katalog `storage/`
z bazą byłby dostępny przez HTTP.

Zostaw to okno otwarte. Sprawdź w drugim:

```bash
curl -s http://localhost:8000/api/health
# {"ok":true,"schema_version":2,"time":"2026-..."}
```

Panel: **http://localhost:8000/admin** — zaloguj się jako `admin`.

> Wbudowany serwer PHP jest jednowątkowy. To wystarcza do testów, ale gdy
> agent czeka na odpowiedź, panel w przeglądarce będzie chwilowo nie reagował.
> To normalne, nie szukaj błędu.

### Skrót: jedno polecenie zamiast kroków 1.1–1.6

Kroki 1.1, 1.2, 1.3 i 1.6 są zautomatyzowane skryptem:

```bash
cd ~/Desktop/projekt_test/cloud_hub
chmod +x start-dev.sh        # tylko raz
./start-dev.sh --seed        # migracja + dane demo + serwer
```

Skrypt sprawdza wersję PHP i rozszerzenia, tworzy `dev.env` z szablonu, zakłada
katalog `storage/` i przypomni, jeśli brakuje konta do panelu albo klucza agenta.
Konto i klucz nadal trzeba założyć ręcznie (kroki 1.4 i 1.5) — wymagają
interaktywnego podania hasła i zapisania klucza.

---

## 2. Desktop Agent — Electron

W nowym oknie Terminala:

```bash
cd ~/Desktop/projekt_test/desktop_agent

npm install          # pierwsze uruchomienie: 2–4 minuty
npm test             # 81 testów jednostkowych, powinny przejść w kilka sekund
npm run dev          # uruchamia aplikację z hot-reloadem
```

`npm run dev` otwiera okno aplikacji. Zmiany w plikach `src/renderer/` odświeżają
się natychmiast; zmiany w `src/main/` restartują proces główny automatycznie.

**Co może pójść nie tak:**

| Objaw | Przyczyna | Rozwiązanie |
|---|---|---|
| `Error: Cannot find module 'mssql'` | przerwana instalacja | `rm -rf node_modules package-lock.json && npm install` |
| Aplikacja startuje i od razu znika | brak uprawnień do zasobnika | Ustawienia systemowe → Prywatność → zezwól aplikacji Electron |
| Okno białe, konsola pusta | port Vite zajęty | zamknij poprzednią instancję: `pkill -f electron` |
| Ostrzeżenie o niepodpisanej aplikacji | brak certyfikatu dewelopera | normalne w trybie dev, zignoruj |

---

## 3. Baza MSSQL — czym zastąpić Wapro na Macu

### Rekomendacja: Docker, nie mock

Rozważałem tryb symulacji, ale **odradzam go jako główną ścieżkę**. Powód:
zdecydowana większość rzeczy, które mogą pójść źle u klientki, siedzi właśnie
w warstwie SQL — składnia `COALESCE(NULLIF(...))` dla SKU, `TOP (@limit)`
z parametrem, transakcje `mssql`, procedury składowane, zachowanie
`DECIMAL(18,4)`. Mock zamockuje dokładnie to, czego nie chcesz mockować.

Docker daje prawdziwy silnik SQL Server. Tryb `dry-run` w agencie zostaje jako
narzędzie do sprawdzania **danych**, nie połączenia.

### 3.1. Uruchom SQL Server w kontenerze

**Apple Silicon (M1/M2/M3/M4)** — SQL Server nie ma obrazu ARM, potrzebna emulacja.
Najpierw włącz Rosettę w Docker Desktop:

> Docker Desktop → Settings → General → zaznacz **Use Rosetta for x86_64/amd64
> emulation on Apple Silicon** → Apply & Restart

Potem:

```bash
docker run -d \
  --name wapro-mssql \
  --platform linux/amd64 \
  -e 'ACCEPT_EULA=Y' \
  -e 'MSSQL_SA_PASSWORD=DevHaslo123!' \
  -e 'MSSQL_PID=Developer' \
  -p 1433:1433 \
  mcr.microsoft.com/mssql/server:2022-latest
```

**Mac z procesorem Intel** — to samo bez `--platform`:

```bash
docker run -d --name wapro-mssql \
  -e 'ACCEPT_EULA=Y' -e 'MSSQL_SA_PASSWORD=DevHaslo123!' -e 'MSSQL_PID=Developer' \
  -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
```

Pierwsze uruchomienie pobiera ~1,5 GB. Poczekaj i sprawdź:

```bash
docker logs wapro-mssql 2>&1 | tail -5
# szukaj: "SQL Server is now ready for client connections"
```

Hasło musi mieć wielką literę, cyfrę i znak specjalny — inaczej kontener
wystartuje i natychmiast padnie.

### 3.2. Załaduj atrapę bazy Wapro

```bash
cd ~/Desktop/projekt_test/desktop_agent

sqlcmd -S localhost -U sa -P 'DevHaslo123!' -C -i przyklady/mock_wapro.sql
```

Flaga `-C` ufa certyfikatowi self-signed kontenera — bez niej dostaniesz błąd SSL.

Oczekiwany wynik na końcu: tabela z SKU i ilościami, m.in.:

```
SKU                NAZWA                            ILOSC
FARBA-BIALA-5L     Farba akrylowa biała 5 l         48.0000
KOSZULKA-L         Koszulka bawełniana — rozm. L    22.0000
SRUB-M8            Śruba M8x40 ocynkowana         1450.0000
TYLKO-HANDLOWY     Towar bez indeksu katalogowego    3.7500
WIERT-06           Wiertło do metalu HSS 6 mm      130.0000
```

Zwróć uwagę: `STARY-TOWAR` nie pojawia się (archiwalny), `TYLKO-HANDLOWY`
przyszedł przez `INDEKS_HANDLOWY`, a `3.7500` sprawdzi zaokrąglanie w dół do `3`.

### 3.3. Zatrzymanie i wznowienie

```bash
docker stop wapro-mssql     # kontener zachowuje dane
docker start wapro-mssql    # następnym razem tylko to
docker rm -f wapro-mssql    # całkowite usunięcie razem z danymi
```

### Wariant awaryjny bez Dockera

Jeśli Docker nie wchodzi w grę (np. brak miejsca), możesz przejść część
przepływu bez bazy:

- **SyncDown w trybie XML** działa bez MSSQL — agent tylko zapisuje pliki.
  Wystarczy nie klikać niczego, co dotyka bazy.
- Zakładki „Ustawienia Bazy" i „Zamówienia" będą zgłaszać błąd połączenia.
- Nie sprawdzisz introspekcji, dopasowania artykułów ani tabeli pośredniej.

To wystarczy do obejrzenia interfejsu, ale **nie zastąpi testu przed wyjazdem
do klientki**. Jeśli masz wybrać jedną rzecz do przetestowania na Dockerze —
niech to będzie tryb tabeli pośredniej z reflektorem.

---

## 4. Scenariusz testowy — pełne przejście zamówienia

Zakładamy: hub działa na `:8000`, kontener MSSQL wstał, agent uruchomiony
przez `npm run dev`.

### Krok 1 — dane demonstracyjne w hubie

```bash
cd ~/Desktop/projekt_test/cloud_hub
source dev.env
php bin/seed_demo.php dev --orders=2
```

Wstawia 7 mapowań SKU i 4 zamówienia (2 z Allegro, 2 z BaseLinkera). Dzięki temu
**nie potrzebujesz konta Allegro ani tokenu BaseLinkera**.

Sprawdź w panelu: **http://localhost:8000/admin** → Pulpit powinien pokazać
„4 zamówienia czeka" i „7 mapowań".

### Krok 2 — folder nasłuchu

```bash
mkdir -p ~/Desktop/projekt_test/nasluch_wapro
open ~/Desktop/projekt_test        # zostaw okno Findera otwarte
```

W realnym wdrożeniu to będzie folder, z którego Wapro wczytuje pliki ECO.
Tutaj po prostu obserwujesz, co się w nim pojawia.

### Krok 3 — agent: połączenie z bazą

Zakładka **Ustawienia Bazy**:

| Pole | Wartość |
|---|---|
| Host | `localhost` |
| Port | `1433` |
| Instancja | *(puste)* |
| Baza | `WAPRO_TEST` |
| Użytkownik | `sa` |
| Hasło | `DevHaslo123!` |
| Szyfruj połączenie | **odznaczone** |
| Ufaj certyfikatowi | **zaznaczone** |

1. Kliknij **Testuj połączenie** → oczekiwany komunikat z nazwą serwera i wersją.
2. Kliknij **Zapisz ustawienia**.
3. Kliknij **Sprawdź schemat** → powinno wyjść „Schemat zgodny".

> Gdyby introspekcja zgłosiła braki — to dokładnie ten mechanizm, który uratuje
> Cię u klientki. Tutaj ma przejść na zielono, bo atrapa używa domyślnych nazw.

### Krok 4 — agent: połączenie z hubem

Zakładka **Konto Cloud**:

- Adres: `http://localhost:8000`
- Klucz API: wklej `wha_...` z kroku 1.5
- **Zapisz**, potem **Sprawdź połączenie** → „Hub odpowiada, wersja schematu 2".

Ostrzeżenie o braku HTTPS przy `localhost` się nie pojawi — jest wyciszone
dla adresów lokalnych.

### Krok 5 — agent: konfiguracja synchronizacji

Zakładka **Synchronizacja**:

1. **Wczytaj listę magazynów** → zaznacz `MAG` i `SKL` (pomiń `REKL`).
2. Zostaw zaznaczone: odejmowanie rezerwacji, pomijanie archiwalnych, sumowanie magazynów.
3. Tryb zapisu zamówień: **Tabela pośrednia w bazie Wapro**.
4. Zaznacz **Generuj z bufora pliki XML** i wskaż folder `~/Desktop/projekt_test/nasluch_wapro`.
5. Odstęp eksportu z bufora: `5` minut.
6. **Zapisz ustawienia**.

### Krok 6 — test stanów (SyncUp)

Zakładka **Dashboard**:

1. **Podejrzyj stany z Wapro** → powinieneś zobaczyć 7 pozycji, w tym
   `TYLKO-HANDLOWY` ze stanem `3` (zaokrąglone w dół z 3,75).
2. **Wyślij stany teraz**.

W logu agenta: `SyncUp: odczytano 7 pozycji` → `wysłano 7 pozycji`.
Zobaczysz też ostrzeżenie o SKU bez mapowania (`TYLKO-HANDLOWY`, `STARY-TOWAR`) —
to poprawne zachowanie, nie błąd.

W panelu huba → **Logi akcji**: siedem wpisów `outbound / wapro_agent / ok`.
Kanały zwrócą błąd, bo nie ma tokenów — to oczekiwane. Sprawdzasz tu ścieżkę
danych, nie integrację z Allegro.

**Test Anti-Loop:** kliknij **Wyślij stany teraz** drugi raz.
Log powinien pokazać `SyncUp: brak zmian — nic nie wysyłam`. To dowód, że
deduplikacja działa.

### Krok 7 — test zamówień (SyncDown)

Zakładka **Zamówienia**:

1. Jeśli widzisz komunikat o braku schematu → **Utwórz schemat**.
2. **Symulacja zapisu (bez zmian w bazie)** → zobaczysz rozpisane pozycje
   z dopasowaniem. Pozycja „Towar spoza kartoteki" pokaże `brak w kartotece` —
   tak ma być.

Wróć na **Dashboard** → **Pobierz zamówienia teraz**.

W logu: `SyncDown: otrzymano 4 zamówień` → `zapisano ...` → `Reflektor: ...`.

### Krok 8 — sprawdź rezultat

Wróć na zakładkę **Zamówienia** → **Odśwież**:

- Kafelki: `0` czeka na eksport, `4` wyeksportowane.
- Tabela: 4 wiersze ze statusem `WYEKSPORTOWANE`, kolumna „Pozycji" z ostrzeżeniem
  `⚠ 1` przy zamówieniach z Allegro (ten towar spoza kartoteki).

W Finderze w folderze `nasluch` powinny leżeć cztery pliki:

```
allegro_1_ALLEGRO-DEMO-ALLEGRO-1.xml
allegro_2_ALLEGRO-DEMO-ALLEGRO-2.xml
baselinker_3_BL-DEMO-BL-1.xml
baselinker_4_BL-DEMO-BL-2.xml
```

Otwórz jeden z nich. Sprawdź, czy:

- `<ID_ARTYKULU>` jest wypełnione dla znanych towarów, puste dla nieznanego,
- polskie znaki są poprawne (`Śruba`, nie `Åšruba`),
- `<DOPASOWANIE>` pokazuje `OK` / `BRAK_ARTYKULU`.

Weryfikacja w bazie:

```bash
sqlcmd -S localhost -U sa -P 'DevHaslo123!' -C -d WAPRO_TEST -Q \
"SELECT ID_INTEGRACJA, ZRODLO, NUMER_OBCY, STATUS, PLIK_XML FROM integracja.ZAMOWIENIA"
```

### Krok 9 — symulacja wciągnięcia przez Wapro

W realnym wdrożeniu to zrobi ERP. Tutaj wywołaj procedurę ręcznie:

```bash
sqlcmd -S localhost -U sa -P 'DevHaslo123!' -C -d WAPRO_TEST -Q \
"EXEC integracja.SP_OZNACZ_PRZETWORZONE @ID_INTEGRACJA=1, @NUMER_DOKUMENTU='ZO/1/2026'"
```

Odśwież zakładkę **Zamówienia** → pierwszy wiersz ma status `PRZETWORZONE`
i numer dokumentu. Pełny cykl domknięty.

### Krok 10 — test idempotencji

To najważniejszy test przed wyjazdem. Kliknij **Pobierz zamówienia teraz**
jeszcze raz.

Oczekiwane: `SyncDown: brak nowych zamówień`. Żadnych nowych plików, żadnych
duplikatów w buforze. Jeśli pojawi się piąty plik — zatrzymaj się i zgłoś to,
zanim pojedziesz do klientki.

Dodatkowo: usuń jeden plik XML z folderu i kliknij **Eksportuj teraz**
w zakładce Zamówienia. Plik **nie** powinien się odtworzyć — zamówienie ma już
status `WYEKSPORTOWANE`. Żeby wymusić ponowny eksport, cofnij status:

```bash
sqlcmd -S localhost -U sa -P 'DevHaslo123!' -C -d WAPRO_TEST -Q \
"UPDATE integracja.ZAMOWIENIA SET STATUS='NOWE' WHERE ID_INTEGRACJA=2"
```

---

## 5. Ściągawka — codzienne uruchamianie

Trzy okna Terminala:

```bash
# Okno 1 — hub
cd ~/Desktop/projekt_test/cloud_hub && source dev.env && php -S localhost:8000 -t public

# Okno 2 — agent
cd ~/Desktop/projekt_test/desktop_agent && npm run dev

# Okno 3 — baza (raz na sesję)
docker start wapro-mssql
```

Reset do stanu początkowego:

```bash
cd ~/Desktop/projekt_test/cloud_hub && source dev.env
php bin/seed_demo.php dev --reset --orders=2

sqlcmd -S localhost -U sa -P 'DevHaslo123!' -C -d WAPRO_TEST -Q \
"DELETE FROM integracja.ZAMOWIENIA_POZYCJE; DELETE FROM integracja.ZAMOWIENIA;"

rm -f ~/Desktop/projekt_test/nasluch_wapro/*.xml
```

W agencie dodatkowo: Dashboard → **Wymuś pełną resynchronizację** (czyści pamięć hashy).

---

## 6. Czego ten test NIE sprawdza

Bądź tego świadomy, planując wizytę u klientki:

- **Prawdziwe nazwy kolumn Wapro** — atrapa używa nazw z domyślnego profilu.
  Na miejscu pierwsze, co robisz, to „Sprawdź schemat".
- **Rzeczywisty format XML ECO** — porównaj plik wygenerowany przez agenta
  z eksportem z instalacji klientki (*Wapro Mag → Narzędzia → Eksport ECO*)
  i skoryguj `ecoXml.js`, jeśli nazwy elementów się różnią.
- **Czy Wapro sam wciąga pliki z folderu** — patrz
  `desktop_agent/przyklady/OSTATNI_MILIMETR.md`, sekcja o wariantach automatyzacji.
  To ustal **przed** obietnicą pełnej bezobsługowości.
- **Odpowiedzi Allegro i BaseLinkera** — do tego potrzebne są konta.
  Allegro ma środowisko sandbox (zmienne `ALLEGRO_API_BASE` / `ALLEGRO_AUTH_BASE`
  w `.env.example`), warto je wykorzystać przed produkcją.
- **Zachowanie pod obciążeniem** — 7 SKU to nie 30 000. Jeśli klientka ma dużą
  kartotekę, zmierz czas `fetchStockSnapshot` na kopii jej bazy.
