import { describe, it, expect } from 'vitest'
import type { NewOrder } from '@/types/orders'
import { orderProblem, priceForCans, salesType, sparkCans, stillCans, toCans } from './orders'

describe('toCans', () => {
  it('reads the box as cases of 24', () => {
    expect(toCans('5', false)).toBe(120)
  })

  it('reads the box as single cans with Enter Manual Number on', () => {
    expect(toCans('130', true)).toBe(130)
  })

  it('leaves a blank box blank', () => {
    expect(toCans('', false)).toBeNull()
  })
})

describe('priceForCans', () => {
  it('prices cans to the cent', () => {
    // 24 x 1.66 is 39.839999999999996 in floating point
    expect(priceForCans(24, 1.66)).toBe(39.84)
    expect(priceForCans(48, 1.66)).toBe(79.68)
    expect(priceForCans(120, 1.5)).toBe(180)
  })

  it('has no price for no cans', () => {
    expect(priceForCans(0, 1.5)).toBeNull()
  })
})

describe('stillCans / sparkCans', () => {
  it('counts a product that is switched on', () => {
    expect(stillCans({ isStill: true, totalStill: 120 })).toBe(120)
    expect(sparkCans({ isSpark: true, totalSpark: 48 })).toBe(48)
  })

  it('ignores a leftover quantity once the product is switched off', () => {
    expect(stillCans({ isStill: false, totalStill: 120 })).toBe(0)
    expect(sparkCans({ isSpark: null, totalSpark: 48 })).toBe(0)
  })

  it('treats a blank quantity as zero', () => {
    expect(stillCans({ isStill: true, totalStill: null })).toBe(0)
  })
})

describe('orderProblem', () => {
  const order = (over: Partial<NewOrder> = {}): NewOrder => ({
    name: 'Dame',
    customerType: 'existing',
    isStill: true,
    isSpark: true,
    totalStill: 120,
    totalSpark: 48,
    IsCustomStill: false,
    isCustomSpark: false,
    price: 252,
    isPaid: false,
    createInvoice: false,
    notes: '',
    address: null,
    businessType: null,
    streetAddress: null,
    city: null,
    state: null,
    zip: null,
    deliveryType: 'Drop',
    isDonation: false,
    ...over,
  })
  const batches = { still: { id: 1, fillDate: null }, spark: { id: 2, fillDate: null } }

  it('accepts a complete order', () => {
    expect(orderProblem(order(), batches)).toBeNull()
  })

  it.each([
    ['no customer', order({ name: '  ' }), batches, /customer name/],
    ['no product', order({ isStill: false, isSpark: false }), batches, /Still or Sparkling/],
    ['no Still quantity', order({ totalStill: 0 }), batches, /how much Still/],
    ['no Sparkling quantity', order({ totalSpark: null }), batches, /how much Sparkling/],
    ['no Still batch', order(), { spark: batches.spark }, /Still batch/],
    ['no Sparkling batch', order(), { still: batches.still }, /Sparkling batch/],
    ['no delivery type', order({ deliveryType: null }), batches, /Drop, Ship or Pickup/],
    ['a $0 sale', order({ price: 0 }), batches, /price, or mark this order as a donation/],
    ['a sale with no price', order({ price: null }), batches, /price/],
  ])('rejects an order with %s', (_, badOrder, badBatches, message) => {
    expect(orderProblem(badOrder, badBatches)).toMatch(message)
  })

  it('accepts a donation at $0', () => {
    expect(orderProblem(order({ isDonation: true, price: 0 }), batches)).toBeNull()
  })

  it('ignores a switched-off product', () => {
    const stillOnly = order({ isSpark: false, totalSpark: null, price: 180 })
    expect(orderProblem(stillOnly, { still: batches.still })).toBeNull()
  })
})

describe('salesType', () => {
  it.each([
    ['existing', 'Business'],
    ['new', 'Business'],
    ['individual', 'Individual'],
  ] as const)('books a %s customer as %s', (customerType, type) => {
    expect(salesType(customerType)).toBe(type)
  })
})
