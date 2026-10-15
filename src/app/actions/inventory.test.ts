// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NewOrder } from '@/types/orders'

// A tiny stand-in for the Supabase query builder, backed by a map of batch counts.
const db = vi.hoisted(() => {
  const counts = new Map<number, number>()
  const updates: { id: number; count: number }[] = []
  const lookups: Record<string, unknown>[] = []
  const from = () => {
    const filters: Record<string, unknown> = {}
    let patch: { count: number } | null = null
    const query = {
      select: () => query,
      update: (values: { count: number }) => {
        patch = values
        return query
      },
      eq: (column: string, value: unknown) => {
        filters[column] = value
        return query
      },
      single: async () => {
        lookups.push({ ...filters })
        const id = filters.id as number | undefined
        return id !== undefined && counts.has(id)
          ? { data: { id, count: counts.get(id) }, error: null }
          : {
              data: null,
              error: { message: 'JSON object requested, multiple (or no) rows returned' },
            }
      },
      then: (resolve: (result: { error: null }) => void) => {
        if (patch) {
          updates.push({ id: filters.id as number, count: patch.count })
          counts.set(filters.id as number, patch.count)
        }
        resolve({ error: null })
      },
    }
    return query
  }
  return { counts, updates, lookups, client: { from } }
})

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => db.client }))

import { decrementInventory } from './inventory'

const order = (over: Partial<NewOrder> = {}): NewOrder => ({
  name: 'Dame',
  customerType: 'existing',
  isStill: false,
  isSpark: false,
  totalStill: null,
  totalSpark: null,
  IsCustomStill: false,
  isCustomSpark: false,
  price: null,
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

const STILL_BATCH = 1
const SPARK_BATCH = 2

beforeEach(() => {
  db.counts.clear()
  db.counts.set(STILL_BATCH, 1440)
  db.counts.set(SPARK_BATCH, 960)
  db.updates.length = 0
  db.lookups.length = 0
})

describe('decrementInventory', () => {
  it('takes each product from its own batch', async () => {
    await decrementInventory(
      order({ isStill: true, totalStill: 120, isSpark: true, totalSpark: 48 }),
      STILL_BATCH,
      SPARK_BATCH
    )
    expect(db.updates).toEqual([
      { id: STILL_BATCH, count: 1320 },
      { id: SPARK_BATCH, count: 912 },
    ])
  })

  it('leaves a switched-off product alone even if its quantity is still filled in', async () => {
    await decrementInventory(
      order({ isStill: false, totalStill: 120, isSpark: true, totalSpark: 48 }),
      STILL_BATCH,
      SPARK_BATCH
    )
    expect(db.updates).toEqual([{ id: SPARK_BATCH, count: 912 }])
    expect(db.counts.get(STILL_BATCH)).toBe(1440)
  })

  it('refuses a product with no batch instead of guessing one', async () => {
    await expect(
      decrementInventory(
        order({ isStill: true, totalStill: 120, isSpark: true, totalSpark: 48 }),
        undefined,
        SPARK_BATCH
      )
    ).rejects.toThrow('No Still batch was selected')

    // Nothing is decremented, not even the product that did have a batch,
    // and no batch is looked up by name.
    expect(db.updates).toEqual([])
    expect(db.lookups.some((filters) => 'name' in filters)).toBe(false)
  })
})
