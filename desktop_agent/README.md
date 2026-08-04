# Desktop Agent

Aplikacja desktopowa (Electron + React) instalowana u klienta. Czyta stany
magazynowe z bazy Wapro Mag, wysyła je do Cloud Huba i zapisuje pobrane
zamówienia z powrotem do ERP.

Folder jest samowystarczalny: nie odwołuje się do niczego poza swoim drzewem.

---

## Szybki start

```bash
cd ~/Desktop/projekt_test/desktop_agent

npm install          # pierwsze uruchomienie: 2–4 minuty
npm test             # 81 testów jednostkowych
npm run dev          # aplikacja z hot-reloadem
```

Wymagania: **Node 18+** (`node -v`).

Budowanie instalatorów:

```bash
npm run build:win    # instalator NSIS dla Windows
npm run build:mac    # DMG dla macOS
```

---

## Struktura

```
desktop_agent/
├── package.json              zależności, skrypty, konfiguracja electron-builder
├── electron.vite.config.js   budowanie main / preload / renderer
├── .eslintrc.json            reguły lintera
│
├── src/
│   ├── shared/
│   │   └── channels.js       kontrakt IPC — jedyne źródło nazw kanałów
│   │
│   ├── main/                 proces główny (Node.js)
│   │   ├── index.js              rejestracja handlerów IPC, okno, cykl życia
│   │   ├── store.js              trwałe ustawienia + szyfrowanie sekretów
│   │   ├── services/
│   │   │   ├── syncService.js    SyncUp (stany), SyncDown (zamówienia)
│   │   │   ├── scheduler.js      harmonogram zadań tła
│   │   │   ├── hubClient.js      klient API Cloud Huba
│   │   │   ├── fileLogger.js     log do pliku z rotacją
│   │   │   └── tray.js           ikona w zasobniku, autostart
│   │   └── wapro/                warstwa MSSQL
│   │       ├── pool.js               połączenie, tłumaczenie błędów
│   │       ├── schemaMap.js          MAPA NAZW TABEL I KOLUMN ← zacznij tutaj
│   │       ├── introspect.js         weryfikacja schematu na żywej bazie
│   │       ├── inventoryRepository.js odczyt stanów
│   │       ├── stockDiff.js          wyliczanie delt
│   │       ├── orderNormalizer.js    Allegro/BaseLinker → wspólny kształt
│   │       ├── orderRepository.js    zapis do tabeli pośredniej
│   │       ├── stagingSchema.js      DDL schematu `integracja`
│   │       ├── bufferReflector.js    bufor → pliki ECO (ostatni milimetr)
│   │       └── ecoXml.js             generatory XML
│   │
│   ├── preload/index.js      mostek contextBridge — jedyne wyjście z sandboxa
│   │
│   └── renderer/             interfejs (React)
│       ├── index.html
│       └── src/
│           ├── App.jsx           powłoka, zakładki, subskrypcje IPC
│           ├── styles.css
│           ├── components/ui.jsx wspólne elementy
│           └── tabs/             6 zakładek
│
├── test/                     81 testów (node:test, bez zewnętrznych bibliotek)
└── przyklady/
    ├── mock_wapro.sql            atrapa bazy Wapro do testów
    ├── OSTATNI_MILIMETR.md       decyzja architektoniczna + warianty
    └── wapro_zam_import_TEMPLATE.sql  szablon (opt-in, z placeholderami)
```

---

## Konfiguracja — wyłącznie przez GUI

Klient nie dotyka kodu. Sześć zakładek:

| Zakładka | Zawiera |
|---|---|
| **Dashboard** | Status, ręczne uruchomienie, podgląd stanów, logi na żywo |
| **Ustawienia Bazy** | Połączenie MSSQL, test, **weryfikacja schematu** |
| **Konto Cloud** | Adres huba, klucz API, link do panelu |
| **Synchronizacja** | Harmonogram, wybór magazynów, tryb zapisu zamówień |
| **Zamówienia** | Podgląd bufora, symulacja, eksport do Wapro |
| **Aplikacja** | Tray, autostart, logi, wersje |

Ustawienia trafiają do `electron-store`. Hasło MSSQL i klucz API są szyfrowane
przez `safeStorage` (DPAPI na Windows, Keychain na macOS). Gdy szyfrowanie jest
niedostępne, GUI o tym informuje zamiast po cichu zapisywać jawnie.

---

## ⚠️ Pierwsza rzecz po instalacji u klienta

Nazwy kolumn w WF-Magu **różnią się między wersjami**. Profil w
`src/main/wapro/schemaMap.js` odzwierciedla typowy układ, ale nie jest
zweryfikowany dla każdej instalacji.

Dlatego zapytania **nie są zaszyte w kodzie** — budowane są z mapy. Po podaniu
danych połączenia kliknij **„Sprawdź schemat"** w zakładce Ustawienia Bazy.
Introspekcja czyta `INFORMATION_SCHEMA.COLUMNS`, raportuje braki i podpowiada
najbliższe nazwy kolumn.

To samo dotyczy formatu XML ECO (`ecoXml.js`) — porównaj plik wygenerowany
przez agenta z eksportem z instalacji klienta
(*Wapro Mag → Narzędzia → Eksport ECO*).

---

## Dwa tryby zapisu zamówień

**1. Pliki XML (ECO)** — agent zapisuje zamówienia bezpośrednio jako pliki
w wybranym folderze. Prosty, nie dotyka bazy.

**2. Tabela pośrednia + reflektor** — agent tworzy własny schemat `integracja`
w bazie Wapro, zapisuje tam zamówienia z dopasowanym `ID_ARTYKULU`, a następnie
odbija bufor jako pliki ECO do folderu nasłuchu ERP.

**Tabele Wapro nie są modyfikowane** — na `dbo.ARTYKULY` wykonujemy wyłącznie
`SELECT` przy dopasowywaniu towarów.

Przepływ statusów:

```
NOWE ──agent generuje plik──► WYEKSPORTOWANE ──Wapro wciąga──► PRZETWORZONE
  │                                                                  ▲
  └──── 5 nieudanych prób ────► BLAD          SP_OZNACZ_PRZETWORZONE ┘
```

Uzasadnienie decyzji i warianty domknięcia automatyzacji:
[`przyklady/OSTATNI_MILIMETR.md`](przyklady/OSTATNI_MILIMETR.md).

---

## Testy lokalne bez bazy klienta

```bash
# SQL Server w kontenerze (Apple Silicon — włącz Rosettę w Docker Desktop)
docker run -d --name wapro-mssql --platform linux/amd64 \
  -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='DevHaslo123!' -e MSSQL_PID=Developer \
  -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest

# Atrapa bazy Wapro
sqlcmd -S localhost -U sa -P 'DevHaslo123!' -C -i przyklady/mock_wapro.sql
```

Dane w atrapie zawierają przypadki brzegowe: artykuł archiwalny (test filtra),
towar tylko z indeksem handlowym (test `COALESCE`), stan `3,75` (test
zaokrąglania w dół), pozycja spoza kartoteki (test `BRAK_ARTYKULU`).

Pełny scenariusz: `../URUCHOMIENIE_MAC.md`.

---

## Bezpieczeństwo

- `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`.
- Renderer nie widzi `ipcRenderer` — tylko zamknięte API `window.agent`.
- Identyfikatory z mapy schematu przechodzą przez `quoteIdent()` z walidacją
  regexem; wartości zawsze przez parametry `mssql`. Próba wstrzyknięcia SQL
  przez zmanipulowaną konfigurację jest odrzucana (pokryte testami).
- `openExternal` przyjmuje wyłącznie `http(s)://`.
- Blokada pojedynczej instancji — dwa agenty na tej samej bazie robiłyby
  podwójne wysyłki.

---

## Rozwiązywanie problemów

| Objaw | Przyczyna | Rozwiązanie |
|---|---|---|
| `Cannot find module 'mssql'` | przerwana instalacja | `rm -rf node_modules package-lock.json && npm install` |
| Aplikacja startuje i znika | brak uprawnień do zasobnika (macOS) | Ustawienia → Prywatność → zezwól Electronowi |
| Białe okno | port Vite zajęty | `pkill -f electron`, potem `npm run dev` |
| „Logowanie odrzucone" | tryb uwierzytelniania SQL Servera | włącz tryb mieszany albo sprawdź hasło |
| „Nie można nawiązać połączenia" | zapora / usługa nie działa | sprawdź port 1433 i usługę SQL Server |
| Błąd certyfikatu SSL | certyfikat self-signed | zaznacz „Ufaj certyfikatowi serwera" |
| Introspekcja zgłasza braki | inna wersja WF-Maga | popraw nazwy zgodnie z podpowiedziami |

Logi aplikacji: menu traya → **Otwórz folder z logami** (rotacja 5 MB × 5 plików).
