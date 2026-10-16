// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NewOrder } from '@/types/orders'

type Write = { range: string; values: unknown[][] }
type WriteRequest = { range: string; requestBody: { values: unknown[][] } }

// An in-memory stand-in for the Sheets API that records every write.
const sheetsApi = vi.hoisted(() => {
  const tabs: Record<string, unknown[][]> = {}
  const writes: Write[] = []
  const appends: Write[] = []
  const inserts: unknown[] = []
  const api = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { title: 'Sales', sheetId: 7 } }] } }),
      batchUpdate: async ({ requestBody }: { requestBody: unknown }) => {
        inserts.push(requestBody)
      },
      values: {
        get: async ({ range }: { range: string }) => ({ data: { values: tabs[range] ?? [] } }),
        update: async ({ range, requestBody }: WriteRequest) => {
          writes.push({ range, values: requestBody.values })
        },
        append: async ({ range, requestBody }: WriteRequest) => {
          appends.push({ range, values: requestBody.values })
        },
      },
    },
  }
  return { tabs, writes, appends, inserts, api }
})

vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: class {} },
    sheets: () => sheetsApi.api,
  },
}))

import { appendOrder } from './sheets'

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

// Sales columns, 0-indexed
const TYPE = 1
const PRODUCT = 2
const UNITS = 4
const SALES = 5
const COGS_PER_UNIT = 13
const COGS_TOTAL = 14
const NOTES = 15

// Sales rows written into the inserted block (A:V), keyed by sheet row number.
const salesRowsWritten = () =>
  sheetsApi.writes
    .filter((w) => /^Sales!A\d+:V\d+$/.test(w.range))
    .flatMap((w) => {
      const first = Number(w.range.match(/^Sales!A(\d+)/)![1])
      return w.values.map((row, i) => ({ sheetRow: first + i, row }))
    })

beforeEach(() => {
  vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_JSON', '{}')
  vi.stubEnv('GOOGLE_SHEET_ID', 'test-sheet')
  for (const key of Object.keys(sheetsApi.tabs)) delete sheetsApi.tabs[key]
  sheetsApi.writes.length = 0
  sheetsApi.appends.length = 0
  sheetsApi.inserts.length = 0
  // Header plus two orders; the Total row below them has nothing in column A.
  sheetsApi.tabs['Sales!A:A'] = [['Date'], ['10/01/2026'], ['10/02/2026']]
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('appendOrder Sales formulas', () => {
  it('multiplies COGS per unit by the units on the same row', async () => {
    await appendOrder(
      order({ isStill: true, totalStill: 120, isSpark: true, totalSpark: 48, price: 252 })
    )

    const rows = salesRowsWritten()
    expect(rows.map((r) => r.sheetRow)).toEqual([4, 5])
    for (const { sheetRow, row } of rows) {
      expect(row[COGS_PER_UNIT]).toBe(`=XLOOKUP(M${sheetRow},Inventory!A:A,Inventory!P:P,0,0)`)
      expect(row[COGS_TOTAL]).toBe(`=N${sheetRow}*E${sheetRow}`)
    }
  })
})

describe('appendOrder products', () => {
  it('splits the price between products by cans', async () => {
    await appendOrder(
      order({ isStill: true, totalStill: 120, isSpark: true, totalSpark: 48, price: 252 })
    )

    expect(salesRowsWritten().map(({ row }) => [row[PRODUCT], row[UNITS], row[SALES]])).toEqual([
      ['Still Cans', 120, 180],
      ['Sparkling Cans', 48, 72],
    ])
  })

  it('ignores a switched-off product even if its quantity is still filled in', async () => {
    await appendOrder(
      order({ isStill: false, totalStill: 120, isSpark: true, totalSpark: 48, price: 72 })
    )

    expect(salesRowsWritten().map(({ row }) => [row[PRODUCT], row[UNITS], row[SALES]])).toEqual([
      ['Sparkling Cans', 48, 72],
    ])
  })
})

describe('appendOrder donations', () => {
  beforeEach(() => {
    sheetsApi.tabs['Donations!A:A'] = [['Date'], ['09/30/2026']]
  })

  it.each([
    ['with the auto price still filled in', 180],
    ['at $0', 0],
    ['with no price', null],
  ])('writes a donation %s to the Donations tab only', async (_, price) => {
    await appendOrder(
      order({ isDonation: true, isStill: true, totalStill: 120, price, notes: 'Gala' })
    )

    expect(salesRowsWritten()).toEqual([])
    expect(sheetsApi.inserts).toEqual([])
    const donation = sheetsApi.writes.find((w) => w.range.startsWith('Donations!'))!
    expect(donation.range).toBe('Donations!A3:K3')
    expect(donation.values[0].slice(1, 6)).toEqual(['DONATIONS', 'Still Cans', 'Dame', 120, 'A7'])
    expect(donation.values[0][10]).toBe('Gala')
  })

  it('writes nothing to Donations for a sale', async () => {
    await appendOrder(order({ isStill: true, totalStill: 120, price: 180 }))

    expect(salesRowsWritten()).toHaveLength(1)
    expect(sheetsApi.writes.some((w) => w.range.startsWith('Donations!'))).toBe(false)
  })
})

describe('appendOrder new business', () => {
  it('adds the typed address to Current Locations Addresses and keeps notes in Sales', async () => {
    await appendOrder(
      order({
        name: 'Fresh Cafe',
        customerType: 'new',
        businessType: 'Cafe',
        streetAddress: '1 SW Main St',
        city: 'Portland',
        state: 'OR',
        zip: '97204',
        notes: 'Call ahead',
        isStill: true,
        totalStill: 120,
        price: 180,
      })
    )

    expect(sheetsApi.appends).toEqual([
      {
        range: 'Current Locations Addresses!A:E',
        values: [['Fresh Cafe', '1 SW Main St, Portland, OR, 97204', '', '', 'Cafe']],
      },
    ])
    expect(salesRowsWritten()[0].row[NOTES]).toBe('Call ahead')
  })
})

describe('appendOrder customer type', () => {
  it.each([
    ['existing', 'Business'],
    ['new', 'Business'],
    ['individual', 'Individual'],
  ] as const)('books a %s customer as %s', async (customerType, type) => {
    await appendOrder(order({ customerType, isStill: true, totalStill: 120, price: 180 }))
    expect(salesRowsWritten()[0].row[TYPE]).toBe(type)
  })

  it.each(['existing', 'individual'] as const)(
    'adds no Current Locations Addresses row for a %s customer',
    async (customerType) => {
      await appendOrder(order({ customerType, isStill: true, totalStill: 120, price: 180 }))
      expect(sheetsApi.appends).toEqual([])
    }
  )
})
