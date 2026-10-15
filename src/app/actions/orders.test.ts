// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateOrderResult, NewOrder, OrderBatches } from '@/types/orders'

const steps = vi.hoisted(() => ({
  appendOrder: vi.fn(),
  decrementInventory: vi.fn(),
  createTrelloCard: vi.fn(),
}))

vi.mock('@/lib/google/sheets', () => ({
  appendOrder: steps.appendOrder,
  getLocationsFromSheet: vi.fn(),
}))
vi.mock('@/app/actions/inventory', () => ({ decrementInventory: steps.decrementInventory }))
vi.mock('@/lib/trello', () => ({ createTrelloCard: steps.createTrelloCard }))
// Sign-in is covered by src/app/actions/auth.test.ts; act as a signed-in partner here.
vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: async () => ({ user: { id: 'user-1', email: 'partner@example.com' }, failure: null }),
}))

import { createOrder } from './orders'

const order = (over: Partial<NewOrder> = {}): NewOrder => ({
  name: 'Dame',
  customerType: 'existing',
  isStill: true,
  isSpark: false,
  totalStill: 120,
  totalSpark: null,
  IsCustomStill: false,
  isCustomSpark: false,
  price: 180,
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

const batches: OrderBatches = { still: { id: 1, fillDate: '2026-08-03' } }

// Silence the server-side error logging these failure cases trigger.
vi.spyOn(console, 'error').mockImplementation(() => {})

beforeEach(() => {
  steps.appendOrder.mockReset().mockResolvedValue({ duplicate: false })
  steps.decrementInventory.mockReset().mockResolvedValue(undefined)
  steps.createTrelloCard.mockReset().mockResolvedValue(undefined)
})

describe('createOrder', () => {
  it('books the order, takes inventory and makes the card', async () => {
    expect(await createOrder(order(), batches)).toEqual({ status: 'saved', warnings: [] })
    expect(steps.decrementInventory).toHaveBeenCalledWith(order(), 1, undefined)
    expect(steps.createTrelloCard).toHaveBeenCalledWith(order(), batches)
  })

  it('reports a Trello failure as a warning on a saved order', async () => {
    steps.createTrelloCard.mockRejectedValue(new Error('Trello API error: 503'))

    const result = (await createOrder(order(), batches)) as CreateOrderResult

    expect(result.status).toBe('saved')
    expect(result).toMatchObject({
      warnings: [expect.stringMatching(/Order saved, but the Trello card failed.*by hand/)],
    })
  })

  it('still makes the card when the inventory update fails', async () => {
    steps.decrementInventory.mockRejectedValue(new Error('Inventory item not found: id 1'))

    const result = await createOrder(order(), batches)

    expect(result).toMatchObject({
      status: 'saved',
      warnings: [expect.stringMatching(/inventory count was not updated.*id 1/)],
    })
    expect(steps.createTrelloCard).toHaveBeenCalled()
  })

  it('stops with a message when the sheet write fails', async () => {
    steps.appendOrder.mockRejectedValue(new Error('The caller does not have permission'))

    const result = await createOrder(order(), batches)

    expect(result).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/may not have been saved.*does not have permission/),
    })
    expect(steps.decrementInventory).not.toHaveBeenCalled()
    expect(steps.createTrelloCard).not.toHaveBeenCalled()
  })

  it('stops at a duplicate without touching inventory or Trello', async () => {
    steps.appendOrder.mockResolvedValue({
      duplicate: true,
      message: 'Dame already has an order today.',
    })

    expect(await createOrder(order(), batches)).toEqual({
      status: 'duplicate',
      message: 'Dame already has an order today.',
    })
    expect(steps.decrementInventory).not.toHaveBeenCalled()
    expect(steps.createTrelloCard).not.toHaveBeenCalled()
  })

  it.each([
    ['a $0 sale', order({ price: 0 }), batches, /price, or mark this order as a donation/],
    ['a sale with no price', order({ price: null }), batches, /price/],
    ['a product with no batch', order(), {}, /Pick the Still batch/],
    ['a product with no quantity', order({ totalStill: null }), batches, /how much Still/],
  ])('writes nothing for %s', async (_, badOrder, badBatches, message) => {
    const result = await createOrder(badOrder, badBatches)

    expect(result).toMatchObject({ status: 'failed', message: expect.stringMatching(message) })
    expect(steps.appendOrder).not.toHaveBeenCalled()
    expect(steps.decrementInventory).not.toHaveBeenCalled()
    expect(steps.createTrelloCard).not.toHaveBeenCalled()
  })

  it('accepts a $0 donation', async () => {
    const donation = order({ isDonation: true, price: 0 })
    expect(await createOrder(donation, batches)).toEqual({ status: 'saved', warnings: [] })
  })
})
