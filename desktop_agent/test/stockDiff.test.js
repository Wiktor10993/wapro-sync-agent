import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diffSnapshot } from '../src/main/wapro/stockDiff.js'

const snap = (pairs) => pairs.map(([sku, quantity]) => ({ sku, quantity, name: sku }))

describe('diffSnapshot', () => {
  it('pierwszy przebieg zgłasza wszystkie pozycje', () => {
    const { changed, hashes } = diffSnapshot(snap([['A', 5], ['B', 0]]), {})
    assert.equal(changed.length, 2)
    assert.equal(Object.keys(hashes).length, 2)
  })

  it('drugi przebieg bez zmian nie zgłasza niczego', () => {
    const first = diffSnapshot(snap([['A', 5], ['B', 0]]), {})
    const second = diffSnapshot(snap([['A', 5], ['B', 0]]), first.hashes)
    assert.equal(second.changed.length, 0)
  })

  it('wykrywa zmianę ilości', () => {
    const first = diffSnapshot(snap([['A', 5]]), {})
    const second = diffSnapshot(snap([['A', 4]]), first.hashes)
    assert.deepEqual(second.changed, [{ sku: 'A', quantity: 4, name: 'A', barcode: '' }])
  })

  it('zeruje SKU, które zniknęło ze snapshotu', () => {
    const first = diffSnapshot(snap([['A', 5], ['B', 3]]), {})
    const second = diffSnapshot(snap([['A', 5]]), first.hashes)

    assert.deepEqual(second.removed, ['B'])
    const b = second.changed.find((c) => c.sku === 'B')
    assert.equal(b.quantity, 0, 'zniknięte SKU musi dostać stan 0, inaczej zostanie na sprzedaży')
  })

  it('rozróżnia stan 0 od braku pozycji', () => {
    const first = diffSnapshot(snap([['A', 0]]), {})
    const second = diffSnapshot(snap([['A', 0]]), first.hashes)
    assert.equal(second.changed.length, 0)
    assert.equal(second.removed.length, 0)
  })

  it('hash zależy zarówno od SKU jak i od ilości', () => {
    const a = diffSnapshot(snap([['A', 1]]), {}).hashes
    const b = diffSnapshot(snap([['A', 2]]), {}).hashes
    const c = diffSnapshot(snap([['B', 1]]), {}).hashes
    assert.notEqual(a.A, b.A)
    assert.notEqual(a.A, c.B)
  })

  it('jest deterministyczny między wywołaniami', () => {
    assert.equal(
      diffSnapshot(snap([['A', 7]]), {}).hashes.A,
      diffSnapshot(snap([['A', 7]]), {}).hashes.A
    )
  })

  it('radzi sobie z pustym snapshotem i pustą historią', () => {
    const r = diffSnapshot([], {})
    assert.deepEqual(r.changed, [])
    assert.deepEqual(r.removed, [])
  })

  it('pusty snapshot przy niepustej historii zeruje wszystko', () => {
    const first = diffSnapshot(snap([['A', 1], ['B', 2], ['C', 3]]), {})
    const second = diffSnapshot([], first.hashes)
    assert.equal(second.changed.length, 3)
    assert.ok(second.changed.every((c) => c.quantity === 0))
  })
})
