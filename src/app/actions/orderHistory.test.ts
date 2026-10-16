// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBatch, ledgerMismatches } from '@/lib/db/inventory'
import {
  applyOrderInventory,
  createSalesOrder,
  getSalesOrder,
  newIdempotencyKey,
  priceLines,
  recordOrderStep,
  type NewSalesOrder,
} from '@/lib/db/orders'
import { fakeSupabase } from '@/lib/db/testing/fakeSupabase'
import { SERVICE, createMigratedDb } from '@/lib/db/testing/testDb'

const mocks = vi.hoisted(() => ({
  pg: null as PGlite | null,
  writeOrderToSheet: vi.fn(),
  untagOrderRows: vi.fn(),
  findOrderRows: vi.fn(),
  createTrelloCard: vi.fn(),
  archiveTrelloCard: vi.fn(),
  createDraftInvoice: vi.fn(),
}))

vi.mock('@/lib/supabase/server', async () => {
  const { fakeSupabase } = await import('@/lib/db/testing/fakeSupabase')
  const { SERVICE } = await import('@/lib/db/testing/testDb')
  // The app's server uses the secret key: the service role.
  return { createClient: async () => fakeSupabase(mocks.pg!, SERVICE) }
})
// Sign-in is covered by src/app/actions/auth.test.ts; act as a signed-in device here.
vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: async () => ({ failure: null }),
}))
vi.mock('@/lib/google/sheets', () => ({
  writeOrderToSheet: mocks.writeOrderToSheet,
  untagOrderRows: mocks.untagOrderRows,
  findOrderRows: mocks.findOrderRows,
}))
vi.mock('@/lib/trello', () => ({
  createTrelloCard: mocks.createTrelloCard,
  archiveTrelloCard: mocks.archiveTrelloCard,
}))
vi.mock('@/lib/square', () => ({ createDraftInvoice: mocks.createDraftInvoice }))

import { listOrders, retryOrder, voidOrder } from './orderHistory'

let base: PGlite
const db = () => fakeSupabase(mocks.pg!, SERVICE)

beforeAll(async () => {
  // As in production: nobody is on the partner list.
  base = await createMigratedDb({ partners: false })
}, 60_000)
afterAll(async () => {
  await base.close()
})
beforeEach(async () => {
  mocks.pg = (await base.clone()) as PGlite
  mocks.writeOrderToSheet
    .mockReset()
    .mockResolvedValue({ ref: 'Sales!A3126:V3127', locationAdded: false })
  mocks.untagOrderRows.mockReset().mockResolvedValue(undefined)
  mocks.findOrderRows.mockReset().mockResolvedValue(null)
  mocks.createTrelloCard.mockReset().mockResolvedValue('card-1')
  mocks.archiveTrelloCard.mockReset().mockResolvedValue(undefined)
  mocks.createDraftInvoice.mockReset()
})
afterEach(async () => {
  await mocks.pg!.close()
})

vi.spyOn(console, 'error').mockImplementation(() => {})

const placeOrder = async (over: Partial<NewSalesOrder> = {}) =>
  (
    await createSalesOrder(db(), {
      idempotency_key: newIdempotencyKey(),
      customer_name: 'Lovejoy Bakers',
      delivery_type: 'drop',
      order_date: '2026-10-15',
      lines: priceLines([
        { product: 'still', cans: 120, batch_id: 45 },
        { product: 'sparkling', cans: 48, batch_id: 25 },
      ]),
      ...over,
    })
  ).order

// An order whose sheet, inventory and Trello steps all finished.
const finishedOrder = async (over: Partial<NewSalesOrder> = {}) => {
  const order = await placeOrder(over)
  await recordOrderStep(db(), order.id, 'sheet', 'done', { externalId: 'Sales!A3126:V3127' })
  await applyOrderInventory(db(), order.id)
  await recordOrderStep(db(), order.id, 'trello', 'done', { externalId: 'card-1' })
  return order
}

describe('listOrders', () => {
  it('lists recent orders, newest first, with their lines and batches', async () => {
    const first = await placeOrder()
    const second = await placeOrder({ customer_name: 'Dame' })
    const history = await listOrders()
    expect(history).toMatchObject({
      error: null,
      orders: [
        { id: second.id, customer_name: 'Dame', lines: [{ batch_id: 45 }, { batch_id: 25 }] },
        { id: first.id, customer_name: 'Lovejoy Bakers' },
      ],
    })
    expect((history as { batches: unknown[] }).batches).toEqual(
      expect.arrayContaining([
        { id: 45, name: 'Portlandica', isStill: true, fillDate: '2026-09-26' },
      ])
    )
  })
})

describe('retryOrder', () => {
  it('runs only the steps that did not finish', async () => {
    const order = await placeOrder()
    await recordOrderStep(db(), order.id, 'sheet', 'done', { externalId: 'Sales!A3126:V3127' })
    await recordOrderStep(db(), order.id, 'trello', 'failed', { error: 'Trello API error: 503' })

    const result = await retryOrder(order.id)
    expect(result).toMatchObject({
      status: 'done',
      order: {
        sheet_status: 'done',
        inventory_status: 'done',
        trello_status: 'done',
        trello_card_id: 'card-1',
      },
      warnings: [],
    })
    expect(mocks.writeOrderToSheet).not.toHaveBeenCalled()
    expect(mocks.createTrelloCard.mock.calls[0][1]).toEqual({ findExisting: true })
  })

  it('takes cans a batch does not have only once confirmed', async () => {
    const order = await placeOrder({
      lines: priceLines([{ product: 'sparkling', cans: 4800, batch_id: 25 }]),
    })
    const short = await retryOrder(order.id)
    expect(short).toMatchObject({
      status: 'done',
      order: { inventory_status: 'failed' },
      shortfalls: [{ batchId: 25, available: 4760, needed: 4800 }],
    })
    const confirmed = await retryOrder(order.id, { allowNegativeInventory: true })
    expect(confirmed).toMatchObject({ order: { inventory_status: 'done' }, shortfalls: [] })
    expect((await getBatch(db(), 25))?.count).toBe(-40)
  })

  it('turns away a bad order id', async () => {
    expect(await retryOrder(0)).toEqual({ status: 'failed', message: 'No such order.' })
    expect(await retryOrder(999)).toMatchObject({ status: 'failed' })
  })
})

describe('voidOrder', () => {
  it('puts the cans back, archives the card and lists the sheet rows to fix', async () => {
    const order = await finishedOrder()
    expect((await getBatch(db(), 45))?.count).toBe(12000 - 120)

    const result = await voidOrder(order.id, 'Entered twice')
    expect(result).toMatchObject({
      status: 'voided',
      order: { id: order.id, void_reason: 'Entered twice', lines: [{}, {}] },
      handFixes: [
        "Sales rows 3126–3127 still show this order. Fix them by hand (the app doesn't edit Sales rows).",
      ],
    })
    expect((await getBatch(db(), 45))?.count).toBe(12000)
    expect(await ledgerMismatches(db())).toEqual([])
    expect(mocks.archiveTrelloCard).toHaveBeenCalledWith('card-1')
  })

  it('lists the Square draft and a card it could not archive', async () => {
    const order = await finishedOrder({ create_invoice: true })
    await recordOrderStep(db(), order.id, 'square', 'done', { externalId: 'inv-1' })
    mocks.archiveTrelloCard.mockRejectedValue(new Error('Trello API error archiving the card: 401'))

    const result = await voidOrder(order.id, 'Customer cancelled')
    expect(result).toMatchObject({ status: 'voided' })
    expect((result as { handFixes: string[] }).handFixes).toEqual([
      "Archive this order's Trello card by hand (Trello API error archiving the card: 401).",
      expect.stringMatching(/^Sales rows 3126–3127/),
      expect.stringMatching(/^Delete the draft invoice for this order in the Square Dashboard/),
    ])
  })

  it('finds rows an unfinished attempt left in the sheet', async () => {
    const order = await placeOrder()
    mocks.findOrderRows.mockResolvedValue('Sales!A3130:V3131')
    const result = await voidOrder(order.id, 'Test order')
    expect((result as { handFixes: string[] }).handFixes).toEqual([
      "Sales rows 3130–3131 were written by an attempt that didn't finish. Remove them by hand.",
    ])
    expect(mocks.untagOrderRows).toHaveBeenCalledWith(order.idempotency_key)
    expect(await getSalesOrder(db(), order.id)).toMatchObject({
      sheet_status: 'failed',
      sheet_ref: 'Sales!A3130:V3131',
    })
    expect(mocks.archiveTrelloCard).not.toHaveBeenCalled()
  })

  it('needs a reason and a real order', async () => {
    const order = await placeOrder()
    expect(await voidOrder(order.id, '  ')).toEqual({
      status: 'failed',
      message: 'Say why the order is being voided.',
    })
    expect(await voidOrder(-1, 'x')).toEqual({ status: 'failed', message: 'No such order.' })
    expect(await voidOrder(999, 'x')).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/wasn't voided/),
    })
    expect((await getSalesOrder(db(), order.id))?.voided_at).toBeNull()
  })

  it('leaves a void order out of the retry list', async () => {
    const order = await placeOrder()
    await voidOrder(order.id, 'Duplicate')
    expect(await retryOrder(order.id)).toMatchObject({
      status: 'done',
      warnings: ['This order is void.'],
    })
    expect(mocks.writeOrderToSheet).not.toHaveBeenCalled()
  })
})
