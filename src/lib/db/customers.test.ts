// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createCustomer,
  customerKey,
  findCustomerByName,
  formatAddress,
  getCustomer,
  listCustomers,
  paymentTermsDays,
  pricePerCan,
  updateCustomer,
} from './customers'
import { DbError } from './errors'
import { fakeSupabase } from './testing/fakeSupabase'
import { PAUL, STRANGER, createMigratedDb } from './testing/testDb'

describe('customer helpers', () => {
  it('matches names trimmed and case-insensitively', () => {
    expect(customerKey('  Hotel Vintage ')).toBe('hotel vintage')
  })

  it('falls back to the default price and terms', () => {
    expect(pricePerCan(null)).toBe(1.5)
    expect(pricePerCan({ price_per_can: null })).toBe(1.5)
    expect(pricePerCan({ price_per_can: 2 })).toBe(2)
    expect(paymentTermsDays({ payment_terms_days: null })).toBe(30)
    expect(paymentTermsDays({ payment_terms_days: 65 })).toBe(65)
  })

  it('makes an individual without terms due on receipt, and keeps businesses on 30', () => {
    expect(paymentTermsDays({ payment_terms_days: null, type: 'individual' })).toBe(0)
    expect(paymentTermsDays({ payment_terms_days: null, type: 'business' })).toBe(30)
    // A one-off individual has no customer row: the order's type decides.
    expect(paymentTermsDays(null, 'individual')).toBe(0)
    expect(paymentTermsDays(null, 'business')).toBe(30)
    expect(paymentTermsDays(null)).toBe(30)
    // Terms set on the customer always win.
    expect(paymentTermsDays({ payment_terms_days: 14, type: 'individual' })).toBe(14)
    expect(paymentTermsDays({ payment_terms_days: 65, type: 'business' }, 'individual')).toBe(65)
  })

  it('formats an address on one line, skipping blanks', () => {
    expect(
      formatAddress({
        street_address: '2310 NE Broadway',
        city: 'Portland',
        state: 'OR',
        zip: '97232',
      })
    ).toBe('2310 NE Broadway, Portland, OR 97232')
    expect(formatAddress({ street_address: null, city: 'Portland', state: 'OR', zip: null })).toBe(
      'Portland, OR'
    )
  })
})

describe('customer queries', () => {
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

  it('creates a customer with tidied fields', async () => {
    const db = fakeSupabase(pg, PAUL)
    const customer = await createCustomer(db, {
      name: '  Hotel Vintage ',
      business_type: 'Hotel',
      street_address: ' 422 SW Broadway ',
      city: 'Portland',
      state: 'or',
      zip: '97205',
      notes: '   ',
      email: ' Frontdesk@HotelVintage.example ',
      price_per_can: 2,
      custom_cans: true,
    })
    expect(customer).toMatchObject({
      name: 'Hotel Vintage',
      name_key: 'hotel vintage',
      type: 'business',
      street_address: '422 SW Broadway',
      state: 'OR',
      notes: null,
      email: 'frontdesk@hotelvintage.example',
      price_per_can: 2,
      custom_cans: true,
      active: true,
    })
    expect(await getCustomer(db, customer.id)).toEqual(customer)
  })

  it('treats names that differ only in case or spacing as the same customer', async () => {
    const db = fakeSupabase(pg, PAUL)
    await createCustomer(db, { name: 'Hotel Vintage' })
    const error = await createCustomer(db, { name: 'hotel vintage ' }).catch((e) => e)
    expect(error).toBeInstanceOf(DbError)
    expect(error.code).toBe('duplicate')
    expect((await findCustomerByName(db, ' HOTEL VINTAGE'))?.name).toBe('Hotel Vintage')
    expect(await findCustomerByName(db, 'Hotel Vintage Annex')).toBeNull()
  })

  it('needs a name', async () => {
    await expect(createCustomer(fakeSupabase(pg, PAUL), { name: '   ' })).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })

  it('updates and hides inactive customers by default', async () => {
    const db = fakeSupabase(pg, PAUL)
    const sysco = await createCustomer(db, { name: 'Sysco' })
    await createCustomer(db, { name: 'Que Dice' })
    const updated = await updateCustomer(db, sysco.id, { payment_terms_days: 65, active: false })
    expect(updated.payment_terms_days).toBe(65)
    expect((await listCustomers(db)).map((c) => c.name)).toEqual(['Que Dice'])
    expect((await listCustomers(db, { includeInactive: true })).map((c) => c.name)).toEqual([
      'Que Dice',
      'Sysco',
    ])
  })

  it('keeps customers away from signed-in non-partners', async () => {
    await createCustomer(fakeSupabase(pg, PAUL), { name: 'Que Dice' })
    const db = fakeSupabase(pg, STRANGER)
    expect(await listCustomers(db)).toEqual([])
    await expect(createCustomer(db, { name: 'Sneaky' })).rejects.toMatchObject({
      code: 'not_partner',
    })
  })
})
