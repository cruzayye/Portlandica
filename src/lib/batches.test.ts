import { describe, it, expect } from 'vitest'
import { batchesFor, customBatchesFor, preselectBatchId } from './batches'
import type { Inventory } from '@/types/orders'

const batch = (over: Partial<Inventory> & { id: number }): Inventory => ({
  created_at: '2026-01-01T00:00:00Z',
  name: 'Original',
  count: 1440,
  isCustom: false,
  isStill: true,
  fillDate: '2026-01-01',
  totalCost: null,
  invoiceNumber: null,
  source: null,
  ...over,
})

describe('batchesFor', () => {
  const inventory = [
    batch({ id: 1, name: 'Original', isStill: true }),
    batch({ id: 2, name: 'Original', isStill: false }),
    batch({ id: 3, name: 'Hollywood Theatre', isStill: true, isCustom: true }),
    batch({ id: 4, name: 'Dame', isStill: true, isCustom: true }),
  ]

  it('separates still from sparkling', () => {
    expect(batchesFor(inventory, true, null).map((b) => b.id)).toEqual([1, 3, 4].filter((id) => id === 1))
    expect(batchesFor(inventory, false, null).map((b) => b.id)).toEqual([2])
  })

  it("excludes another customer's custom fill", () => {
    const ids = batchesFor(inventory, true, 'Dame').map((b) => b.id)
    expect(ids).toContain(4)
    expect(ids).not.toContain(3)
  })

  it('offers only standard stock to an unknown customer', () => {
    expect(batchesFor(inventory, true, 'Nobody').map((b) => b.id)).toEqual([1])
  })
})

describe('customBatchesFor', () => {
  it('keeps only this customer\'s custom fills', () => {
    const batches = [
      batch({ id: 1, name: 'Original' }),
      batch({ id: 2, name: 'Dame', isCustom: true }),
    ]
    expect(customBatchesFor(batches, 'Dame').map((b) => b.id)).toEqual([2])
  })

  it('returns empty when the customer has none', () => {
    expect(customBatchesFor([batch({ id: 1 })], 'Dame')).toEqual([])
  })
})

describe('preselectBatchId', () => {
  it('picks the single custom fill for the customer', () => {
    const all = [batch({ id: 1 }), batch({ id: 2, name: 'Dame', isCustom: true })]
    const custom = [all[1]]
    expect(preselectBatchId(all, custom)).toBe(2)
  })

  it('picks the only option when there is exactly one', () => {
    expect(preselectBatchId([batch({ id: 7 })], [])).toBe(7)
  })

  it('stays blank when several batches are available', () => {
    expect(preselectBatchId([batch({ id: 1 }), batch({ id: 2 })], [])).toBe('')
  })

  it('stays blank when the customer has two custom fills', () => {
    // Hollywood Theatre really does have two custom Still batches (ids 3 and
    // 35). Picking either one silently would be arbitrary.
    const custom = [batch({ id: 3, isCustom: true }), batch({ id: 35, isCustom: true })]
    expect(preselectBatchId([...custom, batch({ id: 1 })], custom)).toBe('')
  })

  it('stays blank when nothing is available', () => {
    expect(preselectBatchId([], [])).toBe('')
  })

  it('prefers the custom fill over standard stock', () => {
    const custom = [batch({ id: 9, name: 'Dame', isCustom: true })]
    const all = [batch({ id: 1 }), batch({ id: 2 }), ...custom]
    expect(preselectBatchId(all, custom)).toBe(9)
  })
})
