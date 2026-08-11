/* ==========================================================================
   Minimalny schemat WAPRO Mag pod testy integratora.
   Odzwierciedla REALNE tabele/kolumny WFMag ustalone ze schematu fizycznego:
     - ARTYKUL      : karta artykułu = ŹRÓDŁO STANU (STAN, ZAREZERWOWANO, ID_MAGAZYNU)
     - KOD_KRESKOWY : dodatkowe kody EAN (wiele na artykuł)
     - MAGAZYN      : magazyny
     - INTEG.INTEG_LOG_SYNC : własny dziennik integracji (nie tabela ERP)
   ========================================================================== */

IF DB_ID('WAPRO') IS NULL
  CREATE DATABASE WAPRO;
GO

USE WAPRO;
GO

/* --- MAGAZYN ------------------------------------------------------------- */
IF OBJECT_ID('dbo.MAGAZYN', 'U') IS NULL
CREATE TABLE dbo.MAGAZYN (
  ID_MAGAZYNU INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  NAZWA       NVARCHAR(50) NOT NULL, -- NVARCHAR w teście = pewne polskie znaki (WFMag prod używa VARCHAR + kolacja PL)
  SYMBOL      VARCHAR(10)  NOT NULL
);
GO

/* --- ARTYKUL (stan trzymany bezpośrednio tutaj) ------------------------- */
IF OBJECT_ID('dbo.ARTYKUL', 'U') IS NULL
CREATE TABLE dbo.ARTYKUL (
  ID_ARTYKULU       INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  ID_MAGAZYNU       INT           NULL,
  NAZWA             NVARCHAR(80)  NOT NULL, -- NVARCHAR w teście dla pewności polskich znaków

  INDEKS_KATALOGOWY VARCHAR(20)   NOT NULL DEFAULT '',
  INDEKS_HANDLOWY   VARCHAR(20)   NOT NULL DEFAULT '',
  KOD_KRESKOWY      VARCHAR(20)   NULL DEFAULT '',
  STAN              DECIMAL(16,4) NULL DEFAULT 0,
  ZAREZERWOWANO     DECIMAL(16,6) NOT NULL DEFAULT 0,
  ZABLOKOWANY       INT           NULL DEFAULT 0
);
GO

/* --- KOD_KRESKOWY (wiele EAN na artykuł) -------------------------------- */
IF OBJECT_ID('dbo.KOD_KRESKOWY', 'U') IS NULL
CREATE TABLE dbo.KOD_KRESKOWY (
  ID_MAGAZYNU  INT          NOT NULL,
  KOD_KRESKOWY VARCHAR(20)  NOT NULL,
  ID_ARTYKULU  INT          NULL,
  CONSTRAINT PK_KOD_KRESKOWY PRIMARY KEY (ID_MAGAZYNU, KOD_KRESKOWY)
);
GO

/* --- Dziennik integracji (własny schemat INTEG, NIE tabela ERP) --------- */
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'INTEG')
  EXEC('CREATE SCHEMA INTEG');
GO

IF OBJECT_ID('INTEG.INTEG_LOG_SYNC', 'U') IS NULL
CREATE TABLE INTEG.INTEG_LOG_SYNC (
  ID         BIGINT IDENTITY(1,1) PRIMARY KEY,
  TS         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
  DIRECTION  VARCHAR(20)    NOT NULL,
  CHANNEL    VARCHAR(20)    NOT NULL,
  SKU        VARCHAR(64)    NULL,
  EAN        VARCHAR(32)    NULL,
  OFFER_ID   VARCHAR(64)    NULL,
  QTY_BEFORE INT            NULL,
  QTY_AFTER  INT            NULL,
  STATUS     VARCHAR(10)    NOT NULL,
  MESSAGE    NVARCHAR(1000) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_INTEG_LOG_TS' AND object_id=OBJECT_ID('INTEG.INTEG_LOG_SYNC'))
  CREATE INDEX IX_INTEG_LOG_TS ON INTEG.INTEG_LOG_SYNC (TS DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_INTEG_LOG_SKU' AND object_id=OBJECT_ID('INTEG.INTEG_LOG_SYNC'))
  CREATE INDEX IX_INTEG_LOG_SKU ON INTEG.INTEG_LOG_SYNC (SKU);
GO

/* --- Bufor zapisów/rezerwacji z kanałów (cel WaproPort.applyDelta) --------
   Tu ląduje „dokument/rezerwacja" tworzony przez agenta, gdy sprzedaż z kanału
   ma obniżyć stan w WAPRO. To WŁASNA tabela (schemat INTEG) — nie dotykamy tabel
   ERP. W produkcji zastępuje ją realny zapis przez procedury JL_*/AP_* Wapro. */
IF OBJECT_ID('INTEG.WAPRO_DELTA_BUFOR', 'U') IS NULL
CREATE TABLE INTEG.WAPRO_DELTA_BUFOR (
  ID          BIGINT IDENTITY(1,1) PRIMARY KEY,
  TS          DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
  SKU         VARCHAR(64)    NOT NULL,
  EAN         VARCHAR(32)    NULL,
  DELTA_QTY   INT            NOT NULL,   -- o ile zmienić (ujemne = zejście)
  TARGET_QTY  INT            NOT NULL,   -- docelowy stan
  REASON      NVARCHAR(200)  NULL,
  PRZETWORZONY INT           NOT NULL DEFAULT 0  -- 0 = czeka na wciągnięcie do ERP
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_BUFOR_SKU' AND object_id=OBJECT_ID('INTEG.WAPRO_DELTA_BUFOR'))
  CREATE INDEX IX_BUFOR_SKU ON INTEG.WAPRO_DELTA_BUFOR (SKU, PRZETWORZONY);
GO
