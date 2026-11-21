// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSalesOrder,
  getSalesOrder,
  priceLines,
  recordOrderStep,
  voidSalesOrder,
  type NewSalesOrder,
} from '@/lib/db/orders'
import { fakeSupabase } from '@/lib/db/testing/fakeSupabase'
import { SERVICE, createMigratedDb } from '@/lib/db/testing/testDb'
import { pacificDate, pacificWallTime } from '@/lib/delivery'

// The delivery-tracking actions against the real SQL (src/lib/db/blineTracking.ts and the
// tracking migration), reached as the app's server reaches it: the service role. Trello is
// mocked.

const mocks = vi.hoisted(() => ({
  pg: null as PGlite | null,
  setTrelloCardComplete: vi.fn(),
}))

vi.mock('@/lib/supabase/server', async () => {
  const { fakeSupabase } = await import('@/lib/db/testing/fakeSupabase')
  const { SERVICE } = await import('@/lib/db/testing/testDb')
  return { createClient: async () => fakeSupabase(mocks.pg!, SERVICE) }
})
// Sign-in is covered by auth.test.ts; act as a signed-in device here.
vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: async () => ({ failure: null }),
}))
vi.mock('@/lib/trello', () => ({ setTrelloCardComplete: mocks.setTrelloCardComplete }))

import {
  clearOrderDelivery,
  loadBlineDeliveries,
  markOrderDelivered,
  readFindeliversFile,
  saveFindeliversFile,
} from './blineTracking'

let base: PGlite
const db = () => fakeSupabase(mocks.pg!, SERVICE)

beforeAll(async () => {
  base = await createMigratedDb({ partners: false })
}, 60_000)
afterAll(async () => {
  await base.close()
})
beforeEach(async () => {
  mocks.pg = (await base.clone()) as PGlite
  mocks.setTrelloCardComplete.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  await mocks.pg!.close()
})

vi.spyOn(console, 'error').mockImplementation(() => {})

const ok = <T extends { ok: boolean }>(result: unknown) => {
  const r = result as T
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r
}

let keys = 0
const order = async (over: Partial<NewSalesOrder> = {}, cardId: string | null = null) => {
  const { order } = await createSalesOrder(db(), {
    idempotency_key: `track-${keys++}`,
    customer_name: 'Lovejoy Bakers',
    delivery_type: 'bline',
    delivery_fee: 10,
    order_date: '2026-11-17',
    delivery_address: '939 NW 10th Ave, Portland, OR 97209',
    lines: priceLines([{ product: 'still', cans: 48, batch_id: 45 }]),
    ...over,
  })
  if (cardId) await recordOrderStep(db(), order.id, 'trello', 'done', { externalId: cardId })
  return order
}

const HEADER =
  'generatedOrderId,shipperOrderId,status,createdAt,type,recipientName,postCode,address,deliveredOn,failureReason'
const csv = (...rows: string[][]) =>
  [HEADER, ...rows.map((row) => row.map((v) => (v.includes(',') ? `"${v}"` : v)).join(','))].join(
    '\n'
  )
const delivered = (
  ref: string,
  recipient: string,
  address: string,
  postcode: string,
  at = '11-18-2026 10:15'
) => [
  `G-${ref}`,
  ref,
  'DELIVERED',
  '11-17-2026 13:30',
  'DROP-OFF',
  recipient,
  postcode,
  address,
  at,
  '',
]

const FILE = csv(
  delivered('261117.0001', 'Lovejoy Bakers', '939 NW 10th Ave, Portland, OR', '97209'),
  [
    'G-2',
    '261117.0002',
    'FAILED_ATTEMPT',
    '11-17-2026 13:31',
    'DROP-OFF',
    'Que Dice',
    '97214',
    '1 SE Main St, Portland, OR',
    '',
    'Refused by recipient',
  ],
  [
    'G-3',
    '261029.0003',
    'DELIVERED',
    '10-29-2026 09:33',
    'PICK-UP',
    '',
    '97222',
    '1 Warehouse Rd, Portland, OR',
    '11-02-2026 13:14',
    '',
  ]
)

describe('readFindeliversFile', () => {
  it('matches the rows to BLine orders, and lists the orders to pick from', async () => {
    const lovejoy = await order()
    const queDice = await order({
      customer_name: 'Que Dice',
      delivery_address: '1 SE Main St, Portland, OR 97214',
    })
    // Not delivered and booked long before the file: still offered, and not in the file.
    const old = await order({
      customer_name: 'Sunny Day Cafe',
      order_date: '2026-10-01',
      delivery_address: null,
    })
    // Our own drop is never offered.
    await createSalesOrder(db(), {
      idempotency_key: 'drop-1',
      customer_name: 'Lovejoy Bakers',
      delivery_type: 'drop',
      order_date: '2026-11-17',
      lines: priceLines([{ product: 'still', cans: 24, batch_id: 45 }]),
    })

    const result = ok<Extract<Awaited<ReturnType<typeof readFindeliversFile>>, { ok: true }>>(
      await readFindeliversFile(FILE)
    )
    expect(result.pickups).toBe(1)
    expect(result.rows.map((row) => row.ref)).toEqual(['261117.0001', '261117.0002'])
    expect(result.matches).toEqual([
      { orderId: lovejoy.id, confidence: 'sure', note: null },
      { orderId: queDice.id, confidence: 'sure', note: null },
    ])
    expect(result.orders.map((o) => o.id)).toEqual(
      [old.id, queDice.id, lovejoy.id].sort((a, b) => b - a)
    )
    expect(result.orders.find((o) => o.id === lovejoy.id)).toMatchObject({
      customerName: 'Lovejoy Bakers',
      orderDate: '2026-11-17',
      totalCans: 48,
      voided: false,
      blineRef: null,
      deliveredAt: null,
    })
  })

  it("refuses a file that isn't findelivers' Orders CSV", async () => {
    expect(await readFindeliversFile('name,amount\nx,1')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/isn't findelivers' Orders CSV/),
    })
    expect(await readFindeliversFile('x'.repeat(2_000_001))).toMatchObject({ ok: false })
  })
})

describe('saveFindeliversFile', () => {
  it('records each row on its order and checks off the Trello cards of new deliveries', async () => {
    const lovejoy = await order({}, 'card-lovejoy')
    const queDice = await order(
      { customer_name: 'Que Dice', delivery_address: '1 SE Main St, Portland, OR 97214' },
      'card-que'
    )
    const choices = [
      { ref: '261117.0001', orderId: lovejoy.id },
      { ref: '261117.0002', orderId: queDice.id },
    ]

    expect(await saveFindeliversFile(FILE, choices)).toEqual({
      ok: true,
      recorded: 2,
      delivered: 1,
      checkedOff: 1,
      problems: [],
      warnings: [],
    })
    expect(mocks.setTrelloCardComplete).toHaveBeenCalledExactlyOnceWith('card-lovejoy')
    const recorded = await getSalesOrder(db(), lovejoy.id)
    expect(recorded).toMatchObject({ bline_ref: '261117.0001', bline_status: 'delivered' })
    // 10:15 AM in Portland.
    expect(new Date(recorded!.delivered_at!).toISOString()).toBe('2026-11-18T18:15:00.000Z')
    expect(await getSalesOrder(db(), queDice.id)).toMatchObject({
      bline_ref: '261117.0002',
      bline_status: 'failed_attempt',
      bline_problem: 'Refused by recipient',
      delivered_at: null,
    })

    // The same file again changes nothing that matters, and checks no card off twice.
    mocks.setTrelloCardComplete.mockClear()
    expect(await saveFindeliversFile(FILE, choices)).toMatchObject({ recorded: 2, delivered: 0 })
    expect(mocks.setTrelloCardComplete).not.toHaveBeenCalled()
  })

  it("says which rows couldn't be recorded, and what to do by hand", async () => {
    const lovejoy = await order({}, 'card-lovejoy')
    const voided = await order({ customer_name: 'Que Dice' })
    await voidSalesOrder(db(), voided.id, 'Customer cancelled')
    mocks.setTrelloCardComplete.mockRejectedValue(new Error('Trello API error: 401'))

    expect(
      await saveFindeliversFile(FILE, [
        { ref: '261117.0001', orderId: lovejoy.id },
        { ref: '261117.0002', orderId: voided.id },
      ])
    ).toEqual({
      ok: true,
      recorded: 1,
      delivered: 1,
      checkedOff: 0,
      problems: [`261117.0002: order #${voided.id} is void, so nothing was recorded.`],
      warnings: [
        `Check off #${lovejoy.id} Lovejoy Bakers's Trello card by hand (Trello API error: 401).`,
      ],
    })
  })

  it('refuses choices that the file or the orders rule out', async () => {
    const lovejoy = await order()
    const drop = (
      await createSalesOrder(db(), {
        idempotency_key: 'drop-2',
        customer_name: 'Lovejoy Bakers',
        delivery_type: 'drop',
        lines: priceLines([{ product: 'still', cans: 24, batch_id: 45 }]),
      })
    ).order

    expect(await saveFindeliversFile(FILE, [])).toEqual({
      ok: false,
      error: 'Pick at least one order to record.',
    })
    expect(await saveFindeliversFile(FILE, [{ ref: '261029.0003', orderId: lovejoy.id }])).toEqual({
      ok: false,
      error: 'A row is no longer in the file. Choose the file again.',
    })
    expect(
      await saveFindeliversFile(FILE, [
        { ref: '261117.0001', orderId: lovejoy.id },
        { ref: '261117.0002', orderId: lovejoy.id },
      ])
    ).toEqual({ ok: false, error: `Order #${lovejoy.id} is picked for two rows.` })
    expect(
      await saveFindeliversFile(FILE, [{ ref: '261117.0001', orderId: drop.id }])
    ).toMatchObject({
      ok: true,
      recorded: 0,
      problems: [`261117.0001: order #${drop.id} isn't a BLine order.`],
    })
  })
})

describe('loadBlineDeliveries', () => {
  it('lists what BLine has still to deliver, the last import, and fees by month', async () => {
    const now = new Date()
    const [year, month] = pacificDate(now).split('-').map(Number)
    const lastMonth = pacificWallTime(
      month === 1 ? year - 1 : year,
      month === 1 ? 12 : month - 1,
      15,
      12
    )
    const lastMonthKey = pacificDate(lastMonth).slice(0, 7)
    const thisMonthKey = pacificDate(now).slice(0, 7)

    const waiting = await order({ customer_name: 'Sunny Day Cafe', delivery_date: '2026-11-21' })
    const handMarked = await order({ delivery_fee: 14.4 })
    const early = await order({ delivery_fee: 12.5 })
    const voided = await order({ customer_name: 'Que Dice' })
    await voidSalesOrder(db(), voided.id, 'Customer cancelled')

    const before = ok<Extract<Awaited<ReturnType<typeof loadBlineDeliveries>>, { ok: true }>>(
      await loadBlineDeliveries()
    )
    expect(before.waiting.map((o) => o.id)).toEqual([waiting.id, handMarked.id, early.id])
    expect(before.lastImport).toBeNull()
    expect(before.months).toEqual([])

    await markOrderDelivered(handMarked.id)
    const file = csv(
      delivered(
        'R-EARLY',
        'Lovejoy Bakers',
        '939 NW 10th Ave, Portland, OR',
        '97209',
        `${String(lastMonth.getUTCMonth() + 1).padStart(2, '0')}-15-${lastMonth.getUTCFullYear()} 12:00`
      )
    )
    ok(await saveFindeliversFile(file, [{ ref: 'R-EARLY', orderId: early.id }]))

    const after = ok<Extract<Awaited<ReturnType<typeof loadBlineDeliveries>>, { ok: true }>>(
      await loadBlineDeliveries()
    )
    expect(after.waiting).toEqual([
      expect.objectContaining({
        id: waiting.id,
        customerName: 'Sunny Day Cafe',
        deliveryDate: '2026-11-21',
      }),
    ])
    expect(after.lastImport).not.toBeNull()
    expect(after.months).toEqual([
      { month: lastMonthKey, orders: 1, fees: 12.5 },
      { month: thisMonthKey, orders: 1, fees: 14.4 },
    ])
  })
})

describe('markOrderDelivered and clearOrderDelivery', () => {
  it('marks a BLine order delivered, checks off its card, and can take it back', async () => {
    const placed = await order({}, 'card-1')

    const marked = await markOrderDelivered(placed.id)
    expect(marked).toMatchObject({
      status: 'done',
      warnings: [],
      order: {
        id: placed.id,
        delivered_at: expect.any(String),
        lines: [expect.objectContaining({ cans: 48 })],
      },
    })
    expect(mocks.setTrelloCardComplete).toHaveBeenCalledExactlyOnceWith('card-1')

    // Marking it again leaves the card alone.
    mocks.setTrelloCardComplete.mockClear()
    await markOrderDelivered(placed.id)
    expect(mocks.setTrelloCardComplete).not.toHaveBeenCalled()

    expect(await clearOrderDelivery(placed.id)).toMatchObject({
      status: 'done',
      order: { delivered_at: null, bline_ref: null },
    })
    expect(mocks.setTrelloCardComplete).toHaveBeenCalledExactlyOnceWith('card-1', false)
  })

  it('says what to do when Trello fails, and refuses other orders', async () => {
    const placed = await order({}, 'card-1')
    mocks.setTrelloCardComplete.mockRejectedValue(new Error('Trello API error: 401'))
    expect(await markOrderDelivered(placed.id)).toMatchObject({
      status: 'done',
      warnings: ["Check off this order's Trello card by hand (Trello API error: 401)."],
    })

    const voided = await order()
    await voidSalesOrder(db(), voided.id, 'Customer cancelled')
    expect(await markOrderDelivered(voided.id)).toEqual({
      status: 'failed',
      message: 'This order is void.',
    })
    const drop = (
      await createSalesOrder(db(), {
        idempotency_key: 'drop-3',
        customer_name: 'Lovejoy Bakers',
        delivery_type: 'drop',
        lines: priceLines([{ product: 'still', cans: 24, batch_id: 45 }]),
      })
    ).order
    expect(await markOrderDelivered(drop.id)).toEqual({
      status: 'failed',
      message: "This isn't a BLine order.",
    })
    expect(await clearOrderDelivery(0)).toEqual({ status: 'failed', message: 'No such order.' })
  })
})
