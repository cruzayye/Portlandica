// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createCustomer } from './customers'
import {
  adjustBatch,
  archiveBatch,
  batchHoldsProduct,
  batchesForLine,
  getBatch,
  ledgerMismatches,
  listBatches,
  listMovements,
  recordFill,
  unarchiveBatch,
} from './inventory'
import { fakeSupabase } from './testing/fakeSupabase'
import { PAUL, STRANGER, createMigratedDb } from './testing/testDb'
import type { Batch } from './types'

const batch = (over: Partial<Batch> & { id: number }): Batch => ({
  created_at: '2026-01-01T00:00:00Z',
  name: 'Portlandica',
  count: 1440,
  isCustom: false,
  isStill: true,
  fillDate: '2026-01-01',
  totalCost: null,
  invoiceNumber: null,
  source: null,
  initialCount: 1440,
  customer_id: null,
  archived_at: null,
  product: 'water',
  ...over,
})

describe('batchHoldsProduct', () => {
  it('keeps still, sparkling and dog water apart', () => {
    const still = batch({ id: 1 })
    const sparkling = batch({ id: 2, isStill: false })
    const dog = batch({ id: 3, product: 'dog_water' })
    expect(batchHoldsProduct(still, 'still')).toBe(true)
    expect(batchHoldsProduct(still, 'sparkling')).toBe(false)
    expect(batchHoldsProduct(sparkling, 'sparkling')).toBe(true)
    expect(batchHoldsProduct(dog, 'still')).toBe(false)
    expect(batchHoldsProduct(dog, 'dog_water')).toBe(true)
  })
})

describe('batchesForLine', () => {
  const batches = [
    batch({ id: 1, name: 'Portlandica' }),
    batch({ id: 2, name: 'Portlandica Dog water', product: 'dog_water' }),
    batch({ id: 3, name: 'Hollywood Theatre', isCustom: true, customer_id: 10 }),
    batch({ id: 4, name: 'Hotel Vintage ', isCustom: true }),
    batch({ id: 5, name: 'Old', archived_at: '2026-10-01T00:00:00Z' }),
  ]
  const ids = (
    product: 'still' | 'dog_water',
    customer: { id: number | null; name: string | null }
  ) => batchesForLine(batches, product, customer).map((b) => b.id)

  it('offers house stock but never dog water for a still line', () => {
    expect(ids('still', { id: null, name: 'Someone' })).toEqual([1])
    expect(ids('dog_water', { id: null, name: 'The Dog House PDX' })).toEqual([2])
  })

  it("offers a customer their own custom batch and nobody else's", () => {
    expect(ids('still', { id: 10, name: 'Hollywood Theatre' })).toEqual([1, 3])
    expect(ids('still', { id: 11, name: 'Que Dice' })).toEqual([1])
  })

  it('matches an unlinked custom batch on its trimmed, case-insensitive name', () => {
    expect(ids('still', { id: 12, name: 'hotel vintage' })).toEqual([1, 4])
  })
})

describe('batch functions', () => {
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

  it('records a fill for a customer and shows it in the ledger', async () => {
    const db = fakeSupabase(pg, PAUL)
    const customer = await createCustomer(db, { name: 'Dame', custom_cans: true })
    const fill = await recordFill(db, {
      count: 1440,
      is_still: true,
      fill_date: '2026-10-20',
      customer_id: customer.id,
      source: 'North Powder',
      total_cost: 1200,
      note: 'October run',
    })
    expect(fill).toMatchObject({
      name: 'Dame',
      count: 1440,
      isCustom: true,
      customer_id: customer.id,
    })
    expect(await listMovements(db, fill.id)).toMatchObject([
      { delta: 1440, reason: 'fill', note: 'October run', created_by: PAUL.sub },
    ])
  })

  it('adjusts a count, refusing to overwrite a change made meanwhile', async () => {
    const db = fakeSupabase(pg, PAUL)
    await expect(
      adjustBatch(db, 45, 11976, 'Recount', { expectedCount: 11000 })
    ).rejects.toMatchObject({
      code: 'count_changed',
    })
    const adjusted = await adjustBatch(db, 45, 11976, 'Recount', { expectedCount: 12000 })
    expect(adjusted.count).toBe(11976)
    expect((await listMovements(db, 45)).map((m) => [m.reason, m.delta])).toEqual([
      ['opening', 12000],
      ['adjustment', -24],
    ])
  })

  it('archives instead of deleting, hides archived batches, and can undo it', async () => {
    const db = fakeSupabase(pg, PAUL)
    const archived = await archiveBatch(db, 36, 'Customer closed')
    expect(archived.count).toBe(0)
    expect((await listBatches(db)).map((b) => b.id)).not.toContain(36)
    expect((await listBatches(db, { includeArchived: true })).map((b) => b.id)).toContain(36)

    await unarchiveBatch(db, 36)
    expect(await getBatch(db, 36)).toMatchObject({ count: 2760, archived_at: null })
    expect(await ledgerMismatches(db)).toEqual([])
  })

  it('lists batches with the new columns, sorted by name', async () => {
    const batches = await listBatches(fakeSupabase(pg, PAUL))
    expect(batches.map((b) => b.name)).toEqual([
      'Dame',
      'Empty batch',
      'Hotel Vintage ',
      'Portlandica',
      'Portlandica - north powder',
      'Portlandica Dog water',
      'Que Dice',
    ])
    expect(batches.find((b) => b.id === 33)).toMatchObject({
      product: 'dog_water',
      customer_id: null,
    })
  })

  it('refuses ledger changes from non-partners', async () => {
    await expect(adjustBatch(fakeSupabase(pg, STRANGER), 45, 0, 'zero')).rejects.toMatchObject({
      code: 'not_partner',
    })
  })
})
