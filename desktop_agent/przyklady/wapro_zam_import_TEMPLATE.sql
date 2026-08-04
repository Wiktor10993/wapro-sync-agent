/* ===========================================================================
   SZABLON — bezpośredni zapis bufora do dokumentu ZAM w Wapro Mag
   ===========================================================================

   ⚠️  TO JEST SZABLON, NIE GOTOWY SKRYPT.

   Agent NIE wgrywa tego pliku i nigdy go nie uruchamia. Wszystkie nazwy tabel
   i kolumn dokumentów oznaczone jako {{PLACEHOLDER}} trzeba podmienić na
   rzeczywiste nazwy z TWOJEJ wersji WF-Maga — nie mam potwierdzonej struktury
   dokumentów Wapro i nie zgaduję jej.

   Zalecana ścieżka to reflektor plików ECO (patrz OSTATNI_MILIMETR.md).
   Ten szablon istnieje dla przypadków, w których masz dokumentację schematu
   i świadomie decydujesz się wejść do tabel ERP.

   PRZED URUCHOMIENIEM:
     1. Wykonaj pełny backup bazy.
     2. Przetestuj na KOPII bazy produkcyjnej.
     3. Sprawdź, jak Twoja instalacja nadaje numery dokumentów — sekcja
        NUMERACJA poniżej jest najbardziej ryzykowna.
     4. Ustal, czy Wapro ma wyzwalacze na tabelach dokumentów, które ten
        skrypt ominie.

   CZEGO TEN SZABLON CELOWO NIE ROBI:
     - nie księguje, nie tworzy rozrachunków, nie rezerwuje stanów,
     - nie wystawia dokumentów magazynowych,
     - nie dotyka rejestrów VAT.
   =========================================================================== */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE [integracja].[SP_SZABLON_UTWORZ_ZAM]
    @ID_INTEGRACJA INT,
    @ID_MAGAZYNU   INT,
    @TYLKO_TEST    BIT = 1        -- 1 = pokaż plan, nie zapisuj (DOMYŚLNIE)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;            -- każdy błąd wycofuje całą transakcję

    DECLARE @ID_KONTRAHENTA INT,
            @NUMER          NVARCHAR(64),
            @ID_DOKUMENTU   INT,
            @NIEDOPASOWANE  INT;

    ---------------------------------------------------------------------
    -- 0. Walidacja wstępna
    ---------------------------------------------------------------------
    IF NOT EXISTS (SELECT 1 FROM [integracja].[ZAMOWIENIA]
                   WHERE ID_INTEGRACJA = @ID_INTEGRACJA
                     AND STATUS IN ('NOWE','WYEKSPORTOWANE'))
    BEGIN
        RAISERROR('Bufor #%d nie istnieje albo został już przetworzony.', 16, 1, @ID_INTEGRACJA);
        RETURN;
    END

    SELECT @NIEDOPASOWANE = COUNT(*)
      FROM [integracja].[ZAMOWIENIA_POZYCJE]
     WHERE ID_INTEGRACJA = @ID_INTEGRACJA
       AND (ID_ARTYKULU IS NULL OR DOPASOWANIE = 'BRAK_ARTYKULU');

    IF @NIEDOPASOWANE > 0
    BEGIN
        -- Dokument z niedopasowanymi pozycjami byłby niekompletny.
        -- Lepiej zatrzymać się tutaj niż wystawić błędne zamówienie.
        RAISERROR('Bufor #%d ma %d pozycji bez ID_ARTYKULU. Uzupełnij kartotekę.',
                  16, 1, @ID_INTEGRACJA, @NIEDOPASOWANE);
        RETURN;
    END

    ---------------------------------------------------------------------
    -- 1. Kontrahent — dopasowanie po NIP, potem po e-mailu
    ---------------------------------------------------------------------
    SELECT TOP 1 @ID_KONTRAHENTA = k.ID_KONTRAHENTA
      FROM dbo.KONTRAHENCI k
      JOIN [integracja].[ZAMOWIENIA] z ON z.ID_INTEGRACJA = @ID_INTEGRACJA
     WHERE (NULLIF(z.KONTRAHENT_NIP, '') IS NOT NULL
            AND REPLACE(REPLACE(k.NIP, '-', ''), ' ', '')
              = REPLACE(REPLACE(z.KONTRAHENT_NIP, '-', ''), ' ', ''));

    IF @ID_KONTRAHENTA IS NULL
    BEGIN
        /* {{PLACEHOLDER}} — dopasowanie po e-mailu wymaga znajomości kolumny
           adresu e-mail w Twojej wersji kartoteki kontrahentów.

        SELECT TOP 1 @ID_KONTRAHENTA = k.ID_KONTRAHENTA
          FROM dbo.KONTRAHENCI k
          JOIN [integracja].[ZAMOWIENIA] z ON z.ID_INTEGRACJA = @ID_INTEGRACJA
         WHERE k.{{KOLUMNA_EMAIL}} = z.KONTRAHENT_EMAIL;
        */

        -- Fallback: kontrahent zbiorczy „Sprzedaż internetowa".
        -- Załóż go RĘCZNIE w Wapro i wstaw jego ID poniżej.
        SET @ID_KONTRAHENTA = {{ID_KONTRAHENTA_ZBIORCZEGO}};
    END

    IF @ID_KONTRAHENTA IS NULL
    BEGIN
        RAISERROR('Nie ustalono kontrahenta dla bufora #%d.', 16, 1, @ID_INTEGRACJA);
        RETURN;
    END

    ---------------------------------------------------------------------
    -- 2. NUMERACJA — najbardziej ryzykowny fragment
    ---------------------------------------------------------------------
    /* {{PLACEHOLDER}}
       Wapro trzyma definicje numeracji we własnych tabelach konfiguracyjnych
       i zwykle nadaje numer procedurą wewnętrzną. Ręczne sklejanie numeru
       (np. 'ZO/1/2026') grozi kolizją z dokumentem wystawionym równolegle
       w interfejsie ERP.

       SPRAWDŹ w dokumentacji swojej wersji, czy jest dostępna procedura
       nadająca numer, i wywołaj ją tutaj. Poniższy przykład jest CELOWO
       naiwny i NIE nadaje się na produkcję:

    SELECT @NUMER = 'ZO/' +
           CAST(ISNULL(MAX(TRY_CAST(SUBSTRING({{KOL_NUMER}}, 4, 10) AS INT)), 0) + 1 AS NVARCHAR(10))
           + '/' + CAST(YEAR(GETDATE()) AS NVARCHAR(4))
      FROM dbo.{{TABELA_DOKUMENTOW}} WITH (UPDLOCK, HOLDLOCK)
     WHERE {{KOL_TYP}} = 'ZO' AND YEAR({{KOL_DATA}}) = YEAR(GETDATE());
    */

    SET @NUMER = N'{{NUMER_Z_PROCEDURY_WAPRO}}';

    ---------------------------------------------------------------------
    -- 3. Tryb testowy — pokaż plan i wyjdź
    ---------------------------------------------------------------------
    IF @TYLKO_TEST = 1
    BEGIN
        SELECT 'PLAN' AS ETAP, @ID_INTEGRACJA AS ID_BUFORA,
               @ID_KONTRAHENTA AS ID_KONTRAHENTA, @NUMER AS NUMER_DOKUMENTU,
               @ID_MAGAZYNU AS ID_MAGAZYNU;

        SELECT p.LP, p.SKU, p.NAZWA, p.ILOSC, p.CENA_BRUTTO, p.ID_ARTYKULU
          FROM [integracja].[ZAMOWIENIA_POZYCJE] p
         WHERE p.ID_INTEGRACJA = @ID_INTEGRACJA
         ORDER BY p.LP;

        RETURN;
    END

    ---------------------------------------------------------------------
    -- 4. Zapis dokumentu
    ---------------------------------------------------------------------
    BEGIN TRANSACTION;

    BEGIN TRY
        /* {{PLACEHOLDER}} — nagłówek dokumentu.
           Nazwy tabeli i kolumn MUSISZ podmienić na rzeczywiste.

        INSERT INTO dbo.{{TABELA_DOKUMENTOW}}
            ({{KOL_TYP}}, {{KOL_NUMER}}, {{KOL_DATA}}, {{KOL_ID_KONTRAHENTA}},
             {{KOL_ID_MAGAZYNU}}, {{KOL_NUMER_OBCY}}, {{KOL_UWAGI}})
        SELECT 'ZO', @NUMER, CAST(z.DATA_ZAMOWIENIA AS DATE), @ID_KONTRAHENTA,
               @ID_MAGAZYNU, z.NUMER_OBCY, z.UWAGI
          FROM [integracja].[ZAMOWIENIA] z
         WHERE z.ID_INTEGRACJA = @ID_INTEGRACJA;

        SET @ID_DOKUMENTU = SCOPE_IDENTITY();

           Pozycje:

        INSERT INTO dbo.{{TABELA_POZYCJI}}
            ({{KOL_ID_DOKUMENTU}}, {{KOL_LP}}, {{KOL_ID_ARTYKULU}},
             {{KOL_ILOSC}}, {{KOL_CENA}})
        SELECT @ID_DOKUMENTU, p.LP, p.ID_ARTYKULU, p.ILOSC, p.CENA_BRUTTO
          FROM [integracja].[ZAMOWIENIA_POZYCJE] p
         WHERE p.ID_INTEGRACJA = @ID_INTEGRACJA
         ORDER BY p.LP;
        */

        -- Dopóki placeholdery nie są podmienione, procedura ma się nie wykonać.
        RAISERROR('Szablon nie został uzupełniony — podmień {{PLACEHOLDER}} przed użyciem.', 16, 1);

        EXEC [integracja].[SP_OZNACZ_PRZETWORZONE]
             @ID_INTEGRACJA      = @ID_INTEGRACJA,
             @ID_DOKUMENTU_WAPRO = @ID_DOKUMENTU,
             @NUMER_DOKUMENTU    = @NUMER;

        COMMIT TRANSACTION;

        SELECT 'OK' AS WYNIK, @ID_DOKUMENTU AS ID_DOKUMENTU, @NUMER AS NUMER;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;

        DECLARE @BLAD NVARCHAR(1000) = ERROR_MESSAGE();

        -- Zapis błędu poza transakcją dokumentu — ślad musi przetrwać rollback.
        EXEC [integracja].[SP_OZNACZ_BLAD]
             @ID_INTEGRACJA = @ID_INTEGRACJA,
             @KOMUNIKAT     = @BLAD;

        THROW;
    END CATCH
END
GO

/* ---------------------------------------------------------------------------
   PRZYKŁAD UŻYCIA (tryb testowy — niczego nie zapisuje):

       EXEC [integracja].[SP_SZABLON_UTWORZ_ZAM]
            @ID_INTEGRACJA = 1, @ID_MAGAZYNU = 1, @TYLKO_TEST = 1;

   Dopiero po podmianie placeholderów i testach na kopii bazy:

       EXEC [integracja].[SP_SZABLON_UTWORZ_ZAM]
            @ID_INTEGRACJA = 1, @ID_MAGAZYNU = 1, @TYLKO_TEST = 0;
   --------------------------------------------------------------------------- */
