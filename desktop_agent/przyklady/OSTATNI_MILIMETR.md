# „Ostatni milimetr" — jak bufor trafia do dokumentów Wapro

Dokument opisuje decyzję architektoniczną i dostępne warianty domknięcia
przepływu: **bufor `integracja.ZAMOWIENIA` → natywny dokument ZO/ZAM w Wapro Mag**.

---

## Decyzja: reflektor plików ECO, nie trigger wstawiający dokument

Rozważane były trzy drogi. Wybrana została **droga B**.

| | Droga A: trigger / procedura pisząca do tabel dokumentów | **Droga B: reflektor bufor → pliki ECO** | Droga C: zostawić bufor, operator klika import |
|---|---|---|---|
| Numeracja dokumentów | musimy odtworzyć | **robi Wapro** | robi Wapro |
| Kontrahent (dopasowanie/założenie) | musimy odtworzyć | **robi Wapro** | robi Wapro |
| Rejestry VAT, rozrachunki | musimy odtworzyć | **robi Wapro** | robi Wapro |
| Ryzyko dla danych księgowych | **wysokie** | zerowe | zerowe |
| Zależność od wersji WF-Maga | krytyczna | tylko format XML | brak |
| Nakład operatora | zerowy | zerowy albo jedno kliknięcie* | pełny |

\* zależnie od tego, czy instalacja ma automatyczny import z folderu — patrz niżej.

### Dlaczego nie trigger

Trigger `AFTER INSERT` na tabeli buforowej wykonuje się **w transakcji agenta**.
To znaczy, że:

- błąd w logice ERP (brakujący kontrahent, zablokowany magazyn, przekroczony limit
  kredytowy) wycofuje **naszą** transakcję i zamówienie znika z bufora bez śladu;
- długo działający trigger trzyma blokady na tabelach dokumentów Wapro, co przy
  otwartym oknie ERP kończy się zakleszczeniami widocznymi dla użytkowniczki;
- odtwarzamy logikę, której nie znamy w 100% — a błąd w numeracji dokumentów
  albo w rejestrze VAT to problem księgowy, nie informatyczny.

Reflektor odwraca zależność: my przygotowujemy **czyste dane**, decyzję o utworzeniu
dokumentu podejmuje ERP. Nasz kod nie dotyka żadnej tabeli należącej do Wapro.

### Co dokładnie robi reflektor

`desktop_agent/src/main/wapro/bufferReflector.js`

1. Czyta wiersze o statusie `NOWE` (opcjonalnie tylko te w pełni dopasowane).
2. Buduje XML ECO — z **wypełnionym `<ID_ARTYKULU>`**, bo dopasowanie do kartoteki
   zrobiliśmy wcześniej. Import nie musi zgadywać po tekstowym indeksie.
3. Zapisuje plik atomowo (`.tmp` → `rename`), więc folder nasłuchu nigdy nie zobaczy
   pliku w połowie zapisu.
4. Dopiero po zapisie oznacza wiersz jako `WYEKSPORTOWANE`. Ta kolejność jest celowa:
   przy awarii dysku najgorsze, co się stanie, to powtórzony plik — a nie zgubione
   zamówienie.
5. Licznik `PROB_EKSPORTU` (limit 5) zapobiega zapętleniu na uszkodzonym rekordzie.

Przepływ statusów:

```
NOWE ──agent generuje plik──► WYEKSPORTOWANE ──Wapro wciąga──► PRZETWORZONE
  │                                                                  ▲
  └──── 5 nieudanych prób ────► BLAD          SP_OZNACZ_PRZETWORZONE ┘
```

---

## Domknięcie: jak Wapro ma wciągnąć pliki bez udziału operatora

Tu trzeba być szczerym: **nie każda instalacja Wapro Mag ma automatyczny import
z folderu**. To zależy od wersji i wykupionych modułów. Sprawdź na miejscu
u klientki, w tej kolejności:

### Wariant 1 — wbudowany harmonogram Wapro (najlepszy)

Sprawdź w menu ERP, czy jest moduł **Zadania cykliczne / Automat / Harmonogram**
(nazwa różni się między wydaniami; szukaj w *Narzędzia*, *Administracja* albo
*Konfiguracja*). Jeśli jest — zdefiniuj zadanie „Import ECO z katalogu" wskazujące
na folder nasłuchu i ustaw je co 5 minut. Wtedy cały przepływ jest bezobsługowy.

### Wariant 2 — Harmonogram zadań Windows

Jeśli instalacja udostępnia import z linii poleceń, zadanie w Harmonogramie zadań
Windows wywoła go cyklicznie. **Nie podaję tu gotowej komendy, bo nie mam
potwierdzonej składni CLI dla Wapro Mag** — sprawdź w dokumentacji swojej wersji
albo u wsparcia Asseco, czy plik wykonywalny przyjmuje przełącznik importu.
Gdy poznasz składnię, zadanie wygląda tak:

```powershell
# Uruchom jako: konto z dostępem do Wapro, "Uruchom niezależnie od zalogowania"
$akcja  = New-ScheduledTaskAction -Execute 'C:\Program Files\WAPRO\Mag\Mag.exe' `
                                  -Argument '<PRZEŁĄCZNIK_IMPORTU> C:\WaproImport'
$wyzwal = New-ScheduledTaskTrigger -Once -At (Get-Date) `
          -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'Wapro import ECO' -Action $akcja -Trigger $wyzwal
```

### Wariant 3 — jedno kliknięcie dziennie

Jeśli żaden z powyższych nie jest dostępny, zostaje ręczny import — ale reflektor
i tak zdejmuje z operatora **całą pracę przygotowawczą**: dopasowanie towarów,
przepisywanie danych klienta, kontrolę duplikatów. Zostaje kliknięcie
„Importuj" raz na jakiś czas, a nie przepisywanie zamówień.

To jest realistyczna granica tego, co da się zagwarantować bez ingerencji
w tabele ERP. Warto ustalić z klientką, który wariant jest dostępny, **zanim**
obiecasz pełną bezobsługowość.

---

## Wariant awaryjny: bezpośredni zapis do dokumentu ZAM

Plik `wapro_zam_import_TEMPLATE.sql` zawiera **szablon** procedury czytającej bufor
i tworzącej dokument w tabelach Wapro.

**Nie jest wgrywany przez agenta i nie powinien być uruchamiany bez weryfikacji.**
Wszystkie nazwy tabel i kolumn dokumentów są w nim **placeholderami** — nie mam
potwierdzonej struktury dokumentów WF-Maga i nie chcę udawać, że mam.

Użyj go tylko wtedy, gdy:

1. masz dokumentację schematu swojej wersji Wapro albo dostęp do wsparcia Asseco,
2. przetestowałeś całość na **kopii** bazy produkcyjnej,
3. masz świeży backup i plan wycofania,
4. klientka rozumie, że to modyfikacja danych ERP poza jego interfejsem.

W każdym innym wypadku zostań przy reflektorze.
