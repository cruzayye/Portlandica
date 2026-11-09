// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSalesOrder, priceLines } from '@/lib/db/orders'
import { fakeSupabase } from '@/lib/db/testing/fakeSupabase'
import { SERVICE, createMigratedDb } from '@/lib/db/testing/testDb'
import { portlandToday } from '@/components/Inventory/dates'
import type { BlineUpdate } from '@/components/Inventory/types'

// The BLine actions against the real SQL (src/lib/db/bline.ts and the BLine migration),
// reached as the app's server reaches it: the service role, nobody on the partner list.

const mocks = vi.hoisted(() => ({ pg: null as PGlite | null }))

vi.mock('@/lib/supabase/server', async () => {
  const { fakeSupabase } = await import('@/lib/db/testing/fakeSupabase')
  const { SERVICE } = await import('@/lib/db/testing/testDb')
  return { createClient: async () => fakeSupabase(mocks.pg!, SERVICE) }
})
// Sign-in is covered by auth.test.ts; act as a signed-in device here.
vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: async () => ({ failure: null }),
}))

import { loadBlineStock, updateBlineStock } from './bline'

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
})
afterEach(async () => {
  await mocks.pg!.close()
})

vi.spyOn(console, 'error').mockImplementation(() => {})

const sent = (
  over: Partial<Extract<BlineUpdate, { kind: 'sent' | 'returned' }>> = {}
): BlineUpdate => ({
  kind: 'sent',
  batchId: 45,
  cans: 1440,
  movedOn: '2026-11-02',
  note: 'First pallet',
  ...over,
})

const ok = <T extends { ok: boolean }>(result: unknown) => {
  const r = result as T
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r
}

// Without a delivery date the order is for today: its cans are off BLine's shelf.
const blineOrder = (cans: number, deliveryDate: string | null = null) =>
  createSalesOrder(db(), {
    idempotency_key: `bline-${cans}`,
    customer_name: 'Lovejoy Bakers',
    delivery_type: 'bline',
    delivery_fee: 10,
    delivery_date: deliveryDate,
    lines: priceLines([{ product: 'still', cans, batch_id: 45 }]),
  })

// Tomorrow in Portland.
const tomorrow = () => {
  const date = new Date(`${portlandToday()}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

describe('loadBlineStock', () => {
  it('starts with nothing at BLine', async () => {
    expect(await loadBlineStock()).toEqual({ ok: true, stock: [], moves: [] })
  })

  it('says so when it cannot be read', async () => {
    await mocks.pg!.exec('drop view public.bline_stock')
    expect(await loadBlineStock()).toEqual({
      ok: false,
      error: 'Could not load what BLine has. Try again.',
    })
  })
})

describe('updateBlineStock', () => {
  it('records cans sent and brought back, and returns what BLine has now', async () => {
    const first = ok(await updateBlineStock(sent()))
    expect(first).toMatchObject({
      stock: [{ batch_id: 45, name: 'Portlandica', is_still: true, moved: 1440, remaining: 1440 }],
      moves: [
        { batch_id: 45, cans: 1440, reason: 'sent', moved_on: '2026-11-02', note: 'First pallet' },
      ],
    })

    await blineOrder(48)
    const back = ok(
      await updateBlineStock({
        kind: 'returned',
        batchId: 45,
        cans: 24,
        movedOn: '2026-11-03',
        note: ' ',
      })
    )
    expect(back).toMatchObject({
      stock: [{ batch_id: 45, moved: 1416, booked: 48, remaining: 1368, on_hand: 1368 }],
      moves: [{ cans: -24, reason: 'returned', note: null }, { cans: 1440 }],
    })
  })

  it('sets what BLine has on its shelf today to their count, recording the difference', async () => {
    await updateBlineStock(sent())
    // 240 cans are for a delivery tomorrow: still on the shelf when BLine counts today.
    await blineOrder(240, tomorrow())
    const result = ok(
      await updateBlineStock({
        kind: 'count',
        batchId: 45,
        counted: 1400,
        expectedCount: 1440,
        note: "BLine's email",
      })
    )
    expect(result).toMatchObject({
      stock: [{ batch_id: 45, pending: 240, remaining: 1160, on_hand: 1400 }],
      moves: [{ cans: -40, reason: 'count', moved_on: portlandToday(), note: "BLine's email" }, {}],
    })
  })

  it('refuses a count made against numbers an order has since changed, with the new ones', async () => {
    await updateBlineStock(sent())
    await blineOrder(24)
    const result = await updateBlineStock({
      kind: 'count',
      batchId: 45,
      counted: 1400,
      expectedCount: 1440,
      note: 'Count',
    })
    expect(result).toMatchObject({
      ok: false,
      error:
        'An order changed what BLine should have today to 1,416 cans while you were counting. Check the count and save again.',
      data: { stock: [{ batch_id: 45, on_hand: 1416 }] },
    })
  })

  it('checks what it is given before writing anything', async () => {
    expect(await updateBlineStock(sent({ cans: 0 }))).toEqual({
      ok: false,
      error: 'Enter how many cans.',
    })
    expect(await updateBlineStock(sent({ batchId: 0 }))).toEqual({
      ok: false,
      error: 'Pick a batch.',
    })
    expect(await updateBlineStock(sent({ movedOn: tomorrow() }))).toEqual({
      ok: false,
      error: "The date can't be after today.",
    })
    expect(
      await updateBlineStock({
        kind: 'count',
        batchId: 45,
        counted: 10,
        expectedCount: 0,
        note: ' ',
      })
    ).toEqual({ ok: false, error: 'Say where the count came from.' })
    expect(ok(await loadBlineStock())).toMatchObject({ stock: [], moves: [] })
  })

  it('words what the database refuses for people', async () => {
    expect(await updateBlineStock(sent({ batchId: 999 }))).toEqual({
      ok: false,
      error: 'That batch no longer exists. Refresh and pick again.',
    })
    await mocks.pg!.query('select public.archive_batch(46)')
    expect(await updateBlineStock(sent({ batchId: 46 }))).toEqual({
      ok: false,
      error: 'That batch is archived. Unarchive it first.',
    })
  })
})
