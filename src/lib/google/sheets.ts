import { google } from 'googleapis'
import type { NewOrder } from '@/types/orders'

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

export async function appendOrder(order: NewOrder) {
  const sheets = getSheetsClient()
  const now = new Date()
  const created_at = now.toISOString()
  const order_date = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`

  const product = [
    order.isStill ? 'Still Cans' : '',
    order.isSpark ? 'Sparkling Cans' : '',
  ].filter(Boolean).join(', ')

  const row = [
    created_at,                                      // A: Timestamp
    order_date,                                      // B: Order Date
    order.isBusiness ? 'Business' : 'Individual',   // C: Customer Type
    order.isNewBusiness ? 'Yes' : 'No',             // D: New Business?
    order.isBusiness ? (order.isNewBusiness ? [order.streetAddress, order.city, order.state, order.zip].filter(Boolean).join(', ') : (order.notes ?? '')) : '',  // E: Business Address
    order.businessType ?? '',                        // F: Type of Business
    '',                                              // G: Delivery Type
    order.name,                                      // H: Customer Name
    product,                                         // I: Product
    order.totalStill ?? '',                          // J: # of Still Cans
    order.price ?? '',                               // K: Price ($)
    order.isPaid ? 'Paid' : 'Unpaid',               // L: Payment Status
    '',                                              // M: Payment Date
    order.totalSpark ?? '',                          // N: # of Sparkling Cans
    !order.isBusiness ? (order.notes ?? '') : '',   // O: Individual Address
    [order.isNewBusiness ? [order.streetAddress, order.city, order.state, order.zip].filter(Boolean).join(', ') : (order.notes ?? ''), order.isNewBusiness ? (order.notes ?? '') : ''].filter(Boolean).join(' | '),  // P: Additional Details for Trello
    order.createInvoice ? 'Yes' : 'No',             // Q: Create an Invoice on Square?
    order.IsCustomStill ? 'Yes' : 'No',             // R: Custom Still Cans?
    order.isCustomSpark ? 'Yes' : 'No',             // S: Custom Sparkling Cans?
  ]

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID!,
    range: 'Form Responses!A:S',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  })
}
