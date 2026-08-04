import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreTableForRole,
  suggestTablesByRole,
  mergeProfile,
  sectionSchema,
  sectionRef,
  requiredObjects
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
