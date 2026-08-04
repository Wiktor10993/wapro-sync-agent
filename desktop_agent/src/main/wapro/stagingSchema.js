/**
 * TABELA POŚREDNIA — schemat `integracja`
 * =======================================
 *
 * Zamówienia z kanałów sprzedaży NIE są wstawiane bezpośrednio do tabel
 * dokumentów Wapro. Powód jest praktyczny: numeracja dokumentów, rozrachunki,
 * powiązania z kartoteką kontrahentów i rejestry VAT są w WF-Magu spięte
 * wyzwalaczami i procedurami, których struktura różni się między wersjami.
 * Wstawienie tam rekordu „z boku” grozi rozjechaniem numeracji i danych
 * księgowych — czyli dokładnie tym, czego klient nie wybaczy.
 *
 * Zamiast tego agent tworzy WŁASNY schemat `integracja` z dwiema tabelami
 * i jedną procedurą. Wapro (albo operator) czyta z nich przez import ECO lub
 * zapytanie. Ryzyko dla danych produkcyjnych: zerowe — nie modyfikujemy
 * żadnego obiektu należącego do ERP.
 *
 * Wymagane uprawnienia użytkownika MSSQL:
 *   CREATE SCHEMA, CREATE TABLE, CREATE PROCEDURE (jednorazowo),
 *   potem tylko INSERT/UPDATE/SELECT na schemacie `integracja`
 *   oraz SELECT na dbo.ARTYKULY.
 */

export const STAGING_SCHEMA = 'integracja'
export const T_ORDERS = 'ZAMOWIENIA'
export const T_ITEMS = 'ZAMOWIENIA_POZYCJE'

/**
 * Instrukcje DDL. Każda jest idempotentna (IF NOT EXISTS), więc funkcję
 * tworzącą można wołać przy każdym starcie agenta.
 */
export const DDL = [
  {
    name: 'schema',
    sql: `
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '${STAGING_SCHEMA}')
    EXEC('CREATE SCHEMA [${STAGING_SCHEMA}]');`
  },
  {
    name: 'tabela ZAMOWIENIA',
    sql: `
IF NOT EXISTS (SELECT 1 FROM sys.tables t
               JOIN sys.schemas s ON s.schema_id = t.schema_id
               WHERE s.name = '${STAGING_SCHEMA}' AND t.name = '${T_ORDERS}')
BEGIN
    CREATE TABLE [${STAGING_SCHEMA}].[${T_ORDERS}] (
        ID_INTEGRACJA       INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ZRODLO              NVARCHAR(32)   NOT NULL,
        ID_ZEWNETRZNY       NVARCHAR(128)  NOT NULL,
        NUMER_OBCY          NVARCHAR(160)  NOT NULL,
        DATA_ZAMOWIENIA     DATETIME2(0)   NULL,
        STATUS              NVARCHAR(24)   NOT NULL CONSTRAINT DF_INT_ZAM_STATUS DEFAULT ('NOWE'),
        KONTRAHENT_NAZWA    NVARCHAR(255)  NULL,
        KONTRAHENT_NIP      NVARCHAR(32)   NULL,
        KONTRAHENT_EMAIL    NVARCHAR(160)  NULL,
        KONTRAHENT_TELEFON  NVARCHAR(64)   NULL,
        ID_KONTRAHENTA      INT            NULL,
        ADRES_ULICA         NVARCHAR(255)  NULL,
        ADRES_KOD           NVARCHAR(16)   NULL,
        ADRES_MIASTO        NVARCHAR(128)  NULL,
        ADRES_KRAJ          NVARCHAR(8)    NULL,
        DOSTAWA_METODA      NVARCHAR(128)  NULL,
        DOSTAWA_KOSZT       DECIMAL(18,4)  NULL,
        WARTOSC_BRUTTO      DECIMAL(18,4)  NULL,
        WALUTA              NVARCHAR(8)    NULL,
        UWAGI               NVARCHAR(MAX)  NULL,
        SUROWY_JSON         NVARCHAR(MAX)  NULL,
        DATA_UTWORZENIA     DATETIME2(0)   NOT NULL CONSTRAINT DF_INT_ZAM_UTW DEFAULT (SYSDATETIME()),
        DATA_EKSPORTU       DATETIME2(0)   NULL,
        PLIK_XML            NVARCHAR(400)  NULL,
        PROB_EKSPORTU       INT            NOT NULL CONSTRAINT DF_INT_ZAM_PROBY DEFAULT (0),
        DATA_PRZETWORZENIA  DATETIME2(0)   NULL,
        ID_DOKUMENTU_WAPRO  INT            NULL,
        NUMER_DOKUMENTU     NVARCHAR(64)   NULL,
        KOMUNIKAT_BLEDU     NVARCHAR(1000) NULL,
        CONSTRAINT CK_INT_ZAM_STATUS CHECK (STATUS IN ('NOWE','WYEKSPORTOWANE','PRZETWORZONE','BLAD','POMINIETE'))
    );

    CREATE UNIQUE INDEX UQ_INT_ZAM_ZRODLO_ID
        ON [${STAGING_SCHEMA}].[${T_ORDERS}] (ZRODLO, ID_ZEWNETRZNY);

    CREATE INDEX IX_INT_ZAM_STATUS
        ON [${STAGING_SCHEMA}].[${T_ORDERS}] (STATUS, DATA_UTWORZENIA);
END`
  },
  {
    name: 'tabela ZAMOWIENIA_POZYCJE',
    sql: `
IF NOT EXISTS (SELECT 1 FROM sys.tables t
               JOIN sys.schemas s ON s.schema_id = t.schema_id
               WHERE s.name = '${STAGING_SCHEMA}' AND t.name = '${T_ITEMS}')
BEGIN
    CREATE TABLE [${STAGING_SCHEMA}].[${T_ITEMS}] (
        ID_POZYCJI      INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ID_INTEGRACJA   INT            NOT NULL,
        LP              INT            NOT NULL,
        SKU             NVARCHAR(128)  NULL,
        KOD_KRESKOWY    NVARCHAR(64)   NULL,
        NAZWA           NVARCHAR(255)  NULL,
        ILOSC           DECIMAL(18,4)  NOT NULL,
        CENA_BRUTTO     DECIMAL(18,4)  NULL,
        STAWKA_VAT      DECIMAL(9,4)   NULL,
        ID_ARTYKULU     INT            NULL,
        DOPASOWANIE     NVARCHAR(24)   NOT NULL CONSTRAINT DF_INT_POZ_DOP DEFAULT ('NIEZNANE'),
        CONSTRAINT FK_INT_POZ_ZAM FOREIGN KEY (ID_INTEGRACJA)
            REFERENCES [${STAGING_SCHEMA}].[${T_ORDERS}] (ID_INTEGRACJA) ON DELETE CASCADE,
        CONSTRAINT CK_INT_POZ_DOP CHECK (DOPASOWANIE IN ('OK','BRAK_ARTYKULU','NIEZNANE'))
    );

    CREATE INDEX IX_INT_POZ_ZAM ON [${STAGING_SCHEMA}].[${T_ITEMS}] (ID_INTEGRACJA);
    CREATE INDEX IX_INT_POZ_SKU ON [${STAGING_SCHEMA}].[${T_ITEMS}] (SKU);
END`
  },
  {
    // Migracje dla instalacji założonych wcześniejszą wersją agenta.
    // Każda sprawdza obecność kolumny/ograniczenia przed zmianą.
    name: 'migracje kolumn eksportu',
    sql: `
IF EXISTS (SELECT 1 FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
           WHERE s.name = '${STAGING_SCHEMA}' AND t.name = '${T_ORDERS}')
BEGIN
    IF COL_LENGTH('${STAGING_SCHEMA}.${T_ORDERS}', 'DATA_EKSPORTU') IS NULL
        ALTER TABLE [${STAGING_SCHEMA}].[${T_ORDERS}] ADD DATA_EKSPORTU DATETIME2(0) NULL;

    IF COL_LENGTH('${STAGING_SCHEMA}.${T_ORDERS}', 'PLIK_XML') IS NULL
        ALTER TABLE [${STAGING_SCHEMA}].[${T_ORDERS}] ADD PLIK_XML NVARCHAR(400) NULL;

    IF COL_LENGTH('${STAGING_SCHEMA}.${T_ORDERS}', 'PROB_EKSPORTU') IS NULL
        ALTER TABLE [${STAGING_SCHEMA}].[${T_ORDERS}]
            ADD PROB_EKSPORTU INT NOT NULL CONSTRAINT DF_INT_ZAM_PROBY DEFAULT (0);

    -- Rozszerzenie listy dopuszczalnych statusów o WYEKSPORTOWANE.
    IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_INT_ZAM_STATUS')
       AND NOT EXISTS (SELECT 1 FROM sys.check_constraints
                       WHERE name = 'CK_INT_ZAM_STATUS' AND definition LIKE '%WYEKSPORTOWANE%')
    BEGIN
        ALTER TABLE [${STAGING_SCHEMA}].[${T_ORDERS}] DROP CONSTRAINT CK_INT_ZAM_STATUS;
        ALTER TABLE [${STAGING_SCHEMA}].[${T_ORDERS}] ADD CONSTRAINT CK_INT_ZAM_STATUS
            CHECK (STATUS IN ('NOWE','WYEKSPORTOWANE','PRZETWORZONE','BLAD','POMINIETE'));
    END
END`
  },
  {
    name: 'indeks eksportu',
    sql: `
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_INT_ZAM_EKSPORT'
               AND object_id = OBJECT_ID('${STAGING_SCHEMA}.${T_ORDERS}'))
    CREATE INDEX IX_INT_ZAM_EKSPORT
        ON [${STAGING_SCHEMA}].[${T_ORDERS}] (STATUS, PROB_EKSPORTU, ID_INTEGRACJA);`
  },
  {
    name: 'widok DO_IMPORTU',
    sql: `
CREATE OR ALTER VIEW [${STAGING_SCHEMA}].[V_DO_IMPORTU] AS
SELECT
    z.ID_INTEGRACJA, z.ZRODLO, z.ID_ZEWNETRZNY, z.NUMER_OBCY, z.DATA_ZAMOWIENIA,
    z.KONTRAHENT_NAZWA, z.KONTRAHENT_NIP, z.KONTRAHENT_EMAIL, z.KONTRAHENT_TELEFON,
    z.ADRES_ULICA, z.ADRES_KOD, z.ADRES_MIASTO, z.ADRES_KRAJ,
    z.DOSTAWA_METODA, z.DOSTAWA_KOSZT,
    z.WARTOSC_BRUTTO, z.WALUTA, z.UWAGI,
    p.LP, p.SKU, p.KOD_KRESKOWY, p.NAZWA AS NAZWA_POZYCJI,
    p.ILOSC, p.CENA_BRUTTO, p.STAWKA_VAT,
    p.ID_ARTYKULU, p.DOPASOWANIE
FROM [${STAGING_SCHEMA}].[${T_ORDERS}] z
JOIN [${STAGING_SCHEMA}].[${T_ITEMS}] p ON p.ID_INTEGRACJA = z.ID_INTEGRACJA
WHERE z.STATUS = 'NOWE';`
  },
  {
    name: 'procedura OZNACZ_WYEKSPORTOWANE',
    sql: `
CREATE OR ALTER PROCEDURE [${STAGING_SCHEMA}].[SP_OZNACZ_WYEKSPORTOWANE]
    @ID_INTEGRACJA INT,
    @PLIK          NVARCHAR(400)
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE [${STAGING_SCHEMA}].[${T_ORDERS}]
       SET STATUS        = 'WYEKSPORTOWANE',
           DATA_EKSPORTU = SYSDATETIME(),
           PLIK_XML      = @PLIK,
           PROB_EKSPORTU = PROB_EKSPORTU + 1
     WHERE ID_INTEGRACJA = @ID_INTEGRACJA
       AND STATUS = 'NOWE';

    SELECT @@ROWCOUNT AS ZAKTUALIZOWANO;
END`
  },
  {
    name: 'procedura OZNACZ_PRZETWORZONE',
    sql: `
CREATE OR ALTER PROCEDURE [${STAGING_SCHEMA}].[SP_OZNACZ_PRZETWORZONE]
    @ID_INTEGRACJA      INT,
    @ID_DOKUMENTU_WAPRO INT           = NULL,
    @NUMER_DOKUMENTU    NVARCHAR(64)  = NULL
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE [${STAGING_SCHEMA}].[${T_ORDERS}]
       SET STATUS             = 'PRZETWORZONE',
           DATA_PRZETWORZENIA = SYSDATETIME(),
           ID_DOKUMENTU_WAPRO = @ID_DOKUMENTU_WAPRO,
           NUMER_DOKUMENTU    = @NUMER_DOKUMENTU,
           KOMUNIKAT_BLEDU    = NULL
     WHERE ID_INTEGRACJA = @ID_INTEGRACJA
       AND STATUS IN ('NOWE', 'WYEKSPORTOWANE');

    SELECT @@ROWCOUNT AS ZAKTUALIZOWANO;
END`
  },
  {
    name: 'procedura OZNACZ_BLAD',
    sql: `
CREATE OR ALTER PROCEDURE [${STAGING_SCHEMA}].[SP_OZNACZ_BLAD]
    @ID_INTEGRACJA INT,
    @KOMUNIKAT     NVARCHAR(1000)
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE [${STAGING_SCHEMA}].[${T_ORDERS}]
       SET STATUS = 'BLAD', KOMUNIKAT_BLEDU = @KOMUNIKAT
     WHERE ID_INTEGRACJA = @ID_INTEGRACJA;

    SELECT @@ROWCOUNT AS ZAKTUALIZOWANO;
END`
  }
]
