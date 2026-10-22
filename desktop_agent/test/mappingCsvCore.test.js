import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTemplate,
  classifyColumns,
  cleanCell,
  parseCsv,
  parseMappingRecords,
  templateInstructions
} from '../src/main/services/mappingCsvCore.js'

const ACCOUNTS = [
  { id: 'primary', label: 'catfish2017', accountLogin: 'catfish2017' },
  { id: 'acc_x1', label: 'Sklep 2', accountLogin: 'sklep-drugi' }
]

// Jak toCsv z exportService: pola z cudzysłowem/średnikiem w cudzysłowach.
const cell = (v) => {
  const s = v == null ? '' : String(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function toCsvText(headers, rows) {
  return [headers.map(cell).join(';'), ...rows.map((r) => r.map(cell).join(';'))].join('\r\n')
}

describe('classifyColumns', () => {
  it('nowy wzorzec: kolumna na każde konto Allegro + BaseLinker, kolumny informacyjne pomijane', () => {
    const cols = classifyColumns(
      ['indeks_wapro', 'ean', 'nazwa_wapro', 'stan_wapro', 'allegro_catfish2017_numer_oferty', 'allegro_sklep_drugi_numer_oferty', 'baselinker_id_produktu', 'zrodlo_mapowania'],
      ACCOUNTS
    )
    assert.equal(cols.sku, 'indeks_wapro')
    assert.equal(cols.ean, 'ean')
    assert.deepEqual(cols.allegro, [
      { header: 'allegro_catfish2017_numer_oferty', accountId: 'primary' },
      { header: 'allegro_sklep_drugi_numer_oferty', accountId: 'acc_x1' }
    ])
    assert.deepEqual(cols.baselinker, ['baselinker_id_produktu'])
  })

  it('stary plik / plik kontrolny: opisowe kolumny z „allegro" i „baselinker" nie są numerami', () => {
    const cols = classifyColumns(
      ['indeks_katalogowy', 'nazwa_wapro', 'allegro_nr_aukcji', 'tytul_allegro', 'kod_producenta_allegro', 'metoda_allegro', 'baselinker_product_id', 'nazwa_baselinker', 'metoda_baselinker', 'listy_zrodlowe'],
      ACCOUNTS
    )
    assert.equal(cols.sku, 'indeks_katalogowy')
    assert.deepEqual(cols.allegro, [{ header: 'allegro_nr_aukcji', accountId: '' }])
    assert.deepEqual(cols.baselinker, ['baselinker_product_id'])
  })

  it('nagłówki z polskimi znakami i spacjami', () => {
    const cols = classifyColumns(['Indeks WAPRO', 'EAN', 'Allegro Sklep 2 – numer oferty', 'BaseLinker ID produktu'], ACCOUNTS)
    assert.equal(cols.sku, 'indeks_wapro')
    assert.deepEqual(cols.allegro, [{ header: 'allegro_sklep_2_numer_oferty', accountId: 'acc_x1' }])
    assert.deepEqual(cols.baselinker, ['baselinker_id_produktu'])
  })
})

describe('parseMappingRecords — oba / jedno / żadne', () => {
  const headers = ['indeks_wapro', 'ean', 'allegro_catfish2017_numer_oferty', 'allegro_sklep_drugi_numer_oferty', 'baselinker_id_produktu']
  const cols = classifyColumns(headers, ACCOUNTS)
  const { records } = parseCsv(
    toCsvText(headers, [
      ['A-1', '590', '12976534486', '', '652215706'], // Allegro (konto 1) + BL
      ['A-2', '', '', '16253991173', ''], // tylko Allegro konto 2
      ['A-3', '', '', '', '700'], // tylko BL
      ['A-4', '', '', '', ''], // nic
      ['A-5', '', '1,29765E+10', '', ''], // Excel zepsuł numer
      ['', '', '12345678901', '', ''] // brak klucza
    ])
  )
  const { items, errors, empty } = parseMappingRecords(records, cols)

  it('mapuje dokładnie to, co wpisano', () => {
    assert.deepEqual(items, [
      { line: 2, sku: 'A-1', ean: '590', allegro: [{ offerId: '12976534486', accountId: 'primary' }], baselinker: '652215706' },
      { line: 3, sku: 'A-2', ean: '', allegro: [{ offerId: '16253991173', accountId: 'acc_x1' }], baselinker: '' },
      { line: 4, sku: 'A-3', ean: '', allegro: [], baselinker: '700' }
    ])
    assert.equal(empty, 1)
  })

  it('zgłasza notację naukową i brak klucza z numerem wiersza', () => {
    assert.equal(errors.length, 2)
    assert.equal(errors[0].line, 6)
    assert.match(errors[0].message, /notacji naukowej/)
    assert.equal(errors[1].line, 7)
    assert.match(errors[1].message, /brak indeksu/)
  })
})

describe('wzorzec', () => {
  it('ma kolumnę na każde konto, jest wypełniony obecnymi mapowaniami i wraca bez strat po imporcie', () => {
    const wapro = [
      { sku: '00-30-71-30-0125', ean: '5901828825217', name: 'Atraktor', quantity: 4 },
      { sku: '00-40-00-00-0500', ean: '', name: 'Booster', quantity: 0 }
    ]
    const existing = {
      allegro: new Map([
        ['primary', new Map([['00-30-71-30-0125', { offerId: '12976534486', via: 'manual' }]])],
        ['acc_x1', new Map([['00-30-71-30-0125', { offerId: '17000000001', via: 'name' }]])]
      ]),
      baselinker: new Map([['00-40-00-00-0500', { offerId: '652215706', via: 'manual' }]])
    }
    const { headers, rows } = buildTemplate(wapro, ACCOUNTS, existing)
    assert.deepEqual(headers, [
      'indeks_wapro', 'ean', 'nazwa_wapro', 'stan_wapro',
      'allegro_catfish2017_numer_oferty', 'allegro_sklep_drugi_numer_oferty',
      'baselinker_id_produktu', 'zrodlo_mapowania'
    ])
    assert.equal(rows[0][1], '="5901828825217"') // EAN chroniony przed Excelem
    assert.match(rows[0][7], /sklep_drugi: auto: nazwa — sprawdź!/)

    const { records } = parseCsv(toCsvText(headers, rows))
    const { items, errors } = parseMappingRecords(records, classifyColumns(headers, ACCOUNTS))
    assert.deepEqual(errors, [])
    assert.deepEqual(items[0].allegro, [
      { offerId: '12976534486', accountId: 'primary' },
      { offerId: '17000000001', accountId: 'acc_x1' }
    ])
    assert.equal(items[0].ean, '5901828825217')
    assert.equal(items[1].baselinker, '652215706')
  })

  it('instrukcja opisuje kolumny każdego konta', () => {
    const txt = templateInstructions(ACCOUNTS, 'mapowanie.csv')
    assert.match(txt, /allegro_catfish2017_numer_oferty .*catfish2017/)
    assert.match(txt, /allegro_sklep_drugi_numer_oferty .*Sklep 2/)
    assert.match(txt, /tylko jedno → mapujemy tylko ten kanał/)
  })

  it('cleanCell zdejmuje ="…" i spacje', () => {
    assert.equal(cleanCell('="00123"'), '00123')
    assert.equal(cleanCell(" 129 765 "), '129765')
    assert.equal(cleanCell('=00123'), '00123') // ="…" po przejściu przez parser bez cudzysłowów
  })
})

describe('konta w nagłówkach eksportów', () => {
  it('konto nazwane samą liczbą dostaje czytelny nagłówek i jest rozpoznawane przy imporcie', async () => {
    const { accountSlug, allegroColumnHeader, allegroStockHeader } = await import('../src/main/services/mappingCsvCore.js')
    const acc = { id: 'acc_2', label: '1', accountLogin: '' }
    assert.equal(accountSlug(acc), 'konto_1')
    assert.equal(allegroColumnHeader(acc), 'allegro_konto_1_numer_oferty')
    assert.equal(allegroStockHeader(ACCOUNTS[0]), 'stan_allegro_catfish2017')
    const cols = classifyColumns(['indeks_wapro', 'allegro_konto_1_numer_oferty', 'stan_allegro_konto_1'], [acc])
    assert.deepEqual(cols.allegro, [{ header: 'allegro_konto_1_numer_oferty', accountId: 'acc_2' }])
  })

  it('plik połączony z eksportu da się wgrać jako mapowanie (kolumny stanu pomijane)', () => {
    const cols = classifyColumns(
      ['indeks_wapro', 'ean', 'nazwa_wapro', 'stan_wapro', 'allegro_catfish2017_numer_oferty', 'stan_allegro_catfish2017',
        'allegro_sklep_drugi_numer_oferty', 'stan_allegro_sklep_drugi', 'baselinker_id_produktu', 'stan_baselinker', 'rozjazd'],
      ACCOUNTS
    )
    assert.deepEqual(cols.allegro.map((c) => c.accountId), ['primary', 'acc_x1'])
    assert.deepEqual(cols.baselinker, ['baselinker_id_produktu'])
  })

  it('buildAccountOfferFinder: mapowanie oferta → indeks wygrywa z sygnaturą, potem EAN i nazwa', async () => {
    const { buildAccountOfferFinder } = await import('../src/main/services/mappingCsvCore.js')
    const offers = [
      { offerId: '1', sku: 'A-1', ean: '', name: 'Kulki truskawka' },
      { offerId: '2', sku: '', ean: '590', name: 'Booster' },
      { offerId: '3', sku: '', ean: '', name: 'Atraktor anyż' }
    ]
    const find = buildAccountOfferFinder(offers, new Map([['3', 'A-1']]))
    assert.equal(find({ sku: 'A-1' }).offerId, '3')
    assert.equal(find({ sku: 'X', ean: '590' }).offerId, '2')
    assert.equal(find({ sku: 'Y', name: 'Kulki truskawka' }).offerId, '1')
    assert.equal(find({ sku: 'Z', name: 'nie ma' }), null)
  })
})
