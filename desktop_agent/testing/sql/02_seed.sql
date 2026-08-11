/* ==========================================================================
   Dane testowe — branża wędkarska (woblery, kulki proteinowe, kołowrotki).
   Zaprojektowane pod testy silnika dopasowań:
     - nazwy z SZUMEM marketingowym (HIT!, GRATIS, PROMOCJA, MEGA, SUPER OKAZJA, nowość),
     - WARIANTY różniące się parametrem (8cm/12cm, 16mm/20mm/24mm, 3000/6000/8000),
     - pozycje z EAN (poziom 1), tylko z SKU (poziom 2), tylko z nazwą (poziom 3),
     - near-duplikaty nazw (kandydaci do „Wymaga weryfikacji"),
     - ZABLOKOWANY = 1 (pomijany), ZAREZERWOWANO (stan efektywny = STAN - REZ).
   ========================================================================== */

USE WAPRO;
GO

DELETE FROM dbo.KOD_KRESKOWY;
DELETE FROM dbo.ARTYKUL;
DELETE FROM dbo.MAGAZYN;
GO

SET IDENTITY_INSERT dbo.MAGAZYN ON;
INSERT INTO dbo.MAGAZYN (ID_MAGAZYNU, NAZWA, SYMBOL) VALUES (1, N'Magazyn Główny', 'MG');
SET IDENTITY_INSERT dbo.MAGAZYN OFF;
GO

/* NAZWA | INDEKS_KATALOGOWY | KOD_KRESKOWY | STAN | ZAREZERWOWANO | ZABLOKOWANY */
INSERT INTO dbo.ARTYKUL (ID_MAGAZYNU, NAZWA, INDEKS_KATALOGOWY, INDEKS_HANDLOWY, KOD_KRESKOWY, STAN, ZAREZERWOWANO, ZABLOKOWANY) VALUES
  -- WOBLERY --------------------------------------------------------------
  (1, N'HIT! Wobler Salmo Perch 8cm Floating GRATIS',  'SAL-PER-08F', '', '5901234000018', 12, 2, 0), -- poziom 1 (EAN), stan efekt. 10
  (1, N'Wobler Salmo Perch 12cm Floating',             'SAL-PER-12F', '', '5901234000025',  7, 0, 0), -- wariant 12cm (param)
  (1, N'MEGA Wobler Rapala CountDown 7cm Sinking PROMOCJA', 'RAP-CD-07S', '', '',            20, 0, 0), -- poziom 2 (tylko SKU)
  (1, N'Wobler Jaxon Karaś 5cm Wzór Naturalny',        '',            '', '',                 5, 0, 0), -- poziom 3 (tylko nazwa)
  -- KULKI PROTEINOWE (boilies) ------------------------------------------
  (1, N'Kulki Proteinowe SUPER Truskawka 16mm 1kg',    'KP-TRU-16',   '', '5901234000032',  30, 0, 0), -- poziom 1 (EAN)
  (1, N'Kulki Proteinowe Truskawka 20mm 1kg PROMOCJA', 'KP-TRU-20',   '', '5901234000049',  25, 5, 0), -- wariant 20mm, stan efekt. 20
  (1, N'Kulki Proteinowe Truskawka 24mm 1kg',          'KP-TRU-24',   '', '',                18, 0, 0), -- wariant 24mm (tylko SKU)
  (1, N'Kulki Zanętowe Skopex Miód 18mm',              '',            '', '',                40, 0, 0), -- poziom 3 (nazwa)
  (1, N'Kulki Proteinowe Wanilia 20mm',                '',            '', '',                15, 0, 0), -- near-duplikat A (nazwa)
  (1, N'Kulki Proteinowe Wanilla 20mm',                '',            '', '',                10, 0, 0), -- near-duplikat B (literówka) → ryzyko NEEDS_REVIEW
  -- KOŁOWROTKI (reels) --------------------------------------------------
  (1, N'Kołowrotek Shimano Baitrunner 6000 SUPER OKAZJA', 'SHI-BR-6000', '', '5901234000056', 8, 1, 0), -- poziom 1 (EAN), stan efekt. 7
  (1, N'Kołowrotek Shimano Baitrunner 8000',           'SHI-BR-8000', '', '5901234000063',   4, 0, 0), -- wariant 8000
  (1, N'Kołowrotek Daiwa Ninja 3000 nowość',           'DAI-NIN-3000','', '',                 6, 0, 0), -- poziom 2/3
  -- PRZYPADKI BRZEGOWE ---------------------------------------------------
  (1, N'ARCHIWALNY Wobler Stary Model 9cm',            'OLD-WOB-09',  '', '5901234000070',   3, 0, 1), -- ZABLOKOWANY → pomijany
  (1, N'Podbierak Delphin Omega Carp',                 'PDB-OMEGA',   '', '',                 3, 3, 0); -- stan efektywny 0 (STAN - REZ)
GO

/* WĘDKI + mocne zniekształcenia nazw (test Fuzzy Matchingu na żywo).
   Te same produkty co na kanale, ale z: brakiem polskich znaków, inną jednostką
   (m/cm), spacjami w modelu, szumem — automat musi je „dogadać" po nazwie. */
INSERT INTO dbo.ARTYKUL (ID_MAGAZYNU, NAZWA, INDEKS_KATALOGOWY, INDEKS_HANDLOWY, KOD_KRESKOWY, STAN, ZAREZERWOWANO, ZABLOKOWANY) VALUES
  (1, N'Wędka Robinson Vobler Spin 2.40m 5-25g HIT!',   'ROB-VSP-240', '', '5901234000100', 9, 0, 0), -- EAN
  (1, N'Wedka Robinson Vobler Spin 240cm 5-25g',        '',            '', '',                4, 0, 0), -- zniekształcenie (bez PL znaków, cm zamiast m) → fuzzy
  (1, N'Wędka Mikado X-Plode Feeder 3,60m PROMOCJA',    'MIK-XPL-360', '', '',                6, 0, 0), -- tylko SKU / nazwa
  (1, N'WEDKA MIKADO XPLODE FEEDER 360',                '',            '', '',                2, 0, 0), -- mocne zniekształcenie tego samego modelu
  (1, N'Kołowrotek Shimano Baitrunner 6000 SUPER OKAZJA','',           '', '',                3, 0, 0), -- near-duplikat modelu 6000 (jest już wariant z EAN)
  (1, N'Kolowrotek SHIMANO Bait Runner 6000',           '',            '', '',                1, 0, 0); -- zniekształcenie (spacja w modelu, bez PL znaków)
GO

/* Dodatkowe kody EAN (wiele na artykuł) — tabela KOD_KRESKOWY.
   Np. dla kulek 16mm dokładamy drugi kod (opakowanie zbiorcze). */
INSERT INTO dbo.KOD_KRESKOWY (ID_MAGAZYNU, KOD_KRESKOWY, ID_ARTYKULU)
SELECT 1, '5909999000032', ID_ARTYKULU FROM dbo.ARTYKUL WHERE INDEKS_KATALOGOWY = 'KP-TRU-16';
GO

/* Szybka kontrola: ile pozycji zobaczy agent (bez ZABLOKOWANYCH). */
SELECT COUNT(*) AS widoczne_pozycje
FROM dbo.ARTYKUL
WHERE ISNULL(ZABLOKOWANY,0) = 0
  AND COALESCE(NULLIF(LTRIM(RTRIM(INDEKS_KATALOGOWY)),''), NULLIF(LTRIM(RTRIM(INDEKS_HANDLOWY)),''), NULLIF(NAZWA,'')) IS NOT NULL;
GO
