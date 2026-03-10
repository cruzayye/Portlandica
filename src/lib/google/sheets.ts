import { google } from 'googleapis'
import type { NewOrder } from '@/types/orders'
import { createTrelloCard } from '@/lib/trello'

export type SheetLocation = {
  name: string
  address: string
  businessType: string
}

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

export async function getLocationsFromSheet(): Promise<SheetLocation[]> {
  const sheets = getSheetsClient()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID_LOCATIONS!,
    range: 'Current Locations Addresses!A:E',
  })
  const rows = res.data.values ?? []
  return rows
    .slice(1) // skip header row
    .filter((row) => row[0]) // skip empty rows
    .map((row) => ({
      name: row[0] ?? '',
      address: row[1] ?? '',
      businessType: row[4] ?? '',
    }))
}

async function insertBeforeTotals(
  sheets: ReturnType<typeof getSheetsClient>,
  spreadsheetId: string,
  rows: unknown[][]
) {
  // Get the Sales sheet's numeric ID (needed for batchUpdate)
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const salesSheet = spreadsheet.data.sheets?.find((s: any) => s.properties?.title === 'Sales')
  const sheetId = salesSheet?.properties?.sheetId
  if (sheetId === undefined) throw new Error('Sales sheet tab not found')

  // Find the last row with a date in column A (stops before totals/summary rows)
  const colA = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Sales!A:A',
  })
  const colAValues = colA.data.values ?? []
  let lastDataRow = 1 // 1-indexed
  for (let i = colAValues.length - 1; i >= 1; i--) {
    if (colAValues[i]?.[0]) {
      lastDataRow = i + 1
      break
    }
  }

  // Insert N blank rows right after the last data row, then fix Sales column format.
  // Without the repeatCell request, inheritFromBefore copies a Text format from the
  // previous row, which causes the number to be stored as a string — breaking P&L formulas.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: lastDataRow,
              endIndex: lastDataRow + rows.length,
            },
            inheritFromBefore: true,
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: lastDataRow,
              endRowIndex: lastDataRow + rows.length,
              startColumnIndex: 5, // F: Sales ($)
              endColumnIndex: 6,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: lastDataRow,
              endRowIndex: lastDataRow + rows.length,
            },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
              },
            },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
      ],
    },
  })

  // Inject formulas for Year-Month (Q, index 16) and Parent Company (R, index 17)
  const rowsWithFormulas = rows.map((row, i) => {
    const r = lastDataRow + 1 + i
    const updated = [...(row as unknown[])]
    updated[13] = `=XLOOKUP(M${r},Inventory!A:A,Inventory!P:P,0,0)`
    updated[14] = `=N${r}*E${r - 1}`
    updated[16] = `=TEXT(A${r},"YYYY-MM")`
    updated[17] = `=IF(B${r}="Business",IF(OR(D${r}="Junior's Roasted Coffee",D${r}="Guilder Cafe inside Powell's Books",D${r}="Guilder East"),"Guilder",IF(OR(D${r}="Ben Bridge Jeweler (Downtown)",D${r}="Ben Bridge Jeweler (Washington Square)"),"Ben Bridge Jeweler",IF(OR(REGEXMATCH(D${r},"^The Great North.*"),REGEXMATCH(D${r},"^Lovejoy Bakers.*")),"The Great North",IF(REGEXMATCH(D${r},"^Elephants Delicatessen.*"),"Elephants Delicatessen",D${r})))),"")`
    updated[18] = `=IF(B${r}="Individual","",MIN(FILTER(A:A,D:D=D${r})))`
    updated[19] = `=IF(S${r}="","",TEXT(S${r},"yyyy-mm"))`
    updated[20] = `=IF(D${r}=D${r - 1},A${r}-A${r - 1},"")`
    return updated
  })

  // Write data into the newly inserted rows
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Sales!A${lastDataRow + 1}:V${lastDataRow + rows.length}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rowsWithFormulas },
  })

  // Force Sales ($) values to be stored as actual numbers.
  // USER_ENTERED can store them as text if the inherited cell format was "Text".
  // RAW always writes numbers as numbers regardless of cell format.
  const salesValues = rowsWithFormulas.map((row) => [row[5]])
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Sales!F${lastDataRow + 1}:F${lastDataRow + rows.length}`,
    valueInputOption: 'RAW',
    requestBody: { values: salesValues },
  })

  // Fix the Total row's SUM formula to include the newly inserted rows.
  // Google Sheets does NOT auto-expand a SUM range when rows are inserted at its
  // exact boundary — so the Total row's =SUM(F2:F<old last row>) silently excludes
  // any rows added after that endpoint. We update it to the correct new endpoint.
  const totalRowIndex = lastDataRow + rows.length + 1
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Sales!F${totalRowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[`=SUM(F$2:F${lastDataRow + rows.length})`]],
    },
  })
}

export async function appendOrder(order: NewOrder) {
  const sheets = getSheetsClient()
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const yyyy = now.getFullYear()
  const order_date = `${mm}/${dd}/${yyyy}`

  const type = order.isBusiness ? 'Business' : 'Individual'
  const customer = order.name ?? ''
  const paid = order.isPaid ? 'Yes' : 'No'
  const notes = order.notes ?? ''
  const totalPrice = order.price ?? 0
  const totalStill = order.totalStill ?? 0
  const totalSpark = order.totalSpark ?? 0
  const totalUnits = totalStill + totalSpark

  const stillPrice = totalUnits > 0 ? totalPrice * (totalStill / totalUnits) : 0
  const sparkPrice = totalUnits > 0 ? totalPrice * (totalSpark / totalUnits) : 0

  const salesRows: unknown[][] = []

  if (order.isStill && totalStill > 0) {
    salesRows.push([
      order_date,                                    // A: Date
      type,                                          // B: Type
      'Still Cans',                                  // C: Product
      customer,                                      // D: Customer
      totalStill,                                    // E: Units
      Math.round(stillPrice * 100) / 100,                         // F: Sales ($)
      '',                                            // G: Shipping Cost ($)
      '',                                            // H: Payment Date
      order.isPaid ? Math.round(stillPrice * 100) / 100 : 0,     // I: Payment Received
      paid,                                          // J: Paid
      '',                                            // K: Referral Cost ($)
      '',                                            // L: Uncollectible?
      '',                                            // M: Inventory Reference #
      '',                                            // N: COGS (Cost per Unit)
      '',                                            // O: COGS (Total per Sale)
      notes,                                         // P: Notes
      '',                                            // Q: Year-Month (formula injected by insertBeforeTotals)
      '',                                            // R: Parent Company
      '',                                            // S: First Sale Date
      '',                                            // T: First Sale Date Year-Month
      '',                                            // U: Last Order
      order.IsCustomStill ? 'Yes' : '',               // V: Custom Cans
    ])
  }

  if (order.isSpark && totalSpark > 0) {
    salesRows.push([
      order_date,                                    // A: Date
      type,                                          // B: Type
      'Sparkling Cans',                              // C: Product
      customer,                                      // D: Customer
      totalSpark,                                    // E: Units
      Math.round(sparkPrice * 100) / 100,                         // F: Sales ($)
      '',                                            // G: Shipping Cost ($)
      '',                                            // H: Payment Date
      order.isPaid ? Math.round(sparkPrice * 100) / 100 : 0,     // I: Payment Received
      paid,                                          // J: Paid
      '',                                            // K: Referral Cost ($)
      '',                                            // L: Uncollectible?
      '',                                            // M: Inventory Reference #
      '',                                            // N: COGS (Cost per Unit)
      '',                                            // O: COGS (Total per Sale)
      notes,                                         // P: Notes
      '',                                            // Q: Year-Month (formula injected by insertBeforeTotals)
      '',                                            // R: Parent Company
      '',                                            // S: First Sale Date
      '',                                            // T: First Sale Date Year-Month
      '',                                            // U: Last Order
      order.isCustomSpark ? 'Yes' : '',               // V: Custom Cans
    ])
  }

  const address = order.isNewBusiness
    ? [order.streetAddress, order.city, order.state, order.zip].filter(Boolean).join(', ')
    : (order.notes ?? '')

  const locationsRow = [
    order.name,                // A: Business Name
    address,                   // B: Address
    '',                        // C: Latitude
    '',                        // D: Longitude
    order.businessType ?? '',  // E: Type of Business
  ]

  const promises: Promise<unknown>[] = []

  if (salesRows.length > 0) {
    promises.push(insertBeforeTotals(sheets, process.env.GOOGLE_SHEET_ID_SALES!, salesRows))
  }

  if (order.isNewBusiness && !order.isDTC) {
    promises.push(
      sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID_LOCATIONS!,
        range: 'Current Locations Addresses!A:E',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [locationsRow] },
      })
    )
  }

  promises.push(createTrelloCard(order))

  await Promise.all(promises)
}

