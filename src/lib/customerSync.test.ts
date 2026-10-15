// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCustomer, findCustomerByName, updateCustomer } from '@/lib/db/customers'
import { fakeSupabase } from '@/lib/db/testing/fakeSupabase'
import { PAUL, createMigratedDb } from '@/lib/db/testing/testDb'
import type { Customer, Db } from '@/lib/db/types'
import type { SheetLocation } from '@/lib/google/sheets'

const mocks = vi.hoisted(() => ({
  geocodeAddress: vi.fn(),
  writeLocationCoordinates: vi.fn(),
}))
vi.mock('@/lib/geocode', () => ({ geocodeAddress: mocks.geocodeAddress }))
vi.mock('@/lib/google/sheets', () => ({ writeLocationCoordinates: mocks.writeLocationCoordinates }))

import { businessTypes, customerOptions, geocodeNewCustomer, syncCustomers } from './customerSync'

let base: PGlite
let pg: PGlite
let db: Db

beforeAll(async () => {
  base = await createMigratedDb()
}, 60_000)
afterAll(async () => {
  await base.close()
})
beforeEach(async () => {
  pg = (await base.clone()) as PGlite
  db = fakeSupabase(pg, PAUL)
  mocks.geocodeAddress.mockReset()
  mocks.writeLocationCoordinates.mockReset().mockResolvedValue(true)
})
afterEach(async () => {
  await pg.close()
})

vi.spyOn(console, 'error').mockImplementation(() => {})
vi.spyOn(console, 'info').mockImplementation(() => {})

const location = (over: Partial<SheetLocation> & { name: string }): SheetLocation => ({
  address: '',
  latitude: null,
  longitude: null,
  businessType: '',
  ...over,
})

describe('syncCustomers', () => {
  it('adds names from the locations tab that are missing, once each', async () => {
    const { customers, added } = await syncCustomers(db, [
      location({
        name: 'The Realm Refillery',
        address: '2310 NE Broadway, Portland, OR 97232',
        latitude: 45.5347519,
        longitude: -122.6419521,
        businessType: 'Grocery',
      }),
      location({ name: 'Fabo’s Tacos', address: '12395 SW Broadway St, Beaverton, OR 97005' }),
      location({ name: 'the realm refillery ', address: 'Somewhere else' }),
    ])
    expect(added).toBe(2)
    expect(customers.map((c) => c.name).sort()).toEqual(['Fabo’s Tacos', 'The Realm Refillery'])
    expect(await findCustomerByName(db, 'The Realm Refillery')).toMatchObject({
      type: 'business',
      business_type: 'Grocery',
      street_address: '2310 NE Broadway',
      city: 'Portland',
      state: 'OR',
      zip: '97232',
      latitude: 45.5347519,
      longitude: -122.6419521,
      price_per_can: null,
      custom_cans: false,
    })
  })

  it('never changes a customer that is already there', async () => {
    const hotel = await createCustomer(db, {
      name: 'Hotel Vintage',
      price_per_can: 2,
      custom_cans: true,
      email: 'ap@hotelvintage.example',
    })
    const { customers, added } = await syncCustomers(db, [
      location({ name: 'hotel vintage ', address: '422 SW Broadway, Portland, OR 97205' }),
    ])
    expect(added).toBe(0)
    expect(customers).toEqual([hotel])
  })

  it('keeps going when someone else adds the same name at the same moment', async () => {
    // Another partner's page adds Crisp Salads just before this one's bulk insert.
    let raced = false
    const racing = {
      rpc: db.rpc.bind(db),
      from: (table: string) => {
        const query = db.from(table)
        if (table !== 'customers' || raced) return query
        const insert = query.insert.bind(query)
        return Object.assign(query, {
          insert: (rows: object) => {
            raced = true
            const builder = insert(rows)
            return {
              select: () =>
                createCustomer(db, { name: 'Crisp Salads' }).then(() => builder.select()),
            }
          },
        })
      },
    } as unknown as Db
    const { customers, added } = await syncCustomers(racing, [
      location({ name: 'Crisp Salads' }),
      location({ name: 'Baerlic Brewery' }),
    ])
    expect(added).toBe(1)
    expect(customers.map((c) => c.name).sort()).toEqual(['Baerlic Brewery', 'Crisp Salads'])
  })
})

describe('customerOptions', () => {
  it('offers active businesses by name, with the address as the tab writes it', async () => {
    const dame = await createCustomer(db, {
      name: 'Dame',
      street_address: '2930 NE Killingsworth St',
      city: 'Portland',
      state: 'OR',
      zip: '97211',
      price_per_can: 1.75,
      custom_cans: true,
    })
    const clyde = await createCustomer(db, { name: 'Clyde Hotel' })
    await createCustomer(db, { name: 'Pat Doe', type: 'individual' })
    const gone = await createCustomer(db, { name: 'Closed Cafe' })
    await updateCustomer(db, gone.id, { active: false })
    const all = (await db.from('customers').select('*')).data as Customer[]

    expect(
      customerOptions(all, [location({ name: 'clyde hotel', address: '1022 SW Stark St' })])
    ).toEqual([
      {
        id: clyde.id,
        name: 'Clyde Hotel',
        business_type: null,
        price_per_can: null,
        custom_cans: false,
        email: null,
        address: '1022 SW Stark St',
      },
      {
        id: dame.id,
        name: 'Dame',
        business_type: null,
        price_per_can: 1.75,
        custom_cans: true,
        email: null,
        address: '2930 NE Killingsworth St, Portland, OR 97211',
      },
    ])
  })

  it("lists the tab's business types first, then any others on file", () => {
    const customers = [
      { business_type: 'Hotel' },
      { business_type: 'Cafe' },
      { business_type: null },
    ]
    expect(
      businessTypes(customers as Customer[], [
        location({ name: 'a', businessType: 'Cafe' }),
        location({ name: 'b', businessType: 'Grocery ' }),
      ])
    ).toEqual(['Cafe', 'Grocery', 'Hotel'])
  })
})

describe('geocodeNewCustomer', () => {
  const newBusiness = () =>
    createCustomer(db, {
      name: 'Baerlic Brewery',
      street_address: '2235 SE 11th Ave',
      city: 'Portland',
      state: 'OR',
      zip: '97214',
    })

  it('saves the coordinates on the customer and the locations tab', async () => {
    mocks.geocodeAddress.mockResolvedValue({
      latitude: 45.5,
      longitude: -122.65,
      matchedAddress: '2235 SE 11TH AVE, PORTLAND, OR, 97214',
    })
    const customer = await newBusiness()
    await geocodeNewCustomer(db, customer)

    expect(mocks.geocodeAddress).toHaveBeenCalledWith('2235 SE 11th Ave, Portland, OR 97214')
    expect(await findCustomerByName(db, 'Baerlic Brewery')).toMatchObject({
      latitude: 45.5,
      longitude: -122.65,
    })
    expect(mocks.writeLocationCoordinates).toHaveBeenCalledWith('Baerlic Brewery', 45.5, -122.65)
  })

  it('leaves them blank when the address has no match or the geocoder fails', async () => {
    const customer = await newBusiness()
    mocks.geocodeAddress.mockResolvedValueOnce(null)
    expect(await geocodeNewCustomer(db, customer)).toBeNull()
    mocks.geocodeAddress.mockRejectedValueOnce(new Error('Census geocoder timed out'))
    expect(await geocodeNewCustomer(db, customer)).toBeNull()
    expect(mocks.writeLocationCoordinates).not.toHaveBeenCalled()
    expect((await findCustomerByName(db, 'Baerlic Brewery'))?.latitude).toBeNull()
  })

  it('still writes the sheet when saving on the customer fails', async () => {
    mocks.geocodeAddress.mockResolvedValue({
      latitude: 45.5,
      longitude: -122.65,
      matchedAddress: '',
    })
    const customer = await newBusiness()
    await geocodeNewCustomer(db, { ...customer, id: 999_999 })
    expect(mocks.writeLocationCoordinates).toHaveBeenCalled()
  })

  it('skips a customer with no address or with coordinates already', async () => {
    const noAddress = await createCustomer(db, { name: 'Sysco' })
    await geocodeNewCustomer(db, noAddress)
    await geocodeNewCustomer(db, { ...(await newBusiness()), latitude: 45, longitude: -122 })
    expect(mocks.geocodeAddress).not.toHaveBeenCalled()
  })
})
