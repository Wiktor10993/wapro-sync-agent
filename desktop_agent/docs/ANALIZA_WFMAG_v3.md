# Analiza schematu WAPRO Mag (WF-Mag) i plan dostosowania v3

Źródło: `StrukturaWFMag.zip` (fizyczny schemat bazy, MS SQL Server) + „WAPRO Mag —
Dokumentacja procedur SQL" (Asseco, od wersji 8.80.0).

## 1. Najważniejsze odkrycie — model stanów jest INNY niż zakładaliśmy

Do tej pory kod zakładał dwie tabele łączone JOIN-em:
`ARTYKULY` ⋈ `STANY_MAGAZYNOWE` po `ID_ARTYKULU`. **W realnym WFMag to nie istnieje.**

Stan magazynowy jest trzymany **bezpośrednio w tabeli `ARTYKUL`** (liczba pojedyncza),
a każdy artykuł jest zdefiniowany **per magazyn** (własny wiersz, PK = `ID_ARTYKULU`).

Tabela `ARTYKUL` — kluczowe kolumny:

| Kolumna | Typ | Znaczenie |
|---|---|---|
| `ID_ARTYKULU` | T_ID_TYP (PK) | identyfikator karty artykułu |
| `ID_MAGAZYNU` | numeric | magazyn, do którego należy karta |
| `STAN` | T_ILOSC_TYP | **bieżący stan** (ilość) |
| `ZAREZERWOWANO` | decimal(16,6) | **rezerwacja** (NIE „REZERWACJA"!) |
| `ZAMOWIONO`, `DO_REZERWACJI`, `OD_DOSTAWCOW`, `DO_ODBIORCOW` | | ilości pomocnicze |
| `NAZWA` | varchar(40) | nazwa |
| `INDEKS_KATALOGOWY` | varchar(20) | indeks katalogowy (SKU) |
| `INDEKS_HANDLOWY` | varchar(20) | indeks handlowy (SKU) |
| `KOD_KRESKOWY` | varchar(20) | podstawowy EAN (na karcie) |
| `ZABLOKOWANY` | T_CHECK_TYP (0/1) | odpowiednik „archiwalny/zablokowany" |
| `STAN_MINIMALNY`, `STAN_MAKSYMALNY` | | progi |

Wniosek: **stan czytamy z jednej tabeli `ARTYKUL`, bez JOIN-a.** To tłumaczy błąd
klienta `Invalid column name 'REZERWACJA'` — realna kolumna to `ZAREZERWOWANO`.

Zapytanie poprawne dla WFMag (zagregowane po SKU, wiele magazynów):

```sql
SELECT
  COALESCE(NULLIF(LTRIM(RTRIM(INDEKS_KATALOGOWY)),''),
           NULLIF(LTRIM(RTRIM(INDEKS_HANDLOWY)),'')) AS sku,
  MAX(NAZWA)                              AS nazwa,
  MAX(KOD_KRESKOWY)                       AS kod,
  SUM(CAST(STAN AS DECIMAL(18,4))
      - CAST(ISNULL(ZAREZERWOWANO,0) AS DECIMAL(18,4))) AS ilosc
FROM ARTYKUL
WHERE ISNULL(ZABLOKOWANY,0) = 0
  AND COALESCE(NULLIF(INDEKS_KATALOGOWY,''), NULLIF(INDEKS_HANDLOWY,'')) IS NOT NULL
GROUP BY COALESCE(NULLIF(LTRIM(RTRIM(INDEKS_KATALOGOWY)),''),
                  NULLIF(LTRIM(RTRIM(INDEKS_HANDLOWY)),''));
```

## 2. Pozostałe realne tabele (potwierdzone ze schematu)

- `MAGAZYN` — magazyny: `ID_MAGAZYNU` (identity, PK), `NAZWA` varchar(50),
  `SYMBOL` varchar(10), `PODLEGA_SYNCHRONIZACJI`.
- `KOD_KRESKOWY` — **wiele EAN na artykuł**: `(ID_MAGAZYNU, KOD_KRESKOWY)` PK,
  `ID_ARTYKULU`. Poza podstawowym `ARTYKUL.KOD_KRESKOWY` dodatkowe kody są tutaj.
- `KONTRAHENT`, `ADRESY_KONTRAHENTA` — nabywcy/adresy.
- `ZAMOWIENIE`, `POZYCJA_ZAMOWIENIA` — zamówienia.
- `DOKUMENT_HANDLOWY`, `POZYCJA_DOKUMENTU_...`, `DOKUMENT_MAGAZYNOWY`,
  `POZYCJA_DOKUMENTU_MAGAZYNOWEGO` — dokumenty (to one realnie zmieniają `STAN`).
- Typy domenowe: `T_ID_TYP`, `T_ILOSC_TYP`, `T_MONEY_TYP`, `T_CHECK_TYP` itd.

## 3. Zamówienia → Wapro: właściwa droga to procedury SQL

„Dokumentacja procedur SQL" opisuje **sankcjonowany** sposób zakładania dokumentów
(zamiast pisać wprost do tabel ERP): zestaw procedur `JL_*` / `AP_*`, m.in.:
- dodanie/zatwierdzenie **dokumentu magazynowego** (nagłówek → pozycje → zatwierdzenie),
- dodanie/zatwierdzenie **dokumentu handlowego** (auto-tworzy dokument magazynowy,
  co obniża `STAN`),
- `JL_SumujDokumentHandlowy_Server`, `JL_PobierzFormatNumeracji_Server`,
  `AP_GenerujRozliczenieDokumentuHandlowego`, obsługa korekt.

To jest docelowa ścieżka „Zamówienie z kanału → dokument w Wapro → spadek stanu".
Uwaga: to **zapis do ERP** — wymaga ostrożności, testów na kopii bazy i decyzji
wdrożeniowej (którego typu dokument tworzymy: ZK/zamówienie, FS/paragon itd.).

## 4. Rozbieżności: nasz kod vs realny WFMag

| Obszar | Nasze założenie | Realny WFMag | Działanie v3 |
|---|---|---|---|
| Tabela artykułów | `ARTYKULY` | `ARTYKUL` | zmiana domyślnej |
| Tabela stanów | `STANY_MAGAZYNOWE` (JOIN) | brak — stan w `ARTYKUL` | tryb jednotabelowy |
| Rezerwacja | `REZERWACJA` | `ZAREZERWOWANO` | kandydat #1 |
| Archiwum | `ARCHIWALNY` | `ZABLOKOWANY` | kandydat #1 |
| Magazyny | `MAGAZYNY` | `MAGAZYN` | zmiana domyślnej |
| EAN | jedna kolumna | `ARTYKUL.KOD_KRESKOWY` + tabela `KOD_KRESKOWY` | kandydat + opcjonalnie dociąganie wielu EAN |
| Zamówienia → Wapro | tabela pośrednia / XML ECO | procedury `JL_*`/`AP_*` | osobny milestone |

Dobra wiadomość: nasz resolver jest już adaptacyjny i „plastyczny", więc korekta
sprowadza się do (a) realnych domyślnych nazw + kandydatów, (b) trybu jednotabelowego
w budowaniu zapytania (gdy tabela artykułów = tabela stanów, pomijamy JOIN).

## 5. Plan v3 (priorytety)

1. **[krytyczne, stany] Tryb jednotabelowy `ARTYKUL`.** Domyślny profil = realny WFMag;
   resolver rozpoznaje, że stan/rezerwacja/magazyn są w tabeli artykułów i buduje
   zapytanie bez JOIN-a. Kandydaci: `STAN`, `ZAREZERWOWANO`, `ID_MAGAZYNU`,
   `ID_ARTYKULU`, `INDEKS_KATALOGOWY`/`INDEKS_HANDLOWY`, `KOD_KRESKOWY`, `ZABLOKOWANY`.
   Zachowujemy wsteczną zgodność (gdyby ktoś miał układ dwutabelowy — JOIN jak dziś).
2. **[stany] Wiele EAN.** Opcjonalnie dociąganie dodatkowych kodów z tabeli
   `KOD_KRESKOWY` do dopasowań Allegro/BaseLinker (po `ID_ARTYKULU`).
3. **[zamówienia] Zapis przez procedury `JL_*`/`AP_*`.** Nowy moduł tworzący dokument
   w Wapro zgodnie z dokumentacją, z trybem „symulacji" i twardym testem na kopii bazy.
   Wymaga decyzji: typ dokumentu i mapowanie płatności/dostawy.
4. **[diagnostyka] Rozszerzyć panel** o wykrycie trybu (jedno/dwutabelowy) i o listę
   realnie użytych kolumn WFMag.

Kroki 1–2 są bezpieczne (tylko odczyt). Krok 3 to zapis do ERP — wdrażamy dopiero po
akceptacji i testach na kopii.
