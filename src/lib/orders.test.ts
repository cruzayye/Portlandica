import { describe, it, expect } from 'vitest'
import type { OrderInput } from '@/types/orders'
import {
  autoTotal,
  dbCustomerType,
  describeSheetRef,
  lineAmounts,
  linePricePerCan,
  linePrices,
  orderProblem,
  priceForCans,
  sameOrder,
  shortfalls,
  splitCents,
  toCans,
  typedLineAmounts,
} from './orders'

const order = (over: Partial<OrderInput> = {}): OrderInput => ({
  customerType: 'existing',
  customerId: 7,
  name: 'Dame',
  businessType: null,
  streetAddress: null,
  city: null,
  state: null,
  zip: null,
  deliveryAddress: null,
  email: null,
  poNumber: null,
  lines: [
    { product: 'still', cans: 120, batchId: 45 },
    { product: 'sparkling', cans: 48, batchId: 25 },
  ],
  price: 252,
  isPaid: false,
  createInvoice: false,
  isDonation: false,
  deliveryType: 'Drop',
  deliveryDate: '2026-10-21',
  notes: null,
  ...over,
})

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

describe('orderProblem', () => {
  it('accepts a complete order', () => {
    expect(orderProblem(order())).toBeNull()
  })

  it.each([
    ['no name', order({ name: '  ' }), /customer name/],
    ['an existing business not picked from the list', order({ customerId: null }), /from the list/],
    ['no product', order({ lines: [] }), /Still or Sparkling/],
    [
      'a product with no quantity',
      order({ lines: [{ product: 'still', cans: null, batchId: 45 }] }),
      /how much Still/,
    ],
    [
      'part of a can',
      order({ lines: [{ product: 'sparkling', cans: 12.5, batchId: 25 }] }),
      /whole number of Sparkling cans/,
    ],
    [
      'a product with no batch',
      order({ lines: [{ product: 'sparkling', cans: 48, batchId: null }] }),
      /Sparkling batch/,
    ],
    ['no delivery type', order({ deliveryType: null }), /Drop, Ship or Pickup/],
    ['no delivery date', order({ deliveryDate: '' }), /delivery date/],
    ['a $0 sale', order({ price: 0 }), /price, or mark this order as a donation/],
    ['a sale with no price', order({ price: null }), /price/],
    ['a mistyped email', order({ email: 'orders at dame' }), /email/],
  ])('refuses %s', (_, bad, message) => {
    expect(orderProblem(bad)).toMatch(message)
  })

  it('accepts a donation at $0', () => {
    expect(orderProblem(order({ isDonation: true, price: 0 }))).toBeNull()
  })

  it('needs no pick from the list for a new business or a person', () => {
    expect(orderProblem(order({ customerType: 'new', customerId: null }))).toBeNull()
    expect(orderProblem(order({ customerType: 'individual', customerId: null }))).toBeNull()
  })
})

describe('dbCustomerType', () => {
  it('books both kinds of business as businesses', () => {
    expect(dbCustomerType('existing')).toBe('business')
    expect(dbCustomerType('new')).toBe('business')
    expect(dbCustomerType('individual')).toBe('individual')
  })
})

describe('line prices', () => {
  const hotelVintage = { price_per_can: 2, custom_cans: true }
  const benBridge = { price_per_can: 1.35, custom_cans: false }
  const batches = [
    { id: 45, isCustom: false },
    { id: 22, isCustom: true },
  ]

  it("charges a custom line at the customer's price", () => {
    expect(linePricePerCan(hotelVintage, true)).toBe(2)
  })

  it('charges a custom-can customer the default for house stock', () => {
    expect(linePricePerCan(hotelVintage, false)).toBe(1.5)
  })

  it("charges house stock at the price of a customer who isn't a custom-can account", () => {
    expect(linePricePerCan(benBridge, false)).toBe(1.35)
  })

  it('charges the default when there is no agreed price', () => {
    expect(linePricePerCan({ price_per_can: null, custom_cans: true }, true)).toBe(1.5)
    expect(linePricePerCan(null, false)).toBe(1.5)
  })

  it('prices each line of a mixed order on its own, by its batch', () => {
    const mixed = [{ batchId: 22 }, { batchId: 45 }]
    expect(linePrices(mixed, batches, hotelVintage)).toEqual([2, 1.5])
    expect(linePrices(mixed, batches, benBridge)).toEqual([1.35, 1.35])
    expect(linePrices(mixed, batches, null)).toEqual([1.5, 1.5])
    // No batch picked yet counts as house stock.
    expect(linePrices([{ batchId: null }], batches, hotelVintage)).toEqual([1.5])
  })

  it('totals the lines, each to the cent', () => {
    expect(autoTotal([240, 48], [2, 1.5])).toBe(552)
    expect(autoTotal([24, 24], [1.66, 1.5])).toBe(75.84)
    expect(autoTotal([0], [2])).toBeNull()
    expect(autoTotal([], [])).toBeNull()
  })
})

describe('lineAmounts', () => {
  it("gives each line its own total when they add up to the order's", () => {
    expect(
      lineAmounts({
        total_price: 552,
        lines: [
          { cans: 240, line_total: 480 },
          { cans: 48, line_total: 72 },
        ],
      })
    ).toEqual([480, 72])
  })

  it('moves the rounding of a typed total so the lines add up to it exactly', () => {
    expect(
      lineAmounts({
        total_price: 500,
        lines: [
          { cans: 200, line_total: 333.34 },
          { cans: 100, line_total: 166.67 },
        ],
      })
    ).toEqual([333.33, 166.67])
  })

  it('splits by cans when the lines have no amounts', () => {
    expect(
      lineAmounts({
        total_price: 0.03,
        lines: [
          { cans: 2, line_total: 0 },
          { cans: 1, line_total: 0 },
        ],
      })
    ).toEqual([0.02, 0.01])
  })

  it('books a typed total over the lines in proportion to their automatic prices', () => {
    // Hotel Vintage: 240 custom cans at $2.00 and 48 house cans at $1.50 ($552), typed as $500.
    const amounts = typedLineAmounts([240, 48], [2, 1.5], 500)
    expect(amounts).toEqual([434.78, 65.22])
    expect(amounts[0] + amounts[1]).toBe(500)
    // One price for every can: an even spread over the cans.
    expect(typedLineAmounts([120, 48], [1.5, 1.5], 250)).toEqual([178.57, 71.43])
  })
})

describe('splitCents', () => {
  it('splits a total by weight so the parts add up exactly', () => {
    expect(splitCents(100, [2, 1])).toEqual([66.67, 33.33])
    expect(splitCents(500, [100, 100, 100])).toEqual([166.67, 166.67, 166.66])
    expect(splitCents(252, [120, 48])).toEqual([180, 72])
  })

  it('gives nothing to nothing', () => {
    expect(splitCents(10, [0, 0])).toEqual([0, 0])
  })
})

describe('shortfalls', () => {
  const batches = [
    { id: 45, name: 'Portlandica', count: 100, isStill: true },
    { id: 25, name: 'Portlandica - north powder', count: 4760, isStill: false },
  ]

  it('lists each batch that has fewer cans than its line needs', () => {
    expect(shortfalls(order().lines, batches)).toEqual([
      { batchId: 45, batchName: 'Portlandica Still', available: 100, needed: 120 },
    ])
  })

  it('is empty when every batch has enough', () => {
    expect(shortfalls([{ product: 'sparkling', cans: 4760, batchId: 25 }], batches)).toEqual([])
  })
})

describe('sameOrder', () => {
  const saved = {
    customer_name: 'Dame',
    is_donation: false,
    total_price: 252,
    lines: [
      { product: 'sparkling' as const, cans: 48, batch_id: 25 },
      { product: 'still' as const, cans: 120, batch_id: 45 },
    ],
  }

  it('matches the submission that saved the order', () => {
    expect(sameOrder(saved, order())).toBe(true)
    expect(sameOrder(saved, order({ name: ' dame ' }))).toBe(true)
  })

  it('tells a changed order apart', () => {
    expect(sameOrder(saved, order({ price: 250 }))).toBe(false)
    expect(sameOrder(saved, order({ name: 'Que Dice' }))).toBe(false)
    expect(sameOrder(saved, order({ lines: [{ product: 'still', cans: 144, batchId: 45 }] }))).toBe(
      false
    )
  })
})

describe('describeSheetRef', () => {
  it('reads a sheet range as rows', () => {
    expect(describeSheetRef('Sales!A3126:V3127')).toBe('Sales rows 3126–3127')
    expect(describeSheetRef('Donations!A57:K57')).toBe('Donations row 57')
    expect(describeSheetRef('somewhere')).toBe('somewhere')
  })
})
