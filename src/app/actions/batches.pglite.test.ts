// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The Inventory tab's actions against the real migrations: PGlite with the Supabase
// stand-in and the REST stand-in the db module tests use, so the ledger functions, RLS and
// argument names are all exercised. Sign-in itself is covered by auth.test.ts.

type Partner = { role: 'authenticated'; sub: string; email: string }

const session = vi.hoisted(() => ({
  pg: null as unknown as PGlite,
  auth: null as unknown as Partner,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const { fakeSupabase } = await import('@/lib/db/testing/fakeSupabase')
    return fakeSupabase(session.pg, session.auth)
  },
}))
vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: async () => ({ failure: null }),
}))

import { reasonLabel } from '@/components/Inventory/history'
import type { NewBatchInput } from '@/components/Inventory/types'
import { createCustomer } from '@/lib/db/customers'
import { applyOrderInventory, createSalesOrder, voidSalesOrder } from '@/lib/db/orders'
import { fakeSupabase } from '@/lib/db/testing/fakeSupabase'
import { JOHNNY, PAUL, STRANGER, createMigratedDb } from '@/lib/db/testing/testDb'
import {
  addBatch,
  archiveInventoryBatch,
  changeBatchCount,
  getBatchHistory,
  loadInventory,
  unarchiveInventoryBatch,
} from './batches'

const expectOk = <T extends object>(result: T) => {
  if (!('ok' in result) || result.ok !== true) {
    throw new Error(`Expected ok, got ${JSON.stringify(result)}`)
  }
  return result as Extract<T, { ok: true }>
}

const houseFill: NewBatchInput = {
  kind: 'house',
  product: 'still',
  cans: 1440,
  name: 'Portlandica',
  customerId: null,
  source: 'North Powder',
  fillDate: '2026-10-15',
  totalCost: 1200,
  invoiceNumber: 'INV-77',
  note: 'October run',
}

describe('Inventory actions on the ledger', () => {
  let base: PGlite

  beforeAll(async () => {
    base = await createMigratedDb()
  }, 60_000)
  afterAll(async () => {
    await base.close()
  })
  beforeEach(async () => {
    session.pg = (await base.clone()) as PGlite
    session.auth = PAUL
  })
  afterEach(async () => {
    await session.pg.close()
  })

  it('records house, custom and dog-water fills and lists them', async () => {
    const rose = await createCustomer(fakeSupabase(session.pg, PAUL), {
      name: 'Rose City Taps',
      custom_cans: true,
    })

    const house = expectOk(await addBatch(houseFill)).batch
    const custom = expectOk(
      await addBatch({
        ...houseFill,
        kind: 'custom',
        name: null,
        customerId: rose.id,
        product: 'sparkling',
      })
    ).batch
    const dog = expectOk(
      await addBatch({ ...houseFill, product: 'dog_water', name: 'Portlandica Dog water' })
    ).batch

    expect(house).toMatchObject({
      name: 'Portlandica',
      count: 1440,
      isStill: true,
      isCustom: false,
      product: 'water',
      fillDate: '2026-10-15',
      source: 'North Powder',
      invoiceNumber: 'INV-77',
    })
    expect(custom).toMatchObject({
      name: 'Rose City Taps',
      isCustom: true,
      customer_id: rose.id,
      isStill: false,
    })
    expect(dog).toMatchObject({ product: 'dog_water', isStill: true, isCustom: false })

    const loaded = expectOk(await loadInventory())
    expect(loaded.ledger).toEqual({ mismatches: [] })
    expect(loaded.batches.map((b) => b.id)).toEqual(
      expect.arrayContaining([house.id, custom.id, dog.id, 45])
    )
    expect(loaded.customers).toContainEqual({
      id: rose.id,
      name: 'Rose City Taps',
      customCans: true,
      active: true,
    })

    expect(expectOk(await getBatchHistory(house.id)).entries).toEqual([
      expect.objectContaining({
        reason: 'fill',
        change: 1440,
        balance: 1440,
        by: 'team',
        note: 'October run',
        order: null,
      }),
    ])
  })

  it('changes a count with a note, and refuses to overwrite a change made meanwhile', async () => {
    const stale = await changeBatchCount({
      batchId: 45,
      newCount: 11976,
      expectedCount: 11000,
      note: 'Recount',
    })
    expect(stale).toMatchObject({ ok: false, batch: { id: 45, count: 12000 } })
    expect(stale).toHaveProperty('error', expect.stringContaining('12,000 cans'))

    const saved = expectOk(
      await changeBatchCount({
        batchId: 45,
        newCount: 11976,
        expectedCount: 12000,
        note: 'Recount',
      })
    )
    expect(saved.batch.count).toBe(11976)

    expect(
      expectOk(await getBatchHistory(45)).entries.map((e) => [
        e.reason,
        e.change,
        e.balance,
        e.by,
        e.note,
      ])
    ).toEqual([
      ['adjustment', -24, 11976, 'team', 'Recount'],
      ['opening', 12000, 12000, 'system', 'Count on hand when the ledger started'],
    ])
  })

  it('archives with a reason instead of deleting, and unarchives', async () => {
    expect(await archiveInventoryBatch(36, '')).toMatchObject({
      ok: false,
      error: 'Say why this batch is being archived.',
    })

    const archived = expectOk(await archiveInventoryBatch(36, 'Customer closed')).batch
    expect(archived).toMatchObject({ count: 0, archived_at: expect.any(String) })
    expect(expectOk(await loadInventory()).batches.find((b) => b.id === 36)).toMatchObject({
      archived_at: expect.any(String),
    })
    expect(
      await changeBatchCount({ batchId: 36, newCount: 24, expectedCount: 0, note: 'Found some' })
    ).toEqual({ ok: false, error: 'This batch is archived. Unarchive it first.' })

    const restored = expectOk(await unarchiveInventoryBatch(36, null)).batch
    expect(restored).toMatchObject({ count: 2760, archived_at: null })

    const entries = expectOk(await getBatchHistory(36)).entries
    expect(entries.map((entry) => reasonLabel(entry))).toEqual([
      'Unarchived',
      'Archived',
      'Opening count',
    ])
    expect(entries[1]).toMatchObject({ change: -2760, note: 'Customer closed', by: 'team' })
  })

  it('shows orders on the history, and who made each change', async () => {
    const johnny = fakeSupabase(session.pg, JOHNNY)
    const hotel = await createCustomer(johnny, { name: 'Hotel Vintage', custom_cans: true })
    const { order } = await createSalesOrder(johnny, {
      idempotency_key: 'order-hotel-vintage-1002',
      delivery_type: 'drop',
      customer_id: hotel.id,
      order_date: '2026-10-02',
      lines: [{ product: 'still', cans: 1440, batch_id: 22, unit_price: 2 }],
    })
    await applyOrderInventory(johnny, order.id)
    await voidSalesOrder(fakeSupabase(session.pg, PAUL), order.id, 'Came off house stock')

    const summary = {
      id: order.id,
      customerName: 'Hotel Vintage',
      orderDate: '2026-10-02',
      voided: true,
    }
    expect(
      expectOk(await getBatchHistory(22)).entries.map((e) => [e.reason, e.change, e.by, e.order])
    ).toEqual([
      ['void', 1440, 'team', summary],
      ['order', -1440, 'team', summary],
      ['opening', 2640, 'system', null],
    ])
  })

  it('reports a batch whose count no longer matches its history', async () => {
    // Change a count the way nothing in the app can: skipping the ledger trigger.
    await session.pg.exec(`
      begin;
      select set_config('portlandica.ledger_write', 'on', true);
      update public.inventory set count = count + 5 where id = 45;
      commit;
    `)

    expect(expectOk(await loadInventory()).ledger).toEqual({
      mismatches: [
        { batch_id: 45, name: 'Portlandica', count: 12005, ledger_total: 12000, difference: 5 },
      ],
    })
  })

  it('explains when the database does not treat the account as a partner', async () => {
    session.auth = STRANGER

    expect(await addBatch(houseFill)).toEqual({
      ok: false,
      error: expect.stringContaining('partner list in Supabase'),
    })
  })
})
