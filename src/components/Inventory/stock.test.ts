import { describe, expect, it } from 'vitest'
import {
  LOW_STOCK_THRESHOLD_CANS,
  archivedBatches,
  fillColumns,
  groupBatches,
  lowStock,
  negativeBatches,
  productOf,
} from './stock'
import { batch } from './testing/fixtures'

describe('productOf and fillColumns', () => {
  it('tells still, sparkling and dog water apart', () => {
    expect(productOf(batch({ id: 1 }))).toBe('still')
    expect(productOf(batch({ id: 2, isStill: false }))).toBe('sparkling')
    expect(productOf(batch({ id: 3, product: 'dog_water' }))).toBe('dog_water')
  })

  it('records dog water as still water in dog-water cans', () => {
    expect(fillColumns('still')).toEqual({ is_still: true, product: 'water' })
    expect(fillColumns('sparkling')).toEqual({ is_still: false, product: 'water' })
    expect(fillColumns('dog_water')).toEqual({ is_still: true, product: 'dog_water' })
  })
})

describe('groupBatches', () => {
  const batches = [
    batch({ id: 1, name: 'Portlandica', count: 12000 }),
    batch({ id: 2, name: 'Dame', isCustom: true, customer_id: 5, count: 2760 }),
    batch({ id: 3, name: 'Portlandica - north powder', isStill: false, count: 4760 }),
    batch({ id: 4, name: 'Portlandica Dog water', product: 'dog_water', count: 2376 }),
    batch({ id: 5, name: 'Que Dice', isCustom: true, count: 1200 }),
    batch({ id: 6, name: 'Old', archived_at: '2026-10-01T00:00:00Z', count: 0 }),
    batch({ id: 7, name: 'Portlandica', count: -24, fillDate: '2026-06-01' }),
  ]

  it('groups by product, house stock before custom cans, leaving out empty groups', () => {
    expect(
      groupBatches(batches).map((g) => [g.product, g.kind, g.batches.map((b) => b.id), g.cans])
    ).toEqual([
      ['still', 'house', [7, 1], 11976],
      ['still', 'custom', [2, 5], 3960],
      ['sparkling', 'house', [3], 4760],
      ['dog_water', 'house', [4], 2376],
    ])
  })

  it('leaves archived batches out', () => {
    expect(groupBatches(batches).flatMap((g) => g.batches.map((b) => b.id))).not.toContain(6)
  })

  it('lists archived batches on their own, latest first', () => {
    expect(
      archivedBatches([
        ...batches,
        batch({ id: 8, name: 'Older', archived_at: '2026-09-01T00:00:00Z' }),
      ]).map((b) => b.id)
    ).toEqual([6, 8])
  })
})

describe('lowStock', () => {
  it('flags house still or sparkling below the threshold', () => {
    expect(
      lowStock([batch({ id: 1, count: 1200 }), batch({ id: 2, isStill: false, count: 4760 })])
    ).toEqual([{ product: 'still', cans: 1200 }])
  })

  it('counts only house stock that is in use', () => {
    expect(
      lowStock([
        batch({ id: 1, count: 1000 }),
        batch({ id: 2, count: 5000, isCustom: true }),
        batch({ id: 3, count: 5000, product: 'dog_water' }),
        batch({ id: 4, count: 5000, archived_at: '2026-10-01T00:00:00Z' }),
        batch({ id: 5, isStill: false, count: 2500 }),
      ])
    ).toEqual([{ product: 'still', cans: 1000 }])
  })

  it('adds up every house batch, below-zero ones included', () => {
    expect(
      lowStock([
        batch({ id: 1, count: 2400 }),
        batch({ id: 2, count: -500 }),
        batch({ id: 3, isStill: false, count: 3000 }),
      ])
    ).toEqual([{ product: 'still', cans: 1900 }])
  })

  it('does not warn at exactly the threshold', () => {
    expect(
      lowStock([
        batch({ id: 1, count: LOW_STOCK_THRESHOLD_CANS }),
        batch({ id: 2, isStill: false, count: LOW_STOCK_THRESHOLD_CANS }),
      ])
    ).toEqual([])
  })

  it('warns when there is no house stock at all', () => {
    expect(lowStock([])).toEqual([
      { product: 'still', cans: 0 },
      { product: 'sparkling', cans: 0 },
    ])
  })
})

describe('negativeBatches', () => {
  it('lists batches in use whose count is below zero', () => {
    expect(
      negativeBatches([
        batch({ id: 1, count: -120, name: 'Hotel Vintage' }),
        batch({ id: 2, count: 0 }),
        batch({ id: 3, count: -5, archived_at: '2026-10-01T00:00:00Z' }),
      ]).map((b) => b.id)
    ).toEqual([1])
  })
})
