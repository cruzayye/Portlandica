// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  applySeedPlan,
  batchesCsv,
  buildSeedPlan,
  customersCsv,
  parseAddress,
  type SeedSources,
} from './customerSeed'
import { listBatches } from './inventory'
import { fakeSupabase } from './testing/fakeSupabase'
import { PAUL, SERVICE, createMigratedDb } from './testing/testDb'

describe('parseAddress', () => {
  it.each([
    ['2310 NE Broadway, Portland, OR 97232', ['2310 NE Broadway', 'Portland', 'OR', '97232']],
    [
      '1080 SE Madison St , Portland , OR, 97214',
      ['1080 SE Madison St', 'Portland', 'OR', '97214'],
    ],
    [
      '2550 N Hendrickson Drive, Suite K , Kalama, WA, 98625',
      ['2550 N Hendrickson Drive, Suite K', 'Kalama', 'WA', '98625'],
    ],
    [
      '14313 NE 20th Ave # A112, , Vancouver, WA, 98686',
      ['14313 NE 20th Ave # A112', 'Vancouver', 'WA', '98686'],
    ],
    [
      '12675 Southwest 1st Street, Beaverton, OR',
      ['12675 Southwest 1st Street', 'Beaverton', 'OR', null],
    ],
    ['1307 NE 102nd Ave Portland, OR 97220', ['1307 NE 102nd Ave', 'Portland', 'OR', '97220']],
    [
      '3970 Mercantile DrLake Oswego, OR 97035',
      ['3970 Mercantile Dr', 'Lake Oswego', 'OR', '97035'],
    ],
    [
      '1533 Northwest 24th Ave Suite 100 Portland, Oregon 97210',
      ['1533 Northwest 24th Ave Suite 100', 'Portland', 'OR', '97210'],
    ],
    ['5769 S Kelly Ave., Portland OR 97239', ['5769 S Kelly Ave.', 'Portland', 'OR', '97239']],
    ['2730 S Moody Ave Portland Or, 97201', ['2730 S Moody Ave', 'Portland', 'OR', '97201']],
    [
      '1911 NW 26th Ave, Portland, OR 97210, United States',
      ['1911 NW 26th Ave', 'Portland', 'OR', '97210'],
    ],
    [
      '5250 NE Martin Luther King Blvd\nPortland, OR 97211\nUnited States',
      ['5250 NE Martin Luther King Blvd', 'Portland', 'OR', '97211'],
    ],
    [
      '12321 NE fourth plain blvd Vancouver wa 98682',
      ['12321 NE fourth plain blvd', 'Vancouver', 'WA', '98682'],
    ],
    ['3150 Gustine Ave, St. Louis, MO 63116', ['3150 Gustine Ave', 'St. Louis', 'MO', '63116']],
    [
      '6807 NE 79th Ct #D Portland, Oregon 97218',
      ['6807 NE 79th Ct #D', 'Portland', 'OR', '97218'],
    ],
  ])('splits %j', (raw, [street_address, city, state, zip]) => {
    expect(parseAddress(raw)).toEqual({ street_address, city, state, zip })
  })

  it('keeps what it cannot place in the street', () => {
    expect(parseAddress('Somewhere out east')).toEqual({
      street_address: 'Somewhere out east',
      city: null,
      state: null,
      zip: null,
    })
    expect(parseAddress('')).toEqual({ street_address: null, city: null, state: null, zip: null })
  })
})

const LOCATIONS_HEADER = ['Name', 'Address', 'Latitude', 'Longitude', 'Type of Business']

const sources = (over: Partial<SeedSources> = {}): SeedSources => ({
  locations: [
    LOCATIONS_HEADER,
    ['Que Dice', '722 SE 10th Ave, Portland, OR 97214', '45.5176811', '-122.6554336', 'Restaurant'],
    ['Hotel Vintage', '422 SW Broadway, Portland, OR 97205', '45.5209134', '-122.6785378', 'Hotel'],
    [
      'Embassy Suites by Hilton Portland Downtown',
      '319 SW Pine St, Portland, OR 97204',
      '45.52',
      '-122.67',
      'Hotel',
    ],
    ['La Arepa', '6035 NE Halsey St, Portland, OR 97213', '45.53', '-122.60', 'Food Truck'],
    ['La Arepa', '5716 SE 92nd Ave, Portland, OR 97266', '45.48', '-122.56', 'Food Truck'],
    [
      "Market of Choice (Reed's Crossing)",
      '3515 SE Cornelius Pass Road Hillsboro, Oregon 97123',
      '45.5',
      '-122.9',
      'Grocery',
    ],
    ['Sysco'],
    ['Spirit of Sage', '', '', ''],
    [''],
  ],
  parentCompanies: [
    ['Parent Company', 'Individual Company'],
    ['Market of Choice', 'Market of Choice (Reed’s Crossing)'],
    ['Market of Choice', 'Market of Choice (Corvallis)'],
  ],
  pricing: { 'Que Dice': 2, 'Hotel Vintage': 2, 'Ben Bridge Jeweler (Downtown)': 1.35 },
  paymentTerms: { Sysco: 65 },
  batches: [
    { id: 13, name: 'Que Dice', isCustom: true, customer_id: null },
    { id: 22, name: 'Hotel Vintage ', isCustom: true, customer_id: null },
    {
      id: 31,
      name: 'embassy suites by hilton portland downtown',
      isCustom: true,
      customer_id: null,
    },
    { id: 36, name: 'Dame', isCustom: true, customer_id: null },
    { id: 45, name: 'Portlandica', isCustom: false, customer_id: null },
  ],
  existing: [],
  ...over,
})

describe('buildSeedPlan', () => {
  const plan = buildSeedPlan(sources())
  const customer = (name: string) => plan.customers.find((row) => row.customer.name === name)

  it('builds one customer per name from the locations tab', () => {
    expect(plan.customers.map((row) => row.customer.name)).toEqual([
      'Que Dice',
      'Hotel Vintage',
      'Embassy Suites by Hilton Portland Downtown',
      'La Arepa',
      "Market of Choice (Reed's Crossing)",
      'Sysco',
      'Spirit of Sage',
      'Ben Bridge Jeweler (Downtown)',
    ])
    expect(customer('Que Dice')).toMatchObject({
      action: 'insert',
      customer: {
        type: 'business',
        business_type: 'Restaurant',
        street_address: '722 SE 10th Ave',
        city: 'Portland',
        state: 'OR',
        zip: '97214',
        latitude: 45.5176811,
        longitude: -122.6554336,
        price_per_can: 2,
        custom_cans: true,
      },
      issues: [],
    })
  })

  it('keeps a second address for the same name in notes and flags it', () => {
    expect(customer('La Arepa')?.customer.street_address).toBe('6035 NE Halsey St')
    expect(customer('La Arepa')?.customer.notes).toBe(
      'Also at: 5716 SE 92nd Ave, Portland, OR 97266'
    )
    expect(customer('La Arepa')?.issues[0]).toMatch(/Listed twice/)
  })

  it('adds parent companies, pricing and payment terms', () => {
    expect(customer("Market of Choice (Reed's Crossing)")?.customer.parent_company).toBe(
      'Market of Choice'
    )
    expect(customer('Sysco')).toMatchObject({
      customer: { payment_terms_days: 65 },
      issues: ['No address'],
    })
    expect(customer('Ben Bridge Jeweler (Downtown)')).toMatchObject({
      customer: { price_per_can: 1.35 },
      issues: ['Not in the locations tab'],
    })
    // A price alone isn't a custom-can account; only a custom batch makes one.
    expect(customer('Ben Bridge Jeweler (Downtown)')?.customer.custom_cans).toBeUndefined()
    expect(plan.notes).toEqual([
      'Parent Companies lists "Market of Choice (Corvallis)" (Market of Choice), which isn\'t in the locations tab',
    ])
  })

  it('links custom batches by trimmed, case-insensitive name and lists the rest', () => {
    expect(plan.batches).toEqual([
      {
        batch_id: 13,
        batch_name: 'Que Dice',
        action: 'link',
        customer_name: 'Que Dice',
        rename_to: null,
        suggestions: [],
      },
      {
        batch_id: 22,
        batch_name: 'Hotel Vintage ',
        action: 'link',
        customer_name: 'Hotel Vintage',
        rename_to: 'Hotel Vintage',
        suggestions: [],
      },
      {
        batch_id: 31,
        batch_name: 'embassy suites by hilton portland downtown',
        action: 'link',
        customer_name: 'Embassy Suites by Hilton Portland Downtown',
        rename_to: 'Embassy Suites by Hilton Portland Downtown',
        suggestions: [],
      },
      {
        batch_id: 36,
        batch_name: 'Dame',
        action: 'unmatched',
        customer_name: null,
        rename_to: null,
        suggestions: [],
      },
    ])
    expect(customer('Embassy Suites by Hilton Portland Downtown')).toMatchObject({
      customer: { custom_cans: true },
      issues: ['Has a custom batch but no agreed price; it will default to $1.50'],
    })
  })

  it('leaves customers that already exist alone', () => {
    const again = buildSeedPlan(
      sources({ existing: [{ id: 1, name: 'Que Dice', name_key: 'que dice' }] })
    )
    expect(again.customers.find((row) => row.customer.name === 'Que Dice')?.action).toBe('exists')
  })

  it("stops if a tab's columns move", () => {
    expect(() => buildSeedPlan(sources({ locations: [['Business', 'Where']] }))).toThrow(
      /no "Name" column/
    )
  })
})

describe('CSV output', () => {
  it('quotes commas, quotes and newlines and defuses formulas', () => {
    const plan = buildSeedPlan(
      sources({
        locations: [LOCATIONS_HEADER, ['=HYPERLINK("x")', 'A "quoted", place\nhere', '', '', '']],
        pricing: {},
        paymentTerms: {},
        batches: [],
      })
    )
    const [header, row] = customersCsv(plan).split('\n')
    expect(header).toBe(
      'action,name,type,business_type,parent_company,price_per_can,custom_cans,payment_terms_days,street_address,city,state,zip,latitude,longitude,notes,sources,issues'
    )
    expect(row.startsWith(`insert,"'=HYPERLINK(""x"")",business,`)).toBe(true)
    expect(batchesCsv(plan)).toBe(
      'batch_id,batch_name,action,customer_name,rename_to,suggestions\n'
    )
  })
})

describe('applySeedPlan', () => {
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

  it('inserts the customers and links and renames the matched batches, once', async () => {
    const db = fakeSupabase(pg, SERVICE)
    const plan = buildSeedPlan(
      sources({ batches: (await listBatches(db)).filter((b) => b.isCustom) })
    )
    expect(await applySeedPlan(db, plan)).toEqual({ inserted: 8, linked: 2, renamed: 1 })

    const batches = await listBatches(fakeSupabase(pg, PAUL))
    expect(batches.find((b) => b.id === 22)).toMatchObject({
      name: 'Hotel Vintage',
      customer_id: expect.any(Number),
    })
    expect(batches.find((b) => b.id === 36)?.customer_id).toBeNull()

    const existing = (
      await pg.query<{ id: number; name: string; name_key: string }>(
        'select id, name, name_key from public.customers'
      )
    ).rows
    const rerun = buildSeedPlan(
      sources({ batches: (await listBatches(db)).filter((b) => b.isCustom), existing })
    )
    expect(rerun.customers.every((row) => row.action === 'exists')).toBe(true)
    expect(await applySeedPlan(db, rerun)).toEqual({ inserted: 0, linked: 0, renamed: 0 })
  })
})
