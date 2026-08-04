import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeProfile, qualified, quoteIdent, requiredObjects, WFMAG_DEFAULT } from '../src/main/wapro/schemaMap.js'

describe('quoteIdent — ochrona przed wstrzyknięciem', () => {
  it('przepuszcza poprawne identyfikatory', () => {
    assert.equal(quoteIdent('ARTYKULY'), '[ARTYKULY]')
    assert.equal(quoteIdent('ID_ARTYKULU'), '[ID_ARTYKULU]')
    assert.equal(quoteIdent('_tmp$1'), '[_tmp$1]')
  })

  const attacks = [
    'STAN]; DROP TABLE ARTYKULY--',
    'STAN] FROM x WHERE 1=1--',
    "STAN' OR '1'='1",
    'STAN UNION SELECT 1',
    '',
    '1STAN',
    'a'.repeat(200),
    'STAN;',
    'STAN--'
  ]

  for (const attack of attacks) {
    it(`odrzuca: ${JSON.stringify(attack.slice(0, 40))}`, () => {
      assert.throws(() => quoteIdent(attack), /Nieprawidłowy/)
    })
  }

  it('odrzuca wartości nie będące stringiem', () => {
    assert.throws(() => quoteIdent(null))
    assert.throws(() => quoteIdent(123))
    assert.throws(() => quoteIdent({ toString: () => 'ARTYKULY' }))
  })
})

describe('qualified', () => {
  it('cytuje schemat i tabelę osobno', () => {
    assert.equal(qualified('dbo', 'ARTYKULY'), '[dbo].[ARTYKULY]')
  })

  it('odrzuca zmanipulowany schemat', () => {
    assert.throws(() => qualified('dbo].[sys', 'ARTYKULY'))
  })
})

describe('mergeProfile', () => {
  it('bez nadpisań zwraca profil domyślny', () => {
    const m = mergeProfile()
    assert.equal(m.artykuly.table, 'ARTYKULY')
    assert.equal(m.stany.table, 'STANY_MAGAZYNOWE')
    assert.equal(m.schema, 'dbo')
  })

  it('nadpisuje pojedyncze pole, zachowując resztę sekcji', () => {
    const m = mergeProfile({ stany: { quantity: 'ILOSC' } })
    assert.equal(m.stany.quantity, 'ILOSC')
    assert.equal(m.stany.articleId, WFMAG_DEFAULT.stany.articleId)
  })

  it('pozwala zmienić schemat', () => {
    assert.equal(mergeProfile({ schema: 'wapro' }).schema, 'wapro')
  })

  it('ignoruje pusty schemat', () => {
    assert.equal(mergeProfile({ schema: '   ' }).schema, 'dbo')
  })

  it('nie mutuje profilu domyślnego', () => {
    mergeProfile({ artykuly: { table: 'INNE' } })
    assert.equal(WFMAG_DEFAULT.artykuly.table, 'ARTYKULY')
  })
})

describe('requiredObjects', () => {
  const objects = requiredObjects(mergeProfile())

  it('wskazuje trzy tabele potrzebne do SyncUp', () => {
    assert.deepEqual(objects.map((o) => o.table), ['ARTYKULY', 'STANY_MAGAZYNOWE', 'MAGAZYNY'])
  })

  it('oznacza kolumny stanów jako wymagane', () => {
    const stany = objects.find((o) => o.table === 'STANY_MAGAZYNOWE')
    assert.ok(stany.required.includes('STAN'))
    assert.ok(stany.required.includes('ID_MAGAZYNU'))
  })

  it('rezerwacja jest opcjonalna', () => {
    const stany = objects.find((o) => o.table === 'STANY_MAGAZYNOWE')
    assert.ok(stany.columns.includes('REZERWACJA'))
    assert.ok(!stany.required.includes('REZERWACJA'))
  })

  it('pomija pola null w mapie', () => {
    const objects2 = requiredObjects(mergeProfile({ artykuly: { archivedFlag: null, typeColumn: null } }))
    const art = objects2.find((o) => o.table === 'ARTYKULY')
    assert.ok(!art.columns.includes(null))
  })
})
