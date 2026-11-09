import { describe, expect, it } from 'vitest'
import type { BlineStockRow } from '@/lib/db/types'
import {
  atBline,
  blineHoldings,
  blineLow,
  blineNegative,
  blineRowTitle,
  onHandAtBline,
  sendableBatches,
} from './blineRows'
import { batch } from './testing/fixtures'

const row = (over: Partial<BlineStockRow> & { batch_id: number }): BlineStockRow => ({
  name: 'Portlandica',
  is_still: true,
  moved: 1440,
  booked: 0,
  pending: 0,
  remaining: 1440,
  on_hand: 1440,
  ...over,
})

describe('blineHoldings', () => {
  it('lists what BLine has, still before sparkling, leaving out batches it has run out of', () => {
    const stock = [
      row({ batch_id: 25, name: 'North Powder', is_still: false, remaining: 1200 }),
      row({ batch_id: 45 }),
      row({ batch_id: 33, name: 'Old', remaining: 0, on_hand: 0 }),
      row({ batch_id: 22, name: 'Short', remaining: -24, on_hand: -24 }),
      // Every can is for a delivery not made yet: still on the shelf.
      row({
        batch_id: 31,
        name: 'Promised',
        booked: 240,
        pending: 240,
        remaining: 0,
        on_hand: 240,
      }),
    ]
    expect(blineHoldings(stock).map((r) => r.batch_id)).toEqual([45, 22, 31, 25])
  })
})

describe('blineLow and blineNegative', () => {
  it('warns per product under 240 cans, but only for products BLine has had', () => {
    const stock = [
      row({ batch_id: 45, remaining: 120 }),
      row({ batch_id: 46, remaining: 96 }),
      row({ batch_id: 25, is_still: false, remaining: 1440 }),
    ]
    expect(blineLow(stock)).toEqual([{ product: 'still', cans: 216 }])
    expect(blineLow([row({ batch_id: 45, remaining: 240 })])).toEqual([])
    expect(blineLow([])).toEqual([])
  })

  it('leaves below zero to its own warning', () => {
    const stock = [row({ batch_id: 45, remaining: -48 })]
    expect(blineLow(stock)).toEqual([])
    expect(blineNegative(stock)).toEqual(stock)
  })
})

describe('atBline and onHandAtBline', () => {
  it("say what BLine has left and has on its shelf today, 0 when it doesn't hold the batch", () => {
    const stock = [row({ batch_id: 45, booked: 288, pending: 240, remaining: 1152, on_hand: 1392 })]
    expect(atBline(stock, 45)).toBe(1152)
    expect(onHandAtBline(stock, 45)).toBe(1392)
    expect(atBline(stock, 25)).toBe(0)
    expect(onHandAtBline(stock, '')).toBe(0)
  })
})

describe('blineRowTitle', () => {
  it('names the batch as the list does, or from the row when it is not loaded', () => {
    const batches = [batch({ id: 25, name: 'North Powder', isStill: false })]
    expect(blineRowTitle(row({ batch_id: 25 }), batches)).toBe('North Powder Sparkling')
    expect(blineRowTitle(row({ batch_id: 45 }), batches)).toBe('Portlandica Still')
    expect(blineRowTitle(row({ batch_id: 9, name: null }), [])).toBe('Batch 9 Still')
  })
})

describe('sendableBatches', () => {
  it('offers live batches, house stock first, still before sparkling', () => {
    const batches = [
      batch({ id: 1, name: 'Dame', isCustom: true }),
      batch({ id: 2, name: 'North Powder', isStill: false }),
      batch({ id: 3, name: 'Portlandica' }),
      batch({ id: 4, name: 'Gone', archived_at: '2026-10-01T00:00:00Z' }),
    ]
    expect(sendableBatches(batches).map((b) => b.id)).toEqual([3, 2, 1])
  })
})
