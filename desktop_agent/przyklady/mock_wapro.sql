/* ===========================================================================
   ATRAPA BAZY WAPRO MAG — do testów deweloperskich
   ===========================================================================

   Tworzy bazę WAPRO_TEST z minimalnym zestawem tabel, których używa agent:
   ARTYKULY, STANY_MAGAZYNOWE, MAGAZYNY, KONTRAHENCI.

   Nazwy kolumn odpowiadają domyślnemu profilowi w schemaMap.js. To NIE jest
   odwzorowanie prawdziwego WF-Maga — brakuje tu setek kolumn, wyzwalaczy
   i relacji. Chodzi wyłącznie o to, żeby dało się przetestować odczyt stanów,
   introspekcję i dopasowanie artykułów bez dostępu do bazy produkcyjnej.

   Uruchomienie (macOS, kontener z SQL Serverem):
     sqlcmd -S localhost -U sa -P 'TwojeHaslo123!' -C -i mock_wapro.sql
   =========================================================================== */

IF DB_ID('WAPRO_TEST') IS NULL
BEGIN
    PRINT 'Tworzę bazę WAPRO_TEST...';
    EXEC('CREATE DATABASE WAPRO_TEST');
END
GO

USE WAPRO_TEST;
GO

/* --------------------------------------------------------------------------
   MAGAZYNY
   -------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.MAGAZYNY', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.MAGAZYNY (
        ID_MAGAZYNU INT           NOT NULL PRIMARY KEY,
        SYMBOL      NVARCHAR(20)  NOT NULL,
        NAZWA       NVARCHAR(100) NOT NULL
    );

    INSERT INTO dbo.MAGAZYNY (ID_MAGAZYNU, SYMBOL, NAZWA) VALUES
        (1, N'MAG',  N'Magazyn główny'),
        (2, N'SKL',  N'Sklep stacjonarny'),
        (3, N'REKL', N'Reklamacje');
END
GO

/* --------------------------------------------------------------------------
   ARTYKULY
   -------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.ARTYKULY', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ARTYKULY (
        ID_ARTYKULU              INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        INDEKS_KATALOGOWY        NVARCHAR(40)  NULL,
        INDEKS_HANDLOWY          NVARCHAR(40)  NULL,
        PODSTAWOWY_KOD_KRESKOWY  NVARCHAR(40)  NULL,
        NAZWA                    NVARCHAR(255) NOT NULL,
        TYP_ARTYKULU             INT           NOT NULL DEFAULT 0,  -- 0 = towar, 1 = usługa
        ARCHIWALNY               BIT           NOT NULL DEFAULT 0,
        PODSTAWOWA_JEDNOSTKA     NVARCHAR(10)  NOT NULL DEFAULT N'szt'
    );

    CREATE INDEX IX_ART_INDEKS ON dbo.ARTYKULY (INDEKS_KATALOGOWY);

    INSERT INTO dbo.ARTYKULY
        (INDEKS_KATALOGOWY, INDEKS_HANDLOWY, PODSTAWOWY_KOD_KRESKOWY, NAZWA, TYP_ARTYKULU, ARCHIWALNY)
    VALUES
        (N'WIERT-06',        N'W06',  N'5901234000016', N'Wiertło do metalu HSS 6 mm',     0, 0),
        (N'WIERT-08',        N'W08',  N'5901234000023', N'Wiertło do metalu HSS 8 mm',     0, 0),
        (N'SRUB-M8',         N'SM8',  N'5901234000030', N'Śruba M8x40 ocynkowana',         0, 0),
        (N'FARBA-BIALA-5L',  N'FB5',  N'5901234000047', N'Farba akrylowa biała 5 l',       0, 0),
        (N'FARBA-BIALA-10L', N'FB10', N'5901234000054', N'Farba akrylowa biała 10 l',      0, 0),
        (N'KOSZULKA-M',      NULL,    N'5901234000061', N'Koszulka bawełniana — rozm. M',  0, 0),
        (N'KOSZULKA-L',      NULL,    N'5901234000078', N'Koszulka bawełniana — rozm. L',  0, 0),
        -- Artykuł archiwalny: sprawdza filtr skipArchived.
        (N'STARY-TOWAR',     NULL,    N'5901234000085', N'Towar wycofany ze sprzedaży',    0, 1),
        -- Artykuł tylko z indeksem handlowym: sprawdza COALESCE w buildSkuExpression.
        (NULL,               N'TYLKO-HANDLOWY', NULL,   N'Towar bez indeksu katalogowego', 0, 0),
        -- Usługa: nie ma sensu synchronizować jej stanu.
        (N'USL-TRANSPORT',   NULL,    NULL,             N'Transport',                      1, 0);
END
GO

/* --------------------------------------------------------------------------
   STANY_MAGAZYNOWE
   -------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.STANY_MAGAZYNOWE', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.STANY_MAGAZYNOWE (
        ID_STANU    INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ID_MAGAZYNU INT           NOT NULL,
        ID_ARTYKULU INT           NOT NULL,
        STAN        DECIMAL(14,4) NOT NULL DEFAULT 0,
        REZERWACJA  DECIMAL(14,4) NOT NULL DEFAULT 0,
        WARTOSC     DECIMAL(18,4) NOT NULL DEFAULT 0,
        CONSTRAINT FK_STANY_MAG FOREIGN KEY (ID_MAGAZYNU) REFERENCES dbo.MAGAZYNY (ID_MAGAZYNU),
        CONSTRAINT FK_STANY_ART FOREIGN KEY (ID_ARTYKULU) REFERENCES dbo.ARTYKULY (ID_ARTYKULU),
        CONSTRAINT UQ_STANY      UNIQUE (ID_MAGAZYNU, ID_ARTYKULU)
    );

    -- Magazyn główny
    INSERT INTO dbo.STANY_MAGAZYNOWE (ID_MAGAZYNU, ID_ARTYKULU, STAN, REZERWACJA)
    SELECT 1, a.ID_ARTYKULU, v.STAN, v.REZ
      FROM dbo.ARTYKULY a
      JOIN (VALUES
            (N'WIERT-06',        120.0000,  5.0000),
            (N'WIERT-08',         80.0000,  0.0000),
            (N'SRUB-M8',        1500.0000, 50.0000),
            (N'FARBA-BIALA-5L',   42.0000,  2.0000),
            (N'FARBA-BIALA-10L',  18.0000,  0.0000),
            (N'KOSZULKA-M',       30.0000,  0.0000),
            (N'KOSZULKA-L',       25.0000,  3.0000),
            (N'STARY-TOWAR',       7.0000,  0.0000)
           ) AS v(IDX, STAN, REZ) ON v.IDX = a.INDEKS_KATALOGOWY;

    -- Sklep stacjonarny: sprawdza sumowanie po magazynach
    INSERT INTO dbo.STANY_MAGAZYNOWE (ID_MAGAZYNU, ID_ARTYKULU, STAN, REZERWACJA)
    SELECT 2, a.ID_ARTYKULU, v.STAN, 0
      FROM dbo.ARTYKULY a
      JOIN (VALUES
            (N'WIERT-06',        15.0000),
            (N'FARBA-BIALA-5L',   8.0000)
           ) AS v(IDX, STAN) ON v.IDX = a.INDEKS_KATALOGOWY;

    -- Stan ułamkowy: sprawdza zaokrąglanie w dół
    INSERT INTO dbo.STANY_MAGAZYNOWE (ID_MAGAZYNU, ID_ARTYKULU, STAN, REZERWACJA)
    SELECT 1, a.ID_ARTYKULU, 3.7500, 0
      FROM dbo.ARTYKULY a WHERE a.INDEKS_HANDLOWY = N'TYLKO-HANDLOWY';
END
GO

/* --------------------------------------------------------------------------
   KONTRAHENCI
   -------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.KONTRAHENCI', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.KONTRAHENCI (
        ID_KONTRAHENTA INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        KOD            NVARCHAR(40)  NULL,
        NAZWA          NVARCHAR(255) NOT NULL,
        NIP            NVARCHAR(20)  NULL,
        EMAIL          NVARCHAR(160) NULL
    );

    INSERT INTO dbo.KONTRAHENCI (KOD, NAZWA, NIP, EMAIL) VALUES
        (N'ALLEGRO-DET', N'Sprzedaż internetowa — klient detaliczny', NULL, NULL),
        (N'ACME',        N'ACME sp. z o.o.', N'5252445767', N'biuro@acme.example');
END
GO

/* --------------------------------------------------------------------------
   Podsumowanie
   -------------------------------------------------------------------------- */
PRINT '';
PRINT '=== Atrapa WAPRO_TEST gotowa ===';

SELECT 'ARTYKULY' AS TABELA, COUNT(*) AS WIERSZY FROM dbo.ARTYKULY
UNION ALL SELECT 'STANY_MAGAZYNOWE', COUNT(*) FROM dbo.STANY_MAGAZYNOWE
UNION ALL SELECT 'MAGAZYNY',         COUNT(*) FROM dbo.MAGAZYNY
UNION ALL SELECT 'KONTRAHENCI',      COUNT(*) FROM dbo.KONTRAHENCI;

PRINT '';
PRINT 'Podgląd tego, co zobaczy agent (magazyn 1+2, minus rezerwacje, bez archiwalnych):';

SELECT
    COALESCE(NULLIF(LTRIM(RTRIM(a.INDEKS_KATALOGOWY)), ''),
             NULLIF(LTRIM(RTRIM(a.INDEKS_HANDLOWY)), '')) AS SKU,
    MAX(a.NAZWA)                                          AS NAZWA,
    SUM(CAST(s.STAN AS DECIMAL(18,4))
        - CAST(ISNULL(s.REZERWACJA, 0) AS DECIMAL(18,4))) AS ILOSC
FROM dbo.STANY_MAGAZYNOWE s
JOIN dbo.ARTYKULY a ON a.ID_ARTYKULU = s.ID_ARTYKULU
WHERE COALESCE(NULLIF(LTRIM(RTRIM(a.INDEKS_KATALOGOWY)), ''),
               NULLIF(LTRIM(RTRIM(a.INDEKS_HANDLOWY)), '')) IS NOT NULL
  AND ISNULL(a.ARCHIWALNY, 0) = 0
  AND s.ID_MAGAZYNU IN (1, 2)
GROUP BY COALESCE(NULLIF(LTRIM(RTRIM(a.INDEKS_KATALOGOWY)), ''),
                  NULLIF(LTRIM(RTRIM(a.INDEKS_HANDLOWY)), ''))
ORDER BY SKU;
GO
