import { normalizeOrder } from './orderNormalizer.js'

/**
 * Generator dokumentu XML w formacie importu ECO dla Wapro Mag.
 *
 * Wydzielony z syncService, żeby dało się go testować bez ładowania Electrona
 * i sterownika MSSQL.
 *
 * UWAGA: dokładna struktura ECO różni się między wersjami Wapro. Poniższy układ
 * odpowiada typowemu zamówieniu od odbiorcy (ZO). Przed wdrożeniem porównaj go
 * z plikiem wyeksportowanym z docelowej instalacji
 * (Wapro Mag → Narzędzia → Eksport ECO) i skoryguj nazwy elementów.
 */

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * @param {object} raw surowe zamówienie z huba
 * @param {'allegro'|'baselinker'} source
 * @returns {string}
 */
export function buildEcoOrderXml(raw, source) {
  const order = normalizeOrder(raw, source)

  const positions = order.items
    .map(
      (item) => `      <POZYCJA>
        <LP>${item.lp}</LP>
        <INDEKS_KATALOGOWY>${xmlEscape(item.sku || item.fallbackRef)}</INDEKS_KATALOGOWY>
        <KOD_KRESKOWY>${xmlEscape(item.barcode)}</KOD_KRESKOWY>
        <NAZWA>${xmlEscape(item.name)}</NAZWA>
        <ILOSC>${item.quantity}</ILOSC>
        <CENA_BRUTTO>${item.priceGross.toFixed(2)}</CENA_BRUTTO>
      </POZYCJA>`
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<ECO>
  <DOKUMENT>
    <TYP>ZO</TYP>
    <NUMER_OBCY>${xmlEscape(order.documentRef)}</NUMER_OBCY>
    <DATA>${(order.orderedAt ?? new Date().toISOString()).slice(0, 10)}</DATA>
    <WALUTA>${xmlEscape(order.currency)}</WALUTA>
    <KONTRAHENT>
      <NAZWA>${xmlEscape(order.buyer.name)}</NAZWA>
      <NIP>${xmlEscape(order.buyer.taxId)}</NIP>
      <EMAIL>${xmlEscape(order.buyer.email)}</EMAIL>
      <TELEFON>${xmlEscape(order.buyer.phone)}</TELEFON>
      <ULICA>${xmlEscape(order.delivery.street)}</ULICA>
      <KOD_POCZTOWY>${xmlEscape(order.delivery.postCode)}</KOD_POCZTOWY>
      <MIEJSCOWOSC>${xmlEscape(order.delivery.city)}</MIEJSCOWOSC>
      <KRAJ>${xmlEscape(order.delivery.countryCode)}</KRAJ>
    </KONTRAHENT>
    <DOSTAWA>
      <METODA>${xmlEscape(order.delivery.method)}</METODA>
      <KOSZT>${order.delivery.cost.toFixed(2)}</KOSZT>
    </DOSTAWA>
    <POZYCJE>
${positions}
    </POZYCJE>
    <UWAGI>${xmlEscape(order.notes)}</UWAGI>
  </DOKUMENT>
</ECO>
`
}

/**
 * Buduje XML ECO na podstawie danych JUŻ ZAPISANYCH w buforze
 * (`integracja.V_DO_IMPORTU`).
 *
 * Różnica wobec buildEcoOrderXml: pozycje mają wypełnione `ID_ARTYKULU`
 * dopasowane wcześniej do kartoteki Wapro. Import po stronie ERP nie musi
 * zgadywać po indeksie — dostaje twardy klucz. To istotne, bo dopasowanie
 * po tekstowym indeksie bywa niejednoznaczne (spacje, wielkość liter,
 * ten sam indeks w kilku kartotekach).
 *
 * @param {object} header wiersz nagłówka z bufora (nazwy kolumn jak w tabeli)
 * @param {Array<object>} items pozycje z bufora
 * @returns {string}
 */
export function buildEcoFromBuffer(header, items) {
  const h = header ?? {}
  const rows = Array.isArray(items) ? items : []

  const dec = (v, digits = 2) => {
    const n = Number(v)
    return Number.isFinite(n) ? n.toFixed(digits) : (0).toFixed(digits)
  }

  const dateOnly = (v) => {
    if (!v) return new Date().toISOString().slice(0, 10)
    const d = v instanceof Date ? v : new Date(v)
    return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10)
  }

  const positions = rows
    .map((r) => {
      // ID_ARTYKULU wypisujemy tylko gdy dopasowanie się powiodło — pusty
      // element jest czytelniejszy dla operatora niż `0` albo `NULL`.
      const idArt = r.ID_ARTYKULU == null ? '' : String(r.ID_ARTYKULU)

      return `      <POZYCJA>
        <LP>${Number(r.LP) || 0}</LP>
        <ID_ARTYKULU>${xmlEscape(idArt)}</ID_ARTYKULU>
        <INDEKS_KATALOGOWY>${xmlEscape(r.SKU)}</INDEKS_KATALOGOWY>
        <KOD_KRESKOWY>${xmlEscape(r.KOD_KRESKOWY)}</KOD_KRESKOWY>
        <NAZWA>${xmlEscape(r.NAZWA_POZYCJI ?? r.NAZWA)}</NAZWA>
        <ILOSC>${dec(r.ILOSC, 4)}</ILOSC>
        <CENA_BRUTTO>${dec(r.CENA_BRUTTO)}</CENA_BRUTTO>
        <STAWKA_VAT>${r.STAWKA_VAT == null ? '' : dec(r.STAWKA_VAT, 2)}</STAWKA_VAT>
        <DOPASOWANIE>${xmlEscape(r.DOPASOWANIE)}</DOPASOWANIE>
      </POZYCJA>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<ECO>
  <DOKUMENT>
    <TYP>ZO</TYP>
    <ID_BUFORA>${Number(h.ID_INTEGRACJA) || 0}</ID_BUFORA>
    <ZRODLO>${xmlEscape(h.ZRODLO)}</ZRODLO>
    <NUMER_OBCY>${xmlEscape(h.NUMER_OBCY)}</NUMER_OBCY>
    <DATA>${dateOnly(h.DATA_ZAMOWIENIA)}</DATA>
    <WALUTA>${xmlEscape(h.WALUTA || 'PLN')}</WALUTA>
    <KONTRAHENT>
      <NAZWA>${xmlEscape(h.KONTRAHENT_NAZWA)}</NAZWA>
      <NIP>${xmlEscape(h.KONTRAHENT_NIP)}</NIP>
      <EMAIL>${xmlEscape(h.KONTRAHENT_EMAIL)}</EMAIL>
      <TELEFON>${xmlEscape(h.KONTRAHENT_TELEFON)}</TELEFON>
      <ULICA>${xmlEscape(h.ADRES_ULICA)}</ULICA>
      <KOD_POCZTOWY>${xmlEscape(h.ADRES_KOD)}</KOD_POCZTOWY>
      <MIEJSCOWOSC>${xmlEscape(h.ADRES_MIASTO)}</MIEJSCOWOSC>
      <KRAJ>${xmlEscape(h.ADRES_KRAJ || 'PL')}</KRAJ>
    </KONTRAHENT>
    <DOSTAWA>
      <METODA>${xmlEscape(h.DOSTAWA_METODA)}</METODA>
      <KOSZT>${dec(h.DOSTAWA_KOSZT)}</KOSZT>
    </DOSTAWA>
    <POZYCJE>
${positions}
    </POZYCJE>
    <WARTOSC_BRUTTO>${dec(h.WARTOSC_BRUTTO)}</WARTOSC_BRUTTO>
    <UWAGI>${xmlEscape(h.UWAGI)}</UWAGI>
  </DOKUMENT>
</ECO>
`
}
