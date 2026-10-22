// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

// The Inventory tab's actions with the data modules mocked: what they pass to the ledger
// functions, what they refuse before getting there, and how database errors read.
// batches.pglite.test.ts runs the same actions against the real SQL.

const mocks = vi.hoisted(() => ({
  client: { label: 'supabase client' },
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  recordFill: vi.fn(),
  adjustBatch: vi.fn(),
  archiveBatch: vi.fn(),
  unarchiveBatch: vi.fn(),
  listMovements: vi.fn(),
  ledgerMismatches: vi.fn(),
  listCustomers: vi.fn(),
  listOrderSummaries: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.client }))
// Sign-in is covered by auth.test.ts; act as a signed-in device here.
vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: async () => ({ failure: null }),
}))
vi.mock('@/lib/db/inventory', () => ({
  listBatches: mocks.listBatches,
  getBatch: mocks.getBatch,
  recordFill: mocks.recordFill,
  adjustBatch: mocks.adjustBatch,
  archiveBatch: mocks.archiveBatch,
  unarchiveBatch: mocks.unarchiveBatch,
  listMovements: mocks.listMovements,
  ledgerMismatches: mocks.ledgerMismatches,
}))
vi.mock('@/lib/db/customers', () => ({ listCustomers: mocks.listCustomers }))
vi.mock('@/lib/db/orderSummaries', () => ({ listOrderSummaries: mocks.listOrderSummaries }))

import { DbError } from '@/lib/db/errors'
import type { Customer, InventoryMovement } from '@/lib/db/types'
import { batch } from '@/components/Inventory/testing/fixtures'
import type { NewBatchInput } from '@/components/Inventory/types'
import {
  addBatch,
  archiveInventoryBatch,
  changeBatchCount,
  getBatchHistory,
  loadInventory,
  unarchiveInventoryBatch,
} from './batches'

const { client } = mocks

const raise = (hint: string, message = 'from the database', code = 'P0001') =>
  new DbError({ message, code, hint, details: null })

const fill = (over: Partial<NewBatchInput> = {}): NewBatchInput => ({
  kind: 'house',
  product: 'still',
  cans: 1440,
  name: ' Portlandica ',
  customerId: null,
  source: 'North Powder',
  fillDate: '2026-10-15',
  totalCost: 1200,
  invoiceNumber: ' INV-77 ',
  note: '  ',
  ...over,
})

const customerRow = (over: Partial<Customer> & { id: number; name: string }): Customer => ({
  name_key: over.name.toLowerCase(),
  type: 'business',
  business_type: null,
  parent_company: null,
  price_per_can: 2,
  custom_cans: false,
  payment_terms_days: null,
  street_address: '1 Main St',
  city: 'Portland',
  state: 'OR',
  zip: '97201',
  latitude: null,
  longitude: null,
  email: 'billing@example.com',
  square_customer_id: null,
  invoiced_outside_square: false,
  active: true,
  notes: null,
  created_at: '2026-10-15T00:00:00Z',
  updated_at: '2026-10-15T00:00:00Z',
  ...over,
})

const movement = (over: Partial<InventoryMovement> & { id: number }): InventoryMovement => ({
  batch_id: 7,
  delta: 0,
  reason: 'adjustment',
  order_id: null,
  order_line_id: null,
  note: null,
  created_by: null,
  made_in_app: false,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
})

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  vi.clearAllMocks()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('loadInventory', () => {
  it('returns every batch, the customers and any ledger mismatch', async () => {
    mocks.listBatches.mockResolvedValue([
      batch({ id: 1 }),
      batch({ id: 2, count: null as unknown as number, name: null as unknown as string }),
    ])
    mocks.listCustomers.mockResolvedValue([
      customerRow({ id: 5, name: 'Dame', custom_cans: true }),
      customerRow({ id: 6, name: 'Gone', active: false }),
    ])
    mocks.ledgerMismatches.mockResolvedValue([
      { batch_id: 1, name: 'Portlandica', count: 1440, ledger_total: 1416, difference: 24 },
    ])

    const result = await loadInventory()

    expect(mocks.listBatches).toHaveBeenCalledWith(client, { includeArchived: true })
    expect(mocks.listCustomers).toHaveBeenCalledWith(client, { includeInactive: true })
    expect(result).toEqual({
      ok: true,
      // A row without a count or name shows as 0 cans, "Unnamed batch".
      batches: [batch({ id: 1 }), batch({ id: 2, count: 0, name: 'Unnamed batch' })],
      // Only what the tab needs: no prices, addresses or emails go to the browser.
      customers: [
        { id: 5, name: 'Dame', customCans: true, active: true },
        { id: 6, name: 'Gone', customCans: false, active: false },
      ],
      ledger: {
        mismatches: [
          { batch_id: 1, name: 'Portlandica', count: 1440, ledger_total: 1416, difference: 24 },
        ],
      },
    })
  })

  it('still loads when the ledger check fails', async () => {
    mocks.listBatches.mockResolvedValue([])
    mocks.listCustomers.mockResolvedValue([])
    mocks.ledgerMismatches.mockRejectedValue(new Error('view missing'))

    expect(await loadInventory()).toEqual({
      ok: true,
      batches: [],
      customers: [],
      ledger: { error: 'Could not check that every count matches its history.' },
    })
  })

  it('returns a message, not a throw, when loading fails', async () => {
    mocks.listBatches.mockRejectedValue(new Error('network down'))
    mocks.listCustomers.mockResolvedValue([])
    mocks.ledgerMismatches.mockResolvedValue([])

    expect(await loadInventory()).toEqual({
      ok: false,
      error: 'Could not load the inventory. Try again.',
    })
    expect(consoleError).toHaveBeenCalled()
  })
})

describe('addBatch', () => {
  it('records a house fill through record_fill, tidying the text', async () => {
    mocks.recordFill.mockResolvedValue(batch({ id: 101 }))

    expect(await addBatch(fill())).toEqual({ ok: true, batch: batch({ id: 101 }) })
    expect(mocks.recordFill).toHaveBeenCalledWith(client, {
      count: 1440,
      is_still: true,
      fill_date: '2026-10-15',
      name: 'Portlandica',
      customer_id: null,
      source: 'North Powder',
      total_cost: 1200,
      invoice_number: 'INV-77',
      note: undefined,
    })
  })

  it('records custom cans for the picked customer, named after them', async () => {
    mocks.recordFill.mockResolvedValue(batch({ id: 102, isCustom: true }))

    await addBatch(
      fill({
        kind: 'custom',
        name: 'typed name',
        customerId: 5,
        product: 'sparkling',
        note: 'October run',
      })
    )

    expect(mocks.recordFill).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        name: null,
        customer_id: 5,
        is_still: false,
        note: 'October run',
      })
    )
  })

  it('records a dog water fill as house still stock, with no product of its own', async () => {
    mocks.recordFill.mockResolvedValue(batch({ id: 103 }))

    await addBatch(fill({ name: 'Portlandica Dog water' }))

    const [, recorded] = mocks.recordFill.mock.calls[0]
    expect(recorded).toMatchObject({ name: 'Portlandica Dog water', is_still: true })
    expect(recorded).not.toHaveProperty('product')
  })

  it('refuses a product other than still or sparkling', async () => {
    expect(await addBatch(fill({ product: 'dog_water' as never }))).toEqual({
      ok: false,
      error: 'Choose still or sparkling.',
    })
    expect(mocks.recordFill).not.toHaveBeenCalled()
  })

  it('refuses an incomplete fill without touching the database', async () => {
    expect(await addBatch(fill({ source: '' }))).toEqual({
      ok: false,
      error: 'Pick the water source.',
    })
    expect(await addBatch(fill({ kind: 'custom', customerId: null }))).toEqual({
      ok: false,
      error: 'Pick the customer these cans were filled for.',
    })
    expect(await addBatch(null as unknown as NewBatchInput)).toEqual({
      ok: false,
      error: 'Fill in the batch details.',
    })
    expect(mocks.recordFill).not.toHaveBeenCalled()
  })

  it('passes on the ledger functions’ own wording, and nothing else from the database', async () => {
    mocks.recordFill.mockRejectedValueOnce(
      raise('invalid_input', 'A fill needs a positive number of cans')
    )
    expect(await addBatch(fill())).toEqual({
      ok: false,
      error: 'A fill needs a positive number of cans',
    })

    mocks.recordFill.mockRejectedValueOnce(
      new DbError({
        message: 'violates check constraint "x"',
        code: '23514',
        hint: null,
        details: null,
      })
    )
    expect(await addBatch(fill())).toEqual({
      ok: false,
      error: 'Could not add the batch. Try again.',
    })
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('explains a missing customer and a server key the database refuses', async () => {
    mocks.recordFill.mockRejectedValueOnce(raise('customer_not_found'))
    expect(await addBatch(fill({ kind: 'custom', customerId: 9 }))).toEqual({
      ok: false,
      error: 'That customer no longer exists. Refresh and pick again.',
    })

    mocks.recordFill.mockRejectedValueOnce(raise('not_partner', 'Only partners', '42501'))
    expect(await addBatch(fill())).toEqual({
      ok: false,
      error: expect.stringContaining('SUPABASE_SECRET_KEY'),
    })
  })
})

describe('changeBatchCount', () => {
  const change = { batchId: 7, newCount: 216, expectedCount: 240, note: ' Recount ' }

  it('sets the counted number with the note, guarded by the count the partner saw', async () => {
    mocks.adjustBatch.mockResolvedValue(batch({ id: 7, count: 216 }))

    expect(await changeBatchCount(change)).toEqual({
      ok: true,
      batch: batch({ id: 7, count: 216 }),
    })
    expect(mocks.adjustBatch).toHaveBeenCalledWith(client, 7, 216, 'Recount', {
      expectedCount: 240,
    })
  })

  it('needs a note and a count of 0 or more', async () => {
    expect(await changeBatchCount({ ...change, note: '' })).toEqual({
      ok: false,
      error: 'Say why the count is changing.',
    })
    expect(await changeBatchCount({ ...change, newCount: -24 })).toEqual({
      ok: false,
      error: 'Enter the number of cans you counted (0 or more).',
    })
    expect(mocks.adjustBatch).not.toHaveBeenCalled()
  })

  it('hands back the batch as it is now when someone changed it meanwhile', async () => {
    mocks.adjustBatch.mockRejectedValue(raise('count_changed'))
    mocks.getBatch.mockResolvedValue(batch({ id: 7, count: 200 }))

    expect(await changeBatchCount(change)).toEqual({
      ok: false,
      error:
        'Someone changed this batch to 200 cans while you were editing. Check your count and save again.',
      batch: batch({ id: 7, count: 200 }),
    })
  })

  it('says so when the batch is gone or archived', async () => {
    mocks.adjustBatch.mockRejectedValueOnce(raise('count_changed'))
    mocks.getBatch.mockResolvedValueOnce(null)
    expect(await changeBatchCount(change)).toEqual({
      ok: false,
      error: 'This batch no longer exists. Refresh the list.',
    })

    mocks.adjustBatch.mockRejectedValueOnce(raise('batch_archived'))
    expect(await changeBatchCount(change)).toEqual({
      ok: false,
      error: 'This batch is archived. Unarchive it first.',
    })
  })
})

describe('archiveInventoryBatch', () => {
  it('needs a reason before writing off cans', async () => {
    mocks.getBatch.mockResolvedValue(batch({ id: 7, count: 240 }))

    expect(await archiveInventoryBatch(7, ' ')).toEqual({
      ok: false,
      error: 'Say why this batch is being archived.',
      batch: batch({ id: 7, count: 240 }),
    })
    expect(mocks.archiveBatch).not.toHaveBeenCalled()
  })

  it('archives with the reason', async () => {
    mocks.getBatch.mockResolvedValue(batch({ id: 7, count: 240 }))
    const archived = batch({ id: 7, count: 0, archived_at: '2026-10-15T20:00:00Z' })
    mocks.archiveBatch.mockResolvedValue(archived)

    expect(await archiveInventoryBatch(7, ' Customer closed ')).toEqual({
      ok: true,
      batch: archived,
    })
    expect(mocks.archiveBatch).toHaveBeenCalledWith(client, 7, 'Customer closed')
  })

  it('archives an empty batch without a reason', async () => {
    mocks.getBatch.mockResolvedValue(batch({ id: 7, count: 0 }))
    mocks.archiveBatch.mockResolvedValue(
      batch({ id: 7, count: 0, archived_at: '2026-10-15T20:00:00Z' })
    )

    expect(await archiveInventoryBatch(7, null)).toMatchObject({ ok: true })
    expect(mocks.archiveBatch).toHaveBeenCalledWith(client, 7, undefined)
  })

  it('leaves an archived batch as it is', async () => {
    const archived = batch({ id: 7, count: 0, archived_at: '2026-10-15T20:00:00Z' })
    mocks.getBatch.mockResolvedValue(archived)

    expect(await archiveInventoryBatch(7, null)).toEqual({ ok: true, batch: archived })
    expect(mocks.archiveBatch).not.toHaveBeenCalled()
  })

  it('refuses a missing batch or a bad id', async () => {
    mocks.getBatch.mockResolvedValue(null)
    expect(await archiveInventoryBatch(7, 'x')).toEqual({
      ok: false,
      error: 'This batch no longer exists. Refresh the list.',
    })
    expect(await archiveInventoryBatch('7' as unknown as number, 'x')).toEqual({
      ok: false,
      error: 'Pick a batch.',
    })
  })
})

describe('unarchiveInventoryBatch', () => {
  it('puts the batch back, with the note if there is one', async () => {
    mocks.unarchiveBatch.mockResolvedValue(batch({ id: 7, count: 240 }))

    expect(await unarchiveInventoryBatch(7, '')).toEqual({
      ok: true,
      batch: batch({ id: 7, count: 240 }),
    })
    expect(mocks.unarchiveBatch).toHaveBeenCalledWith(client, 7, undefined)

    await unarchiveInventoryBatch(7, 'Reopened')
    expect(mocks.unarchiveBatch).toHaveBeenLastCalledWith(client, 7, 'Reopened')
  })

  it('refuses a note that is too long', async () => {
    expect(await unarchiveInventoryBatch(7, 'x'.repeat(501))).toEqual({
      ok: false,
      error: 'Keep the note under 500 characters.',
    })
    expect(mocks.unarchiveBatch).not.toHaveBeenCalled()
  })
})

describe('getBatchHistory', () => {
  const movements = [
    movement({ id: 1, delta: 2640, reason: 'opening' }),
    movement({
      id: 2,
      delta: -1440,
      reason: 'order',
      order_id: 12,
      order_line_id: 30,
      made_in_app: true,
    }),
    movement({ id: 3, delta: -24, reason: 'adjustment', made_in_app: true, note: 'Recount' }),
  ]

  it('returns the history newest first, with orders and who made each change', async () => {
    mocks.listMovements.mockResolvedValue(movements)
    mocks.listOrderSummaries.mockResolvedValue([
      { id: 12, customer_name: 'Hotel Vintage', order_date: '2026-10-02', voided_at: null },
    ])

    const result = await getBatchHistory(7)

    expect(mocks.listMovements).toHaveBeenCalledWith(client, 7)
    expect(mocks.listOrderSummaries).toHaveBeenCalledWith(client, [12])
    expect(result).toEqual({
      ok: true,
      entries: [
        expect.objectContaining({ id: 3, change: -24, balance: 1176, by: 'team', note: 'Recount' }),
        expect.objectContaining({
          id: 2,
          balance: 1200,
          by: 'team',
          order: { id: 12, customerName: 'Hotel Vintage', orderDate: '2026-10-02', voided: false },
        }),
        expect.objectContaining({ id: 1, balance: 2640, by: 'system', reason: 'opening' }),
      ],
    })
  })

  it('still shows the history when the order details can’t be read', async () => {
    mocks.listMovements.mockResolvedValue(movements)
    mocks.listOrderSummaries.mockRejectedValue(new Error('no access'))

    const result = await getBatchHistory(7)

    expect(result).toMatchObject({ ok: true })
    expect(result).toHaveProperty(['entries', 1, 'order'], {
      id: 12,
      customerName: null,
      orderDate: null,
      voided: false,
    })
  })

  it('returns a message when the history can’t be read', async () => {
    mocks.listMovements.mockRejectedValue(new Error('timeout'))

    expect(await getBatchHistory(7)).toEqual({
      ok: false,
      error: 'Could not load the history. Try again.',
    })
    expect(await getBatchHistory(0)).toEqual({ ok: false, error: 'Pick a batch.' })
  })
})
