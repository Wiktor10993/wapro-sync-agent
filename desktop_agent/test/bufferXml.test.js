import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildEcoFromBuffer } from '../src/main/wapro/ecoXml.js'

/** Nagłówek w kształcie zwracanym przez integracja.V_DO_IMPORTU. */
const header = {
  ID_INTEGRACJA: 42,
  ZRODLO: 'allegro',
  ID_ZEWNETRZNY: 'DEMO-ALLEGRO-1',
  NUMER_OBCY: 'ALLEGRO-DEMO-ALLEGRO-1',
  DATA_ZAMOWIENIA: new Date('2026-07-30T09:15:00Z'),
  KONTRAHENT_NAZWA: 'Jan Kowalski & Syn',
  KONTRAHENT_NIP: '5252445767',
  KONTRAHENT_EMAIL: 'jan@example.pl',
  KONTRAHENT_TELEFON: '600100200',
  ADRES_ULICA: 'Długa 5/<b>2</b>',
  ADRES_KOD: '00-001',
  ADRES_MIASTO: 'Warszawa',
  ADRES_KRAJ: 'PL',
  DOSTAWA_METODA: 'Kurier DPD',
  DOSTAWA_KOSZT: 15.99,
  WARTOSC_BRUTTO: 108.28,
  WALUTA: 'PLN',
  UWAGI: 'Proszę o fakturę'
}

const items = [
  {
    LP: 1,
    SKU: 'WIERT-06',
    KOD_KRESKOWY: '5901234000016',
    NAZWA_POZYCJI: 'Wiertło HSS 6 mm',
    ILOSC: 3,
    CENA_BRUTTO: 24.9,
    STAWKA_VAT: 23,
    ID_ARTYKULU: 1,
    DOPASOWANIE: 'OK'
  },
  {
    LP: 2,
    SKU: '99999999999',
    KOD_KRESKOWY: null,
    NAZWA_POZYCJI: 'Towar spoza kartoteki "X"',
    ILOSC: 1,
    CENA_BRUTTO: 9.99,
    STAWKA_VAT: null,
    ID_ARTYKULU: null,
    DOPASOWANIE: 'BRAK_ARTYKULU'
  }
]

describe('buildEcoFromBuffer', () => {
  const xml = buildEcoFromBuffer(header, items)

  it('zaczyna się deklaracją XML i typem ZO', () => {
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
    assert.match(xml, /<TYP>ZO<\/TYP>/)
  })

  it('przenosi identyfikator bufora — kluczowy do sprzężenia zwrotnego', () => {
    assert.match(xml, /<ID_BUFORA>42<\/ID_BUFORA>/)
  })

  it('wypełnia ID_ARTYKULU dla dopasowanej pozycji', () => {
    assert.match(xml, /<ID_ARTYKULU>1<\/ID_ARTYKULU>/)
  })

  it('zostawia ID_ARTYKULU puste zamiast wpisywać 0 albo NULL', () => {
    assert.match(xml, /<ID_ARTYKULU><\/ID_ARTYKULU>/)
    assert.ok(!xml.includes('<ID_ARTYKULU>null</ID_ARTYKULU>'))
    assert.ok(!xml.includes('<ID_ARTYKULU>0</ID_ARTYKULU>'))
  })

  it('przenosi status dopasowania, żeby operator wiedział co sprawdzić', () => {
    assert.match(xml, /<DOPASOWANIE>OK<\/DOPASOWANIE>/)
    assert.match(xml, /<DOPASOWANIE>BRAK_ARTYKULU<\/DOPASOWANIE>/)
  })

  it('escapuje ampersand i znaczniki w danych klienta', () => {
    assert.match(xml, /<NAZWA>Jan Kowalski &amp; Syn<\/NAZWA>/)
    assert.match(xml, /<ULICA>Długa 5\/&lt;b&gt;2&lt;\/b&gt;<\/ULICA>/)
    assert.match(xml, /Towar spoza kartoteki &quot;X&quot;/)
  })

  it('formatuje ilość z czterema miejscami, cenę z dwoma', () => {
    assert.match(xml, /<ILOSC>3\.0000<\/ILOSC>/)
    assert.match(xml, /<CENA_BRUTTO>24\.90<\/CENA_BRUTTO>/)
    assert.match(xml, /<KOSZT>15\.99<\/KOSZT>/)
  })

  it('przyjmuje obiekt Date z sterownika mssql', () => {
    assert.match(xml, /<DATA>2026-07-30<\/DATA>/)
  })

  it('zostawia pustą stawkę VAT zamiast wpisywać 0', () => {
    assert.match(xml, /<STAWKA_VAT>23\.00<\/STAWKA_VAT>/)
    assert.match(xml, /<STAWKA_VAT><\/STAWKA_VAT>/)
  })

  it('generuje tyle POZYCJI, ile jest wierszy', () => {
    assert.equal([...xml.matchAll(/<POZYCJA>/g)].length, 2)
  })

  it('ma zbalansowane znaczniki', () => {
    const stack = []
    for (const t of xml.matchAll(/<(\/?)([A-Z_]+)>/g)) {
      if (t[1] === '') stack.push(t[2])
      else assert.equal(stack.pop(), t[2], `niedopasowany tag ${t[2]}`)
    }
    assert.equal(stack.length, 0)
  })
})

describe('buildEcoFromBuffer — dane brzegowe', () => {
  it('nie wywraca się na pustym nagłówku i braku pozycji', () => {
    const xml = buildEcoFromBuffer({}, [])
    assert.ok(xml.includes('<TYP>ZO</TYP>'))
    assert.match(xml, /<ID_BUFORA>0<\/ID_BUFORA>/)
    assert.equal([...xml.matchAll(/<POZYCJA>/g)].length, 0)
  })

  it('podstawia PLN i PL, gdy waluta i kraj są puste', () => {
    const xml = buildEcoFromBuffer({ ID_INTEGRACJA: 1 }, [])
    assert.match(xml, /<WALUTA>PLN<\/WALUTA>/)
    assert.match(xml, /<KRAJ>PL<\/KRAJ>/)
  })

  it('podstawia dzisiejszą datę przy braku daty zamówienia', () => {
    const xml = buildEcoFromBuffer({ ID_INTEGRACJA: 1 }, [])
    assert.match(xml, new RegExp(`<DATA>${new Date().toISOString().slice(0, 10)}</DATA>`))
  })

  it('odporny na niepoprawną datę z bazy', () => {
    const xml = buildEcoFromBuffer({ ID_INTEGRACJA: 1, DATA_ZAMOWIENIA: 'to-nie-jest-data' }, [])
    assert.match(xml, /<DATA>\d{4}-\d{2}-\d{2}<\/DATA>/)
  })

  it('traktuje nieliczbową kwotę jako zero, nie jako NaN', () => {
    const xml = buildEcoFromBuffer(
      { ID_INTEGRACJA: 1, DOSTAWA_KOSZT: 'brak' },
      [{ LP: 1, SKU: 'A', ILOSC: 'x', CENA_BRUTTO: undefined }]
    )
    assert.ok(!xml.includes('NaN'))
    assert.match(xml, /<KOSZT>0\.00<\/KOSZT>/)
    assert.match(xml, /<CENA_BRUTTO>0\.00<\/CENA_BRUTTO>/)
  })

  it('akceptuje items jako null', () => {
    const xml = buildEcoFromBuffer({ ID_INTEGRACJA: 5 }, null)
    assert.ok(xml.includes('<POZYCJE>'))
  })
})
