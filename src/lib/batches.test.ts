import { describe, it, expect } from 'vitest'
import {
  batchLabel,
  batchTitle,
  batchesForCustomer,
  chosenBatchId,
  customBatches,
  preselectBatchId,
} from './batches'
import type { BatchOption } from '@/types/orders'

const batch = (over: Partial<BatchOption> & { id: number }): BatchOption => ({
  name: 'Portlandica',
  count: 1440,
  isCustom: false,
  isStill: true,
  customer_id: null,
  fillDate: '2026-01-01',
  source: null,
  ...over,
})

const HOLLYWOOD = 11
const DAME = 12

const inventory = [
  batch({ id: 1, isStill: true }),
  batch({ id: 2, isStill: false }),
  batch({ id: 3, name: 'Hollywood Theatre', isCustom: true, customer_id: HOLLYWOOD }),
  batch({ id: 4, name: 'Dame', isCustom: true, customer_id: DAME }),
  // Custom cans not linked to anyone yet.
  batch({ id: 5, name: 'Dame', isCustom: true, customer_id: null }),
  // Just a batch name: house still stock like any other.
  batch({ id: 6, name: 'Portlandica Dog water' }),
]

describe('batchesForCustomer', () => {
  it('separates still from sparkling, offering dog water as house still stock', () => {
    expect(batchesForCustomer(inventory, 'still', null).map((b) => b.id)).toEqual([1, 6])
    expect(batchesForCustomer(inventory, 'sparkling', null).map((b) => b.id)).toEqual([2])
  })

  it("offers a customer's own custom cans, matched by customer id", () => {
    expect(batchesForCustomer(inventory, 'still', DAME).map((b) => b.id)).toEqual([1, 4, 6])
    expect(batchesForCustomer(inventory, 'still', HOLLYWOOD).map((b) => b.id)).toEqual([1, 3, 6])
  })

  it("never offers another customer's custom cans or unlinked ones, whatever the name", () => {
    expect(batchesForCustomer(inventory, 'still', 999).map((b) => b.id)).toEqual([1, 6])
  })
})

describe('customBatches', () => {
  it('keeps only custom fills', () => {
    expect(customBatches(batchesForCustomer(inventory, 'still', DAME)).map((b) => b.id)).toEqual([
      4,
    ])
  })
})

describe('preselectBatchId', () => {
  const house = batch({ id: 1 })
  const custom = batch({ id: 4, isCustom: true, customer_id: DAME })

  it('picks the single custom fill for the customer', () => {
    expect(preselectBatchId([house, custom], [custom])).toBe(4)
  })

  it('picks the only option when there is exactly one', () => {
    expect(preselectBatchId([house], [])).toBe(1)
  })

  it('stays blank when several batches are available', () => {
    expect(preselectBatchId([house, batch({ id: 7 })], [])).toBe('')
  })

  it('stays blank when nothing is available', () => {
    expect(preselectBatchId([], [])).toBe('')
  })
})

describe('chosenBatchId', () => {
  const options = [batch({ id: 1 }), batch({ id: 7 })]

  it('keeps the batch the user picked', () => {
    expect(chosenBatchId(7, options, [])).toBe(7)
  })

  it('falls back to the preselection when nothing is picked', () => {
    expect(chosenBatchId('', [batch({ id: 1 })], [])).toBe(1)
  })

  it('drops a pick that is no longer on offer', () => {
    expect(chosenBatchId(9, options, [])).toBe('')
  })
})

describe('batch labels', () => {
  it('names the product and shows the cans left', () => {
    expect(batchTitle(batch({ id: 1, isStill: false }))).toBe('Portlandica Sparkling')
    expect(
      batchLabel(
        batch({
          id: 3,
          name: 'Hollywood Theatre',
          isCustom: true,
          count: 4320,
          fillDate: '2026-08-25',
          source: 'North Powder',
        })
      )
    ).toBe('Hollywood Theatre Still (Custom) · 2026-08-25 · 4,320 left · North Powder')
  })
})
