// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeSheets, type FakeCell, type FakeSheets } from './testing/fakeSheets'

const sheet = vi.hoisted(() => ({ current: null as FakeSheets | null }))

vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: class {} },
    sheets: () => sheet.current!.api,
  },
}))
vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_JSON', '{}')
vi.stubEnv('GOOGLE_SHEET_ID', 'sheet-1')

import {
  findOrderRows,
  findSameDaySheetOrder,
  getLocationsFromSheet,
  untagOrderRows,
  writeLocationCoordinates,
  writeOrderToSheet,
  type SheetOrder,
} from './sheets'

// Like the real Sales tab: data rows, then the Total row, a blank row and a P&L note.
const SALES_HEADER = [
  'Date',
  'Type',
  'Product',
  'Customer',
  'Units',
  'Sales ($)',
  'Shipping Cost ($)',
  'Payment Date',
  'Payment Received',
  'Paid',
  'Referral Cost ($)',
  'Uncollectible?',
  'Inventory Reference #',
  'COGS (Cost per Unit)',
  'COGS (Total per Sale)',
  'Notes',
  'Year-Month',
  'Parent Company',
  'First Sale Date',
  'First Sale Date Year-Month',
  'Last Order',
  'Custom Cans',
]
const salesTab = (): FakeCell[][] => [
  SALES_HEADER,
  [46308, 'Business', 'Still Cans', 'Hi-Lo Hotel', 72, 108],
  [46309, 'Business', 'Sparkling Cans', 'Lovejoy Bakers', 48, 72],
  ['', '', '', 'Total', 'Total', '=SUM(F$2:F3)'],
  [],
  ['', 'Per P&L Tab', 'Total Revenue', '$486,203'],
]
const locationsTab = (): FakeCell[][] => [
  ['Name', 'Address', 'Latitude', 'Longitude', 'Type of Business'],
  [
    'The Realm Refillery',
    '2310 NE Broadway, Portland, OR 97232',
    45.5347519,
    -122.6419521,
    'Grocery',
  ],
  ['Crisp Salads', '3901 N Williams Ave, Portland, OR 97227', '', '', 'Restaurant'],
  ['', '', '', '', ''],
  ['  Fabo’s Tacos ', '12395 SW Broadway St,  Beaverton, OR 97005', 'n/a', '', 'Food Truck'],
]
const donationsTab = (): FakeCell[][] => [
  ['Date', 'Exp Type', 'Product', 'Item Name', '# Units', 'Inventory Reference #'],
  [45318, 'SAMPLES', 'Still Cans', "Fabo's Tacos", 48, 'A1'],
]

const order = (over: Partial<SheetOrder> = {}): SheetOrder => ({
  key: 'key-1',
  orderDate: '2026-10-15',
  type: 'business',
  customerName: 'Hollywood Theatre',
  lines: [
    { product: 'still', cans: 240, batchId: 35, isCustom: true, amount: 398.4 },
    { product: 'sparkling', cans: 360, batchId: 15, isCustom: true, amount: 597.6 },
  ],
  isPaid: false,
  createInvoice: false,
  isDonation: false,
  notes: null,
  newLocation: null,
  ...over,
})

const ORDER_DATE = 46310 // 10/15/2026
const fake = () => sheet.current!

beforeEach(() => {
  sheet.current = createFakeSheets({
    Sales: salesTab(),
    Donations: donationsTab(),
    'Current Locations Addresses': locationsTab(),
  })
})

describe('writeOrderToSheet: Sales', () => {
  it('adds one row per product above the Total row and returns where they went', async () => {
    const written = await writeOrderToSheet(order())
    expect(written).toEqual({ ref: 'Sales!A4:V5', locationAdded: false })

    const rows = fake().rows('Sales')
    expect(rows[3].slice(0, 6)).toEqual([
      ORDER_DATE,
      'Business',
      'Still Cans',
      'Hollywood Theatre',
      240,
      398.4,
    ])
    expect(rows[4].slice(0, 6)).toEqual([
      ORDER_DATE,
      'Business',
      'Sparkling Cans',
      'Hollywood Theatre',
      360,
      597.6,
    ])
    expect(rows[5].slice(3, 6)).toEqual(['Total', 'Total', '=SUM(F$2:F5)'])
    expect(rows[7][1]).toBe('Per P&L Tab')
  })

  it('writes every column the reports read, with the batch in M', async () => {
    await writeOrderToSheet(order({ notes: 'Back door' }))
    const row = fake().rows('Sales')[3]
    expect(row).toEqual([
      ORDER_DATE, // A: Date
      'Business', // B: Type
      'Still Cans', // C: Product
      'Hollywood Theatre', // D: Customer
      240, // E: Units
      398.4, // F: Sales ($)
      '', // G: Shipping Cost ($)
      '', // H: Payment Date (not paid)
      0, // I: Payment Received
      '=IF(I4-F4=0,"Yes","No")', // J: Paid
      '', // K
      '', // L
      'SB-35', // M: Inventory Reference #
      '=XLOOKUP(M4,Inventory!A:A,Inventory!P:P,0,0)', // N
      '=N4*E4', // O: same row's units
      'Back door', // P: Notes
      '=TEXT(A4,"YYYY-MM")', // Q
      expect.stringMatching(/^=IF\(B4="Business",IF\(OR\(D4="Junior's Roasted Coffee"/), // R
      '=IF(B4="Individual","",MIN(FILTER(A:A,D:D=D4)))', // S
      '=IF(S4="","",TEXT(S4,"yyyy-mm"))', // T
      '=IF(D4=D3,A4-A3,"")', // U
      'Yes', // V: Custom Cans
    ])
  })

  it('fills in the payment date and amount when the order is paid', async () => {
    await writeOrderToSheet(order({ isPaid: true }))
    const [still, sparkling] = fake().rows('Sales').slice(3, 5)
    expect([still[7], still[8]]).toEqual([ORDER_DATE, 398.4])
    expect([sparkling[7], sparkling[8]]).toEqual([ORDER_DATE, 597.6])
  })

  it("gives each row its own line's amount", async () => {
    // A mixed order: custom still at the customer's price, house sparkling at $1.50.
    await writeOrderToSheet(
      order({
        isPaid: true,
        lines: [
          { product: 'still', cans: 240, batchId: 22, isCustom: true, amount: 480 },
          { product: 'sparkling', cans: 48, batchId: 25, isCustom: false, amount: 72 },
        ],
      })
    )
    const rows = fake().rows('Sales').slice(3, 5)
    expect(rows.map((row) => [row[4], row[5], row[8]])).toEqual([
      [240, 480, 480],
      [48, 72, 72],
    ])
    expect(rows.map((row) => row[21] ?? '')).toEqual(['Yes', ''])
  })

  it('books individuals as Individual', async () => {
    await writeOrderToSheet(
      order({ type: 'individual', customerName: 'Pat Doe', lines: [order().lines[0]] })
    )
    expect(fake().rows('Sales')[3][1]).toBe('Individual')
  })

  it('keeps typed text as text, never as a formula', async () => {
    await writeOrderToSheet(order({ customerName: '=IMPORTXML("x")', notes: '+1 more' }))
    const update = fake().calls.find((c) => c.method === 'batchUpdate')!.detail as {
      updateCells?: { rows: { values: { userEnteredValue?: object }[] }[] }
    }[]
    const cells = update.find((r) => r.updateCells)!.updateCells!.rows[0].values
    expect(cells[3].userEnteredValue).toEqual({ stringValue: '=IMPORTXML("x")' })
    expect(cells[15].userEnteredValue).toEqual({ stringValue: '+1 more' })
  })

  it('formats the new rows like the rest and bolds an order that needs an invoice', async () => {
    await writeOrderToSheet(order({ createInvoice: true }))
    expect(fake().formats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
        }),
        expect.objectContaining({
          range: expect.objectContaining({ startColumnIndex: 5, startRowIndex: 3, endRowIndex: 5 }),
          cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0' } } },
        }),
        expect.objectContaining({
          range: expect.objectContaining({ startColumnIndex: 0 }),
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'mm/dd/yyyy' } } },
        }),
      ])
    )
  })

  it('inserts the rows, their values and their tags in one update', async () => {
    await writeOrderToSheet(order())
    const updates = fake().calls.filter((c) => c.method === 'batchUpdate')
    expect(updates).toHaveLength(1)
    const kinds = (updates[0].detail as object[]).map((r) => Object.keys(r)[0])
    expect(kinds[0]).toBe('insertDimension')
    expect(kinds).toContain('updateCells')
    expect(kinds.filter((k) => k === 'createDeveloperMetadata')).toHaveLength(2)
    expect(
      fake()
        .tags()
        .map((t) => t.index)
    ).toEqual([3, 4])
  })

  it('rewrites the rows an earlier attempt left instead of adding them again', async () => {
    // The first attempt writes the rows, then fails fixing the Total row.
    fake().failNext('values.update')
    await expect(writeOrderToSheet(order())).rejects.toThrow('values.update failed')
    expect(fake().rows('Sales')).toHaveLength(8)

    const retry = await writeOrderToSheet(order({ isPaid: true }))
    expect(retry.ref).toBe('Sales!A4:V5')
    const rows = fake().rows('Sales')
    expect(rows).toHaveLength(8)
    expect(rows.filter((row) => row[3] === 'Hollywood Theatre')).toHaveLength(2)
    expect(rows[3][8]).toBe(398.4)
    expect(rows[5][5]).toBe('=SUM(F$2:F5)')
  })

  it('finds its rows even after other orders were added below them', async () => {
    fake().failNext('values.update')
    await expect(writeOrderToSheet(order())).rejects.toThrow()
    await writeOrderToSheet(
      order({ key: 'key-2', customerName: 'Dame', lines: [order().lines[0]] })
    )

    expect((await writeOrderToSheet(order())).ref).toBe('Sales!A4:V5')
    expect(
      fake()
        .rows('Sales')
        .map((row) => row[3])
    ).toEqual([
      'Customer',
      'Hi-Lo Hotel',
      'Lovejoy Bakers',
      'Hollywood Theatre',
      'Hollywood Theatre',
      'Dame',
      'Total',
      undefined,
      '$486,203',
    ])
  })

  it('refuses to guess when the tagged rows no longer match the order', async () => {
    fake().failNext('values.update')
    await expect(writeOrderToSheet(order())).rejects.toThrow()
    await expect(writeOrderToSheet(order({ lines: [order().lines[0]] }))).rejects.toThrow(
      /fix the Sales tab by hand/
    )
  })

  it('keeps two orders written at the same moment apart', async () => {
    await Promise.all([
      writeOrderToSheet(order()),
      writeOrderToSheet(order({ key: 'key-2', customerName: 'Dame', lines: [order().lines[0]] })),
    ])
    const rows = fake().rows('Sales')
    expect(rows.map((row) => [row[3], row[4]])).toEqual(
      expect.arrayContaining([
        ['Hollywood Theatre', 240],
        ['Hollywood Theatre', 360],
        ['Dame', 240],
      ])
    )
    expect(rows.filter((row) => row[3] === 'Total')).toHaveLength(1)
    expect(rows[6].slice(3, 6)).toEqual(['Total', 'Total', '=SUM(F$2:F6)'])
  })

  it('leaves the Total row alone when it is not where it should be', async () => {
    const sales = fake().rows('Sales')
    sales.splice(3, 1) // no Total row
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeOrderToSheet(order())
    expect(fake().rows('Sales')[5]).toEqual([])
    expect(fake().calls.some((c) => c.method === 'values.update')).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('removes its tags once the step is recorded', async () => {
    await writeOrderToSheet(order())
    await untagOrderRows('key-1')
    expect(fake().tags()).toEqual([])
    expect(await findOrderRows('key-1')).toBeNull()
  })

  it('says where an unfinished attempt left rows', async () => {
    fake().failNext('values.update')
    await expect(writeOrderToSheet(order())).rejects.toThrow()
    expect(await findOrderRows('key-1')).toBe('Sales!A4:V5')
  })
})

describe('writeOrderToSheet: donations', () => {
  it('writes Donations rows and leaves Sales alone', async () => {
    const written = await writeOrderToSheet(
      order({ isDonation: true, customerName: 'Rose Festival', notes: 'Booth' })
    )
    expect(written.ref).toBe('Donations!A3:K4')
    expect(fake().rows('Sales')).toEqual(salesTab())
    expect(fake().rows('Donations').slice(2)).toEqual([
      [
        ORDER_DATE,
        'DONATIONS',
        'Still Cans',
        'Rose Festival',
        240,
        'A7',
        '=XLOOKUP(F3,Inventory!A:A,Inventory!P:P,0,0)',
        2,
        '=G3*E3',
        '=H3*E3',
        'Booth',
      ],
      [
        ORDER_DATE,
        'DONATIONS',
        'Sparkling Cans',
        'Rose Festival',
        360,
        'A8',
        '=XLOOKUP(F4,Inventory!A:A,Inventory!P:P,0,0)',
        2,
        '=G4*E4',
        '=H4*E4',
        'Booth',
      ],
    ])
  })
})

describe('writeOrderToSheet: new business', () => {
  const location = {
    name: 'Baerlic Brewery',
    address: '2235 SE 11th Ave, Portland, OR 97214',
    latitude: null,
    longitude: null,
    businessType: 'Brewery',
  }

  it('adds the business to Current Locations Addresses', async () => {
    const written = await writeOrderToSheet(order({ newLocation: location }))
    expect(written.locationAdded).toBe(true)
    expect(fake().rows('Current Locations Addresses').at(-1)).toEqual([
      'Baerlic Brewery',
      '2235 SE 11th Ave, Portland, OR 97214',
      '',
      '',
      'Brewery',
    ])
  })

  it("doesn't list a business twice", async () => {
    const written = await writeOrderToSheet(
      order({ newLocation: { ...location, name: 'crisp salads ' } })
    )
    expect(written.locationAdded).toBe(false)
    expect(fake().rows('Current Locations Addresses')).toEqual(locationsTab())
  })
})

describe('reading the sheet', () => {
  it('reads locations with their coordinates', async () => {
    expect(await getLocationsFromSheet()).toEqual([
      {
        name: 'The Realm Refillery',
        address: '2310 NE Broadway, Portland, OR 97232',
        latitude: 45.5347519,
        longitude: -122.6419521,
        businessType: 'Grocery',
      },
      {
        name: 'Crisp Salads',
        address: '3901 N Williams Ave, Portland, OR 97227',
        latitude: null,
        longitude: null,
        businessType: 'Restaurant',
      },
      {
        name: 'Fabo’s Tacos',
        address: '12395 SW Broadway St, Beaverton, OR 97005',
        latitude: null,
        longitude: null,
        businessType: 'Food Truck',
      },
    ])
  })

  it('finds a same-day Sales row for the customer, in any case', async () => {
    expect(await findSameDaySheetOrder('2026-10-14', 'lovejoy bakers')).toBe(true)
    expect(await findSameDaySheetOrder('2026-10-15', 'Lovejoy Bakers')).toBe(false)
    expect(await findSameDaySheetOrder('2026-10-14', 'Hi-Lo Hotel')).toBe(false)
  })
})

describe('writeLocationCoordinates', () => {
  it('fills in a row with no coordinates', async () => {
    expect(await writeLocationCoordinates('Crisp Salads', 45.551, -122.667)).toBe(true)
    expect(fake().rows('Current Locations Addresses')[2].slice(0, 4)).toEqual([
      'Crisp Salads',
      '3901 N Williams Ave, Portland, OR 97227',
      45.551,
      -122.667,
    ])
  })

  it('leaves coordinates that are already there', async () => {
    expect(await writeLocationCoordinates('The Realm Refillery', 1, 2)).toBe(false)
    expect(fake().rows('Current Locations Addresses')).toEqual(locationsTab())
  })

  it('does nothing for a name that is not on the tab', async () => {
    expect(await writeLocationCoordinates('Nowhere Cafe', 1, 2)).toBe(false)
  })
})
