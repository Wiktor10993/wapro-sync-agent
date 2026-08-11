/* ==========================================================================
   MOCK WAPRO — układ DWUTABELOWY zgodny z integratorem:
     ARTYKULY (ID_ARTYKULU, INDEKS_KATALOGOWY, INDEKS_HANDLOWY, EAN, NAZWA)
     STANY    (ID_ARTYKULU, ID_MAGAZYNU, STAN)
     MAGAZYNY (ID_MAGAZYNU, NAZWA, SYMBOL)
     INTEG.*  (dziennik + bufor rezerwacji/zapisów z kanałów)

   Wklej całość do Azure Data Studio (połączenie: localhost,1433 / sa) i uruchom.
   Po wgraniu ustaw w aplikacji „Mapowanie tabel": produkty=ARTYKULY, stany=STANY,
   magazyny=MAGAZYNY, zapisz i „Sprawdź schemat".
   ========================================================================== */

IF DB_ID('WAPRO') IS NULL CREATE DATABASE WAPRO;
GO
USE WAPRO;
GO

/* Czysty start (kolejność ze względu na logiczne zależności). */
IF OBJECT_ID('dbo.STANY', 'U')    IS NOT NULL DROP TABLE dbo.STANY;
IF OBJECT_ID('dbo.ARTYKULY', 'U') IS NOT NULL DROP TABLE dbo.ARTYKULY;
IF OBJECT_ID('dbo.MAGAZYNY', 'U') IS NOT NULL DROP TABLE dbo.MAGAZYNY;
GO

CREATE TABLE dbo.MAGAZYNY (
  ID_MAGAZYNU INT IDENTITY(1,1) PRIMARY KEY,
  NAZWA       NVARCHAR(50) NOT NULL,
  SYMBOL      VARCHAR(10)  NOT NULL
);
GO

CREATE TABLE dbo.ARTYKULY (
  ID_ARTYKULU       INT IDENTITY(1,1) PRIMARY KEY,
  INDEKS_KATALOGOWY VARCHAR(40)  NOT NULL DEFAULT '',
  INDEKS_HANDLOWY   VARCHAR(40)  NOT NULL DEFAULT '',
  EAN               VARCHAR(32)  NULL DEFAULT '',
  NAZWA             NVARCHAR(120) NOT NULL
);
GO

CREATE TABLE dbo.STANY (
  ID_ARTYKULU INT NOT NULL,
  ID_MAGAZYNU INT NOT NULL,
  STAN        DECIMAL(16,4) NOT NULL DEFAULT 0,
  CONSTRAINT PK_STANY PRIMARY KEY (ID_ARTYKULU, ID_MAGAZYNU)
);
GO

/* --- Schemat integracji (własny, NIE tabele ERP) ----------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'INTEG') EXEC('CREATE SCHEMA INTEG');
GO
IF OBJECT_ID('INTEG.INTEG_LOG_SYNC', 'U') IS NULL
CREATE TABLE INTEG.INTEG_LOG_SYNC (
  ID BIGINT IDENTITY(1,1) PRIMARY KEY, TS DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  DIRECTION VARCHAR(20) NOT NULL, CHANNEL VARCHAR(20) NOT NULL, SKU VARCHAR(64) NULL,
  EAN VARCHAR(32) NULL, OFFER_ID VARCHAR(64) NULL, QTY_BEFORE INT NULL, QTY_AFTER INT NULL,
  STATUS VARCHAR(10) NOT NULL, MESSAGE NVARCHAR(1000) NULL
);
GO
IF OBJECT_ID('INTEG.WAPRO_DELTA_BUFOR', 'U') IS NULL
CREATE TABLE INTEG.WAPRO_DELTA_BUFOR (
  ID BIGINT IDENTITY(1,1) PRIMARY KEY, TS DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  SKU VARCHAR(64) NOT NULL, EAN VARCHAR(32) NULL, DELTA_QTY INT NOT NULL,
  TARGET_QTY INT NOT NULL, REASON NVARCHAR(200) NULL, PRZETWORZONY INT NOT NULL DEFAULT 0
);
GO

/* ==========================================================================
   DANE TESTOWE (branża wędkarska)
   ========================================================================== */
SET IDENTITY_INSERT dbo.MAGAZYNY ON;
INSERT INTO dbo.MAGAZYNY (ID_MAGAZYNU, NAZWA, SYMBOL) VALUES (1, N'Magazyn Główny', 'MG');
SET IDENTITY_INSERT dbo.MAGAZYNY OFF;
GO

SET IDENTITY_INSERT dbo.ARTYKULY ON;
INSERT INTO dbo.ARTYKULY (ID_ARTYKULU, INDEKS_KATALOGOWY, INDEKS_HANDLOWY, EAN, NAZWA) VALUES
  -- 1) Ten produkt CELOWO wywali błąd przy wysyłce na kanał (mock: „Oferta zarchiwizowana").
  (1, 'FB-CZIN-710', 'FB-CZIN-710', '5904619771106', N'Przynęta Feeder Bait Czinkers DUO 7/10mm Orzech Tygrysi'),
  -- 2) Dopasowanie po SKU (INDEKS) — wysyłka OK.
  (2, 'SAL-PER-08F', 'SAL-PER-08F', '5901000000029', N'HIT! Wobler Salmo Perch 8cm Floating GRATIS'),
  -- 3) Brak EAN i SKU w ofercie → dopasowanie po NAZWIE (Fuzzy) — wysyłka OK.
  (3, 'KP-TRU-16',   'KP-TRU-16',   '',              N'Kulki Proteinowe SUPER Truskawka 16mm 1kg PROMOCJA'),
  -- 4) BŁĘDNY EAN + brak oferty → „Niezmapowany produkt" (Kategoria I).
  (4, 'PDB-X',       '',            'EAN-BLAD-123',  N'Podbierak Testowy Bez Oferty 60cm');
SET IDENTITY_INSERT dbo.ARTYKULY OFF;
GO

INSERT INTO dbo.STANY (ID_ARTYKULU, ID_MAGAZYNU, STAN) VALUES
  (1, 1, 15),
  (2, 1, 12),
  (3, 1, 30),
  (4, 1, 7);
GO

/* Kontrola: co zobaczy agent (JOIN ARTYKULY⋈STANY). */
SELECT a.ID_ARTYKULU,
       COALESCE(NULLIF(a.INDEKS_KATALOGOWY,''), NULLIF(a.INDEKS_HANDLOWY,'')) AS sku,
       a.EAN, a.NAZWA, s.STAN, s.ID_MAGAZYNU
FROM dbo.ARTYKULY a JOIN dbo.STANY s ON s.ID_ARTYKULU = a.ID_ARTYKULU
ORDER BY a.ID_ARTYKULU;
GO
