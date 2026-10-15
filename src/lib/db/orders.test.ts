// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createCustomer } from './customers'
import { DbError } from './errors'
import { getBatch, ledgerMismatches } from './inventory'
import {
  applyOrderInventory,
  createSalesOrder,
  deliveryTypeFromForm,
  findSameDayOrders,
  getSalesOrder,
  lineTotal,
  linesTotal,
  listSalesOrders,
  listUnfinishedOrders,
  newIdempotencyKey,
  pendingSteps,
  priceLines,
  recordOrderStep,
  voidSalesOrder,
  type NewSalesOrder,
} from './orders'
import { fakeSupabase } from './testing/fakeSupabase'
import { JOHNNY, PAUL, STRANGER, createMigratedDb } from './testing/testDb'
import type { SalesOrder } from './types'

describe('pricing', () => {
  const lines = [
    { product: 'still' as const, cans: 48, batch_id: 1 },
    { product: 'sparkling' as const, cans: 24, batch_id: 2 },
  ]

  it('charges the default or the customer price per can', () => {
    expect(priceLines(lines).map((l) => l.unit_price)).toEqual([1.5, 1.5])
    expect(linesTotal(priceLines(lines, { pricePerCan: 2 }))).toBe(144)
  })

  it('spreads a manual total over every can', () => {
    const priced = priceLines(lines, { totalPrice: 100 })
    expect(priced.map((l) => l.unit_price)).toEqual([1.3889, 1.3889])
    expect(priced.map(lineTotal)).toEqual([66.67, 33.33])
  })

  it('makes donations free whatever the price', () => {
    expect(
      linesTotal(priceLines(lines, { pricePerCan: 2, totalPrice: 50, isDonation: true }))
    ).toBe(0)
  })

  it('rounds line totals to cents', () => {
    expect(lineTotal({ cans: 3, unit_price: 1.005 })).toBe(3.02)
    expect(
      linesTotal([
        { cans: 1, unit_price: 0.1 },
        { cans: 1, unit_price: 0.2 },
      ])
    ).toBe(0.3)
  })
})

describe('order helpers', () => {
  const order = (over: Partial<SalesOrder>) =>
    ({
      voided_at: null,
      inventory_status: 'done',
      sheet_status: 'done',
      trello_status: 'done',
      square_status: 'skipped',
      ...over,
    }) as SalesOrder

  it('lists the steps left to run, inventory first', () => {
    expect(pendingSteps(order({}))).toEqual([])
    expect(
      pendingSteps(
        order({ sheet_status: 'failed', inventory_status: 'pending', square_status: 'pending' })
      )
    ).toEqual(['inventory', 'sheet', 'square'])
    expect(
      pendingSteps(order({ sheet_status: 'failed', voided_at: '2026-10-16T00:00:00Z' }))
    ).toEqual([])
  })

  it("reads the form's delivery types", () => {
    expect(deliveryTypeFromForm('Drop')).toBe('drop')
    expect(deliveryTypeFromForm('Pickup')).toBe('pickup')
    expect(deliveryTypeFromForm(null)).toBeNull()
    expect(deliveryTypeFromForm('Courier')).toBeNull()
  })

  it('makes a fresh idempotency key each time', () => {
    const key = newIdempotencyKey()
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
    expect(newIdempotencyKey()).not.toBe(key)
  })
})

describe('DbError', () => {
  it('sorts errors by hint, then by Postgres code', () => {
    expect(new DbError({ message: 'x', code: 'P0001', hint: 'order_void' }).code).toBe('order_void')
    expect(new DbError({ message: 'x', code: '23505' }).code).toBe('duplicate')
    expect(new DbError({ message: 'x', code: 'PGRST116' }).code).toBe('not_found')
    expect(new DbError({ message: 'x', code: 'P0001', hint: 'something else' }).code).toBe(
      'unknown'
    )
  })
})

describe('order queries', () => {
  let base: PGlite
  let pg: PGlite

  beforeAll(async () => {
    base = await createMigratedDb()
  }, 60_000)
  afterAll(async () => {
    await base.close()
  })
  beforeEach(async () => {
    pg = (await base.clone()) as PGlite
  })
  afterEach(async () => {
    await pg.close()
  })

  const queDiceOrder = (over: Partial<NewSalesOrder> = {}): NewSalesOrder => ({
    idempotency_key: newIdempotencyKey(),
    customer_name: 'Que Dice',
    delivery_type: 'drop',
    order_date: '2026-10-16',
    lines: priceLines([{ product: 'still', cans: 240, batch_id: 13 }], { pricePerCan: 2 }),
    ...over,
  })

  it('creates an order once per submission and books its inventory once', async () => {
    const db = fakeSupabase(pg, PAUL)
    const input = queDiceOrder({ notes: 'Back door' })
    const first = await createSalesOrder(db, input)
    expect(first.created).toBe(true)
    expect(first.order).toMatchObject({ total_cans: 240, total_price: 480, notes: 'Back door' })
    expect(first.lines).toMatchObject([
      { product: 'still', cans: 240, is_custom: true, line_total: 480 },
    ])

    const retry = await createSalesOrder(fakeSupabase(pg, JOHNNY), input)
    expect(retry).toMatchObject({ created: false, order: { id: first.order.id } })

    const applied = await applyOrderInventory(db, first.order.id)
    await applyOrderInventory(db, first.order.id)
    expect(applied.inventory_status).toBe('done')
    expect((await getBatch(db, 13))?.count).toBe(1200 - 240)
    expect(await ledgerMismatches(db)).toEqual([])
  })

  it('totals lines to the same cent as the database', async () => {
    const db = fakeSupabase(pg, PAUL)
    const prices = [1.005, 1.3889, 1.66, 0.0049, 2.675]
    const lines = prices.map((unit_price, i) => ({
      product: 'still' as const,
      cans: [3, 72, 1, 1, 7][i],
      batch_id: 45,
      unit_price,
    }))
    const { order, lines: saved } = await createSalesOrder(db, queDiceOrder({ lines }))
    expect(saved.map((l) => l.line_total)).toEqual(lines.map(lineTotal))
    expect(order.total_price).toBe(linesTotal(lines))
  })

  it('reports how short a batch is, and books it anyway when told to', async () => {
    const db = fakeSupabase(pg, PAUL)
    const { order } = await createSalesOrder(
      db,
      queDiceOrder({ lines: priceLines([{ product: 'still', cans: 1224, batch_id: 13 }]) })
    )
    const error = await applyOrderInventory(db, order.id).catch((e) => e)
    expect(error).toBeInstanceOf(DbError)
    expect(error.code).toBe('insufficient_stock')
    expect(error.shortfall).toEqual({ batchId: 13, available: 1200, needed: 1224 })

    await recordOrderStep(db, order.id, 'inventory', 'failed', { error: error.message })
    expect(await listUnfinishedOrders(db)).toMatchObject([
      { id: order.id, inventory_status: 'failed' },
    ])

    await applyOrderInventory(db, order.id, { allowNegative: true })
    expect((await getBatch(db, 13))?.count).toBe(-24)
  })

  it('voids an order, returning its cans', async () => {
    const db = fakeSupabase(pg, PAUL)
    const { order } = await createSalesOrder(db, queDiceOrder())
    await applyOrderInventory(db, order.id)
    const voided = await voidSalesOrder(db, order.id, 'Entered twice')
    expect(voided).toMatchObject({ void_reason: 'Entered twice', voided_by: PAUL.sub })
    expect((await getBatch(db, 13))?.count).toBe(1200)
    await expect(applyOrderInventory(db, order.id)).rejects.toMatchObject({ code: 'order_void' })
    expect(await listSalesOrders(db)).toEqual([])
    expect(await listSalesOrders(db, { includeVoided: true })).toHaveLength(1)
  })

  it('records each downstream step and what is left', async () => {
    const db = fakeSupabase(pg, PAUL)
    const { order } = await createSalesOrder(db, queDiceOrder({ create_invoice: true }))
    expect(pendingSteps(order)).toEqual(['inventory', 'sheet', 'trello', 'square'])

    await applyOrderInventory(db, order.id)
    await recordOrderStep(db, order.id, 'sheet', 'done')
    await recordOrderStep(db, order.id, 'trello', 'done', { externalId: 'card-123' })
    const after = await recordOrderStep(db, order.id, 'square', 'failed', { error: 'Square 503' })
    expect(after).toMatchObject({ trello_card_id: 'card-123', square_error: 'Square 503' })
    expect(pendingSteps(after)).toEqual(['square'])

    await expect(
      recordOrderStep(db, order.id, 'trello', 'done', { externalId: 'card-456' })
    ).rejects.toMatchObject({ code: 'external_id_conflict' })

    const full = await getSalesOrder(db, order.id)
    expect(full?.lines).toHaveLength(1)
    expect(await getSalesOrder(db, 999)).toBeNull()
  })

  it('finds same-day orders by customer id or by name', async () => {
    const db = fakeSupabase(pg, PAUL)
    const customer = await createCustomer(db, { name: '100% Juice_Bar' })
    await createSalesOrder(db, queDiceOrder({ customer_id: customer.id, customer_name: null }))
    await createSalesOrder(db, queDiceOrder({ customer_name: 'Que Dice' }))

    expect(
      await findSameDayOrders(db, {
        orderDate: '2026-10-16',
        customerId: customer.id,
        customerName: '',
      })
    ).toHaveLength(1)
    expect(
      await findSameDayOrders(db, { orderDate: '2026-10-16', customerName: ' que dice' })
    ).toHaveLength(1)
    expect(
      await findSameDayOrders(db, { orderDate: '2026-10-16', customerName: '100% juice_bar' })
    ).toHaveLength(1)
    expect(
      await findSameDayOrders(db, { orderDate: '2026-10-16', customerName: '1%' })
    ).toHaveLength(0)
    expect(
      await findSameDayOrders(db, { orderDate: '2026-10-17', customerName: 'Que Dice' })
    ).toHaveLength(0)
  })

  it('refuses orders from non-partners', async () => {
    await expect(
      createSalesOrder(fakeSupabase(pg, STRANGER), queDiceOrder())
    ).rejects.toMatchObject({
      code: 'not_partner',
    })
  })
})
