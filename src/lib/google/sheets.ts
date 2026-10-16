import { google, type sheets_v4 } from 'googleapis'
import type { CustomerType, LineProduct } from '@/lib/db/types'
import { sheetDate, sheetDateSerial } from '@/lib/delivery'

// The Sales sheet: the book of record Paul's reports read. Tab names, columns and
// formulas stay exactly as they are; the order flow only adds rows.

export type SheetLocation = {
  name: string
  address: string
  latitude: number | null
  longitude: number | null
  businessType: string
}

type Sheets = sheets_v4.Sheets
type Cell = sheets_v4.Schema$CellData
type Request = sheets_v4.Schema$Request

const SALES = 'Sales'
const DONATIONS = 'Donations'
const LOCATIONS = 'Current Locations Addresses'
const LOCATIONS_RANGE = (columns: string) => `'${LOCATIONS}'!${columns}`

// Tags the rows an order writes, so a retry finds and rewrites them instead of adding a
// second copy. Developer metadata is invisible in the sheet. The tag is removed once the
// order's sheet step is recorded as done (sheets allow 30,000 characters of it).
const ORDER_TAG = 'portlandicaOrder'

const getSheetsClient = (): Sheets => {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

const spreadsheetId = () => process.env.GOOGLE_SHEET_ID!

const text = (value: unknown) => String(value ?? '').trim()
const sameName = (a: unknown, b: string) => text(a).toLowerCase() === b.trim().toLowerCase()

const coordinate = (value: unknown, limit: number) => {
  const raw = text(value)
  const number = Number(raw)
  return raw !== '' && Number.isFinite(number) && Math.abs(number) <= limit ? number : null
}

/** Every location on the Current Locations Addresses tab, in sheet order. */
export const getLocationsFromSheet = async (): Promise<SheetLocation[]> => {
  const res = await getSheetsClient().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: LOCATIONS_RANGE('A:E'),
  })
  return (res.data.values ?? [])
    .slice(1) // header row
    .filter((row) => text(row[0]))
    .map((row) => {
      const latitude = coordinate(row[2], 90)
      const longitude = coordinate(row[3], 180)
      const both = latitude !== null && longitude !== null
      return {
        name: text(row[0]),
        address: text(row[1]).replace(/\s+/g, ' '),
        latitude: both ? latitude : null,
        longitude: both ? longitude : null,
        businessType: text(row[4]),
      }
    })
}

/** Whether the Sales tab already has a row for this customer on this date (YYYY-MM-DD). */
export const findSameDaySheetOrder = async (isoDate: string, customer: string) => {
  const res = await getSheetsClient().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${SALES}!A:D`,
  })
  const date = sheetDate(isoDate)
  return (res.data.values ?? []).slice(1).some((row) => row[0] === date && sameName(row[3], customer))
}

export type SheetOrderLine = {
  product: LineProduct
  cans: number
  batchId: number
  isCustom: boolean
  /** What this line is charged, in dollars: its own row's Sales ($). */
  amount: number
}

/** An order as the Sales sheet records it. */
export type SheetOrder = {
  /** The order's idempotency key. Tags its rows so a retry rewrites them. */
  key: string
  /** YYYY-MM-DD */
  orderDate: string
  type: CustomerType
  customerName: string
  /** One row each, with its own amount; the amounts add up to what the order is charged. */
  lines: SheetOrderLine[]
  isPaid: boolean
  createInvoice: boolean
  isDonation: boolean
  notes: string | null
  /** A new business to list on Current Locations Addresses, unless it's there already. */
  newLocation: SheetLocation | null
}

export type SheetWrite = {
  /** Where the rows went, e.g. 'Sales!A3126:V3127'. */
  ref: string
  /** Whether the new business was added to Current Locations Addresses. */
  locationAdded: boolean
}

const PRODUCT_LABELS: Record<LineProduct, string> = {
  still: 'Still Cans',
  sparkling: 'Sparkling Cans',
  dog_water: 'Dog Water Cans',
}

const empty: Cell = {}
const str = (value: string): Cell => (value ? { userEnteredValue: { stringValue: value } } : empty)
const num = (value: number): Cell => ({ userEnteredValue: { numberValue: value } })
const formula = (value: string): Cell => ({ userEnteredValue: { formulaValue: value } })

type RowAt = (row: number) => Cell[]

// One Sales row per product, A to V. Strings go in as text, so nothing typed into the
// form is ever read as a formula.
const salesRows = (order: SheetOrder): RowAt[] => {
  const date = sheetDateSerial(order.orderDate)
  return order.lines.map((line) => (r: number) => [
    num(date), // A: Date
    str(order.type === 'individual' ? 'Individual' : 'Business'), // B: Type
    str(PRODUCT_LABELS[line.product]), // C: Product
    str(order.customerName), // D: Customer
    num(line.cans), // E: Units
    num(line.amount), // F: Sales ($)
    empty, // G: Shipping Cost ($)
    empty, // H: Payment Date: filled in when the money arrives (autopay pays weeks later)
    num(order.isPaid ? line.amount : 0), // I: Payment Received
    formula(`=IF(I${r}-F${r}=0,"Yes","No")`), // J: Paid
    empty, // K: Referral Cost ($)
    empty, // L: Uncollectible?
    str(`SB-${line.batchId}`), // M: Inventory Reference #
    formula(`=XLOOKUP(M${r},Inventory!A:A,Inventory!P:P,0,0)`), // N: COGS (Cost per Unit)
    formula(`=N${r}*E${r}`), // O: COGS (Total per Sale)
    str(order.notes ?? ''), // P: Notes
    formula(`=TEXT(A${r},"YYYY-MM")`), // Q: Year-Month
    formula(
      `=IF(B${r}="Business",IF(OR(D${r}="Junior's Roasted Coffee",D${r}="Guilder Cafe inside Powell's Books",D${r}="Guilder East"),"Guilder",IF(OR(D${r}="Ben Bridge Jeweler (Downtown)",D${r}="Ben Bridge Jeweler (Washington Square)"),"Ben Bridge Jeweler",IF(OR(REGEXMATCH(D${r},"^The Great North.*"),REGEXMATCH(D${r},"^Lovejoy Bakers.*")),"The Great North",IF(REGEXMATCH(D${r},"^Elephants Delicatessen.*"),"Elephants Delicatessen",D${r})))),"")`
    ), // R: Parent Company
    formula(`=IF(B${r}="Individual","",MIN(FILTER(A:A,D:D=D${r})))`), // S: First Sale Date
    formula(`=IF(S${r}="","",TEXT(S${r},"yyyy-mm"))`), // T: First Sale Date Year-Month
    formula(`=IF(D${r}=D${r - 1},A${r}-A${r - 1},"")`), // U: Last Order
    line.isCustom ? str('Yes') : empty, // V: Custom Cans
  ])
}

// Donations keep their inventory references to the sheet's own Inventory tab, so the
// COGS lookup in G keeps working.
const RETAIL_PRICE_PER_UNIT = 2.0
const DONATION_INV_REFS: Record<LineProduct, string> = { still: 'A7', sparkling: 'A8', dog_water: 'A7' }

const donationRows = (order: SheetOrder): RowAt[] => {
  const date = sheetDateSerial(order.orderDate)
  return order.lines.map((line) => (r: number) => [
    num(date), // A: Date
    str('DONATIONS'), // B: Exp Type
    str(PRODUCT_LABELS[line.product]), // C: Product
    str(order.customerName), // D: Item Name
    num(line.cans), // E: # Units
    str(DONATION_INV_REFS[line.product]), // F: Inventory Reference #
    formula(`=XLOOKUP(F${r},Inventory!A:A,Inventory!P:P,0,0)`), // G: COGS (Cost per Unit)
    num(RETAIL_PRICE_PER_UNIT), // H: Retail Price per Unit
    formula(`=G${r}*E${r}`), // I: COGS (Total $)
    formula(`=H${r}*E${r}`), // J: Retail Price (Total Retail $)
    str(order.notes ?? ''), // K: Notes
  ])
}

const LAST_COLUMN = { [SALES]: 'V', [DONATIONS]: 'K' } as const

const tabIds = async (sheets: Sheets) => {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId(),
    fields: 'sheets.properties(sheetId,title)',
  })
  return new Map(
    (res.data.sheets ?? []).map((sheet) => [sheet.properties?.title ?? '', sheet.properties?.sheetId])
  )
}

/** Rows (0-based) tagged with this order's key, in sheet order. */
const findTaggedRows = async (sheets: Sheets, key: string) => {
  const res = await sheets.spreadsheets.developerMetadata.search({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      dataFilters: [{ developerMetadataLookup: { metadataKey: ORDER_TAG, metadataValue: key } }],
    },
  })
  return (res.data.matchedDeveloperMetadata ?? [])
    .flatMap(({ developerMetadata }) => {
      const range = developerMetadata?.location?.dimensionRange
      return range?.sheetId != null && range.startIndex != null
        ? [{ sheetId: range.sheetId, index: range.startIndex }]
        : []
    })
    .sort((a, b) => a.index - b.index)
}

/** Index (0-based) of the row after the last one with something in column A. */
const nextRowIndex = async (sheets: Sheets, tab: string) => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${tab}!A:A`,
  })
  const values = res.data.values ?? []
  for (let i = values.length - 1; i >= 1; i--) {
    if (text(values[i]?.[0])) return i + 1
  }
  return 1
}

const rowsRange = (sheetId: number, start: number, count: number) => ({
  sheetId,
  startRowIndex: start,
  endRowIndex: start + count,
})

const columnFormat = (
  sheetId: number,
  start: number,
  count: number,
  column: number,
  numberFormat: sheets_v4.Schema$NumberFormat
): Request => ({
  repeatCell: {
    range: { ...rowsRange(sheetId, start, count), startColumnIndex: column, endColumnIndex: column + 1 },
    cell: { userEnteredFormat: { numberFormat } },
    fields: 'userEnteredFormat.numberFormat',
  },
})

// The formats the Sales rows already use. Inserted rows inherit the row above, which once
// held a Text format that turned amounts into strings, so these are set explicitly.
const salesFormats = (sheetId: number, start: number, count: number, bold: boolean): Request[] => [
  columnFormat(sheetId, start, count, 0, { type: 'DATE', pattern: 'mm/dd/yyyy' }),
  columnFormat(sheetId, start, count, 5, { type: 'CURRENCY', pattern: '"$"#,##0' }),
  columnFormat(sheetId, start, count, 7, { type: 'DATE', pattern: 'mm/dd/yyyy' }),
  {
    // Bold marks an order that needs an invoice.
    repeatCell: {
      range: rowsRange(sheetId, start, count),
      cell: { userEnteredFormat: { textFormat: { bold } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  },
]

const writeCells = (sheetId: number, start: number, rows: Cell[][]): Request => ({
  updateCells: {
    start: { sheetId, rowIndex: start, columnIndex: 0 },
    rows: rows.map((values) => ({ values })),
    fields: 'userEnteredValue',
  },
})

const tagRows = (sheetId: number, start: number, count: number, key: string): Request[] =>
  Array.from({ length: count }, (_, i) => ({
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: ORDER_TAG,
        metadataValue: key,
        visibility: 'DOCUMENT',
        location: {
          dimensionRange: { sheetId, dimension: 'ROWS', startIndex: start + i, endIndex: start + i + 1 },
        },
      },
    },
  }))

// The Total row's SUM doesn't grow when rows are inserted right above it, so point it at
// the last order row again. Only touches the row just below the last order, and only if
// it is the Total row.
const fixSalesTotal = async (sheets: Sheets) => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${SALES}!A:D`,
  })
  const values = res.data.values ?? []
  let last = -1
  for (let i = values.length - 1; i >= 1; i--) {
    if (text(values[i]?.[0])) {
      last = i
      break
    }
  }
  const totalRow = values[last + 1]
  if (last < 1 || text(totalRow?.[3]) !== 'Total') {
    console.warn('Sales sheet: no Total row below the last order; its sum was left alone')
    return
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${SALES}!F${last + 2}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[`=SUM(F$2:F${last + 1})`]] },
  })
}

const ensureLocation = async (sheets: Sheets, location: SheetLocation) => {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: LOCATIONS_RANGE('A:A'),
  })
  if ((res.data.values ?? []).some((row) => sameName(row[0], location.name))) return false
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: LOCATIONS_RANGE('A:E'),
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [
        [
          location.name, // A: Name
          location.address, // B: Address
          location.latitude ?? '', // C: Latitude
          location.longitude ?? '', // D: Longitude
          location.businessType, // E: Type of Business
        ],
      ],
    },
  })
  return true
}

/**
 * Write an order to the sheet: Sales rows for a sale, Donations rows for a donation, and
 * a Current Locations Addresses row for a new business. Safe to call again for the same
 * order: rows an earlier attempt added are found by their tag and rewritten in place.
 * New rows, their values and their tags go in as one update, so two orders written at
 * the same moment can't land on each other's rows.
 */
export const writeOrderToSheet = async (order: SheetOrder): Promise<SheetWrite> => {
  if (!order.lines.length) throw new Error('The order has no products to write')
  const sheets = getSheetsClient()
  const tab = order.isDonation ? DONATIONS : SALES
  const sheetId = (await tabIds(sheets)).get(tab)
  if (sheetId == null) throw new Error(`The ${tab} tab is missing`)

  const rows = order.isDonation ? donationRows(order) : salesRows(order)
  const formats = (start: number, count: number) =>
    order.isDonation ? [] : salesFormats(sheetId, start, count, order.createInvoice)
  const tagged = await findTaggedRows(sheets, order.key)

  let rowNumbers: number[]
  if (tagged.length) {
    if (tagged.length !== rows.length || tagged.some((row) => row.sheetId !== sheetId)) {
      throw new Error(
        `An earlier attempt left ${tagged.length} rows for this order that don't match it; fix the ${tab} tab by hand`
      )
    }
    rowNumbers = tagged.map((row) => row.index + 1)
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        requests: tagged.flatMap((row, i) => [
          ...formats(row.index, 1),
          writeCells(sheetId, row.index, [rows[i](row.index + 1)]),
        ]),
      },
    })
  } else {
    const at = await nextRowIndex(sheets, tab)
    rowNumbers = rows.map((_, i) => at + i + 1)
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + rows.length },
              inheritFromBefore: true,
            },
          },
          ...formats(at, rows.length),
          writeCells(
            sheetId,
            at,
            rows.map((row, i) => row(at + i + 1))
          ),
          ...tagRows(sheetId, at, rows.length, order.key),
        ],
      },
    })
  }

  if (!order.isDonation) await fixSalesTotal(sheets)
  const locationAdded = order.newLocation ? await ensureLocation(sheets, order.newLocation) : false

  const first = Math.min(...rowNumbers)
  const last = Math.max(...rowNumbers)
  return { ref: `${tab}!A${first}:${LAST_COLUMN[tab]}${last}`, locationAdded }
}

/** Remove an order's row tags once its sheet step is recorded. */
export const untagOrderRows = async (key: string) => {
  await getSheetsClient().spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      requests: [
        {
          deleteDeveloperMetadata: {
            dataFilter: {
              developerMetadataLookup: { metadataKey: ORDER_TAG, metadataValue: key },
            },
          },
        },
      ],
    },
  })
}

/** Rows an unfinished attempt wrote for this order, as 'Sales!A3126:V3127', or null. */
export const findOrderRows = async (key: string) => {
  const sheets = getSheetsClient()
  const tagged = await findTaggedRows(sheets, key)
  if (!tagged.length) return null
  const titles = new Map([...(await tabIds(sheets))].map(([title, id]) => [id, title]))
  const tab = titles.get(tagged[0].sheetId) ?? 'Sales'
  const lastColumn = tab === DONATIONS ? 'K' : 'V'
  return `${tab}!A${tagged[0].index + 1}:${lastColumn}${tagged[tagged.length - 1].index + 1}`
}

/**
 * Fill in a location's latitude and longitude (columns C and D) on Current Locations
 * Addresses. Leaves a row that already has coordinates alone. False if the name isn't
 * on the tab or already has them.
 */
export const writeLocationCoordinates = async (
  name: string,
  latitude: number,
  longitude: number
) => {
  const sheets = getSheetsClient()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: LOCATIONS_RANGE('A:D'),
  })
  const values = res.data.values ?? []
  let index = -1
  for (let i = values.length - 1; i >= 1; i--) {
    if (sameName(values[i]?.[0], name)) {
      index = i
      break
    }
  }
  if (index < 0 || text(values[index][2]) || text(values[index][3])) return false
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: LOCATIONS_RANGE(`C${index + 1}:D${index + 1}`),
    valueInputOption: 'RAW',
    requestBody: { values: [[latitude, longitude]] },
  })
  return true
}
