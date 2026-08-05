import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreTableForRole,
  suggestTablesByRole,
  mergeProfile,
  sectionSchema,
  sectionRef,
  requiredObjects,
  resolveStockColumns,
  optionalColumnExpr
} from '../src/main/wapro/schemaMap.js'

describe('scoreTableForRole — dopasowanie po frazach', () => {
  it('rozpoznaje tabelę produktów po różnych nazwach', () => {
    assert.ok(scoreTableForRole('ARTYKULY', 'artykuly') > 0)
    assert.ok(scoreTableForRole('TW__Towary', 'artykuly') > 0)
    assert.ok(scoreTableForRole('Produkty', 'artykuly') > 0)
    assert.equal(scoreTableForRole('MAGAZYNY', 'artykuly'), 0)
  })

  it('rozpoznaje tabelę stanów, także z prefiksem', () => {
    assert.ok(scoreTableForRole('STANY_MAGAZYNOWE', 'stany') > 0)
    assert.ok(scoreTableForRole('ST_StanyTowarow', 'stany') > 0)
  })

  it('STANY_MAGAZYNOWE wygrywa dla roli stany nad rolą magazyny', () => {
    const asStany = scoreTableForRole('STANY_MAGAZYNOWE', 'stany')
    const asMagazyny = scoreTableForRole('STANY_MAGAZYNOWE', 'magazyny')
    assert.ok(asStany > asMagazyny)
  })

  it('czysta MAGAZYNY wygrywa dla roli magazyny nad STANY_MAGAZYNOWE', () => {
    const magazyny = scoreTableForRole('MAGAZYNY', 'magazyny')
    const stanyAsMag = scoreTableForRole('STANY_MAGAZYNOWE', 'magazyny')
    assert.ok(magazyny > stanyAsMag)
  })

  it('nie dopasowuje nazw bez słów kluczowych', () => {
    assert.equal(scoreTableForRole('KONTRAHENCI', 'stany'), 0)
    assert.equal(scoreTableForRole('FAKTURY', 'artykuly'), 0)
  })
})

describe('suggestTablesByRole — ranking z realnej listy', () => {
  const tables = [
    { name: 'ARTYKULY', schema: 'dbo', fullName: 'dbo.ARTYKULY' },
    { name: 'STANY_MAGAZYNOWE', schema: 'dbo', fullName: 'dbo.STANY_MAGAZYNOWE' },
    { name: 'MAGAZYNY', schema: 'dbo', fullName: 'dbo.MAGAZYNY' },
    { name: 'KONTRAHENCI', schema: 'dbo', fullName: 'dbo.KONTRAHENCI' },
    { name: 'TW_Towar', schema: 'wapro', fullName: 'wapro.TW_Towar' }
  ]

  it('typuje właściwe tabele na pierwszym miejscu', () => {
    const s = suggestTablesByRole(tables)
    assert.equal(s.artykuly[0].name, 'ARTYKULY')
    assert.equal(s.stany[0].name, 'STANY_MAGAZYNOWE')
    assert.equal(s.magazyny[0].name, 'MAGAZYNY')
  })

  it('nie wrzuca kontrahentów do żadnej roli', () => {
    const s = suggestTablesByRole(tables)
    for (const role of ['artykuly', 'stany', 'magazyny']) {
      assert.ok(!s[role].some((t) => t.name === 'KONTRAHENCI'))
    }
  })

  it('zachowuje schemat w sugestii (tabele rozproszone)', () => {
    const s = suggestTablesByRole(tables)
    assert.ok(s.artykuly.some((t) => t.schema === 'wapro' && t.name === 'TW_Towar'))
  })
})

describe('schemat per sekcja (tabele rozproszone)', () => {
  it('sekcja dziedziczy globalny schemat, gdy własnego brak', () => {
    const map = mergeProfile({ schema: 'wapro' })
    assert.equal(sectionSchema(map, 'artykuly'), 'wapro')
  })

  it('sekcja może mieć własny schemat', () => {
    const map = mergeProfile({ schema: 'dbo', stany: { schema: 'magazyn', table: 'STANY' } })
    assert.equal(sectionSchema(map, 'stany'), 'magazyn')
    assert.equal(sectionRef(map, 'stany'), '[magazyn].[STANY]')
    // Artykuły nadal na globalnym schemacie.
    assert.equal(sectionSchema(map, 'artykuly'), 'dbo')
  })

  it('requiredObjects niesie schemat i sekcję', () => {
    const map = mergeProfile({ artykuly: { schema: 'a', table: 'T_ART' } })
    const objs = requiredObjects(map)
    const art = objs.find((o) => o.section === 'artykuly')
    assert.equal(art.schema, 'a')
    assert.equal(art.table, 'T_ART')
  })
})

describe('resolveStockColumns — adaptacja do realnych kolumn Wapro', () => {
  const map = mergeProfile()
  // Typowy „pełny" zestaw kolumn.
  const artFull = ['ID_ARTYKULU', 'NAZWA', 'INDEKS_KATALOGOWY', 'INDEKS_HANDLOWY', 'PODSTAWOWY_KOD_KRESKOWY', 'ARCHIWALNY']
  const stanyFull = ['ID_ARTYKULU', 'ID_MAGAZYNU', 'STAN', 'REZERWACJA']

  it('pełny schemat — wszystko rozwiązane, brak braków', () => {
    const c = resolveStockColumns(map, artFull, stanyFull)
    assert.equal(c.quantity, 'STAN')
    assert.equal(c.reserved, 'REZERWACJA')
    assert.deepEqual(c.missingRequired, [])
  })

  it('brak REZERWACJA — reserved=null, BEZ błędu (opcjonalna)', () => {
    const c = resolveStockColumns(map, artFull, ['ID_ARTYKULU', 'ID_MAGAZYNU', 'STAN'])
    assert.equal(c.reserved, null)
    assert.equal(c.quantity, 'STAN')
    assert.deepEqual(c.missingRequired, [])
    assert.ok(c.droppedOptional.includes('rezerwacja'))
  })

  it('brak kolumny stanu — zgłoszone jako wymagane', () => {
    const c = resolveStockColumns(map, artFull, ['ID_ARTYKULU', 'ID_MAGAZYNU'])
    assert.equal(c.quantity, null)
    assert.ok(c.missingRequired.some((m) => /stan|ilo/i.test(m)))
  })

  it('alternatywne nazwy: ILOSC zamiast STAN, EAN zamiast PODSTAWOWY_KOD_KRESKOWY', () => {
    const c = resolveStockColumns(
      map,
      ['ID_TOWARU', 'NAZWA_TOWARU', 'SYMBOL', 'EAN'],
      ['ID_TOWARU', 'ID_MAGAZYNU', 'ILOSC']
    )
    assert.equal(c.quantity, 'ILOSC')
    assert.equal(c.barcode, 'EAN')
    assert.equal(c.artId, 'ID_TOWARU')
    assert.deepEqual(c.skuColumns, ['SYMBOL'])
    assert.deepEqual(c.missingRequired, [])
  })

  it('honoruje nazwy z mapy schematu przed domyślnymi', () => {
    const custom = mergeProfile({ stany: { quantity: 'STAN_WLASNY' } })
    const c = resolveStockColumns(custom, artFull, ['ID_ARTYKULU', 'ID_MAGAZYNU', 'STAN_WLASNY', 'STAN'])
    assert.equal(c.quantity, 'STAN_WLASNY')
  })

  it('brak jakiejkolwiek kolumny SKU — wymagane', () => {
    const c = resolveStockColumns(map, ['ID_ARTYKULU', 'NAZWA'], stanyFull)
    assert.equal(c.skuColumns.length, 0)
    assert.ok(c.missingRequired.some((m) => /SKU|indeks/i.test(m)))
  })
})

describe('optionalColumnExpr — plastyczne wyrażenia z fallbackiem', () => {
  it('brak kolumny → literał domyślny', () => {
    assert.equal(optionalColumnExpr(null, { alias: 'a', defaultSql: "CAST('' AS NVARCHAR(1))" }), "CAST('' AS NVARCHAR(1))")
    assert.equal(optionalColumnExpr(null, { alias: 's', defaultSql: '0' }), '0')
  })

  it('kolumna istnieje → cytowany odnośnik z aliasem', () => {
    assert.equal(optionalColumnExpr('EAN', { alias: 'a', defaultSql: "''" }), 'a.[EAN]')
  })

  it('kolumna bez aliasu', () => {
    assert.equal(optionalColumnExpr('STAN', { defaultSql: '0' }), '[STAN]')
  })

  it('odrzuca wstrzyknięcie w nazwie kolumny', () => {
    assert.throws(() => optionalColumnExpr('X]; DROP TABLE', { alias: 'a', defaultSql: '0' }), /Nieprawidłowy/)
  })

  it('zapewnia jednakowy kształt niezależnie od wersji Wapro', () => {
    // Brak REZERWACJA/ARCHIWALNY/EAN — wszystkie sprowadzone do bezpiecznych literałów.
    const map = mergeProfile()
    const c = resolveStockColumns(map, ['ID_ARTYKULU', 'NAZWA', 'INDEKS_KATALOGOWY'], ['ID_ARTYKULU', 'ID_MAGAZYNU', 'STAN'])
    assert.equal(optionalColumnExpr(c.reserved, { alias: 's', defaultSql: '0' }), '0')
    assert.equal(optionalColumnExpr(c.archived, { alias: 'a', defaultSql: '0' }), '0')
    assert.equal(optionalColumnExpr(c.barcode, { alias: 'a', defaultSql: "CAST('' AS NVARCHAR(1))" }), "CAST('' AS NVARCHAR(1))")
  })
})
